/**
 * `muster claude-hook <event>` — the Claude Code lane's bus-agent endpoint.
 *
 * A Claude background lane (`claude --bg --name <lane>`) publishes no Concord
 * prompt endpoint and runs no in-process heartbeat, so a message sent to it
 * waits until someone types `muster wait --inbox <lane>`, and `muster lanes`
 * shows only what `claude agents --json` says. Claude Code can reach a running
 * session at a tool boundary through a hook, so the lane's plugin (`muster-bus`
 * in claude-mods) calls this command once per event with the hook's payload on
 * stdin and prints the hook's JSON answer on stdout.
 *
 * This command owns the bus half and the plugin owns only the Claude plumbing,
 * so the inbox reader, the once-only ledger and the card writer are the same
 * owners every other harness uses (`lib/agent-inbox.ts`, `lib/lane-card.ts`,
 * `lib/claude-lane-card.ts`) — no second copy of bus code lives in the plugin.
 *
 * Contract:
 *   - The lane is the session's own: the payload's `session_id` (or `--session`)
 *     looked up in the daemon's job record (`claudeSessionLane`), because every
 *     `claude --bg` session carries the daemon's `CONCORD_AGENT_ID`, not its own.
 *     `--lane` overrides it. With no bus lane, one more shape answers: the operator's own
 *     interactive session, `operator:claude:<8>` (`operatorSessionLane` — Henry's F5,
 *     2026-10-16 16:25), for which the command is delivery-only (see below).
 *     With neither, the command is inert: it prints nothing and exits 0, so a
 *     session that is neither a lane nor one of the operator's is never changed.
 *   - For the operator's own session (`operatorSessionLane`) the command delivers only:
 *     the pending `session_send` messages move to `read/` and ride back as
 *     `hookSpecificOutput.additionalContext`, the same answer a bus lane gets.
 *     No card, no heartbeat, no tab ledger, no record, no nudges — nothing of
 *     the lane lifecycle touches his session — and a pending message at `Stop`
 *     stays pending instead of blocking the turn: his session is handed its
 *     mail, never driven (methodology Closure, LD9).
 *   - Nothing on stdin that does not parse is a refusal to act, never an error:
 *     a hook must not be able to block the model (exit 0, no output).
 *   - One call delivers each pending message once. The message is moved to the
 *     inbox's `read/` by `markInboxMessageRead` (the same ledger `muster wait
 *     --inbox` uses) before the answer is printed, so a message is delivered
 *     exactly once even if the hook is re-entered.
 *   - The answer is `{"hookSpecificOutput":{"hookEventName":…,"additionalContext":[…]}}`
 *     when messages were delivered, and nothing at all when none were: an empty
 *     answer is the cheap case the plugin sees on most tool boundaries.
 *   - `Stop` is the one event answered with a decision instead: a message pending
 *     as the turn ends is returned as `{"decision":"block","reason":<text>}`, so
 *     the lane continues its turn with it instead of going idle with it unread.
 *     Only when the payload says `stop_hook_active: false`; an active stop hook
 *     means the lane is already continuing from one, and blocking again could loop.
 *     The same block carries the report nudge (`report-nudge.ts`, LD7) when the lane
 *     ends a turn without having filed a report in this work cycle, once per cycle.
 *     A cycle begins at `SessionStart` with source `startup` or `resume`.
 *     It also carries the waiter nudge (`inbox-waiter.ts`, WP9) when an auto lane's
 *     `muster wait --inbox` is not running: a lane that ends its turn with no waiter can
 *     only be woken by a resume, which the bus no longer does to a live session (LD9).
 *     Once per turn, by the same `stop_hook_active` rule.
 *     A browser QA lane that still has a Chrome tab open (the lane record's `openTabs`) is told to close
 *     it in the same block (`browser-qa.ts`, LD11). `PostToolUse` keeps that ledger: it records the tab a
 *     `tabs_create_mcp` result names and drops the one a `tabs_close_mcp` result closed, a subagent's too.
 *
 * Events (the classic names Claude Code sends; unknown ones are a heartbeat):
 *   SessionStart                  heartbeat `running`, deliver pending messages
 *   PostToolUse[Failure|Batch]    heartbeat `running`, deliver pending messages
 *   Notification                  heartbeat (state unchanged), deliver pending
 *   Stop                          heartbeat `idle`, record the last assistant message, reset the retry count
 *   StopFailure                   an API error ended the turn: card state, one event line, and a resume timer (DS2)
 *   SessionEnd                    remove the card (a `/clear` keeps it: the lane goes on; so does a session the card no longer names)
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { atBoundary, boundaryReason } from "../ledger/boundary.ts";
import { threadAskLines } from "../asks.ts";
import { agentInboxDir, listInboxMessages, markInboxMessageRead, type InboxMessage } from "../lib/agent-inbox.ts";
import { claudeSessionLane, formatClaudeInboxDelivery, operatorSessionLane, writeClaudeLaneHeartbeat, type ClaudeLaneHeartbeat } from "../lib/claude-lane-card.ts";
import { cutLastMessage, readLaneCard, removeLaneCard, type LaneState, type LaneWall } from "../lib/lane-card.ts";
import { waiterAlive, waiterNudgeText } from "../inbox-waiter.ts";
import { isConversationLane, recordSession } from "../lane-lifecycle.ts";
import { applyTabEvent, openTabsNudgeFor, tabEventOf } from "../browser-qa.ts";
import { appendOrchestratorEvent, formatEventLine, type EventKind } from "../lane-report.ts";
import { markReportNudged, REPORT_NUDGE_TEXT, reportNudgeDue, reportNudgeExempt } from "../report-nudge.ts";
import { scheduleLaneResume } from "../resume-timer.ts";
import { lanesStateDir } from "./lanes.ts";
import { parseFlags, type CliCommand, type CliContext } from "./types.ts";

const VALUE_FLAGS = ["lane", "event", "session"];
/**
 * The events that carry a delivery. `SessionStart` and `UserPromptSubmit` accept
 * `hookSpecificOutput.additionalContext`; the tool events and `Notification` do
 * too. `Stop` is absent: the model has finished its turn, so its context goes
 * nowhere. A message pending at `Stop` is delivered as a block decision instead
 * (`stopMayDeliver`), which makes the model read it as the reason to continue.
 */
const DELIVERING_EVENTS = new Set([
	"SessionStart",
	"UserPromptSubmit",
	"PostToolUse",
	"PostToolUseFailure",
	"PostToolBatch",
	"Notification",
]);

/** How many pending messages one delivery carries (the text of each is capped by the formatter). */
const MAX_DELIVERED_MESSAGES = 10;

/** The classic payload fields this command reads; every one is optional. */
interface HookPayload {
	hook_event_name?: unknown;
	session_id?: unknown;
	transcript_path?: unknown;
	/** The prompt he just submitted: `UserPromptSubmit`'s own field, the one his message is found by. */
	prompt?: unknown;
	cwd?: unknown;
	model?: unknown;
	source?: unknown;
	last_assistant_message?: unknown;
	reason?: unknown;
	agent_id?: unknown;
	stop_hook_active?: unknown;
	error?: unknown;
	error_details?: unknown;
	tool_name?: unknown;
	tool_response?: unknown;
}

function asText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * The lane this hook answers for. `--lane` wins so a caller can name one
 * explicitly. Otherwise a session id (`--session`, else the payload's) decides
 * and process env is never consulted for it: a session that is not a known lane
 * is not attributed to the env's lane (the daemon's env names the wrong one).
 * With no session id the process's own identity decides, which is what an
 * interactive the operator session lacks — there the command stays inert.
 */
export function resolveClaudeHookLane(
	flags: { lane?: string | undefined; session?: string | undefined },
	agentId: string | undefined,
	payloadSessionId?: string,
	sessionLane: (sessionId: string) => string | undefined = claudeSessionLane,
): string | undefined {
	const explicit = asText(flags.lane);
	if (explicit !== undefined) return explicit;
	const session = asText(flags.session) ?? asText(payloadSessionId);
	if (session !== undefined) return sessionLane(session);
	return asText(agentId);
}

/**
 * Whether a `Stop` may be answered with a pending message. Only an explicit
 * `stop_hook_active: false` qualifies: `true` is a lane already continuing from a
 * stop hook, and a missing or malformed field is a payload this command cannot
 * vouch for. Both mean "do not block".
 */
export function stopMayDeliver(event: string, payload: { stop_hook_active?: unknown }): boolean {
	return event === "Stop" && payload.stop_hook_active === false;
}

/**
 * Does this `SessionStart` begin a work cycle? A launch (`startup`) and a resume (`resume`) do;
 * `clear` and `compact` continue the same work. A payload with no source starts one only when
 * the card has none, so a lane that predates the field is given one.
 */
export function startsWorkCycle(source: unknown, cardHasCycle: boolean): boolean {
	return source === "startup" || source === "resume" || !cardHasCycle;
}

/** How long a transient API error waits before the one automatic resume (DS2). */
export const TRANSIENT_RESUME_MS = 120_000;

const RESUME_TEXT = "Continue where you stopped.";

/**
 * A reset time inside a `StopFailure` `error_details`, as epoch ms, or undefined.
 * The field is free text from Claude Code, so this reads only what is unambiguous:
 * an ISO-8601 date-time anywhere in a string, a `resetAt` / `reset_at` / `resets_at`
 * member of an object, or a bare number (seconds below 1e12, else milliseconds).
 */
export function parseResetAt(details: unknown): number | undefined {
	if (typeof details === "number") return Number.isFinite(details) && details > 0 ? (details < 1e12 ? details * 1000 : details) : undefined;
	if (typeof details === "string") {
		const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/.exec(details);
		if (iso !== null) {
			const at = Date.parse(iso[0]);
			if (!Number.isNaN(at)) return at;
		}
		const bare = details.trim();
		return /^\d{9,13}$/.test(bare) ? parseResetAt(Number(bare)) : undefined;
	}
	if (details !== null && typeof details === "object" && !Array.isArray(details)) {
		const record = details as Record<string, unknown>;
		for (const key of ["resetAt", "reset_at", "resets_at", "resetsAt"]) {
			const at = parseResetAt(record[key]);
			if (at !== undefined) return at;
		}
	}
	return undefined;
}

/** What a `StopFailure` turn end means for the lane's card, event line and resume timer. */
export interface StopFailureOutcome {
	state: LaneState;
	wall?: LaneWall;
	retry?: { count: number };
	blockedReason?: string;
	/** The line the orchestrator's waiter reads; absent when the hook resumes the lane itself. */
	event?: { kind: EventKind; detail: string };
	/** When to wake the lane, and with what. */
	resumeAt?: number;
}

/**
 * DS2: classify one API-error turn end.
 *
 *   rate_limit                 -> quota-walled, QUOTA WALL; a resume timer at the reset when the details name one
 *   overloaded | server_error  -> idle with retry {1} and one resume after 120 s; a second in a row is CRASHED
 *   anything else              -> blocked with the code, CRASHED; these need the operator, never a retry
 */
export function classifyStopFailure(payload: { error?: unknown; error_details?: unknown }, retryCount: number, now: number): StopFailureOutcome {
	const code = asText(payload.error) ?? "unknown";
	if (code === "rate_limit") {
		const resetAt = parseResetAt(payload.error_details);
		return {
			state: "quota-walled",
			wall: { shapeId: "claude-rate-limit", ...(resetAt !== undefined ? { resetAt } : {}) },
			event: {
				kind: "QUOTA WALL",
				detail: resetAt === undefined ? "claude walled until unknown; the orchestrator decides" : `claude walled until ${new Date(resetAt).toISOString()}; resume timer set for then`,
			},
			...(resetAt !== undefined ? { resumeAt: resetAt } : {}),
		};
	}
	if (code === "overloaded" || code === "server_error") {
		if (retryCount < 1) return { state: "idle", retry: { count: 1 }, resumeAt: now + TRANSIENT_RESUME_MS };
		return {
			state: "blocked",
			retry: { count: retryCount },
			blockedReason: code,
			event: { kind: "CRASHED", detail: `${code} again after one automatic resume` },
		};
	}
	return { state: "blocked", blockedReason: code, event: { kind: "CRASHED", detail: `${code}; needs the operator, no automatic retry` } };
}

/** The bus state a heartbeat records, or undefined for an event that never moves it. */
export function claudeHookState(event: string, payload: { error?: unknown; error_details?: unknown } = {}, retryCount = 0, now = Date.now()): LaneState | undefined {
	if (event === "StopFailure") return classifyStopFailure(payload, retryCount, now).state;
	if (event === "Stop") return "idle";
	if (event === "SessionStart") return "running";
	if (event === "PostToolUse" || event === "PostToolUseFailure" || event === "PostToolBatch" || event === "UserPromptSubmit") return "running";
	return undefined;
}

/** The side effects of a `StopFailure`, injectable so a test starts no timer and writes no real events file. */
export interface StopFailurePorts {
	scheduleResume: (lane: string, at: Date, text: string) => { unit: string } | { error: string };
	appendEvent: (stateDir: string, line: string, now: Date) => boolean;
}

const defaultStopFailurePorts: StopFailurePorts = {
	scheduleResume: (lane, at, text) => scheduleLaneResume(lane, at, text),
	appendEvent: appendOrchestratorEvent,
};

/**
 * Apply one API-error turn end: set the resume timer, write the card, append the event.
 * A timer systemd refuses is not silent. A transient error whose resume cannot be set
 * would leave the lane idle for good, so it becomes CRASHED; a wall keeps its event
 * and says the orchestrator must resume the lane.
 */
export function handleStopFailure(stateDir: string, laneId: string, payload: HookPayload, now: number, ports: StopFailurePorts = defaultStopFailurePorts): StopFailureOutcome {
	const existing = readLaneCard(stateDir, laneId);
	let outcome = classifyStopFailure(payload, existing?.retry?.count ?? 0, now);
	if (outcome.resumeAt !== undefined) {
		const scheduled = ports.scheduleResume(laneId, new Date(outcome.resumeAt), RESUME_TEXT);
		if ("error" in scheduled) {
			outcome =
				outcome.state === "quota-walled"
					? { ...outcome, event: { kind: "QUOTA WALL", detail: `claude walled until ${new Date(outcome.resumeAt).toISOString()}; resume timer failed (${scheduled.error}), the orchestrator resumes it` } }
					: { state: "blocked", blockedReason: asText(payload.error) ?? "unknown", event: { kind: "CRASHED", detail: `${asText(payload.error) ?? "unknown"}; the automatic resume could not be set (${scheduled.error})` } };
		}
	}
	writeClaudeLaneHeartbeat(
		stateDir,
		laneId,
		{
			...heartbeatFor(payload, "StopFailure", now, outcome.state),
			...(outcome.wall !== undefined ? { wall: outcome.wall } : {}),
			...(outcome.retry !== undefined ? { retry: outcome.retry } : {}),
			...(outcome.blockedReason !== undefined ? { blockedReason: outcome.blockedReason } : {}),
		},
		now,
	);
	if (outcome.event !== undefined) ports.appendEvent(stateDir, formatEventLine(outcome.event.kind, laneId, outcome.event.detail), new Date(now));
	return outcome;
}

/**
 * Take the lane's pending messages and move them to `read/` (the ledger), so the
 * caller's answer carries each exactly once. A message whose move fails is left
 * pending and not delivered, which is the honest failure: the next boundary
 * tries again rather than losing it.
 */
export function takePendingInboxDeliveries(
	stateDir: string,
	laneId: string,
	read: (stateDir: string, agent: string) => InboxMessage[] = listInboxMessages,
	markRead: (stateDir: string, agent: string, id: string) => boolean = markInboxMessageRead,
): InboxMessage[] {
	const delivered: InboxMessage[] = [];
	for (const message of read(stateDir, laneId).slice(0, MAX_DELIVERED_MESSAGES)) {
		if (markRead(stateDir, laneId, message.id)) delivered.push(message);
	}
	return delivered;
}

function heartbeatFor(payload: HookPayload, event: string, now: number, state: LaneState | undefined = claudeHookState(event)): ClaudeLaneHeartbeat {
	const heartbeat: ClaudeLaneHeartbeat = {
		lastActivityMs: now,
		...(state !== undefined ? { state } : {}),
	};
	const sessionId = asText(payload.session_id);
	if (sessionId !== undefined) heartbeat.sessionId = sessionId;
	const cwd = asText(payload.cwd);
	if (cwd !== undefined) heartbeat.cwd = cwd;
	const model = asText(payload.model);
	if (model !== undefined) heartbeat.model = model;
	const lastMessage = asText(payload.last_assistant_message);
	if (lastMessage !== undefined) heartbeat.lastMessage = cutLastMessage(lastMessage);
	return heartbeat;
}

async function run(ctx: CliContext): Promise<number> {
	const parsed = parseFlags(ctx.argv, VALUE_FLAGS);
	// The plugin passes the event as the positional; `--event` is accepted so a
	// caller that prefers flags is not refused.
	const eventArgument = parsed.positionals[0] ?? parsed.values.get("event");
	const raw = await ctx.readStdin().catch(() => "");
	let payload: HookPayload = {};
	if (raw.trim() !== "") {
		try {
			const parsedPayload = JSON.parse(raw);
			if (typeof parsedPayload === "object" && parsedPayload !== null && !Array.isArray(parsedPayload)) payload = parsedPayload as HookPayload;
		} catch {
			// A hook must fail open: an unreadable payload is nothing to act on, not
			// an error the model sees. The lane is never blocked by this command.
			return 0;
		}
	}
	const event = asText(eventArgument) ?? asText(payload.hook_event_name) ?? "Unknown";
	const busLaneId = resolveClaudeHookLane({ lane: parsed.values.get("lane"), session: parsed.values.get("session") }, ctx.agentId, asText(payload.session_id), (id) => claudeSessionLane(id, { env: ctx.env }));
	// Henry's F5: a session no job record names but whose id is a session UUID is the operator's own
	// interactive session. It gets delivery only — no lane lifecycle, no Stop block (LD9).
	const operatorLane = busLaneId === undefined ? operatorSessionLane(asText(parsed.values.get("session")) ?? asText(payload.session_id)) : undefined;
	if (busLaneId === undefined && operatorLane === undefined) return 0;
	const laneId = busLaneId ?? operatorLane!;

	const stateDir = lanesStateDir(ctx.env);

	// `--inbox-dir` answers one question and nothing else: where this lane's
	// pending messages live, so its plugin can probe that directory on every tool
	// boundary without spawning this command. The path rule stays here, with the
	// inbox owner, rather than being copied into the hook. It reads no store.
	if (parsed.flags.has("inbox-dir")) {
		ctx.io.out(agentInboxDir(stateDir, laneId));
		return 0;
	}

	// LC12 (LC-D4, DL6): one call of this command is one boundary. A store that
	// cannot be reached lets the turn continue — exit 0, no output — instead of
	// becoming an error Claude Code sees or the CLI frame's exit 75 (LC2). The
	// entry is wrapped whole, not per store call: the answer is built from several
	// reads and one write, and a partial answer is worse than none.
	return atBoundary("claude-hook", () => runLaneHook(ctx, { event, payload, laneId, operatorLane, stateDir, now: Date.now() }), 0);
}

/**
 * the operator's own session is handed the list line of every ask its thread raised, on his own message: the
 * payload names the session the sweep wrote the source with, the transcript it reads, and the prompt he just
 * submitted, so the evidence is this message's own line (VR24-230 AC2). Nothing is read when the thread raised
 * nothing open: the queue is a file, and the transcript is only touched when the line has to name it.
 */
function threadAskLinesForSession(stateDir: string, payload: HookPayload): string[] {
	const session = asText(payload.session_id);
	if (session === undefined) return [];
	const transcript = asText(payload.transcript_path);
	const prompt = asText(payload.prompt);
	return threadAskLines({
		musterStateDir: stateDir,
		session,
		...(transcript !== undefined ? { evidence: () => ({ transcript, line: transcriptPromptLine(transcript, prompt) }) } : {}),
	});
}

/** Whitespace is not part of a prompt's identity: a transcript line and a payload wrap it differently. */
function flatPrompt(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** The text of a transcript entry that is the operator typing, or undefined for every other entry. */
function promptTextOf(line: string): string | undefined {
	if (!line.includes('"type":"user"')) return undefined;
	try {
		const entry = JSON.parse(line) as { type?: unknown; message?: { role?: unknown; content?: unknown } };
		if (entry.type !== "user" || entry.message?.role !== "user") return undefined;
		// A typed prompt is a string; a tool result is a block array.
		return typeof entry.message.content === "string" ? entry.message.content : undefined;
	} catch {
		return undefined;
	}
}

/** How much of the transcript's end the line rule reads back over: his message is its last entry, or one past it. */
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
/** How much of one line is worth reading whole: a pasted prompt well inside any real one. */
const LAST_LINE_BYTES = 8 * 1024 * 1024;

/** The file's last complete line, read whole however long it is: the tail window is a window, not a limit. */
function readLastLine(fd: number, size: number): string | undefined {
	const chunk = Buffer.allocUnsafe(64 * 1024);
	let end = size;
	let fromEnd = true;
	let start = 0;
	while (end > 0) {
		const at = Math.max(0, end - chunk.length);
		const read = readSync(fd, chunk, 0, end - at, at);
		let found = -1;
		for (let index = read - 1; index >= 0; index -= 1) {
			if (chunk[index] !== 0x0a) continue;
			const lineStart = at + index + 1;
			// The file's own trailing newline starts no line; the newline before it ends the last one.
			if (fromEnd && lineStart === size) continue;
			found = lineStart;
			break;
		}
		if (found >= 0) {
			start = found;
			break;
		}
		fromEnd = false;
		end = at;
	}
	const length = size - start;
	if (length <= 0 || length > LAST_LINE_BYTES) return undefined;
	const buffer = Buffer.allocUnsafe(length);
	const read = readSync(fd, buffer, 0, length, start);
	const text = buffer.subarray(0, read).toString("utf8");
	return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/**
 * The line of the transcript that holds the message he just sent (VR24-230 AC2).
 *
 * Measured on a real transcript (`~/.claude/projects/-home-operator/*.jsonl`): a typed prompt is one `type: user`
 * entry with `message.role: user` and a string content, and the turn's `api-request` and `system` records follow
 * it — so the file's last line is not his message's line. The rule reads the file's end, where at submit time his
 * entry is: the last entry that carries the payload's own prompt. When the transcript does not hold it yet, the
 * message lands on the next line, which is the count of the lines already there plus one. A payload with no prompt
 * falls back to the last typed entry.
 *
 * Cost is one pass counting newlines — 136 ms for the largest transcript on this machine, 94 MB, measured
 * 2026-10-28 — plus a bounded read of the end; it is paid only when the thread has an open ask to cite.
 */
export function transcriptPromptLine(path: string, prompt: string | undefined): number | undefined {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return undefined;
	}
	try {
		const size = statSync(path).size;
		const buffer = Buffer.allocUnsafe(1 << 20);
		let newlines = 0;
		for (;;) {
			const read = readSync(fd, buffer, 0, buffer.length, null);
			if (read <= 0) break;
			for (let index = 0; index < read; index += 1) if (buffer[index] === 0x0a) newlines += 1;
		}
		const wanted = prompt === undefined ? undefined : flatPrompt(prompt);
		if (wanted !== undefined && wanted === "") return newlines + 1;
		const tailStart = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
		const tailLength = size - tailStart;
		const tail = Buffer.allocUnsafe(tailLength);
		const tailRead = tailLength === 0 ? 0 : readSync(fd, tail, 0, tailLength, tailStart);
		const lines = tail.subarray(0, tailRead).toString("utf8").split("\n");
		// The file ends with a newline, so its last complete line is `newlines`; a torn tail is one more line.
		const written = lines.at(-1) === "" ? newlines : newlines + 1;
		const complete = lines.at(-1) === "" ? lines.slice(0, -1) : lines;
		for (let back = 1; back <= complete.length; back += 1) {
			const line = complete[complete.length - back];
			if (line === undefined) continue;
			const text = promptTextOf(line);
			if (text === undefined) continue;
			if (wanted === undefined) return written - back + 1;
			if (flatPrompt(text).includes(wanted)) return written - back + 1;
		}
		// The tail window can cut the start off the file's last entry, which is the one a prompt bigger than the
		// window occupies: read that single line whole before deciding the message has not been written yet.
		if (wanted !== undefined) {
			const last = readLastLine(fd, size);
			if (last !== undefined) {
				const text = promptTextOf(last);
				if (text !== undefined && flatPrompt(text).includes(wanted)) return written;
			}
		}
		return written + 1;
	} finally {
		closeSync(fd);
	}
}

/** The hook's own work: everything past the payload and the lane identity, and no `await`. */
function runLaneHook(
	ctx: CliContext,
	input: { event: string; payload: HookPayload; laneId: string; operatorLane: string | undefined; stateDir: string; now: number },
): number {
	const { event, payload, laneId, operatorLane, stateDir, now } = input;

	// the operator's own session: hand it its pending session_send mail at the passive
	// boundaries and stop there. A message pending at `Stop` stays pending — his
	// session is never blocked into continuing (LD9) — and nothing of the lane
	// lifecycle (card, heartbeat, tab ledger, record, nudges) is written.
	if (operatorLane !== undefined) {
		if (!DELIVERING_EVENTS.has(event)) return 0;
		const mail = takePendingInboxDeliveries(stateDir, operatorLane);
		// VR24-230 AC2: an ask this thread raised is on the operator's list, and his message here is the one
		// place the session learns it, so it can close the ask in the same turn his words settle it.
		const threadLines = event === "UserPromptSubmit" ? threadAskLinesForSession(stateDir, payload) : [];
		if (mail.length === 0 && threadLines.length === 0) return 0;
		ctx.io.out(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: event,
					additionalContext: [...mail.map((message) => formatClaudeInboxDelivery(message, operatorLane)), ...threadLines],
				},
			}),
		);
		return 0;
	}

	// The tab ledger of a browser QA lane (LD11). A subagent's tab is the lane's tab, so this is outside the agent_id rule below.
	if (event === "PostToolUse") {
		const tab = tabEventOf(payload);
		if (tab !== undefined) applyTabEvent(stateDir, laneId, tab);
	}

	// A subagent's own tool calls carry `agent_id`; the card belongs to the main
	// thread of the lane, so a subagent boundary writes no heartbeat.
	if (asText(payload.agent_id) === undefined) {
		if (event === "SessionEnd") {
			// A `/clear` ends the conversation while the lane runs on: keep the card.
			// So does a session the card no longer names: a lane resumed by `muster
			// send` starts its new session while the old one's SessionEnd may still be
			// running, and that must not remove the card the new session just wrote.
			const endingSession = asText(payload.session_id);
			const cardSession = readLaneCard(stateDir, laneId)?.sessionId;
			const superseded = endingSession !== undefined && cardSession !== undefined && cardSession !== endingSession;
			if (asText(payload.reason) !== "clear" && !superseded) removeLaneCard(stateDir, laneId);
		} else if (event === "StopFailure") {
			handleStopFailure(stateDir, laneId, payload, now);
		} else {
			// A turn that ended without an API error spends no retry: the next transient error gets its resume again.
			const existingCard = readLaneCard(stateDir, laneId);
			const spent = event === "Stop" && (existingCard?.retry?.count ?? 0) > 0;
			const cycle = event === "SessionStart" && startsWorkCycle(payload.source, existingCard?.cycleStartedAt !== undefined);
			writeClaudeLaneHeartbeat(
				stateDir,
				laneId,
				{ ...heartbeatFor(payload, event, now), ...(spent ? { retry: { count: 0 } } : {}), ...(cycle ? { cycleStartedAt: now } : {}) },
				now,
			);
			// A session start is the one place a lane's new session id is known: the record's chain grows here (WP9).
			const startedSession = asText(payload.session_id);
			if (event === "SessionStart" && startedSession !== undefined) {
				try {
					recordSession(stateDir, laneId, startedSession);
				} catch (error) {
					// A record that cannot be written never blocks the lane; a store that is
					// unreachable is the entry boundary's to answer (LC0-R6, LC12).
					if (boundaryReason(error) !== undefined) throw error;
				}
			}
		}
	}

	const stopDelivery = stopMayDeliver(event, payload);
	if (!DELIVERING_EVENTS.has(event) && !stopDelivery) return 0;

	// A lane ending its turn with no report filed in this cycle is asked once for it (LD7). Read after the
	// Stop heartbeat so the card is the one just written; a subagent's boundary is not the lane's turn end.
	const nudgeCard = stopDelivery && asText(payload.agent_id) === undefined ? readLaneCard(stateDir, laneId) : undefined;
	const nudge = nudgeCard !== undefined && reportNudgeDue(laneId, { ...nudgeCard, conversation: isConversationLane(stateDir, laneId) }, { stateDir });
	// An auto lane ending its turn with no armed waiter is asked once to arm one (WP9). Same exemption as the report nudge.
	const waiterNudge = stopDelivery && asText(payload.agent_id) === undefined && !reportNudgeExempt(laneId, { stateDir }) && !waiterAlive(stateDir, laneId);
	const tabsNudge = stopDelivery && asText(payload.agent_id) === undefined ? openTabsNudgeFor(stateDir, laneId) : undefined;
	const deliveries = takePendingInboxDeliveries(stateDir, laneId);
	if (deliveries.length === 0 && !nudge && !waiterNudge && tabsNudge === undefined) return 0;

	if (stopDelivery) {
		// The turn goes on with the message or the nudge, so the lane is running, not idle.
		if (asText(payload.agent_id) === undefined) writeClaudeLaneHeartbeat(stateDir, laneId, heartbeatFor(payload, event, now, "running"), now);
		if (nudge) markReportNudged(stateDir, laneId, now);
		ctx.io.out(
			JSON.stringify({
				decision: "block",
				reason: [
					...deliveries.map((message) => formatClaudeInboxDelivery(message, laneId, "sent as your turn ended (your turn continues with it)")),
					...(nudge ? [REPORT_NUDGE_TEXT] : []),
					...(waiterNudge ? [waiterNudgeText(laneId)] : []),
					...(tabsNudge !== undefined ? [tabsNudge] : []),
				].join("\n\n"),
			}),
		);
		return 0;
	}

	ctx.io.out(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: event,
				additionalContext: deliveries.map((message) => formatClaudeInboxDelivery(message, laneId)),
			},
		}),
	);
	return 0;
}

export const command: CliCommand = {
	name: "claude-hook",
	summary: "Answer one Claude Code hook event for a bus lane (heartbeat + inbox delivery)",
	usage: [
		"muster claude-hook <event> [--lane <id> | --session <id>] [--json]",
		"muster claude-hook (--lane <id> | --session <id>) --inbox-dir",
		"  The classic Claude Code hook payload is read from stdin.",
		"  The lane is --lane, else the session's own (--session, else the payload's session_id, else CONCORD_AGENT_ID); a session no job record names but whose id is a session UUID is the operator's own session, answered with delivery only.",
		"  Inert with no lane and no the operator session: no other session is ever changed.",
		"  Prints the hook's hookSpecificOutput JSON, or nothing when there is nothing to deliver.",
		"  --inbox-dir prints the lane's pending-inbox directory and does nothing else.",
	].join("\n"),
	run,
};
