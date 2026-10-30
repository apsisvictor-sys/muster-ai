/**
 * Muster seats: `orchestrator` and `architect` as roles one session at a time
 * holds, Claude Code or Pi (LD20 to LD24, seats blueprint 2026-10-12).
 *
 * Authority belongs to the seat, never to a session name. A seat record carries
 * the holder (harness, session, physical process), an epoch that rises on every
 * change of holder, and the hash of the credential handed to the holder. The
 * record lives in the same compare-and-set store the programme owner uses
 * (`owner-fence.ts`) and is fenced with the same `ownerFenceSatisfied` check;
 * `seatStore` picks which backend that store is (LC4): the files store today,
 * the ledger when `<stateDir>/backend.json` says so.
 *
 * Moving a seat needs proof that the operator typed the phrase at a terminal:
 * - in process: the Pi adapter checked `source === "interactive"` itself;
 * - a ticket: the Claude adapter, after seeing `origin.kind === "composer"`,
 *   writes `<stateDir>/seats/<role>.ticket` (`writeSeatTicket`). The owner
 *   consumes it inside the same compare-and-set update that records the claim.
 * There is deliberately no verb that writes a ticket: a model running
 * `muster seat claim` from its own shell has none (blueprint R1).
 *
 * LD36 (2026-10-16) adds a third proof, the assignment: `assignSeat` writes
 * `<stateDir>/seats/<role>.assignment` (nonce, role, target session and harness,
 * `assignedBy`, `writtenAt`) inside the seat transition, and a claim presenting
 * its nonce takes the seat with no typed phrase — the operator's shell or the Muster
 * gateway moves the seat. The new holder records `assignedBy` (and the
 * assignment's `writtenAt`), a replaced holding ends with `how: "assign"`, and
 * any successful claim, rebind or release removes a pending assignment. There
 * is still no verb that writes a ticket.
 *
 * An empty seat at epoch 0 (never claimed) enforces nothing: the name is
 * accepted as before, so this can merge before the operator's first claim.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { writeInboxMessage } from "./lib/agent-inbox.ts";
import { claudeSessionLane, isOwnAncestor, ownClaudeLane } from "./lib/claude-lane-card.ts";
import { SEAT_ENV_ROLE, SEAT_ENV_TOKEN } from "./lib/seat-env.ts";
import { procPidAlive, procStartTime } from "./lib/lane-directory.ts";
import { musterStateDir } from "./binding.ts";
import { readBackend } from "./ledger/backend.ts";
import { ledgerCasStore, ledgerSocketPath } from "./ledger/cas-store.ts";
import { CAS_ATTEMPTS, fileCasStore, ownerFenceSatisfied, type CasStore, type CasStoreOptions, type OwnerFence } from "./owner-fence.ts";

export const SEAT_SCHEMA_VERSION = 1 as const;
export const SEAT_ROLES = ["orchestrator", "architect"] as const;
export type SeatRole = (typeof SEAT_ROLES)[number];
export type SeatHarness = "claude" | "pi";

/** The environment names a holder's session carries (owned by `lib/seat-env.ts`); the adapters set them and the bus reads them. */
export { SEAT_ENV_ROLE, SEAT_ENV_TOKEN };
/** Exit code of a bus command refused for a missing or stale seat credential (sysexits EX_NOPERM), so a waiter can tell it from any other failure. */
export const SEAT_REFUSED_EXIT = 77;
/** A seat with no live session is reported to the operator after this long (LD24). */
export const SEAT_ORPHAN_AFTER_MS = 15 * 60_000;

/** A ticket is valid for 10 seconds from the moment the adapter writes it. */
export const SEAT_TICKET_TTL_MS = 10_000;
/** A ticket stamped further in the future than this is refused (clock skew allowance). */
const SEAT_TICKET_SKEW_MS = 1_000;
/** An assignment is valid for 10 minutes from the moment the assigner wrote it (LD36). */
export const SEAT_ASSIGNMENT_TTL_MS = 10 * 60_000;
const SEAT_HISTORY_CAP = 20;
/** Name of the role in a role alias (`designer` is the architect seat). */
const SEAT_ALIASES: Readonly<Record<string, SeatRole>> = { designer: "architect" };

/** What a seat holder re-reads on claim, rebind and after a compaction (F3, the operator 2026-10-22: today's snapshot and rulings, no 10-11 files). */
const DEFAULT_DOSSIERS: Readonly<Record<SeatRole, readonly string[]>> = {
	orchestrator: [
		"plans/orchestration-2026-10-05/handoffs/orchestrator-snapshot.md",
		"plans/orchestration-2026-10-05/operator-rulings-2026-10-19.md",
		"state/orchestrator-events.log",
		"~/.claude/skills/continuous-orchestration/SKILL.md",
	],
	architect: [
		"~/.claude/skills/design-session/SKILL.md",
		"plans/orchestration-2026-10-05/handoffs/design-snapshot.md",
		"plans/orchestration-2026-10-05/design-inbox.md",
		"plans/orchestration-2026-10-05/operator-rulings-2026-10-19.md",
	],
};

export type SeatHolder = {
	harness: SeatHarness;
	sessionId: string;
	/** The physical process, as `OwnerFence.processKey`. */
	processKey: string;
	laneId?: string;
	/** Claude jsonl or Pi session file, for readers that need it. */
	transcript?: string;
	/** Hash of the credential handed to the holder. The token itself is never stored. */
	tokenSha256: string;
	since: string;
	/** The last terminal-typed prompt in the holder; the adapter writes it through `touchSeat`. */
	lastTypedAt?: string;
	/** How this holding began (LD36): the operator typed at a terminal, or an assignment from shell or gateway. */
	assignedBy?: "terminal" | "shell" | "gateway";
	/** The assignment's `writtenAt`, when this holding began by assignment. */
	writtenAt?: string;
};

/**
 * One finished holding. `from` is when the holder took the seat, `to` when it
 * ended, `how` what ended it: another session's `claim`, the holder's `release`,
 * or an assignment (`assign`, LD36).
 */
export type SeatHistoryEntry = {
	epoch: number;
	sessionId: string;
	harness: string;
	from: string;
	to: string | null;
	how: "claim" | "release" | "assign";
};

export type SeatRecord = {
	schemaVersion: typeof SEAT_SCHEMA_VERSION;
	/** Compare-and-set revision of the file; the epoch below is the authority fence. */
	revision: number;
	role: SeatRole;
	/** +1 on every claim by a different session (or onto an empty seat). 0 means never claimed. */
	epoch: number;
	holder: SeatHolder | null;
	/** Paths the next holder reads first, maintained by the holder. */
	dossier: string[];
	/** The last 20 finished holdings. */
	history: SeatHistoryEntry[];
	updatedAt: string;
};

export type SeatStateErrorCode = "missing" | "malformed" | "conflict" | "io" | "refused" | "unknown-role";

export class SeatStateError extends Error {
	// No parameter property: the OpenCode lane host loads this file through lane-lifecycle under plain node (strip-only).
	readonly code: SeatStateErrorCode;
	constructor(code: SeatStateErrorCode, message: string) {
		super(message);
		this.code = code;
		this.name = "SeatStateError";
	}
}

/** Everything the seat owner reads from outside itself, so tests need no live state. */
export type SeatContext = {
	/** Muster state dir (`state/muster`); the seat files live in `<stateDir>/seats`. */
	stateDir?: string;
	now?: () => number;
	/** Is the process named by this key still there? Default: `/proc`. */
	processAlive?: (processKey: string) => boolean;
	/** Test seam: the compare-and-set store over `<stateDir>/seats`. */
	store?: CasStore<SeatRecord>;
};

export type SeatHolderInput = {
	harness: SeatHarness;
	sessionId: string;
	processKey: string;
	laneId?: string;
	transcript?: string;
};

/** Proof that the seat may move: the phrase typed at a terminal (in-process, ticket), or an assignment (LD36). */
export type SeatProof = { kind: "in-process" } | { kind: "ticket"; nonce: string } | { kind: "assignment"; nonce: string };

export type ClaimResult = {
	role: SeatRole;
	token: string;
	epoch: number;
	/** The holder this claim replaced (null when the seat was empty). Same-session reclaims return the same session. */
	previous: SeatHolder | null;
	/** How this holding began (LD36): the terminal, or the assignment's channel. */
	assignedBy: "terminal" | "shell" | "gateway";
	/** The assignment's `writtenAt`, when this holding began by assignment. */
	writtenAt?: string;
};

export type RebindResult = { role: SeatRole; token: string; epoch: number };

export type SeatAuthorization =
	| { allowed: true; reason: "holder" | "legacy-epoch-0"; epoch: number }
	| { allowed: false; reason: "not-holder" | "superseded" | "empty"; epoch: number; message: string };

// ─── Roles, paths, store ─────────────────────────────────────────────────────

/** `designer` is an alias of `architect`. Undefined when the name is not a seat. */
export function resolveSeatRole(name: string): SeatRole | undefined {
	const lowered = name.trim().toLowerCase();
	if ((SEAT_ROLES as readonly string[]).includes(lowered)) return lowered as SeatRole;
	return SEAT_ALIASES[lowered];
}

function roleOf(name: string): SeatRole {
	const role = resolveSeatRole(name);
	if (role === undefined) throw new SeatStateError("unknown-role", `${JSON.stringify(name)} is not a seat; seats are ${SEAT_ROLES.join(", ")} (designer is the architect)`);
	return role;
}

/**
 * The seat context of a command line's environment: `PI_MUSTER_STATE_DIR` wins, as `lanesStateDir` reads it
 * (that function lives in a module `cli/types.ts` cannot import without a cycle).
 */
export function seatContextFor(env: NodeJS.ProcessEnv): SeatContext {
	const override = env["PI_MUSTER_STATE_DIR"]?.trim();
	return override !== undefined && override !== "" ? { stateDir: resolve(override) } : {};
}

export function seatsDir(ctx: SeatContext = {}): string {
	return join(ctx.stateDir ?? musterStateDir(), "seats");
}

export function seatTicketPath(role: SeatRole, ctx: SeatContext = {}): string {
	return join(seatsDir(ctx), `${role}.ticket`);
}

export function seatBadgePath(role: SeatRole, ctx: SeatContext = {}): string {
	return join(seatsDir(ctx), `${role}.badge`);
}

export function seatAssignmentPath(role: SeatRole, ctx: SeatContext = {}): string {
	return join(seatsDir(ctx), `${role}.assignment`);
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const nonNegativeInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

export function validateSeatRecord(raw: unknown): { ok: true; record: SeatRecord } | { ok: false; errors: string[] } {
	const errors: string[] = [];
	if (!isObject(raw)) return { ok: false, errors: ["record must be an object"] };
	if (raw.schemaVersion !== SEAT_SCHEMA_VERSION) errors.push(`schemaVersion must be ${SEAT_SCHEMA_VERSION}`);
	if (!nonNegativeInt(raw.revision)) errors.push("revision must be a non-negative integer");
	if (!(SEAT_ROLES as readonly unknown[]).includes(raw.role)) errors.push("role must be a seat");
	if (!nonNegativeInt(raw.epoch)) errors.push("epoch must be a non-negative integer");
	if (raw.holder !== null) {
		const holder = raw.holder;
		if (!isObject(holder)) errors.push("holder must be an object or null");
		else {
			if (holder.harness !== "claude" && holder.harness !== "pi") errors.push("holder.harness must be claude or pi");
			for (const key of ["sessionId", "processKey", "tokenSha256", "since"]) {
				if (!nonEmpty(holder[key])) errors.push(`holder.${key} must be a non-empty string`);
			}
			for (const key of ["laneId", "transcript", "lastTypedAt", "writtenAt"]) {
				if (holder[key] !== undefined && typeof holder[key] !== "string") errors.push(`holder.${key} must be a string`);
			}
			if (holder.assignedBy !== undefined && holder.assignedBy !== "terminal" && holder.assignedBy !== "shell" && holder.assignedBy !== "gateway") {
				errors.push("holder.assignedBy must be terminal, shell or gateway");
			}
		}
	}
	if (!Array.isArray(raw.dossier) || raw.dossier.some((path) => !nonEmpty(path))) errors.push("dossier must be a list of paths");
	if (!Array.isArray(raw.history) || raw.history.length > SEAT_HISTORY_CAP) errors.push(`history must be a list of at most ${SEAT_HISTORY_CAP} entries`);
	if (!nonEmpty(raw.updatedAt)) errors.push("updatedAt must be a timestamp");
	return errors.length > 0 ? { ok: false, errors } : { ok: true, record: raw as unknown as SeatRecord };
}

/** The one set of store options the seat owner gives either backend, so both validate a record and refuse a transition identically. */
const seatStoreOptions: Omit<CasStoreOptions<SeatRecord>, "dir"> = {
	idPattern: /^(?:orchestrator|architect)$/,
	idKind: "seat",
	noun: "seat",
	validate: validateSeatRecord,
	errorClass: SeatStateError,
};

/** The files half: one JSON file per role under `dir` (today's store, unchanged). */
export function fileSeatStore(dir: string): CasStore<SeatRecord> {
	return fileCasStore<SeatRecord>({ ...seatStoreOptions, dir });
}

/**
 * Where `musterd` serves the ledger socket. `ledger/open.ts:ledgerDir` owns the
 * rule (`MUSTER_LEDGER_DIR`, else the Muster state directory); it is read here
 * rather than imported because that module imports Durable Pi (DL4), and this
 * file is loaded by the OpenCode lane host and the one-file Claude hook bundle.
 */
function ledgerSocket(): string {
	const dir = process.env["MUSTER_LEDGER_DIR"]?.trim();
	return ledgerSocketPath(dir !== undefined && dir !== "" ? dir : musterStateDir());
}

/**
 * The seat's store: a test's own store when `ctx` supplies one, the ledger when
 * `backend.json` says so, the files store otherwise (LC-D2: a missing switch file
 * is today's behaviour). Only the store changes here; every seat rule above and
 * below is the same in both backends.
 */
export function seatStore(ctx: SeatContext = {}): CasStore<SeatRecord> {
	if (ctx.store !== undefined) return ctx.store;
	if (readBackend(ctx.stateDir ?? musterStateDir()) === "ledger") {
		return ledgerCasStore<SeatRecord>("seat", ledgerSocket(), seatStoreOptions);
	}
	return fileSeatStore(seatsDir(ctx));
}

const nowOf = (ctx: SeatContext): number => (ctx.now ?? Date.now)();
const isoOf = (ctx: SeatContext): string => new Date(nowOf(ctx)).toISOString();

function emptySeat(role: SeatRole, ctx: SeatContext): SeatRecord {
	return {
		schemaVersion: SEAT_SCHEMA_VERSION,
		revision: 0,
		role,
		epoch: 0,
		holder: null,
		dossier: [...DEFAULT_DOSSIERS[role]],
		history: [],
		updatedAt: isoOf(ctx),
	};
}

/** The seat's record. A seat nobody has claimed reads as epoch 0 with the default dossier and writes nothing. */
export function readSeat(roleName: string, ctx: SeatContext = {}): SeatRecord {
	const role = roleOf(roleName);
	return seatStore(ctx).read(role) ?? emptySeat(role, ctx);
}

/** The seats this session holds. A session may hold both: nothing decides otherwise. */
export function seatOf(sessionId: string, ctx: SeatContext = {}): SeatRole[] {
	return SEAT_ROLES.filter((role) => readSeat(role, ctx).holder?.sessionId === sessionId);
}

// ─── Process liveness ────────────────────────────────────────────────────────

/**
 * Is the process behind a process key still there? Keys read `pi-<pid>-<bootId>-<startTicks>`
 * or `claude-<pid>-<startTicks>`; the start ticks, when the key carries them, keep a reused
 * pid from passing for the holder. A key that names no pid cannot be proven gone, so it counts as alive.
 */
export function processKeyAlive(processKey: string): boolean {
	const pid = /^(?:pi|claude)-(\d+)-/.exec(processKey)?.[1];
	if (pid === undefined) return true;
	const number = Number(pid);
	if (!procPidAlive(number)) return false;
	const ticks = /^(?:pi|claude)-\d+-(?:[0-9a-f]+(?:-[0-9a-f]+)*-)?(\d+)$/.exec(processKey)?.[1];
	return ticks === undefined || procStartTime(number) === ticks;
}

const aliveOf = (ctx: SeatContext): ((processKey: string) => boolean) => ctx.processAlive ?? processKeyAlive;

// ─── Credentials ─────────────────────────────────────────────────────────────

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** `s<epoch>.<64 hex>`: the epoch prefix lets a refusal say which holding the token belonged to. */
function mintToken(epoch: number): string {
	return `s${epoch}.${randomBytes(32).toString("hex")}`;
}

const tokenEpoch = (token: string): number | undefined => {
	const match = /^s(\d+)\./.exec(token);
	return match === null ? undefined : Number(match[1]);
};

function hashMatches(holder: SeatHolder, token: string): boolean {
	const stored = Buffer.from(holder.tokenSha256, "hex");
	const given = Buffer.from(sha256(token), "hex");
	return stored.length === given.length && timingSafeEqual(stored, given);
}

/** True only for the current holding's token. */
export function verifySeatCredential(roleName: string, token: string | undefined, ctx: SeatContext = {}): boolean {
	const decision = authorizeSeatActor(roleName, token, ctx);
	return decision.allowed && decision.reason === "holder";
}

/** Does this fence still name the seat's holder, session, process and epoch? The programme owner's own check. */
export function seatFenceSatisfied(roleName: string, fence: OwnerFence, ctx: SeatContext = {}): boolean {
	const record = readSeat(roleName, ctx);
	return ownerFenceSatisfied(record.holder === null ? null : { sessionId: record.holder.sessionId, processKey: record.holder.processKey, epoch: record.epoch }, fence);
}

/**
 * May a caller act on the bus as this seat name? The one decision `requireAgentId` and the
 * seat-inbox readers ask. Epoch 0 (never claimed) is the legacy state and accepts the name.
 * From epoch 1 on only the holder's current credential passes, so an empty or dead-holder
 * seat is acted as by nobody.
 */
export function authorizeSeatActor(roleName: string, token: string | undefined, ctx: SeatContext = {}): SeatAuthorization {
	const record = readSeat(roleName, ctx);
	const { role, epoch, holder } = record;
	if (epoch === 0) return { allowed: true, reason: "legacy-epoch-0", epoch };
	const claimHint = `the operator gives it by typing 'become the ${role}' in your terminal`;
	if (token === undefined || token.trim() === "") {
		return { allowed: false, reason: "not-holder", epoch, message: `you do not hold the ${role} seat; ${claimHint}` };
	}
	const given = tokenEpoch(token);
	if (holder === null) {
		return given !== undefined && given < epoch
			? { allowed: false, reason: "superseded", epoch, message: `you are no longer the ${role} (#${given}); the seat is empty now (#${epoch}). ${claimHint}` }
			: { allowed: false, reason: "empty", epoch, message: `the ${role} seat is empty; ${claimHint}` };
	}
	if (hashMatches(holder, token)) return { allowed: true, reason: "holder", epoch };
	if (given !== undefined && given < epoch) {
		return { allowed: false, reason: "superseded", epoch, message: `you are no longer the ${role} (#${given}, now #${epoch})` };
	}
	return { allowed: false, reason: "not-holder", epoch, message: `you do not hold the ${role} seat; ${claimHint}` };
}

// ─── Privileges (blueprint, Privileges 1 to 3) ──────────────────────────────

/**
 * The environment of a process an agent session started: Claude Code sets `CLAUDECODE` for its shells,
 * Pi exposes `PI_SESSION_ID`, and a launched lane carries `CONCORD_AGENT_ID`. A process with none of them
 * is the operator's own shell or a service (the tick, the gateway), which the seat checks leave alone.
 */
export function runsInAgentSession(env: NodeJS.ProcessEnv): boolean {
	return ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "PI_SESSION_ID", "CONCORD_AGENT_ID"].some((name) => (env[name] ?? "").trim() !== "");
}

/**
 * Privilege 1: may this process act on the bus under this id? An id that is not a seat name always may.
 * A seat name needs the seat's current credential in `MUSTER_SEAT_TOKEN`; at epoch 0 the name is accepted as before.
 */
export function authorizeSeatIdentity(agentId: string, env: NodeJS.ProcessEnv, ctx: SeatContext = {}): { allowed: true } | { allowed: false; message: string } {
	const role = resolveSeatRole(agentId);
	if (role === undefined) return { allowed: true };
	const decision = authorizeSeatActor(role, env[SEAT_ENV_TOKEN], ctx);
	return decision.allowed ? { allowed: true } : { allowed: false, message: decision.message };
}

// ─── The caller's bus identity (REPREF) ──────────────────────────────────────

/** The identity a caller acts under, or the refusal that says why not. */
export type BusIdentity = { ok: true; id: string; notice?: string } | { ok: false; error: string };

/**
 * Does this process hold the credential of that seat? The credential decides, never the
 * name: the launcher scrubs the seat names from every lane it starts (`SEAT_SCRUB`), so a
 * lane can only hold one when it was given it.
 */
function holdsSeatCredential(role: SeatRole, env: NodeJS.ProcessEnv, ctx: SeatContext): boolean {
	if (resolveSeatRole((env[SEAT_ENV_ROLE] ?? "").trim()) !== role) return false;
	return verifySeatCredential(role, env[SEAT_ENV_TOKEN], ctx);
}

/** The seat admission for one id: a seat name needs its credential, any other name is free. */
function seatAdmission(id: string, env: NodeJS.ProcessEnv, ctx: SeatContext): { ok: true } | { ok: false; error: string } {
	const seat = authorizeSeatIdentity(id, env, ctx);
	return seat.allowed ? { ok: true } : { ok: false, error: seat.message };
}

/**
 * The identity this session proves, given the id the frame resolved.
 *
 * Inside a real Claude session (`CLAUDE_PID` is an own ancestor, the check
 * `ownClaudeLane` makes) the environment's agent id is the daemon's stale inheritance: it
 * names a lane this session is not part of, because the daemon spawns every session from
 * its own environment. A session there whose lane `ownClaudeLane` cannot name has no
 * identity of its own, so a claim stands as it did before and an unheld seat name is
 * refused as before (VR24-109). Everywhere else — a Pi lane, a service — the id the
 * launcher gave the session is its proof.
 */
function sessionProof(env: NodeJS.ProcessEnv, resolved: string): string {
	const lane = ownClaudeLane(env);
	if (lane !== undefined) return lane;
	const pid = Number(env["CLAUDE_PID"]);
	if (Number.isInteger(pid) && pid > 1 && isOwnAncestor(pid)) return "";
	return resolved;
}

/**
 * The caller's bus identity, decided here (REPREF, architect VR24-95).
 *
 * The identity is what the session proves it has: its own lane id, or the seat its
 * credential opens. A name on the command line is a claim, never a proof: it never
 * replaces the session's own identity, and a seat name the credential does not open never
 * becomes an identity at all. So a command string copied out of a brief cannot change who
 * a lane is — the OUTROWS lane's `muster report` was refused for exactly that on
 * 2026-10-25 (its brief quoted a read command that named the orchestrator seat, and the
 * report command inherited the name, so the seat check compared a claimed name against the
 * seat record and refused the lane's own report).
 *
 * `claimed` is the name the caller asked for, `session` the identity the frame resolved.
 * A caller with no identity of its own (the operator's shell, a service) has only the claim, and
 * the claim stands as before.
 */
export function resolveBusIdentity(
	claimed: string | undefined,
	session: string | undefined,
	env: NodeJS.ProcessEnv,
	ctx: SeatContext = {},
): BusIdentity {
	const claim = (claimed ?? "").trim();
	const own = sessionProof(env, (session ?? "").trim());
	if (own === "" || claim === "" || claim === own) {
		const id = claim !== "" ? claim : own;
		if (id === "") return { ok: false, error: "no agent identity: pass --agent <id>, or run from an enrolled session with CONCORD_AGENT_ID" };
		const admitted = seatAdmission(id, env, ctx);
		return admitted.ok ? { ok: true, id } : admitted;
	}
	const claimRole = resolveSeatRole(claim);
	const ownRole = resolveSeatRole(own);
	// A seat name: it stands only with the seat's credential, so the holder keeps it and a lane loses it.
	if (claimRole !== undefined) {
		if (holdsSeatCredential(claimRole, env, ctx)) {
			const admitted = seatAdmission(claim, env, ctx);
			return admitted.ok ? { ok: true, id: claim } : admitted;
		}
		const admitted = seatAdmission(own, env, ctx);
		return admitted.ok
			? { ok: true, id: own, notice: `${claim} is the ${claimRole} seat and this session does not hold it; acting as ${own}` }
			: admitted;
	}
	// The session's own identity is a seat name: a claim never replaces it.
	if (ownRole !== undefined) {
		const admitted = seatAdmission(claim, env, ctx);
		return admitted.ok ? { ok: true, id: claim } : admitted;
	}
	// A plain name never replaces the session's own identity.
	const admitted = seatAdmission(own, env, ctx);
	return admitted.ok ? { ok: true, id: own, notice: `${claim} is not this session's own identity; acting as ${own}` } : admitted;
}

/** The writer a process resolves to: the operator's own shell, or the seat whose credential it holds. */
export type SeatWriterResolution = { writer: "operator-shell" | SeatRole } | { error: string };

/**
 * Who may write a store that only the operator's shell and the two seats write (the ask queue, the goal
 * registry): the writer is the process. A process that is not an agent session is the operator's own
 * shell. An agent session must hold the architect or orchestrator seat, and is otherwise refused,
 * with the wording the caller gives for "this name is not a seat".
 *
 * A valid seat credential (`MUSTER_SEAT` with the holder's current `MUSTER_SEAT_TOKEN`) decides first:
 * a seat session can still carry a lane id in `CONCORD_AGENT_ID` from its launcher, and that id never
 * vetoes the credential. Without a valid credential the name resolves as before, so an id from the env
 * alone gains nothing and a stale or forged token is refused.
 */
export function resolveSeatWriter(
	env: NodeJS.ProcessEnv,
	agentId: string | undefined,
	context: SeatContext | undefined,
	notSeatMessage: (named: string) => string,
): SeatWriterResolution {
	if (!runsInAgentSession(env)) return { writer: "operator-shell" };
	const seatContext = context ?? seatContextFor(env);
	const credentialRole = resolveSeatRole(env["MUSTER_SEAT"]?.trim() ?? "");
	let credentialRefusal: string | undefined;
	if (credentialRole !== undefined) {
		try {
			const decision = authorizeSeatActor(credentialRole, env[SEAT_ENV_TOKEN], seatContext);
			if (decision.allowed && decision.reason === "holder") return { writer: credentialRole };
			if (!decision.allowed) credentialRefusal = decision.message;
		} catch (error) {
			credentialRefusal = error instanceof Error ? error.message : String(error);
		}
	}
	const named = agentId?.trim() || env["MUSTER_SEAT"]?.trim() || env["CONCORD_AGENT_ID"]?.trim() || "";
	const role = resolveSeatRole(named);
	if (role === undefined) return { error: credentialRefusal ?? notSeatMessage(named) };
	try {
		const decision = authorizeSeatActor(role, env[SEAT_ENV_TOKEN], seatContext);
		if (!decision.allowed) return { error: decision.message };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
	return { writer: role };
}

/**
 * Privilege 2: may this process read the inbox of this address? Only a seat inbox is guarded, and only against
 * an agent session without the credential: the operator's own shell reads any inbox, as it does today.
 */
export function authorizeSeatInboxRead(address: string, env: NodeJS.ProcessEnv, ctx: SeatContext = {}): { allowed: true } | { allowed: false; message: string } {
	if (resolveSeatRole(address) === undefined || !runsInAgentSession(env)) return { allowed: true };
	return authorizeSeatIdentity(address, env, ctx);
}

/**
 * Privilege 3: may this process stop, close, abort or re-model a lane? An agent session needs the orchestrator
 * seat. the operator's shell and the services (they run no agent session) are not asked.
 */
export function authorizeLaneControl(env: NodeJS.ProcessEnv, ctx: SeatContext = {}): { allowed: true } | { allowed: false; message: string } {
	if (!runsInAgentSession(env)) return { allowed: true };
	const decision = authorizeSeatActor("orchestrator", env[SEAT_ENV_TOKEN], ctx);
	return decision.allowed ? { allowed: true } : { allowed: false, message: `lane control needs the orchestrator seat: ${decision.message}` };
}

// ─── Who holds a seat (the one answer the name checks ask) ──────────────────

/**
 * The lane id and role of every seat holder that has a lane. A holder whose process died still holds (LD24).
 * A Claude holder claimed by the operator's typed words carries no lane id (the plugin's claim passes none), so its
 * lane is the one its session's background job names (`claudeSessionLane`), the answer the Claude hook uses
 * for that session. A holder with neither has no lane.
 */
export function seatHolderLanes(ctx: SeatContext = {}): Array<{ role: SeatRole; laneId: string }> {
	const held: Array<{ role: SeatRole; laneId: string }> = [];
	for (const role of SEAT_ROLES) {
		const holder = readSeat(role, ctx).holder;
		const laneId = holder?.laneId ?? (holder?.harness === "claude" ? claudeSessionLane(holder.sessionId) : undefined);
		if (laneId !== undefined) held.push({ role, laneId });
	}
	return held;
}

/**
 * The seat an agent id stands for: the lane id of a holder, or the name `orchestrator` while that seat was
 * never claimed (epoch 0, the legacy rule). A seat file that cannot be read answers as before the seats existed.
 */
export function seatHeldBy(agentId: string | undefined, ctx: SeatContext = {}): SeatRole | undefined {
	const id = agentId?.trim();
	if (id === undefined || id === "") return undefined;
	try {
		const holding = seatHolderLanes(ctx).find((entry) => entry.laneId === id);
		if (holding !== undefined) return holding.role;
		if (resolveSeatRole(id) === "orchestrator" && readSeat("orchestrator", ctx).epoch === 0) return "orchestrator";
	} catch {
		return id === "orchestrator" ? "orchestrator" : undefined;
	}
	return undefined;
}

// ─── Tickets ─────────────────────────────────────────────────────────────────

type SeatTicket = { nonce: string; sessionId: string; role: SeatRole; writtenAt: string };

/**
 * The Claude adapter's half of the proof: a mode 0600 file with a random nonce and the
 * session id, valid for 10 s. Exported for the adapter's contract and for tests. No verb calls it.
 */
export function writeSeatTicket(roleName: string, sessionId: string, ctx: SeatContext = {}): string {
	const role = roleOf(roleName);
	const ticket: SeatTicket = { nonce: randomBytes(16).toString("hex"), sessionId, role, writtenAt: isoOf(ctx) };
	const path = seatTicketPath(role, ctx);
	mkdirSync(seatsDir(ctx), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(ticket)}\n`, { mode: 0o600 });
		chmodSync(temp, 0o600);
		renameSync(temp, path);
	} finally {
		rmSync(temp, { force: true });
	}
	return ticket.nonce;
}

/**
 * Check a proof; for a ticket, consume it. Runs inside the compare-and-set update, so the proof is
 * gone exactly when the claim is recorded, and a refused attempt leaves both files as they were.
 * An assignment proof returns what it contributes to the new holder's record (LD36); the claim
 * removes the assignment file with the move, so a refused attempt leaves it in place.
 */
function consumeProof(role: SeatRole, input: SeatHolderInput, proof: SeatProof, current: SeatRecord, ctx: SeatContext): { assignedBy: "shell" | "gateway"; writtenAt: string } | undefined {
	if (proof.kind === "in-process") return undefined;
	if (proof.kind === "assignment") return consumeAssignment(role, input, proof.nonce, current, ctx);
	const refuse = (why: string): never => {
		throw new SeatStateError("refused", `the ${role} seat moves only when the operator types the phrase at a terminal: ${why}`);
	};
	const path = seatTicketPath(role, ctx);
	if (!existsSync(path)) return refuse("no ticket");
	let ticket: unknown;
	try {
		ticket = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return refuse("the ticket is unreadable");
	}
	if (!isObject(ticket) || !nonEmpty(ticket.nonce) || !nonEmpty(ticket.sessionId) || !nonEmpty(ticket.writtenAt)) return refuse("the ticket is malformed");
	const given = Buffer.from(proof.nonce);
	const wanted = Buffer.from(ticket.nonce);
	if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return refuse("the ticket does not match");
	if (ticket.sessionId !== input.sessionId) return refuse("the ticket was written for another session");
	const age = nowOf(ctx) - Date.parse(ticket.writtenAt);
	if (!Number.isFinite(age) || age > SEAT_TICKET_TTL_MS || age < -SEAT_TICKET_SKEW_MS) return refuse("the ticket is stale");
	rmSync(path, { force: true });
	return undefined;
}

// ─── Assignments (LD36) ─────────────────────────────────────────────────────

/** A pending assignment: `assignSeat` wrote it; a claim presenting its nonce takes the seat. */
export type SeatAssignment = {
	nonce: string;
	role: SeatRole;
	sessionId: string;
	harness: SeatHarness;
	assignedBy: "shell" | "gateway";
	writtenAt: string;
};

/** What the assigner asks the owner to do: a named target session and the inbox its notice goes to. */
export type SeatAssignmentTarget = { harness: SeatHarness; sessionId: string; inbox: string };

function parseSeatAssignment(raw: unknown, role: SeatRole): SeatAssignment | undefined {
	if (!isObject(raw) || !nonEmpty(raw.nonce) || raw.role !== role || !nonEmpty(raw.sessionId)) return undefined;
	if (raw.harness !== "claude" && raw.harness !== "pi") return undefined;
	if (raw.assignedBy !== "shell" && raw.assignedBy !== "gateway") return undefined;
	if (!nonEmpty(raw.writtenAt)) return undefined;
	return { nonce: raw.nonce, role, sessionId: raw.sessionId, harness: raw.harness, assignedBy: raw.assignedBy, writtenAt: raw.writtenAt };
}

/** Write the assignment whole: temp file, mode 0600, atomic rename. Runs inside the seat transition. */
function writeSeatAssignment(assignment: SeatAssignment, ctx: SeatContext): void {
	const path = seatAssignmentPath(assignment.role, ctx);
	mkdirSync(seatsDir(ctx), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(assignment)}\n`, { mode: 0o600 });
		chmodSync(temp, 0o600);
		renameSync(temp, path);
	} finally {
		rmSync(temp, { force: true });
	}
}

/** The pending assignment for a role, or undefined. Adapters read it to present the nonce; only the owner writes and consumes it. */
export function readSeatAssignment(roleName: string, ctx: SeatContext = {}): SeatAssignment | undefined {
	const role = roleOf(roleName);
	try {
		return parseSeatAssignment(JSON.parse(readFileSync(seatAssignmentPath(role, ctx), "utf8")), role);
	} catch {
		return undefined;
	}
}

/** Any successful claim, rebind or release of a role removes its pending assignment (LD36). */
function clearAssignment(role: SeatRole, ctx: SeatContext): void {
	rmSync(seatAssignmentPath(role, ctx), { force: true });
}

/**
 * Check an assignment as claim proof: nonce, session, role, age and skew, and that the claimant's
 * process key is not the current holder's. Runs inside the compare-and-set update; the caller
 * removes the file with the successful move, so a refused attempt leaves it in place.
 */
function consumeAssignment(role: SeatRole, input: SeatHolderInput, nonce: string, current: SeatRecord, ctx: SeatContext): { assignedBy: "shell" | "gateway"; writtenAt: string } {
	const refuse = (why: string): never => {
		throw new SeatStateError("refused", `the ${role} seat assignment is refused: ${why}`);
	};
	const path = seatAssignmentPath(role, ctx);
	if (!existsSync(path)) return refuse("no assignment is pending");
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return refuse("the assignment is unreadable");
	}
	const assignment = parseSeatAssignment(raw, role);
	if (assignment === undefined) return refuse("the assignment is malformed");
	if (assignment.sessionId !== input.sessionId) return refuse(`it names session ${assignment.sessionId.slice(0, 8)}, not this one`);
	const given = Buffer.from(nonce);
	const wanted = Buffer.from(assignment.nonce);
	if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return refuse("the nonce does not match");
	const age = nowOf(ctx) - Date.parse(assignment.writtenAt);
	if (!Number.isFinite(age) || age > SEAT_ASSIGNMENT_TTL_MS || age < -SEAT_TICKET_SKEW_MS) return refuse("the assignment is stale");
	if (current.holder !== null && current.holder.processKey === input.processKey) return refuse("the seat's current holder process cannot claim an assignment");
	return { assignedBy: assignment.assignedBy, writtenAt: assignment.writtenAt };
}

// ─── Moves ───────────────────────────────────────────────────────────────────

function requireInput(input: SeatHolderInput, verb: string): void {
	if (input.harness !== "claude" && input.harness !== "pi") throw new SeatStateError("refused", `${verb}: harness must be claude or pi`);
	if (!nonEmpty(input.sessionId)) throw new SeatStateError("refused", `${verb}: a non-empty session id is required`);
	if (!nonEmpty(input.processKey)) throw new SeatStateError("refused", `${verb}: a non-empty process key is required`);
}

/** Run one compare-and-set transition, re-reading and retrying when another writer won the revision. */
function transition<R>(
	role: SeatRole,
	ctx: SeatContext,
	step: (current: SeatRecord) => { next: Omit<SeatRecord, "revision" | "updatedAt" | "role" | "schemaVersion">; result: R },
): { record: SeatRecord; result: R } {
	const store = seatStore(ctx);
	let lastConflict: string | undefined;
	for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
		const current = store.read(role) ?? emptySeat(role, ctx);
		try {
			let result: R | undefined;
			const record = store.update(role, current.revision === 0 ? undefined : current.revision, (stored) => {
				// The store has already matched the revision under its lock, so `base` is the record read above.
				const base = stored ?? emptySeat(role, ctx);
				const planned = step(base);
				result = planned.result;
				return { schemaVersion: SEAT_SCHEMA_VERSION, role, revision: base.revision + 1, updatedAt: isoOf(ctx), ...planned.next };
			});
			return { record, result: result as R };
		} catch (error) {
			if (error instanceof SeatStateError && error.code === "conflict") {
				lastConflict = error.message;
				continue;
			}
			throw error;
		}
	}
	throw new SeatStateError("conflict", `Could not move the ${role} seat after ${CAS_ATTEMPTS} attempts: ${lastConflict ?? "contended"}`);
}

function capHistory(history: SeatHistoryEntry[]): SeatHistoryEntry[] {
	return history.slice(-SEAT_HISTORY_CAP);
}

function endedHolding(record: SeatRecord, how: SeatHistoryEntry["how"], to: string): SeatHistoryEntry | undefined {
	return record.holder === null
		? undefined
		: { epoch: record.epoch, sessionId: record.holder.sessionId, harness: record.holder.harness, from: record.holder.since, to, how };
}

function holderFrom(input: SeatHolderInput, token: string, since: string, lastTypedAt: string | undefined): SeatHolder {
	return {
		harness: input.harness,
		sessionId: input.sessionId,
		processKey: input.processKey,
		...(nonEmpty(input.laneId) ? { laneId: input.laneId } : {}),
		...(nonEmpty(input.transcript) ? { transcript: input.transcript } : {}),
		tokenSha256: sha256(token),
		since,
		...(lastTypedAt !== undefined ? { lastTypedAt } : {}),
	};
}

/**
 * The seat moves to this session. The epoch rises when the session differs from the current holder
 * (or the seat is empty); the same session claiming again keeps the epoch and gets a fresh token.
 * The previous holder gets one best-effort inbox notice and stays open as an ordinary session (LD22).
 */
export function claimSeat(roleName: string, input: SeatHolderInput, proof: SeatProof, ctx: SeatContext = {}): ClaimResult {
	const role = roleOf(roleName);
	requireInput(input, "claim");
	const { record, result } = transition(role, ctx, (current) => {
		const assignment = consumeProof(role, input, proof, current, ctx);
		clearAssignment(role, ctx);
		const at = isoOf(ctx);
		const sameSession = current.holder?.sessionId === input.sessionId;
		const epoch = sameSession ? current.epoch : current.epoch + 1;
		const token = mintToken(epoch);
		const ended = sameSession ? undefined : endedHolding(current, assignment === undefined ? "claim" : "assign", at);
		const actor = assignment === undefined ? { assignedBy: "terminal" as const } : { assignedBy: assignment.assignedBy, writtenAt: assignment.writtenAt };
		return {
			next: {
				epoch,
				holder: { ...holderFrom(input, token, sameSession ? current.holder!.since : at, sameSession ? current.holder!.lastTypedAt : undefined), ...actor },
				dossier: current.dossier,
				history: capHistory(ended === undefined ? current.history : [...current.history, ended]),
			},
			result: { role, token, epoch, previous: current.holder, ...actor } satisfies ClaimResult,
		};
	});
	writeBadge(record, ctx);
	if (result.previous !== null && result.previous.sessionId !== input.sessionId) notifyPreviousHolder(record, result.previous, ctx);
	return result;
}

/**
 * The holder's own session in a new process (a retired Claude session reopened with the same id):
 * accepted only for the current holder's session id, once the recorded process is gone, with the
 * same proof as a claim. The epoch stays; the old process's token stops working.
 */
export function rebindSeat(
	roleName: string,
	input: SeatHolderInput,
	proof: SeatProof,
	ctx: SeatContext = {},
): RebindResult {
	const role = roleOf(roleName);
	requireInput(input, "rebind");
	const { record, result } = transition(role, ctx, (current) => {
		const holder = current.holder;
		if (holder === null || holder.sessionId !== input.sessionId) {
			throw new SeatStateError("refused", `rebind refused: session ${input.sessionId} is not the ${role} holder`);
		}
		if (aliveOf(ctx)(holder.processKey)) {
			throw new SeatStateError("refused", `rebind refused: the ${role} holder's process (${holder.processKey}) is still running`);
		}
		consumeProof(role, input, proof, current, ctx);
		clearAssignment(role, ctx);
		const token = mintToken(current.epoch);
		return {
			next: {
				epoch: current.epoch,
				holder: holderFrom(input, token, holder.since, holder.lastTypedAt),
				dossier: current.dossier,
				history: current.history,
			},
			result: { role, token, epoch: current.epoch } satisfies RebindResult,
		};
	});
	writeBadge(record, ctx);
	return result;
}

/**
 * Write an assignment (LD36): the named target session may claim the role with the file's nonce,
 * valid for 10 minutes, single use, and never for the session that already holds the role. The
 * file is written inside the seat transition, so a replace and a consume never interleave; the
 * target's notice goes out after the transition returns and never undoes the assignment. The
 * caller (the shell verb or the gateway tool) sends the Grokbot line through the existing send path.
 */
export function assignSeat(roleName: string, target: SeatAssignmentTarget, assignedBy: "shell" | "gateway", ctx: SeatContext = {}): { role: SeatRole; sessionId: string; expiresAt: string } {
	const role = roleOf(roleName);
	if (target.harness !== "claude" && target.harness !== "pi") throw new SeatStateError("refused", "assign: harness must be claude or pi");
	if (!nonEmpty(target.sessionId)) throw new SeatStateError("refused", "assign: a non-empty session id is required");
	if (!nonEmpty(target.inbox)) throw new SeatStateError("refused", "assign: a non-empty inbox is required");
	const { result } = transition(role, ctx, (current) => {
		if (current.holder !== null && current.holder.sessionId === target.sessionId) {
			throw new SeatStateError("refused", `assign refused: session ${target.sessionId} already holds the ${role} seat`);
		}
		const writtenAt = isoOf(ctx);
		writeSeatAssignment({ nonce: randomBytes(16).toString("hex"), role, sessionId: target.sessionId, harness: target.harness, assignedBy, writtenAt }, ctx);
		return {
			next: { epoch: current.epoch, holder: current.holder, dossier: current.dossier, history: current.history },
			result: { role, sessionId: target.sessionId, expiresAt: new Date(nowOf(ctx) + SEAT_ASSIGNMENT_TTL_MS).toISOString(), writtenAt },
		};
	});
	try {
		writeInboxMessage(ctx.stateDir ?? musterStateDir(), {
			agent: target.inbox,
			from: "muster-seats",
			at: isoOf(ctx),
			idempotencyKey: `seat-${role}-assigned-${result.writtenAt}`,
			text: `The ${role} seat was assigned to you ${HOLDER_ACTOR_PHRASES[assignedBy]} at ${result.writtenAt} and is valid for 10 minutes. Take it on your next turn or inbox wake; your adapter presents it: muster seat claim ${role} --assignment <nonce>.`,
		});
	} catch { /* a notice that cannot be written never undoes the assignment */ }
	return { role: result.role, sessionId: result.sessionId, expiresAt: result.expiresAt };
}

/** The holder gives the seat up. It stays empty at its current epoch (so the bus refuses the name) until the operator claims it. */
export function releaseSeat(roleName: string, token: string | undefined, ctx: SeatContext = {}): { role: SeatRole; epoch: number } {
	const role = roleOf(roleName);
	const { record, result } = transition(role, ctx, (current) => {
		if (current.holder === null || current.epoch === 0 || token === undefined || !hashMatches(current.holder, token)) {
			throw new SeatStateError("refused", `release refused: only the ${role} holder, with its current credential, can release the seat`);
		}
		const ended = endedHolding(current, "release", isoOf(ctx));
		clearAssignment(role, ctx);
		return {
			next: { epoch: current.epoch, holder: null, dossier: current.dossier, history: capHistory([...current.history, ...(ended ? [ended] : [])]) },
			result: { role, epoch: current.epoch },
		};
	});
	writeBadge(record, ctx);
	return result;
}

/** The holder records a terminal-typed prompt. Rate-limited by the caller (the adapter writes it at most once a minute). */
export function touchSeat(roleName: string, token: string | undefined, ctx: SeatContext = {}): void {
	const role = roleOf(roleName);
	transition(role, ctx, (current) => {
		if (current.holder === null || token === undefined || !hashMatches(current.holder, token)) {
			throw new SeatStateError("refused", `touch refused: only the ${role} holder can record its typing`);
		}
		return {
			next: { epoch: current.epoch, holder: { ...current.holder, lastTypedAt: isoOf(ctx) }, dossier: current.dossier, history: current.history },
			result: undefined,
		};
	});
}

/** The holder maintains its dossier. */
export function editSeatDossier(
	roleName: string,
	token: string | undefined,
	op: "add" | "remove",
	path: string,
	ctx: SeatContext = {},
): string[] {
	const role = roleOf(roleName);
	if (!nonEmpty(path)) throw new SeatStateError("refused", "dossier: a non-empty path is required");
	const { result } = transition(role, ctx, (current) => {
		if (current.holder === null || token === undefined || !hashMatches(current.holder, token)) {
			throw new SeatStateError("refused", `dossier refused: only the ${role} holder can change its dossier`);
		}
		const dossier = op === "add" ? (current.dossier.includes(path) ? current.dossier : [...current.dossier, path]) : current.dossier.filter((entry) => entry !== path);
		return { next: { epoch: current.epoch, holder: current.holder, dossier, history: current.history }, result: dossier };
	});
	return result;
}

// ─── Visibility ──────────────────────────────────────────────────────────────

/**
 * The small file a status line reads instead of the record, so it stays fast. It carries the epoch
 * a holder compares against its own to learn the seat moved. Best effort: the record is the authority.
 */
function writeBadge(record: SeatRecord, ctx: SeatContext): void {
	try {
		const path = seatBadgePath(record.role, ctx);
		const temp = `${path}.${process.pid}.tmp`;
		mkdirSync(seatsDir(ctx), { recursive: true, mode: 0o700 });
		try {
			const badge = { role: record.role, epoch: record.epoch, sessionId: record.holder?.sessionId ?? null, harness: record.holder?.harness ?? null, since: record.holder?.since ?? null };
			writeFileSync(temp, `${JSON.stringify(badge)}\n`, { mode: 0o600 });
			renameSync(temp, path);
		} finally {
			rmSync(temp, { force: true });
		}
	} catch { /* a status-line cache must never fail a seat move */ }
}

/** The inbox the previous holder reads: its lane's, or a per-session one when it has no lane. */
export function seatNoticeInbox(holder: Pick<SeatHolder, "laneId" | "sessionId">): string {
	return nonEmpty(holder.laneId) ? holder.laneId : `seat-session-${holder.sessionId}`;
}

/** How a notice names the actor of a move: the new holder's `assignedBy` (LD36). */
const HOLDER_ACTOR_PHRASES: Readonly<Record<"terminal" | "shell" | "gateway", string>> = {
	terminal: "by the operator at the terminal",
	shell: "by assignment from the operator's shell",
	gateway: "by assignment through the gateway",
};

function notifyPreviousHolder(record: SeatRecord, previous: SeatHolder, ctx: SeatContext): void {
	const holder = record.holder;
	if (holder === null) return;
	try {
		writeInboxMessage(ctx.stateDir ?? musterStateDir(), {
			agent: seatNoticeInbox(previous),
			from: "muster-seats",
			at: isoOf(ctx),
			idempotencyKey: `seat-${record.role}-${record.epoch}-moved`,
			text: `The ${record.role} seat moved to ${holder.harness} session ${holder.sessionId.slice(0, 8)} (#${record.epoch}) at ${holder.since}, ${HOLDER_ACTOR_PHRASES[holder.assignedBy ?? "terminal"]}. You no longer hold it. If you have handover notes that are not in the dossier files, send them now: muster send ${record.role} "HANDOVER: …"`,
		});
	} catch { /* a notice that cannot be written never undoes the move */ }
}

/** A record as `muster seat show` prints it: the credential hash is never shown. */
export function describeSeat(record: SeatRecord, ctx: SeatContext = {}): SeatView {
	const { holder, ...rest } = record;
	if (holder === null) return { ...rest, holder: null };
	const { tokenSha256: _hidden, ...shown } = holder;
	return { ...rest, holder: { ...shown, processAlive: aliveOf(ctx)(holder.processKey) } };
}

export type SeatView = Omit<SeatRecord, "holder"> & { holder: null | (Omit<SeatHolder, "tokenSha256"> & { processAlive: boolean }) };

// ─── A seat with no live session (LD24) ──────────────────────────────────────

/** What the tick writes beside the seat record about a seat it saw without a live session. Not part of the record. */
type SeatOrphanMark = { epoch: number; sessionId: string | null; deadSince: number; notifiedAt?: number };

export function seatOrphanPath(role: SeatRole, ctx: SeatContext = {}): string {
	return join(seatsDir(ctx), `${role}.orphan.json`);
}

function readOrphanMark(role: SeatRole, ctx: SeatContext): SeatOrphanMark | undefined {
	try {
		const raw: unknown = JSON.parse(readFileSync(seatOrphanPath(role, ctx), "utf8"));
		if (!isObject(raw) || !nonNegativeInt(raw.epoch) || typeof raw.deadSince !== "number") return undefined;
		return { epoch: raw.epoch, sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null, deadSince: raw.deadSince, ...(typeof raw.notifiedAt === "number" ? { notifiedAt: raw.notifiedAt } : {}) };
	} catch {
		return undefined;
	}
}

function writeOrphanMark(role: SeatRole, mark: SeatOrphanMark, ctx: SeatContext): void {
	const path = seatOrphanPath(role, ctx);
	const temp = `${path}.${process.pid}.tmp`;
	mkdirSync(seatsDir(ctx), { recursive: true, mode: 0o700 });
	try {
		writeFileSync(temp, `${JSON.stringify(mark)}\n`, { mode: 0o600 });
		renameSync(temp, path);
	} finally {
		rmSync(temp, { force: true });
	}
}

export type SeatOrphanNotice = { role: SeatRole; epoch: number; text: string; key: string };

/**
 * One pass of the tick's seat watch (LD24). A claimed seat (epoch 1 or more) whose holder's process is gone, or
 * that was released, is "without a live session". The first pass that sees it starts the clock; 15 minutes later
 * it returns one notice for the operator and `markSeatOrphanNotified` records that it was sent. A seat that has a live
 * holder again, or that was never claimed, clears its mark. The holder is never touched: this only reads the
 * record and writes the mark (a dry run writes nothing).
 */
export function observeSeatOrphans(ctx: SeatContext = {}, options: { dryRun?: boolean } = {}): SeatOrphanNotice[] {
	const notices: SeatOrphanNotice[] = [];
	const now = nowOf(ctx);
	for (const role of SEAT_ROLES) {
		const record = readSeat(role, ctx);
		const mark = readOrphanMark(role, ctx);
		const holder = record.holder;
		const orphaned = record.epoch !== 0 && (holder === null || !aliveOf(ctx)(holder.processKey));
		if (!orphaned) {
			if (mark !== undefined && options.dryRun !== true) rmSync(seatOrphanPath(role, ctx), { force: true });
			continue;
		}
		const sessionId = holder?.sessionId ?? null;
		let current = mark !== undefined && mark.epoch === record.epoch && mark.sessionId === sessionId ? mark : undefined;
		if (current === undefined) {
			// A released seat has been empty since the release; a dead holder since this pass first saw it dead.
			const releasedAt = holder === null ? Date.parse(record.updatedAt) : Number.NaN;
			current = { epoch: record.epoch, sessionId, deadSince: Number.isFinite(releasedAt) ? releasedAt : now };
			if (options.dryRun !== true) writeOrphanMark(role, current, ctx);
		}
		if (current.notifiedAt !== undefined || now - current.deadSince < SEAT_ORPHAN_AFTER_MS) continue;
		notices.push({
			role,
			epoch: record.epoch,
			key: `seat-orphan:${role}:${record.epoch}:${current.deadSince}`,
			text: `The ${role} seat has no live session (${holder === null ? "released" : `${holder.harness} session ${holder.sessionId.slice(0, 8)} is gone`}). Type 'become the ${role}' in any session at your terminal or ask Bob to assign it.`,
		});
	}
	return notices;
}

/** The notice went out: do not send it again for this holding. */
export function markSeatOrphanNotified(role: SeatRole, ctx: SeatContext = {}): void {
	const mark = readOrphanMark(role, ctx);
	if (mark !== undefined) writeOrphanMark(role, { ...mark, notifiedAt: nowOf(ctx) }, ctx);
}
