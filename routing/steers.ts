/**
 * The steer layer: a person's temporary, scoped routing instruction, kept in one append-only journal and
 * applied over the tracked pool file when that file is read (S-steer of
 * `~/research/router-steers-2026-10-29/architecture-v2.md`, sections 3, 4, 7 and 9, with findings 1, 2, 4,
 * 6, 10, 14 and 21 of its review).
 *
 * The rules the shape carries:
 * - `provider-pool.json` is the base. This module reads it (`loadPoolConfig`) and composes the result in
 *   memory: no second base copy, no compiler, no rewritten file (findings 1 and 2).
 * - `state/steers.jsonl` is the only record of a steer, and one writer appends to it: the `muster steer`
 *   verb, whose author is the identity the control channel proved for the calling session, never a field a
 *   caller may set (finding 4). Every write holds a lock, so two writers cannot interleave, and a read skips
 *   a torn last line instead of failing (finding 14).
 * - Expiry is re-evaluated from the journal on every read, never cached. A `manual` steer stays live past
 *   its `reviewAt` and reports the review as due; it never lifts by itself (finding 21). `routing.paused`
 *   is the operator's own pause: nothing here reads or writes it, and no steer lifts it (VR24-113).
 * - A steer may name a project, a harness or an account, and the scope is applied where the placement knows
 *   them, never baked into a global result (finding 6). Capacity (`claudeMax`, `hardMax`, `slots`) is a
 *   record of its own, so "cap this provider except for this lane kind" is expressible without conflating
 *   capacity with eligibility (finding 10).
 */

import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { appendFsyncedLineTo } from "../core/append-line.ts";
import { loadPoolConfig, type PoolConfig } from "./provider-pool.ts";

/** The authors the channel admits (blueprint section 3). A seat identity resolves to one of these or is refused. */
export const STEER_AUTHORS = ["operator", "henry", "orchestrator"] as const;
export type SteerAuthor = (typeof STEER_AUTHORS)[number];

export const STEER_ACTIONS = ["exclude", "demote", "prefer"] as const;
export type SteerAction = (typeof STEER_ACTIONS)[number];

/** A capacity field a capOverride may set. `pick`, `paused`, `policy` and `kindRules` are not capacity. */
export const STEER_CAP_FIELDS = ["claudeMax", "hardMax", "slots"] as const;
export type SteerCapField = (typeof STEER_CAP_FIELDS)[number];

/** No steer reaches further than a week: a steer is temporary by construction (blueprint section 3). */
export const STEER_MAX_AHEAD_MS = 7 * 24 * 3_600_000;
/** Compaction runs inside the writer once the journal passes this size (blueprint section 2). */
export const STEER_JOURNAL_MAX_BYTES = 1_048_576;
/** An expired or retired entry older than this is dropped by compaction. */
export const STEER_RETENTION_MS = 30 * 24 * 3_600_000;
const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 10;
const REASON_MAX_CHARS = 300;
const SOURCE_MAX_CHARS = 2_000;

/**
 * Where a steer applies. Every field is optional and an absent field matches everything, so an empty scope
 * is one steer for all placements. `role` is the role or task kind a placement asks for; `"*"` is the
 * explicit spelling of "every role".
 */
export interface SteerScope {
	role?: string;
	ref?: string;
	provider?: string;
	account?: string;
	harness?: "pi" | "opencode" | "claude";
	project?: string;
}

/**
 * When a steer lifts. `at` is a clock the caller names. `meter-reset` lifts at the meter's own reset, no
 * later than `fallbackAt`, which is the clock a caller without a meter reading uses. `manual` never lifts by
 * itself: past `reviewAt` it stays live and the review is due (finding 21).
 */
export type SteerExpiry =
	| { type: "at"; at: string }
	| { type: "meter-reset"; meter: string; fallbackAt: string }
	| { type: "manual"; reviewAt: string };

export interface SteerSource {
	/** The chat text the steer came from, when the author quoted one. */
	chat?: string;
}

/** One `add` line for a steer: the journal's own record, exactly as it was written. */
export interface SteerAddRecord {
	op: "add";
	kind: "steer";
	id: string;
	scope: SteerScope;
	action: SteerAction;
	reason: string;
	author: SteerAuthor;
	source: SteerSource & { ts: string };
	expiry: SteerExpiry;
	createdAt: string;
}

/** One `add` line for a capacity change. Time expiry only, and capacity only (finding 10). */
export interface SteerCapRecord {
	op: "add";
	kind: "cap";
	id: string;
	scope: SteerScope;
	capOverride: { field: SteerCapField; value: number; until: string };
	reason: string;
	author: SteerAuthor;
	source: SteerSource & { ts: string };
	createdAt: string;
}

export type SteerAdd = SteerAddRecord | SteerCapRecord;

/** A retirement is a second line, never an edit: the journal stays append-only. */
export interface SteerRetireRecord {
	op: "retire";
	id: string;
	at: string;
	by: SteerAuthor;
}

export type SteerJournalRecord = SteerAdd | SteerRetireRecord;

/** One add line and the retirement a later line names for it, if any. */
export interface SteerEntry {
	record: SteerAdd;
	retiredAt?: string;
	retiredBy?: SteerAuthor;
}

export interface SteerJournalRead {
	entries: SteerEntry[];
	/** What the read skipped and why. A torn last line is one; a read never fails over one. */
	warnings: string[];
}

/** A journal entry with the reading the caller asked for: live, retired, and whether a review is due. */
export interface SteerView extends SteerEntry {
	live: boolean;
	reviewDue: boolean;
	/** The clock this entry lifts at. Absent for a `manual` steer, which has none. */
	expiresAt?: string;
}

/** `~/.pi/agent/state/steers.jsonl`, overridable for tests. */
export function steersJournalPath(env: NodeJS.ProcessEnv = process.env): string {
	return env["PI_STEERS_PATH"] ?? join(homedir(), ".pi", "agent", "state", "steers.jsonl");
}

/** The lock a writer holds while it appends: one writer, and no second lock file elsewhere. */
export function steersLockPath(journalPath: string = steersJournalPath()): string {
	return `${journalPath}.lock`;
}

export function isSteerAuthor(value: unknown): value is SteerAuthor {
	return typeof value === "string" && (STEER_AUTHORS as readonly string[]).includes(value);
}

/**
 * The journal's own records, replayed: an `add` sets the entry for its id, a `retire` marks it retired.
 * A line that does not parse (a write cut off mid-line) is skipped with a warning, so a crashed write
 * leaves the rest of the journal readable. The order is the order the adds were written.
 */
export function readSteerJournal(path: string = steersJournalPath()): SteerJournalRead {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], warnings: [] };
		return { entries: [], warnings: [`${path}: ${error instanceof Error ? error.message : String(error)}`] };
	}
	const entries = new Map<string, SteerEntry>();
	const warnings: string[] = [];
	for (const [index, line] of text.split("\n").entries()) {
		if (line.trim() === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			warnings.push(`line ${index + 1} skipped: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		if (parsed === null || typeof parsed !== "object") {
			warnings.push(`line ${index + 1} skipped: not an object`);
			continue;
		}
		const record = parsed as Partial<SteerJournalRecord>;
		if (record.op === "add" && typeof record.id === "string") {
			entries.set(record.id, { record: record as SteerAdd });
			continue;
		}
		if (record.op === "retire" && typeof record.id === "string") {
			const entry = entries.get(record.id);
			if (entry === undefined) {
				warnings.push(`line ${index + 1}: a retirement names unknown steer ${record.id}`);
				continue;
			}
			entries.set(record.id, { ...entry, retiredAt: record.at, ...(isSteerAuthor(record.by) ? { retiredBy: record.by } : {}) });
			continue;
		}
		warnings.push(`line ${index + 1} skipped: unknown op ${JSON.stringify(record.op)}`);
	}
	return { entries: [...entries.values()], warnings };
}

/** The moment an entry lifts, when it has one. A `manual` steer has none: it waits for its review. */
export function steerExpiresAt(record: SteerAdd, ctx: Pick<SteerContext, "meterResetAt"> = {}): number | undefined {
	const expiry = record.kind === "cap" ? { type: "at" as const, at: record.capOverride.until } : record.expiry;
	if (expiry.type === "at") return Date.parse(expiry.at);
	if (expiry.type === "manual") return undefined;
	const fallback = Date.parse(expiry.fallbackAt);
	const meter = ctx.meterResetAt?.(expiry.meter);
	return meter === undefined || !Number.isFinite(meter) ? fallback : Math.min(fallback, meter);
}

/**
 * The journal as one placement reads it: live or not, and whether a manual steer's review is due. Liveness is
 * computed here, at the reading's own `now`, so a caller never uses a stale answer.
 */
export function steerView(read: SteerJournalRead, now: number, ctx: Pick<SteerContext, "meterResetAt"> = {}): SteerView[] {
	return read.entries.map((entry) => {
		const expiresAt = steerExpiresAt(entry.record, ctx);
		const retired = entry.retiredAt !== undefined;
		const live = !retired && (expiresAt === undefined || expiresAt > now);
		const reviewDue = entry.record.kind === "steer" && entry.record.expiry.type === "manual" && !retired && now >= Date.parse(entry.record.expiry.reviewAt);
		return {
			...entry,
			live,
			reviewDue,
			...(expiresAt === undefined ? {} : { expiresAt: new Date(expiresAt).toISOString() }),
		};
	});
}

/** Where a placement is being made: the facts a scope is matched against. */
export interface SteerContext {
	now: number;
	/** The role or task kind the placement asks for. */
	role?: string;
	harness?: "pi" | "opencode" | "claude";
	project?: string;
	/** The account a placement names, when it names one. An account-scoped steer matches nowhere else. */
	account?: string;
	/** A meter's reset, when the caller read one: a `meter-reset` steer lifts no later than it. */
	meterResetAt?: (meter: string) => number | undefined;
}

/** The dimensions of a scope that are facts of the placement rather than of the ref it reaches. */
function contextMatches(scope: SteerScope, ctx: SteerContext): boolean {
	if (scope.role !== undefined && scope.role !== "*" && scope.role !== ctx.role) return false;
	if (scope.harness !== undefined && scope.harness !== ctx.harness) return false;
	if (scope.project !== undefined && scope.project !== ctx.project) return false;
	if (scope.account !== undefined && scope.account !== ctx.account) return false;
	return true;
}

/** The dimensions that name the refs a steer reaches: matched against each list's own entries. */
function refMatches(scope: SteerScope, ref: string): boolean {
	if (scope.ref !== undefined && ref !== scope.ref) return false;
	if (scope.provider !== undefined && !ref.startsWith(`${scope.provider}/`)) return false;
	return true;
}

/** Every list in the pool that names a ref a placement may read. A steer moves or removes refs here only. */
function refLists(config: PoolConfig): string[][] {
	const lists: string[][] = Object.values(config.roles);
	const defaults = config.laneDefaults;
	if (defaults !== undefined) {
		lists.push(defaults.pi.candidates);
		if (defaults.pi.hard !== undefined) lists.push(defaults.pi.hard);
		lists.push(defaults.opencode);
	}
	if (config.routing !== undefined) lists.push(...Object.values(config.routing.policy));
	return lists;
}

/** A copy whose every ref list is its own array, so applying a steer never mutates the base a caller holds. */
function copyOf(config: PoolConfig): PoolConfig {
	const defaults = config.laneDefaults;
	const routing = config.routing;
	const copy: PoolConfig = {
		...config,
		providerWalls: { ...config.providerWalls },
		roles: Object.fromEntries(Object.entries(config.roles).map(([role, refs]) => [role, [...refs]])),
		freeRefs: [...config.freeRefs],
		employerAccounts: [...config.employerAccounts],
		nonChatRoles: [...config.nonChatRoles],
		quotaShapes: [...config.quotaShapes],
	};
	if (defaults !== undefined) {
		copy.laneDefaults = {
			pi: {
				candidates: [...defaults.pi.candidates],
				fallbackRole: defaults.pi.fallbackRole,
				...(defaults.pi.hard === undefined ? {} : { hard: [...defaults.pi.hard] }),
			},
			opencode: [...defaults.opencode],
			claude: defaults.claude,
		};
	}
	if (routing !== undefined) {
		copy.routing = {
			...routing,
			// the operator's pause is carried and never edited: cloning it is the one thing this module does with it.
			paused: [...routing.paused],
			policy: Object.fromEntries(Object.entries(routing.policy).map(([kind, refs]) => [kind, [...refs]])),
			kindRules: Object.fromEntries(Object.entries(routing.kindRules).map(([project, rules]) => [project, { ...rules }])),
		};
	}
	return copy;
}

function createdOf(record: SteerAdd): number {
	const at = Date.parse(record.createdAt);
	return Number.isFinite(at) ? at : 0;
}

/**
 * Newest first, and inside one millisecond the journal's own order: the sort is stable and
 * `readSteerJournal` keeps insertion order, so two steers written in the same millisecond never swap
 * places by id (main's `7491cb9` settled the same rule for asks).
 */
function newestFirst(left: SteerView, right: SteerView): number {
	return createdOf(right.record) - createdOf(left.record);
}

/**
 * The pool file as one placement reads it: the tracked file with the journal's live, scope-matching steers
 * applied. Excludes run first, then demotes, then prefers, newest first inside each: a demote never removes
 * a ref, so no steer can empty a chain by itself, and a the operator exclude is never put back by a prefer.
 *
 * The result is a new object; `config` and `routing.paused` are never written by this or any other call here.
 */
export function applySteers(config: PoolConfig, read: SteerJournalRead, ctx: SteerContext): PoolConfig {
	const view = steerView(read, ctx.now, ctx);
	const steered = copyOf(config);
	const lists = refLists(steered);
	// A steer is read here when its placement facts match; which refs it reaches is decided list by list.
	const live = view.filter((entry) => entry.live && contextMatches(entry.record.scope, ctx));
	for (const action of STEER_ACTIONS) {
		const records = live
			.filter((entry): entry is SteerView & { record: SteerAddRecord } => entry.record.kind === "steer" && entry.record.action === action)
			.sort(newestFirst);
		for (const { record } of records) {
			for (const refs of lists) {
				const matched = refs.filter((ref) => refMatches(record.scope, ref));
				if (matched.length === 0) continue;
				const keep = refs.filter((ref) => !matched.includes(ref));
				refs.splice(0, refs.length, ...(action === "exclude" ? keep : action === "demote" ? [...keep, ...matched] : [...matched, ...keep]));
			}
		}
	}
	// Capacity is its own record and only its own record: oldest first, so the newest override of a field wins,
	// and inside one millisecond the journal's own order decides, exactly as it does for steers.
	const caps = view
		.filter((entry): entry is SteerView & { record: SteerCapRecord } => entry.live && entry.record.kind === "cap")
		.sort((left, right) => createdOf(left.record) - createdOf(right.record));
	for (const { record } of caps) {
		const routing = steered.routing;
		if (routing === undefined) continue;
		if (!contextMatches(record.scope, ctx)) continue;
		const field = record.capOverride.field;
		if (field !== "claudeMax" && field !== "hardMax" && field !== "slots") continue;
		routing[field] = record.capOverride.value;
	}
	return steered;
}

export interface SteeredPool {
	config: PoolConfig;
	journal: SteerJournalRead;
	warnings: string[];
}

export type SteeredPoolResult = ({ ok: true } & SteeredPool) | { ok: false; errors: string[] };

export interface SteeredPoolOptions {
	poolPath?: string;
	journalPath?: string;
	env?: NodeJS.ProcessEnv;
}

/**
 * The one read a placement makes: the tracked pool file, the journal, and the result composed in memory.
 * A journal that cannot be read leaves the file's own answer with a warning (finding 20: fail open to base,
 * never to a stale result). `MUSTER_STEERS=off` is the kill switch: the base stands alone.
 */
export function loadSteeredPool(ctx: SteerContext, options: SteeredPoolOptions = {}): SteeredPoolResult {
	const env = options.env ?? process.env;
	const loaded = loadPoolConfig(options.poolPath, ctx.now);
	if (!loaded.ok) return loaded;
	const warnings = [...(loaded.warnings ?? [])];
	if (env["MUSTER_STEERS"] === "off") {
		return { ok: true, config: loaded.config, journal: { entries: [], warnings: [] }, warnings: [...warnings, "steers are off (MUSTER_STEERS=off)"] };
	}
	const journal = readSteerJournal(options.journalPath);
	if (journal.warnings.length > 0) warnings.push(...journal.warnings.map((warning) => `steers: ${warning}`));
	return { ok: true, config: applySteers(loaded.config, journal, ctx), journal, warnings };
}

class SteerLockTimeout extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SteerLockTimeout";
	}
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockAge(lockPath: string): number | undefined {
	try {
		return Date.now() - statSync(lockPath).mtimeMs;
	} catch {
		return undefined;
	}
}

/** One writer at a time: `wx` creates the lock, a lock older than its keep-alive is stale and is taken. */
function acquireLock(lockPath: string, waitMs: number): number {
	mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
	const deadline = Date.now() + waitMs;
	for (;;) {
		try {
			const fd = openSync(lockPath, "wx", 0o600);
			writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
			return fd;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const age = lockAge(lockPath);
			if (age !== undefined && age > LOCK_STALE_MS) {
				try {
					unlinkSync(lockPath);
				} catch {
					// Another writer took the stale lock first; the next attempt sees its lock.
				}
				continue;
			}
			if (Date.now() >= deadline) throw new SteerLockTimeout(`another writer holds ${lockPath}`);
			sleepSync(LOCK_POLL_MS);
		}
	}
}

function withLock<T>(journalPath: string, waitMs: number, body: () => T): T {
	const lockPath = steersLockPath(journalPath);
	const fd = acquireLock(lockPath, waitMs);
	try {
		return body();
	} finally {
		closeSync(fd);
		try {
			unlinkSync(lockPath);
		} catch {
			// A lock already gone is the state this call wanted.
		}
	}
}

function journalBytes(journalPath: string): number {
	try {
		return statSync(journalPath).size;
	} catch {
		return 0;
	}
}

/**
 * Rewrite the journal under the writer's own lock: every entry still inside the retention window, one add
 * line each, its retirement after it. The new file is written whole and renamed into place, so a reader
 * sees the old journal or the new one and never half of either.
 */
function compactJournal(journalPath: string, now: number): void {
	const read = readSteerJournal(journalPath);
	const lines: string[] = [];
	for (const entry of read.entries) {
		const expiresAt = steerExpiresAt(entry.record);
		const retired = entry.retiredAt === undefined ? undefined : Date.parse(entry.retiredAt);
		const over = retired !== undefined ? now - retired >= STEER_RETENTION_MS : expiresAt !== undefined && now - expiresAt >= STEER_RETENTION_MS;
		if (over) continue;
		lines.push(JSON.stringify(entry.record));
		if (entry.retiredAt !== undefined) {
			lines.push(JSON.stringify({ op: "retire", id: entry.record.id, at: entry.retiredAt, ...(entry.retiredBy === undefined ? {} : { by: entry.retiredBy }) } satisfies SteerRetireRecord));
		}
	}
	const scratch = `${journalPath}.compaction`;
	writeFileSync(scratch, lines.length === 0 ? "" : `${lines.join("\n")}\n`, { mode: 0o600 });
	renameSync(scratch, journalPath);
}

function compactIfNeeded(journalPath: string, now: number, maxBytes: number): void {
	if (journalBytes(journalPath) < maxBytes) return;
	compactJournal(journalPath, now);
}

export interface SteerWriteOptions {
	journalPath?: string;
	lockWaitMs?: number;
	/** Compaction's size trigger. A test sets it low; a run never changes it. */
	maxJournalBytes?: number;
}

export interface AddSteerInput {
	/** The identity the control channel proved. The verb passes `requireAgentId`'s answer, never a flag. */
	author: string;
	action: SteerAction;
	scope: SteerScope;
	reason: string;
	expiry: SteerExpiry;
	source?: SteerSource;
	now?: number;
	id?: string;
}

export interface AddCapOverrideInput {
	author: string;
	scope: SteerScope;
	field: SteerCapField;
	value: number;
	until: string;
	reason: string;
	source?: SteerSource;
	now?: number;
	id?: string;
}

export type SteerWriteResult = { ok: true; record: SteerAdd } | { ok: false; errors: string[] };

function scopeErrors(scope: SteerScope): string[] {
	const errors: string[] = [];
	if (scope.harness !== undefined && !["pi", "opencode", "claude"].includes(scope.harness)) errors.push(`harness ${JSON.stringify(scope.harness)}: use pi, opencode or claude`);
	if (scope.ref !== undefined && (scope.ref.includes(" ") || !scope.ref.includes("/"))) errors.push(`ref ${JSON.stringify(scope.ref)}: use provider/model`);
	if (scope.provider !== undefined && (scope.provider.includes(" ") || scope.provider.includes("/"))) errors.push(`provider ${JSON.stringify(scope.provider)}: use the provider alone`);
	if (scope.role !== undefined && scope.role.trim() === "") errors.push("role: use a role name or *");
	for (const key of ["project", "account"] as const) {
		const value = scope[key];
		if (value !== undefined && (value.trim() === "" || value.includes(" "))) errors.push(`${key} ${JSON.stringify(value)}: use one word`);
	}
	return errors;
}

function commonErrors(input: { author: string; reason: string; scope: SteerScope; source?: SteerSource }, now: number, ahead: number[], pastAllowed = false): string[] {
	const errors: string[] = [];
	if (!isSteerAuthor(input.author)) errors.push(`author ${JSON.stringify(input.author)}: a steer is accepted from ${STEER_AUTHORS.join(", ")} only`);
	if (input.reason.trim() === "") errors.push("reason: a steer carries the reason it was given");
	else if (input.reason.length > REASON_MAX_CHARS) errors.push(`reason: ${input.reason.length} characters, at most ${REASON_MAX_CHARS}`);
	if (input.source?.chat !== undefined && input.source.chat.length > SOURCE_MAX_CHARS) errors.push(`chat: ${input.source.chat.length} characters, at most ${SOURCE_MAX_CHARS}`);
	errors.push(...scopeErrors(input.scope));
	for (const at of ahead) {
		if (!Number.isFinite(at)) errors.push(`expiry: ${JSON.stringify(at)} is not a time`);
		else if (!pastAllowed && at <= now) errors.push(`expiry: ${new Date(at).toISOString()} has already passed`);
		else if (at > now + STEER_MAX_AHEAD_MS) errors.push(`expiry: ${new Date(at).toISOString()} is further than seven days out`);
	}
	return errors;
}

/**
 * Append one steer. Validated first, then written under the journal's lock, so a refused steer leaves no
 * line and two writers never interleave.
 */
export function addSteer(input: AddSteerInput, options: SteerWriteOptions = {}): SteerWriteResult {
	const now = input.now ?? Date.now();
	const at = input.expiry.type === "at" ? [Date.parse(input.expiry.at)] : input.expiry.type === "meter-reset" ? [Date.parse(input.expiry.fallbackAt)] : [Date.parse(input.expiry.reviewAt)];
	if (input.expiry.type === "meter-reset" && input.expiry.meter.trim() === "") at.push(Number.NaN);
	// A manual steer's clock is the review, not the lift: a review already due is a steer to look at now.
	const errors = commonErrors(input, now, at, input.expiry.type === "manual");
	if (!STEER_ACTIONS.includes(input.action)) errors.push(`action ${JSON.stringify(input.action)}: use exclude, demote or prefer`);
	if (errors.length > 0) return { ok: false, errors };
	const createdAt = new Date(now).toISOString();
	const record: SteerAddRecord = {
		op: "add",
		kind: "steer",
		id: input.id ?? `st-${randomUUID()}`,
		scope: input.scope,
		action: input.action,
		reason: input.reason,
		author: input.author as SteerAuthor,
		source: { ...(input.source?.chat === undefined ? {} : { chat: input.source.chat }), ts: createdAt },
		expiry: input.expiry,
		createdAt,
	};
	return appendRecord(record, now, options);
}

/** Append one capacity override. Capacity only, a clock only: `pick`, `paused` and `policy` are refused. */
export function addCapOverride(input: AddCapOverrideInput, options: SteerWriteOptions = {}): SteerWriteResult {
	const now = input.now ?? Date.now();
	const errors = commonErrors(input, now, [Date.parse(input.until)]);
	if (!(STEER_CAP_FIELDS as readonly string[]).includes(input.field)) errors.push(`field ${JSON.stringify(input.field)}: use ${STEER_CAP_FIELDS.join(", ")}`);
	if (!Number.isFinite(input.value) || input.value < 0 || !Number.isInteger(input.value)) errors.push(`value ${JSON.stringify(input.value)}: use a whole number of zero or more`);
	if (input.scope.ref !== undefined || input.scope.provider !== undefined || input.scope.account !== undefined) errors.push("a capacity override names a role, a harness or a project, never a ref, a provider or an account");
	if (errors.length > 0) return { ok: false, errors };
	const createdAt = new Date(now).toISOString();
	const record: SteerCapRecord = {
		op: "add",
		kind: "cap",
		id: input.id ?? `st-${randomUUID()}`,
		scope: input.scope,
		capOverride: { field: input.field, value: input.value, until: input.until },
		reason: input.reason,
		author: input.author as SteerAuthor,
		source: { ...(input.source?.chat === undefined ? {} : { chat: input.source.chat }), ts: createdAt },
		createdAt,
	};
	return appendRecord(record, now, options);
}

function appendRecord(record: SteerAdd, now: number, options: SteerWriteOptions): SteerWriteResult {
	const journalPath = options.journalPath ?? steersJournalPath();
	try {
		withLock(journalPath, options.lockWaitMs ?? LOCK_WAIT_MS, () => {
			appendFsyncedLineTo(journalPath, `${JSON.stringify(record)}\n`);
			compactIfNeeded(journalPath, now, options.maxJournalBytes ?? STEER_JOURNAL_MAX_BYTES);
		});
		return { ok: true, record };
	} catch (error) {
		return { ok: false, errors: [`${journalPath}: ${error instanceof Error ? error.message : String(error)}`] };
	}
}

export type SteerRetireResult = { ok: true; record: SteerRetireRecord } | { ok: false; errors: string[] };

/** Retire one steer with a second line. A steer that is not there is a refusal, never a silent success. */
export function retireSteer(id: string, by: string, options: SteerWriteOptions & { now?: number } = {}): SteerRetireResult {
	const now = options.now ?? Date.now();
	if (!isSteerAuthor(by)) return { ok: false, errors: [`author ${JSON.stringify(by)}: a retirement is recorded from ${STEER_AUTHORS.join(", ")} only`] };
	const journalPath = options.journalPath ?? steersJournalPath();
	try {
		return withLock(journalPath, options.lockWaitMs ?? LOCK_WAIT_MS, () => {
			const read = readSteerJournal(journalPath);
			const entry = read.entries.find((candidate) => candidate.record.id === id);
			if (entry === undefined) return { ok: false as const, errors: [`no steer ${id} in ${journalPath}`] };
			if (entry.retiredAt !== undefined) return { ok: false as const, errors: [`steer ${id} was already retired at ${entry.retiredAt}`] };
			const record: SteerRetireRecord = { op: "retire", id, at: new Date(now).toISOString(), by: by as SteerAuthor };
			appendFsyncedLineTo(journalPath, `${JSON.stringify(record)}\n`);
			compactIfNeeded(journalPath, now, options.maxJournalBytes ?? STEER_JOURNAL_MAX_BYTES);
			return { ok: true as const, record };
		});
	} catch (error) {
		return { ok: false, errors: [`${journalPath}: ${error instanceof Error ? error.message : String(error)}`] };
	}
}

/** Compaction, for the runs that want it on demand: the same body the writer uses at its size trigger. */
export function compactSteerJournal(journalPath: string = steersJournalPath(), now: number = Date.now()): { before: number; after: number } {
	const before = journalBytes(journalPath);
	return withLock(journalPath, LOCK_WAIT_MS, () => {
		compactJournal(journalPath, now);
		return { before, after: journalBytes(journalPath) };
	});
}
