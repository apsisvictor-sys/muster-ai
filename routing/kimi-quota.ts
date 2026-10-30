/**
 * Kimi Coding subscription quota reader.
 *
 * Kimi exposes GET https://api.kimi.com/coding/v1/usages to the same API key
 * used by Pi's `kimi-coding` provider. The response reports a top-level weekly
 * quota (`usage`) and one or more rolling windows (`limits`), including the
 * 300-minute / 5-hour window for the current Coding subscription.
 *
 * The endpoint is read-only. It is polled only while a Kimi Coding model is
 * active and cached between status-bar renders. The key comes from
 * `KIMI_API_KEY` or the stored `~/.pi/agent/auth.json` entry, in the one order
 * `provider-key.ts` owns.
 */

import { missingKeyReason, providerApiKey, type ProviderKeyOptions } from "./provider-key.ts";
import type { RateLimitWindow } from "./codex-quota.ts";

export interface KimiQuota {
	primary: RateLimitWindow | null;
	secondary: RateLimitWindow | null;
	planType: string | null;
	source: "kimi-coding-usage";
	capturedAt: number;
	ageMs: number;
}

const CACHE_TTL_MS = 30_000;
const POLL_INTERVAL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;
const ENDPOINT = "https://api.kimi.com/coding/v1/usages";

let cached: { value: KimiQuota | null; at: number } = { value: null, at: 0 };
let pollTimer: ReturnType<typeof setInterval> | null = null;

function resolveApiKey(options: ProviderKeyOptions = {}): string | null {
	return providerApiKey("kimi-coding", options);
}

function toNumber(value: unknown): number | null {
	const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(number) ? number : null;
}

function resetEpoch(value: unknown): number | null {
	if (typeof value !== "string" && typeof value !== "number") return null;
	const parsed = typeof value === "number" ? value : Date.parse(value);
	return Number.isFinite(parsed) ? Math.floor(parsed > 1_000_000_000_000 ? parsed / 1000 : parsed) : null;
}

function toWindow(detail: unknown, windowMinutes: number): RateLimitWindow | null {
	if (!detail || typeof detail !== "object" || !Number.isFinite(windowMinutes) || windowMinutes <= 0) return null;
	const record = detail as Record<string, unknown>;
	const limit = toNumber(record.limit);
	const used = toNumber(record.used);
	const resetsAt = resetEpoch(record.resetTime);
	if (limit == null || limit <= 0 || used == null || resetsAt == null) return null;
	return { usedPercent: Math.max(0, Math.min(100, (used / limit) * 100)), windowMinutes, resetsAt };
}

/** Exported for focused, network-free parser tests. */
export function parseKimiQuota(payload: unknown, capturedAt = Date.now()): KimiQuota | null {
	if (!payload || typeof payload !== "object") return null;
	const value = payload as Record<string, unknown>;
	const weekly = toWindow(value.usage, 7 * 24 * 60);
	const limits = Array.isArray(value.limits) ? value.limits : [];
	let primary: RateLimitWindow | null = null;
	for (const limit of limits) {
		if (!limit || typeof limit !== "object") continue;
		const record = limit as { window?: { duration?: unknown; timeUnit?: unknown }; detail?: unknown };
		const duration = toNumber(record.window?.duration);
		const unit = typeof record.window?.timeUnit === "string" ? record.window.timeUnit : "";
		const minutes = duration == null ? null : unit === "TIME_UNIT_HOUR" ? duration * 60 : unit === "TIME_UNIT_MINUTE" ? duration : null;
		const candidate = minutes == null ? null : toWindow(record.detail, minutes);
		if (candidate && (!primary || Math.abs(candidate.windowMinutes - 300) < Math.abs(primary.windowMinutes - 300))) primary = candidate;
	}
	if (!primary && !weekly) return null;
	const membership = (value.user as { membership?: { level?: unknown } } | undefined)?.membership?.level;
	return {
		primary,
		secondary: weekly,
		planType: typeof membership === "string" ? membership : null,
		source: "kimi-coding-usage",
		capturedAt,
		ageMs: Math.max(0, Date.now() - capturedAt),
	};
}

/**
 * One call of the usage endpoint with the key it resolves. It never logs the
 * key or the response body. It throws the cause of a failed read: a missing
 * key, a non-2xx status, a transport failure, or a body with no usage fields.
 */
async function fetchChecked(options: ProviderKeyOptions = {}): Promise<KimiQuota> {
	const key = resolveApiKey(options);
	if (!key) throw new Error(missingKeyReason("kimi-coding", options));
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(ENDPOINT, {
			headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": "KimiCLI/1.5" },
			signal: controller.signal,
		});
		if (!response.ok) throw new Error(`HTTP ${response.status} from api.kimi.com`);
		const quota = parseKimiQuota(await response.json());
		if (quota === null) throw new Error("HTTP 200 from api.kimi.com but the body has no usage or limits");
		return quota;
	} finally {
		clearTimeout(timeout);
	}
}

/** The poller's read: the same call, with every failure reading as no quota. */
async function fetchOnce(options: ProviderKeyOptions = {}): Promise<KimiQuota | null> {
	try {
		return await fetchChecked(options);
	} catch {
		return null;
	}
}

/**
 * One-shot fetch for the snapshot script, following `fetchGLMQuotaOnce`: one
 * call with the key it resolves, independent of the poller's cache. A failed
 * read throws its cause, so the snapshot row names it instead of reading as a
 * lost key.
 */
export async function fetchKimiQuotaOnce(options: ProviderKeyOptions = {}): Promise<KimiQuota> {
	return fetchChecked(options);
}

async function refreshCache(): Promise<void> {
	cached = { value: await fetchOnce(), at: Date.now() };
}

export function readKimiQuota(): KimiQuota | null {
	const now = Date.now();
	if (now - cached.at >= CACHE_TTL_MS) void refreshCache();
	return cached.value ? { ...cached.value, ageMs: Math.max(0, now - cached.value.capturedAt) } : null;
}

export function startKimiPoller(): void {
	if (pollTimer) return;
	void refreshCache();
	pollTimer = setInterval(() => { void refreshCache(); }, POLL_INTERVAL_MS);
	pollTimer.unref?.();
}

export function stopKimiPoller(): void {
	if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
