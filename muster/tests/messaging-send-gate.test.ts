import "./muster-test-isolation.ts";
/**
 * MG6 (messaging agent, VR24-62, VR24-72, VR24-85; blueprint G7 to G12): approval and the send
 * gate, against a fake WAHA on a loopback port this file starts. The live container is never
 * called, no real chat text is used, and the store and the ask queue are temp folders.
 *
 * The contract:
 *  - one tap -> exactly one `sendText` to the draft's chat, the ask `done` with the log line that
 *    holds the message id; a second run, a duplicate timer or a replayed tap -> 0 calls;
 *  - a draft whose stored text no longer matches its hash is refused; an answer in words, by
 *    Henry's relay, by the architect or by the CLI is refused (only the page's tap qualifies);
 *  - the send intent is written to `send.log` before the call and survives a deleted index; a crash
 *    after the intent gives `unknown`, no second call, and one operator-action ask with no name;
 *  - a newer message, an edit or a revoke of the basis, or the session not WORKING -> no call;
 *  - a thread that arrives under `@lid` and `@c.us` sends to the id the draft's hash was made from;
 *  - the first live send goes to the operator's own chat until his page releases it.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
	AskStateError,
	answerAsk,
	answerAskResult,
	askVersion,
	raiseAsk,
	prepareAsk,
	readAsks,
	resolveAskWriter,
	standingRuleDrafts,
	type Ask,
} from "../asks.ts";
import {
	MESSAGE_ASK_QUESTION,
	MESSAGE_ASK_SOURCE_PREFIX,
	UNKNOWN_ASK_QUESTION,
	liveDraftAsk,
	nextMessageCode,
	parseMessageAskSource,
	raiseDraftAsk,
	raiseDraftAsks,
	withdrawStaleDrafts,
} from "../messaging/approval.ts";
import { draftHash, runDrafts, threadFingerprint, type DraftWriter } from "../messaging/drafts.ts";
import { appendSendEvent, draftSendView, readSendLog, sendLogPath, SendLogError } from "../messaging/send-log.ts";
import { isPageTap, runSendGate, type SendGatePorts } from "../messaging/send-gate.ts";
import { openMessagingStore, type MessagingStore } from "../messaging/store.ts";
import { createWahaAdapter } from "../messaging/whatsapp.ts";
import { serializedId, startFakeWaha, type FakeChat, type FakeWaha } from "./messaging-fake-waha.ts";

const CHANNEL = "whatsapp";
const PEER = "15550002222@c.us";
const SELF = "15550001111@c.us";
const LID = "900000000000002@lid";
const NAME = "Fixture Pomegranate Person";
const INBOUND = "KIWI-INBOUND when are we meeting";
const REPLY = "Yes, PINEAPPLE-REPLY at four";
const T0 = "2026-10-25T09:00:00.000Z";
const NOW = new Date("2026-10-25T09:05:00.000Z");
const MODEL = "command-code/deepseek/deepseek-v4.1-flash";
const RELAY_AT = "2026-10-25T09:06:00.000Z";

const seconds = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

type World = {
	root: string;
	stateDir: string;
	store: MessagingStore;
	fake: FakeWaha;
	adapter: ReturnType<typeof createWahaAdapter>;
	chatId: string;
	draftId: string;
	/** Raises the draft's ask (G7). */
	raise: () => Ask;
	/** The page's tap on an ask: the one input `answerByTap` accepts. */
	tap: (ask: Ask, option?: string) => void;
	ask: (id?: string) => Ask;
	gate: (over?: Partial<SendGatePorts>) => ReturnType<typeof runSendGate>;
	/** Closes the store, optionally loses the index file, and opens it again. */
	reopen: (loseIndex?: boolean) => void;
};

type WorldOptions = {
	chats?: FakeChat[];
	/** The chat the draft is for; the fake holds it with the one inbound message. */
	chatId?: string;
	/** Id forms the store learns for the thread before drafting (the contact list's evidence). */
	contactAliases?: string[];
	/** Where the inbound message arrives, when it is not the thread's own id form. */
	arrivesAs?: string;
};

function tempDir(t: test.TestContext, prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function stubWriter(text: string): DraftWriter {
	return async () => text;
}

async function makeWorld(t: test.TestContext, options: WorldOptions = {}): Promise<World> {
	const root = tempDir(t, "messaging-gate-store-");
	const stateDir = tempDir(t, "messaging-gate-state-");
	const chatId = options.chatId ?? PEER;
	const arrives = options.arrivesAs ?? chatId;
	const inbound = { id: serializedId(arrives, "A-1"), timestamp: seconds(T0), from: arrives, body: INBOUND, type: "chat" };
	const chats: FakeChat[] = options.chats ?? [{ id: arrives, name: NAME, messages: [inbound] }];
	if (arrives !== chatId && !chats.some((chat) => chat.id === chatId)) chats.push({ id: chatId, name: NAME, messages: [] });
	const fake = await startFakeWaha({ chats });
	t.after(() => fake.close());
	fake.clock = () => seconds("2026-10-25T09:10:30.000Z");

	let store = openMessagingStore(root);
	t.after(() => store.close());
	if (options.contactAliases !== undefined) {
		store.archiveContact({ channel: CHANNEL, contactId: chatId, aliases: options.contactAliases, name: NAME, payload: { id: chatId, name: NAME }, recordedAt: T0 });
	}
	store.archiveMessage({
		channel: CHANNEL,
		chatId: arrives,
		messageId: "A-1",
		timestamp: Date.parse(T0),
		fromMe: false,
		senderId: arrives,
		type: "chat",
		text: INBOUND,
		payload: { id: "A-1", from: arrives, body: INBOUND },
		recordedAt: T0,
	});
	const threadId = store.threads()[0]!.threadId;
	store.triage.record({
		channel: CHANNEL,
		threadId,
		state: "triaged",
		needsReply: "yes",
		urgency: "today",
		kind: "personal",
		basisMessageId: "A-1",
		basisTimestamp: Date.parse(T0),
		questionSet: "messaging-triage",
		setVersion: 1,
		triagedAt: NOW.toISOString(),
		model: "stub/classifier",
		stopReason: null,
		inputTokens: 100,
		outputTokens: 5,
		costUsd: 0.0002,
		stateBytes: 512,
	});
	await runDrafts({ store, writer: stubWriter(REPLY), model: MODEL, now: () => NOW });
	const draft = store.drafts.list()[0]!;
	const adapter = createWahaAdapter({ config: { url: fake.url, apiKey: fake.key, session: fake.session }, typingDelayMs: () => 0, sleep: async () => {} });

	const world: World = {
		root,
		stateDir,
		get store() {
			return store;
		},
		fake,
		adapter,
		chatId: threadId,
		draftId: draft.draftId,
		raise: () => raiseDraftAsk(stateDir, store.drafts.read(draft.draftId)!, NOW.toISOString()),
		ask: (id?: string) => {
			const found = readAsks(stateDir).asks.find((one) => (id === undefined ? parseMessageAskSource(one.source)?.draftId === draft.draftId : one.id === id));
			assert.ok(found, "the ask exists");
			return found;
		},
		tap: (ask, option = "Send") => {
			answerAskResult(stateDir, {
				ref: ask.id,
				by: "operator-page",
				ruling: option,
				relay: { via: "command-center", ref: "relay-1", at: RELAY_AT },
				tap: { option, version: askVersion(world.ask(ask.id)) },
				at: RELAY_AT,
			});
		},
		gate: (over = {}) =>
			runSendGate({
				store,
				stateDir,
				adapter,
				config: { firstLiveSelfChatOnly: false },
				selfIds: [SELF],
				now: () => new Date("2026-10-25T09:10:00.000Z"),
				inFlightGraceMs: 0,
				...over,
			}),
		reopen: (loseIndex = false) => {
			store.close();
			if (loseIndex) for (const suffix of ["", "-wal", "-shm"]) rmSync(`${join(root, "messages.db")}${suffix}`, { force: true });
			store = openMessagingStore(root);
		},
	} as World;
	return world;
}

const sendCalls = (world: World) => world.fake.sendTexts();
const logText = (world: World): string => readFileSync(sendLogPath(world.root), "utf8");

// ── Acceptance 1: the ask (G7) ──

test("MG6 1: the draft's ask is raised by the messaging writer, as an authorization with no rule and a source that names the draft", async (t) => {
	const world = await makeWorld(t);
	const ask = world.raise();
	assert.equal(ask.raisedBy, "messaging");
	assert.equal(ask.kind, "authorization");
	assert.equal(ask.rule, undefined, "no rule: no standing rule can arise from message approvals");
	assert.equal(ask.question, MESSAGE_ASK_QUESTION);
	assert.equal(ask.question, "A WhatsApp reply is waiting for your OK. Open Messages on the command center page.");
	assert.deepEqual(ask.options, ["Send", "Don't send"]);
	assert.equal(ask.recommendation, "Don't send");
	assert.match(ask.code ?? "", /^MSG-\d+$/);
	const draft = world.store.drafts.read(world.draftId)!;
	assert.equal(ask.source, `${MESSAGE_ASK_SOURCE_PREFIX}${draft.draftId}:${draft.hash12}`);
	assert.deepEqual(parseMessageAskSource(ask.source), { draftId: draft.draftId, hash12: draft.hash12 });
	for (const secret of [NAME, INBOUND, REPLY, PEER, "15550002222"]) {
		assert.equal(JSON.stringify(ask).includes(secret), false, `the ask holds no ${secret.slice(0, 8)}…`);
	}
	assert.equal(readAsks(world.stateDir).unreadableLines, 0, "the queue reads every messaging line");
});

test("MG6 1: the messaging writer is process-internal, and it records no ruling", async (t) => {
	const world = await makeWorld(t);
	const ask = world.raise();
	for (const agentId of [undefined, "messaging", "desk", "operator-page"]) {
		const writer = resolveAskWriter({}, agentId);
		assert.notEqual("writer" in writer ? writer.writer : "", "messaging", `resolveAskWriter(${String(agentId)}) never returns messaging`);
	}
	assert.throws(
		() => answerAsk(world.stateDir, { ref: ask.id, by: "messaging", ruling: "Send" }),
		(error: unknown) => error instanceof AskStateError && /records no ruling/.test(error.message),
	);
});

test("MG6 1: three message asks answered Send give standingRuleDrafts nothing", async (t) => {
	const world = await makeWorld(t);
	for (let n = 0; n < 3; n += 1) {
		const raised = raiseAsk(world.stateDir, { by: "messaging", kind: "authorization", question: MESSAGE_ASK_QUESTION, code: nextMessageCode(readAsks(world.stateDir)), source: `${MESSAGE_ASK_SOURCE_PREFIX}${"a".repeat(15)}${n}:${"b".repeat(12)}` });
		const prepared = prepareAsk(world.stateDir, { ref: raised.id, by: "messaging", options: ["Send", "Don't send"], recommendation: "Don't send" });
		world.tap(prepared);
	}
	const queue = readAsks(world.stateDir);
	assert.equal(queue.asks.filter((ask) => ask.ruling === "Send").length, 3);
	assert.deepEqual(standingRuleDrafts(queue), []);
	assert.deepEqual(
		queue.asks.map((ask) => ask.code),
		["MSG-1", "MSG-2", "MSG-3"],
		"codes count up and are never reused",
	);
});

// ── Acceptance 2: one tap, one send ──

test("MG6 2: one tap -> exactly one sendText to the draft's chat, the ask done with the message id as evidence", async (t) => {
	const world = await makeWorld(t);
	const ask = world.raise();
	assert.equal((await world.gate()).sent, 0, "an unanswered ask sends nothing");
	assert.equal(sendCalls(world).length, 0);

	world.tap(ask);
	const run = await world.gate();
	assert.equal(run.sent, 1);
	assert.deepEqual(sendCalls(world), [{ chatId: world.chatId, text: REPLY }], "one sendText, to the draft's chat, with the draft's text");
	assert.deepEqual(
		world.fake.writes().map((call) => call.path),
		["/api/sendSeen", "/api/startTyping", "/api/sendText", "/api/stopTyping"],
		"the sequence a person produces",
	);
	for (const call of world.fake.writes()) {
		assert.equal(call.authorized, true);
		assert.equal((call.body as { chatId?: string }).chatId, world.chatId, `${call.path} names the draft's chat`);
		assert.equal((call.body as { session?: string }).session, world.fake.session);
	}

	const done = world.ask(ask.id);
	assert.equal(done.status, "done");
	const evidence = done.evidence;
	assert.ok(evidence !== undefined && "log" in evidence, "log evidence");
	const events = readSendLog(world.root);
	const line = events.find((event) => event.line === (evidence as { line: number }).line);
	assert.equal(line?.kind, "outcome");
	assert.equal((evidence as { file: string }).file, sendLogPath(world.root));
	assert.equal(line?.kind === "outcome" && line.state, "sent");
	assert.equal(line?.kind === "outcome" && line.messageId, "SENT1", "the evidence line holds the channel's message id");
	assert.equal(draftSendView(events, world.draftId).state, "sent");
});

test("MG6 2: a second run, a duplicate timer and a replayed tap send nothing more", async (t) => {
	const world = await makeWorld(t);
	const ask = world.raise();
	world.tap(ask);
	await world.gate();
	assert.equal(sendCalls(world).length, 1);

	assert.equal((await world.gate()).sent, 0, "a second run finds the ask done");
	// Two timers at once, after the tap: still nothing.
	await Promise.all([world.gate(), world.gate()]);
	// A replayed tap on a done ask is refused by the owner and changes nothing.
	assert.throws(() => world.tap(ask), (error: unknown) => error instanceof AskStateError);
	await world.gate();
	assert.equal(sendCalls(world).length, 1, "one tap, one send");
	assert.equal(world.fake.writes().length, 4);
});

test("MG6 2: two gate runs at once on one tap call the adapter once (the first intent line owns the send)", async (t) => {
	const world = await makeWorld(t);
	const ask = world.raise();
	world.tap(ask);
	let sends = 0;
	const slow = {
		...world.adapter,
		send: async (draft: Parameters<typeof world.adapter.send>[0]) => {
			sends += 1;
			await new Promise((done) => setTimeout(done, 50));
			return world.adapter.send(draft);
		},
		readChat: world.adapter.readChat,
		health: world.adapter.health,
	};
	const [first, second] = await Promise.all([world.gate({ adapter: slow }), world.gate({ adapter: slow })]);
	assert.equal(sends, 1, "the adapter was called once");
	assert.equal(sendCalls(world).length, 1);
	assert.equal(first.sent + second.sent, 1);
	assert.equal(readSendLog(world.root).filter((event) => event.kind === "intent").length, 2, "both wrote an intent; only the first line owned the send");
});

// ── Acceptance 3: what does not qualify ──

test("MG6 3: a tap on an edited draft whose hash differs is refused, and nothing is sent", async (t) => {
	const world = await makeWorld(t);
	const ask = world.raise();
	world.tap(ask);
	const db = new DatabaseSync(world.store.indexPath);
	db.prepare("UPDATE thread_drafts SET text = ? WHERE draft_id = ?").run("send the money to another account", world.draftId);
	db.close();
	const run = await world.gate();
	assert.equal(run.sent, 0);
	assert.equal(run.refused, 1);
	assert.equal(run.outcomes[0]!.reason, "hash-mismatch");
	assert.equal(sendCalls(world).length, 0);
	assert.equal(world.ask(ask.id).status, "withdrawn", "the ask of a draft that changed is withdrawn");
	assert.equal(draftSendView(readSendLog(world.root), world.draftId).state, "withdrawn");
});

for (const route of ["shell", "henry-relay", "architect", "page-words"] as const) {
	test(`MG6 3: an answer by ${route} does not qualify, nothing is sent and the ask is withdrawn`, async (t) => {
		const world = await makeWorld(t);
		const ask = world.raise();
		const words = { words: "yes, send it", relay: { via: "grokbot-gateway" as const, ref: "relay-h", at: RELAY_AT } };
		if (route === "shell") answerAsk(world.stateDir, { ref: ask.id, by: "operator-shell", ruling: "Send" });
		if (route === "henry-relay") answerAsk(world.stateDir, { ref: ask.id, by: "grokbot", ruling: "Send", ...words });
		if (route === "architect") answerAsk(world.stateDir, { ref: ask.id, by: "architect", ruling: "Send", words: "yes", relay: { via: "architect-session", ref: "relay-a", at: RELAY_AT } });
		if (route === "page-words") answerAsk(world.stateDir, { ref: ask.id, by: "operator-page", ruling: "Send", words: "send it", relay: { via: "command-center", ref: "relay-p", at: RELAY_AT } });
		const decided = world.ask(ask.id);
		assert.equal(decided.status, "decided");
		assert.equal(decided.ruling, "Send", "the owner accepted the answer; the gate does not");
		assert.equal(isPageTap(decided), false);

		const run = await world.gate();
		assert.equal(run.sent, 0);
		assert.equal(run.outcomes[0]!.reason, "not-a-page-tap");
		assert.equal(sendCalls(world).length, 0);
		assert.equal(world.fake.writes().length, 0, "no write call of any kind");
		assert.equal(world.ask(ask.id).status, "withdrawn");
		// The draft is not spent: a fresh ask can be raised and tapped.
		const again = raiseDraftAsks({ store: world.store, stateDir: world.stateDir, now: () => NOW });
		assert.equal(again.raised, 1);
	});
}

test("MG6 3: Don't send closes the draft and sends nothing", async (t) => {
	const world = await makeWorld(t);
	const ask = world.raise();
	world.tap(ask, "Don't send");
	const run = await world.gate();
	assert.equal(run.dropped, 1);
	assert.equal(sendCalls(world).length, 0);
	assert.equal(world.ask(ask.id).status, "done");
	assert.equal(draftSendView(readSendLog(world.root), world.draftId).state, "dropped");
	assert.equal(raiseDraftAsks({ store: world.store, stateDir: world.stateDir, now: () => NOW }).raised, 0, "a dropped draft is not asked about again");
});

// ── Acceptance 4: the intent survives, and unknown never resends ──

test("MG6 4: the intent is in send.log before the call, and holds ids and times only", async (t) => {
	const world = await makeWorld(t);
	const ask = world.raise();
	world.tap(ask);
	let intentWhenCalled: string | undefined;
	const watching = {
		...world.adapter,
		health: world.adapter.health,
		readChat: world.adapter.readChat,
		send: async (draft: Parameters<typeof world.adapter.send>[0]) => {
			intentWhenCalled = existsSync(sendLogPath(world.root)) ? readFileSync(sendLogPath(world.root), "utf8") : "";
			return world.adapter.send(draft);
		},
	};
	await world.gate({ adapter: watching });
	assert.match(intentWhenCalled ?? "", /"kind":"intent"/, "the intent was on disk when the adapter was called");
	const log = logText(world);
	for (const secret of [REPLY, INBOUND, NAME]) assert.equal(log.includes(secret), false, "send.log holds no text");
	const intent = readSendLog(world.root).find((event) => event.kind === "intent")!;
	assert.ok(intent.kind === "intent" && intent.attemptId.length > 0 && Date.parse(intent.at) > 0);
});

test("MG6 4: a crash between the intent and the call -> unknown, no second call, one operator-action ask with no name", async (t) => {
	const world = await makeWorld(t);
	const ask = world.raise();
	world.tap(ask);
	// The state a process leaves when it dies right after the fsynced intent: an intent, no outcome, no call.
	appendSendEvent(world.root, { kind: "intent", attemptId: "attempt-lost", draftId: world.draftId }, new Date("2026-10-25T09:08:00.000Z"));
	assert.equal(draftSendView(readSendLog(world.root), world.draftId).state, "sending");

	const first = await world.gate();
	assert.equal(first.unknown, 1);
	assert.equal(sendCalls(world).length, 0, "the gate never resends on its own");
	assert.equal(world.fake.writes().length, 0);
	const asks = readAsks(world.stateDir).asks;
	const unknownAsks = asks.filter((one) => one.kind === "operator-action");
	assert.equal(unknownAsks.length, 1, "one operator-action ask");
	assert.equal(unknownAsks[0]!.question, UNKNOWN_ASK_QUESTION);
	for (const secret of [NAME, REPLY, INBOUND, PEER]) assert.equal(JSON.stringify(unknownAsks[0]).includes(secret), false);
	assert.equal(world.ask(ask.id).status, "withdrawn", "the tapped ask is closed so the gate does not read the chat every run");

	await world.gate();
	await world.gate();
	assert.equal(readAsks(world.stateDir).asks.filter((one) => one.kind === "operator-action").length, 1, "still one");
	assert.equal(sendCalls(world).length, 0);
});

test("MG6 4: a crash inside the adapter call records unknown and the next run does not resend", async (t) => {
	const world = await makeWorld(t);
	const ask = world.raise();
	world.tap(ask);
	const crashing = { ...world.adapter, health: world.adapter.health, readChat: world.adapter.readChat, send: async () => Promise.reject(new Error("process died")) };
	const first = await world.gate({ adapter: crashing });
	assert.equal(first.unknown, 1);
	assert.equal(draftSendView(readSendLog(world.root), world.draftId).state, "unknown");
	const second = await world.gate();
	assert.equal(second.sent, 0);
	assert.equal(sendCalls(world).length, 0, "the real adapter was never asked to send");
	assert.equal(readAsks(world.stateDir).asks.filter((one) => one.kind === "operator-action").length, 1);
});

test("MG6 4: a send whose answer was lost but whose message left is found in the chat, and recorded as found", async (t) => {
	const world = await makeWorld(t);
	const ask = world.raise();
	world.tap(ask);
	world.fake.sendBehavior = "drop-after-send";
	const first = await world.gate();
	assert.equal(first.unknown, 1);
	assert.equal(sendCalls(world).length, 1, "the message left");
	const second = await world.gate();
	assert.equal(second.found, 1, "the next run finds our message with the same text after the intent time");
	assert.equal(sendCalls(world).length, 1, "and does not send it again");
	assert.equal(draftSendView(readSendLog(world.root), world.draftId).state, "found");
	assert.equal(readAsks(world.stateDir).asks.filter((one) => one.kind === "operator-action").length, 0, "nothing to ask the operator");
	assert.equal(world.ask(ask.id).status, "done");
});

test("MG6 4: a send whose connection dropped before anything left is unknown, and one operator-action ask is raised", async (t) => {
	const world = await makeWorld(t);
	const ask = world.raise();
	world.tap(ask);
	world.fake.sendBehavior = "drop-before-send";
	await world.gate();
	await world.gate();
	assert.equal(sendCalls(world).length, 0);
	assert.equal(readAsks(world.stateDir).asks.filter((one) => one.kind === "operator-action").length, 1);
	assert.equal(world.ask(ask.id).status, "withdrawn");
});

test("MG6 4: WAHA refusing sendText with a 4xx is failed: nothing left, the ask is closed, nothing retries by itself", async (t) => {
	const world = await makeWorld(t);
	const ask = world.raise();
	world.tap(ask);
	world.fake.sendBehavior = 422;
	const first = await world.gate();
	assert.equal(first.failed, 1);
	assert.equal(draftSendView(readSendLog(world.root), world.draftId).state, "failed");
	assert.equal(world.ask(ask.id).status, "withdrawn");
	await world.gate();
	assert.equal(sendCalls(world).length, 0, "no second attempt on its own");
	assert.equal(world.fake.writes().filter((call) => call.path === "/api/sendText").length, 1, "WAHA saw exactly one sendText");
});

test("MG6 4: a deleted index between the intent and the retry still gives one send", async (t) => {
	const world = await makeWorld(t);
	const ask = world.raise();
	world.tap(ask);
	await world.gate();
	assert.equal(sendCalls(world).length, 1);
	// The index is lost: R1 yields no rows, and the rebuild replays `raw/` only. The intent was never kept there.
	world.reopen(true);
	world.store.rebuild();
	assert.equal(world.store.drafts.list().length, 0, "the drafts were in the lost index");

	const run = await world.gate();
	assert.equal(run.sent, 0);
	assert.equal(sendCalls(world).length, 1, "one send only");
	assert.equal(draftSendView(readSendLog(world.root), world.draftId).state, "sent", "send.log still says so");
});

test("MG6 4: a deleted index after a lost intent does not allow a send, and the same draft is not asked about again", async (t) => {
	const world = await makeWorld(t);
	const ask = world.raise();
	world.tap(ask);
	appendSendEvent(world.root, { kind: "intent", attemptId: "attempt-lost", draftId: world.draftId }, new Date("2026-10-25T09:08:00.000Z"));
	world.reopen(true);
	world.store.rebuild();

	const run = await world.gate();
	assert.equal(run.sent, 0);
	assert.equal(sendCalls(world).length, 0);

	// The pipeline writes the same draft again (its id is the thread, the basis and the text); it has an intent, so no new ask.
	world.store.triage.record({
		channel: CHANNEL, threadId: world.chatId, state: "triaged", needsReply: "yes", urgency: "today", kind: "personal", basisMessageId: "A-1", basisTimestamp: Date.parse(T0),
		questionSet: "messaging-triage", setVersion: 1, triagedAt: NOW.toISOString(), model: "stub/classifier", stopReason: null, inputTokens: 1, outputTokens: 1, costUsd: 0, stateBytes: 1,
	});
	await runDrafts({ store: world.store, writer: stubWriter(REPLY), model: MODEL, now: () => NOW });
	assert.equal(world.store.drafts.list()[0]!.draftId, world.draftId, "the same draft id comes back");
	const before = readAsks(world.stateDir).asks.length;
	assert.equal(raiseDraftAsks({ store: world.store, stateDir: world.stateDir, now: () => NOW }).raised, 0);
	assert.equal(readAsks(world.stateDir).asks.length, before);
});

test("MG6 4: a send log that cannot be read stops the gate before it looks at an ask", async (t) => {
	const world = await makeWorld(t);
	const ask = world.raise();
	world.tap(ask);
	mkdirSync(world.root, { recursive: true });
	writeFileSync(sendLogPath(world.root), "this is not an event\n");
	const run = await world.gate();
	assert.equal(run.blocked, "send-log-unreadable");
	assert.equal(sendCalls(world).length, 0);
	assert.equal(world.ask(ask.id).status, "decided", "the ask is untouched");
	assert.throws(() => readSendLog(world.root), SendLogError);

	writeFileSync(sendLogPath(world.root), '{"v":1,"id":"x","at":"2026-10-25T09:00:00.000Z","kind":"released');
	assert.equal((await world.gate()).blocked, "send-log-unreadable", "a line cut short by a crash stops it too");
});

// ── Acceptance 5: stale drafts, health, first live ──

test("MG6 5: a newer message in the chat -> the draft is withdrawn and nothing is sent", async (t) => {
	const world = await makeWorld(t);
	const ask = world.raise();
	world.tap(ask);
	world.fake.addMessage(world.chatId, { id: serializedId(world.chatId, "A-2"), timestamp: seconds("2026-10-25T09:07:00.000Z"), from: world.chatId, body: "also, bring the file", type: "chat" });
	const run = await world.gate();
	assert.equal(run.withdrawn, 1);
	assert.equal(run.outcomes[0]!.reason, "arrived-after-draft");
	assert.equal(sendCalls(world).length, 0);
	assert.equal(world.fake.writes().length, 0);
	assert.equal(world.ask(ask.id).status, "withdrawn");
	assert.equal(draftSendView(readSendLog(world.root), world.draftId).state, "withdrawn");
});

test("MG6 5: the operator answering from his phone is a message after the basis and withdraws the draft", async (t) => {
	const world = await makeWorld(t);
	const ask = world.raise();
	world.tap(ask);
	world.fake.addMessage(world.chatId, { id: serializedId(world.chatId, "OWN-1", true), timestamp: seconds("2026-10-25T09:07:00.000Z"), fromMe: true, from: SELF, body: "on my way", type: "chat" });
	const run = await world.gate();
	assert.equal(run.outcomes[0]!.reason, "sent-after-draft");
	assert.equal(sendCalls(world).length, 0);
});

test("MG6 5: an edit or a revoke of the basis message withdraws the draft", async (t) => {
	for (const how of ["edited", "revoked-by-mark", "gone"] as const) {
		const world = await makeWorld(t);
		const ask = world.raise();
		world.tap(ask);
		if (how === "edited") world.fake.editMessage(world.chatId, "A-1", "an edited version of the question");
		if (how === "revoked-by-mark") {
			world.fake.removeMessage(world.chatId, "A-1");
			world.fake.addMessage(world.chatId, { id: serializedId(world.chatId, "A-1"), timestamp: seconds(T0), from: world.chatId, body: INBOUND, type: "chat", edit: "7" });
		}
		if (how === "gone") world.fake.removeMessage(world.chatId, "A-1");
		const run = await world.gate();
		assert.equal(run.withdrawn, 1, how);
		assert.match(run.outcomes[0]!.reason ?? "", /basis/, how);
		assert.equal(sendCalls(world).length, 0, how);
		assert.equal(world.ask(ask.id).status, "withdrawn", how);
	}
});

test("MG6 5: a session that is not WORKING -> no call, and the tap waits for the session", async (t) => {
	const world = await makeWorld(t);
	const ask = world.raise();
	world.tap(ask);
	world.fake.setStatus("SCAN_QR_CODE");
	const run = await world.gate();
	assert.equal(run.sent, 0);
	assert.equal(run.outcomes[0]!.reason, "channel-not-working");
	assert.equal(world.fake.writes().length, 0, "no write call");
	assert.equal(world.ask(ask.id).status, "decided", "the ask waits");
	world.fake.setStatus("WORKING");
	assert.equal((await world.gate()).sent, 1, "the next run with a working session sends");
});

test("MG6 5: the first live send goes to the operator's own chat only, until his page releases it", async (t) => {
	const world = await makeWorld(t);
	const ask = world.raise();
	world.tap(ask);
	const guarded = { config: { firstLiveSelfChatOnly: true } };
	const refused = await world.gate(guarded);
	assert.equal(refused.outcomes[0]!.reason, "first-live-self-chat-only");
	assert.equal(world.fake.writes().length, 0);
	assert.equal(world.ask(ask.id).status, "decided");

	appendSendEvent(world.root, { kind: "release", by: "operator-page" });
	const released = await world.gate(guarded);
	assert.equal(released.sent, 1, "released: the guard no longer applies");
});

test("MG6 5: the guard lets the operator's own chat through", async (t) => {
	const world = await makeWorld(t, { chatId: SELF });
	const ask = world.raise();
	world.tap(ask);
	const run = await world.gate({ config: { firstLiveSelfChatOnly: true } });
	assert.equal(run.sent, 1);
	assert.deepEqual(sendCalls(world), [{ chatId: SELF, text: REPLY }]);
});

// ── @lid and @c.us ──

test("MG6 6: a thread that arrives under @lid and @c.us sends to the id the draft's hash was made from", async (t) => {
	const world = await makeWorld(t, { contactAliases: [LID], arrivesAs: LID });
	assert.equal(world.chatId, PEER, "the canonical thread is the @c.us form once the contact list shows the mapping");
	const draft = world.store.drafts.read(world.draftId)!;
	assert.equal(draft.hash, draftHash(PEER, REPLY), "the hash was made from the canonical id");
	assert.equal(draft.threadFingerprint, threadFingerprint(PEER));
	const ask = world.raise();
	world.tap(ask);
	const run = await world.gate();
	assert.equal(run.sent, 1);
	assert.deepEqual(sendCalls(world), [{ chatId: PEER, text: REPLY }], "the call names the hashed id, not the form the message arrived under");
	assert.equal(sendCalls(world).some((call) => call.chatId === LID), false);
	assert.ok(world.fake.messagesOf(LID).length > 0 && world.fake.messagesOf(PEER).length > 0, "the fresh read covers both id forms of the thread");
});

test("MG6 6: a draft made under @lid before the mapping was known is not sent to the id the mapping later names", async (t) => {
	const world = await makeWorld(t, { arrivesAs: LID, chatId: LID });
	assert.equal(world.chatId, LID);
	const ask = world.raise();
	world.tap(ask);
	// The contact list arrives: the thread's canonical id becomes the @c.us form, so the hash no longer names it.
	world.store.archiveContact({ channel: CHANNEL, contactId: PEER, aliases: [LID], name: NAME, payload: { id: PEER, lid: LID }, recordedAt: "2026-10-25T09:04:00.000Z" });
	const run = await world.gate();
	assert.equal(run.sent, 0);
	assert.equal(sendCalls(world).length, 0);
	assert.equal(run.outcomes[0]!.reason, "thread-id-changed");
	assert.equal(world.ask(ask.id).status, "withdrawn");
});

// ── G12 withdrawal and the asks pass ──

test("MG6 7: the stale pass withdraws an unanswered ask when the chat moves on, and a new draft gets a new ask; nothing expires on a clock", async (t) => {
	const world = await makeWorld(t);
	const raised = raiseDraftAsks({ store: world.store, stateDir: world.stateDir, now: () => NOW });
	assert.equal(raised.raised, 1);
	const ask = world.ask();
	assert.equal(raiseDraftAsks({ store: world.store, stateDir: world.stateDir, now: () => NOW }).raised, 0, "one ask per draft");

	// A month later, nothing moved: the ask stays.
	const later = new Date("2026-11-25T09:00:00.000Z");
	assert.deepEqual(withdrawStaleDrafts({ store: world.store, stateDir: world.stateDir, now: () => later }), { withdrawn: 0, repaired: 0 });
	assert.equal(world.ask(ask.id).status, "awaiting-operator");

	// A new inbound message after the basis.
	world.store.archiveMessage({ channel: CHANNEL, chatId: world.chatId, messageId: "A-2", timestamp: Date.parse("2026-10-25T09:07:00.000Z"), fromMe: false, senderId: world.chatId, type: "chat", text: "one more thing", payload: { id: "A-2", body: "one more thing" }, recordedAt: T0 });
	const pass = withdrawStaleDrafts({ store: world.store, stateDir: world.stateDir, now: () => NOW });
	assert.equal(pass.withdrawn, 1);
	assert.equal(world.ask(ask.id).status, "withdrawn");
	assert.equal(draftSendView(readSendLog(world.root), world.draftId).state, "withdrawn");

	// The chat still needs him: a new draft, then a new ask.
	const run = await runDrafts({ store: world.store, writer: stubWriter("Yes, and a second reply"), model: MODEL, now: () => new Date("2026-10-25T09:08:00.000Z") });
	assert.equal(run.drafted, 1);
	assert.equal(raiseDraftAsks({ store: world.store, stateDir: world.stateDir, now: () => NOW }).raised, 1);
	const live = liveDraftAsk(readAsks(world.stateDir), world.store.drafts.latest(CHANNEL, threadFingerprint(world.chatId))!.draftId);
	assert.ok(live !== undefined && live.id !== ask.id, "the new draft has its own ask");
	assert.equal(live.code, "MSG-2");
});

test("MG6 7: an edit event of the basis in the archive withdraws the draft's ask", async (t) => {
	const world = await makeWorld(t);
	const ask = world.raise();
	world.store.archiveEvent({ channel: CHANNEL, chatId: world.chatId, messageId: "A-1", event: "edited", at: "2026-10-25T09:06:00.000Z", text: "changed", recordedAt: T0 });
	assert.equal(withdrawStaleDrafts({ store: world.store, stateDir: world.stateDir, now: () => NOW }).withdrawn, 1);
	assert.equal(world.ask(ask.id).status, "withdrawn");
});

test("MG6 7: an ack event of a sent message does not withdraw anything", async (t) => {
	const world = await makeWorld(t);
	const ask = world.raise();
	world.store.archiveEvent({ channel: CHANNEL, chatId: world.chatId, messageId: "A-1", event: "ack", at: "2026-10-25T09:06:00.000Z", payload: { ack: "READ" }, recordedAt: T0 });
	assert.equal(withdrawStaleDrafts({ store: world.store, stateDir: world.stateDir, now: () => NOW }).withdrawn, 0);
	assert.equal(world.ask(ask.id).status, "awaiting-operator");
});

// ── Nothing leaves the store ──

test("MG6 8: no chat text, draft text, name or chat id reaches the ask queue", async (t) => {
	const world = await makeWorld(t, { contactAliases: [LID], arrivesAs: LID });
	const ask = world.raise();
	world.tap(ask);
	world.fake.sendBehavior = "drop-before-send";
	await world.gate();
	await world.gate();
	const dir = join(world.stateDir, "asks");
	const files = readdirSync(dir);
	assert.ok(files.length > 0);
	for (const file of files) {
		const text = readFileSync(join(dir, file), "utf8");
		for (const secret of [NAME, INBOUND, REPLY, "KIWI", "PINEAPPLE", "15550002222", "900000000000002"]) {
			assert.equal(text.includes(secret), false, `${file} holds no ${secret}`);
		}
	}
	// Nor does the send log hold text.
	for (const secret of [NAME, INBOUND, REPLY]) assert.equal(logText(world).includes(secret), false);
});

test("MG6 8: the WhatsApp adapter's send: 2xx is sent with the short id, 4xx failed, 5xx and a dropped connection unknown", async (t) => {
	const world = await makeWorld(t);
	const draft = { draftId: world.draftId, chatId: world.chatId, text: REPLY, hash: draftHash(world.chatId, REPLY) };
	const sent = await world.adapter.send(draft);
	assert.equal(sent.state, "sent");
	assert.equal(sent.messageId, "SENT1");
	world.fake.sendBehavior = 400;
	assert.equal((await world.adapter.send(draft)).state, "failed");
	world.fake.sendBehavior = 503;
	assert.equal((await world.adapter.send(draft)).state, "unknown");
	world.fake.sendBehavior = "drop-before-send";
	assert.equal((await world.adapter.send(draft)).state, "unknown");
	const noKey = createWahaAdapter({ config: { url: world.fake.url, apiKey: "wrong-key", session: world.fake.session }, typingDelayMs: () => 0, sleep: async () => {} });
	assert.equal((await noKey.send(draft)).state, "failed", "a 401 sent nothing");
});

// A line is appended by the gate only through `appendSendEvent`: nothing else writes the file.
test("MG6 8: send.log is append-only and 0600 beside raw/", async (t) => {
	const world = await makeWorld(t);
	const first = appendSendEvent(world.root, { kind: "release", by: "operator-page" });
	const second = appendSendEvent(world.root, { kind: "dropped", draftId: "x".repeat(16) });
	assert.equal(second.line, first.line + 1);
	assert.equal(logText(world).split("\n").filter((line) => line !== "").length, 2);
	const mode = statSync(sendLogPath(world.root)).mode & 0o777;
	assert.equal(mode, 0o600);
	assert.ok(existsSync(join(world.root, "raw")), "it sits beside raw/");
});
