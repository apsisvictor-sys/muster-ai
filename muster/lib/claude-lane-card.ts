/**
 * Claude Code lane cards.
 *
 * A Claude lane (`claude --bg --name <lane>`) runs no heartbeat, so its card is
 * not live state: `claude agents --json` is (lane-directory.ts overlays it on
 * the card). The card exists so the lane has somewhere to keep what the CLI
 * cannot: its last report (`muster report`), its control outcome and how to
 * reach it. It is created on first need, by the verb that needs it, and the
 * fields another writer put on it are kept.
 *
 * Messages reach a Claude lane through the agent inbox (lib/agent-inbox.ts):
 * the session publishes no Concord prompt endpoint, so Concord has nothing to
 * deliver to. The lane reads its inbox with `muster wait --inbox <lane>`.
 *
 * A live lane that has ended its turn reaches no tool boundary, so its hook would never
 * read a new message. It is woken in place by its own background `muster wait --inbox
 * <lane>` (LD10). No sender stops or resumes a Claude session to deliver a message (LD16):
 * every bus resume produced a new session id and sometimes two live copies (LD9), and a
 * session the daemon retired after an idle hour is asleep, not dead. Its message waits in the
 * inbox until the session is next opened (`claudeInboxState` reads whether it is asleep).
 * `resumeClaudeLane` stays as the deliberate restart (`muster resume`), never a send path.
 *
 * The lane is stopped here too (`stopClaudeLane`): no host on the lane reads the
 * control queue, so `muster control <lane> stop` runs `claude stop` itself and
 * then removes the card.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { InboxMessage } from "./agent-inbox.ts";
import { waiterAlive } from "../inbox-waiter.ts";
import { withoutSeatCredential } from "./seat-env.ts";
import { updateJsonSettingsFile } from "../../core/atomic-settings.ts";
import { CLAUDE_LANE_NAME, procPidAlive, readClaudeAgentsJson, findClaudeRow, stateFromClaudeStatus, type ClaudeJobActivity, type ClaudeLaneRow } from "./lane-directory.ts";
import { readLaneCard, removeLaneCard, writeLaneCard, type LaneCard, type LaneState, type LaneWall } from "./lane-card.ts";
import type { InboxState } from "../send.ts";

/**
 * Which lane is this Claude session? A session answers from its own record, never
 * from process env: `claude --bg` hands the job to the already-running daemon,
 * which spawns every session from its own environment, so the launcher's
 * per-launch `CONCORD_AGENT_ID` reaches only the first lane (measured 2026-10-09:
 * four lanes carried the first one's id).
 *
 * The record is the daemon's job file, `<claude config>/jobs/<first 8 of the
 * session id>/state.json`, written when the job is created: it holds the
 * `--name` the launcher passed and the full `sessionId`, so there is no launch
 * race and no `claude agents --json` call (6 s measured, too slow for a hook).
 * A file that does not name this session, or a name that is not a lane id, is
 * "not a lane": the answer is undefined and the caller stays inert.
 */
export function claudeSessionLane(
	sessionId: string | undefined,
	options: { jobsDir?: string; env?: NodeJS.ProcessEnv } = {},
): string | undefined {
	const name = readClaudeJob(sessionId, options)?.name;
	return name !== undefined && CLAUDE_LANE_NAME.test(name) ? name : undefined;
}

/** The full session-UUID shape Claude Code's hook payloads carry. */
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The lane id of the operator's own interactive Claude session (Henry's F5, 2026-10-16 16:25):
 * `lane-directory.ts` lists an unenrolled live interactive session as
 * `operator:claude:<8>` (LD2), and a gateway session_send delivery waits in that lane's
 * inbox. Only a full session UUID counts — anything else is not a session id.
 */
export function operatorSessionLane(sessionId: string | undefined): string | undefined {
	if (sessionId === undefined || !SESSION_UUID.test(sessionId)) return undefined;
	return `operator:claude:${sessionId.slice(0, 8)}`;
}

/** What the daemon's job record says about one background session (only the fields the bus reads). */
export interface ClaudeJob extends ClaudeJobActivity {
	sessionId: string;
	name: string;
	/** `bg` for a `claude --bg` job. */
	template?: string;
	cwd?: string;
	/** The flags the job was launched with (`--name`, `--model`, `--permission-mode`, `--plugin-dir`), which a respawn repeats. */
	respawnFlags?: string[];
	/** The job's own lifecycle state (`running`, `done`, `blocked`, `stopped`, ...). */
	state?: string;
	/** The job's process, when the record holds one (null once the session is gone). */
	pid?: number;
	/** The job's Remote Control entry (`cse_...`); absent when it has none. */
	bridgeSessionId?: string;
}

/**
 * The job record of the background session `sessionId`, or undefined when there
 * is none or it names a different session. The one reader of
 * `<claude config>/jobs/<first 8 of the session id>/state.json`.
 */
export function readClaudeJob(
	sessionId: string | undefined,
	options: { jobsDir?: string; env?: NodeJS.ProcessEnv } = {},
): ClaudeJob | undefined {
	const session = (sessionId ?? "").trim();
	// The id names a directory below, so only a UUID-shaped one is looked up.
	if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(session)) return undefined;
	const env = options.env ?? process.env;
	const jobsDir = options.jobsDir ?? join(env["CLAUDE_CONFIG_DIR"]?.trim() || join(env["HOME"]?.trim() || homedir(), ".claude"), "jobs");
	try {
		const job = JSON.parse(readFileSync(join(jobsDir, session.slice(0, 8), "state.json"), "utf8")) as Record<string, unknown>;
		if (job["sessionId"] !== session || typeof job["name"] !== "string") return undefined;
		const flags = job["respawnFlags"];
		const updatedAtMs = typeof job["updatedAt"] === "string" ? Date.parse(job["updatedAt"]) : Number.NaN;
		const inFlight = job["inFlight"];
		const inFlightTasks = typeof inFlight === "object" && inFlight !== null ? (inFlight as Record<string, unknown>)["tasks"] : undefined;
		return {
			sessionId: session,
			name: job["name"].trim(),
			...(typeof job["template"] === "string" ? { template: job["template"] } : {}),
			...(typeof job["cwd"] === "string" ? { cwd: job["cwd"] } : {}),
			...(Array.isArray(flags) && flags.every((flag) => typeof flag === "string") ? { respawnFlags: flags as string[] } : {}),
			...(typeof job["state"] === "string" ? { state: job["state"] } : {}),
			...(typeof job["pid"] === "number" ? { pid: job["pid"] } : {}),
			...(typeof job["bridgeSessionId"] === "string" && job["bridgeSessionId"] !== "" ? { bridgeSessionId: job["bridgeSessionId"] } : {}),
			...(typeof job["tempo"] === "string" ? { tempo: job["tempo"] } : {}),
			...(Number.isFinite(updatedAtMs) ? { updatedAtMs } : {}),
			...(typeof inFlightTasks === "number" ? { inFlightTasks } : {}),
		};
	} catch {
		return undefined;
	}
}

/** Is `pid` this process or one of its ancestors? Reads /proc; false where it cannot tell. */
export function isOwnAncestor(pid: number): boolean {
	let current = process.pid;
	for (let depth = 0; depth < 64 && current > 1; depth += 1) {
		if (current === pid) return true;
		try {
			// `pid (comm) state ppid ...`: comm may hold spaces and parentheses, so cut after the last ")".
			const stat = readFileSync(`/proc/${current}/stat`, "utf8");
			current = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
		} catch {
			return false;
		}
		if (!Number.isInteger(current)) return false;
	}
	return current === pid;
}

/**
 * The lane this process runs inside, when it runs inside a Claude lane's session:
 * `CLAUDE_CODE_SESSION_ID` names the session and `CLAUDE_PID` its process, which
 * must be an ancestor of this one. The ancestry check keeps a stale copy of those
 * variables (a tmux server started from a Claude tool inherits them, and every
 * Pi lane window after it) from naming a lane this process is not part of.
 */
export function ownClaudeLane(
	env: NodeJS.ProcessEnv = process.env,
	options: { jobsDir?: string; isAncestor?: (pid: number) => boolean } = {},
): string | undefined {
	const pid = Number(env["CLAUDE_PID"]);
	if (!Number.isInteger(pid) || pid <= 1) return undefined;
	if (!(options.isAncestor ?? isOwnAncestor)(pid)) return undefined;
	return claudeSessionLane(env["CLAUDE_CODE_SESSION_ID"], { env, ...(options.jobsDir !== undefined ? { jobsDir: options.jobsDir } : {}) });
}

/** How a Claude lane is reached; the card's `endpoint` field carries it. */
export function claudeLaneEndpoint(laneId: string): string {
	return `inbox: muster wait --inbox ${laneId}`;
}

/** Is this lane a Claude Code session? A card's harness decides; with no card, `claude agents` does. */
export function isClaudeLane(
	stateDir: string,
	laneId: string,
	readRows: () => readonly ClaudeLaneRow[] = () => readClaudeAgentsJson({}),
): boolean {
	const card = readLaneCard(stateDir, laneId);
	if (card !== undefined) return card.harness === "claude";
	return findClaudeRow(readRows(), laneId) !== undefined;
}

/**
 * Make sure the lane has a card. Returns the card, or undefined when no
 * `claude agents` row carries that name (the honest answer for a lane the bus
 * cannot see). An existing card is returned as it is.
 */
export function ensureClaudeLaneCard(
	stateDir: string,
	laneId: string,
	options: { now?: number; readRows?: () => readonly ClaudeLaneRow[] } = {},
): LaneCard | undefined {
	const existing = readLaneCard(stateDir, laneId);
	if (existing !== undefined) return existing;
	const row = findClaudeRow((options.readRows ?? (() => readClaudeAgentsJson({})))(), laneId);
	if (row === undefined) return undefined;
	const now = options.now ?? Date.now();
	const card: LaneCard = {
		laneId,
		harness: "claude",
		cwd: row.cwd ?? null,
		branch: null,
		state: stateFromClaudeStatus(row.status ?? row.state),
		model: null,
		thinking: null,
		since: typeof row.startedAt === "number" ? row.startedAt : null,
		updatedAt: now,
		wall: null,
		sessionId: row.sessionId,
		endpoint: claudeLaneEndpoint(laneId),
	};
	writeLaneCard(stateDir, card);
	return card;
}

/**
 * What the lane itself reports at a hook boundary: the fields the CLI cannot
 * read off a live surface. Every field is optional — a heartbeat names only
 * what it saw.
 */
export interface ClaudeLaneHeartbeat {
	/** `running` while a turn is in flight, `idle` at a turn boundary. */
	state?: LaneState;
	/** The session's model, when the payload names one (SessionStart). */
	model?: string | null;
	/** The Claude session id, so one physical lane is one row. */
	sessionId?: string;
	/** The lane's working directory. */
	cwd?: string | null;
	/** The lane's branch, when the caller knows it. */
	branch?: string | null;
	/** Epoch ms of the event that produced this heartbeat. */
	lastActivityMs?: number | null;
	/** One short line of the last assistant message (`Stop`'s payload carries it). */
	lastMessage?: string | null;
	/** The wall a `rate_limit` turn end records; any heartbeat without one clears it. */
	wall?: LaneWall | null;
	/** Automatic resumes spent on transient API errors; a heartbeat without one keeps the card's count. */
	retry?: { count: number };
	/** Epoch ms a work cycle began (session start or resume); a heartbeat without one keeps the card's value. */
	cycleStartedAt?: number;
	/** Why an API error ended the turn; any heartbeat without one clears it. */
	blockedReason?: string;
}

/**
 * Write the hook-backed heartbeat on a Claude lane's card, creating the card on
 * first need.
 *
 * A Claude lane has no in-process heartbeat like a Pi lane's: the bus-agent
 * hooks call this at session start, each tool boundary and each stop, so
 * `muster lanes` shows the lane's own activity and model even though
 * `claude agents --json` only says it exists. Read-modify-write through the card
 * owner (`lane-card.ts`), so a report or a control outcome another writer put
 * there is kept; the card's `since` moves only when the state changes.
 *
 * Returns the card as written. A lane id is the caller's identity, so a blank
 * one is a caller bug rather than a lane the bus cannot see.
 */
export function writeClaudeLaneHeartbeat(
	stateDir: string,
	laneId: string,
	heartbeat: ClaudeLaneHeartbeat,
	now: number = Date.now(),
): LaneCard {
	const existing = readLaneCard(stateDir, laneId);
	const state = heartbeat.state ?? existing?.state ?? "idle";
	const stateChanged = existing === undefined || existing.state !== state;
	const card: LaneCard = {
		...(existing ?? {}),
		laneId,
		harness: "claude",
		cwd: heartbeat.cwd !== undefined ? heartbeat.cwd : existing?.cwd ?? null,
		branch: heartbeat.branch !== undefined ? heartbeat.branch : existing?.branch ?? null,
		state,
		model: heartbeat.model !== undefined ? heartbeat.model : existing?.model ?? null,
		thinking: existing?.thinking ?? null,
		since: stateChanged ? now : existing?.since ?? now,
		updatedAt: now,
		wall: heartbeat.wall ?? null,
		sessionId: heartbeat.sessionId ?? existing?.sessionId,
		endpoint: existing?.endpoint ?? claudeLaneEndpoint(laneId),
		lastActivityMs: heartbeat.lastActivityMs !== undefined ? heartbeat.lastActivityMs : now,
		...(heartbeat.lastMessage !== undefined ? { lastMessage: heartbeat.lastMessage } : {}),
		...(heartbeat.retry !== undefined ? { retry: heartbeat.retry } : {}),
		...(heartbeat.cycleStartedAt !== undefined ? { cycleStartedAt: heartbeat.cycleStartedAt } : {}),
	};
	if (heartbeat.blockedReason !== undefined) card.blockedReason = heartbeat.blockedReason;
	else delete card.blockedReason;
	writeLaneCard(stateDir, card);
	return card;
}

/** One `claude` CLI call. Injectable so a test never spawns the real CLI. */
export type ClaudeCliRun = (args: string[], options?: { cwd?: string; timeoutMs?: number }) => { status: number | null; stdout: string; stderr: string };

export interface ClaudeStopResult {
	/** True only after the CLI confirmed the stop and the card was removed. */
	ok: boolean;
	/** The short background handle the CLI was given, when one was resolved. */
	handle?: string;
	/** Why the lane was not stopped; nothing changed. */
	reason?: string;
	/** What ran, or what was refused, for the caller's line. */
	detail: string;
}

/**
 * One `claude` call, with a deadline so a stalled daemon cannot hang the caller. The call carries no seat
 * credential: a `claude --bg --resume` that finds no daemon starts one from this environment, and every later
 * session would then hold the caller's seat (seat1, 2026-10-23).
 */
export function runClaudeCli(args: string[], options: { cwd?: string; timeoutMs?: number } = {}): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync("claude", args, { encoding: "utf8", timeout: options.timeoutMs ?? 10_000, stdio: ["ignore", "pipe", "pipe"], env: withoutSeatCredential(process.env), ...(options.cwd !== undefined ? { cwd: options.cwd } : {}) });
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? (result.error === undefined ? "" : String(result.error.message)),
	};
}

/**
 * Stop one Claude background session through the CLI's own verb.
 *
 * `claude stop` matches the short background `id` (or a name prefix) printed by
 * `claude agents --json`, NOT the `sessionId` UUID the card carries: verified
 * 2026-10-09 — `claude logs <sessionId>` answers "No job matching" while the
 * short id works. `claude agents --json` is the owner of that live surface
 * (`lane-directory.ts`), so the handle is resolved there at call time and the
 * card keeps one meaning per field.
 *
 * A confirmed stop removes the card through its owner: a clean stop leaves no
 * card behind. A refusal changes nothing.
 */
export function stopClaudeLane(
	stateDir: string,
	laneId: string,
	options: { readRows?: () => readonly ClaudeLaneRow[]; runCli?: ClaudeCliRun } = {},
): ClaudeStopResult {
	const card = readLaneCard(stateDir, laneId);
	let row: ClaudeLaneRow | undefined;
	try {
		row = findClaudeRow((options.readRows ?? (() => readClaudeAgentsJson({})))(), laneId, card?.sessionId);
	} catch {
		row = undefined;
	}
	if (row === undefined || typeof row.id !== "string" || row.id.trim() === "") {
		return {
			ok: false,
			reason: `no live background session for ${laneId} in \`claude agents --json\` (the lane is not running, or the CLI cannot see it)`,
			detail: `claude stop ${laneId}: refused`,
		};
	}
	const handle = row.id.trim();
	const run = options.runCli ?? runClaudeCli;
	const result = run(["stop", handle]);
	if (result.status !== 0) {
		const said = result.stderr.trim() || result.stdout.trim();
		return {
			ok: false,
			handle,
			reason: said === "" ? `claude stop ${handle} exited ${result.status === null ? "with no status" : String(result.status)}` : said,
			detail: `claude stop ${handle}: refused`,
		};
	}
	removeLaneCard(stateDir, laneId);
	return { ok: true, handle, detail: `claude stop ${handle}: stopped` };
}

/** How much of one message a delivery carries. */
const MAX_MESSAGE_CHARS = 4_000;

/**
 * One message as the model reads it: who sent it, when it arrived, and the text.
 * The reply command is named so the lane can answer without a second lookup. The
 * hook delivers it mid-task and a resumed lane gets it as its prompt, so both read
 * the same words.
 */
export function formatClaudeInboxDelivery(message: Pick<InboxMessage, "from" | "text"> & Partial<InboxMessage>, laneId: string, arrival = "delivered mid-task"): string {
	const reply = message.replyTo !== undefined ? ` (reply to ${message.replyTo})` : "";
	const body = message.text.length > MAX_MESSAGE_CHARS ? `${message.text.slice(0, MAX_MESSAGE_CHARS)}… [+${message.text.length - MAX_MESSAGE_CHARS} chars]` : message.text;
	return [
		`Muster message for ${laneId} from ${message.from}${reply}, ${arrival}:`,
		body,
		`Reply with: muster send ${message.from} --agent ${laneId} "<your reply>"`,
	].join("\n");
}

/**
 * The read-only half of `resumeClaudeLane`, for the send outcome text (LD16): is the Claude
 * session's process there, and is its waiter armed? Nothing is stopped or resumed. A row with no
 * live pid (the daemon retires an idle background session after 60 minutes and keeps listing it
 * with `pid: null`) is asleep: its message waits in the inbox until the session is next opened.
 * `undefined` means the state cannot be told (an interactive session, no row, `claude agents`
 * failed), and the outcome then says nothing about it.
 */
export function claudeInboxState(
	stateDir: string,
	options: {
		readRows?: () => readonly ClaudeLaneRow[];
		readJob?: (sessionId: string) => ClaudeJob | undefined;
		pidAlive?: (pid: number) => boolean;
		waiterAlive?: (stateDir: string, laneId: string) => boolean;
	} = {},
): (laneId: string) => InboxState | undefined {
	const readJob = options.readJob ?? ((sessionId: string) => readClaudeJob(sessionId));
	const pidAlive = options.pidAlive ?? procPidAlive;
	return (laneId) => {
		const card = readLaneCard(stateDir, laneId);
		// A card that names a session with no background job record is not a background
		// lane (the interactive orchestrator): answer without a `claude agents` call.
		if (card?.sessionId !== undefined && readJob(card.sessionId)?.template !== "bg") return undefined;
		let row: ClaudeLaneRow | undefined;
		try {
			row = findClaudeRow((options.readRows ?? (() => readClaudeAgentsJson({})))(), laneId, card?.sessionId);
		} catch {
			row = undefined;
		}
		if (row === undefined) return undefined;
		if (typeof row.pid === "number" && pidAlive(row.pid)) {
			return { state: "live", waiter: (options.waiterAlive ?? ((dir: string, lane: string) => waiterAlive(dir, lane, pidAlive)))(stateDir, laneId) };
		}
		return { state: "asleep", why: "its process is gone" };
	};
}

/** How long one `muster resume` holds its lane's lease: until the new row shows in `claude agents --json`, or this long. */
export const RESUME_LEASE_MS = 30_000;
/** A lease older than this belongs to a crashed holder, whatever its pid says. */
const RESUME_LEASE_STALE_MS = RESUME_LEASE_MS + 5_000;
const RESUME_POLL_MS = 500;

/** The Remote Control link of a job (`bridgeSessionId` is `cse_<id>`, the page is `session_<id>`). Checked on one sample, 2026-10-12. */
export function claudeRemoteControlLink(bridgeSessionId: string): string {
	return `https://claude.ai/code/session_${bridgeSessionId.replace(/^cse_/, "")}`;
}

function sleepBlocking(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export type ClaudeResumeResult =
	/** A process holds the session. Nothing was resumed: the message is in its inbox, and `waiter` says whether its waiter is armed. */
	| { state: "live"; waiter: boolean }
	/** Another `muster resume` of this lane holds the lease (`by` is its pid). */
	| { state: "in-progress"; by: number }
	/** The lane has no session this can wake: no session id, no daemon job record, or no cwd. */
	| { state: "unresumable"; reason: string }
	/**
	 * The session was woken. `keptId` is false when the CLI started a copy under another id (`handle` is the copy);
	 * `rowSeen` says whether the new row showed in `claude agents --json` before the lease ran out.
	 */
	| { state: "resumed"; sessionId: string; oldHandle: string; handle?: string; keptId: boolean; rowSeen: boolean; bridgeSessionId?: string; detail: string }
	| { state: "failed"; reason: string };

/**
 * Wake a Claude lane whose process is gone: the one resume owner, run only by `muster resume` (LD16).
 * The session may be one the daemon retired after an idle hour (a row with `pid: null`), or one stopped
 * on purpose and parked (no row; its id comes from `options.sessionId`, the lane record's).
 *
 * `claude --bg --resume <full session id> [prompt]`, with NO flags, continues the same job under the
 * same short id and session id (measured 2026-10-12, probe P2, 4 of 4): the job keeps its saved options.
 * Any flag starts a copy under a new id ("keeps its own saved options, so the flags you passed started a
 * copy"), which is what every bus resume since 2026-10-09 did. So this never passes flags and never runs
 * `claude stop` (a stop also drops the Remote Control entry of a live session, F5).
 *
 * A live process (the row's pid or the job record's pid) is never touched: resuming over it starts a copy.
 * One resume per lane at a time: a lease file under `<stateDir>/resume/` is taken before the check
 * and kept until the new row shows or `RESUME_LEASE_MS` passes. Nothing is run unless the job record and
 * its cwd are known first. The lane's card and record are not written here: the woken session's own
 * SessionStart heartbeat appends its id to the record's chain.
 */
export function resumeClaudeLane(
	stateDir: string,
	laneId: string,
	prompt: string | undefined,
	options: {
		/** The lane's session when no card names one (a parked lane: the record's). */
		sessionId?: string;
		readRows?: () => readonly ClaudeLaneRow[];
		runCli?: ClaudeCliRun;
		readJob?: (sessionId: string) => ClaudeJob | undefined;
		pidAlive?: (pid: number) => boolean;
		waiterAlive?: (stateDir: string, laneId: string) => boolean;
		now?: () => number;
		sleep?: (ms: number) => void;
	} = {},
): ClaudeResumeResult {
	if (!CLAUDE_LANE_NAME.test(laneId)) return { state: "unresumable", reason: `${laneId} is not a lane id` };
	const readJob = options.readJob ?? ((sessionId: string) => readClaudeJob(sessionId));
	const pidAlive = options.pidAlive ?? procPidAlive;
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? sleepBlocking;
	const readRows = options.readRows ?? (() => readClaudeAgentsJson({}));
	const hint = options.sessionId ?? readLaneCard(stateDir, laneId)?.sessionId;
	const lease = takeResumeLease(stateDir, laneId, pidAlive, now());
	if ("heldBy" in lease) return { state: "in-progress", by: lease.heldBy };
	try {
		let rows: readonly ClaudeLaneRow[];
		try {
			rows = readRows();
		} catch (error) {
			return { state: "failed", reason: `claude agents --json failed, so a live copy of ${laneId} cannot be ruled out: ${error instanceof Error ? error.message : String(error)}` };
		}
		const row = findClaudeRow(rows, laneId, hint);
		const sessionId = hint ?? row?.sessionId;
		if (sessionId === undefined) return { state: "unresumable", reason: `no session id for ${laneId}: no card, lane record or \`claude agents\` row names one` };
		const job = readJob(sessionId);
		if (job?.template !== "bg") return { state: "unresumable", reason: `${laneId} (${sessionId}) has no background job record, so \`claude --bg --resume\` cannot wake it` };
		if ((typeof row?.pid === "number" && pidAlive(row.pid)) || (typeof job.pid === "number" && pidAlive(job.pid))) {
			return { state: "live", waiter: (options.waiterAlive ?? ((dir: string, lane: string) => waiterAlive(dir, lane, pidAlive)))(stateDir, laneId) };
		}
		const cwd = job.cwd ?? row?.cwd;
		if (cwd === undefined) return { state: "unresumable", reason: `the job record of ${laneId} (${sessionId}) holds no cwd to resume in` };
		const oldHandle = sessionId.slice(0, 8);
		const started = now();
		const resume = (options.runCli ?? runClaudeCli)(["--bg", "--resume", sessionId, ...(prompt !== undefined && prompt !== "" ? [prompt] : [])], { cwd, timeoutMs: 30_000 });
		if (resume.status !== 0) {
			const said = resume.stderr.trim() || resume.stdout.trim();
			return { state: "failed", reason: `claude --bg --resume ${oldHandle}: ${said === "" ? `exited ${resume.status === null ? "with no status" : String(resume.status)}` : said}` };
		}
		// `claude --bg` prints `backgrounded · <short id> · <name>`.
		const handle = /backgrounded\s*·\s*([0-9a-f]{8})\b/i.exec(resume.stdout)?.[1];
		const keptId = handle === undefined || sessionId.startsWith(handle);
		let rowSeen = false;
		let newSessionId = keptId ? sessionId : undefined;
		for (;;) {
			let listed: readonly ClaudeLaneRow[] = [];
			try {
				listed = readRows();
			} catch {
				/* the lease then simply runs its course */
			}
			const woken = listed.find((candidate) => candidate.id === (handle ?? oldHandle) && typeof candidate.pid === "number" && pidAlive(candidate.pid));
			if (woken !== undefined) {
				rowSeen = true;
				newSessionId = woken.sessionId;
				break;
			}
			if (now() - started >= RESUME_LEASE_MS) break;
			sleep(RESUME_POLL_MS);
		}
		const bridgeSessionId = newSessionId === undefined ? undefined : readJob(newSessionId)?.bridgeSessionId;
		return {
			state: "resumed",
			sessionId: newSessionId ?? sessionId,
			oldHandle,
			...(handle !== undefined ? { handle } : {}),
			keptId,
			rowSeen,
			...(bridgeSessionId !== undefined ? { bridgeSessionId } : {}),
			detail: keptId ? `claude --bg --resume ${oldHandle}: woke the same session` : `claude --bg --resume ${oldHandle} started a copy as ${handle}`,
		};
	} finally {
		lease.release();
	}
}

/** One lease per lane, claimed under the settings owner's mkdir lock so two resumes cannot both pass the check. */
function takeResumeLease(stateDir: string, laneId: string, pidAlive: (pid: number) => boolean, nowMs: number): { release: () => void } | { heldBy: number } {
	const file = join(stateDir, "resume", `${laneId}.lock`);
	let heldBy: number | undefined;
	updateJsonSettingsFile<{ pid?: number; at?: number }>(file, {}, (current) => {
		if (typeof current.pid === "number" && typeof current.at === "number" && nowMs - current.at < RESUME_LEASE_STALE_MS && pidAlive(current.pid)) {
			heldBy = current.pid;
			return current;
		}
		return { pid: process.pid, at: nowMs };
	});
	return heldBy !== undefined ? { heldBy } : { release: () => { rmSync(file, { force: true }); } };
}
