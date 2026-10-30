import "./muster-test-isolation.ts";
/**
 * MG1 (messaging agent, VR24-62, rules G1, G2 and G4): the archive half of
 * `packages/muster/messaging/`.
 *
 * The contract:
 *  - the store root comes from the caller or `MESSAGING_ROOT_ENV`, the production
 *    folder is only the last default, and resolving a root creates nothing;
 *  - every pulled message is appended to `raw/YYYY-MM-DD.jsonl` exactly as the
 *    channel gave it, one line per pull, never rewritten;
 *  - media is copied into `media/` under its SHA-256, so a copy survives the
 *    channel's prunable cache and two identical blobs cost one file;
 *  - an edit, a deletion and a revoke are appended as events and the original
 *    message text stays readable, unedited, in both `raw/` and the index;
 *  - the folder is 0700 and every file the store writes is 0600.
 *
 * Fixtures are synthetic ids and names only: no chat text from a real account.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appendArchiveRecord, MESSAGING_ROOT_ENV, messagingRoot, readArchiveRecords } from "../messaging/archive.ts";
import { openMessagingStore } from "../messaging/store.ts";

const mode = (path: string): number => statSync(path).mode & 0o777;

function tempRoot(t: test.TestContext): string {
	const root = mkdtempSync(join(tmpdir(), "messaging-archive-"));
	rmSync(root, { recursive: true, force: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

const PULLED_AT = "2026-10-25T10:00:00.000Z";

const MESSAGE = {
	channel: "whatsapp",
	chatId: "15550001111@c.us",
	messageId: "MSG-1",
	timestamp: Date.parse("2026-10-24T09:00:00.000Z"),
	fromMe: false,
	senderId: "15550001111@c.us",
	type: "chat",
	text: "The contract is ready for your signature",
	payload: {
		id: "MSG-1",
		from: "15550001111@c.us",
		body: "The contract is ready for your signature",
		_data: { notifyName: "Synthetic Contact", t: 1792000000 },
	},
	recordedAt: PULLED_AT,
} as const;

test("the root is the caller's, then the environment's, and resolving one creates nothing", (t) => {
	const root = tempRoot(t);
	const saved = process.env[MESSAGING_ROOT_ENV];
	t.after(() => {
		if (saved === undefined) delete process.env[MESSAGING_ROOT_ENV];
		else process.env[MESSAGING_ROOT_ENV] = saved;
	});

	process.env[MESSAGING_ROOT_ENV] = root;
	assert.equal(messagingRoot(), root, "the environment variable names the store root");
	assert.equal(messagingRoot("/tmp/explicit-messaging-root"), "/tmp/explicit-messaging-root", "the parameter wins over the environment");
	assert.equal(existsSync(root), false, "resolving a root creates no folder");

	delete process.env[MESSAGING_ROOT_ENV];
	assert.match(messagingRoot(), /\.local\/share\/messaging$/, "the production folder is the default when nothing else names a root");
});

test("a pulled message is appended as the channel gave it, and a repeat pull of it adds no line", (t) => {
	const root = tempRoot(t);
	const store = openMessagingStore(root);
	t.after(() => store.close());

	const first = store.archiveMessage(MESSAGE);
	assert.equal(first.threadId, "15550001111@c.us");
	assert.equal(first.duplicate, false);
	const second = store.archiveMessage(MESSAGE);
	assert.equal(second.duplicate, true, "the index keeps one row for a message pulled twice");

	const lines = readFileSync(join(root, "raw", "2026-10-25.jsonl"), "utf8").trim().split("\n");
	assert.equal(lines.length, 1, "a record the index already holds is not archived twice (R2)");
	const record = JSON.parse(lines[0]);
	assert.equal(record.kind, "message");
	assert.deepEqual(record.payload, MESSAGE.payload, "the channel's own payload is kept whole");
	assert.equal(record.text, MESSAGE.text);
	assert.equal(record.chatId, MESSAGE.chatId);
	const contents = readArchiveRecords(root);
	assert.equal(contents.records.length, 1);
	assert.deepEqual(contents.skipped, []);
	assert.equal(store.counts().messages, 1, "the derived index holds one row");
});

test("the same message and the same event archived twice leave one line each", (t) => {
	const root = tempRoot(t);
	const store = openMessagingStore(root);
	t.after(() => store.close());

	const event = {
		channel: "whatsapp",
		chatId: MESSAGE.chatId,
		messageId: MESSAGE.messageId,
		event: "edited" as const,
		at: "2026-10-24T09:05:00.000Z",
		text: "The contract is signed",
		recordedAt: PULLED_AT,
	};
	assert.equal(store.archiveMessage(MESSAGE).duplicate, false);
	const repeated = store.archiveMessage(MESSAGE);
	assert.equal(repeated.duplicate, true);
	assert.equal(store.archiveEvent(event).duplicate, false);
	assert.equal(store.archiveEvent(event).duplicate, true);

	const lines = readFileSync(join(root, "raw", "2026-10-25.jsonl"), "utf8").trim().split("\n");
	assert.equal(lines.length, 2, "one line for the message, one for the edit, and nothing for the repeats");
	assert.deepEqual(
		lines.map((line) => JSON.parse(line).kind),
		["message", "event"],
	);
	assert.deepEqual(store.counts(), { messages: 1, events: 1, threads: 1, contacts: 0 });
});

test("a record already in raw/ but not in the index is indexed by the next call, without a second line", (t) => {
	const root = tempRoot(t);
	// A copy the crash left behind: in the archive, never indexed.
	appendArchiveRecord(root, {
		v: 1,
		kind: "message",
		channel: MESSAGE.channel,
		chatId: MESSAGE.chatId,
		messageId: MESSAGE.messageId,
		recordedAt: PULLED_AT,
		timestamp: MESSAGE.timestamp,
		fromMe: MESSAGE.fromMe,
		senderId: MESSAGE.senderId,
		type: MESSAGE.type,
		text: MESSAGE.text,
		source: "channel",
		payload: MESSAGE.payload,
	});

	const store = openMessagingStore(root);
	t.after(() => store.close());
	const outcome = store.archiveMessage(MESSAGE);
	assert.equal(outcome.duplicate, false, "the index did not hold it, so indexing it is new work");
	assert.equal(store.counts().messages, 1);
	const lines = readFileSync(join(root, "raw", "2026-10-25.jsonl"), "utf8").trim().split("\n");
	assert.equal(lines.length, 1, "the copy already in raw/ is not appended again");
	const rebuilt = store.rebuild();
	assert.deepEqual({ records: rebuilt.records, messages: rebuilt.messages, skips: rebuilt.skipped.length }, { records: 1, messages: 1, skips: 0 });
});

test("inbound media is copied into media/ under its hash, and the same blob costs one file", (t) => {
	const root = tempRoot(t);
	const store = openMessagingStore(root);
	t.after(() => store.close());

	const bytes = Buffer.from("synthetic-jpeg-bytes");
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const outcome = store.archiveMessage({ ...MESSAGE, media: { bytes, mime: "image/jpeg" } });
	const media = outcome.record.kind === "message" ? outcome.record.media : undefined;
	assert.ok(media, "the record names the copied media");
	assert.equal(media.sha256, sha256, "the hash is the copied bytes' hash");
	assert.equal(media.bytes, bytes.length);
	assert.equal(media.mime, "image/jpeg");
	const file = join(root, media.file);
	assert.equal(existsSync(file), true, "the media file is inside the store");
	assert.equal(readFileSync(file).toString(), "synthetic-jpeg-bytes");
	assert.equal(mode(file), 0o600, "a media copy is 0600");

	store.archiveMessage({ ...MESSAGE, messageId: "MSG-2", media: { bytes, mime: "image/jpeg" } });
	assert.deepEqual(readdirSync(join(root, "media")), [media.file.split("/").pop()], "one file for one hash");
});

test("the store folder is 0700 and raw files, media and the index are 0600", (t) => {
	const root = tempRoot(t);
	const store = openMessagingStore(root);
	t.after(() => store.close());
	store.archiveMessage({ ...MESSAGE, media: { bytes: Buffer.from("bytes"), mime: "image/png" } });

	for (const dir of [root, join(root, "raw"), join(root, "media")]) {
		assert.equal(mode(dir), 0o700, `${dir} is 0700`);
	}
	const rawFiles = readdirSync(join(root, "raw"));
	assert.deepEqual(rawFiles, ["2026-10-25.jsonl"]);
	assert.equal(mode(join(root, "raw", rawFiles[0])), 0o600, "a raw file is 0600");
	for (const file of readdirSync(join(root, "media"))) assert.equal(mode(join(root, "media", file)), 0o600, `${file} is 0600`);
	assert.equal(mode(join(root, "messages.db")), 0o600, "the derived index is 0600");
});

test("an edit, a deletion and a revoke are events and the original text stays readable", (t) => {
	const root = tempRoot(t);
	const store = openMessagingStore(root);
	t.after(() => store.close());

	store.archiveMessage(MESSAGE);
	store.archiveEvent({
		channel: "whatsapp",
		chatId: MESSAGE.chatId,
		messageId: MESSAGE.messageId,
		event: "edited",
		at: "2026-10-24T09:05:00.000Z",
		recordedAt: PULLED_AT,
		text: "The contract is signed",
		payload: { id: MESSAGE.messageId, body: "The contract is signed" },
	});
	store.archiveEvent({ channel: "whatsapp", chatId: MESSAGE.chatId, messageId: "MSG-9", event: "deleted", at: "2026-10-24T09:07:00.000Z", recordedAt: PULLED_AT });
	store.archiveEvent({ channel: "whatsapp", chatId: MESSAGE.chatId, messageId: "MSG-10", event: "revoked", at: "2026-10-24T09:08:00.000Z", recordedAt: PULLED_AT });

	const records = readArchiveRecords(root).records;
	assert.deepEqual(
		records.map((record) => (record.kind === "event" ? record.event : record.kind)),
		["message", "edited", "deleted", "revoked"],
	);
	const message = records[0];
	assert.equal(message.kind === "message" && message.text, MESSAGE.text, "the archived message keeps its own text");

	const view = store.readThread(MESSAGE.chatId);
	const held = view.messages.find((row) => row.messageId === MESSAGE.messageId);
	assert.equal(held?.text, MESSAGE.text, "an edit does not change the original text");
	assert.deepEqual(held?.events.map((event) => event.event), ["edited"]);
	assert.equal(held?.events[0].text, "The contract is signed", "the new text lives on the event");
	assert.deepEqual(
		store.readThread(MESSAGE.chatId).events.map((event) => [event.messageId, event.event]),
		[
			[MESSAGE.messageId, "edited"],
			["MSG-9", "deleted"],
			["MSG-10", "revoked"],
		],
		"deletions and revokes are kept as events of the thread",
	);
});

test("a fragment with no newline, then a real archive call, then a rebuild gives both records and one reported skip", (t) => {
	const root = tempRoot(t);
	const store = openMessagingStore(root);
	t.after(() => store.close());

	store.archiveMessage(MESSAGE);
	// What a crash between two writes leaves: a half line, and no newline after it.
	appendFileSync(join(root, "raw", "2026-10-25.jsonl"), '{"v":1,"kind":"mes');
	store.archiveMessage({ ...MESSAGE, messageId: "MSG-2", text: "A second line", timestamp: MESSAGE.timestamp + 60_000 });

	const lines = readFileSync(join(root, "raw", "2026-10-25.jsonl"), "utf8").split("\n").filter((line) => line.length > 0);
	assert.equal(lines.length, 3, "the fragment is a line of its own, the new record is not glued onto it");
	const rebuilt = store.rebuild();
	assert.equal(rebuilt.records, 2, "both finished records are replayed");
	assert.equal(rebuilt.messages, 2, "and both are indexed");
	assert.equal(rebuilt.skipped.length, 1, "the fragment is reported, not silently dropped");
	assert.equal(rebuilt.skipped[0].file, "2026-10-25.jsonl");
	assert.equal(rebuilt.skipped[0].line, 2, "the skip names the line it is on");
	assert.deepEqual(
		store.readThread(MESSAGE.chatId).messages.map((row) => row.messageId),
		["MSG-1", "MSG-2"],
	);
});

test("a broken line in the middle of a file does not stop the rebuild", (t) => {
	const root = tempRoot(t);
	const store = openMessagingStore(root);
	t.after(() => store.close());

	store.archiveMessage(MESSAGE);
	appendFileSync(join(root, "raw", "2026-10-25.jsonl"), '{"oops":true}\nnot-json-at-all\n');
	store.archiveMessage({ ...MESSAGE, messageId: "MSG-2", text: "After the damage", timestamp: MESSAGE.timestamp + 60_000 });

	const rebuilt = store.rebuild();
	assert.equal(rebuilt.records, 2, "the records on both sides of the damage are replayed");
	assert.equal(rebuilt.messages, 2);
	assert.deepEqual(
		rebuilt.skipped.map((skip) => [skip.line, skip.reason === "not an archive record" ? "shape" : "json"]),
		[
			[2, "shape"],
			[3, "json"],
		],
		"a line that parses but is not a record, and a line that does not parse, are both reported",
	);
	assert.equal(store.counts().messages, 2);
	assert.deepEqual(
		store.readThread(MESSAGE.chatId).messages.map((row) => row.messageId),
		["MSG-1", "MSG-2"],
	);
});
