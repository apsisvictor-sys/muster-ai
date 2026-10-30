/**
 * The lane stage and health owner — blueprint Revision 7, D26 and CRS 1 to 3.
 *
 * One vocabulary for "where the lane stands" (the six stages and the two off-board values) and
 * one for "how it is doing" (the seven health values), so the composer, the change lines and
 * History cannot drift apart. Every row of D26's order and every case CRS 1 names is in the
 * two tables below, plus the CRS 3 grep that keeps a second implementation out of
 * `packages/muster`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
	HANDOFF_VERDICTS,
	LANE_HEALTH,
	LANE_HEALTH_LABELS,
	LANE_OFF_BOARD,
	LANE_STAGES,
	LANE_STAGE_LABELS,
	laneHealth,
	laneStage,
	roundsOf,
	type LaneHandoff,
	type LaneHealth,
	type LaneStageOrOff,
} from "../lane-stage.ts";
import type { LanePhase, LaneRecord } from "../lane-lifecycle.ts";
import type { LaneReportMark, LaneState } from "../lib/lane-card.ts";

const T = (iso: string): number => Date.parse(iso);
const LAUNCHED = T("2026-10-25T08:00:00.000Z");

const report = (kind: string, at: string): LaneReportMark => ({ kind, summary: `${kind} one`, at: T(at) });
const handoff = (verdict: LaneHandoff["verdict"], at: string): LaneHandoff => ({ at: T(at), by: "orchestrator", verdict });

type StageRow = {
	name: string;
	record: Pick<LaneRecord, "phase" | "terminal" | "launchedAt"> & { handoffs?: readonly LaneHandoff[] };
	latestReport?: LaneReportMark;
	lastTurnAt?: number | null;
	stage: LaneStageOrOff;
	alreadyDone?: boolean;
};

const base = (over: Partial<StageRow["record"]> = {}): StageRow["record"] => ({ phase: "working", terminal: undefined, launchedAt: LAUNCHED, ...over });

const terminal = (outcome: "merged" | "abandoned") => ({ outcome, reason: "closed", sha: null, at: T("2026-10-25T09:00:00.000Z") });

const STAGE_ROWS: StageRow[] = [
	// Rules 1 and 2: the terminal fact, then the phase.
	{ name: "a merged terminal", record: base({ phase: "merged", terminal: terminal("merged") }), stage: "merged" },
	{ name: "phase merged", record: base({ phase: "merged" }), stage: "merged" },
	{ name: "phase closed with a merged terminal", record: base({ phase: "closed", terminal: terminal("merged") }), stage: "merged" },
	{ name: "an abandoned terminal", record: base({ terminal: terminal("abandoned") }), stage: "abandoned" },
	{ name: "phase abandoned", record: base({ phase: "abandoned" }), stage: "abandoned" },
	{ name: "merged beats a sent-back handoff", record: base({ phase: "merged", terminal: terminal("merged"), handoffs: [handoff("sent-back", "2026-10-25T08:30:00.000Z")] }), stage: "merged" },
	// R2 (VR24-165, the CRS 1 row): a lane that reported already_done and was closed as merged.
	{ name: "already_done closed as merged", record: base({ phase: "merged", terminal: terminal("merged") }), latestReport: report("already_done", "2026-10-25T09:30:00.000Z"), stage: "merged", alreadyDone: true },
	// Rule 3: an old record closed before closeLane stored a terminal.
	{ name: "an old closed record with no terminal", record: base({ phase: "closed" }), stage: "closed" },
	// Rule 4: accepted and nothing newer.
	{ name: "accepted, no report", record: base({ handoffs: [handoff("accepted", "2026-10-25T09:00:00.000Z")] }), stage: "waiting-to-merge" },
	{ name: "accepted with an older review report", record: base({ handoffs: [handoff("accepted", "2026-10-25T09:00:00.000Z")] }), latestReport: report("review_ready", "2026-10-25T08:30:00.000Z"), stage: "waiting-to-merge" },
	// Rule 5: a review report newer than the latest handoff.
	{ name: "review_ready with no handoff", record: base(), latestReport: report("review_ready", "2026-10-25T09:00:00.000Z"), stage: "verifying" },
	{ name: "discovery_ready", record: base(), latestReport: report("discovery_ready", "2026-10-25T09:00:00.000Z"), stage: "verifying" },
	{ name: "already_done is a flag beside the stage", record: base(), latestReport: report("already_done", "2026-10-25T09:00:00.000Z"), stage: "verifying", alreadyDone: true },
	{ name: "a review report newer than an accepted handoff", record: base({ handoffs: [handoff("accepted", "2026-10-25T09:00:00.000Z")] }), latestReport: report("review_ready", "2026-10-25T09:30:00.000Z"), stage: "verifying" },
	{ name: "a review report newer than a send-back returns to verifying", record: base({ handoffs: [handoff("sent-back", "2026-10-25T09:00:00.000Z")] }), latestReport: report("review_ready", "2026-10-25T09:30:00.000Z"), stage: "verifying" },
	// A parked lane keeps the stage its report gives it: the rules never read the phase.
	{ name: "parked after review_ready", record: base({ phase: "parked" }), latestReport: report("review_ready", "2026-10-25T09:00:00.000Z"), stage: "verifying" },
	{ name: "parked after a question", record: base({ phase: "parked" }), latestReport: report("question", "2026-10-25T09:00:00.000Z"), stage: "working" },
	{ name: "parked after blocked", record: base({ phase: "parked" }), latestReport: report("blocked", "2026-10-25T09:00:00.000Z"), stage: "working" },
	// Rule 6: a send-back holds against every report that is not a review.
	{ name: "sent back with no report", record: base({ handoffs: [handoff("sent-back", "2026-10-25T09:00:00.000Z")] }), stage: "sent-back" },
	{ name: "sent back then working", record: base({ handoffs: [handoff("sent-back", "2026-10-25T09:00:00.000Z")] }), latestReport: report("working", "2026-10-25T09:30:00.000Z"), stage: "sent-back" },
	{ name: "blocked after a send-back", record: base({ handoffs: [handoff("sent-back", "2026-10-25T09:00:00.000Z")] }), latestReport: report("blocked", "2026-10-25T09:30:00.000Z"), stage: "sent-back" },
	{ name: "question after a send-back", record: base({ handoffs: [handoff("sent-back", "2026-10-25T09:00:00.000Z")] }), latestReport: report("question", "2026-10-25T09:30:00.000Z"), stage: "sent-back" },
	{ name: "an older send-back with a newer accepted handoff waits to merge", record: base({ handoffs: [handoff("sent-back", "2026-10-25T08:30:00.000Z"), handoff("accepted", "2026-10-25T09:00:00.000Z")] }), stage: "waiting-to-merge" },
	// Rule 7: no report, and no transcript turn after the launch.
	{ name: "no report, no turn", record: base(), lastTurnAt: null, stage: "assigning" },
	{ name: "no report, the turn stamp missing", record: base(), lastTurnAt: undefined, stage: "assigning" },
	{ name: "no report, a turn at the launch instant", record: base(), lastTurnAt: LAUNCHED, stage: "assigning" },
	{ name: "no report, a turn before the launch", record: base(), lastTurnAt: LAUNCHED - 60_000, stage: "assigning" },
	// A Claude lane whose hook wrote lastActivityMs still has no transcript turn: D26/Q3 reads lastTurnAt only,
	// and the type has no field for the activity stamp, so this row is the whole of that rule.
	{ name: "no report, activity stamp only", record: base(), lastTurnAt: null, stage: "assigning" },
	// Rule 8.
	{ name: "no report, a turn after the launch", record: base(), lastTurnAt: LAUNCHED + 60_000, stage: "working" },
	{ name: "a working report", record: base(), latestReport: report("working", "2026-10-25T09:00:00.000Z"), stage: "working" },
	{ name: "a blocked report with no handoff", record: base(), latestReport: report("blocked", "2026-10-25T09:00:00.000Z"), stage: "working" },
];

test("D26 stage order: every row of the table takes its stage and its already-done flag", () => {
	for (const row of STAGE_ROWS) {
		const got = laneStage({ record: row.record, latestReport: row.latestReport, lastTurnAt: row.lastTurnAt });
		assert.equal(got.stage, row.stage, row.name);
		assert.equal(got.alreadyDone, row.alreadyDone ?? false, `${row.name}: alreadyDone`);
	}
});

type HealthRow = {
	name: string;
	cardState: LaneState | undefined;
	phase: LanePhase | undefined;
	terminal?: boolean;
	latestReport?: LaneReportMark;
	handoffs?: readonly LaneHandoff[];
	leftover?: boolean;
	health: LaneHealth;
};

const HEALTH_ROWS: HealthRow[] = [
	// The card state speaks first.
	{ name: "a stalled card", cardState: "stalled", phase: "working", health: "stalled" },
	{ name: "a walled card", cardState: "quota-walled", phase: "working", health: "quota-walled" },
	{ name: "a blocked card", cardState: "blocked", phase: "blocked", health: "blocked" },
	{ name: "a stalled card beats a question report", cardState: "stalled", phase: "question", latestReport: report("question", "2026-10-25T09:00:00.000Z"), health: "stalled" },
	// The report speaks when the tick has parked the lane and the card is gone.
	{ name: "a blocked report with no handoff", cardState: "running", phase: "blocked", latestReport: report("blocked", "2026-10-25T09:00:00.000Z"), health: "blocked" },
	{ name: "a question report with no handoff", cardState: "running", phase: "question", latestReport: report("question", "2026-10-25T09:00:00.000Z"), health: "question" },
	{ name: "a question report with an older send-back", cardState: "running", phase: "question", latestReport: report("question", "2026-10-25T09:30:00.000Z"), handoffs: [handoff("sent-back", "2026-10-25T09:00:00.000Z")], health: "question" },
	{ name: "a blocked report with a newer handoff is on track", cardState: "running", phase: "working", latestReport: report("blocked", "2026-10-25T09:00:00.000Z"), handoffs: [handoff("accepted", "2026-10-25T09:30:00.000Z")], health: "ok" },
	// Q2: parking removes the card, so a parked lane's row says gone and its report gives the health.
	{ name: "a parked lane after review_ready, its row gone", cardState: "gone", phase: "parked", latestReport: report("review_ready", "2026-10-25T09:00:00.000Z"), health: "ok" },
	{ name: "a parked lane after question, its row gone", cardState: "gone", phase: "parked", latestReport: report("question", "2026-10-25T09:00:00.000Z"), health: "question" },
	{ name: "a parked lane after blocked, its row gone", cardState: "gone", phase: "parked", latestReport: report("blocked", "2026-10-25T09:00:00.000Z"), health: "blocked" },
	// A gone card with no terminal fact ended without a report.
	{ name: "a gone card with no report and no terminal", cardState: "gone", phase: "working", health: "gone" },
	{ name: "a gone card with a merged terminal", cardState: "gone", phase: "closed", terminal: true, health: "ok" },
	// The leftover test comes after gone, and before ok.
	{ name: "a closed lane whose scope is alive", cardState: "idle", phase: "closed", leftover: true, health: "leftover" },
	// R1 (VR24-165): a report gives the health only while the record has no terminal fact, so a closed lane's
	// old question report never overrides leftover.
	{ name: "a leftover lane with a question report", cardState: "idle", phase: "closed", terminal: true, latestReport: report("question", "2026-10-25T09:00:00.000Z"), leftover: true, health: "leftover" },
	{ name: "a running lane with no report", cardState: "running", phase: "working", health: "ok" },
	{ name: "a review-ready lane", cardState: "running", phase: "review_ready", latestReport: report("review_ready", "2026-10-25T09:00:00.000Z"), health: "ok" },
];

test("D26 health: the card, then the report, then gone unless parked, then leftover, else on track", () => {
	for (const row of HEALTH_ROWS) {
		const got = laneHealth({
			cardState: row.cardState,
			phase: row.phase,
			terminal: row.terminal ?? false,
			latestReport: row.latestReport,
			handoffs: row.handoffs,
			leftover: row.leftover ?? false,
		});
		assert.equal(got, row.health, row.name);
	}
});

test("D26 vocabulary: the six stages in order, the two off-board values, the seven health values and their words", () => {
	assert.deepEqual([...LANE_STAGES], ["assigning", "working", "verifying", "sent-back", "waiting-to-merge", "merged"]);
	assert.deepEqual([...LANE_OFF_BOARD], ["abandoned", "closed"]);
	assert.deepEqual(
		LANE_STAGES.map((stage) => LANE_STAGE_LABELS[stage]),
		["Assigning", "Working", "Verifying", "Sent back", "Waiting to merge", "Merged"],
	);
	assert.deepEqual([...LANE_HEALTH], ["ok", "stalled", "quota-walled", "blocked", "question", "gone", "leftover"]);
	assert.deepEqual(
		LANE_HEALTH.map((health) => LANE_HEALTH_LABELS[health]),
		["On track", "Stalled", "Walled", "Blocked", "Asks a question", "Ended without a report", "Closed, still running"],
	);
	assert.deepEqual([...HANDOFF_VERDICTS], ["sent-back", "accepted"]);
	// Every value a reader can get has a word, off-board ones included.
	for (const key of [...LANE_STAGES, ...LANE_OFF_BOARD] as const) assert.equal(typeof LANE_STAGE_LABELS[key], "string", key);
});

test("D26 rounds: the send-backs on the record, and none when there is no record field", () => {
	assert.equal(roundsOf(undefined), 0);
	assert.equal(roundsOf([]), 0);
	assert.equal(roundsOf([handoff("accepted", "2026-10-25T09:00:00.000Z")]), 0);
	assert.equal(roundsOf([handoff("sent-back", "2026-10-25T08:00:00.000Z"), handoff("accepted", "2026-10-25T08:30:00.000Z"), handoff("sent-back", "2026-10-25T09:00:00.000Z")]), 2);
});

test("CRS 3: no file in packages/muster but lane-stage.ts names a stage by its key", () => {
	const root = join(import.meta.dirname, "..");
	const offenders: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				// The package's own tests assert the vocabulary and carry stage rows as fixtures, so
				// they name the keys on purpose. The split moved them inside the package; before it
				// they sat outside `packages/muster` and this walk never reached them (RS3CI).
				if (entry.name !== "node_modules" && path !== join(root, "tests")) walk(path);
				continue;
			}
			if (!/\.(ts|mjs|js|html)$/.test(entry.name)) continue;
			if (path === join(root, "lane-stage.ts")) continue;
			const lines = readFileSync(path, "utf8").split("\n");
			for (const [index, line] of lines.entries()) {
				if (line.includes('"sent-back"') || line.includes('"waiting-to-merge"')) offenders.push(`${path}:${index + 1}`);
			}
		}
	};
	walk(root);
	assert.deepEqual(offenders, [], "a stage key outside its owner");
});
