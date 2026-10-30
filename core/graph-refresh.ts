// Code-graph refresh (lifecycle blueprint WP11, LD12): the TypeScript side of scripts/graph-refresh.sh.
//
// The script owns the graph's state and its staleness rule (`--status`). This module only calls it, so the
// tick, the janitor and Henry's graph tools read one answer and keep no second copy of the rule.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { LabUnitRefusal, labUnitOperand } from "./lab-units.ts";
import { piAgentDir } from "./pi-ports.ts";

/** S10: `<agentDir>/scripts` (the old `SCRIPTS_DIR`), read through the port when called, never at module load. */
function scriptsDir(): string {
	return join(piAgentDir(), "scripts");
}

/** The refresh script under the configured agent folder (S10). */
export function graphRefreshScript(): string {
	return join(scriptsDir(), "graph-refresh.sh");
}

/** The nudge script under the configured agent folder (S10). */
export function graphNudgeScript(): string {
	return join(scriptsDir(), "graph-nudge.sh");
}

export interface GraphStatus {
	/** The repository's main checkout, where graphify-out/ lives. */
	repo: string;
	graph: string;
	report: string;
	exists: boolean;
	/** Epoch ms of the last refresh (the graph file's mtime when the script never refreshed it). */
	refreshedAt?: number;
	/** HEAD of the main checkout when the graph was last refreshed. */
	sha?: string;
	/** Commits on the main checkout's HEAD since `sha`: how far the graph lags, when the script can count them. */
	commitsSince?: number;
	/** A local origin/dev or origin/main has moved since that refresh. */
	stale: boolean;
	/** A refresh is running now. */
	running: boolean;
	/** Stale, not running and not in the failure back-off, or no graph at all. */
	due: boolean;
}

/** Parse `graph-refresh.sh --status` output. */
export function parseGraphStatus(output: string): GraphStatus | undefined {
	const fields = new Map<string, string>();
	for (const line of output.split("\n")) {
		const at = line.indexOf("=");
		if (at > 0) fields.set(line.slice(0, at), line.slice(at + 1));
	}
	const repo = fields.get("repo");
	const graph = fields.get("graph");
	const report = fields.get("report");
	if (repo === undefined || graph === undefined || report === undefined) return undefined;
	const refreshedRaw = fields.get("refreshed_at");
	const refreshedSeconds = refreshedRaw ? Number(refreshedRaw) : Number.NaN;
	const commitsRaw = fields.get("commits_since");
	const commitsSince = commitsRaw ? Number(commitsRaw) : Number.NaN;
	return {
		repo,
		graph,
		report,
		exists: fields.get("exists") === "1",
		refreshedAt: Number.isFinite(refreshedSeconds) ? refreshedSeconds * 1000 : undefined,
		sha: fields.get("sha") || undefined,
		commitsSince: Number.isFinite(commitsSince) ? commitsSince : undefined,
		stale: fields.get("stale") === "1",
		running: fields.get("running") === "1",
		due: fields.get("due") === "1",
	};
}

/** The graph's state, or undefined when the path is not in a git repository or the script cannot run. */
export function graphStatus(repo: string, script: string = graphRefreshScript()): GraphStatus | undefined {
	try {
		return parseGraphStatus(execFileSync(script, ["--status", repo], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }));
	} catch {
		return undefined;
	}
}

/** One refresh, waited for (the nightly janitor). Throws with graphify's message when it fails; a refresh already running is success. */
export function refreshGraph(repo: string, timeoutMs = 600_000, script: string = graphRefreshScript()): void {
	try {
		execFileSync(script, [repo], { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
	} catch (error) {
		const stderr = (error as { stderr?: unknown }).stderr;
		const detail = typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim().split("\n").pop() : error instanceof Error ? error.message.split("\n")[0] : String(error);
		throw new Error(`graph refresh of ${repo} failed: ${detail}`);
	}
}

/**
 * Start a refresh and return at once (the tick). It runs in its own scope in pi-tests.slice, so it is not
 * part of the tick's service cgroup and outlives the run that started it.
 */
export function startGraphRefresh(repo: string, script: string = graphRefreshScript(), now: () => number = Date.now): void {
	const unit = `graph-refresh-${Math.floor(now() / 1000)}-${repo.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(-40)}`;
	const child = spawn("systemd-run", ["--user", "--scope", "--quiet", "--slice=pi-tests.slice", `--unit=${unit}`, "--", script, repo], { detached: true, stdio: "ignore" });
	child.on("error", () => {});
	child.unref();
}

export interface GraphRefreshPorts {
	repos(): string[];
	status(repo: string): GraphStatus | undefined;
	start(repo: string): void;
}

/**
 * The transient unit of one rebuild request: `graph-refresh-<project>`, fixed per repository so
 * `logs_read({source:"unit"})` has a handle. The project name is slugged to systemd's own alphabet.
 */
export function graphRefreshUnit(projectId: string): string {
	const slug = projectId.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
	return `graph-refresh-${slug === "" ? "repo" : slug}`;
}

/**
 * The argv of one rebuild request: a transient user unit that `--collect` removes once it exits. `unit` is the
 * name the request runs under, which is the live name unless the lab unit guard resolved it.
 */
export function graphRefreshRequestArgv(projectId: string, repo: string, script: string = graphRefreshScript(), unit: string = graphRefreshUnit(projectId)): string[] {
	return ["--user", "--unit", unit, "--collect", script, repo];
}

/** Starting one rebuild unit, and what systemd answered about it. The unit is never waited for. */
export type GraphRefreshRun = (argv: string[]) => { ok: boolean; detail: string };

/** The real runner: `systemd-run` hands the unit to the user manager and exits; the refresh itself runs on. */
export const runGraphRefreshUnit: GraphRefreshRun = (argv) => {
	const result = spawnSync("systemd-run", argv, { encoding: "utf8", timeout: 15_000 });
	if (result.error !== undefined) return { ok: false, detail: result.error.message };
	if (result.status === 0) return { ok: true, detail: "started" };
	const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
	const last = stderr === "" ? "" : stderr.split("\n").pop()!;
	return { ok: false, detail: last === "" ? `systemd-run exited ${result.status}` : last };
};

export interface GraphRefreshRequest {
	/** A unit was started. */
	started: boolean;
	/** The unit name either way, so the caller can look for it in the journal. */
	unit: string;
	detail: string;
}

/**
 * One rebuild request (HO12), decided by the script's own `--status` and nothing else. A refresh
 * already running means no second unit: the script's flock makes a losing call exit 0 having
 * refreshed nothing, so an exit code is never read as success here.
 */
export function requestGraphRefresh(options: {
	repo: string;
	projectId: string;
	status?: (repo: string) => GraphStatus | undefined;
	run?: GraphRefreshRun;
	script?: string;
	/** Where the lab unit marker is read from; `process.env` when absent. */
	env?: NodeJS.ProcessEnv;
}): GraphRefreshRequest {
	const live = graphRefreshUnit(options.projectId);
	const status = (options.status ?? graphStatus)(options.repo);
	if (status === undefined) return { started: false, unit: live, detail: `${options.repo} is not a repository the graph script can read` };
	if (status.running) return { started: false, unit: live, detail: `a refresh is already running in ${status.repo}` };
	// The lab unit guard (lab-units.ts): a marked lab starts only a unit it mapped, so a lab request can never
	// start a live graph-refresh unit, which reads the live checkouts (R2). A refusal starts nothing.
	let unit: string;
	try {
		unit = labUnitOperand(live, options.env ?? process.env);
	} catch (error) {
		if (!(error instanceof LabUnitRefusal)) throw error;
		return { started: false, unit: live, detail: error.message };
	}
	const result = (options.run ?? runGraphRefreshUnit)(graphRefreshRequestArgv(options.projectId, options.repo, options.script ?? graphRefreshScript(), unit));
	return result.ok ? { started: true, unit, detail: `started ${unit} for ${status.repo}` } : { started: false, unit, detail: `systemd-run refused ${unit}: ${result.detail}` };
}

export interface GraphRefreshStarted {
	repo: string;
	reason: string;
}

/**
 * The tick's graph pass: start a refresh for every catalogue repository whose graph exists and is due,
 * which is a local origin/dev or origin/main that has moved since the last refresh. A repository with no
 * graph is left to the janitor's nightly pass, which builds the first one.
 */
export function graphRefreshPass(ports: GraphRefreshPorts): GraphRefreshStarted[] {
	const started: GraphRefreshStarted[] = [];
	for (const repo of ports.repos()) {
		const status = ports.status(repo);
		if (status === undefined || !status.exists || !status.due) continue;
		ports.start(status.repo);
		started.push({ repo: status.repo, reason: status.sha === undefined ? "never refreshed by graph-refresh.sh" : `origin/dev or origin/main moved since ${status.sha.slice(0, 7)}` });
	}
	return started;
}

/**
 * The graph nudge for one tool call, as plain text, or undefined when there is nothing to say: the call is
 * not a raw-file search, the session was already nudged, or the repository has no graph. The script owns all
 * three decisions; Pi's tool-call hook only hands it the call in the same JSON shape Claude Code's
 * PreToolUse hook sends (`graph-nudge.sh --text`).
 */
export function graphNudge(call: { sessionId: string; cwd: string; toolName: string; input: unknown }, script: string = graphNudgeScript(), env: NodeJS.ProcessEnv = process.env): string | undefined {
	const result = spawnSync(script, ["--text"], {
		input: JSON.stringify({ session_id: call.sessionId, cwd: call.cwd, tool_name: call.toolName, tool_input: call.input }),
		encoding: "utf8",
		timeout: 15_000,
		env,
	});
	const text = result.status === 0 && typeof result.stdout === "string" ? result.stdout.trim() : "";
	return text === "" ? undefined : text;
}
