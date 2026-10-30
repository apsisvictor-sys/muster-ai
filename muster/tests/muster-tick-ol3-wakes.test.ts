import "./muster-test-isolation.ts";
/**
 * A2's wakes (out-loop spec Revision 3 §10 row OL3, §7a strictness; VR24-220, VR24-229 item 7).
 *
 * The loop tells the seat about the three states the tick can see that need its judgment, in one message,
 * once per distinct set:
 *
 *   1. a ready item the dispatcher did not launch, with the reason the dispatcher gave;
 *   2. an item the gate has held long enough for the dispatcher to ask about (its one ask is an unprepared
 *      ask, so the ask branch carries it);
 *   3. an open ask nobody has prepared - a free-text one, or the dispatcher's own;
 *   4. a lane that reported REVIEW READY more than an hour ago and nobody has taken.
 *
 * Item 5 of the row (every lane event except REVIEW READY and ALREADY DONE) is the report owner's list
 * (`lane-report.ts` `WAKING_REPORT_KINDS`, `scripts/orch-wait.sh`), outside this lane's owned paths.
 *
 * Owner temp directories and a scratch ask store only: no provider, no Concord, no ledger.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareAsk, raiseAsk, readAsks } from "../asks.ts";
import type { DispatchItem, DispatchPort } from "../dispatch.ts";
import type { LaneCard } from "../lib/lane-card.ts";
import { enumerateLanes } from "../lib/lane-directory.ts";
import { writeLaneRecord } from "../lane-lifecycle.ts";
import {
	CONDUCTOR_WAKE_KEY,
	REVIEW_AWAITING_MS,
	awaitingReviewItems,
	conductorWake,
	undispatchedItems,
	unpreparedAskItems,
	type EmptySlotPort,
	type SeatHold,
	type TickPorts,
} from "../tick.ts";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 29, 9, 0, 0);

/** One working brief, so `readyItems` can name a base and a repository for an item it would launch. */
const BRIEF = ["# brief", "Cut from: main@abc1234 (~/projects/muster)", ""].join("\n");

function item(over: Partial<DispatchItem> & { code: string; state: string }): DispatchItem {
	return {
		heading: `the ${over.code} item`,
		goal: "OL",
		project: "muster",
		kind: "build",
		class: "S",
		harness: "pi",
		brief: "/briefs/ol3.md",
		ownedPaths: [`muster/${over.code.toLowerCase()}.ts`],
		dependencies: [],
		attempt: 1,
		...over,
	};
}

function laneRow(over: Partial<LaneCard> & { laneId: string }): LaneCard {
	return { harness: "pi", state: "idle", origin: "lane", ...over } as LaneCard;
}

type Fixture = {
	ports: TickPorts;
	stateDir: string;
	wakes: string[];
	marks: Map<string, string>;
	restoreStateDir: () => void;
};

/**
 * One scratch installation: an ask store in the OS temp dir, a marks store, and the two ports the wake reads.
 * `items` is the work-item store the dispatcher's own predicate folds; `lanes` is the lane directory's list.
 */
function fixture(input: { items?: readonly DispatchItem[]; lanes?: readonly LaneCard[]; seats?: readonly SeatHold[]; now?: number } = {}): Fixture {
	const stateDir = mkdtempSync(join(tmpdir(), "muster-ol3-wakes-"));
	const brief = join(stateDir, "ol3-brief.md");
	writeFileSync(brief, BRIEF);
	const wakes: string[] = [];
	const marks = new Map<string, string>();
	const emptySlot: EmptySlotPort = {
		lanes: () => input.lanes ?? [],
		seats: () => input.seats ?? [{ role: "orchestrator", sessionId: "orchestrator-session" }],
		// CUTOVER: the empty-slot wake reads the work-item records; this fixture's store holds nothing ready.
		readyItems: () => ({ ok: true, ready: [] }),
		wake: (text) => void wakes.push(text),
	};
	const dispatch = {
		now: () => input.now ?? T0,
		items: () => ({ items: input.items ?? [], skipped: [] }),
		mode: () => "on" as const,
		liveLanes: () => [],
		stateDir: () => stateDir,
		freeSlots: () => 3,
		killed: () => undefined,
		gate: async () => ({ admitted: true, reason: "" }),
		brief: () => ({ ok: true, text: BRIEF }),
		launch: async () => ({ launched: true }),
		setState: () => ({ ok: true }),
		mark: { get: (key: string) => marks.get(key), set: (key: string, value: string) => void marks.set(key, value) },
		shadow: () => undefined,
		event: () => undefined,
		ask: () => ({ ok: true }),
	} as unknown as DispatchPort;
	const saved = process.env.PI_MUSTER_STATE_DIR;
	process.env.PI_MUSTER_STATE_DIR = stateDir;
	return {
		ports: {
			now: () => input.now ?? T0,
			catalogue: () => undefined,
			control: {},
			readTasks: () => undefined,
			alerts: { get: (key) => marks.get(key), set: (key, value) => void marks.set(key, value) },
			alert: async () => ({ delivered: true }),
			emptySlot,
			dispatch,
		},
		stateDir,
		wakes,
		marks,
		restoreStateDir: () => {
			if (saved === undefined) delete process.env.PI_MUSTER_STATE_DIR;
			else process.env.PI_MUSTER_STATE_DIR = saved;
		},
	};
}

function withFixture<T>(input: Parameters<typeof fixture>[0], run: (fx: Fixture) => T): T {
	const fx = fixture(input);
	try {
		return run(fx);
	} finally {
		fx.restoreStateDir();
		rmSync(fx.stateDir, { recursive: true, force: true });
	}
}

/** A pass later, with the same stores: the second call is what proves the wake does not repeat. */
function later(fx: Fixture, byMs: number): TickPorts {
	const now = (fx.ports.now as () => number)() + byMs;
	return { ...fx.ports, now: () => now, dispatch: { ...(fx.ports.dispatch as DispatchPort), now: () => now } };
}

// ─── 1. a ready item the dispatcher did not launch, with its reason ────────

test("OL3 item 1: a ready item the dispatcher held wakes the seat once, with the dispatcher's own reason", () => {
	withFixture({ items: [item({ code: "OL3X", state: "ready", ownedPaths: [] })] }, (fx) => {
		const action = conductorWake(fx.ports);
		assert.equal(action?.action, "conductor-wake");
		assert.equal(fx.wakes.length, 1, "one message, not one per row");
		const text = fx.wakes[0]!;
		assert.match(text, /OL3X is ready and not launched: it owns no paths/, "the reason is `readyItems`' own words");
		// The same set on the next pass says nothing: the mark holds the set's keys.
		assert.equal(conductorWake(later(fx, 2 * MINUTE)), undefined);
		assert.equal(fx.wakes.length, 1, "nothing repeats for an unchanged set");
	});
});

test("OL3 item 1: a set that grows wakes again with the new row, and a cleared set starts over", () => {
	withFixture({ items: [item({ code: "OL3X", state: "ready", ownedPaths: [] })] }, (fx) => {
		conductorWake(fx.ports);
		const grown: TickPorts = {
			...later(fx, 2 * MINUTE),
			dispatch: {
				...(later(fx, 2 * MINUTE).dispatch as DispatchPort),
				items: () => ({ items: [item({ code: "OL3X", state: "ready", ownedPaths: [] }), item({ code: "OL3Y", state: "ready", ownedPaths: [] })], skipped: [] }),
			},
		};
		conductorWake(grown);
		assert.equal(fx.wakes.length, 2, "the new row is news");
		assert.match(fx.wakes[1]!, /OL3Y/);
		const cleared: TickPorts = { ...later(fx, 4 * MINUTE), dispatch: { ...(later(fx, 4 * MINUTE).dispatch as DispatchPort), items: () => ({ items: [], skipped: [] }) } };
		assert.equal(conductorWake(cleared), undefined, "nothing held, nothing to say");
		assert.equal(fx.marks.get(CONDUCTOR_WAKE_KEY), "", "the mark is cleared, so a recurrence is news again");
		const again: TickPorts = { ...cleared, dispatch: { ...(cleared.dispatch as DispatchPort), items: () => ({ items: [item({ code: "OL3X", state: "ready", ownedPaths: [] })], skipped: [] }) } };
		conductorWake(again);
		assert.equal(fx.wakes.length, 3, "the same row that came back is news again");
	});
});

test("OL3 item 1: an item the dispatcher may launch is not the seat's business", () => {
	withFixture({ items: [item({ code: "OL3Z", state: "ready" }), item({ code: "OL3W", state: "launched:ol3w-a1" })] }, (fx) => {
		assert.deepEqual(undispatchedItems({ ready: [], held: [] }), [], "nothing held, nothing said");
		assert.equal(conductorWake(fx.ports), undefined);
		assert.equal(fx.wakes.length, 0);
	});
});

// ─── 2 and 3. an unprepared ask ───────────────────────────────────────────

test("OL3 items 2 and 3: an unprepared ask wakes the seat once; preparing it ends the wake", () => {
	withFixture({}, (fx) => {
		const ask = raiseAsk(fx.stateDir, { by: "orchestrator", kind: "product-decision", question: "Which of the two briefs does OL9 follow?" });
		conductorWake(fx.ports);
		assert.equal(fx.wakes.length, 1);
		assert.match(fx.wakes[0]!, new RegExp(`prepare ask ${ask.id}`), "the wake names the ask by its own id");
		assert.equal(conductorWake(later(fx, 2 * MINUTE)), undefined, "the same unprepared ask is not raised again");

		prepareAsk(fx.stateDir, { ref: ask.id, by: "orchestrator", options: ["the first", "the second"], recommendation: "the first" });
		assert.deepEqual(unpreparedAskItems(readAsks(fx.stateDir)), [], "a prepared ask is the operator's, not the seat's to prepare");
		conductorWake(later(fx, 4 * MINUTE));
		assert.equal(fx.marks.get(CONDUCTOR_WAKE_KEY), "", "the wake ends with the last unprepared ask");
	});
});

test("OL3 item 2: the dispatcher's one ask for a gate-held item is the same wake, not a second alert", () => {
	withFixture({}, (fx) => {
		// The shape `dispatch.ts` raises at thirty minutes: a free-text ask in the orchestrator's name.
		raiseAsk(fx.stateDir, { by: "orchestrator", kind: "product-decision", question: "OL2B has been held by the resource gate for 30 minutes: wait, stop the window, smaller job", source: "muster-tick dispatch OL2B" });
		conductorWake(fx.ports);
		assert.equal(fx.wakes.length, 1, "one wake for the gated item");
		assert.match(fx.wakes[0]!, /prepare ask ask_/, "carried as the ask it is");
	});
});

// ─── 4. a review nobody took ──────────────────────────────────────────────

test("OL3 item 4: a review waits an hour, then wakes the seat once", () => {
	const rows = [laneRow({ laneId: "pi-ol3a", lastReport: { kind: "review_ready", summary: "REVIEW READY", at: T0 - 59 * MINUTE, sha: "abc1234" } })];
	assert.deepEqual(awaitingReviewItems(rows, T0), [], "inside the hour it is the lanes' own business");
	const due = awaitingReviewItems([laneRow({ laneId: "pi-ol3a", lastReport: { kind: "review_ready", summary: "REVIEW READY", at: T0 - REVIEW_AWAITING_MS, sha: "abc1234" } })], T0);
	assert.equal(due.length, 1);
	assert.equal(due[0]!.key, "review:pi-ol3a@abc1234", "once per lane and commit, so a re-report does not wake again");

	withFixture({ lanes: [laneRow({ laneId: "pi-ol3a", lastReport: { kind: "review_ready", summary: "REVIEW READY", at: T0 - 61 * MINUTE, sha: "abc1234" } })] }, (fx) => {
		conductorWake(fx.ports);
		assert.equal(fx.wakes.length, 1);
		assert.match(fx.wakes[0]!, /pi-ol3a reported abc1234 ready for review 61 minutes ago/);
		assert.equal(conductorWake(later(fx, 2 * MINUTE)), undefined, "the same review is not reported twice");
	});
});

test("OL3 item 4: a lane whose last report is not REVIEW READY is not waiting for a review", () => {
	const rows = [
		laneRow({ laneId: "pi-work", lastReport: { kind: "working", summary: "building", at: T0 - 3 * 60 * MINUTE } }),
		laneRow({ laneId: "pi-blocked", lastReport: { kind: "blocked", summary: "BLOCKED", at: T0 - 3 * 60 * MINUTE } }),
		laneRow({ laneId: "pi-quiet" }),
	];
	assert.deepEqual(awaitingReviewItems(rows, T0), []);
});

test("TICK-STALE-CARDS: a closed lane's old review report raises no line, a live idle lane's does", () => {
	// The rows come from the builder, not from hand-made cards: the bug lived between a closed lane's row
	// (the record keeps its last report, so a parked question is not lost) and this line, which read every
	// row's report and never asked whether the lane still had a process to take the review.
	const base = mkdtempSync(join(tmpdir(), "muster-stale-cards-"));
	const stateDir = join(base, "state");
	const lanesDir = join(stateDir, "lanes");
	mkdirSync(lanesDir, { recursive: true });
	const report = { kind: "review_ready", summary: "REVIEW READY: lane@abc1234", at: T0 - 332 * MINUTE, sha: "abc1234" };
	writeLaneRecord(stateDir, {
		laneId: "si3",
		harness: "pi",
		cwd: "/w/si3",
		branch: "lane/si3",
		launchedAt: T0 - 900 * MINUTE,
		launchedBy: "orchestrator",
		phase: "closed",
		phaseSince: T0 - 300 * MINUTE,
		lastReport: report,
	});
	writeFileSync(
		join(lanesDir, "live-idle.json"),
		JSON.stringify({ laneId: "live-idle", harness: "pi", cwd: "/w/live", branch: "lane/live", state: "idle", updatedAt: T0, since: T0 - 120 * MINUTE, sessionId: "s-live", lastReport: report }),
	);
	writeFileSync(join(stateDir, "pi-lanes.json"), JSON.stringify({ si3: "s-si3", "live-idle": "s-live" }));
	try {
		const rows = enumerateLanes({
			home: base,
			stateDir,
			laneCardsDir: lanesDir,
			laneRegistryPath: join(stateDir, "pi-lanes.json"),
			sessionsRoot: join(base, "sessions"),
			includeUnregisteredSessions: false,
			skipClaude: true,
			nowMs: T0,
			evidence: { tmuxPanes: () => [], pidAlive: () => false, hasAgentEnv: () => false, piProcesses: () => [], hermesUnits: () => [], scopeUnits: () => [] },
		});
		const closed = rows.find((row) => row.laneId === "si3");
		assert.equal(closed?.state, "gone", "a closed lane with no process reads gone");
		assert.equal(closed?.lastReport?.kind, "review_ready", "and still carries the report it was closed with");
		assert.equal(rows.find((row) => row.laneId === "live-idle")?.state, "idle", "a heartbeat a moment ago is a live lane");

		const items = awaitingReviewItems(rows, T0);
		assert.deepEqual(items.map((item) => item.key), ["review:live-idle@abc1234"], "only the lane that still has a process is waiting on the seat");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

// ─── the seat and the wire ────────────────────────────────────────────────

test("OL3: with no orchestrator holder on the seat there is nobody to wake", () => {
	withFixture({ seats: [{ role: "architect", sessionId: "architect-session" }], items: [item({ code: "OL3X", state: "ready", ownedPaths: [] })] }, (fx) => {
		assert.equal(conductorWake(fx.ports), undefined);
		assert.equal(fx.wakes.length, 0);
	});
});

test("OL3: without the wake wire or the dispatcher's port the pass is silent and read-free", () => {
	withFixture({ items: [item({ code: "OL3X", state: "ready", ownedPaths: [] })] }, (fx) => {
		const { emptySlot: _emptySlot, ...noWire } = fx.ports;
		assert.equal(conductorWake(noWire as TickPorts), undefined);
		const { dispatch: _dispatch, ...noDispatch } = fx.ports;
		assert.equal(conductorWake(noDispatch as TickPorts), undefined);
		assert.equal(fx.wakes.length, 0);
	});
});

test("OL3: the wake's text is bounded and says how many rows it left out", () => {
	withFixture({ items: Array.from({ length: 11 }, (_unused, index) => item({ code: `OL${index}X`, state: "ready", ownedPaths: [] })) }, (fx) => {
		conductorWake(fx.ports);
		const text = fx.wakes[0]!;
		assert.equal(text.split("\n").filter((line) => line.startsWith("- ")).length, 8, "eight rows, then a count");
		assert.match(text, /and 3 more/);
	});
});

