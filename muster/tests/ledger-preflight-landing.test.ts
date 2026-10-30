import "./muster-test-isolation.ts";
/**
 * The flip preflight's landing commit resolves in the checkout the Muster code stands in,
 * not in the workspace the CLI happens to run from.
 *
 * The defect (2026-10-29): `scripts/muster-release.sh flip <sha>` refused a valid release
 * with `--landing <sha> is not a commit in this checkout`, because `landingCommit()` asked
 * `git -C <repoRoot>`, and `repoRoot` is the Concord workspace (`--repo`, else cwd) — the
 * profile checkout, which holds no Muster commit at all.
 *
 * 1. A commit that exists in the Muster checkout and not in the invoking one resolves, and
 *    the committer time it reads is the one the process check compares with.
 * 2. A commit that exists only in the invoking checkout is still refused.
 * 3. A SHA that exists nowhere is still refused, in the wording it already had.
 * 4. The LC10 fallback still resolves in the Muster checkout, and a process older than that
 *    commit is restart-needed, not a refusal (VR24-229 item 7: only a live worker lane refuses).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { harnessFlipChecks, type LedgerTool, type ProcRow } from "../cli/ledger.ts";

/** The refusal a SHA outside the Muster checkout earns, in the wording it already had. */
const NOT_A_COMMIT = (sha: string): string => `--landing ${sha} is not a commit in this checkout`;

function git(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** One repository with one empty commit at `date`, which is the SHA this test names. */
function repoWithCommit(root: string, name: string, message: string, date: string): { dir: string; sha: string } {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	assert.equal(git(dir, ["init", "--quiet"]).status, 0);
	const committed = git(dir, ["-c", "user.email=fixture@example.test", "-c", "user.name=fixture", "commit", "--quiet", "--allow-empty", "-m", message], {
		GIT_AUTHOR_DATE: date,
		GIT_COMMITTER_DATE: date,
	});
	assert.equal(committed.status, 0, committed.stderr);
	const shown = git(dir, ["rev-parse", "HEAD"]);
	assert.equal(shown.status, 0, shown.stderr);
	return { dir, sha: shown.stdout.trim() };
}

/**
 * The ledger tool with two checkouts: `invoking` is what `repoRoot` answers (the workspace the
 * CLI runs in), `code` is the tree the Muster code stands in. Everything else is empty: no
 * lane, no process, no spool, so only the landing commit decides.
 */
function toolFor(options: { invoking: string; code: string; processes?: ProcRow[] }): LedgerTool {
	const stateDir = join(options.invoking, "state", "muster");
	const inRoot = (root: string) => (args: string[]) => {
		const shown = git(root, args);
		return { status: shown.status, stdout: shown.stdout };
	};
	return {
		stateDir,
		ledgerDir: stateDir,
		socketPath: join(stateDir, "musterd.sock"),
		repoRoot: options.invoking,
		env: {},
		now: () => Date.now(),
		out: () => {},
		err: () => {},
		git: inRoot(options.invoking),
		gitInCode: inRoot(options.code),
		systemctl: () => ({ status: 1, stdout: "" }),
		leaseHeld: () => false,
		leasesDir: join(stateDir, "leases"),
		processes: () => options.processes ?? [],
		processEnv: () => ({}),
		lanes: () => [],
		spoolCount: () => 0,
	};
}

function processesCheck(checks: ReturnType<typeof harnessFlipChecks>): { check: string; ok: boolean; detail: string } {
	const found = checks.find((check) => check.check === "processes");
	assert.ok(found, "the preflight has a processes check");
	return found;
}

async function withRoot(run: (root: string) => void): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "muster-landing-"));
	try {
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("a landing commit in the Muster checkout resolves, and its committer time is compared", async () => {
	await withRoot((root) => {
		const code = repoWithCommit(root, "muster", "a Muster commit", "2026-10-29T10:00:00+02:00");
		const invoking = repoWithCommit(root, "profile", "a profile commit", "2026-10-29T10:00:00+02:00");
		// The invoking checkout cannot answer for it: this is the refusal the fix removes.
		assert.notEqual(git(invoking.dir, ["cat-file", "-e", `${code.sha}^{commit}`]).status, 0);

		const fresh: ProcRow = { pid: 4242, ppid: 1, comm: "node", args: [join(code.dir, "muster", "bin", "muster.mts")], startMs: Date.now() };
		const check = processesCheck(harnessFlipChecks(toolFor({ invoking: invoking.dir, code: code.dir, processes: [fresh] }), { landing: code.sha, roots: { harnessTrees: [code.dir] } }));
		assert.equal(check.ok, true, check.detail);
		assert.match(check.detail, /1 Muster process\(es\), all started after the landing commit/);
	});
});

test("a landing commit that exists only in the invoking checkout is still refused", async () => {
	await withRoot((root) => {
		const code = repoWithCommit(root, "muster", "a Muster commit", "2026-10-29T10:00:00+02:00");
		const invoking = repoWithCommit(root, "profile", "a profile commit", "2026-10-29T10:00:00+02:00");
		const check = processesCheck(harnessFlipChecks(toolFor({ invoking: invoking.dir, code: code.dir }), { landing: invoking.sha }));
		assert.equal(check.ok, false);
		assert.equal(check.detail, NOT_A_COMMIT(invoking.sha));
	});
});

test("a landing SHA that exists nowhere is still refused", async () => {
	await withRoot((root) => {
		const code = repoWithCommit(root, "muster", "a Muster commit", "2026-10-29T10:00:00+02:00");
		const invoking = repoWithCommit(root, "profile", "a profile commit", "2026-10-29T10:00:00+02:00");
		const absent = "0123456789abcdef0123456789abcdef01234567";
		const check = processesCheck(harnessFlipChecks(toolFor({ invoking: invoking.dir, code: code.dir }), { landing: absent }));
		assert.equal(check.ok, false);
		assert.equal(check.detail, NOT_A_COMMIT(absent));
	});
});

test("the LC10 fallback resolves in the Muster checkout, and a process older than it is restart-needed, not a refusal", async () => {
	await withRoot((root) => {
		const code = repoWithCommit(root, "muster", "Merge lane/lc10: the durable ledger cutover", "2020-01-01T00:00:00+02:00");
		const invoking = repoWithCommit(root, "profile", "a profile commit", "2026-10-29T10:00:00+02:00");
		const row = (startMs: number): ProcRow => ({ pid: 4243, ppid: 1, comm: "node", args: [join(code.dir, "muster", "bin", "muster.mts")], startMs });

		// No `--landing`: the merge that brought LC10 to main, found in the Muster checkout and
		// dated 2020, so a process started now is after it.
		const fresh = processesCheck(harnessFlipChecks(toolFor({ invoking: invoking.dir, code: code.dir, processes: [row(Date.now())] }), { roots: { harnessTrees: [code.dir] } }));
		assert.equal(fresh.ok, true, fresh.detail);

		const stale = processesCheck(harnessFlipChecks(toolFor({ invoking: invoking.dir, code: code.dir, processes: [row(1_000)] }), { roots: { harnessTrees: [code.dir] } }));
		assert.equal(stale.ok, true, "only a live worker lane refuses the flip (VR24-229 item 7)");
		assert.match(stale.detail, /1 of 1 Muster process\(es\) restart-needed, started before the landing commit/);
	});
});
