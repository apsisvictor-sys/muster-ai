/**
 * The launch recipe when the lane does not start (2026-10-10).
 *
 * The gateway's `lane_launch` for a Pi lane failed with a bare `exit 1`: the
 * service PATH had no `node`, so `run-custom.sh` died with status 127 inside the
 * 5 s verify window, `verify` hit pipefail on the vanished window and printed
 * nothing, and the lane store kept a row for a session that never ran. These
 * tests run the recipe against a private tmux server with fake lane binaries.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { labInstallEnv, liveLaunchRecordGuard } from "./lane-state-lab.ts";
import { fileURLToPath } from "node:url";
import { harnessRoot, nodeBinary } from "../../core/harness-paths.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);
const RECIPE = join(HARNESS_ROOT, "muster", "scripts", "pi-lane-launch.sh");
const SESSION = "pilane-startup";
const liveRecords = liveLaunchRecordGuard();
after(() => liveRecords.assertUntouched());
// A pool ref: an explicit model outside provider-pool.json is refused (P5-D6), so a fixture
// that only needs to name one uses the pool's own head.
const MODEL = "zai/glm-5.3-flash";
const HAS_TMUX = spawnSync("tmux", ["-V"]).status === 0;
// VR24-187: the isolation check judges the launches this file made, not the live files as a whole.
// Every lane it launches carries this run's own suffix, so a record naming one is attributable to
// this run and a real lane launch by anyone else names none of them (VR24-185 (c)).
const RUN = randomBytes(4).toString("hex");
/** This run's name for a fixture lane. */
const lane = (name: string): string => `${name}-${RUN}`;

/** The live install's gate state: the spacing tap, the gate log and the event log (VR24-185). */
const LIVE_STATE_DIR = join(homedir(), ".pi", "agent", "state");
const LIVE_GATE = {
	last: join(LIVE_STATE_DIR, "heavy-gate.last-lane-launch"),
	log: join(LIVE_STATE_DIR, "heavy-gate.log"),
	events: join(LIVE_STATE_DIR, "orchestrator-events.log"),
};

function readText(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

/** Every line of `text` that names one of `markers`. */
function naming(text: string, markers: string[]): string[] {
	return text.split("\n").filter((line) => markers.some((marker) => line.includes(marker)));
}

/** The lab's own gate files, in one place, so the fixture writes and the checks read the same names. */
function gatePaths(dir: string): GatePaths {
	return { last: join(dir, "heavy-gate.last-lane-launch"), log: join(dir, "heavy-gate.log"), events: join(dir, "orchestrator-events.log") };
}

/**
 * The lab's own heavy-gate state (VR24-185 (a)): the recipe's gate reads and writes these instead
 * of the live install's, so five fake `sleep` lanes in a private tmux server neither space a real
 * lane launch nor get spaced by one. The gate's memory checks and `PI_HEAVY_GATE_OVERRIDE` are
 * untouched: `scripts/heavy-gate.sh` keeps every default.
 */
function gateEnv(lab: Lab): NodeJS.ProcessEnv {
	return {
		HEAVY_GATE_LAST: lab.gate.last,
		HEAVY_GATE_LOG: lab.gate.log,
		HEAVY_GATE_EVENTS_LOG: lab.gate.events,
		HEAVY_GATE_REFUSED_STATE_DIR: lab.dir,
		HEAVY_GATE_PAUSED_FILE: join(lab.dir, "heavy-gate.paused"),
		HEAVY_GATE_SPACING: "0",
	};
}

type GatePaths = { last: string; log: string; events: string };
type Lab = { dir: string; env: NodeJS.ProcessEnv; store: string; gate: GatePaths; launches: string[]; mark: string };

/** One finished lab: the launches it made, and its gate state read before its temp dir went. */
type LabRun = { markers: string[]; mark: string; launches: string[]; paths: GatePaths; log: string; events: string; last: string; lastRecorded: boolean };

const runs: LabRun[] = [];

/**
 * VR24-187's two checks, over files rather than the live install as a whole, so a unit test can
 * hand them a fake one: (1) every launch the lab made landed in the lab's own gate state — the
 * positive proof; (2) no live gate record names this run — the attribution check. A real lane
 * launch during the run names nothing of ours, so it cannot turn either check red.
 */
function attributionViolations(labRuns: LabRun[], live: { gateLog: string; eventsLog: string; lastLaunch: string }): string[] {
	const violations: string[] = [];
	for (const run of labRuns) {
		const lines = run.log.split("\n");
		const admitted = lines.filter((line) => line.includes("admitted kind=lane-launch")).length;
		if (admitted !== run.launches.length) {
			violations.push(`${run.paths.log} holds ${admitted} admitted lane-launch line(s) for ${run.launches.length} launch(es) (${run.launches.join(", ")}): a launch did not land in the lab's own gate state`);
		}
		const refused = [...lines, ...run.events.split("\n")].filter((line) => /refused kind=lane-launch|GATE REFUSAL.*lane-launch/.test(line));
		if (refused.length > 0) violations.push(`${run.paths.log} refused a fixture launch: ${refused[0].trim()}`);
		if (run.launches.length > 0 && !run.lastRecorded) violations.push(`${run.paths.last} was never written: the lab's gate recorded no lane launch`);
		if (run.launches.length > 0 && naming(run.log, [run.mark]).length === 0) violations.push(`${run.paths.log} carries none of the lab's ${run.mark} lines: its launches cannot be attributed to the lab`);
		for (const [where, text] of [["the live gate log", live.gateLog], ["the live events log", live.eventsLog], ["the live last-launch record", live.lastLaunch]] as const) {
			const named = naming(text, run.markers);
			if (named.length > 0) violations.push(`${where} names the fixture's own ${named[0].trim()}`);
		}
	}
	return violations;
}

function withLab(piScript: string, body: (lab: Lab) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "pi-lane-startup-"));
	const fakePi = join(dir, "fake-pi.sh");
	writeFileSync(fakePi, piScript.replaceAll("$DIR", dir));
	chmodSync(fakePi, 0o755);
	const store = join(dir, "pi-lanes.json");
	// A per-lab available value, unique to this run: the gate prints it in every line it writes, so a
	// lab launch that reaches the live gate carries the lab's own mark into the live log (VR24-187).
	const available = 66_000 + (randomBytes(2).readUInt16BE(0) % 1000);
	const meminfo = join(dir, "gate-meminfo-marked");
	writeFileSync(meminfo, `MemAvailable: ${available * 1024} kB\n`);
	const env: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: dir, PI_BIN: fakePi, PI_LANES_TMUX_SESSION: SESSION, PI_LANES_JSON: store, ...labInstallEnv(dir), HEAVY_GATE_MEMINFO_FILE: meminfo };
	delete env["TMUX"];
	const mark = `available=${available}MiB`;
	const lab: Lab = { dir, env, store, gate: gatePaths(dir), launches: [], mark };
	try {
		body(lab);
	} finally {
		spawnSync("tmux", ["kill-server"], { env, stdio: "ignore" });
		// Read before the dir goes: the last test judges the launches this lab made (VR24-187).
		runs.push({
			markers: [dir, lab.mark, ...lab.launches],
			mark: lab.mark,
			launches: [...lab.launches],
			paths: lab.gate,
			log: readText(lab.gate.log),
			events: readText(lab.gate.events),
			last: readText(lab.gate.last),
			lastRecorded: existsSync(lab.gate.last),
		});
		rmSync(dir, { recursive: true, force: true });
	}
}

function launch(lab: Lab, laneName: string, ...args: string[]) {
	// The gate's state goes to the fake lane's own child environment only.
	const env = { ...lab.env, ...gateEnv(lab) };
	lab.launches.push(laneName);
	const result = spawnSync(RECIPE, ["--lane", laneName, "--model", MODEL, "--cwd", lab.dir, "--verify-seconds", "2", "--title", "A startup lane", "--no-goal", ...args], { encoding: "utf8", timeout: 60_000, env });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const windows = (lab: Lab): string[] => spawnSync("tmux", ["list-windows", "-t", `=${SESSION}`, "-F", "#{window_name}"], { encoding: "utf8", env: lab.env }).stdout.split("\n").filter(Boolean);
const rows = (lab: Lab): Record<string, unknown> => (existsSync(lab.store) ? (JSON.parse(readFileSync(lab.store, "utf8")) as Record<string, unknown>) : {});

test("a lane that dies at startup: the dead pane's output reaches stderr, the window is cleaned up and no row is registered", { skip: !HAS_TMUX }, () => {
	withLab('#!/bin/sh\necho startup-marker-line >&2\nexit 127\n', (lab) => {
		const result = launch(lab, lane("dies-lane"));
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /exited within 2s/);
		assert.match(result.stderr, /startup-marker-line/);
		assert.deepEqual(windows(lab), [], "the dead window is not left behind");
		assert.deepEqual(rows(lab), {}, "a launch that never came up registers nothing");
	});
});

test("a window that vanished before verify is reported, not a silent exit 1", { skip: !HAS_TMUX }, () => {
	// A script that kills its own window is gone before verify looks.
	withLab('#!/bin/sh\ntmux kill-window -t "$TMUX_PANE"\nsleep 5\n', (lab) => {
		const result = launch(lab, lane("gone-lane"));
		assert.equal(result.status, 1);
		assert.match(result.stderr, /gone after launch|exited within/);
		assert.deepEqual(rows(lab), {});
	});
});

test("a lane that comes up is registered, and --unregister removes only that row", { skip: !HAS_TMUX }, () => {
	withLab('#!/bin/sh\nexec sleep 30\n', (lab) => {
		assert.equal(launch(lab, lane("up-lane"), "--session", "sess-up").status, 0);
		assert.equal(launch(lab, lane("other-lane"), "--session", "sess-other").status, 0);
		assert.deepEqual(Object.keys(rows(lab)).sort(), [lane("other-lane"), lane("up-lane")]);
		const live = spawnSync(RECIPE, ["--lane", lane("up-lane"), "--unregister"], { encoding: "utf8", env: lab.env });
		assert.equal(live.status, 3, "refused while the lane has a window");
		spawnSync("tmux", ["kill-window", "-t", `=${SESSION}:=${lane("up-lane")}`], { env: lab.env });
		const done = spawnSync(RECIPE, ["--lane", lane("up-lane"), "--unregister"], { encoding: "utf8", env: lab.env });
		assert.equal(done.status, 0, done.stderr);
		assert.deepEqual(Object.keys(rows(lab)), [lane("other-lane")]);
	});
});

const NODE_DIR = ((): string | undefined => {
	for (const candidate of [nodeBinary(), join(homedir(), ".pi", "agent", "bin", "node")]) {
		try {
			return dirname(realpathSync(candidate));
		} catch {
			/* next candidate */
		}
	}
	return undefined;
})();

test("the lane gets the node directory on its PATH even when the launcher and the tmux server have a service PATH", { skip: !HAS_TMUX || NODE_DIR === undefined || ["/usr/bin", "/bin"].includes(NODE_DIR) }, () => {
	withLab('#!/bin/sh\nprintf "%s" "$PATH" > "$DIR/path-$CONCORD_AGENT_ID"\nexec sleep 30\n', (lab) => {
		const narrow = "/usr/bin:/bin";
		const env = { ...lab.env, PATH: narrow };
		// A tmux server that already exists with the narrow PATH, as under a service.
		assert.equal(spawnSync("tmux", ["new-session", "-d", "-s", "keeper", "sleep 60"], { env }).status, 0);
		lab.env = env;
		const result = launch(lab, lane("path-lane"));
		assert.equal(result.status, 0, result.stderr);
		const lanePath = readFileSync(join(lab.dir, `path-${lane("path-lane")}`), "utf8");
		assert.ok(lanePath.split(":").includes(NODE_DIR as string), `lane PATH ${lanePath} lacks ${NODE_DIR}`);
	});
});

// VR24-187: the check has to be red when a fixture launch reaches the live gate, and green when
// someone else launches a real lane during the run. Driving the function over fake files proves
// both directions without the proof itself touching the live install.
test("the isolation check names the fixture's own launches and nothing else", () => {
	const paths: GatePaths = { last: "/lab/heavy-gate.last-lane-launch", log: "/lab/heavy-gate.log", events: "/lab/orchestrator-events.log" };
	const clean: LabRun = {
		markers: ["/lab", lane("up-lane"), "available=66777MiB"],
		mark: "available=66777MiB",
		launches: [lane("up-lane")],
		paths,
		log: "2026-10-26T18:00:00+02:00 admitted kind=lane-launch size=1498MiB available=66777MiB need=7642MiB\n",
		events: "",
		last: "",
		lastRecorded: true,
	};
	const none = { gateLog: "", eventsLog: "", lastLaunch: "" };
	assert.deepEqual(attributionViolations([clean], none), [], "a lab that recorded its one launch is clean");

	// Red: one launch went to the live gate, so the lab's own log is one line short.
	const leaked: LabRun = { ...clean, launches: [lane("up-lane"), lane("other-lane")] };
	assert.match(attributionViolations([leaked], none).join("\n"), /holds 1 admitted lane-launch line\(s\) for 2 launch\(es\)/);

	// Red: the gate line a leaked launch writes lands in the live log, mark and all.
	const leakedLine = "2026-10-26T18:00:01+02:00 admitted kind=lane-launch size=1498MiB available=66777MiB need=7642MiB";
	assert.match(attributionViolations([clean], { ...none, gateLog: leakedLine }).join("\n"), /the live gate log names the fixture's own/);
	assert.match(attributionViolations([clean], { ...none, eventsLog: `2026-10-26T18:00:02+02:00 GATE REFUSAL: unit=lane-launch reason="/lab"` }).join("\n"), /the live events log names the fixture's own/);

	// Green: a real lane launch and a foreign refusal during the run name nothing of ours.
	const foreign = "2026-10-26T18:00:02+02:00 admitted kind=lane-launch size=1498MiB available=9120MiB need=7642MiB\n2026-10-26T18:00:03+02:00 GATE REFUSAL: unit=lane-launch size=1498MiB psi=20.40 reason=\"only 5000 MiB of memory is available\"";
	assert.deepEqual(attributionViolations([clean], { gateLog: foreign, eventsLog: foreign, lastLaunch: "2026-10-26T18:00:03+02:00" }), []);
});

// VR24-185 (c) as VR24-187 amends it: every launch above passed through `heavy-gate.sh lane-launch`,
// so each one must be in its own lab's gate state (the count is the positive proof), and no live
// gate record may name this run — its lanes, its lab dir or its available mark. Runs last, so it
// judges the whole file.
test("the lab records every launch it made and the live gate state names none of them", (t) => {
	if (runs.length === 0) return t.skip("no launch ran on this machine, so there is nothing to attribute");
	assert.deepEqual(attributionViolations(runs, { gateLog: readText(LIVE_GATE.log), eventsLog: readText(LIVE_GATE.events), lastLaunch: readText(LIVE_GATE.last) }), []);
});
