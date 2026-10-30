import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SNAPSHOT_FRESH_MS, activeWalls, chatRoles, fallbackRef, freshRoutingSnapshot, learnQuotaWall, loadPoolConfig, parsePoolConfig, persistProviderWall, poolConfigPath, providerOf, rankLaneRoutes, readRouteDecisions, readRoutingSnapshot, resolveLaneModel, routeDecisionLine, routePool, startRef, type PoolConfig, type PoolState, type RoutingSnapshot, type Wall, wallKey } from "../provider-pool.ts";
import { classifyQuota } from "../quota-classifier.ts";
import { harnessRoot } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);

const HERE = dirname(fileURLToPath(import.meta.url));
process.env.PI_PROVIDER_WALLS_PATH = join(mkdtempSync(join(tmpdir(), "pool-learned-")), "provider-walls.json");
writeFileSync(process.env.PI_PROVIDER_WALLS_PATH, "{}\n");
const SHIPPED = poolConfigPath();
const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const HOUR = 3_600_000;

function config(overrides: Record<string, unknown> = {}): PoolConfig {
	const parsed = parsePoolConfig({
		version: 1,
		virtualProvider: "pool",
		cooldownMs: HOUR,
		resetHorizonMs: 24 * HOUR,
		roles: { r: ["alpha/a", "beta/b", "gamma/c"] },
		quotaShapes: [{ id: "wall", match: "QUOTA_WALL", reset: { kind: "iso", pattern: "until (\\d{4}-\\d{2}-\\d{2}T[\\d:]+Z)" } }],
		...overrides,
	});
	assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join("; "));
	return (parsed as { ok: true; config: PoolConfig }).config;
}
const always = () => true;
const wallMessage = (until?: string) => ({ stopReason: "error", errorMessage: `429: QUOTA_WALL${until ? ` until ${until}` : ""}` });
const route = (cfg: PoolConfig, input: Partial<Parameters<typeof routePool>[0]> & { reason: Parameters<typeof routePool>[0]["reason"] }) =>
	routePool({ config: cfg, role: "r", now: NOW, newRun: false, available: always, ...input });

// --- shipped file ---------------------------------------------------------------------------

test("the shipped provider list is valid and every role chain visits each of its paid providers once (a free ref has a wall of its own)", () => {
	const loaded = loadPoolConfig(SHIPPED);
	assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.errors.join("; "));
	const { config: shipped } = loaded as { ok: true; config: PoolConfig };
	for (const [role, chain] of Object.entries(shipped.roles)) {
		const providers = chain.filter((ref) => !shipped.freeRefs.includes(ref)).map(providerOf);
		assert.equal(new Set(providers).size, providers.length, `${role} repeats a provider`);
	}
	// SK3 lands inert: the second account is off until its keys exist (C5b).
	assert.deepEqual(shipped.employerAccounts, []);
});

test("shipped roles do not all start on one provider (the balance across three providers is in the fallbacks, see below)", () => {
	const { config: shipped } = loadPoolConfig(SHIPPED) as { ok: true; config: PoolConfig };
	const starts = new Set(Object.values(shipped.roles).map((chain) => providerOf(chain[0])));
	assert.ok(starts.size >= 2, `starts: ${[...starts].join(", ")}`);
	for (const role of ["session", "worker", "memory", "build", "verify", "research"]) assert.ok(shipped.roles[role], `role ${role}`);
});

test("shipped chains hold workhorse models only: frontier models stay pinned to their roles", () => {
	const raw = readFileSync(SHIPPED, "utf8");
	const roles = (JSON.parse(raw) as { roles: Record<string, string[]> }).roles;
	for (const [role, chain] of Object.entries(roles)) {
		for (const ref of chain) assert.doesNotMatch(ref, /claude|opus|sonnet|native\/|gpt-6-sol|astra|gpt-5\.6-(sol|terra)/i, `${role}: ${ref}`);
	}
});

// --- validation -----------------------------------------------------------------------------

test("parsePoolConfig reports every problem and never throws", () => {
	for (const [name, raw, expected] of [
		["not an object", 7, /object/],
		["no roles", { version: 1, virtualProvider: "pool", cooldownMs: 1, resetHorizonMs: 1, roles: {}, quotaShapes: [] }, /roles/],
		["empty chain", { version: 1, virtualProvider: "pool", cooldownMs: 1, resetHorizonMs: 1, roles: { r: [] }, quotaShapes: [{ id: "x", match: "x" }] }, /role "r"/],
		["bad ref", { version: 1, virtualProvider: "pool", cooldownMs: 1, resetHorizonMs: 1, roles: { r: ["nomodel"] }, quotaShapes: [{ id: "x", match: "x" }] }, /provider\/model/],
		["repeated provider", { version: 1, virtualProvider: "pool", cooldownMs: 1, resetHorizonMs: 1, roles: { r: ["a/x", "a/y"] }, quotaShapes: [{ id: "x", match: "x" }] }, /repeats provider "a"/],
		["bad cooldown", { version: 1, virtualProvider: "pool", cooldownMs: 0, resetHorizonMs: 1, roles: { r: ["a/x"] }, quotaShapes: [{ id: "x", match: "x" }] }, /cooldownMs/],
		["bad regex", { version: 1, virtualProvider: "pool", cooldownMs: 1, resetHorizonMs: 1, roles: { r: ["a/x"] }, quotaShapes: [{ id: "broken", match: "(" }] }, /shape "broken"/],
		["no shapes", { version: 1, virtualProvider: "pool", cooldownMs: 1, resetHorizonMs: 1, roles: { r: ["a/x"] }, quotaShapes: [] }, /quotaShapes/],
		["bad wall date", { version: 1, virtualProvider: "pool", cooldownMs: 1, resetHorizonMs: 1, roles: { r: ["a/x"] }, providerWalls: { a: { until: "soon" } }, quotaShapes: [{ id: "x", match: "x" }] }, /providerWalls/],
		["employerAccounts not an array", { version: 1, virtualProvider: "pool", cooldownMs: 1, resetHorizonMs: 1, roles: { r: ["a/x"] }, employerAccounts: "a", quotaShapes: [{ id: "x", match: "x" }] }, /employerAccounts/],
		["employerAccounts names an unrouted provider", { version: 1, virtualProvider: "pool", cooldownMs: 1, resetHorizonMs: 1, roles: { r: ["a/x"] }, employerAccounts: ["opencode-go"], quotaShapes: [{ id: "x", match: "x" }] }, /not a provider this file routes/],
		["employerAccounts repeats", { version: 1, virtualProvider: "pool", cooldownMs: 1, resetHorizonMs: 1, roles: { r: ["a/x"] }, employerAccounts: ["a", "a"], quotaShapes: [{ id: "x", match: "x" }] }, /repeats "a"/],
	] as const) {
		const parsed = parsePoolConfig(raw);
		assert.equal(parsed.ok, false, name);
		assert.match((parsed as { errors: string[] }).errors.join("\n"), expected, name);
	}
});

test("loadPoolConfig reports a missing or malformed file as not ok", () => {
	assert.equal(loadPoolConfig(join(piAgentDir(), "extensions", "tests", "no-such-pool.json")).ok, false);
	assert.equal(loadPoolConfig(join(HERE, "fixtures", "quota-samples.json")).ok, false);
});

test("employerAccounts parses a routed provider, and an absent field is the empty list", () => {
	const base = { version: 1, virtualProvider: "pool", cooldownMs: 1, resetHorizonMs: 1, roles: { r: ["opencode-go/x", "zai/y"] } };
	const shapes = [{ id: "x", match: "x" }];
	const parsed = parsePoolConfig({ ...base, employerAccounts: ["opencode-go"], quotaShapes: shapes });
	assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join("; "));
	if (parsed.ok) assert.deepEqual(parsed.config.employerAccounts, ["opencode-go"]);
	const absent = parsePoolConfig({ ...base, quotaShapes: shapes });
	assert.equal(absent.ok, true, absent.ok ? "" : absent.errors.join("; "));
	if (absent.ok) assert.deepEqual(absent.config.employerAccounts, []);
});

// --- routing --------------------------------------------------------------------------------

test("(a) the first request of a new run returns to the primary once its wall has passed", () => {
	const state: PoolState = { walls: { alpha: { until: NOW - 1, source: "error" } } };
	const result = route(config(), { reason: "continuation", newRun: true, previous: "beta/b", state });
	assert.equal(result.ref, "alpha/a");
	assert.equal(result.consumedNewRun, true);
});

test("(a2) a new run stays on the fallback while the primary's wall is active", () => {
	const state: PoolState = { walls: { alpha: { until: NOW + HOUR, source: "error" } } };
	const result = route(config(), { reason: "user", newRun: true, previous: "beta/b", state });
	assert.equal(result.ref, "beta/b");
	assert.equal(result.consumedNewRun, true);
});

test("(b) a later request in the same run keeps the current model even after the wall passed", () => {
	const state: PoolState = { walls: { alpha: { until: NOW - 1, source: "error" } } };
	const result = route(config(), { reason: "continuation", newRun: false, previous: "beta/b", state });
	assert.equal(result.ref, "beta/b");
	assert.equal(result.consumedNewRun, false);
});

test("(c) a mid-run steer, which routes as `user`, does not switch back", () => {
	const state: PoolState = { walls: { alpha: { until: NOW - 1, source: "error" } } };
	assert.equal(route(config(), { reason: "user", newRun: false, previous: "beta/b", state }).ref, "beta/b");
});

test("(d) a retry whose error is a quota wall moves to the next provider and records the wall", () => {
	const result = route(config(), { reason: "retry", failed: { ref: "alpha/a", message: wallMessage() } });
	assert.equal(result.ref, "beta/b");
	assert.deepEqual(result.state, { walls: { alpha: { until: NOW + HOUR, source: "cooldown" } } });
});

test("(d1) the wall lifts at the time the error names, or at the cooldown when that time is unusable", () => {
	const cfg = config();
	const lift = (message: ReturnType<typeof wallMessage>) =>
		route(cfg, { reason: "retry", failed: { ref: "alpha/a", message } }).state?.walls.alpha;
	assert.deepEqual(lift(wallMessage("2026-10-06T15:00:00Z")), { until: Date.parse("2026-10-06T15:00:00Z"), source: "error" });
	assert.deepEqual(lift(wallMessage("2026-10-06T11:00:00Z")), { until: NOW + HOUR, source: "cooldown" }, "in the past");
	assert.deepEqual(lift(wallMessage("2026-12-06T15:00:00Z")), { until: NOW + HOUR, source: "cooldown" }, "beyond the horizon");
});

test("(d2) a retry whose error is capacity moves to the next ref and walls nothing (ROUTERFAIL, Henry 2026-10-29)", () => {
	// The rule this replaces: "a retry whose error is transient stays on the failed model". Henry's item makes a
	// 429, a 503 and "overloaded" a failover signal, so the request moves on; the provider is not parked, because a
	// capacity answer is not a wall and the same ref usually answers again a minute later.
	const result = route(config(), { reason: "retry", failed: { ref: "alpha/a", message: { stopReason: "error", errorMessage: "429: temporarily overloaded" } } });
	assert.equal(result.ref, "beta/b");
	assert.equal(result.state, undefined);
});

test("(d3) a quota retry on the second provider goes to the third, never back to a primary whose wall just passed", () => {
	const state: PoolState = { walls: { alpha: { until: NOW - 1, source: "error" } } };
	const result = route(config(), { reason: "retry", state, failed: { ref: "beta/b", message: wallMessage() } });
	assert.equal(result.ref, "gamma/c");
});

test("(e) a direct request never consumes the new-run flag and carries no state", () => {
	const state: PoolState = { walls: { alpha: { until: NOW + HOUR, source: "error" } } };
	const result = route(config(), { reason: "direct", newRun: true, state });
	assert.equal(result.consumedNewRun, false);
	assert.equal(result.ref, "beta/b");
	assert.equal(result.state, undefined);
});

test("(f) a resumed session with a wall in the past returns to the primary", () => {
	const state: PoolState = JSON.parse(JSON.stringify({ walls: { alpha: { until: NOW - 5 * HOUR, source: "cooldown" } } }));
	assert.equal(route(config(), { reason: "user", newRun: true, previous: "gamma/c", state }).ref, "alpha/a");
});

test("walls the watcher found are merged into the route and stored", () => {
	const result = route(config(), { reason: "user", previous: "beta/b", pending: { beta: { until: NOW + HOUR, source: "cooldown" } } });
	assert.equal(result.ref, "gamma/c");
	assert.deepEqual(result.state?.walls.beta, { until: NOW + HOUR, source: "cooldown" });
});

test("a provider walled in the file, or without credentials, is skipped", () => {
	const cfg = config({ providerWalls: { alpha: { until: "2026-10-10T00:00:00Z" } } });
	assert.equal(route(cfg, { reason: "user", newRun: true }).ref, "beta/b");
	assert.equal(route(config(), { reason: "user", newRun: true, available: (ref) => providerOf(ref) !== "alpha" }).ref, "beta/b");
});

test("a state is returned only when it changed", () => {
	assert.equal(route(config(), { reason: "continuation", previous: "alpha/a", state: { walls: {} } }).state, undefined);
});

test("with every provider walled the router probes the one whose wall lifts first and does not throw", () => {
	const state: PoolState = { walls: { alpha: { until: NOW + 3 * HOUR, source: "error" }, beta: { until: NOW + HOUR, source: "error" }, gamma: { until: NOW + 2 * HOUR, source: "cooldown" } } };
	assert.equal(route(config(), { reason: "user", newRun: true, state }).ref, "beta/b");
});

test("with no usable model at all the router says so", () => {
	assert.throws(() => route(config(), { reason: "user", available: () => false }), /no usable model/);
});

test("a role the file does not define is an error naming the role", () => {
	assert.throws(() => route(config(), { reason: "user", role: "ghost" }), /role "ghost"/);
});

// --- one owner for delegates, memory and workers --------------------------------------------

test("startRef gives the first model whose provider is not walled", () => {
	const cfg = config();
	assert.equal(startRef(cfg, "r", { now: NOW }), "alpha/a");
	assert.equal(startRef(cfg, "r", { now: NOW, walls: { alpha: { until: NOW + HOUR, source: "error" } } }), "beta/b");
	assert.equal(startRef(cfg, "ghost", { now: NOW }), undefined);
});

test("activeWalls merges the file's walls with learned ones and drops expired entries", () => {
	const cfg = config({ providerWalls: { gamma: { until: "2026-10-10T00:00:00Z" } } });
	const walls = activeWalls(cfg, { walls: { alpha: { until: NOW + HOUR, source: "error" }, beta: { until: NOW - 1, source: "error" } } }, NOW);
	assert.deepEqual(Object.keys(walls).sort(), ["alpha", "gamma"]);
	assert.equal(walls.gamma.source, "config");
});

test("fallbackRef is the next usable ref on a different, unwalled provider; a primary outside the role gets the first usable provider other than its own", () => {
	const cfg = config();
	assert.equal(fallbackRef(cfg, "r", "alpha/a", { now: NOW }), "beta/b");
	assert.equal(fallbackRef(cfg, "r", "gamma/c", { now: NOW }), "alpha/a", "wraps to the head");
	assert.equal(fallbackRef(cfg, "r", "alpha/a", { now: NOW, walls: { beta: { until: NOW + HOUR, source: "error" } } }), "gamma/c");
	assert.equal(fallbackRef(cfg, "r", "alpha/a", { now: NOW, available: (ref) => providerOf(ref) === "alpha" }), undefined);
	assert.equal(fallbackRef(cfg, "r", "elsewhere/x", { now: NOW }), "alpha/a", "an operator-pinned primary: the list supplies only the fallback");
	assert.equal(fallbackRef(cfg, "r", "alpha/other-model", { now: NOW }), "beta/b", "a different model of a chain provider still skips that provider");
	assert.equal(fallbackRef(cfg, "ghost", "alpha/a", { now: NOW }), undefined);
});

test("shipped lists route VR18 (the operator 2026-10-17): with the personal OpenCode Go refs gone the list supplies each mode's fallback from its chain's head — Luna on build, verify and research, z.ai GLM 5.3 Flash on memory — and workers still start on Command Code DeepSeek v4.1 Flash (the operator 2026-10-07)", () => {
	const { config: shipped } = loadPoolConfig(SHIPPED) as { ok: true; config: PoolConfig };
	const now = Date.parse("2026-10-06T12:00:00Z");
	const primary = "opencode-go/deepseek-v4.1-flash";
	// The list supplies only the fallback for an operator-pinned primary. VR18 (the operator 2026-10-17)
	// removed the personal OpenCode Go refs, so the primaries the settings still pin
	// (delegate-mode-settings.json, unchanged) name a provider no chain holds: the walk starts at
	// the role's head, which is Luna on all three (H2's balance pin was already superseded when
	// the operator moved the three primaries to the same provider).
	// 2026-10-23 (the operator): chains hold only Command Code DeepSeek V4.1 Flash then MiniMax M3.1 Flash.
	const fallbacks: Record<string, string> = { build: "command-code/deepseek/deepseek-v4.1-flash", verify: "command-code/deepseek/deepseek-v4.1-flash", research: "command-code/deepseek/deepseek-v4.1-flash" };
	for (const role of ["build", "verify", "research"] as const) {
		assert.equal(fallbackRef(shipped, role, primary, { now }), fallbacks[role], `${role}'s fallback`);
	}
	// memory's primary has its own owner (memory/settings.json, still gpt-5.6-luna); the list's
	// memory fallback chain starts on z.ai GLM 5.3 Flash, its head, now that VR18 removed the
	// personal OpenCode Go refs.
	const memorySettings = JSON.parse(readFileSync(join(piAgentDir(), "memory", "settings.json"), "utf8")) as { extractionModel: string };
	assert.equal(memorySettings.extractionModel, "openai-codex/gpt-5.6-luna");
	assert.equal(fallbackRef(shipped, "memory", memorySettings.extractionModel, { now }), "command-code/deepseek/deepseek-v4.1-flash");
	// Workers start on the chain head (the operator 2026-10-07: DeepSeek v4.1 Flash on the new Command Code key);
	// the start does not move, today or after 10 October.
	assert.equal(shipped.roles.worker[0], "command-code/deepseek/deepseek-v4.1-flash");
	assert.equal(startRef(shipped, "worker", { now }), shipped.roles.worker[0]);
	assert.equal(startRef(shipped, "worker", { now: Date.parse("2026-10-11T00:00:00Z") }), shipped.roles.worker[0]);
});

test("the pure provider list libraries load under bare Node, which the Muster tick and memory CLI use without a transpiler", () => {
	const lib = join(HARNESS_ROOT, "routing");
	const probe = [
		`const pool = await import(${JSON.stringify(join(lib, "provider-pool.ts"))});`,
		`const loaded = pool.loadPoolConfig(${JSON.stringify(SHIPPED)});`,
		`console.log(JSON.stringify({ ok: loaded.ok, start: pool.startRef(loaded.config, "session", { now: Date.now() }) }));`,
	].join("\n");
	const out = execFileSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8" });
	// The probe proves the load, not the head: the head is provider-pool.json's, and reading it
	// here is what keeps this assertion from going stale when the owner reorders the chain.
	const shipped = (loadPoolConfig(SHIPPED) as { ok: true; config: PoolConfig }).config;
	assert.deepEqual(JSON.parse(out.trim().split("\n").at(-1)!), { ok: true, start: shipped.roles.session[0] });
});

test("memory's primary has one owner, memory/settings.json: the memory role lists no Luna, only fallbacks on other providers", () => {
	const { config: shipped } = loadPoolConfig(SHIPPED) as { ok: true; config: PoolConfig };
	assert.ok(shipped.roles.memory.every((ref) => providerOf(ref) !== "openai-codex"), shipped.roles.memory.join(", "));
});

test("the session role starts on the model the operator made his first choice (the operator, 2026-10-10 20:34Z), with the paid providers then the free refs last", () => {
	const { config: shipped } = loadPoolConfig(SHIPPED) as { ok: true; config: PoolConfig };
	// Update this pin when the operator re-routes the Pi session start. the operator moved it to Command Code DeepSeek
	// V4.1 Flash at 2026-10-10 20:34Z, "the first choice right now" (Pi session
	// 01a1274a-08d6-77c8-bda4-b7cd7c8c646e), implemented in de21fd5 and recorded in provider-pool.json's
	// _note; Luna held the session start before that (H1). VR18 removed the paid personal OpenCode Go
	// ref that sat between zai and MiniMax.
	assert.equal(shipped.roles.session[0], "command-code/deepseek/deepseek-v4.1-flash");
	assert.deepEqual(shipped.roles.session.slice(1).filter((ref) => !shipped.freeRefs.includes(ref)).map(providerOf), ["minimax"], "then MiniMax (2026-10-23: the only other paid provider)");
});

// --- roles that are not chat models (a classifier) ------------------------------------------

function withClassifier(): PoolConfig {
	return config({ roles: { r: ["alpha/a", "beta/b", "gamma/c"], clf: ["router/classifier-1"] }, nonChatRoles: ["clf"] });
}

test("a role named in nonChatRoles must exist, and the list is optional", () => {
	const bad = parsePoolConfig({ version: 1, virtualProvider: "pool", cooldownMs: 1, resetHorizonMs: 1, roles: { r: ["a/x"] }, nonChatRoles: ["ghost"], quotaShapes: [{ id: "x", match: "x" }] });
	assert.equal(bad.ok, false);
	assert.match((bad as { errors: string[] }).errors.join("\n"), /nonChatRoles.*"ghost"/);
	assert.deepEqual(chatRoles(config()), ["r"], "no nonChatRoles means every role is a chat role");
});

test("a classifier role is loaded and readable, but is never a chat role: no start, no fallback, no route", () => {
	const cfg = withClassifier();
	assert.deepEqual(cfg.roles.clf, ["router/classifier-1"], "its consumer reads the first ref from the loaded list");
	assert.deepEqual(chatRoles(cfg), ["r"]);
	assert.equal(startRef(cfg, "clf", { now: NOW }), undefined);
	assert.equal(fallbackRef(cfg, "clf", "router/classifier-1", { now: NOW }), undefined);
	assert.throws(() => route(cfg, { reason: "user", role: "clf" }), /not a chat role/);
	assert.equal(startRef(cfg, "r", { now: NOW }), "alpha/a", "chat roles are unaffected");
});

test("the shipped list's classifier role is one ref, and it is not a chat role", () => {
	const { config: shipped } = loadPoolConfig(SHIPPED) as { ok: true; config: PoolConfig };
	assert.deepEqual(shipped.roles.classifier, ["openrouter/typesafe/jev-1.13"]);
	assert.ok(!chatRoles(shipped).includes("classifier"));
	assert.equal(startRef(shipped, "classifier", { now: NOW }), undefined);
});

// --- ceilings (NLB, D18) ----------------------------------------------------------------------

test("ceilings.classifier.usdPerMonth is read from the file, and a file without ceilings parses as before", () => {
	assert.deepEqual(config({ ceilings: { classifier: { usdPerMonth: 2 } } }).ceilings, { classifier: { usdPerMonth: 2 } });
	assert.equal(config().ceilings, undefined);
});

test("a ceiling of zero, a negative number, a string or a non-number is refused, and so is an unknown key", () => {
	const base = { version: 1, virtualProvider: "pool", cooldownMs: 1, resetHorizonMs: 1, roles: { r: ["a/x"] }, quotaShapes: [{ id: "x", match: "x" }] };
	for (const usdPerMonth of [0, -1, "2", null, Number.NaN, Number.POSITIVE_INFINITY]) {
		const result = parsePoolConfig({ ...base, ceilings: { classifier: { usdPerMonth } } });
		assert.equal(result.ok, false, `usdPerMonth ${String(usdPerMonth)}`);
		assert.match((result as { errors: string[] }).errors.join("\n"), /ceilings\.classifier\.usdPerMonth/);
	}
	const unknownCeiling = parsePoolConfig({ ...base, ceilings: { worker: { usdPerMonth: 2 } } });
	assert.equal(unknownCeiling.ok, false);
	assert.match((unknownCeiling as { errors: string[] }).errors.join("\n"), /ceilings.*worker/);
	const unknownKey = parsePoolConfig({ ...base, ceilings: { classifier: { usdPerMonth: 2, perDay: 1 } } });
	assert.equal(unknownKey.ok, false);
	assert.match((unknownKey as { errors: string[] }).errors.join("\n"), /ceilings\.classifier.*perDay/);
	assert.equal(parsePoolConfig({ ...base, ceilings: [] }).ok, false);
});

test("the tracked provider-pool.json carries the $2 monthly classifier ceiling and the router's own $1 (VR24-39, VR24-204)", () => {
	const { config: shipped } = loadPoolConfig(SHIPPED) as { ok: true; config: PoolConfig };
	assert.deepEqual(shipped.ceilings, { classifier: { usdPerMonth: 2 }, routing: { usdPerMonth: 1 } });
});

// --- free refs ------------------------------------------------------------------------------

const FREE_ROLES = { r: ["alpha/a", "beta/b", "beta/free-1", "beta/free-2"] };
const freeConfig = (overrides: Record<string, unknown> = {}) => config({ roles: FREE_ROLES, freeRefs: ["beta/free-1", "beta/free-2"], ...overrides });
const providerWall = { until: NOW + HOUR, source: "error" as const };

test("freeRefs: every listed ref must be a ref of a chat role, and the list is optional", () => {
	assert.deepEqual(config().freeRefs, []);
	assert.deepEqual(freeConfig().freeRefs, ["beta/free-1", "beta/free-2"]);
	const base = { version: 1, virtualProvider: "pool", cooldownMs: HOUR, resetHorizonMs: 24 * HOUR, quotaShapes: [{ id: "w", match: "W" }] };
	const notInRole = parsePoolConfig({ ...base, roles: { r: ["alpha/a"] }, freeRefs: ["beta/ghost"] });
	assert.equal(notInRole.ok, false);
	assert.match((notInRole as { errors: string[] }).errors.join(";"), /freeRefs.*beta\/ghost.*chat role/);
	const inNonChat = parsePoolConfig({ ...base, roles: { r: ["alpha/a"], c: ["beta/judge"] }, nonChatRoles: ["c"], freeRefs: ["beta/judge"] });
	assert.equal(inNonChat.ok, false, "a classifier ref is not a chat ref");
	assert.equal(parsePoolConfig({ ...base, roles: { r: ["alpha/a"] }, freeRefs: "alpha/a" }).ok, false);
	assert.equal(parsePoolConfig({ ...base, roles: { r: ["alpha/a"] }, freeRefs: ["not-a-ref"] }).ok, false);
});

test("a free ref may share a provider with a paid ref or with another free ref; any other repeat stays an error", () => {
	assert.equal(providerOf("beta/b"), providerOf("beta/free-1"));
	const repeatsPaid = parsePoolConfig({ version: 1, virtualProvider: "pool", cooldownMs: HOUR, resetHorizonMs: 24 * HOUR, quotaShapes: [{ id: "w", match: "W" }], roles: { r: ["alpha/a", "beta/b", "beta/c"] } });
	assert.equal(repeatsPaid.ok, false);
	assert.match((repeatsPaid as { errors: string[] }).errors.join(";"), /repeats provider "beta"/);
	const repeatsFree = parsePoolConfig({ version: 1, virtualProvider: "pool", cooldownMs: HOUR, resetHorizonMs: 24 * HOUR, quotaShapes: [{ id: "w", match: "W" }], roles: { r: ["alpha/a", "beta/free-1", "beta/free-1"] }, freeRefs: ["beta/free-1"] });
	assert.equal(repeatsFree.ok, false, "the same free ref twice in one chain");
});

test("a free ref's wall is keyed by the full ref; a paid ref's wall by its provider", () => {
	const cfg = freeConfig();
	assert.equal(wallKey(cfg, "beta/b"), "beta");
	assert.equal(wallKey(cfg, "beta/free-1"), "beta/free-1");
	assert.equal(wallKey(config(), "beta/free-1"), "beta", "without freeRefs nothing changes");
});

// --- SK4: walls and cooldowns per account (SK-D7) ----------------------------------------------

/** The shipped split: a paid ref and a free ref of one provider whose work runs on the second account. */
const SPLIT = { roles: { r: ["opencode-go/paid", "zai/glm-x", "opencode-go/free-1"] }, freeRefs: ["opencode-go/free-1"], employerAccounts: ["opencode-go"] };

test("a split provider's wall is keyed per account; a personal process keeps today's key", () => {
	const cfg = config(SPLIT);
	assert.equal(wallKey(cfg, "opencode-go/paid", undefined), "opencode-go", "a personal process keeps the bare key");
	assert.equal(wallKey(cfg, "opencode-go/paid", "acme-realty"), "opencode-go@acme-realty");
	assert.equal(wallKey(cfg, "opencode-go/free-1", "acme-realty"), "opencode-go/free-1@acme-realty", "a free ref of a split provider is per account too");
	assert.equal(wallKey(cfg, "opencode-go/free-1", undefined), "opencode-go/free-1");
	assert.equal(wallKey(cfg, "zai/glm-x", "acme-realty"), "zai", "a provider outside employerAccounts is unchanged");
	assert.equal(wallKey(cfg, "zai/glm-x", undefined), "zai");
	assert.equal(wallKey(config(), "beta/b", "acme-realty"), "beta", "with employerAccounts empty nothing changes (the shipped file)");
	assert.notEqual(wallKey(cfg, "opencode-go/free-1", "acme-realty"), wallKey(cfg, "opencode-go/free-1", undefined), "the work free ref and the personal free ref never meet");
});

test("a wall an Acme Realty process writes lands under the work key; a personal write names the account it reads", () => {
	const cfg = config(SPLIT);
	const walls = () => JSON.parse(readFileSync(process.env.PI_PROVIDER_WALLS_PATH!, "utf8")) as Record<string, { until: string }>;
	const prior = process.env.PI_EMPLOYER;
	try {
		process.env.PI_EMPLOYER = "acme-realty";
		learnQuotaWall(cfg, "opencode-go/paid", { shapeId: "w", resetAt: NOW + HOUR }, NOW);
		assert.ok(walls()["opencode-go@acme-realty"], "a work write carries the account");
		process.env.PI_EMPLOYER = undefined;
		learnQuotaWall(cfg, "opencode-go/paid", { shapeId: "w", resetAt: NOW + HOUR }, NOW);
		// AR16: the wall names the account the process reads, which for a plan with accounts is the plan's
		// routed account (the personal key of a single-account plan stays bare, as before).
		assert.ok(walls()["opencode-go@second account"], "a personal write names the account it reads");
	} finally {
		process.env.PI_EMPLOYER = prior;
	}
});

test("a work wall blocks only work processes; a personal wall blocks only personal ones", () => {
	const cfg = config(SPLIT);
	const wall: Wall = { until: NOW + HOUR, source: "error" };
	const prior = process.env.PI_EMPLOYER;
	try {
		process.env.PI_EMPLOYER = "acme-realty";
		assert.equal(startRef(cfg, "r", { now: NOW, walls: { "opencode-go@acme-realty": wall } }), "zai/glm-x", "the work process sees its own account's wall");
		assert.equal(startRef(cfg, "r", { now: NOW, walls: { "opencode-go": wall } }), "opencode-go/paid", "a personal wall leaves the work process open");
		process.env.PI_EMPLOYER = "personal";
		assert.equal(startRef(cfg, "r", { now: NOW, walls: { "opencode-go": wall } }), "zai/glm-x", "an existing walls-file key still walls the personal process");
		assert.equal(startRef(cfg, "r", { now: NOW, walls: { "opencode-go@acme-realty": wall } }), "opencode-go/paid", "a work wall leaves the personal ref open");
	} finally {
		process.env.PI_EMPLOYER = prior;
	}
});

test("a provider wall, learned or from the file, does not block its free refs; a wall on a free ref blocks only that ref", () => {
	const learned = { beta: providerWall };
	assert.equal(route(freeConfig(), { reason: "retry", failed: { ref: "alpha/a", message: wallMessage() }, state: { walls: learned } }).ref, "beta/free-1", "alpha and beta are walled: the free ref serves, not the probe of a walled provider");
	const filed = freeConfig({ providerWalls: { beta: { until: "2026-10-10T00:00:00Z" } } });
	assert.equal(startRef(filed, "r", { now: NOW, walls: { alpha: providerWall } }), "beta/free-1");

	const onFree = route(freeConfig(), { reason: "retry", failed: { ref: "beta/free-1", message: wallMessage() } });
	assert.deepEqual(Object.keys(onFree.state!.walls), ["beta/free-1"], "the paid provider is not walled by a free ref");
	assert.equal(onFree.ref, "alpha/a", "a usable paid ref comes before the other free ref");
});

test("a quota error on a paid ref walls the provider, not its free refs", () => {
	const outcome = route(freeConfig(), { reason: "retry", failed: { ref: "beta/b", message: wallMessage() }, state: { walls: { alpha: providerWall } } });
	assert.deepEqual(Object.keys(outcome.state!.walls).sort(), ["alpha", "beta"]);
	assert.equal(outcome.ref, "beta/free-1", "the free ref of the walled provider keeps serving");
});

test("free refs are the last resort: a usable paid ref, even behind the wrap, is preferred", () => {
	assert.equal(route(freeConfig(), { reason: "retry", failed: { ref: "beta/b", message: wallMessage() } }).ref, "alpha/a");
	assert.equal(fallbackRef(freeConfig(), "r", "alpha/a", { now: NOW }), "beta/b");
	assert.equal(fallbackRef(freeConfig(), "r", "alpha/a", { now: NOW, walls: { beta: providerWall } }), "beta/free-1");
});

test("with every ref walled the router still probes the one whose own wall lifts first", () => {
	const walls = { alpha: providerWall, beta: providerWall, "beta/free-1": { until: NOW + 2 * HOUR, source: "error" as const }, "beta/free-2": { until: NOW + HOUR / 2, source: "error" as const } };
	assert.equal(route(freeConfig(), { reason: "direct", state: { walls } }).ref, "beta/free-2");
});

test("fallbackRef and startRef: a free ref is selectable whenever its own wall is clear, also on its primary's provider", () => {
	const cfg = freeConfig();
	assert.equal(fallbackRef(cfg, "r", "beta/b", { now: NOW, walls: { alpha: providerWall } }), "beta/free-1", "a free ref on the primary's provider is still a different wall");
	assert.equal(fallbackRef(cfg, "r", "beta/b", { now: NOW, walls: { alpha: providerWall, beta: providerWall, "beta/free-1": providerWall } }), "beta/free-2");
	assert.equal(fallbackRef(cfg, "r", "beta/free-1", { now: NOW, walls: { "beta/free-2": providerWall } }), "alpha/a");
	assert.equal(fallbackRef(cfg, "r", "beta/b", { now: NOW, walls: { "beta/free-1": providerWall, "beta/free-2": providerWall } }), "alpha/a");
	assert.equal(startRef(cfg, "r", { now: NOW, walls: { alpha: providerWall, beta: providerWall } }), "beta/free-1");
});

test("the shipped list carries its one free chat ref once in every chat chain, and no role chain carries an opencode/ ref: Zen serves the free GLM 5.3 Flash only to the OpenCode client (2026-10-18)", () => {
	const { config: shipped } = loadPoolConfig(SHIPPED) as { ok: true; config: PoolConfig };
	const free: string[] = []; // 2026-10-23 (the operator): no free ref in any chain
	assert.deepEqual([...shipped.freeRefs].sort(), [...free].sort());
	for (const role of ["session", "worker", "memory", "build", "verify", "research"]) {
		// MiniMax is the one non-free entry after the free ref today: every chat chain still ends on it.
		assert.equal(shipped.roles[role].at(-1), "minimax/MiniMax-M3.1-Flash", `${role} ends on MiniMax`);
		assert.equal(shipped.roles[role].filter((ref) => shipped.freeRefs.includes(ref)).length, free.length, `${role} lists each free ref once`);
	}
	// Every role is run by Pi (session, delegate, memory, Muster worker): a Pi session on a Zen free
	// model dies with FreeTierError, so no role chain may carry an opencode/ ref. The OpenCode client's
	// default list (laneDefaults.opencode) is the one place such a ref lives.
	for (const [role, chain] of Object.entries(shipped.roles)) {
		assert.deepEqual(chain.filter((ref) => ref.startsWith("opencode/")), [], `${role}: no opencode/ ref in a Pi-run chain`);
	}
	assert.ok(shipped.laneDefaults, "the shipped pool has a laneDefaults section");
	assert.deepEqual(shipped.laneDefaults.pi.candidates.filter((ref) => ref.startsWith("opencode/")), [], "no opencode/ ref among the Pi lane candidates");
	assert.equal(shipped.laneDefaults.opencode[0], "minimax/MiniMax-M3.1-Flash", "OpenCode lanes run MiniMax M3.1 Flash (2026-10-23, z.ai spent)");
	// The session start is the pin above: the operator's 2026-10-10 20:34Z first choice (de21fd5), after Luna (H1).
	assert.equal(shipped.roles.session[0], "command-code/deepseek/deepseek-v4.1-flash", "the session start is the operator's recorded first choice (2026-10-10 20:34Z)");
	assert.equal(shipped.freeRefs.some((ref) => shipped.roles.classifier.includes(ref)), false);
});

test("fallbackRef skip walks past tried refs, including to a free ref", () => {
	assert.equal(fallbackRef(config(), "r", "alpha/a", { now: NOW, skip: new Set(["beta/b"]) }), "gamma/c");
	assert.equal(fallbackRef(freeConfig(), "r", "alpha/a", { now: NOW, skip: new Set(["beta/b"]) }), "beta/free-1");
	assert.equal(fallbackRef(freeConfig(), "r", "alpha/a", { now: NOW, skip: new Set(["beta/b", "beta/free-1"]) }), "beta/free-2");
});

test("persistProviderWall writes learned walls to the state file, not the pool file, and drops expired entries", () => {
	const dir = mkdtempSync(join(tmpdir(), "pool-wall-"));
	const poolPath = join(dir, "provider-pool.json");
	const wallsPath = join(dir, "provider-walls.json");
	const base = {
		version: 1, virtualProvider: "pool", cooldownMs: HOUR, resetHorizonMs: 24 * HOUR,
		roles: { r: ["alpha/a", "beta/b"] }, quotaShapes: [{ id: "w", match: "W" }],
		providerWalls: { operator: { until: "2999-01-01T00:00:00.000Z" } },
	};
	writeFileSync(poolPath, JSON.stringify(base, null, "\t"));
	writeFileSync(wallsPath, JSON.stringify({ stale: { until: "2020-01-01T00:00:00.000Z" } }));
	const until = NOW + HOUR;
	persistProviderWall("alpha", until, "weekly-monthly-window", NOW, wallsPath);
	const pool = JSON.parse(readFileSync(poolPath, "utf8")) as { providerWalls: Record<string, { until: string }> };
	assert.deepEqual(pool.providerWalls, base.providerWalls, "the tracked pool file is never written");
	const written = JSON.parse(readFileSync(wallsPath, "utf8")) as Record<string, { until: string; reason?: string }>;
	assert.equal(written.stale, undefined, "expired walls are dropped");
	assert.equal(written.alpha.until, new Date(until).toISOString());
	assert.equal(written.alpha.reason, "weekly-monthly-window");
});

// --- the one routing rule (P5-D1 O1, UM10) ---------------------------------------------------

const CHAIN = ["alpha/a", "beta/b", "gamma/c"];
const usage = (rows: ReadonlyArray<readonly [string, number]>): RoutingSnapshot => ({
	capturedAt: NOW,
	rows: rows.map(([provider, usedPercent]) => ({ provider, windows: [], meter: "read" as const, usedPercent: [usedPercent] })),
});
const verdicts = (ranked: ReadonlyArray<{ ref: string; verdict: string }>) => ranked.map((entry) => `${entry.ref}:${entry.verdict}`);

function rank(overrides: { snapshot?: RoutingSnapshot; walls?: Record<string, Wall>; runningLanes?: (provider: string) => number; available?: (ref: string) => boolean; candidates?: string[]; freeRefsLast?: boolean } = {}) {
	return rankLaneRoutes({
		config: config(),
		candidates: overrides.candidates ?? CHAIN,
		walls: overrides.walls ?? {},
		available: overrides.available ?? always,
		...(overrides.snapshot ? { snapshot: overrides.snapshot } : {}),
		...(overrides.runningLanes ? { runningLanes: overrides.runningLanes } : {}),
		...(overrides.freeRefsLast === undefined ? {} : { freeRefsLast: overrides.freeRefsLast }),
	});
}

test("the ranking keeps the owner's order when nothing is walled and nothing is spent", () => {
	assert.deepEqual(verdicts(rank()), ["alpha/a:chosen", "beta/b:open", "gamma/c:open"]);
});

test("a paid ref at or over 95% of a window moves behind the other paid refs, and below it does not", () => {
	assert.deepEqual(verdicts(rank({ snapshot: usage([["alpha", 96]]) })), ["beta/b:chosen", "gamma/c:open", "alpha/a:over-threshold"]);
	assert.deepEqual(verdicts(rank({ snapshot: usage([["alpha", 94]]) })), ["alpha/a:chosen", "beta/b:open", "gamma/c:open"]);
});

test("every paid ref at the threshold keeps the order: the step only reorders and never empties a role", () => {
	const all = usage([["alpha", 100], ["beta", 100], ["gamma", 100]]);
	assert.deepEqual(verdicts(rank({ snapshot: all })), ["alpha/a:chosen", "beta/b:over-threshold", "gamma/c:over-threshold"]);
});

test("free refs stay after every paid ref, and a caller may keep its own order instead", () => {
	const cfg = config({ freeRefs: ["gamma/c"] });
	const candidates = ["gamma/c", "alpha/a", "beta/b"];
	const chain = rankLaneRoutes({ config: cfg, candidates, walls: {}, available: always });
	assert.deepEqual(verdicts(chain), ["alpha/a:chosen", "beta/b:open", "gamma/c:free"]);
	const own = rankLaneRoutes({ config: cfg, candidates, walls: {}, available: always, freeRefsLast: false });
	assert.deepEqual(own.map((entry) => entry.ref), ["gamma/c", "alpha/a", "beta/b"]);
	// A free ref is never demoted for its provider's usage: the threshold is the paid refs' rule.
	const spent = rankLaneRoutes({ config: cfg, candidates, walls: {}, available: always, snapshot: usage([["gamma", 100]]) });
	assert.equal(spent.find((entry) => entry.ref === "gamma/c")?.verdict, "free");
});

test("among equal candidates the provider with the fewest running lanes wins", () => {
	const lanes = (provider: string) => ({ alpha: 2, beta: 0, gamma: 1 })[provider] ?? 0;
	assert.deepEqual(verdicts(rank({ runningLanes: lanes })), ["beta/b:chosen", "gamma/c:open", "alpha/a:open"]);
});

test("a walled and an unavailable ref are named, never chosen", () => {
	const ranked = rank({ walls: { alpha: { until: NOW + HOUR, source: "cooldown" } }, available: (ref) => ref !== "gamma/c" });
	assert.deepEqual(verdicts(ranked), ["beta/b:chosen", "alpha/a:walled", "gamma/c:unavailable"]);
});

test("startRef, fallbackRef, resolveLaneModel and routePool all walk the one ranked order", () => {
	const cfg = config({ laneDefaults: { pi: { candidates: ["alpha/a", "beta/b"], fallbackRole: "r" }, opencode: ["gamma/c"], claude: "sonnet" } });
	const snapshot = usage([["alpha", 97]]);
	assert.equal(startRef(cfg, "r", { now: NOW, snapshot }), "beta/b");
	assert.equal(fallbackRef(cfg, "r", "beta/b", { now: NOW, snapshot }), "gamma/c");
	const lane = resolveLaneModel(cfg, { harness: "pi", now: NOW, snapshot });
	assert.equal(lane.model, "beta/b");
	assert.deepEqual(lane.skipped, [{ ref: "alpha/a", reason: "over-threshold" }]);
	// A new run of the same role leads with the head that still has headroom, not the one at 97%.
	assert.equal(routePool({ config: cfg, role: "r", reason: "user", now: NOW, newRun: true, available: always, snapshot }).ref, "beta/b");
	// A retry after the head's wall walks the same ranked order: alpha is walled and beta is over
	// its provider's threshold, so the work reaches gamma instead of stopping at beta.
	const retry = routePool({ config: cfg, role: "r", reason: "retry", now: NOW, newRun: false, available: always, snapshot: usage([["beta", 97]]), failed: { ref: "alpha/a", message: wallMessage() } });
	assert.equal(retry.ref, "gamma/c");
});

test("the snapshot is read as a file, and a stale or unreadable one leaves the order alone", () => {
	const path = join(mkdtempSync(join(tmpdir(), "pool-snapshot-")), "snapshot.json");
	writeFileSync(path, JSON.stringify({ version: 1, capturedAt: NOW - SNAPSHOT_FRESH_MS - 1, providers: [{ provider: "alpha", quota: { primary: { usedPercent: 99 }, secondary: null } }] }));
	assert.equal(freshRoutingSnapshot(NOW, path), undefined, "an old snapshot decides nothing");
	writeFileSync(path, JSON.stringify({ version: 1, capturedAt: NOW - 1000, providers: [{ provider: "alpha", quota: { primary: { usedPercent: 99 }, secondary: { usedPercent: 40 } } }, { provider: "beta", quota: null }] }));
	assert.deepEqual(readRoutingSnapshot(path), {
		capturedAt: NOW - 1000,
		rows: [
			{ provider: "alpha", windows: [], meter: "read", usedPercent: [99, 40] },
			{ provider: "beta", windows: [], meter: "read", usedPercent: [] },
		],
	});
	writeFileSync(path, "{ torn");
	assert.equal(readRoutingSnapshot(path), undefined);
	writeFileSync(path, JSON.stringify({ version: 1, providers: [] }));
	assert.equal(readRoutingSnapshot(path), undefined, "no capturedAt is no snapshot");
});

test("a decision line is one JSON object, read back in order, and a torn line is skipped", () => {
	const path = join(mkdtempSync(join(tmpdir(), "pool-routing-")), "decisions.jsonl");
	const entry = { at: NOW, lane: "pi-um10", chosen: "alpha/a", by: "rule" as const, candidates: [{ ref: "alpha/a", verdict: "chosen" as const, reason: "usable" }] };
	writeFileSync(path, routeDecisionLine(entry));
	writeFileSync(path, routeDecisionLine({ ...entry, at: NOW + 1, by: "orchestrator", reason: "named on the command line" }), { flag: "a" });
	const read = readRouteDecisions(path);
	assert.equal(read.length, 2);
	assert.equal(read[0]?.lane, "pi-um10");
	assert.equal(read[1]?.by, "orchestrator");
	assert.equal(routeDecisionLine(entry).split("\n").length, 2, "one line per decision");
	writeFileSync(path, `${routeDecisionLine(entry)}{torn\n`);
	assert.equal(readRouteDecisions(path).length, 1);
	assert.deepEqual(readRouteDecisions(join(tmpdir(), "no-such-routing-log.jsonl")), []);
});

// --- a rejected credential (the opencode-go 401 of 2026-10-17) ---------------------------------

const CREDENTIAL_401 = { stopReason: "error", errorMessage: '401: {"type":"error","error":{"type":"AuthError","message":"Invalid credential"}}' };
const ENTITLEMENT_403 = { stopReason: "error", errorMessage: '403: {"type":"error","error":{"type":"EntitlementError","message":"No active Go plan"}}' };

test("a 401 Invalid credential walls the provider, so session, worker and build skip it (the 2026-10-17 cause; VR18 removed the personal OpenCode Go refs, so the fixture keeps them)", () => {
	const { config: shipped } = loadPoolConfig(SHIPPED) as { ok: true; config: PoolConfig };
	// The behaviour is generic; the shipped file stays the one owner of the quota wording.
	const parsed = parsePoolConfig({
		version: 1, virtualProvider: "pool", cooldownMs: HOUR, resetHorizonMs: 24 * HOUR,
		roles: {
			session: ["command-code/deepseek/deepseek-v4.1-flash", "opencode-go/deepseek-v4.1-flash", "zai/glm-5.3-flash"],
			worker: ["command-code/deepseek/deepseek-v4.1-flash", "opencode-go/glm-5.3-flash", "zai/glm-5.3-flash"],
			build: ["openai-codex/gpt-6-luna", "opencode-go/deepseek-v4.1-flash", "zai/glm-5.3-flash"],
		},
		quotaShapes: shipped.quotaShapes,
	});
	assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join("; "));
	const fixture = (parsed as { ok: true; config: PoolConfig }).config;
	for (const role of ["session", "worker", "build"]) {
		const failed = fixture.roles[role]?.find((ref) => providerOf(ref) === "opencode-go" && !fixture.freeRefs.includes(ref)) as string;
		assert.ok(failed, `${role} holds a paid opencode-go ref`);
		const retry = routePool({ config: fixture, role, reason: "retry", now: NOW, newRun: false, available: always, failed: { ref: failed, message: CREDENTIAL_401 } });
		assert.notEqual(providerOf(retry.ref), "opencode-go", `${role} retried on ${retry.ref}`);
		assert.ok(retry.state?.walls["opencode-go"], `${role} learned a wall on opencode-go`);
		// The learned wall is honoured by the start pick and by the failover from a ref ahead of it.
		const walls = retry.state?.walls ?? {};
		assert.notEqual(providerOf(startRef(fixture, role, { now: NOW, walls, available: always }) as string), "opencode-go");
		const chain = fixture.roles[role] as string[];
		const before = chain[chain.indexOf(failed) - 1] as string;
		assert.notEqual(fallbackRef(fixture, role, before, { now: NOW, walls, available: always }), failed, `${role} failover from ${before} skips ${failed}`);
	}
});

test("a 403 EntitlementError is a valid key without a plan, not a rejected credential, and walls nothing", () => {
	const { config: shipped } = loadPoolConfig(SHIPPED) as { ok: true; config: PoolConfig };
	assert.equal(classifyQuota(ENTITLEMENT_403, shipped.quotaShapes, NOW).quota, false);
	assert.equal(classifyQuota(CREDENTIAL_401, shipped.quotaShapes, NOW).quota, true, "the 401 is the contrast: it is a wall");
});
