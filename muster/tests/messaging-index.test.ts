import "./muster-test-isolation.ts";
/**
 * MG1 (messaging agent, VR24-62, rules G1, G2 and G4): the derived index half of
 * `packages/muster/messaging/`, and the whole path a lane can run: a fake channel
 * adapter's pull, the archive, a rebuild from `raw/`, then a search.
 *
 * The contract:
 *  - `messages.db` is derived. `rebuild()` recreates it from `raw/` and the two
 *    indexes hold the same rows, the same threads and the same search results;
 *  - a message pulled twice yields one row, and the idempotency key is the
 *    channel's message id inside the canonical thread;
 *  - one conversation that arrives under `@lid` and `@c.us` forms archives once:
 *    one thread, one name from the contact list, both id forms mapped to it;
 *  - a display name comes from the stored contact list and never from message text;
 *  - FTS5 returns a known phrase with its neighbouring words.
 *
 * Fixtures are synthetic ids and names only: no chat text from a real account.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ChannelAdapter, PullResult } from "../messaging/types.ts";
import { openMessagingStore } from "../messaging/store.ts";

const CHANNEL = "whatsapp";
const PHONE_ID = "15550001111@c.us";
const LID_ID = "900000000000001@lid";
const NAME = "Fixture Person";
const PULLED_AT = "2026-10-25T10:00:00.000Z";

function tempRoot(t: test.TestContext): string {
	const root = mkdtempSync(join(tmpdir(), "messaging-index-"));
	rmSync(root, { recursive: true, force: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

const message = (over: {
	chatId: string;
	messageId: string;
	text: string;
	at: string;
	media?: { bytes: Uint8Array; mime?: string };
}) => ({
	channel: CHANNEL,
	chatId: over.chatId,
	messageId: over.messageId,
	timestamp: Date.parse(over.at),
	fromMe: false,
	senderId: over.chatId,
	type: "chat",
	text: over.text,
	payload: { id: over.messageId, from: over.chatId, body: over.text },
	recordedAt: PULLED_AT,
	...over.media ? { media: over.media } : {},
});

/** The contact list entry that tells the store the two id forms are one person. */
const contact = {
	channel: CHANNEL,
	contactId: PHONE_ID,
	aliases: [LID_ID],
	name: NAME,
		payload: { id: PHONE_ID, lid: LID_ID, name: NAME, number: "15550001111" },
	recordedAt: PULLED_AT,
};

/** A pull as the WhatsApp adapter will return one (MG2), on synthetic ids only. */
function fixturePull(): PullResult {
	return {
		cursor: "cursor-2",
		contacts: [contact],
		messages: [
			{
				chatId: LID_ID,
				messageId: "MSG-1",
				timestamp: Date.parse("2026-10-24T09:00:00.000Z"),
				fromMe: false,
				senderId: LID_ID,
				type: "chat",
				text: "Morning, the contract is ready for your signature",
				payload: { id: "MSG-1", from: LID_ID, body: "Morning, the contract is ready for your signature" },
			},
			{
				chatId: PHONE_ID,
				messageId: "MSG-2",
				timestamp: Date.parse("2026-10-24T09:30:00.000Z"),
				fromMe: true,
				senderId: PHONE_ID,
				type: "chat",
				text: "Thanks, I will read the contract tonight",
				payload: { id: "MSG-2", to: PHONE_ID, fromMe: true, body: "Thanks, I will read the contract tonight" },
			},
		],
		events: [{ chatId: LID_ID, messageId: "MSG-1", event: "edited", at: "2026-10-24T09:10:00.000Z", text: "Morning, the contract is ready" }],
	};
}

/** The fake adapter proves the port type is implementable exactly as G1 writes it. */
const fakeAdapter: ChannelAdapter = {
	id: CHANNEL,
	pull: async (cursor) => ({ ...fixturePull(), cursor: cursor === null ? "cursor-1" : "cursor-2" }),
	send: async () => ({ state: "sent", at: PULLED_AT, messageId: "MSG-3", ack: "SERVER" }),
	health: async () => ({ state: "working", checkedAt: PULLED_AT }),
};

/** Applies a pull the way the sync job will: contacts, then messages, then events. */
function applyPull(
	store: ReturnType<typeof openMessagingStore>,
	pull: PullResult,
): { appended: number; duplicates: number } {
	let appended = 0;
	let duplicates = 0;
	const note = (duplicate: boolean) => (duplicate ? (duplicates += 1) : (appended += 1));
	for (const row of pull.contacts ?? []) note(store.archiveContact({ ...row, channel: CHANNEL }).duplicate);
	for (const row of pull.messages) note(store.archiveMessage({ ...row, channel: CHANNEL }).duplicate);
	for (const row of pull.events ?? []) note(store.archiveEvent({ ...row, channel: CHANNEL }).duplicate);
	return { appended, duplicates };
}

function dump(path: string): unknown {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		const select = (sql: string) => db.prepare(sql).all().map((row) => ({ ...row }));
		return {
			threads: select("SELECT * FROM threads ORDER BY thread_id"),
			thread_ids: select("SELECT * FROM thread_ids ORDER BY channel, chat_id"),
			contacts: select("SELECT * FROM contacts ORDER BY channel, contact_id"),
			messages: select("SELECT * FROM messages ORDER BY thread_id, message_id"),
			message_events: select("SELECT * FROM message_events ORDER BY id"),
		};
	} finally {
		db.close();
	}
}

test("a pulled message appended twice is one row, keyed inside the thread", (t) => {
	const root = tempRoot(t);
	const store = openMessagingStore(root);
	t.after(() => store.close());

	const once = store.archiveMessage(message({ chatId: PHONE_ID, messageId: "MSG-1", text: "hello", at: "2026-10-24T09:00:00.000Z" }));
	const twice = store.archiveMessage(message({ chatId: PHONE_ID, messageId: "MSG-2", text: "hello again", at: "2026-10-24T09:01:00.000Z" }));
	store.archiveMessage(message({ chatId: PHONE_ID, messageId: "MSG-1", text: "hello", at: "2026-10-24T09:00:00.000Z" }));
	assert.equal(once.duplicate, false);
	assert.equal(twice.duplicate, false);
	assert.equal(store.counts().messages, 2, "the second pull of MSG-1 adds no row");

	const db = new DatabaseSync(join(root, "messages.db"), { readOnly: true });
	const row = db.prepare("SELECT idem_key, chat_id, thread_id FROM messages WHERE message_id = ?").get("MSG-1") as {
		idem_key: string;
		chat_id: string;
		thread_id: string;
	};
	db.close();
	assert.equal(row.idem_key, `${CHANNEL}:${PHONE_ID}:MSG-1`, "the key is <channel>:<thread>:<messageId>");
});

test("one conversation under @lid and @c.us archives once, with one thread and one name", (t) => {
	const root = tempRoot(t);
	const store = openMessagingStore(root);
	t.after(() => store.close());

	// The same conversation arrives under both id forms before the contact list names it.
	store.archiveMessage(message({ chatId: LID_ID, messageId: "MSG-1", text: "the contract is ready", at: "2026-10-24T09:00:00.000Z" }));
	store.archiveMessage(message({ chatId: LID_ID, messageId: "MSG-1b", text: "second line", at: "2026-10-24T09:01:00.000Z" }));
	// A message whose payload carries a display-ish name must not become the thread's name.
	store.archiveMessage(
		message({ chatId: LID_ID, messageId: "MSG-1c", text: "third line", at: "2026-10-24T09:02:00.000Z" }),
	);
	assert.equal(store.threads()[0].displayName, null, "no name before the contact list has one");

	store.archiveContact(contact);
	const afterContact = store.threads();
	assert.equal(afterContact.length, 1, "the thread is repointed, not duplicated");
	assert.equal(afterContact[0].threadId, PHONE_ID, "the canonical thread is the @c.us form once the mapping is known");
	assert.equal(afterContact[0].displayName, NAME, "the name comes from the stored contact list");
	assert.deepEqual(
		store.threadIds(PHONE_ID).sort(),
		[LID_ID, PHONE_ID].sort(),
		"every id form maps to the one canonical thread",
	);

	// The same message then arrives again under the phone form: no second row.
	const duplicate = store.archiveMessage(message({ chatId: PHONE_ID, messageId: "MSG-1", text: "the contract is ready", at: "2026-10-24T09:00:00.000Z" }));
	assert.equal(duplicate.duplicate, true, "one message is one message across both id forms");
	assert.equal(duplicate.threadId, PHONE_ID);
	assert.equal(store.counts().messages, 3);
	assert.equal(store.counts().threads, 1);

	const view = store.readThread(LID_ID);
	assert.equal(view.thread.threadId, PHONE_ID, "reading by the @lid form reads the canonical thread");
	assert.deepEqual(view.messages.map((row) => row.messageId).sort(), ["MSG-1", "MSG-1b", "MSG-1c"]);

	const hits = store.search("contract");
	assert.equal(hits.length, 1, "the search index follows the merge: one hit, not two");
	assert.equal(hits[0].threadId, PHONE_ID);
	assert.equal(hits[0].displayName, NAME);
});

test("FTS search returns a known phrase with its neighbouring words", (t) => {
	const root = tempRoot(t);
	const store = openMessagingStore(root);
	t.after(() => store.close());

	store.archiveContact(contact);
	store.archiveMessage(
		message({
			chatId: PHONE_ID,
			messageId: "MSG-1",
			text: "Morning, the contract is ready for your signature whenever you like",
			at: "2026-10-24T09:00:00.000Z",
		}),
	);
	store.archiveMessage(message({ chatId: PHONE_ID, messageId: "MSG-2", text: "unrelated line about lunch", at: "2026-10-24T09:01:00.000Z" }));

	const hits = store.search("the contract");
	assert.equal(hits.length, 1, "only the message holding the phrase matches");
	assert.equal(hits[0].messageId, "MSG-1");
	assert.equal(hits[0].displayName, NAME);
	assert.equal(hits[0].threadId, PHONE_ID);
	assert.match(hits[0].snippet, /\[the contract\]/, "the match is marked in the snippet");
	assert.match(hits[0].snippet, /ready/, "the neighbours of the match come with it");
	assert.deepEqual(store.search("nothinglikethis"), []);
});

test("rebuild from raw/ equals the live index, on the whole path from a pull to a search", async (t) => {
	const root = tempRoot(t);
	const store = openMessagingStore(root);
	t.after(() => store.close());

	const pull = await fakeAdapter.pull(null);
	const applied = applyPull(store, pull);
	assert.equal(applied.appended, 4, "one contact, two messages and one edit land");
	// The same pull again adds nothing: the index holds every record, so raw/ keeps one copy (R2).
	assert.deepEqual(applyPull(store, pull), { appended: 0, duplicates: 4 });

	const live = { counts: store.counts(), dump: dump(join(root, "messages.db")), hits: store.search("contract"), threads: store.threads() };
	const rebuilt = store.rebuild();
	assert.equal(rebuilt.records, 4, "the rebuild replays the four archived records");
	assert.equal(rebuilt.messages, 2, "the second pull of the same pull is in the index, so raw/ kept one copy");
	assert.deepEqual(rebuilt.skipped, [], "nothing in raw/ was unreadable");

	const after = { counts: store.counts(), dump: dump(join(root, "messages.db")), hits: store.search("contract"), threads: store.threads() };
	assert.deepEqual(after.dump, live.dump, "every row of the recreated index equals the live one");
	assert.deepEqual(after.threads, live.threads);
	assert.deepEqual(after.hits, live.hits, "search answers the same after a rebuild");
	assert.equal(after.counts.messages, 2);
	assert.equal(after.threads.length, 1);
	assert.equal(after.threads[0].displayName, NAME);

	const view = store.readThread(PHONE_ID);
	assert.equal(view.messages[0].source, "channel");
	assert.deepEqual(view.messages[0].events.map((event) => event.event), ["edited"]);
});

test("a message a channel read by vision is marked lossy, in the index and in a search result", (t) => {
	const root = tempRoot(t);
	const store = openMessagingStore(root);
	t.after(() => store.close());

	const outcome = store.archiveMessage({
		...message({ chatId: PHONE_ID, messageId: "VIS-1", text: "transcript of a screenshot", at: "2026-10-24T09:00:00.000Z" }),
		source: "vision",
		media: { bytes: Buffer.from("synthetic-png"), mime: "image/png" },
	});
	assert.equal(outcome.record.kind === "message" ? outcome.record.source : null, "vision");

	const view = store.readThread(PHONE_ID);
	assert.equal(view.messages[0].source, "vision", "the transcript is stored as lossy, not as the channel's own text");
	assert.equal(view.messages[0].media?.mime, "image/png", "the screenshot is kept beside it");
	assert.equal(store.search("screenshot")[0].source, "vision", "a search result says how the text was obtained");
});
