/**
 * The sweeper's transcript scan (AK5 of
 * `plans/muster-autonomy/operator-queue-proposal-2026-10-16.md`, "The sweeper"
 * step 2).
 *
 * It reads the Pi and Claude transcripts of a window with the transcript owners
 * (`readPiTranscript`, `readClaudeTranscript` with `allMessages: true`), picks
 * the candidates the design names — an agent's message to the operator that asks
 * something, and the operator's own deferrals ("later", "remind me", "tomorrow") —
 * and labels each one `{ isAsk, kind, question, codes, quote }` with a cheap pool
 * model: one isolated headless Pi run in print mode per prompt-sized chunk of
 * candidates (`--no-session --no-extensions --no-tools --no-skills
 * --no-prompt-templates --model <MUSTER_ASKS_LABEL_MODEL|the pool worker-role head>
 * --print`) — never a session that joins Muster, never the session default model.
 *
 * Every candidate ends in exactly one bucket, and the run prints one accounting
 * line. A label whose quote is not verbatim in the message is unreadable and is
 * counted, never used; an unreadable candidate carries one reason (AK8), the
 * four counts print on the accounting line and add up to `unreadable`, and a
 * chunk whose run failed is retried once as two halves — the accounting line
 * prints the first line of each distinct chunk error. A chunk that times out,
 * meets a quota wall or has its credential rejected moves the run to the next model in the provider list's role
 * chain (`fallbackRef`, the routing owner), and the whole labelling phase is
 * bounded by the unit's own start timeout: a run that would overrun stops, keeps
 * the chunks it labelled and lists the rest `unscanned`. Codes match only the
 * queue's registered codes, the VH, VD and DQ series, and the codes the two
 * snapshots carry today — never a bare `D1` or `O2` from a proposal.
 *
 * The scan never changes an ask's status: its review findings go to the same
 * review list the file diff appends to (`asks.ts`), for the architect to settle
 * with a queue event. A dry run (`--dry-run`) makes no model call and writes
 * nothing: it counts the candidates the pre-filter finds.
 *
 * Client work is never labelled: a session whose cwd is an excluded project
 * (`isExcludedCwd`, the J1 owner) is skipped whole, before any model call, and
 * the transcript readers' own sanitizer has already redacted what is read. So
 * are lane sessions (AK9): a session the launcher's registry lists, or one
 * whose first user message is a lane or test brief, asks the orchestrator
 * rather than the operator and carries no ask of the operator's; each is skipped whole and
 * printed as `skipped lane`, apart from `skipped excluded`.
 *
 * A `not-in-queue` candidate whose label is an action only the operator can do (HO3,
 * `SWEEP_ASK_KINDS`) is raised as an ask of its own through the one ask writer,
 * `raiseAsk`, with the transcript it was found in as its `source` and the words
 * it was found in in its question; the queue's own `findOpenDuplicate` keeps the
 * two windows from raising it twice. Every other finding stays on the review
 * list, exactly as before, and the sweep never answers or closes an ask.
 */

import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { laneRegistryPath, readLaneRegistryRows } from "./lib/lane-directory.js";
import type { NormalizedTranscript } from "../core/pi-ports.ts";
import { piPort } from "../core/pi-ports.ts";
import { isExcludedCwd } from "../core/excluded-cwd.ts";
import { fallbackRef, loadPoolConfig, poolConfigPath, wallFor, wallKey, type PoolConfig, type Wall } from "../routing/provider-pool.ts";
import { classifyQuota, type QuotaClassification } from "../routing/quota-classifier.ts";
import {
	parseDesignSnapshot,
	parseOrchestratorSnapshot,
	REPO_SOURCE_PATHS,
	textMatch,
} from "./asks-import-lib.ts";
import {
	ASK_KINDS,
	CLOSED_ASK_STATUSES,
	MAX_FINDING_TEXT,
	SWEEP_LISTS_ROOT_ENV,
	SWEEP_SOURCE_PREFIX,
	findOpenDuplicate,
	matchesWaiting,
	plural,
	programmeCardReader,
	raiseAsk,
	readAsks,
	recordReviewFindings,
	textMatchCounts,
	waitingOnOperator,
	type Ask,
	type AskKind,
	type AskQueue,
	type AskStatus,
	type ReviewAppendResult,
	type SweepFinding,
} from "./asks.ts";
import { piAgentDir } from "./binding.ts";

// ─── The window ──────────────────────────────────────────────────────────────

/**
 * The windows the sweep runs over: the hourly pass over 2 hours, the nightly
 * backstop over 24 hours, and the one-off wide pass over 4 days.
 */
export type ScanWindow = "2h" | "4d" | "24h";
export const SCAN_WINDOWS: readonly ScanWindow[] = ["2h", "4d", "24h"];

const WINDOW_MS: Record<ScanWindow, number> = {
	"2h": 2 * 60 * 60_000,
	"24h": 24 * 60 * 60_000,
	"4d": 4 * 24 * 60 * 60_000,
};

export function scanWindowMs(window: ScanWindow): number {
	return WINDOW_MS[window];
}

// ─── Candidates ──────────────────────────────────────────────────────────────

/** Where a candidate was read: harness, session, and its place in the transcript. */
export type ScanCandidate = {
	id: string;
	source: "pi" | "claude";
	sessionId: string;
	cwd: string;
	/** ISO when the message carries a timestamp; a date is never invented. */
	at: string | undefined;
	kind: "agent-question" | "operator-deferral";
	text: string;
};

/**
 * The kind vocabulary one label carries: the ask kinds `muster ask --kind` takes
 * (`ASK_KINDS`, the owner), plus `none` for a message that is not an ask at all.
 * A label with no valid kind is unreadable (`no-label`), never guessed at.
 */
export type ScanLabelKind = AskKind | "none";
export const LABEL_KINDS: readonly ScanLabelKind[] = [...ASK_KINDS, "none"];

/**
 * The kinds the sweep raises itself (HO3): the ones only the operator can carry out —
 * a DNS change, a 2FA login, a key he creates. Owner of the kinds is `ASK_KINDS`;
 * this is the sweep's own selector over it. Authority: the operator 2026-10-17 22:55
 * via Grokbot ("every the operator-action raised in chat … gets an ask row").
 */
export const SWEEP_ASK_KINDS: readonly AskKind[] = ["operator-action", "human-login", "credential"];

/** The label one candidate gets from the model. `quote` must be verbatim in the text. */
export type ScanLabel = {
	isAsk: boolean;
	kind: ScanLabelKind;
	question?: string;
	codes?: string[];
	/** The id of a queue ask that already asks the same need (F2ASKS); an id the queue does not hold is ignored. */
	sameAs?: string;
	quote: string;
};

/**
 * One ask the labeller may name in `sameAs` (F2ASKS, VR24-166, VR24-171 (3)): an ask
 * still waiting on the operator, one closed inside the scan window, or one he answered inside
 * it, as `knownAsks` selects them.
 */
export type KnownAsk = {
	id: string;
	status: AskStatus;
	closedAt: string | undefined;
	/** The moment the operator answered a `decided` ask: the `answered` event's time, or the card's `appliedAt`. */
	answeredAt?: string | undefined;
	question: string;
};

/**
 * The asks the one labelling call sees besides the candidates (F2ASKS, VR24-166,
 * VR24-171 (3)): everything still waiting on the operator, every ask closed inside the scan
 * window, and every one he answered inside it — the ones a candidate may still repeat.
 * A settled ask from before the window is out: a message inside the window is after it,
 * so it covers nothing there.
 */
export function knownAsks(queue: AskQueue, sinceMs: number): KnownAsk[] {
	const inside = (iso: string | undefined): boolean => {
		if (iso === undefined) return false;
		const ms = Date.parse(iso);
		return !Number.isNaN(ms) && ms >= sinceMs;
	};
	const settled = queue.asks.filter((ask) => {
		if (CLOSED_ASK_STATUSES.includes(ask.status)) return inside(ask.closedAt);
		if (ask.status === "decided") return inside(ask.answeredAt);
		return false;
	});
	return [...waitingOnOperator(queue), ...settled].map((ask) => ({
		id: ask.id,
		status: ask.status,
		closedAt: ask.closedAt,
		answeredAt: ask.answeredAt,
		question: ask.question,
	}));
}

/**
 * The labeller, injectable so tests run on a fake and no test makes a model call.
 * `known` is the queue as `knownAsks` selects it, so the one call judges "same
 * meaning" as well as "is an ask" (F2ASKS).
 */
export type AskScanLabeller = (
	candidates: readonly ScanCandidate[],
	onError?: (message: string) => void,
	known?: readonly KnownAsk[],
) => Promise<ScanLabel[]>;

/** the operator's own deferral words, as the design spells them. */
const DEFERRAL_TEXT = /\b(?:later|remind me|tomorrow)\b/i;

function candidatesFrom(
	source: "pi" | "claude",
	transcript: NormalizedTranscript,
	window: { sinceMs: number; untilMs: number },
): ScanCandidate[] {
	const out: ScanCandidate[] = [];
	for (const [index, message] of transcript.messages.entries()) {
		if (message.timestamp !== undefined && (message.timestamp < window.sinceMs || message.timestamp > window.untilMs)) {
			continue;
		}
		const text = message.content.trim();
		if (text === "") continue;
		const deferral = message.role === "user" && message.speaker === "operator" && DEFERRAL_TEXT.test(text);
		const agentToOperator = (message.role === "assistant" || (message.role === "user" && message.speaker === "agent")) && text.includes("?");
		if (!deferral && !agentToOperator) continue;
		out.push({
			id: `${source}:${transcript.sessionId}#${index}`,
			source,
			sessionId: transcript.sessionId,
			cwd: transcript.cwd,
			at: message.timestamp !== undefined ? new Date(message.timestamp).toISOString() : undefined,
			kind: deferral ? "operator-deferral" : "agent-question",
			text,
		});
	}
	return out;
}

// ─── The buckets ─────────────────────────────────────────────────────────────

/** The one bucket every candidate ends in, printed as one accounting line per run. */
export type ScanBucket =
	| "not-an-ask"
	| "already-linked"
	| "already-covered"
	| "not-in-queue"
	| "may-be-answered"
	| "unreadable";
export const SCAN_BUCKETS: readonly ScanBucket[] = [
	"not-an-ask",
	"already-linked",
	"already-covered",
	"not-in-queue",
	"may-be-answered",
	"unreadable",
];

/** Why a candidate stayed unreadable (AK8); the four counts add up to `buckets.unreadable`. */
export type ScanUnreadableReason = "chunk-failed" | "no-label" | "not-verbatim" | "unscanned";
export type ScanUnreadableReasons = Record<ScanUnreadableReason, number>;

export type ScanSourceReport = { harness: "pi" | "claude"; files: number; read: number; skipped: number; laneSkipped: number };

export type ScanResult = {
	window: ScanWindow;
	sources: ScanSourceReport[];
	/** Messages read inside the window, across the sessions that were read. */
	messages: number;
	candidates: number;
	buckets: Record<ScanBucket, number>;
	/** The unreadable split by reason (AK8): the counts add up to `buckets.unreadable`. */
	unreadableReasons: ScanUnreadableReasons;
	/** The review findings this run produced (none in a dry run). */
	findings: SweepFinding[];
	/** The error text of each labelling run that failed — a whole chunk, or its retried half (none in a dry run). */
	chunkFailures: string[];
	/** False for a dry run: no model call, no bucketing, no writes. */
	labelled: boolean;
	/** The one accounting line the run prints. */
	accounting: string;
};

export type ScanOptions = {
	window: ScanWindow;
	now?: number;
	/** Required unless `dryRun`; the CLI wires `offloadLabeller`. */
	labeller?: AskScanLabeller;
	dryRun?: boolean;
	env?: NodeJS.ProcessEnv;
	home?: string;
};

/** Where the scan reads transcripts; a test points these at fixture directories. */
export const SCAN_SESSIONS_ROOT_ENV = "MUSTER_ASKS_SESSIONS_ROOT";
export const SCAN_CLAUDE_ROOT_ENV = "MUSTER_ASKS_CLAUDE_ROOT";

export type ScanRoots = { pi: string; claude: string };

export function scanRoots(env: NodeJS.ProcessEnv, home: string = homedir()): ScanRoots {
	const pi = env[SCAN_SESSIONS_ROOT_ENV]?.trim();
	const claude = env[SCAN_CLAUDE_ROOT_ENV]?.trim();
	return {
		pi: pi !== undefined && pi !== "" ? pi : join(piAgentDir(), "sessions"),
		claude: claude !== undefined && claude !== "" ? claude : join(home, ".claude", "projects"),
	};
}

function recent(path: string, sinceMs: number): boolean {
	try {
		return statSync(path).mtimeMs >= sinceMs;
	} catch {
		return false;
	}
}

/** `<sessions>/<project dir>/*.jsonl`, kept to files written inside the window. */
function piSessionFiles(root: string, sinceMs: number): string[] {
	const files: string[] = [];
	let projects: string[] = [];
	try {
		projects = readdirSync(root);
	} catch {
		return files;
	}
	for (const project of projects) {
		let names: string[] = [];
		try {
			names = readdirSync(join(root, project));
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			const path = join(root, project, name);
			if (recent(path, sinceMs)) files.push(path);
		}
	}
	return files.sort();
}

function readTranscript(path: string, source: "pi" | "claude"): NormalizedTranscript | undefined {
	if (source === "pi") return piPort("transcripts").readPiTranscript(path) ?? undefined;
	return piPort("transcripts").readClaudeTranscript(path, { allMessages: true }) ?? undefined;
}

/** The launch briefs a lane or a harness test begins its session with (AK9): a lane asks the orchestrator, never the operator. */
const LANE_BRIEF_PREFIXES = ["You are lane ", "# Lane ", "You are a short-lived"] as const;

/**
 * AK9: a lane's session is skipped whole. The launcher's registry names it by
 * session id; a lane whose row the registry no longer carries is caught by its
 * first user message, the launch brief the launcher or a test wrote.
 */
function isLaneSession(transcript: NormalizedTranscript, laneSessionIds: ReadonlySet<string>): boolean {
	if (laneSessionIds.has(transcript.sessionId)) return true;
	const firstUser = transcript.messages.find((message) => message.role === "user");
	return firstUser !== undefined && LANE_BRIEF_PREFIXES.some((prefix) => firstUser.content.startsWith(prefix));
}

// ─── Codes ───────────────────────────────────────────────────────────────────

/** The queue's own series, which a message may name before any ask carries the code. */
const CODE_SERIES = /^(?:VH|VD|DQ)\d{1,3}$/;

/**
 * The codes a label's `codes` may match: a live ask's registered code, and the
 * codes the two snapshots carry today (their own letter series). A bare `D1` or
 * `O2` from a proposal is in neither, so it never links a candidate.
 */
function matchableCodes(waiting: readonly Ask[], env: NodeJS.ProcessEnv): Set<string> {
	const codes = new Set<string>();
	for (const ask of waiting) {
		if (ask.code !== undefined) codes.add(ask.code);
	}
	const named = env[SWEEP_LISTS_ROOT_ENV]?.trim();
	const root = named !== undefined && named !== "" ? named : piAgentDir();
	for (const relative of [REPO_SOURCE_PATHS.orchestratorSnapshot, REPO_SOURCE_PATHS.designSnapshot]) {
		let text: string;
		try {
			text = readFileSync(join(root, relative), "utf8");
		} catch {
			continue;
		}
		for (const row of [...parseOrchestratorSnapshot(relative, text), ...parseDesignSnapshot(relative, text)]) {
			if (row.code !== undefined) codes.add(row.code);
		}
	}
	return codes;
}

// ─── Labels ──────────────────────────────────────────────────────────────────

function isScanLabel(value: unknown): value is ScanLabel {
	if (value === null || typeof value !== "object") return false;
	const label = value as Record<string, unknown>;
	if (typeof label["isAsk"] !== "boolean") return false;
	if (typeof label["quote"] !== "string") return false;
	if (!(LABEL_KINDS as readonly string[]).includes(label["kind"] as string)) return false;
	if (label["question"] !== undefined && typeof label["question"] !== "string") return false;
	if (label["codes"] !== undefined && !Array.isArray(label["codes"])) return false;
	if (label["sameAs"] !== undefined && typeof label["sameAs"] !== "string") return false;
	return true;
}

/**
 * The quote one failed labelling run's placeholders carry (AK8). A control
 * character cannot stand verbatim in a real message, so the scan alone reads
 * it: the reason `chunk-failed`, never a model's label.
 */
export const CHUNK_FAILED_QUOTE = "\u0000chunk-failed\u0000";

/**
 * The quote every candidate the run never reached carries: a run that stopped at
 * its budget, or one whose role has no further model. It says the label was never
 * attempted, apart from `chunk-failed`, which says one was attempted and failed.
 */
export const CHUNK_UNSCANNED_QUOTE = "\u0000unscanned\u0000";

/**
 * The one reason the label cannot be read (AK8), or undefined when it can: the
 * marker an unattempted or failed run left behind, a label with the wrong shape,
 * or a quote that is not verbatim in the message. A model's answer for an
 * `agent-question` that is not an ask carries an empty quote, because a non-ask
 * has nothing to quote: that label is readable (the live run of 2026-10-18 counted
 * every such answer `not-verbatim`). An ask, and any label on a deferral, still
 * needs its verbatim quote, and a non-empty quote must always be in the message.
 */
function unreadableReasonOf(label: unknown, candidate: ScanCandidate): ScanUnreadableReason | undefined {
	if (typeof label === "object" && label !== null && (label as ScanLabel).quote === CHUNK_FAILED_QUOTE) return "chunk-failed";
	if (typeof label === "object" && label !== null && (label as ScanLabel).quote === CHUNK_UNSCANNED_QUOTE) return "unscanned";
	if (!isScanLabel(label)) return "no-label";
	if (!label.isAsk && candidate.kind === "agent-question" && label.quote.trim() === "") return undefined;
	return quoteVerbatim(label.quote, candidate.text) ? undefined : "not-verbatim";
}

/**
 * What a sweep names as the cause when every candidate came back unreadable: the
 * first failed attempt's error when there was one, else the reasons the scan
 * itself rejected the labels for. A run whose attempts all succeeded has no error
 * text, and an empty cause (the 2026-10-18 report) tells the reader nothing.
 */
export function unreadableCause(result: Pick<ScanResult, "unreadableReasons">, firstError: string): string {
	if (firstError.trim() !== "") return firstError;
	const reasons = result.unreadableReasons;
	const parts: string[] = [];
	if (reasons["not-verbatim"] > 0) parts.push(`${reasons["not-verbatim"]} not-verbatim (the label's quote was empty or not in the message)`);
	if (reasons["no-label"] > 0) parts.push(`${reasons["no-label"]} no-label (the label lacked a boolean isAsk, a string quote or a valid kind)`);
	return parts.length > 0
		? `no labelling attempt failed; the model answered, but the scan rejected its labels: ${parts.join(", ")}`
		: "no labelling attempt reported an error";
}

/**
 * Whether a run whose every candidate came back unreadable is an outage, which the sweep exits 1 on, or a
 * content rejection, which it exits 0 on with the warning kept (2026-10-28, muster-asks-scan-hourly).
 *
 * An outage is the substrate failing, and the two reasons say it: `chunk-failed` is a part whose attempt
 * and retry both failed, `unscanned` is a candidate no attempt labelled — the run stopped at its budget,
 * or its route chain ran out. A run whose labels the scan itself refused (`not-verbatim`, `no-label`) is
 * the model's answer being rejected by the verbatim check, and the check is working: the warning still
 * prints, the accounting still counts the candidate, and the doctor's contract does not turn red for a
 * model's mistake. The refusal itself is never weakened here.
 *
 * The attempt's error text is not read (ASKFIX, 2026-10-29): `chunkFailures` also carries attempts a later
 * model in the chain healed, so testing it made a run's verdict about an error that cost nothing, and
 * reported a content rejection as an outage whenever the primary route was rejected first. The two
 * reason counts already carry every substrate failure.
 */
export function unreadableRunIsOutage(result: Pick<ScanResult, "unreadableReasons">): boolean {
	const reasons = result.unreadableReasons;
	return reasons["chunk-failed"] > 0 || reasons.unscanned > 0;
}

/**
 * The label's quote must be verbatim in the message: an exact substring, or the
 * same words across a line wrap. Anything else is unreadable and is counted.
 */
function quoteVerbatim(quote: unknown, text: string): quote is string {
	if (typeof quote !== "string") return false;
	const trimmed = quote.trim();
	if (trimmed === "") return false;
	if (text.includes(trimmed)) return true;
	return text.replace(/\s+/g, " ").includes(trimmed.replace(/\s+/g, " "));
}

// ─── The scan ────────────────────────────────────────────────────────────────

/**
 * The sessions the sweep must skip: the launcher's lane registry, read through the lane owner. The path is
 * `laneRegistryPath`'s (`PI_LANES_JSON` when the launcher named another), and the backend decides where the rows
 * live — ledger mode keeps them in the registry store, not in `pi-lanes.json` (VR24-230 AC1/AC3). A one-argument
 * read kept the sweep on the file after the ledger flip, so a lane launched after it read as a chat session.
 */
export function laneSessionsFor(musterStateDir: string): Set<string> {
	const sessions = new Set<string>();
	for (const row of readLaneRegistryRows(laneRegistryPath(musterStateDir), musterStateDir).values()) {
		if (row.sessionId !== undefined) sessions.add(row.sessionId);
	}
	return sessions;
}

function emptyBuckets(): Record<ScanBucket, number> {
	return { "not-an-ask": 0, "already-linked": 0, "already-covered": 0, "not-in-queue": 0, "may-be-answered": 0, unreadable: 0 };
}

function emptyUnreadableReasons(): ScanUnreadableReasons {
	return { "chunk-failed": 0, "no-label": 0, "not-verbatim": 0, unscanned: 0 };
}

/**
 * The question one swept ask carries (HO3): the label's question, then the words
 * it was found in, quoted. The question is what the operator answers; the quote is why
 * the ask is in his list, and `findOpenDuplicate` drops the tail when it compares
 * two questions, because the message is not the question.
 */
function sweepQuestion(question: string, quote: string): string {
	return `${question} — "${quote.trim()}"`;
}

/**
 * The source one swept ask carries: `sweep:<harness>:<session>@<time>`, the
 * transcript it was read from. A candidate without a timestamp is stamped with
 * the run's own time, so a reader can always find the session and the moment.
 */
function sweepSourceOf(candidate: ScanCandidate, now: number): string {
	return `${SWEEP_SOURCE_PREFIX}${candidate.source}:${candidate.sessionId}@${candidate.at ?? new Date(now).toISOString()}`;
}

/**
 * One scan run. It reads, labels, buckets, raises the asks only the operator can carry
 * out (HO3) and appends the rest of its findings to the review list; it never
 * answers or closes an ask. A dry run stops after the pre-filter: counts only, no
 * model call, no writes.
 */
export async function scanTranscripts(musterStateDir: string, options: ScanOptions): Promise<ScanResult> {
	const dryRun = options.dryRun === true;
	if (!dryRun && options.labeller === undefined) {
		throw new Error("the transcript scan needs a labeller (the delegate offload path); use --dry-run for counts without a model call");
	}
	const now = options.now ?? Date.now();
	const window = { sinceMs: now - scanWindowMs(options.window), untilMs: now };
	const env = options.env ?? process.env;
	const roots = scanRoots(env, options.home ?? homedir());
	const queue = readAsks(musterStateDir, { cardState: programmeCardReader() });
	const waiting = waitingOnOperator(queue);
	// The asks the one labelling call sees besides the candidates (F2ASKS): everything
	// still waiting on the operator, and everything closed inside the window.
	const known = knownAsks(queue, window.sinceMs);
	// The asks this run raises join the queue the dedupe reads, so two candidates
	// in one run, and the next run of either window, raise one ask between them.
	let queueForDedupe: AskQueue = queue;
	const codes = matchableCodes(waiting, env);
	const laneSessionIds = laneSessionsFor(musterStateDir);

	const sources: ScanSourceReport[] = [];
	const candidates: ScanCandidate[] = [];
	let messages = 0;
	for (const source of ["pi", "claude"] as const) {
		const root = source === "pi" ? roots.pi : roots.claude;
		let files: string[] = [];
		try {
			files = source === "pi" ? piSessionFiles(root, window.sinceMs) : piPort("transcripts").listClaudeTranscriptFiles(root).filter((path) => recent(path, window.sinceMs));
		} catch {
			files = [];
		}
		let read = 0;
		let skipped = 0;
		let laneSkipped = 0;
		for (const path of files) {
			const transcript = readTranscript(path, source);
			if (transcript === undefined) continue;
			// Client work never reaches the model: the session is skipped whole.
			if (isExcludedCwd(transcript.cwd)) {
				skipped += 1;
				continue;
			}
			// A lane's session never carries a question for the operator (AK9): the
			// registry's row skips it whole, then the launch brief for a lane the
			// registry no longer lists.
			if (isLaneSession(transcript, laneSessionIds)) {
				laneSkipped += 1;
				continue;
			}
			read += 1;
			messages += transcript.messages.filter(
				(message) => message.timestamp === undefined || (message.timestamp >= window.sinceMs && message.timestamp <= window.untilMs),
			).length;
			candidates.push(...candidatesFrom(source, transcript, window));
		}
		sources.push({ harness: source, files: files.length, read, skipped, laneSkipped });
	}

	const buckets = emptyBuckets();
	const findings: SweepFinding[] = [];
	const chunkFailures: string[] = [];
	const unreadableReasons = emptyUnreadableReasons();
	let recorded: ReviewAppendResult = { appended: [], alreadyThere: 0 };

	if (!dryRun && candidates.length > 0) {
		const labels = await options.labeller!(candidates, (message) => chunkFailures.push(message), known);
		if (!Array.isArray(labels) || labels.length !== candidates.length) {
			throw new Error(`the labeller returned ${Array.isArray(labels) ? labels.length : "no"} labels for ${candidates.length} candidates; the run wrote nothing`);
		}
		for (const [index, candidate] of candidates.entries()) {
			const reason = unreadableReasonOf(labels[index], candidate);
			if (reason !== undefined) {
				buckets.unreadable += 1;
				unreadableReasons[reason] += 1;
				continue;
			}
			const label = labels[index]!;
			const itemCodes = (label.codes ?? [])
				.filter((code): code is string => typeof code === "string" && (codes.has(code) || CODE_SERIES.test(code)));
			const itemText = (label.question?.trim() || candidate.text).slice(0, MAX_FINDING_TEXT);
			const item = { source: candidate.id, codes: itemCodes, text: itemText };
			if (candidate.kind === "operator-deferral") {
				if (matchesWaiting(item, waiting)) {
					buckets["already-linked"] += 1;
					continue;
				}
				buckets["may-be-answered"] += 1;
				findings.push({ finding: "may-be-answered", source: candidate.id, text: candidate.text.slice(0, MAX_FINDING_TEXT) });
				continue;
			}
			if (!label.isAsk) {
				buckets["not-an-ask"] += 1;
				continue;
			}
			if (matchesWaiting(item, waiting)) {
				buckets["already-linked"] += 1;
				continue;
			}
			// The queue's own dedupe decides, told when the message was written and which ask
			// the labeller matched it to (F2ASKS, VR24-166): a need the queue settled before
			// this message, and a need said in other words, both raise nothing.
			const question = sweepQuestion(itemText, label.quote);
			const covering = findOpenDuplicate(queueForDedupe, {
				code: itemCodes[0],
				question,
				at: candidate.at ?? new Date(now).toISOString(),
				sameAs: label.sameAs,
			});
			if (covering !== undefined) {
				if (covering.status === "open" || covering.status === "awaiting-operator") buckets["already-linked"] += 1;
				else buckets["already-covered"] += 1;
				continue;
			}
			buckets["not-in-queue"] += 1;
			// An action only the operator can carry out becomes an ask of its own (HO3). It
			// replaces the review entry the architect used to settle by hand: it goes
			// in through the one ask writer, with the transcript it was found in as its
			// source and the words it was found in as the tail of its question, so
			// the operator sees why it is there. Anything else stays on the review list.
			if ((SWEEP_ASK_KINDS as readonly string[]).includes(label.kind)) {
				const raised = raiseAsk(musterStateDir, {
					by: "architect",
					kind: label.kind as AskKind,
					question,
					source: sweepSourceOf(candidate, now),
					at: new Date(now).toISOString(),
				});
				queueForDedupe = { ...queueForDedupe, asks: [...queueForDedupe.asks, raised] };
				continue;
			}
			findings.push({ finding: "not-in-queue", source: candidate.id, text: itemText });
		}
		recorded = recordReviewFindings(musterStateDir, findings, new Date(now).toISOString());
	}

	const result: Omit<ScanResult, "accounting"> = {
		window: options.window,
		sources,
		messages,
		candidates: candidates.length,
		buckets,
		unreadableReasons,
		findings,
		chunkFailures,
		labelled: !dryRun,
	};
	return { ...result, accounting: formatScanAccounting(result, recorded) };
}

/** The one accounting line a run prints: every session, message and candidate, counted. */
export function formatScanAccounting(result: Omit<ScanResult, "accounting">, recorded: ReviewAppendResult): string {
	const filesOf = (harness: "pi" | "claude"): number => result.sources.find((source) => source.harness === harness)?.files ?? 0;
	const skipped = result.sources.reduce((sum, source) => sum + source.skipped, 0);
	const laneSkipped = result.sources.reduce((sum, source) => sum + source.laneSkipped, 0);
	const head = [
		`asks sweep --since ${result.window}${result.labelled ? "" : " (dry run)"}`,
		`${plural(result.sources.reduce((sum, source) => sum + source.read, 0), "session")} (pi ${filesOf("pi")}, claude ${filesOf("claude")}${skipped > 0 ? `, ${skipped} skipped excluded` : ""}${laneSkipped > 0 ? `, ${laneSkipped} skipped lane` : ""})`,
		plural(result.messages, "message"),
	];
	if (!result.labelled) {
		return [...head, `${plural(result.candidates, "candidate")} (unlabelled)`, "nothing written to the review list"].join(", ");
	}
	const buckets = result.buckets;
	const reasons = result.unreadableReasons;
	const unreadable = buckets.unreadable > 0
		? `${buckets.unreadable} unreadable (${reasons["chunk-failed"]} chunk-failed, ${reasons["no-label"]} no-label, ${reasons["not-verbatim"]} not-verbatim, ${reasons.unscanned} unscanned)`
		: `${buckets.unreadable} unreadable`;
	// The first line of each distinct chunk error (AK8), a healed run's included: the text stays bounded to 200 characters.
	const chunkErrorLines = [...new Set(result.chunkFailures)].map((message) => message.split("\n")[0]!.slice(0, 200));
	return [
		...head,
		`${result.candidates} candidates: ${buckets["not-an-ask"]} not an ask, ${buckets["already-linked"]} already linked to an open ask, ${buckets["already-covered"]} already covered by a settled ask, ${buckets["not-in-queue"]} not-in-queue, ${buckets["may-be-answered"]} may-be-answered, ${unreadable}${chunkErrorLines.length > 0 ? `, chunk errors: ${chunkErrorLines.join(", ")}` : ""}`,
		`${recorded.appended.length} written to the review list, ${recorded.alreadyThere} already there`,
	].join(", ");
}

// ─── The labeller (the delegate extension's offload substrate) ───────────────

/** The env var that names the Pi executable, as the lane launcher spells it (`pi-lane-launch.sh`). */
const PI_BIN_ENV = "PI_BIN";
const PI_BIN_DEFAULT = join(homedir(), "projects", "pi-mono", "run-custom.sh");
/**
 * The scan unit's own start timeout (`systemd/muster-asks-scan.service`,
 * `TimeoutStartSec`), the ceiling one run must fit inside: systemd kills the run
 * at it, and a killed run writes nothing.
 */
export const SCAN_SERVICE_TIMEOUT_MS = 1_800_000;
/** What a run leaves of the service timeout for reading the transcripts and writing the findings. */
export const SCAN_READ_WRITE_RESERVE_MS = 300_000;
/** The labelling phase's budget: the unit's start timeout less the reserve, counted from the process start. */
export const SCAN_LABEL_BUDGET_MS = SCAN_SERVICE_TIMEOUT_MS - SCAN_READ_WRITE_RESERVE_MS;
/**
 * One attempt's own timeout. The live run of 2026-10-17 spent the whole unit's
 * start timeout inside a single hung model call and wrote nothing, so an attempt
 * is cut here: its chunk moves to the next model in the pool's chain, and the
 * budget check keeps the run inside `SCAN_LABEL_BUDGET_MS`.
 */
export const LABEL_ATTEMPT_TIMEOUT_MS = 180_000;

/**
 * The env var that names the labeller's model, so an operator can move the
 * labelling run off a walled route without touching the pool's session route.
 */
export const LABEL_MODEL_ENV = "MUSTER_ASKS_LABEL_MODEL";

/**
 * The labeller's model, with no model literal of its own: `MUSTER_ASKS_LABEL_MODEL`
 * when an operator pins one, else the first entry of the labelling role's chain in
 * the one provider list, read through the routing owner (`loadPoolConfig`) — never
 * the caller's session default. `offloadLabeller` passes `LABEL_ROLE`, the worker
 * roster `provider-policy.ts` also names, and the same list its fallbacks come from.
 * A list that is unreadable, or that names no such role, is an error: a labelling
 * run never invents a route.
 */
export function labelModelRoute(env: NodeJS.ProcessEnv = process.env, poolPath: string = poolConfigPath(), role: string = LABEL_ROLE): string {
	const named = env[LABEL_MODEL_ENV]?.trim();
	if (named !== undefined && named !== "") return named;
	const loaded = loadPoolConfig(poolPath);
	if (!loaded.ok) throw new Error(`the provider list at ${poolPath} is unreadable, so the labelling route is unknown: ${loaded.errors.join("; ")}`);
	const head = loaded.config.roles[role]?.[0];
	if (head === undefined) throw new Error(`the provider list names no "${role}" role, so the labelling route is unknown`);
	return head;
}

/**
 * The flags one labelling run starts Pi with. The live `--since 4d` run passed
 * only `--print`: that booted a full Pi session (it joined Muster as an agent,
 * ran the janitor, consumed control messages) on the session default model,
 * which was walled. The flags isolate the run to one print-mode turn on the
 * labeller's own cheap model, and the labelled run joins Muster never.
 */
export const PI_LABEL_FLAGS = [
	"--no-session",
	"--no-extensions",
	"--no-tools",
	"--no-skills",
	"--no-prompt-templates",
	"--model",
] as const;

/** The Pi executable one headless labelling run starts. */
export function piExecutable(env: NodeJS.ProcessEnv = process.env): string {
	const named = env[PI_BIN_ENV]?.trim();
	return named !== undefined && named !== "" ? named : PI_BIN_DEFAULT;
}

/**
 * One attempt cut for exceeding its own timeout: the kill `runPiPrint` performs,
 * and the labeller's own guard for a run that ignores the timeout it is given.
 * A timeout is a route failure: the chunk moves to the next model in the pool.
 */
export class LabellerTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LabellerTimeoutError";
	}
}

/**
 * How a provider words a rejected credential: an HTTP 401 or 403 status line, or
 * the words. The pool's `credential-rejected` shape walls the one wording it names
 * ("Invalid credential") for the router; the other wordings and a 403 are no wall
 * and have no reset, so the scan still reads them as a route failure itself.
 */
const CREDENTIAL_REJECTED = /(?:^|\D)40[13]:|invalid credential|invalid api key|unauthori[sz]ed/i;

/**
 * One failed `pi --print` run: the one-line message the accounting line prints,
 * and the run's own stderr, where a provider words its quota wall.
 */
export class LabellerRunError extends Error {
	/** The run's whole stderr, kept off the message so an accounting line stays one line. */
	readonly stderr: string;
	constructor(message: string, stderr: string) {
		super(message);
		this.name = "LabellerRunError";
		this.stderr = stderr;
	}
}

/** One `pi --print` run: stdout, or a failure naming what went wrong. */
export type PiPrintRun = (command: string, args: readonly string[], timeoutMs: number) => Promise<string>;

/**
 * The launcher's own notice, never a failure: `scripts/session-launch.sh` prints
 * `session-launch: …` on stderr before the child starts, so it is stderr's first
 * line on every run `run-custom.sh` starts — the runs that succeed and the runs
 * that then fail. The cause is the first line after it (SCANFIX F3,
 * `docs/qa/scanfix-impact-map-2026-10-28.md`).
 */
const LAUNCHER_NOTICE = /^session-launch: /;

/** The one stderr line a failed run is named by: the first that is not the launcher's notice. */
function stderrCause(stderr: string): string {
	for (const line of stderr.split("\n")) {
		const trimmed = line.trim();
		if (trimmed !== "" && !LAUNCHER_NOTICE.test(trimmed)) return trimmed;
	}
	return "";
}

function runPiPrint(command: string, args: readonly string[], timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new LabellerTimeoutError(`the labeller's Pi run exceeded ${Math.round(timeoutMs / 1000)}s and was stopped`));
		}, timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(new LabellerRunError(`the labeller could not start ${command}: ${error instanceof Error ? error.message : String(error)}`, stderr));
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve(stdout);
			else {
				const cause = stderrCause(stderr);
				reject(new LabellerRunError(`the labeller's Pi run exited ${code}${cause !== "" ? `: ${cause}` : ""}`, stderr));
			}
		});
	});
}

/**
 * One ask as one prompt line (F2ASKS): its id, its status, when it was settled — the close
 * of a done or withdrawn ask, the answer of a decided one — and its question, flattened so
 * one ask is never two lines.
 */
function knownAskLine(ask: KnownAsk): string {
	const question = ask.question.replace(/\s+/g, " ").trim().slice(0, 300);
	const settled = ask.status === "decided" ? ask.answeredAt : ask.closedAt;
	const when = settled !== undefined ? `, ${ask.status === "decided" ? "answered" : "closed"} ${settled}` : "";
	return `- ${ask.id} ${ask.status}${when} — "${question}"`;
}

/**
 * The one prompt the labeller sends: the candidates as JSON, the asks already in the
 * queue as one line each, the label shape, and the one rule that keeps work talk out
 * of the queue — only a message that asks the operator the person for something is an ask.
 * The known asks are what the same call answers `sameAs` from (F2ASKS, VR24-166); an
 * empty list prints as `none`, so the model is never asked to name an ask it cannot see.
 */
export function labellerPrompt(candidates: readonly ScanCandidate[], known: readonly KnownAsk[] = []): string {
	const payload = candidates.map((candidate) => ({
		id: candidate.id,
		kind: candidate.kind,
		at: candidate.at,
		text: candidate.text,
	}));
	return [
		"You label candidate messages taken from coding-session transcripts, for an ask-queue sweeper.",
		"For every candidate in the JSON array below, return one object:",
		'  { "id": <the candidate\'s id>, "isAsk": <boolean>, "kind": <string>, "question": <string>, "codes": <string[]>, "sameAs": <string>, "quote": <string> }',
		"- isAsk: true only when the message asks the operator the person (the human who runs these sessions) for a decision, an approval, a credential, an action or a review that waits on him. A message addressed to another agent or to the model itself, and ordinary work talk, is not an ask.",
		`- kind: what the message needs, one of ${LABEL_KINDS.join(", ")}. operator-action is a step he does with his own hands or devices (a DNS change, a machine reboot); human-login is a login only he can complete (a 2FA prompt); credential is a key or secret he must create; authorization is a ruling only he can give; product-decision is a product rule he decides; review is a review of work. Use none when isAsk is false, and when none of the kinds fits.`,
		"- question: when isAsk, the question as it would be put to the operator, one line, plain words. When not isAsk, omit it or return an empty string.",
		"- codes: any item codes the message names (shapes like VD7, VH3, DQ2, H1). Only codes the message actually names; an empty array otherwise.",
		"- sameAs: when the candidate asks the same need as one of the asks already in the queue below, even in different words, that ask's id. Omit it or return an empty string otherwise. Only an id from that list is read.",
		"- quote: a verbatim substring of the message's own text that carries the ask or the deferral. Copy it exactly; a quote that is not in the text is discarded. When isAsk is false and the candidate's kind is agent-question, there is nothing to quote: return an empty string.",
		"Answer with ONLY the JSON array, no prose before or after it.",
		"",
		"Asks already in the queue, one line each (id, status, settled time, question). A closed or answered ask is one the operator settled: one settled before the candidate was written no longer covers it, and the scan decides that from the dates, so still name the same ask whenever the need is the same. Name none of them when nothing in the list is the same need.",
		...(known.length > 0 ? known.map(knownAskLine) : ["- none"]),
		"",
		JSON.stringify(payload, null, 2),
	].join("\n");
}

/**
 * The labelling prompt's hard bound. The OS refuses one argv argument past
 * about 128 KB ("spawn E2BIG", the first live `--since 4d` run), so every
 * prompt stays well under it.
 */
export const MAX_LABEL_PROMPT_BYTES = 60_000;
/** The most candidates one labelling run carries. */
export const MAX_LABEL_CHUNK_CANDIDATES = 15;
/**
 * The longest one candidate's text in a prompt. The cut is a prefix, so a
 * quote the model takes off the sent text stays verbatim in the message.
 */
export const MAX_LABEL_CANDIDATE_CHARS = 4_000;

/** One prompt's candidates, each text cut to the fixed length. */
function promptCandidates(candidates: readonly ScanCandidate[]): ScanCandidate[] {
	return candidates.map((candidate) =>
		candidate.text.length > MAX_LABEL_CANDIDATE_CHARS ? { ...candidate, text: candidate.text.slice(0, MAX_LABEL_CANDIDATE_CHARS) } : candidate,
	);
}

/**
 * The candidates in the prompt-sized chunks one labelling run each carries, in
 * candidate order. Every chunk holds at most `MAX_LABEL_CHUNK_CANDIDATES` and
 * every prompt, the known-asks block included, stays under
 * `MAX_LABEL_PROMPT_BYTES`, so no single argv argument can reach the OS
 * per-argument limit.
 */
export function chunkCandidates(candidates: readonly ScanCandidate[], known: readonly KnownAsk[] = []): ScanCandidate[][] {
	const chunks: ScanCandidate[][] = [];
	let chunk: ScanCandidate[] = [];
	for (const candidate of candidates) {
		const next = [...chunk, candidate];
		const fits =
			chunk.length < MAX_LABEL_CHUNK_CANDIDATES &&
			Buffer.byteLength(labellerPrompt(promptCandidates(next), known), "utf8") <= MAX_LABEL_PROMPT_BYTES;
		if (!fits && chunk.length > 0) {
			chunks.push(chunk);
			chunk = [candidate];
			continue;
		}
		chunk = next;
	}
	if (chunk.length > 0) chunks.push(chunk);
	return chunks;
}

/** The labels from the run's stdout: one JSON array, one label per candidate. */
export function parseLabels(output: string, count: number): ScanLabel[] {
	const start = output.indexOf("[");
	const end = output.lastIndexOf("]");
	if (start < 0 || end <= start) throw new Error(`the labeller's reply holds no JSON array for ${count} candidates`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(output.slice(start, end + 1));
	} catch (error) {
		throw new Error(`the labeller's reply is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!Array.isArray(parsed) || parsed.length !== count) {
		throw new Error(`the labeller's reply is not one JSON array of ${count} labels`);
	}
	return parsed as ScanLabel[];
}

export type OffloadLabellerOptions = {
	env?: NodeJS.ProcessEnv;
	/** One attempt's own timeout (`LABEL_ATTEMPT_TIMEOUT_MS`). */
	timeoutMs?: number;
	/** The whole labelling phase's deadline, epoch ms. Defaults to the process start plus `SCAN_LABEL_BUDGET_MS`. */
	deadlineMs?: number;
	/** The clock the budget and the wall classifier read. */
	now?: () => number;
	run?: PiPrintRun;
	/** The provider list the fallback chain comes from (`provider-pool.json`); `poolConfigPath` by default. */
	poolPath?: string;
	/** The pool role whose chain supplies the next model (`LABEL_ROLE`). */
	role?: string;
	/** Receives each failed chunk's error text; the scan passes its own through the labeller call. */
	onError?: (message: string) => void;
};

/**
 * The pool role the labeller's fallback chain comes from: the worker roster the
 * provider list owns (`provider-policy.ts` `poolWorkerRole`), the same role the
 * delegate's offload mode runs on (`delegate.ts`). The primary is still
 * `MUSTER_ASKS_LABEL_MODEL`; the list supplies only its fallbacks, so an
 * operator's pin and the chain stay one route each and no second list exists.
 */
export const LABEL_ROLE = "worker";

/**
 * The production labeller: one isolated headless Pi run per chunk in print mode
 * (`pi --no-session --no-extensions --no-tools --no-skills
 * --no-prompt-templates --model <MUSTER_ASKS_LABEL_MODEL|the pool worker-role head>
 * --print`), on an approved cheap worker route — never the caller's session
 * default, never a session that joins Muster. The candidates travel in
 * prompt-sized chunks and the labels come back merged in candidate order. A
 * chunk whose run fails is retried once, as two halves (AK8); a half still
 * failing leaves its candidates with the chunk-failed placeholder, which the
 * scan counts unreadable instead of reading them as "not an ask", and every
 * failed attempt's error text reaches both collectors: the caller's `onError`
 * from the call, and `options.onError` (the CLI's own) when one was built in.
 *
 * Each attempt is cut at its own timeout, and a chunk whose attempt timed out or
 * met a quota wall moves to the next model in the provider list's role chain
 * (`fallbackRef`) instead of being split. The whole phase is bounded by the
 * unit's start timeout (`SCAN_LABEL_BUDGET_MS`, from the process start): a part
 * the budget can no longer hold stops the run, every candidate it did not reach
 * carries the `unscanned` placeholder, and the chunks it labelled are still
 * returned for the scan to write.
 */
export function offloadLabeller(options: OffloadLabellerOptions = {}): AskScanLabeller {
	const run = options.run ?? runPiPrint;
	const attemptTimeoutMs = options.timeoutMs ?? LABEL_ATTEMPT_TIMEOUT_MS;
	const env = options.env ?? process.env;
	const poolPath = options.poolPath ?? poolConfigPath();
	const role = options.role ?? LABEL_ROLE;
	const now = options.now ?? Date.now;
	// The unit's start timeout runs from the process start, so this phase's deadline does too: whatever the
	// transcript read already spent is not available to the model calls, and the reserve stays for the write.
	// `process.uptime()` is how a run knows its own start without another setting to keep in step.
	const deadlineMs = options.deadlineMs ?? now() - Math.round(process.uptime() * 1000) + SCAN_LABEL_BUDGET_MS;
	return async (candidates, onError, known = []) => {
		if (candidates.length === 0) return [];
		const labels: ScanLabel[] = [];
		const report = (message: string) => {
			onError?.(message);
			options.onError?.(message);
		};
		/** The route this run is on: the operator's pin first, then the pool's own chain. */
		let model = labelModelRoute(env, poolPath, role);
		/** The one provider list, read at the first failure: a run whose primary works never touches it. */
		let pool: PoolConfig | undefined;
		let poolRead = false;
		const poolConfig = (): PoolConfig | undefined => {
			if (!poolRead) {
				poolRead = true;
				const loaded = loadPoolConfig(poolPath, now());
				if (loaded.ok) pool = loaded.config;
			}
			return pool;
		};
		/** The walls this run learned: a walled route is skipped for the run's later chunks, never written to the pool's state. */
		const walls: Record<string, Wall> = {};
		/** The refs this run tried, so the walk never returns to one. */
		const tried = new Set<string>();
		/** The next model for a failed route: the pool's fallback rule, which never returns the same wall or provider. */
		const nextModel = (failed: string, quota: QuotaClassification | undefined): string | undefined => {
			tried.add(failed);
			const config = poolConfig();
			if (config === undefined) return undefined;
			if (quota !== undefined && quota.quota) walls[wallKey(config, failed)] = wallFor(quota.resetAt, now(), config);
			return fallbackRef(config, role, failed, { now: now(), walls, skip: tried });
		};
		/** The run's own reading of a failed attempt's text: the pool's quota shapes are the only owner of a wall's wording. */
		const quotaWall = (detail: string): QuotaClassification | undefined => {
			const config = poolConfig();
			if (config === undefined) return undefined;
			const wall = classifyQuota({ stopReason: "error", errorMessage: detail }, config.quotaShapes, now());
			return wall.quota ? wall : undefined;
		};
		/** A rejected credential (the 401 of 2026-10-17): the route is dead for this run, whatever the prompt holds. */
		const credentialRejected = (detail: string): boolean => CREDENTIAL_REJECTED.test(detail);
		const detailOf = (error: unknown): string =>
			error instanceof LabellerRunError && error.stderr.trim() !== "" ? `${error.message}\n${error.stderr}` : error instanceof Error ? error.message : String(error);
		type Attempt = { ok: true; labels: ScanLabel[] } | { ok: false; message: string; detail: string; timedOut: boolean };
		/** One attempt, cut at `attemptMs`: the run's own kill, and this race for a run that ignores it. */
		const attempt = async (items: readonly ScanCandidate[], attemptModel: string, attemptMs: number): Promise<Attempt> => {
			const work = run(
				piExecutable(env),
				[...PI_LABEL_FLAGS, attemptModel, "--print", labellerPrompt(promptCandidates(items), known)],
				attemptMs,
			);
			// The race below can settle first, so the later rejection is still handled here; `runPiPrint`'s own kill ends the child.
			void work.catch(() => undefined);
			let timer: NodeJS.Timeout | undefined;
			try {
				const output = await Promise.race([
					work,
					new Promise<never>((_resolve, reject) => {
						timer = setTimeout(
							() => reject(new LabellerTimeoutError(`the labeller's Pi run exceeded ${Math.round(attemptMs / 1000)}s and was stopped`)),
							attemptMs,
						);
					}),
				]);
				return { ok: true, labels: parseLabels(output, items.length) };
			} catch (error) {
				return {
					ok: false,
					timedOut: error instanceof LabellerTimeoutError,
					message: error instanceof Error ? error.message : String(error),
					detail: detailOf(error),
				};
			} finally {
				if (timer !== undefined) clearTimeout(timer);
			}
		};
		const chunks = chunkCandidates(candidates, known);
		/** Every candidate the run will not reach: `unscanned`, never read as "not an ask". */
		const unscanned = (parts: readonly (readonly ScanCandidate[])[]): void => {
			for (const part of parts) for (let index = 0; index < part.length; index += 1) labels.push({ isAsk: false, kind: "none", quote: CHUNK_UNSCANNED_QUOTE });
		};
		for (const [at, chunk] of chunks.entries()) {
			// One chunk at a time, in parts: the whole chunk first, its two halves after a content failure
			// (AK8), and the same part again on the next model after a route failure.
			const queue: Array<{ items: ScanCandidate[]; split: boolean }> = [{ items: chunk, split: true }];
			const left = (part: { items: ScanCandidate[] }): ScanCandidate[][] => [
				part.items,
				...queue.map((queued) => queued.items),
				...chunks.slice(at + 1),
			];
			while (queue.length > 0) {
				const part = queue.shift()!;
				const remaining = deadlineMs - now();
				if (remaining < attemptTimeoutMs) {
					const pending = left(part).reduce((sum, items) => sum + items.length, 0);
					report(
						`the labelling run stopped at its budget with ${Math.round(remaining / 1000)}s left, short of one attempt's ${Math.round(attemptTimeoutMs / 1000)}s: ${pending} candidates are unscanned`,
					);
					unscanned(left(part));
					return labels;
				}
				const outcome = await attempt(part.items, model, Math.min(attemptTimeoutMs, remaining));
				if (outcome.ok) {
					labels.push(...outcome.labels);
					continue;
				}
				report(outcome.message);
				const quota = quotaWall(outcome.detail);
				if (outcome.timedOut || quota !== undefined || credentialRejected(outcome.detail)) {
					// A route failure: a hung, walled or credential-rejecting model is not a prompt-size problem,
					// so the same part moves to the next model in the list's chain rather than being split.
					const next = nextModel(model, quota);
					if (next === undefined) {
						// The chain is spent for this run: every candidate from here on carries the unscanned
						// placeholder, and the report says how many, so the journal names the loss and not only the route.
						const pending = left(part).reduce((sum, items) => sum + items.length, 0);
						report(`no further model in the provider list's "${role}" chain after ${model}: ${pending} candidates were not labelled`);
						unscanned(left(part));
						return labels;
					}
					model = next;
					queue.unshift(part);
					continue;
				}
				// One retry, as two halves (AK8): a smaller prompt survives what the whole chunk may not,
				// and the failed attempt's error is still reported. A chunk of one is retried as itself.
				if (part.split) {
					const mid = Math.ceil(part.items.length / 2);
					queue.unshift(
						...(part.items.length > 1
							? [{ items: part.items.slice(0, mid), split: false }, { items: part.items.slice(mid), split: false }]
							: [{ items: part.items, split: false }]),
					);
					continue;
				}
				// The failed part's candidates are unreadable, never not-an-ask, and every other part's
				// labels survive in candidate order.
				for (let index = 0; index < part.items.length; index += 1) labels.push({ isAsk: false, kind: "none", quote: CHUNK_FAILED_QUOTE });
			}
		}
		return labels;
	};
}

// ─── The comparison report ("The sweeper" step 3) ────────────────────────────

/** One item of the operator's last hand audit, as Grokbot reads the list out. */
export type HandAuditItem = { code: string | undefined; text: string; struck: boolean };

/** A code-shaped leading token: letters, then a digit (`VD7`, `H1`), as the snapshot parser spells the shape. */
const AUDIT_CODE = /^([A-Za-z][A-Za-z0-9.]*\d+)\s+(.*)$/;

/**
 * One item per non-empty line; `~~` marks a settled item; a leading code-shaped
 * token is the item's code. A line that only carries a code is not an item.
 */
export function parseHandAudits(text: string): HandAuditItem[] {
	const items: HandAuditItem[] = [];
	for (const raw of text.split("\n")) {
		let line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		line = line.replace(/^[-*]\s+/, "");
		const struck = line.includes("~~");
		const flat = line.replace(/~~/g, "").trim();
		const coded = AUDIT_CODE.exec(flat);
		const body = (coded?.[2] ?? flat).replace(/[.;]+$/, "").trim();
		if (body === "") continue;
		items.push({ code: coded?.[1], text: body, struck });
	}
	return items;
}

/** Does one audit item answer to one finding: the same code where both have one, or the text match the queue's own bar clears. */
function auditMatches(item: HandAuditItem, finding: SweepFinding): boolean {
	if (item.code !== undefined && finding.text.trim().startsWith(`${item.code} `)) return true;
	// The matcher and the bar are the owners' own: the import script's `textMatch`, the queue's `textMatchCounts`.
	return textMatchCounts(item.text, finding.text) || textMatchCounts(finding.text, item.text) || textMatch(item.text, finding.text).exact;
}

export type ComparisonInput = {
	/** The report's own date, `YYYY-MM-DD`. */
	date: string;
	/** The review list's findings, from the file diff and the scan runs. */
	findings: readonly SweepFinding[];
	/** the operator's last hand audits; empty until the architect provides them. */
	audits: readonly HandAuditItem[];
	proposalPath?: string;
};

/**
 * The comparison report (`plans/muster-autonomy/asks-sweep-comparison-<date>.md`):
 * what the sweeper found, what the operator's hand audits hold, the two matched item
 * by item with every difference counted and explained, and the gaps the sweep
 * cannot close, stated plainly. The architect accepts the report with a `noted`
 * event on a tracking ask; only then are the two timers enabled.
 */
export function renderComparisonReport(input: ComparisonInput): string {
	const proposal = input.proposalPath ?? "plans/muster-autonomy/operator-queue-proposal-2026-10-16.md";
	const byKind = (kind: SweepFinding["finding"]): SweepFinding[] => input.findings.filter((finding) => finding.finding === kind);
	const matchedAuditIndexes = new Set<number>();
	const matchedFindingKeys = new Set<string>();
	const rows: string[] = [];
	for (const [index, item] of input.audits.entries()) {
		const at = input.findings.findIndex((finding) => auditMatches(item, finding));
		if (at >= 0) {
			matchedAuditIndexes.add(index);
			matchedFindingKeys.add(`${input.findings[at]!.finding}\u0000${input.findings[at]!.source}\u0000${input.findings[at]!.text}`);
			rows.push(`| ${item.struck ? `~~${item.text}~~` : item.text} | ${input.findings[at]!.finding} (${input.findings[at]!.source}) | agreed |`);
		} else {
			rows.push(`| ${item.struck ? `~~${item.text}~~` : item.text} | nothing | missed by the sweep — neither the file diff nor the scan produced it |`);
		}
	}
	const extras = input.findings.filter((finding) => !matchedFindingKeys.has(`${finding.finding}\u0000${finding.source}\u0000${finding.text}`));
	const matched = matchedAuditIndexes.size;
	const missed = input.audits.length - matched;
	const lines = [
		`# Asks sweep comparison — ${input.date}`,
		"",
		`The sweeper's first \`--files\` run and first \`--since 4d\` scan, item by item against the operator's last hand audits`,
		`(\`${proposal}\`, "The sweeper" step 3). The architect accepts this report with a \`noted\` event on a tracking ask;`,
		"only then are the hourly diff timer and the 06:00 scan timer enabled.",
		"",
		"## What the sweeper found",
		"",
	];
	if (input.findings.length === 0) lines.push("The review list is empty.");
	else {
		for (const kind of ["not-in-queue", "may-be-done", "may-be-answered"] as const) {
			const kindRows = byKind(kind);
			if (kindRows.length === 0) continue;
			lines.push(`### ${kind} (${kindRows.length})`, "");
			for (const finding of kindRows) lines.push(`- ${finding.source} — ${finding.text}`);
			lines.push("");
		}
	}
	lines.push("## the operator's hand audits (from Grokbot)", "");
	if (input.audits.length === 0) lines.push("Not provided yet; the architect gets the list from Grokbot.", "");
	else {
		for (const item of input.audits) lines.push(`- ${item.code !== undefined ? `${item.code} ` : ""}${item.struck ? `~~${item.text}~~` : item.text}`);
		lines.push("");
	}
	lines.push("## Item by item", "");
	if (input.audits.length === 0) lines.push("The comparison runs when the audit list arrives.", "");
	else {
		lines.push("| the operator's audit item | The sweeper found | Difference |", "| --- | --- | --- |", ...rows, "");
	}
	if (extras.length > 0) {
		lines.push("### Findings no audit item accounts for", "");
		for (const finding of extras) lines.push(`- ${finding.finding} ${finding.source} — ${finding.text}`);
		lines.push("");
	}
	lines.push(
		"## Counts",
		"",
		`- audit items: ${input.audits.length} — matched ${matched}, missed by the sweep ${missed}`,
		`- findings: ${input.findings.length} — accounted for by an audit item ${input.findings.length - extras.length}, extra ${extras.length}`,
		"",
		"## Gaps the sweep cannot close",
		"",
		"- An answer given by voice to Bob exists only if Bob records it with `asks_answer`.",
		"- OpenCode and Hermes sessions have no transcript reader and are not scanned.",
		"",
	);
	return lines.join("\n");
}
