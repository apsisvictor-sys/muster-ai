/**
 * The account a lane starts on (CCACCT2, the operator 2026-10-27, relayed by Henry 04:22 EET).
 *
 * Before CCACCT2, the account a lane ran on was fixed by the name Pi reads in the launch's own environment:
 * `command-code` resolved through `COMMAND_CODE_API_KEY`, which was the *first* account's key, so a new launch always
 * landed on account 1 and stayed walled when account 1 answered 400 insufficient-credits, even though account 2 was
 * free. AR16's failover moves a *running* lane; nothing chose the account *before* the lane started.
 *
 * The wiring that followed (the operator 2026-10-27) routes the account that answers: `models.json` names
 * `$ACCT2_COMMAND_CODE_API_KEY` for the provider, the inventory routes that account, and the ruling leads with its
 * name, so Pi itself reads the right key. This module is what is left for the launch to decide: an account that cannot
 * start is never chosen, and a plan whose every account is out moves to another ref instead of starting into a wall.
 *
 * The rule here only reads owners that already exist:
 *
 *   - the accounts of a plan are `providerAccounts`' list (the inventory's labels, A-2/UD11);
 *   - an account's wall is `wallForCandidate`'s reading (AR14 F1), so a bare provider wall stops every account and a
 *     wall under one account's key stops only that one;
 *   - which of the open accounts takes the lane is `rankLaneRoutes`' answer, the same ranking AR14's placement door
 *     uses, so the launch and the placement can never disagree about an account;
 *   - whether an account can start at all is the caller's `configured` check (`accountConfigured`, VR24-213): an
 *     account whose own key is absent is never chosen, because the lane would start with the other account's key.
 *
 * When no account of the plan can take the lane, the launch moves to another ref: the operator's order first
 * (`LAUNCH_FALLBACK_REFS`, the two refs he named), then the pool's own `laneDefaults.pi.candidates` order. A ref the
 * pool does not offer for a Pi lane is never used, so this module cannot widen the set of models a lane may run on
 * (VR24-218). No key and no value is read here; the answer is labels and refs.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLACEABLE_VERDICTS, providerAccounts, providerOf, rankLaneRoutes, wallForCandidate, type PoolConfig, type RankedRoute, type RoutingSnapshot, type Wall } from "./provider-pool.ts";

/**
 * The refs a launch moves to when every account of the planned ref's plan is walled, in this order: the operator's own,
 * 2026-10-27 (relayed by Henry 04:22 EET), "opencode-go/deepseek-v4.1-flash, then minimax/MiniMax-M3.1-Flash". A ref
 * the pool's `laneDefaults.pi.candidates` does not carry is skipped, so the pool stays the owner of what a Pi lane
 * may run on.
 */
export const LAUNCH_FALLBACK_REFS: readonly string[] = ["opencode-go/deepseek-v4.1-flash", "minimax/MiniMax-M3.1-Flash"];

export interface LaunchAccountInput {
	config: PoolConfig;
	/** The ref the launch would use as things stand: the harness default, the placement's answer, or the operator's. */
	ref: string;
	/** The walls in force, as `activeWalls` merges them. */
	walls: Record<string, Wall>;
	now: number;
	snapshot?: RoutingSnapshot;
	/** Whether the candidate's key name is present in the lane's would-be environment, tested by name only (VR24-213). */
	configured?: (ref: string, account?: string) => boolean;
	/**
	 * The account a door already answered with, when another owner ranked the accounts (the placement's allowance rule,
	 * AR14). It is used only when it can take the lane: one rule answers "which open account", this module answers "can
	 * it start at all", so two doors never place different accounts for the same lane.
	 */
	preferred?: string;
	/**
	 * The ref the door that answered `preferred` was placing. The preference is honoured only when that ref's provider is
	 * this input ref's provider, because the account labels are not unique across providers: both of the shipped plans
	 * call theirs "first account" and "second account" (CCACCT2 Fix-gate F6).
	 */
	preferredRef?: string;
	/**
	 * The accounts account-health recorded as failing in the current hour, as `<provider>/<label>` (`readFailingAccounts`
	 * builds this). An account in this set is not offered the lane; when every account of a plan is in it, the launch
	 * moves on exactly as it does when every account is walled.
	 */
	failing?: ReadonlySet<string>;
	/** The refs a launch may move to; the pool's own Pi candidates by default. Never a ref the pool does not carry. */
	candidates?: readonly string[];
}

export interface LaunchAccountChoice {
	/** The ref the lane starts on: the input's own unless every account of its plan was unavailable. */
	ref: string;
	/** The account the lane starts on, when its plan lists accounts and one can take it. */
	account?: string;
	/** True when `ref` is not the input's ref, because no account of the input's plan could take the lane. */
	fellBack: boolean;
	/** Every account of the input's plan that could not take the lane, and why. Labels and reasons only, never a key. */
	skipped: Array<{ account: string; reason: string }>;
	/** One line for the launcher's log and the routing decision line: labels and refs, never a value. */
	reason: string;
}

/** The account names account-health writes an alert for: `<provider>/<label>` (`scripts/account-health.mts`). */
function healthName(provider: string, label: string): string {
	return `${provider}/${label}`;
}

/**
 * The first account of `ref`'s plan the ranking would place, or undefined when none can take the lane.
 *
 * Only the open accounts are offered as candidates: a walled one would rank at the end anyway (its verdict is
 * `walled`), and one account-health calls failing is not offered at all, so the ranking never has to know about
 * health. The ranking itself, its order and its verdicts are `rankLaneRoutes`' own, unchanged.
 */
function firstOpenAccount(input: LaunchAccountInput, ref: string): { usable: boolean; account?: string; ranked: RankedRoute[] } {
	const provider = providerOf(ref);
	const accounts = providerAccounts(provider);
	const failing = input.failing ?? new Set<string>();
	const offered = accounts.filter((account) => !failing.has(healthName(provider, account.label)));
	// Every account of a plan in the health record leaves nothing to offer: the plan cannot start, and the launch must
	// move on exactly as it does when every account is walled. A provider that lists no accounts has none to lose, so
	// it is still ranked as the bare ref it always was.
	if (accounts.length > 0 && offered.length === 0) return { usable: false, ranked: [] };
	const ranked = rankLaneRoutes({
		config: input.config,
		candidates: offered.length === 0 ? [ref] : offered.map((account) => ({ ref, account: account.label })),
		walls: input.walls,
		available: () => true,
		...(input.configured === undefined ? {} : { configured: input.configured }),
		...(input.snapshot === undefined ? {} : { snapshot: input.snapshot }),
		now: input.now,
		freeRefsLast: false,
	});
	const placeable = (entry: RankedRoute | undefined): entry is RankedRoute => entry !== undefined && PLACEABLE_VERDICTS.includes(entry.verdict);
	// The door's own answer wins when it can start; otherwise the ranking's head is the account.
	const preferred =
		input.preferred === undefined || input.preferredRef === undefined || providerOf(input.preferredRef) !== provider
			? undefined
			: ranked.find((entry) => entry.account === input.preferred && placeable(entry));
	const chosen = preferred ?? ranked[0];
	return placeable(chosen) ? { usable: true, account: chosen.account, ranked } : { usable: false, ranked };
}

/**
 * Why an account of `ref`'s plan cannot take the lane, as one plain phrase: the wall that stops it (with its source and
 * the moment it lifts), the account-health reading, or the ranking's own verdict when its key is absent.
 */
function skipReason(input: LaunchAccountInput, ref: string, label: string, ranked: readonly RankedRoute[]): string {
	const wall = wallForCandidate(input.config, input.walls, { ref, account: label });
	if (wall !== undefined && wall.until > input.now) return `walled until ${new Date(wall.until).toISOString()} (${wall.source})`;
	if (input.failing?.has(healthName(providerOf(ref), label)) === true) return "account-health recorded it failing this hour";
	const entry = ranked.find((candidate) => candidate.account === label);
	return entry?.reason ?? "not placeable";
}

/**
 * The refs a launch may move to, in order: the operator's two, then the pool's own Pi candidates, each once, minus the ref
 * the launch already has, and never a ref the pool does not carry for a Pi lane.
 */
function fallbackRefs(input: LaunchAccountInput): string[] {
	const poolCandidates = input.config.laneDefaults?.pi.candidates ?? [];
	const offered = input.candidates ?? [...LAUNCH_FALLBACK_REFS, ...poolCandidates];
	const seen = new Set<string>([input.ref]);
	const out: string[] = [];
	for (const ref of offered) {
		if (seen.has(ref) || !poolCandidates.includes(ref)) continue;
		seen.add(ref);
		out.push(ref);
	}
	return out;
}

/**
 * The account a lane starts on, and the ref it starts on when no account of its plan can take it.
 *
 * A plan held once is returned unchanged and names no account: the one-account behaviour every launch had is what a
 * provider without an account list keeps. A plan held twice is offered only to an account that is not walled, not
 * failing its health check and whose own key is present; when no account qualifies the launch moves to the first ref
 * of `fallbackRefs` that can start, and the answer says it fell back.
 */
export function chooseLaunchAccount(input: LaunchAccountInput): LaunchAccountChoice {
	const provider = providerOf(input.ref);
	const accounts = providerAccounts(provider);
	if (accounts.length < 2) return { ref: input.ref, fellBack: false, skipped: [], reason: `${provider} holds one account` };

	const first = firstOpenAccount(input, input.ref);
	// A passed-over account is one that could not take the lane at all: walled, failing its health check, or without its
	// own key. An account the ranking merely ranked lower is not skipped, it is simply second in the rule's order.
	const skipped = first.account === undefined
		? accounts.map((account) => ({ account: account.label, reason: skipReason(input, input.ref, account.label, first.ranked) }))
		: accounts
				.filter((account) => account.label !== first.account)
				.filter((account) => {
					if (input.failing?.has(healthName(provider, account.label)) === true) return true;
					const wall = wallForCandidate(input.config, input.walls, { ref: input.ref, account: account.label });
					if (wall !== undefined && wall.until > input.now) return true;
					const entry = first.ranked.find((candidate) => candidate.account === account.label);
					return entry === undefined || !PLACEABLE_VERDICTS.includes(entry.verdict);
				})
				.map((account) => ({ account: account.label, reason: skipReason(input, input.ref, account.label, first.ranked) }));
	if (first.account !== undefined) {
		const passedOver = skipped.length === 0 ? "" : `; passed over ${skipped.map((entry) => `${entry.account} (${entry.reason})`).join(", ")}`;
		return {
			ref: input.ref,
			...(first.account === undefined ? {} : { account: first.account }),
			fellBack: false,
			skipped,
			reason: `${provider} starts on ${first.account ?? "the plan's own account"}${passedOver}`,
		};
	}

	const walled = skipped.map((entry) => `${entry.account} (${entry.reason})`).join(", ");
	for (const ref of fallbackRefs(input)) {
		const next = firstOpenAccount(input, ref);
		if (!next.usable) continue;
		const account = next.account === undefined ? "" : ` on ${next.account}`;
		return {
			ref,
			...(next.account === undefined ? {} : { account: next.account }),
			fellBack: true,
			skipped,
			reason: `every ${provider} account is out (${walled}), so the launch moves to ${ref}${account}`,
		};
	}
	return {
		ref: input.ref,
		fellBack: false,
		skipped,
		reason: `every ${provider} account is out (${walled}) and no other ref the pool carries for a Pi lane can start`,
	};
}

/**
 * The hour bucket `scripts/account-health.mts` writes beside a failing account (`hourBucket(now)`, `YYYY-MM-DDTHH`).
 *
 * It is repeated here because that module is not loadable under plain node (a constructor parameter property, which
 * type stripping refuses) and the launcher's helper runs under plain node. The reader below is one `JSON.parse` of one
 * field, so the two can only differ in the field they read, which is the file the owner names.
 */
function hourBucket(at: number): string {
	return new Date(at).toISOString().slice(0, 13);
}

/**
 * The accounts account-health recorded as failing in the current hour, as `<provider>/<label>`, read from the owner's
 * own record: `<stateDir>/account-health/alerts.json`, whose `accounts` map holds `<provider>/<label>` → hour bucket.
 *
 * A missing, torn or unreadable file is no signal rather than a wrong one: the launch then reads the walls alone,
 * exactly as before this reader existed. An alert from an earlier hour is not a reading of this hour and is dropped,
 * so a recovered account is offered again as soon as its hour passes.
 */
export function readFailingAccounts(stateDir: string, now: number): ReadonlySet<string> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(join(stateDir, "account-health", "alerts.json"), "utf8"));
	} catch {
		return new Set<string>();
	}
	const accounts = (parsed as { accounts?: unknown } | null)?.accounts;
	if (accounts === null || typeof accounts !== "object") return new Set<string>();
	const bucket = hourBucket(now);
	const failing = new Set<string>();
	for (const [name, recorded] of Object.entries(accounts as Record<string, unknown>)) {
		if (recorded === bucket) failing.add(name);
	}
	return failing;
}
