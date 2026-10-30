import "./muster-test-isolation.ts";
/**
 * LC7 (plan §4, §2.1): the inbox owner, in files mode and on the ledger.
 *
 * The claims proven here, one deliberate test each:
 * 1. Write two, list two in order, mark one, list one, and the delivered history
 *    shows one — the same claims in files mode and in ledger mode, because the
 *    owner is the only reader and writer of a message.
 * 2. An exact repeat of a write (same sender, retry key and text, different minted
 *    ids) is stored once and both calls answer with the first id, while distinct
 *    mail under one reused key stays distinct — the janitor's `janitor-<date>`.
 * 3. `findInboxMessage` and `listDeliveredMessages` answer the same over both
 *    backends for the same input, including the newest-`limit` slice.
 * 4. `drain` delivers everything waiting in one commit and empties the index.
 *
 * Everything runs in a temp state directory with its own temp ledger directory
 * (`MUSTER_LEDGER_DIR`), so nothing here reads or writes live `state/muster/` and
 * no case writes a live `backend.json`.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
	countInboxMessages,
	findInboxMessage,
	listDeliveredMessages,
	listInboxAgents,
	listInboxMessages,
	markInboxMessageRead,
	writeInboxMessage,
} from "../lib/agent-inbox.ts";
import { backendPath } from "../ledger/backend.ts";
import { requestSync } from "../ledger/client-sync.ts";
import type { MessageDoc } from "../ledger/schema.ts";
import { ownerLedgerSocket } from "../ledger/stores.ts";
import { harnessRoot, nodeBinary, tsxLoaderPath } from "../../core/harness-paths.ts";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
const NODE = nodeBinary();
const DAEMON = join(HARNESS_ROOT, "muster", "ledger", "daemon.ts");

const AT_ONE = "2026-10-17T00:01:00.000Z";
const AT_TWO = "2026-10-17T00:02:00.000Z";
const AT_THREE = "2026-10-17T00:03:00.000Z";
/** The switch file as the flip tool writes it (LC15). */
const LEDGER_SWITCH = { backend: "ledger", flipId: "lc7-test", at: "2026-10-17T00:00:00+03:00", cursor: "1" };

type Box = { root: string; stateDir: string; ledgerDir: string; close: () => void };

/** One disposable install: a Muster state dir and the ledger dir `musterd` serves from. */
function box(): Box {
	const root = mkdtempSync(join(tmpdir(), "muster-lc7-"));
	const stateDir = join(root, "state", "muster");
	const ledgerDir = join(root, "ledger");
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(ledgerDir, { recursive: true });
	return { root, stateDir, ledgerDir, close: () => rmSync(root, { recursive: true, force: true }) };
}

/** Point the owner at the ledger: the switch file, the ledger directory and the state dir it reads. */
function useLedger(b: Box): () => void {
	writeFileSync(backendPath(b.stateDir), JSON.stringify(LEDGER_SWITCH));
	const savedLedger = process.env["MUSTER_LEDGER_DIR"];
	const savedState = process.env["PI_MUSTER_STATE_DIR"];
	process.env["MUSTER_LEDGER_DIR"] = b.ledgerDir;
	process.env["PI_MUSTER_STATE_DIR"] = b.stateDir;
	return () => {
		if (savedLedger === undefined) delete process.env["MUSTER_LEDGER_DIR"];
		else process.env["MUSTER_LEDGER_DIR"] = savedLedger;
		if (savedState === undefined) delete process.env["PI_MUSTER_STATE_DIR"];
		else process.env["PI_MUSTER_STATE_DIR"] = savedState;
	};
}

/** The loader this process runs under, so a child fixture loads a `.ts` module the same way. */
function loaderArgs(): string[] {
	const args: string[] = [];
	for (let at = 0; at < process.execArgv.length; at++) {
		if (process.execArgv[at] === "--import" && process.execArgv[at + 1] !== undefined) args.push("--import", process.execArgv[at + 1] as string);
	}
	return args.length > 0 ? args : ["--import", tsxLoaderPath()];
}

/** The real `startDaemon` in its own process: `requestSync` blocks the calling thread in `Atomics.wait`. */
function startDaemon(t: TestContext, dir: string): Promise<void> {
	const file = join(dir, "fixture-daemon.mjs");
	writeFileSync(
		file,
		[`import { startDaemon } from ${JSON.stringify(DAEMON)};`, "await startDaemon(process.env.MUSTER_FIXTURE_DIR);", 'process.stdout.write("READY\\n");'].join("\n"),
	);
	const child: ChildProcess = spawn(NODE, [...loaderArgs(), file], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, MUSTER_FIXTURE_DIR: dir },
	});
	let output = "";
	const collect = (chunk: Buffer): void => void (output += chunk.toString());
	child.stdout?.on("data", collect);
	child.stderr?.on("data", collect);
	t.after(async () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
		child.kill("SIGKILL");
		await exited;
	});
	return (async () => {
		const deadline = Date.now() + 15_000;
		while (!output.includes("READY")) {
			if (child.exitCode !== null || child.signalCode !== null) throw new Error(`the daemon fixture exited before READY: ${output}`);
			if (Date.now() > deadline) throw new Error(`the daemon fixture did not answer within 15 s: ${output}`);
			await delay(25);
		}
	})();
}

/** One write, everything the owner needs and no id of the caller's. */
function message(over: Partial<Parameters<typeof writeInboxMessage>[1]> = {}): Parameters<typeof writeInboxMessage>[1] {
	return { agent: "orchestrator", from: "pi-lane", at: AT_ONE, text: "first", idempotencyKey: "k1", ...over };
}

/**
 * Claim 1, in one backend: the owner answers the same questions over files and over
 * the ledger, so this runs unchanged in both.
 */
function writeListMarkList(stateDir: string): void {
	writeInboxMessage(stateDir, message({ text: "first", at: AT_ONE, idempotencyKey: "k1" }));
	writeInboxMessage(stateDir, message({ text: "second", at: AT_TWO, idempotencyKey: "k2" }));

	const listed = listInboxMessages(stateDir, "orchestrator");
	assert.deepEqual(listed.map((entry) => entry.text), ["first", "second"], "listed in arrival order");
	assert.equal(countInboxMessages(stateDir, "orchestrator"), 2);
	assert.deepEqual(listDeliveredMessages(stateDir, "orchestrator", 10), [], "nothing is delivered before it is marked");
	assert.equal(findInboxMessage(stateDir, "orchestrator", listed[0]!.id)?.text, "first");

	assert.equal(markInboxMessageRead(stateDir, "orchestrator", listed[0]!.id), true);
	assert.deepEqual(listInboxMessages(stateDir, "orchestrator").map((entry) => entry.text), ["second"], "one pending message left");
	assert.equal(countInboxMessages(stateDir, "orchestrator"), 1);
	assert.deepEqual(listDeliveredMessages(stateDir, "orchestrator", 10).map((entry) => entry.text), ["first"], "the delivered history shows the one moved");
	assert.equal(findInboxMessage(stateDir, "orchestrator", listed[0]!.id)?.text, "first", "a delivered message is still found by id");
	assert.equal(findInboxMessage(stateDir, "someone-else", listed[0]!.id), undefined, "another address's message is not this address's");
	assert.equal(findInboxMessage(stateDir, "orchestrator", ""), undefined, "an empty id names no message");
	assert.deepEqual(listInboxAgents(stateDir), ["orchestrator"]);
}

// ─── 1. Write two, list two, mark one, list one, in each backend ────────────

test("LC7: files mode writes, lists, marks and shows the delivered history", (t) => {
	const b = box();
	t.after(b.close);
	writeListMarkList(b.stateDir);
	assert.equal(existsSync(join(b.stateDir, "inbox", "orchestrator", "read")), true, "files mode still moves the message into read/");
});

test("LC7: ledger mode writes, lists, marks and shows the delivered history", async (t) => {
	const b = box();
	t.after(b.close);
	await startDaemon(t, b.ledgerDir);
	const restore = useLedger(b);
	t.after(restore);

	writeListMarkList(b.stateDir);
	assert.equal(existsSync(join(b.stateDir, "inbox")), false, "ledger mode writes no inbox file");
});

// ─── 2. The retry rule (G4) ─────────────────────────────────────────────────

test("LC7: an exact repeat is stored once and answers with the first id, while distinct mail under one key stays distinct", async (t) => {
	const b = box();
	t.after(b.close);
	await startDaemon(t, b.ledgerDir);
	const restore = useLedger(b);
	t.after(restore);

	// The janitor's case: one sender, one key for the day, one summary each.
	const janitor = { from: "muster-janitor", idempotencyKey: "janitor-2026-10-17" };
	const first = writeInboxMessage(b.stateDir, message({ ...janitor, text: "the day's summary", at: AT_ONE }));
	const repeat = writeInboxMessage(b.stateDir, message({ ...janitor, text: "the day's summary", at: AT_ONE }));
	const second = writeInboxMessage(b.stateDir, message({ ...janitor, text: "a second summary", at: AT_TWO }));

	assert.equal(repeat, first, "the repeated write answers with the first message's id");
	assert.notEqual(second, first, "different text under one key is a different message");
	assert.deepEqual(
		listInboxMessages(b.stateDir, "orchestrator").map((entry) => entry.text),
		["the day's summary", "a second summary"],
	);
	const stored = requestSync<MessageDoc[]>(ownerLedgerSocket(b.stateDir), "messages", { address: "orchestrator", state: "accepted" });
	assert.equal(stored.length, 2, "the repeat wrote no third message");
	assert.deepEqual(
		requestSync<{ address: string; pending: string[] }[]>(ownerLedgerSocket(b.stateDir), "inboxes", { address: "orchestrator" }),
		[{ address: "orchestrator", pending: [first, second] }],
		"the index holds each id once, in arrival order",
	);
	assert.deepEqual(
		requestSync<{ type: string; text: string }[]>(ownerLedgerSocket(b.stateDir), "events", {}).map((event) => [event.type, event.text]),
		[
			["SENT", "the day's summary"],
			["SENT", "a second summary"],
		],
		"one SENT entry per stored message, none for the repeat",
	);
});

// ─── 3. The two readers agree across backends ───────────────────────────────

test("LC7: findInboxMessage and listDeliveredMessages agree across backends", async (t) => {
	const files = box();
	t.after(files.close);
	const ledger = box();
	t.after(ledger.close);
	await startDaemon(t, ledger.ledgerDir);
	const restore = useLedger(ledger);
	t.after(restore);

	/** The same script over one backend: two messages for one address, three for another, all of the second address's read. */
	const script = (stateDir: string): Record<string, unknown> => {
		writeInboxMessage(stateDir, message({ text: "one", at: AT_ONE, idempotencyKey: "k1" }));
		writeInboxMessage(stateDir, message({ text: "two", at: AT_TWO, idempotencyKey: "k2" }));
		for (const [text, at, key] of [
			["a", AT_ONE, "m1"],
			["b", AT_TWO, "m2"],
			["c", AT_THREE, "m3"],
		] as const) {
			writeInboxMessage(stateDir, message({ agent: "cc-mods", text, at, idempotencyKey: key }));
		}
		const first = listInboxMessages(stateDir, "orchestrator")[0]!;
		assert.equal(markInboxMessageRead(stateDir, "orchestrator", first.id), true);
		for (const entry of listInboxMessages(stateDir, "cc-mods")) assert.equal(markInboxMessageRead(stateDir, "cc-mods", entry.id), true);
		return {
			pending: listInboxMessages(stateDir, "orchestrator").map((entry) => entry.text),
			delivered: listDeliveredMessages(stateDir, "orchestrator", 10).map((entry) => entry.text),
			limited: listDeliveredMessages(stateDir, "cc-mods", 2).map((entry) => entry.text),
			foundPending: findInboxMessage(stateDir, "orchestrator", first.id)?.text,
			foundElsewhere: findInboxMessage(stateDir, "cc-mods", first.id),
			agents: listInboxAgents(stateDir),
		};
	};

	const overLedger = script(ledger.stateDir);
	const overFiles = script(files.stateDir);
	assert.deepEqual(overLedger, overFiles);
	assert.deepEqual(overFiles["delivered"], ["one"], "the delivered history of the address whose message was moved");
	assert.deepEqual(overFiles["limited"], ["b", "c"], "the limit keeps the newest, as the file reader's slice does");
	assert.deepEqual(overFiles["agents"], ["orchestrator"], "only an address with mail still waiting is listed; cc-mods has none left");
});

// ─── 4. Drain: everything waiting, one commit ───────────────────────────────

test("LC7: drain delivers every waiting message in one commit and empties the index", async (t) => {
	const b = box();
	t.after(b.close);
	await startDaemon(t, b.ledgerDir);
	const restore = useLedger(b);
	t.after(restore);

	writeInboxMessage(b.stateDir, message({ text: "first", at: AT_ONE, idempotencyKey: "k1" }));
	writeInboxMessage(b.stateDir, message({ text: "second", at: AT_TWO, idempotencyKey: "k2" }));

	const drained = requestSync<{ messages: { text: string }[] }>(ownerLedgerSocket(b.stateDir), "drain", { address: "orchestrator" });
	assert.deepEqual(drained.messages.map((entry) => entry.text), ["first", "second"], "oldest first");
	assert.deepEqual(listInboxMessages(b.stateDir, "orchestrator"), [], "the index is empty after the drain");
	assert.deepEqual(listDeliveredMessages(b.stateDir, "orchestrator", 10).map((entry) => entry.text), ["first", "second"]);
	assert.deepEqual(requestSync<{ messages: unknown[] }>(ownerLedgerSocket(b.stateDir), "drain", { address: "orchestrator" }), { messages: [] }, "a second drain has nothing to deliver");
});
