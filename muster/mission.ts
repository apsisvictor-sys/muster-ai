/**
 * The mission table — acceptance check 7, design §4.6.
 *
 * One read-only view of every lane the bus can see, drawn from the lane cards
 * through their owner (`lib/lane-directory.ts`). It is what the `pi:mission`
 * tmux window runs (`muster lanes --watch`).
 *
 * Nothing here writes to a lane: Enter opens a lane's own terminal (the tmux
 * window it already has, or `claude attach` for a Claude background session),
 * and every other key is navigation. A row with no card is marked `not
 * enrolled`, because that is the one thing the orchestrator must be able to see
 * at a glance: a lane the bus cannot message or control.
 */

import type { LaneCard } from "./lib/lane-card.ts";

export interface MissionRow {
	laneId: string;
	harness: string;
	model: string;
	state: string;
	/** Context window used, e.g. `39%`; `—` when the harness cannot say. */
	context: string;
	/** Age of the last heartbeat, e.g. `12s`; `—` for a row with no card. */
	heartbeat: string;
	branch: string;
	/** The lane's last report line, or `—`. */
	report: string;
	/** False for a row the directory derived from a harness surface, not a card. */
	enrolled: boolean;
}

function age(ms: number | null | undefined, now: number): string {
	if (typeof ms !== "number" || ms <= 0) return "—";
	const seconds = Math.max(0, Math.round((now - ms) / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	return `${Math.round(seconds / 3600)}h`;
}

function oneLine(text: string, max: number): string {
	const flat = text.replace(/[\r\n]+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}

export function missionRows(cards: readonly LaneCard[], now = Date.now()): MissionRow[] {
	return cards.map((card) => ({
		laneId: card.laneId,
		harness: card.harness,
		model: card.model ?? "—",
		state: card.wall !== null && card.state === "quota-walled" ? `quota-walled (${card.wall.shapeId})` : card.state,
		context: typeof card.contextPercent === "number" ? `${card.contextPercent}%` : "—",
		heartbeat: age(card.updatedAt, now),
		branch: card.branch ?? "—",
		report: card.lastReport === undefined ? "—" : oneLine(`${card.lastReport.kind}: ${card.lastReport.summary}`, 60),
		enrolled: card.authoritative === true,
	}));
}

/** A row's lane id plus the marker the table shows for an unenrolled lane. */
export function missionLabel(row: MissionRow): string {
	return row.enrolled ? row.laneId : `${row.laneId} (not enrolled)`;
}

const COLUMNS: Array<{ header: string; width: number; of: (row: MissionRow) => string }> = [
	{ header: "lane", width: 26, of: (row) => missionLabel(row) },
	{ header: "harness", width: 8, of: (row) => row.harness },
	{ header: "model", width: 26, of: (row) => row.model },
	{ header: "state", width: 18, of: (row) => row.state },
	{ header: "ctx", width: 5, of: (row) => row.context },
	{ header: "beat", width: 5, of: (row) => row.heartbeat },
	{ header: "branch", width: 16, of: (row) => row.branch },
	{ header: "last report", width: 62, of: (row) => row.report },
];

/**
 * Render the table. `selected` is highlighted; `height` bounds the visible rows
 * so the window never scrolls past the terminal, and the caller keeps the
 * selection on screen by passing a window of rows.
 */
export function renderMissionTable(
	rows: readonly MissionRow[],
	opts: { selected?: number; height?: number; now?: number; title?: string } = {},
): string {
	const selected = opts.selected ?? -1;
	const height = Math.max(4, opts.height ?? 40);
	const header = COLUMNS.map((column) => column.header.padEnd(column.width)).join("  ").trimEnd();
	const separator = COLUMNS.map((column) => "─".repeat(column.width)).join("  ").trimEnd();
	const lines: string[] = [opts.title ?? `lanes (${rows.length})`, header, separator];
	if (rows.length === 0) {
		lines.push("no lanes visible: no cards, no registered lane sessions, no claude agents");
		return `${lines.join("\n")}\n`;
	}
	// Keep the selection inside the visible window.
	const body = Math.max(1, height - lines.length - 1);
	const offset = selected < 0 || rows.length <= body ? 0 : Math.max(0, Math.min(selected - Math.floor(body / 2), rows.length - body));
	for (let index = offset; index < Math.min(rows.length, offset + body); index += 1) {
		const row = rows[index]!;
		const text = COLUMNS.map((column) => oneLine(column.of(row), column.width).padEnd(column.width)).join("  ").trimEnd();
		lines.push(`${index === selected ? "▸" : " "} ${text}`);
	}
	if (rows.length > body) lines.push(`  … ${rows.length - body} more`);
	lines.push("");
	lines.push("↑/↓ select · Enter open · q quit");
	return `${lines.join("\n")}\n`;
}

export type MissionKey = "up" | "down" | "open" | "quit" | "none";

/** One keypress. Enter is `\r`; vim-style keys work too, nothing else acts. */
export function missionKey(data: string): MissionKey {
	if (data === "\u001b[A" || data === "k") return "up";
	if (data === "\u001b[B" || data === "j") return "down";
	if (data === "\r" || data === "\n") return "open";
	if (data === "q" || data === "\u0003") return "quit";
	return "none";
}

export interface MissionOpenPlan {
	kind: "tmux" | "claude" | "none";
	/** tmux: argv for `tmux`. claude: argv for the attach command. */
	args: string[];
	/** The window the plan needs, for the caller's log line. */
	window?: string;
}

/**
 * How Enter opens a row.
 *
 * A Pi or OpenCode lane already owns a tmux window: the table switches the
 * client to it (`select-window`, plus `switch-client` when the client sits in
 * another session). A Claude background session has no window, so the table
 * creates one named `view-<lane>` and attaches to it there. A row the table
 * cannot open says so instead of guessing.
 */
export function missionOpenPlan(
	row: MissionRow,
	opts: { session: string; viewSession?: string; clientSession?: string; opencodeSession?: string } = { session: "pi" },
): MissionOpenPlan {
	const viewSession = opts.viewSession ?? "pi";
	if (row.harness === "claude") {
		if (row.laneId.trim() === "") return { kind: "none", args: [] };
		return { kind: "claude", args: ["attach", row.laneId], window: `${viewSession}:view-${row.laneId}` };
	}
	const session = row.harness === "opencode" ? opts.opencodeSession ?? "oc" : opts.session;
	const target = `${session}:${row.laneId}`;
	const args = ["select-window", "-t", target];
	if (opts.clientSession !== undefined && opts.clientSession !== "" && opts.clientSession !== session) {
		args.push(";", "switch-client", "-t", session);
	}
	return { kind: "tmux", args, window: target };
}
