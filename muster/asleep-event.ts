/**
 * The ASLEEP event (lifecycle LD25). A message queued for a worker lane whose process is gone has no
 * reader, and a Henry or tick sender's ask would go nowhere. One `ASLEEP: <lane> | ...` line on the
 * orchestrator's events file wakes the orchestrator, which decides whether to run `muster resume`.
 *
 * Called from the one send wiring (`laneSendDeps`, send-deps.ts) when `deliverLaneMessage` reports an
 * asleep recipient. The lane is never touched: this writes one event line and one timestamp. At most one
 * line per lane per `ASLEEP_REPEAT_MS`, kept in a timestamp map beside the duplicate guard's, so the lane's
 * card and record stay byte-identical (the LD16 proof). A conversation session (LD14), the operator's own session
 * (LD2) and a seat holder (LD24) never raise it: their messages wait for the next open.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LaneOrigin } from "./lib/lane-card.ts";
import { appendOrchestratorEvent, formatEventLine } from "./lane-report.ts";
import { readLaneRecord, sessionUntouchable } from "./lane-lifecycle.ts";

/** A lane that raised ASLEEP stays quiet this long, however many messages queue for it. */
export const ASLEEP_REPEAT_MS = 30 * 60_000;

export function asleepRaisedFile(musterStateDir: string): string {
	return join(musterStateDir, "asleep-raised.json");
}

/** Lane to the time it last raised ASLEEP. An absent or unreadable file is "none". */
export function readAsleepRaised(musterStateDir: string): Record<string, number> {
	try {
		const file = asleepRaisedFile(musterStateDir);
		if (!existsSync(file)) return {};
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
	} catch {
		return {};
	}
}

/** Remember a raise. Entries past the window are dropped on the way, so the file stays small. */
function markAsleepRaised(musterStateDir: string, lane: string, at: number): void {
	const kept = Object.fromEntries(Object.entries(readAsleepRaised(musterStateDir)).filter(([, raisedAt]) => at - raisedAt < ASLEEP_REPEAT_MS));
	const file = asleepRaisedFile(musterStateDir);
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify({ ...kept, [lane]: at }, null, 2), { mode: 0o600 });
	renameSync(tmp, file);
}

export interface AsleepEventInput {
	/** The muster state dir (the events file sits beside it). */
	stateDir: string;
	laneId: string;
	/** Who sent the queued message. */
	from: string;
	why: string;
	now: Date;
	/** The registry row (origin) and the `claude agents` row (kind) `sessionUntouchable` reads. */
	sessionRows?: { registryRow?: { origin?: LaneOrigin }; agentsRow?: { kind?: string } };
	/** Does this lane hold a seat (LD24)? The one call site for the seat predicate. */
	holdsSeat: (laneId: string) => boolean;
}

/**
 * Append one ASLEEP line when the lane may raise it. True when a line was written. The orchestrator's own
 * sends never raise it (it reads the outcome text), a lane with no record or in a terminal phase has nothing
 * to wake (a merged lane is a new lane, LD26), and a failed append is retried by the next message.
 */
export function raiseAsleepEvent(input: AsleepEventInput): boolean {
	if (input.from === "orchestrator") return false;
	if (sessionUntouchable({ stateDir: input.stateDir, laneId: input.laneId, ...input.sessionRows }) !== undefined) return false;
	if (input.holdsSeat(input.laneId)) return false;
	const record = readLaneRecord(input.stateDir, input.laneId);
	if (record === undefined || record.phase === "merged" || record.phase === "abandoned" || record.phase === "closed") return false;
	const at = input.now.getTime();
	const last = readAsleepRaised(input.stateDir)[input.laneId];
	if (last !== undefined && at - last < ASLEEP_REPEAT_MS) return false;
	const line = formatEventLine("ASLEEP", input.laneId, `a message from ${input.from} is queued for the asleep lane (${input.why}); wake it with \`muster resume ${input.laneId}\``);
	if (!appendOrchestratorEvent(input.stateDir, line, input.now)) return false;
	markAsleepRaised(input.stateDir, input.laneId, at);
	return true;
}
