/**
 * LC3 (§3.2): the synchronous bridge — one request to `musterd` answered while
 * the caller's thread is blocked in `Atomics.wait`, plus the per-socket
 * breaker and the late-reply rule.
 *
 * Every case runs against a daemon on a temporary directory, in its own child
 * process: `Atomics.wait` blocks the whole thread, so a daemon in this process
 * could never answer the call that is waiting on it. The two methods the
 * timeout cases need (a sleep, and a reply that outlives its caller's deadline)
 * have no ledger equivalent, so those cases use a raw wire stub that speaks the
 * same newline-delimited JSON; the round-trip cases use the real `startDaemon`.
 * Nothing here reads or writes the live `state/muster/`, and no case starts a
 * live `musterd`.
 */

import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { MusterdUnreachable, createClient } from "../ledger/client.ts";
import { LedgerError, requestSync } from "../ledger/client-sync.ts";
import { harnessRoot, nodeBinary, tsxLoaderPath } from "../../core/harness-paths.ts";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
const NODE = nodeBinary();
const DAEMON = join(HARNESS_ROOT, "muster", "ledger", "daemon.ts");
const SYNC = join(HARNESS_ROOT, "muster", "ledger", "client-sync.ts");
/** `build-hook-bundle.mjs` ships no declarations; the path in a variable keeps it out of the type graph. */
const BUILDER_MODULE = "../../../extensions/muster/build-hook-bundle.mjs";

/** The loader this process runs under, so a `.ts` fixture loads the same way here. */
function loaderArgs(): string[] {
	const args: string[] = [];
	for (let at = 0; at < process.execArgv.length; at++) {
		if (process.execArgv[at] === "--import" && process.execArgv[at + 1] !== undefined) args.push("--import", process.execArgv[at + 1] as string);
	}
	return args.length > 0 ? args : ["--import", tsxLoaderPath()];
}

/** The child daemon: the real `startDaemon` for round trips, a sleeping wire stub for the timeout cases. */
function fixtureSource(mode: "daemon" | "stub"): string {
	if (mode === "daemon") {
		return [
			`import { startDaemon } from ${JSON.stringify(DAEMON)};`,
			"await startDaemon(process.env.MUSTER_FIXTURE_DIR);",
			'process.stdout.write("READY\\n");',
		].join("\n");
	}
	return [
		'import { createServer } from "node:net";',
		'import { join } from "node:path";',
		"const server = createServer((socket) => {",
		'  let buffer = "";',
		'  socket.setEncoding("utf8");',
		'  socket.on("data", (chunk) => {',
		"    buffer += chunk;",
		"    let at;",
		'    while ((at = buffer.indexOf("\\n")) >= 0) {',
		"      const request = JSON.parse(buffer.slice(0, at));",
		"      buffer = buffer.slice(at + 1);",
		"      const wait = Number(request.params?.delayMs ?? 0);",
		"      const answer = () => socket.write(`${JSON.stringify({ id: request.id, ok: true, result: { echoed: request.params } })}\\n`);",
		"      if (wait > 0) setTimeout(answer, wait);",
		"      else answer();",
		"    }",
		"  });",
		"});",
		'const socket = join(process.env.MUSTER_FIXTURE_DIR ?? "", "ledger.sock");',
		'server.listen(socket, () => process.stdout.write("READY\\n"));',
	].join("\n");
}

type Fixture = { dir: string; socket: string; stop: () => Promise<void> };

/** Start a fixture; `dir` reuses a directory a stopped fixture left behind. */
async function startFixture(t: TestContext, mode: "daemon" | "stub", dir?: string): Promise<Fixture> {
	const root = dir ?? mkdtempSync(join(tmpdir(), `muster-lc3-${mode}-`));
	const file = join(root, `fixture-${mode}.mjs`);
	writeFileSync(file, fixtureSource(mode));
	const child: ChildProcess = spawn(NODE, [...loaderArgs(), file], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, MUSTER_FIXTURE_DIR: root },
	});
	let output = "";
	const collect = (chunk: Buffer): void => {
		output += chunk.toString();
	};
	child.stdout?.on("data", collect);
	child.stderr?.on("data", collect);
	const exited = new Promise<void>((resolveExit) => child.on("exit", () => resolveExit()));
	const stop = async (): Promise<void> => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited;
	};
	t.after(async () => {
		await stop();
		if (dir === undefined) rmSync(root, { recursive: true, force: true });
	});
	const deadline = Date.now() + 15_000;
	while (!output.includes("READY")) {
		if (child.exitCode !== null || child.signalCode !== null) throw new Error(`the fixture exited before READY: ${output}`);
		if (Date.now() > deadline) throw new Error(`the fixture did not answer within 15 s: ${output}`);
		await delay(25);
	}
	return { dir: root, socket: join(root, "ledger.sock"), stop };
}

/** One record through the daemon's own client, so the bridge has something to read. */
async function seed(socket: string): Promise<void> {
	const client = createClient(socket);
	await client.request("casUpdate", { store: "probe", id: "one", expectedRevision: undefined, record: { n: 1 } });
	client.close();
}

/** A test that moves the wall clock: the breaker reads `Date`, the caller's deadline a monotonic clock. */
function fakeClockAt(t: TestContext, offsetMs?: number): void {
	t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
	if (offsetMs !== undefined) t.mock.timers.setTime(Date.now() + offsetMs);
}

test("a casRead round trip returns the record", async (t) => {
	const fixture = await startFixture(t, "daemon");
	await seed(fixture.socket);
	assert.deepEqual(requestSync(fixture.socket, "casRead", { store: "probe", id: "one" }), { record: { n: 1 }, revision: 1 });
});

test("a reply line past the default 1 MiB cap fails as unreachable, and delivers whole when the call raises the bound (finding 28)", async (t) => {
	const fixture = await startFixture(t, "daemon");
	await seed(fixture.socket);
	// The live orchestrator inbox's delivered history measured 1,232,333 bytes in
	// one `messages` reply (LC16c, 2026-10-18); seed the same order of size.
	for (let n = 0; n < 110; n++) {
		requestSync(fixture.socket, "send", {
			requestId: `lc16c-big-${n}`,
			message: { id: `big-${n}`, agent: "orchestrator", from: "probe", at: new Date().toISOString(), text: "x".repeat(12_000), idempotencyKey: `lc16c-big-${n}` },
		});
	}
	// The default bound stays the guard it always was: the oversized reply tears
	// the connection down and the call fails as unreachable.
	assert.throws(() => requestSync(fixture.socket, "messages", { address: "orchestrator", state: "accepted" }), MusterdUnreachable);
	// Past the refused-socket breaker window, the export's raised bound delivers
	// the whole reply, and the connection keeps working.
	fakeClockAt(t, 6_000);
	const docs = requestSync<{ message: { id: string } }[]>(
		fixture.socket,
		"messages",
		{ address: "orchestrator", state: "accepted" },
		{ maxLineBytes: 64 * 1024 * 1024, timeoutMs: 30_000 },
	);
	assert.equal(docs.length, 110);
	assert.deepEqual(requestSync(fixture.socket, "casRead", { store: "probe", id: "one" }, { maxLineBytes: 64 * 1024 * 1024 }), { record: { n: 1 }, revision: 1 });
});

test("a daemon stopped between two calls throws at once, and the breaker holds the next call", async (t) => {
	const fixture = await startFixture(t, "daemon");
	await seed(fixture.socket);
	assert.deepEqual(requestSync(fixture.socket, "casRead", { store: "probe", id: "one" }), { record: { n: 1 }, revision: 1 });
	await fixture.stop();
	const started = performance.now();
	assert.throws(() => requestSync(fixture.socket, "casRead", { store: "probe", id: "one" }), MusterdUnreachable);
	const refusedMs = performance.now() - started;
	assert.ok(refusedMs < 50, `a refused socket must answer at once, took ${refusedMs.toFixed(1)}ms`);
	// The breaker, not the socket, refuses the next call: a fresh daemon on the same path is not asked.
	await startFixture(t, "daemon", fixture.dir);
	const breaker = performance.now();
	assert.throws(() => requestSync(fixture.socket, "casRead", { store: "probe", id: "one" }), MusterdUnreachable);
	assert.ok(performance.now() - breaker < 5, "the breaker answered without touching the socket");
	// Past its 5 s window the restarted daemon answers, so the breaker is a window and not a permanent refusal.
	fakeClockAt(t, 6_000);
	assert.deepEqual(requestSync(fixture.socket, "casRead", { store: "probe", id: "one" }), { record: { n: 1 }, revision: 1 });
});

test("a method slower than its budget times out at the budget, then the breaker holds for 60 s", async (t) => {
	const fixture = await startFixture(t, "stub");
	const started = performance.now();
	assert.throws(() => requestSync(fixture.socket, "casRead", { store: "probe", id: "one", delayMs: 500 }, { timeoutMs: 273 }), MusterdUnreachable);
	const elapsed = performance.now() - started;
	assert.ok(elapsed >= 260 && elapsed < 480, `a timeout must be about its budget, took ${elapsed.toFixed(1)}ms`);
	fakeClockAt(t, 30_000);
	const held = performance.now();
	assert.throws(() => requestSync(fixture.socket, "casRead", { store: "probe", id: "one" }, { timeoutMs: 273 }), MusterdUnreachable);
	assert.ok(performance.now() - held < 10, "inside the window every call throws at once");
	// Past 60 s the call waits for the daemon again, and the slow method times out a second time.
	t.mock.timers.setTime(Date.now() + 31_000);
	const again = performance.now();
	assert.throws(() => requestSync(fixture.socket, "casRead", { store: "probe", id: "one", delayMs: 500 }, { timeoutMs: 273 }), MusterdUnreachable);
	assert.ok(performance.now() - again >= 260, "past the window the call is charged its budget again");
});

test("the bridge refuses to run inside musterd (RF5)", () => {
	const saved = process.env["MUSTERD"];
	process.env["MUSTERD"] = "1";
	try {
		const started = performance.now();
		assert.throws(
			() => requestSync("/nonexistent-muster-lc3/ledger.sock", "casRead", {}),
			(error: unknown) => error instanceof LedgerError && error.message === "requestSync inside musterd",
		);
		assert.ok(performance.now() - started < 20, "the refusal is immediate, never a deadlock");
	} finally {
		if (saved === undefined) delete process.env["MUSTERD"];
		else process.env["MUSTERD"] = saved;
	}
});

test("startDaemon marks its own process, so the bridge refuses inside the daemon (RF5)", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "muster-lc3-inside-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "inside.mjs");
	writeFileSync(
		file,
		[
			`import { startDaemon } from ${JSON.stringify(DAEMON)};`,
			`import { requestSync } from ${JSON.stringify(SYNC)};`,
			"const daemon = await startDaemon(process.env.MUSTER_FIXTURE_DIR);",
			"const started = Date.now();",
			"try {",
			'  requestSync(daemon.socketPath, "casRead", { store: "probe", id: "one" });',
			'  process.stdout.write("ANSWERED\\n");',
			"} catch (error) {",
			'  process.stdout.write(`${error.name}|${error.message}|${Date.now() - started}\\n`);',
			"}",
			"await daemon.stop();",
		].join("\n"),
	);
	const run = spawnSync(NODE, [...loaderArgs(), file], { encoding: "utf8", timeout: 30_000, env: { ...process.env, MUSTER_FIXTURE_DIR: dir } });
	assert.equal(run.status, 0, run.stderr);
	const [name, message, elapsed] = run.stdout.trim().split("|");
	assert.equal(name, "LedgerError");
	assert.equal(message, "requestSync inside musterd");
	assert.ok(Number(elapsed) < 100, `the refusal must be immediate, took ${elapsed}ms (the deadlocked call's own deadline would be 2000 ms)`);
});

test("the same round trip from a one-file bundle in a child node process", async (t) => {
	const fixture = await startFixture(t, "daemon");
	await seed(fixture.socket);
	const entry = [
		`import { requestSync } from ${JSON.stringify(SYNC)};`,
		'const record = requestSync(process.argv[2], "casRead", { store: "probe", id: "one" }, { timeoutMs: 2000 });',
		"process.stdout.write(`${JSON.stringify(record)}\\n`);",
	].join("\n");
	const outfile = join(fixture.dir, "sync-check.bundle.mjs");
	const builder = (await import(BUILDER_MODULE)) as {
		buildSyncBundle: (options: { source: string; outfile: string }) => Promise<unknown>;
	};
	await builder.buildSyncBundle({ source: entry, outfile });
	assert.match(readFileSync(outfile, "utf8"), /globalThis\.__MUSTER_SYNC_WORKER_CODE__ = "/, "the bundle carries the worker's code as a string");
	const run = spawnSync(NODE, [outfile, fixture.socket], { encoding: "utf8", timeout: 30_000 });
	assert.equal(run.status, 0, run.stderr);
	assert.deepEqual(JSON.parse(run.stdout.trim()), { record: { n: 1 }, revision: 1 });
});

test("a late reply never ends the next call: B returns B's own result, after B's reply", async (t) => {
	const fixture = await startFixture(t, "stub");
	// Warm the worker and its connection, so A's 300 ms reply is later than B's own.
	requestSync(fixture.socket, "casRead", { store: "probe", id: "warm" }, { timeoutMs: 2000 });
	assert.throws(() => requestSync(fixture.socket, "casRead", { store: "probe", id: "a", delayMs: 300 }, { timeoutMs: 273 }), MusterdUnreachable);
	fakeClockAt(t, 61_000);
	const started = performance.now();
	const result = requestSync(fixture.socket, "casRead", { store: "probe", id: "b", delayMs: 100, marker: "B" }, { timeoutMs: 2000 });
	const elapsed = performance.now() - started;
	assert.deepEqual(result, { echoed: { store: "probe", id: "b", delayMs: 100, marker: "B" } });
	assert.ok(elapsed >= 95, `B must return only after B's reply arrived, took ${elapsed.toFixed(1)}ms`);
});
