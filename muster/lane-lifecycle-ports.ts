/**
 * The live ports of the lane lifecycle (blueprint WP4): the tmux, `claude`,
 * launcher and Concord calls that `closeLane` and the parked-lane resume make.
 * `lane-lifecycle.ts` holds the decisions and the record; this file holds the
 * processes, so the Claude hook bundle that hashes `lane-lifecycle.ts` stays small.
 *
 * Every external call has a deadline and a fixed argv (no shell), and every path
 * is taken from the state dir it is given, so a test points all of it at a temp dir.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readClaudeJob, runClaudeCli, stopClaudeLane, type ClaudeCliRun } from "./lib/claude-lane-card.ts";
import { CLAUDE_LANE_NAME, enumerateLanes, findClaudeRow, laneRegistryPath, procPidAlive, procStartTime, readActiveScopeUnits, readClaudeAgentsJson, readLaneRegistryRows, readProcStat, type ClaudeLaneRow } from "./lib/lane-directory.ts";
import { isCardGone, laneCardsDir, readLaneCard, removeLaneCard, type LaneHarness } from "./lib/lane-card.ts";
import { sharedBusRoot } from "./lib/bus-root.ts";
import { enqueueLaneControl } from "./lib/lane-control.ts";
import { concordDbPath, piAgentDir } from "./binding.ts";
import { runLaunchScript } from "./gateway/launch.ts";
import { labUnitOperand } from "../core/lab-units.ts";
import { tmuxSessionForHarness, type ParkedResumeResult } from "./send.ts";
import { closeLane, idleLaneHelperScopes, listLaneRecords, readLaneRecord, HELPER_SCOPE_UNIT, type CloseLaneOptions, type CloseLanePorts, type CloseLaneResult, type IdleHelperScope, type LanePhase, type OwnScopeOutcome } from "./lane-lifecycle.ts";

const TMUX_TIMEOUT_MS = 10_000;

// ─── The rehearsal's lane scope (LC15) ───────────────────────────────────────
//
// A lab process (LC16) reads machine-wide evidence — the live lane cards, `claude
// agents`, `/proc` — so its tick or flip could act on a live lane. With
// `MUSTER_LANE_SCOPE` set, every action port of the tick acts only on a lane whose
// id starts with the scope; a refusal and an action each write one line into
// `<stateDir>/scope.log`, which the rehearsal's isolation check reads. Unset,
// nothing here changes.

/** The variable naming the rehearsal's lane scope (LC15, LC16). */
export const LANE_SCOPE_ENV = "MUSTER_LANE_SCOPE";

/** The scope the environment names, or undefined when the guard is off. */
export function laneScope(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const scope = env[LANE_SCOPE_ENV]?.trim();
	return scope === undefined || scope === "" ? undefined : scope;
}

/** Is a lane inside the scope? No scope means every lane is. */
export function laneInScope(laneId: string, scope: string | undefined): boolean {
	return scope === undefined || laneId.startsWith(scope);
}

/** One line into `<stateDir>/scope.log`; a log that cannot be written never changes a decision. */
export function scopeLog(stateDir: string, line: string): void {
	try {
		appendFileSync(join(stateDir, "scope.log"), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
	} catch {
		// The guard's decision stands without its log line.
	}
}

/**
 * The scope guard over one port set: with `MUSTER_LANE_SCOPE` set, an action on a
 * lane outside the scope is refused and logged, an action inside it is logged, and
 * a lane outside the scope is never touched. Without the scope the ports are
 * returned untouched, so production behaviour is exactly what it was.
 */
export function scopedLanePorts(stateDir: string, ports: CloseLanePorts, env: NodeJS.ProcessEnv = process.env): CloseLanePorts {
	const scope = laneScope(env);
	if (scope === undefined) return ports;
	const refusal = `outside ${LANE_SCOPE_ENV}=${scope}`;
	const allowed = (laneId: string, action: string): boolean => {
		if (laneInScope(laneId, scope)) {
			scopeLog(stateDir, `action ${action} ${laneId}`);
			return true;
		}
		scopeLog(stateDir, `refused ${action} ${laneId} (scope ${scope})`);
		return false;
	};
	/** The lane a registered helper pid belongs to: `closeLane` stops a record's own helpers. */
	const helperLane = (pid: number): string | undefined => listLaneRecords(stateDir).find((record) => (record.helperPids ?? []).some((helper) => helper.pid === pid))?.laneId;
	/** The lane a registered helper scope belongs to, by its exact unit name. */
	const helperScopeLane = (unit: string): string | undefined => listLaneRecords(stateDir).find((record) => (record.helperScopes ?? []).some((registered) => registered.unit === unit))?.laneId;
	return {
		...ports,
		stopClaude: (laneId) => (allowed(laneId, "stop") ? ports.stopClaude(laneId) : { ok: false, reason: refusal, detail: `refused by the lane scope (${refusal})` }),
		enqueueStop: (laneId, from) => {
			if (allowed(laneId, "stop-request")) ports.enqueueStop(laneId, from);
		},
		killWindow: (harness, laneId) => {
			if (allowed(laneId, "kill")) ports.killWindow(harness, laneId);
		},
		removeCard: (laneId) => {
			if (allowed(laneId, "remove-card")) ports.removeCard(laneId);
		},
		// A helper outside the scope stays registered and running: `reused` is the port's
		// "the pid was left alone", so `closeLane` keeps its entry rather than naming a stop.
		stopHelper: async (pid, startTime) => {
			const lane = helperLane(pid);
			if (lane === undefined) {
				scopeLog(stateDir, `refused stop-helper ${pid} (no lane record registers it, scope ${scope})`);
				return "reused";
			}
			return allowed(lane, `stop-helper ${pid}`) ? ports.stopHelper(pid, startTime) : "reused";
		},
		// Same rule for a helper scope: `refused` is the port's "left registered, not stopped", so an
		// action outside the scope never ends another lane's dev server.
		stopHelperScope: async (unit) => {
			const lane = helperScopeLane(unit);
			if (lane === undefined) {
				scopeLog(stateDir, `refused stop-helper-scope ${unit} (no lane record registers it, scope ${scope})`);
				return "refused";
			}
			return allowed(lane, `stop-helper-scope ${unit}`) ? ports.stopHelperScope(unit) : "refused";
		},
		// The lane's own scope is the same class of action on the lane itself (VR21-42 S4): outside
		// the rehearsal's scope it is skipped, and the close's outcome answers with no emptied units.
		closeOwnScope: async (laneId) => (allowed(laneId, "close-own-scope") ? (ports.closeOwnScope?.(laneId) ?? { emptied: [], held: [], detail: "" }) : { emptied: [], held: [], detail: "" }),
		unregister: async (harness, laneId) => (allowed(laneId, "unregister") ? ports.unregister(harness, laneId) : { ok: false, detail: `refused by the lane scope (${refusal})` }),
		closeConcord: async (repoRoot, laneId) => (allowed(laneId, "close-concord") ? ports.closeConcord(repoRoot, laneId) : { endpoints: 0, agent: "absent" }),
	};
}

/** S10: the lane launch script under the configured agent folder, read when a lane is launched. */
function launchScript(): string {
	return join(piAgentDir(), "scripts", "pi-lane-launch.sh");
}

function agentHome(env: NodeJS.ProcessEnv): string {
	return env["PI_CODING_AGENT_DIR"]?.trim() || join(env["HOME"]?.trim() || homedir(), ".pi", "agent");
}

/** The orchestration folder's briefs and messages (the gateway's `handoffsMsgsDir`). */
export function handoffsMsgsDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(agentHome(env), "plans", "orchestration-2026-10-05", "handoffs", "msgs");
}

/** The lane store the launcher writes: the owner's path unless `PI_LANES_JSON` names another. */
function lanesRegistry(stateDir: string, env: NodeJS.ProcessEnv): string {
	return env["PI_LANES_JSON"]?.trim() || laneRegistryPath(stateDir);
}

/** The tmux session a lane's window lives in: the environment wins, then the harness's own (`tmuxSessionForHarness`), else `pi`. */
function tmuxSession(harness: LaneHarness, env: NodeJS.ProcessEnv): string {
	return env["PI_LANES_TMUX_SESSION"]?.trim() || tmuxSessionForHarness(harness) || "pi";
}

function tmux(args: string[]): { status: number | null; stdout: string } {
	const result = spawnSync("tmux", args, { encoding: "utf8", timeout: TMUX_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
	return { status: result.status, stdout: result.stdout ?? "" };
}

/**
 * The status a finished or silent lane's Concord agent is set to. Concord's agent statuses are
 * active, blocked, waiting_review and done: the blueprint's `inactive` is not one of them, and a row
 * written with it makes `AgentRepository.list()` throw for every reader of the workspace (proved in
 * tests/muster-lane-lifecycle.test.ts). `closeLane` and the daily janitor both use this constant.
 */
export const CONCORD_INACTIVE_STATUS = "done";

/** The slice of Concord's repositories the cleanup uses. */
export interface ConcordCleanupRepos {
	db: { close(): void };
	agentEndpoints: {
		list(): Array<{ endpointId: string; agentId: string; status: string }>;
		disconnect(endpointId: string): unknown;
	};
	agents: {
		get(agentId: string): ({ agentId: string; firstSeen: string; lastSeen: string } & Record<string, unknown>) | undefined;
		upsert(agent: unknown): unknown;
	};
}

/** Concord's own repositories for one database file, resolved from this package's node_modules. */
export async function openConcordRepositories(file: string): Promise<ConcordCleanupRepos> {
	const require = createRequire(import.meta.url);
	const concord = (await import(pathToFileURL(require.resolve("@concord-ai/concord-mcp/dist/db/index.js")).href)) as { openRepositories(file: string): ConcordCleanupRepos };
	return concord.openRepositories(file);
}

/**
 * The one "disconnect the endpoints and set the agents inactive" step, through Concord's repositories,
 * never raw SQL. Returns the agents that were found and set to `CONCORD_INACTIVE_STATUS`.
 */
export function deactivateConcordAgents(repos: ConcordCleanupRepos, endpointIds: string[], agentIds: string[]): string[] {
	for (const endpointId of endpointIds) repos.agentEndpoints.disconnect(endpointId);
	const deactivated: string[] = [];
	for (const agentId of agentIds) {
		const agent = repos.agents.get(agentId);
		if (agent === undefined) continue;
		const { firstSeen: _firstSeen, lastSeen: _lastSeen, ...fields } = agent;
		repos.agents.upsert({ ...fields, status: CONCORD_INACTIVE_STATUS });
		deactivated.push(agentId);
	}
	return deactivated;
}

/** Closing one lane: disconnect every connected endpoint of the agent and mark it finished. */
export async function closeConcordLane(repoRoot: string, laneId: string): Promise<{ endpoints: number; agent: "done" | "absent" | "no-database" }> {
	const file = concordDbPath(repoRoot);
	if (!existsSync(file)) return { endpoints: 0, agent: "no-database" };
	const repos = await openConcordRepositories(file);
	try {
		const endpointIds = repos.agentEndpoints.list().filter((endpoint) => endpoint.agentId === laneId && endpoint.status === "connected").map((endpoint) => endpoint.endpointId);
		const deactivated = deactivateConcordAgents(repos, endpointIds, [laneId]);
		return { endpoints: endpointIds.length, agent: deactivated.length > 0 ? "done" : "absent" };
	} finally {
		repos.db.close();
	}
}

/** How long a helper process gets to leave after SIGTERM before it is killed. */
export const HELPER_TERM_WAIT_MS = 3_000;

/**
 * Stop one registered helper process by its exact pid (never by pattern). The start time recorded
 * when the lane registered it must still match: a pid that now belongs to another process is left
 * alone. SIGTERM first, then SIGKILL once the grace has passed, and only while the identity still holds.
 */
export async function stopHelperProcess(pid: number, startTime: string, waitMs: number = HELPER_TERM_WAIT_MS): Promise<"stopped" | "gone" | "reused"> {
	if (!procPidAlive(pid)) return "gone";
	if (procStartTime(pid) !== startTime) return "reused";
	process.kill(pid, "SIGTERM");
	const deadline = Date.now() + waitMs;
	while (procPidAlive(pid) && Date.now() < deadline) await new Promise<void>((done) => { setTimeout(done, 50); });
	if (procPidAlive(pid) && procStartTime(pid) === startTime) {
		process.kill(pid, "SIGKILL");
		await new Promise<void>((done) => { setTimeout(done, 100); });
	}
	return "stopped";
}

/** Timeout for one `systemctl` call: a stop that has to wait out systemd's own grace must be bounded. */
const SYSTEMCTL_TIMEOUT_MS = 15_000;
/** How often the scope stop asks whether the scope is still there. */
const SCOPE_POLL_MS = 50;

/** `systemctl --user …` with a fixed argv and a deadline. No shell. */
function systemctl(args: string[]): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", timeout: SYSTEMCTL_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Is the scope active? A unit systemd does not know reads as inactive, which is what a stop wants. */
function scopeActive(unit: string): boolean {
	return spawnSync("systemctl", ["--user", "is-active", "--quiet", unit], { stdio: "ignore", timeout: SYSTEMCTL_TIMEOUT_MS }).status === 0;
}

/** The active scope units of this user, by systemd's own listing (the one reader, `lib/lane-directory.ts`). A listing may take a pattern; a kill never does. */
export function listActiveScopes(): string[] {
	return readActiveScopeUnits().filter((name) => HELPER_SCOPE_UNIT.test(name));
}

/**
 * Stop one registered helper scope by its exact unit name (never a pattern): SIGTERM to the whole cgroup, then,
 * if anything is still there past the grace, SIGKILL, then `stop` to release the unit. `kill` comes before `stop`
 * because `stop` waits out the unit's own stop timeout (90 s by default) and a close must not block on it.
 *
 * Throws when the scope is still active afterwards, so `closeLane` keeps the registration and warns instead of
 * claiming a stop that did not happen.
 *
 * The lab unit guard (`lab-units.ts`) resolves the unit before the first spawn: in a marked lab a scope the lab
 * did not map is refused here, so a lab stop can never reach a live dev-server scope (R2).
 */
export async function stopHelperScopeProcess(unit: string, waitMs: number = HELPER_TERM_WAIT_MS, env: NodeJS.ProcessEnv = process.env): Promise<"stopped" | "gone"> {
	if (!HELPER_SCOPE_UNIT.test(unit)) throw new Error(`${JSON.stringify(unit)} is not a systemd scope unit name`);
	const target = labUnitOperand(unit, env);
	if (!scopeActive(target)) return "gone";
	systemctl(["kill", "--signal=TERM", target]);
	const deadline = Date.now() + waitMs;
	while (scopeActive(target) && Date.now() < deadline) await new Promise<void>((done) => { setTimeout(done, SCOPE_POLL_MS); });
	if (scopeActive(target)) {
		systemctl(["kill", "--signal=KILL", target]);
		await new Promise<void>((done) => { setTimeout(done, SCOPE_POLL_MS); });
	}
	systemctl(["stop", target]);
	if (scopeActive(target)) throw new Error(`helper scope ${target} is still active after TERM and KILL`);
	return "stopped";
}

/** A helper scope the sweep stopped, with the lane that had registered it. */
export interface StoppedHelperScope {
	unit: string;
	laneId: string;
	phase: LanePhase;
	outcome: "stopped" | "gone";
}

// ─── The lane's own launcher scope (VR21-42 S4) ──────────────────────────────
//
// pi-lane-launch.sh runs each lane's pane command inside a transient
// `lane-<lane>-<epoch>.scope` (`systemd-run --user --scope --slice=pi-lanes.slice`,
// `lane-adopt-cgroup.sh` copies the naming for Claude lanes), so the scope outlives a
// pane or a window whenever any process the lane left behind holds its cgroup. Ending
// only the pane can strand such a cgroup; a close empties it and checks it is empty.

/**
 * The launcher's own scope unit names for one lane id, from the active listing: the
 * units whose name is `lane-<sanitised>-<epoch>.scope` with the launch's numeric
 * epoch. The listing is a listing — every kill takes the exact names it returned,
 * never a pattern.
 */
export function laneOwnScopeUnits(laneId: string, active: readonly string[] = readActiveScopeUnits()): string[] {
	const prefix = `lane-${laneId.replace(/[^A-Za-z0-9._-]/g, "_")}-`;
	return active.filter((unit) => unit.startsWith(prefix) && /^\d+\.scope$/.test(unit.slice(prefix.length))).sort();
}

/** How many processes still hold the scope's cgroup, or undefined when the path cannot be read. */
function scopeCgroupPids(unit: string): number[] | undefined {
	const shown = systemctl(["show", "--property=ControlGroup", "--value", unit]);
	const group = shown.stdout.trim().split("\n")[0] ?? "";
	if (shown.status !== 0 || group === "") return undefined;
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (uid === undefined) return undefined;
	// A user manager delegates a subtree, and the property answers where INSIDE it the cgroup
	// sits with its whole path (`/user.slice/user-<uid>.slice/user@<uid>.service/pi.slice/
	// pi-lanes.slice/<unit>`, measured on this host 2026-10-21); the file root is the user
	// manager's mount, so the two join directly — never reconstructed from prefixes.
	try {
		return readFileSync(join("/sys/fs/cgroup/user.slice", `user-${uid}.slice`, `user@${uid}.service`, group.replace(/^\//, ""), "cgroup.procs"), "utf8")
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map(Number)
			.filter((pid) => Number.isInteger(pid) && pid > 0);
	} catch {
		return undefined;
	}
}

/**
 * Empty one lane's own launcher scopes: the cgroup's processes take TERM, then KILL
 * (the same order a helper scope takes), and the close's emptiness check reads the
 * cgroup itself — a unit that still holds pids, or a stop systemd never finished, is
 * reported back to the caller, never claimed as empty. Unmapped units in a marked lab
 * (LC16) are refused before any spawn, as every scope stop is.
 */
export async function stopLaneOwnScope(laneId: string, waitMs: number = HELPER_TERM_WAIT_MS, env: NodeJS.ProcessEnv = process.env): Promise<OwnScopeOutcome> {
	const emptied: string[] = [];
	const held: string[] = [];
	for (const unit of laneOwnScopeUnits(laneId)) {
		const target = labUnitOperand(unit, env);
		if (!scopeActive(target)) {
			emptied.push(unit);
			continue;
		}
		systemctl(["kill", "--signal=TERM", target]);
		const deadline = Date.now() + waitMs;
		while (scopeActive(target) && Date.now() < deadline) await new Promise<void>((done) => { setTimeout(done, SCOPE_POLL_MS); });
		if (scopeActive(target)) systemctl(["kill", "--signal=KILL", target]);
		systemctl(["stop", target]);
		let alive = scopeActive(target);
		let pids = scopeCgroupPids(target);
		const deadlineEmpty = Date.now() + waitMs;
		while ((alive || (pids !== undefined && pids.length > 0)) && Date.now() < deadlineEmpty) {
			await new Promise<void>((done) => { setTimeout(done, SCOPE_POLL_MS); });
			alive = scopeActive(target);
			pids = scopeCgroupPids(target);
		}
		if (!alive && (pids === undefined || pids.length === 0)) emptied.push(unit);
		else held.push(unit);
	}
	return {
		emptied,
		held,
		detail: held.length > 0 ? "the scope's cgroup was not empty after TERM, KILL and stop" : "",
	};
}

/**
 * The janitor's net under `closeLane` (2026-10-18): stop every active scope a lane registered whose record says
 * the lane runs nothing (`idleLaneHelperScopes`). A scope no lane record registers is left alone — a server
 * started outside a lane is not the janitor's to stop — and every unit is stopped by its exact name.
 */
export async function stopIdleHelperScopes(
	stateDir: string,
	candidates: readonly IdleHelperScope[] | undefined = undefined,
	active: readonly string[] | undefined = undefined,
	env: NodeJS.ProcessEnv = process.env,
): Promise<StoppedHelperScope[]> {
	const wanted = candidates ?? idleLaneHelperScopes(listLaneRecords(stateDir));
	const activeNames = new Set(active ?? listActiveScopes());
	const stopped: StoppedHelperScope[] = [];
	for (const candidate of wanted) {
		if (!activeNames.has(candidate.unit)) continue;
		stopped.push({ unit: candidate.unit, laneId: candidate.laneId, phase: candidate.phase, outcome: await stopHelperScopeProcess(candidate.unit, HELPER_TERM_WAIT_MS, env) });
	}
	return stopped;
}

// ─── Orphaned Claude Code shells (2026-10-18) ────────────────────────────────
//
// Six `/bin/bash -c source …/.claude/shell-snapshots/… eval 'while pgrep -f …'` shells were still alive five hours
// after their sessions ended (measured 2026-10-18 19:05): the loop's own `pgrep -f` pattern matched the shell that
// ran it, so the loop never ended. `closeLane` cannot see such a shell — a tool call left it behind, it is not a
// registered helper — so the janitor sweeps it: a finished job's parentless shell, older than an hour, is stopped
// by its exact pid. Only a lane's or the orchestrator's own finished session qualifies (Henry 2026-10-18 19:05):
// the operator's own session runs no background job, and Hermes is not Claude Code, so neither carries the two markers
// this reads, a `CLAUDE_JOB_DIR` and a snapshot shell.

/** The snapshot a Claude Code shell sources; a shell that runs one is what this judges (`~/.claude/shell-snapshots/…`). */
const CLAUDE_SHELL_SNAPSHOT = /\.claude\/shell-snapshots\/snapshot-bash-[A-Za-z0-9_.-]+\.sh/;
/** A shell younger than this is left alone: a session that has just started is not an orphan. */
export const ORPHAN_SHELL_MIN_AGE_MS = 60 * 60 * 1000;
/**
 * The job states that mean the background session has ended: `done` (the turn finished and the record
 * carries its result), `stopped` (the session was stopped) and `failed` (it ended in failure).
 * `running`, `working` and `blocked` are a session that is still there — a blocked one waits on an
 * answer — and a state this set does not name is not evidence that the job finished, so the sweep
 * leaves its shells alone exactly as it does for a record that cannot be read.
 */
const FINISHED_CLAUDE_JOB_STATES = new Set(["done", "stopped", "failed"]);

/** Does this job state mean the background session has ended? A missing or unnamed state says no. */
export function isFinishedClaudeJobState(state: string | undefined): boolean {
	return state !== undefined && FINISHED_CLAUDE_JOB_STATES.has(state.trim().toLowerCase());
}
/**
 * Linux `USER_HZ`: `/proc/<pid>/stat` counts a start time in these ticks. `cli/ledger.ts` keeps the same constant
 * for its process rows, and it cannot be imported here because that module imports this one.
 */
const CLOCK_TICKS_PER_SECOND = 100;

/** One `/bin/bash -c` snapshot shell whose Claude job has finished and whose parent is gone. */
export interface OrphanClaudeShell {
	pid: number;
	/** The `/proc/<pid>/stat` start time: the identity the stop re-checks before it signals. */
	startTime: string;
	/** The job directory the shell carries (`CLAUDE_JOB_DIR`). */
	jobDir: string;
	/** The job id the report names: the job directory's own name. */
	jobId: string;
	/** How old the shell is, in ms. */
	ageMs: number;
}

/** What the sweep reads from the machine; a test replaces it, so no fixture reads the real `/proc`. */
export interface OrphanShellReaders {
	/** Every pid on the machine. */
	pids(): number[];
	/** One process's parent and start time (`lib/lane-directory.ts` owns the `/proc/<pid>/stat` read). */
	stat(pid: number): { ppid: number; startTime: string | undefined } | undefined;
	/** One process's argv, or undefined when it cannot be read. */
	argv(pid: number): string[] | undefined;
	/** One process's environment, or undefined when it cannot be read (another user's, or one that is gone). */
	environ(pid: number): Record<string, string> | undefined;
	/** Epoch ms the machine booted, or undefined when it cannot be read. */
	bootMs(): number | undefined;
	now(): number;
}

/** `/proc` and the clock: the sweep's real readers. */
export const realOrphanShellReaders: OrphanShellReaders = {
	pids() {
		try {
			return readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map(Number);
		} catch {
			return [];
		}
	},
	stat(pid) {
		const stat = readProcStat(pid);
		return stat === undefined ? undefined : { ppid: stat.ppid, startTime: stat.startTime };
	},
	argv(pid) {
		try {
			return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter((arg) => arg !== "");
		} catch {
			return undefined;
		}
	},
	environ(pid) {
		try {
			const env: Record<string, string> = {};
			for (const entry of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
				const equals = entry.indexOf("=");
				if (equals > 0) env[entry.slice(0, equals)] = entry.slice(equals + 1);
			}
			return env;
		} catch {
			return undefined;
		}
	},
	bootMs() {
		try {
			const [uptime] = readFileSync("/proc/uptime", "utf8").trim().split(" ");
			const seconds = Number(uptime);
			return Number.isFinite(seconds) ? Date.now() - seconds * 1000 : undefined;
		} catch {
			return undefined;
		}
	},
	now: () => Date.now(),
};

/**
 * One pid as the sweep sees it: the shell when it is an orphan this pass may stop, else undefined. Every test is a
 * refusal: a shell that is not a Claude Code snapshot shell, is not parentless, is younger than the threshold,
 * carries no readable environment, is not a finished job, or belongs to the operator's own session or a Hermes lane is
 * left alone.
 */
function orphanShellAt(pid: number, context: { readers: OrphanShellReaders; stateDir: string; now: number; bootMs: number | undefined; minAgeMs: number }): OrphanClaudeShell | undefined {
	const { readers, now, bootMs, minAgeMs } = context;
	const stat = readers.stat(pid);
	if (stat === undefined || stat.ppid !== 1 || stat.startTime === undefined) return undefined;
	const argv = readers.argv(pid);
	if (argv === undefined || argv[0] !== "/bin/bash" || argv[1] !== "-c" || !CLAUDE_SHELL_SNAPSHOT.test(argv[2] ?? "")) return undefined;
	const env = readers.environ(pid);
	if (env === undefined) return undefined;
	const jobDir = env["CLAUDE_JOB_DIR"]?.trim();
	const sessionId = env["CLAUDE_CODE_SESSION_ID"]?.trim();
	if (jobDir === undefined || jobDir === "" || sessionId === undefined || sessionId === "") return undefined;
	const ticks = Number(stat.startTime);
	if (bootMs === undefined || !Number.isFinite(ticks)) return undefined;
	const ageMs = now - (bootMs + (ticks * 1000) / CLOCK_TICKS_PER_SECOND);
	if (!(ageMs >= minAgeMs)) return undefined;
	// The job record, when there is one, must name a lane the janitor may act on, and must say the job stopped.
	const job = readClaudeJob(sessionId, { jobsDir: dirname(jobDir) });
	if (job !== undefined) {
		if (job.name.startsWith("operator:") || !CLAUDE_LANE_NAME.test(job.name) || readLaneRecord(context.stateDir, job.name)?.harness === "hermes") return undefined;
		// A session that has not ended is still running its shells for a reason (2026-10-18: a `done` job
		// left a `while pgrep -f …` shell behind and the sweep walked past it).
		if (!isFinishedClaudeJobState(job.state)) return undefined;
	} else if (existsSync(jobDir)) {
		// A record that is there but unreadable is not evidence that the job finished.
		return undefined;
	}
	return { pid, startTime: stat.startTime, jobDir, jobId: basename(jobDir), ageMs };
}

/**
 * The orphaned Claude Code shells of this machine, oldest first: the janitor's candidate list. A read over the
 * readers, so a dry run lists exactly what a pass would stop, and nothing is signalled here.
 */
export function findOrphanClaudeShells(stateDir: string, readers: OrphanShellReaders = realOrphanShellReaders, minAgeMs: number = ORPHAN_SHELL_MIN_AGE_MS): OrphanClaudeShell[] {
	const now = readers.now();
	const bootMs = readers.bootMs();
	if (bootMs === undefined) return [];
	const shells: OrphanClaudeShell[] = [];
	for (const pid of readers.pids()) {
		const shell = orphanShellAt(pid, { readers, stateDir, now, bootMs, minAgeMs });
		if (shell !== undefined) shells.push(shell);
	}
	return shells.sort((left, right) => right.ageMs - left.ageMs);
}

/** One orphaned shell the sweep stopped, with the job it belonged to. */
export interface StoppedOrphanShell {
	pid: number;
	jobId: string;
	ageMs: number;
	outcome: "stopped" | "gone" | "reused";
}

/**
 * Stop the orphaned shells by their exact pids, through the one exact-pid stop (`stopHelperProcess`: SIGTERM, the
 * grace, then SIGKILL, and only while the start time still matches the process). Never a pattern — the call that
 * leaves these shells behind is a `pgrep -f` matching itself, and a pattern here would repeat its bug.
 */
export async function stopOrphanClaudeShells(shells: readonly OrphanClaudeShell[]): Promise<StoppedOrphanShell[]> {
	const stopped: StoppedOrphanShell[] = [];
	for (const shell of shells) stopped.push({ pid: shell.pid, jobId: shell.jobId, ageMs: shell.ageMs, outcome: await stopHelperProcess(shell.pid, shell.startTime) });
	return stopped;
}

// ─── The Claude registry, read for a stop (LC16 F10) ─────────────────────────

/** `claude agents --json` as a close sees it: the rows, or why the table could not be read. */
export type ClaudeTable = { ok: true; rows: ClaudeLaneRow[] } | { ok: false; reason: string };

/** A close may wait for the table: it is not a hook, and an unread table must not read as "no session". */
const CLAUDE_TABLE_TIMEOUT_MS = 20_000;

function runClaudeTable(): { status: number | null; stdout: string; stderr: string } {
	return runClaudeCli(["agents", "--json"], { timeoutMs: CLAUDE_TABLE_TIMEOUT_MS });
}

/**
 * The harness's own registry for a stop. `readClaudeAgentsJson` answers an empty list for a missing
 * `claude`, a timeout or bad output, which the directory can live with and a close cannot: the
 * rehearsal's close read a table it could not get as "no live session", removed the card and left
 * the session running. Here an unreadable table is its own answer.
 */
export function readClaudeTableStrict(run: () => { status: number | null; stdout: string; stderr: string } = runClaudeTable): ClaudeTable {
	const result = run();
	if (result.status !== 0) {
		const said = result.stderr.trim();
		return { ok: false, reason: `\`claude agents --json\` could not be read (${said === "" ? `exit ${result.status === null ? "with no status" : String(result.status)}` : said})` };
	}
	try {
		const parsed: unknown = JSON.parse(result.stdout);
		if (Array.isArray(parsed)) return { ok: true, rows: parsed as ClaudeLaneRow[] };
	} catch {
		// Falls through to the same refusal as a list that is not one.
	}
	return { ok: false, reason: "`claude agents --json` could not be read (its output is not a list)" };
}

export interface ClaudeStopOutcome {
	ok: boolean;
	handle?: string;
	/** True only when the registry was read and held no session for the lane: the one case a card may go without a stop. */
	absent?: boolean;
	reason?: string;
	detail: string;
}

/**
 * Stop one Claude lane through the registry, whatever the session's state (an idle one keeps its row
 * and its short id). Nothing is removed unless `claude stop` confirmed, or the registry was read and
 * the lane is not in it; every other outcome leaves the card, so `muster control <lane> stop` still has it.
 */
export function stopClaudeChecked(
	stateDir: string,
	laneId: string,
	readTable: () => ClaudeTable = readClaudeTableStrict,
	options: { runCli?: ClaudeCliRun } = {},
): ClaudeStopOutcome {
	const table = readTable();
	if (!table.ok) return { ok: false, reason: table.reason, detail: `claude stop ${laneId}: refused` };
	const listed = findClaudeRow(table.rows, laneId, readLaneCard(stateDir, laneId)?.sessionId) !== undefined;
	const stopped = stopClaudeLane(stateDir, laneId, { readRows: () => table.rows, ...(options.runCli !== undefined ? { runCli: options.runCli } : {}) });
	return {
		ok: stopped.ok,
		...(stopped.handle !== undefined ? { handle: stopped.handle } : {}),
		...(!stopped.ok && !listed ? { absent: true } : {}),
		...(stopped.reason !== undefined ? { reason: stopped.reason } : {}),
		detail: stopped.detail,
	};
}

/** The real ports for one Muster state dir, under the rehearsal's scope guard (LC15). */
export function realCloseLanePorts(stateDir: string, env: NodeJS.ProcessEnv = process.env): CloseLanePorts {
	return scopedLanePorts(stateDir, rawCloseLanePorts(stateDir, env), env);
}

/** The live ports, unscoped. `realCloseLanePorts` is the one every caller uses. */
function rawCloseLanePorts(stateDir: string, env: NodeJS.ProcessEnv = process.env): CloseLanePorts {
	return {
		now: () => Date.now(),
		sleep: (ms) => new Promise<void>((done) => { setTimeout(done, ms); }),
		card: (laneId) => {
			const card = readLaneCard(stateDir, laneId);
			return card === undefined ? undefined : { harness: card.harness, ...(card.sessionId !== undefined ? { sessionId: card.sessionId } : {}), live: card.state !== "gone" && !isCardGone(card.updatedAt, Date.now()) };
		},
		registryHarness: (laneId) => {
			const row = readLaneRegistryRows(lanesRegistry(stateDir, env), stateDir).get(laneId);
			if (row === undefined) return undefined;
			// A row written before 2026-10-08 is a bare session id and reads as a Pi lane.
			return row.harness === "pi" || row.harness === "opencode" || row.harness === "claude" ? row.harness : "pi";
		},
		sessionRows: (laneId) => {
			const home = env["HOME"];
			const registryRow = enumerateLanes({
				...(home !== undefined ? { home } : {}),
				laneCardsDir: laneCardsDir(stateDir),
				laneRegistryPath: lanesRegistry(stateDir, env),
				includeUnregisteredSessions: true,
			}).find((card) => card.laneId === laneId);
			const agentsRow = findClaudeRow(readClaudeAgentsJson(home !== undefined ? { home } : {}), laneId, readLaneCard(stateDir, laneId)?.sessionId);
			return { ...(registryRow !== undefined ? { registryRow } : {}), ...(agentsRow !== undefined ? { agentsRow } : {}) };
		},
		stopClaude: (laneId) => stopClaudeChecked(stateDir, laneId),
		enqueueStop: (laneId, from) => { enqueueLaneControl(stateDir, { laneId, operation: "stop", from }); },
		paneState: (harness, laneId) => {
			const listed = tmux(["list-panes", "-t", `=${tmuxSession(harness, env)}:=${laneId}`, "-F", "#{pane_dead}"]);
			if (listed.status !== 0) return "absent";
			return listed.stdout.split("\n").some((line) => line.trim() === "0") ? "alive" : "dead";
		},
		killWindow: (harness, laneId) => { tmux(["kill-window", "-t", `=${tmuxSession(harness, env)}:=${laneId}`]); },
		removeCard: (laneId) => { removeLaneCard(stateDir, laneId); },
		stopHelper: (pid, startTime) => stopHelperProcess(pid, startTime),
		stopHelperScope: (unit) => stopHelperScopeProcess(unit, HELPER_TERM_WAIT_MS, env),
		closeOwnScope: (laneId) => stopLaneOwnScope(laneId, HELPER_TERM_WAIT_MS, env),
		unregister: (harness, laneId) =>
			runLaunchScript(launchScript(), ["--lane", laneId, "--unregister"], { ...env, PI_LANES_JSON: lanesRegistry(stateDir, env), PI_LANES_TMUX_SESSION: tmuxSession(harness, env) }),
		closeConcord: (repoRoot, laneId) => closeConcordLane(repoRoot ?? sharedBusRoot(env), laneId),
	};
}

/** `closeLane` with the live ports: what the CLI, the gateway and the tick call. */
export function closeLaneLive(stateDir: string, laneId: string, options: CloseLaneOptions, env: NodeJS.ProcessEnv = process.env): Promise<CloseLaneResult> {
	return closeLane(stateDir, laneId, options, realCloseLanePorts(stateDir, env));
}

export interface ParkedResumeDeps {
	env?: NodeJS.ProcessEnv;
	/** Where the resume brief is written; default the orchestration folder's `msgs`. */
	msgsDir?: string;
	now?: () => Date;
	/** The launcher; default runs `scripts/pi-lane-launch.sh`. */
	launch?: (args: string[], env: NodeJS.ProcessEnv) => Promise<{ ok: boolean; detail: string }>;
}

function stamp(date: Date): string {
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`;
}

/**
 * What `muster send` (and `lane_send`) hand the delivery owner as `resumeParked`: a
 * message to a parked lane writes the text to
 * `<msgs>/<lane>-resume-<yyyymmdd-hhmm>.md` and relaunches the lane. A Pi or OpenCode
 * lane comes back through the launcher with that brief (it resumes the registered
 * session and sends the brief into it). A parked Claude lane is never resumed by a
 * message (LD16): it answers `inbox-only`, writes no brief, and the inbox carries the
 * text. A lane whose record is not `parked` answers `not-parked`, and the normal path
 * carries the message.
 */
export function parkedLaneResume(stateDir: string, from: string, deps: ParkedResumeDeps = {}): (request: { laneId: string; text: string }) => Promise<ParkedResumeResult> {
	const env = deps.env ?? process.env;
	const scope = laneScope(env);
	return async (request) => {
		// The message that relaunches a lane is an action on that lane (LC15): outside the
		// rehearsal's scope it is refused, and the inbox carries the text as for any lane
		// that cannot be resumed.
		if (scope !== undefined && !laneInScope(request.laneId, scope)) {
			scopeLog(stateDir, `refused resume ${request.laneId} (scope ${scope})`);
			return { state: "failed", reason: `refused by the lane scope (outside ${LANE_SCOPE_ENV}=${scope})` };
		}
		if (scope !== undefined) scopeLog(stateDir, `action resume ${request.laneId}`);
		const record = readLaneRecord(stateDir, request.laneId);
		if (record === undefined || record.phase !== "parked") return { state: "not-parked" };
		const laneId = request.laneId;
		const text = request.text;
		if (record.harness === "unknown") return { state: "failed", reason: `the parked record of ${laneId} names no harness` };
		// A Claude session is never resumed by a message (LD16): no brief, no resume, the inbox carries it.
		if (record.harness === "claude") return { state: "inbox-only", why: "its process was stopped on purpose" };
		const now = deps.now?.() ?? new Date();
		const dir = deps.msgsDir ?? handoffsMsgsDir(env);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		let brief = join(dir, `${laneId}-resume-${stamp(now)}.md`);
		for (let n = 2; existsSync(brief); n += 1) brief = join(dir, `${laneId}-resume-${stamp(now)}-${n}.md`);
		writeFileSync(brief, [`# Resume ${laneId} (${now.toISOString()})`, "", `From: ${from}`, "", "You were parked after your last report. Continue with the message below, then file a new `muster report`.", "", text, ""].join("\n"), { mode: 0o600, flag: "wx" });
		if (record.cwd === null) return { state: "failed", reason: `the parked record of ${laneId} holds no cwd to relaunch in (brief kept at ${brief})` };
		const args = ["--lane", laneId, "--harness", record.harness, "--cwd", record.cwd, "--brief", brief, "--resume-brief", "--no-attach", "--launched-by", from, ...(record.repoRoot !== undefined ? ["--repo-root", record.repoRoot] : [])];
		const launchEnv = { ...env, PI_LANES_JSON: lanesRegistry(stateDir, env) };
		const launched = await (deps.launch ?? ((argv, e) => runLaunchScript(launchScript(), argv, e)))(args, launchEnv);
		return launched.ok ? { state: "resumed", detail: launched.detail, brief } : { state: "failed", reason: `${launched.detail} (brief kept at ${brief})` };
	};
}
