import "./muster-test-isolation.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLaneCard, writeLaneCard, type LaneCard } from "../lib/lane-card.ts";
import { markReportNudged, reportedThisCycle, reportNudgeDue, reportNudgeExempt } from "../report-nudge.ts";

/** The report nudge rule (LD7): who is asked, and when it is spent. */

const report = (kind: string, at: number) => ({ kind, summary: "x", at });

test("a lane with no report is due; any ending report in the cycle, or a spent nudge, is not", () => {
	assert.equal(reportNudgeDue("cc-lane", {}), true);
	assert.equal(reportNudgeDue("cc-lane", { cycleStartedAt: 100, lastReport: report("working", 150) }), true, "progress is not an ending");
	for (const kind of ["review_ready", "blocked", "question", "already_done", "discovery_ready"]) {
		assert.equal(reportNudgeDue("cc-lane", { cycleStartedAt: 100, lastReport: report(kind, 100) }), false, kind);
	}
	assert.equal(reportNudgeDue("cc-lane", { cycleStartedAt: 100, lastReport: report("review_ready", 99) }), true, "a report from before the cycle belongs to an earlier one");
	assert.equal(reportNudgeDue("cc-lane", { cycleStartedAt: 100, reportNudgedAt: 120 }), false, "once per cycle");
	assert.equal(reportNudgeDue("cc-lane", { cycleStartedAt: 200, reportNudgedAt: 120 }), true, "a new cycle is asked again");
	assert.equal(reportNudgeDue("cc-lane", undefined), false, "a lane with nothing to read is not guessed at");
});

test("the orchestrator and the operator's own rows are never asked", () => {
	assert.equal(reportNudgeExempt("orchestrator"), true);
	assert.equal(reportNudgeExempt("operator:claude:ab12cd34"), true);
	assert.equal(reportNudgeExempt("pi-wp7"), false);
	assert.equal(reportNudgeDue("orchestrator", {}), false);
	assert.equal(reportNudgeDue("operator:pi:ab12cd34", {}), false);
});

test("a conversation lane is not due, whatever else is true, while the waiter and tab exemptions still ask by lane id alone", () => {
	assert.equal(reportNudgeDue("sn-design", { conversation: true }), false);
	assert.equal(reportNudgeDue("sn-design", { conversation: false }), true);
	assert.equal(reportNudgeDue("sn-design", {}), true, "absent means a worker");
	assert.equal(reportNudgeExempt("sn-design"), false, "the id-only exemption (waiter, tabs) does not spare a conversation lane");
});

test("a report with no timestamp counts only as old as the epoch", () => {
	assert.equal(reportedThisCycle({ lastReport: { kind: "review_ready", summary: "x" } }), true, "no cycle recorded");
	assert.equal(reportedThisCycle({ cycleStartedAt: 5, lastReport: { kind: "review_ready", summary: "x" } }), false);
});

test("marking the nudge writes the lane's card and keeps its other fields; a lane with no card is refused", () => {
	const dir = mkdtempSync(join(tmpdir(), "report-nudge-"));
	try {
		assert.equal(markReportNudged(dir, "cc-lane", 5), false);
		const card: LaneCard = { laneId: "cc-lane", harness: "claude", cwd: null, branch: null, state: "idle", model: "m", thinking: null, since: 1, updatedAt: 1, wall: null, cycleStartedAt: 3 };
		writeLaneCard(dir, card);
		assert.equal(markReportNudged(dir, "cc-lane", 5), true);
		assert.deepEqual(readLaneCard(dir, "cc-lane"), { ...card, reportNudgedAt: 5 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
