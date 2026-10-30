import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import test from "node:test";

import * as frontier from "../frontier.ts";

/**
 * R1 item 2: continue automatically. The frontier is the work that is waiting
 * for the parent: a handoff addressed to its mailbox, a returned or blocked
 * task, or a free lane while a dispatchable task exists. Pure evaluation over
 * Concord-shaped rows; no I/O in the predicate.
 */

const MAILBOX = "pi-sandbox-parent";

const task = (taskId: string, status: string, extra: Record<string, unknown> = {}) => ({ taskId, status, ...extra });

test("a handoff addressed to the parent mailbox is actionable", () => {
	const work = frontier.evaluateActionableWork({
		tasks: [task("t1", "handoff_offered", { ownerAgentId: "worker-1", pendingHandoffTo: MAILBOX })],
		mailbox: MAILBOX,
		ceiling: 5,
	});
	assert.equal(work.actionable, true);
	assert.deepEqual(work.handoffs, ["t1"]);
});

test("a handoff addressed to someone else is not the parent's work", () => {
	const work = frontier.evaluateActionableWork({
		tasks: [task("t1", "handoff_offered", { ownerAgentId: "worker-1", pendingHandoffTo: "pi-other-parent" })],
		mailbox: MAILBOX,
		ceiling: 5,
	});
	assert.equal(work.actionable, false);
});

test("returned and blocked tasks are actionable", () => {
	const returned = frontier.evaluateActionableWork({ tasks: [task("t2", "review_ready", { ownerAgentId: "worker-2" })], mailbox: MAILBOX, ceiling: 5 });
	assert.deepEqual(returned.returned, ["t2"]);
	assert.equal(returned.actionable, true);
	const handedOff = frontier.evaluateActionableWork({ tasks: [task("t3", "handed_off", { ownerAgentId: "worker-3" })], mailbox: MAILBOX, ceiling: 5 });
	assert.deepEqual(handedOff.returned, ["t3"]);
	const blocked = frontier.evaluateActionableWork({ tasks: [task("t4", "blocked", { ownerAgentId: "worker-4" })], mailbox: MAILBOX, ceiling: 5 });
	assert.deepEqual(blocked.blocked, ["t4"]);
	assert.equal(blocked.actionable, true);
});

test("a proposed task is dispatchable only while a lane is free", () => {
	const live = (n: number) => Array.from({ length: n }, (_, i) => task(`w${i}`, "active", { ownerAgentId: `worker-${i}` }));
	const open = frontier.evaluateActionableWork({ tasks: [...live(2), task("p1", "proposed")], mailbox: MAILBOX, ceiling: 3 });
	assert.equal(open.liveLanes, 2);
	assert.equal(open.freeLanes, 1);
	assert.deepEqual(open.dispatchable, ["p1"]);
	assert.equal(open.actionable, true);
	const full = frontier.evaluateActionableWork({ tasks: [...live(3), task("p1", "proposed")], mailbox: MAILBOX, ceiling: 3 });
	assert.equal(full.freeLanes, 0);
	assert.deepEqual(full.dispatchable, []);
	assert.equal(full.actionable, false);
});

test("the parent's own tasks do not count as worker lanes", () => {
	const work = frontier.evaluateActionableWork({
		tasks: [task("mine", "active", { ownerAgentId: MAILBOX }), task("p1", "proposed")],
		mailbox: MAILBOX,
		ceiling: 1,
	});
	assert.equal(work.liveLanes, 0);
	assert.deepEqual(work.dispatchable, ["p1"]);
});

test("running workers alone are not actionable work", () => {
	const work = frontier.evaluateActionableWork({
		tasks: [task("w1", "active", { ownerAgentId: "worker-1" }), task("w2", "assigned", { assignedAgentId: "worker-2" })],
		mailbox: MAILBOX,
		ceiling: 5,
	});
	assert.equal(work.actionable, false);
	assert.equal(work.liveLanes, 2);
});

test("completed and closed tasks never count", () => {
	const work = frontier.evaluateActionableWork({ tasks: [task("c1", "complete"), task("c2", "closed")], mailbox: MAILBOX, ceiling: 5 });
	assert.equal(work.actionable, false);
});

test("the fingerprint ignores row order and changes when the actionable set changes", () => {
	const a = task("t1", "handoff_offered", { pendingHandoffTo: MAILBOX });
	const b = task("t2", "blocked", { ownerAgentId: "worker-2" });
	const one = frontier.evaluateActionableWork({ tasks: [a, b], mailbox: MAILBOX, ceiling: 5 });
	const two = frontier.evaluateActionableWork({ tasks: [b, a], mailbox: MAILBOX, ceiling: 5 });
	const fewer = frontier.evaluateActionableWork({ tasks: [a], mailbox: MAILBOX, ceiling: 5 });
	assert.equal(one.fingerprint, two.fingerprint);
	assert.notEqual(one.fingerprint, fewer.fingerprint);
});

test("the reason names what is waiting, in plain words", () => {
	const work = frontier.evaluateActionableWork({
		tasks: [
			task("t1", "handoff_offered", { pendingHandoffTo: MAILBOX }),
			task("t2", "blocked", { ownerAgentId: "worker-2" }),
			task("p1", "proposed"),
		],
		mailbox: MAILBOX,
		ceiling: 5,
	});
	const text = frontier.frontierReason(work);
	assert.match(text, /handoff.*t1/);
	assert.match(text, /blocked.*t2/);
	assert.match(text, /free lane/);
	assert.match(text, /p1/);
});

test("next-best-step candidates ride the frontier wake when lanes are free and nothing is dispatchable", () => {
	const work = frontier.evaluateActionableWork({
		tasks: [
			{ taskId: "lane-1", status: "active", ownerAgentId: "worker-1" },
			{ taskId: "t9", status: "complete", notes: "next: write the reviewer gate" },
		],
		mailbox: MAILBOX,
		ceiling: 2,
	});
	assert.deepEqual(work.dispatchable, []);
	assert.equal(work.nextCandidates?.[0]?.text, "write the reviewer gate");
	const text = frontier.frontierReason(work);
	assert.match(text, /Rank these candidates/);
	assert.match(text, /\[next\] write the reviewer gate/);
	assert.match(text, /decision card/);
});

test("a dispatchable task keeps the frontier reason about dispatch, with no candidate list", () => {
	const work = frontier.evaluateActionableWork({
		tasks: [
			{ taskId: "lane-1", status: "active", ownerAgentId: "worker-1" },
			{ taskId: "p1", status: "proposed" },
			{ taskId: "t9", status: "complete", notes: "next: something later" },
		],
		mailbox: MAILBOX,
		ceiling: 2,
	});
	assert.deepEqual(work.dispatchable, ["p1"]);
	assert.equal(work.nextCandidates, undefined, "candidates only matter when nothing is ready");
	assert.match(frontier.frontierReason(work), /ready to dispatch \(p1\)/);
});

test("readFrontierTasks reads the roster and the addressee of each offered handoff", async () => {
	const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	const rows = await frontier.readFrontierTasks(async (name, args) => {
		calls.push({ name, args });
		if (args["task_id"] === "t1") {
			return { structuredContent: { task: { taskId: "t1" }, pending_handoff: { id: 7, fromAgentId: "worker-1", toAgentId: MAILBOX } } };
		}
		return {
			structuredContent: {
				active: [
					{ taskId: "t1", status: "handoff_offered", agentId: "worker-1", assignedAgentId: null },
					{ taskId: "t2", status: "active", agentId: "worker-2", assignedAgentId: "worker-2" },
					{ taskId: "t3", status: "proposed", agentId: null, assignedAgentId: null },
				],
			},
		};
	});
	assert.deepEqual(
		rows.map((row) => [row.taskId, row.status, row.ownerAgentId, row.pendingHandoffTo]),
		[
			["t1", "handoff_offered", "worker-1", MAILBOX],
			["t2", "active", "worker-2", undefined],
			["t3", "proposed", undefined, undefined],
		],
	);
	assert.equal(calls.filter((call) => call.args["task_id"] !== undefined).length, 1, "only offered handoffs are read in detail");
});

test("readFrontierTasks returns nothing for a malformed roster instead of guessing", async () => {
	assert.deepEqual(await frontier.readFrontierTasks(async () => ({ structuredContent: { active: "nope" } })), []);
	assert.deepEqual(await frontier.readFrontierTasks(async () => ({})), []);
});
