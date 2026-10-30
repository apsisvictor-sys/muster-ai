/**
 * Pi-side harness link test (blueprint §11 RS2d, §9 AC3, RD10).
 *
 * Pi's profile reaches harness code through the one tracked link `harness ->
 * packages`, and RS4 later points that link at the standalone repository. Two
 * rules follow, and this test is their owner on Pi's side:
 *
 *   1. a specifier that reaches the harness names it through `harness/`, never
 *      the `packages/` folder directly (AC3);
 *   2. no Pi-profile file reaches harness code with a dynamic `import()` (AC3,
 *      RD10). A dynamic import resolves the link at call time, so a process
 *      could run two trees (one with no ports configured); a lazy load goes
 *      through a harness module Pi imported statically instead.
 *
 * Scope: every tracked source file outside `packages/` and `harness/`. That is
 * Pi's profile by location, which is what AC3 governs: `extensions/**` (tests
 * included — RS2c keeps them in Pi's profile with `harness/` specifiers),
 * `scripts/**`, `memory/**` and the rest. The §7 test-package assignment is a
 * different question (which package a test's behaviour belongs to) and belongs
 * to `packages/core/tests/harness-boundary.test.ts`.
 *
 * Out of scope: a `require()` resolves at load like a static import; a
 * type-position `typeof import("…")` is erased at runtime, so RD10's runtime
 * rule does not apply to it (the other type-position spelling,
 * `import("…").X`, is written as `import type { X } from "harness/…"` instead,
 * which this test then checks like any other static import); a non-literal
 * `import()` is the scanner's blind spot that S10's rule covers in the boundary
 * test; the generated `*.bundle.mjs` files have no hand-written imports and
 * RS2c's hash check owns their paths.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, posix, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { extractImports, tokenize, type ImportForm } from "../import-scan.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * The checkout this test runs in, from git rather than from a fixed depth: in pi-agent the
 * file sits three levels below the root (`packages/core/tests/`), in the harness repository
 * two (`core/tests/`), and a lane worktree has its own root. `harnessFreeze` needs the
 * checkout under test, not the one the file was written for.
 */
const ROOT = ((): string => {
	try {
		return execFileSync("git", ["-C", HERE, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
	} catch {
		return resolve(HERE, "..", "..", "..");
	}
})();
/** Pi's profile is this tree's `extensions/` folder; the harness repository's own tree has none. */
const PI_PROFILE = existsSync(resolve(ROOT, "extensions"));
const SCANNABLE = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$/;
/** Generated bundles: written by the builder, and RS2c's hash check owns their paths. */
const GENERATED = /\.bundle\.mjs$/;
/** The harness tree, reached by a relative path or by the tracked link's name. */
const HARNESS_TREES = ["packages", "harness"];

export interface LinkFinding {
	from: string;
	specifier: string;
	form: ImportForm;
	reason: string;
}

type Route = "link" | "direct";

/**
 * How a specifier reaches the harness: `link` through a `harness/` path,
 * `direct` through `packages/`, or `undefined` when it does not reach the
 * harness at all. Only the leading segments count, so a file that merely has
 * `packages` deeper in its own path (or a `./packages/` folder of another
 * project, as `scripts/prompt-watch/runner.template.ts` names) is not a hit.
 */
export function harnessRoute(from: string, specifier: string): Route | undefined {
	const target = specifier.startsWith(".") || specifier.startsWith("/") ? posix.normalize(posix.join(posix.dirname(from), specifier)) : specifier;
	if (target === "harness" || target.startsWith("harness/")) return "link";
	if (target === "packages" || target.startsWith("packages/")) return "direct";
	return undefined;
}

/**
 * A `typeof import("…")` type query. It carries an `ImportForm` of `dynamic`
 * (the scanner's shape), but it is erased by the transform like an `import
 * type`, so AC3's runtime rule does not reach it.
 */
export function isTypeQuery(text: string, pos: number): boolean {
	return /(^|[^\w$])typeof$/.test(text.slice(0, pos).replace(/\s+$/, ""));
}

export function analyze(files: readonly string[], readSource: (path: string) => string | undefined): LinkFinding[] {
	const findings: LinkFinding[] = [];
	for (const path of files) {
		const text = readSource(path);
		if (text === undefined) continue;
		for (const record of extractImports(tokenize(text, /\.(tsx|jsx)$/.test(path))).imports) {
			const route = harnessRoute(path, record.specifier);
			if (route === undefined) continue;
			if (record.form === "dynamic") {
				if (isTypeQuery(text, record.pos)) continue;
				findings.push({
					from: path,
					specifier: record.specifier,
					form: record.form,
					reason: "dynamic import() of harness code: a lazy load resolves the link again at call time (RD10); call a harness module imported statically instead",
				});
				continue;
			}
			if (record.form === "require") continue;
			if (route === "direct") {
				findings.push({ from: path, specifier: record.specifier, form: record.form, reason: "names the packages/ folder directly: Pi's profile imports harness code as harness/… (AC3)" });
			}
		}
	}
	return findings;
}

function profileFiles(root: string): string[] {
	const listed = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8" });
	return listed
		.split("\n")
		.filter((line) => line !== "" && SCANNABLE.test(line) && !GENERATED.test(line) && !HARNESS_TREES.some((tree) => line.startsWith(`${tree}/`)))
		.sort();
}

const files = profileFiles(ROOT);
const sources = new Map<string, string | undefined>();
const readSource = (path: string): string | undefined => {
	if (!sources.has(path)) {
		try {
			sources.set(path, readFileSync(resolve(ROOT, path), "utf8"));
		} catch {
			sources.set(path, undefined);
		}
	}
	return sources.get(path);
};

const findings = analyze(files, readSource);

function listing(rows: readonly LinkFinding[]): string {
	return rows
		.slice(0, 200)
		.map((f) => `${f.from} (${f.form} "${f.specifier}") ${f.reason}`)
		.join("\n");
}

test("the detector reports a dynamic import() of harness code, and not a type-position one", () => {
	const fixture: Record<string, string> = {
		"extensions/tests/pi-file.ts": 'const ports = await import("../../harness/core/pi-ports.ts");\n',
		"extensions/tests/pi-type.ts": 'type Ports = typeof import("../../harness/core/pi-ports.ts");\n',
	};
	const found = analyze(Object.keys(fixture), (path) => fixture[path]);
	assert.deepEqual(found.map((f) => `${f.from}->${f.specifier}`), ["extensions/tests/pi-file.ts->../../harness/core/pi-ports.ts"]);
	assert.match(found[0]!.reason, /dynamic import\(\)/);
});

test("the detector reports a specifier that names packages/ directly, and accepts harness/", () => {
	const fixture: Record<string, string> = {
		"extensions/tests/pi-file.ts": 'import { piAgentDir } from "../../packages/core/pi-ports.ts";\n',
		"extensions/tests/pi-ok.ts": 'import { piAgentDir } from "../../harness/core/pi-ports.ts";\n',
	};
	const found = analyze(Object.keys(fixture), (path) => fixture[path]);
	assert.deepEqual(found.map((f) => `${f.from}->${f.specifier}`), ["extensions/tests/pi-file.ts->../../packages/core/pi-ports.ts"]);
	assert.equal(harnessRoute("scripts/prompt-watch/runner.template.ts", "./packages/coding-agent/src/tools.ts"), undefined, "another project's packages/ folder is not the harness");
});

/**
 * The next three tests assert something about Pi's profile, which this checkout has only
 * while the harness lives inside it. The harness repository's own tree (the split, its CI)
 * has no profile, so there they say so instead of failing: AC3 is asserted here, in Pi's
 * checkout, which is the tree AC3 governs.
 */
const NO_PROFILE = PI_PROFILE ? false : "this checkout has no Pi profile: AC3 is asserted in Pi's checkout";

test("no Pi-profile file reaches harness code with a dynamic import() or through packages/", { skip: NO_PROFILE }, () => {
	assert.deepEqual(findings, [], `Pi-profile files that break AC3:\n${listing(findings)}`);
});

test("the scanned set is Pi's profile, not the harness", { skip: NO_PROFILE }, () => {
	assert.ok(files.includes("extensions/tests/messaging-gateway.test.ts"), "a Pi-profile test is scanned");
	assert.ok(files.includes("scripts/muster.mts"), "the CLI start file is Pi-profile and scanned");
	assert.ok(!files.some((path) => HARNESS_TREES.some((tree) => path.startsWith(`${tree}/`))), "no harness file is scanned");
	assert.ok(!files.some((path) => GENERATED.test(path)), "generated bundles are not scanned");
	for (const tree of ["extensions", "scripts", "memory"]) assert.ok(files.some((path) => path.startsWith(`${tree}/`)), `${tree}/ is part of Pi's profile and scanned`);
});

test("the check is not vacuous: Pi-profile files reach harness code statically", { skip: NO_PROFILE }, () => {
	const staticReachers = files.filter((path) => {
		const text = readSource(path);
		return text !== undefined && extractImports(tokenize(text)).imports.some((record) => record.form !== "dynamic" && harnessRoute(path, record.specifier) === "link");
	});
	assert.ok(staticReachers.length > 0, "some Pi-profile file imports harness code through harness/ statically");
});

// ─── The freeze's owner (AC1, blueprint §9, RS3 step 6) ──────────────────────
//
// After RS4 the `harness` link points at the standalone repository, and `packages/`
// in pi-agent is a frozen copy that no consumer loads. A change committed or left
// uncommitted under `packages/` from then on lands in a tree nothing reads, so the
// lane that made it loses it at the next release. This is AC1's owner on Pi's side:
// it fails such a change at T2 or T3 and names the repository it belongs to.

/** The repository the harness moved to (OL12 D1). */
export const FREEZE_REPOSITORY = "muster-dev/muster";

export interface FreezeFinding {
	path: string;
	reason: string;
}

/**
 * The rule, with its inputs injected so it can be tested without a flipped link:
 * before the flip `packages/` is the live tree and an edit there is ordinary work;
 * after it, every change under `packages/` is a loss.
 */
export function freezeFindings(input: { flipped: boolean; changed: readonly string[] }): FreezeFinding[] {
	if (!input.flipped) return [];
	return input.changed
		.filter((path) => path === "packages" || path.startsWith("packages/"))
		.map((path) => ({ path, reason: `packages/ is frozen in pi-agent: nothing reads it after the flip, so this change belongs in the ${FREEZE_REPOSITORY} repository` }));
}

function gitIn(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return undefined;
	}
}

/** The tracked link's real target, or undefined when this checkout has no link. */
export function linkTarget(root: string): string | undefined {
	try {
		return realpathSync(resolve(root, "harness"));
	} catch {
		return undefined;
	}
}

export interface HarnessFreeze {
	repository: string;
	/** The link's real target; undefined while there is no link at all. */
	link?: string;
	flipped: boolean;
	/** The main checkout that owns the link: a lane worktree shares its link. */
	main: string;
	/** The commit that last changed the link, which is the flip once it has one. */
	base?: string;
	findings: FreezeFinding[];
}

/**
 * The freeze's state for the checkout `root` — Pi's main checkout, or a lane worktree,
 * whose link and flip commit are the main checkout's. Changes are read from the checkout
 * under test, so a worktree cut before the flip is failed by the flip its main checkout
 * already carries (review focus 3).
 */
export function harnessFreeze(root: string = ROOT): HarnessFreeze {
	const common = gitIn(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const main = common === undefined || common === "" ? root : dirname(common);
	const link = linkTarget(main);
	const flipped = link !== undefined && !(link === main || link.startsWith(main + sep));
	const freeze: HarnessFreeze = { repository: FREEZE_REPOSITORY, ...(link === undefined ? {} : { link }), flipped, main, findings: [] };
	if (!flipped) return freeze;
	const base = gitIn(main, ["log", "-1", "--format=%H", "--", "harness"]);
	if (base) freeze.base = base;
	const changed: string[] = [];
	const diff = base === undefined ? gitIn(root, ["diff", "--name-only", "--", "packages"]) : gitIn(root, ["diff", "--name-only", base, "HEAD", "--", "packages"]);
	for (const line of (diff ?? "").split("\n")) if (line !== "") changed.push(line);
	const status = gitIn(root, ["status", "--porcelain", "--untracked-files=all", "--", "packages"]) ?? "";
	for (const line of status.split("\n")) {
		const path = line.slice(3).trim();
		if (path !== "") changed.push(path.includes(" -> ") ? path.slice(path.indexOf(" -> ") + 4) : path);
	}
	freeze.findings = freezeFindings({ flipped, changed });
	return freeze;
}

test("the freeze reports a change under packages/ once the link points outside pi-agent", () => {
	const findings = freezeFindings({ flipped: true, changed: ["packages/core/pi-ports.ts", "packages/muster/seats.ts"] });
	assert.equal(findings.length, 2);
	for (const finding of findings) {
		assert.equal(finding.path, finding.path.startsWith("packages/") ? finding.path : "unreachable");
		assert.match(finding.reason, /muster-dev\/muster/);
	}
});

test("the freeze reports nothing while the link still points at packages/, and nothing outside packages/", () => {
	assert.deepEqual(freezeFindings({ flipped: false, changed: ["packages/core/pi-ports.ts"] }), [], "before the flip, packages/ is the live tree and an edit there is ordinary work");
	assert.deepEqual(freezeFindings({ flipped: true, changed: ["extensions/tests/harness-link.test.ts", "scripts/graph-refresh.sh"] }), [], "Pi's own profile stays editable after the flip");
});

test("nothing under packages/ has changed since the flip", () => {
	const freeze = harnessFreeze();
	assert.deepEqual(freeze.findings, [], `changes under packages/ after the flip belong in ${freeze.repository}:\n${freeze.findings.map((f) => `${f.path} (${f.reason})`).join("\n")}`);
});
