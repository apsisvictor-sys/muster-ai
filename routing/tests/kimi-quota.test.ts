import assert from "node:assert/strict";
import test from "node:test";
import { parseKimiQuota } from "../kimi-quota.ts";

test("parses Kimi Coding 300-minute and weekly subscription windows", () => {
	const quota = parseKimiQuota({
		user: { membership: { level: "LEVEL_BASIC" } },
		usage: { limit: "100", used: "1", resetTime: "2026-07-29T12:00:00Z" },
		limits: [{
			window: { duration: "300", timeUnit: "TIME_UNIT_MINUTE" },
			detail: { limit: "100", used: "6", resetTime: "2026-07-22T17:00:00Z" },
		}],
	}, Date.parse("2026-07-22T12:00:00Z"));

	assert.ok(quota);
	assert.equal(quota.planType, "LEVEL_BASIC");
	assert.deepEqual(quota.primary, { usedPercent: 6, windowMinutes: 300, resetsAt: 1784739600 });
	assert.deepEqual(quota.secondary, { usedPercent: 1, windowMinutes: 10080, resetsAt: 1785326400 });
});

test("rejects malformed Kimi Coding quota payloads", () => {
	assert.equal(parseKimiQuota({ usage: { limit: "0", used: "1" } }), null);
});
