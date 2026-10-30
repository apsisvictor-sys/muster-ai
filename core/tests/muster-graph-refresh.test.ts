/**
 * WP11 (LD12): the code-graph refresh script, the graph nudge and their TypeScript wrapper.
 * A fake `graphify` on PATH stands in for the real one; the git repositories are temporary.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { graphNudge, graphNudgeScript, graphRefreshPass, graphRefreshRequestArgv, graphRefreshScript, graphStatus, parseGraphStatus, requestGraphRefresh, type GraphStatus } from "../graph-refresh.ts";

// RS1/S10: the scripts live under the agent folder the test setup configured, read through the port.
const GRAPH_REFRESH_SCRIPT = graphRefreshScript();
const GRAPH_NUDGE_SCRIPT = graphNudgeScript();

const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const temps: string[] = [];
test.after(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-`)));
	temps.push(dir);
	return dir;
}

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
	assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

interface Fixture {
	main: string;
	worktree: string;
	bin: string;
	log: string;
	env: NodeJS.ProcessEnv;
}

/** A repository with a commit on origin/dev, a linked worktree, and a fake graphify that logs its cwd and argument. */
function fixture(): Fixture {
	const root = tmp("graph-refresh");
	const main = join(root, "repo");
	mkdirSync(main);
	git(main, "init", "-q", "-b", "main");
	writeFileSync(join(main, "a.txt"), "a\n");
	git(main, "add", ".");
	git(main, "commit", "-q", "-m", "one");
	git(main, "update-ref", "refs/remotes/origin/dev", "HEAD");
	const worktree = join(root, "lane");
	git(main, "worktree", "add", "-q", "-b", "lane", worktree);
	const bin = join(root, "bin");
	mkdirSync(bin);
	const log = join(root, "graphify.log");
	writeFileSync(
		join(bin, "graphify"),
		`#!/bin/sh\necho "$PWD $*" >> "${log}"\n[ -n "\${FAKE_GRAPHIFY_FAIL:-}" ] && exit 3\nmkdir -p "$2/graphify-out"\necho '{}' > "$2/graphify-out/graph.json"\necho '# report' > "$2/graphify-out/GRAPH_REPORT.md"\n`,
	);
	chmodSync(join(bin, "graphify"), 0o755);
	const env = { ...process.env, ...GIT_ENV, PATH: `${bin}:${process.env.PATH}`, GRAPH_NUDGE_STATE_DIR: join(root, "nudge") };
	return { main, worktree, bin, log, env };
}

function refresh(f: Fixture, ...args: string[]) {
	return spawnSync(GRAPH_REFRESH_SCRIPT, args, { encoding: "utf8", env: f.env });
}

function status(f: Fixture, repo: string): Record<string, string> {
	const result = refresh(f, "--status", repo);
	assert.equal(result.status, 0, result.stderr);
	return Object.fromEntries(result.stdout.trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

test("a refresh started in a lane worktree builds the main checkout's graph and stamps HEAD and the base refs", () => {
	const f = fixture();
	const result = refresh(f, f.worktree);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(readFileSync(f.log, "utf8").trim(), `${f.main} update ${f.main}`, "graphify ran in the main checkout, on the main checkout");
	assert.ok(existsSync(join(f.main, "graphify-out", "graph.json")));
	assert.equal(existsSync(join(f.worktree, "graphify-out")), false, "nothing is written in the worktree");
	const stamp = readFileSync(join(f.main, "graphify-out", ".refreshed-at"), "utf8").trim().split("\n");
	assert.match(stamp[0], /^\d{4}-\d\d-\d\dT[\d:+-]+ [0-9a-f]{40}$/);
	assert.equal(stamp[0].split(" ")[1], git(f.main, "rev-parse", "HEAD"));
	assert.equal(stamp[1], `origin/dev ${git(f.main, "rev-parse", "origin/dev")}`);
	assert.equal(stamp.length, 2, "origin/main does not exist here, so it has no line");
});

// ─── the main checkout follows its base ref ─────────────────────────────────

/** `branch` tracks `origin/<branch>` as a real main checkout does; no remote is contacted. */
function trackOrigin(main: string, branch: string): void {
	git(main, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
	git(main, "config", `branch.${branch}.remote`, "origin");
	git(main, "config", `branch.${branch}.merge`, `refs/heads/${branch}`);
}

/** A repository whose main checkout is on `dev`, tracking origin/dev, one commit behind it. */
function fixtureBehindBase(): Fixture {
	const f = fixture();
	git(f.main, "checkout", "-q", "-b", "dev");
	trackOrigin(f.main, "dev");
	writeFileSync(join(f.main, "b.txt"), "b\n");
	git(f.main, "add", "b.txt");
	git(f.main, "commit", "-q", "-m", "two");
	git(f.main, "update-ref", "refs/remotes/origin/dev", git(f.main, "rev-parse", "HEAD"));
	git(f.main, "reset", "-q", "--hard", "HEAD~1");
	return f;
}

test("a refresh fast-forwards the clean main checkout to its base ref before building the graph", () => {
	const f = fixtureBehindBase();
	const target = git(f.main, "rev-parse", "origin/dev");
	assert.notEqual(git(f.main, "rev-parse", "HEAD"), target, "the checkout starts behind origin/dev");
	const result = refresh(f, f.worktree);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(git(f.main, "rev-parse", "HEAD"), target, "the main checkout was fast-forwarded to its base ref");
	assert.equal(readFileSync(join(f.main, "b.txt"), "utf8"), "b\n", "the fast-forward's file is in the main checkout");
	assert.equal(readFileSync(f.log, "utf8").trim(), `${f.main} update ${f.main}`, "graphify ran in the moved checkout");
	const stamp = readFileSync(join(f.main, "graphify-out", ".refreshed-at"), "utf8").trim().split("\n");
	assert.equal(stamp[0].split(" ")[1], target, "the stamp records the commit the graph was built at");
	assert.equal(stamp[1], `origin/dev ${target}`);
	assert.deepEqual([status(f, f.main).stale, status(f, f.main).due], ["0", "0"]);
	assert.equal(status(f, f.main).note, "", "a checkout that moved needs no note");
});

test("a dirty main checkout is left alone, the note says why, and the note clears once it is clean", () => {
	const f = fixtureBehindBase();
	const before = git(f.main, "rev-parse", "HEAD");
	writeFileSync(join(f.main, "a.txt"), "dirty\n");
	assert.equal(refresh(f, f.main).status, 0);
	assert.equal(git(f.main, "rev-parse", "HEAD"), before, "a dirty checkout is not moved");
	assert.equal(status(f, f.main).note, `uncommitted changes in ${f.main}`);
	git(f.main, "checkout", "--", "a.txt");
	assert.equal(refresh(f, f.main).status, 0);
	assert.equal(git(f.main, "rev-parse", "HEAD"), git(f.main, "rev-parse", "origin/dev"));
	assert.equal(status(f, f.main).note, "", "the note does not outlive its reason");
});

test("a checkout ahead of its base ref, or diverged from it, is not moved and the note names the case", () => {
	const ahead = fixture();
	git(ahead.main, "checkout", "-q", "-b", "dev");
	trackOrigin(ahead.main, "dev");
	writeFileSync(join(ahead.main, "b.txt"), "b\n");
	git(ahead.main, "add", "b.txt");
	git(ahead.main, "commit", "-q", "-m", "local");
	const aheadHead = git(ahead.main, "rev-parse", "HEAD");
	assert.equal(refresh(ahead, ahead.main).status, 0);
	assert.equal(git(ahead.main, "rev-parse", "HEAD"), aheadHead, "a checkout ahead of its base ref is not moved");
	assert.equal(status(ahead, ahead.main).note, "branch dev is ahead of origin/dev");

	const diverged = fixtureBehindBase();
	writeFileSync(join(diverged.main, "c.txt"), "c\n");
	git(diverged.main, "add", "c.txt");
	git(diverged.main, "commit", "-q", "-m", "local");
	git(diverged.main, "checkout", "-q", "-b", "other", "HEAD~1");
	writeFileSync(join(diverged.main, "d.txt"), "d\n");
	git(diverged.main, "add", "d.txt");
	git(diverged.main, "commit", "-q", "-m", "remote");
	git(diverged.main, "update-ref", "refs/remotes/origin/dev", git(diverged.main, "rev-parse", "HEAD"));
	git(diverged.main, "checkout", "-q", "dev");
	const divergedHead = git(diverged.main, "rev-parse", "HEAD");
	assert.equal(refresh(diverged, diverged.main).status, 0);
	assert.equal(git(diverged.main, "rev-parse", "HEAD"), divergedHead, "a diverged checkout is not moved");
	assert.equal(status(diverged, diverged.main).note, "branch dev diverged from origin/dev");

	const unrelated = fixture();
	git(unrelated.main, "checkout", "-q", "-b", "side");
	writeFileSync(join(unrelated.main, "d.txt"), "d\n");
	git(unrelated.main, "add", "d.txt");
	git(unrelated.main, "commit", "-q", "-m", "side");
	git(unrelated.main, "update-ref", "refs/remotes/origin/dev", git(unrelated.main, "rev-parse", "HEAD"));
	git(unrelated.main, "checkout", "-q", "main");
	const unrelatedHead = git(unrelated.main, "rev-parse", "HEAD");
	assert.equal(refresh(unrelated, unrelated.main).status, 0);
	assert.equal(git(unrelated.main, "rev-parse", "HEAD"), unrelatedHead, "a branch without a base ref is not moved");
	assert.equal(status(unrelated, unrelated.main).note, "branch main has no base ref");
});

// ─── a detached main checkout ─────────────────────────────────────────────────

/** The main checkout parked detached (the architect leaves it that way) one commit behind origin/dev. */
function fixtureDetachedBehind(): Fixture {
	const f = fixtureBehindBase();
	git(f.main, "switch", "-q", "--detach");
	return f;
}

test("a detached main checkout behind its base ref is due, and a refresh re-detaches it at that base ref", () => {
	const f = fixtureDetachedBehind();
	const target = git(f.main, "rev-parse", "origin/dev");
	const parked = git(f.main, "rev-parse", "HEAD");
	assert.notEqual(parked, target, "the detached checkout starts behind origin/dev");
	// The state observed on the parked BE checkout: a graph built at its HEAD, the stamp's ref line already at the
	// base ref, so only the distance from the recorded sha to that ref shows the lag.
	mkdirSync(join(f.main, "graphify-out"), { recursive: true });
	writeFileSync(join(f.main, "graphify-out", "graph.json"), "{}\n");
	writeFileSync(join(f.main, "graphify-out", ".refreshed-at"), `${new Date().toISOString()} ${parked}\norigin/dev ${target}\n`);
	const before = status(f, f.main);
	assert.deepEqual([before.sha, before.commits_since, before.stale, before.due], [parked, "1", "1", "1"], "a detached checkout that can move is due, not parked with a note");
	assert.equal(refresh(f, f.main).status, 0);
	assert.equal(git(f.main, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD", "it is moved by re-detaching, never onto a branch");
	assert.equal(git(f.main, "rev-parse", "HEAD"), target, "the detached checkout moved to its base ref");
	assert.equal(readFileSync(join(f.main, "b.txt"), "utf8"), "b\n", "the moved commit's file is in the main checkout");
	assert.equal(readFileSync(f.log, "utf8").trim(), `${f.main} update ${f.main}`, "graphify ran in the moved checkout");
	const stamp = readFileSync(join(f.main, "graphify-out", ".refreshed-at"), "utf8").trim().split("\n");
	assert.equal(stamp[0].split(" ")[1], target, "the stamp records the commit the graph was built at");
	const after = status(f, f.main);
	assert.deepEqual([after.sha, after.stale, after.due, after.note], [target, "0", "0", ""], "the next status is fresh and clean");
});

test("detached: the nearest base ref that has HEAD as an ancestor is the target, ties to the first", () => {
	const f = fixtureDetachedBehind();
	const dev = git(f.main, "rev-parse", "origin/dev");
	const tree = git(f.main, "rev-parse", `${dev}^{tree}`);
	const further = git(f.main, "commit-tree", tree, "-p", dev, "-m", "main moved twice");
	git(f.main, "update-ref", "refs/remotes/origin/main", further);
	assert.equal(refresh(f, f.main).status, 0);
	assert.equal(git(f.main, "rev-parse", "HEAD"), dev, "origin/dev is one commit away, origin/main two");
	// Equal distance from HEAD: the first base ref in BASE_REFS order wins.
	const head = git(f.main, "rev-parse", "HEAD");
	const headTree = git(f.main, "rev-parse", "HEAD^{tree}");
	const side = git(f.main, "commit-tree", headTree, "-p", head, "-m", "dev moved");
	const other = git(f.main, "commit-tree", headTree, "-p", head, "-m", "main moved");
	git(f.main, "update-ref", "refs/remotes/origin/dev", side);
	git(f.main, "update-ref", "refs/remotes/origin/main", other);
	assert.equal(refresh(f, f.main).status, 0);
	assert.equal(git(f.main, "rev-parse", "HEAD"), side, "a tie goes to origin/dev");
});

test("a detached main checkout with a dirty tracked tree, or ahead of every base ref, is left alone with a note", () => {
	const dirty = fixtureDetachedBehind();
	const dirtyHead = git(dirty.main, "rev-parse", "HEAD");
	writeFileSync(join(dirty.main, "a.txt"), "dirty\n");
	assert.equal(refresh(dirty, dirty.main).status, 0);
	assert.equal(git(dirty.main, "rev-parse", "HEAD"), dirtyHead, "a dirty detached checkout is not moved");
	assert.equal(status(dirty, dirty.main).note, `uncommitted changes in ${dirty.main}`);

	const ahead = fixtureBehindBase();
	git(ahead.main, "switch", "-q", "--detach", "origin/dev");
	git(ahead.main, "commit", "-q", "--allow-empty", "-m", "local");
	const aheadHead = git(ahead.main, "rev-parse", "HEAD");
	assert.equal(refresh(ahead, ahead.main).status, 0);
	assert.equal(git(ahead.main, "rev-parse", "HEAD"), aheadHead, "a detached checkout ahead of every base ref is not moved");
	assert.equal(status(ahead, ahead.main).note, "detached HEAD");
});

/**
 * The state that hid 465 commits: `origin/<branch>` gains a commit while the checkout stays where the graph was
 * built. The commit is made off to the side, so the checkout's HEAD does not move and stays behind its base ref.
 */
function advanceBaseRefPastCheckout(f: Fixture, ref: string): string {
	const next = git(f.main, "commit-tree", git(f.main, "rev-parse", "HEAD^{tree}"), "-p", git(f.main, "rev-parse", "HEAD"), "-m", "base moved");
	git(f.main, "update-ref", `refs/remotes/${ref}`, next);
	return next;
}

test("status: the graph is counted against the base ref, not HEAD, so a checkout left behind it is stale and due", () => {
	const f = fixtureBehindBase();
	refresh(f, f.main);
	assert.deepEqual([status(f, f.main).stale, status(f, f.main).due], ["0", "0"], "the refresh moved the checkout to the base ref");
	const behind = git(f.main, "rev-parse", "HEAD");
	const target = advanceBaseRefPastCheckout(f, "origin/dev");
	// The stamp a refresh wrote before the checkout followed its base ref: HEAD's sha, and the base ref at its
	// new commit. The stamp's own comparison therefore agrees with the refs, which is how the lag stayed hidden.
	const stamp = join(f.main, "graphify-out", ".refreshed-at");
	writeFileSync(stamp, `${readFileSync(stamp, "utf8").split("\n")[0]}\norigin/dev ${target}\n`);
	assert.equal(git(f.main, "rev-parse", "HEAD"), behind, "the checkout did not move");
	const observed = status(f, f.main);
	assert.equal(observed.sha, behind, "the graph was built at the checkout's HEAD");
	assert.equal(observed.commits_since, "1", "counted to the base ref, not to HEAD");
	assert.deepEqual([observed.stale, observed.due], ["1", "1"], "the base ref carries a commit the graph does not have");
	assert.equal(refresh(f, f.main).status, 0);
	assert.equal(git(f.main, "rev-parse", "HEAD"), target, "the refresh fast-forwards the checkout to the base ref");
	const after = status(f, f.main);
	assert.deepEqual([after.sha, after.stale, after.due, after.commits_since], [target, "0", "0", "0"], "the next status is fresh");
});

test("status: a graph that already contains the base ref is fresh, so a checkout ahead of it is not refreshed every tick", () => {
	const f = fixtureBehindBase();
	refresh(f, f.main);
	writeFileSync(join(f.main, "c.txt"), "c\n");
	git(f.main, "add", "c.txt");
	git(f.main, "commit", "-q", "-m", "local");
	const ahead = status(f, f.main);
	assert.deepEqual([ahead.stale, ahead.due], ["0", "0"], "a graph built ahead of its base ref already contains it");
	assert.equal(ahead.commits_since, "0", "the base ref carries no commit the graph lacks");
});

test("status: fresh after a refresh, due once a base ref moves, due with no graph", () => {
	const f = fixture();
	assert.deepEqual([status(f, f.main).exists, status(f, f.main).due], ["0", "1"]);
	refresh(f, f.main);
	const fresh = status(f, f.worktree);
	assert.equal(fresh.repo, f.main);
	assert.deepEqual([fresh.exists, fresh.stale, fresh.running, fresh.due], ["1", "0", "0", "0"]);
	assert.equal(fresh.sha, git(f.main, "rev-parse", "HEAD"));
	assert.equal(fresh.commits_since, "0", "the graph was built at HEAD");
	writeFileSync(join(f.main, "b.txt"), "b\n");
	git(f.main, "add", ".");
	git(f.main, "commit", "-q", "-m", "two");
	assert.equal(status(f, f.main).stale, "0", "a commit on the checkout's own branch is not a merge");
	assert.equal(status(f, f.main).commits_since, "0", "counted to the base ref: a local commit ahead of it is not a commit the graph lacks");
	git(f.main, "update-ref", "refs/remotes/origin/main", "HEAD");
	assert.deepEqual([status(f, f.main).stale, status(f, f.main).due], ["1", "1"], "a new origin/main is a merge the graph has not seen");
	refresh(f, f.main);
	assert.deepEqual([status(f, f.main).stale, status(f, f.main).due], ["0", "0"]);
});

test("a refresh that finds another one running exits 0 and runs nothing", async () => {
	const f = fixture();
	refresh(f, f.main);
	const calls = readFileSync(f.log, "utf8").trim().split("\n").length;
	const holder = spawn("flock", [join(f.main, "graphify-out", ".refresh.lock"), "sleep", "3"]);
	await new Promise((done) => setTimeout(done, 400));
	try {
		assert.equal(status(f, f.main).running, "1");
		assert.equal(status(f, f.main).due, "0", "a running refresh is not due again");
		const second = refresh(f, f.main);
		assert.equal(second.status, 0);
		assert.equal(readFileSync(f.log, "utf8").trim().split("\n").length, calls, "graphify was not started");
	} finally {
		holder.kill();
	}
});

test("a failed refresh keeps the old stamp, reports graphify's exit code and backs off", () => {
	const f = fixture();
	refresh(f, f.main);
	const before = readFileSync(join(f.main, "graphify-out", ".refreshed-at"), "utf8");
	git(f.main, "update-ref", "refs/remotes/origin/main", "HEAD");
	const failed = spawnSync(GRAPH_REFRESH_SCRIPT, [f.main], { encoding: "utf8", env: { ...f.env, FAKE_GRAPHIFY_FAIL: "1" } });
	assert.equal(failed.status, 3);
	assert.equal(readFileSync(join(f.main, "graphify-out", ".refreshed-at"), "utf8"), before);
	const after = status(f, f.main);
	assert.deepEqual([after.stale, after.due], ["1", "0"], "still behind, but not retried within the back-off");
	assert.notEqual(after.failed_at, "");
});

test("a path outside any repository is a usage error", () => {
	const f = fixture();
	assert.equal(refresh(f, "--status", tmp("not-a-repo")).status, 2);
	assert.equal(refresh(f).status, 2);
});

// ─── the nudge ───────────────────────────────────────────────────────────────

function nudge(f: Fixture, call: Record<string, unknown>, ...args: string[]) {
	return spawnSync(GRAPH_NUDGE_SCRIPT, args, { encoding: "utf8", env: f.env, input: JSON.stringify(call) });
}

const search = (f: Fixture, session: string, command = "grep -rn needle .") => ({ session_id: session, cwd: f.worktree, tool_name: "Bash", tool_input: { command } });

test("the nudge fires once per session on the first search, from a worktree, and names the main checkout's graph", () => {
	const f = fixture();
	refresh(f, f.main);
	assert.equal(nudge(f, search(f, "s1", "ls -la")).stdout, "", "not a search");
	const first = nudge(f, search(f, "s1"));
	assert.equal(first.status, 0, first.stderr);
	const context = JSON.parse(first.stdout).hookSpecificOutput;
	assert.equal(context.hookEventName, "PreToolUse");
	assert.ok(context.additionalContext.includes(join(f.main, "graphify-out", "GRAPH_REPORT.md")), "the report path is the main checkout's");
	assert.ok(context.additionalContext.includes(`graphify query "<question>" --graph "${join(f.main, "graphify-out", "graph.json")}"`));
	assert.match(context.additionalContext, /graphify path "A" "B" --graph/);
	assert.match(context.additionalContext, /graphify explain "X" --graph/);
	assert.doesNotMatch(context.additionalContext, /graph-refresh\.sh/, "a fresh graph is not told to refresh");
	assert.equal(nudge(f, search(f, "s1", "rg other")).stdout, "", "the same session is nudged once");
	assert.notEqual(nudge(f, search(f, "s2", "find . -name x")).stdout, "", "another session is nudged");
});

test("a graph behind the last merge adds the refresh command; --text prints the plain message; a Pi grep call counts", () => {
	const f = fixture();
	refresh(f, f.main);
	git(f.main, "update-ref", "refs/remotes/origin/main", "HEAD");
	const text = nudge(f, { session_id: "p1", cwd: f.worktree, tool_name: "grep", tool_input: { pattern: "x" } }, "--text");
	assert.match(text.stdout, /^graphify: /);
	assert.ok(text.stdout.includes(`run ${GRAPH_REFRESH_SCRIPT} ${f.main} first`), text.stdout);
});

test("no graph means no nudge and no marker, so the session is told once a graph exists", () => {
	const f = fixture();
	assert.equal(nudge(f, search(f, "s1")).stdout, "");
	refresh(f, f.main);
	assert.notEqual(nudge(f, search(f, "s1")).stdout, "");
});

test("Pi's hook helper returns the text once and undefined when there is nothing to say", () => {
	const f = fixture();
	refresh(f, f.main);
	const call = { sessionId: "pi-1", cwd: f.worktree, toolName: "bash", input: { command: "grep -rn x ." } };
	const text = graphNudge(call, GRAPH_NUDGE_SCRIPT, f.env);
	assert.ok(text?.startsWith("graphify: "), String(text));
	assert.equal(graphNudge(call, GRAPH_NUDGE_SCRIPT, f.env), undefined);
	assert.equal(graphNudge({ ...call, sessionId: "pi-2", input: { command: "npm test" } }, GRAPH_NUDGE_SCRIPT, f.env), undefined);
});

// ─── the wrapper ─────────────────────────────────────────────────────────────

test("parseGraphStatus reads the script's lines and refuses output without a repo", () => {
	const parsed = parseGraphStatus("repo=/r\ngraph=/r/graphify-out/graph.json\nreport=/r/graphify-out/GRAPH_REPORT.md\nexists=1\nrefreshed_at=1791761226\nsha=abc\ncommits_since=7\nstale=1\nfailed_at=\nrunning=0\ndue=1\n");
	assert.deepEqual(parsed, { repo: "/r", graph: "/r/graphify-out/graph.json", report: "/r/graphify-out/GRAPH_REPORT.md", exists: true, refreshedAt: 1791761226000, sha: "abc", commitsSince: 7, stale: true, running: false, due: true });
	assert.equal(parseGraphStatus("exists=1\n"), undefined);
	const missing = parseGraphStatus("repo=/r\ngraph=/g\nreport=/p\nexists=0\ndue=1\n");
	assert.deepEqual([missing?.exists, missing?.refreshedAt, missing?.due], [false, undefined, true]);
});

test("graphStatus reads the live script and answers undefined outside a repository", () => {
	const f = fixture();
	refresh(f, f.main);
	const live = graphStatus(f.worktree);
	assert.equal(live?.repo, f.main);
	assert.equal(live?.exists, true);
	assert.equal(graphStatus(tmp("not-a-repo")), undefined);
});

test("the tick pass starts a refresh only for a repository whose graph exists and is due", () => {
	const status = (over: Partial<GraphStatus>): GraphStatus => ({ repo: "/r", graph: "/r/g", report: "/r/p", exists: true, stale: false, running: false, due: false, ...over });
	const byRepo: Record<string, GraphStatus | undefined> = {
		"/fresh": status({ repo: "/fresh" }),
		"/behind": status({ repo: "/behind", stale: true, due: true, sha: "1234567890" }),
		"/never": status({ repo: "/never", exists: false, due: true }),
		"/running": status({ repo: "/running", stale: true, running: true }),
		"/unreadable": undefined,
	};
	const started: string[] = [];
	const result = graphRefreshPass({ repos: () => Object.keys(byRepo), status: (repo) => byRepo[repo], start: (repo) => void started.push(repo) });
	assert.deepEqual(started, ["/behind"]);
	assert.deepEqual(result, [{ repo: "/behind", reason: "origin/dev or origin/main moved since 1234567" }]);
});

test("a rebuild request starts one transient unit with a fixed argv, and starts nothing while a refresh runs", async () => {
	const f = fixture();
	refresh(f, f.main);
	const argv = ["--user", "--unit", "graph-refresh-demo", "--collect", GRAPH_REFRESH_SCRIPT, f.main];
	assert.deepEqual(graphRefreshRequestArgv("demo", f.main), argv, "a fixed argument list, and the script from the agent folder");
	const starts: string[][] = [];
	const run = (called: string[]) => {
		starts.push(called);
		return { ok: true, detail: "started" };
	};
	const first = requestGraphRefresh({ repo: f.main, projectId: "demo", run });
	assert.deepEqual([first.started, first.unit], [true, "graph-refresh-demo"]);
	assert.deepEqual(starts, [argv]);
	const refused = requestGraphRefresh({ repo: f.main, projectId: "demo", run: () => ({ ok: false, detail: "Unit graph-refresh-demo.service already exists." }) });
	assert.equal(refused.started, false, "systemd refusing the unit is not a start");
	assert.match(refused.detail, /already exists/);
	const holder = spawn("flock", [join(f.main, "graphify-out", ".refresh.lock"), "sleep", "3"]);
	await new Promise((done) => setTimeout(done, 400));
	try {
		const second = requestGraphRefresh({ repo: f.main, projectId: "demo", run });
		assert.equal(second.started, false);
		assert.match(second.detail, /a refresh is already running/);
		assert.equal(starts.length, 1, "no second unit was started");
	} finally {
		holder.kill();
	}
	const outside = requestGraphRefresh({ repo: tmp("not-a-repo"), projectId: "demo", run });
	assert.equal(outside.started, false);
	assert.match(outside.detail, /not a repository/);
	assert.equal(starts.length, 1, "nothing was started for a path the script cannot read");
});
