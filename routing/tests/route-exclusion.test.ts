/**
 * AR3 of the auto-routing blueprint (section 4.4 steps 1 and 2, the AR3 row, gaps G2 and G4): a provider
 * whose window of a day or more is spent is excluded by itself, an unread meter ranks as unknown, and nothing
 * excluded is ever marked chosen.
 *
 * The acceptance is the AR3 row's own package table: with the 10-25 snapshot `openai-codex` is excluded
 * until 1794861784, `xai` ranks `unknown-meter`, minimax at 100 percent of its 5-hour window is over the line
 * and chosen only when nothing is open, and the log line reads `excluded: 30-day window 100 percent, resets
 * <time>` — named by the spent window's own length (AR3F), never `weekly` for every window of a day or more. The last test runs the real launcher helper under plain node, because that is where a lane is
 * placed and where the line is written.
 *
 * Fix gate: on the base every case fails — `rankLaneRoutes` has neither verdict, an exhausted provider is
 * only demoted by the 95 percent headroom, and the first usable ref is marked `chosen` whatever it is.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	fallbackRef,
	loadPoolConfig,
	parsePoolConfig,
	rankLaneRoutes,
	readRoutingSnapshot,
	resolveLaneModel,
	routeDecisionLine,
	routePool,
	startRef,
	type PoolConfig,
	type RankedRoute,
	type RoutingSnapshot,
} from "../provider-pool.ts";
import { harnessRoot, tsxLoaderPath } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
const CLI = join(HARNESS_ROOT, "muster", "lane-model.mjs");
const MUSTER_CLI = join(piAgentDir(), "scripts", "muster.mts");
const TSX_LOADER = tsxLoaderPath();

/** The 10-25 reading was taken at 15:30 EET, and its openai-codex window resets at 1794861784 (epoch seconds). */
const NOW = Date.parse("2026-10-25T13:30:00.000Z");
const CODEX_RESET_S = 1_794_861_784;
const CODEX_RESET_MS = CODEX_RESET_S * 1000;
const HOUR = 3_600_000;
const MIN = 60_000;
const DAY = 24 * HOUR;

const CODEX = "openai-codex/gpt-6-luna";
const XAI = "xai/grok-4.6";
const MINIMAX = "minimax/MiniMax-M3.1-Flash";
const ZAI = "zai/glm-5.3-flash";

const POOL_DOC = {
	version: 1,
	virtualProvider: "pool",
	cooldownMs: HOUR,
	resetHorizonMs: 40 * DAY,
	roles: { r: [CODEX, XAI, MINIMAX, ZAI] },
	laneDefaults: { pi: { candidates: [CODEX, ZAI], fallbackRole: "r" }, opencode: [MINIMAX], claude: "sonnet" },
	quotaShapes: [{ id: "wall", match: "QUOTA_WALL" }],
};

function config(overrides: Record<string, unknown> = {}): PoolConfig {
	const parsed = parsePoolConfig({ ...POOL_DOC, ...overrides });
	assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join("; "));
	return (parsed as { ok: true; config: PoolConfig }).config;
}

const sec = (ms: number): number => Math.floor(ms / 1000);
const verdicts = (ranked: ReadonlyArray<RankedRoute>): string[] => ranked.map((entry) => `${entry.ref}:${entry.verdict}`);
const entryOf = (ranked: ReadonlyArray<RankedRoute>, ref: string): RankedRoute | undefined => ranked.find((entry) => entry.ref === ref);

/** The 10-25 snapshot in the monitor's own shape, written as a file so the reader every caller uses reads it. */
function snapshotFile(providers: unknown[], capturedAt: number = NOW): { path: string; snapshot: RoutingSnapshot } {
	const path = join(mkdtempSync(join(tmpdir(), "ar3-snapshot-")), "snapshot.json");
	writeFileSync(path, JSON.stringify({ version: 1, capturedAt, providers }));
	const snapshot = readRoutingSnapshot(path);
	assert.ok(snapshot, "the fixture reads back as a snapshot");
	return { path, snapshot };
}

const reading25 = (): { path: string; snapshot: RoutingSnapshot } =>
	snapshotFile([
		// openai-codex: no 5-hour window, a 30-day window spent, resets 1794861784 (the 10-25 reading).
		{ provider: "openai-codex", quota: { primary: null, secondary: { usedPercent: 100, windowMinutes: 43_200, resetsAt: CODEX_RESET_S } } },
		// xai: no API read at all (G4).
		{ provider: "xai", quota: null, unreadable: "SuperGrok usage is shown on grok.com only" },
		// minimax: the 5-hour window at 100 percent, the weekly one empty.
		{ provider: "minimax", quota: { primary: { usedPercent: 100, windowMinutes: 300, resetsAt: sec(NOW + 2 * HOUR) }, secondary: { usedPercent: 0, windowMinutes: 10_080, resetsAt: sec(NOW + 5 * DAY) } } },
		// zai: 1 percent of the 5-hour window, 41 percent of the weekly one.
		{ provider: "zai", quota: { primary: { usedPercent: 1, windowMinutes: 300, resetsAt: sec(NOW + 3 * HOUR) }, secondary: { usedPercent: 41, windowMinutes: 10_080, resetsAt: sec(NOW + 4 * DAY) } } },
	]);

/** Two providers whose window of a day or more is spent, with different resets. */
const spentPair = (): RoutingSnapshot =>
	snapshotFile([
		{ provider: "openai-codex", quota: { primary: null, secondary: { usedPercent: 100, windowMinutes: 10_080, resetsAt: sec(NOW + 5 * DAY) } } },
		{ provider: "minimax", quota: { primary: null, secondary: { usedPercent: 100, windowMinutes: 43_200, resetsAt: sec(NOW + 2 * DAY) } } },
	]).snapshot;

// --- the acceptance: the 10-25 reading ---------------------------------------------------------

test("with the 10-25 snapshot the weekly-exhausted provider is excluded by itself, the unread meter ranks unknown, and the 5-hour window is only over the line", () => {
	const ranked = rankLaneRoutes({ config: config(), candidates: [CODEX, XAI, MINIMAX, ZAI], walls: {}, available: () => true, snapshot: reading25().snapshot, now: NOW });
	assert.deepEqual(verdicts(ranked), [`${ZAI}:chosen`, `${XAI}:unknown-meter`, `${MINIMAX}:over-threshold`, `${CODEX}:excluded`]);

	const codex = entryOf(ranked, CODEX);
	assert.equal(codex?.until, CODEX_RESET_MS, "the reset the exclusion lifts at");
	assert.match(codex?.reason ?? "", /^excluded: 30-day window 100 percent, resets 2026-11-16T/, "the line the decisions log carries, named by the window's own length");
	assert.equal(ranked[0]?.verdict, "chosen", "the open provider is the one placed");
	assert.notEqual(codex?.verdict, "chosen", "nothing excluded is ever chosen");
});

test("an unread meter ranks after every readable open window and before a provider over the line", () => {
	const snapshot = reading25().snapshot;
	const all = rankLaneRoutes({ config: config(), candidates: [XAI, MINIMAX, ZAI], walls: {}, available: () => true, snapshot, now: NOW });
	assert.deepEqual(verdicts(all), [`${ZAI}:chosen`, `${XAI}:unknown-meter`, `${MINIMAX}:over-threshold`]);
	// With nothing open, the unknown meter is preferred to a provider over its 5-hour line: the 5-hour one
	// refills within hours, and an unread meter is not a claim that the provider is spent.
	const withoutOpen = rankLaneRoutes({ config: config(), candidates: [MINIMAX, XAI], walls: {}, available: () => true, snapshot, now: NOW });
	assert.deepEqual(verdicts(withoutOpen), [`${XAI}:chosen`, `${MINIMAX}:over-threshold`]);
});

test("a 5-hour window at 100 percent is over the line, not excluded, and it is chosen only when nothing is open", () => {
	const snapshot = reading25().snapshot;
	const full = rankLaneRoutes({ config: config(), candidates: [MINIMAX, ZAI], walls: {}, available: () => true, snapshot, now: NOW });
	assert.equal(entryOf(full, MINIMAX)?.verdict, "over-threshold");
	const alone = rankLaneRoutes({ config: config(), candidates: [MINIMAX], walls: {}, available: () => true, snapshot, now: NOW });
	assert.equal(entryOf(alone, MINIMAX)?.verdict, "chosen", "with nothing open the over-the-line provider is the answer");
});

test("the exclusion names the spent window's own length, not weekly for every window of a day or more", () => {
	for (const [minutes, label] of [[1_440, "1-day"], [10_080, "7-day"], [43_200, "30-day"]] as [number, string][]) {
		const snapshot = snapshotFile([
			{ provider: "openai-codex", quota: { primary: null, secondary: { usedPercent: 100, windowMinutes: minutes, resetsAt: sec(NOW + 3 * DAY) } } },
		]).snapshot;
		const codex = entryOf(rankLaneRoutes({ config: config(), candidates: [CODEX, ZAI], walls: {}, available: () => true, snapshot, now: NOW }), CODEX);
		assert.equal(codex?.verdict, "excluded", `a ${minutes}-minute window at 100 percent excludes its provider`);
		assert.match(codex?.reason ?? "", new RegExp(`^excluded: ${label} window 100 percent, resets `), `the reason names a ${label} window`);
	}
});

test("a free ref keeps the free verdict on a provider whose paid window is spent", () => {
	// The pool note: a free ref has a wall of its own, keyed by the full ref, so its provider's paid window is
	// not its exclusion (AR3 impact map, "A free ref"). The live pool lists none; a config that lists one
	// reaches this case, so it is proved rather than argued away.
	const free = "openai-codex/gpt-6-luna-free";
	const cfg = config({ freeRefs: [free], roles: { r: [CODEX, XAI, MINIMAX, ZAI, free] } });
	const ranked = rankLaneRoutes({ config: cfg, candidates: [CODEX, free, ZAI], walls: {}, available: () => true, snapshot: reading25().snapshot, now: NOW });
	assert.equal(entryOf(ranked, free)?.verdict, "free", "the free ref keeps its own verdict");
	assert.doesNotMatch(entryOf(ranked, free)?.reason ?? "", /^excluded:/, "its provider's spent window is not its reason");
	assert.equal(entryOf(ranked, CODEX)?.verdict, "excluded", "the paid ref on the same provider is still excluded");
	assert.match(entryOf(ranked, CODEX)?.reason ?? "", /^excluded: 30-day window 100 percent, resets /);
	assert.equal(entryOf(ranked, ZAI)?.verdict, "chosen");
});

test("an exclusion lifts at its window's reset by itself", () => {
	const snapshot = reading25().snapshot;
	const after = rankLaneRoutes({ config: config(), candidates: [CODEX, ZAI], walls: {}, available: () => true, snapshot, now: CODEX_RESET_MS + 1 });
	assert.equal(entryOf(after, CODEX)?.verdict, "over-threshold", "the window refilled: no exclusion, only the headroom step");
	assert.equal(entryOf(after, CODEX)?.until, undefined);
	assert.equal(entryOf(after, ZAI)?.verdict, "chosen");
});

// --- nothing excluded is ever chosen, and nothing answers empty --------------------------------

test("a chain whose every ref is excluded answers on the earliest return, and no excluded ref is chosen", () => {
	const snapshot = spentPair();
	const cfg = config({ roles: { r: [CODEX, MINIMAX] }, laneDefaults: { pi: { candidates: [CODEX, MINIMAX], fallbackRole: "r" }, opencode: [MINIMAX], claude: "sonnet" } });
	const ranked = rankLaneRoutes({ config: cfg, candidates: [CODEX, MINIMAX], walls: {}, available: () => true, snapshot, now: NOW });
	assert.deepEqual(verdicts(ranked), [`${MINIMAX}:excluded`, `${CODEX}:excluded`], "earliest return first, neither chosen");
	assert.equal(ranked[0]?.until, NOW + 2 * DAY);
	// Every door still answers, and none of them answers empty.
	assert.equal(routePool({ config: cfg, role: "r", reason: "user", now: NOW, newRun: true, available: () => true, snapshot }).ref, MINIMAX);
	assert.equal(startRef(cfg, "r", { now: NOW, snapshot }), MINIMAX);
	const lane = resolveLaneModel(cfg, { harness: "pi", now: NOW, snapshot });
	assert.equal(lane.model, MINIMAX);
	assert.notEqual(lane.model, CODEX);
});

test("an open ref wins over an excluded one at every door", () => {
	const snapshot = reading25().snapshot;
	const cfg = config();
	assert.equal(startRef(cfg, "r", { now: NOW, snapshot }), ZAI);
	assert.equal(fallbackRef(cfg, "r", CODEX, { now: NOW, snapshot }), ZAI);
	const lane = resolveLaneModel(cfg, { harness: "pi", now: NOW, snapshot });
	assert.equal(lane.model, ZAI, "the lane default list skips the excluded candidate");
	assert.deepEqual(lane.skipped, [{ ref: CODEX, reason: "excluded" }]);
	assert.equal(routePool({ config: cfg, role: "r", reason: "user", now: NOW, newRun: true, available: () => true, snapshot }).ref, ZAI);
});

// --- the log line ------------------------------------------------------------------------------

test("the decision line carries the exclusion with its reset, and `muster route record` accepts it", () => {
	const snapshot = reading25().snapshot;
	const candidates = rankLaneRoutes({ config: config(), candidates: [CODEX, ZAI], walls: {}, available: () => true, snapshot, now: NOW });
	const line = routeDecisionLine({ at: NOW, lane: "lane-ar3", chosen: ZAI, by: "rule", candidates, snapshotAt: snapshot.capturedAt });
	const read = JSON.parse(line) as { chosen: string; candidates: RankedRoute[] };
	const codex = read.candidates.find((entry) => entry.ref === CODEX);
	assert.equal(codex?.verdict, "excluded");
	assert.equal(codex?.until, CODEX_RESET_MS);
	assert.match(codex?.reason ?? "", /^excluded: 30-day window 100 percent, resets /);

	// The verb that writes and reads the log accepts the new verdicts, so the reason reaches the file.
	const dir = mkdtempSync(join(tmpdir(), "ar3-route-"));
	const path = join(dir, "decisions.jsonl");
	const env = { ...process.env, PI_ROUTING_DECISIONS_PATH: path };
	const recorded = muster(env, line, ["route", "record"]);
	assert.equal(recorded.status, 0, recorded.output);
	const explain = muster(env, "", ["route", "explain", "lane-ar3"]);
	assert.equal(explain.status, 0, explain.output);
	assert.match(explain.stdout, /openai-codex\/gpt-6-luna: excluded \(excluded: 30-day window 100 percent, resets /);
	const unknown = muster(env, routeDecisionLine({ at: NOW, lane: "lane-ar3b", chosen: XAI, by: "rule", candidates: rankLaneRoutes({ config: config(), candidates: [XAI], walls: {}, available: () => true, snapshot, now: NOW }) }), ["route", "record"]);
	assert.equal(unknown.status, 0, unknown.output);
});

test("the launcher helper writes the exclusion into its own decision line, end to end", () => {
	const dir = mkdtempSync(join(tmpdir(), "ar3-launch-"));
	const state = join(dir, "state");
	mkdirSync(join(state, "usage"), { recursive: true });
	mkdirSync(join(state, "routing"), { recursive: true });
	const poolPath = join(dir, "provider-pool.json");
	writeFileSync(poolPath, JSON.stringify(POOL_DOC));
	const snapshotPath = join(state, "usage", "snapshot.json");
	const walls = join(state, "provider-walls.json");
	const decisions = join(state, "routing", "decisions.jsonl");
	const env = { ...process.env, PI_PROVIDER_POOL_PATH: poolPath, PI_PROVIDER_WALLS_PATH: walls, PI_USAGE_SNAPSHOT_PATH: snapshotPath, PI_ROUTING_DECISIONS_PATH: decisions };

	// A fresh reading: the helper records the spent window as a wall and ranks against the same reading.
	const now = Date.now();
	writeFileSync(
		snapshotPath,
		JSON.stringify({
			version: 1,
			capturedAt: now,
			providers: [{ provider: "openai-codex", quota: { primary: null, secondary: { usedPercent: 100, windowMinutes: 43_200, resetsAt: Math.floor(now / 1000) + 20 * 24 * 3600 } } }],
		}),
	);
	const launched = JSON.parse(execFileSync("node", [CLI, "--harness", "pi", "--agent-dir", dir, "--json"], { encoding: "utf8", env })) as {
		model: string;
		source: string;
		skipped: { ref: string; reason: string }[];
	};
	assert.equal(launched.model, ZAI, "the lane is placed on the provider that still has room");
	assert.deepEqual(launched.skipped, [{ ref: CODEX, reason: "excluded" }], "the launcher's own note names the exclusion");

	const line = JSON.parse(readFileSync(decisions, "utf8").trim().split("\n")[0]!) as { chosen: string; candidates: RankedRoute[] };
	assert.equal(line.chosen, ZAI);
	const codex = line.candidates.find((entry) => entry.ref === CODEX);
	assert.equal(codex?.verdict, "excluded", "the wall the helper recorded is reported as the exclusion it is");
	assert.match(codex?.reason ?? "", /^excluded: 30-day window 100 percent, resets /);
	assert.equal(codex?.until, (Math.floor(now / 1000) + 20 * 24 * 3600) * 1000);
});

function muster(env: NodeJS.ProcessEnv, input: string, args: string[]): { status: number; stdout: string; stderr: string; output: string } {
	try {
		const stdout = execFileSync(process.execPath, ["--import", `file://${TSX_LOADER}`, MUSTER_CLI, ...args], { encoding: "utf8", input, env, stdio: ["pipe", "pipe", "pipe"] });
		return { status: 0, stdout, stderr: "", output: stdout };
	} catch (error) {
		const failure = error as { status?: number; stdout?: string; stderr?: string };
		return { status: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
	}
}
