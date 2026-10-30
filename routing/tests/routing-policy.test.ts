/**
 * The routing policy in the pool file (auto-routing blueprint 2026-10-25, section 4.4 and the AR5
 * row, VR24-100; VR24-91 for the Claude cap, VR24-92 for the Grok pause).
 *
 * `provider-pool.json` is the one owner of which model serves which role. Its `routing` section is
 * the one owner of which model a lane *kind* is placed on, how many Claude lanes may run at once,
 * and the path patterns a project's brief is classified by. This file checks the seed values, every
 * refusal the section owes, and the rule that a refused section is dropped with a warning instead of
 * failing the file: `pick` is off and nothing reads the table yet (AR6), so a typo in it must never
 * stop a lane launch.
 *
 * Nothing here reads the table or ranks a lane. That is AR6.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { TASK_KINDS, TASK_KIND_CLASS, loadPoolConfig, parsePoolConfig, poolConfigPath, resolveLaneModel, type LaneDefaults, type PoolConfig, type PoolRouting, withAdmittedFreeRef } from "../provider-pool.ts";
import { harnessRoot } from "../../core/harness-paths.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
const SHIPPED = poolConfigPath();
const CLI = join(HARNESS_ROOT, "muster", "lane-model.mjs");
const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const HOUR = 3_600_000;

// Learned walls live in a temp file so the live agent's walls never decide a test.
process.env.PI_PROVIDER_WALLS_PATH = join(mkdtempSync(join(tmpdir(), "routing-policy-walls-")), "provider-walls.json");
writeFileSync(process.env.PI_PROVIDER_WALLS_PATH, "{}\n");

const FLASH_ORDER = ["cc/ds-flash", "mm/flash", "zai/glm-flash"];
const FLASH_KINDS = ["ui", "copy", "test", "adapter", "config", "docs", "research-read"];
const HARD_KINDS = ["retry", "unknown-cause-bug", "shared-owner", "security-data", "perf"];

const LANE_DEFAULTS: LaneDefaults = {
	pi: { candidates: [...FLASH_ORDER], fallbackRole: "worker", hard: ["xai/grok-4.6"] },
	opencode: ["mm/flash"],
	claude: "sonnet",
};

/** A file with every other section valid, so only the `routing` section can be the reason for a refusal. */
function baseFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: 1,
		virtualProvider: "pool",
		cooldownMs: HOUR,
		resetHorizonMs: 24 * HOUR,
		freeRefs: [],
		roles: { worker: [...FLASH_ORDER], classifier: ["jev/classifier"] },
		nonChatRoles: ["classifier"],
		laneDefaults: LANE_DEFAULTS,
		quotaShapes: [{ id: "wall", match: "QUOTA_WALL" }],
		...overrides,
	};
}

function seedPolicy(overrides: Record<string, string[]> = {}): Record<string, string[]> {
	const policy: Record<string, string[]> = {};
	for (const kind of FLASH_KINDS) policy[kind] = [...FLASH_ORDER];
	policy.review = ["xai/grok-4.6", "sonnet"];
	policy["product-pass"] = ["sonnet"];
	for (const kind of HARD_KINDS) policy[kind] = ["xai/grok-4.6"];
	return { ...policy, ...overrides };
}

function seedRouting(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { pick: "off", slots: 7, claudeMax: 2, hardMax: 2, policy: seedPolicy(), kindRules: {}, ...overrides };
}

/** A section the parse accepts, with no warning. */
function accepted(routing: unknown, file: Record<string, unknown> = baseFile()): PoolRouting {
	const parsed = parsePoolConfig({ ...file, routing });
	assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join("; "));
	assert.equal((parsed as { ok: true; warnings?: string[] }).warnings, undefined, "an accepted section warns about nothing");
	const config = (parsed as { ok: true; config: PoolConfig }).config;
	assert.ok(config.routing, "an accepted section is on the config");
	return config.routing;
}

/** A section the parse refuses: dropped from the config, named in the warnings, and never fatal. */
function dropped(routing: unknown, file: Record<string, unknown> = baseFile()): { config: PoolConfig; warnings: string[] } {
	const parsed = parsePoolConfig({ ...file, routing });
	assert.equal(parsed.ok, true, `a refused routing section must not fail the file: ${parsed.ok ? "" : parsed.errors.join("; ")}`);
	const { config, warnings } = parsed as { ok: true; config: PoolConfig; warnings?: string[] };
	assert.equal(config.routing, undefined, "a refused section is dropped");
	assert.ok(warnings !== undefined && warnings.length > 0, "a refused section is reported");
	for (const warning of warnings) assert.match(warning, /^routing/, `every warning names the section: ${warning}`);
	return { config, warnings };
}

// --- the vocabulary ---------------------------------------------------------------------------

test("the closed kind list is the blueprint's 14 kinds with their class: 7 flash kinds, H1 to H5, and the two exception kinds a Claude lane is allowed for", () => {
	assert.deepEqual([...TASK_KINDS], [
		"ui",
		"copy",
		"test",
		"adapter",
		"config",
		"docs",
		"research-read",
		"retry",
		"unknown-cause-bug",
		"shared-owner",
		"security-data",
		"perf",
		"review",
		"product-pass",
	]);
	for (const kind of FLASH_KINDS) assert.equal(TASK_KIND_CLASS[kind as keyof typeof TASK_KIND_CLASS], "flash", kind);
	for (const [kind, klass] of [["retry", "H1"], ["unknown-cause-bug", "H2"], ["shared-owner", "H3"], ["security-data", "H4"], ["perf", "H5"]] as const) {
		assert.equal(TASK_KIND_CLASS[kind], klass, kind);
	}
	for (const kind of ["review", "product-pass"] as const) assert.equal(TASK_KIND_CLASS[kind], "exception", kind);
});

// --- the shipped file -------------------------------------------------------------------------

test("the shipped file carries the section in force: pick on, 10 slots, the Claude cap 0, the hard cap 2, the policy per kind, and the router's own 1.00 ceiling", () => {
	const loaded = loadPoolConfig(SHIPPED, NOW);
	assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.errors.join("; "));
	const { config, warnings } = loaded as { ok: true; config: PoolConfig; warnings?: string[] };
	assert.equal(warnings, undefined, `the shipped section is valid: ${(warnings ?? []).join("; ")}`);
	const routing = config.routing;
	assert.ok(routing, "the shipped pool has a routing section");
	// VR24-212 (the operator, relayed by Henry, 27 Oct 01:14 EET): auto-placement is on. The pin reads the shipped value
	// through loadPoolConfig above, the one owner of the section, instead of asserting a value the file does not hold.
	assert.equal(routing.pick, "on");
	assert.equal(routing.slots, 10, "VR24-208: up to 10 Pi sessions fill the free slots");
	assert.equal(routing.claudeMax, 0, "VR24-207: no new lane on Claude until Fri 30 Oct 07:00 Sofia (switch board S2 restores 2)");
	assert.equal(routing.hardMax, 2, "VR24-91: at most two hard lanes");
	assert.deepEqual(routing.paused, [], "VR24-209 S3: the operator's Grok pause is lifted, because VR24-207 runs the Fix-gate review on it");
	const flash = ["command-code/deepseek/deepseek-v4.1-flash", "minimax/MiniMax-M3.1-Flash", "zai/glm-5.3-flash"];
	for (const kind of FLASH_KINDS) assert.deepEqual(routing.policy[kind as keyof typeof routing.policy], flash, kind);
	assert.deepEqual(routing.policy.review, ["xai/grok-4.6", "sonnet"], "the Fix gate review runs on a different strong model: Grok first, Sonnet second");
	assert.deepEqual(routing.policy["product-pass"], ["sonnet"], "VR24-5: Sonnet 5.5 is the product model");
	// VR24-208: a hard lane runs on the hard-lane model; the review ref is reserved for the Fix-gate review.
	for (const kind of HARD_KINDS) assert.deepEqual(routing.policy[kind as keyof typeof routing.policy], [flash[0]], kind);
	assert.deepEqual(routing.kindRules, {}, "AR4 fills the path patterns; this lane invents none");
	// AR13 (VR24-204): the router's month is its own bucket at 1.00 USD; the desk's stays 2 (VR24-39).
	assert.deepEqual(config.ceilings, { classifier: { usdPerMonth: 2 }, routing: { usdPerMonth: 1 } });
	// Nothing in the file names a free ref or an opencode/ ref as a policy entry.
	for (const list of Object.values(routing.policy)) {
		for (const ref of list) {
			assert.doesNotMatch(ref, /^opencode\//, `${ref} is never a Pi lane ref`);
			assert.ok(!config.freeRefs.includes(ref), `${ref} is not a free ref (P5-D2)`);
		}
	}
});

test("the shipped routing section changes no other reader: laneDefaults is the same and every harness resolves the model it did before", () => {
	const loaded = loadPoolConfig(SHIPPED, NOW);
	assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.errors.join("; "));
	const { config } = loaded as { ok: true; config: PoolConfig };
	assert.deepEqual(config.laneDefaults, {
		pi: {
			candidates: ["command-code/deepseek/deepseek-v4.1-flash", "minimax/MiniMax-M3.1-Flash", "zai/glm-5.3-flash"],
			fallbackRole: "worker",
			// VR24-208: the hard-lane model leads; xai/grok-4.6 stays second, the only place the pool routes the
			// ref reserved for the Fix-gate review, so a review lane launched with --model is still admitted.
			hard: ["command-code/deepseek/deepseek-v4.1-flash", "xai/grok-4.6"],
		},
		opencode: ["minimax/MiniMax-M3.1-Flash"],
		claude: "sonnet",
	});
	assert.equal(resolveLaneModel(config, { harness: "pi", now: NOW }).model, "command-code/deepseek/deepseek-v4.1-flash");
	assert.equal(resolveLaneModel(config, { harness: "opencode", now: NOW }).model, "minimax/MiniMax-M3.1-Flash");
	assert.equal(resolveLaneModel(config, { harness: "claude", now: NOW }).model, "sonnet");
});

// --- what the section refuses -----------------------------------------------------------------

test("the section is refused for every rule the blueprint names, each time dropped with a warning that names the rule", () => {
	for (const [name, section, expected] of [
		["a ref in no chain and no lane default", seedRouting({ policy: seedPolicy({ ui: ["nowhere/at-all"] }) }), /ui: "nowhere\/at-all" is not in the pool/],
		["an entry that is not a ref", seedRouting({ policy: seedPolicy({ copy: ["deepseek-flash"] }) }), /copy: "deepseek-flash" is not a provider\/model ref/],
		["an opencode ref in a Pi list", seedRouting({ policy: seedPolicy({ test: ["opencode/glm-5.3-flash-free"] }) }), /test: "opencode\/glm-5.3-flash-free" is an OpenCode ref/],
		["a Claude ref on a flash kind", seedRouting({ policy: seedPolicy({ docs: ["sonnet"] }) }), /docs: the Claude ref "sonnet" is allowed only for review and product-pass/],
		["a Claude ref on a hard kind", seedRouting({ policy: seedPolicy({ perf: ["sonnet"] }) }), /perf: the Claude ref "sonnet" is allowed only for review and product-pass/],
		["a flash ref on a hard kind", seedRouting({ policy: seedPolicy({ retry: ["cc/ds-flash"] }) }), /retry: "cc\/ds-flash" is not one of laneDefaults\.pi\.hard/],
		["a repeated ref", seedRouting({ policy: seedPolicy({ adapter: ["cc/ds-flash", "cc/ds-flash"] }) }), /adapter repeats "cc\/ds-flash"/],
		["a kind with no list", seedRouting({ policy: seedPolicy({ config: [] }) }), /config must be a non-empty list/],
		["a kind the vocabulary does not have", seedRouting({ policy: seedPolicy({ frontend: ["cc/ds-flash"] }) }), /frontend.*is not a task kind/],
		["a missing kind", (() => {
			const policy = seedPolicy();
			delete policy.docs;
			return seedRouting({ policy });
		})(), /docs must be a non-empty list/],
		["a pick outside off, shadow and on", seedRouting({ pick: "auto" }), /pick must be one of off, shadow, on/],
		["no pick at all", (() => {
			const section = seedRouting();
			delete section.pick;
			return section;
		})(), /pick must be one of off, shadow, on/],
		["a fractional Claude cap", seedRouting({ claudeMax: 1.5 }), /claudeMax must be a whole number of zero or more/],
		["a negative hard cap", seedRouting({ hardMax: -2 }), /hardMax must be a whole number of zero or more/],
		["no slots", seedRouting({ slots: 0 }), /slots must be a whole number of one or more/],
		["an unknown key", seedRouting({ removedKey: true }), /unknown key "removedKey"/],
		["not an object", 7, /must be an object/],
		["a paused ref outside the pool", seedRouting({ paused: ["nowhere/at-all"] }), /paused: "nowhere\/at-all" is not in the pool/],
		["a kindRules kind the vocabulary does not have", seedRouting({ kindRules: { pi: { frontend: ["src/ui/**"] } } }), /kindRules\.pi names "frontend", which is not a task kind/],
		["a kindRules kind with no pattern", seedRouting({ kindRules: { pi: { ui: [] } } }), /kindRules\.pi\.ui must be a non-empty list of path patterns/],
		["a kindRules pattern that is not a string", seedRouting({ kindRules: { pi: { ui: [3] } } }), /kindRules\.pi\.ui: 3 is not a path pattern/],
		["an empty kindRules project", seedRouting({ kindRules: { " ": { ui: ["src/ui/**"] } } }), /kindRules names an empty project/],
	] as const) {
		const { warnings } = dropped(section);
		assert.match(warnings.join("\n"), expected, name);
	}
});

test("a free ref is never placed by the table, even when the pool legitimately carries it (P5-D2)", () => {
	const file = baseFile({ freeRefs: ["free/model:free"], roles: { worker: [...FLASH_ORDER, "free/model:free"], classifier: ["jev/classifier"] } });
	const { warnings } = dropped(seedRouting({ policy: seedPolicy({ "research-read": ["free/model:free"] }) }), file);
	assert.match(warnings.join("\n"), /research-read: "free\/model:free" is a free ref/);
	// The same file without the free ref in the policy is accepted, so the refusal is about the entry.
	accepted(seedRouting(), file);
});

test("a hard kind needs laneDefaults.pi.hard: a flash ref, or a ref that only the hard tier used to carry, drops the section and leaves the file loadable", () => {
	// xai/grok-4.6 is still routed by a chain, so only the hard-kind rule can refuse it.
	const chained = baseFile({
		laneDefaults: { pi: { candidates: [...FLASH_ORDER], fallbackRole: "worker" }, opencode: ["mm/flash"], claude: "sonnet" },
		roles: { worker: [...FLASH_ORDER, "xai/grok-4.6"], classifier: ["jev/classifier"] },
	});
	const tierless = dropped(seedRouting(), chained);
	assert.match(tierless.warnings.join("\n"), /retry: "xai\/grok-4.6" is not one of laneDefaults\.pi\.hard/);
	assert.equal(resolveLaneModel(tierless.config, { harness: "pi", now: NOW }).model, "cc/ds-flash", "the Pi default still resolves");
	// With the hard tier gone from the defaults and from every chain, the ref is not in the pool at all, and the file still loads.
	const noHardTier = baseFile({ laneDefaults: { pi: { candidates: [...FLASH_ORDER], fallbackRole: "worker" }, opencode: ["mm/flash"], claude: "sonnet" } });
	const gone = dropped(seedRouting(), noHardTier);
	assert.match(gone.warnings.join("\n"), /is not in the pool/);
	assert.equal(resolveLaneModel(gone.config, { harness: "pi", now: NOW }).model, "cc/ds-flash");
});

// --- the section is dropped, nothing else moves ------------------------------------------------

test("a refused section leaves laneDefaults and every other reader exactly as they were without it", () => {
	const without = parsePoolConfig(baseFile()) as { ok: true; config: PoolConfig };
	assert.equal(without.ok, true);
	assert.equal(without.config.routing, undefined, "a file without the section has no routing");
	assert.equal((without as { warnings?: string[] }).warnings, undefined);
	const { config } = dropped(seedRouting({ policy: seedPolicy({ ui: ["nowhere/at-all"] }) }));
	assert.deepEqual(config.laneDefaults, without.config.laneDefaults);
	assert.deepEqual(config.roles, without.config.roles);
	assert.deepEqual(config.freeRefs, without.config.freeRefs);
	assert.deepEqual(config.ceilings, without.config.ceilings);
	assert.deepEqual(config.quotaShapes, without.config.quotaShapes);
	for (const harness of ["pi", "opencode", "claude"] as const) {
		assert.deepEqual(resolveLaneModel(config, { harness, now: NOW }), resolveLaneModel(without.config, { harness, now: NOW }), harness);
	}
});

test("one broken section never hides a real error elsewhere: the same parse still names the other section", () => {
	const parsed = parsePoolConfig(baseFile({ routing: seedRouting({ pick: "auto" }), providerWalls: { "cc": { until: "soon" } } }));
	assert.equal(parsed.ok, false, "a bad providerWalls still fails the file");
	assert.match((parsed as { errors: string[] }).errors.join("\n"), /providerWalls/);
});

test("the shipped pool carries no lane pause, and the ref a pause would name is still pooled through laneDefaults.pi.hard", () => {
	const loaded = loadPoolConfig(SHIPPED, NOW);
	assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.errors.join("; "));
	const { config, warnings } = loaded as { ok: true; config: PoolConfig; warnings?: string[] };
	assert.equal(warnings, undefined, `the pause list is valid: ${(warnings ?? []).join("; ")}`);
	assert.deepEqual(config.routing?.paused, [], "VR24-209 S3: the Grok pause is lifted, because VR24-207 runs the Fix-gate review on it");
	assert.ok(config.laneDefaults?.pi.hard?.includes("xai/grok-4.6"), "the ref reserved for the Fix-gate review is still the hard tier's second entry, so the pool routes it (VR24-207)");
	// A pause is for lanes only: it is not a wall, so no reader of the walls is paused by it.
	assert.equal(config.providerWalls["xai"], undefined, "the pause is not a providerWalls wall (VR24-113): a wall has a clock and covers delegates, review and memory too");
	assert.equal(resolveLaneModel(config, { harness: "pi", now: NOW }).model, "command-code/deepseek/deepseek-v4.1-flash", "a paused ref changes no launch today: nothing reads the table until AR6");
});

test("paused is a list of pool refs the parse checks: a ref outside the pool is refused, and the list may be empty", () => {
	assert.deepEqual(accepted(seedRouting({ paused: ["xai/grok-4.6"] })).paused, ["xai/grok-4.6"]);
	assert.deepEqual(accepted(seedRouting()).paused, []);
});

test("the seed section parses with kindRules filled for a project (AR4's data) and refuses nothing about it", () => {
	const routing = accepted(seedRouting({ kindRules: { "pi-agent": { docs: ["docs/**/*.md"], ui: ["extensions/**/*.tsx"] } } }));
	assert.deepEqual(routing.kindRules, { "pi-agent": { docs: ["docs/**/*.md"], ui: ["extensions/**/*.tsx"] } } as PoolRouting["kindRules"]);
});

// --- the file's other writer ------------------------------------------------------------------

test("muster pool admit keeps the routing section it did not touch", () => {
	const raw = JSON.parse(readFileSync(SHIPPED, "utf8")) as Record<string, unknown>;
	const admission = withAdmittedFreeRef(raw, "opencode/glm-5.3-flash-free");
	assert.equal(admission.ok, true, admission.ok ? "" : admission.reason);
	const written = (admission as { ok: true; file: Record<string, unknown> }).file;
	assert.deepEqual(written.routing, raw.routing, "the admission copies the routing section untouched");
	const reparsed = parsePoolConfig(written);
	assert.equal(reparsed.ok, true, reparsed.ok ? "" : reparsed.errors.join("; "));
	assert.deepEqual((reparsed as { ok: true; config: PoolConfig }).config.routing, (parsePoolConfig(raw) as { ok: true; config: PoolConfig }).config.routing);
});

// --- the whole path ---------------------------------------------------------------------------

test("a lane launch still resolves the shipped file through the helper the launcher calls, and the Claude alias still resolves to itself", () => {
	const dir = mkdtempSync(join(tmpdir(), "routing-policy-launch-"));
	const env = {
		...process.env,
		PI_PROVIDER_POOL_PATH: SHIPPED,
		PI_PROVIDER_WALLS_PATH: join(dir, "provider-walls.json"),
		PI_ROUTING_DECISIONS_PATH: join(dir, "routing", "decisions.jsonl"),
		PI_USAGE_SNAPSHOT_PATH: join(dir, "usage", "snapshot.json"),
	};
	const run = (harness: string) => JSON.parse(execFileSync("node", [CLI, "--harness", harness, "--json"], { encoding: "utf8", env })) as { model: string; source: string };
	const pi = run("pi");
	assert.equal(pi.model, "command-code/deepseek/deepseek-v4.1-flash");
	assert.equal(pi.source, "default");
	assert.equal(run("claude").model, "sonnet");
	// The helper recorded the decision it always records: the routing section changed no launch.
	const decisions = readFileSync(join(dir, "routing", "decisions.jsonl"), "utf8").trim().split("\n");
	assert.equal(decisions.length, 2, "one decision line per launch");
	assert.equal((JSON.parse(decisions[0]!) as { chosen: string }).chosen, "command-code/deepseek/deepseek-v4.1-flash");
});
