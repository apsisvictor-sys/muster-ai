/**
 * HO5 `test_results` and the run-ledger reader (blueprint `henry-observability-blueprint-2026-10-17.md`,
 * section HO5). The ledger itself is written by `scripts/test-ledger-append.mjs`, the one writer every
 * guarded entry point calls; this module is the one READER, so `test_results` and `repo_status`'s last-test
 * line (HO4) both read the same rows through the same parser.
 *
 * The ledger is `~/.pi/agent/state/tests/runs.jsonl` (one JSON row per run, mode 600). Reading is bounded:
 * only the end of the file is read, a torn or malformed line is skipped and counted, and a failing run's log
 * tail is read through `readLogTail` (the gateway's existing redacting tail reader). A log that `/tmp`
 * cleaned up reads `log gone`, never a guess.
 */

import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { basename, join } from "node:path";
import { piAgentDir } from "../../core/pi-ports.ts";
import { readLogTail } from "./logs.ts";

export const TEST_RUN_KINDS = ["unit", "typecheck", "e2e", "qa", "guards"] as const;
/** Rows one `test_results` answer shows by default, and the most it will show. */
export const TEST_RESULTS_LIMIT_DEFAULT = 10;
export const TEST_RESULTS_LIMIT_MAX = 50;
/** Lines of a failing run's log that travel with the answer (HO5). */
export const TEST_TAIL_LINES = 60;
/** Characters of the whole `test_results` answer. */
const TEST_RESULTS_MAX_CHARS = 60_000;
/** At most this much of the ledger is read, from its end. */
const LEDGER_READ_BYTES = 512 * 1024;
/** Project names named in a "nothing matched" answer. */
const PROJECTS_NAMED = 12;

/** One ledger row, as `scripts/test-ledger-append.mjs` writes it. */
export type TestRun = {
	at: string;
	/** The repository the run belongs to (a worktree run counts for its repository). */
	project: string;
	cwd: string;
	branch: string | null;
	sha: string | null;
	kind: string;
	command: string;
	exit: number;
	durationMs: number | null;
	log: string;
	failing: string[] | null;
};

export type TestRunFilter = {
	project?: string;
	kind?: string;
	/** One branch exactly (`lane/ho10`): HO10 asks the ledger for what one lane's branch ran. */
	branch?: string;
	limit?: number;
};

export type TestRunRead = {
	/** Matching rows, newest first, at most `limit`. */
	runs: TestRun[];
	/** Rows scanned in the ledger's tail. */
	scanned: number;
	/** Lines in that tail that are not a valid row (a torn write, a hand-edit). */
	skipped: number;
	/** Project names seen while scanning, for a "nothing matched" answer. */
	projects: string[];
	/** The ledger path that was read, when it could be resolved. */
	path?: string;
	/** Why the ledger could not be read at all. */
	unreadable?: string;
};

/** The one ledger path: the `PI_TEST_LEDGER` test seam, else the agent folder's own state. */
export function ledgerPath(): string | undefined {
	const override = (process.env.PI_TEST_LEDGER ?? "").trim();
	if (override !== "") return override;
	try {
		return join(piAgentDir(), "state", "tests", "runs.jsonl");
	} catch {
		// No agentDir port configured: nothing to read, and no guess about where it would be.
		return undefined;
	}
}

function parseRow(line: string): TestRun | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const row = value as Record<string, unknown>;
	if (typeof row["at"] !== "string" || typeof row["project"] !== "string" || typeof row["exit"] !== "number" || typeof row["kind"] !== "string") return undefined;
	return {
		at: row["at"],
		project: row["project"],
		cwd: typeof row["cwd"] === "string" ? row["cwd"] : "",
		branch: typeof row["branch"] === "string" ? row["branch"] : null,
		sha: typeof row["sha"] === "string" ? row["sha"] : null,
		kind: row["kind"],
		command: typeof row["command"] === "string" ? row["command"] : "",
		exit: row["exit"],
		durationMs: typeof row["durationMs"] === "number" ? row["durationMs"] : null,
		log: typeof row["log"] === "string" ? row["log"] : "",
		failing: Array.isArray(row["failing"]) ? row["failing"].filter((name): name is string => typeof name === "string") : null,
	};
}

/** The matching ledger rows, newest first. Never throws: an unreadable ledger is reported as such. */
export function readTestRuns(filter: TestRunFilter = {}): TestRunRead {
	const path = ledgerPath();
	if (path === undefined) return { runs: [], scanned: 0, skipped: 0, projects: [] };
	if (!existsSync(path)) return { runs: [], scanned: 0, skipped: 0, projects: [], path };
	let text: string;
	let truncated: boolean;
	try {
		const fd = openSync(path, "r");
		try {
			const size = fstatSync(fd).size;
			const length = Math.min(size, LEDGER_READ_BYTES);
			const buffer = Buffer.alloc(length);
			readSync(fd, buffer, 0, length, size - length);
			text = buffer.toString("utf8");
			truncated = size > length;
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		return { runs: [], scanned: 0, skipped: 0, projects: [], path, unreadable: error instanceof Error ? error.message : String(error) };
	}
	const lines = text.split("\n");
	// The first line of a cut read is partial, not a malformed row.
	if (truncated) lines.shift();
	const limit = Math.min(Math.max(filter.limit ?? TEST_RESULTS_LIMIT_DEFAULT, 1), TEST_RESULTS_LIMIT_MAX);
	const runs: TestRun[] = [];
	const projects = new Set<string>();
	let scanned = 0;
	let skipped = 0;
	// Newest last on disk, so walk backwards and stop once the page is full.
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index]!.trim();
		if (line === "") continue;
		const row = parseRow(line);
		if (row === undefined) {
			skipped++;
			continue;
		}
		scanned++;
		projects.add(row.project);
		if (filter.project !== undefined && row.project !== filter.project) continue;
		if (filter.kind !== undefined && row.kind !== filter.kind) continue;
		if (filter.branch !== undefined && row.branch !== filter.branch) continue;
		if (runs.length < limit) runs.push(row);
	}
	return { runs, scanned, skipped, projects: [...projects].sort(), path };
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}\n…[cut at ${max} characters]` : text;
}

function runLine(run: TestRun): string {
	const duration = run.durationMs === null ? "duration unknown" : `${Math.round(run.durationMs / 1000)}s`;
	const where = `${run.branch ?? "no branch"}@${run.sha === null ? "unknown" : run.sha.slice(0, 7)}`;
	return `${run.at}  ${run.project}  ${run.kind}  exit=${run.exit}  ${duration}  ${where}  ${run.log === "" ? "no log path" : run.log}`;
}

/** The failing names and, when the run failed, the redacted tail of its log. */
function failureDetail(run: TestRun): string[] {
	const lines: string[] = [];
	if (run.failing !== null && run.failing.length > 0) lines.push(`  failing: ${run.failing.join(", ")}`);
	if (run.exit === 0) return lines;
	if (run.log === "") {
		lines.push("  log gone (the row carries no log path)");
		return lines;
	}
	if (!existsSync(run.log)) {
		lines.push(`  log gone (${run.log} is no longer there)`);
		return lines;
	}
	let tail: string;
	try {
		tail = readLogTail(run.log, TEST_TAIL_LINES, "test log");
	} catch (error) {
		lines.push(`  log unreadable (${error instanceof Error ? error.message : String(error)})`);
		return lines;
	}
	lines.push(`  log, last ${TEST_TAIL_LINES} lines:`);
	for (const line of tail.split("\n")) lines.push(`    ${line}`);
	return lines;
}

/**
 * `test_results` (HO5): the run ledger, newest first. `project` and `kind` filter it, `limit` caps it
 * (default 10, at most 50). A failing run carries its failing test names and the redacted last 60 lines
 * of its log. Read-only.
 */
export function testResults(filter: TestRunFilter = {}): string {
	const read = readTestRuns(filter);
	if (read.unreadable !== undefined) return `the run ledger is unreadable (${read.unreadable})`;
	if (read.path === undefined) return "the run ledger path cannot be resolved (no agent folder is configured)";
	const filterText = [filter.project === undefined ? "" : `project ${filter.project}`, filter.kind === undefined ? "" : `kind ${filter.kind}`].filter((part) => part !== "").join(", ");
	if (read.scanned === 0) {
		return `no test runs recorded yet in ${read.path}${read.skipped > 0 ? ` (${read.skipped} unreadable lines)` : ""}`;
	}
	if (read.runs.length === 0) {
		return `no test run matches ${filterText === "" ? "the filter" : filterText}; recorded projects: ${read.projects.slice(0, PROJECTS_NAMED).join(", ")}${read.projects.length > PROJECTS_NAMED ? `, +${read.projects.length - PROJECTS_NAMED} more` : ""}`;
	}
	const head = `test runs (newest first): ${read.runs.length} of ${read.scanned} recorded${filterText === "" ? "" : `, ${filterText}`}${read.skipped > 0 ? `, ${read.skipped} unreadable lines` : ""}`;
	const body: string[] = [head];
	for (const run of read.runs) {
		body.push(runLine(run), ...failureDetail(run));
	}
	body.push(`ledger: ${read.path}`);
	return clip(body.join("\n"), TEST_RESULTS_MAX_CHARS);
}

/**
 * HO4's last-test line for one repository's checkout: the newest ledger row of that repository as one short
 * line, or undefined when none was recorded. The repository name comes from the checkout's own folder, which
 * is what the ledger writer recorded (a worktree run counts for the repository it was cut from).
 */
export function lastTestRunLine(dir: string): string | undefined {
	const run = readTestRuns({ project: basename(dir), limit: 1 }).runs[0];
	if (run === undefined) return undefined;
	const failing = run.failing?.length ?? 0;
	const outcome = run.exit === 0 ? "pass" : `exit ${run.exit}${failing > 0 ? ` (${failing} failing)` : ""}`;
	return `${run.kind} ${outcome} ${run.branch ?? "no branch"}@${run.sha === null ? "unknown" : run.sha.slice(0, 7)} ${run.at}`;
}
