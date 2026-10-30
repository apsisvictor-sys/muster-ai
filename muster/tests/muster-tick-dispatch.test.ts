import "./muster-test-isolation.ts";
/**
 * OL2 on the tick's own side (out-loop spec Revision 3 §9, §10 row OL2, §11 rule 3; VR24-208, VR24-220):
 * the two things the dispatcher changed about the tick itself.
 *
 *   1. While the dispatcher may launch, the empty-slot wake stays silent: A1 owns the work items, so the
 *      orchestrator is not also asked to place a lane. With the mode `off` it speaks exactly as before.
 *   2. The slot count is `routing.slots` minus every worker lane, not the Pi lanes only: the cap counts a
 *      Claude or OpenCode lane too, and the Pi-only view is the floor's own filter, kept for its callers.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { LaneCard } from "../lib/lane-card.ts";
import {
	EMPTY_SLOT_MIN_LANES,
	emptySlotWake,
	runningPiWorkerLanes,
	runningWorkerLanes,
	type EmptySlotPort,
	type SeatHold,
	type TickPorts,
} from "../tick.ts";
import type { DispatchMode, DispatchPort } from "../dispatch.ts";

const T0 = Date.UTC(2026, 9, 28, 21, 0, 0);
const MINUTE = 60_000;

function lane(over: Partial<LaneCard> & { laneId: string }): LaneCard {
	return { harness: "pi", state: "running", origin: "lane", ...over } as LaneCard;
}

// ─── 2. the slot count ─────────────────────────────────────────────────────

test("the slot count sees every harness; the Pi-only view is a filter on it", () => {
	const rows = [
		lane({ laneId: "pi-a1" }),
		lane({ laneId: "claude-a1", harness: "claude" }),
		lane({ laneId: "opencode-a1", harness: "opencode" }),
		lane({ laneId: "merged-a1", state: "merged" }),
		lane({ laneId: "operator:a1", origin: "operator" }),
	];
	const seats: SeatHold[] = [{ role: "orchestrator", sessionId: "seat-session", laneId: "seat-lane" }];
	assert.deepEqual(runningWorkerLanes(rows, seats).map((row) => row.laneId), ["pi-a1", "claude-a1", "opencode-a1"]);
	assert.deepEqual(runningPiWorkerLanes(rows, seats).map((row) => row.laneId), ["pi-a1"], "the floor's own view stays Pi only");
	const seatHeld = [...rows, lane({ laneId: "seat-lane" })];
	assert.equal(runningWorkerLanes(seatHeld, seats).some((row) => row.laneId === "seat-lane"), false, "a seat holder is not a slot it fills");
});

// ─── 1. the empty-slot wake ────────────────────────────────────────────────

/** One scratch installation: one ready work item, a marks store, and the two seats a wake needs. */
function tickWith(mode: DispatchMode, wakes: string[]): { ports: TickPorts; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "muster-tick-dispatch-"));
	const marks = new Map<string, string>();
	const emptySlot: EmptySlotPort = {
		lanes: () => [lane({ laneId: "only-a1" })],
		seats: () => [{ role: "orchestrator", sessionId: "orchestrator-session" }],
		// CUTOVER: the ready rows are the work-item records' now, not the hand table's.
		readyItems: () => ({ ok: true, ready: ["OL9"] }),
		wake: (text) => void wakes.push(text),
	};
	const ports: TickPorts = {
		now: () => T0,
		catalogue: () => undefined,
		control: {},
		readTasks: () => undefined,
		alerts: { get: (key) => marks.get(key), set: (key, value) => void marks.set(key, value) },
		alert: async () => ({ delivered: true }),
		emptySlot,
		// Only the mode is read by the wake; the rest of the port is the dispatcher's own business.
		dispatch: { mode: () => mode } as unknown as DispatchPort,
	};
	return { ports, dir };
}

/** Below the floor for a quarter hour with a ready backlog: the state the wake exists for. */
function belowFloorForAQuarterHour(ports: TickPorts): TickPorts {
	emptySlotWake(ports);
	return { ...ports, now: () => T0 + 16 * MINUTE };
}

test("the empty-slot wake stays silent while the dispatcher may launch", () => {
	const dirs: string[] = [];
	try {
		for (const mode of ["shadow", "on"] as const) {
			const wakes: string[] = [];
			const { ports, dir } = tickWith(mode, wakes);
			dirs.push(dir);
			assert.equal(emptySlotWake(belowFloorForAQuarterHour(ports)), undefined, `A1 owns the work items while the mode is ${mode}`);
			assert.deepEqual(wakes, [], "the orchestrator is not asked to place a lane the dispatcher will place");
		}
	} finally {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	}
});

test("with the mode off the wake speaks exactly as before, and the floor is still three lanes", () => {
	const wakes: string[] = [];
	const { ports, dir } = tickWith("off", wakes);
	try {
		const action = emptySlotWake(belowFloorForAQuarterHour(ports));
		assert.equal(action?.action, "empty-slot-wake", "off is the rollback, so the wake is untouched");
		assert.equal(wakes.length, 1);
		assert.match(wakes[0]!, /1 Pi worker lane/);
		assert.equal(EMPTY_SLOT_MIN_LANES, 3);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
