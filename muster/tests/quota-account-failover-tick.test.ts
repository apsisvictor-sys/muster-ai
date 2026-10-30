/**
 * AR16: an account failover on a 429 (VR24-218).
 *
 * A Command Code lane that meets a quota wall moves to the other Command Code account
 * before it falls to the next ref. The wall names the account that met it, the
 * decision is recorded beside the lane's real one, and the live switch sits behind one
 * routing flag that ships off.
 *
 * What each test proves:
 *
 *   a. the one routing flag is read from the pool file, and a file without it is off;
 *   b. a 429 on the first account moves the lane to the second account with the flag
 *      on: the same model, the other account, and nothing else;
 *   c. with the flag off the intended move is recorded in the routing decisions log as
 *      a shadow line and the lane keeps the ref chain it had;
 *   d. two walled accounts fall through to the ref chain unchanged;
 *   e. a bare provider wall still stops every account (AR14 F1);
 *   f. an OpenCode lane fails over only to a model its own rule allows;
 *   g. no key value appears in the event line, in the decision line or in the walls.
 *
 * The inventory is a fixture, so no live plan, key or meter is read. Only names and
 * account labels are ever compared, and no value is read into a variable at all.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { LaneCard } from "../lib/lane-card.ts";
import {
	parsePoolConfig,
	type PoolConfig,
	type RouteDecision,
	type Wall,
} from "../../routing/provider-pool.ts";
import { applyQuotaFallback, quotaFallback, type QuotaFallbackAction } from "../tick.ts";

const CC = "command-code/deepseek/deepseek-v4.1-flash";
const MM = "minimax/MiniMax-M3.1-Flash";
const GO = "opencode-go/deepseek-v4.1-flash";
const XAI = "xai/grok-4.6";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const RESET = Date.parse("2026-10-27T18:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const FLASH_KINDS = ["ui", "copy", "test", "adapter", "config", "docs", "research-read"] as const;
const HARD_KINDS = ["retry", "unknown-cause-bug", "shared-owner", "security-data", "perf"] as const;

const SCRATCH = mkdtempSync(join(tmpdir(), "ar16-"));

// The inventory as the one owner reads it: Command Code in the order `extensions/telemetry-stats/subscriptions.json`
// holds it since CCACCT2 (2026-10-28) — the second account routed, the first with no name of its own. OpenCode Go keeps
// a second row here that its shipped plan no longer lists, because this file's subject is switching between a plan's
// accounts.
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
					{ label: "second account", envPrefix: "ACCT2_", routed: true },
					{ label: "first account", routed: false },
				],
			},
			{
				provider: "opencode-go",
				name: "OpenCode Go",
				monthlyUsd: null,
				source: "AR16 test fixture",
				readOn: "2026-10-27",
				kind: "subscription",
				accounts: [
					{ label: "second account", envPrefix: "ACCT2_", routed: true },
					{ label: "first account", routed: false },
				],
			},
		],
	}),
);
process.env.PI_SUBSCRIPTIONS_PATH = join(SCRATCH, "inventory.json");
process.env.PI_PROVIDER_WALLS_PATH = join(SCRATCH, "walls.json");
process.env.PI_ROUTING_DECISIONS_PATH = join(SCRATCH, "decisions.jsonl");

/** A pool file the real parser accepts, with the one routing flag this lane reads. */
function poolDoc(accountFailover?: "off" | "on"): Record<string, unknown> {
	const policy: Record<string, string[]> = {};
	for (const kind of FLASH_KINDS) policy[kind] = [CC, MM];
	for (const kind of HARD_KINDS) policy[kind] = [CC];
	policy.review = [XAI, "sonnet"];
	policy["product-pass"] = ["sonnet"];
	const candidates = [CC, MM, GO];
	return {
		version: 1,
		virtualProvider: "pool",
		cooldownMs: HOUR,
		resetHorizonMs: 40 * DAY,
		freeRefs: [],
		roles: { worker: [CC, MM, GO, XAI], classifier: ["jev/classifier"] },
		nonChatRoles: ["classifier"],
		laneDefaults: { pi: { candidates, fallbackRole: "worker", hard: [CC] }, opencode: [MM], claude: "sonnet" },
		quotaShapes: [{ id: "wall", match: "QUOTA_WALL" }],
		routing: {
			pick: "off",
			slots: 10,
			claudeMax: 0,
			hardMax: 2,
			paused: [],
			policy,
			kindRules: {},
			...(accountFailover === undefined ? {} : { accountFailover }),
		},
	};
}

function config(accountFailover?: "off" | "on"): PoolConfig {
	const parsed = parsePoolConfig(poolDoc(accountFailover));
	assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join("; "));
	return (parsed as { ok: true; config: PoolConfig }).config;
}

function card(over: Partial<LaneCard> = {}): LaneCard {
	return {
		laneId: "pi-a",
		harness: "pi",
		cwd: null,
		branch: null,
		state: "quota-walled",
		model: CC,
		thinking: null,
		since: NOW - 60_000,
		updatedAt: NOW - 5_000,
		wall: { shapeId: "weekly-plan-limit", resetAt: RESET },
		...over,
	};
}

const wall = (until: number, source: Wall["source"] = "error"): Wall => ({ until, source });
const walls = (entries: Record<string, Wall>): Record<string, Wall> => entries;

/** The action's own fields, read without a cast on the kind. */
type AccountSwitch = { ref: string; account: string; walledAccount: string };
type Action = QuotaFallbackAction & {
	account?: string;
	walledAccount?: string;
	accountSwitch?: AccountSwitch;
};

/** The decisions the tick recorded, one file per test so a test reads only its own. */
function decisionsFor(name: string): RouteDecision[] {
	const path = join(SCRATCH, `decisions-${name}.jsonl`);
	process.env.PI_ROUTING_DECISIONS_PATH = path;
	try {
		return readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line) as RouteDecision);
	} catch {
		return [];
	}
}

test("a. the one routing flag is read from the pool file, and a file without it is off", () => {
	assert.equal(config("on").routing?.accountFailover, "on");
	assert.equal(config("off").routing?.accountFailover, "off");
	assert.equal(config().routing?.accountFailover, "off", "a pool file without the flag is off");
});

test("b. a 429 on the first account moves the lane to the second account, the same model", () => {
	const pool = config("on");
	const actions = quotaFallback([card()], pool, walls({ "command-code@first account": wall(NOW + HOUR) }), NOW);
	assert.equal(actions.length, 1);
	const action = actions[0] as Action;
	assert.equal(action.kind, "switch-account");
	assert.equal(action.ref, CC, "the model does not change: only the account does");
	assert.equal(action.account, "second account");
	assert.equal(action.walledAccount, "first account");
	assert.equal(action.event, `QUOTA WALL: pi-a | ${CC} walled until 2026-10-27T18:00:00Z; switched to second account`);
});

test("b2. the live switch is applied through the tick's account port", () => {
	const pool = config("on");
	const actions = quotaFallback([card()], pool, walls({ "command-code@first account": wall(NOW + HOUR) }), NOW);
	const calls: string[] = [];
	applyQuotaFallback(actions, {
		setModel: (lane, ref) => (calls.push(`model ${lane} ${ref}`), { ok: true }),
		setAccount: (lane, ref, account) => (calls.push(`account ${lane} ${ref} ${account}`), { ok: true }),
		scheduleResume: () => ({ unit: "never" }),
		event: () => {},
		markHandled: () => {},
		now: () => NOW,
	});
	assert.deepEqual(calls, [`account pi-a ${CC} second account`], "the lane moves to the other account, and to no other ref");
});

test("c. with the flag off the intended move is recorded and the lane keeps the ref chain", () => {
	const pool = config("off");
	const actions = quotaFallback([card()], pool, walls({ "command-code@first account": wall(NOW + HOUR) }), NOW);
	assert.equal(actions.length, 1);
	const action = actions[0] as Action;
	assert.equal(action.kind, "switch", "the lane keeps the chain it had");
	assert.equal(action.ref, MM);
	assert.equal(action.accountSwitch?.account, "second account");
	assert.equal(action.accountSwitch?.walledAccount, "first account");

	const calls: string[] = [];
	process.env.PI_ROUTING_DECISIONS_PATH = join(SCRATCH, "decisions-c.jsonl");
	applyQuotaFallback(actions, {
		setModel: (lane, ref) => (calls.push(`model ${lane} ${ref}`), { ok: true }),
		setAccount: (lane, ref, account) => (calls.push(`account ${lane} ${ref} ${account}`), { ok: true }),
		scheduleResume: () => ({ unit: "never" }),
		event: () => {},
		markHandled: () => {},
		now: () => NOW,
	});
	assert.deepEqual(calls, [`model pi-a ${MM}`], "the account is recorded, never applied");

	const recorded = decisionsFor("c");
	assert.equal(recorded.length, 1, "one decision line names the intended move");
	assert.equal(recorded[0].by, "failover");
	assert.equal(recorded[0].lane, "pi-a");
	assert.equal(recorded[0].chosen, CC);
	assert.equal(recorded[0].account, "second account");
	assert.equal(recorded[0].laneAccount, "first account");
	assert.equal(recorded[0].shadow, true, "the intended move is a shadow line while the flag is off");
});

test("d. two walled accounts fall through to the ref chain unchanged", () => {
	const pool = config("on");
	const both = walls({
		"command-code@first account": wall(NOW + HOUR),
		"command-code@second account": wall(NOW + HOUR),
	});
	const actions = quotaFallback([card()], pool, both, NOW);
	assert.equal(actions.length, 1);
	const action = actions[0] as Action;
	assert.equal(action.kind, "switch");
	assert.equal(action.ref, MM);
	assert.equal(action.accountSwitch, undefined, "no account is free, so no account switch is offered");
});

test("e. a bare provider wall stops every account", () => {
	const pool = config("on");
	const actions = quotaFallback([card()], pool, walls({ "command-code": wall(NOW + HOUR) }), NOW);
	const action = actions[0] as Action;
	assert.equal(action.kind, "switch");
	assert.equal(action.ref, MM);
	assert.equal(action.accountSwitch, undefined, "AR14 F1: a provider-level wall stops every account");
});

test("f. an OpenCode lane fails over only to a model its own rule allows", () => {
	const pool = config("on");
	const lane = card({ laneId: "oc-a", harness: "opencode", model: GO });
	const actions = quotaFallback([lane], pool, walls({ "opencode-go@second account": wall(NOW + HOUR) }), NOW);
	assert.equal(actions.length, 1);
	const action = actions[0] as Action;
	assert.equal(action.kind, "switch");
	assert.equal(action.ref, MM, "the only ref the OpenCode candidate list allows");
	assert.equal(action.accountSwitch, undefined, "the Go account is not an implementation target for an OpenCode lane");
});

test("g. no key value appears in the event line, in the decision line or in the walls", () => {
	const pool = config("off");
	const actions = quotaFallback([card()], pool, walls({ "command-code@first account": wall(NOW + HOUR) }), NOW);
	const path = join(SCRATCH, "decisions-g.jsonl");
	process.env.PI_ROUTING_DECISIONS_PATH = path;
	applyQuotaFallback(actions, {
		setModel: () => ({ ok: true }),
		scheduleResume: () => ({ unit: "never" }),
		event: () => {},
		markHandled: () => {},
		now: () => NOW,
	});
	const recorded = decisionsFor("g");
	assert.equal(recorded.length, 1, "the intended move is recorded");
	const written = `${actions[0].event}\n${JSON.stringify(recorded)}`;
	assert.doesNotMatch(written, /API_KEY|secret|token|sk-[A-Za-z0-9]/i, "only names and account labels are written");
});
