import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { computeMetrics, createDecisionLimiter, formatMetricsLine, readMetricEvents, readOwnershipEvents, type MetricsInput } from "../metrics.ts";
import type { MetricRow } from "../types.ts";

/**
 * R1 item 7: metrics derived from records that already exist (Concord's
 * ownership events and the per-session journals), with no new ledger. The
 * fixture below is hand-counted; each expected number is derived in its comment.
 */

const MAILBOX = "pi-p-parent";
const at = (hhmm: string, seconds = 0): number => Date.parse(`2026-10-03T${hhmm}:${String(seconds).padStart(2, "0")}.000Z`);
const FROM = at("12:00");
const TO = at("13:00");

type EventRow = MetricsInput["events"][number];
const ev = (taskId: string, transition: string, time: number, actor: string, toAgentId: string | undefined, fromStatus = "x", toStatus = "y"): EventRow => ({
	taskId,
	transition,
	at: time,
	actorAgentId: actor,
	toAgentId,
	fromStatus,
	toStatus,
});

/**
 * Three lanes in a 60 minute window with a ceiling of 5:
 *  t1: assigned 12:00, offered 12:20, parent accepted 12:30, closed 12:45
 *      lane 30 min, offer→accept 10 min, accept→close 15 min
 *  t2: assigned 12:10, offered 12:50, parent accepted 12:55, closed 12:58
 *      lane 45 min, offer→accept 5 min, accept→close 3 min
 *  t3: assigned 12:40, still running at 13:00: lane 20 min
 */
const EVENTS: EventRow[] = [
	ev("t1", "assign", at("12:00"), MAILBOX, "w1"),
	ev("t1", "accept", at("12:01"), "w1", "w1"),
	ev("t1", "offer_handoff", at("12:20"), "w1", MAILBOX),
	ev("t1", "accept_handoff", at("12:30"), MAILBOX, MAILBOX),
	ev("t1", "close", at("12:45"), MAILBOX, undefined),
	ev("t2", "assign", at("12:10"), MAILBOX, "w2"),
	ev("t2", "accept", at("12:11"), "w2", "w2"),
	ev("t2", "offer_handoff", at("12:50"), "w2", MAILBOX),
	ev("t2", "accept_handoff", at("12:55"), MAILBOX, MAILBOX),
	ev("t2", "close", at("12:58"), MAILBOX, undefined),
	ev("t3", "assign", at("12:40"), MAILBOX, "w3"),
];

/** Parent turns: 12:00-12:18, 12:22-12:28, 12:52-12:56. */
const RUNS: MetricRow[] = [
	{ at: at("12:00"), session: "p1", event: "run-start" },
	{ at: at("12:18"), session: "p1", event: "run-end" },
	{ at: at("12:22"), session: "p1", event: "run-start" },
	{ at: at("12:28"), session: "p1", event: "run-end" },
	{ at: at("12:52"), session: "p1", event: "run-start" },
	{ at: at("12:56"), session: "p1", event: "run-end" },
];

const base = { events: EVENTS, mailbox: MAILBOX, ceiling: 5, from: FROM, to: TO, retired: new Set<string>() } satisfies Partial<MetricsInput>;

test("lane occupancy is lane-minutes over window-minutes times the ceiling", () => {
	const m = computeMetrics({ ...base, metricEvents: [] });
	// 30 + 45 + 20 = 95 lane-minutes; 95 / 60 = 1.583 lanes on average; 95 / (60 * 5) = 31.67 %.
	assert.equal(Math.round(m.laneMinutes), 95);
	assert.equal(Math.round(m.avgLiveLanes * 1000) / 1000, 1.583);
	assert.equal(Math.round(m.occupancy * 10000) / 10000, 0.3167);
});

test("offer to accept and accept to close are measured per handoff", () => {
	const m = computeMetrics({ ...base, metricEvents: [] });
	assert.deepEqual(m.offerToAccept, { count: 2, meanMin: 7.5, medianMin: 7.5, maxMin: 10 });
	assert.deepEqual(m.acceptToClose, { count: 2, meanMin: 9, medianMin: 9, maxMin: 15 });
});

test("batch closing days later does not drag the reported accept→close time: the line shows the median (F12)", () => {
	// Three accepted handoffs closed 1, 45 and 7 495 minutes later: the mean is 2 514, the median 45.
	const start = at("00:00");
	const events: EventRow[] = [];
	for (const [taskId, minutes] of [["a", 1], ["b", 45], ["c", 7495]] as const) {
		events.push(ev(taskId, "accept_handoff", start, MAILBOX, MAILBOX), ev(taskId, "close", start + minutes * 60_000, MAILBOX, undefined));
	}
	const m = computeMetrics({ ...base, events, from: start, to: start + 8000 * 60_000, metricEvents: [] });
	assert.equal(m.acceptToClose?.medianMin, 45);
	assert.match(formatMetricsLine(m), /accept→close median 45 min \(n=3\)/);
	assert.doesNotMatch(formatMetricsLine(m), /integrated/);
});

test("parent idle time counts only the waiting minutes in which no parent turn was running", () => {
	const m = computeMetrics({ ...base, metricEvents: RUNS });
	// t1 waited 12:20-12:30 (10 min) with a turn running 12:22-12:28 (6 min): 4 min idle.
	// t2 waited 12:50-12:55 (5 min) with a turn running 12:52-12:55 (3 min): 2 min idle.
	assert.equal(m.parentIdleWithWorkMin, 6);
	assert.equal(m.waitingMin, 15);
});

test("turns of two sessions are paired within each session, so another session's run-end cannot close this one's turn (F11)", () => {
	const rows: MetricRow[] = [
		{ at: at("12:22"), session: "p1", event: "run-start" },
		{ at: at("12:23"), session: "p2", event: "run-end" }, // p2's turn began before the rows we have
		{ at: at("12:28"), session: "p1", event: "run-end" },
	];
	const m = computeMetrics({ ...base, metricEvents: rows });
	// p1 ran 12:22-12:28 and p2 12:00-12:23: together 12:00-12:28 covers 8 of t1's 10 waiting minutes, none of t2's 5.
	assert.equal(m.parentIdleWithWorkMin, 7);
});

test("with no recorded parent turns the idle time is not measured, not zero", () => {
	assert.equal(computeMetrics({ ...base, metricEvents: [] }).parentIdleWithWorkMin, undefined);
});

test("a turn still running at the end of the window covers the rest of it", () => {
	const m = computeMetrics({ ...base, metricEvents: [{ at: at("12:19"), session: "p1", event: "run-start" }] });
	// The turn starts 12:19 and never ends, so it covers both waits completely.
	assert.equal(m.parentIdleWithWorkMin, 0);
});

test("false edit blocks are blocks whose every holder is a retired identity", () => {
	const block = (time: number, taskIds: string[], holders: string[]): MetricRow => ({ at: time, session: "p1", event: "edit-block", repoKey: "repo-1", taskIds, holders });
	const blocks = [
		block(at("12:05"), ["T9"], ["pi-old-parent"]),
		block(at("12:06"), ["T9"], ["pi-old-parent"]),
		block(at("12:07"), ["T9", "t1"], ["pi-old-parent", "w1"]),
		block(at("12:08"), ["t1"], ["w1"]),
		block(at("12:09"), ["t2"], ["w2"]),
		block(at("11:30"), ["T9"], ["pi-old-parent"]),
	];
	const m = computeMetrics({ ...base, metricEvents: blocks, retired: new Set(["pi-old-parent"]) });
	// Five blocks fall in the window (11:30 is outside). Two have only the retired holder: false.
	assert.deepEqual(m.editBlocks, { total: 5, falseBlocks: 2 });
});

test("continuations are counted by outcome and by reason", () => {
	const decision = (time: number, outcome: string, reason?: string): MetricRow => ({ at: time, session: "p1", event: "continuation", outcome: outcome as never, ...(reason === undefined ? {} : { reason }) });
	const m = computeMetrics({
		...base,
		metricEvents: [
			decision(at("12:01"), "admitted"),
			decision(at("12:02"), "admitted"),
			decision(at("12:03"), "steered"),
			decision(at("12:04"), "waiting", "claim-active"),
			decision(at("12:05"), "waiting", "claim-active"),
			decision(at("12:06"), "waiting", "capacity"),
			decision(at("12:07"), "denied", "programme-paused"),
			decision(at("12:08"), "denied", "kill-file"),
			decision(at("12:09"), "denied", "kill-file"),
			decision(at("12:10"), "deferred", "session-busy"),
		],
	});
	assert.deepEqual(m.continuations, {
		admitted: 2,
		steered: 1,
		waiting: { "claim-active": 2, capacity: 1 },
		denied: { "programme-paused": 1, "kill-file": 2 },
		deferred: 1,
		unavailable: 0,
	});
});

test("the one-line form carries every number, in words", () => {
	const m = computeMetrics({ ...base, metricEvents: RUNS });
	const line = formatMetricsLine(m);
	assert.match(line, /lanes 1\.6 of 5 live on average \(32%\)/);
	assert.match(line, /offer→accept median 7\.5 min \(n=2\)/);
	assert.match(line, /accept→close median 9 min \(n=2\)/);
	assert.match(line, /parent idle with work waiting 6 min/);
	assert.match(line, /edit blocks 0/);
	assert.match(line, /continuations 0 admitted/);
	assert.equal(line.includes("\n"), false);
});

test("an empty window says so instead of dividing by zero", () => {
	const m = computeMetrics({ events: [], metricEvents: [], mailbox: MAILBOX, ceiling: 5, from: FROM, to: TO, retired: new Set() });
	assert.equal(m.occupancy, 0);
	assert.equal(m.offerToAccept, undefined);
	assert.match(formatMetricsLine(m), /offer→accept none/);
});

// ─── Recording without flooding ──────────────────────────────────────────────

test("a repeating waiting or denied decision is recorded once per minute, a change at once, an admission always", () => {
	let now = 0;
	const record = createDecisionLimiter(60_000, () => now);
	assert.equal(record("waiting", "claim-active"), true, "the first one is recorded");
	now += 1_000;
	assert.equal(record("waiting", "claim-active"), false, "the retry a second later is not");
	now += 1_000;
	assert.equal(record("waiting", "capacity"), true, "a different reason is");
	assert.equal(record("denied", "kill-file"), true, "a different outcome is");
	now += 61_000;
	assert.equal(record("denied", "kill-file"), true, "the same one again after a minute is");
	assert.equal(record("admitted", undefined), true);
	assert.equal(record("admitted", undefined), true, "admissions are never thinned");
	assert.equal(record("steered", undefined), true);
	assert.equal(record("denied", "kill-file"), true, "an admission in between makes the next denial a new episode");
});

// ─── Readers ─────────────────────────────────────────────────────────────────

test("readMetricEvents reads runs and continuations only from the programme's own sessions, edit blocks of its repository from any, and tags each row with its session (F11)", () => {
	const dir = mkdtempSync(join(tmpdir(), "muster-metrics-scope-"));
	try {
		const row = (event: Record<string, unknown>) => JSON.stringify({ type: "metric", ...event });
		const when = "2026-10-03T12:10:00.000Z";
		writeFileSync(join(dir, "owner-1.jsonl"), [row({ event: "run-start", at: when }), row({ event: "continuation", outcome: "admitted", at: when })].join("\n") + "\n");
		writeFileSync(join(dir, "worker-9.jsonl"), [
			row({ event: "run-start", at: when }),
			row({ event: "continuation", outcome: "admitted", at: when }),
			row({ event: "edit-block", repoKey: "repo-1", taskIds: ["t1"], holders: ["w1"], at: when }),
			row({ event: "edit-block", repoKey: "repo-OTHER", taskIds: ["t2"], holders: ["w2"], at: when }),
			row({ event: "edit-block", taskIds: ["t3"], holders: ["w3"], at: when }),
		].join("\n") + "\n");
		const rows = readMetricEvents(dir, FROM, { sessions: new Set(["owner-1"]), repoKey: "repo-1" });
		assert.deepEqual(
			rows.map((entry) => [entry.session, entry.event]).sort((a, b) => `${a}`.localeCompare(`${b}`)),
			[["owner-1", "continuation"], ["owner-1", "run-start"], ["worker-9", "edit-block"]],
		);
		const block = rows.find((entry) => entry.event === "edit-block");
		assert.ok(block && block.event === "edit-block" && block.repoKey === "repo-1");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readMetricEvents reads the rows of the sessions it is given and ignores everything else", () => {
	const dir = mkdtempSync(join(tmpdir(), "muster-metrics-"));
	try {
		mkdirSync(dir, { recursive: true });
		const row = (event: Record<string, unknown>) => JSON.stringify({ type: "metric", ...event });
		writeFileSync(join(dir, "a.jsonl"), [row({ event: "run-start", at: "2026-10-03T12:00:00.000Z" }), JSON.stringify({ type: "binding", data: {} }), "{torn"].join("\n") + "\n");
		writeFileSync(join(dir, "b.jsonl"), [row({ event: "run-end", at: "2026-10-03T12:05:00.000Z" }), row({ event: "bogus", at: "2026-10-03T12:06:00.000Z" })].join("\n") + "\n");
		const events = readMetricEvents(dir, FROM, { sessions: new Set(["a", "b"]), repoKey: "repo-1" });
		assert.deepEqual(events.map((entry) => [entry.event, entry.at]), [["run-start", at("12:00")], ["run-end", at("12:05")]]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readOwnershipEvents reads transitions read-only from a Concord database", async () => {
	const dir = mkdtempSync(join(tmpdir(), "muster-metrics-db-"));
	try {
		const file = join(dir, "concord.db");
		const db = new DatabaseSync(file);
		db.exec(`
			CREATE TABLE task_ownership_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, transition TEXT NOT NULL, actor_agent_id TEXT NOT NULL, from_agent_id TEXT, to_agent_id TEXT, from_status TEXT NOT NULL, to_status TEXT NOT NULL, from_version INTEGER NOT NULL, to_version INTEGER NOT NULL, reason TEXT, created_at TEXT NOT NULL);
			INSERT INTO task_ownership_events (task_id, transition, actor_agent_id, from_agent_id, to_agent_id, from_status, to_status, from_version, to_version, created_at)
			VALUES ('t1','assign','pi-p-parent','pi-p-parent','w1','active','assigned',1,2,'2026-10-03T12:00:00.000Z'),
			       ('t1','offer_handoff','w1','w1','pi-p-parent','active','handoff_offered',2,3,'2026-10-03T12:20:00.000Z'),
			       ('t0','assign','pi-p-parent','pi-p-parent','w0','active','assigned',1,2,'2026-10-03T01:00:00.000Z');
		`);
		db.close();
		const events = await readOwnershipEvents(file, at("11:00"));
		assert.deepEqual(events.map((entry) => [entry.taskId, entry.transition, entry.at, entry.toAgentId]), [
			["t1", "assign", at("12:00"), "w1"],
			["t1", "offer_handoff", at("12:20"), "pi-p-parent"],
		]);
		assert.deepEqual(await readOwnershipEvents(join(dir, "missing.db"), 0), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
