/**
 * The one provider list (P3) and its failover router (U10).
 *
 * provider-pool.json is the single owner of which workhorse models serve which role and of
 * how each provider words a quota wall. This module reads it and decides, as pure functions:
 * which model a role starts on, which provider a request goes to next, and when a wall lifts.
 * It also owns the shape of the routing policy (which model serves a lane kind) and validates it;
 * nothing walks that table yet. It names no provider and no model, apart from the `opencode/`
 * provider prefix a Pi list refuses. Frontier models are not in the file and never enter here.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { classifyFailure, type QuotaShape } from "./quota-classifier.ts";
import { loadSubscriptionPlans, routerSubscriptionsPath } from "./subscriptions.ts";

export interface Wall {
	/** Epoch ms when the wall is expected to lift. */
	until: number;
	/**
	 * error: the provider named the time. cooldown: configured retry interval. config: the operator's file
	 * says so. snapshot: the usage monitor read a window of a day or more at 100 percent (blueprint 4.2, AR2).
	 */
	source: "error" | "cooldown" | "config" | "snapshot";
}

/** Router state, stored on the session branch. JSON only. */
export interface PoolState {
	walls: Record<string, Wall>;
}

/**
 * The per-harness default lane model (the operator, 2026-10-09): each harness has its own default and
 * the harnesses share no routing table. `scripts/pi-lane-launch.sh` reads this through
 * `resolveLaneModel` when it is given no `--model`; an explicit `--model` wins and is never
 * resolved or validated here.
 */
export interface LaneDefaults {
	/** Pi: ordered candidates, then the role whose chain supplies a fallback when every candidate is walled. */
	pi: { candidates: string[]; fallbackRole: string; hard?: string[] };
	/** OpenCode: ordered free-only candidates. A paid model is never a default. */
	opencode: string[];
	/** Claude: one alias, resolved by the harness itself. */
	claude: string;
}

/**
 * What a lane does (auto-routing blueprint 2026-10-25, section 2; VR24-100). The first seven kinds are
 * the methodology's flash class made machine-readable, `H1` to `H5` are its hard class, and the two
 * exception kinds are the only standing reasons for a Claude lane (VR24-91). A closed list: a new kind
 * is a recorded row and an edit here, never a free string in a brief.
 */
export type TaskKind =
	| "ui"
	| "copy"
	| "test"
	| "adapter"
	| "config"
	| "docs"
	| "research-read"
	| "retry"
	| "unknown-cause-bug"
	| "shared-owner"
	| "security-data"
	| "perf"
	| "review"
	| "product-pass";

export const TASK_KINDS: readonly TaskKind[] = [
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
];

/**
 * The methodology's class of a kind. `exception` is the blueprint's name for the two kinds a Claude
 * lane is allowed for: they are not a class of work, they are the reasons Claude is allowed at all.
 */
export type TaskKindClass = "flash" | "H1" | "H2" | "H3" | "H4" | "H5" | "exception";

export const TASK_KIND_CLASS: Record<TaskKind, TaskKindClass> = {
	ui: "flash",
	copy: "flash",
	test: "flash",
	adapter: "flash",
	config: "flash",
	docs: "flash",
	"research-read": "flash",
	retry: "H1",
	"unknown-cause-bug": "H2",
	"shared-owner": "H3",
	"security-data": "H4",
	perf: "H5",
	review: "exception",
	"product-pass": "exception",
};

export function isTaskKind(value: unknown): value is TaskKind {
	return typeof value === "string" && (TASK_KINDS as readonly string[]).includes(value);
}

/**
 * Which model serves a lane kind (auto-routing blueprint 4.4, AR5; VR24-100). The table names refs the
 * rest of the file already routes, plus the Claude alias for the two kinds a Claude lane is allowed for.
 * Nothing reads it yet: `pick` ships `off` and the pick lands in AR6.
 */
export interface PoolRouting {
	/** `off`: nothing reads the table. `shadow`: a pick runs beside the orchestrator's placement. `on`: the table places the lane. */
	pick: "off" | "shadow" | "on";
	/**
	 * AR16: the account failover. `off` (the shipped posture): a lane that meets a quota wall records the
	 * intended move to the other account of its plan and keeps the ref chain it had. `on`: the lane moves to
	 * that account. The file is the operator's, so the flip is his; the tick reads this and nothing else.
	 */
	accountFailover?: "off" | "on";
	/** How many worker lanes run at once (VR24-91: seven, the free slots fill with Pi lanes). */
	slots: number;
	/** Claude lanes allowed at once (VR24-91: two). */
	claudeMax: number;
	/** Hard lanes allowed at once (VR24-91: two). */
	hardMax: number;
	/**
	 * Refs the operator paused for lanes. His word, not a clock: the list is emptied when he lifts it. A pause is for
	 * lanes only and has no end, so it is not a `providerWalls` wall, whose clock would also pause delegates,
	 * review and memory (VR24-113). The shipped file carries no pause: the operator lifted the Grok one, because
	 * VR24-207 runs the Fix-gate review on it (VR24-209 S3).
	 */
	paused: string[];
	/** Kind -> ordered preference. Every kind of `TASK_KINDS` has a non-empty list. */
	policy: Record<TaskKind, string[]>;
	/** Project -> kind -> the path patterns a brief's owned paths are classified by (AR4's data). */
	kindRules: Record<string, Partial<Record<TaskKind, string[]>>>;
}

export interface PoolConfig {
	version: 1;
	virtualProvider: string;
	cooldownMs: number;
	resetHorizonMs: number;
	/** Operator walls (a `config` wall) and the learned ones merged in by `loadPoolConfig`, which keep their source. */
	providerWalls: Record<string, { until: number; reason?: string; source?: Wall["source"] }>;
	roles: Record<string, string[]>;
	/**
	 * Free models. Each is a ref of a chat role. A free ref's wall is its own (keyed by the full ref), so a provider's wall
	 * never blocks it and a quota error on it walls only that ref. It may share a provider with a paid ref or another free ref.
	 */
	freeRefs: string[];
	/**
	 * Providers whose work runs on a second (Acme Realty) account (SK-D5). An employer's process reads
	 * its own account's key and every other process reads the personal one; empty until the work keys
	 * exist. A process's employer is `PI_EMPLOYER`, which `run-as` sets (`provider-key.ts` `accountFor`).
	 */
	employerAccounts: string[];
	/** Roles whose refs are not chat models (a classifier). They are loaded and readable, but never routed, started or failed over. */
	nonChatRoles: string[];
	/** The per-harness lane default models. Absent in a file written before 2026-10-09. */
	laneDefaults?: LaneDefaults;
	/** Spending ceilings (VR24-39, D18). The classifier owner enforces `classifier.usdPerMonth`. Absent means no ceiling. */
	ceilings?: PoolCeilings;
	/** The routing policy (blueprint 4.4, AR5). Absent in a file written before 2026-10-25, and dropped when the section is refused. */
	routing?: PoolRouting;
	quotaShapes: QuotaShape[];
}

export interface PoolCeilings {
	/** The desk's classifier spend, VR24-39. */
	classifier?: { usdPerMonth: number };
	/** The router's own bucket, VR24-204: Jev's routing calls never spend the desk's ceiling. */
	routing?: { usdPerMonth: number };
}

/**
 * A parse result. `warnings` names a section that was dropped and the file still loaded: only a section
 * nothing depends on may be refused that way, and `routing` is the one (`pick` off, nothing reads it yet).
 */
export type PoolConfigResult = { ok: true; config: PoolConfig; warnings?: string[] } | { ok: false; errors: string[] };

export function poolConfigPath(): string {
	return process.env.PI_PROVIDER_POOL_PATH ?? join(homedir(), ".pi", "agent", "provider-pool.json");
}

/** Learned runtime walls. state/ is gitignored; the tracked pool file is never written. */
export function learnedWallsPath(): string {
	return process.env.PI_PROVIDER_WALLS_PATH ?? join(homedir(), ".pi", "agent", "state", "provider-walls.json");
}

/** `provider/model`: the provider is everything before the first slash. */
export function providerOf(ref: string): string {
	const slash = ref.indexOf("/");
	return slash < 0 ? ref : ref.slice(0, slash);
}

/**
 * The employer label of a split provider's second account (SK-D5). `provider-key.ts`'s
 * `WORK_ACCOUNT` owns this label for key reads; the pool repeats it only to key a wall per
 * account, and imports nothing from that module so this one stays free of Pi APIs.
 */
const WORK_EMPLOYER = "acme-realty";

/**
 * The account a wall in this process belongs to (AR14 design 3): an explicit placement's account, else
 * `PI_ACCOUNT` (`run-as` exports it beside the key names it maps), else the employer `PI_EMPLOYER`. A process
 * with neither works on no named account and keeps today's bare keys.
 */
function wallAccount(account: string | undefined): string | undefined {
	const explicit = account?.trim();
	if (explicit !== undefined && explicit !== "") return explicit;
	const placed = process.env.PI_ACCOUNT?.trim();
	if (placed !== undefined && placed !== "") return placed;
	return process.env.PI_EMPLOYER === WORK_EMPLOYER ? WORK_EMPLOYER : undefined;
}

/** One account of a plan Pi holds more than once, as the inventory names it (A-2, UD11). */
export interface PlanAccountRef {
	/** What the row, the page and a placement call this account; unique within the plan. */
	label: string;
	/** Env-name prefix of this account's key copies, such as `ACCT2_`; absent for the account Pi's own order reads. */
	envPrefix?: string;
	/** True for the one account the pool's own key belongs to. */
	routed: boolean;
}

/**
 * The accounts the inventory lists for a provider (A-2/UD11, the one owner of the labels), or an empty list for
 * a plan held once, for a provider the inventory does not name, and for a file that cannot be read: a broken
 * inventory leaves the one-account-per-provider behaviour every reader had before AR14.
 */
export function providerAccounts(provider: string): readonly PlanAccountRef[] {
	try {
		const plan = loadSubscriptionPlans(routerSubscriptionsPath(), { noReceipts: true }).find((entry) => entry.provider === provider);
		if (plan?.accounts === undefined) return [];
		return plan.accounts.map((account) => ({
			label: account.label,
			...(account.envPrefix === undefined ? {} : { envPrefix: account.envPrefix }),
			routed: account.routed,
		}));
	} catch {
		return [];
	}
}

/**
 * `key` scoped to the account this process works on (SK4, SK-D7, AR14 design 3): in a process on the second
 * account a split provider's wall key carries `@<account>`, so one account's wall never blocks the other. The
 * account is the explicit argument, else `PI_ACCOUNT`, else the employer `PI_EMPLOYER`: an employer account keeps
 * its `employerAccounts` gate, and an inventory account appends only for a provider whose plan lists it, so a
 * provider the account does not serve keeps its bare key. A personal process is unchanged.
 */
export function accountWallKey(config: Pick<PoolConfig, "employerAccounts">, key: string, account: string | undefined = undefined): string {
	const who = wallAccount(account);
	if (who === undefined) return key;
	const provider = providerOf(key);
	if (who === WORK_EMPLOYER) return config.employerAccounts.includes(provider) ? `${key}@${who}` : key;
	return providerAccounts(provider).some((entry) => entry.label === who) ? `${key}@${who}` : key;
}

/**
 * The key a ref's quota wall is stored under: its provider, except a free ref, which walls alone.
 * A paid provider wall and a free ref's wall cannot meet, because the key of a free ref holds a slash.
 * A split provider's wall is per account (`accountWallKey`), so its paid refs and its own free refs
 * each carry the account; a personal process keeps today's bare key, so the walls file stays valid.
 */
export function wallKey(config: Pick<PoolConfig, "freeRefs" | "employerAccounts">, ref: string, account: string | undefined = undefined): string {
	return accountWallKey(config, config.freeRefs.includes(ref) ? ref : providerOf(ref), account);
}

/**
 * The account a lane on `ref` actually reads its key from (AR14 design 5): `PI_ACCOUNT` when this process was
 * placed on an account, else the plan's routed account, else nothing. It is the second half of the comparison
 * the decision line carries, beside the account the rule would pick.
 */
export function laneAccountFor(ref: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const placed = env.PI_ACCOUNT?.trim();
	if (placed !== undefined && placed !== "") return placed;
	return providerAccounts(providerOf(ref)).find((account) => account.routed)?.label;
}

/**
 * The account-scoped pool key a free ref's cooldown is recorded under, or undefined when `ref` is not
 * a free ref of the one list. A free ref carries its model on every provider — the same free-ref rule
 * `wallKey` applies to its quota wall — so its cooldown never meets its provider's account-scoped key
 * or a paid sibling's; a paid ref keeps that account-scoped key. The list is read per call, it being
 * the one owner of freeRefs; a missing or invalid list yields undefined.
 */
export function freeRefPoolKey(ref: string, accountKey: string): string | undefined {
	const loaded = loadPoolConfig();
	if (!loaded.ok || !loaded.config.freeRefs.includes(ref)) return undefined;
	return `${providerOf(ref)}/${accountKey}/${ref.slice(ref.indexOf("/") + 1)}`;
}

// ─── Ranking, the usage snapshot and the decisions log (P5-D1 O1, UM10) ──────
//
// ONE rule for every lane start, delegate placement and mid-run failover. It only
// reorders the candidates their owner set: a walled ref is skipped as before, a paid
// ref whose provider shows no headroom comes first, a paid ref at or over the
// threshold moves behind the other paid refs, and free refs stay after every paid
// ref. Nothing here reaches the network: the usage snapshot is the file UM5 writes,
// and a missing or stale file leaves the order alone.

/** The share of any window at or above which a paid ref moves behind the other paid refs (proposal). */
export const PAID_HEADROOM_PERCENT = 95;
/** How old the UM5 snapshot may be for the headroom step to apply (proposal). */
export const SNAPSHOT_FRESH_MS = 30 * 60_000;

/** The lengths the plans have (blueprint G6): a 5-hour, a weekly and a 30-day window. */
export const NOMINAL_WINDOW_MINUTES = [300, 10_080, 43_200] as const;
/** A window of a day or more that is spent keeps a provider out until it resets; a 5-hour one refills within hours. */
export const SPENT_WINDOW_MINUTES = 1_440;
/** The window a refilling plan's allowance opens again: the 5-hour cap VR24-202 names (MiniMax's plan). */
export const REFILL_WINDOW_MINUTES = NOMINAL_WINDOW_MINUTES[0];

/** One window of a usage row, as the router sees it. */
export interface RoutingUsageWindow {
	usedPercent: number;
	/** The length the monitor reports. It is the plan's own only when it is one of `NOMINAL_WINDOW_MINUTES`. */
	windowMinutes: number;
	/** Epoch ms when the window refills. The file writes seconds; the reader converts to this module's unit. */
	resetsAt: number;
}

/** The one row a routing decision needs from the UM5 snapshot. */
export interface RoutingUsageRow {
	provider: string;
	/**
	 * Whether Pi's router uses this row (UD11): a provider whose subscription Pi holds twice writes one row per
	 * account, and only the account the pool's own key belongs to is routed. Absent means routed, so every
	 * snapshot written before this field and every hand-built row reads exactly as before; a row the snapshot
	 * marks `routed: false` is dropped from `rows` and kept in `accounts` when it names an account.
	 */
	routed?: boolean;
	/**
	 * The account of a provider whose plan Pi holds more than once (UD11, AR14): the inventory's own label, the
	 * one `recordSnapshotWalls` keys a wall by and a placement names. Absent for a plan held once.
	 */
	account?: string;
	/** Every window the row reports, with its length and its reset, so a weekly window is told from a 5-hour one. */
	windows: RoutingUsageWindow[];
	/**
	 * `unknown`: the monitor says it could not read this provider and the row carries no window, so the
	 * router has no reading (P5-D4: never room, never exhausted). `read`: anything else, including a
	 * metered row whose reading is a balance rather than a window.
	 */
	meter: "read" | "unknown";
	/** Every window the row reports, as the percentage used: the derived list every earlier reader keeps using. */
	usedPercent: number[];
}

/** One window object of the snapshot file, before it is checked. */
interface RawUsageWindow {
	usedPercent?: unknown;
	windowMinutes?: unknown;
	resetsAt?: unknown;
}

/**
 * The one epoch-seconds to epoch-ms conversion (UB0 UD4). The monitor writes `resetsAt` in seconds; this
 * module's times are ms, as `Wall.until` and every `now`. Exported because the usage panel reads the same
 * rows (CRH F4): one conversion, one owner, instead of a copy per reader.
 */
export function resetsAtMs(value: number): number {
	return value < 1e11 ? value * 1000 : value;
}

/** One window of a row, or undefined when the monitor did not report all three numbers it takes. */
function readUsageWindow(raw: RawUsageWindow): RoutingUsageWindow | undefined {
	const { usedPercent, windowMinutes, resetsAt } = raw;
	if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return undefined;
	if (typeof windowMinutes !== "number" || !Number.isFinite(windowMinutes)) return undefined;
	if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return undefined;
	return { usedPercent, windowMinutes, resetsAt: resetsAtMs(resetsAt) };
}

/** The windows of a day or more that are spent, the latest reset first. A 5-hour window at 100 percent is over the line, not spent. */
function spentWindows(row: RoutingUsageRow, now: number): RoutingUsageWindow[] {
	return row.windows
		.filter((window) => window.windowMinutes >= SPENT_WINDOW_MINUTES && window.usedPercent >= 100 && window.resetsAt > now)
		.sort((left, right) => right.resetsAt - left.resetsAt);
}

/**
 * The window `exhaustedUntil` reads, and the one the reason line names: the latest reset of a window of a day
 * or more at 100 percent. `spentWindows` stays the only rule for which windows count. Pure (AR2).
 */
export function exhaustedWindow(row: RoutingUsageRow, now: number): RoutingUsageWindow | undefined {
	return spentWindows(row, now)[0];
}

/**
 * When a provider is spent: the latest reset (epoch ms) of any window of a day or more at 100 percent
 * whose reset is still ahead, else undefined. Pure (blueprint 4.2, AR2).
 */
export function exhaustedUntil(row: RoutingUsageRow, now: number): number | undefined {
	return exhaustedWindow(row, now)?.resetsAt;
}

/**
 * The window's own length as the exclusion reason names it (AR3F): 43 200 minutes is `30-day`, 10 080 is
 * `7-day`, 1 440 is `1-day`. One rule, taken from the length field itself, never from the plan's name.
 */
function windowSpanLabel(windowMinutes: number): string {
	return `${Math.max(1, Math.round(windowMinutes / 1_440))}-day`;
}

/**
 * The reading projected to the end of its window at the current burn, or undefined when the router has
 * no pace to compute it from: a length the plans do not have (G6: z.ai reports 272 and 8519 minutes),
 * a window that has not started, and one that has already reset. Nothing ranks on it yet (AR3, AR6).
 */
export function windowPace(window: RoutingUsageWindow, now: number): number | undefined {
	if (!(NOMINAL_WINDOW_MINUTES as readonly number[]).includes(window.windowMinutes)) return undefined;
	const spanMs = window.windowMinutes * 60_000;
	const elapsed = now - (window.resetsAt - spanMs);
	if (elapsed <= 0 || elapsed > spanMs) return undefined;
	return (window.usedPercent * spanMs) / elapsed;
}

export interface RoutingSnapshot {
	capturedAt: number;
	rows: RoutingUsageRow[];
	/**
	 * One row per account of a plan Pi holds more than once, the routed account's row among them (AR14 design 1).
	 * `rows` keeps one row per provider, so every reader written before AR14 reads what it read; a placement that
	 * ranks accounts reads this list, and its absence (a file written before A-2, a hand-built fixture) leaves the
	 * one-account-per-provider ranking untouched.
	 */
	accounts?: RoutingUsageRow[];
}

/** The UM5 snapshot file, overridable for tests exactly as the pool and walls are. */
export function routingSnapshotPath(): string {
	return process.env.PI_USAGE_SNAPSHOT_PATH ?? join(homedir(), ".pi", "agent", "state", "usage", "snapshot.json");
}

/** Read the snapshot as a file. A missing, torn or unrecognized file is no snapshot, never a guess. */
export function readRoutingSnapshot(path: string = routingSnapshotPath()): RoutingSnapshot | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { capturedAt?: unknown; providers?: unknown };
		if (typeof parsed?.capturedAt !== "number" || !Number.isFinite(parsed.capturedAt)) return undefined;
		if (!Array.isArray(parsed.providers)) return undefined;
		const rows: RoutingUsageRow[] = [];
		const accounts: RoutingUsageRow[] = [];
		for (const raw of parsed.providers) {
			const row = raw as {
				provider?: unknown;
				routed?: unknown;
				account?: unknown;
				unreadable?: unknown;
				quota?: { primary?: RawUsageWindow | null; secondary?: RawUsageWindow | null } | null;
			};
			if (typeof row?.provider !== "string") continue;
			const account = typeof row.account === "string" && row.account.trim() !== "" ? row.account.trim() : undefined;
			const reported = [row.quota?.primary, row.quota?.secondary].filter(
				(window): window is RawUsageWindow => window !== null && typeof window === "object",
			);
			const usedPercent = reported
				.map((window) => window.usedPercent)
				.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
			const windows = reported.map(readUsageWindow).filter((window): window is RoutingUsageWindow => window !== undefined);
			// Unknown is a state, not a zero (P5-D4): only the monitor's own `unreadable` reason, on a row it
			// could report no window for, makes the meter unknown. A metered row reads as a balance, not a window.
			const unreadable = typeof row.unreadable === "string" && row.unreadable.trim() !== "";
			const parsedRow: RoutingUsageRow = { provider: row.provider, windows, meter: unreadable && windows.length === 0 ? "unknown" : "read", usedPercent };
			// One account of a multi-account provider is shown and kept in history; AR14 gives it a wall of its own.
			if (account !== undefined) accounts.push({ ...parsedRow, account, routed: row.routed !== false });
			// One row per provider for every reader written before AR14: the routed account, exactly as before.
			if (row.routed === false) continue;
			rows.push(parsedRow);
		}
		return accounts.length === 0 ? { capturedAt: parsed.capturedAt, rows } : { capturedAt: parsed.capturedAt, rows, accounts };
	} catch {
		return undefined;
	}
}

/** Whether a snapshot is fresh enough to decide on: not from the future, and not older than `SNAPSHOT_FRESH_MS`. */
export function snapshotIsFresh(snapshot: RoutingSnapshot, now: number): boolean {
	return snapshot.capturedAt <= now && now - snapshot.capturedAt <= SNAPSHOT_FRESH_MS;
}

/** The snapshot only while it is fresh enough to decide on; else undefined, and the order is unchanged. */
export function freshRoutingSnapshot(now: number, path: string = routingSnapshotPath()): RoutingSnapshot | undefined {
	const snapshot = readRoutingSnapshot(path);
	if (snapshot === undefined || !snapshotIsFresh(snapshot, now)) return undefined;
	return snapshot;
}

/** Whether a provider's row is at or over the headroom threshold in any window. */
export function providerAtHeadroom(snapshot: RoutingSnapshot, provider: string): boolean {
	const row = snapshot.rows.find((candidate) => candidate.provider === provider && candidate.routed !== false);
	return row !== undefined && row.usedPercent.some((used) => used >= PAID_HEADROOM_PERCENT);
}

export type RouteVerdict =
	| "chosen"
	| "open"
	| "over-threshold"
	| "free"
	| "walled"
	| "unavailable"
	| "unconfigured"
	| "excluded"
	| "unknown-meter";

/**
 * One candidate a ranking reads: a ref, and — for a provider whose inventory plan lists accounts — the account of
 * it (AR14 design 1, VR24-206). A bare string reads exactly as it did before this type existed, so every caller
 * that ranks refs alone keeps its order and its reasons.
 */
export interface RouteCandidate {
	ref: string;
	/** The inventory's own label for one account of the provider; absent reads the provider's routed row. */
	account?: string;
}

/** The snapshot row a candidate reads: its own account's row, else the provider's routed row (AR14). */
function candidateRow(snapshot: RoutingSnapshot | undefined, candidate: RouteCandidate): RoutingUsageRow | undefined {
	if (snapshot === undefined) return undefined;
	const provider = providerOf(candidate.ref);
	if (candidate.account === undefined) return snapshot.rows.find((row) => row.provider === provider && row.routed !== false);
	return snapshot.accounts?.find((row) => row.provider === provider && row.account === candidate.account);
}

/** A candidate as the ranking holds it: a ref alone, or a ref with the account it is one candidate of. */
function asCandidate(candidate: string | RouteCandidate): RouteCandidate {
	return typeof candidate === "string" ? { ref: candidate } : candidate;
}

/**
 * The wall one candidate meets (AR14 send-back F1): its own account's key first, then the provider-level key a process
 * without a placement writes — `command-code`, or a free ref's full name. A bare provider wall therefore stops every
 * account of that provider, and a wall under one account's key stops only that account.
 */
export function wallForCandidate(config: Pick<PoolConfig, "freeRefs" | "employerAccounts">, walls: Record<string, Wall>, candidate: string | RouteCandidate): Wall | undefined {
	const entry = asCandidate(candidate);
	const own = walls[entry.account === undefined ? wallKey(config, entry.ref) : accountWallKey(config, config.freeRefs.includes(entry.ref) ? entry.ref : providerOf(entry.ref), entry.account)];
	if (own !== undefined || entry.account === undefined) return own;
	return walls[config.freeRefs.includes(entry.ref) ? entry.ref : providerOf(entry.ref)];
}

/** A provider as a reason names it: `command-code`, or `command-code (second account)` when it means one account. */
function accounted(provider: string, account: string | undefined): string {
	return account === undefined ? provider : `${provider} (${account})`;
}

export interface RankedRoute {
	ref: string;
	/** The account this candidate is one of, when its provider's plan lists accounts (AR14, VR24-206). */
	account?: string;
	verdict: RouteVerdict;
	/** Why the ref sits where it sits: the line the decisions log carries. */
	reason: string;
	/**
	 * For `excluded`: epoch ms when the spent window resets, so a caller with nothing else open can still go
	 * out on the earliest return instead of answering nothing (blueprint 8.1). Absent on every other verdict.
	 */
	until?: number;
}

export interface RankLaneRoutesInput {
	config: PoolConfig;
	/** The candidates in the order their owner set them: a ref, or a ref with one account of a multi-account plan. */
	candidates: readonly (string | RouteCandidate)[];
	walls: Record<string, Wall>;
	/** Whether a ref names a model that exists and has credentials. `account` is the candidate's account, when it has one. */
	available: (ref: string, account?: string) => boolean;
	/**
	 * Whether the candidate's provider key is present in the lane's would-be environment (VR24-213), tested by name
	 * only. Absent leaves the check out, exactly as before AR14; a candidate it refuses is skipped as `unconfigured`.
	 */
	configured?: (ref: string, account?: string) => boolean;
	/** The snapshot while it is fresh. Undefined leaves the headroom step out. */
	snapshot?: RoutingSnapshot;
	/** Running lanes per provider, for the spread step; absent counts as none. `account` is the candidate's account. */
	runningLanes?: (provider: string, account?: string) => number;
	/** A role chain puts free refs after every paid one (today's rule). The Pi lane default list keeps the operator's own order. */
	freeRefsLast?: boolean;
	/**
	 * The moment the ranking is made at. An exclusion lifts at its window's reset by itself (blueprint 2), so
	 * the ranking needs the current time; omitting it reads the wall clock. Every caller has a `now` already.
	 */
	now?: number;
}

/**
 * Rank one set of candidates by the one routing rule. Only usable refs are ranked;
 * a walled or unavailable ref keeps its place at the end, so a caller can still see it
 * and, when nothing is open, go out on the wall that lifts first.
 *
 * The tiers (AR3, blueprint 4.4 step 2): a readable window under the headroom first, then an unread meter,
 * then a provider over the line. A provider whose window of a day or more is spent (`excluded`) returns only
 * when that window resets, and it is never `chosen`; a ref walled by the usage monitor's own reading is
 * reported as the exclusion it is.
 */
export function rankLaneRoutes(input: RankLaneRoutesInput): RankedRoute[] {
	const { config, walls, available } = input;
	const freeRefsLast = input.freeRefsLast ?? true;
	const snapshot = input.snapshot;
	const now = input.now ?? Date.now();
	// A candidate's wall is its own account's key, then the provider-level key a process without a placement writes
	// (`wallForCandidate`, F1): one lookup, so a bare provider wall and a per-account wall can never disagree.
	/**
	 * The exclusion a spent window of a day or more puts on a paid ref: the reset `exhaustedUntil` names,
	 * with the line the decisions log carries (blueprint 2, G2, AR3), named by the window's own length
	 * (AR3F). A 5-hour window at 100 percent is over the line, not an exclusion, and a reset already behind
	 * us excludes nothing. A free ref is never excluded by its provider's paid window: it has a wall of its
	 * own keyed by the full ref, and it keeps the `free` verdict (AR3 impact map, "A free ref").
	 */
	const exclusionFor = (entry: RouteCandidate): { until: number; reason: string } | undefined => {
		if (config.freeRefs.includes(entry.ref)) return undefined;
		const row = candidateRow(snapshot, entry);
		const spent = row === undefined ? undefined : exhaustedWindow(row, now);
		return spent === undefined
			? undefined
			: { until: spent.resetsAt, reason: `excluded: ${windowSpanLabel(spent.windowMinutes)} window 100 percent, resets ${new Date(spent.resetsAt).toISOString()}` };
	};
	const running = (entry: RouteCandidate) => input.runningLanes?.(providerOf(entry.ref), entry.account) ?? 0;
	// Fewest running lanes first among equal candidates; the owner's own order breaks a tie.
	const spread = (entries: RankedRoute[], verdict: RouteVerdict): RankedRoute[] =>
		entries
			.map((entry, index) => ({ entry, index }))
			.sort((left, right) => running(left.entry) - running(right.entry) || left.index - right.index)
			.map(({ entry }) => ({ ...entry, verdict }));

	const usable: RankedRoute[] = [];
	const excluded: RankedRoute[] = [];
	const walled: RankedRoute[] = [];
	const unavailable: RankedRoute[] = [];
	const unconfigured: RankedRoute[] = [];
	for (const inputCandidate of input.candidates) {
		const candidate = asCandidate(inputCandidate);
		const ref = candidate.ref;
		const entry: RankedRoute = { ...candidate, verdict: "open", reason: "usable" };
		const wall = wallForCandidate(config, walls, candidate);
		// A wall the usage monitor wrote is the spent window itself (AR2), not a request wall: it is
		// reported as the exclusion it is, with the reset the row carries. An error, cooldown or operator
		// wall that holds instead keeps its own reading and wins.
		const exclusion = wall === undefined || wall.source === "snapshot" ? exclusionFor(candidate) : undefined;
		if (exclusion !== undefined) excluded.push({ ...entry, verdict: "excluded", reason: exclusion.reason, until: exclusion.until });
		else if (wall) walled.push({ ...entry, verdict: "walled", reason: `walled until ${new Date(wall.until).toISOString()} (${wall.source})` });
		// VR24-213: a provider whose key name is absent from the lane's environment is never started, and the next
		// candidate is tried. The account's own prefixed name is the one tested when the candidate names an account.
		else if (input.configured !== undefined && !input.configured(ref, candidate.account)) {
			unconfigured.push({ ...entry, verdict: "unconfigured", reason: `unconfigured: no key for ${accounted(providerOf(ref), candidate.account)}` });
		} else if (!available(ref, candidate.account)) unavailable.push({ ...entry, verdict: "unavailable", reason: "no model with credentials" });
		else usable.push(entry);
	}

	const isFree = (entry: RankedRoute) => config.freeRefs.includes(entry.ref);
	const over = (entry: RankedRoute) => {
		const row = candidateRow(snapshot, entry);
		return row !== undefined && row.usedPercent.some((used) => used >= PAID_HEADROOM_PERCENT);
	};
	// Unknown is a state, not a zero (P5-D4, G4): the monitor said it could not read this provider, so the
	// router has no reading — never room, never spent. It ranks after every readable open window and before
	// a provider over the line.
	const unread = (entry: RankedRoute) => candidateRow(snapshot, entry)?.meter === "unknown";
	const open: RankedRoute[] = [];
	const unknown: RankedRoute[] = [];
	const near: RankedRoute[] = [];
	for (const entry of usable) {
		// A free ref keeps the free verdict and its own place: the headroom step was never its rule.
		if (!isFree(entry) && over(entry)) near.push({ ...entry, reason: `provider at or over ${PAID_HEADROOM_PERCENT}% of a window` });
		else if (!isFree(entry) && unread(entry)) unknown.push({ ...entry, reason: "the usage monitor has no reading for this provider" });
		else open.push(entry);
	}
	const readable = spread(open.filter((entry) => !isFree(entry)), "open");
	const unreadMeters = spread(unknown, "unknown-meter");
	const nearLine = spread(near, "over-threshold");
	const free = spread(open.filter(isFree), "free");
	const ordered = freeRefsLast ? [...readable, ...unreadMeters, ...nearLine, ...free] : [...spread(open, "open"), ...unreadMeters, ...nearLine];

	// An excluded ref returns at its window's reset, so it sits after every usable ref and before the
	// walled ones, earliest return first: the order a caller reads when nothing is open.
	const spent = [...excluded].sort((left, right) => (left.until ?? 0) - (right.until ?? 0));
	const ranked = [...ordered, ...spent, ...walled, ...unavailable, ...unconfigured];
	// Nothing excluded is ever marked chosen: only a ref the rule would actually place takes the verdict.
	const head = ranked[0];
	if (head !== undefined && (head.verdict === "open" || head.verdict === "free" || head.verdict === "unknown-meter" || head.verdict === "over-threshold")) {
		ranked[0] = { ...head, verdict: "chosen" };
	}
	return ranked;
}

/** The routing decisions log: `<pi-agent>/state/routing/decisions.jsonl`, overridable for tests. */
export function routingDecisionsPath(env: NodeJS.ProcessEnv = process.env): string {
	return env["PI_ROUTING_DECISIONS_PATH"] ?? join(homedir(), ".pi", "agent", "state", "routing", "decisions.jsonl");
}

/** One routing decision: what was chosen, what the alternatives were, and why. */
export interface RouteDecision {
	at: number;
	lane?: string;
	session?: string;
	delegate?: string;
	role?: string;
	project?: string;
	chosen: string;
	/** rule: the ranking chose it. orchestrator: a lane placed by hand on a pool model. failover: a wall moved the work. */
	by: "rule" | "orchestrator" | "failover";
	/**
	 * AR14: the account of a multi-account plan the rule would pick for `chosen`. Recorded in shadow first (design 5):
	 * it is the rule's answer, and `laneAccount` says which account the lane actually ran on, so a reader compares the
	 * two rather than assuming this one was applied.
	 */
	account?: string;
	/** AR14: the account the lane used — `PI_ACCOUNT` when the process was placed, else the plan's routed account. */
	laneAccount?: string;
	/** The lane's class (`flash`, `H1`..`H5`), when the placement carried one. */
	class?: string;
	/** What the lane does (`ui`, `copy`, `test`, `shared-owner`, ...), when the placement carried one. */
	taskKind?: string;
	/** The rule that chose the kind, when a rule did. */
	rule?: string;
	/** The reason a hand placement differs from the rule's choice. */
	override?: string;
	/** True for a shadow line: the rule's answer beside the real placement, never a placement itself. */
	shadow?: boolean;
	/**
	 * Set on a wait: the rule placed nothing (`chosen` is then empty), and this is the earliest moment a
	 * candidate returns, from a wall's `until` or a window's reset. Absent when nothing carries a clock.
	 */
	until?: number;
	candidates: RankedRoute[];
	/** AR13: the candidate set with the facts a choice reads, as the placement built it. */
	facts?: DecisionFacts;
	/** AR13 shadow: Jev's answer beside the deterministic placement, never a placement itself. */
	jev?: RouteJev;
	/** When the snapshot the headroom step read was captured. */
	snapshotAt?: number;
	reason?: string;
}

/**
 * Jev's answer as the decision line carries it (AR13, VR24-203): what it chose, the fact it named, the version of
 * the methodology it read, and what the call cost. A discarded answer keeps `choice` exactly as it came back and
 * says why under `fallback`, so the line shows what happened rather than a tidy version of it.
 */
export interface RouteJev {
	/** The ref Jev answered. Empty when it answered nothing usable. */
	choice: string;
	/** One line, at most 200 characters: the deciding fact Jev named, with the chosen candidate's own numbers. */
	reason?: string;
	/** The deciding fact as the closed code Jev answered with. */
	because?: string;
	/** The answer's own confidence in the choice it made. */
	confidence?: number;
	/** sha256 of the methodology's prompt text, the version every line quotes. */
	methodologyHash: string;
	/** The classifier ref the call went to, from the pool's own `classifier` role. */
	model?: string;
	/** USD the call cost; null when the service reported no usage. */
	costUsd?: number | null;
	/** False when the answer was discarded or never made, so the deterministic top stands. */
	accepted: boolean;
	/** Why the deterministic top stands instead: `not-placed`, `no-methodology`, `outside-set`, `ceiling`, `failed`. */
	fallback?: string;
}

/** One decision as a log line. The shape and the path are owned here; the append is `appendFsyncedLine` (send.ts). */
export function routeDecisionLine(entry: RouteDecision): string {
	return `${JSON.stringify(entry)}\n`;
}

/**
 * Where `appendFsyncedLine` writes the log: the directory and the file name. This library has
 * to stay loadable by plain node — the launcher's `lane-model.mjs` helper is one such caller,
 * and Node's TypeScript stripping refuses a module in the append body's import graph — so it
 * never imports the append body itself. `muster route record` is the write path that does.
 */
export function routingDecisionsTarget(env: NodeJS.ProcessEnv = process.env): { stateDir: string; fileName: string } {
	const path = routingDecisionsPath(env);
	return { stateDir: dirname(path), fileName: basename(path) };
}

/** Read the log back in order. A torn or unknown line is skipped, never fatal. */
export function readRouteDecisions(path: string = routingDecisionsPath()): RouteDecision[] {
	try {
		return readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => {
				try {
					return JSON.parse(line) as RouteDecision;
				} catch {
					return undefined;
				}
			})
			.filter((entry): entry is RouteDecision => entry !== undefined && typeof entry.at === "number" && typeof entry.chosen === "string");
	} catch {
		return [];
	}
}

/** The file's own ref shape (`provider/model`): the one validator `parsePoolConfig` and a free admission both use. */
export function isPoolRef(value: unknown): value is string {
	return typeof value === "string" && /^[^/\s]+\/\S+$/.test(value);
}

/**
 * `laneDefaults` is optional so a file written before 2026-10-09 still loads; when present it must
 * be complete, because a half-parsed default would name a model no one chose. Every error lands in
 * `errors`, and the section is dropped when it contributed one.
 */
function parseLaneDefaults(raw: unknown, roles: Record<string, string[]>, errors: string[]): LaneDefaults | undefined {
	if (raw === undefined) return undefined;
	const before = errors.length;
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		errors.push("laneDefaults must be an object");
		return undefined;
	}
	const input = raw as Record<string, unknown>;
	const piCandidates: string[] = [];
	const piHard: string[] = [];
	let fallbackRole = "";
	const piRaw = input.pi;
	if (piRaw === null || typeof piRaw !== "object" || Array.isArray(piRaw)) {
		errors.push("laneDefaults.pi must be an object with candidates and fallbackRole");
	} else {
		const pi = piRaw as Record<string, unknown>;
		if (!Array.isArray(pi.candidates) || pi.candidates.length === 0) {
			errors.push("laneDefaults.pi.candidates must be a non-empty array of provider/model refs");
		} else {
			for (const ref of pi.candidates) {
				if (!isPoolRef(ref)) errors.push(`laneDefaults.pi.candidates: "${String(ref)}" is not a provider/model ref`);
				else if (piCandidates.includes(ref)) errors.push(`laneDefaults.pi.candidates repeats "${ref}"`);
				else piCandidates.push(ref);
			}
		}
		if (pi.hard !== undefined) {
			if (!Array.isArray(pi.hard) || pi.hard.length === 0) {
				errors.push("laneDefaults.pi.hard must be a non-empty array of provider/model refs when present");
			} else {
				for (const ref of pi.hard) {
					if (!isPoolRef(ref)) errors.push(`laneDefaults.pi.hard: "${String(ref)}" is not a provider/model ref`);
					else if (piHard.includes(ref)) errors.push(`laneDefaults.pi.hard repeats "${ref}"`);
					else piHard.push(ref);
				}
			}
		}
		if (typeof pi.fallbackRole !== "string" || !(pi.fallbackRole in roles)) {
			errors.push(`laneDefaults.pi.fallbackRole must name a role in this file ("${String(pi.fallbackRole)}" is not one)`);
		} else {
			fallbackRole = pi.fallbackRole;
		}
	}
	const opencode: string[] = [];
	if (!Array.isArray(input.opencode) || input.opencode.length === 0) {
		errors.push("laneDefaults.opencode must be a non-empty array of free provider/model refs");
	} else {
		for (const ref of input.opencode) {
			if (!isPoolRef(ref)) errors.push(`laneDefaults.opencode: "${String(ref)}" is not a provider/model ref`);
			else if (opencode.includes(ref)) errors.push(`laneDefaults.opencode repeats "${ref}"`);
			else opencode.push(ref);
		}
	}
	if (typeof input.claude !== "string" || !input.claude.trim()) errors.push("laneDefaults.claude must be a non-empty model alias");
	if (errors.length > before) return undefined;
	return { pi: { candidates: piCandidates, fallbackRole, ...(piHard.length > 0 ? { hard: piHard } : {}) }, opencode, claude: (input.claude as string).trim() };
}

const ROUTING_KEYS = ["pick", "accountFailover", "slots", "claudeMax", "hardMax", "paused", "policy", "kindRules"] as const;
const ROUTING_PICKS = ["off", "shadow", "on"] as const;
/** AR16: the one flag the account failover reads. Absent from the file means off. */
const ROUTING_ACCOUNT_FAILOVERS = ["off", "on"] as const;

/** The kinds a Claude lane is allowed for (VR24-91): the Fix-gate review and the product pass, nothing else. */
const CLAUDE_KINDS: readonly TaskKind[] = ["review", "product-pass"];

/** The hard kinds: the methodology's H1 to H5, which only a `laneDefaults.pi.hard` ref may serve. */
const HARD_KINDS: readonly TaskKind[] = TASK_KINDS.filter((kind) => TASK_KIND_CLASS[kind].startsWith("H"));

/**
 * Every ref this file already routes: a role chain, a Pi lane default or its hard tier. The same set
 * `lane-control.ts` builds for P5-D6, which stays the one guard on an explicit model.
 */
function pooledRefs(roles: Record<string, string[]>, laneDefaults: LaneDefaults | undefined): Set<string> {
	const refs = new Set<string>();
	for (const chain of Object.values(roles)) for (const ref of chain) refs.add(ref);
	if (laneDefaults) {
		for (const ref of laneDefaults.pi.candidates) refs.add(ref);
		for (const ref of laneDefaults.pi.hard ?? []) refs.add(ref);
		for (const ref of laneDefaults.opencode) refs.add(ref);
	}
	return refs;
}

/**
 * `routing` is the policy table (blueprint 4.4, AR5): which model serves a lane kind, the Claude and hard
 * caps, the refs the operator paused for lanes, and the path patterns a brief is classified by.
 *
 * A refused section is dropped and its reasons go to `warnings`, never to `errors`: `pick` ships `off` and
 * nothing reads the table yet (AR6), so a typo here must not stop every lane launch. Every refusal is a
 * rule someone would otherwise break by hand: a ref the pool does not route, a free model placed
 * automatically, an `opencode/` ref on a Pi list, a Claude lane for a kind that is not an exception, a
 * hard kind served by a flash ref, a kind with no list, or a cap that is not a whole number.
 */
function parseRouting(
	raw: unknown,
	roles: Record<string, string[]>,
	laneDefaults: LaneDefaults | undefined,
	freeRefs: string[],
	warnings: string[],
): PoolRouting | undefined {
	if (raw === undefined) return undefined;
	const before = warnings.length;
	const refuse = (message: string) => warnings.push(`routing: ${message}`);
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		refuse("must be an object");
		return undefined;
	}
	const input = raw as Record<string, unknown>;
	for (const key of Object.keys(input)) if (!(ROUTING_KEYS as readonly string[]).includes(key)) refuse(`unknown key "${key}"`);

	const pick = input.pick;
	if (typeof pick !== "string" || !(ROUTING_PICKS as readonly string[]).includes(pick)) refuse(`pick must be one of ${ROUTING_PICKS.join(", ")}`);
	// AR16: the account failover's one flag. A file without it is off, so the shipped posture needs no edit.
	const accountFailover = input.accountFailover === undefined ? "off" : input.accountFailover;
	if (typeof accountFailover !== "string" || !(ROUTING_ACCOUNT_FAILOVERS as readonly string[]).includes(accountFailover)) {
		refuse(`accountFailover must be one of ${ROUTING_ACCOUNT_FAILOVERS.join(", ")}`);
	}
	const whole = (key: "slots" | "claudeMax" | "hardMax", min: number): number => {
		const value = input[key];
		if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
			refuse(`${key} must be a whole number of ${min === 0 ? "zero" : "one"} or more`);
			return min;
		}
		return value;
	};
	const slots = whole("slots", 1);
	const claudeMax = whole("claudeMax", 0);
	const hardMax = whole("hardMax", 0);

	const pooled = pooledRefs(roles, laneDefaults);
	const paused: string[] = [];
	if (input.paused !== undefined) {
		if (!Array.isArray(input.paused)) {
			refuse("paused must be an array of provider/model refs");
		} else {
			for (const entry of input.paused) {
				const ref = typeof entry === "string" ? entry.trim() : "";
				if (!isPoolRef(ref)) { refuse(`paused: "${String(entry)}" is not a provider/model ref`); continue; }
				if (!pooled.has(ref)) { refuse(`paused: "${ref}" is not in the pool`); continue; }
				if (paused.includes(ref)) { refuse(`paused repeats "${ref}"`); continue; }
				paused.push(ref);
			}
		}
	}

	const claudeAlias = laneDefaults?.claude;
	const hardRefs = new Set(laneDefaults?.pi.hard ?? []);
	const policy = {} as Record<TaskKind, string[]>;
	const policyRaw = input.policy;
	if (policyRaw === null || typeof policyRaw !== "object" || Array.isArray(policyRaw)) {
		refuse("policy must be an object of kind -> refs");
	} else {
		const named = policyRaw as Record<string, unknown>;
		for (const key of Object.keys(named)) if (!isTaskKind(key)) refuse(`policy names "${key}", which is not a task kind`);
		for (const kind of TASK_KINDS) {
			const list = named[kind];
			if (!Array.isArray(list) || list.length === 0) { refuse(`policy.${kind} must be a non-empty list of refs`); continue; }
			const refs: string[] = [];
			for (const entry of list) {
				const ref = typeof entry === "string" ? entry.trim() : "";
				if (ref === "") { refuse(`policy.${kind}: ${JSON.stringify(entry)} is not a ref`); continue; }
				if (refs.includes(ref)) { refuse(`policy.${kind} repeats "${ref}"`); continue; }
				// A Claude ref is the harness's own alias (`laneDefaults.claude`), never a pool ref: a Claude lane is
				// a Claude-harness lane and a non-Claude ref is a Pi lane (Harness fact).
				if (claudeAlias !== undefined && ref === claudeAlias) {
					if (CLAUDE_KINDS.includes(kind)) refs.push(ref);
					else refuse(`policy.${kind}: the Claude ref "${ref}" is allowed only for ${CLAUDE_KINDS.join(" and ")} (VR24-91)`);
					continue;
				}
				if (!isPoolRef(ref)) {
					refuse(`policy.${kind}: "${ref}" is not a provider/model ref${claudeAlias === undefined ? "" : `, and not the Claude alias "${claudeAlias}"`}`);
					continue;
				}
				if (ref.startsWith("opencode/")) { refuse(`policy.${kind}: "${ref}" is an OpenCode ref, and a Pi list never carries one`); continue; }
				if (freeRefs.includes(ref)) { refuse(`policy.${kind}: "${ref}" is a free ref, and the table places paid refs only (P5-D2)`); continue; }
				if (!pooled.has(ref)) { refuse(`policy.${kind}: "${ref}" is not in the pool (no chain and no lane default names it, P5-D6)`); continue; }
				if (HARD_KINDS.includes(kind) && !hardRefs.has(ref)) { refuse(`policy.${kind}: "${ref}" is not one of laneDefaults.pi.hard, and ${kind} is a hard kind`); continue; }
				refs.push(ref);
			}
			if (refs.length > 0) policy[kind] = refs;
		}
	}

	const kindRules: Record<string, Partial<Record<TaskKind, string[]>>> = {};
	if (input.kindRules !== undefined) {
		if (input.kindRules === null || typeof input.kindRules !== "object" || Array.isArray(input.kindRules)) {
			refuse("kindRules must be an object of project -> kind -> path patterns");
		} else {
			for (const [project, table] of Object.entries(input.kindRules as Record<string, unknown>)) {
				if (project.trim() === "") { refuse("kindRules names an empty project"); continue; }
				if (table === null || typeof table !== "object" || Array.isArray(table)) { refuse(`kindRules.${project} must be an object of kind -> path patterns`); continue; }
				const kinds: Partial<Record<TaskKind, string[]>> = {};
				for (const [kind, patterns] of Object.entries(table as Record<string, unknown>)) {
					if (!isTaskKind(kind)) { refuse(`kindRules.${project} names "${kind}", which is not a task kind`); continue; }
					if (!Array.isArray(patterns) || patterns.length === 0) { refuse(`kindRules.${project}.${kind} must be a non-empty list of path patterns`); continue; }
					const kept: string[] = [];
					for (const pattern of patterns) {
						if (typeof pattern !== "string" || pattern.trim() === "") { refuse(`kindRules.${project}.${kind}: ${JSON.stringify(pattern)} is not a path pattern`); continue; }
						kept.push(pattern.trim());
					}
					if (kept.length > 0) kinds[kind] = kept;
				}
				kindRules[project] = kinds;
			}
		}
	}

	if (warnings.length > before) return undefined;
	return { pick: pick as PoolRouting["pick"], accountFailover: accountFailover as PoolRouting["accountFailover"], slots, claudeMax, hardMax, paused, policy, kindRules };
}

/**
 * `ceilings`: one entry per bucket, each with a finite `usdPerMonth` above zero. The desk (`classifier`, VR24-39)
 * and the router (`routing`, VR24-204) are separate buckets, so one can never spend the other's month. Any other
 * key is an error, so a typo cannot hide a cap.
 */
const CEILING_BUCKETS = ["classifier", "routing"] as const;

function parseCeilings(value: unknown, errors: string[]): PoolCeilings | undefined {
	if (value === undefined) return undefined;
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		errors.push("ceilings must be an object");
		return undefined;
	}
	const before = errors.length;
	const ceilings: PoolCeilings = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (!(CEILING_BUCKETS as readonly string[]).includes(key)) { errors.push(`ceilings: unknown key "${key}"`); continue; }
		const bucket = key as (typeof CEILING_BUCKETS)[number];
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) { errors.push(`ceilings.${bucket} must be an object`); continue; }
		for (const field of Object.keys(entry)) if (field !== "usdPerMonth") errors.push(`ceilings.${bucket}: unknown key "${field}"`);
		const usd = (entry as { usdPerMonth?: unknown }).usdPerMonth;
		if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) errors.push(`ceilings.${bucket}.usdPerMonth must be a finite number above zero`);
		else ceilings[bucket] = { usdPerMonth: usd };
	}
	return errors.length > before ? undefined : ceilings;
}

export function parsePoolConfig(raw: unknown): PoolConfigResult {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: ["provider pool must be a JSON object"] };
	const input = raw as Record<string, unknown>;
	const errors: string[] = [];
	if (input.version !== 1) errors.push("version must be 1");
	if (typeof input.virtualProvider !== "string" || !input.virtualProvider.trim()) errors.push("virtualProvider must be a non-empty string");
	for (const key of ["cooldownMs", "resetHorizonMs"] as const) {
		if (typeof input[key] !== "number" || !Number.isFinite(input[key]) || (input[key] as number) <= 0) errors.push(`${key} must be a positive number`);
	}

	const freeRefs: string[] = [];
	if (input.freeRefs !== undefined) {
		if (!Array.isArray(input.freeRefs)) {
			errors.push("freeRefs must be an array of provider/model refs");
		} else {
			for (const ref of input.freeRefs) {
				if (!isPoolRef(ref)) errors.push(`freeRefs: "${String(ref)}" is not a provider/model ref`);
				else if (!freeRefs.includes(ref)) freeRefs.push(ref);
			}
		}
	}

	const roles: Record<string, string[]> = {};
	const rawRoles = input.roles;
	if (rawRoles === null || typeof rawRoles !== "object" || Array.isArray(rawRoles) || Object.keys(rawRoles).length === 0) {
		errors.push("roles must be an object with at least one role");
	} else {
		for (const [role, chain] of Object.entries(rawRoles as Record<string, unknown>)) {
			if (!Array.isArray(chain) || chain.length === 0) { errors.push(`role "${role}" needs a non-empty chain`); continue; }
			const seen = new Set<string>();
			const refs: string[] = [];
			for (const ref of chain) {
				if (!isPoolRef(ref)) { errors.push(`role "${role}": "${String(ref)}" is not a provider/model ref`); continue; }
				// A free ref has a wall of its own, so it may share its provider; every other repeat is an error.
				if (freeRefs.includes(ref)) {
					if (refs.includes(ref)) errors.push(`role "${role}" repeats free ref "${ref}"`);
				} else {
					const provider = providerOf(ref);
					if (seen.has(provider)) errors.push(`role "${role}" repeats provider "${provider}"`);
					seen.add(provider);
				}
				refs.push(ref);
			}
			roles[role] = refs;
		}
	}

	const nonChatRoles: string[] = [];
	if (input.nonChatRoles !== undefined) {
		if (!Array.isArray(input.nonChatRoles)) {
			errors.push("nonChatRoles must be an array of role names");
		} else {
			for (const name of input.nonChatRoles) {
				if (typeof name !== "string" || !(name in roles)) errors.push(`nonChatRoles names role "${String(name)}", which does not exist`);
				else nonChatRoles.push(name);
			}
		}
	}

	const laneDefaults = parseLaneDefaults(input.laneDefaults, roles, errors);
	const ceilings = parseCeilings(input.ceilings, errors);
	// A section nothing depends on is dropped with a warning instead of failing the file. `routing` is
	// that section: `pick` is `off` and no reader walks the table yet (AR6), so a typo in it must not
	// stop a lane launch. Every section above still fails the parse as it always has.
	const warnings: string[] = [];
	const routing = parseRouting(input.routing, roles, laneDefaults, freeRefs, warnings);

	for (const ref of freeRefs) {
		if (!Object.entries(roles).some(([role, chain]) => !nonChatRoles.includes(role) && chain.includes(ref))) errors.push(`freeRefs: "${ref}" is not in any chat role`);
	}

	// SK3: the providers whose work runs on a second account. An id must name a provider this file
	// already routes (a role chain or a free ref), so a typo fails the parse instead of silently
	// never splitting that provider.
	const routedProviders = new Set<string>();
	for (const chain of Object.values(roles)) for (const ref of chain) routedProviders.add(providerOf(ref));
	const employerAccounts: string[] = [];
	if (input.employerAccounts !== undefined) {
		if (!Array.isArray(input.employerAccounts)) {
			errors.push("employerAccounts must be an array of provider ids");
		} else {
			for (const id of input.employerAccounts) {
				const name = typeof id === "string" ? id.trim() : "";
				if (name === "") errors.push(`employerAccounts: "${String(id)}" is not a provider id`);
				else if (!routedProviders.has(name)) errors.push(`employerAccounts: "${name}" is not a provider this file routes`);
				else if (employerAccounts.includes(name)) errors.push(`employerAccounts repeats "${name}"`);
				else employerAccounts.push(name);
			}
		}
	}

	const shapes: QuotaShape[] = [];
	if (!Array.isArray(input.quotaShapes) || input.quotaShapes.length === 0) {
		errors.push("quotaShapes must list at least one shape");
	} else {
		for (const shape of input.quotaShapes as QuotaShape[]) {
			const id = typeof shape?.id === "string" ? shape.id : "?";
			let valid = typeof shape?.id === "string" && typeof shape.match === "string";
			for (const pattern of [shape?.match, shape?.reset?.pattern]) {
				if (pattern === undefined) continue;
				try { new RegExp(pattern); } catch { valid = false; }
			}
			if (valid) shapes.push(shape); else errors.push(`shape "${id}" is malformed or its pattern is not a valid regular expression`);
		}
	}

	const providerWalls: PoolConfig["providerWalls"] = {};
	if (input.providerWalls !== undefined) {
		if (input.providerWalls === null || typeof input.providerWalls !== "object" || Array.isArray(input.providerWalls)) {
			errors.push("providerWalls must be an object");
		} else {
			for (const [provider, wall] of Object.entries(input.providerWalls as Record<string, { until?: unknown; reason?: unknown }>)) {
				const until = typeof wall?.until === "string" ? Date.parse(wall.until) : Number.NaN;
				if (!Number.isFinite(until)) { errors.push(`providerWalls.${provider}.until must be an ISO date`); continue; }
				providerWalls[provider] = { until, ...(typeof wall.reason === "string" ? { reason: wall.reason } : {}) };
			}
		}
	}

	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		config: {
			version: 1,
			virtualProvider: (input.virtualProvider as string).trim(),
			cooldownMs: input.cooldownMs as number,
			resetHorizonMs: input.resetHorizonMs as number,
			providerWalls,
			roles,
			freeRefs,
			employerAccounts,
			nonChatRoles,
			...(laneDefaults ? { laneDefaults } : {}),
			...(ceilings ? { ceilings } : {}),
			...(routing ? { routing } : {}),
			quotaShapes: shapes,
		},
		...(warnings.length > 0 ? { warnings } : {}),
	};
}

export type FreeRefAdmission =
	| { ok: true; file: Record<string, unknown>; roles: string[] }
	| { ok: false; reason: string };

/**
 * The provider-pool.json one free admission produces (UM11, P5-D2). Pure and
 * I/O-free: the verb `muster pool admit` hands the result to the one settings
 * writer (`updateJsonSettingsFile`) and re-parses it with `parsePoolConfig`
 * before anything reaches disk, so this module stays the one owner of the
 * file's shape and the file stays the one routing list.
 *
 * The rule is the file's own (`_note`): `ref` joins `freeRefs` and the end of
 * every chat chain, and never the non-chat roles. `laneDefaults`, the walls and
 * `quotaShapes` are copied untouched. `roles` lists the chains `ref` really
 * joined, so a caller can report a ref that already sat in them.
 */
export function withAdmittedFreeRef(raw: unknown, ref: string): FreeRefAdmission {
	if (!isPoolRef(ref)) return { ok: false, reason: `${String(ref)} is not a <provider>/<model> ref` };
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "the provider pool must be a JSON object" };
	const input = raw as Record<string, unknown>;
	const freeRefs = Array.isArray(input.freeRefs) ? (input.freeRefs as unknown[]) : [];
	if (freeRefs.includes(ref)) return { ok: false, reason: `${ref} is already in freeRefs` };
	const roles = input.roles;
	if (roles === null || typeof roles !== "object" || Array.isArray(roles) || Object.keys(roles).length === 0) {
		return { ok: false, reason: "roles must be an object with at least one role" };
	}
	const nonChatRoles = Array.isArray(input.nonChatRoles)
		? input.nonChatRoles.filter((name): name is string => typeof name === "string")
		: [];
	const nextRoles: Record<string, unknown> = {};
	const added: string[] = [];
	for (const [role, chain] of Object.entries(roles as Record<string, unknown>)) {
		if (!Array.isArray(chain) || nonChatRoles.includes(role) || chain.includes(ref)) {
			nextRoles[role] = chain;
			continue;
		}
		nextRoles[role] = [...chain, ref];
		added.push(role);
	}
	return { ok: true, file: { ...input, freeRefs: [...freeRefs, ref], roles: nextRoles }, roles: added };
}

/** The sources a learned wall may carry; an entry written without one reads as the operator's `config` wall. */
const WALL_SOURCES: readonly Wall["source"][] = ["error", "cooldown", "config", "snapshot"];

function readLearnedWalls(now: number, path: string = learnedWallsPath()): Record<string, { until: number; reason?: string; source?: Wall["source"] }> {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, { until?: unknown; reason?: unknown; source?: unknown }>;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const walls: Record<string, { until: number; reason?: string; source?: Wall["source"] }> = {};
		for (const [key, wall] of Object.entries(parsed)) {
			const until = typeof wall?.until === "string" ? Date.parse(wall.until) : Number(wall?.until);
			if (!Number.isFinite(until) || until <= now) continue;
			walls[key] = {
				until,
				...(typeof wall.reason === "string" ? { reason: wall.reason } : {}),
				...(typeof wall.source === "string" && WALL_SOURCES.includes(wall.source as Wall["source"])
					? { source: wall.source as Wall["source"] }
					: {}),
			};
		}
		return walls;
	} catch {
		return {};
	}
}

export function loadPoolConfig(path: string = poolConfigPath(), now: number = Date.now()): PoolConfigResult {
	try {
		const parsed = parsePoolConfig(JSON.parse(readFileSync(path, "utf8")));
		if (!parsed.ok) return parsed;
		for (const [key, wall] of Object.entries(readLearnedWalls(now))) {
			const existing = parsed.config.providerWalls[key];
			if (!existing || wall.until > existing.until) parsed.config.providerWalls[key] = wall;
		}
		return parsed;
	} catch (error) {
		return { ok: false, errors: [`${path}: ${error instanceof Error ? error.message : String(error)}`] };
	}
}

/** The roles a chat request can be routed to: every role except the ones the file marks as not chat models. */
export function chatRoles(config: PoolConfig): string[] {
	return Object.keys(config.roles).filter((role) => !config.nonChatRoles.includes(role));
}

/** Walls in force at `now`: the file's walls plus learned ones, later `until` winning, expired entries dropped. */
export function activeWalls(config: PoolConfig, state: PoolState | undefined, now: number): Record<string, Wall> {
	const walls: Record<string, Wall> = {};
	const add = (key: string, wall: Wall) => {
		if (wall.until > now && (walls[key]?.until ?? 0) < wall.until) walls[key] = wall;
	};
	for (const [provider, wall] of Object.entries(config.providerWalls)) add(provider, { until: wall.until, source: wall.source ?? "config" });
	for (const [provider, wall] of Object.entries(state?.walls ?? {})) add(provider, wall);
	return walls;
}

/** When a quota wall lifts: the time the error names if it is in the future and within the horizon, else the cooldown. */
export function wallFor(resetAt: number | undefined, now: number, config: PoolConfig): Wall {
	if (resetAt !== undefined && resetAt > now && resetAt <= now + config.resetHorizonMs) return { until: resetAt, source: "error" };
	return { until: now + config.cooldownMs, source: "cooldown" };
}

type Pickable = {
	available: (ref: string) => boolean;
	/** The moment the ranking is made at, so an exclusion lifts at its window's reset. */
	now: number;
	/** The snapshot while it is fresh (P5-D1 O1); undefined leaves the headroom step out. */
	snapshot?: RoutingSnapshot;
	/** Running lanes per provider, for the spread step. */
	runningLanes?: (provider: string) => number;
};

/**
 * First usable ref after position `from` in chain order, wrapping around (from -1 starts at the top), ranked by
 * `rankLaneRoutes`: free refs come only after every usable paid ref, and a paid ref at or over the headroom
 * threshold moves behind the other paid refs.
 * With every provider walled it returns the usable ref whose wall lifts first, so a request still goes
 * out and renews the wall if it fails. Undefined only when no ref is usable at all.
 */
function pick(config: PoolConfig, chain: readonly string[], walls: Record<string, Wall>, opts: Pickable, from: number): string | undefined {
	const { available } = opts;
	const order = chain.map((_, k) => chain[(from + 1 + k) % chain.length]).filter((ref) => available(ref));
	const ranked = rankLaneRoutes({
		config,
		candidates: order,
		walls,
		available,
		now: opts.now,
		...(opts.snapshot ? { snapshot: opts.snapshot } : {}),
		...(opts.runningLanes ? { runningLanes: opts.runningLanes } : {}),
	});
	const open = ranked.find((entry) => entry.verdict !== "walled" && entry.verdict !== "unavailable" && entry.verdict !== "excluded");
	if (open) return open.ref;
	// Every usable ref is walled or excluded: go out on the one that returns first, from its wall or from the
	// reset its spent window names. Undefined only when nothing is usable at all.
	const lift = (ref: string) => walls[wallKey(config, ref)]?.until ?? ranked.find((entry) => entry.ref === ref)?.until ?? Number.POSITIVE_INFINITY;
	return order.reduce<string | undefined>((best, ref) => (best === undefined || lift(ref) < lift(best) ? ref : best), undefined);
}

function chainFor(config: PoolConfig, role: string): readonly string[] {
	const chain = config.roles[role];
	if (!chain) throw new Error(`provider pool has no role "${role}"`);
	if (config.nonChatRoles.includes(role)) throw new Error(`provider pool role "${role}" is not a chat role`);
	return chain;
}

export interface RouteInput {
	config: PoolConfig;
	role: string;
	reason: "user" | "continuation" | "retry" | "direct";
	now: number;
	/** True until the first request of a run has been routed. */
	newRun: boolean;
	/** Physical model of the latest successful response, as provider/model. */
	previous?: string;
	/** For a retry: the model that failed and its assistant message. */
	failed?: { ref: string; message: { stopReason?: string; errorMessage?: string } };
	state?: PoolState;
	/** Walls found outside route(), e.g. by the settle watcher. */
	pending?: Record<string, Wall>;
	/** Whether a ref names a model that exists and has credentials. */
	available: (ref: string) => boolean;
	/** The snapshot while it is fresh (P5-D1 O1). Undefined leaves the headroom step out; the live caller passes `freshRoutingSnapshot(now)`. */
	snapshot?: RoutingSnapshot;
	/** Running lanes per provider, for the spread step. */
	runningLanes?: (provider: string) => number;
}

export interface RouteOutcome {
	ref: string;
	/** Present only when the walls changed. Never set for `direct` requests, whose state Pi ignores. */
	state?: PoolState;
	/** The request used the new-run flag, so the caller clears it. */
	consumedNewRun: boolean;
}

export function routePool(input: RouteInput): RouteOutcome {
	const { config, role, reason, now } = input;
	const chain = chainFor(config, role);
	const learned: Record<string, Wall> = { ...(input.state?.walls ?? {}) };
	let changed = false;
	const learn = (key: string, wall: Wall) => { learned[key] = wall; changed = true; };

	for (const [provider, wall] of Object.entries(input.pending ?? {})) learn(provider, wall);
	// One reading of the failure, through the owner (ROUTERFAIL): a wall is recorded, and a failure that only says
	// "capacity" moves this request to the next ref without parking the provider, which answers again later.
	const failure = reason === "retry" && input.failed !== undefined ? classifyFailure(input.failed.message, config.quotaShapes, now) : undefined;
	if (failure?.wall === true && input.failed !== undefined) learn(wallKey(config, input.failed.ref), wallFor(failure.resetAt, now, config));

	const walls = activeWalls(config, { walls: learned }, now);
	// A new run starts from the primary; the rest of a run stays on its model until that model is walled.
	const consumedNewRun = input.newRun && (reason === "user" || reason === "continuation");
	const anchor = reason === "retry" ? input.failed?.ref : reason === "direct" || consumedNewRun ? undefined : input.previous;
	const anchorIndex = anchor === undefined ? -1 : chain.indexOf(anchor);
	const stay = anchor !== undefined && anchorIndex >= 0 && input.available(anchor) && !walls[wallKey(config, anchor)] && failure?.failover !== true;
	const ref = stay ? anchor : pick(config, chain, walls, input, anchorIndex);
	if (ref === undefined) throw new Error(`provider pool: no usable model for role "${role}"`);

	const result: RouteOutcome = { ref, consumedNewRun };
	if (changed && reason !== "direct") {
		result.state = { walls: Object.fromEntries(Object.entries(learned).filter(([, wall]) => wall.until > now)) };
	}
	return result;
}

/** The model a role starts on at `now`: the first whose provider is not walled. Undefined when the role is not in the file. */
export function startRef(config: PoolConfig, role: string, opts: { now: number; walls?: Record<string, Wall>; available?: (ref: string) => boolean; snapshot?: RoutingSnapshot; runningLanes?: (provider: string) => number }): string | undefined {
	const chain = config.roles[role];
	if (!chain || config.nonChatRoles.includes(role)) return undefined;
	const walls = activeWalls(config, { walls: opts.walls ?? {} }, opts.now);
	return pick(config, chain, walls, { available: opts.available ?? (() => true), now: opts.now, ...(opts.snapshot ? { snapshot: opts.snapshot } : {}), ...(opts.runningLanes ? { runningLanes: opts.runningLanes } : {}) }, -1);
}

/**
 * The next usable ref after `primary` in its role, behind a different wall (its provider, or a free ref's own) that is not walled.
 * A primary outside the role (an operator pinned it) takes the first usable
 * provider other than its own, so the list supplies the fallback of a route it does not choose.
 */
export function fallbackRef(config: PoolConfig, role: string, primary: string, opts: { now: number; walls?: Record<string, Wall>; available?: (ref: string) => boolean; skip?: ReadonlySet<string>; snapshot?: RoutingSnapshot; runningLanes?: (provider: string) => number }): string | undefined {
	const chain = config.roles[role];
	if (!chain || config.nonChatRoles.includes(role)) return undefined;
	const index = chain.indexOf(primary);
	const walls = activeWalls(config, { walls: opts.walls ?? {} }, opts.now);
	const available = opts.available ?? (() => true);
	const skipKeys = new Set<string>([wallKey(config, primary), ...[...(opts.skip ?? [])].map((ref) => wallKey(config, ref))]);
	for (const ref of opts.skip ?? []) skipKeys.add(ref);
	// The wrap from the primary, ranked by the one rule: free refs last, and a paid ref over its
	// provider's headroom threshold behind the others, so a paid ref later in the wrap still wins.
	const rotated = Array.from({ length: chain.length - 1 }, (_, step) => chain[(index + 1 + step) % chain.length]);
	const ranked = rankLaneRoutes({ config, candidates: rotated, walls, available, now: opts.now, ...(opts.snapshot ? { snapshot: opts.snapshot } : {}), ...(opts.runningLanes ? { runningLanes: opts.runningLanes } : {}) });
	for (const entry of ranked) {
		if (entry.verdict === "walled" || entry.verdict === "unavailable" || entry.verdict === "excluded") continue;
		if (skipKeys.has(entry.ref) || skipKeys.has(wallKey(config, entry.ref))) continue;
		return entry.ref;
	}
	return undefined;
}

export type LaneHarness = "pi" | "opencode" | "claude";

export interface LaneModelSkip {
	ref: string;
	reason: "walled" | "unavailable" | "over-threshold" | "excluded";
}

export interface LaneModelResolution {
	/** The model ref or alias to use. Undefined only when nothing is available. */
	model?: string;
	/** explicit: the operator named it. default: the harness's own default. fallback: the pool's role chain. none: nothing usable. */
	source: "explicit" | "default" | "fallback" | "none";
	skipped: LaneModelSkip[];
	/** Why no model is available. Present only when source is "none". */
	reason?: string;
}

export interface LaneModelInput {
	harness: LaneHarness;
	now: number;
	/** A model the operator named: used as is once the caller has checked it against the harness catalog, never resolved here. */
	explicit?: string;
	/** Walls beyond the pool file's own, e.g. learned ones a caller merged. */
	walls?: Record<string, Wall>;
	/** Whether a ref names a model that exists and has credentials. */
	available?: (ref: string) => boolean;
	/** The snapshot while it is fresh (P5-D1 O1). undefined reads the snapshot file; null leaves the headroom step out. */
	snapshot?: RoutingSnapshot | null;
	/** Running lanes per provider, for the spread step. */
	runningLanes?: (provider: string) => number;
}

/**
 * The model a lane starts on: the operator's explicit choice, else the harness's default from
 * `laneDefaults`. Pi walks its ordered candidates and falls through `pi.fallbackRole` when every
 * candidate is walled. OpenCode walks its free shortlist and never returns a paid model. Claude
 * returns its one alias. A ref is never validated against a model catalog here.
 */
export function resolveLaneModel(config: PoolConfig, input: LaneModelInput): LaneModelResolution {
	const explicit = input.explicit?.trim();
	if (explicit) return { model: explicit, source: "explicit", skipped: [] };
	const defaults = config.laneDefaults;
	if (!defaults) return { source: "none", skipped: [], reason: "the provider pool has no laneDefaults section" };
	if (input.harness === "claude") return { model: defaults.claude, source: "default", skipped: [] };

	const available = input.available ?? (() => true);
	const walls = activeWalls(config, { walls: input.walls ?? {} }, input.now);
	const snapshot = input.snapshot === undefined ? freshRoutingSnapshot(input.now) : input.snapshot ?? undefined;
	const skipped: LaneModelSkip[] = [];

	if (input.harness === "opencode") {
		for (const ref of defaults.opencode) {
			// A free lane model has a wall of its own, keyed by the full ref (the pool's free-ref rule), so
			// one exhausted free model does not wall its neighbours; a provider-wide wall is honoured too.
			// Each key carries this process's account when the provider is split (SK4).
			if (walls[accountWallKey(config, ref)] || walls[accountWallKey(config, providerOf(ref))]) { skipped.push({ ref, reason: "walled" }); continue; }
			if (!available(ref)) { skipped.push({ ref, reason: "unavailable" }); continue; }
			return { model: ref, source: "default", skipped };
		}
		return { source: "none", skipped, reason: "every free OpenCode model is walled; a paid model is never used for an OpenCode lane" };
	}

	// the operator's own order, with the headroom step inside it: a paid candidate whose provider is at or
	// over the threshold moves behind the others, and the free Step 5 Preview keeps its place, because
	// the lane default list is the operator's order and not the free-refs-last rule a role chain follows.
	const ranked = rankLaneRoutes({
		config,
		candidates: defaults.pi.candidates,
		walls,
		available,
		now: input.now,
		...(snapshot ? { snapshot } : {}),
		...(input.runningLanes ? { runningLanes: input.runningLanes } : {}),
		freeRefsLast: false,
	});
	const first = ranked.find((entry) => entry.verdict !== "walled" && entry.verdict !== "unavailable" && entry.verdict !== "excluded");
	// The note names what the operator's order passed over before the choice.
	const chosen = first === undefined ? -1 : defaults.pi.candidates.indexOf(first.ref);
	for (const [index, ref] of defaults.pi.candidates.entries()) {
		if (chosen >= 0 && index >= chosen) break;
		const entry = ranked.find((candidate) => candidate.ref === ref);
		if (entry?.verdict === "walled") skipped.push({ ref, reason: "walled" });
		else if (entry?.verdict === "unavailable") skipped.push({ ref, reason: "unavailable" });
		else if (entry?.verdict === "over-threshold") skipped.push({ ref, reason: "over-threshold" });
		else if (entry?.verdict === "excluded") skipped.push({ ref, reason: "excluded" });
	}
	if (first) return { model: first.ref, source: "default", skipped };
	// The fallback chain is ranked against the same reading and the same walls the candidate list was, so a
	// provider the reading excluded is not reached through the fallback door (AR3).
	const fallback = startRef(config, defaults.pi.fallbackRole, { now: input.now, walls: input.walls, available, ...(snapshot ? { snapshot } : {}) });
	if (fallback) return { model: fallback, source: "fallback", skipped };
	return { source: "none", skipped, reason: `every pi candidate is walled and role "${defaults.pi.fallbackRole}" has no usable model` };
}

/** A lane running right now, as a door counted it: the ref it runs on. */
export interface RunningLane {
	ref: string;
}

export interface LanePlacementInput {
	/**
	 * The harness the lane will run in. With no harness the candidates are not filtered: the answer names the
	 * harness its ref needs (`claude`), which is what the orchestrator reads when it asks where a lane goes.
	 */
	harness?: LaneHarness;
	now: number;
	/** A model the operator named. The resolution keeps it exactly as today (P5-D6) and the table places nothing. */
	explicit?: string;
	/** What the lane does (blueprint 4.4). With no kind, or with `pick` off, the placement changes nothing. */
	kind?: TaskKind;
	/** The lane's class as it will be recorded; absent reads the kind's own class from `TASK_KIND_CLASS`. */
	class?: TaskKindClass;
	/** Walls beyond the pool file's own, e.g. learned ones a caller merged. */
	walls?: Record<string, Wall>;
	/** Whether a ref names a model that exists and has credentials. */
	available?: (ref: string) => boolean;
	/**
	 * Whether the candidate's provider key is present in the lane's would-be environment (VR24-213), tested by name
	 * only. Absent leaves the check out, exactly as before AR14; a candidate it refuses is never placed.
	 */
	configured?: (ref: string, account?: string) => boolean;
	/** The snapshot while it is fresh; undefined reads the snapshot file, null leaves the headroom step out. */
	snapshot?: RoutingSnapshot | null;
	/**
	 * The lanes running now. The spread step, the Claude cap and the hard cap read this one list, so a door
	 * that cannot count them says so by passing nothing rather than by counting twice.
	 */
	running?: readonly RunningLane[];
	/**
	 * The reviewer-family preference this lane is placed under (finding 12), when its caller has one. A preference
	 * among the placeable refs, never a filter: it reorders a tier and removes nothing.
	 */
	family?: ReviewerFamilyPreference;
}

/**
 * One window of a candidate, as a choice reads it (AR13): the length, how much is used, how much is left, and when
 * it refills. The router's own reading is `RoutingUsageWindow`; this is the same reading in the shape the decision
 * line and the question carry.
 */
export interface DecisionWindow {
	windowMinutes: number;
	usedPercent: number;
	/** The share still unused: 100 minus `usedPercent`, so a reader never does the subtraction itself. */
	remaining: number;
	/** Epoch ms when the window refills. */
	resetsAt: number;
}

/** The three tiers of blueprint 4.4 step 2, as a candidate's facts name them. */
export type DecisionTier = "open" | "unknown-meter" | "over-the-line";

/** One candidate of the set a choice is made inside: a ref and only the facts that choice needs (AR13). */
export interface DecisionFactsCandidate {
	ref: string;
	tier: DecisionTier;
	/** Every window the row reports, or only the 5-hour one for a plan whose only limit is a refilling window. */
	windows: DecisionWindow[];
	/** Weekly used percent minus weekly elapsed percent; negative is behind pace. Absent with no weekly window. */
	pace?: number;
	/** Lanes already running on that provider. */
	running: number;
	/** The inventory says this plan's only limit is its 5-hour window (VR24-202, VR24-203 (5)). */
	refills: boolean;
	free: boolean;
}

/**
 * What code hands a choice (AR13, VR24-203): the task, the moment, the deterministic top as the fallback, and the
 * candidates with the facts. Code has already removed every ref that is walled, exhausted, paused, over a cap or
 * not allowed for this kind, so a ref in this set is the whole of what may be chosen.
 */
export interface DecisionFacts {
	kind: TaskKind;
	class: TaskKindClass;
	now: number;
	/** The ref the AR5/AR12 order places: the answer a fallback uses and a retro compares against. */
	deterministic: string;
	candidates: DecisionFactsCandidate[];
}

/** The verdicts a ref can carry and still be placed: the set a choice is made inside (CCACCT2's launch account reads it). */
export const PLACEABLE_VERDICTS: readonly RouteVerdict[] = ["chosen", "open", "free", "unknown-meter", "over-threshold"];

/** The tier a placeable verdict belongs to, for the facts the choice reads. */
function decisionTier(verdict: RouteVerdict): DecisionTier {
	if (verdict === "unknown-meter") return "unknown-meter";
	if (verdict === "over-threshold") return "over-the-line";
	return "open";
}

/**
 * One ref of the placement's own list, as the shortfall records it: what it is, and why it can or cannot take
 * the lane now. A ref the placement dropped before ranking (paused, or another harness's) carries no verdict,
 * because no rule gave it one.
 */
export interface ShortfallRef {
	ref: string;
	/** The account this candidate is one of, when the provider's plan lists accounts (AR14, VR24-206). */
	account?: string;
	provider: string;
	verdict?: RouteVerdict;
	/** Why it serves, or why it cannot: the ranking's own line, or the rule that dropped it. */
	reason: string;
	/** For a spent or walled ref: the moment it returns. */
	until?: number;
}

/**
 * What the kind's list can actually cover (finding 7): the refs that can take the lane now, the providers they
 * sit on, every ref that cannot with its reason, and the one rule that makes it a shortfall. The invariant is
 * the operator's — a critical role keeps two placeable refs across two providers, or the record says exactly why not
 * (architecture v2 §0, §4 step 5) — and it is read off the verdicts `rankLaneRoutes` already produced, never off
 * the list's length: two refs both behind a wall or a cap report a shortfall that names them instead of passing
 * on the fact that the policy lists two.
 */
export interface PlacementShortfall {
	kind: TaskKind;
	/** The refs that can take this lane now, in the ranking's order. The head is the one placed. */
	placeable: ShortfallRef[];
	/** The distinct providers `placeable` sits on, in its order. */
	providers: string[];
	/** Every ref of the list that cannot take the lane, in the policy's order, each with its reason. */
	notPlaceable: ShortfallRef[];
	/** Two placeable refs across two providers. */
	ok: boolean;
	/** Why the list falls short, naming each ref and its reason. Present exactly when `ok` is false. */
	reason?: string;
}

/**
 * A caller's reviewer-family preference (finding 12). The families stay the caller's vocabulary — the review
 * owner's `familyFromModel` and `REVIEW_FAMILIES` — so the placement reads them through `familyOf` and never
 * names one itself. It is a preference: an avoided ref sorts behind a differing one and is never removed, so a
 * role whose every family is avoided still places its first ref instead of ending with nothing.
 */
export interface ReviewerFamilyPreference {
	/** The families the caller would rather not use for this lane, e.g. the author's and the parent's. */
	avoid: readonly string[];
	/** The ref's family, read by the owner that records it. Undefined leaves the ref unpreferred, never out. */
	familyOf: (ref: string) => string | undefined;
}

/**
 * The list's coverage as one record: its placeable refs over their providers, and its reason when it keeps
 * fewer than two of either. The reason names every ref that cannot serve and why, so a shortfall is never a
 * sentence a reader has to match against the policy by hand.
 */
function shortfallOf(kind: TaskKind, placeable: ShortfallRef[], notPlaceable: ShortfallRef[]): PlacementShortfall {
	const providers = [...new Set(placeable.map((entry) => entry.provider))];
	if (placeable.length >= 2 && providers.length >= 2) return { kind, placeable, providers, notPlaceable, ok: true };
	const detail = notPlaceable
		.map((entry) => `${entry.ref}${entry.account === undefined ? "" : ` (${entry.account})`}: ${entry.reason}`)
		.join("; ");
	const because = detail === "" ? "" : ` — ${detail}`;
	if (placeable.length === 0) return { kind, placeable, providers, notPlaceable, ok: false, reason: `routing.policy.${kind} has no placeable ref now${because}` };
	if (placeable.length === 1) return { kind, placeable, providers, notPlaceable, ok: false, reason: `routing.policy.${kind} has one placeable ref (${placeable[0]?.ref ?? "?"}) and the role needs two${because}` };
	return { kind, placeable, providers, notPlaceable, ok: false, reason: `routing.policy.${kind} has ${placeable.length} placeable refs on ${providers.join(", ")} alone and the role needs two providers${because}` };
}

/**
 * What the table would do with one lane (blueprint 4.5). `status: "off"` is every path where nothing is
 * placed by the table — no `routing` section, `pick` off, no kind, or an explicit model — and `resolution` is
 * then the whole answer, exactly what `resolveLaneModel` returns today.
 */
export interface LanePlacement {
	status: "off" | "placed" | "wait";
	/** The ref the table places. Present only for `placed`. */
	ref?: string;
	/** The harness default's own answer. With `status: "off"` this is what the launcher uses, unchanged. */
	resolution: LaneModelResolution;
	/** Every candidate the rule read, in its order, with its verdict: the decision line's alternatives. */
	candidates: RankedRoute[];
	/** AR13: the placeable candidates and their facts, present only on a placement. */
	facts?: DecisionFacts;
	/** Finding 7: what the kind's list can cover and why each ref it cannot, on every placement but `off`. */
	shortfall?: PlacementShortfall;
	/** The one-line reason: the kind's list, the tier, and the count or the cap that decided. */
	reason: string;
	/** For `wait`: the earliest moment a candidate returns. Absent when no candidate carries a clock. */
	until?: number;
	/** True when the placed ref is the Claude alias, so the door knows this is a Claude-harness lane. */
	claude?: boolean;
}

/** What the one step-3 comparator needs: the running count, the pace, the refilling plans, and the kind's own order. */
interface PlacementOrder {
	now: number;
	runningOf: (provider: string, account?: string) => number;
	preference: readonly string[];
	snapshot?: RoutingSnapshot;
	/** The providers whose plan's only limit is a window that refills (the inventory's flag, VR24-202). */
	refills: ReadonlySet<string>;
	/** The harness's Claude alias, which the refill key never reads, whatever the inventory says (VR24-91). */
	claudeRef?: string;
	/** The caller's reviewer-family preference, when it has one (finding 12). */
	family?: ReviewerFamilyPreference;
}

/**
 * The providers whose plan's only limit is a window that refills: the inventory's `refills` flag, the one
 * owner of that fact (VR24-202), so this rule keeps no provider list of its own. It reads the file
 * `routerSubscriptionsPath` names and applies no receipt, a price being no routing fact. A missing, torn
 * or unrecognized file names no plan and leaves the order alone, exactly as a missing snapshot does.
 */
export function refillingProviders(): ReadonlySet<string> {
	try {
		return new Set(
			loadSubscriptionPlans(routerSubscriptionsPath(), { noReceipts: true })
				.filter((plan) => plan.refills === true)
				.map((plan) => plan.provider),
		);
	} catch {
		return new Set();
	}
}

/**
 * One ref's pace: its weekly window projected to the end at the current burn (`windowPace`). The lower the
 * projection, the further behind pace the plan is, and an underused subscription is the one to use
 * (blueprint 4.4 step 3; the operator 2026-10-15). A ref with no weekly window and no nominal length has no pace
 * and sorts last. Pace is a tie-break only.
 */
function placementPace(entry: RouteCandidate, order: PlacementOrder): number {
	const row = candidateRow(order.snapshot, entry);
	const weekly = row?.windows.find((window) => window.windowMinutes === 10_080);
	if (weekly === undefined) return Number.POSITIVE_INFINITY;
	return windowPace(weekly, order.now) ?? Number.POSITIVE_INFINITY;
}

/**
 * A candidate's refilling window, or undefined when the rule reads none for it: the plan must refill, the
 * ref must not be the Claude alias, and the snapshot must carry its 5-hour window. A candidate that names an
 * account reads that account's row, so one account's open window never speaks for the other (AR14).
 */
function refillWindow(entry: RouteCandidate, order: PlacementOrder): RoutingUsageWindow | undefined {
	if (order.claudeRef !== undefined && entry.ref === order.claudeRef) return undefined;
	if (!order.refills.has(providerOf(entry.ref))) return undefined;
	return candidateRow(order.snapshot, entry)?.windows.find((window) => window.windowMinutes === REFILL_WINDOW_MINUTES);
}

/**
 * Whether the refilling window is open now (VR24-202): the reading is under the 95 percent line and the
 * reset is still ahead. A window at or over the line is spent, and one whose reset is behind us is not this
 * window's reading, so neither gives a bonus.
 */
function refillFirst(entry: RouteCandidate, order: PlacementOrder): number {
	const window = refillWindow(entry, order);
	if (window === undefined || window.usedPercent >= PAID_HEADROOM_PERCENT || window.resetsAt <= order.now) return 1;
	return 0;
}

/** The line the decision carries when the refill key decided it. */
function refillNote(entry: RouteCandidate, order: PlacementOrder): string {
	const window = refillWindow(entry, order);
	const used = window === undefined ? "?" : `${Math.round(window.usedPercent)}%`;
	const resets = window === undefined ? "" : ` and resets ${new Date(window.resetsAt).toISOString()}`;
	return `refill-first: ${accounted(providerOf(entry.ref), entry.account)}'s ${REFILL_WINDOW_MINUTES / 60}-hour window is ${used} used${resets}`;
}

/**
 * The earliest refilling window that opens inside the horizon among `candidates`, or undefined (VR24-202).
 * Only a plan the inventory names as refilling is read: a capped weekly or monthly allowance never opens
 * sooner for having been waited for, so it never holds a lane.
 */
function refillReturn(candidates: readonly RouteCandidate[], order: PlacementOrder, horizonMs: number): { ref: string; until: number } | undefined {
	let best: { ref: string; until: number } | undefined;
	for (const entry of candidates) {
		const window = refillWindow(entry, order);
		if (window === undefined || window.usedPercent < PAID_HEADROOM_PERCENT) continue;
		if (window.resetsAt <= order.now || window.resetsAt > order.now + horizonMs) continue;
		if (best === undefined || window.resetsAt < best.until) best = { ref: accounted(providerOf(entry.ref), entry.account), until: window.resetsAt };
	}
	return best;
}

/**
 * An account's spare allowance as design 1 compares it (AR14): the smallest remaining share across the account's
 * windows — its tightest window — so the account with more room in its tightest limit is the one to use. A row the
 * snapshot does not carry reads as no reading and sorts behind every reading.
 */
function spareAllowance(entry: RouteCandidate, order: PlacementOrder): number {
	const row = candidateRow(order.snapshot, entry);
	if (row === undefined || row.windows.length === 0) return Number.NEGATIVE_INFINITY;
	return Math.min(...row.windows.map((window) => 100 - window.usedPercent));
}

/**
 * The reviewer-family preference as a sort key, never a filter (finding 12): a ref whose family the caller
 * avoids sorts behind one it does not, and stays a candidate either way. A ref whose family cannot be read is
 * unpreferred rather than excluded, because a preference the caller cannot evaluate never removes a candidate.
 */
function familyFirst(entry: RouteCandidate, order: PlacementOrder): number {
	const preference = order.family;
	if (preference === undefined || preference.avoid.length === 0) return 0;
	const family = preference.familyOf(entry.ref);
	return family !== undefined && preference.avoid.includes(family) ? 1 : 0;
}

/**
 * Step 3 of placement (blueprint 4.4), and the only ordering AR6 adds: inside the best tier, a refilling
 * window that is open comes first, then the ref with the fewest running lanes, then the provider furthest
 * behind its pace, then the kind's own preference order. AR12 adds its refill key to this function and
 * nowhere else (VR24-202): the rule reorders the candidates its kind's list already holds and adds none.
 *
 * AR14 adds the account keys of design 1 and only between two candidates that both name an account: the spare
 * allowance across the account's tightest window, then fewer running lanes on that account, then the kind's order,
 * then the label. Two candidates without an account compare exactly as they did before AR14.
 */
function comparePlacement(left: RouteCandidate, right: RouteCandidate, order: PlacementOrder): number {
	const refill = refillFirst(left, order) - refillFirst(right, order);
	if (refill !== 0) return refill;
	// Finding 12: the caller's family preference sits above the load keys and below the refill key, because a
	// reviewer's independence is a rule of the work and the spread is a nicety. It never removes a ref.
	const family = familyFirst(left, order) - familyFirst(right, order);
	if (family !== 0) return family;
	if (left.account !== undefined && right.account !== undefined) {
		const spare = spareAllowance(left, order);
		const other = spareAllowance(right, order);
		if (spare !== other) return spare > other ? -1 : 1;
		const lanes = order.runningOf(providerOf(left.ref), left.account) - order.runningOf(providerOf(right.ref), right.account);
		if (lanes !== 0) return lanes;
		const preference = order.preference.indexOf(left.ref) - order.preference.indexOf(right.ref);
		if (preference !== 0) return preference;
		return left.account < right.account ? -1 : left.account > right.account ? 1 : 0;
	}
	const lanes = order.runningOf(providerOf(left.ref)) - order.runningOf(providerOf(right.ref));
	if (lanes !== 0) return lanes;
	const pace = placementPace(left, order);
	const other = placementPace(right, order);
	if (pace !== other) return pace < other ? -1 : 1;
	return order.preference.indexOf(left.ref) - order.preference.indexOf(right.ref);
}

/**
 * Where the table would place one lane (blueprint 4.4 and 4.5, AR6): the placement steps 1 to 3 over
 * `routing.policy[kind]`, read through the verdicts `rankLaneRoutes` already produces so there is no second
 * ranking. It places nothing — `status: "off"` — with no kind, with `pick: "off"`, without the section, or
 * when the operator named a model, so every caller's launch is whatever it was before AR6.
 *
 * The caps are the operator's recorded limits, not new ones: `claudeMax` Claude lanes at once and `hardMax` hard
 * lanes (VR24-91), a pause that is his word for lanes only (VR24-113), and a hard kind that never lands on a
 * flash ref (blueprint 4.4). Nothing downgrades silently: when every candidate is out, the answer is `wait`
 * with the earliest return.
 */
export function placeLaneModel(config: PoolConfig, input: LanePlacementInput): LanePlacement {
	const resolution = resolveLaneModel(config, {
		harness: input.harness ?? "pi",
		now: input.now,
		...(input.explicit !== undefined ? { explicit: input.explicit } : {}),
		...(input.walls !== undefined ? { walls: input.walls } : {}),
		...(input.available !== undefined ? { available: input.available } : {}),
		...(input.snapshot !== undefined ? { snapshot: input.snapshot } : {}),
	});
	const off = (reason: string): LanePlacement => ({ status: "off", resolution, candidates: [], reason });
	const routing = config.routing;
	if (routing === undefined) return off("the pool file carries no routing section");
	if (routing.pick === "off") return off("routing.pick is off");
	if (input.explicit !== undefined && input.explicit.trim() !== "") return off(`${input.explicit.trim()} was named on the command line, so the table places nothing`);
	if (input.kind === undefined) return off("no task kind was given, so the harness default stands");
	const policy = routing.policy[input.kind];
	if (policy === undefined || policy.length === 0) return off(`routing.policy has no list for ${input.kind}`);

	const now = input.now;
	const available = input.available ?? (() => true);
	const walls = activeWalls(config, { walls: input.walls ?? {} }, now);
	const snapshot = input.snapshot === undefined ? freshRoutingSnapshot(now) : input.snapshot ?? undefined;
	const kindClass = input.class ?? TASK_KIND_CLASS[input.kind];
	const hard = kindClass.startsWith("H");
	const claudeAlias = config.laneDefaults?.claude;
	const hardRefs = new Set(config.laneDefaults?.pi.hard ?? []);
	const running = input.running ?? [];
	const runningOf = (provider: string, account?: string) =>
		running.filter((lane) => providerOf(lane.ref) === provider && (account === undefined || lane.account === account)).length;
	const claudeRunning = claudeAlias === undefined ? 0 : running.filter((lane) => lane.ref === claudeAlias).length;
	const hardRunning = running.filter((lane) => hardRefs.has(lane.ref)).length;

	/** A wait: the rule placed nothing, and `until` is the earliest moment a candidate returns. */
	const wait = (reason: string, candidates: RankedRoute[], at?: number, shortfall?: PlacementShortfall): LanePlacement => {
		const returns = [
			...(at === undefined ? [] : [at]),
			...candidates.map((entry) =>
				entry.verdict === "excluded"
					? entry.until
					: entry.verdict === "walled"
						? wallForCandidate(config, walls, entry)?.until
						: undefined,
			),
		].filter((until): until is number => typeof until === "number" && until > now);
		const until = returns.length === 0 ? undefined : Math.min(...returns);
		return { status: "wait", resolution, candidates, reason, ...(shortfall === undefined ? {} : { shortfall }), ...(until === undefined ? {} : { until }) };
	};

	// Step 1: a paused ref is never a candidate. the operator's pause is for lanes only and has no end, so it is
	// dropped here and never turned into a wall, whose clock would also hold delegates and memory (VR24-113).
	const paused = policy.filter((ref) => routing.paused.includes(ref));
	// The harness decides which refs a lane may run on: the Claude harness runs the Claude alias only, and a Pi
	// or OpenCode lane never runs it (blueprint 7.1, P5-D6). A kind whose list is the alias alone therefore
	// places nothing for a Pi lane, and says so rather than reaching outside the list.
	// With a harness named, the candidate list follows it: the Claude harness runs the Claude alias only and a
	// Pi or OpenCode lane never runs it (blueprint 7.1, P5-D6). With no harness the list is unfiltered, so a
	// kind whose order spans both harnesses still has one answer, and `claude` says which lane it needs.
	const forHarness = input.harness === undefined ? policy : policy.filter((ref) => (input.harness === "claude") === (ref === claudeAlias));
	const policyCandidates = forHarness.filter((ref) => !routing.paused.includes(ref));
	/** Why one ref of the kind's list never reached the ranking: its harness, or the operator's pause. */
	const droppedReason = (ref: string): string =>
		!forHarness.includes(ref) ? `a ${input.harness} lane never runs it (blueprint 7.1)` : "paused for lanes (VR24-113)";
	if (policyCandidates.length === 0) {
		const why = forHarness.length === 0 ? `routing.policy.${input.kind} names no ref this ${input.harness} lane may run on` : `${[...new Set(paused)].join(", ")} is paused for lanes`;
		// Even here the answer names every ref and why: the finding is about a record that reported nothing useful.
		const none = policy.map((ref): ShortfallRef => ({ ref, provider: providerOf(ref), reason: droppedReason(ref) }));
		return wait(`${why} (blueprint 4.4 step 1)`, [], undefined, shortfallOf(input.kind, [], none));
	}
	// AR14 design 1: a ref of a provider whose inventory plan lists accounts becomes one candidate per account, so the
	// one ranking decides between accounts as it decides between refs. A plan held once keeps its single candidate.
	const candidates = policyCandidates.flatMap((ref): RouteCandidate[] => {
		const accounts = providerAccounts(providerOf(ref));
		return accounts.length === 0 ? [{ ref }] : accounts.map((account) => ({ ref, account: account.label }));
	});

	// Steps 1 and 2 are the ranking's own verdicts, never a second ranking: walled, exhausted (`excluded`) and
	// unavailable refs are already out of `chosen`, and the three tiers are its order.
	const ranked = rankLaneRoutes({
		config,
		candidates,
		walls,
		available,
		...(input.configured === undefined ? {} : { configured: input.configured }),
		now,
		...(snapshot ? { snapshot } : {}),
		runningLanes: runningOf,
		freeRefsLast: false,
	});

	const order: PlacementOrder = {
		now,
		runningOf,
		preference: policy,
		refills: refillingProviders(),
		...(claudeAlias === undefined ? {} : { claudeRef: claudeAlias }),
		...(snapshot ? { snapshot } : {}),
		...(input.family === undefined ? {} : { family: input.family }),
	};
	const tiers: ReadonlyArray<readonly RouteVerdict[]> = [
		["chosen", "open", "free"],
		["unknown-meter"],
		["over-threshold"],
	];
	/**
	 * Why a ref cannot be placed at all, whatever its tier: a hard kind never lands on a ref outside
	 * `laneDefaults.pi.hard` (blueprint 4.4), and the Claude cap holds its own alias in place (VR24-91).
	 */
	const blocked = (entry: RankedRoute): "hard-class" | "claude-cap" | undefined => {
		if (hard && !hardRefs.has(entry.ref)) return "hard-class";
		if (claudeAlias !== undefined && entry.ref === claudeAlias && claudeRunning >= routing.claudeMax) return "claude-cap";
		return undefined;
	};
	/**
	 * AR13's candidate set: every ref this kind may take, with the facts a choice reads. It holds the placeable refs
	 * only, so a ref code has excluded — walled, a spent window, no credentials, a hard kind's flash ref, a
	 * Claude-capped alias — is never in it (VR24-203 (1)). The deterministic top is the fallback, named here.
	 */
	const placeable = ranked.filter((entry) => PLACEABLE_VERDICTS.includes(entry.verdict) && blocked(entry) === undefined);
	/**
	 * Finding 7: the kind's list as a record of coverage, read from the ranking's verdicts and from the rules that
	 * drop a ref before or after it. Every ref the list names is either placeable or carried in `notPlaceable` with
	 * its reason, so a role that has lost its second provider says which ref it lost and why.
	 */
	const notPlaceableReason = (entry: RankedRoute): string => {
		switch (blocked(entry)) {
			case "hard-class":
				return `it is not one of laneDefaults.pi.hard, and ${input.kind} is a hard kind (blueprint 4.4)`;
			case "claude-cap":
				return `${routing.claudeMax} Claude lanes already run (VR24-91)`;
			default:
				return entry.reason;
		}
	};
	const shortfall = shortfallOf(
		input.kind,
		placeable.map((entry): ShortfallRef => ({
			ref: entry.ref,
			...(entry.account === undefined ? {} : { account: entry.account }),
			provider: providerOf(entry.ref),
			verdict: entry.verdict,
			reason: entry.reason,
			...(entry.until === undefined ? {} : { until: entry.until }),
		})),
		[
			...policy.filter((ref) => !policyCandidates.includes(ref)).map((ref): ShortfallRef => ({ ref, provider: providerOf(ref), reason: droppedReason(ref) })),
			...ranked
				.filter((entry) => !placeable.includes(entry))
				.map((entry): ShortfallRef => ({
					ref: entry.ref,
					...(entry.account === undefined ? {} : { account: entry.account }),
					provider: providerOf(entry.ref),
					verdict: entry.verdict,
					reason: notPlaceableReason(entry),
					...(entry.until === undefined ? {} : { until: entry.until }),
				})),
		],
	);

	if (hard && hardRunning >= routing.hardMax) {
		return wait(`${routing.hardMax} hard lanes already run, and ${input.kind} is a hard kind (VR24-91)`, ranked, undefined, shortfall);
	}
	const factsFor = (deterministic: string): DecisionFacts => ({
		kind: input.kind as TaskKind,
		class: kindClass,
		now,
		deterministic,
		candidates: placeable.map((entry): DecisionFactsCandidate => {
			const provider = providerOf(entry.ref);
			const refills = order.refills.has(provider);
			const row = candidateRow(snapshot, entry);
			// A plan whose only limit is a window that refills is sent with that window alone (VR24-203 (5)): its
			// weekly meter reads 0 whatever happens, and sending it would read as room the plan does not hold.
			const windows = (row?.windows ?? [])
				.filter((window) => !refills || window.windowMinutes === REFILL_WINDOW_MINUTES)
				.map((window) => ({
					windowMinutes: window.windowMinutes,
					usedPercent: window.usedPercent,
					remaining: Math.round((100 - window.usedPercent) * 10) / 10,
					resetsAt: window.resetsAt,
				}));
			const weekly = row?.windows.find((window) => window.windowMinutes === 10_080);
			const pace = weekly === undefined ? undefined : windowPace(weekly, now);
			return {
				ref: entry.ref,
				...(entry.account === undefined ? {} : { account: entry.account }),
				tier: decisionTier(entry.verdict),
				windows,
				...(pace === undefined ? {} : { pace }),
				running: runningOf(provider, entry.account),
				refills,
				free: config.freeRefs.includes(entry.ref),
			};
		}),
	});
	/**
	 * The ranked list as a decision carries it: the entry the placement chose is the one marked `chosen`, and no second
	 * entry stays marked. `rankLaneRoutes` marks the head of its own order, and the placement's comparator can pick a
	 * different entry inside the same tier (AR12's refill key, and AR14's account keys), so the two are reconciled here
	 * rather than the line contradicting the choice it records.
	 */
	const chosenList = (entries: RankedRoute[], chosen: RankedRoute): RankedRoute[] =>
		entries.map((entry) =>
			entry.ref === chosen.ref && entry.account === chosen.account
				? { ...entry, verdict: "chosen" }
				: entry.verdict === "chosen"
					? { ...entry, verdict: "open" }
					: entry,
		);
	for (const [index, tier] of tiers.entries()) {
		const allowed: RankedRoute[] = [];
		let claudeCapped = false;
		for (const entry of ranked) {
			if (!tier.includes(entry.verdict)) continue;
			const why = blocked(entry);
			if (why === "hard-class") continue;
			if (why === "claude-cap") {
				claudeCapped = true;
				continue;
			}
			allowed.push(entry);
		}
		if (allowed.length === 0) {
			if (claudeCapped) return wait(`${routing.claudeMax} Claude lanes already run, and ${input.kind} may not start another (VR24-91)`, ranked, undefined, shortfall);
			continue;
		}
		// AR12's wait rule (VR24-202): the tier about to answer holds only refs already at or over the 95 percent
		// line, so no readable allowance is open. When one of this kind's placeable refs is a plan whose window
		// refills and it opens again inside the horizon, the lane waits for that reset instead of spending a
		// capped weekly or monthly allowance. A plan that does not refill never holds a lane: over the line is
		// still chosen when nothing better is open (blueprint 4.4 step 2).
		if (allowed.every((entry) => {
			const row = candidateRow(snapshot, entry);
			return row !== undefined && row.usedPercent.some((used) => used >= PAID_HEADROOM_PERCENT);
		})) {
			const spent = ranked.filter((entry) => (entry.verdict === "over-threshold" || entry.verdict === "chosen") && blocked(entry) === undefined);
			const returning = refillReturn(spent, order, config.resetHorizonMs);
			if (returning !== undefined) {
				return wait(
					`every ${input.kind} candidate is over the line, and ${returning.ref} refills at ${new Date(returning.until).toISOString()} (refill-first, VR24-202)`,
					ranked,
					returning.until,
					shortfall,
				);
			}
		}
		const best = [...allowed].sort((left, right) => comparePlacement(left, right, order))[0] as RankedRoute;
		const tierName = ["open and readable", "unread meter", "over the line"][index] ?? "open and readable";
		const lanes = runningOf(providerOf(best.ref), best.account);
		const refill = refillFirst(best, order) === 0 ? `${refillNote(best, order)}, ` : "";
		return {
			status: "placed",
			ref: best.ref,
			...(best.account === undefined ? {} : { account: best.account }),
			resolution,
			candidates: chosenList(ranked, best),
			facts: factsFor(best.ref),
			shortfall,
			reason: `routing.policy.${input.kind}: ${tierName} tier, ${refill}${lanes} running lane(s) on ${accounted(providerOf(best.ref), best.account)}, then pace, then the kind's order`,
			...(claudeAlias !== undefined && best.ref === claudeAlias ? { claude: true } : {}),
		};
	}

	return wait(`every ${input.kind} candidate is walled, exhausted, unconfigured or unavailable right now (blueprint 8.1)`, ranked, undefined, shortfall);
}

/**
 * Learn the quota wall a lane saw on `ref`: lifts at the reset the error names, else after the cooldown (D3, 2026-10-09).
 *
 * AR16: the wall belongs to an account, so it is recorded under that account's own key — the explicit
 * argument, else the account this process reads (`PI_ACCOUNT`, else the employer's work account, else the
 * plan's routed account). One account's wall then stops that account alone, which is what lets the other
 * account take the lane, and the bare provider key stays the operator's wall, which stops every account of
 * that provider (AR14 F1). A provider whose plan holds one account keeps today's bare key.
 */
export function learnQuotaWall(config: PoolConfig, ref: string, wall: { shapeId: string; resetAt?: number }, now: number = Date.now(), account: string | undefined = undefined): void {
	const named = account?.trim();
	const who = named === undefined || named === "" ? wallAccount(undefined) ?? laneAccountFor(ref) : named;
	persistProviderWall(wallKey(config, ref, who), wallFor(wall.resetAt, now, config).until, wall.shapeId, now);
}

/**
 * Keep what the usage snapshot says about spent windows in the learned wall file (blueprint 4.2, AR2):
 *
 * - a provider whose window of a day or more is at 100 percent is walled until that window's latest
 *   reset, under `source: "snapshot"`, so the wall survives a restart and every caller that reads the
 *   learned walls honours it;
 * - the snapshot is read at any age. A stale snapshot keeps a known exhaustion instead of lifting it,
 *   because usage inside a window never falls before its reset (G3);
 * - a later reading of the same row below 100 percent lifts the wall this function wrote, and only that
 *   one: an operator wall and an error wall are never touched;
 * - a wall that lifts later than this reading stands, so a snapshot never shortens one.
 *
 * Returns the walls it recorded, so the caller ranks this launch against them without re-reading the file.
 */
export function recordSnapshotWalls(
	snapshot: RoutingSnapshot,
	config: PoolConfig,
	now: number = Date.now(),
	path: string = learnedWallsPath(),
): Record<string, Wall> {
	const recorded: Record<string, Wall> = {};
	const learned = readLearnedWalls(now, path);
	/** One row's wall, under the account the row belongs to (AR14 design 3). */
	const recordRow = (row: RoutingUsageRow): void => {
		const key = accountWallKey(config, row.provider, row.account);
		const spent = spentWindows(row, now)[0];
		if (spent !== undefined) {
			if ((learned[key]?.until ?? 0) >= spent.resetsAt) return;
			persistProviderWall(key, spent.resetsAt, `snapshot: ${spent.windowMinutes} min window at 100 percent`, now, path, "snapshot");
			recorded[key] = { until: spent.resetsAt, source: "snapshot" };
			return;
		}
		if (learned[key]?.source === "snapshot" && row.windows.length > 0) persistProviderWall(key, now, undefined, now, path);
	};
	for (const row of snapshot.rows) {
		// A wall is written for the account Pi routes, never for the account the page shows separately (UD11):
		// the second account's spent window says nothing about the key a process without a placement uses.
		if (row.routed === false) continue;
		recordRow(row);
	}
	// AR14 design 3: an account of a plan held twice is a placement of its own, so its spent window walls that
	// account and no other. Every other `routed: false` row keeps the UD11 skip above.
	for (const row of snapshot.accounts ?? []) {
		if (row.account === undefined || !providerAccounts(row.provider).some((account) => account.label === row.account)) continue;
		recordRow(row);
	}
	return recorded;
}

/**
 * Record a learned quota wall in state/provider-walls.json. The tracked pool file is never written.
 * Operator walls stay in provider-pool.json providerWalls; loadPoolConfig merges both (later until wins).
 * A `source` is stored beside the time, so a wall read back after a restart still says where it came from.
 */
export function persistProviderWall(
	key: string,
	until: number,
	reason?: string,
	now: number = Date.now(),
	path: string = learnedWallsPath(),
	source?: Wall["source"],
): void {
	const walls: Record<string, { until: string; reason?: string; source?: Wall["source"] }> = {};
	for (const [existing, wall] of Object.entries(readLearnedWalls(now, path))) {
		walls[existing] = {
			until: new Date(wall.until).toISOString(),
			...(wall.reason ? { reason: wall.reason } : {}),
			...(wall.source ? { source: wall.source } : {}),
		};
	}
	if (until > now) {
		walls[key] = { until: new Date(until).toISOString(), ...(reason ? { reason } : {}), ...(source ? { source } : {}) };
	} else delete walls[key];
	const tmp = `${path}.${process.pid}.${now}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(tmp, `${JSON.stringify(walls, null, "\t")}\n`);
		renameSync(tmp, path);
	} catch {
		try { unlinkSync(tmp); } catch { /* the temp file may never have been created */ }
	}
}
