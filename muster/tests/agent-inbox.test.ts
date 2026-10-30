/**
 * Agent inbox (06:19 brief, build 1): one file per message, written whole,
 * read once into `read/`, never deleted, and a torn file never blocks a reader.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	agentInboxDir,
	agentInboxReadDir,
	countInboxMessages,
	listInboxAgents,
	listInboxMessages,
	markInboxMessageRead,
	writeInboxMessage,
} from "../lib/agent-inbox.ts";

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "agent-inbox-"));
}

const message = (over: Record<string, unknown> = {}): Parameters<typeof writeInboxMessage>[1] => ({
	agent: "orchestrator",
	from: "pi-core",
	text: "REVIEW READY: harness-bus-o1@c76dcf4",
	idempotencyKey: "key-1",
	at: "2026-10-08T03:20:00.000Z",
	...over,
});

test("one message is one file: whole, mode 0600, no temp file left behind", () => {
	const dir = tmp();
	try {
		const file = writeInboxMessage(dir, message());
		assert.equal(dirname(file), agentInboxDir(dir, "orchestrator"));
		assert.equal(statSync(file).mode & 0o777, 0o600);
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		assert.equal(parsed["text"], "REVIEW READY: harness-bus-o1@c76dcf4");
		assert.equal(parsed["from"], "pi-core");
		assert.equal(parsed["agent"], "orchestrator");
		assert.equal(parsed["idempotencyKey"], "key-1");
		assert.equal(parsed["at"], "2026-10-08T03:20:00.000Z");
		assert.equal(typeof parsed["id"], "string");
		assert.deepEqual(readdirSync(agentInboxDir(dir, "orchestrator")), [basename(file)], "the rename leaves the temp file behind only on failure");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("messages are listed in arrival order, and an empty or torn file is skipped rather than thrown", () => {
	const dir = tmp();
	try {
		const first = writeInboxMessage(dir, message({ text: "first", at: "2026-10-08T03:20:00.000Z", idempotencyKey: "k1" }));
		const second = writeInboxMessage(dir, message({ text: "second", at: "2026-10-08T03:20:01.000Z", idempotencyKey: "k2" }));
		writeFileSync(join(agentInboxDir(dir, "orchestrator"), "2026-10-08T03:20:02.000Z-torn.json"), "");
		writeFileSync(join(agentInboxDir(dir, "orchestrator"), "2026-10-08T03:20:03.000Z-partial.json"), '{"agent":"orchestrator","text":');
		const listed = listInboxMessages(dir, "orchestrator");
		assert.deepEqual(listed.map((m) => m.text), ["first", "second"]);
		assert.equal(countInboxMessages(dir, "orchestrator"), 2);
		assert.ok(first !== second);
		assert.equal(listInboxMessages(dir, "someone-else").length, 0, "an agent with no inbox reads as empty, not an error");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a read message moves into read/ beside the inbox and is kept, not deleted", () => {
	const dir = tmp();
	try {
		writeInboxMessage(dir, message({ idempotencyKey: "k1" }));
		const listed = listInboxMessages(dir, "orchestrator");
		const read = listed[0];
		assert.ok(read !== undefined);
		assert.equal(markInboxMessageRead(dir, "orchestrator", read.id), true);
		assert.equal(listInboxMessages(dir, "orchestrator").length, 0, "the pending inbox is empty after the move");
		const kept = readdirSync(agentInboxReadDir(dir, "orchestrator"));
		assert.equal(kept.length, 1);
		assert.equal(JSON.parse(readFileSync(join(agentInboxReadDir(dir, "orchestrator"), kept[0]!), "utf8")).text, "REVIEW READY: harness-bus-o1@c76dcf4");
		assert.equal(markInboxMessageRead(dir, "orchestrator", read.id), false, "a second move of the same id does nothing");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an agent id cannot escape the inbox root", () => {
	const dir = tmp();
	try {
		const file = writeInboxMessage(dir, message({ agent: "../../etc/evil" }));
		assert.ok(file.startsWith(join(dir, "inbox")), `stayed inside the inbox root: ${file}`);
		assert.equal(file.includes(".."), false);
		assert.equal(countInboxMessages(dir, "../../etc/evil"), 1, "the same sanitised agent reads it back");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("only agents with a pending message are listed, with their counts", () => {
	const dir = tmp();
	try {
		assert.deepEqual(listInboxAgents(dir), []);
		writeInboxMessage(dir, message({ agent: "orchestrator" }));
		writeInboxMessage(dir, message({ agent: "cc-mods", idempotencyKey: "k2" }));
		writeInboxMessage(dir, message({ agent: "cc-mods", idempotencyKey: "k3", at: "2026-10-08T03:21:00.000Z" }));
		assert.deepEqual(listInboxAgents(dir), ["cc-mods", "orchestrator"]);
		assert.equal(countInboxMessages(dir, "cc-mods"), 2);
		// A read/ subdirectory must never be mistaken for an agent named "read".
		const listed = listInboxMessages(dir, "cc-mods");
		markInboxMessageRead(dir, "cc-mods", listed[0]!.id);
		assert.equal(countInboxMessages(dir, "cc-mods"), 1);
		assert.deepEqual(listInboxAgents(dir), ["cc-mods", "orchestrator"], "an agent with one message left is still listed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
