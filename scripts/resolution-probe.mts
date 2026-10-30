/**
 * RS3 step 4 resolution probe (modular-repo blueprint §11 RS3, review focus 2).
 *
 * The question: does everything this tree imports resolve from this tree? In the
 * in-place phase a harness file's bare import passed `~/.pi/agent/node_modules`
 * (pi-mono's) after `packages/node_modules`, which hid a dependency its package
 * never declared (A12). From this repository that lookup cannot happen, so a
 * missing declaration or an import of Pi's profile shows up here instead of in a
 * unit at run time.
 *
 * Three checks, all reported, one exit code:
 *
 *   1. imports — every tracked source file's imports are read with the tree's own
 *      scanner (`core/import-scan.ts`, the one owner of "what is an import"). A
 *      relative path that leaves this repository fails, unless the import is
 *      `import type`: that is erased at run time (RD1's rule is a run-time rule),
 *      and it is reported on its own because the typecheck still needs it. A bare
 *      specifier that does not resolve, or resolves outside this repository, fails.
 *   2. entries — every package's entry modules are walked as an import graph: each
 *      module an entry point reaches, by relative or bare specifier, must resolve
 *      inside this repository. Nothing is executed, so a CLI entry that parses
 *      argv when it loads cannot turn this check into a run.
 *   3. `--link` — a scratch link placed the way Pi's profile places one
 *      (`<dir>/harness -> this repository`) is created, the same graph is walked
 *      through it, and one module is loaded both ways to show the link yields the
 *      same module instance, not a second tree (RD10, blueprint §8).
 *
 * Usage:
 *   node --import tsx scripts/resolution-probe.mts            # checks 1 and 2
 *   node --import tsx scripts/resolution-probe.mts --link     # also check 3
 *   node --import tsx scripts/resolution-probe.mts --json     # one JSON object
 *
 * Exit codes: 0 every check passed, 1 at least one violation, 2 usage.
 */

import { execFileSync } from "node:child_process";
import { isBuiltin } from "node:module";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractImports, tokenize } from "../core/import-scan.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$/;
const PACKAGES = ["core", "routing", "toolbelt", "muster"];

interface Finding {
	check: "imports" | "entries" | "link";
	kind: string;
	file?: string;
	specifier?: string;
	detail?: string;
}

interface Resolution {
	/** A relative or bare specifier that reaches a file inside this repository, as an absolute path. */
	target?: string;
	finding?: Finding;
}

function isInside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !rel.startsWith(sep));
}

/** Every tracked source file, repository-relative. An untracked file is not part of a clone. */
function trackedSources(): string[] {
	return execFileSync("git", ["-C", ROOT, "ls-files", "-z"], { encoding: "utf8" })
		.split("\0")
		.filter((path) => path !== "" && SOURCE.test(path) && !path.split("/").includes("node_modules"))
		.sort();
}

function readImports(file: string, root: string) {
	return extractImports(tokenize(readFileSync(join(root, file), "utf8"), /\.(tsx|jsx)$/.test(file))).imports;
}

/** The installed package directory for a bare specifier, found the way the loader looks: upward from the file. */
function packageDirectory(root: string, file: string, specifier: string): string | undefined {
	const segments = specifier.split("/");
	const name = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]!;
	let dir = dirname(join(root, file));
	while (true) {
		const candidate = join(dir, "node_modules", name);
		if (existsSync(join(candidate, "package.json"))) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** Resolve one specifier the way the loader would, without loading anything. */
function resolveSpecifier(root: string, file: string, specifier: string, typeOnly: boolean): Resolution {
	if (specifier.startsWith("node:") || isBuiltin(specifier)) return {};
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)) return {};
	if (specifier.startsWith(".") || specifier.startsWith("/")) {
		const target = resolve(root, dirname(file), specifier);
		if (isInside(root, target)) return { target };
		return {
			finding: {
				check: "imports",
				kind: typeOnly ? "outside-type" : "outside-runtime",
				file,
				specifier,
				detail: "a relative import leaves this repository",
			},
		};
	}
	// A bare specifier must be an installed package found from the importing file upward,
	// which is the lookup the loader performs. What this checks is *where* the package came
	// from — inside this repository, not from a parent folder — not the package's own
	// `exports` map, which the runtime and the typecheck prove.
	const installed = packageDirectory(root, file, specifier);
	if (installed === undefined) {
		return { finding: { check: "imports", kind: "bare-unresolved", file, specifier, detail: "no installed package of that name is reachable from this tree" } };
	}
	if (!isInside(root, installed)) {
		return { finding: { check: "imports", kind: "bare-outside-root", file, specifier, detail: `the package resolves outside this repository: ${installed}` } };
	}
	return { target: join(installed, "package.json") };
}

function checkImports(files: string[]): Finding[] {
	const findings: Finding[] = [];
	for (const file of files) {
		for (const record of readImports(file, ROOT)) {
			const { finding } = resolveSpecifier(ROOT, file, record.specifier, record.typeOnly);
			if (finding) findings.push(finding);
		}
	}
	return findings;
}

/** The entry modules: each package's command entry points, its top-level modules and the MCP server. */
function entryModules(files: string[]): string[] {
	return files.filter((path) => {
		const segments = path.split("/");
		if (!PACKAGES.includes(segments[0]!)) return false;
		if (path.endsWith(".d.ts")) return false;
		if (segments[1] === "bin" && path.endsWith(".mts")) return true;
		if (segments.length === 2) return true;
		return path === "toolbelt/mcp/server.ts";
	});
}

/**
 * Walk the import graph from the entry modules. Every module reached must resolve
 * inside `root`; the walk reports how many modules and files it touched, so an
 * empty result cannot pass for a successful check.
 */
function walkEntries(entries: string[], root: string, check: Finding["check"]): { findings: Finding[]; reached: number } {
	const findings: Finding[] = [];
	const seen = new Set<string>();
	const tracked = new Set(trackedSources());
	const queue = [...entries];
	while (queue.length > 0) {
		const file = queue.pop()!;
		if (seen.has(file)) continue;
		seen.add(file);
		let imports;
		try {
			imports = readImports(file, root);
		} catch (error) {
			findings.push({ check, kind: "unreadable", file, detail: (error as Error).message.split("\n")[0] });
			continue;
		}
		for (const record of imports) {
			const { target, finding } = resolveSpecifier(root, file, record.specifier, record.typeOnly);
			if (finding) {
				findings.push({ ...finding, check });
				continue;
			}
			if (target === undefined) continue;
			// A resolved dependency (node_modules) is a leaf: its own internals are not this tree's imports.
			const next = isInside(root, target) ? relative(root, target) : target;
			if (SOURCE.test(next) && tracked.has(next)) queue.push(next);
		}
	}
	return { findings, reached: seen.size };
}

/**
 * The second probe (blueprint §8, RD10): a scratch link placed like Pi's profile's
 * `harness` must reach this repository and nothing else. Node resolves symlinks, so a
 * module loaded through the link is the same module instance the direct import got;
 * two instances would mean two trees, which the link's one-resolution rule forbids.
 */
async function checkLink(entries: string[], module = "core/pi-ports.ts"): Promise<{ findings: Finding[]; linkRoot: string; reached: number }> {
	const scratch = mkdtempSync(join(tmpdir(), "muster-link-"));
	const link = join(scratch, "harness");
	symlinkSync(ROOT, link, "dir");
	const findings: Finding[] = [];
	if (!isInside(ROOT, realpathSync(link))) {
		findings.push({ check: "link", kind: "outside-root", file: "harness", detail: `the link resolves to ${realpathSync(link)}, outside ${ROOT}` });
	}
	try {
		const direct = await import(pathToFileURL(join(ROOT, module)).href);
		const linked = await import(pathToFileURL(join(link, module)).href);
		if (direct !== linked) {
			findings.push({ check: "link", kind: "second-tree", file: module, detail: "the link loaded a different module instance than the direct import: two trees are running (RD10)" });
		}
	} catch (error) {
		findings.push({ check: "link", kind: "load-failed", file: module, detail: (error as Error).message.split("\n")[0] });
	}
	const walk = walkEntries(entries, link, "link");
	for (const finding of walk.findings) {
		// A relative import inside the link resolves under the link path, which is this repository.
		const path = finding.file === undefined ? undefined : join(link, finding.file);
		if (finding.kind !== "outside-type" && path !== undefined && !isInside(ROOT, realpathSync(path))) {
			findings.push(finding);
		}
	}
	return { findings, linkRoot: link, reached: walk.reached };
}

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	if (argv.some((arg) => arg !== "--link" && arg !== "--json")) {
		console.error("usage: node --import tsx scripts/resolution-probe.mts [--link] [--json]");
		return 2;
	}
	const wantLink = argv.includes("--link");
	const asJson = argv.includes("--json");

	const files = trackedSources();
	const entries = entryModules(files);
	const importFindings = checkImports(files);
	const walk = walkEntries(entries, ROOT, "entries");
	let findings = importFindings.concat(walk.findings);
	let link: { findings: Finding[]; linkRoot: string; reached: number } | undefined;
	if (wantLink) {
		link = await checkLink(entries);
		findings = findings.concat(link.findings);
		try {
			rmSync(dirname(link.linkRoot), { recursive: true, force: true });
		} catch {
			// A scratch folder that survives is harmless.
		}
	}

	const unique = new Map<string, Finding>();
	for (const finding of findings) unique.set(`${finding.kind}\u0000${finding.file ?? ""}\u0000${finding.specifier ?? ""}`, finding);
	const all = [...unique.values()];
	const failures = all.filter((finding) => finding.kind !== "outside-type");
	const types = all.filter((finding) => finding.kind === "outside-type");
	if (asJson) {
		console.log(JSON.stringify({ root: ROOT, files: files.length, entries: entries.length, modules: walk.reached, linkModules: link?.reached, failures, outsideType: types }, null, 2));
	} else {
		console.log(`== resolution probe: root=${ROOT} files=${files.length} entries=${entries.length} modules=${walk.reached} link=${wantLink ? `yes (${link?.reached} modules)` : "no"} ==`);
		for (const finding of failures) console.log(`FAIL ${finding.check} ${finding.kind} ${finding.file ?? ""} ${finding.specifier ?? ""} ${finding.detail ?? ""}`.trimEnd());
		for (const finding of types) console.log(`TYPE ${finding.kind} ${finding.file ?? ""} ${finding.specifier ?? ""} ${finding.detail ?? ""}`.trimEnd());
		console.log(`== result: failures=${failures.length} outside-type=${types.length} ==`);
	}
	return failures.length === 0 ? 0 : 1;
}

process.exitCode = await main();
