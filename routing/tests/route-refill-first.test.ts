/**
 * AR12 of the auto-routing blueprint (section 4.4 step 3, the "Revision 2026-10-26 22:3x" section,
 * VR24-202): refill-first.
 *
 * A plan whose only limit is a window that refills (MiniMax: unlimited use, a 5-hour cap that opens
 * again) is used whenever its window is open. The inventory names such plans (`refills`), so the
 * placement keeps no provider list of its own, and the rule lives in the one comparator
 * (`comparePlacement`) and in the wait rule beside it. The acceptance is the blueprint's own table:
 *
 * - (a) MiniMax at 40 percent of its 5-hour window and DeepSeek at 10 percent weekly: MiniMax first
 *   for `ui`, ahead of the pace step, and the pace step decides when nothing refills;
 * - (b) MiniMax at 96 percent: over the line, DeepSeek first;
 * - (c) MiniMax at 100 percent with `resetsAt` in the past and the snapshot stale: not first, and an
 *   unread meter stays in the unknown tier;
 * - (d) a hard kind: the rule reorders refs the kind's list already holds and adds none;
 * - (e) the decision line names "refill-first", through `muster route pick` on a fixture agent-dir;
 * - (f) every candidate over the line and one refilling window inside the horizon: wait with that
 *   reset; a plan that does not refill never holds a lane;
 * - (g) with `pick` off the launcher's output is byte-identical (the AR6 whole-path test);
 * - (N2) the fixture's `claudeMax` and `hardMax` are the shipped file's own, read and never defaulted;
 * - (N4) both doors answer the same for the same facts: the launcher counts the running lanes and the caps.
 *
 * Fix gate: on the base nothing names `refills` and `comparePlacement` has no refill key, so (a) to
 * (f) fail; on the tip they pass and the AR6 file (`route-pick.test.ts`) stays green.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPoolConfig, parsePoolConfig, placeLaneModel, poolConfigPath, readRouteDecisions, readRoutingSnapshot, type PoolConfig, type RouteDecision, type RoutingSnapshot, type TaskKind } from "../provider-pool.ts";
import { loadSubscriptionPlans } from "../subscriptions.ts";
import { harnessRoot, tsxLoaderPath } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
const CLI = join(HARNESS_ROOT, "muster", "lane-model.mjs");
const MUSTER_CLI = join(piAgentDir(), "scripts", "muster.mts");
const TSX_LOADER = tsxLoaderPath();
const SHIPPED_INVENTORY = join(piAgentDir(), "extensions", "telemetry-stats", "subscriptions.json");

const NOW = Date.parse("2026-10-26T20:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The file the doors load, so a fixture takes its caps from it rather than from a number of its own (N2). */
const SHIPPED_POOL = poolConfigPath();

/**
 * The shipped pool's own `claudeMax` and `hardMax`. A live change to either is meant to show up here, in the
 * fixture and in the case that reads the cap, and never to hide behind a default (N2, VR24-207).
 */
function shippedCaps(): { claudeMax: number; hardMax: number } {
	const loaded = loadPoolConfig(SHIPPED_POOL);
	assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.errors.join("; "));
	const routing = (loaded as { ok: true; config: PoolConfig }).config.routing;
	assert.ok(routing, "the shipped pool carries a routing section");
	return { claudeMax: routing.claudeMax, hardMax: routing.hardMax };
}

const CC = "command-code/deepseek/deepseek-v4.1-flash";
const MM = "minimax/MiniMax-M3.1-Flash";
const ZAI = "zai/glm-5.3-flash";
const XAI = "xai/grok-4.6";
const SONNET = "sonnet";

const FLASH_KINDS: readonly TaskKind[] = ["ui", "copy", "test", "adapter", "config", "docs", "research-read"];
const HARD_KINDS: readonly TaskKind[] = ["retry", "unknown-cause-bug", "shared-owner", "security-data", "perf"];

// ─── the inventory: the one owner of which plans refill ─────────────────────────────────────────

const INVENTORY_DIR = mkdtempSync(join(tmpdir(), "ar12-inventory-"));
let inventoryFiles = 0;

/** One entry of the shipped inventory, with only the fields the placement's rule reads. */
function plan(provider: string, refills: boolean): Record<string, unknown> {
	return {
		provider,
		name: provider === "minimax" ? "MiniMax" : `Plan of ${provider}`,
		monthlyUsd: provider === "minimax" ? 12 : 25,
		source: "the operator, via the orchestrator (VQ6)",
		readOn: "2026-10-06",
		kind: "subscription",
		...(refills ? { refills: true } : {}),
	};
}

/** An inventory file naming `refillProviders` as plans whose only limit is a refilling window. */
function inventoryPath(refillProviders: readonly string[], extra: Record<string, unknown>[] = []): string {
	const plans = ["minimax", "command-code", "zai", "xai", ...extra.map((entry) => String(entry["provider"]))].map((provider) => plan(provider, refillProviders.includes(provider)));
	return writeInventory(plans);
}

function writeInventory(plans: readonly Record<string, unknown>[]): string {
	inventoryFiles += 1;
	const path = join(INVENTORY_DIR, `subscriptions-${inventoryFiles}.json`);
	writeFileSync(path, `${JSON.stringify({ plans }, null, "\t")}\n`);
	return path;
}

/** Point the placement at an inventory. The rule reads the file, so the test reads through it too. */
function useInventory(refillProviders: readonly string[], extra: Record<string, unknown>[] = []): string {
	const path = inventoryPath(refillProviders, extra);
	process.env.PI_SUBSCRIPTIONS_PATH = path;
	return path;
}

// ─── the pool and the snapshot ──────────────────────────────────────────────────────────────────

/** The shipped policy (blueprint 4.4's seed), so every fixture file passes the real parser. */
function seedPolicy(hard: readonly string[]): Record<string, string[]> {
	const policy: Record<string, string[]> = {};
	for (const kind of FLASH_KINDS) policy[kind] = [CC, MM, ZAI];
	policy.review = [XAI, SONNET];
	policy["product-pass"] = [SONNET];
	for (const kind of HARD_KINDS) policy[kind] = [...hard];
	return policy;
}

interface PoolOptions {
	pick?: "off" | "shadow" | "on";
	paused?: string[];
	policy?: Record<string, string[]>;
	hard?: string[];
	horizonMs?: number;
}

function poolFile(options: PoolOptions = {}): Record<string, unknown> {
	const caps = shippedCaps();
	return {
		version: 1,
		virtualProvider: "pool",
		cooldownMs: HOUR,
		resetHorizonMs: options.horizonMs ?? 40 * DAY,
		freeRefs: [],
		roles: { worker: [CC, MM, ZAI, XAI], classifier: ["jev/classifier"] },
		nonChatRoles: ["classifier"],
		laneDefaults: {
			pi: { candidates: [CC, MM, ZAI], fallbackRole: "worker", hard: options.hard ?? [XAI] },
			opencode: [MM],
			claude: SONNET,
		},
		quotaShapes: [{ id: "wall", match: "QUOTA_WALL" }],
		routing: {
			pick: options.pick ?? "on",
			slots: 7,
			claudeMax: caps.claudeMax,
			hardMax: caps.hardMax,
			paused: options.paused ?? [XAI],
			policy: { ...seedPolicy(options.hard ?? [XAI]), ...(options.policy ?? {}) },
			kindRules: {},
		},
	};
}

/** A whole file, parsed by the real parser, so every case ranks a config the launcher would accept. */
function pool(options: PoolOptions = {}): PoolConfig {
	const parsed = parsePoolConfig(poolFile(options));
	assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join("; "));
	const warnings = (parsed as { warnings?: string[] }).warnings;
	assert.equal(warnings, undefined, `the fixture file is valid: ${(warnings ?? []).join("; ")}`);
	return (parsed as { ok: true; config: PoolConfig }).config;
}

const sec = (ms: number): number => Math.floor(ms / 1000);

/** One window of a row, in the monitor's own shape: the length, the reading, the reset in seconds. */
const windowOf = (usedPercent: number, windowMinutes: number, resetsAt: number): unknown => ({
	usedPercent,
	windowMinutes,
	resetsAt: sec(resetsAt),
});
const fiveHour = (usedPercent: number, resetsAt: number): unknown => windowOf(usedPercent, 300, resetsAt);
const weekly = (usedPercent: number, resetsAt: number): unknown => windowOf(usedPercent, 10_080, resetsAt);

/** One provider's row: the two windows most plans report. */
const row = (provider: string, primary: unknown, secondary: unknown = null): unknown => ({
	provider,
	quota: { primary, secondary },
});

/** A snapshot file in the monitor's own shape, written where a reader finds it. */
function snapshotFile(providers: unknown[], capturedAt: number): string {
	const dir = mkdtempSync(join(tmpdir(), "ar12-snapshot-"));
	const path = join(dir, "snapshot.json");
	writeFileSync(path, JSON.stringify({ version: 1, capturedAt, providers }));
	return path;
}

/** The same snapshot, read back by the reader every caller uses. */
function reading(providers: unknown[], capturedAt: number = NOW): RoutingSnapshot {
	const snapshot = readRoutingSnapshot(snapshotFile(providers, capturedAt));
	assert.ok(snapshot, "the fixture reads back as a snapshot");
	return snapshot;
}

/** The fixture pair of case (a): a capped weekly allowance behind its pace, and a refilling 5-hour window. */
const PACED = (): unknown[] => [
	row("command-code", fiveHour(3, NOW + 2 * HOUR), weekly(10, NOW + DAY / 8)),
	row("minimax", fiveHour(40, NOW + 2 * HOUR), weekly(50, NOW + 6 * DAY)),
];

/** Run `body` with the snapshot file the door reads pointed at `path`. */
function withSnapshotFile<T>(path: string, body: () => T): T {
	const previous = process.env.PI_USAGE_SNAPSHOT_PATH;
	process.env.PI_USAGE_SNAPSHOT_PATH = path;
	try {
		return body();
	} finally {
		if (previous === undefined) delete process.env.PI_USAGE_SNAPSHOT_PATH;
		else process.env.PI_USAGE_SNAPSHOT_PATH = previous;
	}
}

// ─── the inventory flag: the schema and the shipped file ───────────────────────────────────────

test("the inventory names exactly MiniMax as a plan whose only limit is a refilling window", () => {
	const plans = loadSubscriptionPlans(SHIPPED_INVENTORY, { noReceipts: true });
	assert.deepEqual(
		plans.filter((entry) => entry.refills === true).map((entry) => entry.provider),
		["minimax"],
		"the router keeps no provider list of its own: this flag is the one owner of the fact (VR24-202)",
	);
});

test("a refills flag that is not true or false is refused, never read as true", () => {
	const path = writeInventory([{ ...plan("minimax", false), refills: "yes" }]);
	assert.throws(() => loadSubscriptionPlans(path, { noReceipts: true }), /refills must be true or false/);
	const unnamed = writeInventory([{ ...plan("minimax", false), refills: false }]);
	assert.equal(loadSubscriptionPlans(unnamed, { noReceipts: true })[0]?.refills, false, "false is read as false");
});

// ─── (a) the refilling window while it is open ─────────────────────────────────────────────────

test("(a) a refilling 5-hour window under the line sorts ahead of the pace step", () => {
	useInventory(["minimax"]);
	const placed = placeLaneModel(pool({ policy: { ui: [CC, MM] } }), { harness: "pi", now: NOW, kind: "ui", snapshot: reading(PACED()) });
	assert.equal(placed.ref, MM, "the refilling window is used while it is open (VR24-202)");
	// The entry the placement chose is the one the line marks chosen: AR14 reconciles the mark with the comparator's
	// answer, so a decision never names two different refs as chosen.
	assert.equal(placed.candidates.find((entry) => entry.ref === MM)?.verdict, "chosen");
	assert.match(placed.reason, /refill-first/, "the reason names the rule that decided");
});

test("(a) with no plan named as refilling, the pace step decides as it did before AR12", () => {
	useInventory([]);
	const placed = placeLaneModel(pool({ policy: { ui: [CC, MM] } }), { harness: "pi", now: NOW, kind: "ui", snapshot: reading(PACED()) });
	assert.equal(placed.ref, CC, "command-code is behind its week and MiniMax burned half of it in a day");
	assert.doesNotMatch(placed.reason, /refill-first/);
});

// ─── (b) over the line ────────────────────────────────────────────────────────────────────────

test("(b) a refilling window at or over the 95 percent line is over the line, and the next candidate is placed", () => {
	useInventory(["minimax"]);
	const snapshot = reading([
		row("command-code", fiveHour(3, NOW + 2 * HOUR), weekly(10, NOW + DAY / 8)),
		row("minimax", fiveHour(96, NOW + 2 * HOUR), weekly(0, NOW + 6 * DAY)),
	]);
	const placed = placeLaneModel(pool({ policy: { ui: [CC, MM] } }), { harness: "pi", now: NOW, kind: "ui", snapshot });
	assert.equal(placed.ref, CC, "the refilling plan's allowance is spent, so the capped one carries the lane");
	assert.equal(placed.candidates.find((entry) => entry.ref === MM)?.verdict, "over-threshold");
	assert.doesNotMatch(placed.reason, /refill-first/);
});

// ─── (c) a stale reading, and an unread meter ─────────────────────────────────────────────────

test("(c) a spent refilling window with its reset behind us, read from a stale snapshot, is never first", () => {
	useInventory(["minimax"]);
	const stale = snapshotFile(
		[
			row("command-code", fiveHour(3, NOW + 2 * HOUR), weekly(10, NOW + DAY / 8)),
			row("minimax", fiveHour(100, NOW - HOUR), weekly(40, NOW + 6 * DAY)),
		],
		NOW - DAY / 24,
	);
	const placed = withSnapshotFile(stale, () => placeLaneModel(pool({ policy: { ui: [CC, MM] } }), { harness: "pi", now: NOW, kind: "ui" }));
	assert.notEqual(placed.ref, MM, "a reading older than the snapshot's own freshness is no reading at all");
	assert.equal(placed.ref, CC);
	assert.doesNotMatch(placed.reason, /refill-first/);
});

test("(c) an unread meter stays in the unknown tier, and refill-first never lifts it above a readable window", () => {
	useInventory(["minimax"]);
	const snapshot = reading([
		row("command-code", fiveHour(3, NOW + 2 * HOUR), weekly(10, NOW + DAY / 8)),
		{ provider: "minimax", quota: null, unreadable: "the monitor cannot read it" },
	]);
	const placed = placeLaneModel(pool({ policy: { ui: [CC, MM] } }), { harness: "pi", now: NOW, kind: "ui", snapshot });
	assert.equal(placed.candidates.find((entry) => entry.ref === MM)?.verdict, "unknown-meter", "unknown is a state, not a zero");
	assert.equal(placed.ref, CC);
});

// ─── (d) a hard kind is unchanged ─────────────────────────────────────────────────────────────

test("(d) a hard kind keeps its list: the rule reorders the refs it already holds and adds none", () => {
	useInventory(["minimax"]);
	const snapshot = reading(PACED());
	const placed = placeLaneModel(pool({ policy: { "shared-owner": [CC, MM] }, hard: [CC, MM] }), {
		harness: "pi",
		now: NOW,
		kind: "shared-owner",
		class: "H3",
		snapshot,
	});
	assert.equal(placed.ref, MM, "inside the hard list the refilling window still sorts first");
	assert.deepEqual(placed.candidates.map((entry) => entry.ref).sort(), [CC, MM].sort(), "no ref outside the kind's list is added");

	const narrow = placeLaneModel(pool({ policy: { "shared-owner": [CC] }, hard: [CC] }), { harness: "pi", now: NOW, kind: "shared-owner", class: "H3", snapshot });
	assert.equal(narrow.ref, CC, "a refilling provider outside the kind's hard list is never placed by the rule");
});

test("(d) the rule never applies to the Claude ref, whatever its plan reports", () => {
	// A plan recorded for the alias's own provider: the rule must not read it for a Claude lane (VR24-91).
	useInventory(["sonnet"]);
	const snapshot = reading([
		row("xai", fiveHour(3, NOW + 2 * HOUR), weekly(5, NOW + DAY / 8)),
		row("sonnet", fiveHour(40, NOW + 2 * HOUR), weekly(60, NOW + 6 * DAY)),
	]);
	const placed = placeLaneModel(pool({ paused: [] }), { now: NOW, kind: "review", snapshot });
	assert.equal(placed.ref, XAI, "the kind's order and the pace keep the Claude ref where they put it");
	assert.doesNotMatch(placed.reason, /refill-first/);
});

// ─── (e) the decision line, through the second door ───────────────────────────────────────────

interface DoorFacts {
	pick?: "off" | "shadow" | "on";
	policy?: Record<string, string[]>;
	/** The refs a hard kind may run on (`laneDefaults.pi.hard`), which a hard-kind policy must stay inside. */
	hard?: string[];
	/** The refs of the lane cards the directory holds: the running list both doors read. */
	running?: readonly string[];
	/** The snapshot rows this fixture writes, when a case needs more of them than the default pair. */
	providers?: unknown[];
}

/**
 * One fixture installation both doors read: a pool file, a snapshot taken against the real clock (the doors read
 * their own clock), the inventory, the lane cards that make up the running list, and a temp decision log. `HOME`
 * points into the fixture, so the directory's other sources read it rather than the operator's own home.
 */
function doorFixture(facts: DoorFacts = {}): { dir: string; env: NodeJS.ProcessEnv; decisions: string } {
	const inventory = useInventory(["minimax"]);
	const dir = mkdtempSync(join(tmpdir(), "ar12-door-"));
	const state = join(dir, "state");
	const stateDir = join(state, "muster");
	const cards = join(stateDir, "lanes");
	mkdirSync(cards, { recursive: true });
	mkdirSync(join(state, "usage"), { recursive: true });
	mkdirSync(join(state, "routing"), { recursive: true });
	writeFileSync(join(dir, "provider-pool.json"), JSON.stringify(poolFile({ ...(facts.pick === undefined ? {} : { pick: facts.pick }), ...(facts.policy === undefined ? {} : { policy: facts.policy }), ...(facts.hard === undefined ? {} : { hard: facts.hard }) })));
	const live = Date.now();
	writeFileSync(
		join(state, "usage", "snapshot.json"),
		JSON.stringify({
			version: 1,
			capturedAt: live,
			providers: facts.providers ?? [row("command-code", fiveHour(3, live + 2 * HOUR), weekly(10, live + DAY / 8)), row("minimax", fiveHour(40, live + 2 * HOUR), weekly(50, live + 6 * DAY))],
		}),
	);
	(facts.running ?? []).forEach((model, index) => {
		const laneId = `lane-${index + 1}`;
		writeFileSync(
			join(cards, `${laneId}.json`),
			JSON.stringify({ laneId, harness: "pi", cwd: dir, branch: "lane/ar12", state: "running", model, thinking: null, since: live - MINUTE, updatedAt: live, wall: null, endpoint: null, pendingIn: 0, contextPercent: 3, sessionId: null }),
		);
	});
	const decisions = join(state, "routing", "decisions.jsonl");
	return {
		dir,
		decisions,
		env: {
			...process.env,
			HOME: dir,
			PI_PROVIDER_POOL_PATH: join(dir, "provider-pool.json"),
			PI_PROVIDER_WALLS_PATH: join(state, "provider-walls.json"),
			PI_USAGE_SNAPSHOT_PATH: join(state, "usage", "snapshot.json"),
			PI_ROUTING_DECISIONS_PATH: decisions,
			PI_MUSTER_STATE_DIR: stateDir,
			PI_SUBSCRIPTIONS_PATH: inventory,
			// VR24-213: a lane starts only where its key name is present, so the fixture lane's environment carries the
			// names these candidates read (values are fixtures, and nothing here is a real key).
			MINIMAX_API_KEY: "fixture-present",
			ZAI_API_KEY: "fixture-present",
			XAI_API_KEY: "fixture-present",
			// Command Code's routed name (CCACCT2, 2026-10-28): the ruling names this one, so it is what keeps its lanes
			// placeable here.
			ACCT2_COMMAND_CODE_API_KEY: "fixture-present",
		},
	};
}

function muster(env: NodeJS.ProcessEnv, args: string[]): { status: number; stdout: string; stderr: string; output: string } {
	try {
		const stdout = execFileSync(process.execPath, ["--import", `file://${TSX_LOADER}`, MUSTER_CLI, ...args], { encoding: "utf8", input: "", env, stdio: ["pipe", "pipe", "pipe"] });
		return { status: 0, stdout, stderr: "", output: stdout };
	} catch (error) {
		const failure = error as { status?: number; stdout?: string; stderr?: string };
		return { status: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
	}
}

test("(e) muster route pick places the refilling window and the decision line names refill-first", () => {
	const fixture = doorFixture({ pick: "on", policy: { ui: [CC, MM] } });
	const picked = muster(fixture.env, ["route", "pick", "--lane", "ar12", "--task-kind", "ui", "--json"]);
	assert.equal(picked.status, 0, picked.output);
	const answer = JSON.parse(picked.stdout) as { status: string; ref: string };
	assert.equal(answer.status, "placed");
	assert.equal(answer.ref, MM);
	const line = readRouteDecisions(fixture.decisions)[0] as RouteDecision;
	assert.equal(line.chosen, MM);
	assert.match(line.reason ?? "", /refill-first/, "the line the command center reads carries the rule that decided");
	assert.doesNotMatch(line.reason ?? "", /refills/, "the line names the rule, not the inventory's field");
});

// ─── (f) waiting for a refill ────────────────────────────────────────────────────────────────

test("(f) every candidate over the line with a refilling window inside the horizon: wait for that reset", () => {
	useInventory(["minimax"]);
	const reset = NOW + 20 * MINUTE;
	const snapshot = reading([
		row("command-code", fiveHour(99, NOW + 2 * HOUR), weekly(10, NOW + DAY / 8)),
		row("minimax", fiveHour(99, reset), weekly(50, NOW + 6 * DAY)),
	]);
	const waiting = placeLaneModel(pool({ horizonMs: HOUR, policy: { ui: [CC, MM] } }), { harness: "pi", now: NOW, kind: "ui", snapshot });
	assert.equal(waiting.status, "wait", "the refilling allowance is spent for 20 minutes, and its return is known");
	assert.equal(waiting.ref, undefined, "a wait places nothing");
	assert.equal(waiting.until, Math.floor(reset / 1000) * 1000, "the reset the refilling window names");
	assert.match(waiting.reason, /refill-first/);
});

test("(f) a refilling window outside the horizon, or a plan that does not refill, never holds a lane", () => {
	useInventory(["minimax"]);
	const far = reading([
		row("command-code", fiveHour(99, NOW + 2 * HOUR), weekly(10, NOW + DAY / 8)),
		row("minimax", fiveHour(99, NOW + 2 * HOUR), weekly(50, NOW + 6 * DAY)),
	]);
	const placed = placeLaneModel(pool({ horizonMs: HOUR, policy: { ui: [CC, MM] } }), { harness: "pi", now: NOW, kind: "ui", snapshot: far });
	assert.equal(placed.status, "placed", "outside the horizon the over-the-line ref is still chosen, as 4.4 step 2 says");
	assert.equal(placed.ref, CC);
	assert.doesNotMatch(placed.reason, /refill-first/);

	// The same spent window on a plan that does not refill: its allowance does not open sooner for a wait.
	const capped = reading([row("command-code", fiveHour(99, NOW + 20 * MINUTE), weekly(10, NOW + DAY / 8))]);
	const cappedOnly = placeLaneModel(pool({ horizonMs: HOUR, policy: { ui: [CC] } }), { harness: "pi", now: NOW, kind: "ui", snapshot: capped });
	assert.equal(cappedOnly.status, "placed");
	assert.equal(cappedOnly.ref, CC);
});

// ─── (N2) the caps come from the shipped file ───────────────────────────────────────────────

test("(N2) the fixture pool takes claudeMax and hardMax from the shipped file, so a live change shows up", () => {
	const caps = shippedCaps();
	const routing = pool().routing;
	assert.ok(routing, "the fixture pool parses with its routing section");
	assert.equal(routing.claudeMax, caps.claudeMax, "no default of this file's own hides the shipped cap");
	assert.equal(routing.hardMax, caps.hardMax);
	// Case (d) places a hard lane with an empty running list, so it reads the shipped hardMax rather than a 2.
	assert.ok(caps.hardMax >= 1, `the shipped pool allows at least one hard lane (hardMax ${caps.hardMax}): case (d) depends on it`);
});

// ─── (N4) both doors, one answer ──────────────────────────────────────────────────────────────

function launch(env: NodeJS.ProcessEnv, dir: string, extra: string[] = []): { status: number; stdout: string; stderr: string } {
	try {
		const stdout = execFileSync("node", [CLI, "--harness", "pi", "--agent-dir", dir, "--json", ...extra], { encoding: "utf8", env });
		return { status: 0, stdout, stderr: "" };
	} catch (error) {
		const failure = error as { status?: number; stdout?: string; stderr?: string };
		return { status: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
	}
}

test("(N4) both doors count the running lanes: the spread step puts the same ref in both answers", () => {
	// The kind's own order names ZAI first, both are behind their week by the same amount, and one lane already
	// runs on ZAI — so the spread step alone answers CC, and only a running list reaches it.
	const live = Date.now();
	const fixture = doorFixture({
		pick: "on",
		policy: { ui: [ZAI, CC] },
		running: [ZAI],
		providers: [row("command-code", fiveHour(3, live + 2 * HOUR), weekly(10, live + DAY / 8)), row("zai", fiveHour(3, live + 2 * HOUR), weekly(10, live + DAY / 8))],
	});
	const picked = muster(fixture.env, ["route", "pick", "--lane", "ar12", "--task-kind", "ui", "--json"]);
	assert.equal(picked.status, 0, picked.output);
	const answer = JSON.parse(picked.stdout) as { status: string; ref: string };
	assert.equal(answer.ref, CC, "route pick reads the running lane on ZAI");
	const launched = launch(fixture.env, fixture.dir, ["--lane", "ar12", "--task-kind", "ui"]);
	assert.equal(launched.status, 0, launched.stderr);
	assert.equal((JSON.parse(launched.stdout) as { model: string }).model, answer.ref, "the launcher door answers what route pick answers");
});

test("(N4) both doors count the caps: with the hard cap spent, neither places a hard lane", () => {
	// The cap is the shipped hardMax, so the list and the cap decide, never a number written here.
	const cap = shippedCaps().hardMax;
	const fixture = doorFixture({ pick: "on", policy: { "shared-owner": [CC, MM] }, hard: [CC, MM], running: Array.from({ length: cap }, () => CC) });
	const picked = muster(fixture.env, ["route", "pick", "--lane", "ar12", "--task-kind", "shared-owner", "--class", "H3", "--json"]);
	assert.equal(picked.status, 3, picked.output);
	const answer = JSON.parse(picked.stdout) as { status: string; ref: null; reason: string };
	assert.equal(answer.status, "wait", `route pick waits at ${cap} hard lanes running`);
	assert.equal(answer.ref, null);
	const launched = launch(fixture.env, fixture.dir, ["--lane", "ar12", "--task-kind", "shared-owner", "--class", "H3"]);
	assert.equal(launched.status, 1, "the launcher door refuses the start the same way");
	assert.equal(launched.stdout, "", "a wait places nothing at either door");
	assert.match(launched.stderr, /nothing may start now/, launched.stderr);
	assert.match(launched.stderr, /hard lanes already run/, "the reason names the cap both doors read");
});

// ─── (g) the off path, with the inventory in place ───────────────────────────────────────────

test("(g) with pick off the launcher's output stays byte-identical, with a refilling plan in the inventory", () => {
	const plain = doorFixture({ pick: "off" });
	const kinded = doorFixture({ pick: "off" });
	const before = launch(plain.env, plain.dir);
	const after = launch(kinded.env, kinded.dir, ["--task-kind", "ui", "--class", "flash"]);
	assert.equal(before.status, 0, before.stderr);
	assert.equal(after.status, 0, after.stderr);
	assert.equal(after.stdout, before.stdout, "the inventory read changes nothing while the table places nothing");
	assert.equal(after.stderr, before.stderr);
});
