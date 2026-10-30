/**
 * The Henry wake: one GitHub issue in a private mailbox repo, so a Grok Bot routine on GitHub
 * notifications starts a conversation that reads `outbox_read`.
 *
 * Only the sender, the first line of the message (80 characters) and the file count go to GitHub.
 * No file content and no further message text. Fail-open: the caller logs a failure once and the
 * send stays a success. A routine that never fires leaves Henry reading deliveries at his next
 * conversation, as before.
 *
 * The issue is assigned, because Henry's listener fires only on an assignment (Henry, 2026-10-22).
 *
 * It authenticates `gh` with a token resolved fresh for every issue (TICKGH): the process environment,
 * then `gh auth token`, then the `GITHUB_TOKEN` line of the operator's `~/.bashrc`. The value rides in that one
 * child's environment as `GH_TOKEN`, never in a message, a log line or the queue.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactSensitiveText } from "../core/self-improving-redactor.ts";

/** The private repo the orchestrator creates once (VR6). Configurable for tests and a rename. */
export const DEFAULT_MAILBOX_REPO = "muster-dev/henry-mailbox";
/** The account the issue is assigned to: a notification on it is what starts Henry's conversation. Configurable for tests and a rename. */
export const DEFAULT_MAILBOX_ASSIGNEE = "muster-dev";
export const WAKE_TIMEOUT_MS = 5_000;
/** `gh auth token` answers at once or not at all: asking never holds a wake longer than one wake timeout. */
const AUTH_TOKEN_TIMEOUT_MS = 5_000;
/** The token names `gh` itself honours, in its own order of preference. */
const GH_TOKEN_NAMES = ["GH_TOKEN", "GITHUB_TOKEN"] as const;
/** the operator's shell exports the working token; the tick's systemd environment does not (TICKGH). */
const SHELL_TOKEN_FILE = ".bashrc";
const TITLE_LINE_CHARS = 80;

export type WakeExec = (command: string, args: string[], timeoutMs: number, env?: Readonly<Record<string, string>>) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

/** What the wake reads outside the injected exec for its token: the environment, gh's own login, the operator's shell file. */
export type WakeTokenDeps = { exec: WakeExec; gh?: string; env?: NodeJS.ProcessEnv; shellFile?: string };

/** The wake's dependencies: the exec, the mailbox target, and the token sources. */
export type WakeDeps = WakeTokenDeps & { repo?: string; assignee?: string };

/** A token the caller already keeps in its environment, `GH_TOKEN` first, as `gh` reads them. */
function envToken(env: NodeJS.ProcessEnv): string | undefined {
	for (const name of GH_TOKEN_NAMES) {
		const value = env[name]?.trim();
		if (value !== undefined && value !== "") return value;
	}
	return undefined;
}

/**
 * `gh auth token`, asked fresh for every wake. It exits non-zero while `gh`'s own login file holds no
 * token, which is the stale source TICKGH found; its words are read for nothing and kept nowhere.
 */
async function ghAuthToken(deps: WakeTokenDeps): Promise<string | undefined> {
	try {
		const result = await deps.exec(deps.gh ?? "gh", ["auth", "token"], AUTH_TOKEN_TIMEOUT_MS);
		if (result.exitCode !== 0) return undefined;
		const value = result.stdout.trim();
		return value === "" ? undefined : value;
	} catch {
		return undefined;
	}
}

/**
 * The `GITHUB_TOKEN` line of the operator's shell file, parsed in-process: no shell is sourced and nothing is
 * written back. Surrounding quotes are stripped; an empty value, an unexpanded `$` reference or
 * whitespace reads as absent, because none of those can be a token.
 */
function shellToken(path: string): string | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	let found: string | undefined;
	for (const line of text.split("\n")) {
		const match = /^\s*(?:export\s+)?GITHUB_TOKEN\s*=\s*(.*)$/.exec(line);
		if (match === null) continue;
		const value = (match[1] ?? "").trim().replace(/^(['"])(.*)\1$/, "$2").trim();
		if (value === "" || /[\s$`]/.test(value)) continue;
		found = value;
	}
	return found;
}

/**
 * TICKGH: the token for one wake, resolved fresh each time and never cached. The process environment
 * first (the unit sets neither name today), then `gh auth token`, then the operator's shell file.
 */
async function resolveGhToken(deps: WakeTokenDeps): Promise<string | undefined> {
	const fromEnv = envToken(deps.env ?? process.env);
	if (fromEnv !== undefined) return fromEnv;
	const fromGh = await ghAuthToken(deps);
	if (fromGh !== undefined) return fromGh;
	return shellToken(deps.shellFile ?? join(homedir(), SHELL_TOKEN_FILE));
}

export type WakeInfo = { messageId: string; from: string; firstLine: string; attachmentCount: number };

/** The part of a message that may reach GitHub: its first line, secrets redacted, one line, at most 80 characters. */
export function wakeLine(firstLine: string): string {
	return redactSensitiveText(firstLine, { preservePaths: true, strictAssignments: true })
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.trim()
		.slice(0, TITLE_LINE_CHARS);
}

/** The issue title: `<from>: <first line, at most 80 characters>`, one line, no control characters, secrets redacted. */
export function wakeTitle(from: string, firstLine: string): string {
	return `${from}: ${wakeLine(firstLine)}`;
}

/**
 * One `gh issue create`, with the freshly resolved token in that child's environment only and under
 * the one name `gh` reads it from. Throws with gh's own words when it fails; the token is never among
 * them, whatever gh prints.
 */
async function ghIssueCreate(args: string[], deps: WakeDeps): Promise<void> {
	const token = await resolveGhToken(deps);
	const result = await deps.exec(deps.gh ?? "gh", ["issue", "create", ...args], WAKE_TIMEOUT_MS, token === undefined ? undefined : { GH_TOKEN: token });
	if (result.exitCode === 0) return;
	const said = (result.stderr || result.stdout).trim();
	const detail = (token === undefined ? said : said.split(token).join("<redacted>")).slice(-300);
	throw new Error(`gh issue create failed (${result.exitCode === null ? "no exit code" : `exit ${result.exitCode}`})${detail === "" ? "" : `: ${detail}`}`);
}

/** `gh issue create` through the injected exec (no shell). Throws with gh's own words when it fails. */
export async function wakeGrokbot(info: WakeInfo, deps: WakeDeps): Promise<void> {
	const count = info.attachmentCount;
	await ghIssueCreate([
		"--repo", deps.repo ?? DEFAULT_MAILBOX_REPO,
		"--assignee", deps.assignee ?? DEFAULT_MAILBOX_ASSIGNEE,
		"--title", wakeTitle(info.from, info.firstLine),
		"--body", `Delivery ${info.messageId} with ${count} file(s). Read it with outbox_read.`,
	], deps);
}

/**
 * The senders that write to Henry on a schedule (the tick's lane notices, the janitor's daily summary).
 * Their wakes are batched: one issue per hour at most, the other messages wait in the inbox and are
 * named in the next issue. Every other sender wakes at once.
 */
export const BATCHED_WAKE_SENDERS: readonly string[] = ["muster-tick", "muster-janitor"];
export const BATCH_WAKE_INTERVAL_MS = 3_600_000;
/** Beside the inbox and the send log in the Muster state dir. */
export const WAKE_STATE_FILE = "henry-wake.json";
const DIGEST_LINES = 30;

type QueuedWake = { id: string; from: string; line: string };
type WakeState = { lastBatchAt: number; pending: QueuedWake[] };

export type GatedWakeDeps = WakeDeps & { stateDir: string; now: () => number };

function readWakeState(stateDir: string): WakeState {
	try {
		const parsed = JSON.parse(readFileSync(join(stateDir, WAKE_STATE_FILE), "utf8")) as Partial<WakeState>;
		return { lastBatchAt: typeof parsed.lastBatchAt === "number" ? parsed.lastBatchAt : 0, pending: Array.isArray(parsed.pending) ? parsed.pending : [] };
	} catch {
		return { lastBatchAt: 0, pending: [] };
	}
}

function writeWakeState(stateDir: string, state: WakeState): void {
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const target = join(stateDir, WAKE_STATE_FILE);
	const tmp = `${target}.tmp-${process.pid}`;
	const fd = openSync(tmp, "w", 0o600);
	try {
		writeFileSync(fd, JSON.stringify(state));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, target);
}

/** One issue for everything queued: a single entry reads like an immediate wake, several become a digest. */
async function wakeDigest(queued: QueuedWake[], deps: GatedWakeDeps): Promise<void> {
	if (queued.length === 1) {
		const only = queued[0]!;
		await wakeGrokbot({ messageId: only.id, from: only.from, firstLine: only.line, attachmentCount: 0 }, deps);
		return;
	}
	const senders = [...new Set(queued.map((entry) => entry.from))].sort().join("/");
	const lines = queued.slice(0, DIGEST_LINES).map((entry) => `- ${entry.from} ${entry.id}: ${entry.line}`);
	const more = queued.length > DIGEST_LINES ? [`- and ${queued.length - DIGEST_LINES} more`] : [];
	await ghIssueCreate([
		"--repo", deps.repo ?? DEFAULT_MAILBOX_REPO,
		"--assignee", deps.assignee ?? DEFAULT_MAILBOX_ASSIGNEE,
		"--title", `${senders}: ${queued.length} messages`,
		"--body", [...lines, ...more, "", "Read them with outbox_read (batched hourly)."].join("\n"),
	], deps);
}

/**
 * The wake for one message written to Henry's inbox. A scheduled sender's message is queued in
 * `henry-wake.json` first, and the issue opens only when the last batched issue is an hour old (or
 * there was none); a failed issue leaves the queue as it was, so the next call retries. Any other
 * sender wakes at once. The message itself is already in the inbox, so a queued wake loses nothing.
 */
export async function wakeGrokbotGated(info: WakeInfo, deps: GatedWakeDeps): Promise<void> {
	if (!BATCHED_WAKE_SENDERS.includes(info.from)) return wakeGrokbot(info, deps);
	const state = readWakeState(deps.stateDir);
	// A repeated send under one retry key answers with the first id; it is queued once.
	const pending = state.pending.some((entry) => entry.id === info.messageId) ? state.pending : [...state.pending, { id: info.messageId, from: info.from, line: wakeLine(info.firstLine) }];
	writeWakeState(deps.stateDir, { ...state, pending });
	if (deps.now() - state.lastBatchAt < BATCH_WAKE_INTERVAL_MS) return;
	await wakeDigest(pending, deps);
	writeWakeState(deps.stateDir, { lastBatchAt: deps.now(), pending: [] });
}

/**
 * Opens the issue for messages that were queued and are now an hour old, when no later message
 * arrived to carry them. The tick calls it every run; with nothing queued it touches nothing.
 */
export async function flushGrokbotWake(deps: GatedWakeDeps): Promise<boolean> {
	const state = readWakeState(deps.stateDir);
	if (state.pending.length === 0 || deps.now() - state.lastBatchAt < BATCH_WAKE_INTERVAL_MS) return false;
	await wakeDigest(state.pending, deps);
	writeWakeState(deps.stateDir, { lastBatchAt: deps.now(), pending: [] });
	return true;
}
