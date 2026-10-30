/**
 * `muster wait --lanes` (acceptance check 4): a lane report, a stall or a gone
 * lane ends the wait; what was already on the board when the wait began does not.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { LaneCard } from "../lib/lane-card.ts";
import { formatLaneWaitResult, waitOnLaneCards } from "../lane-wait.ts";

function card(overrides: Partial<LaneCard> & { laneId: string }): LaneCard {
	return {
		harness: "pi",
		cwd: "/home/operator/projects/alpha",
		branch: "main",
		state: "idle",
		model: "openai/gpt-5",
		thinking: null,
		since: 1_000,
		updatedAt: 1_000,
		wall: null,
		...overrides,
	};
}

/**
 * A deterministic clock: no test waits in real time, and the wait loop's
 * deadline is reached by counting polls rather than by sleeping.
 */
function clock(stepMs = 10): { now: () => number; sleep: (ms: number) => Promise<void> } {
	let t = 0;
	return {
		now: () => { t += stepMs; return t; },
		sleep: async (ms: number) => { t += Math.max(ms, stepMs); },
	};
}

/** A reader that returns one scripted board per poll. */
function scripted(boards: LaneCard[][]): () => LaneCard[] {
	let index = 0;
	return () => {
		const board = boards[Math.min(index, boards.length - 1)]!;
		index += 1;
		return board;
	};
}

test("a report filed after the wait began ends the wait", async () => {
	const boards = [
		[card({ laneId: "pi-be-g3" })],
		[card({ laneId: "pi-be-g3", lastReport: { kind: "review_ready", summary: "REVIEW READY: b@c — done", at: 5_000 } })],
	];
	const result = await waitOnLaneCards({ read: scripted(boards), timeoutMs: 60_000, pollMs: 1, ...clock() });
	assert.equal(result.timedOut, false);
	assert.equal(result.events.length, 1);
	assert.equal(result.events[0]!.kind, "report");
	assert.equal(result.events[0]!.laneId, "pi-be-g3");
	assert.match(result.events[0]!.detail, /REVIEW READY/);
});

test("a report already on the card is not an event, so the same line never wakes twice", async () => {
	const board = [card({ laneId: "pi-be-g3", lastReport: { kind: "blocked", summary: "BLOCKED: no workspace", at: 1_000 } })];
	let slept = 0;
	const stepper = clock();
	const result = await waitOnLaneCards({
		read: () => board,
		timeoutMs: 100,
		pollMs: 1,
		sleep: async (ms: number) => { slept += 1; await stepper.sleep(ms); },
		now: stepper.now,
	});
	assert.equal(result.events.length, 0);
	assert.equal(result.timedOut, true);
	assert.ok(slept > 0, "it polled instead of returning the stale line");
});

test("a lane that stalls during the wait is an event; one already stalled is not", async () => {
	const stalled = card({ laneId: "pi-be-g4", state: "stalled" });
	const fresh = card({ laneId: "pi-be-g4" });
	const boards = [[fresh], [stalled]];
	const result = await waitOnLaneCards({ read: scripted(boards), timeoutMs: 60_000, pollMs: 1, ...clock() });
	assert.equal(result.events.length, 1);
	assert.equal(result.events[0]!.kind, "stalled");

	const already = await waitOnLaneCards({ read: () => [stalled], timeoutMs: 100, pollMs: 1, ...clock() });
	assert.equal(already.events.length, 0);
});

test("a lane that goes during the wait is an event", async () => {
	const boards = [[card({ laneId: "pi-be-g5" })], [card({ laneId: "pi-be-g5", state: "gone" })]];
	const result = await waitOnLaneCards({ read: scripted(boards), timeoutMs: 60_000, pollMs: 1, ...clock() });
	assert.equal(result.events[0]!.kind, "gone");
});

test("--lane restricts the wait to the named lanes", async () => {
	const boards = [
		[card({ laneId: "pi-be-g3" }), card({ laneId: "pi-be-g4" })],
		[card({ laneId: "pi-be-g3", lastReport: { kind: "blocked", summary: "BLOCKED", at: 9_000 } }), card({ laneId: "pi-be-g4" })],
	];
	const result = await waitOnLaneCards({ read: scripted(boards), timeoutMs: 60_000, pollMs: 1, laneIds: ["pi-be-g4"], ...clock() });
	assert.equal(result.timedOut, true, "pi-be-g4 said nothing and it was the only lane asked about");
});

test("an abort stops the wait without inventing an event", async () => {
	const controller = new AbortController();
	controller.abort();
	const result = await waitOnLaneCards({ read: () => [card({ laneId: "pi-core" })], timeoutMs: 60_000, pollMs: 1, signal: controller.signal, ...clock() });
	assert.equal(result.aborted, true);
	assert.equal(result.events.length, 0);
	assert.match(formatLaneWaitResult(result), /aborted/);
});

test("the one-line result names the lane and what it said", () => {
	const text = formatLaneWaitResult({ events: [{ kind: "report", laneId: "pi-be-g3", detail: "REVIEW READY: b@c" }], timedOut: false, aborted: false, elapsedMs: 4_000, polls: 2 });
	assert.equal(text, "muster wait: pi-be-g3 report: REVIEW READY: b@c");
	assert.match(formatLaneWaitResult({ events: [], timedOut: true, aborted: false, elapsedMs: 5_000, polls: 3 }), /nothing needs you/);
});
