import "./muster-test-isolation.ts";
/**
 * LC16 finding 16: `musterd` reports a stalled event loop with the CPU it used meanwhile.
 *
 * The claims proven here, one deliberate test each:
 * 1. A loop blocked by the process's own synchronous work is reported, and the CPU it
 *    used is close to the lag.
 * 2. A process the host did not schedule (stopped, then continued) is reported with
 *    almost no CPU, so the two causes read differently.
 * 3. An idle loop reports nothing.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { watchEventLoop, type LoopLag } from "../ledger/loop-lag.ts";
import { harnessRoot, nodeBinary, tsxLoaderPath } from "../../core/harness-paths.ts";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
const NODE = nodeBinary();
const LOOP_LAG = join(HARNESS_ROOT, "muster", "ledger", "loop-lag.ts");

/** The loader this process runs under, so a child fixture loads a `.ts` module the same way. */
function loaderArgs(): string[] {
	const args: string[] = [];
	for (let at = 0; at < process.execArgv.length; at++) {
		if (process.execArgv[at] === "--import" && process.execArgv[at + 1] !== undefined) args.push("--import", process.execArgv[at + 1] as string);
	}
	return args.length > 0 ? args : ["--import", tsxLoaderPath()];
}

test("a loop blocked by its own work is reported with the CPU it spent", async () => {
	const reports: LoopLag[] = [];
	const stop = watchEventLoop((lag) => reports.push(lag), { intervalMs: 20, thresholdMs: 150 });
	try {
		await delay(60);
		const until = Date.now() + 400;
		while (Date.now() < until) {
			// Spin: the synchronous call the daemon has none of.
		}
		await delay(60);
	} finally {
		stop();
	}
	assert.equal(reports.length, 1);
	const [lag] = reports as [LoopLag];
	assert.ok(lag.lagMs >= 300, `lag ${lag.lagMs} ms`);
	assert.ok(lag.cpuMs >= lag.lagMs * 0.5, `cpu ${lag.cpuMs} ms of ${lag.lagMs} ms`);
});

test("a process the host did not schedule is reported with almost no CPU", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "muster-loop-lag-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "fixture-lag.mjs");
	writeFileSync(
		file,
		[
			`import { watchEventLoop } from ${JSON.stringify(LOOP_LAG)};`,
			"watchEventLoop((lag) => process.stdout.write(JSON.stringify(lag) + '\\n'), { intervalMs: 20, thresholdMs: 150 });",
			"setInterval(() => {}, 1000);",
			'process.stdout.write("READY\\n");',
		].join("\n"),
	);
	const child = spawn(NODE, [...loaderArgs(), file], { stdio: ["ignore", "pipe", "inherit"] });
	t.after(() => child.kill("SIGKILL"));
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => void (output += chunk.toString()));
	const deadline = Date.now() + 15_000;
	while (!output.includes("READY")) {
		assert.ok(Date.now() < deadline && child.exitCode === null, `the fixture did not start: ${output}`);
		await delay(20);
	}
	await delay(100);
	child.kill("SIGSTOP");
	await delay(500);
	child.kill("SIGCONT");
	while (!output.includes('"lagMs"')) {
		assert.ok(Date.now() < deadline, `no lag was reported: ${output}`);
		await delay(20);
	}
	const lag = JSON.parse(output.split("\n").find((line) => line.startsWith("{")) ?? "{}") as LoopLag;
	assert.ok(lag.lagMs >= 400, `lag ${lag.lagMs} ms`);
	assert.ok(lag.cpuMs <= lag.lagMs * 0.2, `cpu ${lag.cpuMs} ms of ${lag.lagMs} ms`);
});

test("an idle loop reports nothing", async () => {
	const reports: LoopLag[] = [];
	const stop = watchEventLoop((lag) => reports.push(lag), { intervalMs: 20, thresholdMs: 150 });
	try {
		await delay(500);
	} finally {
		stop();
	}
	assert.deepEqual(reports, []);
});
