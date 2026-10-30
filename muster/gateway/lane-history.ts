/**
 * `lane_history` (HO10 of the observability blueprint, the operator 2026-10-17 22:59):
 * per lane, the brief it was given, the harness and model that ran it, when it
 * started and ended with the duration, its final report, the commit that merged
 * it and the guarded runs the HO5 ledger records for its branch.
 *
 * One reader over the existing owners, no second lane store:
 *   - the live rows from the lane directory (`deps.lanes()`) and the lane records
 *     (`listLaneRecords`, lane-lifecycle.ts);
 *   - the archived rows a closed lane leaves behind: a card under
 *     `<stateDir>/lanes-archive*` and a record under
 *     `<stateDir>/lifecycle-archive/<YYYY-MM>/` (`archiveLaneRecord`);
 *   - the report mark through the card/record field (`lib/lane-card.ts`), the
 *     newest of the two taken with `newerLaneReport`;
 *   - the brief folder from `handoffsMsgsDir` (lane-lifecycle-ports.ts);
 *   - the run ledger from `readTestRuns` (test-results.ts, HO5);
 *   - the repositories from the project register (`registerRepos`, oversight.ts).
 *
 * Data that is missing prints `unknown`, never a guess. Read-only.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

import { isLaneReportMark, newerLaneReport, type LaneCard, type LaneHarness, type LaneReportMark } from "../lib/lane-card.ts";
import { listLaneRecords, type LanePhase, type LaneRecord } from "../lane-lifecycle.ts";
import { handoffsMsgsDir } from "../lane-lifecycle-ports.ts";
import type { ProjectCatalogue, ProjectRegistration } from "../projects.ts";
import { execGit, type GitExec } from "./knowledge.ts";
import { laneBriefNamePattern, OversightError, registerRepos, sinceToMs } from "./oversight.ts";
import { readTestRuns, TEST_RESULTS_LIMIT_MAX, type TestRun } from "./test-results.ts";

/** Lanes shown when the caller names no limit. */
export const LANE_HISTORY_LIMIT_DEFAULT = 10;
/** Most lanes one answer lists. */
export const LANE_HISTORY_LIMIT_MAX = 50;
/** Characters of one answer before the cut. */
const LANE_HISTORY_MAX_CHARS = 60_000;
/** Archived lane files read in one call, so a long archive cannot blow the answer up. */
const ARCHIVE_FILES_MAX = 400;
/** Lane ids named in an "unknown lane" refusal. */
const LANES_NAMED = 12;
/** Runs shown per lane before the count only. */
const TESTS_SHOWN = 5;
/** Merge commits read per branch when looking for the one that names the lane. */
const MERGE_CANDIDATES = 200;
/** Characters of one report summary kept. */
const SUMMARY_CHARS = 300;

/**
 * What `lane_history` reads. Every field is one the oversight deps already carry,
 * so the gateway passes its `OversightToolDeps` unchanged.
 */
export type LaneHistoryDeps = {
	/** Muster state dir: lane cards, lane records and both archives live under it. */
	stateDir: string;
	/** The lane directory, as `muster lanes` reads it. */
	lanes: () => LaneCard[];
	/** The project register (`projects.ts`); undefined or throwing means no repository is known. */
	register?: () => ProjectCatalogue | undefined;
	/** One git call; production `execGit` (a fixed argv, no shell), tests a stub. */
	git?: GitExec;
	/** The folder the briefs live in (`handoffsMsgsDir`); production reads it, tests a fixture. */
	laneBriefsDir?: () => string;
	now?: () => Date;
};

export type LaneHistoryFilter = {
	/** One lane id; an id nothing knows is refused. */
	lane?: string;
	/** A date, an ISO time or "N units ago": lanes that started before it are left out. */
	since?: string;
	limit?: number;
};

/** The merge commit that names the lane's branch. */
export type LaneMerge = {
	sha: string;
	subject: string;
	branch: string;
	/** The merge commit's committer time (ISO, `%cI`): "Shipped today" selects on it. Absent when the git answer carried none. */
	at?: string;
};

/** One lane's history, as the tool answers it. `null` is "no source says", never "nothing happened". */
export type LaneHistoryEntry = {
	lane: string;
	harness: LaneHarness | "unknown";
	model: string | null;
	/** D32: what the lane delivers, from its record (D27); null on a record written before titles. */
	title: string | null;
	/** Epoch ms the lane was launched (the record's `launchedAt`), else the card's `since`. */
	startedAt: number | null;
	/** Epoch ms the lane ended; null while no terminal fact and no report says it did. */
	endedAt: number | null;
	durationMs: number | null;
	branch: string | null;
	/** The lane's own last report, as its card or record carries it. */
	outcome: { kind: string; summary: string; at: number | null } | null;
	/** The brief file in the handoffs msgs folder, when one names this lane. */
	brief: string | null;
	merge: LaneMerge | null;
	/** The guarded runs of the lane's branch (`lane/<lane>`, or its own `lane/*` branch); `scanned` is how many ledger rows the reader walked. */
	tests: { runs: TestRun[]; scanned: number };
	/** The lane row's own state, when a card says it. */
	state: string | null;
};

// ─── The facts one lane is built from ───────────────────────────────────────

/**
 * What the sources say about one lane. Every source (an archived row, the live
 * record, the live directory row) fills what it has; a later source wins where it
 * has a value, so the live facts never lose to the archive.
 */
type LaneFacts = {
	laneId: string;
	harness?: LaneHarness;
	model?: string | null;
	cwd?: string | null;
	branch?: string | null;
	repoRoot?: string;
	state?: string | null;
	since?: number | null;
	updatedAt?: number | null;
	launchedAt?: number;
	phase?: LanePhase;
	/** D27: the lane's plain title, from its record (live or archived). */
	title?: string;
	lastReport?: LaneReportMark;
	terminal?: { outcome: string; reason: string; sha: string | null; at: number; closedAt?: number };
};

/** The phases that mean the lane is finished. */
const TERMINAL_PHASES: readonly LanePhase[] = ["merged", "abandoned", "closed"];
const LANE_PHASES: readonly LanePhase[] = ["working", "review_ready", "blocked", "question", "parked", "merged", "abandoned", "closed"];
const LANE_HARNESSES: readonly LaneHarness[] = ["pi", "claude", "opencode", "hermes", "unknown"];

/** The source's own values, without the `undefined`s a spread would let overwrite. */
function definedFacts(source: LaneFacts): Partial<LaneFacts> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(source)) {
		if (key !== "laneId" && value !== undefined) out[key] = value;
	}
	return out as Partial<LaneFacts>;
}

/** The two report marks are the same concept in two files: the newest one is the lane's. */
function mergeFacts(base: LaneFacts, source: LaneFacts): LaneFacts {
	const merged = { ...base, ...definedFacts(source), laneId: base.laneId } as LaneFacts;
	merged.lastReport = newerLaneReport(base.lastReport, source.lastReport);
	return merged;
}

function numberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null | undefined {
	return typeof value === "string" || value === null ? (value as string | null) : undefined;
}

function terminalOf(value: unknown): LaneFacts["terminal"] {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const row = value as Record<string, unknown>;
	const at = numberOrNull(row["at"]);
	if (typeof row["outcome"] !== "string" || at === null) return undefined;
	const closedAt = numberOrNull(row["closedAt"]);
	return {
		outcome: row["outcome"],
		reason: typeof row["reason"] === "string" ? row["reason"] : "",
		sha: typeof row["sha"] === "string" ? row["sha"] : null,
		at,
		...(closedAt !== null ? { closedAt } : {}),
	};
}

/**
 * One archived lane file, read for the fields the tool shows.
 *
 * The archives are the same two shapes the live store writes — a card under
 * `lanes-archive*` and a record under `lifecycle-archive/<YYYY-MM>/` — so one
 * reader serves both, and a file that is neither is skipped like a torn one.
 */
function parseArchivedLane(text: string): LaneFacts | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const row = value as Record<string, unknown>;
	const laneId = row["laneId"];
	if (typeof laneId !== "string" || laneId === "") return undefined;
	const facts: LaneFacts = { laneId };
	if (typeof row["harness"] === "string" && (LANE_HARNESSES as readonly string[]).includes(row["harness"])) facts.harness = row["harness"] as LaneHarness;
	const model = stringOrNull(row["model"]);
	if (model !== undefined) facts.model = model;
	const cwd = stringOrNull(row["cwd"]);
	if (cwd !== undefined) facts.cwd = cwd;
	const branch = stringOrNull(row["branch"]);
	if (branch !== undefined) facts.branch = branch;
	if (typeof row["repoRoot"] === "string") facts.repoRoot = row["repoRoot"];
	if (typeof row["state"] === "string") facts.state = row["state"];
	const since = numberOrNull(row["since"]);
	if (since !== null) facts.since = since;
	const updatedAt = numberOrNull(row["updatedAt"]);
	if (updatedAt !== null) facts.updatedAt = updatedAt;
	const launchedAt = numberOrNull(row["launchedAt"]);
	if (launchedAt !== null) facts.launchedAt = launchedAt;
	if (typeof row["phase"] === "string" && (LANE_PHASES as readonly string[]).includes(row["phase"])) facts.phase = row["phase"] as LanePhase;
	if (typeof row["title"] === "string" && row["title"].trim() !== "") facts.title = row["title"];
	if (isLaneReportMark(row["lastReport"])) facts.lastReport = row["lastReport"];
	const terminal = terminalOf(row["terminal"]);
	if (terminal !== undefined) facts.terminal = terminal;
	return facts;
}

/** The archived lane files: a card under `lanes-archive*`, a record under `lifecycle-archive/<month>/`. */
function archivedLaneFiles(stateDir: string): string[] {
	const files: string[] = [];
	const jsonFiles = (dir: string): void => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const path = join(dir, name);
			try {
				if (statSync(path).isFile()) files.push(path);
			} catch {
				// A race or a broken link: skipped, like an unreadable card.
			}
		}
	};
	const oneLevelDown = (root: string): void => {
		let names: string[];
		try {
			names = readdirSync(root);
		} catch {
			return;
		}
		for (const name of names) {
			const path = join(root, name);
			try {
				if (statSync(path).isDirectory()) jsonFiles(path);
				else if (name.endsWith(".json")) files.push(path);
			} catch {
				// Skipped for the same reason.
			}
		}
	};
	let top: string[];
	try {
		top = readdirSync(stateDir);
	} catch {
		return [];
	}
	for (const name of top) {
		if (name.startsWith("lanes-archive")) oneLevelDown(join(stateDir, name));
		else if (name === "lifecycle-archive") oneLevelDown(join(stateDir, name));
	}
	return files.slice(0, ARCHIVE_FILES_MAX);
}

function archivedFacts(stateDir: string): LaneFacts[] {
	const rows: LaneFacts[] = [];
	for (const file of archivedLaneFiles(stateDir)) {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const facts = parseArchivedLane(text);
		if (facts !== undefined) rows.push(facts);
	}
	return rows;
}

/** The live records, or none when the store cannot be read (a stale leftover is not an error here). */
function liveRecordFacts(stateDir: string): LaneFacts[] {
	let records: LaneRecord[];
	try {
		records = listLaneRecords(stateDir);
	} catch {
		return [];
	}
	return records.map((record) => ({
		laneId: record.laneId,
		harness: record.harness,
		cwd: record.cwd,
		branch: record.branch,
		...(record.repoRoot !== undefined ? { repoRoot: record.repoRoot } : {}),
		launchedAt: record.launchedAt,
		phase: record.phase,
		...(record.title !== undefined ? { title: record.title } : {}),
		...(record.lastReport !== undefined ? { lastReport: record.lastReport } : {}),
		...(record.terminal !== undefined ? { terminal: record.terminal } : {}),
	}));
}

/** The live directory rows, or none when reading them fails. */
function liveRowFacts(deps: LaneHistoryDeps): LaneFacts[] {
	let rows: LaneCard[];
	try {
		rows = deps.lanes();
	} catch {
		return [];
	}
	return rows.map((row) => ({
		laneId: row.laneId,
		harness: row.harness,
		model: row.model,
		cwd: row.cwd,
		branch: row.branch,
		state: row.state,
		since: row.since,
		updatedAt: row.updatedAt,
		...(row.phase !== undefined ? { phase: row.phase } : {}),
		...(row.lastReport !== undefined ? { lastReport: row.lastReport } : {}),
	}));
}

/**
 * The branch whose merge and runs are the lane's own: the `lane/*` branch its record
 * or card carries (`pi-ho7` works `lane/ho7`), else `lane/<lane id>`. Never a guess
 * at a branch the lane did not use: a card with no `lane/*` branch falls back to its id.
 */
function laneBranchOf(facts: LaneFacts): string {
	const branch = facts.branch;
	return branch !== null && branch !== undefined && /^lane\/[A-Za-z0-9._-]+$/.test(branch) ? branch : `lane/${facts.laneId}`;
}

// ─── The brief, the merge commit and the runs ───────────────────────────────

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The lane's brief file in the handoffs msgs folder: `lane-prompt-*-<lane>-*.md`,
 * the same naming convention `readLaneBriefs` (oversight.ts) reads the texts of.
 * The newest match wins; none is `null`, never an invented path.
 */
function briefPath(deps: LaneHistoryDeps, laneId: string): string | null {
	let dir: string;
	try {
		dir = (deps.laneBriefsDir ?? (() => handoffsMsgsDir()))();
	} catch {
		return null;
	}
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return null;
	}
	const name = laneBriefNamePattern(laneId);
	const matches = names.filter((entry) => name.test(entry)).sort();
	return matches.length === 0 ? null : join(dir, matches[matches.length - 1]!);
}

/** A lane's repository and the branches the merge commit may be on, integration branch first. */
type LaneRepo = { dir: string; branches: string[] };

/** Whether `path` is `dir` itself or sits under it, on a path boundary. */
function inside(path: string, dir: string): boolean {
	return path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
}

/**
 * The branch a merge into this repository would land on: the register's
 * `settings.integration.branch` when the project sets one, else the repository's
 * default branch. `origin/HEAD` is the standard answer and is unset in the
 * register's own checkouts, so the named branches follow it; `dev` is last
 * because crm-app, the one project that merges lanes onto `dev`, has no
 * other default. Nothing resolves to `undefined`, never to a guessed name.
 */
async function defaultBranch(git: GitExec, dir: string): Promise<string | undefined> {
	try {
		const name = (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dir)).trim().replace(/^origin\//, "");
		if (name !== "") return name;
	} catch {
		// No origin HEAD: the named branches below decide.
	}
	for (const name of ["main", "master", "dev"]) {
		try {
			await git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], dir);
			return name;
		} catch {
			// The next candidate.
		}
	}
	return undefined;
}

/**
 * The repository a lane belongs to: the register checkout that holds its
 * directory, else the lane's own directory when git resolves a branch there (a
 * worktree of the same repository sees the same merge commits).
 */
async function resolveRepo(deps: LaneHistoryDeps, git: GitExec, candidates: string[]): Promise<LaneRepo | undefined> {
	const projects = deps.register?.()?.projects ?? [];
	const repos = registerRepos(deps);
	for (const candidate of candidates) {
		if (candidate === "") continue;
		const match = repos.filter((entry) => inside(candidate, entry.dir)).sort((a, b) => b.dir.length - a.dir.length)[0];
		if (match !== undefined) {
			const project: ProjectRegistration | undefined = projects.find((entry) => entry.name === match.project);
			const branches: string[] = [];
			const integration = project?.settings?.integration?.branch;
			if (integration !== undefined && integration !== "") branches.push(integration);
			const fallback = await defaultBranch(git, match.dir);
			if (fallback !== undefined && !branches.includes(fallback)) branches.push(fallback);
			if (branches.length > 0) return { dir: match.dir, branches };
			continue;
		}
		const fallback = await defaultBranch(git, candidate);
		if (fallback !== undefined) return { dir: candidate, branches: [fallback] };
	}
	return undefined;
}

/**
 * The merge commit whose subject names the lane's branch, on the first branch that has one.
 * `--grep` narrows the walk and the subject is matched exactly here, because a branch name
 * is a prefix of another (`lane/ho1` would otherwise read `lane/ho10`). The local branch is
 * searched first, then its remote-tracking ref, because a register checkout can be behind
 * and the merge is then only on `origin/<branch>`.
 */
async function mergeCommit(git: GitExec, repo: LaneRepo, laneBranch: string): Promise<LaneMerge | undefined> {
	const name = new RegExp(`(?:^|[\\s'\"(])${escapeRegExp(laneBranch)}(?![A-Za-z0-9._-])`);
	for (const branch of repo.branches) {
		for (const ref of [branch, `origin/${branch}`]) {
			let out: string;
			try {
				out = await git(["log", "--merges", `--grep=${laneBranch}`, "--format=%H%x09%cI%x09%s", `--max-count=${MERGE_CANDIDATES}`, ref], repo.dir);
			} catch {
				continue;
			}
			for (const line of out.split("\n")) {
				const [sha, ...rest] = line.split("\t");
				// The committer time is the second field when it is an ISO time; a line with none reads as before.
				const committed = rest.length >= 2 && Number.isFinite(Date.parse(rest[0]!)) ? rest.shift()! : undefined;
				const subject = rest.join("\t").trim();
				if (sha === undefined || !/^[0-9a-f]{7,40}$/.test(sha) || subject === "") continue;
				if (name.test(subject)) return { sha, subject, branch, ...(committed !== undefined ? { at: committed } : {}) };
			}
		}
	}
	return undefined;
}

// ─── The reader ─────────────────────────────────────────────────────────────

function parseSince(text: string, nowMs: number): number {
	const ms = sinceToMs(text, nowMs);
	if (ms === undefined) throw new OversightError(`since ${JSON.stringify(text)} is not a date, an ISO time or "N units ago"`);
	return ms;
}

function startedOf(facts: LaneFacts): number | null {
	return facts.launchedAt ?? facts.since ?? null;
}

/** When the lane ended: its record's terminal time, else the report of a finished phase, else the farewell card. */
function endedOf(facts: LaneFacts): number | null {
	if (facts.terminal !== undefined) return facts.terminal.closedAt ?? facts.terminal.at;
	if (facts.phase !== undefined && TERMINAL_PHASES.includes(facts.phase)) return facts.lastReport?.at ?? facts.updatedAt ?? null;
	if (facts.state === "gone") return facts.updatedAt ?? null;
	return null;
}

/**
 * Every lane with history, newest start first. An unknown `lane` is refused with
 * the ids that have history; `since` and `limit` are the answer's own bounds.
 */
export async function laneHistoryEntries(deps: LaneHistoryDeps, filter: LaneHistoryFilter = {}): Promise<LaneHistoryEntry[]> {
	const nowMs = (deps.now?.() ?? new Date()).getTime();
	const facts = new Map<string, LaneFacts>();
	const apply = (source: LaneFacts): void => {
		const current = facts.get(source.laneId);
		facts.set(source.laneId, current === undefined ? source : mergeFacts(current, source));
	};
	// Archived rows first, then the live record, then the live row: a later source
	// wins where it has a value, so a lane's live facts never lose to its archive.
	for (const source of archivedFacts(deps.stateDir)) apply(source);
	for (const source of liveRecordFacts(deps.stateDir)) apply(source);
	for (const source of liveRowFacts(deps)) apply(source);

	if (filter.lane !== undefined && !facts.has(filter.lane)) {
		const known = [...facts.keys()].sort().slice(0, LANES_NAMED);
		throw new OversightError(`unknown lane ${JSON.stringify(filter.lane)}: no lane, record or archive names it${known.length === 0 ? "" : `; the lanes with history are ${known.join(", ")}`}`);
	}
	const sinceMs = filter.since === undefined ? undefined : parseSince(filter.since, nowMs);
	const limit = Math.min(Math.max(filter.limit ?? LANE_HISTORY_LIMIT_DEFAULT, 1), LANE_HISTORY_LIMIT_MAX);
	const selected = [...facts.values()]
		.filter((entry) => filter.lane === undefined || entry.laneId === filter.lane)
		.filter((entry) => sinceMs === undefined || ((startedOf(entry) ?? 0) >= sinceMs))
		.sort((a, b) => (startedOf(b) ?? 0) - (startedOf(a) ?? 0) || a.laneId.localeCompare(b.laneId))
		.slice(0, limit);

	const git = deps.git ?? execGit;
	const repoCache = new Map<string, Promise<LaneRepo | undefined>>();
	const repoFor = (candidates: string[]): Promise<LaneRepo | undefined> => {
		const key = candidates.join("\u0000");
		const cached = repoCache.get(key);
		if (cached !== undefined) return cached;
		const pending = resolveRepo(deps, git, candidates);
		repoCache.set(key, pending);
		return pending;
	};
	return Promise.all(
		selected.map(async (entry) => {
			const laneBranch = laneBranchOf(entry);
			const candidates = [...new Set([entry.cwd ?? "", entry.repoRoot ?? ""].filter((candidate) => candidate !== ""))];
			const repo = candidates.length === 0 ? undefined : await repoFor(candidates);
			const merge = repo === undefined ? undefined : await mergeCommit(git, repo, laneBranch);
			const ledger = readTestRuns({ branch: laneBranch, limit: TEST_RESULTS_LIMIT_MAX });
			const startedAt = startedOf(entry);
			const endedAt = endedOf(entry);
			return {
				lane: entry.laneId,
				harness: entry.harness ?? "unknown",
				model: entry.model ?? null,
				title: entry.title ?? null,
				startedAt,
				endedAt,
				durationMs: startedAt !== null && endedAt !== null ? Math.max(0, endedAt - startedAt) : null,
				branch: entry.branch ?? null,
				outcome: entry.lastReport === undefined ? null : { kind: entry.lastReport.kind, summary: entry.lastReport.summary, at: entry.lastReport.at ?? null },
				brief: briefPath(deps, entry.laneId),
				merge: merge ?? null,
				tests: { runs: ledger.runs, scanned: ledger.scanned },
				state: entry.state ?? null,
			} satisfies LaneHistoryEntry;
		}),
	);
}

// ─── The answer ─────────────────────────────────────────────────────────────

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 90) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 120) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** One run as a short line: what ran and how it ended. */
function runLine(run: TestRun): string {
	const failing = run.failing?.length ?? 0;
	return `${run.kind} ${run.exit === 0 ? "pass" : `exit ${run.exit}${failing > 0 ? ` (${failing} failing)` : ""}`} ${run.at}`;
}

function testsText(entry: LaneHistoryEntry): string {
	const { runs, scanned } = entry.tests;
	if (runs.length === 0) return `none in the ledger's newest ${scanned} row(s)`;
	const shown = runs.slice(0, TESTS_SHOWN);
	const more = runs.length > shown.length ? `, +${runs.length - shown.length} more` : "";
	return `${runs.length} run(s) of ${scanned} ledger row(s): ${shown.map(runLine).join(", ")}${more}`;
}

function endText(entry: LaneHistoryEntry): string {
	if (entry.endedAt !== null) return iso(entry.endedAt);
	return entry.state === null ? "unknown" : `running (${entry.state})`;
}

function renderEntry(entry: LaneHistoryEntry): string[] {
	return [
		`lane ${entry.lane} — ${entry.harness}, ${entry.model ?? "unknown"}`,
		`  brief: ${entry.brief ?? "unknown"}`,
		`  start: ${entry.startedAt === null ? "unknown" : iso(entry.startedAt)}  end: ${endText(entry)}  duration: ${entry.durationMs === null ? "unknown" : formatDuration(entry.durationMs)}`,
		`  branch: ${entry.branch ?? "unknown"}`,
		`  outcome: ${entry.outcome === null ? "unknown" : `${entry.outcome.kind}: ${clip(entry.outcome.summary, SUMMARY_CHARS)}`}`,
		`  merged: ${entry.merge === null ? "unknown" : `${entry.merge.sha.slice(0, 7)} ${clip(entry.merge.subject, 160)} (on ${entry.merge.branch})`}`,
		`  tests: ${testsText(entry)}`,
	];
}

/**
 * `lane_history`: one plain-text block per lane, newest start first, at most
 * `limit` of them. Read-only; a lane nothing knows prints `unknown` per field.
 */
export async function laneHistory(deps: LaneHistoryDeps, filter: LaneHistoryFilter = {}): Promise<string> {
	const entries = await laneHistoryEntries(deps, filter);
	const scoped = filter.lane === undefined ? "" : `, lane ${filter.lane}`;
	const since = filter.since === undefined ? "" : `, since ${filter.since}`;
	if (entries.length === 0) return `lane history: no lane matches${scoped}${since}; nothing has history for it`;
	const lines = [`lane history: ${entries.length} lane(s)${scoped}${since}, newest start first`];
	for (const entry of entries) lines.push("", ...renderEntry(entry));
	const text = lines.join("\n");
	return text.length > LANE_HISTORY_MAX_CHARS ? `${text.slice(0, LANE_HISTORY_MAX_CHARS)}\n…[cut at ${LANE_HISTORY_MAX_CHARS} characters]` : text;
}
