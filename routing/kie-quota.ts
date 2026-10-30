/**
 * Kie credit balance reader.
 *
 * Kie is pay-as-you-go over a prepaid credit pool. `GET https://api.kie.ai/api/v1/chat/credit` is
 * Kie's documented read-only balance call: `{ code, msg, data }` where `data` is the remaining
 * credits. It spends nothing. The key comes from `KIE_API_KEY`, through `provider-key.ts`.
 */

import { missingKeyReason, providerApiKey, type ProviderKeyOptions } from "./provider-key.ts";

export interface KieBalance {
	/** Remaining credits. */
	balance: number;
	currency: "credits";
	source: "kie-credits";
	capturedAt: number;
	ageMs: number;
}

const FETCH_TIMEOUT_MS = 8_000;
const ENDPOINT = "https://api.kie.ai/api/v1/chat/credit";
const KEY_OPTIONS = { envNames: ["KIE_API_KEY"] } as const satisfies ProviderKeyOptions;

/** Exported for focused, network-free parser tests. */
export function parseKieCredit(payload: unknown, capturedAt = Date.now()): KieBalance | null {
	if (!payload || typeof payload !== "object") return null;
	const { code, data } = payload as { code?: unknown; data?: unknown };
	if (code !== 200 || typeof data !== "number" || !Number.isFinite(data)) return null;
	return { balance: data, currency: "credits", source: "kie-credits", capturedAt, ageMs: 0 };
}

/**
 * One call of the credit endpoint. It never logs the key or the body, and throws the cause of a
 * failed read: a missing key, a non-2xx status, a transport failure, or a body with no balance.
 */
export async function fetchKieBalanceOnce(options: ProviderKeyOptions = {}): Promise<KieBalance> {
	const key = providerApiKey("kie", { ...options, ...KEY_OPTIONS });
	if (!key) throw new Error(missingKeyReason("kie", { ...options, ...KEY_OPTIONS }));
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(ENDPOINT, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: controller.signal });
		if (!response.ok) throw new Error(`HTTP ${response.status} from api.kie.ai`);
		const balance = parseKieCredit(await response.json());
		if (balance === null) throw new Error("HTTP 200 from api.kie.ai but the body has no credit balance");
		return balance;
	} finally {
		clearTimeout(timeout);
	}
}
