import "./muster-test-isolation.ts";
/**
 * The provider health probe (brief `providerhealth-0935`).
 *
 * One cheap test call per provider the pool routes, classified from the pool's own wall vocabulary, and
 * Henry told once per newly seen wall, at most once an hour while it persists, and once when it clears.
 *
 * Every test runs against an OS temp state directory and an injected clock; the request port is a fixture,
 * so no test here makes a request or reads a key. The classes are the ones the brief names: healthy, a
 * rejected or expired credential, an inactive subscription, a usage limit, and an unclassified error.
 *
 * Authored here; executed through `./test.sh muster/tests/muster-provider-health.test.ts`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	PROVIDER_HEALTH_FILE,
	REPEAT_WALL_MS,
	classifyProviderAnswer,
	providerAlertKey,
	providerHealthPass,
	providerTargets,
	readProviderHealthMemory,
	writeProviderHealthMemory,
	type ProviderAnswer,
	type ProviderHealthPorts,
	type ProviderTarget,
} from "../health/provider-health.ts";
import type { QuotaShape } from "../../routing/quota-classifier.ts";
import type { PoolConfig, Wall } from "../../routing/provider-pool.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A fixed moment, so every assertion about "first seen" and "an hour later" is arithmetic, not the wall clock. */
const T0 = Date.parse("2026-10-29T09:00:00.000Z");

/**
 * The shipped shapes this test relies on, copied as fixtures: the pool file is the wording's owner and may
 * be edited any day, so the test pins the vocabulary it asserts instead of reading the live file.
 */
const SHAPES: QuotaShape[] = [
	{ id: "go-usage-limit", match: "GoUsageLimitError", reset: { kind: "relative", pattern: "Resets in (\\d+)\\s*(min|h|hour|d|day)" } },
	{ id: "credential-rejected", match: "Invalid credential" },
	{ id: "claude-subscription-disabled", match: "subscription access" },
	{ id: "chat-usage-limit", match: "usage limit \\(", reset: { kind: "relative", pattern: "Try again in ~(\\d+) (min|h|hour|d|day)" } },
	{ id: "free-tier-limit", match: "Free usage exceeded" },
	{ id: "endpoint-unavailable-429", match: "429.*Endpoint is unavailable" },
];

/** A pool config as the file writes it, reduced to the fields the sweep reads. */
function poolConfig(roles: Record<string, string[]>, laneDefaults?: unknown, nonChatRoles: string[] = []): PoolConfig {
	return { version: 1, virtualProvider: "pool", roles, nonChatRoles, ...(laneDefaults === undefined ? {} : { laneDefaults }) } as unknown as PoolConfig;
}

type Telling = { text: string; key: string };
type LearnedWall = { ref: string; shapeId: string; resetAt?: number };

/** One pass's world: a fixed clock, one answer per ref, the walls in force, and the messages and walls that went out. */
function harness(options: {
	at: number;
	stateDir: string;
	answers: Record<string, ProviderAnswer>;
	targets: ProviderTarget[];
	told?: Telling[];
	failSend?: boolean;
	walls?: Record<string, Wall>;
	learned?: LearnedWall[];
	probes?: string[];
}) {
	const told = options.told ?? [];
	const learned = options.learned ?? [];
	const probes = options.probes ?? [];
	const ports: ProviderHealthPorts = {
		now: () => options.at,
		stateDir: () => options.stateDir,
		targets: () => options.targets,
		shapes: () => SHAPES,
		walls: () => options.walls ?? {},
		learnWall: (ref, shapeId, resetAt) => {
			learned.push({ ref, shapeId, ...(resetAt === undefined ? {} : { resetAt }) });
		},
		probe: async (ref) => {
			probes.push(ref);
			const answer = options.answers[ref];
			if (answer === undefined) throw new Error(`no fixture answer for ${ref}`);
			return answer;
		},
		tellHenry: (text, key) => {
			if (options.failSend === true) throw new Error("the bus refused the message");
			told.push({ text, key });
		},
	};
	return { ports, told, learned, probes };
}

function withStateDir(body: (stateDir: string) => void | Promise<void>): () => Promise<void> {
	return async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "muster-provider-health-"));
		try {
			await body(stateDir);
		} finally {
			rmSync(stateDir, { recursive: true, force: true });
		}
	};
}

const COMMAND_CODE: ProviderTarget = { provider: "command-code", ref: "command-code/deepseek/deepseek-v4.1-flash" };

const HEALTHY: ProviderAnswer = { outcome: "answer", latencyMs: 120 };
/** Tonight's wall, word for word: the key was expired and the answer said so. */
const EXPIRED_KEY: ProviderAnswer = { outcome: "error", errorMessage: "401 Unauthorized: Your API key has expired", latencyMs: 90 };

test("every provider the pool routes is swept once, with the first ref the chains name", () => {
	const config = poolConfig({
		session: ["command-code/model-a", "minimax/model-b"],
		worker: ["command-code/model-c", "openrouter/model-d"],
		classifier: ["openrouter/model-e"],
	});
	assert.deepEqual(providerTargets(config), [
		{ provider: "command-code", ref: "command-code/model-a" },
		{ provider: "minimax", ref: "minimax/model-b" },
		{ provider: "openrouter", ref: "openrouter/model-d" },
	]);
	// The sweep follows the file: a fourth provider needs no change here.
	const fourth = providerTargets(poolConfig({ session: ["command-code/a", "xai/grok-4.6"] }));
	assert.deepEqual(fourth.map((target) => target.provider), ["command-code", "xai"]);
});

test("the refs a lane can start on are swept too, so a free ref that lives only in laneDefaults is covered", () => {
	// A free Zen ref is a lane default, never a chain entry: a sweep that walked the chains alone would never call it.
	const config = poolConfig({ session: ["opencode-go/model-a"] }, {
		pi: { candidates: ["opencode-go/model-a"], hard: ["minimax/model-b"] },
		opencode: ["opencode/deepseek-v4.1-flash-free", "opencode-go/model-a"],
		claude: "sonnet",
	});
	assert.deepEqual(providerTargets(config), [
		{ provider: "opencode-go", ref: "opencode-go/model-a" },
		{ provider: "minimax", ref: "minimax/model-b" },
		{ provider: "opencode", ref: "opencode/deepseek-v4.1-flash-free" },
	]);
});

test("an answer is healthy, a rejected or expired credential, an inactive subscription, a usage limit, or other", () => {
	const cases: Array<{ name: string; answer: ProviderAnswer; klass: string; shapeId?: string; marker?: string; resetAt?: number }> = [
		{ name: "healthy", answer: HEALTHY, klass: "healthy" },
		{ name: "tonight's expired key, status and all", answer: EXPIRED_KEY, klass: "credential", marker: "expired-credential" },
		{
			name: "the vendor's other 401 body, which no shape words",
			answer: { outcome: "error", errorMessage: '401: {"message":"Invalid Authorization header","type":"authentication_error","code":"UNAUTHORIZED"}', latencyMs: 20 },
			klass: "credential",
			marker: "auth-code",
		},
		{
			name: "endpoint down, worded by the pool's own shape: a wall, not a capacity reading (F20)",
			answer: { outcome: "error", errorMessage: '429: {"message":"Upstream request failed: Endpoint is unavailable."}', latencyMs: 20 },
			klass: "usage-limit",
			shapeId: "endpoint-unavailable-429",
		},
		{
			name: "endpoint down, as the host really answered it (529, no shape matches): still a wall",
			answer: { outcome: "error", errorMessage: '529: {"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}', latencyMs: 20 },
			klass: "usage-limit",
			marker: "endpoint-unavailable",
		},
		{
			name: "bare capacity: a failover signal, not a wall",
			answer: { outcome: "error", errorMessage: '429: {"message":"Upstream model provider is temporarily unavailable. Please try again in a moment.","type":"rate_limit_error"}', latencyMs: 20 },
			klass: "other",
			marker: "capacity-429",
		},
		{
			name: "an expired key with no status in the text",
			answer: { outcome: "error", errorMessage: "Your API key has expired", latencyMs: 40 },
			klass: "credential",
			marker: "expired-credential",
		},
		{
			name: "the pool's own credential shape",
			answer: { outcome: "error", errorMessage: "Invalid credential for this account", latencyMs: 40 },
			klass: "credential",
			shapeId: "credential-rejected",
		},
		{
			name: "an inactive subscription",
			answer: { outcome: "error", errorMessage: "Your subscription is inactive", latencyMs: 40 },
			klass: "entitlement",
			marker: "inactive-subscription",
		},
		{
			name: "the pool's own entitlement shape",
			answer: { outcome: "error", errorMessage: "no subscription access on this account", latencyMs: 40 },
			klass: "entitlement",
			shapeId: "claude-subscription-disabled",
		},
		{
			name: "a usage limit, named by the pool and resetting from its own rule",
			answer: { outcome: "error", errorMessage: "GoUsageLimitError: Resets in 30 min", latencyMs: 40 },
			klass: "usage-limit",
			shapeId: "go-usage-limit",
			resetAt: T0 + 30 * MINUTE,
		},
		{
			name: "another usage limit shape",
			answer: { outcome: "error", errorMessage: "chat usage limit (2056) reached. Try again in ~2 h", latencyMs: 40 },
			klass: "usage-limit",
			shapeId: "chat-usage-limit",
			resetAt: T0 + 2 * HOUR,
		},
		{ name: "other", answer: { outcome: "error", errorMessage: "ECONNREFUSED 127.0.0.1:443", latencyMs: 40 }, klass: "other" },
	];
	for (const entry of cases) {
		const health = classifyProviderAnswer(COMMAND_CODE.ref, entry.answer, SHAPES, T0);
		assert.equal(health.class, entry.klass, entry.name);
		assert.equal(health.provider, "command-code", entry.name);
		assert.equal(health.shapeId, entry.shapeId, entry.name);
		assert.equal(health.marker, entry.marker, entry.name);
		assert.equal(health.resetAt, entry.resetAt, entry.name);
	}
});

test("a wall is told once, and the same failure again does not tell Henry twice", withStateDir(async (stateDir) => {
	const told: Telling[] = [];
	const answers = { [COMMAND_CODE.ref]: EXPIRED_KEY };
	const first = await providerHealthPass(harness({ at: T0, stateDir, answers, targets: [COMMAND_CODE], told }).ports);
	assert.equal(first[0]?.action, "alert");
	assert.equal(told.length, 1);
	assert.match(told[0]!.text, /Provider command-code answers a test call/);
	assert.match(told[0]!.text, /rejected credential \(marker "expired-credential"\)/, "the more precise reading: an expired key, not just a 401");
	assert.match(told[0]!.text, /provider's own words:/);
	assert.match(told[0]!.text, new RegExp(`First seen ${new Date(T0).toISOString()}`));
	assert.equal(told[0]!.key, providerAlertKey("command-code", "credential:expired-credential", T0));

	const second = await providerHealthPass(harness({ at: T0 + MINUTE, stateDir, answers, targets: [COMMAND_CODE], told }).ports);
	assert.equal(second[0]?.action, "none");
	assert.equal(told.length, 1, "a second identical failure is not a second message");
}));

test("a wall that persists is repeated once an hour and no sooner", withStateDir(async (stateDir) => {
	const told: Telling[] = [];
	const answers = { [COMMAND_CODE.ref]: EXPIRED_KEY };
	await providerHealthPass(harness({ at: T0, stateDir, answers, targets: [COMMAND_CODE], told }).ports);
	const early = await providerHealthPass(harness({ at: T0 + REPEAT_WALL_MS - MINUTE, stateDir, answers, targets: [COMMAND_CODE], told }).ports);
	assert.equal(early[0]?.action, "none");
	assert.equal(told.length, 1);
	const repeated = await providerHealthPass(harness({ at: T0 + REPEAT_WALL_MS, stateDir, answers, targets: [COMMAND_CODE], told }).ports);
	assert.equal(repeated[0]?.action, "repeat");
	assert.equal(told.length, 2);
	assert.match(told[1]!.text, /still answers a test call/);
	assert.match(told[1]!.text, new RegExp(`First seen ${new Date(T0).toISOString()};`));
	assert.equal(told[1]!.key, told[0]!.key, "one wall, one key: the repeat is the same wall, not a new one");
}));

test("a wall that clears is told once, and the same wall again is a new wall", withStateDir(async (stateDir) => {
	const told: Telling[] = [];
	await providerHealthPass(harness({ at: T0, stateDir, answers: { [COMMAND_CODE.ref]: EXPIRED_KEY }, targets: [COMMAND_CODE], told }).ports);
	const cleared = await providerHealthPass(harness({ at: T0 + 10 * MINUTE, stateDir, answers: { [COMMAND_CODE.ref]: HEALTHY }, targets: [COMMAND_CODE], told }).ports);
	assert.equal(cleared[0]?.action, "cleared");
	assert.equal(told.length, 2);
	assert.match(told[1]!.text, /answers a test call .* again\. The credential wall first seen /);
	assert.deepEqual(readProviderHealthMemory(stateDir)["command-code"], { class: "healthy", wallKey: "", firstSeenAt: 0, lastAlertAt: 0 });
	const again = await providerHealthPass(harness({ at: T0 + 20 * MINUTE, stateDir, answers: { [COMMAND_CODE.ref]: EXPIRED_KEY }, targets: [COMMAND_CODE], told }).ports);
	assert.equal(again[0]?.action, "alert", "a wall after a clear is newly seen, not a silent repeat");
	assert.equal(told.length, 3);
	// That second wall clears too, and the clear is told once; healthy to healthy after it says nothing.
	const clearedAgain = await providerHealthPass(harness({ at: T0 + 30 * MINUTE, stateDir, answers: { [COMMAND_CODE.ref]: HEALTHY }, targets: [COMMAND_CODE], told }).ports);
	assert.equal(clearedAgain[0]?.action, "cleared");
	assert.equal(told.length, 4);
	const quiet = await providerHealthPass(harness({ at: T0 + 40 * MINUTE, stateDir, answers: { [COMMAND_CODE.ref]: HEALTHY }, targets: [COMMAND_CODE], told }).ports);
	assert.equal(quiet[0]?.action, "none");
	assert.equal(told.length, 4);
}));

test("an unclassified error is recorded and printed, never alerted", withStateDir(async (stateDir) => {
	const told: Telling[] = [];
	const answers = { [COMMAND_CODE.ref]: { outcome: "error", errorMessage: "socket hang up", latencyMs: 5 } };
	const results = await providerHealthPass(harness({ at: T0, stateDir, answers, targets: [COMMAND_CODE], told }).ports);
	assert.equal(results[0]?.class, "other");
	assert.equal(results[0]?.action, "none");
	assert.equal(told.length, 0);
	assert.equal(readProviderHealthMemory(stateDir)["command-code"]?.class, "other");
}));

test("a send that fails is retried on the next run instead of being called told", withStateDir(async (stateDir) => {
	const answers = { [COMMAND_CODE.ref]: EXPIRED_KEY };
	const failed = await providerHealthPass(harness({ at: T0, stateDir, answers, targets: [COMMAND_CODE], failSend: true }).ports);
	assert.equal(failed[0]?.action, "alert-failed");
	assert.match(failed[0]!.failure ?? "", /the bus refused the message/);
	assert.deepEqual(readProviderHealthMemory(stateDir), {}, "a wall nobody was told about is not remembered as told");
	const told: Telling[] = [];
	const retried = await providerHealthPass(harness({ at: T0 + MINUTE, stateDir, answers, targets: [COMMAND_CODE], told }).ports);
	assert.equal(retried[0]?.action, "alert");
	assert.equal(told.length, 1);
}));

test("a dry run tells nobody and writes no memory", withStateDir(async (stateDir) => {
	const told: Telling[] = [];
	const results = await providerHealthPass(
		harness({ at: T0, stateDir, answers: { [COMMAND_CODE.ref]: EXPIRED_KEY }, targets: [COMMAND_CODE], told }).ports,
		{ dryRun: true },
	);
	assert.equal(results[0]?.action, "alert");
	assert.equal(told.length, 0);
	assert.deepEqual(readProviderHealthMemory(stateDir), {});
}));

test("no secret value reaches a result or a message", withStateDir(async (stateDir) => {
	const told: Telling[] = [];
	const answer: ProviderAnswer = {
		outcome: "error",
		errorMessage: "401 Unauthorized: key Bearer sk-live-abcdefghijklmnopqrstuvwxyz012345 is expired (abcdef0123456789abcdef0123456789)",
		latencyMs: 12,
	};
	const results = await providerHealthPass(harness({ at: T0, stateDir, answers: { [COMMAND_CODE.ref]: answer }, targets: [COMMAND_CODE], told }).ports);
	const text = results[0]?.text ?? "";
	for (const secret of ["sk-live-abcdefghijklmnopqrstuvwxyz012345", "abcdef0123456789abcdef0123456789", "Bearer sk-"]) {
		assert.equal(text.includes(secret), false, `the result kept ${secret}`);
		assert.equal(told[0]!.text.includes(secret), false, `the message kept ${secret}`);
	}
	assert.match(told[0]!.text, /401 Unauthorized/, "the provider's own words still name the wall");
}));

test("the memory file survives a torn write by reading as no memory", withStateDir(async (stateDir) => {
	writeFileSync(join(stateDir, PROVIDER_HEALTH_FILE), "{ not json");
	assert.deepEqual(readProviderHealthMemory(stateDir), {});
	writeProviderHealthMemory(stateDir, { "command-code": { class: "credential", wallKey: "credential:http-401", firstSeenAt: T0, lastAlertAt: T0 } });
	const read = JSON.parse(readFileSync(join(stateDir, PROVIDER_HEALTH_FILE), "utf8")) as Record<string, unknown>;
	assert.deepEqual(read, { "command-code": { class: "credential", wallKey: "credential:http-401", firstSeenAt: T0, lastAlertAt: T0 } });
}));

test("a spent free ref is recorded under the pool's own shape, told once, and then not called again", withStateDir(async (stateDir) => {
	// The wall Henry approved the fallback for: a free Zen tier whose quota is spent. The shape is the pool's own
	// `free-tier-limit`; the wall is written through the pool's owner, so a launch's ranking skips this ref and the
	// pool's own `laneDefaults` order falls to opencode-go.
	const FREE: ProviderTarget = { provider: "opencode", ref: "opencode/deepseek-v4.1-flash-free" };
	const spent: ProviderAnswer = { outcome: "error", errorMessage: "Free usage exceeded", latencyMs: 30 };
	const told: Telling[] = [];
	const learned: LearnedWall[] = [];
	const probes: string[] = [];

	const first = await providerHealthPass(harness({ at: T0, stateDir, answers: { [FREE.ref]: spent }, targets: [FREE], told, learned, probes }).ports);
	assert.equal(first[0]?.class, "usage-limit");
	assert.equal(first[0]?.shapeId, "free-tier-limit");
	assert.equal(first[0]?.action, "alert");
	assert.deepEqual(learned, [{ ref: FREE.ref, shapeId: "free-tier-limit" }], "the wall carries the pool's shape id and no reset the shape does not have");
	assert.equal(told.length, 1);

	const wallUntil = T0 + HOUR;
	const second = await providerHealthPass(
		harness({ at: T0 + 10 * MINUTE, stateDir, answers: { [FREE.ref]: spent }, targets: [FREE], told, learned, probes, walls: { opencode: { until: wallUntil, reason: "free-tier-limit", source: "error" } } }).ports,
	);
	assert.equal(second[0]?.class, "walled");
	assert.equal(second[0]?.action, "none");
	assert.equal(probes.length, 1, "a ref with a wall in force is not called: the wall is the answer");
	assert.equal(told.length, 1, "a wall another owner recorded is reported, not re-told");
	assert.match(second[0]?.note ?? "", /not called/);

	const cleared = await providerHealthPass(harness({ at: wallUntil + MINUTE, stateDir, answers: { [FREE.ref]: HEALTHY }, targets: [FREE], told, learned, probes }).ports);
	assert.equal(cleared[0]?.class, "healthy");
	assert.equal(cleared[0]?.action, "cleared");
	assert.equal(told.length, 2);
	assert.match(told[1]!.text, /The recorded wall first seen /);
	assert.equal(probes.length, 2, "the ref is called again once its wall has lifted");
}));

test("a provider the pool records a wall for and no chain routes is reported, never called", withStateDir(async (stateDir) => {
	// Command Code was disabled by the vendor and removed from every chain: gone from the chains, it must not vanish
	// from the report, and it must never be test-called again.
	const TARGET: ProviderTarget = { provider: "opencode-go", ref: "opencode-go/model-a" };
	const told: Telling[] = [];
	const probes: string[] = [];
	const results = await providerHealthPass(
		harness({
			at: T0,
			stateDir,
			answers: { [TARGET.ref]: HEALTHY },
			targets: [TARGET],
			told,
			probes,
			walls: {
				"command-code": { until: T0 + HOUR, reason: "credential-rejected", source: "config" },
				"command-code (first account)": { until: T0 + HOUR, reason: "an account key, not a provider", source: "config" },
			},
		}).ports,
	);
	assert.deepEqual(results.map((result) => result.provider), ["opencode-go", "command-code"]);
	const removed = results[1]!;
	assert.equal(removed.class, "walled");
	assert.equal(removed.ref, "");
	assert.equal(removed.action, "none");
	assert.match(removed.note ?? "", /no chain routes it, so it was not called/);
	assert.deepEqual(probes, [TARGET.ref], "only the routed ref is called");
	assert.equal(told.length, 0, "a wall another owner recorded is not re-told");
}));

test("an endpoint-down answer reaches Henry once per episode and is heard cleared (F20)", withStateDir(async (stateDir) => {
	// The wall nobody heard about: an endpoint that says it is down. It is a wall in the pool's own vocabulary, so it
	// is recorded and told exactly like a usage limit, and the clear is told too.
	const ENDPOINT: ProviderTarget = { provider: "opencode-go", ref: "opencode-go/deepseek-v4.1-flash" };
	const down: ProviderAnswer = { outcome: "error", errorMessage: '529: {"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}', latencyMs: 20 };
	const told: Telling[] = [];
	const learned: LearnedWall[] = [];
	const probes: string[] = [];

	const first = await providerHealthPass(harness({ at: T0, stateDir, answers: { [ENDPOINT.ref]: down }, targets: [ENDPOINT], told, learned, probes }).ports);
	assert.equal(first[0]?.class, "usage-limit");
	assert.equal(first[0]?.marker, "endpoint-unavailable");
	assert.equal(first[0]?.action, "alert");
	assert.equal(told.length, 1);
	assert.match(told[0]!.text, /a usage limit \(marker "endpoint-unavailable"\)/);
	assert.deepEqual(learned, [{ ref: ENDPOINT.ref, shapeId: "endpoint-unavailable" }], "the wall is recorded, not only read");

	const second = await providerHealthPass(harness({ at: T0 + MINUTE, stateDir, answers: { [ENDPOINT.ref]: down }, targets: [ENDPOINT], told, learned, probes }).ports);
	assert.equal(second[0]?.action, "none", "one alert per provider per episode");
	assert.equal(told.length, 1);

	const cleared = await providerHealthPass(harness({ at: T0 + 5 * MINUTE, stateDir, answers: { [ENDPOINT.ref]: HEALTHY }, targets: [ENDPOINT], told, learned, probes }).ports);
	assert.equal(cleared[0]?.action, "cleared");
	assert.equal(told.length, 2);
	assert.match(told[1]!.text, /The usage-limit wall first seen /);
}));
