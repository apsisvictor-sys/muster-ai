"use strict";

// Classifies a provider CLI command into an execution class.
//
// The important inversion versus the old adapters: a command nobody has
// classified is `mutate` — gated behind approval but EXECUTABLE — instead of
// refused. Safety comes from the gate, not from the command being missing.

const fs = require("node:fs");
const path = require("node:path");

const CLASSES = ["read", "mutate", "destructive", "sensitive"];

// The catalog's legacy `blocked` bucket maps onto the `sensitive` advisory so
// no refusal-only class re-enters the router.
const DECLARED_CLASS_ALIASES = { blocked: "sensitive" };
function declaredClass(value) {
	if (CLASSES.includes(value)) return value;
	return DECLARED_CLASS_ALIASES[value] || null;
}

// Verb-shaped defaults that hold across every CLI we wrap. Per-provider files
// only need to carry the exceptions.
const DEFAULT_RULES = {
	read: [
		"(^|\\s)(list|get|ls|show|view|inspect|describe|info|status|search|diff|lint|check|whoami|balance|history|logs|log|tail|ping|netcheck|advisors|about|freebusy|coverage|metrics|usage|activity|report)(\\s|$)",
	],
	destructive: [
		"(^|\\s)(delete|rm|remove|destroy|reset|drop|purge|prune|revoke|terminate|uninstall)(\\s|$)",
		"(^|\\s)(restore|rollback|cancel)(\\s|$)",
	],
	blocked: [
		"(^|\\s)(login|logout|auth)(\\s|$)",
	],
	// Reads that hand back a live credential. Executing them would put a secret
	// in Toolbelt output, which is the one thing this tool must never do.
	secretReturning: [],
};

function compile(patterns) {
	return (patterns || []).map((pattern) => new RegExp(pattern, "i"));
}

function policyPath(dataDir, provider) {
	return path.join(dataDir, "policy", `${provider}.json`);
}

function readPolicy(dataDir, provider) {
	let overrides = {};
	try {
		overrides = JSON.parse(fs.readFileSync(policyPath(dataDir, provider), "utf8"));
	} catch {
		overrides = {};
	}
	const merge = (key) => [...(DEFAULT_RULES[key] || []), ...(overrides[key] || [])];
	return {
		provider,
		dryRunFlag: overrides.dryRunFlag || null,
		read: compile(merge("read")),
		destructive: compile(merge("destructive")),
		blocked: compile(merge("blocked")),
		secretReturning: compile(merge("secretReturning")),
		// A per-provider file can force an exact command into a class, which
		// wins over every pattern above.
		exact: overrides.exact && typeof overrides.exact === "object" ? overrides.exact : {},
		httpMethodCommands: Array.isArray(overrides.httpMethodCommands) ? overrides.httpMethodCommands : [],
		// command-prefix -> output sanitizer, for reads whose payload carries
		// values we must not surface (e.g. env var listings).
		sanitize: overrides.sanitize && typeof overrides.sanitize === "object" ? overrides.sanitize : {},
		classified: overrides,
	};
}

// argv is the verbatim provider command, e.g. ["db","push","--linked"].
// Leading global flags (`gh --repo owner/repo api`) used to stop collection
// immediately, leaving an empty command that the router treated as a no-op.
// Skip leading flags and a following value token when another command token
// clearly follows, then collect command words up to the next flag.
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

function commandWords(argv) {
	const words = [];
	for (let index = commandStart(argv); index < argv.length; index += 1) {
		const arg = String(argv[index]);
		if (arg === "--" || arg.startsWith("-")) break;
		words.push(arg);
	}
	return words;
}

// `gh api` / `vercel api` are read or write depending on the HTTP method, so
// classifying the command name alone would gate every plain GET.
// `gh` defaults to GET, but any request-body flag (`-f`, `-F`, `--field`,
// `--raw-field`, `--input`) makes the default POST; an explicit `-X/--method`
// always wins.
function httpMethod(argv) {
	let explicit = null;
	let implied = null;
	for (let i = 0; i < argv.length; i++) {
		const arg = String(argv[i]);
		const inline = /^(?:-X|--method)=(.+)$/.exec(arg) || /^-X(.+)$/.exec(arg);
		if (inline) {
			explicit = inline[1].toUpperCase();
			continue;
		}
		if (arg === "-X" || arg === "--method") {
			explicit = String(argv[i + 1] || "").toUpperCase();
			continue;
		}
		if (arg === "-f" || arg === "-F" || /^-f.+/.test(arg) || /^-F.+/.test(arg)
			|| /^--(?:raw-)?field(?:=|$)/.test(arg) || /^--input(?:=|$)/.test(arg)) {
			implied = "POST";
		}
	}
	return explicit || implied || "GET";
}

function classify(policy, argv, leaf = null) {
	const words = commandWords(argv);
	const command = words.join(" ").trim();
	// An empty command after flag stripping must fail closed to the gated class,
	// never `read`: leading global flags used to hide the verb entirely.
	if (!command) return { class: "mutate", reason: "no_command_words" };
	// Exact overrides still win, but an authoritative class on the surface leaf
	// (catalog-declared operations) beats every heuristic below it.
	for (const [exactCommand, forced] of Object.entries(policy.exact)) {
		if (command === exactCommand || command.startsWith(`${exactCommand} `)) {
			return { class: CLASSES.includes(forced) ? forced : "mutate", reason: "exact_override", matched: exactCommand };
		}
	}
	// A surface-declared class is authoritative for what the catalog curated as
	// safe, but must never weaken a positive destructive/blocked match: the
	// catalog only distinguishes safe/mutating, so `firewall-delete` arrives as
	// "mutate" and still deserves the second gate. The legacy `blocked` bucket
	// is mapped to `sensitive`; CLASSES itself stays refusal-free.
	const declared = leaf ? declaredClass(leaf.class) : null;
	// Verbs hide inside hyphenated names (`domains-list`, `vps-restart`), so
	// match against a separator-normalised form as well.
	const normalized = command.replace(/-/g, " ");
	const httpCommands = policy.httpMethodCommands || [];
	const httpIndex = httpCommands.length > 0 ? words.findIndex((word) => httpCommands.includes(word)) : -1;
	if (httpIndex !== -1) {
		const method = httpMethod(argv);
		if (["GET", "HEAD", "OPTIONS"].includes(method)) return { class: "read", reason: `http_${method.toLowerCase()}` };
		if (["DELETE"].includes(method)) return { class: "destructive", reason: "http_delete" };
		return { class: "mutate", reason: `http_${method.toLowerCase()}` };
	}
	const rank = { read: 0, mutate: 1, destructive: 2, sensitive: 3 };
	const withDeclared = (verdict) => {
		if (!declared) return verdict;
		return rank[declared] > rank[verdict.class]
			? { class: declared, reason: "surface_declared" }
			: verdict;
	};
	// These used to refuse. They now run — the label survives so the agent knows
	// to say what it is about to do before doing it.
	if (policy.secretReturning.some((re) => re.test(command) || re.test(normalized))) {
		return { class: "sensitive", reason: "secret_returning", message: "This command returns a live credential. Do not echo the value into chat or a file the user has not asked for." };
	}
	if (policy.blocked.some((re) => re.test(command) || re.test(normalized))) {
		return { class: "sensitive", reason: "credential_or_session", message: "This changes credentials or session state for the whole machine, not just this call." };
	}
	if (policy.destructive.some((re) => re.test(command) || re.test(normalized))) {
		return { class: "destructive", reason: "destructive_pattern" };
	}
	if (policy.read.some((re) => re.test(command) || re.test(normalized))) {
		return withDeclared({ class: "read", reason: "read_pattern" });
	}
	// Unmatched: the catalog's own classification beats "we do not know".
	if (declared) return { class: declared, reason: "surface_declared" };
	return { class: "mutate", reason: "default_unclassified" };
}

// Which leaves in a surface fall through to the default. Surfaced by
// catalog-check so new CLI commands get reviewed instead of silently
// inheriting `mutate`.
function unclassified(policy, surface) {
	if (!surface) return [];
	return surface.leaves
		.map((leaf) => ({ leaf, verdict: classify(policy, leaf.cmd.split(" "), leaf) }))
		.filter(({ verdict }) => verdict.reason === "default_unclassified")
		.map(({ leaf }) => leaf.cmd);
}

function sanitizerFor(policy, argv) {
	const command = commandWords(argv).join(" ");
	for (const [prefix, name] of Object.entries(policy.sanitize || {})) {
		if (command === prefix || command.startsWith(`${prefix} `)) return name;
	}
	return null;
}

// Keeps the shape and the keys, drops every value.
function namesOnly(value) {
	if (Array.isArray(value)) {
		return value.map((item) => (item && typeof item === "object"
			? Object.fromEntries(Object.entries(item).map(([k, v]) => [k, /^(name|key|id|scope|environment|service|target)$/i.test(k) ? v : "[REDACTED]"]))
			: "[REDACTED]"));
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.keys(value).map((key) => [key, "[REDACTED]"]));
	}
	return "[REDACTED]";
}

const SANITIZERS = { namesOnly };

function applySanitizer(name, value) {
	const fn = SANITIZERS[name];
	return fn ? fn(value) : value;
}

module.exports = { readPolicy, classify, commandWords, httpMethod, unclassified, policyPath, sanitizerFor, applySanitizer, CLASSES, DEFAULT_RULES };
