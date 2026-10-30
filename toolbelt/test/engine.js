#!/usr/bin/env node
"use strict";

// Engine tests for the capability-index path (providers / menu / run).
//
// Everything runs against a fake `supabase` on PATH inside a temp
// PI_TOOLBELT_HOME, so mutating and destructive commands can be proven to
// actually execute without touching a real provider.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BIN = process.env.PI_TOOLBELT_BIN || path.join(__dirname, "..", "bin", "pi-toolbelt");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-toolbelt-engine-"));
const binDir = path.join(root, "bin");
const dataDir = path.join(root, "data");
const auditLog = path.join(root, "invocations.log");
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, "surface"), { recursive: true });
fs.mkdirSync(path.join(dataDir, "policy"), { recursive: true });

// --- fake provider -------------------------------------------------------
// Records every invocation so tests can assert what did and did not run.
fs.writeFileSync(path.join(binDir, "supabase"), `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(auditLog)}, JSON.stringify({ args, token: process.env.SUPABASE_ACCESS_TOKEN || null }) + "\\n");
const words = []; for (const a of args) { if (a.startsWith("-")) break; words.push(a); } const cmd = words.join(" ");
const org = process.env.SUPABASE_ACCESS_TOKEN === "tok-partner" ? "org-partner" : "org-personal";
if (args.includes("--version")) { console.log("2.98.2"); process.exit(0); }
if (cmd === "orgs list") { console.log(JSON.stringify([{ id: org, name: org, slug: org }])); process.exit(0); }
if (cmd === "projects list") { console.log(JSON.stringify([{ id: "proj1", organization_id: org }])); process.exit(0); }
if (cmd.startsWith("projects create")) { console.log(JSON.stringify({ id: "proj-new", organization_id: org })); process.exit(0); }
if (cmd.startsWith("projects delete")) { console.log(JSON.stringify({ deleted: cmd.split(" ")[2] })); process.exit(0); }
if (cmd === "db push") { console.log(JSON.stringify({ applied: args.includes("--dry-run") ? 0 : 3, dryRun: args.includes("--dry-run") })); process.exit(0); }
if (cmd === "secrets list") { console.log(JSON.stringify([{ name: "API_KEY", value: "sk-live-must-never-surface" }])); process.exit(0); }
if (cmd === "migration list") { console.log(JSON.stringify([{ id: "mig1", name: "fixture-migration" }])); process.exit(0); }
console.error("unknown command: " + cmd);
process.exit(1);
`, { mode: 0o755 });

fs.writeFileSync(path.join(dataDir, "accounts.json"), JSON.stringify({
	version: 1,
	accounts: {
		"supabase-personal": { provider: "supabase", profile: "personal-operator", expectedIdentity: ["org-personal"], enabled: true },
		"supabase-partner": { provider: "supabase", profile: "partner", expectedIdentity: ["org-partner"], enabled: true },
	},
	projects: {
		"personal-thing": { supabase: "supabase-personal" },
		"partner-thing": { supabase: "supabase-partner" },
		"unbound-thing": { resend: "resend-personal" },
	},
}, null, 2));

fs.writeFileSync(path.join(dataDir, "surface", "supabase.json"), JSON.stringify({
	schemaVersion: 1,
	cli: "supabase",
	cliVersion: "2.98.2",
	leafCount: 7,
	leaves: [
		{ cmd: "orgs list", flags: ["output"], desc: "List organizations" },
		{ cmd: "projects list", flags: ["output"], desc: "List projects" },
		{ cmd: "projects create", flags: ["org-id", "region", "size", "output"], desc: "Create a project" },
		{ cmd: "projects delete", flags: ["output"], desc: "Delete a project" },
		{ cmd: "db push", flags: ["dry-run", "linked", "password", "output"], desc: "Push migrations" },
		{ cmd: "secrets list", flags: ["project-ref"], desc: "List secrets" },
		{ cmd: "login", flags: [], desc: "Authenticate" },
	],
}, null, 2));

fs.writeFileSync(path.join(dataDir, "policy", "supabase.json"), JSON.stringify({
	schemaVersion: 1,
	provider: "supabase",
	dryRunFlag: "--dry-run",
	read: [], destructive: [], blocked: [], secretReturning: [],
	exact: { "db push": "mutate", "projects create": "mutate" },
	sanitize: { "secrets list": "namesOnly" },
}, null, 2));

function run(args, extraEnv = {}) {
	// Toolbelt flags must precede "--"; everything after it is provider argv.
	const split = args.indexOf("--");
	const full = split === -1
		? [...args, "--json", "--agent", "engine-test"]
		: [...args.slice(0, split), "--json", "--agent", "engine-test", ...args.slice(split)];
	const result = spawnSync(BIN, full, {
		encoding: "utf8",
		timeout: 60_000,
		env: {
			...process.env,
			PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
			PI_TOOLBELT_HOME: root,
			PI_TOOLBELT_IDENTITY_TTL_MS: "0",
			SUPABASE_ACCESS_TOKEN_PERSONAL_OPERATOR: "tok-personal",
			SUPABASE_ACCESS_TOKEN_PARTNER: "tok-partner",
			SUPABASE_ACCESS_TOKEN: "ambient-must-not-be-used",
			...extraEnv,
		},
	});
	try {
		return JSON.parse(result.stdout || "{}");
	} catch (error) {
		throw new Error(`invalid JSON for ${full.join(" ")}: ${error.message}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
	}
}

function invocations() {
	if (!fs.existsSync(auditLog)) return [];
	return fs.readFileSync(auditLog, "utf8").split("\n").filter(Boolean)
		.map((line) => JSON.parse(line))
		// `--version` install probes carry no auth and are not command runs.
		.filter((call) => !call.args.includes("--version"));
}

function clearInvocations() {
	fs.writeFileSync(auditLog, "");
}

try {
	// --- menu -------------------------------------------------------------
	let out = run(["menu", "supabase"]);
	assert.equal(out.ok, true);
	assert.equal(out.mode, "full");
	assert.match(out.menu, /db push {2}--dry-run --linked --password/, "menu lists per-command flags");
	assert.match(out.menu, /^# supabase/m);

	out = run(["menu", "nope-provider"]);
	assert.equal(out.ok, false);
	// The provider name is validated against the catalog before a surface is
	// looked up, so an unknown provider is reported as such rather than as a
	// missing generated surface.
	assert.equal(out.error || out.status, "unknown_provider");

	// --- reads execute ----------------------------------------------------
	clearInvocations();
	out = run(["run", "supabase", "--account", "supabase-personal", "--", "projects", "list", "-o", "json"]);
	assert.equal(out.ok, true, JSON.stringify(out));
	assert.equal(out.operationClass, "read");
	assert.equal(out.data[0].organization_id, "org-personal");
	assert.equal(invocations().every((call) => call.token !== "ambient-must-not-be-used"), true, "ambient token must be stripped");

	// --- mutations execute; classification is advisory ---------------------
	// Approval gating was removed at the operator's instruction: the agent asks him in
	// chat instead. What must survive is the CLASS, so it knows what to ask about.
	clearInvocations();
	out = run(["run", "supabase", "--account", "supabase-personal", "--", "db", "push", "--linked"]);
	assert.equal(out.ok, true, `mutation must execute without approval flags: ${JSON.stringify(out)}`);
	assert.equal(out.operationClass, "mutate", "the class must still be reported so the agent can ask first");
	assert.equal(out.data.applied, 3);
	assert.equal(invocations().some((call) => call.args.join(" ") === "db push --linked"), true);

	// --- dry-run uses the provider's own flag -----------------------------
	clearInvocations();
	out = run(["run", "supabase", "--account", "supabase-personal", "--dry-run", "--", "db", "push", "--linked"]);
	assert.equal(out.ok, true);
	assert.equal(out.dryRun, true);
	assert.equal(out.data.dryRun, true);
	assert.equal(invocations()[0].args.includes("--dry-run"), true);

	// --- destructive executes too, and is labelled as such -----------------
	clearInvocations();
	out = run(["run", "supabase", "--account", "supabase-personal", "--", "projects", "delete", "proj1"]);
	assert.equal(out.ok, true, JSON.stringify(out));
	assert.equal(out.operationClass, "destructive", "destructive must still be labelled");
	assert.equal(out.data.deleted, "proj1");

	// --- previously-blocked commands now run, still labelled sensitive -----
	clearInvocations();
	out = run(["run", "supabase", "--account", "supabase-personal", "--", "login"]);
	assert.notEqual(out.status, "blocked_operation", "nothing is refused by classification any more");
	assert.equal(out.operationClass, "sensitive", "but the agent is told it is credential-touching");

	// --- secrets never travel in argv, and never come back in output ------
	out = run(["run", "supabase", "--account", "supabase-personal", "--confirm-mutating", "--reason", "x", "--", "db", "push", "--password", "hunter2placeholder"]);
	assert.equal(out.status, "secret_value_in_argv_rejected");
	assert.equal(JSON.stringify(out).includes("hunter2placeholder"), false, "the rejected value must not be echoed");

	out = run(["run", "supabase", "--account", "supabase-personal", "--", "secrets", "list"]);
	assert.equal(out.ok, true, JSON.stringify(out));
	assert.equal(out.sanitized, "namesOnly");
	assert.equal(JSON.stringify(out).includes("sk-live-must-never-surface"), false, "sanitizer must strip values");
	assert.equal(out.data[0].name, "API_KEY", "names survive");

	// --- account boundary -------------------------------------------------
	out = run(["run", "supabase", "--project", "partner-thing", "--", "projects", "list"]);
	assert.equal(out.ok, true);
	assert.equal(out.routing.account, "supabase-partner");
	assert.equal(out.data[0].organization_id, "org-partner");

	out = run(["run", "supabase", "--project", "personal-thing", "--account", "supabase-partner", "--", "projects", "list"]);
	assert.equal(out.status, "account_binding_mismatch", "explicit account may not override a project binding");

	out = run(["run", "supabase", "--project", "unbound-thing", "--", "projects", "list"]);
	assert.equal(out.status, "project_provider_binding_missing", "a registered project with no binding must fail closed");

	out = run(["run", "supabase", "--", "projects", "list"]);
	assert.equal(out.status, "account_selection_required", "two accounts and no selection must fail closed");

	// A mutation under a mis-bound identity must not reach the provider.
	clearInvocations();
	const misbound = JSON.parse(fs.readFileSync(path.join(dataDir, "accounts.json"), "utf8"));
	misbound.accounts["supabase-personal"].profile = "partner";
	fs.writeFileSync(path.join(dataDir, "accounts.json"), JSON.stringify(misbound, null, 2));
	out = run(["run", "supabase", "--account", "supabase-personal", "--confirm-mutating", "--reason", "should not run", "--", "db", "push", "--linked"]);
	assert.equal(out.status, "identity_mismatch", JSON.stringify(out));
	assert.equal(invocations().some((call) => call.args.includes("push")), false, "no mutation may run under an unproven identity");
	misbound.accounts["supabase-personal"].profile = "personal-operator";
	fs.writeFileSync(path.join(dataDir, "accounts.json"), JSON.stringify(misbound, null, 2));

	// --- the command index never gates native execution -------------------
	// An incomplete index must not refuse a command the CLI itself supports;
	// index completeness is discovery metadata, not an execution gate.
	clearInvocations();
	out = run(["run", "supabase", "--account", "supabase-personal", "--", "migration", "list"]);
	assert.equal(out.ok, true, `an unindexed command must still execute: ${JSON.stringify(out)}`);
	assert.equal(out.data[0].id, "mig1");
	assert.equal(invocations().some((call) => call.args.join(" ") === "migration list"), true, "the unindexed command reached the provider CLI");

	// A genuinely wrong command reaches the CLI too, so the evidence is the
	// provider's own failure plus the closest menu match, not a Toolbelt refusal.
	clearInvocations();
	out = run(["run", "supabase", "--account", "supabase-personal", "--", "projcts", "lst"]);
	assert.notEqual(out.status, "unknown_command", "the index must not refuse an unindexed command");
	assert.equal(out.ok, false);
	assert.equal(out.status, "provider_error");
	assert.equal(out.exitCode, 1);
	assert.match(String(out.hint || ""), /projects list/, "the provider failure still names the closest command");

	// --- the ledger records without leaking -------------------------------
	const ledger = fs.readFileSync(path.join(dataDir, "ledger.jsonl"), "utf8");
	assert.equal(ledger.includes("sk-live-must-never-surface"), false);
	assert.equal(ledger.includes("hunter2placeholder"), false);
	assert.equal(ledger.includes("tok-personal"), false);

	console.log("toolbelt engine ok");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
