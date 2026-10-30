import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeInboxState, claudeRemoteControlLink, claudeSessionLane, ensureClaudeLaneCard, isClaudeLane, isOwnAncestor, ownClaudeLane, readClaudeJob, resumeClaudeLane, stopClaudeLane, writeClaudeLaneHeartbeat, type ClaudeJob } from "../lib/claude-lane-card.ts";
import { readLaneCard, recordLaneReport, writeLaneCard } from "../lib/lane-card.ts";
import { ENDED_TURN_QUIET_MS, isClaudeRowIdle, type ClaudeLaneRow } from "../lib/lane-directory.ts";

const rows: ClaudeLaneRow[] = [
	{ id: "d7911283", sessionId: "sess-voice", cwd: "/work/voice", name: "cc-voice", kind: "background", status: "busy", state: "working", startedAt: 1_000 },
	{ id: "2727cbda", sessionId: "sess-screens", cwd: "/work/screens", name: "cc-screens", kind: "background", status: "idle", state: "blocked", startedAt: 2_000 },
];

function withDir(run: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "claude-lane-card-"));
	try {
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("the first need creates the card from the lane's `claude agents` row, and a report lands on it", () => {
	withDir((dir) => {
		assert.equal(readLaneCard(dir, "cc-voice"), undefined);
		assert.equal(recordLaneReport(dir, "cc-voice", { kind: "working", summary: "x", at: 5 }), false, "the old failure: no card, no report");
		const card = ensureClaudeLaneCard(dir, "cc-voice", { now: 9_000, readRows: () => rows });
		assert.equal(card?.harness, "claude");
		assert.equal(card?.state, "running");
		assert.equal(card?.sessionId, "sess-voice");
		assert.equal(card?.endpoint, "inbox: muster wait --inbox cc-voice");
		assert.equal(recordLaneReport(dir, "cc-voice", { kind: "review_ready", summary: "done", at: 7 }), true);
		assert.equal(readLaneCard(dir, "cc-voice")?.lastReport?.summary, "done");
	});
});

test("an existing card is left alone, and a name `claude agents` does not list gets no card", () => {
	withDir((dir) => {
		writeLaneCard(dir, { laneId: "cc-screens", harness: "claude", cwd: null, branch: null, state: "idle", model: null, thinking: null, since: null, updatedAt: 1, wall: null, lastReport: { kind: "working", summary: "kept", at: 3 } });
		assert.equal(ensureClaudeLaneCard(dir, "cc-screens", { readRows: () => rows })?.lastReport?.summary, "kept");
		assert.equal(ensureClaudeLaneCard(dir, "pi-nobody", { readRows: () => rows }), undefined);
		assert.equal(readLaneCard(dir, "pi-nobody"), undefined);
	});
});

test("a lane is a Claude lane by its card's harness, else by its `claude agents` name", () => {
	withDir((dir) => {
		assert.equal(isClaudeLane(dir, "cc-voice", () => rows), true, "no card: the CLI row decides");
		assert.equal(isClaudeLane(dir, "pi-be-g3", () => rows), false);
		writeLaneCard(dir, { laneId: "oc-bus1", harness: "opencode", cwd: null, branch: null, state: "idle", model: null, thinking: null, since: null, updatedAt: 1, wall: null });
		assert.equal(isClaudeLane(dir, "oc-bus1", () => [{ sessionId: "s", name: "oc-bus1" }]), false, "a card names its harness; the CLI row does not override it");
	});
});

// ─── the hook heartbeat (pi-claude-parity, 2026-10-09) ──────────────────────

test("the heartbeat creates the card on first need and keeps what another writer put there", () => {
	withDir((dir) => {
		const card = writeClaudeLaneHeartbeat(dir, "cc-lane", {
			state: "running",
			model: "claude-haiku-4-5-20251001",
			sessionId: "sess-1",
			cwd: "/w/cc-lane",
		}, 1_000);
		assert.equal(card.harness, "claude");
		assert.equal(card.state, "running");
		assert.equal(card.since, 1_000);
		assert.equal(card.endpoint, "inbox: muster wait --inbox cc-lane");
		// A report filed between two heartbeats survives the next one.
		assert.equal(recordLaneReport(dir, "cc-lane", { kind: "working", summary: "half way", at: 1_500 }), true);
		const second = writeClaudeLaneHeartbeat(dir, "cc-lane", { state: "idle", lastActivityMs: 2_000, lastMessage: "waiting on the orchestrator" }, 2_000);
		assert.equal(second.lastReport?.summary, "half way");
		assert.equal(second.state, "idle");
		assert.equal(second.since, 2_000, "since moves when the state changes");
		assert.equal(second.lastMessage, "waiting on the orchestrator");
		assert.equal(second.model, "claude-haiku-4-5-20251001", "a field the heartbeat did not name is kept");
		// An unchanged state keeps `since`, so the row does not read as a new arrival.
		const third = writeClaudeLaneHeartbeat(dir, "cc-lane", { state: "idle", lastActivityMs: 3_000 }, 3_000);
		assert.equal(third.since, 2_000);
		assert.equal(third.lastMessage, "waiting on the orchestrator");
	});
});

test("the heartbeat never invents a session id, and a lane id it is given is written as given", () => {
	withDir((dir) => {
		const card = writeClaudeLaneHeartbeat(dir, "cc-lane", { lastActivityMs: 10 }, 10);
		assert.equal(card.sessionId, undefined);
		assert.equal(card.state, "idle", "the honest default before a session start names one");
		assert.equal(card.model, null);
	});
});

// ─── stop: the CLI runs the harness's own verb (2026-10-09) ──────────────────

function claudeCard(dir: string, laneId: string, sessionId: string): void {
	writeLaneCard(dir, { laneId, harness: "claude", cwd: "/work/a", branch: null, state: "running", model: null, thinking: null, since: 1, updatedAt: 2, wall: null, sessionId });
}

test("stopClaudeLane hands `claude stop` the short background id, never the sessionId", () => {
	withDir((dir) => {
		claudeCard(dir, "cc-voice", "sess-voice");
		const calls: string[][] = [];
		const result = stopClaudeLane(dir, "cc-voice", {
			readRows: () => rows,
			runCli: (args) => { calls.push(args); return { status: 0, stdout: "", stderr: "" }; },
		});
		assert.equal(result.ok, true);
		// Verified live 2026-10-09: `claude logs <sessionId>` answers "No job
		// matching"; `claude agents --json`'s short id is what resolves.
		assert.deepEqual(calls, [["stop", "d7911283"]]);
		assert.equal(result.handle, "d7911283");
		assert.equal(readLaneCard(dir, "cc-voice"), undefined, "a confirmed stop removes the card");
	});
});

test("stopClaudeLane finds the row by the card's sessionId when the name differs from the lane id", () => {
	withDir((dir) => {
		claudeCard(dir, "cc-audit", "sess-voice");
		const calls: string[][] = [];
		const result = stopClaudeLane(dir, "cc-audit", {
			readRows: () => rows,
			runCli: (args) => { calls.push(args); return { status: 0, stdout: "", stderr: "" }; },
		});
		assert.equal(result.ok, true);
		assert.deepEqual(calls, [["stop", "d7911283"]]);
	});
});

test("stopClaudeLane changes nothing when the CLI refuses or the lane is not listed", () => {
	withDir((dir) => {
		claudeCard(dir, "cc-voice", "sess-voice");
		const refused = stopClaudeLane(dir, "cc-voice", {
			readRows: () => rows,
			runCli: () => ({ status: 1, stdout: "", stderr: "couldn't confirm it was stopped" }),
		});
		assert.equal(refused.ok, false);
		assert.match(refused.reason ?? "", /confirm it was stopped/);
		assert.ok(readLaneCard(dir, "cc-voice"), "a refused stop keeps the card");

		const absent = stopClaudeLane(dir, "cc-voice", { readRows: () => [], runCli: () => ({ status: 0, stdout: "", stderr: "" }) });
		assert.equal(absent.ok, false);
		assert.match(absent.reason ?? "", /no live background session/);
		assert.ok(readLaneCard(dir, "cc-voice"));

		// A row without the short id (an interactive session) is not stoppable here.
		const interactive = stopClaudeLane(dir, "cc-voice", { readRows: () => [{ sessionId: "sess-voice", name: "cc-voice", kind: "interactive" }], runCli: () => ({ status: 0, stdout: "", stderr: "" }) });
		assert.equal(interactive.ok, false);
		assert.ok(readLaneCard(dir, "cc-voice"));
	});
});

// ─── Which lane is this session? (the daemon's job record, never process env) ───

const SESSION_A = "0a1b2c3d-1111-4222-8333-444455556666";
const SESSION_B = "1b2c3d4e-1111-4222-8333-444455556666";

/** A jobs directory the way the Claude daemon writes it: `<first 8>/state.json`. */
function withJobs(jobs: Array<{ sessionId: string; name: unknown; dir?: string }>, run: (jobsDir: string) => void): void {
	withDir((dir) => {
		for (const job of jobs) {
			mkdirSync(join(dir, job.dir ?? job.sessionId.slice(0, 8)), { recursive: true });
			writeFileSync(join(dir, job.dir ?? job.sessionId.slice(0, 8), "state.json"), JSON.stringify({ name: job.name, sessionId: job.sessionId, template: "bg" }));
		}
		run(dir);
	});
}

test("a session id resolves to the --name its job was launched with, one lane per session", () => {
	withJobs([{ sessionId: SESSION_A, name: "cc-scratch-a" }, { sessionId: SESSION_B, name: " cc-scratch-b " }], (jobsDir) => {
		assert.equal(claudeSessionLane(SESSION_A, { jobsDir }), "cc-scratch-a");
		assert.equal(claudeSessionLane(SESSION_B, { jobsDir }), "cc-scratch-b");
	});
});

test("an unknown session, a record naming another session, or a non-lane name is not a lane", () => {
	withJobs(
		[
			{ sessionId: SESSION_A, name: "two words" },
			// A record filed under B's directory that names a different session: not B's.
			{ sessionId: "ffffffff-1111-4222-8333-444455556666", name: "cc-intruder", dir: SESSION_B.slice(0, 8) },
		],
		(jobsDir) => {
			assert.equal(claudeSessionLane(SESSION_A, { jobsDir }), undefined, "a free-text session name is not a lane id");
			assert.equal(claudeSessionLane(SESSION_B, { jobsDir }), undefined, "the record must name this exact session");
			assert.equal(claudeSessionLane("2c3d4e5f-1111-4222-8333-444455556666", { jobsDir }), undefined, "no record");
			assert.equal(claudeSessionLane(undefined, { jobsDir }), undefined);
		},
	);
});

test("only a UUID-shaped session id is looked up: a path in the id reaches no file", () => {
	withJobs([{ sessionId: SESSION_A, name: "cc-scratch-a" }], (jobsDir) => {
		assert.equal(claudeSessionLane("../0a1b2c3d", { jobsDir }), undefined);
		assert.equal(claudeSessionLane("0a1b2c3d", { jobsDir }), undefined);
		assert.equal(claudeSessionLane("", { jobsDir }), undefined);
	});
});

test("the jobs directory comes from CLAUDE_CONFIG_DIR, else HOME/.claude", () => {
	withDir((dir) => {
		mkdirSync(join(dir, "cfg", "jobs", SESSION_A.slice(0, 8)), { recursive: true });
		writeFileSync(join(dir, "cfg", "jobs", SESSION_A.slice(0, 8), "state.json"), JSON.stringify({ name: "cc-cfg", sessionId: SESSION_A }));
		mkdirSync(join(dir, "home", ".claude", "jobs", SESSION_A.slice(0, 8)), { recursive: true });
		writeFileSync(join(dir, "home", ".claude", "jobs", SESSION_A.slice(0, 8), "state.json"), JSON.stringify({ name: "cc-home", sessionId: SESSION_A }));
		assert.equal(claudeSessionLane(SESSION_A, { env: { CLAUDE_CONFIG_DIR: join(dir, "cfg"), HOME: join(dir, "home") } }), "cc-cfg");
		assert.equal(claudeSessionLane(SESSION_A, { env: { HOME: join(dir, "home") } }), "cc-home");
	});
});

test("a process inside a Claude lane resolves it only when CLAUDE_PID is its own ancestor", () => {
	withJobs([{ sessionId: SESSION_A, name: "cc-scratch-a" }], (jobsDir) => {
		const env = { CLAUDE_CODE_SESSION_ID: SESSION_A, CLAUDE_PID: "4242", CONCORD_AGENT_ID: "cc-first-launch" };
		assert.equal(ownClaudeLane(env, { jobsDir, isAncestor: (pid) => pid === 4242 }), "cc-scratch-a", "the session wins over the daemon's env");
		// A stale copy of the variables (a tmux server started from a Claude tool, then a Pi lane under it).
		assert.equal(ownClaudeLane(env, { jobsDir, isAncestor: () => false }), undefined);
		assert.equal(ownClaudeLane({ ...env, CLAUDE_PID: undefined }, { jobsDir, isAncestor: () => true }), undefined);
		assert.equal(ownClaudeLane({ ...env, CLAUDE_CODE_SESSION_ID: undefined }, { jobsDir, isAncestor: () => true }), undefined);
	});
});

test("isOwnAncestor walks /proc: this process and its parent are ancestors, an unrelated pid is not", () => {
	assert.equal(isOwnAncestor(process.pid), true);
	assert.equal(isOwnAncestor(process.ppid), true);
	assert.equal(isOwnAncestor(2_000_000_000), false);
});

// --- Resume an idle lane with a message (sn-ident 0002) ---

const IDLE_SESSION = "7a1b2c3d-1111-4222-8333-444455556666";
const idleRow: ClaudeLaneRow = { id: "7a1b2c3d", sessionId: IDLE_SESSION, cwd: "/work/idle", name: "cc-idle", kind: "background", status: "idle", state: "blocked", startedAt: 3_000 };
const idleJob: ClaudeJob = {
	sessionId: IDLE_SESSION,
	name: "cc-idle",
	template: "bg",
	cwd: "/work/idle",
	respawnFlags: ["--name", "cc-idle", "--permission-mode", "bypassPermissions", "--plugin-dir", "/mods/muster-bus", "--model", "haiku"],
};

function recordingCli(statuses: Array<number | null> = [0, 0], stdout = "backgrounded · 8f9e0a1b · cc-idle\n"): { calls: Array<{ args: string[]; options?: { cwd?: string; timeoutMs?: number } }>; runCli: (args: string[], options?: { cwd?: string; timeoutMs?: number }) => { status: number | null; stdout: string; stderr: string } } {
	const calls: Array<{ args: string[]; options?: { cwd?: string; timeoutMs?: number } }> = [];
	return {
		calls,
		runCli: (args, options) => {
			calls.push({ args, ...(options !== undefined ? { options } : {}) });
			const status = statuses[calls.length - 1] ?? 0;
			return { status, stdout: status === 0 ? stdout : "", stderr: status === 0 ? "" : "refused" };
		},
	};
}

test("a finished or blocked background row is idle; a working, interactive or id-less row is not", () => {
	assert.equal(isClaudeRowIdle(idleRow), true);
	assert.equal(isClaudeRowIdle({ id: "328bc4fb", sessionId: "s", status: "idle", state: "done" }), true);
	assert.equal(isClaudeRowIdle({ id: "e2d363b5", sessionId: "s", state: "blocked" }), true, "blocked with no status field is waiting for an answer");
	assert.equal(isClaudeRowIdle({ id: "73f23a87", sessionId: "s", status: "busy", state: "working" }), false);
	assert.equal(isClaudeRowIdle({ id: "3a4d53b4", sessionId: "s", status: "busy", state: "done" }), true, "a done turn with a stale busy status can be resumed");
	assert.equal(isClaudeRowIdle({ sessionId: "s", status: "idle" }), false, "an interactive session has no handle to resume it by");
});

// sn-idlew: Claude's end-of-turn classifier leaves `state: "working", tempo: "idle"` when the last message matches no done/blocked pattern.
const STALE_NOW = Date.parse("2026-10-09T12:20:00.000Z");
const staleWorkingRow: ClaudeLaneRow = { id: "e7f6946a", sessionId: "s", status: "idle", state: "working" };
const endedJob = { tempo: "idle", updatedAtMs: STALE_NOW - ENDED_TURN_QUIET_MS, inFlightTasks: 0 };

test("idle status with a stale `working` state is an ended turn only when the job record agrees and has been quiet", () => {
	assert.equal(isClaudeRowIdle(staleWorkingRow, endedJob, STALE_NOW), true, "the 2026-10-09 sn-ints case: idle + working, tempo idle, record unchanged");
	assert.equal(isClaudeRowIdle(staleWorkingRow, { ...endedJob, updatedAtMs: STALE_NOW - ENDED_TURN_QUIET_MS + 1 }, STALE_NOW), false, "a record written inside the quiet window may be the turn's own closing write");
	assert.equal(isClaudeRowIdle(staleWorkingRow, { ...endedJob, tempo: "active" }, STALE_NOW), false);
	assert.equal(isClaudeRowIdle(staleWorkingRow, { ...endedJob, inFlightTasks: 2 }, STALE_NOW), false, "background tasks in flight will still reach a tool boundary");
	assert.equal(isClaudeRowIdle(staleWorkingRow, undefined, STALE_NOW), false, "no job record, no proof");
	assert.equal(isClaudeRowIdle(staleWorkingRow, { tempo: "idle", inFlightTasks: 0 }, STALE_NOW), false, "a record with no usable updatedAt is no proof");
	assert.equal(isClaudeRowIdle({ ...staleWorkingRow, status: "busy" }, endedJob, STALE_NOW), false, "a live busy process is never idle, whatever the record says");
	assert.equal(isClaudeRowIdle({ ...staleWorkingRow, status: undefined }, endedJob, STALE_NOW), false, "working with no live status is not idle");
});

/** A fake clock whose sleeps advance it, so the lease's 30 s run out without waiting. */
function fakeClock(): { now: () => number; sleep: (ms: number) => void; slept: number[] } {
	let t = 1_000_000;
	const slept: number[] = [];
	return { now: () => t, sleep: (ms) => { slept.push(ms); t += ms; }, slept };
}

const LEASE_FILE = (dir: string, laneId = "cc-idle"): string => join(dir, "resume", `${laneId}.lock`);
const wokenRow: ClaudeLaneRow = { ...idleRow, pid: 4300, state: "working", status: "busy" };
const KEPT = "backgrounded · 7a1b2c3d · cc-idle (idle — send a prompt to start)\n";

test("a lane with a live process is never resumed: the row's pid or the job record's pid keeps it out, with no spawn", () => {
	withDir((dir) => {
		const cli = recordingCli();
		for (const [row, job] of [[{ ...idleRow, pid: 4242 }, idleJob], [{ ...idleRow, pid: undefined }, { ...idleJob, pid: 4242 }], [{ ...idleRow, status: "busy", state: "working", pid: 4242 }, idleJob]] as const) {
			const result = resumeClaudeLane(dir, "cc-idle", "x", { readRows: () => [row], runCli: cli.runCli, readJob: () => job, pidAlive: (pid) => pid === 4242, waiterAlive: () => false });
			assert.deepEqual(result, { state: "live", waiter: false });
		}
		const armed = resumeClaudeLane(dir, "cc-idle", "x", { readRows: () => [{ ...idleRow, pid: 4242 }], runCli: cli.runCli, readJob: () => idleJob, pidAlive: () => true, waiterAlive: () => true });
		assert.deepEqual(armed, { state: "live", waiter: true }, "the answer says whether the lane's waiter is armed");
		assert.deepEqual(cli.calls, [], "`claude --bg --resume` is never run for a live process (LD9)");
		assert.equal(existsSync(LEASE_FILE(dir)), false, "a refusal leaves no lease behind");
	});
});

test("a pid-less lane is woken with exactly one call, `--bg --resume <full session id> <prompt>`: no flags, no stop, from its cwd", () => {
	withDir((dir) => {
		claudeCard(dir, "cc-idle", IDLE_SESSION);
		const cli = recordingCli([0], KEPT);
		const listings = [[{ ...idleRow, pid: 4243 }], [wokenRow]];
		const clock = fakeClock();
		const result = resumeClaudeLane(dir, "cc-idle", "the prompt", {
			readRows: () => listings.shift() ?? [wokenRow],
			runCli: cli.runCli,
			readJob: () => ({ ...idleJob, bridgeSessionId: "cse_0175vvLNM7awake" }),
			pidAlive: (pid) => pid === 4300,
			...clock,
		});
		assert.deepEqual(cli.calls.map((call) => call.args), [["--bg", "--resume", IDLE_SESSION, "the prompt"]], "no `claude stop`, and none of the job's launch flags: any flag starts a copy under a new id");
		assert.equal(cli.calls[0]?.options?.cwd, "/work/idle");
		assert.deepEqual(result, { state: "resumed", sessionId: IDLE_SESSION, oldHandle: "7a1b2c3d", handle: "7a1b2c3d", keptId: true, rowSeen: true, bridgeSessionId: "cse_0175vvLNM7awake", detail: "claude --bg --resume 7a1b2c3d: woke the same session" });
		assert.equal(readLaneCard(dir, "cc-idle")?.sessionId, IDLE_SESSION, "the card is not rewritten here: the woken session's own heartbeat does that");
		assert.equal(existsSync(LEASE_FILE(dir)), false, "the lease is released once the new row shows");
	});
});

test("no prompt means no prompt argument; a parked lane (no row) is woken from the session id the caller gives", () => {
	withDir((dir) => {
		const cli = recordingCli([0], KEPT);
		const clock = fakeClock();
		const result = resumeClaudeLane(dir, "cc-idle", undefined, { sessionId: IDLE_SESSION, readRows: () => [], runCli: cli.runCli, readJob: () => idleJob, ...clock });
		assert.equal(result.state, "resumed");
		assert.deepEqual(cli.calls.map((call) => call.args), [["--bg", "--resume", IDLE_SESSION]]);
	});
});

test("a CLI that starts a copy under another id is reported as a copy, not as the lane woken", () => {
	withDir((dir) => {
		const cli = recordingCli([0], "backgrounded · 8f9e0a1b · cc-idle\n");
		const clock = fakeClock();
		const result = resumeClaudeLane(dir, "cc-idle", "p", { readRows: () => [{ ...idleRow, pid: undefined }], runCli: cli.runCli, readJob: () => idleJob, ...clock });
		assert.equal(result.state, "resumed");
		assert.deepEqual({ keptId: (result as { keptId: boolean }).keptId, handle: (result as { handle?: string }).handle, detail: (result as { detail: string }).detail }, { keptId: false, handle: "8f9e0a1b", detail: "claude --bg --resume 7a1b2c3d started a copy as 8f9e0a1b" });
	});
});

test("a second resume of the lane is refused while the first holds the lease, and a dead or stale holder does not block it", () => {
	withDir((dir) => {
		const clock = fakeClock();
		const cli = recordingCli([0], KEPT);
		const lease = (pid: number, at: number): void => { mkdirSync(join(dir, "resume"), { recursive: true }); writeFileSync(LEASE_FILE(dir), JSON.stringify({ pid, at })); };
		const resume = (): ReturnType<typeof resumeClaudeLane> => resumeClaudeLane(dir, "cc-idle", "p", { readRows: () => [idleRow], runCli: cli.runCli, readJob: () => idleJob, pidAlive: (pid) => pid === 4242 || pid === 4300, ...clock });
		lease(4242, clock.now() - 5_000);
		assert.deepEqual(resume(), { state: "in-progress", by: 4242 });
		assert.deepEqual(cli.calls, [], "the refused resume spawns nothing");
		assert.ok(existsSync(LEASE_FILE(dir)), "and does not take the holder's lease away");
		lease(4999, clock.now() - 5_000);
		assert.equal(resume().state, "resumed", "a holder whose pid is gone is a crash, not a resume in progress");
		lease(4242, clock.now() - 40_000);
		assert.equal(resume().state, "resumed", "a lease older than 35 s is stale even when its pid lives");
	});
});

test("the lease is held until the new row shows, and runs out after 30 s when it never does", () => {
	withDir((dir) => {
		const cli = recordingCli([0], KEPT);
		const clock = fakeClock();
		let polls = 0;
		const result = resumeClaudeLane(dir, "cc-idle", "p", {
			readRows: () => {
				polls += 1;
				if (polls > 1) assert.ok(existsSync(LEASE_FILE(dir)), `poll ${polls}: the lease is still held`);
				return polls >= 4 ? [wokenRow] : [{ ...idleRow, pid: undefined }];
			},
			runCli: cli.runCli,
			readJob: () => idleJob,
			pidAlive: (pid) => pid === 4300,
			...clock,
		});
		assert.deepEqual({ state: result.state, rowSeen: (result as { rowSeen: boolean }).rowSeen, polls }, { state: "resumed", rowSeen: true, polls: 4 });
		assert.deepEqual(clock.slept, [500, 500], "polled every 500 ms until the row showed");
		assert.equal(existsSync(LEASE_FILE(dir)), false);

		const never = fakeClock();
		let held = 0;
		const timedOut = resumeClaudeLane(dir, "cc-idle", "p", { readRows: () => { if (existsSync(LEASE_FILE(dir))) held += 1; return [{ ...idleRow, pid: undefined }]; }, runCli: recordingCli([0], KEPT).runCli, readJob: () => idleJob, ...never });
		assert.equal((timedOut as { rowSeen: boolean }).rowSeen, false);
		assert.equal(never.slept.length, 60, "30 s of 500 ms polls, then the lease ends");
		assert.ok(held > 1);
		assert.equal(existsSync(LEASE_FILE(dir)), false);
	});
});

test("nothing is run unless the resume is fully specified: no session, no job record, an interactive card, no cwd or a failed listing", () => {
	withDir((dir) => {
		const cli = recordingCli();
		const clock = fakeClock();
		const base = { runCli: cli.runCli, ...clock };
		assert.equal(resumeClaudeLane(dir, "cc-idle", "x", { ...base, readRows: () => [], readJob: () => idleJob }).state, "unresumable", "no card, record or row names a session");
		assert.equal(resumeClaudeLane(dir, "cc-idle", "x", { ...base, readRows: () => [idleRow], readJob: () => undefined }).state, "unresumable", "the daemon has no job record");
		claudeCard(dir, "orchestrator", "352cee8e-a1af-4056-9e39-cfc3aef16c83");
		assert.equal(resumeClaudeLane(dir, "orchestrator", "x", { ...base, readRows: () => [], readJob: () => undefined }).state, "unresumable", "an interactive card names a session with no background job record");
		assert.equal(resumeClaudeLane(dir, "cc-idle", "x", { ...base, readRows: () => [{ ...idleRow, cwd: undefined }], readJob: () => ({ ...idleJob, cwd: undefined }) }).state, "unresumable", "no cwd to resume in");
		const failedList = resumeClaudeLane(dir, "cc-idle", "x", { ...base, readRows: () => { throw new Error("claude agents timed out"); }, readJob: () => idleJob });
		assert.equal(failedList.state, "failed", "a live copy cannot be ruled out");
		assert.equal(resumeClaudeLane(dir, "../cc-idle", "x", { ...base, readRows: () => [idleRow], readJob: () => idleJob }).state, "unresumable", "a lane id is never a path");
		assert.deepEqual(cli.calls, []);
		assert.equal(existsSync(LEASE_FILE(dir)), false, "every refusal released its lease");
	});
});

test("a failed spawn says so, with the CLI's own words, and releases the lease", () => {
	withDir((dir) => {
		const failed = resumeClaudeLane(dir, "cc-idle", "x", { readRows: () => [idleRow], runCli: recordingCli([1]).runCli, readJob: () => idleJob, ...fakeClock() });
		assert.equal(failed.state, "failed");
		assert.match((failed as { reason: string }).reason, /claude --bg --resume 7a1b2c3d: refused/);
		assert.equal(existsSync(LEASE_FILE(dir)), false);
	});
});

test("the Remote Control link drops the cse_ prefix of the job's bridgeSessionId", () => {
	assert.equal(claudeRemoteControlLink("cse_0175vvLNM7azFmumnANDJW5f"), "https://claude.ai/code/session_0175vvLNM7azFmumnANDJW5f");
});

test("claudeInboxState reads a live row's waiter, calls a pid-less or dead-pid row asleep, and does not guess otherwise (LD16: read-only)", () => {
	withDir((dir) => {
		const read = (rows: ClaudeLaneRow[], extra: Parameters<typeof claudeInboxState>[1] = {}) => claudeInboxState(dir, { readRows: () => rows, readJob: () => idleJob, ...extra })("cc-idle");
		assert.deepEqual(read([{ ...idleRow, pid: 4242 }], { pidAlive: () => true, waiterAlive: () => false }), { state: "live", waiter: false });
		assert.deepEqual(read([{ ...idleRow, pid: 4242 }], { pidAlive: () => true, waiterAlive: () => true }), { state: "live", waiter: true });
		assert.deepEqual(read([{ ...idleRow, pid: 4242 }], { pidAlive: () => false }), { state: "asleep", why: "its process is gone" }, "a dead pid is asleep");
		assert.deepEqual(read([{ ...idleRow, pid: null } as unknown as ClaudeLaneRow]), { state: "asleep", why: "its process is gone" }, "the daemon retires an idle session and keeps its row with pid null");
		assert.equal(read([]), undefined, "no row: nothing is claimed");
		assert.equal(claudeInboxState(dir, { readRows: () => { throw new Error("claude agents timed out"); }, readJob: () => idleJob })("cc-idle"), undefined);
	});
});

test("claudeInboxState answers an interactive card without asking `claude agents`", () => {
	withDir((dir) => {
		writeLaneCard(dir, { laneId: "orchestrator", harness: "claude", cwd: "/w", branch: "main", state: "running", model: null, thinking: null, since: 1, updatedAt: Date.now(), wall: null, sessionId: IDLE_SESSION });
		let asked = 0;
		const state = claudeInboxState(dir, { readRows: () => { asked += 1; return [idleRow]; }, readJob: () => undefined })("orchestrator");
		assert.equal(state, undefined);
		assert.equal(asked, 0);
	});
});

test("readClaudeJob reads the daemon's record only for the session it names", () => {
	withJobs([{ sessionId: SESSION_A, name: "cc-scratch-a" }], (jobsDir) => {
		const job = readClaudeJob(SESSION_A, { jobsDir });
		assert.equal(job?.name, "cc-scratch-a");
		assert.equal(job?.template, "bg");
		assert.equal(readClaudeJob(SESSION_B, { jobsDir }), undefined);
	});
});

test("readClaudeJob carries the record's tempo, updatedAt and in-flight task count", () => {
	withDir((jobsDir) => {
		mkdirSync(join(jobsDir, SESSION_A.slice(0, 8)), { recursive: true });
		writeFileSync(
			join(jobsDir, SESSION_A.slice(0, 8), "state.json"),
			JSON.stringify({ name: "cc-scratch-a", sessionId: SESSION_A, template: "bg", state: "working", tempo: "idle", updatedAt: "2026-10-09T12:10:50.267Z", inFlight: { tasks: 2, queued: 0 } }),
		);
		const job = readClaudeJob(SESSION_A, { jobsDir });
		assert.deepEqual({ tempo: job?.tempo, updatedAtMs: job?.updatedAtMs, inFlightTasks: job?.inFlightTasks }, { tempo: "idle", updatedAtMs: Date.parse("2026-10-09T12:10:50.267Z"), inFlightTasks: 2 });
	});
});
