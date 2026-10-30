/**
 * Tavily credit reader.
 *
 * `GET https://api.tavily.com/usage` is Tavily's documented read-only usage call. Its `account`
 * object carries the plan's credits used (`plan_usage`) and allowed (`plan_limit`) for the current
 * cycle. The reading is the credits left, kept as a balance: the response states no reset day, so
 * no window and no reset time is invented. The key comes from `TAVILY_API_KEY`, through
 * `provider-key.ts`.
 */

import { missingKeyReason, providerApiKey, type ProviderKeyOptions } from "./provider-key.ts";

export interface TavilyBalance {
	/** Credits left in the current plan cycle. */
	balance: number;
	currency: "credits";
	source: "tavily-usage";
	capturedAt: number;
	ageMs: number;
}

const FETCH_TIMEOUT_MS = 8_000;
const ENDPOINT = "https://api.tavily.com/usage";
const KEY_OPTIONS = { envNames: ["TAVILY_API_KEY"] } as const satisfies ProviderKeyOptions;

/** Exported for focused, network-free parser tests. */
export function parseTavilyUsage(payload: unknown, capturedAt = Date.now()): TavilyBalance | null {
	if (!payload || typeof payload !== "object") return null;
	const account = (payload as { account?: { plan_usage?: unknown; plan_limit?: unknown } }).account;
	const used = account?.plan_usage;
	const limit = account?.plan_limit;
	if (typeof used !== "number" || typeof limit !== "number" || !Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
	return { balance: Math.max(0, limit - used), currency: "credits", source: "tavily-usage", capturedAt, ageMs: 0 };
}

/**
 * One call of the usage endpoint. It never logs the key or the body, and throws the cause of a
 * failed read: a missing key, a non-2xx status, a transport failure, or a body with no plan credits.
 */
export async function fetchTavilyBalanceOnce(options: ProviderKeyOptions = {}): Promise<TavilyBalance> {
	const key = providerApiKey("tavily", { ...options, ...KEY_OPTIONS });
	if (!key) throw new Error(missingKeyReason("tavily", { ...options, ...KEY_OPTIONS }));
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(ENDPOINT, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: controller.signal });
		if (!response.ok) throw new Error(`HTTP ${response.status} from api.tavily.com`);
		const balance = parseTavilyUsage(await response.json());
		if (balance === null) throw new Error("HTTP 200 from api.tavily.com but the body has no plan credits");
		return balance;
	} finally {
		clearTimeout(timeout);
	}
}
