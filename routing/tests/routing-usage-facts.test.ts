/**
 * AR2 of the auto-routing blueprint (section 4.2, the AR2 row): the router sees window length, reset
 * time and which meters are unread.
 *
 * The shape change is the point: `RoutingUsageRow` carries `windows` and `meter` beside the derived
 * `usedPercent` list every earlier reader keeps using, `exhaustedUntil` names the reset of a window of
 * a day or more at 100 percent, a spent window is kept in the learned wall file with
 * `source: "snapshot"`, a stale snapshot never lifts it, a later reading below 100 percent does, and a
 * window length outside 300 / 10080 / 43200 minutes gives no pace. The whole path runs the real
 * launcher helper under plain node, because that is where a lane is placed.
 *
 * Fix gate: the failing-first case is the last test — on the base the helper places the lane on a
 * provider whose weekly window is spent, and no wall is ever written from a snapshot.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	activeWalls,
	exhaustedUntil,
	loadPoolConfig,
	parsePoolConfig,
	persistProviderWall,
	readRoutingSnapshot,
	recordSnapshotWalls,
	resolveLaneModel,
	windowPace,
	type PoolConfig,
	type RoutingUsageRow,
	type RoutingUsageWindow,
	type RoutingSnapshot,
} from "../provider-pool.ts";
import { harnessRoot } from "../../core/harness-paths.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
const CLI = join(HARNESS_ROOT, "muster", "lane-model.mjs");
const NOW = Date.parse("2026-10-25T16:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A pool of three providers: two Pi candidates and one role chain they fall back through. */
const POOL_DOC = {
	version: 1,
	virtualProvider: "pool",
	cooldownMs: HOUR,
	resetHorizonMs: 40 * DAY,
	roles: { r: ["alpha/a", "beta/b"] },
	laneDefaults: { pi: { candidates: ["alpha/a", "beta/b"], fallbackRole: "r" }, opencode: ["gamma/c"], claude: "sonnet" },
	quotaShapes: [{ id: "wall", match: "QUOTA_WALL" }],
};

function config(overrides: Record<string, unknown> = {}): PoolConfig {
	const parsed = parsePoolConfig({ ...POOL_DOC, ...overrides });
	assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join("; "));
	return (parsed as { ok: true; config: PoolConfig }).config;
}

const window = (usedPercent: number, windowMinutes: number, resetsAt: number): RoutingUsageWindow => ({ usedPercent, windowMinutes, resetsAt });
const row = (provider: string, windows: RoutingUsageWindow[], meter: "read" | "unknown" = "read"): RoutingUsageRow => ({
	provider,
	windows,
	meter,
	usedPercent: windows.map((entry) => entry.usedPercent),
});
const snapshot = (rows: RoutingUsageRow[], capturedAt: number = NOW): RoutingSnapshot => ({ capturedAt, rows });
const fresh: RoutingSnapshot = { capturedAt: NOW, rows: [] };

function wallsPath(): string {
	const path = join(mkdtempSync(join(tmpdir(), "ar2-walls-")), "provider-walls.json");
	writeFileSync(path, "{}\n");
	return path;
}
const filed = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, { until: string; reason?: string; source?: string }>;

/** A snapshot file in the monitor's own shape: `resetsAt` in epoch seconds, as every row writes it. */
const sec = (ms: number): number => Math.floor(ms / 1000);

function writeSnapshot(path: string, capturedAt: number, providers: unknown[]): void {
	writeFileSync(path, JSON.stringify({ version: 1, capturedAt, providers }));
}

// --- the row the router reads ----------------------------------------------------------------

test("a row carries every window with its length and its reset, and the derived percentages unchanged", () => {
	const path = join(mkdtempSync(join(tmpdir(), "ar2-snapshot-")), "snapshot.json");
	writeSnapshot(path, NOW, [
		{
			provider: "alpha",
			quota: {
				primary: { usedPercent: 12.5, windowMinutes: 300, resetsAt: sec(NOW + HOUR) },
				secondary: { usedPercent: 100, windowMinutes: 10_080, resetsAt: sec(NOW + 3 * DAY) },
			},
		},
		// A reading with no window length is still usage: it keeps its percentage and contributes no window.
		{ provider: "beta", quota: { primary: { usedPercent: 41 }, secondary: null } },
		{ provider: "gamma", quota: null },
	]);
	const read = readRoutingSnapshot(path);
	assert.ok(read);
	const alpha = read.rows.find((entry) => entry.provider === "alpha");
	assert.deepEqual(alpha?.usedPercent, [12.5, 100], "the derived list every earlier reader uses is unchanged");
	assert.deepEqual(alpha?.windows, [
		window(12.5, 300, NOW + HOUR),
		window(100, 10_080, NOW + 3 * DAY),
	]);
	assert.equal(alpha?.windows[1]?.resetsAt, NOW + 3 * DAY, "the file's epoch seconds become this module's ms");
	assert.deepEqual(read.rows.find((entry) => entry.provider === "beta")?.windows, [], "no length, no window");
	assert.deepEqual(read.rows.find((entry) => entry.provider === "beta")?.usedPercent, [41]);
	assert.deepEqual(read.rows.find((entry) => entry.provider === "gamma")?.usedPercent, []);
});

test("the meter is unknown only for a row the monitor could not read and gave no window for", () => {
	const path = join(mkdtempSync(join(tmpdir(), "ar2-meter-")), "snapshot.json");
	writeSnapshot(path, NOW, [
		{ provider: "xai", quota: null, reason: "no reading yet", unreadable: "SuperGrok usage is shown on grok.com only" },
		{ provider: "openai-codex", quota: { secondary: { usedPercent: 100, windowMinutes: 43_200, resetsAt: sec(NOW + 5 * DAY) } } },
		{ provider: "deepseek", quota: null, balance: -1.2 },
		{ provider: "kimi-coding", quota: null, unreadable: "HTTP 200 with an empty body" },
	]);
	const meter = (provider: string) => readRoutingSnapshot(path)?.rows.find((entry) => entry.provider === provider)?.meter;
	assert.equal(meter("xai"), "unknown", "no reading and no window is an unknown meter, never room");
	assert.equal(meter("kimi-coding"), "unknown");
	assert.equal(meter("openai-codex"), "read", "a window it could read keeps the meter read");
	assert.equal(meter("deepseek"), "read", "a metered account reads as a balance, not as an unreadable meter");
});

test("a missing, torn or windowless snapshot is still no snapshot, never a guess", () => {
	const path = join(mkdtempSync(join(tmpdir(), "ar2-torn-")), "snapshot.json");
	writeFileSync(path, "{ torn");
	assert.equal(readRoutingSnapshot(path), undefined);
	writeSnapshot(path, NOW, [{ provider: "alpha", quota: { primary: { usedPercent: 100, windowMinutes: 10_080, resetsAt: "soon" } } }]);
	const read = readRoutingSnapshot(path);
	assert.deepEqual(read?.rows[0]?.windows, [], "a reset that is not a number is no window");
	assert.deepEqual(read?.rows[0]?.usedPercent, [100]);
});

// --- spent windows ---------------------------------------------------------------------------

test("exhaustedUntil names the latest reset of a window of a day or more at 100 percent", () => {
	const weekly = window(100, 10_080, NOW + 7 * DAY);
	const monthly = window(100, 43_200, NOW + 20 * DAY);
	assert.equal(exhaustedUntil(row("alpha", [weekly]), NOW), NOW + 7 * DAY);
	assert.equal(exhaustedUntil(row("alpha", [weekly, monthly]), NOW), NOW + 20 * DAY, "the latest reset the row shows");
	assert.equal(exhaustedUntil(row("alpha", [window(100, 1_440, NOW + 2 * DAY)]), NOW), NOW + 2 * DAY, "a day counts");
	assert.equal(exhaustedUntil(row("alpha", [window(100, 300, NOW + HOUR)]), NOW), undefined, "a 5-hour window at 100 percent is over the line, not spent");
	assert.equal(exhaustedUntil(row("alpha", [window(100, 1_439, NOW + 2 * DAY)]), NOW), undefined);
	assert.equal(exhaustedUntil(row("alpha", [window(99.9, 10_080, NOW + 7 * DAY)]), NOW), undefined);
	assert.equal(exhaustedUntil(row("alpha", [window(100, 10_080, NOW - 1)]), NOW), undefined, "a reset already behind us lifts it");
	assert.equal(exhaustedUntil(row("unknown", []), NOW), undefined);
});

test("windowPace gives a projection only for a length the plans have", () => {
	const half = (windowMinutes: number) => window(50, windowMinutes, NOW + (windowMinutes * 60_000) / 2);
	assert.equal(windowPace(half(300), NOW), 100, "half the window spent is a projection of the whole at the reset");
	assert.equal(windowPace(half(10_080), NOW), 100);
	assert.equal(windowPace(half(43_200), NOW), 100);
	assert.equal(windowPace(window(50, 272, NOW + 1_360 * 60_000), NOW), undefined, "z.ai's 272 is no plan length, so no pace");
	assert.equal(windowPace(window(50, 8_519, NOW + 4_259 * 60_000), NOW), undefined);
	assert.equal(windowPace(window(50, 60, NOW + 30 * 60_000), NOW), undefined);
	assert.equal(windowPace(window(50, 10_080, NOW - DAY), NOW), undefined, "a window that already reset has no pace");
});

// --- the learned wall the snapshot writes ------------------------------------------------------

test("a spent weekly window is kept in the learned file with its source, and survives a restart", () => {
	const path = wallsPath();
	const cfg = config();
	const reset = NOW + 7 * DAY;
	const recorded = recordSnapshotWalls(snapshot([row("alpha", [window(1, 300, NOW + HOUR), window(100, 10_080, reset)])]), cfg, NOW, path);
	assert.deepEqual(recorded, { alpha: { until: reset, source: "snapshot" } });
	const written = filed(path);
	assert.equal(written.alpha?.until, new Date(reset).toISOString());
	assert.equal(written.alpha?.source, "snapshot");
	assert.equal(written.alpha?.reason, "snapshot: 10080 min window at 100 percent");
	assert.equal(written.beta, undefined, "a row with a 5-hour window only walls nothing");

	// The restart: the loader merges the learned file into the pool's walls, and the source comes back.
	const poolPath = join(mkdtempSync(join(tmpdir(), "ar2-pool-")), "provider-pool.json");
	writeFileSync(poolPath, JSON.stringify(POOL_DOC));
	const prior = process.env.PI_PROVIDER_WALLS_PATH;
	try {
		process.env.PI_PROVIDER_WALLS_PATH = path;
		const loaded = loadPoolConfig(poolPath, NOW);
		assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.errors.join("; "));
		const loadedConfig = (loaded as { ok: true; config: PoolConfig }).config;
		assert.deepEqual(loadedConfig.providerWalls.alpha?.source, "snapshot");
		assert.equal(activeWalls(loadedConfig, undefined, NOW).alpha?.source, "snapshot", "a snapshot wall is not mistaken for an operator wall");
	} finally {
		if (prior !== undefined) process.env.PI_PROVIDER_WALLS_PATH = prior;
		else delete process.env.PI_PROVIDER_WALLS_PATH;
	}
});

test("a stale snapshot keeps the exhaustion, and a later reading below 100 percent lifts it before the reset", () => {
	const path = wallsPath();
	const cfg = config();
	const reset = NOW + 7 * DAY;
	const spent = [row("alpha", [window(100, 10_080, reset)])];
	// Captured two hours ago: the headroom step is off, the spent window is not.
	recordSnapshotWalls(snapshot(spent, NOW - 2 * HOUR), cfg, NOW, path);
	assert.equal(filed(path).alpha?.source, "snapshot", "a stale reading never lifts a known exhaustion");
	// Re-reading the same stale file keeps it, and does not push the reset out.
	recordSnapshotWalls(snapshot(spent, NOW - 2 * HOUR), cfg, NOW, path);
	assert.equal(filed(path).alpha?.until, new Date(reset).toISOString());

	// The next fresh reading of the same window is below 100 percent: the new reading wins.
	recordSnapshotWalls(snapshot([row("alpha", [window(40, 10_080, reset)])]), cfg, NOW, path);
	assert.equal(filed(path).alpha, undefined, "the wall this function wrote lifts before its reset");
});

test("a snapshot never shortens an error or operator wall, and never lifts one", () => {
	const path = wallsPath();
	const cfg = config();
	const errorUntil = NOW + 20 * DAY;
	persistProviderWall("alpha", errorUntil, "429 weekly window", NOW, path);
	const recorded = recordSnapshotWalls(snapshot([row("alpha", [window(100, 10_080, NOW + 7 * DAY)])]), cfg, NOW, path);
	assert.deepEqual(recorded, {}, "an earlier reset does not replace a wall that lifts later");
	assert.equal(filed(path).alpha?.until, new Date(errorUntil).toISOString());
	assert.equal(filed(path).alpha?.source, undefined, "an error wall is not relabelled");
	// A later reading below 100 percent lifts only a wall this function wrote.
	recordSnapshotWalls(snapshot([row("alpha", [window(10, 10_080, NOW + 7 * DAY)])]), cfg, NOW, path);
	assert.equal(filed(path).alpha?.until, new Date(errorUntil).toISOString(), "the error wall stands");
});

// --- who is placed ----------------------------------------------------------------------------

test("a lane is never placed on a provider whose weekly window is spent: the launcher helper end to end", () => {
	const dir = mkdtempSync(join(tmpdir(), "ar2-launch-"));
	const state = join(dir, "state");
	mkdirSync(join(state, "usage"), { recursive: true });
	mkdirSync(join(state, "routing"), { recursive: true });
	const poolPath = join(dir, "provider-pool.json");
	writeFileSync(poolPath, JSON.stringify(POOL_DOC));
	const snapshotPath = join(state, "usage", "snapshot.json");
	const walls = join(state, "provider-walls.json");
	const decisions = join(state, "routing", "decisions.jsonl");
	const env = {
		...process.env,
		PI_PROVIDER_POOL_PATH: poolPath,
		PI_PROVIDER_WALLS_PATH: walls,
		PI_USAGE_SNAPSHOT_PATH: snapshotPath,
		PI_ROUTING_DECISIONS_PATH: decisions,
	};
	const launch = () =>
		JSON.parse(execFileSync("node", [CLI, "--harness", "pi", "--agent-dir", dir, "--json"], { encoding: "utf8", env })) as {
			model: string;
			source: string;
			skipped: { ref: string; reason: string }[];
			note: string;
		};

	const now = Date.now();
	const reset = Math.floor(now / 1000) + 3 * 24 * 3600;
	writeSnapshot(snapshotPath, now - 2 * HOUR, [
		{ provider: "alpha", quota: { primary: null, secondary: { usedPercent: 100, windowMinutes: 10_080, resetsAt: reset } } },
		{ provider: "beta", quota: { primary: { usedPercent: 3, windowMinutes: 300, resetsAt: Math.floor(now / 1000) + 3_600 }, secondary: null } },
	]);

	const spent = launch();
	assert.equal(spent.model, "beta/b", "a stale snapshot's spent weekly window still keeps alpha out of the launch");
	assert.deepEqual(spent.skipped, [{ ref: "alpha/a", reason: "walled" }]);
	const written = filed(walls);
	assert.equal(written.alpha?.source, "snapshot");
	assert.equal(written.alpha?.until, new Date(reset * 1000).toISOString(), "the wall lifts when the window resets");
	const firstLine = JSON.parse(readFileSync(decisions, "utf8").trim().split("\n")[0]!) as { chosen: string; candidates: { ref: string; verdict: string; reason: string }[] };
	assert.equal(firstLine.chosen, "beta/b");
	const alphaInLine = firstLine.candidates.find((entry) => entry.ref === "alpha/a");
	assert.equal(alphaInLine?.verdict, "walled", "the recorded line says why alpha was passed over");
	assert.match(alphaInLine?.reason ?? "", /\(snapshot\)$/);

	// The window refills below 100 percent before its reset: the next launch returns to alpha by itself.
	writeSnapshot(snapshotPath, Date.now(), [
		{ provider: "alpha", quota: { primary: null, secondary: { usedPercent: 40, windowMinutes: 10_080, resetsAt: reset } } },
	]);
	const open = launch();
	assert.equal(open.model, "alpha/a", "the newer reading lifts the wall before its reset");
	assert.equal(open.source, "default");
	assert.equal(filed(walls).alpha, undefined);
	const lines = readFileSync(decisions, "utf8").trim().split("\n");
	assert.equal(lines.length, 2, "one decision line per launch");
	const second = JSON.parse(lines[1]!) as { chosen: string; candidates: { ref: string; verdict: string }[] };
	assert.equal(second.chosen, "alpha/a");
	assert.equal(second.candidates.find((entry) => entry.ref === "alpha/a")?.verdict, "chosen", "the line and the choice agree");
});

test("a chain whose every ref is walled still answers, on the wall that lifts first", () => {
	const cfg = config();
	const walls = { alpha: { until: NOW + 2 * DAY, source: "snapshot" as const }, beta: { until: NOW + 5 * DAY, source: "snapshot" as const } };
	const resolved = resolveLaneModel(cfg, { harness: "pi", now: NOW, snapshot: fresh, walls });
	assert.equal(resolved.model, "alpha/a", "never an empty answer: the ref whose wall lifts first");
	assert.equal(resolved.source, "fallback");
});
