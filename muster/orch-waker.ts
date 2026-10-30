/**
 * The orchestrator waker (WAKE1, Henry via the operator 2026-10-29 03:29).
 *
 * The seat's one wake path. A long-lived process (`bin/muster-orch-waker.mts`, the
 * `muster-orch-waker` systemd user unit) blocks on the ledger's event lines and the
 * orchestrator's bus inbox, and never exits after a batch: it hands what it read to
 * the send owner in `wake` mode, which writes one message the seat's own Pi session
 * reads (`inbox-wake.ts` in the session, a follow-up with `triggerTurn`). Then it
 * proves the seat took a turn, and only what that ladder cannot fix is escalated.
 *
 * The ladder, in the brief's order:
 *
 *   1. deliver once, and wait for a turn inside PROOF_WINDOW_MS;
 *   2. not proved: deliver once more, and wait again;
 *   3. not proved: ask the existing parked-lane resume for the seat, and wait again;
 *   4. not proved: ONE Henry-mailbox issue per outage, and at most one alert an hour
 *      across outages (ALERT_REPEAT_MS). Nothing else is paged: Discord is not on this
 *      route at all (the operator, 2026-10-29 22:24).
 *
 * "A turn" is the lane directory's own clock for the seat's session (`lastTurnAt`),
 * never a file's mtime and never a byte count: the transcript is rewritten for
 * reasons other than turns. A seat whose transcript says it is mid-turn (`busy`)
 * reads a queued follow-up at that turn's boundary, so its proof window is the
 * longer BUSY_PROOF_WINDOW_MS rather than a false outage.
 *
 * This module is the policy. The machine (systemd, the CLI, the ledger, the seat
 * file, the transcript reader) is wired in `bin/muster-orch-waker.mts`, so a test
 * runs the whole ladder with a fake clock and no process.
 */

import { EVENT_KINDS } from "./lane-report.ts";

/** The unit the tick watches. One name, in the unit file, the waker and the watchdog. */
export const WAKER_UNIT = "muster-orch-waker.service";
/** The sender every message and alert from this process carries. */
export const WAKER_ACTOR = "muster-orch-waker";
/** The newest turn must land inside this window after a delivery, for an idle seat. */
export const PROOF_WINDOW_MS = 3 * 60_000;
/** A seat that was already mid-turn reads a queued follow-up at its boundary; that is not an outage yet. */
export const BUSY_PROOF_WINDOW_MS = 15 * 60_000;
/** One alert an hour at most, whichever outage it is about. */
export const ALERT_REPEAT_MS = 3_600_000;
/** How often the proof loop looks at the seat's turn. */
export const PROOF_POLL_MS = 10_000;
/** How long one `muster wait --events` blocks before the loop reads the inbox again. */
export const EVENT_WAIT_S = 30;
/** The most event lines one delivered message carries; the rest wait in the inbox and the store. */
export const MAX_BATCH_LINES = 40;
/** How much of the delivery text one event line may take. */
export const MAX_LINE_CHARS = 400;
/** The waker's own marks, beside the ledger switch: one file, replace-only. */
export const WAKER_STATE_FILE = "orch-waker.json";

/**
 * The lines the seat acts on. `STALE:` joins the eight event kinds for the seat's old
 * waiter; the waker reads the same stream and the same kinds, so nothing that woke the
 * seat before stops waking it.
 */
export const WAKER_KINDS: readonly string[] = [...EVENT_KINDS, "STALE"];

/** The seat as the seat owner describes it. `sessionId` is the process the proof watches. `laneId` on a delivery is the role inbox, not this id. */
export type WakerSeat = { laneId: string; sessionId: string; harness: string; epoch: number };

/** The one mailbox for the orchestrator seat. It does not move with the holder. */
export const ORCHESTRATOR_INBOX = "orchestrator";

/** Where a wake is written. The proof still watches `sessionId`; the mailbox is the role. */
export function deliveryTarget(seat: WakerSeat | undefined): WakerSeat {
	const base = seat ?? { laneId: ORCHESTRATOR_INBOX, sessionId: ORCHESTRATOR_INBOX, harness: "unknown", epoch: 0 };
	return { ...base, laneId: ORCHESTRATOR_INBOX };
}

/** One pending inbox message, as the inbox owner lists it. */
export type WakerInboxMessage = { id: string; at: string; from: string; text: string };

/** The seat's turn clock and whether a turn is in progress. */
export type WakerTurn = { lastTurnAt: number | undefined; busy: boolean };

/** What one delivery answered. The send owner's words, never a second verdict. */
export type WakerDelivery = { ok: boolean; detail: string };

/** The parked-lane resume's answer (`parkedLaneResume`), passed through unchanged. */
export type WakerResume = { state: "resumed" | "not-parked" | "inbox-only" | "failed"; detail: string };

/** The waker's own marks: the outage in hand and the last alert that went out. */
export type WakerMarks = {
	/** Identifies the outage the last alert was about: `<epoch>:<sessionId>`. */
	outageKey?: string;
	/** When the outage in hand started (epoch ms). */
	outageStartedAt?: number;
	/** When the last alert actually went out (epoch ms). Never set by a failed alert. */
	lastAlertAt?: number;
	/** When a delivery was last proved by a turn (epoch ms): the seat answered. */
	provenAt?: number;
	/** When the last delivery was made (epoch ms). */
	lastDeliveryAt?: number;
};

export type WakerDeps = {
	/**
	 * The stop signal: systemd's `stop` aborts it.
	 *
	 * Every wait in here yields to the event loop, so a blocked thread can never hold the
	 * process past the unit's stop timeout (rev4's W1).
	 */
	signal: AbortSignal;
	/** The orchestrator seat, or undefined while it was never claimed. */
	seat(): WakerSeat | undefined;
	/** The orchestrator inbox's pending messages. Listing never moves one. */
	inbox(): readonly WakerInboxMessage[];
	/** Move inbox messages the delivered text carried into `read/`, after the delivery. */
	markInboxRead(ids: readonly string[]): void;
	/**
	 * The next event lines: blocks up to `waitSeconds`, then answers with what arrived.
	 *
	 * The wait yields: a thread that blocks cannot see a stop signal, so the owner reads the
	 * store in a way that hands the event loop back while it waits.
	 */
	events(waitSeconds: number): Promise<readonly string[]>;
	/** Deliver one message into the seat: `muster send <seat> --mode wake` (the seat's own poll turns it into a turn). It yields, so a stop is seen while it sends. */
	deliver(seat: WakerSeat, text: string, idempotencyKey: string): Promise<WakerDelivery>;
	/** The seat's turn clock, from the lane directory. It yields, so a stop is seen while it reads. */
	turn(): Promise<WakerTurn>;
	/** Relaunch a parked seat through the existing parked-lane resume. */
	resume(seat: WakerSeat, text: string): Promise<WakerResume>;
	/** Henry's mailbox issue, through the send owner that batches it. The only alert this process sends. */
	alertHenry(text: string, idempotencyKey: string): void;
	marks(): WakerMarks;
	saveMarks(marks: WakerMarks): void;
	now(): number;
	/** Wait, and return at once when the process is asked to stop: a stop never waits for the next poll, and the timer is cleared, so the process can end at once. */
	sleep(ms: number): Promise<void>;
	log(line: string): void;
};

/**
 * One trigger: the event lines the waker read and the inbox messages it is carrying.
 *
 * The messages travel with the batch because their inbox copies are marked read once the delivery is
 * made: a delivery that named only their count would destroy them unread.
 */
export type WakerBatch = { lines: string[]; messages: WakerInboxMessage[] };

/** What one wake attempt ended as. */
export type WakerOutcome =
	| { kind: "proved"; deliveries: number; afterResume: boolean }
	| { kind: "alerted"; deliveries: number; attempts: string[] }
	| { kind: "alert-failed"; detail: string }
	| { kind: "alert-held"; detail: string }
	| { kind: "stopped"; detail: string };

/** The event kinds the waker reads, and only those. A `WORKING:` line wakes nobody. */
export function isWakeLine(line: string): boolean {
	// Event lines carry `date -Iseconds` first; a bare line (a test, another producer) is read as it stands.
	const body = line.replace(/^\d{4}-\d\d-\d\dT[^\s]+\s+/, "");
	return WAKER_KINDS.some((kind) => body.startsWith(`${kind}:`));
}

/** Keep only wake lines, one of each kind per lane, cut to a readable length. */
export function selectLines(lines: readonly string[], limit = MAX_BATCH_LINES): string[] {
	const kept: string[] = [];
	const seen = new Set<string>();
	for (const raw of lines) {
		const line = raw.trim();
		if (line === "" || !isWakeLine(line)) continue;
		if (seen.has(line)) continue;
		seen.add(line);
		kept.push(line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}...` : line);
		if (kept.length >= limit) break;
	}
	return kept;
}

/**
 * The inbox messages that are a wake in themselves: a sender other than this process
 * (its own delivered message is not a new trigger) and a lane the waker does not read
 * back. Everything else is carried by the event line of the same report.
 */
export function inboxTrigger(messages: readonly WakerInboxMessage[]): WakerInboxMessage[] {
	return messages.filter((message) => message.from !== WAKER_ACTOR);
}

/** One batch from what the loop read; undefined when nothing needs the seat. */
export function batchOf(events: readonly string[], inbox: readonly WakerInboxMessage[], limit = MAX_BATCH_LINES): WakerBatch | undefined {
	const lines = selectLines(events, limit);
	const trigger = inboxTrigger(inbox);
	if (lines.length === 0 && trigger.length === 0) return undefined;
	return {
		lines,
		// Every pending message travels in the delivery, and is marked read once it is carried, so the
		// seat is not handed the same text again by its own poll.
		messages: trigger,
	};
}

/** One inbox message as the delivered text carries it: who sent it and what they said, bounded. */
function messageLine(message: WakerInboxMessage): string {
	const body = message.text.replace(/\s*[\r\n]+\s*/g, " ").trim();
	const cut = body.length > MAX_LINE_CHARS ? `${body.slice(0, MAX_LINE_CHARS)}...` : body;
	return `MESSAGE: ${message.from} | ${cut}`;
}

/**
 * The one message the seat reads: the event lines and the inbox messages themselves, so the
 * delivery stands on its own (their inbox copies are marked read once this is delivered). Named
 * `WAKE` so a reader, and the proof log, can tell a waker batch from a lane report.
 */
export function wakerText(batch: WakerBatch, since: number | undefined): string {
	const parts = [`WAKE: ${batch.lines.length + batch.messages.length} item(s) for the orchestrator${since === undefined ? "" : ` since ${new Date(since).toISOString()}`}`];
	if (batch.lines.length > 0) parts.push(batch.lines.join("\n"));
	if (batch.messages.length > 0) parts.push(batch.messages.map(messageLine).join("\n"));
	parts.push("Read your inbox for anything newer, then continue the programme.");
	return parts.join("\n");
}

/** The outage a delivery attempt belongs to: a new seat holding is a new outage. */
export function outageKey(seat: WakerSeat | undefined): string {
	return seat === undefined ? "unseated" : `${seat.epoch}:${seat.sessionId}`;
}

/** An alert may go out when none ever did, or the last one is an hour old. */
export function alertAllowed(marks: WakerMarks, now: number): boolean {
	return marks.lastAlertAt === undefined || now - marks.lastAlertAt >= ALERT_REPEAT_MS;
}

/** How long a delivery may take to be proved, by where the seat was when it arrived. */
export function proofWindow(turn: WakerTurn): number {
	return turn.busy ? BUSY_PROOF_WINDOW_MS : PROOF_WINDOW_MS;
}

/** True when the seat took a turn at or after `since`. */
export function turnAfter(turn: WakerTurn, since: number): boolean {
	return turn.lastTurnAt !== undefined && turn.lastTurnAt >= since;
}

/** Wait until the seat's turn is newer than `since`, or the window closes. Never sleeps past the deadline. */
export async function awaitTurn(deps: WakerDeps, since: number, windowMs: number): Promise<boolean> {
	const deadline = since + windowMs;
	for (;;) {
		// A stop ends the wait: the proof is not made, and the loop must not spin on it.
		if (deps.signal.aborted) return false;
		const turn = await deps.turn();
		if (turnAfter(turn, since)) return true;
		const now = deps.now();
		if (now >= deadline) return false;
		await deps.sleep(Math.min(PROOF_POLL_MS, deadline - now));
	}
}

/** The outage line: what was tried, and what nobody should assume. */
export function outageText(outage: string, attempts: readonly string[]): string {
	return [
		`${WAKER_ACTOR}: the orchestrator seat (${outage}) took no turn after ${attempts.length} attempt(s).`,
		...attempts.map((attempt) => `- ${attempt}`),
		"Nothing else was restarted and no seat was moved. Check the seat's session and the waker's journal.",
	].join("\n");
}

/**
 * One wake: deliver, prove, retry once, resume the parked seat, then alert once.
 *
 * The retry and the resume keep the same proof window rule as the first delivery. A
 * resume the owner refuses (`not-parked`, or `inbox-only` for a Claude session) is
 * named as an attempt, never counted as one that could have worked: the owner's own
 * answer decides what the seat's state allows.
 */
export async function runWake(deps: WakerDeps, batch: WakerBatch): Promise<WakerOutcome> {
	// A stop ends the ladder where it stands: nothing more is delivered and nobody is paged.
	if (deps.signal.aborted) return { kind: "stopped", detail: "the waker is stopping" };
	const seat = deps.seat();
	const now = deps.now();
	const marks = deps.marks();
	const since = marks.provenAt;
	const window = proofWindow(await deps.turn());
	const text = wakerText(batch, since);
	const attempts: string[] = [];
	let deliveries = 0;
	let lastDetail = "";

	const deliver = async (label: string): Promise<boolean> => {
		if (deps.signal.aborted) return false;
		const result = await deps.deliver(deliveryTarget(seat), text, `${WAKER_ACTOR}:${now}:${deliveries}`);
		deliveries += 1;
		lastDetail = result.detail;
		deps.log(`${label}: ${result.ok ? "delivered" : "delivery failed"}: ${result.detail}`);
		if (!result.ok) attempts.push(`${label} failed: ${result.detail}`);
		return result.ok;
	};

	const carried = (): void => {
		if (batch.messages.length === 0) return;
		// The message travels in the delivered text, so the inbox copy is done and the seat reads it once.
		try {
			deps.markInboxRead(batch.messages.map((message) => message.id));
		} catch (error) {
			deps.log(`the inbox could not be marked read: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const firstDelivered = await deliver("delivery 1");
	if (deps.signal.aborted) return { kind: "stopped", detail: "the waker is stopping" };
	if (firstDelivered) {
		carried();
		deps.saveMarks({ ...marks, lastDeliveryAt: now });
		if (await awaitTurn(deps, now, window)) {
			const provedAt = deps.now();
			deps.saveMarks({ ...deps.marks(), provenAt: provedAt, outageStartedAt: undefined, outageKey: undefined });
			return { kind: "proved", deliveries, afterResume: false };
		}
		if (deps.signal.aborted) return { kind: "stopped", detail: "the waker is stopping" };
	}

	// 2. One retry: a hold, a pause, a refused send or a session that ended under the first message
	// all look the same from here, and a second delivery is the cheap answer.
	const retryAt = deps.now();
	const retried = await deliver("delivery 2 (retry)");
	if (deps.signal.aborted) return { kind: "stopped", detail: "the waker is stopping" };
	if (retried) {
		carried();
		deps.saveMarks({ ...deps.marks(), lastDeliveryAt: retryAt });
		if (await awaitTurn(deps, retryAt, window)) {
			deps.saveMarks({ ...deps.marks(), provenAt: deps.now(), outageStartedAt: undefined, outageKey: undefined });
			return { kind: "proved", deliveries, afterResume: false };
		}
		if (deps.signal.aborted) return { kind: "stopped", detail: "the waker is stopping" };
	}
	attempts.push(
		retried
			? `two deliveries, no turn in ${Math.round(window / 60_000)} min each`
			: `both deliveries were refused (${lastDetail})`,
	);

	// 3. The seat's process is gone or parked: the existing parked-lane resume is the one owner
	// that may relaunch it. A live seat answers `not-parked`, and nothing is started twice.
	const resumeAt = deps.now();
	let resumed = false;
	try {
		const result = await deps.resume(seat ?? unseatedTarget(), text);
		resumed = result.state === "resumed";
		attempts.push(`resume: ${result.state}${result.detail === "" ? "" : ` (${result.detail})`}`);
		deps.log(`resume: ${result.state} ${result.detail}`);
	} catch (error) {
		attempts.push(`resume: failed (${error instanceof Error ? error.message : String(error)})`);
	}
	if (deps.signal.aborted) return { kind: "stopped", detail: "the waker is stopping" };
	if (resumed && (await awaitTurn(deps, resumeAt, window))) {
		deps.saveMarks({ ...deps.marks(), provenAt: deps.now(), outageStartedAt: undefined, outageKey: undefined });
		return { kind: "proved", deliveries, afterResume: true };
	}

	// 4. Alert once per outage, one an hour at most.
	if (deps.signal.aborted) return { kind: "stopped", detail: "the waker is stopping" };
	const key = outageKey(seat);
	const current = deps.marks();
	const startedAt = current.outageKey === key && current.outageStartedAt !== undefined ? current.outageStartedAt : resumeAt;
	const alertText = outageText(key, attempts);
	const held = current.lastAlertAt === undefined ? undefined : ALERT_REPEAT_MS - (resumeAt - current.lastAlertAt);
	if (!alertAllowed(current, resumeAt)) {
		deps.log(`an alert went out ${Math.round((current.lastAlertAt === undefined ? 0 : resumeAt - current.lastAlertAt) / 60_000)} min ago; this outage is logged, not paged`);
		deps.saveMarks({ ...current, outageKey: key, outageStartedAt: startedAt });
		return { kind: "alert-held", detail: held === undefined ? "an alert went out inside the last hour" : `${Math.round(held / 60_000)} min until the next one may go out` };
	}
	deps.saveMarks({ ...current, outageKey: key, outageStartedAt: startedAt });
	try {
		deps.alertHenry(alertText, `${WAKER_ACTOR}:${key}:${Math.floor(resumeAt / ALERT_REPEAT_MS)}`);
	} catch (error) {
		// Not marked: the hour rates alerts that went out, so a failed one is retried next pass.
		const detail = error instanceof Error ? error.message : String(error);
		deps.log(`Henry's alert failed: ${detail}`);
		return { kind: "alert-failed", detail: `Henry's mailbox: ${detail}` };
	}
	deps.saveMarks({ ...deps.marks(), outageKey: key, outageStartedAt: startedAt, lastAlertAt: resumeAt });
	return { kind: "alerted", deliveries, attempts };
}

/** The address the send owner uses while the seat was never claimed: the legacy `orchestrator` inbox. */
function unseatedTarget(): WakerSeat {
	return { laneId: ORCHESTRATOR_INBOX, sessionId: ORCHESTRATOR_INBOX, harness: "unknown", epoch: 0 };
}

/** One pass of the loop: read, and wake only when something needs the seat. */
export async function wakerPass(deps: WakerDeps): Promise<WakerOutcome | undefined> {
	const batch = batchOf(await deps.events(EVENT_WAIT_S), deps.inbox());
	if (batch === undefined) return undefined;
	deps.log(`wake: ${batch.lines.length} event line(s), ${batch.messages.length} inbox message(s)`);
	return runWake(deps, batch);
}

/**
 * The process: read and wake forever. It returns only when `signal` aborts, which is
 * what systemd's stop does; a batch never ends it (the waiter it replaces exited after
 * every batch and had to be re-armed by hand).
 */
export async function runWakerLoop(deps: WakerDeps): Promise<void> {
	while (!deps.signal.aborted) {
		try {
			await wakerPass(deps);
		} catch (error) {
			// One bad pass must not end the process: systemd would restart it and lose the cursor read.
			deps.log(`pass failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
			await deps.sleep(PROOF_POLL_MS);
		}
	}
	deps.log("stopped");
}
