import "./muster-test-isolation.ts";
/**
 * MG2 (messaging agent, VR24-62, rules G1, G2, G3, G4, G13): the WhatsApp adapter
 * over a fake WAHA.
 *
 * The contract:
 *  - `pull` reads the session's chats and, for each chat whose newest message is newer
 *    than that chat's cursor, its messages; a chat that has not moved is not read again;
 *  - media is fetched before the caller can archive the message, and its bytes carry the
 *    hash the archive will store;
 *  - the contact list arrives with the other id forms the list printed, the only evidence
 *    that maps `@lid` onto `@c.us`;
 *  - `send` is not part of this lane: it throws and makes no request at all;
 *  - the delivery re-read reports the mark of the messages this account sent.
 *
 * Every call goes through `X-Api-Key`; fixtures are synthetic.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";

import {
	WAHA_DEFAULT_SESSION,
	WAHA_DEFAULT_URL,
	WAHA_KEY_ENV,
	ackNameOf,
	contactAliasesOf,
	createWahaAckReader,
	createWahaAdapter,
	formatCursor,
	healthStateOf,
	mediaGoneOf,
	messageIdOf,
	parseCursor,
	sameOriginAs,
	timestampMsOf,
	wahaConfigFromEnv,
	WahaHttpError,
	type MediaMissing,
} from "../messaging/whatsapp.ts";
import { serializedId, startFakeWaha, type FakeChat } from "./messaging-fake-waha.ts";

const PHONE = "15550001111@c.us";
const GROUP = "120363000000000001@g.us";
const LID = "900000000000001@lid";
const NAME = "Fixture Person";
const IMAGE_BYTES = Buffer.from("synthetic-image-bytes-0001", "utf8");

function chats(): FakeChat[] {
	return [
		{
			id: PHONE,
			name: NAME,
			messages: [
				{ id: serializedId(PHONE, "A0001"), timestamp: 1_700_000_000, from: PHONE, body: "fixture one", type: "chat" },
				{ id: serializedId(PHONE, "A0002"), timestamp: 1_700_000_100, from: PHONE, body: "fixture two", type: "image" },
			],
		},
		{
			id: GROUP,
			messages: [{ id: serializedId(GROUP, "B0001"), timestamp: 1_700_000_050, from: PHONE, body: "fixture three", type: "chat" }],
		},
	];
}

async function withFake(run: (fake: Awaited<ReturnType<typeof startFakeWaha>>) => Promise<void>): Promise<void> {
	const fake = await startFakeWaha({
		chats: chats(),
		contacts: [{ id: PHONE, name: NAME, lid: LID }],
		media: { A0002: { bytes: IMAGE_BYTES, mime: "image/png" } },
	});
	try {
		await run(fake);
	} finally {
		await fake.close();
	}
}

test("whatsapp: pull reads the chats that moved, with media fetched before the archive sees the message", async () => {
	await withFake(async (fake) => {
		const adapter = createWahaAdapter({ config: { url: fake.url, apiKey: fake.key, session: fake.session } });
		assert.equal(adapter.id, "whatsapp");
		const first = await adapter.pull(null);

		assert.deepEqual(
			first.messages.map((one) => one.chatId),
			[PHONE, PHONE, GROUP],
			"the messages of both chats, oldest first inside a chat",
		);
		const image = first.messages.find((one) => one.messageId === "A0002");
		assert.ok(image !== undefined, "the image message is archived");
		assert.ok(image.media !== undefined, "the image bytes come with the message, not after it");
		assert.equal(createHash("sha256").update(image.media.bytes).digest("hex"), createHash("sha256").update(IMAGE_BYTES).digest("hex"), "the copied bytes are the file");
		assert.equal(image.media.mime, "image/png");
		assert.deepEqual(
			first.messages.map((one) => one.messageId),
			["A0001", "A0002", "B0001"],
			"the GOWS-serialized id keeps only the stable last segment",
		);
		assert.equal(first.messages[0]?.timestamp, 1_700_000_000_000, "seconds become epoch milliseconds");
		assert.deepEqual(first.contacts?.map((one) => one.contactId), [PHONE]);
		assert.deepEqual(first.contacts?.[0]?.aliases, [LID], "the other id form the list printed is kept");
		assert.equal(first.contacts?.[0]?.name, NAME);
		assert.ok(fake.requests.every((one) => one.authorized), "every call carries X-Api-Key");

		// The cursor it handed back is the newest message it read, per chat id.
		const cursor = parseCursor(first.cursor);
		assert.deepEqual(cursor.chats[PHONE], { at: 1_700_000_100_000, id: "A0002" });
		assert.deepEqual(cursor.chats[GROUP], { at: 1_700_000_050_000, id: "B0001" });
		assert.equal(cursor.contacts, false, "the contact list is not read twice in a row");
	});
});

test("whatsapp: a chat whose newest message is older than its cursor is not read again", async () => {
	await withFake(async (fake) => {
		const adapter = createWahaAdapter({ config: { url: fake.url, apiKey: fake.key, session: fake.session } });
		const first = await adapter.pull(null);
		const before = fake.requests.length;

		const second = await adapter.pull(first.cursor);
		assert.deepEqual(second.messages, [], "nothing was said after the message the first pull stopped at");
		assert.equal(second.contacts, undefined, "and the contact list is not read again");
		assert.equal(fake.requests.length, before + 1, "only the overview is read: no per-chat message call");

		fake.addMessage(PHONE, { id: serializedId(PHONE, "A0003"), timestamp: 1_700_000_200, from: PHONE, body: "fixture four", type: "chat" });
		const third = await adapter.pull(first.cursor);
		assert.deepEqual(third.messages.map((one) => one.messageId), ["A0003"], "only the chat that moved is read");
	});
});

test("whatsapp: a passing media failure holds the message and its chat's cursor in front of it", async () => {
	const fake = await startFakeWaha({ chats: chats(), contacts: [{ id: PHONE, name: NAME, lid: LID }] });
	try {
		const failures: { chatId: string; messageId: string }[] = [];
		const missing: MediaMissing[] = [];
		fake.addMedia("A0002", IMAGE_BYTES, "image/png");
		fake.refuseMedia("A0002", 503);
		const adapter = createWahaAdapter({
			config: { url: fake.url, apiKey: fake.key, session: fake.session },
			onMediaFailure: (failure) => failures.push({ chatId: failure.chatId, messageId: failure.messageId }),
			onMediaMissing: (one) => missing.push(one),
		});
		const first = await adapter.pull(null);
		assert.deepEqual(first.messages.map((one) => one.messageId), ["A0001", "B0001"], "the chat stops at the message whose media is not readable now");
		assert.deepEqual(failures, [{ chatId: PHONE, messageId: "A0002" }]);
		assert.deepEqual(missing, [], "a failure that may pass is not a missing file");

		fake.allowMedia("A0002");
		const second = await adapter.pull(first.cursor);
		assert.deepEqual(second.messages.map((one) => one.messageId), ["A0002"], "the next run takes it, with the bytes");
		assert.equal(failures.length, 1, "and reports no second failure");
	} finally {
		await fake.close();
	}
});

test("whatsapp: a file WAHA no longer holds (404) is archived without bytes and reported as gone, and the chat reads on", async () => {
	const three: FakeChat[] = [
		{
			id: PHONE,
			name: NAME,
			messages: [
				{ id: serializedId(PHONE, "A0001"), timestamp: 1_700_000_000, from: PHONE, body: "fixture one" },
				{ id: serializedId(PHONE, "A0002"), timestamp: 1_700_000_100, from: PHONE, body: "fixture two", type: "image" },
				{ id: serializedId(PHONE, "A0003"), timestamp: 1_700_000_200, from: PHONE, body: "fixture three" },
			],
		},
	];
	const fake = await startFakeWaha({ chats: three });
	try {
		fake.refuseMedia("A0002", 404);
		const missing: MediaMissing[] = [];
		const failures: unknown[] = [];
		const adapter = createWahaAdapter({
			config: { url: fake.url, apiKey: fake.key, session: fake.session },
			onMediaFailure: (failure) => failures.push(failure),
			onMediaMissing: (one) => missing.push(one),
		});
		const pulled = await adapter.pull(null);
		assert.deepEqual(pulled.messages.map((one) => one.messageId), ["A0001", "A0002", "A0003"], "the messages around the missing file are read, and the chat does not stop");
		assert.equal(pulled.messages[1]?.media, undefined, "the message is archived without bytes");
		assert.deepEqual(missing, [{ chatId: PHONE, messageId: "A0002", reason: "gone" }], "one report, with a reason code");
		assert.deepEqual(failures, [], "and it is not held");
		assert.deepEqual(parseCursor(pulled.cursor).chats[PHONE], { at: 1_700_000_200_000, id: "A0003" }, "the cursor moved past it");
	} finally {
		await fake.close();
	}
});

test("whatsapp: a media url on another origin is never fetched, so the key stays with WAHA", async () => {
	const chatsWithUrl: FakeChat[] = [
		{
			id: PHONE,
			messages: [
				{ id: serializedId(PHONE, "A0002"), timestamp: 1_700_000_100, from: PHONE, type: "image", mediaUrl: "EVIL/media/x.png" },
			],
		},
	];
	const fake = await startFakeWaha({ chats: chatsWithUrl, media: { A0002: { bytes: IMAGE_BYTES, mime: "image/png" } } });
	try {
		// The message names a url whose text starts with WAHA's url, as `http://waha` + `.example` does.
		chatsWithUrl[0]!.messages[0]!.mediaUrl = `${fake.url}.evil.example/media/x.png`;
		const called: string[] = [];
		const guarded: typeof fetch = (input, init) => {
			const url = String(input);
			called.push(url);
			if (!url.startsWith(fake.url) || url.startsWith(`${fake.url}.`)) throw new Error(`the adapter called another origin: ${url}`);
			return fetch(input, init);
		};
		const adapter = createWahaAdapter({ config: { url: fake.url, apiKey: fake.key, session: fake.session }, fetch: guarded });
		const pulled = await adapter.pull(null);
		assert.equal(pulled.messages.length, 1, "the message is read through WAHA's own file endpoint");
		assert.ok(pulled.messages[0]?.media !== undefined, "with its bytes");
		assert.ok(!called.some((url) => url.includes("evil.example")), "no call ever went to the look-alike host");
		assert.equal((pulled.messages[0]?.payload as { media?: { url?: string } }).media?.url, `${fake.url}.evil.example/media/x.png`, "the WAHA media fields stay in the payload as they came");
	} finally {
		await fake.close();
	}
});

test("whatsapp: send makes the four calls of a person typing, in order, and sends the text to the chat it was given (MG6)", async () => {
	await withFake(async (fake) => {
		const adapter = createWahaAdapter({ config: { url: fake.url, apiKey: fake.key, session: fake.session }, typingDelayMs: () => 0, sleep: async () => {} });
		await adapter.pull(null);
		const before = fake.requests.length;
		const outcome = await adapter.send({ draftId: "d1", chatId: PHONE, text: "fixture reply", hash: "h" });
		assert.equal(outcome.state, "sent");
		assert.deepEqual(
			fake.requests.slice(before).map((one) => `${one.method} ${one.path}`),
			["POST /api/sendSeen", "POST /api/startTyping", "POST /api/sendText", "POST /api/stopTyping"],
		);
		assert.deepEqual(fake.sendTexts(), [{ chatId: PHONE, text: "fixture reply" }]);
	});
});

test("whatsapp: the four send bodies match WAHA's own request schemas (MG6 M1, waha-send-schema.json)", async () => {
	type Field = { type: string; required: boolean };
	const schema = JSON.parse(readFileSync(new URL("../messaging/waha-send-schema.json", import.meta.url), "utf8")) as {
		calls: Record<string, { path: string; fields: Record<string, Field> }>;
	};
	await withFake(async (fake) => {
		const adapter = createWahaAdapter({ config: { url: fake.url, apiKey: fake.key, session: fake.session }, typingDelayMs: () => 0, sleep: async () => {} });
		await adapter.pull(null);
		const before = fake.requests.length;
		assert.equal((await adapter.send({ draftId: "d1", chatId: PHONE, text: "fixture reply", hash: "h" })).state, "sent");
		const sent = fake.requests.slice(before).filter((one) => one.method === "POST");
		assert.equal(sent.length, 4);
		for (const request of sent) {
			const call = Object.values(schema.calls).find((one) => one.path === request.path);
			assert.ok(call, `${request.path} is a call the schema file describes`);
			const body = request.body as Record<string, unknown>;
			for (const [name, field] of Object.entries(call.fields)) {
				if (field.required) assert.ok(name in body, `${request.path} sends the required field ${name}`);
			}
			for (const [name, value] of Object.entries(body)) {
				const field = call.fields[name];
				assert.ok(field, `${request.path} sends ${name}, a field WAHA's request schema names`);
				assert.equal(typeof value, field.type, `${request.path} ${name} has the schema's type`);
			}
		}
	});
});

test("whatsapp: health reads the session status and refuses to run without a key", async () => {
	await withFake(async (fake) => {
		const adapter = createWahaAdapter({ config: { url: fake.url, apiKey: fake.key, session: fake.session } });
		const health = await adapter.health();
		assert.equal(health.state, "working");
		assert.equal(health.detail, "WORKING");

		fake.setStatus("SCAN_QR_CODE");
		assert.equal((await adapter.health()).state, "scan-qr");

		const keyless = createWahaAdapter({ config: { url: fake.url, apiKey: "", session: fake.session } });
		const before = fake.requests.length;
		await assert.rejects(async () => keyless.health(), /WAHA_API_KEY is not set/);
		assert.equal(fake.requests.length, before, "a missing key is refused before any request goes out");
	});
});

test("whatsapp: the delivery re-read reports the mark of a message this account sent", async () => {
	const sent: FakeChat = {
		id: PHONE,
		messages: [
			{ id: serializedId(PHONE, "S0001", true), timestamp: 1_700_000_000, fromMe: true, from: PHONE, body: "fixture sent", type: "chat", ack: 3 },
			{ id: serializedId(PHONE, "S0002", true), timestamp: 1_700_000_010, fromMe: true, from: PHONE, body: "fixture sent too", type: "chat" },
		],
	};
	const fake = await startFakeWaha({ chats: [sent] });
	try {
		const readAcks = createWahaAckReader({ config: { url: fake.url, apiKey: fake.key, session: fake.session } });
		const events = await readAcks([
			{ chatId: PHONE, messageId: "S0001" },
			{ chatId: PHONE, messageId: "S0002" },
			{ chatId: PHONE, messageId: "S9999" },
		]);
		assert.deepEqual(events.map((one) => one.messageId), ["S0001"], "a message with a mark, and only that one");
		assert.equal(events[0]?.event, "ack");
		assert.deepEqual(events[0]?.payload, { ack: "DEVICE" });
		assert.equal(events[0]?.chatId, PHONE);
	} finally {
		await fake.close();
	}
});

test("whatsapp: the pure helpers the adapter's reading rests on", () => {
	assert.equal(messageIdOf("false_15550001111@c.us_A0001"), "A0001");
	assert.equal(messageIdOf("true_15550001111@c.us_3EB0ABCD"), "3EB0ABCD");
	assert.equal(messageIdOf("plain-id"), "plain-id", "a value without the serialized shape is kept");

	assert.equal(timestampMsOf(1_700_000_000), 1_700_000_000_000, "seconds become milliseconds");
	assert.equal(timestampMsOf(1_700_000_000_000), 1_700_000_000_000, "milliseconds stay milliseconds");
	assert.equal(timestampMsOf("1700000000"), 1_700_000_000_000);
	assert.equal(timestampMsOf(undefined), 0);
	assert.equal(timestampMsOf("not a time"), 0);

	assert.equal(ackNameOf(2), "SERVER");
	assert.equal(ackNameOf(4), "READ");
	assert.equal(ackNameOf("read"), "READ");
	assert.equal(ackNameOf(9), undefined);
	assert.equal(ackNameOf(undefined), undefined);

	assert.equal(healthStateOf("WORKING"), "working");
	assert.equal(healthStateOf("SCAN_QR_CODE"), "scan-qr");
	assert.equal(healthStateOf("FAILED"), "failed");
	assert.equal(healthStateOf("STOPPED"), "stopped");
	assert.equal(healthStateOf("STARTING"), "unknown");
	assert.equal(healthStateOf(undefined), "unknown");

	assert.deepEqual(contactAliasesOf({ id: PHONE, name: NAME, lid: LID, pushname: NAME }), [LID], "id-shaped fields only, and never the entry's own id");
	assert.deepEqual(contactAliasesOf({ id: PHONE }), []);

	assert.deepEqual(parseCursor(null), { v: 1, chats: {}, contacts: true, giveUp: [] }, "an empty cursor reads from the beginning");
	assert.deepEqual(parseCursor("not json"), { v: 1, chats: {}, contacts: true, giveUp: [] });
	assert.deepEqual(parseCursor('{"v":1,"chats":{"' + PHONE + '":1700000000000}}').chats[PHONE], { at: 1_700_000_000_000, id: "" }, "a cursor from before the id was kept still reads");
	assert.equal(
		formatCursor({ v: 1, chats: { [GROUP]: { at: 2, id: "B" }, [PHONE]: { at: 1, id: "A" } }, contacts: false, giveUp: [] }),
		'{"v":1,"chats":{"120363000000000001@g.us":{"at":2,"id":"B"},"15550001111@c.us":{"at":1,"id":"A"}},"contacts":false,"giveUp":[]}',
	);
	assert.deepEqual(parseCursor('{"v":1,"chats":{},"giveUp":["M2","M1"]}').giveUp, ["M2", "M1"], "the ids a poll must take without bytes are read from the cursor");

	assert.equal(sameOriginAs(`${WAHA_DEFAULT_URL}/api/files/x`, WAHA_DEFAULT_URL), true);
	assert.equal(sameOriginAs("http://waha.example/media/x.png", "http://waha"), false, "a look-alike host is another origin");
	assert.equal(sameOriginAs("http://waha.example/media/x.png", "http://waha.example"), true);
	assert.equal(sameOriginAs("not a url", WAHA_DEFAULT_URL), false);
	assert.equal(sameOriginAs("https://waha", "http://waha"), false, "another scheme is another origin");
	assert.equal(mediaGoneOf(new WahaHttpError(404, "/x", "")), true);
	assert.equal(mediaGoneOf(new WahaHttpError(410, "/x", "")), true);
	assert.equal(mediaGoneOf(new WahaHttpError(503, "/x", "")), false);
	assert.equal(mediaGoneOf(new Error("timeout")), false);

	const env = wahaConfigFromEnv({ [WAHA_KEY_ENV]: "  key-value  " });
	assert.equal(env.url, WAHA_DEFAULT_URL);
	assert.equal(env.session, WAHA_DEFAULT_SESSION);
	assert.equal(env.apiKey, "key-value", "the key is read from the environment and trimmed");
});
