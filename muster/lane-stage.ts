/**
 * The lane stage and health owner — command-center blueprint Revision 7, D26.
 *
 * "Where the lane stands" (stage) and "how it is doing" (health) are two vocabularies, kept apart
 * because a blocked lane in Sent back must show both. One owner, so the composer, the change lines
 * (D31) and History cannot invent a second answer.
 *
 * Runtime leaf (plan correction C1): `lib/lane-card.ts` imports `lane-lifecycle.ts` at runtime, and
 * `lane-lifecycle.ts` imports `lib/lane-card.ts` for types only to avoid that cycle. This module
 * imports both as types only and takes the latest report as an input the caller computes with
 * `newerLaneReport`, so it adds no edge to either side.
 */

import type { LanePhase, LaneRecord } from "./lane-lifecycle.ts";
import type { LaneReportMark, LaneState } from "./lib/lane-card.ts";

/** The six stages a lane on the board sits in, in board order (D26). */
export const LANE_STAGES = ["assigning", "working", "verifying", "sent-back", "waiting-to-merge", "merged"] as const;
export type LaneStage = (typeof LANE_STAGES)[number];

/** The stages a worker lane still has work in front of it for: on the board and not through review (D26). */
export const LANE_WORKING_STAGES: readonly LaneStage[] = ["assigning", "working", "sent-back"];

/** The stage a review's fix round leaves the lane in, named so no reader spells the key itself. */
export const LANE_STAGE_SENT_BACK: LaneStage = "sent-back";

/** The stage an accepted lane sits in until its work merges. */
export const LANE_STAGE_WAITING_TO_MERGE: LaneStage = "waiting-to-merge";

/** The two values that take a lane off the board and into History (D26 rules 2 and 3). */
export const LANE_OFF_BOARD = ["abandoned", "closed"] as const;
export type LaneStageOrOff = LaneStage | (typeof LANE_OFF_BOARD)[number];

/** The one place a stage becomes words. The composer and the page read this, never their own map. */
export const LANE_STAGE_LABELS: Record<LaneStageOrOff, string> = {
	assigning: "Assigning",
	working: "Working",
	verifying: "Verifying",
	"sent-back": "Sent back",
	"waiting-to-merge": "Waiting to merge",
	merged: "Merged",
	abandoned: "Abandoned",
	closed: "Closed",
};

/** How a lane is doing (D26), independent of its stage. */
export const LANE_HEALTH = ["ok", "stalled", "quota-walled", "blocked", "question", "gone", "leftover"] as const;
export type LaneHealth = (typeof LANE_HEALTH)[number];

/** The one place a health value becomes words; a tone is D7's attention tone for every value but `ok`. */
export const LANE_HEALTH_LABELS: Record<LaneHealth, string> = {
	ok: "On track",
	stalled: "Stalled",
	"quota-walled": "Walled",
	blocked: "Blocked",
	question: "Asks a question",
	gone: "Ended without a report",
	leftover: "Closed, still running",
};

/** The orchestrator's verdict on a handoff (D27). `by` is narrowed to `GoalWriter` at the writer. */
export const HANDOFF_VERDICTS = ["sent-back", "accepted"] as const;
export type HandoffVerdict = (typeof HANDOFF_VERDICTS)[number];
export type LaneHandoff = { at: number; by: string; verdict: HandoffVerdict; cause?: string; sha?: string; waits?: string };

/** What a stage decision needs: the record's phase, terminal fact, launch time and handoffs, the newest report and the row's transcript turn. */
export type StageInput = {
	record: Pick<LaneRecord, "phase" | "terminal" | "launchedAt"> & { handoffs?: readonly LaneHandoff[] };
	latestReport: LaneReportMark | undefined;
	lastTurnAt: number | null | undefined;
};

/** The review kinds: a report of one of these, newer than the latest handoff, puts the lane in Verifying (D26 rules 4 and 5). */
const REVIEW_KINDS: readonly string[] = ["review_ready", "discovery_ready", "already_done"];

const latestOf = (handoffs: readonly LaneHandoff[] | undefined): LaneHandoff | undefined =>
	handoffs === undefined || handoffs.length === 0 ? undefined : handoffs[handoffs.length - 1];

const atOf = (mark: LaneReportMark): number => mark.at ?? 0;

/**
 * The stage, in D26's order: the terminal fact, then the handoffs and reports, then the transcript turn.
 *
 * `alreadyDone` is a flag beside the stage, never a stage: a lane that reported `already_done` shows
 * "Already done" wherever it sits, and its close files it under Merged or off the board by its outcome.
 */
export function laneStage(input: StageInput): { stage: LaneStageOrOff; alreadyDone: boolean } {
	const { record, latestReport, lastTurnAt } = input;
	const handoff = latestOf(record.handoffs);
	const outcome = record.terminal?.outcome;
	const alreadyDone = latestReport?.kind === "already_done";

	// 1. Merged. 2. Abandoned. A terminal fact wins over the phase it was written with.
	if (outcome === "merged" || record.phase === "merged") return { stage: "merged", alreadyDone };
	if (outcome === "abandoned" || record.phase === "abandoned") return { stage: "abandoned", alreadyDone };
	// 3. Closed with no terminal fact: only a record written before closeLane stored one.
	if (record.phase === "closed") return { stage: "closed", alreadyDone };

	// 4. Accepted, and no report newer than the handoff: the work waits for the merger.
	if (handoff?.verdict === "accepted" && (latestReport === undefined || atOf(latestReport) <= handoff.at)) {
		return { stage: "waiting-to-merge", alreadyDone };
	}
	// 5. A review report newer than the latest handoff. A parked lane stays here: the rules never read the phase.
	const reviewing = latestReport !== undefined && REVIEW_KINDS.includes(latestReport.kind);
	if (reviewing && (handoff === undefined || atOf(latestReport) > handoff.at)) return { stage: "verifying", alreadyDone };
	// 6. Sent back and nothing reviewed since. Working, blocked and question reports keep the lane here.
	if (handoff?.verdict === "sent-back") return { stage: "sent-back", alreadyDone };
	// 7. No report, and no transcript turn after the launch. D26/Q3: `lastTurnAt` only, never the activity
	//    stamp, which a Claude hook writes on every event and which the row falls back to `since` for.
	if (latestReport === undefined && (lastTurnAt === null || lastTurnAt === undefined || lastTurnAt <= record.launchedAt)) {
		return { stage: "assigning", alreadyDone };
	}
	// 8.
	return { stage: "working", alreadyDone };
}

/**
 * How the lane is doing, from the card state and the latest report — never from the phase alone.
 *
 * The tick parks a blocked or question lane after 30 minutes and parking removes the card, so the
 * phase cannot carry the answer (D26, Q2): a parked lane's row says `gone`, and its report gives the health.
 * R1 (VR24-165): a report gives that health only while the record has no terminal fact, so a closed lane's
 * old report never overrides the leftover test, which is what a closed lane with a live scope is.
 */
export function laneHealth(input: {
	cardState: LaneState | undefined;
	phase: LanePhase | undefined;
	terminal: boolean;
	latestReport: LaneReportMark | undefined;
	handoffs?: readonly LaneHandoff[];
	leftover: boolean;
}): LaneHealth {
	const { cardState, phase, terminal, latestReport, handoffs, leftover } = input;
	if (cardState === "stalled" || cardState === "quota-walled" || cardState === "blocked") return cardState;
	// R1: the report speaks only while the record has no terminal fact.
	if (!terminal && latestReport !== undefined && (latestReport.kind === "blocked" || latestReport.kind === "question")) {
		const handoff = latestOf(handoffs);
		if (handoff === undefined || atOf(latestReport) > handoff.at) return latestReport.kind;
	}
	// Q2: parking removes the card, so a parked lane's directory row says gone while the lane is on the board.
	if (cardState === "gone" && !terminal && phase !== "parked") return "gone";
	if (leftover) return "leftover";
	return "ok";
}

/** The rounds a lane has run: every `sent-back` handoff on the record (D27). */
export function roundsOf(handoffs?: readonly LaneHandoff[]): number {
	if (handoffs === undefined) return 0;
	let rounds = 0;
	for (const handoff of handoffs) if (handoff.verdict === "sent-back") rounds += 1;
	return rounds;
}
