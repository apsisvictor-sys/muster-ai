import "./muster-test-isolation.ts";
/**
 * LC13 (plan §4): `send` without Concord.
 *
 * The claims proven here, one deliberate test each, all in ledger mode:
 * 1. A send to a Pi lane whose card is fresh writes one inbox message and types nothing into a pane.
 * 2. A send to a Pi lane whose card stopped beating writes the message and uses the pane as well.
 * 3. A send to a Claude lane words the waiter state as it does today.
 * 4. A send with no daemon is the boundary's: the store error is never swallowed into a pane
 *    fallback, and the real `muster send` frame exits 75 with the reason (DL6).
 *
 * Everything runs in a temp state directory with its own temp ledger directory
 * (`MUSTER_LEDGER_DIR`), so nothing here reads or writes live `state/muster/` and no
 * case writes a live `backend.json`. The arrangement mirrors `ledger-lc7-inbox.test.ts`.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { countInboxMessages, listInboxMessages } from "../lib/agent-inbox.ts";
import { backendPath } from "../ledger/backend.ts";
import { boundaryReason } from "../ledger/boundary.ts";
import { laneSendDeps } from "../send-deps.ts";
import { deliverLaneMessage, formatSendOutcome, type ArrivalProof, type SendLogRecord } from "../send.ts";
import { harnessRoot, nodeBinary, tsxLoaderPath } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
const NODE = nodeBinary();
const DAEMON = join(HARNESS_ROOT, "muster", "ledger", "daemon.ts");

/** The switch file as the flip tool writes it (LC15). */
const LEDGER_SWITCH = { backend: "ledger", flipId: "lc13-test", at: "2026-10-17T00:00:00+03:00", cursor: "1" };

type Box = { root: string; stateDir: string; ledgerDir: string; close: () => void };

/** One disposable install: a Muster state dir and the ledger dir `musterd` serves from. */
function box(): Box {
	const root = mkdtempSync(join(tmpdir(), "muster-lc13-"));
	const stateDir = join(root, "state", "muster");
	const ledgerDir = join(root, "ledger");
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(ledgerDir, { recursive: true });
	return { root, stateDir, ledgerDir, close: () => rmSync(root, { recursive: true, force: true }) };
}

/** Point the owners at the ledger: the switch file, the ledger directory and the state dir they read. */
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

/** The wiring under test, with the one port a test must decide: the arrival proof it would read from a card. */
function depsWithProof(
	stateDir: string,
	proof: () => Promise<ArrivalProof>,
	panes: Array<{ laneId: string; text: string }>,
	records: SendLogRecord[],
) {
	const deps = laneSendDeps(stateDir, "lc13-sender", {
		// A lane with no card would otherwise ask the real `claude agents --json`.
		readRows: () => [],
		pane: async (request) => {
			panes.push(request);
			return { ok: true, command: `pane ${request.laneId}` };
		},
	});
	return { ...deps, log: (record: SendLogRecord) => records.push(record), confirmArrival: proof };
}

// ─── 1. A ledger send reaches the inbox, and a fresh card means no pane ─────

test("LC13: a ledger send to a Pi lane with a fresh card writes one message and no pane line", async (t) => {
	const b = box();
	t.after(b.close);
	await startDaemon(t, b.ledgerDir);
	const restore = useLedger(b);
	t.after(restore);

	const panes: Array<{ laneId: string; text: string }> = [];
	const records: SendLogRecord[] = [];
	const request = { laneId: "pi-lane", mode: "followup" as const, text: "brief" };
	const outcome = await deliverLaneMessage(request, depsWithProof(b.stateDir, async () => ({ state: "confirmed" }), panes, records));

	assert.equal(outcome.transport, "inbox");
	assert.equal(outcome.ledger, true);
	assert.equal(panes.length, 0, "a card that took the message is never typed into its pane");
	assert.deepEqual(listInboxMessages(b.stateDir, "pi-lane").map((message) => message.text), ["brief"]);
	assert.equal(countInboxMessages(b.stateDir, "pi-lane"), 1);
	assert.equal(records.length, 1);
	assert.equal(records[0]!.transport, "inbox");
	assert.equal(records[0]!.attempts, undefined, "Concord is not asked, so there are no attempts");
	assert.match(formatSendOutcome(outcome, request), /^muster send: delivered to pi-lane by its inbox/, "the outcome names the inbox and never Concord");
});

// ─── 2. A card that stopped beating sends the message to the pane as well ───

test("LC13: a ledger send to a Pi lane whose card stopped beating writes the message and uses the pane", async (t) => {
	const b = box();
	t.after(b.close);
	await startDaemon(t, b.ledgerDir);
	const restore = useLedger(b);
	t.after(restore);

	const panes: Array<{ laneId: string; text: string }> = [];
	const records: SendLogRecord[] = [];
	const request = { laneId: "pi-lane", mode: "followup" as const, text: "brief" };
	const outcome = await deliverLaneMessage(
		request,
		depsWithProof(b.stateDir, async () => ({ state: "held", detail: "the lane's card says it is gone" }), panes, records),
	);

	assert.equal(outcome.transport, "pane");
	assert.equal(panes.length, 1, "the lane's pane carries the message");
	assert.equal(panes[0]!.text, "brief");
	assert.deepEqual(listInboxMessages(b.stateDir, "pi-lane").map((message) => message.text), ["brief"], "the inbox copy is written either way");
	assert.deepEqual(
		records.map((record) => record.transport),
		["inbox", "pane"],
	);
	assert.match(records[1]!.reason ?? "", /the inbox holds .* but the lane's card says it is gone/, "the pane record names why the pane was used");
	assert.match(formatSendOutcome(outcome, request), /the message is also in its inbox/);
});

// ─── 3. A Claude lane words its waiter state as today ──────────────────────

test("LC13: a ledger send to a Claude lane words the waiter state as today", async (t) => {
	const b = box();
	t.after(b.close);
	await startDaemon(t, b.ledgerDir);
	const restore = useLedger(b);
	t.after(restore);

	const deps = laneSendDeps(b.stateDir, "lc13-sender", {
		readRows: () => [{ sessionId: "s-1", name: "cl-1", pid: 4242 }],
		pidAlive: () => true,
		waiterAlive: () => true,
		pane: async () => ({ ok: true, command: "unused" }),
		confirmArrival: false,
	});
	const request = { laneId: "cl-1", mode: "followup" as const, text: "brief" };
	const outcome = await deliverLaneMessage(request, deps);

	assert.equal(outcome.transport, "inbox");
	assert.equal(outcome.queued, "waiter");
	assert.equal(countInboxMessages(b.stateDir, "cl-1"), 1);
	assert.match(formatSendOutcome(outcome, request), /^muster send: queued for cl-1 \(inbox; the lane's waiter wakes it\): /);
});

// ─── 4. No daemon: the boundary owns it, and the CLI exits 75 ──────────────

test("LC13: a ledger send with no daemon is the boundary's, and the real muster send frame exits 75", async (t) => {
	const b = box();
	const noConcord = join(b.root, "empty-agent-dir");
	mkdirSync(noConcord, { recursive: true });
	t.after(b.close);
	const restore = useLedger(b);
	t.after(restore);

	// The delivery layer hands the store error up untouched: no delivery failure, no pane.
	const panes: Array<{ laneId: string; text: string }> = [];
	const deps = laneSendDeps(b.stateDir, "lc13-sender", {
		readRows: () => [],
		pane: async (request) => {
			panes.push(request);
			return { ok: true, command: "pane" };
		},
	});
	await assert.rejects(
		() => deliverLaneMessage({ laneId: "pi-lane", mode: "followup", text: "brief" }, deps),
		(error: unknown) => {
			assert.equal(boundaryReason(error), "musterd is not running");
			return true;
		},
	);
	assert.equal(panes.length, 0, "an unreachable store is never reported as a pane delivery");

	// The real CLI frame (cli-main's `atBoundaryAsync("cli", …)`) turns that error into exit 75.
	// `agentDir` points at a directory with no Concord MCP launcher, so the send never opens a
	// Concord connection in this test; the store is what fails.
	const stub = join(b.root, "send-cli.mts");
	writeFileSync(
		stub,
		[
			`import { configurePiPorts } from ${JSON.stringify(pathToFileURL(join(HARNESS_ROOT, "core", "pi-ports.ts")).href)};`,
			`import ${JSON.stringify(pathToFileURL(join(piAgentDir(), "extensions", "lib", "harness-ports.ts")).href)};`,
			`import { musterMain } from ${JSON.stringify(pathToFileURL(join(HARNESS_ROOT, "muster", "cli-main.ts")).href)};`,
			`import { command } from ${JSON.stringify(pathToFileURL(join(HARNESS_ROOT, "muster", "cli", "send.ts")).href)};`,
			`configurePiPorts({ agentDir: ${JSON.stringify(noConcord)} });`,
			`musterMain(async () => new Map([["send", command]]));`,
			"",
		].join("\n"),
	);
	let code = 0;
	let stderr = "";
	try {
		execFileSync(NODE, [...loaderArgs(), stub, "--agent", "lc13-sender", "send", "pi-lane", "brief"], {
			cwd: HARNESS_ROOT,
			env: { ...process.env, PI_MUSTER_STATE_DIR: b.stateDir, MUSTER_LEDGER_DIR: b.ledgerDir, NODE_NO_WARNINGS: "1" },
			encoding: "utf8",
			timeout: 60_000,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		const failure = error as { status?: number; stderr?: string };
		code = failure.status ?? -1;
		stderr = failure.stderr ?? "";
	}
	assert.equal(code, 75, stderr);
	assert.match(stderr, /musterd is not running/);
});
