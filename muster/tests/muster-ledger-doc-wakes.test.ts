import "./muster-test-isolation.ts";
/**
 * CRP (blueprint R7 D30 first part, plan correction C5): document wakes in musterd.
 *
 * 1. A subscriber with `docs: ["muster.cas"]` gets one `{sub, doc}` frame per CAS
 *    write, with the store and id in the key; `docs: ["muster.ask"]` gets one per
 *    ask append. Neither carries a value.
 * 2. A subscriber with `docs` and no `types` gets no event frame.
 * 3. A subscriber with only `types` (the orchestrator waiter's filter) gets exactly
 *    the frames it got before, checked against a recorded fixture of mixed commits.
 * 4. The client passes a `{sub, doc}` frame to `onDoc` and drops it without one;
 *    after a daemon restart it resubscribes with `docs`, and every subscriber still
 *    gets exactly one RECONNECT `onEvent` wake.
 * 5. Whole path on a lab ledger: `muster wait --events` and `muster wait --inbox`
 *    wake as before, and a goal write wakes a docs subscriber.
 *
 * Everything runs on a temp ledger directory (`MUSTER_LEDGER_DIR`); nothing here
 * reads or writes live `state/muster/` or touches the live `musterd`.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ASK_KINDS, type AskEvent } from "../asks.ts";
import { appendOrchestratorEvent, EVENT_KINDS } from "../lane-report.ts";
import { listInboxMessages, writeInboxMessage } from "../lib/agent-inbox.ts";
import { ledgerCommit } from "../ledger/cas-store.ts";
import { createClient } from "../ledger/client.ts";
import { framesFor, type LedgerSubscriber } from "../ledger/daemon.ts";
import { GOAL_STORE, ownerLedgerSocket } from "../ledger/stores.ts";
import { ledgerBox, startDaemon as startLabDaemon, useLedger, type LedgerBox } from "./ledger-fixture.ts";
import { harnessRoot } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
const MUSTER = join(piAgentDir(), "extensions", "muster", "launchers", "muster");

/** The recorded fixture: four real publications, `seq` 5 holding an event and two document changes. */
function recordedPublications(): unknown[] {
	const raw = readFileSync(join(TESTS_DIR, "fixtures", "ledger-mixed-commit.json"), "utf8");
	const parsed = JSON.parse(raw) as { note: string; publications: unknown[] };
	assert.ok(parsed.publications.length >= 4, "the fixture holds the recorded commits");
	return parsed.publications;
}

/** One ask event, in the owner's shape, so the recorded/asked document is real. */
function raisedAsk(): AskEvent {
	return { v: 1, at: new Date().toISOString(), id: "ask-crp-1-e1", type: "raised", by: "architect", kind: ASK_KINDS[0]!, question: "which door" };
}

/** A raw connection with a line reader, for the wire-level tests. */
function rawConnect(socketPath: string) {
	const socket = net.connect(socketPath);
	const lines: string[] = [];
	const waiters: ((line: string | undefined) => void)[] = [];
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		let newline: number;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			const waiter = waiters.shift();
			if (waiter === undefined) lines.push(line);
			else waiter(line);
		}
	});
	return {
		write: (text: string) => socket.write(text),
		/** The next frame, or undefined when none arrives inside `ms`. */
		nextLine: (ms = 4000): Promise<string | undefined> =>
			new Promise<string | undefined>((resolveNext) => {
				const line = lines.shift();
				if (line !== undefined) {
					resolveNext(line);
					return;
				}
				const timer = setTimeout(() => {
					const at = waiters.indexOf(settle);
					if (at >= 0) waiters.splice(at, 1);
					resolveNext(undefined);
				}, ms);
				const settle = (value: string | undefined): void => {
					clearTimeout(timer);
					resolveNext(value);
				};
				waiters.push(settle);
			}),
		subscribe: (id: string, params: object) => socket.write(`${JSON.stringify({ id, method: "subscribe", params })}\n`),
		end: () => socket.end(),
	};
}

/** Poll until the predicate holds, so a slow path is a failure with a reason and not a flake. */
async function until(predicate: () => boolean, ms: number, label: string, detail?: () => string): Promise<void> {
	const deadline = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${label}${detail === undefined ? "" : `\n${detail()}`}`);
		await delay(10);
	}
}

function musterEnv(box: LedgerBox, over: Record<string, string> = {}): Record<string, string> {
	return { ...process.env, PI_MUSTER_STATE_DIR: box.stateDir, MUSTER_LEDGER_DIR: box.ledgerDir, ...over } as Record<string, string>;
}

type Running = { output: () => string; stop: () => Promise<void> };

/** One long-running child with its output collected; the caller stops it. */
function run(command: string, args: string[], env: Record<string, string>): Running {
	const child: ChildProcess = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env });
	let output = "";
	const collect = (chunk: Buffer): void => void (output += chunk.toString());
	child.stdout?.on("data", collect);
	child.stderr?.on("data", collect);
	return {
		output: () => output,
		stop: async () => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
			child.kill("SIGKILL");
			await exited;
		},
	};
}

function count(where: string, needle: string): number {
	return where.split(needle).length - 1;
}

test("CRP 1: a docs subscriber gets one {sub, doc} frame per matching write, and no value", async (t) => {
	const box = ledgerBox();
	t.after(box.close);
	await startLabDaemon(t, box.ledgerDir);
	const socketPath = join(box.ledgerDir, "ledger.sock");
	const casSub = rawConnect(socketPath);
	const askSub = rawConnect(socketPath);
	t.after(() => {
		casSub.end();
		askSub.end();
	});
	casSub.subscribe("cas-only", { docs: ["muster.cas"] });
	assert.equal(JSON.parse((await casSub.nextLine())!).ok, true, "the subscribe reply is unchanged");
	askSub.subscribe("ask-only", { docs: ["muster.ask"] });
	assert.equal(JSON.parse((await askSub.nextLine())!).ok, true);

	const c = createClient(socketPath);
	t.after(() => c.close());
	await c.request("casUpdate", { store: "lane-card", id: "pi-lane-crp", expectedRevision: undefined, record: { laneId: "pi-lane-crp" } });
	const casFrame = JSON.parse((await casSub.nextLine())!) as { sub: string; doc: { kind: string; key: string }; event?: unknown };
	assert.deepEqual(casFrame, { sub: "cas-only", doc: { kind: "muster.cas", key: "lane-card:pi-lane-crp" } });
	assert.equal("value" in casFrame.doc, false, "a frame is a wake, never the record");
	assert.equal(await askSub.nextLine(500), undefined, "a cas write does not reach an ask subscriber");

	await c.request("askAppend", { askId: "ask-crp-1", event: raisedAsk(), requestId: "crp-ask-1" });
	const askFrame = JSON.parse((await askSub.nextLine())!) as { sub: string; doc: { kind: string; key: string } };
	assert.deepEqual(askFrame, { sub: "ask-only", doc: { kind: "muster.ask", key: "ask-crp-1" } });
	assert.equal(await casSub.nextLine(500), undefined, "an ask append does not reach a cas subscriber");

	casSub.end();
	askSub.end();
	c.close();
});

test("CRP 2: a subscriber with docs and no types gets no event frame", async (t) => {
	const box = ledgerBox();
	t.after(box.close);
	await startLabDaemon(t, box.ledgerDir);
	const raw = rawConnect(join(box.ledgerDir, "ledger.sock"));
	t.after(() => raw.end());
	raw.subscribe("docs-only", { docs: ["muster.cas"] });
	assert.equal(JSON.parse((await raw.nextLine())!).ok, true);

	const c = createClient(join(box.ledgerDir, "ledger.sock"));
	t.after(() => c.close());
	await c.request("appendEvent", { type: "WORKING", text: "not for a docs subscriber", requestId: "crp-2-event" });
	assert.equal(await raw.nextLine(500), undefined, "no event frame reached it");

	// The same connection still gets its own kind, so the silence above is the filter and not a dead socket.
	await c.request("casUpdate", { store: "lane-card", id: "pi-lane-crp", expectedRevision: undefined, record: { laneId: "pi-lane-crp" } });
	assert.deepEqual(JSON.parse((await raw.nextLine())!), { sub: "docs-only", doc: { kind: "muster.cas", key: "lane-card:pi-lane-crp" } });

	raw.end();
	c.close();
});

test("CRP 3: a types-only subscriber gets exactly the frames the recorded commits gave it before", () => {
	const publications = recordedPublications();
	const seen = (subscriber: LedgerSubscriber): string[] =>
		publications.flatMap((publication) =>
			framesFor(publication as never, subscriber).map((frame) =>
				frame.event === undefined ? `doc:${frame.doc?.kind}:${frame.doc?.key}` : `${frame.event.type}#${frame.event.id}`,
			),
		);

	// The waiter's filter, the empty filter and a lane filter: the two events, no documents.
	assert.deepEqual(seen({ id: "waiter", types: [...EVENT_KINDS] }), ["STALLED#8", "REVIEW READY#14"]);
	assert.deepEqual(seen({ id: "all" }), ["STALLED#8", "REVIEW READY#14"], "today's every-event default is unchanged");
	assert.deepEqual(seen({ id: "lanes", types: [...EVENT_KINDS], lanes: ["pi-lane-crp"] }), ["STALLED#8", "REVIEW READY#14"]);
	assert.deepEqual(seen({ id: "other-lane", types: [...EVENT_KINDS], lanes: ["someone-else"] }), [], "the lane filter still refuses another lane");

	// The new filters: documents only, then the hub's shape, documents beside events.
	assert.deepEqual(seen({ id: "docs", docs: ["muster.cas", "muster.ask"] }), [
		"doc:muster.cas:lane-card:pi-lane-crp",
		"doc:muster.ask:ask-crp-fixture",
		"doc:muster.cas:goal:CC",
	]);
	assert.deepEqual(seen({ id: "cas-only", docs: ["muster.cas"] }), ["doc:muster.cas:lane-card:pi-lane-crp", "doc:muster.cas:goal:CC"]);
	assert.deepEqual(seen({ id: "hub", types: [...EVENT_KINDS], docs: ["muster.cas", "muster.ask"] }), [
		"STALLED#8",
		"doc:muster.cas:lane-card:pi-lane-crp",
		"doc:muster.ask:ask-crp-fixture",
		"REVIEW READY#14",
		"doc:muster.cas:goal:CC",
	]);
});

test("CRP 4: the client hands a doc frame to onDoc, drops it without one, and resubscribes with docs", async (t) => {
	const box = ledgerBox();
	t.after(box.close);
	const socketPath = join(box.ledgerDir, "ledger.sock");
	let d = await startLabDaemon(t, box.ledgerDir);
	let writer: ReturnType<typeof createClient> | undefined;
	t.after(() => writer?.close());
	const c = createClient(socketPath);
	t.after(() => c.close());
	const docs: string[] = [];
	const events: string[] = [];
	c.subscribe({ types: ["WORKING"], docs: ["muster.cas"] }, (event) => events.push(event.type), (doc) => docs.push(`${doc.kind}:${doc.key}`));
	// The same filter without `onDoc`: the frame is dropped, and its `onEvent` is never called for a document.
	const dropped: string[] = [];
	const plainEvents: string[] = [];
	c.subscribe({ types: ["WORKING"], docs: ["muster.cas"] }, (event) => plainEvents.push(event.type));
	c.subscribe({ types: ["WORKING"] }, (event) => dropped.push(event.type));

	assert.equal(
		(await c.request<{ ok: boolean }>("casUpdate", { store: "lane-card", id: "pi-lane-crp", expectedRevision: undefined, record: { laneId: "pi-lane-crp" } })).ok,
		true,
	);
	await until(() => docs.length > 0, 4000, "the docs subscription's onDoc");
	assert.deepEqual(docs, ["muster.cas:lane-card:pi-lane-crp"]);
	assert.equal(events.length, 0, "a document change is not an event");
	assert.equal(plainEvents.length, 0, "the subscription stays subscribed, and a document is not its event");
	assert.equal(dropped.length, 0, "a subscription without docs is not woken by a document");

	// A restart: the resubscribe sends entry.filter, so docs survives, and one RECONNECT per subscriber stays.
	await d.stop();
	d = await startLabDaemon(t, box.ledgerDir);
	await until(() => events.includes("RECONNECT"), 10_000, "the reconnect wake");
	writer = createClient(socketPath);
	await writer.request("casUpdate", { store: "lane-card", id: "pi-lane-crp-after", expectedRevision: undefined, record: { laneId: "pi-lane-crp" } });
	await until(() => docs.includes("muster.cas:lane-card:pi-lane-crp-after"), 6000, "a doc frame after the restart");
	assert.equal(count(events.join(" "), "RECONNECT"), 1, "exactly one reconnect wake");
	writer.close();
	c.close();
});

test("CRP 5: on a lab ledger the waiter and the inbox receiver wake as before, and a goal write wakes a docs subscriber", async (t) => {
	const box = ledgerBox();
	t.after(box.close);
	useLedger(box);
	await startLabDaemon(t, box.ledgerDir);

	// The orchestrator's events waiter, on this branch's daemon.
	const cursorFile = join(box.root, "cursor");
	const waiter = run(MUSTER, ["wait", "--events", "--cursor-file", cursorFile, "--timeout", "40"], musterEnv(box));
	t.after(() => waiter.stop());
	await until(() => existsSync(cursorFile), 15_000, "the events waiter to arm", () => `the waiter said: ${waiter.output()}`);

	// An inbox receiver, the same shape the inbox uses: types ["SENT"] and one lane.
	const inbox = run(MUSTER, ["wait", "--inbox", "pi-lane", "--timeout", "40"], musterEnv(box, { PI_MUSTER_WAIT_POLL_MS: "500" }));
	t.after(() => inbox.stop());
	await until(() => existsSync(join(box.stateDir, "waiters", "pi-lane.pid")), 15_000, "the inbox waiter to arm", () => `the waiter said: ${inbox.output()}`);

	// A docs subscriber in this process, reading the same lab ledger through the branch's client.
	const docs: string[] = [];
	const events: string[] = [];
	const hub = createClient(ownerLedgerSocket(box.stateDir));
	t.after(() => hub.close());
	hub.subscribe({ types: ["WORKING"], docs: ["muster.cas", "muster.ask"] }, (event) => events.push(event.type), (doc) => docs.push(`${doc.kind}:${doc.key}`));
	await delay(300);

	assert.equal(
		ledgerCommit(ownerLedgerSocket(box.stateDir), {
			requestId: "crp-5-goal",
			cas: [{ store: GOAL_STORE, id: "CC", expectedRevision: undefined, record: { code: "CC", name: "Command center" } }],
		}).ok,
		true,
	);
	await until(() => docs.includes(`muster.cas:${GOAL_STORE}:CC`), 6000, "the goal write to wake the docs subscriber", () => `docs so far ${JSON.stringify(docs)}, events ${JSON.stringify(events)}, waiter ${JSON.stringify(waiter.output())}`);

	// The orchestrator's waiter: an event filed on the lab ledger wakes it inside 1 s and prints the line once.
	const at = Date.now();
	assert.equal(appendOrchestratorEvent(box.stateDir, "REVIEW READY: pi-lane-crp lane/crp@abc1234 | crp whole path"), true);
	await until(() => waiter.output().includes("REVIEW READY: pi-lane-crp"), 5000, "the waiter to print the event");
	assert.ok(Date.now() - at <= 1_000, `woken within 1 s (took ${Date.now() - at} ms)`);
	assert.equal(count(waiter.output(), "REVIEW READY: pi-lane-crp"), 1, "printed once, so no doc frame reached it");
	assert.deepEqual(events, [], "the goal write is not an event");

	// The inbox receiver: one message, printed and then delivered.
	writeInboxMessage(box.stateDir, {
		agent: "pi-lane",
		from: "orchestrator",
		at: new Date().toISOString(),
		text: "the lab message",
		idempotencyKey: "crp-5-m1",
	});
	await until(() => inbox.output().includes("the lab message"), 10_000, "the inbox waiter to print the message");
	assert.deepEqual(listInboxMessages(box.stateDir, "pi-lane"), [], "delivered once");
});
