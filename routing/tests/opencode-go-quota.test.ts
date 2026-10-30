import assert from "node:assert/strict";
import test from "node:test";
import { parseOpenCodeGoUsage } from "../opencode-go-quota.ts";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const RESETS = new Date(NOW + 3 * 3600_000).toISOString();

/** Recorded shape, values replaced by types (probe 2026-10-16, facts §6). */
const meter = (percent: unknown, resetsAt: unknown = RESETS, status = "ok") => ({ status, percent, resetsAt });

test("reads the rolling and weekly meters the endpoint reports", () => {
	const quota = parseOpenCodeGoUsage(
		{ usage: { rolling: meter(12.5), weekly: meter(48), monthly: meter(3) } },
		NOW,
	);

	assert.ok(quota);
	assert.equal(quota.primary.usedPercent, 12.5);
	assert.equal(quota.primary.windowMinutes, 300);
	assert.equal(quota.primary.resetsAt, Math.floor((NOW + 3 * 3600_000) / 1000));
	assert.equal(quota.secondary?.usedPercent, 48);
	assert.equal(quota.secondary?.windowMinutes, 10_080);
	assert.equal(quota.source, "opencode-go-usage");
	assert.equal(quota.capturedAt, NOW);
});

test("a meter without a usable reset string still reports its share", () => {
	const quota = parseOpenCodeGoUsage(
		{ usage: { rolling: { status: "exceeded", percent: 100 }, weekly: null } },
		NOW,
	);

	assert.equal(quota?.primary.usedPercent, 100);
	assert.equal(quota?.primary.resetsAt, 0);
	assert.equal(quota?.secondary, null);
});

test("a changed shape yields null, never a wrong number", () => {
	assert.equal(parseOpenCodeGoUsage(null, NOW), null);
	assert.equal(parseOpenCodeGoUsage({}, NOW), null);
	assert.equal(parseOpenCodeGoUsage({ usage: {} }, NOW), null);
	assert.equal(parseOpenCodeGoUsage({ usage: { rolling: { status: "ok" } } }, NOW), null);
	assert.equal(parseOpenCodeGoUsage({ usage: { rolling: { status: "ok", percent: "x" } } }, NOW), null);
});
