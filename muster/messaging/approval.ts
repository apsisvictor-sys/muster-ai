/**
 * MG6 of the messaging agent (VR24-62, VR24-72, VR24-85; blueprint
 * `plans/orchestration-2026-10-05/specs/messaging-agent-blueprint-2026-10-25.md`, rules G7
 * and G12): the ask for a draft, and the passes that keep the asks and the drafts in step.
 *
 * - One ask per draft (G7). The raiser is the process-internal writer `messaging`. The ask is
 *   an `authorization` with no `rule`, so `standingRuleDrafts` never counts it and no standing
 *   rule can arise from message approvals. Its `source` is `msg-draft:<draftId>:<hash12>` and is
 *   set once, by the raised event. Its question holds no name and no text: `asks_read` prints
 *   it verbatim on the public gateway, and a contact's display name is text a peer controls.
 *   The page maps ask to draft through the source.
 * - The code is `MSG-<n>`. The recommendation is `Don't send`: `prepareAsk` refuses an empty
 *   one, and it does not push the operator towards sending.
 * - G12: a new inbound or outbound message after a draft's basis, or an edit or revoke of the
 *   basis message, withdraws the draft's open ask. A draft the operator has not answered stays; no
 *   clock expires anything.
 *
 * Nothing here sends and nothing here records a ruling. The send gate (`send-gate.ts`) is the
 * only code that sends.
 */
import {
	AskStateError,
	CLOSED_ASK_STATUSES,
	prepareAsk,
	raiseAsk,
	readAsks,
	withdrawAsk,
	type Ask,
	type AskQueue,
} from "../asks.ts";
import { messageFingerprint, threadFingerprint } from "./drafts.ts";
import type { DraftRow, ThreadRow } from "./messages-db.ts";
import { appendSendEvent, draftSendView, readSendLog, TERMINAL_SEND_STATES } from "./send-log.ts";
import type { MessagingStore } from "./store.ts";
import { needsOperator } from "./triage.ts";

/** The question of a draft's ask: no name, no text (G7). */
export const MESSAGE_ASK_QUESTION = "A WhatsApp reply is waiting for your OK. Open Messages on the command center page.";
/** The question of the ask raised for a send whose outcome is unknown: no name either (G8). */
export const UNKNOWN_ASK_QUESTION = "Not sure a reply was sent: open Messages on the command center page.";
export const SEND_OPTION = "Send";
export const DONT_SEND_OPTION = "Don't send";
export const MESSAGE_ASK_OPTIONS: readonly string[] = [SEND_OPTION, DONT_SEND_OPTION];
/** The recommendation: not sending, which is the answer that changes nothing. */
export const MESSAGE_ASK_RECOMMENDATION = DONT_SEND_OPTION;
export const UNKNOWN_ASK_OPTION = "I checked";
export const MESSAGE_ASK_SOURCE_PREFIX = "msg-draft:";
export const UNKNOWN_ASK_SOURCE_PREFIX = "msg-unknown:";
/** `MS3` to `MS5` are rule names in the blueprint, so the prefix differs. */
export const MESSAGE_CODE_PREFIX = "MSG-";
const CODE_NUMBER = /^MSG-(\d+)$/;
const DRAFT_SOURCE = /^msg-draft:([0-9a-f]{16}):([0-9a-f]{12})$/;

/** The immutable source of a draft's ask: the draft and the first 12 hex of the hash of its text. */
export function messageAskSource(draft: Pick<DraftRow, "draftId" | "hash12">): string {
	return `${MESSAGE_ASK_SOURCE_PREFIX}${draft.draftId}:${draft.hash12}`;
}

/** The draft id and the short hash a source names, or undefined for any other source. */
export function parseMessageAskSource(source: string | undefined): { draftId: string; hash12: string } | undefined {
	const match = source === undefined ? null : DRAFT_SOURCE.exec(source);
	return match === null ? undefined : { draftId: match[1]!, hash12: match[2]! };
}

/** An ask the messaging agent raised for a draft. */
export function isMessageDraftAsk(ask: Ask): boolean {
	return parseMessageAskSource(ask.source) !== undefined;
}

/** Any ask the messaging agent raised: a draft's, or the one for an unknown outcome. */
export function isMessageAsk(ask: Ask): boolean {
	return ask.source !== undefined && (ask.source.startsWith(MESSAGE_ASK_SOURCE_PREFIX) || ask.source.startsWith(UNKNOWN_ASK_SOURCE_PREFIX));
}

/** The next `MSG-<n>`: one past the highest number any ask ever carried, closed ones included, so a code is never reused. */
export function nextMessageCode(queue: AskQueue): string {
	let highest = 0;
	for (const ask of queue.asks) {
		const match = ask.code === undefined ? null : CODE_NUMBER.exec(ask.code);
		if (match !== null) highest = Math.max(highest, Number(match[1]));
	}
	return `${MESSAGE_CODE_PREFIX}${highest + 1}`;
}

/** The draft's ask that is not withdrawn: open, decided or done. */
export function liveDraftAsk(queue: AskQueue, draftId: string): Ask | undefined {
	return queue.asks.filter((ask) => parseMessageAskSource(ask.source)?.draftId === draftId && ask.status !== "withdrawn").at(-1);
}

/** Raises and prepares the ask for one draft (G7). The question carries no name and no text. */
export function raiseDraftAsk(stateDir: string, draft: DraftRow, at?: string): Ask {
	const raised = raiseAsk(stateDir, {
		by: "messaging",
		kind: "authorization",
		question: MESSAGE_ASK_QUESTION,
		code: nextMessageCode(readAsks(stateDir)),
		source: messageAskSource(draft),
		...(at !== undefined ? { at } : {}),
	});
	return prepareAsk(stateDir, {
		ref: raised.id,
		by: "messaging",
		options: [...MESSAGE_ASK_OPTIONS],
		recommendation: MESSAGE_ASK_RECOMMENDATION,
		...(at !== undefined ? { at } : {}),
	});
}

/** Raises the one operator-action ask for a send whose outcome the process cannot tell (G8). No name, no text. */
export function raiseUnknownAsk(stateDir: string, draftId: string, at?: string): Ask {
	const raised = raiseAsk(stateDir, {
		by: "messaging",
		kind: "operator-action",
		question: UNKNOWN_ASK_QUESTION,
		code: nextMessageCode(readAsks(stateDir)),
		source: `${UNKNOWN_ASK_SOURCE_PREFIX}${draftId}`,
		...(at !== undefined ? { at } : {}),
	});
	return prepareAsk(stateDir, { ref: raised.id, by: "messaging", options: [UNKNOWN_ASK_OPTION], recommendation: UNKNOWN_ASK_OPTION, ...(at !== undefined ? { at } : {}) });
}

/** The thread a draft was written for: found by its fingerprint, since a draft never holds the chat id (G11). */
export function threadOfDraft(store: MessagingStore, draft: DraftRow): ThreadRow | undefined {
	return store.threads({ limit: 5000 }).find((thread) => thread.channel === draft.channel && threadFingerprint(thread.threadId) === draft.threadFingerprint);
}

/**
 * Why the archive says a draft is stale, or undefined while it is not (G12): a message after the
 * basis, from either side, or an edit or revoke of the basis message. The archive lags the channel
 * by up to a sync interval, so the send gate asks the channel too (G8 step 4); this is the pass
 * that keeps an unsent ask from outliving the chat it was raised for.
 */
export function archiveStaleReason(store: MessagingStore, draft: DraftRow): string | undefined {
	const thread = threadOfDraft(store, draft);
	if (thread === undefined) return "the thread of the draft is not in the archive under the id the draft was made for";
	const view = store.readThread(thread.threadId, { limit: 50, channel: thread.channel });
	for (const message of view.messages) {
		const after = message.timestamp > draft.basisTimestamp || (message.timestamp === draft.basisTimestamp && messageFingerprint(message.messageId) !== draft.basisMessageHash);
		if (after) return message.fromMe ? "a message was sent in the chat after the draft" : "a message arrived in the chat after the draft";
	}
	for (const event of view.events) {
		if ((event.event === "edited" || event.event === "deleted" || event.event === "revoked") && messageFingerprint(event.messageId) === draft.basisMessageHash) {
			return `the message the draft answers was ${event.event}`;
		}
	}
	return undefined;
}

export type ApprovalPorts = {
	store: MessagingStore;
	/** The Muster state dir whose `asks/` queue holds the asks. */
	stateDir: string;
	now?: () => Date;
};

export type StalePass = { withdrawn: number; repaired: number };

/**
 * G12 and its repair. For every ask of a draft that is not closed:
 *  - a draft whose chat moved on has its ask withdrawn and is marked `withdrawn` in `send.log`;
 *  - an ask whose draft `send.log` already calls withdrawn or dropped (a crash between the two writes)
 *    is withdrawn now.
 * An ask the operator has not answered, on a chat that did not move, stays. Nothing expires on a clock.
 */
export function withdrawStaleDrafts(ports: ApprovalPorts): StalePass {
	const at = ports.now?.() ?? new Date();
	let withdrawn = 0;
	let repaired = 0;
	for (const ask of readAsks(ports.stateDir).asks) {
		const named = parseMessageAskSource(ask.source);
		if (named === undefined || CLOSED_ASK_STATUSES.includes(ask.status)) continue;
		const view = draftSendView(readSendLog(ports.store.root), named.draftId);
		if (view.state === "withdrawn" || view.state === "dropped") {
			withdrawAskQuietly(ports.stateDir, ask.id, view.state === "dropped" ? "the operator chose not to send" : "the chat moved on after the draft", at);
			repaired += 1;
			continue;
		}
		if (TERMINAL_SEND_STATES.includes(view.state) || view.state === "sending" || view.state === "unknown") continue;
		const draft = ports.store.drafts.read(named.draftId);
		if (draft === null) continue;
		const reason = archiveStaleReason(ports.store, draft);
		if (reason === undefined) continue;
		appendSendEvent(ports.store.root, { kind: "withdrawn", draftId: named.draftId, reason }, at);
		withdrawAskQuietly(ports.stateDir, ask.id, "the chat moved on after the draft", at);
		withdrawn += 1;
	}
	return { withdrawn, repaired };
}

function withdrawAskQuietly(stateDir: string, askId: string, reason: string, at: Date): void {
	try {
		withdrawAsk(stateDir, { ref: askId, by: "messaging", reason, at: at.toISOString() });
	} catch (error) {
		// An ask somebody closed between the read and the write is closed; nothing else is swallowed.
		if (!(error instanceof AskStateError) || error.code !== "conflict") throw error;
	}
}

export type RaisePass = {
	/** Asks raised this pass. */
	raised: number;
	/** Drafts left alone because they already have a live ask, or have left the open states. */
	skipped: number;
};

/**
 * Raises the ask for each thread's newest draft while the thread still needs the operator (MG4's
 * `needsOperator()`, asked and not copied) and the draft is still current. A draft that already has a
 * live ask, one that was sent, dropped, withdrawn or failed, and one the archive calls stale get none.
 */
export function raiseDraftAsks(ports: ApprovalPorts): RaisePass {
	const at = (ports.now?.() ?? new Date()).toISOString();
	const queue = readAsks(ports.stateDir);
	const events = readSendLog(ports.store.root);
	let raised = 0;
	let skipped = 0;
	for (const thread of ports.store.threads({ limit: 5000 })) {
		const row = ports.store.triage.read(thread.channel, thread.threadId);
		const newest = ports.store.readThread(thread.threadId, { limit: 1, channel: thread.channel }).messages.at(-1);
		if (!needsOperator(row, newest)) continue;
		const draft = ports.store.drafts.latest(thread.channel, threadFingerprint(thread.threadId));
		if (draft === null) continue;
		const state = draftSendView(events, draft.draftId).state;
		if (state !== "approved" || liveDraftAsk(queue, draft.draftId) !== undefined || archiveStaleReason(ports.store, draft) !== undefined) {
			skipped += 1;
			continue;
		}
		raiseDraftAsk(ports.stateDir, draft, at);
		raised += 1;
	}
	return { raised, skipped };
}
