/**
 * Flow metrics (R1 item 7), derived from records that already exist.
 *
 * There is no ledger here. Concord's ownership events say who held which task
 * and when it moved; the per-session journals say when the parent was running,
 * each continuation decision and each blocked edit. This module only reads and
 * counts them, so the numbers can be checked by hand against the source rows.
 *
 * The same one-line form feeds `/muster status` and each Discord digest line.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { ContinuationDecisionOutcome, MetricRow } from "./types.ts";

export type OwnershipEvent = {
	taskId: string;
	transition: string;
	at: number;
	actorAgentId: string;
	toAgentId?: string;
	fromStatus: string;
	toStatus: string;
};

export type MetricsInput = {
	/** Ownership events in time order or not: they are sorted here. Include some lookback before `from`. */
	events: OwnershipEvent[];
	metricEvents: MetricRow[];
	mailbox: string;
	ceiling: number;
	from: number;
	to: number;
	/** Operator-retired identities, for the false-edit-block count. */
	retired: ReadonlySet<string>;
};

export type Stat = { count: number; meanMin: number; medianMin: number; maxMin: number };

export type Metrics = {
	windowMin: number;
	ceiling: number;
	laneMinutes: number;
	avgLiveLanes: number;
	/** Lane-minutes over window-minutes times the ceiling, 0 to 1. */
	occupancy: number;
	offerToAccept: Stat | undefined;
	/** accept_handoff to close. BE closes in batches, so this is an upper bound on integration time. */
	acceptToClose: Stat | undefined;
	/** Minutes the parent waited on offered handoffs. */
	waitingMin: number;
	/** Of those, minutes with no parent turn running; undefined when no turn was ever recorded. */
	parentIdleWithWorkMin: number | undefined;
	editBlocks: { total: number; falseBlocks: number };
	continuations: {
		admitted: number;
		steered: number;
		waiting: Record<string, number>;
		denied: Record<string, number>;
		deferred: number;
		unavailable: number;
	};
};

const MINUTE = 60_000;
const ASSIGNING = new Set(["assign", "reassign", "force_reassign"]);
const LANE_ENDING = new Set(["accept_handoff", "release", "close"]);

type Interval = [number, number];

function overlap(a: Interval, b: Interval): number {
	return Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
}

function round(value: number, places = 2): number {
	const scale = 10 ** places;
	return Math.round(value * scale) / scale;
}

function stat(durationsMs: number[]): Stat | undefined {
	if (durationsMs.length === 0) return undefined;
	const sorted = durationsMs.map((ms) => ms / MINUTE).sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
	return {
		count: sorted.length,
		meanMin: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
		medianMin: round(median),
		maxMin: round(sorted[sorted.length - 1]!),
	};
}

/** Merge overlapping intervals into a disjoint, sorted set. */
function unionOf(intervals: Interval[]): Interval[] {
	const merged: Interval[] = [];
	for (const interval of [...intervals].sort((a, b) => a[0] - b[0])) {
		const last = merged[merged.length - 1];
		if (last !== undefined && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
		else merged.push([interval[0], interval[1]]);
	}
	return merged;
}

/**
 * Parent turns as disjoint intervals. Turns are paired within each session: one
 * session's run-end must never close another session's turn.
 */
function runIntervals(rows: MetricRow[], from: number, to: number): Interval[] {
	const sessions = new Map<string, MetricRow[]>();
	for (const row of rows) {
		if (row.event !== "run-start" && row.event !== "run-end") continue;
		sessions.set(row.session, [...(sessions.get(row.session) ?? []), row]);
	}
	return unionOf([...sessions.values()].flatMap((sessionRows) => sessionIntervals(sessionRows, from, to)));
}

function sessionIntervals(rows: MetricRow[], from: number, to: number): Interval[] {
	const runEvents = rows.filter((row) => row.event === "run-start" || row.event === "run-end").sort((a, b) => a.at - b.at);
	// A first row that ends a turn means the turn began before the rows we have.
	let open: number | undefined = runEvents[0]?.event === "run-end" ? from : undefined;
	const intervals: Interval[] = [];
	for (const row of runEvents) {
		if (row.event === "run-start") {
			if (open === undefined) open = row.at;
		} else if (open !== undefined) {
			intervals.push([open, row.at]);
			open = undefined;
		}
	}
	if (open !== undefined) intervals.push([open, to]);
	return intervals;
}

export function computeMetrics(input: MetricsInput): Metrics {
	const { mailbox, ceiling, from, to, retired } = input;
	const windowMs = Math.max(1, to - from);
	const window: Interval = [from, to];
	const events = input.events.map((event, index) => ({ event, index })).sort((a, b) => a.event.at - b.event.at || a.index - b.index).map((entry) => entry.event);

	// Lanes: a worker holds a lane from the assignment until its handoff is accepted,
	// it is released or it is closed. Reassigning to another worker keeps it open.
	const laneStart = new Map<string, number>();
	const lanes: Interval[] = [];
	const offerAt = new Map<string, number>();
	const acceptAt = new Map<string, number>();
	const offerToAccept: number[] = [];
	const acceptToClose: number[] = [];
	const waiting: Interval[] = [];
	for (const event of events) {
		const toWorker = event.toAgentId !== undefined && event.toAgentId !== mailbox;
		if (ASSIGNING.has(event.transition) && toWorker) {
			if (!laneStart.has(event.taskId)) laneStart.set(event.taskId, event.at);
		} else if (LANE_ENDING.has(event.transition) || (ASSIGNING.has(event.transition) && !toWorker)) {
			const start = laneStart.get(event.taskId);
			if (start !== undefined) {
				lanes.push([start, event.at]);
				laneStart.delete(event.taskId);
			}
		}
		if (event.transition === "offer_handoff") {
			offerAt.set(event.taskId, event.at);
		} else if (event.transition === "accept_handoff" || event.transition === "decline_handoff") {
			const offered = offerAt.get(event.taskId);
			if (offered !== undefined) {
				waiting.push([offered, event.at]);
				if (event.transition === "accept_handoff" && event.at >= from && event.at <= to) offerToAccept.push(event.at - offered);
				offerAt.delete(event.taskId);
			}
			if (event.transition === "accept_handoff") acceptAt.set(event.taskId, event.at);
		} else if (event.transition === "close") {
			const accepted = acceptAt.get(event.taskId);
			if (accepted !== undefined) {
				if (event.at >= from && event.at <= to) acceptToClose.push(event.at - accepted);
				acceptAt.delete(event.taskId);
			}
		}
	}
	for (const start of laneStart.values()) lanes.push([start, to]);
	for (const offered of offerAt.values()) waiting.push([offered, to]);

	const laneMs = lanes.reduce((sum, lane) => sum + overlap(lane, window), 0);
	const waitingInWindow = waiting.map((interval) => [Math.max(interval[0], from), Math.min(interval[1], to)] as Interval).filter((interval) => interval[1] > interval[0]);
	const waitingMs = waitingInWindow.reduce((sum, interval) => sum + (interval[1] - interval[0]), 0);

	const hasRuns = input.metricEvents.some((row) => row.event === "run-start" || row.event === "run-end");
	let parentIdleWithWorkMin: number | undefined;
	if (hasRuns) {
		const runs = runIntervals(input.metricEvents, from, to);
		const idleMs = waitingInWindow.reduce((sum, interval) => sum + (interval[1] - interval[0]) - runs.reduce((covered, run) => covered + overlap(run, interval), 0), 0);
		parentIdleWithWorkMin = round(idleMs / MINUTE);
	}

	const inWindow = input.metricEvents.filter((row) => row.at >= from && row.at <= to);
	const blocks = inWindow.filter((row): row is MetricRow & { event: "edit-block" } => row.event === "edit-block");
	const continuations: Metrics["continuations"] = { admitted: 0, steered: 0, waiting: {}, denied: {}, deferred: 0, unavailable: 0 };
	for (const row of inWindow) {
		if (row.event !== "continuation") continue;
		const outcome: ContinuationDecisionOutcome = row.outcome;
		if (outcome === "waiting" || outcome === "denied") {
			const bucket = continuations[outcome];
			const reason = row.reason ?? "unknown";
			bucket[reason] = (bucket[reason] ?? 0) + 1;
		} else {
			continuations[outcome] += 1;
		}
	}

	return {
		windowMin: round(windowMs / MINUTE),
		ceiling,
		laneMinutes: laneMs / MINUTE,
		avgLiveLanes: laneMs / windowMs,
		occupancy: laneMs / (windowMs * Math.max(1, ceiling)),
		offerToAccept: stat(offerToAccept),
		acceptToClose: stat(acceptToClose),
		waitingMin: round(waitingMs / MINUTE),
		parentIdleWithWorkMin,
		editBlocks: {
			total: blocks.length,
			falseBlocks: blocks.filter((block) => block.holders.length > 0 && block.holders.every((holder) => retired.has(holder))).length,
		},
		continuations,
	};
}

function num(value: number): string {
	return Number(value.toFixed(1)).toString();
}

/** The median, with the count: a few batch closes days late must not set the number. */
function statText(value: Stat | undefined): string {
	return value === undefined ? "none" : `median ${num(value.medianMin)} min (n=${value.count})`;
}

function reasons(counts: Record<string, number>): string {
	const entries = Object.entries(counts);
	return entries.length === 0 ? "" : ` (${entries.map(([reason, count]) => `${reason} ${count}`).join(", ")})`;
}

/** One line, in words: the `/muster status` metrics line and the digest line. */
export function formatMetricsLine(m: Metrics): string {
	const waitingTotal = Object.values(m.continuations.waiting).reduce((sum, count) => sum + count, 0);
	const deniedTotal = Object.values(m.continuations.denied).reduce((sum, count) => sum + count, 0);
	const idle = m.parentIdleWithWorkMin === undefined ? "not measured" : `${num(m.parentIdleWithWorkMin)} min`;
	const blocks = `edit blocks ${m.editBlocks.total}${m.editBlocks.falseBlocks > 0 ? ` (${m.editBlocks.falseBlocks} from retired identities)` : ""}`;
	const continuations =
		`continuations ${m.continuations.admitted} admitted` +
		(m.continuations.steered > 0 ? `, ${m.continuations.steered} steered` : "") +
		(waitingTotal > 0 ? `, ${waitingTotal} waiting${reasons(m.continuations.waiting)}` : "") +
		(deniedTotal > 0 ? `, ${deniedTotal} denied${reasons(m.continuations.denied)}` : "");
	return [
		`lanes ${num(m.avgLiveLanes)} of ${m.ceiling} live on average (${Math.round(m.occupancy * 100)}%)`,
		`offer→accept ${statText(m.offerToAccept)}`,
		`accept→close ${statText(m.acceptToClose)}`,
		`parent idle with work waiting ${idle}`,
		blocks,
		continuations,
	].join(" · ");
}

// ─── Recording without flooding ──────────────────────────────────────────────

/**
 * Decides whether a continuation decision is worth a journal row. The pump
 * retries a held delivery about once a second, so a repeating waiting or denied
 * decision is recorded once per `minGapMs`, a change at once, and every
 * admission always (an admission also ends the episode).
 */
export function createDecisionLimiter(minGapMs = 60_000, now: () => number = Date.now) {
	let last: { key: string; at: number } | undefined;
	return (outcome: string, reason: string | undefined): boolean => {
		if (outcome === "admitted" || outcome === "steered") {
			last = undefined;
			return true;
		}
		const key = `${outcome}:${reason ?? ""}`;
		const at = now();
		if (last !== undefined && last.key === key && at - last.at < minGapMs) return false;
		last = { key, at };
		return true;
	};
}

// ─── Readers ─────────────────────────────────────────────────────────────────

const OUTCOMES = new Set<string>(["admitted", "steered", "waiting", "denied", "deferred", "unavailable"]);

function stringList(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
}

/** Parse one journal line of `session` into a metric row; anything else is ignored. */
function metricRowOf(line: string, session: string): MetricRow | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== "object") return undefined;
	const row = parsed as Record<string, unknown>;
	if (row["type"] !== "metric" || typeof row["at"] !== "string") return undefined;
	const at = Date.parse(row["at"]);
	if (Number.isNaN(at)) return undefined;
	const event = row["event"];
	if (event === "run-start" || event === "run-end") return { event, at, session };
	if (event === "continuation" && typeof row["outcome"] === "string" && OUTCOMES.has(row["outcome"])) {
		return {
			event,
			at,
			session,
			outcome: row["outcome"] as ContinuationDecisionOutcome,
			...(typeof row["reason"] === "string" ? { reason: row["reason"] } : {}),
		};
	}
	if (event === "edit-block") {
		const repoKey = row["repoKey"];
		const taskIds = stringList(row["taskIds"]);
		const holders = stringList(row["holders"]);
		// A block with no repository cannot be attributed to a project.
		if (typeof repoKey === "string" && taskIds !== undefined && holders !== undefined) return { event, at, session, repoKey, taskIds, holders };
	}
	return undefined;
}

/**
 * Which journals count for one project. Parent turns and continuation decisions
 * come only from the sessions that owned the programme: a worker's turn is not
 * the parent running, and another project's session says nothing about this
 * one. A blocked edit is attributed by its repository instead, because lanes
 * and other sessions of the same project block edits too.
 */
export type MetricScope = { sessions: ReadonlySet<string>; repoKey: string };

/** Metric rows of one project from the session journals in a directory, from `fromMs` on, in time order. */
export function readMetricEvents(sessionsDir: string, fromMs: number, scope: MetricScope): MetricRow[] {
	if (!existsSync(sessionsDir)) return [];
	const rows: MetricRow[] = [];
	for (const name of readdirSync(sessionsDir)) {
		if (!name.endsWith(".jsonl")) continue;
		const session = name.slice(0, -".jsonl".length);
		const file = join(sessionsDir, name);
		try {
			// A journal not touched since the window began holds nothing from it.
			if (statSync(file).mtimeMs < fromMs) continue;
			for (const line of readFileSync(file, "utf8").split("\n")) {
				if (line.trim() === "") continue;
				const row = metricRowOf(line, session);
				if (row === undefined || row.at < fromMs) continue;
				if (row.event === "edit-block" ? row.repoKey === scope.repoKey : scope.sessions.has(session)) rows.push(row);
			}
		} catch {
			/* an unreadable journal costs this metric its rows, never the status command */
		}
	}
	return rows.sort((a, b) => a.at - b.at);
}

/**
 * Ownership transitions from a Concord database, read-only, from `fromMs` on.
 * `node:sqlite` is imported on demand: a runtime without it yields no events,
 * and the metrics then report what they could not measure instead of failing.
 */
export async function readOwnershipEvents(dbFile: string, fromMs: number): Promise<OwnershipEvent[]> {
	if (!existsSync(dbFile)) return [];
	try {
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(dbFile, { readOnly: true });
		try {
			const rows = db
				.prepare("SELECT task_id, transition, actor_agent_id, to_agent_id, from_status, to_status, created_at FROM task_ownership_events WHERE created_at >= ? ORDER BY id")
				.all(new Date(fromMs).toISOString()) as Array<{
				task_id: string;
				transition: string;
				actor_agent_id: string;
				to_agent_id: string | null;
				from_status: string;
				to_status: string;
				created_at: string;
			}>;
			return rows.map((row) => ({
				taskId: row.task_id,
				transition: row.transition,
				at: Date.parse(row.created_at),
				actorAgentId: row.actor_agent_id,
				...(row.to_agent_id !== null ? { toAgentId: row.to_agent_id } : {}),
				fromStatus: row.from_status,
				toStatus: row.to_status,
			}));
		} finally {
			db.close();
		}
	} catch {
		return [];
	}
}
