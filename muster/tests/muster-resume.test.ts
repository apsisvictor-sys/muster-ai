import "./muster-test-isolation.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeJob } from "../lib/claude-lane-card.ts";
import type { ClaudeLaneRow } from "../lib/lane-directory.ts";
import { LANE_BUS_VERBS, laneVerbCell } from "../lib/lane-control.ts";
import { writeLaneCard } from "../lib/lane-card.ts";
import { readLaneRecord, recordLaunch, writeLaneRecord } from "../lane-lifecycle.ts";
import { command, resumeCommand, type ResumeDeps } from "../cli/resume.ts";
import type { CliContext } from "../cli/types.ts";

const SESSION = "7a1b2c3d-1111-4222-8333-444455556666";
const asleepRow: ClaudeLaneRow = { id: "7a1b2c3d", sessionId: SESSION, cwd: "/work/w", name: "cc-w", kind: "background", state: "done", startedAt: 3_000 };
const liveRow: ClaudeLaneRow = { ...asleepRow, pid: 4300, state: "working" };
const job: ClaudeJob = { sessionId: SESSION, name: "cc-w", template: "bg", cwd: "/work/w", respawnFlags: ["--name", "cc-w", "--model", "haiku"], bridgeSessionId: "cse_0175vvLNM7azFmumnANDJW5f" };

function fixture(run: (dir: string) => Promise<void> | void): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "muster-resume-"));
	return Promise.resolve(run(dir)).finally(() => { rmSync(dir, { recursive: true, force: true }); });
}

function ctxFor(dir: string, argv: string[], json = false): { ctx: CliContext; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	return { out, err, ctx: { argv, repoRoot: dir, agentId: "orchestrator", json, cwd: dir, env: { ...process.env, PI_MUSTER_STATE_DIR: dir }, io: { out: (line) => out.push(line), err: (line) => err.push(line) }, readStdin: async () => "" } };
}

/** A `claude` CLI spy and a fake clock; the first listing is the lane's row, the next ones the woken row. */
function fakeClaude(before: ClaudeLaneRow[], after: ClaudeLaneRow[], stdout = "backgrounded · 7a1b2c3d · cc-w\n"): { deps: ResumeDeps; calls: string[][] } {
	const calls: string[][] = [];
	const listings = [before];
	let t = 1_000_000;
	return {
		calls,
		deps: {
			sessionRows: () => ({}),
			claude: {
				readRows: () => listings.shift() ?? after,
				runCli: (args) => { calls.push(args); return { status: 0, stdout, stderr: "" }; },
				readJob: () => job,
				pidAlive: (pid) => pid === 4300,
				now: () => t,
				sleep: (ms) => { t += ms; },
			},
		},
	};
}

function seed(dir: string, laneId = "cc-w", extra: Partial<Parameters<typeof recordLaunch>[1]> = {}): void {
	recordLaunch(dir, { laneId, harness: "claude", cwd: "/work/w", branch: null, sessionId: SESSION, title: "A lane the resume fixture parks", ...extra });
}

test("`resume` is a bus verb with a cell for every harness, and a verb file the frame discovers", () => {
	assert.ok((LANE_BUS_VERBS as readonly string[]).includes("resume"));
	assert.equal(command.name, "resume");
	assert.equal(laneVerbCell("claude", "resume").support, "adapter");
	assert.equal(laneVerbCell("pi", "resume").support, "cannot");
	assert.equal(laneVerbCell("unknown", "resume").support, "cannot");
});

test("sessions no automation touches are refused with the substitute, and the claude CLI is never called", async () => {
	await fixture(async (dir) => {
		const cases: Array<{ laneId: string; setup: () => void; rows?: ResumeDeps["sessionRows"] }> = [
			{ laneId: "sn-product", setup: () => seed(dir, "sn-product", { kind: "conversation" }) },
			{ laneId: "orchestrator", setup: () => undefined },
			{ laneId: "operator-0a", setup: () => undefined, rows: () => ({ registryRow: { origin: "operator" } }) },
			{ laneId: "cc-w", setup: () => seed(dir), rows: () => ({ agentsRow: { kind: "interactive" } }) },
		];
		for (const { laneId, setup, rows } of cases) {
			setup();
			const fake = fakeClaude([asleepRow], [liveRow]);
			const { ctx, err, out } = ctxFor(dir, [laneId, "--message", "hello"]);
			const code = await resumeCommand(ctx, { ...fake.deps, ...(rows !== undefined ? { sessionRows: rows } : {}) });
			assert.equal(code, 3, laneId);
			assert.deepEqual(fake.calls, [], `${laneId}: the claude CLI is never called`);
			assert.deepEqual(out, []);
			assert.match(err.join("\n"), /the operator opens it in the Claude app or runs `claude attach .+`; it keeps its id/, laneId);
		}
	});
});

test("a merged or closed lane is refused with `start a new lane`: exit 3, no claude call, no lease (LD26)", async () => {
	await fixture(async (dir) => {
		for (const phase of ["merged", "closed", "abandoned"] as const) {
			seed(dir);
			const record = readLaneRecord(dir, "cc-w")!;
			writeLaneRecord(dir, { ...record, phase, terminal: { outcome: phase === "merged" ? "merged" : "abandoned", reason: "test", sha: null, at: 1 } });
			const fake = fakeClaude([asleepRow], [liveRow]);
			const { ctx, err, out } = ctxFor(dir, ["cc-w", "--message", "hello"]);
			assert.equal(await resumeCommand(ctx, fake.deps), 3, phase);
			assert.deepEqual(fake.calls, [], `${phase}: the claude CLI is never called`);
			assert.deepEqual(out, []);
			assert.equal(err.join("\n"), "muster resume: cc-w was not resumed: cc-w is merged (or closed); start a new lane", phase);
			assert.equal(existsSync(join(dir, "resume")), false, `${phase}: no lease was taken`);
			const json = ctxFor(dir, ["cc-w"], true);
			assert.equal(await resumeCommand(json.ctx, fakeClaude([asleepRow], [liveRow]).deps), 3);
			assert.deepEqual(JSON.parse(json.out.join("\n")), { laneId: "cc-w", ok: false, reason: "cc-w is merged (or closed); start a new lane" });
			assert.equal(readLaneRecord(dir, "cc-w")?.phase, phase, "the record is not touched");
		}
	});
});

test("a lane whose process is alive is refused: the message is in its inbox, and nothing is spawned", async () => {
	await fixture(async (dir) => {
		seed(dir);
		const fake = fakeClaude([liveRow], [liveRow]);
		const { ctx, err } = ctxFor(dir, ["cc-w", "--message", "hello"]);
		assert.equal(await resumeCommand(ctx, fake.deps), 3);
		assert.match(err.join("\n"), /its process is alive.*The message is in its inbox/);
		assert.deepEqual(fake.calls, []);
	});
});

test("a pid-less worker is woken by one call in order, and the old and new short ids, the session id and the Remote Control link are printed", async () => {
	await fixture(async (dir) => {
		seed(dir);
		const fake = fakeClaude([asleepRow], [liveRow]);
		const { ctx, out, err } = ctxFor(dir, ["cc-w", "--message", "run the rest"]);
		assert.equal(await resumeCommand(ctx, fake.deps), 0, err.join("\n"));
		assert.equal(fake.calls.length, 1);
		assert.deepEqual(fake.calls[0]?.slice(0, 3), ["--bg", "--resume", SESSION]);
		assert.match(fake.calls[0]?.[3] ?? "", /Muster message for cc-w from orchestrator, delivered on resume:\nrun the rest/);
		assert.equal(fake.calls[0]?.length, 4, "no flags, no stop");
		const printed = out.join("\n");
		assert.match(printed, /short id: 7a1b2c3d -> 7a1b2c3d/);
		assert.match(printed, new RegExp(`session id: ${SESSION}`));
		assert.match(printed, /Remote Control: https:\/\/claude\.ai\/code\/session_0175vvLNM7azFmumnANDJW5f/);
		assert.equal(existsSync(join(dir, "resume", "cc-w.lock")), false);
	});
});

test("--json carries the same facts, and a job with no Remote Control entry says so", async () => {
	await fixture(async (dir) => {
		seed(dir);
		const fake = fakeClaude([asleepRow], [liveRow]);
		fake.deps.claude!.readJob = () => ({ ...job, bridgeSessionId: undefined } as ClaudeJob);
		const { ctx, out } = ctxFor(dir, ["cc-w"], true);
		assert.equal(await resumeCommand(ctx, fake.deps), 0);
		assert.deepEqual(JSON.parse(out.join("\n")), { laneId: "cc-w", ok: true, oldShortId: "7a1b2c3d", newShortId: "7a1b2c3d", sessionId: SESSION, remoteControl: null, rowSeen: true, detail: "claude --bg --resume 7a1b2c3d: woke the same session" });
		assert.deepEqual(fake.calls[0], ["--bg", "--resume", SESSION], "no --message: no prompt argument");
	});
});

test("a second resume is refused with `resume in progress` while the first holds the lease", async () => {
	await fixture(async (dir) => {
		seed(dir);
		mkdirSync(join(dir, "resume"), { recursive: true });
		writeFileSync(join(dir, "resume", "cc-w.lock"), JSON.stringify({ pid: 4300, at: 1_000_000 - 2_000 }));
		const fake = fakeClaude([asleepRow], [liveRow]);
		const { ctx, err } = ctxFor(dir, ["cc-w"]);
		assert.equal(await resumeCommand(ctx, fake.deps), 3);
		assert.match(err.join("\n"), /resume in progress/);
		assert.deepEqual(fake.calls, []);
	});
});

test("a parked record goes back to working once its session is woken; a copy under another id is a failure with the stop command", async () => {
	await fixture(async (dir) => {
		seed(dir);
		const parked = readLaneRecord(dir, "cc-w")!;
		writeLaneRecord(dir, { ...parked, phase: "parked", parkedAt: 5 });
		const fake = fakeClaude([], [liveRow]);
		const { ctx } = ctxFor(dir, ["cc-w", "--message", "go"]);
		assert.equal(await resumeCommand(ctx, fake.deps), 0);
		assert.equal(readLaneRecord(dir, "cc-w")?.phase, "working");
		assert.deepEqual(readLaneRecord(dir, "cc-w")?.sessionChain, [SESSION], "the chain keeps the session; the woken session's heartbeat appends any new one");

		const copy = fakeClaude([asleepRow], [{ ...liveRow, id: "8f9e0a1b", sessionId: "8f9e0a1b-0000-4000-8000-000000000000" }], "backgrounded · 8f9e0a1b · cc-w\n");
		const second = ctxFor(dir, ["cc-w"]);
		assert.equal(await resumeCommand(second.ctx, copy.deps), 3);
		assert.match(second.err.join("\n"), /started a copy \(8f9e0a1b\).*claude stop 8f9e0a1b/);
	});
});

test("a Pi lane is refused with the harness's own substitute", async () => {
	await fixture(async (dir) => {
		writeLaneCard(dir, { laneId: "pi-x", harness: "pi", cwd: "/w", branch: null, state: "idle", model: null, thinking: null, since: 1, updatedAt: 2, wall: null });
		const fake = fakeClaude([asleepRow], [liveRow]);
		const { ctx, err } = ctxFor(dir, ["pi-x"]);
		assert.equal(await resumeCommand(ctx, fake.deps), 3);
		assert.match(err.join("\n"), /parked Pi lane is relaunched by the launcher/);
		assert.deepEqual(fake.calls, []);
	});
});

test("a lane id is required", async () => {
	await fixture(async (dir) => {
		const { ctx, err } = ctxFor(dir, []);
		assert.equal(await resumeCommand(ctx, fakeClaude([], []).deps), 2);
		assert.match(err.join("\n"), /a lane is required/);
	});
});
