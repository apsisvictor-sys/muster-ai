import "./muster-test-isolation.ts";
/**
 * MG3 (messaging agent, VR24-62, rules G2, G4 and G14): the read and search CLI over
 * the archive, and the two ride-alongs the architect asked for after the MG1 review.
 *
 * The contract:
 *  - `msg threads`, `msg read <chat>`, `msg search <text>`, `msg status` and
 *    `msg rebuild` print from the archive and write nothing but their audit line;
 *  - a search result shows the chat, the date and the message in context;
 *  - a read writes one audit line holding the chat id, the thread id and the command,
 *    and never the text of a message;
 *  - two channels that share one chat id are two threads, not one (ride-along a);
 *  - an edit's replacement text is searchable, the search shows the current text, and
 *    the original text is still found (ride-along b).
 *
 * Every fixture is synthetic: no chat text from a real account. The CLI runs for
 * real, against a store in a temp folder and an audit file in a temp folder, so the
 * production store and the live audit are never touched.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { indexIsStale } from "../messaging/messages-db.ts";
import { openMessagingStore } from "../messaging/store.ts";
import { harnessRoot, tsxCliPath } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);
const SCRIPT = join(piAgentDir(), "scripts", "msg.mts");
const TSX = tsxCliPath();

const WHATSAPP = "whatsapp";
const VIBER = "viber";
const PHONE_ID = "15550001111@c.us";
const NAME = "Fixture Person";
const PULLED_AT = "2026-10-25T10:00:00.000Z";

/** One temp folder per test: the store, and the audit file the CLI writes into. */
function tempRoot(t: test.TestContext): { store: string; audit: string } {
	const root = mkdtempSync(join(tmpdir(), "messaging-cli-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const store = join(root, "store");
	const audit = join(root, "gateway-state");
	return { store, audit };
}

const message = (over: { channel?: string; chatId: string; messageId: string; text: string; at: string }) => ({
	channel: over.channel ?? WHATSAPP,
	chatId: over.chatId,
	messageId: over.messageId,
	timestamp: Date.parse(over.at),
	fromMe: false,
	senderId: over.chatId,
	type: "chat",
	text: over.text,
	payload: { id: over.messageId, from: over.chatId, body: over.text },
	recordedAt: PULLED_AT,
});

const contact = {
	channel: WHATSAPP,
	contactId: PHONE_ID,
	name: NAME,
	payload: { id: PHONE_ID, name: NAME, number: "15550001111" },
	recordedAt: PULLED_AT,
};

/** A synthetic archive: one WhatsApp chat with two messages and one edit. */
function seedArchive(store: ReturnType<typeof openMessagingStore>): void {
	store.archiveContact(contact);
	store.archiveMessage(
		message({ chatId: PHONE_ID, messageId: "MSG-1", text: "Morning, the contract is ready for your signature", at: "2026-10-24T09:00:00.000Z" }),
	);
	store.archiveEvent({
		channel: WHATSAPP,
		chatId: PHONE_ID,
		messageId: "MSG-1",
		event: "edited",
		at: "2026-10-24T09:10:00.000Z",
		text: "Morning, the contract is ready",
		recordedAt: PULLED_AT,
	});
	store.archiveMessage(
		message({ chatId: PHONE_ID, messageId: "MSG-2", text: "Thanks, I will read the contract tonight", at: "2026-10-24T09:30:00.000Z" }),
	);
}

/** Runs the CLI for real, against the temp store and the temp audit file. */
function run(args: string[], paths: { store: string; audit: string }): { status: number | null; stdout: string; stderr: string } {
	const child = spawnSync(process.execPath, [TSX, SCRIPT, "--root", paths.store, ...args], {
		cwd: HARNESS_ROOT,
		encoding: "utf8",
		timeout: 60_000,
		env: {
			...process.env,
			MESSAGING_STORE_ROOT: paths.store,
			GROKBOT_GATEWAY_STATE_DIR: paths.audit,
			NODE_NO_WARNINGS: "1",
		},
	});
	return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

/** The audit lines the CLI wrote. */
function auditLines(paths: { store: string; audit: string }): string[] {
	const file = join(paths.audit, "audit.jsonl");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8").split("\n").filter((line) => line.trim().length > 0);
}

test("msg threads lists the archive's threads with their channel, name and size", (t) => {
	const paths = tempRoot(t);
	const store = openMessagingStore(paths.store);
	seedArchive(store);
	store.close();

	const result = run(["threads"], paths);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /whatsapp/, "the channel is on the row");
	assert.match(result.stdout, new RegExp(PHONE_ID.replace(/[@.]/g, "\\$&")), "the chat id is on the row");
	assert.match(result.stdout, /Fixture Person/, "the name comes from the contact list");
	assert.match(result.stdout, /2 messages/, "the row holds how many messages the thread has");
	assert.deepEqual(auditLines(paths), [], "a thread list shows no message text, so it writes no audit line");
});

test("msg read prints the messages of a thread, with the edit among them", (t) => {
	const paths = tempRoot(t);
	const store = openMessagingStore(paths.store);
	seedArchive(store);
	store.close();

	const result = run(["read", PHONE_ID], paths);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /2026-10-24T09:00:00\.000Z/, "the message carries its date");
	assert.match(result.stdout, /Morning, the contract is ready for your signature/, "the message text is printed");
	assert.match(result.stdout, /edited/, "the edit of the message is printed with it");
	assert.match(result.stdout, /Morning, the contract is ready$/m, "the replacement text of the edit is printed");
});

test("msg search shows the chat, the date and the message in context", (t) => {
	const paths = tempRoot(t);
	const store = openMessagingStore(paths.store);
	seedArchive(store);
	store.close();

	const result = run(["search", "contract"], paths);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Fixture Person/, "the chat is named");
	assert.match(result.stdout, /2026-10-24T09:00:00\.000Z/, "the date of the message is shown");
	assert.match(result.stdout, /\[contract\]/, "the match is marked in its context");
	assert.match(result.stdout, /ready/, "the words around the match come with it");
});

test("the audit line of a read holds a fingerprint, never an id, a name or text", (t) => {
	const paths = tempRoot(t);
	const store = openMessagingStore(paths.store);
	seedArchive(store);
	store.close();

	const result = run(["read", PHONE_ID], paths);
	assert.equal(result.status, 0, result.stderr);
	const lines = auditLines(paths);
	assert.equal(lines.length, 1, "one read writes one audit line");
	const fingerprint = createHash("sha256").update(PHONE_ID).digest("hex").slice(0, 12);
	assert.match(lines[0]!, new RegExp(fingerprint), "the line holds the fingerprint of the thread");
	assert.doesNotMatch(lines[0]!, /15550001111/, "the line holds no chat id");
	assert.doesNotMatch(lines[0]!, /@c\.us/, "the line holds no chat id");
	assert.doesNotMatch(lines[0]!, /Fixture Person/, "the line holds no name");
	assert.doesNotMatch(lines[0]!, /Morning/, "the line holds no message text");
	assert.doesNotMatch(lines[0]!, /contract/, "the line holds no message text");
});

test("the audit line of a search holds a fingerprint and a count, never the query or an id", (t) => {
	const paths = tempRoot(t);
	const store = openMessagingStore(paths.store);
	seedArchive(store);
	store.close();

	const result = run(["search", "contract"], paths);
	assert.equal(result.status, 0, result.stderr);
	const lines = auditLines(paths);
	assert.equal(lines.length, 1, "one search writes one audit line");
	const fingerprint = createHash("sha256").update(PHONE_ID).digest("hex").slice(0, 12);
	assert.match(lines[0]!, new RegExp(fingerprint), "the line holds the fingerprint of the thread");
	assert.doesNotMatch(lines[0]!, /15550001111/, "the line holds no chat id");
	assert.doesNotMatch(lines[0]!, /Fixture Person/, "the line holds no name");
	assert.doesNotMatch(lines[0]!, /contract/, "the line holds no query and no message text");
});

test("a locked index is never stale, and a damaged one is rebuilt from raw/", (t) => {
	const paths = tempRoot(t);
	const store = openMessagingStore(paths.store);
	seedArchive(store);
	store.close();
	const indexPath = join(paths.store, "messages.db");
	const before = readFileSync(indexPath);

	// Locked: another process holds the database (the sync job may hold it).
	const holder = new DatabaseSync(indexPath);
	holder.exec("PRAGMA locking_mode = EXCLUSIVE");
	holder.exec("BEGIN EXCLUSIVE");
	holder.prepare("SELECT COUNT(*) FROM messages").get();
	try {
		assert.equal(indexIsStale(indexPath), false, "a locked database is not stale");
	} finally {
		holder.exec("ROLLBACK");
		holder.close();
	}
	assert.deepEqual(readFileSync(indexPath), before, "the index is untouched");

	// Damaged: the file is not a database any more.
	writeFileSync(indexPath, "this is not a database");
	assert.equal(indexIsStale(indexPath), true, "a damaged index is stale");
	const rebuilt = openMessagingStore(paths.store);
	try {
		assert.equal(rebuilt.counts().messages, 2, "the index is rebuilt from raw/");
		assert.equal(rebuilt.counts().events, 1, "the events are rebuilt too");
	} finally {
		rebuilt.close();
	}
});

test("msg status reports the folder, its size, the last pull and the counts", (t) => {
	const paths = tempRoot(t);
	const store = openMessagingStore(paths.store);
	seedArchive(store);
	store.close();

	const result = run(["status"], paths);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /size/i, "the folder size is reported");
	assert.match(result.stdout, /2026-10-25T10:00:00\.000Z/, "the last pull is reported");
	assert.match(result.stdout, /messages 2/, "the counts are reported");
});

test("msg rebuild recreates the index from raw/ and the counts stay the same", (t) => {
	const paths = tempRoot(t);
	const store = openMessagingStore(paths.store);
	seedArchive(store);
	store.close();

	const before = run(["status"], paths);
	assert.equal(before.status, 0, before.stderr);
	const rebuilt = run(["rebuild"], paths);
	assert.equal(rebuilt.status, 0, rebuilt.stderr);
	assert.match(rebuilt.stdout, /4 records/, "the rebuild replays the four archived records");
	const after = run(["status"], paths);
	assert.equal(after.status, 0, after.stderr);
	assert.match(after.stdout, /messages 2/, "the rebuilt index holds the same messages");
	assert.match(after.stdout, /events 1/, "the rebuilt index holds the same events");
});

test("the CLI names the channel when one chat id lives in two channels", (t) => {
	const paths = tempRoot(t);
	const store = openMessagingStore(paths.store);
	store.archiveMessage(message({ channel: WHATSAPP, chatId: PHONE_ID, messageId: "MSG-1", text: "whatsapp line", at: "2026-10-24T09:00:00.000Z" }));
	store.archiveMessage(message({ channel: VIBER, chatId: PHONE_ID, messageId: "MSG-1", text: "viber line", at: "2026-10-24T09:01:00.000Z" }));
	store.close();

	const listed = run(["threads", "--channel", VIBER], paths);
	assert.equal(listed.status, 0, listed.stderr);
	assert.match(listed.stdout, /viber/, "the viber thread is listed");
	assert.doesNotMatch(listed.stdout, /whatsapp/, "the whatsapp thread is not listed");

	const read = run(["read", PHONE_ID, "--channel", VIBER], paths);
	assert.equal(read.status, 0, read.stderr);
	assert.match(read.stdout, /viber line/, "the viber thread's message is printed");
	assert.doesNotMatch(read.stdout, /whatsapp line/, "the whatsapp message is not printed");

	const ambiguous = run(["read", PHONE_ID], paths);
	assert.notEqual(ambiguous.status, 0, "an ambiguous chat id is refused, not guessed");
	assert.match(ambiguous.stderr, /channel/, "the refusal names the channel to use");
});

test("two channels with the same chat id are two threads, not one", (t) => {
	const paths = tempRoot(t);
	const store = openMessagingStore(paths.store);
	t.after(() => store.close());

	store.archiveMessage(message({ channel: WHATSAPP, chatId: PHONE_ID, messageId: "MSG-1", text: "whatsapp line", at: "2026-10-24T09:00:00.000Z" }));
	store.archiveMessage(message({ channel: VIBER, chatId: PHONE_ID, messageId: "MSG-1", text: "viber line", at: "2026-10-24T09:01:00.000Z" }));

	const threads = store.threads();
	assert.equal(threads.length, 2, "one thread per channel, not one thread for both");
	assert.deepEqual(threads.map((row) => row.channel).sort(), [VIBER, WHATSAPP].sort());
	assert.equal(store.counts().messages, 2, "the same message id in two channels is two messages");

	const whatsapp = store.readThread(PHONE_ID, { channel: WHATSAPP });
	assert.deepEqual(whatsapp.messages.map((row) => row.text), ["whatsapp line"], "the whatsapp thread holds its own line");
	const viber = store.readThread(PHONE_ID, { channel: VIBER });
	assert.deepEqual(viber.messages.map((row) => row.text), ["viber line"], "the viber thread holds its own line");
	assert.throws(() => store.readThread(PHONE_ID), /channel/, "an ambiguous chat id is refused, not guessed");
});

test("an edit's replacement text is searchable, and the original is still found", (t) => {
	const paths = tempRoot(t);
	const store = openMessagingStore(paths.store);
	t.after(() => store.close());

	store.archiveMessage(message({ chatId: PHONE_ID, messageId: "MSG-1", text: "the contract is ready", at: "2026-10-24T09:00:00.000Z" }));
	store.archiveEvent({
		channel: WHATSAPP,
		chatId: PHONE_ID,
		messageId: "MSG-1",
		event: "edited",
		at: "2026-10-24T09:10:00.000Z",
		text: "the contract is signed",
		recordedAt: PULLED_AT,
	});

	const current = store.search("signed");
	assert.equal(current.length, 1, "the replacement text of the edit is searchable");
	assert.equal(current[0]!.currentText, "the contract is signed", "the search shows the current text");
	assert.match(current[0]!.snippet, /signed/, "the current text comes with the match in context");

	const original = store.search("ready");
	assert.equal(original.length, 1, "the original text is still found");
	assert.equal(original[0]!.currentText, "the contract is signed", "the search still shows the current text");
	assert.equal(original[0]!.edited, true, "the hit says the message was edited");
});
