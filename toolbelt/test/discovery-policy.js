#!/usr/bin/env node
"use strict";

// Discovery and policy regression coverage. These tests exercise the shared
// parsers directly (no provider CLI is spawned) plus one real graphql/HTTP
// classification path, so the discovery defects cannot silently return.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const surfaceLib = require("../lib/surface.js");
const policyLib = require("../lib/policy.js");

const DATA_DIR = path.join(__dirname, "..", "data");

// ---------------------------------------------------------------- parsing ---

const stitchHelp = [
	"stitch - universal Google Stitch CLI for the operator/Pi",
	"",
	"Commands:",
	"  status                         Check SDK/auth readiness without printing secrets",
	"  init                           Create project-local .stitch/ folders and config",
	"  list-tools                     List Stitch MCP tool names",
	"  list-projects                  List accessible Stitch projects",
	"  generate                       Generate one screen from a prompt file/string and save HTML + PNG",
	"  batch                          Sequentially generate boards from a .stitch manifest",
	"",
	"Examples:",
	"  stitch generate --prompt-file .stitch/prompts/x.md --design-file DESIGN.md",
].join("\n");

{
	const parsed = surfaceLib.parseHelpText(stitchHelp);
	assert.deepEqual([...parsed.subs.keys()].sort(), ["batch", "generate", "init", "list-projects", "list-tools", "status"]);
	assert.ok(parsed.flags.includes("prompt-file") && parsed.flags.includes("design-file"));
}

// yargs prints a Positionals block whose entries look like commands.
{
	const yargsHelp = [
		"wrangler d1 create <name>",
		"",
		"Positionals:",
		"  name  The name of the new D1 database  [string] [required]",
		"",
		"Flags:",
		"  --json  Output as JSON",
	].join("\n");
	const parsed = surfaceLib.parseHelpText(yargsHelp);
	assert.deepEqual([...parsed.subs.keys()], [], "a positional must never become a subcommand");
	assert.ok(parsed.flags.includes("json"));
}

// Metavars and all-caps placeholders are arguments, never commands.
{
	const placeholderHelp = [
		"COMMANDS:",
		"  <name>   the name",
		"  [file]   the file",
		"  FILE     a path",
		"  real     a real command",
	].join("\n");
	const parsed = surfaceLib.parseHelpText(placeholderHelp);
	assert.deepEqual([...parsed.subs.keys()], ["real"]);
}

// A CLI that adds a long-help context block after its command list (resend's
// commander `addHelpText`) wraps prose at the entry indent. Those continuation
// lines and the CLI's reprinted usage lines used to become pseudo commands:
// `string`/`number` (em-dash fragments), `via` (template placeholder) and the
// binary name itself (`resend  domains verify <domain-id>`).
{
	const resendHelp = [
		"Usage: resend contact-properties [options] [command]",
		"",
		"Commands:",
		"  create              Create a new contact property definition",
		"  string  — text values (default for most properties)",
		"  via  {{{PROPERTY_NAME|fallback}}} triple-brace interpolation.",
		"  resend  domains verify <domain-id>",
		"  run  [flags]",
	].join("\n");
	const parsed = surfaceLib.parseHelpText(resendHelp, null, { binaryName: "resend" });
	assert.deepEqual([...parsed.subs.keys()].sort(), ["create"],
		"usage lines, em-dash fragments, templates, metavar fragments and the binary name are not commands");
}

// The filter is not a blanket drop. A real lowercase description (audible), an
// annotation-prefixed description (sentry/tailscale), vercel's "argument name +
// capitalised verb" shape and a description that carries a metavar all stay.
{
	const help = [
		"Commands:",
		"  download   download audiobook(s) from library",
		"  status     [EXPERIMENTAL] Check the status",
		"  remove     id Remove a certificate by id",
		"  add        name [environment] Add an Environment Variable",
	].join("\n");
	const parsed = surfaceLib.parseHelpText(help);
	assert.deepEqual([...parsed.subs.keys()].sort(), ["add", "download", "remove", "status"]);
}

// The walker passes the binary name through, so a reprinted usage line inside a
// child's help is rejected where the other guards live rather than becoming a
// child named after the CLI.
{
	const menus = {
		mycli: "Usage: mycli [command]\n\nCommands:\n  claim  Manage a domain claim\n",
		"mycli claim": [
			"Usage: mycli claim [command]",
			"",
			"Commands:",
			"  create  Start a claim",
			"  mycli  domains verify <domain-id>",
		].join("\n"),
		"mycli claim create": "Usage: mycli claim create\n\nFlags:\n  --json  Output as JSON\n",
	};
	const surface = surfaceLib.walkCli("mycli", {
		helpProvider: (argv) => menus[argv.join(" ")] || "",
		maxDepth: 3,
	});
	assert.deepEqual(surface.leaves.map((leaf) => leaf.cmd), ["claim create"]);
	assert.equal(surface.leaves.some((leaf) => leaf.cmd.split(" ").includes("mycli")), false,
		"the binary name is never a subcommand of itself");
}

// A repeated binary path prefix is stripped before the entry matcher, so a
// generated CLI's "wrangler d1 list" line becomes "list"; a Positionals block
// still contributes no commands.
{
	const help = [
		"wrangler d1 execute <database>",
		"",
		"Commands:",
		"  wrangler d1 list   List databases",
		"  wrangler d1 info   Show database info",
		"Positionals:",
		"  database  The database name  [string] [required]",
	].join("\n");
	const parsed = surfaceLib.parseHelpText(help, /^(\s{2,8})wrangler\s+d1\s+/);
	assert.deepEqual([...parsed.subs.keys()].sort(), ["info", "list"]);
}

// ------------------------------------------------------- walk cycle guard ---

const stitchMenus = {
	"stitch": stitchHelp,
	"stitch status": stitchHelp,
	"stitch init": stitchHelp,
	"stitch list-tools": stitchHelp,
	"stitch list-projects": stitchHelp,
	"stitch generate": stitchHelp,
	"stitch batch": stitchHelp,
};

{
	const surface = surfaceLib.walkCli("stitch", {
		helpProvider: (argv) => stitchMenus[argv.join(" ")] || "",
		maxDepth: 3,
	});
	assert.equal(surface.leafCount, 6, "reprinted usage must not fabricate 6^3 combinations");
	assert.deepEqual(surface.leaves.map((leaf) => leaf.cmd),
		["batch", "generate", "init", "list-projects", "list-tools", "status"]);
	// Every child reprints the root menu, so each name listed under a child
	// belongs to the root. The commands are real leaves, but the walk never saw
	// their own subcommands: coverage is partial, not complete.
	assert.equal(surface.coverage.complete, false, "reprinted help is incomplete coverage");
	assert.equal(surface.coverage.source, "help_walk");
	assert.deepEqual(surface.coverage.repeatedParentLeaves,
		["batch", "generate", "init", "list-projects", "list-tools", "status"]);
	assert.deepEqual(surface.coverage.unexpandedGroups, []);
	assert.ok(surface.leaves.every((leaf) => leaf.complete === false && leaf.incompleteReason === "repeated_parent_help"));
}

// A child whose command list repeats the parent's list stays a runnable leaf,
// even when the usage line differs (vercel git connect reprinted the git menu),
// but its coverage is partial rather than complete.
const vercelRootHelp = [
	"Commands:",
	"  git  Manage Git integration for the current Project",
].join("\n");
const gitHelp = [
	"Usage: vercel git <command>",
	"",
	"Commands:",
	"  connect     Connect your Vercel Project to your Git repository",
	"  disconnect  Disconnect the Git repository from your Vercel",
].join("\n");
const gitConnectHelp = gitHelp.replace("vercel git <command>", "vercel git connect");

{
	const surface = surfaceLib.walkCli("vercel", {
		helpProvider: (argv) => {
			const key = argv.join(" ");
			if (key === "vercel") return vercelRootHelp;
			if (key === "vercel git") return gitHelp;
			if (key === "vercel git connect" || key === "vercel git disconnect") return gitConnectHelp;
			return "";
		},
		maxDepth: 3,
	});
	assert.deepEqual(surface.leaves.map((leaf) => leaf.cmd), ["git connect", "git disconnect"]);
	assert.equal(surface.leaves.some((leaf) => leaf.cmd === "git connect connect"), false);
	// `vercel git connect` reprints the `git` menu with a different usage line.
	// The command itself is real and must stay runnable, but its own subcommands
	// were never discovered, so the discarded names are recorded and coverage
	// stays incomplete instead of claiming complete:true.
	for (const leaf of surface.leaves) {
		assert.equal(leaf.complete, false);
		assert.equal(leaf.incompleteReason, "repeated_parent_help");
		assert.deepEqual(leaf.truncatedSubcommands, ["connect", "disconnect"]);
	}
	assert.equal(surface.coverage.complete, false);
	assert.deepEqual(surface.coverage.repeatedParentLeaves, ["git connect", "git disconnect"]);
	assert.deepEqual(surface.coverage.unexpandedGroups, []);
	const gitMenu = surfaceLib.renderMenu(surface, { group: "git" });
	assert.match(gitMenu, /git connect/);
	assert.doesNotMatch(gitMenu, /\[group/,
		"a command whose own help reprinted an ancestor menu is still runnable");
}

// The depth cap must report an unexpanded group as incomplete, not as a leaf
// that looks executable.
{
	const deepMenus = {
		cli: "Commands:\n  group  A subgroup\n",
		"cli group": "Commands:\n  sub  A real subcommand\n",
		"cli group sub": "Leaf: no subcommands\n",
	};
	const surface = surfaceLib.walkCli("cli", {
		helpProvider: (argv) => deepMenus[argv.join(" ")] || "",
		maxDepth: 1,
	});
	assert.equal(surface.leafCount, 1);
	const [leaf] = surface.leaves;
	assert.equal(leaf.cmd, "group");
	assert.equal(leaf.complete, false);
	assert.equal(leaf.incompleteReason, "max_depth");
	assert.deepEqual(leaf.truncatedSubcommands, ["sub"]);
	assert.equal(surface.coverage.complete, false);
	assert.equal(surface.coverage.truncatedLeafCount, 1);
	assert.deepEqual(surface.coverage.truncatedLeaves, ["group"]);
	assert.deepEqual(surface.coverage.unexpandedGroups, ["group"]);
	assert.deepEqual(surface.coverage.repeatedParentLeaves, []);
}

// Paths deeper than the cap are not fabricated; only the depth-capped node is
// recorded, with the names the walk declined to descend into.
{
	const deepMenus = {
		cli: "Commands:\n  a  Level A\n",
		"cli a": "Commands:\n  b  Level B\n",
		"cli a b": "Commands:\n  c  Level C\n",
		"cli a b c": "Commands:\n  d  Level D\n",
		"cli a b c d": "Leaf: done\n",
	};
	const surface = surfaceLib.walkCli("cli", {
		helpProvider: (argv) => deepMenus[argv.join(" ")] || "",
		maxDepth: 3,
	});
	assert.deepEqual(surface.leaves.map((leaf) => leaf.cmd), ["a b c"], "a 4th level must not be fabricated");
	const [leaf] = surface.leaves;
	assert.equal(leaf.complete, false);
	assert.equal(leaf.incompleteReason, "max_depth");
	assert.deepEqual(leaf.truncatedSubcommands, ["d"]);
	assert.equal(surface.coverage.complete, false);
	assert.deepEqual(surface.coverage.unexpandedGroups, ["a b c"]);
	assert.equal(surface.coverage.helpNodes, 4, "the capped child is never walked");
}

// Repeated walks of the same input must be byte-identical.
{
	const options = { helpProvider: (argv) => stitchMenus[argv.join(" ")] || "", maxDepth: 3 };
	const first = surfaceLib.walkCli("stitch", { ...options, helpProvider: options.helpProvider });
	const second = surfaceLib.walkCli("stitch", { ...options, helpProvider: options.helpProvider });
	assert.deepEqual(first.leaves, second.leaves);
	assert.deepEqual(first.coverage, second.coverage);
}

// ------------------------------------------------------------- staleness ---

{
	const self = path.join(__dirname, "discovery-policy.js");
	const fresh = { cli: self, cliMtimeMs: fs.statSync(self).mtimeMs };
	assert.equal(surfaceLib.isStale(fresh), false);
	assert.deepEqual(surfaceLib.staleness(fresh), { stale: false, reason: "current" });
	assert.equal(surfaceLib.isStale({ cli: "/nonexistent/toolbelt-cli", cliMtimeMs: 1 }), true);
	assert.deepEqual(surfaceLib.staleness({ cli: "/nonexistent/toolbelt-cli", cliMtimeMs: 1 }),
		{ stale: true, reason: "cli_missing" });
	assert.equal(surfaceLib.staleness({ cli: self }).stale, false, "an unversioned surface is not evidence of staleness");
	assert.equal(surfaceLib.staleness(null).stale, true);
}

// -------------------------------------------------- catalog-derived surfaces ---

{
	const derived = surfaceLib.derivedSurface("/tmp/runware", [
		{ cmd: "image generate", flags: ["args"], class: "mutate" },
		{ cmd: "models upload", flags: ["args"], class: "blocked" },
		{ cmd: "models upload", flags: ["args"], class: "read" },
		"status",
	], { source: "provider_catalog" });
	assert.equal(derived.leafCount, 3);
	assert.deepEqual(derived.leaves.map((leaf) => leaf.cmd), ["image generate", "models upload", "status"]);
	assert.equal(derived.leaves.find((leaf) => leaf.cmd === "models upload").class, "sensitive",
		"legacy blocked must map to the sensitive advisory");
	assert.equal(derived.leaves.find((leaf) => leaf.cmd === "status").class, "mutate");
	assert.equal(derived.coverage.complete, true);
	assert.equal(surfaceLib.derivedSurface("/tmp/runware", [], {}), null);
}

// ---------------------------------------------------------------- search ---

{
	const surface = {
		cli: "gh",
		leaves: [
			{ cmd: "logs", flags: [], desc: null },
			{ cmd: "login", flags: [], desc: "Log in to a GitHub account" },
			{ cmd: "deployments list", flags: ["json"], desc: "List deployments" },
		],
	};
	const rows = [{ provider: "github", surface }];
	assert.deepEqual(surfaceLib.searchSurfaces(rows, "logs").map((hit) => hit.leaf.cmd), ["logs"]);
	assert.equal(surfaceLib.searchSurfaces(rows, "log").some((hit) => hit.leaf.cmd === "login"), false,
		"a 3-letter query must not prefix-match login");
	assert.deepEqual(surfaceLib.searchSurfaces(rows, "log").map((hit) => hit.leaf.cmd), ["logs"],
		"the short singular still finds its own plural command");
	assert.ok(surfaceLib.searchSurfaces(rows, "github").some((hit) => hit.leaf.cmd === "login"),
		"description words still match when they do not name the command");
	assert.ok(surfaceLib.searchSurfaces(rows, "deploy").some((hit) => hit.leaf.cmd === "deployments list"));
	const text = surfaceLib.renderSearch([{ provider: "github", leaf: surface.leaves[2] }], "deploy", null);
	assert.match(text, /--json/, "search output must not hoist flags out of view");
}

{
	// A plural query is judged by its singular root, and the root matches a
	// command word only by equality with itself or its plain plural. `login` and
	// `logout` describe themselves with "Logs into your account"; the plural
	// never prefix-matched their command words, so they leaked in through the
	// description fallback. The root test is what has to stop them.
	const surface = {
		cli: "mixed",
		leaves: [
			{ cmd: "logs", flags: [], desc: "View build or deploy logs" },
			{ cmd: "logs list", flags: [], desc: "List API request logs" },
			{ cmd: "codespace logs", flags: [], desc: "Access codespace logs" },
			{ cmd: "login", flags: [], desc: "Logs into your account or creates a new one" },
			{ cmd: "logout", flags: [], desc: "Logs out of your account" },
		],
	};
	const logMatches = surfaceLib.searchSurfaces([{ provider: "mixed", surface }], "logs").map((hit) => hit.leaf.cmd);
	assert.deepEqual(logMatches.slice().sort(), ["codespace logs", "logs", "logs list"],
		`find logs must not return login/logout: ${JSON.stringify(logMatches)}`);
	assert.equal(surfaceLib.searchSurfaces([{ provider: "mixed", surface }], "logs").some((hit) => hit.leaf.cmd === "login"), false,
		"a description word must never override the command-name root decision");
}

// ------------------------------------------------ coverage rendering ---

{
	const legacy = { cli: "legacy", leaves: [{ cmd: "group", flags: [], desc: null, complete: false, truncatedSubcommands: [] }] };
	assert.equal(surfaceLib.coverageStatus(legacy).known, false,
		"a surface without coverage metadata is unknown, not complete");
	assert.deepEqual(surfaceLib.coverageStatus({ cli: "x", leaves: [] }),
		{ known: false, complete: null, truncatedLeafCount: null, truncatedLeaves: [], unexpandedGroups: [], repeatedParentLeaves: [] });
	const backfilled = surfaceLib.coverageStatus({ coverage: { complete: false, truncatedLeafCount: 1, truncatedLeaves: ["group"] }, leaves: legacy.leaves });
	assert.deepEqual(backfilled.unexpandedGroups, ["group"], "pre-reason incomplete leaves backfill as groups");
	assert.deepEqual(backfilled.repeatedParentLeaves, []);

	const surface = {
		cli: "cli",
		cliVersion: "1.0.0",
		leafCount: 3,
		coverage: {
			source: "help_walk",
			complete: false,
			truncatedLeafCount: 1,
			truncatedLeaves: ["group"],
			unexpandedGroups: ["group"],
			repeatedParentLeaves: [],
		},
		leaves: [
			{ cmd: "group", flags: ["json"], desc: "A group", complete: false, incompleteReason: "max_depth", truncatedSubcommands: ["sub"] },
			{ cmd: "list", flags: [], desc: "List things" },
			{ cmd: "deploy", flags: ["json"], desc: "Deploy things" },
		],
	};
	const menu = surfaceLib.renderMenu(surface, { provider: "cli", classify: () => "read" });
	assert.match(menu, /group — help only/);
	assert.match(menu, /pi-toolbelt menu cli "group"/);
	assert.match(menu, /coverage: incomplete/);
	assert.doesNotMatch(menu, /^group  --json$/m, "an unexpanded group must not be printed as a runnable flag recipe");
	assert.match(menu, /deploy/);
	assert.equal(surfaceLib.renderMenu(surface, { provider: "cli", classify: () => "read" }), menu,
		"menu rendering must be deterministic");

	const index = surfaceLib.renderGroupIndex(surface);
	assert.match(index, /partially expanded/);
	assert.match(index, /coverage: incomplete/);

	const oldSurface = { cli: "old", cliVersion: null, leafCount: 1, leaves: [{ cmd: "status", flags: [], desc: null }] };
	assert.match(surfaceLib.renderMenu(oldSurface, { provider: "old" }), /coverage: unknown/,
		"a surface without coverage metadata never renders as complete");

	// A group hit is help-only in search output too: no runnable flag recipe.
	const groupSurface = {
		cli: "cli",
		leaves: [
			{ cmd: "email routing addresses", flags: ["config"], desc: "Manage addresses", complete: false, incompleteReason: "max_depth", truncatedSubcommands: ["list"] },
			{ cmd: "banner", flags: ["json"], desc: "Show a banner" },
		],
		coverage: { complete: false, truncatedLeafCount: 1, truncatedLeaves: ["email routing addresses"], unexpandedGroups: ["email routing addresses"], repeatedParentLeaves: [] },
	};
	const hits = surfaceLib.searchSurfaces([{ provider: "cli", surface: groupSurface }], "email");
	assert.equal(hits.length, 1);
	const search = surfaceLib.renderSearch(hits, "email", null);
	assert.match(search, /\[group — open with: pi-toolbelt menu cli "email"\]/);
	assert.doesNotMatch(search, /--config/, "a group hit must not advertise a runnable flag recipe");
	assert.match(search, /coverage: incomplete for cli/);
}

// ---------------------------------------------------------- policy grammar ---

{
	assert.deepEqual(policyLib.commandWords(["--repo", "owner/repo", "api", "--method", "POST"]), ["api"]);
	assert.deepEqual(policyLib.commandWords(["--debug", "api"]), ["api"]);
	assert.deepEqual(policyLib.commandWords(["db", "push", "--linked"]), ["db", "push"]);
	assert.deepEqual(policyLib.commandWords(["--", "db", "push"]), ["db", "push"]);

	assert.equal(policyLib.httpMethod(["-f", "x=1"]), "POST");
	assert.equal(policyLib.httpMethod(["--raw-field", "x=1"]), "POST");
	assert.equal(policyLib.httpMethod(["--input", "body.json"]), "POST");
	assert.equal(policyLib.httpMethod(["-X", "DELETE"]), "DELETE");
	assert.equal(policyLib.httpMethod(["--method=PATCH"]), "PATCH");
	assert.equal(policyLib.httpMethod(["-XGET", "-f", "x=1"]), "GET", "an explicit method wins over a body flag");
	assert.equal(policyLib.httpMethod([]), "GET");

	const github = policyLib.readPolicy(DATA_DIR, "github");
	assert.equal(policyLib.classify(github, ["api"]).class, "read");
	assert.equal(policyLib.classify(github, ["api", "-f", "x=1"]).class, "mutate",
		"gh api -f defaults to POST");
	assert.equal(policyLib.classify(github, ["api", "--input", "body.json"]).reason, "http_post");
	assert.equal(policyLib.classify(github, ["api", "-X", "DELETE"]).class, "destructive");
	assert.equal(policyLib.classify(github, ["--repo", "owner/repo", "api", "-f", "x=1"]).class, "mutate",
		"a leading global flag must not hide the verb");
	assert.equal(policyLib.classify(github, []).class, "mutate", "an unparsed command must fail closed, never read");
	assert.equal(policyLib.classify(github, []).reason, "no_command_words");

	const unclassifiedPolicy = policyLib.readPolicy(DATA_DIR, "neon");
	assert.equal(policyLib.classify(unclassifiedPolicy, ["mystery-operation"]).class, "mutate");
	assert.equal(policyLib.classify(unclassifiedPolicy, ["mystery-operation"]).reason, "default_unclassified");
	assert.equal(policyLib.classify(unclassifiedPolicy, ["login"]).class, "sensitive",
		"credential/session patterns stay an advisory, not a refusal");
	assert.equal(policyLib.classify(unclassifiedPolicy, ["mystery-operation"], { cmd: "mystery-operation", class: "blocked" }).class, "sensitive");
	const declared = policyLib.classify(unclassifiedPolicy, ["mystery-operation"], { cmd: "mystery-operation", class: "blocked" });
	assert.equal(declared.class, "sensitive");
	assert.notEqual(declared.class, "blocked", "a refusal-only class can never reach the router");
	assert.equal(policyLib.CLASSES.includes("blocked"), false, "no refusal-only class may re-enter the router");
	assert.deepEqual(policyLib.unclassified(unclassifiedPolicy, { leaves: [{ cmd: "mystery-operation", class: "blocked" }] }), []);
}

// Provider-declared mutable commands keep their class when a positional value
// happens to read like a read verb (`git push <remote named status>`), and
// leading global flags must not hide the verb.
{
	const git = policyLib.readPolicy(DATA_DIR, "git");
	assert.equal(policyLib.classify(git, ["status"]).class, "read");
	const push = { cmd: "push", class: "mutate" };
	const positionalRead = policyLib.classify(git, ["push", "status"], push);
	assert.equal(positionalRead.class, "mutate", "a positional named status must not downgrade a declared mutation");
	assert.equal(positionalRead.reason, "surface_declared");
	assert.equal(policyLib.classify(git, ["push", "origin", "status"], push).class, "mutate");

	assert.deepEqual(policyLib.commandWords(["--config", "wrangler.toml", "deploy"]), ["deploy"]);
	assert.deepEqual(policyLib.commandWords(["--config=wrangler.toml", "deploy"]), ["deploy"]);
	assert.equal(policyLib.classify(git, ["--config", "x", "delete"]).class, "destructive",
		"a leading global flag must not turn a destructive verb into an unknown one");

	// Unknown stays executable mutate — advisory, never blocked.
	assert.equal(policyLib.classify(git, ["frobnicate"]).class, "mutate");
	assert.equal(policyLib.classify(git, ["frobnicate"]).reason, "default_unclassified");
	assert.equal(policyLib.classify(git, ["frobnicate"]).class === "blocked", false);
}

console.log("toolbelt discovery/policy regressions ok");
