/**
 * One live holder per lane name, and the `--conversation` flag (lifecycle WP12, LD14, LD15).
 *
 * The launcher refuses a name that `claude agents --json` lists or that a lane tmux session holds, for
 * every harness, before anything starts. `--conversation` puts `kind: conversation` on the lane record.
 * Fakes only: a private tmux server, a fake `claude` and a fake `pi`, so no real session is touched.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeBrief } from "./lane-brief-fixture.ts";
import { labInstallEnv, liveLaunchRecordGuard } from "./lane-state-lab.ts";
import { readLaneRecord } from "../lane-lifecycle.ts";
import { harnessRoot } from "../../core/harness-paths.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);
const RECIPE = join(HARNESS_ROOT, "muster", "scripts", "pi-lane-launch.sh");
const SESSION = "pilane-livename";
const HAS_TMUX = spawnSync("tmux", ["-V"]).status === 0;
const liveRecords = liveLaunchRecordGuard();
after(() => liveRecords.assertUntouched());

type Lab = { dir: string; env: NodeJS.ProcessEnv; brief: string; cwd: string; bgCalls: string; state: string };

/** `agentsJson` is what the fake `claude agents --json` prints; a `--bg` call is recorded. */
function withLab(agentsJson: string, run: (lab: Lab) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "lane-livename-"));
	const bin = join(dir, "bin");
	mkdirSync(bin);
	const cwd = join(dir, "worktree");
	mkdirSync(cwd);
	const bgCalls = join(dir, "bg-calls.log");
	const agents = join(dir, "agents.json");
	writeFileSync(agents, agentsJson);
	writeFileSync(
		join(bin, "claude"),
		[
			"#!/bin/sh",
			`if [ "$1" = "agents" ]; then cat "${agents}"; exit 0; fi`,
			`printf 'argv=%s\\n' "$*" >> "${bgCalls}"`,
			"printf 'backgrounded · deadbeef · lane\\n'",
			"",
		].join("\n"),
	);
	chmodSync(join(bin, "claude"), 0o755);
	const fakePi = join(dir, "fake-pi.sh");
	writeFileSync(fakePi, "#!/bin/sh\nexec sleep 30\n");
	chmodSync(fakePi, 0o755);
	const fixture = makeBrief();
	const labEnv = labInstallEnv(dir);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		TMUX_TMPDIR: dir,
		PI_BIN: fakePi,
		PI_LANES_TMUX_SESSION: SESSION,
		PI_LANES_JSON: join(dir, "pi-lanes.json"),
		PI_CLAUDE_BUS_PLUGIN_DIR: join(dir, "no-plugin"),
		...labEnv,
		PATH: `${bin}:${process.env.PATH}`,
	};
	delete env["TMUX"];
	try {
		run({ dir, env, brief: fixture.path, cwd, bgCalls, state: labEnv.PI_MUSTER_STATE_DIR });
	} finally {
		spawnSync("tmux", ["kill-server"], { env, stdio: "ignore" });
		fixture.remove();
		rmSync(dir, { recursive: true, force: true });
	}
}

function launch(lab: Lab, lane: string, harness: string, ...args: string[]) {
	const result = spawnSync(RECIPE, ["--lane", lane, "--harness", harness, "--cwd", lab.cwd, "--brief", lab.brief, "--model", harness === "claude" ? "opus" : "zai/glm-5.3-flash", "--verify-seconds", "2", "--title", "A live-name lane", "--no-goal", ...args], { encoding: "utf8", timeout: 60_000, env: lab.env });
	return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const bgCalls = (lab: Lab): string[] => (existsSync(lab.bgCalls) ? readFileSync(lab.bgCalls, "utf8").split("\n").filter(Boolean) : []);

function windows(lab: Lab): string[] {
	const result = spawnSync("tmux", ["list-windows", "-t", `=${SESSION}`, "-F", "#{window_name}"], { encoding: "utf8", env: lab.env });
	return result.status === 0 ? result.stdout.split("\n").filter(Boolean) : [];
}

function openWindow(lab: Lab, name: string): void {
	const made = spawnSync("tmux", ["new-session", "-d", "-s", SESSION, "-n", name, "sleep 60"], { env: lab.env });
	assert.equal(made.status, 0, String(made.stderr));
}

const LIVE_ROW = (name: string): string => JSON.stringify([{ id: "abcd1234", name, sessionId: "abcd1234-0000", kind: "background", state: "idle" }]);

test("a Pi or OpenCode launch is refused when a Claude session already has the name, and nothing starts", { skip: !HAS_TMUX }, () => {
	withLab(LIVE_ROW("sn-taken"), (lab) => {
		for (const harness of ["pi", "opencode"]) {
			const refused = launch(lab, "sn-taken", harness);
			assert.equal(refused.status, 3, `${harness}: ${refused.output}`);
			assert.match(refused.output, /a live Claude session is already named sn-taken; nothing was started/);
		}
		assert.deepEqual(windows(lab), [], "no window was created");
		const dry = launch(lab, "sn-taken", "pi", "--dry-run");
		assert.equal(dry.status, 3, "a dry run reports the refusal too");
		const free = launch(lab, "sn-free", "pi", "--dry-run");
		assert.equal(free.status, 0, free.output);
	});
});

test("a Claude launch is refused when a Pi lane window already has the name, in either lane session, and starts nothing", { skip: !HAS_TMUX }, () => {
	withLab("[]", (lab) => {
		openWindow(lab, "pi-taken");
		const refused = launch(lab, "pi-taken", "claude");
		assert.equal(refused.status, 3, refused.output);
		assert.match(refused.output, new RegExp(`window ${SESSION}:pi-taken already exists; a lane name has one live holder \\(LD15\\); nothing was started`));
		assert.deepEqual(bgCalls(lab), [], "claude --bg was never called");
		const other = launch(lab, "pi-other", "claude");
		assert.equal(other.status, 0, other.output);
		assert.equal(bgCalls(lab).length, 1);
	});
});

test("a Pi lane's own window is left to the respawn rules: a respawn is not refused by the live-name check, a plain launch still is", { skip: !HAS_TMUX }, () => {
	withLab("[]", (lab) => {
		openWindow(lab, "pi-mine");
		const respawn = launch(lab, "pi-mine", "pi", "--respawn", "--dry-run");
		assert.equal(respawn.status, 0, respawn.output);
		assert.match(respawn.output, /would respawn in/);
		const plain = launch(lab, "pi-mine", "pi", "--dry-run");
		assert.equal(plain.status, 3, plain.output);
		assert.match(plain.output, /already exists/);
	});
});

test("--unregister is not a launch: a window or session that holds the name does not stop it from reaching its own check", { skip: !HAS_TMUX }, () => {
	withLab(LIVE_ROW("pi-gone"), (lab) => {
		const result = spawnSync(RECIPE, ["--lane", "pi-gone", "--unregister"], { encoding: "utf8", timeout: 60_000, env: lab.env });
		assert.doesNotMatch(`${result.stdout}${result.stderr}`, /one live holder|already named/);
	});
});

test("--conversation puts kind conversation on the lane record; without it the record has no kind, and a later launch without it keeps it", { skip: !HAS_TMUX }, () => {
	withLab("[]", (lab) => {
		const design = launch(lab, "sn-design", "claude", "--conversation");
		assert.equal(design.status, 0, design.output);
		assert.equal(readLaneRecord(lab.state, "sn-design")?.kind, "conversation");
		const worker = launch(lab, "sn-worker", "claude");
		assert.equal(worker.status, 0, worker.output);
		assert.equal(readLaneRecord(lab.state, "sn-worker")?.kind, undefined);
		const again = launch(lab, "sn-design", "claude");
		assert.equal(again.status, 0, again.output);
		assert.equal(readLaneRecord(lab.state, "sn-design")?.kind, "conversation", "a resume that forgot the flag is still a conversation");
	});
});
