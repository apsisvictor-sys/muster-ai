/**
 * WAKE-DELIVERY (2026-10-29): a delivery that reaches a session's inbox becomes a turn,
 * nothing is consumed until that turn is seen, and the budget is judged on the clock the
 * waker promised — delivery to turn, not injection to turn.
 *
 * The failure it answers, observed twice on 2026-10-29: `muster-orch-waker` wrote a wake
 * into the orchestrator seat's inbox at 22:49 and again at 23:05, logged it `delivered`,
 * and the idle session took no turn for more than twenty minutes — delivery is not a wake.
 *
 * Two clocks, kept apart on every line: `deliveryLatencyMs` is measured from the message's
 * own write time (the contract), `injectionLatencyMs` from the poll's injection. A slow poll
 * whose turn still lands inside the minute passes; a fast poll whose turn is late is a miss.
 *
 * The whole path through the real extension lives in Pi's profile
 * (`extensions/tests/wake-delivery.test.ts`), because it imports both sides.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inboxWakeRequest } from "../inbox-wake.ts";
import { listInboxMessages, writeInboxMessage, type InboxMessage } from "../lib/agent-inbox.ts";
import { WAKE_BUDGET_MS, WakeInjector, wakeInjectionText, type WakeInjectionPorts, type WakeInjectionReceipt } from "../wake-injection.ts";

const AGENT = "orchestrator";
/** Tonight's first wake, as the waker stamped it (23:12:55 local). */
const DELIVERED_AT = "2026-10-29T21:12:55.388Z";
const T0 = Date.parse(DELIVERED_AT);

function lab(run: (state: string) => void | Promise<void>): Promise<void> | void {
	const state = mkdtempSync(join(tmpdir(), "muster-wake-injection-"));
	const done = (): void => rmSync(state, { recursive: true, force: true });
	try {
		const result = run(state);
		if (result instanceof Promise) return result.finally(done);
		done();
	} catch (error) {
		done();
		throw error;
	}
}

/** One inbox message as the waker writes it, and the message the owner read back. */
function delivery(state: string, text: string, at = DELIVERED_AT): InboxMessage {
	// The write time is the test's, to the millisecond: the budget is judged on it, so it must not drift
	// between cases. The read-back is by text, so two messages may share a stamp.
	writeInboxMessage(state, { agent: AGENT, from: "muster-orch-waker", at, text, idempotencyKey: `wake:${text}` });
	return listInboxMessages(state, AGENT).find((message) => message.text === text)!;
}

type Rig = {
	injector: WakeInjector;
	sent: Array<{ text: string; options: { deliverAs?: string } | undefined }>;
	records: WakeInjectionReceipt[];
	markedRead: string[];
	clock: { ms: number };
	setIdle: (idle: boolean) => void;
};

function rig(options: { idle?: boolean; now?: number; admit?: () => boolean } = {}): Rig {
	let idle = options.idle ?? true;
	const clock = { ms: options.now ?? T0 };
	const sent: Rig["sent"] = [];
	const records: WakeInjectionReceipt[] = [];
	const markedRead: string[] = [];
	const ports: WakeInjectionPorts = {
		isIdle: () => idle,
		inject: (text, opts) => {
			sent.push({ text, options: opts });
		},
		record: (receipt) => {
			records.push(receipt);
		},
		now: () => clock.ms,
		onInjected: (message) => {
			markedRead.push(message.id);
		},
	};
	if (options.admit !== undefined) ports.admit = options.admit;
	const injector = new WakeInjector(ports);
	return { injector, sent, records, markedRead, clock, setIdle: (value) => { idle = value; } };
}

/** The delivery is queued now and drained on the injector's coalescing microtask. */
const afterDrain = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("a turn at 75 s is a miss on the delivery clock, even when the poll read it late", () =>
	lab(async (state) => {
		// The waker wrote at T0; this poll only read the message 20 s later.
		const r = rig({ idle: true, now: T0 + 20_000 });
		const message = delivery(state, "REVIEW READY: lane/x@abc1234 | slow poll, late turn");
		assert.equal(r.injector.deliver(inboxWakeRequest(state, AGENT, message), message), "queued");
		await afterDrain();
		assert.equal(r.sent.length, 1, "injected by the late poll");
		assert.deepEqual(r.records, [], "no receipt before the turn");
		assert.equal(listInboxMessages(state, AGENT).length, 1, "and nothing consumed");

		// The poll that crosses the minute, measured from the delivery, not from the injection.
		r.clock.ms = T0 + 60_000;
		assert.equal(r.injector.misses(), 1, "60 s after the waker wrote it");
		assert.equal(r.records.length, 1);
		const miss = r.records[0]!;
		assert.equal(miss.outcome, "missed");
		assert.equal(miss.injectedAt, T0 + 20_000, "the injection clock is kept beside it");
		assert.equal(miss.waitedMs, 60_000, "waited, measured from the delivery");
		assert.equal(miss.budgetMs, WAKE_BUDGET_MS);
		assert.equal(r.injector.awaitingCount, 1, "still held for the late turn");
		assert.equal(listInboxMessages(state, AGENT).length, 1, "and still unread");

		// The turn arrives at 75 s: 75 s from the delivery, 55 s from the injection. Both on the line.
		r.clock.ms = T0 + 75_000;
		assert.equal(r.injector.turnStarted(), 1);
		const late = r.records[1]!;
		assert.equal(late.outcome, "started");
		assert.equal(late.deliveryLatencyMs, 75_000, "the latency the waker promised to keep");
		assert.equal(late.injectionLatencyMs, 55_000, "the injection's own wait");
		assert.ok(late.deliveryLatencyMs! > WAKE_BUDGET_MS, "over the budget against the delivery");
		assert.equal(late.missedBeforeTurn, true);
		assert.deepEqual(r.records.map((receipt) => receipt.outcome), ["missed", "started"]);
		assert.deepEqual(r.markedRead, [message.id], "read when the turn arrived");
	}));

test("a slow poll with a fast turn still passes, because the delivery clock is the one that counts", () =>
	lab(async (state) => {
		const r = rig({ idle: true, now: T0 + 40_000 });
		const message = delivery(state, "DISCOVERY READY: plans/x.md | slow poll, fast turn");
		r.injector.deliver(inboxWakeRequest(state, AGENT, message), message);
		await afterDrain();
		assert.equal(r.sent.length, 1);

		r.clock.ms = T0 + 50_000;
		assert.equal(r.injector.misses(), 0, "50 s from the delivery is inside the minute");
		assert.equal(r.injector.turnStarted(), 1);
		const receipt = r.records[0]!;
		assert.equal(receipt.outcome, "started");
		assert.equal(receipt.deliveryLatencyMs, 50_000);
		assert.equal(receipt.injectionLatencyMs, 10_000);
		assert.equal(receipt.missedBeforeTurn, undefined);
		assert.deepEqual(r.markedRead, [message.id]);
	}));

test("a turn at 55 s is inside the waker's minute, and only then is the delivery read", () =>
	lab(async (state) => {
		assert.equal(WAKE_BUDGET_MS, 60_000, "the budget the brief names");
		const r = rig({ idle: true, now: T0 + 5_000 });
		const message = delivery(state, "REVIEW READY: lane/y@def5678 | on time");
		r.injector.deliver(inboxWakeRequest(state, AGENT, message), message);
		await afterDrain();

		assert.equal(r.sent.length, 1, "the idle session took the injection at once");
		assert.match(r.sent[0]!.text, new RegExp(message.id), "the turn names the delivery it carries");
		assert.deepEqual(r.records, [], "the injection alone proves nothing: no receipt before the turn");
		assert.equal(listInboxMessages(state, AGENT).length, 1, "and the delivery is still pending");

		r.clock.ms = T0 + 55_000;
		assert.equal(r.injector.misses(), 0, "55 s from the delivery is still inside the minute");
		assert.equal(r.injector.turnStarted(), 1);
		const receipt = r.records[0]!;
		assert.equal(receipt.outcome, "started");
		assert.equal(receipt.injectedAt, T0 + 5_000);
		assert.equal(receipt.turnStartedAt, T0 + 55_000);
		assert.equal(receipt.deliveryLatencyMs, 55_000);
		assert.equal(receipt.injectionLatencyMs, 50_000);
		assert.equal(receipt.missedBeforeTurn, undefined);
		assert.deepEqual(r.markedRead, [message.id], "read only once the turn was seen");
	}));

test("a delivery whose turn never starts stays unread and keeps its place", () =>
	lab(async (state) => {
		const r = rig({ idle: true, now: T0 });
		const message = delivery(state, "QUESTION: lane/z@5555555 | never acted on");
		r.injector.deliver(inboxWakeRequest(state, AGENT, message), message);
		await afterDrain();
		r.clock.ms = T0 + 60_000;
		assert.equal(r.injector.misses(), 1);
		r.clock.ms = T0 + 600_000;
		assert.equal(r.injector.misses(), 0, "one miss line per injection, however long the seat stays silent");
		assert.equal(r.records.filter((receipt) => receipt.outcome === "missed").length, 1);
		assert.equal(listInboxMessages(state, AGENT).length, 1, "the delivery is still there for the retry");
		assert.deepEqual(r.markedRead, []);
	}));

test("a delivery that arrives mid-turn is injected at the boundary, not into the tool call", () =>
	lab(async (state) => {
		const r = rig({ idle: false, now: T0 });
		const message = delivery(state, "REVIEW READY: lane/b@6666666 | mid-turn");
		assert.equal(r.injector.deliver(inboxWakeRequest(state, AGENT, message), message), "queued");
		await afterDrain();

		assert.equal(r.sent.length, 0, "no injection while the run is active");
		assert.equal(r.injector.pendingCount, 1);

		r.clock.ms = T0 + 5_000;
		assert.equal(r.injector.boundary(), 1, "the settled run is the boundary");
		assert.equal(r.sent.length, 1);
		assert.equal(r.sent[0]!.options?.deliverAs, "followUp");
		assert.deepEqual(r.records, [], "the boundary is not the turn: the next run is");
		assert.equal(listInboxMessages(state, AGENT).length, 1);

		r.clock.ms = T0 + 6_000;
		assert.equal(r.injector.turnStarted(), 1);
		assert.equal(r.records[0]!.appliedAs, "boundary");
		assert.equal(r.records[0]!.deliveryLatencyMs, 6_000);
		assert.equal(r.records[0]!.injectionLatencyMs, 1_000);
		assert.deepEqual(r.markedRead, [message.id]);
		assert.equal(r.injector.pendingCount, 0);
	}));

test("two deliveries that arrive together are one turn, and both are recorded", () =>
	lab(async (state) => {
		const r = rig({ idle: true, now: T0 });
		const first = delivery(state, "REVIEW READY: lane/a@1111111 | one");
		const second = delivery(state, "QUESTION: lane/b@2222222 | two");
		r.injector.deliver(inboxWakeRequest(state, AGENT, first), first);
		r.injector.deliver(inboxWakeRequest(state, AGENT, second), second);
		await afterDrain();

		assert.equal(r.sent.length, 1, "one drain, one turn");
		assert.match(r.sent[0]!.text, new RegExp(first.id));
		assert.match(r.sent[0]!.text, new RegExp(second.id));

		r.clock.ms = T0 + 5_000;
		assert.equal(r.injector.turnStarted(), 2);
		assert.equal(r.records.length, 2);
		assert.deepEqual(r.records.map((receipt) => receipt.batch), [2, 2]);
		assert.equal(r.records[0]!.injectedAt, r.records[1]!.injectedAt, "one turn carried both");
		assert.equal(r.records[0]!.deliveryLatencyMs, r.records[1]!.deliveryLatencyMs);
		assert.deepEqual(r.markedRead, [first.id, second.id]);
		assert.equal(r.injector.pendingCount, 0);
	}));

test("a held delivery is kept, not lost, and goes through when the policy admits it", () =>
	lab(async (state) => {
		let admitted = false;
		const r = rig({ idle: true, now: T0, admit: () => admitted });
		const message = delivery(state, "REVIEW READY: lane/c@3333333 | held");
		r.injector.deliver(inboxWakeRequest(state, AGENT, message), message);
		await afterDrain();
		assert.equal(r.sent.length, 0, "the operator's holds still decide");
		assert.equal(r.injector.pendingCount, 1);

		admitted = true;
		assert.equal(r.injector.boundary(), 1);
		assert.equal(r.sent.length, 1);
		assert.equal(r.injector.turnStarted(), 1);
		assert.deepEqual(r.markedRead, [message.id]);
	}));

test("a delivery whose turn was seen is never injected twice", () =>
	lab(async (state) => {
		const r = rig({ idle: true });
		const message = delivery(state, "STALLED: lane/d@4444444");
		r.injector.deliver(inboxWakeRequest(state, AGENT, message), message);
		await afterDrain();
		r.injector.turnStarted();
		assert.equal(r.sent.length, 1);
		assert.equal(r.injector.deliver(inboxWakeRequest(state, AGENT, message), message), "duplicate");
		await afterDrain();
		assert.equal(r.sent.length, 1, "a re-polled message starts no second turn");
	}));

test("the injected text of a batch names every delivery it carries", () =>
	lab((state) => {
		const first = delivery(state, "first body");
		const second = delivery(state, "second body");
		const text = wakeInjectionText([
			{ request: inboxWakeRequest(state, AGENT, first), message: first },
			{ request: inboxWakeRequest(state, AGENT, second), message: second },
		]);
		assert.match(text, /^Muster wake: 2 deliveries reached this session's inbox together\./);
		assert.ok(text.includes(`--- inbox message ${first.id} from muster-orch-waker at ${first.at} ---`));
		assert.ok(text.includes(first.text) && text.includes(second.text));
	}));
