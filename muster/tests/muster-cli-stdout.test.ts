/**
 * `muster` on a pipe — LC0-R3, F2 of `plans/muster-autonomy/ledger-cutover-facts-2026-10-16.md`.
 *
 * A verb that prints more than a pipe buffer's worth of output must deliver all
 * of it. `process.stdout` is asynchronous when it is a pipe, and `process.exit()`
 * drops whatever libuv has not flushed yet (Node's own caveat), so
 * `muster lanes --json` lost its tail whenever the directory was large enough:
 * redirected to a file the same run wrote 116 974 bytes, through a pipe 65 536
 * bytes, and the consumer failed with "Unterminated string" at char ~65 371
 * (2026-10-17). 65 536 is the pipe capacity: the first write fills it, the rest
 * is queued, and the exit drops the queue.
 *
 * The reader starts late on purpose (`sleep 10` before `cat`), so nothing drains
 * while the verb writes; the verb's own start is several seconds of tsx, so a
 * reader that drained from the start could let libuv flush between chunks and
 * hide the truncation.
 *
 * The cards are rewritten while the verb runs, as F2 described, though neither a
 * torn read (the writer is atomic — `writeLaneCard` writes a temp file and
 * renames it) nor churn is what the failure needed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { writeLaneCard, type LaneCard } from "../lib/lane-card.ts";
import { harnessRoot } from "../../core/harness-paths.ts";
import { musterLauncher } from "../../core/pi-ports.ts";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = musterLauncher();
const HARNESS_ROOT = harnessRoot(import.meta.url);
/** Enough rows that the JSON view is twice the 64 KiB pipe capacity or more. */
const CARD_COUNT = 300;
/** Longer than the verb's own start (seconds of tsx compile), so the pipe stays full while it writes. */
const READER_DELAY_SECONDS = 10;

/** A temp installation: cards under PI_MUSTER_STATE_DIR, no other harness CLI on PATH. */
function tempInstall(): { state: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "muster-cli-stdout-"));
	const state = join(root, "state", "muster");
	const bin = join(root, "bin");
	mkdirSync(bin, { recursive: true });
	symlinkSync("/usr/bin/bash", join(bin, "bash"));
	symlinkSync(process.execPath, join(bin, "node"));
	const env = {
		PI_MUSTER_STATE_DIR: state,
		HOME: join(root, "home"),
		PI_LANES_SYSTEM_EVIDENCE: "off",
		PI_LANES_TMUX_SESSION: "muster-cli-stdout-nosuch",
		PATH: `${bin}:/usr/bin:${dirname(process.execPath)}`,
	};
	return { state, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function card(state: string, laneId: string): void {
	const now = Date.now();
	writeLaneCard(state, {
		laneId,
		harness: "pi",
		cwd: "/tmp/lane",
		branch: null,
		state: "idle",
		model: null,
		thinking: null,
		since: now,
		updatedAt: now,
		wall: null,
	} as LaneCard);
}

/** Run `muster --json lanes` through a shell pipeline whose consumer is not draining yet. */
function runLanesThroughLateReader(env: NodeJS.ProcessEnv, outFile: string): Promise<number | null> {
	const script = `"${LAUNCHER}" --json lanes 2>"${outFile}.err" | { sleep ${READER_DELAY_SECONDS}; cat; } > "${outFile}"`;
	return new Promise((resolvePromise, reject) => {
		const child = spawn("/usr/bin/bash", ["-c", script], { cwd: HARNESS_ROOT, env: { ...process.env, ...env } });
		child.once("error", reject);
		child.once("exit", (code) => resolvePromise(code));
	});
}

test("lanes --json arrives whole through a pipe when the reader starts late", async () => {
	const fx = tempInstall();
	let churned = 0;
	let interval: NodeJS.Timeout | undefined;
	try {
		for (let index = 0; index < CARD_COUNT; index += 1) card(fx.state, `pi-stdout-${index}`);
		// Live churn: cards are rewritten while the verb reads the directory.
		interval = setInterval(() => {
			card(fx.state, `pi-stdout-${churned % CARD_COUNT}`);
			churned += 1;
		}, 5);

		const outFile = join(fx.state, "..", "lanes.json");
		let code: number | null;
		try {
			code = await runLanesThroughLateReader(fx.env, outFile);
		} finally {
			clearInterval(interval);
		}
		assert.equal(code, 0, readFileSync(`${outFile}.err`, "utf8"));

		const stdout = readFileSync(outFile, "utf8");
		let rows: Array<{ laneId: string }>;
		try {
			rows = JSON.parse(stdout) as Array<{ laneId: string }>;
		} catch (error) {
			assert.fail(`stdout was not whole JSON: ${Buffer.byteLength(stdout)} bytes, ${error instanceof Error ? error.message : String(error)}`);
		}
		assert.equal(rows.length, CARD_COUNT, `every card is a row (${Buffer.byteLength(stdout)} bytes of stdout)`);
	} finally {
		if (interval !== undefined) clearInterval(interval);
		fx.cleanup();
	}
});
