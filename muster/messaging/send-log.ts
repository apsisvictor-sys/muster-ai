/**
 * MG6 of the messaging agent (VR24-62, VR24-85 gate list point 3; blueprint
 * `plans/orchestration-2026-10-05/specs/messaging-agent-blueprint-2026-10-25.md`, rule G8):
 * `send.log`, the owner of a draft's send state.
 *
 * The send intent is written where a damaged or rebuilt index cannot erase it. `messages.db`
 * is derived and rebuildable, and R1 (VR24-81) makes a damaged index yield no rows, so an
 * intent kept only there could be forgotten and allow a second send. This file sits beside
 * `raw/` in the store root and is append-only: one JSON object per line, written with one
 * `write` on an `O_APPEND` descriptor and `fsync`ed before the call returns. Nothing rewrites
 * it, and the index never reads or writes it.
 *
 * A line holds ids, hashes and times, and never text: the draft id, an attempt id, the short
 * message id the channel gave, and (for the delivery re-read of G3) the chat id the message
 * went to. The store folder is 0700 and the file 0600, like `raw/`.
 *
 * It fails closed. A line that is not an event, or a last line cut short by a crash, makes
 * `readSendLog` throw `SendLogError`, and the gate sends nothing until an operator has read
 * the file: a log that cannot be read cannot say that a draft was not sent already.
 */
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

import { ensureStore, messagingRoot } from "./archive.ts";

/** The log's file name, inside the store root. */
export const SEND_LOG_FILE = "send.log";

export type SendLogEvent =
	| { kind: "intent"; attemptId: string; draftId: string }
	| {
			kind: "outcome";
			attemptId: string;
			draftId: string;
			state: "sent" | "failed" | "unknown";
			/** The short message id the channel gave, when it gave one. */
			messageId?: string;
			/** The chat the message went to, for the delivery re-read (G3). */
			chatId?: string;
			ack?: string;
			/** A code or a status line, never text. */
			reason?: string;
	  }
	| { kind: "found"; attemptId: string; draftId: string; messageId?: string }
	| { kind: "unknown-ask"; attemptId: string; draftId: string; askId: string }
	| { kind: "withdrawn"; draftId: string; reason: string }
	| { kind: "dropped"; draftId: string }
	| { kind: "release"; by: string };

/** An event as the file holds it: its id, its time, its line, and the event itself. */
export type LoggedSendEvent = SendLogEvent & { v: 1; id: string; at: string; line: number };

export class SendLogError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SendLogError";
	}
}

/** The log's path inside a store root. */
export function sendLogPath(root: string): string {
	return join(messagingRoot(root), SEND_LOG_FILE);
}

const KINDS: readonly string[] = ["intent", "outcome", "found", "unknown-ask", "withdrawn", "dropped", "release"];

/**
 * Appends one event and syncs it. The line number comes from reading the file back and finding
 * the event by its own id, so two writers at once each learn their own line.
 */
export function appendSendEvent(root: string, event: SendLogEvent, at: Date = new Date()): LoggedSendEvent {
	const storeRoot = messagingRoot(root);
	ensureStore(storeRoot);
	const path = sendLogPath(storeRoot);
	const id = randomUUID();
	const line = `${JSON.stringify({ v: 1, id, at: at.toISOString(), ...event })}\n`;
	const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
	try {
		writeSync(fd, line);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	const written = readSendLog(storeRoot).find((candidate) => candidate.id === id);
	if (written === undefined) throw new SendLogError("the send log does not hold the event just written");
	return written;
}

/** Every event of the log, in order. A missing file is an empty log; an unreadable line is an error. */
export function readSendLog(root: string): LoggedSendEvent[] {
	const path = sendLogPath(root);
	if (!existsSync(path)) return [];
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw new SendLogError(`the send log could not be read (${error instanceof Error ? error.message : String(error)})`);
	}
	if (text.length === 0) return [];
	if (!text.endsWith("\n")) throw new SendLogError("the send log ends on a line that was cut short: nothing is sent until it is read by hand");
	const events: LoggedSendEvent[] = [];
	const lines = text.slice(0, -1).split("\n");
	for (const [index, raw] of lines.entries()) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new SendLogError(`send log line ${index + 1} is not JSON: nothing is sent until it is read by hand`);
		}
		const record = parsed as Record<string, unknown> | null;
		if (
			record === null ||
			typeof record !== "object" ||
			record["v"] !== 1 ||
			typeof record["id"] !== "string" ||
			typeof record["at"] !== "string" ||
			typeof record["kind"] !== "string" ||
			!KINDS.includes(record["kind"])
		) {
			throw new SendLogError(`send log line ${index + 1} is not an event: nothing is sent until it is read by hand`);
		}
		events.push({ ...(record as unknown as LoggedSendEvent), line: index + 1 });
	}
	return events;
}

/** Where a draft stands. `sending` is an intent with no outcome: the process cannot tell, so it is read as `unknown`. */
export type DraftSendState = "approved" | "sending" | "sent" | "failed" | "unknown" | "found" | "withdrawn" | "dropped";

/** States nothing in the gate moves a draft out of by itself. */
export const TERMINAL_SEND_STATES: readonly DraftSendState[] = ["sent", "found", "failed", "withdrawn", "dropped"];

export type DraftSendView = {
	state: DraftSendState;
	/** The attempt of the newest intent. */
	attemptId?: string;
	/** When that intent was written (ISO). */
	intentAt?: string;
	/** The line of the first intent of this draft: the one that owns the send. */
	firstIntentLine?: number;
	/** The newest outcome event of the draft. */
	outcome?: LoggedSendEvent;
	/** The line of the event that put the draft in its state. */
	line?: number;
	/** The id of the operator-action ask raised for an unknown outcome, once it exists. */
	unknownAskId?: string;
};

/** A draft's send state, folded from the log in order. A draft with no event is `approved`: the ask decides whether it may go. */
export function draftSendView(events: readonly LoggedSendEvent[], draftId: string): DraftSendView {
	let view: DraftSendView = { state: "approved" };
	for (const event of events) {
		if (!("draftId" in event) || event.draftId !== draftId) continue;
		// Once the message left, or was found to have left, nothing after it changes the state.
		if (view.state === "sent" || view.state === "found") break;
		switch (event.kind) {
			case "intent":
				view = { ...view, state: "sending", attemptId: event.attemptId, intentAt: event.at, firstIntentLine: view.firstIntentLine ?? event.line, line: event.line };
				break;
			case "outcome":
				view = { ...view, state: event.state, outcome: event, line: event.line };
				break;
			case "found":
				view = { ...view, state: "found", line: event.line };
				break;
			case "unknown-ask":
				view = { ...view, unknownAskId: event.askId };
				break;
			case "withdrawn":
				view = { ...view, state: "withdrawn", line: event.line };
				break;
			case "dropped":
				view = { ...view, state: "dropped", line: event.line };
				break;
			default:
				break;
		}
	}
	return view;
}

/** Whether the operator's page has released the first-live guard (`firstLiveSelfChatOnly`). */
export function isReleased(events: readonly LoggedSendEvent[]): boolean {
	return events.some((event) => event.kind === "release");
}

/** The messages this account sent after `sinceMs`, with the chat each went to: the delivery re-read's list (G3). */
export function sentSince(events: readonly LoggedSendEvent[], sinceMs: number): Array<{ chatId: string; messageId: string }> {
	const sent: Array<{ chatId: string; messageId: string }> = [];
	for (const event of events) {
		if (event.kind !== "outcome" || event.state !== "sent") continue;
		if (event.chatId === undefined || event.messageId === undefined) continue;
		if (Date.parse(event.at) >= sinceMs) sent.push({ chatId: event.chatId, messageId: event.messageId });
	}
	return sent;
}
