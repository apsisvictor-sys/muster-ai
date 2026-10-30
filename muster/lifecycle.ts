/**
 * Idempotent binding journal write for muster_* tool results.
 *
 * Extracted from `index.ts` so a focused unit test can exercise the
 * start→assign and offer→notification batching without spinning up a live
 * Concord/Herdr/operator mode. The previous in-place version persisted the
 * binding every time, even when the structured result was an identity echo
 * (same status/version/owner as the last observation). A repeated
 * `muster_inspect` after no change, or a `muster_update` message echo, used
 * to dirty the journal and queue a write. This helper returns the
 * observation + lifecycle result and only writes when something actually
 * changes.
 *
 * The contract is intentionally narrow:
 *   - `applyObservation` decides whether the structured payload mutates
 *     the binding (returns true on any change), recording the observation
 *     in `taskStates` only when status/version/owner moved;
 *   - `currentWriteTaskId` is narrowed to the canonical parent-only muster_*
 *     actions (start, transfer:assign, transfer:accept, transfer:release,
 *     transfer:decline, finish:complete, finish:closed). Child delegates
 *     have no command of `binding`, so a child's task transition cannot
 *     hijack the parent's write target by this path.
 *
 * The free function does not touch the binding journal itself; the caller
 * runs `persistBinding()` only when the return value is `true`.
 */

import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { adoptLaunchReservation, readProgrammeSnapshot, recordLaneLaunch, reserveDescendantWriter, reserveWriter, type ProgrammeControlContext } from "./control.ts";
import { taskDetailOf, type ConcordToolResult } from "./concord.ts";
import { structuredLines, type DispatchPlan } from "./dispatch.ts";
import type { RepoBinding } from "./types.ts";
import type { TaskLifecycleObservation } from "./agile.ts";

export type LifecycleStructured = {
	task_id?: unknown;
	status?: unknown;
	version?: unknown;
	agent_id?: unknown;
	assigned_agent_id?: unknown;
	action?: unknown;
	outcome?: unknown;
};

/**
 * Read and write the binding's task observation set; mutate the binding
 * fields the parent lifecycle owns. Returns `true` when the binding
 * actually changed (the caller should then call `persistBinding()`).
 *
 * `taskStates` is the parent's process-local observation map. The helper
 * never throws; a malformed structured payload is a silent no-op.
 */
export function applyLifecycleObservation(input: {
	binding: RepoBinding;
	musterName: string;
	structured: LifecycleStructured | undefined;
	taskStates: Map<string, TaskLifecycleObservation>;
}): boolean {
	const { binding, musterName, structured, taskStates } = input;
	if (!structured) return false;
	const taskId = typeof structured.task_id === "string" ? (structured.task_id as string) : undefined;
	if (taskId === undefined) return false;

	const previous = taskStates.get(taskId);
	const nextStatus = typeof structured.status === "string" ? structured.status : previous?.status;
	const nextVersion = typeof structured.version === "number" ? structured.version : previous?.version;
	const nextAgent = structured.agent_id === null ? undefined : typeof structured.agent_id === "string" ? structured.agent_id : previous?.agentId;
	const nextAssigned = structured.assigned_agent_id === null ? undefined : typeof structured.assigned_agent_id === "string" ? structured.assigned_agent_id : previous?.assignedAgentId;
	const observationUnchanged =
		previous !== undefined &&
		previous.status === nextStatus &&
		previous.version === nextVersion &&
		previous.agentId === nextAgent &&
		previous.assignedAgentId === nextAssigned;
	if (observationUnchanged && previous) previous.observedAtMs = Date.now();
	if (!observationUnchanged) {
		const observation: TaskLifecycleObservation = {
			status: nextStatus ?? previous?.status ?? "unknown",
			observedAtMs: Date.now(),
		};
		if (nextVersion !== undefined) observation.version = nextVersion;
		if (nextAgent !== undefined) observation.agentId = nextAgent;
		if (nextAssigned !== undefined) observation.assignedAgentId = nextAssigned;
		taskStates.set(taskId, observation);
	}

	let mutated = false;
	if (musterName === "muster_start") {
		if (binding.currentWriteTaskId !== taskId) {
			binding.currentWriteTaskId = taskId;
			mutated = true;
		}
	} else if (musterName === "muster_transfer") {
		const action = structured.action;
		if (action === "assign" || action === "reassign") {
			if (!binding.supervisedTaskIds.includes(taskId)) {
				binding.supervisedTaskIds.push(taskId);
				mutated = true;
			}
			if (binding.currentWriteTaskId === taskId) {
				binding.currentWriteTaskId = undefined;
				mutated = true;
			}
		} else if (action === "accept") {
			if (binding.currentWriteTaskId !== taskId) {
				binding.currentWriteTaskId = taskId;
				mutated = true;
			}
		} else if (action === "release" || action === "decline") {
			if (binding.currentWriteTaskId === taskId) {
				binding.currentWriteTaskId = undefined;
				mutated = true;
			}
		}
	} else if (musterName === "muster_finish") {
		const outcome = structured.outcome;
		if (outcome === "complete" || outcome === "closed") {
			const before = binding.supervisedTaskIds.length;
			binding.supervisedTaskIds = binding.supervisedTaskIds.filter((id) => id !== taskId);
			if (binding.supervisedTaskIds.length !== before) mutated = true;
			if (binding.currentWriteTaskId === taskId) {
				binding.currentWriteTaskId = undefined;
				mutated = true;
			}
		}
	}
	return mutated;
}

export type LaneLifecycleClient = { callTool(name: string, args: Record<string, unknown>): Promise<ConcordToolResult> };

/** Reserve through control and assign through the versioned Concord lifecycle before process creation. */
export async function prepareLaneAssignment(input: {
	plan: DispatchPlan; client: LaneLifecycleClient; register: () => Promise<void>; control?: ProgrammeControlContext;
}): Promise<void> {
	const { plan, client, control } = input;
	if (!plan.programmeId || !plan.parentAgentId || !plan.attemptId) throw new Error("dispatch has no programme, attempt or mailbox authority");
	const inspected = taskDetailOf((await client.callTool("inspect_work", { task_id: plan.taskId })).structuredContent).task;
	if (inspected?.status !== "proposed" || inspected.agentId !== plan.parentAgentId || !Number.isInteger(inspected.version)) throw new Error("dispatch task is not a versioned proposal owned by the mailbox");
	const ownerRef = `lane:${plan.agentName}`;
	if (plan.expectedFiles.length > 0) reserveDescendantWriter(plan.programmeId, ownerRef, "lane", plan.expectedFiles, control);
	else {
		const slot = reserveWriter(plan.programmeId, ownerRef, control);
		if (slot.outcome !== "admitted") throw new Error(`dispatch writer ceiling is full (${slot.activeReservations} active)`);
	}
	// The existing writer reservation is the reconciliation handle. Persist the
	// attempt identity before registration, assignment, worktree or pane creation.
	let step = "launch identity persistence";
	try {
		recordLaneLaunch(plan.programmeId, ownerRef, { taskId: plan.taskId, attemptId: plan.attemptId, agentName: plan.agentName, phase: "reserved", checkoutRoot: resolve(plan.cwd) }, control);
		step = "Concord agent registration";
		await input.register();
		step = "versioned Concord assignment";
		await client.callTool("transfer_work", { action: "assign", task_id: plan.taskId, to_agent_id: plan.agentName,
			expected_version: inspected.version, reason: "Automatic Muster dispatch with a reserved writer slot" });
	} catch (error) {
		try { recordLaneLaunch(plan.programmeId, ownerRef, { taskId: plan.taskId, attemptId: plan.attemptId, agentName: plan.agentName, phase: "failed", failureStep: step }, control); } catch { /* the writer reservation remains the recovery handle */ }
		throw error;
	}
}

/** Authenticated fresh-session bootstrap: only the bound assignment and pending reservation authorize input. */
export async function bootstrapAssignedLane(input: {
	programmeId: string; taskId: string; agentId: string; sessionId: string; briefPath: string; briefDir: string;
	client: LaneLifecycleClient; kind: string; model?: string; cwd: string; control?: ProgrammeControlContext;
}): Promise<{ brief: string; structured: LifecycleStructured }> {
	const { client, programmeId, taskId, agentId, control } = input;
	const task = taskDetailOf((await client.callTool("inspect_work", { task_id: taskId })).structuredContent).task;
	if (task?.taskId !== taskId || task.status !== "assigned" || task.assignedAgentId !== agentId) throw new Error("worker bootstrap task is not assigned to this authenticated Concord binding");
	const record = readProgrammeSnapshot(programmeId, control);
	if (record.status !== "running" || !record.reservations.some((row) => row.ownerRef === `lane:${agentId}`)) throw new Error("worker bootstrap has no pending launch reservation");
	const notes = typeof task.notes === "string" ? task.notes : "";
	const riskTags = Array.isArray(task.riskTags) ? task.riskTags.filter((tag): tag is string => typeof tag === "string") : [];
	const named = structuredLines({ notes, riskTags }).get("brief")?.[0];
	if (!named || resolve(input.briefDir, named) !== resolve(input.briefPath)) throw new Error("worker bootstrap brief does not match the assigned task");
	const canonical = realpathSync(input.briefPath);
	const within = relative(realpathSync(input.briefDir), canonical);
	if (within === ".." || within.startsWith(`..${sep}`)) throw new Error("worker bootstrap brief escapes the programme brief directory");
	const brief = readFileSync(canonical, "utf8");
	if (!brief.trim()) throw new Error("worker bootstrap brief is empty");
	// The trusted bound client accepts through start_work, which owns registration
	// and versioned assignment acceptance. Inspect again rather than inventing state.
	await client.callTool("start_work", { task_id: taskId, title: task.title, kind: input.kind,
		...(input.model ? { model: input.model } : {}), cwd: input.cwd, worktree: input.cwd, pid: process.pid });
	const accepted = taskDetailOf((await client.callTool("inspect_work", { task_id: taskId })).structuredContent).task;
	if (accepted?.status !== "active" || accepted.agentId !== agentId) throw new Error("worker bootstrap assignment acceptance did not reach this agent");
	adoptLaunchReservation(programmeId, `lane:${agentId}`, `lane:${input.sessionId}`, control);
	return { brief, structured: { task_id: taskId, status: accepted.status, version: accepted.version, agent_id: agentId } };
}