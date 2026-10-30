"use strict";

// Media Hub provider adapter.
//
// The pi-media-hub CLI is the only publisher: it owns the local review store,
// the cloud upload and the credentials it reads from its own environment. This
// adapter builds that CLI's argv from structured arguments and returns the
// review's URL, so a caller (the gateway tool, Henry) never has to parse the
// CLI's text output.
//
// The provider is registered once, in bin/pi-toolbelt's PROVIDER_CATALOG; this
// module only carries the descriptor and the `call` adapter. The spawner and
// the envelope builders are injected by the bin, so a test drives the adapter
// with a fake spawner and never publishes anything.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROVIDER = {
	id: "media-hub",
	kind: "official_cli_adapter",
	status: "implemented_if_cli_available",
	cli: "pi-media-hub",
	safeOperations: ["versions", "list", "feedback", "uploads", "events"],
	mutatingOperations: ["create", "update", "share", "rollback", "unshare", "set-password"],
	verifyCommand: "pi-media-hub --help",
	notes: "Wraps the pi-media-hub CLI, which is the only publisher: create/update take files (or html text), a title and an optional base id, and answer with the review's URL in `data.url`; share mints the review's unlisted capability URL; versions lists local revisions before an update or rollback. Toolbelt itself never uploads and never reads or stores Media Hub credentials — the CLI reads its own environment. Everything else the CLI supports (rollback, unshare, list, feedback, uploads, events, set-password) is reachable with `run media-hub -- <command>`.",
};

// What the `call` adapter answers. The rest of the CLI stays reachable through
// `run media-hub -- ...`, so nothing is hidden by a narrower adapter.
const OPERATIONS = ["create", "update", "versions", "share"];
const MUTATING = new Set(["create", "update", "share"]);

function asList(value) {
	const list = Array.isArray(value) ? value : [value];
	return list.map((item) => (item === undefined || item === null ? "" : String(item).trim())).filter(Boolean);
}

function firstString(args, names) {
	for (const name of names) {
		const value = args[name];
		if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
	}
	return null;
}

function addFlag(cliArgs, args, names, flag) {
	const value = firstString(args, names);
	if (value) cliArgs.push(flag, value);
	return value;
}

function truthy(value) {
	return value === true || value === "true" || value === 1;
}

// `html` is text, not a path. The CLI takes files only, so the text is written
// to a temporary .html file for the duration of the run and removed afterwards.
function writeHtmlFile(html) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-toolbelt-media-hub-"));
	const file = path.join(dir, "review.html");
	fs.writeFileSync(file, html, { mode: 0o600 });
	return { file, dir };
}

function buildCreateArgs(args) {
	const cliArgs = ["create"];
	const title = addFlag(cliArgs, args, ["title"], "--title");
	if (!title) return { error: { status: "missing_required_arg", required: ["title"] } };
	addFlag(cliArgs, args, ["context"], "--context");
	// A base id names an existing review to publish into, so the same URL is
	// reused instead of a duplicate session: the CLI's own --slug with
	// --update-if-exists.
	const base = firstString(args, ["base", "baseId", "base_id"]);
	const slug = firstString(args, ["slug"]);
	if (base) cliArgs.push("--slug", base, "--update-if-exists");
	else if (slug) cliArgs.push("--slug", slug);
	if (truthy(args.updateIfExists) || truthy(args.update_if_exists)) cliArgs.push("--update-if-exists");
	if (truthy(args.cloud)) cliArgs.push("--cloud");
	return { cliArgs };
}

function buildUpdateArgs(args) {
	const reviewId = firstString(args, ["slug", "base", "baseId", "base_id", "id"]);
	if (!reviewId) return { error: { status: "missing_required_arg", required: ["slug|base"] } };
	const cliArgs = ["update", reviewId];
	addFlag(cliArgs, args, ["title"], "--title");
	addFlag(cliArgs, args, ["context"], "--context");
	addFlag(cliArgs, args, ["note"], "--note");
	const mode = firstString(args, ["mode"]);
	if (mode) cliArgs.push("--mode", mode);
	if (truthy(args.cloud)) cliArgs.push("--cloud");
	return { cliArgs, reviewId };
}

// The CLI takes the review id as its one positional argument.
function buildReadArgs(operation, args) {
	const reviewId = firstString(args, ["slug", "base", "baseId", "base_id", "id"]);
	if (!reviewId) return { error: { status: "missing_required_arg", required: ["slug|base"] } };
	return { cliArgs: [operation, reviewId], reviewId };
}

function callMediaHub(operation, args = {}, deps) {
	const op = String(operation || "").trim();
	if (!OPERATIONS.includes(op)) return deps.unsupported("media-hub", op, OPERATIONS);
	const cli = process.env.MEDIA_HUB_CLI_PATH || "pi-media-hub";
	if (!deps.exists(cli)) return deps.unavailable("media-hub", cli, op);

	const dryRun = truthy(args.dryRun) || truthy(args.dry_run) || Boolean(deps.parsed && deps.parsed.opts["dry-run"] === true);
	const mutating = MUTATING.has(op);
	const resourceType = op === "versions" ? "media_hub_versions" : "media_hub_review";
	const fields = {
		adapter: "official_cli",
		operationClass: mutating ? "external_write" : "read_only",
		mutating,
	};

	let temp = null;
	let cliArgs;
	if (op === "create" || op === "update") {
		const built = op === "create" ? buildCreateArgs(args) : buildUpdateArgs(args);
		if (built.error) return deps.error("media-hub", op, built.error.status, { required: built.error.required });
		const files = asList([args.files, args.file, args.path]);
		const html = args.html === undefined || args.html === null ? "" : String(args.html);
		if (files.length === 0 && !html.trim()) {
			return deps.error("media-hub", op, "missing_required_arg", { required: ["files|html"] });
		}
		if (html.trim()) {
			temp = writeHtmlFile(html);
			files.push(temp.file);
		}
		cliArgs = built.cliArgs;
		cliArgs.push("--json");
		// --cloud-dry-run validates payload generation without a network call,
		// which is the only dry run this CLI offers for a publish.
		if (dryRun) cliArgs.push("--cloud-dry-run");
		cliArgs.push(...files);
	} else {
		const built = buildReadArgs(op, args);
		if (built.error) return deps.error("media-hub", op, built.error.status, { required: built.error.required });
		cliArgs = built.cliArgs;
		cliArgs.push("--json");
	}

	let result;
	try {
		result = deps.spawn(cli, cliArgs, { timeout: op === "versions" ? 30_000 : 300_000 });
	} finally {
		if (temp) fs.rmSync(temp.dir, { recursive: true, force: true });
	}

	const payload = result && typeof result.json === "object" && !Array.isArray(result.json) ? result.json : null;
	if (payload && payload.ok === false) {
		return deps.error("media-hub", op, "provider_error", {
			...fields,
			resourceType,
			data: payload,
			cli: result,
			url: payload.url || null,
			message: payload.error || "pi-media-hub reported a failure; nothing was published.",
		});
	}
	const envelope = deps.result("media-hub", op, resourceType, result, fields);
	if (dryRun) envelope.dryRun = true;
	// The URL is the one thing a caller needs from a publish, so it travels at
	// the top level as well as inside the CLI's own payload.
	if (payload && payload.url) envelope.url = payload.url;
	return envelope;
}

module.exports = { PROVIDER, OPERATIONS, callMediaHub };
