import "./muster-test-isolation.ts";
/**
 * LC5 at the CLI and the launcher: the registry's one owner, and `muster report`
 * in ledger mode.
 *
 * 1. `muster report` with no daemon, and again with `backend.json` frozen: exit 0,
 *    DL6's sentence, one spool file each.
 * 2. `muster lane-record register|session|unregister` write and read the registry,
 *    and in files mode the bytes on disk are exactly what the launcher's Python
 *    wrote (indent 1, trailing newline, the same merge and the same key order).
 * 3. `scripts/pi-lane-launch.sh --dry-run` prints the `lane-record register` call it
 *    would make instead of writing the store's file itself.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { backendPath } from "../ledger/backend.ts";
import { readSpool } from "../ledger/spool.ts";
import { labInstallEnv } from "./lane-state-lab.ts";
import { harnessRoot } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
const LAUNCHER = join(piAgentDir(), "extensions", "muster", "launchers", "muster");
const RECIPE = join(HARNESS_ROOT, "muster", "scripts", "pi-lane-launch.sh");
const DL6_SENTENCE = /musterd is down; the report is kept and filed when it starts/;
const LEDGER_SWITCH = { backend: "ledger", flipId: "lc5-cli", at: "2026-10-17T00:00:00+03:00", cursor: "1" };
const FROZEN_SWITCH = { backend: "frozen", flipId: "lc5-cli", from: "files", to: "ledger", at: "2026-10-17T00:00:00+03:00" };

type Lab = { root: string; state: string; home: string; registry: string; ledger: string; env: NodeJS.ProcessEnv; close: () => void };

/** A temp installation: the state dir, its own registry path, its own ledger dir, no other CLI on PATH. */
function lab(): Lab {
	const root = mkdtempSync(join(tmpdir(), "muster-lc5-cli-"));
	const state = join(root, "state", "muster");
	const home = join(root, "home");
	const registry = join(root, "state", "pi-lanes.json");
	const ledger = join(root, "ledger");
	const bin = join(root, "bin");
	mkdirSync(state, { recursive: true });
	mkdirSync(home, { recursive: true });
	mkdirSync(ledger, { recursive: true });
	mkdirSync(bin, { recursive: true });
	symlinkSync("/usr/bin/bash", join(bin, "bash"));
	symlinkSync(process.execPath, join(bin, "node"));
	const env: NodeJS.ProcessEnv = {
		PI_MUSTER_STATE_DIR: state,
		PI_LANES_JSON: registry,
		MUSTER_LEDGER_DIR: ledger,
		HOME: home,
		PATH: `${bin}:/usr/bin:${dirname(process.execPath)}`,
	};
	return { root, state, home, registry, ledger, env, close: () => rmSync(root, { recursive: true, force: true }) };
}

function runMuster(l: Lab, args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(LAUNCHER, args, { encoding: "utf8", timeout: 60_000, cwd: HARNESS_ROOT, env: { ...l.env, ...env } });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The Python the launcher wrote a row with, kept here as the byte reference. */
function pythonRegistryBytes(data: Record<string, unknown>): string {
	const result = spawnSync("python3", ["-c", "import json,sys\nsys.stdout.write(json.dumps(json.loads(sys.argv[1]), indent=1) + '\\n')", JSON.stringify(data)], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

test("LC5 CLI: muster report exits 0 with DL6's sentence and one spool file, with no daemon and while frozen", () => {
	const l = lab();
	try {
		writeFileSync(backendPath(l.state), JSON.stringify(LEDGER_SWITCH));
		const first = runMuster(l, ["--agent", "pi-lc5-fixture", "report", "working", "--lane", "lane-a", "--summary", "the report spools", "--json"]);
		assert.equal(first.status, 0, first.stderr);
		assert.match(first.stdout, DL6_SENTENCE);
		assert.equal(readSpool(l.state).length, 1, "no daemon: one spool file");

		writeFileSync(backendPath(l.state), JSON.stringify(FROZEN_SWITCH));
		const second = runMuster(l, ["--agent", "pi-lc5-fixture", "report", "working", "--lane", "lane-b", "--summary", "frozen", "--json"]);
		assert.equal(second.status, 0, second.stderr);
		assert.match(second.stdout, DL6_SENTENCE);
		assert.equal(readSpool(l.state).length, 2, "frozen: one spool file per report");
		assert.equal(existsSync(join(l.state, "lanes", "lane-a.json")), false, "no card file is written in ledger mode");
	} finally {
		l.close();
	}
});

test("LC5 CLI: register, session and unregister go through the owner, and files mode keeps the Python bytes", () => {
	const l = lab();
	try {
		// A row the launcher's Python wrote earlier: a dict with extra keys and a retirement,
		// beside a bare-string row from before 2026-10-08.
		const before = {
			"lane-a": { sessionId: "11111111-1111-4111-8111-111111111111", harness: "pi", retired: true, retiredAt: "2026-10-01T00:00:00Z", extra: 7 },
			"lane-old": "22222222-2222-4222-8222-222222222222",
		};
		writeFileSync(l.registry, pythonRegistryBytes(before));

		assert.equal(runMuster(l, ["lane-record", "session", "lane-old"]).stdout.trim(), "22222222-2222-4222-8222-222222222222");

		const registered = runMuster(l, ["lane-record", "register", "lane-b", "--session", "33333333-3333-4333-8333-333333333333", "--harness", "claude"]);
		assert.equal(registered.status, 0, registered.stderr);
		assert.equal(runMuster(l, ["lane-record", "session", "lane-b"]).stdout.trim(), "33333333-3333-4333-8333-333333333333");

		// Registering again replaces the session, keeps other keys and drops the retirement.
		const again = runMuster(l, ["lane-record", "register", "lane-a", "--session", "44444444-4444-4444-8444-444444444444", "--harness", "pi"]);
		assert.equal(again.status, 0, again.stderr);
		const expected = {
			"lane-a": { sessionId: "44444444-4444-4444-8444-444444444444", harness: "pi", extra: 7 },
			"lane-old": "22222222-2222-4222-8222-222222222222",
			"lane-b": { sessionId: "33333333-3333-4333-8333-333333333333", harness: "claude" },
		};
		assert.equal(readFileSync(l.registry, "utf8"), pythonRegistryBytes(expected), "the bytes are the launcher's Python bytes");

		// The JSON face a reader (night-watch) uses: rows by lane, with the harness and the retirement.
		const listed = runMuster(l, ["lane-record", "registry", "--json"]);
		assert.equal(listed.status, 0, listed.stderr);
		assert.deepEqual(JSON.parse(listed.stdout), {
			"lane-a": { sessionId: "44444444-4444-4444-8444-444444444444", harness: "pi", retired: false },
			"lane-old": { sessionId: "22222222-2222-4222-8222-222222222222", harness: "pi", retired: false },
			"lane-b": { sessionId: "33333333-3333-4333-8333-333333333333", harness: "claude", retired: false },
		});

		const removed = runMuster(l, ["lane-record", "unregister", "lane-b"]);
		assert.equal(removed.status, 0, removed.stderr);
		assert.equal(runMuster(l, ["lane-record", "session", "lane-b"]).stdout, "", "a removed row reads as nothing");
		assert.deepEqual(Object.keys(JSON.parse(readFileSync(l.registry, "utf8")) as Record<string, unknown>), ["lane-a", "lane-old"]);
	} finally {
		l.close();
	}
});

test("LC5 launcher: --dry-run prints the register call it would make", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-lane-lc5-"));
	try {
		const fakePi = join(root, "fake-pi.sh");
		writeFileSync(fakePi, "#!/bin/sh\nexit 0\n");
		chmodSync(fakePi, 0o755);
		const env: NodeJS.ProcessEnv = {
			...process.env,
			TMUX_TMPDIR: root,
			PI_BIN: fakePi,
			PI_LANES_TMUX_SESSION: "pilane-lc5",
			PI_LANES_JSON: join(root, "state", "pi-lanes.json"),
			...labInstallEnv(root),
		};
		delete env["TMUX"];
		const result = spawnSync(
			RECIPE,
			["--lane", "lc5-lane", "--harness", "pi", "--model", "command-code/deepseek/deepseek-v4.1-flash", "--cwd", root, "--session", "55555555-5555-4555-8555-555555555555", "--dry-run"],
			{ encoding: "utf8", timeout: 60_000, env },
		);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /lane-record register lc5-lane --session 55555555-5555-4555-8555-555555555555 --harness pi/);
		assert.equal(existsSync(join(root, "state", "pi-lanes.json")), false, "a dry run writes no registry row");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
