import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findInboxMessage, markInboxMessageRead, writeInboxMessage } from "../lib/agent-inbox.ts";
import {
	assertAttachmentSet,
	AttachmentTooLarge,
	attachmentsRoot,
	MAX_ATTACHMENT_BYTES,
	MAX_MESSAGE_ATTACHMENTS,
	resolveAttachment,
	sanitizeAttachmentName,
	storeAttachment,
} from "../lib/inbox-attachments.ts";

function withDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "inbox-attachments-"));
	return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("a stored file resolves by id with its size and sha256, mode 0700 for the directory and 0600 for the files", async () => {
	await withDir(async (dir) => {
		const source = join(dir, "source.txt");
		writeFileSync(source, "hello henry");
		const ref = await storeAttachment(dir, { sourcePath: source, name: "source.txt", from: "pi-a", to: "grokbot" });
		assert.equal(ref.size, 11);
		assert.equal(ref.sha256, createHash("sha256").update("hello henry").digest("hex"));
		const stored = resolveAttachment(dir, ref.id);
		assert.ok(stored);
		assert.equal(readFileSync(stored.path, "utf8"), "hello henry");
		assert.equal(stored.meta.from, "pi-a");
		assert.equal(stored.meta.to, "grokbot");
		const folder = join(attachmentsRoot(dir), ref.id);
		assert.equal(statSync(folder).mode & 0o777, 0o700);
		assert.equal(statSync(stored.path).mode & 0o777, 0o600);
		assert.deepEqual(readdirSync(folder).sort(), ["data", "meta.json"]);
	});
});

test("a stream is stored the same way and a name with separators, quotes and control characters is cut to a base name", async () => {
	await withDir(async (dir) => {
		const ref = await storeAttachment(dir, { stream: (async function* () { yield Buffer.from("ab"); yield Buffer.from("cd"); })(), name: '../../etc/pa"ss\\wd\n.txt', from: "grokbot", to: "pi-a" });
		assert.equal(ref.size, 4);
		assert.equal(ref.name, "wd_.txt");
		assert.equal(sanitizeAttachmentName('a"b\\c.txt'), "c.txt");
		assert.equal(sanitizeAttachmentName('a"b.txt'), "a_b.txt");
		assert.equal(sanitizeAttachmentName("доклад.pdf"), "доклад.pdf");
		assert.equal(sanitizeAttachmentName("a/../b"), "b");
		assert.equal(sanitizeAttachmentName(".."), "_");
		assert.equal(sanitizeAttachmentName(""), "file");
		assert.equal(sanitizeAttachmentName("x".repeat(300)).length, 120);
	});
});

test("a file over the cap throws AttachmentTooLarge and leaves nothing behind, temp file included", async () => {
	await withDir(async (dir) => {
		const big = (async function* () { yield Buffer.alloc(600); yield Buffer.alloc(600); })();
		await assert.rejects(() => storeAttachment(dir, { stream: big, name: "big.bin", from: "grokbot", to: "pi-a", maxBytes: 1000 }), AttachmentTooLarge);
		assert.deepEqual(readdirSync(attachmentsRoot(dir)), []);
	});
});

test("a stream that fails midway leaves nothing behind", async () => {
	await withDir(async (dir) => {
		const broken = (async function* () { yield Buffer.from("partial"); throw new Error("connection reset"); })();
		await assert.rejects(() => storeAttachment(dir, { stream: broken, name: "x.bin", from: "grokbot", to: "pi-a" }), /connection reset/);
		assert.deepEqual(readdirSync(attachmentsRoot(dir)), []);
	});
});

test("an id that is not a UUID resolves to nothing, whatever path it spells", async () => {
	await withDir(async (dir) => {
		for (const id of ["", "..", "../x", "a/b", "0000", "00000000-0000-0000-0000-00000000000/../x"]) assert.equal(resolveAttachment(dir, id), undefined);
		assert.equal(resolveAttachment(dir, "00000000-0000-4000-8000-000000000000"), undefined);
	});
});

test("a message carries at most 10 files of 50 MiB each and 200 MiB in all", () => {
	assertAttachmentSet([1, 2, 3]);
	assert.throws(() => assertAttachmentSet(new Array(MAX_MESSAGE_ATTACHMENTS + 1).fill(1)), /at most 10 files/);
	assert.throws(() => assertAttachmentSet([MAX_ATTACHMENT_BYTES + 1]), AttachmentTooLarge);
	assert.throws(() => assertAttachmentSet(new Array(5).fill(MAX_ATTACHMENT_BYTES)), AttachmentTooLarge);
});

test("findInboxMessage finds a message pending or already read, and compares the id with file names only", async () => {
	await withDir(async (dir) => {
		writeInboxMessage(dir, { id: "m-1", agent: "grokbot", from: "pi-a", at: "2026-10-13T10:00:00.000Z", text: "one", idempotencyKey: "k1", attachments: [{ id: "a", name: "n", size: 1, sha256: "s" }] });
		writeInboxMessage(dir, { id: "m-2", agent: "grokbot", from: "pi-a", at: "2026-10-13T10:00:01.000Z", text: "two", idempotencyKey: "k2" });
		assert.equal(findInboxMessage(dir, "grokbot", "m-1")?.attachments?.[0]?.name, "n");
		markInboxMessageRead(dir, "grokbot", "m-1");
		assert.equal(findInboxMessage(dir, "grokbot", "m-1")?.text, "one");
		assert.equal(findInboxMessage(dir, "grokbot", "m-3"), undefined);
		for (const id of ["", "..", "../../x", "m-"]) assert.equal(findInboxMessage(dir, "grokbot", id), undefined);
		assert.equal(findInboxMessage(dir, "someone-else", "m-2"), undefined);
	});
});
