#!/usr/bin/env node
"use strict";

// Media Hub provider tests.
//
// Two layers, neither of which can publish anything:
//   1. the adapter, driven with an injected spawner, so its argv and the URL it
//      returns are asserted without starting a process at all;
//   2. the real toolbelt binary, with a fake `pi-media-hub` on PATH and a temp
//      PI_TOOLBELT_HOME, so the provider list and the `call` wiring are proven
//      end to end without reaching Media Hub.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const mediaHub = require("../lib/media-hub.js");

const TOOLBELT_ROOT = path.join(__dirname, "..");
const DATA = path.join(TOOLBELT_ROOT, "data");
const BIN = process.env.PI_TOOLBELT_BIN || path.join(TOOLBELT_ROOT, "bin", "pi-toolbelt");
const REVIEW_URL = "https://media.example/s/unlisted-token";

// Stands in for the bin's envelope builders and spawner. The spawner records
// every call instead of running one.
function fakeDeps(options = {}) {
	const spawned = [];
	const deps = {
		parsed: options.parsed || { opts: {} },
		exists: () => options.installed !== false,
		spawn: (command, argv, spawnOptions) => {
			const record = { command, argv, options: spawnOptions };
			if (options.onSpawn) options.onSpawn(record);
			spawned.push(record);
			if (options.spawnResult) return options.spawnResult;
			return {
				command,
				argv,
				ok: true,
				exitCode: 0,
				jsonParsed: true,
				json: { ok: true, url: REVIEW_URL, reviewSlug: "demo-review" },
				stdout: "",
				stderr: "",
			};
		},
		result: (provider, operation, resourceType, result, fields) => ({
			ok: Boolean(result.ok),
			provider,
			operation,
			resourceType,
			status: result.ok ? "success" : "error",
			data: result.json ?? null,
			...fields,
		}),
		error: (provider, operation, status, fields = {}) => ({ ok: false, provider, operation, status, ...fields }),
		unavailable: (provider, operation) => ({ ok: false, provider, operation, status: "unavailable" }),
		unsupported: (provider, operation) => ({ ok: false, provider, operation, status: "unsupported_operation" }),
	};
	return { deps, spawned };
}

test("the provider is registered under the CLI it wraps", () => {
	assert.equal(mediaHub.PROVIDER.id, "media-hub");
	assert.equal(mediaHub.PROVIDER.cli, "pi-media-hub");
	for (const operation of ["create", "update", "versions", "share"]) {
		assert.equal(mediaHub.OPERATIONS.includes(operation), true, `${operation} is served by the adapter`);
	}
});

test("create passes the title, files and context and returns the review URL", () => {
	const { deps, spawned } = fakeDeps();
	const out = mediaHub.callMediaHub("create", { title: "Weekly report", files: ["/tmp/review.md"], context: "Sprint 12" }, deps);
	assert.equal(spawned.length, 1);
	assert.equal(spawned[0].command, "pi-media-hub");
	assert.deepEqual(spawned[0].argv, ["create", "--title", "Weekly report", "--context", "Sprint 12", "--json", "/tmp/review.md"]);
	assert.equal(out.ok, true);
	assert.equal(out.url, REVIEW_URL);
	assert.equal(out.data.url, REVIEW_URL);
	assert.equal(out.operationClass, "external_write");
	assert.equal(out.mutating, true);
});

test("create accepts a base id and reuses that review instead of duplicating it", () => {
	const { deps, spawned } = fakeDeps();
	const out = mediaHub.callMediaHub("create", { title: "Weekly report", files: "/tmp/review.md", base: "media-1234" }, deps);
	assert.deepEqual(spawned[0].argv, ["create", "--title", "Weekly report", "--slug", "media-1234", "--update-if-exists", "--json", "/tmp/review.md"]);
	assert.equal(out.url, REVIEW_URL);
});

test("html text becomes a file for the run and is removed afterwards", () => {
	let seen = null;
	const { deps, spawned } = fakeDeps({
		onSpawn: (record) => {
			const file = record.argv[record.argv.length - 1];
			seen = { file, body: fs.readFileSync(file, "utf8") };
		},
	});
	const out = mediaHub.callMediaHub("create", { title: "Inline", html: "<h1>Lane report</h1>" }, deps);
	assert.equal(seen.body, "<h1>Lane report</h1>");
	assert.equal(seen.file.endsWith("review.html"), true);
	assert.equal(fs.existsSync(seen.file), false, "the temp file does not outlive the run");
	assert.equal(out.url, REVIEW_URL);
});

test("dry run asks the CLI to validate the payload without a network call", () => {
	const { deps, spawned } = fakeDeps();
	const out = mediaHub.callMediaHub("create", { title: "Preview", files: ["/tmp/review.md"], dryRun: true }, deps);
	assert.deepEqual(spawned[0].argv, ["create", "--title", "Preview", "--json", "--cloud-dry-run", "/tmp/review.md"]);
	assert.equal(out.dryRun, true);
});

test("update names the review and the mode", () => {
	const { deps, spawned } = fakeDeps();
	mediaHub.callMediaHub("update", { base: "media-1234", files: ["/tmp/v2.png"], mode: "append", note: "v2" }, deps);
	assert.deepEqual(spawned[0].argv, ["update", "media-1234", "--note", "v2", "--mode", "append", "--json", "/tmp/v2.png"]);
});

test("versions is a read and share is a write", () => {
	const versions = fakeDeps();
	const listed = mediaHub.callMediaHub("versions", { slug: "demo-review" }, versions.deps);
	assert.deepEqual(versions.spawned[0].argv, ["versions", "demo-review", "--json"]);
	assert.equal(listed.operationClass, "read_only");
	assert.equal(listed.mutating, false);

	const share = fakeDeps();
	const shared = mediaHub.callMediaHub("share", { slug: "demo-review" }, share.deps);
	assert.deepEqual(share.spawned[0].argv, ["share", "demo-review", "--json"]);
	assert.equal(shared.operationClass, "external_write");
	assert.equal(shared.mutating, true);
});

test("a missing title, file or review id is reported without running the CLI", () => {
	for (const [operation, args, required] of [
		["create", { files: ["/tmp/review.md"] }, "create title"],
		["create", { title: "No content" }, "create content"],
		["update", { files: ["/tmp/review.md"] }, "update review id"],
		["versions", {}, "versions review id"],
	]) {
		const { deps, spawned } = fakeDeps();
		const out = mediaHub.callMediaHub(operation, args, deps);
		assert.equal(out.status, "missing_required_arg", `${required} is required`);
		assert.equal(spawned.length, 0, `${required}: the CLI is not started`);
	}
});

test("an operation the adapter does not curate is refused, not guessed", () => {
	const { deps, spawned } = fakeDeps();
	const out = mediaHub.callMediaHub("rollback", { slug: "demo-review" }, deps);
	assert.equal(out.status, "unsupported_operation");
	assert.equal(spawned.length, 0);
});

test("an uninstalled CLI is unavailable, and a failed publish keeps the CLI's reason", () => {
	const missing = fakeDeps({ installed: false });
	assert.equal(mediaHub.callMediaHub("versions", { slug: "demo-review" }, missing.deps).status, "unavailable");
	assert.equal(missing.spawned.length, 0);

	const failed = fakeDeps({
		spawnResult: { ok: false, exitCode: 1, jsonParsed: true, json: { ok: false, error: "cloud upload failed", url: "http://local/review/demo" }, stdout: "", stderr: "" },
	});
	const out = mediaHub.callMediaHub("create", { title: "Weekly report", files: ["/tmp/review.md"] }, failed.deps);
	assert.equal(out.ok, false);
	assert.equal(out.status, "provider_error");
	assert.equal(out.url, "http://local/review/demo");
	assert.equal(out.data.error, "cloud upload failed");
});

test("the toolbelt binary lists media-hub and runs a create through the CLI", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-toolbelt-media-hub-"));
	try {
		const binDir = path.join(root, "bin");
		const home = path.join(root, "toolbelt");
		const audit = path.join(root, "invocations.jsonl");
		fs.mkdirSync(binDir, { recursive: true });
		fs.mkdirSync(path.join(home, "data"), { recursive: true });
		// This checkout's own catalogs: the fixture home never rewrites the repo's.
		fs.cpSync(path.join(DATA, "policy"), path.join(home, "data", "policy"), { recursive: true });
		fs.copyFileSync(path.join(DATA, "providers.json"), path.join(home, "data", "providers.json"));

		fs.writeFileSync(
			path.join(binDir, "pi-media-hub"),
			`#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(audit)}, JSON.stringify({ args }) + "\\n");
console.log(JSON.stringify({ ok: true, url: ${JSON.stringify(REVIEW_URL)}, reviewSlug: "demo-review", manifest: {} }));
`,
			{ mode: 0o755 },
		);

		const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, PI_TOOLBELT_HOME: home };
		for (const name of ["PI_MEDIA_API_TOKEN", "PI_MEDIA_API_BASE", "PI_MEDIA_CLOUD_DRY_RUN", "MEDIA_HUB_CLI_PATH"]) delete env[name];
		const run = (args) => {
			const result = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env });
			assert.equal(result.status, 0, `pi-toolbelt ${args.join(" ")} failed: ${result.stderr}`);
			return JSON.parse(result.stdout);
		};

		const providers = run(["providers", "--json"]);
		const row = providers.providers.find((item) => item.id === "media-hub");
		assert.ok(row, "media-hub appears in the provider list");
		assert.equal(row.cli, "pi-media-hub");
		assert.equal(row.installed, true);

		const out = run(["call", "media-hub", "create", "--args", JSON.stringify({ title: "Lane report", files: ["/tmp/lane-report.md"] }), "--dry-run", "--json"]);
		assert.equal(out.ok, true, `create failed: ${JSON.stringify(out)}`);
		assert.equal(out.url, REVIEW_URL);
		assert.equal(out.data.url, REVIEW_URL);
		assert.equal(out.dryRun, true);

		const calls = fs.readFileSync(audit, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(calls[calls.length - 1].args, ["create", "--title", "Lane report", "--json", "--cloud-dry-run", "/tmp/lane-report.md"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
