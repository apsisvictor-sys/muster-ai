/**
 * `muster ledger status|preflight|flip|abort|rollback|backup` — LC15 of
 * `plans/muster-autonomy/durable-ledger-cutover-plan-2026-10-16.md`.
 *
 * One tool, six verbs, one switch file:
 *
 * - `status` reads the backend, the daemon, the spool, the backups and the lanes.
 * - `preflight` refuses the flip while any of the plan's six conditions holds.
 * - `flip` freezes the stores, tars them, imports them (LC14), writes `backend.json`
 *   as `ledger` with the cursor and replays the spool (LC2).
 * - `abort` returns a frozen install to the backend it came from.
 * - `rollback` exports the ledger back to files (LC14) and returns the switch to files.
 * - `backup` writes one consistent copy of the ledger with SQLite `VACUUM INTO` and
 *   keeps the newest seven (LC-D9).
 *
 * Every step is idempotent by flip id, so a flip killed at any step (inside the
 * import included) can be rerun or aborted. This tool is the only writer of
 * `backend.json`, by temporary name, fsync and rename (`ledger/backend.ts` owns the
 * file's shape and reads it on every owner call).
 *
 * Running `flip`, `abort` or `rollback` against the live state is the cutover (CV3)
 * and needs the architect's word; building and testing it does not. The tests run on
 * temp state dirs only.
 */

import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";

import { laneCardsDir, isCardGone, type LaneCard } from "../lib/lane-card.ts";
import { enumerateLanes, isBusLane, laneRegistryPath, readProcStat } from "../lib/lane-directory.ts";
import { musterLeasesDir, piAgentDir } from "../binding.ts";
import { replaySpool } from "../ledger/boundary.ts";
import { backendPath, backendState, type BackendState } from "../ledger/backend.ts";
import { MusterdUnreachable } from "../ledger/client.ts";
import { requestSync } from "../ledger/client-sync.ts";
import { crashKill } from "../ledger/runtime.ts";
import { readSpool } from "../ledger/spool.ts";
import { LANE_CARD_STORE, ownerLedgerSocket } from "../ledger/stores.ts";
import { readSupervisorHeartbeatState, supervisorLeasePath } from "../recovery.ts";
import { SEND_LOG_FILE } from "../send.ts";
import { harnessRoot } from "../../core/harness-paths.ts";
import { labSystemctlOperand } from "../../core/lab-units.ts";
import { seatHeldBy } from "../seats.ts";
import { LANE_SCOPE_ENV, laneInScope, laneScope, scopeLog } from "../lane-lifecycle-ports.ts";
import { importLedger, flipRecordPath, planImport } from "../bin/muster-ledger-import.mts";
import { exportLedger } from "../bin/muster-ledger-export.mts";
import { parseFlags, type CliCommand, type CliContext } from "./types.ts";
import { lanesStateDir } from "./lanes.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

/** The plan's minimum daemon uptime before a flip (preflight 1). */
export const MIN_DAEMON_UPTIME_MS = 10 * 60_000;
/** The plan's margin before a scheduled tick or janitor run (preflight 6). */
export const TIMER_MARGIN_MS = 10 * 60_000;
/** The tick timer the flip stops and starts, and the two timers preflight 6 reads. */
export const TICK_TIMER = "muster-tick.timer";
export const JANITOR_TIMER = "muster-janitor.timer";
/** The two services whose running now is what preflight 6 waits for (LD46). */
export const TICK_SERVICE = "muster-tick.service";
export const JANITOR_SERVICE = "muster-janitor.service";
/** LC-D9: how many backups the daily job keeps. */
export const BACKUP_KEEP = 7;
/** The committed rehearsal records the preflight reads under the checkout (LC14). */
const LEDGER_FLIP_DIR = join("plans", "muster-autonomy", "ledger-flip");
/**
 * The stores the flip moves into the ledger, relative to the Muster state dir: the
 * LC14 import's sources. `send-log.jsonl` is `SEND_LOG_FILE`'s name in that dir.
 */
const MOVED_STORES = ["lanes", "lifecycle", "inbox", "read", "control", "seats", "asks", "programmes", "goals", "research-desk", "waiters", SEND_LOG_FILE] as const;
/** The two stores that sit beside the state dir (LC0-R5 lists them as moved, not staying files). */
const SIBLING_STORES = ["pi-lanes.json", "orchestrator-events.log"] as const;
/** Linux `USER_HZ`: the clock ticks `/proc/<pid>/stat` counts (field 22). */
const CLOCK_TICKS_PER_SECOND = 100;
/** The flip's crash points, armed by `MUSTER_LEDGER_TEST=1` + `MUSTER_LEDGER_CRASH_AT` (LC15 test 2). */
export const FLIP_CRASH_POINTS = {
	afterFreeze: "flip-after-step-1",
	afterTar: "flip-after-step-2",
	afterImport: "flip-after-step-3",
	afterSwitch: "flip-after-step-4",
	afterSpool: "flip-after-step-5",
} as const;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ─── The tool's ports ────────────────────────────────────────────────────────

/** One process as `/proc` shows it, with the start time resolved to epoch ms when it can be. */
export type ProcRow = { pid: number; ppid: number; comm: string; args: string[]; startMs: number | undefined };

/**
 * Everything the verbs read and do. Every field is injectable so the tests drive a
 * temp state dir with fakes and no live process, git, systemd or lane.
 */
export type LedgerTool = {
	stateDir: string;
	ledgerDir: string;
	socketPath: string;
	repoRoot: string;
	env: NodeJS.ProcessEnv;
	now(): number;
	out(line: string): void;
	err(line: string): void;
	/** `git -C <repoRoot> <args>`. */
	git(args: string[]): { status: number | null; stdout: string };
	/**
	 * `git -C <codeRoot> <args>`: the checkout the Muster code stands in, which is where a
	 * landing commit lives (`core/harness-paths.ts:harnessRoot`). Never `repoRoot`: that is the
	 * workspace this CLI was asked to coordinate, and a Muster commit need not be in it (the
	 * 2026-10-29 release refused a valid release for exactly that).
	 */
	gitInCode(args: string[]): { status: number | null; stdout: string };
	/** `systemctl --user <args>`. */
	systemctl(args: string[]): { status: number | null; stdout: string };
	/** Is this lease file's `flock` held? (`flock -n <path> true`, the lock's own heldness probe.) */
	leaseHeld(path: string): boolean;
	/** The directory the identity leases live in (`binding.ts:musterLeasesDir`), injectable for a temp install. */
	leasesDir: string;
	processes(): ProcRow[];
	/** One process's environment, for the lane it was launched as. */
	processEnv(pid: number): Record<string, string>;
	lanes(): LaneCard[];
	spoolCount(): number;
};

export interface LedgerToolOptions {
	stateDir: string;
	repoRoot: string;
	env: NodeJS.ProcessEnv;
	out(line: string): void;
	err(line: string): void;
}

/**
 * The ledger directory rule `ledger/open.ts:ledgerDir` owns, read here the way
 * `ledger/stores.ts` reads the socket rule: a CLI diagnostic must not load Durable Pi.
 */
export function ledgerDirFor(stateDir: string, env: NodeJS.ProcessEnv): string {
	const override = env["MUSTER_LEDGER_DIR"]?.trim();
	return override !== undefined && override !== "" ? override : stateDir;
}

/** Epoch ms the machine booted, as `/proc/uptime` counts it; undefined when it cannot be read. */
function bootTimeMs(now: number): number | undefined {
	try {
		const [uptime] = readFileSync("/proc/uptime", "utf8").trim().split(" ");
		const seconds = Number(uptime);
		return Number.isFinite(seconds) ? now - seconds * 1000 : undefined;
	} catch {
		return undefined;
	}
}

function scanProcs(now: number): ProcRow[] {
	const rows: ProcRow[] = [];
	const boot = bootTimeMs(now);
	let names: string[] = [];
	try {
		names = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
	} catch {
		return rows;
	}
	for (const name of names) {
		const pid = Number(name);
		const stat = readProcStat(pid);
		if (stat === undefined) continue;
		let args: string[] = [];
		try {
			args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter((arg) => arg !== "");
		} catch {
			// A kernel thread has no cmdline; comm still answers.
		}
		const ticks = stat.startTime === undefined ? undefined : Number(stat.startTime);
		const startMs = boot === undefined || ticks === undefined || !Number.isFinite(ticks) ? undefined : boot + (ticks * 1000) / CLOCK_TICKS_PER_SECOND;
		rows.push({ pid, ppid: stat.ppid, comm: stat.comm, args, startMs });
	}
	return rows;
}

function processEnvOf(pid: number): Record<string, string> {
	const env: Record<string, string> = {};
	try {
		for (const entry of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
			const equals = entry.indexOf("=");
			if (equals > 0) env[entry.slice(0, equals)] = entry.slice(equals + 1);
		}
	} catch {
		// A process that is gone, or another user's: no environment, no lane.
	}
	return env;
}

/** The ledger tool over a real install: `/proc`, git, systemd, flock and the lane directory. */
export function realLedgerTool(options: LedgerToolOptions): LedgerTool {
	const { stateDir, env } = options;
	const envWithState = { ...env, PI_MUSTER_STATE_DIR: stateDir };
	// The tree this file stands in: the muster clone, or a release worktree of it. A landing
	// commit is a Muster commit, so this is the checkout that can answer for it.
	const codeRoot = harnessRoot(import.meta.url);
	return {
		stateDir,
		ledgerDir: ledgerDirFor(stateDir, env),
		socketPath: ownerLedgerSocket(stateDir),
		repoRoot: options.repoRoot,
		env,
		now: () => Date.now(),
		out: options.out,
		err: options.err,
		git: (args) => {
			const result = spawnSync("git", ["-C", options.repoRoot, ...args], { encoding: "utf8", timeout: 30_000 });
			return { status: result.status, stdout: result.stdout ?? "" };
		},
		gitInCode: (args) => {
			const result = spawnSync("git", ["-C", codeRoot, ...args], { encoding: "utf8", timeout: 30_000 });
			return { status: result.status, stdout: result.stdout ?? "" };
		},
		systemctl: (args) => {
			// The lab unit guard (lab-units.ts): in a marked lab the operand must be
			// one the lab mapped, and an unmapped live unit refuses before any real
			// systemctl is spawned (LC16c run 2, 2026-10-18 22:23). Without the
			// marker the argv is untouched — the live install behaves as before.
			const operand = labSystemctlOperand(args[1], env);
			const guarded = [args[0], operand, ...args.slice(2)];
			const result = spawnSync("systemctl", ["--user", ...guarded], { encoding: "utf8", timeout: 30_000 });
			return { status: result.status, stdout: result.stdout ?? "" };
		},
		leaseHeld: (path) => spawnSync("flock", ["-n", path, "true"], { stdio: "ignore" }).status !== 0,
		leasesDir: musterLeasesDir(),
		processes: () => scanProcs(Date.now()),
		processEnv: processEnvOf,
		lanes: () =>
			enumerateLanes({
				laneCardsDir: laneCardsDir(stateDir),
				laneRegistryPath: laneRegistryPath(stateDir),
				includeUnregisteredSessions: false,
				...(env["HOME"] !== undefined ? { home: env["HOME"] } : {}),
			}),
		spoolCount: () => readSpool(stateDir).length,
	};
}

// ─── The switch file ─────────────────────────────────────────────────────────

/**
 * Write `backend.json`: a temporary file in the same directory, `fsync`, rename. The
 * flip tool is the only writer (LC15), so the writer lives here and `ledger/backend.ts`
 * keeps the shape.
 */
export function writeBackendSwitch(stateDir: string, state: BackendState): void {
	const file = backendPath(stateDir);
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const temporary = `${file}.tmp`;
	const fd = openSync(temporary, "w", 0o600);
	try {
		writeSync(fd, JSON.stringify(state));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, file);
}

function writeJsonAtomic(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.tmp`;
	const fd = openSync(temporary, "w", 0o600);
	try {
		writeSync(fd, JSON.stringify(value));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, file);
}

// ─── systemd ─────────────────────────────────────────────────────────────────

function stopTickTimer(tool: LedgerTool): void {
	const result = tool.systemctl(["stop", TICK_TIMER]);
	tool.out(`systemctl --user stop ${TICK_TIMER}: ${result.status === 0 ? "done" : `exit ${result.status ?? "?"}`}`);
}

function startTickTimer(tool: LedgerTool): void {
	const result = tool.systemctl(["start", TICK_TIMER]);
	tool.out(`systemctl --user start ${TICK_TIMER}: ${result.status === 0 ? "done" : `exit ${result.status ?? "?"}`}`);
}

function parseProps(text: string): Record<string, string> {
	const props: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const equals = line.indexOf("=");
		if (equals > 0) props[line.slice(0, equals).trim()] = line.slice(equals + 1).trim();
	}
	return props;
}

/** A systemd timespan ("1w 3d 4h 5min 6.7s") in ms; undefined when the text is not one. */
export function parseSystemdTimespanMs(text: string | undefined): number | undefined {
	if (text === undefined || text.trim() === "") return undefined;
	const units: Record<string, number> = { us: 1e-3, "µs": 1e-3, ms: 1, s: 1000, min: 60_000, month: 2_629_800_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, y: 31_557_600_000 };
	let total = 0;
	let seen = false;
	for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(month|min|ms|us|µs|s|h|d|w|y)?/g)) {
		const value = Number(match[1]);
		const unit = match[2];
		if (!Number.isFinite(value)) return undefined;
		total += value * (unit === undefined ? 1000 : (units[unit] ?? 0));
		seen = true;
	}
	return seen ? total : undefined;
}

// ─── Preflight ───────────────────────────────────────────────────────────────

export type CheckResult = { check: string; ok: boolean; detail: string };

function daemonProbe(tool: LedgerTool): { ok: boolean; reason?: string } {
	try {
		requestSync<unknown>(tool.socketPath, "casRead", { store: LANE_CARD_STORE, id: "preflight" }, { timeoutMs: 2000 });
		return { ok: true };
	} catch (error) {
		const reason = error instanceof MusterdUnreachable ? error.message : messageOf(error);
		return { ok: false, reason };
	}
}

/** How long `musterd` has been up, from the lock file it takes at startup; undefined when there is none. */
export function daemonUptimeMs(tool: LedgerTool): number | undefined {
	try {
		const taken = statSync(join(tool.ledgerDir, "musterd.lock")).mtimeMs;
		return Math.max(0, tool.now() - taken);
	} catch {
		return undefined;
	}
}

function checkDaemon(tool: LedgerTool): CheckResult {
	const probe = daemonProbe(tool);
	if (!probe.ok) return { check: "musterd", ok: false, detail: `musterd does not answer casRead (${probe.reason ?? "unknown"})` };
	const uptime = daemonUptimeMs(tool);
	if (uptime === undefined) return { check: "musterd", ok: false, detail: `no ${join(tool.ledgerDir, "musterd.lock")}: muster uptime is unknown` };
	if (uptime < MIN_DAEMON_UPTIME_MS) return { check: "musterd", ok: false, detail: `musterd has been up for ${formatDuration(uptime)}, under the 10-minute minimum` };
	return { check: "musterd", ok: true, detail: `answering casRead, up ${formatDuration(uptime)}` };
}

/** The rehearsed SHA a rehearsal record names ("rehearsed SHA <sha>", or a `SHA:` line). */
export function rehearsedSha(text: string): string | undefined {
	const named = /\brehearsed sha\b[^0-9a-f]{0,24}([0-9a-f]{7,40})/i.exec(text);
	if (named !== null) return named[1];
	const plain = /^sha\b[^0-9a-f]{0,4}([0-9a-f]{7,40})/im.exec(text);
	return plain === null ? undefined : plain[1];
}

function checkRehearsal(tool: LedgerTool, landing: string | undefined): CheckResult {
	const dir = join(tool.repoRoot, LEDGER_FLIP_DIR);
	let names: string[] = [];
	try {
		names = readdirSync(dir).filter((name) => /^rehearsal-.*\.md$/.test(name)).sort();
	} catch {
		names = [];
	}
	if (names.length === 0) return { check: "rehearsal", ok: false, detail: `no ${LEDGER_FLIP_DIR}/rehearsal-*.md in ${tool.repoRoot}` };
	const notes: string[] = [];
	for (const name of names) {
		const relative = `${LEDGER_FLIP_DIR.split(sep).join("/")}/${name}`;
		const shown = tool.git(["show", `main:${relative}`]);
		if (shown.status !== 0) {
			notes.push(`${name}: not committed on main`);
			continue;
		}
		const last = shown.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "").pop();
		if (last !== "REHEARSAL RESULT: pass") {
			notes.push(`${name}: its last line is ${JSON.stringify(last ?? "")}, not "REHEARSAL RESULT: pass"`);
			continue;
		}
		const sha = rehearsedSha(shown.stdout);
		if (sha === undefined) {
			notes.push(`${name}: it names no rehearsed SHA`);
			continue;
		}
		if (landing !== undefined && tool.git(["merge-base", "--is-ancestor", landing, sha]).status !== 0) {
			notes.push(`${name}: rehearsed ${sha}, older than the landing commit ${landing}`);
			continue;
		}
		return { check: "rehearsal", ok: true, detail: `${name} (committed on main, rehearsed ${sha})` };
	}
	return { check: "rehearsal", ok: false, detail: `no committed passing rehearsal of the landing commit: ${notes.join("; ")}` };
}

/**
 * The live worker lanes (preflight 3), inside the rehearsal's scope when one is set. `isBusLane` is the one
 * predicate for a lane the bus started (LD2), so a seat holder (the seats registry, LD24) and one of the operator's
 * own sessions never refuse the flip (LD46, W1 R2), and this check keeps no second copy of that question.
 */
export function liveAutoLanes(tool: LedgerTool): LaneCard[] {
	const now = tool.now();
	const scope = laneScope(tool.env);
	const rows = tool.lanes().filter((card) => laneInScope(card.laneId, scope));
	if (scope !== undefined) scopeLog(tool.stateDir, `action preflight lane-count ${rows.length} (scope ${scope})`);
	const seats = { stateDir: tool.stateDir };
	return rows.filter(
		(card) => card.state !== "gone" && !isCardGone(card.updatedAt, now) && isBusLane(card) && seatHeldBy(card.laneId, seats) === undefined,
	);
}

function checkLanes(tool: LedgerTool): CheckResult {
	const lanes = liveAutoLanes(tool);
	if (lanes.length > 0) return { check: "lanes", ok: false, detail: `${lanes.length} live orchestrator worker lane(s): ${lanes.map((card) => card.laneId).sort().join(", ")}` };
	return { check: "lanes", ok: true, detail: "no live orchestrator worker lane" };
}

/** One Muster process the flip must wait for (preflight 4). */
export type MusterProcessRow = {
	kind: "pi-session" | "gateway" | "muster-wait" | "opencode-host" | "harness";
	pid: number;
	startMs: number | undefined;
	where: string;
	/** The start file or script the command line names, when it names one: it tells night-watch from psi-guard. */
	command?: string;
	operator: boolean;
};

/**
 * Where harness code is loaded from: Pi's agent folder and the harness trees a process
 * can name in its command line (blueprint RD10, RS4). Taken from the caller so a test
 * states them and a run without a profile keeps working.
 */
export type HarnessRoots = { profileDir?: string; harnessTrees?: string[] };

/** The harness trees on this machine: the split repository and the releases RS4 builds. */
export function defaultHarnessRoots(): HarnessRoots {
	let profileDir: string | undefined;
	try {
		profileDir = piAgentDir();
	} catch {
		// A run with no profile: the command-line kinds that need no agent folder still answer.
		profileDir = undefined;
	}
	return {
		...(profileDir === undefined ? {} : { profileDir }),
		harnessTrees: [join(homedir(), "projects", "harness"), join(homedir(), ".local", "share", "muster", "releases")],
	};
}

/**
 * The start file a command line names, when it names one: the operator reads `night-watch.py`
 * where `python3` would only say that a script under the profile is running.
 */
function startFileOf(row: ProcRow): string | undefined {
	for (const arg of row.args.slice(1)) {
		if (arg === "" || arg.startsWith("-")) continue;
		const name = basename(arg);
		if (/\.(?:mts|ts|mjs|cjs|js|py|sh)$/.test(name)) return name;
	}
	return undefined;
}

/**
 * RD10's command-line kind (RS4, extending LC15): a process that loads harness code and
 * is invisible to the lease, gateway, waiter and OpenCode kinds — an unleased Pi session,
 * the toolbelt MCP server, a unit's own process. Matched on `/proc/<pid>/cmdline` only,
 * never the environment, and reported by pid, start time and command name.
 */
export function harnessCmdlineRows(rows: readonly ProcRow[], roots: HarnessRoots = defaultHarnessRoots()): MusterProcessRow[] {
	const trees = (roots.harnessTrees ?? []).filter((tree) => tree !== "");
	const out: MusterProcessRow[] = [];
	for (const row of rows) {
		const command = row.args[0] === undefined || row.args[0] === "" ? row.comm : row.args[0];
		const name = basename(command);
		const cmd = row.args.join(" ");
		const kinds: string[] = [];
		if (row.comm === "pi" || name === "pi") kinds.push("pi-cli");
		if (roots.profileDir !== undefined && roots.profileDir !== "" && cmd.includes(`${roots.profileDir}${sep}`)) kinds.push("pi-profile");
		if (trees.some((tree) => cmd.includes(`${tree}${sep}`))) kinds.push("harness-tree");
		if (cmd.includes("toolbelt/mcp/server.ts")) kinds.push("toolbelt-mcp");
		if (kinds.length === 0) continue;
		const startFile = startFileOf(row);
		out.push({ kind: "harness", pid: row.pid, startMs: row.startMs, where: `${kinds.join("+")} ${name}`, ...(startFile === undefined ? {} : { command: startFile }), operator: false });
	}
	return out;
}

function argValue(args: readonly string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	const value = index < 0 ? undefined : args[index + 1];
	return value === undefined || value === "" ? undefined : value;
}

/** The programs whose `LEASE` names the supervisor's programme leases, never a session's (LC0-R4, F3). */
function supervisorLeaseNames(): Set<string> {
	const names = new Set<string>();
	try {
		const state = readSupervisorHeartbeatState();
		if (state !== undefined && typeof state.programmeId === "string" && state.programmeId !== "") names.add(basename(supervisorLeasePath(state.programmeId)));
	} catch {
		// No heartbeat state, no supervisor lease to skip.
	}
	return names;
}

/**
 * Every Muster process the flip must wait for: a Pi session from its lease (the
 * `flock` holder's parent process, its lane from `CONCORD_AGENT_ID`), the gateway
 * service, a `muster wait` waiter and an OpenCode host, by cmdline. A session whose
 * lane cannot be read is the operator's own: the bus launched every registered lane, and
 * only he restarts a session the bus does not own.
 */
export function musterProcesses(tool: LedgerTool, roots: HarnessRoots = defaultHarnessRoots()): MusterProcessRow[] {
	const rows = tool.processes();
	const out: MusterProcessRow[] = [];
	const supervisors = supervisorLeaseNames();
	let leaseNames: string[] = [];
	try {
		leaseNames = readdirSync(tool.leasesDir).sort();
	} catch {
		leaseNames = [];
	}
	for (const name of leaseNames) {
		if (!/^lease-[0-9a-f]{24}\.lock$/.test(name) || supervisors.has(name)) continue;
		const path = join(tool.leasesDir, name);
		if (!tool.leaseHeld(path)) continue;
		const holder = rows.find((row) => row.args.includes(path));
		if (holder === undefined) continue;
		const sessionPid = holder.ppid;
		const lane = tool.processEnv(sessionPid)["CONCORD_AGENT_ID"]?.trim();
		const named = lane === undefined || lane === "" ? undefined : lane;
		out.push({
			kind: "pi-session",
			pid: sessionPid,
			startMs: rows.find((row) => row.pid === sessionPid)?.startMs ?? holder.startMs,
			where: named ?? `session ${sessionPid}`,
			operator: named === undefined,
		});
	}
	for (const row of rows) {
		const cmd = row.args.join(" ");
		if (/muster\.mts"?\s+gateway\b/.test(cmd)) out.push({ kind: "gateway", pid: row.pid, startMs: row.startMs, where: "muster-gateway.service", operator: false });
		if (/muster\.mts"?\s+wait\b/.test(cmd)) out.push({ kind: "muster-wait", pid: row.pid, startMs: row.startMs, where: argValue(row.args, "--inbox") ?? "unknown", operator: false });
		if (/opencode-host(?:-lib)?\.mjs/.test(cmd)) out.push({ kind: "opencode-host", pid: row.pid, startMs: row.startMs, where: argValue(row.args, "--lane") ?? "unknown", operator: false });
	}
	// A session named by a lease is also on the command line; it is one process, listed once.
	const seen = new Set(out.map((row) => row.pid));
	for (const row of harnessCmdlineRows(rows, roots)) {
		if (seen.has(row.pid)) continue;
		seen.add(row.pid);
		out.push(row);
	}
	return out;
}

function checkProcesses(tool: LedgerTool, landingMs: number | undefined, roots?: HarnessRoots): CheckResult {
	const scope = laneScope(tool.env);
	const all = musterProcesses(tool, roots);
	const rows = scope === undefined ? all : all.filter((row) => laneInScope(row.where, scope));
	if (scope !== undefined) scopeLog(tool.stateDir, `action preflight process-count ${rows.length} (scope ${scope})`);
	if (landingMs === undefined) return { check: "processes", ok: true, detail: "no landing commit: no process is older than it (see the rehearsal and lanes checks)" };
	const old = rows.filter((row) => row.startMs !== undefined && row.startMs < landingMs);
	if (old.length === 0) return { check: "processes", ok: true, detail: `${rows.length} Muster process(es), all started after the landing commit` };
	const listed = old
		.sort((left, right) => left.startMs! - right.startMs!)
		.map((row) => `${row.kind} pid ${row.pid} since ${new Date(row.startMs!).toISOString()} ${row.where}${row.operator ? " (the operator restarts it)" : ""}`);
	return { check: "processes", ok: false, detail: `${old.length} Muster process(es) started before the landing commit: ${listed.join("; ")}` };
}

function checkSpool(tool: LedgerTool): CheckResult {
	const count = tool.spoolCount();
	return count === 0 ? { check: "spool", ok: true, detail: "empty" } : { check: "spool", ok: false, detail: `the spool holds ${count} request(s); the owners must deliver them first` };
}

/**
 * When systemd says a timer next fires. A calendar timer reports no monotonic deadline
 * (`NextElapseUSecMonotonic=0`), so zero or empty means absent and `NextElapseUSecRealtime` answers (LD46).
 */
function nextElapseMs(props: Record<string, string>, now: number): number | undefined {
	const monotonic = parseSystemdTimespanMs(props["NextElapseUSecMonotonic"]);
	const boot = monotonic !== undefined && monotonic > 0 ? bootTimeMs(now) : undefined;
	if (monotonic !== undefined && boot !== undefined) return boot + monotonic;
	const realtime = Date.parse(props["NextElapseUSecRealtime"] ?? "");
	return Number.isFinite(realtime) ? realtime : undefined;
}

/**
 * Preflight 6: a tick or janitor run happening now, or the janitor's own deadline inside the margin. The tick
 * timer's two-minute cadence alone does not refuse, because the flip's first step stops it (LD46).
 */
function checkTimers(tool: LedgerTool): CheckResult {
	const now = tool.now();
	const running: string[] = [];
	for (const service of [TICK_SERVICE, JANITOR_SERVICE]) {
		const shown = tool.systemctl(["show", service, "-p", "LoadState", "-p", "ActiveState"]);
		if (shown.status !== 0) continue;
		const state = parseProps(shown.stdout)["ActiveState"];
		if (state === "activating" || state === "active") running.push(`${service} ${state}`);
	}
	const due: string[] = [];
	const shown = tool.systemctl(["show", JANITOR_TIMER, "-p", "LoadState", "-p", "ActiveState", "-p", "NextElapseUSecRealtime", "-p", "NextElapseUSecMonotonic"]);
	if (shown.status === 0) {
		const props = parseProps(shown.stdout);
		if (props["ActiveState"] === "active") {
			const dueMs = nextElapseMs(props, now);
			if (dueMs !== undefined && dueMs - now <= TIMER_MARGIN_MS) due.push(`${JANITOR_TIMER} at ${new Date(dueMs).toISOString()}`);
		}
	}
	if (running.length === 0 && due.length === 0) {
		return { check: "timers", ok: true, detail: `neither ${TICK_SERVICE} nor ${JANITOR_SERVICE} is running and ${JANITOR_TIMER} is not due within 10 minutes` };
	}
	const refusal = [...(running.length > 0 ? [`running now: ${running.join(", ")}`] : []), ...(due.length > 0 ? [`due within 10 minutes: ${due.join(", ")}`] : [])];
	return { check: "timers", ok: false, detail: refusal.join("; ") };
}

/**
 * The plan's landing commit: the merge that brought LC10 to main, or `--landing`. It is a
 * Muster commit, so both reads run in the checkout the Muster code stands in, never in the
 * workspace the CLI happens to run from.
 */
function landingCommit(tool: LedgerTool, option: string | undefined): { sha?: string; ms?: number; reason?: string } {
	const found = option ?? (() => {
		const logged = tool.gitInCode(["log", "--first-parent", "--format=%H%x09%ct", "-1", "--grep=Merge lane/lc10"]);
		if (logged.status !== 0) return undefined;
		const [sha] = (logged.stdout.split("\n")[0] ?? "").split("\t");
		return sha === undefined || sha === "" ? undefined : sha;
	})();
	if (found === undefined) return { reason: "the landing commit (the merge that brought LC10 to main) is not in this checkout: pass --landing <sha>" };
	const shown = tool.gitInCode(["show", "-s", "--format=%H%x09%ct", found]);
	if (shown.status !== 0) return { reason: `--landing ${found} is not a commit in this checkout` };
	const [sha, seconds] = shown.stdout.trim().split("\t");
	const ms = Number(seconds) * 1000;
	if (sha === undefined || !Number.isFinite(ms)) return { reason: `--landing ${found} has no committer time to compare with` };
	return { sha, ms };
}

/**
 * Which restart a process needs (RD10, VR24-229 item 7): a session picks the new code up on
 * its own next start, and a helper is restarted by the release script's unit step.
 */
export type RestartClass = "interactive-session" | "helper";

/**
 * The one classification the harness flip makes of a live process, and the reason it never
 * restarts a session underneath itself: a lease holder, the Pi CLI, a `muster wait` waiter
 * and an OpenCode host all belong to a session, which loads the new code when it next starts;
 * the gateway, the toolbelt MCP server and a unit's own process are helpers the flip restarts.
 */
export function restartClassOf(row: MusterProcessRow): RestartClass {
	if (row.kind === "pi-session" || row.kind === "muster-wait" || row.kind === "opencode-host") return "interactive-session";
	if (row.kind === "harness" && row.where.startsWith("pi-cli")) return "interactive-session";
	return "helper";
}

/**
 * Preflight 4 of the harness flip (RD10, VR24-229 item 7): every Muster process that started
 * before the landing commit is restart-needed, and none of them refuses the flip. Only a live
 * worker lane refuses it (`checkLanes`, unchanged): a lane is mid-task and cannot be restarted
 * underneath itself, while an interactive session picks the new code up on its next start and
 * a helper is restarted by the release script's own step. The rows are listed by pid, start
 * time, class and name, so the operator sees what the flip leaves alone before the link moves.
 */
export function restartNeededCheck(tool: LedgerTool, landingMs: number | undefined, roots?: HarnessRoots): CheckResult {
	const scope = laneScope(tool.env);
	const all = musterProcesses(tool, roots);
	const rows = scope === undefined ? all : all.filter((row) => laneInScope(row.where, scope));
	if (scope !== undefined) scopeLog(tool.stateDir, `action preflight process-count ${rows.length} (scope ${scope})`);
	if (landingMs === undefined) {
		return { check: "processes", ok: true, detail: `restart-needed: ${rows.length} Muster process(es), and no landing commit to compare them with` };
	}
	const old = rows.filter((row) => row.startMs !== undefined && row.startMs < landingMs);
	if (old.length === 0) {
		return { check: "processes", ok: true, detail: `no process is restart-needed: ${rows.length} Muster process(es), all started after the landing commit` };
	}
	const listed = old
		.sort((left, right) => left.startMs! - right.startMs!)
		.map((row) => `${restartClassOf(row)} pid ${row.pid} since ${new Date(row.startMs!).toISOString()} ${row.where}${row.command === undefined ? "" : ` (${row.command})`}`);
	return { check: "processes", ok: true, detail: `${old.length} of ${rows.length} Muster process(es) restart-needed, started before the landing commit: ${listed.join("; ")}` };
}

/**
 * RS4's flip preflight (blueprint §9, RD10): a live orchestrator worker lane refuses it, and
 * nothing else does. It is LC15's two checks and nothing else, so the ledger's own conditions
 * (the daemon, the rehearsal, the spool, the timers) never refuse a harness flip.
 */
export function harnessFlipChecks(tool: LedgerTool, options: { landing?: string; roots?: HarnessRoots } = {}): CheckResult[] {
	const landing = landingCommit(tool, options.landing);
	return [
		checkLanes(tool),
		landing.sha === undefined
			? { check: "processes", ok: false, detail: landing.reason ?? "the landing commit is unknown" }
			: restartNeededCheck(tool, landing.ms, options.roots),
	];
}

/** Every preflight check, in the plan's order. */
export function preflightChecks(tool: LedgerTool, options: { landing?: string } = {}): CheckResult[] {
	const landing = landingCommit(tool, options.landing);
	return [
		checkDaemon(tool),
		checkRehearsal(tool, landing.sha),
		checkLanes(tool),
		// 4. A Muster process older than the landing commit. An unknown landing commit is not a
		// pass: without it the check cannot tell a stale process from a fresh one.
		landing.sha === undefined ? { check: "processes", ok: false, detail: landing.reason ?? "the landing commit is unknown" } : checkProcesses(tool, landing.ms),
		checkSpool(tool),
		checkTimers(tool),
	];
}

// ─── Flip, abort, rollback ───────────────────────────────────────────────────

/** The flip record LC14 writes beside the manifest: the export's input. */
export type FlipRecord = { flipId: string; cursor: string; askCounts: Record<string, number> };

/**
 * The record itself is the importer's path (`muster-ledger-import.mts:flipRecordPath`),
 * beside the state dir: the flip writes it there and the export reads it there, so
 * a rollback finds what the flip wrote wherever the checkout happens to be
 * (finding 17, 2026-10-18).
 */
export function readFlipRecord(tool: LedgerTool, flipId: string): FlipRecord | undefined {
	try {
		const parsed = JSON.parse(readFileSync(flipRecordPath(tool.stateDir, flipId), "utf8")) as { cursor?: unknown; askCounts?: unknown };
		if (typeof parsed.cursor !== "string") return undefined;
		return { flipId, cursor: parsed.cursor, askCounts: parsed.askCounts === undefined || parsed.askCounts === null ? {} : (parsed.askCounts as Record<string, number>) };
	} catch {
		return undefined;
	}
}

/** A flip id names one flip for its life: `flip-<local date>-<local time>`. */
export function flipIdFor(now: number): string {
	const at = new Date(now);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `flip-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
}

/** The tar of the stores that move, beside the state dir — where LC14's import looks for it. */
export function flipTarPath(stateDir: string, flipId: string): string {
	return join(dirname(stateDir), `muster-flip-${flipId}.tar`);
}

/**
 * Tar the moved stores and the two files beside the state dir. Written once per flip id:
 * a rerun keeps the first tar, because the import has already moved the message files
 * into it and a second tar would hold the folders without their mail.
 */
function writeStoresTar(tool: LedgerTool, tarPath: string): number {
	const stateDir = tool.stateDir;
	const args = ["-cf", tarPath];
	let count = 0;
	const inside = MOVED_STORES.filter((name) => existsSync(join(stateDir, name)));
	if (inside.length > 0) {
		args.push("-C", stateDir, ...inside);
		count += inside.length;
	}
	const beside = SIBLING_STORES.filter((name) => existsSync(join(dirname(stateDir), name)));
	if (beside.length > 0) {
		args.push("-C", dirname(stateDir), ...beside);
		count += beside.length;
	}
	if (count === 0) args.push("-T", "/dev/null");
	const result = spawnSync("tar", args, { encoding: "utf8", timeout: 300_000 });
	if (result.status !== 0) throw new Error(`tar exited ${result.status ?? "without a status"}: ${(result.stderr ?? "").trim().split("\n")[0] ?? ""}`);
	return count;
}

function scopeNote(tool: LedgerTool, line: string): void {
	const scope = laneScope(tool.env);
	if (scope !== undefined) scopeLog(tool.stateDir, `action ${line} (scope ${scope})`);
}

/** `frozen`, `ledger` with the cursor, or an error reason. */
function switchStateOf(tool: LedgerTool): BackendState {
	return backendState(tool.stateDir);
}

/**
 * `muster ledger flip` (CV3): freeze, tar, import, switch, replay. Idempotent by flip
 * id: a rerun after a kill anywhere finishes the steps the install has not reached.
 */
export function ledgerFlip(tool: LedgerTool, options: { flipId?: string; landing?: string } = {}): number {
	const state = switchStateOf(tool);
	if (state.backend === "ledger") {
		const flipId = options.flipId ?? state.flipId;
		if (flipId !== state.flipId) {
			tool.err(`backend.json names the ledger for flip ${state.flipId}, not ${flipId}`);
			return 2;
		}
		tool.out(`already flipped: backend.json names the ledger (flip ${state.flipId}, cursor ${state.cursor})`);
		scopeNote(tool, `flip ${state.flipId} already done`);
		startTickTimer(tool);
		tool.out(`spool replayed: ${replaySpool(tool.stateDir)} request(s)`);
		return 0;
	}
	if (state.backend === "frozen" && options.flipId !== undefined && options.flipId !== state.flipId) {
		tool.err(`a different flip is frozen: ${state.flipId}. Run muster ledger abort first.`);
		return 2;
	}
	const flipId = options.flipId ?? (state.backend === "frozen" ? state.flipId : flipIdFor(tool.now()));
	scopeNote(tool, `flip ${flipId}`);

	// 1. The switch freezes at `from: files, to: ledger`, and the tick timer stops. A rerun
	// from `frozen` repeats both: the write replaces the same record and stop is idempotent.
	if (state.backend === "files") {
		writeBackendSwitch(tool.stateDir, { backend: "frozen", from: "files", to: "ledger", flipId, at: new Date(tool.now()).toISOString() });
		tool.out(`frozen: backend.json is frozen (files -> ledger, flip ${flipId})`);
	}
	stopTickTimer(tool);
	crashKill(FLIP_CRASH_POINTS.afterFreeze);

	// 2. The tar of the moved stores.
	const tarPath = flipTarPath(tool.stateDir, flipId);
	if (existsSync(tarPath)) tool.out(`backup kept: ${tarPath}`);
	else {
		const stores = writeStoresTar(tool, tarPath);
		tool.out(`backed up: ${tarPath} (${stores} store(s))`);
	}
	crashKill(FLIP_CRASH_POINTS.afterTar);

	// 3. The import (LC14) and its completeness check: every chunk's request row exists,
	// or every chunk was committed by an earlier run.
	const plan = planImport({ flipId, stateDir: tool.stateDir, nowMs: tool.now() });
	let run;
	try {
		run = importLedger({ flipId, stateDir: tool.stateDir, socketPath: tool.socketPath });
	} catch (error) {
		tool.err(`the import did not complete (${messageOf(error)}). The install stays frozen; rerun muster ledger flip to finish it.`);
		return 1;
	}
	const committed = run.committedChunks.length + run.skippedChunks.length;
	if (committed !== plan.chunks.length) {
		tool.err(`the import is incomplete: ${committed} of ${plan.chunks.length} chunks are in the ledger. Rerun muster ledger flip.`);
		return 1;
	}
	if (readFlipRecord(tool, flipId) === undefined) {
		tool.err(`the import wrote no flip record at ${flipRecordPath(tool.stateDir, flipId)}. Rerun muster ledger flip.`);
		return 1;
	}
	tool.out(`imported: ${plan.chunks.length} chunk(s) (${run.committedChunks.length} committed, ${run.skippedChunks.length} already present); cursor ${run.cursor}; manifest ${run.manifestPath}`);
	crashKill(FLIP_CRASH_POINTS.afterImport);

	// 4. The ledger switch, with the cursor, and the tick timer back on.
	writeBackendSwitch(tool.stateDir, { backend: "ledger", flipId, at: new Date(tool.now()).toISOString(), cursor: run.cursor });
	tool.out(`switched: backend.json names the ledger (flip ${flipId}, cursor ${run.cursor})`);
	startTickTimer(tool);
	crashKill(FLIP_CRASH_POINTS.afterSwitch);

	// 5. The spool, through the owners.
	tool.out(`spool replayed: ${replaySpool(tool.stateDir)} request(s)`);
	crashKill(FLIP_CRASH_POINTS.afterSpool);

	// 6. The CV3 smoke checks are the orchestrator's, on the running install.
	tool.out("CV3 smoke checks to run next: one muster send each to the orchestrator, the architect and one of the operator's sessions; one rh- probe lane per harness, launched and closed; muster wait --events wakes on a probe report; muster asks lists the same queue; muster lanes equals the pre-flip list minus the manifest's ghosts. Then both seats restart their waiters.");
	return 0;
}

/** `muster ledger abort`: a frozen install returns to the backend it came from. */
export function ledgerAbort(tool: LedgerTool): number {
	const state = switchStateOf(tool);
	if (state.backend === "files") {
		tool.out("nothing to abort: backend.json already names files");
		startTickTimer(tool);
		return 0;
	}
	if (state.backend === "ledger") {
		tool.err(`the flip completed (flip ${state.flipId}); use muster ledger rollback to go back to files`);
		return 2;
	}
	if (state.from === "ledger") {
		const record = readFlipRecord(tool, state.flipId);
		if (record === undefined) {
			tool.err(`cannot return to the ledger: the import record at ${flipRecordPath(tool.stateDir, state.flipId)} is missing, so the cursor is unknown`);
			return 1;
		}
		writeBackendSwitch(tool.stateDir, { backend: "ledger", flipId: state.flipId, at: new Date(tool.now()).toISOString(), cursor: record.cursor });
	} else {
		writeBackendSwitch(tool.stateDir, { backend: "files" });
	}
	tool.out(`aborted: backend.json names ${state.from}`);
	startTickTimer(tool);
	tool.out(`spool replayed: ${replaySpool(tool.stateDir)} request(s)`);
	return 0;
}

/** The flip tool's own rollback state, so an export killed halfway is finished by a rerun. */
export type RollbackRecord = { flipId: string; cursor: string; askCounts: Record<string, number>; exported: boolean };

function rollbackRecordPath(stateDir: string): string {
	return join(stateDir, "flip-rollback.json");
}

function readRollbackRecord(stateDir: string): RollbackRecord | undefined {
	try {
		const parsed = JSON.parse(readFileSync(rollbackRecordPath(stateDir), "utf8")) as Partial<RollbackRecord>;
		if (typeof parsed.flipId !== "string" || typeof parsed.cursor !== "string") return undefined;
		return { flipId: parsed.flipId, cursor: parsed.cursor, askCounts: parsed.askCounts ?? {}, exported: parsed.exported === true };
	} catch {
		return undefined;
	}
}

function finishRollback(tool: LedgerTool, pending: RollbackRecord): number {
	stopTickTimer(tool);
	try {
		const result = exportLedger({ flipId: pending.flipId, cursor: pending.cursor, askCounts: pending.askCounts, stateDir: tool.stateDir, socketPath: tool.socketPath });
		writeJsonAtomic(rollbackRecordPath(tool.stateDir), { ...pending, exported: true });
		tool.out(
			`exported: ${result.accepted + result.delivered} message(s), ${result.asks} ask event(s), ${Object.values(result.stores).reduce((sum, count) => sum + count, 0)} store record(s), ${result.skipped.length} skipped`,
		);
	} catch (error) {
		// The switch already names files and `flip-rollback.json` holds the cursor, so a rerun
		// finishes the export. Nothing is deleted: the ledger keeps every record.
		tool.err(`the export failed (${messageOf(error)}). backend.json names files and ${rollbackRecordPath(tool.stateDir)} holds the cursor: rerun muster ledger rollback to finish it.`);
		return 1;
	}
	startTickTimer(tool);
	tool.out(`rolled back: backend.json names files; spool replayed: ${replaySpool(tool.stateDir)} request(s)`);
	return 0;
}

/**
 * `muster ledger rollback`: the export (LC14), then files. The export writes files and
 * refuses unless `backend.json` names files (`muster-ledger-export.mts`), so the switch
 * moves first and `flip-rollback.json` makes the window between the two recoverable.
 */
export function ledgerRollback(tool: LedgerTool): number {
	const state = switchStateOf(tool);
	if (state.backend === "files") {
		const pending = readRollbackRecord(tool.stateDir);
		if (pending === undefined || pending.exported) {
			tool.out("nothing to roll back: backend.json already names files");
			startTickTimer(tool);
			return 0;
		}
		tool.out(`finishing the export of flip ${pending.flipId}`);
		return finishRollback(tool, pending);
	}
	const record = readFlipRecord(tool, state.flipId);
	if (record === undefined) {
		tool.err(`the import record at ${flipRecordPath(tool.stateDir, state.flipId)} is missing: the export needs its askCounts, so nothing was changed`);
		return 1;
	}
	const cursor = state.backend === "ledger" ? state.cursor : record.cursor;
	const pending: RollbackRecord = { flipId: state.flipId, cursor, askCounts: record.askCounts, exported: false };
	writeJsonAtomic(rollbackRecordPath(tool.stateDir), pending);
	writeBackendSwitch(tool.stateDir, { backend: "files" });
	tool.out(`switching back to files (flip ${state.flipId}, cursor ${cursor})`);
	return finishRollback(tool, pending);
}

// ─── Backup ──────────────────────────────────────────────────────────────────

/** Local calendar date, the name `ledger-<date>.sqlite` carries (LC-D9). */
export function backupDate(now: number): string {
	const at = new Date(now);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

function backupDir(stateDir: string): string {
	return join(stateDir, "backups");
}

/** The backup files, newest name first. */
export function listBackups(stateDir: string): string[] {
	try {
		return readdirSync(backupDir(stateDir)).filter((name) => /^ledger-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name)).sort().reverse();
	} catch {
		return [];
	}
}

/**
 * One consistent copy of the ledger: SQLite `VACUUM INTO` from a second, read-only
 * connection, which WAL makes safe while `musterd` writes (`ledger-cutover-facts`: a
 * readonly second connection ran it with the writer open). The copy is written whole
 * (a same-day rerun replaces it) and the newest `BACKUP_KEEP` are kept.
 */
export type BackupOptions = { stateDir: string; ledgerDir: string; now: number };

export function backupLedger(options: BackupOptions): { path: string; bytes: number; kept: number; removed: string[] } {
	const source = join(options.ledgerDir, "ledger.sqlite");
	if (!existsSync(source)) throw new Error(`no ledger at ${source}`);
	const dir = backupDir(options.stateDir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const target = join(dir, `ledger-${backupDate(options.now)}.sqlite`);
	rmSync(target, { force: true });
	const database = new DatabaseSync(source, { readOnly: true });
	try {
		database.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
	} finally {
		database.close();
	}
	// Measured before the prune: the newest `BACKUP_KEEP` are kept, and a copy dated older
	// than the seven newest is removed again (a same-day rerun replaces its own file).
	const bytes = statSync(target).size;
	const removed = listBackups(options.stateDir).filter((_name, index) => index >= BACKUP_KEEP);
	for (const name of removed) rmSync(join(dir, name), { force: true });
	return { path: target, bytes, kept: BACKUP_KEEP, removed };
}

// ─── Status ──────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours} h ${minutes % 60} min`;
	return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/** `muster ledger status`: what the switch, the daemon, the spool and the backups say. Reads only. */
export function ledgerStatus(tool: LedgerTool): number {
	const state = switchStateOf(tool);
	tool.out(`state dir: ${tool.stateDir}`);
	if (state.backend === "frozen") tool.out(`backend: frozen (from ${state.from} to ${state.to}, flip ${state.flipId}, at ${state.at})`);
	else if (state.backend === "ledger") tool.out(`backend: ledger (flip ${state.flipId}, at ${state.at}, cursor ${state.cursor})`);
	else tool.out("backend: files");
	const probe = daemonProbe(tool);
	tool.out(`musterd: ${probe.ok ? `answering casRead on ${tool.socketPath}` : `unreachable (${probe.reason ?? "unknown"})`}`);
	const uptime = daemonUptimeMs(tool);
	tool.out(`uptime: ${uptime === undefined ? `unknown (no ${join(tool.ledgerDir, "musterd.lock")})` : formatDuration(uptime)}`);
	tool.out(`spool: ${tool.spoolCount()} request(s) in ${tool.stateDir}`);
	const backups = listBackups(tool.stateDir);
	tool.out(`backups: ${backups.length}${backups.length === 0 ? "" : ` (newest ${backups[0]})`}`);
	tool.out(`lanes: ${liveAutoLanes(tool).length} live auto lane(s)`);
	const scope = laneScope(tool.env);
	if (scope !== undefined) tool.out(`scope: ${LANE_SCOPE_ENV}=${scope}`);
	return 0;
}

// ─── The CLI verb ────────────────────────────────────────────────────────────

const USAGE = [
	"muster ledger <verb> [--landing <sha>] [--flip-id <id>]",
	"",
	"  status      the switch, muster, the spool and the backups (reads only)",
	"  preflight   refuse the flip while any of the plan's six conditions holds (exit 1)",
	"  flip        freeze, tar, import and switch to the ledger (CV3; needs the architect's word)",
	"  abort       return a frozen install to the backend it came from",
	"  rollback    export the ledger to files and switch back (CV3)",
	"  backup      one consistent copy of the ledger, keeping the newest 7 (LC-D9)",
	"",
	"--harness        RS4's flip preflight instead (RD10): a live worker lane refuses it,",
	"                 and every other process older than --landing is restart-needed",
	"",
	"--landing <sha>  the landing commit the preflight compares process start times with",
	"                 (default: the merge that brought LC10 to main)",
	"--flip-id <id>   the flip id a rerun continues (default: the frozen flip, else a new one)",
].join("\n");

const VERBS = new Set(["status", "preflight", "flip", "abort", "rollback", "backup"]);

export async function runLedger(ctx: CliContext): Promise<number> {
	const parsed = parseFlags(ctx.argv, ["landing", "flip-id"]);
	const verb = parsed.positionals[0];
	if (verb === undefined || !VERBS.has(verb)) {
		ctx.io.err(`${verb === undefined ? "muster ledger: a verb is required" : `muster ledger: unknown verb ${verb}`}\n`);
		ctx.io.err(`${USAGE}\n`);
		return 2;
	}
	const stateDir = lanesStateDir(ctx.env);
	const tool = realLedgerTool({ stateDir, repoRoot: ctx.repoRoot, env: ctx.env, out: ctx.io.out, err: ctx.io.err });
	const landing = parsed.values.get("landing");
	switch (verb) {
		case "status":
			return ledgerStatus(tool);
		case "preflight": {
			const checks = parsed.flags.has("harness")
				? harnessFlipChecks(tool, { ...(landing !== undefined ? { landing } : {}) })
				: preflightChecks(tool, { ...(landing !== undefined ? { landing } : {}) });
			for (const check of checks) tool.out(`[${check.ok ? "ok" : "refuse"}] ${check.check}: ${check.detail}`);
			const refused = checks.filter((check) => !check.ok);
			if (refused.length > 0) {
				tool.err(`the flip is refused: ${refused.length} of ${checks.length} checks failed`);
				return 1;
			}
			tool.out("the flip may run");
			return 0;
		}
		case "flip": {
			const flipId = parsed.values.get("flip-id");
			return ledgerFlip(tool, { ...(flipId !== undefined ? { flipId } : {}), ...(landing !== undefined ? { landing } : {}) });
		}
		case "abort":
			return ledgerAbort(tool);
		case "rollback":
			return ledgerRollback(tool);
		case "backup": {
			const written = backupLedger({ stateDir: tool.stateDir, ledgerDir: tool.ledgerDir, now: tool.now() });
			tool.out(`backup: ${written.path} (${written.bytes} bytes)${written.removed.length === 0 ? "" : `; removed ${written.removed.join(", ")}`}`);
			return 0;
		}
	}
}

export const command: CliCommand = {
	name: "ledger",
	summary: "the durable ledger: status, preflight, flip, abort, rollback, backup",
	usage: USAGE,
	run: runLedger,
};
