/**
 * OpenCode Go subscription quota reader.
 *
 * OpenCode Go (Anomaly Innovations, Inc.) exposes a usage endpoint at
 *   GET https://opencode.ai/zen/go/v1/usage
 * authenticated with the same API key the provider uses for inference
 * (`Authorization: Bearer <key>`). The response is one envelope of named
 * meters (probe 2026-10-16, plans/provider-accounts/facts-2026-10-16.md §6):
 *
 *   { "usage": {
 *       "rolling": { "status": "string", "percent": "number", "resetsAt": "string" },
 *       "weekly":  { "status": "string", "percent": "number", "resetsAt": "string" },
 *       "monthly": { "status": "string", "percent": "number", "resetsAt": "string" }
 *   } }
 *
 * `percent` is the used share (0..100) and `resetsAt` is an ISO-8601 string;
 * `status` is the server's own word for the meter. The rolling window is the
 * 5-hour one (the provider's own wall message reads "5-hour usage limit
 * reached", the crate names it "rolling"), the weekly window is 7 days, and
 * the monthly one is 30 days with its own reset (Revision 2b, VR24-201). All
 * three are surfaced, named, so the snapshot row states each beside the others
 * (UD4); `windows` is that list and `primary`/`secondary` keep their meaning.
 *
 * The API key is read in-process through `provider-key.ts` `providerApiKey`,
 * which reads the provider's env name (`OPENCODE_API_KEY`) and then the stored
 * `~/.pi/agent/auth.json` entry — the credential Pi itself uses for this
 * provider — never another CLI's store.
 *
 * Polled on a timer (5 min) by `startOpenCodeGoPoller` so the status bar can
 * read a cached snapshot without a network call on every render.
 * `readOpenCodeGoQuota` itself never performs a network call.
 *
 * Graceful failure: no key, 401/403, a non-2xx response, an unparseable body
 * or a changed response shape all yield null on the poller's path and the
 * status bar shows no quota line for the provider. Never throws there, never
 * logs a body, and never turns a changed shape into a wrong number. The
 * one-shot read throws its cause instead, and a non-2xx answer reads exactly
 * `HTTP <status>`, so a row states the status the design names (A-3): 401 and
 * 403 are the endpoint refusing the key, and 403 is also how a key with no Go
 * plan answers.
 *
 * The endpoint is undocumented for third parties, so a shape change must
 * degrade to null.
 *
 * Source: opencode.ai/zen/go/v1/usage (probe 2026-10-16);
 *         cmd-usage crate (docs.rs/cmd-usage), `ocuse::api::USAGE_URL`.
 */

import { missingKeyReason, providerApiKey, type ProviderKeyOptions } from "./provider-key.ts";
import type { RateLimitWindow } from "./codex-quota.ts";

/** One meter as a row states it: the endpoint's own share and reset, under the name the row gives it (UD4). */
export interface OpenCodeGoWindow extends RateLimitWindow {
	name: string;
}

export interface OpenCodeGoQuota {
	/** Rolling 5-hour window. */
	primary: RateLimitWindow;
	/** Weekly window when the endpoint reports a usable one. */
	secondary: RateLimitWindow | null;
	/** The 30-day meter when the endpoint reports a usable one (Revision 2b). */
	monthly: RateLimitWindow | null;
	/** Every meter the endpoint reported, named, in the endpoint's order: a row's `quota.windows`. */
	windows: OpenCodeGoWindow[];
	source: "opencode-go-usage";
	capturedAt: number;         // epoch ms
	ageMs: number;              // age as of read time
}

const CACHE_TTL_MS = 30_000;
const POLL_INTERVAL_MS = 5 * 60_000; // 5 min — gentle, not spammy
const ENDPOINT = "https://opencode.ai/zen/go/v1/usage";
const ROLLING_MINUTES = 300;
const WEEKLY_MINUTES = 10_080;
/** 30 days (Revision 2b): the longest window the plan reports, with its own reset. */
const MONTHLY_MINUTES = 43_200;

let cached: { value: OpenCodeGoQuota | null; at: number } = { value: null, at: 0 };
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** The credential Pi uses for `opencode-go`, in the one order `provider-key.ts` owns. */
function resolveAPIKey(options: ProviderKeyOptions = {}): string | null {
	return providerApiKey("opencode-go", options);
}

/** One meter (`percent` share plus an ISO `resetsAt`), or null on shape drift. */
function toMeterWindow(raw: unknown, windowMinutes: number): RateLimitWindow | null {
	if (raw === null || typeof raw !== "object") return null;
	const meter = raw as { percent?: unknown; resetsAt?: unknown };
	const percent = Number(meter.percent);
	if (!Number.isFinite(percent)) return null;
	const resetsAtMs = typeof meter.resetsAt === "string" ? Date.parse(meter.resetsAt) : NaN;
	return {
		usedPercent: Math.max(0, Math.min(100, percent)),
		windowMinutes,
		resetsAt: Number.isFinite(resetsAtMs) && resetsAtMs > 0 ? Math.floor(resetsAtMs / 1000) : 0,
	};
}

/** Parse one `/zen/go/v1/usage` body. Exported for the recorded-shape tests. */
export function parseOpenCodeGoUsage(json: unknown, capturedAt: number = Date.now()): OpenCodeGoQuota | null {
	const usage = (json as { usage?: unknown } | null | undefined)?.usage;
	if (usage === null || typeof usage !== "object") return null;
	const meters = usage as { rolling?: unknown; weekly?: unknown; monthly?: unknown };
	const primary = toMeterWindow(meters.rolling, ROLLING_MINUTES);
	// The rolling meter is the one the plan always reports: without it the body is not a reading at all.
	if (!primary) return null;
	const secondary = toMeterWindow(meters.weekly, WEEKLY_MINUTES);
	const monthly = toMeterWindow(meters.monthly, MONTHLY_MINUTES);
	const windows: OpenCodeGoWindow[] = [{ name: "5-hour", ...primary }];
	if (secondary !== null) windows.push({ name: "weekly", ...secondary });
	if (monthly !== null) windows.push({ name: "monthly", ...monthly });
	return {
		primary,
		secondary,
		monthly,
		windows,
		source: "opencode-go-usage",
		capturedAt,
		ageMs: Math.max(0, Date.now() - capturedAt),
	};
}

/**
 * One call of the usage endpoint. It throws the cause of a failed read: a
 * missing key, a non-2xx status (401 and 403 are the endpoint refusing the
 * key), a transport failure, or a body without the rolling meter.
 */
async function fetchChecked(options: ProviderKeyOptions = {}): Promise<OpenCodeGoQuota> {
	const key = resolveAPIKey(options);
	if (!key) throw new Error(missingKeyReason("opencode-go", options));
	const res = await fetch(ENDPOINT, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${key}`,
			"Content-Type": "application/json",
		},
	});
	// The status alone, exactly: a row states "HTTP 403" for a key with no Go plan, and the body is never read.
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const quota = parseOpenCodeGoUsage(await res.json(), Date.now());
	if (quota === null) throw new Error("HTTP 200 from opencode.ai but the body has no usage meters");
	return quota;
}

/** The poller's read: the same call, with every failure reading as no quota. */
async function fetchOnce(options: ProviderKeyOptions = {}): Promise<OpenCodeGoQuota | null> {
	try {
		return await fetchChecked(options);
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
 * copy) and never logs the key or the response body. A failed read throws its
 * cause (missing key, non-2xx, transport failure, unparsable body), as
 * `fetchKimiQuotaOnce` does — the snapshot records the message as the
 * provider's error and continues.
 */
export async function fetchOpenCodeGoQuotaOnce(options: ProviderKeyOptions = {}): Promise<OpenCodeGoQuota> {
	return fetchChecked(options);
}

/**
 * Cached snapshot for the status bar. Never performs a network call itself:
 * the cache is filled by `startOpenCodeGoPoller()`. An empty cache (first
 * call, or before the poller's first result) returns null and the bar shows
 * no quota line for the provider.
 */
export function readOpenCodeGoQuota(): OpenCodeGoQuota | null {
	const now = Date.now();
	if (now - cached.at < CACHE_TTL_MS) return cached.value;
	// Stale or empty: refresh in the background and return what the cache holds.
	void refreshCacheAsync();
	return cached.value;
}

/** Background poller (5 min). Idempotent; stopped by `stopOpenCodeGoPoller`. */
export function startOpenCodeGoPoller(): void {
	if (pollTimer) return;
	void refreshCacheAsync();
	pollTimer = setInterval(() => { void refreshCacheAsync(); }, POLL_INTERVAL_MS);
	pollTimer.unref?.();
}

export function stopOpenCodeGoPoller(): void {
	if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
