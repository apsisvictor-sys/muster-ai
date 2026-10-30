import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import test from "node:test";

import * as lead from "../lead.ts";

/**
 * R1 / AM1.3 and AM1.5: whoever the operator drove last leads the project.
 *
 * A session becomes the orchestrator at its first orchestration act inside a
 * run that started from the operator's own input (keyboard or his bound Discord
 * account). Runs started by a relay, peer message, continuation or watchdog,
 * and worker lanes, never take ownership. Pure policy: no I/O in this file.
 */

test("an interactive or rpc input starts an operator run; an extension input does not", () => {
	for (const source of ["interactive", "rpc"] as const) {
		const t = lead.createRunOriginTracker();
		t.noteInput(source);
		t.runStarted();
		assert.equal(t.current(), "operator", source);
	}
	const t = lead.createRunOriginTracker();
	t.noteInput("extension");
	t.runStarted();
	assert.equal(t.current(), "automatic");
});

test("a bound Discord conversation counts as the operator, a relay or continuation does not", () => {
	const discord = lead.createRunOriginTracker();
	discord.noteOperatorRelay();
	discord.runStarted();
	assert.equal(discord.current(), "operator");
	const auto = lead.createRunOriginTracker();
	auto.noteAutomatic();
	auto.runStarted();
	assert.equal(auto.current(), "automatic");
});

test("a run with no recorded origin is automatic (fail closed)", () => {
	const t = lead.createRunOriginTracker();
	t.runStarted();
	assert.equal(t.current(), "automatic");
});

test("an operator input typed into a running automatic run upgrades it; an automatic message never downgrades an operator run", () => {
	const up = lead.createRunOriginTracker();
	up.noteAutomatic();
	up.runStarted();
	up.noteInput("interactive");
	assert.equal(up.current(), "operator");
	const keep = lead.createRunOriginTracker();
	keep.noteInput("interactive");
	keep.runStarted();
	keep.noteAutomatic();
	assert.equal(keep.current(), "operator");
});

test("an operator input queued before an automatic message wins for the run that starts", () => {
	const t = lead.createRunOriginTracker();
	t.noteAutomatic();
	t.noteInput("interactive");
	t.runStarted();
	assert.equal(t.current(), "operator");
});

test("a retry or compaction inside the operator's run starts the agent loop again without demoting it (F7)", () => {
	const t = lead.createRunOriginTracker();
	t.noteInput("interactive");
	t.runStarted();
	t.runStarted(); // Pi fires agent_start again for a retried or continued loop of the same run
	assert.equal(t.current(), "operator");
	t.runStarted();
	assert.equal(t.current(), "operator");
	t.runSettled();
	t.runStarted();
	assert.equal(t.current(), "automatic", "the next, separate run starts clean");
});

test("a retry inside an automatic run does not promote it either", () => {
	const t = lead.createRunOriginTracker();
	t.noteAutomatic();
	t.runStarted();
	t.runStarted();
	assert.equal(t.current(), "automatic");
});

test("settling the run clears the origin so the next run starts clean", () => {
	const t = lead.createRunOriginTracker();
	t.noteInput("interactive");
	t.runStarted();
	t.runSettled();
	assert.equal(t.current(), undefined);
	t.runStarted();
	assert.equal(t.current(), "automatic");
});

test("orchestration acts are the task and worker mutations, not reads, chat or plain edits", () => {
	const act = (toolName: string, input: Record<string, unknown> = {}) => lead.orchestrationActOf({ toolName, input });
	assert.equal(act("muster_start", { task_id: "t1" }), "create");
	assert.equal(act("muster_transfer", { action: "assign" }), "assign");
	assert.equal(act("muster_transfer", { action: "reassign" }), "assign");
	assert.equal(act("muster_transfer", { action: "accept" }), "accept");
	assert.equal(act("muster_finish", { outcome: "complete" }), "finish");
	assert.equal(act("bash", { command: "herdr pane split p1 --direction right --cwd /w" }), "launch");
	assert.equal(act("bash", { command: "herdr agent start lane --kind pi --pane p2" }), "launch");
	assert.equal(act("bash", { command: "herdr pane close p2" }), "close");
	assert.equal(act("bash", { command: "git merge --ff-only work/lane-1" }), "integrate");
	assert.equal(act("muster_transfer", { action: "decline" }), "decline");
	assert.equal(act("muster_transfer", { action: "release" }), "release");
	// Not acts.
	assert.equal(act("muster_transfer", { action: "offer" }), undefined);
	assert.equal(act("muster_transfer", { action: "reopen" }), undefined);
	assert.equal(act("muster_inspect"), undefined);
	assert.equal(act("muster_update"), undefined);
	assert.equal(act("edit", { path: "src/a.ts" }), undefined);
	assert.equal(act("write", { path: "src/a.ts" }), undefined);
	assert.equal(act("read"), undefined);
	assert.equal(act("bash", { command: "npm test" }), undefined);
	assert.equal(act("bash", { command: "echo herdr pane split" }), undefined, "text inside another command is not a launch");
	assert.equal(act("bash", { command: "git status" }), undefined);
});

test("a worker lane is recognised by its task environment and never leads", () => {
	assert.equal(lead.isWorkerSession({ CONCORD_TASK: "t-7" }), true);
	assert.equal(lead.isWorkerSession({ CONCORD_TASK: "  " }), false);
	assert.equal(lead.isWorkerSession({}), false);
	// A parent with a stable CONCORD_AGENT_ID is still a parent when that id is the project mailbox.
	assert.equal(lead.isWorkerSession({ CONCORD_AGENT_ID: "pi-be-master-plan-parent" }), false);
	assert.equal(lead.isWorkerSession({ CONCORD_AGENT_ID: "pi-be-master-plan-parent" }, "pi-be-master-plan-parent"), false);
	// Any other launcher-assigned id marks a lane, even one launched without CONCORD_TASK (F8).
	assert.equal(lead.isWorkerSession({ CONCORD_AGENT_ID: "pi-be-l97-ownership" }, "pi-be-master-plan-parent"), true);
	assert.equal(lead.isWorkerSession({ CONCORD_AGENT_ID: "pi-be-l97-ownership" }), false, "without a known mailbox only the task variable counts");
	assert.equal(lead.isWorkerSession({}, "pi-be-master-plan-parent"), false, "no launcher id at all is an ordinary session");
});

test("decideLead: leads on an operator act, refuses an automatic act, admits everything else", () => {
	const base = { worker: false, isOwner: false } as const;
	assert.equal(lead.decideLead({ ...base, act: "assign", origin: "operator" }), "lead");
	assert.equal(lead.decideLead({ ...base, act: "assign", origin: "automatic" }), "refuse-automatic");
	assert.equal(lead.decideLead({ ...base, act: "assign", origin: undefined }), "refuse-automatic");
	assert.equal(lead.decideLead({ ...base, act: undefined, origin: "operator" }), "admit", "plain tools never take ownership");
	assert.equal(lead.decideLead({ ...base, act: "launch", worker: true, origin: "operator" }), "admit", "workers never lead");
	assert.equal(lead.decideLead({ ...base, act: "assign", isOwner: true, origin: "automatic" }), "admit", "the owner keeps working");
});

test("notices: leading, superseded and the Discord takeover line", () => {
	const at = new Date(2026, 9, 3, 14, 5);
	assert.equal(lead.formatClock(at), "14:05");
	assert.equal(lead.leadingNotice("crm-app"), "Leading crm-app");
	assert.equal(
		lead.supersededNotice({ project: "crm-app", sessionName: "crm-app orchestrator", at }),
		"crm-app moved to session 'crm-app orchestrator' at 14:05. This session no longer orchestrates it.",
	);
	assert.equal(
		lead.connectedLine({ sessionName: "crm-app orchestrator", model: "zai/glm-5.3-flash", startedAt: at }),
		"Now connected to 'crm-app orchestrator' (zai/glm-5.3-flash), started 14:05. Previous orchestrator disconnected.",
	);
	assert.equal(lead.orchestratorSessionName("crm-app"), "crm-app orchestrator");
});
