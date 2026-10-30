/**
 * Supervised recovery — watchdog heartbeats and fenced recovery observations
 * (plan §7 P4.2, §3 "Recovery").
 *
 * Two halves meet here:
 * - a running session publishes a bounded heartbeat: the latest process
 *   identity in the programme control record (`control.ts` `recordHeartbeat`)
 *   plus the small state file `state/muster/supervisor.json` (mode 0600) that
 *   the external watchdog reads;
 * - a liveness observation is published into the durable delivery journal as a
 *   `recovery-observation` delivery (`inbox.ts`), which P1's wake pump and
 *   continuation admission already consume.
 *
 * Authority rules enforced here:
 * - only `process-death-proven` evidence authorizes a fenced recovery wake;
 *   a stale heartbeat alone never does (plan §7 P4.2 change 3);
 * - the wake identity is `supervisor-<generation>-<n>` and the observation must
 *   match the programme record's current run generation, so an observer bound to
 *   an older generation cannot act on a newer programme;
 * - operator stops win: `off`, `paused`, `waiting` and the kill files record the
 *   observation without admitting a wake;
 * - the publisher never composes a continuation prompt and never schedules
 *   product work; its message names what was and was not proven.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { musterLeasesDir, musterSessionsDir, musterStateDir } from "./binding.ts";
import {
	enqueueWake,
	fileProgrammeControlStore,
	programmeControlKillFilePaths,
	ProgrammeControlStateError,
	readProgrammeSnapshot,
	recordHeartbeat,
	type CompactionObservation,
	type ProgrammeControlContext,
	type ProgrammeControlRecord,
} from "./control.ts";
import { MusterJournal, recoveryObservationDeliveryKey } from "./inbox.ts";
import type { RecoveryObservationKind } from "./types.ts";

export const SUPERVISOR_SCHEMA_VERSION = 1 as const;

/**
 * Heartbeat cadence the Muster extension publishes at, and the watchdog's
 * default check cadence and grace window. The grace window tolerates several
 * missed beats (a long tool call or a slow disk never triggers recovery); the
 * watchdog itself never decides that a stale beat means death.
 */
export const SUPERVISOR_HEARTBEAT_INTERVAL_MS = 30_000;
export const SUPERVISOR_CHECK_INTERVAL_MS = 30_000;
export const SUPERVISOR_GRACE_MS = 120_000;

/** The small state file the external watchdog reads (mode 0600). */
export function supervisorStatePath(): string {
	const override = process.env.PI_MUSTER_SUPERVISOR_STATE?.trim();
	if (override) return resolve(override);
	return join(musterStateDir(), "supervisor.json");
}

/**
 * Lease file path for one programme, in the existing Muster lease style
 * (`state/muster/leases/lease-<24 hex>.lock`, never unlinked, ownership tied to
 * the recorded process). The watchdog computes the same name from the same
 * recipe, so this points an operator at the exact file.
 */
export function supervisorLeasePath(programmeId: string, leaseDir?: string): string {
	const hash = createHash("sha256").update(`muster-supervisor::${programmeId}`).digest("hex").slice(0, 24);
	return join(leaseDir ?? musterLeasesDir(), `lease-${hash}.lock`);
}

// ─── Heartbeat state file ────────────────────────────────────────────────────

export type SupervisorHeartbeatState = {
	schemaVersion: typeof SUPERVISOR_SCHEMA_VERSION;
	pid: number;
	sessionId: string;
	programmeId: string;
	/** Programme run generation the publisher observed when it beat. */
	generation: number;
	heartbeatAt: string;
	/** Claim carried by the beating process; null when no continuation is active. */
	claim: { claimId: string; owner: string; runGeneration: number; admittedAt: string } | null;
	status: ProgrammeControlRecord["status"];
	/**
	 * Process start identity, so a reused pid can never be mistaken for this
	 * process. Null on platforms without `/proc`.
	 */
	pidStartTicks: number | null;
	bootId: string | null;
	updatedAt: string;
};

/** Preserve healthy OS keys; an unavailable proof must not collapse incarnations onto placeholders. */
export function createMusterProcessKey(
	pid: number,
	bootId: string | undefined,
	startTicks: number | undefined,
	incarnation: string,
): string {
	const base = `pi-${pid}-${bootId ?? "noboot"}-${startTicks ?? "nostart"}`;
	if (bootId !== undefined && startTicks !== undefined) return base;
	if (incarnation === "" || incarnation.trim() !== incarnation) {
		throw new Error("An unavailable OS process identity requires a nonempty literal incarnation marker");
	}
	return `${base}-${incarnation}`;
}

/** `/proc/sys/kernel/random/boot_id`; undefined off Linux or when unreadable. */
export function readBootId(): string | undefined {
	try {
		const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		return value === "" ? undefined : value;
	} catch {
		return undefined;
	}
}

/**
 * Field 22 (`starttime`) of `/proc/<pid>/stat`, in clock ticks since boot.
 * A command name may contain spaces and parentheses, so parsing starts after
 * the last `)`. Returns undefined when the process is gone or unreadable.
 */
export function readProcessStartTicks(pid: number): number | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const close = stat.lastIndexOf(")");
		if (close < 0) return undefined;
		const fields = stat.slice(close + 2).trim().split(/\s+/);
		// The slice starts at field 3 (state); starttime is field 22 → index 19.
		const ticks = Number.parseInt(fields[19] ?? "", 10);
		return Number.isInteger(ticks) && ticks >= 0 ? ticks : undefined;
	} catch {
		return undefined;
	}
}

/** Validate one state file. Structural deviation is refused, never repaired. */
export function parseSupervisorHeartbeatState(input: unknown): SupervisorHeartbeatState | undefined {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
	const state = input as Record<string, unknown>;
	if (state.schemaVersion !== SUPERVISOR_SCHEMA_VERSION) return undefined;
	if (!positiveInteger(state.pid)) return undefined;
	if (!nonEmpty(state.sessionId) || !nonEmpty(state.programmeId)) return undefined;
	if (!positiveInteger(state.generation)) return undefined;
	if (!nonEmpty(state.heartbeatAt) || !Number.isFinite(Date.parse(state.heartbeatAt))) return undefined;
	if (!nonEmpty(state.updatedAt)) return undefined;
	if (state.status !== "off" && state.status !== "running" && state.status !== "paused" && state.status !== "waiting") {
		return undefined;
	}
	const claim = state.claim;
	if (claim !== null && claim !== undefined) {
		if (typeof claim !== "object" || Array.isArray(claim)) return undefined;
		const row = claim as Record<string, unknown>;
		if (
			!nonEmpty(row.claimId) ||
			!nonEmpty(row.owner) ||
			!positiveInteger(row.runGeneration) ||
			!nonEmpty(row.admittedAt)
		) {
			return undefined;
		}
	}
	if (
		state.pidStartTicks !== null &&
		state.pidStartTicks !== undefined &&
		!(typeof state.pidStartTicks === "number" && Number.isInteger(state.pidStartTicks) && state.pidStartTicks >= 0)
	) {
		return undefined;
	}
	if (state.bootId !== null && state.bootId !== undefined && !nonEmpty(state.bootId)) return undefined;
	return input as SupervisorHeartbeatState;
}

/** Fresh read of the watchdog state file; undefined when absent or invalid. */
export function readSupervisorHeartbeatState(path = supervisorStatePath()): SupervisorHeartbeatState | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return parseSupervisorHeartbeatState(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return undefined;
	}
}

/** Atomic 0600 write: a watchdog must never read a half-written heartbeat. */
export function writeSupervisorHeartbeatState(state: SupervisorHeartbeatState, path = supervisorStatePath()): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
		chmodSync(temp, 0o600);
		renameSync(temp, path);
		chmodSync(path, 0o600);
	} finally {
		rmSync(temp, { force: true });
	}
}

/**
 * Remove the heartbeat state on a clean session shutdown. A watchdog that finds
 * no state does nothing: this keeps a deliberate exit from looking like a crash,
 * while a killed process leaves the file behind as evidence.
 */
export function clearSupervisorHeartbeatState(path = supervisorStatePath()): void {
	rmSync(path, { force: true });
}

export type SupervisorHeartbeatInput = {
	programmeId: string;
	sessionId: string;
	/** When the session last went idle, or null while it runs a turn (R1 tick). */
	idleSince?: string | null;
	/** What the rotation triggers read (R1.5): context size, the last compaction, the Herdr pane. */
	contextTokens?: number;
	contextWindow?: number;
	compaction?: CompactionObservation;
	paneId?: string;
	wakeHold?: { reason: string; at: string };
	lastInputAt?: string;
	/** Defaults to this process; tests and gates may override. */
	pid?: number;
};

/**
 * Persist one heartbeat: the control record first (durable, CAS-serialized),
 * then the state file the watchdog reads. Returns the published state.
 */
export function publishSupervisorHeartbeat(
	input: SupervisorHeartbeatInput,
	context?: ProgrammeControlContext,
	options?: { statePath?: string },
): SupervisorHeartbeatState {
	const pid = input?.pid ?? process.pid;
	const record = readProgrammeSnapshot(input.programmeId, context);
	// The generation recorded is the programme generation observed at beat time:
	// this is what later fences a watchdog bound to an older generation.
	const beat = recordHeartbeat(
		input.programmeId,
		{
			pid,
			sessionId: input.sessionId,
			generation: record.runGeneration,
			...(input.idleSince !== undefined ? { idleSince: input.idleSince } : {}),
			...(input.contextTokens !== undefined ? { contextTokens: input.contextTokens } : {}),
			...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
			...(input.compaction !== undefined ? { compaction: input.compaction } : {}),
			...(input.paneId !== undefined ? { paneId: input.paneId } : {}),
			...(input.wakeHold !== undefined ? { wakeHold: input.wakeHold } : {}),
			...(input.lastInputAt !== undefined ? { lastInputAt: input.lastInputAt } : {}),
		},
		context,
	);
	const claim = beat.activeClaim;
	const now = new Date().toISOString();
	const state: SupervisorHeartbeatState = {
		schemaVersion: SUPERVISOR_SCHEMA_VERSION,
		pid,
		sessionId: input.sessionId,
		programmeId: beat.programmeId,
		generation: beat.runGeneration,
		heartbeatAt: now,
		claim:
			claim === null
				? null
				: {
						claimId: claim.claimId,
						owner: claim.owner,
						runGeneration: claim.runGeneration,
						admittedAt: claim.admittedAt,
					},
		status: beat.status,
		pidStartTicks: readProcessStartTicks(pid) ?? null,
		bootId: readBootId() ?? null,
		updatedAt: now,
	};
	writeSupervisorHeartbeatState(state, options?.statePath ?? supervisorStatePath());
	return state;
}

// ─── Recovery observations ───────────────────────────────────────────────────

/** Reason an observation could not admit a recovery wake. */
export type RecoveryBlockReason =
	| "process-alive"
	| "ambiguous"
	| "programme-off"
	| "programme-paused"
	| "programme-waiting"
	| "kill-file";

export type RecoveryObservationInput = {
	programmeId: string;
	/** Generation the observing process is bound to (must match the record). */
	generation: number;
	observation: RecoveryObservationKind;
	/** Process liveness evidence: pid, `/proc` check, boot id. Never a transcript. */
	evidence: string;
	/** Overrides the recorded heartbeat's session (tests, operator context). */
	sessionRef?: string;
	/** Observation number within the generation; defaults to the next free n. */
	sequence?: number;
	/** Journal override (tests); defaults to the recording session's journal. */
	journal?: MusterJournal;
	recordedAt?: string;
};

export type RecoveryObservationResult =
	| {
			outcome: "published";
			sourceEventId: string;
			deliveryKey: string;
			programmeId: string;
			sessionRef: string;
			generation: number;
			observation: RecoveryObservationKind;
			message: string;
			/** True only for proven death with every operator gate clear. */
			wakeEnqueued: boolean;
			blockedBy?: RecoveryBlockReason;
	  }
	| {
			outcome: "refused";
			reason: "no-record" | "generation-mismatch" | "no-session";
			detail?: string;
	  };

/**
 * Publish one liveness observation into the durable delivery journal and, when
 * the evidence proves process death and no operator gate is closed, enqueue the
 * fenced recovery wake `supervisor-<generation>-<n>` for the admission owner.
 *
 * The observation is written before the wake, so a wake can never exist without
 * its evidence. Alive or ambiguous observations write the same durable record
 * with an actionable blocker text and enqueue no wake at all.
 */
export async function publishRecoveryObservation(
	input: RecoveryObservationInput,
	context?: ProgrammeControlContext,
): Promise<RecoveryObservationResult> {
	const evidence = typeof input?.evidence === "string" ? input.evidence.trim() : "";
	if (evidence === "") {
		throw new ProgrammeControlStateError("io", "publishRecoveryObservation requires non-empty evidence");
	}
	const generation = input?.generation;
	if (!positiveInteger(generation)) {
		throw new ProgrammeControlStateError(
			"io",
			"publishRecoveryObservation requires a positive integer generation",
		);
	}
	if (!isRecoveryObservationKind(input?.observation)) {
		throw new ProgrammeControlStateError(
			"io",
			"publishRecoveryObservation observation must be process-death-proven, process-alive or ambiguous",
		);
	}
	const store = context?.store ?? fileProgrammeControlStore();
	const record = store.read(input.programmeId);
	if (record === undefined) return { outcome: "refused", reason: "no-record" };
	if (record.runGeneration !== generation) {
		// Fencing: an older generation's observer must not act on a newer programme.
		return {
			outcome: "refused",
			reason: "generation-mismatch",
			detail: `record generation ${record.runGeneration}`,
		};
	}
	const sessionRef = nonEmpty(input.sessionRef) ? input.sessionRef.trim() : record.lastHeartbeat?.sessionId;
	if (!nonEmpty(sessionRef)) return { outcome: "refused", reason: "no-session" };
	const journal = input.journal ?? new MusterJournal(sessionRef.trim(), musterSessionsDir());
	const sequence =
		input.sequence ?? (await nextRecoveryObservationSequence(journal, generation, record));
	const sourceEventId = `supervisor-${generation}-${sequence}`;
	const deliveryKey = recoveryObservationDeliveryKey(sourceEventId);
	const gate = recoveryObservationGate(record, context);
	const wakeEnqueued = input.observation === "process-death-proven" && gate === undefined;
	const blockedBy = wakeEnqueued ? undefined : recoveryObservationBlockReason(input.observation, gate);
	const message = recoveryObservationMessage({
		observation: input.observation,
		evidence,
		programmeId: input.programmeId,
		generation,
		sourceEventId,
		sessionRef: sessionRef.trim(),
		...(record.lastHeartbeat !== null ? { pid: record.lastHeartbeat.pid } : {}),
		...(record.activeClaim !== null ? { claimId: record.activeClaim.claimId } : {}),
		...(blockedBy !== undefined ? { blockedBy } : {}),
	});
	const recordedAt = input.recordedAt ?? new Date().toISOString();
	await journal.append({
		type: "delivery",
		record: {
			type: "pending",
			deliveryKey,
			repoKey: "",
			sessionId: sessionRef.trim(),
			target: {
				kind: "recovery-observation",
				sourceEventId,
				programmeId: input.programmeId,
				generation,
				observation: input.observation,
				evidence,
				admitsWake: wakeEnqueued,
			},
			payload: message,
			at: recordedAt,
		},
		at: recordedAt,
	});
	if (wakeEnqueued) {
		enqueueWake(
			input.programmeId,
			{ sourceEventId, kind: "watchdog", reason: message, sessionRef: sessionRef.trim() },
			context,
		);
	}
	return {
		outcome: "published",
		sourceEventId,
		deliveryKey,
		programmeId: input.programmeId,
		sessionRef: sessionRef.trim(),
		generation,
		observation: input.observation,
		message,
		wakeEnqueued,
		...(blockedBy !== undefined ? { blockedBy } : {}),
	};
}

/** The gate an observation meets at publish time; `undefined` = admissible. */
export function recoveryObservationGate(
	record: ProgrammeControlRecord,
	context?: ProgrammeControlContext,
): RecoveryBlockReason | undefined {
	if (record.status === "off") return "programme-off";
	if (record.status === "paused") return "programme-paused";
	if (record.status === "waiting") return "programme-waiting";
	const paths = context?.killFilePath !== undefined ? [context.killFilePath] : programmeControlKillFilePaths();
	if (paths.some((path) => existsSync(path))) return "kill-file";
	return undefined;
}

/** Why an observation admitted no wake: the operator gate, else its own kind. */
export function recoveryObservationBlockReason(
	observation: RecoveryObservationKind,
	gate: RecoveryBlockReason | undefined,
): RecoveryBlockReason {
	if (gate !== undefined) return gate;
	return observation === "process-alive" ? "process-alive" : "ambiguous";
}

/**
 * Next free `n` for `supervisor-<generation>-<n>`: the maximum already used by
 * this programme's pending/claimed wake IDs and by the session journal, + 1.
 * Reading both keeps the identity unique even when a programme moves between
 * sessions or the watchdog restarts.
 */
export async function nextRecoveryObservationSequence(
	journal: MusterJournal,
	generation: number,
	record?: ProgrammeControlRecord,
): Promise<number> {
	const pattern = `supervisor-${generation}-`;
	let max = 0;
	const note = (sourceEventId: string): void => {
		if (!sourceEventId.startsWith(pattern)) return;
		const value = Number.parseInt(sourceEventId.slice(pattern.length), 10);
		if (Number.isInteger(value) && value > max) max = value;
	};
	for (const wake of record?.pendingWakes ?? []) note(wake.sourceEventId);
	for (const sourceEventId of record?.activeClaim?.wakeIds ?? []) note(sourceEventId);
	try {
		const fold = await journal.fold();
		for (const delivery of fold.deliveries.values()) note(recoverySourceEventIdOf(delivery));
	} catch {
		/* an unreadable journal costs uniqueness only for this call */
	}
	return max + 1;
}

/** The `supervisor-<generation>-<n>` identity of a recovery delivery, if any. */
export function recoverySourceEventIdOf(record: {
	deliveryKey: string;
	target?: { kind: string; sourceEventId?: string };
}): string {
	if (record.target?.kind === "recovery-observation" && typeof record.target.sourceEventId === "string") {
		return record.target.sourceEventId;
	}
	const prefix = "recovery/";
	return record.deliveryKey.startsWith(prefix) ? record.deliveryKey.slice(prefix.length) : "";
}

export type RecoveryObservationMessageInput = {
	observation: RecoveryObservationKind;
	evidence: string;
	programmeId: string;
	generation: number;
	sourceEventId: string;
	sessionRef: string;
	pid?: number;
	claimId?: string;
	blockedBy?: RecoveryBlockReason;
};

const SUPERVISION_FOOTER =
	"This is a supervision observation from the Muster watchdog, not a continuation prompt: it schedules no product work, and the continuation admission owner decides whether and when work resumes.";

/**
 * Actionable same-chat text for one observation. It names the evidence, the
 * addressee, whether a wake was admitted and exactly what could not be proven;
 * it never claims that recovery succeeded.
 */
export function recoveryObservationMessage(input: RecoveryObservationMessageInput): string {
	const process = input.pid === undefined ? "the recorded process" : `pid ${input.pid}`;
	const head = `Muster recovery · programme ${input.programmeId} · generation ${input.generation}`;
	const addressee = `session ${input.sessionRef}`;
	const claim =
		input.claimId === undefined ? "" : ` Interrupted claim ${input.claimId} is preserved for the same owner.`;
	switch (input.observation) {
		case "process-death-proven":
			if (input.blockedBy !== undefined) {
				return `${head}: process death is proven for ${process} (${input.evidence}), but the programme is ${input.blockedBy}, so no recovery wake was admitted.${claim} Operator action: lift the ${input.blockedBy} state explicitly, then resume; the observation stays durable for the admission owner. ${SUPERVISION_FOOTER}`;
			}
			return `${head}: process death is proven for ${process} of ${addressee} (${input.evidence}), so the previous writer cannot still be writing. Fenced recovery wake ${input.sourceEventId} is pending for the admission owner; ambiguous completed side effects are not replayed.${claim} ${SUPERVISION_FOOTER}`;
		case "process-alive":
			return `${head}: ${process} of ${addressee} is still alive while its heartbeat is stale beyond the grace window (${input.evidence}). What could not be proven: that the process stopped writing, or that its in-flight children and checks are settled. No replacement writer was authorized and no continuation was admitted.${claim} Operator action: check that session directly, then continue, pause or resume it explicitly. ${SUPERVISION_FOOTER}`;
		default:
			return `${head}: liveness of ${process} of ${addressee} could not be determined (${input.evidence}). What could not be proven: whether the process is alive, whether it can still write, and whether its descendants are settled. No replacement writer was authorized and no continuation was admitted.${claim} Operator action: inspect the process and choose an explicit resume or pause. ${SUPERVISION_FOOTER}`;
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isRecoveryObservationKind(value: unknown): value is RecoveryObservationKind {
	return value === "process-death-proven" || value === "process-alive" || value === "ambiguous";
}

function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}
