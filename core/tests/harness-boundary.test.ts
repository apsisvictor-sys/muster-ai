/**
 * Harness boundary test (blueprint §11 RS1 Done 1, §5 "May import", RD1, AC2, AC3).
 *
 * Fails on the base, listing today's crossings, and passes after the §7 cuts:
 *
 *   1. a *runtime* import from a harness-bound file (a file whose §5 package is
 *      `core`, `routing`, `toolbelt` or `muster`) into Pi's profile (`stays`,
 *      `extensions/` outside a package tree, `memory/`). A type-only import is
 *      erased at runtime and is allowed: RD1 forbids the import *at runtime*.
 *      Bare specifiers are RS0 item 3's subject (RD8): the harness declares its
 *      own dependencies in its manifests, so this test does not judge them.
 *   2. an import that §5's "May import" column does not allow: `core` imports
 *      nothing, `routing` and `toolbelt` import `core` only, `toolbelt` imports
 *      no other package (AC2), and `muster` may import all three.
 *   3. an `import.meta.url` / `__dirname` use in a harness file whose literal
 *      path segments climb out of that file's own package folder or name
 *      Pi's `scripts`/`state` (S10; RS0 item 8 classes each use).
 *
 * The failing-first list of the base is RS0 item 2: 154 harness → Pi-profile
 * crossings and 4 package edges, of which nine are production (`agile.ts`,
 * `control-bridge.ts`, `control.ts`, `asks-scan.ts`, `cli/gateway.ts`,
 * `gateway/tools.ts` twice, `cli/subscriptions.ts`, `gateway/knowledge.ts`).
 * Prove it against any checkout with `HARNESS_BOUNDARY_ROOT=<base checkout>` —
 * the scan reads that root, while the scanner itself comes from this checkout's
 * `lib/core/import-scan.ts`.
 *
 * Test classification (§7 "tests and their helpers"): a test that imports both
 * harness code and a Pi-only file tests their integration and stays in Pi's
 * profile, so it is no crossing; a test that imports only harness code takes
 * the package it reaches, and a helper takes the package of the tests that
 * import it (RD7). In RS1 nothing moves between directories, so this
 * classification is what removes the test-side crossings.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assignTestPackage, createImportReader, createPackageResolver, extractImports, packageOf, PART5_MONITOR_FILES, PART5_PACKAGE, PI_PACKAGE, PI_PACKAGE_SENTINEL, resolveTarget, tokenize, type ImportRecord, type Pkg } from "../import-scan.ts";
import { harnessRoot } from "../harness-paths.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
// RS2d: this test lives in `packages/core/tests/`, so the checkout root is three levels up.
const HARNESS_ROOT = harnessRoot(import.meta.url);
// The checkout that holds the packages: Pi's profile above `packages/`, else the repository root itself.
const CHECKOUT = existsSync(join(HARNESS_ROOT, "..", "packages")) ? resolve(HARNESS_ROOT, "..") : HARNESS_ROOT;
const ROOT = process.env.HARNESS_BOUNDARY_ROOT ? resolve(process.env.HARNESS_BOUNDARY_ROOT) : CHECKOUT;
// RS2a: `packages/` is the moved harness tree. The `harness` link is not scanned
// (it would enumerate the same files twice); a specifier through it resolves to
// `packages/` below, which is the same file.
const SCAN_TREES = ["extensions", "scripts", "toolbelt", "packages"];
const SCANNABLE = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$/;
/** Bare specifiers that name a Pi package; recorded for the report, judged by RS0 item 3 / RD8, not here. */
/**
 * §8's port wiring: every start file imports one of these, and they are Pi's
 * profile by design (§6), so their import is the sanctioned crossing point.
 */
const PORT_WIRING = new Set(["extensions/lib/harness-ports.ts", "extensions/muster/harness-gateway-ports.ts"]);
/**
 * §5 assigns the Part-5 monitor files (RS0's PART5 rows, quoted in §5's routing
 * row) their package now, so a Muster file importing a routing monitor file is
 * allowed — but only inside the extension tree, which is what §5's four packages
 * own. A `scripts/**` PART5 row names monitor *logic* whose move arrives with
 * routing in RS2; today that file is a Pi-profile entry point (RS0's item-2 scan)
 * unless §5's own table already names it — RS2c moved `scripts/usage-snapshot.ts`'s
 * logic to `packages/muster/bin/usage-snapshot.mts` with `signals.ts`, so that path
 * holds Pi's start file and is no longer in `ROUTING_FILES`;
 * `scripts/model-catalog-scan.ts`/`model-probe.ts` stay Pi-profile entry points, so
 * their Pi-profile reads of Muster stay Pi → harness (RD1).
 */
/**
 * §5's one open edge, which RS1 disclosed and RS2c closed: `scripts/usage-snapshot.ts`
 * (routing) read `extensions/muster/signals.ts` (muster). RS2c moved the snapshot's
 * logic to `packages/muster/bin/usage-snapshot.mts` with `signals.ts`, leaving
 * `scripts/usage-snapshot.ts` as Pi's start file, so no edge remains and no
 * exception is needed. Any new edge fails this test.
 */
const KNOWN_OPEN_EDGES = new Set<string>();

export interface BoundaryFinding {
	from: string;
	to: string;
	specifier: string;
	form: string;
	line?: number;
	reason: string;
}

export interface BoundaryReport {
	crossings: BoundaryFinding[];
	edgeViolations: BoundaryFinding[];
	locationUses: BoundaryFinding[];
}

type FileSource = (path: string) => string | undefined;

/** §5's allowed directions. Anything not listed is a violation. */
const MAY_IMPORT: Record<Pkg, Pkg[]> = {
	core: [],
	routing: ["core"],
	toolbelt: [],
	muster: ["core", "routing", "toolbelt"],
	stays: ["core", "routing", "toolbelt", "muster"],
};

export function analyze(files: readonly string[], readSource: FileSource): BoundaryReport {
	const importsOf = createImportReader(readSource);

	// §7's test rule lives in the scan owner (`import-scan.ts`): one resolver,
	// used by this test and by the listing that moved the tests (OL12-D8).
	const pkgOf = createPackageResolver(files, readSource, importsOf);

	const crossings: BoundaryFinding[] = [];
	const edgeViolations: BoundaryFinding[] = [];
	const locationUses: BoundaryFinding[] = [];

	for (const path of files) {
		const fromPkg = pkgOf(path);
		const records = importsOf(path);
		for (const record of records) {
			if (record.typeOnly) continue;
			const target = resolveTarget(path, record.specifier, readSource);
			if (target === undefined) continue;
			if (target === PI_PACKAGE_SENTINEL) continue;
			const toPkg = pkgOf(target);
			if (fromPkg !== "stays" && toPkg === "stays" && !PORT_WIRING.has(target)) {
				crossings.push({ from: path, to: target, specifier: record.specifier, form: record.form, reason: "harness file imports Pi's profile (RD1)" });
				continue;
			}
			if (fromPkg !== toPkg && fromPkg !== "stays" && toPkg !== "stays" && !MAY_IMPORT[fromPkg].includes(toPkg)) {
				if (KNOWN_OPEN_EDGES.has(`${path}->${target}`)) continue;
				edgeViolations.push({ from: path, to: target, specifier: record.specifier, form: record.form, reason: `§5 does not allow ${fromPkg} → ${toPkg}` });
			}
		}
		if (fromPkg === "stays") continue;
		// S10's rule binds production harness files; a test's own location reads
		// come with it when RS2 moves it (its entry configures the ports then), and
		// §7's four test rules do not ask for them in RS1.
		if (/(^|\/)(tests?)\//.test(path)) continue;
		const text = readSource(path);
		if (text === undefined) continue;
		const lines = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			if (!line.includes("import.meta.url") && !line.includes("__dirname") && !line.includes("__filename")) continue;
			const reason = locationReason(path, line);
			if (reason !== undefined) locationUses.push({ from: path, to: "", specifier: "", form: "location", line: i + 1, reason });
		}
	}

	return { crossings, edgeViolations, locationUses };
}

/** The package folder a harness file belongs to; a literal climb out of it is S10's hazard. */
function packageRoot(path: string): string {
	if (path.startsWith("packages/core/")) return "packages/core";
	if (path.startsWith("packages/routing/")) return "packages/routing";
	if (path.startsWith("packages/toolbelt/")) return "packages/toolbelt";
	if (path.startsWith("packages/muster/")) return "packages/muster";
	if (path.startsWith("extensions/muster/")) return "extensions/muster";
	if (path.startsWith("extensions/lib/")) return "extensions/lib";
	if (path.startsWith("extensions/")) return "extensions";
	if (path.startsWith("toolbelt/")) return "toolbelt";
	if (path.startsWith("scripts/")) return "scripts";
	return "";
}

/**
 * Why one `import.meta.url`/`__dirname` line breaks S10, or `undefined` when it
 * resolves inside the file's own package. Only literal segments are judged; a
 * dynamic segment cannot be proven wrong here.
 */
function locationReason(path: string, line: string): string | undefined {
	if (!line.includes("import.meta.url") && !line.includes("__dirname") && !line.includes("__filename")) return undefined;
	// The segments of a `resolve(dirname(fileURLToPath(import.meta.url)), "a", "..", ...)` climb.
	const segments = [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1]!).filter((segment) => segment === ".." || (!segment.includes("/") && !segment.includes("\\") && !segment.includes(".")));
	if (segments.length === 0) return undefined;
	const root = packageRoot(path);
	const start = posix.dirname(path);
	let dir = start;
	for (const segment of segments) {
		dir = segment === ".." ? posix.dirname(dir) : posix.join(dir, segment);
	}
	if (root !== "" && !(dir === root || dir.startsWith(`${root}/`))) return `climbs out of its own package (${start} -> ${dir}): harness code must not derive a Pi-profile path from its own location (S10)`;
	// A package may hold its own `scripts/` or `state/` folder: muster's launcher
	// and gate moved into `packages/muster/scripts` (OL12-D8), and D8's own-package
	// rule asks the harness to find them beside its own file. So the naming rule
	// binds the files outside a package root, where `scripts` and `state` are Pi's
	// profile folders; inside a package the climb check above already judges it.
	if (root === "" && (segments.includes("scripts") || segments.includes("state"))) return `names Pi's "${segments.find((s) => s === "scripts" || s === "state")!}" from its own location (S10)`;
	return undefined;
}

function trackedFiles(root: string): string[] {
	const listed = execFileSync("git", ["-C", root, "ls-files", "--", ...SCAN_TREES], { encoding: "utf8" });
	return listed.split("\n").filter((line) => line !== "" && SCANNABLE.test(line)).sort();
}

const files = trackedFiles(ROOT);
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

const report = analyze(files, readSource);

function listing(findings: readonly BoundaryFinding[]): string {
	return findings
		.slice(0, 200)
		.map((f) => (f.line === undefined ? `${f.from} -> ${f.to} (${f.form} "${f.specifier}") ${f.reason}` : `${f.from}:${f.line} ${f.reason}`))
		.join("\n");
}

test("the detector reports a harness file that imports a Pi-profile file", () => {
	const fixture: Record<string, string> = {
		"extensions/muster/needs-pi.ts": 'import { helper } from "../lib/pi-only-helper.ts";\n',
		"extensions/lib/pi-only-helper.ts": "export const helper = 1;\n",
	};
	const found = analyze(Object.keys(fixture), (path) => fixture[path]);
	assert.equal(found.crossings.length, 1, `expected one crossing, got ${JSON.stringify(found.crossings)}`);
	assert.equal(found.crossings[0]!.from, "extensions/muster/needs-pi.ts");
});

test("the detector reports a package edge §5 does not allow", () => {
	// §5's own tables: `atomic-settings.ts` is core, `provider-key.ts` is routing.
	const fixture: Record<string, string> = {
		"extensions/lib/atomic-settings.ts": 'import { x } from "./provider-key.ts";\n',
		"extensions/lib/provider-key.ts": "export const x = 1;\n",
	};
	const found = analyze(Object.keys(fixture), (path) => fixture[path]);
	assert.deepEqual(
		found.edgeViolations.map((f) => `${f.from}->${f.to}`),
		["extensions/lib/atomic-settings.ts->extensions/lib/provider-key.ts"],
	);
});

test("the detector reports a location climb out of the file's own package", () => {
	const fixture: Record<string, string> = {
		"extensions/muster/climbs.ts": 'const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts");\n',
	};
	const found = analyze(Object.keys(fixture), (path) => fixture[path]);
	assert.equal(found.locationUses.length, 1, `expected one location finding, got ${JSON.stringify(found.locationUses)}`);
});

test("a package's own scripts folder is the package's, not Pi's (OL12-D8)", () => {
	const own: Record<string, string> = {
		"packages/muster/gateway/uses-own-scripts.ts": 'const p = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "heavy-gate.sh");\n',
	};
	const found = analyze(Object.keys(own), (path) => own[path]);
	assert.deepEqual(found.locationUses, [], "muster's own scripts folder stays inside its own package");
	const climbing: Record<string, string> = {
		"packages/muster/gateway/climbs-to-pi.ts": 'const p = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "heavy-gate.sh");\n',
	};
	const out = analyze(Object.keys(climbing), (path) => climbing[path]);
	assert.equal(out.locationUses.length, 1, "Pi's own scripts folder is still out of bounds");
});

test("no harness file imports Pi's profile, memory/ or a Pi package at runtime", () => {
	assert.deepEqual(report.crossings, [], `harness → Pi-profile crossings (RS0 item 2's 154 on the base):\n${listing(report.crossings)}`);
});

test("every import follows §5's package direction", () => {
	assert.deepEqual(report.edgeViolations, [], `package edges §5 does not allow:\n${listing(report.edgeViolations)}`);
});

test("no package edge or crossing is waived", () => {
	assert.equal(KNOWN_OPEN_EDGES.size, 0, "the §5 edge RS1 disclosed was closed by RS2c, so the exception list is empty");
	const open = analyze(files, readSource);
	const openEdges = [...open.edgeViolations, ...open.crossings].map((f) => `${f.from}->${f.to}`);
	for (const edge of openEdges) assert.ok(KNOWN_OPEN_EDGES.has(edge), `unexpected finding: ${edge}`);
});

test("no harness file derives a Pi-profile path from its own location", () => {
	assert.deepEqual(report.locationUses, [], `location uses outside their own package (S10, RS0 item 8):\n${listing(report.locationUses)}`);
});

test("the scanned set is the harness trees, not the whole repository", () => {
	assert.ok(files.includes("packages/muster/binding.ts"), "a known harness file is scanned");
	assert.ok(files.every((path) => SCAN_TREES.some((tree) => path.startsWith(`${tree}/`))), "only the harness trees are scanned");
	assert.ok(!files.some((path) => path.startsWith("plans/")), "plans are not scanned");
	assert.ok(existsSync(join(ROOT, "packages/core/import-scan.ts")), "the scan owner exists");
	assert.equal(PART5_PACKAGE.get("extensions/muster/signals.ts"), "muster", "the disclosed open edge still names a muster file");
});
