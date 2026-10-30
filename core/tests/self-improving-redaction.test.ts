import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { redactSensitiveData, redactSensitiveText, scrubImprovementJsonlFiles } from "../self-improving-redactor.ts";

const REDACTED = "[REDACTED]";

test("redacts bearer tokens", () => {
	assert.equal(redactSensitiveText("Authorization: Bearer abc.def-123_xyz"), `Authorization: Bearer ${REDACTED}`);
});

test("redacts API-key assignments with common separators and quoted whitespace", () => {
	assert.equal(redactSensitiveText("api_key=sample-secret-value"), `api_key=${REDACTED}`);
	assert.equal(redactSensitiveText("API-KEY: 'sample secret value'"), `API-KEY: ${REDACTED}`);
	assert.equal(redactSensitiveText('access_token="sample token value"'), `access_token=${REDACTED}`);
});

test("redacts quoted bearer tokens", () => {
	assert.equal(redactSensitiveText('Authorization: Bearer "sample token value"'), `Authorization: Bearer ${REDACTED}`);
});

test("redacts password assignments", () => {
	assert.equal(redactSensitiveText("password=hunter-example"), `password=${REDACTED}`);
	assert.equal(redactSensitiveText('passwd: "hunter-example"'), `passwd: ${REDACTED}`);
});

test("redacts standalone provider, OAuth/JWT, cloud tokens, and email addresses", () => {
	const samples = [
		`ghp_${"a".repeat(36)}`,
		`github_pat_${"b".repeat(24)}`,
		`sk-${"c".repeat(32)}`,
		`sk-ant-${"d".repeat(24)}`,
		`ya29.${"e".repeat(24)}`,
		`eyJ${"f".repeat(8)}.${"g".repeat(12)}.${"h".repeat(12)}`,
		`AKIA${"J".repeat(16)}`,
		"operator@example.test",
		"/home/operator/.pi/agent/sessions/private.jsonl",
		"account_id=123456789012",
	];
	const safe = redactSensitiveText(samples.join(" "));
	for (const sample of samples) assert.equal(safe.includes(sample), false);
});

test("redacts complete private-key blocks", () => {
	const input = [
		"before",
		"-----BEGIN PRIVATE KEY-----",
		"example-key-material",
		"-----END PRIVATE KEY-----",
		"after",
	].join("\n");
	assert.equal(redactSensitiveText(input), `before\n${REDACTED}\nafter`);
});

test("redacts URI userinfo while preserving ordinary URLs and text", () => {
	assert.equal(
		redactSensitiveText("database is postgresql://user:pass@example.test:5432/app"),
		`database is postgresql://${REDACTED}@example.test:5432/app`,
	);
	const ordinary = "See https://example.test/docs/@scope and the public documentation.";
	assert.equal(redactSensitiveText(ordinary), ordinary);
});

test("preserves aggregate metrics and recursively redacts nested session fields and configured keys", () => {
	const ordinary = "Build passed: 12 tests in 3.4 seconds.";
	assert.equal(redactSensitiveText(ordinary), ordinary);
	const reportPayload = redactSensitiveData({
		metrics: { totalRuns: 12, failedRuns: 2, costByModel: { modelA: 1.25 } },
		session: { sessionId: "session-private", prompt: "private request", nested: [`Bearer sample-token`] },
		customInternal: { value: "private metadata" },
	}, { denylistedKeys: ["customInternal"] });
	assert.deepEqual(reportPayload, {
		metrics: { totalRuns: 12, failedRuns: 2, costByModel: { modelA: 1.25 } },
		session: { sessionId: REDACTED, prompt: REDACTED, nested: [`Bearer ${REDACTED}`] },
		customInternal: REDACTED,
	});
});

test("scrubs JSONL atomically and idempotently", () => {
	const directory = mkdtempSync(join(tmpdir(), "self-improving-redaction-"));
	const path = join(directory, "patterns.jsonl");
	writeFileSync(path, [
		JSON.stringify({ context: 'password="two words"' }),
		JSON.stringify({ error: "postgresql://user:pass@example.test/app" }),
		JSON.stringify({ context: "ordinary https://example.test/docs" }),
	].join("\n") + "\n", "utf8");

	assert.deepEqual(scrubImprovementJsonlFiles(directory), {
		filesScanned: 1,
		filesChanged: 1,
		recordsChanged: 2,
		recordsMalformed: 0,
		recordsSkipped: 0,
	});
	const once = readFileSync(path, "utf8");
	for (const line of once.trim().split("\n")) JSON.parse(line);
	assert.equal(once.includes("two words"), false);
	assert.equal(once.includes("user:pass"), false);
	assert.deepEqual(scrubImprovementJsonlFiles(directory), {
		filesScanned: 1,
		filesChanged: 0,
		recordsChanged: 0,
		recordsMalformed: 0,
		recordsSkipped: 0,
	});
	assert.equal(readFileSync(path, "utf8"), once);
});

test("redacts malformed JSON text and remains idempotent", () => {
	const directory = mkdtempSync(join(tmpdir(), "self-improving-redaction-broken-json-"));
	const path = join(directory, "patterns.jsonl");
	writeFileSync(path, '{"context":"password=malformed-example"\n', "utf8");

	assert.deepEqual(scrubImprovementJsonlFiles(directory), {
		filesScanned: 1,
		filesChanged: 1,
		recordsChanged: 1,
		recordsMalformed: 1,
		recordsSkipped: 1,
	});
	const once = readFileSync(path);
	assert.equal(once.includes(Buffer.from("malformed-example")), false);
	assert.equal(once.includes(Buffer.from(`password=${REDACTED}`)), true);
	assert.deepEqual(scrubImprovementJsonlFiles(directory), {
		filesScanned: 1,
		filesChanged: 0,
		recordsChanged: 0,
		recordsMalformed: 1,
		recordsSkipped: 1,
	});
	assert.deepEqual(readFileSync(path), once);
});

test("redacts secrets in invalid UTF-8 while preserving unrelated invalid bytes and order", () => {
	const directory = mkdtempSync(join(tmpdir(), "self-improving-redaction-invalid-utf8-"));
	const path = join(directory, "patterns.jsonl");
	const before = Buffer.from([0xff, 0xfe]);
	const after = Buffer.from([0x80, 0xc0]);
	writeFileSync(path, Buffer.concat([
		before,
		Buffer.from(' {"context":"password=invalid-utf8-example"} '),
		after,
		Buffer.from("\n"),
	]));

	assert.deepEqual(scrubImprovementJsonlFiles(directory), {
		filesScanned: 1,
		filesChanged: 1,
		recordsChanged: 1,
		recordsMalformed: 1,
		recordsSkipped: 1,
	});
	const once = readFileSync(path);
	assert.deepEqual(once.subarray(0, before.length), before);
	assert.deepEqual(once.subarray(once.length - after.length - 1, once.length - 1), after);
	assert.equal(once.includes(Buffer.from("invalid-utf8-example")), false);
	assert.equal(once.includes(Buffer.from(`password=${REDACTED}`)), true);
	assert.deepEqual(scrubImprovementJsonlFiles(directory), {
		filesScanned: 1,
		filesChanged: 0,
		recordsChanged: 0,
		recordsMalformed: 1,
		recordsSkipped: 1,
	});
	assert.deepEqual(readFileSync(path), once);
});

test("preserves malformed JSONL bytes and continues scrubbing later records", () => {
	const directory = mkdtempSync(join(tmpdir(), "self-improving-redaction-malformed-"));
	const path = join(directory, "patterns.jsonl");
	const malformed = Buffer.from([0x7b, 0xff, 0x7d]);
	writeFileSync(path, Buffer.concat([
		Buffer.from(`${JSON.stringify({ context: "password=first-example" })}\n`),
		malformed,
		Buffer.from(`\n${JSON.stringify({ context: "Bearer second-example" })}\n`),
	]));

	assert.deepEqual(scrubImprovementJsonlFiles(directory), {
		filesScanned: 1,
		filesChanged: 1,
		recordsChanged: 2,
		recordsMalformed: 1,
		recordsSkipped: 1,
	});
	const once = readFileSync(path);
	const lines = once.subarray(0, once.length - 1).toString("binary").split("\n");
	assert.doesNotThrow(() => JSON.parse(Buffer.from(lines[0]!, "binary").toString("utf8")));
	assert.deepEqual(Buffer.from(lines[1]!, "binary"), malformed);
	assert.doesNotThrow(() => JSON.parse(Buffer.from(lines[2]!, "binary").toString("utf8")));
	assert.equal(once.includes(Buffer.from("first-example")), false);
	assert.equal(once.includes(Buffer.from("second-example")), false);

	assert.deepEqual(scrubImprovementJsonlFiles(directory), {
		filesScanned: 1,
		filesChanged: 0,
		recordsChanged: 0,
		recordsMalformed: 1,
		recordsSkipped: 1,
	});
	assert.deepEqual(readFileSync(path), once);
});
