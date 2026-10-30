/**
 * MG6 of the messaging agent (VR24-62, VR24-72, VR24-85; blueprint
 * `plans/orchestration-2026-10-05/specs/messaging-agent-blueprint-2026-10-25.md`, rules G8,
 * G9 and G12): the send gate, the only code that sends a message to a person.
 *
 * `runSendGate` is the one function. `scripts/messaging-send.mts` calls it from a timer under
 * `flock`. It walks the asks the messaging agent raised for drafts and sends a draft only when
 * every one of these holds, checked in this order (G8):
 *
 *   1. its ask is `decided` with option `Send`, a `tap` present, answered by `operator-page` with
 *      the relay `command-center` — the tap path of `answerByTap`. Any other answer, from any
 *      writer, does not qualify: not words from the shell, not Henry's relay, not the CLI (G9,
 *      ticket MA-H4);
 *   2. `sha256(chatId + "\n" + text)` recomputed from the stored draft equals the hash in the
 *      ask's source, and the chat id is the one the draft's hash was made from — the canonical
 *      thread id — which is also the id the adapter is handed;
 *   3. the draft is `approved` in `send.log`: no intent, no outcome, not withdrawn or dropped;
 *   4. a fresh read of this one chat from the channel shows no message after the draft's basis
 *      and the basis message neither edited nor revoked (otherwise the draft and its ask are
 *      withdrawn: G12);
 *   5. the channel's health is WORKING.
 *
 * Between 3 and 4 sits the first-live guard (`firstLiveSelfChatOnly`): until the operator's page has
 * released it, the only chat the gate sends to is his own.
 *
 * Then the intent (`sending`, an attempt id, the time) is written to `send.log` and synced
 * before the adapter is called. `send.log` is its own file beside `raw/`: a damaged or rebuilt
 * index cannot erase it. The first intent line of a draft owns the send, so two runs at once
 * cannot both call the adapter.
 *
 * The outcome is `sent` (the ask is finished with the log line as evidence), `failed` (WAHA
 * refused before anything left; the ask is withdrawn and nothing retries by itself) or
 * `unknown` (a timeout or a crash after the intent). An `unknown` is never resent: the next run
 * reads the chat for a message of ours with the same text after the intent time, records
 * `found` when there is one, and otherwise raises one operator-action ask with no name in it.
 *
 * The recipient is the stored thread's id. No model output selects or changes it.
 * Nothing here writes chat text anywhere: the log and the asks hold ids, hashes and codes.
 */
import { randomUUID } from "node:crypto";

import { AskStateError, finishAsk, readAsks, withdrawAsk, type Ask } from "../asks.ts";
import {
	DONT_SEND_OPTION,
	SEND_OPTION,
	UNKNOWN_ASK_SOURCE_PREFIX,
	parseMessageAskSource,
	raiseUnknownAsk,
	threadOfDraft,
} from "./approval.ts";
import { draftHash, messageFingerprint } from "./drafts.ts";
import type { DraftRow } from "./messages-db.ts";
import { appendSendEvent, draftSendView, isReleased, readSendLog, sendLogPath, SendLogError, type DraftSendView, type LoggedSendEvent } from "./send-log.ts";
import type { MessagingStore } from "./store.ts";
import type { ChannelAdapter, ChannelMessage, ChatReader, SendOutcome } from "./types.ts";

/** What the gate needs from the config file (`messaging.config.json`). */
export type SendGateConfig = {
	/** True until the operator's page releases it: the only chat the gate sends to is his own. */
	firstLiveSelfChatOnly: boolean;
};

export type SendGatePorts = {
	store: MessagingStore;
	/** The Muster state dir whose `asks/` queue holds the asks. */
	stateDir: string;
	/** The channel: `send`, `health` and the fresh read of one chat. */
	adapter: ChannelAdapter & ChatReader;
	config: SendGateConfig;
	/** The ids of the operator's own account (`MESSAGING_SELF_IDS`), for the first-live guard. */
	selfIds?: readonly string[];
	now?: () => Date;
	attemptId?: () => string;
	/**
	 * How long an intent with no outcome counts as a call still in flight. A run that finds an older
	 * one treats the call as lost: it never resends and goes to the unknown path. Defaults to 5 minutes,
	 * longer than the adapter's whole sequence.
	 */
	inFlightGraceMs?: number;
};

/** What the gate did with one ask, as a code (never text, never a name). */
export type GateResult =
	| "sent"
	| "failed"
	| "unknown"
	| "found"
	| "dropped"
	| "withdrawn"
	| "refused"
	| "waiting"
	| "in-flight"
	| "blocked";

export type GateOutcome = { askId: string; code: string | undefined; draftId: string; result: GateResult; reason?: string };

export type SendGateRun = {
	sent: number;
	failed: number;
	unknown: number;
	found: number;
	dropped: number;
	withdrawn: number;
	refused: number;
	waiting: number;
	/** Set when the whole run stopped before it looked at an ask, with the code why. */
	blocked?: string;
	outcomes: GateOutcome[];
};

/** Five minutes: longer than seen + typing + send + stop at the adapter's timeouts. */
export const IN_FLIGHT_GRACE_MS = 5 * 60 * 1000;

const nonEmpty = (value: string | undefined): value is string => typeof value === "string" && value.trim() !== "";

/**
 * Whether the ask was answered by the page's tap, and by nothing else (G8 step 1, G9): `decided`
 * with the option `Send`, a tap on that option, the writer `operator-page`, the relay `command-center`
 * and no words. An answer from the shell, from Henry's relay or from the CLI has no `tap`, and the
 * owner (`answerByTap`) accepts a tap from the page alone.
 */
export function isPageTap(ask: Ask): boolean {
	return (
		ask.status === "decided" &&
		ask.kind === "authorization" &&
		ask.raisedBy === "messaging" &&
		ask.ruling === SEND_OPTION &&
		ask.tap?.option === SEND_OPTION &&
		nonEmpty(ask.tap.version) &&
		ask.answeredBy === "operator-page" &&
		ask.relay?.via === "command-center" &&
		nonEmpty(ask.relay.ref) &&
		ask.words === undefined &&
		!ask.answeredByCard
	);
}

/** One pass of the gate over every message ask that is waiting on it. */
export async function runSendGate(ports: SendGatePorts): Promise<SendGateRun> {
	const run: SendGateRun = { sent: 0, failed: 0, unknown: 0, found: 0, dropped: 0, withdrawn: 0, refused: 0, waiting: 0, outcomes: [] };
	try {
		readSendLog(ports.store.root);
	} catch (error) {
		if (!(error instanceof SendLogError)) throw error;
		// A log that cannot be read cannot say a draft was not sent already.
		return { ...run, blocked: "send-log-unreadable" };
	}
	for (const ask of readAsks(ports.stateDir).asks) {
		// the operator's answer to "not sure a reply was sent" closes that ask with the log line of the attempt it is about.
		if (ask.raisedBy === "messaging" && ask.status === "decided" && ask.source?.startsWith(UNKNOWN_ASK_SOURCE_PREFIX) === true) {
			const unknownView = draftSendView(readSendLog(ports.store.root), ask.source.slice(UNKNOWN_ASK_SOURCE_PREFIX.length));
			finishQuietly(ports, ask.id, unknownView, ports.now?.() ?? new Date());
			continue;
		}
		const named = parseMessageAskSource(ask.source);
		if (named === undefined || ask.raisedBy !== "messaging") continue;
		if (ask.status === "withdrawn" || ask.status === "done") continue;
		if (ask.status !== "decided") {
			run.waiting += 1;
			continue;
		}
		const outcome = await handleAsk(ports, ask, named.draftId, named.hash12);
		run.outcomes.push(outcome);
		switch (outcome.result) {
			case "sent":
				run.sent += 1;
				break;
			case "failed":
				run.failed += 1;
				break;
			case "unknown":
				run.unknown += 1;
				break;
			case "found":
				run.found += 1;
				break;
			case "dropped":
				run.dropped += 1;
				break;
			case "withdrawn":
				run.withdrawn += 1;
				break;
			case "refused":
			case "blocked":
				run.refused += 1;
				break;
			default:
				run.waiting += 1;
		}
	}
	return run;
}

async function handleAsk(ports: SendGatePorts, ask: Ask, draftId: string, hash12: string): Promise<GateOutcome> {
	const done = (result: GateResult, reason?: string): GateOutcome => ({ askId: ask.id, code: ask.code, draftId, result, ...(reason !== undefined ? { reason } : {}) });
	const root = ports.store.root;
	const at = ports.now?.() ?? new Date();
	const view = draftSendView(readSendLog(root), draftId);

	// What the log already says settles the ask; a crash between the two writes is repaired here.
	if (view.state === "sent" || view.state === "found") {
		finishQuietly(ports, ask.id, view, at);
		return done(view.state);
	}
	if (view.state === "withdrawn" || view.state === "dropped" || view.state === "failed") {
		withdrawQuietly(ports, ask.id, view.state === "failed" ? "the send failed and nothing left the account" : view.state === "dropped" ? "the operator chose not to send" : "the chat moved on after the draft", at);
		return done(view.state === "failed" ? "failed" : "withdrawn");
	}
	if (view.state === "sending" || view.state === "unknown") return reconcile(ports, ask, draftId, view, at, done);

	// The draft has not been tried. "Don't send" closes it, whoever recorded it: it changes nothing.
	if (ask.ruling === DONT_SEND_OPTION) {
		const line = appendSendEvent(root, { kind: "dropped", draftId }, at);
		finishQuietly(ports, ask.id, draftSendView([line], draftId), at);
		return done("dropped");
	}
	// Step 1.
	if (!isPageTap(ask)) {
		withdrawQuietly(ports, ask.id, "answered outside the page: only the page's tap approves a send", at);
		return done("refused", "not-a-page-tap");
	}
	const draft = ports.store.drafts.read(draftId);
	if (draft === null) return done("refused", "draft-missing");

	// Step 2.
	const thread = threadOfDraft(ports.store, draft);
	if (thread === undefined) {
		appendSendEvent(root, { kind: "withdrawn", draftId, reason: "thread-id-changed" }, at);
		withdrawQuietly(ports, ask.id, "the chat id of the draft is not the chat's id any more", at);
		return done("withdrawn", "thread-id-changed");
	}
	const chatId = thread.threadId;
	const hash = draftHash(chatId, draft.text);
	if (hash !== draft.hash || hash.slice(0, 12) !== hash12 || draft.hash12 !== hash12 || !ports.store.threadIds(chatId, thread.channel).includes(chatId)) {
		appendSendEvent(root, { kind: "withdrawn", draftId, reason: "hash-mismatch" }, at);
		withdrawQuietly(ports, ask.id, "the draft is not the text that was asked about", at);
		return done("refused", "hash-mismatch");
	}

	// Step 3 is the view above (`approved`). The first-live guard sits here.
	if (ports.config.firstLiveSelfChatOnly && !isReleased(readSendLog(root))) {
		const forms = ports.store.threadIds(chatId, thread.channel);
		const own = (ports.selfIds ?? []).some((id) => id === chatId || forms.includes(id));
		if (!own) return done("refused", "first-live-self-chat-only");
	}

	// Step 4: a fresh read of this one chat.
	let fresh: FreshChat;
	try {
		fresh = await freshChat(ports, thread.channel, chatId);
	} catch {
		return done("blocked", "chat-unreadable");
	}
	const stale = staleAgainst(ports.store, draft, fresh);
	if (stale !== undefined) {
		appendSendEvent(root, { kind: "withdrawn", draftId, reason: stale }, at);
		withdrawQuietly(ports, ask.id, "the chat moved on after the draft", at);
		return done("withdrawn", stale);
	}

	// Step 5.
	let working = false;
	try {
		working = (await ports.adapter.health()).state === "working";
	} catch {
		working = false;
	}
	if (!working) return done("refused", "channel-not-working");

	// The intent, synced, before the call. The first intent line of the draft owns the send.
	const attemptId = (ports.attemptId ?? randomUUID)();
	const intent = appendSendEvent(root, { kind: "intent", attemptId, draftId }, ports.now?.() ?? new Date());
	const owner = draftSendView(readSendLog(root), draftId);
	if (owner.firstIntentLine !== intent.line) return done("in-flight", "another-attempt-owns-the-send");

	let outcome: SendOutcome;
	try {
		outcome = await ports.adapter.send({ draftId, chatId, text: draft.text, hash });
	} catch {
		outcome = { state: "unknown", at: (ports.now?.() ?? new Date()).toISOString(), reason: "the adapter failed after the intent" };
	}
	const logged = appendSendEvent(
		root,
		{
			kind: "outcome",
			attemptId,
			draftId,
			state: outcome.state,
			chatId,
			...(outcome.messageId !== undefined ? { messageId: outcome.messageId } : {}),
			...(outcome.ack !== undefined ? { ack: outcome.ack } : {}),
			...(outcome.reason !== undefined ? { reason: outcome.reason.slice(0, 120) } : {}),
		},
		ports.now?.() ?? new Date(),
	);
	if (outcome.state === "sent") {
		finishQuietly(ports, ask.id, draftSendView([logged], draftId), at);
		return done("sent");
	}
	if (outcome.state === "failed") {
		withdrawQuietly(ports, ask.id, "the send failed and nothing left the account", at);
		return done("failed", outcome.reason?.slice(0, 120));
	}
	return done("unknown");
}

/**
 * An intent with no `sent` outcome. The process cannot tell whether the message left, so it never
 * resends: it reads the chat for a message of ours with the draft's text after the intent time and
 * records `found`, or raises the one operator-action ask. The ask the tap answered is closed either way,
 * so the gate reads the chat once for this draft and not every run.
 */
async function reconcile(
	ports: SendGatePorts,
	ask: Ask,
	draftId: string,
	view: DraftSendView,
	at: Date,
	done: (result: GateResult, reason?: string) => GateOutcome,
): Promise<GateOutcome> {
	const root = ports.store.root;
	const intentMs = view.intentAt === undefined ? 0 : Date.parse(view.intentAt);
	// A call that may still be running is left alone.
	if (view.state === "sending" && at.getTime() - intentMs < (ports.inFlightGraceMs ?? IN_FLIGHT_GRACE_MS)) return done("in-flight", "send-in-progress");
	const draft = ports.store.drafts.read(draftId);
	const thread = draft === null ? undefined : threadOfDraft(ports.store, draft);
	if (draft === null || thread === undefined) return done("blocked", "draft-or-thread-missing");
	let fresh: FreshChat;
	try {
		fresh = await freshChat(ports, thread.channel, thread.threadId);
	} catch {
		return done("blocked", "chat-unreadable");
	}
	const floorMs = Math.floor(intentMs / 1000) * 1000;
	const found = fresh.messages.find((message) => message.fromMe && (message.text ?? "") === draft.text && message.timestamp >= floorMs);
	if (found !== undefined) {
		const line = appendSendEvent(root, { kind: "found", attemptId: view.attemptId ?? "", draftId, messageId: found.messageId }, at);
		finishQuietly(ports, ask.id, draftSendView([line], draftId), at);
		return done("found");
	}
	if (view.unknownAskId === undefined) {
		const raised = raiseUnknownAsk(ports.stateDir, draftId, at.toISOString());
		appendSendEvent(root, { kind: "unknown-ask", attemptId: view.attemptId ?? "", draftId, askId: raised.id }, at);
	}
	withdrawQuietly(ports, ask.id, "the outcome of the send is unknown: the operator was asked to check", at);
	return done("unknown");
}

type FreshChat = { messages: ChannelMessage[]; edited: Set<string> };

/** The channel's own read of the thread, every id form of it, with the fingerprints of messages it marks edited or revoked. */
async function freshChat(ports: SendGatePorts, channel: string, chatId: string): Promise<FreshChat> {
	const forms = new Set([chatId, ...ports.store.threadIds(chatId, channel)]);
	const messages: ChannelMessage[] = [];
	const edited = new Set<string>();
	for (const form of forms) {
		const read = await ports.adapter.readChat(form);
		messages.push(...read.messages);
		for (const event of read.events) {
			if (event.event === "edited" || event.event === "deleted" || event.event === "revoked") edited.add(messageFingerprint(event.messageId));
		}
	}
	return { messages, edited };
}

/**
 * G8 step 4 against the channel's own read: a message after the basis from either side, a basis the
 * channel no longer holds (revoked), a basis it marks edited, or a basis whose text is no longer the
 * text the archive kept. Returns a code, or undefined while the draft is still current.
 */
function staleAgainst(store: MessagingStore, draft: DraftRow, fresh: FreshChat): string | undefined {
	let basis: ChannelMessage | undefined;
	for (const message of fresh.messages) {
		const isBasis = messageFingerprint(message.messageId) === draft.basisMessageHash;
		if (isBasis) {
			basis = message;
			continue;
		}
		if (message.timestamp >= draft.basisTimestamp) return message.fromMe ? "sent-after-draft" : "arrived-after-draft";
	}
	if (draft.basisMessageHash !== "") {
		if (basis === undefined) return "basis-gone";
		if (fresh.edited.has(draft.basisMessageHash)) return "basis-edited-or-revoked";
		const thread = threadOfDraft(store, draft);
		if (thread !== undefined) {
			const kept = store.readThread(thread.threadId, { limit: 50, channel: thread.channel }).messages.find((message) => messageFingerprint(message.messageId) === draft.basisMessageHash);
			if (kept !== undefined && (basis.text ?? "") !== kept.text) return "basis-edited-or-revoked";
		}
	}
	return undefined;
}

function finishQuietly(ports: SendGatePorts, askId: string, view: DraftSendView, at: Date): void {
	if (view.line === undefined) return;
	try {
		finishAsk(ports.stateDir, { ref: askId, by: "messaging", evidence: { log: "send.log", file: sendLogPath(ports.store.root), line: view.line }, at: at.toISOString() });
	} catch (error) {
		// An ask closed between the read and the write is closed; nothing else is swallowed.
		if (!(error instanceof AskStateError) || error.code !== "conflict") throw error;
	}
}

function withdrawQuietly(ports: SendGatePorts, askId: string, reason: string, at: Date): void {
	try {
		withdrawAsk(ports.stateDir, { ref: askId, by: "messaging", reason, at: at.toISOString() });
	} catch (error) {
		if (!(error instanceof AskStateError) || error.code !== "conflict") throw error;
	}
}

export type { LoggedSendEvent };
