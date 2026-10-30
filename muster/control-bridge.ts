/**
 * Programme control bridge — session enrolment resolution plus the
 * wake/admission/complete wiring the Muster and Delegate extensions share
 * (plan §7 P1.2, §3 "Continuation admission").
 *
 * The control record (control.ts, P1.1) owns every admission predicate. This
 * module only:
 * - resolves a session to the programme that enrolled it, by scanning the
 *   control records (`state/muster/programmes/control/<programmeId>.json`);
 * - submits idempotent wake reasons and asks the store for the single
 *   continuation claim (`enqueueWake` → `claimContinuation`, never authority);
 * - tracks the one in-flight claim per session so the settled-run boundary can
 *   record a structured outcome and release it (`completeContinuation`);
 * - reuses the store's kill-file check rather than defining a second stop.
 *
 * Ownership contract (operator-approved): enrolment resolves through the
 * record's execution owner first — the single session that ran `/muster on`.
 * Historical `enrolledSessions` and the Agile bootstrap `sessionId` stay
 * authoritative only for records written before ownership existed (no `owner`
 * field). Once a record carries an owner, historical enrolment grants no
 * authority: a takeover disconnects every previous session.
 *
 * A session with no control record resolves as `not-enrolled`: callers keep
 * today's behaviour and make zero control-store calls. Malformed records are
 * never reset or repaired; they are skipped (reported once per process) so one
 * bad file cannot take down every session — see the wiring handoff for the
 * resulting fail-open note.
 *
 * The resolver reads disk on every call: no cache can be authoritative while
 * pause/resume, enrolment and claims are written by other processes.
 */

import { existsSync } from "node:fs";

import { fileProgrammeStore, programmesStateDir, type ProgrammeRecord } from "../core/programme.ts";
import {
	attachProgramme,
	claimContinuation,
	completeContinuation,
	enqueueWake,
	listProgrammeControlRecords,
	programmeControlStore,
	pauseProgramme,
	programmeControlKillFilePaths,
	programmeControlStateDir,
	ProgrammeControlStateError,
	recoverInterruptedClaim,
	resumeProgramme,
	stopProgramme,
	type AttachProgrammeOptions,
	type AttachProgrammeResult,
	type ContinuationDenialReason,
	type ContinuationOutcome,
	type ContinuationWaitingReason,
	type ProgrammeControlContext,
	type ProgrammeControlRecord,
	type ProgrammeControlStatus,
	type OwnerFence,
	type WakeEvent,
} from "./control.ts";

// ─── Context and results ─────────────────────────────────────────────────────

export type ControlBridgeContext = ProgrammeControlContext & {
	/** Physical caller identity when resolving execution authority (omitted only by legacy readers). */
	processKey?: string;
	/** Control-record directory override (defaults to control.ts's root). */
	controlDir?: string;
	/** Agile programme-record directory override (defaults to operating-mode's root). */
	programmeDir?: string;
};

export type ProgrammeEnrollment = {
	programmeId: string;
	sessionRef: string;
	status: ProgrammeControlStatus;
	runGeneration: number;
	pendingWakeCount: number;
	/**
	 * Ownership contract: the epoch this session currently owns. `undefined`
	 * for legacy records (no `owner`) which still resolve through the
	 * historical enrolledSessions path.
	 */
	ownerEpoch?: number;
	ownerProcessKey?: string;
	ownerLeaseExpiresAt?: string;
};

/** Which continuation source owns an in-flight claim (outcome signals differ per source). */
export type ProgrammeContinuationOwner = "muster" | "delegate";

export type ProgrammeContinuationRequest = {
	sessionRef: string;
	/** Continuation source; only the owner may complete the claim it admitted. */
	owner: ProgrammeContinuationOwner;
	/** Idempotent events in this batch; duplicate source event IDs coalesce. */
	events: WakeEvent[];
	/**
	 * Caller-side hold, evaluated only for an enrolled session: true retains the
	 * wake without asking for the claim (mid-run, compaction, pending operator
	 * input). The pump's own gates handle the common case; this closes the
	 * "queued human input while idle" window without changing non-enrolled runs.
	 */
	hold?: () => boolean;
};

/**
 * Outcome of one admission attempt. `waiting`, `denied` and `deferred` all keep
 * the persisted wake in the store: the caller must not send a continuation
 * prompt. `not-enrolled` means no control record covers the session — today's
 * behaviour applies unchanged.
 */
export type ProgrammeContinuationAdmission =
	| { outcome: "not-enrolled" }
	| {
			outcome: "admitted";
			programmeId: string;
			sessionRef: string;
			claimId: string;
			/** Set when a crashed admission's claim was replayed for this owner (P4.2). */
			recoveredClaimId?: string;
	  }
	| { outcome: "waiting"; programmeId: string; reasons: ContinuationWaitingReason[] }
	| { outcome: "denied"; programmeId: string; reason: ContinuationDenialReason }
	| { outcome: "deferred"; programmeId: string; reason: "session-busy" }
	| { outcome: "unavailable"; programmeId: string; reason: string };

export type ActiveProgrammeContinuation = {
	programmeId: string;
	sessionRef: string;
	claimId: string;
	owner: ProgrammeContinuationOwner;
	admittedAt: string;
};

export type ProgrammeCompletion = {
	programmeId: string;
	claimId: string;
	outcome: ContinuationOutcome;
	released: boolean;
	runGeneration?: number;
	error?: string;
};

// ─── In-flight claim tracking (one per session, process-local) ───────────────

const activeContinuations = new Map<string, ActiveProgrammeContinuation>();
const reportedSkipped = new Set<string>();

// ─── Enrolment resolution ────────────────────────────────────────────────────

function controlDirFor(context: ControlBridgeContext | undefined): string {
	return context?.controlDir ?? context?.store?.dir ?? programmeControlStateDir();
}

function controlStoreFor(context: ControlBridgeContext | undefined) {
	return context?.store ?? programmeControlStore(controlDirFor(context));
}

function reportSkippedRecord(file: string, error: string): void {
	const key = `${file}:${error}`;
	if (reportedSkipped.has(key) || reportedSkipped.size > 64) return;
	reportedSkipped.add(key);
	process.stderr.write(`muster: skipping unreadable programme control record ${file}: ${error}\n`);
}

/** Scan the control records through their owner; malformed records are skipped and reported, never reset. */
function scanControlRecords(context: ControlBridgeContext | undefined): Map<string, ProgrammeControlRecord> {
	const scan = listProgrammeControlRecords(controlStoreFor(context), controlDirFor(context));
	for (const entry of scan.skipped) reportSkippedRecord(entry.file, entry.error);
	return scan.records;
}

function enrollmentOf(record: ProgrammeControlRecord, sessionRef: string): ProgrammeEnrollment {
	const owner = record.owner ?? null;
	return {
		programmeId: record.programmeId,
		sessionRef,
		status: record.status,
		runGeneration: record.runGeneration,
		pendingWakeCount: record.pendingWakes.length,
		...(owner !== null && owner.sessionId === sessionRef
			? {
					ownerEpoch: owner.epoch,
					ownerProcessKey: owner.processKey,
					ownerLeaseExpiresAt: owner.leaseExpiresAt,
			  }
			: {}),
	};
}

function sortedRecords(records: Map<string, ProgrammeControlRecord>): ProgrammeControlRecord[] {
	return [...records.values()].sort((left, right) => left.programmeId.localeCompare(right.programmeId));
}

/** Every non-`off` enrolled session → programme mapping currently on disk. */
export function listProgrammeEnrollments(context?: ControlBridgeContext): ProgrammeEnrollment[] {
	const records = scanControlRecords(context);
	const enrollments: ProgrammeEnrollment[] = [];
	for (const record of sortedRecords(records)) {
		if (record.status === "off") continue;
		const owner = record.owner ?? null;
		if (owner !== null) {
			// Ownership contract: the current owner is the enrolled session; other
			// sessions (including historically enrolled ones) resolve nothing.
			enrollments.push(enrollmentOf(record, owner.sessionId));
			continue;
		}
		for (const sessionRef of record.enrolledSessions) enrollments.push(enrollmentOf(record, sessionRef));
	}
	// Bootstrap enrollments: an Agile programme record names its parent session
	// before any claim has written `enrolledSessions`. Deduped against explicit
	// control-record enrollments so one session/programme pair appears once.
	const seen = new Set(enrollments.map((entry) => `${entry.programmeId}\u0000${entry.sessionRef}`));
	for (const agile of listBootstrapRecords(context)) {
		if (agile.sessionId === "") continue;
		const control = records.get(agile.programmeId);
		if (control === undefined || control.status === "off") continue;
		// Owned records resolve by owner only; bootstrap covers legacy records.
		if ((control.owner ?? null) !== null) continue;
		if (control.enrolledSessions.includes(agile.sessionId)) continue;
		const key = `${agile.programmeId}\u0000${agile.sessionId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		enrollments.push(enrollmentOf(control, agile.sessionId));
	}
	return enrollments.sort((left, right) => left.programmeId.localeCompare(right.programmeId) || left.sessionRef.localeCompare(right.sessionRef));
}

/** Agile programme records on disk, sorted; a malformed record is reported once and skipped. */
function listBootstrapRecords(context?: ControlBridgeContext): ProgrammeRecord[] {
	const dir = context?.programmeDir ?? programmesStateDir();
	try {
		return fileProgrammeStore(dir).list().records.sort((left, right) => left.programmeId.localeCompare(right.programmeId));
	} catch (error) {
		reportSkippedRecord(dir, messageOf(error));
		return [];
	}
}

/**
 * Resolve a session to its enrolled programme, or `undefined` when no control
 * record covers it. No record → no control call anywhere in the bridge.
 */
export function resolveEnrolledProgramme(
	sessionRef: string,
	context?: ControlBridgeContext,
): ProgrammeEnrollment | undefined {
	const session = typeof sessionRef === "string" ? sessionRef.trim() : "";
	if (session === "") return undefined;
	const records = scanControlRecords(context);
	if (records.size === 0) return undefined;
	for (const record of sortedRecords(records)) {
		if (record.status === "off") continue;
		const owner = record.owner ?? null;
		if (owner !== null) {
			// Ownership contract: the current owner is the enrolled session; other
			// sessions (including historically enrolled ones) resolve nothing.
			if (owner.sessionId === session && (context?.processKey === undefined || owner.processKey === context.processKey)) {
				return enrollmentOf(record, session);
			}
			continue;
		}
		// Legacy record without owner: enrolledSessions stay authoritative.
		if (record.enrolledSessions.includes(session)) return enrollmentOf(record, session);
	}
	// Bootstrap: the Agile programme record names its parent session before any
	// claim has written `enrolledSessions`.
	let agileRecords: ProgrammeRecord[];
	try {
		agileRecords = fileProgrammeStore(context?.programmeDir ?? programmesStateDir()).list().records;
	} catch (error) {
		reportSkippedRecord(context?.programmeDir ?? programmesStateDir(), messageOf(error));
		return undefined;
	}
	for (const agile of agileRecords.sort((left, right) => left.programmeId.localeCompare(right.programmeId))) {
		if (agile.sessionId !== session) continue;
		const control = records.get(agile.programmeId);
		if (control === undefined || control.status === "off") continue;
		// Owned records resolve by owner only; bootstrap covers legacy records.
		if ((control.owner ?? null) !== null) continue;
		return enrollmentOf(control, session);
	}
	return undefined;
}

export type ProgrammeBootAuthority =
	| { outcome: "ready"; enrollment: ProgrammeEnrollment }
	| { outcome: "reattach-required"; programmeId: string; command: string }
	| { outcome: "not-enrolled" };

/** Boot is observation, not operator takeover: a saved UUID cannot revoke another process. */
export function resolveProgrammeBootAuthority(
	sessionRef: string,
	processKey: string,
	context?: ControlBridgeContext,
): ProgrammeBootAuthority {
	const enrollment = resolveEnrolledProgramme(sessionRef, { ...context, processKey });
	if (enrollment !== undefined) return { outcome: "ready", enrollment };
	// UUID-only lookup is diagnostic, never execution authority. This also makes
	// legacy process-key formats visibly require an explicit operator reattach.
	const advisory = resolveEnrolledProgramme(sessionRef, { ...context, processKey: undefined });
	if (advisory?.ownerEpoch !== undefined) {
		return {
			outcome: "reattach-required",
			programmeId: advisory.programmeId,
			command: `/muster on ${advisory.programmeId}`,
		};
	}
	return { outcome: "not-enrolled" };
}

/** The store's kill-file predicate (both documented operator paths). */
export function programmeKillFileActive(context?: ControlBridgeContext): boolean {
	const paths = context?.killFilePath !== undefined ? [context.killFilePath] : programmeControlKillFilePaths();
	return paths.some((path) => existsSync(path));
}

// ─── Operator ownership controls (on / pause / resume / off) ─────────────────

/**
 * Operator attach (`/muster on`): give this session exclusive execution
 * ownership of the programme (creating the control record when missing). The
 * caller owns relay lifecycle: it starts the epoch socket and writes the
 * relay-owner pointer after this returns.
 */
export function attachProgrammeControl(
	programmeId: string,
	options: AttachProgrammeOptions,
	context?: ControlBridgeContext,
): AttachProgrammeResult {
	return attachProgramme(programmeId, options, context);
}

/** Operator pause, fenced to the caller's current ownership epoch. */
export function pauseProgrammeControl(
	programmeId: string,
	options: { reason: string; operatorRef?: string; ownerFence?: OwnerFence },
	context?: ControlBridgeContext,
): ProgrammeControlRecord {
	return pauseProgramme(programmeId, options.reason, context, options.ownerFence);
}

/** Operator resume, fenced like pause. */
export function resumeProgrammeControl(
	programmeId: string,
	options: { operatorRef: string; ownerFence?: OwnerFence },
	context?: ControlBridgeContext,
): ProgrammeControlRecord {
	return resumeProgramme(programmeId, options.operatorRef, context, options.ownerFence);
}

/** Operator off: revoke execution authorization and release the Discord binding. */
export function stopProgrammeControl(
	programmeId: string,
	options: { reason: string; operatorRef?: string },
	context?: ControlBridgeContext,
): ProgrammeControlRecord {
	return stopProgramme(programmeId, options, context);
}

/** Shared idempotent wake identity for a Muster delivery key (pump batches and reconciliation). */
export function programmeWakeForDelivery(deliveryKey: string): Pick<WakeEvent, "kind" | "sourceEventId" | "reason"> {
	if (deliveryKey.startsWith("msg/")) {
		const messageId = deliveryKey.slice("msg/".length);
		return {
			kind: "handoff",
			sourceEventId: `muster-inbox/${messageId}`,
			reason: `muster inbox delivery ${messageId}`,
		};
	}
	if (deliveryKey.startsWith("pwake/")) {
		// Programme wake (frontier or watchdog): `pwake/<kind>/<sourceEventId>`; the
		// real reason text comes from the batch's delivery row.
		const rest = deliveryKey.slice("pwake/".length);
		const slash = rest.indexOf("/");
		const kind = slash < 0 ? rest : rest.slice(0, slash);
		const sourceEventId = slash < 0 ? rest : rest.slice(slash + 1);
		return {
			kind: kind === "watchdog" ? "watchdog" : kind === "rotation" ? "rotation" : "frontier",
			sourceEventId: `${kind}/${sourceEventId}`,
			reason: `muster ${kind} wake ${sourceEventId}`,
		};
	}
	if (deliveryKey.startsWith("recovery/")) {
		// Watchdog recovery observation (plan §7 P4.2): the delivery key carries
		// the fenced `supervisor-<generation>-<n>` identity, so the wake keeps the
		// identity the publishing process used and the real reason text comes from
		// the batch's delivery row.
		const sourceEventId = deliveryKey.slice("recovery/".length);
		return {
			kind: "watchdog",
			sourceEventId,
			reason: `muster recovery observation ${sourceEventId}`,
		};
	}
	return {
		kind: "handoff",
		sourceEventId: `muster-reconcile/${deliveryKey}`,
		reason: `muster task event ${deliveryKey}`,
	};
}

// ─── Wake / admission / completion ───────────────────────────────────────────

/**
 * Persist one wake reason without asking for a claim. Used when an event is
 * discovered before its delivery is eligible (busy session, queued batch): the
 * hint is durable, and admission still happens only through
 * `admitProgrammeContinuation`.
 */
export function noteProgrammeWake(sessionRef: string, event: WakeEvent, context?: ControlBridgeContext): boolean {
	const session = typeof sessionRef === "string" ? sessionRef.trim() : "";
	const enrollment = resolveEnrolledProgramme(session, context);
	if (enrollment === undefined) return false;
	try {
		enqueueWake(
			enrollment.programmeId,
			{ sourceEventId: event.sourceEventId, kind: event.kind, reason: event.reason, sessionRef: session },
			context,
		);
		return true;
	} catch (error) {
		reportSkippedRecord(enrollment.programmeId, messageOf(error));
		return false;
	}
}

/**
 * Submit the batch's wake reasons and ask the store for the single
 * continuation claim. Admission is the store's decision; this function never
 * admits by itself.
 */
export function admitProgrammeContinuation(
	request: ProgrammeContinuationRequest,
	context?: ControlBridgeContext,
): ProgrammeContinuationAdmission {
	const session = typeof request?.sessionRef === "string" ? request.sessionRef.trim() : "";
	const events = Array.isArray(request?.events) ? request.events : [];
	if (session === "") return { outcome: "not-enrolled" };
	const enrollment = resolveEnrolledProgramme(session, context);
	if (enrollment === undefined) return { outcome: "not-enrolled" };
	const programmeId = enrollment.programmeId;
	// An enrolled batch with no wake identity cannot be judged: hold it rather than
	// fall through to an unauthorized send.
	if (events.length === 0) return { outcome: "unavailable", programmeId, reason: "empty wake batch" };
	for (const event of events) {
		if (!nonEmpty(event?.sourceEventId) || !nonEmpty(event?.reason)) {
			return { outcome: "unavailable", programmeId, reason: "invalid wake event" };
		}
	}
	try {
		for (const event of events) {
			enqueueWake(
				programmeId,
				{ sourceEventId: event.sourceEventId, kind: event.kind, reason: event.reason, sessionRef: session },
				context,
			);
		}
		// Duplicated for a concrete denial reason; `claimContinuation` remains the
		// authoritative predicate (it re-checks the kill file inside the store).
		if (programmeKillFileActive(context)) return { outcome: "denied", programmeId, reason: "kill-file" };
		if (request.hold?.() === true) return { outcome: "deferred", programmeId, reason: "session-busy" };
		// Crash between admission and delivery (plan §7 P4.2): a persisted claim
		// with no live run in this process is durable evidence, not a permanent
		// block. Recovery is fenced by generation and only ever replays this same
		// session's claim; the replayed wakes drain into the new claim below.
		let recoveredClaimId: string | undefined;
		if (activeContinuations.get(session) === undefined) {
			const recovery = recoverInterruptedClaim(programmeId, enrollment.runGeneration, context, {
				sessionRef: session,
				// Ownership contract: the current owner may also recover a stale claim
				// left by a previous (crashed) owner after a takeover.
				...(enrollment.ownerEpoch !== undefined
					? { ownerFence: { sessionId: session, processKey: enrollment.ownerProcessKey ?? "", epoch: enrollment.ownerEpoch } }
					: {}),
			});
			if (recovery.outcome === "recovered") recoveredClaimId = recovery.claim.claimId;
		}
		const claim = claimContinuation(
			programmeId,
			session,
			context,
			// Ownership fencing: if a takeover or off happened after the enrollment
			// was resolved, the CAS rejects this claim instead of landing it on the
			// new owner's record.
			enrollment.ownerEpoch === undefined ? undefined : { sessionId: session, processKey: enrollment.ownerProcessKey ?? "", epoch: enrollment.ownerEpoch },
		);
		if (claim.outcome === "admitted") {
			activeContinuations.set(session, {
				programmeId,
				sessionRef: session,
				claimId: claim.claimId,
				owner: request.owner,
				admittedAt: new Date().toISOString(),
			});
			return {
				outcome: "admitted",
				programmeId,
				sessionRef: session,
				claimId: claim.claimId,
				...(recoveredClaimId !== undefined ? { recoveredClaimId } : {}),
			};
		}
		if (claim.outcome === "waiting") return { outcome: "waiting", programmeId, reasons: claim.reasons };
		return { outcome: "denied", programmeId, reason: claim.reason };
	} catch (error) {
		return { outcome: "unavailable", programmeId, reason: messageOf(error) };
	}
}

/**
 * A programme wake (frontier or watchdog) starts a continuation, so it may only
 * go out after the control store admitted it. A session that is not the owner
 * resolves as `not-enrolled`, whose ordinary-relay path must not carry one.
 */
export function wakeBatchNeedsAdmission(outcome: string, details: unknown): boolean {
	if (outcome !== "not-enrolled") return false;
	const deliveries = (details as { deliveries?: unknown } | undefined)?.deliveries;
	return Array.isArray(deliveries) && deliveries.some((row) => String((row as { deliveryKey?: unknown })?.deliveryKey ?? "").startsWith("pwake/"));
}

export type ProgrammeSteerAdmission =
	| { outcome: "not-enrolled" }
	| { outcome: "admitted"; programmeId: string }
	| { outcome: "denied"; programmeId: string; reason: ContinuationDenialReason }
	| { outcome: "unavailable"; programmeId: string; reason: string };

/**
 * Admission for a message steered into a run that is already in progress. It
 * starts no run, so it takes no continuation claim and writes nothing: it only
 * checks that the programme still allows work (running, no kill file, this
 * session is still the owner). A paused, off or waiting programme denies it and
 * the delivery stays pending for later.
 */
export function admitProgrammeSteer(
	request: { sessionRef: string; events: WakeEvent[] },
	context?: ControlBridgeContext,
): ProgrammeSteerAdmission {
	const session = typeof request?.sessionRef === "string" ? request.sessionRef.trim() : "";
	if (session === "") return { outcome: "not-enrolled" };
	const enrollment = resolveEnrolledProgramme(session, context);
	if (enrollment === undefined) return { outcome: "not-enrolled" };
	const programmeId = enrollment.programmeId;
	if (programmeKillFileActive(context)) return { outcome: "denied", programmeId, reason: "kill-file" };
	try {
		const record = controlStoreFor(context).read(programmeId);
		if (record === undefined) return { outcome: "unavailable", programmeId, reason: "no programme record" };
		if (record.status === "off") return { outcome: "denied", programmeId, reason: "programme-off" };
		if (record.status === "paused") return { outcome: "denied", programmeId, reason: "programme-paused" };
		if (record.status !== "running") return { outcome: "unavailable", programmeId, reason: `programme is ${record.status}` };
		return { outcome: "admitted", programmeId };
	} catch (error) {
		return { outcome: "unavailable", programmeId, reason: messageOf(error) };
	}
}

/** The in-flight continuation claim for one session, when this process holds it. */
export function activeProgrammeContinuation(
	sessionRef: string,
	owner?: ProgrammeContinuationOwner,
): ActiveProgrammeContinuation | undefined {
	const active = activeContinuations.get(sessionRef);
	if (active === undefined) return undefined;
	if (owner !== undefined && active.owner !== owner) return undefined;
	return { ...active };
}

/**
 * Record the admitted run's structured outcome and release the claim. Returns
 * `undefined` when this process holds no claim for the session (already
 * completed, never admitted here, or owned by another continuation source when
 * `owner` is given). A transient store failure keeps the in-memory claim so a
 * later settled run can retry; a conflict releases it because the stored claim
 * no longer exists.
 */
export function completeProgrammeContinuation(
	sessionRef: string,
	outcome: ContinuationOutcome,
	context?: ControlBridgeContext,
	owner?: ProgrammeContinuationOwner,
): ProgrammeCompletion | undefined {
	const active = activeContinuations.get(sessionRef);
	if (active === undefined) return undefined;
	if (owner !== undefined && active.owner !== owner) return undefined;
	try {
		const record = completeContinuation(active.programmeId, active.claimId, outcome, context);
		activeContinuations.delete(sessionRef);
		return {
			programmeId: active.programmeId,
			claimId: active.claimId,
			outcome,
			released: true,
			runGeneration: record.runGeneration,
		};
	} catch (error) {
		if (error instanceof ProgrammeControlStateError && error.code === "conflict") {
			activeContinuations.delete(sessionRef);
		}
		return {
			programmeId: active.programmeId,
			claimId: active.claimId,
			outcome,
			released: false,
			error: messageOf(error),
		};
	}
}

/**
 * Map the observed end-of-run signals onto the plan §3 outcomes. `aborted` and
 * `error` are the run's own terminal reasons; `waiting_worker` is used when the
 * only work left is with dispatched workers. `waiting_check`,
 * `waiting_decision` and `completed` need signals the extension events do not
 * carry today (P1.2 step 2's `programme_yield` surface).
 */
export function programmeOutcomeFromSignals(input: {
	stopReason?: string;
	workersOutstanding?: boolean;
}): ContinuationOutcome {
	if (input.stopReason === "aborted") return "paused";
	if (input.stopReason === "error") return "failed";
	if (input.workersOutstanding === true) return "waiting_worker";
	return "progressed";
}

/** Test/reset seam for the in-memory claim map (never touches the store). */
export function resetProgrammeContinuations(): void {
	activeContinuations.clear();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
