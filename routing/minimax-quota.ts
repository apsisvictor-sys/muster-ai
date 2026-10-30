/**
 * MiniMax Token Plan quota reader.
 *
 * MiniMax exposes a first-party usage endpoint at
 *   GET https://www.minimax.io/v1/token_plan/remains
 * authenticated with a **Subscription Key** (separate from the pay-as-you-go
 * API Key). The response is a `base_resp` envelope plus a `model_remains`
 * array — each entry carries:
 *   - `current_interval_remaining_percent`  → 5-hour rolling, remaining %
 *   - `current_weekly_remaining_percent`    → weekly, remaining %
 *   - `end_time` / `weekly_end_time`        → reset epochs in **milliseconds**
 *   - `model_name`                          → e.g. "general" (text), "video"
 *
 * The first "general" model entry is the right window for text models
 * (M2.7, M3). Used % is reported to the bar, computed as
 * `100 - remaining_percent`.
 *
 * The Subscription Key is looked up by `provider-key.ts` `providerApiKey`, in
 * this reader's own order:
 *   1. process.env.MINIMAX_SUBSCRIPTION_KEY
 *   2. process.env.MINIMAX_API_KEY  (a Subscription Key reused as API key
 *      also works; the call returns the same shape)
 *   3. ~/.pi/agent/auth.json         ({"minimax":{"type":"api_key", ...}})
 *
 * Polled on a timer (5 min) by `startMiniMaxPoller` so the status bar can
 * read a cached snapshot without making a network call on every render.
 *
 * Graceful failure: if no key is found, or the call returns 1004 (pay-as-you-go
 * key on a token-plan endpoint, or invalid key), the reader returns null and
 * the status bar shows no quota info — never throws.
 *
 * Source: https://platform.minimax.io/docs/token-plan/faq.md
 *         https://platform.minimax.io/docs/token-plan/intro
 *         https://platform.minimax.io/docs/guides/pricing-token-plan
 */

import { execSync } from "node:child_process";
import type { RateLimitWindow } from "./codex-quota.ts";
import { providerApiKey, type ProviderKeyOptions } from "./provider-key.ts";

export interface MiniMaxQuota {
	primary: RateLimitWindow;   // 5-hour rolling
	secondary: RateLimitWindow; // weekly
	planType: string | null;    // "Plus" | "Max" | "Ultra" | null
	source: "minimax-token-plan" | "minimax-token-plan-stale";
	capturedAt: number;         // epoch ms
	ageMs: number;              // age as of read time
}

const CACHE_TTL_MS = 30_000;
const POLL_INTERVAL_MS = 5 * 60_000; // 5 min — gentle, not spammy
const ENDPOINT = "https://www.minimax.io/v1/token_plan/remains";

let cached: { value: MiniMaxQuota | null; at: number; reason?: string } = { value: null, at: 0 };
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastError: string | null = null;
let lastErrorAt = 0;

function resolveSubscriptionKey(options: ProviderKeyOptions = {}): string | null {
	return providerApiKey("minimax", {
		...options,
		// This reader's own order: the dedicated Subscription Key name comes first.
		extraEnvNames: ["MINIMAX_SUBSCRIPTION_KEY"],
	});
}

function toWindow(usedPercent: number, windowMinutes: number, resetMs: number): RateLimitWindow | null {
	if (!Number.isFinite(usedPercent) || !Number.isFinite(windowMinutes) || !Number.isFinite(resetMs)) return null;
	return { usedPercent, windowMinutes, resetsAt: Math.floor(resetMs / 1000) };
}

/**
 * Pick the entry that should drive the status bar. Prefer "general" (text
 * models M2.7 / M3) and fall back to the first entry. Image / video / music
 * windows are not what the bar should display.
 */
function pickTextEntry(entries: any[]): any | null {
	if (!Array.isArray(entries) || entries.length === 0) return null;
	const general = entries.find((e) => typeof e?.model_name === "string" && e.model_name.toLowerCase().includes("general"));
	return general ?? entries[0];
}

function parseResponse(json: any, capturedAt: number): MiniMaxQuota | null {
	if (json?.base_resp?.status_code !== 0) return null;
	const entry = pickTextEntry(json.model_remains);
	if (!entry) return null;
	const used5h = 100 - Number(entry.current_interval_remaining_percent ?? 0);
	const usedWk = 100 - Number(entry.current_weekly_remaining_percent ?? 0);
	const primary = toWindow(used5h, 300, Number(entry.end_time ?? 0));
	const secondary = toWindow(usedWk, 10080, Number(entry.weekly_end_time ?? 0));
	if (!primary || !secondary) return null;
	const planType = typeof entry.model_name === "string" ? entry.model_name : null;
	return {
		primary, secondary, planType,
		capturedAt,
		source: "minimax-token-plan",
		ageMs: Math.max(0, Date.now() - capturedAt),
	};
}

async function fetchOnce(options: ProviderKeyOptions = {}): Promise<MiniMaxQuota | null> {
	const key = resolveSubscriptionKey(options);
	if (!key) {
		lastError = "no subscription key";
		lastErrorAt = Date.now();
		return null;
	}
	try {
		// Use Node 22's built-in fetch (no extra dependency).
		const res = await fetch(ENDPOINT, {
			method: "GET",
			headers: { Authorization: `Bearer ${key}` },
		});
		if (!res.ok) {
			lastError = `HTTP ${res.status}`;
			lastErrorAt = Date.now();
			return null;
		}
		const json = await res.json();
		return parseResponse(json, Date.now());
	} catch (e: any) {
		lastError = e?.message ?? String(e);
		lastErrorAt = Date.now();
		return null;
	}
}

/**
 * One-shot fetch for the snapshot script. Calls the MiniMax token-plan endpoint
 * once with the key it resolves, never logs the key or the response body, and
 * returns null on missing key, non-2xx, transport failure, an unparsable body,
 * or a 1004 (pay-as-you-go key on a token-plan endpoint). Unlike
 * `readMiniMaxQuota` it does not depend on the in-memory cache or the poller
 * being started, so it is the right entry point for a fresh snapshot row.
 */
export async function fetchMiniMaxQuotaOnce(options: ProviderKeyOptions = {}): Promise<MiniMaxQuota | null> {
	return fetchOnce(options);
}

/**
 * Sync read of the latest cached MiniMax quota. 30s in-memory cache.
 * Returns null when no key, no response yet, or 1004 (pay-as-you-go key).
 *
 * IMPORTANT: this never performs a network call itself. The cache is
 * populated by `startMiniMaxPoller()`. If the cache is empty (first
 * call, or before the poller has finished its initial poll), it returns
 * null and the status bar simply shows no quota info for that frame.
 */
export function readMiniMaxQuota(): MiniMaxQuota | null {
	const now = Date.now();
	if (now - cached.at < CACHE_TTL_MS) return cached.value;
	// Cache is stale or empty. Refresh asynchronously and return whatever
	// the cache currently holds (likely null on the very first call).
	void refreshCacheAsync();
	return cached.value;
}

async function refreshCacheAsync(): Promise<void> {
	const q = await fetchOnce();
	cached = { value: q, at: Date.now(), reason: lastError ?? undefined };
}

/**
 * Start a background poller that calls the token-plan endpoint every
 * 5 minutes. Idempotent — second call is a no-op. Stops automatically
 * on `stopMiniMaxPoller` or when the process exits.
 */
export function startMiniMaxPoller(): void {
	if (pollTimer) return;
	// Kick off one immediate poll so the bar is populated within seconds.
	void refreshCacheAsync();
	pollTimer = setInterval(() => { void refreshCacheAsync(); }, POLL_INTERVAL_MS);
	pollTimer.unref?.();
}

export function stopMiniMaxPoller(): void {
	if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

/**
 * Returns the most recent polling error string, or null if polling has
 * succeeded at least once. Useful for one-line notices in the status bar
 * (e.g. "no quota — pay-as-you-go key") without throwing.
 */
export function lastMiniMaxError(): { message: string; at: number } | null {
	if (!lastError) return null;
	return { message: lastError, at: lastErrorAt };
}
