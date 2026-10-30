/**
 * The launch recipe for a Claude Code lane (`--harness claude`), against a fake
 * `claude` on PATH, so no real session is started (2026-10-09).
 *
 * A Claude lane is `claude --bg --name <lane>` in the lane's cwd, with the brief
 * as the prompt. The recipe refuses when a live `claude agents` row already has
 * that name, and it registers nothing in the Pi/OpenCode lane store.
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
import { harnessRoot } from "../../core/harness-paths.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);
const RECIPE = join(HARNESS_ROOT, "muster", "scripts", "pi-lane-launch.sh");
const liveRecords = liveLaunchRecordGuard();
after(() => liveRecords.assertUntouched());

type Lab = { dir: string; env: NodeJS.ProcessEnv; bgCalls: string; store: string; cwd: string; brief: string };

/**
 * `agentsJson` is what `claude agents --json` prints. The fake `claude` records
 * each `--bg` call (argv, cwd and bus identity) and prints a short id like the
 * real CLI does.
 */
function withLab(agentsJson: string, run: (lab: Lab) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "pi-lane-claude-"));
	const bin = join(dir, "bin");
	mkdirSync(bin);
	const cwd = join(dir, "worktree");
	mkdirSync(cwd);
	const fixture = makeBrief();
	const brief = fixture.path;
	const bgCalls = join(dir, "bg-calls.log");
	const agents = join(dir, "agents.json");
	writeFileSync(agents, agentsJson);
	const fakeClaude = join(bin, "claude");
	writeFileSync(
		fakeClaude,
		[
			"#!/bin/sh",
			`if [ "$1" = "agents" ]; then cat "${agents}"; exit 0; fi`,
			`printf 'cwd=%s agent=%s repo=%s argv=%s\\n' "$PWD" "$CONCORD_AGENT_ID" "$CONCORD_REPO_ROOT" "$*" >> "${bgCalls}"`,
			// What Claude Code 2.1.295 prints: the id is on the first line, a hint block follows.
			`printf 'backgrounded · deadbeef · %s\\n  claude agents             list sessions\\n  claude stop deadbeef      stop this session\\n' lane`,
			"",
		].join("\n"),
	);
	chmodSync(fakeClaude, 0o755);
	const store = join(dir, "pi-lanes.json");
	const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_LANES_JSON: store, PI_CLAUDE_BUS_PLUGIN_DIR: join(dir, "no-plugin"), ...labInstallEnv(dir), HEAVY_GATE_LAST: join(dir, "gate.last"), HEAVY_GATE_LOG: join(dir, "gate.log"), HEAVY_GATE_REFUSED_STATE_DIR: join(dir, "gate-refused"), HEAVY_GATE_SPACING: "0" };
	try {
		run({ dir, env, bgCalls, store, cwd, brief });
	} finally {
		fixture.remove();
		rmSync(dir, { recursive: true, force: true });
	}
}

function recipe(lab: Lab, args: string[]): { status: number | null; output: string } {
	const result = spawnSync(RECIPE, ["--harness", "claude", "--title", "A claude lane", "--no-goal", ...args], { encoding: "utf8", timeout: 30_000, env: lab.env });
	return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const bgCalls = (lab: Lab): string[] => (existsSync(lab.bgCalls) ? readFileSync(lab.bgCalls, "utf8").split("\n").filter(Boolean) : []);

test("--dry-run prints the claude --bg command and starts nothing", () => {
	withLab("[]", (lab) => {
		const result = recipe(lab, ["--lane", "cc-x", "--cwd", lab.cwd, "--brief", lab.brief, "--dry-run"]);
		assert.equal(result.status, 0, result.output);
		assert.match(result.output, /--bg --name cc-x --model sonnet --permission-mode bypassPermissions/);
		assert.match(result.output, /\/lane-worker Read .*brief\.md and do it\./);
		assert.deepEqual(bgCalls(lab), []);
		assert.equal(existsSync(lab.store), false, "the lane store is not written for a Claude lane");
	});
});

test("a launch starts the session in the cwd with the brief prompt and the bus identity", () => {
	withLab("[]", (lab) => {
		const result = recipe(lab, ["--lane", "cc-x", "--cwd", lab.cwd, "--brief", lab.brief, "--model", "opus"]);
		assert.equal(result.status, 0, result.output);
		assert.match(result.output, /started Claude lane cc-x \(id deadbeef, model opus/);
		const [call] = bgCalls(lab);
		assert.ok(call, "claude --bg was called");
		assert.match(call, /^cwd=.*worktree agent= repo=\S+ /, "a Claude lane is named by its job record, so the launcher hands the daemon no CONCORD_AGENT_ID");
		assert.match(call, /argv=--bg --name cc-x --model opus --permission-mode bypassPermissions \/lane-worker Read .*brief\.md and do it\./);
		// The lane files its own end-of-run report, because a Claude session ends with no bus signal.
		assert.match(call, /muster report review_ready --summary/);
		assert.match(call, /muster report blocked/);
		// The lane is woken in place by its own waiter (LD10), so its first message asks for one.
		assert.match(call, /run `muster wait --inbox cc-x --timeout 0` with run_in_background true now, and again each time it returns/);
		assert.equal(existsSync(lab.store), false, "the lane store is not written for a Claude lane");
	});
});

test("a live Claude row with the same name refuses the launch and starts nothing", () => {
	const row = JSON.stringify([{ id: "abcd1234", name: "cc-x", sessionId: "abcd1234-0000", kind: "background", state: "idle" }]);
	withLab(row, (lab) => {
		const result = recipe(lab, ["--lane", "cc-x", "--cwd", lab.cwd, "--brief", lab.brief]);
		assert.equal(result.status, 3, result.output);
		assert.match(result.output, /a live Claude session is already named cc-x/);
		assert.deepEqual(bgCalls(lab), []);
	});
});

test("a row with another name does not block the launch", () => {
	const row = JSON.stringify([{ id: "abcd1234", name: "cc-other", sessionId: "abcd1234-0000", kind: "background", state: "idle" }]);
	withLab(row, (lab) => {
		const result = recipe(lab, ["--lane", "cc-x", "--cwd", lab.cwd, "--brief", lab.brief]);
		assert.equal(result.status, 0, result.output);
		assert.equal(bgCalls(lab).length, 1);
	});
});

test("a missing or unreadable brief is refused before anything starts", () => {
	withLab("[]", (lab) => {
		const none = recipe(lab, ["--lane", "cc-x", "--cwd", lab.cwd]);
		assert.equal(none.status, 2, none.output);
		assert.match(none.output, /--brief <file> is required/);
		const missing = recipe(lab, ["--lane", "cc-x", "--cwd", lab.cwd, "--brief", join(lab.dir, "nope.md")]);
		assert.equal(missing.status, 2, missing.output);
		assert.match(missing.output, /brief not found/);
		assert.deepEqual(bgCalls(lab), []);
	});
});

test("--respawn and --session are refused for a Claude lane, which has no tmux window or lane-store row to resume", () => {
	withLab("[]", (lab) => {
		const respawn = recipe(lab, ["--lane", "cc-x", "--cwd", lab.cwd, "--brief", lab.brief, "--respawn"]);
		assert.equal(respawn.status, 2, respawn.output);
		assert.match(respawn.output, /--respawn is not supported with --harness claude/);
		const session = recipe(lab, ["--lane", "cc-x", "--cwd", lab.cwd, "--brief", lab.brief, "--session", "x"]);
		assert.equal(session.status, 2, session.output);
		assert.match(session.output, /--session is not supported with --harness claude/);
		assert.deepEqual(bgCalls(lab), []);
	});
});
