/**
 * The one owner of the harness import scan (`plans/repo/modular-repo-blueprint-2026-10-17.md`,
 * §7 "tests and their helpers": the manifest script and the tests share one scan).
 *
 * TypeScript's own lexer, `createScanner` from `typescript/unstable/ast`: TypeScript 7.0.2
 * ships no parse-to-AST JS API, so the lexer is the parser surface it exposes. It is not a
 * text search: comments, string contents and template literals cannot produce a false import,
 * and every import form is recognised from tokens.
 */

import { posix } from "node:path";
import { LanguageVariant, ScriptTarget, SyntaxKind, createScanner } from "typescript/unstable/ast";

// ---------------------------------------------------------------------------
// Token scan (TypeScript's own lexer)
// ---------------------------------------------------------------------------

export interface Token {
	kind: number;
	kindName: string;
	text: string;
	pos: number;
}

export type ImportForm = "import" | "side-effect" | "export-from" | "dynamic" | "require";

export interface ImportRecord {
	/** The module specifier exactly as written. */
	specifier: string;
	form: ImportForm;
	/** Token offset of the `import`/`export`/`require` keyword. */
	pos: number;
	/** An `import type …` / `export type …` clause: erased at runtime (RD1's rule is a runtime rule). */
	typeOnly: boolean;
}

export interface ImportScan {
	imports: ImportRecord[];
	/** Dynamic `import()` whose argument is not a string literal (a scan blind spot). */
	dynamicNonLiteral: number[];
	/** `import.meta.url` token offsets. */
	importMetaUrl: number[];
	/** `__dirname` / `__filename` identifier offsets. */
	dirRefs: { name: string; pos: number }[];
}

/**
 * Whether a `/` at this point starts a regular expression rather than a division.
 * The lexer cannot know (the parser decides with `reScanSlashToken`), so the walk uses the
 * usual previous-token rule. A regex left as a division would put its braces into the
 * token stream and unbalance every brace-depth walk over the file.
 */
function mayStartRegex(prev: Token | undefined): boolean {
	if (prev === undefined) return true;
	switch (prev.kind) {
		case SyntaxKind.Identifier:
		case SyntaxKind.PrivateIdentifier:
		case SyntaxKind.NumericLiteral:
		case SyntaxKind.BigIntLiteral:
		case SyntaxKind.StringLiteral:
		case SyntaxKind.RegularExpressionLiteral:
		case SyntaxKind.NoSubstitutionTemplateLiteral:
		case SyntaxKind.TemplateTail:
		case SyntaxKind.CloseParenToken:
		case SyntaxKind.CloseBracketToken:
		case SyntaxKind.CloseBraceToken:
		case SyntaxKind.PlusPlusToken:
		case SyntaxKind.MinusMinusToken:
		case SyntaxKind.ThisKeyword:
		case SyntaxKind.SuperKeyword:
		case SyntaxKind.TrueKeyword:
		case SyntaxKind.FalseKeyword:
		case SyntaxKind.NullKeyword:
			return false;
		default:
			return true;
	}
}

/** Tokenize with TypeScript's lexer, trivia skipped. */
export function tokenize(text: string, jsx = false): Token[] {
	const scanner = createScanner(
		true,
		jsx ? LanguageVariant.JSX : LanguageVariant.Standard,
		text,
	);
	const tokens: Token[] = [];
	const push = (kind: number): void => {
		tokens.push({
			kind,
			kindName: SyntaxKind[kind] ?? String(kind),
			text: scanner.getTokenText(),
			pos: scanner.getTokenStart(),
		});
	};

	// A template literal needs the parser's own re-scan: after the `}` that closes a `${…}`
	// substitution the scanner must be put back into template mode (`reScanTemplateToken`),
	// or it reads the template body as code and can stall on a token it will not advance past.
	// `contexts` holds the brace depth of each open substitution.
	const contexts: number[] = [];
	let lastPos = -1;
	let kind = scanner.scan();
	while (kind !== SyntaxKind.EndOfFile) {
		// The `}` that closes a `${…}` is not code and is not emitted: emitting it would leave
		// the token stream (and every brace-depth walk over it) unbalanced.
		const closesSubstitution = kind === SyntaxKind.CloseBraceToken && contexts.length > 0 && contexts[contexts.length - 1] === 0;
		if (!closesSubstitution) push(kind);
		if (kind === SyntaxKind.TemplateHead) {
			contexts.push(0);
		} else if (kind === SyntaxKind.TemplateMiddle) {
			if (contexts.length > 0) contexts[contexts.length - 1] = 0;
			else contexts.push(0);
		} else if (kind === SyntaxKind.TemplateTail) {
			contexts.pop();
		} else if (contexts.length > 0) {
			const top = contexts.length - 1;
			if (kind === SyntaxKind.OpenBraceToken) contexts[top] = contexts[top]! + 1;
			else if (kind === SyntaxKind.CloseBraceToken) {
				if (contexts[top] === 0) {
					kind = scanner.reScanTemplateToken(true);
					if (kind === SyntaxKind.EndOfFile) break;
					continue;
				}
				contexts[top] = contexts[top]! - 1;
			}
		}
		const pos = scanner.getTokenEnd();
		kind = scanner.scan();
		// Guard against any other of the lexer's non-advancing states: resume one character on.
		if (kind !== SyntaxKind.EndOfFile && pos <= lastPos) {
			stallCount++;
			lastPos = pos + 1;
			scanner.setText(text, lastPos);
			kind = scanner.scan();
			continue;
		}
		lastPos = pos;
		if ((kind === SyntaxKind.SlashToken || kind === SyntaxKind.SlashEqualsToken) && mayStartRegex(tokens[tokens.length - 1])) {
			const rescanned = scanner.reScanSlashToken();
			if (rescanned === SyntaxKind.RegularExpressionLiteral) kind = rescanned;
		}
	}
	return tokens;
}

/** Lexer stalls seen (a token that did not advance); reported in the manifest. */
export let stallCount = 0;

/** Token text with the surrounding quotes removed (the lexer keeps them). */
function literalText(token: Token): string {
	const raw = token.text;
	if (raw.length >= 2 && (raw.startsWith('"') || raw.startsWith("'") || raw.startsWith("`"))) {
		return raw.slice(1, -1);
	}
	return raw;
}

/** Tokens that may sit between `import`/`export` and `from` in a clause. */
const CLAUSE_TOKENS = new Set<number>([
	SyntaxKind.Identifier,
	SyntaxKind.TypeKeyword,
	SyntaxKind.AsteriskToken,
	SyntaxKind.OpenBraceToken,
	SyntaxKind.CloseBraceToken,
	SyntaxKind.CommaToken,
	SyntaxKind.AsKeyword,
	SyntaxKind.DefaultKeyword,
]);

const MAX_LOOKAHEAD = 400;

/**
 * Every import form in a token stream:
 * `import x from "m"`, `import "m"`, `import type {...} from "m"`, `import x = require("m")`,
 * `export ... from "m"`, `import("m")` and `require("m")`. A member access (`obj.import`),
 * an object key (`{ import: 1 }`) and `import.meta` are not imports.
 */
export function extractImports(tokens: Token[]): ImportScan {
	const imports: ImportRecord[] = [];
	const dynamicNonLiteral: number[] = [];
	const importMetaUrl: number[] = [];
	const dirRefs: { name: string; pos: number }[] = [];

	const at = (i: number): Token | undefined => tokens[i];

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;

		if (token.kind === SyntaxKind.Identifier && (token.text === "__dirname" || token.text === "__filename")) {
			dirRefs.push({ name: token.text, pos: token.pos });
		}

		if (token.kind === SyntaxKind.ImportKeyword) {
			const prev = at(i - 1);
			const next = at(i + 1);
			if (prev !== undefined && prev.kind === SyntaxKind.DotToken) continue; // obj.import
			if (next === undefined) continue;
			if (next.kind === SyntaxKind.DotToken) {
				// `import.meta.url`
				if (at(i + 2)?.text === "meta" && at(i + 3)?.kind === SyntaxKind.DotToken) importMetaUrl.push(token.pos);
				continue;
			}
			if (next.kind === SyntaxKind.ColonToken) continue; // object key
			if (next.kind === SyntaxKind.OpenParenToken) {
				const arg = at(i + 2);
				if (arg !== undefined && arg.kind === SyntaxKind.StringLiteral) {
					imports.push({ specifier: literalText(arg), form: "dynamic", pos: token.pos, typeOnly: false });
				} else {
					dynamicNonLiteral.push(token.pos);
				}
				continue;
			}
			if (next.kind === SyntaxKind.StringLiteral) {
				imports.push({ specifier: literalText(next), form: "side-effect", pos: token.pos, typeOnly: false });
				continue;
			}
			// Clause form, including `import x = require("m")`.
			const statementTypeOnly = next.kind === SyntaxKind.TypeKeyword && at(i + 2)?.kind !== SyntaxKind.FromKeyword;
			// `import { type A, type B } from "m"` is type-only too: its specifiers
			// carry the `type` modifier, so the statement is erased at runtime (RD1's
			// rule is a runtime rule). An `as` rename is still the item's type.
			let valueSpecifier = false;
			for (let j = i + 1; j < tokens.length; j++) {
				const cur = at(j)!;
				if (cur.kind === SyntaxKind.FromKeyword) break;
				if (cur.kind === SyntaxKind.Identifier) {
					const prev = at(j - 1)!;
					if (prev.kind !== SyntaxKind.TypeKeyword && prev.kind !== SyntaxKind.AsKeyword) valueSpecifier = true;
				} else if (cur.kind === SyntaxKind.AsteriskToken) valueSpecifier = true;
				else if (cur.kind !== SyntaxKind.TypeKeyword && cur.kind !== SyntaxKind.AsKeyword && !CLAUSE_TOKENS.has(cur.kind)) break;
			}
			const typeOnly = statementTypeOnly || !valueSpecifier;
			let sawAssignment = false;
			for (let j = i + 1; j < Math.min(i + 1 + MAX_LOOKAHEAD, tokens.length); j++) {
				const cur = tokens[j]!;
				if (cur.kind === SyntaxKind.FromKeyword) {
					const spec = at(j + 1);
					if (spec !== undefined && spec.kind === SyntaxKind.StringLiteral) {
						imports.push({ specifier: literalText(spec), form: "import", pos: token.pos, typeOnly });
					}
					break;
				}
				if (cur.kind === SyntaxKind.FirstAssignment) {
					sawAssignment = true;
					break;
				}
				if (!CLAUSE_TOKENS.has(cur.kind)) break;
			}
			if (sawAssignment) {
				const eq = tokens.findIndex((t, k) => k > i && t.kind === SyntaxKind.FirstAssignment);
				const require = at(eq + 1);
				const paren = at(eq + 2);
				const spec = at(eq + 3);
				if (
					require !== undefined &&
					require.kind === SyntaxKind.RequireKeyword &&
					paren !== undefined &&
					paren.kind === SyntaxKind.OpenParenToken &&
					spec !== undefined &&
					spec.kind === SyntaxKind.StringLiteral
				) {
					imports.push({ specifier: literalText(spec), form: "require", pos: token.pos, typeOnly: false });
				}
			}
			continue;
		}

		if (token.kind === SyntaxKind.ExportKeyword) {
			for (let j = i + 1; j < Math.min(i + 1 + MAX_LOOKAHEAD, tokens.length); j++) {
				const cur = tokens[j]!;
				if (cur.kind === SyntaxKind.FromKeyword) {
					const spec = at(j + 1);
					if (spec !== undefined && spec.kind === SyntaxKind.StringLiteral) {
						imports.push({ specifier: literalText(spec), form: "export-from", pos: token.pos, typeOnly: at(i + 1)?.kind === SyntaxKind.TypeKeyword });
					}
					break;
				}
				if (!CLAUSE_TOKENS.has(cur.kind)) break;
			}
			continue;
		}
	}

	return { imports, dynamicNonLiteral, importMetaUrl, dirRefs };
}

// ---------------------------------------------------------------------------
// Line index
// ---------------------------------------------------------------------------

export class LineIndex {
	private readonly starts: number[] = [0];
	constructor(private readonly text: string) {
		for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
	}
	line(pos: number): number {
		let lo = 0;
		let hi = this.starts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (this.starts[mid]! <= pos) lo = mid;
			else hi = mid - 1;
		}
		return lo + 1;
	}
	lineText(line: number): string {
		const start = this.starts[line - 1] ?? 0;
		const end = line < this.starts.length ? this.starts[line]! - 1 : this.text.length;
		return this.text.slice(start, end).replace(/\r$/, "");
	}
	get lineCount(): number {
		return this.starts.length;
	}
}

// ---------------------------------------------------------------------------
// Package assignment (§5) — one owner: the same tables the manifest prints
// ---------------------------------------------------------------------------


export type Pkg = "core" | "routing" | "toolbelt" | "muster" | "stays";

export const PKG_ORDER: Pkg[] = ["core", "routing", "toolbelt", "muster", "stays"];
/** Test assignment order: a test of muster behaviour moves with muster, not with core. */
export const TEST_PACKAGE_ORDER: Pkg[] = ["muster", "toolbelt", "routing", "core"];

/** §5 `core`. */
export const CORE_FILES = new Set([
	"extensions/lib/atomic-settings.ts",
	"extensions/lib/event-wake.ts",
	"extensions/lib/graph-refresh.ts",
	"extensions/lib/self-improving-redactor.ts",
	// §5 "new from the seams" (created by RS1, listed here so RS1 compares against one list).
	"extensions/lib/core/import-scan.ts",
	"extensions/lib/core/pi-ports.ts",
	"extensions/lib/core/excluded-cwd.ts",
	"extensions/lib/core/delegate-evidence.ts",
	"extensions/lib/core/programme.ts",
	"extensions/lib/core/decision-types.ts",
]);

/**
 * §5 `routing`. The ten quota readers left this list when they moved into
 * `packages/routing/`, where the directory rule in `packageOf` assigns them
 * (VR24-176 (4b)); `qwen-token-plan-quota.ts` is gone with the provider (VR24-173).
 */
export const ROUTING_FILES = new Set([
	"extensions/lib/provider-pool.ts",
	"extensions/lib/quota-classifier.ts",
	"extensions/lib/delegate-pool.ts",
	"extensions/lib/provider-key.ts",
	"extensions/muster/provider-policy.ts",
]);

/** §5 `toolbelt`: the three `lib/` files that toolbelt code owns. */
export const TOOLBELT_LIB_FILES = new Set([
	"extensions/lib/toolbelt-run.ts",
	"extensions/lib/toolbelt-tool-spec.ts",
	"extensions/lib/toolbelt-operations.ts",
]);

/**
 * Part 5 monitor files (§5 "the Part 5 monitor files (RS0 lists them)"), from
 * `plans/provider-accounts/usage-monitor-blueprint-2026-10-16.md`. RS0 lists them
 * because the blueprint assigns them by hand: `routing` takes the usage snapshot's
 * logic and the monitor's routing side, `muster` takes its gateway/signals side, and
 * a file the monitor does not move stays with Pi.
 */
export const PART5_MONITOR_FILES: { path: string; pkg: Pkg; why: string }[] = [
	{ path: "scripts/usage-snapshot.ts", pkg: "routing", why: "usage monitor UM1 (logics move: §5)" },
	{ path: "extensions/telemetry-stats/subscriptions.ts", pkg: "routing", why: "monitor inventory loader (UM1); Pi-profile importer today (§3, status-bar)" },
	{ path: "extensions/telemetry-stats/subscriptions.json", pkg: "routing", why: "monitor inventory data (UM1)" },
	{ path: "extensions/lib/provider-pool.ts", pkg: "routing", why: "lane ranking (UM9, §5)" },
	{ path: "extensions/lib/lane-control.ts", pkg: "routing", why: "UM9 P5-D6 guard of the ranked route" },
	{ path: "extensions/muster/lane-model.mjs", pkg: "muster", why: "UM9 lane model check (muster owns lane model choice)" },
	{ path: "scripts/pi-lane-launch.sh", pkg: "stays", why: "UM9: the launcher stays in Pi's profile (§8)" },
	{ path: "extensions/provider-failover.ts", pkg: "stays", why: "UM9: Pi extension, logs the failover it already makes" },
	{ path: "extensions/muster/gateway/tools.ts", pkg: "muster", why: "UM2/UM8 gateway tools (usage_read, signals_read, signals_add)" },
	{ path: "extensions/muster/signals.ts", pkg: "muster", why: "UM8 signal log (created by Part 5)" },
	{ path: "extensions/muster/cli/signals.ts", pkg: "muster", why: "UM8 `muster signals` verb (created by Part 5)" },
	{ path: "extensions/muster/cli/usage.ts", pkg: "muster", why: "UM2 `muster usage` verb (created by Part 5)" },
	{ path: "extensions/muster/cli/subscriptions.ts", pkg: "muster", why: "UM1 `muster subscriptions` verb (created by Part 5)" },
	{ path: "scripts/model-catalog-scan.ts", pkg: "muster", why: "UM10 catalog scan (created by Part 5); RS1 reads it as a Muster script like §5's bin/*.mts" },
	{ path: "scripts/model-probe.ts", pkg: "muster", why: "UM10 model probe (created by Part 5); RS1 reads it as a Muster script like §5's bin/*.mts" },
	{ path: "systemd/pi-usage-snapshot.timer", pkg: "stays", why: "unit stays in Pi's profile (§8)" },
	{ path: "systemd/pi-usage-snapshot.service", pkg: "stays", why: "unit stays in Pi's profile (§8)" },
	{ path: "extensions/tests/usage-snapshot.test.ts", pkg: "routing", why: "UM1 tests move with the code (§9)" },
];

export const TOOLBELT_PERSONAL_DATA = new Set([
	"toolbelt/data/accounts.json",
	"toolbelt/data/ledger.jsonl",
	"toolbelt/data/identity-cache.json",
]);

/** §6 Pi adapter files inside `extensions/muster/`. */
export const MUSTER_PI_ADAPTER_FILES = new Set([
	"extensions/muster/index.ts",
	"extensions/muster/execution-guard.ts",
	"extensions/muster/lane-card-adapter.ts",
	"extensions/muster/delegate-settlement.ts",
	// RS1 F1: the S4/S5 port adapter is Pi wiring (its header says so, §6), and it
	// imports memory's readers and the history/context-lookup tools, so it belongs
	// with the other Muster Pi adapters rather than in the muster package.
	"extensions/muster/harness-gateway-ports.ts",
	"extensions/muster/package.json",
	"extensions/muster/build-hook-bundle.mjs",
	"extensions/muster/claude-hook.bundle.mjs",
	"extensions/muster/runtime-provenance.json",
]);

/** §5 the seven Muster `lib/` files. */
export const MUSTER_LIB_FILES = new Set([
	"extensions/lib/agent-inbox.ts",
	"extensions/lib/bus-root.ts",
	"extensions/lib/claude-lane-card.ts",
	"extensions/lib/inbox-attachments.ts",
	"extensions/lib/lane-card.ts",
	"extensions/lib/lane-control.ts",
	"extensions/lib/lane-directory.ts",
]);

/** §5 the script bodies that become `muster/bin/*.mts`. */
export const MUSTER_SCRIPT_FILES = new Set([
	"scripts/muster.mts",
	"scripts/muster-tick.mts",
	"scripts/muster-janitor.mts",
	"scripts/asks-import.mts",
	// F-send-back: Muster's two timer scripts, built by UM9/UM10 after RS0's scan.
	// §5's muster row owns a Muster script run by a unit (`bin/*.mts` script body),
	// and these are the same shape: `systemd/pi-model-catalog-scan.*` runs the scan,
	// it raises Muster signals, and `muster probe` calls the probe. PART5 predicted
	// routing for them before they existed; routing → muster is not an allowed edge,
	// and each would leave the other side red, so they belong with the other Muster
	// scripts.
	"scripts/model-catalog-scan.ts",
	"scripts/model-probe.ts",
	// Part 7's files: §3 says they are not on this base; the check below records the truth.
	"scripts/musterd.mts",
	// LC14's import and export bodies, called by `muster ledger flip` (LC15): Muster scripts.
	"scripts/muster-ledger-import.mts",
	"scripts/muster-ledger-export.mts",
]);

/** §5's package of one path, the exact rule RS0 used to fill item 1. */
export interface PackageAssignment {
	pkg: Pkg;
	why: string;
}

export function packageOf(path: string): PackageAssignment {
	// The trees RS2 moves into, and the tracked `harness` link that reaches them:
	// one package per directory, so a moved file or test keeps its §5 assignment
	// and a Pi-profile specifier through the link resolves to the same package.
	if (path.startsWith("harness/")) return packageOf(path.slice("harness/".length));
	if (path.startsWith("packages/core/")) return { pkg: "core", why: "§5 core (RS2a)" };
	if (path.startsWith("packages/routing/")) return { pkg: "routing", why: "§5 routing (RS2a)" };
	if (path.startsWith("packages/toolbelt/")) return { pkg: "toolbelt", why: "§5 toolbelt (RS2b)" };
	if (path.startsWith("packages/muster/")) return { pkg: "muster", why: "§5 muster (RS2c)" };
	// `extensions/lib/core/` **is** §5's core package: the files RS1 moved there and
	// every one added later (F2's `append-line.ts`) belong to it by directory, so a
	// new core file is never read as Pi's profile by accident.
	if (CORE_FILES.has(path) || path.startsWith("extensions/lib/core/")) return { pkg: "core", why: "§5 core" };
	if (ROUTING_FILES.has(path)) return { pkg: "routing", why: "§5 routing" };
	if (TOOLBELT_LIB_FILES.has(path)) return { pkg: "toolbelt", why: "§5 toolbelt" };
	if (MUSTER_LIB_FILES.has(path)) return { pkg: "muster", why: "§5 muster (one of the seven lib files)" };
	if (MUSTER_SCRIPT_FILES.has(path)) return { pkg: "muster", why: "§5 muster bin/*.mts script body" };
	if (path.startsWith("toolbelt/")) {
		if (TOOLBELT_PERSONAL_DATA.has(path)) return { pkg: "stays", why: "personal data, stays at its path (RD3, S9)" };
		return { pkg: "toolbelt", why: "§5 toolbelt tree" };
	}
	if (path.startsWith("extensions/muster/")) {
		if (MUSTER_PI_ADAPTER_FILES.has(path) || path.startsWith("extensions/muster/launchers/")) return { pkg: "stays", why: "§6 Muster's Pi adapter" };
		return { pkg: "muster", why: "§5 muster" };
	}
	if (path.startsWith("extensions/tests/")) return { pkg: "stays", why: "assigned below from the imports it reaches" };
	return { pkg: "stays", why: "Pi's profile (§6)" };
}

/** Test assignment order (§5 "tests move with the code"): the first package a test's imports reach. */
export function assignTestPackage(reached: Iterable<Pkg>): Pkg | undefined {
	const set = new Set(reached);
	return TEST_PACKAGE_ORDER.find((k) => set.has(k));
}

// ---------------------------------------------------------------------------
// The shared plumbing: one resolver for §7's test rule, used by the boundary
// test and by the listing that moved the tests (OL12 item 1, D3).
// ---------------------------------------------------------------------------

/** Reads one repo-relative file's source, or undefined when it is not there. */
export type FileSource = (path: string) => string | undefined;

/** A bare specifier that names a Pi package: RS0 item 3's subject (RD8), not a path. */
export const PI_PACKAGE = /^@earendil-works\//;
export const PI_PACKAGE_SENTINEL = "<pi-package>";

/** One file's imports, read once and kept. */
export function createImportReader(readSource: FileSource, cache = new Map<string, ImportRecord[]>()): (path: string) => ImportRecord[] {
	return (path: string): ImportRecord[] => {
		const cached = cache.get(path);
		if (cached) return cached;
		const text = readSource(path);
		const records = text === undefined ? [] : extractImports(tokenize(text, /\.(tsx|jsx)$/.test(path))).imports;
		cache.set(path, records);
		return records;
	};
}

/**
 * The repo path a relative specifier names, honouring the `.js`→`.ts` ESM convention.
 * Pi's profile reaches harness code through the one tracked link (RD5/AC3): `harness/x` is
 * `packages/x`, so the finding names the real file.
 */
export function resolveTarget(from: string, specifier: string, readSource: FileSource): string | undefined {
	if (!specifier.startsWith(".") && !specifier.startsWith("/")) return PI_PACKAGE.test(specifier) ? PI_PACKAGE_SENTINEL : undefined;
	let base = posix.normalize(posix.join(posix.dirname(from), specifier));
	if (base.startsWith("harness/")) base = `packages/${base.slice("harness/".length)}`;
	const candidates = [
		base,
		base.replace(/\.js$/, ".ts"),
		base.replace(/\.mjs$/, ".mts"),
		base.replace(/\.js$/, ".tsx"),
		`${base}.ts`,
		`${base}.mts`,
		`${base}/index.ts`,
		`${base}/index.mts`,
	];
	return candidates.find((candidate) => readSource(candidate) !== undefined);
}

/** §5's Part-5 monitor files that own a package; the rest stay in Pi's profile (§6). */
export const PART5_PACKAGE = new Map(
	PART5_MONITOR_FILES.filter((row) => row.pkg !== "stays" && row.path.startsWith("extensions/") && !row.path.startsWith("extensions/tests/")).map((row) => [row.path, row.pkg]),
);

/**
 * The package each file in Pi's test folder takes (§7 "tests and their helpers"): the tests
 * and the helpers they import.
 *
 * A test that imports both harness code and a Pi-only file tests their integration and
 * stays in Pi's profile; a test that imports only harness code takes the package it
 * reaches; a helper moves with the tests that import it (RD7).
 *
 * The helper's own package comes from the packages its importers reach, so the rule never
 * depends on the order the files are read in: a test that reaches no package directly but
 * reaches one through a helper moves with that helper's package, and a helper that reads
 * Pi's profile stays (the harness may not import Pi's profile, RD1).
 */
export function assignTestPackages(
	files: readonly string[],
	readSource: FileSource,
	importsOf: (path: string) => ImportRecord[] = createImportReader(readSource),
): Map<string, Pkg> {
	const inTests = "extensions/tests/";
	const isHelper = (path: string): boolean => path.startsWith(inTests) && !/\.test\.(ts|mts)$/.test(path);
	const isTest = (path: string): boolean => path.startsWith(inTests) && !isHelper(path);

	// What each file in Pi's test folder names, once: the packages it reaches, the Pi-only
	// files it reads, and the helpers it imports.
	const reached = new Map<string, { pkgs: Set<Pkg>; pi: Set<string>; helpers: Set<string> }>();
	for (const path of files) {
		if (!path.startsWith(inTests)) continue;
		const pkgs = new Set<Pkg>();
		const pi = new Set<string>();
		const helpers = new Set<string>();
		for (const record of importsOf(path)) {
			const target = resolveTarget(path, record.specifier, readSource);
			if (target === undefined || target === PI_PACKAGE_SENTINEL) continue;
			if (target.startsWith("packages/")) pkgs.add(target.split("/")[1] as Pkg);
			else if (isHelper(target)) helpers.add(target);
			else pi.add(target);
		}
		reached.set(path, { pkgs, pi, helpers });
	}

	// The helpers' importers, so a helper takes the package of the tests that import it.
	const importers = new Map<string, string[]>();
	for (const path of files) {
		if (!isTest(path)) continue;
		for (const helper of reached.get(path)?.helpers ?? []) importers.set(helper, [...(importers.get(helper) ?? []), path]);
	}

	const helperPackage = new Map<string, Pkg>();
	for (const path of files) {
		if (!isHelper(path)) continue;
		const own = reached.get(path);
		if (own === undefined) continue;
		const packages = new Set<Pkg>(own.pkgs);
		for (const importer of importers.get(path) ?? []) for (const pkg of reached.get(importer)?.pkgs ?? []) packages.add(pkg);
		// A helper that reads Pi's profile cannot move into the harness (RD1).
		helperPackage.set(path, own.pi.size > 0 || packages.size === 0 ? "stays" : (assignTestPackage(packages) ?? "stays"));
	}

	const testPackage = new Map<string, Pkg>();
	for (const path of files) {
		if (!isTest(path)) continue;
		const own = reached.get(path);
		if (own === undefined) continue;
		const packages = new Set<Pkg>(own.pkgs);
		let blocked = own.pi.size > 0;
		for (const helper of own.helpers) {
			const pkg = helperPackage.get(helper);
			if (pkg === undefined || pkg === "stays") blocked = true;
			else packages.add(pkg);
		}
		testPackage.set(path, blocked || packages.size === 0 ? "stays" : (assignTestPackage(packages) ?? "stays"));
	}

	return new Map([...helperPackage, ...testPackage]);
}

/**
 * The one package resolver (§7 "tests and their helpers"): the test folder's assignment
 * above, and every other file's own package.
 */
export function createPackageResolver(
	files: readonly string[],
	readSource: FileSource,
	importsOf: (path: string) => ImportRecord[] = createImportReader(readSource),
): (path: string) => Pkg {
	const inTests = "extensions/tests/";
	const testPackages = assignTestPackages(files, readSource, importsOf);
	const packageMemo = new Map<string, Pkg>();
	const pkgOf = (path: string): Pkg => {
		const memo = packageMemo.get(path);
		if (memo) return memo;
		const scannedPkg = packageOf(path).pkg;
		const own: Pkg = path.startsWith(inTests) ? (testPackages.get(path) ?? "stays") : scannedPkg === "stays" ? (PART5_PACKAGE.get(path) ?? "stays") : scannedPkg;
		packageMemo.set(path, own);
		return own;
	};
	return pkgOf;
}
