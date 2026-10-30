import test from "node:test";
import assert from "node:assert/strict";

import {
	allOperations,
	clampControlTimeoutMs,
	deadlineArgs,
	executionControlArgs,
	explainFailure,
	formatCatalog,
	MAX_CONTROL_TIMEOUT_MS,
	normalizeExecutionControls,
	normalizeOperation,
	parseCatalog,
	planExecutionDeadline,
	suggestOperations,
	surveyControlArgs,
	translateRunAlternative,
	translateToolbeltHint,
	unknownOperationMessage,
	WRAPPER_GRACE_MS,
	type ProviderCatalog,
} from "../toolbelt-operations.ts";

// The real github and vercel catalogues, as reported by `pi-toolbelt discover`.
const github: ProviderCatalog = {
	safe: ["status", "repo", "repo-list", "prs", "pr", "pr-checks", "pr-diff", "pr-comments", "issues", "issue", "gist", "org", "orgs", "release"],
	mutating: ["pr-create", "pr-merge", "pr-close", "pr-reopen", "pr-edit", "pr-comment", "issue-create", "issue-reopen", "gist-create"],
	blocked: ["repo-delete", "release-delete", "gist-delete"],
};
const vercel: ProviderCatalog = {
	safe: ["status", "list-projects", "list-deployments", "inspect-deployment", "logs", "domains", "env-list", "teams"],
	mutating: [],
	blocked: [],
};

test("parseCatalog reads a discover payload", () => {
	const payload = {
		providers: [
			{ id: "vercel", safeOperations: ["status", "logs"], mutatingOperations: [], blockedOperations: [] },
			{ id: "github", safeOperations: ["repo"], mutatingOperations: ["pr-create"], blockedOperations: [] },
		],
	};
	assert.deepEqual(parseCatalog(payload, "github"), { safe: ["repo"], mutating: ["pr-create"], blocked: [] });
	assert.equal(parseCatalog(payload, "stripe"), undefined);
	assert.equal(parseCatalog(null, "github"), undefined);
});

test("parseCatalog reads the real discover envelope shape", () => {
	// `pi-toolbelt discover --json` returns the whole envelope, not a bare
	// providers array. The wrapper previously asked this envelope for a `stdout`
	// field, so the catalogue never loaded at all.
	const envelope = {
		ok: true,
		schemaVersion: 1,
		storage: "/home/operator/.pi/agent/toolbelt",
		providers: [{ id: "github", cli: "gh", safeOperations: ["repo", "prs"], mutatingOperations: ["pr-create"], blockedOperations: ["repo-delete"], notes: "x" }],
		commands: ["discover", "run"],
		catalog: { canonical: "PROVIDER_CATALOG" },
		valuesPrinted: false,
	};
	assert.deepEqual(parseCatalog(envelope, "github"), { safe: ["repo", "prs"], mutating: ["pr-create"], blocked: ["repo-delete"] });
	// No `stdout` field was ever present, which is why the old read returned undefined.
	assert.equal(parseCatalog(envelope, "stripe"), undefined);
});

test("mechanical variants normalise to the canonical name", () => {
	// Separator and case differences carry no meaning.
	assert.equal(normalizeOperation("pr_diff", github), "pr-diff");
	assert.equal(normalizeOperation("PR-Diff", github), "pr-diff");
	assert.equal(normalizeOperation("prcomments", github), "pr-comments");
	// Verb-noun reordering, both observed in the logs.
	assert.equal(normalizeOperation("deployments-list", vercel), "list-deployments");
	assert.equal(normalizeOperation("projects-list", vercel), "list-projects");
});

test("filler verbs are stripped to reach the canonical noun", () => {
	// Observed guesses: repo_view / repo-view / search-repos for `repo`.
	assert.equal(normalizeOperation("repo_view", github), "repo");
	assert.equal(normalizeOperation("view-repo", github), "repo");
	assert.equal(normalizeOperation("get-repo", github), "repo");
	assert.equal(normalizeOperation("list-repo", github), "repo-list");
});

test("normalisation refuses to guess at meaning", () => {
	// `pr-list` → `prs` is a semantic leap, not a mechanical one. Returning
	// undefined sends the caller to the catalogue instead of firing the wrong
	// operation at a live service.
	assert.equal(normalizeOperation("teleport", github), undefined);
	assert.equal(normalizeOperation("", github), undefined);
});

test("an exact name is returned unchanged, including mutating and blocked ones", () => {
	assert.equal(normalizeOperation("prs", github), "prs");
	assert.equal(normalizeOperation("pr-merge", github), "pr-merge");
	assert.equal(normalizeOperation("repo-delete", github), "repo-delete");
});

test("suggestions rank genuine near-misses first", () => {
	assert.equal(suggestOperations("pr_diff", github)[0], "pr-diff");
	assert.equal(suggestOperations("repoz", github)[0], "repo");
});

test("suggestions cannot bridge a vocabulary gap — the catalogue must", () => {
	// "pull request" and "prs" share no bigrams, so string similarity is
	// powerless here. This is the documented reason the full catalogue is
	// returned rather than suggestions alone; if this ever starts passing,
	// the suggester improved and the comment should be revisited.
	const suggestions = suggestOperations("list_pull_requests", github);
	assert.ok(!suggestions.includes("prs"), "similarity is not expected to find prs");
	assert.ok(unknownOperationMessage("github", "list_pull_requests", github).includes("prs"), "the catalogue must still carry the answer");
});

test("the unknown-operation error carries the whole catalogue", () => {
	const message = unknownOperationMessage("github", "list_pull_requests", github);
	assert.match(message, /unknown_operation/);
	// Every name is present, so one round trip is enough to recover.
	for (const operation of allOperations(github)) assert.ok(message.includes(operation), `missing ${operation}`);
	assert.match(message, /mutating \(ask before running\)/);
	assert.match(message, /policy-classified/);
	assert.match(message, /action:'run'/, "the legacy catalogue must point at the native passthrough path");
});

test("formatCatalog omits empty groups", () => {
	const text = formatCatalog("vercel", vercel);
	assert.match(text, /read-only: status list-projects/);
	assert.ok(!text.includes("mutating"), "vercel has no mutating operations to list");
});

test("formatCatalog no longer claims an approval flag", () => {
	// Regression: the label "mutating (needs confirmMutating)" named a gate the
	// CLI no longer has, so the model passed a flag that authorised nothing.
	const text = formatCatalog("github", github);
	assert.ok(!/confirmMutating/.test(text), text);
	assert.match(text, /mutating \(ask before running\)/);
});

test("execution controls are clamped to physical bounds only", () => {
	// No arbitrary short cap: a caller asking for 90s gets 90s, and a caller
	// asking for more than the platform can hold gets the platform bound.
	assert.equal(clampControlTimeoutMs(90_000), 90_000);
	assert.equal(clampControlTimeoutMs(1), 1);
	assert.equal(clampControlTimeoutMs("2500"), 2500);
	assert.equal(clampControlTimeoutMs(9_999_999_999), MAX_CONTROL_TIMEOUT_MS);
	assert.equal(clampControlTimeoutMs(0), undefined);
	assert.equal(clampControlTimeoutMs(-5), undefined);
	assert.equal(clampControlTimeoutMs(Number.NaN), undefined);
});

test("execution controls require absolute paths and a positive timeout", () => {
	const ok = normalizeExecutionControls({
		cwd: "/home/operator/repo",
		timeoutMs: 600_000,
		stdinFile: "/tmp/body.md",
		allowUnlisted: true,
	});
	assert.deepEqual(ok.issues, []);
	assert.deepEqual(ok.controls, { cwd: "/home/operator/repo", timeoutMs: 600_000, stdinFile: "/tmp/body.md", allowUnlisted: true });

	const bad = normalizeExecutionControls({ cwd: "repo", timeoutMs: 0, stdinFile: "/tmp/a\nb" });
	assert.equal(bad.controls.cwd, undefined);
	assert.equal(bad.controls.timeoutMs, undefined);
	assert.equal(bad.controls.stdinFile, undefined);
	assert.equal(bad.issues.length, 3);
	assert.match(bad.issues.join(" "), /cwd must be an absolute/);
	assert.match(bad.issues.join(" "), /timeoutMs must be a positive/);
	assert.match(bad.issues.join(" "), /single local file path/);
});

test("execution control flags are ordered before the provider argv", () => {
	assert.deepEqual(
		executionControlArgs({ cwd: "/repo", timeoutMs: 1000, stdinFile: "/tmp/in", allowUnlisted: true }),
		["--cwd", "/repo", "--timeout-ms", "1000", "--stdin-file", "/tmp/in", "--allow-unlisted"],
	);
	assert.deepEqual(surveyControlArgs({ fast: true, all: true }), ["--fast", "--all"]);
	assert.deepEqual(executionControlArgs({}), []);
	assert.deepEqual(surveyControlArgs({}), []);
	assert.deepEqual(normalizeExecutionControls({ fast: true, all: true }).controls, { fast: true, all: true });
	assert.deepEqual(normalizeExecutionControls({ fast: false, all: false }).controls, {});
});

test("the wrapper deadline outlives the CLI deadline by its grace", () => {
	const plan = planExecutionDeadline(300_000, 1_000);
	assert.ok(plan);
	assert.equal(plan.deadlineAt, 301_000);
	assert.equal(plan.wrapperTimeoutMs, 300_000 + WRAPPER_GRACE_MS);
	assert.ok(plan.wrapperTimeoutMs > plan.timeoutMs, "the wrapper must not SIGTERM in the same instant the CLI times out");
	assert.deepEqual(deadlineArgs(plan), ["--deadline-ms", "301000"]);
	assert.deepEqual(deadlineArgs(undefined), []);
	assert.equal(planExecutionDeadline(undefined, 1_000), undefined);
});

test("shell hints are translated into tool calls the model can make", () => {
	assert.equal(
		translateToolbeltHint('Run "pi-toolbelt menu supabase", or pass --allow-unlisted if the menu is out of date.'),
		'Run "{action:\'menu\', service:\'supabase\'}", or pass --allow-unlisted if the menu is out of date.',
	);
	assert.equal(translateToolbeltHint('pi-toolbelt providers'), "{action:'providers'}");
	assert.equal(translateToolbeltHint('pi-toolbelt find "deployment logs"'), "{action:'find', query:'deployment logs'}");
	assert.equal(translateToolbeltHint("pi-toolbelt menu <provider>"), "{action:'menu'}");
	// The git cwd rejection's secondary hint is a shell command too.
	assert.match(translateToolbeltHint("pi-toolbelt run git --cwd /path/to/repo -- status") ?? "", /^\{action:'run', service:'git'\}/);
	assert.equal(translateToolbeltHint(undefined), undefined);
});

test("a structured run alternative is translated into a run tool call with its argv intact", () => {
	// `call` refusals carry the CLI's exact `run` line; the argv after `--` must
	// become the `command` array, never the surrounding shell text.
	assert.equal(
		translateRunAlternative("pi-toolbelt run resend -- domains create --name example.com"),
		'{action:\'run\', service:\'resend\', command:["domains","create","--name","example.com"]}',
	);
	assert.equal(
		translateRunAlternative("pi-toolbelt run vercel -- env ls 'a b'"),
		'{action:\'run\', service:\'vercel\', command:["env","ls","a b"]}',
	);
	// Not a run alternative: the caller falls back to the generic hint translation.
	assert.equal(translateRunAlternative("No structured alias maps this operation."), undefined);
	assert.equal(translateRunAlternative(undefined), undefined);
});

test("explainFailure recovers the reason behind a bare adapter error", () => {
	// Shape of the real `vercel status` payload: the detail is one level down,
	// which is why the summary was the unactionable "fail vercel status error".
	const timedOut = { provider: "vercel", status: "error", data: { whoami: { command: "vercel", timedOut: true, timeoutMs: 30000 } } };
	assert.match(explainFailure(timedOut) ?? "", /whoami timed out after 30000ms/);

	const nonZero = { data: { version: { command: "vercel", exitCode: 1, stderr: "Error: not authenticated\n" } } };
	assert.match(explainFailure(nonZero) ?? "", /version exited 1: Error: not authenticated/);
});

test("explainFailure stays silent when everything succeeded", () => {
	assert.equal(explainFailure({ data: { whoami: { exitCode: 0, timedOut: false } } }), undefined);
	assert.equal(explainFailure(null), undefined);
	assert.equal(explainFailure("nope"), undefined);
});
