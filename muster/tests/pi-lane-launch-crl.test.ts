import "./muster-test-isolation.ts";
/**
 * CRL: the launch standard — blueprint R7 D27, D28, CRL 1 to 6.
 *
 * 1. A new worker lane without `--title` is refused before anything starts (exit 3, no process, no
 *    record), on the harness whose process this file can see start: Claude. A title of 2 or 81
 *    characters, or one with a newline, is refused the same way.
 * 2. A `--conversation` session needs no title and no goal, and a relaunch of a lane that already has
 *    a live record needs neither: those are `recordLaunch`'s own rules, checked here at the launcher.
 * 3. An orchestrator launch names exactly one of `--goal` and `--no-goal`; `--goal` with
 *    `--launched-by grokbot` is refused, because a Grokbot lane has no goal writer.
 * 4. `--goal CODE` attaches at the goal's current station, `--goal CODE:station` at the named one, and
 *    a goal that already holds the lane is not attached again. An unknown goal, an unknown station and
 *    a goal with every station finished are refused before anything starts.
 * 5. An attach that fails twice leaves the lane running and exits 4, printing the command to run: a
 *    lost goal link is never silent (the launcher's record write used to swallow it).
 * 6. `--title` reaches the lane record, trimmed, and the janitor's adopt title is a valid one.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { addGoal, fileGoalStore, goalsDir, readGoal } from "../goals.ts";
import { readLaneRecord, validateLaneTitle } from "../lane-lifecycle.ts";
import { janitorAdoptTitle } from "../bin/muster-janitor.mts";
import { makeBrief } from "./lane-brief-fixture.ts";
import { harnessRoot } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
const LAUNCH_SCRIPT = join(HARNESS_ROOT, "muster", "scripts", "pi-lane-launch.sh");
const MUSTER = join(piAgentDir(), "extensions", "muster", "launchers", "muster");

const TITLE_REFUSAL = "a new lane needs --title: what it delivers, in plain words";
const LANE = "crl-qa";

type Lab = { root: string; calls: string; state: string; cwd: string; brief: string; env: NodeJS.ProcessEnv; close: () => void };

/** A lab installation with a fake `claude` on PATH: the launch starts a shell script, never a session. */
function lab(): Lab {
	const root = mkdtempSync(join(tmpdir(), "crl-launch-"));
	const bin = join(root, "bin");
	const cwd = join(root, "worktree");
	mkdirSync(bin);
	mkdirSync(cwd);
	const calls = join(root, "claude-calls.log");
	writeFileSync(
		join(bin, "claude"),
		["#!/bin/sh", `if [ "$1" = "agents" ]; then echo "[]"; exit 0; fi`, `printf 'argv=%s\\n' "$*" >> "${calls}"`, "printf 'backgrounded · deadbeef · lane\\n'", ""].join("\n"),
	);
	chmodSync(join(bin, "claude"), 0o755);
	const state = join(root, "state", "muster");
	mkdirSync(state, { recursive: true });
	// The heavy gate must answer the same on a busy machine as on an idle one: this file launches a lane
	// many times, and a pause flag, a dev-server window or the machine's own pressure is not its subject.
	writeFileSync(join(root, "gate-psi"), "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n");
	writeFileSync(join(root, "gate-meminfo"), `MemAvailable: ${64 * 1024 * 1024} kB\n`);
	mkdirSync(join(root, "gate-slice"));
	const fixture = makeBrief();
	writeFileSync(fixture.path, "# Brief\n\nDo the work.\n");
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		PI_LANES_JSON: join(root, "state", "pi-lanes.json"),
		PI_CLAUDE_BUS_PLUGIN_DIR: join(root, "no-plugin"),
		PI_CODING_AGENT_DIR: root,
		PI_MUSTER_STATE_DIR: state,
		HEAVY_GATE_LAST: join(root, "gate.last"),
		HEAVY_GATE_SPACING: "0",
		HEAVY_GATE_PAUSED_FILE: join(root, "gate-paused"),
		HEAVY_GATE_LOG: join(root, "gate.log"),
		HEAVY_GATE_REFUSED_STATE_DIR: join(root, "gate-refused"),
		HEAVY_GATE_UNITS_CMD: "true",
		HEAVY_GATE_PSI_FILE: join(root, "gate-psi"),
		HEAVY_GATE_MEMINFO_FILE: join(root, "gate-meminfo"),
		HEAVY_GATE_SLICE_DIR: join(root, "gate-slice"),
	};
	// The launch-check must answer as it would for a plain shell, not as the lane that runs this test.
	for (const name of ["CONCORD_AGENT_ID", "MUSTER_SEAT", "MUSTER_SEAT_TOKEN", "MUSTER_SEAT_EPOCH"]) delete env[name];
	return {
		root,
		calls,
		state,
		cwd,
		brief: fixture.path,
		env,
		close: () => {
			fixture.remove();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function launch(l: Lab, args: string[], extra: NodeJS.ProcessEnv = {}): { status: number | null; output: string } {
	const result = spawnSync(LAUNCH_SCRIPT, ["--harness", "claude", "--lane", LANE, "--cwd", l.cwd, "--model", "sonnet", "--brief", l.brief, ...args], {
		encoding: "utf8",
		timeout: 60_000,
		env: { ...l.env, ...extra },
	});
	return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function runMuster(l: Lab, args: string[]): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(MUSTER, args, { encoding: "utf8", timeout: 60_000, cwd: HARNESS_ROOT, env: l.env });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** What the fake claude was asked to start: empty means nothing started. */
function started(l: Lab): string {
	return existsSync(l.calls) ? readFileSync(l.calls, "utf8") : "";
}

/** A goal with two stations, the first one finished, so its current station is `wp2`. */
function goal(l: Lab, code = "AA"): void {
	const store = fileGoalStore(goalsDir(l.state));
	addGoal(
		store,
		{
			code,
			name: "The launch standard",
			sub: "what a launch states",
			project: "pi",
			stations: [
				{ id: "wp1", name: "Title" },
				{ id: "wp2", name: "Goal" },
			],
		},
		{ by: "operator-shell", projectIds: ["pi"] },
	);
	const finished = runMuster(l, ["goals", "finish", code, "wp1"]);
	assert.equal(finished.status, 0, finished.stderr);
}

// ─── 1. The title ────────────────────────────────────────────────────────────

test("a new lane without --title is refused before the process starts, and writes no record", () => {
	const l = lab();
	try {
		const refused = launch(l, []);
		assert.equal(refused.status, 3, refused.output);
		assert.match(refused.output, new RegExp(TITLE_REFUSAL));
		assert.equal(started(l), "", "nothing was started");
		assert.equal(readLaneRecord(l.state, LANE), undefined, "no record for a launch that did not start");
	} finally {
		l.close();
	}
});

test("a title of 2 or 81 characters, or one with a newline, is refused before the process starts", () => {
	const l = lab();
	try {
		const short = launch(l, ["--title", "ab"]);
		assert.equal(short.status, 3, short.output);
		assert.match(short.output, /a lane title must be 3 to 80 characters \(this one is 2\)/);

		const long = launch(l, ["--title", "x".repeat(81)]);
		assert.equal(long.status, 3, long.output);
		assert.match(long.output, /this one is 81/);

		const multiline = launch(l, ["--title", "two\nlines"]);
		assert.equal(multiline.status, 3, multiline.output);
		assert.match(multiline.output, /a lane title must be one line/);

		assert.equal(started(l), "", "nothing was started");
	} finally {
		l.close();
	}
});

test("--title reaches the record, trimmed, and the lane starts", () => {
	const l = lab();
	try {
		const launched = launch(l, ["--title", "  The launch standard  ", "--no-goal"]);
		assert.equal(launched.status, 0, launched.output);
		assert.equal(readLaneRecord(l.state, LANE)?.title, "The launch standard");
		assert.match(started(l), /argv=--bg --name crl-qa/);
	} finally {
		l.close();
	}
});

test("a --conversation lane needs no title and no goal", () => {
	const l = lab();
	try {
		const launched = launch(l, ["--conversation"]);
		assert.equal(launched.status, 0, launched.output);
		const record = readLaneRecord(l.state, LANE);
		assert.equal(record?.kind, "conversation");
		assert.equal(record?.title, undefined);
	} finally {
		l.close();
	}
});

test("a relaunch of a lane that already has a live record needs neither flag and keeps the title", () => {
	const l = lab();
	try {
		assert.equal(launch(l, ["--title", "The launch standard", "--no-goal"]).status, 0);
		const again = launch(l, []);
		assert.equal(again.status, 0, again.output);
		assert.equal(readLaneRecord(l.state, LANE)?.title, "The launch standard");
	} finally {
		l.close();
	}
});

// ─── 2. The goal ─────────────────────────────────────────────────────────────

test("an orchestrator launch names exactly one of --goal and --no-goal", () => {
	const l = lab();
	try {
		const missing = launch(l, ["--title", "The launch standard"]);
		assert.equal(missing.status, 3, missing.output);
		assert.match(missing.output, /names the goal the lane works on/);

		const both = launch(l, ["--title", "The launch standard", "--no-goal", "--goal", "AA"]);
		assert.equal(both.status, 3, both.output);
		assert.match(both.output, /--goal and --no-goal name two different things/);

		assert.equal(started(l), "", "nothing was started");
	} finally {
		l.close();
	}
});

test("--goal is refused with --launched-by grokbot", () => {
	const l = lab();
	try {
		const refused = launch(l, ["--title", "A Grokbot lane", "--goal", "AA", "--launched-by", "grokbot"]);
		assert.equal(refused.status, 3, refused.output);
		assert.match(refused.output, /--goal is refused with --launched-by grokbot/);
		assert.equal(started(l), "", "nothing was started");
	} finally {
		l.close();
	}
});

test("--goal attaches at the current station, --goal CODE:station at the named one, and neither when it already holds the lane", () => {
	const l = lab();
	try {
		goal(l);
		const current = launch(l, ["--title", "The launch standard", "--goal", "AA"]);
		assert.equal(current.status, 0, current.output);
		const attached = readGoal(fileGoalStore(goalsDir(l.state)), "AA");
		assert.deepEqual(attached?.lanes, [{ lane: LANE, station: "wp2" }], "the current station is the first one not finished");

		const named = launch(l, ["--title", "The launch standard", "--goal", "AA:wp1"]);
		assert.equal(named.status, 0, named.output);
		assert.equal(readGoal(fileGoalStore(goalsDir(l.state)), "AA")?.lanes[0]?.station, "wp2", "a goal that holds the lane is not attached again");
	} finally {
		l.close();
	}
});

test("the named station wins when the goal names another one", () => {
	const l = lab();
	try {
		goal(l);
		const launched = launch(l, ["--title", "The launch standard", "--goal", "AA:wp1"]);
		assert.equal(launched.status, 0, launched.output);
		assert.deepEqual(readGoal(fileGoalStore(goalsDir(l.state)), "AA")?.lanes, [{ lane: LANE, station: "wp1" }]);
	} finally {
		l.close();
	}
});

test("an unknown goal, an unknown station and a goal with every station finished are refused before the process starts", () => {
	const l = lab();
	try {
		goal(l);
		const unknown = launch(l, ["--title", "The launch standard", "--goal", "ZZ"]);
		assert.equal(unknown.status, 3, unknown.output);
		assert.match(unknown.output, /no goal ZZ in the goal registry; nothing was started/);

		const station = launch(l, ["--title", "The launch standard", "--goal", "AA:nope"]);
		assert.equal(station.status, 3, station.output);
		assert.match(station.output, /goal AA has no station nope/);

		assert.equal(runMuster(l, ["goals", "finish", "AA", "wp2"]).status, 0);
		const finished = launch(l, ["--title", "The launch standard", "--goal", "AA"]);
		assert.equal(finished.status, 3, finished.output);
		assert.match(finished.output, /every station of goal AA is finished/);

		assert.equal(started(l), "", "nothing was started");
	} finally {
		l.close();
	}
});

// ─── 3. The attach ───────────────────────────────────────────────────────────

test("an attach that fails twice leaves the lane running and exits 4 with the command to run", () => {
	const l = lab();
	try {
		goal(l);
		// The goal store cannot be written: both attach attempts fail.
		const dir = goalsDir(l.state);
		chmodSync(dir, 0o555);
		try {
			const launched = launch(l, ["--title", "The launch standard", "--goal", "AA:wp2"]);
			assert.equal(launched.status, 4, launched.output);
			assert.match(launched.output, /its goal link to AA was not written/);
			assert.match(launched.output, /goals attach AA crl-qa --station wp2/);
			assert.ok(readLaneRecord(l.state, LANE) !== undefined, "the lane ran and kept its record");
			assert.match(started(l), /argv=--bg --name crl-qa/);
		} finally {
			chmodSync(dir, 0o755);
		}
	} finally {
		l.close();
	}
});

test("a record store that cannot be read is unknown, and an unknown phase never refuses a launch", () => {
	const l = lab();
	try {
		// A path that is not a state dir: `lane-record show` answers 1 there, which is neither 0 nor 3, so the
		// phase is unknown. Reading that as "no record" would require a title and a goal the store cannot keep.
		const unreadable = join(l.root, "not-a-state-dir");
		writeFileSync(unreadable, "not a directory\n");
		const launched = launch(l, [], { PI_MUSTER_STATE_DIR: unreadable });
		assert.equal(launched.status, 0, launched.output);
		assert.match(started(l), /argv=--bg --name crl-qa/, "the lane started: an unknown store must not block it");
	} finally {
		l.close();
	}
});

// ─── 4. The janitor's adopt title ────────────────────────────────────────────

test("the janitor's adopt title is a title the record accepts", () => {
	const short = janitorAdoptTitle("crl-qa");
	assert.equal(short, "crl-qa: launched by hand, closed by the janitor");
	assert.ok("title" in validateLaneTitle(short), "the adopt title validates");
	// A long lane name is cut to the record's cap rather than refused.
	const long = janitorAdoptTitle("lane-with-a-name-that-is-long-enough-to-reach-the-eighty-character-cap");
	assert.equal(long.length, 80);
	assert.ok("title" in validateLaneTitle(long), "a cut adopt title still validates: " + JSON.stringify(validateLaneTitle(long)));
});

test("muster lane-record title-check is the owner's verdict, counted the way the record counts", () => {
	const l = lab();
	try {
		const valid = runMuster(l, ["lane-record", "title-check", "--title", "  The launch standard  "]);
		assert.equal(valid.status, 0, valid.stderr);
		assert.equal(valid.stdout.trim(), "The launch standard", "the owner prints the trimmed title");

		const short = runMuster(l, ["lane-record", "title-check", "--title", "ab"]);
		assert.equal(short.status, 3, short.stderr);
		assert.match(short.stderr, /a lane title must be 3 to 80 characters \(this one is 2\)/);

		const empty = runMuster(l, ["lane-record", "title-check", "--title", ""]);
		assert.equal(empty.status, 3, empty.stderr);
		assert.match(empty.stderr, /this one is 0/);

		const multiline = runMuster(l, ["lane-record", "title-check", "--title", "two\nlines"]);
		assert.equal(multiline.status, 3, multiline.stderr);
		assert.match(multiline.stderr, /a lane title must be one line/);

		// An emoji is two UTF-16 units: 78 characters plus one emoji is exactly 80, and 79 plus one is 81.
		const fits = `${"x".repeat(78)}🚀`;
		const fitsOut = runMuster(l, ["lane-record", "title-check", "--title", fits]);
		assert.equal(fitsOut.status, 0, fitsOut.stderr);
		assert.equal(fitsOut.stdout.trim(), fits);

		const over = `${"x".repeat(79)}🚀`;
		const overOut = runMuster(l, ["lane-record", "title-check", "--title", over]);
		assert.equal(overOut.status, 3, overOut.stderr);
		assert.match(overOut.stderr, /this one is 81/, "the owner counts UTF-16 units, so a shell count would disagree");
	} finally {
		l.close();
	}
});

test("a title at the emoji edge is refused by the launcher before anything starts, and the one that fits is stored", () => {
	const l = lab();
	try {
		const over = `${"x".repeat(79)}🚀`;
		const refused = launch(l, ["--title", over, "--no-goal"]);
		assert.equal(refused.status, 3, refused.output);
		assert.match(refused.output, /this one is 81/);
		assert.equal(started(l), "", "nothing was started");

		const fits = `${"x".repeat(78)}🚀`;
		const launched = launch(l, ["--title", fits, "--no-goal"]);
		assert.equal(launched.status, 0, launched.output);
		assert.equal(readLaneRecord(l.state, LANE)?.title, fits);
	} finally {
		l.close();
	}
});
