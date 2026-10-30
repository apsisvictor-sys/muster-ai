/**
 * Provider-aware operation policy (plan §7 P4.1, §6 D4; decision A8).
 *
 * Pure policy module at leaf level: no Pi API, no network, no Concord and no
 * delegate import. It owns five decisions the delegate seams previously made
 * implicitly:
 *
 * 1. `classifyProviderOutcome` — one typed provider failure class from the
 *    STRUCTURED provider error channel only (HTTP status, provider error code,
 *    provider error text the transport already parsed). Assistant message text
 *    is not an input, so a model sentence can never become a quota event.
 * 2. `providerAdmissionKey`/`poolKeyFor` — provider/account/pool identity for
 *    admission. OpenCode Go and Command Code are observable (decision KD1,
 *    2026-10-16: each reports its own account window, so both pools are
 *    account-scoped and carry only a share a reader reported); native DeepSeek
 *    is not OpenCode DeepSeek and native Z.ai is not GLM through another
 *    provider. Unknown stays unknown: a pool without a reader never carries a
 *    fabricated percentage.
 * 3. `LunaMasterPolicy.resolveMasterRoute` — the orchestrator stays Luna. An
 *    unavailable Luna route resolves to an explicitly configured equivalent
 *    (const map, initially EMPTY) or to a visible wait with a decision/notify
 *    payload; it never substitutes Flash, Astra, Opus or another model.
 * 4. `resolveWorkerFallback` — a worker fallback must be an explicitly
 *    configured cheap-worker route AND pass the caller's capability predicate
 *    (tool capability/context minimums). A fallback that cannot carry the
 *    required context/tools is blocked, never silently truncated onto a
 *    smaller route.
 * 5. `cooldownUntil` + `providerPolicyStatusSummary` — an exhausted pool cools
 *    down in-memory (default 30 min, caller-overridable) instead of being
 *    retried in a loop, and stale/unknown observations remain visible.
 *
 * The §6 reserve thresholds (Codex 75% weekly / 90% short window; native Z.ai
 * 90%) are declared in `D4_RESERVE_PROFILE` with `selected: false`. They are a
 * proposed profile: `reserveThresholdFor` returns nothing until an operator
 * explicitly selects that profile, so no unapproved reserve is ever enforced.
 *
 * `OpenDecisionInput` is imported as a TYPE from `../lib/core/decision-types.ts`:
 * the vocabulary carries no import into Muster, so there is no cycle.
 */

import type { OpenDecisionInput } from "../core/decision-types.ts";
import { freeRefPoolKey, loadPoolConfig } from "./provider-pool.ts";

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export const PROVIDER_POLICY_VERSION = 1 as const;

/** An exhausted pool cools down instead of being retried in a rapid loop. */
export const DEFAULT_COOLDOWN_MS = 30 * 60_000;
export const MAX_COOLDOWN_MS = 24 * 60 * 60_000;
/** Bounded backoff hints for a transient provider throttle. */
export const DEFAULT_THROTTLE_BACKOFF_MS = 15_000;
export const DEFAULT_SERVER_BACKOFF_MS = 5_000;
export const MAX_BACKOFF_HINT_MS = 120_000;
/** A supported observation captured this recently is reused, never re-polled per model turn. */
export const FRESH_OBSERVATION_MS = 5 * 60_000;
/** Past this age a captured observation is stale evidence, not a fact. */
export const STALE_OBSERVATION_MS = 30 * 60_000;
/** Account label used when an observation does not name its account. */
const DEFAULT_ACCOUNT = "default-account";

/** How the remaining quota of one pool can be known (plan §6 observability table). */
export type ProviderQuotaState = "observable" | "unknown" | "metered";

/**
 * Opaque subscription surfaces: remaining dashboard quota is not machine
 * readable, so an exhausted route is cooled down from actual errors only and no
 * percentage is ever invented (F3, D6). Empty since KD1 (2026-10-16) moved
 * OpenCode Go and Command Code to the observable set; a provider belongs here
 * only while it has no supported reader.
 */
const OPAQUE_POOL_PROVIDERS = new Set<string>([]);
/**
 * Account surfaces whose remaining quota a supported first-party reader
 * reports: native OpenAI Codex and Z.ai/Zhipu, plus OpenCode Go
 * (`lib/opencode-go-quota.ts`) and Command Code (`lib/command-code-quota.ts`)
 * on decision KD1 (2026-10-16), and MiniMax and Kimi Coding on decision KD2
 * (2026-10-16): each reports subscription windows, so the snapshot and the
 * P5-D1 headroom check read them. The reserve profile stays unselected, so
 * admission does not change. Qwen left this set with VR24-173.
 */
const OBSERVABLE_POOL_PROVIDERS = new Set(["openai-codex", "zai", "zhipu", "opencode-go", "command-code", "minimax", "kimi-coding"]);
/**
 * Pay-as-you-go surfaces: a credit balance is observable but it is NOT a
 * subscription window, so it never becomes a quota percentage. Runware joins
 * the set with the usage snapshot (UM5, 2026-10-16); it reports a unified
 * inference credit balance like DeepSeek and OpenRouter.
 */
const METERED_POOL_PROVIDERS = new Set(["openrouter", "deepseek", "anthropic", "openai", "runware"]);

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Typed policy failure, shaped like `ProgrammeControlStateError`:
 * - `io`: invalid input (unusable pool key or timestamp);
 * - `cooldown`: a cooldown window cannot be derived.
 */
export class ProviderPolicyError extends Error {
	constructor(
		readonly code: "io" | "cooldown",
		message: string,
	) {
		super(message);
		this.name = "ProviderPolicyError";
	}
}

// ─── Pool identity ───────────────────────────────────────────────────────────

export type ProviderPoolKey = {
	provider: string;
	account?: string;
	poolKey: string;
	quotaState: ProviderQuotaState;
};

/**
 * The admission key for one provider observation. `quota` is present only for
 * an observable pool whose supported reader reported a usable percentage;
 * opaque/metered pools carry `quotaUnknownReason` instead — never a number
 * derived from tokens, model names or errors.
 */
export type ProviderAdmissionKey = ProviderPoolKey & {
	quota?: NormalizedQuotaObservation;
	quotaUnknownReason?: string;
};

export type ProviderObservation = {
	provider: string;
	model?: string;
	account?: string;
	/**
	 * Output of a supported reader (codex-quota/glm-quota/deepseek-quota/
	 * openrouter-quota/opencode-go-quota/command-code-quota). It is evidence,
	 * not authority: an observation for a pool with no reader, or for a metered
	 * surface, is discarded with a visible reason.
	 */
	quota?: {
		window?: string;
		usedPercent?: number;
		resetsAt?: number | string;
		capturedAt?: number | string;
		source?: string;
	};
};

export type NormalizedQuotaObservation = {
	window?: string;
	/** 0..100 used share, only when a supported reader reported it. */
	usedPercent?: number;
	/** Epoch ms when the provider resets the window, when reported. */
	resetsAt?: number;
	/** Epoch ms the snapshot was captured, when reported. */
	capturedAt?: number;
	source?: string;
};

/**
 * The one normalization of a provider name: trimmed and lower-cased. Exported
 * for the signal store (UM8), so a signal's provider is the same id the pool
 * and the snapshot use.
 */
export function normalizeProviderId(provider: string): string {
	return String(provider ?? "").trim().toLowerCase();
}

function normalizeAccount(account: string | undefined): string | undefined {
	const normalized = typeof account === "string" ? account.trim() : "";
	return normalized === "" ? undefined : normalized;
}

/**
 * Pool identity for one provider/account surface. Never inferred across
 * providers: `deepseek/<account>` and `opencode-go/<account>/<model>` are
 * different pools (native DeepSeek credit does not describe OpenCode DeepSeek),
 * and native `zai` is never GLM through another provider.
 */
export function poolKeyFor(provider: string, account?: string, model?: string): ProviderPoolKey {
	const providerId = normalizeProviderId(provider);
	const normalizedAccount = normalizeAccount(account);
	if (providerId === "") {
		throw new invalidInput("poolKeyFor requires a non-empty provider");
	}
	const accountKey = normalizedAccount ?? DEFAULT_ACCOUNT;
	const modelKey = normalizeModelKey(model);
	// A free ref carries its model on every provider (`freeRefPoolKey`, the same free-ref rule
	// `wallKey` applies to its quota wall), so its cooldown never meets its provider's account-scoped
	// key or a paid sibling's; every other ref keeps the account-scoped pool.
	const poolKey = (modelKey === undefined ? undefined : freeRefPoolKey(`${providerId}/${modelKey}`, accountKey)) ?? `${providerId}/${accountKey}`;
	if (OPAQUE_POOL_PROVIDERS.has(providerId)) {
		// One opaque route surface is one pool: the provider cannot report a
		// shared account window, so a model-scoped key avoids pretending it can.
		return {
			provider: providerId,
			account: normalizedAccount,
			poolKey: `${providerId}/${accountKey}${modelKey ? `/${modelKey}` : ""}`,
			quotaState: "unknown",
		};
	}
	if (OBSERVABLE_POOL_PROVIDERS.has(providerId)) {
		return { provider: providerId, account: normalizedAccount, poolKey, quotaState: "observable" };
	}
	if (METERED_POOL_PROVIDERS.has(providerId)) {
		return { provider: providerId, account: normalizedAccount, poolKey, quotaState: "metered" };
	}
	// An unrecognized provider has no supported reader: its pool stays unknown.
	return { provider: providerId, account: normalizedAccount, poolKey, quotaState: "unknown" };
}

/**
 * Derive the admission key from one observation. The quota payload survives
 * only for an observable pool; for every other pool the result names why it is
 * unknown and carries no percentage (no fabrication from opaque providers).
 */
export function providerAdmissionKey(observation: ProviderObservation): ProviderAdmissionKey {
	if (observation === null || typeof observation !== "object") {
		throw new invalidInput("providerAdmissionKey requires an observation object");
	}
	const pool = poolKeyFor(observation.provider, observation.account, observation.model);
	if (pool.quotaState !== "observable") {
		return {
			...pool,
			quotaUnknownReason: pool.quotaState === "metered"
				? "metered surface: a credit balance is not a subscription quota window"
				: "provider quota is not machine-observable through the current setup",
		};
	}
	const quota = normalizeQuotaObservation(observation.quota);
	if (quota === undefined) {
		return { ...pool, quotaUnknownReason: "no supported observation recorded for this pool" };
	}
	return { ...pool, quota };
}

function normalizeModelKey(model: string | undefined): string | undefined {
	const normalized = typeof model === "string" ? model.trim() : "";
	return normalized === "" ? undefined : normalized;
}

function normalizeQuotaObservation(
	quota: ProviderObservation["quota"],
): NormalizedQuotaObservation | undefined {
	if (quota === null || typeof quota !== "object") return undefined;
	const normalized: NormalizedQuotaObservation = {};
	if (typeof quota.window === "string" && quota.window.trim() !== "") normalized.window = quota.window.trim();
	if (typeof quota.usedPercent === "number" && Number.isFinite(quota.usedPercent) && quota.usedPercent >= 0 && quota.usedPercent <= 100) {
		normalized.usedPercent = quota.usedPercent;
	}
	const resetsAt = normalizeEpochMs(quota.resetsAt);
	if (resetsAt !== undefined) normalized.resetsAt = resetsAt;
	const capturedAt = normalizeEpochMs(quota.capturedAt);
	if (capturedAt !== undefined) normalized.capturedAt = capturedAt;
	if (typeof quota.source === "string" && quota.source.trim() !== "") normalized.source = quota.source.trim();
	return Object.keys(normalized).length === 0 ? undefined : normalized;
}

function normalizeEpochMs(value: number | string | undefined): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

/** Epoch-ms normalization shared by cooldown and observation timestamps. */
export function normalizeObservationAt(value: number | string): number {
	const epoch = normalizeEpochMs(value);
	if (epoch === undefined) throw new invalidInput(`invalid observation timestamp: ${String(value)}`);
	return epoch;
}

// ─── Outcome classification ──────────────────────────────────────────────────

export type ProviderOutcomeInput = {
	provider: string;
	model?: string;
	account?: string;
	/** HTTP status when the transport surfaced one. */
	httpStatus?: number;
	/** Structured provider error code (`insufficient_quota`, `model_not_found`, …). */
	code?: string | number;
	/**
	 * Provider error text from the provider/transport error channel
	 * (`terminal.errorMessage`, `stopReason=error` message). This is NOT
	 * assistant text: a model sentence never reaches this field.
	 */
	errorMessage?: string;
};

export type ProviderOutcomeBase = {
	provider: string;
	model?: string;
	account?: string;
	httpStatus?: number;
	code?: string;
};

export type ProviderOutcome =
	| (ProviderOutcomeBase & {
		kind: "transient-throttle";
		retryable: true;
		backoffHintMs: number;
		reason: string;
	})
	| (ProviderOutcomeBase & {
		kind: "quota-exhausted";
		retryable: false;
		poolKey: string;
		window?: string;
		reason: string;
	})
	| (ProviderOutcomeBase & { kind: "auth/config-failure"; retryable: false; reason: string })
	| (ProviderOutcomeBase & { kind: "unsupported-model"; retryable: false; reason: string })
	| (ProviderOutcomeBase & { kind: "context-overflow"; retryable: false; reason: string })
	| (ProviderOutcomeBase & { kind: "unknown"; retryable: false; reason: string });

const QUOTA_CODES = new Set([
	"insufficient_quota",
	"quota_exceeded",
	"quota-exceeded",
	"usage_limit_reached",
	"account_quota_exceeded",
	"billing_hard_limit_reached",
	"credit_balance_too_low",
	"payment_required",
]);
const AUTH_CODES = new Set([
	"invalid_api_key",
	"invalid_authentication",
	"authentication_error",
	"unauthorized",
	"permission_denied",
	"forbidden",
]);
const UNSUPPORTED_MODEL_CODES = new Set([
	"model_not_found",
	"model_not_available",
	"unsupported_model",
	"unknown_model",
]);
const CONTEXT_OVERFLOW_CODES = new Set([
	"context_length_exceeded",
	"context_window_exceeded",
	"max_context_length_exceeded",
	"prompt_too_long",
	"too_many_tokens",
]);
const TRANSIENT_CODES = new Set([
	"rate_limit_exceeded",
	"rate_limited",
	"too_many_requests",
	"overloaded_error",
	"server_error",
	"service_unavailable",
	"timeout",
	"timed_out",
	"etimedout",
	"econnreset",
	"eai_again",
]);

const QUOTA_MESSAGE_PATTERN = /hit your (session|weekly|daily|monthly|usage) limit|quota exceeded|usage limit reached|insufficient (quota|credit|balance)|out of credit|credit balance/i;
const CONTEXT_MESSAGE_PATTERN = /context (length|window)|maximum context|prompt is too long|too many tokens/i;
const UNSUPPORTED_MODEL_MESSAGE_PATTERN = /model[^.]*(not found|not available|unsupported|does not exist|unknown)/i;
const AUTH_MESSAGE_PATTERN = /unauthorized|forbidden|invalid api key|api[ _-]?key|authentication/i;
const TRANSIENT_MESSAGE_PATTERN = /rate.?limit|too many requests|\b429\b|overloaded|temporarily unavailable|server error|timed? ?out|timeout|econnreset|eai_again|try again/i;
const RETRY_AFTER_PATTERN = /retry[ -]?after[:\s]+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec(?:onds?)?|m|min(?:utes?)?|h|hours?)?/i;

function outcomeBase(input: ProviderOutcomeInput, code?: string): ProviderOutcomeBase {
	const base: ProviderOutcomeBase = { provider: normalizeProviderId(input.provider) || "unknown" };
	const model = typeof input.model === "string" && input.model.trim() !== "" ? input.model.trim() : undefined;
	if (model !== undefined) base.model = model;
	const account = normalizeAccount(input.account);
	if (account !== undefined) base.account = account;
	if (typeof input.httpStatus === "number" && Number.isFinite(input.httpStatus)) base.httpStatus = input.httpStatus;
	if (code !== undefined) base.code = code;
	return base;
}

function normalizeCode(code: string | number | undefined): string | undefined {
	if (typeof code === "number" && Number.isFinite(code)) return String(code);
	if (typeof code === "string" && code.trim() !== "") return code.trim().toLowerCase();
	return undefined;
}

/**
 * One structured provider outcome. Resolution order is explicit so the same
 * input always classifies the same way:
 *   1. provider error code;
 *   2. auth status (401/403);
 *   3. quota error text (an account window is exhausted even under a 429);
 *   4. context/size error text;
 *   5. unsupported-model error text;
 *   6. HTTP status (402 quota, 404 unsupported, 408/425/429/5xx transient);
 *   7. auth text, then transient text;
 *   8. unknown with a concrete reason.
 */
export function classifyProviderOutcome(input: ProviderOutcomeInput): ProviderOutcome {
	if (input === null || typeof input !== "object") {
		throw new invalidInput("classifyProviderOutcome requires an input object");
	}
	const code = normalizeCode(input.code);
	const message = typeof input.errorMessage === "string" ? input.errorMessage : "";
	const status = typeof input.httpStatus === "number" && Number.isFinite(input.httpStatus) ? input.httpStatus : undefined;
	const base = outcomeBase(input, code);

	if (code !== undefined) {
		if (AUTH_CODES.has(code)) return { ...base, kind: "auth/config-failure", retryable: false, reason: `provider auth/config code ${code}` };
		if (QUOTA_CODES.has(code)) {
			const pool = poolKeyFor(input.provider, input.account, input.model);
			const window = inferQuotaWindow(message);
			return {
				...base,
				kind: "quota-exhausted",
				retryable: false,
				poolKey: pool.poolKey,
				...(window !== undefined ? { window } : {}),
				reason: `provider quota code ${code}`,
			};
		}
		if (CONTEXT_OVERFLOW_CODES.has(code)) {
			return { ...base, kind: "context-overflow", retryable: false, reason: `provider context code ${code}` };
		}
		if (UNSUPPORTED_MODEL_CODES.has(code)) {
			return { ...base, kind: "unsupported-model", retryable: false, reason: `provider model code ${code}` };
		}
		if (TRANSIENT_CODES.has(code)) {
			return {
				...base,
				kind: "transient-throttle",
				retryable: true,
				backoffHintMs: throttleBackoffMs(code, status, message),
				reason: `provider transient code ${code}`,
			};
		}
	}
	if (status === 401 || status === 403) {
		return { ...base, kind: "auth/config-failure", retryable: false, reason: `provider HTTP ${status}` };
	}
	if (QUOTA_MESSAGE_PATTERN.test(message)) {
		const pool = poolKeyFor(input.provider, input.account, input.model);
		const window = inferQuotaWindow(message);
		return {
			...base,
			kind: "quota-exhausted",
			retryable: false,
			poolKey: pool.poolKey,
			...(window !== undefined ? { window } : {}),
			reason: "provider reported an exhausted account window",
		};
	}
	if (CONTEXT_MESSAGE_PATTERN.test(message)) {
		return { ...base, kind: "context-overflow", retryable: false, reason: "provider reported a context/size overflow" };
	}
	if (UNSUPPORTED_MODEL_MESSAGE_PATTERN.test(message)) {
		return { ...base, kind: "unsupported-model", retryable: false, reason: "provider reported the model as unavailable" };
	}
	if (status !== undefined) {
		if (status === 402) {
			const pool = poolKeyFor(input.provider, input.account, input.model);
			return { ...base, kind: "quota-exhausted", retryable: false, poolKey: pool.poolKey, reason: "provider HTTP 402 payment required" };
		}
		if (status === 404) {
			return { ...base, kind: "unsupported-model", retryable: false, reason: "provider HTTP 404 for the model route" };
		}
		if (status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599)) {
			return {
				...base,
				kind: "transient-throttle",
				retryable: true,
				backoffHintMs: throttleBackoffMs(undefined, status, message),
				reason: `provider HTTP ${status}`,
			};
		}
	}
	if (AUTH_MESSAGE_PATTERN.test(message)) {
		return { ...base, kind: "auth/config-failure", retryable: false, reason: "provider reported an auth/config failure" };
	}
	if (TRANSIENT_MESSAGE_PATTERN.test(message)) {
		return {
			...base,
			kind: "transient-throttle",
			retryable: true,
			backoffHintMs: throttleBackoffMs(undefined, status, message),
			reason: "provider reported a transient throttle",
		};
	}
	return {
		...base,
		kind: "unknown",
		retryable: false,
		reason: status !== undefined
			? `no structured provider signal beyond HTTP ${status}`
			: "no structured provider signal (status, code and provider error text all absent)",
	};
}

function inferQuotaWindow(message: string): string | undefined {
	if (/weekly|week(ly)? limit/i.test(message)) return "weekly";
	if (/monthly|month(ly)? limit/i.test(message)) return "monthly";
	if (/daily|day limit/i.test(message)) return "daily";
	if (/5[ -]?hour|five[ -]?hour/i.test(message)) return "5-hour";
	if (/session limit/i.test(message)) return "session";
	return undefined;
}

function throttleBackoffMs(code: string | undefined, status: number | undefined, message: string): number {
	const explicit = parseRetryAfterMs(message);
	if (explicit !== undefined) return Math.min(MAX_BACKOFF_HINT_MS, Math.max(1_000, explicit));
	if (code === "timeout" || code === "timed_out" || code === "etimedout" || status === 408) return DEFAULT_SERVER_BACKOFF_MS;
	if (status !== undefined && status >= 500 && status <= 599) return DEFAULT_SERVER_BACKOFF_MS;
	return DEFAULT_THROTTLE_BACKOFF_MS;
}

function parseRetryAfterMs(message: string): number | undefined {
	const match = RETRY_AFTER_PATTERN.exec(message);
	if (!match) return undefined;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return undefined;
	const unit = (match[2] ?? "s").toLowerCase();
	if (unit.startsWith("ms") || unit.startsWith("millisecond")) return amount;
	if (unit.startsWith("h")) return amount * 60 * 60_000;
	if (unit.startsWith("m")) return amount * 60_000;
	return amount * 1_000;
}

// ─── Luna master policy (A8) ─────────────────────────────────────────────────

/**
 * Approved master/verifier routes (plan §6/§11; roster set by the operator's routing
 * map of 2026-10-04 23:50, when Sol and Luna left the plan and Codex held only
 * Astra). A master route is bulk work, so the approved roster is the cheap pair:
 * GLM 5.3 flash, and DeepSeek v4.1 flash on opencode-go. Explicit list, never
 * derived from model names, so a rename cannot silently promote another model to
 * master. The `Luna`-named exports below are historical: the policy they belong
 * to is the master-role policy, and its shape (explicit roster, empty
 * equivalence map, wait visibly) is unchanged.
 */
export const APPROVED_MASTER_ROUTES: readonly string[] = [
	"zai/glm-5.3-flash",
	"opencode-go/deepseek-v4.1-flash",
];

/**
 * Luna-equivalent routes. Key = the configured master route; value = routes an
 * operator explicitly configured as equivalent. Bounded const map, initially
 * EMPTY per plan §7 P4.1.3: an unavailable Luna route waits visibly rather
 * than becoming Flash, Astra, Opus or another model. Never auto-derived from
 * model names.
 */
export const LUNA_EQUIVALENT_ROUTES: Readonly<Record<string, readonly string[]>> = Object.freeze<Record<string, readonly string[]>>({});

export type ProviderRouteObservation = {
	route: string;
	/** False when the transport/provider is known to be unavailable. */
	available: boolean;
	reason?: string;
	outcome?: ProviderOutcome;
};

export type MasterDecisionContext = {
	blockedTaskIds?: readonly string[];
	scopeRevision?: string | number;
};

export type MasterRouteResolution =
	| { kind: "same" }
	| { kind: "approved-equivalent"; route: string; reason: string }
	| {
		kind: "wait";
		reason: string;
		/** The caller preserves its run/task state; the wait is not a failure to retry elsewhere. */
		statePreserved: true;
		/** Decision/notification payload (core/decision-types.ts `OpenDecisionInput` shape). */
		notify: OpenDecisionInput;
	};

function normalizeRoute(route: string | undefined): string | undefined {
	const normalized = typeof route === "string" ? route.trim() : "";
	return normalized === "" ? undefined : normalized;
}

export function isApprovedMasterRoute(route: string | undefined): boolean {
	const normalized = normalizeRoute(route);
	if (normalized === undefined) return false;
	return APPROVED_MASTER_ROUTES.some((master) => master.toLowerCase() === normalized.toLowerCase());
}

export function lunaEquivalentRoutes(configuredRoute: string): readonly string[] {
	const normalized = normalizeRoute(configuredRoute);
	if (normalized === undefined) return [];
	for (const [master, equivalents] of Object.entries(LUNA_EQUIVALENT_ROUTES)) {
		if (master.toLowerCase() === normalized.toLowerCase()) return equivalents;
	}
	return [];
}

function masterWait(
	configured: string,
	requested: string,
	reason: string,
	decisionContext: MasterDecisionContext | undefined,
): MasterRouteResolution {
	const notify: OpenDecisionInput = {
		kind: "authorization",
		question: `Luna master route '${configured}' is unavailable (${reason}). Keep the run state and wait for it, or approve an explicitly configured equivalent Luna route before any substitution. Requested '${requested}'.`,
		options: [
			{ id: "wait", label: `Wait for ${configured} to become available` },
			{ id: "approve-equivalent", label: "Approve a specific equivalent Luna route (name the exact route in the answer)" },
		],
		recommendation: "wait",
		blockedTaskIds: [...(decisionContext?.blockedTaskIds ?? [])],
		scopeRevision: decisionContext?.scopeRevision ?? PROVIDER_POLICY_VERSION,
	};
	return { kind: "wait", reason, statePreserved: true, notify };
}

/**
 * Resolve the master model role. The policy governs master-role routes only:
 * a configured route that is not an approved Luna route returns `same` because
 * no master substitution was requested.
 *
 * - configured route usable and requested route identical → `same`;
 * - requested route differs from the configured route and is explicitly
 *   configured as Luna-equivalent → `approved-equivalent`;
 * - anything else (unavailable route, unapproved substitute request) → `wait`
 *   with a decision/notification payload. With the equivalence map empty, every
 *   unavailable master route waits.
 */
export function resolveMasterRoute(
	requestedRole: "master",
	requestedModel: string,
	configuredRoute: string,
	observation?: ProviderRouteObservation,
	decisionContext?: MasterDecisionContext,
): MasterRouteResolution {
	if (requestedRole !== "master") {
		throw new invalidInput("resolveMasterRoute requires requestedRole 'master'");
	}
	const configured = normalizeRoute(configuredRoute);
	const requested = normalizeRoute(requestedModel);
	if (configured === undefined || requested === undefined) {
		throw new invalidInput("resolveMasterRoute requires non-empty configuredRoute and requestedModel");
	}
	if (!isApprovedMasterRoute(configured) && !isApprovedMasterRoute(requested)) {
		return { kind: "same" };
	}
	const available = observation?.available !== false;
	const reason = observation?.reason
		?? (observation?.outcome !== undefined ? `provider outcome ${observation.outcome.kind}` : "availability not observed");

	if (available) {
		if (requested.toLowerCase() === configured.toLowerCase()) return { kind: "same" };
		const equivalents = lunaEquivalentRoutes(configured);
		if (equivalents.some((route) => route.toLowerCase() === requested.toLowerCase())) {
			return {
				kind: "approved-equivalent",
				route: requested,
				reason: `route explicitly configured as Luna-equivalent to ${configured}`,
			};
		}
		return masterWait(
			configured,
			requested,
			`requested route '${requested}' is not the configured master route and is not configured as a Luna-equivalent route`,
			decisionContext,
		);
	}
	// The configured route is unavailable: an explicitly approved equivalent is
	// the only legal substitute; with the map empty this is always a wait.
	const equivalents = lunaEquivalentRoutes(configured);
	const candidate = equivalents.find((route) => route.toLowerCase() === requested.toLowerCase());
	if (candidate !== undefined) {
		return {
			kind: "approved-equivalent",
			route: candidate,
			reason: `configured master route ${configured} is unavailable (${reason}); '${candidate}' is explicitly configured as its Luna-equivalent`,
		};
	}
	return masterWait(configured, requested, `${reason}; no approved equivalent Luna route is configured`, decisionContext);
}

/** Namespace form of the A8 master policy (`LunaMasterPolicy.resolveMasterRoute`). */
export const LunaMasterPolicy = Object.freeze({
	resolveMasterRoute,
	isApprovedMasterRoute,
	approvedMasterRoutes: APPROVED_MASTER_ROUTES,
	lunaEquivalentRoutes: LUNA_EQUIVALENT_ROUTES,
});

// ─── Worker fallback policy ──────────────────────────────────────────────────

/**
 * The worker roster's one owner is the provider list's worker role
 * (`provider-pool.json`, P3; ruling 2026-10-05 18:19: "the worker role is the
 * approved roster, one owner, git-reviewed"). Read per call through
 * `loadPoolConfig` so a profile pointing `PI_PROVIDER_POOL_PATH` at another file
 * gets that file's roster for its run. Undefined when the list file is missing
 * or names no worker role. Exclusions are NOT applied here: a route the list
 * names but workers may not use is refused at admission (`routeExclusionFor` in
 * `resolveWorkerFallback` and in the delegate seam), never silently dropped at
 * the roster level, so the roster mirrors the file.
 */
export function poolWorkerRole(): readonly string[] | undefined {
	const loaded = loadPoolConfig();
	if (!loaded.ok) return undefined;
	const chain = loaded.config.roles.worker;
	if (!Array.isArray(chain) || chain.length === 0) return undefined;
	return chain;
}

/**
 * Degraded default (pre-pool behaviour): the roster the policy holds only when
 * there is no readable provider list or the list names no worker role. Since the
 * provider list owns the roster, the live default takes `poolWorkerRole()` first
 * and falls back to this only without a list, so a route change in the list can
 * never contradict the policy again (A8 ruling, orchestrator 2026-10-06:
 * `opencode-go/glm-5.3-flash` is an approved cheap worker route because the
 * list's worker role names it). the operator's routing map of 2026-10-04 names the
 * cheap pair as `zai/glm-5.3-flash` and `opencode-go/deepseek-v4.1-flash`, and
 * the seeded the CRM app worker model is the latter. The `command-code`
 * DeepSeek Flash build stays approved as the after-2026-10-10 replacement.
 * Similar-looking surfaces (native `deepseek/…`, `command-code/z-ai/…`,
 * `openrouter/…`) are deliberately NOT auto-added: enabling one is an explicit
 * profile choice, and a route is never approved by model-name similarity.
 */
export const APPROVED_CHEAP_WORKER_ROUTES: readonly string[] = [
	// 2026-10-23 (the operator): z.ai spent; the fallback roster matches provider-pool.json's worker role.
	"command-code/deepseek/deepseek-v4.1-flash",
	"minimax/MiniMax-M3.1-Flash",
];

export type WorkerCapabilityRequirements = {
	/** Tool/capability names the worker cannot work without (`write-files`, `run_check`, …). */
	requiredCapabilities?: readonly string[];
	/** Minimum context window the fallback must carry; never truncate to fit. */
	minimumContextTokens?: number;
};

export type WorkerRouteFacts = {
	tools?: readonly string[];
	contextWindowTokens?: number;
};

export type CapabilityVerdict = { ok: true } | { ok: false; reasons: readonly string[] };

export type WorkerFallbackOptions = WorkerCapabilityRequirements & {
	/** Caller-supplied capability predicate; wins over the built-in facts check. */
	capabilityCheck?: (route: string, requirements: WorkerCapabilityRequirements, facts: WorkerRouteFacts | undefined) => CapabilityVerdict;
	/** Structured facts per resolved route; absent facts stay unknown, never assumed. */
	routeFacts?: Readonly<Record<string, WorkerRouteFacts>>;
	/** Override the approved route list (profile selection/tests). */
	approvedRoutes?: readonly string[] | undefined;
};

export type WorkerFallbackResolution =
	| { kind: "route"; route: string; requestedModel: string; reason: string }
	| { kind: "blocked"; reasons: string[] };

function evaluateWorkerCapabilities(
	route: string,
	requirements: WorkerCapabilityRequirements,
	facts: WorkerRouteFacts | undefined,
): CapabilityVerdict {
	const reasons: string[] = [];
	const required = requirements.requiredCapabilities ?? [];
	if (required.length > 0) {
		if (facts?.tools === undefined) {
			reasons.push(`route tool capabilities are unknown for '${route}'; cannot prove it carries ${required.join(", ")}`);
		} else {
			const missing = required.filter((capability) => !(facts.tools ?? []).includes(capability));
			if (missing.length > 0) reasons.push(`route '${route}' lacks required capabilities: ${missing.join(", ")}`);
		}
	}
	if (requirements.minimumContextTokens !== undefined) {
		if (facts?.contextWindowTokens === undefined) {
			reasons.push(`context window is unknown for '${route}'; cannot prove it carries ${requirements.minimumContextTokens} tokens`);
		} else if (facts.contextWindowTokens < requirements.minimumContextTokens) {
			reasons.push(`context window ${facts.contextWindowTokens} of '${route}' is below the required ${requirements.minimumContextTokens} tokens`);
		}
	}
	return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/**
 * Choose the first usable worker fallback. Every candidate must be an
 * explicitly approved cheap-worker route, differ from the requested model and
 * pass the capability predicate. Anything else is refused with concrete
 * reasons — there is no "best effort" substitution and no silent truncation.
 */
export function resolveWorkerFallback(
	requestedModel: string,
	fallbackChain: readonly string[],
	options: WorkerFallbackOptions = {},
): WorkerFallbackResolution {
	const requested = normalizeRoute(requestedModel);
	if (requested === undefined) throw new invalidInput("resolveWorkerFallback requires a non-empty requestedModel");
	const chain = Array.isArray(fallbackChain) ? fallbackChain.filter((route) => normalizeRoute(route) !== undefined) : [];
	if (chain.length === 0) return { kind: "blocked", reasons: ["no fallback chain configured"] };
	const approved = options.approvedRoutes ?? poolWorkerRole() ?? APPROVED_CHEAP_WORKER_ROUTES;
	const approvedKeys = new Set(approved.map((route) => route.toLowerCase()));
	const requirements: WorkerCapabilityRequirements = {
		...(options.requiredCapabilities !== undefined ? { requiredCapabilities: options.requiredCapabilities } : {}),
		...(options.minimumContextTokens !== undefined ? { minimumContextTokens: options.minimumContextTokens } : {}),
	};
	const reasons: string[] = [];
	for (const rawRoute of chain) {
		const route = normalizeRoute(rawRoute)!;
		if (route.toLowerCase() === requested.toLowerCase()) {
			reasons.push(`route '${route}' is the requested model; a fallback must be a different route`);
			continue;
		}
		if (!approvedKeys.has(route.toLowerCase())) {
			reasons.push(`route '${route}' is not an explicitly approved cheap-worker route`);
			continue;
		}
		if (routeExclusionFor(route, "worker") !== undefined) {
			reasons.push(`route '${route}' is an excluded frontier/metered route`);
			continue;
		}
		const facts = routeFactsFor(options.routeFacts, route);
		const verdict = options.capabilityCheck !== undefined
			? options.capabilityCheck(route, requirements, facts)
			: evaluateWorkerCapabilities(route, requirements, facts);
		if (!verdict.ok) {
			reasons.push(...verdict.reasons);
			continue;
		}
		return {
			kind: "route",
			route,
			requestedModel: requested,
			reason: facts === undefined
				? "explicitly approved cheap-worker route with no declared capability minimum"
				: "explicitly approved cheap-worker route passing the declared capability minimums",
		};
	}
	reasons.push("no approved, capability-compatible fallback route remains in the chain");
	return { kind: "blocked", reasons };
}

function routeFactsFor(
	facts: Readonly<Record<string, WorkerRouteFacts>> | undefined,
	route: string,
): WorkerRouteFacts | undefined {
	if (facts === undefined) return undefined;
	for (const [key, value] of Object.entries(facts)) {
		if (key.toLowerCase() === route.toLowerCase()) return value;
	}
	return undefined;
}

// ─── Frontier/metered exclusions (resolved routes) ───────────────────────────

export type RouteExclusionClass = "frontier" | "metered";

export type RouteExclusion = {
	route: string;
	class: RouteExclusionClass;
	reason: string;
};

/**
 * Frontier routes excluded from unattended worker selection (plan §6 D4/D5:
 * "Astra and Opus are for architecture and planning, not unattended builders,
 * design lanes, verifiers or automatic fallbacks"). Matched on the RESOLVED
 * provider/model route, never on the requested friendly name.
 */
export const FRONTIER_WORKER_EXCLUDED_ROUTES: readonly string[] = [
	"native/claude-opus-5",
	"native/claude-opus-5-5",
	"openai-codex/gpt-6-astra",
];

/**
 * Metered provider prefixes excluded from unattended worker selection without a
 * separately approved per-run spend envelope (plan §6). Native `deepseek/…`
 * stays selectable because it is an explicitly enabled cheap surface with its
 * own balance reader; it still cannot become a fallback outside the pool's
 * worker role (`poolWorkerRole()`) or, without a list, the documented default
 * `APPROVED_CHEAP_WORKER_ROUTES`.
 */
export const METERED_WORKER_EXCLUDED_PREFIXES: readonly string[] = [
	"openrouter/",
	"anthropic/",
];

export type RouteExclusionOverrides = {
	frontierRoutes?: readonly string[];
	meteredPrefixes?: readonly string[];
};

/**
 * Exclusion at the resolved route for a worker scope. `scope` is named in the
 * refusal reason so the caller's factual message can say which scope was
 * refused; the default exclusion lists do not vary by scope.
 */
export function routeExclusionFor(
	resolvedRoute: string,
	scope: string,
	overrides: RouteExclusionOverrides = {},
): RouteExclusion | undefined {
	const route = normalizeRoute(resolvedRoute);
	if (route === undefined) return undefined;
	const routeKey = route.toLowerCase();
	const frontier = overrides.frontierRoutes ?? FRONTIER_WORKER_EXCLUDED_ROUTES;
	if (frontier.some((candidate) => candidate.toLowerCase() === routeKey)) {
		return {
			route,
			class: "frontier",
			reason: `resolved route '${route}' is a frontier route reserved for explicit architecture/planning, not ${scope} worker scope`,
		};
	}
	const metered = overrides.meteredPrefixes ?? METERED_WORKER_EXCLUDED_PREFIXES;
	const prefix = metered.find((candidate) => routeKey.startsWith(candidate.toLowerCase()));
	if (prefix !== undefined) {
		return {
			route,
			class: "metered",
			reason: `resolved route '${route}' is a metered surface and needs a separately approved per-run spend envelope before ${scope} worker scope may select it`,
		};
	}
	return undefined;
}

// ─── Cooldowns and admission ─────────────────────────────────────────────────

export type PoolCooldown = {
	poolKey: string;
	/** Epoch ms of the observation that triggered the cooldown. */
	observationAt: number;
	/** Epoch ms the pool becomes admissible again. */
	until: number;
	cooldownMs: number;
	/** Provider-reported reset time that extended the cooldown, when present. */
	resetAt?: number;
};

export type CooldownWindow = {
	/** Caller-overridable cooldown; defaults to DEFAULT_COOLDOWN_MS. */
	cooldownMs?: number;
	/** Provider-reported reset time (epoch ms or ISO string), used when later. */
	resetAt?: number | string;
};

const cooldowns = new Map<string, PoolCooldown>();
const observations = new Map<string, ProviderAdmissionKey>();

function requirePoolKey(poolKey: string): string {
	const normalized = typeof poolKey === "string" ? poolKey.trim() : "";
	if (normalized === "") throw new invalidInput("a non-empty poolKey is required");
	return normalized;
}

/**
 * Record an exhausted pool's cooldown. In-memory by design: a cooldown is a
 * process-local retry guard, not durable state. The window is
 * `max(observationAt + cooldownMs, resetAt)`.
 */
export function cooldownUntil(
	poolKey: string,
	observationAt: number | string,
	window: CooldownWindow = {},
): PoolCooldown {
	const key = requirePoolKey(poolKey);
	const observedAt = normalizeObservationAt(observationAt);
	const requested = window.cooldownMs ?? DEFAULT_COOLDOWN_MS;
	if (!Number.isFinite(requested) || requested <= 0) {
		throw new invalidInput(`cooldownUntil requires a positive cooldownMs, got ${String(window.cooldownMs)}`);
	}
	const cooldownMs = Math.min(MAX_COOLDOWN_MS, Math.max(1, Math.round(requested)));
	const resetAt = window.resetAt === undefined ? undefined : normalizeEpochMs(window.resetAt);
	if (window.resetAt !== undefined && resetAt === undefined) {
		throw new invalidInput(`cooldownUntil could not parse resetAt: ${String(window.resetAt)}`);
	}
	const cooldown: PoolCooldown = {
		poolKey: key,
		observationAt: observedAt,
		until: Math.max(observedAt + cooldownMs, resetAt ?? 0),
		cooldownMs,
		...(resetAt !== undefined ? { resetAt } : {}),
	};
	cooldowns.set(key, cooldown);
	return { ...cooldown };
}

export function isPoolCoolingDown(poolKey: string, at: number | string = Date.now()): boolean {
	const key = typeof poolKey === "string" ? poolKey.trim() : "";
	if (key === "") return false;
	const cooldown = cooldowns.get(key);
	if (cooldown === undefined) return false;
	return cooldown.until > normalizeObservationAt(at);
}

/** The active cooldown for one pool, or undefined when it is admissible. */
export function poolCooldown(poolKey: string, at: number | string = Date.now()): PoolCooldown | undefined {
	const key = typeof poolKey === "string" ? poolKey.trim() : "";
	if (key === "") return undefined;
	const cooldown = cooldowns.get(key);
	if (cooldown === undefined) return undefined;
	return cooldown.until > normalizeObservationAt(at) ? { ...cooldown } : undefined;
}

export type ProviderAdmissionDecision =
	| { admitted: true; key: ProviderAdmissionKey }
	| { admitted: false; reason: "cooldown"; key: ProviderAdmissionKey; cooldown: PoolCooldown };

/**
 * Pool-keyed admission for one observation. A cooling pool denies with the
 * concrete window; every other pool is admitted and its (possibly unknown)
 * quota status is recorded for `providerPolicyStatusSummary`. Reserve
 * thresholds are NOT applied here while `D4_RESERVE_PROFILE.selected` is false.
 */
export function providerRequestAdmission(
	observation: ProviderObservation,
	options: { at?: number | string } = {},
): ProviderAdmissionDecision {
	const key = providerAdmissionKey(observation);
	observations.set(key.poolKey, key);
	const at = options.at === undefined ? Date.now() : normalizeObservationAt(options.at);
	const cooldown = poolCooldown(key.poolKey, at);
	if (cooldown !== undefined) return { admitted: false, reason: "cooldown", key, cooldown };
	return { admitted: true, key };
}

// ─── Status summary ──────────────────────────────────────────────────────────

export type ProviderQuotaFreshness = "fresh" | "stale" | "unknown";

export type ProviderPoolStatus = {
	poolKey: string;
	provider: string;
	account?: string;
	quotaState: ProviderQuotaState;
	quota?: NormalizedQuotaObservation;
	quotaFreshness?: ProviderQuotaFreshness;
	quotaUnknownReason?: string;
	observationAt?: number;
	observationAgeMs?: number;
	cooldown?: { until: number; remainingMs: number; active: boolean; cooldownMs: number };
};

export type ProviderPolicyStatusSummary = {
	generatedAt: number;
	version: typeof PROVIDER_POLICY_VERSION;
	/** The §6 reserve profile is inactive until an operator selects it. */
	reservesActive: boolean;
	poolCount: number;
	pools: ProviderPoolStatus[];
};

function quotaFreshness(capturedAt: number | undefined, at: number): ProviderQuotaFreshness {
	if (capturedAt === undefined) return "unknown";
	const age = at - capturedAt;
	if (age <= FRESH_OBSERVATION_MS) return "fresh";
	if (age <= STALE_OBSERVATION_MS) return "stale";
	return "unknown";
}

/**
 * Visible pool status: every recorded observation (fresh, stale or unknown)
 * plus every cooldown, so an operator can see that an opaque pool is unknown
 * rather than zero, and that a route is cooling down.
 */
export function providerPolicyStatusSummary(options: { at?: number | string } = {}): ProviderPolicyStatusSummary {
	const at = options.at === undefined ? Date.now() : normalizeObservationAt(options.at);
	const pools: ProviderPoolStatus[] = [];
	const seen = new Set<string>();
	for (const [poolKey, key] of observations) {
		seen.add(poolKey);
		pools.push(poolStatus(poolKey, key, at));
	}
	for (const poolKey of cooldowns.keys()) {
		if (seen.has(poolKey)) continue;
		pools.push(poolStatus(poolKey, undefined, at));
	}
	pools.sort((left, right) => left.poolKey.localeCompare(right.poolKey));
	return {
		generatedAt: at,
		version: PROVIDER_POLICY_VERSION,
		reservesActive: D4_RESERVE_PROFILE.selected,
		poolCount: pools.length,
		pools,
	};
}

function poolStatus(poolKey: string, key: ProviderAdmissionKey | undefined, at: number): ProviderPoolStatus {
	const provider = key?.provider ?? poolKey.split("/")[0] ?? poolKey;
	const status: ProviderPoolStatus = {
		poolKey,
		provider,
		quotaState: key?.quotaState ?? "unknown",
	};
	if (key?.account !== undefined) status.account = key.account;
	if (key?.quota !== undefined) {
		status.quota = { ...key.quota };
		status.quotaFreshness = quotaFreshness(key.quota.capturedAt, at);
		if (key.quota.capturedAt !== undefined) {
			status.observationAt = key.quota.capturedAt;
			status.observationAgeMs = Math.max(0, at - key.quota.capturedAt);
		}
	} else {
		status.quotaFreshness = "unknown";
		status.quotaUnknownReason = key?.quotaUnknownReason ?? "no observation recorded for this pool";
	}
	const cooldown = cooldowns.get(poolKey);
	if (cooldown !== undefined) {
		status.cooldown = {
			until: cooldown.until,
			remainingMs: Math.max(0, cooldown.until - at),
			active: cooldown.until > at,
			cooldownMs: cooldown.cooldownMs,
		};
	}
	return status;
}

/** Test/reset seam for the in-memory cooldown and observation maps. */
export function resetProviderPolicyState(): void {
	cooldowns.clear();
	observations.clear();
}

// ─── §6 reserve profile (declared, INACTIVE) ─────────────────────────────────

export type ReserveThreshold = {
	provider: "openai-codex" | "zai";
	window: string;
	/** Proposed used-percent threshold; enforcement is gated on `selected`. */
	usedPercent: number;
};

export type ProviderReserveProfile = {
	id: string;
	/** False until an operator explicitly selects this profile (plan §6, §11). */
	selected: boolean;
	thresholds: readonly ReserveThreshold[];
};

/**
 * The §6 D4 numbers exactly as proposed: Codex 75% weekly / 90% current
 * short-window used, native Z.ai 90% used in an applicable reported window.
 * They are proposed daytime-reserve values, not approved limits, so the
 * profile ships `selected: false` and nothing enforces these numbers until
 * the operator selects the profile.
 */
export const D4_RESERVE_PROFILE: ProviderReserveProfile = Object.freeze<ProviderReserveProfile>({
	id: "d4-codex-75-weekly-90-short-zai-90",
	selected: false,
	thresholds: [
		{ provider: "openai-codex", window: "weekly", usedPercent: 75 },
		{ provider: "openai-codex", window: "5-hour", usedPercent: 90 },
		{ provider: "zai", window: "applicable", usedPercent: 90 },
	],
});

/**
 * The active reserve threshold for a provider/window, or undefined while the
 * profile is unselected. A configured-but-inactive threshold is deliberately
 * invisible to admission: no unapproved reserve is ever enforced.
 */
export function reserveThresholdFor(
	provider: string,
	window: string,
	profile: ProviderReserveProfile = D4_RESERVE_PROFILE,
): ReserveThreshold | undefined {
	if (!profile.selected) return undefined;
	const providerId = normalizeProviderId(provider);
	const windowKey = window.trim().toLowerCase();
	return profile.thresholds.find((threshold) =>
		threshold.provider === providerId
		&& (threshold.window === "applicable" || threshold.window.toLowerCase() === windowKey));
}

function invalidInput(message: string): ProviderPolicyError {
	return new ProviderPolicyError("io", message);
}
