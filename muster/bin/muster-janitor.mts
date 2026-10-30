/**
 * Muster janitor (lifecycle blueprint WP6, LD4): run daily by the `muster-janitor.timer` user unit.
 *
 * It removes worktrees that are finished, closes the ended Claude lanes the lifecycle never managed,
 * archives closed lane records, stops the dev-server scopes a lane that is not running left behind,
 * cleans stale Concord endpoints and agents, then writes one report for
 * Henry and sends him one summary line. Failed
 * user units are sent to the orchestrator in one message instead of being left for the operator (AK11).
 * A worktree is removed only when it is clean, its HEAD has been in origin/dev or origin/main
 * for more than 24 h, and nothing uses it. It never forces a removal and never deletes a branch.
 * Dirty and unmerged worktrees are only listed (on Sundays). Run directly it makes one pass;
 * `--dry-run` prints what it would do and changes nothing.
 *
 * The OL1 cleanup rules (VR24-220, spec §6) are planned on every pass and acted on only for the rules
 * `state/muster/janitor-apply` lists, each enabled on its own (S3-F6). Every worktree removal is archived first,
 * in one path for a merged and an unmerged worktree alike (S3-F1, S3-F7); a finished job's `tmp` is emptied only
 * when the bus's own "finished" predicate says so (S3-F2); build caches go only from a worktree with no live lane
 * record, no registered scope and no process inside (S3-F8); docker images are judged by their `RepoDigests`
 * (S3-F9); the pnpm store prune runs by absolute path and reports the bytes it freed (S3-F10). No process is
 * signalled by folder match: the scope stops below are the only stops (S3-F3), and `fstrim` stays a named
 * command. A run takes `state/muster/janitor.lock` through `flock`, and a second run exits with "skipped: lock
 * held". Every run writes its report to `plans/muster-autonomy/janitor/`, dry runs included. Nothing that is not
 * a copy is deleted without its own ruling, and the archive of unmerged work is the only copy there is of it, so
 * this pass never deletes an archive.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { concordDbPath, musterStateDir, normalizePrimaryRoot, piAgentDir } from "../binding.ts";
import { catalogueRepoRoots, projectCataloguePath, readProjectCatalogue } from "../projects.ts";
import { archiveLaneRecord, idleLaneHelperScopes, LANE_NOT_RUNNING_PHASES, laneRecordsArchiveDir, listLaneRecords, readLaneRecord, recordLaunch, sessionUntouchable, type LaneRecord } from "../lane-lifecycle.ts";
import { closeLaneLive, CONCORD_INACTIVE_STATUS, deactivateConcordAgents, findOrphanClaudeShells, isFinishedClaudeJobState, openConcordRepositories, stopIdleHelperScopes, stopOrphanClaudeShells, type OrphanClaudeShell, type StoppedHelperScope, type StoppedOrphanShell } from "../lane-lifecycle-ports.ts";
import { ORCHESTRATOR_ADDRESS } from "../lane-report.ts";
import { readBackend } from "../ledger/backend.ts";
import { backupLedger, ledgerDirFor } from "../cli/ledger.ts";
import { musterLauncher } from "../../core/pi-ports.ts";
import { tellGrokbot } from "../grokbot-tell.ts";
import { enumerateLanes, procPidAlive } from "../lib/lane-directory.ts";
import { readClaudeJob } from "../lib/claude-lane-card.ts";
import type { LaneCard } from "../lib/lane-card.ts";
import { graphStatus, refreshGraph, type GraphStatus } from "../../core/graph-refresh.ts";

const HOUR_MS = 3_600_000;
/** LD4: a worktree is removed once its HEAD has been in the base for more than this. */
export const MERGED_MIN_AGE_MS = 24 * HOUR_MS;
/** Closed lane records and silent Concord endpoints are cleaned after the same day. */
export const CLEANUP_AFTER_MS = 24 * HOUR_MS;
/** A Claude lane with no record and no report is closed once it has been silent for this long. */
export const ENDED_LANE_IDLE_MS = 24 * HOUR_MS;
/** The base refs a lane's work is merged into. */
const BASE_REFS = ["origin/dev", "origin/main"] as const;
/** The principal the janitor sends as: its own, never the orchestrator seat. */
export const JANITOR_SENDER = "muster-janitor";

// ─── git ─────────────────────────────────────────────────────────────────────

/** `GIT_OPTIONAL_LOCKS=0`: reading a worktree's status must not rewrite its index under a lane that is using it. */
const READ_ONLY_GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

/** stdout of one git call, or undefined when it fails or times out. */
function git(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024, env: READ_ONLY_GIT_ENV });
	} catch {
		return undefined;
	}
}

/** `git merge-base --is-ancestor`: true or false, and undefined when git could not answer. */
function isAncestor(cwd: string, sha: string, ref: string): boolean | undefined {
	const result = spawnSync("git", ["-C", cwd, "merge-base", "--is-ancestor", sha, ref], { stdio: "ignore", timeout: 30_000, env: READ_ONLY_GIT_ENV });
	return result.status === 0 ? true : result.status === 1 ? false : undefined;
}

// ─── worktrees ───────────────────────────────────────────────────────────────

export interface WorktreeEntry {
	path: string;
	sha: string;
	/** Branch name, or null for a detached HEAD. */
	branch: string | null;
	locked: boolean;
}

/** The linked worktrees of a repository: `git worktree list --porcelain` minus the main one (always first). */
export function listLinkedWorktrees(repo: string): WorktreeEntry[] | undefined {
	const out = git(repo, ["worktree", "list", "--porcelain"]);
	if (out === undefined) return undefined;
	const entries = out.split(/\n\n+/).flatMap((block) => {
		const lines = block.split("\n").filter((line) => line !== "");
		const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
		const sha = lines.find((line) => line.startsWith("HEAD "))?.slice("HEAD ".length);
		if (path === undefined || sha === undefined || lines.includes("bare")) return [];
		const branchRef = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
		return [{ path, sha, branch: branchRef?.replace(/^refs\/heads\//, "") ?? null, locked: lines.some((line) => line === "locked" || line.startsWith("locked ")) }];
	});
	return entries.slice(1);
}

export type WorktreeVerdict = "remove" | "keep-recent" | "keep-in-use" | "keep-unknown" | "dirty" | "unmerged";

export interface WorktreeFinding {
	repo: string;
	path: string;
	branch: string | null;
	sha: string;
	verdict: WorktreeVerdict;
	reason: string;
	/** Commit time of HEAD (ms), for the weekly list. */
	lastCommitAt?: number;
	lastSubject?: string;
}

export interface WorktreeUsage {
	/** The cwd of every live lane row. */
	laneCwds: readonly string[];
	/** Every `/proc/<pid>/cwd`. */
	processCwds: readonly string[];
	/** AK12: the paths the user's unit files name. */
	units: UnitUsage;
}

// ─── user units (AK12) ───────────────────────────────────────────────────────

/** The unit directory the AK12 keep rule reads. */
export const USER_UNIT_DIR = join(homedir(), ".config", "systemd", "user");

export interface UnitUsage {
	/** Every path a user unit names as its `WorkingDirectory` or in an `ExecStart*` line. */
	named: readonly string[];
	/** A unit file could not be read, so whether one names a worktree cannot be known. */
	unreadable: boolean;
}

/** systemd's `~` and `%h`: the home directory of the user the unit runs as. */
function expandHome(value: string): string {
	const home = homedir();
	return value.replace(/^~(?=\/|$)/, home).replaceAll("%h", home);
}

/** A word of a command line that names a path: absolute, or home-relative. */
function isPathWord(word: string): boolean {
	return word.startsWith("/") || word === "~" || word.startsWith("~/") || word.startsWith("%h");
}

/**
 * Every path one unit file names: the whole value of `WorkingDirectory` (with systemd's optional `-`
 * prefix dropped) and each path-looking word of an `ExecStart`, `ExecStartPre` or `ExecStartPost`
 * line, with `~` and `%h` expanded.
 */
export function unitNamedPaths(text: string): string[] {
	const named: string[] = [];
	for (const line of text.split("\n")) {
		const match = /^\s*(WorkingDirectory|ExecStart|ExecStartPre|ExecStartPost)\s*=\s*(.+)$/.exec(line);
		if (match === null) continue;
		const value = match[2]!.trim().replace(/^"|"$/g, "");
		if (match[1] === "WorkingDirectory") {
			named.push(expandHome(value.replace(/^-/, "")));
			continue;
		}
		for (const word of value.split(/\s+/)) {
			const token = word.replace(/^["']|["']$/g, "");
			if (isPathWord(token)) named.push(expandHome(token));
		}
	}
	return named;
}

/**
 * The unit rule read from a directory: what its `.service` files name. Only a service unit carries
 * `WorkingDirectory` and `ExecStart`, so the directory's other entries and drop-in directories are
 * skipped rather than misread as unreadable unit files. A unit file that cannot be read leaves the
 * rule unknown, and a worktree a unit might name is then never removed.
 */
export function readUnitUsage(dir: string): UnitUsage {
	if (!existsSync(dir)) return { named: [], unreadable: false };
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return { named: [], unreadable: true };
	}
	const named: string[] = [];
	let unreadable = false;
	for (const name of names.filter((entry) => entry.endsWith(".service"))) {
		try {
			named.push(...unitNamedPaths(readFileSync(join(dir, name), "utf8")));
		} catch {
			unreadable = true;
		}
	}
	return { named, unreadable };
}

function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function isInside(dir: string, candidate: string): boolean {
	return candidate === dir || candidate.startsWith(`${dir}/`);
}

/**
 * Milliseconds since HEAD reached `ref`: the commit time of the earliest descendant of `sha` on that ref
 * (last line of `git log --ancestry-path`). null when `sha` is the ref's tip, where the log has no
 * descendant and the time it got there cannot be read.
 */
function mergedSince(repo: string, sha: string, ref: string): number | null | undefined {
	const out = git(repo, ["log", "--ancestry-path", "--format=%ct", `${sha}..${ref}`]);
	if (out === undefined) return undefined;
	const lines = out.split("\n").filter((line) => line.trim() !== "");
	if (lines.length === 0) return null;
	const seconds = Number(lines[lines.length - 1]);
	return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

/** Classify the linked worktrees of one repository. Reads git only; changes nothing. */
export function classifyWorktrees(repo: string, now: number, usage: WorktreeUsage): WorktreeFinding[] {
	const entries = listLinkedWorktrees(repo);
	if (entries === undefined) return [{ repo, path: repo, branch: null, sha: "", verdict: "keep-unknown", reason: "git worktree list failed" }];
	const refs = BASE_REFS.filter((ref) => git(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/${ref}`]) !== undefined);
	const laneCwds = usage.laneCwds.map(real);
	const processCwds = usage.processCwds.map(real);
	const unitPaths = usage.units.named.map(real);
	return entries.flatMap((entry): WorktreeFinding[] => {
		if (!existsSync(entry.path)) return []; // a vanished directory is `git worktree prune`'s, not ours
		const path = real(entry.path);
		const base = { repo, path: entry.path, branch: entry.branch, sha: entry.sha };
		const last = git(path, ["log", "-1", "--format=%ct%x09%s"])?.trim().split("\t");
		const commit = last !== undefined && Number.isFinite(Number(last[0])) ? { lastCommitAt: Number(last[0]) * 1000, lastSubject: last.slice(1).join("\t") } : {};
		const found = (verdict: WorktreeVerdict, reason: string): WorktreeFinding => ({ ...base, ...commit, verdict, reason });

		const status = git(path, ["status", "--porcelain"]);
		if (status === undefined) return [found("keep-unknown", "git status failed")];
		if (status.trim() !== "") return [found("dirty", "uncommitted changes")];
		if (entry.locked) return [found("keep-unknown", "worktree is locked")];

		let ageMs: number | undefined;
		let mergedRef: string | undefined;
		let unknown = false;
		let tip = false;
		for (const ref of refs) {
			const ancestor = isAncestor(path, entry.sha, ref);
			if (ancestor === undefined) unknown = true;
			if (ancestor !== true) continue;
			const since = mergedSince(path, entry.sha, ref);
			if (since === undefined) unknown = true;
			else if (since === null) tip = true;
			else if (ageMs === undefined || now - since > ageMs) {
				ageMs = now - since;
				mergedRef = ref;
			}
		}
		if (ageMs === undefined) {
			if (unknown) return [found("keep-unknown", "git could not tell whether HEAD is merged")];
			if (tip) return [found("keep-recent", "HEAD is the tip of the base; the time it got there is unknown")];
			return [found("unmerged", refs.length === 0 ? "no origin/dev or origin/main ref" : "HEAD is not in origin/dev or origin/main")];
		}
		if (ageMs <= MERGED_MIN_AGE_MS) return [found("keep-recent", `merged ${Math.round(ageMs / HOUR_MS)} h ago`)];

		if (laneCwds.some((cwd) => isInside(path, cwd))) return [found("keep-in-use", "a live lane row uses it as its cwd")];
		if (processCwds.some((cwd) => isInside(path, cwd))) return [found("keep-in-use", "a process has it as its cwd")];
		if (unitPaths.some((named) => isInside(path, named))) return [found("keep-in-use", "a user unit names it")];
		if (usage.units.unreadable) return [found("keep-unknown", "a user unit file could not be read")];
		return [found("remove", `clean, in ${mergedRef} for ${Math.round(ageMs / HOUR_MS)} h, unused`)];
	});
}

/** Today's manifest format: `repo | path | branch | sha`, one line per removal written before the removal, under a header with the restore line. */
export function appendManifest(file: string, date: string, finding: WorktreeFinding): void {
	mkdirSync(dirname(file), { recursive: true });
	if (!existsSync(file)) {
		writeFileSync(file, `# Worktrees removed ${date} by muster-janitor (archived first, then removed: clean HEAD in origin/dev or origin/main for more than 24 h, or a closed lane's unmerged work, and no process using them). Restore: git -C <repo> worktree add <path> <branch-or-sha>\n`);
	}
	appendFileSync(file, `${finding.repo} | ${finding.path} | ${finding.branch ?? "detached"} | ${finding.sha}\n`);
}

/**
 * A removal the pass attempted and git refused. Its manifest line is already written, so this correction goes
 * beside it: whoever reads the manifest must never take a worktree that is still there for one that went.
 */
export function appendKeptLine(file: string, date: string, finding: WorktreeFinding, error: string): void {
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `# kept ${date}: ${finding.repo} | ${finding.path} was not removed (${error}); the worktree is still there\n`);
}

export interface RemovalResult {
	removed: WorktreeFinding[];
	failed: Array<{ finding: WorktreeFinding; error: string }>;
}

// ─── the OL1 cleanup rules (VR24-220, spec §6) ────────────────────────────────
//
// Six rule groups, each planned on every pass. A rule's write half runs only when `state/muster/janitor-apply`
// names it, and that line is the rule's rollback (S3-F6). Every rule states what keeps a thing, every worktree
// removal goes through one function whether the worktree is merged or not (S3-F1), and the only thing never
// deleted here is the archive of unmerged work, which is the only copy there is of it.

/** Where a removed worktree's unmerged work is kept: one folder per day (spec §6, OL1). */
export const ARCHIVE_ROOT = join(homedir(), "projects", "_worktree-archive");
/** Rule (b): a finished job's scratch folder is emptied once nothing has written to the job for this long. */
export const JOB_TEMP_MIN_AGE_MS = 2 * 24 * HOUR_MS;
/** Rule (c): a worktree's build caches go once its HEAD is this old and nothing uses the worktree. */
export const BUILD_CACHE_IDLE_MS = 24 * HOUR_MS;
/** Rule (c): the only directory names it removes. */
export const BUILD_CACHE_DIRS = [".next", "dist"] as const;
/** Rule (a): untracked payload above this is archived to `LARGE_ARCHIVE_ROOT` with a checksum, not deleted. */
export const ARCHIVE_MAX_BYTES = 200 * 1024 ** 2;
/** Rule (a): where a worktree over that size is copied, with the sha256 of every file (VR24-223). */
export const LARGE_ARCHIVE_ROOT = "/mnt/e/archive";
/** Rule (d): an image is removable once no container has used it for a week (VR24-224). */
export const DOCKER_IMAGE_MIN_AGE_MS = 168 * HOUR_MS;
/** Rule (g): one declared repair is one bounded command, never a shell. */
export const DOCTOR_REPAIR_TIMEOUT_MS = 30_000;
/**
 * Rule (g): a contract repaired once is left alone this long. The doctor re-reads every two minutes, so the
 * repair's own effect is visible long before the window ends; a second attempt inside it would be a loop.
 */
export const DOCTOR_REPAIR_WINDOW_MS = 15 * 60_000;
/** Rule (g): a timer contract's id is a unit name, and only a unit name is ever handed to systemctl. */
const TIMER_CONTRACT_ID = /^[A-Za-z0-9@._-]+\.timer$/;

// ─── the rule switch and the pass lock (spec §6 line 1, S3-F6) ────────────────

/**
 * The §6 rule groups the apply file may name, each enabled on its own. Every rule it does not name only plans,
 * so the file's contents are the rollback: remove one line and that rule stops acting.
 */
export const JANITOR_RULES = ["worktrees", "job-temp", "build-caches", "docker", "pnpm", "repairs"] as const;
export type JanitorRule = (typeof JANITOR_RULES)[number];

/** The switch: one rule name per line, `#` starting a comment. A missing file means no rule applies. */
export function applyFilePath(stateDir: string): string {
	return join(stateDir, "janitor-apply");
}

/** The rules the switch names. A word outside `JANITOR_RULES` is ignored, so a typo enables nothing. */
export function readAppliedRules(file: string): Set<JanitorRule> {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return new Set();
	}
	const named = new Set<JanitorRule>();
	for (const line of text.split("\n")) {
		const name = line.split("#")[0]!.trim();
		if ((JANITOR_RULES as readonly string[]).includes(name)) named.add(name as JanitorRule);
	}
	return named;
}

/** What a run prints and exits with while another run holds the pass lock. */
export const LOCK_HELD_MESSAGE = "skipped: lock held";

/** The lock file's name under the state directory. */
export const PASS_LOCK_FILE = "janitor.lock";

/** §6 calls the docker prune and the pnpm store prune weekly: Sunday, the day this pass already lists dirty worktrees. */
export const WEEKLY_PASS_DAY = 0;

/** Is `now` the weekly pass's day? */
export function isWeeklyPass(now: number): boolean {
	return new Date(now).getDay() === WEEKLY_PASS_DAY;
}

/** A run's exclusive lock, held for the life of the pass. */
export interface PassLock {
	file: string;
	release(): void;
}

/**
 * Take the pass's exclusive `flock` on `state/muster/janitor.lock`, so a manual run and the timer can never act
 * on the same rules at once (spec §6 line 1). The holder is `flock -n <file> sh -c 'echo HELD; read'`, the same
 * probe `scripts/secrets/cutover.mts` uses: it prints `HELD` once it has the lock and stays until the pipe
 * closes. undefined means the lock is held elsewhere, `flock` is unavailable, or it refused for another reason.
 */
export function holdPassLock(file: string): Promise<PassLock | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (value: PassLock | undefined): void => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		let holder: ReturnType<typeof spawn>;
		try {
			mkdirSync(dirname(file), { recursive: true });
			holder = spawn("flock", ["-n", file, "sh", "-c", "echo HELD; read -r _ || true"], { stdio: ["pipe", "pipe", "pipe"] });
		} catch {
			settle(undefined);
			return;
		}
		holder.stdout?.setEncoding("utf8");
		holder.stdout?.on("data", (chunk: string) => {
			if (!chunk.includes("HELD")) return;
			settle({
				file,
				release() {
					// Closing the pipe ends the holder's `read`, so `flock` exits and releases the lock.
					try {
						holder.stdin?.end();
					} catch {
						// the holder is already gone
					}
					holder.unref();
					holder.kill();
				},
			});
		});
		holder.on("error", () => settle(undefined));
		// `flock -n` exits at once without printing when another run holds the lock.
		holder.on("exit", () => settle(undefined));
	});
}

/** A link in another checkout whose target is inside the worktree a pass would remove (PRUNE2). */
export interface LinkUser {
	link: string;
	target: string;
}

/** One worktree to archive and then remove: the one removal path for a merged and an unmerged worktree alike (S3-F1). */
export interface ArchiveTarget {
	finding: WorktreeFinding;
	/**
	 * The closed lane record that owns an unmerged worktree. Undefined for a merged one: the base ref already holds
	 * its commits, so no record is needed to say the worktree is finished with.
	 */
	laneId?: string;
	/** The ref that keeps the commit after the folder is gone: `refs/archive/wt/<name>`. */
	ref: string;
	/** The folder the diff, the copies and the manifest are written to. */
	dir: string;
}

/** A worktree rule (a) would remove and does not, with the fact that keeps it. */
export interface CleanupKeep {
	finding: WorktreeFinding;
	why: string;
}

/** Rule (a): a worktree whose untracked payload is over the cap, copied to `/mnt/e/archive` and kept. */
export interface LargeArchive {
	finding: WorktreeFinding;
	laneId?: string;
	/** The folder the files and their sha256 manifest are written to. */
	dir: string;
	files: number;
	bytes: number;
}

/** Rule (d): one image the weekly pass may remove. */
export interface DockerImage {
	id: string;
	repository: string;
	tag: string;
	/** When the image was built, ms. */
	createdMs: number;
	/**
	 * `docker image inspect`'s `RepoDigests`: the registry copies this image can be pulled again from. An image
	 * built locally has none, so removing it would lose it (S3-F9).
	 */
	repoDigests: readonly string[];
	/** How many containers name it. A container of any state keeps an image out of the prune. */
	containers: number;
}

/** The fields of one red or green doctor contract this rule reads (OL0's table, the doctor's owner). */
export interface DoctorContract {
	kind: string;
	id: string;
	ok: boolean;
}

/** Rule (g): one declared, bounded repair. */
export interface DoctorRepair {
	contractId: string;
	/** argv, never a shell line: nothing from the doctor's output reaches it. */
	command: string[];
	why: string;
	timeoutMs: number;
}

/** Rule (g): what one pass may repair, and the red contracts it may not. */
export interface DoctorRepairPlan {
	repairs: DoctorRepair[];
	/** Red contracts with no declared repair: a report line, never a guess. */
	unrepairable: DoctorContract[];
	/** Repaired inside the window, so not again yet. */
	repairedRecently: string[];
	/** Repaired earlier today, so not again today. */
	repairedToday: string[];
}

/** A command a rule names but never runs: it reaches a store or the disk outside this owner. */
export interface PlannedCommand {
	command: string;
	why: string;
}

/** Everything one pass would do under the cleanup rules, computed by reading only. */
export interface CleanupPlan {
	/** Rule (a): archived, then removed. */
	archives: ArchiveTarget[];
	/** Rule (a): over the size cap, copied to `/mnt/e/archive` with a checksum, and kept. */
	largeArchives: LargeArchive[];
	/** Rule (a): closed-lane worktrees kept, and why. */
	kept: CleanupKeep[];
	/** Rule (b): finished job folders to empty. */
	jobDirs: string[];
	/** Rule (c): cache folders to delete. */
	caches: string[];
	/** Rule (d): images the weekly pass may remove. */
	dockerImages: DockerImage[];
	/** Rule (d): images it leaves and why, so a plan-only report says what it skipped. */
	dockerSkipped: Array<{ image: DockerImage; reason: "local-build" | "in-use"; why: string }>;
	/** Rules (docker, pnpm) and (f): what the pass names, and the one command it runs weekly. */
	commands: PlannedCommand[];
	/** Rule (pnpm): the store prune the weekly pass runs, by absolute path (S3-F10). */
	pnpm?: PlannedCommand;
	/** Rule (g): the declared repairs this pass may run, and the red contracts it may not. */
	doctorRepairs: DoctorRepairPlan;
	/** Spec §6 line 1: archives past 30 days that may go, and the ones that stay with the reason. */
	expiringArchives: ArchiveExpiry[];
	keptArchives: ArchiveExpiry[];
}

function gib(bytes: number): string {
	return (bytes / 1024 ** 3).toFixed(1);
}

/**
 * The closed lane records the pass archived on an earlier day. A lane's worktree is still that lane's to give
 * up a month later, and the record is the only fact that says the lane is closed, so rule (a) reads both the
 * live records and the archive (the archive's layout is `laneRecordsArchiveDir`'s, the owner of both).
 */
export function archivedLaneRecords(stateDir: string): LaneRecord[] {
	const root = laneRecordsArchiveDir(stateDir);
	let months: string[];
	try {
		months = readdirSync(root).filter((name) => /^\d{4}-\d{2}$/.test(name));
	} catch {
		return [];
	}
	const records: LaneRecord[] = [];
	for (const month of months) {
		let files: string[];
		try {
			files = readdirSync(join(root, month)).filter((name) => name.endsWith(".json"));
		} catch {
			continue;
		}
		for (const file of files) {
			try {
				const parsed = JSON.parse(readFileSync(join(root, month, file), "utf8")) as Partial<LaneRecord>;
				if (typeof parsed.laneId === "string" && parsed.phase === "closed") records.push(parsed as LaneRecord);
			} catch {
				// an archive file that cannot be read is not a fact this pass can use
			}
		}
	}
	return records;
}

/** A ref-safe name for a worktree path, from its own folder name. */
export function archiveRefName(path: string): string {
	const name = basename(path).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^\.+/, "w").slice(0, 80);
	return name === "" || name === "-" ? "worktree" : name;
}

/**
 * The closed lane record that owns a worktree: its cwd is the worktree, or its branch is the worktree's.
 * Rule (a) removes a worktree only when this exists, because "closed" is the lane record's fact.
 */
export function closedLaneFor(finding: WorktreeFinding, records: readonly LaneRecord[]): LaneRecord | undefined {
	const path = real(finding.path);
	return records.find(
		(record) => record.phase === "closed" && ((record.cwd !== null && real(record.cwd) === path) || (finding.branch !== null && record.branch === finding.branch)),
	);
}

/** Every `node_modules` link of `root`, and of one package level below it, that resolves inside `target`. */
/**
 * Every link of the other checkouts that resolves inside `target`: any symlink at a checkout's root or in a
 * directory one level below it, `node_modules` among them. Removing a worktree one of them points into breaks
 * that checkout, which is the PRUNE2 incident.
 */
export function linksInto(target: string, roots: readonly string[]): LinkUser[] {
	const inside = real(target);
	const found: LinkUser[] = [];
	const link = (path: string): void => {
		let isLink = false;
		try {
			isLink = lstatSync(path).isSymbolicLink();
		} catch {
			return;
		}
		if (!isLink) return;
		const resolved = real(path);
		if (isInside(inside, resolved)) found.push({ link: path, target: resolved });
	};
	for (const root of roots) {
		if (real(root) === inside) continue;
		let entries: Dirent[];
		try {
			entries = readdirSync(root, { withFileTypes: true });
		} catch {
			continue; // an unreadable checkout has no link this pass can know about
		}
		for (const entry of entries) {
			if (entry.name === ".git") continue;
			const path = join(root, entry.name);
			link(path);
			if (!entry.isDirectory()) continue;
			let children: Dirent[];
			try {
				children = readdirSync(path, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const child of children) link(join(path, child.name));
		}
	}
	return found;
}

/** The archive folder for one worktree on one date, made unique when a name repeats. */
export function archiveDirFor(root: string, date: string, path: string): string {
	const name = archiveRefName(path);
	let dir = join(root, date, name);
	for (let n = 2; existsSync(dir); n += 1) dir = join(root, date, `${name}-${n}`);
	return dir;
}

/** The sha256 of a file, read in chunks so a large file is never held in memory. */
function sha256(file: string): string {
	const hash = createHash("sha256");
	const fd = openSync(file, "r");
	try {
		const buffer = Buffer.allocUnsafe(1 << 20);
		for (;;) {
			const read = readSync(fd, buffer, 0, buffer.length, null);
			if (read === 0) break;
			hash.update(buffer.subarray(0, read));
		}
	} finally {
		closeSync(fd);
	}
	return hash.digest("hex");
}

/**
 * What an archive never copies: the trees a build regenerates, and the files that hold secrets. The test is on the
 * path's segments and its name, because the list comes from git and `.env*` is a pattern (S3-F4, spec §6 line 113).
 */
const ARCHIVE_EXCLUDED_SEGMENTS = new Set<string>(["node_modules", ...BUILD_CACHE_DIRS, "coverage", ".turbo"]);

/** Is this path one the archive never copies: a regenerated tree, or a `.env*` file? */
function isArchiveExcluded(path: string): boolean {
	if (path.split("/").some((segment) => ARCHIVE_EXCLUDED_SEGMENTS.has(segment))) return true;
	return basename(path).startsWith(".env");
}

/**
 * Every file below `path` git does not track and no build regenerates, with the total size git reports. The files
 * left out are named too, so nothing is silently dropped: they leave the copies, never the report.
 */
function archivePayload(path: string): { files: string[]; excluded: string[]; bytes: number } {
	const { untracked, ignored } = untrackedFiles(path);
	const all = [...untracked, ...ignored];
	const files = all.filter((file) => !isArchiveExcluded(file));
	const excluded = all.filter((file) => isArchiveExcluded(file));
	let bytes = 0;
	for (const file of files) {
		try {
			bytes += statSync(join(path, file)).size;
		} catch {
			// a file that vanished contributes nothing
		}
	}
	return { files, excluded, bytes };
}

/** The archive destinations rule (a) writes to: the day's folder, and the large-payload root. */
export interface ArchiveRoots {
	root: string;
	largeRoot: string;
	/** The payload above which the large path is used; `ARCHIVE_MAX_BYTES` unless a test says otherwise. */
	maxBytes?: number;
}

/**
 * The one removal path's plan: every worktree this pass would archive and then remove, merged or unmerged
 * (S3-F1). A merged worktree needs no lane record, because the base ref already holds its commits; an unmerged one
 * is removed only when a closed lane record owns it. Kept: a worktree a live lane row, a live process or a user
 * unit names, a worktree whose unit directory could not be read, and a worktree another checkout's link resolves
 * into. A worktree whose payload is over the size cap goes to `/mnt/e/archive` with a checksum instead, and stays.
 */
export function planArchives(findings: readonly WorktreeFinding[], records: readonly LaneRecord[], usage: WorktreeUsage, others: readonly string[], roots: ArchiveRoots, date: string): { archives: ArchiveTarget[]; largeArchives: LargeArchive[]; kept: CleanupKeep[] } {
	const laneCwds = usage.laneCwds.map(real);
	const processCwds = usage.processCwds.map(real);
	const unitPaths = usage.units.named.map(real);
	const maxBytes = roots.maxBytes ?? ARCHIVE_MAX_BYTES;
	const archives: ArchiveTarget[] = [];
	const largeArchives: LargeArchive[] = [];
	const kept: CleanupKeep[] = [];
	for (const finding of findings) {
		if (finding.verdict !== "unmerged" && finding.verdict !== "remove") continue;
		const record = closedLaneFor(finding, records);
		if (finding.verdict === "unmerged" && record === undefined) continue;
		const path = real(finding.path);
		const keep = (why: string) => kept.push({ finding, why });
		const target = (dir: string) => ({
			finding,
			...(record === undefined ? {} : { laneId: record.laneId }),
			ref: `refs/archive/wt/${archiveRefName(finding.path)}`,
			dir,
		});
		if (laneCwds.some((cwd) => isInside(path, cwd))) keep("a live lane row uses it as its cwd");
		else if (processCwds.some((cwd) => isInside(path, cwd))) keep("a process has it as its cwd");
		else if (unitPaths.some((named) => isInside(path, named))) keep("a user unit names it");
		else if (usage.units.unreadable) keep("a user unit file could not be read");
		else {
			const links = linksInto(path, others);
			if (links.length > 0) keep(`other checkouts have a link into it: ${links.map((link) => link.link).join(", ")}`);
			else {
				const payload = archivePayload(finding.path);
				if (payload.bytes > maxBytes) {
					largeArchives.push({ finding, ...(record === undefined ? {} : { laneId: record.laneId }), dir: archiveDirFor(roots.largeRoot, date, finding.path), files: payload.files.length, bytes: payload.bytes });
				} else archives.push({ ...target(archiveDirFor(roots.root, date, finding.path)) });
			}
		}
	}
	return { archives, largeArchives, kept };
}

/**
 * Rule (a)'s large half: copy the payload to `/mnt/e/archive`, write the manifest with the sha256 of every
 * file, and check each copy against it. The worktree stays: this is a copy, not a removal.
 */
export function largeArchive(target: LargeArchive): { ok: boolean; detail: string } {
	try {
		if (existsSync(join(target.dir, "manifest.json"))) return { ok: true, detail: `${target.dir} already holds it` };
		mkdirSync(target.dir, { recursive: true });
		const payload = archivePayload(target.finding.path);
		const files: Array<{ path: string; bytes: number; sha256: string }> = [];
		for (const file of payload.files) {
			const from = join(target.finding.path, file);
			const to = join(target.dir, "files", file);
			copyInto(from, to);
			const copied = sha256(to);
			if (copied !== sha256(from)) return { ok: false, detail: `${file} did not copy intact, so nothing is removed` };
			files.push({ path: file, bytes: statSync(to).size, sha256: copied });
		}
		writeFileSync(
			join(target.dir, "manifest.json"),
			`${JSON.stringify({ repo: target.finding.repo, path: target.finding.path, branch: target.finding.branch, sha: target.finding.sha, laneId: target.laneId ?? null, files, excluded: payload.excluded, kept: "the worktree is not removed" }, null, "\t")}\n`,
		);
		return { ok: true, detail: `${files.length} files sha256-checked in ${target.dir}; the worktree is kept` };
	} catch (error) {
		return { ok: false, detail: error instanceof Error ? error.message : String(error) };
	}
}

function copyInto(from: string, to: string): void {
	mkdirSync(dirname(to), { recursive: true });
	copyFileSync(from, to);
}

/** The newest write anywhere in a folder tree, to the depth a job's own files reach. */
function newestWrite(dir: string, depth = 3): number {
	let newest = 0;
	const mtime = (path: string): number => {
		try {
			return statSync(path).mtimeMs;
		} catch {
			return 0;
		}
	};
	newest = mtime(dir);
	if (depth === 0) return newest;
	let entries: Dirent[] | undefined;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return newest;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		newest = Math.max(newest, entry.isDirectory() ? newestWrite(path, depth - 1) : mtime(path));
	}
	return newest;
}

/** One job folder's own `sessionId`, so the bus's reader can look the job up by the key it owns. */
function readJobSessionId(dir: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
		const sessionId = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["sessionId"] : undefined;
		return typeof sessionId === "string" ? sessionId : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Rule (b): the `tmp` folder of a job the bus's own "finished" predicate calls finished (`isFinishedClaudeJobState`,
 * `lane-lifecycle-ports.ts`) and nothing has written to for more than two days (S3-F2). Reads only. Kept: a job
 * with no readable record (which is not evidence that it finished), a working or a blocked job, and a job the bus
 * may not touch (`sessionUntouchable`: a seat holder, `operator:*`, a conversation, the orchestrator). The folder is
 * emptied, never deleted, so the job's record stays.
 */
export function planJobTempCleanup(jobsDir: string, stateDir: string, now: number): string[] {
	let names: string[];
	try {
		names = readdirSync(jobsDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
	return names.flatMap((name) => {
		const dir = join(jobsDir, name);
		// The record is read through its owner, which rejects a file whose `sessionId` is not this session's.
		const job = readClaudeJob(readJobSessionId(dir), { jobsDir });
		if (job === undefined) return [];
		if (!isFinishedClaudeJobState(job.state)) return [];
		if (sessionUntouchable({ stateDir, laneId: job.name }) !== undefined) return [];
		const newest = job.updatedAtMs ?? newestWrite(dir);
		if (!(now - newest > JOB_TEMP_MIN_AGE_MS)) return [];
		const tmp = join(dir, "tmp");
		try {
			return statSync(tmp).isDirectory() ? [tmp] : [];
		} catch {
			return [];
		}
	});
}

/**
 * Rule (c): `.next` and `dist` in a worktree whose HEAD is over a day old and that nothing is using: no live lane
 * record, no registered helper scope, no process inside, and no commit inside `BUILD_CACHE_IDLE_MS` (S3-F8, spec
 * §6 line 118). A monorepo builds into its package folders, so each real directory at the worktree's root is looked
 * at too. A lane record still working, or one that registered a scope (a dev server may be watching that tree),
 * keeps them.
 */
export function planBuildCaches(findings: readonly WorktreeFinding[], usage: WorktreeUsage, records: readonly LaneRecord[], now: number): string[] {
	const laneCwds = usage.laneCwds.map(real);
	const processCwds = usage.processCwds.map(real);
	const held = records
		.filter((record) => record.cwd !== null && (!LANE_NOT_RUNNING_PHASES.includes(record.phase) || (record.helperScopes ?? []).length > 0))
		.map((record) => real(record.cwd!));
	return findings.flatMap((finding) => {
		if (finding.lastCommitAt === undefined || now - finding.lastCommitAt <= BUILD_CACHE_IDLE_MS) return [];
		const path = real(finding.path);
		if (!existsSync(path)) return [];
		if (laneCwds.some((cwd) => isInside(path, cwd)) || processCwds.some((cwd) => isInside(path, cwd))) return [];
		if (held.some((cwd) => isInside(path, cwd))) return [];
		const dirs = [path];
		try {
			for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isDirectory()) dirs.push(join(path, entry.name));
		} catch {
			// a worktree that cannot be listed has no cache this pass can name
		}
		return dirs.flatMap((dir) =>
			BUILD_CACHE_DIRS.flatMap((name) => {
				const cache = join(dir, name);
				try {
					// A symlink may point outside the worktree, so only a real directory is this rule's.
					return statSync(cache).isDirectory() && !lstatSync(cache).isSymbolicLink() ? [cache] : [];
				} catch {
					return [];
				}
			}),
		);
	});
}

/**
 * Rule (f): the weekly command that stays a command. `fstrim` reaches the disk outside this owner, so it is named
 * and never run. The pnpm store prune has its own rule and it runs: see `runPnpmStorePrune`.
 */
export function planWeeklyCommands(): PlannedCommand[] {
	return [{ command: "fstrim /", why: "the WSL disk trims the blocks it no longer uses" }];
}

/** A byte count as the operator reads it. */
export function bytesLabel(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
	return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** The bytes below `dir`, so a prune's freed size is measured rather than parsed from its own output (S3-F10). */
export function dirBytes(dir: string): number {
	let total = 0;
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			total += dirBytes(path);
			continue;
		}
		try {
			total += statSync(path).size;
		} catch {
			// a file that vanished contributes nothing
		}
	}
	return total;
}

/**
 * The pnpm binary, by absolute path: the unit's `PATH` carries no pnpm shim, so a bare name is never enough
 * (S3-F10). undefined when this machine has none in those places.
 */
export function findPnpm(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const onPath = (env["PATH"] ?? "")
		.split(":")
		.filter((dir) => dir !== "")
		.map((dir) => join(dir, "pnpm"));
	const candidates = [...onPath, join(homedir(), ".local", "share", "pnpm", "pnpm"), "/usr/local/bin/pnpm", "/usr/bin/pnpm"];
	return candidates.find((candidate) => {
		try {
			return statSync(candidate).isFile();
		} catch {
			return false;
		}
	});
}

/**
 * Rule (pnpm): `pnpm store prune` for the store at its own absolute path, with the bytes it freed measured before and
 * after (S3-F10, VR24-224). It reaches the store outside this owner, so it runs only when the apply file names the
 * rule, and weekly.
 */
export function runPnpmStorePrune(binary: string): { ok: boolean; detail: string; freedBytes?: number } {
	try {
		const store = execFileSync(binary, ["store", "path"], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
		if (store === "") return { ok: false, detail: `${binary} store path printed nothing` };
		const before = dirBytes(store);
		execFileSync(binary, ["store", "prune"], { encoding: "utf8", timeout: 600_000, stdio: ["ignore", "pipe", "pipe"] });
		const freed = Math.max(0, before - dirBytes(store));
		return { ok: true, detail: `${store}: ${bytesLabel(freed)} freed`, freedBytes: freed };
	} catch (error) {
		return { ok: false, detail: (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "pnpm failed" };
	}
}

/** How long an archive stays before the expiry rule may touch it (spec §6 line 1). */
export const ARCHIVE_EXPIRY_MS = 30 * 24 * HOUR_MS;

/** One archive folder past 30 days, with the fact that decides whether it may go. */
export interface ArchiveExpiry {
	dir: string;
	repo: string;
	ref: string;
	/** The base branch the ref is checked against. */
	baseRef: string;
	diffEmpty: boolean;
	expires: boolean;
	reason: string;
}

/**
 * Spec §6 line 1: an archive past 30 days expires only when its `refs/archive/wt` ref is an ancestor of the
 * base branch or its diff is empty. Everything else stays and is listed. A non-empty `untracked.tgz` also
 * keeps it: those files are in no ref, so the folder is their only copy.
 */
export function planArchiveExpiry(root: string, now: number): ArchiveExpiry[] {
	let dates: string[];
	try {
		dates = readdirSync(root).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name) && now - Date.parse(`${name}T00:00:00Z`) > ARCHIVE_EXPIRY_MS);
	} catch {
		return [];
	}
	const found: ArchiveExpiry[] = [];
	for (const date of dates) {
		let names: string[];
		try {
			names = readdirSync(join(root, date), { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name);
		} catch {
			continue;
		}
		for (const name of names) {
			const dir = join(root, date, name);
			let manifest: Record<string, unknown> | undefined;
			try {
				const parsed: unknown = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
				manifest = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
			} catch {
				manifest = undefined;
			}
			if (manifest === undefined) {
				found.push({ dir, repo: "", ref: "", baseRef: "", diffEmpty: false, expires: false, reason: "no manifest, so nothing proves what it holds" });
				continue;
			}
			const repo = typeof manifest["repo"] === "string" ? manifest["repo"] : "";
			const ref = typeof manifest["ref"] === "string" ? manifest["ref"] : "";
			const baseRef = typeof manifest["baseRef"] === "string" ? manifest["baseRef"] : "";
			let diffEmpty = true;
			try {
				diffEmpty = readFileSync(join(dir, "diff.patch"), "utf8").trim() === "";
			} catch {
				diffEmpty = true;
			}
			let untracked = false;
			try {
				untracked = statSync(join(dir, "untracked.tgz")).size > 0;
			} catch {
				untracked = false;
			}
			const entry: ArchiveExpiry = { dir, repo, ref, baseRef, diffEmpty, expires: false, reason: "" };
			if (untracked) found.push({ ...entry, reason: "its untracked archive is in no ref, so this folder is the only copy" });
			else if (diffEmpty) found.push({ ...entry, expires: true, reason: "the diff is empty" });
			else if (baseRef === "" || ref === "") found.push({ ...entry, reason: "no base branch or no ref to check" });
			else if (isAncestor(repo, ref, `refs/remotes/${baseRef}`) === true) found.push({ ...entry, expires: true, reason: `its ref is in ${baseRef}` });
			else found.push({ ...entry, reason: `its diff is not in ${baseRef}` });
		}
	}
	return found;
}

/** The write half of the expiry rule: remove the folders the plan named, one failure per folder. */
export function expireArchives(dirs: readonly string[]): { expired: string[]; failed: Array<{ dir: string; error: string }> } {
	const expired: string[] = [];
	const failed: Array<{ dir: string; error: string }> = [];
	for (const dir of dirs) {
		try {
			rmSync(dir, { recursive: true, force: false });
			expired.push(dir);
		} catch (error) {
			failed.push({ dir, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { expired, failed };
}

/** Everything one pass plans, from reads only. */
export interface CleanupContext {
	findings: readonly WorktreeFinding[];
	/** Every catalogue repository's main checkout and every linked worktree: the PRUNE2 guard's search space. */
	others: readonly string[];
	records: readonly LaneRecord[];
	usage: WorktreeUsage;
	now: number;
	date: string;
	/** The Claude jobs directory, or undefined when the pass must not look at one. */
	jobsDir?: string;
	/** The state directory: the rule switch's, the bus's records and the repair log live there. */
	stateDir: string;
	/** The pnpm binary the weekly store prune would use, by absolute path, when the rule has one. */
	pnpmBinary?: string;
	/** Where the day's archives go, and where a payload over the cap goes. */
	archiveRoot: string;
	largeRoot: string;
	/** The payload cap; `ARCHIVE_MAX_BYTES` unless a test says otherwise. */
	maxBytes?: number;
	/** The images docker holds, as rule (d) reads them. */
	docker: readonly DockerImage[];
	/** The doctor's contracts, and the last attempt on each repaired contract (rule g). */
	doctor: readonly DoctorContract[];
	repairLog: Readonly<Record<string, number>>;
}

export function planCleanup(ctx: CleanupContext): CleanupPlan {
	const roots: ArchiveRoots = { root: ctx.archiveRoot, largeRoot: ctx.largeRoot, ...(ctx.maxBytes === undefined ? {} : { maxBytes: ctx.maxBytes }) };
	const { archives, largeArchives, kept } = planArchives(ctx.findings, ctx.records, ctx.usage, ctx.others, roots, ctx.date);
	const docker = planDockerPrune(ctx.docker, ctx.now);
	return {
		archives,
		largeArchives,
		kept,
		jobDirs: ctx.jobsDir === undefined ? [] : planJobTempCleanup(ctx.jobsDir, ctx.stateDir, ctx.now),
		caches: planBuildCaches(ctx.findings, ctx.usage, ctx.records, ctx.now),
		dockerImages: docker.remove,
		dockerSkipped: docker.skipped,
		commands: planWeeklyCommands(),
		...(ctx.pnpmBinary === undefined ? {} : { pnpm: { command: `${ctx.pnpmBinary} store prune`, why: "store entries no lockfile references, refilled from the registry; the freed bytes are measured" } }),
		doctorRepairs: planDoctorRepairs(ctx.doctor, ctx.repairLog, ctx.now),
		...((): { expiringArchives: ArchiveExpiry[]; keptArchives: ArchiveExpiry[] } => {
			const archives = planArchiveExpiry(ctx.archiveRoot, ctx.now);
			return { expiringArchives: archives.filter((entry) => entry.expires), keptArchives: archives.filter((entry) => !entry.expires) };
		})(),
	};
}

/** What one applied pass did: the same shapes as the plan, with outcomes. */
export interface CleanupApplied {
	archived: ArchiveTarget[];
	archiveFailures: Array<{ target: ArchiveTarget; error: string }>;
	/** Rule (a): payloads copied to `/mnt/e/archive` with a checksum; their worktrees stay. */
	largeArchived: LargeArchive[];
	emptiedJobDirs: string[];
	removedCaches: string[];
	/** Rule (d): the images actually removed. */
	removedImages: string[];
	/** Rule (pnpm): the weekly store prune, with the bytes it freed. */
	pnpmPrune?: { ok: boolean; detail: string; freedBytes?: number };
	/** Rule (g): the declared repairs tried, with their outcome. */
	repairs: Array<{ contractId: string; detail: string; ok: boolean }>;
	/** Spec §6 line 1: the archive folders removed, and the ones that could not be. */
	expiredArchives: string[];
	expiryFailures: Array<{ dir: string; error: string }>;
}

/** Every file below `path` git does not track, split into the ones it ignores and the ones it does not. */
function untrackedFiles(path: string): { untracked: string[]; ignored: string[] } {
	const lines = (out: string | undefined) => (out ?? "").split("\n").filter((line) => line !== "");
	return { untracked: lines(git(path, ["ls-files", "--others", "--exclude-standard"])), ignored: lines(git(path, ["ls-files", "--others", "--ignored", "--exclude-standard"])) };
}

/**
 * Everything git does not track, as `untracked.tgz` beside the diff: one tarball is the archive of the files,
 * and a folder with no untracked files has none. Nothing is silently dropped (the list comes from git).
 */
function writeUntrackedTarball(worktree: string, files: readonly string[], target: string): void {
	if (files.length === 0) return;
	const done = spawnSync("tar", ["-czf", target, "-C", worktree, "--files-from", "-"], { input: `${files.join("\n")}\n`, encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
	if (done.status !== 0) throw new Error(`tar failed: ${(done.stderr ?? "").split("\n")[0] ?? String(done.error)}`);
}

/**
 * The one removal path (S3-F1, S3-F7): the archive is written first (the manifest line, the tracked diff, the
 * untracked and ignored files minus the excluded ones, and the `refs/archive/wt/<name>` ref), and only then is the
 * worktree removed, never with `--force`. A removal git refuses leaves the line in the manifest plus a `# kept`
 * correction beside it, so a reader never takes a worktree that is still there for one that went.
 */
export function archiveWorktrees(targets: readonly ArchiveTarget[], manifest: string, date: string): { archived: ArchiveTarget[]; failed: Array<{ target: ArchiveTarget; error: string }> } {
	const archived: ArchiveTarget[] = [];
	const failed: Array<{ target: ArchiveTarget; error: string }> = [];
	const touched = new Set<string>();
	for (const target of targets) {
		const fail = (error: string) => failed.push({ target, error });
		try {
			const { finding } = target;
			const repo = finding.repo;
			const baseRef = BASE_REFS.find((ref) => git(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/${ref}`]) !== undefined);
			if (baseRef === undefined) {
				fail("no origin/dev or origin/main ref to diff against");
				continue;
			}
			const base = git(finding.path, ["merge-base", `refs/remotes/${baseRef}`, "HEAD"])?.trim();
			if (base === undefined || base === "") {
				fail(`no merge base with ${baseRef}`);
				continue;
			}
			const diff = git(finding.path, ["diff", "--binary", `${base}..HEAD`]);
			if (diff === undefined) {
				fail("git diff of the branch failed");
				continue;
			}
			const payload = archivePayload(finding.path);
			mkdirSync(target.dir, { recursive: true });
			writeFileSync(join(target.dir, "diff.patch"), diff);
			writeUntrackedTarball(finding.path, payload.files, join(target.dir, "untracked.tgz"));
			const ref = git(repo, ["update-ref", target.ref, finding.sha]) === undefined ? undefined : target.ref;
			if (ref === undefined) {
				fail(`could not write ${target.ref}`);
				continue;
			}
			writeFileSync(
				join(target.dir, "manifest.json"),
				`${JSON.stringify(
					{
						date,
						repo,
						path: finding.path,
						branch: finding.branch,
						sha: finding.sha,
						laneId: target.laneId ?? null,
						base: `${baseRef}@${base}`,
						baseRef,
						ref: target.ref,
						diff: "diff.patch",
						untracked: payload.files.length === 0 ? undefined : "untracked.tgz",
						files: payload.files,
						// Named, never copied: a cache tree a build regenerates, and a `.env*` file that holds secrets (S3-F4).
						excluded: payload.excluded,
						restore: `git -C ${repo} worktree add ${finding.path} ${finding.branch ?? finding.sha}`,
					},
					null,
					"\t",
				)}\n`,
			);
			if (!existsSync(join(target.dir, "diff.patch")) || !existsSync(join(target.dir, "manifest.json"))) {
				fail("the archive is not on disk, so the worktree stays");
				continue;
			}
			// The restore index is written before the removal it describes, so a kill inside the unit's timeout cannot
			// lose it (S3-F7).
			appendManifest(manifest, date, finding);
			try {
				execFileSync("git", ["-C", repo, "worktree", "remove", finding.path], { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
			} catch (error) {
				const detail = (error instanceof Error ? error.message : String(error)).split("\n").find((line) => line.trim() !== "") ?? "git worktree remove failed";
				appendKeptLine(manifest, date, finding, detail);
				fail(detail);
				continue;
			}
			archived.push(target);
			touched.add(repo);
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error));
		}
	}
	for (const repo of touched) git(repo, ["worktree", "prune"]);
	return { archived, failed };
}

/** Rule (b), the write half: empty a finished job's folder, and keep the folder. */
export function emptyJobDirs(dirs: readonly string[]): { emptied: string[]; failed: Array<{ dir: string; error: string }> } {
	const emptied: string[] = [];
	const failed: Array<{ dir: string; error: string }> = [];
	for (const dir of dirs) {
		try {
			for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { recursive: true, force: false });
			emptied.push(dir);
		} catch (error) {
			failed.push({ dir, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { emptied, failed };
}

/** Rule (c), the write half: delete the cache directories a plan names. */
export function removeCaches(dirs: readonly string[]): { removed: string[]; failed: Array<{ dir: string; error: string }> } {
	const removed: string[] = [];
	const failed: Array<{ dir: string; error: string }> = [];
	for (const dir of dirs) {
		try {
			rmSync(dir, { recursive: true, force: false });
			removed.push(dir);
		} catch (error) {
			failed.push({ dir, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { removed, failed };
}

// ─── docker images (rule d) ──────────────────────────────────────────────────

/**
 * Rule (d): the images the weekly pass may remove. One is removable only when `docker image inspect` gave it at
 * least one `RepoDigests` entry (so the registry can serve it again) and no container names it (S3-F9). A locally
 * built image has no digest and cannot be pulled again, so it is kept. Ids are deduplicated, because one image with
 * several tags is one image. Volumes are never touched at all.
 */
/** What rule (d) would remove, and what it leaves with the fact that leaves it. */
export interface DockerPlan {
	remove: DockerImage[];
	/** Images a pass would leave, each with the reason the report gives. */
	skipped: Array<{ image: DockerImage; reason: "local-build" | "in-use"; why: string }>;
}

/** The registry digests an image can be pulled again from: `RepoDigests` without the empty and `<none>` entries. */
export function pullableDigests(image: DockerImage): string[] {
	return image.repoDigests.map((digest) => digest.trim()).filter((digest) => digest !== "" && digest !== "<none>");
}

export function planDockerPrune(images: readonly DockerImage[], now: number): DockerPlan {
	const remove: DockerImage[] = [];
	const skipped: DockerPlan["skipped"] = [];
	const seen = new Set<string>();
	for (const image of images) {
		if (seen.has(image.id)) continue; // one image with several tags is one image, so one removal line
		seen.add(image.id);
		if (now - image.createdMs <= DOCKER_IMAGE_MIN_AGE_MS) continue; // not due yet, so neither removed nor skipped
		if (pullableDigests(image).length === 0) skipped.push({ image, reason: "local-build", why: "built locally, with no registry digest, so it could not be pulled again" });
		else if (image.containers > 0) skipped.push({ image, reason: "in-use", why: `a container names it (${image.containers})` });
		else remove.push(image);
	}
	return { remove, skipped };
}

// ─── doctor repairs (rule g) ─────────────────────────────────────────────────

/**
 * Rule (g): the repairs the janitor declares, keyed by what the doctor's contract is. Nothing else is ever
 * run for a red contract, and nothing the doctor reports is passed to a command: a timer contract's id is a
 * unit name and is the only word that reaches `systemctl`.
 */
export function declaredRepair(row: DoctorContract): DoctorRepair | undefined {
	if (row.ok || row.kind !== "timer" || !TIMER_CONTRACT_ID.test(row.id)) return undefined;
	return {
		contractId: row.id,
		command: ["systemctl", "--user", "restart", row.id],
		why: "a timer contract's proof is stale, and one restart is the bounded repair that makes a fresh proof possible",
		timeoutMs: DOCTOR_REPAIR_TIMEOUT_MS,
	};
}

/** Rule (g): at most one declared repair per red contract a day; a red contract with none is a report line. */
export function planDoctorRepairs(rows: readonly DoctorContract[], log: Readonly<Record<string, number>>, now: number): DoctorRepairPlan {
	const repairs: DoctorRepair[] = [];
	const unrepairable: DoctorContract[] = [];
	const recently: string[] = [];
	const today: string[] = [];
	const date = localDate(now);
	for (const row of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
		if (row.ok) continue;
		const last = log[row.id];
		if (last !== undefined && now - last < DOCTOR_REPAIR_WINDOW_MS) {
			recently.push(row.id);
			continue;
		}
		if (last !== undefined && localDate(last) === date) {
			today.push(row.id);
			continue;
		}
		const repair = declaredRepair(row);
		if (repair === undefined) unrepairable.push(row);
		else repairs.push(repair);
	}
	return { repairs, unrepairable, repairedRecently: recently, repairedToday: today };
}

/** Rule (g): the file that holds the day each contract was last repaired, one owner, in the janitor's state. */
export function repairLogPath(stateDir: string): string {
	return join(stateDir, "janitor-repairs.json");
}

/** The repair log: contract id to the epoch ms of its last attempt. A date string is read as that day's start. */
export function readRepairLog(stateDir: string): Record<string, number> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(repairLogPath(stateDir), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return {};
		const log: Record<string, number> = {};
		for (const [contractId, value] of Object.entries(parsed as Record<string, unknown>)) {
			const at = typeof value === "number" ? value : typeof value === "string" ? Date.parse(`${value}T00:00:00`) : Number.NaN;
			if (Number.isFinite(at)) log[contractId] = at;
		}
		return log;
	} catch {
		return {};
	}
}

export function writeRepairLog(stateDir: string, log: Readonly<Record<string, number>>): void {
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(repairLogPath(stateDir), `${JSON.stringify(log, null, "\t")}\n`);
}

// ─── ended lanes ─────────────────────────────────────────────────────────────

/** How a lane's cwd reads for the close rule: `none` when nothing there could hold uncommitted work. */
type WorktreeState = "clean" | "dirty" | "none" | "unknown";

/**
 * The worktree a lane's cwd holds: `none` for no cwd, a cwd that is gone, or a directory that is not a
 * work tree at all (no branch, so no uncommitted work), `unknown` when git could not answer.
 */
function worktreeState(cwd: string | null): WorktreeState {
	if (cwd === null || !existsSync(cwd)) return "none";
	const inside = git(cwd, ["rev-parse", "--is-inside-work-tree"])?.trim();
	if (inside === undefined) return "unknown";
	if (inside !== "true") return "none";
	const status = git(cwd, ["status", "--porcelain"]);
	return status === undefined ? "unknown" : status.trim() === "" ? "clean" : "dirty";
}

/** The base ref `sha` is in, read from `cwd`: null when none, undefined when git could not tell. */
function baseRefOf(cwd: string, sha: string): string | null | undefined {
	let unknown = false;
	for (const ref of BASE_REFS) {
		const ancestor = isAncestor(cwd, sha, ref);
		if (ancestor === true) return ref;
		if (ancestor === undefined) unknown = true;
	}
	return unknown ? undefined : null;
}

export interface EndedLane {
	/** The row that was closed, so the report can name it with the facts the decision used. */
	row: LaneCard;
	reason: string;
}

/**
 * The ended lanes this pass may close (Grokbot's 2026-10-17 housekeeping ask, under the standing cleanup
 * rule): a Claude lane whose process is gone, which no automation owns, and whose end is a verified fact —
 * the commit it last reported is in a base ref, or it has been silent for more than a day with a clean
 * worktree or no worktree left. A Claude lane is launched by hand, so no launcher wrote it a lane record:
 * the tick (`decideLifecycle`) reads records and never acts on one, which is the gap this closes.
 *
 * Never closed: a lane somebody answered for — the operator's own, the orchestrator's, a seat holder's, a
 * conversation (the one `sessionUntouchable` predicate) — a row the lifecycle already holds a record for,
 * a lane whose process may still be up, a cwd a live process still holds (something is working there, and
 * the same fact keeps a worktree), a worktree with uncommitted changes, a fact git cannot answer, and a
 * lane too recently silent to be sure of. `row.lastReport` is only on card rows, so most Claude rows end
 * through the silence rule.
 */
export function endedLanes(rows: readonly LaneCard[], records: readonly LaneRecord[], stateDir: string, now: number, processCwds: readonly string[] = []): EndedLane[] {
	const recorded = new Set(records.map((record) => record.laneId));
	const held = processCwds.map(real);
	const ended: EndedLane[] = [];
	for (const row of [...rows].sort((a, b) => a.laneId.localeCompare(b.laneId))) {
		if (row.harness !== "claude" || row.alive !== false) continue;
		if (recorded.has(row.laneId)) continue;
		if (row.cwd !== null && held.some((cwd) => isInside(real(row.cwd!), cwd))) continue;
		if (sessionUntouchable({ stateDir, laneId: row.laneId, ...(row.origin !== undefined ? { registryRow: { origin: row.origin } } : {}) }) !== undefined) continue;
		const sha = row.lastReport?.sha;
		const merged = row.cwd !== null && sha !== undefined ? baseRefOf(row.cwd, sha) : undefined;
		if (row.cwd !== null && sha !== undefined && typeof merged === "string") {
			ended.push({ row, reason: `process gone, reported ${sha.slice(0, 7)} is in ${merged}` });
			continue;
		}
		// A lane with nothing said about it and no report has only its silence: a card's last heartbeat, the
		// turn it stopped writing, or when it appeared. One that never had any is kept.
		const quietSince = row.lastTurnAt ?? row.lastActivityMs ?? row.since ?? row.updatedAt ?? null;
		if (quietSince === null || now - quietSince <= ENDED_LANE_IDLE_MS) continue;
		const worktree = worktreeState(row.cwd);
		if (worktree === "dirty" || worktree === "unknown") continue;
		const days = Math.max(1, Math.round((now - quietSince) / (24 * HOUR_MS)));
		ended.push({ row, reason: `process gone for about ${days} d, ${worktree === "clean" ? "worktree clean" : "no worktree left"}` });
	}
	return ended;
}

// ─── Concord ─────────────────────────────────────────────────────────────────

export interface ConcordPlan {
	dbFile: string;
	disconnect: Array<{ endpointId: string; agentId: string; lastSeen: string }>;
	deactivate: Array<{ agentId: string; lastSeen: string }>;
}

/**
 * What the cleanup would do to one Concord database, read-only. An endpoint connected but not seen
 * for more than 24 h is disconnected. An agent is deactivated when it has endpoints, none of them
 * connected once those are disconnected, it is `active`, was not seen for more than 24 h and its
 * pid is gone. An agent that never had an endpoint (the operator's own sessions, the orchestrator) is not touched.
 */
export function planConcordCleanup(dbFile: string, now: number, pidAlive: (pid: number) => boolean = procPidAlive): ConcordPlan {
	const plan: ConcordPlan = { dbFile, disconnect: [], deactivate: [] };
	const cutoff = now - CLEANUP_AFTER_MS;
	const older = (iso: string): boolean => Date.parse(iso) < cutoff;
	const db = new DatabaseSync(dbFile, { readOnly: true });
	try {
		const endpoints = db.prepare("SELECT endpoint_id, agent_id, status, last_seen FROM agent_endpoints").all() as Array<{ endpoint_id: string; agent_id: string; status: string; last_seen: string }>;
		const agents = db.prepare("SELECT agent_id, status, pid, last_seen FROM agents").all() as Array<{ agent_id: string; status: string; pid: number | null; last_seen: string }>;
		const stale = new Set<string>();
		for (const endpoint of endpoints) {
			if (endpoint.status === "connected" && older(endpoint.last_seen)) {
				plan.disconnect.push({ endpointId: endpoint.endpoint_id, agentId: endpoint.agent_id, lastSeen: endpoint.last_seen });
				stale.add(endpoint.endpoint_id);
			}
		}
		for (const agent of agents) {
			const own = endpoints.filter((endpoint) => endpoint.agent_id === agent.agent_id);
			if (own.length === 0 || agent.status !== "active" || !older(agent.last_seen)) continue;
			if (own.some((endpoint) => endpoint.status === "connected" && !stale.has(endpoint.endpoint_id))) continue;
			if (agent.pid !== null && pidAlive(agent.pid)) continue;
			plan.deactivate.push({ agentId: agent.agent_id, lastSeen: agent.last_seen });
		}
	} finally {
		db.close();
	}
	return plan;
}

/** Apply a plan through the lifecycle's one Concord cleanup helper. */
export async function applyConcordCleanup(plan: ConcordPlan): Promise<void> {
	if (plan.disconnect.length === 0 && plan.deactivate.length === 0) return;
	const repos = await openConcordRepositories(plan.dbFile);
	try {
		deactivateConcordAgents(repos, plan.disconnect.map((endpoint) => endpoint.endpointId), plan.deactivate.map((agent) => agent.agentId));
	} finally {
		repos.db.close();
	}
}

// ─── ports ───────────────────────────────────────────────────────────────────

export interface JanitorPorts {
	now(): number;
	/** Repository roots of the project catalogue. */
	repos(): string[];
	/** Concord database files of the project catalogue that exist. */
	concordDbs(): string[];
	lanes(): LaneCard[];
	processCwds(): string[];
	/** AK12: the unit directory whose `.service` files can name a worktree. */
	unitDir(): string;
	failedUnits(): string;
	memory(): { free: string; pressure: string };
	/** WP11: the repository's code graph state, through scripts/graph-refresh.sh --status. */
	graphStatus(repo: string): GraphStatus | undefined;
	/** WP11: one code-only graph refresh, waited for. Throws when it fails. */
	graphRefresh(repo: string): void;
	tellHenry(text: string): void;
	/** AK11: hand one message for the orchestrator to the bus (`muster send`), which owns delivery. */
	sendToOrchestrator(text: string): void;
	/**
	 * LC-D9: one consistent copy of the ledger, or undefined when `backend.json` does not
	 * name the ledger yet (there is nothing to back up before the flip). Optional so a
	 * unit test that has no ledger can leave it out.
	 */
	ledgerBackup?(): { path: string; bytes: number } | undefined;
	/**
	 * The net under `closeLane` (2026-10-18): stop every active systemd scope a lane registered whose record
	 * says the lane runs nothing, by the unit's exact name. A dry run leaves it out. Optional so a test with
	 * no systemd can leave it out.
	 */
	stopIdleHelperScopes?(): Promise<StoppedHelperScope[]>;
	/**
	 * The orphaned Claude Code shells this pass would stop (2026-10-18): a finished job's snapshot shell, parentless
	 * and older than an hour. A read, so a dry run lists them too. Optional so a test with a fake machine can leave it out.
	 */
	orphanClaudeShells?(): OrphanClaudeShell[];
	/** Stop those shells, by exact pid. A dry run leaves it out. */
	stopOrphanClaudeShells?(shells: readonly OrphanClaudeShell[]): Promise<StoppedOrphanShell[]>;
	/**
	 * Close one ended lane exactly as `muster close <lane> --abandoned "<reason>"` does, through
	 * `closeLane`, after giving the row the lane record no launcher wrote it. One lane per call.
	 */
	close(lane: LaneCard, reason: string): Promise<{ ok: boolean; detail: string }>;
	/** Rule (b): the Claude jobs directory. Optional, so a test with a fake machine reads no live job. */
	jobsDir?(): string;
	/** Rule (a): where an archived worktree is written. Optional; it defaults to `ARCHIVE_ROOT`. */
	archiveRoot?(): string;
	/** Rule (d): the images docker holds, each as `docker image inspect` describes it. A read, so a plan lists them too. */
	dockerImages?(): DockerImage[];
	/** Rule (d): remove those images, one exact id at a time. A plan leaves it out. */
	dockerRemove?(ids: readonly string[]): { removed: string[]; failed: Array<{ id: string; error: string }> };
	/** Rule (a): where a payload over the cap is archived. Optional; it defaults to `LARGE_ARCHIVE_ROOT`. */
	largeArchiveRoot?(): string;
	/** Rule (a): the payload cap. Optional; it defaults to `ARCHIVE_MAX_BYTES`. */
	archiveMaxBytes?(): number;
	/** Rule (g): the doctor's contract table. A read, so a plan lists the repairs it would run. */
	doctorContracts?(): DoctorContract[];
	/** Rule (g): run one declared repair argv with its timeout. A plan leaves it out. */
	runRepair?(command: readonly string[], timeoutMs: number): { ok: boolean; detail: string };
	/** Rule (pnpm): the pnpm binary by absolute path, or undefined when this machine has none. */
	pnpmBinary?(): string | undefined;
	/** Rule (pnpm): run the store prune for that binary and report the bytes it freed. A plan leaves it out. */
	pnpmStorePrune?(binary: string): { ok: boolean; detail: string; freedBytes?: number };
}

export interface JanitorOptions {
	dryRun: boolean;
	/**
	 * Spec §6 line 1: the rules `state/muster/janitor-apply` names. A rule this set does not hold is planned and
	 * reported and does nothing, so an empty set (the default) is a plan-only pass and one removed line is a
	 * rule's rollback.
	 */
	appliedRules: ReadonlySet<JanitorRule>;
	stateDir: string;
	/** `plans/muster-autonomy/janitor` */
	outDir: string;
	/** The path Henry passes to `plans_read root=pi-plans`, ending in the report file name. */
	plansPath: (reportName: string) => string;
}

/**
 * What the janitor states a hand-launched lane delivers (R1, VR24-172). A new lane needs a title, and a
 * Claude lane started by hand has no record and nobody to ask, so the janitor says the one true thing it
 * knows, cut to the 80 characters `validateLaneTitle` accepts.
 */
export function janitorAdoptTitle(laneId: string): string {
	return `${laneId}: launched by hand, closed by the janitor`.slice(0, 80);
}

export function liveJanitorPorts(stateDir: string = musterStateDir()): JanitorPorts {
	const catalogue = () => readProjectCatalogue(projectCataloguePath());
	return {
		now: () => Date.now(),
		repos: () => catalogueRepoRoots(catalogue()),
		concordDbs: () => [...new Set(catalogue().projects.flatMap((project) => project.programmes.map((programme) => concordDbPath(normalizePrimaryRoot(programme.repoKey)))))].filter((file) => existsSync(file)),
		lanes: () => enumerateLanes(),
		processCwds() {
			const cwds: string[] = [];
			for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
				try {
					cwds.push(readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, ""));
				} catch {
					// another user's process, or one that just ended
				}
			}
			return cwds;
		},
		unitDir: () => USER_UNIT_DIR,
		failedUnits: () => run("systemctl", ["--user", "--failed", "--no-legend", "--plain"]),
		memory: () => ({ free: run("free", ["-m"]), pressure: readText("/proc/pressure/memory") }),
		graphStatus: (repo) => graphStatus(repo),
		graphRefresh: (repo) => refreshGraph(repo),
		jobsDir: () => join(process.env["CLAUDE_CONFIG_DIR"]?.trim() || join(homedir(), ".claude"), "jobs"),
		archiveRoot: () => ARCHIVE_ROOT,
		// A link ending in " (deleted)" is a process whose working folder is gone; its path is the folder it had.
		// Rule (pnpm) and (f): the store prune runs by absolute path when its rule is on (S3-F10); fstrim is only named.
		pnpmBinary: () => findPnpm(),
		pnpmStorePrune: (binary) => runPnpmStorePrune(binary),
		// Each image is judged by `docker image inspect`'s own `RepoDigests`, and by the containers that name it, so the
		// two facts the rule needs are the fields docker itself reports (S3-F9). A register that cannot be read is a
		// missing image, never a removable one.
		dockerImages() {
			const ids = [
				...new Set(
					run("docker", ["image", "ls", "-a", "--no-trunc", "--format", "{{.ID}}"])
						.split("\n")
						.map((line) => line.trim())
						.filter((line) => line !== "" && !line.startsWith("(")),
				),
			];
			return ids.flatMap((id) => {
				const inspected = run("docker", ["image", "inspect", id]);
				if (!inspected.startsWith("[")) return [];
				let row: Record<string, unknown>;
				try {
					row = ((JSON.parse(inspected) as Array<Record<string, unknown>>)[0] ?? {}) as Record<string, unknown>;
				} catch {
					return [];
				}
				const imageId = typeof row["Id"] === "string" ? row["Id"] : id;
				const created = typeof row["Created"] === "string" ? Date.parse(row["Created"]) : Number.NaN;
				if (!Number.isFinite(created)) return [];
				const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
				const tags = strings(row["RepoTags"]);
				const reference = tags[0] ?? "<none>";
				const cut = reference.lastIndexOf(":");
				const containers = run("docker", ["ps", "-a", "--filter", `ancestor=${imageId}`, "--format", "{{.ID}}"])
					.split("\n")
					.filter((line) => line.trim() !== "" && !line.startsWith("(")).length;
				return [
					{
						id: imageId,
						repository: cut > 0 ? reference.slice(0, cut) : reference,
						tag: cut > 0 ? reference.slice(cut + 1) : "<none>",
						createdMs: created,
						repoDigests: strings(row["RepoDigests"]),
						containers,
					},
				];
			});
		},
		dockerRemove(ids) {
			const removed: string[] = [];
			const failed: Array<{ id: string; error: string }> = [];
			for (const id of ids) {
				try {
					execFileSync("docker", ["image", "rm", id], { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
					removed.push(id);
				} catch (error) {
					failed.push({ id, error: (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "docker image rm failed" });
				}
			}
			return { removed, failed };
		},
		largeArchiveRoot: () => LARGE_ARCHIVE_ROOT,
		archiveMaxBytes: () => ARCHIVE_MAX_BYTES,
		// OL0's contract table, read from the doctor's own result file. The doctor stays read-only.
		doctorContracts() {
			try {
				const parsed: unknown = JSON.parse(readFileSync(join(piAgentDir(), "health", "doctor-result.json"), "utf8"));
				const rows = (parsed as { checks?: { contracts?: { rows?: unknown } } }).checks?.contracts?.rows;
				if (!Array.isArray(rows)) return [];
				return rows.flatMap((row) => {
					const entry = row as { kind?: unknown; id?: unknown; ok?: unknown };
					return typeof entry.id === "string" && typeof entry.kind === "string" && typeof entry.ok === "boolean" ? [{ kind: entry.kind, id: entry.id, ok: entry.ok }] : [];
				});
			} catch {
				return [];
			}
		},
		runRepair(command, timeoutMs) {
			const [program, ...args] = command;
			if (program === undefined) return { ok: false, detail: "no command" };
			try {
				execFileSync(program, args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
				return { ok: true, detail: "ran" };
			} catch (error) {
				return { ok: false, detail: (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "failed" };
			}
		},
		stopIdleHelperScopes: () => stopIdleHelperScopes(stateDir),
		orphanClaudeShells: () => findOrphanClaudeShells(stateDir),
		stopOrphanClaudeShells: (shells) => stopOrphanClaudeShells(shells),
		tellHenry(text) {
			tellGrokbot(stateDir, JANITOR_SENDER, text, `janitor-${new Date().toISOString().slice(0, 10)}`);
		},
		// A Claude lane is launched by hand, so no launcher wrote it a record: the tick reads records,
		// so it never acts on one, and `closeLane` would have no record to write the terminal outcome
		// into. Recording the launch first (the launch owner) and closing right after is the same path a
		// Pi lane's record takes, and it is what the archive step then picks up a day later.
		async close(lane, reason) {
			if (readLaneRecord(stateDir, lane.laneId) === undefined) {
				recordLaunch(stateDir, { laneId: lane.laneId, harness: lane.harness, cwd: lane.cwd, branch: lane.branch, title: janitorAdoptTitle(lane.laneId), launchedBy: JANITOR_SENDER, ...(lane.sessionId !== undefined ? { sessionId: lane.sessionId } : {}) });
			}
			const closed = await closeLaneLive(stateDir, lane.laneId, { park: false, terminal: { outcome: "abandoned", reason }, caller: JANITOR_SENDER }, process.env);
			return { ok: closed.ok, detail: closed.detail };
		},
		// AK11: the bus is the one path to a lane's inbox, so the janitor runs `muster send` for the
		// orchestrator rather than writing that inbox itself. `--no-verify` returns as soon as the bus has
		// taken the message instead of waiting for a session to read it.
		sendToOrchestrator(text) {
			const result = spawnSync(musterLauncher(), ["--agent", JANITOR_SENDER, "send", ORCHESTRATOR_ADDRESS, text, "--no-verify"], { encoding: "utf8", timeout: 60_000 });
			if (result.status === 0) return;
			const detail = `${result.error?.message ?? ""}${result.stderr ?? ""}`.trim().split("\n")[0] ?? "";
			throw new Error(`muster send exited ${result.status ?? "without a status"}${detail === "" ? "" : `: ${detail}`}`);
		},
		// LC-D9: the daily ledger backup, through the flip tool's own backup (VACUUM INTO from a
		// second read connection). The switch decides: before the flip there is no ledger to copy.
		ledgerBackup: () => (readBackend(stateDir) !== "ledger" ? undefined : backupLedger({ stateDir, ledgerDir: ledgerDirFor(stateDir, process.env), now: Date.now() })),
	};
}

function run(command: string, args: string[]): string {
	try {
		return execFileSync(command, args, { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
	} catch (error) {
		return `(${command} failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)})`;
	}
}

function readText(file: string): string {
	try {
		return readFileSync(file, "utf8").trim();
	} catch {
		return `(${file} unreadable)`;
	}
}

// ─── code graphs ─────────────────────────────────────────────────────────────

interface GraphReading {
	repo: string;
	status: GraphStatus | undefined;
	refreshed?: boolean;
	failure?: string;
}

/** One report line for a graph: age, the commit it was built at, and what this pass did to it. */
function describeGraph(reading: GraphReading, now: number, dryRun: boolean): string {
	const { status } = reading;
	const state = status === undefined ? "state unreadable" : !status.exists ? "no graph yet" : `${status.refreshedAt === undefined ? "age unknown" : `${age(status.refreshedAt, now)} old`}${status.sha ? `, built at ${status.sha.slice(0, 7)}` : ""}${status.stale ? ", behind origin/dev or origin/main" : ""}`;
	if (reading.failure !== undefined) return `${state}; refresh failed (${reading.failure})`;
	return `${state}${dryRun ? "; dry run, would refresh" : reading.refreshed ? "; refreshed tonight" : ""}`;
}

// ─── the pass ────────────────────────────────────────────────────────────────

export interface JanitorResult {
	date: string;
	reportName: string;
	report: string;
	removed: WorktreeFinding[];
	removalFailures: RemovalResult["failed"];
	weekly: WorktreeFinding[];
	concord: ConcordPlan[];
	/** The ended Claude lanes this pass closed; in a dry run, the ones it would close. */
	closed: EndedLane[];
	archived: string[];
	/** VR24-220: what this pass planned under the OL1 cleanup rules, deleted only when it was asked to apply. */
	cleanup: CleanupPlan;
	/** What an applying pass did; absent on a plan-only pass. */
	cleanupApplied?: CleanupApplied;
	/** LC-D9: the copy this pass wrote, when the backend names the ledger. */
	ledgerBackup?: { path: string; bytes: number };
	needsOperator: string[];
	summary: string;
}

/** Local calendar date, `YYYY-MM-DD`: the day the operator reads the report on. */
export function localDate(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function age(ms: number, now: number): string {
	const hours = Math.max(0, now - ms) / HOUR_MS;
	return hours < 1 ? `${Math.round(hours * 60)} min` : hours < 48 ? `${Math.round(hours)} h` : `${Math.round(hours / 24)} d`;
}

function closedAt(record: LaneRecord): number {
	return record.terminal?.closedAt ?? record.phaseSince;
}

export async function runJanitor(options: JanitorOptions, ports: JanitorPorts): Promise<JanitorResult> {
	const now = ports.now();
	const date = localDate(now);
	const reportName = `janitor-${date}.md`;
	const manifest = join(options.outDir, `worktree-removal-${date}.txt`);
	const problems: string[] = [];
	const guard = <T,>(label: string, fallback: T, fn: () => T): T => {
		try {
			return fn();
		} catch (error) {
			problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
			return fallback;
		}
	};

	// 1. Worktrees, and the ended-lane decision the worktree step must not invalidate.
	const rows = guard("lane rows", [] as LaneCard[], () => ports.lanes());
	const lanes = rows.filter((lane) => lane.state !== "gone");
	// Decided before the removal below: the merge check reads git inside the lane's own worktree, and the
	// worktree step may remove that worktree in this same pass, leaving nothing to read.
	const records = guard("lane records", [] as LaneRecord[], () => listLaneRecords(options.stateDir));
	const usage: WorktreeUsage = {
		laneCwds: lanes.flatMap((lane) => (lane.cwd === null ? [] : [lane.cwd])),
		processCwds: guard("process cwds", [], () => ports.processCwds()),
		// Without a readable unit rule nothing that a unit might name is removable, so a failed read stays unknown.
		units: guard("user units", { named: [], unreadable: true }, () => readUnitUsage(ports.unitDir())),
	};
	// Decided before the removal below: the merge check reads git inside the lane's own worktree, and the
	// worktree step may remove that worktree in this same pass, leaving nothing to read.
	const ended = guard("ended lanes", [] as EndedLane[], () => endedLanes(rows, records, options.stateDir, now, usage.processCwds));
	const findings = guard("catalogue", [] as string[], () => ports.repos()).flatMap((repo) => classifyWorktrees(repo, now, usage));
	const weekly = new Date(now).getDay() === 0 ? findings.filter((finding) => finding.verdict === "dirty" || finding.verdict === "unmerged") : [];
	const unknown = findings.filter((finding) => finding.verdict === "keep-unknown");

	// 1b. The OL1 cleanup rules (VR24-220, spec §6). Six rule groups, each planned on every pass from reads only.
	// A rule's write half runs only when `state/muster/janitor-apply` names it (S3-F6): the rules the file does not
	// name plan and report and do nothing, so removing one line is that rule's rollback. A rule that throws is a
	// step problem like any other and stops nothing.
	const applies = (rule: JanitorRule): boolean => !options.dryRun && options.appliedRules.has(rule);
	const appliedRules = JANITOR_RULES.filter((rule) => applies(rule));
	// §6 calls the docker prune and the pnpm store prune weekly, so their write halves wait for the weekly pass.
	const weeklyPass = isWeeklyPass(now);
	const archiveRoot = guard("archive root", ARCHIVE_ROOT, () => ports.archiveRoot?.() ?? ARCHIVE_ROOT);
	const largeRoot = guard("large archive root", LARGE_ARCHIVE_ROOT, () => ports.largeArchiveRoot?.() ?? LARGE_ARCHIVE_ROOT);
	const jobsDir = guard<string | undefined>("claude jobs dir", undefined, () => ports.jobsDir?.());
	const pnpmBinary = guard<string | undefined>("pnpm binary", undefined, () => ports.pnpmBinary?.());
	// A lane closed yesterday has its record on the board; a lane closed a month ago has it in the archive, and
	// its worktree is just as much that lane's to give up. Rule (a) is the only reader of this longer list.
	const closedHistory = [...records, ...guard("archived lane records", [] as LaneRecord[], () => archivedLaneRecords(options.stateDir))];
	// Rule (g): the last attempt on each repaired contract. A contract is left alone for the 15-minute window and
	// for the rest of the day it was repaired on.
	const repairLog = guard("repair log", {} as Record<string, number>, () => readRepairLog(options.stateDir));
	const cleanup = guard(
		"cleanup plan",
		{ archives: [], largeArchives: [], kept: [], jobDirs: [], caches: [], dockerImages: [], dockerSkipped: [], commands: [], doctorRepairs: { repairs: [], unrepairable: [], repairedRecently: [], repairedToday: [] }, expiringArchives: [], keptArchives: [] } as CleanupPlan,
		() =>
			planCleanup({
				findings,
				others: [...new Set([...findings.map((finding) => finding.path), ...guard("catalogue", [] as string[], () => ports.repos())])],
				records: closedHistory,
				usage,
				now,
				date,
				stateDir: options.stateDir,
				...(jobsDir === undefined ? {} : { jobsDir }),
				...(pnpmBinary === undefined ? {} : { pnpmBinary }),
				archiveRoot,
				largeRoot,
				maxBytes: guard("archive cap", ARCHIVE_MAX_BYTES, () => ports.archiveMaxBytes?.() ?? ARCHIVE_MAX_BYTES),
				docker: guard("docker images", [] as DockerImage[], () => ports.dockerImages?.() ?? []),
				doctor: guard("doctor contracts", [] as DoctorContract[], () => ports.doctorContracts?.() ?? []),
				repairLog,
			}),
	);
	// What the one removal path did, and — in a dry run, which changes nothing — what it would do.
	const removal: RemovalResult = { removed: [], failed: [] };
	if (options.dryRun) removal.removed = cleanup.archives.map((target) => target.finding);
	let cleanupApplied: CleanupApplied | undefined;
	if (appliedRules.length > 0) {
		const archived = applies("worktrees") ? archiveWorktrees(cleanup.archives, manifest, date) : { archived: [] as ArchiveTarget[], failed: [] as Array<{ target: ArchiveTarget; error: string }> };
		removal.removed = archived.archived.map((target) => target.finding);
		removal.failed = archived.failed.map((failure) => ({ finding: failure.target.finding, error: failure.error }));
		const largeArchived: LargeArchive[] = [];
		if (applies("worktrees")) {
			for (const target of cleanup.largeArchives) {
				const done = largeArchive(target);
				if (done.ok) largeArchived.push(target);
				else problems.push(`large archive ${target.finding.path}: ${done.detail}`);
			}
		}
		const emptied = applies("job-temp") ? emptyJobDirs(cleanup.jobDirs) : { emptied: [], failed: [] };
		const pruned = applies("build-caches") ? removeCaches(cleanup.caches) : { removed: [], failed: [] };
		const images = applies("docker") && weeklyPass ? guard("docker image removal", { removed: [] as string[], failed: [] as Array<{ id: string; error: string }> }, () => ports.dockerRemove?.(cleanup.dockerImages.map((image) => image.id)) ?? { removed: [], failed: [] }) : { removed: [] as string[], failed: [] as Array<{ id: string; error: string }> };
		for (const failure of images.failed) problems.push(`docker image ${failure.id}: ${failure.error}`);
		let pnpmPrune: CleanupApplied["pnpmPrune"];
		if (applies("pnpm") && weeklyPass) {
			pnpmPrune = guard("pnpm store prune", { ok: false, detail: "not run" }, () =>
				pnpmBinary === undefined ? { ok: false, detail: "no pnpm binary on this machine's PATH or in ~/.local/share/pnpm" } : (ports.pnpmStorePrune?.(pnpmBinary) ?? { ok: false, detail: "no pnpmStorePrune port" }),
			);
			if (!pnpmPrune.ok) problems.push(`pnpm store prune: ${pnpmPrune.detail}`);
		}
		const repairs: CleanupApplied["repairs"] = [];
		if (applies("repairs") && cleanup.doctorRepairs.repairs.length > 0) {
			const log = guard("repair log", {} as Record<string, number>, () => readRepairLog(options.stateDir));
			for (const repair of cleanup.doctorRepairs.repairs) {
				const done = guard(`repair ${repair.contractId}`, { ok: false, detail: "not run" }, () => ports.runRepair?.(repair.command, repair.timeoutMs) ?? { ok: false, detail: "no runRepair port" });
				repairs.push({ contractId: repair.contractId, ...done });
				// An attempt is the repair, whatever it returned: a failing repair is not retried inside the window.
				log[repair.contractId] = now;
				if (!done.ok) problems.push(`repair ${repair.contractId}: ${done.detail}`);
			}
			guard("repair log write", undefined, () => writeRepairLog(options.stateDir, log));
		}
		const expired = applies("worktrees") ? expireArchives(cleanup.expiringArchives.map((entry) => entry.dir)) : { expired: [], failed: [] };
		// A failed removal is one report line, never a Needs the operator item: the worktree is still there, which is the
		// safe outcome, and the next pass plans it again.
		for (const failure of emptied.failed) problems.push(`empty ${failure.dir}: ${failure.error}`);
		for (const failure of pruned.failed) problems.push(`remove ${failure.dir}: ${failure.error}`);
		cleanupApplied = { archived: archived.archived, archiveFailures: archived.failed, largeArchived, emptiedJobDirs: emptied.emptied, removedCaches: pruned.removed, removedImages: images.removed, ...(pnpmPrune === undefined ? {} : { pnpmPrune }), repairs, expiredArchives: expired.expired, expiryFailures: expired.failed };
	}

	// 2. Lane records: close the ended lanes the lifecycle never managed, then archive the closed
	// records older than 24 h. A lane closed now gets a day on the board with its reason before it goes.
	const closed: EndedLane[] = [];
	for (const entry of ended) {
		if (options.dryRun) {
			closed.push(entry);
			continue;
		}
		try {
			const done = await ports.close(entry.row, entry.reason);
			if (done.ok) closed.push(entry);
			else problems.push(`close ${entry.row.laneId}: ${done.detail}`);
		} catch (error) {
			problems.push(`close ${entry.row.laneId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const archived = records.filter((record) => record.phase === "closed" && now - closedAt(record) > CLEANUP_AFTER_MS).map((record) => record.laneId);

	// 2b. Dev-server scopes a lane left behind (2026-10-18). `closeLane` stops a lane's registered scope when it
	// parks or closes; this is the net under it, for a stop that failed and for a lane that was already closed when
	// the scope was registered. A record that says its lane runs nothing but still names an active scope gets it
	// stopped, by the unit's exact name; a scope no record registers is never touched. The candidates come from the
	// records either way, so a dry run still lists what a pass would stop. This runs before the archive below, which
	// is what takes a closed record out of `listLaneRecords`.
	const idleScopes = idleLaneHelperScopes(records);
	let stoppedScopes: StoppedHelperScope[] = [];
	if (!options.dryRun) {
		try {
			stoppedScopes = await (ports.stopIdleHelperScopes?.() ?? Promise.resolve([]));
		} catch (error) {
			problems.push(`idle helper scopes: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	// 2c. Orphaned Claude Code shells (2026-10-18). A tool call's `while …` loop outlives the session that started it:
	// the loop's own `pgrep -f` pattern matches the shell running it, so the loop never ends. `closeLane` cannot see
	// such a shell — it is not a registered helper — so a finished job's parentless shell, older than an hour, is
	// stopped by its exact pid. The list is a read, so a dry run shows what a pass would stop and stops nothing.
	const orphanShells = guard("orphan shells", [] as OrphanClaudeShell[], () => ports.orphanClaudeShells?.() ?? []);
	let stoppedOrphanShells: StoppedOrphanShell[] = [];
	if (!options.dryRun && orphanShells.length > 0) {
		try {
			stoppedOrphanShells = await (ports.stopOrphanClaudeShells?.(orphanShells) ?? Promise.resolve([]));
		} catch (error) {
			problems.push(`orphan shells: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (!options.dryRun) for (const laneId of archived) guard(`archive ${laneId}`, undefined, () => archiveLaneRecord(options.stateDir, laneId, now));

	// 3. Concord.
	const concord: ConcordPlan[] = [];
	for (const dbFile of guard("concord databases", [] as string[], () => ports.concordDbs())) {
		try {
			const plan = planConcordCleanup(dbFile, now);
			if (!options.dryRun) await applyConcordCleanup(plan);
			concord.push(plan);
		} catch (error) {
			problems.push(`concord ${dbFile}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// 4. Code graphs (WP11, LD12): every catalogue repository is refreshed each night, code only. A dry run only reads.
	const graphs: GraphReading[] = [];
	for (const repo of guard("catalogue", [] as string[], () => ports.repos())) {
		const reading: GraphReading = { repo, status: guard(`graph status ${repo}`, undefined, () => ports.graphStatus(repo)) };
		if (!options.dryRun) {
			try {
				ports.graphRefresh(repo);
				reading.refreshed = true;
				reading.status = guard(`graph status ${repo}`, reading.status, () => ports.graphStatus(repo));
			} catch (error) {
				reading.failure = error instanceof Error ? error.message : String(error);
				problems.push(reading.failure);
			}
		}
		graphs.push(reading);
	}

	// 5. LC-D9: one ledger backup a day. Only in ledger mode — before the flip there is no
	// ledger — and a dry run writes nothing. A failure is a step problem, not a stopped pass.
	const ledgerBackup = options.dryRun ? undefined : guard("ledger backup", undefined, () => ports.ledgerBackup?.());

	// 6. Readings for the report.
	const failedUnits = guard("failed units", "", () => ports.failedUnits()).trim();
	// AK11: a failed user unit is the orchestrator's work, not the operator's, so the units leave the "Needs
	// the operator" list and are named in one message to its inbox. A dry run reports them and sends nothing.
	const failedUnitNames = failedUnits.split("\n").map((line) => line.replace(/^\W+/, "").split(/\s+/)[0] ?? "").filter((name) => name !== "");
	const memory = guard("memory", { free: "(unread)", pressure: "(unread)" }, () => ports.memory());
	const phaseOf = (laneId: string): string => records.find((record) => record.laneId === laneId)?.phase ?? "no record";

	if (failedUnitNames.length > 0 && !options.dryRun) {
		guard("failed units to the orchestrator", undefined, () => ports.sendToOrchestrator(`Failed user units: ${failedUnitNames.join(", ")}. Report: plans_read root=pi-plans path=${options.plansPath(reportName)}`));
	}

	const needsOperator: string[] = [];
	if (weekly.length > 0) needsOperator.push(`${weekly.length} dirty or unmerged worktrees (weekly list)`);
	const waiting = records.filter((record) => record.phase === "parked" || record.phase === "blocked" || record.phase === "question");
	if (waiting.length > 0) needsOperator.push(`lanes parked or unanswered: ${waiting.map((record) => `${record.laneId} (${record.phase})`).join(", ")}`);
	// A lane that is no longer running (parked or finished) whose record still lists Chrome tabs: nobody can close them but the operator (LD11).
	const orphanTabs = records.filter((record) => LANE_NOT_RUNNING_PHASES.includes(record.phase) && (record.openTabs?.length ?? 0) > 0);
	if (orphanTabs.length > 0) needsOperator.push(`orphan tab groups to close in Chrome: ${orphanTabs.map((record) => `${record.laneId} (tabs ${record.openTabs!.join(", ")})`).join("; ")}`);
	for (const problem of problems) needsOperator.push(`janitor step failed: ${problem}`);

	const kept = (verdict: WorktreeVerdict): number => findings.filter((finding) => finding.verdict === verdict).length;
	const lines: string[] = [`# Janitor report ${date}`, "", ...(options.dryRun ? ["DRY RUN: nothing below was changed.", ""] : []), "## Worktrees removed"];
	if (removal.removed.length === 0) lines.push(options.dryRun ? "None would be." : appliedRules.includes("worktrees") ? "None." : "None: the worktrees rule is not in the apply file, so this pass planned its removals and removed nothing.");
	else {
		if (options.dryRun) lines.push(`DRY RUN: ${removal.removed.length} would be archived and then removed:`);
		lines.push(...removal.removed.map((finding) => `- ${finding.repo} | ${finding.path} | ${finding.branch ?? "detached"} | ${finding.sha} (${finding.reason})`));
		lines.push("", options.dryRun ? `Manifest it would append to: ${manifest}` : `Manifest: ${manifest}. Restore: git -C <repo> worktree add <path> <branch-or-sha>`);
	}
	lines.push("", `Kept: ${kept("dirty")} dirty, ${kept("unmerged")} unmerged, ${kept("keep-recent")} merged less than 24 h ago, ${kept("keep-in-use")} in use, ${kept("keep-unknown")} where it could not be determined.`);
	if (unknown.length > 0) lines.push("", "Kept because it could not be determined:", ...unknown.map((finding) => `- ${finding.path}: ${finding.reason}`));

	lines.push("", "## Weekly list: dirty and unmerged worktrees");
	if (new Date(now).getDay() !== 0) lines.push("Listed on Sundays.");
	else if (weekly.length === 0) lines.push("None.");
	else lines.push(...weekly.map((finding) => `- ${finding.verdict}: ${finding.path} (${finding.branch ?? "detached"}) last commit ${finding.lastCommitAt === undefined ? "unknown" : `${age(finding.lastCommitAt, now)} ago`}${finding.lastSubject ? `: ${finding.lastSubject}` : ""}`));

	// VR24-220: the six OL1 rules, as counts on every pass and as outcomes on the rules that applied.
	lines.push("", "## Cleanup plan (OL1)");
	lines.push(
		options.dryRun
			? "DRY RUN: nothing below is deleted."
			: appliedRules.length === 0
				? `PLAN ONLY: no rule is listed in ${applyFilePath(options.stateDir)}, so nothing below is deleted. Rollback is one line removed from that file.`
				: `APPLIED: ${appliedRules.join(", ")}. Every other rule only planned.`,
	);
	lines.push(`- (a) worktrees, one removal path for merged and unmerged alike, archived then removed: ${cleanup.archives.length}${cleanupApplied === undefined ? " planned" : ` planned, ${cleanupApplied.archived.length} removed`}; kept ${cleanup.kept.length}`);
	if (cleanupApplied !== undefined) for (const target of cleanupApplied.archived) lines.push(`  - archived to ${target.dir}, then removed ${target.finding.path} (${target.laneId === undefined ? "merged, no lane record needed" : `lane ${target.laneId}`}, ${target.finding.branch ?? "detached"}, ${target.ref})`);
	if (cleanup.largeArchives.length > 0) {
		lines.push(
			`  - over the ${gib(ARCHIVE_MAX_BYTES)} GB payload cap, copied to ${largeRoot} with a sha256 check and kept: ${cleanup.largeArchives.length}${cleanupApplied === undefined ? " planned" : ` planned, ${cleanupApplied.largeArchived.length} copied`}`,
		);
		for (const target of cleanup.largeArchives) lines.push(`    - ${target.finding.path} (${target.files} files, ${gib(target.bytes)} GB) -> ${target.dir}`);
	}
	for (const keep of cleanup.kept) lines.push(`  - kept ${keep.finding.path}: ${keep.why}`);
	lines.push(`- (b) tmp folders of finished Claude jobs older than 2 d, emptied: ${cleanup.jobDirs.length}${cleanupApplied === undefined ? " planned" : ` planned, ${cleanupApplied.emptiedJobDirs.length} emptied`}`);
	lines.push(`- (c) build caches in worktrees idle 24 h with no live lane record, no registered scope and no process inside, deleted: ${cleanup.caches.length}${cleanupApplied === undefined ? " planned" : ` planned, ${cleanupApplied.removedCaches.length} deleted`}`);
	for (const cache of cleanup.caches) lines.push(`  - delete ${cache}`);
	lines.push(
		`- (d) docker images with a RepoDigests entry that no container uses, unused for 168 h, removed weekly (volumes are never touched): ${cleanup.dockerImages.length}${cleanupApplied === undefined ? " planned" : ` planned, ${cleanupApplied.removedImages.length} removed`}${applies("docker") && !weeklyPass ? " (the weekly pass applies it on Sunday)" : ""}`,
	);
	for (const image of cleanup.dockerImages) lines.push(`  - remove ${image.repository}:${image.tag} ${image.id} (built ${age(image.createdMs, now)} ago, digests ${pullableDigests(image).join(", ")})`);
	for (const entry of cleanup.dockerSkipped.filter((skip) => skip.reason === "local-build")) lines.push(`  - skip ${entry.image.repository}:${entry.image.tag} ${entry.image.id}: ${entry.why}`);
	const inUse = cleanup.dockerSkipped.filter((skip) => skip.reason === "in-use").length;
	if (inUse > 0) lines.push(`  - ${inUse} more images are named by a container and are left alone`);
	for (const id of cleanupApplied?.removedImages ?? []) lines.push(`  - removed ${id}`);
	lines.push(
		`- (pnpm) the store prune, by absolute path, weekly: ${cleanup.pnpm === undefined ? "no pnpm binary found" : `${cleanup.pnpm.command} (${cleanup.pnpm.why})`}${cleanupApplied?.pnpmPrune === undefined ? "" : ` -> ${cleanupApplied.pnpmPrune.ok ? "ok" : "failed"}: ${cleanupApplied.pnpmPrune.detail}`}${applies("pnpm") && !weeklyPass ? " (the weekly pass applies it on Sunday)" : ""}`,
	);
	lines.push(`- (e) processes: none are stopped here. The scope stops below are the only stops, and nothing is signalled by folder match (S3-F3)`);
	lines.push(`- (f) weekly commands, named and never run: ${cleanup.commands.map((entry) => `${entry.command} (${entry.why})`).join("; ")}`);
	lines.push("- (f) the C: free-space check is a doctor contract (follow-up row: health/doctor.ts); this pass keeps only fstrim");
	lines.push(
		`- (g) doctor repairs, one declared bounded repair per red contract, again only ${Math.round(DOCTOR_REPAIR_WINDOW_MS / 60_000)} minutes after the last attempt and once a day: ${cleanup.doctorRepairs.repairs.length}${cleanupApplied === undefined ? " planned" : ` planned, ${cleanupApplied.repairs.length} tried`}; red contracts with no declared repair: ${cleanup.doctorRepairs.unrepairable.length}; inside the window: ${cleanup.doctorRepairs.repairedRecently.length}; repaired earlier today: ${cleanup.doctorRepairs.repairedToday.length}`,
	);
	for (const repair of cleanup.doctorRepairs.repairs) {
		const done = cleanupApplied?.repairs.find((entry) => entry.contractId === repair.contractId);
		lines.push(`  - ${repair.contractId}: ${repair.command.join(" ")} within ${Math.round(repair.timeoutMs / 1000)} s${done === undefined ? "" : ` -> ${done.ok ? "ok" : "failed"}: ${done.detail}`}`);
	}
	for (const row of cleanup.doctorRepairs.unrepairable) lines.push(`  - ${row.kind} ${row.id}: no declared repair, left to the tick's ask`);
	if (cleanupApplied !== undefined) for (const failure of cleanupApplied.archiveFailures) lines.push(`  - failed to remove ${failure.target.finding.path}: ${failure.error}`);
	lines.push(
		`- archives past 30 days: ${cleanup.expiringArchives.length}${cleanupApplied === undefined ? " expiring" : ` expiring, ${cleanupApplied.expiredArchives.length} expired`}, ${cleanup.keptArchives.length} kept`,
	);
	for (const archive of cleanup.expiringArchives) lines.push(`  - expire ${archive.dir}: ${archive.reason}`);
	for (const archive of cleanup.keptArchives) lines.push(`  - kept ${archive.dir}: ${archive.reason}`);
	if (cleanupApplied !== undefined) for (const failure of cleanupApplied.expiryFailures) lines.push(`  - failed to expire ${failure.dir}: ${failure.error}`);

	lines.push("", "## Failed user units", failedUnits === "" ? "None." : failedUnits);
	lines.push("", "## Memory (reading only)", "```", memory.free, "", memory.pressure, "```");

	lines.push("", "## Live lanes");
	if (lanes.length === 0) lines.push("None.");
	else lines.push(...lanes.map((lane) => `- ${lane.laneId}: ${phaseOf(lane.laneId)}, ${lane.state}, last turn ${lane.lastActivityMs ? `${age(lane.lastActivityMs, now)} ago` : "unknown"}`));

	lines.push("", "## Lanes parked or unanswered");
	if (waiting.length === 0) lines.push("None.");
	else lines.push(...waiting.map((record) => `- ${record.laneId}: ${record.phase} for ${age(record.phaseSince, now)}${record.lastReport?.summary ? `: ${record.lastReport.summary}` : ""}`));

	lines.push("", "## Orphan tab groups for the operator to close");
	if (orphanTabs.length === 0) lines.push("None.");
	else lines.push(...orphanTabs.map((record) => `- ${record.laneId} (${record.phase} ${age(record.phaseSince, now)} ago): Chrome tabs ${record.openTabs!.join(", ")}`));

	// The net under `closeLane` for a dev server whose lane is not running any more.
	lines.push("", "## Dev-server scopes left by a lane that was not running");
	if (options.dryRun) {
		if (idleScopes.length === 0) lines.push("None.");
		else lines.push("DRY RUN: a pass would stop:", ...idleScopes.map((scope) => `- ${scope.unit} (registered by ${scope.laneId}, ${scope.phase})`));
	} else if (stoppedScopes.length === 0) {
		lines.push(idleScopes.length === 0 ? "None." : `${idleScopes.length} registered, none of them active any more.`);
	} else {
		lines.push(...stoppedScopes.map((scope) => `- ${scope.unit} (registered by ${scope.laneId}, ${scope.phase}): ${scope.outcome}`));
	}

	// A shell no lane owns: a tool call's loop that outlived its session, which no close reaches.
	lines.push("", "## Orphaned Claude Code shells left by a finished job");
	if (options.dryRun) {
		if (orphanShells.length === 0) lines.push("None.");
		else lines.push("DRY RUN: a pass would stop:", ...orphanShells.map((shell) => `- pid ${shell.pid} (job ${shell.jobId}, ${age(now - shell.ageMs, now)} old): ${shell.jobDir}`));
	} else if (stoppedOrphanShells.length === 0) {
		lines.push(orphanShells.length === 0 ? "None." : `${orphanShells.length} found, none stopped.`);
	} else {
		lines.push(...stoppedOrphanShells.map((shell) => `- pid ${shell.pid} (job ${shell.jobId}, ${age(now - shell.ageMs, now)} old): ${shell.outcome}`));
	}

	lines.push("", "## Code graphs");
	if (graphs.length === 0) lines.push("None.");
	else lines.push(...graphs.map((graph) => `- ${graph.repo}: ${describeGraph(graph, now, options.dryRun)}`));

	lines.push("", "## Housekeeping", `- Ended lanes closed: ${closed.length === 0 ? "none" : closed.map((entry) => `${entry.row.laneId} (${entry.reason})`).join("; ")}`);
	lines.push(`- Lane records archived: ${archived.length === 0 ? "none" : archived.join(", ")}`);
	lines.push(`- Ledger backup: ${ledgerBackup === undefined ? (options.dryRun ? "dry run, nothing written" : "not in ledger mode") : `${ledgerBackup.path} (${ledgerBackup.bytes} bytes)`}`);
	for (const plan of concord) lines.push(`- Concord ${plan.dbFile}: ${plan.disconnect.length} endpoints disconnected, ${plan.deactivate.length} agents set to ${CONCORD_INACTIVE_STATUS}`);
	if (problems.length > 0) lines.push("", "## Steps that failed", ...problems.map((problem) => `- ${problem}`));
	const report = `${lines.join("\n")}\n`;

	const unitNote = failedUnitNames.length === 0 ? "" : options.dryRun ? " Failed units would be sent to the orchestrator." : " Failed units sent to the orchestrator.";
	const closedNote = closed.length === 0 ? "" : ` ${closed.length} ended lane${closed.length === 1 ? "" : "s"} closed."`;
	const orphanNote = stoppedOrphanShells.length === 0 ? "" : ` Orphaned Claude shells stopped: ${stoppedOrphanShells.map((shell) => `pid ${shell.pid} (job ${shell.jobId})`).join(", ")}."`;
	const summary = `Janitor ${date}${options.dryRun ? " (dry run)" : ""}: ${removal.removed.length} worktrees removed${removal.removed.length > 0 ? ` (manifest worktree-removal-${date}.txt)` : ""}.${unitNote}${closedNote}${orphanNote} ${needsOperator.length === 0 ? "Nothing needs the operator." : `Needs the operator: ${needsOperator.map((entry) => entry.split("\n")[0]).join("; ")}.`} Report: plans_read root=pi-plans path=${options.plansPath(reportName)}`;

	// Spec §6 line 1: every run writes its report, a dry run included, so a plan is a file the operator can read later.
	mkdirSync(options.outDir, { recursive: true });
	writeFileSync(join(options.outDir, reportName), report);
	if (!options.dryRun) guard("summary to Henry", undefined, () => ports.tellHenry(summary));
	return { date, reportName, report, removed: removal.removed, removalFailures: removal.failed, weekly, concord, closed, archived, ...(ledgerBackup !== undefined ? { ledgerBackup } : {}), cleanup, ...(cleanupApplied !== undefined ? { cleanupApplied } : {}), needsOperator, summary };
}

export async function main(): Promise<void> {
	const dryRun = process.argv.includes("--dry-run");
	const stateDir = musterStateDir();
	// Spec §6 line 1: one pass at a time. A manual run and the timer can never apply the same rule at once, and the
	// second one says so and exits without touching anything.
	const lock = await holdPassLock(join(stateDir, PASS_LOCK_FILE));
	if (lock === undefined) {
		process.stdout.write(`${LOCK_HELD_MESSAGE}\n`);
		return;
	}
	try {
		const result = await runJanitor(
			{
				dryRun,
				appliedRules: readAppliedRules(applyFilePath(stateDir)),
				stateDir,
				outDir: join(piAgentDir(), "plans", "muster-autonomy", "janitor"),
				plansPath: (name) => `muster-autonomy/janitor/${name}`,
			},
			liveJanitorPorts(stateDir),
		);
		process.stdout.write(dryRun ? `${result.report}\n--- summary line for Henry ---\n${result.summary}\n` : `${result.summary}\n`);
	} finally {
		lock.release();
	}
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error: unknown) => {
		process.stderr.write(`muster-janitor: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
		process.exitCode = 1;
	});
}
