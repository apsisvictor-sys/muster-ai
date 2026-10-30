import "./muster-test-isolation.ts";
/**
 * LC8 (plan §4, §2 and LC-D5): doorbells, the derived signal the Claude plugin's
 * cached inbox folder reads.
 *
 * The claims proven here, one deliberate test each:
 * 1. A send raises one empty 0600 `<id>.json`, a delivered message and a drain
 *    remove it again.
 * 2. A daemon restarted after a doorbell file was deleted by hand recreates it.
 * 3. A message file (`<13-digit ms>-<id>.json`) in an inbox folder is left in
 *    place and counted as one stray, never removed by the sweep.
 * 4. RF2: a folder path taken before the flip sees the doorbell of a message sent
 *    after the flip, so a Claude session started earlier still wakes.
 *
 * Everything runs in a temp directory that is both the Muster state directory and
 * the ledger directory, so nothing here reads or writes live `state/muster/`.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { writeInboxMessage } from "../lib/agent-inbox.ts";
import { backendPath } from "../ledger/backend.ts";
import { requestSync } from "../ledger/client-sync.ts";
import { doorbellFileName, inboxDoorbellStrays } from "../ledger/doorbell.ts";
import { ownerLedgerSocket } from "../ledger/stores.ts";
import { harnessRoot, nodeBinary, tsxLoaderPath } from "../../core/harness-paths.ts";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
const NODE = nodeBinary();
const DAEMON = join(HARNESS_ROOT, "muster", "ledger", "daemon.ts");

const AT_ONE = "2026-10-17T00:01:00.000Z";
const AT_TWO = "2026-10-17T00:02:00.000Z";
/** The switch file as the flip tool writes it (LC15). */
const LEDGER_SWITCH = { backend: "ledger", flipId: "lc8-test", at: "2026-10-17T00:00:00+03:00", cursor: "1" };

type Box = { root: string; dir: string; close: () => void };

/**
 * One disposable install: the state directory `musterd` serves, which is also its
 * ledger directory — `MUSTER_LEDGER_DIR` names the state directory in production.
 */
function box(): Box {
	const root = mkdtempSync(join(tmpdir(), "muster-lc8-"));
	const dir = join(root, "state", "muster");
	mkdirSync(dir, { recursive: true });
	return { root, dir, close: () => rmSync(root, { recursive: true, force: true }) };
}

/** The flip, as LC15 writes it: `<musterStateDir>/backend.json` names the ledger. */
function flip(b: Box): void {
	writeFileSync(backendPath(b.dir), JSON.stringify(LEDGER_SWITCH));
}

/** Point the owner functions and the synchronous bridge at this box's state and ledger directory. */
function pointOwnersAt(b: Box): () => void {
	const savedLedger = process.env["MUSTER_LEDGER_DIR"];
	const savedState = process.env["PI_MUSTER_STATE_DIR"];
	process.env["MUSTER_LEDGER_DIR"] = b.dir;
	process.env["PI_MUSTER_STATE_DIR"] = b.dir;
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

type Fixture = { child: ChildProcess; log: () => string };

/** The real `startDaemon` in its own process: `requestSync` blocks the calling thread in `Atomics.wait`. */
function startFixture(t: TestContext, dir: string): Promise<Fixture> {
	const file = join(dir, "fixture-daemon.mjs");
	writeFileSync(
		file,
		[
			`import { startDaemon } from ${JSON.stringify(DAEMON)};`,
			"const daemon = await startDaemon(process.env.MUSTER_FIXTURE_DIR);",
			"process.on('SIGTERM', () => { void daemon.stop().then(() => process.exit(0)); });",
			'process.stdout.write("READY\\n");',
		].join("\n"),
	);
	const child: ChildProcess = spawn(NODE, [...loaderArgs(), file], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, MUSTER_FIXTURE_DIR: dir },
	});
	let output = "";
	const collect = (chunk: Buffer): void => void (output += chunk.toString());
	child.stdout?.on("data", collect);
	child.stderr?.on("data", collect);
	t.after(async () => stopFixture(child));
	return new Promise<Fixture>((resolveReady, reject) => {
		const deadline = Date.now() + 15_000;
		const poll = (): void => {
			if (output.includes("READY")) return resolveReady({ child, log: () => output });
			if (child.exitCode !== null || child.signalCode !== null) return reject(new Error(`the daemon fixture exited before READY: ${output}`));
			if (Date.now() > deadline) return reject(new Error(`the daemon fixture did not answer within 15 s: ${output}`));
			void delay(25).then(poll);
		};
		poll();
	});
}

async function stopFixture(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
	child.kill("SIGTERM");
	const killed = setTimeout(() => child.kill("SIGKILL"), 2000);
	await exited;
	clearTimeout(killed);
}

/** One write, everything the owner needs and no id of the caller's. */
function message(over: Partial<Parameters<typeof writeInboxMessage>[1]> = {}): Parameters<typeof writeInboxMessage>[1] {
	return { agent: "orchestrator", from: "pi-lane", at: AT_ONE, text: "first", idempotencyKey: "k1", ...over };
}

/** One address's folder — the owner's rule, the same path a cached plugin keeps. */
function inboxFolder(b: Box, address: string): string {
	return join(b.dir, "inbox", address);
}

/** Every `*.json` name in an address's folder, doorbells and strays alike. */
function jsonNames(dir: string): string[] {
	try {
		return readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
	} catch {
		return [];
	}
}

/**
 * The plugin's `isPendingInbox` (`claude-hook.core.ts:106-107`): any `*.json` file
 * in the cached folder means a message is waiting. Played here so the claim does
 * not need the plugin repository.
 */
function pluginProbe(cachedFolder: string): boolean {
	return jsonNames(cachedFolder).length > 0;
}

// ─── 1. A send raises a doorbell, a delivery and a drain remove it ──────────

test("LC8: a send raises an empty 0600 doorbell, a delivered message and a drain remove it", async (t) => {
	const b = box();
	t.after(b.close);
	flip(b);
	t.after(pointOwnersAt(b));
	await startFixture(t, b.dir);

	const first = writeInboxMessage(b.dir, message({ text: "first", at: AT_ONE, idempotencyKey: "k1" }));
	const second = writeInboxMessage(b.dir, message({ text: "second", at: AT_TWO, idempotencyKey: "k2" }));

	const folder = inboxFolder(b, "orchestrator");
	const firstBell = join(folder, doorbellFileName(first));
	assert.deepEqual(jsonNames(folder), [doorbellFileName(first), doorbellFileName(second)].sort(), "one doorbell per pending message");
	assert.equal(statSync(firstBell).size, 0, "a doorbell is empty");
	assert.equal(statSync(firstBell).mode & 0o777, 0o600, "a doorbell is mode 0600");

	requestSync<{ ok: boolean }>(ownerLedgerSocket(b.dir), "markDelivered", {
		address: "orchestrator",
		id: first,
		requestId: "lc8-deliver-first",
	});
	assert.deepEqual(jsonNames(folder), [doorbellFileName(second)], "a delivered message loses its doorbell");

	requestSync<{ messages: unknown[] }>(ownerLedgerSocket(b.dir), "drain", { address: "orchestrator" });
	assert.deepEqual(jsonNames(folder), [], "a drain removes every doorbell of the address");
});

// ─── 2. The start sweep recreates what was deleted by hand ──────────────────

test("LC8: a daemon restarted after a doorbell was deleted by hand recreates it", async (t) => {
	const b = box();
	t.after(b.close);
	flip(b);
	t.after(pointOwnersAt(b));

	const first = await startFixture(t, b.dir);
	const id = writeInboxMessage(b.dir, message({ text: "first", at: AT_ONE, idempotencyKey: "k1" }));
	const bell = join(inboxFolder(b, "orchestrator"), doorbellFileName(id));
	assert.equal(existsSync(bell), true, "the send raised the doorbell");
	rmSync(bell);
	assert.deepEqual(jsonNames(inboxFolder(b, "orchestrator")), [], "the doorbell is gone by hand");
	await stopFixture(first.child);

	await startFixture(t, b.dir);
	assert.deepEqual(jsonNames(inboxFolder(b, "orchestrator")), [doorbellFileName(id)], "the start sweep recreates the missing doorbell");
});

// ─── 3. A message file is a stray, never removed ────────────────────────────

test("LC8: a message file in an inbox folder is left in place and counted as one stray", async (t) => {
	const b = box();
	t.after(b.close);
	flip(b);
	t.after(pointOwnersAt(b));

	const address = "cc-mods";
	const folder = inboxFolder(b, address);
	mkdirSync(folder, { recursive: true });
	// A files-mode message file: `<13-digit ms>-<id>.json` (`agent-inbox.ts:85-88`).
	const strayName = "1750000000000-00000000-0000-4000-8000-000000000000.json";
	const stray = join(folder, strayName);
	writeFileSync(stray, JSON.stringify(message({ agent: address, text: "an old files-mode message" })));
	const before = statSync(stray);

	const fixture = await startFixture(t, b.dir);
	assert.equal(existsSync(stray), true, "the sweep never removes a non-empty file");
	assert.equal(statSync(stray).size, before.size, "the stray is left byte for byte");
	assert.deepEqual(inboxDoorbellStrays(b.dir), [{ address, name: strayName }], "muster ledger status counts one stray");
	assert.deepEqual(jsonNames(folder), [strayName], "the stray is not treated as a doorbell");
	assert.match(fixture.log(), /left in place/, "the daemon logs the stray once at start");
});

// ─── 4. RF2: the cached folder sees a message sent after the flip ────────────

test("LC8 RF2: a folder path taken before the flip sees the doorbell of a message sent after it", async (t) => {
	const b = box();
	t.after(b.close);
	// The Claude session cached this path when it started, before the flip.
	const cachedFolder = inboxFolder(b, "cc-mods");
	assert.equal(pluginProbe(cachedFolder), false, "before the flip the cached folder holds nothing");

	flip(b);
	t.after(pointOwnersAt(b));
	await startFixture(t, b.dir);
	const id = writeInboxMessage(b.dir, message({ agent: "cc-mods", text: "sent after the flip", idempotencyKey: "k1" }));

	assert.deepEqual(jsonNames(cachedFolder), [doorbellFileName(id)], "the doorbell lands in the cached folder");
	assert.equal(pluginProbe(cachedFolder), true, "the plugin's probe sees a pending message and calls the CLI");
});
