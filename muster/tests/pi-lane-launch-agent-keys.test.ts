/**
 * KEYINJ P2, end to end: the launcher re-reads `~/.config/agent-keys.env` at every launch.
 *
 * The defect this holds shut (2026-10-27): the tmux server holds the environment it was started
 * with, so a key added to the file afterwards never reached a lane, and a value copied with its
 * shell quotes reached it as 53 characters against 51 and answered 401.
 *
 * The lab starts one real tmux server with a stale copy of a key, writes the file with a newer
 * value and a second, quoted key after that server exists, and launches one lane. The lane's own
 * process environment — dumped by the fake `pi` — must carry the file's unquoted values, and the
 * launcher's own output must carry neither value.
 *
 * Test hygiene (2026-10-27): a launch resolves its lane model through `lane-model.mjs`, which appends
 * a routing decision line, and `routingDecisionsPath` resolves that line under `~` — it knows no lab
 * knob. The lab therefore states `PI_ROUTING_DECISIONS_PATH` itself, asserts the line lands in its own
 * state dir, and fails if this file adds any `keyinj` line to the machine's live log.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeBrief } from "./lane-brief-fixture.ts";
import { labInstallEnv, liveLaunchRecordGuard } from "./lane-state-lab.ts";
import { harnessRoot } from "../../core/harness-paths.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);
const RECIPE = join(HARNESS_ROOT, "muster", "scripts", "pi-lane-launch.sh");
const SESSION = "pilane-keyinj";
const HAS_TMUX = spawnSync("tmux", ["-V"]).status === 0;
const MODEL = "command-code/deepseek/deepseek-v4.1-flash";
const liveRecords = liveLaunchRecordGuard();

/**
 * The live routing decisions log a lane launch appends its decision line to (`routingDecisionsPath`
 * resolves it under `~`). The lab points `PI_ROUTING_DECISIONS_PATH` at its own temp state dir, so a
 * test launch appends there and never here (KEYINJ test hygiene, 2026-10-27). The lines an earlier run
 * left in the live log stay as they are: this file reads the log and deletes nothing.
 */
const LIVE_DECISIONS = join(homedir(), ".pi", "agent", "state", "routing", "decisions.jsonl");

/** The live log's `keyinj` decision lines, read-only, in file order. */
function liveKeyinjDecisions(): string[] {
	if (!existsSync(LIVE_DECISIONS)) return [];
	return readFileSync(LIVE_DECISIONS, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.filter((line) => {
			try {
				const lane = (JSON.parse(line) as { lane?: unknown }).lane;
				return typeof lane === "string" && lane.startsWith("keyinj");
			} catch {
				return false;
			}
		});
}

const liveDecisionsBefore = liveKeyinjDecisions();
after(() => {
	liveRecords.assertUntouched();
	assert.deepEqual(liveKeyinjDecisions(), liveDecisionsBefore, `this file appended a keyinj decision line to the live log ${LIVE_DECISIONS}`);
});

/** The values this file uses. Canaries: never a real credential. */
const STALE = "test-key-stale";
const FRESH = "test-key-aaaa";
const QUOTED = "test-key-bbbb";

type Lab = { dir: string; env: NodeJS.ProcessEnv; brief: string; keys: string; expected: string; dump: string };

function withLab(run: (lab: Lab) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "lane-keyinj-"));
	const fixture = makeBrief();
	const fakePi = join(dir, "fake-pi.sh");
	const dump = join(dir, "lane-env.txt");
	writeFileSync(fakePi, `#!/bin/sh\nenv > "$KEYINJ_ENV_DUMP"\nexec sleep 30\n`);
	chmodSync(fakePi, 0o755);
	mkdirSync(dir, { recursive: true });
	const keys = join(dir, "agent-keys.env");
	// The second copy a launch compares against, by length and sha256 only.
	const expected = join(dir, "expected.env");
	const env: NodeJS.ProcessEnv = {
		...process.env,
		TMUX_TMPDIR: dir,
		PI_BIN: fakePi,
		PI_LANES_TMUX_SESSION: SESSION,
		PI_LANES_JSON: join(dir, "pi-lanes.json"),
		PI_AGENT_KEYS_PATH: keys,
		PI_AGENT_KEYS_EXPECTED_PATH: expected,
		KEYINJ_ENV_DUMP: dump,
		...labInstallEnv(dir),
		// The lane model helper appends the routing decision line, `routingDecisionsPath` resolves it under `~`
		// and knows no lab knob: the lab states the path itself, in its own agent dir's state folder.
		PI_ROUTING_DECISIONS_PATH: join(dir, "lab-agent", "state", "routing", "decisions.jsonl"),
	};
	delete env["TMUX"];
	// The machine's own keys must not decide this test: the file the launcher reads is the fixture.
	delete env["ZAI_API_KEY"];
	delete env["MINIMAX_API_KEY"];
	try {
		run({ dir, env, brief: fixture.path, keys, expected, dump });
	} finally {
		spawnSync("tmux", ["kill-server"], { env, stdio: "ignore" });
		fixture.remove();
		rmSync(dir, { recursive: true, force: true });
	}
}

/** The tmux server as it exists today: started with a copy of the key that the file has since replaced. */
function startStaleServer(lab: Lab): void {
	const started = spawnSync("tmux", ["new-session", "-d", "-s", SESSION, "-n", "keep", "sleep", "60"], {
		env: { ...lab.env, ZAI_API_KEY: STALE },
		encoding: "utf8",
	});
	assert.equal(started.status, 0, `tmux server did not start: ${started.stderr ?? ""}`);
	const global = spawnSync("tmux", ["show-environment", "-g", "ZAI_API_KEY"], { env: lab.env, encoding: "utf8" }).stdout;
	assert.match(global, new RegExp(`ZAI_API_KEY=${STALE}`), "the lab's server really holds the stale copy");
}

function launch(lab: Lab, lane: string, ...args: string[]) {
	const result = spawnSync(RECIPE, ["--lane", lane, "--model", MODEL, "--cwd", lab.dir, "--verify-seconds", "2", "--title", "A keyinj lane", "--no-goal", "--brief", lab.brief, ...args], {
		encoding: "utf8",
		timeout: 120_000,
		env: lab.env,
	});
	return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function waitForDump(path: string, timeoutMs = 15_000): string {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) {
			const text = readFileSync(path, "utf8");
			if (text.trim() !== "") return text;
		}
		spawnSync("sleep", ["0.2"]);
	}
	return "";
}

test("a key written after the tmux server started reaches a new lane, unquoted, over the server's stale copy", { skip: !HAS_TMUX }, () => {
	withLab((lab) => {
		startStaleServer(lab);
		// The file changes after the server exists: a replaced value and a brand new, quoted key.
		writeFileSync(lab.keys, `${["ZAI_API_KEY=\"" + FRESH + "\"", `MINIMAX_API_KEY='${QUOTED}'`, "export DEEPSEEK_API_KEY=" + FRESH].join("\n")}\n`);
		const result = launch(lab, `keyinj-${process.pid}`);
		assert.equal(result.status, 0, result.output);
		const dumped = waitForDump(lab.dump);
		assert.notEqual(dumped, "", `the lane never wrote its environment:\n${result.output}`);
		assert.match(dumped, new RegExp(`^ZAI_API_KEY=${FRESH}$`, "m"), "the file's value wins over the server's stale copy");
		assert.match(dumped, new RegExp(`^MINIMAX_API_KEY=${QUOTED}$`, "m"), "the quoted value arrives unquoted");
		assert.match(dumped, new RegExp(`^DEEPSEEK_API_KEY=${FRESH}$`, "m"), "the export prefix is not part of the name");
		assert.doesNotMatch(dumped, new RegExp(STALE), "the tmux server's stale copy is overridden");
		// The decision line the lane model helper writes lands in the lab's own state dir.
		const labLog = join(lab.dir, "lab-agent", "state", "routing", "decisions.jsonl");
		assert.ok(existsSync(labLog), `the launch wrote no decision line into the lab: ${result.output}`);
		assert.match(readFileSync(labLog, "utf8"), new RegExp(`"lane":"keyinj-${process.pid}"`), "the lab's decision line is in the lab");
		for (const value of [STALE, FRESH, QUOTED]) {
			assert.equal(result.output.includes(value), false, `the launcher printed a key value:\n${result.output}`);
		}
	});
});

test("the dry run says nothing about the keys and prints no value", { skip: !HAS_TMUX }, () => {
	withLab((lab) => {
		writeFileSync(lab.keys, `ZAI_API_KEY="${FRESH}"\n`);
		const result = launch(lab, "keyinj-dry", "--dry-run");
		assert.equal(result.status, 0, result.output);
		assert.match(result.output, /would create/);
		assert.equal(result.output.includes(FRESH), false, `the dry run printed a key value:\n${result.output}`);
	});
});

test("a quoted key is stripped to the expected copy's length and sha256, and a value that cannot be trusted is said out loud", { skip: !HAS_TMUX }, () => {
	withLab((lab) => {
		const bare = `test-key-${"a".repeat(42)}`;
		const other = `test-key-${"b".repeat(42)}`;
		writeFileSync(lab.keys, `ZAI_API_KEY="${bare}"\n`);
		writeFileSync(lab.expected, `ZAI_API_KEY=${bare}\n`);

		// The launch compares the value it hands the lane with the expected copy: same length, same sha256, no value read.
		const result = launch(lab, `keyinj-quoted-${process.pid}`);
		assert.equal(result.status, 0, result.output);
		const dumped = waitForDump(lab.dump);
		const value = /^ZAI_API_KEY=(.*)$/m.exec(dumped)?.[1] ?? "";
		assert.equal(value.length, bare.length, "51 characters, not 53");
		assert.equal(createHash("sha256").update(value).digest("hex"), createHash("sha256").update(bare).digest("hex"), "the length and sha256 are the expected copy's");
		assert.doesNotMatch(result.output, /key ZAI_API_KEY/, "a value that matches its copy says nothing");

		// A value the expected copy disagrees with is said out loud, by name and length, and never printed.
		writeFileSync(lab.keys, `ZAI_API_KEY=${other}\n`);
		const differs = launch(lab, "keyinj-differs", "--dry-run");
		assert.equal(differs.status, 0, differs.output);
		assert.match(differs.output, /key ZAI_API_KEY differs from .*expected\.env \(\d+ characters here, \d+ there\)/);
		assert.equal(differs.output.includes(other), false, "the launcher printed a key value");

		// A second layer of quotes is said out loud too, so it cannot reach a lane as a silent 401.
		writeFileSync(lab.keys, `ZAI_API_KEY="'${bare}'"\n`);
		const stillQuoted = launch(lab, "keyinj-still-quoted", "--dry-run");
		assert.equal(stillQuoted.status, 0, stillQuoted.output);
		assert.match(stillQuoted.output, /key ZAI_API_KEY is still quoted after parsing \(53 characters\)/);
		assert.equal(stillQuoted.output.includes(bare), false, "the launcher printed a key value");
	});
});
