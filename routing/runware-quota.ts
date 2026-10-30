/**
 * Runware quota + pricing readers.
 *
 * Runware is strictly pay-as-you-go over a single unified-inference credit
 * pool (shared by image and LLM traffic). What serves the status bar:
 *   - remaining credit balance → POST /v1 (REST task API)
 *       [{ taskType: "accountManagement", taskUUID, operation: "getDetails" }]
 *       → data[0].balance
 *   - live per-model token pricing → GET /v1/models (OpenAI-style list)
 *       → data[].pricing.{prompt, completion, input_cache_read} in USD/token,
 *         ×1e6 for per-million rates.
 *
 * Cadence: balance refreshes every 5 minutes (warm on poller start, cached
 * 30 s for display); pricing refreshes lazily on a 10-minute TTL. No token
 * cost — these are plain REST calls.
 */

import { missingKeyReason, providerApiKey, type ProviderKeyOptions } from "./provider-key.ts";

export interface RunwareQuota {
	/** Remaining credits in USD. */
	balance: number;
	/** The unit of `balance`; the credit pool is USD. */
	currency: "USD";
	source: "runware-credits" | "runware-credits-stale";
	capturedAt: number;
	ageMs: number;
}

export interface RunwareModelRates {
	/** USD per million input (prompt) tokens. */
	inputPerM: number;
	/** USD per million output (completion) tokens. */
	outputPerM: number;
	/** USD per million cache-read tokens, when reported. */
	cacheReadPerM: number | null;
	source: "runware-models" | "runware-models-stale";
	capturedAt: number;
	ageMs: number;
}

const CACHE_TTL_MS = 30_000;
const POLL_INTERVAL_MS = 5 * 60_000;
const PRICING_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

const API_BASE = "https://api.runware.ai/v1";

let cachedQuota: { value: RunwareQuota | null; at: number } = { value: null, at: 0 };
let cachedPricing: { key: string; value: RunwareModelRates | null; at: number } = { key: "", value: null, at: 0 };
let pricingInFlight = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function apiKey(options: ProviderKeyOptions = {}): string | undefined {
	return providerApiKey("runware", options) ?? undefined;
}

function uuid(): string {
	if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
		const r = (Math.random() * 16) | 0;
		return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
	});
}

/** POST to the task API. Throws the cause of a failed call: no key, a non-2xx status or a transport failure. */
async function postJson(body: unknown[], options: ProviderKeyOptions = {}): Promise<any> {
	const key = apiKey(options);
	if (!key) throw new Error(missingKeyReason("runware", options));
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(`${API_BASE}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		if (!res.ok) throw new Error(`HTTP ${res.status} from api.runware.ai`);
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
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

function parseQuota(data: any): RunwareQuota | null {
	const balance = Number(data?.balance);
	if (!Number.isFinite(balance)) return null;
	return {
		balance: Math.max(0, balance),
		currency: "USD",
		source: "runware-credits",
		capturedAt: Date.now(),
		ageMs: 0,
	};
}

/**
 * One-shot credit-balance fetch for the snapshot script, following
 * `fetchGLMQuotaOnce`: one call with the key it resolves, independent of the
 * poller's cache. A failed read throws its cause (no key, non-2xx status,
 * transport failure, a body without a balance); it never logs the key or the
 * body.
 */
export async function fetchRunwareBalanceOnce(options: ProviderKeyOptions = {}): Promise<RunwareQuota> {
	const payload = await postJson([{ taskType: "accountManagement", taskUUID: uuid(), operation: "getDetails" }], options);
	const quota = parseQuota(payload?.data?.[0]);
	if (quota === null) throw new Error("HTTP 200 from api.runware.ai but the body has no balance");
	return quota;
}

async function fetchQuota(): Promise<RunwareQuota | null> {
	let parsed: RunwareQuota | null = null;
	try {
		parsed = await fetchRunwareBalanceOnce();
	} catch {
		// The poller reads a failed call as no balance.
	}
	cachedQuota = { value: parsed, at: Date.now() };
	return parsed;
}

export function readRunwareQuota(): RunwareQuota | null {
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
		source: age > CACHE_TTL_MS ? "runware-credits-stale" : cachedQuota.value.source,
	};
}

export function startRunwarePoller(): void {
	if (pollTimer) return;
	// Warm the cache immediately so the bar paints on first render.
	void fetchQuota();
	pollTimer = setInterval(() => { void fetchQuota(); }, POLL_INTERVAL_MS);
	pollTimer.unref?.();
}

export function stopRunwarePoller(): void {
	if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ─── Live per-model token pricing ────────────────────────────────────────

/**
 * Runware serves models under dashed REST ids ("zai-glm-5-3-flash") while
 * Pi references AIR ids ("zai:glm@5.3-flash"). Normalize both sides to the
 * same dashed form before matching.
 */
function normalizeModelId(id: string): string {
	return id.toLowerCase().replace(/[:@._]/g, "-");
}

function parsePricing(modelId: string, data: any): RunwareModelRates | null {
	const parsed = parseRunwarePricingData(modelId, data);
	return parsed;
}

/** Pure parser, exported for tests: raw /v1/models payload → per-million rates. */
export function parseRunwarePricingData(modelId: string, data: any): RunwareModelRates | null {
	const models = data?.data;
	if (!Array.isArray(models)) return null;
	const wanted = normalizeModelId(modelId);
	const entry = models.find((m: any) => normalizeModelId(String(m?.id ?? "")) === wanted)
		?? models.find((m: any) => normalizeModelId(String(m?.name ?? "")) === wanted);
	const pricing = entry?.pricing;
	const prompt = Number(pricing?.prompt);
	const completion = Number(pricing?.completion);
	if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
	const cacheRead = Number(pricing?.input_cache_read);
	return {
		inputPerM: prompt * 1e6,
		outputPerM: completion * 1e6,
		cacheReadPerM: Number.isFinite(cacheRead) ? cacheRead * 1e6 : null,
		source: "runware-models",
		capturedAt: Date.now(),
		ageMs: 0,
	};
}

async function fetchPricing(modelId: string): Promise<RunwareModelRates | null> {
	if (pricingInFlight) return cachedPricing.key === modelId ? cachedPricing.value : null;
	pricingInFlight = true;
	try {
		const data = await getJson("/models");
		const parsed = data ? parsePricing(modelId, data) : null;
		cachedPricing = { key: modelId, value: parsed, at: Date.now() };
		return parsed;
	} finally {
		pricingInFlight = false;
	}
}

export function readRunwarePricing(modelId: string): RunwareModelRates | null {
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
		source: age > PRICING_TTL_MS ? "runware-models-stale" : cachedPricing.value.source,
	};
}
