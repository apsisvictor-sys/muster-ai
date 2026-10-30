/**
 * MG6 and MG7 of the messaging agent (VR24-85 gate list point 6; blueprint G9 to G12 and G17): what
 * the command center's tailnet page asks of the messaging module. `cli/gateway.ts` wires it in, so
 * the gateway code itself imports nothing from here.
 *
 * - `list` is the waiting drafts with their text. It feeds `GET /cc/api/messages`, a route of the
 *   tailnet listener only.
 * - `panel` is the Messages panel (MG7): the connection strip, the counts, and one row per thread
 *   that needs him or whose draft was tried. The rows hold a name and a preview, so they travel on
 *   the tailnet listener only; the loopback view carries the counts and "open on the phone".
 * - `thread` is one open thread: the chat's last messages, then the draft the operator may send, change,
 *   drop or replace.
 * - `counts` is the two numbers the state panel carries on both listeners: drafts waiting, and chats
 *   triage says need him. Henry and the loopback page get these and nothing else.
 * - `tap` is the operator's Send or Don't send. It is the one place a tap on a draft's ask is built: it
 *   checks that the text the page showed (the short hash) is the stored draft's text for the chat the
 *   draft was made for, then answers the ask as `operator-page` through `answerAskResult`, the owner of
 *   the tap rules. The send gate checks all of it again before it sends.
 * - `editSend` is the operator's own text (MG7). One request: the draft of his text, its ask raised and
 *   prepared, and the tap recorded as `operator-page`, so the trail reads exactly like a draft the agent
 *   wrote and the operator approved. The agent's own draft stands down: one text waits for one chat.
 * - `redraft` asks the writer for a new draft of that thread (MG7). It withdraws the current draft's
 *   ask first and sends nothing.
 *
 * Nothing here sends. Display redaction is the handler's (`redactDeep`); the archive is unchanged, and
 * a draft of the operator's text is a row in the same `drafts` table the writer's drafts live in.
 */
import { AskStateError, answerAskResult, askCodeOf, askVersion, readAsks, withdrawAsk, type Ask, type AskQueue } from "../asks.ts";
import type {
	MessageActionResult,
	MessageDraftView,
	MessageEditSend,
	MessageRedraft,
	MessageRowState,
	MessageRowView,
	MessagesPanelView,
	MessageTap,
	MessageTapResult,
	MessagesPort,
	MessageThreadView,
} from "../gateway/command-center.ts";
import { DONT_SEND_OPTION, SEND_OPTION, liveDraftAsk, parseMessageAskSource, raiseDraftAsk, threadOfDraft } from "./approval.ts";
import { draftHash, runDrafts, sha256, threadFingerprint, validateDraft, type DraftWriter } from "./drafts.ts";
import type { DraftRow, ThreadRow } from "./messages-db.ts";
import { emptyLine, healthStrip, previewOf, rowLine } from "./panel-view.ts";
import { appendSendEvent, draftSendView, readSendLog, type DraftSendView } from "./send-log.ts";
import type { MessagingStore } from "./store.ts";

export type MessagesPortOptions = {
	/** Opens the store; the port closes it after each call. `undefined`: there is no store yet (nothing is installed), so nothing waits. */
	open: () => MessagingStore | undefined;
	/** The Muster state dir whose `asks/` queue holds the asks. */
	stateDir: string;
	/**
	 * MG7: the writer a redraft asks, resolved when it is asked (the pool's `reply` role and the headless
	 * writer), so a page load never pays for them. Absent or undefined: redraft answers 503 and writes nothing.
	 */
	drafting?: () => Promise<{ writer: DraftWriter; model: string } | undefined>;
	/** The clock the rows, the strip and the notes read; tests pin it. */
	now?: () => Date;
};

/** A draft's ask is live in these states: it waits for the operator, or he answered it and the gate has not run. */
const WAITING = new Set(["open", "awaiting-operator", "decided"]);
/** How many rows the panel shows, and how many messages an open thread carries. */
const ROW_LIMIT = 20;
const THREAD_MESSAGES = 12;
/** The model field of a draft the operator wrote himself: the drafts table records who wrote the text (G7). */
const OPERATOR_DRAFT_MODEL = "operator-page";
/** The largest text `msg-edit-send` accepts: the writer's own ceiling (drafts.ts, MAX_DRAFT_CHARS). */
const MAX_EDIT_CHARS = 65_536;

const threadKey = (channel: string, threadId: string): string => `${channel}\n${threadId}`;
const isoOf = (at: number | null | undefined): string | null => (typeof at === "number" && Number.isFinite(at) ? new Date(at).toISOString() : null);

/** The row's state, from the send log's fold and the ask that names it. One rule for the panel and the open thread. */
function rowStateOf(view: DraftSendView | undefined, ask: Ask | undefined): MessageRowState {
	if (view === undefined) return ask === undefined ? "needs-you" : "draft";
	if (view.state === "approved") return ask === undefined ? "needs-you" : "draft";
	if (view.state === "sending") return "sending";
	if (view.state === "sent" || view.state === "found") return "sent";
	if (view.state === "failed") return "failed";
	if (view.state === "unknown") return "unknown";
	// Dropped and withdrawn drafts are not rows: nothing waits on them and nothing left the account.
	return "needs-you";
}

/** What a sent, failed or unknown row says about its own attempt: never text, only the channel's codes. */
function sendFacts(view: DraftSendView | undefined): { at: string | null; ack: string | null; reason: string | null } {
	const outcome = view?.outcome;
	const at = outcome !== undefined && "at" in outcome && typeof outcome.at === "string" ? outcome.at : (view?.intentAt ?? null);
	const ack = outcome !== undefined && "ack" in outcome && typeof outcome.ack === "string" ? outcome.ack : null;
	const reason = outcome !== undefined && "reason" in outcome && typeof outcome.reason === "string" ? outcome.reason : null;
	return { at, ack, reason };
}

/** The page-facing port of the messaging module. */
export function messagesPort(options: MessagesPortOptions): MessagesPort {
	const at = (): Date => options.now?.() ?? new Date();

	const withStore = <T>(use: (store: MessagingStore) => T, absent: T): T => {
		const store = options.open();
		if (store === undefined) return absent;
		try {
			return use(store);
		} finally {
			store.close();
		}
	};

	const countsOf = (store: MessagingStore, queue: AskQueue): { draftsWaiting: number; needYou: number } => ({
		draftsWaiting: queue.asks.filter((ask) => parseMessageAskSource(ask.source) !== undefined && ask.raisedBy === "messaging" && WAITING.has(ask.status)).length,
		needYou: store.triage.list({ state: "triaged" }).filter((row) => row.needsReply === "yes").length,
	});

	/** One draft's ask per draft id, the ones still live. */
	const liveAsks = (queue: AskQueue): Map<string, Ask> => {
		const live = new Map<string, Ask>();
		for (const ask of queue.asks) {
			const named = parseMessageAskSource(ask.source);
			if (named === undefined || ask.raisedBy !== "messaging" || !WAITING.has(ask.status)) continue;
			live.set(named.draftId, ask);
		}
		return live;
	};

	const list = (): MessageDraftView[] =>
		withStore((store) => {
			const events = readSendLog(store.root);
			const views: MessageDraftView[] = [];
			for (const ask of readAsks(options.stateDir).asks) {
				const named = parseMessageAskSource(ask.source);
				if (named === undefined || ask.raisedBy !== "messaging") continue;
				if (ask.status !== "open" && ask.status !== "awaiting-operator" && ask.status !== "decided") continue;
				if (draftSendView(events, named.draftId).state !== "approved") continue;
				const draft = store.drafts.read(named.draftId);
				if (draft === null) continue;
				const thread = threadOfDraft(store, draft);
				views.push({
					draftId: draft.draftId,
					hash12: draft.hash12,
					askId: ask.id,
					code: ask.code ?? null,
					version: askVersion(ask),
					status: ask.status === "decided" ? "decided" : "waiting",
					thread: draft.threadFingerprint,
					name: thread?.displayName ?? null,
					text: draft.text,
					createdAt: draft.createdAt,
				});
			}
			return views;
		}, []);

	const counts = (): { draftsWaiting: number; needYou: number } => withStore((store) => countsOf(store, readAsks(options.stateDir)), { draftsWaiting: 0, needYou: 0 });

	/**
	 * MG7: the panel. Rows are the threads triage says need him, plus the threads whose draft was tried
	 * (sent, failed, unsure), so a send's outcome stays readable after the chat stops needing him.
	 */
	const panel = (): MessagesPanelView =>
		withStore(
			(store) => {
				const now = at();
				const events = readSendLog(store.root);
				const queue = readAsks(options.stateDir);
				const live = liveAsks(queue);
				const byId = new Map<string, ThreadRow>();
				const byFingerprint = new Map<string, ThreadRow>();
				for (const thread of store.threads({ limit: 5000 })) {
					byId.set(threadKey(thread.channel, thread.threadId), thread);
					byFingerprint.set(`${thread.channel}\n${threadFingerprint(thread.threadId)}`, thread);
				}
				type Candidate = { thread: ThreadRow; fingerprint: string; draft: DraftRow | null; needs: boolean };
				const candidates = new Map<string, Candidate>();
				const consider = (thread: ThreadRow, needs: boolean): void => {
					const key = threadKey(thread.channel, thread.threadId);
					const previous = candidates.get(key);
					if (previous !== undefined) {
						previous.needs = previous.needs || needs;
						return;
					}
					const fingerprint = threadFingerprint(thread.threadId);
					candidates.set(key, { thread, fingerprint, draft: store.drafts.latest(thread.channel, fingerprint), needs });
				};
				for (const row of store.triage.list({ state: "triaged" })) {
					if (row.needsReply !== "yes") continue;
					const thread = byId.get(threadKey(row.channel, row.threadId));
					if (thread !== undefined) consider(thread, true);
				}
				for (const draft of store.drafts.list({ limit: 50 })) {
					const state = draftSendView(events, draft.draftId).state;
					if (state === "dropped" || state === "withdrawn") continue;
					if (state === "approved" && !live.has(draft.draftId)) continue;
					const thread = byFingerprint.get(`${draft.channel}\n${draft.threadFingerprint}`);
					if (thread !== undefined) consider(thread, false);
				}
				const built: Array<{ row: MessageRowView; order: number; threadId: string }> = [];
				for (const candidate of candidates.values()) {
					const draft = candidate.draft;
					const view = draft === null ? undefined : draftSendView(events, draft.draftId);
					const ask = draft === null ? undefined : live.get(draft.draftId);
					const state = rowStateOf(view, ask);
					// A draft that was dropped or withdrawn is not a row: nothing waits on it, nothing left the account.
					const dead = view?.state === "dropped" || view?.state === "withdrawn";
					if (dead && !candidate.needs) continue;
					const facts = state === "sent" || state === "failed" || state === "unknown" ? sendFacts(view) : { at: null, ack: null, reason: null };
					const order = state === "sent" || state === "failed" || state === "unknown" ? Date.parse(facts.at ?? candidate.draft?.createdAt ?? "") || 0 : (candidate.thread.lastMessageAt ?? 0);
					built.push({
						order,
						threadId: candidate.thread.threadId,
						row: {
							thread: candidate.fingerprint,
							name: candidate.thread.displayName,
							channel: candidate.thread.channel,
							state,
							line: rowLine({ state, ...facts }),
							preview: null,
							waitingSince: state === "draft" || state === "needs-you" ? isoOf(candidate.thread.lastMessageAt) : null,
							draftId: draft === null ? null : draft.draftId,
						},
					});
				}
				built.sort((left, right) => right.order - left.order);
				const rows = built.slice(0, ROW_LIMIT).map((builtRow) => builtRow.row);
				// The preview is the newest message of the chat: one read per row, after the list is cut.
				for (let index = 0; index < rows.length; index += 1) {
					const thread = byId.get(threadKey(rows[index]!.channel, built[index]!.threadId));
					if (thread === undefined) continue;
					const newest = store.readThread(thread.threadId, { limit: 1, channel: thread.channel }).messages.at(-1);
					rows[index]!.preview = previewOf(newest?.text ?? null);
				}
				const loggedOut = queue.asks.some((ask) => ask.kind === "human-login" && ask.raisedBy === "messaging" && WAITING.has(ask.status));
				const waitingRows = rows.filter((row) => row.state === "draft" || row.state === "needs-you").length;
				return {
					strip: healthStrip({ loggedOut, lastAt: store.lastPull() }, now),
					counts: countsOf(store, queue),
					history: byId.size > 0,
					empty: emptyLine({ rows: waitingRows, history: byId.size > 0 }),
					rows,
				};
			},
			{
				strip: healthStrip({ loggedOut: false, lastAt: null }, at()),
				counts: { draftsWaiting: 0, needYou: 0 },
				history: false,
				empty: emptyLine({ rows: 0, history: false }),
				rows: [],
			},
		);

	/** MG7: one open thread, by the draft a row named. */
	const thread = (draftId: string): MessageThreadView | undefined =>
		withStore((store) => {
			const draft = store.drafts.read(draftId);
			if (draft === null) return undefined;
			const row = threadOfDraft(store, draft);
			if (row === undefined) return undefined;
			const view = draftSendView(readSendLog(store.root), draftId);
			const ask = liveDraftAsk(readAsks(options.stateDir), draftId);
			// Only an ask that waits for him carries a version: anything else is not a draft the page may act on (VR24-98 F1b).
			const version = ask !== undefined && actionable(ask) ? askVersion(ask) : "";
			const state = rowStateOf(view, ask);
			const read = store.readThread(row.threadId, { limit: THREAD_MESSAGES, channel: row.channel });
			return {
				thread: draft.threadFingerprint,
				name: row.displayName,
				channel: row.channel,
				state,
				line: rowLine({ state, ...sendFacts(view) }),
				messages: read.messages.map((message) => ({ at: new Date(message.timestamp).toISOString(), fromMe: message.fromMe, text: message.text })),
				draft: {
					draftId: draft.draftId,
					hash12: draft.hash12,
					version,
					text: draft.text,
					createdAt: draft.createdAt,
				},
			};
		}, undefined);

	const tap = (input: MessageTap): MessageTapResult =>
		withStore((store) => {
			const refuse = (status: number, error: string): MessageTapResult => ({ ok: false, status, error });
			const queue = readAsks(options.stateDir);
			const ask: Ask | undefined = liveDraftAsk(queue, input.draftId);
			if (ask === undefined || ask.raisedBy !== "messaging") return refuse(404, "no reply is waiting for that draft");
			const named = parseMessageAskSource(ask.source);
			if (named === undefined || named.hash12 !== input.hash12) return refuse(409, "this draft changed, reload");
			const draft = store.drafts.read(input.draftId);
			if (draft === null) return refuse(404, "no reply is waiting for that draft");
			const thread = threadOfDraft(store, draft);
			// The text on the page is the stored text, for the chat the draft was made for.
			if (thread === undefined || draft.hash12 !== input.hash12 || draftHash(thread.threadId, draft.text) !== draft.hash) return refuse(409, "this draft changed, reload");
			const option = input.option === "send" ? SEND_OPTION : DONT_SEND_OPTION;
			try {
				const result = answerAskResult(options.stateDir, { ref: ask.id, by: "operator-page", ruling: option, relay: input.relay, tap: { option, version: input.version }, at: input.at });
				return { ok: true, code: askCodeOf(result.ask), thread: threadFingerprint(thread.threadId), already: result.already };
			} catch (error) {
				if (!(error instanceof AskStateError)) throw error;
				return refuse(error.code === "missing" ? 404 : error.code === "invalid" ? 400 : error.code === "io" ? 502 : 409, error.message);
			}
		}, { ok: false, status: 503, error: "Messages is not available" });

	/**
	 * Stands one ask down. The queue refuses only an ask that is already closed, and it accepts one that was answered
	 * (`asks.ts:740`), so a refusal here is not the whole race: every caller re-reads the ask with `stillWaiting` directly
	 * before this, and the residual milliseconds between that read and this call belong to the asks owner (VR24-103).
	 */
	const withdrawNow = (askId: string, reason: string, when: string): { ok: true } | { ok: false; status: number; error: string } => {
		try {
			withdrawAsk(options.stateDir, { ref: askId, by: "messaging", reason, at: when });
			return { ok: true };
		} catch (error) {
			if (!(error instanceof AskStateError)) throw error;
			return { ok: false, status: error.code === "missing" ? 404 : error.code === "invalid" ? 400 : error.code === "io" ? 502 : 409, error: error.message };
		}
	};

	/**
	 * An ask these two actions may act on: it waits for the operator's answer, and for nothing else (VR24-98 F1).
	 * `decided` means he already tapped and the send gate has the text: withdrawing it there would race the gate's own send,
	 * and `done` means the ask is closed. Neither is a draft the page may change or replace.
	 */
	const actionable = (ask: Ask): boolean => ask.status === "open" || ask.status === "awaiting-operator";

	/** The fields every message action checks before anything is written: the draft waits for him and the page read it. */
	const checkable = (
		store: MessagingStore,
		input: { draftId: string; hash12: string; version: string },
	): { ok: true; ask: Ask; draft: DraftRow; thread: ThreadRow } | { ok: false; status: number; error: string } => {
		const ask = liveDraftAsk(readAsks(options.stateDir), input.draftId);
		if (ask === undefined || ask.raisedBy !== "messaging") return { ok: false, status: 404, error: "no reply is waiting for that draft" };
		if (!actionable(ask)) return { ok: false, status: 409, error: "that reply is not waiting for you any more" };
		if (askVersion(ask) !== input.version) return { ok: false, status: 409, error: "this draft changed, reload" };
		const named = parseMessageAskSource(ask.source);
		if (named === undefined || named.hash12 !== input.hash12) return { ok: false, status: 409, error: "this draft changed, reload" };
		const draft = store.drafts.read(input.draftId);
		if (draft === null) return { ok: false, status: 404, error: "no reply is waiting for that draft" };
		const thread = threadOfDraft(store, draft);
		if (thread === undefined) return { ok: false, status: 409, error: "this draft changed, reload" };
		return { ok: true, ask, draft, thread };
	};

	/**
	 * The ask as it is now, re-read straight before a withdraw (VR24-103 F1d): the operator may have tapped while a writer ran, and
	 * a `decided` ask is the send gate's to carry out. A status that is no longer waiting, or a version that is not the one the
	 * page sent, stops the action with 409 before any `withdrawn` line or second ask exists.
	 */
	const stillWaiting = (input: { draftId: string; version: string }): { ok: true; ask: Ask } | { ok: false; status: number; error: string } => {
		const ask = liveDraftAsk(readAsks(options.stateDir), input.draftId);
		if (ask === undefined) return { ok: false, status: 404, error: "no reply is waiting for that draft" };
		if (!actionable(ask)) return { ok: false, status: 409, error: "that reply is not waiting for you any more" };
		if (askVersion(ask) !== input.version) return { ok: false, status: 409, error: "this draft changed, reload" };
		return { ok: true, ask };
	};

	/**
	 * MG7: the operator's own text for one draft. The draft of his text is built the way the writer's is (its id and hash are the
	 * same function), its ask is raised and prepared, and the tap is answered as `operator-page`: the send gate then re-reads the
	 * hash from the stored text before anything leaves. The agent's ask stands down first and strictly, so the one text that
	 * can go is his, and a losing race writes nothing (VR24-98 F1).
	 */
	const editSend = (input: MessageEditSend): MessageActionResult =>
		withStore((store) => {
			const checked = checkable(store, input);
			if (!checked.ok) return { ok: false, status: checked.status, error: checked.error };
			const validation = validateDraft(input.text, { maxChars: MAX_EDIT_CHARS });
			if (!validation.ok) return { ok: false, status: 400, error: validation.detail };
			const text = validation.text;
			const hash = draftHash(checked.thread.threadId, text);
			// The same text as the draft: this is the page's Send, through the tap rule that owns it.
			if (hash === checked.draft.hash) {
				const sent = tap({ draftId: input.draftId, hash12: input.hash12, version: input.version, option: "send", relay: input.relay, at: input.at });
				return sent.ok ? { ok: true, draftId: input.draftId, thread: sent.thread, code: sent.code, already: sent.already } : { ok: false, status: sent.status, error: sent.error };
			}
			const fingerprint = threadFingerprint(checked.thread.threadId);
			const draftId = sha256(`${fingerprint}\n${checked.draft.basisMessageHash}\n${hash}`).slice(0, 16);
			const own: DraftRow = {
				draftId,
				channel: checked.draft.channel,
				threadFingerprint: fingerprint,
				hash,
				hash12: hash.slice(0, 12),
				text,
				basisTimestamp: checked.draft.basisTimestamp,
				basisMessageHash: checked.draft.basisMessageHash,
				createdAt: input.at,
				model: OPERATOR_DRAFT_MODEL,
			};
			// The agent's text is not the text being sent: its ask stands down before anything else is written, after a re-read
			// in case a tap landed since this action read it.
			const still = stillWaiting(input);
			if (!still.ok) return { ok: false, status: still.status, error: still.error };
			const stood = withdrawNow(still.ask.id, "the operator wrote his own text for this reply", input.at);
			if (!stood.ok) return { ok: false, status: stood.status, error: stood.error };
			appendSendEvent(store.root, { kind: "withdrawn", draftId: checked.draft.draftId, reason: "superseded by the operator's own text" }, new Date(input.at));
			store.drafts.record(own);
			const raised = raiseDraftAsk(options.stateDir, own, input.at);
			try {
				const result = answerAskResult(options.stateDir, {
					ref: raised.id,
					by: "operator-page",
					ruling: SEND_OPTION,
					relay: input.relay,
					tap: { option: SEND_OPTION, version: askVersion(raised) },
					at: input.at,
				});
				return { ok: true, draftId, thread: fingerprint, code: askCodeOf(result.ask), already: result.already };
			} catch (error) {
				if (!(error instanceof AskStateError)) throw error;
				return { ok: false, status: error.code === "missing" ? 404 : error.code === "invalid" ? 400 : error.code === "io" ? 502 : 409, error: error.message };
			}
		}, { ok: false, status: 503, error: "Messages is not available" });

	/**
	 * MG7: a new draft of that thread, from the writer, with the operator's one-line instruction when he gave one. The writer runs
	 * first and the old ask stands down only once the new draft exists, so a failed or empty call leaves the waiting reply
	 * exactly as it was (VR24-98 F2); nothing is sent, and the new draft's ask is what the operator taps next.
	 */
	const redraft = async (input: MessageRedraft): Promise<MessageActionResult> => {
		const store = options.open();
		if (store === undefined) return { ok: false, status: 503, error: "Messages is not available" };
		try {
			const checked = checkable(store, input);
			if (!checked.ok) return { ok: false, status: checked.status, error: checked.error };
			const wiring = options.drafting === undefined ? undefined : await options.drafting();
			if (wiring === undefined) return { ok: false, status: 503, error: "Drafting is not available" };
			const run = await runDrafts({
				store,
				writer: wiring.writer,
				model: wiring.model,
				thread: { channel: checked.thread.channel, threadId: checked.thread.threadId },
				redraft: true,
				...(input.instruction === null ? {} : { instruction: input.instruction }),
				now: () => new Date(input.at),
			});
			if (run.drafted === 0) return { ok: false, status: 502, error: "The writer produced no new draft" };
			// The call record names the draft the writer wrote: `latest` cannot separate two drafts of one chat written in the same second.
			const written = run.calls.find((call) => call.status === "written" && call.draftId !== null);
			const fresh = written === undefined || written.draftId === null ? null : store.drafts.read(written.draftId);
			if (fresh === null) return { ok: false, status: 502, error: "The writer produced no new draft" };
			// The new draft exists, so the old ask stands down; a conflict here writes no send-log line and raises no second ask.
			// A writer call can run for minutes, so the ask is re-read first: if the operator tapped it meanwhile, the send gate owns it.
			const still = stillWaiting(input);
			if (!still.ok) return { ok: false, status: still.status, error: still.error };
			const stood = withdrawNow(still.ask.id, "the operator asked for a new draft", input.at);
			if (!stood.ok) return { ok: false, status: stood.status, error: stood.error };
			appendSendEvent(store.root, { kind: "withdrawn", draftId: checked.draft.draftId, reason: "the operator asked for a new draft" }, new Date(input.at));
			const raised = raiseDraftAsk(options.stateDir, fresh, input.at);
			return { ok: true, draftId: fresh.draftId, thread: checked.draft.threadFingerprint, code: askCodeOf(raised), already: false };
		} finally {
			store.close();
		}
	};

	return { counts, list, tap, panel, thread, editSend, redraft };
}
