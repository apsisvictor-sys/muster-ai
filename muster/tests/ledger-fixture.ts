/**
 * A disposable ledger install for a test: a Muster state dir, the ledger dir `musterd` serves from, the real
 * `startDaemon` in its own process (`requestSync` blocks the calling thread in `Atomics.wait`), and the switch
 * file and environment that point the owners at it. Nothing here reads or writes live `state/muster/`.
 * The arrangement is the one `ledger-lc13-send.test.ts` carries; new files use this module.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { backendPath } from "../ledger/backend.ts";
import { harnessRoot, nodeBinary, tsxLoaderPath } from "../../core/harness-paths.ts";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
const NODE = nodeBinary();
const DAEMON = join(HARNESS_ROOT, "muster", "ledger", "daemon.ts");

/** The switch file as the flip tool writes it (LC15). */
export const LEDGER_SWITCH = { backend: "ledger", flipId: "fixture", at: "2026-10-17T00:00:00+03:00", cursor: "1" };

export type LedgerBox = { root: string; stateDir: string; ledgerDir: string; close: () => void };

/** One disposable install: a Muster state dir and the ledger dir `musterd` serves from. */
export function ledgerBox(): LedgerBox {
	const root = mkdtempSync(join(tmpdir(), "muster-fixture-"));
	const stateDir = join(root, "state", "muster");
	const ledgerDir = join(root, "ledger");
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(ledgerDir, { recursive: true });
	return { root, stateDir, ledgerDir, close: () => rmSync(root, { recursive: true, force: true }) };
}

/** Point the owners at the ledger: the switch file, the ledger directory and the state dir they read. Returns the restore. */
export function useLedger(box: LedgerBox, switchFile: Record<string, string> = LEDGER_SWITCH): () => void {
	writeFileSync(backendPath(box.stateDir), JSON.stringify(switchFile));
	const savedLedger = process.env["MUSTER_LEDGER_DIR"];
	const savedState = process.env["PI_MUSTER_STATE_DIR"];
	process.env["MUSTER_LEDGER_DIR"] = box.ledgerDir;
	process.env["PI_MUSTER_STATE_DIR"] = box.stateDir;
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

/** The real `startDaemon` in its own process, killed when the test ends. Resolves once it answers READY, with a handle that stops it early (a test that restarts it on the same directory). */
export function startDaemon(t: TestContext, dir: string): Promise<{ stop: () => Promise<void> }> {
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
	const stop = async (): Promise<void> => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
		child.kill("SIGKILL");
		await exited;
	};
	t.after(stop);
	return (async () => {
		const deadline = Date.now() + 15_000;
		while (!output.includes("READY")) {
			if (child.exitCode !== null || child.signalCode !== null) throw new Error(`the daemon fixture exited before READY: ${output}`);
			if (Date.now() > deadline) throw new Error(`the daemon fixture did not answer within 15 s: ${output}`);
			await delay(25);
		}
		return { stop };
	})();
}
