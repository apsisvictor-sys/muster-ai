import "./muster-test-isolation.ts";
/**
 * LC9 (plan §4, §3.2, §3.3): events and waiting, in files mode and on the ledger.
 *
 * The claims proven here, one deliberate test each:
 * 1. `muster event` writes night-watch's line byte for byte in files mode, through
 *    the one owner (`lane-report.ts`).
 * 2. A report appended by the owner wakes a `muster wait --events` child within 1 s,
 *    and the child prints the events-file line format.
 * 3. Two events committed in one millisecond are both printed (the cursor is the
 *    entry id, never `at`).
 * 4. A waiter whose daemon restarts reconnects and prints the event committed during
 *    the outage once.
 * 5. A `muster wait --inbox` child started in files mode follows the flip and wakes
 *    on a ledger send within one poll.
 * 6. `orch-wait.sh` prints the same event bodies from the file and from the ledger,
 *    and a cursor after the imported prefix wakes nobody.
 * 7. `orch-wait.sh` follows a flip during its run: started in files mode it prints an
 *    event committed to the ledger after the switch moved.
 *
 * Everything runs in a temp state directory with its own temp ledger directory
 * (`MUSTER_LEDGER_DIR`), so nothing here reads or writes live `state/muster/`.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { harnessRoot, nodeBinary, tsxLoaderPath } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

import { listInboxMessages, writeInboxMessage } from "../lib/agent-inbox.ts";
import { appendOrchestratorEvent } from "../lane-report.ts";
import { backendPath } from "../ledger/backend.ts";
import { ledgerCommit } from "../ledger/cas-store.ts";
import { requestSync } from "../ledger/client-sync.ts";
import { ownerLedgerSocket } from "../ledger/stores.ts";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
const NODE = nodeBinary();
const DAEMON = join(HARNESS_ROOT, "muster", "ledger", "daemon.ts");
const MUSTER = join(piAgentDir(), "extensions", "muster", "launchers", "muster");
const ORCH_WAIT = join(HARNESS_ROOT, "muster", "scripts", "orch-wait.sh");

const FLIP_ID = "lc9-test";

type Box = { root: string; stateDir: string; ledgerDir: string; events: string; close: () => void };

/** One disposable install: a Muster state dir, the events file beside it, and the ledger dir `musterd` serves from. */
function box(): Box {
	const root = mkdtempSync(join(tmpdir(), "muster-lc9-"));
	const stateDir = join(root, "state", "muster");
	const ledgerDir = join(root, "ledger");
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(ledgerDir, { recursive: true });
	return { root, stateDir, ledgerDir, events: join(root, "state", "orchestrator-events.log"), close: () => rmSync(root, { recursive: true, force: true }) };
}

/** The switch file as the flip tool writes it (LC15): `cursor` is the imported prefix no waiter wakes on. */
function useLedger(b: Box, cursor = "0"): void {
	writeFileSync(backendPath(b.stateDir), JSON.stringify({ backend: "ledger", flipId: FLIP_ID, at: "2026-10-17T00:00:00+03:00", cursor }));
}

/** The env a muster child needs to reach this box's stores. */
function musterEnv(b: Box, over: Record<string, string> = {}): Record<string, string> {
	return { ...process.env, PI_MUSTER_STATE_DIR: b.stateDir, MUSTER_LEDGER_DIR: b.ledgerDir, ...over } as Record<string, string>;
}

/** The loader this process runs under, so a child fixture loads a `.ts` module the same way. */
function loaderArgs(): string[] {
	const args: string[] = [];
	for (let at = 0; at < process.execArgv.length; at++) {
		if (process.execArgv[at] === "--import" && process.execArgv[at + 1] !== undefined) args.push("--import", process.execArgv[at + 1] as string);
	}
	return args.length > 0 ? args : ["--import", tsxLoaderPath()];
}

type Daemon = { stop: () => Promise<void> };

/** The real `startDaemon` in its own process: `requestSync` blocks the calling thread in `Atomics.wait`. */
async function startDaemon(dir: string): Promise<Daemon> {
	const file = join(dir, "lc9-daemon.mjs");
	writeFileSync(file, [`import { startDaemon } from ${JSON.stringify(DAEMON)};`, "await startDaemon(process.env.MUSTER_FIXTURE_DIR);", 'process.stdout.write("READY\\n");'].join("\n"));
	const child: ChildProcess = spawn(NODE, [...loaderArgs(), file], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MUSTER_FIXTURE_DIR: dir } });
	let output = "";
	const collect = (chunk: Buffer): void => void (output += chunk.toString());
	child.stdout?.on("data", collect);
	child.stderr?.on("data", collect);
	const stop = async (): Promise<void> => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
		child.kill("SIGKILL");
		await exited;
	};
	const deadline = Date.now() + 15_000;
	while (!output.includes("READY")) {
		if (child.exitCode !== null || child.signalCode !== null) throw new Error(`the daemon fixture exited before READY: ${output}`);
		if (Date.now() > deadline) throw new Error(`the daemon fixture did not answer within 15 s: ${output}`);
		await delay(25);
	}
	return { stop };
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

/** Poll until the predicate holds, so a slow child is a failure with a reason and not a flake. */
async function until(predicate: () => boolean, ms: number, label: string): Promise<void> {
	const deadline = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${label}`);
		await delay(5);
	}
}

/** The muster CLI, run to completion. */
function muster(args: string[], b: Box, over: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(MUSTER, args, { encoding: "utf8", timeout: 60_000, env: musterEnv(b, over) });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The event body: the line without its `<date -Iseconds> ` prefix. */
function body(line: string): string {
	return line.slice(line.indexOf(" ") + 1);
}

function count(where: string, needle: string): number {
	return where.split(needle).length - 1;
}

test("LC9 event: `muster event` writes night-watch's line byte for byte in files mode", () => {
	const b = box();
	try {
		const result = muster(["event", "STALLED", "cc-a", "running but no session write for 5 min"], b);
		assert.equal(result.status, 0, result.stderr);
		const lines = readFileSync(b.events, "utf8").split("\n").filter((line) => line !== "");
		assert.equal(lines.length, 1, "one event, one line");
		// `date -Iseconds` + `<KIND>: <lane> | <detail>`: the shape night-watch wrote itself before LC9.
		assert.match(lines[0]!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2} STALLED: cc-a \| running but no session write for 5 min$/);
		// A detail with a bar and a newline stays one line, exactly as the owner's format says.
		assert.equal(muster(["event", "CRASHED", "cc-b", "a | b\nc"], b).status, 0);
		const both = readFileSync(b.events, "utf8").split("\n").filter((line) => line !== "");
		assert.equal(both.length, 2);
		assert.match(both[1]!, / CRASHED: cc-b \| a \| b c$/);
		// An unknown kind is refused rather than written.
		assert.equal(muster(["event", "NOT A KIND", "cc-c", "x"], b).status, 2);
	} finally {
		b.close();
	}
});

test("LC9 event: night-watch files its alerts through `muster event`, and a dry run writes nothing", () => {
	const b = box();
	try {
		const fake = join(b.root, "muster-stub");
		const calls = join(b.root, "calls");
		writeFileSync(calls, "");
		writeFileSync(fake, ["#!/usr/bin/env bash", `printf '%s\\n' "$*" >>"${calls}"`, "exit 0", ""].join("\n"));
		chmodSync(fake, 0o755);
		const script = `
import argparse, importlib.util, sys
spec = importlib.util.spec_from_file_location("night_watch", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
mod.ARGS = argparse.Namespace(state_dir=sys.argv[2], muster=sys.argv[3], dry_run=sys.argv[4] == "1")
mod.append_event("STALLED", "cc-a", "running but no session write for 5 min")
`;
		const live = spawnSync("python3", ["-c", script, join(piAgentDir(), "scripts", "night-watch.py"), b.stateDir, fake, "0"], { encoding: "utf8", timeout: 30_000 });
		assert.equal(live.status, 0, live.stderr);
		assert.equal(readFileSync(calls, "utf8").trim(), `event STALLED cc-a running but no session write for 5 min`);
		assert.equal(existsSync(b.events), false, "the watcher writes no store itself");
		writeFileSync(calls, "");
		const dry = spawnSync("python3", ["-c", script, join(piAgentDir(), "scripts", "night-watch.py"), b.stateDir, fake, "1"], { encoding: "utf8", timeout: 30_000 });
		assert.equal(dry.status, 0, dry.stderr);
		assert.equal(readFileSync(calls, "utf8"), "", "a dry run calls nothing");
	} finally {
		b.close();
	}
});

test("LC9 waiter: a report wakes `muster wait --events` within 1 s and prints the log line", async (t) => {
	const b = box();
	t.after(b.close);
	useLedger(b);
	process.env["PI_MUSTER_STATE_DIR"] = b.stateDir;
	process.env["MUSTER_LEDGER_DIR"] = b.ledgerDir;
	t.after(() => {
		delete process.env["PI_MUSTER_STATE_DIR"];
		delete process.env["MUSTER_LEDGER_DIR"];
	});
	const daemon = await startDaemon(b.ledgerDir);
	t.after(() => daemon.stop());

	const cursorFile = join(b.root, "cursor");
	const waiter = run(MUSTER, ["wait", "--events", "--cursor-file", cursorFile, "--timeout", "30"], musterEnv(b));
	t.after(() => waiter.stop());
	await until(() => existsSync(cursorFile), 15_000, "the waiter to arm (it writes its cursor file)");

	const at = Date.now();
	// The report path's other half, in this process: the owner appends the ledger event.
	assert.equal(appendOrchestratorEvent(b.stateDir, "REVIEW READY: cc-a lane/lc9@abc123 | done"), true, "the event is durably recorded");
	await until(() => waiter.output().includes("REVIEW READY: cc-a"), 5_000, "the waiter to print the report");
	const elapsed = Date.now() - at;
	assert.ok(elapsed <= 1_000, `the waiter woke within 1 s of the report (took ${elapsed} ms)`);
	assert.equal(count(waiter.output(), "REVIEW READY: cc-a"), 1, "printed once");
	assert.match(waiter.output(), /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2} REVIEW READY: cc-a lane\/lc9@abc123 \| done/);
});

test("LC9 waiter: two events committed in one millisecond are both printed", async (t) => {
	const b = box();
	t.after(b.close);
	useLedger(b);
	process.env["PI_MUSTER_STATE_DIR"] = b.stateDir;
	process.env["MUSTER_LEDGER_DIR"] = b.ledgerDir;
	t.after(() => {
		delete process.env["PI_MUSTER_STATE_DIR"];
		delete process.env["MUSTER_LEDGER_DIR"];
	});
	const daemon = await startDaemon(b.ledgerDir);
	t.after(() => daemon.stop());

	// One commit, two entries: the store stamps both with the same millisecond.
	const committed = ledgerCommit(ownerLedgerSocket(b.stateDir), {
		requestId: "lc9-two",
		cas: [],
		events: [
			{ type: "STALLED", lane: "cc-1", text: "first", at: 0, requestId: "lc9-e1" },
			{ type: "STALLED", lane: "cc-1", text: "second", at: 0, requestId: "lc9-e2" },
		],
	});
	assert.equal(committed.ok, true);

	const result = muster(["wait", "--events", "--timeout", "1"], b);
	assert.equal(result.status, 0, result.stderr);
	const lines = result.stdout.split("\n").filter((line) => line !== "");
	assert.deepEqual(lines.map(body), ["STALLED: cc-1 | first", "STALLED: cc-1 | second"], "both events, oldest first");
	// The printed batch is exactly what the store holds, so the two really shared a millisecond.
	const stored = requestSync<{ id: number; at: number }[]>(ownerLedgerSocket(b.stateDir), "events", {});
	assert.equal(stored.length, 2);
	assert.equal(stored[0]!.at, stored[1]!.at, "one millisecond");
	assert.notEqual(stored[0]!.id, stored[1]!.id, "two entry ids");
});

test("LC9 waiter: a restarted daemon reconnects and the outage event is printed once", async (t) => {
	const b = box();
	t.after(b.close);
	useLedger(b);
	process.env["PI_MUSTER_STATE_DIR"] = b.stateDir;
	process.env["MUSTER_LEDGER_DIR"] = b.ledgerDir;
	t.after(() => {
		delete process.env["PI_MUSTER_STATE_DIR"];
		delete process.env["MUSTER_LEDGER_DIR"];
	});
	const first = await startDaemon(b.ledgerDir);

	const cursorFile = join(b.root, "cursor");
	const waiter = run(MUSTER, ["wait", "--events", "--cursor-file", cursorFile, "--timeout", "40"], musterEnv(b));
	t.after(() => waiter.stop());
	await until(() => existsSync(cursorFile), 15_000, "the waiter to arm");

	await first.stop();
	const second = await startDaemon(b.ledgerDir);
	t.after(() => second.stop());
	assert.equal(
		ledgerCommit(ownerLedgerSocket(b.stateDir), {
			requestId: "lc9-outage",
			cas: [],
			events: [{ type: "STALLED", lane: "cc-2", text: "committed while the socket was down", at: 0, requestId: "lc9-outage-e" }],
		}).ok,
		true,
	);
	await until(() => waiter.output().includes("committed while the socket was down"), 20_000, "the waiter to print the outage event");
	assert.equal(count(waiter.output(), "committed while the socket was down"), 1, "printed once");
});

test("LC9 waiter: `--inbox` started in files mode wakes on a ledger send after the flip", async (t) => {
	const b = box();
	t.after(b.close);
	// Files mode first: no switch file, so the waiter arms against the files inbox.
	const daemon = await startDaemon(b.ledgerDir);
	t.after(() => daemon.stop());
	process.env["PI_MUSTER_STATE_DIR"] = b.stateDir;
	process.env["MUSTER_LEDGER_DIR"] = b.ledgerDir;
	t.after(() => {
		delete process.env["PI_MUSTER_STATE_DIR"];
		delete process.env["MUSTER_LEDGER_DIR"];
	});

	const waiter = run(MUSTER, ["wait", "--inbox", "pi-lane", "--timeout", "30"], musterEnv(b, { PI_MUSTER_WAIT_POLL_MS: "500" }));
	t.after(() => waiter.stop());
	await until(() => existsSync(join(b.stateDir, "waiters", "pi-lane.pid")), 15_000, "the waiter to arm");
	assert.equal(waiter.output(), "", "nothing to report in files mode");

	// The flip, then one poll for the waiter to notice it and subscribe.
	useLedger(b);
	await delay(900);
	const at = Date.now();
	writeInboxMessage(b.stateDir, { agent: "pi-lane", from: "orchestrator", at: new Date().toISOString(), text: "the ledger send", idempotencyKey: "lc9-m1" });
	await until(() => waiter.output().includes("the ledger send"), 10_000, "the waiter to print the ledger message");
	const elapsed = Date.now() - at;
	assert.ok(elapsed <= 1_500, `woken within a poll of the ledger send (took ${elapsed} ms)`);
	assert.deepEqual(listInboxMessages(b.stateDir, "pi-lane"), [], "the waiter marked it delivered in the ledger");
});

test("LC9 orch-wait: the same event bodies come from the file and from the ledger", async (t) => {
	const b = box();
	t.after(b.close);
	const orchEnv = (): Record<string, string> => ({ ...musterEnv(b), ORCH_STATE_DIR: join(b.root, "state"), ORCH_MUSTER: MUSTER, ORCH_NO_EVENT_S: "0", ORCH_COLLECT_WINDOW_S: "0", ORCH_POLL_S: "1" });
	const fixture = [
		"STALLED: cc-f | files and ledger agree",
		"QUOTA WALL: cc-g | walled",
	];
	const expected = fixture.slice().sort();

	// Files mode: the events file is the store.
	mkdirSync(dirname(b.events), { recursive: true });
	writeFileSync(b.events, ["2026-10-17T00:00:01+03:00 " + fixture[0]!, "2026-10-17T00:00:02+03:00 " + fixture[1]!, ""].join("\n"));
	const filesRun = run(ORCH_WAIT, [], orchEnv());
	let filesOut = "";
	await until(() => (filesOut = filesRun.output()).includes("QUOTA WALL"), 60_000, "the files-mode wait to print both events");
	await filesRun.stop();

	// Ledger mode: the same two events, committed through the store.
	useLedger(b);
	rmSync(b.events, { force: true });
	const daemon = await startDaemon(b.ledgerDir);
	t.after(() => daemon.stop());
	process.env["PI_MUSTER_STATE_DIR"] = b.stateDir;
	process.env["MUSTER_LEDGER_DIR"] = b.ledgerDir;
	t.after(() => {
		delete process.env["PI_MUSTER_STATE_DIR"];
		delete process.env["MUSTER_LEDGER_DIR"];
	});
	assert.equal(
		ledgerCommit(ownerLedgerSocket(b.stateDir), {
			requestId: "lc9-orch",
			cas: [],
			events: [
				{ type: "STALLED", lane: "cc-f", text: "files and ledger agree", at: 0, requestId: "lc9-orch-1" },
				{ type: "QUOTA WALL", lane: "cc-g", text: "walled", at: 0, requestId: "lc9-orch-2" },
			],
		}).ok,
		true,
	);
	const ledgerRun = run(ORCH_WAIT, [], orchEnv());
	let ledgerOut = "";
	await until(() => (ledgerOut = ledgerRun.output()).includes("QUOTA WALL"), 60_000, "the ledger-mode wait to print both events");
	await ledgerRun.stop();

	const bodies = (out: string): string[] => out.split("\n").filter((line) => line.includes("| ")).map(body).sort();
	assert.deepEqual(bodies(filesOut), expected);
	assert.deepEqual(bodies(ledgerOut), expected, "the ledger prints the same lines, no INBOX duplicate");
	assert.deepEqual(filesOut.split("\n").filter((line) => line.includes("INBOX")), [], "no inbox line in files mode");
	assert.deepEqual(ledgerOut.split("\n").filter((line) => line.includes("INBOX")), [], "no inbox line in ledger mode");

	// A cursor after the imported prefix wakes nobody: the flip's own cursor is the start.
	const cursor = join(b.root, "state", "orch-wait.cursor");
	const [flipId, lastId] = readFileSync(cursor, "utf8").trim().split(/\s+/);
	assert.equal(flipId, FLIP_ID);
	const after = muster(["wait", "--events", "--after", lastId!, "--timeout", "1"], b);
	assert.equal(after.status, 4, "nothing after the cursor");
	assert.equal(after.stdout.trim(), "");
});

test("LC9 orch-wait: a flip during the run is followed, and the ledger event is printed", async (t) => {
	const b = box();
	t.after(b.close);
	const daemon = await startDaemon(b.ledgerDir);
	t.after(() => daemon.stop());
	// Started in files mode with an empty events file, and told to wait.
	const waiter = run(ORCH_WAIT, [], {
		...musterEnv(b),
		ORCH_STATE_DIR: join(b.root, "state"),
		ORCH_MUSTER: MUSTER,
		ORCH_NO_EVENT_S: "25",
		ORCH_COLLECT_WINDOW_S: "0",
		ORCH_POLL_S: "1",
	});
	t.after(() => waiter.stop());
	await delay(2_000);
	assert.equal(waiter.output().includes("STALLED"), false, "nothing yet");

	// The flip, then one event committed to the ledger.
	process.env["PI_MUSTER_STATE_DIR"] = b.stateDir;
	process.env["MUSTER_LEDGER_DIR"] = b.ledgerDir;
	t.after(() => {
		delete process.env["PI_MUSTER_STATE_DIR"];
		delete process.env["MUSTER_LEDGER_DIR"];
	});
	useLedger(b);
	assert.equal(
		ledgerCommit(ownerLedgerSocket(b.stateDir), {
			requestId: "lc9-after-flip",
			cas: [],
			events: [{ type: "STALLED", lane: "cc-h", text: "committed after the flip", at: 0, requestId: "lc9-after-flip-e" }],
		}).ok,
		true,
	);
	await until(() => waiter.output().includes("committed after the flip"), 25_000, "the waiter to follow the flip and print the ledger event");
	assert.equal(body(waiter.output().split("\n").find((line) => line.includes("committed after the flip"))!), "STALLED: cc-h | committed after the flip");
});
