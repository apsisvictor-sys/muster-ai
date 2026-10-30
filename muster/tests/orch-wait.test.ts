/**
 * `orch-wait.sh` — the one orchestrator waiter (efficiency plan WP2, section 1).
 *
 * The waiter reads only the eight event kinds, from a saved offset, drops the
 * scratch and proof lanes, and applies the collect window (R5). These tests run
 * the real script against fixture files; the collect window is set to 0 so one
 * pass is enough, and the no-event timeout likewise, so no test sleeps. A lane
 * handoff (REVIEW READY, BLOCKED, QUESTION) shortens the window to
 * PRIORITY_COLLECT_WINDOW_S (WAITWIN), driven below by that env var.
 *
 * The waiter also reads the orchestrator's bus inbox through the `muster inbox`
 * CLI. Every run is pointed at a fixture Muster state dir (never the real one),
 * so no test can read or move a real message.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentInboxReadDir, listInboxMessages, writeInboxMessage } from "../lib/agent-inbox.ts";
import { writeLaneRecord, type LaneRecord } from "../lane-lifecycle.ts";
import { harnessRoot } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
const SCRIPT = join(HARNESS_ROOT, "muster", "scripts", "orch-wait.sh");
// The waiter moved into muster's package (OL12-D8): Pi's path is the wrapper
// that execs it, and the waiter's own source lives in the package.
const WAITER_SOURCE = join(HARNESS_ROOT, "muster", "scripts", "orch-wait.sh");
const MUSTER = join(piAgentDir(), "extensions", "muster", "launchers", "muster");

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "orch-wait-"));
	const events = join(root, "orchestrator-events.log");
	const offset = join(root, "orch-wait.offset");
	const state = join(root, "state", "muster");
	return { root, events, offset, state, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function typedTranscript(root: string, atMs: number): string {
	const path = join(root, "transcript.jsonl");
	const line = JSON.stringify({ type: "user", timestamp: new Date(atMs).toISOString(), message: { role: "user", content: "stop and tell me where things are" } });
	writeFileSync(path, line + "\n");
	return path;
}

function machineTranscript(root: string): string {
	const path = join(root, "machine.jsonl");
	const rows = [
		{ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: "Another Claude session sent a message:\nhi" } },
		{ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: "<task-notification>\n<task-id>x</task-id>" } },
	];
	writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
	return path;
}

function runEnv(fx: { events: string; offset: string; state: string }, transcript: string, env: Record<string, string> = {}): NodeJS.ProcessEnv {
	return {
		...process.env,
		ORCH_MUSTER: MUSTER,
		PI_MUSTER_STATE_DIR: fx.state,
		ORCH_EVENTS: fx.events,
		ORCH_WAIT_OFFSET: fx.offset,
		ORCH_TRANSCRIPT: transcript,
		ORCH_COLLECT_WINDOW_S: "0",
		ORCH_NO_EVENT_S: "0",
		ORCH_POLL_S: "1",
		...env,
	};
}

function run(fx: { events: string; offset: string; state: string }, transcript: string, env: Record<string, string> = {}) {
	return spawnSync("bash", [SCRIPT], { encoding: "utf8", timeout: 60_000, env: runEnv(fx, transcript, env) });
}

test("the waiter prints only the eight event kinds and drops scratch and proof lanes", () => {
	const fx = fixture();
	try {
		const stamp = "2026-10-09T21:45:03+03:00";
		writeFileSync(
			fx.events,
			[
				`${stamp} REVIEW READY: pi-wp2 lane/wp2-wake-path@abc1234 | done`,
				`${stamp} BLOCKED: pi-wp2 | waiting on a decision`,
				`${stamp} QUESTION: pi-wp2 | which one?`,
				`${stamp} ALREADY DONE: pi-wp2 | commit abc`,
				`${stamp} STALLED: pi-core | no session write for 46 min`,
				`${stamp} QUOTA WALL: pi-core | weekly-plan-limit resets 2026-10-21T08:20:12Z`,
				`${stamp} CRASHED: pi:0 | window missing`,
				`${stamp} ASLEEP: cc-w | a message from henry is queued for the asleep lane (its process is gone); wake it with \`muster resume cc-w\``,
				`${stamp} WORKING: pi-wp2 | mid-way`,
				`${stamp} turn ended (stop): pi-wp2 idle`,
				`${stamp} REVIEW READY: cc-scratch-a l@abc | scratch noise`,
				`${stamp} REVIEW READY: sn-verify-p l@abc | proof noise`,
			].join("\n") + "\n",
		);
		const result = run(fx, machineTranscript(fx.root));
		assert.equal(result.status, 0, result.stderr);
		const out = result.stdout;
		for (const kind of ["REVIEW READY", "BLOCKED", "QUESTION", "ALREADY DONE", "STALLED", "QUOTA WALL", "CRASHED", "ASLEEP"]) {
			assert.match(out, new RegExp(`^.*${kind}: `, "m"), `${kind} should wake the orchestrator`);
		}
		assert.doesNotMatch(out, /WORKING:/);
		assert.doesNotMatch(out, /turn ended/);
		assert.doesNotMatch(out, /cc-scratch-a/);
		assert.doesNotMatch(out, /sn-verify-p/);
	} finally {
		fx.cleanup();
	}
});

test("with no event the waiter exits with the line `no events`", () => {
	const fx = fixture();
	try {
		writeFileSync(fx.events, "");
		const result = run(fx, machineTranscript(fx.root));
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim(), "no events");
	} finally {
		fx.cleanup();
	}
});

test("the saved offset means an event is printed once and never re-read", () => {
	const fx = fixture();
	try {
		writeFileSync(fx.events, "2026-10-09T21:45:03+03:00 REVIEW READY: pi-wp2 b@abc | done\n");
		const first = run(fx, machineTranscript(fx.root));
		assert.match(first.stdout, /REVIEW READY: pi-wp2/);
		assert.equal(readFileSync(fx.offset, "utf8").trim(), String(Buffer.byteLength("2026-10-09T21:45:03+03:00 REVIEW READY: pi-wp2 b@abc | done\n")));
		const second = run(fx, machineTranscript(fx.root));
		assert.equal(second.stdout.trim(), "no events");
	} finally {
		fx.cleanup();
	}
});

test("a typed message within the chatting window wakes at once, before the collect window elapses", () => {
	const fx = fixture();
	try {
		writeFileSync(fx.events, "2026-10-09T21:45:03+03:00 QUOTA WALL: pi-core | weekly-plan-limit\n");
		const transcript = typedTranscript(fx.root, Date.now());
		// A one-hour collect window: only the chatting exception can end the wait at once.
		const result = run(fx, transcript, { ORCH_COLLECT_WINDOW_S: "3600", ORCH_CHATTING_WINDOW_S: "600" });
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /QUOTA WALL: pi-core/);
	} finally {
		fx.cleanup();
	}
});

test("a machine message is not the operator chatting: the waiter holds the collect window", () => {
	const fx = fixture();
	try {
		writeFileSync(fx.events, "2026-10-09T21:45:03+03:00 QUOTA WALL: pi-core | weekly-plan-limit\n");
		// 1 s collect window still proves the chatting path was not taken before the window test;
		// the helper must report nothing for machine input.
		const result = run(fx, machineTranscript(fx.root), { ORCH_COLLECT_WINDOW_S: "1" });
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /QUOTA WALL: pi-core/);
	} finally {
		fx.cleanup();
	}
});

test("an exact duplicate line within one run is printed once, a different line is kept", () => {
	const fx = fixture();
	try {
		const twice = "2026-10-09T21:45:03+03:00 REVIEW READY: sn-s1 lane/s1@abc | done\n";
		writeFileSync(fx.events, twice + twice + "2026-10-09T21:45:04+03:00 REVIEW READY: sn-s1 lane/s1@abc | done\n" + twice);
		const result = run(fx, machineTranscript(fx.root));
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.split("\n").filter((l) => l.includes("REVIEW READY")).length, 2);
		// The offset still covers the whole file: duplicates are dropped from output, not left unread.
		assert.equal(readFileSync(fx.offset, "utf8").trim(), String(Buffer.byteLength(twice) * 3 + Buffer.byteLength("2026-10-09T21:45:04+03:00 REVIEW READY: sn-s1 lane/s1@abc | done\n")));
	} finally {
		fx.cleanup();
	}
});

// ---- the orchestrator's bus inbox ----

const inboxLines = (out: string): string[] => out.split("\n").filter((line) => line.includes(" INBOX: "));

test("a message sent to the orchestrator is printed once with time, sender, the whole text on one line and path, then marked read", () => {
	const fx = fixture();
	try {
		writeFileSync(fx.events, "");
		writeInboxMessage(fx.state, { agent: "orchestrator", from: "grokbot", at: "2026-10-10T20:50:11.000Z", text: "Gateway test done\nsecond line is printed too", idempotencyKey: "k1", source: "send" });
		const first = run(fx, machineTranscript(fx.root));
		assert.equal(first.status, 0, first.stderr);
		const lines = inboxLines(first.stdout);
		assert.equal(lines.length, 1, first.stdout);
		assert.match(lines[0]!, /^2026-10-1[01]T\S+ INBOX: grokbot \| Gateway test done\\nsecond line is printed too \| \S+\/read\/\d+-[0-9a-f-]+\.json$/);
		assert.match(first.stdout, /second line is printed too/);
		assert.equal(listInboxMessages(fx.state, "orchestrator").length, 0, "marked read after the print");
		const printedPath = lines[0]!.split(" | ").at(-1)!;
		assert.ok(existsSync(printedPath), "the printed path is where the message now lives");
		assert.ok(printedPath.startsWith(agentInboxReadDir(fx.state, "orchestrator")));
		const second = run(fx, machineTranscript(fx.root));
		assert.equal(second.stdout.trim(), "no events", "a read message is never printed again");
	} finally {
		fx.cleanup();
	}
});

test("a message that arrives while the waiter is armed wakes it within one poll", async () => {
	const fx = fixture();
	try {
		writeFileSync(fx.events, "");
		const started = Date.now();
		const child = spawn("bash", [SCRIPT], { env: runEnv(fx, machineTranscript(fx.root), { ORCH_NO_EVENT_S: "120", ORCH_POLL_S: "1" }), stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
		const exited = new Promise<number | null>((resolveExit) => child.on("close", resolveExit));
		// Let the first pass find nothing, then write the message the way `muster send` and the gateway do.
		await new Promise((resolveWait) => setTimeout(resolveWait, 2500));
		writeInboxMessage(fx.state, { agent: "orchestrator", from: "grokbot", at: new Date().toISOString(), text: "wake up", idempotencyKey: "k2", source: "send" });
		const code = await Promise.race([exited, new Promise<"hung">((resolveHang) => setTimeout(() => resolveHang("hung"), 30_000))]);
		if (code === "hung") child.kill();
		assert.equal(code, 0, stdout);
		assert.equal(inboxLines(stdout).length, 1, stdout);
		assert.match(stdout, /INBOX: grokbot \| wake up \|/);
		assert.ok(Date.now() - started < 25_000, "woke within a few polls, not at the 120 s timeout");
		assert.equal(listInboxMessages(fx.state, "orchestrator").length, 0);
	} finally {
		fx.cleanup();
	}
});

test("a lane report is printed once: its inbox notice is marked read when the events file has the same report", () => {
	const fx = fixture();
	try {
		const at = new Date();
		const stamp = at.toISOString();
		writeFileSync(fx.events, `${stamp} REVIEW READY: gw-wake lane/gw-wake@abc1234 | waiter reads the inbox\n`);
		writeInboxMessage(fx.state, { agent: "orchestrator", from: "gw-wake", at: stamp, text: "REVIEW READY: lane/gw-wake@abc1234 (base a24b871) \u2014 waiter reads the inbox", idempotencyKey: "report:gw-wake:1", source: "report" });
		writeInboxMessage(fx.state, { agent: "orchestrator", from: "gw-wake", at: stamp, text: "BLOCKED: no events line for this one (needs: nothing)", idempotencyKey: "report:gw-wake:2", source: "report" });
		const result = run(fx, machineTranscript(fx.root));
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.split("\n").filter((line) => line.includes("REVIEW READY")).length, 1, result.stdout);
		assert.equal(inboxLines(result.stdout).length, 1, "only the notice without an events line is printed");
		assert.match(inboxLines(result.stdout)[0]!, /INBOX: gw-wake \| BLOCKED: no events line/);
		assert.equal(listInboxMessages(fx.state, "orchestrator").length, 0, "the duplicate is marked read too");
	} finally {
		fx.cleanup();
	}
});

test("a second report from the same lane with another sha is not taken for a duplicate", () => {
	const fx = fixture();
	try {
		const stamp = new Date().toISOString();
		writeFileSync(fx.events, `${stamp} REVIEW READY: gw-wake lane/gw-wake@abc1234 | first\n`);
		writeInboxMessage(fx.state, { agent: "orchestrator", from: "gw-wake", at: stamp, text: "REVIEW READY: lane/gw-wake@def5678 \u2014 send-back fix", idempotencyKey: "report:gw-wake:3", source: "report" });
		const result = run(fx, machineTranscript(fx.root));
		assert.equal(inboxLines(result.stdout).length, 1, result.stdout);
		assert.match(result.stdout, /INBOX: gw-wake \| REVIEW READY: lane\/gw-wake@def5678/);
	} finally {
		fx.cleanup();
	}
});

test("a notice from a scratch lane is marked read without a print", () => {
	const fx = fixture();
	try {
		writeFileSync(fx.events, "");
		writeInboxMessage(fx.state, { agent: "orchestrator", from: "cc-scratch-a", at: new Date().toISOString(), text: "REVIEW READY: l@abc \u2014 noise", idempotencyKey: "report:s:1", source: "report" });
		const result = run(fx, machineTranscript(fx.root));
		assert.equal(result.stdout.trim(), "no events");
		assert.equal(listInboxMessages(fx.state, "orchestrator").length, 0);
	} finally {
		fx.cleanup();
	}
});

test("a waiter that dies before it prints leaves the message pending", () => {
	const fx = fixture();
	try {
		writeFileSync(fx.events, "");
		writeInboxMessage(fx.state, { agent: "orchestrator", from: "gw-wake", at: new Date().toISOString(), text: "held in the collect window", idempotencyKey: "k3", source: "send" });
		// A one-hour collect window: the waiter holds the message and is killed by the test timeout.
		const result = spawnSync("bash", [SCRIPT], { encoding: "utf8", timeout: 8_000, killSignal: "SIGKILL", env: runEnv(fx, machineTranscript(fx.root), { ORCH_COLLECT_WINDOW_S: "3600" }) });
		assert.equal(result.stdout, "", "nothing was printed yet");
		assert.equal(listInboxMessages(fx.state, "orchestrator").length, 1, "still pending, so the next waiter prints it");
	} finally {
		fx.cleanup();
	}
});

// ---- priority senders: someone is waiting, so the collect window is skipped ----

/** Run the waiter with a one-hour collect window and a 1 s poll; resolves with how long it took. */
async function runLong(fx: { events: string; offset: string; state: string; root: string }, limitMs: number, env: Record<string, string> = {}) {
	const started = Date.now();
	const child = spawn("bash", [SCRIPT], { env: runEnv(fx, machineTranscript(fx.root), { ORCH_COLLECT_WINDOW_S: "3600", ORCH_NO_EVENT_S: "3600", ORCH_POLL_S: "1", ...env }), stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
	const exited = new Promise<number | null>((resolveExit) => child.on("close", resolveExit));
	const code = await Promise.race([exited, new Promise<"held">((resolveHeld) => setTimeout(() => resolveHeld("held"), limitMs))]);
	if (code === "held") { child.kill("SIGKILL"); await exited; }
	return { code, stdout, ms: Date.now() - started };
}

for (const from of ["grokbot", "operator", "operator:telegram"]) {
	test(`an inbox message from ${from} skips the collect window and wakes within one poll`, async () => {
		const fx = fixture();
		try {
			writeFileSync(fx.events, "");
			writeInboxMessage(fx.state, { agent: "orchestrator", from, at: new Date().toISOString(), text: "answer me now", idempotencyKey: `p-${from}`, source: "send" });
			const result = await runLong(fx, 15_000);
			assert.equal(result.code, 0, `held for the collect window: ${result.stdout}`);
			assert.match(result.stdout, new RegExp(`INBOX: ${from} \\| answer me now \\|`));
			assert.ok(result.ms < 8_000, `woke after ${result.ms} ms`);
			assert.equal(listInboxMessages(fx.state, "orchestrator").length, 0);
		} finally {
			fx.cleanup();
		}
	});
}

test("a priority message prints the lane events already collected with it, in one wake", async () => {
	const fx = fixture();
	try {
		writeFileSync(fx.events, "2026-10-12T01:00:00+03:00 REVIEW READY: pi-wp2 lane/wp2@abc1234 | done\n");
		writeInboxMessage(fx.state, { agent: "orchestrator", from: "grokbot", at: new Date().toISOString(), text: "Henry is waiting", idempotencyKey: "p-batch", source: "send" });
		const result = await runLong(fx, 15_000);
		assert.equal(result.code, 0, result.stdout);
		assert.match(result.stdout, /REVIEW READY: pi-wp2/);
		assert.match(result.stdout, /INBOX: grokbot \| Henry is waiting/);
	} finally {
		fx.cleanup();
	}
});

test("a non-priority lane event and its lane report still batch: the waiter holds the collect window", async () => {
	const fx = fixture();
	try {
		const stamp = new Date().toISOString();
		writeFileSync(fx.events, `${stamp} ALREADY DONE: gw-wake | commit abc1234\n`);
		writeInboxMessage(fx.state, { agent: "orchestrator", from: "gw-wake", at: stamp, text: "ALREADY DONE: commit abc1234", idempotencyKey: "r-batch", source: "report" });
		writeInboxMessage(fx.state, { agent: "orchestrator", from: "pi-wp2", at: stamp, text: "a note from a lane", idempotencyKey: "r-note", source: "send" });
		const result = await runLong(fx, 5_000);
		assert.equal(result.code, "held", `a lane message must not end the wait: ${result.stdout}`);
		assert.equal(result.stdout, "");
		assert.equal(listInboxMessages(fx.state, "orchestrator").length, 2, "nothing was marked read while the window was open");
	} finally {
		fx.cleanup();
	}
});

test("ORCH_PRIORITY_SENDERS replaces the priority set", async () => {
	const fx = fixture();
	try {
		writeFileSync(fx.events, "");
		writeInboxMessage(fx.state, { agent: "orchestrator", from: "grokbot", at: new Date().toISOString(), text: "no longer priority", idempotencyKey: "p-env", source: "send" });
		const result = await runLong(fx, 5_000, { ORCH_PRIORITY_SENDERS: "henry" });
		assert.equal(result.code, "held", result.stdout);
	} finally {
		fx.cleanup();
	}
});

test("a priority message is marked read only after the waiter printed it", () => {
	const fx = fixture();
	try {
		writeFileSync(fx.events, "");
		const out = join(fx.root, "stdout.txt");
		const log = join(fx.root, "mark.log");
		const fake = join(fx.root, "muster-fake");
		// `inbox list` lists the message until `inbox read` ran; `inbox read` records how many bytes the waiter had printed by then.
		writeFileSync(fake, [
			"#!/usr/bin/env bash",
			`marker=${JSON.stringify(join(fx.root, "marked"))}`,
			'if [ "$1 $2" = "inbox list" ]; then',
			'  [ -e "$marker" ] || printf \'m1\\t2026-10-12T01:00:00.000Z\\tgrokbot\\tsend\\t/tmp/m1.json\\tcome back to Henry\\n\'',
			'elif [ "$1 $2" = "inbox read" ]; then',
			`  wc -c <${JSON.stringify(out)} >${JSON.stringify(log)}`,
			'  : >"$marker"',
			"fi",
			"",
		].join("\n"));
		chmodSync(fake, 0o755);
		const result = spawnSync("bash", ["-c", `bash ${JSON.stringify(SCRIPT)} >${JSON.stringify(out)}`], { encoding: "utf8", timeout: 30_000, env: runEnv(fx, machineTranscript(fx.root), { ORCH_MUSTER: fake, ORCH_COLLECT_WINDOW_S: "3600", ORCH_NO_EVENT_S: "3600" }) });
		assert.equal(result.status, 0, result.stderr);
		const printed = readFileSync(out, "utf8");
		assert.match(printed, /INBOX: grokbot \| come back to Henry \| \/tmp\/m1\.json/);
		assert.equal(Number(readFileSync(log, "utf8").trim()), Buffer.byteLength(printed), "the whole line was on stdout when the message was marked read");
	} finally {
		fx.cleanup();
	}
});

// ---- WAITWIN: a lane handoff wakes in 3 minutes, everything else keeps the 20-minute batch ----

/** Run the waiter with a one-hour long window and a 2 s priority window, appending one line `afterMs` into the run. */
async function runStaged(fx: { events: string; offset: string; state: string; root: string }, limitMs: number, staged: { afterMs: number; line: string }, env: Record<string, string> = {}) {
	const started = Date.now();
	const child = spawn("bash", [SCRIPT], { env: runEnv(fx, machineTranscript(fx.root), { ORCH_COLLECT_WINDOW_S: "3600", ORCH_NO_EVENT_S: "3600", ORCH_POLL_S: "1", ORCH_PRIORITY_COLLECT_WINDOW_S: "2", ...env }), stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
	const timer = setTimeout(() => { appendFileSync(fx.events, staged.line); }, staged.afterMs);
	const exited = new Promise<number | null>((resolveExit) => child.on("close", resolveExit));
	const code = await Promise.race([exited, new Promise<"held">((resolveHeld) => setTimeout(() => resolveHeld("held"), limitMs))]);
	clearTimeout(timer);
	if (code === "held") { child.kill("SIGKILL"); await exited; }
	return { code, stdout, ms: Date.now() - started };
}

const LANE_HANDOFFS: Array<[string, string]> = [
	["REVIEW READY", "2026-10-27T18:26:00+02:00 REVIEW READY: gw-waitwin lane/waitwin@abc1234 | tests green"],
	["BLOCKED", "2026-10-27T18:26:00+02:00 BLOCKED: gw-waitwin | needs a schema decision"],
	["QUESTION", "2026-10-27T18:26:00+02:00 QUESTION: gw-waitwin | which owner?"],
];

for (const [kind, line] of LANE_HANDOFFS) {
	test(`a ${kind} lane event wakes inside the short priority window, not the 20-minute batch`, async () => {
		const fx = fixture();
		try {
			writeFileSync(fx.events, line + "\n");
			const result = await runLong(fx, 25_000, { ORCH_PRIORITY_COLLECT_WINDOW_S: "2" });
			assert.equal(result.code, 0, `held for the long window: ${result.stdout}`);
			assert.match(result.stdout, new RegExp(`${kind}: gw-waitwin`));
			assert.ok(result.ms < 10_000, `woke after ${result.ms} ms with a 2 s priority window and a 3600 s long one`);
			assert.equal(readFileSync(fx.offset, "utf8").trim(), String(Buffer.byteLength(line + "\n")), "the wake delivered the event and advanced the saved offset");
		} finally {
			fx.cleanup();
		}
	});
}

const BATCHED_KINDS: Array<[string, string]> = [
	["ALREADY DONE", "2026-10-27T18:26:00+02:00 ALREADY DONE: gw-waitwin | commit abc1234"],
	["STALLED", "2026-10-27T18:26:00+02:00 STALLED: pi-core | no session write for 46 min"],
	["QUOTA WALL", "2026-10-27T18:26:00+02:00 QUOTA WALL: pi-core | weekly-plan-limit resets 2026-10-21T08:20:12Z"],
];

for (const [kind, line] of BATCHED_KINDS) {
	test(`a ${kind} event still batches for the long window`, async () => {
		const fx = fixture();
		try {
			writeFileSync(fx.events, line + "\n");
			const result = await runLong(fx, 6_000, { ORCH_PRIORITY_COLLECT_WINDOW_S: "2" });
			assert.equal(result.code, "held", `a non-priority event must not end the wait: ${result.stdout}`);
			assert.equal(result.stdout, "", "nothing is printed while the long window is open");
		} finally {
			fx.cleanup();
		}
	});
}

test("a priority event arriving inside an open long window shortens it", async () => {
	const fx = fixture();
	try {
		writeFileSync(fx.events, "2026-10-27T18:26:00+02:00 ALREADY DONE: gw-live | commit abc1234\n");
		const result = await runStaged(fx, 30_000, { afterMs: 2_000, line: "2026-10-27T18:30:00+02:00 REVIEW READY: gw-waitwin lane/waitwin@def5678 | done\n" });
		assert.equal(result.code, 0, `held for the long window: ${result.stdout}`);
		assert.match(result.stdout, /ALREADY DONE: gw-live/, "the batch keeps the earlier, non-priority line");
		assert.match(result.stdout, /REVIEW READY: gw-waitwin/);
		assert.ok(result.ms < 15_000, `woke after ${result.ms} ms; the 3600 s long window alone would not have woken it`);
	} finally {
		fx.cleanup();
	}
});

test("the short window is 180 s by default and named once", async () => {
	const source = readFileSync(WAITER_SOURCE, "utf8");
	assert.match(source, /^PRIORITY_COLLECT_WINDOW_S=\$\{ORCH_PRIORITY_COLLECT_WINDOW_S:-180\}/m, "the default is 3 minutes");
	assert.equal(source.match(/PRIORITY_COLLECT_WINDOW_S=/g)?.length, 1, "the constant is named once");
	const fx = fixture();
	try {
		writeFileSync(fx.events, "2026-10-27T18:26:00+02:00 REVIEW READY: gw-waitwin lane/waitwin@abc1234 | done\n");
		// No override: a 6 s observation stays far inside the 3-minute window.
		const result = await runLong(fx, 6_000, { ORCH_PRIORITY_COLLECT_WINDOW_S: "" });
		assert.equal(result.code, "held", `woke before the default window elapsed: ${result.stdout}`);
	} finally {
		fx.cleanup();
	}
});

// ─── The seat as the source of "the operator is chatting", and SEAT LOST (seats blueprint, WP-S4 item 4) ───

/** A `muster` stand-in: `seat show` answers from STUB_SEAT_JSON, `inbox list` exits with STUB_INBOX_RC. */
function stubMuster(root: string): string {
	const path = join(root, "muster-stub");
	writeFileSync(path, [
		"#!/usr/bin/env bash",
		'case "$1 $2" in',
		'  "seat show") cat "$STUB_SEAT_JSON" 2>/dev/null || exit 1 ;;',
		'  "inbox list") [ "${STUB_INBOX_RC:-0}" = 0 ] || { echo "muster inbox: refused" >&2; exit "$STUB_INBOX_RC"; } ;;',
		"esac",
		"exit 0",
		"",
	].join("\n"));
	chmodSync(path, 0o755);
	return path;
}

function seatJson(root: string, epoch: number, lastTypedAt?: string): string {
	const path = join(root, "seat.json");
	writeFileSync(path, JSON.stringify({ role: "orchestrator", epoch, holder: epoch === 0 ? null : { harness: "pi", sessionId: "s", ...(lastTypedAt !== undefined ? { lastTypedAt } : {}) } }));
	return path;
}

function runStub(fx: { root: string; events: string; offset: string; state: string }, seatFile: string, transcript: string, env: Record<string, string> = {}) {
	const started = Date.now();
	const result = spawnSync("bash", [SCRIPT], { encoding: "utf8", timeout: 60_000, env: runEnv(fx, transcript, { ORCH_MUSTER: stubMuster(fx.root), STUB_SEAT_JSON: seatFile, ORCH_COLLECT_WINDOW_S: "6", ...env }) });
	return { ...result, elapsedMs: Date.now() - started };
}

const QUOTA = "2026-10-09T21:45:03+03:00 QUOTA WALL: pi-core | weekly-plan-limit\n";

test("with the seat never claimed (epoch 0) the waiter still reads ORCH_TRANSCRIPT, exactly as before the seats", () => {
	const fx = fixture();
	try {
		writeFileSync(fx.events, QUOTA);
		const typedNow = runStub(fx, seatJson(fx.root, 0), typedTranscript(fx.root, Date.now()));
		assert.equal(typedNow.status, 0, typedNow.stderr);
		assert.match(typedNow.stdout, /QUOTA WALL/);
		assert.ok(typedNow.elapsedMs < 4000, `a typed transcript message wakes at once (${typedNow.elapsedMs} ms)`);
		rmSync(fx.offset, { force: true });
		const machine = runStub(fx, seatJson(fx.root, 0), machineTranscript(fx.root));
		assert.match(machine.stdout, /QUOTA WALL/);
		assert.ok(machine.elapsedMs >= 4500, `a machine message holds the collect window (${machine.elapsedMs} ms)`);
		rmSync(fx.offset, { force: true });
		const noVerb = runStub(fx, join(fx.root, "missing.json"), typedTranscript(fx.root, Date.now()));
		assert.ok(noVerb.elapsedMs < 4000, "a muster with no seat verb falls back to the transcript");
	} finally {
		fx.cleanup();
	}
});

test("once the seat is claimed the holder's lastTypedAt decides, and the transcript is ignored", () => {
	const fx = fixture();
	try {
		writeFileSync(fx.events, QUOTA);
		const fresh = runStub(fx, seatJson(fx.root, 2, new Date(Date.now() - 60_000).toISOString()), machineTranscript(fx.root));
		assert.equal(fresh.status, 0, fresh.stderr);
		assert.match(fresh.stdout, /QUOTA WALL/);
		assert.ok(fresh.elapsedMs < 4000, `typed a minute ago wakes at once (${fresh.elapsedMs} ms)`);
		rmSync(fx.offset, { force: true });
		const stale = runStub(fx, seatJson(fx.root, 2, new Date(Date.now() - 3 * 3600_000).toISOString()), typedTranscript(fx.root, Date.now()));
		assert.match(stale.stdout, /QUOTA WALL/);
		assert.ok(stale.elapsedMs >= 4500, `typed 3 hours ago, whatever the transcript says (${stale.elapsedMs} ms)`);
		rmSync(fx.offset, { force: true });
		const never = runStub(fx, seatJson(fx.root, 2), typedTranscript(fx.root, Date.now()));
		assert.ok(never.elapsedMs >= 4500, "a holder that never typed is not chatting");
		rmSync(fx.offset, { force: true });
		const edge = runStub(fx, seatJson(fx.root, 2, new Date(Date.now() - 600_000).toISOString()), machineTranscript(fx.root));
		assert.ok(edge.elapsedMs >= 4500, "the window is a strict less-than");
	} finally {
		fx.cleanup();
	}
});

test("a refused seat credential prints SEAT LOST with the epoch of the lost holding, leaves the offset alone, and exits", () => {
	const fx = fixture();
	try {
		writeFileSync(fx.events, QUOTA);
		const lost = runStub(fx, seatJson(fx.root, 4, new Date().toISOString()), machineTranscript(fx.root), { STUB_INBOX_RC: "77", MUSTER_SEAT_TOKEN: `s3.${"ab".repeat(32)}` });
		assert.equal(lost.status, 0, lost.stderr);
		assert.equal(lost.stdout.trim(), "SEAT LOST orchestrator #3");
		assert.equal(existsSync(fx.offset), false, "the events stay for the new holder's waiter");
		assert.doesNotMatch(lost.stdout, /QUOTA WALL/);

		const noToken = runStub(fx, seatJson(fx.root, 4, new Date().toISOString()), machineTranscript(fx.root), { STUB_INBOX_RC: "77", MUSTER_SEAT_TOKEN: "" });
		assert.equal(noToken.stdout.trim(), "SEAT LOST orchestrator #4", "a waiter armed with no credential reports the seat's current epoch");

		const other = runStub(fx, seatJson(fx.root, 0), machineTranscript(fx.root), { STUB_INBOX_RC: "1" });
		assert.doesNotMatch(other.stdout, /SEAT LOST/, "any other failure of inbox list keeps today's behaviour");
		assert.match(other.stdout, /QUOTA WALL/);
	} finally {
		fx.cleanup();
	}
});

// ─── STALE: a handoff report nobody accepted or sent back (OPENITEMS, 2026-10-26) ───
//
// The age rules are measured from a fixed clock, never the wall clock, and every run points the
// rate-limit state at the fixture: no test reads or writes the live events file, offset or ledger.

const STALE_NOW = 1793050000;

/** One lane record with one handoff report, and the answer to it when the case has one. */
function seedLane(state: string, laneId: string, kind: "review_ready" | "blocked" | "question", ageS: number, answer?: "accepted" | "sent-back") {
	const at = (STALE_NOW - ageS) * 1000;
	const record: LaneRecord = {
		laneId,
		harness: "pi",
		cwd: null,
		branch: `lane/${laneId}`,
		launchedAt: at - 3_600_000,
		launchedBy: "orchestrator",
		phase: kind,
		phaseSince: at,
		lastReport: { kind, summary: `${laneId} reported ${kind}`, at, ...(kind === "review_ready" ? { branch: `lane/${laneId}`, sha: "abc1234" } : {}) },
		...(answer === undefined ? {} : { handoffs: [{ at: at + 60_000, by: "orchestrator", verdict: answer }] }),
	};
	writeLaneRecord(state, record);
}

/** The fixture's own rate-limit state file, so the run never stamps the live one. */
const staleState = (fx: { root: string }): string => join(fx.root, "orch-wait-stale");

const staleEnv = (fx: { root: string }, now: number, extra: Record<string, string> = {}): Record<string, string> => ({
	ORCH_STALE_NOW: String(now),
	ORCH_STALE_STATE: staleState(fx),
	...extra,
});

test("an unanswered review_ready report older than 30 minutes prints a STALE line", () => {
	const fx = fixture();
	try {
		writeFileSync(fx.events, "");
		seedLane(fx.state, "gw-old", "review_ready", 31 * 60);
		const result = run(fx, machineTranscript(fx.root), staleEnv(fx, STALE_NOW));
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /^STALE: gw-old REVIEW READY 31m$/m, result.stdout);
		assert.equal(readFileSync(fx.events, "utf8"), "", "the stale line never goes into the events file");
		assert.equal(readFileSync(staleState(fx), "utf8").trim(), `gw-old\t${STALE_NOW}`, "the hour is stamped in the waiter's own state file");
	} finally {
		fx.cleanup();
	}
});

test("a review answered with an accept or a send-back is never STALE, and neither is one under 30 minutes", () => {
	const fx = fixture();
	try {
		writeFileSync(fx.events, "");
		seedLane(fx.state, "gw-accepted", "review_ready", 45 * 60, "accepted");
		seedLane(fx.state, "gw-sentback", "review_ready", 45 * 60, "sent-back");
		seedLane(fx.state, "gw-young", "review_ready", 29 * 60);
		const result = run(fx, machineTranscript(fx.root), staleEnv(fx, STALE_NOW));
		assert.equal(result.status, 0, result.stderr);
		assert.doesNotMatch(result.stdout, /STALE:/, result.stdout);
		assert.equal(result.stdout.trim(), "no events");
		assert.equal(existsSync(staleState(fx)), false, "nothing was stamped, so the next waiter sees the same state");
	} finally {
		fx.cleanup();
	}
});

test("blocked and question reports are STALE in their own words", () => {
	const fx = fixture();
	try {
		writeFileSync(fx.events, "");
		seedLane(fx.state, "gw-blocked", "blocked", 2 * 3600);
		seedLane(fx.state, "gw-question", "question", 45 * 60);
		const result = run(fx, machineTranscript(fx.root), staleEnv(fx, STALE_NOW));
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /^STALE: gw-blocked BLOCKED 2h00m$/m, result.stdout);
		assert.match(result.stdout, /^STALE: gw-question QUESTION 45m$/m, result.stdout);
	} finally {
		fx.cleanup();
	}
});

test("the same unanswered lane is surfaced at most once an hour", () => {
	const fx = fixture();
	try {
		writeFileSync(fx.events, "");
		seedLane(fx.state, "gw-repeat", "review_ready", 31 * 60);
		const first = run(fx, machineTranscript(fx.root), staleEnv(fx, STALE_NOW));
		assert.match(first.stdout, /STALE: gw-repeat REVIEW READY 31m/, first.stdout);
		const insideTheHour = run(fx, machineTranscript(fx.root), staleEnv(fx, STALE_NOW + 600));
		assert.doesNotMatch(insideTheHour.stdout, /STALE:/, `woke again inside the hour: ${insideTheHour.stdout}`);
		assert.equal(insideTheHour.stdout.trim(), "no events");
		const afterTheHour = run(fx, machineTranscript(fx.root), staleEnv(fx, STALE_NOW + 3700));
		assert.match(afterTheHour.stdout, /STALE: gw-repeat REVIEW READY 1h32m/, afterTheHour.stdout);
	} finally {
		fx.cleanup();
	}
});

test("a stale lane ends the wait at once instead of opening the collect window", async () => {
	const fx = fixture();
	try {
		writeFileSync(fx.events, "");
		seedLane(fx.state, "gw-now", "review_ready", 40 * 60);
		const result = await runLong(fx, 20_000, staleEnv(fx, STALE_NOW, { ORCH_NO_EVENT_S: "3600" }));
		assert.equal(result.code, 0, `held for the collect window: ${result.stdout}`);
		assert.match(result.stdout, /STALE: gw-now REVIEW READY 40m/);
		assert.ok(result.ms < 8_000, `woke after ${result.ms} ms`);
	} finally {
		fx.cleanup();
	}
});

// ─── SEND BACK (2026-10-26): a scan must not spend a muster process per closed lane ───
//
// The lane directory already says which rows are closed, merged or abandoned, so the record
// read is needed only for the few rows that are not. These tests count the processes.

/** A `muster` stand-in that records every verb it was asked for, then runs the real one. */
function countingMuster(root: string, callLog: string): string {
	const path = join(root, "muster-counting");
	writeFileSync(path, ["#!/usr/bin/env bash", `printf '%s\\n' "$*" >>${JSON.stringify(callLog)}`, `exec ${JSON.stringify(MUSTER)} "$@"`, ""].join("\n"));
	chmodSync(path, 0o755);
	return path;
}

/** How many `lane-record show` processes the standings ran. */
function recordLooks(callLog: string): number {
	if (!existsSync(callLog)) return 0;
	return readFileSync(callLog, "utf8").split("\n").filter((line) => line.startsWith("lane-record show")).length;
}

/** A lane that reported a handoff and is already closed, merged or abandoned. */
function seedClosed(state: string, laneId: string, ageS: number, phase: "closed" | "merged" | "abandoned" = "closed") {
	const at = (STALE_NOW - ageS) * 1000;
	writeLaneRecord(state, {
		laneId,
		harness: "pi",
		cwd: null,
		branch: `lane/${laneId}`,
		launchedAt: at - 7_200_000,
		launchedBy: "orchestrator",
		phase,
		phaseSince: at + 60_000,
		lastReport: { kind: "review_ready", summary: `${laneId} reported review_ready`, at, branch: `lane/${laneId}`, sha: "abc1234" },
		terminal: { outcome: "merged", reason: "merged", sha: "abc1234", at: at + 60_000 },
	});
}

test("a scan reads the record only for the lanes the directory does not already say are closed", () => {
	const fx = fixture();
	try {
		writeFileSync(fx.events, "");
		for (let i = 0; i < 12; i += 1) seedClosed(fx.state, `gw-closed-${i}`, 40 * 60);
		seedLane(fx.state, "gw-open", "review_ready", 40 * 60);
		const calls = join(fx.root, "calls.log");
		const result = run(fx, machineTranscript(fx.root), staleEnv(fx, STALE_NOW, { ORCH_MUSTER: countingMuster(fx.root, calls) }));
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /STALE: gw-open REVIEW READY 40m/, result.stdout);
		assert.doesNotMatch(result.stdout, /gw-closed-/, result.stdout);
		assert.equal(recordLooks(calls), 1, "one lane-record read for the one lane still open, none for the twelve closed ones");
	} finally {
		fx.cleanup();
	}
});

test("a scan over many closed lanes does not delay a normal event wake", () => {
	const fx = fixture();
	try {
		writeFileSync(fx.events, "2026-10-12T01:00:00+03:00 REVIEW READY: gw-live lane/gw-live@abc1234 | done\n");
		for (let i = 0; i < 12; i += 1) seedClosed(fx.state, `gw-closed-${i}`, 40 * 60);
		const calls = join(fx.root, "calls.log");
		const started = Date.now();
		const result = run(fx, machineTranscript(fx.root), staleEnv(fx, STALE_NOW, { ORCH_MUSTER: countingMuster(fx.root, calls) }));
		const took = Date.now() - started;
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /REVIEW READY: gw-live/, result.stdout);
		assert.doesNotMatch(result.stdout, /STALE:/);
		assert.equal(recordLooks(calls), 0, "the directory's own answer was enough: no lane-record read at all");
		assert.ok(took < 8000, `the event wake took ${took} ms with twelve closed lanes in the directory`);
	} finally {
		fx.cleanup();
	}
});

test("a lane whose record is closed, merged or abandoned never goes STALE", () => {
	const fx = fixture();
	try {
		writeFileSync(fx.events, "");
		seedClosed(fx.state, "gw-closed", 90 * 60, "closed");
		seedClosed(fx.state, "gw-merged", 90 * 60, "merged");
		seedClosed(fx.state, "gw-abandoned", 90 * 60, "abandoned");
		const calls = join(fx.root, "calls.log");
		const result = run(fx, machineTranscript(fx.root), staleEnv(fx, STALE_NOW, { ORCH_MUSTER: countingMuster(fx.root, calls) }));
		assert.equal(result.status, 0, result.stderr);
		assert.doesNotMatch(result.stdout, /STALE:/, result.stdout);
		assert.equal(result.stdout.trim(), "no events");
		assert.equal(recordLooks(calls), 0);
	} finally {
		fx.cleanup();
	}
});

test("a STALE item and a lane event arrive in the same wake", () => {
	const fx = fixture();
	try {
		writeFileSync(fx.events, "2026-10-12T01:00:00+03:00 REVIEW READY: gw-live lane/gw-live@abc1234 | done\n");
		seedLane(fx.state, "gw-open", "review_ready", 40 * 60);
		const result = run(fx, machineTranscript(fx.root), staleEnv(fx, STALE_NOW));
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /REVIEW READY: gw-live/, result.stdout);
		assert.match(result.stdout, /STALE: gw-open REVIEW READY 40m/, result.stdout);
	} finally {
		fx.cleanup();
	}
});

test("a STALE item and a priority message wake the orchestrator together, at once", async () => {
	const fx = fixture();
	try {
		writeFileSync(fx.events, "");
		seedLane(fx.state, "gw-open", "review_ready", 40 * 60);
		writeInboxMessage(fx.state, { agent: "orchestrator", from: "grokbot", at: new Date().toISOString(), text: "Henry is waiting", idempotencyKey: "stale-priority", source: "send" });
		const result = await runLong(fx, 20_000, staleEnv(fx, STALE_NOW));
		assert.equal(result.code, 0, `held: ${result.stdout}`);
		assert.match(result.stdout, /STALE: gw-open REVIEW READY 40m/, result.stdout);
		assert.match(result.stdout, /INBOX: grokbot \| Henry is waiting/, result.stdout);
		assert.ok(result.ms < 8_000, `woke after ${result.ms} ms`);
	} finally {
		fx.cleanup();
	}
});

test("the operator chatting still wakes at once with a STALE item in the batch", () => {
	const fx = fixture();
	try {
		writeFileSync(fx.events, "");
		seedLane(fx.state, "gw-open", "review_ready", 40 * 60);
		const started = Date.now();
		const result = run(fx, typedTranscript(fx.root, Date.now()), staleEnv(fx, STALE_NOW, { ORCH_COLLECT_WINDOW_S: "3600" }));
		const took = Date.now() - started;
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /STALE: gw-open REVIEW READY 40m/, result.stdout);
		assert.ok(took < 8000, `woke after ${took} ms`);
	} finally {
		fx.cleanup();
	}
});

// ---- WGGUARD: one seat, one waiter (VR24-215, Henry 17:44) ----

const pidFileFor = (state: string): string => join(state, "waiters", "orchestrator.pid");

async function waitForFile(file: string, limitMs: number): Promise<boolean> {
	const deadline = Date.now() + limitMs;
	while (Date.now() < deadline) {
		if (existsSync(file)) return true;
		await new Promise((resume) => setTimeout(resume, 50));
	}
	return existsSync(file);
}

test("a live waiter refuses a second one by its pid and leaves the file alone", async () => {
	const fx = fixture();
	const pidFile = pidFileFor(fx.state);
	const first = spawn("bash", [SCRIPT], {
		env: runEnv(fx, machineTranscript(fx.root), { ORCH_NO_EVENT_S: "120", ORCH_POLL_S: "1" }),
		stdio: "ignore",
	});
	const exited = new Promise<number | null>((resolveExit) => first.on("close", resolveExit));
	try {
		writeFileSync(fx.events, "");
		assert.equal(await waitForFile(pidFile, 15_000), true, "the first waiter arms and writes its pid");
		const armedPid = readFileSync(pidFile, "utf8").trim();
		assert.equal(armedPid, String(first.pid), "the file names the waiter's own pid");

		const second = run(fx, machineTranscript(fx.root));
		assert.notEqual(second.status, 0, "a second waiter must not arm while the first is alive");
		assert.equal(second.status, 75, `refused with its own code: ${second.stderr}`);
		assert.match(second.stderr, new RegExp(`^orch-wait: refusing to arm, pid ${armedPid} is already a live waiter \\(.*orch-wait\\.sh.*\\)$`, "m"), second.stderr);
		assert.equal(second.stdout.trim(), "", "a refused waiter reads no events");
		assert.equal(readFileSync(pidFile, "utf8").trim(), armedPid, "the refused waiter never touched the file");
	} finally {
		first.kill("SIGKILL");
		await exited;
		fx.cleanup();
	}
});

test("a dead pid is a stale file: the waiter takes over and arms", () => {
	const fx = fixture();
	try {
		writeFileSync(fx.events, "");
		mkdirSync(join(fx.state, "waiters"), { recursive: true });
		const dead = spawnSync(process.execPath, ["-e", "0"], { encoding: "utf8" }).pid!;
		writeFileSync(pidFileFor(fx.state), `${dead}\n`);
		const result = run(fx, machineTranscript(fx.root));
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim(), "no events");
		assert.doesNotMatch(result.stderr, /refusing to arm/);
	} finally {
		fx.cleanup();
	}
});

test("no pid file arms as before", () => {
	const fx = fixture();
	try {
		writeFileSync(fx.events, "");
		const result = run(fx, machineTranscript(fx.root));
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim(), "no events");
		assert.doesNotMatch(result.stderr, /refusing to arm/);
	} finally {
		fx.cleanup();
	}
});

test("a pid the kernel gave to an unrelated process is a stale file", async () => {
	const fx = fixture();
	const other = spawn("sleep", ["60"], { stdio: "ignore" });
	const exited = new Promise<number | null>((resolveExit) => other.on("close", resolveExit));
	try {
		writeFileSync(fx.events, "");
		mkdirSync(join(fx.state, "waiters"), { recursive: true });
		writeFileSync(pidFileFor(fx.state), `${other.pid}\n`);
		const result = run(fx, machineTranscript(fx.root));
		assert.equal(result.status, 0, `an unrelated live pid is not a waiter: ${result.stderr}`);
		assert.equal(result.stdout.trim(), "no events");
		assert.doesNotMatch(result.stderr, /refusing to arm/);
	} finally {
		other.kill("SIGKILL");
		await exited;
		fx.cleanup();
	}
});
