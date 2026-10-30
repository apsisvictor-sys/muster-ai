import "./muster-test-isolation.ts";
/**
 * AR1: a closed lane says what it ran on, as which kind, and its lane-outcomes row is written by code.
 *
 * 1. `muster lane-record launch` stores the model, the class, the task kind and the route-by on the lane
 *    record, and a later launch replaces them, as it replaces the launch warning.
 * 2. `muster lane-outcome` appends the row the lane record describes, with the three new columns at the
 *    end, and keeps a file that still has the old header aligned.
 * 3. The whole path: the launcher's dry run passes the three values to the lane record, the record keeps
 *    them, the verb writes the row, and the digest's own parser reads that row back with its kind known.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readLaneRecord } from "../lane-lifecycle.ts";
import { labInstallEnv } from "./lane-state-lab.ts";
import { harnessRoot } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
const LAUNCHER = join(piAgentDir(), "extensions", "muster", "launchers", "muster");
const RECIPE = join(HARNESS_ROOT, "muster", "scripts", "pi-lane-launch.sh");
const DIGEST = join(piAgentDir(), "scripts", "learning-digest.py");

/** The row the file carries today, and the row it carries after this lane: three columns at the end. */
const HEADER_OLD = ["date", "lane", "project", "class", "model", "launched_at", "closed_at", "rounds_sent_back", "outcome", "send_back_causes"];
const HEADER_NEW = [...HEADER_OLD, "task_kind", "harness", "route_by"];

type Lab = { root: string; state: string; tsv: string; catalogue: string; env: NodeJS.ProcessEnv; close: () => void };

/** A lab installation: its own state dir, its own lane-outcomes file, its own project catalogue. */
function lab(header: readonly string[] = HEADER_NEW): Lab {
	const root = mkdtempSync(join(tmpdir(), "muster-ar1-"));
	const state = join(root, "state", "muster");
	const home = join(root, "home");
	const bin = join(root, "bin");
	const tsv = join(root, "lane-outcomes.tsv");
	const catalogue = join(root, "muster-projects.json");
	mkdirSync(state, { recursive: true });
	mkdirSync(home, { recursive: true });
	mkdirSync(bin, { recursive: true });
	symlinkSync("/usr/bin/bash", join(bin, "bash"));
	symlinkSync(process.execPath, join(bin, "node"));
	writeFileSync(tsv, `${header.join("\t")}\n`, "utf8");
	writeFileSync(catalogue, JSON.stringify({ schemaVersion: 1, projects: [] }), "utf8");
	const env: NodeJS.ProcessEnv = {
		PI_MUSTER_STATE_DIR: state,
		PI_LANE_OUTCOMES_TSV: tsv,
		PI_MUSTER_PROJECTS_FILE: catalogue,
		HOME: home,
		PATH: `${bin}:/usr/bin:${dirname(process.execPath)}`,
	};
	return { root, state, tsv, catalogue, env, close: () => rmSync(root, { recursive: true, force: true }) };
}

function runMuster(l: Lab, args: string[], extra: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(LAUNCHER, args, { encoding: "utf8", timeout: 60_000, cwd: HARNESS_ROOT, env: { ...l.env, ...extra } });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The rows of the lane-outcomes file, one array of cells each. */
function rowsOf(path: string): string[][] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => line.split("\t"));
}

test("AR1: lane-record launch stores the model, the class, the task kind and the route-by, and a later launch replaces them", () => {
	const l = lab();
	try {
		const first = runMuster(l, [
			"lane-record", "launch", "--lane", "lane-a", "--harness", "pi", "--title", "A lane the row describes",
			"--model", "zai/glm-5.3-flash", "--class", "flash", "--task-kind", "ui", "--route-by", "rule",
		]);
		assert.equal(first.status, 0, first.stderr);
		const stored = readLaneRecord(l.state, "lane-a");
		assert.equal(stored?.model, "zai/glm-5.3-flash");
		assert.equal(stored?.class, "flash");
		assert.equal(stored?.taskKind, "ui");
		assert.equal(stored?.routeBy, "rule");
		assert.equal(stored?.kind, undefined, "the record's own kind (worker or conversation) is not the task kind");

		const second = runMuster(l, [
			"lane-record", "launch", "--lane", "lane-a", "--harness", "pi", "--title", "A lane the row describes",
			"--model", "minimax/MiniMax-M3.1-Flash", "--class", "H3", "--task-kind", "shared-owner", "--route-by", "orchestrator",
		]);
		assert.equal(second.status, 0, second.stderr);
		const replaced = readLaneRecord(l.state, "lane-a");
		assert.equal(replaced?.model, "minimax/MiniMax-M3.1-Flash", "a later launch states its own model");
		assert.equal(replaced?.class, "H3");
		assert.equal(replaced?.taskKind, "shared-owner");
		assert.equal(replaced?.routeBy, "orchestrator");

		const third = runMuster(l, ["lane-record", "launch", "--lane", "lane-a", "--harness", "pi"]);
		assert.equal(third.status, 0, third.stderr);
		const dropped = readLaneRecord(l.state, "lane-a");
		assert.equal(dropped?.model, undefined, "a launch that states no model drops the earlier one, as the launch warning is dropped");
		assert.equal(dropped?.class, undefined);
		assert.equal(dropped?.taskKind, undefined);
		assert.equal(dropped?.routeBy, undefined);
	} finally {
		l.close();
	}
});

test("AR1: muster lane-outcome appends the row the lane record describes, with the three new columns at the end", () => {
	const l = lab();
	try {
		const launched = runMuster(l, [
			"lane-record", "launch", "--lane", "lane-a", "--harness", "pi", "--title", "A lane the row describes", "--cwd", l.root,
			"--model", "zai/glm-5.3-flash", "--class", "flash", "--task-kind", "ui", "--route-by", "rule",
		]);
		assert.equal(launched.status, 0, launched.stderr);

		const written = runMuster(l, ["lane-outcome", "lane-a", "--rounds", "1", "--causes", "cause one", "--outcome", "merged"]);
		assert.equal(written.status, 0, written.stderr);

		const rows = rowsOf(l.tsv);
		assert.equal(rows.length, 2, "the header and one row");
		const row = rows[1] as string[];
		assert.equal(row.length, HEADER_NEW.length, "one cell per column");
		assert.match(row[0] as string, /^\d{4}-\d{2}-\d{2}$/, "the row's date");
		assert.equal(row[1], "lane-a");
		assert.equal(row[3], "flash");
		assert.equal(row[4], "zai/glm-5.3-flash");
		assert.match(row[5] as string, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "the launch time");
		assert.match(row[6] as string, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "the close time");
		assert.equal(row[7], "1");
		assert.equal(row[8], "merged");
		assert.equal(row[9], "cause one");
		assert.equal(row[10], "ui");
		assert.equal(row[11], "pi");
		assert.equal(row[12], "rule");
	} finally {
		l.close();
	}
});

test("AR1: a lane-outcomes file with the old header keeps its rows aligned", () => {
	const l = lab(HEADER_OLD);
	try {
		const launched = runMuster(l, [
			"lane-record", "launch", "--lane", "lane-a", "--harness", "pi", "--title", "A lane the row describes", "--cwd", l.root,
			"--model", "zai/glm-5.3-flash", "--class", "flash", "--task-kind", "ui", "--route-by", "rule",
		]);
		assert.equal(launched.status, 0, launched.stderr);
		const written = runMuster(l, ["lane-outcome", "lane-a", "--rounds", "0", "--outcome", "merged"]);
		assert.equal(written.status, 0, written.stderr);
		assert.match(written.stderr, /task_kind/, "the missing columns are named");
		const rows = rowsOf(l.tsv);
		assert.equal(rows.length, 2);
		assert.equal((rows[1] as string[]).length, HEADER_OLD.length, "the row follows the file's own header");
		assert.equal((rows[1] as string[])[9], "none", "a lane with no send-back round has no cause");
	} finally {
		l.close();
	}
});

test("AR1: muster lane-outcome refuses a lane with no record and writes no row", () => {
	const l = lab();
	try {
		const written = runMuster(l, ["lane-outcome", "lane-nothing", "--rounds", "0", "--outcome", "merged"]);
		assert.notEqual(written.status, 0, "a lane with no record is refused");
		assert.equal(rowsOf(l.tsv).length, 1, "the file still holds only its header");
	} finally {
		l.close();
	}
});

test("AR1: the whole path — the launcher states the three values, the record keeps them, the verb writes the row, the digest reads it back", () => {
	const l = lab();
	try {
		const root = join(l.root, "work");
		mkdirSync(root, { recursive: true });
		const fakePi = join(l.root, "fake-pi.sh");
		writeFileSync(fakePi, "#!/bin/sh\nexit 0\n", "utf8");
		chmodSync(fakePi, 0o755);
		const launcherEnv: NodeJS.ProcessEnv = {
			...l.env,
			TMUX_TMPDIR: l.root,
			PI_BIN: fakePi,
			PI_LANES_TMUX_SESSION: "ar1-lane",
			PI_LANES_JSON: join(l.root, "state", "pi-lanes.json"),
			...labInstallEnv(l.root),
		};
		delete launcherEnv["TMUX"];

		const dry = spawnSync(
			RECIPE,
			["--lane", "ar1-lane", "--harness", "pi", "--model", "command-code/deepseek/deepseek-v4.1-flash",
				"--class", "flash", "--task-kind", "ui", "--cwd", root,
				"--session", "55555555-5555-4555-8555-555555555555", "--dry-run"],
			{ encoding: "utf8", timeout: 60_000, env: launcherEnv },
		);
		assert.equal(dry.status, 0, dry.stderr);
		assert.match(dry.stdout, /lane-record launch/);
		assert.match(dry.stdout, /--model command-code\/deepseek\/deepseek-v4\.1-flash/);
		assert.match(dry.stdout, /--class flash/);
		assert.match(dry.stdout, /--task-kind ui/);

		const launched = runMuster(l, [
			"lane-record", "launch", "--lane", "ar1-lane", "--harness", "pi", "--title", "A lane the row describes", "--cwd", root,
			"--model", "command-code/deepseek/deepseek-v4.1-flash", "--class", "flash", "--task-kind", "ui", "--route-by", "rule",
		]);
		assert.equal(launched.status, 0, launched.stderr);
		const written = runMuster(l, ["lane-outcome", "ar1-lane", "--rounds", "0", "--outcome", "merged"]);
		assert.equal(written.status, 0, written.stderr);

		const rows = rowsOf(l.tsv);
		const row = rows[1] as string[];
		assert.equal(row[10], "ui", "the row carries the task kind the launcher stated");
		assert.equal(row[4], "command-code/deepseek/deepseek-v4.1-flash");
		assert.equal(row[11], "pi");
		assert.equal(row[12], "rule");

		// The digest's own parser over the row the verb wrote.
		const python = [
			"import importlib.util, json, sys",
			"spec = importlib.util.spec_from_file_location('ld', sys.argv[1])",
			"ld = importlib.util.module_from_spec(spec)",
			"spec.loader.exec_module(ld)",
			"today = ld.date.fromisoformat(sys.argv[3])",
			"rows = ld.parse_tsv(sys.argv[2], today)",
			"print(json.dumps({",
			"  'rows': len(rows),",
			"  'task_kind': rows[0].get('task_kind') if rows else None,",
			"  'harness': rows[0].get('harness') if rows else None,",
			"  'unknown_model': ld.count_unknown(rows, 'model'),",
			"  'unknown_class': ld.count_unknown(rows, 'class'),",
			"  'unknown_task_kind': ld.count_unknown(rows, 'task_kind'),",
			"}))",
		].join("\n");
		const parsed = spawnSync("python3", ["-I", "-c", python, DIGEST, l.tsv, row[0] as string], { encoding: "utf8", timeout: 120_000 });
		assert.equal(parsed.status, 0, parsed.stderr);
		const seen = JSON.parse(parsed.stdout.trim()) as { rows: number; task_kind: string; harness: string; unknown_model: number; unknown_class: number; unknown_task_kind: number };
		assert.equal(seen.rows, 1);
		assert.equal(seen.task_kind, "ui");
		assert.equal(seen.harness, "pi");
		assert.equal(seen.unknown_model, 0, "the digest counts no unknown model in a row the verb wrote");
		assert.equal(seen.unknown_class, 0);
		assert.equal(seen.unknown_task_kind, 0);
	} finally {
		l.close();
	}
});

test("AR1: a second lane-outcome for the same launch is refused with exit 4 and writes nothing", () => {
	const l = lab();
	try {
		const launched = runMuster(l, [
			"lane-record", "launch", "--lane", "lane-a", "--harness", "pi", "--title", "A lane the row describes", "--cwd", l.root,
			"--model", "zai/glm-5.3-flash", "--class", "flash", "--task-kind", "ui", "--route-by", "rule",
		]);
		assert.equal(launched.status, 0, launched.stderr);
		const first = runMuster(l, ["lane-outcome", "lane-a", "--rounds", "0", "--outcome", "merged"]);
		assert.equal(first.status, 0, first.stderr);
		const before = readFileSync(l.tsv, "utf8");

		const second = runMuster(l, ["lane-outcome", "lane-a", "--rounds", "0", "--outcome", "merged"]);
		assert.equal(second.status, 4, "a row for this launch already exists");
		assert.equal(second.stderr.trim().split("\n").length, 1, "one line says so");
		assert.match(second.stderr, /already has a row/);
		assert.equal(readFileSync(l.tsv, "utf8"), before, "the second call writes nothing");
		assert.equal(rowsOf(l.tsv).length, 2, "one header and one row");
	} finally {
		l.close();
	}
});

test("AR1: the lane-outcomes file the verb writes is the one the installation owns", () => {
	// The path is the repo the running code lives in, the same root the digest reads, with an override
	// for a lab. A verb that wrote somewhere else would leave the file the digest reads untouched.
	const l = lab();
	try {
		const written = runMuster(l, ["lane-outcome", "lane-nothing", "--rounds", "0", "--outcome", "merged"]);
		assert.notEqual(written.status, 0);
		assert.equal(rowsOf(l.tsv).length, 1, "the lab's own file is the one the verb writes");
	} finally {
		l.close();
	}
});
