/**
 * The per-harness default lane model (the operator's ruling, 2026-10-09).
 *
 * One owner: the `laneDefaults` section of provider-pool.json, read through
 * `resolveLaneModel` in the pool library. Pi walks its ordered DeepSeek V4.1
 * Flash candidates and falls through its fallback role when every candidate is
 * walled; OpenCode walks the free-only shortlist and never returns a paid model;
 * Claude returns its one alias. An explicit model wins as is.
 *
 * The CLI (`harness/muster/lane-model.mjs`) is exercised too, because that is
 * what `scripts/pi-lane-launch.sh` actually calls.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPoolConfig, parsePoolConfig, poolConfigPath, resolveLaneModel, type PoolConfig } from "../provider-pool.ts";
import { harnessRoot } from "../../core/harness-paths.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
const CLI = join(HARNESS_ROOT, "muster", "lane-model.mjs");
const SHIPPED = poolConfigPath();
const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const HOUR = 3_600_000;

// Learned walls live in a temp file so the live agent's walls never decide a test.
process.env.PI_PROVIDER_WALLS_PATH = join(mkdtempSync(join(tmpdir(), "lane-defaults-walls-")), "provider-walls.json");
writeFileSync(process.env.PI_PROVIDER_WALLS_PATH, "{}\n");

function config(overrides: Record<string, unknown> = {}): PoolConfig {
	const parsed = parsePoolConfig({
		version: 1,
		virtualProvider: "pool",
		cooldownMs: HOUR,
		resetHorizonMs: 24 * HOUR,
		roles: { r: ["alpha/a", "beta/b"] },
		laneDefaults: {
			pi: { candidates: ["cc/ds-flash", "ocg/ds-flash", "native/ds-flash"], fallbackRole: "r" },
			opencode: ["opencode/one-free", "opencode/two-free"],
			claude: "sonnet",
		},
		quotaShapes: [{ id: "wall", match: "QUOTA_WALL" }],
		...overrides,
	});
	assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join("; "));
	return (parsed as { ok: true; config: PoolConfig }).config;
}

const wall = (key: string) => ({ [key]: { until: NOW + HOUR, source: "cooldown" as const } });

// --- the shipped file ------------------------------------------------------------------------

test("the shipped file carries the lane defaults the operator named: pi z.ai GLM 5.3 Flash then Command Code DeepSeek v4.1 Flash, the OpenCode lane's two refs (the free Zen GLM 5.3 Flash, then z.ai's coding-plan GLM 5.3 Flash), the Claude alias", () => {
	const loaded = loadPoolConfig(SHIPPED);
	assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.errors.join("; "));
	const { laneDefaults } = (loaded as { ok: true; config: PoolConfig }).config;
	assert.ok(laneDefaults, "the shipped pool has a laneDefaults section");
	assert.deepEqual(laneDefaults.pi.candidates, [
		"command-code/deepseek/deepseek-v4.1-flash",
		"minimax/MiniMax-M3.1-Flash",
		"zai/glm-5.3-flash",
		"opencode-go/deepseek-v4.1-flash",
		"opencode-go/glm-5.3-flash",
		"opencode-go/mimo-v2.6-flash",
	]); // 2026-10-23 (the operator): z.ai spent, native DeepSeek out; 2026-10-25 (the operator, VR24-89): z.ai GLM 5.3 Flash back as the last candidate; 2026-10-27 (S14, VR24-208): the OpenCode Go plan's flash models behind them, each probed once
	assert.equal(laneDefaults.pi.fallbackRole, "worker");
	// Henry option C, 2026-10-18 22:00 (the operator's standing rule that no mediocre free model is
	// used): the OpenCode lane has these two refs and pausing is the outcome when both are walled.
	assert.deepEqual(laneDefaults.opencode, ["minimax/MiniMax-M3.1-Flash"]); // 2026-10-23 (the operator)
	assert.equal(laneDefaults.claude, "sonnet");
});

test("a pool written before 2026-10-09 still loads without a laneDefaults section", () => {
	const cfg = config({ laneDefaults: undefined });
	assert.equal(cfg.laneDefaults, undefined);
	const resolved = resolveLaneModel(cfg, { harness: "pi", now: NOW });
	assert.equal(resolved.source, "none");
	assert.match(resolved.reason ?? "", /no laneDefaults section/);
});

test("a malformed laneDefaults is refused, not half-parsed", () => {
	for (const [name, value] of [
		["no claude alias", { pi: { candidates: ["cc/x"], fallbackRole: "r" }, opencode: ["opencode/x"] }],
		["empty opencode list", { pi: { candidates: ["cc/x"], fallbackRole: "r" }, opencode: [], claude: "sonnet" }],
		["fallbackRole names no role", { pi: { candidates: ["cc/x"], fallbackRole: "nope" }, opencode: ["opencode/x"], claude: "sonnet" }],
		["a bad ref", { pi: { candidates: ["cc/x"], fallbackRole: "r" }, opencode: ["not-a-ref"], claude: "sonnet" }],
	] as const) {
		const parsed = parsePoolConfig({
			version: 1,
			virtualProvider: "pool",
			cooldownMs: HOUR,
			resetHorizonMs: HOUR,
			roles: { r: ["alpha/a"] },
			laneDefaults: value,
			quotaShapes: [{ id: "wall", match: "QUOTA_WALL" }],
		});
		assert.equal(parsed.ok, false, `${name} should be refused`);
	}
});

// --- the resolver ----------------------------------------------------------------------------

test("each harness returns its own default when no model is named", () => {
	const cfg = config();
	assert.equal(resolveLaneModel(cfg, { harness: "pi", now: NOW }).model, "cc/ds-flash");
	assert.equal(resolveLaneModel(cfg, { harness: "opencode", now: NOW }).model, "opencode/one-free");
	assert.equal(resolveLaneModel(cfg, { harness: "claude", now: NOW }).model, "sonnet");
});

test("an explicit model wins as is for every harness and is never resolved", () => {
	for (const harness of ["pi", "opencode", "claude"] as const) {
		const resolved = resolveLaneModel(config(), { harness, now: NOW, explicit: "zai/glm-5.3-flash" });
		assert.deepEqual(resolved, { model: "zai/glm-5.3-flash", source: "explicit", skipped: [] });
	}
});

test("pi skips a walled candidate and reports why", () => {
	const resolved = resolveLaneModel(config(), { harness: "pi", now: NOW, walls: wall("cc") });
	assert.equal(resolved.model, "ocg/ds-flash");
	assert.deepEqual(resolved.skipped, [{ ref: "cc/ds-flash", reason: "walled" }]);
});

test("pi falls through the pool's fallback role when every candidate is walled", () => {
	const walls = { ...wall("cc"), ...wall("ocg"), ...wall("native") };
	const resolved = resolveLaneModel(config(), { harness: "pi", now: NOW, walls });
	assert.equal(resolved.model, "alpha/a");
	assert.equal(resolved.source, "fallback");
	// The fallback role's own first ref is walled as well, so it moves on.
	const shifted = resolveLaneModel(config(), { harness: "pi", now: NOW, walls: { ...walls, alpha: { until: NOW + HOUR, source: "cooldown" } } });
	assert.equal(shifted.model, "beta/b");
	assert.equal(shifted.source, "fallback");
});

test("an OpenCode lane never falls through to a role: a fully walled lane-default list is none, not a fallback", () => {
	const resolved = resolveLaneModel(config(), { harness: "opencode", now: NOW, walls: { ...wall("opencode/one-free"), ...wall("opencode/two-free") } });
	assert.equal(resolved.model, undefined);
	assert.equal(resolved.source, "none");
	assert.match(resolved.reason ?? "", /OpenCode/);
	// Every other answer is a member of the free shortlist, never a paid ref.
	const cfg = config();
	assert.equal(resolveLaneModel(cfg, { harness: "opencode", now: NOW }).model, "opencode/one-free");
	// A wall on the first free model rotates to the next; a provider-wide wall takes the list out.
	assert.equal(resolveLaneModel(cfg, { harness: "opencode", now: NOW, walls: wall("opencode/one-free") }).model, "opencode/two-free");
	assert.equal(resolveLaneModel(cfg, { harness: "opencode", now: NOW, walls: wall("opencode") }).source, "none");
});

// --- the CLI the launcher calls --------------------------------------------------------------

function fixturePool(laneDefaults: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "lane-defaults-pool-"));
	writeFileSync(
		join(dir, "provider-pool.json"),
		JSON.stringify({
			version: 1,
			virtualProvider: "pool",
			cooldownMs: HOUR,
			resetHorizonMs: 24 * HOUR,
			roles: { r: ["alpha/a", "beta/b"] },
			laneDefaults,
			quotaShapes: [{ id: "wall", match: "QUOTA_WALL" }],
		}),
	);
	return dir;
}

function helper(agentDir: string, harness: string, extra: string[] = []): { status: number; stdout: string; stderr: string } {
	try {
		const stdout = execFileSync("node", [CLI, "--harness", harness, "--agent-dir", agentDir, "--json", ...extra], { encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "pipe"] });
		return { status: 0, stdout, stderr: "" };
	} catch (error) {
		const failure = error as { status?: number; stdout?: string; stderr?: string };
		return { status: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
	}
}

test("the lane-model CLI returns the resolved harness default as JSON", () => {
	const dir = fixturePool({ pi: { candidates: ["cc/ds-flash"], fallbackRole: "r" }, opencode: ["opencode/one-free"], claude: "sonnet" });
	const pi = helper(dir, "pi");
	assert.equal(pi.status, 0, pi.stderr);
	assert.deepEqual(JSON.parse(pi.stdout), { model: "cc/ds-flash", source: "default", skipped: [], reason: null, note: "pi default" });
	const opencode = helper(dir, "opencode");
	assert.equal(JSON.parse(opencode.stdout).model, "opencode/one-free");
	const claude = helper(dir, "claude");
	assert.equal(JSON.parse(claude.stdout).model, "sonnet");
});

test("the lane-model CLI exits 1 with the reason when no model is available, and 2 on a bad invocation", () => {
	const dir = fixturePool({ pi: { candidates: ["cc/x"], fallbackRole: "r" }, opencode: ["opencode/one-free"], claude: "sonnet" });
	mkdirSync(join(dir, "state"), { recursive: true });
	writeFileSync(
		join(dir, "state", "provider-walls.json"),
		JSON.stringify({ "opencode/one-free": { until: new Date(Date.now() + HOUR).toISOString() } }),
	);
	const none = helper(dir, "opencode");
	assert.equal(none.status, 1, `expected exit 1, got ${none.status}: ${none.stderr}`);
	assert.match(JSON.parse(none.stdout).reason, /free OpenCode model/);
	const bad = helper(dir, "nope");
	assert.equal(bad.status, 2, bad.stderr);
});

test("the headroom step applies inside the operator's lane default list: z.ai GLM 5.3 Flash leads while it has room, and no Pi default is an opencode/ ref (Zen's free tier answers only the OpenCode client)", () => {
	const loaded = loadPoolConfig(SHIPPED);
	assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.errors.join("; "));
	const { config: shipped } = loaded as { ok: true; config: PoolConfig };
	assert.equal(resolveLaneModel(shipped, { harness: "pi", now: NOW }).model, "command-code/deepseek/deepseek-v4.1-flash", "Command Code DeepSeek V4.1 Flash leads the Pi default while it is open (2026-10-23)");
	// Put command-code at 96% of a window: it moves behind MiniMax and the skip is named. The row carries the
	// shape AR2 requires (`windows`, `meter`), so the ranking reads a reading and not a bare percentage.
	const spent = resolveLaneModel(shipped, { harness: "pi", now: NOW, snapshot: { capturedAt: NOW, rows: [{ provider: "command-code", windows: [], meter: "read", usedPercent: [96] }] } });
	assert.equal(spent.model, "minimax/MiniMax-M3.1-Flash");
	assert.equal(spent.source, "default");
	assert.deepEqual(spent.skipped, [{ ref: "command-code/deepseek/deepseek-v4.1-flash", reason: "over-threshold" }]);
	// A stale snapshot is no snapshot: DeepSeek stands again.
	assert.equal(resolveLaneModel(shipped, { harness: "pi", now: NOW, snapshot: null }).model, "command-code/deepseek/deepseek-v4.1-flash");
	// With DeepSeek and MiniMax walled the last of the three set candidates, z.ai GLM 5.3 Flash, answers (VR24-89).
	const third = resolveLaneModel(shipped, { harness: "pi", now: NOW, snapshot: null, walls: { ...wall("command-code"), ...wall("minimax") } });
	assert.equal(third.model, "zai/glm-5.3-flash");
	assert.equal(third.source, "default");
	// S14 (2026-10-27): the OpenCode Go plan's flash models follow them, and one provider wall covers all three.
	const fourth = resolveLaneModel(shipped, { harness: "pi", now: NOW, snapshot: null, walls: { ...wall("command-code"), ...wall("minimax"), ...wall("zai") } });
	assert.equal(fourth.model, "opencode-go/deepseek-v4.1-flash");
	assert.equal(fourth.source, "default");
	// With every Pi candidate walled the fallback role answers, and neither it nor any walk lands on an opencode/ ref.
	const walled = resolveLaneModel(shipped, { harness: "pi", now: NOW, snapshot: null, walls: { ...wall("command-code"), ...wall("minimax"), ...wall("zai"), ...wall("opencode-go") } });
	assert.equal(walled.source, "fallback");
	assert.ok(!walled.model?.startsWith("opencode/"), `the fallback is not an opencode/ ref (${walled.model})`);
});

test("the OpenCode harness default is the free Zen GLM 5.3 Flash, and the coding-plan GLM 5.3 Flash when it is walled (never a weaker free model)", () => {
	const loaded = loadPoolConfig(SHIPPED);
	assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.errors.join("; "));
	const { config: shipped } = loaded as { ok: true; config: PoolConfig };
	// 2026-10-23 (the operator): the OpenCode lane runs MiniMax M3.1 Flash only.
	assert.equal(resolveLaneModel(shipped, { harness: "opencode", now: NOW }).model, "minimax/MiniMax-M3.1-Flash");
	// Walled: no second ref, no weaker free model, and the lane is left to its QUOTA WALL.
	const both = resolveLaneModel(shipped, { harness: "opencode", now: NOW, walls: wall("minimax") });
	assert.equal(both.model, undefined);
	assert.equal(both.source, "none");
});
