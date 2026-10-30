import "./muster-test-isolation.ts";
/**
 * R1 (architect VR24-81) of MG5: the index rebuild of a store another process holds.
 *
 * `existingTriageRows` used to answer "no rows" for ANY open error, so a `msg rebuild`
 * while another process held the database dropped the triage rows — the one thing `raw/`
 * cannot replay. Only a damaged file may yield no rows now: a busy or locked database
 * stops the rebuild with "index in use", and the rows stay where they are.
 *
 * Fixtures are synthetic ids and text only.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openMessagingStore, type MessagingStore } from "../messaging/store.ts";

const CHANNEL = "whatsapp";
const DIRECT = "15550002222@c.us";
const PULLED_AT = "2026-10-25T09:00:00.000Z";

function tempRoot(t: test.TestContext): string {
	const root = mkdtempSync(join(tmpdir(), "messaging-rebuild-"));
	rmSync(root, { recursive: true, force: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function seed(store: MessagingStore): void {
	store.archiveMessage({
		channel: CHANNEL,
		chatId: DIRECT,
		messageId: "A-1",
		timestamp: Date.parse("2026-10-25T09:00:00.000Z"),
		fromMe: false,
		senderId: DIRECT,
		type: "chat",
		text: "one synthetic question",
		payload: { id: "A-1", from: DIRECT, body: "one synthetic question" },
		recordedAt: PULLED_AT,
	});
	store.triage.record({
		channel: CHANNEL,
		threadId: DIRECT,
		state: "triaged",
		needsReply: "yes",
		urgency: "today",
		kind: "personal",
		basisMessageId: "A-1",
		basisTimestamp: Date.parse("2026-10-25T09:00:00.000Z"),
		questionSet: "messaging-triage",
		setVersion: 1,
		triagedAt: "2026-10-25T12:00:00.000Z",
		model: "stub/classifier",
		stopReason: null,
		inputTokens: 100,
		outputTokens: 5,
		costUsd: 0.0002,
		stateBytes: 512,
	});
}

test("R1 1: a database another process holds stops the rebuild, and the triage rows survive", (t) => {
	const root = tempRoot(t);
	const store = openMessagingStore(root);
	try {
		seed(store);

		// Another process holds the database: it holds SQLite's write lock, so the index
		// cannot be replaced under it.
		const holder = new DatabaseSync(join(root, "messages.db"));
		holder.exec("BEGIN IMMEDIATE");
		holder.prepare("UPDATE thread_triage SET triaged_at = triaged_at WHERE channel = ?").run(CHANNEL);

		assert.throws(() => store.rebuild(), /index in use/, "a held database is never rebuilt");

		holder.exec("ROLLBACK");
		holder.close();

		const rebuilt = store.rebuild();
		assert.equal(rebuilt.messages, 1, "the archive is replayed into the recreated index");
		const row = store.triage.read(CHANNEL, DIRECT);
		assert.equal(row?.needsReply, "yes", "the classifier answer is not in raw/, so it must survive");
		assert.equal(row?.state, "triaged");
	} finally {
		store.close();
	}
});

test("R1 2: a damaged index file is replaced and yields no rows, and the archive is replayed", (t) => {
	const root = tempRoot(t);
	const store = openMessagingStore(root);
	try {
		seed(store);
	} finally {
		store.close();
	}

	// A file that is not a database: the archive is the truth, so the index is recreated.
	writeFileSync(join(root, "messages.db"), "this is not a database at all");

	const reopened = openMessagingStore(root);
	try {
		assert.equal(reopened.counts().messages, 1, "the archive is replayed into the recreated index");
		assert.equal(reopened.triage.read(CHANNEL, DIRECT), null, "a damaged file yields no rows");
	} finally {
		reopened.close();
	}
});
