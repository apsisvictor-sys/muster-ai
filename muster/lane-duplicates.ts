/**
 * The duplicate guard (lifecycle LD15): two live sessions under one lane name, or two live sessions of
 * one lane's session chain, are a fork. A fork splits the lane's messages and its record; on 2026-10-11
 * the resume of sn-product left two live copies and lost a decision. The tick finds one within 2 minutes
 * whatever caused it, tells the orchestrator and Henry once, and changes nothing: the guard never stops,
 * parks, messages or otherwise touches a session, so it is as safe on the operator's own sessions and on a
 * conversation lane as anywhere else. The orchestrator decides which copy stays.
 *
 * The facts are raw: `enumerateLanes` folds two rows of one name into one lane, so the guard reads
 * `claude agents --json` and `tmux list-panes` itself (through the directory's own readers and its pid
 * check) and the lane records' session chains. This module decides; `scripts/muster-tick.mts` reads
 * the machine and delivers the alert, and the launcher refuses a live name before a second one exists.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CLAUDE_LANE_NAME, type ClaudeLaneRow, type TmuxPane } from "./lib/lane-directory.ts";
import type { LaneRecord } from "./lane-lifecycle.ts";
import { tmuxSessionForHarness } from "./send.ts";

/** The tmux sessions lanes live in, from the one owner of the harness-to-session layout (`tmuxSessionForHarness`; `pi` is its default). */
export const LANE_TMUX_SESSIONS: readonly string[] = [...new Set(["pi", "opencode"].map((harness) => tmuxSessionForHarness(harness) ?? "pi"))];

/** One live session or window that holds a lane name. */
export interface LiveHolder {
	/** Stable and readable: `claude:<first 8 of the session id>` or `tmux:<session>/<window>#<window id or pane pid>`. */
	id: string;
	harness: "claude" | "tmux";
	sessionId?: string;
}

/** Two or more live holders of one lane. */
export interface DuplicateSet {
	/** The sorted holder ids: the set's identity, so one set is reported once. */
	key: string;
	/** The lane name the holders share (a session chain's lane, or a window or session name). */
	lane: string;
	holders: LiveHolder[];
}

export interface DuplicateEvidence {
	claudeRows: readonly ClaudeLaneRow[];
	/** `undefined` when tmux could not be read: no tmux holder is invented from that. */
	panes: readonly TmuxPane[] | undefined;
	records: readonly Pick<LaneRecord, "laneId" | "sessionChain" | "sessionId">[];
	/**
	 * Lane names something on the bus knows (a card, a registry row, a lane record): the directory's `auto` rows.
	 * A window or session that merely carries a name is not a lane: the operator's own tmux windows in the `pi` session
	 * are called `claude`, and two of them are no fork.
	 */
	knownLanes: ReadonlySet<string>;
	pidAlive(pid: number): boolean;
}

/**
 * Every lane name with more than one live holder. A Claude row is live when its pid is in /proc (a row
 * the daemon still lists with a dead or missing pid is a dead lane, as everywhere else in the directory);
 * a tmux window is live when any of its panes is not dead. A Claude row or window belongs to the lane it is
 * named for (when the name is a lane name the bus knows, not free text or a window of the operator's) and a Claude row to the lane whose record chain holds its session
 * id, so a copy that was renamed is still caught.
 */
export function findDuplicateLanes(evidence: DuplicateEvidence): DuplicateSet[] {
	const groups = new Map<string, Map<string, LiveHolder>>();
	const add = (lane: string, holder: LiveHolder): void => {
		const group = groups.get(lane) ?? new Map<string, LiveHolder>();
		group.set(holder.id, holder);
		groups.set(lane, group);
	};
	const chainLanes = new Map<string, string[]>();
	for (const record of evidence.records) {
		for (const sessionId of new Set([...(record.sessionChain ?? []), ...(record.sessionId !== undefined ? [record.sessionId] : [])])) {
			chainLanes.set(sessionId, [...(chainLanes.get(sessionId) ?? []), record.laneId]);
		}
	}
	for (const row of evidence.claudeRows) {
		if (typeof row.sessionId !== "string" || row.sessionId === "" || typeof row.pid !== "number" || !evidence.pidAlive(row.pid)) continue;
		const holder: LiveHolder = { id: `claude:${row.sessionId.slice(0, 8)}`, harness: "claude", sessionId: row.sessionId };
		const name = typeof row.name === "string" ? row.name.trim() : "";
		if (CLAUDE_LANE_NAME.test(name) && evidence.knownLanes.has(name)) add(name, holder);
		for (const lane of chainLanes.get(row.sessionId) ?? []) add(lane, holder);
	}
	const windows = new Map<string, { lane: string; holder: LiveHolder; alive: boolean }>();
	for (const pane of evidence.panes ?? []) {
		if (!LANE_TMUX_SESSIONS.includes(pane.session)) continue;
		const id = `tmux:${pane.session}/${pane.window}#${pane.windowId ?? pane.pid}`;
		const seen = windows.get(id);
		windows.set(id, { lane: pane.window, holder: { id, harness: "tmux" }, alive: (seen?.alive ?? false) || !pane.dead });
	}
	for (const { lane, holder, alive } of windows.values()) if (alive && evidence.knownLanes.has(lane)) add(lane, holder);

	const sets = new Map<string, DuplicateSet>();
	for (const [lane, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
		if (group.size < 2) continue;
		const holders = [...group.values()].sort((a, b) => a.id.localeCompare(b.id));
		const key = holders.map((holder) => holder.id).join("+");
		if (!sets.has(key)) sets.set(key, { key, lane, holders });
	}
	return [...sets.values()];
}

/** The words of the alert, for the STALLED event (`formatEventLine("STALLED", lane, …)`). */
export function duplicateDetail(set: DuplicateSet): string {
	return `duplicate: ${set.holders.map((holder) => holder.id).join(", ")}`;
}

/** The words of the line to Henry's outbox. */
export function duplicateOperatorText(set: DuplicateSet): string {
	return `Lane ${set.lane} has ${set.holders.length} live sessions (${set.holders.map((holder) => holder.id).join(", ")}). Nothing was stopped or changed. The orchestrator decides which one stays.`;
}

// ─── Reported once ─────────────────────────────────────────────────────────────────────────────

/** A duplicate set reported this long ago is forgotten, so the file does not grow for ever. */
export const DUPLICATE_MEMORY_MS = 30 * 24 * 60 * 60 * 1000;

export function duplicatesReportedFile(musterStateDir: string): string {
	return join(musterStateDir, "duplicates-reported.json");
}

/** The sets already reported: key to the time they were. An absent or unreadable file is "none". */
export function readReportedDuplicates(musterStateDir: string): Record<string, number> {
	try {
		const file = duplicatesReportedFile(musterStateDir);
		if (!existsSync(file)) return {};
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
	} catch {
		return {};
	}
}

/**
 * Remember that a set was reported. Entries older than `DUPLICATE_MEMORY_MS` are dropped on the way. A
 * set is never dropped just because it stopped showing: one failed `claude agents` read would otherwise
 * report the same live fork again at the next tick.
 */
export function markDuplicateReported(musterStateDir: string, key: string, at: number): void {
	const kept = Object.fromEntries(Object.entries(readReportedDuplicates(musterStateDir)).filter(([, reportedAt]) => at - reportedAt < DUPLICATE_MEMORY_MS));
	const file = duplicatesReportedFile(musterStateDir);
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify({ ...kept, [key]: at }, null, 2), { mode: 0o600 });
	renameSync(tmp, file);
}
