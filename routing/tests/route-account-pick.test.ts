/**
 * AR14: the account pick inside a provider (VR24-206) and a launch that never starts a provider whose key is absent
 * (VR24-213).
 *
 * Spec: `plans/orchestration-2026-10-05/specs/auto-routing-blueprint-2026-10-25.md`, revision 2026-10-26 23:25,
 * design 1 to 5 and acceptance a to f, plus (g). What each test proves:
 *
 *   a. two accounts of one plan, the one with more spare allowance in its tightest window is chosen, and a spent
 *      window on it excludes it so the other is chosen;
 *   b. a refilling 5-hour window that is open outranks a closed one inside one provider, and each account's own
 *      window is read — one account's open window never speaks for the other;
 *   c. a wall on one account leaves the other's refs rankable, and the wall keys are per account;
 *   d. `run-as --account` maps the account's prefixed key names to the plain names in the child only (the case
 *      lives beside the other `run-as` rules, in `secrets-run-as.test.ts`);
 *   e. a process with no placement behaves exactly as before: `pick: off` places nothing, a ref without an account
 *      reads the routed row and today's wall key, and an account a provider does not hold changes no key;
 *   f. the decision line names the account the rule would pick and the account the lane used — through the
 *      launcher's own door, `harness/muster/lane-model.mjs`, reading the log back;
 *   g. the same door skips a provider whose key name is absent as `unconfigured` and starts nothing, never a lane
 *      on the absent key.
 *
 * The inventory is a fixture, so no live plan, key or meter is read; the key names are the only thing a presence
 * check touches, and no value appears in an argument, an output or a log.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	accountWallKey,
	parsePoolConfig,
	placeLaneModel,
	rankLaneRoutes,
	wallKey,
	type PoolConfig,
	type RouteDecision,
	type RoutingSnapshot,
	type RoutingUsageRow,
	type Wall,
} from "../provider-pool.ts";
import { harnessRoot } from "../../core/harness-paths.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
const CLI = join(HARNESS_ROOT, "muster", "lane-model.mjs");

// Now, not a fixed instant: the launcher's helper only reads a snapshot it judges fresh, so a fixture dated in the past
// or the future would leave the door with no meter at all and the test would pass for the wrong reason.
const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const CC = "command-code/deepseek/deepseek-v4.1-flash";
const MM = "minimax/MiniMax-M3.1-Flash";
const ZAI = "zai/glm-5.3-flash";
const GO = "opencode-go/deepseek-v4.1-flash";
const XAI = "xai/grok-4.6";

const FLASH_KINDS = ["ui", "copy", "test", "adapter", "config", "docs", "research-read"] as const;
const HARD_KINDS = ["retry", "unknown-cause-bug", "shared-owner", "security-data", "perf"] as const;

const SCRATCH = mkdtempSync(join(tmpdir(), "ar14-"));
// A missing inventory names no plan, exactly as it does before A-2: each test that needs accounts points this at its
// own fixture file and puts the previous value back.
process.env.PI_SUBSCRIPTIONS_PATH = join(SCRATCH, "no-inventory.json");
process.env.PI_PROVIDER_WALLS_PATH = join(SCRATCH, "no-walls.json");
process.env.PI_USAGE_SNAPSHOT_PATH = join(SCRATCH, "no-snapshot.json");

// ─── Fixtures ────────────────────────────────────────────────────────────────

interface AccountFixture {
	label: string;
	routed: boolean;
	envPrefix?: string;
}

interface PlanFixture {
	provider: string;
	accounts: AccountFixture[];
	refills?: boolean;
}

/** The inventory as the one owner reads it: the four original fields plus the account list A-2 added. */
function inventoryDoc(plans: readonly PlanFixture[]): unknown {
	return {
		plans: plans.map((plan) => ({
			provider: plan.provider,
			name: plan.provider,
			monthlyUsd: null,
			source: "AR14 test fixture",
			readOn: "2026-10-27",
			kind: "subscription",
			...(plan.refills === true ? { refills: true } : {}),
			accounts: plan.accounts.map((account) => ({
				label: account.label,
				routed: account.routed,
				...(account.envPrefix === undefined ? {} : { envPrefix: account.envPrefix }),
			})),
		})),
	};
}

/** Point the inventory reader at one fixture for the duration of `run`, then put the previous path back. */
function withInventory(plans: readonly PlanFixture[], run: () => void): void {
	const path = join(SCRATCH, `inventory-${Math.random().toString(16).slice(2)}.json`);
	writeFileSync(path, JSON.stringify(inventoryDoc(plans)));
	const prior = process.env.PI_SUBSCRIPTIONS_PATH;
	process.env.PI_SUBSCRIPTIONS_PATH = path;
	try {
		run();
	} finally {
		process.env.PI_SUBSCRIPTIONS_PATH = prior;
	}
}

/** The command-code pair as the shipped inventory holds it: the first pair is routed, the second carries `ACCT2_`. */
const CC_PAIR: readonly AccountFixture[] = [
	{ label: "first account", routed: true },
	{ label: "second account", routed: false, envPrefix: "ACCT2_" },
];

/** A pool file the real parser accepts, with the kind's own list given. */
function poolDoc(ui: readonly string[] = [CC, MM, ZAI], pick: "off" | "shadow" | "on" = "on"): Record<string, unknown> {
	const policy: Record<string, string[]> = {};
	for (const kind of FLASH_KINDS) policy[kind] = [...ui];
	policy.review = [XAI, "sonnet"];
	policy["product-pass"] = ["sonnet"];
	for (const kind of HARD_KINDS) policy[kind] = [CC];
	const candidates = [...new Set([...ui, CC])];
	return {
		version: 1,
		virtualProvider: "pool",
		cooldownMs: HOUR,
		resetHorizonMs: 40 * DAY,
		freeRefs: [],
		// The review kind's own ref is pooled through a role, as the shipped file pools it; the placement still reads
		// the kind's list, which is what each test states.
		roles: { worker: [...new Set([...candidates, XAI])], classifier: ["jev/classifier"] },
		nonChatRoles: ["classifier"],
		laneDefaults: { pi: { candidates, fallbackRole: "worker", hard: [CC] }, opencode: [MM], claude: "sonnet" },
		quotaShapes: [{ id: "wall", match: "QUOTA_WALL" }],
		routing: { pick, slots: 10, claudeMax: 0, hardMax: 2, paused: [], policy, kindRules: {} },
	};
}

function config(ui: readonly string[] = [CC, MM, ZAI], pick: "off" | "shadow" | "on" = "on"): PoolConfig {
	const parsed = parsePoolConfig(poolDoc(ui, pick));
	assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join("; "));
	return (parsed as { ok: true; config: PoolConfig }).config;
}

function window(windowMinutes: number, usedPercent: number, resetsIn: number) {
	return { windowMinutes, usedPercent, resetsAt: NOW + resetsIn };
}
const h5 = (used: number, resetsIn = 3 * HOUR) => window(300, used, resetsIn);
const week = (used: number) => window(10_080, used, 5 * DAY);
const month = (used: number) => window(43_200, used, 20 * DAY);

interface RowFixture {
	provider: string;
	account?: string;
	routed?: boolean;
	windows: ReturnType<typeof window>[];
}

/**
 * A snapshot whose `rows` hold the routed row of each provider, exactly as `readRoutingSnapshot` builds it, and
 * whose `accounts` hold every row that names an account (A-2's shape, AR14's reading).
 */
function snapshot(rows: readonly RowFixture[]): RoutingSnapshot {
	const row = (entry: RowFixture): RoutingUsageRow => ({
		provider: entry.provider,
		...(entry.account === undefined ? {} : { account: entry.account }),
		...(entry.routed === undefined ? {} : { routed: entry.routed }),
		windows: entry.windows,
		meter: "read",
		usedPercent: entry.windows.map((item) => item.usedPercent),
	});
	const accounts = rows.filter((entry) => entry.account !== undefined);
	return {
		capturedAt: NOW,
		rows: rows.filter((entry) => entry.routed !== false && entry.account === undefined).map(row),
		...(accounts.length === 0 ? {} : { accounts: accounts.map(row) }),
	};
}

/** The two-account snapshot of one provider: one row per account, the routed account's row on `rows` too. */
function pairSnapshot(provider: string, first: ReturnType<typeof window>[], second: ReturnType<typeof window>[]): RoutingSnapshot {
	const firstAccount: RowFixture = { provider, account: "first account", routed: true, windows: first };
	const secondAccount: RowFixture = { provider, account: "second account", routed: false, windows: second };
	const built = snapshot([secondAccount, firstAccount]);
	return { ...built, rows: [rowOf({ provider, windows: first })] };
}

function rowOf(entry: RowFixture): RoutingUsageRow {
	return {
		provider: entry.provider,
		windows: entry.windows,
		meter: "read",
		usedPercent: entry.windows.map((item) => item.usedPercent),
	};
}

const pair = (first: ReturnType<typeof window>[], second: ReturnType<typeof window>[]) => pairSnapshot("command-code", first, second);

/** A placement with no walls of its own and every candidate configured, so a test states only what it is about. */
function place(kind: "ui" | "shared-owner", built: PoolConfig, at: RoutingSnapshot, extra: { walls?: Record<string, Wall>; configured?: boolean } = {}) {
	return placeLaneModel(built, {
		kind,
		now: NOW,
		snapshot: at,
		walls: extra.walls ?? {},
		...(extra.configured === false ? {} : { configured: () => true }),
	});
}

// ─── (a) the account with more spare allowance, and the spent account excluded ─

test("AR14 a: of two accounts of one plan the one with more spare allowance in its tightest window is chosen", () => {
	withInventory([{ provider: "command-code", accounts: [...CC_PAIR] }], () => {
		const placement = place("ui", config(), pair([month(83)], [month(51)]));
		assert.equal(placement.status, "placed");
		assert.equal(placement.ref, CC);
		assert.equal(placement.account, "second account", "51 percent used leaves more spare than 83");
		assert.match(placement.reason, /command-code \(second account\)/, "the reason names the account the rule picked");
		// Every candidate is visible with its own verdict, so the line shows what the rule passed over, and the one the
		// rule placed is the only entry marked `chosen`.
		const byAccount = new Map(placement.candidates.map((entry) => [entry.account, entry.verdict]));
		assert.equal(byAccount.get("second account"), "chosen");
		assert.equal(byAccount.get("first account"), "open");
		assert.equal(placement.candidates.filter((entry) => entry.verdict === "chosen").length, 1);
	});
});

test("AR14 a: a spent weekly window on the second account excludes it, and the first account is chosen", () => {
	withInventory([{ provider: "command-code", accounts: [...CC_PAIR] }], () => {
		const placement = place("ui", config(), pair([month(83)], [month(51), week(100)]));
		assert.equal(placement.account, "first account");
		const excluded = placement.candidates.find((entry) => entry.account === "second account");
		assert.equal(excluded?.verdict, "excluded");
		assert.match(excluded?.reason ?? "", /excluded: 7-day window 100 percent/, "AR3F: the spent window is named by its own length");
	});
});

// ─── (b) refill-first inside one provider, read per account ──────────────────

test("AR14 b: a refilling 5-hour window that is open outranks a closed one inside one provider, per account", () => {
	withInventory([{ provider: "command-code", refills: true, accounts: [...CC_PAIR] }], () => {
		const open = place("ui", config(), pair([h5(100), week(0)], [h5(20), week(60)]));
		assert.equal(open.account, "second account", "the first account's 5-hour window is spent, so it is not refill-first");
		assert.match(open.reason, /refill-first: command-code \(second account\)'s 5-hour window is 20% used/);
		// The other direction: the routed row's own open window never makes the other account look open.
		const flipped = place("ui", config(), pair([h5(15), week(0)], [h5(100), week(0)]));
		assert.equal(flipped.account, "first account");
		assert.match(flipped.reason, /refill-first: command-code \(first account\)'s 5-hour window is 15% used/);
	});
});

// ─── (c) a wall on one account leaves the other rankable ────────────────────

test("AR14 c: a wall on one account leaves the other account's refs rankable, and the keys are per account", () => {
	withInventory([{ provider: "command-code", accounts: [...CC_PAIR] }], () => {
		const built = config();
		const placement = place("ui", built, pair([month(83)], [month(51)]), {
			walls: { "command-code@second account": { until: NOW + 2 * HOUR, source: "cooldown" } },
		});
		assert.equal(placement.account, "first account", "the second account is walled, so the first is placed");
		const walled = placement.candidates.find((entry) => entry.account === "second account");
		assert.equal(walled?.verdict, "walled");
		assert.match(walled?.reason ?? "", /cooldown/, "the wall's own source is named");

		const prior = { account: process.env.PI_ACCOUNT, employer: process.env.PI_EMPLOYER };
		try {
			delete process.env.PI_ACCOUNT;
			delete process.env.PI_EMPLOYER;
			assert.equal(wallKey(built, CC), "command-code", "a process with no placement keeps today's bare key");
			process.env.PI_ACCOUNT = "second account";
			assert.equal(wallKey(built, CC), "command-code@second account", "the placed account's wall key carries it");
			assert.equal(wallKey(built, MM), "minimax", "an account only reaches a provider whose plan lists it");
			assert.equal(accountWallKey(built, "opencode-go", "second account"), "opencode-go", "a label the plan does not hold changes nothing");
		} finally {
			if (prior.account === undefined) delete process.env.PI_ACCOUNT;
			else process.env.PI_ACCOUNT = prior.account;
			if (prior.employer === undefined) delete process.env.PI_EMPLOYER;
			else process.env.PI_EMPLOYER = prior.employer;
		}
	});
});

// ─── (e) a process with no placement behaves exactly as before ──────────────

test("AR14 e: pick off places nothing and names no account", () => {
	withInventory([{ provider: "command-code", accounts: [...CC_PAIR] }], () => {
		const placement = place("ui", config([CC, MM, ZAI], "off"), pair([month(83)], [month(51)]));
		assert.equal(placement.status, "off");
		assert.equal(placement.account, undefined);
		assert.equal(placement.candidates.length, 0);
	});
});

test("AR14 e: a ref with no account ranks as it did, and an employer the plan no longer names changes no key", () => {
	withInventory([{ provider: "command-code", accounts: [...CC_PAIR] }], () => {
		const built = config();
		const ranked = rankLaneRoutes({
			config: built,
			candidates: [CC, MM, ZAI],
			walls: {},
			available: () => true,
			now: NOW,
			snapshot: pair([month(83)], [month(51)]),
			freeRefsLast: false,
		});
		assert.deepEqual(ranked.map((entry) => entry.ref), [CC, MM, ZAI], "the kind's own order decides, as before");
		assert.equal(ranked[0]?.verdict, "chosen");
		for (const entry of ranked) assert.equal("account" in entry, false, "a bare candidate carries no account");
		const prior = { account: process.env.PI_ACCOUNT, employer: process.env.PI_EMPLOYER };
		try {
			delete process.env.PI_ACCOUNT;
			process.env.PI_EMPLOYER = "acme-realty";
			assert.equal(accountWallKey({ employerAccounts: ["command-code"] }, "command-code"), "command-code@acme-realty", "SK4's employer rule is unchanged");
			assert.equal(accountWallKey({ employerAccounts: [] }, "command-code"), "command-code", "a provider outside employerAccounts is unchanged");
		} finally {
			if (prior.account === undefined) delete process.env.PI_ACCOUNT;
			else process.env.PI_ACCOUNT = prior.account;
			if (prior.employer === undefined) delete process.env.PI_EMPLOYER;
			else process.env.PI_EMPLOYER = prior.employer;
		}
	});
});

// ─── F1: a bare provider wall stops every account of it ────────────────────

test("AR14 F1: a bare provider wall stops every account of the plan, and a per-account wall stops only that one", () => {
	withInventory([{ provider: "command-code", accounts: [...CC_PAIR] }], () => {
		// One provider in the kind's list, so the wall's reach is what the answer shows.
		const bare = place("ui", config([CC]), pair([month(83)], [month(51)]), {
			walls: { "command-code": { until: NOW + 2 * HOUR, source: "cooldown" } },
		});
		assert.equal(bare.status, "wait", "a wall on the provider stops both accounts, so nothing is placed");
		assert.deepEqual(
			bare.candidates.map((entry) => entry.verdict),
			["walled", "walled"],
			"every account of the walled provider is walled (F1)",
		);
		// The same wall written under one account's key stops that account alone.
		const one = place("ui", config([CC]), pair([month(83)], [month(51)]), {
			walls: { "command-code@second account": { until: NOW + 2 * HOUR, source: "cooldown" } },
		});
		assert.equal(one.account, "first account");
	});
});

// ─── (f) and (g) through the launcher's own door ────────────────────────────

/** An agent dir the launcher's helper reads: the pool, the meter file, the walls file and the decision log. */
function agentDirFixture(options: { pool?: Record<string, unknown>; inventory?: unknown; at?: RoutingSnapshot; walls?: Record<string, Wall>; agentKeys?: readonly string[] }): string {
	const dir = mkdtempSync(join(SCRATCH, "agent-"));
	mkdirSync(join(dir, "state", "usage"), { recursive: true });
	mkdirSync(join(dir, "state", "routing"), { recursive: true });
	// A home of its own: no stored credential and no `models.json`, so the only keys in play are the ones a test names.
	mkdirSync(join(dir, "home", ".pi", "agent"), { recursive: true });
	mkdirSync(join(dir, "home", ".config"), { recursive: true });
	// `agent-keys.env` as a fixture, so the machine's real one never decides a test (VR24-213 reads its names).
	writeFileSync(join(dir, "home", ".config", "agent-keys.env"), (options.agentKeys ?? []).map((name) => `${name}=fixture-present\n`).join(""));
	writeFileSync(join(dir, "provider-pool.json"), JSON.stringify(options.pool ?? poolDoc()));
	if (options.inventory !== undefined) writeFileSync(join(dir, "inventory.json"), JSON.stringify(options.inventory));
	if (options.at !== undefined) writeFileSync(join(dir, "state", "usage", "snapshot.json"), JSON.stringify(snapshotFile(options.at)));
	writeFileSync(join(dir, "state", "provider-walls.json"), JSON.stringify(wallsFile(options.walls ?? {})));
	return dir;
}

/** The snapshot as the monitor writes it: seconds for a reset, `routed` and `account` on every row. */
function snapshotFile(at: RoutingSnapshot): unknown {
	const rows = [...(at.accounts ?? []), ...at.rows];
	return {
		capturedAt: at.capturedAt,
		providers: rows.map((row) => ({
			provider: row.provider,
			...(row.account === undefined ? {} : { account: row.account }),
			...(row.routed === undefined ? {} : { routed: row.routed }),
			quota: { primary: windowsFile(row.windows[0]), secondary: windowsFile(row.windows[1]) },
			...(row.meter === "unknown" ? { unreadable: "no reading" } : {}),
		})),
	};
}

function windowsFile(item: RoutingUsageRow["windows"][number] | undefined): unknown {
	return item === undefined ? null : { usedPercent: item.usedPercent, windowMinutes: item.windowMinutes, resetsAt: item.resetsAt / 1000 };
}

function wallsFile(walls: Record<string, Wall>): unknown {
	const out: Record<string, { until: string; source?: string }> = {};
	for (const [key, wall] of Object.entries(walls)) out[key] = { until: new Date(wall.until).toISOString(), ...(wall.source === undefined ? {} : { source: wall.source }) };
	return out;
}

function door(dir: string, extraEnv: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH ?? "",
		HOME: join(dir, "home"),
		PI_SUBSCRIPTIONS_PATH: join(dir, "inventory.json"),
		// The lane's own store of key names, never the machine's.
		PI_AGENT_KEYS_PATH: join(dir, "home", ".config", "agent-keys.env"),
		...extraEnv,
	};
	try {
		const stdout = execFileSync("node", [CLI, "--harness", "pi", "--agent-dir", dir, "--task-kind", "ui", "--json"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
		return { status: 0, stdout, stderr: "" };
	} catch (error) {
		const failure = error as { status?: number; stdout?: string; stderr?: string };
		return { status: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
	}
}

function decisions(dir: string): RouteDecision[] {
	const path = join(dir, "state", "routing", "decisions.jsonl");
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as RouteDecision);
}

test("AR14 f: the launcher's decision line names the account the rule would pick and the account the lane used", () => {
	// One ref only, so the account keys of design 1 are what the comparator has to decide between.
	const dir = agentDirFixture({
		pool: poolDoc([MM]),
		inventory: inventoryDoc([{ provider: "minimax", accounts: [...CC_PAIR] }]),
		at: pairSnapshot("minimax", [month(83)], [month(51)]),
	});
	// Both accounts' key names are present, so the pick is about the allowance and not about a missing key.
	const result = door(dir, { MINIMAX_API_KEY: "present", ACCT2_MINIMAX_API_KEY: "present" });
	assert.equal(result.status, 0, `the helper places a lane: ${result.stderr}`);
	const payload = JSON.parse(result.stdout) as { model: string; account?: string | null; laneAccount?: string };
	assert.equal(payload.model, MM);
	assert.equal(payload.account, "second account", "the rule's answer travels with the placement");
	assert.equal(payload.laneAccount, "second account", "CCACCT2: the launch applies the account the rule picks, instead of landing on the first one");
	const line = decisions(dir).at(-1) as RouteDecision;
	assert.equal(line.chosen, MM);
	assert.equal(line.by, "rule");
	assert.equal(line.account, "second account");
	assert.equal(line.laneAccount, "second account");
	assert.equal(line.shadow, undefined, "pick on placed the model, so this is the launch line");
});

test("AR14 g: an absent key is skipped as unconfigured, and three walled providers plus it start nothing", () => {
	// The shipped shape, not a convenient one: Command Code holds two accounts, so a bare wall on it has to reach both
	// (F1), and OpenCode Go holds two accounts whose key names are absent from this lane's environment.
	const dir = agentDirFixture({
		pool: poolDoc([CC, MM, ZAI, GO]),
		inventory: inventoryDoc([
			{ provider: "command-code", accounts: [...CC_PAIR] },
			{
				provider: "opencode-go",
				accounts: [
					{ label: "second account", routed: true, envPrefix: "ACCT2_" },
					{ label: "first account", routed: false },
				],
			},
		]),
		at: snapshot([
			{ provider: "command-code", windows: [month(10)] },
			{ provider: "command-code", account: "first account", routed: true, windows: [month(10)] },
			{ provider: "command-code", account: "second account", routed: false, windows: [month(10)] },
			{ provider: "minimax", windows: [h5(10)] },
			{ provider: "zai", windows: [week(10)] },
		]),
		// Exactly as `learnQuotaWall` and a cooldown write them: the provider's own key, no account.
		walls: {
			"command-code": { until: NOW + 2 * HOUR, source: "cooldown" },
			minimax: { until: NOW + 2 * HOUR, source: "cooldown" },
			zai: { until: NOW + 2 * HOUR, source: "cooldown" },
		},
	});
	// The environment carries the three walled providers' keys and none of OpenCode Go's, and the lane's own
	// `agent-keys.env` names neither either.
	const result = door(dir, { COMMAND_CODE_API_KEY: "present", MINIMAX_API_KEY: "present", ZAI_API_KEY: "present" });
	assert.equal(result.status, 1, "nothing may start");
	assert.match(result.stderr, /nothing may start now/);
	const line = decisions(dir).at(-1) as RouteDecision;
	assert.equal(line.chosen, "", "a wait places nothing");
	const ccEntries = line.candidates.filter((entry) => entry.ref === CC);
	assert.equal(ccEntries.length, 2, "one candidate per account of the plan");
	for (const entry of ccEntries) assert.equal(entry.verdict, "walled", "the bare wall reached this account (F1)");
	const goEntries = line.candidates.filter((entry) => entry.ref === GO);
	assert.equal(goEntries.length, 2, "one candidate per account of the plan");
	for (const entry of goEntries) {
		assert.equal(entry.verdict, "unconfigured");
		assert.match(entry.reason, /^unconfigured: no key for opencode-go/);
	}
	assert.equal(line.candidates.some((entry) => entry.ref === GO && (entry.verdict === "chosen" || entry.verdict === "open")), false, "never a Go lane");
	assert.match(line.reason ?? "", /unconfigured/);
});

test("AR14 F2: Command Code is judged by its key names, and its second account is unconfigured without its own", () => {
	// Both accounts are open, and the second has more spare allowance: on the old rule (no name known) it was placed.
	// CCACCT2 (2026-10-28): the pair the shipped inventory holds — the second account routed, read through `ACCT2_`.
	const ROUTED_SECOND = [
		{ label: "second account", routed: true, envPrefix: "ACCT2_" },
		{ label: "first account", routed: false },
	];
	const dir = agentDirFixture({
		pool: poolDoc([CC]),
		inventory: inventoryDoc([{ provider: "command-code", accounts: [...ROUTED_SECOND] }]),
		at: pairSnapshot("command-code", [month(83)], [month(51)]),
	});
	const bare = door(dir);
	assert.equal(bare.status, 1, "no key name and no stored entry: nothing starts");
	const bareLine = decisions(dir).at(-1) as RouteDecision;
	for (const entry of bareLine.candidates) {
		assert.equal(entry.verdict, "unconfigured");
		assert.match(entry.reason, /^unconfigured: no key for command-code/);
	}
	// CCACCT2 (2026-10-28): Command Code's ruling is the routed account's name, so that name is what a process has to
	// hold. The plain name alone names no account of the pair any more, so it starts nothing.
	const plainDir = agentDirFixture({
		pool: poolDoc([CC]),
		inventory: inventoryDoc([{ provider: "command-code", accounts: [...ROUTED_SECOND] }]),
		at: pairSnapshot("command-code", [month(83)], [month(51)]),
	});
	const plain = door(plainDir, { COMMAND_CODE_API_KEY: "fixture-plain-key" });
	assert.equal(plain.status, 1, "the plain name is not a name the rule reads, so nothing starts");
	// The routed name configures the account it belongs to, and only that one.
	const routedDir = agentDirFixture({
		pool: poolDoc([CC]),
		inventory: inventoryDoc([{ provider: "command-code", accounts: [...ROUTED_SECOND] }]),
		at: pairSnapshot("command-code", [month(83)], [month(51)]),
	});
	const placed = door(routedDir, { ACCT2_COMMAND_CODE_API_KEY: "fixture-routed-key" });
	assert.equal(placed.status, 0, placed.stderr);
	const placedLine = decisions(routedDir).at(-1) as RouteDecision;
	assert.equal(placedLine.chosen, CC);
	assert.equal(placedLine.account, "second account", "the account whose name the lane holds");
	assert.equal(placedLine.candidates.find((entry) => entry.account === "first account")?.verdict, "unconfigured");
	// The name may live in the lane's own `agent-keys.env` instead of the launcher's environment.
	const keysDir = agentDirFixture({
		pool: poolDoc([CC]),
		inventory: inventoryDoc([{ provider: "command-code", accounts: [...ROUTED_SECOND] }]),
		at: pairSnapshot("command-code", [month(83)], [month(51)]),
		agentKeys: ["ACCT2_COMMAND_CODE_API_KEY"],
	});
	const fromKeys = door(keysDir);
	assert.equal(fromKeys.status, 0, fromKeys.stderr);
	assert.equal((decisions(keysDir).at(-1) as RouteDecision).account, "second account", "the routed name in agent-keys.env configures the second account");
});
