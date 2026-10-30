/**
 * Browser QA cleanup — WP10 of the lane lifecycle blueprint (LD11).
 *
 * Fixtures only: the tab results are the strings the Claude in Chrome tools print, the hook is
 * run through the real `muster` launcher with real stdin payloads, and processes are `sleep`
 * children this test starts and ends itself. No Chrome tab is touched.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { procStartTime } from "../lib/lane-directory.ts";
import { writeWaiterPid } from "../inbox-waiter.ts";
import { applyTabEvent, openTabsNudge, openTabsNudgeText, tabEventOf } from "../browser-qa.ts";
import { closeLane, readLaneRecord, recordLaunch, recordTabClosed, recordTabOpened, writeLaneRecord, type CloseLanePorts, type LaneRecord } from "../lane-lifecycle.ts";
import { stopHelperProcess } from "../lane-lifecycle-ports.ts";
import { REPORT_NUDGE_TEXT } from "../report-nudge.ts";
import { makeBrief } from "./lane-brief-fixture.ts";
import { harnessRoot } from "../../core/harness-paths.ts";
import { musterLauncher } from "../../core/pi-ports.ts";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
const LAUNCHER = musterLauncher();
const LAUNCH_SCRIPT = join(HARNESS_ROOT, "muster", "scripts", "pi-lane-launch.sh");
const T0 = Date.parse("2026-10-12T00:00:00Z");

const CREATED = (id: number) => ({ content: [{ type: "text", text: `Created new tab. Tab ID: ${id}` }, { type: "text", text: "\n\nTab Context:\n- Available tabs:\n  • tabId 7 \"x\"" }] });
const CLOSED = (id: number) => ({ content: [{ type: "text", text: `Closed tab ${id}. Group is now empty (auto-removed).` }] });

// ─── What a tab tool result means ────────────────────────────────────────────

test("a tabs_create_mcp result is an opened tab, a tabs_close_mcp result a closed one", () => {
	assert.deepEqual(tabEventOf({ tool_name: "mcp__claude-in-chrome__tabs_create_mcp", tool_response: CREATED(2022352291) }), { kind: "opened", tabId: 2022352291 });
	assert.deepEqual(tabEventOf({ tool_name: "mcp__claude-in-chrome__tabs_close_mcp", tool_response: CLOSED(2022351638) }), { kind: "closed", tabId: 2022351638 });
	assert.deepEqual(tabEventOf({ tool_name: "mcp__claude-in-chrome__tabs_create_mcp", tool_response: "Created new tab. Tab ID: 5" }), { kind: "opened", tabId: 5 }, "a plain-text result reads the same");
});

test("another tool, a failed call and an unreadable result are not tab events", () => {
	assert.equal(tabEventOf({ tool_name: "Bash", tool_response: { stdout: "Created new tab. Tab ID: 9" } }), undefined);
	assert.equal(tabEventOf({ tool_name: "mcp__claude-in-chrome__tabs_context_mcp", tool_response: CREATED(9) }), undefined, "listing tabs opens none");
	assert.equal(tabEventOf({ tool_name: "mcp__claude-in-chrome__tabs_close_mcp", tool_response: { content: [{ type: "text", text: "Error: no tab with id 12" }] } }), undefined, "a close that failed leaves the tab open");
	assert.equal(tabEventOf({ tool_name: "mcp__claude-in-chrome__tabs_create_mcp", tool_response: undefined }), undefined);
	assert.equal(tabEventOf({ tool_name: undefined, tool_response: CREATED(1) }), undefined);
});

// ─── The ledger on the lane record ───────────────────────────────────────────

function record(overrides: Partial<LaneRecord> = {}): LaneRecord {
	return { laneId: "cc-qa", harness: "claude", cwd: "/w/qa", branch: "lane/qa", launchedAt: T0, launchedBy: "orchestrator", phase: "working", phaseSince: T0, ...overrides };
}

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "browser-qa-"));
}

test("the ledger adds and removes tab ids, once each, and a lane that opens a tab is a browser lane", () => {
	const dir = tempDir();
	try {
		writeLaneRecord(dir, record());
		assert.equal(readLaneRecord(dir, "cc-qa")!.browser, undefined);
		applyTabEvent(dir, "cc-qa", { kind: "opened", tabId: 11 });
		applyTabEvent(dir, "cc-qa", { kind: "opened", tabId: 12 });
		applyTabEvent(dir, "cc-qa", { kind: "opened", tabId: 11 });
		assert.deepEqual(readLaneRecord(dir, "cc-qa")!.openTabs, [11, 12], "an id is listed once");
		assert.equal(readLaneRecord(dir, "cc-qa")!.browser, true);
		applyTabEvent(dir, "cc-qa", { kind: "closed", tabId: 11 });
		assert.deepEqual(readLaneRecord(dir, "cc-qa")!.openTabs, [12]);
		applyTabEvent(dir, "cc-qa", { kind: "closed", tabId: 99 });
		assert.deepEqual(readLaneRecord(dir, "cc-qa")!.openTabs, [12], "closing an id the lane never opened changes nothing");
		recordTabClosed(dir, "cc-qa", 12);
		assert.equal("openTabs" in readLaneRecord(dir, "cc-qa")!, false, "a clean lane carries no list");
		assert.equal(readLaneRecord(dir, "cc-qa")!.browser, true, "and stays a browser lane");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a lane with no record has nothing to write to", () => {
	const dir = tempDir();
	try {
		assert.equal(recordTabOpened(dir, "cc-none", 1), false);
		assert.equal(readLaneRecord(dir, "cc-none"), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a launch that names the browser marks the record, and a resume that forgets the flag keeps the mark", () => {
	const dir = tempDir();
	try {
		recordLaunch(dir, { laneId: "cc-qa", harness: "claude", cwd: "/w/qa", branch: null, browser: true, title: "A browser lane with tabs open" }, T0);
		assert.equal(readLaneRecord(dir, "cc-qa")!.browser, true);
		recordLaunch(dir, { laneId: "cc-qa", harness: "claude", cwd: "/w/qa", branch: null, title: "A browser lane with tabs open" }, T0 + 1);
		assert.equal(readLaneRecord(dir, "cc-qa")!.browser, true);
		recordLaunch(dir, { laneId: "cc-plain", harness: "claude", cwd: "/w/p", branch: null, title: "A lane that opens no tab" }, T0);
		assert.equal(readLaneRecord(dir, "cc-plain")!.browser, undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the open-tabs nudge names the ids, and never reaches the orchestrator, a operator row or a clean lane", () => {
	assert.equal(openTabsNudge("cc-qa", { browser: true, openTabs: [11, 12] }), "Close your tabs before ending the turn: tabs_close_mcp for 11, 12.");
	assert.equal(openTabsNudge("cc-qa", { browser: true, openTabs: [11, 12] }), openTabsNudgeText([11, 12]));
	assert.equal(openTabsNudge("cc-qa", { browser: true, openTabs: [] }), undefined);
	assert.equal(openTabsNudge("cc-qa", { browser: true }), undefined);
	assert.equal(openTabsNudge("cc-qa", { openTabs: [3] }), undefined, "only a browser lane");
	assert.equal(openTabsNudge("orchestrator", { browser: true, openTabs: [3] }), undefined);
	assert.equal(openTabsNudge("operator:claude:ab12cd34", { browser: true, openTabs: [3] }), undefined);
	assert.equal(openTabsNudge("cc-qa", undefined), undefined);
});

// ─── The hook, through the real launcher ─────────────────────────────────────

const LANE_SESSION = "0a1b2c3d-1111-4222-8333-444455556666";

function tempInstall(): { state: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "browser-qa-hook-"));
	const state = join(root, "muster");
	const claudeDir = join(root, "claude");
	mkdirSync(join(claudeDir, "jobs", LANE_SESSION.slice(0, 8)), { recursive: true });
	writeFileSync(join(claudeDir, "jobs", LANE_SESSION.slice(0, 8), "state.json"), JSON.stringify({ name: "cc-qa", sessionId: LANE_SESSION, template: "bg" }));
	// The lane's waiter is armed (this test process stands for it), so these Stop cases stay about the tabs.
	writeWaiterPid(state, "cc-qa", process.pid);
	return { state, env: { PI_MUSTER_STATE_DIR: state, HOME: join(root, "home"), CLAUDE_CONFIG_DIR: claudeDir, CONCORD_AGENT_ID: "cc-qa" }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runHook(event: string, payload: Record<string, unknown>, env: NodeJS.ProcessEnv): { status: number | null; stdout: string } {
	const result = spawnSync(LAUNCHER, ["claude-hook", event], {
		encoding: "utf8",
		timeout: 60_000,
		cwd: HARNESS_ROOT,
		input: JSON.stringify({ hook_event_name: event, session_id: LANE_SESSION, cwd: "/w/qa", transcript_path: "/tmp/t.jsonl", ...payload }),
		env: { ...process.env, ...env },
	});
	return { status: result.status, stdout: result.stdout ?? "" };
}

const tabCall = (name: "create" | "close", response: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
	tool_name: `mcp__claude-in-chrome__tabs_${name}_mcp`,
	tool_input: {},
	tool_response: response,
	tool_use_id: "toolu_1",
	...extra,
});

const stopPayload = (active: boolean | undefined): Record<string, unknown> => ({ ...(active === undefined ? {} : { stop_hook_active: active }), last_assistant_message: "done" });

test("PostToolUse keeps the ledger: tabs a lane opens are listed, a close removes its id, a subagent's tab counts", () => {
	const inst = tempInstall();
	try {
		writeLaneRecord(inst.state, record());
		runHook("PostToolUse", tabCall("create", CREATED(21)), inst.env);
		runHook("PostToolUse", tabCall("create", CREATED(22), { agent_id: "sub-1" }), inst.env);
		assert.deepEqual(readLaneRecord(inst.state, "cc-qa")!.openTabs, [21, 22]);
		runHook("PostToolUse", tabCall("close", CLOSED(21)), inst.env);
		assert.deepEqual(readLaneRecord(inst.state, "cc-qa")!.openTabs, [22]);
		runHook("PostToolUse", tabCall("close", { content: [{ type: "text", text: "Error: tab 22 not found" }] }), inst.env);
		assert.deepEqual(readLaneRecord(inst.state, "cc-qa")!.openTabs, [22], "a failed close removes nothing");
	} finally {
		inst.cleanup();
	}
});

test("Stop blocks a browser lane with open tabs, names the ids, and does not once they are closed", () => {
	const inst = tempInstall();
	try {
		writeLaneRecord(inst.state, record({ lastReport: { kind: "review_ready", summary: "s", at: T0 + 10 } }));
		runHook("SessionStart", { source: "startup" }, inst.env);
		runHook("PostToolUse", tabCall("create", CREATED(31)), inst.env);
		runHook("PostToolUse", tabCall("create", CREATED(32)), inst.env);
		const blocked = runHook("Stop", stopPayload(false), inst.env);
		assert.equal(blocked.status, 0);
		const answer = JSON.parse(blocked.stdout.trim()) as { decision?: string; reason?: string };
		assert.equal(answer.decision, "block");
		assert.match(answer.reason ?? "", /Close your tabs before ending the turn: tabs_close_mcp for 31, 32\./);

		runHook("PostToolUse", tabCall("close", CLOSED(31)), inst.env);
		runHook("PostToolUse", tabCall("close", CLOSED(32)), inst.env);
		const clear = runHook("Stop", stopPayload(false), inst.env);
		assert.equal(clear.stdout.trim().includes("Close your tabs"), false, "no tab open, no block for tabs");
	} finally {
		inst.cleanup();
	}
});

test("Stop never blocks for tabs while stop_hook_active is true or missing", () => {
	const inst = tempInstall();
	try {
		writeLaneRecord(inst.state, record({ browser: true, openTabs: [41] }));
		for (const active of [true, undefined]) {
			assert.equal(runHook("Stop", stopPayload(active), inst.env).stdout.trim(), "", `no block for stop_hook_active ${String(active)}`);
		}
	} finally {
		inst.cleanup();
	}
});

test("the report nudge and the tabs share one block, and a subagent's turn end is not asked", () => {
	const inst = tempInstall();
	try {
		writeLaneRecord(inst.state, record({ browser: true, openTabs: [51] }));
		runHook("SessionStart", { source: "startup" }, inst.env);
		const sub = runHook("Stop", { ...stopPayload(false), agent_id: "sub-1" }, inst.env);
		assert.equal(sub.stdout.trim(), "", "a subagent boundary is not the lane's turn end");
		const both = runHook("Stop", stopPayload(false), inst.env);
		const reason = (JSON.parse(both.stdout.trim()) as { reason: string }).reason;
		assert.equal(reason, `${REPORT_NUDGE_TEXT}\n\nClose your tabs before ending the turn: tabs_close_mcp for 51.`);
	} finally {
		inst.cleanup();
	}
});

test("a session no job record names (an interactive one) keeps no ledger and is never blocked", () => {
	const inst = tempInstall();
	try {
		writeLaneRecord(inst.state, record({ browser: true, openTabs: [61] }));
		const other = "9f8e7d6c-1111-4222-8333-444455556666";
		const env = { ...inst.env, CONCORD_AGENT_ID: "" };
		runHook("PostToolUse", tabCall("create", CREATED(62), { session_id: other }), env);
		assert.deepEqual(readLaneRecord(inst.state, "cc-qa")!.openTabs, [61]);
		assert.equal(runHook("Stop", { ...stopPayload(false), session_id: other }, env).stdout.trim(), "");
	} finally {
		inst.cleanup();
	}
});

// ─── Helper processes ────────────────────────────────────────────────────────

const children: ChildProcess[] = [];

function sleeper(): ChildProcess {
	const child = spawn("sleep", ["300"], { stdio: "ignore" });
	children.push(child);
	return child;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitDead(child: ChildProcess): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return true;
	return await Promise.race([new Promise<boolean>((done) => { child.once("exit", () => { done(true); }); }), new Promise<boolean>((done) => { setTimeout(() => { done(false); }, 5_000); })]);
}

test.after(() => {
	for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
});

function fakePorts(stopHelper: CloseLanePorts["stopHelper"], calls: string[]): CloseLanePorts {
	return {
		now: () => T0,
		sleep: async () => undefined,
		card: () => undefined,
		registryHarness: () => "claude",
		stopClaude: () => ({ ok: true, handle: "h", detail: "stopped" }),
		enqueueStop: () => undefined,
		paneState: () => "absent",
		killWindow: () => undefined,
		removeCard: () => undefined,
		stopHelper,
		stopHelperScope: async () => "gone",
		unregister: async () => ({ ok: true, detail: "unregistered" }),
		closeConcord: async () => ({ endpoints: 0, agent: "absent" }),
	};
}

test("closeLane asks to stop only the pids the lane registered, reports each, and clears the list", async () => {
	const dir = tempDir();
	try {
		writeLaneRecord(dir, record({ helperPids: [{ pid: 4001, startTime: "100", comm: "node", addedAt: T0 }, { pid: 4002, startTime: "200", addedAt: T0 }, { pid: 4003, startTime: "300", comm: "chrome", addedAt: T0 }] }));
		const asked: number[] = [];
		const result = await closeLane(dir, "cc-qa", { park: false, caller: "orchestrator" }, fakePorts(async (pid) => { asked.push(pid); return pid === 4001 ? "stopped" : pid === 4002 ? "gone" : "reused"; }, []));
		assert.equal(result.ok, true, result.detail);
		assert.deepEqual(asked, [4001, 4002, 4003], "exactly the registered pids");
		assert.match(result.detail, /stopped helper process 4001 \(node\)/);
		assert.match(result.detail, /helper process 4002 had already exited/);
		assert.match(result.detail, /helper process 4003 \(chrome\) was left alone: the pid now belongs to another process/);
		assert.equal(readLaneRecord(dir, "cc-qa")!.helperPids, undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("parking also stops the helpers, and a helper that could not be stopped stays registered with a warning", async () => {
	const dir = tempDir();
	try {
		writeLaneRecord(dir, record({ helperPids: [{ pid: 4101, startTime: "1", addedAt: T0 }, { pid: 4102, startTime: "2", addedAt: T0 }] }));
		const result = await closeLane(dir, "cc-qa", { park: true, caller: "tick" }, fakePorts(async (pid) => { if (pid === 4102) throw new Error("EPERM"); return "stopped"; }, []));
		assert.equal(result.ok, true, result.detail);
		assert.match(result.detail, /helper process 4102 not stopped: EPERM/);
		const after = readLaneRecord(dir, "cc-qa")!;
		assert.equal(after.phase, "parked");
		assert.deepEqual(after.helperPids?.map((h) => h.pid), [4102]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a lane with no registered helper stops nothing", async () => {
	const dir = tempDir();
	try {
		writeLaneRecord(dir, record());
		const result = await closeLane(dir, "cc-qa", { park: false }, fakePorts(async () => { throw new Error("must not be called"); }, []));
		assert.equal(result.ok, true, result.detail);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("stopHelperProcess ends the registered process, leaves a process with another start time and an unregistered one alone", async () => {
	const mine = sleeper();
	const reused = sleeper();
	const bystander = sleeper();
	await new Promise<void>((done) => { setTimeout(done, 100); });
	const mineStart = procStartTime(mine.pid!)!;
	assert.ok(mineStart, "the child has a start time");

	assert.equal(await stopHelperProcess(reused.pid!, "1"), "reused", "a start time that does not match is another process");
	assert.equal(alive(reused.pid!), true);
	assert.equal(await stopHelperProcess(mine.pid!, mineStart, 2_000), "stopped");
	assert.equal(await waitDead(mine), true, "the registered process is gone");
	assert.equal(alive(bystander.pid!), true, "a process nobody registered is untouched");
	assert.equal(await stopHelperProcess(mine.pid!, mineStart), "gone", "a second stop finds it already gone");
});

// ─── muster lane-pid ─────────────────────────────────────────────────────────

function muster(args: string[], env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(LAUNCHER, args, { encoding: "utf8", timeout: 60_000, cwd: HARNESS_ROOT, env: { ...process.env, ...env } });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("muster lane-pid add registers a live process with its start time and refuses a dead pid, a bad pid and a lane with no record", async () => {
	const dir = tempDir();
	const env = { PI_MUSTER_STATE_DIR: dir, CONCORD_AGENT_ID: "" };
	try {
		writeLaneRecord(dir, record());
		const server = sleeper();
		await new Promise<void>((done) => { setTimeout(done, 100); });
		const added = muster(["lane-pid", "add", String(server.pid), "--lane", "cc-qa"], env);
		assert.equal(added.status, 0, added.stderr);
		const helper = readLaneRecord(dir, "cc-qa")!.helperPids?.[0];
		assert.equal(helper?.pid, server.pid);
		assert.equal(helper?.startTime, procStartTime(server.pid!));
		assert.equal(helper?.comm, "sleep");

		const viaEnv = muster(["lane-pid", "add", String(server.pid)], { ...env, CONCORD_AGENT_ID: "cc-qa" });
		assert.equal(viaEnv.status, 0, viaEnv.stderr);
		assert.equal(readLaneRecord(dir, "cc-qa")!.helperPids?.length, 1, "the same pid is listed once");

		server.kill("SIGKILL");
		await waitDead(server);
		assert.equal(muster(["lane-pid", "add", String(server.pid), "--lane", "cc-qa"], env).status, 3, "a process that is gone is refused");
		assert.equal(muster(["lane-pid", "add", "1", "--lane", "cc-qa"], env).status, 2);
		assert.equal(muster(["lane-pid", "add", "abc", "--lane", "cc-qa"], env).status, 2);
		assert.equal(muster(["lane-pid", "add", String(process.pid), "--lane", "cc-none"], env).status, 3, "no record to register against");
		assert.equal(muster(["lane-pid", "add", String(process.pid)], env).status, 2, "no lane at all");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("muster lane-record launch --browser marks the record", () => {
	const dir = tempDir();
	try {
		const out = muster(["lane-record", "launch", "--lane", "cc-qa", "--harness", "claude", "--cwd", "/w/qa", "--browser", "--title", "A browser lane with tabs open"], { PI_MUSTER_STATE_DIR: dir });
		assert.equal(out.status, 0, out.stderr);
		assert.equal(readLaneRecord(dir, "cc-qa")!.browser, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ─── The launcher ────────────────────────────────────────────────────────────

function withLauncherLab(run: (lab: { dir: string; env: NodeJS.ProcessEnv; cwd: string; calls: string; state: string }) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "browser-qa-launch-"));
	const bin = join(dir, "bin");
	mkdirSync(bin);
	const cwd = join(dir, "worktree");
	mkdirSync(cwd);
	const calls = join(dir, "bg-calls.log");
	writeFileSync(join(bin, "claude"), ["#!/bin/sh", `if [ "$1" = "agents" ]; then echo "[]"; exit 0; fi`, `printf 'argv=%s\\n' "$*" >> "${calls}"`, "printf 'backgrounded · deadbeef · lane\\n'", ""].join("\n"));
	chmodSync(join(bin, "claude"), 0o755);
	const state = join(dir, "state", "muster");
	// A lab installation: the launcher refuses a lab state dir under the live agent dir, and a lane record must never land in the live one.
	// The heavy gate keeps its launch stamp and log in the live state dir unless told otherwise: a lab launch must not move them, nor be refused by another launch's stamp.
	const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_LANES_JSON: join(dir, "state", "pi-lanes.json"), PI_CLAUDE_BUS_PLUGIN_DIR: join(dir, "no-plugin"), PI_CODING_AGENT_DIR: dir, PI_MUSTER_STATE_DIR: state, HEAVY_GATE_LAST: join(dir, "gate.last"), HEAVY_GATE_PAUSED_FILE: join(dir, "gate-paused"), HEAVY_GATE_UNITS_CMD: "true", HEAVY_GATE_LOG: join(dir, "gate.log"), HEAVY_GATE_REFUSED_STATE_DIR: join(dir, "gate-refused") };
	try {
		run({ dir, env, cwd, calls, state });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function launch(lab: { env: NodeJS.ProcessEnv; cwd: string }, args: string[]): { status: number | null; output: string } {
	const result = spawnSync(LAUNCH_SCRIPT, ["--harness", "claude", "--lane", "cc-qa", "--cwd", lab.cwd, "--model", "sonnet", "--title", "A browser lane", "--no-goal", ...args], { encoding: "utf8", timeout: 60_000, env: lab.env });
	return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const briefRemovers: Array<() => void> = [];

/** A brief outside /tmp (the launcher refuses one under it), holding `text`. */
function writeBrief(_dir: string, text: string): string {
	const fixture = makeBrief();
	briefRemovers.push(fixture.remove);
	writeFileSync(fixture.path, `# Brief\n\n${text}\n`);
	return fixture.path;
}

test.after(() => {
	for (const remove of briefRemovers) remove();
});

test("--chrome starts the session with Claude in Chrome and marks the lane record as a browser lane", () => {
	withLauncherLab((lab) => {
		const brief = writeBrief(lab.dir, "Check the page.");
		const dry = launch(lab, ["--brief", brief, "--chrome", "--dry-run"]);
		assert.equal(dry.status, 0, dry.output);
		assert.match(dry.output, /--permission-mode bypassPermissions --chrome /);

		const real = launch(lab, ["--brief", brief, "--chrome"]);
		assert.equal(real.status, 0, real.output);
		assert.match(readFileSync(lab.calls, "utf8"), /argv=--bg --name cc-qa --model \S+ --permission-mode bypassPermissions --chrome /);
		assert.equal(readLaneRecord(lab.state, "cc-qa")!.browser, true);
	});
});

test("a brief that names claude-in-chrome marks the record without changing the claude flags, and a plain brief does not", () => {
	withLauncherLab((lab) => {
		const named = writeBrief(lab.dir, "Use the mcp__claude-in-chrome__ tools to check the page.");
		const result = launch(lab, ["--brief", named]);
		assert.equal(result.status, 0, result.output);
		assert.doesNotMatch(readFileSync(lab.calls, "utf8"), /--chrome/);
		assert.equal(readLaneRecord(lab.state, "cc-qa")!.browser, true);
	});
	withLauncherLab((lab) => {
		const result = launch(lab, ["--brief", writeBrief(lab.dir, "Fix the bug.")]);
		assert.equal(result.status, 0, result.output);
		assert.equal(readLaneRecord(lab.state, "cc-qa")!.browser, undefined);
	});
});

test("--chrome is refused for a harness that is not claude", () => {
	withLauncherLab((lab) => {
		const result = spawnSync(LAUNCH_SCRIPT, ["--harness", "pi", "--lane", "pi-qa", "--cwd", lab.cwd, "--chrome", "--dry-run"], { encoding: "utf8", timeout: 60_000, env: lab.env });
		assert.equal(result.status, 2);
		assert.match(`${result.stdout}${result.stderr}`, /--chrome is supported only with --harness claude/);
	});
});
