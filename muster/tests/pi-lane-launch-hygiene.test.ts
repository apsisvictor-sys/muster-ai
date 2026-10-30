/**
 * Launcher hygiene (lifecycle WP5, 2026-10-11).
 *
 * - A brief under /tmp is refused: briefs live in handoffs/msgs, never copied silently.
 * - A Pi or OpenCode lane's pane command runs in a transient scope inside
 *   pi-lanes.slice, with no memory properties.
 * - A resumed Pi session says why the brief is not sent.
 *
 * The scope test starts a real lane window on a private tmux server with a fake
 * `pi`, and reads the scope back from the user manager.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeBrief } from "./lane-brief-fixture.ts";
import { labInstallEnv, liveLaunchRecordGuard } from "./lane-state-lab.ts";
import { harnessRoot } from "../../core/harness-paths.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);
const RECIPE = join(HARNESS_ROOT, "muster", "scripts", "pi-lane-launch.sh");
const SESSION = "pilane-hygiene";
const liveRecords = liveLaunchRecordGuard();
after(() => liveRecords.assertUntouched());
// An explicit --model is checked against the harness's own catalog before the lane starts
// (P5-D6: a Pi model outside provider-pool.json is refused), so a fixture that only needs to
// name one uses the pool's own head.
const MODEL = "command-code/deepseek/deepseek-v4.1-flash";
const HAS_TMUX = spawnSync("tmux", ["-V"]).status === 0;
const HAS_USER_SYSTEMD = spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" }).status === 0 && spawnSync("systemd-run", ["--version"], { stdio: "ignore" }).status === 0;

type Lab = { dir: string; env: NodeJS.ProcessEnv; brief: string };

function withLab(run: (lab: Lab) => void, extraBin?: Record<string, string>): void {
	const dir = mkdtempSync(join(tmpdir(), "lane-hygiene-"));
	const fixture = makeBrief();
	const fakePi = join(dir, "fake-pi.sh");
	writeFileSync(fakePi, "#!/bin/sh\nexec sleep 30\n");
	chmodSync(fakePi, 0o755);
	const bin = join(dir, "bin");
	spawnSync("mkdir", ["-p", bin]);
	for (const [name, body] of Object.entries(extraBin ?? {})) {
		writeFileSync(join(bin, name), body);
		chmodSync(join(bin, name), 0o755);
	}
	const env: NodeJS.ProcessEnv = {
		...process.env,
		TMUX_TMPDIR: dir,
		PI_BIN: fakePi,
		PI_LANES_TMUX_SESSION: SESSION,
		PI_LANES_JSON: join(dir, "pi-lanes.json"),
		...labInstallEnv(dir),
		PATH: `${bin}:${process.env.PATH}`,
	};
	delete env["TMUX"];
	try {
		run({ dir, env, brief: fixture.path });
	} finally {
		spawnSync("tmux", ["kill-server"], { env, stdio: "ignore" });
		fixture.remove();
		rmSync(dir, { recursive: true, force: true });
	}
}

function launch(lab: Lab, lane: string, ...args: string[]) {
	const result = spawnSync(RECIPE, ["--lane", lane, "--model", MODEL, "--cwd", lab.dir, "--verify-seconds", "2", "--title", "A hygiene lane", "--no-goal", ...args], { encoding: "utf8", timeout: 60_000, env: lab.env });
	return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

test("a brief under /tmp is refused with the standing-rule message, for every harness, and nothing starts", { skip: !HAS_TMUX }, () => {
	withLab((lab) => {
		const inTmp = join(lab.dir, "brief.md");
		writeFileSync(inTmp, "# brief\n");
		for (const harness of ["pi", "claude"]) {
			const result = launch(lab, "tmp-brief", "--harness", harness, "--brief", inTmp, "--dry-run");
			assert.equal(result.status, 2, `${harness}: ${result.output}`);
			assert.match(result.output, /briefs live in handoffs\/msgs \(standing rule 2026-10-11\)/);
			assert.doesNotMatch(result.output, /would (create|start)/);
		}
	});
});

test("a brief that is a symlink into /tmp is refused too, and a brief outside /tmp is accepted", { skip: !HAS_TMUX }, () => {
	withLab((lab) => {
		const target = join(lab.dir, "real-brief.md");
		writeFileSync(target, "# brief\n");
		const link = join(lab.brief, "..", "link.md");
		symlinkSync(target, link);
		const refused = launch(lab, "link-brief", "--harness", "pi", "--brief", link, "--dry-run");
		assert.equal(refused.status, 2, refused.output);
		assert.match(refused.output, /briefs live in handoffs\/msgs/);
		const accepted = launch(lab, "ok-brief", "--harness", "pi", "--brief", lab.brief, "--dry-run");
		assert.equal(accepted.status, 0, accepted.output);
	});
});

test("pi: a resumed session says the brief is not sent, a fresh one does not", { skip: !HAS_TMUX }, () => {
	withLab((lab) => {
		const resumed = launch(lab, "resume-note", "--brief", lab.brief, "--session", "11111111-1111-4111-8111-111111111111", "--dry-run");
		assert.equal(resumed.status, 0, resumed.output);
		assert.match(resumed.output, /session 11111111-1111-4111-8111-111111111111 is resumed, so the brief is not sent; send it with muster send resume-note/);
		const fresh = launch(lab, "fresh-note", "--brief", lab.brief, "--dry-run");
		assert.equal(fresh.status, 0, fresh.output);
		assert.doesNotMatch(fresh.output, /is resumed, so the brief is not sent/);
	});
});

test("pi: the pane command runs in a scope inside pi-lanes.slice with no memory properties", { skip: !HAS_TMUX || !HAS_USER_SYSTEMD }, () => {
	withLab((lab) => {
		const lane = `hyg-slice-${process.pid}`;
		const dry = launch(lab, lane, "--dry-run");
		assert.match(dry.output, new RegExp(`pane command runs in scope lane-${lane}-\\d+\\.scope, slice pi-lanes\\.slice`), dry.output);
		const result = launch(lab, lane);
		assert.equal(result.status, 0, result.output);
		// verify() already read CONCORD_AGENT_ID from the pane's pid: the scope keeps the lane's environment.
		assert.match(result.output, new RegExp(`bus identity CONCORD_AGENT_ID=${lane}`), result.output);
		const units = spawnSync("systemctl", ["--user", "list-units", "--type=scope", "--plain", "--no-legend", `lane-${lane}-*.scope`], { encoding: "utf8" }).stdout;
		const unit = units.trim().split(/\s+/)[0] ?? "";
		assert.match(unit, new RegExp(`^lane-${lane}-\\d+\\.scope$`), units);
		const show = spawnSync("systemctl", ["--user", "show", unit, "-p", "Slice", "-p", "MemoryMax", "-p", "MemoryHigh", "-p", "MemoryLow"], { encoding: "utf8" }).stdout;
		assert.match(show, /^Slice=pi-lanes\.slice$/m, show);
		assert.match(show, /^MemoryMax=infinity$/m, show);
		assert.match(show, /^MemoryHigh=infinity$/m, show);
		assert.match(show, /^MemoryLow=0$/m, show);
	});
});

test("pi: without a user systemd manager the lane still starts and the launcher says it is outside the slice", { skip: !HAS_TMUX }, () => {
	withLab(
		(lab) => {
			const result = launch(lab, "hyg-noscope");
			assert.equal(result.status, 0, result.output);
			assert.match(result.output, /no user systemd manager; hyg-noscope runs outside pi-lanes\.slice/);
			assert.match(result.output, /bus identity CONCORD_AGENT_ID=hyg-noscope/);
		},
		{ systemctl: "#!/bin/sh\nexit 1\n" },
	);
});
