#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TOOLBELT_ROOT = process.env.PI_TOOLBELT_CANONICAL_ROOT
	|| path.resolve(path.dirname(process.env.PI_TOOLBELT_BIN || path.join(os.homedir(), ".pi", "agent", "harness", "toolbelt", "bin", "pi-toolbelt")), "..");
const BIN = process.env.PI_TOOLBELT_BIN || path.join(TOOLBELT_ROOT, "bin", "pi-toolbelt");
const AGENT = process.env.PI_TOOLBELT_AGENT || "conformance";
const EXECUTABLE_CLASSES = new Set(["read", "mutate", "destructive", "sensitive"]);

// --- hermetic fixture -------------------------------------------------------
// This entrypoint is safe to run standalone: it builds its own provider PATH,
// Toolbelt home, and audit log instead of inheriting them. Surfaces, policies,
// and the native provider registry are copied into a temp home, so the
// structural checks below read the exact files the wrapper loads; every
// provider CLI resolves to test/support/fake-provider-cli.js, which performs no
// network I/O and records each invocation instead of contacting a service.
const FAKE_HELPER = path.join(TOOLBELT_ROOT, "test", "support", "fake-provider-cli.js");
const CANONICAL_DATA = path.join(TOOLBELT_ROOT, "data");
const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "toolbelt-conformance-"));
const FIXTURE_HOME = path.join(FIXTURE_ROOT, "toolbelt");
const FIXTURE_BIN = path.join(FIXTURE_ROOT, "bin");
const DATA_DIR = path.join(FIXTURE_HOME, "data");
const AUDIT = path.join(FIXTURE_ROOT, "invocations.jsonl");
fs.mkdirSync(FIXTURE_BIN, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
process.on("exit", () => fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true }));

// Explicit fixture copy: the structural index checks read these files, not the
// live data, so a passing run can never be satisfied by state the wrapper did
// not load from the same canonical surfaces on disk.
fs.cpSync(path.join(CANONICAL_DATA, "surface"), path.join(DATA_DIR, "surface"), { recursive: true });
fs.cpSync(path.join(CANONICAL_DATA, "policy"), path.join(DATA_DIR, "policy"), { recursive: true });
fs.copyFileSync(path.join(CANONICAL_DATA, "providers.json"), path.join(DATA_DIR, "providers.json"));
fs.writeFileSync(path.join(DATA_DIR, "accounts.json"), `${JSON.stringify({
	version: 1,
	accounts: { "resend-fixture": { provider: "resend", profile: "fixture-profile", enabled: true } },
	projects: {},
}, null, 2)}\n`);
fs.writeFileSync(AUDIT, "");

const FIXTURE_CLIS = ["resend", "gh", "vercel", "stripe", "sentry-cli", "railway", "tailscale", "gws", "supabase", "wrangler", "portal", "pixellab", "runware", "studio", "stitch"];
for (const name of FIXTURE_CLIS) {
	fs.writeFileSync(path.join(FIXTURE_BIN, name),
		`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_HELPER)} ${name} "$@"\n`,
		{ mode: 0o755 });
}

// PATH is rebuilt from the fixture bin plus the runtimes this test needs. The
// directories that hold the real provider CLIs (/usr/local/bin, ~/.local/bin)
// are deliberately absent, so a missing fixture is a hard "not installed"
// rather than a live call.
const PYTHON_BIN = ["/usr/bin/python3", "/usr/local/bin/python3", "/bin/python3"].find((candidate) => fs.existsSync(candidate));
const PATH_DIRS = [FIXTURE_BIN, path.dirname(process.execPath), ...(PYTHON_BIN ? [path.dirname(PYTHON_BIN)] : []), "/usr/bin", "/bin"];

// No-fallthrough proof: every provider name must resolve to the fixture shim,
// not to a real CLI that happens to sit later on PATH. A missing fixture is a
// hard failure here, never a live call at run time.
function resolveOnPath(name) {
	for (const dir of PATH_DIRS) {
		const candidate = path.join(dir, name);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch { /* keep looking */ }
	}
	return null;
}
for (const name of FIXTURE_CLIS) {
	assert.equal(resolveOnPath(name), path.join(FIXTURE_BIN, name), `fixture CLI ${name} did not resolve inside the fixture bin`);
}

// HOME is left alone on purpose: the native registry records generated-CLI
// paths under the real home, and rewriting HOME would make the copied
// providers.json drift from the catalog, turning the drift check into noise.
// The live home is still never read or written, because PI_TOOLBELT_HOME points
// at the fixture (its .env does not exist there) and the provider credentials
// below are removed from the child environment entirely.
const FIXTURE_ENV = {
	...process.env,
	PATH: PATH_DIRS.join(path.delimiter),
	PI_TOOLBELT_HOME: FIXTURE_HOME,
	PI_TOOLBELT_BIN: BIN,
	PI_TOOLBELT_IDENTITY_TTL_MS: "0",
	PI_TOOLBELT_FIXTURE: "1",
	PI_TOOLBELT_FAKE_AUDIT: AUDIT,
	PI_TOOLBELT_FAKE_CLIS: FIXTURE_CLIS.join(" "),
	PIXELLAB_CLI_PATH: path.join(FIXTURE_BIN, "pixellab"),
	RUNWARE_CLI_PATH: path.join(FIXTURE_BIN, "runware"),
	STUDIO_CLI_PATH: path.join(FIXTURE_BIN, "studio"),
	STITCH_CLI_PATH: path.join(FIXTURE_BIN, "stitch"),
	PORTAL_CLI_PATH: path.join(FIXTURE_BIN, "portal"),
	PI_TOOLBELT_GWS_BIN: path.join(FIXTURE_BIN, "gws"),
};
for (const credential of ["VERCEL_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "RESEND_API_KEY", "STRIPE_API_KEY", "STRIPE_SECRET_KEY", "SENTRY_AUTH_TOKEN", "RAILWAY_TOKEN", "RAILWAY_API_TOKEN", "TAILSCALE_AUTHKEY", "RUNWARE_API_KEY", "PIXELLAB_API_KEY", "STUDIO_API_KEY", "SUPABASE_ACCESS_TOKEN", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
	delete FIXTURE_ENV[credential];
}

function surfaceIds() {
	return fs.readdirSync(path.join(DATA_DIR, "surface"))
		.filter((file) => file.endsWith(".json"))
		.map((file) => file.replace(/\.json$/, ""));
}

function readSurfaceFile(provider) {
	return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "surface", `${provider}.json`), "utf8"));
}

function leafCommands(provider) {
	return readSurfaceFile(provider).leaves.map((leaf) => leaf.cmd);
}

function run(args, options = {}) {
	const separator = args.indexOf("--");
	const fullArgs = separator >= 0
		? [...args.slice(0, separator), "--json", "--agent", AGENT, ...args.slice(separator)]
		: [...args, "--json", "--agent", AGENT];
	const result = spawnSync(BIN, fullArgs, {
		encoding: "utf8",
		timeout: 120_000,
		maxBuffer: 2_000_000,
		env: options.env || FIXTURE_ENV,
	});
	let json;
	try {
		json = JSON.parse(result.stdout || "{}");
	} catch (error) {
		throw new Error(`invalid JSON for ${fullArgs.join(" ")}: ${error.message}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
	}
	if (!options.allowNonZero) assert.equal(result.status, 0, `expected exit 0 for ${fullArgs.join(" ")}: ${result.stderr}`);
	return { result, json };
}

function assertEnvelope(value, expected = {}) {
	assert.equal(typeof value, "object");
	assert.equal(value.schemaVersion, 1);
	if (expected.provider !== undefined) assert.equal(value.provider, expected.provider);
	if (expected.operation !== undefined) assert.equal(value.operation, expected.operation);
	assert.equal(typeof value.ok, "boolean");
	assert.equal(typeof value.status, "string");
	assert.equal(value.valuesPrinted, false);
	assert.equal(value.policy.secretValuesAccepted, false);
	assert.equal(value.policy.valuesPrinted, false);
}

function assertNoSecret(value) {
	const text = JSON.stringify(value);
	assert.equal(/ghp_[A-Za-z0-9]{10,}|sk-[A-Za-z0-9_-]{16,}|VERCEL_TOKEN[=:]\S+|api[_-]?key[=:]\S+|bearer\s+[A-Za-z0-9._-]{16,}/i.test(text), false, text);
}

function auditEntries() {
	return fs.readFileSync(AUDIT, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function assertProviderInvoked(cli, needle) {
	const match = auditEntries().find((entry) => entry.cli === cli && entry.args.join(" ").includes(needle));
	assert.ok(match, `expected a fixture invocation of ${cli} containing ${JSON.stringify(needle)}; recorded: ${JSON.stringify(auditEntries())}`);
}

let out = run(["catalog-check"]);
assert.equal(out.json.ok, true);
assert.equal(out.json.canonical, "PROVIDER_CATALOG");
assert.equal(out.json.drift, false);
// The native registry includes Git (a surface-less official CLI adapter). Both
// the code-side catalog and the checked-in cache it is compared against must
// carry it, otherwise drift is being hidden rather than reported.
assert.ok(out.json.providers.includes("git"), "canonical provider registry must include git");
const nativeRegistry = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "providers.json"), "utf8"));
assert.ok(nativeRegistry.providers.some((entry) => entry.id === "git"), "native registry cache must include git");
// Structural coverage invariants instead of frozen counts: the numbers must be
// internally consistent and must match the surfaces actually on disk.
const coverage = out.json.coverage;
assert.ok(coverage.checkedProviders > 0, "no providers were checked");
assert.equal(
	coverage.fullyClassifiedProviders.length + coverage.partialProviders.length,
	coverage.checkedProviders,
	"fully classified + partial must account for every checked provider",
);
assert.equal(
	coverage.unclassifiedLeaves,
	coverage.partialProviders.reduce((sum, row) => sum + row.unclassified.length, 0),
	"unclassifiedLeaves must equal the partial-provider detail",
);
if (coverage.unclassifiedLeaves === 0) assert.deepEqual(coverage.partialProviders, []);
const coveredProviders = new Set([
	...coverage.fullyClassifiedProviders,
	...coverage.partialProviders.map((row) => row.provider),
]);
let expectedLeaves = 0;
for (const provider of coveredProviders) {
	const surface = readSurfaceFile(provider);
	expectedLeaves += surface.leafCount ?? surface.leaves.length;
}
assert.equal(coverage.totalLeaves, expectedLeaves, "totalLeaves must match the checked-in surfaces");
for (const provider of ["vercel", "github", "supabase", "resend", "google-workspace", "wrangler"]) {
	assert.ok(coverage.fullyClassifiedProviders.includes(provider), `${provider} is not fully classified`);
}
assertNoSecret(out.json);

// Every checked-in surface must be structurally honest: no fabricated
// placeholders, no duplicate commands, no refusal-only class, and complete
// metadata when a depth cap left groups unexpanded.
for (const provider of surfaceIds()) {
	const surface = readSurfaceFile(provider);
	assert.ok(Array.isArray(surface.leaves) && surface.leaves.length > 0, `${provider}: no leaves`);
	assert.equal(surface.leafCount, surface.leaves.length, `${provider}: leafCount mismatch`);
	const commands = surface.leaves.map((leaf) => leaf.cmd);
	assert.equal(new Set(commands).size, commands.length, `${provider}: duplicate command`);
	for (const leaf of surface.leaves) {
		assert.equal(typeof leaf.cmd, "string", `${provider}: cmd must be a string`);
		assert.ok(leaf.cmd.trim().length > 0, `${provider}: empty cmd`);
		assert.equal(/[<>]/.test(leaf.cmd), false, `${provider}: placeholder leaked into ${leaf.cmd}`);
		assert.ok(Array.isArray(leaf.flags), `${provider}: ${leaf.cmd} flags must be an array`);
		for (const flag of leaf.flags) {
			assert.match(flag, /^[A-Za-z0-9][A-Za-z0-9-]*$/, `${provider}: bad flag ${flag} on ${leaf.cmd}`);
		}
		if (leaf.class !== undefined) {
			assert.ok(EXECUTABLE_CLASSES.has(leaf.class), `${provider}: ${leaf.cmd} has non-executable class ${leaf.class}`);
		}
		if (leaf.complete === false) {
			// Names are present for walk-generated nodes; an empty list means the
			// group is known to be unexpanded but its children were not recorded.
			assert.ok(Array.isArray(leaf.truncatedSubcommands),
				`${provider}: incomplete leaf ${leaf.cmd} must carry truncatedSubcommands`);
		}
	}
	assert.deepEqual(commands, [...commands].sort((a, b) => a.localeCompare(b)), `${provider}: leaves are not sorted`);
	if (surface.coverage) {
		assert.equal(surface.coverage.truncatedLeafCount, surface.coverage.truncatedLeaves.length,
			`${provider}: coverage truncatedLeafCount mismatch`);
		assert.equal(surface.coverage.complete, surface.coverage.truncatedLeaves.length === 0,
			`${provider}: coverage.complete disagrees with truncatedLeaves`);
	}
}

// Discovery regressions for the repaired grammars: fabricated recursion and
// positional arguments must not reach the cached command list.
assert.deepEqual(leafCommands("stitch"), ["batch", "generate", "init", "list-projects", "list-tools", "status"]);
for (const cmd of leafCommands("runware")) {
	assert.equal(!cmd.includes(" ") && cmd.includes("-"), false, `runware: hyphenated catalog id ${cmd}`);
}
for (const cmd of ["models search", "models upload", "image generate", "task response", "task helpers"]) {
	assert.ok(leafCommands("runware").includes(cmd), `runware missing documented command ${cmd}`);
}
assert.ok(leafCommands("vercel").includes("git connect"), "vercel git connect missing");
assert.ok(leafCommands("vercel").includes("git disconnect"), "vercel git disconnect missing");
assert.equal(leafCommands("vercel").some((cmd) => /^git (?:connect|disconnect) (?:connect|disconnect)$/.test(cmd)), false,
	"vercel: crossed git combinations returned");
for (const cmd of ["deploy", "init", "delete", "dev", "docs", "types", "complete", "rollback", "secret bulk", "d1 create", "d1 execute"]) {
	assert.ok(leafCommands("wrangler").includes(cmd), `wrangler missing ${cmd}`);
}
assert.equal(leafCommands("wrangler").some((cmd) => /(^| )([a-z-]+) \2$/.test(cmd)), false, "wrangler: repeated positional token");

out = run(["inventory"]);
assert.equal(out.json.ok, true);
assert.equal(out.json.catalogDrift, false);
assert.ok(out.json.providers.some((provider) => provider.id === "git" && String(provider.status).startsWith("implemented")),
	"inventory must report the native git adapter as implemented");
assert.equal(out.json.valuesPrinted, false);
assertNoSecret(out.json);

out = run(["find", "deployment logs"]);
assert.equal(out.json.ok, true);
assert.ok(Array.isArray(out.json.matches) && out.json.matches.length > 0);
assert.match(out.json.text, /logs?/i);
assert.ok(out.json.matches.every((match) => typeof match.operationClass === "string"));
// Substring search used to surface `login` for `log`/`logs` queries.
out = run(["find", "logs"]);
assert.equal(out.json.ok, true);
const logMatches = out.json.matches.map((match) => match.command);
assert.equal(logMatches.some((command) => command.split(" ").includes("login")), false,
	`find logs returned login: ${JSON.stringify(logMatches)}`);
assert.ok(logMatches.some((command) => command.split(" ").includes("logs")), "find logs returned no logs command");

// Cached menus for the repaired providers must not advertise fabricated trees.
out = run(["menu", "vercel", "git"]);
assert.equal(out.json.ok, true);
assert.match(out.json.text, /git connect/);
assert.doesNotMatch(out.json.text, /git connect connect/);
out = run(["menu", "stitch"]);
assert.equal(out.json.ok, true);
assert.match(out.json.text, /batch/);
assert.doesNotMatch(out.json.text, /batch batch/);
out = run(["menu", "runware", "image"]);
assert.equal(out.json.ok, true);
assert.match(out.json.text, /image generate/);
assert.doesNotMatch(out.json.text, /image-generate/);
out = run(["menu", "wrangler", "d1"]);
assert.equal(out.json.ok, true);
assert.match(out.json.text, /d1 create/);
assert.doesNotMatch(out.json.text, /d1 create name/);

out = run(["menu", "supabase"]);
assert.equal(out.json.ok, true);
assert.equal(out.json.provider, "supabase");
assert.equal(typeof out.json.text, "string");
assert.match(out.json.text, /read|mutate|destructive|sensitive/i);

out = run(["operation-meta", "--provider", "stitch", "--operation", "generate"]);
assert.equal(out.json.ok, true);
assert.equal(out.json.adapterTimeoutMs, 420_000);
assert.equal(out.json.extensionTimeoutMs, 435_000);
assert.equal(out.json.deadlineVisible, true);
assert.match(out.json.abortPropagation, /^extension_signal_to_process(?:_tree_pdeathsig)?$/);

out = run(["operation-meta", "--provider", "stitch", "--operation", "batch"]);
assert.equal(out.json.ok, true);
assert.equal(out.json.adapterTimeoutMs, 43_200_000);
assert.equal(out.json.extensionTimeoutMs, 43_215_000);
assert.equal(out.json.maxTimeoutMs, 43_200_000);

out = run(["run"]);
assert.equal(out.json.status, "run_requires_provider");
assert.equal(out.json.hint, "pi-toolbelt providers");

out = run(["run", "--provider", "github"]);
assert.equal(out.json.status, "run_requires_command");

out = run(["run", "--provider", "not-a-real-provider", "--", "status"]);
assert.equal(out.json.status, "unknown_provider");

// An unindexed command is forwarded to the provider CLI instead of being
// refused by the wrapper. The fixture rejects it exactly as the real CLI would,
// so the failure surfaces as provider_error and the invocation is provable in
// the audit log.
out = run(["run", "--provider", "github", "--", "not-a-real-command"]);
assert.equal(out.json.status, "provider_error");
assert.match(out.json.menuNote, /not-a-real-command/);
assertProviderInvoked("gh", "not-a-real-command");

// Toolbelt flag names after `--` belong to the provider CLI. The collision is
// reported as a note and the argv still reaches the CLI verbatim.
out = run(["run", "--provider", "github", "--", "repo", "list", "--account", "fixture-gh-login", "--confirm-mutating"]);
assert.equal(out.json.status, "success");
assert.match(out.json.flagCollisionNote, /--account/);
assert.match(out.json.flagCollisionNote, /--confirm-mutating/);
assertProviderInvoked("gh", "--account fixture-gh-login");

// A Toolbelt-selected account still refuses a provider flag that would run the
// command as a different profile, and does it before anything executes.
out = run(["run", "--provider", "resend", "--account", "resend-fixture", "--", "status", "--profile", "other-profile"]);
assert.equal(out.json.status, "account_profile_mismatch");
assert.equal(out.json.account, "resend-fixture");
assert.equal(auditEntries().some((entry) => entry.cli === "resend"), false,
	"a refused account mismatch must not reach the provider CLI");

out = run(["run", "--provider", "github", "--", "api", "--token", "ghp_aaaaaaaaaaaaaaaaaaaa"], { allowNonZero: true });
assert.equal(out.result.status, 2);
assert.equal(out.json.error, "secret_like_input_rejected");
assert.equal(out.json.valuesPrinted, false);

out = run(["call", "--provider", "stripe", "--operation", "customers-get"]);
assertEnvelope(out.json, { provider: "stripe", operation: "customers-get" });
assert.equal(out.json.status, "missing_required_arg");

out = run(["call", "--provider", "github", "--operation", "branches"]);
assertEnvelope(out.json, { provider: "github", operation: "branches" });
assert.equal(out.json.status, "missing_required_arg");
assertNoSecret(out.json);

out = run(["call", "--provider", "not-implemented", "--operation", "probe"]);
assertEnvelope(out.json, { provider: "not-implemented", operation: "probe" });
assert.equal(out.json.status, "adapter_not_implemented");

out = run(["link", "--name", "safe-test-secret-link", "--target", "https://example.com/callback?token=ghp_aaaaaaaaaaaaaaaaaaaa"], { allowNonZero: true });
assert.equal(out.result.status, 2);
assert.equal(out.json.error, "secret_like_input_rejected");
assert.equal(out.json.valuesPrinted, false);

out = run(["audit-secrets"]);
assert.equal(out.json.ok, true, JSON.stringify(out.json.findings));
assert.deepEqual(out.json.findings, []);
assert.equal(out.json.valuesPrinted, false);

out = run(["ledger", "--limit", "20"]);
assertNoSecret(out.json);

// Isolation proof: every provider process this run reached was the fixture
// helper, and at least one provider invocation happened so the proof is not
// vacuous.
const entries = auditEntries();
assert.ok(entries.length > 0, "no fixture provider invocations were recorded");
for (const entry of entries) {
	assert.equal(entry.fixture, true, `non-fixture provider invocation recorded: ${JSON.stringify(entry)}`);
	assert.ok(FIXTURE_CLIS.includes(entry.cli), `unexpected fixture CLI recorded: ${entry.cli}`);
}

console.log("toolbelt conformance ok");
