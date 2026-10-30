/**
 * A fake WAHA for the MG2 tests: the same endpoint shapes the adapter reads, on a
 * loopback port the test starts itself. The live container is never called (the
 * brief's hard limits), so this file *is* the contract MG2 is built and tested
 * against, and `reports/mg2-impact-map.md` lists what the first live run must confirm.
 *
 * Endpoints:
 *   GET /api/sessions/{session}                              -> { name, status }
 *   GET /api/{session}/chats/overview?limit=                  -> [{ id, name, lastMessage }]
 *   GET /api/{session}/chats/{chatId}/messages?limit=         -> messages, newest first
 *   GET /api/contacts/all?session=                            -> [{ id, name, lid? }]
 *   GET /api/files/{session}/{messageId}                      -> the bytes, or 404
 *
 * MG6 adds the writes the send gate makes, so the whole path can be tested with no live container:
 *   POST /api/sendSeen | /api/startTyping | /api/stopTyping   { session, chatId }
 *   POST /api/sendText                                        { session, chatId, text } -> the sent message
 * Each is recorded with its body in `requests`, and `sendTexts()` lists the sendText calls. `sendBehavior` makes the next
 * sendText answer a status, or drop the connection with the message sent (`drop-after-send`) or not sent (`drop-before-send`).
 *
 * Every call needs `X-Api-Key`; without it the server answers 401 as the spike saw.
 * Message ids are GOWS-serialized (`{fromMe}_{chatId}_{id}`) so the adapter's
 * normalization is exercised, and `timestamp` is in seconds as WAHA reports it.
 *
 * Fixtures are synthetic: invented ids, names and bodies only, never a real chat.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeMessage = {
	/** The GOWS-serialized id; the adapter keeps the last segment as the message id. */
	id: string;
	/** Epoch seconds, as WAHA reports it. */
	timestamp: number;
	fromMe?: boolean;
	from: string;
	body?: string;
	type?: string;
	ack?: number | string;
	/** A media url the message names, as WAHA does when it has already converted the file. */
	mediaUrl?: string;
	/** The engine's edit attribute (`_data.Info.Edit`): `"1"` an edit, `"7"` a revoke. */
	edit?: string;
};

export type FakeChat = { id: string; name?: string; messages: FakeMessage[] };

export type FakeContact = { id: string; name?: string; lid?: string };

export type FakeMedia = Record<string, { bytes: Buffer; mime: string }>;

export type FakeRequest = { method: string; path: string; authorized: boolean; body?: unknown };

/** What the next sendText does. `ok` sends; a number answers that status and sends nothing; the drops end the connection with no answer. */
export type SendBehavior = "ok" | "drop-before-send" | "drop-after-send" | number;

export type FakeWaha = {
	url: string;
	key: string;
	session: string;
	requests: FakeRequest[];
	status: string;
	/** Answers every request from here on with 503, as a restart does. */
	failAfter(count: number | null): void;
	setStatus(status: string): void;
	messagesOf(chatId: string): FakeRequest[];
	/** The sendText calls the server received, in order. */
	sendTexts(): Array<{ chatId: string; text: string }>;
	/** Every write call (`POST`), in order. */
	writes(): FakeRequest[];
	sendBehavior: SendBehavior;
	/** Epoch seconds a sent message is stamped with; a test sets it so the stamp is not the machine's clock. */
	clock: () => number;
	addMessage(chatId: string, message: FakeMessage): void;
	/** Changes a message's text and marks it edited, as the engine does. */
	editMessage(chatId: string, shortId: string, body: string): void;
	/** Takes a message out of the chat, as a revoke does. */
	removeMessage(chatId: string, shortId: string): void;
	/** Changes the delivery mark a message already holds, as an ack moving on does. */
	setAck(chatId: string, shortId: string, ack: number | string): void;
	addMedia(messageId: string, bytes: Buffer, mime: string): void;
	/** Makes the file endpoint answer this status for the message (503, 404, …). */
	refuseMedia(messageId: string, status: number): void;
	/** Lets the file endpoint answer with bytes again. */
	allowMedia(messageId: string): void;
	close(): Promise<void>;
};

export type FakeWahaOptions = {
	chats: FakeChat[];
	contacts?: FakeContact[];
	status?: string;
	media?: FakeMedia;
	key?: string;
	session?: string;
};

const SERIALIZED_ID = /^(?:true|false)_.+_([^_]+)$/;

/** The id segment a GOWS-serialized message id carries. */
export function idSegment(raw: string): string {
	return SERIALIZED_ID.exec(raw)?.[1] ?? raw;
}

/** A GOWS-serialized message id for the fixture, from the chat id and a short id. */
export function serializedId(chatId: string, short: string, fromMe = false): string {
	return `${fromMe ? "true" : "false"}_${chatId}_${short}`;
}

/** A deterministic synthetic body, so a fixture reads the same wherever it is printed. */
export function bodyId(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export async function startFakeWaha(options: FakeWahaOptions): Promise<FakeWaha> {
	const key = options.key ?? "fake-waha-key-0001";
	const session = options.session ?? "default";
	const media: FakeMedia = { ...options.media };
	const refusals = new Map<string, number>();
	const state = {
		chats: options.chats.map((chat) => ({ ...chat, messages: [...chat.messages] })),
		contacts: [...(options.contacts ?? [])],
		status: options.status ?? "WORKING",
		failAfter: null as number | null,
		count: 0,
		sent: 0,
	};
	const sentTexts: Array<{ chatId: string; text: string }> = [];

	const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => handle(request, response, Buffer.concat(chunks).toString("utf8")));
	});

	const handle = (request: IncomingMessage, response: ServerResponse, bodyText: string): void => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const authorized = request.headers["x-api-key"] === key;
		state.count += 1;
		let body: unknown;
		try {
			body = bodyText.length > 0 ? JSON.parse(bodyText) : undefined;
		} catch {
			body = undefined;
		}
		(fake.requests as FakeRequest[]).push({ method: request.method ?? "GET", path: url.pathname + url.search, authorized, ...(body !== undefined ? { body } : {}) });
		const send = (status: number, body: unknown, mime = "application/json"): void => {
			const text = typeof body === "string" ? body : JSON.stringify(body);
			response.writeHead(status, { "content-type": mime });
			response.end(text);
		};
		if (state.failAfter !== null && state.count > state.failAfter) {
			send(503, { message: "the fake WAHA is restarting" });
			return;
		}
		if (!authorized) {
			send(401, { message: "unauthorized" });
			return;
		}

		const parts = url.pathname.split("/").filter((part) => part.length > 0).map(decodeURIComponent);
		// POST /api/sendSeen | startTyping | stopTyping | sendText
		if (request.method === "POST" && parts.length === 2 && parts[0] === "api" && ["sendSeen", "startTyping", "stopTyping", "sendText"].includes(parts[1]!)) {
			const asked = (body ?? {}) as { session?: string; chatId?: string; text?: string };
			const chat = state.chats.find((one) => one.id === asked.chatId);
			if (asked.session !== session || chat === undefined) {
				send(chat === undefined ? 404 : 422, { message: chat === undefined ? "no such chat" : "unknown session" });
				return;
			}
			if (parts[1] !== "sendText") {
				send(201, { sent: true });
				return;
			}
			const behavior = fake.sendBehavior;
			fake.sendBehavior = "ok";
			if (typeof behavior === "number") {
				send(behavior, { message: "the fake WAHA refused sendText" });
				return;
			}
			if (behavior === "drop-before-send") {
				response.socket?.destroy();
				return;
			}
			const shortId = `SENT${state.sent + 1}`;
			state.sent += 1;
			const message: FakeMessage = { id: serializedId(chat.id, shortId, true), timestamp: fake.clock(), fromMe: true, from: chat.id, body: String(asked.text ?? ""), type: "chat", ack: 1 };
			chat.messages.push(message);
			sentTexts.push({ chatId: chat.id, text: String(asked.text ?? "") });
			if (behavior === "drop-after-send") {
				response.socket?.destroy();
				return;
			}
			send(201, { id: message.id, timestamp: message.timestamp, fromMe: true, body: message.body, ack: 1 });
			return;
		}
		// /api/sessions/{session}
		if (parts.length === 3 && parts[0] === "api" && parts[1] === "sessions") {
			send(200, { name: parts[2], status: state.status, engine: { ENGINE: "GOWS" } });
			return;
		}
		// /api/contacts/all?session=
		if (parts.length === 3 && parts[0] === "api" && parts[1] === "contacts" && parts[2] === "all") {
			send(200, state.contacts);
			return;
		}
		// /api/files/{session}/{messageId}
		if (parts.length === 4 && parts[0] === "api" && parts[1] === "files") {
			const refused = refusals.get(parts[3]!);
			if (refused !== undefined) {
				send(refused, { message: "the fake WAHA will not serve this file" });
				return;
			}
			const found = media[parts[3]!];
			if (found === undefined) {
				send(404, { message: "no such media" });
				return;
			}
			response.writeHead(200, { "content-type": found.mime });
			response.end(found.bytes);
			return;
		}
		// /api/{session}/chats/overview
		if (parts.length === 4 && parts[0] === "api" && parts[2] === "chats" && parts[3] === "overview") {
			const limit = Number(url.searchParams.get("limit") ?? "100");
			send(
				200,
				state.chats.slice(0, Number.isFinite(limit) ? limit : 100).map((chat) => ({
					id: chat.id,
					...(chat.name !== undefined ? { name: chat.name } : {}),
					lastMessage: chat.messages.length > 0 ? chat.messages[chat.messages.length - 1] : null,
				})),
			);
			return;
		}
		// /api/{session}/chats/{chatId}/messages
		if (parts.length === 5 && parts[0] === "api" && parts[2] === "chats" && parts[4] === "messages") {
			const chat = state.chats.find((one) => one.id === parts[3]);
			if (chat === undefined) {
				send(404, { message: "no such chat" });
				return;
			}
			const limit = Number(url.searchParams.get("limit") ?? "100");
			const newestFirst = [...chat.messages]
				.sort((left, right) => right.timestamp - left.timestamp)
				.slice(0, Number.isFinite(limit) ? limit : 100)
				.map((message) => ({
					id: message.id,
					timestamp: message.timestamp,
					fromMe: message.fromMe === true,
					from: message.from,
					...(message.body !== undefined ? { body: message.body } : {}),
					type: message.type ?? "chat",
					...(message.ack !== undefined ? { ack: message.ack } : {}),
					media: message.mediaUrl !== undefined ? { url: message.mediaUrl, mimetype: "image/png" } : null,
					_data: { key: idSegment(message.id), ...(message.edit !== undefined ? { Info: { Edit: message.edit } } : {}) },
				}));
			send(200, newestFirst);
			return;
		}
		send(404, { message: `no route for ${url.pathname}` });
	};

	const fake: FakeWaha = {
		url: "",
		key,
		session,
		requests: [],
		get status(): string {
			return state.status;
		},
		failAfter(count: number | null): void {
			state.failAfter = count;
		},
		setStatus(status: string): void {
			state.status = status;
		},
		messagesOf(chatId: string): FakeRequest[] {
			return fake.requests.filter((one) => one.path.includes(`/chats/${encodeURIComponent(chatId)}/messages`));
		},
		sendTexts(): Array<{ chatId: string; text: string }> {
			return sentTexts;
		},
		writes(): FakeRequest[] {
			return fake.requests.filter((one) => one.method === "POST");
		},
		sendBehavior: "ok",
		clock: () => Math.floor(Date.now() / 1000),
		editMessage(chatId: string, shortId: string, body: string): void {
			const message = state.chats.find((one) => one.id === chatId)?.messages.find((one) => idSegment(one.id) === shortId);
			if (message !== undefined) {
				message.body = body;
				message.edit = "1";
			}
		},
		removeMessage(chatId: string, shortId: string): void {
			const chat = state.chats.find((one) => one.id === chatId);
			if (chat !== undefined) chat.messages = chat.messages.filter((one) => idSegment(one.id) !== shortId);
		},
		addMessage(chatId: string, message: FakeMessage): void {
			const chat = state.chats.find((one) => one.id === chatId);
			if (chat !== undefined) chat.messages.push(message);
		},
		setAck(chatId: string, shortId: string, ack: number | string): void {
			const chat = state.chats.find((one) => one.id === chatId);
			const message = chat?.messages.find((one) => idSegment(one.id) === shortId);
			if (message !== undefined) message.ack = ack;
		},
		addMedia(messageId: string, bytes: Buffer, mime: string): void {
			media[idSegment(messageId)] = { bytes, mime };
		},
		refuseMedia(messageId: string, status: number): void {
			refusals.set(idSegment(messageId), status);
		},
		allowMedia(messageId: string): void {
			refusals.delete(idSegment(messageId));
		},
		async close(): Promise<void> {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address() as AddressInfo;
	(fake as { url: string }).url = `http://127.0.0.1:${address.port}`;
	return fake;
}
