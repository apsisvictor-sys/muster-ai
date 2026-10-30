/**
 * Lane close tests — WP4 of the lane lifecycle blueprint (2026-10-11).
 *
 * `closeLane` is the one stop owner. Each harness's stop path runs against fake
 * ports (no tmux, no `claude`, no Concord), then the pieces that touch real files
 * run against temp dirs: the Concord repositories, the launcher's `--unregister`
 * and the `muster close` / `muster lane-record` commands.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stopClaudeLane } from "../lib/claude-lane-card.ts";
import type { ClaudeLaneRow } from "../lib/lane-directory.ts";
import { readLaneCard, writeLaneCard, type LaneHarness } from "../lib/lane-card.ts";
import { closeLane, idleLaneHelperScopes, laneRecordsArchiveDir, listLaneRecords, readLaneRecord, recordLaunch, writeLaneRecord, type CloseLanePorts, type LaneRecord } from "../lane-lifecycle.ts";
import { closeConcordLane, listActiveScopes, parkedLaneResume, readClaudeTableStrict, realCloseLanePorts, stopClaudeChecked, stopIdleHelperScopes } from "../lane-lifecycle-ports.ts";
import { deliverLaneMessage, type SendDeps } from "../send.ts";
import { createGatewayTools } from "../gateway/tools.ts";
import { harnessRoot } from "../../core/harness-paths.ts";
import { musterLauncher, piAgentDir } from "../../core/pi-ports.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = musterLauncher();
const T0 = Date.parse("2026-10-12T00:00:00Z");

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "lane-close-"));
}

function record(overrides: Partial<LaneRecord> = {}): LaneRecord {
	return { laneId: "pi-x", harness: "pi", cwd: "/w/x", branch: "lane/x", launchedAt: T0, launchedBy: "orchestrator", phase: "review_ready", phaseSince: T0, lastReport: { kind: "review_ready", summary: "done", at: T0, sha: "abc1234" }, ...overrides };
}

type World = { pane: "alive" | "dead" | "absent"; card: { harness: LaneHarness; sessionId?: string; live: boolean } | undefined; registry: LaneHarness | undefined };

/** Fake ports over a tiny world. `onSleep` lets a test play the lane's side (it ends its pane and card). */
function fakePorts(world: World, onSleep?: (count: number) => void): { ports: CloseLanePorts; calls: string[]; clock: () => number } {
	const calls: string[] = [];
	let now = T0;
	let sleeps = 0;
	const ports: CloseLanePorts = {
		now: () => now,
		sleep: async (ms) => { now += ms; sleeps += 1; calls.push(`sleep ${ms}`); onSleep?.(sleeps); },
		card: () => world.card,
		registryHarness: () => world.registry,
		stopClaude: (laneId) => { calls.push(`claude-stop ${laneId}`); return { ok: true, handle: "15d51acb", detail: "claude stop 15d51acb: stopped" }; },
		enqueueStop: (laneId, from) => { calls.push(`enqueue-stop ${laneId} ${from}`); },
		paneState: () => world.pane,
		killWindow: (_h, laneId) => { calls.push(`kill-window ${laneId}`); world.pane = "absent"; },
		removeCard: (laneId) => { calls.push(`remove-card ${laneId}`); world.card = undefined; },
		stopHelper: async (pid) => { calls.push(`stop-helper ${pid}`); return "stopped"; },
		stopHelperScope: async (unit) => { calls.push(`stop-helper-scope ${unit}`); return "stopped"; },
		unregister: async (_h, laneId) => { calls.push(`unregister ${laneId}`); return { ok: true, detail: `removed ${laneId} from the registry` }; },
		closeConcord: async (repoRoot, laneId) => { calls.push(`concord ${laneId} ${repoRoot ?? "default"}`); return { endpoints: 1, agent: "done" }; },
	};
	return { ports, calls, clock: () => now };
}

test("a Pi lane that obeys its own stop: window killed once the pane is dead, registry and Concord cleaned, record closed", async () => {
	const dir = tempDir();
	try {
		writeLaneRecord(dir, record({ repoRoot: "/concord/root" }));
		const world: World = { pane: "alive", card: { harness: "pi", live: true }, registry: "pi" };
		const { ports, calls } = fakePorts(world, () => { world.pane = "dead"; world.card = undefined; });
		const result = await closeLane(dir, "pi-x", { park: false, terminal: { outcome: "abandoned", reason: "stopped by orchestrator" }, caller: "orchestrator" }, ports);
		assert.equal(result.ok, true, result.detail);
		assert.deepEqual(calls.filter((c) => !c.startsWith("sleep")), ["enqueue-stop pi-x orchestrator", "kill-window pi-x", "remove-card pi-x", "unregister pi-x", "concord pi-x /concord/root"]);
		assert.equal(calls.filter((c) => c === "kill-window pi-x").length, 1, "the window is killed once");
		const after = readLaneRecord(dir, "pi-x")!;
		assert.equal(after.phase, "closed");
		assert.equal(after.terminal?.outcome, "abandoned");
		assert.equal(after.terminal?.reason, "stopped by orchestrator");
		assert.equal(after.terminal?.sha, "abc1234", "the closed record keeps the reported SHA");
		assert.equal(typeof after.terminal?.closedAt, "number");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a Pi pane that ignores its stop is killed after 60 s, not before", async () => {
	const dir = tempDir();
	try {
		const world: World = { pane: "alive", card: { harness: "pi", live: true }, registry: "pi" };
		const { ports, calls, clock } = fakePorts(world);
		const result = await closeLane(dir, "pi-x", { park: false, terminal: { outcome: "abandoned", reason: "r" } }, ports);
		assert.equal(result.ok, true, result.detail);
		assert.ok(clock() - T0 >= 60_000 && clock() - T0 < 62_000, `waited about 60 s, waited ${clock() - T0} ms`);
		assert.ok(calls.indexOf("kill-window pi-x") > calls.lastIndexOf("sleep 1000"), "the kill comes after the wait");
		assert.match(result.detail, /did not end the pane within 60 s/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a live card with no tmux window that ignores its stop is refused and nothing else changes", async () => {
	const dir = tempDir();
	try {
		writeLaneRecord(dir, record());
		const world: World = { pane: "absent", card: { harness: "pi", live: true }, registry: "pi" };
		const { ports, calls } = fakePorts(world);
		const result = await closeLane(dir, "pi-x", { park: false, caller: "orchestrator" }, ports);
		assert.equal(result.ok, false);
		assert.match(result.detail, /no tmux window to kill/);
		assert.ok(!calls.some((c) => c.startsWith("unregister") || c.startsWith("concord") || c.startsWith("remove-card")), "no cleanup ran");
		assert.equal(readLaneRecord(dir, "pi-x")!.phase, "review_ready", "the record is unchanged");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a stale card has no reader: no stop request is queued, and a live pane is ended with its window", async () => {
	const dir = tempDir();
	try {
		const world: World = { pane: "alive", card: { harness: "pi", live: false }, registry: "pi" };
		const { ports, calls, clock } = fakePorts(world);
		const result = await closeLane(dir, "pi-x", { park: false }, ports);
		assert.equal(result.ok, true);
		assert.ok(!calls.some((c) => c.startsWith("enqueue-stop")), "a request nobody reads would stop the next lane with this name");
		assert.ok(calls.includes("kill-window pi-x"));
		assert.equal(clock(), T0, "nothing is waited for");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a leftover window and registry row with no card are cleaned up (the grokbot-test lanes)", async () => {
	const dir = tempDir();
	try {
		const world: World = { pane: "dead", card: undefined, registry: "opencode" };
		const { ports, calls } = fakePorts(world);
		const result = await closeLane(dir, "oc-old", { park: false }, ports);
		assert.equal(result.ok, true, result.detail);
		assert.deepEqual(calls.filter((c) => c !== "remove-card oc-old"), ["kill-window oc-old", "unregister oc-old", "concord oc-old default"]);
		assert.match(result.detail, /no lane record to update/);
		assert.equal(readLaneRecord(dir, "oc-old"), undefined, "closing never invents a record");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("parking keeps the registry row and the Concord agent; closing removes both", async () => {
	const dir = tempDir();
	try {
		writeLaneRecord(dir, record());
		const parkWorld: World = { pane: "dead", card: { harness: "pi", sessionId: "s-1", live: false }, registry: "pi" };
		const parked = fakePorts(parkWorld);
		const result = await closeLane(dir, "pi-x", { park: true, caller: "tick" }, parked.ports);
		assert.equal(result.ok, true);
		assert.ok(parked.calls.includes("kill-window pi-x"), "the window is killed when parking");
		assert.ok(!parked.calls.some((c) => c.startsWith("unregister") || c.startsWith("concord")), "parking keeps the registry row and the Concord agent");
		const record1 = readLaneRecord(dir, "pi-x")!;
		assert.equal(record1.phase, "parked");
		assert.equal(record1.parkedAt, T0);
		assert.equal(record1.sessionId, "s-1");

		const closeWorld: World = { pane: "dead", card: undefined, registry: "pi" };
		const closed = fakePorts(closeWorld);
		await closeLane(dir, "pi-x", { park: false, terminal: { outcome: "merged", reason: "in origin/dev" } }, closed.ports);
		assert.ok(closed.calls.some((c) => c.startsWith("unregister")) && closed.calls.some((c) => c.startsWith("concord")));
		const record2 = readLaneRecord(dir, "pi-x")!;
		assert.equal(record2.phase, "closed");
		assert.equal(record2.terminal?.outcome, "merged");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a Claude lane is stopped with `claude stop`; no tmux, registry or window call is made", async () => {
	const dir = tempDir();
	try {
		writeLaneRecord(dir, record({ laneId: "cc-x", harness: "claude" }));
		const world: World = { pane: "absent", card: { harness: "claude", sessionId: "sess-9", live: true }, registry: undefined };
		const { ports, calls } = fakePorts(world);
		const result = await closeLane(dir, "cc-x", { park: true }, ports);
		assert.equal(result.ok, true, result.detail);
		assert.deepEqual(calls, ["claude-stop cc-x"]);
		const after = readLaneRecord(dir, "cc-x")!;
		assert.equal(after.phase, "parked");
		assert.equal(after.sessionId, "sess-9", "the session id is kept for the resume");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a Claude stop the CLI refuses changes nothing; a lane with no live session still closes", async () => {
	const dir = tempDir();
	try {
		writeLaneRecord(dir, record({ laneId: "cc-x", harness: "claude" }));
		const world: World = { pane: "absent", card: { harness: "claude", live: true }, registry: undefined };
		const refusing = fakePorts(world);
		refusing.ports.stopClaude = () => ({ ok: false, handle: "15d51acb", reason: "couldn't confirm it was stopped", detail: "claude stop 15d51acb: refused" });
		const refused = await closeLane(dir, "cc-x", { park: false }, refusing.ports);
		assert.equal(refused.ok, false);
		assert.match(refused.detail, /couldn't confirm it was stopped/);
		assert.equal(readLaneRecord(dir, "cc-x")!.phase, "review_ready");
		assert.ok(!refusing.calls.some((c) => c.startsWith("concord")));

		const gone = fakePorts(world);
		gone.ports.stopClaude = () => ({ ok: false, absent: true, reason: "no live background session", detail: "refused" });
		const closed = await closeLane(dir, "cc-x", { park: false, caller: "orchestrator" }, gone.ports);
		assert.equal(closed.ok, true, closed.detail);
		assert.equal(readLaneRecord(dir, "cc-x")!.phase, "closed");
		assert.ok(gone.calls.includes("remove-card cc-x"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a Claude close whose session cannot be confirmed absent or stopped keeps the card and the record (LC16 F10)", async () => {
	const dir = tempDir();
	try {
		writeLaneRecord(dir, record({ laneId: "cc-x", harness: "claude" }));
		const world: World = { pane: "absent", card: { harness: "claude", live: true }, registry: undefined };
		const unreadable = fakePorts(world);
		unreadable.ports.stopClaude = () => ({ ok: false, reason: "`claude agents --json` could not be read: spawn claude ENOENT", detail: "claude stop cc-x: refused" });
		const refused = await closeLane(dir, "cc-x", { park: false, caller: "orchestrator" }, unreadable.ports);
		assert.equal(refused.ok, false);
		assert.match(refused.detail, /could not be read/);
		assert.equal(readLaneRecord(dir, "cc-x")!.phase, "review_ready");
		assert.ok(!unreadable.calls.includes("remove-card cc-x"), "the card is the handle `muster control <lane> stop` needs");
		assert.ok(!unreadable.calls.some((c) => c.startsWith("concord")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readClaudeTableStrict tells a registry it could not read from an empty one", () => {
	const ok = (stdout: string) => () => ({ status: 0, stdout, stderr: "" });
	assert.deepEqual(readClaudeTableStrict(ok("[]")), { ok: true, rows: [] });
	assert.equal(readClaudeTableStrict(ok('[{"id":"a1","sessionId":"S","name":"cc-x"}]')).ok, true);
	for (const [label, run] of [
		["claude not on PATH", () => ({ status: null, stdout: "", stderr: "spawn claude ENOENT" })],
		["a timeout", () => ({ status: null, stdout: "", stderr: "spawnSync claude ETIMEDOUT" })],
		["a non-zero exit", () => ({ status: 1, stdout: "", stderr: "daemon not running" })],
		["output that is not JSON", ok("backgrounded")],
		["JSON that is not a list", ok("{}")],
	] as const) {
		const table = readClaudeTableStrict(run);
		assert.equal(table.ok, false, label);
		assert.match(table.ok ? "" : table.reason, /claude agents --json/, label);
	}
});

test("stopClaudeChecked: an unreadable registry stops nothing and keeps the card; a listed idle session is stopped by its short id; only a readable registry without the lane is absent", () => {
	const dir = tempDir();
	try {
		const cli: string[][] = [];
		const run = (args: string[]) => { cli.push(args); return { status: 0, stdout: "", stderr: "" }; };
		const keepCard = (lane: string) => writeLaneCard(dir, { laneId: lane, harness: "claude", cwd: null, branch: null, state: "idle", model: null, thinking: null, since: T0, updatedAt: Date.now(), wall: null, sessionId: `S-${lane}` });

		keepCard("cc-a");
		const unreadable = stopClaudeChecked(dir, "cc-a", () => ({ ok: false, reason: "`claude agents --json` could not be read: spawn claude ENOENT" }), { runCli: run });
		assert.equal(unreadable.ok, false);
		assert.equal(unreadable.absent, undefined);
		assert.match(unreadable.reason ?? "", /could not be read/);
		assert.deepEqual(cli, []);
		assert.ok(readLaneCard(dir, "cc-a"), "the card stays");

		// The rehearsal's session: idle, listed, a short id, no pid (a retired idle session keeps its row).
		const idle: ClaudeLaneRow = { id: "5440f6fc", sessionId: "S-cc-a", name: "cc-a", kind: "background", status: "idle", state: "done" };
		const stopped = stopClaudeChecked(dir, "cc-a", () => ({ ok: true, rows: [idle] }), { runCli: run });
		assert.equal(stopped.ok, true, stopped.detail);
		assert.deepEqual(cli, [["stop", "5440f6fc"]]);
		assert.equal(readLaneCard(dir, "cc-a"), undefined, "the card goes only after the stop");

		keepCard("cc-b");
		cli.length = 0;
		const refusedStop = stopClaudeChecked(dir, "cc-b", () => ({ ok: true, rows: [{ ...idle, sessionId: "S-cc-b", name: "cc-b" }] }), { runCli: () => ({ status: 1, stdout: "", stderr: "no such job" }) });
		assert.equal(refusedStop.ok, false);
		assert.equal(refusedStop.absent, undefined);
		assert.equal(refusedStop.handle, "5440f6fc");
		assert.ok(readLaneCard(dir, "cc-b"), "a refused stop keeps the card");

		const absent = stopClaudeChecked(dir, "cc-b", () => ({ ok: true, rows: [] }), { runCli: run });
		assert.equal(absent.ok, false);
		assert.equal(absent.absent, true);
		assert.deepEqual(cli, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the orchestrator and the operator's sessions are refused; a close without a terminal keeps the record's own, else abandoned", async () => {
	const dir = tempDir();
	try {
		const world: World = { pane: "absent", card: undefined, registry: "pi" };
		const { ports, calls } = fakePorts(world);
		assert.equal((await closeLane(dir, "orchestrator", { park: false }, ports)).ok, false);
		assert.equal((await closeLane(dir, "operator:claude:abcd1234", { park: true }, ports)).ok, false);
		assert.deepEqual(calls, [], "nothing was called for either");

		writeLaneRecord(dir, record({ phase: "merged", terminal: { outcome: "merged", reason: "in origin/dev", sha: "abc1234", at: T0 + 5 } }));
		await closeLane(dir, "pi-x", { park: false }, fakePorts(world).ports);
		const kept = readLaneRecord(dir, "pi-x")!;
		assert.equal(kept.terminal?.outcome, "merged");
		assert.equal(kept.terminal?.at, T0 + 5, "the tick's own decision time is kept");

		writeLaneRecord(dir, record({ laneId: "pi-y" }));
		await closeLane(dir, "pi-y", { park: false, caller: "henry" }, fakePorts(world).ports);
		assert.equal(readLaneRecord(dir, "pi-y")!.terminal?.reason, "closed by henry");
		assert.equal(readLaneRecord(dir, "pi-y")!.terminal?.outcome, "abandoned");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a launch creates the record; a parked lane comes back to working; a finished name is archived first", () => {
	const dir = tempDir();
	try {
		const first = recordLaunch(dir, { laneId: "pi-x", harness: "pi", cwd: "/w/x", branch: "lane/x", sessionId: "s-1", repoRoot: "/r", launchedBy: "grokbot", title: "A lane that closes with a commit" }, T0);
		assert.equal(first.phase, "working");
		assert.equal(first.launchedBy, "grokbot");
		assert.equal(first.repoRoot, "/r");

		writeLaneRecord(dir, { ...first, phase: "parked", parkedAt: T0 + 10, reminded: { orchestratorAt: T0 + 5 } });
		const back = recordLaunch(dir, { laneId: "pi-x", harness: "pi", cwd: "/w/x", branch: "lane/x", title: "A lane that closes with a commit" }, T0 + 20);
		assert.equal(back.phase, "working");
		assert.equal(back.phaseSince, T0 + 20);
		assert.equal(back.launchedAt, T0, "the lane keeps its history");
		assert.equal(back.parkedAt, undefined);
		assert.deepEqual(back.reminded, {});

		writeLaneRecord(dir, { ...back, phase: "closed", terminal: { outcome: "abandoned", reason: "r", sha: null, at: T0 + 30, closedAt: T0 + 30 } });
		const reused = recordLaunch(dir, { laneId: "pi-x", harness: "pi", cwd: "/w/z", branch: null, title: "The same name, a new lane" }, T0 + 40);
		assert.equal(reused.phase, "working");
		assert.equal(reused.launchedAt, T0 + 40);
		const archived = readdirSync(join(laneRecordsArchiveDir(dir), "2026-10"));
		assert.deepEqual(archived, ["pi-x.json"], "the finished record is kept in the archive");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- Concord, through its own repositories ---

async function concordRepos() {
	const require = createRequire(join(piAgentDir(), "extensions", "muster", "x.js"));
	const load = async (name: string) => (await import(pathToFileURL(require.resolve(`@concord-ai/concord-mcp/dist/db/${name}.js`)).href)) as Record<string, any>;
	return { connection: await load("connection"), agents: await load("repositories/agents"), endpoints: await load("repositories/agent-endpoints") };
}

test("closing a lane disconnects its Concord endpoints and marks its agent done, and the workspace stays readable", async () => {
	const root = tempDir();
	try {
		mkdirSync(join(root, ".concord"));
		const { connection, agents, endpoints } = await concordRepos();
		const seed = connection.openDatabase(join(root, ".concord", "concord.db"));
		for (const id of ["pi-x", "pi-other"]) {
			agents.createAgentRepository(seed).upsert({ agentId: id, kind: "pi", owner: null, model: "m", pid: 1, cwd: "/w", worktree: null, branch: null, summary: "s", status: "active" });
			endpoints.createAgentEndpointRepository(seed).upsert({ endpointId: `ep-${id}`, agentId: id, provider: "p", transport: "t", capabilities: [], address: "a", credentialHash: "h" });
		}
		seed.close();

		assert.deepEqual(await closeConcordLane(root, "pi-x"), { endpoints: 1, agent: "done" });
		assert.deepEqual(await closeConcordLane(root, "no-such-lane"), { endpoints: 0, agent: "absent" });
		assert.deepEqual(await closeConcordLane(join(root, "nowhere"), "pi-x"), { endpoints: 0, agent: "no-database" });

		const check = connection.openDatabase(join(root, ".concord", "concord.db"));
		const list = agents.createAgentRepository(check).list();
		assert.equal(list.find((a: { agentId: string }) => a.agentId === "pi-x").status, "done");
		assert.equal(list.find((a: { agentId: string }) => a.agentId === "pi-other").status, "active", "other agents are untouched");
		const eps = endpoints.createAgentEndpointRepository(check).list();
		assert.equal(eps.find((e: { agentId: string }) => e.agentId === "pi-x").status, "disconnected");
		assert.equal(eps.find((e: { agentId: string }) => e.agentId === "pi-other").status, "connected");

		// Why `done` and not the blueprint's `inactive`: Concord's agent statuses are a closed set, and
		// one row outside it makes the whole workspace unreadable (the table has no CHECK, so SQLite accepts the write).
		check.prepare("UPDATE agents SET status = 'inactive' WHERE agent_id = 'pi-other'").run();
		assert.throws(() => agents.createAgentRepository(check).list(), "an `inactive` agent breaks AgentRepository.list() for every reader");
		check.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// --- resuming a parked lane ---

test("a message to a parked Pi lane writes the resume brief and relaunches the lane with it", async () => {
	const dir = tempDir();
	const msgs = tempDir();
	try {
		writeLaneRecord(dir, record({ phase: "parked", parkedAt: T0, repoRoot: "/r" }));
		const launches: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
		const resume = parkedLaneResume(dir, "orchestrator", { msgsDir: msgs, now: () => new Date("2026-10-12T00:42:00Z"), launch: async (args, env) => { launches.push({ args, env }); return { ok: true, detail: "pi-lane-launch: registered" }; } });
		const result = await resume({ laneId: "pi-x", text: "please also cover the janitor" });
		assert.equal(result.state, "resumed");
		const brief = join(msgs, "pi-x-resume-20261012-0042.md");
		assert.equal(readFileSync(brief, "utf8").includes("please also cover the janitor"), true);
		assert.deepEqual(launches[0]!.args, ["--lane", "pi-x", "--harness", "pi", "--cwd", "/w/x", "--brief", brief, "--resume-brief", "--no-attach", "--launched-by", "orchestrator", "--repo-root", "/r"]);
		assert.equal(launches[0]!.env["PI_LANES_JSON"], join(dirname(dir), "pi-lanes.json"));

		// A second resume in the same minute never overwrites the first brief.
		await resume({ laneId: "pi-x", text: "again" });
		assert.deepEqual(readdirSync(msgs).sort(), ["pi-x-resume-20261012-0042-2.md", "pi-x-resume-20261012-0042.md"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(msgs, { recursive: true, force: true });
	}
});

test("a lane that is not parked is left to the normal transports; a failed relaunch keeps the brief and says so", async () => {
	const dir = tempDir();
	const msgs = tempDir();
	try {
		writeLaneRecord(dir, record({ phase: "review_ready" }));
		const never = async () => { throw new Error("must not launch"); };
		assert.deepEqual(await parkedLaneResume(dir, "o", { msgsDir: msgs, launch: never })({ laneId: "pi-x", text: "t" }), { state: "not-parked" });
		assert.deepEqual(await parkedLaneResume(dir, "o", { msgsDir: msgs, launch: never })({ laneId: "no-record", text: "t" }), { state: "not-parked" });
		assert.deepEqual(readdirSync(msgs), [], "no brief for a lane that is not parked");

		writeLaneRecord(dir, record({ phase: "parked" }));
		const failed = await parkedLaneResume(dir, "o", { msgsDir: msgs, launch: async () => ({ ok: false, detail: "exit 3" }) })({ laneId: "pi-x", text: "t" });
		assert.equal(failed.state, "failed");
		assert.match(failed.state === "failed" ? failed.reason : "", /exit 3.*brief kept at/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(msgs, { recursive: true, force: true });
	}
});

test("a message to a parked Claude lane resumes nothing and writes no brief: it answers inbox-only (LD16)", async () => {
	const dir = tempDir();
	const msgs = tempDir();
	try {
		writeLaneRecord(dir, record({ laneId: "cc-x", harness: "claude", phase: "parked", sessionId: "sess-9" }));
		const before = readFileSync(join(dir, "lifecycle", "cc-x.json"), "utf8");
		const result = await parkedLaneResume(dir, "orchestrator", { msgsDir: msgs, launch: async () => { throw new Error("must not launch"); } })({ laneId: "cc-x", text: "next step" });
		assert.equal(result.state, "inbox-only");
		assert.deepEqual(readdirSync(msgs), [], "no resume brief is written for a Claude session");
		assert.equal(readLaneRecord(dir, "cc-x")!.phase, "parked", "the record is not returned to working: nothing was resumed");
		assert.equal(readFileSync(join(dir, "lifecycle", "cc-x.json"), "utf8"), before);

		writeLaneRecord(dir, record({ laneId: "cc-y", harness: "claude", phase: "parked" }));
		assert.equal((await parkedLaneResume(dir, "o", { msgsDir: msgs })({ laneId: "cc-y", text: "t" })).state, "inbox-only", "a parked Claude record with no session id is still just an inbox target");
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(msgs, { recursive: true, force: true });
	}
});

// --- send and the gateway ---

function sendDeps(overrides: Partial<SendDeps>): { deps: SendDeps; logs: string[] } {
	const logs: string[] = [];
	return { logs, deps: { concord: undefined, pane: async () => ({ ok: false, command: "pane", detail: "no window" }), log: (record) => { logs.push(`${record.transport}:${record.error ?? "ok"}`); }, ...overrides } };
}

test("muster send asks the parked-lane resume first: resumed is a resume, failed is not delivered, not-parked falls through", async () => {
	const request = { laneId: "pi-x", mode: "followup" as const, text: "t" };
	const resumed = sendDeps({ resumeParked: async () => ({ state: "resumed", detail: "relaunched", brief: "/m/b.md" }) });
	const first = await deliverLaneMessage(request, resumed.deps);
	assert.equal(first.transport, "resume");
	assert.match(first.transport === "resume" ? first.detail : "", /\/m\/b\.md/);

	const failed = sendDeps({ resumeParked: async () => ({ state: "failed", reason: "no cwd" }) });
	const second = await deliverLaneMessage(request, failed.deps);
	assert.equal(second.transport, "none");
	assert.match(second.transport === "none" ? second.error : "", /parked and resuming it failed: no cwd/);

	const normal = sendDeps({ resumeParked: async () => ({ state: "not-parked" }) });
	const third = await deliverLaneMessage(request, normal.deps);
	assert.equal(third.transport, "none", "the normal path ran and found nothing to deliver to");
	assert.match(third.transport === "none" ? third.error : "", /pane fallback failed/);
});

test("the gateway's lane_control stop reaches closeLane on every harness, with the caller named", async () => {
	const closed: Array<{ laneId: string; caller: string }> = [];
	const tools = createGatewayTools({
		stateDir: "/tmp", lanes: () => [], notesRoot: "/tmp", agentId: "grokbot", sendToOrchestrator: async () => "",
		actions: {
			home: "/tmp", handoffsMsgsDir: "/tmp",
			deliverLaneMessage: async () => ({ ok: true, detail: "" }),
			readLaneCard: (_s, laneId) => ({ laneId, harness: laneId.startsWith("cc-") ? "claude" : "pi" }),
			enqueueLaneControl: () => { throw new Error("stop must not be queued by the gateway"); },
			closeLane: async (laneId, caller) => { closed.push({ laneId, caller }); return { ok: true, detail: "closed" }; },
			launchLane: async () => ({ ok: true, detail: "" }),
			readLaneLatestReport: () => undefined,
			canWriteBrief: () => ({ ok: false, reason: "test" }),
		},
	});
	const control = tools.find((tool) => tool.name === "lane_control")!;
	assert.match(String(await control.run({ lane: "pi-x", verb: "stop" })), /stopped pi-x: closed/);
	assert.match(String(await control.run({ lane: "cc-x", verb: "stop" })), /stopped cc-x: closed/);
	assert.deepEqual(closed, [{ laneId: "pi-x", caller: "grokbot" }, { laneId: "cc-x", caller: "grokbot" }]);
});

// --- LD17: one untouchable predicate, read by closeLane and the gateway (WP-C) ---

type Rows = ReturnType<NonNullable<CloseLanePorts["sessionRows"]>>;

function untouchableWorld(rows: Rows): { ports: CloseLanePorts; calls: string[] } {
	const world: World = { pane: "absent", card: { harness: "claude", sessionId: "S-1", live: true }, registry: undefined };
	const { ports, calls } = fakePorts(world);
	return { ports: { ...ports, sessionRows: () => rows }, calls };
}

test("closeLane refuses every untouchable session and runs nothing (LD17)", async () => {
	const dir = tempDir();
	try {
		writeLaneRecord(dir, record({ laneId: "design-x", harness: "claude", kind: "conversation" }));
		const cases: Array<{ lane: string; rows: Rows; detail: RegExp }> = [
			{ lane: "orchestrator", rows: {}, detail: /orchestrator lane is never stopped/ },
			{ lane: "operator:abc", rows: {}, detail: /the operator's own session \(LD2\)/ },
			{ lane: "operator-0a", rows: { registryRow: { origin: "operator" } }, detail: /the operator's own session \(LD2\)/ },
			{ lane: "cc-open", rows: { agentsRow: { kind: "interactive" } }, detail: /interactive session is never stopped/ },
			{ lane: "design-x", rows: {}, detail: /conversation session \(LD14, LD17\).*--end-conversation/ },
			{ lane: "sn-product", rows: {}, detail: /conversation session \(LD14, LD17\)/ },
		];
		for (const { lane, rows, detail } of cases) {
			const { ports, calls } = untouchableWorld(rows);
			const result = await closeLane(dir, lane, { park: false, terminal: { outcome: "abandoned", reason: "r" }, caller: "grokbot" }, ports);
			assert.equal(result.ok, false, lane);
			assert.match(result.detail, detail, lane);
			assert.deepEqual(calls, [], `${lane}: nothing was stopped, removed or queued`);
		}
		assert.equal(readLaneRecord(dir, "design-x")!.phase, "review_ready", "the record is untouched");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("--end-conversation lifts the conversation refusal only (LD17)", async () => {
	const dir = tempDir();
	try {
		writeLaneRecord(dir, record({ laneId: "design-x", harness: "claude", kind: "conversation" }));
		const options = { park: false, terminal: { outcome: "abandoned" as const, reason: "the operator ended the topic" }, caller: "orchestrator", endConversation: true };
		const open = untouchableWorld({});
		const ended = await closeLane(dir, "design-x", options, open.ports);
		assert.equal(ended.ok, true, ended.detail);
		assert.ok(open.calls.includes("claude-stop design-x"), "a conversation session is stopped when its topic is ended");
		assert.equal(readLaneRecord(dir, "design-x")!.phase, "closed");
		for (const [lane, rows] of [["orchestrator", {}], ["operator:abc", {}], ["operator-0a", { registryRow: { origin: "operator" } }], ["cc-open", { agentsRow: { kind: "interactive" } }]] as const) {
			const held = untouchableWorld(rows);
			const result = await closeLane(dir, lane, options, held.ports);
			assert.equal(result.ok, false, `${lane} stays refused`);
			assert.deepEqual(held.calls, [], lane);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the gateway's lane_control stop on a conversation, the operator's or the orchestrator's session is refused and the Claude CLI is never run; a worker is stopped once through closeLane (LD17)", async () => {
	const dir = tempDir();
	try {
		writeLaneRecord(dir, record({ laneId: "design-x", harness: "claude", kind: "conversation" }));
		const cli: string[][] = [];
		const readRows = (): ClaudeLaneRow[] => ["sn-product", "design-x", "operator-0a", "cc-w"].map((name, index) => ({ id: `abc1234${index}`, sessionId: `S-${index}`, name, kind: "background", pid: 100 + index }));
		const base = untouchableWorld({});
		const stopper: CloseLanePorts = {
			...base.ports,
			stopClaude: (laneId) => { const stopped = stopClaudeLane(dir, laneId, { readRows, runCli: (args) => { cli.push(args); return { status: 0, stdout: "", stderr: "" }; } }); return { ok: stopped.ok, ...(stopped.handle !== undefined ? { handle: stopped.handle } : {}), detail: stopped.detail }; },
		};
		const tools = createGatewayTools({
			stateDir: dir, lanes: () => [{ laneId: "operator-0a", origin: "operator" } as never], notesRoot: "/tmp", agentId: "grokbot", sendToOrchestrator: async () => "",
			actions: {
				home: "/tmp", handoffsMsgsDir: "/tmp",
				deliverLaneMessage: async () => ({ ok: true, detail: "" }),
				readLaneCard: (_s, laneId) => ({ laneId, harness: "claude" }),
				enqueueLaneControl: () => { throw new Error("a Claude stop must not be queued"); },
				closeLane: (laneId, caller) => closeLane(dir, laneId, { park: false, terminal: { outcome: "abandoned", reason: `stopped by ${caller}` }, caller }, stopper),
				launchLane: async () => ({ ok: true, detail: "" }),
				readLaneLatestReport: () => undefined,
				canWriteBrief: () => ({ ok: false, reason: "test" }),
			},
		});
		const control = tools.find((tool) => tool.name === "lane_control")!;
		const said = async (lane: string): Promise<string> => { const out = await control.run({ lane, verb: "stop" }); return typeof out === "string" ? out : JSON.stringify(out); };
		assert.match(await said("sn-product"), /refused: .*conversation session/);
		assert.match(await said("design-x"), /refused: .*conversation session/);
		assert.match(await said("operator-0a"), /refused: the operator's own session \(LD2\)/);
		await assert.rejects(said("orchestrator"), /orchestrator/);
		assert.deepEqual(cli, [], "the Claude CLI was never run for a protected session");
		assert.match(await said("cc-w"), /stopped cc-w/);
		assert.deepEqual(cli, [["stop", "abc12343"]], "the worker was stopped once, through closeLane");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- the launcher and the CLI, against temp dirs ---

function cliEnv(root: string): NodeJS.ProcessEnv {
	return { ...process.env, PI_CODING_AGENT_DIR: root, PI_MUSTER_STATE_DIR: join(root, "state", "muster"), PI_LANES_JSON: join(root, "state", "pi-lanes.json"), PI_LANES_TMUX_SESSION: "lane-close-test-nosuch" };
}

function muster(args: string[], env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(LAUNCHER, args, { encoding: "utf8", timeout: 90_000, env, cwd: join(HARNESS_ROOT) });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("`muster close` removes the real registry row through the launcher and records the lane closed", async () => {
	const root = tempDir();
	try {
		const state = join(root, "state", "muster");
		mkdirSync(state, { recursive: true });
		writeFileSync(join(root, "state", "pi-lanes.json"), JSON.stringify({ "pi-x": { sessionId: "s-1", harness: "pi" }, "pi-keep": { sessionId: "s-2", harness: "pi" } }));
		writeLaneRecord(state, record());
		const env = cliEnv(root);

		const closed = muster(["close", "pi-x", "--abandoned", "superseded by pi-y"], env);
		assert.equal(closed.status, 0, closed.stderr);
		assert.match(closed.stdout, /closed pi-x/);
		assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(root, "state", "pi-lanes.json"), "utf8"))), ["pi-keep"], "only the closed lane's row is removed");
		const after = readLaneRecord(state, "pi-x")!;
		assert.equal(after.phase, "closed");
		assert.equal(after.terminal?.reason, "superseded by pi-y");

		assert.equal(muster(["close", "pi-x"], env).status, 2, "a close names how the lane ended");
		assert.equal(muster(["close", "orchestrator", "--merged"], env).status, 3, "the orchestrator is refused");

		// The real ports read the same registry.
		assert.equal(realCloseLanePorts(state, env).registryHarness("pi-keep"), "pi");
		assert.equal(realCloseLanePorts(state, env).registryHarness("pi-x"), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("`muster lane-record launch` writes the record the launcher relies on", () => {
	const root = tempDir();
	try {
		const env = cliEnv(root);
		const out = muster(["lane-record", "launch", "--lane", "pi-z", "--harness", "pi", "--cwd", "/w/z", "--branch", "lane/z", "--session", "s-9", "--launched-by", "grokbot", "--title", "A lane the launcher records"], env);
		assert.equal(out.status, 0, out.stderr);
		const written = readLaneRecord(join(root, "state", "muster"), "pi-z")!;
		assert.equal(written.phase, "working");
		assert.equal(written.launchedBy, "grokbot");
		assert.equal(written.sessionId, "s-9");
		assert.equal(existsSync(join(root, "state", "muster", "lifecycle", "pi-z.json")), true);
		assert.equal(muster(["lane-record", "launch", "--lane", "pi-z"], env).status, 2, "a harness is required");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// --- helper scopes: the dev server a lane started cannot outlive the lane (2026-10-18) ---
//
// A lane's dev server runs in its own memory-capped scope (`scripts/lanes/dev-server.sh` in the BE repo) and
// registers that scope with `muster lane-pid add-scope`. Stopping a helper pid alone leaves the server tree the
// wrapper started alive (measured 2026-10-18: 5.4 GB next-server trees outlived two idle lanes), so `closeLane`
// stops the scope by its exact unit name, and the janitor sweeps the ones a lane that is not running left over.

/** The host can keep a scope only with a user systemd manager: the same test dev-server.sh makes. */
const hasUserManager = (() => {
	try {
		execFileSync("bash", ["-c", "command -v systemd-run >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

/** One scope unit name (the full name, as dev-server.sh registers it) under the same prefix it uses, unique to this run. */
function scopeUnit(label: string): string {
	return `be-dev-server-${label}-${process.pid}-${Date.now()}.scope`;
}

/**
 * Start a real transient scope with dev-server.sh's own shape (`pi-lanes.slice`, the 3G/4G cap). Its body leaves a
 * child behind and both the body and the child ignore TERM, so only the cgroup's own kill can end the scope: that
 * is what a pid-level stop of the wrapper would leave running.
 */
function startScope(unit: string, childPidFile: string): void {
	const body = `trap '' TERM; bash -c 'trap "" TERM; while :; do sleep 0.2; done' & echo $! > ${childPidFile}; wait`;
	const started = spawn("systemd-run", ["--user", "--scope", "--quiet", "--unit", unit, "-p", "MemoryHigh=3G", "-p", "MemoryMax=4G", "-p", "MemorySwapMax=0", "--slice=pi-lanes.slice", "--", "bash", "-c", body], { detached: true, stdio: "ignore" });
	started.unref();
}

const scopeIsActive = (unit: string): boolean => spawnSync("systemctl", ["--user", "is-active", "--quiet", unit], { stdio: "ignore", timeout: 15_000 }).status === 0;

/** End a scope this test started, whatever it did, so nothing is left on the machine. */
function stopScope(unit: string): void {
	spawnSync("systemctl", ["--user", "kill", "--signal=KILL", unit], { stdio: "ignore", timeout: 15_000 });
	spawnSync("systemctl", ["--user", "stop", unit], { stdio: "ignore", timeout: 15_000 });
}

async function waitForPid(file: string): Promise<number> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		try {
			const pid = Number(readFileSync(file, "utf8").trim());
			if (Number.isInteger(pid) && pid > 1) return pid;
		} catch { /* the scope has not written it yet */ }
		await new Promise<void>((done) => { setTimeout(done, 50); });
	}
	throw new Error(`no process wrote its pid to ${file}`);
}

async function pidGone(pid: number, timeoutMs = 5_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		await new Promise<void>((done) => { setTimeout(done, 50); });
	}
	return false;
}

test("closeLane stops the helper scopes a lane registered and keeps only the one that could not be stopped", async () => {
	const root = tempDir();
	try {
		const state = join(root, "state", "muster");
		mkdirSync(state, { recursive: true });
		const world: World = { pane: "absent", card: undefined, registry: "pi" };
		const { ports, calls } = fakePorts(world);
		const stubborn: CloseLanePorts = {
			...ports,
			stopHelperScope: async (unit) => {
				calls.push(`stop-helper-scope ${unit}`);
				if (unit === "be-dev-server-3-4.scope") throw new Error("still active after TERM and KILL");
				return "stopped";
			},
		};
		writeLaneRecord(state, record({ helperScopes: [{ unit: "be-dev-server-1-2.scope", addedAt: T0 }, { unit: "be-dev-server-3-4.scope", addedAt: T0 }] }));

		const closed = await closeLane(state, "pi-x", { park: false, caller: "test" }, stubborn);

		assert.equal(closed.ok, true, closed.detail);
		assert.deepEqual(calls.filter((call) => call.startsWith("stop-helper-scope")), ["stop-helper-scope be-dev-server-1-2.scope", "stop-helper-scope be-dev-server-3-4.scope"], "every registered scope is stopped once");
		assert.match(closed.detail, /stopped helper scope be-dev-server-1-2\.scope/);
		assert.match(closed.warnings.join(" "), /helper scope be-dev-server-3-4\.scope not stopped: still active after TERM and KILL/);
		assert.deepEqual(readLaneRecord(state, "pi-x")?.helperScopes?.map((scope) => scope.unit), ["be-dev-server-3-4.scope"], "only the scope that could not be stopped stays registered");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a parked lane stops its helper scopes too, so parking leaves no server running", async () => {
	const root = tempDir();
	try {
		const state = join(root, "state", "muster");
		mkdirSync(state, { recursive: true });
		const world: World = { pane: "absent", card: undefined, registry: "pi" };
		const { ports, calls } = fakePorts(world);
		writeLaneRecord(state, record({ helperScopes: [{ unit: "be-dev-server-5-6.scope", addedAt: T0 }] }));

		const parked = await closeLane(state, "pi-x", { park: true, caller: "test" }, ports);

		assert.equal(parked.ok, true, parked.detail);
		assert.deepEqual(calls.filter((call) => call.startsWith("stop-helper-scope")), ["stop-helper-scope be-dev-server-5-6.scope"]);
		assert.equal(readLaneRecord(state, "pi-x")?.phase, "parked");
		assert.equal(readLaneRecord(state, "pi-x")?.helperScopes, undefined, "the stopped scope is dropped from the record");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("`muster lane-pid add-scope` registers a scope unit, and refuses anything that is not one", () => {
	const root = tempDir();
	try {
		const state = join(root, "state", "muster");
		mkdirSync(state, { recursive: true });
		writeLaneRecord(state, record());
		const env = cliEnv(root);

		const added = muster(["lane-pid", "add-scope", "be-dev-server-11-22.scope", "--lane", "pi-x"], env);
		assert.equal(added.status, 0, added.stderr);
		assert.match(added.stdout, /will stop scope be-dev-server-11-22\.scope/);
		assert.deepEqual(readLaneRecord(state, "pi-x")?.helperScopes?.map((scope) => scope.unit), ["be-dev-server-11-22.scope"]);
		assert.equal(muster(["lane-pid", "add-scope", "be-dev-server-*", "--lane", "pi-x"], env).status, 2, "a pattern is not a unit name");
		assert.equal(muster(["lane-pid", "add-scope", "../../etc/passwd", "--lane", "pi-x"], env).status, 2, "a path is not a unit name");
		assert.equal(muster(["lane-pid", "add-scope", "--lane", "pi-x"], env).status, 2, "a unit is required");
		assert.equal(muster(["lane-pid", "add-scope", "be-dev-server-11-22.scope", "--lane", "pi-absent"], env).status, 3, "a lane with no record has nothing to register against");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a scope registered from a Claude lane's session belongs to that lane whatever CONCORD_AGENT_ID says, and closing the lane stops exactly that scope (S6)", async () => {
	const root = tempDir();
	try {
		const state = join(root, "state", "muster");
		mkdirSync(state, { recursive: true });
		// The daemon hands every `claude --bg` session its own CONCORD_AGENT_ID (`pb3fix` on 2026-10-23); the job record names the lane.
		const session = "0a1b2c3d-1111-4222-8333-444455556666";
		const claudeDir = join(root, "claude");
		mkdirSync(join(claudeDir, "jobs", session.slice(0, 8)), { recursive: true });
		writeFileSync(join(claudeDir, "jobs", session.slice(0, 8), "state.json"), JSON.stringify({ name: "cc-s6", sessionId: session, template: "bg" }));
		writeLaneRecord(state, record({ laneId: "cc-s6", harness: "claude" }));
		writeLaneRecord(state, record({ laneId: "pb3fix", harness: "claude", helperScopes: [{ unit: "be-dev-server-own-pb3fix.scope", addedAt: T0 }] }));
		const env = { ...cliEnv(root), CLAUDE_CONFIG_DIR: claudeDir, CLAUDE_CODE_SESSION_ID: session, CLAUDE_PID: String(process.pid), CONCORD_AGENT_ID: "pb3fix" };

		// No --lane: the wrapper leaves the lane to the CLI, as every other lane command does.
		const added = muster(["lane-pid", "add-scope", "be-dev-server-31-41.scope"], env);
		assert.equal(added.status, 0, added.stderr);
		assert.match(added.stdout, /^muster lane-pid: cc-s6 will stop scope be-dev-server-31-41\.scope/);
		assert.deepEqual(readLaneRecord(state, "cc-s6")?.helperScopes?.map((scope) => scope.unit), ["be-dev-server-31-41.scope"]);
		assert.deepEqual(readLaneRecord(state, "pb3fix")?.helperScopes?.map((scope) => scope.unit), ["be-dev-server-own-pb3fix.scope"], "the daemon's lane gets nothing from this session");

		const world: World = { pane: "absent", card: { harness: "claude", sessionId: session, live: true }, registry: undefined };
		const { ports, calls } = fakePorts(world);
		const closed = await closeLane(state, "cc-s6", { park: false, caller: "test" }, ports);
		assert.equal(closed.ok, true, closed.detail);
		assert.deepEqual(calls.filter((call) => call.startsWith("stop-helper-scope")), ["stop-helper-scope be-dev-server-31-41.scope"], "close stops exactly the scope this lane registered");
		assert.deepEqual(readLaneRecord(state, "pb3fix")?.helperScopes?.map((scope) => scope.unit), ["be-dev-server-own-pb3fix.scope"], "pb3fix keeps its own scope");

		// Outside any lane's session and with no CONCORD_AGENT_ID there is no lane: the command refuses (exit 2) and writes nothing.
		const { CONCORD_AGENT_ID: _drop, ...bare } = cliEnv(root);
		const none = muster(["lane-pid", "add-scope", "be-dev-server-51-61.scope"], bare);
		assert.equal(none.status, 2);
		assert.match(none.stderr, /no lane: pass --lane/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("closing a lane ends its registered scope and every process in it", { skip: hasUserManager ? false : "no systemd-run with a user manager on this host (cgroup v2)" }, async () => {
	const root = tempDir();
	const unit = scopeUnit("close");
	try {
		const state = join(root, "state", "muster");
		mkdirSync(state, { recursive: true });
		startScope(unit, join(root, "child.pid"));
		const child = await waitForPid(join(root, "child.pid"));
		assert.equal(scopeIsActive(unit), true, "the stub dev server's scope is up");
		assert.ok(listActiveScopes().includes(unit), "the sweep's listing finds it by systemd's own name");
		writeLaneRecord(state, record({ helperScopes: [{ unit, addedAt: Date.now() }] }));
		const ports: CloseLanePorts = {
			...realCloseLanePorts(state, cliEnv(root)),
			unregister: async () => ({ ok: true, detail: "the registry is not this test's subject" }),
			closeConcord: async () => ({ endpoints: 0, agent: "no-database" }),
		};

		const closed = await closeLane(state, "pi-x", { park: false, caller: "test" }, ports);

		assert.equal(closed.ok, true, closed.detail);
		assert.ok(closed.detail.includes(`stopped helper scope ${unit}`), closed.detail);
		assert.equal(scopeIsActive(unit), false, "the scope is gone");
		assert.equal(await pidGone(child), true, "no process the dev server left behind survives its lane");
		assert.equal(readLaneRecord(state, "pi-x")?.helperScopes, undefined);
	} finally {
		if (scopeIsActive(unit)) stopScope(unit);
		rmSync(root, { recursive: true, force: true });
	}
});

test("the janitor's sweep stops an idle lane's scope and leaves a running lane's scope alone", { skip: hasUserManager ? false : "no systemd-run with a user manager on this host (cgroup v2)" }, async () => {
	const root = tempDir();
	const idleUnit = scopeUnit("sweep-idle");
	const liveUnit = scopeUnit("sweep-live");
	try {
		const state = join(root, "state", "muster");
		mkdirSync(state, { recursive: true });
		startScope(idleUnit, join(root, "idle.pid"));
		startScope(liveUnit, join(root, "live.pid"));
		await waitForPid(join(root, "idle.pid"));
		await waitForPid(join(root, "live.pid"));
		writeLaneRecord(state, record({ laneId: "pi-closed", phase: "closed", helperScopes: [{ unit: idleUnit, addedAt: Date.now() }] }));
		writeLaneRecord(state, record({ laneId: "pi-working", phase: "working", helperScopes: [{ unit: liveUnit, addedAt: Date.now() }] }));

		const candidates = idleLaneHelperScopes(listLaneRecords(state));
		assert.deepEqual(candidates.map((candidate) => candidate.unit), [idleUnit], "only the lane that runs nothing is a candidate");
		const stopped = await stopIdleHelperScopes(state);

		assert.deepEqual(stopped.map((scope) => scope.unit), [idleUnit]);
		assert.equal(stopped[0]?.laneId, "pi-closed");
		assert.equal(stopped[0]?.outcome, "stopped");
		assert.equal(scopeIsActive(idleUnit), false, "the idle lane's dev server is gone");
		assert.equal(scopeIsActive(liveUnit), true, "the running lane's dev server is untouched");
	} finally {
		if (scopeIsActive(idleUnit)) stopScope(idleUnit);
		if (scopeIsActive(liveUnit)) stopScope(liveUnit);
		rmSync(root, { recursive: true, force: true });
	}
});

// --- VR21-42 S4: the launcher's own scope is emptied, and its emptiness is checked ---
//
// pi-lane-launch.sh runs the pane command inside a transient `lane-<lane>-<epoch>.scope`, so a
// process the lane left behind (an orphaned tool shell, a server that ignored its stop) holds that
// cgroup after the pane and the window are gone. Ending only the pane strands it; the close empties
// the scope by its exact unit names and checks the cgroup IS empty before it answers.

test("closeLane reports every emptied launcher scope and warns about one that did not empty", async () => {
	const dir = tempDir();
	try {
		writeLaneRecord(dir, record());
		const world: World = { pane: "absent", card: undefined, registry: "pi" };
		const { ports, calls } = fakePorts(world);
		const scopes: CloseLanePorts = {
			...ports,
			closeOwnScope: async (laneId) => {
				calls.push(`close-own-scope ${laneId}`);
				return { emptied: ["lane-pi-x-1698600123.scope"], held: ["lane-pi-x-1698600456.scope"], detail: "still holds 2 processes" };
			},
		};

		const closed = await closeLane(dir, "pi-x", { park: false, caller: "test" }, scopes);

		assert.equal(closed.ok, true, closed.detail);
		assert.deepEqual(calls.filter((call) => call.startsWith("close-own-scope")), ["close-own-scope pi-x"], "the own-scope port is asked once, by lane id");
		assert.ok(closed.steps.includes("emptied lane scope lane-pi-x-1698600123.scope (cgroup empty)"), closed.detail);
		assert.match(closed.warnings.join(" "), /lane scope lane-pi-x-1698600456\.scope still holds processes: still holds 2 processes/);
		assert.equal(readLaneRecord(dir, "pi-x")?.phase, "closed", "the close still records the lane closed after the warning");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a close with no closeOwnScope port skips the step, exactly the pre-S4 fakes (S4 is optional)", async () => {
	const dir = tempDir();
	try {
		writeLaneRecord(dir, record());
		const world: World = { pane: "absent", card: undefined, registry: "pi" };
		const { ports, calls } = fakePorts(world);
		const result = await closeLane(dir, "pi-x", { park: false, caller: "test" }, ports);
		assert.equal(result.ok, true, result.detail);
		assert.equal(calls.some((call) => call.includes("lane-pi-x-")), false, "no scope is named without the port");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("closing a lane empties its own launcher scope and checks the cgroup is empty", { skip: hasUserManager ? false : "no systemd-run with a user manager on this host (cgroup v2)" }, async () => {
	const root = tempDir();
	const unit = `lane-pi-s4lab-${Date.now()}.scope`;
	try {
		const state = join(root, "state", "muster");
		mkdirSync(state, { recursive: true });
		startScope(unit, join(root, "child.pid"));
		const child = await waitForPid(join(root, "child.pid"));
		assert.equal(scopeIsActive(unit), true, "the stub the pane left behind holds its launcher scope");
		writeLaneRecord(state, record({ laneId: "pi-s4lab" }));
		const ports: CloseLanePorts = {
			...realCloseLanePorts(state, cliEnv(root)),
			unregister: async () => ({ ok: true, detail: "the registry is not this test's subject" }),
			closeConcord: async () => ({ endpoints: 0, agent: "no-database" }),
		};

		const closed = await closeLane(state, "pi-s4lab", { park: false, caller: "test" }, ports);

		assert.equal(closed.ok, true, closed.detail);
		assert.ok(closed.steps.includes(`emptied lane scope ${unit} (cgroup empty)`), closed.detail);
		assert.equal(scopeIsActive(unit), false, "the scope is gone");
		assert.equal(await pidGone(child), true, "the process tree the pane left behind ends with its scope");
	} finally {
		if (scopeIsActive(unit)) stopScope(unit);
		rmSync(root, { recursive: true, force: true });
	}
});
