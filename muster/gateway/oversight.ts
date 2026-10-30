/**
 * Session oversight for the Grokbot gateway (the operator 2026-10-16 14:42 "build the
 * session oversight", 14:43 "add sending into my sessions"): read-only views of
 * the operator's own sessions — the lanes directory's `operator:*` rows — and one send
 * path into them.
 *
 * This module is mechanics only; the four tools (session_read, project_list's
 * register view, oversight_digest, session_send) are defined beside the other
 * gateway tools in `tools.ts`. Every owner here is reused, never re-implemented:
 *   - the lane directory names the sessions and their live state;
 *   - the transcript readers of memory/lib read the sessions
 *     (`readPiTranscript`, `readClaudeTranscript`), already sanitized per message;
 *   - the muster project catalogue (`extensions/muster/projects.ts`) is the one
 *     project register a session is tagged against, by its working directory,
 *     its repository (`git rev-parse --git-common-dir`), or the register project
 *     its recent transcript touches most — a session launched from ~ is still
 *     the salon project when it edits the salon (Henry's review, 2026-10-16 16:06);
 *   - `deliverLaneMessage` (muster/send.ts) delivers session_send. This wiring
 *     writes the lane inbox only: it never stops, resumes, relaunches or types
 *     into a the operator session (LD9, LD16), and every attempt goes to the muster
 *     send log the same as any other send.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { NormalizedTranscript, NormalizedTranscriptMessage, NormalizedTranscriptTail, TranscriptTailOptions } from "../../core/pi-ports.ts";
import { piPort } from "../../core/pi-ports.ts";
import { listDeliveredMessages, listInboxMessages, writeInboxMessage, type InboxMessage } from "../lib/agent-inbox.ts";
import { claudeProjectFolder, isBusLane, readClaudeAgentsJson, type ClaudeLaneRow, type LaneCard } from "../lib/lane-directory.ts";
import { listLaneRecords, TERMINAL_PHASES, type LanePhase, type LaneRecord } from "../lane-lifecycle.ts";
import { normalizePrimaryRoot } from "../binding.ts";
import { REPO_SOURCE_PATHS } from "../asks-import-lib.ts";
import { listOpenDecisions, type DecisionRecord } from "../decisions.ts";
import { askCodeOf, formatAskAge, formatAskLine, orderAsksForOperator, programmeCardReader, readAsks, waitingOnOperator } from "../asks.ts";
import { waiterAlive } from "../inbox-waiter.ts";
import { readSeat, SEAT_ROLES } from "../seats.ts";
import { appendSendLog, deliverLaneMessage, type PaneDelivery, type SendDeps, type SendOutcome, type SendRequest } from "../send.ts";
import type { ProjectCatalogue, ProjectRegistration } from "../projects.ts";
import { GATEWAY_AGENT_ID } from "./state.ts";
import { deniedReason, execGit, gitLogOneLine, SINCE, type GitExec } from "./knowledge.ts";
import { redactSensitiveText } from "../../core/self-improving-redactor.ts";
import { runAsReader } from "./dashboard-login.ts";
import { lastTestRunLine } from "./test-results.ts";

/** A refusal of the oversight mechanics; the tool layer turns it into a ToolRefusal. */
export class OversightError extends Error {}

/** The lanes table's ids for the operator's own sessions: `operator:<harness>:<session or unit>`. A bus lane never matches. */
export const OPERATOR_LANE = /^operator:(claude|pi|opencode|hermes):[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

/** How many transcript messages one session_read returns by default. */
export const SESSION_MESSAGES_DEFAULT = 12;
/** Characters of one transcript message kept in a session_read answer. */
const MESSAGE_RENDER_CHARS = 1200;
/** Working-tree entries listed in one session_read or digest answer. */
const MAX_STATUS_FILES = 20;
/** Commits named per project in one digest answer. */
const DIGEST_COMMITS = 5;
/** Pending and delivered inbox messages shown in one session_read answer. */
const INBOX_ITEMS = 5;
/** Characters of one inbox message kept in an answer. */
const INBOX_TEXT_CHARS = 200;
/** Characters of one inbox message kept when the caller asks for the full text (HO1). */
const INBOX_FULL_CHARS = 20_000;
/** Sessions the bus does not run as lane cards, whose transcript comes from the claude agents table by name: the architect and the orchestrator. */
const SEAT_SESSIONS = new Set(["architect", "orchestrator"]);

export type OversightToolDeps = {
	/** The machine home: the default transcript roots live under it. */
	home: string;
	/** Muster state dir: the lane inbox and the send log live under it. */
	stateDir: string;
	/** The lane directory, as `muster lanes` reads it. */
	lanes: () => LaneCard[];
	/** The project register reader (extensions/muster/projects.ts). Undefined or throwing means no register. */
	register?: () => ProjectCatalogue | undefined;
	/** Pi session JSONLs (`~/.pi/agent/sessions` by default). */
	sessionsRoot?: string;
	/** Claude transcripts (`~/.claude/projects` by default). */
	claudeProjectsRoot?: string;
	/** The transcript readers; production uses the memory owners, tests stub them. The Claude reader takes the owner's options (oversight reads the whole conversation, and the touched-file scan also the harness rows that carry the file paths). */
	readPi?: (path: string) => NormalizedTranscript | null;
	readClaude?: (path: string, options?: { allMessages?: boolean; includeSystem?: boolean }) => NormalizedTranscript | null;
	/** The tail readers (command center D10): the last N messages from the end of the file. Production uses the S4 port, tests stub them. */
	readPiTail?: (path: string, options: TranscriptTailOptions) => NormalizedTranscriptTail | null;
	readClaudeTail?: (path: string, options: TranscriptTailOptions) => NormalizedTranscriptTail | null;
	/** The claude agents table; consulted only for the architect's row, whose session id the lanes row does not carry. */
	claudeAgents?: (source?: { home?: string }) => ClaudeLaneRow[];
	/** Open decision rows per programme (extensions/muster/decisions.ts); production `listOpenDecisions`, tests a stub. */
	openDecisions?: (programmeId: string) => DecisionRecord[];
	/** The handoffs file of the operator's open items (operator-only-list.md) as its text; production reads the default path, tests a fixture. */
	operatorOnlyList?: () => string | undefined;
	/** The architect's decision record (the design session's store: the BE decision record on its docs branch) as its text; production reads the docs branch through git, tests a fixture. */
	architectDecisions?: () => string | undefined;
	/** The architect's design snapshot (design-snapshot.md) as its text; production reads the default path, tests a fixture. */
	designSnapshot?: () => string | undefined;
	/** The orchestrator snapshot (`REPO_SOURCE_PATHS.orchestratorSnapshot`) as its text; production reads that one path, tests a fixture. */
	orchestratorSnapshot?: () => string | undefined;
	/** The lane briefs (`handoffs/msgs/lane-prompt-*-<lane>-*.md`) of one lane as their texts; production reads the msgs folder beside the snapshot, tests a fixture. */
	laneBriefs?: (laneId: string) => string[];
	/** One git call; production `execGit` (a fixed argv, no shell), tests a stub. */
	git?: GitExec;
	/** One `gh` call with the token in the child's environment; production `execGh`, tests a stub (HO4 deploy states). */
	gh?: GhExec;
	/** The GitHub token through run-as; production reads the gateway's `/services` layer, absent means deploy state is not read (HO4). */
	githubToken?: () => Promise<string | undefined>;
	/** The last test run of one repository as its display line (the HO5 run ledger); absent means the HO5 reader decides, which answers "no runs recorded" until the ledger has a row. */
	lastTestRun?: (dir: string) => string | undefined;
	now?: () => Date;
	/** The delivery of one session_send; production `operatorSessionSend`, tests a stub. */
	send?: (request: SendRequest) => Promise<SendOutcome>;
};

/**
 * The sessions the oversight tools read: the operator's own (origin operator) and — read-only,
 * the orchestrator's scope addition of 2026-10-16 14:50 — the architect's own session, and
 * (HO1, 2026-10-17) the orchestrator's, so Henry can read what reaches it.
 */
function oversightRow(lanes: readonly LaneCard[], lane: string): LaneCard | undefined {
	const row = lanes.find((candidate) => candidate.laneId === lane);
	return row !== undefined && (row.origin === "operator" || SEAT_SESSIONS.has(row.laneId)) ? row : undefined;
}

/** When `since` names, as epoch ms: a date (UTC midnight), an ISO time, or "N units ago". Undefined when it is neither. */
export function sinceToMs(text: string, nowMs: number): number | undefined {
	if (!SINCE.test(text)) return undefined;
	const parsed = Date.parse(text);
	if (Number.isFinite(parsed)) return parsed;
	const match = /^(\d{1,3}) (hour|day|week|month)s? ago$/.exec(text);
	if (match === null) return undefined;
	const unitMs: Record<string, number> = { hour: 3_600_000, day: 86_400_000, week: 604_800_000, month: 2_592_000_000 };
	return nowMs - Number(match[1]) * (unitMs[match[2]!] ?? 0);
}

function age(ms: number | null | undefined, nowMs: number): string {
	if (typeof ms !== "number" || ms <= 0) return "unknown";
	const seconds = Math.max(0, Math.round((nowMs - ms) / 1000));
	if (seconds < 90) return `${seconds}s ago`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
	if (seconds < 172_800) return `${Math.round(seconds / 3600)}h ago`;
	return `${Math.round(seconds / 86_400)}d ago`;
}

/** A bus lane's review_ready report older than this, with no activity since, is unanswered (the tick parks a lane 30 minutes after its report, methodology Closure). */
export const REPORT_STALE_MS = 30 * 60_000;
/** An idle bus lane with no final report for this long is stuck (a rule HO2 proposes; it is not yet in methodology). */
export const IDLE_NO_REPORT_MS = 30 * 60_000;
/** A session with no lane record whose last transcript turn is older than this is an orphan session, not a pipeline lane (Henry 2026-10-18 04:25 item B). */
export const ORPHAN_SESSION_MS = 6 * 60 * 60_000;
/** Orphan sessions named in one line before the rest are only counted. */
const ORPHAN_LINES = 4;
/** Lane activity within this long after a report is the report's own tail, not an answer to it. */
const REPORT_SETTLE_MS = 5 * 60_000;
/** The report kinds that end a lane's work: a lane holding one is waiting for the orchestrator. */
const FINAL_REPORT_KINDS = new Set(["review_ready", "blocked", "question", "already_done", "discovery_ready"]);

/**
 * Is this lane finished? A lane record's terminal phase — merged, abandoned or closed
 * (`muster close --merged`/`--abandoned`, lane-lifecycle.ts) — means the lane's last report is
 * closed work, not an open question waiting for the orchestrator. One owner of the vocabulary:
 * `TERMINAL_PHASES` is the lifecycle record's own list.
 */
export function isFinishedLane(phase: LanePhase | undefined): boolean {
	return phase !== undefined && TERMINAL_PHASES.includes(phase);
}

/**
 * Why a row is stuck, or undefined. The one stall predicate: `oversight_digest` runs it over the
 * sessions and seats it reports, `pipeline_health` over the worker lanes. A stalled, quota-walled
 * or blocked row is stuck anywhere, a gone row when it is a session or seat. For a worker lane it
 * also catches a lane waiting, a review_ready report nobody answered within REPORT_STALE_MS, and an
 * idle lane with no final report for IDLE_NO_REPORT_MS (HO2).
 */
export function stallReason(row: LaneCard, nowMs: number): string | undefined {
	const wall = row.wall !== null && row.wall !== undefined ? ` (${row.wall.shapeId})` : "";
	if (row.state === "stalled" || row.state === "quota-walled" || row.state === "blocked") return `${row.state}${wall}`;
	if (!isBusLane(row)) return row.state === "gone" ? `gone${wall}` : undefined;
	if (isFinishedLane(row.phase)) return undefined;
	if (row.state === "waiting") return "waiting";
	if (row.state === "gone") return undefined;
	const last = row.lastActivityMs ?? row.since ?? 0;
	const report = row.lastReport;
	if (report?.kind === "review_ready" && typeof report.at === "number" && report.at > 0) {
		return nowMs - report.at > REPORT_STALE_MS && last - report.at < REPORT_SETTLE_MS ? `review_ready filed ${age(report.at, nowMs)}, unanswered (STALE)` : undefined;
	}
	if (row.state === "idle" && (report === undefined || !FINAL_REPORT_KINDS.has(report.kind)) && last > 0 && nowMs - last > IDLE_NO_REPORT_MS) {
		return `idle, last active ${age(last, nowMs)}, no report (STALE, proposed rule)`;
	}
	return undefined;
}

// ─── Session files ───────────────────────────────────────────────────────────

/** The Pi session JSONL of one session id (`<root>/<dir>/<time>_<uuid>.jsonl`), or undefined. */
export function findPiSessionFile(sessionsRoot: string, sessionId: string): string | undefined {
	if (!/^[0-9a-f-]{36}$/i.test(sessionId) || !existsSync(sessionsRoot)) return undefined;
	try {
		for (const dir of readdirSync(sessionsRoot, { withFileTypes: true })) {
			if (!dir.isDirectory()) continue;
			const sub = join(sessionsRoot, dir.name);
			try {
				const hit = readdirSync(sub).find((file) => file.endsWith(`_${sessionId}.jsonl`));
				if (hit !== undefined) return join(sub, hit);
			} catch {
				continue;
			}
		}
	} catch {
		return undefined;
	}
	return undefined;
}

/**
 * The Claude transcript of one session, by full id or by the short id a
 * `operator:claude:<8>` lane id carries, or undefined. The exact project folder
 * is tried first (Claude names it after the working directory), then every
 * project folder, so a session resumed elsewhere is still found.
 */
export function findClaudeSessionFile(root: string, cwd: string | null, sessionId: string): string | undefined {
	const prefix = sessionId.trim();
	if (!/^[0-9a-f-]{8,36}$/i.test(prefix) || !existsSync(root)) return undefined;
	if (cwd !== null && cwd !== "" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(prefix)) {
		const direct = join(root, claudeProjectFolder(cwd), `${prefix}.jsonl`);
		if (existsSync(direct)) return direct;
	}
	try {
		for (const dir of readdirSync(root, { withFileTypes: true })) {
			if (!dir.isDirectory()) continue;
			const sub = join(root, dir.name);
			try {
				const hit = readdirSync(sub).filter((file) => file.endsWith(".jsonl") && file.startsWith(prefix)).sort()[0];
				if (hit !== undefined) return join(sub, hit);
			} catch {
				continue;
			}
		}
	} catch {
		return undefined;
	}
	return undefined;
}

// ─── Project tagging ─────────────────────────────────────────────────────────

/**
 * The project a working directory belongs to: a register project whose
 * checkout root or repository main checkout contains it, else the register
 * project whose repository the directory's worktree belongs to, else an
 * unregistered group named after the directory's repository (or the directory
 * itself when it is not a working tree).
 */
export async function projectForCwd(cwd: string, deps: Pick<OversightToolDeps, "register" | "git">): Promise<{ name: string; registered: boolean; repoKey?: string }> {
	const catalogue = deps.register?.();
	if (catalogue !== undefined) {
		for (const project of catalogue.projects) {
			for (const programme of project.programmes) {
				const roots = [programme.checkoutRoot, normalizePrimaryRoot(programme.repoKey)];
				if (roots.some((root) => root !== "" && (cwd === root || cwd.startsWith(root + sep)))) return { name: project.name, registered: true, repoKey: programme.repoKey };
			}
		}
	}
	const git = deps.git ?? execGit;
	const common = await git(["rev-parse", "--git-common-dir"], cwd).then((out) => resolve(cwd, out.trim())).catch(() => undefined);
	if (catalogue !== undefined && common !== undefined) {
		for (const project of catalogue.projects) {
			for (const programme of project.programmes) {
				if (programme.repoKey === common) return { name: project.name, registered: true, repoKey: programme.repoKey };
			}
		}
	}
	return { name: basename(common !== undefined ? normalizePrimaryRoot(common) : cwd), registered: false };
}

type ProjectTag = { name: string; registered: boolean; repoKey?: string };

/**
 * The project one session belongs to: its working directory first (a register root or its
 * repository), then — Henry's review of 2026-10-16 16:06: tag by the repo the session
 * touches, not the exact cwd — the register project its transcript names most.
 * Memoized per lane, so a digest reads each session once.
 */
function sessionTagger(deps: OversightToolDeps): (row: LaneCard) => Promise<ProjectTag> {
	const cache = new Map<string, Promise<ProjectTag>>();
	return (row) => {
		const hit = cache.get(row.laneId);
		if (hit !== undefined) return hit;
		const fresh = (async (): Promise<ProjectTag> => {
			const byCwd: ProjectTag = row.cwd === null || row.cwd === undefined ? { name: "(no working dir)", registered: false } : await projectForCwd(row.cwd, deps).catch(() => ({ name: basename(row.cwd!), registered: false }));
			if (byCwd.registered) return byCwd;
			const catalogue = deps.register?.();
			if (catalogue === undefined) return byCwd;
			const roots: Array<{ name: string; root: string; repoKey: string }> = [];
			for (const project of catalogue.projects) {
				for (const programme of project.programmes) {
					for (const root of [programme.checkoutRoot, normalizePrimaryRoot(programme.repoKey)]) {
						if (root !== "") roots.push({ name: project.name, root, repoKey: programme.repoKey });
					}
				}
			}
			const transcript = await sessionTranscript(deps, row.laneId, row, { includeSystem: true });
			const counts = new Map<string, { hits: number; repoKey: string }>();
			for (const message of transcript.transcript?.messages ?? []) {
				for (const candidate of roots) {
					if (!message.content.includes(candidate.root)) continue;
					const seen = counts.get(candidate.name);
					if (seen === undefined) counts.set(candidate.name, { hits: 1, repoKey: candidate.repoKey });
					else seen.hits += 1;
				}
			}
			let best: { name: string; hits: number; repoKey: string } | undefined;
			for (const [name, count] of counts) {
				if (best === undefined || count.hits > best.hits) best = { name, ...count };
			}
			return best === undefined ? byCwd : { name: best.name, registered: true, repoKey: best.repoKey };
		})();
		cache.set(row.laneId, fresh);
		return fresh;
	};
}

// ─── Git view of one working directory ───────────────────────────────────────

async function gitView(cwd: string, deps: OversightToolDeps): Promise<{ repo: string; branch?: string; changedCount: number; changedFiles: string[]; recentCommits?: string[] } | null> {
	const git = deps.git ?? execGit;
	const repo = await git(["rev-parse", "--show-toplevel"], cwd).then((out) => out.trim()).catch(() => undefined);
	if (repo === undefined) return null;
	const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd).then((out) => out.trim()).catch(() => undefined);
	const status = await git(["status", "--porcelain"], cwd).catch(() => undefined);
	const lines = (status ?? "").split("\n").filter((line) => line.trim() !== "");
	let recentCommits: string[] | undefined;
	try {
		const log = await gitLogOneLine({ name: basename(cwd), dir: cwd }, { limit: 5 }, git, deps.home);
		recentCommits = log === "no commits" ? undefined : log.split("\n");
	} catch {
		recentCommits = undefined;
	}
	return {
		repo,
		...(branch !== undefined && branch !== "" ? { branch } : {}),
		changedCount: lines.length,
		changedFiles: lines.slice(0, MAX_STATUS_FILES).map((line) => line.slice(3).trim()),
		...(recentCommits !== undefined ? { recentCommits } : {}),
	};
}

// ─── session_read ────────────────────────────────────────────────────────────

/**
 * One readable session's transcript through the memory owners: a Pi row by its
 * session id; a Claude row by its own id or the short id in the lane id; and the
 * architect's row, whose session id the lanes row does not carry, from the claude
 * agents table. Undefined with a note when there is no readable transcript.
 */
async function sessionTranscript(deps: OversightToolDeps, lane: string, row: Pick<LaneCard, "laneId" | "harness" | "sessionId" | "cwd">, readOptions?: { includeSystem?: boolean; tail?: TranscriptTailOptions }): Promise<{ transcript?: NormalizedTranscript; tail?: NormalizedTranscriptTail; notes: string[] }> {
	const notes: string[] = [];
	if (row.harness === "pi") {
		const sessionId = row.sessionId;
		if (sessionId === undefined || sessionId === "") {
			notes.push("the lanes row carries no Pi session id, so there is no transcript to read");
			return { notes };
		}
		const file = findPiSessionFile(deps.sessionsRoot ?? join(deps.home, ".pi", "agent", "sessions"), sessionId);
		if (file === undefined) {
			notes.push(`no Pi session JSONL found for ${sessionId}`);
			return { notes };
		}
		if (readOptions?.tail !== undefined) {
			const tail = cachedTail(deps, "pi", file, readOptions.tail, deps.readPiTail ?? piPort("transcripts").readPiTranscriptTail);
			if (tail === null) {
				notes.push(`the Pi transcript at ${file} could not be read`);
				return { notes };
			}
			return { transcript: tail.transcript, tail, notes };
		}
		const read = deps.readPi ?? piPort("transcripts").readPiTranscript;
		const parsed = read(file);
		if (parsed === null) {
			notes.push(`the Pi transcript at ${file} could not be read`);
			return { notes };
		}
		return { transcript: parsed, notes };
	}
	if (row.harness === "claude") {
		let sessionId: string | undefined = row.sessionId;
		if ((sessionId === undefined || sessionId === "") && lane.startsWith("operator:claude:")) sessionId = lane.slice("operator:claude:".length);
		if ((sessionId === undefined || sessionId === "") && SEAT_SESSIONS.has(row.laneId)) {
			try {
				sessionId = (deps.claudeAgents ?? readClaudeAgentsJson)({}).find((agent) => agent.name === row.laneId)?.sessionId;
			} catch {
				sessionId = undefined;
			}
			if (sessionId === undefined || sessionId === "") notes.push(`the ${row.laneId} session id could not be read from the claude agents table`);
		}
		if (sessionId === undefined || sessionId === "") {
			if (notes.length === 0) notes.push("the lanes row carries no Claude session id, so there is no transcript to read");
			return { notes };
		}
		const file = findClaudeSessionFile(deps.claudeProjectsRoot ?? join(deps.home, ".claude", "projects"), row.cwd ?? null, sessionId);
		if (file === undefined) {
			notes.push(`no Claude transcript found for ${sessionId}`);
			return { notes };
		}
		if (readOptions?.tail !== undefined) {
			const tail = cachedTail(deps, "claude", file, readOptions.tail, deps.readClaudeTail ?? piPort("transcripts").readClaudeTranscriptTail);
			if (tail === null) {
				notes.push(`the Claude transcript at ${file} could not be read`);
				return { notes };
			}
			return { transcript: tail.transcript, tail, notes };
		}
		const read = deps.readClaude ?? piPort("transcripts").readClaudeTranscript;
		// The whole conversation, not only the live window: a session that compacted recently
		// would otherwise show no user turns at all, and the project it works on lives in the
		// turns before the cut (Henry's review, 2026-10-16 16:06). The touched-file scan adds
		// includeSystem: the file paths a session worked on often sit only in its harness rows
		// (task notifications, compaction summaries), which the conversation view rightly hides.
		const parsed = read(file, { allMessages: true, ...(readOptions ?? {}) });
		if (parsed === null) {
			notes.push(`the Claude transcript at ${file} could not be read`);
			return { notes };
		}
		return { transcript: parsed, notes };
	}
	notes.push(`no transcript reader is wired for harness '${row.harness}' rows; the lanes row is all the bus knows`);
	return { notes };
}

function renderMessage(message: NormalizedTranscriptMessage): { role: "user" | "assistant"; speaker?: string; at?: string; content: string } {
	return {
		role: message.role,
		...(message.speaker !== undefined ? { speaker: message.speaker } : {}),
		...(message.timestamp !== undefined ? { at: new Date(message.timestamp).toISOString() } : {}),
		content: message.content.length > MESSAGE_RENDER_CHARS ? `${message.content.slice(0, MESSAGE_RENDER_CHARS)}… [+${message.content.length - MESSAGE_RENDER_CHARS} chars]` : message.content,
	};
}

function renderTail(messages: readonly NormalizedTranscriptMessage[], limit: number): unknown[] {
	return messages.slice(-limit).map(renderMessage);
}

// ─── The live session of a lane (command center WPF, D10) ────────────────────

/** Tail reads kept per oversight deps, so a page refreshing every 10 s does not re-read a file that has not changed. */
const TAIL_CACHE_ENTRIES = 32;
const tailCaches = new WeakMap<object, Map<string, NormalizedTranscriptTail | null>>();

/** A tail read, reused while the file's path, size and modification time and the window asked for are unchanged. */
function cachedTail(deps: OversightToolDeps, harness: string, file: string, options: TranscriptTailOptions, read: (path: string, options: TranscriptTailOptions) => NormalizedTranscriptTail | null): NormalizedTranscriptTail | null {
	let key: string | undefined;
	try {
		const stat = statSync(file);
		key = `${harness}|${file}|${stat.size}|${stat.mtimeMs}|${options.limit}|${options.endOffset ?? ""}`;
	} catch {
		key = undefined;
	}
	let cache = tailCaches.get(deps);
	if (cache === undefined) tailCaches.set(deps, (cache = new Map()));
	if (key !== undefined && cache.has(key)) return cache.get(key)!;
	const fresh = read(file, options);
	if (key !== undefined) {
		cache.set(key, fresh);
		if (cache.size > TAIL_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
	}
	return fresh;
}

export type LaneTail = {
	lane: string;
	readAt: string;
	/** The session's message count, known only when one read reached the start of the file with no `before`; otherwise null. */
	total: number | null;
	/** True when older messages exist, or may exist because the read stopped before the start of the file. */
	hasMore: boolean;
	/** Oldest first. `index` is the byte offset of the message's row: pass the first message's index as `before` for the page before it. */
	messages: Array<{ index: number; role: "user" | "assistant"; speaker?: string; at?: string; content: string }>;
	notes: string[];
};

/** The row a live-session read follows: a worker lane the directory lists, or a seat role's holder. the operator's own sessions and anything unlisted are not served. */
function tailRow(deps: OversightToolDeps, laneId: string): Pick<LaneCard, "laneId" | "harness" | "sessionId" | "cwd"> | undefined {
	if ((SEAT_ROLES as readonly string[]).includes(laneId)) {
		try {
			const holder = readSeat(laneId, { stateDir: deps.stateDir }).holder;
			if (holder === null) return undefined;
			const card = holder.laneId !== undefined ? deps.lanes().find((candidate) => candidate.laneId === holder.laneId) : undefined;
			return { laneId, harness: holder.harness, sessionId: holder.sessionId, cwd: card?.cwd ?? null };
		} catch {
			return undefined;
		}
	}
	const card = deps.lanes().find((candidate) => candidate.laneId === laneId);
	return card === undefined || card.origin === "operator" ? undefined : card;
}

/**
 * The last `limit` messages of one lane's session, or the `limit` before the message `before` names, read from the end of the file through the
 * transcript port (never the whole file), rendered as `session_read` renders them. Undefined for a lane this view does not serve.
 */
export async function laneTranscriptTail(deps: OversightToolDeps, laneId: string, query: { limit: number; before?: number }): Promise<LaneTail | undefined> {
	const row = tailRow(deps, laneId);
	if (row === undefined) return undefined;
	const parsed = await sessionTranscript(deps, laneId, row, { tail: { limit: query.limit, ...(query.before !== undefined ? { endOffset: query.before } : {}) } });
	const readAt = (deps.now?.() ?? new Date()).toISOString();
	const tail = parsed.tail;
	if (tail === undefined) return { lane: laneId, readAt, total: null, hasMore: false, messages: [], notes: parsed.notes };
	return {
		lane: laneId,
		readAt,
		total: tail.reachedStart && query.before === undefined ? tail.windowCount : null,
		hasMore: tail.olderInWindow || !tail.reachedStart,
		messages: tail.transcript.messages.map((message, position) => ({ index: tail.offsets[position]!, ...renderMessage(message) })),
		notes: parsed.notes,
	};
}

/**
 * The lane inbox of one session, as session_read shows it: pending (written, not yet read
 * into the chat) and delivered (read). Both listings come from the inbox owner, so this
 * reads the same records in either backend.
 */
function sessionInbox(stateDir: string, lane: string, options: { full?: boolean; items?: number } = {}): Array<{ id?: string; from: string; at: string; state: "pending" | "delivered"; text: string }> {
	const items = options.items ?? INBOX_ITEMS;
	// Full text (HO1): each message up to INBOX_FULL_CHARS, with its id; a longer one is cut and says by how much.
	const render = (message: InboxMessage, state: "pending" | "delivered") => ({
		...(options.full === true ? { id: message.id } : {}),
		from: message.from,
		at: message.at,
		state,
		text:
			options.full === true
				? message.text.length > INBOX_FULL_CHARS
					? `${message.text.slice(0, INBOX_FULL_CHARS)}… [+${message.text.length - INBOX_FULL_CHARS} chars]`
					: message.text
				: message.text.length > INBOX_TEXT_CHARS
					? `${message.text.slice(0, INBOX_TEXT_CHARS)}…`
					: message.text,
	});
	const pending = listInboxMessages(stateDir, lane).slice(-items).map((message) => render(message, "pending"));
	const delivered = listDeliveredMessages(stateDir, lane, items).map((message) => render(message, "delivered"));
	return [...pending, ...delivered];
}

/**
 * The full session_read answer for one the operator session: working dir, project,
 * git repo and branch, changed files, last activity and the last messages from
 * the session's transcript, through the memory owners (already sanitized per
 * message; the server redacts the whole answer again on the way out).
 */
export async function sessionEvidence(deps: OversightToolDeps, lane: string, limit: number, inbox?: { full?: boolean; items?: number }): Promise<string> {
	const row = oversightRow(deps.lanes(), lane);
	if (row === undefined) {
		const listed = deps.lanes().find((candidate) => candidate.laneId === lane);
		throw new OversightError(listed !== undefined ? `${lane} is a bus lane; the oversight tools read the operator's own sessions, the architect and the orchestrator only` : `unknown session ${lane}: no such row in the lanes table`);
	}
	const now = deps.now?.() ?? new Date();
	const notes: string[] = [];
	const cwd = row.cwd ?? undefined;
	const denied = cwd !== undefined ? deniedReason(cwd, deps.home) : undefined;
	const tag = await sessionTagger(deps)(row);
	let git = cwd !== undefined && denied === undefined ? await gitView(cwd, deps) : null;
	if (denied !== undefined) notes.push(`the working directory is on the read denylist (${denied}); its git repo was not read`);
	// A session launched from ~ works in no repository of its own: the branch shown is the
	// tagged project's, and the note says so (Henry's review, 2026-10-16 16:06).
	if (git === null && denied === undefined && tag.registered && tag.repoKey !== undefined) {
		const projectGit = await gitView(normalizePrimaryRoot(tag.repoKey), deps);
		if (projectGit !== null) {
			notes.push(`the working directory is not a repository; git answers for the session's project (${tag.name})`);
			git = projectGit;
		}
	}

	const parsed = await sessionTranscript(deps, lane, row);
	notes.push(...parsed.notes);
	const session = parsed.transcript?.sessionId;
	const allMessages = parsed.transcript?.messages ?? [];
	const rendered = renderTail(allMessages, limit);
	const transcript = parsed.transcript !== undefined ? { from: parsed.transcript.startTime, to: parsed.transcript.endTime, messages: rendered } : undefined;
	// Every human user turn of the session, with its timestamp (Henry's review, 2026-10-16 17:10,
	// F6.2): a long autonomous stretch leaves the tail all-assistant, and a harness record must
	// never stand in for the person's turns, so the person's own words are listed whole. An agent
	// relay (speaker "agent") and a harness row (speaker "system") are not human turns.
	const userTurns = allMessages
		.filter((message) => message.role === "user" && message.speaker !== "agent" && message.speaker !== "system")
		.map((message) => ({
			...(message.timestamp !== undefined ? { at: new Date(message.timestamp).toISOString() } : {}),
			content: message.content.length > MESSAGE_RENDER_CHARS ? `${message.content.slice(0, MESSAGE_RENDER_CHARS)}… [+${message.content.length - MESSAGE_RENDER_CHARS} chars]` : message.content,
		}));
	const inboxMessages = sessionInbox(deps.stateDir, lane, inbox);

	return JSON.stringify(
		{
			lane,
			harness: row.harness,
			state: row.state,
			...(cwd !== undefined ? { cwd } : {}),
			project: tag,
			...(git !== null ? { git } : {}),
			...(session !== undefined ? { session } : {}),
			...(transcript !== undefined ? { transcript } : {}),
			...(userTurns.length > 0 ? { userTurns } : {}),
			...(inboxMessages.length > 0 ? { inbox: inboxMessages } : {}),
			lastActivity: typeof row.lastActivityMs === "number" && row.lastActivityMs > 0 ? new Date(row.lastActivityMs).toISOString() : null,
			alive: row.alive ?? null,
			...(notes.length > 0 ? { notes } : {}),
		},
		null,
		2,
	);
}

// ─── project_list's register view ────────────────────────────────────────────

/**
 * The project register with every the operator session tagged to its project, and
 * the sessions no register project claims. Read-only; the register itself is
 * never written here.
 */
export async function projectOverview(deps: OversightToolDeps): Promise<string> {
	const now = deps.now?.() ?? new Date();
	const rows = deps.lanes().filter((row) => row.origin === "operator");
	const tag = sessionTagger(deps);
	const catalogue = deps.register?.();
	const lines: string[] = [];
	if (catalogue !== undefined && catalogue.projects.length > 0) {
		lines.push("projects (the muster project register):");
		for (const project of catalogue.projects) {
			lines.push(project.name);
			const roots = [...new Set(project.programmes.flatMap((programme) => [programme.checkoutRoot, normalizePrimaryRoot(programme.repoKey)]))];
			for (const root of roots) lines.push(`  roots: ${root}`);
			const tagged: string[] = [];
			for (const row of rows) {
				const where = await tag(row);
				if (where?.registered === true && where.name === project.name) tagged.push(`${row.laneId} (${row.state}, active ${age(row.lastActivityMs, now.getTime())})`);
			}
			lines.push(tagged.length > 0 ? `  sessions: ${tagged.join(", ")}` : "  sessions: none");
		}
	} else {
		lines.push("projects: the muster project register is empty or unreadable");
	}
	const untagged: string[] = [];
	for (const row of rows) {
		const where = await tag(row);
		if (where?.registered !== true) untagged.push(`  ${row.laneId}\t${row.cwd ?? "(no working dir)"}\t${row.state}`);
	}
	if (untagged.length > 0) {
		lines.push("sessions with no registered project:");
		lines.push(...untagged);
	}
	return lines.join("\n");
}

// ─── oversight_digest ────────────────────────────────────────────────────────

/**
 * Per project, since T: the the operator sessions active, the project's commits and
 * working tree, and — regardless of since — anything stuck or erroring. Bus
 * lanes are the orchestrator's business and are not part of the digest.
 */
export async function oversightDigest(deps: OversightToolDeps, sinceText: string): Promise<string> {
	const now = deps.now?.() ?? new Date();
	const sinceMs = sinceToMs(sinceText, now.getTime());
	if (sinceMs === undefined) throw new OversightError("since must be YYYY-MM-DD, an ISO time, or like '6 hours ago'");
	const rows = deps.lanes().filter((row) => row.origin === "operator" || row.laneId === "architect" || row.laneId === "orchestrator");
	const tag = sessionTagger(deps);
	const git = deps.git ?? execGit;

	const groups = new Map<string, { label: string; registered: boolean; repoKey?: string; rows: LaneCard[] }>();
	for (const row of rows) {
		const where = await tag(row);
		const key = `${where.registered ? "registered" : "unregistered"}:${where.name}`;
		const group = groups.get(key) ?? { label: where.registered ? where.name : `unregistered (${where.name})`, registered: where.registered, ...(where.repoKey !== undefined ? { repoKey: where.repoKey } : {}), rows: [] };
		group.rows.push(row);
		groups.set(key, group);
	}
	// Every register project reports, even with no session of its own: "what changed" is a question
	// about the project, not only about the sessions in it.
	try {
		for (const project of deps.register?.()?.projects ?? []) {
			const key = `registered:${project.name}`;
			if (!groups.has(key)) groups.set(key, { label: project.name, registered: true, ...(project.programmes[0] !== undefined ? { repoKey: project.programmes[0]!.repoKey } : {}), rows: [] });
		}
	} catch {
		// A register that cannot be read leaves the session groups alone.
	}

	const lines: string[] = [`oversight digest since ${sinceText} (${new Date(sinceMs).toISOString()})`];
	for (const group of [...groups.values()].sort((a, b) => a.label.localeCompare(b.label))) {
		const active = group.rows.filter((row) => (row.lastActivityMs ?? row.since ?? 0) >= sinceMs);
		if (!group.registered && active.length === 0) continue;
		lines.push(group.label);
		lines.push(active.length > 0 ? `  sessions active since then: ${active.map((row) => `${row.laneId} (${row.state}, active ${age(row.lastActivityMs, now.getTime())})`).join(", ")}` : "  sessions active since then: none");
		if (group.registered && group.repoKey !== undefined) {
			const repoDir = normalizePrimaryRoot(group.repoKey);
			try {
				const log = await gitLogOneLine({ name: group.label, dir: repoDir }, { limit: DIGEST_COMMITS, since: sinceText }, git, deps.home);
				const commits = log === "no commits" ? [] : log.split("\n");
				lines.push(`  commits since then: ${commits.length}`);
				for (const commit of commits) lines.push(`    ${commit}`);
			} catch (error) {
				lines.push(`  commits since then: unknown (${error instanceof Error ? error.message : "git failed"})`);
			}
			const status = await git(["status", "--porcelain"], repoDir).catch(() => undefined);
			if (status !== undefined) {
				const changed = status.split("\n").filter((line) => line.trim() !== "");
				lines.push(`  working tree: ${changed.length} file(s) changed`);
			}
		}
	}

	const stuck = rows.flatMap((row) => {
		const reason = stallReason(row, now.getTime());
		return reason === undefined ? [] : [{ row, reason }];
	});
	if (stuck.length > 0) {
		lines.push("stuck or erroring:");
		for (const { row, reason } of stuck) lines.push(`  ${row.laneId} ${reason}${row.lastActivityMs ? `, active ${age(row.lastActivityMs, now.getTime())}` : ""}`);
	} else {
		lines.push("stuck or erroring: none");
	}
	return lines.join("\n");
}

// ─── pipeline_health ─────────────────────────────────────────────────────────

/** How many worker lanes should be running (the operator 2026-10-16 20:59 and 2026-10-17 22:43). */
export const PIPELINE_TARGET = { min: 4, max: 5 } as const;
/** The answer is cut here; each section also limits its own lines, so the cut should not fire. */
const PIPELINE_MAX_CHARS = 4000;
/** Branches named per repository in the unpushed section, the largest first. */
const UNPUSHED_BRANCHES = 3;
/** Characters the unpushed section may take, so the plan section after it is never cut. */
const UNPUSHED_CHARS = 1900;
/** Plan items named per class in the plan section. */
const PLAN_ITEMS_SHOWN = 8;
/** Code tokens such as P6, UM14, RS3, VR15a. */
const PLAN_CODE = /\b[A-Z]{1,4}\d+[a-z]?\b/g;

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;
const clip = (text: string, chars: number): string => (text.length > chars ? `${text.slice(0, chars)}…` : text);

/**
 * The state of every local branch of one repository against its remotes, read-only git through the
 * caller's `git`. `kind`: "ahead" holds commits the upstream lacks (optionally also behind),
 * "unpushed" has no usable upstream and commits on no remote branch, "behind" is only behind.
 * HO2's unpushed section filters the behind rows out; HO4's `repo_status` lists them all.
 */
export type UnpushedBranch = {
	branch: string;
	/** Commits no remote has: 0 for a branch that is only behind. */
	count: number;
	text: string;
	kind: "ahead" | "unpushed" | "behind";
	/** Commits the branch is behind its upstream, when it is behind at all. */
	behindCount?: number;
};

export async function unpushedByBranch(git: GitExec, dir: string): Promise<UnpushedBranch[]> {
	const refs = await git(["for-each-ref", "--format=%(refname)%09%(upstream:short)%09%(upstream:track)", "refs/heads"], dir);
	const checks = refs
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map(async (line): Promise<UnpushedBranch | undefined> => {
			const [ref = "", upstream = "", track = ""] = line.split("\t");
			const branch = ref.replace(/^refs\/heads\//, "");
			if (upstream !== "" && !/gone/.test(track)) {
				const ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0);
				const behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0);
				if (ahead === 0 && behind === 0) return undefined;
				if (ahead === 0) return { branch, count: 0, kind: "behind", behindCount: behind, text: `${branch}: ${plural(behind, "commit")} behind ${upstream}` };
				return {
					branch,
					count: ahead,
					kind: "ahead",
					...(behind > 0 ? { behindCount: behind } : {}),
					text: `${branch}: ${plural(ahead, "commit")} ahead of ${upstream}${behind > 0 ? `, ${plural(behind, "commit")} behind` : ""}`,
				};
			}
			// The full ref name: a branch called like a file or another ref would make the short name ambiguous.
			const count = Number((await git(["rev-list", "--count", ref, "--not", "--remotes"], dir)).trim());
			return count > 0 ? { branch, count, kind: "unpushed", text: `${branch}: ${plural(count, "commit")} not on any remote branch` } : undefined;
		});
	return (await Promise.all(checks)).filter((entry): entry is UnpushedBranch => entry !== undefined).sort((a, b) => b.count - a.count || a.branch.localeCompare(b.branch));
}

/** Unpushed commits one repository holds, summed over its branches (a commit on two branches counts twice: the figure is per branch). */
function unpushedTotal(result: { branches: UnpushedBranch[] }): number {
	return result.branches.reduce((sum, entry) => sum + entry.count, 0);
}

/** Every repository of the project register: every programme of every project, once per checkout. */
export function registerRepos(deps: Pick<OversightToolDeps, "register">): Array<{ project: string; programmeId: string; dir: string }> {
	const repos: Array<{ project: string; programmeId: string; dir: string }> = [];
	const seen = new Set<string>();
	for (const project of deps.register?.()?.projects ?? []) {
		for (const programme of project.programmes) {
			const dir = normalizePrimaryRoot(programme.repoKey);
			if (dir === "" || seen.has(dir)) continue;
			seen.add(dir);
			repos.push({ project: project.name, programmeId: programme.programmeId, dir });
		}
	}
	return repos;
}

/** The snapshot's items under `## Next` and `## Open promises`: one per numbered or bulleted line, indented lines joined to it. */
export function planItems(snapshot: string): string[] {
	const items: string[] = [];
	let inSection = false;
	for (const line of snapshot.split("\n")) {
		if (/^##\s/.test(line)) {
			inSection = /^##\s+(Next|Open promises)\b/i.test(line);
			continue;
		}
		if (!inSection) continue;
		const start = /^(?:\d+\.|[-*])\s+(.*)$/.exec(line);
		if (start !== null) items.push(start[1]!.trim());
		else if (/^\s+\S/.test(line) && items.length > 0) items[items.length - 1] += ` ${line.trim()}`;
	}
	return items;
}

function readOrchestratorSnapshot(home: string): string | undefined {
	try {
		return readFileSync(join(home, ".pi", "agent", REPO_SOURCE_PATHS.orchestratorSnapshot), "utf8");
	} catch {
		return undefined;
	}
}

/** The file name of a lane's brief, `lane-prompt-*-<lane>-*.md`: the one pattern `readLaneBriefs` and the lane history's `briefPath` both match. */
export function laneBriefNamePattern(laneId: string): RegExp {
	return new RegExp(`^lane-prompt-(?:.+-)?${laneId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:-.*)?\\.md$`);
}

/** The lane's briefs, `lane-prompt-*-<lane>-*.md`, from the msgs folder beside the orchestrator snapshot, in file-name order (the newest brief is last). */
export function readLaneBriefs(home: string, laneId: string): string[] {
	const dir = join(dirname(join(home, ".pi", "agent", REPO_SOURCE_PATHS.orchestratorSnapshot)), "msgs");
	const name = laneBriefNamePattern(laneId);
	try {
		return readdirSync(dir)
			.filter((file) => name.test(file))
			.sort()
			.map((file) => readFileSync(join(dir, file), "utf8"));
	} catch {
		return [];
	}
}

/** The part of a brief that names the work: its header up to the first field that cites rules, owners or paths. */
export function briefOutcome(brief: string): string {
	const end = brief.search(/^(?:Cut from|Owned paths|Decisions|Owners|Rules):/m);
	return end > 0 ? brief.slice(0, end) : brief;
}

/** The lane records by lane id, through the lifecycle store's own reader; undefined when that store cannot be read. */
function laneRecords(deps: OversightToolDeps): Map<string, LaneRecord> | undefined {
	try {
		return new Map(listLaneRecords(deps.stateDir).map((record) => [record.laneId, record]));
	} catch {
		return undefined;
	}
}

/**
 * Is this an orphan session: a row the bus never launched (no lane record), whose last transcript
 * turn is older than `ORPHAN_SESSION_MS`? A record-less row that ended on a final report is a real
 * unanswered handoff, and stays in the report list; a row that cannot say when it last worked is
 * never called an orphan.
 */
function isOrphanSession(row: LaneCard, records: ReadonlyMap<string, LaneRecord>, finished: ReadonlySet<string>, nowMs: number): boolean {
	const last = typeof row.lastActivityMs === "number" ? row.lastActivityMs : 0;
	if (last <= 0 || nowMs - last <= ORPHAN_SESSION_MS) return false;
	if (records.has(row.laneId) || finished.has(row.laneId)) return false;
	return row.lastReport === undefined || !FINAL_REPORT_KINDS.has(row.lastReport.kind);
}

/**
 * One answer to "is the pipeline moving": the worker lanes against the target band, stalls first;
 * the commits each register repository holds that no remote has; and the plan items no live lane
 * covers. Read-only, plain text, about 4 KB. Deployed state is not read (no token, VC2).
 */
export async function pipelineHealth(deps: OversightToolDeps): Promise<string> {
	const now = deps.now?.() ?? new Date();
	const nowMs = now.getTime();
	const git = deps.git ?? execGit;
	const lanes = deps.lanes().filter(isBusLane);
	const lines: string[] = [`pipeline health at ${now.toISOString()}`];

	// A lane whose record is terminal (merged, abandoned, closed) is finished work, not an open
	// report (the live rows pi-ho3, labfix, pii1 kept their review_ready report past their close,
	// Henry 2026-10-18 04:25 item B). A session with no lane record whose last transcript turn is
	// hours old is an orphan session, not a pipeline lane.
	const records = laneRecords(deps);
	const finished = new Set(
		lanes
			.filter((row) => isFinishedLane(row.phase) || (records !== undefined && isFinishedLane(records.get(row.laneId)?.phase)))
			.map((row) => row.laneId),
	);
	const orphaned = records === undefined ? [] : lanes.filter((row) => isOrphanSession(row, records, finished, nowMs));
	const orphans = new Set(orphaned.map((row) => row.laneId));
	const open = lanes.filter((row) => !finished.has(row.laneId) && !orphans.has(row.laneId));

	// 1. Lanes against the target.
	const running = open.filter((row) => row.state === "running" && row.harness !== "unknown");
	const band = running.length < PIPELINE_TARGET.min ? " (below target)" : running.length > PIPELINE_TARGET.max ? " (above target)" : "";
	lines.push(`lanes running: ${running.length} of target ${PIPELINE_TARGET.min}–${PIPELINE_TARGET.max}${band}`);
	const stuck = open.flatMap((row) => {
		const reason = stallReason(row, nowMs);
		return reason === undefined ? [] : [{ row, reason }];
	});
	const flagged = new Set(stuck.map(({ row }) => row.laneId));
	if (stuck.length > 0) {
		lines.push("  stalled or waiting:");
		for (const { row, reason } of stuck.slice(0, 10)) lines.push(`    ${row.laneId} ${reason}`);
		if (stuck.length > 10) lines.push(`    +${stuck.length - 10} more`);
	} else {
		lines.push("  stalled or waiting: none");
	}
	if (orphaned.length > 0) {
		const named = orphaned.slice(0, ORPHAN_LINES).map((row) => `${row.laneId} (${row.harness}, ${row.cwd ?? "no working dir"}, last active ${age(row.lastActivityMs, nowMs)})`);
		lines.push(`  orphan sessions: ${named.join(", ")}${orphaned.length > ORPHAN_LINES ? ` +${orphaned.length - ORPHAN_LINES} more` : ""}`);
	}
	const idle = open.filter((row) => row.state === "idle" && !flagged.has(row.laneId));
	for (const row of idle.slice(0, 8)) lines.push(`  idle: ${row.laneId}, last active ${age(row.lastActivityMs ?? row.since, nowMs)}`);
	const reported = open.filter((row) => !flagged.has(row.laneId) && row.lastReport !== undefined && ["review_ready", "blocked", "question"].includes(row.lastReport.kind));
	for (const row of reported.slice(0, 8)) lines.push(`  report: ${row.laneId} ${row.lastReport!.kind} ${age(row.lastReport!.at, nowMs)}: ${clip(row.lastReport!.summary, 80)}`);
	if (running.length > 0) lines.push(`  running: ${running.map((row) => `${row.laneId} (active ${age(row.lastActivityMs, nowMs)})`).join(", ")}`);

	// 2. Unpushed commits, every programme of every register project.
	lines.push("unpushed commits:");
	let repos: ReturnType<typeof registerRepos> = [];
	try {
		repos = registerRepos(deps);
	} catch {
		// A register that cannot be read says so below.
	}
	if (repos.length === 0) lines.push("  the project register is empty or unreadable");
	const perRepo = await Promise.all(
		repos.map(async (repo): Promise<{ repo: (typeof repos)[number]; branches: UnpushedBranch[]; error?: string }> => {
			try {
				// Behind-only branches are not unpushed work; repo_status lists them, this section does not.
				return { repo, branches: (await unpushedByBranch(git, repo.dir)).filter((entry) => entry.kind !== "behind") };
			} catch (error) {
				return { repo, branches: [], error: error instanceof Error ? error.message : "git failed" };
			}
		}),
	);
	// Largest holdings first; a repository with nothing unpushed is one line at the end.
	const holding = perRepo.filter((result) => result.branches.length > 0).sort((a, b) => unpushedTotal(b) - unpushedTotal(a));
	const failed = perRepo.filter((result) => result.error !== undefined);
	const clean = perRepo.filter((result) => result.error === undefined && result.branches.length === 0);
	const sameName = (name: string) => repos.filter((repo) => repo.project === name).length > 1;
	const labelOf = (repo: (typeof repos)[number]) => (sameName(repo.project) ? `${repo.project}/${basename(repo.dir)}` : repo.project);
	const section: string[] = [];
	for (const result of holding) {
		const total = unpushedTotal(result);
		section.push(`  ${labelOf(result.repo)}: ${result.branches.length} ${result.branches.length === 1 ? "branch" : "branches"}, ${plural(total, "commit")}`);
		for (const entry of result.branches.slice(0, UNPUSHED_BRANCHES)) section.push(`    ${entry.text}`);
		if (result.branches.length > UNPUSHED_BRANCHES) section.push(`    +${result.branches.length - UNPUSHED_BRANCHES} more branches`);
	}
	for (const result of failed) section.push(`  ${labelOf(result.repo)}: unknown (${clip(result.error ?? "git failed", 70)})`);
	if (clean.length > 0) section.push(`  nothing unpushed: ${clean.map((result) => labelOf(result.repo)).join(", ")}`);
	let used = 0;
	for (const [index, line] of section.entries()) {
		used += line.length + 1;
		if (used > UNPUSHED_CHARS) {
			lines.push(`  …${section.length - index} more lines cut`);
			break;
		}
		lines.push(line);
	}

	// 3. Undeployed commits are not read: the deployed commit needs a Vercel or GitHub call and the gateway holds no token.
	lines.push("undeployed commits: deploy state isn't read here; see the orchestrator's status line");

	// 4. Plan items without a lane.
	const snapshot = deps.orchestratorSnapshot?.() ?? readOrchestratorSnapshot(deps.home);
	if (snapshot === undefined) {
		lines.push("plan items without a lane: the orchestrator snapshot could not be read");
	} else {
		const coveredCodes = new Set<string>();
		for (const row of lanes.filter((lane) => lane.state === "running" || lane.state === "idle")) {
			for (const brief of (deps.laneBriefs ?? ((laneId: string) => readLaneBriefs(deps.home, laneId)))(row.laneId)) {
				for (const code of briefOutcome(brief).match(PLAN_CODE) ?? []) coveredCodes.add(code);
			}
		}
		const noLane: string[] = [];
		const held: string[] = [];
		for (const item of planItems(snapshot)) {
			if ((item.match(PLAN_CODE) ?? []).some((code) => coveredCodes.has(code))) continue;
			(/\b(held|waits?|the operator)\b/i.test(item) ? held : noLane).push(item);
		}
		lines.push(`plan items without a lane: ${noLane.length}, held: ${held.length}`);
		for (const item of noLane.slice(0, PLAN_ITEMS_SHOWN)) lines.push(`  no lane: ${clip(item, 90)}`);
		if (noLane.length > PLAN_ITEMS_SHOWN) lines.push(`  +${noLane.length - PLAN_ITEMS_SHOWN} more with no lane`);
		for (const item of held.slice(0, 5)) lines.push(`  held: ${clip(item, 70)}`);
		if (held.length > 5) lines.push(`  +${held.length - 5} more held`);
	}

	const text = lines.join("\n");
	return text.length > PIPELINE_MAX_CHARS ? `${text.slice(0, PIPELINE_MAX_CHARS)}\n…[cut at ${PIPELINE_MAX_CHARS} characters]` : text;
}

// ─── repo_status (HO4) ───────────────────────────────────────────────────────

/** Branches named in one repo_status answer, the largest holdings first. */
const REPO_STATUS_BRANCHES = 8;
/** Worktrees dirty-counted in one repo_status answer before the cut. */
const REPO_STATUS_WORKTREES = 8;
/** Characters of one repo_status answer. */
const REPO_STATUS_MAX_CHARS = 4000;
/** The run-as consumer of the gateway's own vault layer (`/services`), and the one variable repo_status reads from it. */
export const GITHUB_CONSUMER = "gateway";
export const GITHUB_TOKEN_NAME = "GITHUB_TOKEN";

/** One `gh` call with a fixed argument list; the token rides in the child's environment, never in argv. */
export type GhExec = (args: string[], token: string) => Promise<string>;

/** Production `gh`: no shell, a bounded buffer, and a refusal whose message is redacted and short. */
export const execGh: GhExec = (args, token) =>
	new Promise((resolveGh, rejectGh) => {
		execFile("gh", args, { timeout: 15_000, maxBuffer: 1024 * 1024, encoding: "utf8", env: { ...process.env, GH_TOKEN: token } }, (error, stdout, stderr) => {
			if (error !== null) {
				const said = redactSensitiveText((stderr || error.message).trim(), { preservePaths: true }).split("\n").slice(0, 3).join(" ").slice(0, 200);
				rejectGh(new Error(said === "" ? "gh failed" : `gh failed: ${said}`));
			} else resolveGh(stdout);
		});
	});

/**
 * The production GitHub-token read (HO4): `infisical-agent run-as gateway -- node -e … GITHUB_TOKEN`,
 * the dashboard-login read. Anything unreadable, or an empty variable, means no token; the value
 * itself leaves this function only into `gh`'s environment.
 */
export function defaultGithubToken(options: { home: string }): () => Promise<string | undefined> {
	const read = runAsReader({ bin: join(options.home, ".pi", "agent", "scripts", "secrets", "infisical-agent") });
	return async () => {
		try {
			const vars = await read(GITHUB_CONSUMER, [GITHUB_TOKEN_NAME]);
			const token = vars[GITHUB_TOKEN_NAME];
			return token !== undefined && token !== "" ? token : undefined;
		} catch {
			return undefined;
		}
	};
}

/** The GitHub `owner/repo` of one checkout's origin, or "" when origin is missing or not GitHub. */
async function githubSlug(git: GitExec, dir: string): Promise<string> {
	try {
		const url = (await git(["remote", "get-url", "origin"], dir)).trim();
		return /github\.com[:/]/.test(url) ? url.replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "") : "";
	} catch {
		return "";
	}
}

/** A branch name `gh` may be given as one argv entry (the same shape knowledge.ts accepts for a ref). */
const GH_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

/**
 * The deploy line (HO4): GitHub commit statuses — Vercel posts one per deployed commit — for `dev`
 * and the default branch, through `gh` only when a GitHub token is present through run-as. Without
 * a token, or without a GitHub remote, the line reads "deploy state not read". Never Vercel (VC2).
 */
async function repoDeployLine(deps: OversightToolDeps, git: GitExec, dir: string): Promise<string> {
	const notRead = "deploy state not read";
	const token = await (deps.githubToken ?? defaultGithubToken({ home: deps.home }))().catch(() => undefined);
	if (token === undefined || token === "") return notRead;
	const slug = await githubSlug(git, dir);
	if (slug === "" || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(slug)) return notRead;
	let branch = "main";
	try {
		branch = (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dir)).trim().replace(/^origin\//, "") || "main";
	} catch {
		// No origin HEAD: `main` is the guess the blueprint names (main/master).
	}
	const environments = ["dev", ...(GH_BRANCH.test(branch) && branch !== "dev" ? [branch] : [])];
	const states = await Promise.all(
		environments.map(async (environment) => {
			try {
				const parsed = JSON.parse(await (deps.gh ?? execGh)(["api", `repos/${slug}/commits/${environment}/status`], token)) as { state?: unknown; sha?: unknown };
				const state = typeof parsed.state === "string" && parsed.state !== "" ? parsed.state : "unknown";
				const sha = typeof parsed.sha === "string" && /^[0-9a-f]{7,40}$/.test(parsed.sha) ? parsed.sha.slice(0, 7) : "";
				return `${environment}: ${state}${sha === "" ? "" : ` (${sha})`}`;
			} catch {
				return `${environment}: unknown (gh failed)`;
			}
		}),
	);
	return `deploy: ${states.join(", ")}`;
}

/**
 * `repo_status` (HO4, the operator 2026-10-17 22:59): one register repository, read-only — the main
 * checkout's current branch, every local branch ahead of or behind its upstream or with none (the
 * `unpushedByBranch` owner), dirty file counts only for the main checkout and each worktree, the
 * last test run (the HO5 run ledger, `test-results.ts`), and the deploy line.
 * The `repo` argument is a register projectId; an unknown one is refused with the choices.
 */
export async function repoStatus(deps: OversightToolDeps, repoName: string): Promise<string> {
	const projects = deps.register?.()?.projects ?? [];
	const project = projects.find((candidate) => candidate.projectId === repoName);
	if (project === undefined) {
		throw new OversightError(`unknown repo ${JSON.stringify(repoName)}; the choices are ${projects.map((candidate) => candidate.projectId).join(", ") || "(none)"}`);
	}
	const dir = project.programmes[0]?.checkoutRoot ?? "";
	if (dir === "") throw new OversightError(`${repoName}: the register has no checkout root for it`);
	const git = deps.git ?? execGit;
	let worktrees: string[] = [];
	try {
		worktrees = (await git(["worktree", "list", "--porcelain"], dir))
			.split("\n")
			.filter((line) => line.startsWith("worktree "))
			.map((line) => line.slice("worktree ".length));
	} catch {
		// The line below says it is not a repository.
	}
	if (worktrees.length === 0) throw new OversightError(`${repoName}: ${dir} is not a git repository`);
	const main = worktrees[0]!;
	const lines: string[] = [`repo ${project.projectId} (${dir}):`];
	let branch = "";
	try {
		branch = (await git(["branch", "--show-current"], main)).trim();
	} catch {
		// Detached HEAD or a failed git: named below, never a crash.
	}
	lines.push(`  main checkout branch: ${branch === "" ? "unknown (detached or git failed)" : branch}`);
	try {
		const all = await unpushedByBranch(git, dir);
		if (all.length > 0) {
			lines.push("  local branches:");
			for (const entry of all.slice(0, REPO_STATUS_BRANCHES)) lines.push(`    ${entry.text}`);
			if (all.length > REPO_STATUS_BRANCHES) lines.push(`    +${all.length - REPO_STATUS_BRANCHES} more branches`);
		} else {
			lines.push("  local branches: all pushed and current");
		}
	} catch (error) {
		lines.push(`  local branches: unknown (${clip(error instanceof Error ? error.message : "git failed", 70)})`);
	}
	const dirty: string[] = [];
	for (const tree of worktrees.slice(0, REPO_STATUS_WORKTREES)) {
		const label = tree === main ? "main checkout" : basename(tree);
		try {
			const count = (await git(["status", "--porcelain"], tree)).split("\n").filter((line) => line.trim() !== "").length;
			dirty.push(`${label}: ${plural(count, "dirty file")}`);
		} catch {
			dirty.push(`${label}: unknown`);
		}
	}
	if (worktrees.length > REPO_STATUS_WORKTREES) dirty.push(`+${worktrees.length - REPO_STATUS_WORKTREES} more worktrees`);
	lines.push(`  worktrees: ${dirty.join(", ")}`);
	lines.push(`  last test: ${(deps.lastTestRun ?? lastTestRunLine)(dir) ?? "no runs recorded"}`);
	lines.push(`  ${await repoDeployLine(deps, git, dir)}`);
	const text = lines.join("\n");
	return text.length > REPO_STATUS_MAX_CHARS ? `${text.slice(0, REPO_STATUS_MAX_CHARS)}\n…[cut at ${REPO_STATUS_MAX_CHARS} characters]` : text;
}

// ─── session_send's delivery ─────────────────────────────────────────────────

/**
 * The `deliverLaneMessage` wiring for the operator's own sessions: the lane inbox is
 * the only transport. No Concord (the operator's sessions never enrolled), no pane
 * (never typed into), no parked relaunch (LD9: a the operator session is never
 * resumed). The sender is the gateway agent id (`grokbot`, Henry), and the
 * muster send log records the attempt like any other send.
 */
export function operatorSessionSend(options: { musterStateDir: string; lanes: () => LaneCard[]; waiter?: (stateDir: string, laneId: string) => boolean; now?: () => Date; pane?: PaneDelivery }): (request: SendRequest) => Promise<SendOutcome> {
	const waiter = options.waiter ?? waiterAlive;
	const pane = options.pane ?? (async () => ({ ok: false, command: "none", detail: "the gateway never types into a the operator session (LD9)" }));
	const deps: SendDeps = {
		concord: undefined,
		endpointless: (laneId) => `its own waiter or its next tool boundary (\`muster wait --inbox ${laneId}\`)`,
		inboxState: (laneId) => {
			const row = options.lanes().find((candidate) => candidate.laneId === laneId);
			if (row === undefined) return undefined;
			return row.alive === false ? { state: "asleep", why: "its process is gone" } : { state: "live", waiter: waiter(options.musterStateDir, laneId) };
		},
		recipientEnrolled: () => false,
		pane,
		inbox: async (message) => {
			try {
				const path = writeInboxMessage(options.musterStateDir, {
					id: randomUUID(),
					agent: message.laneId,
					from: GATEWAY_AGENT_ID,
					at: (options.now?.() ?? new Date()).toISOString(),
					text: message.text,
					idempotencyKey: message.idempotencyKey,
					mode: message.mode,
					...(message.taskId !== undefined ? { taskId: message.taskId } : {}),
					source: "send" as const,
				});
				return { ok: true, path };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
		log: (record) => appendSendLog(options.musterStateDir, record),
		...(options.now !== undefined ? { now: options.now } : {}),
	};
	return (request) => deliverLaneMessage(request, deps);
}

// ─── deferred_items: the open and deferred register ────────────────────────

/** Words that mark work as parked rather than open. */
const DEFERRAL_MARKER = /\b(deferr(?:ed|al)?|\blater\b|TODO|on hold|backlog)\b/i;
/** Words that mark work as waiting on the operator specifically: open, owned by the operator. */
const WAITING_ON_OPERATOR = /\bwaiting on (?:the operator|him|her)\b|\bawaiting (?:the operator|his|her) (?:OK|approval|ruling|answer)\b/i;
/** How much of each session's recent transcript the marker scan reads. */
const SESSION_SCAN_MESSAGES = 40;/** Marker hits kept per session. */
const MARKERS_PER_SESSION = 3;
const MAX_ITEMS = 50;
const ITEM_TEXT_CHARS = 300;
/** How many outbox asks are kept per coordination agent. */
const INBOX_ASKS = 5;
/** How far back in an inbox's read pile an ask is still looked for (older asks are history, not a register). */
const INBOX_READ_SCAN = 200;
/** Words that mark a held inbox message as an ask waiting on the operator. */
const OUTBOX_ASK = /\b(needs|asked|waiting on|awaiting) operator/i;
/** A negation right before the ask words: "Nothing needs the operator", "none needs the operator" is not an ask. */
const NOT_AN_ASK = /\b(nothing|none|nobody|no one|never)\s*(?:else\s*)?$/i;
/** An outcome reported before the ask words: the ask's own message has already answered it. "done" is absent on purpose ("they aren't done yet"). */
const OUTCOME_WORD = /\b(closed|resolved|blocked|abandoned|confirmed|decided|ruled|landed|merged|completed)\b/i;
/** Tokens too common to say two messages are about the same subject. */
const STOP_TOKENS = new Set(["operator", "needs", "asked", "waiting", "awaiting", "report", "orchestrator", "gateway", "external", "agent", "untrusted", "treat", "text", "open"]);

/** The subject tokens of one message: words of five characters or more, minus the common ones. */
function subjectTokens(text: string): Set<string> {
	return new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9._-]{4,}/g) ?? []).filter((token) => !STOP_TOKENS.has(token)));
}

/** Whether two messages name the same subject: one shared subject token is enough. */
function sharesSubject(text: string, other: string): boolean {
	const tokens = subjectTokens(other);
	return [...subjectTokens(text)].some((token) => tokens.has(token));
}

/**
 * One ask per unit when a message lists them ("failed user units: a.service, b.service"): the two
 * failed units are two different things to fix, so they are two items (Henry's review, 2026-10-16
 * 17:10, F6.3). Anything else stays one item.
 */
function splitAskUnits(text: string): string[] {
	const marker = /\b(needs?|asked|waiting on|awaiting)\b/i.exec(text);
	if (marker === null) return [text];
	// The list runs to the end of its sentence; the pattern stays lazy so a dot inside a name
	// (`mcp-health.service`) does not cut it short.
	const list = /:\s*([^:\n]+?)\.(?:\s|$)/.exec(text.slice(marker.index));
	if (list === null) return [text];
	const parts = list[1]!.split(",").map((part) => part.trim());
	if (parts.length < 2 || parts.some((part) => part === "" || /\s/.test(part))) return [text];
	return parts.map((part) => text.replace(list[1]!, part));
}

/** The design session's decision record: repo, branch and path (design-snapshot.md: "docs branch `docs/agent-runtime-2026-10-13`, local only"). */
const ARCHITECT_DECISION_RECORD = { project: "crm-app", branch: "docs/agent-runtime-2026-10-13", file: "docs/plans/decisions-2026-10-02.md" };

/** The default design snapshot: this programme's handoffs file. Undefined when it does not exist. */
function readDesignSnapshot(home: string): string | undefined {
	try {
		return readFileSync(join(home, ".pi", "agent", "plans", "orchestration-2026-10-05", "handoffs", "design-snapshot.md"), "utf8");
	} catch {
		return undefined;
	}
}

/**
 * The design session's decision record, read from the docs branch through the register's checkout
 * (the file is local-only on that branch). Undefined when git cannot read it: the register is a
 * register, never a crash.
 */
async function readArchitectDecisionRecord(deps: OversightToolDeps): Promise<string | undefined> {
	if (deps.architectDecisions !== undefined) return deps.architectDecisions();
	const git = deps.git ?? execGit;
	let root = join(deps.home, "projects", ARCHITECT_DECISION_RECORD.project);
	try {
		const checkout = deps.register?.()?.projects.find((project) => project.projectId === ARCHITECT_DECISION_RECORD.project)?.programmes[0]?.checkoutRoot;
		if (typeof checkout === "string" && checkout !== "") root = checkout;
	} catch {
		// An unreadable register falls back to the default checkout path.
	}
	return git(["show", `${ARCHITECT_DECISION_RECORD.branch}:${ARCHITECT_DECISION_RECORD.file}`], root).catch(() => undefined);
}

/** The default operator-only list: this programme's handoffs file. Undefined when it does not exist. */
function readOperatorOnlyList(home: string): string | undefined {
	try {
		return readFileSync(join(home, ".pi", "agent", "plans", "orchestration-2026-10-05", "handoffs", "operator-only-list.md"), "utf8");
	} catch {
		return undefined;
	}
}

export type DeferredItem = {
	source: string;
	date: string | null;
	owner: string;
	status: "open" | "deferred" | "stale" | "done";
	text: string;
};

function trimItemText(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > ITEM_TEXT_CHARS ? `${oneLine.slice(0, ITEM_TEXT_CHARS)}…` : oneLine;
}

/**
 * The running register of open and deferred items (orchestrator scope addition,
 * 2026-10-16 14:50): lane reports that are blocked or asking a question, open
 * decision rows from the architect's decision store, asks waiting on the operator —
 * undelivered session_send messages in his sessions' inboxes, orchestrator and
 * gateway inbox asks that name him, every open row of the handoffs operator-only
 * list — and deferral markers in the recent tail of every readable session, one
 * item per source event (Henry's review, 2026-10-16 16:06). AK2 adds two sections
 * of their own: `asks`, the queue's asks waiting on the operator read through the queue
 * owner (`../asks.ts`), and `review`, the sweeper's review list (`asks/
 * review.jsonl`, AK4's to write; absent until then). Read-only; every item
 * carries source, date, owner and status. Secrets are redacted by the transcript
 * owners and the server on the way out.
 */
export async function deferredItems(deps: OversightToolDeps): Promise<string> {
	const notes: string[] = [];
	const items: DeferredItem[] = [];
	const push = (item: DeferredItem): void => {
		if (items.length < MAX_ITEMS) items.push(item);
	};
	// 1. Lane reports: blocked or question is an open item; any other report only when it defers something itself.
	for (const row of deps.lanes()) {
		const report = row.lastReport;
		if (report === undefined) continue;
		const status: "open" | "deferred" | undefined = report.kind === "blocked" || report.kind === "question" ? "open" : DEFERRAL_MARKER.test(report.summary) || WAITING_ON_OPERATOR.test(report.summary) ? "deferred" : undefined;
		if (status === undefined) continue;
		push({ source: `lane report ${row.laneId}`, date: typeof report.at === "number" && report.at > 0 ? new Date(report.at).toISOString() : null, owner: row.laneId, status, text: trimItemText(`${report.kind}: ${report.summary}`) });
	}
	// 2. Decision rows: an open decision awaits its ruling; the store's own reader is the owner.
	try {
		for (const project of deps.register?.()?.projects ?? []) {
			for (const programme of project.programmes) {
				for (const decision of (deps.openDecisions ?? listOpenDecisions)(programme.programmeId)) {
					push({ source: `decision ${decision.decisionId} (${programme.programmeId})`, date: decision.createdAt, owner: "operator", status: "open", text: trimItemText(`${decision.kind}: ${decision.question}`) });
				}
			}
		}
	} catch (error) {
		notes.push(`decision rows could not be read (${error instanceof Error ? error.message : "failed"})`);
	}
	// 2b. The architect's decision store (Henry's review, 2026-10-16 17:10, F6.3): the design
	// session keeps its rows in the BE decision record on its docs branch — the record's the operator
	// rows (the fate of the the operator-list codes, e.g. VD6 replaced by LC1) and the design snapshot's
	// open "Waits on the operator" rows. The muster decision cards above stay the one decision-card store.
	try {
		const record = await readArchitectDecisionRecord(deps);
		if (record !== undefined) {
			for (const line of record.split("\n")) {
				if (/^\s*-\s*\*\*(.+?)\*\*/.exec(line) === null || !/\bVD\d+\b/.test(line)) continue;
				const row = line.trim().replace(/^-\s*/, "").replace(/\*\*/g, "");
				push({ source: "architect decision record (BE docs branch)", date: /(\d{4}-\d{2}-\d{2})/.exec(row)?.[1] ?? null, owner: "operator", status: "done", text: trimItemText(row) });
			}
		}
	} catch (error) {
		notes.push(`the architect decision record could not be read (${error instanceof Error ? error.message : "failed"})`);
	}
	const snapshot = deps.designSnapshot?.() ?? readDesignSnapshot(deps.home);
	if (snapshot !== undefined) {
		const dated = /(\d{4}-\d{2}-\d{2})/.exec(snapshot.split("\n")[0] ?? "")?.[1] ?? null;
		// The architect has named this section "Waits on the operator" (2026-10-15 16:4x) and "the operator's list"
		// (2026-10-16 20:22); both are the snapshot's own record of what waits on the operator.
		const waits = /^##\s+(?:Waits?\s+on\s+the operator|the operator's list)[^\n]*$/im.exec(snapshot);
		if (waits !== null) {
			for (const line of snapshot.slice(waits.index + waits[0].length).split("\n")) {
				if (/^##\s/.test(line)) break;
				const text = line.trim().replace(/^-\s*/, "");
				if (text === "") continue;
				push({ source: "architect decision snapshot", date: dated, owner: "operator", status: "open", text: trimItemText(text) });
			}
		}
	}
	// 3. Session markers: the recent tail of each readable session (the operator's own, and the architect's).
	const rows = deps.lanes().filter((row) => (row.origin === "operator" || row.laneId === "architect") && (row.harness === "pi" || row.harness === "claude"));
	for (const row of rows) {
		const transcript = await sessionTranscript(deps, row.laneId, row);
		if (transcript.notes.length > 0 && notes.length < 5) notes.push(`${row.laneId}: ${transcript.notes[0]!}`);
		const seen = new Map<string, DeferredItem>();
		let kept = 0;
		for (const message of (transcript.transcript?.messages ?? []).slice(-SESSION_SCAN_MESSAGES)) {
			if (kept >= MARKERS_PER_SESSION || items.length >= MAX_ITEMS) break;
			if (!DEFERRAL_MARKER.test(message.content) && !WAITING_ON_OPERATOR.test(message.content)) continue;
			// One item per source event: a relay can sit in the transcript twice (once without
			// a timestamp). The duplicate only fills in the date of the item already recorded.
			const key = message.content.replace(/\s+/g, " ").trim();
			const prior = seen.get(key);
			if (prior !== undefined) {
				if (prior.date === null && message.timestamp !== undefined) prior.date = new Date(message.timestamp).toISOString();
				continue;
			}
			const item: DeferredItem = {
				source: `session ${row.laneId}`,
				date: message.timestamp !== undefined ? new Date(message.timestamp).toISOString() : null,
				owner: message.speaker === "operator" ? "operator" : row.laneId,
				status: WAITING_ON_OPERATOR.test(message.content) ? "open" : "deferred",
				text: trimItemText(message.content),
			};
			const before = items.length;
			push(item);
			if (items.length > before) {
				seen.set(key, item);
				kept += 1;
			}
		}
	}
	// 4. Session inbox asks: a session_send delivery not yet read into the chat is still an open ask.
	for (const row of deps.lanes()) {
		if (row.origin !== "operator") continue;
		for (const message of listInboxMessages(deps.stateDir, row.laneId).slice(-INBOX_ITEMS)) {
			push({ source: `inbox ${row.laneId}`, date: message.at, owner: "operator", status: "open", text: trimItemText(`${message.from}: ${message.text}`) });
		}
	}
	// 5. Outbox asks: messages the orchestrator and the gateway hold that ask the operator for a ruling.
	// A mention is not an ask when it is negated ("Nothing needs the operator"), an ask is done when its
	// own message reports the outcome ("the operator confirmed… blocked"), and stale when a later message
	// moves the same subject on (Henry's review, 2026-10-16 17:10, F6.3). A message from the gateway
	// agent is Henry's own note: Henry owns it, not the operator. The janitor's two failed units are two
	// asks, not one.
	const coordination: Array<{ agent: string; message: InboxMessage }> = [];
	for (const agent of [...new Set<string>(["orchestrator", GATEWAY_AGENT_ID])]) {
		for (const message of [...listInboxMessages(deps.stateDir, agent), ...listDeliveredMessages(deps.stateDir, agent, INBOX_READ_SCAN)]) {
			coordination.push({ agent, message });
		}
	}
	coordination.sort((left, right) => left.message.at.localeCompare(right.message.at));
	for (const { agent, message } of coordination) {
		const match = OUTBOX_ASK.exec(message.text);
		if (match === null) continue;
		if (NOT_AN_ASK.test(message.text.slice(Math.max(0, match.index - 40), match.index).trimEnd())) continue;
		const answered = OUTCOME_WORD.test(message.text.slice(0, match.index));
		const superseded = coordination.some((candidate) => candidate.message.from === message.from && candidate.message.at > message.at && sharesSubject(candidate.message.text, message.text));
		const status: DeferredItem["status"] = answered ? "done" : superseded ? "stale" : "open";
		const owner = message.from === GATEWAY_AGENT_ID ? "Henry (gateway)" : "operator";
		for (const text of splitAskUnits(`${message.from}: ${message.text}`)) {
			push({ source: `outbox ask ${agent}`, date: message.at, owner, status, text: trimItemText(text) });
		}
	}
	// 6. the operator's own list: every row of the handoffs file (VH actions and VD decisions alike). A
	// decided row is struck through and appears as done, so a decided code is never missing (Henry's
	// review F6.3); every row carries the date it names, else the list's own updated date.
	const operatorOnly = deps.operatorOnlyList?.() ?? readOperatorOnlyList(deps.home);
	if (operatorOnly !== undefined) {
		const updated = /Updated\s+(\d{4}-\d{2}-\d{2})/i.exec(operatorOnly)?.[1];
		for (const line of operatorOnly.split("\n")) {
			const matched = /^\|\s*(~~)?\s*([A-Za-z]{1,6}\d+)\s*(~~)?\s*\|([^|]+)\|([^|]*)\|/.exec(line.trim());
			if (matched === null) continue;
			const done = matched[1] !== undefined || matched[3] !== undefined;
			const cells = `${matched[4]} ${matched[5] ?? ""}`;
			push({ source: "operator-only-list", date: /(\d{4}-\d{2}-\d{2})/.exec(cells)?.[1] ?? updated ?? null, owner: "operator", status: done ? "done" : "open", text: trimItemText(`${matched[2]} ${matched[4].trim()}`) });
		}
	}
	items.sort((left, right) => (right.date ?? "").localeCompare(left.date ?? ""));
	// 7. The queue (AK2): the asks waiting on the operator, blocking first, read through the queue
	// owner; and the sweeper's review list, which AK4 writes and this only reads.
	const asks: DeferredAsk[] = [];
	let review: AskReviewItem[] = [];
	try {
		const queue = readAsks(deps.stateDir, { cardState: programmeCardReader() });
		const nowMs = (deps.now?.() ?? new Date()).getTime();
		for (const ask of orderAsksForOperator(waitingOnOperator(queue))) {
			asks.push({
				id: ask.id,
				code: askCodeOf(ask),
				kind: ask.kind,
				question: ask.question,
				status: ask.status,
				owner: ask.owner ?? "operator",
				raisedAt: ask.raisedAt,
				age: formatAskAge(ask.raisedAt, nowMs),
				...(ask.blocks.length > 0 ? { blocks: ask.blocks } : {}),
				...(ask.recommendation !== undefined ? { recommendation: ask.recommendation } : {}),
				line: formatAskLine(ask, nowMs),
			});
		}
		review = readAskReviewList(deps.stateDir);
	} catch (error) {
		notes.push(`the ask queue could not be read (${error instanceof Error ? error.message : "failed"})`);
	}
	return JSON.stringify({ scanned: { lanes: deps.lanes().length, sessions: rows.length }, items, asks, review, ...(notes.length > 0 ? { notes } : {}) }, null, 2);
}

export type { ProjectRegistration };

/** One ask waiting on the operator, in the register's own `asks` section (AK2). */
export type DeferredAsk = {
	id: string;
	code: string;
	kind: string;
	question: string;
	status: string;
	owner: string;
	raisedAt: string;
	age: string;
	blocks?: string[];
	recommendation?: string;
	line: string;
};

/** One finding of the sweeper's review list (AK4 declares the entry shape). */
export type AskReviewItem = { finding: "not-in-queue" | "may-be-done"; source: string; text: string; at: string };

/**
 * The sweeper's review list, `<stateDir>/asks/review.jsonl`, read tolerantly: AK4 owns writing it
 * and it does not exist until then, and a line that is not a usable entry is skipped rather than
 * failing the register. Its entries are `{ finding: "not-in-queue" | "may-be-done", source, text, at }`.
 */
export function readAskReviewList(musterStateDir: string, limit = MAX_ITEMS): AskReviewItem[] {
	const path = join(musterStateDir, "asks", "review.jsonl");
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const items: AskReviewItem[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const parsed = JSON.parse(line) as Partial<AskReviewItem>;
			if ((parsed.finding === "not-in-queue" || parsed.finding === "may-be-done") && typeof parsed.text === "string") {
				items.push({ finding: parsed.finding, source: typeof parsed.source === "string" ? parsed.source : path, text: parsed.text, at: typeof parsed.at === "string" ? parsed.at : "" });
			}
		} catch {
			continue;
		}
	}
	return items.slice(-limit);
}
