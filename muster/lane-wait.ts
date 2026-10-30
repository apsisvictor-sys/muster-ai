/**
 * Lane-card wait — acceptance check 4.
 *
 * The orchestrator's watcher needs to stop parsing pane text: `muster wait
 * --lanes` reads the lane cards and returns on the first thing a lane says that
 * needs the caller — a `REVIEW READY`, `BLOCKED` or `question` report filed
 * after the wait began, or a lane that became `stalled` or `gone`.
 *
 * It reads and reports only: no Concord, no TUI, no lane is touched. A report
 * that was already on the card before the wait started is not an event, so the
 * same line never wakes the orchestrator twice.
 */

import type { LaneCard, LaneState } from "./lib/lane-card.ts";

/** The report kinds that need a human or an orchestrator. */
export const WAIT_REPORT_KINDS = ["review_ready", "blocked", "question"] as const;

export type LaneWaitEventKind = "report" | "stalled" | "gone";

export interface LaneWaitEvent {
	kind: LaneWaitEventKind;
	laneId: string;
	detail: string;
}

export interface LaneWaitResult {
	events: LaneWaitEvent[];
	timedOut: boolean;
	aborted: boolean;
	elapsedMs: number;
	polls: number;
}

export interface LaneWaitOptions {
	/** Read the cards (usually `enumerateLanes`). */
	read: () => LaneCard[];
	timeoutMs: number;
	pollMs?: number;
	/** Restrict to these lanes. */
	laneIds?: readonly string[];
	signal?: AbortSignal;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export const LANE_WAIT_DEFAULT_POLL_MS = 2_000;

function stateOf(card: LaneCard): LaneState {
	return card.state;
}

/** Events in one poll, against the baseline taken when the wait began. */
function eventsSince(
	cards: readonly LaneCard[],
	baselineReports: Map<string, number>,
	baselineStates: Map<string, LaneState>,
): LaneWaitEvent[] {
	const events: LaneWaitEvent[] = [];
	for (const card of cards) {
		const report = card.lastReport;
		const before = baselineReports.get(card.laneId);
		if (
			report !== undefined &&
			(WAIT_REPORT_KINDS as readonly string[]).includes(report.kind) &&
			typeof report.at === "number" &&
			(before === undefined || report.at > before)
		) {
			events.push({ kind: "report", laneId: card.laneId, detail: report.summary });
			continue;
		}
		const state = stateOf(card);
		const previous = baselineStates.get(card.laneId);
		if ((state === "stalled" || state === "gone") && previous !== undefined && previous !== state) {
			events.push({ kind: state, laneId: card.laneId, detail: state === "stalled" ? "no heartbeat past the stalled threshold" : "the lane is gone" });
		}
	}
	return events;
}

/**
 * Wait for the first lane event. Resolution order in one poll: reports first
 * (they are the orchestrator's work), then stalled, then gone.
 */
export async function waitOnLaneCards(opts: LaneWaitOptions): Promise<LaneWaitResult> {
	const now = opts.now ?? (() => Date.now());
	// Not unref'd: this timer is the only thing keeping a waiting CLI alive, and
	// an unref'd sleep lets node exit 0 with no answer at all (found in the CLI
	// test for check 4: the process returned before the first poll).
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
	const pollMs = Math.max(50, opts.pollMs ?? LANE_WAIT_DEFAULT_POLL_MS);
	const filter = opts.laneIds === undefined || opts.laneIds.length === 0 ? undefined : new Set(opts.laneIds);
	const started = now();
	const baselineReports = new Map<string, number>();
	const baselineStates = new Map<string, LaneState>();
	let polls = 0;

	const visible = (cards: readonly LaneCard[]): LaneCard[] => (filter === undefined ? [...cards] : cards.filter((card) => filter.has(card.laneId)));

	// Baseline: what was already true when the wait began is not an event.
	const first = visible(opts.read());
	for (const card of first) {
		baselineReports.set(card.laneId, card.lastReport?.at ?? 0);
		baselineStates.set(card.laneId, stateOf(card));
	}
	polls += 1;
	const immediate = eventsSince(first, baselineReports, baselineStates);
	if (immediate.length > 0) return { events: immediate, timedOut: false, aborted: false, elapsedMs: now() - started, polls };

	while (now() - started < opts.timeoutMs) {
		if (opts.signal?.aborted === true) return { events: [], timedOut: false, aborted: true, elapsedMs: now() - started, polls };
		await sleep(pollMs);
		if (opts.signal?.aborted === true) return { events: [], timedOut: false, aborted: true, elapsedMs: now() - started, polls };
		const cards = visible(opts.read());
		polls += 1;
		// A lane that appears during the wait starts from its own first observation.
		for (const card of cards) {
			if (!baselineReports.has(card.laneId)) baselineReports.set(card.laneId, card.lastReport?.at ?? 0);
			if (!baselineStates.has(card.laneId)) baselineStates.set(card.laneId, stateOf(card));
		}
		const events = eventsSince(cards, baselineReports, baselineStates);
		if (events.length > 0) return { events, timedOut: false, aborted: false, elapsedMs: now() - started, polls };
	}
	return { events: [], timedOut: true, aborted: false, elapsedMs: now() - started, polls };
}

export function formatLaneWaitResult(result: LaneWaitResult): string {
	if (result.aborted) return `muster wait: aborted after ${Math.round(result.elapsedMs / 1000)}s`;
	if (result.events.length === 0) return `muster wait: nothing needs you (${Math.round(result.elapsedMs / 1000)}s, ${result.polls} polls)`;
	return result.events.map((event) => `muster wait: ${event.laneId} ${event.kind}: ${event.detail}`).join("\n");
}
