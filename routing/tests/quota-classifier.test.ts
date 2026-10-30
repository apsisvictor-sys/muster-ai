import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyFailure, classifyQuota, type QuotaShape } from "../quota-classifier.ts";
import { harnessRoot } from "../../core/harness-paths.ts";
import { poolConfigPath } from "../provider-pool.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
type Sample = { provider: string; class: "quota" | "transient" | "cancel"; id: string; errorMessage: string; resetIso?: string; resetAfterMs?: number };
const samples = (JSON.parse(readFileSync(join(HERE, "fixtures", "quota-samples.json"), "utf8")) as { samples: Sample[] }).samples;
// The shipped default shapes are the single owner of provider wording (D-UQ4).
const shapes = (JSON.parse(readFileSync(poolConfigPath(), "utf8")) as { quotaShapes: QuotaShape[] }).quotaShapes;
const NOW = Date.parse("2026-10-05T00:00:00.000Z");

test("fixture holds the 45 distinct recorded samples", () => {
	assert.equal(samples.length, 45);
	assert.equal(new Set(samples.map((sample) => sample.id)).size, 45);
});

test("every recorded sample is classified through the shipped shapes: quota walls are quota, everything else is not", () => {
	for (const sample of samples) {
		const result = classifyQuota({ stopReason: "error", errorMessage: sample.errorMessage }, shapes, NOW);
		assert.equal(result.quota, sample.class === "quota", `${sample.id} (${sample.provider}) classified as quota=${result.quota}`);
	}
});

test("429 or rate_limit_error alone is not a quota signal", () => {
	const transient = samples.find((sample) => sample.id === "cc-429-transient")!;
	assert.match(transient.errorMessage, /429/);
	assert.match(transient.errorMessage, /rate_limit_error/);
	assert.equal(classifyQuota({ stopReason: "error", errorMessage: transient.errorMessage }, shapes, NOW).quota, false);
});

test("an aborted or successful message is never a quota wall, whatever its text says", () => {
	const wall = samples.find((sample) => sample.id === "zai-1308")!.errorMessage;
	assert.equal(classifyQuota({ stopReason: "aborted", errorMessage: wall }, shapes, NOW).quota, false);
	assert.equal(classifyQuota({ stopReason: "stop", errorMessage: wall }, shapes, NOW).quota, false);
	assert.equal(classifyQuota({ stopReason: "error" }, shapes, NOW).quota, false);
});

test("reset times are read per shape: UTC+8 for the zone-less z.ai text, explicit Z for ISO, relative to now for durations", () => {
	for (const sample of samples.filter((s) => s.resetIso || s.resetAfterMs)) {
		const result = classifyQuota({ stopReason: "error", errorMessage: sample.errorMessage }, shapes, NOW);
		assert.equal(result.quota, true, sample.id);
		const expected = sample.resetIso ? Date.parse(sample.resetIso) : NOW + sample.resetAfterMs!;
		assert.equal(result.quota && result.resetAt, expected, `${sample.id} reset`);
	}
});

test("a quota wall with no time in its text has no reset, so the cooldown applies", () => {
	for (const id of ["oc-usage", "oc-usage-wrapped", "cc-credits", "codex-token-plan-1week", "deepseek-insufficient-balance"]) {
		const result = classifyQuota({ stopReason: "error", errorMessage: samples.find((s) => s.id === id)!.errorMessage }, shapes, NOW);
		assert.equal(result.quota, true, id);
		assert.equal(result.quota && result.resetAt, undefined, id);
	}
});

test("the weekly/monthly z.ai zone is marked assumed, the 5-hour one is not", () => {
	const classify = (id: string) => classifyQuota({ stopReason: "error", errorMessage: samples.find((s) => s.id === id)!.errorMessage }, shapes, NOW);
	assert.equal((classify("zai-1310") as { assumed?: boolean }).assumed, true);
	assert.notEqual((classify("zai-1308") as { assumed?: boolean }).assumed, true);
});

test("a new provider's wording is a data edit: an unknown wall is not quota until a shape names it", () => {
	const unknown = { stopReason: "error", errorMessage: "402: {\"error\":\"monthly allowance spent, resets 2026-11-01T00:00:00Z\"}" };
	assert.equal(classifyQuota(unknown, shapes, NOW).quota, false);
	const added: QuotaShape[] = [...shapes, { id: "new-allowance", match: "monthly allowance spent", reset: { pattern: "resets (\\d{4}-\\d{2}-\\d{2}T[\\d:]+Z)", kind: "iso" } }];
	const result = classifyQuota(unknown, added, NOW);
	assert.equal(result.quota, true);
	assert.equal(result.quota && result.resetAt, Date.parse("2026-11-01T00:00:00Z"));
});

test("a malformed shape never throws and never matches", () => {
	const bad: QuotaShape[] = [{ id: "bad", match: "(" }];
	assert.equal(classifyQuota({ stopReason: "error", errorMessage: "(" }, bad, NOW).quota, false);
});

test("the classifier source names no provider or model", () => {
	const source = readFileSync(join(HARNESS_ROOT, "routing", "quota-classifier.ts"), "utf8");
	assert.doesNotMatch(source, /zai|z\.ai|opencode|command-code|openai|codex|glm|deepseek|luna|anthropic|claude/i);
});

test("ROUTERFAIL: a rejected credential, an expired key and capacity are read by status and code, not only by wording", () => {
	const classify = (errorMessage: string) => classifyFailure({ stopReason: "error", errorMessage }, shapes, NOW);
	// The two bodies Command Code answered tonight (Henry, 2026-10-29). Neither matches a shipped shape, so before this
	// reading neither was a wall: no failover, and the same dead ref was tried again.
	const invalidHeader = '401: {"message":"Invalid Authorization header","type":"authentication_error","code":"UNAUTHORIZED"}';
	const expiredKey = '401: {"message":"Your API key has expired. Log in again to get a new key: run `cmd login`, or create a new key in Command Code Studio.","type":"authentication_error","code":"UNAUTHORIZED"}';
	assert.equal(classifyQuota({ stopReason: "error", errorMessage: invalidHeader }, shapes, NOW).quota, false, "no shape words it: the status and the code are what say it");
	const auth = classify(invalidHeader);
	assert.equal(auth.wall, true);
	assert.equal(auth.failover, true);
	assert.equal(auth.kind, "auth");
	assert.equal(auth.status, 401);

	// The same wall with no status in front of it.
	const bare = classify("Your API key has expired");
	assert.equal(bare.wall, true);
	assert.equal(bare.kind, "expiry");
	assert.equal(bare.id, "expired-credential");
	assert.equal(classify(expiredKey).kind, "expiry", "the more precise reading wins over the status");

	// A plan that is not active is a wall too, in wording the pool has no shape for.
	const inactive = classify("Your subscription is inactive");
	assert.equal(inactive.wall, true);
	assert.equal(inactive.kind, "entitlement");

	// Capacity moves this request on and walls nothing, the recorded transient 429 included.
	const transient = samples.find((sample) => sample.id === "cc-429-transient")!;
	const capacity = classify(transient.errorMessage);
	assert.equal(capacity.failover, true);
	assert.equal(capacity.wall, false);
	assert.equal(capacity.kind, "capacity");
	assert.equal(capacity.status, 429);
	assert.equal(classify("503: service unavailable").kind, "capacity");
	assert.equal(classify("503: service unavailable").wall, false);

	// An endpoint that reports itself down is a wall: the pool words that as `endpoint-unavailable-429`, and the real
	// body arrives with 529 (routing/tests/fixtures/quota-samples.json, `oc-529`), so the wording has to carry it.
	const endpointDown = classify('529: {"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}');
	assert.equal(endpointDown.wall, true);
	assert.equal(endpointDown.failover, true);
	assert.equal(endpointDown.kind, "unavailable");
	assert.equal(endpointDown.status, 529);

	// A shipped shape is a wall and keeps the pool's own id: the wording stays the file's business.
	const invalid = classifyFailure({ stopReason: "error", errorMessage: '401: {"type":"error","error":{"type":"AuthError","message":"Invalid credential"}}' }, shapes, NOW, { "credential-rejected": "auth" });
	assert.equal(invalid.wall, true);
	assert.equal(invalid.id, "credential-rejected");
	assert.equal(invalid.kind, "auth");
	const fixtureShape: QuotaShape[] = [{ id: "wall", match: "QUOTA_WALL" }];
	assert.equal(classifyFailure({ stopReason: "error", errorMessage: "429: QUOTA_WALL" }, fixtureShape, NOW).kind, "usage", "an unnamed shape is a usage limit, as before");
	assert.equal(classifyFailure({ stopReason: "error", errorMessage: "429: QUOTA_WALL" }, fixtureShape, NOW, { wall: "auth" }).kind, "auth", "the caller may say what its own shape means");

	// Nothing readable is neither a wall nor a failover.
	const unknown = classify("ECONNREFUSED 127.0.0.1:443");
	assert.equal(unknown.wall, false);
	assert.equal(unknown.failover, false);
	assert.equal(unknown.kind, "none");
	assert.equal(classifyFailure({ stopReason: "stop", errorMessage: invalidHeader }, shapes, NOW).kind, "none", "a message that did not fail is read no further");
});
