/**
 * AR6 of the auto-routing blueprint (sections 4.4, 4.5, 4.7, the AR6 row, VR24-91/92/100): one placement
 * function with two doors, in shadow first.
 *
 * `placeLaneModel` reads `routing.policy[kind]` and applies placement steps 1 to 3 through the verdicts
 * `rankLaneRoutes` already produces. The two doors are the Pi launcher's helper (`lane-model.mjs`, plain
 * node) and `muster route pick`. This file is the whole-path test the Fix gate asks for:
 *
 * - `pick: off` leaves the launcher's output byte-identical, with or without `--task-kind`;
 * - `shadow` adds one line with `shadow: true` and changes no launch;
 * - the caps hold: two Claude lanes, two hard lanes, and no flash kind on Claude;
 * - a hand placement (`--model` + `--override "reason"`) is recorded as the orchestrator's;
 * - a replay of a recorded launch sequence never runs more than two Claude lanes and never places a flash
 *   kind on Claude.
 *
 * Fix gate: on the base `placeLaneModel` and `muster route pick` do not exist, so every case fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	parsePoolConfig,
	placeLaneModel,
	readRoutingSnapshot,
	readRouteDecisions,
	routeDecisionLine,
	type PoolConfig,
	type RouteDecision,
	type RoutingSnapshot,
	type TaskKind,
	type TaskKindClass,
} from "../provider-pool.ts";
import { harnessRoot, tsxLoaderPath } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
const CLI = join(HARNESS_ROOT, "muster", "lane-model.mjs");
const MUSTER_CLI = join(piAgentDir(), "scripts", "muster.mts");
const TSX_LOADER = tsxLoaderPath();

const NOW = Date.parse("2026-10-26T20:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// AR12 (VR24-202): the placement reads the inventory's `refills` flag, and every fixture in this file
// predates it — a case here ranks as it did before a plan could refill. The file the flag is read from is
// named once, before any placement runs, and it holds no plan: a missing inventory means nothing refills.
process.env.PI_SUBSCRIPTIONS_PATH = join(mkdtempSync(join(tmpdir(), "ar6-inventory-")), "no-inventory.json");

/**
 * The caps the recorded sequence ran under (N2 of the AR6 review, VR24-207). This file replays what happened on
 * 2026-10-25 and 26, so it names its own caps instead of reading today's: the live pool has carried
 * `claudeMax: 0` since VR24-207, and a replay against the live value would not show what the sequence did. The
 * doors read the live file themselves; `route-refill-first.test.ts` takes its numbers from it for the same reason.
 */
const REPLAY_CLAUDE_MAX = 2;
const REPLAY_HARD_MAX = 2;

const CC = "command-code/deepseek/deepseek-v4.1-flash";
const MM = "minimax/MiniMax-M3.1-Flash";
const ZAI = "zai/glm-5.3-flash";
const XAI = "xai/grok-4.6";
const SONNET = "sonnet";

const FLASH_ORDER = [CC, MM, ZAI];
const FLASH_KINDS: readonly TaskKind[] = ["ui", "copy", "test", "adapter", "config", "docs", "research-read"];
const HARD_KINDS: readonly TaskKind[] = ["retry", "unknown-cause-bug", "shared-owner", "security-data", "perf"];

/** The shipped policy (blueprint 4.4's seed): Grok paused for lanes, so a hard kind and a review wait. */
function seedPolicy(): Record<string, string[]> {
	const policy: Record<string, string[]> = {};
	for (const kind of FLASH_KINDS) policy[kind] = [...FLASH_ORDER];
	policy.review = [XAI, SONNET];
	policy["product-pass"] = [SONNET];
	for (const kind of HARD_KINDS) policy[kind] = [XAI];
	return policy;
}

interface PoolOptions {
	pick?: "off" | "shadow" | "on";
	paused?: string[];
	policy?: Record<string, string[]>;
	claudeMax?: number;
	hardMax?: number;
	candidates?: string[];
	hard?: string[];
}

/** A whole file, parsed by the real parser, so every test ranks a config the launcher would accept. */
function pool(options: PoolOptions = {}): PoolConfig {
	const doc = {
		version: 1,
		virtualProvider: "pool",
		cooldownMs: HOUR,
		resetHorizonMs: 40 * DAY,
		freeRefs: [],
		roles: { worker: [CC, MM, ZAI, XAI], classifier: ["jev/classifier"] },
		nonChatRoles: ["classifier"],
		laneDefaults: {
			pi: { candidates: options.candidates ?? [...FLASH_ORDER], fallbackRole: "worker", hard: options.hard ?? [XAI] },
			opencode: [MM],
			claude: SONNET,
		},
		quotaShapes: [{ id: "wall", match: "QUOTA_WALL" }],
		routing: {
			pick: options.pick ?? "on",
			slots: 7,
			claudeMax: options.claudeMax ?? REPLAY_CLAUDE_MAX,
			hardMax: options.hardMax ?? REPLAY_HARD_MAX,
			paused: options.paused ?? [XAI],
			policy: { ...seedPolicy(), ...(options.policy ?? {}) },
			kindRules: {},
		},
	};
	const parsed = parsePoolConfig(doc);
	assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join("; "));
	const warnings = (parsed as { warnings?: string[] }).warnings;
	assert.equal(warnings, undefined, `the fixture file is valid: ${(warnings ?? []).join("; ")}`);
	return (parsed as { ok: true; config: PoolConfig }).config;
}

const sec = (ms: number): number => Math.floor(ms / 1000);

/** A snapshot in the monitor's own shape, read back by the reader every caller uses. */
function reading(providers: unknown[], capturedAt: number = NOW): RoutingSnapshot {
	const path = join(mkdtempSync(join(tmpdir(), "ar6-snapshot-")), "snapshot.json");
	writeFileSync(path, JSON.stringify({ version: 1, capturedAt, providers }));
	const snapshot = readRoutingSnapshot(path);
	assert.ok(snapshot, "the fixture reads back as a snapshot");
	return snapshot;
}

/** One row with a 5-hour and a weekly window, the pair most plans report. */
const row = (provider: string, fiveHour: number, weekly: number): unknown => ({
	provider,
	quota: {
		primary: { usedPercent: fiveHour, windowMinutes: 300, resetsAt: sec(NOW + 2 * HOUR) },
		secondary: { usedPercent: weekly, windowMinutes: 10_080, resetsAt: sec(NOW + 5 * DAY) },
	},
});

// --- what "off" means: nothing changes ---------------------------------------------------------

test("with pick off, without a kind, or with an explicit model, the placement is off and the harness default is the whole answer", () => {
	const off = placeLaneModel(pool({ pick: "off" }), { harness: "pi", now: NOW, kind: "ui" });
	assert.equal(off.status, "off");
	assert.equal(off.ref, undefined);
	assert.deepEqual(off.candidates, []);
	assert.equal(off.resolution.model, CC, "today's Pi default, untouched");

	const kindless = placeLaneModel(pool({ pick: "on" }), { harness: "pi", now: NOW });
	assert.equal(kindless.status, "off");
	assert.equal(kindless.resolution.model, CC);

	const explicit = placeLaneModel(pool({ pick: "on" }), { harness: "pi", now: NOW, kind: "ui", explicit: ZAI });
	assert.equal(explicit.status, "off");
	assert.equal(explicit.resolution.source, "explicit");
	assert.equal(explicit.resolution.model, ZAI, "the operator's model is kept (P5-D6)");

	const noSection = (() => {
		const { routing: _routing, ...file } = poolFile();
		const parsed = parsePoolConfig(file);
		assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join("; "));
		return (parsed as { ok: true; config: PoolConfig }).config;
	})();
	assert.equal(placeLaneModel(noSection, { harness: "pi", now: NOW, kind: "ui" }).status, "off");
});

test("a kind's list, not the lane default order, decides the placement", () => {
	// The lane default order puts ZAI first; the policy for `ui` puts it last. A placement on CC can only
	// have come from routing.policy.
	const config = pool({ candidates: [ZAI, MM, CC], policy: { ui: [CC, MM, ZAI] } });
	const placed = placeLaneModel(config, { harness: "pi", now: NOW, kind: "ui" });
	assert.equal(placed.status, "placed");
	assert.equal(placed.ref, CC);
	assert.match(placed.reason, /^routing\.policy\.ui: open and readable tier/);
	assert.deepEqual(placed.candidates.map((entry) => entry.ref).sort(), [CC, MM, ZAI].sort(), "every candidate is on the line");
});

// --- step 1: drop what cannot run --------------------------------------------------------------

test("a walled, exhausted, unavailable or paused ref is never placed, and the next one is", () => {
	const walls = { "command-code": { until: NOW + HOUR, source: "config" as const } };
	const walled = placeLaneModel(pool(), { harness: "pi", now: NOW, kind: "ui", walls });
	assert.equal(walled.ref, MM, "a walled ref is dropped by the ranking's own verdict");

	const spent = reading([{ provider: "command-code", quota: { primary: null, secondary: { usedPercent: 100, windowMinutes: 10_080, resetsAt: sec(NOW + 3 * DAY) } } }]);
	const exhausted = placeLaneModel(pool(), { harness: "pi", now: NOW, kind: "ui", snapshot: spent });
	assert.equal(exhausted.ref, MM, "a spent weekly window excludes its provider by itself (AR3)");

	const missing = placeLaneModel(pool(), { harness: "pi", now: NOW, kind: "ui", available: (ref) => ref !== CC });
	assert.equal(missing.ref, MM, "a ref with no credentials is never placed");

	const paused = placeLaneModel(pool({ policy: { ui: [CC, MM, ZAI] }, paused: [CC] }), { harness: "pi", now: NOW, kind: "ui" });
	assert.equal(paused.ref, MM, "a pause is the operator's word for lanes and drops the ref (VR24-113)");
	assert.ok(!paused.candidates.some((entry) => entry.ref === CC), "a paused ref is not even a candidate");
});

test("a hard kind whose only ref is paused returns wait with the class noted, never a silent downgrade (the shipped seed)", () => {
	const placed = placeLaneModel(pool(), { harness: "pi", now: NOW, kind: "shared-owner", class: "H3" });
	assert.equal(placed.status, "wait");
	assert.equal(placed.ref, undefined);
	assert.match(placed.reason, /xai\/grok-4\.6 is paused for lanes/);
});

// --- step 2: the tiers ------------------------------------------------------------------------

test("an unread meter ranks before a provider over the line, and a readable open window before both", () => {
	const mainlySpent = reading([
		{ provider: "command-code", quota: { primary: { usedPercent: 99, windowMinutes: 300, resetsAt: sec(NOW + HOUR) }, secondary: null } },
		{ provider: "minimax", quota: null, unreadable: "the monitor cannot read it" },
		row("zai", 4, 20),
	]);
	const openBeatsAll = placeLaneModel(pool(), { harness: "pi", now: NOW, kind: "ui", snapshot: mainlySpent });
	assert.equal(openBeatsAll.ref, ZAI, "ZAI is the only readable provider under the line");

	const noOpen = reading([
		{ provider: "command-code", quota: { primary: { usedPercent: 99, windowMinutes: 300, resetsAt: sec(NOW + HOUR) }, secondary: null } },
		{ provider: "minimax", quota: null, unreadable: "the monitor cannot read it" },
		row("zai", 99, 40),
	]);
	const unknownFirst = placeLaneModel(pool(), { harness: "pi", now: NOW, kind: "ui", snapshot: noOpen });
	assert.equal(unknownFirst.ref, MM, "an unread meter is a state, not a zero: it ranks before over-the-line");
});

// --- step 3: the one comparator ---------------------------------------------------------------

test("inside the best tier the fewest running lanes wins, before the kind's own preference order", () => {
	const config = pool({ policy: { ui: [MM, CC] } });
	const placed = placeLaneModel(config, {
		harness: "pi",
		now: NOW,
		kind: "ui",
		running: [{ ref: MM }, { ref: MM }],
	});
	assert.equal(placed.ref, CC, "the spread step outranks the order the kind lists");
	assert.match(placed.reason, /2 running lane\(s\) on minimax|0 running lane\(s\)/);
});

test("among equal running counts, the provider behind its pace wins, and a ref with no pace sorts last", () => {
	// minimax burned half its week in a tenth of it; command-code is at 10 percent with nine tenths gone.
	const paced = reading([
		{ provider: "command-code", quota: { primary: { usedPercent: 3, windowMinutes: 300, resetsAt: sec(NOW + 2 * HOUR) }, secondary: { usedPercent: 10, windowMinutes: 10_080, resetsAt: sec(NOW + DAY / 8) } } },
		{ provider: "minimax", quota: { primary: { usedPercent: 3, windowMinutes: 300, resetsAt: sec(NOW + 2 * HOUR) }, secondary: { usedPercent: 50, windowMinutes: 10_080, resetsAt: sec(NOW + 6 * DAY) } } },
	]);
	const placed = placeLaneModel(pool({ policy: { ui: [MM, CC] } }), { harness: "pi", now: NOW, kind: "ui", snapshot: paced });
	assert.equal(placed.ref, CC, "the plan behind its pace is used first, so the subscription is not wasted");

	const noPace = reading([
		{ provider: "command-code", quota: { primary: { usedPercent: 1, windowMinutes: 300, resetsAt: sec(NOW + HOUR) }, secondary: { usedPercent: 1, windowMinutes: 8_519, resetsAt: sec(NOW + DAY) } } },
		row("minimax", 1, 1),
	]);
	const weekly = placeLaneModel(pool({ policy: { ui: [CC, MM] } }), { harness: "pi", now: NOW, kind: "ui", snapshot: noPace });
	assert.equal(weekly.ref, MM, "a window length outside the nominal set gives no pace (G6), so the order decides");
});

// --- the caps: the operator's recorded limits -------------------------------------------------------

test("claudeMax: two Claude lanes at once, the third waits, and a placed Claude ref says so", () => {
	const one = placeLaneModel(pool(), { harness: "claude", now: NOW, kind: "product-pass", running: [{ ref: SONNET }] });
	assert.equal(one.status, "placed");
	assert.equal(one.ref, SONNET);
	assert.equal(one.claude, true, "the door can tell this is a Claude-harness lane");

	const two = placeLaneModel(pool(), { harness: "claude", now: NOW, kind: "product-pass", running: [{ ref: SONNET }, { ref: SONNET }] });
	assert.equal(two.status, "wait");
	assert.match(two.reason, /2 Claude lanes already run/);
});

test("a review kind falls from Grok to Sonnet only while Grok is paused, and the Claude cap still holds", () => {
	const placed = placeLaneModel(pool(), { harness: "claude", now: NOW, kind: "review" });
	assert.equal(placed.ref, SONNET, "a Claude lane is offered the Claude alias only, and Grok is paused for lanes");

	// Without a harness the list's own order decides across both harnesses, which is the orchestrator's question.
	const unpaused = placeLaneModel(pool({ paused: [] }), { now: NOW, kind: "review" });
	assert.equal(unpaused.ref, XAI, "an unpaused review runs on Grok, a Pi lane");
	assert.equal(unpaused.claude, undefined);
	const paused = placeLaneModel(pool(), { now: NOW, kind: "review" });
	assert.equal(paused.ref, SONNET, "with Grok paused the review falls to Sonnet, and the line says it is a Claude lane");
	assert.equal(paused.claude, true);
});

test("hardMax: two hard lanes running, the third waits; one running, the hard ref is placed", () => {
	const config = pool({ paused: [] });
	const one = placeLaneModel(config, { harness: "pi", now: NOW, kind: "security-data", class: "H4", running: [{ ref: XAI }] });
	assert.equal(one.status, "placed");
	assert.equal(one.ref, XAI);

	const two = placeLaneModel(config, { harness: "pi", now: NOW, kind: "perf", class: "H5", running: [{ ref: XAI }, { ref: XAI }] });
	assert.equal(two.status, "wait");
	assert.match(two.reason, /2 hard lanes already run/);
});

test("a hard lane never lands on a flash ref, whatever the caller's class says", () => {
	// The caller says H3 over a flash kind: the policy's flash refs are not hard refs, so nothing is placed.
	const placed = placeLaneModel(pool({ paused: [] }), { harness: "pi", now: NOW, kind: "ui", class: "H3", running: [] });
	assert.equal(placed.status, "wait");
	assert.equal(placed.ref, undefined);
});

// --- wait: never a silent downgrade -----------------------------------------------------------

test("every candidate out returns wait with the earliest return, from a wall or a spent window", () => {
	const all = reading([
		{ provider: "command-code", quota: { primary: null, secondary: { usedPercent: 100, windowMinutes: 10_080, resetsAt: sec(NOW + 10 * DAY) } } },
		{ provider: "minimax", quota: { primary: null, secondary: { usedPercent: 100, windowMinutes: 43_200, resetsAt: sec(NOW + 2 * DAY) } } },
		{ provider: "zai", quota: { primary: null, secondary: { usedPercent: 100, windowMinutes: 10_080, resetsAt: sec(NOW + 5 * DAY) } } },
	]);
	const waiting = placeLaneModel(pool(), { harness: "pi", now: NOW, kind: "ui", snapshot: all });
	assert.equal(waiting.status, "wait");
	assert.equal(waiting.until, Math.floor((NOW + 2 * DAY) / 1000) * 1000, "minimax returns first");
	assert.match(waiting.reason, /every ui candidate is walled, exhausted, unconfigured or unavailable/);

	const walled = placeLaneModel(pool(), {
		harness: "pi",
		now: NOW,
		kind: "ui",
		walls: { "command-code": { until: NOW + 3 * HOUR, source: "error" as const }, minimax: { until: NOW + HOUR, source: "error" as const }, zai: { until: NOW + 2 * HOUR, source: "error" as const } },
	});
	assert.equal(walled.status, "wait");
	assert.equal(walled.until, NOW + HOUR, "the wall that lifts first is the earliest return");
});

// --- the launcher door: plain node, byte-identical when off ------------------------------------

function launcherDir(options: PoolOptions = {}): { dir: string; env: NodeJS.ProcessEnv; decisions: string } {
	const dir = mkdtempSync(join(tmpdir(), "ar6-launch-"));
	const state = join(dir, "state");
	mkdirSync(join(state, "usage"), { recursive: true });
	mkdirSync(join(state, "routing"), { recursive: true });
	writeFileSync(join(dir, "provider-pool.json"), JSON.stringify(poolFile(options)));
	const decisions = join(state, "routing", "decisions.jsonl");
	const env = {
		...process.env,
		PI_PROVIDER_POOL_PATH: join(dir, "provider-pool.json"),
		PI_PROVIDER_WALLS_PATH: join(state, "provider-walls.json"),
		PI_USAGE_SNAPSHOT_PATH: join(state, "usage", "snapshot.json"),
		PI_ROUTING_DECISIONS_PATH: decisions,
		// VR24-213: a lane starts only where its key name is present, so these fixture lanes carry the names their
		// candidates read. The values are fixtures; no real key is read here.
		MINIMAX_API_KEY: "fixture-present",
		ZAI_API_KEY: "fixture-present",
		XAI_API_KEY: "fixture-present",
	};
	return { dir, env, decisions };
}

/** The fixture file as JSON, for the plain-node door that parses it itself. */
function poolFile(options: PoolOptions = {}): Record<string, unknown> {
	const config = pool(options);
	return {
		version: 1,
		virtualProvider: "pool",
		cooldownMs: HOUR,
		resetHorizonMs: 40 * DAY,
		freeRefs: [],
		roles: { worker: [CC, MM, ZAI, XAI], classifier: ["jev/classifier"] },
		nonChatRoles: ["classifier"],
		laneDefaults: config.laneDefaults,
		quotaShapes: [{ id: "wall", match: "QUOTA_WALL" }],
		routing: config.routing,
	};
}

function launch(env: NodeJS.ProcessEnv, dir: string, extra: string[] = []): { status: number; stdout: string; stderr: string } {
	try {
		const stdout = execFileSync("node", [CLI, "--harness", "pi", "--agent-dir", dir, "--json", ...extra], { encoding: "utf8", env });
		return { status: 0, stdout, stderr: "" };
	} catch (error) {
		const failure = error as { status?: number; stdout?: string; stderr?: string };
		return { status: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
	}
}

test("with pick off the launcher's output is byte-identical with and without --task-kind, and it writes one line", () => {
	const plain = launcherDir({ pick: "off" });
	const kinded = launcherDir({ pick: "off" });
	const before = launch(plain.env, plain.dir);
	const after = launch(kinded.env, kinded.dir, ["--task-kind", "ui", "--class", "flash"]);
	assert.equal(before.status, 0, before.stderr);
	assert.equal(after.status, 0, after.stderr);
	assert.equal(after.stdout, before.stdout, "the launcher's stdout is byte-identical");
	assert.equal(after.stderr, before.stderr);
	const plainLines = readFileSync(plain.decisions, "utf8").trim().split("\n");
	const kindedLines = readFileSync(kinded.decisions, "utf8").trim().split("\n");
	assert.equal(plainLines.length, 1);
	assert.equal(kindedLines.length, 1, "pick off adds no line");
	const line = JSON.parse(kindedLines[0]!) as RouteDecision;
	assert.equal(line.taskKind, "ui", "the kind still reaches the real decision line (AR1)");
	assert.equal(line.shadow, undefined);
	assert.equal(line.chosen, JSON.parse(before.stdout).model);
});

test("in shadow the launcher adds one line with shadow: true and changes no launch", () => {
	const off = launcherDir({ pick: "off" });
	const shadow = launcherDir({ pick: "shadow" });
	const real = launch(off.env, off.dir);
	const shadowed = launch(shadow.env, shadow.dir, ["--task-kind", "ui", "--class", "flash"]);
	assert.equal(shadowed.status, 0, shadowed.stderr);
	assert.equal(shadowed.stdout, real.stdout, "a shadow line never changes the launch");
	const lines = readFileSync(shadow.decisions, "utf8").trim().split("\n").map((raw) => JSON.parse(raw) as RouteDecision);
	assert.equal(lines.length, 2, "the real placement and the rule's answer beside it");
	assert.equal(lines[0]!.shadow, undefined);
	assert.equal(lines[1]!.shadow, true);
	assert.equal(lines[0]!.chosen, JSON.parse(real.stdout).model, "the real placement is the harness default");
	assert.equal(lines[1]!.chosen, CC, "the shadow line is the table's answer for a ui lane");
	assert.equal(lines[1]!.by, "rule");
	assert.equal(lines[1]!.taskKind, "ui");
	assert.equal(lines[1]!.class, "flash");
});

test("with pick on the launcher starts the lane on the table's ref and says which rule placed it", () => {
	const dir = launcherDir({ pick: "on", policy: { ui: [MM] } });
	const launched = launch(dir.env, dir.dir, ["--task-kind", "ui"]);
	assert.equal(launched.status, 0, launched.stderr);
	const payload = JSON.parse(launched.stdout) as { model: string; note: string };
	assert.equal(payload.model, MM);
	assert.match(payload.note, /^routing\.policy\.ui:/);
	const line = JSON.parse(readFileSync(dir.decisions, "utf8").trim()) as RouteDecision;
	assert.equal(line.chosen, MM);
	assert.equal(line.by, "rule");
});

test("with pick on, a kind that may not start exits 1 with the earliest return and records the wait", () => {
	const dir = launcherDir({ pick: "on" });
	const launched = launch(dir.env, dir.dir, ["--task-kind", "shared-owner", "--class", "H3"]);
	assert.equal(launched.status, 1, launched.stdout);
	assert.match(launched.stderr, /nothing may start now: .*paused for lanes/);
	const line = JSON.parse(readFileSync(dir.decisions, "utf8").trim()) as RouteDecision;
	assert.equal(line.chosen, "", "a wait placed nothing");
	assert.equal(line.by, "rule");
	assert.match(line.reason ?? "", /paused for lanes/);
});

// --- the CLI door: muster route pick ----------------------------------------------------------

function muster(env: NodeJS.ProcessEnv, input: string, args: string[]): { status: number; stdout: string; stderr: string; output: string } {
	try {
		const stdout = execFileSync(process.execPath, ["--import", `file://${TSX_LOADER}`, MUSTER_CLI, ...args], { encoding: "utf8", input, env, stdio: ["pipe", "pipe", "pipe"] });
		return { status: 0, stdout, stderr: "", output: stdout };
	} catch (error) {
		const failure = error as { status?: number; stdout?: string; stderr?: string };
		return { status: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
	}
}

/** The agent-dir env `muster route pick` reads: a fixture pool, a temp log, and no lanes unless a test writes cards. */
function pickEnv(options: PoolOptions = {}, cards: { laneId: string; harness: string; model: string; state?: string }[] = []): { env: NodeJS.ProcessEnv; decisions: string; stateDir: string } {
	const dir = mkdtempSync(join(tmpdir(), "ar6-pick-"));
	const state = join(dir, "state");
	const stateDir = join(state, "muster");
	mkdirSync(join(stateDir, "lanes"), { recursive: true });
	mkdirSync(join(state, "usage"), { recursive: true });
	mkdirSync(join(state, "routing"), { recursive: true });
	writeFileSync(join(dir, "provider-pool.json"), JSON.stringify(poolFile(options)));
	for (const card of cards) {
		writeFileSync(
			join(stateDir, "lanes", `${card.laneId}.json`),
			JSON.stringify({ laneId: card.laneId, harness: card.harness, cwd: "/tmp", branch: `lane/${card.laneId}`, state: card.state ?? "running", model: card.model, thinking: "high", since: Date.now() - HOUR, updatedAt: Date.now(), wall: null }),
		);
	}
	const decisions = join(state, "routing", "decisions.jsonl");
	const env = {
		...process.env,
		PI_PROVIDER_POOL_PATH: join(dir, "provider-pool.json"),
		PI_PROVIDER_WALLS_PATH: join(state, "provider-walls.json"),
		PI_USAGE_SNAPSHOT_PATH: join(state, "usage", "snapshot.json"),
		PI_ROUTING_DECISIONS_PATH: decisions,
		PI_MUSTER_STATE_DIR: stateDir,
		// VR24-213: `route pick` refuses a candidate whose key name is absent, so a fixture lane carries the names its
		// candidates read (fixture values, never a real key).
		MINIMAX_API_KEY: "fixture-present",
		ZAI_API_KEY: "fixture-present",
		XAI_API_KEY: "fixture-present",
	};
	return { env, decisions, stateDir };
}

test("muster route pick answers by rule, records by rule, and reads its answer back", () => {
	const { env, decisions } = pickEnv({ pick: "on" });
	const picked = muster(env, "", ["route", "pick", "--lane", "a1", "--task-kind", "ui", "--json"]);
	assert.equal(picked.status, 0, picked.output);
	const answer = JSON.parse(picked.stdout) as { status: string; ref: string; reason: string };
	assert.equal(answer.status, "placed");
	assert.equal(answer.ref, CC);
	const lines = readRouteDecisions(decisions);
	assert.equal(lines.length, 1);
	assert.equal(lines[0]!.by, "rule");
	assert.equal(lines[0]!.lane, "a1");
	assert.equal(lines[0]!.taskKind, "ui");
	assert.equal(lines[0]!.class, "flash", "the kind's own class is recorded when the caller names none");
	const explain = muster(env, "", ["route", "explain", "a1"]);
	assert.equal(explain.status, 0, explain.output);
	assert.match(explain.stdout, new RegExp(`a1 -> ${CC.replace(/[/.]/g, "\\$&")}`));
});

test("a hand placement passes --model with --override, is recorded as the orchestrator's, and counts as one", () => {
	const { env, decisions } = pickEnv({ pick: "on" });
	const picked = muster(env, "", ["route", "pick", "--lane", "gl3", "--task-kind", "product-pass", "--model", SONNET, "--override", "the operator named GL3 for Claude in his own words (VR24-91)"]);
	assert.equal(picked.status, 0, picked.output);
	const line = readRouteDecisions(decisions)[0]!;
	assert.equal(line.chosen, SONNET);
	assert.equal(line.by, "orchestrator");
	assert.match(line.override ?? "", /the operator named GL3/);
	assert.equal(line.taskKind, "product-pass");
	assert.equal(line.class, "exception");

	// Without a reason there is no hand placement, and without a model there is nothing to record.
	assert.equal(muster(env, "", ["route", "pick", "--lane", "gl4", "--task-kind", "product-pass", "--model", SONNET]).status, 2);
	assert.equal(muster(env, "", ["route", "pick", "--lane", "gl4", "--task-kind", "product-pass", "--override", "because"]).status, 2);
});

test("with two Claude lane cards running, route pick waits for the cap and records the wait with no ref", () => {
	const busy = pickEnv({ pick: "on" }, [
		{ laneId: "gl3", harness: "claude", model: SONNET },
		{ laneId: "gl4", harness: "claude", model: SONNET },
	]);
	const waiting = muster(busy.env, "", ["route", "pick", "--lane", "gl5", "--task-kind", "product-pass", "--json"]);
	assert.equal(waiting.status, 3, waiting.output);
	const answer = JSON.parse(waiting.stdout) as { status: string; ref: string | null; reason: string };
	assert.equal(answer.status, "wait");
	assert.equal(answer.ref, null);
	assert.match(answer.reason, /2 Claude lanes already run/);
	const line = readRouteDecisions(busy.decisions)[0]!;
	assert.equal(line.chosen, "");
	assert.match(line.reason ?? "", /2 Claude lanes already run/);

	// One of them finishes: the same question is placed, so the cap is read live rather than fixed.
	const freed = pickEnv({ pick: "on" }, [{ laneId: "gl3", harness: "claude", model: SONNET }]);
	const placed = muster(freed.env, "", ["route", "pick", "--lane", "gl5", "--task-kind", "product-pass", "--json"]);
	assert.equal(placed.status, 0, placed.output);
	assert.equal((JSON.parse(placed.stdout) as { ref: string }).ref, SONNET);

	// A lane that is gone is not running.
	const finished = pickEnv({ pick: "on" }, [
		{ laneId: "gl3", harness: "claude", model: SONNET },
		{ laneId: "gl4", harness: "claude", model: SONNET, state: "gone" },
	]);
	assert.equal(muster(finished.env, "", ["route", "pick", "--lane", "gl5", "--task-kind", "product-pass"]).status, 0);
});

test("route log prints a wait line as a wait, and still refuses a hand-written decision with no ref", () => {
	const { env, decisions } = pickEnv({ pick: "on" });
	mkdirSync(dirname(decisions), { recursive: true });
	writeFileSync(decisions, routeDecisionLine({ at: NOW, lane: "wait1", chosen: "", by: "rule", reason: "2 Claude lanes already run", until: NOW + HOUR, candidates: [] }));
	const log = muster(env, "", ["route", "log"]);
	assert.equal(log.status, 0, log.output);
	assert.match(log.stdout, /lane wait1 -> wait until \d{4}-\d{2}-\d{2}T/);
	const refused = muster(env, JSON.stringify({ at: NOW, chosen: "", by: "rule", candidates: [] }), ["route", "record"]);
	assert.equal(refused.status, 2, "a decision fed on stdin still names what was chosen");
});

test("route pick refuses a kind, a class or a harness nobody put in the vocabulary", () => {
	const { env } = pickEnv({ pick: "on" });
	assert.equal(muster(env, "", ["route", "pick", "--lane", "x1", "--task-kind", "frontend"]).status, 2);
	assert.equal(muster(env, "", ["route", "pick", "--lane", "x1", "--task-kind", "ui", "--class", "H9"]).status, 2);
	assert.equal(muster(env, "", ["route", "pick", "--lane", "x1", "--task-kind", "ui", "--harness", "hermes"]).status, 2);
	assert.equal(muster(env, "", ["route", "pick", "--task-kind", "ui"]).status, 2, "--lane is needed");
});

test("with pick off, route pick answers with the harness default and records nothing", () => {
	const { env, decisions } = pickEnv({ pick: "off" });
	const picked = muster(env, "", ["route", "pick", "--lane", "a1", "--task-kind", "ui", "--json"]);
	assert.equal(picked.status, 0, picked.output);
	const answer = JSON.parse(picked.stdout) as { status: string; resolution: { model: string } };
	assert.equal(answer.status, "off");
	assert.equal(answer.resolution.model, CC);
	assert.deepEqual(readRouteDecisions(decisions), []);
});

// --- the replay: a recorded launch sequence ----------------------------------------------------

/**
 * The recorded sequence, written from the shape of the lines in `state/routing/decisions.jsonl` (a lane, what
 * it did, its class). No line before AR6 carried a kind, so the kinds here are the ones the blueprint's table
 * places and the classes are `TASK_KIND_CLASS`.
 */
const RECORDED_SEQUENCE: ReadonlyArray<{ lane: string; kind: TaskKind; class: TaskKindClass }> = [
	{ lane: "a1", kind: "ui", class: "flash" },
	{ lane: "a2", kind: "adapter", class: "flash" },
	{ lane: "a3", kind: "test", class: "flash" },
	{ lane: "gl3", kind: "review", class: "exception" },
	{ lane: "be1", kind: "docs", class: "flash" },
	{ lane: "gl2", kind: "copy", class: "flash" },
	{ lane: "fx1", kind: "shared-owner", class: "H3" },
	{ lane: "fx2", kind: "security-data", class: "H4" },
	{ lane: "gl4", kind: "product-pass", class: "exception" },
	{ lane: "fx3", kind: "perf", class: "H5" },
	{ lane: "ar8", kind: "config", class: "flash" },
	{ lane: "mg7", kind: "unknown-cause-bug", class: "H2" },
	{ lane: "rep1", kind: "review", class: "exception" },
	{ lane: "rep2", kind: "retry", class: "H1" },
];

test("replaying the recorded launch sequence runs at most two Claude lanes and never places a flash kind on Claude", () => {
	const config = pool({ pick: "on" });
	const running: { ref: string }[] = [];
	const placed: { lane: string; ref: string; kind: TaskKind }[] = [];
	const waits: { lane: string; reason: string }[] = [];
	for (const launch of RECORDED_SEQUENCE) {
		const answer = placeLaneModel(config, { now: NOW, kind: launch.kind, class: launch.class, running: [...running] });
		if (answer.status !== "placed") {
			waits.push({ lane: launch.lane, reason: answer.reason });
			continue;
		}
		const ref = answer.ref as string;
		placed.push({ lane: launch.lane, ref, kind: launch.kind });
		running.push({ ref });
	}

	const claudeLanes = placed.filter((entry) => entry.ref === SONNET);
	assert.equal(claudeLanes.length, 2, "the two Claude slots are used, and no more");
	for (const entry of placed) {
		if (FLASH_KINDS.includes(entry.kind)) assert.notEqual(entry.ref, SONNET, `${entry.lane}: a flash kind is never placed on Claude`);
	}
	assert.ok(placed.filter((entry) => FLASH_KINDS.includes(entry.kind)).length >= 6, "the flash kinds are placed");
	assert.deepEqual(waits.map((entry) => entry.lane), ["fx1", "fx2", "fx3", "mg7", "rep1", "rep2"], "the hard kinds wait while Grok is paused, and the third Claude lane waits");
	for (const waiting of waits) assert.match(waiting.reason, /paused for lanes|Claude lanes already run/);

	// Two Claude lanes running is the cap at every moment of the replay, not only at the end.
	let claude = 0;
	for (const entry of placed) {
		if (entry.ref === SONNET) claude += 1;
		assert.ok(claude <= 2, "no moment of the replay runs a third Claude lane");
	}
});

test("the same replay with Grok unpaused waits at two hard lanes running", () => {
	const config = pool({ pick: "on", paused: [] });
	const running: { ref: string }[] = [];
	const outcomes: { lane: string; status: string; ref?: string }[] = [];
	for (const launch of RECORDED_SEQUENCE) {
		const answer = placeLaneModel(config, { now: NOW, kind: launch.kind, class: launch.class, running: [...running] });
		outcomes.push({ lane: launch.lane, status: answer.status, ...(answer.ref === undefined ? {} : { ref: answer.ref }) });
		if (answer.status === "placed" && answer.ref !== undefined) running.push({ ref: answer.ref });
	}
	const hardPlaced = outcomes.filter((entry) => entry.status === "placed" && entry.ref === XAI);
	assert.equal(hardPlaced.length, 2, "two hard lanes are placed, the third waits");
	assert.equal(outcomes.find((entry) => entry.lane === "fx3")?.status, "wait", "perf waits at two hard lanes running");
});


