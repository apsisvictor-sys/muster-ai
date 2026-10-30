import "./muster-test-isolation.ts";
/**
 * Undefined-identifier guard for the extension surface.
 *
 * Why this exists: two production breaks in one week shipped as a call to an
 * identifier that was never defined or imported in its module —
 * `resolveActiveMissionId` in delegate.ts (retired helper, still called) and
 * `formatHistoryReadResult` in history-search-extension.ts (exported and used,
 * never imported). Both are `TS2304: Cannot find name`, both passed every
 * existing gate, and both failed only at runtime on first use. The
 * transpile-only check in retired-orchestration-cleanup.test.ts deliberately
 * cannot see this class (its own comment says so).
 *
 * The real TypeScript checker can. This test runs the checker over the
 * production extension sources and fails on any unresolved name, alongside
 * self-tests proving the detector can actually fail and that valid
 * declarations/imports report nothing.
 *
 * Scope (exact): `.ts` files under extensions/ at any depth, excluding
 * declaration files (`*.d.ts`) and every `tests/` directory at any depth —
 * top-level `extensions/tests/` and nested ones such as
 * `extensions/browser/tests/`. Test files are not part of the loaded
 * extension surface; checking only some of them was the inconsistency the
 * explicit scope statement and coverage test below remove.
 *
 * Diagnostics: only TS2304 ("Cannot find name") and TS2552 ("Cannot find name
 * … did you mean …"). Every other diagnostic is ignored on purpose — this
 * codebase is not type-clean under a full check, and a gate that failed on
 * pre-existing type noise would be turned off. This is therefore NOT a
 * universal typecheck gate; it promises only the unresolved-name family in
 * the source set above.
 *
 * Invocation: this file runs when selected explicitly, and it is part of
 * run-guarded.sh's default invocation set, so the default guarded run covers
 * it. It is not wired into a whole-project typecheck, because no such gate
 * exists here.
 *
 * Note on severity: an unresolved name in a VALUE position throws
 * ReferenceError on first call. The same error in a TYPE position is erased by
 * the transform and only fails a real typecheck. The gate reports both and the
 * assertion message names which is which for the reader.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { harnessRoot } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

// TypeScript 7's package exports do not include `./lib/tsc.js`, so the entry is
// resolved from the package root, which is exported. Resolving through the
// repo's own dependency tree keeps this independent of where the tree lives.
const TSC_ENTRY = join(
	dirname(createRequire(import.meta.url).resolve("typescript/package.json")),
	"lib",
	"tsc.js",
);

const HARNESS_ROOT = harnessRoot(import.meta.url);
const EXTENSIONS_DIR = join(piAgentDir(), "extensions");

/** Cannot find name / Cannot find name, did you mean. */
const UNRESOLVED_NAME_CODES = new Set([2304, 2552]);

type UnresolvedName = { file: string; line: number; code: number; message: string };

/** Test directories at any depth are not part of the loaded extension
 * surface. Directory names are matched segment-wise so `tests/` at the top
 * level and nested test directories are excluded by the same rule. */
function isExcluded(path: string): boolean {
	return relative(EXTENSIONS_DIR, path).split(/[\\/]/).includes("tests");
}

function collectSources(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			if (entry === "node_modules" || entry.startsWith(".")) continue;
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue;
			if (isExcluded(full)) continue;
			out.push(full);
		}
	};
	walk(root);
	return out;
}

/**
 * Run the real checker over `rootNames` and return only the unresolved-name
 * family. Exported shape is deliberately parameterisable so the self-test can
 * point it at a fixture instead of the live tree.
 */
export async function unresolvedNames(rootNames: readonly string[], baseUrl: string): Promise<UnresolvedName[]> {
	// TypeScript 7 ships no public program API: `typescript` exposes only the
	// version, and the compiler API under `typescript/unstable/*` is node guards,
	// kinds and a tokenizer with no program/diagnostics entry point. The
	// compiler's CLI is the stable interface, so this runs `tsc --noEmit` over a
	// generated config and reads the unresolved-name family off its output. The
	// promise is unchanged: only TS2304/TS2552 are reported, every other
	// diagnostic is ignored on purpose.
	const configPath = join(mkdtempSync(join(tmpdir(), "undefined-id-check-")), "tsconfig.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			compilerOptions: {
				noEmit: true,
				skipLibCheck: true,
				target: "ES2022",
				module: "ESNext",
				moduleResolution: "Bundler",
				types: [],
				// TypeScript 7 takes bare lib names and removed `baseUrl`; the
				// catch-all mapping below is what the removed option used to do.
				lib: ["es2022", "dom"],
				strict: false,
				paths: {
					"@earendil-works/pi-ai": ["./node_modules/@earendil-works/pi-ai/dist/index.js"],
					"@earendil-works/pi-ai/*": ["./node_modules/@earendil-works/pi-ai/dist/*"],
					"*": ["./*"],
				},
			},
			files: [...rootNames],
		}),
	);
	const result = spawnSync(process.execPath, [TSC_ENTRY, "-p", configPath, "--noEmit", "--pretty", "false"], {
		cwd: baseUrl,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	rmSync(dirname(configPath), { recursive: true, force: true });

	const found: UnresolvedName[] = [];
	// `path(line,col): error TS2304: message` — the CLI's stable diagnostic shape.
	for (const line of `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split("\n")) {
		const match = /^(.+?)\((\d+),(\d+)\): error TS(\d+): (.*)$/.exec(line);
		if (!match) continue;
		const code = Number(match[4]);
		if (!UNRESOLVED_NAME_CODES.has(code)) continue;
		found.push({
			file: relative(baseUrl, match[1]!),
			line: Number(match[2]),
			code,
			message: match[5]!,
		});
	}
	return found;
}

test("the unresolved-name detector actually fails on an undefined identifier", async () => {
	const dir = mkdtempSync(join(tmpdir(), "undefined-id-fixture-"));
	try {
		writeFileSync(join(dir, "fixture.ts"), "export function run(): unknown { return neverDefinedAnywhere; }\n", "utf8");
		const found = await unresolvedNames([join(dir, "fixture.ts")], dir);
		assert.ok(
			found.some((d) => d.code === 2304 && /neverDefinedAnywhere/.test(d.message)),
			`detector failed to flag a known-undefined identifier; got ${JSON.stringify(found)}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the near-miss family (TS2552) is reported too", async () => {
	const dir = mkdtempSync(join(tmpdir(), "undefined-id-miss-"));
	try {
		// A close-enough spelling makes the checker emit TS2552 ("did you mean")
		// instead of TS2304. Both supported families must be seen.
		writeFileSync(join(dir, "fixture.ts"), "const knownValue = 1;\nexport function run(): number { return knowValue; }\n", "utf8");
		const found = await unresolvedNames([join(dir, "fixture.ts")], dir);
		assert.ok(
			found.some((d) => d.code === 2552 && /knowValue/.test(d.message)),
			`detector failed to flag a near-miss identifier; got ${JSON.stringify(found)}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("valid declarations and imports report no unresolved name", async () => {
	const dir = mkdtempSync(join(tmpdir(), "undefined-id-valid-"));
	try {
		writeFileSync(join(dir, "dep.ts"), "export const provided = 1;\n", "utf8");
		writeFileSync(
			join(dir, "fixture.ts"),
			[
				"import { provided } from \"./dep.js\";",
				"declare const ambientValue: number;",
				"export function run(): number { return provided + ambientValue; }",
				"",
			].join("\n"),
			"utf8",
		);
		const found = await unresolvedNames([join(dir, "fixture.ts")], dir);
		assert.deepEqual(found, [], `a fully declared/imported module must pass; got ${JSON.stringify(found)}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the collected source set is the production extension surface, not the test tree", () => {
	const relativeSources = collectSources(EXTENSIONS_DIR).map((path) => relative(EXTENSIONS_DIR, path).replace(/\\/g, "/"));
	assert.ok(relativeSources.includes("context-ledger.ts"), "a known top-level production module is collected");
	assert.ok(relativeSources.includes("lib/ledger-events.ts"), "a known lib production module is collected");
	assert.ok(relativeSources.includes("telemetry-stats/quality.ts"), "nested production modules are collected");
	assert.equal(relativeSources.some((path) => path.split("/").includes("tests")), false, "no tests/ directory at any depth is collected");
	assert.equal(relativeSources.some((path) => path.endsWith(".d.ts")), false, "declaration files are excluded");
	assert.ok(relativeSources.every((path) => path.endsWith(".ts")), "only TypeScript modules are collected");
});

test("no production extension module calls an identifier that is neither declared nor imported", async () => {
	const sources = collectSources(EXTENSIONS_DIR);
	assert.ok(sources.length > 50, `expected the production extension surface to be non-trivial, found ${sources.length} files`);
	const found = await unresolvedNames(sources, HARNESS_ROOT);
	const report = found.map((d) => `${d.file}:${d.line} TS${d.code} ${d.message}`).join("\n");
	assert.deepEqual(
		found,
		[],
		`unresolved identifiers in the production extension surface (TS2304/TS2552; test directories excluded). A value-position reference throws ReferenceError at first call; a type-position reference is a silent type error:\n${report}`,
	);
});
