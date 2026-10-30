/**
 * The launch recipe against a real tmux server (2026-10-08).
 *
 * F1: a launch when the tmux session does not exist (its last window was closed)
 * creates the session with the lane as its first window instead of failing with
 * "can't find session". F2: the lane store holds `{sessionId, harness}` rows; the
 * reader must pass the row's session id on, not the whole row.
 *
 * The tmux server is private to the test (TMUX_TMPDIR), so no real session is touched.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { labInstallEnv, liveLaunchRecordGuard } from "./lane-state-lab.ts";
import { fileURLToPath } from "node:url";
import { harnessRoot } from "../../core/harness-paths.ts";
import { poolConfigPath } from "../../routing/provider-pool.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);
const RECIPE = join(HARNESS_ROOT, "muster", "scripts", "pi-lane-launch.sh");
const SESSION = "pilane-test";
const liveRecords = liveLaunchRecordGuard();
after(() => liveRecords.assertUntouched());
// The shipped pi lane default (provider-pool.json laneDefaults, first candidate), which the recipe resolves when
// no --model is given and no provider is walled. Read from the shipped file so a deliberate reorder (the operator
// 2026-10-15, 6260227a: z.ai GLM 5.3 Flash first) does not leave a second copy behind.
const PI_MODEL = (JSON.parse(readFileSync(poolConfigPath(), "utf8")) as { laneDefaults: { pi: { candidates: string[] } } }).laneDefaults.pi.candidates[0]!;

type Lab = { dir: string; env: NodeJS.ProcessEnv; store: string };

function withLab(run: (lab: Lab) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "pi-lane-launch-"));
	const fakePi = join(dir, "fake-pi.sh");
	// Records the arguments it was started with, per lane, then stays up like a session would.
	writeFileSync(fakePi, '#!/bin/sh\nprintf "%s\\n" "$@" > "' + dir + '/argv-$CONCORD_AGENT_ID"\nexec sleep 120\n');
	chmodSync(fakePi, 0o755);
	const store = join(dir, "pi-lanes.json");
	const env: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: dir, PI_BIN: fakePi, PI_LANES_TMUX_SESSION: SESSION, PI_LANES_JSON: store, ...labInstallEnv(dir) };
	delete env["TMUX"];
	try {
		run({ dir, env, store });
	} finally {
		spawnSync("tmux", ["kill-server"], { env, stdio: "ignore" });
		rmSync(dir, { recursive: true, force: true });
	}
}

function launch(lab: Lab, ...args: string[]): string {
	const result = spawnSync(RECIPE, ["--lane", ...args, "--cwd", lab.dir, "--verify-seconds", "1", "--title", "A session lane", "--no-goal"], { encoding: "utf8", timeout: 60_000, env: lab.env });
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	assert.equal(result.status, 0, `recipe exit ${result.status}: ${output.slice(0, 400)}`);
	return output;
}

const windows = (lab: Lab): string[] => spawnSync("tmux", ["list-windows", "-t", `=${SESSION}`, "-F", "#{window_name}"], { encoding: "utf8", env: lab.env }).stdout.split("\n").filter(Boolean);
const argvOf = (lab: Lab, lane: string): string[] => readFileSync(join(lab.dir, `argv-${lane}`), "utf8").split("\n").filter(Boolean);

test("a launch creates the tmux session when it does not exist, and a second lane joins it", { skip: spawnSync("tmux", ["-V"]).status !== 0 }, () => {
	withLab((lab) => {
		assert.deepEqual(windows(lab), [], "no session yet");
		const first = launch(lab, "lane-one", "--session", "sess-1");
		assert.match(first, /tmux session pilane-test does not exist; creating it/);
		assert.deepEqual(windows(lab), ["lane-one"]);
		assert.deepEqual(argvOf(lab, "lane-one"), ["--session-id", "sess-1", "--name", "lane-one", "--model", PI_MODEL]);
		launch(lab, "lane-two", "--session", "sess-2");
		assert.deepEqual(windows(lab).sort(), ["lane-one", "lane-two"]);
	});
});

test("the session id comes out of a {sessionId, harness} store row, and out of a bare id from before", { skip: spawnSync("tmux", ["-V"]).status !== 0 }, () => {
	withLab((lab) => {
		writeFileSync(lab.store, JSON.stringify({ "row-lane": { sessionId: "bfc38c4b-1111", harness: "pi" }, "bare-lane": "0a0a0a0a-2222" }));
		launch(lab, "row-lane");
		assert.deepEqual(argvOf(lab, "row-lane"), ["--session-id", "bfc38c4b-1111", "--name", "row-lane", "--model", PI_MODEL]);
		launch(lab, "bare-lane");
		assert.deepEqual(argvOf(lab, "bare-lane"), ["--session-id", "0a0a0a0a-2222", "--name", "bare-lane", "--model", PI_MODEL]);
		// The store keeps the row shape and the id it had.
		const store = JSON.parse(readFileSync(lab.store, "utf8")) as Record<string, { sessionId: string; harness: string }>;
		assert.deepEqual(store["row-lane"], { sessionId: "bfc38c4b-1111", harness: "pi" });
		assert.equal(store["bare-lane"]?.sessionId, "0a0a0a0a-2222");
		assert.ok(existsSync(lab.store));
	});
});

test("every harness defaults its Concord workspace to the shared agent dir; --repo-root-own and --repo-root override it", () => {
	withLab((lab) => {
		const dry = (...args: string[]): string => {
			const result = spawnSync(RECIPE, ["--lane", "root-lane", "--cwd", lab.dir, "--dry-run", ...args], { encoding: "utf8", timeout: 60_000, env: lab.env });
			assert.equal(result.status, 0, `dry run exit ${result.status}: ${(result.stderr ?? "").slice(0, 300)}`);
			return `${result.stdout}${result.stderr}`;
		};
		const shared = join(process.env["HOME"] ?? "", ".pi", "agent");
		const env = lab.env;
		delete env["PI_LANES_REPO_ROOT"];
		// The dry run prints "(cwd <dir>, CONCORD_AGENT_ID=<lane>, CONCORD_REPO_ROOT=<root>)".
		const rootOf = (output: string): string | undefined => /CONCORD_REPO_ROOT=([^)\s]+)\)/.exec(output)?.[1];
		assert.equal(rootOf(dry("--harness", "opencode")), shared);
		assert.equal(rootOf(dry("--harness", "pi")), shared);
		assert.equal(rootOf(dry("--harness", "opencode", "--repo-root-own")), lab.dir);
		assert.equal(rootOf(dry("--harness", "opencode", "--repo-root", "/tmp/elsewhere")), "/tmp/elsewhere");
	});
});
