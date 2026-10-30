"use strict";

// Capability surface: walk a provider CLI's --help tree once, cache it, and
// render it for an LLM at the smallest token cost that stays actionable.
//
// Nothing here runs on the hot path. `refresh-surface` walks; `menu` only
// reads the cached JSON.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Help dialects differ (cobra, gh, vercel). These match the shared shape:
// a section header, then indented "name  description" entries.
// A header either ends in a colon (cobra, vercel) or is ALL CAPS at column 0
// (gh). Command lines are also letters-and-spaces, so the double-space guard
// below is what actually separates the two: headers are single-spaced words,
// entries always have a run of spaces between name and description.
const SECTION_COLON = /^\s{0,2}[A-Za-z][A-Za-z0-9 /|-]{0,40}:\s*$/;
const SECTION_CAPS = /^[A-Z][A-Z0-9 ]{2,40}$/;
const ENTRY_GAP = /\S\s{2,}\S/;
// POSITIONALS matters as much as ARGUMENTS: yargs CLIs (wrangler) print a
// `Positionals:` block whose entries look identical to command entries, so
// every positional (`name`, `path`, `key`) was parsed as a subcommand and
// turned one real command into a tree of fabricated ones.
const SKIP_SECTION = /\b(FLAGS|OPTIONS|USAGE|EXAMPLES|LEARN|INHERITED|ENVIRONMENT|ARGUMENTS|POSITIONALS|GLOBAL|ALIASES)\b/i;
// Handles the dialects in play: cobra (`create    desc`), gh (`co:  desc`),
// vercel (`ls | list  [app]  desc`) and commander (`list|ls [options]  desc`).
// The alias group is captured whole so the canonical (longest) name wins.
//
// The name/description separator must allow a SINGLE space: cobra pads each
// `--help` section independently to its longest command name plus one space, so
// exactly one command per section — the longest, and the only entry of any
// single-command section — is separated by one space and was silently dropped
// (e.g. `network-restrictions`, `db schema declarative`). Deep indentation is
// still rejected: entry lines start with 2-8 spaces, while wrapped description
// continuations are indented to the description column.
const ENTRY = /^\s{2,8}([a-z][a-z0-9-]*(?:\s*\|\s*[a-z][a-z0-9-]*)*)\s*:?(?:\s*(?:\[[^\]]*\]|<[^>]*>))*\s+(\S.*)$/;
const FLAG = /(?<![\w-])--([a-z][a-z0-9-]+)/g;
// A positional metavar (`<name>`, `[file]`, `NAME`) is an argument, never a
// subcommand. ENTRY already requires a lowercase name, so the bracket and
// all-caps forms are a second guard for dialects that list bare metavars.
const PLACEHOLDER = /^(?:<[^>]*>|\[[^\]]*\]|[A-Z][A-Z0-9_-]*|\.{2,}|\S*<[^>]*>)$/;
function isPlaceholder(name) {
	const value = String(name || "").trim();
	return value.length === 0 || PLACEHOLDER.test(value);
}

// CLIs that add a long-help context block (resend's commander `addHelpText`,
// cobra's long description) print prose after the command list, wrapped and
// indented exactly like command entries. Parsed naively, those lines become
// pseudo commands whose "description" is a sentence fragment from the block or
// another command's reprinted usage line:
//   Supported types:
//     string  — text values (default for most properties)
//   Usage:
//     resend  domains verify <domain-id>
// Each pattern below is a shape a real command description does not have, so a
// genuine short description is never dropped on its own.
const DESC_EM_DASH = /^[—–]/;
// `<metavar> …`, `[flags] …`, `{{{NAME|fallback}}} …`. The bracket form requires
// a lowercase token, so a real all-caps annotation prefix (`[ALPHA]`, `[BETA]`,
// `[EXPERIMENTAL]`, as sentry and tailscale print) still reads as a description.
const DESC_METAVAR = /^(?:<[^>]*>|\[[a-z0-9][^\]A-Z]*\]|\{\{)/;
// Another invocation: two or more lowercase command words followed directly by
// a metavar or flag (`domains verify <domain-id>`, `contacts topics <id>`).
// vercel's `id Remove a certificate by id` does not match: the word after the
// argument name is capitalised and no metavar follows it.
const DESC_USAGE = /^[a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*)+\s+(?:<[^>]*>|\[[^\]]*\]|--[a-z])/;
function isHelpTextFragment(desc) {
	const value = String(desc || "").trim();
	return value.length > 0
		&& (DESC_EM_DASH.test(value) || DESC_METAVAR.test(value) || DESC_USAGE.test(value));
}
// The CLI reprints its own usage lines prefixed with the binary name
// (`resend  domains verify <domain-id>`), which parses the binary itself as a
// child command. A binary is never a subcommand of itself.
function isBinaryNameBleed(name, binaryName) {
	return Boolean(binaryName) && name === binaryName;
}

const NOISE_FLAGS = new Set(["help", "version"]);
const NOISE_SUBS = new Set(["help", "completion", "version"]);

const QUIET_ENV = {
	NO_COLOR: "1",
	CI: "1",
	DO_NOT_TRACK: "1",
	VERCEL_TELEMETRY_DISABLED: "1",
	STRIPE_CLI_TELEMETRY_OPTOUT: "1",
	NEXT_TELEMETRY_DISABLED: "1",
	GH_NO_UPDATE_NOTIFIER: "1",
	npm_config_update_notifier: "false",
};

const MAX_DEPTH = 3;
const HELP_TIMEOUT_MS = 25_000;

function helpText(argv) {
	for (const form of [[...argv, "--help"], [...argv, "help"]]) {
		const result = spawnSync(form[0], form.slice(1), {
			encoding: "utf8",
			timeout: HELP_TIMEOUT_MS,
			maxBuffer: 2_000_000,
			env: { ...process.env, ...QUIET_ENV },
		});
		const text = `${result.stdout || ""}\n${result.stderr || ""}`;
		if (text.trim().length > 40) return text;
	}
	return "";
}

// Some CLIs (wrangler) list entries as "<binary> <subcommand>  description".
// Without stripping the repeated binary name every entry parses as the binary
// itself and the whole tree collapses to one leaf.
function parseHelp(text, pathPrefix, options = {}) {
	const binaryName = options.binaryName ? path.basename(String(options.binaryName)) : null;
	const subs = new Map();
	const flags = new Set();
	let inCommands = false;
	for (const line of text.split("\n")) {
		const isHeader = !ENTRY_GAP.test(line) && !line.trim().startsWith("-")
			&& (SECTION_COLON.test(line) || SECTION_CAPS.test(line));
		if (isHeader) {
			inCommands = !SKIP_SECTION.test(line);
			continue;
		}
		for (const match of line.matchAll(FLAG)) {
			if (!NOISE_FLAGS.has(match[1])) flags.add(match[1]);
		}
		if (!inCommands || line.trimStart().startsWith("-")) continue;
		// Entries may repeat the full command path ("wrangler r2 object  desc").
		// Strip the current path first so the ordinary matcher sees "object desc".
		const candidate = pathPrefix ? line.replace(pathPrefix, "  ") : line;
		const entry = ENTRY.exec(candidate);
		if (!entry) continue;
		const name = entry[1].split("|").map((part) => part.trim())
			.sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
		const desc = entry[2].trim().replace(/\s+/g, " ").slice(0, 120);
		if (name && !isPlaceholder(name) && !NOISE_SUBS.has(name) && !subs.has(name)
			&& !isHelpTextFragment(desc) && !isBinaryNameBleed(name, binaryName)) {
			subs.set(name, desc);
		}
	}
	return { subs, flags: [...flags].sort() };
}

// Resolve without spawning: `which` would cost a subprocess on every menu read.
function resolveCliPath(cli) {
	if (cli.includes("/")) return fs.existsSync(cli) ? cli : null;
	for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, cli);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch { /* keep looking */ }
	}
	return null;
}

function cliMtimeMs(cli) {
	const resolved = resolveCliPath(cli);
	if (!resolved) return null;
	try { return fs.statSync(resolved).mtimeMs; } catch { return null; }
}

// A surface is stale when the binary it was generated from has been replaced
// or is no longer resolvable. Costs one stat instead of a `--version`
// subprocess. A missing binary is reported as stale: the cached tree cannot be
// trusted against a CLI that is not there, and `false` used to hide exactly
// that case.
function staleness(surface) {
	if (!surface) return { stale: true, reason: "no_surface" };
	if (typeof surface.cliMtimeMs !== "number") return { stale: false, reason: "unversioned" };
	const current = cliMtimeMs(surface.cli);
	if (current === null) return { stale: true, reason: "cli_missing" };
	if (current !== surface.cliMtimeMs) return { stale: true, reason: "cli_replaced" };
	return { stale: false, reason: "current" };
}

function isStale(surface) {
	return staleness(surface).stale;
}

function cliVersion(cli, prefix = []) {
	const result = spawnSync(cli, [...prefix, "--version"], { encoding: "utf8", timeout: 20_000, maxBuffer: 200_000 });
	const text = `${result.stdout || ""}${result.stderr || ""}`;
	const match = /\d+\.\d+\.\d+/.exec(text);
	return match ? match[0] : null;
}

// e.g. for ["wrangler","r2"] the path prefix matches a leading
// "  wrangler r2 " on entry lines. Escapes every regex metacharacter in each
// path segment before joining them with a whitespace run.
function pathPrefixFor(argv) {
	const escaped = argv
		.map((part) => String(part).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("\\s+");
	return new RegExp(`^(\\s{2,8})${escaped}\\s+`);
}

// Two help outputs are the same menu when their text matches after whitespace
// is normalised. Used to detect help that reprints the parent's tree.
function normalizeHelpText(text) {
	return String(text || "").replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
}

// A leaf is a group when the walk stopped before expanding its subcommands: it
// must be offered as a menu pointer, never as a runnable flag recipe.
// `repeated_parent_help` is the one incomplete case that stays runnable: the
// parent menu named the command, and the CLI merely reprinted an ancestor menu
// in its help, so the command exists even though its own children were not
// discovered.
function isUnexpandedGroup(leaf) {
	return Boolean(leaf) && leaf.complete === false && leaf.incompleteReason !== "repeated_parent_help";
}

// Description of how complete a generated surface is. `maxDepth` and
// `helpNodes` are walk diagnostics; `truncatedLeaves` lists every node that
// still had subcommands when the walk stopped, so a group is never presented as
// an executable leaf without saying so. `unexpandedGroups` separates the nodes
// that need a menu drill-down from `repeatedParentLeaves`, which stay runnable.
function surfaceCoverage(leaves, options = {}) {
	const truncated = (leaves || []).filter((leaf) => leaf.complete === false);
	const groups = truncated.filter((leaf) => leaf.incompleteReason !== "repeated_parent_help");
	const repeated = truncated.filter((leaf) => leaf.incompleteReason === "repeated_parent_help");
	return {
		source: options.source || null,
		maxDepth: options.maxDepth === undefined ? null : options.maxDepth,
		helpNodes: options.helpNodes === undefined ? null : options.helpNodes,
		complete: truncated.length === 0,
		truncatedLeafCount: truncated.length,
		truncatedLeaves: truncated.map((leaf) => leaf.cmd),
		unexpandedGroups: groups.map((leaf) => leaf.cmd),
		repeatedParentLeaves: repeated.map((leaf) => leaf.cmd),
	};
}

// One shape for every consumer. A surface with no `coverage` block predates the
// metadata, so its completeness is unknown — never "complete". Surfaces written
// before the reason field is backfilled from their `complete: false` leaves.
function coverageStatus(surface) {
	if (!surface || !surface.coverage) {
		return { known: false, complete: null, truncatedLeafCount: null, truncatedLeaves: [], unexpandedGroups: [], repeatedParentLeaves: [] };
	}
	const coverage = surface.coverage;
	const leaves = Array.isArray(surface.leaves) ? surface.leaves : [];
	const groups = Array.isArray(coverage.unexpandedGroups)
		? coverage.unexpandedGroups
		: leaves.filter(isUnexpandedGroup).map((leaf) => leaf.cmd);
	const repeated = Array.isArray(coverage.repeatedParentLeaves)
		? coverage.repeatedParentLeaves
		: leaves.filter((leaf) => leaf.complete === false && leaf.incompleteReason === "repeated_parent_help").map((leaf) => leaf.cmd);
	return {
		known: true,
		complete: coverage.complete === true,
		truncatedLeafCount: typeof coverage.truncatedLeafCount === "number" ? coverage.truncatedLeafCount : groups.length + repeated.length,
		truncatedLeaves: Array.isArray(coverage.truncatedLeaves) ? coverage.truncatedLeaves : [...groups, ...repeated],
		unexpandedGroups: groups,
		repeatedParentLeaves: repeated,
	};
}

// Walks the whole tree. Slow by design (one subprocess per node); callers
// cache. `options.helpProvider` injects a help source for tests and for callers
// that already hold the help text, keeping the regression suite subprocess-free.
function walkCli(cli, options = {}) {
	const maxDepth = Number.isFinite(Number(options.maxDepth)) ? Number(options.maxDepth) : MAX_DEPTH;
	const prefix = Array.isArray(options.prefix) ? options.prefix : [];
	const provideHelp = typeof options.helpProvider === "function" ? options.helpProvider : helpText;
	const leaves = [];
	const seen = new Set();
	const parsedByText = new Map();
	let helpNodes = 0;
	const record = (argv, fields) => {
		const leaf = {
			cmd: argv.slice(1 + prefix.length).join(" "),
			flags: [...new Set(fields.flags || [])].sort(),
			desc: fields.desc || null,
		};
		if (fields.complete === false) {
			leaf.complete = false;
			leaf.truncatedSubcommands = Array.isArray(fields.truncatedSubcommands) ? fields.truncatedSubcommands : [];
			if (fields.incompleteReason) leaf.incompleteReason = fields.incompleteReason;
		}
		leaves.push(leaf);
	};
	const walk = (argv, depth, desc, parentText, ancestorSignatures) => {
		const key = argv.join(" ");
		if (seen.has(key)) return;
		seen.add(key);
		const pathPrefix = pathPrefixFor(argv);
		const text = provideHelp(argv);
		helpNodes += 1;
		const normalized = normalizeHelpText(text);
		const cacheKey = `${normalized}\u0000${pathPrefix.source}`;
		let parsed = parsedByText.get(cacheKey);
		if (!parsed) {
			parsed = parseHelp(text, pathPrefix, { binaryName: cli });
			parsedByText.set(cacheKey, parsed);
		}
		const { subs, flags } = parsed;
		const signature = [...subs.keys()].sort().join("|");
		// A node whose help repeats its parent's text, or its parent's exact
		// command list, is not a real subcommand tree: the CLI is reprinting the
		// group menu (stitch prints its usage for every command; `vercel git
		// connect` prints the `git` menu). Recursing there fabricates a cross
		// product of names instead of discovering commands.
		const repeatsParent = depth > 0 && (normalized === parentText
			|| (signature !== "" && ancestorSignatures.has(signature)));
		if (subs.size === 0) {
			record(argv, { flags, desc, complete: true });
			return;
		}
		if (repeatsParent) {
			// The help lists these names, but they belong to an ancestor menu the
			// CLI reprinted. The command itself is real — its parent menu named it —
			// so it stays runnable, while the walk records that its own children
			// were never discovered rather than claiming a complete subtree.
			record(argv, {
				flags,
				desc,
				complete: false,
				incompleteReason: "repeated_parent_help",
				truncatedSubcommands: [...subs.keys()].sort(),
			});
			return;
		}
		if (depth >= maxDepth) {
			// The depth cap hides real subcommands. Keep the node but mark it
			// incomplete and name what was not walked.
			record(argv, {
				flags,
				desc,
				complete: false,
				incompleteReason: "max_depth",
				truncatedSubcommands: [...subs.keys()].sort(),
			});
			return;
		}
		const nextAncestors = new Set(ancestorSignatures);
		nextAncestors.add(signature);
		for (const [name, childDesc] of subs) walk([...argv, name], depth + 1, childDesc, normalized, nextAncestors);
	};
	walk([cli, ...prefix], 0, null, null, new Set());
	leaves.sort((a, b) => a.cmd.localeCompare(b.cmd));
	return {
		schemaVersion: 1,
		cli,
		cliVersion: cliVersion(cli, prefix),
		cliPath: resolveCliPath(cli),
		cliMtimeMs: cliMtimeMs(cli),
		generatedAt: new Date().toISOString(),
		leafCount: leaves.length,
		coverage: surfaceCoverage(leaves, { source: "help_walk", maxDepth, helpNodes }),
		leaves,
	};
}

// A flag carried by most commands is ambient, not a per-command choice.
// Hoisting it to one header line is where most of the token saving comes from.
function globalFlags(leaves) {
	if (leaves.length <= 3) return [];
	const counts = new Map();
	for (const leaf of leaves) {
		for (const flag of leaf.flags) counts.set(flag, (counts.get(flag) || 0) + 1);
	}
	const threshold = 0.7 * leaves.length;
	return [...counts.entries()].filter(([, count]) => count >= threshold).map(([flag]) => flag).sort();
}

function groupOf(leaf) {
	return leaf.cmd.split(" ")[0];
}

function groupCounts(surface) {
	const groups = new Map();
	for (const leaf of surface.leaves) {
		const group = groupOf(leaf);
		const current = groups.get(group) || { count: 0, desc: null };
		current.count += 1;
		if (!current.desc && leaf.desc && leaf.cmd === group) current.desc = leaf.desc;
		groups.set(group, current);
	}
	return groups;
}

// All of these execute. The labels tell the agent what to tell the user first.
const CLASS_SECTIONS = [
	["read", "safe to run"],
	["mutate", "changes state — say what you are about to do first"],
	["destructive", "deletes or resets — confirm with the user in chat first"],
	["sensitive", "touches credentials or session state — confirm, and never echo a value"],
];

// A depth-capped group has no runnable flag recipe; the only honest output is
// its name plus a working expansion pointer. `menu` takes a top-level group
// word (bin/pi-toolbelt matches `groupOf`), so the pointer names that group
// rather than a path the menu cannot address.
function groupPointer(provider, cmd) {
	const group = String(cmd || "").trim().split(/\s+/)[0];
	return `pi-toolbelt menu ${provider} ${JSON.stringify(group)}`;
}

// Coverage lines shared by menu/search/group rendering. A surface without
// coverage metadata is announced as unknown rather than silently rendered as if
// it were complete.
function coverageNotes(surface, coverage) {
	const provider = surface && surface.cli ? surface.cli : "<provider>";
	if (!coverage.known) {
		return [`# coverage: unknown — this surface predates coverage metadata; regenerate with: pi-toolbelt refresh-surface ${provider}`];
	}
	if (coverage.complete) return [];
	const notes = [];
	if (coverage.unexpandedGroups.length > 0) {
		notes.push(`# coverage: incomplete — ${coverage.unexpandedGroups.length} group(s) were not expanded; open one with: pi-toolbelt menu ${provider} "<group>" (or regenerate: pi-toolbelt refresh-surface ${provider})`);
	}
	if (coverage.repeatedParentLeaves.length > 0) {
		notes.push(`# coverage: partial — ${coverage.repeatedParentLeaves.length} command(s) reprinted an ancestor menu; their own subcommands are unverified`);
	}
	return notes;
}

function renderMenu(surface, options = {}) {
	const group = options.group ? String(options.group).trim() : null;
	const classify = typeof options.classify === "function" ? options.classify : null;
	const hoisted = globalFlags(surface.leaves);
	const hoistedSet = new Set(hoisted);
	const leaves = group ? surface.leaves.filter((leaf) => groupOf(leaf) === group) : surface.leaves;
	if (group && leaves.length === 0) return null;
	const provider = options.provider || surface.cli;
	const groups = leaves.filter(isUnexpandedGroup);
	const runnable = leaves.filter((leaf) => !isUnexpandedGroup(leaf));
	const lines = [`# ${surface.cli}${surface.cliVersion ? ` ${surface.cliVersion}` : ""} — ${leaves.length} commands${group ? ` in "${group}"` : ""}`];
	lines.push(`# run: pi-toolbelt run ${provider} -- <command> [flags]`);
	if (hoisted.length > 0) lines.push(`# global flags: ${hoisted.map((flag) => `--${flag}`).join(" ")}`);
	lines.push(...coverageNotes(surface, coverageStatus(surface)));
	const line = (leaf) => {
		const local = leaf.flags.filter((flag) => !hoistedSet.has(flag));
		return local.length > 0 ? `${leaf.cmd}  ${local.map((flag) => `--${flag}`).join(" ")}` : leaf.cmd;
	};
	// An unexpanded group is help-only: printing its flags would offer a runnable
	// recipe for a command whose own subcommands were never seen.
	const groupLines = groups.flatMap((leaf) => [
		leaf.cmd,
		"  group — help only; its subcommands were not expanded",
		`  open with: ${groupPointer(provider, leaf.cmd)}`,
	]);
	if (!classify) {
		lines.push("");
		for (const leaf of runnable) lines.push(line(leaf));
		if (groups.length > 0) lines.push("", "## groups — expand before running", ...groupLines);
		return lines.join("\n");
	}
	const buckets = new Map(CLASS_SECTIONS.map(([name]) => [name, []]));
	for (const leaf of runnable) {
		const verdict = classify(leaf.cmd.split(" "), leaf);
		(buckets.get(verdict) || buckets.get("mutate")).push(leaf);
	}
	for (const [name, gate] of CLASS_SECTIONS) {
		const bucket = buckets.get(name);
		if (!bucket || bucket.length === 0) continue;
		lines.push("", `## ${name} — ${gate}`);
		for (const leaf of bucket) lines.push(line(leaf));
	}
	if (groups.length > 0) lines.push("", "## groups — not fully discovered; help only", ...groupLines);
	return lines.join("\n");
}

// Intent-first lookup across every generated surface. This is the router
// entry point: an agent has a goal ("deploy logs"), not a provider name.
//
// A term is judged by its word root: a term long enough to be a root and
// written as a plain plural is reduced to its singular, so "logs" is tested as
// "log". A root matches a command word only by equality with the root or its
// plain plural; a root long enough to stand on its own may still prefix-match,
// so "deploy" keeps finding "deployments". An under-length root prefix does not
// fall through to the description either: the command name decides the term,
// which is what keeps `login` (description "Logs into your account") out of a
// `logs` search. Descriptions still match words that do not name a command, so
// `github` still finds `login`.
const WORD_ROOT_MIN = 4;
function pluralOf(term, word) {
	return word === `${term}s` || word === `${term}es`;
}

function rootOf(term) {
	return term.length >= WORD_ROOT_MIN && term.endsWith("s") ? term.slice(0, -1) : term;
}

function searchSurfaces(surfaces, query, options = {}) {
	const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return [];
	const hits = [];
	for (const { provider, surface } of surfaces) {
		if (!surface) continue;
		// Kept in the hit shape for callers that still ask which flags are
		// ambient; renderSearch no longer subtracts them from its output.
		const hoistedSet = new Set(globalFlags(surface.leaves));
		for (const leaf of surface.leaves) {
			const cmd = leaf.cmd.toLowerCase();
			const words = [...new Set(cmd.split(/[\s-]+/).filter(Boolean))];
			const descWords = new Set(String(leaf.desc || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
			let score = 0;
			for (const term of terms) {
				const root = rootOf(term);
				if (words.includes(term)) {
					score += 10;
					continue;
				}
				// A term whose root prefixes this command's own word is decided by the
				// command name alone. `login`'s description says "Logs into your
				// account", and that human-language "logs" used to surface login for
				// the `logs` query: the plural never prefix-matched a command word, so
				// the term fell through to the description. Judging the root ("logs"
				// as "log") makes the command-name rule fire and blocks the fall-through.
				if (words.some((word) => word.startsWith(root))) {
					if (root.length >= WORD_ROOT_MIN || words.some((word) => word === root || pluralOf(root, word))) score += 6;
					continue;
				}
				if (descWords.has(term)) score += 4;
			}
			if (score === 0) continue;
			// Prefer shallow commands: `vercel logs` over `vercel alerts rules ls`.
			score -= leaf.cmd.split(" ").length;
			// The surface's discovery coverage travels with the hit so a search
			// result can state how complete its menu actually is.
			hits.push({ provider, leaf, score, hoistedSet, coverage: surface.coverage || null });
		}
	}
	hits.sort((a, b) => b.score - a.score || a.provider.localeCompare(b.provider) || a.leaf.cmd.localeCompare(b.leaf.cmd));
	return hits.slice(0, Number(options.limit) || 15);
}

function renderSearch(hits, query, classify) {
	if (hits.length === 0) return `# no command matches "${query}"\n# try: pi-toolbelt providers`;
	const lines = [`# ${hits.length} commands matching "${query}"`, "# run: pi-toolbelt run <provider> -- <command> [flags]"];
	// Discovery metadata travels with the hit, so a search result never implies
	// more coverage than the surface actually has.
	const unknown = [...new Set(hits.filter((hit) => !hit.coverage).map((hit) => hit.provider))].sort();
	const partial = [...new Set(hits.filter((hit) => hit.coverage && hit.coverage.complete === false).map((hit) => hit.provider))].sort();
	if (unknown.length > 0) lines.push(`# coverage: unknown for ${unknown.join(", ")} — regenerate with: pi-toolbelt refresh-surface <provider>`);
	if (partial.length > 0) lines.push(`# coverage: incomplete for ${partial.join(", ")} — expand a group with: pi-toolbelt menu <provider> "<group>"`);
	lines.push("");
	for (const { provider, leaf } of hits) {
		if (isUnexpandedGroup(leaf)) {
			// A group is help-only: its flag list is not a runnable recipe.
			lines.push(`${provider}  ${leaf.cmd}  [group — open with: ${groupPointer(provider, leaf.cmd)}]`);
			continue;
		}
		// Search output has no per-surface header to carry hoisted flags, so it
		// prints every flag the leaf accepts. Subtracting the ambient set here
		// silently removed the flags a caller most often needs.
		const flags = Array.isArray(leaf.flags) ? leaf.flags : [];
		const cls = classify ? classify(provider, leaf.cmd.split(" "), leaf) : null;
		lines.push(`${provider}  ${leaf.cmd}${cls && cls !== "read" ? `  [${cls}]` : ""}${flags.length > 0 ? `  ${flags.map((flag) => `--${flag}`).join(" ")}` : ""}${leaf.desc ? `\n    ${leaf.desc}` : ""}`);
	}
	return lines.join("\n");
}

function renderGroupIndex(surface) {
	const groups = groupCounts(surface);
	const partial = new Set((surface.leaves || []).filter(isUnexpandedGroup).map((leaf) => groupOf(leaf)));
	const lines = [`# ${surface.cli}${surface.cliVersion ? ` ${surface.cliVersion}` : ""} — ${surface.leafCount} commands in ${groups.size} groups`];
	lines.push(`# drill down: pi-toolbelt menu ${surface.cli} <group>`);
	lines.push(...coverageNotes(surface, coverageStatus(surface)));
	lines.push("");
	for (const [group, info] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		lines.push(`${group} (${info.count})${info.desc ? ` — ${info.desc}` : ""}${partial.has(group) ? " — partially expanded" : ""}`);
	}
	return lines.join("\n");
}

function estimateTokens(text) {
	return Math.ceil(String(text || "").length / 4);
}

function surfacePath(dataDir, provider) {
	return path.join(dataDir, "surface", `${provider}.json`);
}

function readSurface(dataDir, provider) {
	try {
		return JSON.parse(fs.readFileSync(surfacePath(dataDir, provider), "utf8"));
	} catch {
		return null;
	}
}

function writeSurface(dataDir, provider, surface) {
	const file = surfacePath(dataDir, provider);
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, `${JSON.stringify(surface, null, 1)}\n`, { mode: 0o600 });
	return file;
}

// Command lookup for run-time validation and failure hints. Leading global
// flags are skipped the same way `lib/policy.js#commandWords` skips them, so
// `--token X deploy` still resolves to the `deploy` leaf.
function commandStart(argv) {
	let index = 0;
	while (index < argv.length) {
		const arg = String(argv[index]);
		if (arg === "--") return index + 1;
		if (!arg.startsWith("-")) return index;
		const next = argv[index + 1];
		const afterNext = argv[index + 2];
		const nextIsFlag = next === undefined || String(next).startsWith("-");
		const afterIsFlag = afterNext === undefined || String(afterNext).startsWith("-");
		if (!arg.includes("=") && !nextIsFlag && !afterIsFlag) index += 2;
		else index += 1;
	}
	return index;
}

function findLeaf(surface, argv) {
	if (!surface) return null;
	const args = [...argv].map(String);
	const words = [];
	for (let index = commandStart(args); index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--" || arg.startsWith("-")) break;
		words.push(arg);
	}
	let best = null;
	for (const leaf of surface.leaves) {
		const parts = leaf.cmd.split(" ");
		if (parts.every((part, index) => words[index] === part)) {
			if (!best || parts.length > best.cmd.split(" ").length) best = leaf;
		}
	}
	return best;
}

function cliInstalled(cli, prefix = []) {
	if (cli.includes("/")) {
		try { fs.accessSync(cli, fs.constants.X_OK); } catch { return false; }
		if (prefix.length === 0) return true;
	}
	const result = spawnSync(cli, [...prefix, "--version"], { encoding: "utf8", timeout: 20_000, maxBuffer: 200_000 });
	return result.error === undefined && result.status === 0;
}

// Ranking matches the router's gate order; a stronger class wins when two
// catalog entries collapse to the same command string.
const CLASS_RANK = { read: 0, mutate: 1, destructive: 2, sensitive: 3 };
// The catalog's legacy `blocked` bucket becomes the `sensitive` advisory. No
// operation is refused by classification, and CLASSES keeps its four
// executable classes.
const LEGACY_CLASS_ALIASES = { blocked: "sensitive" };

// Builds a cached surface from catalog-declared operations for a generated CLI
// that exposes no help tree (`<operation> --args <json>`). Callers own the
// command strings, so the documented invocation format is preserved verbatim;
// translation from hyphenated catalog ids (runware `image-generate`) to the
// real dispatch (`image generate`) happens before this function is reached.
function derivedSurface(cli, entries, options = {}) {
	const base = options.base && typeof options.base === "object" ? options.base : {};
	const byCmd = new Map();
	for (const entry of entries || []) {
		const source = typeof entry === "string" ? { cmd: entry } : (entry || {});
		const cmd = String(source.cmd || source.operation || "").trim();
		if (!cmd) continue;
		const declared = LEGACY_CLASS_ALIASES[source.class] || source.class || "mutate";
		const leaf = {
			cmd,
			flags: [...new Set(Array.isArray(source.flags) && source.flags.length > 0 ? source.flags : ["args"])].sort(),
			class: declared,
			desc: source.desc || null,
		};
		const existing = byCmd.get(cmd);
		if (!existing || (CLASS_RANK[leaf.class] || 0) > (CLASS_RANK[existing.class] || 0)) byCmd.set(cmd, leaf);
	}
	const leaves = [...byCmd.values()].sort((a, b) => a.cmd.localeCompare(b.cmd));
	if (leaves.length === 0) return null;
	return {
		schemaVersion: 1,
		cli,
		cliVersion: base.cliVersion === undefined ? null : base.cliVersion,
		cliPath: base.cliPath === undefined ? resolveCliPath(cli) : base.cliPath,
		cliMtimeMs: base.cliMtimeMs === undefined ? cliMtimeMs(cli) : base.cliMtimeMs,
		generatedAt: base.generatedAt || new Date().toISOString(),
		source: options.source || "provider_catalog",
		note: options.note || "Operations take a single --args JSON object.",
		leafCount: leaves.length,
		coverage: surfaceCoverage(leaves, { source: options.source || "provider_catalog" }),
		leaves,
	};
}

module.exports = {
	QUIET_ENV,
	walkCli,
	isStale,
	staleness,
	cliMtimeMs,
	resolveCliPath,
	cliInstalled,
	renderMenu,
	searchSurfaces,
	renderSearch,
	renderGroupIndex,
	groupCounts,
	globalFlags,
	estimateTokens,
	readSurface,
	writeSurface,
	surfacePath,
	findLeaf,
	cliVersion,
	parseHelpText: parseHelp,
	surfaceCoverage,
	coverageStatus,
	isUnexpandedGroup,
	derivedSurface,
};
