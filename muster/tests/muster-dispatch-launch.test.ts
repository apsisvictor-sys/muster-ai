import "./muster-test-isolation.ts";
/**
 * OL2 (out-loop spec Revision 3 §9, §10 row OL2, §11 rules 1–2; VR24-210, VR24-208): the dispatcher's effects,
 * on this side of the port.
 *
 * Every launch path here is exercised with the launcher injected (a fake that records argv), a scratch state
 * directory and a scratch git repository: no lane is started, no gate stamp is spent and nothing on this
 * machine is touched. What each fixture proves:
 *   1. the argv the launcher receives: lane, title, goal-or-no-goal, brief, worktree, harness, item,
 *      `--launched-by dispatcher`, `--no-attach`, and no `--model` (the router picks);
 *   2. the worktree step at a verified base: an isolated clean worktree on its own branch, a base that is not
 *      a commit refused before anything is created, and an existing checkout preserved;
 *   3. a failed launch undoes only its own clean worktree, and keeps one that holds work;
 *   4. the switch: a missing or unknown mode file is `off`, `shadow` and `on` are read as themselves, and the
 *      shadow line lands in the routing state dir as one JSON line;
 *   5. the lane record carries the item, a live lane id is refused unless the launch says `--respawn`, and the
 *      slot count is `routing.slots` minus the lanes that hold one.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	appendDispatchShadow,
	createLaneWorktree,
	DISPATCH_MODE_FILE,
	DISPATCH_SHADOW_FILE,
	dispatchAssignedLane,
	freeWorkerSlots,
	laneLauncherArgv,
	liveLaneRecords,
	readDispatchMode,
	removeLaneWorktree,
} from "../dispatch-launch.ts";
import { laneBranchFor, type LaunchRequest } from "../dispatch.ts";
import { listLaneRecords, readLaneRecord, recordLaunch } from "../lane-lifecycle.ts";

function scratch(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** A repository with one commit: the base every worktree fixture starts from. */
function scratchRepo(root: string): { repo: string; sha: string } {
	const repo = join(root, "repo");
	mkdirSync(repo, { recursive: true });
	const git = (...args: string[]): string =>
		execFileSync("git", ["-C", repo, "-c", "user.email=test@example.invalid", "-c", "user.name=Test", ...args], { encoding: "utf8" });
	git("init", "--initial-branch=main");
	writeFileSync(join(repo, "README.md"), "the base\n");
	git("add", "README.md");
	git("commit", "-m", "the base");
	return { repo, sha: git("rev-parse", "HEAD").trim() };
}

function request(over: Partial<LaunchRequest> = {}): LaunchRequest {
	return {
		code: "OL2B",
		lane: "ol2b-a1",
		attempt: 1,
		briefPath: "/state/muster/briefs/lane-prompt-ol2b-1849.md",
		title: "Rebuild the dispatcher on the current main",
		goal: "out-loop",
		repo: "/tmp/repo",
		base: "bfd73551624f",
		laneRoot: "/state/muster/lanes/ol2b-a1",
		branch: "lane/ol2b-a1",
		harness: "pi",
		...over,
	};
}

// ─── 1. the argv ────────────────────────────────────────────────────────────

test("the launcher's argv states one lane, its brief, its worktree and its harness, and never a model", () => {
	assert.deepEqual(laneLauncherArgv(request()), [
		"--lane", "ol2b-a1",
		"--title", "Rebuild the dispatcher on the current main",
		"--goal", "out-loop",
		"--brief", "/state/muster/briefs/lane-prompt-ol2b-1849.md",
		"--cwd", "/state/muster/lanes/ol2b-a1",
		"--harness", "pi",
		"--item", "OL2B",
		"--launched-by", "dispatcher",
		"--no-attach",
	]);
	const argv = laneLauncherArgv(request());
	assert.equal(argv.includes("--model"), false, "the router picks the model; the dispatcher never names one");
	assert.equal(argv.includes("--attach"), false, "nothing waits on a terminal that is not there");
	assert.equal(argv[argv.indexOf("--launched-by") + 1], "dispatcher", "the record says the dispatcher started it");
	assert.deepEqual(laneLauncherArgv(request({ goal: undefined })), [
		"--lane", "ol2b-a1",
		"--title", "Rebuild the dispatcher on the current main",
		"--no-goal",
		"--brief", "/state/muster/briefs/lane-prompt-ol2b-1849.md",
		"--cwd", "/state/muster/lanes/ol2b-a1",
		"--harness", "pi",
		"--item", "OL2B",
		"--launched-by", "dispatcher",
		"--no-attach",
	]);
});

// ─── 2. the worktree step ───────────────────────────────────────────────────

test("the worktree step creates an isolated clean checkout at the verified base, on the lane's own branch", async () => {
	const root = scratch("muster-dispatch-worktree-");
	try {
		const { repo, sha } = scratchRepo(root);
		const laneRoot = join(root, "state", "lanes", "ol2b-a1");
		const made = await createLaneWorktree({ repo, base: sha.slice(0, 7), laneRoot, branch: laneBranchFor("ol2b-a1") });
		assert.deepEqual(made, { ok: true, sha }, "an abbreviated base is resolved to the full commit the brief named");
		assert.ok(existsSync(join(laneRoot, "README.md")), "the checkout holds the base's own tree");
		const git = (args: string[]): string => execFileSync("git", ["-C", laneRoot, ...args], { encoding: "utf8" }).trim();
		assert.equal(git(["rev-parse", "HEAD"]), sha, "the checkout is at the base, not at whatever the repository had");
		assert.equal(git(["symbolic-ref", "--short", "HEAD"]), "lane/ol2b-a1", "the lane has its own branch");
		assert.equal(git(["status", "--porcelain", "--untracked-files=all"]), "", "the checkout is clean");
		const source = execFileSync("git", ["-C", repo, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
		assert.notEqual(git(["rev-parse", "--absolute-git-dir"]), source, "the lane is its own writer checkout");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a base that is not a commit is refused before anything is created", async () => {
	const root = scratch("muster-dispatch-badbase-");
	try {
		const { repo } = scratchRepo(root);
		const laneRoot = join(root, "state", "lanes", "ol2b-a1");
		const made = await createLaneWorktree({ repo, base: "0123456789abcdef", laneRoot, branch: "lane/ol2b-a1" });
		assert.equal(made.ok, false);
		assert.match((made as { error: string }).error, /is not a commit in/);
		assert.equal(existsSync(laneRoot), false, "nothing was created for a base that does not exist");
		const mid = await createLaneWorktree({ repo, base: "not-a-sha", laneRoot, branch: "lane/ol2b-a1" });
		assert.equal(mid.ok, false);
		assert.match((mid as { error: string }).error, /verified 40-hex base SHA is required/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an existing checkout is never reused and never removed: a shared directory is refused as it stands", async () => {
	const root = scratch("muster-dispatch-existing-");
	try {
		const { repo, sha } = scratchRepo(root);
		const laneRoot = join(root, "state", "lanes", "ol2b-a1");
		mkdirSync(laneRoot, { recursive: true });
		writeFileSync(join(laneRoot, "unfamiliar.txt"), "someone else's work\n");
		const made = await createLaneWorktree({ repo, base: sha, laneRoot, branch: laneBranchFor("ol2b-a1") });
		assert.equal(made.ok, false);
		assert.match((made as { error: string }).error, /not an isolated clean worktree at .*; existing work was preserved/);
		assert.ok(existsSync(join(laneRoot, "unfamiliar.txt")), "the directory was not touched");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ─── 3. the launch, with the launcher injected ──────────────────────────────

test("dispatchAssignedLane creates the worktree and hands the launcher its argv, with no process started here", async () => {
	const root = scratch("muster-dispatch-launch-");
	try {
		const { repo, sha } = scratchRepo(root);
		const laneRoot = join(root, "state", "lanes", "ol2b-a1");
		const briefPath = join(root, "brief.md");
		writeFileSync(briefPath, "Outcome: x\n");
		const seen: LaunchRequest[] = [];
		const outcome = await dispatchAssignedLane(request({ repo, base: sha, laneRoot, briefPath }), {}, async (sent) => {
			seen.push(sent);
			return { launched: true };
		});
		assert.equal(outcome.launched, true);
		assert.equal(seen.length, 1);
		assert.equal(seen[0]!.laneRoot, laneRoot, "the lane runs in its own worktree, never the shared checkout");
		assert.deepEqual(laneLauncherArgv(seen[0]!), laneLauncherArgv(request({ repo, base: sha, laneRoot, briefPath })));
		assert.ok(existsSync(join(laneRoot, "README.md")), "the worktree the lane was given exists");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a failed launch removes only the worktree that attempt made, and keeps one holding work", async () => {
	const root = scratch("muster-dispatch-clean-up-");
	try {
		const { repo, sha } = scratchRepo(root);
		const laneRoot = join(root, "state", "lanes", "ol2b-a1");
		const refused = await dispatchAssignedLane(request({ repo, base: sha, laneRoot }), {}, async () => ({
			launched: false,
			error: "pi-lane-launch: a new lane needs --title",
			exitCode: 3,
		}));
		assert.equal(refused.launched, false);
		assert.match(refused.error ?? "", /the attempt's clean worktree was removed/);
		assert.equal(existsSync(laneRoot), false, "a refusal that started nothing leaves no checkout behind");
		// A worktree the lane has written in is preserved, and its reason says so.
		const kept = await dispatchAssignedLane(request({ repo, base: sha, laneRoot }), {}, async (sent) => {
			writeFileSync(join(sent.laneRoot, "work-in-progress.txt"), "a lane's work\n");
			return { launched: false, error: "the launcher failed", exitCode: 1 };
		});
		assert.equal(kept.launched, false);
		assert.match(kept.error ?? "", /the attempt's worktree was kept \(it holds work\)/);
		assert.ok(existsSync(join(laneRoot, "work-in-progress.txt")), "a worker's work is never removed to tidy up");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("removeLaneWorktree says plainly when there was nothing to remove", async () => {
	const root = scratch("muster-dispatch-nothing-");
	try {
		const { repo } = scratchRepo(root);
		const result = await removeLaneWorktree({ repo, laneRoot: join(root, "absent") });
		assert.deepEqual(result, { removed: false, reason: "there was no worktree to remove" });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ─── 4. the switch ──────────────────────────────────────────────────────────

test("the switch is a file: missing or unknown is off, shadow and on are read as themselves", () => {
	const root = scratch("muster-dispatch-mode-");
	try {
		assert.equal(readDispatchMode(root), "off", "a machine nobody enabled launches nothing");
		writeFileSync(join(root, DISPATCH_MODE_FILE), " shadow\n");
		assert.equal(readDispatchMode(root), "shadow");
		writeFileSync(join(root, DISPATCH_MODE_FILE), "on\n");
		assert.equal(readDispatchMode(root), "on");
		writeFileSync(join(root, DISPATCH_MODE_FILE), "enabled\n");
		assert.equal(readDispatchMode(root), "off", "a word the switch does not know is the rollback, never a guess");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a shadow line is one JSON line in the routing state dir, beside the orchestrator's launches", () => {
	const root = scratch("muster-dispatch-shadow-");
	try {
		appendDispatchShadow(root, { by: "dispatcher", item: "OL2B", lane: "ol2b-a1" });
		appendDispatchShadow(root, { by: "dispatcher", item: "OL3", lane: "ol3-a1" });
		const lines = readFileSync(join(root, DISPATCH_SHADOW_FILE), "utf8").trim().split("\n");
		assert.equal(lines.length, 2);
		assert.deepEqual(JSON.parse(lines[0]!), { by: "dispatcher", item: "OL2B", lane: "ol2b-a1" });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ─── 5. the lane record and the slot count ─────────────────────────────────

test("the lane record carries the item across a relaunch, so a crash is resolved from the record", () => {
	const stateDir = scratch("muster-dispatch-record-");
	try {
		const record = recordLaunch(stateDir, { laneId: "ol2b-a1", harness: "pi", cwd: "/w", branch: "lane/ol2b-a1", launchedBy: "dispatcher", title: "The dispatcher's lane", item: "OL2B" });
		assert.equal(record.item, "OL2B", "the record says which item the lane serves, so a crash is resolvable");
		assert.equal(record.launchedBy, "dispatcher");
		// A live record is the same lane coming back: it takes the new facts, keeps its phase, keeps its item.
		const again = recordLaunch(stateDir, { laneId: "ol2b-a1", harness: "pi", cwd: "/w2", branch: "lane/ol2b-a1", launchedBy: "dispatcher" });
		assert.equal(again.item, "OL2B", "the item is sticky across a relaunch");
		assert.equal(again.cwd, "/w2");
		assert.equal(again.phase, "working", "a relaunch keeps the lane's phase");
		assert.deepEqual(liveLaneRecords(stateDir).map((lane) => lane.item), ["OL2B"], "a live record names its item");
		assert.equal(readLaneRecord(stateDir, "ol2b-a1")?.phase, "working");
		assert.equal(listLaneRecords(stateDir).length, 1, "a respawn replaces the record, it does not add a second");
	} finally {
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("free worker slots are routing.slots minus the lanes that hold one", () => {
	const stateDir = scratch("muster-dispatch-slots-");
	try {
		const pool = { routing: { slots: 4 } } as unknown as Parameters<typeof freeWorkerSlots>[2];
		assert.equal(freeWorkerSlots(stateDir, {}, pool), 4, "an empty machine has every slot free");
		const capped = { routing: { slots: 0 } } as unknown as Parameters<typeof freeWorkerSlots>[2];
		assert.equal(freeWorkerSlots(stateDir, {}, capped), 0, "a cap of zero launches nothing");
	} finally {
		rmSync(stateDir, { recursive: true, force: true });
	}
});
