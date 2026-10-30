/**
 * The secret scan's own test (modular-repo blueprint RD6/RS3 step 2, OL12 D2).
 *
 * `scripts/harness-secret-scan.sh` is the one owner of "is there a secret in these
 * commits", and its single job is to stop the push. Two rules make that job hold, and
 * this test is their proof:
 *
 *   1. R2 — a scan that could not run must not report "nothing found". A git without
 *      PCRE, or a `git grep` that dies for any other reason, stops the run with exit 2
 *      and a loud line: it is never mistaken for a clean scan.
 *   2. R3 — the allow list pins reviewed hits, and a pinned hit must not re-fire on
 *      every later commit whose tree still carries the same fixture. So commits up to
 *      the split base keep the whole-tree scan (commit + path), and every commit after
 *      it is scanned for the lines it ADDS only, keyed in the allow list by path,
 *      pattern name and a hash of the matched line. The value itself is never stored:
 *      a new secret written into an allowed fixture path has a different hash and is
 *      still a hit. A rename is read as a delete plus an add (`--no-renames`, R4), so
 *      a file that only moves is scanned at the path it moved to, where a key for the
 *      old path does not match.
 *
 * The scratch repository, its commits and every planted value are built here at run
 * time: no key-shaped literal is written into this file, so the scan of this
 * repository's own history finds nothing in it. Nothing here prints a matched value.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * The checkout this test runs in, from git rather than a fixed depth: the file sits
 * three levels below pi-agent's root (`extensions/tests/`) and two below the harness
 * repository's (`core/tests/`), and a lane worktree has its own root.
 */
const ROOT = ((): string => {
	try {
		return execFileSync("git", ["-C", HERE, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
	} catch {
		return resolve(HERE, "..", "..");
	}
})();
const SCANNER = join(ROOT, "scripts", "harness-secret-scan.sh");
const PATTERN_FIXTURE = "core/tests/fixture.test.ts";

/** The real git, so a stubbed PATH still reaches it. */
const GIT = ((): string => {
	try {
		return execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
	} catch {
		return "/usr/bin/git";
	}
})();

/**
 * Planted values, assembled at run time. `Z` and `Y` runs are shaped like the patterns
 * and are visibly made up; nothing here is a real credential.
 */
const AWS_BODY = "Z".repeat(16);
const ALLOWED_LINE = `const AWS_KEY = "AKIA${AWS_BODY}";`;
const SECOND_LINE = `const SECOND_KEY = "AKIA${"Y".repeat(16)}";`;
const DOCS_TOKEN = "ghp_" + "Z".repeat(36);
const DOCS_LINE = `const DEPLOY_NOTE = "${DOCS_TOKEN}";`;

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

interface Scan {
	status: number;
	lines: string[];
	stderr: string;
}

/** Run the scanner in `cwd`; `pathPrefix` puts a stubbed `git` in front of the real one. */
function scan(cwd: string, args: string[], pathPrefix?: string): Scan {
	const path = pathPrefix ? `${pathPrefix}:${process.env.PATH ?? ""}` : process.env.PATH;
	const result = spawnSync("bash", [SCANNER, ...args], { cwd, encoding: "utf8", env: { ...process.env, PATH: path } });
	return {
		status: result.status ?? -1,
		lines: (result.stdout ?? "").split("\n").filter((line) => line.trim() !== ""),
		stderr: result.stderr ?? "",
	};
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function writeFile(dir: string, relative: string, content: string): void {
	const target = join(dir, relative);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, content, "utf8");
}

/** A `git` on PATH that fails the way a broken build fails, and passes everything else through. */
function gitStub(dir: string, name: string, body: string): string {
	const bin = join(dir, `stub-${name}`);
	mkdirSync(bin, { recursive: true });
	const script = join(bin, "git");
	writeFileSync(script, `#!/bin/sh\n${body}\n`, "utf8");
	chmodSync(script, 0o755);
	return bin;
}

interface Scenario {
	dir: string;
	splitBase: string;
	commits: string[];
	allowFile: string;
}

const scratchRoots: string[] = [];
after(() => {
	for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
});

/**
 * Seven commits, in the order a real split history has them:
 *
 *   A  the split base: the reviewed fixture already carries a made-up key
 *   B  a commit that touches nothing secret, its tree still carries the fixture
 *   C  a NEW secret written into the allowed fixture path (must stay a hit)
 *   D  the allowed line deleted (a deletion is not an added line)
 *   E  the same allowed line added again (the hash key, not a new allow entry)
 *   F  a data file that must never travel
 *   G  a new file carrying a token-shaped value (must stay a hit)
 */
function buildScenario(): Scenario {
	const dir = mkdtempSync(join(tmpdir(), "harness-secret-scan-"));
	scratchRoots.push(dir);
	git(dir, ["init", "-q", "-b", "main"]);
	git(dir, ["config", "user.email", "scan-test@example.invalid"]);
	git(dir, ["config", "user.name", "harness secret scan test"]);

	const commits: string[] = [];
	const commit = (message: string): string => {
		git(dir, ["add", "-A"]);
		git(dir, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
		const sha = git(dir, ["rev-parse", "HEAD"]);
		commits.push(sha);
		return sha;
	};

	writeFile(dir, PATTERN_FIXTURE, `${ALLOWED_LINE}\n`);
	writeFile(dir, "README.md", "# scratch repository\n");
	const splitBase = commit("the reviewed fixture");

	writeFile(dir, "README.md", "# scratch repository\n\na later line\n");
	commit("unrelated work");

	writeFile(dir, PATTERN_FIXTURE, `${ALLOWED_LINE}\n${SECOND_LINE}\n`);
	commit("a new value in the allowed fixture");

	writeFile(dir, PATTERN_FIXTURE, `${SECOND_LINE}\n`);
	commit("the allowed line removed");

	writeFile(dir, PATTERN_FIXTURE, `${ALLOWED_LINE}\n${SECOND_LINE}\n`);
	commit("the allowed line added again");

	writeFile(dir, ".env", "SCAN_TEST_PLACEHOLDER=1\n");
	commit("a data file");

	writeFile(dir, "docs/notes.md", `${DOCS_LINE}\n`);
	commit("a new file");

	const allowFile = join(dir, "allow.txt");
	writeFileSync(
		allowFile,
		[
			"# the reviewed fixture at the split base, and the added-line keys",
			`${splitBase} ${PATTERN_FIXTURE}`,
			`= ${PATTERN_FIXTURE} aws-access-key ${sha256(ALLOWED_LINE)}`,
			"= .env file-name",
			"",
		].join("\n"),
		"utf8",
	);
	return { dir, splitBase, commits, allowFile };
}

const scenario = buildScenario();

/** `<commit> <path> <pattern> [<hash>]`, the only shape a hit may print. */
const HIT = /^[0-9a-f]{40} \S+ [a-z-]+( [0-9a-f]{64})?$/;

test("the whole-tree scan flags the reviewed fixture at every commit that carries it", (): void => {
	const result = scan(scenario.dir, ["HEAD"]);
	assert.equal(result.status, 1, result.stderr);
	assert.equal(result.lines.filter((line) => line.endsWith(` ${PATTERN_FIXTURE} aws-access-key`)).length, scenario.commits.length);
});

test("after the split base only the added lines are scanned, and a new secret in an allowed path still hits", (): void => {
	const result = scan(scenario.dir, [scenario.splitBase + "..HEAD", "--allow", scenario.allowFile, "--split-base", scenario.splitBase]);
	assert.equal(result.status, 1, result.stderr);
	// `git rev-list` walks newest first, so the hit order is not the commit order.
	assert.deepEqual(
		result.lines.map((line) => line.split(" ").slice(1).join(" ")).sort(),
		[
			`${PATTERN_FIXTURE} aws-access-key ${sha256(SECOND_LINE)}`,
			`docs/notes.md github-token ${sha256(DOCS_LINE)}`,
		].sort(),
		result.lines.join("\n"),
	);
	// The same scan without the split base re-flags the allowed fixture at every commit.
	assert.equal(
		scan(scenario.dir, [scenario.splitBase + "..HEAD", "--allow", scenario.allowFile]).lines.filter((line) => line.includes(PATTERN_FIXTURE)).length,
		scenario.commits.length - 1,
	);
});

test("a reviewed added line and a data file are allowed by path, pattern and line hash", (): void => {
	const result = scan(scenario.dir, [scenario.splitBase, "--allow", scenario.allowFile, "--split-base", scenario.splitBase]);
	// Only the reviewed fixture at the split base remains: everything after it is clean.
	assert.equal(result.status, 0, result.lines.join("\n"));
});

test("hit lines carry the commit, the path, the pattern and a hash, never a value", (): void => {
	const outputs = [
		scan(scenario.dir, ["HEAD"]),
		scan(scenario.dir, ["HEAD", "--allow", scenario.allowFile, "--split-base", scenario.splitBase]),
	].flatMap((result) => [result.lines.join("\n"), result.stderr]);
	for (const output of outputs) {
		assert.ok(!output.includes(AWS_BODY), "a matched value reached the output");
		assert.ok(!output.includes(DOCS_TOKEN), "a matched value reached the output");
		for (const line of output.split("\n")) {
			if (line.includes(" aws-access-key") || line.includes(" github-token")) assert.match(line, HIT);
		}
	}
});

test("a git without PCRE stops the scan with exit 2 instead of reporting nothing", (): void => {
	const bin = gitStub(scenario.dir, "no-pcre", ['if [ "$1" = "grep" ]; then', '\techo "fatal: cannot use Perl-compatible regexes" >&2', "\texit 128", "fi", `exec "${GIT}" "$@"`].join("\n"));
	const result = scan(scenario.dir, ["HEAD"], bin);
	assert.equal(result.status, 2, `a scan that could not run passed: ${result.lines.join("\n")}`);
	assert.match(result.stderr, /git grep -P/);
	assert.deepEqual(result.lines, []);
});

test("a git grep that fails after the probe stops the scan with exit 2", (): void => {
	const counter = join(scenario.dir, "grep-calls");
	const bin = gitStub(
		scenario.dir,
		"late-failure",
		[
			'if [ "$1" = "grep" ]; then',
			`\tn=$(cat "${counter}" 2>/dev/null || echo 0)`,
			"\tn=$((n + 1))",
			`\techo "$n" > "${counter}"`,
			'\tif [ "$n" -ge 2 ]; then',
			'\t\techo "fatal: grep died after the probe" >&2',
			"\t\texit 128",
			"\tfi",
			"fi",
			`exec "${GIT}" "$@"`,
		].join("\n"),
	);
	const result = scan(scenario.dir, ["HEAD"], bin);
	assert.equal(result.status, 2, `a failed git grep passed: ${result.lines.join("\n")}`);
	assert.match(result.stderr, /git grep/);
});

/**
 * R4: a pure rename carries its content with no added lines, so a scan that reads only
 * a commit's `+` lines sees nothing to search. `--no-renames` reads every rename as a
 * delete plus an add, so the carried lines are scanned at the path they now live at —
 * where neither the path half of the key nor a hash entry for the old path matches.
 *
 *   A  the split base: the reviewed fixture at its reviewed path
 *   B  a planted token in an ordinary path (a hit either way)
 *   C  that file renamed, content unchanged (silent before the fix)
 *   D  the allowed fixture renamed to a NEW path: the line hash still matches the
 *      reviewed value, and the path key must still make it a hit (silent before it)
 */
function buildRenameScenario(): Scenario {
	const dir = mkdtempSync(join(tmpdir(), "harness-secret-scan-rename-"));
	scratchRoots.push(dir);
	git(dir, ["init", "-q", "-b", "main"]);
	git(dir, ["config", "user.email", "scan-test@example.invalid"]);
	git(dir, ["config", "user.name", "harness secret scan test"]);

	const commits: string[] = [];
	const commit = (message: string): string => {
		git(dir, ["add", "-A"]);
		git(dir, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
		const sha = git(dir, ["rev-parse", "HEAD"]);
		commits.push(sha);
		return sha;
	};

	writeFile(dir, PATTERN_FIXTURE, `${ALLOWED_LINE}\n`);
	writeFile(dir, "README.md", "# scratch repository\n");
	const splitBase = commit("the reviewed fixture");

	writeFile(dir, "docs/planted.md", `${DOCS_LINE}\n`);
	commit("a planted value in an ordinary path");

	git(dir, ["mv", "docs/planted.md", "docs/moved.md"]);
	commit("the planted file renamed");

	mkdirSync(join(dir, "lib"), { recursive: true });
	git(dir, ["mv", PATTERN_FIXTURE, "lib/moved.ts"]);
	commit("the allowed fixture renamed to a new path");

	const allowFile = join(dir, "allow.txt");
	writeFileSync(
		allowFile,
		[
			"# the reviewed fixture at the split base, and the added-line key for it",
			`${splitBase} ${PATTERN_FIXTURE}`,
			`= ${PATTERN_FIXTURE} aws-access-key ${sha256(ALLOWED_LINE)}`,
			"",
		].join("\n"),
		"utf8",
	);
	return { dir, splitBase, commits, allowFile };
}

test("a rename is scanned at its new path, where the allow key does not match", (): void => {
	const renames = buildRenameScenario();
	const result = scan(renames.dir, [renames.splitBase + "..HEAD", "--allow", renames.allowFile, "--split-base", renames.splitBase]);
	assert.equal(result.status, 1, `a renamed file was never scanned: ${result.lines.join("\n")}`);
	assert.deepEqual(
		result.lines.map((line) => line.split(" ").slice(1).join(" ")).sort(),
		[
			`docs/planted.md github-token ${sha256(DOCS_LINE)}`,
			`docs/moved.md github-token ${sha256(DOCS_LINE)}`,
			`lib/moved.ts aws-access-key ${sha256(ALLOWED_LINE)}`,
		].sort(),
		result.lines.join("\n"),
	);
});

test("an unusable split base is refused, never silently ignored", (): void => {
	const result = scan(scenario.dir, ["HEAD", "--split-base", "0000000000000000000000000000000000000000"]);
	assert.equal(result.status, 2, result.lines.join("\n"));
	assert.match(result.stderr, /split base/);
});
