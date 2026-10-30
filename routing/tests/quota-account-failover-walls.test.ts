/**
 * AR16: the wall a lane learns names the account that met it.
 *
 * `learnQuotaWall` records the wall under the account's own key, so one account's
 * quota wall never stops the other account of the same plan (AR14 design 3, and the
 * reason an account failover is possible at all). A provider whose plan holds one
 * account keeps today's bare key.
 *
 * The inventory is a fixture and the walls file is a scratch file: no live plan, key
 * or meter is read, and no value is ever read into a variable.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { learnQuotaWall, parsePoolConfig, type PoolConfig } from "../provider-pool.ts";

const CC = "command-code/deepseek/deepseek-v4.1-flash";
const MM = "minimax/MiniMax-M3.1-Flash";
const XAI = "xai/grok-4.6";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const FLASH_KINDS = ["ui", "copy", "test", "adapter", "config", "docs", "research-read"] as const;
const HARD_KINDS = ["retry", "unknown-cause-bug", "shared-owner", "security-data", "perf"] as const;

const SCRATCH = mkdtempSync(join(tmpdir(), "ar16-walls-"));

writeFileSync(
	join(SCRATCH, "inventory.json"),
	JSON.stringify({
		plans: [
			{
				provider: "command-code",
				name: "command-code",
				monthlyUsd: 10,
				source: "AR16 test fixture",
				readOn: "2026-10-27",
				kind: "subscription",
				accounts: [
					{ label: "first account", routed: true },
					{ label: "second account", envPrefix: "ACCT2_", routed: false },
				],
			},
		],
	}),
);
process.env.PI_SUBSCRIPTIONS_PATH = join(SCRATCH, "inventory.json");

function poolDoc(): Record<string, unknown> {
	const policy: Record<string, string[]> = {};
	for (const kind of FLASH_KINDS) policy[kind] = [CC, MM];
	for (const kind of HARD_KINDS) policy[kind] = [CC];
	policy.review = [XAI, "sonnet"];
	policy["product-pass"] = ["sonnet"];
	return {
		version: 1,
		virtualProvider: "pool",
		cooldownMs: HOUR,
		resetHorizonMs: 40 * DAY,
		freeRefs: [],
		roles: { worker: [CC, MM, XAI], classifier: ["jev/classifier"] },
		nonChatRoles: ["classifier"],
		laneDefaults: { pi: { candidates: [CC, MM], fallbackRole: "worker", hard: [CC] }, opencode: [MM], claude: "sonnet" },
		quotaShapes: [{ id: "wall", match: "QUOTA_WALL" }],
		routing: { pick: "off", slots: 10, claudeMax: 0, hardMax: 2, paused: [], policy, kindRules: {} },
	};
}

function config(): PoolConfig {
	const parsed = parsePoolConfig(poolDoc());
	assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join("; "));
	return (parsed as { ok: true; config: PoolConfig }).config;
}

/** The learned walls file, under a name of its own so one test reads only its own. */
function wallsFile(name: string): string {
	const path = join(SCRATCH, `walls-${name}.json`);
	process.env.PI_PROVIDER_WALLS_PATH = path;
	return path;
}

function learned(path: string): Record<string, { until: string; reason?: string }> {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, { until: string; reason?: string }>;
	} catch {
		return {};
	}
}

test("a Command Code wall is learned under the account the process reads", () => {
	const path = wallsFile("routed");
	learnQuotaWall(config(), CC, { shapeId: "weekly-plan-limit", resetAt: NOW + HOUR }, NOW);
	const walls = learned(path);
	assert.deepEqual(Object.keys(walls), ["command-code@first account"], "the routed account's own key, not the bare provider key");
	assert.equal(walls["command-code@first account"].until, new Date(NOW + HOUR).toISOString());
});

test("an explicit account names the account the wall belongs to", () => {
	const path = wallsFile("explicit");
	learnQuotaWall(config(), CC, { shapeId: "weekly-plan-limit", resetAt: NOW + HOUR }, NOW, "second account");
	assert.deepEqual(Object.keys(learned(path)), ["command-code@second account"], "the ACCT2_ account's own key");
});

test("a provider whose plan holds one account keeps today's bare key", () => {
	const path = wallsFile("single");
	learnQuotaWall(config(), MM, { shapeId: "weekly-plan-limit", resetAt: NOW + HOUR }, NOW);
	assert.deepEqual(Object.keys(learned(path)), ["minimax"], "an account only reaches a provider whose plan lists it");
});

test("the learned wall file carries no key value", () => {
	const path = wallsFile("no-key");
	learnQuotaWall(config(), CC, { shapeId: "weekly-plan-limit", resetAt: NOW + HOUR }, NOW, "second account");
	const written = readFileSync(path, "utf8");
	assert.doesNotMatch(written, /API_KEY|secret|token|sk-[A-Za-z0-9]/i, "only a key name and a clock are written");
});
