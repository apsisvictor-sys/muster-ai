/**
 * A Pi session wakes on its bus inbox.
 *
 * A seat is an address, not a harness: lanes report and send to
 * `orchestrator`, which lands in `<musterStateDir>/inbox/orchestrator/`. A Claude
 * Code session reads that with a background `muster wait --inbox`. A Pi session
 * has no such waiter, so this module polls the inbox it is given (who may poll is
 * the seat owner's answer, `pollAgent` in `seat-adapter.ts`, which follows
 * `seatHeldBy` in `seats.ts`) and hands each message to the caller's `request`,
 * which reports the delivery as a wake. The Pi extension's request is the session's
 * own injection (`wake-injection.ts`); admission (pause, kill file, breaker, an
 * idle session, no draft in the editor) stays with the Muster wake policy, and
 * this module only produces the deliveries.
 *
 * A message is moved to `read/` only after the request delivered it, so a
 * message that was held, or a session that ended first, is offered again.
 *
 * Both readers below go through the inbox owner (`lib/agent-inbox.ts`), which
 * reads the switch on every call: in ledger mode the same poll sees the ledger's
 * accepted messages and marks them delivered there (LC9), so this module keeps
 * one polling path and changes nothing else.
 */

import { listInboxMessages, markInboxMessageRead, type InboxMessage } from "./lib/agent-inbox.ts";
import type { EventWakeRequest } from "../core/event-wake.ts";

export const INBOX_WAKE_ORIGIN = "bus inbox";
const DEFAULT_INTERVAL_MS = 5_000;

/** What the caller does with one delivery. The message is passed so the caller needs no second read. */
export type InboxWakeRequest = (wake: EventWakeRequest, message: InboxMessage) => "queued" | "duplicate" | "closed";

export function inboxWakeRequest(stateDir: string, agent: string, message: InboxMessage): EventWakeRequest {
	return {
		text: `${message.from} wrote to ${agent}'s bus inbox:\n${message.text}`,
		origin: INBOX_WAKE_ORIGIN,
		mode: "followUp",
		dedupeKey: `inbox:${agent}:${message.id}`,
		customType: "bus-inbox",
		details: { messageId: message.id, from: message.from, ...(message.taskId !== undefined ? { taskId: message.taskId } : {}) },
		// A message read by someone else (a `muster wait` on the same inbox) is no longer worth a turn.
		isRelevant: () => listInboxMessages(stateDir, agent).some((pending) => pending.id === message.id),
		onDelivered: () => {
			markInboxMessageRead(stateDir, agent, message.id);
		},
	};
}

/** One pass: offer every unread message to the request. Returns how many were newly queued. */
export function pollInboxWake(stateDir: string, agent: string, request: InboxWakeRequest): number {
	let queued = 0;
	for (const message of listInboxMessages(stateDir, agent)) {
		if (request(inboxWakeRequest(stateDir, agent, message), message) === "queued") queued += 1;
	}
	return queued;
}

/** Poll until stopped. The timer is unref'd, so it never keeps the process alive. */
export function startInboxWake(options: {
	stateDir: () => string;
	agent: string;
	request: InboxWakeRequest;
	intervalMs?: number;
}): () => void {
	const tick = (): void => {
		try {
			pollInboxWake(options.stateDir(), options.agent, options.request);
		} catch {
			// An unreadable inbox is retried on the next tick; it must not break the session.
		}
	};
	tick();
	const timer = setInterval(tick, options.intervalMs ?? DEFAULT_INTERVAL_MS);
	timer.unref?.();
	return () => clearInterval(timer);
}
