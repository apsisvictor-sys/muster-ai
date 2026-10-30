/**
 * The listing that moved the harness-only tests (OL12 item 1, D3; blueprint RD7, §7 "tests and
 * their helpers").
 *
 * A test in `extensions/tests/` moves with the code it tests: a test that imports harness code
 * and no Pi-only file takes the package it reaches, and a test that imports both tests their
 * integration and stays in Pi's profile. The rule is the scan owner's (§7), so this script reads
 * it from `packages/core/import-scan.ts` instead of repeating it, and the boundary test reads the
 * same assignment.
 *
 *   node --import tsx packages/core/list-harness-tests.mts          # write packages/MOVED-TESTS.txt
 *   node --import tsx packages/core/list-harness-tests.mts --apply  # move the files and fix their imports
 *
 * The list is the commit's record of the move: the counts before, the counts after, every file
 * that moved with its new path, and every file that stayed.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assignTestPackages, createImportReader, resolveTarget, type FileSource, type Pkg } from "./import-scan.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const TESTS = "extensions/tests";
/** The scan's trees: the harness files and Pi's profile, the two sides of RD1. */
const SCAN_TREES = ["extensions", "scripts", "toolbelt", "packages"];
const SCANNABLE = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$/;
/**
 * The runner's setup stays in Pi's profile: the guard preloads this exact path (RD7 keeps the
 * guard in Pi's profile), and the setup's one job is to point the `agentDir` port at Pi's
 * checkout. The packages' own setup for a machine without the guard is `packages/test-setup.ts`
 * (OL12-D4).
 */
const STAYS_IN_PI = new Map([["extensions/tests/harness-test-setup.ts", "the guard preloads this path; it points the agentDir port at Pi's checkout"]]);
/** The guard stays in Pi's profile (RD7), so the tests that exercise it read it there. */
const GUARD_FILES = new Set(["extensions/tests/guard-lib.sh", "extensions/tests/run-guarded.sh"]);
/** The packages a file may live in, from the base to the top: a fixture several packages read lives in the lowest. */
const PACKAGE_BASE_ORDER: Pkg[] = ["core", "routing", "toolbelt", "muster"];

interface Move {
	/** The file in Pi's profile today. */
	from: string;
	/** The file in the package it moves to. */
	to: string;
	/** The package that owns it. */
	pkg: Pkg;
	/** A helper (not a test) that moves with the tests that import it. */
	helper: boolean;
	/** A fixture the moved tests read by path; it travels with them. */
	fixture: boolean;
}

function git(...args: string[]): string {
	return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" });
}

const files = git("ls-files", "--", ...SCAN_TREES).split("\n").filter((line) => line !== "" && SCANNABLE.test(line)).sort();
const sources = new Map<string, string | undefined>();
const readSource: FileSource = (path) => {
	if (!sources.has(path)) {
		try {
			sources.set(path, readFileSync(join(ROOT, path), "utf8"));
		} catch {
			sources.set(path, undefined);
		}
	}
	return sources.get(path);
};

const importsOf = createImportReader(readSource);
const testPackages = assignTestPackages(files, readSource, importsOf);

const inTests = files.filter((path) => path.startsWith(`${TESTS}/`));
const moves: Move[] = [];
const stays: string[] = [];
for (const path of inTests) {
	const pkg = testPackages.get(path);
	if (pkg === undefined || pkg === "stays" || STAYS_IN_PI.has(path)) {
		stays.push(path);
		continue;
	}
	const name = path.slice(`${TESTS}/`.length);
	moves.push({ from: path, to: `packages/${pkg}/tests/${name}`, pkg, helper: !/\.test\.(ts|mts)$/.test(path), fixture: false });
}

/** The helpers move with the tests that import them: a helper left behind would be a Pi-profile file the harness reaches. */
const helpers = moves.filter((move) => move.helper);
const tests = moves.filter((move) => !move.helper);
const stayedTests = stays.filter((path) => /\.test\.(ts|mts)$/.test(path));

/**
 * The path references a file makes to its own folder: the relative paths it reads or runs,
 * whether they come from `new URL(..., import.meta.url)` or from `join`/`resolve` over the
 * file's own directory.
 */
function pathReferences(source: string): string[] {
	const paths: string[] = [];
	for (const match of source.matchAll(/new URL\((["'])(\.[^"']*)\1\s*,\s*import\.meta\.url\)/g)) paths.push(match[2]!);
	for (const match of source.matchAll(/(?:resolve|join)\((?:dirname\(fileURLToPath\(import\.meta\.url\)\)|import\.meta\.dirname|TESTS_DIR|HERE|here)((?:\s*,\s*"[^"]*")*)\)/g)) {
		paths.push([...match[1]!.matchAll(/"([^"]*)"/g)].map((part) => part[1]!).join("/"));
	}
	return paths;
}

/** The absolute path a reference names today, the link followed when there is one. */
function absoluteTarget(from: string, path: string): string {
	const target = resolve(dirname(join(ROOT, from)), path);
	try {
		return realpathSync(target);
	} catch {
		return target;
	}
}

/** Every file under a folder. */
function filesUnder(folder: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(folder, { withFileTypes: true })) {
		const path = join(folder, entry.name);
		if (entry.isDirectory()) found.push(...filesUnder(path));
		else found.push(path);
	}
	return found;
}

/** The fixtures a moved test reads by path travel with it: test data belongs to the test. */
function fixtureMoves(): Move[] {
	const wanted = new Map<string, Pkg>();
	for (const move of moves) {
		const source = readFileSync(join(ROOT, move.from), "utf8");
		for (const path of pathReferences(source)) {
			const target = absoluteTarget(move.from, path);
			if (!target.startsWith(join(ROOT, TESTS))) continue;
			if (!existsSync(target)) continue;
			const rel = relative(join(ROOT, TESTS), target);
			if (STAYS_IN_PI.has(`${TESTS}/${rel}`) || GUARD_FILES.has(`${TESTS}/${rel}`)) continue;
			// A folder of fixtures moves file by file: the files beside it may belong to a test that stays.
			const files = statSync(target).isDirectory() ? filesUnder(target) : [target];
			for (const file of files) {
				const fileRel = relative(join(ROOT, TESTS), file);
				const pkg = wanted.get(fileRel);
				if (pkg === undefined || PACKAGE_BASE_ORDER.indexOf(move.pkg) < PACKAGE_BASE_ORDER.indexOf(pkg)) wanted.set(fileRel, move.pkg);
			}
		}
	}
	return [...wanted.entries()]
		.map(([rel, pkg]) => ({ from: `${TESTS}/${rel}`, to: `packages/${pkg}/tests/${rel}`, pkg, helper: false, fixture: true }))
		.filter((entry) => !moves.some((move) => move.from === entry.from));
}

/** The fixtures a moved test reads by path travel with it: test data belongs to the test. */
const fixtures = fixtureMoves();

function list(): string {
	const lines: string[] = [];
	lines.push("Harness-only tests moved out of Pi's profile (OL12 item 1, D3; blueprint RD7, §7).");
	lines.push("");
	lines.push("Rule (the scan owner, packages/core/import-scan.ts): a test in extensions/tests that");
	lines.push("imports harness code and no Pi-only file takes the package it reaches; a test that");
	lines.push("imports both stays in Pi's profile, because it tests their integration. A helper moves");
	lines.push("with the tests that import it, and a helper that reads Pi's profile stays.");
	lines.push("");
	lines.push(`Before: ${inTests.length} files in ${TESTS}/ (${tests.length + stayedTests.length} tests, ${inTests.length - tests.length - stayedTests.length} helpers)`);
	lines.push(`After:  ${stayedTests.length} tests and ${stays.length - stayedTests.length} helpers stayed in ${TESTS}/, ${tests.length} tests and ${helpers.length} helpers moved into the packages' tests/ folders`);
	lines.push(`Check:  ${tests.length} moved + ${stayedTests.length} stayed = ${tests.length + stayedTests.length} tests before`);
	lines.push("");
	lines.push("Moved tests:");
	for (const move of tests) lines.push(`  ${move.from} -> ${move.to}`);
	lines.push("");
	lines.push("Moved helpers:");
	for (const move of helpers) lines.push(`  ${move.from} -> ${move.to}`);
	lines.push("");
	lines.push("Moved fixtures (the data the moved tests read):");
	for (const move of fixtures) lines.push(`  ${move.from} -> ${move.to}`);
	lines.push("");
	lines.push("Stayed in Pi's profile:");
	for (const path of stays) {
		const reason = STAYS_IN_PI.get(path);
		lines.push(reason === undefined ? `  ${path}` : `  ${path} (${reason})`);
	}
	lines.push("");
	return lines.join("\n");
}

/**
 * The specifier an import takes after the move.
 *
 * A moved file lives in the harness tree and names the harness tree directly; a file that stays
 * in Pi's profile names the harness through the one tracked link (RD1's direction).
 */
function rewrite(importerFrom: string, importerTo: string, specifier: string, movedPaths: Map<string, string>): string | undefined {
	if (!specifier.startsWith(".")) return undefined;
	const target = resolveTarget(importerFrom, specifier, readSource);
	if (target === undefined) return undefined;
	const movedTo = movedPaths.get(target);
	if (importerTo !== importerFrom) {
		const from = dirname(join(ROOT, importerTo));
		const to = join(ROOT, movedTo ?? target);
		let rel = relative(from, to);
		if (!rel.startsWith(".")) rel = `./${rel}`;
		return rel;
	}
	if (movedTo === undefined) return undefined;
	const inTree = relative("packages", join(ROOT, movedTo));
	const viaLink = relative(dirname(join(ROOT, importerTo)), join(ROOT, "harness", inTree));
	return viaLink.startsWith(".") ? viaLink : `./${viaLink}`;
}

/**
 * The path a moved file reads or runs after the move: the same file, named from the new folder.
 */
function rewritePaths(source: string, oldDir: string, newDir: string, movedAbsolute: Map<string, string>): string {
	const map = (absolute: string): string => movedAbsolute.get(absolute) ?? absolute;
	const relativeTo = (absolute: string): string => {
		const rel = relative(newDir, map(absolute));
		return rel.startsWith(".") ? rel : `./${rel}`;
	};
	let out = source.replace(/new URL\((["'])(\.[^"']*)\1(\s*,\s*import\.meta\.url\))/g, (whole, quote, path, tail) => {
		return `new URL(${quote}${relativeTo(absoluteTargetFrom(oldDir, path))}${quote}${tail}`;
	});
	out = out.replace(/(resolve|join)\((dirname\(fileURLToPath\(import\.meta\.url\)\)|import\.meta\.dirname|TESTS_DIR|HERE|here)((?:\s*,\s*"[^"]*")*)\)/g, (whole, fn, base, segText) => {
		const segments = [...segText.matchAll(/"([^"]*)"/g)].map((part) => part[1]!);
		if (segments.length === 0) return whole;
		const absolute = resolve(oldDir, ...segments);
		const rel = relative(newDir, map(absolute)).split("/");
		return `${fn}(${base}, ${rel.map((part) => `"${part}"`).join(", ")})`;
	});
	return out;
}

function absoluteTargetFrom(dir: string, path: string): string {
	const target = resolve(dir, path);
	try {
		return realpathSync(target);
	} catch {
		return target;
	}
}

const apply = process.argv.includes("--apply");
if (!apply) {
	writeFileSync(join(ROOT, "packages/MOVED-TESTS.txt"), list());
	console.log(`packages/MOVED-TESTS.txt: ${tests.length} tests and ${helpers.length} helpers move, ${stayedTests.length} tests stay`);
} else {
	const all = [...moves, ...fixtures];
	/** The moved file's new path, by the path the scan names it (repo-relative) and by its absolute path. */
	const movedPaths = new Map<string, string>();
	const movedAbsolute = new Map<string, string>();
	for (const move of all) {
		movedPaths.set(move.from, move.to);
		const from = join(ROOT, move.from);
		try {
			movedAbsolute.set(realpathSync(from), join(ROOT, move.to));
		} catch {
			movedAbsolute.set(from, join(ROOT, move.to));
		}
	}

	// Every file that names a moved file has its specifiers rewritten: the moved files
	// themselves (their own harness paths become tree paths), and the files that stay in
	// Pi's profile and import a helper that moved (they name the harness through the link).
	const importers = [
		...moves.map((move) => ({ from: move.from, to: move.to })),
		...stays
			.filter((path) =>
				importsOf(path).some((record) => {
					const target = resolveTarget(path, record.specifier, readSource);
					return target !== undefined && all.some((move) => move.from === target);
				}),
			)
			.map((path) => ({ from: path, to: path })),
	];
	for (const { from, to } of importers) {
		// The rewrite happens before the move: the file is read and written where it is now.
		const file = join(ROOT, from);
		const source = readFileSync(file, "utf8");
		const withImports = source.replace(/(from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)(["'])([^"']+)\2/g, (whole, head, quote, specifier) => {
			const next = rewrite(from, to, specifier, movedPaths);
			return next === undefined ? whole : `${head}${quote}${next}${quote}`;
		});
		const withPaths = to === from ? withImports : rewritePaths(withImports, dirname(join(ROOT, from)), dirname(join(ROOT, to)), movedAbsolute);
		if (withPaths !== source) writeFileSync(file, withPaths);
	}

	for (const move of all) {
		const target = join(ROOT, move.to);
		mkdirSync(dirname(target), { recursive: true });
		if (!existsSync(join(ROOT, move.from))) throw new Error(`gone before the move: ${move.from} (wanted ${move.to})`);
		git("mv", move.from, move.to);
	}
	writeFileSync(join(ROOT, "packages/MOVED-TESTS.txt"), list());
	console.log(`moved ${all.length} files (${tests.length} tests, ${helpers.length} helpers, ${fixtures.length} fixtures); rewrote ${importers.length} files`);
}
