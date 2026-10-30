/**
 * OpenRouter pricing reader tests — per-endpoint absolute pricing capture.
 * Pure parser checks; no network. Live endpoints data verified 2026-09-05:
 * each endpoint carries pricing.{prompt, completion, input_cache_read, discount}
 * in USD/token, plus a quantization field Runware lacks.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { parseOpenRouterEndpointsPricing } from "../openrouter-quota.ts";

const ENDPOINTS_FIXTURE = {
	data: {
		endpoints: [
			{
				provider_name: "Baidu",
				status: 0,
				pricing: { prompt: "0.00000004998", completion: "0.00000009996", input_cache_read: "0.000000009996", discount: 0.643 },
			},
			{
				provider_name: "Relace",
				status: 0,
				pricing: { prompt: "0.000000065", completion: "0.00000018", discount: 0 },
			},
		],
	},
};

test("openrouter endpoints parse captures per-provider discounts and absolute rates", () => {
	const p = parseOpenRouterEndpointsPricing("openrouter/deepseek/deepseek-v4-flash-0731", ENDPOINTS_FIXTURE);
	assert.ok(p, "endpoints pricing should parse");
	assert.equal(p!.byProvider["Baidu"], 64); // 0.643 → 64% (rounded)
	assert.equal(p!.bestProvider, "Baidu");
	const baidu = p!.ratesByProvider["Baidu"];
	assert.ok(baidu);
	assert.ok(Math.abs(baidu.inputPerM - 0.04998) < 1e-9);
	assert.ok(Math.abs(baidu.outputPerM - 0.09996) < 1e-9);
	assert.ok(Math.abs((baidu.cacheReadPerM ?? 0) - 0.009996) < 1e-9);
	const relace = p!.ratesByProvider["Relace"];
	assert.ok(relace);
	assert.equal(relace.cacheReadPerM, null);
});

test("openrouter endpoints parse returns null for empty or missing data", () => {
	assert.equal(parseOpenRouterEndpointsPricing("x", { data: { endpoints: [] } }), null);
	assert.equal(parseOpenRouterEndpointsPricing("x", null), null);
});
