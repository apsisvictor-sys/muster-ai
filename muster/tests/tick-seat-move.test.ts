/**
 * SL2: Claude near its limit raises the seat-move item.
 *
 * The fixture drives the whole path the brief names — the usage snapshot's own read, the headroom
 * threshold, the seat owner's read, and the ask written once — through `runTick`, so a pass that
 * reads the snapshot but never reaches the queue fails here.
 *
 * What it pins:
 *   - a 96% weekly reading with the architect seat on a live Claude session raises exactly one fully
 *     prepared ask, naming the seat, the window and the reset in Sofia time, and naming Pi as the target;
 *   - a second tick pass on the same reading raises nothing (once per crossing, never once per tick);
 *   - a drop under the line withdraws it, and a second crossing raises a second ask;
 *   - a seat that is not on Claude, a dead holder, a stale snapshot, a null quota and no snapshot at all
 *     raise nothing, and a stale snapshot does not withdraw an item it cannot measure.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readAsks, type Ask } from "../asks.ts";
import { claimSeat, describeSeat, readSeat, SEAT_ROLES, writeSeatTicket, type SeatContext, type SeatHolderInput, type SeatRole } from "../seats.ts";
import { runTick, type TickPorts } from "../tick.ts";
import { readUsageSnapshot, writeUsageSnapshot, type SnapshotWindow, type UsageSnapshot } from "../bin/usage-snapshot.mts";

const ARCHITECT_CODE = "C-CLAUDE-ARCH";
const ORCHESTRATOR_CODE = "C-CLAUDE-ORCH";
/** Friday 07:00 in Sofia, the reset the live snapshot names tonight. */
const WEEKLY_RESET_S = Math.floor(Date.parse("2026-10-30T05:00:00.000Z") / 1_000);

const CLAUDE_ARCHITECT: SeatHolderInput = { harness: "claude", sessionId: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa", processKey: "claude-4001-777", laneId: "lane-arch" };
const PI_ORCHESTRATOR: SeatHolderInput = { harness: "pi", sessionId: "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb", processKey: "pi-4002-boot-888" };

type Box = {
	root: string;
	stateDir: string;
	snapshotPath: string;
	now: number;
	alive: Set<string>;
};

function box(): Box {
	const root = mkdtempSync(join(tmpdir(), "muster-sl2-"));
	return { root, stateDir: join(root, "muster"), snapshotPath: join(root, "snapshot.json"), now: Date.parse("2026-10-29T00:40:00.000Z"), alive: new Set<string>() };
}

function withBox(run: (box: Box) => Promise<void>): () => Promise<void> {
	return async () => {
		const created = box();
		try {
			await run(created);
		} finally {
			rmSync(created.root, { recursive: true, force: true });
		}
	};
}

function seatContext(box: Box): SeatContext {
	return { stateDir: box.stateDir, now: () => box.now, processAlive: (key) => box.alive.has(key) };
}

/** A claim the way the Claude adapter makes one: the ticket's nonce, then the claim. */
function holdSeat(box: Box, role: SeatRole, holder: SeatHolderInput): void {
	const ctx = seatContext(box);
	const nonce = writeSeatTicket(role, holder.sessionId, ctx);
	box.alive.add(holder.processKey);
	claimSeat(role, holder, { kind: "ticket", nonce }, ctx);
}

function windowOf(usedPercent: number, windowMinutes: number, resetsAt: number): SnapshotWindow {
	return { usedPercent, windowMinutes, resetsAt };
}

/** The snapshot the reader writes, with Claude's two slots as the live file carries them. */
function writeSnapshot(box: Box, options: { capturedAt?: number; weekly?: number | null; fiveHour?: number; quota?: "none" } = {}): void {
	const capturedAt = options.capturedAt ?? box.now;
	const quota =
		options.quota === "none"
			? null
			: {
					source: "claude-oauth-usage",
					planType: null,
					capturedAt,
					ageMs: 0,
					primary: windowOf(options.fiveHour ?? 9, 300, WEEKLY_RESET_S - 22 * 3_600),
					secondary: options.weekly === null ? null : windowOf(options.weekly ?? 96, 10_080, WEEKLY_RESET_S),
				};
	const snapshot = {
		version: 1 as const,
		capturedAt,
		providers: [
			{
				provider: "claude-code",
				quotaState: "observable" as const,
				plan: null,
				quota,
				error: null,
				walls: [],
				reason: null,
				readerWired: true,
			},
		],
	} as unknown as UsageSnapshot;
	writeUsageSnapshot(snapshot, box.snapshotPath);
}

function ports(box: Box): TickPorts {
	return {
		now: () => box.now,
		catalogue: () => undefined,
		control: {},
		readTasks: () => undefined,
		alerts: { get: () => undefined, set: () => undefined },
		alert: async () => ({ delivered: true }),
		seatMove: {
			stateDir: () => box.stateDir,
			snapshot: () => readUsageSnapshot(box.snapshotPath),
			seats: () =>
				SEAT_ROLES.map((role) => {
					const holder = describeSeat(readSeat(role, seatContext(box)), seatContext(box)).holder;
					return { role, holder: holder === null ? null : { harness: holder.harness, processAlive: holder.processAlive } };
				}),
		},
	};
}

function askWithCode(asks: readonly Ask[], code: string): Ask | undefined {
	return asks.filter((ask) => ask.code === code).at(-1);
}

function openAsk(asks: readonly Ask[], code: string): Ask | undefined {
	return asks.filter((ask) => ask.code === code).find((ask) => ask.status === "open" || ask.status === "awaiting-operator");
}

test("a crossing at 96% weekly raises one prepared architect item that names the seat, the window and Pi", withBox(async (box) => {
	holdSeat(box, "architect", CLAUDE_ARCHITECT);
	writeSnapshot(box, { weekly: 96 });

	const actions = await runTick(ports(box));
	const raised = actions.filter((action) => action.action === "seat-move-ask");
	assert.equal(raised.length, 1, `one seat item: ${JSON.stringify(actions.map((action) => action.action))}`);

	const asks = readAsks(box.stateDir).asks;
	assert.equal(asks.length, 1, "exactly one ask");
	const ask = askWithCode(asks, ARCHITECT_CODE);
	assert.ok(ask !== undefined, "the architect's own code");
	assert.equal(ask.kind, "operator-action");
	assert.equal(ask.status, "awaiting-operator", "prepared in the same pass");
	assert.match(ask.question, /architect/);
	assert.match(ask.question, /weekly window is at 96%/);
	assert.match(ask.question, /Friday 07:00/, "the reset in Sofia time");
	assert.match(ask.question, /pi/, "the target harness");
	assert.equal(ask.options?.length, 2);
	assert.match(ask.options?.[0] ?? "", /Move the architect to pi now/, "the first option is the move");
	assert.equal(ask.recommendation, ask.options?.[0], "the recommendation is the first option word for word");
	assert.match(ask.options?.[1] ?? "", /Keep it on Claude until the window resets at Friday 07:00/);
}));

test("a second tick pass on the same reading raises nothing", withBox(async (box) => {
	holdSeat(box, "architect", CLAUDE_ARCHITECT);
	writeSnapshot(box, { weekly: 96 });

	await runTick(ports(box));
	box.now += 15 * 60_000;
	const second = await runTick(ports(box));

	assert.equal(second.filter((action) => action.action === "seat-move-ask").length, 0, "no second item while the first is open");
	assert.equal(readAsks(box.stateDir).asks.length, 1, "still one ask");
}));

test("a drop under the line withdraws the item, and a second crossing raises a second ask", withBox(async (box) => {
	holdSeat(box, "architect", CLAUDE_ARCHITECT);
	writeSnapshot(box, { weekly: 96 });
	await runTick(ports(box));

	writeSnapshot(box, { weekly: 90 });
	box.now += 15 * 60_000;
	const dropped = await runTick(ports(box));
	assert.equal(dropped.filter((action) => action.action === "seat-move-ask-withdrawn").length, 1);
	assert.equal(openAsk(readAsks(box.stateDir).asks, ARCHITECT_CODE), undefined, "the item is gone");

	writeSnapshot(box, { weekly: 96 });
	box.now += 15 * 60_000;
	await runTick(ports(box));
	const asks = readAsks(box.stateDir).asks;
	assert.equal(asks.filter((ask) => ask.code === ARCHITECT_CODE).length, 2, "a second crossing is a second ask");
	assert.equal(openAsk(asks, ARCHITECT_CODE)?.status, "awaiting-operator");
}));

test("a seat on Pi raises nothing, and the second seat is never hidden behind the first", withBox(async (box) => {
	holdSeat(box, "architect", PI_ORCHESTRATOR);
	holdSeat(box, "orchestrator", { ...CLAUDE_ARCHITECT, sessionId: "33333333-cccc-4ccc-8ccc-cccccccccccc", processKey: "claude-5003-999", laneId: "lane-orch" });
	writeSnapshot(box, { weekly: 99 });

	await runTick(ports(box));
	const asks = readAsks(box.stateDir).asks;
	assert.equal(asks.length, 1, "one item, for the seat that is on Claude");
	assert.ok(askWithCode(asks, ORCHESTRATOR_CODE) !== undefined, "the orchestrator's own code");
	assert.equal(askWithCode(asks, ARCHITECT_CODE), undefined, "the architect is on Pi and needs no move");
}));

test("a dead holder raises nothing", withBox(async (box) => {
	holdSeat(box, "architect", CLAUDE_ARCHITECT);
	box.alive.delete(CLAUDE_ARCHITECT.processKey);
	writeSnapshot(box, { weekly: 100 });

	const actions = await runTick(ports(box));
	assert.equal(actions.filter((action) => action.action === "seat-move-ask").length, 0);
	assert.equal(readAsks(box.stateDir).asks.length, 0);
}));

test("a stale snapshot raises nothing and withdraws nothing it cannot measure", withBox(async (box) => {
	holdSeat(box, "architect", CLAUDE_ARCHITECT);
	writeSnapshot(box, { weekly: 96 });
	await runTick(ports(box));

	writeSnapshot(box, { weekly: 96, capturedAt: box.now - 7 * 3_600_000 });
	box.now += 15 * 60_000;
	const stale = await runTick(ports(box));
	assert.equal(stale.filter((action) => action.action === "seat-move-ask").length, 0);
	assert.equal(stale.filter((action) => action.action === "seat-move-ask-withdrawn").length, 0);
	assert.equal(openAsk(readAsks(box.stateDir).asks, ARCHITECT_CODE)?.status, "awaiting-operator", "the item stands: the reading is unknown, not green");
}));

test("a null quota, no weekly window, and no snapshot at all raise nothing", withBox(async (box) => {
	holdSeat(box, "architect", CLAUDE_ARCHITECT);

	writeSnapshot(box, { quota: "none" });
	assert.equal((await runTick(ports(box))).filter((action) => action.action === "seat-move-ask").length, 0, "quota null");

	writeSnapshot(box, { weekly: null, fiveHour: 40 });
	assert.equal((await runTick(ports(box))).filter((action) => action.action === "seat-move-ask").length, 0, "no weekly window");

	rmSync(box.snapshotPath, { force: true });
	assert.equal((await runTick(ports(box))).filter((action) => action.action === "seat-move-ask").length, 0, "no snapshot");
	assert.equal(readAsks(box.stateDir).asks.length, 0);
}));
