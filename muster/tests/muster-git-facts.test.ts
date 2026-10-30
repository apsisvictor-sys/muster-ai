/**
 * `lib/git-facts.ts`: the one owner of the lifecycle rules' view of git, read from real git in a
 * temporary repository. Moved here from muster-tick.test.ts when `liveGitFacts` moved out of
 * `bin/muster-tick.mts` (PB5), so the owner is tested without loading the whole tick.
 */

import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { liveGitFacts } from "../lib/git-facts.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A bare origin, a main checkout cloned from it, and a linked worktree on its own branch. */
function gitFixture(dir: string): { main: string; lane: string; originMainSha: string; laneSha: string } {
	const origin = join(dir, "origin.git");
	const main = join(dir, "main");
	const lane = join(dir, "wt-lane");
	execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "ignore" });
	execFileSync("git", ["clone", "-q", origin, main], { stdio: "ignore" });
	writeFileSync(join(main, "f.txt"), "one\n");
	git(main, "add", "f.txt");
	git(main, "commit", "-q", "-m", "one");
	git(main, "push", "-q", "origin", "HEAD:main");
	git(main, "fetch", "-q", "origin");
	git(main, "worktree", "add", "-q", "-b", "lane/x", lane, "origin/main");
	writeFileSync(join(lane, "g.txt"), "two\n");
	git(lane, "add", "g.txt");
	git(lane, "commit", "-q", "-m", "two");
	return { main, lane, originMainSha: git(main, "rev-parse", "HEAD"), laneSha: git(lane, "rev-parse", "HEAD") };
}

test("liveGitFacts reads a linked worktree, cleanliness, the branch and origin refs from real git, and answers undefined when it cannot tell", () => {
	const dir = mkdtempSync(join(tmpdir(), "muster-git-facts-"));
	try {
		const { main, lane, originMainSha, laneSha } = gitFixture(dir);
		assert.equal(liveGitFacts.isLinkedWorktree(lane), true);
		assert.equal(liveGitFacts.isLinkedWorktree(main), false, "the main checkout is not a lane worktree");
		assert.equal(liveGitFacts.isLinkedWorktree(dir), false, "a folder that is no repository is not a lane worktree");
		assert.equal(liveGitFacts.isLinkedWorktree(join(dir, "gone")), undefined, "a missing cwd cannot be told");
		assert.equal(liveGitFacts.isClean(lane), true);
		writeFileSync(join(lane, "dirty.txt"), "x");
		assert.equal(liveGitFacts.isClean(lane), false, "an untracked file makes it dirty");
		assert.equal(liveGitFacts.isClean(join(dir, "gone")), undefined);
		assert.equal(liveGitFacts.onBranch(lane, laneSha, "lane/x"), true);
		assert.equal(liveGitFacts.onBranch(lane, laneSha, "lane/nope"), false);
		assert.equal(liveGitFacts.isAncestor(lane, originMainSha, "origin/main"), true);
		assert.equal(liveGitFacts.isAncestor(lane, laneSha, "origin/main"), false, "the lane commit is not merged yet");
		assert.equal(liveGitFacts.isAncestor(lane, laneSha, "origin/dev"), false, "a ref that does not exist holds nothing");
		assert.equal(liveGitFacts.isAncestor(lane, "0123456789abcdef0123456789abcdef01234567", "origin/main"), undefined, "an unknown commit cannot be told");
		assert.equal(liveGitFacts.isAncestor(lane, "--output=x", "origin/main"), undefined, "a sha that is not hex is refused");
		git(main, "push", "-q", "origin", `${laneSha}:refs/heads/main`);
		git(main, "fetch", "-q", "origin");
		assert.equal(liveGitFacts.isAncestor(lane, laneSha, "origin/main"), true, "after the push the lane commit is in origin/main");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
