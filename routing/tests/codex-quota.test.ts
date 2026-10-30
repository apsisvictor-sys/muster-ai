import assert from "node:assert/strict";
import test from "node:test";
import { parseRateLimitsObject, parseWhamResponse, selectQuota, type CodexQuota } from "../codex-quota.ts";

const NOW = Date.parse("2026-08-21T00:00:00Z");
const secondsFromNow = (hours: number) => Math.floor(NOW / 1000) + hours * 3600;

test("accepts the weekly-only Codex payload the backend now sends", () => {
	// Current shape: one 7-day window under `primary`, `secondary: null`.
	const quota = parseRateLimitsObject(
		{
			primary: { used_percent: 42, window_minutes: 10080, resets_at: secondsFromNow(150) },
			secondary: null,
			plan_type: "plus",
		},
		NOW,
		"pi-runtime",
		NOW,
	);

	assert.ok(quota);
	assert.equal(quota.planType, "plus");
	assert.equal(quota.primary, null);
	assert.deepEqual(quota.secondary, { usedPercent: 42, windowMinutes: 10080, resetsAt: secondsFromNow(150) });
});

test("keeps classifying a 5h window as primary when the backend sends both", () => {
	const quota = parseRateLimitsObject(
		{
			primary: { used_percent: 12, window_minutes: 300, resets_at: secondsFromNow(2) },
			secondary: { used_percent: 49, window_minutes: 10080, resets_at: secondsFromNow(100) },
		},
		NOW,
		"pi-runtime",
		NOW,
	);

	assert.ok(quota);
	assert.deepEqual(quota.primary, { usedPercent: 12, windowMinutes: 300, resetsAt: secondsFromNow(2) });
	assert.deepEqual(quota.secondary, { usedPercent: 49, windowMinutes: 10080, resetsAt: secondsFromNow(100) });
});

test("discards a snapshot whose window has already reset", () => {
	// Verbatim from ~/.codex/sessions/2026/07/25/rollout-…jsonl: 91% weekly,
	// resets_at 2026-07-28. Expired data is not a usable fallback.
	const expired = parseRateLimitsObject(
		{ primary: { used_percent: 91, window_minutes: 10080, resets_at: 1785258173 }, secondary: null },
		Date.parse("2026-07-25T16:09:08.708Z"),
		"codex-rollout",
		NOW,
	);

	assert.equal(expired, null);
});

test("parses the first-party WHAM window shape", () => {
	const quota = parseWhamResponse(
		{
			plan_type: "plus",
			rate_limit: {
				primary_window: { used_percent: 42, limit_window_seconds: 604800, reset_at: secondsFromNow(153) },
				secondary_window: null,
			},
		},
		NOW,
		NOW,
	);

	assert.ok(quota);
	assert.equal(quota.source, "codex-wham");
	assert.deepEqual(quota.secondary, { usedPercent: 42, windowMinutes: 10080, resetsAt: secondsFromNow(153) });
});

const snapshot = (capturedAt: number, source: CodexQuota["source"], usedPercent: number): CodexQuota => ({
	primary: null,
	secondary: { usedPercent, windowMinutes: 10080, resetsAt: secondsFromNow(100) },
	planType: "plus",
	capturedAt,
	source,
	ageMs: 0,
});

test("local snapshots are trusted only while they are recent", () => {
	const recent = snapshot(NOW - 10 * 60_000, "pi-runtime", 42);
	const ancient = snapshot(NOW - 26 * 24 * 3_600_000, "codex-rollout", 91);

	assert.equal(selectQuota(null, recent, NOW)?.secondary?.usedPercent, 42);
	assert.equal(selectQuota(null, ancient, NOW), null);
});

test("first-party data wins over any local snapshot", () => {
	const polled = snapshot(NOW - 4 * 60_000, "codex-wham", 42);
	const localNewerButLocal = snapshot(NOW - 60_000, "pi-runtime", 91);

	assert.equal(selectQuota(polled, localNewerButLocal, NOW)?.source, "codex-wham");
});
