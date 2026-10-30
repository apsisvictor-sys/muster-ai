/**
 * Lane record tests — WP1 of the lane lifecycle blueprint (2026-10-11).
 *
 * The record is the lane's life from launch to close and outlives the card.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLaneReportMark, readLaneCard, recordLaneReport, writeLaneCard, type LaneCard } from "../lib/lane-card.ts";
import {
	archiveLaneRecord,
	decideLifecycle,
	isConversationLane,
	laneRecordsArchiveDir,
	laneRecordsDir,
	markReminded,
	readLaneRecord,
	readProtectedLanes,
	recordLaunch,
	recordReport,
	recordSession,
	writeLaneRecord,
	type GitFacts,
	type LaneRecord,
	type LifecycleAction,
} from "../lane-lifecycle.ts";
import { mapLaneReport } from "../lane-report.ts";

const T0 = Date.parse("2026-10-11T20:00:00Z");

function stateDir(): string {
	return mkdtempSync(join(tmpdir(), "lane-lifecycle-"));
}

function record(overrides: Partial<LaneRecord> = {}): LaneRecord {
	return { laneId: "sn-x", harness: "claude", cwd: "/w/x", branch: "lane/x", launchedAt: T0, launchedBy: "orchestrator", phase: "working", phaseSince: T0, ...overrides };
}

test("a record round-trips through the file", () => {
	const dir = stateDir();
	try {
		const original = record({ sessionId: "s-1", parkedAt: T0 + 5, reminded: { stalledAt: T0 + 9 }, terminal: { outcome: "merged", reason: "in origin/dev", sha: "abc1234", at: T0 + 10 } });
		writeLaneRecord(dir, original);
		assert.deepEqual(readLaneRecord(dir, "sn-x"), original);
		assert.equal(existsSync(join(laneRecordsDir(dir), "sn-x.json")), true);
		assert.deepEqual(readdirSync(laneRecordsDir(dir)), ["sn-x.json"], "no tmp file is left behind");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a review_ready report updates the phase, the line and the SHA", () => {
	const dir = stateDir();
	try {
		writeLaneRecord(dir, record({ reminded: { orchestratorAt: T0 } }));
		recordReport(dir, "sn-x", { kind: "review_ready", summary: "REVIEW READY: lane/x@abc1234 — done", at: T0 + 60_000, branch: "lane/x", sha: "abc1234", base: "df47d5a" });
		const after = readLaneRecord(dir, "sn-x")!;
		assert.equal(after.phase, "review_ready");
		assert.equal(after.phaseSince, T0 + 60_000);
		assert.equal(after.lastReport?.sha, "abc1234");
		assert.equal(after.lastReport?.branch, "lane/x");
		assert.equal(after.lastReport?.base, "df47d5a");
		assert.deepEqual(after.reminded, {}, "a new report starts the reminders over");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("each report kind moves the phase it names, and a handoff that is not a review waits like one", () => {
	const dir = stateDir();
	try {
		const expected: Array<[string, string]> = [["blocked", "blocked"], ["question", "question"], ["working", "working"], ["discovery_ready", "review_ready"], ["already_done", "review_ready"]];
		for (const [kind, phase] of expected) {
			writeLaneRecord(dir, record());
			recordReport(dir, "sn-x", { kind, summary: kind, at: T0 + 1 });
			assert.equal(readLaneRecord(dir, "sn-x")!.phase, phase, kind);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a parked lane that reports is working again; a closed record keeps its phase", () => {
	const dir = stateDir();
	try {
		writeLaneRecord(dir, record({ phase: "parked", parkedAt: T0 }));
		recordReport(dir, "sn-x", { kind: "working", summary: "progress: resumed", at: T0 + 1 });
		const resumed = readLaneRecord(dir, "sn-x")!;
		assert.equal(resumed.phase, "working");
		assert.equal(resumed.parkedAt, undefined);
		writeLaneRecord(dir, record({ phase: "closed" }));
		recordReport(dir, "sn-x", { kind: "working", summary: "late", at: T0 + 2 });
		const closed = readLaneRecord(dir, "sn-x")!;
		assert.equal(closed.phase, "closed");
		assert.equal(closed.lastReport?.summary, "late");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a report for a lane with no record creates nothing", () => {
	const dir = stateDir();
	try {
		recordReport(dir, "sn-none", { kind: "working", summary: "s", at: T0 });
		assert.equal(readLaneRecord(dir, "sn-none"), undefined);
		assert.equal(existsSync(laneRecordsDir(dir)), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("recordLaneReport feeds the record and the card from one call, and works with no card", () => {
	const dir = stateDir();
	try {
		const card: LaneCard = { laneId: "sn-x", harness: "claude", cwd: "/w/x", branch: "lane/x", state: "running", model: null, thinking: null, since: T0, updatedAt: T0, wall: null };
		writeLaneCard(dir, card);
		writeLaneRecord(dir, record());
		const mark = { kind: "review_ready", summary: "REVIEW READY: lane/x@abc1234 — done", at: T0 + 1, branch: "lane/x", sha: "abc1234" };
		assert.equal(recordLaneReport(dir, "sn-x", mark), true);
		assert.deepEqual(readLaneCard(dir, "sn-x")!.lastReport, mark);
		assert.equal(readLaneRecord(dir, "sn-x")!.lastReport?.sha, "abc1234");
		// A lane with a record but no card: the card answer stays false, the record still takes the report.
		writeLaneRecord(dir, record({ laneId: "sn-nocard" }));
		assert.equal(recordLaneReport(dir, "sn-nocard", mark), false);
		assert.equal(readLaneRecord(dir, "sn-nocard")!.phase, "review_ready");
		// A lane id that cannot name a record file never breaks the card path.
		assert.equal(recordLaneReport(dir, "../escape", mark), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("archiving moves the file into the month folder and never deletes it", () => {
	const dir = stateDir();
	try {
		writeLaneRecord(dir, record());
		archiveLaneRecord(dir, "sn-x", Date.parse("2026-10-12T08:00:00Z"));
		assert.equal(readLaneRecord(dir, "sn-x"), undefined);
		const archived = join(laneRecordsArchiveDir(dir), "2026-10", "sn-x.json");
		assert.equal(existsSync(archived), true);
		// The same lane name archived again the same month keeps both files.
		writeLaneRecord(dir, record({ launchedAt: T0 + 1 }));
		archiveLaneRecord(dir, "sn-x", Date.parse("2026-10-20T08:00:00Z"));
		assert.equal(readdirSync(join(laneRecordsArchiveDir(dir), "2026-10")).length, 2);
		// Archiving a lane with no record is a no-op.
		assert.doesNotThrow(() => archiveLaneRecord(dir, "sn-none", T0));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an unreadable record reads as undefined and never throws", () => {
	const dir = stateDir();
	try {
		mkdirSync(laneRecordsDir(dir), { recursive: true });
		writeFileSync(join(laneRecordsDir(dir), "empty.json"), "");
		writeFileSync(join(laneRecordsDir(dir), "torn.json"), '{"laneId":"torn","phase":"wor');
		writeFileSync(join(laneRecordsDir(dir), "foreign.json"), JSON.stringify({ laneId: "someone-else", phase: "working", phaseSince: 1, launchedAt: 1 }));
		writeFileSync(join(laneRecordsDir(dir), "shapeless.json"), JSON.stringify({ laneId: "shapeless" }));
		for (const id of ["empty", "torn", "foreign", "shapeless", "missing", "../escape", ""]) assert.equal(readLaneRecord(dir, id), undefined, id);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a report mark accepts the branch, sha and base, and refuses a foreign type for them", () => {
	assert.equal(isLaneReportMark({ kind: "review_ready", summary: "s", at: 1, branch: "b", sha: "c", base: "d" }), true);
	assert.equal(isLaneReportMark({ kind: "working", summary: "s", at: 1 }), true);
	assert.equal(isLaneReportMark({ kind: "review_ready", summary: "s", at: 1, sha: 7 }), false);
	assert.equal(isLaneReportMark({ kind: "review_ready", summary: "s", at: 1, branch: {} }), false);
});

test("the mapped report line carries branch, sha and base for review_ready and the sha for discovery_ready only", () => {
	const review = mapLaneReport({ kind: "review_ready", summary: "done", branch: "lane/x", sha: "abc1234", base: "df47d5a" }, undefined);
	assert.ok(review.ok);
	assert.deepEqual({ branch: review.line.branch, sha: review.line.sha, base: review.line.base }, { branch: "lane/x", sha: "abc1234", base: "df47d5a" });
	const noBase = mapLaneReport({ kind: "review_ready", summary: "done", branch: "lane/x", sha: "abc1234" }, undefined);
	assert.ok(noBase.ok);
	assert.equal("base" in noBase.line, false);
	const discovery = mapLaneReport({ kind: "discovery_ready", doc: "d.md", sha: "abc1234" }, undefined);
	assert.ok(discovery.ok);
	assert.equal(discovery.line.sha, "abc1234");
	const bare = mapLaneReport({ kind: "discovery_ready", doc: "d.md" }, undefined);
	assert.ok(bare.ok);
	assert.equal("sha" in bare.line, false);
	const blocked = mapLaneReport({ kind: "blocked", reason: "r", needs: "n" }, undefined);
	assert.ok(blocked.ok);
	assert.deepEqual(Object.keys(blocked.line).sort(), ["kind", "summary"]);
});

// ─── The reconciler (WP3) ───────────────────────────────────────────────────────────────────────

const MIN = 60_000;
const NOW = T0 + 10 * 60 * MIN;

/** Git facts for a fixture: everything is a clean linked worktree whose commits are on their branch and not merged, unless a test says otherwise. */
function git(overrides: Partial<GitFacts> = {}): GitFacts {
	return { isAncestor: () => false, isClean: () => true, onBranch: () => true, isLinkedWorktree: () => true, ...overrides };
}

/** A handed-off lane whose last turn was `idleMin` minutes before NOW. */
function handedOff(laneId: string, idleMin: number, overrides: Partial<LaneRecord> = {}): { row: LaneCard; rec: LaneRecord } {
	const at = NOW - idleMin * MIN;
	const rec = record({
		laneId,
		cwd: `/w/${laneId}`,
		branch: `lane/${laneId}`,
		phase: "review_ready",
		phaseSince: at,
		lastReport: { kind: "review_ready", summary: "done", at, branch: `lane/${laneId}`, sha: "abc1234def" },
		...overrides,
	});
	const row: LaneCard = { laneId, harness: "claude", cwd: rec.cwd, branch: rec.branch, state: "idle", model: null, thinking: null, since: at, updatedAt: null, wall: null, origin: "auto", alive: true, aliveVia: "claude-agents", lastTurnAt: at, lastActivityMs: at };
	return { row, rec };
}

function decide(lanes: Array<{ row: LaneCard; rec: LaneRecord }>, facts: GitFacts = git(), options: { protectedLanes?: string[]; now?: number } = {}): LifecycleAction[] {
	return decideLifecycle(lanes.map((l) => l.row), new Map(lanes.map((l) => [l.rec.laneId, l.rec])), facts, options.now ?? NOW, options.protectedLanes === undefined ? {} : { protectedLanes: options.protectedLanes });
}

test("a reported commit that is in origin/dev or origin/main closes the lane as merged, and a merge needs a clean worktree", () => {
	const lane = handedOff("sn-a", 5);
	for (const ref of ["origin/dev", "origin/main"]) {
		const actions = decide([lane], git({ isAncestor: (_cwd, _sha, r) => r === ref }));
		assert.deepEqual(actions, [{ kind: "close", lane: "sn-a", outcome: "merged", reason: `reported abc1234 is in ${ref}`, sha: "abc1234def" }]);
	}
	assert.deepEqual(decide([lane], git({ isAncestor: () => true, isClean: () => false })), [{ kind: "flag-dirty", lane: "sn-a", reminder: "stalledAt" }], "a dirty merged lane is flagged, never closed");
});

test("a lane still working on feedback is not closed by an old merged report, but a dead one is", () => {
	const lane = handedOff("sn-a", 5, { phase: "working" });
	assert.deepEqual(decide([lane], git({ isAncestor: () => true })), []);
	lane.row.alive = false;
	assert.equal(decide([lane], git({ isAncestor: () => true }))[0]?.kind, "close");
});

test("review_ready idle for 29 minutes: no action; idle for 31 with a clean worktree: parked", () => {
	assert.deepEqual(decide([handedOff("sn-a", 29)]), []);
	assert.deepEqual(decide([handedOff("sn-a", 31)]), [{ kind: "park", lane: "sn-a", why: "idle-30m" }]);
});

test("a lane that is running or has a tool executing is not parked, and the clock counts from the later of the last turn and the report", () => {
	const running = handedOff("sn-a", 90);
	running.row.state = "running";
	assert.deepEqual(decide([running]), []);
	const tool = handedOff("sn-b", 90);
	tool.row.toolStartedAt = NOW - 5 * MIN;
	assert.deepEqual(decide([tool]), []);
	const recent = handedOff("sn-c", 90);
	recent.row.lastTurnAt = NOW - 2 * MIN;
	assert.deepEqual(decide([recent]), [], "a turn 2 minutes ago is not idle");
	const resumed = handedOff("sn-d", 90);
	resumed.rec.phaseSince = NOW - 3 * MIN;
	assert.deepEqual(decide([resumed]), [], "a report 3 minutes ago starts the clock again");
});

test("idle with a dirty worktree: flag-dirty once, never parked", () => {
	const lane = handedOff("sn-a", 45);
	assert.deepEqual(decide([lane], git({ isClean: () => false })), [{ kind: "flag-dirty", lane: "sn-a", reminder: "stalledAt" }]);
	lane.rec.reminded = { stalledAt: NOW - MIN };
	assert.deepEqual(decide([lane], git({ isClean: () => false })), [], "the flag fires once");
});

test("blocked at 2 h: an event; at 12 h: a line to the operator; each fires once, including after the lane is parked", () => {
	const blocked = (idle: number, overrides: Partial<LaneRecord> = {}) =>
		handedOff("sn-a", idle, { phase: "blocked", lastReport: { kind: "blocked", summary: "needs the key", at: NOW - idle * MIN }, ...overrides });
	assert.deepEqual(decide([blocked(100)]).map((a) => a.kind), ["park"], "under 2 h it is only parked");
	const at2h = decide([blocked(125)]);
	assert.deepEqual(at2h.map((a) => a.kind), ["park", "event"]);
	assert.deepEqual(at2h[1], { kind: "event", lane: "sn-a", detail: "blocked not absorbed for 2.1 h: needs the key", reminder: "orchestratorAt" });
	assert.deepEqual(decide([blocked(125, { reminded: { orchestratorAt: NOW } })]).map((a) => a.kind), ["park"]);
	const at12h = decide([blocked(13 * 60, { reminded: { orchestratorAt: NOW } })]);
	const operator = at12h.find((a) => a.kind === "tell-operator");
	assert.ok(operator && operator.kind === "tell-operator" && operator.reminder === "operatorAt");
	assert.match(operator.text, /sn-a has waited 13 h with blocked: needs the key\. Recommendation: answer it with muster send sn-a/);
	assert.deepEqual(decide([blocked(13 * 60, { reminded: { orchestratorAt: NOW, operatorAt: NOW, stalledAt: NOW } })]).map((a) => a.kind), ["park"]);
	// Once parked, the reminders keep running from the report time.
	const parked = blocked(125, { phase: "parked", phaseSince: NOW - 60 * MIN, parkedAt: NOW - 60 * MIN });
	assert.deepEqual(decide([parked]).map((a) => a.kind), ["event"]);
});

test("a review_ready lane gets the same two reminders, with a review recommendation", () => {
	const lane = handedOff("sn-a", 13 * 60, { phase: "parked", parkedAt: NOW - 600 * MIN, phaseSince: NOW - 600 * MIN });
	const actions = decide([lane]);
	const operator = actions.find((a) => a.kind === "tell-operator");
	assert.ok(operator && operator.kind === "tell-operator");
	assert.match(operator.text, /Recommendation: review and merge lane\/sn-a@abc1234, or close it with muster close sn-a --abandoned/);
});

test("a dead process with no terminal state closes the lane as abandoned (died: …) and tells the operator once the close worked", () => {
	const lane = handedOff("sn-a", 45, { phase: "working", lastReport: undefined });
	lane.row.alive = false;
	lane.row.aliveVia = "pid";
	const actions = decide([lane]);
	assert.equal(actions.length, 2);
	assert.deepEqual(actions[0], { kind: "close", lane: "sn-a", outcome: "abandoned", reason: `died: process gone, last turn ${new Date(NOW - 45 * MIN).toISOString()}`, sha: null });
	assert.equal(actions[1]?.kind, "tell-operator");
	assert.equal((actions[1] as { afterClose?: boolean }).afterClose, true);
	lane.row.wall = { shapeId: "claude-subscription-disabled" };
	assert.match((decide([lane])[0] as { reason: string }).reason, /^died: quota wall claude-subscription-disabled, last turn /);
	const fresh = handedOff("sn-b", 5, { phase: "working", lastReport: undefined });
	fresh.row.alive = false;
	assert.deepEqual(decide([fresh]), [], "a process that has not been up 30 minutes yet is not dead");
});

test("a working lane that is alive and silent for 30 minutes gets one STALLED event", () => {
	const lane = handedOff("sn-a", 31, { phase: "working", lastReport: undefined });
	assert.deepEqual(decide([lane]), [{ kind: "event", lane: "sn-a", detail: "working with no report and no turn for 31 min", reminder: "stalledAt" }]);
	lane.rec.reminded = { stalledAt: NOW };
	assert.deepEqual(decide([lane]), []);
});

test("4 idle lanes: the oldest is parked even before 30 minutes; a dirty one still counts but is not parked", () => {
	const lanes = [handedOff("sn-a", 25), handedOff("sn-b", 20), handedOff("sn-c", 15), handedOff("sn-d", 10)];
	assert.deepEqual(decide(lanes), [{ kind: "park", lane: "sn-a", why: "idle-cap" }]);
	assert.deepEqual(decide(lanes.slice(1)), [], "3 idle lanes are allowed");
	const dirtyOldest = decide(lanes, git({ isClean: (cwd) => cwd !== "/w/sn-a" }));
	assert.deepEqual(dirtyOldest, [{ kind: "flag-dirty", lane: "sn-a", reminder: "stalledAt" }, { kind: "park", lane: "sn-b", why: "idle-cap" }]);
	const five = [...lanes, handedOff("sn-e", 5)];
	assert.deepEqual(decide(five).map((a) => (a.kind === "park" ? a.lane : a.kind)), ["sn-a", "sn-b"], "5 idle lanes park the two oldest");
	const withParked = [handedOff("sn-a", 45), ...lanes.slice(1)];
	assert.deepEqual(decide(withParked), [{ kind: "park", lane: "sn-a", why: "idle-30m" }], "a lane parked by the 30 minute rule leaves the count");
});

test("operator rows, the orchestrator, protected lanes and closed records get no action", () => {
	const operator = handedOff("sn-v", 600);
	operator.row.origin = "operator";
	const orch = handedOff("orchestrator", 600);
	const product = handedOff("sn-product", 600);
	const closed = handedOff("sn-z", 600, { phase: "closed" });
	assert.deepEqual(decide([operator, orch, product, closed], git({ isAncestor: () => true })), []);
	// The default list protects sn-product; a file may replace it, and the orchestrator stays protected either way.
	assert.equal(decide([product], git(), { protectedLanes: [] }).length > 0, true);
	assert.deepEqual(decide([orch], git(), { protectedLanes: [] }), []);
	assert.deepEqual(decide([handedOff("sn-keep", 600)], git(), { protectedLanes: ["sn-keep"] }), []);
});

// ─── Conversation sessions (WP12, LD14) ──────────────────────────────────────────────────────────

test("a conversation lane idle for 2 hours is not parked, closed or reminded, and does not count toward the idle cap", () => {
	const talk = handedOff("sn-design", 120, { kind: "conversation" });
	assert.deepEqual(decide([talk]), [], "idle 2 h with a clean worktree: not parked");
	assert.deepEqual(decide([talk], git({ isAncestor: () => true })), [], "a merged report does not close it either");
	const unanswered = handedOff("sn-design", 13 * 60, { kind: "conversation", phase: "question" });
	assert.deepEqual(decide([unanswered]), [], "no 2 h or 12 h reminder for a question it holds");
	const notes: string[] = [];
	decideLifecycle([talk.row], new Map([[talk.rec.laneId, talk.rec]]), git(), NOW, { trace: (lane, note) => notes.push(`${lane}: ${note}`) });
	assert.match(notes.join("\n"), /sn-design: conversation session \(LD14\)/);
	// Four idle workers park the oldest as before; the conversation lanes beside them are not part of the count.
	const workers = ["sn-a", "sn-b", "sn-c"].map((id, index) => handedOff(id, 10 + index));
	assert.deepEqual(decide([...workers, talk, handedOff("sn-talk2", 300, { kind: "conversation" })]), [], "3 workers and 2 conversation lanes: under the cap");
	assert.equal(decide([...workers, handedOff("sn-d", 14), talk]).filter((a) => a.kind === "park").length, 1);
});

test("the same lane as a worker is parked: the kind is what exempts it", () => {
	// At 2 h a worker is parked and the orchestrator is reminded; the conversation lane in the test above got neither.
	assert.deepEqual(decide([handedOff("sn-design", 120)]).map((a) => a.kind), ["park", "event"]);
});

test("a launch with --conversation sets the kind, a later launch without it keeps it, and a worker has none", () => {
	const dir = stateDir();
	try {
		recordLaunch(dir, { laneId: "sn-design", harness: "claude", cwd: "/w/d", branch: null, kind: "conversation" }, T0);
		assert.equal(readLaneRecord(dir, "sn-design")?.kind, "conversation");
		recordLaunch(dir, { laneId: "sn-design", harness: "claude", cwd: "/w/d", branch: null, title: "A design session in talk with the operator" }, T0 + 1);
		assert.equal(readLaneRecord(dir, "sn-design")?.kind, "conversation", "a resume without the flag is still a conversation");
		recordLaunch(dir, { laneId: "sn-w", harness: "claude", cwd: "/w/w", branch: null, title: "A worker lane beside the session" }, T0);
		assert.equal("kind" in readLaneRecord(dir, "sn-w")!, false);
		recordLaunch(dir, { laneId: "sn-w", harness: "claude", cwd: "/w/w", branch: null, kind: "worker", title: "A worker lane beside the session" }, T0 + 1);
		assert.equal("kind" in readLaneRecord(dir, "sn-w")!, false, "an explicit worker launch adds nothing");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("isConversationLane: the record's kind, or the protected-lanes stop-gap (sn-product by default), and never a plain worker", () => {
	const dir = stateDir();
	try {
		assert.equal(isConversationLane(dir, "sn-product"), true, "the built-in stop-gap list names sn-product until it is relaunched as a conversation");
		assert.equal(isConversationLane(dir, "sn-worker"), false);
		writeLaneRecord(dir, record({ laneId: "sn-design", kind: "conversation" }));
		writeLaneRecord(dir, record({ laneId: "sn-worker" }));
		assert.equal(isConversationLane(dir, "sn-design"), true);
		assert.equal(isConversationLane(dir, "sn-worker"), false);
		writeFileSync(join(dir, "protected-lanes.json"), JSON.stringify(["sn-keep"]));
		assert.equal(isConversationLane(dir, "sn-keep"), true, "a file replaces the default list and still counts");
		assert.equal(isConversationLane(dir, "sn-product"), false, "the file replaced the default");
		writeFileSync(join(dir, "protected-lanes.json"), "{not json");
		assert.equal(isConversationLane(dir, "sn-product"), true, "an unreadable file falls back to the built-in list instead of nudging a design session");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a lane whose cwd is not a linked worktree, or has no cwd, is not acted on at all", () => {
	const lane = handedOff("sn-a", 600);
	assert.deepEqual(decide([lane], git({ isLinkedWorktree: () => false, isAncestor: () => true })), []);
	lane.rec.cwd = null;
	lane.row.cwd = null;
	assert.deepEqual(decide([lane], git({ isAncestor: () => true })), []);
});

test("a git fact of undefined never stops or closes a lane; one STALLED event says so, once", () => {
	const lane = handedOff("sn-a", 45);
	const noClean = decide([lane], git({ isClean: () => undefined }));
	assert.deepEqual(noClean.map((a) => a.kind), ["event"]);
	assert.match((noClean[0] as { detail: string }).detail, /cannot verify whether its worktree is clean for sn-a; not stopped/);
	const noMerge = decide([lane], git({ isAncestor: (_c, _s, ref) => (ref === "origin/dev" ? undefined : false) }));
	assert.equal(noMerge.some((a) => a.kind === "close" || a.kind === "park"), false);
	assert.equal(noMerge.filter((a) => a.kind === "event").length, 1, "two unknowns in one tick are one event");
	const noBranch = decide([lane], git({ onBranch: () => undefined }));
	assert.equal(noBranch.some((a) => a.kind === "park"), false);
	const noWorktree = decide([lane], git({ isLinkedWorktree: () => undefined, isAncestor: () => true }));
	assert.equal(noWorktree.some((a) => a.kind === "close" || a.kind === "park"), false);
	assert.equal(noWorktree.filter((a) => a.kind === "event").length, 1);
	lane.rec.reminded = { stalledAt: NOW };
	assert.deepEqual(decide([lane], git({ isClean: () => undefined })), []);
});

test("a record the process stopped being merged or abandoned finishes its close", () => {
	const lane = handedOff("sn-a", 5, { phase: "merged", terminal: { outcome: "merged", reason: "in origin/dev", sha: "abc1234def", at: NOW - MIN } });
	assert.deepEqual(decide([lane]), [{ kind: "close", lane: "sn-a", outcome: "merged", reason: "in origin/dev", sha: "abc1234def" }]);
});

test("protected lanes read from the file, default without it, and an unreadable file is an error, not a guess", () => {
	const dir = stateDir();
	try {
		assert.deepEqual(readProtectedLanes(dir), { lanes: ["sn-product", "orchestrator"] });
		writeFileSync(join(dir, "protected-lanes.json"), JSON.stringify(["sn-product", " design "]));
		assert.deepEqual(readProtectedLanes(dir), { lanes: ["sn-product", "design"] });
		writeFileSync(join(dir, "protected-lanes.json"), "{not json");
		assert.ok(readProtectedLanes(dir).error?.includes("protected-lanes.json"));
		writeFileSync(join(dir, "protected-lanes.json"), JSON.stringify({ a: 1 }));
		assert.match(readProtectedLanes(dir).error ?? "", /JSON array of lane names/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("markReminded stamps one reminder and keeps the others; a lane with no record is left alone", () => {
	const dir = stateDir();
	try {
		writeLaneRecord(dir, record({ reminded: { stalledAt: 1 } }));
		markReminded(dir, "sn-x", "orchestratorAt", 5);
		assert.deepEqual(readLaneRecord(dir, "sn-x")?.reminded, { stalledAt: 1, orchestratorAt: 5 });
		markReminded(dir, "sn-none", "operatorAt", 5);
		assert.equal(readLaneRecord(dir, "sn-none"), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a launch seeds the session chain; a resumed session joins it once and becomes the record's session", () => {
	const dir = stateDir();
	try {
		recordLaunch(dir, { laneId: "sn-x", harness: "claude", cwd: "/w/x", branch: null, sessionId: "s-1", title: "A lane whose record carries the session chain" }, T0);
		assert.deepEqual(readLaneRecord(dir, "sn-x")?.sessionChain, ["s-1"]);
		recordSession(dir, "sn-x", "s-1");
		recordSession(dir, "sn-x", "s-2");
		recordSession(dir, "sn-x", "s-2");
		recordSession(dir, "sn-x", "s-3");
		const latest = readLaneRecord(dir, "sn-x");
		assert.deepEqual(latest?.sessionChain, ["s-1", "s-2", "s-3"], "each id once, oldest first");
		assert.equal(latest?.sessionId, "s-3");
		// A record written before the chain existed starts it from its own session id.
		writeLaneRecord(dir, record({ laneId: "sn-old", sessionId: "s-a" }));
		recordSession(dir, "sn-old", "s-b");
		assert.deepEqual(readLaneRecord(dir, "sn-old")?.sessionChain, ["s-a", "s-b"]);
		recordSession(dir, "sn-none", "s-1");
		assert.equal(readLaneRecord(dir, "sn-none"), undefined, "no record, no invented launch");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("WARN1: a launch warning is recorded, replaced by the next launch, and dropped when a launch has none", () => {
	const dir = stateDir();
	try {
		const warning = "model minimax/m walled at launch, until 2026-10-25T05:03:35Z (07:03 EET)";
		const first = recordLaunch(dir, { laneId: "sn-warn", harness: "pi", cwd: "/w/w", branch: null, launchWarning: warning, title: "A lane warned at launch" }, T0);
		assert.equal(first.launchWarning, warning);
		assert.equal(readLaneRecord(dir, "sn-warn")?.launchWarning, warning, "the stored record carries it for the digest");
		// A respawn (live phase) on an open provider states no warning: the old one goes.
		const respawn = recordLaunch(dir, { laneId: "sn-warn", harness: "pi", cwd: "/w/w", branch: null }, T0 + 1);
		assert.equal(respawn.launchWarning, undefined);
		assert.equal(readLaneRecord(dir, "sn-warn")?.launchWarning, undefined);
		// A launch without a warning on a fresh lane writes no key at all.
		assert.equal("launchWarning" in recordLaunch(dir, { laneId: "sn-clean", harness: "pi", cwd: "/w/c", branch: null, title: "A lane with no warning" }, T0), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
