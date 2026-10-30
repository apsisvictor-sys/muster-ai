/**
 * The inbox waiter (lifecycle WP9, LD10): `muster wait --inbox <lane>` writes its pid file while
 * it runs, exits on the first message printing it the way the hook would, and removes the file.
 */

import "./muster-test-isolation.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listInboxMessages, writeInboxMessage } from "../lib/agent-inbox.ts";
import { findSessionProcess, removeWaiterPid, sessionProcessAlive, waiterAlive, waiterPidFile, writeWaiterPid, type ProcInfo } from "../inbox-waiter.ts";
import { harnessRoot } from "../../core/harness-paths.ts";
import { musterLauncher } from "../../core/pi-ports.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);

const LAUNCHER = musterLauncher();

function tempState(): { root: string; state: string; env: NodeJS.ProcessEnv } {
	const root = mkdtempSync(join(tmpdir(), "muster-inbox-waiter-"));
	const state = join(root, "muster");
	return { root, state, env: { ...process.env, PI_MUSTER_STATE_DIR: state, PI_MUSTER_WAIT_POLL_MS: "50" } };
}

test("the pid file names the waiter while it is alive; a stale, missing or foreign file reads as no waiter", () => {
	const { root, state } = tempState();
	try {
		assert.equal(waiterAlive(state, "sn-a"), false, "no file");
		writeWaiterPid(state, "sn-a", 4321);
		assert.equal(readFileSync(waiterPidFile(state, "sn-a"), "utf8").trim(), "4321");
		assert.equal(waiterAlive(state, "sn-a", (pid) => pid === 4321), true);
		assert.equal(waiterAlive(state, "sn-a", () => false), false, "a dead pid is no waiter");
		removeWaiterPid(state, "sn-a", 9999);
		assert.equal(existsSync(waiterPidFile(state, "sn-a")), true, "a file naming another waiter is not this one's to remove");
		removeWaiterPid(state, "sn-a", 4321);
		assert.equal(existsSync(waiterPidFile(state, "sn-a")), false);
		writeWaiterPid(state, "sn-a", 4321);
		assert.equal(waiterAlive(state, "../escape"), false, "a lane id that is not a lane id reads no file");
		assert.throws(() => waiterPidFile(state, "../escape"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("muster wait --inbox keeps its pid file while it runs, exits on the first message printing the lane delivery, and removes the file", async () => {
	const { root, state, env } = tempState();
	try {
		const child = spawn(LAUNCHER, ["wait", "--inbox", "sn-lane", "--timeout", "30"], { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
		const exited = new Promise<number | null>((done) => child.on("close", (code) => done(code)));

		const deadline = Date.now() + 20_000;
		while (!existsSync(waiterPidFile(state, "sn-lane")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
		assert.equal(existsSync(waiterPidFile(state, "sn-lane")), true, "the pid file appears while the waiter runs");
		assert.equal(waiterAlive(state, "sn-lane"), true);
		assert.equal(Number.parseInt(readFileSync(waiterPidFile(state, "sn-lane"), "utf8"), 10) > 0, true);

		writeInboxMessage(state, { agent: "sn-lane", from: "pi-core", at: new Date().toISOString(), text: "use option B", idempotencyKey: "k1", source: "send", id: "m1" });
		writeInboxMessage(state, { agent: "sn-lane", from: "pi-core", at: new Date(Date.now() + 1).toISOString(), text: "second", idempotencyKey: "k2", source: "send", id: "m2" });
		const code = await Promise.race([exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 20_000))]);
		assert.equal(code, 0, "exits on the first unread message");
		assert.match(stdout, /Muster message for sn-lane from pi-core, sent while you were idle \(this wait woke you\):/);
		assert.match(stdout, /use option B/);
		assert.match(stdout, /Reply with: muster send pi-core --agent sn-lane/);
		assert.equal(existsSync(waiterPidFile(state, "sn-lane")), false, "the pid file is removed on exit");
		assert.equal(waiterAlive(state, "sn-lane"), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("muster wait --inbox --timeout 0 has no expiry: it keeps waiting, exits on a message and removes its pid file", async () => {
	const { root, state, env } = tempState();
	try {
		const child = spawn(LAUNCHER, ["wait", "--inbox", "sn-forever", "--timeout", "0"], { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		let exitedWith: number | null | undefined;
		const exited = new Promise<number | null>((done) => child.on("close", (code) => { exitedWith = code; done(code); }));

		const deadline = Date.now() + 20_000;
		while (!existsSync(waiterPidFile(state, "sn-forever")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
		assert.equal(waiterAlive(state, "sn-forever"), true, stderr);
		// A timeout of 0 must not mean "read once": the process is still waiting well after the first polls.
		await new Promise((r) => setTimeout(r, 1_500));
		assert.equal(exitedWith, undefined, `still waiting (stdout: ${stdout}, stderr: ${stderr})`);
		assert.equal(waiterAlive(state, "sn-forever"), true);

		writeInboxMessage(state, { agent: "sn-forever", from: "pi-core", at: new Date().toISOString(), text: "wake up", idempotencyKey: "z1", source: "send", id: "z1" });
		const code = await Promise.race([exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 20_000))]);
		assert.equal(code, 0);
		assert.match(stdout, /wake up/);
		assert.equal(existsSync(waiterPidFile(state, "sn-forever")), false, "the pid file is removed on exit");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("--timeout 0 is for --inbox only: --lanes and --mailbox refuse it", () => {
	const { root, env } = tempState();
	try {
		for (const args of [["wait", "--lanes", "--timeout", "0"], ["wait", "--lane", "sn-a", "--timeout", "0"], ["wait", "--mailbox", "orch", "--timeout", "0"]]) {
			const refused = spawnSync(LAUNCHER, args, { encoding: "utf8", env, timeout: 30_000 });
			assert.equal(refused.status, 2, `${args.join(" ")}: ${refused.stdout}${refused.stderr}`);
			assert.match(refused.stderr, /--timeout 0 \(no timeout\) is for --inbox only/);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the orchestrator's wait keeps its one-line format, and a timeout removes the pid file too", () => {
	const { root, state, env } = tempState();
	try {
		writeInboxMessage(state, { agent: "orchestrator", from: "pi-core", at: "2026-10-12T00:00:00.000Z", text: "REVIEW READY: x@abc", idempotencyKey: "o1", source: "send", id: "o1" });
		const first = spawnSync(LAUNCHER, ["wait", "--inbox", "orchestrator", "--timeout", "5"], { encoding: "utf8", env, timeout: 30_000 });
		assert.equal(first.status, 0, first.stderr);
		assert.match(first.stdout, /muster wait: orchestrator inbox: pi-core -> REVIEW READY: x@abc/);

		const idle = spawnSync(LAUNCHER, ["wait", "--inbox", "sn-quiet", "--timeout", "1"], { encoding: "utf8", env, timeout: 30_000 });
		assert.equal(idle.status, 4, "nothing arrived");
		assert.equal(existsSync(waiterPidFile(state, "sn-quiet")), false);
		assert.equal(listInboxMessages(state, "sn-quiet").length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// --- the waiter follows its session process (N4) ---

test("findSessionProcess returns the nearest claude or pi ancestor, never itself, and nothing when there is none", () => {
	const table = new Map<number, ProcInfo>([
		[900, { ppid: 1, comm: "tmux: server", args: [] }],
		[500, { ppid: 900, comm: "claude", args: ["claude", "--bg"] }],
		[400, { ppid: 500, comm: "claude", args: ["claude", "daemon"] }],
		[300, { ppid: 400, comm: "bash", args: ["bash", "-c", "muster wait"] }],
		[200, { ppid: 300, comm: "node", args: ["node", "/x/muster.mts", "wait"] }],
		[700, { ppid: 900, comm: "node", args: ["node", "/home/v/.npm-global/bin/pi"] }],
		[650, { ppid: 700, comm: "sh", args: ["sh"] }],
		[640, { ppid: 650, comm: "node", args: ["node", "/x/muster.mts"] }],
		[610, { ppid: 900, comm: "sh", args: ["sh"] }],
		[600, { ppid: 610, comm: "node", args: ["node", "/x/other.js"] }],
		[800, { ppid: 500, comm: "claude", args: ["claude"] }],
		[550, { ppid: 900, comm: "2.1.296", args: ["claude", "bg-spare", "--bg-spare"] }],
		[540, { ppid: 550, comm: "bash", args: ["bash", "-c"] }],
		[530, { ppid: 540, comm: "MainThread", args: ["/x/bin/node", "/x/muster.mts"] }],
		[720, { ppid: 900, comm: "MainThread", args: ["/x/bin/node", "/home/v/.npm-global/bin/pi"] }],
		[710, { ppid: 720, comm: "MainThread", args: ["/x/bin/node", "/x/muster.mts"] }],
		// The real shape, read from /proc on 2026-10-17: a background session rewrites its title, so argv[0]
		// is one string with a space and argv[1] is the next flag. A waiter armed under it never followed it.
		[560, { ppid: 900, comm: "2.1.300", args: ["claude bg-spare", "--bg-spare", "/tmp/cc-daemon/spare/x.claim.sock"] }],
		[561, { ppid: 560, comm: "bash", args: ["/bin/bash", "-c", "muster wait --inbox architect --timeout 0"] }],
		[562, { ppid: 561, comm: "MainThread", args: ["/x/bin/node", "--import", "/x/tsx/loader.mjs", "/x/scripts/muster.mts", "wait"] }],
		[570, { ppid: 900, comm: "2.1.300", args: ["claude-ish tool"] }],
		[571, { ppid: 570, comm: "MainThread", args: ["/x/bin/node", "/x/muster.mts"] }],
	]);
	const read = (pid: number): ProcInfo | undefined => table.get(pid);
	const startTime = (pid: number): string => `start-${pid}`;
	assert.deepEqual(findSessionProcess({ from: 200, read, startTime }), { pid: 400, startTime: "start-400" }, "the nearest ancestor wins");
	assert.deepEqual(findSessionProcess({ from: 640, read, startTime }), { pid: 700, startTime: "start-700" }, "a node host running a pi script counts");
	assert.deepEqual(findSessionProcess({ from: 530, read, startTime }), { pid: 550, startTime: "start-550" }, "a background session runs under a version-number comm, found by argv[0]");
	assert.equal(findSessionProcess({ from: 562, read, startTime })?.pid, 560, "a background session whose argv[0] is its rewritten title, `claude bg-spare`");
	assert.equal(findSessionProcess({ from: 571, read, startTime }), undefined, "a title that only starts with the letters claude is not a session");
	assert.equal(findSessionProcess({ from: 710, read, startTime })?.pid, 720, "a MainThread host running pi counts");
	assert.equal(findSessionProcess({ from: 600, read, startTime }), undefined, "no claude or pi above it");
	assert.equal(findSessionProcess({ from: 800, read, startTime })?.pid, 500, "the start process is never its own session");
	assert.equal(findSessionProcess({ from: 12345, read, startTime }), undefined, "an unreadable process answers nothing");
});

test("sessionProcessAlive is false for a dead pid and for a pid another process now holds", () => {
	const session = { pid: 4242, startTime: "100" };
	assert.equal(sessionProcessAlive(session, { pidAlive: () => true, startTime: () => "100" }), true);
	assert.equal(sessionProcessAlive(session, { pidAlive: () => false, startTime: () => "100" }), false);
	assert.equal(sessionProcessAlive(session, { pidAlive: () => true, startTime: () => "101" }), false, "a reused pid has another start time");
});

/** A node binary that calls itself `claude`, running a script that starts the waiter under `sh` so its exit code survives the session. */
function fakeClaudeSession(root: string, env: NodeJS.ProcessEnv, agent: string): { claudePid: number; codeFile: string; stdoutFile: string; stderrFile: string } {
	const bin = join(root, "bin");
	mkdirSync(bin, { recursive: true });
	symlinkSync(process.execPath, join(bin, "claude"));
	const codeFile = join(root, "code");
	const stdoutFile = join(root, "waiter.out");
	const stderrFile = join(root, "waiter.err");
	const script = join(root, "fake-session.js");
	writeFileSync(script, `require("node:child_process").spawn("sh", ["-c", ${JSON.stringify(`"${LAUNCHER}" wait --inbox ${agent} --timeout 0 >"${stdoutFile}" 2>"${stderrFile}"; echo $? >"${codeFile}"`)}], { stdio: "ignore" });\nsetInterval(() => {}, 1000);\n`);
	const child = spawn(join(bin, "claude"), [script], { env, stdio: "ignore" });
	child.unref();
	return { claudePid: child.pid!, codeFile, stdoutFile, stderrFile };
}

async function until(condition: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (!condition() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
	return condition();
}

test("a waiter whose session process is gone exits 0 and leaves the message in inbox/ (N4)", async () => {
	const { root, state, env } = tempState();
	let claudePid: number | undefined;
	try {
		const session = fakeClaudeSession(root, env, "sn-retired");
		claudePid = session.claudePid;
		assert.equal(await until(() => existsSync(waiterPidFile(state, "sn-retired")), 20_000), true, "the waiter armed under the fake session");
		process.kill(session.claudePid, "SIGKILL");
		writeInboxMessage(state, { agent: "sn-retired", from: "pi-core", at: new Date().toISOString(), text: "for a dead session", idempotencyKey: "d1", source: "send", id: "d1" });
		assert.equal(await until(() => existsSync(session.codeFile), 20_000), true, "the waiter ended");
		assert.equal(readFileSync(session.codeFile, "utf8").trim(), "0");
		assert.equal(readFileSync(session.stdoutFile, "utf8"), "", "nothing was printed to the dead session");
		assert.match(readFileSync(session.stderrFile, "utf8"), /session that armed this wait .* is gone; \d message\(s\) stay in sn-retired's inbox/);
		assert.deepEqual(listInboxMessages(state, "sn-retired").map((message) => message.id), ["d1"], "the message is still pending");
		assert.equal(existsSync(join(state, "inbox", "sn-retired", "read")) && readdirSync(join(state, "inbox", "sn-retired", "read")).length > 0, false, "nothing was marked read");
		assert.equal(waiterAlive(state, "sn-retired"), false, "the pid file is removed");
	} finally {
		if (claudePid !== undefined) try { process.kill(claudePid, "SIGKILL"); } catch { /* already gone */ }
		rmSync(root, { recursive: true, force: true });
	}
});

test("a waiter whose session process is alive delivers and marks the message read as before (N4)", async () => {
	const { root, state, env } = tempState();
	let claudePid: number | undefined;
	try {
		const session = fakeClaudeSession(root, env, "sn-live");
		claudePid = session.claudePid;
		assert.equal(await until(() => existsSync(waiterPidFile(state, "sn-live")), 20_000), true);
		writeInboxMessage(state, { agent: "sn-live", from: "pi-core", at: new Date().toISOString(), text: "for a live session", idempotencyKey: "l1", source: "send", id: "l1" });
		assert.equal(await until(() => existsSync(session.codeFile), 20_000), true, "the waiter ended");
		assert.equal(readFileSync(session.codeFile, "utf8").trim(), "0");
		assert.match(readFileSync(session.stdoutFile, "utf8"), /for a live session/);
		assert.deepEqual(listInboxMessages(state, "sn-live"), [], "the message moved into read/");
	} finally {
		if (claudePid !== undefined) try { process.kill(claudePid, "SIGKILL"); } catch { /* already gone */ }
		rmSync(root, { recursive: true, force: true });
	}
});
