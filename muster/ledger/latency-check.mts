#!/usr/bin/env node
/**
 * LC3's timing leg (plan §3.2, acceptance as amended by the architect's LC3-R1):
 * the per-tool-step hook against the ledger, through the one-file bundle, must stay
 * within today's path plus the ruling's tolerance.
 *
 *   node --import tsx extensions/muster/ledger/latency-check.mts \
 *     [--calls 200] [--bundle <file>] [--timeout 273] [--legacy-cmd "<today's hook>"] [--log <path>]
 *
 * LC3-R1 (architect, relayed by the orchestrator 2026-10-17): the check passes when
 * the bundle's p99 is at or under today's p99 + 60 ms, `--calls` each in the same
 * run. `--legacy-cmd` measures today's path in this run (the pilot's own leg, with
 * this process's environment and the hook payload on stdin); with no legacy command
 * today's p99 is the recorded 143 ms, and the bound is 203 ms.
 *
 * Ported from the pilot's `ledger/pilot/gate-g2-latency.mts` (commit on
 * `lane/m2-ledger-d`). Each call is a fresh child `node` running a one-file bundle
 * that calls `requestSync`, exactly as a Claude hook call is a fresh process, so the
 * daemon answering them must live outside this process; it is a test daemon in a
 * temporary directory, started and stopped here. No live lane and no live state is
 * touched.
 *
 * Exit 0 when the bundle is within the bound. The printed `3 x p99` line is the
 * `HOOK_TIMEOUT_MS` the hook passes (LC3-R1 sets that constant from the accepting run).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { HOOK_TIMEOUT_MS, createClient } from "./client.ts";

/** `build-hook-bundle.mjs` ships no declarations; this is the export the check uses. The path is a variable so nothing else resolves it at type time. */
type BundleBuilder = { buildSyncBundle: (options: { source: string; outfile: string }) => Promise<unknown> };
const BUILDER_MODULE = "../build-hook-bundle.mjs";

const builder = (await import(BUILDER_MODULE)) as BundleBuilder;
/** Today's path when no `--legacy-cmd` is given: the pilot's G2 legacy hook, p99 143 ms (`plans/muster-autonomy/ledger-pilot-evidence/gate-logs/g2-latency-2026-10-13.log`). */
const TODAYS_PATH_MS = 143;
/** LC3-R1's tolerance on the comparison: host noise is not a regression. */
const TOLERANCE_MS = 60;
const BASELINE_CALLS = 20;
/** The payload a hook is measured with: a tool-boundary payload, the common case. */
const HOOK_PAYLOAD = `${JSON.stringify({ hook_event_name: "PostToolUse", session_id: "muster-lc3-latency", cwd: "/muster/lc3" })}\n`;
const AGENT_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

/** The daemon explicitly not inherited: a call is a hook's own process, never a second `musterd`. */
const CALL_ENV: NodeJS.ProcessEnv = { ...process.env };
delete CALL_ENV.MUSTERD;

/** The loader this process runs under, so the daemon child loads `.mts` the same way. */
function loaderArgs(): string[] {
	const args: string[] = [];
	for (let at = 0; at < process.execArgv.length; at++) {
		if (process.execArgv[at] === "--import" && process.execArgv[at + 1] !== undefined) args.push("--import", process.execArgv[at + 1] as string);
	}
	return args.length > 0 ? args : ["--import", join(AGENT_DIR, "node_modules/tsx/dist/loader.mjs")];
}

/**
 * Start `scripts/musterd.mts` for `dir` in its own process, as the live service does, and wait until it
 * answers: a daemon on this process's event loop would be measured through `spawn`'s own scheduling.
 */
async function startDaemonProcess(dir: string, socket: string): Promise<ChildProcess> {
	const child = spawn(process.execPath, [...loaderArgs(), join(AGENT_DIR, "scripts", "musterd.mts")], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...CALL_ENV, MUSTER_LEDGER_DIR: dir },
	});
	let output = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	const deadline = Date.now() + 15_000;	for (;;) {
		const client = createClient(socket, { timeoutMs: 500 });
		try {
			await client.request("events", {});
			return child;
		} catch {
			// Not listening yet, or already gone.
		} finally {
			client.close();
		}
		if (child.exitCode !== null || child.signalCode !== null) throw new Error(`musterd exited before its socket was ready: ${output}`);
		if (Date.now() > deadline) throw new Error(`musterd did not listen within 15 s: ${output}`);
		await delay(50);
	}
}

function flag(name: string): string | undefined {
	const at = process.argv.indexOf(name);
	return at >= 0 ? process.argv[at + 1] : undefined;
}

const calls = Number(flag("--calls") ?? "200");
const timeoutMs = Number(flag("--timeout") ?? String(HOOK_TIMEOUT_MS));
const bundleFlag = flag("--bundle");
const legacyCmd = flag("--legacy-cmd");
const logPath = flag("--log");

function line(text: string): void {
	const stamped = `${new Date().toISOString()} ${text}`;
	process.stdout.write(`${stamped}\n`);
	if (logPath !== undefined) appendFileSync(logPath, `${stamped}\n`);
}

function percentile(sorted: number[], fraction: number): number {
	const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
	return Number((sorted[at] ?? 0).toFixed(1));
}

function report(label: string, samples: number[]): { p50: number; p99: number } {
	const sorted = [...samples].sort((left, right) => left - right);
	const p50 = percentile(sorted, 0.5);
	const p99 = percentile(sorted, 0.99);
	line(`LC3 latency: ${label} p50=${p50}ms p99=${p99}ms min=${sorted[0] ?? 0}ms max=${sorted.at(-1) ?? 0}ms n=${sorted.length}`);
	return { p50, p99 };
}

/** The bundle's own entry: one synchronous call, the hook's shape (a hook cannot await). */
function entrySource(): string {
	return [
		`import { requestSync } from ${JSON.stringify(fileURLToPath(new URL("./client-sync.ts", import.meta.url)))};`,
		"const [, , socket, budget] = process.argv;",
		`const record = requestSync(socket, "casRead", { store: "latency", id: "read" }, { timeoutMs: Number(budget) });`,
		"process.stdout.write(`${JSON.stringify(record ?? null)}\\n`);",
	].join("\n");
}

/** One hook call, exactly as Claude Code makes it: a fresh process, the payload on stdin when one is given. */
async function timeCall(command: string, args: string[], input?: string): Promise<{ ms: number; code: number }> {
	const started = Date.now();
	const child = spawn(command, args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], env: CALL_ENV });
	if (input !== undefined) child.stdin?.end(input);
	let stderr = "";
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const code = await new Promise<number>((resolve) => child.on("close", (value) => resolve(value ?? -1)));
	const ms = Date.now() - started;
	if (code !== 0) line(`LC3 latency: a call exited ${String(code)} in ${ms}ms: ${stderr.trim().split("\n").slice(0, 4).join(" | ").slice(0, 400)}`);
	return { ms, code };
}

const dir = mkdtempSync(join(tmpdir(), "muster-lc3-latency-"));
const socket = join(dir, "ledger.sock");
const daemon = await startDaemonProcess(dir, socket);
let verdict = 0;
try {
	const seed = createClient(socket);
	await seed.request("casUpdate", { store: "latency", id: "read", expectedRevision: undefined, record: { ready: true } });
	seed.close();
	const bundle = bundleFlag ?? join(dir, "sync-check.bundle.mjs");
	if (bundleFlag === undefined) {
		await builder.buildSyncBundle({ source: entrySource(), outfile: bundle });
		line(`LC3 latency: bundle built at ${bundle}`);
	}
	// One warm-up call at the default budget: it proves the bundle reaches the daemon before anything is timed.
	// A bundle that could not would `MusterdUnreachable` in every timed call and read as latency instead of as a failure.
	const warmup = await timeCall(process.execPath, [bundle, socket, "2000"]);
	if (warmup.code !== 0) {
		line(`LC3 latency: FAIL the warm-up call exited ${warmup.code} after ${warmup.ms}ms`);
		verdict = 1;
	} else {
		line(`LC3 latency: warm-up call ${warmup.ms}ms`);
		const baseline: number[] = [];
		for (let call = 0; call < BASELINE_CALLS; call++) baseline.push((await timeCall(process.execPath, ["-e", ""])).ms);
		const baselineReport = report("bare node start", baseline);
		const samples: number[] = [];
		for (let call = 0; call < calls; call++) samples.push((await timeCall(process.execPath, [bundle, socket, String(timeoutMs)])).ms);
		const measured = report("ledger sync bundle", samples);
		line(`LC3 latency: bundle adds p50=${Number((measured.p50 - baselineReport.p50).toFixed(1))}ms p99=${Number((measured.p99 - baselineReport.p99).toFixed(1))}ms over a bare node start`);
		line(`LC3 latency: DL6 timeout = 3 x bundle p99 = ${Math.ceil(measured.p99) * 3}ms (HOOK_TIMEOUT_MS lives in client.ts)`);
		// Today's path: measured in this run when the operator names its command, else the recorded p99 (LC3-R1).
		let todayP99 = TODAYS_PATH_MS;
		let todayLabel = `recorded today's path p99 ${TODAYS_PATH_MS}ms`;
		if (legacyCmd !== undefined) {
			const legacy: number[] = [];
			for (let call = 0; call < calls; call++) legacy.push((await timeCall("bash", ["-lc", legacyCmd], HOOK_PAYLOAD)).ms);
			todayP99 = report("today's path", legacy).p99;
			todayLabel = `today's path p99 ${todayP99}ms measured in this run`;
		}
		const bound = todayP99 + TOLERANCE_MS;
		line(`LC3 latency: pass rule (LC3-R1) bundle p99 <= ${todayLabel} + ${TOLERANCE_MS}ms = ${bound}ms`);
		if (measured.p99 > bound) {
			line(`LC3 latency: FAIL bundle p99 ${measured.p99}ms exceeds ${bound}ms`);
			verdict = 1;
		} else {
			line(`LC3 latency: PASS bundle p99 ${measured.p99}ms <= ${bound}ms`);
		}
	}
} finally {
	daemon.kill("SIGTERM");
	await new Promise<void>((resolve) => {
		if (daemon.exitCode !== null || daemon.signalCode !== null) resolve();
		else daemon.once("close", () => resolve());
	});
	rmSync(dir, { recursive: true, force: true });
}
if (logPath !== undefined) line(`LC3 latency: log ${logPath}`);
// Never `process.exit`: it does not flush a final write to a pipe (LC0-R3), and a hidden verdict is worse than a slow exit.
process.exitCode = verdict;
