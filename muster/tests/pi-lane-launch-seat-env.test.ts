/**
 * A seat credential never reaches a lane (seat1, 2026-10-23).
 *
 * `claude --bg` hands the job to the running Claude daemon, which spawns every session from its own
 * environment, and a daemon that is not running is started on demand by the first `claude --bg`, with that
 * caller's environment as the baseline for every later session. A launch from the orchestrator's shell
 * (which carries MUSTER_SEAT, MUSTER_SEAT_TOKEN and MUSTER_SEAT_EPOCH) therefore made every later lane and
 * re-hosted session the orchestrator. Every launcher scrubs the three names; the owner of the names is
 * `lib/seat-env.ts`.
 *
 * `claude agents --json` reads the job files: in a throwaway HOME it listed a job and started no daemon, while
 * `claude --bg` in the same HOME started one that took the client's environment (seat1, 2026-10-24). The table
 * reads carry no seat credential either, so a Claude release that lets them start a daemon cannot repeat the leak.
 *
 * The launch tests use a fake `claude` and a private tmux server with a fake `pi`, and record names only.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readClaudeTableStrict } from "../lane-lifecycle-ports.ts";
import { runClaudeCli } from "../lib/claude-lane-card.ts";
import { readClaudeAgentsJson } from "../lib/lane-directory.ts";
import { SEAT_ENV_NAMES, withoutSeatCredential } from "../lib/seat-env.ts";
import { makeBrief } from "./lane-brief-fixture.ts";
import { labInstallEnv, liveLaunchRecordGuard } from "./lane-state-lab.ts";
import { harnessRoot } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);
const RECIPE = join(HARNESS_ROOT, "muster", "scripts", "pi-lane-launch.sh");
// The launcher moved into muster's package (OL12-D8): Pi's path is the wrapper
// that execs it, and the launcher's own source lives in the package.
const LAUNCHER_SOURCE = join(HARNESS_ROOT, "muster", "scripts", "pi-lane-launch.sh");
const liveRecords = liveLaunchRecordGuard();
after(() => liveRecords.assertUntouched());
const HAS_TMUX = spawnSync("tmux", ["-V"]).status === 0;
const MODEL = "command-code/deepseek/deepseek-v4.1-flash";

/** The heavy gate keeps its launch stamp and log in the live state dir unless told otherwise; a lab launch must not move them. */
const gateLab = (dir: string): NodeJS.ProcessEnv => ({ HEAVY_GATE_LAST: join(dir, "gate.last"), HEAVY_GATE_PAUSED_FILE: join(dir, "gate-paused"), HEAVY_GATE_UNITS_CMD: "true", HEAVY_GATE_LOG: join(dir, "gate.log"), HEAVY_GATE_REFUSED_STATE_DIR: join(dir, "gate-refused") });

/** Fake values: the tests never see a real credential. */
const SEAT_HOLDER_ENV: NodeJS.ProcessEnv = { MUSTER_SEAT: "orchestrator", MUSTER_SEAT_TOKEN: "s3.fakefakefakefakefakefake", MUSTER_SEAT_EPOCH: "3" };

/** Prints the names (never the values) of the seat variables and the lane identity the process was started with. */
const NAMES_SCRIPT = [
	"for name in MUSTER_SEAT MUSTER_SEAT_TOKEN MUSTER_SEAT_EPOCH CONCORD_AGENT_ID CONCORD_REPO_ROOT; do",
	'  eval "value=\\${$name+set}"',
	'  [ -n "$value" ] && printf "%s " "$name"',
	"done",
	"echo",
].join("\n");

test("the seat variable names are one list: seat-env.ts and the launcher's scrub agree", () => {
	assert.deepEqual([...SEAT_ENV_NAMES], ["MUSTER_SEAT", "MUSTER_SEAT_TOKEN", "MUSTER_SEAT_EPOCH"]);
	const script = readFileSync(LAUNCHER_SOURCE, "utf8");
	const scrub = /^SEAT_SCRUB=\(env((?: -u [A-Z_]+)+)\)$/m.exec(script);
	assert.ok(scrub, "the launcher defines SEAT_SCRUB=(env -u NAME ...)");
	assert.deepEqual([...(scrub[1] ?? "").matchAll(/-u ([A-Z_]+)/g)].map((match) => match[1]), [...SEAT_ENV_NAMES]);
	const adopt = readFileSync(join(piAgentDir(), "scripts", "lane-adopt-cgroup.sh"), "utf8");
	const adoptScrub = /\benv((?: -u [A-Z_]+)+) claude agents --json/.exec(adopt);
	assert.ok(adoptScrub, "lane-adopt-cgroup.sh reads the table through `env -u NAME ... claude agents --json`");
	assert.deepEqual([...(adoptScrub[1] ?? "").matchAll(/-u ([A-Z_]+)/g)].map((match) => match[1]), [...SEAT_ENV_NAMES]);
});

test("withoutSeatCredential drops the three seat names and keeps everything else", () => {
	const given: NodeJS.ProcessEnv = { ...SEAT_HOLDER_ENV, CONCORD_REPO_ROOT: "/repo", PATH: "/bin" };
	const clean = withoutSeatCredential(given);
	assert.deepEqual(Object.keys(clean).sort(), ["CONCORD_REPO_ROOT", "PATH"]);
	assert.equal(given["MUSTER_SEAT_TOKEN"], SEAT_HOLDER_ENV["MUSTER_SEAT_TOKEN"], "the caller's environment is not changed");
});

test("claude: a launch from a seat holder's shell hands the daemon no seat credential and no lane id (S6: the job record names a Claude lane)", () => {
	const dir = mkdtempSync(join(tmpdir(), "seat-env-claude-"));
	const fixture = makeBrief();
	try {
		const bin = join(dir, "bin");
		mkdirSync(bin);
		const cwd = join(dir, "worktree");
		mkdirSync(cwd);
		const seen = join(dir, "seen.txt");
		const seenAgents = join(dir, "seen-agents.txt");
		const names = join(dir, "names.sh");
		writeFileSync(names, `${NAMES_SCRIPT}\n`);
		const fakeClaude = join(bin, "claude");
		writeFileSync(
			fakeClaude,
			["#!/bin/sh", `if [ "$1" = "agents" ]; then sh "${names}" >> "${seenAgents}"; echo "[]"; exit 0; fi`, `sh "${names}" >> "${seen}"`, "printf 'backgrounded · deadbeef · lane\\n'", ""].join("\n"),
		);
		chmodSync(fakeClaude, 0o755);
		// The launching shell carries another lane's id, as the orchestrator's does (the daemon baseline, `pb3fix`).
		const env: NodeJS.ProcessEnv = { ...process.env, ...SEAT_HOLDER_ENV, CONCORD_AGENT_ID: "pb3fix", PATH: `${bin}:${process.env.PATH}`, PI_LANES_JSON: join(dir, "pi-lanes.json"), PI_CLAUDE_BUS_PLUGIN_DIR: join(dir, "no-plugin"), ...labInstallEnv(dir), ...gateLab(dir) };
		const result = spawnSync(RECIPE, ["--harness", "claude", "--lane", "cc-seat", "--cwd", cwd, "--brief", fixture.path, "--title", "A seat-scrub lane", "--no-goal"], { encoding: "utf8", timeout: 30_000, env });
		assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
		assert.ok(existsSync(seen), "the fake claude was called");
		assert.deepEqual(readFileSync(seen, "utf8").trim().split(/\s+/), ["CONCORD_REPO_ROOT"], "only the repo root travels: no lane id (the job record names the lane) and no MUSTER_SEAT name");
		assert.ok(existsSync(seenAgents), "the launcher read the table before it started the lane");
		const tableReaders = readFileSync(seenAgents, "utf8").trim().split(/\s+/);
		assert.deepEqual(tableReaders.filter((name) => (SEAT_ENV_NAMES as readonly string[]).includes(name)), [], "the live-name check and every muster call the launcher makes read the table with no seat credential");
	} finally {
		fixture.remove();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("claude: muster's own claude calls (resume, stop, agents) carry no seat credential", () => {
	const dir = mkdtempSync(join(tmpdir(), "seat-env-cli-"));
	const savedPath = process.env["PATH"];
	const saved = Object.fromEntries(SEAT_ENV_NAMES.map((name) => [name, process.env[name]]));
	try {
		const fakeClaude = join(dir, "claude");
		writeFileSync(fakeClaude, ["#!/bin/sh", NAMES_SCRIPT, ""].join("\n"));
		chmodSync(fakeClaude, 0o755);
		process.env["PATH"] = `${dir}:${savedPath}`;
		Object.assign(process.env, SEAT_HOLDER_ENV);
		const run = runClaudeCli(["--bg", "--resume", "x"], { timeoutMs: 10_000 });
		assert.equal(run.status, 0, run.stderr);
		assert.equal(run.stdout.trim(), "", `the child saw: ${run.stdout}`);
	} finally {
		process.env["PATH"] = savedPath;
		for (const name of SEAT_ENV_NAMES) {
			if (saved[name] === undefined) delete process.env[name];
			else process.env[name] = saved[name];
		}
		rmSync(dir, { recursive: true, force: true });
	}
});

test("pi: a lane window started from a seat holder's shell carries no seat credential", { skip: !HAS_TMUX }, () => {
	const dir = mkdtempSync(join(tmpdir(), "seat-env-pi-"));
	try {
		const seen = join(dir, "seen.txt");
		const fakePi = join(dir, "fake-pi.sh");
		writeFileSync(fakePi, ["#!/bin/sh", `{`, NAMES_SCRIPT, `} > "${seen}"`, "exec sleep 30", ""].join("\n"));
		chmodSync(fakePi, 0o755);
		const bin = join(dir, "bin");
		mkdirSync(bin);
		// No user systemd manager: the pane command is the bare harness, which is the shape under test.
		writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nexit 1\n");
		chmodSync(join(bin, "systemctl"), 0o755);
		const env: NodeJS.ProcessEnv = { ...process.env, ...SEAT_HOLDER_ENV, TMUX_TMPDIR: dir, PI_BIN: fakePi, PI_LANES_TMUX_SESSION: "seat-env", PI_LANES_JSON: join(dir, "pi-lanes.json"), ...labInstallEnv(dir), ...gateLab(dir), PATH: `${bin}:${process.env.PATH}` };
		delete env["TMUX"];
		try {
			const result = spawnSync(RECIPE, ["--lane", "pi-seat", "--model", MODEL, "--cwd", dir, "--verify-seconds", "2", "--title", "A seat-scrub lane", "--no-goal"], { encoding: "utf8", timeout: 60_000, env });
			assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
			assert.ok(existsSync(seen), "the fake pi ran");
			assert.deepEqual(readFileSync(seen, "utf8").trim().split(/\s+/), ["CONCORD_AGENT_ID", "CONCORD_REPO_ROOT"]);
		} finally {
			spawnSync("tmux", ["kill-server"], { env, stdio: "ignore" });
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** A fake `claude` first on PATH that records which seat names (and the lane id) each call was started with, and answers an empty table. */
function withFakeClaudeTable<T>(dir: string, run: (seenFile: string) => T): T {
	const seen = join(dir, "seen.txt");
	const names = join(dir, "names.sh");
	writeFileSync(names, `${NAMES_SCRIPT}\n`);
	const fakeClaude = join(dir, "claude");
	writeFileSync(fakeClaude, ["#!/bin/sh", `sh "${names}" >> "${seen}"`, "echo '[]'", ""].join("\n"));
	chmodSync(fakeClaude, 0o755);
	const savedPath = process.env["PATH"];
	const saved = Object.fromEntries(SEAT_ENV_NAMES.map((name) => [name, process.env[name]]));
	try {
		process.env["PATH"] = `${dir}:${savedPath}`;
		Object.assign(process.env, SEAT_HOLDER_ENV);
		return run(seen);
	} finally {
		process.env["PATH"] = savedPath;
		for (const name of SEAT_ENV_NAMES) {
			if (saved[name] === undefined) delete process.env[name];
			else process.env[name] = saved[name];
		}
	}
}

const namesSeen = (file: string): string[] => (existsSync(file) ? readFileSync(file, "utf8").trim().split(/\s+/).filter((name) => name !== "") : ["<the fake claude was never called>"]);

test("claude: a close reads the table (`claude agents --json`) with no seat credential", () => {
	const dir = mkdtempSync(join(tmpdir(), "seat-env-table-"));
	try {
		withFakeClaudeTable(dir, (seen) => {
			const table = readClaudeTableStrict();
			assert.equal(table.ok, true, JSON.stringify(table));
			assert.deepEqual(namesSeen(seen), []);
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("claude: the lane directory reads `claude agents --json` with no seat credential, and with the HOME it was given", () => {
	const dir = mkdtempSync(join(tmpdir(), "seat-env-dir-"));
	try {
		withFakeClaudeTable(dir, (seen) => {
			assert.deepEqual(readClaudeAgentsJson({ home: join(dir, "home") }), []);
			assert.deepEqual(namesSeen(seen), []);
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("claude: `muster lanes` from a seat holder's shell starts no `claude agents` with the credential (whole path)", () => {
	const dir = mkdtempSync(join(tmpdir(), "seat-env-lanes-"));
	try {
		const seen = join(dir, "seen.txt");
		const names = join(dir, "names.sh");
		writeFileSync(names, `${NAMES_SCRIPT}\n`);
		const bin = join(dir, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "claude"), ["#!/bin/sh", `sh "${names}" >> "${seen}"`, "echo '[]'", ""].join("\n"));
		chmodSync(join(bin, "claude"), 0o755);
		const env: NodeJS.ProcessEnv = { ...process.env, ...SEAT_HOLDER_ENV, PATH: `${bin}:${process.env.PATH}`, ...labInstallEnv(dir) };
		const result = spawnSync(join(piAgentDir(), "extensions", "muster", "launchers", "muster"), ["lanes"], { encoding: "utf8", timeout: 60_000, env });
		assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
		assert.deepEqual(namesSeen(seen), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
