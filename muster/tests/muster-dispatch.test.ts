import "./muster-test-isolation.ts";
/**
 * OL2 (out-loop spec Revision 3 §9, §10 row OL2, §11 rules 1–4; VR24-220, VR24-208, VR24-210): A1, the
 * dispatcher, over the work-item registry.
 *
 * One fixture per acceptance line:
 *   1. `off` is the rollback: the pass reads nothing, writes nothing and starts nothing.
 *   2. Dispatchable means `ready`, a brief file, owned paths, and a stated project, kind, class and harness.
 *      Each half has its own fixture, and the reason it holds the item is asserted, not just the outcome.
 *   3. One launch per tick, and no launch at the slot limit.
 *   4. The gate's refusal, the kill file and the pause flag hold the item without spending its attempt: it stays
 *      `ready`, the reason is written once per change, and thirty minutes earns exactly one ask.
 *   5. The launch's own terms: the argv the launcher receives (no `--model`), the item's `launched:<lane>`, and
 *      the one event line.
 *   6. The launcher's gate refusal is "retry later"; its own refusal is `gated:<class>`, once.
 *   7. A crash: `launch-uncertain` is resolved from the lane record's `item`, never by relaunching blind.
 *   8. Shadow: one would-launch line per dispatchable item that is not live, nothing else touched, and no
 *      double-launch line against the orchestrator's own launch log.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	composeGatedLine,
	dispatchPass,
	GATED_ASK_CHOICES,
	GATED_EXIT,
	gatedAskedKey,
	gatedReasonKey,
	goalForItem,
	laneForItem,
	laneRootFor,
	readyItems,
	readyQueueReason,
	refusalClass,
	titleForItem,
	type DispatchItem,
	type DispatchMode,
	type DispatchOutcome,
	type DispatchPort,
	type GateReading,
	type LaunchOutcome,
	type LaunchRequest,
	type LiveLane,
} from "../dispatch.ts";
import { runTick, type TickPorts } from "../tick.ts";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 28, 21, 0, 0);

const BRIEF = [
	"Outcome: the item's own outcome.",
	"Cut from: Pi main at bfd73551624f (~/.pi/agent), worktree ~/projects/pi-lane-ol2b, branch lane/ol2b",
	"Owned paths: packages/muster/dispatch.ts",
	"Decisions: VR24-220",
	"Done means: T2 green",
].join("\n");

type Fixture = {
	dir: string;
	port: DispatchPort;
	launches: LaunchRequest[];
	events: string[];
	asks: Array<{ code: string; question: string }>;
	states: Array<{ code: string; state: string }>;
	shadows: Record<string, unknown>[];
	marks: Map<string, string>;
	clock: { now: number };
	mode: { value: DispatchMode };
	gate: { reading: GateReading; calls: number };
	items: { value: DispatchItem[]; reads: number };
	slots: { value: number };
	kill: { value: string | undefined };
	live: { value: LiveLane[] };
	launch: (request: LaunchRequest) => Promise<LaunchOutcome>;
};

function item(over: Partial<DispatchItem> = {}): DispatchItem {
	return {
		code: "OL2B",
		heading: "The dispatcher starts one lane per tick",
		goal: "out-loop",
		project: "pi",
		kind: "build",
		class: "H3",
		harness: "pi",
		brief: "",
		ownedPaths: ["packages/muster/dispatch.ts"],
		dependencies: [],
		attempt: 1,
		state: "ready",
		...over,
	};
}

/** One scratch directory, a real brief file, and the ports the pass reads. */
function withPort(
	options: {
		items?: DispatchItem[];
		brief?: (path: string) => { ok: boolean; reason?: string; text?: string };
		launch?: (request: LaunchRequest) => Promise<LaunchOutcome>;
		freeSlots?: number;
		mode?: DispatchMode;
		gate?: GateReading;
		killed?: string;
		liveLanes?: LiveLane[];
		run: (fixture: Fixture) => Promise<void>;
	},
): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "muster-dispatch-"));
	const briefPath = join(dir, "lane-prompt-ol2b.md");
	writeFileSync(briefPath, BRIEF);
	const launches: LaunchRequest[] = [];
	const events: string[] = [];
	const asks: Array<{ code: string; question: string }> = [];
	const states: Array<{ code: string; state: string }> = [];
	const shadows: Record<string, unknown>[] = [];
	const marks = new Map<string, string>();
	const clock = { now: T0 };
	const mode = { value: options.mode ?? ("on" as DispatchMode) };
	const gate = { reading: options.gate ?? ({ admitted: true, reason: "" } as GateReading), calls: 0 };
	const items = { value: (options.items ?? [item({ brief: briefPath })]).map((entry) => ({ ...entry, brief: entry.brief === "" ? briefPath : entry.brief })), reads: 0 };
	const slots = { value: options.freeSlots ?? 3 };
	const kill = { value: options.killed };
	const live = { value: options.liveLanes ?? [] };
	const launch = options.launch ?? (async () => ({ launched: true }));
	const port: DispatchPort = {
		now: () => clock.now,
		stateDir: () => join(dir, "state"),
		mode: () => mode.value,
		items: () => {
			items.reads += 1;
			return { items: items.value, skipped: [] };
		},
		liveLanes: () => live.value,
		freeSlots: () => slots.value,
		killed: () => kill.value,
		gate: async () => {
			gate.calls += 1;
			return gate.reading;
		},
		brief: (path) =>
			options.brief === undefined
				? { ok: true, text: BRIEF }
				: options.brief(path),
		launch: async (request) => {
			launches.push(request);
			return launch(request);
		},
		setState: (code, state) => {
			states.push({ code, state });
			const entry = items.value.find((row) => row.code === code);
			if (entry !== undefined) entry.state = state;
			return { ok: true };
		},
		mark: { get: (key) => marks.get(key), set: (key, value) => void marks.set(key, value) },
		shadow: (line) => void shadows.push(line),
		event: (line) => void events.push(line),
		ask: (input) => {
			asks.push(input);
			return { ok: true };
		},
	};
	const fixture: Fixture = { dir, port, launches, events, asks, states, shadows, marks, clock, mode, gate, items, slots, kill, live, launch };
	return options.run(fixture).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function tickPorts(dispatch: DispatchPort): TickPorts {
	return {
		now: () => T0,
		// No catalogue at all: the dispatcher is the machine's step, not a programme's, so it runs with no
		// programme and no heartbeat to read.
		catalogue: () => undefined,
		control: {},
		readTasks: () => undefined,
		alerts: { get: () => undefined, set: () => undefined },
		alert: async () => ({ delivered: true }),
		dispatch,
	};
}

// ─── 1. off is the rollback ─────────────────────────────────────────────────

test("off is the rollback: nothing is read, nothing is written, nothing starts", async () => {
	await withPort({
		mode: "off",
		run: async (f) => {
			assert.equal(await dispatchPass(f.port), undefined, "no pass, no action, no line");
			assert.equal(f.items.reads, 0, "not even the queue is read");
			assert.equal(f.gate.calls, 0, "the gate is not asked");
			assert.equal(f.launches.length, 0);
			assert.equal(f.events.length, 0);
			assert.equal(f.states.length, 0);
		},
	});
});

// ─── 2. dispatchable ────────────────────────────────────────────────────────

test("dispatchable is ready, a brief file, owned paths, project, kind, class and harness", async () => {
	const brief = join(tmpdir(), "muster-dispatch-absent", "no-such-brief.md");
	const queue = readyItems({
		items: [
			item({ code: "READY", brief: "/b.md" }),
			item({ code: "DRAFT", state: "draft", brief: "/b.md" }),
			item({ code: "NOBR", brief: "" }),
			item({ code: "NOPATH", brief: "/b.md", ownedPaths: [] }),
			item({ code: "NOBRIEF", brief }),
		],
		liveLanes: [],
		brief: (path) => (path === "/b.md" ? { ok: true, text: BRIEF } : { ok: false, reason: `the brief ${path} does not exist` }),
	});
	assert.deepEqual(queue.ready.map((row) => row.item.code), ["READY"], "only the ready item with a brief and owned paths may launch");
	const why = (code: string): string => queue.held.find((row) => row.code === code)?.why ?? "";
	assert.equal(why("DRAFT"), "", "a draft is not held: it is not in the queue at all");
	assert.match(why("NOBR"), /no brief file named/);
	assert.match(why("NOPATH"), /owns no paths/);
	assert.match(why("NOBRIEF"), /does not exist/);
});

test("a brief that fails brief-check, or names no base or repository, holds the item with the reason", async () => {
	const queue = readyItems({
		items: [item({ code: "A", brief: "/a.md" }), item({ code: "B", brief: "/b.md" }), item({ code: "C", brief: "/c.md" })],
		liveLanes: [],
		brief: (path) =>
			path === "/a.md"
				? { ok: false, reason: "the brief fails check: no Outcome line" }
				: path === "/b.md"
					? { ok: true, text: "Owned paths: x\n" }
					: { ok: true, text: "Cut from: bfd73551624f, worktree ~/projects/x\n" },
	});
	assert.deepEqual(queue.ready, []);
	assert.match(queue.held.find((row) => row.code === "A")!.why, /fails check: no Outcome line/);
	assert.match(queue.held.find((row) => row.code === "B")!.why, /names no base commit/);
	assert.match(queue.held.find((row) => row.code === "C")!.why, /names no repository/);
});

test("an item whose owned paths overlap a launched item's is held, and a live lane record holds its item", async () => {
	const queue = readyItems({
		items: [
			item({ code: "LIVE", state: "launched:live-a1", ownedPaths: ["packages/muster/tick.ts"], brief: "/b.md" }),
			item({ code: "OVERLAP", ownedPaths: ["packages/muster/tick.ts/dispatch.ts"], brief: "/b.md" }),
			item({ code: "SERVED", ownedPaths: ["lib/other.ts"], brief: "/b.md" }),
			item({ code: "FREE", ownedPaths: ["docs/qa/ol2b.md"], brief: "/b.md" }),
		],
		liveLanes: [{ lane: "served-a1", item: "SERVED", phase: "working" }],
		brief: () => ({ ok: true, text: BRIEF }),
	});
	assert.deepEqual(queue.ready.map((row) => row.item.code), ["FREE"]);
	assert.match(queue.held.find((row) => row.code === "OVERLAP")!.why, /packages\/muster\/tick\.ts\/dispatch\.ts is held by LIVE/);
	assert.match(queue.held.find((row) => row.code === "SERVED")!.why, /a live lane record already names this item/);
});

test("a dependency naming another work item must be done; a condition the registry cannot judge does not block", async () => {
	const queue = readyItems({
		items: [
			item({ code: "FIRST", state: "draft", ownedPaths: ["a.ts"], brief: "/b.md" }),
			item({ code: "WAITS", dependencies: ["FIRST"], ownedPaths: ["b.ts"], brief: "/b.md" }),
			item({ code: "CONDITION", dependencies: ["the 05:09 nightly"], ownedPaths: ["c.ts"], brief: "/b.md" }),
		],
		liveLanes: [],
		brief: () => ({ ok: true, text: BRIEF }),
	});
	assert.deepEqual(queue.ready.map((row) => row.item.code), ["CONDITION"]);
	assert.match(queue.held.find((row) => row.code === "WAITS")!.why, /waiting for FIRST/);
});

// ─── 3. one launch per tick, and the slot limit ─────────────────────────────

test("one launch per tick: two ready items start exactly one lane", async () => {
	await withPort({
		items: [item({ code: "AAA", ownedPaths: ["a.ts"] }), item({ code: "BBB", ownedPaths: ["b.ts"] })],
		run: async (f) => {
			const outcome = await dispatchPass(f.port);
			assert.equal(outcome?.action, "dispatched");
			assert.equal(f.launches.length, 1, "the tick launches one lane, never a burst");
			assert.equal(f.launches[0]!.code, "AAA", "the queue is in item-code order, so the choice is not arbitrary");
		},
	});
});

test("no free slot is a wait, not a launch", async () => {
	await withPort({
		freeSlots: 0,
		run: async (f) => {
			const outcome = await dispatchPass(f.port);
			assert.equal(outcome?.action, "dispatch-held");
			assert.match(outcome!.detail, /no free lane slot \(1 item\(s\) ready\)/);
			assert.equal(f.launches.length, 0);
			assert.equal(f.gate.calls, 0, "the gate is not spent when there is nowhere to put the lane");
		},
	});
});

// ─── 4. the machine's stop levers ───────────────────────────────────────────

test("a gate refusal holds the item, keeps it ready, and writes the reason once per change", async () => {
	await withPort({
		gate: { admitted: false, reason: "only 2048 MiB of memory is available; need 12288 for the 12000 MiB job", jobSizeMiB: 12000, availableMiB: 2048 },
		run: async (f) => {
			const first = await dispatchPass(f.port);
			assert.equal(first?.action, "dispatch-waiting");
			assert.match(first!.detail, /waiting: needs 12000 MiB, 2048 free, held by low memory/);
			assert.equal(f.launches.length, 0, "nothing starts behind the gate");
			assert.equal(f.states.at(-1), undefined, "the item keeps its state: only the machine said no");
			assert.equal(f.events.length, 1, "one waiting line for the new reason");
			assert.match(f.events[0]!, /DISPATCH WAITING: OL2B waiting: needs 12000 MiB/);
			// The same refusal again writes no second line (§11 rule 3).
			f.clock.now += MINUTE;
			const second = await dispatchPass(f.port);
			assert.equal(second?.action, "dispatch-waiting");
			assert.equal(f.events.length, 1, "a re-check that finds the same reason writes nothing");
			// A changed reason is one new line.
			f.gate.reading = { admitted: false, reason: "another lane launch passed the gate 3 s ago", jobSizeMiB: 12000, availableMiB: 9000 };
			f.clock.now += MINUTE;
			await dispatchPass(f.port);
			assert.equal(f.events.length, 2);
			assert.match(f.events[1]!, /held by launch spacing/);
		},
	});
});

test("thirty minutes gated raises exactly one ask, with the operator's three choices", async () => {
	await withPort({
		gate: { admitted: false, reason: "paused by the operator at 21:00", pausedBy: "paused by the operator" },
		run: async (f) => {
			const first = await dispatchPass(f.port);
			assert.match(first!.detail, /held by paused by the operator/);
			for (let pass = 1; pass <= 40; pass += 1) {
				f.clock.now = T0 + pass * MINUTE;
				await dispatchPass(f.port);
			}
			assert.equal(f.asks.length, 1, "one ask, never a stream");
			assert.equal(f.asks[0]!.code, "OL2B");
			assert.match(f.asks[0]!.question, /held by the resource gate for 30 minutes/);
			assert.ok(f.asks[0]!.question.includes(GATED_ASK_CHOICES));
			assert.equal(f.marks.get(gatedAskedKey("OL2B")), String(T0 + 30 * MINUTE), "the ask is marked at the pass that raised it");
			assert.equal(f.marks.get(gatedReasonKey("OL2B")), composeGatedLine({ admitted: false, reason: "paused by the operator at 21:00", pausedBy: "paused by the operator" }));
		},
	});
});

test("the kill file holds the item and names its own reason", async () => {
	await withPort({
		killed: "the programme kill file exists",
		run: async (f) => {
			const outcome = await dispatchPass(f.port);
			assert.equal(outcome?.action, "dispatch-waiting");
			assert.match(outcome!.detail, /held by the kill file \(the programme kill file exists\)/);
			assert.equal(f.launches.length, 0);
			assert.equal(f.gate.calls, 0, "the kill file answers before the gate is asked");
			assert.equal(f.states.at(-1), undefined, "the stop lever never spends the item");
		},
	});
});

// ─── 5. the launch's own terms ──────────────────────────────────────────────

test("the launch states the lane, the attempt, the title, the goal, the harness and the brief — and the item becomes launched:<lane>", async () => {
	await withPort({
		items: [item({ code: "OL2B", heading: "Rebuild the dispatcher on the current main", attempt: 2 })],
		run: async (f) => {
			const outcome = await dispatchPass(f.port);
			assert.equal(outcome?.action, "dispatched");
			assert.match(outcome!.detail, /launched OL2B as ol2b-a2 \(attempt 2\)/);
			const request = f.launches[0]!;
			assert.equal(request.lane, "ol2b-a2", "the lane id is the item's code and its own attempt, lowercased");
			assert.equal(request.attempt, 2);
			assert.equal(request.title, "Rebuild the dispatcher on the current main");
			assert.equal(request.goal, "out-loop", "a bare goal code is handed to the launcher");
			assert.equal(request.harness, "pi");
			assert.equal(request.branch, "lane/ol2b-a2");
			assert.equal(request.base, "bfd73551624f", "the base is the brief's own Cut from token, which the port verifies");
			assert.equal(request.laneRoot, laneRootFor(join(f.dir, "state"), "ol2b-a2"));
			assert.deepEqual(f.states, [
				{ code: "OL2B", state: "launch-uncertain" },
				{ code: "OL2B", state: "launched:ol2b-a2" },
			], "the attempt is marked in flight before the effect and settled after it");
			assert.equal(f.events.length, 1);
			assert.match(f.events[0]!, /DISPATCH LAUNCHED: OL2B as ol2b-a2/);
			assert.equal(f.marks.get(gatedReasonKey("OL2B")), "", "a launch clears the gating marks");
		},
	});
});

test("a goal that is a sentence asks for --no-goal instead of a code the registry cannot hold", async () => {
	await withPort({ items: [item({ goal: "the out loop, shadow first" })], run: async (f) => {
		await dispatchPass(f.port);
		assert.equal(f.launches[0]!.goal, undefined);
		assert.equal(goalForItem(item({ goal: "OL2" })), "OL2");
		assert.equal(goalForItem(item({ goal: "the out loop" })), undefined);
	} });
});

// ─── 6. the launcher's own answers ──────────────────────────────────────────

test("the launcher's gate refusal (75) is retry later: the item is ready again and the reason is recorded", async () => {
	await withPort({
		launch: async () => ({ launched: false, error: "another lane launch passed the gate 12 s ago", exitCode: GATED_EXIT }),
		run: async (f) => {
			const outcome = await dispatchPass(f.port);
			assert.equal(outcome?.action, "dispatch-waiting");
			assert.match(outcome!.detail, /held by launch spacing/);
			assert.deepEqual(f.states, [
				{ code: "OL2B", state: "launch-uncertain" },
				{ code: "OL2B", state: "ready" },
			], "a refusal that started nothing returns the item to the queue");
			assert.equal(f.items.value[0]!.state, "ready");
		},
	});
});

test("a refusal about the item itself is gated:<class>, once, with the launcher's words in the event line", async () => {
	await withPort({
		launch: async () => ({ launched: false, error: "pi-lane-launch: a new lane needs --title: what it delivers, in plain words", exitCode: 3 }),
		run: async (f) => {
			const outcome = await dispatchPass(f.port);
			assert.equal(outcome?.action, "dispatch-blocked");
			assert.equal(f.states.at(-1)!.state, "gated:title");
			assert.match(f.events.at(-1)!, /DISPATCH REFUSED: OL2B as ol2b-a1 \| title \| pi-lane-launch: a new lane needs --title/);
			// The next pass does not touch it again: a gated item is out of the queue until an owner moves it.
			const again = await dispatchPass(f.port);
			assert.equal(again, undefined, "nothing ready and nothing held, so the pass says nothing");
			assert.equal(f.launches.length, 1);
		},
	});
});

test("a launcher failure after the lane started is a fault, not an undo: the lane record decides", async () => {
	// The lane record appears while the launch runs: that is the case a failure must not undo.
	const live: LiveLane[] = [];
	await withPort({
		liveLanes: live,
		launch: async () => {
			live.push({ lane: "ol2b-a1", item: "OL2B", phase: "working" });
			return { launched: false, error: "pi-lane-launch: the lane record for ol2b-a1 was not written", exitCode: 3 };
		},
		run: async (f) => {
			const outcome = await dispatchPass(f.port);
			assert.equal(outcome?.action, "dispatch-blocked");
			assert.equal(f.states.at(-1)!.state, "launched:ol2b-a1", "a running lane is reported as launched, never as nothing");
			assert.match(f.events.at(-1)!, /DISPATCH FAULT: OL2B as ol2b-a1 started but its launch reported/);
		},
	});
});

test("a lane id that already has a live record is never started again", async () => {
	// The record may exist without naming the item (a hand-launched lane took the same id): the dispatcher still
	// refuses, because starting it would replace the session that holds the record (review F4).
	await withPort({
		liveLanes: [{ lane: "ol2b-a1", phase: "blocked" }],
		run: async (f) => {
			const outcome = await dispatchPass(f.port);
			assert.equal(outcome?.action, "dispatch-blocked");
			assert.match(outcome!.detail, /lane ol2b-a1 already has a live record, so nothing was started/);
			assert.equal(f.states.at(-1)!.state, "gated:live-record");
			assert.equal(f.launches.length, 0);
			assert.equal(f.gate.calls, 0, "the gate is not spent on a lane id that cannot start");
		},
	});
});

test("the refusal class names what the refusal was about", () => {
	assert.equal(refusalClass({ launched: false, error: "the gate refused", exitCode: GATED_EXIT }), "gate");
	assert.equal(refusalClass({ launched: false, error: "a new lane needs --title", exitCode: 3 }), "title");
	assert.equal(refusalClass({ launched: false, error: "an orchestrator launch names the goal the lane works on: --goal <CODE>", exitCode: 3 }), "goal");
	assert.equal(refusalClass({ launched: false, error: "lane ol2b-a1 already has a live record (working)", exitCode: 3 }), "live-record");
	assert.equal(refusalClass({ launched: false, error: "the model is on a wall until 22:00", exitCode: 3 }), "model-wait");
	assert.equal(refusalClass({ launched: false, error: "git worktree add failed", exitCode: 1 }), "launch");
});

// ─── 7. the crash ───────────────────────────────────────────────────────────

test("an item left launch-uncertain is resolved from the lane record's item field", async () => {
	await withPort({
		items: [item({ state: "launch-uncertain" })],
		liveLanes: [{ lane: "ol2b-a1", item: "OL2B", phase: "working" }],
		run: async (f) => {
			await dispatchPass(f.port);
			assert.deepEqual(f.states, [{ code: "OL2B", state: "launched:ol2b-a1" }], "the lane record says the launch happened");
			assert.equal(f.launches.length, 0, "a resolving pass relaunches nothing blind");
			assert.match(f.events[0]!, /DISPATCH RESOLVED: OL2B was launched as ol2b-a1/);
		},
	});
});

test("an item left launch-uncertain with no lane record was never started: it is ready again", async () => {
	await withPort({
		items: [item({ state: "launch-uncertain" })],
		run: async (f) => {
			const outcome = await dispatchPass(f.port);
			assert.deepEqual(f.states, [
				{ code: "OL2B", state: "ready" },
				{ code: "OL2B", state: "launch-uncertain" },
				{ code: "OL2B", state: "launched:ol2b-a1" },
			], "it is returned to the queue first, and then the same pass may launch it");
			assert.equal(outcome?.action, "dispatched");
			assert.equal(f.launches.length, 1);
		},
	});
});

// ─── 8. shadow ──────────────────────────────────────────────────────────────

test("shadow writes one would-launch line per dispatchable item that is not live, and touches nothing else", async () => {
	await withPort({
		mode: "shadow",
		items: [
			item({ code: "OL2B", ownedPaths: ["packages/muster/dispatch.ts"] }),
			item({ code: "OL3", heading: "A2's wakes", ownedPaths: ["packages/muster/tick.ts"], goal: "the out loop, wakes only" }),
			item({ code: "OL9", heading: "Already in a lane", ownedPaths: ["docs/x.md"] }),
		],
		liveLanes: [{ lane: "ol9-a1", item: "OL9", phase: "working" }],
		run: async (f) => {
			const outcome = await dispatchPass(f.port);
			assert.equal(outcome?.action, "dispatch-held");
			assert.match(outcome!.detail, /shadow: would launch OL2B as ol2b-a1/);
			assert.equal(f.launches.length, 0, "shadow starts nothing");
			assert.equal(f.states.length, 0, "shadow moves no item");
			assert.equal(f.marks.size, 0, "shadow sets no mark");
			assert.equal(f.asks.length, 0, "shadow raises no ask");
			assert.equal(f.events.length, 0, "shadow writes no orchestrator event line");
			assert.equal(f.shadows.length, 1, "one line per pass, and the pass launches one lane");
			const line = f.shadows[0]!;
			assert.equal(line["by"], "dispatcher");
			assert.equal(line["item"], "OL2B");
			assert.equal(line["lane"], "ol2b-a1");
			assert.equal(line["goal"], "out-loop");
			assert.equal(line["harness"], "pi");
			assert.equal(line["base"], "bfd73551624f");
			assert.equal(new Set(f.shadows.map((entry) => entry["item"])).size, f.shadows.length, "no item is named twice");
		},
	});
});

test("no double-launch line: an item the orchestrator already launched gets no would-launch line", async () => {
	await withPort({
		mode: "shadow",
		items: [item({ code: "OL9", state: "launched:ol9" }), item({ code: "OL8", ownedPaths: ["docs/y.md"] })],
		liveLanes: [{ lane: "ol9", item: "OL9", phase: "working" }],
		run: async (f) => {
			await dispatchPass(f.port);
			// The orchestrator's own launch log, as the lane records carry it, beside the dispatcher's line.
			const orchestratorLaunches = f.live.value.map((lane) => lane.item).filter((code): code is string => code !== undefined);
			const dispatcherLines = f.shadows.map((line) => String(line["item"]));
			const doubleLaunch = dispatcherLines.filter((code) => orchestratorLaunches.includes(code));
			assert.deepEqual(doubleLaunch, [], "no item appears both as a dispatcher would-launch and as a real launch");
			assert.deepEqual(dispatcherLines, ["OL8"]);
		},
	});
});

// ─── the global step ────────────────────────────────────────────────────────

test("runTick runs the dispatcher with no programme and no heartbeat: it is the machine's step, not a programme's", async () => {
	await withPort({
		run: async (f) => {
			const actions = await runTick(tickPorts(f.port));
			const dispatchActions = actions.filter((action) => action.action.startsWith("dispatch"));
			assert.equal(dispatchActions.length, 1, "one dispatch action per pass");
			assert.equal(dispatchActions[0]!.action, "dispatched");
			assert.equal(dispatchActions[0]!.programmeId, "-", "the action belongs to the machine, not to a programme");
			assert.equal(f.launches.length, 1);
		},
	});
});

test("runTick without a dispatch port launches nothing and says nothing about dispatch", async () => {
	const ports = { ...tickPorts(undefined as unknown as DispatchPort) };
	delete (ports as { dispatch?: DispatchPort }).dispatch;
	const actions = await runTick(ports);
	assert.deepEqual(actions.filter((action) => action.action.startsWith("dispatch")), []);
});

test("the queue's own line names what holds it, for an operator reading the tick", () => {
	const queue = readyItems({
		items: [item({ code: "OL2B", brief: "" })],
		liveLanes: [],
		brief: () => ({ ok: true, text: BRIEF }),
	});
	assert.match(readyQueueReason(queue, 0, 2), /held OL2B: no brief file named/);
	assert.equal(readyQueueReason({ ready: [], held: [] }, 0, 2), "2 free lanes, nothing ready");
});

test("the lane id never restarts at one and the title is one bounded line", () => {
	assert.equal(laneForItem("OL2B", 1), "ol2b-a1");
	assert.equal(laneForItem("OL2B", 4), "ol2b-a4");
	assert.equal(laneForItem("GL2-ONLY", 2), "gl2-only-a2");
	assert.equal(titleForItem(item({ heading: "  a\nb  " })), "a b");
	assert.equal(titleForItem(item({ heading: "x".repeat(120) })).length, 80);
});

test("an unreadable queue is the pass's own words, never a crash", async () => {
	await withPort({
		run: async (f) => {
			const broken: DispatchPort = {
				...f.port,
				items: () => {
					throw new Error("the store is unreadable");
				},
			};
			const outcome: DispatchOutcome | undefined = await dispatchPass(broken);
			assert.equal(outcome?.action, "dispatch-held");
			assert.match(outcome!.detail, /no pass: the work items could not be read \(the store is unreadable\)/);
		},
	});
});
