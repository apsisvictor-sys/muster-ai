/**
 * `muster lanes` (A1) — read-only lane directory.
 *
 * Enumerates every harness lane the agent can see right now, from existing
 * surfaces only: A2 lane-card files when present, Pi session JSONLs, and
 * `claude agents --json`. Writes nothing. No lane is touched.
 *
 * Card fields per §4.2: laneId, harness, cwd, branch, state, model, thinking,
 * since, wall. Concords enrolled lanes join once their A2 adapter writes a
 * card; until then A1 derives the row from the harness's own sources.
 *
 * States per §4.2: idle, running, waiting, stalled, quota-walled, gone.
 *   - quota-walled: `lib/quota-classifier.ts` over `provider-pool.json`'s
 *     quotaShapes — the one owner of wall wording, no second list.
 *   - stalled: last activity older than `--stalled-minutes` (default 20).
 *   - gone: card absent or session JSONL mtime older than `--gone-minutes`
 *     (default 60); a lane is "gone" only when A1 has no harness evidence
 *     that points at it.
 *
 * Evidence (lifecycle WP2, audit a1 a2 a3 a5, LD2). Each call reads, once, what
 * the harness surfaces cannot say on their own: whether the process is up
 * (`alive`, `aliveVia`: a tmux pane or a `claude agents` pid in /proc), when the
 * lane last took a turn (`lastTurnAt`, from its transcript, never from the
 * heartbeat), whether its last turn ended on a quota wall, and who started it
 * (`origin`). Sessions nobody enrolled show as `operator` rows. Still writes nothing.
 */

import { closeSync, existsSync, openSync, type Dirent, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { classifyQuota, type QuotaShape } from "../../routing/quota-classifier.ts";
import { listLaneCards } from "./lane-card.ts";
import { withoutSeatCredential } from "./seat-env.ts";
import { listLaneRecords, type LaneRecord } from "../lane-lifecycle.ts";
import { tmuxSessionForHarness } from "../send.ts";
import { loadPoolConfig } from "../../routing/provider-pool.ts";
import { readBackend, writeBackend } from "../ledger/backend.ts";
import { ledgerCasStore, ledgerCommit, type LedgerCasStore } from "../ledger/cas-store.ts";
import { LANE_REGISTRY_STORE, ownerLedgerSocket } from "../ledger/stores.ts";
import { CAS_ATTEMPTS } from "../owner-fence.ts";
// The card contract has ONE owner: lib/lane-card.ts (shape, state vocabulary,
// thresholds, file IO). This module reads it and never redefines it.
import {
	isCardGone,
	isLaneControlOutcome,
	isLaneReportMark,
	stalledThresholdMs,
	type LaneCard,
	type LaneHarness,
	type LaneOrigin,
	type LaneState,
	type LaneWall,
} from "./lane-card.ts";

export interface LaneDirectoryOptions {
	home?: string;
	stateDir?: string;
	/** Sessions root for Pi JSONLs (`~/.pi/agent/sessions` by default). */
	sessionsRoot?: string;
	/** Card-file directory (`<stateDir>/muster/lanes` by default). */
	laneCardsDir?: string;
	/** Stalled threshold — default 20 minutes per §4.2. */
	stalledMinutes?: number;
	/** Gone threshold — default 60 minutes (no heartbeat + older than this). */
	goneMinutes?: number;
	/** Maximum JSONL bytes to scan from the tail when deriving state. */
	deriveTailBytes?: number;
	nowMs?: number;
	/** Skip spawning `claude agents --json` (useful in tests). */
	skipClaude?: boolean;
	/**
	 * Include Pi sessions that no lane registry entry claims.
	 *
	 * Default false: the directory is a list of *lanes*, and a session JSONL left
	 * behind by an old one-off `pi` run is not a lane (acceptance check 1).
	 */
	includeUnregisteredSessions?: boolean;
	/** Lane registry (`<stateDir>/pi-lanes.json`: lane id → session id). */
	laneRegistryPath?: string;
	/** `claude agents --json` output override (tests only; avoids spawning the CLI). */
	claudeAgentsOverride?: { stdout: string };
	/** Provider pool override for tests. */
	poolConfigPath?: string;
	/** Process, tmux and systemd readers; tests replace them so no fixture reads the real machine. */
	evidence?: Partial<LaneEvidence>;
	/** Claude transcripts (`~/.claude/projects` by default). */
	claudeProjectsRoot?: string;
}

/** One tmux pane, as `tmux list-panes -a` prints it. */
export interface TmuxPane {
	session: string;
	window: string;
	dead: boolean;
	pid: number;
	/** tmux's `#{window_id}`: two windows may share a name, and one window may hold several panes. Absent in fixtures. */
	windowId?: string;
}

/** A live Pi process. `lineage` is the process and its ancestors, nearest first. */
export interface PiProcess {
	pid: number;
	sessionId?: string;
	lineage: number[];
}

/** What the directory reads from the machine itself, once per call. */
export interface LaneEvidence {
	/** `[]` when there is no tmux server; undefined when tmux could not be read at all. */
	tmuxPanes(): TmuxPane[] | undefined;
	pidAlive(pid: number): boolean;
	/** Does `/proc/<pid>/environ` hold `CONCORD_AGENT_ID` (a process the launcher or a daemon started)? */
	hasAgentEnv(pid: number): boolean;
	/** Live Pi processes that carry no lane identity of their own. */
	piProcesses(): PiProcess[];
	/** Active `hermes-*` user services. */
	hermesUnits(): string[];
	/**
	 * The active scope units of this user's systemd manager (VR21-42 S4). The launcher runs each
	 * lane's pane command inside a transient `lane-<lane>-<epoch>.scope` (pi-lane-launch.sh), so an
	 * active unit under a lane's own name is evidence its process tree still runs — Liveness a
	 * heartbeat, transcript or tmux pane cannot give.
	 */
	scopeUnits(): string[];
}
/**
 * Read `claude agents --json`. A row carries either `status` (interactive
 * agents) or `state` (background agents); both are accepted, neither is
 * required — the CLI is another harness's surface and must not be able to
 * abort the whole directory.
 *
 * Fields per `claude agents --json`:
 *   {id?, pid?, cwd, kind, startedAt, sessionId, name, status?|state?}
 */
export interface ClaudeLaneRow {
	id?: string;
	sessionId: string;
	pid?: number;
	cwd?: string;
	name?: string;
	/** Interactive agents. */
	status?: string;
	/** Background agents. */
	state?: string;
	waitingFor?: string;
	kind?: string;
	startedAt?: number;
}

/**
 * How old a session file may be before the directory stops listing it at all
 * (a different question from the card's gone rule: this hides abandoned
 * sessions the directory has no card for). The card-heartbeat gone rule is
 * `isCardGone` in lib/lane-card.ts.
 */
export const DEFAULT_GONE_MINUTES = 60;
const DEFAULT_TAIL_BYTES = 256 * 1024;
const ONE_MINUTE_MS = 60_000;

function resolveHome(home: string | undefined): string {
	return home ?? process.env.HOME ?? homedir();
}

function defaultStateDir(home: string): string {
	return join(home, ".pi", "agent", "state");
}

function defaultSessionsRoot(home: string): string {
	return join(home, ".pi", "agent", "sessions");
}

/** Read the tail of a JSONL file (last ~tailBytes) without loading the whole file. */
function readTail(path: string, tailBytes: number): string | undefined {
	try {
		const size = statSync(path).size;
		if (size === 0) return "";
		const start = Math.max(0, size - tailBytes);
		const length = size - start;
		const fd = openSync(path, "r");
		try {
			const buffer = Buffer.allocUnsafe(length);
			let filled = 0;
			while (filled < length) {
				const read = readSync(fd, buffer, filled, length - filled, start + filled);
				if (read <= 0) break;
				filled += read;
			}
			return buffer.subarray(0, filled).toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return undefined;
	}
}

/** `/proc/<pid>/stat`: the command name, the parent pid, the state letter and the start time (clock ticks since boot), or undefined when the process is gone. */
export function readProcStat(pid: number): { comm: string; ppid: number; state: string; startTime: string | undefined } | undefined {
	try {
		const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
		// `pid (comm) S ppid …`: comm may hold spaces and parentheses, so cut at the last ")".
		const rest = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
		const ppid = Number(rest[1]);
		// Field 22 of the line, 19 places after the state letter (field 3).
		return rest[0] !== undefined && Number.isInteger(ppid) ? { comm: raw.slice(raw.indexOf("(") + 1, raw.lastIndexOf(")")), ppid, state: rest[0], startTime: /^\d+$/.test(rest[19] ?? "") ? rest[19] : undefined } : undefined;
	} catch {
		return undefined;
	}
}

/** Is the process there and not a zombie? The one pid-liveness check the lane tooling uses. */
export function procPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	const stat = readProcStat(pid);
	return stat !== undefined && stat.state !== "Z" && stat.state !== "X";
}

/** When the process started, as `/proc/<pid>/stat` counts it (a pid reused by another process has another start time). Undefined when it is gone. */
export function procStartTime(pid: number): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	return readProcStat(pid)?.startTime;
}

function procHasAgentEnv(pid: number): boolean {
	try {
		return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").some((entry) => entry.startsWith("CONCORD_AGENT_ID="));
	} catch {
		return false;
	}
}

function readTmuxPanes(): TmuxPane[] | undefined {
	try {
		const stdout = execFileSync("tmux", ["list-panes", "-a", "-F", "#{session_name}\t#{window_name}\t#{pane_dead}\t#{pane_pid}\t#{window_id}"], {
			encoding: "utf8",
			timeout: 3_000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const panes: TmuxPane[] = [];
		for (const line of stdout.split("\n")) {
			const [session, window, dead, pid, windowId] = line.split("\t");
			if (session === undefined || window === undefined || pid === undefined) continue;
			panes.push({ session, window, dead: dead === "1", pid: Number(pid), ...(windowId !== undefined && windowId !== "" ? { windowId } : {}) });
		}
		return panes;
	} catch (error) {
		// No server running is an answer (nothing is alive in tmux); a missing binary or a timeout is not.
		const stderr = String((error as { stderr?: unknown }).stderr ?? "");
		return /no server running|no sessions|error connecting to/i.test(stderr) ? [] : undefined;
	}
}

/** The Pi CLI as it appears in a process's argv: the bundled `cli.js` of the coding agent, or a `pi` binary. */
const PI_CLI_ARGV = /(^|\/)coding-agent\/dist\/(bundle\/)?cli\.js$/;

function readPiProcesses(): PiProcess[] {
	const out: PiProcess[] = [];
	let entries: string[];
	try {
		entries = readdirSync("/proc");
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		const pid = Number(entry);
		let argv: string[];
		try {
			argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
		} catch {
			continue;
		}
		const head = argv.slice(0, 4);
		if (!head.some((arg) => PI_CLI_ARGV.test(arg)) && basename(argv[0] ?? "") !== "pi") continue;
		// A process that carries a lane identity is a lane the launcher started, not an unenrolled session.
		if (procHasAgentEnv(pid)) continue;
		const lineage: number[] = [];
		for (let at: number | undefined = pid; at !== undefined && at > 1 && lineage.length < 64; at = readProcStat(at)?.ppid) lineage.push(at);
		const flag = argv.indexOf("--session-id");
		const sessionId = flag >= 0 ? argv[flag + 1] : undefined;
		out.push({ pid, lineage, ...(sessionId !== undefined && sessionId !== "" ? { sessionId } : {}) });
	}
	return out;
}

function readHermesUnits(): string[] {
	try {
		const stdout = execFileSync("systemctl", ["--user", "list-units", "hermes-*", "--type=service", "--state=active", "--no-legend", "--plain"], {
			encoding: "utf8",
			timeout: 3_000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return stdout.split("\n").map((line) => line.trim().split(/\s+/)[0] ?? "").filter((unit) => unit !== "");
	} catch {
		return [];
	}
}

/**
 * The active scope units of this user's systemd manager, the one read both the
 * directory liveness (below) and `lane-lifecycle-ports.ts`'s helper listing use.
 * A user manager that is missing, busy or refused reads as none: an answer of
 * "no scopes" never aborts the enumeration.
 */
export function readActiveScopeUnits(): string[] {
	try {
		const stdout = execFileSync("systemctl", ["--user", "list-units", "--type=scope", "--state=active", "--no-legend", "--plain", "--no-pager"], {
			encoding: "utf8",
			timeout: 3_000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return stdout.split("\n").map((line) => line.trim().split(/\s+/)[0] ?? "").filter((unit) => unit !== "");
	} catch {
		return [];
	}
}

/**
 * The units among `units` that are this lane's own launcher scopes: `lane-<lane>-<epoch>.scope`, the
 * lane id with every character outside `[A-Za-z0-9._-]` turned into `_` (the launcher's naming).
 */
export function laneScopeUnits(laneId: string, units: readonly string[]): string[] {
	const prefix = `lane-${laneId.replace(/[^A-Za-z0-9._-]/g, "_")}-`;
	return units.filter((unit) => unit.startsWith(prefix) && /^\d+\.scope$/.test(unit.slice(prefix.length)));
}

/** Does an active launcher scope of this lane exist right now? `units` is for a caller that already read the list. */
export function laneScopeAlive(laneId: string, units: readonly string[] = readActiveScopeUnits()): boolean {
	return laneScopeUnits(laneId, units).length > 0;
}

const REAL_EVIDENCE: LaneEvidence = {
	tmuxPanes: readTmuxPanes,
	pidAlive: procPidAlive,
	hasAgentEnv: procHasAgentEnv,
	piProcesses: readPiProcesses,
	hermesUnits: readHermesUnits,
	scopeUnits: readActiveScopeUnits,
};

/**
 * `PI_LANES_SYSTEM_EVIDENCE=off` reads nothing from the machine: an isolated install (a
 * temporary state dir under test) sees only its own cards, never the host's tmux, processes
 * or services.
 */
const NO_EVIDENCE: LaneEvidence = {
	tmuxPanes: () => [],
	pidAlive: () => false,
	hasAgentEnv: () => false,
	piProcesses: () => [],
	hermesUnits: () => [],
	scopeUnits: () => [],
};

/** What the directory reads from the machine: the real readers, or nothing at all under `PI_LANES_SYSTEM_EVIDENCE=off`. */
export function laneSystemEvidence(env: NodeJS.ProcessEnv = process.env): LaneEvidence {
	return env["PI_LANES_SYSTEM_EVIDENCE"] === "off" ? NO_EVIDENCE : REAL_EVIDENCE;
}

interface PiSessionDerivation {
	sessionId: string;
	cwd: string | null;
	startedAtMs: number | null;
	lastActivityMs: number | null;
	lastAssistant: { stopReason?: string; errorMessage?: string; timestampMs: number } | undefined;
	lastUserMs: number | null;
	latestModel: { provider: string; modelId: string } | undefined;
	latestThinking: string | undefined;
}

/** Parse the tail of a Pi session JSONL into enough evidence for a lane card. */
function derivePiSession(tail: string, sessionId: string): PiSessionDerivation {
	const out: PiSessionDerivation = {
		sessionId,
		cwd: null,
		startedAtMs: null,
		lastActivityMs: null,
		lastAssistant: undefined,
		lastUserMs: null,
		latestModel: undefined,
		latestThinking: undefined,
	};
	for (const raw of tail.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		let entry: { type?: string; timestamp?: string; cwd?: string; modelId?: string; provider?: string; message?: { role?: string; stopReason?: string; errorMessage?: string; timestamp?: number }; } | undefined;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (!entry || typeof entry !== "object") continue;
		const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : undefined;
		if (ts !== undefined && Number.isFinite(ts)) {
			if (out.startedAtMs === null || ts < out.startedAtMs) out.startedAtMs = ts;
			if (out.lastActivityMs === null || ts > out.lastActivityMs) out.lastActivityMs = ts;
		}
		if (entry.type === "session" && typeof entry.cwd === "string" && entry.cwd.trim().length > 0) {
			out.cwd = entry.cwd;
		}
		if (entry.type === "model_change" && typeof entry.modelId === "string") {
			out.latestModel = { provider: String(entry.provider ?? ""), modelId: entry.modelId };
		}
		if (entry.type === "message" && entry.message) {
			const role = entry.message.role;
			if (role === "user") {
				out.lastUserMs = ts ?? out.lastUserMs;
			}
			if (role === "assistant") {
				out.lastAssistant = {
					stopReason: entry.message.stopReason,
					errorMessage: entry.message.errorMessage,
					timestampMs: ts ?? 0,
				};
			}
		}
	}
	return out;
}

/**
 * The quota wall a lane's last assistant turn ended on, or null. The one reading of a wall
 * from a transcript: uncarded Pi sessions (`stateForPiSession`) and carded lanes of either
 * harness go through it, so no second list of wall wording exists.
 */
function wallOfLastTurn(last: PiSessionDerivation["lastAssistant"], shapes: readonly QuotaShape[], now: number): LaneWall | null {
	if (last === undefined || last.stopReason !== "error") return null;
	const cls = classifyQuota({ stopReason: last.stopReason, errorMessage: last.errorMessage ?? "" }, shapes, now);
	if (!cls.quota) return null;
	return {
		shapeId: cls.shapeId,
		...(cls.resetAt !== undefined ? { resetAt: cls.resetAt } : {}),
		...(cls.assumed === true ? { assumed: true } : {}),
	};
}

/**
 * Parse the tail of a Claude session JSONL: the timestamp of the last assistant turn and
 * whether that turn was an API error (`isApiErrorMessage`), read as the error text a Pi
 * transcript carries so one classifier serves both.
 */
function deriveClaudeSession(tail: string): { lastTurnMs: number | null; lastAssistant: PiSessionDerivation["lastAssistant"] } {
	let lastTurnMs: number | null = null;
	let lastAssistant: PiSessionDerivation["lastAssistant"];
	for (const raw of tail.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		let entry: { type?: string; timestamp?: string; isSidechain?: boolean; isApiErrorMessage?: boolean; message?: { content?: Array<{ type?: string; text?: string }>; stop_reason?: string } } | undefined;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (!entry || entry.type !== "assistant" || entry.isSidechain === true) continue;
		const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
		if (!Number.isFinite(ts)) continue;
		lastTurnMs = ts;
		const text = entry.message?.content?.find((block) => block?.type === "text")?.text;
		lastAssistant = entry.isApiErrorMessage === true
			? { stopReason: "error", errorMessage: text ?? "", timestampMs: ts }
			: { ...(entry.message?.stop_reason !== undefined ? { stopReason: entry.message.stop_reason } : {}), timestampMs: ts };
	}
	return { lastTurnMs, lastAssistant };
}

/** Pick the lane state from a derived Pi session. */
function stateForPiSession(d: PiSessionDerivation, opts: { now: number; stalledMin: number; goneMin: number; shapes: readonly QuotaShape[] }): { state: LaneState; since: number | null; wall: LaneWall | null } {
	const last = d.lastActivityMs ?? 0;
	if (last > 0 && opts.now - last > opts.goneMin * ONE_MINUTE_MS) {
		return { state: "gone", since: d.lastActivityMs, wall: null };
	}
	const wall = wallOfLastTurn(d.lastAssistant, opts.shapes, opts.now);
	if (wall !== null) return { state: "quota-walled", since: d.lastAssistant?.timestampMs || null, wall };
	if (last > 0 && opts.now - last > opts.stalledMin * ONE_MINUTE_MS) {
		return { state: "stalled", since: d.lastActivityMs, wall: null };
	}
	// Heuristic: a Pi session is `running` when its most recent assistant turn
	// arrived after the most recent user turn (the agent is still iterating);
	// `idle` when the user spoke last or no recent activity at all.
	const assistantAfterUser = d.lastAssistant !== undefined && (d.lastAssistant.timestampMs >= (d.lastUserMs ?? 0));
	if (assistantAfterUser) return { state: "running", since: d.lastAssistant.timestampMs || null, wall: null };
	return { state: "idle", since: d.lastUserMs ?? d.lastActivityMs, wall: null };
}

/** Enumerate Pi session JSONLs under `sessionsRoot` whose last event is within `goneMinutes`. */
function listPiSessionFiles(root: string, nowMs: number, goneMinutes: number): string[] {
	if (!existsSync(root)) return [];
	const out: string[] = [];
	const deadline = nowMs - goneMinutes * ONE_MINUTE_MS;
	for (const dirent of readdirSync(root, { withFileTypes: true })) {
		if (!dirent.isDirectory()) continue;
		const sub = join(root, dirent.name);
		let sessionFiles: string[];
		try {
			sessionFiles = readdirSync(sub);
		} catch {
			continue;
		}
		for (const file of sessionFiles) {
			if (!file.endsWith(".jsonl")) continue;
			const full = join(sub, file);
			try {
				const mtime = statSync(full).mtimeMs;
				if (mtime >= deadline) out.push(full);
			} catch {
				continue;
			}
		}
	}
	return out;
}

/** A session id → file index of every Pi session JSONL, by the id in the file name (`<time>_<uuid>.jsonl`). No stat, no read. */
function indexPiSessionFiles(root: string): Map<string, string> {
	const index = new Map<string, string>();
	if (!existsSync(root)) return index;
	let dirs: Dirent[];
	try {
		dirs = readdirSync(root, { withFileTypes: true });
	} catch {
		return index;
	}
	for (const dirent of dirs) {
		if (!dirent.isDirectory()) continue;
		const sub = join(root, dirent.name);
		let files: string[];
		try {
			files = readdirSync(sub);
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.endsWith(".jsonl")) continue;
			const id = file.match(/_([0-9a-f-]{36})\.jsonl$/)?.[1];
			if (id !== undefined) index.set(id, join(sub, file));
		}
	}
	return index;
}

/** Claude Code names a project folder after the working directory: every character that is not a letter or digit becomes "-". */
export function claudeProjectFolder(cwd: string): string {
	return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** A session id (a Claude short id is not one) → the transcript path, or undefined. */
function claudeTranscript(root: string, cwd: string | null, sessionId: string): string | undefined {
	if (!/^[0-9a-f-]{36}$/.test(sessionId)) return undefined;
	const direct = cwd !== null && cwd !== "" ? join(root, claudeProjectFolder(cwd), `${sessionId}.jsonl`) : undefined;
	if (direct !== undefined && existsSync(direct)) return direct;
	// A session resumed from another directory keeps its id and lives under the folder it was started in.
	try {
		for (const dirent of readdirSync(root, { withFileTypes: true })) {
			if (!dirent.isDirectory()) continue;
			const candidate = join(root, dirent.name, `${sessionId}.jsonl`);
			if (existsSync(candidate)) return candidate;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

/** A Claude session name that is a lane id (`orchestrator`, `cc-be`), not free text. */
export const CLAUDE_LANE_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

/** Read `claude agents --json` from disk or a fixture override. */
export function readClaudeAgentsJson(source: { home?: string; cliOverride?: { stdout: string } }): ClaudeLaneRow[] {
	const override = source.cliOverride;
	if (override) {
		try {
			const parsed = JSON.parse(override.stdout);
			return Array.isArray(parsed) ? (parsed as ClaudeLaneRow[]) : [];
		} catch {
			return [];
		}
	}
	try {
		const stdout = execFileSync("claude", ["agents", "--json"], {
			encoding: "utf8",
			env: withoutSeatCredential({ ...process.env, HOME: source.home ?? process.env.HOME ?? homedir() }),
			timeout: 5_000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const parsed = JSON.parse(stdout);
		return Array.isArray(parsed) ? (parsed as ClaudeLaneRow[]) : [];
	} catch {
		return [];
	}
}

/**
 * A card's wall field as the shared LaneWall shape. A legacy card that wrote
 * the shape id as a bare string still renders as its id (never an object).
 */
function normalizeWall(raw: unknown): LaneWall | null {
	if (typeof raw === "string" && raw !== "") return { shapeId: raw };
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const wall = raw as Partial<LaneWall>;
	if (typeof wall.shapeId !== "string" || wall.shapeId === "") return null;
	return {
		shapeId: wall.shapeId,
		...(typeof wall.resetAt === "number" ? { resetAt: wall.resetAt } : {}),
		...(wall.assumed === true ? { assumed: true } : {}),
	};
}

/**
 * The state a Claude lane stands for. `claude agents` is the lane's liveness, but its `status` stays
 * `busy` for as long as the session has any background task, and every bus lane has one: its
 * `muster wait --inbox` (LD10). A lane that ended its turn and waits there reads `status: busy` for
 * hours, with `state: done` or, for a short last message, `state: working` (measured 2026-10-18:
 * rsmoke2 and lc16daemon `busy/done`, a lab lane `busy/working` 20 s after its Stop; their cards
 * were idle, written by the Stop hook). So `muster lanes` showed every waiting Claude lane as
 * `running`, and the idle gate of the send path and of the rehearsal's Claude leg never held.
 * A `busy` status therefore yields to what says the turn is over: the CLI's own turn state
 * (`done` idle, `blocked` waiting, the order `isClaudeRowIdle` uses) and the card the hook boundary
 * writes at each Stop (`idle`, `waiting`, `blocked`); the hook rewrites it to `running` at the
 * next tool boundary of a woken turn. The earlier rule, `status` alone, dates from before the
 * hook wrote a card at every Stop (check 1, 2026-10-08). Liveness stays the CLI's: this function
 * is only called for a listed session.
 */
export function claudeRowState(row: Pick<ClaudeLaneRow, "status" | "state">, cardState?: LaneState): LaneState {
	const fromStatus = stateFromClaudeStatus(row.status ?? row.state);
	if (fromStatus !== "running") return fromStatus;
	const turn = typeof row.state === "string" ? row.state.toLowerCase() : "";
	if (turn === "done") return "idle";
	if (turn === "blocked") return "waiting";
	return cardState === "idle" || cardState === "waiting" || cardState === "blocked" ? cardState : fromStatus;
}

export function stateFromClaudeStatus(status: unknown): LaneState {
	// A listed agent exists even when neither field names its state; the
	// mapping's unknown default is the honest answer, not a guess at `gone`.
	if (typeof status !== "string") return "idle";
	const s = status.toLowerCase();
	if (s === "busy" || s === "running" || s === "working") return "running";
	if (s === "waiting" || s === "blocked") return "waiting";
	if (s === "stalled" || s === "stall") return "stalled";
	if (s === "idle" || s === "ready") return "idle";
	if (s === "gone" || s === "dead") return "gone";
	if (s === "quota-walled" || s === "quota_walled") return "quota-walled";
	return "idle";
}

/**
 * The `claude agents` row a lane name stands for. A name wins over a session id
 * (check 1: a Claude lane is listed by its name), and a row with no name is
 * matched by its id or session id so a card written for it still finds it.
 */
export function findClaudeRow(rows: readonly ClaudeLaneRow[], laneId: string, sessionId?: string): ClaudeLaneRow | undefined {
	return rows.find((row) => row.sessionId && ((typeof row.name === "string" && row.name.trim() === laneId) || row.sessionId === sessionId || row.id === laneId));
}

/**
 * Has this background session ended its turn? `claude agents --json` says
 * `status: "idle"` with `state: "done"` for a finished run and `state: "blocked"`
 * for one waiting on an answer; a working run says `busy` / `working`. An idle
 * session reaches no tool boundary, so no hook can deliver to it until it is
 * resumed. A row with no background `id` (an interactive session) is never idle
 * in this sense: there is no handle to resume it by.
 */
export function isClaudeRowIdle(row: ClaudeLaneRow, job?: ClaudeJobActivity, nowMs: number = Date.now()): boolean {
	if (typeof row.id !== "string" || row.id.trim() === "") return false;
	const status = typeof row.status === "string" ? row.status.toLowerCase() : "";
	const state = typeof row.state === "string" ? row.state.toLowerCase() : "";
	// The turn state wins: a lane whose turn is done or blocked keeps a stale `busy` status for minutes.
	if (state === "done" || state === "blocked") return true;
	if (status === "busy" || status === "running" || state === "running") return false;
	if (state === "working") return status === "idle" && hasEndedTurn(job, nowMs);
	return status === "idle";
}

/** What the daemon's job record says about a lane's activity (`state.json`: `tempo`, `updatedAt`, `inFlight.tasks`). */
export interface ClaudeJobActivity {
	tempo?: string;
	/** `updatedAt` of the record, in epoch ms. */
	updatedAtMs?: number;
	inFlightTasks?: number;
}

/**
 * How long a job record must stand unchanged before `status: "idle"` with
 * `state: "working"` counts as an ended turn. Claude Code writes that record once,
 * when it classifies the turn's last message, up to ~3 s before the turn's Stop
 * hooks finish (measured 2026-10-09: sn-ints turn end 12:10:52.9, record 12:10:50.3;
 * the slowest Stop hook took 2.5 s), so 15 s is five times the longest window.
 */
export const ENDED_TURN_QUIET_MS = 15_000;

/**
 * Claude Code's end-of-turn classifier (2.1.295) falls through to `state:
 * "working", tempo: "idle"` when the last message matches no done, blocked or
 * failed pattern, and never rewrites the record. `claude agents` reports the live
 * process as `idle` only when no turn runs and no background task is in flight, so
 * `idle` + `working` is a finished turn once the job record agrees: tempo idle,
 * nothing in flight and no write inside the quiet window.
 */
function hasEndedTurn(job: ClaudeJobActivity | undefined, nowMs: number): boolean {
	if (job?.tempo !== "idle" || job.updatedAtMs === undefined) return false;
	if ((job.inFlightTasks ?? 0) > 0) return false;
	return nowMs - job.updatedAtMs >= ENDED_TURN_QUIET_MS;
}

/** Top-level enumerator. */
export function enumerateLanes(opts: LaneDirectoryOptions = {}): LaneCard[] {
	const home = resolveHome(opts.home);
	const stateDir = opts.stateDir ?? defaultStateDir(home);
	const sessionsRoot = opts.sessionsRoot ?? defaultSessionsRoot(home);
	const cardsDir = opts.laneCardsDir ?? join(stateDir, "muster", "lanes");
	// The launcher's registry is what turns a session id into a lane name (check 1:
	// `pi-be-g3`, never a session UUID). Written by scripts/pi-lane-launch.sh.
	const sessionToLane = readLaneRegistry(opts.laneRegistryPath ?? join(stateDir, "pi-lanes.json"), dirname(cardsDir));
	const cardSources = cardSourcesFor(cardsDir, dirname(cardsDir));
	// One stalled rule for writer and reader: the env-aware threshold, with the
	// per-call override for the CLI flags.
	const stalledMin = opts.stalledMinutes ?? stalledThresholdMs() / ONE_MINUTE_MS;
	const goneMin = opts.goneMinutes ?? DEFAULT_GONE_MINUTES;
	const tailBytes = opts.deriveTailBytes ?? DEFAULT_TAIL_BYTES;
	const now = opts.nowMs ?? Date.now();
	const poolPath = opts.poolConfigPath ?? join(home, ".pi", "agent", "provider-pool.json");
	let shapes: readonly QuotaShape[] = [];
	try {
		const pool = loadPoolConfig(poolPath);
		if (pool.ok) shapes = pool.config.quotaShapes;
	} catch {
		shapes = [];
	}

	const evidence: LaneEvidence = { ...laneSystemEvidence(), ...opts.evidence };
	const claudeProjectsRoot = opts.claudeProjectsRoot ?? join(home, ".claude", "projects");
	// The lane records sit beside the cards (`<Muster state dir>/lifecycle`); a card dir override moves both.
	const records = new Map<string, LaneRecord>(listLaneRecords(dirname(cardsDir)).map((record) => [record.laneId, record]));
	const registryLanes = new Set(sessionToLane.values());
	// tmux is read once per call, and only when a row needs it.
	let panes: TmuxPane[] | undefined;
	let panesRead = false;
	const tmuxPanes = (): TmuxPane[] | undefined => {
		if (!panesRead) {
			panes = evidence.tmuxPanes();
			panesRead = true;
		}
		return panes;
	};
	let piIndex: Map<string, string> | undefined;
	const piSessionFile = (sessionId: string): string | undefined => (piIndex ??= indexPiSessionFiles(sessionsRoot)).get(sessionId);

	/** Pi and OpenCode: a lane is up when its window exists in its harness's tmux session and the pane is not dead. */
	const tmuxLiveness = (laneId: string, harness: LaneHarness): Pick<LaneCard, "alive" | "aliveVia"> => {
		if (harness !== "pi" && harness !== "opencode") return { aliveVia: "none" };
		const rows = tmuxPanes();
		if (rows === undefined) return { aliveVia: "none" };
		const session = tmuxSessionForHarness(harness) ?? "pi";
		return { alive: rows.some((pane) => pane.session === session && pane.window === laneId && !pane.dead), aliveVia: "tmux" };
	};
	/** Claude: a listed row is up only when its pid is in /proc (a listed row with a dead pid is a dead lane). */
	const claudeLiveness = (row: ClaudeLaneRow | undefined): Pick<LaneCard, "alive" | "aliveVia"> => {
		if (row === undefined || typeof row.pid !== "number") return { alive: false, aliveVia: "claude-agents" };
		return evidence.pidAlive(row.pid) ? { alive: true, aliveVia: "claude-agents" } : { alive: false, aliveVia: "pid" };
	};

	// The launcher's own scope units, read once (VR21-42 S4). pi-lane-launch.sh names each lane's
	// `lane-<lane>-<epoch>.scope` after the lane id with every character outside
	// `[A-Za-z0-9._-]` turned into `_`, and lane-adopt-cgroup.sh copies that naming, so the active
	// units that share a name's prefix say the lane's process tree still runs.
	const scopeUnits = evidence.scopeUnits?.() ?? [];
	const laneOwnScopeUnits = (laneId: string): string[] => laneScopeUnits(laneId, scopeUnits);
	/**
	 * A live scope is the strongest liveness answer the launcher gives (VR21-42 S4): a lane whose
	 * cgroup holds processes is up, however quiet its transcript, however stale its card. None of
	 * this overrides a real dead answer — it only lifts the `gone` a silent surface forces.
	 */
	const scopeLiveness = (laneId: string): Pick<LaneCard, "alive" | "aliveVia"> | undefined =>
		laneOwnScopeUnits(laneId).length > 0 ? { alive: true, aliveVia: "systemd" } : undefined;
	/** The evidence's own liveness, with the scope lifting it only when that evidence says not-alive. */
	const mergedLiveness = (laneId: string, own: Pick<LaneCard, "alive" | "aliveVia">): Pick<LaneCard, "alive" | "aliveVia"> =>
		own.alive === true ? own : scopeLiveness(laneId) ?? own;
	/**
	 * A row is `auto` when the launcher itself names it: a `pi-lanes.json` row, a lifecycle record, a
	 * `claude agents` job, or a process started in the launcher's environment. A card alone is not launch
	 * evidence (LD2): the session writes its own card, so the operator's own Pi session has one and its presence
	 * says nothing about who started the lane (2026-10-22, preflight 3 counted his session as a worker).
	 */
	const originOf = (laneId: string, namedByLauncher: boolean, pid?: number): LaneOrigin =>
		namedByLauncher || registryLanes.has(laneId) || records.has(laneId) || (pid !== undefined && evidence.hasAgentEnv(pid)) ? "auto" : "operator";
	/** The last transcript turn of a carded or listed lane, and the quota wall its last turn ended on. */
	const readTurn = (harness: LaneHarness, sessionId: string | undefined, cwd: string | null): { lastTurnAt: number | null; wall: LaneWall | null } => {
		const none = { lastTurnAt: null, wall: null };
		if (sessionId === undefined || sessionId === "") return none;
		const path = harness === "pi" ? piSessionFile(sessionId) : harness === "claude" ? claudeTranscript(claudeProjectsRoot, cwd, sessionId) : undefined;
		if (path === undefined) return none;
		const tail = readTail(path, tailBytes);
		if (tail === undefined) return none;
		if (harness === "pi") {
			const d = derivePiSession(tail, sessionId);
			return { lastTurnAt: d.lastActivityMs, wall: wallOfLastTurn(d.lastAssistant, shapes, now) };
		}
		const c = deriveClaudeSession(tail);
		return { lastTurnAt: c.lastTurnMs, wall: wallOfLastTurn(c.lastAssistant, shapes, now) };
	};

	const out: LaneCard[] = [];
	const seenLaneIds = new Set<string>();
	const claudeRows = opts.skipClaude ? [] : readClaudeAgentsJson({ home, cliOverride: opts.claudeAgentsOverride });
	/** Session ids a card already covers, so one physical lane is one row (F4). */
	const cardSessionIds = new Set<string>();

	// 1. Cards win on state/since/branch when present. The reader — not the
	//    writer — concludes `gone` from the heartbeat (F3): a crashed lane
	//    never writes a farewell card, so its last state must expire.
	if (cardSources.length > 0) {
		for (const source of cardSources) {
			const laneId = source.laneId;
			try {
				const raw = source.read();
				// A 0-byte or unreadable card is a stale leftover, not a lane: it is
				// skipped here, and the lane still appears through `pi-lanes.json` /
				// its session file (never a crash, 2026-10-08).
				if (raw.trim() === "") continue;
				const parsed = JSON.parse(raw) as Partial<LaneCard> & { harness?: string; state?: LaneState; since?: number };
				const updatedAt = typeof parsed.updatedAt === "number" ? parsed.updatedAt : null;
				const harness = (parsed.harness as LaneHarness) ?? "unknown";
				// A Claude lane has no heartbeat writer: `claude agents` is its liveness
				// and state (its turn state and the card's idle over a `busy` status held by a
				// background wait, `claudeRowState`), and the card only holds what the CLI cannot (the lane's
				// last report, its control outcome, how to reach it).
				const liveClaude = harness === "claude" ? findClaudeRow(claudeRows, laneId, parsed.sessionId) : undefined;
				const cwd = liveClaude?.cwd ?? parsed.cwd ?? null;
				const cardState: LaneState = liveClaude !== undefined ? claudeRowState(liveClaude, parsed.state) : isCardGone(updatedAt, now) ? "gone" : parsed.state ?? "gone";
				const liveness = mergedLiveness(laneId, harness === "claude" ? claudeLiveness(liveClaude) : tmuxLiveness(laneId, harness));
				const cardWall = normalizeWall(parsed.wall);
				// The transcript says when the lane last took a turn and whether that turn hit a wall.
				const turn = readTurn(harness, parsed.sessionId, cwd);
				const walled = cardWall === null && turn.wall !== null && cardState !== "gone";
				const liveScope = liveness.alive === true && liveness.aliveVia === "systemd";
				const card: LaneCard = {
					laneId,
					harness,
					cwd,
					branch: parsed.branch ?? null,
					// A live scope lifts the gone a silent heartbeat expires into (VR21-42 S4); the
					// row then says `idle`, the same answer a live process without turn evidence gets.
					state: walled ? "quota-walled" : cardState === "gone" && liveScope ? "idle" : cardState,
					model: parsed.model ?? null,
					thinking: parsed.thinking ?? null,
					since: typeof liveClaude?.startedAt === "number" ? liveClaude.startedAt : parsed.since ?? null,
					// A Claude lane is read from `claude agents` right now, so it was seen alive now (check 1).
					updatedAt: liveClaude !== undefined ? now : updatedAt,
					wall: walled ? turn.wall : cardWall,
					...(parsed.sessionId !== undefined ? { sessionId: parsed.sessionId } : {}),
					...(typeof parsed.endpoint === "string" ? { endpoint: parsed.endpoint } : {}),
					...(typeof parsed.pendingIn === "number" ? { pendingIn: parsed.pendingIn } : {}),
					// The card's own record survives into the directory: the mission
					// table renders the last report and the context percentage, and
					// `muster wait --lanes` fires on a report — all three read the
					// directory, not the card file (found live, check 3/4, 2026-10-08).
					...(typeof parsed.contextPercent === "number" ? { contextPercent: parsed.contextPercent } : {}),
					...(isLaneReportMark(parsed.lastReport) ? { lastReport: parsed.lastReport } : {}),
					...(typeof parsed.lastMessage === "string" ? { lastMessage: parsed.lastMessage } : {}),
					...(isLaneControlOutcome(parsed.lastControl) ? { lastControl: parsed.lastControl } : {}),
					authoritative: true,
					// The last transcript turn (audit a2). A lane with no readable transcript keeps what its card says.
					lastActivityMs: turn.lastTurnAt ?? parsed.lastActivityMs ?? parsed.since ?? null,
					lastTurnAt: turn.lastTurnAt,
					// The heartbeat proves the process is up, not that the lane did anything (audit a2):
					// it is carried as `heartbeatAt` and never stands in for the last turn.
					heartbeatAt: liveClaude !== undefined ? now : updatedAt,
					// The card is the session's own heartbeat, never proof of a launch: a Claude job the harness
					// lists is the launcher's surface, and every other lane is named below by its own evidence.
					origin: originOf(laneId, liveClaude !== undefined),
					...liveness,
				};
				if (typeof card.sessionId === "string" && card.sessionId !== "") cardSessionIds.add(card.sessionId);
				out.push(card);
				seenLaneIds.add(laneId);
			} catch {
				// One bad card must not abort the whole enumeration.
				continue;
			}
		}
	}

	// 2. Pi session JSONLs — a lane name when the registry knows the session, and
	//    only when it is a lane at all (see includeUnregisteredSessions).
	const piFiles = listPiSessionFiles(sessionsRoot, now, goneMin);
	for (const full of piFiles) {
		const fileBase = basename(full, ".jsonl");
		const sessionUuid = fileBase.match(/_([0-9a-f-]{36})/)?.[1];
		const laneName = sessionUuid !== undefined ? sessionToLane.get(sessionUuid) : undefined;
		if (laneName === undefined && !opts.includeUnregisteredSessions) continue;
		const laneId = laneName ?? sessionUuid ?? fileBase;
		if (seenLaneIds.has(laneId)) continue;
		if (cardSessionIds.has(laneId)) continue;
		const tail = readTail(full, tailBytes);
		if (tail === undefined) continue;
		const d = derivePiSession(tail, laneId);
		const st = stateForPiSession(d, { now, stalledMin, goneMin, shapes });
		const liveness = mergedLiveness(laneId, tmuxLiveness(laneId, "pi"));
		const card: LaneCard = {
			laneId,
			harness: "pi",
			cwd: d.cwd,
			branch: null,
			// A live scope lifts the gone a quiet transcript expires into (VR21-42 S4).
			state: st.state === "gone" && liveness.aliveVia === "systemd" ? "idle" : st.state,
			model: d.latestModel ? (d.latestModel.provider ? `${d.latestModel.provider}/${d.latestModel.modelId}` : d.latestModel.modelId) : null,
			thinking: d.latestThinking ?? null,
			since: d.lastActivityMs,
			// A session file is not a card: no heartbeat to expire.
			updatedAt: null,
			wall: st.wall,
			authoritative: false,
			lastActivityMs: d.lastActivityMs,
			lastTurnAt: d.lastActivityMs,
			origin: originOf(laneId, false),
			...liveness,
		};
		out.push(card);
		seenLaneIds.add(laneId);
	}

	// 3. Claude lanes from `claude agents --json`.
	if (!opts.skipClaude) {
		for (const row of claudeRows) {
			if (!row.sessionId) continue;
			// Check 1: a Claude lane is listed by its name (`orchestrator`, `cc-be`),
			// not by a session UUID — `claude attach <name>` is what opens it.
			const name = typeof row.name === "string" ? row.name.trim() : "";
			const named = CLAUDE_LANE_NAME.test(name);
			let laneId = name !== "" ? name : (typeof row.id === "string" && row.id.trim() !== "" ? row.id.trim() : row.sessionId);
			const liveness = claudeLiveness(row);
			const origin = originOf(laneId, false, row.pid);
			// A live interactive session nobody enrolled is the operator's own (LD2): it is listed, under a stable name.
			const unenrolled = row.kind === "interactive" && !named && liveness.alive === true && origin === "operator";
			if (unenrolled) laneId = `operator:claude:${row.sessionId.slice(0, 8)}`;
			if (seenLaneIds.has(laneId) || seenLaneIds.has(row.sessionId) || cardSessionIds.has(row.sessionId)) continue;
			// An auto-named session ("acme-realty real estate agency OS") is not a lane: a lane
			// name is an id. `muster lanes --all` still shows those (check 1).
			if (!named && !unenrolled && !opts.includeUnregisteredSessions) continue;
			const cardState = claudeRowState(row);
			const turn = readTurn("claude", row.sessionId, row.cwd ?? null);
			const walled = turn.wall !== null && cardState !== "gone";
			out.push({
				laneId,
				harness: "claude",
				cwd: row.cwd ?? null,
				branch: null,
				state: walled ? "quota-walled" : cardState,
				model: null,
				thinking: null,
				since: typeof row.startedAt === "number" ? row.startedAt : null,
				updatedAt: now,
				wall: walled ? turn.wall : null,
				authoritative: true,
				lastActivityMs: turn.lastTurnAt ?? (typeof row.startedAt === "number" ? row.startedAt : null),
				lastTurnAt: turn.lastTurnAt,
				origin,
				...liveness,
			});
			seenLaneIds.add(laneId);
			seenLaneIds.add(row.sessionId);
		}
	}

	// 4. Unenrolled Pi processes outside the lane session, and active Hermes services (LD2). All `operator`.
	const lanePanes = tmuxPanes();
	if (lanePanes !== undefined) {
		const lanePanePids = new Set(lanePanes.filter((pane) => pane.session === (tmuxSessionForHarness("pi") ?? "pi")).map((pane) => pane.pid));
		for (const proc of evidence.piProcesses()) {
			if (proc.lineage.some((pid) => lanePanePids.has(pid))) continue;
			const laneId = `operator:pi:${proc.sessionId !== undefined ? proc.sessionId.slice(0, 8) : String(proc.pid)}`;
			if (seenLaneIds.has(laneId)) continue;
			const file = proc.sessionId !== undefined ? piSessionFile(proc.sessionId) : undefined;
			const tail = file !== undefined ? readTail(file, tailBytes) : undefined;
			const d = tail !== undefined && proc.sessionId !== undefined ? derivePiSession(tail, proc.sessionId) : undefined;
			const st = d !== undefined ? stateForPiSession(d, { now, stalledMin, goneMin, shapes }) : undefined;
			out.push({
				laneId,
				harness: "pi",
				cwd: d?.cwd ?? null,
				branch: null,
				// A live process is not gone, however quiet its transcript is.
				state: st === undefined || st.state === "gone" ? "idle" : st.state,
				model: d?.latestModel ? (d.latestModel.provider ? `${d.latestModel.provider}/${d.latestModel.modelId}` : d.latestModel.modelId) : null,
				thinking: null,
				since: d?.lastActivityMs ?? null,
				updatedAt: null,
				wall: st?.wall ?? null,
				authoritative: false,
				lastActivityMs: d?.lastActivityMs ?? null,
				lastTurnAt: d?.lastActivityMs ?? null,
				origin: "operator",
				alive: true,
				aliveVia: "pid",
				...(proc.sessionId !== undefined ? { sessionId: proc.sessionId } : {}),
			});
			seenLaneIds.add(laneId);
		}
	}
	for (const unit of evidence.hermesUnits()) {
		const laneId = `operator:hermes:${unit.replace(/\.service$/, "")}`;
		if (seenLaneIds.has(laneId)) continue;
		out.push({
			laneId,
			harness: "unknown",
			cwd: null,
			branch: null,
			state: "running",
			model: null,
			thinking: null,
			since: null,
			updatedAt: null,
			wall: null,
			authoritative: false,
			lastActivityMs: null,
			lastTurnAt: null,
			origin: "operator",
			alive: true,
			aliveVia: "systemd",
		});
		seenLaneIds.add(laneId);
	}

	// 5. A lane record with no card is a lane whose process is gone (parked, closed, died): it stays
	//    visible with its phase and last report, so a parked question is not lost with the process.
	//    An active `lane-<lane>-*.scope` under its own name says the opposite — the process tree is
	//    still running, so the row reads as a live one, not `gone` (VR21-42 S4).
	for (const record of records.values()) {
		if (seenLaneIds.has(record.laneId)) continue;
		if (record.sessionId !== undefined && cardSessionIds.has(record.sessionId)) continue;
		const liveness = scopeLiveness(record.laneId);
		out.push({
			laneId: record.laneId,
			harness: record.harness,
			cwd: record.cwd,
			branch: record.branch,
			state: liveness !== undefined ? "idle" : "gone",
			model: null,
			thinking: null,
			since: record.phaseSince,
			updatedAt: null,
			wall: null,
			authoritative: false,
			lastActivityMs: null,
			lastTurnAt: null,
			origin: "auto",
			...(liveness ?? { alive: false, aliveVia: "none" }),
			phase: record.phase,
			...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
			...(record.lastReport !== undefined ? { lastReport: record.lastReport } : {}),
		});
		seenLaneIds.add(record.laneId);
	}

	// A row whose lane has a record carries the record's session chain (a resumed lane starts a new session).
	for (const row of out) {
		const chain = records.get(row.laneId)?.sessionChain;
		if (chain !== undefined && chain.length > 0) row.sessionChain = [...chain];
	}

	// Order: running first, then waiting/idle, then stalled/quota-walled, then gone; by since desc within.
	const order: Record<LaneState, number> = { running: 0, waiting: 1, idle: 2, stalled: 3, "quota-walled": 4, blocked: 5, gone: 6 };
	out.sort((a, b) => {
		const oa = order[a.state] ?? 9;
		const ob = order[b.state] ?? 9;
		if (oa !== ob) return oa - ob;
		return (b.since ?? 0) - (a.since ?? 0);
	});

	return out;
}

// ─── Seat assignment targets (LD36 SM2) ─────────────────────────────────────

/**
 * The harnesses a seat can be assigned to. The target resolver reads both
 * harnesses' session sources *before* the directory merges its rows, because
 * the merged `LaneCard` rows drop the session id and collapse shared ids
 * (seat-move review R1).
 */
export type SeatTargetHarness = "claude" | "pi";

/** One session row a source names, before the directory merges its rows. */
export interface SeatTargetRow {
	sessionId: string;
	harness: SeatTargetHarness;
	/** `true` when a source saw the session live, `false` when a source reports it dead, `undefined` when no source could tell. */
	alive: boolean | undefined;
	/** The lane id the directory gives this session — the inbox the target's waiter reads (seat-move review R2). */
	inbox: string;
}

export interface SeatTargetOptions {
	home?: string;
	/** The state dir holding `pi-lanes.json` (`~/.pi/agent/state` by default). */
	stateDir?: string;
	sessionsRoot?: string;
	laneRegistryPath?: string;
	/** How recent a Pi session JSONL must be for the session to be named at all. Default 60 minutes. */
	goneMinutes?: number;
	nowMs?: number;
	/** Skip spawning `claude agents --json` (tests). */
	skipClaude?: boolean;
	/** `claude agents --json` output override (tests only; avoids spawning the CLI). */
	claudeAgentsOverride?: { stdout: string };
	/** Process, tmux and systemd readers; tests replace them so no fixture reads the real machine. */
	evidence?: Partial<LaneEvidence>;
	/** Only disambiguates: it never widens a match. */
	harness?: SeatTargetHarness;
}

export type SeatTarget =
	| { ok: true; target: { sessionId: string; harness: SeatTargetHarness; alive: boolean | undefined; inbox: string } }
	| { ok: false; reason: string };

/**
 * Every session the sources name, one row per source sighting (two live
 * processes sharing a session id stay two rows, so the resolver can refuse
 * them). Writes nothing.
 */
function seatTargetRows(opts: SeatTargetOptions): SeatTargetRow[] {
	const home = resolveHome(opts.home);
	const stateDir = opts.stateDir ?? defaultStateDir(home);
	const sessionsRoot = opts.sessionsRoot ?? defaultSessionsRoot(home);
	const registryPath = opts.laneRegistryPath ?? join(stateDir, "pi-lanes.json");
	const sessionLane = new Map<string, string>();
	for (const [laneId, row] of readLaneRegistryRows(registryPath)) {
		if (row.sessionId !== undefined) sessionLane.set(row.sessionId, laneId);
	}
	const evidence: LaneEvidence = { ...laneSystemEvidence(), ...opts.evidence };
	const now = opts.nowMs ?? Date.now();
	const goneMin = opts.goneMinutes ?? DEFAULT_GONE_MINUTES;
	const rows: SeatTargetRow[] = [];

	// Claude: every `claude agents` row that carries a session id. A row without a
	// pid is one whose process the source itself cannot place — the same answer
	// `claudeLiveness` gives the merged cards (dead, via `claude-agents`).
	if (!opts.skipClaude) {
		for (const row of readClaudeAgentsJson({ home, cliOverride: opts.claudeAgentsOverride })) {
			if (!row.sessionId) continue;
			const name = typeof row.name === "string" ? row.name.trim() : "";
			const named = name !== "" && CLAUDE_LANE_NAME.test(name);
			const id = typeof row.id === "string" && row.id.trim() !== "" ? row.id.trim() : undefined;
			const inbox = named ? name : id ?? `operator:claude:${row.sessionId.slice(0, 8)}`;
			rows.push({ sessionId: row.sessionId, harness: "claude", alive: typeof row.pid === "number" ? evidence.pidAlive(row.pid) : false, inbox });
		}
	}

	// Pi: the process scan proves liveness first; a registered lane may also be
	// proven by its tmux window. When tmux cannot be read at all the answer is
	// unknown (`aliveVia: "none"` — accepted, and the reply says so).
	let panes: TmuxPane[] | undefined;
	let panesRead = false;
	const tmuxPanes = (): TmuxPane[] | undefined => {
		if (!panesRead) {
			panes = evidence.tmuxPanes();
			panesRead = true;
		}
		return panes;
	};
	const piAlive = (laneId: string, procAlive: boolean): boolean | undefined => {
		if (procAlive) return true;
		const list = tmuxPanes();
		if (list === undefined) return undefined;
		const session = tmuxSessionForHarness("pi") ?? "pi";
		return list.some((pane) => pane.session === session && pane.window === laneId && !pane.dead);
	};
	for (const proc of evidence.piProcesses()) {
		if (proc.sessionId === undefined) continue;
		const laneId = sessionLane.get(proc.sessionId) ?? `operator:pi:${proc.sessionId.slice(0, 8)}`;
		rows.push({ sessionId: proc.sessionId, harness: "pi", alive: piAlive(laneId, true), inbox: laneId });
	}
	// A recent session JSONL with no live process row: dead, unless a registered
	// lane's tmux window proves it or tmux is unreadable (unknown).
	const seen = new Set(rows.filter((row) => row.harness === "pi").map((row) => row.sessionId));
	for (const full of listPiSessionFiles(sessionsRoot, now, goneMin)) {
		const sessionId = basename(full, ".jsonl").match(/_([0-9a-f-]{36})/)?.[1];
		if (sessionId === undefined || seen.has(sessionId)) continue;
		seen.add(sessionId);
		const laneId = sessionLane.get(sessionId);
		rows.push({ sessionId, harness: "pi", alive: laneId !== undefined ? piAlive(laneId, false) : false, inbox: laneId ?? `operator:pi:${sessionId.slice(0, 8)}` });
	}
	return rows;
}

/**
 * Resolve the target of a seat assignment (LD36 SM2). The full session id or an
 * 8+ character prefix must match exactly one session the sources name. A match
 * the sources report dead is refused; a match whose liveness no source could
 * tell is accepted (`alive: undefined` — the caller's reply says so); a session
 * id two live rows share is refused. `--harness` only disambiguates.
 */
export function resolveSeatTarget(query: string, opts: SeatTargetOptions = {}): SeatTarget {
	const wanted = query.trim();
	if (wanted.length < 8) return { ok: false, reason: "a session id or its first 8+ characters is required" };
	const rows = seatTargetRows(opts).filter((row) => opts.harness === undefined || row.harness === opts.harness);
	const sessionIds = [...new Set(rows.filter((row) => row.sessionId.startsWith(wanted)).map((row) => row.sessionId))];
	if (sessionIds.length === 0) {
		return { ok: false, reason: opts.harness === undefined ? `no running session matches ${wanted}` : `no running ${opts.harness} session matches ${wanted}` };
	}
	if (sessionIds.length > 1) {
		return { ok: false, reason: `${sessionIds.length} sessions match ${wanted} (${sessionIds.map((id) => id.slice(0, 8)).join(", ")}); give more characters` };
	}
	const sessionId = sessionIds[0]!;
	const matches = rows.filter((row) => row.sessionId === sessionId);
	const live = matches.filter((row) => row.alive === true);
	if (live.length > 1) return { ok: false, reason: `session ${sessionId} is reported live by ${live.length} rows (two processes share it), so it cannot be addressed` };
	if (live.length === 1) return { ok: true, target: { sessionId, harness: live[0]!.harness, alive: true, inbox: live[0]!.inbox } };
	if (matches.length === 1) {
		const match = matches[0]!;
		if (match.alive === false) return { ok: false, reason: `session ${sessionId.slice(0, 8)} matches, but the sources report it dead` };
		return { ok: true, target: { sessionId, harness: match.harness, alive: undefined, inbox: match.inbox } };
	}
	// Several rows, none live: the one whose liveness no source could tell is the honest answer.
	const unknown = matches.filter((row) => row.alive === undefined);
	if (unknown.length === 1) return { ok: true, target: { sessionId, harness: unknown[0]!.harness, alive: undefined, inbox: unknown[0]!.inbox } };
	return { ok: false, reason: `session ${sessionId.slice(0, 8)} matches, but no source reports it live` };
}

/**
 * The card sources one enumeration reads: the ledger's `lane-card` records when
 * the switch names the ledger, else the files of `lanes/` (today's store,
 * unchanged). Each source reads lazily, so a torn file is skipped inside the
 * existing try exactly as before.
 */
function cardSourcesFor(cardsDir: string, musterDir: string): { laneId: string; read: () => string }[] {
	if (readBackend(musterDir) === "ledger") {
		return listLaneCards(musterDir).map(({ laneId, card }) => ({ laneId, read: () => JSON.stringify(card) }));
	}
	if (!existsSync(cardsDir)) return [];
	const sources: { laneId: string; read: () => string }[] = [];
	for (const entry of readdirSync(cardsDir)) {
		if (!entry.endsWith(".json")) continue;
		const full = join(cardsDir, entry);
		sources.push({ laneId: entry.slice(0, -".json".length), read: () => readFileSync(full, "utf8") });
	}
	return sources;
}

/**
 * Read the launcher's lane registry: `{ "pi-be-g3": "<session uuid>", ... }`.
 * Returns session id → lane id. A missing, empty or malformed file is "no
 * registry", never an error: the directory must keep working without it.
 */
export function readLaneRegistry(path: string, musterStateDir?: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const [lane, row] of readLaneRegistryRows(path, musterStateDir)) {
		if (row.sessionId !== undefined) map.set(row.sessionId, lane);
	}
	return map;
}

/** One registry row: the session the lane runs, its harness and whether it was retired. */
export type LaneRegistryRow = { sessionId?: string; harness?: string; retired?: boolean };
/**
 * The launcher's registry rows by lane id: the session id and the harness when the row carries them.
 * Two row shapes, one at a time: a bare session id (what the launch recipe wrote before 2026-10-08) or an
 * object carrying it beside the lane's harness and retirement (`{sessionId, harness, retired?}`, what it
 * writes now). A retired row is still a row: this reader keeps it — `muster lanes` shows the lane as gone —
 * and night-watch is the reader that skips it. A missing or unreadable file is an empty map.
 *
 * In ledger mode (`musterStateDir` given and the switch naming the ledger) the rows come from the
 * `lane-registry` store instead of the file (LC5): the launcher's `pi-lanes.json` is not read by
 * anything but its owner, so night-watch never opens the store's file itself (LC-D7).
 */
export function readLaneRegistryRows(path: string, musterStateDir?: string): Map<string, LaneRegistryRow> {
	if (musterStateDir !== undefined && readBackend(musterStateDir) === "ledger") {
		const map = new Map<string, LaneRegistryRow>();
		for (const row of laneRegistryStore(musterStateDir).list()) {
			const { revision: _revision, ...record } = row.record;
			map.set(row.id, record);
		}
		return map;
	}
	const map = new Map<string, LaneRegistryRow>();
	try {
		if (!existsSync(path)) return map;
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		for (const [lane, value] of Object.entries(parsed ?? {})) {
			if (value === undefined || value === null) continue;
			const object = typeof value === "object" ? (value as { sessionId?: unknown; harness?: unknown; retired?: unknown }) : undefined;
			const session = typeof value === "string" ? value : object?.sessionId;
			const harness = object?.harness;
			map.set(lane, {
				...(typeof session === "string" && session.trim() !== "" ? { sessionId: session.trim() } : {}),
				...(typeof harness === "string" ? { harness } : {}),
				...(typeof object?.retired === "boolean" ? { retired: object.retired } : {}),
			});
		}
	} catch {
		return map;
	}
	return map;
}

/**
 * A worker lane the bus started: not one of the operator's own sessions and not a seat (the architect and the
 * orchestrator). One predicate, no second copy (LD2): `origin` is `auto` only when the launcher's own
 * writes name the lane, so a session's own card is never a worker lane, and the architect's and
 * orchestrator's cards are never one whatever their origin says.
 */
export function isBusLane(row: LaneCard): boolean {
	return row.origin === "auto" && row.laneId !== "architect" && row.laneId !== "orchestrator" && !row.laneId.startsWith("operator:");
}

// ─── The registry's write side and its ledger store (LC5) ────────────────────
//
// One owner of the launcher's registry (LC5): `scripts/pi-lane-launch.sh` and the
// CLI write through here, and nothing writes the file itself. Files mode keeps the
// exact bytes the launcher's Python wrote (indent 1, trailing newline); ledger mode
// stores the same row in the `lane-registry` store.

/** The registry file for a Muster state dir: `PI_LANES_JSON` when set, else `<state parent>/pi-lanes.json`. */
export function laneRegistryPath(musterStateDir: string): string {
	const override = process.env["PI_LANES_JSON"]?.trim();
	return override !== undefined && override !== "" ? override : join(dirname(musterStateDir), "pi-lanes.json");
}

/** The owner's `CasStoreError` code set. */
export class LaneRegistryStateError extends Error {
	readonly code: "missing" | "malformed" | "conflict" | "io";
	constructor(code: "missing" | "malformed" | "conflict" | "io", message: string) {
		super(message);
		this.code = code;
		this.name = "LaneRegistryStateError";
	}
}

/** The ledger keeps its revision beside the row, never inside it (LC-D3). */
type StoredRegistryRow = LaneRegistryRow & { revision: number };

function validateStoredRegistryRow(raw: unknown): { ok: true; record: StoredRegistryRow } | { ok: false; errors: string[] } {
	const row = raw as (Record<string, unknown> & { revision?: unknown }) | null | undefined;
	if (row === null || row === undefined || typeof row !== "object" || Array.isArray(row)) return { ok: false, errors: ["not a registry row"] };
	if (row["sessionId"] !== undefined && typeof row["sessionId"] !== "string") return { ok: false, errors: ["sessionId must be a string"] };
	if (row["harness"] !== undefined && typeof row["harness"] !== "string") return { ok: false, errors: ["harness must be a string"] };
	if (row["retired"] !== undefined && typeof row["retired"] !== "boolean") return { ok: false, errors: ["retired must be a boolean"] };
	return { ok: true, record: { ...(row as LaneRegistryRow), revision: typeof row["revision"] === "number" ? row["revision"] : 0 } };
}

function laneRegistryStore(musterStateDir: string): LedgerCasStore<StoredRegistryRow> {
	return ledgerCasStore<StoredRegistryRow>(LANE_REGISTRY_STORE, ownerLedgerSocket(musterStateDir), {
		idPattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/,
		idKind: "lane",
		noun: "lane registry row",
		recordNoun: "row",
		validate: validateStoredRegistryRow,
		errorClass: LaneRegistryStateError,
	});
}

/**
 * Register a lane: merge `{ sessionId, harness }` into its row and drop its retirement, exactly as
 * `pi-lane-launch.sh`'s Python did (`merged = dict(row)`, set both fields, pop `retired`/`retiredAt`).
 * Files mode writes the same bytes (indent 1 and a trailing newline, by temporary name and rename).
 */
export function writeLaneRegistryRow(
	musterStateDir: string,
	laneId: string,
	row: { sessionId: string; harness: string },
): void {
	if (!SAFE_REGISTRY_LANE.test(laneId)) throw new LaneRegistryStateError("io", `invalid lane id: ${laneId}`);
	if (writeBackend(musterStateDir) === "ledger") {
		const store = laneRegistryStore(musterStateDir);
		for (let attempt = 0; ; attempt += 1) {
			const current = store.readWithRevision(laneId);
			const merged = mergeRegistryRow(current === undefined ? undefined : stripRegistryRevision(current.record), row);
			try {
				store.update(laneId, current?.revision, () => ({ ...merged, revision: current?.revision ?? 0 }));
				return;
			} catch (error) {
				if (!(error instanceof LaneRegistryStateError) || error.code !== "conflict" || attempt >= CAS_ATTEMPTS - 1) throw error;
			}
		}
	}
	const path = laneRegistryPath(musterStateDir);
	const data = readRegistryFileRaw(path);
	data[laneId] = mergeRegistryRow(typeof data[laneId] === "object" && data[laneId] !== null ? (data[laneId] as Record<string, unknown>) : undefined, row);
	writeRegistryFileRaw(path, data);
}

/** Remove one lane's row. Files mode deletes the key; the ledger empties the record, which no reader lists. */
export function removeLaneRegistryRow(musterStateDir: string, laneId: string): void {
	if (writeBackend(musterStateDir) === "ledger") {
		const store = laneRegistryStore(musterStateDir);
		for (let attempt = 0; ; attempt += 1) {
			const current = store.readWithRevision(laneId);
			if (current === undefined) return;
			const result = ledgerCommitRegistry(ownerLedgerSocket(musterStateDir), laneId, current.revision);
			if (result) return;
			if (attempt >= CAS_ATTEMPTS - 1) return;
		}
	}
	const path = laneRegistryPath(musterStateDir);
	const data = readRegistryFileRaw(path);
	if (!(laneId in data)) return;
	delete data[laneId];
	writeRegistryFileRaw(path, data);
}

/** The same shape as a lane id the launcher accepts; a registry key is never built from anything else. */
const SAFE_REGISTRY_LANE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

function stripRegistryRevision(row: StoredRegistryRow): Record<string, unknown> {
	const { revision: _revision, ...rest } = row;
	return rest as Record<string, unknown>;
}

function mergeRegistryRow(existing: Record<string, unknown> | undefined, row: { sessionId: string; harness: string }): LaneRegistryRow {
	const merged: Record<string, unknown> = { ...(existing ?? {}) };
	merged["sessionId"] = row.sessionId;
	merged["harness"] = row.harness;
	delete merged["retired"];
	delete merged["retiredAt"];
	return merged as LaneRegistryRow;
}

/** The file as the launcher's Python read it: an object, or an empty one when missing or unreadable. */
function readRegistryFileRaw(path: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** The exact bytes `pi-lane-launch.sh`'s Python wrote: `json.dump(data, handle, indent=1)` and a newline. */
function writeRegistryFileRaw(path: string, data: Record<string, unknown>): void {
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
}

/** Empty one registry record in the ledger; true when it committed. */
function ledgerCommitRegistry(socketPath: string, laneId: string, expectedRevision: number): boolean {
	return ledgerCommit(socketPath, {
		requestId: `remove:${LANE_REGISTRY_STORE}:${laneId}:${expectedRevision}`,
		cas: [{ store: LANE_REGISTRY_STORE, id: laneId, expectedRevision, record: null }],
	}).ok;
}

/** Human-readable table view — one row per lane, fixed column widths. */
export function formatLaneTable(cards: readonly LaneCard[], nowMs = Date.now()): string {
	if (cards.length === 0) return "no lanes visible (no card files, no registered lane sessions, no claude agents).";
	const age = (ms: number | null | undefined): string => {
		if (typeof ms !== "number" || ms <= 0) return "—";
		const seconds = Math.max(0, Math.round((nowMs - ms) / 1000));
		if (seconds < 60) return `${seconds}s`;
		if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
		return `${Math.round(seconds / 3600)}h`;
	};
	const rows: Array<[string, string, string, string, string, string, string]> = cards.map((c) => {
		// A quota wall is named by its shape id, never rendered as an object.
		const state = c.wall && c.state === "quota-walled" ? `${c.state} (${c.wall.shapeId})` : c.phase !== undefined && c.state === "gone" ? `${c.state} (${c.phase})` : c.state;
		const harness = c.harness;
		const cwd = c.cwd ? c.cwd.replace(process.env.HOME ?? "\u0000", "~") : "—";
		const model = c.model ?? "—";
		// Check 1: the card's heartbeat age is what proves a running lane is alive.
		const updated = age(c.updatedAt);
		const activity = age(c.lastActivityMs ?? c.since);
		const laneName = c.laneId.length > 24 ? c.laneId.slice(0, 24) + "…" : c.laneId;
		// the operator's own sessions are read-only on the bus (LD2): the table says so.
		const laneId = c.origin === "operator" ? `${laneName} [yours]` : laneName;
		return [laneId, state, harness, model, cwd, activity, updated];
	});
	const headerLabels = ["lane", "state", "harness", "model", "cwd", "activity", "updated"];
	const colWidths = headerLabels.map((label, i) => rows.reduce((w, r) => Math.max(w, r[i].length), label.length));
	const line = (parts: string[]): string => parts.map((p, i) => p.padEnd(colWidths[i])).join("  ");
	const lines: string[] = [line(headerLabels), line(colWidths.map((w) => "─".repeat(w)))];
	for (const r of rows) lines.push(line(r));
	return lines.join("\n");
}

/** JSON view — one line per lane, suitable for `--json`. */
export function formatLaneJson(cards: readonly LaneCard[]): string {
	return JSON.stringify(cards.map((c) => ({
		...c,
		since: c.since ?? null,
		lastActivityMs: c.lastActivityMs ?? null,
		wall: c.wall ?? null,
		authoritative: c.authoritative ?? false,
	})), null, 2);
}

// Test surface: the pure derivations, so tests can drive them without
// touching the filesystem or spawning the claude CLI.
export const _internal = {
	readTail,
	derivePiSession,
	deriveClaudeSession,
	stateForPiSession,
	stateFromClaudeStatus,
	listPiSessionFiles,
	readLaneRegistry,
	DEFAULT_GONE_MINUTES,
	DEFAULT_TAIL_BYTES,
	ONE_MINUTE_MS,
};

// Silence "noUnusedLocals" — these are intentional exports for the test surface.
export type { PiSessionDerivation };