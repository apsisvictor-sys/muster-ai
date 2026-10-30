/**
 * Lane report tests — A3 of the harness bus design, section 4.4 (D2).
 *
 * One report vocabulary mapping to Concord calls; a question outside the five
 * allowed kinds is refused before anything is written.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listInboxMessages } from "../lib/agent-inbox.ts";
import {
	LANE_REPORT_KINDS,
	ORCHESTRATOR_ADDRESS,
	appendOrchestratorEvent,
	notifyOrchestrator,
	orchestratorEventsPath,
	QUESTION_KINDS,
	formatEventLine,
	formatQuestion,
	laneReportFromParams,
	mapLaneReport,
	normalizeReportKind,
	reportEventLine,
	validateQuestion,
} from "../lane-report.ts";

test("kind vocabulary is the design's five plus already_done", () => {
	assert.deepEqual([...LANE_REPORT_KINDS], ["review_ready", "discovery_ready", "blocked", "question", "working", "already_done"]);
	assert.equal(normalizeReportKind("already-done"), "already_done");
	assert.equal(normalizeReportKind("review-ready"), "review_ready");
	assert.equal(normalizeReportKind("Review_Ready"), "review_ready");
	assert.equal(normalizeReportKind("nonsense"), undefined);
});

test("review_ready maps to finish_work with branch, sha and questions", () => {
	const mapped = mapLaneReport(
		{
			kind: "review_ready",
			summary: "the bus delivers",
			branch: "harness-bus-a3",
			sha: "abc123",
			base: "f4a28cf",
			logs: ["/tmp/log"],
			decidedMyself: ["went with herdr prompt"],
			questions: [{ kind: "product-rule", text: "which default mode?" }],
		},
		"TASK-9",
	);
	assert.equal(mapped.ok, true);
	if (!mapped.ok) return;
	assert.equal(mapped.call.tool, "finish_work");
	assert.equal(mapped.call.args["task_id"], "TASK-9");
	assert.equal(mapped.call.args["outcome"], "review_ready");
	assert.match(String(mapped.call.args["what_changed"]), /branch harness-bus-a3 @ abc123 \(base f4a28cf\)/);
	assert.deepEqual(mapped.call.args["tests_run"], ["/tmp/log"]);
	assert.deepEqual(mapped.call.args["decisions"], ["went with herdr prompt"]);
	assert.deepEqual(mapped.call.args["open_questions"], ["[product-rule] which default mode?"]);
});

test("review_ready outcome only travels with a measured value and carries provenance", () => {
	const refused = mapLaneReport({ kind: "review_ready", summary: "s", branch: "b", sha: "c", outcome: { source: "agent" } }, "T");
	assert.equal(refused.ok, false);
	const accepted = mapLaneReport({ kind: "review_ready", summary: "s", branch: "b", sha: "c", outcome: { acceptance: "accepted" } }, "T");
	assert.equal(accepted.ok, true);
	if (!accepted.ok) return;
	assert.deepEqual(accepted.call.args["reported_outcome"], { source: "agent", acceptance: "accepted" });
	assert.deepEqual(accepted.call.args["provenance"], [{ field: "reported_outcome", source: "lane_report review_ready c" }]);
});

test("review_ready requires summary, branch and sha", () => {
	for (const missing of ["summary", "branch", "sha"] as const) {
		const report: Record<string, unknown> = { kind: "review_ready", summary: "s", branch: "b", sha: "c" };
		delete report[missing];
		const mapped = mapLaneReport(report, "T");
		assert.equal(mapped.ok, false, missing);
		if (!mapped.ok) assert.match(mapped.error, new RegExp(missing));
	}
});

test("discovery_ready records a finding; blocked records a blocker; question records a question; working records progress", () => {
	const discovery = mapLaneReport({ kind: "discovery_ready", doc: "plans/x.md", sha: "d1" }, "T");
	assert.equal(discovery.ok, true);
	if (discovery.ok) {
		assert.equal(discovery.call.tool, "update_work");
		assert.equal(discovery.call.args["operation"], "record");
		assert.equal(discovery.call.args["kind"], "finding");
		assert.match(String(discovery.call.args["content"]), /plans\/x\.md @ d1/);
	}
	const blocked = mapLaneReport({ kind: "blocked", reason: "no route", needs: "the orchestrator's call" }, "T");
	assert.equal(blocked.ok, true);
	if (blocked.ok) {
		assert.equal(blocked.call.args["kind"], "blocker");
		assert.match(String(blocked.call.args["content"]), /Needs: the orchestrator's call/);
	}
	const question = mapLaneReport({ kind: "question", question: { kind: "schema-change", text: "add a column?" } }, "T");
	assert.equal(question.ok, true);
	if (question.ok) {
		assert.equal(question.call.args["kind"], "question");
		assert.equal(question.call.args["content"], "[schema-change] add a column?");
	}
	const working = mapLaneReport({ kind: "working", summary: "mid-way" }, "T");
	assert.equal(working.ok, true);
	if (working.ok) {
		assert.equal(working.call.args["kind"], "progress");
		assert.equal(working.call.args["content"], "mid-way");
	}
});

test("a question kind outside the five is refused with the allowed list", () => {
	const checked = validateQuestion({ kind: "curiosity", text: "why?" }, "question");
	assert.equal(checked.ok, false);
	if (!checked.ok) assert.match(checked.error, /product-rule, decision-conflict, schema-change, outward-facing, data-deletion/);
	assert.deepEqual([...QUESTION_KINDS], ["product-rule", "decision-conflict", "schema-change", "outward-facing", "data-deletion"]);
	const unknownField = validateQuestion({ kind: "product-rule", text: "why?", priority: "high" }, "question");
	assert.equal(unknownField.ok, false);
	const ok = validateQuestion({ kind: "outward-facing", text: "send the mail?", options: ["yes", "no"], recommendation: "yes" }, "question");
	assert.equal(ok.ok, true);
	if (ok.ok) assert.equal(formatQuestion(ok.question), "[outward-facing] send the mail?\nOptions: yes | no\nRecommendation: yes");
});

test("without a task the report is lane level: the same call, no task_id, plus the card line (check 3)", () => {
	const working = mapLaneReport({ kind: "working", summary: "mid-way" }, undefined);
	assert.equal(working.ok, true);
	if (!working.ok) return;
	assert.equal(working.call.tool, "update_work");
	assert.equal(working.call.args["kind"], "progress");
	assert.equal("task_id" in working.call.args, false, "no task behind it, so no task_id");
	assert.deepEqual(working.laneReport, { kind: "working", summary: "progress: mid-way" });

	const blocked = mapLaneReport({ kind: "blocked", reason: "no workspace", needs: "a .concord" }, undefined);
	assert.equal(blocked.ok, true);
	if (!blocked.ok) return;
	assert.equal("task_id" in blocked.call.args, false);
	assert.equal(blocked.laneReport?.summary, "BLOCKED: no workspace (needs: a .concord)");

	const review = mapLaneReport({ kind: "review_ready", summary: "done", branch: "b", sha: "c" }, undefined);
	assert.equal(review.ok, true);
	if (!review.ok) return;
	assert.equal("task_id" in review.call.args, false);
	assert.equal(review.laneReport?.kind, "review_ready");
	assert.match(review.laneReport?.summary ?? "", /^REVIEW READY: b@c — done$/);

	// With a task every kind keeps its task_id and still carries the card line (F7):
	// a lane holding a task used to leave `lastReport` empty on its card.
	const withTask = mapLaneReport({ kind: "working", summary: "s" }, "T-1");
	assert.equal(withTask.ok, true);
	if (!withTask.ok) return;
	assert.equal(withTask.call.args["task_id"], "T-1");
	assert.equal(withTask.level, "task");
	assert.deepEqual(withTask.laneReport, { kind: "working", summary: "progress: s" });
	assert.deepEqual(withTask.line, withTask.laneReport);
	assert.equal(working.level, "lane");
});

test("a waking report renders the event line the events file carries, and only the waking kinds", () => {
	assert.equal(reportEventLine("cc-x", { kind: "review_ready", summary: "done", branch: "b", sha: "abc123" }), "REVIEW READY: cc-x b@abc123 | done");
	assert.equal(reportEventLine("cc-x", { kind: "blocked", reason: "no workspace", needs: "a .concord" }), "BLOCKED: cc-x | no workspace (needs: a .concord)");
	assert.equal(reportEventLine("cc-x", { kind: "question", question: { kind: "product-rule", text: "which one?", options: ["a", "b"] } }), "QUESTION: cc-x | [product-rule] which one? Options: a | b");
	// Not waking kinds, and a malformed one, render nothing.
	assert.equal(reportEventLine("cc-x", { kind: "already_done", where: "9ad0149" }), "ALREADY DONE: cc-x | 9ad0149");
	assert.equal(reportEventLine("cc-x", { kind: "already_done" }), undefined);
	assert.equal(reportEventLine("cc-x", { kind: "working", summary: "mid-way" }), undefined);
	assert.equal(reportEventLine("cc-x", { kind: "discovery_ready", doc: "d.md" }), undefined);
	assert.equal(reportEventLine("cc-x", { kind: "review_ready", summary: "done" }), undefined);
});

test("formatEventLine builds every blueprint event shape on one line", () => {
	assert.equal(formatEventLine("REVIEW READY", "sn-s3", "lane/x@abc1234 | all green"), "REVIEW READY: sn-s3 lane/x@abc1234 | all green");
	assert.equal(formatEventLine("QUOTA WALL", "pi-a", "opencode-go walled until unknown; waiting"), "QUOTA WALL: pi-a | opencode-go walled until unknown; waiting");
	assert.equal(formatEventLine("CRASHED", "cc-a", "oauth_org_not_allowed"), "CRASHED: cc-a | oauth_org_not_allowed");
	assert.equal(formatEventLine("STALLED", "cc-a", "turn ended\nwith no event line: x\r\n"), "STALLED: cc-a | turn ended with no event line: x", "a line break would split one event into two waiter lines");
});

test("already_done records a finding naming where the outcome is, and wakes the orchestrator", () => {
	const mapped = mapLaneReport({ kind: "already_done", where: "9ad0149" }, "T");
	assert.equal(mapped.ok, true);
	if (mapped.ok) {
		assert.equal(mapped.call.tool, "update_work");
		assert.equal(mapped.call.args["kind"], "finding");
		assert.equal(mapped.call.args["content"], "Already done: 9ad0149");
		assert.equal(mapped.line.summary, "ALREADY DONE: 9ad0149");
	}
	const missing = mapLaneReport({ kind: "already_done" }, "T");
	assert.equal(missing.ok, false);
	assert.deepEqual(laneReportFromParams({ kind: "already_done", where: "f.ts" }), { kind: "already_done", where: "f.ts" });
});

test("the event line is appended to the events file beside the state dir, prefixed with the local ISO second", () => {
	const dir = mkdtempSync(join(tmpdir(), "lane-events-"));
	const stateDir = join(dir, "state", "muster");
	try {
		assert.equal(orchestratorEventsPath(stateDir), join(dir, "state", "orchestrator-events.log"));
		const at = new Date(2026, 9, 9, 21, 45, 3);
		assert.equal(appendOrchestratorEvent(stateDir, "REVIEW READY: cc-x b@abc123 | done", at), true);
		assert.equal(appendOrchestratorEvent(stateDir, "BLOCKED: cc-x | no workspace (needs: a .concord)", at), true);
		const lines = readFileSync(join(dir, "state", "orchestrator-events.log"), "utf8").split("\n").filter(Boolean);
		assert.equal(lines.length, 2, "one line per event");
		assert.match(lines[0]!, /^2026-10-09T21:45:03[+-]\d\d:\d\d REVIEW READY: cc-x b@abc123 \| done$/);
		assert.match(lines[1]!, /^2026-10-09T21:45:03[+-]\d\d:\d\d BLOCKED: cc-x \| no workspace \(needs: a \.concord\)$/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("tool parameters map to the same report object the validator takes", () => {
	const fromParams = laneReportFromParams({ kind: "review_ready", summary: "s", branch: "b", sha: "c", decided_myself: ["x"], questions: [{ kind: "product-rule", text: "q" }] });
	const mapped = mapLaneReport(fromParams, "T");
	assert.equal(mapped.ok, true);
	if (mapped.ok) {
		assert.deepEqual(mapped.call.args["decisions"], ["x"]);
		assert.deepEqual(mapped.call.args["open_questions"], ["[product-rule] q"]);
	}
	const working = laneReportFromParams({ kind: "working", summary: "s" });
	assert.deepEqual(working, { kind: "working", summary: "s" });
	const blocked = laneReportFromParams({ kind: "blocked", reason: "r", needs: "n" });
	assert.deepEqual(blocked, { kind: "blocked", reason: "r", needs: "n" });
});

test("unknown kind refuses with the vocabulary", () => {
	const mapped = mapLaneReport({ kind: "done" }, "T");
	assert.equal(mapped.ok, false);
	if (!mapped.ok) assert.match(mapped.error, /kind must be one of review_ready/);
});

test("a report that should wake the orchestrator lands in its inbox, task or not; progress does not", () => {
	const state = mkdtempSync(join(tmpdir(), "muster-report-notice-"));
	try {
		const lines = [
			mapLaneReport({ kind: "review_ready", summary: "done", branch: "b", sha: "c" }, undefined),
			mapLaneReport({ kind: "blocked", reason: "r", needs: "n" }, "T-1"),
			mapLaneReport({ kind: "discovery_ready", doc: "plans/x.md" }, undefined),
			mapLaneReport({ kind: "question", question: { kind: "product-rule", text: "which?" } }, undefined),
			mapLaneReport({ kind: "working", summary: "mid-way" }, undefined),
		];
		const notified = lines.map((mapped) => (mapped.ok && mapped.line !== undefined ? notifyOrchestrator(state, "pi-recall", mapped.line, new Date(Date.UTC(2026, 9, 8, 21, 0, 0))) : "no line"));
		assert.deepEqual(notified, [true, true, true, true, false], "a task-level report carries a line too; only working is not a wake");
		const inbox = listInboxMessages(state, ORCHESTRATOR_ADDRESS);
		assert.equal(inbox.length, 4);
		assert.ok(inbox.every((message) => message.from === "pi-recall" && message.agent === "orchestrator" && message.source === "report"));
		assert.match(inbox.map((message) => message.text).join("\n"), /REVIEW READY: b@c — done/);
		assert.match(inbox.map((message) => message.text).join("\n"), /BLOCKED: r \(needs: n\)/);
		// The orchestrator's own report is not mailed to itself, and an unwritable state dir does not throw.
		const own = mapLaneReport({ kind: "blocked", reason: "r", needs: "n" }, undefined);
		assert.equal(own.ok && own.line !== undefined && notifyOrchestrator(state, "orchestrator", own.line), false);
		const blocker = join(state, "not-a-directory");
		writeFileSync(blocker, "x");
		assert.equal(own.ok && own.line !== undefined && notifyOrchestrator(join(blocker, "state"), "pi-recall", own.line), false);
	} finally {
		rmSync(state, { recursive: true, force: true });
	}
});
