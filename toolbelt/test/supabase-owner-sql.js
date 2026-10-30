#!/usr/bin/env node
"use strict";

// Offline proof for the Supabase owner-SQL capability.
//
// `db-owner-sql` is the one Supabase operation that does not shell out to the
// CLI: it POSTs to the Management API's database/query endpoint, which runs SQL
// as the project owner. Everything here runs against a local HTTP fixture under
// a temp PI_TOOLBELT_HOME, so the test proves the request shape — method, path,
// JSON body, Authorization header — the approval gate and the destructive
// label without a Supabase endpoint, a real account or a real token.
//
// The credential is a fixture value, so even a regression that ignored
// SUPABASE_API_URL could not mutate anything live: it would 401.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const policyLib = require(path.join(__dirname, "..", "lib", "policy.js"));

const BIN = process.env.PI_TOOLBELT_BIN || path.join(os.homedir(), ".pi", "agent", "harness", "toolbelt", "bin", "pi-toolbelt");
const TOOLBELT_ROOT = path.join(__dirname, "..");
const OPERATION = "db-owner-sql";
const PROJECT_REF = "dzmkqppeasdfozddvtpk";
const PROFILE_ENV = "SUPABASE_ACCESS_TOKEN_PERSONAL_OPERATOR";
const PROFILE_TOKEN = "fixture-profile-token"; // never a real credential
const AMBIENT_TOKEN = "ambient-must-not-be-used";
const SQL = 'ALTER TABLE "AiActionRun" OWNER TO postgres;';
const FAILING_SQL = 'ALTER TABLE "AiActionRun" OWNER TO postgres; -- FAIL_ME';

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-toolbelt-owner-sql-"));
const binDir = path.join(root, "bin");
const dataDir = path.join(root, "data");
const cliLog = path.join(root, "cli-invocations.log");
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(cliLog, "");

// The fake CLI only has to answer the account identity probe (`orgs list`),
// which every Toolbelt mutation runs before executing. Anything else reaching
// the CLI means owner SQL was routed to the wrong adapter.
fs.writeFileSync(path.join(binDir, "supabase"), `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
if (!args.includes("--version")) fs.appendFileSync(${JSON.stringify(cliLog)}, JSON.stringify({ args }) + "\\n");
if (args.includes("--version")) { console.log("2.98.2"); process.exit(0); }
const words = [];
for (const arg of args) { if (arg.startsWith("-")) break; words.push(arg); }
const command = words.join(" ");
if (command === "orgs list") { console.log(JSON.stringify([{ id: "org-personal", name: "org-personal", slug: "org-personal" }])); process.exit(0); }
console.error("owner-sql test: the CLI must not be asked to run " + command);
process.exit(1);
`, { mode: 0o755 });

// Fail-closed provider binding: the only registered account is selected
// explicitly, so the profile token below is the one the request must carry.
fs.writeFileSync(path.join(dataDir, "accounts.json"), JSON.stringify({
	version: 1,
	accounts: {
		"supabase-personal": { provider: "supabase", profile: "personal-operator", expectedIdentity: ["org-personal"], enabled: true },
	},
	projects: {
		"operator-web": { supabase: "supabase-personal" },
	},
}, null, 2));

function cliInvocations() {
	return fs.readFileSync(cliLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).args.join(" "));
}

async function main() {
	const requests = [];
	const server = http.createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			let parsed = null;
			try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
			const authorization = request.headers.authorization || null;
			requests.push({
				method: request.method,
				url: request.url,
				authorizationPresent: typeof authorization === "string" && authorization.startsWith("Bearer "),
				authorization,
				contentType: request.headers["content-type"] || null,
				body: parsed,
			});
			response.setHeader("Content-Type", "application/json");
			if (parsed && typeof parsed.query === "string" && parsed.query.includes("FAIL_ME")) {
				response.statusCode = 400;
				response.end(JSON.stringify({ message: "relation \"AiActionRun\" does not exist" }));
				return;
			}
			response.end(JSON.stringify([{ table: "AiActionRun", owner: "postgres" }]));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const baseEnv = {
		...process.env,
		PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
		PI_TOOLBELT_HOME: root,
		PI_TOOLBELT_IDENTITY_TTL_MS: "0",
		SUPABASE_API_URL: `http://127.0.0.1:${server.address().port}`,
		[PROFILE_ENV]: PROFILE_TOKEN,
		SUPABASE_ACCESS_TOKEN: AMBIENT_TOKEN,
	};

	// NOTE: this must NOT be spawnSync. The HTTP fixture below lives in THIS
	// process, so a synchronous child that has to call it would deadlock — the
	// event loop cannot serve the request while spawnSync blocks it. Async spawn
	// keeps the fixture responsive and is what makes the request assertions real.
	async function callOwnerSql(options = {}) {
		const args = options.args || { projectRef: PROJECT_REF, query: SQL };
		const result = await new Promise((resolve) => {
			const child = spawn(BIN, [
				"call", "--provider", "supabase", "--operation", OPERATION,
				"--args", JSON.stringify(args),
				...(options.extra || []),
				"--json", "--agent", "owner-sql-test",
			], {
				encoding: "utf8",
				env: { ...baseEnv, ...(options.env || {}) },
			});
			let stdout = "";
			let stderr = "";
			const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
			child.stdout.on("data", (chunk) => { stdout += chunk; });
			child.stderr.on("data", (chunk) => { stderr += chunk; });
			child.on("close", (status, signal) => {
				clearTimeout(timer);
				resolve({ status, signal, stdout, stderr });
			});
		});
		let json = {};
		try {
			json = JSON.parse(result.stdout || "{}");
		} catch (error) {
			throw new Error(`invalid JSON for owner SQL: ${error.message}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
		}
		return { result, json };
	}

	const approval = { extra: ["--confirm-mutating", "--reason", "apply Prisma migration ownership fix"] };

	try {
		// --- destructive classification in the policy decision surface -----
		// Read through the real policy artifact, not the fixture home.
		const policy = policyLib.readPolicy(path.join(TOOLBELT_ROOT, "data"), "supabase");
		assert.equal(policyLib.classify(policy, [OPERATION]).class, "destructive", "owner SQL must classify as destructive");

		// --- discoverable through the catalog the model validates against --
		const discover = spawnSync(BIN, ["discover", "--provider", "supabase", "--json", "--agent", "owner-sql-test"], {
			encoding: "utf8",
			timeout: 30_000,
			env: baseEnv,
		});
		const catalog = JSON.parse(discover.stdout || "{}");
		assert.equal(catalog.ok, true, JSON.stringify(catalog));
		assert.equal(catalog.providers.length, 1);
		assert.equal(catalog.providers[0].mutatingOperations.includes(OPERATION), true, "db-owner-sql must be in the Supabase mutating catalog");

		// --- unapproved owner SQL never reaches the network ---------------
		let out = await callOwnerSql();
		assert.equal(out.json.status, "approval_required", JSON.stringify(out.json));
		assert.equal(out.json.policy.operationClass, "destructive");
		assert.equal(out.json.policy.mutating, true);
		assert.deepEqual(out.json.required, ["--confirm-mutating", "--reason <non-empty>"]);
		assert.equal(requests.length, 0, "an unapproved call must not reach any endpoint");

		// --- missing project ref fails closed -----------------------------
		out = await callOwnerSql({ args: { query: SQL }, extra: approval.extra });
		assert.equal(out.json.status, "missing_required_arg", JSON.stringify(out.json));
		assert.deepEqual(out.json.required, ["projectRef"]);
		assert.equal(requests.length, 0);

		// --- missing profile token fails closed, no ambient fallback ------
		// The account-identity gate runs BEFORE the owner-SQL credential check,
		// because a bound account must prove who it is before a destructive
		// operation is dispatched. With the profile token empty that probe cannot
		// authenticate, so the refusal surfaces as `supabase_account_not_authenticated`
		// rather than `missing_credential` (the latter is only reachable for an
		// UNBOUND account, where there is no identity to prove). Asserting the
		// identity refusal is the stronger claim: it proves no ambient token was
		// substituted and no request was sent.
		out = await callOwnerSql({ extra: approval.extra, env: { [PROFILE_ENV]: "" } });
		assert.match(out.json.status, /^(missing_credential|supabase_account_not_authenticated)$/, JSON.stringify(out.json));
		assert.equal(out.json.ok, false, JSON.stringify(out.json));
		assert.equal(out.json.policy.mutating, false, "a refused call must not be reported as a mutation");
		assert.equal(requests.length, 0, "a missing credential must not fall back to ambient auth");

		// --- approved owner SQL: exact request shape ----------------------
		out = await callOwnerSql(approval);
		assert.equal(out.json.ok, true, JSON.stringify(out.json));
		assert.equal(out.result.status, 0);
		assert.equal(out.json.adapter, "management_api");
		assert.equal(out.json.operation, OPERATION);
		assert.equal(out.json.policy.operationClass, "destructive", "the executed result must stay destructive");
		assert.equal(out.json.policy.mutating, true);
		assert.deepEqual(out.json.data, [{ table: "AiActionRun", owner: "postgres" }]);
		assert.equal(requests.length, 1, "exactly one request must be issued");
		assert.deepEqual(requests[0], {
			method: "POST",
			url: `/v1/projects/${PROJECT_REF}/database/query`,
			authorizationPresent: true,
			authorization: `Bearer ${PROFILE_TOKEN}`,
			contentType: "application/json",
			body: { query: SQL },
		});
		assert.equal(requests[0].authorization.includes(AMBIENT_TOKEN), false, "the ambient token must never be used");
		assert.equal(JSON.stringify(out.json).includes(SQL), false, "the SQL text must not be echoed back");

		// --- provider errors surface, and stay non-2xx ---------------------
		out = await callOwnerSql({ args: { projectRef: PROJECT_REF, query: FAILING_SQL }, extra: approval.extra });
		assert.equal(out.json.ok, false, JSON.stringify(out.json));
		assert.equal(out.json.cli.httpStatus, 400);
		assert.equal(out.json.status, "error");
		assert.match(JSON.stringify(out.json), /does not exist/);
		assert.equal(requests.length, 2);

		// --- the CLI is only ever probed for identity ----------------------
		const cliCalls = cliInvocations();
		assert.equal(cliCalls.length > 0, true, "the account identity probe must have run");
		assert.equal(cliCalls.every((command) => command.startsWith("orgs list")), true, `owner SQL must not shell out to the CLI: ${JSON.stringify(cliCalls)}`);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
	console.log("supabase owner-sql adapter ok");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
