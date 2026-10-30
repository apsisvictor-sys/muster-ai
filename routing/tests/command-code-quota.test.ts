import assert from "node:assert/strict";
import test from "node:test";
import {
	COMMAND_CODE_MONTHLY_MINUTES,
	commandCodeMonthlyWindow,
	parseCommandCodeCredits,
	parseCommandCodeUsageSummary,
} from "../command-code-quota.ts";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const RESET_MS = NOW + 2 * 3600_000;

/**
 * Recorded shape, values replaced by types:
 * plans/provider-accounts/facts-2026-10-16.md §2
 * (`GET https://api.commandcode.ai/alpha/billing/credits`, probe 2026-10-16).
 */
function body(fiveHour: unknown, weekly: unknown) {
	return {
		credits: {
			belowThreshold: false,
			creditThreshold: 5,
			monthlyCredits: 20,
			purchasedCredits: 0,
			freeCredits: 5,
		},
		windowLimits: { limited: true, exceeded: null, fiveHour, weekly },
		sandboxAccess: false,
		sandboxMinutes: { usedMinutes: 4, limitMinutes: 60, overageUsd: 0, resetAt: RESET_MS },
	};
}

test("computes each window's used share from its USD amounts", () => {
	const quota = parseCommandCodeCredits(
		body(
			{ used: 1.25, cap: 5, exceeded: false, resetAt: RESET_MS },
			{ used: 3, cap: 20, exceeded: false, resetAt: RESET_MS },
		),
		NOW,
	);

	assert.ok(quota);
	assert.equal(quota.primary.usedPercent, 25);
	assert.equal(quota.primary.windowMinutes, 300);
	assert.equal(quota.primary.resetsAt, Math.floor(RESET_MS / 1000));
	assert.equal(quota.secondary?.usedPercent, 15);
	assert.equal(quota.secondary?.windowMinutes, 10_080);
	assert.equal(quota.source, "command-code-usage");
	assert.equal(quota.capturedAt, NOW);
});

test("keeps an over-cap window at 100% and tolerates a missing weekly window", () => {
	const quota = parseCommandCodeCredits(body({ used: 7, cap: 5, exceeded: true, resetAt: RESET_MS }, null), NOW);

	assert.equal(quota?.primary.usedPercent, 100);
	assert.equal(quota?.secondary, null);
});

test("a changed shape yields null, never a wrong number", () => {
	assert.equal(parseCommandCodeCredits(null, NOW), null);
	assert.equal(parseCommandCodeCredits({}, NOW), null);
	assert.equal(parseCommandCodeCredits({ windowLimits: {} }, NOW), null);
	assert.equal(parseCommandCodeCredits({ windowLimits: { fiveHour: { used: 1 } } }, NOW), null);
	assert.equal(parseCommandCodeCredits({ windowLimits: { fiveHour: { used: 1, cap: 0, resetAt: RESET_MS } } }, NOW), null);
	assert.equal(parseCommandCodeCredits({ windowLimits: { fiveHour: { used: "x", cap: 5, resetAt: RESET_MS } } }, NOW), null);
});

/** The credit counters as the endpoint states them: `monthlyCredits` is the remaining monthly credit. */
function creditsBody(monthlyCredits: unknown) {
	return {
		credits: { belowThreshold: false, creditThreshold: 5, monthlyCredits, purchasedCredits: 0, freeCredits: 5 },
		windowLimits: {
			limited: true,
			exceeded: null,
			fiveHour: { used: 1.25, cap: 5, exceeded: false, resetAt: RESET_MS },
			weekly: { used: 3, cap: 20, exceeded: false, resetAt: RESET_MS },
		},
	};
}

test("keeps the remaining monthly credit and names the windows it stated (UB0 Revision 2b)", () => {
	const quota = parseCommandCodeCredits(creditsBody(12.0352), NOW);

	assert.equal(quota?.monthlyCredits, 12.0352);
	assert.deepEqual(quota?.windows.map((window) => [window.name, window.windowMinutes]), [["5-hour", 300], ["weekly", 10_080]]);
	assert.equal(parseCommandCodeCredits(creditsBody(undefined), NOW)?.monthlyCredits, null, "a body without the counter states none");
	assert.equal(parseCommandCodeCredits(creditsBody("x"), NOW)?.monthlyCredits, null, "a non-number is not a credit");
});

test("the used monthly credit comes from the usage summary, and a missing shape states nothing", () => {
	assert.equal(parseCommandCodeUsageSummary({ totalMonthlyCredits: 59.9648 }), 59.9648);
	assert.equal(parseCommandCodeUsageSummary({ data: { totalMonthlyCredits: 35.79 } }), 35.79);
	assert.equal(parseCommandCodeUsageSummary({}), null);
	assert.equal(parseCommandCodeUsageSummary(null), null);
	assert.equal(parseCommandCodeUsageSummary({ totalMonthlyCredits: -1 }), null);
});

test("the monthly window is used / (remaining + used), 30 days, resetting at the period end", () => {
	const periodEnd = Date.parse("2026-11-10T10:00:00Z");
	const window = commandCodeMonthlyWindow(12.0352, 59.9648, periodEnd);

	assert.ok(window);
	assert.equal(window.windowMinutes, COMMAND_CODE_MONTHLY_MINUTES);
	assert.equal(COMMAND_CODE_MONTHLY_MINUTES, 43_200);
	assert.ok(Math.abs(window.usedPercent - 83.3) < 0.05, `expected 83.3%, got ${window.usedPercent}`);
	assert.equal(window.resetsAt, Math.floor(periodEnd / 1000));
});

test("the monthly window fails closed when the two readings do not add to a round allowance", () => {
	const periodEnd = Date.parse("2026-11-10T10:00:00Z");

	assert.equal(commandCodeMonthlyWindow(12.5, 59.9648, periodEnd), null, "72.46 is not a plan's round monthly credit");
	assert.equal(commandCodeMonthlyWindow(null, 59.9648, periodEnd), null, "no remaining credit, no allowance");
	assert.equal(commandCodeMonthlyWindow(12.0352, null, periodEnd), null, "no used credit, no share");
	assert.equal(commandCodeMonthlyWindow(12.0352, 59.9648, null), null, "no period end, no reset and no window");
	assert.equal(commandCodeMonthlyWindow(0, 0, periodEnd), null, "an empty allowance is not divided by");
});
