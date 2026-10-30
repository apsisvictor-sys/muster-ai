/**
 * OpenRouter quota + pricing readers.
 *
 * OpenRouter is strictly pay-as-you-go: there is no 5h/weekly budget window
 * to fill. What serves the status bar:
 *   - remaining credit balance   → GET /api/v1/credits        (polled, cheap)
 *   - live per-provider discounts → GET /api/v1/models/{slug}/endpoints
 *   - per-request provider name  → GET /api/v1/generation?id= (driven by the
 *     x-generation-id header captured in after_provider_response; throttled
 *     by the caller)
 *
 * Cadence: balance refreshes every 5 minutes (warm on poller start, cached
 * 30 s for display); pricing refreshes lazily on a 10-minute TTL. No token
 * cost — these are plain REST calls.
 */

import { providerApiKey, type ProviderKeyOptions } from "./provider-key.ts";

export interface OpenRouterQuota {
	/** Remaining credits in USD. */
	balance: number;
	totalCredits: number;
	totalUsage: number;
	/** 0..100 share of topped-up credits consumed. */
	usedPercent: number;
	source: "openrouter-credits" | "openrouter-credits-stale";
	capturedAt: number;
	ageMs: number;
}

export interface OpenRouterPricing {
	/** Provider name → discount percent (0..100). */
	byProvider: Record<string, number>;
	/** Provider name → live per-token pricing (USD per million). */
	ratesByProvider: Record<string, { inputPerM: number; outputPerM: number; cacheReadPerM: number | null }>;
	/** Healthy (status===0) endpoint with the largest discount. */
	bestProvider: string | null;
	bestDiscount: number | null;
	source: "openrouter-endpoints" | "openrouter-endpoints-stale";
	capturedAt: number;
	ageMs: number;
}

const CACHE_TTL_MS = 30_000;
const POLL_INTERVAL_MS = 5 * 60_000;
const PRICING_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

const API_BASE = "https://openrouter.ai/api/v1";

let cachedQuota: { value: OpenRouterQuota | null; at: number } = { value: null, at: 0 };
let cachedPricing: { key: string; value: OpenRouterPricing | null; at: number } = { key: "", value: null, at: 0 };
let pricingInFlight = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function apiKey(options: ProviderKeyOptions = {}): string | undefined {
	return providerApiKey("openrouter", options) ?? undefined;
}

async function getJson(path: string, options: ProviderKeyOptions = {}): Promise<any | null> {
	const key = apiKey(options);
	if (!key) return null;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(`${API_BASE}${path}`, {
			headers: { Authorization: `Bearer ${key}` },
			signal: controller.signal,
		});
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

// ─── Balance ──────────────────────────────────────────────────────────────

function parseQuota(data: any): OpenRouterQuota | null {
	const totalCredits = Number(data?.total_credits);
	const totalUsage = Number(data?.total_usage);
	if (!Number.isFinite(totalCredits) || !Number.isFinite(totalUsage)) return null;
	return {
		balance: Math.max(0, totalCredits - totalUsage),
		totalCredits,
		totalUsage,
		usedPercent: totalCredits > 0 ? (totalUsage / totalCredits) * 100 : 0,
		source: "openrouter-credits",
		capturedAt: Date.now(),
		ageMs: 0,
	};
}

/**
 * One-shot credit-balance fetch for the snapshot script, following
 * `fetchGLMQuotaOnce`: one call with the key it resolves, independent of the
 * poller's cache. Null on a missing key, a non-2xx status, a transport failure
 * or an unparsable body; never throws and never logs the key or the body.
 */
export async function fetchOpenRouterBalanceOnce(options: ProviderKeyOptions = {}): Promise<OpenRouterQuota | null> {
	const data = await getJson("/credits", options);
	return data ? parseQuota(data.data ?? data) : null;
}

async function fetchQuota(): Promise<OpenRouterQuota | null> {
	const parsed = await fetchOpenRouterBalanceOnce();
	cachedQuota = { value: parsed, at: Date.now() };
	return parsed;
}

export function readOpenRouterQuota(): OpenRouterQuota | null {
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
		source: age > CACHE_TTL_MS ? "openrouter-credits-stale" : cachedQuota.value.source,
	};
}

export function startOpenRouterPoller(): void {
	if (pollTimer) return;
	// Warm the cache immediately so the bar paints on first render.
	void fetchQuota();
	pollTimer = setInterval(() => { void fetchQuota(); }, POLL_INTERVAL_MS);
	pollTimer.unref?.();
}

export function stopOpenRouterPoller(): void {
	if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ─── Live per-provider pricing (discounts) ───────────────────────────────

function parsePricing(modelId: string, data: any): OpenRouterPricing | null {
	const endpoints = data?.data?.endpoints;
	if (!Array.isArray(endpoints) || endpoints.length === 0) return null;
	const byProvider: Record<string, number> = {};
	const ratesByProvider: Record<string, { inputPerM: number; outputPerM: number; cacheReadPerM: number | null }> = {};
	let bestProvider: string | null = null;
	let bestDiscount: number | null = null;
	for (const ep of endpoints) {
		const name = ep?.provider_name;
		if (typeof name !== "string" || !name) continue;
		const discount = Number(ep?.pricing?.discount ?? 0);
		byProvider[name] = Math.round((Number.isFinite(discount) ? discount : 0) * 100);
		// Absolute per-token pricing is always present on endpoints; expose it
		// per provider so the bar can show the serving provider's real $/M.
		const prompt = Number(ep?.pricing?.prompt);
		const completion = Number(ep?.pricing?.completion);
		if (Number.isFinite(prompt) && Number.isFinite(completion)) {
			const cacheRead = Number(ep?.pricing?.input_cache_read);
			ratesByProvider[name] = {
				inputPerM: prompt * 1e6,
				outputPerM: completion * 1e6,
				cacheReadPerM: Number.isFinite(cacheRead) ? cacheRead * 1e6 : null,
			};
		}
		if (ep?.status === 0 && (bestDiscount == null || byProvider[name]! > bestDiscount)) {
			bestProvider = name;
			bestDiscount = byProvider[name]!;
		}
	}
	if (bestProvider == null) {
		// No healthy endpoint annotated; fall back to the largest discount overall.
		for (const [name, d] of Object.entries(byProvider)) {
			if (bestDiscount == null || d > bestDiscount) { bestProvider = name; bestDiscount = d; }
		}
	}
	return {
		byProvider,
		ratesByProvider,
		bestProvider,
		bestDiscount,
		source: "openrouter-endpoints",
		capturedAt: Date.now(),
		ageMs: 0,
	};
}

/** Pure parser, exported for tests: raw /endpoints payload → discounts + absolute rates. */
export function parseOpenRouterEndpointsPricing(modelId: string, data: any): OpenRouterPricing | null {
	return parsePricing(modelId, data);
}

async function fetchPricing(modelId: string): Promise<OpenRouterPricing | null> {
	if (pricingInFlight) return cachedPricing.key === modelId ? cachedPricing.value : null;
	pricingInFlight = true;
	try {
		// Model id may be provider-qualified ("openrouter/deepseek/deepseek-v4-flash-0731").
		const slug = modelId.split("/").slice(-2).join("/");
		const encoded = slug.split("/").map(encodeURIComponent).join("/");
		const data = await getJson(`/models/${encoded}/endpoints`);
		const parsed = data ? parsePricing(modelId, data) : null;
		cachedPricing = { key: modelId, value: parsed, at: Date.now() };
		return parsed;
	} finally {
		pricingInFlight = false;
	}
}

export function readOpenRouterPricing(modelId: string): OpenRouterPricing | null {
	if (!modelId) return null;
	const now = Date.now();
	if (cachedPricing.key !== modelId || now - cachedPricing.at >= PRICING_TTL_MS) {
		queueMicrotask(() => { void fetchPricing(modelId); });
	}
	if (cachedPricing.key !== modelId || !cachedPricing.value) return null;
	const age = Math.max(0, now - cachedPricing.value.capturedAt);
	return {
		...cachedPricing.value,
		ageMs: age,
		source: age > PRICING_TTL_MS ? "openrouter-endpoints-stale" : cachedPricing.value.source,
	};
}

// ─── Per-request provider attribution ────────────────────────────────────

export async function fetchOpenRouterGenerationProvider(genId: string): Promise<string | null> {
	// OpenRouter finalizes the generation record ~5s after the response.
	// Retry with backoff so the status bar still converges to the actual
	// serving provider within a few seconds.
	const delays = [0, 2_000, 3_000, 5_000, 5_000];
	for (const delay of delays) {
		if (delay) await new Promise((r) => setTimeout(r, delay));
		const data = await getJson(`/generation?id=${encodeURIComponent(genId)}`);
		const name = data?.data?.provider_name;
		if (typeof name === "string" && name) return name;
	}
	return null;
}
