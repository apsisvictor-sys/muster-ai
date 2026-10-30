/**
 * The mission watch loop (check 7).
 *
 * Reads the cards, draws the table, and acts on keys: Up/Down move, Enter opens
 * the lane's own terminal, q quits. Every effect is injected, so the loop is
 * testable without a terminal and the CLI supplies the real stdin, clock, tmux
 * and claude.
 *
 * It never sends text to a lane: opening a lane is `select-window` on the
 * window the lane already has, or a new `view-<lane>` window running
 * `claude attach <name>` for a Claude background session.
 */

import type { LaneCard } from "./lib/lane-card.ts";
import { missionKey, missionOpenPlan, missionRows, renderMissionTable, type MissionKey } from "./mission.ts";

export interface MissionWatchIo {
	readCards: () => LaneCard[];
	write: (text: string) => void;
	/** Terminal size, so the table fits the window. */
	size: () => { rows: number; columns: number };
	/** Subscribe to keypresses; returns an unsubscribe function. */
	onKey: (handler: (key: MissionKey) => void) => () => void;
	/** Open a lane's own terminal. */
	open: (row: { laneId: string; harness: string }) => { ok: boolean; detail: string };
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** The tmux session the lanes live in (and the view session for Claude rows). */
	session?: string;
	opencodeSession?: string;
	clientSession?: () => string | undefined;
}

export interface MissionWatchOptions {
	refreshMs?: number;
	signal?: AbortSignal;
	/** Stop after this many frames (tests). */
	maxFrames?: number;
}

export const MISSION_REFRESH_MS = 2_000;

export async function runMissionWatch(io: MissionWatchIo, opts: MissionWatchOptions = {}): Promise<number> {
	const now = io.now ?? (() => Date.now());
	const sleep = io.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
	const refreshMs = Math.max(250, opts.refreshMs ?? MISSION_REFRESH_MS);
	let selected = 0;
	let quit = false;
	let frames = 0;

	const draw = (): void => {
		const cards = io.readCards();
		const rows = missionRows(cards, now());
		if (selected >= rows.length) selected = Math.max(0, rows.length - 1);
		const { rows: height, columns } = io.size();
		const title = `pi-mission · ${rows.length} lane${rows.length === 1 ? "" : "s"} · refreshed ${new Date(now()).toISOString().slice(11, 19)}Z`;
		const table = renderMissionTable(rows, { selected, height: Math.max(6, height - 1), title });
		// Clear and home: the table is redrawn in place, the window never scrolls.
		io.write(`\u001b[2J\u001b[H${table.split("\n").map((line) => line.slice(0, Math.max(20, columns))).join("\n")}`);
	};

	const handle = (key: MissionKey): void => {
		if (key === "quit") {
			quit = true;
			return;
		}
		const rows = missionRows(io.readCards(), now());
		if (key === "up") selected = Math.max(0, selected - 1);
		if (key === "down") selected = Math.min(Math.max(0, rows.length - 1), selected + 1);
		if (key === "open") {
			const row = rows[selected];
			if (row === undefined) return;
			const plan = missionOpenPlan(
				row,
				{
					session: io.session ?? "pi",
					...(io.opencodeSession !== undefined ? { opencodeSession: io.opencodeSession } : {}),
					...(io.clientSession?.() !== undefined ? { clientSession: io.clientSession() } : {}),
				},
			);
			if (plan.kind === "none") {
				io.write(`\n${row.laneId}: nothing to open\n`);
				return;
			}
			const result = io.open(row);
			if (!result.ok) io.write(`\n${row.laneId}: ${result.detail}\n`);
		}
	};

	const unsubscribe = io.onKey(handle);
	try {
		while (!quit) {
			draw();
			frames += 1;
			if (opts.maxFrames !== undefined && frames >= opts.maxFrames) break;
			if (opts.signal?.aborted === true) break;
			if (quit) break;
			await sleep(refreshMs);
		}
	} finally {
		unsubscribe();
	}
	return 0;
}

/**
 * The raw keypress bytes a terminal sends, for a caller that drives the loop
 * itself. They are not `MissionKey` values: map them with `missionKey()` first,
 * exactly as the real stdin subscription does.
 */
export const MISSION_KEYPRESSES = { up: "\u001b[A", down: "\u001b[B", open: "\r", quit: "q" } as const;

export { missionKey };
