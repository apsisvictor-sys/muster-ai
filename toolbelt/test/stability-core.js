#!/usr/bin/env node
"use strict";

// Core stability regression suite for bin/pi-toolbelt.
//
// Everything here is hermetic: PI_TOOLBELT_HOME points at a temp directory and
// every provider CLI used by a test is a fake executable placed first on PATH.
// No real provider, account, network call or paid operation is touched.
//
// These are mock-backed checks of Toolbelt's own control flow (passthrough,
// cwd/deadline/stdin plumbing, identity-conflict refusal, JSON falsy payloads,
// path-traversal rejection). They do not prove the real provider CLIs behave
// as the fakes do.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BIN = process.env.PI_TOOLBELT_BIN || path.join(os.homedir(), ".pi", "agent", "harness", "toolbelt", "bin", "pi-toolbelt");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-toolbelt-stability-"));
const HOME = path.join(ROOT, "home");
const DATA = path.join(HOME, "data");
const FAKE_BIN = path.join(ROOT, "bin");
const NO_CLI = path.join(ROOT, "nocli");
for (const dir of [DATA, path.join(DATA, "surface"), FAKE_BIN, NO_CLI]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

const NODE_DIR = path.dirname(process.execPath);
const PATH_WITH_FAKES = [FAKE_BIN, NODE_DIR, "/usr/bin", "/bin"].join(path.delimiter);
const PATH_WITHOUT_FAKES = NO_CLI;

const FAKE_SOURCE = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const name = path.basename(process.argv[1] || "fake");
const argv = process.argv.slice(2);
let stdin = "";
try { if (!process.stdin.isTTY) stdin = fs.readFileSync(0, "utf8"); } catch {}
if (process.env.FAKE_LOG) {
  try { fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ name, argv, cwd: process.cwd(), stdin }) + "\\n"); } catch {}
}
if (process.env.FAKE_VERSION_MARKER && argv.includes("--version")) {
  try { fs.writeFileSync(process.env.FAKE_VERSION_MARKER, "probed\\n"); } catch {}
}
if (argv.includes("--version")) { process.stdout.write("fake-cli 1.2.3\\n"); process.exit(0); }
if (name === "resend" && argv[0] === "whoami") {
  process.stdout.write(JSON.stringify({ authenticated: true, profile: process.env.FAKE_PROFILE || "work" }) + "\\n");
  process.exit(0);
}
if (name === "vercel" && argv[0] === "whoami") {
  process.stdout.write((process.env.FAKE_IDENTITY || "tester") + "\\n");
  process.exit(0);
}
if (process.env.FAKE_SLEEP_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_SLEEP_MS));
if (process.env.FAKE_STDOUT !== undefined) {
  process.stdout.write(process.env.FAKE_STDOUT);
  process.exit(Number(process.env.FAKE_EXIT || 0));
}
process.stdout.write(JSON.stringify({ name, argv, cwd: process.cwd(), stdin }) + "\\n");
process.exit(Number(process.env.FAKE_EXIT || 0));
`;

for (const name of ["vercel", "resend", "tailscale", "gh", "git"]) {
  const file = path.join(FAKE_BIN, name);
  fs.writeFileSync(file, FAKE_SOURCE, { mode: 0o755 });
}

// A cached surface for vercel: proves the menu is a cache even when the CLI
// is absent, and lets the unlisted-command note be exercised.
fs.writeFileSync(path.join(DATA, "surface", "vercel.json"), JSON.stringify({
  schemaVersion: 1,
  cli: "vercel",
  cliVersion: "0.0.0-fake",
  leafCount: 2,
  leaves: [
    { cmd: "status", flags: ["json"], class: "read", desc: "Show status" },
    { cmd: "deploy", flags: [], class: "mutate", desc: "Deploy" },
  ],
}), { mode: 0o600 });

fs.writeFileSync(path.join(DATA, "accounts.json"), JSON.stringify({
  version: 1,
  accounts: { work: { provider: "resend", profile: "work", expectedIdentity: "work" } },
  projects: {},
}), { mode: 0o600 });

const LEDGER = path.join(DATA, "ledger.jsonl");
const IDENTITY_CACHE = path.join(DATA, "identity-cache.json");

function clearIdentityCache() {
  try { fs.rmSync(IDENTITY_CACHE, { force: true }); } catch {}
}

function run(args, options = {}) {
  const env = {
    ...process.env,
    PATH: options.path || PATH_WITH_FAKES,
    PI_TOOLBELT_HOME: HOME,
    ...(options.env || {}),
  };
  const separator = args.indexOf("--");
  const fullArgs = separator >= 0
    ? [...args.slice(0, separator), "--json", ...args.slice(separator)]
    : [...args, "--json"];
  const result = spawnSync(process.execPath, [BIN, ...fullArgs], { encoding: "utf8", timeout: 60_000, maxBuffer: 4_000_000, env });
  assert.equal(result.status, 0, `expected exit 0 for "pi-toolbelt ${args.join(" ")}": ${result.stderr}`);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`invalid JSON for "pi-toolbelt ${args.join(" ")}": ${error.message}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
}

function freshLog(name) {
  const file = path.join(ROOT, `${name}.log`);
  fs.rmSync(file, { force: true });
  return file;
}

function logEntries(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

let checked = 0;
function check(label, fn) {
  fn();
  checked += 1;
  process.stdout.write(`ok ${checked} - ${label}\n`);
}

// 1. Availability is path resolution, not a --version probe.
check("providers does not spawn --version to decide installed", () => {
  const marker = path.join(ROOT, "version-marker");
  const envelope = run(["providers", "--all"], { env: { FAKE_VERSION_MARKER: marker } });
  assert.equal(envelope.ok, true);
  const row = envelope.providers.find((entry) => entry.id === "vercel");
  assert.ok(row, "vercel row missing");
  assert.equal(row.installed, true, "fake vercel on PATH should be installed");
  assert.equal(row.surface, true, "cached surface should be reported separately");
  assert.equal(fs.existsSync(marker), false, "a --version subprocess was still spawned");
});

// 2. An installed CLI and a cached surface are independent facts.
check("providers does not treat a cached surface as an installed CLI", () => {
  const envelope = run(["providers", "--all"], { path: PATH_WITHOUT_FAKES });
  const row = envelope.providers.find((entry) => entry.id === "vercel");
  assert.ok(row, "vercel row missing");
  assert.equal(row.installed, false, "no vercel on PATH, so it is not installed");
  assert.equal(row.surface, true, "the cached surface is still reported");
});

// 3. A command the cached menu does not index still runs, with a note.
check("run passes an unlisted command through instead of refusing it", () => {
  const log = freshLog("unlisted");
  const dir = fs.mkdtempSync(path.join(ROOT, "cwd-"));
  const envelope = run(["run", "vercel", "--", "totally-unlisted", "--weird-flag", "value"], { env: { FAKE_LOG: log } });
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  assert.equal(envelope.status, "success");
  assert.equal(envelope.menuChecked, true);
  assert.match(String(envelope.menuNote || ""), /not in the cached menu/);
  const entry = logEntries(log).find((row) => row.argv.includes("totally-unlisted"));
  assert.ok(entry, "provider CLI was never invoked");
  assert.deepEqual(entry.argv, ["totally-unlisted", "--weird-flag", "value"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 4. Provider flags that collide with Toolbelt flag names are not rejected.
check("run passes provider flags named like Toolbelt flags", () => {
  const log = freshLog("collision");
  const envelope = run(["run", "vercel", "--", "deploy", "--account", "acct", "--timeout-ms", "5", "--reason", "why"], { env: { FAKE_LOG: log } });
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  const entry = logEntries(log).find((row) => row.argv.includes("deploy"));
  assert.ok(entry, "provider CLI was never invoked");
  assert.deepEqual(entry.argv, ["deploy", "--account", "acct", "--timeout-ms", "5", "--reason", "why"]);
  assert.match(String(envelope.flagCollisionNote || ""), /--account/);
});

// 5. --cwd reaches the provider process, with a realpath.
check("--cwd is applied to the provider process", () => {
  const log = freshLog("cwd");
  const dir = fs.mkdtempSync(path.join(ROOT, "target-"));
  const real = fs.realpathSync(dir);
  const envelope = run(["run", "--cwd", dir, "vercel", "--", "status"], { env: { FAKE_LOG: log } });
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  assert.equal(envelope.cwd, real);
  const entry = logEntries(log).find((row) => row.argv.includes("status"));
  assert.ok(entry, "provider CLI was never invoked");
  assert.equal(entry.cwd, real);
});

check("--cwd naming a missing directory fails before running", () => {
  const log = freshLog("badcwd");
  const envelope = run(["run", "--cwd", path.join(ROOT, "does-not-exist"), "vercel", "--", "status"], { env: { FAKE_LOG: log } });
  assert.equal(envelope.ok, false);
  assert.equal(envelope.status, "cwd_not_directory");
  assert.equal(logEntries(log).length, 0, "provider ran with a bad cwd");
});

// 6. --deadline-ms covers preflight plus execution.
check("--deadline-ms in the past refuses before running", () => {
  const log = freshLog("pastdeadline");
  const envelope = run(["run", "vercel", "--deadline-ms", "1", "--", "status"], { env: { FAKE_LOG: log } });
  assert.equal(envelope.ok, false);
  assert.equal(envelope.status, "deadline_exceeded");
  assert.equal(logEntries(log).length, 0, "provider ran after the deadline");
});

check("--deadline-ms bounds the provider execution", () => {
  const log = freshLog("deadline");
  const deadline = Date.now() + 400;
  const envelope = run(["run", "vercel", "--deadline-ms", String(deadline), "--", "status"], { env: { FAKE_LOG: log, FAKE_SLEEP_MS: "3000" } });
  assert.equal(envelope.ok, false, JSON.stringify(envelope));
  assert.equal(envelope.status, "timeout");
  assert.equal(envelope.deadlineMs, deadline);
  assert.equal(envelope.exitCode, null);
});

// 6b. --timeout-ms is passed through as asked. The old 5s floor silently ran a
// requested 300ms budget for 5s, so a deadline-driven caller's exact remaining
// time was overrun.
check("--timeout-ms below the old 5s floor bounds the provider execution", () => {
  const log = freshLog("shorttimeout");
  const startedAt = Date.now();
  const envelope = run(["run", "vercel", "--timeout-ms", "300", "--", "status"], { env: { FAKE_LOG: log, FAKE_SLEEP_MS: "4000" } });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(envelope.ok, false, JSON.stringify(envelope));
  assert.equal(envelope.status, "timeout");
  assert.equal(envelope.exitCode, null);
  assert.equal(envelope.deadlineMs, null, "no --deadline-ms was passed");
  assert.ok(elapsedMs < 3000, `a requested 300ms timeout ran for ${elapsedMs}ms: the 5s floor is back`);
  const entry = logEntries(log).find((row) => row.argv.includes("status"));
  assert.ok(entry, "provider CLI was never invoked");
});

// 7. Non-zero provider exits are classified, not reported as success.
check("a non-zero provider exit is a provider_error with its exit code", () => {
  const log = freshLog("exit");
  const envelope = run(["run", "vercel", "--", "status"], { env: { FAKE_LOG: log, FAKE_EXIT: "3" } });
  assert.equal(envelope.ok, false);
  assert.equal(envelope.status, "provider_error");
  assert.equal(envelope.exitCode, 3);
});

// 8. JSON false/0 are parsed payloads, not missing output.
check("a provider that prints JSON false keeps data=false and no stdout", () => {
  const log = freshLog("jsonfalse");
  const envelope = run(["run", "vercel", "--", "status"], { env: { FAKE_LOG: log, FAKE_STDOUT: "false" } });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data, false);
  assert.equal(envelope.stdout, undefined);
});

check("a provider that prints JSON 0 keeps data=0 and no stdout", () => {
  const log = freshLog("jsonzero");
  const envelope = run(["run", "vercel", "--", "status"], { env: { FAKE_LOG: log, FAKE_STDOUT: "0" } });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data, 0);
  assert.equal(envelope.stdout, undefined);
});

// 9. --stdin-file is read locally, its bytes reach the provider, and no raw
// output comes back: a provider may echo them whole, partial or transformed.
check("--stdin-file feeds the provider and stays out of output and ledger", () => {
  const log = freshLog("stdin");
  const payload = "stdin-payload-not-a-secret-42";
  const file = path.join(ROOT, "payload.txt");
  fs.writeFileSync(file, payload, { mode: 0o600 });
  const before = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, "utf8") : "";
  const envelope = run(["run", "vercel", "--stdin-file", file, "--", "status"], { env: { FAKE_LOG: log } });
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  assert.equal(envelope.stdinFileUsed, true);
  const entry = logEntries(log).find((row) => row.argv.includes("status"));
  assert.ok(entry, "provider CLI was never invoked");
  assert.equal(entry.stdin, payload);
  // The fake echoes stdin back inside its JSON body, which is exactly what a
  // real provider may do. No raw body may travel back, but the reason and the
  // execution facts must.
  assert.equal(envelope.outputSuppressed, true, "stdin runs must report outputSuppressed");
  assert.equal(envelope.outputSuppressedReason, "raw output withheld: a --stdin-file was supplied and the provider may echo those bytes");
  assert.equal(envelope.data, undefined, "data must be withheld for a stdin run");
  assert.equal(envelope.stdout, undefined, "stdout must be withheld for a stdin run");
  assert.equal(envelope.stderr, undefined, "stderr must be withheld for a stdin run");
  assert.equal(envelope.hint, undefined, "hint must be withheld for a stdin run");
  assert.equal(envelope.status, "success");
  assert.equal(envelope.exitCode, 0);
  assert.equal(envelope.operationClass, "read");
  assert.equal(typeof envelope.durationMs, "number");
  assert.equal(JSON.stringify(envelope).includes(payload), false, "stdin value leaked into output");
  const after = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, "utf8") : "";
  assert.equal((after.slice(before.length)).includes(payload), false, "stdin value leaked into the ledger");
});

check("--stdin-file with a sanitizer withholds the sanitized payload too", () => {
  const log = freshLog("stdinsanitized");
  const policyDir = path.join(DATA, "policy");
  fs.mkdirSync(policyDir, { recursive: true, mode: 0o700 });
  const policyFile = path.join(policyDir, "vercel.json");
  fs.writeFileSync(policyFile, JSON.stringify({ sanitize: { status: "namesOnly" } }), { mode: 0o600 });
  const payload = "stdin-payload-sanitizer-7";
  const file = path.join(ROOT, "payload-sanitized.txt");
  fs.writeFileSync(file, payload, { mode: 0o600 });
  try {
    const envelope = run(["run", "vercel", "--stdin-file", file, "--", "status"], { env: { FAKE_LOG: log } });
    assert.equal(envelope.ok, true, JSON.stringify(envelope));
    assert.equal(envelope.sanitized, "namesOnly", "the sanitizer that applied is still reported");
    assert.equal(envelope.outputSuppressed, true);
    assert.equal(envelope.data, undefined, "the sanitized payload must not be printed for a stdin run");
    assert.equal(envelope.stdout, undefined);
    assert.equal(envelope.stderr, undefined);
    assert.equal(envelope.stdinFileUsed, true);
    assert.equal(JSON.stringify(envelope).includes(payload), false, "stdin value leaked into output");
  } finally {
    fs.rmSync(policyFile, { force: true });
  }
});

check("--stdin-file naming a missing file refuses before running", () => {
  const log = freshLog("badstdin");
  const envelope = run(["run", "vercel", "--stdin-file", path.join(ROOT, "nope.txt"), "--", "status"], { env: { FAKE_LOG: log } });
  assert.equal(envelope.ok, false);
  assert.equal(envelope.status, "stdin_file_unreadable");
  assert.equal(logEntries(log).length, 0);
});

// 10. A provider profile flag cannot silently replace the bound account.
check("a conflicting resend profile flag is refused before running", () => {
  clearIdentityCache();
  const log = freshLog("profileconflict");
  const envelope = run(["run", "resend", "--", "send", "--profile", "other"], { env: { FAKE_LOG: log } });
  assert.equal(envelope.ok, false, JSON.stringify(envelope));
  assert.equal(envelope.status, "account_profile_mismatch");
  assert.equal(logEntries(log).some((row) => row.name === "resend"), false, "a resend process ran despite the conflict");
});

check("the bound resend profile is injected when the command omits one", () => {
  clearIdentityCache();
  const log = freshLog("profilebound");
  const envelope = run(["run", "resend", "--", "send"], { env: { FAKE_LOG: log } });
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  const entry = logEntries(log).find((row) => row.argv.includes("send"));
  assert.ok(entry, "provider CLI was never invoked");
  assert.deepEqual(entry.argv, ["send", "--profile", "work"]);
});

// 11. Provider ids that are paths are rejected before any file read.
check("menu rejects a path-shaped provider id", () => {
  const envelope = run(["menu", "../../etc/passwd"]);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error, "unknown_provider");
});

check("run rejects a path-shaped provider id", () => {
  const envelope = run(["run", "../../../bin/sh", "--", "status"]);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.status, "unknown_provider");
});

// 12. git needs an explicit repository target.
check("git without --cwd or -C refuses and does not run", () => {
  const log = freshLog("gitnocwd");
  const envelope = run(["run", "git", "--", "status"], { env: { FAKE_LOG: log } });
  assert.equal(envelope.ok, false);
  assert.equal(envelope.status, "git_cwd_required");
  assert.equal(logEntries(log).length, 0);
});

check("git with --cwd runs", () => {
  const log = freshLog("gitcwd");
  const dir = fs.mkdtempSync(path.join(ROOT, "repo-"));
  const envelope = run(["run", "git", "--cwd", dir, "--", "status", "--short"], { env: { FAKE_LOG: log } });
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  const entry = logEntries(log).find((row) => row.name === "git");
  assert.ok(entry, "git was never invoked");
  assert.deepEqual(entry.argv, ["status", "--short"]);
  assert.equal(entry.cwd, fs.realpathSync(dir));
});

check("git with its own -C runs without Toolbelt --cwd", () => {
  const log = freshLog("gitdashc");
  const dir = fs.mkdtempSync(path.join(ROOT, "repo2-"));
  const envelope = run(["run", "git", "--", "-C", dir, "status"], { env: { FAKE_LOG: log } });
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  const entry = logEntries(log).find((row) => row.name === "git");
  assert.ok(entry, "git was never invoked");
  assert.deepEqual(entry.argv, ["-C", dir, "status"]);
});

// 13. Legacy `call` gating must not permanently hide a supported function.
check("call completes an approval-only operation instead of hiding it", () => {
  const log = freshLog("legacycall");
  const envelope = run(["call", "vercel", "env-update"], { env: { FAKE_LOG: log } });
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  const entry = logEntries(log).find((row) => row.name === "vercel");
  assert.ok(entry, "the described operation was never executed");
  assert.deepEqual(entry.argv, ["env", "update"]);
});

check("a blocked call names the exact run alternative", () => {
  const envelope = run(["call", "tailscale", "debug"]);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.status, "blocked_operation");
  assert.equal(envelope.runAlternative, "pi-toolbelt run tailscale -- debug");
});

// 14. The catalogue exposes git through the same run path.
check("inventory lists git as an implemented provider", () => {
  const envelope = run(["inventory"]);
  assert.equal(envelope.ok, true);
  const git = envelope.providers.find((entry) => entry.id === "git");
  assert.ok(git, "git missing from the catalogue");
  assert.match(git.status, /^implemented/);
  assert.equal(git.cli, "git");
  assert.match(String(git.notes), /never pushes through a raw API|credential helper untouched|injects no token/i);
});

fs.rmSync(ROOT, { recursive: true, force: true });
process.stdout.write(`\n1..${checked}\n# ${checked} checks passed (hermetic mocks; no real provider calls)\n`);
