/**
 * DeepSeek balance + pricing readers.
 *
 * DeepSeek reports nothing about money in a chat-completion response: the
 * `usage` object carries token counts (and cache hit/miss counts) only, never
 * account balance. Balance requires a separate authenticated call.
 *
 *   - remaining credit balance → GET /user/balance
 *       → { is_available, balance_infos: [{ currency, total_balance,
 *         granted_balance, topped_up_balance }] }
 *       total_balance is a decimal *string*; currencies arrive as an array, so
 *       USD is preferred and any other single currency is used as a fallback.
 *   - per-model token pricing → NOT exposed by the API. GET /models returns
 *       `{ id, object, owned_by }` only, so rates come from Pi's own model
 *       catalog (`ctx.model.cost`), which is already USD per million tokens.
 *       The catalog carries DeepSeek's PEAK rates; off-peak is half price, so
 *       the band is resolved from the clock on every read.
 *
 * Cadence: balance refreshes every 5 minutes (warm on poller start, cached
 * 30 s for display). No token cost — these are plain REST calls.
 */

import { providerApiKey, type ProviderKeyOptions } from "./provider-key.ts";

export interface DeepSeekQuota {
	/** Total available balance (granted + topped up) in `currency` units. */
	balance: number;
	/** ISO currency code reported by the API, e.g. "USD" or "CNY". */
	currency: string;
	/** Whether the balance is sufficient for API calls. */
	isAvailable: boolean;
	/** Unexpired granted balance. */
	grantedBalance: number;
	/** Topped-up balance. */
	toppedUpBalance: number;
	source: "deepseek-balance" | "deepseek-balance-stale";
	capturedAt: number;
	ageMs: number;
}

export interface DeepSeekRates {
	/** USD per million input tokens, for the current time-of-day band. */
	inputPerM: number;
	/** USD per million output tokens, for the current time-of-day band. */
	outputPerM: number;
	/** USD per million cache-read tokens, when the catalog reports it. */
	cacheReadPerM: number | null;
	source: "pi-model-catalog" | "pi-model-catalog-stale";
	/** Time-of-day pricing band the rates above reflect. */
	mode: DeepSeekPricingMode;
	capturedAt: number;
	ageMs: number;
}

export type DeepSeekPricingMode = "peak" | "off-peak";

const CACHE_TTL_MS = 30_000;
const POLL_INTERVAL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_BASE_URL = "https://api.deepseek.com";

let cachedQuota: { value: DeepSeekQuota | null; at: number } = { value: null, at: 0 };
let pollTimer: ReturnType<typeof setInterval> | null = null;

function apiKey(options: ProviderKeyOptions = {}): string | undefined {
	return providerApiKey("deepseek", options) ?? undefined;
}

/**
 * The balance endpoint lives at the API root. A configured DEEPSEEK_BASE_URL
 * commonly points at the OpenAI-compatible surface (".../v1"), which does not
 * serve /user/balance, so strip a trailing version segment first.
 */
function balanceUrl(): string {
	const raw = (process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
	const root = raw.replace(/\/v\d+$/i, "");
	return `${root || DEFAULT_BASE_URL}/user/balance`;
}

// ─── Balance ──────────────────────────────────────────────────────────────

/**
 * Pure parser, exported for tests: raw /user/balance payload → balance.
 * Returns null when no numeric balance is present, so the bar renders a
 * pending/absent state instead of a fabricated zero.
 */
export function parseDeepSeekBalance(data: any): {
	balance: number;
	currency: string;
	isAvailable: boolean;
	grantedBalance: number;
	toppedUpBalance: number;
} | null {
	const infos = data?.balance_infos;
	if (!Array.isArray(infos) || infos.length === 0) return null;

	// Prefer USD so the figure is comparable across sources; otherwise take the
	// first entry the account reports.
	const usd = infos.find((i: any) => String(i?.currency ?? "").toUpperCase() === "USD");
	const chosen = usd ?? infos[0];
	const balance = Number(chosen?.total_balance);
	if (!Number.isFinite(balance)) return null;

	const granted = Number(chosen?.granted_balance);
	const toppedUp = Number(chosen?.topped_up_balance);
	return {
		balance: Math.max(0, balance),
		currency: String(chosen?.currency ?? "USD").toUpperCase(),
		isAvailable: Boolean(data?.is_available),
		grantedBalance: Number.isFinite(granted) ? granted : 0,
		toppedUpBalance: Number.isFinite(toppedUp) ? toppedUp : 0,
	};
}

async function fetchQuota(): Promise<DeepSeekQuota | null> {
	if (apiKey() === undefined) {
		cachedQuota = { value: null, at: Date.now() };
		return null;
	}
	const parsed = await fetchDeepSeekBalanceOnce();
	cachedQuota = { value: parsed ?? cachedQuota.value, at: Date.now() };
	return cachedQuota.value;
}

/**
 * One-shot balance fetch for the snapshot script, following
 * `fetchGLMQuotaOnce`: one call with the key it resolves, independent of the
 * poller's cache. Null on a missing key, a non-2xx status, a transport failure
 * or an unparsable body; never throws and never logs the key or the body.
 */
export async function fetchDeepSeekBalanceOnce(options: ProviderKeyOptions = {}): Promise<DeepSeekQuota | null> {
	const key = apiKey(options);
	if (!key) return null;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(balanceUrl(), {
			headers: { Authorization: `Bearer ${key}` },
			signal: controller.signal,
		});
		if (!res.ok) return null;
		const info = parseDeepSeekBalance(await res.json());
		if (!info) return null;
		return { ...info, source: "deepseek-balance", capturedAt: Date.now(), ageMs: 0 };
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

export function readDeepSeekQuota(): DeepSeekQuota | null {
	const now = Date.now();
	if (now - cachedQuota.at >= CACHE_TTL_MS) {
		// Refresh in background; display keeps the freshest known value.
		queueMicrotask(() => { void fetchQuota(); });
	}
	if (!cachedQuota.value) return null;
	const age = Math.max(0, now - cachedQuota.value.capturedAt);
	return {
		...cachedQuota.value,
		ageMs: age,
		source: age > CACHE_TTL_MS ? "deepseek-balance-stale" : "deepseek-balance",
	};
}

export function startDeepSeekPoller(): void {
	if (pollTimer) return;
	// Warm the cache immediately so the bar paints on first render.
	void fetchQuota();
	pollTimer = setInterval(() => { void fetchQuota(); }, POLL_INTERVAL_MS);
	pollTimer.unref?.();
}

export function stopDeepSeekPoller(): void {
	if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ─── Token pricing (from Pi's model catalog) ─────────────────────────────

/**
 * DeepSeek time-of-day pricing bands, in UTC:
 * "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday
 * (all other hours are off-peak)."
 *
 * Windows are half-open `[startHour, endHour)`: 04:00 and 10:00 UTC are
 * already off-peak, which is also how DeepSeek bills the boundary minute.
 */
export const DEEPSEEK_PEAK_WINDOWS_UTC: ReadonlyArray<{ startHour: number; endHour: number }> = Object.freeze([
	Object.freeze({ startHour: 1, endHour: 4 }),
	Object.freeze({ startHour: 6, endHour: 10 }),
]);

/** "Off-peak rates are half of the peak rates." */
export const DEEPSEEK_OFF_PEAK_MULTIPLIER = 0.5;

/**
 * Whether DeepSeek is billing at peak rates at `at`. Pure and clock-injectable
 * so the band can be exercised at every boundary without waiting for one.
 */
export function isDeepSeekPeak(at: Date | number = Date.now()): boolean {
	const d = at instanceof Date ? at : new Date(at);
	const day = d.getUTCDay(); // 0 = Sunday, 6 = Saturday
	if (day === 0 || day === 6) return false;
	const hour = d.getUTCHours();
	return DEEPSEEK_PEAK_WINDOWS_UTC.some((w) => hour >= w.startHour && hour < w.endHour);
}

/** The band in force at `at`, and the multiplier it applies to catalog rates. */
export function deepSeekPricingMode(at: Date | number = Date.now()): {
	mode: DeepSeekPricingMode;
	factor: number;
} {
	const peak = isDeepSeekPeak(at);
	return { mode: peak ? "peak" : "off-peak", factor: peak ? 1 : DEEPSEEK_OFF_PEAK_MULTIPLIER };
}

/**
 * DeepSeek exposes no pricing endpoint, so rates come from the Pi model
 * catalog. Catalog `cost` values are already USD per million tokens at PEAK
 * rates; off-peak halves them. A model with no catalog pricing yields null
 * rather than a guessed rate.
 *
 * `at` is resolved on every call, so a render that happens after a band
 * boundary reports the new band without any extra timer.
 */
export function readDeepSeekRates(
	cost: { input?: number; output?: number; cacheRead?: number } | null | undefined,
	at: Date | number = Date.now(),
): DeepSeekRates | null {
	const inputPerM = Number(cost?.input);
	const outputPerM = Number(cost?.output);
	if (!Number.isFinite(inputPerM) || !Number.isFinite(outputPerM)) return null;
	if (inputPerM <= 0 && outputPerM <= 0) return null;
	const cacheRead = Number(cost?.cacheRead);
	const { mode, factor } = deepSeekPricingMode(at);
	return {
		inputPerM: inputPerM * factor,
		outputPerM: outputPerM * factor,
		cacheReadPerM: Number.isFinite(cacheRead) && cacheRead > 0 ? cacheRead * factor : null,
		source: "pi-model-catalog",
		mode,
		capturedAt: Date.now(),
		ageMs: 0,
	};
}
