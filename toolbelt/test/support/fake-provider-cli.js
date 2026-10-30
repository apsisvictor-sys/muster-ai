#!/usr/bin/env node
"use strict";

// Fixture provider CLI for the Toolbelt regression entrypoints.
//
// Every provider command the fixture-isolated suites can reach must resolve
// here, never to the real binary. The script performs no network I/O and
// spawns no child process, so an invocation that lands here cannot cost money
// or change provider state.
//
// Contract:
//   node fake-provider-cli.js <cli-name> <provider-args...>
//   PI_TOOLBELT_FIXTURE   must be "1"
//   PI_TOOLBELT_FAKE_AUDIT  append-only JSONL invocation log (required)
//   PI_TOOLBELT_FAKE_CLIS   space-separated allowlist; the CLI must be in it
//
// Maintenance modes (never write to the audit log):
//   node fake-provider-cli.js --audit-check <audit-file>
//       exit 0 only when the log is non-empty and every entry is a fixture
//       invocation; prints the entry count.
//   node fake-provider-cli.js --audit-has <audit-file> <cli> <substring>
//       exit 0 only when a logged invocation of <cli> has <substring> in its
//       joined argv.

const fs = require("node:fs");

const FIXTURE_CLIS = [
	"resend", "gh", "vercel", "stripe", "sentry-cli", "railway", "tailscale",
	"gws", "supabase", "wrangler", "portal", "pixellab", "runware",
	"studio", "stitch",
];

function fail(code, message) {
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

function argumentValue(args, names) {
	for (const name of names) {
		const at = args.indexOf(name);
		if (at >= 0 && at + 1 < args.length) return args[at + 1];
		const inline = args.find((arg) => arg.startsWith(`${name}=`));
		if (inline) return inline.slice(name.length + 1);
	}
	return null;
}

function readAudit(file) {
	if (!fs.existsSync(file)) return [];
	return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => {
		try {
			return JSON.parse(line);
		} catch {
			fail(96, `corrupt audit line in ${file}`);
			return null;
		}
	});
}

function auditCheck(file) {
	const entries = readAudit(file);
	if (entries.length === 0) fail(1, `no fixture provider invocations were recorded in ${file}`);
	const foreign = entries.filter((entry) => entry.fixture !== true || !FIXTURE_CLIS.includes(entry.cli));
	if (foreign.length > 0) {
		fail(1, `non-fixture provider invocations recorded: ${JSON.stringify(foreign.slice(0, 3))}`);
	}
	process.stdout.write(`${entries.length}\n`);
	process.exit(0);
}

function auditHas(file, cli, needle) {
	const entries = readAudit(file).filter((entry) => entry.cli === cli);
	const match = entries.find((entry) => entry.args.join(" ").includes(needle));
	if (!match) fail(1, `no fixture invocation of ${cli} containing ${JSON.stringify(needle)} in ${file}`);
	process.stdout.write(`${cli}: ${match.args.join(" ")}\n`);
	process.exit(0);
}

function main() {
	const argv = process.argv.slice(2);
	if (argv[0] === "--audit-check") return auditCheck(argv[1]);
	if (argv[0] === "--audit-has") return auditHas(argv[1], argv[2], argv[3]);

	const name = argv[0];
	const args = argv.slice(1);
	if (process.env.PI_TOOLBELT_FIXTURE !== "1") {
		fail(96, `fixture provider CLI ${name} invoked outside a fixture-isolated run`);
	}
	if (!FIXTURE_CLIS.includes(name)) fail(96, `unknown fixture provider CLI: ${name}`);
	const audit = process.env.PI_TOOLBELT_FAKE_AUDIT;
	if (!audit) fail(96, "PI_TOOLBELT_FAKE_AUDIT is not set");
	const allowlist = String(process.env.PI_TOOLBELT_FAKE_CLIS || "").split(/\s+/).filter(Boolean);
	if (allowlist.length > 0 && !allowlist.includes(name)) fail(96, `${name} is not in PI_TOOLBELT_FAKE_CLIS`);
	fs.appendFileSync(audit, `${JSON.stringify({ cli: name, args, fixture: true })}\n`);

	// A command the surface does not index must reach the provider CLI and fail
	// there, never at a wrapper refusal. These probes emulate the real CLI's
	// unknown-command exit so the passthrough contract stays observable while the
	// audit log still records that the invocation happened.
	if (/^not-a-real(?:-command)?$/.test(String(args[0] || ""))) fail(1, `${name}: unknown command "${args[0]}"`);

	const emit = (value) => {
		process.stdout.write(`${JSON.stringify(value)}\n`);
		process.exit(0);
	};
	const textOut = (value) => {
		process.stdout.write(`${String(value)}\n`);
		process.exit(0);
	};
	const has = (value) => args.includes(value);
	const profile = argumentValue(args, ["--profile", "-p"]);

	if (has("--version")) textOut(`${name}-fixture`);

	switch (name) {
		case "resend":
			if (args[0] === "whoami") {
				emit({ authenticated: true, profile, source: "fixture", api_key: "re_redacted_fixture_value" });
			}
			if (args[0] === "auth" && args[1] === "list") {
				emit({ profiles: [{ name: profile, active: true }] });
			}
			if (args[0] === "domains" && args[1] === "list") {
				emit({ data: [{ id: "domain_fixture", name: "fixture.example", status: "verified", profile }] });
			}
			emit({ ok: true, fixture: true, cli: "resend", profile });
			break;
		case "gh":
			if (args[0] === "api" && args[1] === "user") textOut("fixture-user");
			if (args[0] === "auth" && args[1] === "status") textOut("logged in as fixture-user");
			if (args[0] === "repo" && args[1] === "list") emit([{ name: "fixture-repo", owner: { login: "fixture-user" }, url: "https://example.invalid/fixture-repo" }]);
			if (args[0] === "release" && args[1] === "list") emit([]);
			if (args[0] === "pr" && args[1] === "list") emit([]);
			if (args[0] === "issue" && args[1] === "list") emit([]);
			if (args[0] === "run" && args[1] === "list") emit([]);
			if (args[0] === "workflow" && args[1] === "list") emit([]);
			if (args[0] === "gist" && args[1] === "list") emit([]);
			emit({ ok: true, fixture: true, cli: "gh" });
			break;
		case "vercel":
			if (args[0] === "whoami") textOut("fixture-vercel");
			if (args[0] === "api") emit({ projects: [] });
			if (args[0] === "domains" && args[1] === "list") emit([]);
			if (args[0] === "teams" && args[1] === "list") emit([]);
			if (args[0] === "ls" || args[0] === "list") emit([]);
			emit({ ok: true, fixture: true, cli: "vercel" });
			break;
		case "stripe":
			if (args[0] === "version") emit({ version: "fixture" });
			if (args[0] === "whoami") emit({ account_id: "acct_fixture", live_mode: false });
			emit({ object: "list", data: [], fixture: true });
			break;
		case "sentry-cli":
			if (args[0] === "info") textOut("Sentry Server: fixture.invalid\nDefault Organization: fixture-org\nDefault Project: fixture-project\nAuthentication Method: Auth Token");
			emit([]);
			break;
		case "railway":
			// Deterministic stress modes for the MCP adapter's suites: a large output, and a command that outlives its caller.
			if (args[0] === "fixture-large") textOut("row\n".repeat(Math.max(0, Number(args[1]) || 0)).trimEnd());
			if (args[0] === "fixture-sleep") {
				const ms = Math.max(0, Number(args[1]) || 0);
				setTimeout(() => emit({ ok: true, fixture: true, cli: "railway", slept: ms }), ms);
				break;
			}
			emit({ ok: true, fixture: true, cli: "railway" });
			break;
		case "tailscale":
			emit({ BackendState: "Running", TUN: true, MagicDNSSuffix: "fixture.ts.net", Self: { HostName: "fixture-host", Online: true }, Peer: {} });
			break;
		case "portal":
			if (args[0] === "cities") {
				process.stdout.write("CITY  SLUG\nSofia  sofia\n");
				process.exit(0);
			}
			emit({ ok: true, fixture: true, cli: "portal" });
			break;
		default:
			emit({ status: "success", ok: true, fixture: true, cli: name });
	}
}

main();
