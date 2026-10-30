#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BIN = process.env.PI_TOOLBELT_BIN || path.join(os.homedir(), ".pi", "agent", "harness", "toolbelt", "bin", "pi-toolbelt");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-toolbelt-accounts-"));
const binDir = path.join(root, "bin");
const dataDir = path.join(root, "data");
const auditLog = path.join(root, "invocations.jsonl");
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, "accounts.json"), JSON.stringify({
  version: 1,
  accounts: {
    "resend-personal": { provider: "resend", profile: "personal-operator", enabled: true },
    "resend-acme-realty": { provider: "resend", profile: "acme-realty", enabled: true },
    "github-personal": { provider: "github", profile: "personal", expectedIdentity: "personal-user", enabled: true },
    "github-partnervault": { provider: "github", profile: "partnervault", expectedIdentity: "partner-user", enabled: true },
    "vercel-personal": { provider: "vercel", profile: "personal", expectedIdentity: "personal-vercel", enabled: true },
    "vercel-partnervault": { provider: "vercel", profile: "partnervault", expectedIdentity: "partner-vercel", scope: "partnerprivate", enabled: true },
  },
  projects: {
    "crm-app-ai-native": { resend: "resend-acme-realty" },
    "partner-vault": { github: "github-partnervault", vercel: "vercel-partnervault" },
  },
}, null, 2));

const fakeResend = `#!/usr/bin/env node
if (process.env.PI_TOOLBELT_FIXTURE !== "1") { process.stderr.write("fixture CLI used outside a fixture-isolated run\\n"); process.exit(96); }
require("fs").appendFileSync(process.env.PI_TOOLBELT_FAKE_AUDIT || "/dev/null", JSON.stringify({ cli: "resend", args: process.argv.slice(2) }) + "\\n");
const args = process.argv.slice(2);
const profileAt = args.findIndex((arg) => arg === "--profile" || arg === "-p");
const profile = profileAt >= 0 ? args[profileAt + 1] : null;
if (process.env.RESEND_API_KEY) {
  process.stderr.write(JSON.stringify({ error: { code: "ambient_secret_leaked" } }));
  process.exit(7);
}
if (args.includes("--version")) { console.log("resend-cli test"); process.exit(0); }
if (args[0] === "whoami") { console.log(JSON.stringify({ authenticated: true, profile, source: "config", api_key: "re_redacted_test_value" })); process.exit(0); }
if (args[0] === "auth" && args[1] === "list") { console.log(JSON.stringify({ profiles: [{ name: profile, active: true }] })); process.exit(0); }
if (args[0] === "domains" && args[1] === "list") { console.log(JSON.stringify({ data: [{ id: "domain_test", profile }] })); process.exit(0); }
console.log(JSON.stringify({ ok: true, profile }));
`;
fs.writeFileSync(path.join(binDir, "resend"), fakeResend, { mode: 0o755 });

const fakeGh = `#!/usr/bin/env node
if (process.env.PI_TOOLBELT_FIXTURE !== "1") { process.stderr.write("fixture CLI used outside a fixture-isolated run\\n"); process.exit(96); }
require("fs").appendFileSync(process.env.PI_TOOLBELT_FAKE_AUDIT || "/dev/null", JSON.stringify({ cli: "gh", args: process.argv.slice(2) }) + "\\n");
const args = process.argv.slice(2);
if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) process.exit(7);
const profile = (process.env.GH_CONFIG_DIR || "").split("/").pop();
const login = profile === "partnervault" ? "partner-user" : "personal-user";
if (args[0] === "api" && args[1] === "user") { console.log(login); process.exit(0); }
if (args[0] === "repo" && args[1] === "list") { console.log(JSON.stringify([{ name: "repo", owner: { login }, url: "https://example.invalid/repo" }])); process.exit(0); }
if (args[0] === "auth" && args[1] === "status") { console.log(\`logged in as \${login}\`); process.exit(0); }
console.log(JSON.stringify({ login, profile }));
`;
fs.writeFileSync(path.join(binDir, "gh"), fakeGh, { mode: 0o755 });

const fakeVercel = `#!/usr/bin/env node
if (process.env.PI_TOOLBELT_FIXTURE !== "1") { process.stderr.write("fixture CLI used outside a fixture-isolated run\\n"); process.exit(96); }
require("fs").appendFileSync(process.env.PI_TOOLBELT_FAKE_AUDIT || "/dev/null", JSON.stringify({ cli: "vercel", args: process.argv.slice(2) }) + "\\n");
const args = process.argv.slice(2);
if (process.env.VERCEL_TOKEN) process.exit(7);
const configAt = args.findIndex((arg) => arg === "--global-config" || arg === "-Q");
const profile = configAt >= 0 ? args[configAt + 1].split("/").pop() : null;
const login = profile === "partnervault" ? "partner-vercel" : "personal-vercel";
if (args.includes("--version")) { console.log("Vercel CLI test"); process.exit(0); }
if (args[0] === "whoami") { console.log(login); process.exit(0); }
if (args[0] === "api") { console.log(JSON.stringify({ projects: [{ id: "project_test", account: login }] })); process.exit(0); }
console.log(JSON.stringify({ login, profile }));
`;
fs.writeFileSync(path.join(binDir, "vercel"), fakeVercel, { mode: 0o755 });

function run(args) {
  const result = spawnSync(BIN, [...args, "--json", "--agent", "account-routing-test"], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, PI_TOOLBELT_HOME: root, PI_TOOLBELT_FIXTURE: "1", PI_TOOLBELT_FAKE_AUDIT: auditLog, RESEND_API_KEY: "re_ambient_must_not_leak", GITHUB_TOKEN: "ambient_github_must_not_leak", VERCEL_TOKEN: "ambient_vercel_must_not_leak" },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

try {
  let out = run(["call", "--provider", "resend", "--operation", "status"]);
  assert.equal(out.status, "account_selection_required");
  assert.deepEqual(out.accounts, ["resend-personal", "resend-acme-realty"]);

  out = run(["call", "--provider", "resend", "--operation", "status", "--project", "crm-app-ai-native"]);
  assert.equal(out.ok, true);
  assert.equal(out.routing.account, "resend-acme-realty");
  assert.equal(out.routing.profile, "acme-realty");
  assert.equal(out.routing.source, "project_binding");
  assert.deepEqual(out.data.env.present, []);

  out = run(["call", "--provider", "resend", "--operation", "domains-list", "--account", "resend-acme-realty"]);
  assert.equal(out.ok, true);
  assert.equal(out.data.data[0].profile, "acme-realty");

  out = run(["call", "--provider", "resend", "--operation", "domains-create", "--account", "resend-acme-realty", "--args", JSON.stringify({ name: "acme-realty.bg", region: "eu-west-1", tls: "enforced" }), "--confirm-mutating", "--reason", "approved test domain"]);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.policy.mutating, true);
  assert.equal(out.data.profile, "acme-realty");

  out = run(["call", "--provider", "resend", "--operation", "api-keys-create", "--account", "resend-acme-realty", "--confirm-mutating", "--reason", "approved secret-returning operation"]);
  assert.equal(out.status, "secure_secret_sink_required");

  out = run(["call", "--provider", "resend", "--operation", "status", "--account", "resend-acme-realty", "--args", JSON.stringify({ profile: "personal-operator" })]);
  assert.equal(out.status, "account_profile_mismatch");

  out = run(["call", "--provider", "resend", "--operation", "status", "--project", "crm-app-ai-native", "--account", "resend-personal"]);
  assert.equal(out.status, "account_binding_mismatch");

  out = run(["call", "--provider", "github", "--operation", "repo-list", "--project", "partner-vault"]);
  assert.equal(out.ok, true);
  assert.equal(out.routing.account, "github-partnervault");
  assert.equal(out.data[0].owner.login, "partner-user");

  out = run(["call", "--provider", "vercel", "--operation", "list-projects", "--project", "partner-vault"]);
  assert.equal(out.ok, true);
  assert.equal(out.routing.account, "vercel-partnervault");
  assert.equal(out.data.projects[0].account, "partner-vercel");

  out = run(["call", "--provider", "github", "--operation", "repo-list", "--account", "github-partnervault"]);
  assert.equal(out.ok, true);
  assert.equal(out.routing.source, "explicit");

  // Isolation proof: the only provider processes that ran were the three
  // fixture CLIs, so no live gh/resend/vercel binary was reachable.
  const audited = fs.readFileSync(auditLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const auditedClis = new Set(audited.map((entry) => entry.cli));
  for (const cli of ["resend", "gh", "vercel"]) assert.equal(auditedClis.has(cli), true, `${cli} fixture was never invoked`);
  assert.deepEqual([...auditedClis].sort(), ["gh", "resend", "vercel"], "a non-fixture CLI ran");

  console.log("toolbelt account routing ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
