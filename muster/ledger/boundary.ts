/**
 * The boundary (LC2, §3.3): DL6 applied once per process, and the spool's replay.
 *
 * LC-D4: owners fail closed — a read that cannot reach `musterd` throws, it never
 * answers "absent" — and each process boundary turns that one class of failure
 * into its own honest outcome: a hook that lets the turn continue, a CLI that
 * exits 75 with one line, a gateway tool that hands the model the reason, an
 * OpenCode host loop that logs and carries on, a tick pass that stops with one
 * line. Every other error is rethrown exactly as before, so this changes nothing
 * while `state/muster/backend.json` is absent (files mode).
 *
 * The spool's other half lives here too (§3.2): the two owners of one-time
 * signals (`recordLaneReport`, `appendOrchestratorEvent`) write their own input
 * to `<musterStateDir>/spool/` when the store is unavailable, and `replaySpool`
 * puts those records back through those same owners, outside `musterd`.
 *
 * Node builtins plus the owners it calls: the Claude hook bundle already loads
 * `lib/lane-card.ts` and `lane-report.ts`, so this adds no weight to it.
 */

import { isLaneReportMark, recordLaneReport } from "../lib/lane-card.ts";
import { appendOrchestratorEvent } from "../lane-report.ts";
import { MusterFrozen } from "./backend.ts";
import { MusterdUnreachable } from "./client.ts";
import { readSpool, removeSpoolFile } from "./spool.ts";

export type BoundaryKind = "hook" | "cli" | "tick" | "gateway";

/** The reason text for MusterdUnreachable or MusterFrozen, else undefined. */
export function boundaryReason(error: unknown): string | undefined {
	if (error instanceof MusterdUnreachable || error instanceof MusterFrozen) return error.message;
	return undefined;
}

/** Epoch ms of the last line each boundary name logged; the text comes from the owner that threw. */
const lastLogAt = new Map<string, number>();

/** One line per boundary name a minute: a store that is down for hours must not fill a hook log. */
function logBoundary(name: string, reason: string): void {
	const now = Date.now();
	if (now - (lastLogAt.get(name) ?? 0) < 60_000) return;
	lastLogAt.set(name, now);
	process.stderr.write(`muster: ${name}: ${reason}\n`);
}

/** Hooks and Pi extension handlers: runs fn. On a boundary error returns `fallback` and logs at most once a minute. Other errors are rethrown. */
export function atBoundary<T>(name: string, fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch (error) {
		const reason = boundaryReason(error);
		if (reason === undefined) throw error;
		logBoundary(name, reason);
		return fallback;
	}
}

/**
 * CLI, gateway and the OpenCode host: the same for async work. A CLI prints the
 * reason and resolves 75, because a verb that cannot reach its store must not
 * look like a success or like the verb's own refusal. A gateway tool resolves
 * the reason as its error text. The host logs at most once a minute and resolves
 * `fallback`. Any other error is rethrown.
 */
export async function atBoundaryAsync<T>(kind: "cli" | "gateway" | "host", name: string, fn: () => Promise<T>, fallback: T): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		const reason = boundaryReason(error);
		if (reason === undefined) throw error;
		if (kind === "cli") {
			process.stderr.write(`muster: ${name}: ${reason}\n`);
			return 75 as T;
		}
		if (kind === "gateway") return reason as unknown as T;
		logBoundary(name, reason);
		return fallback;
	}
}

/**
 * The signal one spool file holds: §3.2's own record, or the same record inside
 * the `params` of the method envelope the landed spool writer uses. A record
 * with no owner field stays for a later pass rather than being dropped.
 */
function spoolSignal(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	const params = record["params"];
	if (typeof params === "object" && params !== null && (params as Record<string, unknown>)["owner"] !== undefined) {
		return params as Record<string, unknown>;
	}
	return record;
}

/**
 * Replay the spool through the owners (§3.2, LC-D4).
 *
 * A one-time signal that could not be written waits in `<stateDir>/spool/`; this
 * runs outside `musterd` (a ledger-mode tick pass, and the flip tool at the end
 * of `flip`, `abort` and `rollback`) and calls the owner that wrote the record,
 * which writes to whichever backend is current. The owner derives its request id
 * from the same input every time, so a replay of an already-committed signal
 * writes nothing, and its own backend rule decides whether the write lands or is
 * spooled again (that second case keeps the file).
 *
 * Returns how many records were replayed. A record this version cannot read —
 * another owner's shape, a torn file, or a report whose lane has no card yet —
 * stays in the spool for a later pass rather than being dropped.
 */
export function replaySpool(musterStateDir: string): number {
	let replayed = 0;
	for (const { path, req } of readSpool(musterStateDir)) {
		const signal = spoolSignal(req);
		if (signal === undefined) continue;
		if (signal["owner"] === "event" && typeof signal["line"] === "string") {
			const at = typeof signal["at"] === "number" && Number.isFinite(signal["at"]) ? new Date(signal["at"]) : new Date();
			if (appendOrchestratorEvent(musterStateDir, signal["line"], at) === true) {
				removeSpoolFile(path);
				replayed += 1;
			}
			continue;
		}
		if (signal["owner"] === "report" && typeof signal["laneId"] === "string" && isLaneReportMark(signal["mark"])) {
			if (recordLaneReport(musterStateDir, signal["laneId"], signal["mark"]) === true) {
				removeSpoolFile(path);
				replayed += 1;
			}
		}
	}
	return replayed;
}
