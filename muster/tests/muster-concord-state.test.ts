import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { workspaceInitialized } from "../binding.ts";
import { concordStateDirFor, relocateConcordState } from "../concord-state.ts";

/**
 * R1 item 9 (AM3): Concord's `.concord` directory (database, WAL, work state,
 * events) is rewritten every few seconds by every lane. Inside the working tree
 * that wakes the dev server's file watcher. Concord 0.10.4 has no configurable
 * database path, so the directory is moved outside and a symlink takes its place:
 * nothing vendored is patched, and every Concord process still opens
 * `<root>/.concord/concord.db`.
 */

type Fixture = { dir: string; root: string; stateRoot: string; repoKey: string };

function withRepo(run: (f: Fixture) => void, options: { concord?: boolean } = {}): void {
	const dir = mkdtempSync(join(tmpdir(), "muster-concord-state-"));
	const root = join(dir, "repo");
	mkdirSync(root, { recursive: true });
	execFileSync("git", ["init", "-q", "-b", "main", root]);
	if (options.concord !== false) {
		mkdirSync(join(root, ".concord"));
		writeFileSync(join(root, ".concord", "concord.db"), "db bytes");
		writeFileSync(join(root, ".concord", "concord.db-wal"), "wal bytes");
		writeFileSync(join(root, ".concord", "WORK_STATE.json"), "{}");
	}
	const stateRoot = join(dir, "state", "concord");
	try {
		run({ dir, root, stateRoot, repoKey: join(root, ".git") });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ─── The cutover command ─────────────────────────────────────────────────────

function runCli(args: string[], env: Record<string, string>): { code: number; stdout: string; stderr: string } {
	const script = new URL("../../../scripts/muster-concord-relocate.mts", import.meta.url).pathname;
	try {
		const stdout = execFileSync(process.execPath, ["--import", "tsx", script, ...args], { env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1", ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { code: 0, stdout, stderr: "" };
	} catch (error) {
		const failure = error as { status?: number; stdout?: string; stderr?: string };
		return { code: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
	}
}

test("the command is a dry run unless told to apply, prints the plan as JSON, and exits non-zero on a refusal", () => withRepo((f) => {
	const env = { PI_MUSTER_STATE_DIR: join(f.dir, "state") };
	const dry = runCli([f.root], env);
	assert.equal(dry.code, 0, dry.stderr);
	const plan = JSON.parse(dry.stdout) as { action: string; applied: boolean };
	assert.deepEqual([plan.action, plan.applied], ["migrate", false]);
	assert.equal(lstatSync(join(f.root, ".concord")).isDirectory(), true);
	const applied = runCli([f.root, "--apply"], env);
	assert.equal(applied.code, 0, applied.stderr);
	assert.equal(lstatSync(join(f.root, ".concord")).isSymbolicLink(), true);
	mkdirSync(join(f.root, "sub"));
	// A directory that is not a repository's primary root is resolved to it, never moved on its own.
	assert.equal(runCli([join(f.root, "sub"), "--apply"], env).code, 0, "a subdirectory resolves to the repository: already relocated");
	rmSync(join(f.root, ".concord"));
	mkdirSync(join(f.root, ".concord"));
	const refused = runCli([f.root, "--apply"], env);
	assert.equal(refused.code, 1);
	assert.match(refused.stderr, /already holds/);
}));

test("the external directory is stable for a repository and differs between repositories", () => {
	const a = concordStateDirFor("/projects/crm-app/.git", "/state/concord");
	assert.equal(a, concordStateDirFor("/projects/crm-app/.git", "/state/concord"));
	assert.notEqual(a, concordStateDirFor("/projects/other/.git", "/state/concord"));
	assert.match(a, /^\/state\/concord\/crm-app-[0-9a-f]{12}$/);
});

test("a dry run reports the move and changes nothing", () => withRepo((f) => {
	const result = relocateConcordState({ primaryRoot: f.root, repoKey: f.repoKey, stateRoot: f.stateRoot, apply: false });
	assert.equal(result.action, "migrate");
	assert.equal(result.applied, false);
	assert.equal(lstatSync(join(f.root, ".concord")).isDirectory(), true);
	assert.equal(existsSync(f.stateRoot), false);
}));

test("apply moves the whole directory, keeps the same files and inode, and leaves a symlink Concord can open through", () => withRepo((f) => {
	const inodeBefore = statSync(join(f.root, ".concord", "concord.db")).ino;
	const result = relocateConcordState({ primaryRoot: f.root, repoKey: f.repoKey, stateRoot: f.stateRoot, apply: true });
	assert.equal(result.action, "migrate");
	assert.equal(result.applied, true);
	const target = concordStateDirFor(f.repoKey, f.stateRoot);
	assert.equal(lstatSync(join(f.root, ".concord")).isSymbolicLink(), true);
	assert.equal(readlinkSync(join(f.root, ".concord")), target);
	assert.equal(readFileSync(join(target, "concord.db-wal"), "utf8"), "wal bytes", "the WAL moved with the database");
	assert.equal(readFileSync(join(target, "WORK_STATE.json"), "utf8"), "{}");
	assert.equal(statSync(join(f.root, ".concord", "concord.db")).ino, inodeBefore, "a rename, not a copy");
	assert.equal(workspaceInitialized(f.root), true, "Muster still sees an initialized workspace through the link");
}));

test("a second apply changes nothing", () => withRepo((f) => {
	relocateConcordState({ primaryRoot: f.root, repoKey: f.repoKey, stateRoot: f.stateRoot, apply: true });
	const again = relocateConcordState({ primaryRoot: f.root, repoKey: f.repoKey, stateRoot: f.stateRoot, apply: true });
	assert.equal(again.action, "already-relocated");
	assert.equal(again.applied, false);
}));

test("the link is excluded from git, once, without touching tracked files", () => withRepo((f) => {
	relocateConcordState({ primaryRoot: f.root, repoKey: f.repoKey, stateRoot: f.stateRoot, apply: true });
	relocateConcordState({ primaryRoot: f.root, repoKey: f.repoKey, stateRoot: f.stateRoot, apply: true });
	const exclude = readFileSync(join(f.root, ".git", "info", "exclude"), "utf8");
	assert.equal(exclude.split("\n").filter((line) => line.trim() === ".concord").length, 1);
	assert.equal(execFileSync("git", ["-C", f.root, "status", "--short"], { encoding: "utf8" }).trim(), "", "git status stays clean");
}));

test("a database that a process still has open is not moved", () => withRepo((f) => {
	const handle = openSync(join(f.root, ".concord", "concord.db"), "r");
	try {
		const result = relocateConcordState({ primaryRoot: f.root, repoKey: f.repoKey, stateRoot: f.stateRoot, apply: true });
		assert.equal(result.action, "refuse");
		assert.match(result.reason ?? "", /open/);
		assert.equal(lstatSync(join(f.root, ".concord")).isDirectory(), true, "nothing moved");
	} finally {
		closeSync(handle);
	}
	assert.equal(relocateConcordState({ primaryRoot: f.root, repoKey: f.repoKey, stateRoot: f.stateRoot, apply: true }).applied, true, "settled lanes: it moves");
}));

test("a target that already holds files is never overwritten", () => withRepo((f) => {
	const target = concordStateDirFor(f.repoKey, f.stateRoot);
	mkdirSync(target, { recursive: true });
	writeFileSync(join(target, "concord.db"), "someone else's");
	const result = relocateConcordState({ primaryRoot: f.root, repoKey: f.repoKey, stateRoot: f.stateRoot, apply: true });
	assert.equal(result.action, "refuse");
	assert.match(result.reason ?? "", /already holds/);
	assert.equal(readFileSync(join(target, "concord.db"), "utf8"), "someone else's");
	assert.equal(lstatSync(join(f.root, ".concord")).isDirectory(), true);
}));

test("a move across filesystems is refused: copying a live WAL database is not safe", () => withRepo((f) => {
	const result = relocateConcordState({ primaryRoot: f.root, repoKey: f.repoKey, stateRoot: f.stateRoot, apply: true, sameFilesystem: () => false });
	assert.equal(result.action, "refuse");
	assert.match(result.reason ?? "", /filesystem/);
	assert.equal(lstatSync(join(f.root, ".concord")).isDirectory(), true);
}));

test("a link that points somewhere else is left alone", () => withRepo((f) => {
	rmSync(join(f.root, ".concord"), { recursive: true });
	mkdirSync(join(f.dir, "elsewhere"));
	execFileSync("ln", ["-s", join(f.dir, "elsewhere"), join(f.root, ".concord")]);
	const result = relocateConcordState({ primaryRoot: f.root, repoKey: f.repoKey, stateRoot: f.stateRoot, apply: true });
	assert.equal(result.action, "refuse");
	assert.match(result.reason ?? "", /points elsewhere/);
}));

test("a repository with no .concord yet gets its external directory and link, ready for concord init", () => withRepo((f) => {
	const result = relocateConcordState({ primaryRoot: f.root, repoKey: f.repoKey, stateRoot: f.stateRoot, apply: true });
	assert.equal(result.action, "create");
	assert.equal(lstatSync(join(f.root, ".concord")).isSymbolicLink(), true);
	writeFileSync(join(f.root, ".concord", "concord.db"), "new");
	assert.equal(readFileSync(join(concordStateDirFor(f.repoKey, f.stateRoot), "concord.db"), "utf8"), "new", "Concord's writes land outside the tree");
}, { concord: false }));
