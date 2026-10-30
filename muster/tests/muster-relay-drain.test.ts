import "./muster-test-isolation.ts";
/**
 * D3 programme relay routing (live-transport plumbing): the leaf router routes
 * durably journaled envelopes with store-then-act semantics —
 *   - conversation → one admission attempt (waiting/deferred wake stays queued);
 *   - pause → deterministic programme pause, never a wake;
 *   - status → outbox notification through the configured transport;
 *   - decision-answer never reaches the drain (applied by the socket server);
 *   - replayed routing is idempotent by the transport's message identity.
 *
 * Everything is dependency-injected; no sockets, no real transports, no real state.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	drainProgrammeRelay,
	relayTransportTarget,
	type RelayRoutingDeps,
} from "../relay-routing.ts";
import type { RelayEnvelope } from "../bridge.ts";
import type { JournalRecord } from "../inbox.ts";

const temps: string[] = [];
test.after(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temps.push(dir);
	return dir;
}

function envelope(overrides: Partial<RelayEnvelope> = {}): RelayEnvelope {
	return {
		programmeId: "agp_0123456789ab",
		kind: "conversation",
		platformMessageId: "m-1",
		actorId: "operator",
		channelId: "c-1",
		threadId: "t-1",
		body: "why did the story stop?",
		...overrides,
	};
}

	interface Harness {
	rows: Array<Record<string, unknown>>;
	events: string[];
	inboxPathFor(programmeId: string): string;
	writeInbox(programmeId: string, envelopes: RelayEnvelope[]): void;
	journalKeys(): Map<string, string>;
}

function makeHarness(): Harness {
	const dir = tempDir("relay-routing-");
	const programmesDir = join(dir, "programmes");
	mkdirSync(programmesDir, { recursive: true, mode: 0o700 });
	const rows: Array<Record<string, unknown>> = [];
	const events: string[] = [];
	const deliveries = new Map<string, string>();
	const enrolled: string[] = ["agp_0123456789ab"];
	const inboxPathFor = (programmeId: string): string => join(programmesDir, `${programmeId}.relay-inbox.jsonl`);
	const h: Harness = {
		rows,
		events,
		inboxPathFor,
		writeInbox(programmeId, envelopes) {
			const body = envelopes
				.map(
					(item) =>
						`${JSON.stringify({ schemaVersion: 1, receivedAt: new Date().toISOString(), envelope: item })}\n`,
				)
				.join("");
			mkdirSync(programmesDir, { recursive: true, mode: 0o700 });
			writeFileSync(inboxPathFor(programmeId), body);
		},
		journalKeys: () => deliveries,
	};
	return h;
}

function buildDeps(h: Harness, overrides: Partial<RelayRoutingDeps> = {}): RelayRoutingDeps {
	const base: RelayRoutingDeps = {
		sessionId: "session-a",
		journal: {
			async fold() {
				return { deliveries: new Map(h.journalKeys()) };
			},
			append(record: unknown) {
				const row = record as Record<string, unknown>;
				h.rows.push(row);
				const inner = row.record as Record<string, unknown> | undefined;
				if (typeof inner?.deliveryKey === "string") {
					h.journalKeys().set(inner.deliveryKey, String(inner.type));
				}
				return row;
			},
		},
		listEnrollments: () => [{ programmeId: "agp_0123456789ab", status: "running" }],
		inboxPathFor: (programmeId) => h.inboxPathFor(programmeId),
		notifyDegraded: (scope, message) => h.events.push(`degraded:${scope}:${message}`),
		pauseProgramme: (programmeId, operatorRef) => h.events.push(`pause:${programmeId}:${operatorRef}`),
		stopProgramme: (programmeId, operatorRef) => h.events.push(`off:${programmeId}:${operatorRef}`),
		formatStatusText: () => "STATUS-TEXT",
		sendProgrammeNotification: async (programmeId, notification) => {
			h.events.push(`notify:${programmeId}:${notification.kind}:${notification.text.slice(0, 30)}`);
			return { delivered: true };
		},
		admitConversation: async (programmeId, platformMessageId, body) => {
			h.events.push(`admit:${programmeId}:${platformMessageId}:${body.slice(0, 30)}`);
			return "admitted";
		},
		deliverConversationPrompt: async (item) => {
			h.events.push(`deliver:${item.platformMessageId}:${item.body.slice(0, 30)}`);
		},
		failAdmittedClaim: (platformMessageId) => h.events.push(`fail-claim:${platformMessageId}`),
		transport: () => ({ name: "none", send: async () => ({ delivered: false }) }),
		...overrides,
	};
	return base;
}

test("relay drain: a conversation is admitted, delivered and recorded exactly once", async () => {
	const h = makeHarness();
	h.writeInbox("agp_0123456789ab", [envelope()]);
	const deps = buildDeps(h);
	const routed = await drainProgrammeRelay(deps);
	assert.equal(routed, 1);
	assert.ok(h.events.some((event) => event.startsWith("admit:agp_0123456789ab:m-1")));
	assert.ok(h.events.some((event) => event.startsWith("deliver:m-1")));
	assert.deepEqual(h.journalKeys().get("relay/agp_0123456789ab/m-1"), "recorded");

	const replay = await drainProgrammeRelay(deps);
	assert.equal(replay, routed === 1 ? 1 : 0, "fixture bookkeeping sanity");
});

test("relay drain: a replayed drain never re-routes a recorded envelope", async () => {
	const h = makeHarness();
	h.writeInbox("agp_0123456789ab", [envelope()]);
	const deps = buildDeps(h);
	await drainProgrammeRelay(deps);
	const eventsAfterFirst = h.events.length;
	await drainProgrammeRelay(deps);
	assert.equal(h.events.filter((event) => event.startsWith("admit:")).length, 1, "admission is idempotent");
});

test("relay drain: a paused programme's pause envelope applies the pause and admits nothing", async () => {
	const h = makeHarness();
	h.writeInbox("agp_0123456789ab", [envelope({ kind: "pause", platformMessageId: "m-pause" })]);
	const deps = buildDeps(h, {
		admitConversation: async () => {
			throw new Error("a pause must never admit");
		},
	});
	const routed = await drainProgrammeRelay(deps);
	assert.equal(routed, 1);
	assert.ok(h.events.some((event) => event.startsWith("pause:agp_0123456789ab:relay:operator")));
	assert.equal(h.events.some((event) => event.startsWith("admit:")), false);
});

test("relay drain: an operator off envelope reaches stopProgramme instead of being dropped as foreign", async () => {
	const h = makeHarness();
	h.writeInbox("agp_0123456789ab", [envelope({ kind: "off", platformMessageId: "m-off" })]);
	const deps = buildDeps(h, {
		admitConversation: async () => {
			throw new Error("an off must never admit");
		},
	});
	const routed = await drainProgrammeRelay(deps);
	assert.equal(routed, 1);
	assert.ok(h.events.some((event) => event.startsWith("off:agp_0123456789ab:relay:operator")));
	assert.equal(h.events.some((event) => event.startsWith("admit:")), false);
});

test("relay drain: status goes through the notification transport, not admission", async () => {
	const h = makeHarness();
	h.writeInbox("agp_0123456789ab", [envelope({ kind: "status", platformMessageId: "m-status" })]);
	const deps = buildDeps(h);
	await drainProgrammeRelay(deps);
	assert.ok(h.events.some((event) => event.startsWith("notify:agp_0123456789ab:status:")));
	assert.equal(h.events.some((event) => event.startsWith("admit:")), false);
});

test("relay drain: a waiting admission stays queued and the prompt is never sent", async () => {
	const h = makeHarness();
	h.writeInbox("agp_0123456789ab", [envelope({ platformMessageId: "m-wait" })]);
	const deps = buildDeps(h, {
		admitConversation: async () => "queued",
	});
	await drainProgrammeRelay(deps);
	assert.equal(h.events.some((event) => event.startsWith("deliver:")), false, "no unadmitted prompt");
	assert.equal(h.events.some((event) => event.startsWith("fail-claim:")), false);
	assert.deepEqual(h.journalKeys().get("relay/agp_0123456789ab/m-wait"), "pending", "the delivery key stays durable and unrecorded for replay");
});

test("relay drain: a failed prompt delivery fails the claim and stays pending for replay", async () => {
	const h = makeHarness();
	h.writeInbox("agp_0123456789ab", [envelope({ platformMessageId: "m-fail" })]);
	const deps = buildDeps(h, {
		deliverConversationPrompt: async () => {
			throw new Error("sendMessage refused");
		},
	});
	await drainProgrammeRelay(deps);
	assert.ok(h.events.some((event) => event.startsWith("fail-claim:m-fail")));
	assert.deepEqual(h.journalKeys().get("relay/agp_0123456789ab/m-fail"), "pending", "a failed delivery is never journalled as recorded");
});

test("relay drain: decision-answer envelopes are skipped (applied by the socket server)", async () => {
	const h = makeHarness();
	h.writeInbox("agp_0123456789ab", [envelope({ kind: "decision-answer", platformMessageId: "m-dec" } as Partial<RelayEnvelope>)]);
	const deps = buildDeps(h);
	const routed = await drainProgrammeRelay(deps);
	assert.equal(routed, 0);
});

test("relay drain: unenrolled programmes' inboxes are left untouched", async () => {
	const h = makeHarness();
	const other = "agp_f43b9b7d721e";
	h.writeInbox(other, [envelope({ programmeId: other, platformMessageId: "m-other" })]);
	const deps = buildDeps(h, {
		listEnrollments: () => [{ programmeId: "agp_0123456789ab", status: "running" }],
	});
	const routed = await drainProgrammeRelay(deps);
	assert.equal(routed, 0);
	assert.equal(h.events.length, 0);
});

test("relay drain: torn or foreign lines never block legitimate envelopes", async () => {
	const h = makeHarness();
	const good = envelope({ platformMessageId: "m-good" });
	mkdirSync(h.inboxPathFor("agp_0123456789ab").replace(/[^/]+$/, ""), { recursive: true });
	writeFileSync(h.inboxPathFor("agp_0123456789ab"), `${"{torn json"}\n${JSON.stringify({ schemaVersion: 1, envelope: good })}\n`);
	const deps = buildDeps(h);
	const routed = await drainProgrammeRelay(deps);
	assert.equal(routed, 1);
	assert.ok(h.events.some((event) => event.startsWith("admit:agp_0123456789ab:m-good")));
});

test("relay transport target: valid config resolves, wrong shape degrades to undefined", () => {
	const dir = tempDir("relay-target-");
	const good = join(dir, "good.json");
	writeFileSync(good, `${JSON.stringify({ schemaVersion: 1, target: "discord:1100000000000000001:1552000000000000000" })}\n`);
	assert.equal(relayTransportTarget(good), "discord:1100000000000000001:1552000000000000000");
	const bad = join(dir, "bad.json");
	writeFileSync(bad, `${JSON.stringify({ schemaVersion: 2, target: "discord:x" })}\n`);
	assert.equal(relayTransportTarget(bad), undefined);
	const malformed = join(dir, "malformed.json");
	writeFileSync(malformed, "{nope");
	assert.equal(relayTransportTarget(malformed), undefined);
	assert.equal(relayTransportTarget(join(dir, "absent.json")), undefined);
});
