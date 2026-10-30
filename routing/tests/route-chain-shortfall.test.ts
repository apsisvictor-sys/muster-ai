/**
 * Findings 7, 8 and 12 of the router architecture (architecture-v2 §11; §0, §2 item 5, §4 step 5): a role that
 * cannot be placed says so, and the shortfall is read off the verdicts the ranking produced.
 *
 * - the invariant is two placeable refs across two providers, or a record naming every ref and its reason, so
 *   two refs both behind a wall or a cap report a shortfall instead of passing on the policy's length;
 * - alternates are the policy's own ranked list: there is no substitutes list to duplicate `routing.policy` or
 *   `rankLaneRoutes`, and nothing here or in the file names one;
 * - a reviewer-family preference reorders the placeable refs and never empties the role.
 *
 * The rounds of the property run are seeded, so a failure reproduces exactly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	parsePoolConfig,
	placeLaneModel,
	providerOf,
	readRoutingSnapshot,
	TASK_KINDS,
	type LanePlacement,
	type PoolConfig,
	type RoutingSnapshot,
	type TaskKind,
	type Wall,
} from "../provider-pool.ts";

const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const CC = "command-code/deepseek/deepseek-v4.1-flash";
const MM = "minimax/MiniMax-M3.1-Flash";
const ZAI = "zai/glm-5.3-flash";
const XAI = "xai/grok-4.6";
const SONNET = "sonnet";

// AR12's inventory is read by every placement; a path that holds no plan means nothing refills, so these cases
// read exactly the windows their own fixtures carry.
process.env.PI_SUBSCRIPTIONS_PATH = join(mkdtempSync(join(tmpdir(), "chain-shortfall-inventory-")), "no-inventory.json");

const sec = (ms: number): number => Math.floor(ms / 1000);

/** A snapshot in the monitor's own shape, read back by the reader every caller uses. */
function reading(providers: unknown[], capturedAt: number = NOW): RoutingSnapshot {
	const path = join(mkdtempSync(join(tmpdir(), "chain-shortfall-snapshot-")), "snapshot.json");
	writeFileSync(path, JSON.stringify({ version: 1, capturedAt, providers }));
	const snapshot = readRoutingSnapshot(path);
	assert.ok(snapshot, "the fixture reads back as a snapshot");
	return snapshot;
}

/** One row with a 5-hour and a weekly window, the pair most plans report. */
const row = (provider: string, fiveHour: number, weekly: number, weeklyResetsAt: number = NOW + 5 * DAY): unknown => ({
	provider,
	quota: {
		primary: { usedPercent: fiveHour, windowMinutes: 300, resetsAt: sec(NOW + 2 * HOUR) },
		secondary: { usedPercent: weekly, windowMinutes: 10_080, resetsAt: sec(weeklyResetsAt) },
	},
});

interface PoolOptions {
	policy?: Partial<Record<TaskKind, string[]>>;
	paused?: string[];
	claudeMax?: number;
	hardMax?: number;
	hard?: string[];
	candidates?: string[];
}

/** The kinds the parser requires `laneDefaults.pi.hard` to cover, because a hard kind never lands on a flash ref. */
const HARD_KINDS = ["retry", "unknown-cause-bug", "shared-owner", "security-data", "perf"] as const;

/** The shipped policy's shape: every kind has a list, so the file parses the way the launcher's does. */
function seedPolicy(hard: readonly string[]): Record<string, string[]> {
	const policy: Record<string, string[]> = {};
	for (const kind of TASK_KINDS) policy[kind] = [CC, MM, ZAI];
	for (const kind of HARD_KINDS) policy[kind] = [...hard];
	policy.review = [XAI, SONNET];
	policy["product-pass"] = [SONNET];
	return policy;
}

/** A whole pool document, parsed by the real parser, so every case places against a config the launcher accepts. */
function pool(options: PoolOptions = {}): PoolConfig {
	const hard = options.hard ?? [XAI];
	const doc = {
		version: 1,
		virtualProvider: "pool",
		cooldownMs: HOUR,
		resetHorizonMs: 40 * DAY,
		providerWalls: {},
		roles: { worker: [CC, MM, ZAI, XAI], classifier: ["jev/classifier"] },
		freeRefs: [],
		employerAccounts: [],
		nonChatRoles: ["classifier"],
		laneDefaults: {
			pi: { candidates: options.candidates ?? [CC, MM], fallbackRole: "worker", hard },
			opencode: [MM],
			claude: SONNET,
		},
		quotaShapes: [{ id: "wall", match: "QUOTA_WALL" }],
			routing: {
			pick: "on",
			slots: 7,
			claudeMax: options.claudeMax ?? 2,
			hardMax: options.hardMax ?? 2,
			paused: options.paused ?? [],
			policy: { ...seedPolicy(hard), ...(options.policy ?? {}) },
			kindRules: {},
		},
	};
	const parsed = parsePoolConfig(doc);
	assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join("; "));
	const warnings = (parsed as { warnings?: string[] }).warnings;
	assert.equal(warnings, undefined, `the fixture file is valid: ${(warnings ?? []).join("; ")}`);
	return (parsed as { ok: true; config: PoolConfig }).config;
}

/** The refs a placement records as unable to serve, by ref. */
function unplaceable(placement: LanePlacement): string[] {
	return (placement.shortfall?.notPlaceable ?? []).map((entry) => entry.ref);
}

/** The refs a placement can serve from, by ref. */
function placeable(placement: LanePlacement): string[] {
	return (placement.shortfall?.placeable ?? []).map((entry) => entry.ref);
}

// ─── the invariant itself: placeable verdicts, never raw refs ──────────────────────────────────

test("a role whose two refs are both capped reports a shortfall naming both, where a raw-ref count reads two providers", () => {
	// Two refs, two providers: a check over the raw list would say this role is fine. One ref is behind a wall
	// and the other's weekly window is spent, so nothing can take the lane and both must be named.
	const config = pool({ policy: { ui: [CC, MM] } });
	assert.equal(new Set([providerOf(CC), providerOf(MM)]).size, 2, "the policy names two providers");
	const walls = { "command-code": { until: NOW + 3 * HOUR, reason: "quota wall", source: "error" as const } };
	const spent = reading([row("minimax", 10, 100)]);
	const placement = placeLaneModel(config, { harness: "pi", now: NOW, kind: "ui", walls, snapshot: spent });

	assert.equal(placement.status, "wait", "no ref can take the lane");
	assert.ok(placement.shortfall, "a wait carries the shortfall");
	assert.equal(placement.shortfall.ok, false, "two placeable refs across two providers is not met");
	assert.deepEqual(placeable(placement), [], "nothing is placeable");
	assert.deepEqual(unplaceable(placement).sort(), [CC, MM].sort(), "both refs are named");
	const cc = placement.shortfall.notPlaceable.find((entry) => entry.ref === CC);
	const mm = placement.shortfall.notPlaceable.find((entry) => entry.ref === MM);
	assert.match(cc?.reason ?? "", /walled until/, `the wall is the reason it cannot serve: ${cc?.reason}`);
	assert.match(mm?.reason ?? "", /excluded: .*100 percent/, `the spent window is the reason it cannot serve: ${mm?.reason}`);
	assert.match(placement.shortfall.reason ?? "", /no placeable ref/, "the shortfall says the role has nothing");
	for (const ref of [CC, MM]) assert.ok((placement.shortfall.reason ?? "").includes(ref), `the reason names ${ref}`);
});

test("the property run: random walls, caps and spent windows leave every role with two placeable refs across two providers or a shortfall naming each ref", () => {
	const REFS = [CC, MM, ZAI, XAI];
	const KINDS: readonly TaskKind[] = ["ui", "review", "shared-owner"];
	const ROUNDS = 150;

	function mulberry32(seed: number): () => number {
		let state = seed >>> 0;
		return () => {
			state = (state + 0x6d2b79f5) >>> 0;
			let value = state;
			value = Math.imul(value ^ (value >>> 15), value | 1);
			value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
			return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
		};
	}

	for (let round = 0; round < ROUNDS; round += 1) {
		const random = mulberry32(round + 1);
		const choose = (least: number, pool: readonly string[]): string[] => {
			const shuffled = [...pool].sort(() => random() - 0.5);
			return shuffled.slice(0, least + Math.floor(random() * (pool.length - least + 1)));
		};
		const kind = KINDS[Math.floor(random() * KINDS.length)] as TaskKind;
		const policy = choose(1, REFS);
		const paused = random() < 0.3 ? choose(1, policy) : [];
		const walls: Record<string, Wall> = {};
		const rows: unknown[] = [];
		for (const ref of REFS) {
			const provider = providerOf(ref);
			if (random() < 0.3) walls[provider] = { until: NOW + HOUR, reason: "quota wall", source: "error" as const };
			if (random() < 0.5) {
				const weekly = random() < 0.25 ? 100 : random() < 0.5 ? 96 : Math.floor(random() * 90);
				rows.push(row(provider, Math.floor(random() * 100), weekly, NOW + DAY));
			}
		}
		const config = pool({
			policy: { [kind]: policy } as Partial<Record<TaskKind, string[]>>,
			paused,
			...(HARD_KINDS.includes(kind as (typeof HARD_KINDS)[number]) ? { hard: policy } : {}),
			claudeMax: Math.floor(random() * 3),
			hardMax: Math.floor(random() * 3),
		});
		const snapshot = rows.length === 0 ? undefined : reading(rows);
		// A flash kind recorded as hard is the other way a ref is dropped after the ranking: `blocked()`'s hard-class rule.
		const asHardClass = !HARD_KINDS.includes(kind as (typeof HARD_KINDS)[number]) && random() < 0.3;
		const input = { now: NOW, kind, walls, ...(asHardClass ? { class: "H3" as const } : {}), ...(snapshot === undefined ? {} : { snapshot }) };
		const placement = placeLaneModel(config, input);
		const where = `round ${round}, kind ${kind}, policy ${policy.join(", ")}, paused ${paused.join(", ") || "none"}`;

		assert.notEqual(placement.status, "off", where);
		assert.ok(placement.shortfall, `${where}: every placement but off carries the coverage record`);
		const shortfall = placement.shortfall;
		assert.ok(shortfall !== undefined, where);

		// Every ref of the kind's list is either placeable or named with a reason: the record never drops one.
		const recorded = new Set([...placeable(placement), ...unplaceable(placement)]);
		for (const ref of policy) assert.ok(recorded.has(ref), `${where}: ${ref} is accounted for`);
		for (const entry of shortfall.notPlaceable) assert.ok(entry.reason.trim() !== "", `${where}: ${entry.ref} carries a reason`);

		// The invariant is the placeable count and the provider count, never the policy's length.
		assert.equal(shortfall.ok, shortfall.placeable.length >= 2 && shortfall.providers.length >= 2, `${where}: ok is two refs on two providers`);
		if (!shortfall.ok) {
			assert.ok((shortfall.reason ?? "").trim() !== "", `${where}: a shortfall is never empty`);
			for (const entry of shortfall.notPlaceable) assert.ok((shortfall.reason ?? "").includes(entry.ref), `${where}: the reason names ${entry.ref}`);
		} else {
			assert.equal(shortfall.reason, undefined, `${where}: a role that is covered has no shortfall reason`);
		}

		// Nothing is placed that the record does not call placeable, and a wait says why.
		if (placement.status === "placed") assert.ok(placeable(placement).includes(placement.ref as string), `${where}: the placed ref is placeable`);
		if (placement.status === "wait") assert.ok(placement.reason.trim() !== "", `${where}: a wait carries its reason`);
		if (shortfall.placeable.length === 0) assert.equal(placement.status, "wait", `${where}: nothing placeable means nothing is placed`);

		// Same inputs, same answer: the record is derived, not sampled.
		assert.deepEqual(placeLaneModel(config, input), placement, `${where}: the same inputs place the same way`);
	}
});

// ─── alternates: the policy's own order, no substitutes list ───────────────────────────────────

test("a policy-derived alternate is placed when the head is walled, with no substitutes list anywhere", () => {
	const config = pool({ policy: { ui: [CC, MM] } });
	assert.ok(!("substitutes" in config), "the pool carries no substitutes list");
	const walls = { "command-code": { until: NOW + HOUR, reason: "quota wall", source: "error" as const } };
	const placement = placeLaneModel(config, { harness: "pi", now: NOW, kind: "ui", walls });

	assert.equal(placement.status, "placed");
	assert.equal(placement.ref, MM);
	assert.ok(!("substitutes" in placement), "the placement carries no substitutes list");
	assert.deepEqual(placeable(placement), [MM], "the alternate is the policy's next entry, read off the ranking");
	assert.deepEqual(unplaceable(placement), [CC], "the head of the policy is named, with the wall as its reason");
	assert.match(placement.shortfall?.notPlaceable[0]?.reason ?? "", /walled until/, "the reason is the ranking's own line");
	assert.equal(placement.shortfall?.ok, false, "one placeable ref is a shortfall even though a lane was placed");
	assert.match(placement.shortfall?.reason ?? "", /one placeable ref/, "the shortfall says the role has no second ref");
});

// ─── family: a preference, never a rule that empties the role ─────────────────────────────────

test("a reviewer family preference is honoured among placeable refs and never empties the role", () => {
	const config = pool({ policy: { review: [XAI, MM] } });
	const familyOf = (ref: string): string | undefined =>
		ref === XAI ? "grok" : ref === MM ? "minimax" : undefined;

	// Honoured: the family the caller avoids is the head of the policy, and the differing ref is placed.
	const honoured = placeLaneModel(config, {
		harness: "pi",
		now: NOW,
		kind: "review",
		family: { avoid: ["grok"], familyOf },
	});
	assert.equal(honoured.status, "placed");
	assert.equal(honoured.ref, MM, "the differing family wins over the policy's own order");
	assert.deepEqual(honoured.shortfall?.placeable.map((entry) => entry.ref).sort(), [MM, XAI].sort(), "both refs stay placeable");
	assert.equal(honoured.shortfall?.ok, true, "two placeable refs across two providers");

	// Never a filter: with every family avoided the policy's first ref places, and nothing was removed.
	const allAvoided = placeLaneModel(config, {
		harness: "pi",
		now: NOW,
		kind: "review",
		family: { avoid: ["grok", "minimax"], familyOf },
	});
	assert.equal(allAvoided.status, "placed", "an avoided family never leaves the role with nothing");
	assert.equal(allAvoided.ref, XAI, "the policy's order decides when the preference can express nothing");
	assert.deepEqual(placeable(allAvoided).sort(), [XAI, MM].sort(), "the preference removed no ref");
	assert.deepEqual(unplaceable(allAvoided), [], "the preference removed no ref");

	// And it never overrules capacity: a walled ref stays out however its family reads.
	const walled = placeLaneModel(config, {
		harness: "pi",
		now: NOW,
		kind: "review",
		walls: { minimax: { until: NOW + HOUR, reason: "quota wall", source: "error" as const } },
		family: { avoid: ["grok"], familyOf },
	});
	assert.equal(walled.ref, XAI, "the only placeable ref places though its family is avoided");
	assert.deepEqual(unplaceable(walled), [MM], "the wall, not the family, is what keeps a ref out");
});
