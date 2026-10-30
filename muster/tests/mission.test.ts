/**
 * The mission table (check 7): rows, keys, opening a lane and the watch loop.
 * No terminal, no tmux: every effect is injected.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { LaneCard } from "../lib/lane-card.ts";
import { missionKey, missionOpenPlan, missionRows, renderMissionTable } from "../mission.ts";
import { MISSION_KEYPRESSES, runMissionWatch } from "../mission-run.ts";

function card(overrides: Partial<LaneCard> & { laneId: string }): LaneCard {
	return {
		harness: "pi",
		cwd: "/home/operator/projects/be-lane-pi-g3",
		branch: "feat/x",
		state: "running",
		model: "openai-codex/gpt-5.6-luna",
		thinking: "high",
		since: 1_000,
		updatedAt: 10_000,
		wall: null,
		...overrides,
	};
}

test("a row carries the card's lane, state, model, context, heartbeat, branch and last report", () => {
	const rows = missionRows([
		card({ laneId: "pi-be-g3", contextPercent: 39, lastReport: { kind: "working", summary: "progress: half way", at: 9_000 }, authoritative: true }),
		card({ laneId: "11111111-2222-3333-4444-555555555555", harness: "pi", updatedAt: null, branch: null, model: null, authoritative: false }),
	], 40_000);
	assert.equal(rows[0]!.laneId, "pi-be-g3");
	assert.equal(rows[0]!.context, "39%");
	assert.equal(rows[0]!.heartbeat, "30s");
	assert.equal(rows[0]!.branch, "feat/x");
	assert.equal(rows[0]!.report, "working: progress: half way");
	assert.equal(rows[0]!.enrolled, true);
	assert.equal(rows[1]!.context, "—");
	assert.equal(rows[1]!.heartbeat, "—");
	assert.equal(rows[1]!.enrolled, false, "no card means the bus cannot reach it");
});

test("the table marks a row without a card as not enrolled", () => {
	const table = renderMissionTable(missionRows([card({ laneId: "pi-x", authoritative: false })]), { selected: 0, height: 20 });
	assert.match(table, /lane {2,}harness {2,}model {2,}state {2,}ctx {2,}beat {2,}branch {2,}last report/);
	assert.match(table, /pi-x \(not enrolled\)/);
	assert.match(table, /↑\/↓ select · Enter open · q quit/);
});

test("keys: arrows and j/k move, Enter opens, q and Ctrl-C quit, nothing else acts", () => {
	assert.equal(missionKey("\u001b[A"), "up");
	assert.equal(missionKey("k"), "up");
	assert.equal(missionKey("\u001b[B"), "down");
	assert.equal(missionKey("j"), "down");
	assert.equal(missionKey("\r"), "open");
	assert.equal(missionKey("\n"), "open");
	assert.equal(missionKey("q"), "quit");
	assert.equal(missionKey("\u0003"), "quit");
	assert.equal(missionKey("x"), "none");
	assert.equal(missionKey("\u001b[5~"), "none");
});

test("Enter opens a lane's own window, in the lane's own session, and switches the client when it is elsewhere", () => {
	const pi = missionOpenPlan({ laneId: "pi-be-g3", harness: "pi" } as never, { session: "pi" });
	assert.equal(pi.kind, "tmux");
	assert.deepEqual(pi.args, ["select-window", "-t", "pi:pi-be-g3"]);
	const oc = missionOpenPlan({ laneId: "oc-c6", harness: "opencode" } as never, { session: "pi", opencodeSession: "oc" });
	assert.deepEqual(oc.args, ["select-window", "-t", "oc:oc-c6"]);
	const elsewhere = missionOpenPlan({ laneId: "pi-core", harness: "pi" } as never, { session: "pi", clientSession: "59" });
	assert.deepEqual(elsewhere.args, ["select-window", "-t", "pi:pi-core", ";", "switch-client", "-t", "pi"]);
	const claude = missionOpenPlan({ laneId: "cc-be", harness: "claude" } as never, { session: "pi" });
	assert.equal(claude.kind, "claude");
	assert.deepEqual(claude.args, ["attach", "cc-be"]);
	assert.equal(claude.window, "pi:view-cc-be");
});

test("the watch loop draws, moves, opens the selected lane and stops on q", async () => {
	const cards = [card({ laneId: "pi-be-g3", authoritative: true }), card({ laneId: "pi-be-g4", authoritative: true })];
	const drawn: string[] = [];
	const opened: string[] = [];
	let handler: ((key: ReturnType<typeof missionKey>) => void) | undefined;
	const keys: Array<ReturnType<typeof missionKey>> = ["down", "open", "quit"];
	const code = await runMissionWatch(
		{
			readCards: () => cards,
			write: (text: string) => { drawn.push(text); },
			size: () => ({ rows: 20, columns: 200 }),
			onKey: (next: (key: ReturnType<typeof missionKey>) => void) => { handler = next; return () => { handler = undefined; }; },
			open: (row: { laneId: string }) => { opened.push(row.laneId); return { ok: true, detail: "opened" }; },
			now: () => 40_000,
			sleep: async () => { const key = keys.shift(); if (key !== undefined) handler?.(key); },
		},
		{ refreshMs: 1, maxFrames: 12 },
	);
	assert.equal(code, 0);
	assert.ok(drawn.length >= 1, "the table was drawn before the first key arrived");
	assert.match(drawn[0]!, /pi-be-g3/);
	assert.deepEqual(opened, ["pi-be-g4"], "Down then Enter opens the second row");
});

test("q stops the loop before another frame is drawn", async () => {
	const drawn: string[] = [];
	let handler: ((key: ReturnType<typeof missionKey>) => void) | undefined;
	let frames = 0;
	await runMissionWatch(
		{
			readCards: () => [card({ laneId: "pi-be-g3" })],
			write: (text: string) => { drawn.push(text); },
			size: () => ({ rows: 20, columns: 200 }),
			onKey: (next) => { handler = next; return () => { handler = undefined; }; },
			open: () => ({ ok: true, detail: "opened" }),
			now: () => 40_000,
			sleep: async () => { frames += 1; handler?.(missionKey(MISSION_KEYPRESSES.quit)); },
		},
		{ refreshMs: 1, maxFrames: 5 },
	);
	assert.equal(frames, 1, "it stopped after the key instead of drawing another frame");
	assert.equal(drawn.length, 1);
});
