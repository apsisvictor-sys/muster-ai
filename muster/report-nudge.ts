/**
 * The report nudge (LD7): a lane that ends a turn without having filed a report
 * is asked once to file one.
 *
 * One owner of the text, of the rule and of the "once per work cycle" mark. The
 * Claude `Stop` hook (`cli/claude-hook.ts`) and the Pi `agent_end` handler
 * (`lane-card-adapter.ts`) both ask this module and only deliver the answer in
 * their own way. A work cycle is one launch or one resume: a report filed before
 * the cycle began belongs to an earlier cycle, so a lane resumed with review
 * feedback is asked again if it ends its turn without reporting.
 *
 * Not nudged: the orchestrator address, a seat holder (LD24), the operator's own sessions (`operator:` rows), a
 * `conversation` lane (LD14: a design or product session in talk with the operator,
 * `isConversationLane` in `lane-lifecycle.ts`), a lane
 * that has already reported in this cycle (any kind but `working`, which is a
 * progress line and not an ending), and a lane already nudged in this cycle. A
 * lane that stays silent after its nudge is the tick's 30-minute STALLED event.
 */

import { readLaneCard, writeLaneCard, type LaneReportMark } from "./lib/lane-card.ts";
import { ORCHESTRATOR_ADDRESS } from "./lane-report.ts";
import { seatHeldBy, type SeatContext } from "./seats.ts";

/** The words both harnesses deliver. */
export const REPORT_NUDGE_TEXT =
	'Before you stop, file your report: muster report review_ready --summary … --branch … --sha …, or muster report blocked "<reason>" --needs "<what>".';

/** What the rule reads. A `LaneCard` satisfies it; the Pi adapter passes its own in-process values. */
export interface ReportNudgeFacts {
	lastReport?: LaneReportMark | undefined;
	cycleStartedAt?: number | undefined;
	reportNudgedAt?: number | undefined;
	/** A conversation session (LD14): never asked for a report. The caller reads it with `isConversationLane`. */
	conversation?: boolean | undefined;
}

/**
 * A lane the bus never nudges, whatever it does: the orchestrator address, the session that holds a seat, and rows
 * that are the operator's own sessions. The waiter and open-tab nudges use this alone; only the report nudge also spares a
 * conversation lane. `seats` says where the seat files are (default: this installation's state dir).
 */
export function reportNudgeExempt(laneId: string, seats?: SeatContext): boolean {
	return laneId === ORCHESTRATOR_ADDRESS || seatHeldBy(laneId, seats) !== undefined || laneId.startsWith("operator:");
}

/** Has the lane filed an ending report since its cycle began? */
export function reportedThisCycle(facts: ReportNudgeFacts): boolean {
	const report = facts.lastReport;
	if (report === undefined || report.kind === "working") return false;
	return (report.at ?? 0) >= (facts.cycleStartedAt ?? 0);
}

/** Should the turn end be answered with the nudge? */
export function reportNudgeDue(laneId: string, facts: ReportNudgeFacts | undefined, seats?: SeatContext): boolean {
	if (facts === undefined || reportNudgeExempt(laneId, seats) || facts.conversation === true || reportedThisCycle(facts)) return false;
	const nudgedAt = facts.reportNudgedAt;
	return nudgedAt === undefined || nudgedAt < (facts.cycleStartedAt ?? 0);
}

/** Record on the lane's card that this cycle's nudge was delivered. False when the lane has no card. */
export function markReportNudged(stateDir: string, laneId: string, now: number): boolean {
	const card = readLaneCard(stateDir, laneId);
	if (card === undefined) return false;
	writeLaneCard(stateDir, { ...card, reportNudgedAt: now });
	return true;
}
