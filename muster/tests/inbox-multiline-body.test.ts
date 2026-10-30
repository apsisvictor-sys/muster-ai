import "./muster-test-isolation.ts";
/**
 * WFIX: a multi-line inbox body reaches the orchestrator waiter whole.
 *
 * Defect (2026-10-25, ledger entry 6612): the gateway's message was stored whole, but the
 * waiter printed only its first line, because `muster inbox list` flattened each body to
 * its first non-empty line (300 characters at most) and `scripts/orch-wait.sh` printed that
 * column. The claims, one test each:
 * 1. Whole path, files mode: the gateway's own sender (`inboxSender`) writes a 1.5 KB
 *    multi-line body, the real `orch-wait.sh` runs the real `muster inbox list`, and the
 *    waiter's stdout holds every line of the body.
 * 2. The same path on the ledger (the mode the incident ran in), through a real `musterd`
 *    and `muster wait --events`.
 * 3. `inbox list` stays one line per message, tabs and backslashes survive the escape, and
 *    `inbox list --json` keeps the raw text.
 * 4. `muster wait --inbox` (the lane waiter) prints the body whole, real newlines included.
 *
 * Everything runs in a temp state dir and a temp ledger dir; nothing reads the live bus.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { inboxSender, EXTERNAL_PREFIX } from "../gateway/tools.ts";
import { listInboxMessages, writeInboxMessage } from "../lib/agent-inbox.ts";
import { harnessRoot, nodeBinary, tsxLoaderPath } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
const SCRIPT = join(HARNESS_ROOT, "muster", "scripts", "orch-wait.sh");
const LAUNCHER = join(piAgentDir(), "extensions", "muster", "launchers", "muster");
const NODE = nodeBinary();
const DAEMON = join(HARNESS_ROOT, "muster", "ledger", "daemon.ts");
const LEDGER_SWITCH = { backend: "ledger", flipId: "wfix-test", at: "2026-10-25T00:00:00+03:00", cursor: "1" };

/** A 1.5 KB body with the shape of Henry's relay: a header line, then paragraphs, a list and a blank line. */
function henryBody(): string {
	const lines = ["TO: orchestrator FROM: Henry", "", "Priority direction, 2026-10-25 01:08:"];
	for (let n = 1; lines.join("\n").length < 1500; n++) lines.push(`${n}. line ${n} of the relay, with a\ttab and a back\\slash, ${"x".repeat(40)}`);
	return lines.join("\n");
}

type Box = { root: string; state: string; ledgerDir: string; events: string; offset: string; transcript: string; env: NodeJS.ProcessEnv };

function box(t: TestContext): Box {
	const root = mkdtempSync(join(tmpdir(), "wfix-body-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const state = join(root, "state", "muster");
	const ledgerDir = join(root, "ledger");
	mkdirSync(state, { recursive: true });
	mkdirSync(ledgerDir, { recursive: true });
	const events = join(root, "orchestrator-events.log");
	const offset = join(root, "orch-wait.offset");
	const transcript = join(root, "transcript.jsonl");
	writeFileSync(events, "");
	writeFileSync(transcript, "");
	const env: NodeJS.ProcessEnv = {
		...process.env,
		ORCH_MUSTER: LAUNCHER,
		PI_MUSTER_STATE_DIR: state,
		MUSTER_LEDGER_DIR: ledgerDir,
		ORCH_EVENTS: events,
		ORCH_WAIT_OFFSET: offset,
		ORCH_WAIT_CURSOR: join(root, "orch-wait.cursor"),
		ORCH_TRANSCRIPT: transcript,
		ORCH_COLLECT_WINDOW_S: "0",
		ORCH_NO_EVENT_S: "0",
		ORCH_POLL_S: "1",
	};
	return { root, state, ledgerDir, events, offset, transcript, env };
}

/** The body as the waiter prints it: one line, newline and tab and backslash escaped. */
function escaped(body: string): string {
	return body.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function loaderArgs(): string[] {
	const args: string[] = [];
	for (let at = 0; at < process.execArgv.length; at++) {
		if (process.execArgv[at] === "--import" && process.execArgv[at + 1] !== undefined) args.push("--import", process.execArgv[at + 1] as string);
	}
	return args.length > 0 ? args : ["--import", tsxLoaderPath()];
}

/** The real `startDaemon` in its own process, as the LC7 test does. */
function startDaemon(t: TestContext, dir: string): Promise<void> {
	const file = join(dir, "fixture-daemon.mjs");
	writeFileSync(file, [`import { startDaemon } from ${JSON.stringify(DAEMON)};`, "await startDaemon(process.env.MUSTER_FIXTURE_DIR);", 'process.stdout.write("READY\\n");'].join("\n"));
	const child: ChildProcess = spawn(NODE, [...loaderArgs(), file], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MUSTER_FIXTURE_DIR: dir } });
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

/** The gateway's own path: `send_to_orchestrator` hands `deps.sendToOrchestrator` the prefixed text. */
async function gatewaySends(stateDir: string, body: string): Promise<void> {
	const send = inboxSender({ stateDir, agentId: "grokbot", recipientId: "orchestrator" });
	await send(`${EXTERNAL_PREFIX}${body}`);
}

function runWaiter(b: Box) {
	return spawnSync("bash", [SCRIPT], { encoding: "utf8", timeout: 90_000, env: b.env });
}

function assertBodyWhole(stdout: string, body: string): void {
	const inboxLines = stdout.split("\n").filter((line) => line.includes(" INBOX: grokbot | "));
	assert.equal(inboxLines.length, 1, `one INBOX line for the one message: ${stdout}`);
	assert.ok(inboxLines[0]!.includes(escaped(`${EXTERNAL_PREFIX}${body}`)), `the whole body is on the INBOX line (${stdout.length} bytes printed)`);
	for (const line of body.split("\n").filter((entry) => entry.trim() !== "")) {
		assert.ok(stdout.includes(escaped(line)), `body line missing from the waiter output: ${line.slice(0, 60)}`);
	}
}

test("WFIX: the gateway's multi-line body reaches the waiter whole (files mode, whole path)", async (t) => {
	const b = box(t);
	const body = henryBody();
	assert.ok(body.length >= 1500 && body.includes("\n"));
	await gatewaySends(b.state, body);
	assert.equal(listInboxMessages(b.state, "orchestrator")[0]?.text, `${EXTERNAL_PREFIX}${body}`, "the store holds the whole text");

	const result = runWaiter(b);
	assert.equal(result.status, 0, result.stderr);
	assertBodyWhole(result.stdout, body);
	assert.equal(listInboxMessages(b.state, "orchestrator").length, 0, "the message was marked read after it was printed");
});

test("WFIX: the gateway's multi-line body reaches the waiter whole (ledger mode, real musterd and muster wait --events)", async (t) => {
	const b = box(t);
	await startDaemon(t, b.ledgerDir);
	writeFileSync(join(b.state, "backend.json"), JSON.stringify(LEDGER_SWITCH));
	const saved = { ledger: process.env["MUSTER_LEDGER_DIR"], state: process.env["PI_MUSTER_STATE_DIR"] };
	process.env["MUSTER_LEDGER_DIR"] = b.ledgerDir;
	process.env["PI_MUSTER_STATE_DIR"] = b.state;
	t.after(() => {
		if (saved.ledger === undefined) delete process.env["MUSTER_LEDGER_DIR"];
		else process.env["MUSTER_LEDGER_DIR"] = saved.ledger;
		if (saved.state === undefined) delete process.env["PI_MUSTER_STATE_DIR"];
		else process.env["PI_MUSTER_STATE_DIR"] = saved.state;
	});
	const body = henryBody();
	await gatewaySends(b.state, body);
	assert.equal(listInboxMessages(b.state, "orchestrator")[0]?.text, `${EXTERNAL_PREFIX}${body}`, "the ledger holds the whole text");

	const result = runWaiter(b);
	assert.equal(result.status, 0, result.stderr);
	assertBodyWhole(result.stdout, body);
	assert.equal(listInboxMessages(b.state, "orchestrator").length, 0, "the message was marked delivered after it was printed");
});

test("WFIX: inbox list stays one line per message, escapes tab, newline and backslash, and --json keeps the raw text", (t) => {
	const b = box(t);
	const text = "head\tcol\nsecond \\n literal\r\n\nlast";
	writeInboxMessage(b.state, { agent: "orchestrator", from: "grokbot", at: "2026-10-25T01:00:00.000Z", text, idempotencyKey: "a", source: "send", id: "id-a" });
	writeInboxMessage(b.state, { agent: "orchestrator", from: "pi-core", at: "2026-10-25T01:01:00.000Z", text: "plain", idempotencyKey: "b", id: "id-b" });
	const listed = spawnSync(LAUNCHER, ["inbox", "list", "orchestrator"], { encoding: "utf8", timeout: 60_000, env: b.env });
	assert.equal(listed.status, 0, listed.stderr);
	const rows = listed.stdout.trimEnd().split("\n").map((line) => line.split("\t"));
	assert.equal(rows.length, 2, "one line per message");
	assert.equal(rows[0]!.length, 6, "six columns, so a reader splitting on tabs keeps them");
	assert.equal(rows[0]![5], "head\\tcol\\nsecond \\\\n literal\\r\\n\\nlast");
	assert.equal(rows[1]![5], "plain");
	const json = spawnSync(LAUNCHER, ["inbox", "list", "orchestrator", "--json"], { encoding: "utf8", timeout: 60_000, env: b.env });
	assert.equal((JSON.parse(json.stdout) as Array<{ text: string }>)[0]!.text, text);
});

test("WFIX: muster wait --inbox prints the multi-line body whole", async (t) => {
	const b = box(t);
	const body = henryBody();
	await gatewaySends(b.state, body);
	const result = spawnSync(LAUNCHER, ["wait", "--inbox", "orchestrator", "--timeout", "5"], { encoding: "utf8", timeout: 60_000, env: b.env });
	assert.equal(result.status, 0, result.stderr);
	assert.ok(result.stdout.includes(`${EXTERNAL_PREFIX}${body}`), "the body is printed with its real newlines");
});
