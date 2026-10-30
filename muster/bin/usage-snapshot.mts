/**
 * Usage snapshot (UM1 and UM5 of
 * `plans/provider-accounts/usage-monitor-blueprint-2026-10-16.md`).
 *
 * One row per inventory entry plus every pool provider, no accounts dimension
 * (R1: both providers' terms forbid a second account). The snapshot is a
 * written fact: every run replaces the previous file in full, and a provider
 * whose reader fails (or never answers) shows its error in its own row while
 * every other provider still gets a row.
 *
 * Owners used:
 *   - `extensions/muster/provider-policy.ts` `poolKeyFor` — the canonical
 *     `observable` / `unknown` / `metered` classification. Only observable
 *     providers are read for a percentage; opaque providers carry walls and
 *     resets only, and a metered provider carries a credit `balance`, never an
 *     invented percentage.
 *   - `extensions/lib/provider-pool.ts` `loadPoolConfig` / `activeWalls` —
 *     the provider list and the live walls (errors, cooldowns, configured).
 *   - `extensions/telemetry-stats/subscriptions.ts` `loadSubscriptionPlans` —
 *     the inventory (UM4): every subscription, metered account and free-model
 *     set, its plan name and monthly USD figure, and how its usage is read.
 *     Its provider list is the snapshot's provider list (UM5), so a new
 *     account needs only its inventory entry.
 *   - `extensions/lib/provider-key.ts` `providerApiKey` — the one owner of how
 *     a provider's key is resolved. No reader reads the environment or
 *     `auth.json` itself (SK3).
 *
 * Readers (one-shot fetches so the snapshot is fresh and does not depend on a
 * background poller being up):
 *   - openai-codex                    → `fetchWhamQuota`
 *   - zai, zhipu                      → `fetchGLMQuotaOnce`
 *   - minimax                         → `fetchMiniMaxQuotaOnce` (KD2)
 *   - kimi-coding                     → `fetchKimiQuotaOnce`
 *   - opencode-go                     → `fetchOpenCodeGoQuotaOnce` (A-3: 5-hour, weekly
 *                                       and monthly, each named in `quota.windows`)
 *   - command-code                    → `fetchCommandCodeQuotaOnce` (KR8)
 *   - deepseek, openrouter, runware,
 *     kie, tavily                     → one-shot balance reads, written as
 *                                       `balance`, never as a percentage
 *   - claude-code                     → Claude's own usage endpoint (`fetchClaudeUsageOnce`, A-1),
 *                                       with UM6's `claude-code.json` read only, as its fallback
 *   - a `monitor-browser` or `browser` inventory entry (UM7, UD2) → the
 *                                       newest `meter` reading for that provider
 *                                       in the signal store (`signals.ts`, UM8),
 *                                       with its `observedAt` as the row's age
 *                                       and the reading's writer as its source
 *
 * Such a row is a meter row: `monitor-browser` is read by the monitor bot's own
 * browser on the Grok Bot box (P5-D5), `browser` by the reader on this PC
 * (VR24-201), so this script opens no browser and makes no request for either.
 * The source is the reading's writer: "monitor bot" for grokbot, "browser
 * reader" for `meter-browser`. Past 13 hours without a reading the row reads
 * "stale: no reading since <time>", never a percentage; with no reading at all
 * it reads "no reading yet". A meter row never takes its windows from a wired
 * reader, even when the repo has one for that provider; a metered meter row
 * still runs its reader for the balance (Kie, Tavily).
 *
 * Every wired reader runs concurrently (`Promise.allSettled`), each inside its
 * own time limit (`readerTimeoutMs`, 10 seconds by default), so a hung reader
 * costs its own row and the run still finishes in about the slowest reader's
 * limit — well inside the 60 seconds after which `pi-usage-snapshot.service`
 * kills the run. A row with no reader says why ("no reader", "balance not
 * read"), so no row is left with both a quota and an error empty.
 *
 * A row with neither a quota nor a balance also carries `unreadable`, the one-line reason (H52):
 * a standing cause (no key, an expired console login, an empty body), the provider's by-design
 * line, the reader's error, or the row's reason, in that order. A row with a reading carries none,
 * except the Claude row, whose API half says `Claude login expired` beside a status-line reading (A-1).
 *
 * The script never logs a key, a token or a response body. A non-2xx fetch,
 * a missing credential or an unparsable body are recorded as an `error` on the
 * row and the run continues.
 *
 * Invocation:
 *   bin/node --import node_modules/tsx/dist/loader.mjs scripts/usage-snapshot.ts [--path <file>]
 *
 * `--path` overrides the default location (`<stateDir>/usage/snapshot.json`)
 * so tests can target a temp file without touching the live state.
 *
 * Every write also appends the reading to `<stateDir>/usage/history.jsonl`
 * (beside the snapshot) and prunes the file to the last 14 days, so
 * `usage_read` can answer a 24-hour or 7-day trend without a second store
 * (HO11). The appended row carries the reading's time and each row's window
 * percentages, not the whole snapshot: 14 days of 15-minute readings stay
 * small.
 *
 * A provider in `provider-pool.json` `employerAccounts` has two accounts, and
 * gets two rows labelled `personal` and `acme-realty` (SK3, §5 step 6): the
 * personal one from its own env names, the work one from the `WORK_` copies
 * `run-as` injects. A provider whose subscription Pi holds twice lists its
 * accounts in the inventory instead (UD11): one row per account, labelled as
 * the inventory labels it, keyed by that account's env prefix, and exactly one
 * of them carrying `routed: true` — the account Pi's own key belongs to. A
 * provider with one account carries no `account` and no `routed` field.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { loadPoolConfig, activeWalls, type Wall } from "../../routing/provider-pool.ts";
import { providerApiKey, WORK_ACCOUNT, WORK_ENV_PREFIX, type ProviderKeyOptions } from "../../routing/provider-key.ts";
import { normalizeProviderId, poolKeyFor } from "../../routing/provider-policy.ts";
import { fetchWhamQuota } from "../../routing/codex-quota.ts";
import { fetchGLMQuotaOnce } from "../../routing/glm-quota.ts";
import { fetchMiniMaxQuotaOnce } from "../../routing/minimax-quota.ts";
import { fetchKimiQuotaOnce } from "../../routing/kimi-quota.ts";
import { fetchOpenCodeGoQuotaOnce } from "../../routing/opencode-go-quota.ts";
import { fetchCommandCodeQuotaOnce, commandCodeMonthlyWindow, fetchCommandCodeUsageSummaryOnce } from "../../routing/command-code-quota.ts";
import { fetchDeepSeekBalanceOnce } from "../../routing/deepseek-quota.ts";
import { fetchOpenRouterBalanceOnce } from "../../routing/openrouter-quota.ts";
import { fetchRunwareBalanceOnce } from "../../routing/runware-quota.ts";
import { fetchKieBalanceOnce } from "../../routing/kie-quota.ts";
import { fetchTavilyBalanceOnce } from "../../routing/tavily-quota.ts";
import {
	CLAUDE_LOGIN_EXPIRED,
	fetchClaudeUsageOnce,
	type ClaudeCloudAllowance,
	type ClaudeExtraUsage,
	type ClaudeUsageOutcome,
} from "../../routing/claude-usage.ts";
import { loadSubscriptionPlans, newestReceipts, receiptSignalsPath, type PlanReceipt, type SubscriptionPlan } from "../../routing/subscriptions.ts";
import { meterUnreadableReasonByHost } from "../meter-browser/last-run.ts";
import { musterStateDir } from "../../core/pi-ports.ts";
import {
	SIGNAL_ACCOUNTS,
	SIGNAL_READ_LIMIT_MAX,
	raiseSignal,
	readSignals,
	SignalStateError,
	type RaiseSignalInput,
	type RaiseSignalResult,
	type Signal,
	type SignalAccount,
	type SignalAlertPorts,
	type SignalBillingCycle,
	type SignalWindow,
} from "../signals.ts";

// ─── Path ────────────────────────────────────────────────────────────────────

/**
 * Where the snapshot lives: `<pi-agent>/state/usage/snapshot.json` by default,
 * overridable for tests via `PI_USAGE_SNAPSHOT_PATH`. The directory is created
 * on write.
 */
export function usageSnapshotPath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env["PI_USAGE_SNAPSHOT_PATH"]?.trim();
	return override && override !== "" ? resolve(override) : usageSnapshotDefaultPath();
}

/** The default snapshot path: `<pi-agent>/state/usage/snapshot.json`. */
export function usageSnapshotDefaultPath(): string {
	return join(homedir(), ".pi", "agent", "state", "usage", "snapshot.json");
}

/**
 * UM6's Claude usage file, next to the snapshot. This script only ever reads
 * it: the Claude mod writes it, and its absence means no Claude session ran.
 */
export function claudeUsagePath(override?: string): string {
	const trimmed = override?.trim();
	return trimmed !== undefined && trimmed !== "" ? resolve(trimmed) : join(dirname(usageSnapshotDefaultPath()), CLAUDE_USAGE_FILE);
}

/**
 * The append-only readings `writeUsageSnapshot` appends, beside the snapshot it
 * was given: `<stateDir>/usage/history.jsonl` by default.
 */
export function usageHistoryPath(snapshotPath: string = usageSnapshotPath()): string {
	return join(dirname(snapshotPath), USAGE_HISTORY_FILE);
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type SnapshotQuotaState = "observable" | "unknown" | "metered";

export interface SnapshotPlan {
	name: string;
	monthlyUsd: number | null;
	source: string;
	readOn: string;
}

export interface SnapshotWindow {
	usedPercent: number;
	windowMinutes: number;
	resetsAt: number;
}

/**
 * One named window a reading carried (UD4): a row keeps every provider-wide window, not only the two
 * `primary` and `secondary` slots, so a plan's monthly line is shown beside its 5-hour one.
 */
export interface SnapshotNamedWindow extends SnapshotWindow {
	name: string;
}

/**
 * The plan's extra-usage allowance in money (A-1): minor units of `currency`, never a share of the plan.
 */
export interface SnapshotExtraUsage extends ClaudeExtraUsage {}

/**
 * The cloud-session allowance in dollars with its own reset (A-1), a money meter and never a percentage of
 * the plan. `resetsAt` is epoch seconds, as every other window's is.
 */
export interface SnapshotCloudAllowance extends ClaudeCloudAllowance {}

/**
 * One window that names a model (UD4), kept out of `quota` on purpose: routing never reads
 * `modelWindows`, so a spent Sonnet week cannot exhaust Opus or the whole provider.
 */
export interface SnapshotModelWindow extends SnapshotNamedWindow {
	model: string;
}

export interface SnapshotQuota {
	source: string;
	planType: string | null;
	capturedAt: number;
	ageMs: number;
	primary: SnapshotWindow | null;
	secondary: SnapshotWindow | null;
	/** Every provider-wide window the reading carried, named, in the order it stated them (UD4). */
	windows?: SnapshotNamedWindow[];
}

/**
 * A metered account's credit balance. Kept apart from `quota` so a balance is
 * never rendered as a percentage (UM5, `provider-policy.ts`).
 */
export interface SnapshotBalance {
	amount: number;
	currency: string;
}

/** The rhythm a provider is paid on (B1): what its billing period spans. The store owns the vocabulary
 * (`SIGNAL_BILLING_CYCLES`), so a reading's `billing.cycle` and this row's `billing.cycle` are one list. */
export type BillingCycle = SignalBillingCycle;

/** Where a billing reading came from, in B2's order: the provider's API first. */
export type BillingSource = "api" | "dashboard" | "receipt" | "operator";

/**
 * One row's observed billing fact (B1, VR24-192). `plan.monthlyUsd` stays the
 * configured price and this is what a source reported; there is no second store.
 * Every field a source cannot answer is null, never a guess.
 */
export interface SnapshotBilling {
	/** The rhythm the reported period spans, or null when its span matches none this file reads. */
	cycle: BillingCycle | null;
	/** The amount the source reports for the period; the API here reports none, so the price stays `plan.monthlyUsd`. */
	amount: number | null;
	currency: string | null;
	/** The day the paid period began, YYYY-MM-DD, as `plan.readOn` is written. */
	lastChargedOn: string | null;
	/** The day the next charge falls, YYYY-MM-DD; null when the period ends with no renewal. */
	nextChargeOn: string | null;
	source: BillingSource;
	/** When the reading was taken, epoch ms, as `capturedAt` and `error.at` are. */
	observedAt: number;
}

export interface SnapshotProviderError {
	message: string;
	at: number;
}

export interface SnapshotWall {
	until: number;
	source: Wall["source"];
}

/**
 * The account a provider's row was read from: the label the inventory gives it (UD11), so a provider Pi's
 * subscription is held for twice reads as two rows, each named. Absent when the provider has one account.
 * The employer split keeps the two labels it always wrote, `personal` and `acme-realty` (SK-D5).
 */
export type SnapshotAccount = string;

export interface SnapshotProvider {
	provider: string;
	/**
	 * Which of a provider's accounts this row reads (UD11, SK3 §5 step 6): the inventory's label.
	 * Absent for a provider with one account, so a pool with no
	 * `employerAccounts` writes exactly the rows it wrote before.
	 */
	account?: SnapshotAccount;
	/**
	 * Whether Pi's router uses this row (UD11): exactly one row of a multi-account provider is routed, and a
	 * row with `routed: false` is shown and kept in history but ignored by `/routing`. Absent when the
	 * provider has one account, so every row written before this field reads back as routed.
	 */
	routed?: boolean;
	quotaState: SnapshotQuotaState;
	plan: SnapshotPlan | null;
	quota: SnapshotQuota | null;
	/** A metered account's balance; absent when the row is not a metered account. */
	balance?: SnapshotBalance;
	/**
	 * The provider's own billing dates (B1). Absent when no source has reported one, so every row a
	 * reader wrote before this field reads back exactly as it did.
	 */
	billing?: SnapshotBilling;
	/**
	 * Per-model windows a reading states (UD4), each with the model it belongs to: never in `quota`, and
	 * never read by routing. Absent on a row whose reading states none.
	 */
	modelWindows?: SnapshotModelWindow[];
	/** The plan's extra-usage allowance in money (A-1); absent when no source reported one. */
	extraUsage?: SnapshotExtraUsage;
	/** The cloud-session allowance in dollars (A-1); absent when no source reported one. */
	cloudAllowance?: SnapshotCloudAllowance;
	error: SnapshotProviderError | null;
	walls: SnapshotWall[];
	reason: string | null;
	/**
	 * Why the row has no reading, stated once: set on every row that carries neither a quota nor a
	 * balance (H52), absent on a row that carries one. `error` and `reason` keep the raw cause.
	 */
	unreadable?: string;
	readerWired: boolean;
}

export interface UsageSnapshot {
	version: 1;
	capturedAt: number;
	providers: SnapshotProvider[];
}

/** One row of an appended reading: the account and the two window percentages. */
export interface UsageHistoryProvider {
	provider: string;
	account?: SnapshotAccount;
	/** `usedPercent` of the primary window, or null when the reading carried none. */
	primary: number | null;
	secondary: number | null;
}

/** One appended reading: the snapshot's own time and each row's window percentages. */
export interface UsageHistoryRow {
	/** The snapshot's `capturedAt` (epoch ms). */
	at: number;
	providers: UsageHistoryProvider[];
}

/** The trend spans `usage_read` answers (HO11). */
export type UsageTrendWindow = "24h" | "7d";

/** One account's one window across the trend's span. */
export interface UsageTrendRow {
	provider: string;
	account?: SnapshotAccount;
	window: "primary" | "secondary";
	first: number;
	latest: number;
	peak: number;
	/** Percentage points per hour across the span, or null with a single reading. */
	ratePerHour: number | null;
	samples: number;
	/** The first and last reading's times (epoch ms). */
	from: number;
	to: number;
}

/** What one wired reader reports: a quota window set, a metered balance, or the row's billing dates. */
export interface ReaderReading {
	quota?: SnapshotQuota;
	balance?: SnapshotBalance;
	/** The row's billing dates, beside its meter (B1). A reader that reads none omits it. */
	billing?: SnapshotBilling;
}

/** One provider's one-shot fetch. `options.prefix` reads another account's copy of the key. */
export type Reader = (options?: ProviderKeyOptions) => Promise<ReaderReading | null>;

/** The per-reader time limit: a hung call costs its own row, never the run. */
export const DEFAULT_READER_TIMEOUT_MS = 10_000;

/** UM6's file name; its absence or staleness is reported, never a percentage. */
const CLAUDE_USAGE_FILE = "claude-code.json";
/** HO11's append-only readings, beside the snapshot. */
const USAGE_HISTORY_FILE = "history.jsonl";
/** How long a reading is kept in the history file. */
const HISTORY_RETENTION_MS = 14 * 24 * 60 * 60_000;
/** Past this age the Claude row reads "stale": no Claude session ran (UM5/UM6). */
const CLAUDE_STALE_MS = 45 * 60_000;

// ─── Reader map ──────────────────────────────────────────────────────────────

/** A reader's quota shape, with the counters normalized to the snapshot's own. */
type QuotaLike = {
	primary: SnapshotWindow | null;
	secondary: SnapshotWindow | null;
	planType?: string | null;
	/** The reading's named windows (UD4), when the reader states them beside the two slots. */
	windows?: SnapshotNamedWindow[];
	capturedAt: number;
	ageMs: number;
	source: string;
};

function quotaReading(value: QuotaLike | null): ReaderReading | null {
	if (value === null) return null;
	return {
		quota: {
			source: value.source,
			planType: value.planType ?? null,
			capturedAt: value.capturedAt,
			ageMs: value.ageMs,
			primary: value.primary,
			secondary: value.secondary,
			...(value.windows === undefined || value.windows.length === 0 ? {} : { windows: value.windows }),
		},
	};
}

function balanceReading(value: { balance: number; currency: string } | null): ReaderReading | null {
	if (value === null) return null;
	return { balance: { amount: value.balance, currency: value.currency } };
}

/**
 * The list of providers that have a working one-shot reader in this repo.
 * Providers outside this list carry walls, a reason or nothing — the snapshot
 * never invents a percentage. Every observable provider in `poolKeyFor` is in
 * this map: OpenCode Go is read over its usage API again (A-3, Revision 2 of
 * VR24-201, which replaces the VR18 retirement), and each metered balance
 * reader is beside its poller.
 */
const READERS: Record<string, Reader> = {
	"openai-codex": async () => quotaReading(await fetchWhamQuota()),
	"opencode-go": async (options) => quotaReading(await fetchOpenCodeGoQuotaOnce(options)),
	zai: async (options) => quotaReading(await fetchGLMQuotaOnce(options)),
	zhipu: async (options) => quotaReading(await fetchGLMQuotaOnce(options)),
	minimax: async (options) => quotaReading(await fetchMiniMaxQuotaOnce(options)),
	"kimi-coding": async (options) => quotaReading(await fetchKimiQuotaOnce(options)),
	"command-code": async (options) => commandCodeRead(options),
	deepseek: async (options) => balanceReading(await fetchDeepSeekBalanceOnce(options)),
	// OpenRouter credits are USD; its reader carries no currency field of its own.
	openrouter: async (options) => {
		const credits = await fetchOpenRouterBalanceOnce(options);
		return balanceReading(credits === null ? null : { balance: credits.balance, currency: "USD" });
	},
	runware: async (options) => balanceReading(await fetchRunwareBalanceOnce(options)),
	kie: async (options) => balanceReading(await fetchKieBalanceOnce(options)),
	tavily: async (options) => balanceReading(await fetchTavilyBalanceOnce(options)),
};

/**
 * The provider ids with a one-shot reader in this repo: the wiring, not a
 * call. `computeUsageSnapshot` takes a `readers` map so a test can exercise
 * the row contract without a live provider call.
 */
export function wiredReaderProviders(): string[] {
	return Object.keys(READERS).sort();
}

// ─── Billing dates (B1) ──────────────────────────────────────────────────────

/**
 * Command Code's subscription endpoint (probe 2026-10-16, `plans/provider-accounts/facts-2026-10-16.md`
 * section 2): `GET /alpha/billing/subscriptions` answers
 * `{success, data: {id, status, planId, currentPeriodStart, currentPeriodEnd, cancelAtPeriodEnd, ...}}`
 * with the same API key the meter read uses. It reports no amount and no currency.
 *
 * The endpoint is undocumented for third parties and sits under `/alpha/`, so a changed shape
 * degrades to null rather than to a wrong date, exactly as the credits reader does.
 */
const COMMAND_CODE_BILLING_ENDPOINT = "https://api.commandcode.ai/alpha/billing/subscriptions";

/**
 * One half of a Command Code read gets this long and no longer: two documented-ish endpoints, one
 * `/alpha/` one, must never hold the row on the other's behalf (F1, orchestrator 2026-10-26 20:42).
 */
export const COMMAND_CODE_READ_DEADLINE_MS = 5_000;

/** The day a charge date reads in, the panel's own zone (D46, `command-center-panels.ts` `PAGE_TIME_ZONE`). */
const BILLING_TIME_ZONE = "Europe/Sofia";

const DAY_MS = 24 * 60 * 60_000;
/** The spans a reported period can have and still name a rhythm: a month, a year. */
const MONTHLY_SPAN = { min: 20 * DAY_MS, max: 45 * DAY_MS };
const ANNUAL_SPAN = { min: 350 * DAY_MS, max: 380 * DAY_MS };

/** An ISO instant from a provider body, in epoch ms, or null when it is not one. */
function billingInstant(value: unknown): number | null {
	if (typeof value !== "string" || value.trim() === "") return null;
	const at = Date.parse(value);
	return Number.isFinite(at) ? at : null;
}

/**
 * One instant as the day it falls on where the operator reads it: YYYY-MM-DD in Europe/Sofia, the zone the
 * command center panel dates every other time in (D46), so the charge date is the day the panel shows
 * rather than a UTC day that can be a day earlier than his own.
 */
function billingDay(at: number): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: BILLING_TIME_ZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date(at));
}

/**
 * The instant a billing day starts where the operator reads it: the inverse of `billingDay`, the start of
 * YYYY-MM-DD in Europe/Sofia. A window whose reset is a period end the billing reader states as a day uses
 * this, so the reset is that day's own start in the same zone rather than a UTC midnight two hours away.
 */
function billingDayStart(day: string | null): number | null {
	if (day === null) return null;
	const midnightUtc = Date.parse(`${day}T00:00:00Z`);
	if (!Number.isFinite(midnightUtc)) return null;
	const offsetAt = (at: number): number => {
		const parts = new Intl.DateTimeFormat("en-CA", {
			timeZone: BILLING_TIME_ZONE,
			hour12: false,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		}).formatToParts(new Date(at));
		const field = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
		const wallAsUtc = Date.UTC(field("year"), field("month") - 1, field("day"), field("hour") % 24, field("minute"), field("second"));
		return wallAsUtc - at;
	};
	const firstGuess = midnightUtc - offsetAt(midnightUtc);
	return midnightUtc - offsetAt(firstGuess);
}

/**
 * The rhythm a paid period of this span is on, or null when the span is neither a month nor a year.
 * A null is deliberately not a guess: the row then shows the dates without a rhythm.
 */
export function billingCycleForPeriod(startMs: number, endMs: number): BillingCycle | null {
	const span = endMs - startMs;
	if (span >= MONTHLY_SPAN.min && span <= MONTHLY_SPAN.max) return "monthly";
	if (span >= ANNUAL_SPAN.min && span <= ANNUAL_SPAN.max) return "annual";
	return null;
}

/**
 * Parse one `/alpha/billing/subscriptions` body into a row's billing fact. The next charge date is
 * the period end; a subscription set to end without a renewal has none, because that date is when
 * access stops rather than a charge. Exported for the recorded-shape test.
 */
export function parseCommandCodeBilling(json: unknown, observedAt: number = Date.now()): SnapshotBilling | null {
	const data = (json as { data?: unknown } | null | undefined)?.data;
	if (data === null || typeof data !== "object") return null;
	const subscription = data as { currentPeriodStart?: unknown; currentPeriodEnd?: unknown; cancelAtPeriodEnd?: unknown };
	const end = billingInstant(subscription.currentPeriodEnd);
	if (end === null) return null;
	const start = billingInstant(subscription.currentPeriodStart);
	return {
		cycle: start === null ? null : billingCycleForPeriod(start, end),
		amount: null,
		currency: null,
		lastChargedOn: start === null ? null : billingDay(start),
		nextChargeOn: subscription.cancelAtPeriodEnd === true ? null : billingDay(end),
		source: "api",
		observedAt,
	};
}

/**
 * One billing read for the snapshot. The key comes from `providerApiKey`, the one owner of the
 * order a provider's credential is resolved in, so this adds no credential handling of its own; a
 * missing key, a non-2xx, a transport failure, an unparsable body or a request that outlives
 * `deadlineMs` all yield null and the row keeps no billing dates. Never logs the key or the body.
 */
export async function fetchCommandCodeBillingOnce(
	options: ProviderKeyOptions = {},
	deadlineMs: number = COMMAND_CODE_READ_DEADLINE_MS,
): Promise<SnapshotBilling | null> {
	const key = providerApiKey("command-code", options);
	if (!key) return null;
	try {
		// The request carries the abort signal so a hung socket is dropped, and the promise is bounded
		// the same way so a server that never answers costs this read its dates and nothing else (F1).
		const body = await withTimeout(readBillingBody(key, deadlineMs), deadlineMs);
		return parseCommandCodeBilling(body, Date.now());
	} catch {
		return null;
	}
}

async function readBillingBody(key: string, deadlineMs: number): Promise<unknown> {
	const res = await fetch(COMMAND_CODE_BILLING_ENDPOINT, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${key}`,
			"Content-Type": "application/json",
		},
		signal: AbortSignal.timeout(deadlineMs),
	});
	if (!res.ok) return null;
	return res.json();
}

/**
 * The row one Command Code read fills: its meter's reading beside its billing dates (B1). Either half
 * can be missing; a row whose meter read failed still carries its dates, and then keeps the meter
 * error `runReader` gives it. The monthly window, when the two credit readings and the period end
 * produced one (Revision 2b), is named in `quota.windows` beside the 5-hour and weekly slots and never
 * replaces either of them. Exported for the combination test.
 */
export function commandCodeReading(
	quota: QuotaLike | null,
	billing: SnapshotBilling | null,
	monthly: SnapshotWindow | null = null,
): ReaderReading | null {
	const withMonthly = quota === null || monthly === null
		? quota
		: { ...quota, windows: [...(quota.windows ?? []), { name: "monthly", ...monthly }] };
	const reading: ReaderReading = quotaReading(withMonthly ?? null) ?? {};
	if (billing !== null) reading.billing = billing;
	return reading.quota === undefined && reading.billing === undefined ? null : reading;
}

/**
 * The Command Code row's one read: its meter and its billing dates in parallel, each inside its own
 * deadline, so a hung endpoint costs its own half and never the other (F1). The monthly window's used
 * half is read in the same pass and through the same key, and its allowance comes from this read's
 * remaining credits (Revision 2b): without all three it is absent, never guessed.
 */
export async function commandCodeRead(
	options: ProviderKeyOptions = {},
	halfDeadlineMs: number = COMMAND_CODE_READ_DEADLINE_MS,
): Promise<ReaderReading | null> {
	const [quota, billing, usedMonthlyCredits] = await Promise.all([
		withTimeout(fetchCommandCodeQuotaOnce(options), halfDeadlineMs).catch(() => null),
		fetchCommandCodeBillingOnce(options, halfDeadlineMs),
		withTimeout(fetchCommandCodeUsageSummaryOnce(options), halfDeadlineMs).catch(() => null),
	]);
	const monthly = commandCodeMonthlyWindow(quota?.monthlyCredits ?? null, usedMonthlyCredits, billingDayStart(billing?.nextChargeOn ?? null));
	return commandCodeReading(quota, billing, monthly);
}

/**
 * The Claude row's reading, from UM6's file: the fallback the API read leaves in place when it fails (A-1).
 * Absent means no Claude session
 * ran; older than 45 minutes reads "stale" and carries no percentage. That rule now applies to this
 * fallback alone, because a fresh API reading replaces it. This script never writes that file.
 */
function readClaudeRow(row: SnapshotProvider, path: string, now: number): void {
	if (!existsSync(path)) {
		row.reason = "no Claude session ran";
		return;
	}
	let parsed: { capturedAt?: unknown; windows?: unknown };
	try {
		parsed = JSON.parse(readFileSync(path, "utf8")) as { capturedAt?: unknown; windows?: unknown };
	} catch {
		row.error = { message: "claude-code.json could not be read", at: now };
		return;
	}
	const capturedAt = Number(parsed?.capturedAt);
	const windows = Array.isArray(parsed?.windows) ? parsed.windows : [];
	if (!Number.isFinite(capturedAt) || windows.length === 0) {
		row.reason = "no Claude session ran";
		return;
	}
	const primary = claudeWindow(windows[0], 0);
	const secondary = windows.length > 1 ? claudeWindow(windows[1], 1) : null;
	if (primary === null && secondary === null) {
		row.reason = "no Claude session ran";
		return;
	}
	const ageMs = Math.max(0, now - capturedAt);
	if (ageMs > CLAUDE_STALE_MS) {
		row.reason = `stale: no Claude session ran in the last ${Math.round(CLAUDE_STALE_MS / 60_000)} minutes (last reading ${Math.round(ageMs / 60_000)} minutes ago)`;
		return;
	}
	row.quota = {
		source: "claude-code-session",
		planType: null,
		capturedAt,
		ageMs,
		primary,
		secondary,
	};
}

/** One window of UM6's file, mapped to the snapshot's window shape. */
function claudeWindow(raw: unknown, index: number): SnapshotWindow | null {
	if (typeof raw !== "object" || raw === null) return null;
	const window = raw as { name?: unknown; usedPercent?: unknown; resetsAt?: unknown };
	const usedPercent = Number(window.usedPercent);
	if (!Number.isFinite(usedPercent)) return null;
	const name = typeof window.name === "string" ? window.name : "";
	// UM6's file stores the reset as an ISO time; a bare number is epoch seconds or milliseconds.
	const rawReset = typeof window.resetsAt === "string" && Number.isNaN(Number(window.resetsAt)) ? Date.parse(window.resetsAt) : Number(window.resetsAt);
	const resetsAt = Number.isFinite(rawReset) ? Math.floor(rawReset > 1_000_000_000_000 ? rawReset / 1000 : rawReset) : 0;
	return {
		usedPercent: Math.max(0, Math.min(100, usedPercent)),
		windowMinutes: claudeWindowMinutes(name, index),
		resetsAt,
	};
}

/** The window length a name states, or the first/second position's default. */
function claudeWindowMinutes(name: string, index: number): number {
	const normalized = name.toLowerCase();
	if (/5\s*h|hour|short/.test(normalized)) return 300;
	if (/week|7\s*d|7-day|daily/.test(normalized)) return 10_080;
	return index === 0 ? 300 : 10_080;
}

/**
 * The Claude row's own API reading, applied beside the status-line fallback (A-1, UD10). A reading replaces
 * the fallback's quota and states the plan's per-model weeks and its two money meters; a dead Claude Code
 * login states itself and leaves the fallback's windows in place; anything else leaves the row exactly as
 * the fallback left it, so a slow endpoint or a changed shape costs the API half only.
 */
function applyClaudeUsage(row: SnapshotProvider, outcome: ClaudeUsageOutcome, now: number): void {
	if (outcome.kind === "login-expired") {
		row.error = { message: CLAUDE_LOGIN_EXPIRED, at: now };
		return;
	}
	if (outcome.kind !== "usage") return;
	const usage = outcome.usage;
	row.quota = {
		source: usage.source,
		planType: null,
		capturedAt: usage.capturedAt,
		ageMs: usage.ageMs,
		primary: usage.primary,
		secondary: usage.secondary,
	};
	// The API's reading is the row's reading, so the fallback's staleness and its file error no longer speak
	// for the row.
	row.reason = null;
	row.error = null;
	// The endpoint names the model of every week it states, so its per-model windows replace the store's
	// reading of them; the store's stand while the endpoint states none (UD4, U-0).
	if (usage.modelWindows.length > 0) {
		row.modelWindows = usage.modelWindows.map((window) => ({
			model: window.model,
			name: window.name,
			usedPercent: window.usedPercent,
			windowMinutes: window.windowMinutes,
			resetsAt: window.resetsAt,
		}));
	}
	if (usage.extraUsage !== null) row.extraUsage = usage.extraUsage;
	if (usage.cloudAllowance !== null) row.cloudAllowance = usage.cloudAllowance;
}

// ─── Meter rows (UM7, UD2) ───────────────────────────────────────────────────

/**
 * The source a `monitor-browser` row carries: the reading came from the monitor
 * bot's own browser on the Grok Bot box, not from this machine (P5-D5).
 */
export const METER_ROW_SOURCE = "monitor bot";
/**
 * The source a `browser` row carries (UD2): the reading came from the reader on this PC, which writes
 * with the `meter-browser` writer (VR24-201).
 */
export const METER_BROWSER_ROW_SOURCE = "browser reader";
/**
 * Every source a meter row can carry. The store already alerts on those readings itself, so the snapshot
 * never derives a second `usage` signal from one.
 */
export const METER_ROW_SOURCES: readonly string[] = [METER_ROW_SOURCE, METER_BROWSER_ROW_SOURCE];
/** The inventory methods whose row is filled from the signal store instead of by a reader here (UD2). */
const METER_METHODS: readonly string[] = ["monitor-browser", "browser"];

/** Whether an inventory method makes a row a meter row (UD2). */
export function isMeterMethod(method: string | undefined): boolean {
	return method !== undefined && METER_METHODS.includes(method);
}

/**
 * How fresh a browser reading must be for its per-model windows to show on a row that is not a meter row,
 * such as the Claude row (U-0, VR24-192 AR10): past this age the reading counts as unknown for routing, so
 * a per-model line taken from it would be a number nobody should act on. A meter row's own windows and
 * per-model windows keep `METER_STALE_MS`, because that row states its whole reading at that age.
 */
export const METER_MODEL_WINDOW_MS = 2 * 60 * 60_000;
/**
 * Past this age a meter row reads stale and carries no percentage (UM7's proposal): the monitor reader read
 * twice a day, so a gap past two cadences means a reading was missed. Both methods keep it (UD2, U3).
 */
export const METER_STALE_MS = 13 * 60 * 60_000;
/** What a meter row with no usable reading says. */
export const METER_NO_READING = "no reading yet";

/** The length each unit states, in minutes. */
const METER_WINDOW_UNITS: ReadonlyArray<{ unit: RegExp; minutes: number }> = [
	{ unit: /month/, minutes: 43_200 },
	{ unit: /week|wk\b|w\b/, minutes: 10_080 },
	{ unit: /day|d\b/, minutes: 1440 },
	{ unit: /hour|hr\b|h\b/, minutes: 60 },
	{ unit: /minute|min\b|m\b/, minutes: 1 },
];

/**
 * The minutes a meter window's own name states ("24h", "weekly"), or 0 when it
 * states none. A monitor bot reports the name it read, so an unstated length is
 * left as unknown rather than guessed from the window's position.
 */
function meterWindowMinutes(name: string): number {
	const normalized = name.toLowerCase();
	const stated = /(\d+(?:\.\d+)?)/.exec(normalized);
	const value = stated === null ? 1 : Number(stated[1]);
	for (const entry of METER_WINDOW_UNITS) {
		if (entry.unit.test(normalized)) return Math.round(value * entry.minutes);
	}
	return 0;
}

/** One meter window in the snapshot's shape, or null when it carries no percentage. */
function meterWindow(window: SignalWindow | undefined): SnapshotWindow | null {
	if (window === undefined) return null;
	const usedPercent = Number(window.usedPercent);
	if (!Number.isFinite(usedPercent)) return null;
	const resetsAt = Number(window.resetsAt);
	return {
		usedPercent: Math.max(0, Math.min(100, usedPercent)),
		windowMinutes: meterWindowMinutes(window.name),
		resetsAt: Number.isFinite(resetsAt) ? Math.floor(resetsAt > 1_000_000_000_000 ? resetsAt / 1000 : resetsAt) : 0,
	};
}

/**
 * The newest `meter` reading per provider, from the one signal store (UM8),
 * which owns the log's shape and its reads. Each provider is read on its own, so a
 * quiet provider's last reading is never pushed out of the read window by other
 * providers' newer readings. The newest is the reading with the latest `observedAt`,
 * so a reading that arrives late but was taken earlier never displaces a newer one.
 */
export function meterReadingsByProvider(stateDir: string, providers: readonly string[]): Map<string, Signal> {
	const newest = new Map<string, Signal>();
	for (const candidate of providers) {
		const provider = normalizeProviderId(candidate);
		const { signals } = readSignals(stateDir, { kind: "meter", provider, limit: SIGNAL_READ_LIMIT_MAX });
		for (const signal of signals) {
			const at = Date.parse(signal.observedAt);
			if (!Number.isFinite(at) || signal.provider === undefined) continue;
			const current = newest.get(provider);
			if (current === undefined || Date.parse(current.observedAt) < at) newest.set(provider, signal);
		}
	}
	return newest;
}

/** A named window as the row's own `primary`/`secondary` slot states it: the name belongs to `quota.windows`. */
function windowSlot(window: SnapshotNamedWindow): SnapshotWindow {
	return { usedPercent: window.usedPercent, windowMinutes: window.windowMinutes, resetsAt: window.resetsAt };
}

/**
 * Every window a reading carried that names no model, in the order it stated them (UD4). A window that
 * names a model is never here: it can only reach `modelWindows`.
 */
function providerWideWindows(windows: readonly SignalWindow[]): SnapshotNamedWindow[] {
	const out: SnapshotNamedWindow[] = [];
	for (const window of windows) {
		if (window.model !== undefined) continue;
		const shaped = meterWindow(window);
		if (shaped === null) continue;
		out.push({ name: window.name, ...shaped });
	}
	return out;
}

/**
 * The per-model windows a reading states, or undefined when it states none or is older than `maxAgeMs`:
 * a window with a model never enters `quota`, so this is its only way onto a row (UD4).
 */
function modelWindowsFrom(reading: Signal, now: number, maxAgeMs: number): SnapshotModelWindow[] | undefined {
	const windows = reading.windows ?? [];
	if (!windows.some((window) => window.model !== undefined)) return undefined;
	const observedAtMs = Date.parse(reading.observedAt);
	if (!Number.isFinite(observedAtMs) || now - observedAtMs > maxAgeMs) return undefined;
	const out: SnapshotModelWindow[] = [];
	for (const window of windows) {
		if (window.model === undefined) continue;
		const shaped = meterWindow(window);
		if (shaped === null) continue;
		out.push({ model: window.model, name: window.name, ...shaped });
	}
	return out.length === 0 ? undefined : out;
}

/**
 * A reading's own billing dates as the row states them (B1's `dashboard` source). Every field the page did
 * not state stays null, never a guess, exactly as a wired reader's billing read does.
 */
function billingFromReading(reading: Signal, observedAtMs: number): SnapshotBilling | undefined {
	const billing = reading.billing;
	if (billing === undefined) return undefined;
	return {
		cycle: billing.cycle ?? null,
		amount: billing.amount ?? null,
		currency: billing.currency ?? null,
		lastChargedOn: billing.lastChargedOn ?? null,
		nextChargeOn: billing.nextChargeOn ?? null,
		source: "dashboard",
		observedAt: observedAtMs,
	};
}

/**
 * The billing fact a receipt states (UB0 B-2, B1's `receipt` source): the day the provider charged and the
 * day the next charge falls, read from the receipt's own period. The amount and the currency are the
 * receipt's own; a plan's price stays what `applyReceipt` says, so a receipt in another currency never
 * reads as a USD price.
 */
export function receiptBilling(receipt: PlanReceipt, observedAt: number): SnapshotBilling {
	return {
		cycle: receiptCycle(receipt.period),
		amount: receipt.amount,
		currency: receipt.currency,
		lastChargedOn: receipt.chargedOn,
		nextChargeOn: nextChargeOnFromReceipt(receipt),
		source: "receipt",
		observedAt,
	};
}

/** The store's own rhythm for a receipt's period (UD3): a month is monthly, a year annual, one payment prepaid. */
function receiptCycle(period: PlanReceipt["period"]): BillingCycle | null {
	if (period === "month") return "monthly";
	if (period === "year") return "annual";
	if (period === "once") return "prepaid";
	return null;
}

/**
 * The day the next charge falls, from the receipt's own period: a month adds one calendar month and clamps
 * to that month's last day, a year adds twelve months, and a one-time charge gives no next date. The
 * arithmetic is on the calendar day the receipt states, so the day is the one the operator reads (D46).
 */
export function nextChargeOnFromReceipt(receipt: PlanReceipt): string | null {
	if (receipt.period === undefined || receipt.period === "once") return null;
	const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(receipt.chargedOn);
	if (parts === null) return null;
	const year = Number(parts[1]);
	const month = Number(parts[2]);
	const day = Number(parts[3]);
	const first = new Date(Date.UTC(year, month - 1 + (receipt.period === "year" ? 12 : 1), 1));
	const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
	const clamped = Math.min(day, lastDay);
	return `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, "0")}-${String(clamped).padStart(2, "0")}`;
}

/**
 * Fill one meter row from its provider's newest reading (UM7, UD2): a fresh reading fills the row with its
 * `observedAt` as the age and with the reading's writer as the source, one older than 13 hours reads stale,
 * and none reads "no reading yet". The row keeps every provider-wide window in `quota.windows` and its
 * first two in `primary` and `secondary`, puts a window that names a model in `modelWindows`, copies a
 * balance to `row.balance` and a reading's billing dates to `row.billing`, and never renders either as a
 * window. A reading whose windows carry no percentage is no reading for the row: there is nothing to show,
 * and the signal itself stays in the store.
 *
 * A row with no reading states the reason the meter browser's own last run gave for its site, while that
 * reason is fresher than a reading would be (U-1): the store holds readings only, so a login wall or a
 * changed page lives in `<stateDir>/meter-browser/last-run.json`. Past `METER_STALE_MS` the row is back
 * to "no reading yet", because a failure that old says nothing about now.
 */
function fillMeterRow(
	row: SnapshotProvider,
	reading: Signal | undefined,
	now: number,
	siteHosts: readonly string[] = [],
	stateDir?: string,
): void {
	const noReading = (): void => {
		row.reason = METER_NO_READING;
		if (stateDir === undefined || siteHosts.length === 0) return;
		const reason = meterUnreadableReasonByHost(stateDir, siteHosts, now, METER_STALE_MS);
		if (reason !== undefined) row.unreadable = reason;
	};
	const observedAtMs = reading === undefined ? Number.NaN : Date.parse(reading.observedAt);
	if (!Number.isFinite(observedAtMs)) {
		noReading();
		return;
	}
	if (now - observedAtMs > METER_STALE_MS) {
		row.reason = `stale: no reading since ${new Date(observedAtMs).toISOString()}`;
		return;
	}
	const windows = providerWideWindows(reading!.windows ?? []);
	const primary = windows[0] ?? null;
	const secondary = windows[1] ?? null;
	if (primary === null && secondary === null) {
		noReading();
		return;
	}
	row.quota = {
		source: reading!.by === "meter-browser" ? METER_BROWSER_ROW_SOURCE : METER_ROW_SOURCE,
		planType: null,
		capturedAt: observedAtMs,
		ageMs: Math.max(0, now - observedAtMs),
		primary: primary === null ? null : windowSlot(primary),
		secondary: secondary === null ? null : windowSlot(secondary),
		windows,
	};
	const modelWindows = modelWindowsFrom(reading!, now, METER_STALE_MS);
	if (modelWindows !== undefined) row.modelWindows = modelWindows;
	if (reading!.balance !== undefined) row.balance = { amount: reading!.balance.amount, currency: reading!.balance.currency };
	const billing = billingFromReading(reading!, observedAtMs);
	if (billing !== undefined) row.billing = billing;
}

// ─── Subscription lookup ─────────────────────────────────────────────────────

/**
 * The inventory for each provider, through the inventory's one loader
 * (`extensions/telemetry-stats/subscriptions.ts`), which owns the file's path
 * and its shape (UM4). A malformed file leaves the rows with no plan instead of
 * aborting the run.
 */
function loadSubscriptions(path?: string): Map<string, SubscriptionPlan> {
	try {
		return new Map(loadSubscriptionPlans(path).map((plan) => [plan.provider.toLowerCase(), plan]));
	} catch {
		return new Map();
	}
}

// ─── Compute ─────────────────────────────────────────────────────────────────

export interface ComputeOptions {
	now?: number;
	poolConfigPath?: string;
	/** The inventory file; defaults to the shipped `subscriptions.json`. */
	subscriptionsPath?: string;
	/**
	 * The readers to run, replacing the repo's own map. A test injects fakes
	 * here so no live provider call happens; an empty map leaves every row
	 * with its no-reader reason.
	 */
	readers?: Record<string, Reader>;
	/** Per-reader limit; a reader that passes it errors on its own row only. */
	readerTimeoutMs?: number;
	/** UM6's file; defaults next to the snapshot. */
	claudeUsagePath?: string;
	/**
	 * The Claude row's own API read (A-1, UD10), run beside the status-line fallback. A test injects its own
	 * so no test reaches Claude's endpoint; the default reads Claude Code's login and the endpoint once.
	 */
	claudeReader?: () => Promise<ClaudeUsageOutcome>;
	/** The Muster state dir the signal store lives under; defaults to `musterStateDir()`. */
	stateDir?: string;
}

/** One reader's result: a reading, or the error text that stands in its place. */
type ReaderOutcome =
	| { quota: SnapshotQuota | null; balance: SnapshotBalance | null; billing: SnapshotBilling | null; error: null }
	| { quota: null; balance: null; billing: null; error: string };

/** Wrap a reader in its own limit so a hung call cannot hold the run open. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolvePromise, reject) => {
		const timer = setTimeout(() => reject(new Error(`reader timed out after ${timeoutMs}ms`)), timeoutMs);
		timer.unref?.();
		promise.then(
			(value) => { clearTimeout(timer); resolvePromise(value); },
			(error: unknown) => { clearTimeout(timer); reject(error); },
		);
	});
}

/** Why a row a reader answered for still has no usage number. */
const NO_METER_READING = "reader returned no reading (missing key, non-2xx or unparsable body)";

async function runReader(reader: Reader, options: ProviderKeyOptions, timeoutMs: number): Promise<ReaderOutcome> {
	try {
		const reading = await withTimeout(reader(options), timeoutMs);
		if (reading === null) {
			return { quota: null, balance: null, billing: null, error: NO_METER_READING };
		}
		// The billing dates are the row's own observed fact (B1) and never a usage reading: a row whose
		// dates arrived but whose meter did not keeps the meter error, so `unreadable`, the signal
		// diff, the failed-row count and `muster usage`'s error line still name the missing meter (F2).
		const meterRead = reading.quota !== undefined || reading.balance !== undefined;
		if (!meterRead && reading.billing === undefined) {
			return { quota: null, balance: null, billing: null, error: NO_METER_READING };
		}
		return {
			quota: reading.quota ?? null,
			balance: reading.balance ?? null,
			billing: reading.billing ?? null,
			error: meterRead ? null : NO_METER_READING,
		};
	} catch (error) {
		return { quota: null, balance: null, billing: null, error: error instanceof Error ? error.message : String(error) };
	}
}

// ─── Unreadable rows (H52) ───────────────────────────────────────────────────

/**
 * Providers whose usage no read on this machine reaches, and why. A row that has a reading never
 * consults this table, so a reader or a monitor-bot reading that starts to work replaces the line.
 */
const UNREADABLE_BY_DESIGN: Record<string, string> = {
	google: "Google AI Studio has no usage or balance API for a key; only its dashboard shows usage, and no reader on this PC reads it (VR24-201)",
	xai: "SuperGrok usage is shown on grok.com only, and the browser reader on this PC has not read it yet (muster usage refresh --browser)",
	opencode: "OpenCode Zen free models expose no balance or quota endpoint; their per-model daily caps (reset 00:00 UTC) show as walls in the usage_read caps",
};

/** A reader error that stays true until a person acts, worded as the cause of the missing reading. */
function unreadableFromError(message: string): string | undefined {
	if (message.startsWith("no key:")) return message;
	if (/HTTP 200 from api\.kimi\.com but the body has no usage or limits/.test(message)) {
		return "api.kimi.com/coding/v1/usages answers HTTP 200 with an empty body for this key, so the plan's usage cannot be read";
	}
	return undefined;
}

/**
 * Name why a row with neither quota nor balance has no reading: a standing cause first, then the
 * provider's by-design line, then the reader's own error, then the row's reason. A row with a
 * reading carries none.
 */
function explainUnreadable(row: SnapshotProvider): void {
	// A reason the meter reader itself stated for this row wins over every standing line (U-1): the only
	// reader that knows a site wants a login is the one that met the login wall this hour.
	const cause = (row.error === null ? undefined : unreadableFromError(row.error.message))
		?? row.unreadable
		?? UNREADABLE_BY_DESIGN[normalizeProviderId(row.provider)]
		?? row.error?.message
		?? row.reason
		?? "no reader and no reason recorded";
	if (row.quota !== null || row.balance !== undefined) {
		// The Claude row is the one row whose two halves read different sources (A-1): the status line can
		// still give its two windows while Claude Code's login is dead, and the card must say so rather than
		// present the fallback as the plan's whole reading.
		if (row.error?.message === CLAUDE_LOGIN_EXPIRED) row.unreadable = CLAUDE_LOGIN_EXPIRED;
		return;
	}
	row.unreadable = cause;
}

/** Why a row that never ran a reader has no number. */
function noReaderReason(quotaState: SnapshotQuotaState, subscription: SubscriptionPlan | null): string {
	if (subscription?.kind === "metered" || quotaState === "metered") return "balance not read: no reader";
	if (quotaState === "observable") return "no reader";
	if (subscription?.usage?.method === "claude-mod") return "no reader";
	return "provider quota is not machine-observable through the current setup";
}

/**
 * The hosts a row's site can be known by (U-1): the host of the inventory's usage URL, which is the site
 * the reader reads, and the provider id as a second name. A site's own id in the meter browser's record is
 * its hostname, so this is the one join between an inventory row and that record.
 */
function meterSiteHosts(subscription: SubscriptionPlan | null, providerId: string): string[] {
	const hosts: string[] = [];
	const url = subscription?.usage?.url;
	if (url !== undefined) {
		try {
			hosts.push(new URL(url).host.toLowerCase());
		} catch {
			// An inventory URL that is not a URL names no site; the provider id still does.
		}
	}
	hosts.push(providerId.toLowerCase());
	return hosts;
}

/**
 * Build a fresh snapshot from the current pool config, the inventory and the
 * readers. Pure with respect to the filesystem: it reads `provider-pool.json`,
 * `subscriptions.json`, the provider keys and UM6's file, and returns the
 * in-memory snapshot. Callers write it to disk themselves.
 */
export async function computeUsageSnapshot(options: ComputeOptions = {}): Promise<UsageSnapshot> {
	const now = options.now ?? Date.now();
	const stateDir = options.stateDir ?? musterStateDir();
	const readers = options.readers ?? READERS;
	const readerTimeoutMs = options.readerTimeoutMs ?? DEFAULT_READER_TIMEOUT_MS;
	const pool = loadPoolConfig(options.poolConfigPath, now);
	if (!pool.ok) {
		// The pool file is broken; the snapshot still records that, with no rows.
		return { version: 1, capturedAt: now, providers: [] };
	}
	const subscriptions = loadSubscriptions(options.subscriptionsPath);

	// The list of providers is every chat role's refs plus any operator wall
	// keys (so a provider with a wall but no role chain is still recorded) plus
	// every inventory entry (UM5), so `muster usage` shows every subscription
	// and metered account, not only the ones the pool routes today.
	const providerSet = new Set<string>();
	for (const role of pool.config.roles ? Object.values(pool.config.roles) : []) {
		for (const ref of role) {
			const slash = ref.indexOf("/");
			if (slash > 0) providerSet.add(ref.slice(0, slash));
		}
	}
	for (const wallKey of Object.keys(pool.config.providerWalls)) providerSet.add(wallKey);
	for (const ref of pool.config.freeRefs) {
		const slash = ref.indexOf("/");
		if (slash > 0) providerSet.add(ref.slice(0, slash));
	}
	for (const plan of subscriptions.values()) providerSet.add(plan.provider);

	// The rows that take a reading from the store (UM7, UD2): a meter row takes its whole quota from the
	// newest `meter` reading, and a `claude-mod` row takes a per-model window from one (U-0). The store is
	// read per provider, before the rows are built, so no browser and no request runs for them here.
	const storeFed = [...providerSet]
		.filter((providerId) => {
			const method = subscriptions.get(providerId.toLowerCase())?.usage?.method;
			return isMeterMethod(method) || method === "claude-mod";
		})
		.sort();
	const meterReadings = meterReadingsByProvider(stateDir, storeFed);

	const walls = activeWalls(pool.config, undefined, now);
	const providers: SnapshotProvider[] = [];
	const jobs: Array<{ row: SnapshotProvider; reader: Reader; isMeterRow: boolean; options: ProviderKeyOptions }> = [];
	// The rows whose own API read runs beside the wired readers (A-1): a `claude-mod` row reads Claude's
	// usage endpoint, and its status-line fallback has already filled it.
	const claudeRows: SnapshotProvider[] = [];
	for (const providerId of [...providerSet].sort()) {
		const key = poolKeyFor(providerId);
		const subscription = subscriptions.get(providerId.toLowerCase()) ?? null;
		const plan: SnapshotPlan | null = subscription
			? { name: subscription.name, monthlyUsd: subscription.monthlyUsd, source: subscription.source, readOn: subscription.readOn }
			: null;
		const wall = walls[providerId];
		const wallRow: SnapshotWall | null = wall ? { until: wall.until, source: wall.source } : null;
		const reader = readers[providerId];
		const isClaudeRow = subscription?.usage?.method === "claude-mod";
		// A meter row is filled from the store instead of by a reader here (UM7, UD2): the inventory says
		// `monitor-browser` (the monitor bot's browser) or `browser` (the reader on this PC).
		const isMeterRow = isMeterMethod(subscription?.usage?.method);
		// A wired reader runs for an observable or metered row (UM5): the old
		// observable-only gate left a metered balance reader unrun. A row that
		// runs none says why, so no row is left with every field empty.
		// An inventory entry of kind metered is a metered account whatever the pool table says
		// of the provider: the pool only routes chat, and Kie and Tavily are never routed.
		const quotaState: SnapshotQuotaState = key.quotaState === "unknown" && subscription?.kind === "metered" ? "metered" : key.quotaState;
		// A meter row takes its reading from the store, so a wired reader never supplies its quota (UD2). A
		// metered meter row is the one exception: there the reader is the row's balance source (Kie, Tavily),
		// and its quota still comes from the store. An inventory that says `none` states the provider's usage
		// is read nowhere on this machine (VR24-201), so that row runs no reader even when one exists.
		const runsReader = reader !== undefined && subscription?.usage?.method !== "none" && (quotaState === "metered" || (quotaState === "observable" && !isMeterRow));
		// A split provider's two accounts are read in this one process: its own layer's
		// names unprefixed, the employer's under `WORK_` (§4 rule 4), so each account
		// gets its own row and its own key. Every other provider keeps its single row.
		// A provider whose subscription Pi holds more than once lists its accounts in the inventory (UD11):
		// each account is its own row, read with its own key, and exactly one of them is routed. A split
		// provider the inventory does not list keeps the employer pair (§4 rule 4), so nothing changes for
		// it; every other provider keeps its single row.
		const accounts: ReadonlyArray<{ account?: SnapshotAccount; prefix?: string; routed?: boolean }> =
			subscription?.accounts !== undefined
				? subscription.accounts.map((entry) => ({
					account: entry.label,
					routed: entry.routed,
					...(entry.envPrefix === undefined ? {} : { prefix: entry.envPrefix }),
				}))
				: pool.config.employerAccounts.includes(providerId)
					? [{ account: "personal", routed: true }, { account: WORK_ACCOUNT, prefix: WORK_ENV_PREFIX, routed: false }]
					: [{}];
		for (const account of accounts) {
			const row: SnapshotProvider = {
				provider: providerId,
				...(account.account === undefined ? {} : { account: account.account }),
				...(account.routed === undefined ? {} : { routed: account.routed }),
				quotaState,
				plan,
				quota: null,
				error: null,
				walls: wallRow ? [wallRow] : [],
				reason: runsReader || isClaudeRow || isMeterRow ? null : noReaderReason(quotaState, subscription),
				readerWired: reader !== undefined || isClaudeRow || isMeterRow,
			};
			if (isClaudeRow) {
				readClaudeRow(row, claudeUsagePath(options.claudeUsagePath), now);
				claudeRows.push(row);
			}
			if (isMeterRow) {
				// A `browser` row states its site's last reason from the reader's own file; a `monitor-browser`
				// row has no such file, because grokbot's monitor runs on another box (U-1).
				const siteHosts = subscription?.usage?.method === "browser" ? meterSiteHosts(subscription, providerId) : [];
				fillMeterRow(row, meterReadings.get(normalizeProviderId(providerId)), now, siteHosts, stateDir);
			}
			else if (isClaudeRow) {
				// The status-line pair stays the status line's, whatever its age; a per-model window comes from the
				// store's reading while that reading is under `METER_MODEL_WINDOW_MS` old (U-0).
				const reading = meterReadings.get(normalizeProviderId(providerId));
				const modelWindows = reading === undefined ? undefined : modelWindowsFrom(reading, now, METER_MODEL_WINDOW_MS);
				if (modelWindows !== undefined) row.modelWindows = modelWindows;
			}
			if (runsReader) jobs.push({ row, reader: reader!, isMeterRow, options: { prefix: account.prefix } });
			providers.push(row);
		}
	}

	// Every wired reader runs at once, each inside its own limit: one failing or
	// hung reader costs its own row and never stops the others or the write. The
	// Claude row's API read runs in the same pass and under the same limit (A-1).
	const claudeReader = options.claudeReader ?? fetchClaudeUsageOnce;
	const [settled, claudeOutcomes] = await Promise.all([
		Promise.allSettled(jobs.map((job) => runReader(job.reader, job.options, readerTimeoutMs))),
		Promise.all(claudeRows.map(() => withTimeout(claudeReader(), readerTimeoutMs).catch((): ClaudeUsageOutcome => ({ kind: "unavailable" })))),
	]);
	settled.forEach((result, index) => {
		const row = jobs[index]!.row;
		if (result.status !== "fulfilled") {
			row.error = { message: `reader failed: ${String(result.reason)}`, at: now };
			return;
		}
		// A row a meter reading already filled keeps it when its reader returns a balance only, and a meter
		// row never takes a quota from a reader at all (UD2): the store is its one source of windows.
		if (result.value.quota !== null && !jobs[index]!.isMeterRow) row.quota = result.value.quota;
		if (result.value.balance !== null) row.balance = result.value.balance;
		// The billing dates are the row's own observed fact (B1), so they are set from the reader
		// that read them and never stand in for a usage reading: `unreadable` still names the
		// missing meter of a row whose dates arrived and whose windows did not.
		if (result.value.billing !== null) row.billing = result.value.billing;
		if (row.quota !== null || row.balance !== undefined) row.reason = null;
		if (result.value.error !== null) row.error = { message: result.value.error, at: now };
	});
	claudeOutcomes.forEach((outcome, index) => applyClaudeUsage(claudeRows[index]!, outcome, now));
	// The receipt fold (UB0 B-2): the newest receipt per provider gives a row its billing dates when no API
	// and no dashboard read them. The order is B-1's, and it is the whole rule: api, then dashboard, then
	// receipt, then operator, so a row that already has a billing keeps it.
	const receipts = newestReceipts(receiptSignalsPath(stateDir));
	for (const row of providers) {
		if (row.billing !== undefined) continue;
		const receipt = receipts.get(row.provider.trim().toLowerCase());
		if (receipt === undefined) continue;
		row.billing = receiptBilling(receipt, now);
	}
	for (const row of providers) explainUnreadable(row);

	return { version: 1, capturedAt: now, providers };
}

// ─── I/O ─────────────────────────────────────────────────────────────────────

/**
 * Read a snapshot from disk. Returns the empty initial snapshot when the file
 * does not exist yet (first run, fresh install) so callers can render an empty
 * table instead of crashing.
 */
export function readUsageSnapshot(path: string = usageSnapshotPath()): UsageSnapshot {
	if (!existsSync(path)) return { version: 1, capturedAt: 0, providers: [] };
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<UsageSnapshot>;
		if (raw && raw.version === 1 && Array.isArray(raw.providers)) {
			return {
				version: 1,
				capturedAt: typeof raw.capturedAt === "number" ? raw.capturedAt : 0,
				providers: raw.providers,
			};
		}
	} catch { /* fall through */ }
	return { version: 1, capturedAt: 0, providers: [] };
}

/**
 * Write the snapshot atomically (write to a sibling temp file, then rename).
 * Creates the parent directory if missing.
 */
export function writeUsageSnapshot(snapshot: UsageSnapshot, path: string = usageSnapshotPath()): void {
	mkdirSync(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tempPath, JSON.stringify(snapshot, null, 2));
	renameSync(tempPath, path);
	appendUsageHistory(snapshot, usageHistoryPath(path));
}

// ─── History, trend and walls (HO11) ─────────────────────────────────────────

/**
 * The readings already on disk, oldest first. A missing file reads as no
 * readings, and a truncated or foreign line is skipped rather than failing the
 * read: one bad line must not hide the rest of the trend.
 */
export function readUsageHistory(path: string = usageHistoryPath()): UsageHistoryRow[] {
	if (!existsSync(path)) return [];
	const rows: UsageHistoryRow[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (line.trim() === "") continue;
		try {
			const parsed = JSON.parse(line) as Partial<UsageHistoryRow>;
			if (typeof parsed?.at === "number" && Number.isFinite(parsed.at) && Array.isArray(parsed.providers)) {
				rows.push({ at: parsed.at, providers: parsed.providers });
			}
		} catch { /* the bad line is dropped; the rest of the file still reads */ }
	}
	return rows;
}

/**
 * Append one reading and prune the file to the last 14 days. `writeUsageSnapshot`
 * calls this on every write, so the history needs no timer of its own. The prune
 * is relative to the newest reading's own time, and the file is replaced
 * atomically (a sibling temp file, then a rename) like the snapshot itself. One
 * writer is assumed — the oneshot unit, killed at 60 seconds — because a second
 * writer in the same moment can drop a reading.
 */
export function appendUsageHistory(snapshot: UsageSnapshot, path: string = usageHistoryPath()): void {
	if (snapshot.capturedAt <= 0) return; // a snapshot with no time is not a reading
	const kept = readUsageHistory(path).filter((row) => row.at > snapshot.capturedAt - HISTORY_RETENTION_MS);
	kept.push({
		at: snapshot.capturedAt,
		providers: snapshot.providers.map((row) => ({
			provider: row.provider,
			...(row.account === undefined ? {} : { account: row.account }),
			primary: row.quota?.primary?.usedPercent ?? null,
			secondary: row.quota?.secondary?.usedPercent ?? null,
		})),
	});
	mkdirSync(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tempPath, `${kept.map((row) => JSON.stringify(row)).join("\n")}\n`);
	renameSync(tempPath, path);
}

/** The span each trend window covers. */
const TREND_SPAN_MS: Record<UsageTrendWindow, number> = { "24h": 24 * 60 * 60_000, "7d": 7 * 24 * 60 * 60_000 };

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

function compareText(left: string, right: string): number {
	return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * First, latest and peak percentage and the rate per hour for every account and
 * window with a reading inside the trend's span. Readings outside the span are
 * ignored, so both windows answer from the one history file.
 */
export function usageTrend(trend: UsageTrendWindow, options: { historyPath?: string; now?: number } = {}): UsageTrendRow[] {
	const now = options.now ?? Date.now();
	const since = now - TREND_SPAN_MS[trend];
	const accounts = new Map<string, { provider: string; account?: SnapshotAccount; window: "primary" | "secondary"; samples: Array<{ at: number; percent: number }> }>();
	for (const row of readUsageHistory(options.historyPath ?? usageHistoryPath())) {
		if (row.at < since) continue;
		for (const reading of row.providers) {
			for (const windowName of ["primary", "secondary"] as const) {
				const percent = reading[windowName];
				if (typeof percent !== "number" || !Number.isFinite(percent)) continue;
				const key = `${reading.provider}\u0000${reading.account ?? ""}\u0000${windowName}`;
				const entry = accounts.get(key) ?? {
					provider: reading.provider,
					...(reading.account === undefined ? {} : { account: reading.account }),
					window: windowName,
					samples: [],
				};
				entry.samples.push({ at: row.at, percent });
				accounts.set(key, entry);
			}
		}
	}
	const rows: UsageTrendRow[] = [];
	for (const entry of accounts.values()) {
		const samples = [...entry.samples].sort((left, right) => left.at - right.at);
		const first = samples[0]!;
		const latest = samples[samples.length - 1]!;
		const hours = (latest.at - first.at) / 3_600_000;
		rows.push({
			provider: entry.provider,
			...(entry.account === undefined ? {} : { account: entry.account }),
			window: entry.window,
			first: round2(first.percent),
			latest: round2(latest.percent),
			peak: round2(Math.max(...samples.map((sample) => sample.percent))),
			ratePerHour: hours > 0 ? round2((latest.percent - first.percent) / hours) : null,
			samples: samples.length,
			from: first.at,
			to: latest.at,
		});
	}
	return rows.sort((left, right) => compareText(left.provider, right.provider) || compareText(left.account ?? "", right.account ?? "") || compareText(left.window, right.window));
}

/**
 * The walls in force at `now`, each phrased `capped until <time> (<source>)`,
 * keyed by what the wall caps: a provider, or a free ref's full ref, because a
 * free ref's wall is its own. The routing owner is the only reader of
 * `state/provider-walls.json`: `loadPoolConfig` merges the learned walls into
 * the pool config, and `activeWalls` is the one predicate for "in force".
 */
export function usageCaps(now: number = Date.now()): Record<string, string> {
	const pool = loadPoolConfig(undefined, now);
	if (!pool.ok) return {};
	const walls = activeWalls(pool.config, undefined, now);
	const caps: Record<string, string> = {};
	for (const key of Object.keys(walls).sort()) {
		const wall = walls[key]!;
		caps[key] = `capped until ${new Date(wall.until).toISOString()} (${wall.source})`;
	}
	return caps;
}

// ─── Usage signals (UM8) ─────────────────────────────────────────────────────

/** A reader error matching this asks for a human login rather than a retry. */
const LOGIN_NEEDED = /login|log in|unauthor|authenticat|credential|token expired/i;

/**
 * A row's account as the signal store can state it. The inventory's label is the row's and the page's name for an
 * account (UD11); the store's `account` is its own smaller vocabulary, so a label outside it travels in the signal's
 * text and never in that field, which the store would refuse.
 */
function signalAccountOf(account: SnapshotAccount | undefined): SignalAccount | undefined {
	return account !== undefined && (SIGNAL_ACCOUNTS as readonly string[]).includes(account) ? (account as SignalAccount) : undefined;
}

/** One usage signal's input, from a row and its detail. Source and writer are the snapshot's. */
function usageInput(row: SnapshotProvider, at: string, detail: string): RaiseSignalInput {
	const where = row.account === undefined ? row.provider : `${row.provider}/${row.account}`;
	const account = signalAccountOf(row.account);
	return {
		kind: "usage",
		source: "local",
		provider: row.provider,
		...(account === undefined ? {} : { account }),
		observedAt: at,
		confidence: "high",
		text: `${where}: ${detail}`,
	};
}

/**
 * One `usage` signal per state transition between two snapshot runs: a wall
 * starts or lifts, a window passes 90%, a reader starts or stops failing (or
 * needs a login). A row with no previous counterpart (the first run against no
 * file) is not a transition. Pure, so the diff is proved without a store.
 */
export function usageSignalInputs(previous: UsageSnapshot, next: UsageSnapshot, at: string): RaiseSignalInput[] {
	const inputs: RaiseSignalInput[] = [];
	for (const row of next.providers) {
		const before = previous.providers.find((candidate) => candidate.provider === row.provider && candidate.account === row.account);
		if (before === undefined) continue;
		const hadWall = before.walls.length > 0;
		const hasWall = row.walls.length > 0;
		if (!hadWall && hasWall) inputs.push(usageInput(row, at, `wall started: until ${new Date(row.walls[0]!.until).toISOString()} (${row.walls[0]!.source})`));
		if (hadWall && !hasWall) inputs.push(usageInput(row, at, "wall lifted"));
		// A meter row's percentage is a meter reading (UM7), which the
		// store itself alerts on when it crosses 95%: the snapshot never derives a
		// second signal from the bot's own reading.
		const meterFed = row.quota !== null && row.quota !== undefined && METER_ROW_SOURCES.includes(row.quota.source);
		if (!meterFed) {
			for (const windowName of ["primary", "secondary"] as const) {
				const from = before.quota?.[windowName]?.usedPercent;
				const to = row.quota?.[windowName]?.usedPercent;
				if (from !== undefined && to !== undefined && from < 90 && to >= 90) {
					inputs.push(usageInput(row, at, `${windowName} window passed 90% (${to.toFixed(1)}%)`));
				}
			}
		}
		const hadError = before.error !== null;
		const hasError = row.error !== null;
		if (!hadError && hasError) {
			const message = row.error!.message;
			inputs.push(usageInput(row, at, LOGIN_NEEDED.test(message) ? `login needed: ${message}` : `reader started failing: ${message}`));
		}
		if (hadError && !hasError) inputs.push(usageInput(row, at, "reader recovered"));
	}
	return inputs;
}

export type EmitUsageSignalsOptions = {
	/** The Muster state dir the signal store lives under. */
	stateDir: string;
	/** The transition time; defaults to now. */
	at?: string;
	/** The alert ports; absent means an alert stays undispatched. */
	ports?: SignalAlertPorts;
};

export type EmitUsageSignalsResult = {
	written: RaiseSignalResult[];
	/** One line per refused write (the daily cap), so one refusal never drops the rest. */
	refusals: string[];
};

/** Record the transitions `usageSignalInputs` found, each through the one store. */
export async function emitUsageSignals(previous: UsageSnapshot, next: UsageSnapshot, options: EmitUsageSignalsOptions): Promise<EmitUsageSignalsResult> {
	const at = options.at ?? new Date().toISOString();
	const result: EmitUsageSignalsResult = { written: [], refusals: [] };
	for (const input of usageSignalInputs(previous, next, at)) {
		try {
			result.written.push(await raiseSignal(options.stateDir, "usage-snapshot", input, options.ports));
		} catch (error) {
			if (!(error instanceof SignalStateError)) throw error;
			result.refusals.push(error.message);
		}
	}
	return result;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { path?: string } {
	const out: { path?: string } = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--path") {
			const next = argv[++index];
			if (next !== undefined) out.path = next;
			continue;
		}
		if (arg?.startsWith("--path=")) {
			out.path = arg.slice("--path=".length);
		}
	}
	return out;
}

async function main(argv: string[]): Promise<number> {
	const args = parseArgs(argv);
	const target = args.path ? resolve(args.path) : usageSnapshotPath();
	// The previous file is the baseline for the transitions: read it before the
	// new snapshot replaces it, so one run writes one signal per transition.
	const previous = readUsageSnapshot(target);
	const snapshot = await computeUsageSnapshot();
	writeUsageSnapshot(snapshot, target);
	const observable = snapshot.providers.filter((row) => row.quotaState === "observable");
	const balances = snapshot.providers.filter((row) => row.balance !== undefined);
	const failed = snapshot.providers.filter((row) => row.error !== null);
	process.stdout.write(`usage-snapshot: wrote ${snapshot.providers.length} providers (${observable.length} observable, ${balances.length} balances, ${failed.length} reader failures) to ${target}\n`);
	try {
		const emitted = await emitUsageSignals(previous, snapshot, { stateDir: musterStateDir() });
		for (const refusal of emitted.refusals) process.stderr.write(`usage-snapshot: usage signal not recorded: ${refusal}\n`);
		if (emitted.written.length > 0) {
			process.stdout.write(`usage-snapshot: recorded ${emitted.written.length} usage signal${emitted.written.length === 1 ? "" : "s"}\n`);
		}
	} catch (error) {
		process.stderr.write(`usage-snapshot: usage signals were not recorded: ${error instanceof Error ? error.message : String(error)}\n`);
	}
	return 0;
}

/** The entry the start file runs (`scripts/usage-snapshot.ts`). */
export function run(argv: string[] = process.argv.slice(2)): void {
	void main(argv)
		.then((code) => process.exit(code))
		.catch((error: unknown) => {
			process.stderr.write(`usage-snapshot: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
			process.exit(1);
		});
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
	run();
}
