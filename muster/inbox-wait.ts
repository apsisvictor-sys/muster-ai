/**
 * `muster wait --inbox <agent>` — the reader half of the agent inbox.
 *
 * The orchestrator (a Claude Code session) has no Concord prompt endpoint, so a
 * lane's reply cannot reach it through Concord. It arms this wait as a
 * background task; the wait polls the agent's inbox directory and returns the
 * moment a whole message file appears. The caller prints the messages and then
 * moves them into `read/` (see `markInboxMessageRead`), so a message is never
 * lost by a reader that dies between reading and moving.
 *
 * A first read happens before any sleep: a message that arrived while nobody was
 * armed is delivered on the next arm instead of waiting for a second message.
 */

import type { InboxMessage } from "./lib/agent-inbox.ts";
import { formatClaudeInboxDelivery } from "./lib/claude-lane-card.ts";

export const INBOX_WAIT_MIN_POLL_MS = 20;

export interface InboxWaitOptions {
	agent: string;
	/** Pending messages, newest last. Injected so the loop is testable. */
	read: () => InboxMessage[];
	timeoutMs: number;
	pollMs: number;
	signal?: AbortSignal;
	/** Injected for tests; defaults to a real sleep. */
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

export interface InboxWaitResult {
	agent: string;
	/** Whole messages waiting at the moment the wait settled. */
	messages: InboxMessage[];
	elapsedMs: number;
	aborted: boolean;
}

function defaultSleep(ms: number): Promise<void> {
	// Deliberately referenced: the wait is the caller's whole purpose, so the
	// timer must keep the process alive until it fires.
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/** Wait for the first whole inbox message; the caller prints it and marks it read. */
export async function waitOnInbox(options: InboxWaitOptions): Promise<InboxWaitResult> {
	const now = options.now ?? (() => Date.now());
	const sleep = options.sleep ?? defaultSleep;
	const pollMs = Math.max(INBOX_WAIT_MIN_POLL_MS, options.pollMs);
	const started = now();
	for (;;) {
		const messages = options.read();
		if (messages.length > 0) return { agent: options.agent, messages, elapsedMs: now() - started, aborted: false };
		if (options.signal?.aborted === true) return { agent: options.agent, messages: [], elapsedMs: now() - started, aborted: true };
		const remaining = options.timeoutMs - (now() - started);
		if (remaining <= 0) return { agent: options.agent, messages: [], elapsedMs: now() - started, aborted: false };
		const wait = Math.min(pollMs, remaining);
		// A timeout of 0 means "read once, report, do not wait": the caller is
		// checking the board, not arming a watch.
		if (options.timeoutMs === 0) return { agent: options.agent, messages: [], elapsedMs: now() - started, aborted: false };
		await sleep(wait);
	}
}

/**
 * One line per message, then the count: what the armed reader prints. A lane woken by its own
 * waiter (`laneDelivery`) reads each message as the hook would have delivered it, with the
 * sender and the reply command.
 */
export function formatInboxWaitResult(result: InboxWaitResult, options: { laneDelivery?: boolean } = {}): string {
	if (result.aborted) return `muster wait: stopped waiting on ${result.agent}'s inbox`;
	if (result.messages.length === 0) return `muster wait: nothing in ${result.agent}'s inbox`;
	if (options.laneDelivery === true) {
		return result.messages.map((message) => formatClaudeInboxDelivery(message, result.agent, "sent while you were idle (this wait woke you)")).join("\n\n");
	}
	const lines = result.messages.map((message) => {
		const reply = message.replyTo !== undefined ? ` (reply to ${message.replyTo})` : "";
		return `muster wait: ${result.agent} inbox: ${message.from} -> ${message.text}${reply}`;
	});
	return lines.join("\n");
}
