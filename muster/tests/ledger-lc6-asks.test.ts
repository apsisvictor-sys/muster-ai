import "./muster-test-isolation.ts";
/**
 * LC6 (§4, LD37): the operator's asks queue on the ledger.
 *
 * The claims proven here, one deliberate test each:
 * 1. Raise, prepare, answer, done, withdraw and note all write and fold through
 *    the owner in ledger mode, and `muster ask` raises one too (LC0-R7). The
 *    `asks/events.jsonl` file is never written in ledger mode.
 * 2. The queue and `renderOperatorList` output are equal over both backends for the
 *    same events: the ledger stores each ask's events, and the fold is the file's.
 * 3. A raise posts no `muster.event` (LD37), so it never wakes the waiter.
 *
 * Everything runs in a temp state directory with its own temp ledger directory
 * (`MUSTER_LEDGER_DIR`), so nothing here reads or writes live `state/muster/`
 * and no case writes a live `backend.json`.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { backendPath } from "../ledger/backend.ts";
import { requestSync } from "../ledger/client-sync.ts";
import { ownerLedgerSocket } from "../ledger/stores.ts";
import {
	answerAsk,
	appendAskEvent,
	asksEventsPath,
	finishAsk,
	noteAsk,
	prepareAsk,
	raiseAsk,
	readAsks,
	regenerateOperatorList,
	renderOperatorList,
	withdrawAsk,
	type AskEvent,
} from "../asks.ts";
import { command as askCommand } from "../cli/ask.ts";
import type { CliContext } from "../cli/types.ts";
import { harnessRoot, nodeBinary, tsxLoaderPath } from "../../core/harness-paths.ts";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
const NODE = nodeBinary();
const DAEMON = join(HARNESS_ROOT, "muster", "ledger", "daemon.ts");

const NOW = Date.parse("2026-10-17T01:00:00.000Z");
/** The switch file as the flip tool writes it (LC15). */
const LEDGER_SWITCH = { backend: "ledger", flipId: "lc6-test", at: "2026-10-17T00:00:00+03:00", cursor: "1" };
const ASK_ONE = "ask_11111111-1111-4111-8111-111111111111";
const ASK_TWO = "ask_22222222-2222-4222-8222-222222222222";

type Box = { root: string; stateDir: string; ledgerDir: string; close: () => void };

/** One disposable install: a Muster state dir and the ledger dir `musterd` serves from. */
function box(): Box {
	const root = mkdtempSync(join(tmpdir(), "muster-lc6-"));
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

/** the operator's own shell for the CLI: no agent-session marker, only the store's own directories. */
function shellEnv(): NodeJS.ProcessEnv {
	return {
		PI_MUSTER_STATE_DIR: process.env["PI_MUSTER_STATE_DIR"],
		PI_MUSTER_DECISIONS_DIR: process.env["PI_MUSTER_DECISIONS_DIR"],
	};
}

function cli(argv: string[]): { ctx: CliContext; err: string[] } {
	const err: string[] = [];
	return {
		err,
		ctx: {
			argv,
			repoRoot: "/tmp/no-repo",
			agentId: undefined,
			json: false,
			cwd: "/tmp/no-repo",
			env: shellEnv(),
			io: { out: () => {}, err: (line) => err.push(line) },
			readStdin: async () => "",
		},
	};
}

/** One fixed event list covering every type, with explicit asks, moments and writers. */
function events(): AskEvent[] {
	return [
		{
			v: 1,
			at: "2026-10-17T00:01:00.000Z",
			id: ASK_ONE,
			type: "raised",
			by: "orchestrator",
			code: "LC6-1",
			kind: "operator-action",
			question: "Field-test the LC6 queue?",
			owner: "architect",
			source: "lane/lc6",
			blocks: ["lc6"],
		},
		{ v: 1, at: "2026-10-17T00:02:00.000Z", id: ASK_ONE, type: "prepared", by: "orchestrator", options: ["approve", "hold"], recommendation: "approve" },
		{ v: 1, at: "2026-10-17T00:03:00.000Z", id: ASK_ONE, type: "noted", by: "orchestrator", text: "the LC6 plan names it" },
		{ v: 1, at: "2026-10-17T00:04:00.000Z", id: ASK_ONE, type: "answered", by: "operator-shell", ruling: "approve" },
		{ v: 1, at: "2026-10-17T00:05:00.000Z", id: ASK_ONE, type: "done", by: "orchestrator", evidence: { commit: "dd1c9fa", repo: "/home/operator/.pi/agent" } },
		{
			v: 1,
			at: "2026-10-17T00:06:00.000Z",
			id: ASK_TWO,
			type: "raised",
			by: "architect",
			code: "LC6-2",
			kind: "product-decision",
			question: "Keep the asks family session-scoped?",
		},
		{ v: 1, at: "2026-10-17T00:07:00.000Z", id: ASK_TWO, type: "withdrawn", by: "architect", reason: "LD37 already rules it" },
	];
}

// ─── 1. Every event type through the owner, on the ledger ───────────────────

test("LC6: raise, prepare, answer, done, withdraw and note fold in ledger mode", async (t) => {
	const b = box();
	t.after(b.close);
	await startDaemon(t, b.ledgerDir);
	const restore = useLedger(b);
	t.after(restore);

	const raised = raiseAsk(b.stateDir, {
		by: "orchestrator",
		kind: "operator-action",
		question: "Approve the LC6 field test?",
		code: "LC6A",
		blocks: ["lc6"],
	});
	assert.equal(raised.status, "open");
	assert.equal(raised.raisedBy, "orchestrator");

	const prepared = prepareAsk(b.stateDir, { ref: "LC6A", by: "orchestrator", options: ["approve", "hold"], recommendation: "approve" });
	assert.equal(prepared.status, "awaiting-operator");
	assert.deepEqual(prepared.options, ["approve", "hold"]);

	const noted = noteAsk(b.stateDir, { ref: "LC6A", by: "orchestrator", text: "the plan names it" });
	assert.equal(noted.status, "awaiting-operator", "a note never changes the status");
	assert.deepEqual(noted.notes, ["the plan names it"]);

	const answered = answerAsk(b.stateDir, { ref: "LC6A", by: "operator-shell", ruling: "approve" });
	assert.equal(answered.status, "decided");
	assert.equal(answered.ruling, "approve");

	const done = finishAsk(b.stateDir, { ref: "LC6A", by: "orchestrator", evidence: { commit: "dd1c9fa", repo: "/home/operator/.pi/agent" } });
	assert.equal(done.status, "done");
	assert.deepEqual(done.evidence, { commit: "dd1c9fa", repo: "/home/operator/.pi/agent" });

	const second = raiseAsk(b.stateDir, { by: "architect", kind: "product-decision", question: "Keep the family session-scoped?" });
	const withdrawn = withdrawAsk(b.stateDir, { ref: second.id, by: "architect", reason: "LD37 already rules it" });
	assert.equal(withdrawn.status, "withdrawn");
	assert.equal(withdrawn.withdrawnReason, "LD37 already rules it");

	// A fresh fold sees every event, and nothing was written to the file.
	const queue = readAsks(b.stateDir);
	assert.equal(queue.unreadableLines, 0);
	assert.equal(queue.partialLastLine, 0);
	assert.deepEqual(
		queue.asks.map((ask) => [ask.code, ask.status]),
		[
			["LC6A", "done"],
			[undefined, "withdrawn"],
		],
	);
	assert.equal(existsSync(asksEventsPath(b.stateDir)), false, "ledger mode never writes asks/events.jsonl");

	// LC0-R7: `muster ask` raises one too, through the owner on the ledger.
	const { ctx, err } = cli(["ask", "--kind", "review", "--question", "Review the LC6 field test?"]);
	assert.equal(await askCommand.run(ctx), 0, err.join("\n"));
	assert.equal(readAsks(b.stateDir).asks.length, 3);
});

// ─── 2. The queue and the operator's list equal both backends ─────────────────────

test("LC6: the queue and renderOperatorList are the same over both backends for the same events", async (t) => {
	const b = box();
	t.after(b.close);

	// Files mode: today's store, unchanged.
	for (const event of events()) appendAskEvent(b.stateDir, event);
	const filesQueue = readAsks(b.stateDir);
	assert.equal(filesQueue.unreadableLines, 0);
	const filesList = renderOperatorList(filesQueue, NOW);
	const filesPath = join(b.root, "files-list.md");
	assert.deepEqual(regenerateOperatorList(b.stateDir, { path: filesPath, now: NOW }), { written: filesPath });
	const filesRendered = readFileSync(filesPath, "utf8");

	await startDaemon(t, b.ledgerDir);
	const restore = useLedger(b);
	t.after(restore);

	// Ledger mode: the same events, through the owner.
	for (const event of events()) appendAskEvent(b.stateDir, event);
	const ledgerQueue = readAsks(b.stateDir);
	assert.deepEqual(ledgerQueue, filesQueue);
	assert.equal(renderOperatorList(ledgerQueue, NOW), filesList);
	const ledgerPath = join(b.root, "ledger-list.md");
	assert.deepEqual(regenerateOperatorList(b.stateDir, { path: ledgerPath, now: NOW }), { written: ledgerPath });
	assert.equal(readFileSync(ledgerPath, "utf8"), filesRendered);

	// The ledger's own store holds them, one document per ask.
	const stored = requestSync<{ askId: string; events: AskEvent[] }[]>(ownerLedgerSocket(b.stateDir), "asksAll", {});
	assert.deepEqual(stored.map((doc) => [doc.askId, doc.events.length]), [
		[ASK_ONE, 5],
		[ASK_TWO, 2],
	]);
});

// ─── 3. A raise posts no muster.event ───────────────────────────────────────

test("LC6: a raise posts no muster.event", async (t) => {
	const b = box();
	t.after(b.close);
	await startDaemon(t, b.ledgerDir);
	const restore = useLedger(b);
	t.after(restore);

	const ask = raiseAsk(b.stateDir, { by: "orchestrator", kind: "review", question: "Does a raise wake the waiter?" });
	prepareAsk(b.stateDir, { ref: ask.id, by: "orchestrator", options: ["no"], recommendation: "no" });
	noteAsk(b.stateDir, { ref: ask.id, by: "orchestrator", text: "LD37: no entry" });

	const events = requestSync<unknown[]>(ownerLedgerSocket(b.stateDir), "events", {});
	assert.deepEqual(events, []);
});

// ─── 4. NLR 2: `rule` survives the ledger round trip ────────────────────────

test("NLR 2: a rule on the raised event is stored by the ledger and folds back, and `muster ask --rule` raises one", async (t) => {
	const b = box();
	t.after(b.close);
	await startDaemon(t, b.ledgerDir);
	const restore = useLedger(b);
	t.after(restore);

	const raised = raiseAsk(b.stateDir, { by: "orchestrator", kind: "authorization", question: "Pay for the plan?", code: "NLR1", rule: "spend" });
	assert.equal(raised.rule, "spend");
	const plain = raiseAsk(b.stateDir, { by: "orchestrator", kind: "review", question: "Look at this?", code: "NLR2" });
	assert.equal(plain.rule, undefined);

	// The ledger holds the field on the raised event itself.
	const stored = requestSync<{ askId: string; events: AskEvent[] }[]>(ownerLedgerSocket(b.stateDir), "asksAll", {});
	const rules = stored.map((doc) => [doc.askId === raised.id, (doc.events[0] as { rule?: string }).rule]);
	assert.deepEqual(rules.sort(), [[false, undefined], [true, "spend"]]);

	// A fresh fold reads it back, and the CLI raises one the same way.
	const asks = readAsks(b.stateDir).asks;
	assert.equal(asks.find((ask) => ask.code === "NLR1")!.rule, "spend");
	assert.equal(asks.find((ask) => ask.code === "NLR2")!.rule, undefined);
	const { ctx, err } = cli(["ask", "--kind", "authorization", "--question", "Publish the post?", "--rule", "publish"]);
	assert.equal(await askCommand.run(ctx), 0, err.join("\n"));
	assert.ok(readAsks(b.stateDir).asks.some((ask) => ask.rule === "publish"));
});
