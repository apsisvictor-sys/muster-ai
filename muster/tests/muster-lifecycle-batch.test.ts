import "./muster-test-isolation.ts";
/**
 * Model-free regressions for the muster lifecycle observation helper.
 *
 * The parent calls `muster_*` tools and expects the binding journal to
 * reflect the latest truth — but only when something actually changed. A
 * repeated `muster_inspect` returning the same status/version/owner as the
 * last good observation must not dirty the journal; an unchanged
 * `muster_update` message echo must not bump `currentWriteTaskId`. The
 * previous in-place version wrote the journal every time.
 *
 * `applyLifecycleObservation` is the pure helper behind the in-place
 * `applyLifecycleResult` in `index.ts`; testing it here exercises the
 * batching contract without a live Concord/Herdr/operator mode.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { applyLifecycleObservation } from "../lifecycle.ts";
import type { RepoBinding } from "../types.ts";
import type { TaskLifecycleObservation } from "../agile.ts";

function freshBinding(): RepoBinding {
	return {
		alias: "test",
		repoKey: "rk_test",
		primaryRoot: "/tmp/rk_test",
		checkoutRoots: ["/tmp/rk_test"],
		workspaceId: "",
		agentId: "pi-test",
		supervisedTaskIds: [],
	};
}

function observation(input: Partial<TaskLifecycleObservation>): TaskLifecycleObservation {
	return {
		status: input.status ?? "active",
		observedAtMs: input.observedAtMs ?? 0,
		...(input.version !== undefined ? { version: input.version } : {}),
		...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
		...(input.assignedAgentId !== undefined ? { assignedAgentId: input.assignedAgentId } : {}),
	};
}

test("lifecycle: muster_start on the same task as already bound is a no-op", () => {
	const binding = freshBinding();
	const taskStates = new Map<string, TaskLifecycleObservation>();
	const structured = {
		task_id: "t_build",
		status: "active",
		version: 3,
		agent_id: "pi-parent",
		assigned_agent_id: "pi-parent",
	};
	taskStates.set("t_build", observation({ status: "active", version: 3, agentId: "pi-parent", assignedAgentId: "pi-parent" }));
	binding.currentWriteTaskId = "t_build";

	const mutated = applyLifecycleObservation({
		binding,
		musterName: "muster_start",
		structured,
		taskStates,
	});
	assert.equal(mutated, false);
	assert.equal(binding.currentWriteTaskId, "t_build");
	const partial = applyLifecycleObservation({ binding, musterName: "muster_inspect", structured: { task_id: "t_build", status: "active" }, taskStates });
	assert.equal(partial, false);
	assert.equal(taskStates.get("t_build")?.version, 3, "partial observations preserve known version");
	assert.equal(taskStates.get("t_build")?.assignedAgentId, "pi-parent");
	assert.ok((taskStates.get("t_build")?.observedAtMs ?? 0) > 0, "fresh observations renew freshness without a journal write");
});

test("lifecycle: muster_start on a new task sets currentWriteTaskId and reports mutation", () => {
	const binding = freshBinding();
	binding.currentWriteTaskId = "t_verify";
	const taskStates = new Map<string, TaskLifecycleObservation>();
	const mutated = applyLifecycleObservation({
		binding,
		musterName: "muster_start",
		structured: { task_id: "t_build", status: "active", version: 1, agent_id: "pi-parent", assigned_agent_id: "pi-parent" },
		taskStates,
	});
	assert.equal(mutated, true);
	assert.equal(binding.currentWriteTaskId, "t_build");
});

test("lifecycle: muster_transfer action=assign records supervisedTaskId and clears matching writeTask", () => {
	const binding = freshBinding();
	binding.currentWriteTaskId = "t_build";
	binding.supervisedTaskIds = [];
	const taskStates = new Map<string, TaskLifecycleObservation>();
	const mutated = applyLifecycleObservation({
		binding,
		musterName: "muster_transfer",
		structured: { task_id: "t_build", action: "assign", status: "active", version: 1, agent_id: "pi-parent", assigned_agent_id: "pi-worker-1" },
		taskStates,
	});
	assert.equal(mutated, true);
	assert.deepEqual(binding.supervisedTaskIds, ["t_build"]);
	assert.equal(binding.currentWriteTaskId, undefined);
});

test("lifecycle: muster_transfer action=accept sets currentWriteTaskId only when it changed", () => {
	const binding = freshBinding();
	binding.currentWriteTaskId = "t_old";
	const taskStates = new Map<string, TaskLifecycleObservation>();
	const mutatedAccept = applyLifecycleObservation({
		binding,
		musterName: "muster_transfer",
		structured: { task_id: "t_new", action: "accept", status: "active", version: 1, agent_id: "pi-parent", assigned_agent_id: "pi-parent" },
		taskStates,
	});
	assert.equal(mutatedAccept, true);
	assert.equal(binding.currentWriteTaskId, "t_new");
	const mutatedRepeat = applyLifecycleObservation({
		binding,
		musterName: "muster_transfer",
		structured: { task_id: "t_new", action: "accept", status: "active", version: 1, agent_id: "pi-parent", assigned_agent_id: "pi-parent" },
		taskStates,
	});
	assert.equal(mutatedRepeat, false, "re-accepting the same task is a no-op");
});

test("lifecycle: muster_update message echo does not mutate the binding", () => {
	const binding = freshBinding();
	binding.currentWriteTaskId = "t_keep";
	binding.supervisedTaskIds = ["t_keep"];
	const taskStates = new Map<string, TaskLifecycleObservation>();
	taskStates.set("t_keep", observation({ status: "active", version: 4, agentId: "pi-parent", assignedAgentId: "pi-parent" }));
	const mutated = applyLifecycleObservation({
		binding,
		musterName: "muster_update",
		structured: { task_id: "t_keep", status: "active", version: 4, agent_id: "pi-parent", assigned_agent_id: "pi-parent" },
		taskStates,
	});
	assert.equal(mutated, false);
});

test("lifecycle: identical muster_inspect echo with the same observation does not rewrite the map", () => {
	const binding = freshBinding();
	const taskStates = new Map<string, TaskLifecycleObservation>();
	taskStates.set("t_keep", observation({ status: "active", version: 4, agentId: "pi-parent", assignedAgentId: "pi-parent" }));
	const before = taskStates.get("t_keep");
	const mutated = applyLifecycleObservation({
		binding,
		musterName: "muster_inspect",
		structured: { task_id: "t_keep", status: "active", version: 4, agent_id: "pi-parent", assigned_agent_id: "pi-parent" },
		taskStates,
	});
	assert.equal(mutated, false);
	assert.equal(taskStates.get("t_keep"), before);
});

test("lifecycle: a new observation overwrites the previous one when status moves", () => {
	const binding = freshBinding();
	const taskStates = new Map<string, TaskLifecycleObservation>();
	taskStates.set("t_build", observation({ status: "active", version: 3, agentId: "pi-parent", assignedAgentId: "pi-parent" }));
	const mutated = applyLifecycleObservation({
		binding,
		musterName: "muster_update",
		structured: { task_id: "t_build", status: "blocked", version: 4, agent_id: "pi-parent", assigned_agent_id: "pi-parent" },
		taskStates,
	});
	assert.equal(mutated, false);
	const stored = taskStates.get("t_build");
	assert.equal(stored?.status, "blocked");
	assert.equal(stored?.version, 4);
});

test("lifecycle: muster_finish outcome=closed prunes the supervisedTaskIds and clears the writeTask", () => {
	const binding = freshBinding();
	binding.supervisedTaskIds = ["t_build", "t_keep"];
	binding.currentWriteTaskId = "t_build";
	const taskStates = new Map<string, TaskLifecycleObservation>();
	const mutated = applyLifecycleObservation({
		binding,
		musterName: "muster_finish",
		structured: { task_id: "t_build", outcome: "closed", status: "complete", version: 5 },
		taskStates,
	});
	assert.equal(mutated, true);
	assert.deepEqual(binding.supervisedTaskIds, ["t_keep"]);
	assert.equal(binding.currentWriteTaskId, undefined);
});

test("lifecycle: a structured payload without a task_id is a silent no-op", () => {
	const binding = freshBinding();
	binding.currentWriteTaskId = "t_keep";
	const taskStates = new Map<string, TaskLifecycleObservation>();
	for (const structured of [undefined, {}, { task_id: 99 }]) {
		const mutated = applyLifecycleObservation({
			binding,
			musterName: "muster_start",
			structured,
			taskStates,
		});
		assert.equal(mutated, false);
	}
	assert.equal(binding.currentWriteTaskId, "t_keep");
});