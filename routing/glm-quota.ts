/**
 * GLM / Zhipu / Z.ai Token Plan quota reader.
 *
 * Zhipu exposes a first-party usage endpoint at
 *   GET https://api.z.ai/api/monitor/usage/quota/limit       (Z.ai international)
 *   GET https://bigmodel.cn/api/monitor/usage/quota/limit    (Zhipu domestic China)
 * authenticated with the same API key used for model inference. The response
 * is a `{ code, success, data: { limits } }` envelope where `limits` is an
 * array of quota windows:
 *
 *   { type: "TOKENS_LIMIT", usage, currentValue, percentage, nextResetTime }
 *
 * The TOKENS_LIMIT entries carry rolling token quotas with
 * `percentage` = used % and `nextResetTime` = reset epoch in **milliseconds**.
 * Typically two entries are returned:
 *   - First (unit=3, number=5): 5-hour rolling window
 *   - Second (unit=6, number=1): daily window (~24h)
 * There is no weekly window from Zhipu; the daily window is used as secondary.
 *
 * The API key is looked up by `provider-key.ts` `providerApiKey`, in this
 * reader's own order:
 *   1. process.env.ZAI_API_KEY
 *   2. process.env.ZHIPU_API_KEY
 *   3. ~/.pi/agent/auth.json  ({"zai":{"type":"api_key", ...}}, then
 *      {"zhipu":{"type":"api_key", ...}})
 *
 * Polled on a timer (5 min) by `startGLMPoller` so the status bar can
 * read a cached snapshot without making a network call on every render.
 *
 * Graceful failure: if no key is found, or the call fails, the reader
 * returns null and the status bar shows no quota info — never throws.
 *
 * Source: https://open.bigmodel.cn/dev/api
 *         opencode-mystatus plugin/lib/zhipu.ts (reverse-engineered)
 *         opencode-quota PR #78
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { providerApiKey, type ProviderKeyOptions } from "./provider-key.ts";
import type { RateLimitWindow } from "./codex-quota.ts";

export interface GLMQuota {
	primary: RateLimitWindow;   // 5-hour rolling TOKENS_LIMIT
	secondary: RateLimitWindow | null; // daily window when available (~24h), no weekly from Zhipu
	planType: string | null;
	source: "glm-token-plan" | "glm-token-plan-stale";
	capturedAt: number;         // epoch ms
	ageMs: number;              // age as of read time
}

const CACHE_TTL_MS = 30_000;
const POLL_INTERVAL_MS = 5 * 60_000; // 5 min — gentle, not spammy
const ZAI_ENDPOINT = "https://api.z.ai/api/monitor/usage/quota/limit";
const ZHIPU_ENDPOINT = "https://bigmodel.cn/api/monitor/usage/quota/limit";

let cached: { value: GLMQuota | null; at: number; reason?: string } = { value: null, at: 0 };
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastError: string | null = null;
let lastErrorAt = 0;

function resolveAPIKey(options: ProviderKeyOptions = {}): string | null {
	return providerApiKey("zai", {
		...options,
		// This reader's own order: the international key, then the domestic one.
		envNames: ["ZAI_API_KEY", "ZHIPU_API_KEY"],
		storedProviders: ["zai", "zhipu"],
	});
}

/**
 * Pick the endpoint based on which provider the user is running.
 * For Z.ai (international) use api.z.ai; for domestic bigmodel.cn
 * use bigmodel.cn. We detect by checking if the key resolves from
 * a ZHIPU_-prefixed var; otherwise default to Z.ai.
 */
function resolveEndpoint(): string {
	const zhipuKey = process.env.ZHIPU_API_KEY?.trim();
	if (zhipuKey) return ZHIPU_ENDPOINT;

	// Check auth.json for zhipu vs zai
	try {
		const path = join(homedir(), ".pi", "agent", "auth.json");
		if (existsSync(path)) {
			const auth = JSON.parse(readFileSync(path, "utf-8"));
			if (auth?.zhipu?.type === "api_key") return ZHIPU_ENDPOINT;
		}
	} catch { /* ignore */ }

	return ZAI_ENDPOINT;
}

function toLimitWindow(limit: any): RateLimitWindow | null {
	const usedPercent = Number(limit.percentage ?? 0);
	const resetMs = Number(limit.nextResetTime ?? 0);
	if (!Number.isFinite(usedPercent) || !Number.isFinite(resetMs)) return null;
	const resetsAtSec = Math.floor(resetMs / 1000);
	const nowSec = Math.floor(Date.now() / 1000);
	const deltaSec = Math.max(0, resetsAtSec - nowSec);
	const windowMinutes = deltaSec > 0 ? Math.round(deltaSec / 60) : 300;
	return { usedPercent, windowMinutes, resetsAt: resetsAtSec };
}

function parseResponse(json: any, capturedAt: number): GLMQuota | null {
	// Response shape: { code: 200, success: true, data: { limits: [...] } }
	if (!json?.success || json?.code !== 200) return null;
	if (!Array.isArray(json?.data?.limits) || json.data.limits.length === 0) return null;

	// The API returns multiple TOKENS_LIMIT entries:
	//   [0] unit=3, number=5  → 5-hour rolling window (short)
	//   [1] unit=6, number=1  → daily window (~24h)
	const tokensLimits = json.data.limits.filter(
		(l: any) => l?.type === "TOKENS_LIMIT",
	);
	if (tokensLimits.length === 0) return null;

	const primary = toLimitWindow(tokensLimits[0]);
	if (!primary) return null;

	// Second TOKENS_LIMIT is the daily window. May not always be present.
	const secondary = tokensLimits.length > 1 ? toLimitWindow(tokensLimits[1]) : null;

	// Plan level (e.g. "pro") from the response
	const planType = typeof json.data?.level === "string" ? json.data.level : null;

	return {
		primary,
		secondary,
		planType,
		capturedAt,
		source: "glm-token-plan",
		ageMs: Math.max(0, Date.now() - capturedAt),
	};
}

async function fetchOnce(options: ProviderKeyOptions = {}): Promise<GLMQuota | null> {
	const key = resolveAPIKey(options);
	if (!key) {
		lastError = "no API key";
		lastErrorAt = Date.now();
		return null;
	}
	try {
		const endpoint = resolveEndpoint();
		const res = await fetch(endpoint, {
			method: "GET",
			headers: {
				Authorization: key,
				"Content-Type": "application/json",
			},
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
 * One-shot fetch for the snapshot script. Calls the Z.ai or Zhipu quota endpoint
 * once with the key it resolves, never logs the key or the response body, and
 * returns null on missing key, non-2xx, transport failure or unparsable body.
 * Unlike `readGLMQuota` it does not depend on the in-memory cache or the poller
 * being started, so it is the right entry point for a fresh snapshot row.
 */
export async function fetchGLMQuotaOnce(options: ProviderKeyOptions = {}): Promise<GLMQuota | null> {
	return fetchOnce(options);
}

/**
 * Sync read of the latest cached GLM quota. 30s in-memory cache.
 * Returns null when no key, no response yet, or API error.
 *
 * IMPORTANT: this never performs a network call itself. The cache is
 * populated by `startGLMPoller()`. If the cache is empty (first
 * call, or before the poller has finished its initial poll), it returns
 * null and the status bar simply shows no quota info for that frame.
 */
export function readGLMQuota(): GLMQuota | null {
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
 * Start a background poller that calls the quota endpoint every
 * 5 minutes. Idempotent — second call is a no-op. Stops automatically
 * on `stopGLMPoller` or when the process exits.
 */
export function startGLMPoller(): void {
	if (pollTimer) return;
	// Kick off one immediate poll so the bar is populated within seconds.
	void refreshCacheAsync();
	pollTimer = setInterval(() => { void refreshCacheAsync(); }, POLL_INTERVAL_MS);
	pollTimer.unref?.();
}

export function stopGLMPoller(): void {
	if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

/**
 * Returns the most recent polling error string, or null if polling has
 * succeeded at least once.
 */
export function lastGLMError(): { message: string; at: number } | null {
	if (!lastError) return null;
	return { message: lastError, at: lastErrorAt };
}
