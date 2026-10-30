/**
 * MG2 of the messaging agent (VR24-62, blueprint
 * `plans/orchestration-2026-10-05/specs/messaging-agent-blueprint-2026-10-25.md`,
 * rules G1, G2, G3, G4 and G13): WhatsApp, read through WAHA (engine GOWS).
 *
 * Polling for reads: `health` reads the session, `pull` reads the chat overview, the
 * messages of the chats that moved and the contact list once a day, and `readChat` (MG6)
 * reads one chat fresh for the send gate.
 *
 * `send` (MG6) is the only call that writes to the account, and the send gate is the only
 * code that calls it (G8). It posts the sequence a person produces: `sendSeen`,
 * `startTyping`, a pause proportional to the text, `sendText`, `stopTyping`. The recipient is
 * the stored `chatId` of the approved draft and nothing else. A refusal WAHA gave before it
 * sent anything is `failed` (a retry is safe); an answer that cannot say whether the message
 * left (a timeout, a connection error, a 5xx) is `unknown`, which nothing retries.
 *
 * Endpoint and field shapes come from the WAHA API of the running version as the
 * s1 report describes it (`GET /api/sessions/{session}`,
 * `GET /api/{session}/chats/overview?limit=`, `GET /api/{session}/chats/{chatId}/messages?limit=`,
 * `GET /api/contacts/all?session=`, `GET|/api/files/{session}/{messageId}`) and from
 * the fake server the lane's tests run. The live container was not called by this
 * lane; `reports/mg2-impact-map.md` lists what the orchestrator's first live run has
 * to confirm.
 *
 * Media (G2) is read *before* the caller archives a message: a message the index
 * already holds is never archived again, so a message archived without its bytes
 * could never gain them. When the bytes cannot be read, the message is not returned
 * at all and the chat's cursor stops in front of it, so the next run tries again.
 */
import type {
	ApprovedDraft,
	ChannelAdapter,
	ChannelContact,
	ChannelEvent,
	ChannelMessage,
	Cursor,
	ChatRead,
	ChatReader,
	Health,
	HealthState,
	MediaBlob,
	PullResult,
	SendOutcome,
} from "./types.ts";

/** The base URL of the WAHA server (`WAHA_URL`), loopback by default (MS1). */
export const WAHA_URL_ENV = "WAHA_URL";
/** The API key WAHA expects in `X-Api-Key` (`WAHA_API_KEY`). Read from the environment only. */
export const WAHA_KEY_ENV = "WAHA_API_KEY";
/** The WAHA session this adapter reads (`WAHA_SESSION`), `default` on this install. */
export const WAHA_SESSION_ENV = "WAHA_SESSION";
export const WAHA_DEFAULT_URL = "http://127.0.0.1:3000";
export const WAHA_DEFAULT_SESSION = "default";
/** One request's budget. A poll that hangs is a failed run, repaired by the next one. */
export const WAHA_TIMEOUT_MS = 20_000;
/** Messages read per chat per poll (the s1 report read 1 to 284 with `limit=1000`). */
export const WAHA_MESSAGE_LIMIT = 1000;
/** Chats read from the overview per poll (32 on the spike install, 500 is the API's own cap). */
export const WAHA_CHATS_LIMIT = 500;

/** Where WAHA is and how to talk to it. The key comes from the environment, never a file. */
export type WahaConfig = { url: string; apiKey: string; session: string; timeoutMs?: number };

/** The config a run uses: the environment's values, with the documented defaults. */
export function wahaConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WahaConfig {
	const url = (env[WAHA_URL_ENV] ?? "").trim();
	const apiKey = (env[WAHA_KEY_ENV] ?? "").trim();
	const session = (env[WAHA_SESSION_ENV] ?? "").trim();
	return {
		url: (url.length > 0 ? url : WAHA_DEFAULT_URL).replace(/\/+$/, ""),
		apiKey,
		session: session.length > 0 ? session : WAHA_DEFAULT_SESSION,
	};
}

/**
 * The adapter's cursor: where reading stopped in each chat, plus whether this poll
 * should also read the contact list. It is one string so the port stays
 * `pull(cursor: string | null)`.
 *
 * A chat's place is the newest message it has read — its timestamp and its id, not the
 * timestamp alone. WAHA reports time in whole seconds, so two messages share a
 * timestamp; the id says whether the poll has already taken *that* message, which means a
 * quiet chat is not read again and a message that arrived in the same second as the last
 * one is still taken.
 *
 * `giveUp` is the caller's instruction for this poll, not channel state: the message ids
 * whose media the sync has waited a day for, so this poll takes them without their bytes
 * (G2 amended, VR24-70). The adapter never carries it forward.
 */
export type WahaChatCursor = { at: number; id: string };
export type WahaCursor = {
	v: 1;
	/** `chatId` as WAHA sends it (`@c.us`, `@lid`, `@g.us`) -> the newest message read there. */
	chats: Record<string, WahaChatCursor>;
	/** True when the caller wants the contact list in this poll (once a day, G3). */
	contacts: boolean;
	/** Message ids to take without their bytes: their media hold has expired. */
	giveUp: string[];
};

function chatCursorOf(value: unknown): WahaChatCursor | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return { at: Math.round(value), id: "" };
	if (value === null || typeof value !== "object") return undefined;
	const entry = value as { at?: unknown; id?: unknown };
	const at = typeof entry.at === "number" && Number.isFinite(entry.at) && entry.at > 0 ? Math.round(entry.at) : 0;
	if (at === 0) return undefined;
	return { at, id: typeof entry.id === "string" ? entry.id : "" };
}

/** A cursor blob from its string form; `null` (nothing archived yet) means "from the beginning". */
export function parseCursor(cursor: Cursor): WahaCursor {
	if (cursor === null || cursor.trim().length === 0) return { v: 1, chats: {}, contacts: true, giveUp: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(cursor);
	} catch {
		return { v: 1, chats: {}, contacts: true, giveUp: [] };
	}
	const blob = parsed as { chats?: unknown; contacts?: unknown; giveUp?: unknown } | null;
	const chats: Record<string, WahaChatCursor> = {};
	if (blob?.chats !== null && typeof blob?.chats === "object") {
		for (const [chatId, value] of Object.entries(blob.chats as Record<string, unknown>)) {
			const place = chatCursorOf(value);
			if (chatId.length > 0 && place !== undefined) chats[chatId] = place;
		}
	}
	const giveUp = Array.isArray(blob?.giveUp) ? (blob.giveUp as unknown[]).filter((one): one is string => typeof one === "string" && one.length > 0) : [];
	return { v: 1, chats, contacts: blob?.contacts === true, giveUp };
}

/** A cursor blob as the string the store's state file holds: keys sorted, so it is stable across runs. */
export function formatCursor(cursor: WahaCursor): string {
	const chats: Record<string, WahaChatCursor> = {};
	for (const chatId of Object.keys(cursor.chats).sort()) {
		const place = cursor.chats[chatId]!;
		chats[chatId] = { at: place.at, id: place.id };
	}
	return JSON.stringify({ v: 1, chats, contacts: cursor.contacts === true, giveUp: [...cursor.giveUp].sort() });
}

/**
 * The channel's message id inside the chat. GOWS serializes it as
 * `{fromMe}_{chatId}_{id}`; the last segment is the id that stays put, so that is the
 * one the idempotency key carries (G4). A value without that shape is kept as it came.
 */
export function messageIdOf(raw: string): string {
	const match = /^(?:true|false)_.+_([^_]+)$/.exec(raw.trim());
	return match?.[1] ?? raw.trim();
}

/** A WAHA timestamp in epoch milliseconds. WAHA reports seconds; a value already in ms is kept. */
export function timestampMsOf(value: unknown): number {
	const n = typeof value === "number" ? value : typeof value === "string" && value.trim().length > 0 ? Number(value) : Number.NaN;
	if (!Number.isFinite(n) || n <= 0) return 0;
	return Math.round(n >= 1e12 ? n : n * 1000);
}

const ACK_NAMES = ["ERROR", "PENDING", "SERVER", "DEVICE", "READ"] as const;

/** A delivery mark as WAHA names it: a numeric level, or the name itself on some engines. */
export function ackNameOf(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < ACK_NAMES.length) return ACK_NAMES[value];
	if (typeof value === "string" && /^[A-Za-z]+$/.test(value.trim())) return value.trim().toUpperCase();
	return undefined;
}

/** The session status WAHA reports, as the port's health state (G13). */
export function healthStateOf(status: unknown): HealthState {
	switch (typeof status === "string" ? status.trim().toUpperCase() : "") {
		case "WORKING":
			return "working";
		case "SCAN_QR_CODE":
			return "scan-qr";
		case "FAILED":
			return "failed";
		case "STOPPED":
			return "stopped";
		default:
			return "unknown";
	}
}

/** The message types that carry bytes WAHA has to be asked for (G2). */
const MEDIA_TYPES = new Set(["image", "video", "audio", "ptt", "voice", "document", "sticker"]);

/** A contact-list id form, the only evidence that maps `@lid` onto `@c.us` (G4). */
const CONTACT_ID = /^[0-9A-Za-z._:-]+@(?:c\.us|lid|g\.us|broadcast|newsletter|s\.whatsapp\.net)$/;

/**
 * The other id forms the contact list itself shows for one person: every id-shaped
 * field of the entry except its own `id`. A form is never derived from another; this
 * only reports what the list printed.
 */
export function contactAliasesOf(contact: Record<string, unknown>): string[] {
	const own = typeof contact.id === "string" ? contact.id.trim() : "";
	const aliases = new Set<string>();
	for (const value of Object.values(contact)) {
		if (typeof value !== "string") continue;
		const form = value.trim();
		if (form === own || !CONTACT_ID.test(form)) continue;
		aliases.add(form);
	}
	return [...aliases].sort();
}

/** A request WAHA refused or could not answer. Never carries the key. */
export class WahaHttpError extends Error {
	constructor(
		readonly status: number,
		readonly path: string,
		readonly body: string,
	) {
		super(`messaging whatsapp: WAHA answered ${status} for ${path}${body.length > 0 ? `: ${body.slice(0, 200)}` : ""}`);
		this.name = "WahaHttpError";
	}
}

/** The WAHA wire, as four reads: JSON, bytes, and nothing else. */
type WahaHttp = {
	json<T>(path: string): Promise<T>;
	binary(path: string): Promise<{ bytes: Uint8Array; mime?: string }>;
	/** A write: the response as WAHA gave it, so the caller can tell a refusal from a silence. */
	post(path: string, body: unknown): Promise<Response>;
};

function wahaHttp(config: WahaConfig, fetchImpl: typeof fetch): WahaHttp {
	const call = async (path: string): Promise<Response> => {
		if (config.apiKey.length === 0) throw new Error(`messaging whatsapp: ${WAHA_KEY_ENV} is not set`);
		return fetchImpl(`${config.url}${path}`, {
			headers: { "X-Api-Key": config.apiKey, accept: "application/json" },
			signal: AbortSignal.timeout(config.timeoutMs ?? WAHA_TIMEOUT_MS),
		});
	};
	const fail = async (response: Response, path: string): Promise<never> => {
		const body = await response.text().catch(() => "");
		throw new WahaHttpError(response.status, path, body.trim());
	};
	return {
		async post(path: string, body: unknown): Promise<Response> {
			if (config.apiKey.length === 0) throw new Error(`messaging whatsapp: ${WAHA_KEY_ENV} is not set`);
			return fetchImpl(`${config.url}${path}`, {
				method: "POST",
				headers: { "X-Api-Key": config.apiKey, accept: "application/json", "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(config.timeoutMs ?? WAHA_TIMEOUT_MS),
			});
		},
		async json<T>(path: string): Promise<T> {
			const response = await call(path);
			if (!response.ok) return fail(response, path);
			return (await response.json()) as T;
		},
		async binary(path: string): Promise<{ bytes: Uint8Array; mime?: string }> {
			const response = await call(path);
			if (!response.ok) return fail(response, path);
			const mime = response.headers.get("content-type")?.split(";")[0]?.trim();
			const bytes = new Uint8Array(await response.arrayBuffer());
			return { bytes, ...(mime !== undefined && mime.length > 0 ? { mime } : {}) };
		},
	};
}

/** A WAHA message, as far as this adapter reads it. Everything else is kept in `payload`. */
export type WahaMessage = {
	id?: string;
	timestamp?: number | string;
	fromMe?: boolean;
	from?: string;
	to?: string;
	body?: string;
	type?: string;
	ack?: number | string;
	media?: { url?: string; mimetype?: string; filename?: string } | null;
	_data?: unknown;
};

/** A chat from the overview endpoint. */
type WahaChat = { id?: string; name?: string | null; lastMessage?: WahaMessage | null };

/** A contact-list entry. */
type WahaContact = { id?: string; name?: string | null; pushname?: string | null; [field: string]: unknown };

/** One message whose bytes could not be copied this run: it is held back and retried. */
export type MediaFailure = { chatId: string; messageId: string; reason: string };

/**
 * One message archived without its bytes (G2 amended, VR24-70): `gone` when WAHA says the
 * file is not there any more (404 or 410), `expired` when the hold of a failing fetch ran
 * out after a day. The caller appends one `media-missing` event carrying this code.
 */
export type MediaMissing = { chatId: string; messageId: string; reason: "gone" | "expired" };

/**
 * Whether two urls share an origin, compared as parsed urls: `http://waha` is not the
 * origin of `http://waha.example`, so the key never leaves for another host.
 */
export function sameOriginAs(url: string, base: string): boolean {
	try {
		return new URL(url).origin === new URL(base).origin;
	} catch {
		return false;
	}
}

/** Whether a failed media read means the file is not there any more, rather than "not now". */
export function mediaGoneOf(error: unknown): boolean {
	return error instanceof WahaHttpError && (error.status === 404 || error.status === 410);
}

export type WahaAdapterOptions = {
	config: WahaConfig;
	/** The transport; a test passes its own or none. */
	fetch?: typeof fetch;
	/** The clock, for `checkedAt` and the ack events' `at`. */
	now?: () => number;
	messageLimit?: number;
	chatsLimit?: number;
	/** Called for every message whose media could not be copied this run (ids and a reason only). */
	onMediaFailure?: (failure: MediaFailure) => void;
	/** Called for every message this poll takes without its bytes, the reason a code. */
	onMediaMissing?: (missing: MediaMissing) => void;
	/** How long the typing indicator shows before `sendText`, from the text (MG6, G8). */
	typingDelayMs?: (text: string) => number;
	/** The wait itself; a test passes one that returns at once. */
	sleep?: (ms: number) => Promise<void>;
};

/** A person types about 40 ms a character; the pause is that, kept between 0.8 and 8 seconds. */
export function defaultTypingDelayMs(text: string): number {
	return Math.min(8_000, Math.max(800, text.length * 40));
}

const defaultSleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** One reference to a message this account sent, the input of the delivery re-read (G3). */
export type SentRef = { chatId: string; messageId: string };

/**
 * The WhatsApp adapter: the port's three calls, over WAHA, read-only.
 *
 * `pull` reads the session's chats, and for each chat whose newest message is newer
 * than its cursor, that chat's messages. Media (G2) is fetched here, before the
 * caller archives the message; a chat whose media could not be read stops there.
 */
export function createWahaAdapter(options: WahaAdapterOptions): ChannelAdapter & ChatReader {
	const config = options.config;
	const http = wahaHttp(config, options.fetch ?? fetch);
	const now = options.now ?? (() => Date.now());
	const messageLimit = options.messageLimit ?? WAHA_MESSAGE_LIMIT;
	const chatsLimit = options.chatsLimit ?? WAHA_CHATS_LIMIT;
	const session = encodeURIComponent(config.session);

	const chats = async (): Promise<WahaChat[]> => {
		const body = await http.json<WahaChat[] | { chats?: WahaChat[] }>(`/api/${session}/chats/overview?limit=${chatsLimit}`);
		return Array.isArray(body) ? body : (body.chats ?? []);
	};

	const messagesOf = async (chatId: string): Promise<WahaMessage[]> => {
		const path = `/api/${session}/chats/${encodeURIComponent(chatId)}/messages?limit=${messageLimit}&downloadMedia=false`;
		try {
			const body = await http.json<WahaMessage[] | { messages?: WahaMessage[] }>(path);
			return Array.isArray(body) ? body : (body.messages ?? []);
		} catch (error) {
			// A chat the store no longer holds is nothing to read, not a failed run.
			if (error instanceof WahaHttpError && error.status === 404) return [];
			throw error;
		}
	};

	const contactsOf = async (): Promise<ChannelContact[]> => {
		const body = await http.json<WahaContact[] | { contacts?: WahaContact[] }>(`/api/contacts/all?session=${session}`);
		const list = Array.isArray(body) ? body : (body.contacts ?? []);
		const contacts: ChannelContact[] = [];
		for (const entry of list) {
			const contactId = typeof entry.id === "string" ? entry.id.trim() : "";
			if (contactId.length === 0) continue;
			const named = [entry.name, entry.pushname].find((value) => typeof value === "string" && value.trim().length > 0);
			const name = typeof named === "string" ? named.trim() : undefined;
			const aliases = contactAliasesOf(entry as Record<string, unknown>);
			contacts.push({
				contactId,
				...(aliases.length > 0 ? { aliases } : {}),
				...(name !== undefined ? { name } : {}),
				payload: entry,
			});
		}
		return contacts;
	};

	/**
	 * The bytes of one message's media. WAHA answers the file endpoint with the file
	 * itself, or with JSON that names a `url`; an inline `data:` url is decoded here,
	 * and a url on WAHA's own origin is fetched. Nothing outside the configured server
	 * is called.
	 */
	const mediaOf = async (messageId: string, entry: WahaMessage): Promise<MediaBlob> => {
		const declared = entry.media ?? undefined;
		const inline = typeof declared?.url === "string" ? declared.url : "";
		const fromInline = inline.startsWith("data:") ? decodeDataUrl(inline) : undefined;
		if (fromInline !== undefined) {
			return { bytes: fromInline.bytes, ...mimeAndName(fromInline.mime ?? declared?.mimetype, declared?.filename) };
		}
		if (inline.length > 0 && sameOriginAs(inline, config.url)) {
			const response = await (options.fetch ?? fetch)(inline, {
				headers: { "X-Api-Key": config.apiKey },
				signal: AbortSignal.timeout(config.timeoutMs ?? WAHA_TIMEOUT_MS),
			});
			if (!response.ok) throw new WahaHttpError(response.status, "/media", "");
			return {
				bytes: new Uint8Array(await response.arrayBuffer()),
				...mimeAndName(response.headers.get("content-type") ?? declared?.mimetype, declared?.filename),
			};
		}
		const path = `/api/files/${session}/${encodeURIComponent(messageId)}`;
		const file = await http.binary(path);
		return { bytes: file.bytes, ...mimeAndName(file.mime ?? declared?.mimetype, declared?.filename) };
	};

	/**
	 * One chat, read fresh for the send gate (G8 step 4): its messages as the channel holds them
	 * now, and an edit or revoke event for each message that carries the channel's mark of one.
	 * A chat WAHA no longer holds reads as empty, which the gate treats as a basis that is gone.
	 */
	const readChat = async (chatId: string): Promise<ChatRead> => {
		const entries = await messagesOf(chatId);
		const messages: ChannelMessage[] = [];
		const events: ChannelEvent[] = [];
		const at = new Date(now()).toISOString();
		for (const entry of entries) {
			const timestamp = timestampMsOf(entry.timestamp);
			const messageId = messageIdOf(String(entry.id ?? ""));
			if (timestamp === 0 || messageId.length === 0) continue;
			messages.push(toChannelMessage(entry, chatId, messageId, timestamp));
			const mark = editMarkOf(entry);
			if (mark !== undefined) {
				events.push({ chatId, messageId, event: mark, at, ...(mark === "edited" && typeof entry.body === "string" ? { text: entry.body } : {}) });
			}
		}
		return { messages, events };
	};

	/**
	 * The one write (MG6, G8): the sequence a person produces, to the draft's own `chatId`.
	 * `sendSeen` and `startTyping` are courtesy calls, so a failure of either is not a reason to
	 * stop; `sendText` decides the outcome. WAHA refusing with a 4xx means nothing left the
	 * account (`failed`, a retry is safe). Anything that cannot say so, a timeout, a dropped
	 * connection or a 5xx, is `unknown`.
	 */
	const send = async (draft: ApprovedDraft): Promise<SendOutcome> => {
		const sleep = options.sleep ?? defaultSleep;
		const target = { session: config.session, chatId: draft.chatId };
		const quiet = async (path: string): Promise<void> => {
			try {
				await http.post(path, target);
			} catch {
				// A courtesy call that fails does not change what is sent.
			}
		};
		const at = (): string => new Date(now()).toISOString();
		await quiet("/api/sendSeen");
		await quiet("/api/startTyping");
		await sleep((options.typingDelayMs ?? defaultTypingDelayMs)(draft.text));
		let response: Response;
		try {
			response = await http.post("/api/sendText", { ...target, text: draft.text });
		} catch (error) {
			await quiet("/api/stopTyping");
			return { state: "unknown", at: at(), reason: `WAHA did not answer sendText (${error instanceof Error ? error.name : "error"})` };
		}
		await quiet("/api/stopTyping");
		if (response.ok) {
			const sent = await response.json().catch(() => undefined);
			const id = sentMessageId(sent);
			const ack = ackNameOf((sent as { ack?: unknown } | undefined)?.ack);
			return { state: "sent", at: at(), ...(id !== undefined ? { messageId: id } : {}), ...(ack !== undefined ? { ack } : {}) };
		}
		await response.text().catch(() => "");
		const refused = response.status >= 400 && response.status < 500 && response.status !== 408;
		return { state: refused ? "failed" : "unknown", at: at(), reason: `WAHA answered ${response.status} for sendText` };
	};

	const pull = async (cursor: Cursor): Promise<PullResult> => {
		const state = parseCursor(cursor);
		const contacts = state.contacts ? await contactsOf() : undefined;
		const messages: ChannelMessage[] = [];
		const next: WahaCursor = { v: 1, chats: { ...state.chats }, contacts: false, giveUp: [] };

		for (const chat of await chats()) {
			const chatId = typeof chat.id === "string" ? chat.id.trim() : "";
			if (chatId.length === 0) continue;
			const since = state.chats[chatId];
			const newest = timestampMsOf(chat.lastMessage?.timestamp);
			const newestId = messageIdOf(String(chat.lastMessage?.id ?? ""));
			// This chat has nothing after the place reading stopped at, so it is not read again.
			if (since !== undefined && newest !== 0 && (newest < since.at || (newest === since.at && newestId === since.id))) {
				next.chats[chatId] = since;
				continue;
			}

			const ordered = [...(await messagesOf(chatId))].sort(
				(left, right) => timestampMsOf(left.timestamp) - timestampMsOf(right.timestamp) || String(left.id ?? "").localeCompare(String(right.id ?? "")),
			);
			let advanced = since;
			for (const entry of ordered) {
				const timestamp = timestampMsOf(entry.timestamp);
				if (timestamp === 0) continue;
				const messageId = messageIdOf(String(entry.id ?? ""));
				if (messageId.length === 0) continue;
				// The message the last poll stopped at is not taken twice; one in the same second is.
				if (since !== undefined && (timestamp < since.at || (timestamp === since.at && messageId === since.id))) continue;
				if (MEDIA_TYPES.has(String(entry.type ?? "").toLowerCase())) {
					const giveUp = state.giveUp.includes(messageId);
					try {
						const bytes = await mediaOf(messageId, entry);
						messages.push(toChannelMessage(entry, chatId, messageId, timestamp, bytes));
					} catch (error) {
						if (mediaGoneOf(error) || giveUp) {
							// G2 amended (VR24-70): a file WAHA no longer holds, or one the sync waited a day
							// for, does not hold the chat. The message is archived without its bytes, its WAHA
							// media fields stay in the payload, and one `media-missing` event says why.
							messages.push(toChannelMessage(entry, chatId, messageId, timestamp));
							options.onMediaMissing?.({ chatId, messageId, reason: mediaGoneOf(error) ? "gone" : "expired" });
						} else {
							// A passing failure: the message is held back and the chat's cursor stops in
							// front of it, so the next run tries again.
							options.onMediaFailure?.({ chatId, messageId, reason: errorText(error) });
							break;
						}
					}
					advanced = { at: timestamp, id: messageId };
					continue;
				}
				messages.push(toChannelMessage(entry, chatId, messageId, timestamp));
				advanced = { at: timestamp, id: messageId };
			}
			if (advanced !== undefined) next.chats[chatId] = advanced;
		}

		return { messages, cursor: formatCursor(next), ...(contacts !== undefined ? { contacts } : {}) };
	};

	return {
		id: "whatsapp",
		pull,
		health: async (): Promise<Health> => {
			const session_ = await http.json<{ name?: string; status?: string }>(`/api/sessions/${session}`);
			const status = typeof session_.status === "string" ? session_.status.trim() : "UNKNOWN";
			return { state: healthStateOf(status), checkedAt: new Date(now()).toISOString(), detail: status };
		},
		readChat,
		send,
	};
}

/**
 * The delivery re-read of G3: for the messages this account sent in the last day, the
 * mark WAHA now holds (sent, delivered, read) as one `ack` event each. The list comes
 * from the send gate (MG6) through the sync state; this function only reads.
 *
 * A message whose chat cannot be read is left out of the answer; a message with no
 * mark is left out too. Repeats are the caller's business: an event is appended only
 * when the mark changed.
 */
export function createWahaAckReader(options: WahaAdapterOptions): (sent: readonly SentRef[]) => Promise<ChannelEvent[]> {
	const config = options.config;
	const http = wahaHttp(config, options.fetch ?? fetch);
	const now = options.now ?? (() => Date.now());
	const messageLimit = options.messageLimit ?? WAHA_MESSAGE_LIMIT;
	const session = encodeURIComponent(config.session);

	return async (sent: readonly SentRef[]): Promise<ChannelEvent[]> => {
		const wanted = new Map<string, Set<string>>();
		for (const ref of sent) {
			const wantedHere = wanted.get(ref.chatId) ?? new Set<string>();
			wantedHere.add(messageIdOf(ref.messageId));
			wanted.set(ref.chatId, wantedHere);
		}
		const events: ChannelEvent[] = [];
		const at = new Date(now()).toISOString();
		for (const [chatId, ids] of wanted) {
			const path = `/api/${session}/chats/${encodeURIComponent(chatId)}/messages?limit=${messageLimit}&downloadMedia=false`;
			const body = await http.json<WahaMessage[] | { messages?: WahaMessage[] }>(path);
			for (const entry of Array.isArray(body) ? body : (body.messages ?? [])) {
				const messageId = messageIdOf(String(entry.id ?? ""));
				if (!ids.has(messageId)) continue;
				const ack = ackNameOf(entry.ack);
				if (ack === undefined) continue;
				events.push({ chatId, messageId, event: "ack", at, payload: { ack } });
			}
		}
		return events;
	};
}

/** The id WAHA's `sendText` answer names, as the short id the archive keeps. */
function sentMessageId(sent: unknown): string | undefined {
	if (sent === null || typeof sent !== "object") return undefined;
	const id = (sent as { id?: unknown }).id;
	if (typeof id === "string" && id.trim().length > 0) return messageIdOf(id);
	if (id !== null && typeof id === "object") {
		const inner = id as { _serialized?: unknown; id?: unknown };
		if (typeof inner.id === "string" && inner.id.trim().length > 0) return inner.id.trim();
		if (typeof inner._serialized === "string" && inner._serialized.trim().length > 0) return messageIdOf(inner._serialized);
	}
	return undefined;
}

/**
 * The channel's own mark that a message was edited or revoked, from a fresh read. GOWS reports
 * the engine's edit attribute in `_data.Info.Edit` (`1` an edit, `7` and `8` a revoke); a
 * `revoked` or `edited` flag on the message is read the same way. Neither shape has been seen
 * on this install (the blueprint's G3 note), so the send gate also compares the basis message's
 * text with the archive's and treats a missing basis as revoked: this function is one of three
 * ways the gate learns of a change, not the only one.
 */
function editMarkOf(entry: WahaMessage): "edited" | "revoked" | undefined {
	const record = entry as Record<string, unknown>;
	const info = (entry._data as { Info?: { Edit?: unknown } } | undefined)?.Info;
	const edit = typeof info?.Edit === "string" ? info.Edit : typeof info?.Edit === "number" ? String(info.Edit) : "";
	if (edit === "7" || edit === "8") return "revoked";
	if (record["revoked"] === true || record["isRevoked"] === true || String(entry.type ?? "").toLowerCase() === "revoked") return "revoked";
	if (edit === "1" || record["edited"] === true || record["isEdited"] === true) return "edited";
	return undefined;
}

function toChannelMessage(entry: WahaMessage, chatId: string, messageId: string, timestamp: number, media?: MediaBlob): ChannelMessage {
	const senderId = typeof entry.from === "string" && entry.from.trim().length > 0 ? entry.from.trim() : undefined;
	return {
		chatId,
		messageId,
		timestamp,
		fromMe: entry.fromMe === true,
		...(senderId !== undefined ? { senderId } : {}),
		type: typeof entry.type === "string" && entry.type.trim().length > 0 ? entry.type.trim() : "unknown",
		...(typeof entry.body === "string" ? { text: entry.body } : {}),
		payload: entry,
		source: "channel",
		...(media !== undefined ? { media } : {}),
	};
}

function decodeDataUrl(url: string): { bytes: Uint8Array; mime?: string } | undefined {
	const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
	if (match === null) return undefined;
	const mime = match[1];
	const payload = match[3] ?? "";
	const bytes = match[2] === ";base64" ? new Uint8Array(Buffer.from(payload, "base64")) : new Uint8Array(Buffer.from(decodeURIComponent(payload), "utf8"));
	return { bytes, ...(mime !== undefined && mime.length > 0 ? { mime } : {}) };
}

function mimeAndName(mime: string | undefined, filename: string | undefined): { mime?: string; filename?: string } {
	const clean = (value: string | undefined): string | undefined => {
		const trimmed = (value ?? "").split(";")[0]?.trim() ?? "";
		return trimmed.length > 0 ? trimmed : undefined;
	};
	const named = filename?.trim();
	return { ...(clean(mime) !== undefined ? { mime: clean(mime) } : {}), ...(named !== undefined && named.length > 0 ? { filename: named } : {}) };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
