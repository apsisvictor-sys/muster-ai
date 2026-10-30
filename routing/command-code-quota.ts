/**
 * Command Code subscription quota reader.
 *
 * Command Code (Langbase, Inc.) exposes a first-party billing endpoint at
 *   GET https://api.commandcode.ai/alpha/billing/credits
 * authenticated with the same API key used for model inference
 * (`Authorization: Bearer <key>`). The response carries both rolling
 * subscription windows plus the credit counters:
 *
 *   {
 *     credits: { belowThreshold, creditThreshold, monthlyCredits,
 *                purchasedCredits, freeCredits },
 *     windowLimits: {
 *       limited, exceeded,
 *       fiveHour: { used, cap, exceeded, resetAt },
 *       weekly:   { used, cap, exceeded, resetAt }
 *     },
 *     sandboxAccess,
 *     sandboxMinutes: { usedMinutes, limitMinutes, overageUsd, resetAt }
 *   }
 *
 * Both window amounts are USD, not percentages: `used` and `cap` are numbers
 * and `resetAt` is epoch **milliseconds**. The used share is computed here as
 * used / cap * 100; a window whose `cap` is not a positive number is dropped
 * instead of divided by zero.
 *
 * The monthly one is derived from two endpoints (UB0 Revision 2b), because the
 * plan publishes no monthly percentage:
 *   - `credits.monthlyCredits` of this endpoint is the **remaining** monthly credit;
 *   - `GET https://api.commandcode.ai/alpha/usage/summary` `totalMonthlyCredits`
 *     is the credit **used** this period.
 * The allowance is their sum, so the share is used / (remaining + used), and the
 * window resets when the billing period ends. Because the allowance is derived,
 * `commandCodeMonthlyWindow` returns no window unless the two numbers add to a
 * round number: a changed plan reads as no monthly line, never as a wrong one.
 *
 * The API key is read in-process through `provider-key.ts` `providerApiKey`,
 * which reads the provider's env name (`COMMAND_CODE_API_KEY`, named by
 * `models.json`) and then the stored `~/.pi/agent/auth.json` entry — the
 * credential Pi itself uses for this provider. Another CLI's store
 * (e.g. ~/.commandcode/auth.json) may belong to a different account and is
 * never consulted.
 *
 * Polled on a timer (5 min) by `startCommandCodePoller` so the status bar can
 * read a cached snapshot without a network call on every render.
 * `readCommandCodeQuota` itself never performs a network call.
 *
 * Graceful failure: no key, a non-2xx response, an unparseable body or a
 * changed response shape all yield null and the status bar shows no quota
 * line for the provider. Never throws, never logs a body, and never turns a
 * changed shape into a wrong number.
 *
 * The endpoint is undocumented for third parties (it sits under `/alpha/`),
 * so a shape change must degrade to null.
 *
 * Source: api.commandcode.ai/alpha/billing/credits (probe 2026-10-16,
 *         plans/provider-accounts/facts-2026-10-16.md §2);
 *         cmd-usage crate (docs.rs/cmd-usage), endpoint `api::CREDITS_URL`.
 */

import { providerApiKey, type ProviderKeyOptions } from "./provider-key.ts";
import type { RateLimitWindow } from "./codex-quota.ts";

export interface CommandCodeQuota {
	/** 5-hour rolling window. */
	primary: RateLimitWindow;
	/** Weekly rolling window when the endpoint reports a usable one. */
	secondary: RateLimitWindow | null;
	/** The remaining monthly credit this endpoint reports (UB0 Revision 2b), or null when it reports none. */
	monthlyCredits: number | null;
	/** The windows this endpoint stated, named, in its order: a row's `quota.windows` (`monthly` is added by the caller that can read the used credits). */
	windows: CommandCodeWindow[];
	source: "command-code-usage";
	capturedAt: number;         // epoch ms
	ageMs: number;              // age as of read time
}

/** One named window: the two slots' shapes plus the name `quota.windows` states (UD4). */
export interface CommandCodeWindow extends RateLimitWindow {
	name: string;
}

/**
 * The 30-day monthly window (UB0 Revision 2b): the plan reports no such window, so it exists only while both
 * halves of its arithmetic are readable and add to a round allowance.
 */
export const COMMAND_CODE_MONTHLY_MINUTES = 43_200;

/** A derived allowance is a plan's round monthly credit; this is how far the two readings may miss it. */
const ALLOWANCE_EPSILON = 0.005;

const CACHE_TTL_MS = 30_000;
const POLL_INTERVAL_MS = 5 * 60_000; // 5 min — gentle, not spammy
const ENDPOINT = "https://api.commandcode.ai/alpha/billing/credits";
/** The used half of the monthly window (UB0 Revision 2b): `totalMonthlyCredits`, the credit used this period. */
export const COMMAND_CODE_USAGE_SUMMARY_ENDPOINT = "https://api.commandcode.ai/alpha/usage/summary";
const FIVE_HOUR_MINUTES = 300;
const WEEKLY_MINUTES = 10_080;

let cached: { value: CommandCodeQuota | null; at: number } = { value: null, at: 0 };
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** The credential Pi uses for `command-code`, in the one order `provider-key.ts` owns. */
function resolveAPIKey(options: ProviderKeyOptions = {}): string | null {
	return providerApiKey("command-code", options);
}

/** One USD window (`used`/`cap`), or null when the shape is not that window. */
function toWindow(raw: unknown, windowMinutes: number): RateLimitWindow | null {
	if (raw === null || typeof raw !== "object") return null;
	const window = raw as { used?: unknown; cap?: unknown; resetAt?: unknown };
	const used = Number(window.used);
	const cap = Number(window.cap);
	if (!Number.isFinite(used) || !Number.isFinite(cap) || cap <= 0) return null;
	const resetsAtMs = Number(window.resetAt);
	return {
		usedPercent: Math.max(0, Math.min(100, (used / cap) * 100)),
		windowMinutes,
		resetsAt: Number.isFinite(resetsAtMs) && resetsAtMs > 0 ? Math.floor(resetsAtMs / 1000) : 0,
	};
}

/** A credit amount the endpoint states, or null when it states something else: never a guess. */
function creditsAmount(raw: unknown): number | null {
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Parse one `/alpha/billing/credits` body. Exported for the recorded-shape tests. */
export function parseCommandCodeCredits(json: unknown, capturedAt: number = Date.now()): CommandCodeQuota | null {
	const body = json as { credits?: unknown; windowLimits?: unknown } | null | undefined;
	const limits = body?.windowLimits;
	if (limits === null || typeof limits !== "object") return null;
	const windows = limits as { fiveHour?: unknown; weekly?: unknown };
	const primary = toWindow(windows.fiveHour, FIVE_HOUR_MINUTES);
	if (!primary) return null;
	const secondary = toWindow(windows.weekly, WEEKLY_MINUTES);
	const credits = body?.credits;
	const monthlyCredits = credits !== null && typeof credits === "object" ? creditsAmount((credits as { monthlyCredits?: unknown }).monthlyCredits) : null;
	const named: CommandCodeWindow[] = [{ name: "5-hour", ...primary }];
	if (secondary !== null) named.push({ name: "weekly", ...secondary });
	return {
		primary,
		secondary,
		monthlyCredits,
		windows: named,
		source: "command-code-usage",
		capturedAt,
		ageMs: Math.max(0, Date.now() - capturedAt),
	};
}

/**
 * One `/alpha/usage/summary` body's used monthly credit (`totalMonthlyCredits`), or null when the body states
 * none. Exported for the recorded-shape tests.
 */
export function parseCommandCodeUsageSummary(json: unknown): number | null {
	const root = json as { data?: unknown; totalMonthlyCredits?: unknown } | null | undefined;
	const data = root?.data;
	const nested = data !== null && typeof data === "object" ? (data as { totalMonthlyCredits?: unknown }).totalMonthlyCredits : undefined;
	const stated = nested ?? root?.totalMonthlyCredits;
	return stated === undefined ? null : creditsAmount(stated);
}

/**
 * The monthly window (UB0 Revision 2b): used / (remaining + used), 30 days, resetting at the end of the paid
 * period. Every input is required and the allowance must be a round number, because it is derived from two
 * readings rather than published: a plan whose two numbers stop adding to a round allowance reads as no monthly
 * window instead of a guessed percentage.
 */
export function commandCodeMonthlyWindow(
	remaining: number | null,
	used: number | null,
	periodEndMs: number | null,
): RateLimitWindow | null {
	if (remaining === null || used === null) return null;
	if (periodEndMs === null || !Number.isFinite(periodEndMs) || periodEndMs <= 0) return null;
	const allowance = remaining + used;
	if (!(allowance > 0)) return null;
	if (Math.abs(allowance - Math.round(allowance)) > ALLOWANCE_EPSILON) return null;
	return {
		usedPercent: Math.max(0, Math.min(100, (used / allowance) * 100)),
		windowMinutes: COMMAND_CODE_MONTHLY_MINUTES,
		resetsAt: Math.floor(periodEndMs / 1000),
	};
}

/**
 * The used monthly credit, read once for a snapshot row. Null on a missing key, a non-2xx response, a transport
 * failure or a body without the counter: the row then carries no monthly window, and the month's own credits
 * stay unstated rather than wrong. Never logs the key or the body.
 */
export async function fetchCommandCodeUsageSummaryOnce(options: ProviderKeyOptions = {}): Promise<number | null> {
	const key = resolveAPIKey(options);
	if (!key) return null;
	try {
		const res = await fetch(COMMAND_CODE_USAGE_SUMMARY_ENDPOINT, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
		});
		if (!res.ok) return null;
		return parseCommandCodeUsageSummary(await res.json());
	} catch {
		return null;
	}
}

async function fetchOnce(options: ProviderKeyOptions = {}): Promise<CommandCodeQuota | null> {
	const key = resolveAPIKey(options);
	if (!key) return null;
	try {
		const res = await fetch(ENDPOINT, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
		});
		if (!res.ok) return null;
		return parseCommandCodeCredits(await res.json(), Date.now());
	} catch {
		return null;
	}
}

async function refreshCacheAsync(): Promise<void> {
	try {
		const value = await fetchOnce();
		cached = { value, at: Date.now() };
	} catch {
		cached = { value: null, at: Date.now() };
	}
}

/**
 * One-shot fetch for the snapshot script and any caller that needs a fresh
 * reading without starting the background poller. Reads the key through
 * `provider-key.ts` (`options.prefix: "WORK_"` reads the work account's
 * copy), never logs the key or the response body, and returns null on missing
 * key, non-2xx, transport failure or unparsable body — the snapshot records
 * that null as an error per provider and continues.
 */
export async function fetchCommandCodeQuotaOnce(options: ProviderKeyOptions = {}): Promise<CommandCodeQuota | null> {
	return fetchOnce(options);
}

/**
 * Cached snapshot for the status bar. Never performs a network call itself:
 * the cache is filled by `startCommandCodePoller()`. An empty cache (first
 * call, or before the poller's first result) returns null and the bar shows
 * no quota line for the provider.
 */
export function readCommandCodeQuota(): CommandCodeQuota | null {
	const now = Date.now();
	if (now - cached.at < CACHE_TTL_MS) return cached.value;
	// Stale or empty: refresh in the background and return what the cache holds.
	void refreshCacheAsync();
	return cached.value;
}

/** Background poller (5 min). Idempotent; stopped by `stopCommandCodePoller`. */
export function startCommandCodePoller(): void {
	if (pollTimer) return;
	void refreshCacheAsync();
	pollTimer = setInterval(() => { void refreshCacheAsync(); }, POLL_INTERVAL_MS);
	pollTimer.unref?.();
}

export function stopCommandCodePoller(): void {
	if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
