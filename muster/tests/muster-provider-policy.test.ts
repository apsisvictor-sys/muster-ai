import "./muster-test-isolation.ts";
/**
 * Model-free regressions for the P4.1 provider-aware operation policy
 * (plan §7 P4.1, §6 D4; decision A8).
 *
 * Pure policy tests: synthetic statuses, codes, provider error strings and
 * timestamps only. No provider call, no credential, no delegate import and no
 * real quota endpoint. Cooldown/observation state is process-local in-memory
 * state, reset by `resetProviderPolicyState()` between cases.
 *
 * Authored here; executed by the parent through the guarded runner.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	APPROVED_CHEAP_WORKER_ROUTES,
	APPROVED_MASTER_ROUTES,
	D4_RESERVE_PROFILE,
	DEFAULT_COOLDOWN_MS,
	FRONTIER_WORKER_EXCLUDED_ROUTES,
	LUNA_EQUIVALENT_ROUTES,
	LunaMasterPolicy,
	ProviderPolicyError,
	classifyProviderOutcome,
	cooldownUntil,
	isPoolCoolingDown,
	poolCooldown,
	poolKeyFor,
	poolWorkerRole,
	providerAdmissionKey,
	providerPolicyStatusSummary,
	providerRequestAdmission,
	reserveThresholdFor,
	resetProviderPolicyState,
	resolveMasterRoute,
	resolveWorkerFallback,
	routeExclusionFor,
	type ProviderOutcomeInput,
} from "../../routing/provider-policy.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const BASE_TIME = Date.parse("2026-09-23T12:00:00.000Z");

// Policy pool reads are lazy (each caller reads the list per call), so a plain env bind
// after the imports covers them all: this suite sees the repo's shipped list, not the live tree.
process.env.PI_PROVIDER_POOL_PATH = fileURLToPath(new URL("../../../provider-pool.json", import.meta.url));
process.env.PI_PROVIDER_WALLS_PATH = join(mkdtempSync(join(tmpdir(), "muster-policy-walls-")), "provider-walls.json");
writeFileSync(process.env.PI_PROVIDER_WALLS_PATH, "{}\n");

// ─── Classification ──────────────────────────────────────────────────────────

test("classifyProviderOutcome: transient throttle from status, code and retry-after", () => {
	const fromStatus = classifyProviderOutcome({
		provider: "openai-codex",
		model: "gpt-6-luna",
		httpStatus: 429,
		errorMessage: "Too many requests; retry after 30 s",
	});
	assert.equal(fromStatus.kind, "transient-throttle");
	if (fromStatus.kind !== "transient-throttle") return;
	assert.equal(fromStatus.retryable, true);
	assert.equal(fromStatus.backoffHintMs, 30_000);
	assert.equal(fromStatus.provider, "openai-codex");
	assert.equal(fromStatus.model, "gpt-6-luna");
	assert.equal(fromStatus.httpStatus, 429);

	const fromCode = classifyProviderOutcome({
		provider: "zai",
		model: "glm-5.3-flash",
		code: "rate_limit_exceeded",
	});
	assert.equal(fromCode.kind, "transient-throttle");
	if (fromCode.kind !== "transient-throttle") return;
	assert.equal(fromCode.code, "rate_limit_exceeded");
	assert.ok(fromCode.backoffHintMs > 0);

	const fromServer = classifyProviderOutcome({ provider: "deepseek", model: "deepseek-flash", httpStatus: 503 });
	assert.equal(fromServer.kind, "transient-throttle");
	if (fromServer.kind !== "transient-throttle") return;
	assert.equal(fromServer.backoffHintMs, 5_000);
});

test("classifyProviderOutcome: quota exhaustion wins over a 429 and names the pool window", () => {
	const outcome = classifyProviderOutcome({
		provider: "openai-codex",
		model: "gpt-6-luna",
		httpStatus: 429,
		errorMessage: "You've hit your weekly limit for gpt-6-luna; resets at 09:00",
	});
	assert.equal(outcome.kind, "quota-exhausted");
	if (outcome.kind !== "quota-exhausted") return;
	assert.equal(outcome.retryable, false);
	assert.equal(outcome.window, "weekly");
	assert.equal(outcome.poolKey, "openai-codex/default-account");
	assert.equal(outcome.httpStatus, 429);

	const fromCode = classifyProviderOutcome({
		provider: "command-code",
		model: "deepseek-v4.1-flash",
		httpStatus: 429,
		code: "insufficient_quota",
	});
	assert.equal(fromCode.kind, "quota-exhausted");
	if (fromCode.kind !== "quota-exhausted") return;
	// KD1 (2026-10-16): Command Code is observable, so its pool is the account,
	// not one pool per model.
	assert.equal(fromCode.poolKey, "command-code/default-account");

	const fromPayment = classifyProviderOutcome({ provider: "deepseek", model: "deepseek-flash", httpStatus: 402 });
	assert.equal(fromPayment.kind, "quota-exhausted");
});

test("classifyProviderOutcome: auth/config failure is distinct from throttling", () => {
	const status = classifyProviderOutcome({ provider: "zai", model: "glm-5.3", httpStatus: 401 });
	assert.equal(status.kind, "auth/config-failure");
	const text = classifyProviderOutcome({
		provider: "openai-codex",
		model: "gpt-6-luna",
		httpStatus: 400,
		errorMessage: "invalid api key provided",
	});
	assert.equal(text.kind, "auth/config-failure");
	assert.equal(text.retryable, false);
});

test("classifyProviderOutcome: unsupported model and context overflow are separate classes", () => {
	const missing = classifyProviderOutcome({ provider: "opencode-go", model: "glm-5.3", httpStatus: 404 });
	assert.equal(missing.kind, "unsupported-model");
	const byText = classifyProviderOutcome({
		provider: "opencode-go",
		model: "glm-5.3",
		errorMessage: "The requested model does not exist for this account",
	});
	assert.equal(byText.kind, "unsupported-model");
	const overflow = classifyProviderOutcome({
		provider: "openai-codex",
		model: "gpt-6-luna",
		httpStatus: 400,
		errorMessage: "This model's maximum context length is 128000 tokens",
	});
	assert.equal(overflow.kind, "context-overflow");
});

test("classifyProviderOutcome: unknown carries a concrete reason and never invents a class", () => {
	const outcome = classifyProviderOutcome({ provider: "opencode-go", model: "glm-5.3", httpStatus: 418 });
	assert.equal(outcome.kind, "unknown");
	if (outcome.kind !== "unknown") return;
	assert.match(outcome.reason, /418/);
	const empty = classifyProviderOutcome({ provider: "opencode-go" });
	assert.equal(empty.kind, "unknown");
	assert.equal(empty.provider, "opencode-go");
});

test("classifyProviderOutcome: assistant-shaped input can never become a quota event", () => {
	// The classifier accepts only the structured provider fields. A model
	// sentence smuggled into an extra field is not part of the contract and is
	// ignored, so it cannot downgrade a request or trigger a cooldown.
	const smuggled = {
		provider: "openai-codex",
		model: "gpt-6-luna",
		assistantText: "I hit the weekly quota limit, please retry later",
	} as unknown as ProviderOutcomeInput;
	const outcome = classifyProviderOutcome(smuggled);
	assert.equal(outcome.kind, "unknown");
});

test("ProviderPolicyError is typed for unusable input", () => {
	assert.throws(() => poolKeyFor(""), (error: unknown) => error instanceof ProviderPolicyError);
	assert.throws(() => cooldownUntil("", BASE_TIME));
});

// ─── Pool identity and no fabrication ────────────────────────────────────────

test("KD1: OpenCode Go and Command Code are observable, account-scoped pools", () => {
	const opencode = poolKeyFor("opencode-go");
	assert.equal(opencode.quotaState, "observable");
	assert.equal(opencode.poolKey, "opencode-go/default-account");
	const command = poolKeyFor("command-code");
	assert.equal(command.quotaState, "observable");

	// A reader's reported share is the only source of a percentage; the pool
	// itself stays the account rather than one pool per model.
	const key = providerAdmissionKey({
		provider: "opencode-go",
		model: "glm-5.3-flash",
		quota: { usedPercent: 42, window: "5-hour", capturedAt: BASE_TIME },
	});
	assert.equal(key.quotaState, "observable");
	assert.equal(key.quota?.usedPercent, 42);
	assert.equal(key.poolKey, "opencode-go/default-account");
});

test("native DeepSeek and OpenCode DeepSeek are distinct pools", () => {
	const native = poolKeyFor("deepseek", "operator", "deepseek-flash");
	const opencode = poolKeyFor("opencode-go", "operator", "deepseek-v4.1-flash");
	assert.notEqual(native.poolKey, opencode.poolKey);
	assert.equal(native.quotaState, "metered");
	assert.equal(opencode.quotaState, "observable");

	const nativeObservation = providerAdmissionKey({
		provider: "deepseek",
		account: "operator",
		model: "deepseek-flash",
		quota: { usedPercent: 10, capturedAt: BASE_TIME },
	});
	// A metered credit balance is not a subscription window: no percentage.
	assert.equal(nativeObservation.quota, undefined);
	assert.match(nativeObservation.quotaUnknownReason ?? "", /balance/i);
});

test("GLM through another provider is not native Z.ai and native quota passes through", () => {
	const native = poolKeyFor("zai", "operator", "glm-5.3");
	const viaOpencode = poolKeyFor("opencode-go", "operator", "glm-5.3-flash");
	assert.notEqual(native.poolKey, viaOpencode.poolKey);
	assert.equal(native.quotaState, "observable");
	assert.equal(viaOpencode.quotaState, "observable");

	const nativeKey = providerAdmissionKey({
		provider: "zai",
		account: "operator",
		model: "glm-5.3",
		quota: { usedPercent: 63.5, window: "daily", capturedAt: BASE_TIME },
	});
	assert.equal(nativeKey.quota?.usedPercent, 63.5);
	assert.equal(nativeKey.quota?.window, "daily");
});

test("an unknown provider is opaque, not zero", () => {
	// KD2 (2026-10-16) moved minimax and kimi-coding into the observable set, so
	// this fixture is a provider no reader or policy set knows.
	const key = providerAdmissionKey({ provider: "acme-inference", model: "acme-1" });
	assert.equal(key.quotaState, "unknown");
	assert.equal(key.quota, undefined);
});

// ─── Master route policy (A8), roster per the 2026-10-04 routing map ──────────

test("the Luna equivalence map is empty: no auto-derived equivalent", () => {
	assert.deepEqual(Object.keys(LUNA_EQUIVALENT_ROUTES), []);
	assert.equal(LunaMasterPolicy.lunaEquivalentRoutes, LUNA_EQUIVALENT_ROUTES);
});

test("T2: no approved master or worker default is a retired Sol or Luna route, and the roster is the cheap pair", () => {
	for (const route of [...APPROVED_MASTER_ROUTES, ...APPROVED_CHEAP_WORKER_ROUTES]) {
		assert.doesNotMatch(route, /sol|luna/i, `${route} is retired: Codex holds Astra only`);
	}
	assert.deepEqual([...APPROVED_MASTER_ROUTES].sort(), ["opencode-go/deepseek-v4.1-flash", "zai/glm-5.3-flash"]);
	// The roster is the provider list's worker role (P3, Q3): the policy reads that file, never a second copy of it.
	const roster = poolWorkerRole();
	assert.ok(roster !== undefined && roster.length >= 2, "the list names a worker role");
	if (roster === undefined) return;
	// The seed's own worker model must be a route a fallback may land on, or a
	// catalogue entry and the policy would contradict each other.
	const seed = JSON.parse(
		readFileSync(new URL("../../../docs/muster-seeds/muster-projects.seed.json", import.meta.url), "utf8"),
	) as { projects: Array<{ settings?: { workerModel?: string; rotation?: { parentModel?: string } } }> };
	const routes = [
		...seed.projects.flatMap((project) => [project.settings?.workerModel, project.settings?.rotation?.parentModel]),
		...roster,
	].filter((route): route is string => typeof route === "string");
	assert.ok(routes.length >= 2, "the seed and the list name routed models");
	for (const route of routes) {
		assert.doesNotMatch(route, /sol|luna/i, `${route} is retired`);
		assert.equal(routeExclusionFor(route, "worker"), undefined, `${route} is not a route workers may fall back to`);
		assert.ok(
			[...APPROVED_MASTER_ROUTES, ...roster].includes(route),
			`${route} is a configured route and the policy must know it`,
		);
	}
});

test("an available approved master route stays the same", () => {
	const decision = resolveMasterRoute(
		"master",
		"zai/glm-5.3-flash",
		"zai/glm-5.3-flash",
		{ route: "zai/glm-5.3-flash", available: true },
	);
	assert.deepEqual(decision, { kind: "same" });
});

test("an unavailable approved master route waits visibly instead of substituting a model", () => {
	const decision = resolveMasterRoute(
		"master",
		"zai/glm-5.3-flash",
		"zai/glm-5.3-flash",
		{ route: "zai/glm-5.3-flash", available: false, reason: "provider HTTP 429" },
		{ blockedTaskIds: ["task-1"], scopeRevision: 7 },
	);
	assert.equal(decision.kind, "wait");
	if (decision.kind !== "wait") return;
	assert.equal(decision.statePreserved, true);
	assert.match(decision.reason, /429/);
	assert.equal(decision.notify.kind, "authorization");
	assert.equal(decision.notify.recommendation, "wait");
	assert.deepEqual(decision.notify.blockedTaskIds, ["task-1"]);
	assert.equal(decision.notify.scopeRevision, 7);
	assert.ok(decision.notify.options.some((option) => option.id === "wait"));
});

test("a different model is refused even while the master route is reported available", () => {
	const decision = resolveMasterRoute(
		"master",
		"opencode-go/deepseek-v4.1-flash",
		"zai/glm-5.3-flash",
		{ route: "zai/glm-5.3-flash", available: true },
	);
	assert.equal(decision.kind, "wait");
	if (decision.kind !== "wait") return;
	assert.match(decision.reason, /not configured as a Luna-equivalent/);
});

test("the master policy does not govern non-master routes", () => {
	const decision = resolveMasterRoute(
		"master",
		"command-code/deepseek/deepseek-v4.1-flash",
		"command-code/deepseek/deepseek-v4.1-flash",
		{ route: "command-code/deepseek/deepseek-v4.1-flash", available: false, reason: "404" },
	);
	assert.deepEqual(decision, { kind: "same" });
});

// ─── Worker fallback gating ──────────────────────────────────────────────────

test("a worker fallback outside the approved cheap chain is blocked", () => {
	const decision = resolveWorkerFallback("command-code/deepseek/deepseek-v4.1-flash", ["openai-codex/gpt-5.6-luna"]);
	assert.equal(decision.kind, "blocked");
	if (decision.kind !== "blocked") return;
	assert.ok(decision.reasons.some((reason) => reason.includes("not an explicitly approved cheap-worker route")));
});

test("the default roster is the pool's worker role: a route the list names is approved with no options", () => {
	// `opencode-go/glm-5.3-flash` is first in the worker role (bac39d7); the A8 ruling (orchestrator,
	// 2026-10-06) approves it as a cheap worker route, so the unconfigured default resolves through the pool.
	// 2026-10-23: the worker role is Command Code DeepSeek V4.1 Flash then MiniMax M3.1 Flash.
	const decision = resolveWorkerFallback("command-code/deepseek/deepseek-v4.1-flash", ["minimax/MiniMax-M3.1-Flash"]);
	assert.equal(decision.kind, "route");
	if (decision.kind !== "route") return;
	assert.equal(decision.route, "minimax/MiniMax-M3.1-Flash");
	// A route the list does not know is still not approved by similarity.
	const stranger = resolveWorkerFallback("zai/glm-5.3-flash", ["native/deepseek/deepseek-flash"]);
	assert.equal(stranger.kind, "blocked");
});

test("an empty chain blocks with a concrete reason", () => {
	const decision = resolveWorkerFallback("zai/glm-5.3-flash", []);
	assert.deepEqual(decision, { kind: "blocked", reasons: ["no fallback chain configured"] });
});

test("an approved cheap route with no declared minimum resolves", () => {
	assert.ok(APPROVED_CHEAP_WORKER_ROUTES.includes("minimax/MiniMax-M3.1-Flash"));
	const decision = resolveWorkerFallback("command-code/deepseek/deepseek-v4.1-flash", ["minimax/MiniMax-M3.1-Flash"]);
	assert.equal(decision.kind, "route");
	if (decision.kind !== "route") return;
	assert.equal(decision.route, "minimax/MiniMax-M3.1-Flash");
});

test("a fallback that cannot carry the required context is blocked, never truncated", () => {
	const decision = resolveWorkerFallback("zai/glm-5.3-flash", ["command-code/deepseek/deepseek-v4.1-flash"], {
		minimumContextTokens: 300_000,
		routeFacts: { "command-code/deepseek/deepseek-v4.1-flash": { contextWindowTokens: 131_072 } },
	});
	assert.equal(decision.kind, "blocked");
	if (decision.kind !== "blocked") return;
	assert.ok(decision.reasons.some((reason) => reason.includes("below the required")));

	const unknown = resolveWorkerFallback("zai/glm-5.3-flash", ["command-code/deepseek/deepseek-v4.1-flash"], {
		minimumContextTokens: 300_000,
	});
	assert.equal(unknown.kind, "blocked");
	if (unknown.kind !== "blocked") return;
	assert.ok(unknown.reasons.some((reason) => reason.includes("context window is unknown")));
});

test("a fallback lacking required tools is blocked via the passed-in predicate", () => {
	const decision = resolveWorkerFallback("zai/glm-5.3-flash", ["command-code/deepseek/deepseek-v4.1-flash"], {
		requiredCapabilities: ["write-files", "run_check"],
		capabilityCheck: (route, requirements) => requirements.requiredCapabilities?.includes("run_check") === true && route !== ""
			? { ok: false, reasons: [`route ${route} cannot carry the run_check tool`] }
			: { ok: true },
	});
	assert.equal(decision.kind, "blocked");
	if (decision.kind !== "blocked") return;
	assert.ok(decision.reasons.some((reason) => reason.includes("run_check")));
});

test("required capabilities are blocked when route facts are absent, and pass when proven", () => {
	const blocked = resolveWorkerFallback("zai/glm-5.3-flash", ["command-code/deepseek/deepseek-v4.1-flash"], {
		requiredCapabilities: ["write-files"],
	});
	assert.equal(blocked.kind, "blocked");

	const passed = resolveWorkerFallback("zai/glm-5.3-flash", ["command-code/deepseek/deepseek-v4.1-flash"], {
		requiredCapabilities: ["write-files"],
		routeFacts: { "command-code/deepseek/deepseek-v4.1-flash": { tools: ["read", "write-files"] } },
	});
	assert.equal(passed.kind, "route");
});

test("a fallback equal to the requested model is refused", () => {
	const decision = resolveWorkerFallback("zai/glm-5.3-flash", ["zai/glm-5.3-flash"]);
	assert.equal(decision.kind, "blocked");
	if (decision.kind !== "blocked") return;
	assert.ok(decision.reasons.some((reason) => reason.includes("is the requested model")));
});

test("an approved-list override still cannot smuggle in an excluded frontier route", () => {
	const decision = resolveWorkerFallback("zai/glm-5.3-flash", ["native/claude-opus-5"], {
		approvedRoutes: ["native/claude-opus-5"],
	});
	assert.equal(decision.kind, "blocked");
	if (decision.kind !== "blocked") return;
	assert.ok(decision.reasons.some((reason) => reason.includes("excluded frontier/metered")));
});

// ─── Cooldowns ───────────────────────────────────────────────────────────────

test("an exhausted pool cools down for the default window and expires", () => {
	resetProviderPolicyState();
	const cooldown = cooldownUntil("opencode-go/default-account/glm-5.3-flash", BASE_TIME);
	assert.equal(cooldown.until, BASE_TIME + DEFAULT_COOLDOWN_MS);
	assert.equal(isPoolCoolingDown(cooldown.poolKey, BASE_TIME + 29 * MINUTE), true);
	assert.equal(isPoolCoolingDown(cooldown.poolKey, BASE_TIME + DEFAULT_COOLDOWN_MS), false);
	assert.equal(poolCooldown(cooldown.poolKey, BASE_TIME + HOUR), undefined);
	resetProviderPolicyState();
});

test("the caller can override the cooldown window and a reset time extends it", () => {
	resetProviderPolicyState();
	const short = cooldownUntil("zai/default-account", BASE_TIME, { cooldownMs: 1_000 });
	assert.equal(short.until, BASE_TIME + 1_000);
	const extended = cooldownUntil("command-code/default-account/deepseek-v4.1-flash", BASE_TIME, {
		cooldownMs: 1_000,
		resetAt: BASE_TIME + 10 * MINUTE,
	});
	assert.equal(extended.until, BASE_TIME + 10 * MINUTE);
	assert.equal(extended.resetAt, BASE_TIME + 10 * MINUTE);
	resetProviderPolicyState();
});

test("pool-keyed admission denies a cooling pool and admits an unrelated pool", () => {
	resetProviderPolicyState();
	const codex = { provider: "openai-codex", model: "gpt-6-luna" };
	const admitted = providerRequestAdmission(codex, { at: BASE_TIME });
	assert.equal(admitted.admitted, true);
	if (!admitted.admitted) return;
	assert.equal(admitted.key.poolKey, "openai-codex/default-account");

	cooldownUntil(admitted.key.poolKey, BASE_TIME);
	const denied = providerRequestAdmission(codex, { at: BASE_TIME + MINUTE });
	assert.equal(denied.admitted, false);
	if (denied.admitted) return;
	assert.equal(denied.reason, "cooldown");
	assert.equal(denied.cooldown.until, BASE_TIME + DEFAULT_COOLDOWN_MS);

	const other = providerRequestAdmission({ provider: "zai", model: "glm-5.3-flash", account: "operator" }, { at: BASE_TIME + MINUTE });
	assert.equal(other.admitted, true);

	const afterExpiry = providerRequestAdmission(codex, { at: BASE_TIME + DEFAULT_COOLDOWN_MS });
	assert.equal(afterExpiry.admitted, true);
	resetProviderPolicyState();
});

// ─── Status summary ──────────────────────────────────────────────────────────

test("status summary keeps unknown and stale observations visible", () => {
	resetProviderPolicyState();
	providerRequestAdmission({
		provider: "zai",
		model: "glm-5.3",
		quota: { usedPercent: 91, window: "daily", capturedAt: BASE_TIME - 2 * HOUR, source: "glm-token-plan" },
	}, { at: BASE_TIME });
	providerRequestAdmission({ provider: "opencode-go", model: "glm-5.3-flash" }, { at: BASE_TIME });
	cooldownUntil("opencode-go/default-account", BASE_TIME, { cooldownMs: 10 * MINUTE });

	const summary = providerPolicyStatusSummary({ at: BASE_TIME + MINUTE });
	assert.equal(summary.reservesActive, false);
	const zai = summary.pools.find((pool) => pool.provider === "zai");
	assert.equal(zai?.quota?.usedPercent, 91);
	assert.equal(zai?.quotaFreshness, "unknown");
	const opencodeGo = summary.pools.find((pool) => pool.provider === "opencode-go");
	assert.equal(opencodeGo?.quotaState, "observable");
	assert.equal(opencodeGo?.quota, undefined);
	assert.ok((opencodeGo?.quotaUnknownReason ?? "").length > 0);
	assert.equal(opencodeGo?.cooldown?.active, true);
	assert.equal(opencodeGo?.cooldown?.remainingMs, 9 * MINUTE);
	resetProviderPolicyState();
});

test("the §6 reserve profile values exist but enforce nothing until selected", () => {
	assert.equal(D4_RESERVE_PROFILE.selected, false);
	assert.equal(D4_RESERVE_PROFILE.thresholds.length, 3);
	assert.equal(reserveThresholdFor("openai-codex", "weekly"), undefined);
	assert.equal(reserveThresholdFor("zai", "daily"), undefined);
	const selected = { ...D4_RESERVE_PROFILE, selected: true };
	assert.equal(reserveThresholdFor("openai-codex", "weekly", selected)?.usedPercent, 75);
	assert.equal(reserveThresholdFor("openai-codex", "5-hour", selected)?.usedPercent, 90);
	assert.equal(reserveThresholdFor("zai", "daily", selected)?.usedPercent, 90);
});

// ─── Resolved-route exclusions ───────────────────────────────────────────────

test("frontier and metered exclusions match the resolved route", () => {
	assert.ok(FRONTIER_WORKER_EXCLUDED_ROUTES.includes("native/claude-opus-5-5"));
	assert.equal(routeExclusionFor("native/claude-opus-5-5", "implement")?.class, "frontier");
	assert.equal(routeExclusionFor("native/claude-opus-5", "implement")?.class, "frontier");
	assert.equal(routeExclusionFor("openai-codex/gpt-6-astra", "review")?.class, "frontier");
	assert.equal(routeExclusionFor("openrouter/some-model", "research")?.class, "metered");
	assert.equal(routeExclusionFor("anthropic/claude-sonnet-5", "implement")?.class, "metered");
});

test("an approved cheap route and the master route are not excluded", () => {
	assert.equal(routeExclusionFor("zai/glm-5.3-flash", "implement"), undefined);
	assert.equal(routeExclusionFor("command-code/deepseek/deepseek-v4.1-flash", "implement"), undefined);
	assert.equal(routeExclusionFor("openai-codex/gpt-6-luna", "verify"), undefined);
});

test("the requested friendly name is not what gets enforced", () => {
	// "opus" is an alias the resolver maps to native/claude-opus-5-5; the
	// exclusion decision is made on the resolved route, so the bare alias alone
	// is not a match — the delegate seam resolves first, then enforces.
	assert.equal(routeExclusionFor("opus", "implement"), undefined);
	assert.equal(routeExclusionFor("native/claude-opus-5-5", "implement") !== undefined, true);
});

test("exclusion overrides let a profile extend the lists without name inference", () => {
	const exclusion = routeExclusionFor("some-provider/expensive-model", "implement", {
		frontierRoutes: ["some-provider/expensive-model"],
	});
	assert.equal(exclusion?.class, "frontier");
	assert.equal(routeExclusionFor("openrouter/x", "implement", { meteredPrefixes: [] }), undefined);
});
