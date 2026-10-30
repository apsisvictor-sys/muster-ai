/**
 * `muster wait --inbox` — the reader half: return on the first whole message,
 * never wait for a second one, and never lose a message that was already there.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { formatInboxWaitResult, waitOnInbox } from "../inbox-wait.ts";
import type { InboxMessage } from "../lib/agent-inbox.ts";

const message = (over: Partial<InboxMessage> = {}): InboxMessage => ({
	id: "m1",
	agent: "orchestrator",
	from: "pi-core",
	at: "2026-10-08T03:30:00.000Z",
	text: "REVIEW READY: harness-bus-o1@c76dcf4",
	idempotencyKey: "k1",
	...over,
});

test("a message already waiting is returned on the first read, with no sleep", async () => {
	let sleeps = 0;
	const result = await waitOnInbox({
		agent: "orchestrator",
		read: () => [message()],
		timeoutMs: 5_000,
		pollMs: 1_000,
		sleep: async () => { sleeps += 1; },
	});
	assert.equal(result.messages.length, 1);
	assert.equal(result.messages[0]!.text, "REVIEW READY: harness-bus-o1@c76dcf4");
	assert.equal(sleeps, 0, "an armed reader must not wait for a second message");
});

test("empty polls are slept through until the first message arrives", async () => {
	let reads = 0;
	const seen: number[] = [];
	const result = await waitOnInbox({
		agent: "orchestrator",
		read: () => {
			reads += 1;
			return reads >= 3 ? [message({ text: "late" })] : [];
		},
		timeoutMs: 60_000,
		pollMs: 250,
		sleep: async (ms) => { seen.push(ms); },
	});
	assert.equal(result.messages[0]!.text, "late");
	assert.deepEqual(seen, [250, 250], "two empty polls, then the message");
});

test("a timeout returns no message rather than an error", async () => {
	const result = await waitOnInbox({
		agent: "orchestrator",
		read: () => [],
		timeoutMs: 1_000,
		pollMs: 400,
		now: (() => { let t = 0; return () => (t += 400); })(),
		sleep: async () => undefined,
	});
	assert.deepEqual(result.messages, []);
	assert.equal(result.aborted, false);
	assert.match(formatInboxWaitResult(result), /nothing in orchestrator's inbox/);
});

test("a wait with no timeout keeps waiting past 120 s of fake time, then returns the message", async () => {
	let clock = 0;
	let reads = 0;
	const result = await waitOnInbox({
		agent: "sn-lane",
		read: () => {
			reads += 1;
			return clock >= 600_000 ? [message({ agent: "sn-lane", text: "late" })] : [];
		},
		timeoutMs: Number.POSITIVE_INFINITY,
		pollMs: 2_000,
		now: () => clock,
		sleep: async (ms) => { clock += ms; },
	});
	assert.equal(result.messages[0]!.text, "late");
	assert.equal(result.aborted, false);
	assert.equal(result.elapsedMs, 600_000, "ten minutes passed with no expiry");
	assert.equal(reads, 301);
});

test("a signal stops the wait", async () => {
	const controller = new AbortController();
	controller.abort();
	const result = await waitOnInbox({
		agent: "orchestrator",
		read: () => [],
		timeoutMs: 10_000,
		pollMs: 100,
		signal: controller.signal,
		sleep: async () => undefined,
	});
	assert.equal(result.aborted, true);
	assert.match(formatInboxWaitResult(result), /stopped waiting/);
});

test("from -> text is what the reader prints, and a reply names the message it answers", () => {
	const text = formatInboxWaitResult({ agent: "orchestrator", messages: [message({ replyTo: "7a6cd91c" })], elapsedMs: 5, aborted: false });
	assert.match(text, /pi-core -> REVIEW READY: harness-bus-o1@c76dcf4 \(reply to 7a6cd91c\)/);
});
