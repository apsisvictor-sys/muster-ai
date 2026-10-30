/**
 * MG4 of the messaging agent (VR24-62, blueprint
 * `plans/orchestration-2026-10-05/specs/messaging-agent-blueprint-2026-10-25.md`,
 * rule G5): triage is the classifier owner's job, per thread.
 *
 * - A deterministic filter runs before any model call. Own messages, reactions, status
 *   updates, channels and newsletters, call notices, and group chats nobody mentioned
 *   the operator in never reach the classifier. The run reports how many items each reason
 *   removed, so a quiet week and a broken filter look different.
 * - One classifier call per thread with new inbound text, never one per message. The
 *   thread's own messages are the classifier's `state`: data to judge, under the
 *   question set's data-not-instructions framing. No other thread is in that state.
 * - The answer is a closed enum (`TRIAGE_CHOICES`). A failed call, a missing answer or
 *   an answer outside the sets leaves the thread `untriaged`: visible, with the call's
 *   stop reason, and nothing invented.
 * - The row holds ids, closed sets, token counts and money. Chat text is never written
 *   here, into the index or into the run's report.
 * - Every effect is a port: the store and one `judge` call. A test runs the whole path
 *   against a stub classifier, a temp store root and synthetic text.
 */
import { DEFAULT_LIST_LIMIT, DEFAULT_THREAD_LIMIT, type ThreadMessage, type ThreadRow, type TriageKind, type TriageNeedsReply, type TriageRow, type TriageUrgency } from "./messages-db.ts";
import type { MessagingStore } from "./store.ts";

/** The question set this module asks. Data in `extensions/lib/classifier-questions/`, never inline. */
export const TRIAGE_QUESTION_SET = "messaging-triage";

/**
 * The stored answer sets, and the validator for what the classifier returns. The set
 * file names the same choices; a test fails when the two drift apart.
 */
export const TRIAGE_CHOICES = {
	needs_reply: ["yes", "no", "unsure"],
	urgency: ["now", "today", "later"],
	kind: ["personal", "business", "vendor", "automated", "other"],
} as const;

/** The classifier's `state`: JSON data, never a prompt. */
export type TriageStateData = Record<string, unknown>;

/** One answer as the classifier owner returns it. */
export type TriageAnswer = { type: string; choice?: string };

/**
 * The classifier owner's call record (`ClassifierCallRecord` in
 * `extensions/lib/classifier.ts`), structurally. Triage adds the thread and the outcome.
 */
export type TriageCallLike = {
	at: string;
	questionSet: string;
	setVersion: number;
	model: string;
	stopReason: string;
	answers: Record<string, TriageAnswer>;
	inputTokens: number | null;
	outputTokens: number | null;
	costUsd: number | null;
	latencyMs: number;
	stateBytes: number;
	error?: string;
};

/** One call this run made: the classifier's record, plus which thread it was about. */
export type TriageCallRecord = TriageCallLike & {
	threadId: string;
	channel: string;
	/** False when the call failed or answered outside the sets; the thread is then untriaged. */
	ok: boolean;
};

export type TriageJudgeOutcome = { ok: true; answers: Record<string, TriageAnswer>; record: TriageCallLike } | { ok: false; record: TriageCallLike };

/** The one model port: a thread's state in, the classifier owner's outcome out. */
export type TriageJudge = (state: TriageStateData) => Promise<TriageJudgeOutcome>;

/** Why the deterministic filter dropped something. One count per dropped item (`TriageRun.dropped`). */
export const DROP_REASONS = ["own-messages", "reactions", "status-updates", "channels-newsletters", "call-notices", "group-chats"] as const;
export type DropReason = (typeof DROP_REASONS)[number];

export type TriageRun = {
	/** Threads that held messages newer than their last triage. */
	examined: number;
	triaged: number;
	untriaged: number;
	dropped: Record<DropReason, number>;
	calls: TriageCallRecord[];
};

export type TriagePorts = {
	store: MessagingStore;
	judge: TriageJudge;
	/** The clock, for tests. */
	now?: () => Date;
	/**
	 * the operator's own ids (`1555…@c.us`, `…@lid`). A group chat is kept only when one of them
	 * is mentioned or quoted; with no id given every group chat is dropped, which is the
	 * quiet branch of the rule and never a wrong promotion.
	 */
	selfIds?: readonly string[];
	threadLimit?: number;
	messageLimit?: number;
};

/** Newest messages of a thread that go into the classifier's state. */
export const STATE_MESSAGES = 12;
/** Characters one message may contribute to the state. */
export const STATE_MESSAGE_CHARS = 1_200;
/** Characters the whole state's message list may hold, oldest cut first. */
export const STATE_CHARS = 8_000;

type ChatKind = "direct" | "group" | "channel" | "status";
type MessageClass = "text" | "reaction" | "call" | "status";

const REACTION_TYPES = new Set(["reaction", "reactions", "vote", "poll_vote", "poll-vote"]);
const CALL_TYPES = new Set(["call", "call_log", "call-log", "calllog"]);
const STATUS_TYPES = new Set(["status", "status_post", "status-post", "status_update", "status-update"]);
const QUOTED_KEYS = ["quotedMsg", "quoted", "quotedParticipant"];
const QUOTE_SENDER_FIELDS = ["from", "author", "participant", "senderId"];

/** The kind of chat a message id names. `status@broadcast` is a status update, not a channel. */
export function chatKindOf(chatId: string): ChatKind {
	const id = chatId.toLowerCase();
	if (id.startsWith("status@")) return "status";
	if (id.endsWith("@newsletter") || id.endsWith("@broadcast")) return "channel";
	if (id.endsWith("@g.us")) return "group";
	return "direct";
}

/** True when the text names one of `selfIds` the way a channel marks a mention (`@1555…`). */
export function mentionsSelf(text: string, selfIds: readonly string[]): boolean {
	if (text === "" || selfIds.length === 0) return false;
	for (const id of selfIds) {
		const handle = id.split("@")[0] ?? "";
		if (handle !== "" && text.includes(`@${handle}`)) return true;
		if (text.includes(id)) return true;
	}
	return false;
}

/** True when the message carries a quote of a message one of `selfIds` sent. */
export function quotesSelf(payload: unknown, selfIds: readonly string[]): boolean {
	if (selfIds.length === 0) return false;
	for (const quoted of quotedParts(payload)) {
		for (const field of QUOTE_SENDER_FIELDS) {
			const value = quoted[field];
			if (typeof value === "string" && selfIds.includes(value)) return true;
		}
	}
	return false;
}

function quotedParts(payload: unknown): Array<Record<string, unknown>> {
	const parts: Array<Record<string, unknown>> = [];
	const visit = (value: unknown, depth: number): void => {
		if (value === null || typeof value !== "object" || depth > 3) return;
		const record = value as Record<string, unknown>;
		for (const key of QUOTED_KEYS) {
			const quoted = record[key];
			if (quoted !== null && typeof quoted === "object" && !Array.isArray(quoted)) parts.push(quoted as Record<string, unknown>);
		}
		visit(record._data, depth + 1);
	};
	visit(payload, 0);
	return parts;
}

function payloadType(payload: unknown): string {
	if (payload === null || typeof payload !== "object") return "";
	const record = payload as Record<string, unknown>;
	if (typeof record.type === "string" && record.type !== "") return record.type.toLowerCase();
	const data = record._data;
	if (data !== null && typeof data === "object" && typeof (data as Record<string, unknown>).type === "string") {
		return ((data as Record<string, unknown>).type as string).toLowerCase();
	}
	return "";
}

/** What one message is for the filter, read from the channel's own type and its payload. */
export function messageClassOf(message: { type: string; payload?: unknown }): MessageClass {
	for (const type of [message.type.toLowerCase(), payloadType(message.payload)]) {
		if (type === "") continue;
		if (REACTION_TYPES.has(type)) return "reaction";
		if (CALL_TYPES.has(type)) return "call";
		if (STATUS_TYPES.has(type)) return "status";
	}
	return "text";
}

/**
 * The classifier's state for one thread: the newest messages of that thread and nothing
 * else. The question set frames the text as data to judge; this is the data.
 */
export function threadState(input: { thread: ThreadRow; messages: readonly ThreadMessage[]; now: Date }): TriageStateData {
	const recent = input.messages.slice(-STATE_MESSAGES);
	const newest = input.messages[input.messages.length - 1];
	const waiting = [...input.messages].reverse().find((message) => !message.fromMe);
	const messages: Array<{ at: string; from: "them" | "me"; type: string; text: string }> = [];
	let budget = STATE_CHARS;
	for (const message of recent) {
		const text = message.text.slice(0, Math.max(0, Math.min(STATE_MESSAGE_CHARS, budget)));
		if (text.length === 0 && budget <= 0) break;
		budget -= text.length;
		messages.push({ at: new Date(message.timestamp).toISOString(), from: message.fromMe ? "me" : "them", type: message.type, text });
	}
	return {
		thread: {
			channel: input.thread.channel,
			chat: newest === undefined ? "direct" : chatKindOf(newest.chatId),
			name: input.thread.displayName,
			messages_in_thread: input.thread.messageCount,
			waiting_minutes: waiting === undefined ? null : Math.max(0, Math.round((input.now.getTime() - waiting.timestamp) / 60_000)),
		},
		now: input.now.toISOString(),
		messages,
	};
}

function choiceOf(answers: Record<string, TriageAnswer>, name: keyof typeof TRIAGE_CHOICES): string | null {
	const answer = answers[name];
	if (answer === undefined || answer.type !== "choice" || typeof answer.choice !== "string") return null;
	return (TRIAGE_CHOICES[name] as readonly string[]).includes(answer.choice) ? answer.choice : null;
}

/** The three answers when each is inside its set, else null: an outside answer is no answer. */export function parseTriageAnswers(
	answers: Record<string, TriageAnswer>,
): { needs_reply: TriageNeedsReply; urgency: TriageUrgency; kind: TriageKind } | null {
	const needsReply = choiceOf(answers, "needs_reply");
	const urgency = choiceOf(answers, "urgency");
	const kind = choiceOf(answers, "kind");
	if (needsReply === null || urgency === null || kind === null) return null;
	return { needs_reply: needsReply as TriageNeedsReply, urgency: urgency as TriageUrgency, kind: kind as TriageKind };
}

/**
 * R3 (architect G43): a stored `needsReply: yes` applies only while the thread's newest
 * message is inbound. MG5 (the drafter) and MG7 (the page) ask the question through this
 * one function, so a thread the operator already answered from his phone stops counting as
 * needing him before the next triage pass runs.
 */
export function needsOperator(row: TriageRow | null, newest: { fromMe: boolean } | undefined): boolean {
	return row !== null && row.state === "triaged" && row.needsReply === "yes" && newest !== undefined && !newest.fromMe;
}

/**
 * One pass over the archive. Reads every thread the store lists, keeps the ones holding
 * messages newer than their last triage, runs the filter, asks the classifier once per
 * kept thread and writes one row per call.
 *
 * Two failure rules, both stated in the row's `stopReason`:
 *  - a call that ran and failed does not repeat on the same text, so a broken model
 *    cannot spend the shared classifier ceiling on the same thread every run;
 *  - a call that never ran (`ceiling`, `budget-unreadable`) leaves the text still new,
 *    so the thread is triaged once the ceiling allows it.
 */
export async function runTriage(ports: TriagePorts): Promise<TriageRun> {
	const now = ports.now?.() ?? new Date();
	const selfIds = ports.selfIds ?? [];
	const dropped: Record<DropReason, number> = {
		"own-messages": 0,
		reactions: 0,
		"status-updates": 0,
		"channels-newsletters": 0,
		"call-notices": 0,
		"group-chats": 0,
	};
	const calls: TriageCallRecord[] = [];
	let examined = 0;
	let triaged = 0;
	let untriaged = 0;

	for (const thread of ports.store.threads({ limit: ports.threadLimit ?? DEFAULT_LIST_LIMIT })) {
		const held = ports.store.triage.read(thread.channel, thread.threadId);
		const view = ports.store.readThread(thread.threadId, { limit: ports.messageLimit ?? DEFAULT_THREAD_LIMIT, channel: thread.channel });
		// `>=` on the timestamp and `!==` on the id: a message that shares the basis message's
		// second is still new, and the basis message itself never is.
		const fresh = held === null ? view.messages : view.messages.filter((message) => message.timestamp >= held.basisTimestamp && message.messageId !== held.basisMessageId);
		if (fresh.length === 0) continue;
		examined += 1;
		const newest = fresh[fresh.length - 1]!;
		const chat = chatKindOf(newest.chatId);
		if (chat === "status") {
			dropped["status-updates"] += 1;
			continue;
		}
		if (chat === "channel") {
			dropped["channels-newsletters"] += 1;
			continue;
		}
		if (chat === "group") {
			const mentioned = fresh.some((message) => mentionsSelf(message.text, selfIds));
			let quoted = false;
			if (!mentioned && selfIds.length > 0) {
				// A quote lives in the channel's payload, which a thread read does not carry: read it only here.
				const payloads = ports.store.payloads(thread.channel, thread.threadId, { limit: ports.messageLimit ?? DEFAULT_THREAD_LIMIT });
				quoted = fresh.some((message) => quotesSelf(payloads.get(message.messageId), selfIds));
			}
			if (!mentioned && !quoted) {
				dropped["group-chats"] += 1;
				continue;
			}
		}

		const inbound: ThreadMessage[] = [];
		for (const message of fresh) {
			if (message.fromMe) {
				dropped["own-messages"] += 1;
				continue;
			}
			const kind = messageClassOf(message);
			if (kind === "reaction") {
				dropped.reactions += 1;
				continue;
			}
			if (kind === "call") {
				dropped["call-notices"] += 1;
				continue;
			}
			if (kind === "status") {
				dropped["status-updates"] += 1;
				continue;
			}
			inbound.push(message);
		}
		if (inbound.length === 0) continue;

		const outcome = await ports.judge(threadState({ thread, messages: view.messages, now }));
		const answers = outcome.ok ? parseTriageAnswers(outcome.answers) : null;
		const ok = answers !== null;
		const neverRan = outcome.record.stopReason === "ceiling" || outcome.record.stopReason === "budget-unreadable";
		const basis =
			ok || !neverRan
				? { messageId: newest.messageId, timestamp: newest.timestamp }
				: { messageId: held?.basisMessageId ?? "", timestamp: held?.basisTimestamp ?? 0 };

		const row: TriageRow = {
			threadId: thread.threadId,
			channel: thread.channel,
			state: ok ? "triaged" : "untriaged",
			needsReply: answers?.needs_reply ?? null,
			urgency: answers?.urgency ?? null,
			kind: answers?.kind ?? null,
			basisMessageId: basis.messageId,
			basisTimestamp: basis.timestamp,
			questionSet: outcome.record.questionSet,
			setVersion: outcome.record.setVersion,
			triagedAt: now.toISOString(),
			model: outcome.record.model,
			stopReason: ok ? null : outcome.ok ? "answer-outside-set" : outcome.record.stopReason,
			inputTokens: outcome.record.inputTokens,
			outputTokens: outcome.record.outputTokens,
			costUsd: outcome.record.costUsd,
			stateBytes: outcome.record.stateBytes,
		};
		ports.store.triage.record(row);
		calls.push({ ...outcome.record, threadId: thread.threadId, channel: thread.channel, ok });
		if (ok) triaged += 1;
		else untriaged += 1;
	}

	return { examined, triaged, untriaged, dropped, calls };
}
