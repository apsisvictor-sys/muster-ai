/**
 * The lifecycle rules' view of git, the one owner (moved out of `bin/muster-tick.mts` in PB5 so the
 * ledger tick and the file tick read git the same way). `bin/muster-tick.mts` re-exports it.
 *
 * Impact map (VR22-30):
 * - bin/muster-tick.mts: its `lifecyclePorts().git` is this object. The move changes no behaviour;
 *   `muster-tick.test.ts` reads real git through the re-export.
 * - ledger/task-ports.ts: `createTaskPorts` uses it as the default git facts of `lifecycle.decide`.
 *   A second implementation would drop the protections below.
 * - Protections kept here: `GIT_OPTIONAL_LOCKS=0` (a `git status` must not take index.lock in a lane's
 *   worktree while the lane commits), the sha format check (a sha that is not hex never reaches argv),
 *   the ref-exists check (a missing `origin/dev` is "no", not "could not tell"), `refs/heads/<branch>`
 *   in `onBranch`, and `existsSync` in `isLinkedWorktree` (a missing cwd is undefined).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { GitFacts } from "../lane-lifecycle.ts";

/** Git for the lifecycle rules: read-only, no lock files written, 10 s per call, a fixed argv and no shell. `undefined` is "could not tell". */
function gitRun(cwd: string, args: string[]): { status: number; stdout: string } | undefined {
	try {
		const run = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
		return run.error !== undefined || run.status === null ? undefined : { status: run.status, stdout: run.stdout };
	} catch {
		return undefined;
	}
}

/** Whether a ref names a commit here: true, false (it does not exist), or undefined (git failed). */
function refExists(cwd: string, ref: string): boolean | undefined {
	const run = gitRun(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
	return run === undefined ? undefined : run.status === 0 ? true : run.status === 1 ? false : undefined;
}

/** `merge-base --is-ancestor`: 0 yes, 1 no, anything else (an unknown commit, a git error) is undefined. */
function isAncestorOf(cwd: string, sha: string, ref: string): boolean | undefined {
	if (!/^[0-9a-f]{7,40}$/i.test(sha)) return undefined;
	const exists = refExists(cwd, ref);
	if (exists !== true) return exists;
	const run = gitRun(cwd, ["merge-base", "--is-ancestor", sha, ref]);
	return run === undefined ? undefined : run.status === 0 ? true : run.status === 1 ? false : undefined;
}

/** The lifecycle rules' view of git: only the local `origin/*` refs (no fetch), and a worktree is clean when `status --porcelain` prints nothing. */
export const liveGitFacts: GitFacts = {
	isAncestor: isAncestorOf,
	isClean(cwd) {
		const run = gitRun(cwd, ["status", "--porcelain"]);
		return run === undefined || run.status !== 0 ? undefined : run.stdout.trim() === "";
	},
	onBranch(cwd, sha, branch) {
		return isAncestorOf(cwd, sha, `refs/heads/${branch}`);
	},
	isLinkedWorktree(cwd) {
		if (!existsSync(cwd)) return undefined;
		const run = gitRun(cwd, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]);
		if (run === undefined) return undefined;
		if (run.status !== 0) return false;
		const [gitDir, commonDir] = run.stdout.trim().split("\n");
		return gitDir !== undefined && commonDir !== undefined && gitDir !== commonDir;
	},
};
