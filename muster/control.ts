/**
 * Programme continuation control record (plan §7 P1.1, §3 "L0 — deterministic
 * supervision").
 *
 * One durable, versioned aggregate per programme owns what the existing Muster
 * owners lack:
 * - the current run generation and the single active continuation claim;
 * - pending (deduplicated) wake reasons submitted by handoff, original delegate
 *   completion, operator answer, relevant state transition or watchdog events;
 * - writer reservations counted against the programme ceiling;
 * - descendant writer reservations (plan §7 P3): the files each lane/leaf
 *   writer of a programme subtree has claimed, refused on overlap so sibling
 *   writers never collide, and counted against the same ceiling;
 * - pause state plus operator provenance for resume, and reference-only
 *   decision IDs (never copied decision content, grants or backlog).
 *
 * A wake is a hint, never authority (plan §7 P1.1.4). Every transition is
 * serialized through the repository's locked atomic-write helper
 * (`updateJsonSettingsFile`), the same compare-and-set primitive the Agile
 * decomposition store uses. A malformed record fails closed with a typed error
 * and is never reset to defaults.
 *
 * Storage root: `<agentDir>/state/muster/programmes/control/<programmeId>.json`.
 * The plan names `state/muster/programmes/<programmeId>.json`, but that exact
 * path is already owned by the Agile programme record (`lib/operating-mode.ts`
 * `ProgrammeStore`); a dedicated `control/` subdirectory keeps this aggregate
 * from overwriting or shadowing it.
 *
 * Standalone by design (P1.1): no Pi API, no Concord process, no network and
 * no event wiring — `muster/index.ts` integration is P1.2. Reads always come
 * from disk; nothing here caches a record between calls.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { isDelegateCheckEvidence, type DelegateCheckEvidence } from "../core/delegate-evidence.ts";
import { isRuntimeActorIdentity, type RuntimeActorIdentity } from "./lead.ts";
import { readBackend } from "./ledger/backend.ts";
import { ledgerCasStore, type LedgerCasStore } from "./ledger/cas-store.ts";
import { PROGRAMME_CONTROL_STORE, ownerLedgerSocket } from "./ledger/stores.ts";
import { CAS_ATTEMPTS, fileCasStore, ownerFenceSatisfied, type OwnerFence } from "./owner-fence.ts";
import { reviewIsIndependent } from "./merge-queue.ts";
import {
	killFilePath,
	laneOwnerRef,
	parseDescendantOwnerRef,
	piAgentDir,
	musterStateDir,
	validateAgentId,
	type DescendantOwnerKind,
} from "./binding.ts";

// The fence is owned by owner-fence.ts; programme callers keep importing it from here.
export { ownerFenceSatisfied, type OwnerFence };

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export const PROGRAMME_CONTROL_SCHEMA_VERSION = 1 as const;
/** Default delivery capacity: five active worker writers, including descendants. */
export const DEFAULT_WRITER_CEILING = 5;
export const MAX_WRITER_CEILING = 64;
/**
 * Bounded descendant-reservation rows per programme (plan §7 P3): one row per
 * lane/leaf writer that declared files, so a runaway subtree cannot grow the
 * control record without limit.
 */
export const MAX_DESCENDANT_RESERVATIONS = 50;

const PROGRAMME_ID_PATTERN = /^agp_[0-9a-f]{12}$/;
/** Bounded operator-action audit kept inside one record. */
const OPERATOR_ACTION_CAP = 100;

/**
 * `off` and `paused` are hard stops. `waiting` is the visible "only human
 * decisions remain" state from plan §3: continuation is not admitted from it,
 * and only an operator apply (`applyDecisionRef`) or resume returns it to
 * `running`.
 */
export type ProgrammeControlStatus = "off" | "running" | "paused" | "waiting";

/** Idempotent wake sources (plan §3 continuation admission step 1). */
export type WakeKind =
	| "handoff"
	| "delegate-completion"
	| "operator-answer"
	| "state-transition"
	| "watchdog"
	| "frontier"
	| "rotation";

/** Structured run outcomes (plan §3). */
export type ContinuationOutcome =
	| "progressed"
	| "waiting_worker"
	| "waiting_check"
	| "waiting_decision"
	| "completed"
	| "paused"
	| "failed";

/**
 * Transient conditions that hold continuation without denying it. `waiting`
 * reasons clear through their own transition (claim completion, capacity
 * release, an operator-applied decision); `programme-waiting` clears only
 * through an operator apply/resume.
 */
export type ContinuationWaitingReason = "claim-active" | "decision-pending" | "capacity" | "programme-waiting" | "rotating";
/** Hard conditions: only an operator (or kill-file removal) clears them. */
export type ContinuationDenialReason = "programme-off" | "programme-paused" | "kill-file" | "ownership-lost";

export type PendingWake = {
	sourceEventId: string;
	kind: WakeKind;
	reason: string;
	sessionRef?: string;
	enqueuedAt: string;
};

/** At most one continuation claim exists at a time (plan §7 P1.1.4). */
export type ContinuationClaim = {
	claimId: string;
	/** Addressee identity in the shared owner vocabulary: `lane:<sessionId>`. */
	owner: string;
	sessionRef: string;
	/** Run generation at admission; completion fences it by bumping the record. */
	runGeneration: number;
	admittedAt: string;
	/** Wake IDs consumed by this claim (the pending list is drained into it). */
	wakeIds: string[];
	/**
	 * Full consumed wake rows (plan §7 P4.2 claim durability). Drained pending
	 * wakes keep their reason text here, so a crash between admission and
	 * delivery can replay the same owner with the original reasons instead of
	 * losing the continuation. Empty only for records written before P4.2.
	 */
	wakes: PendingWake[];
};

/**
 * Latest heartbeat observed for one programme (plan §7 P4.2). Bounded: the
 * record keeps only the newest observation, never a history. A heartbeat is an
 * observation, never authority — it changes no status, generation, claim or
 * reservation, and it is recorded even for a paused programme so a live
 * session can never be mistaken for a missed beat.
 */
export type ProgrammeHeartbeat = {
	/** Process id recorded by the publishing session. */
	pid: number;
	sessionId: string;
	/** Programme run generation the publisher believed current when it beat. */
	generation: number;
	at: string;
	/**
	 * When the publishing session last went idle, or null while it is running a
	 * turn. Absent on beats written before R1. The external tick reads it to see
	 * a parent that has been idle with work waiting; it is an observation only.
	 */
	idleSince?: string | null;
	/** Context size of the publishing session, for the rotation triggers (R1.5). Observation only. */
	contextTokens?: number;
	contextWindow?: number;
	/** The session's latest compaction, so a failed or ineffective one can trigger rotation. */
	compaction?: CompactionObservation;
	/** Herdr pane the publishing session runs in; the rotation launch splits it. */
	paneId?: string;
	/**
	 * Why the session's wake pump last held a wake it still has pending (editor
	 * draft, open dialog, paused group, global pause...). A held wake is the
	 * operator's gate, not a stuck leader: rotation reads this to tell them apart.
	 */
	wakeHold?: { reason: string; at: string };
	/** When an operator last typed into the session (or answered through Discord). */
	lastInputAt?: string;
};

export type CompactionObservation = {
	at: string;
	outcome: "failed" | "completed";
	/** Context size after a completed compaction. */
	tokensAfter?: number;
};

/**
 * "context" is kept only so records written before T1 still validate: a healthy
 * leader's context size stopped being a rotation reason then, because compaction
 * owns normal growth. Nothing writes it any more.
 */
export type RotationReason = "context" | "compaction" | "idle";
export type RotationPhase = "checkpoint" | "launched" | "completed" | "failed" | "cancelled";

/**
 * The automatic rotation of a project's parent (R1.5, AM4): the current or last
 * one. A ticket names one rotation; `consecutiveFailures` and `lastCompleted`
 * outlive it so the spacing and alert rules can be decided from the record.
 */
export type RotationState = {
	ticket: string;
	phase: RotationPhase;
	reason: RotationReason;
	requestedAt: string;
	/** The leader being replaced. */
	fromSessionId: string;
	/** Set when the leader finished its checkpoint turn. */
	checkpointedAt?: string;
	launchedAt?: string;
	finishedAt?: string;
	/** The session that took over, once completed. */
	toSessionId?: string;
	/** What the fresh parent is told. The fresh session reads it from here and submits it itself. */
	brief?: string;
	/** Why a rotation failed or was cancelled. */
	detail?: string;
	/** Failed rotations in a row, counting this one once it has failed. */
	consecutiveFailures: number;
	lastCompleted?: { at: string; reason: RotationReason };
};

export type WriterReservation = {
	ownerRef: string;
	reservedAt: string;
};

/**
 * One writer's reserved file set inside a programme subtree (plan §7 P3).
 * `ownerRef` is the binding vocabulary `lane:<sessionId>` or `leaf:<delegateId>`
 * so a reservation addresses the same identity the admission owner uses.
 */
export type DescendantReservation = {
	ownerRef: string;
	kind: DescendantOwnerKind;
	files: string[];
	reservedAt: string;
};

/** Reference-only decision link: IDs and status, never decision content. */
export type DecisionRef = {
	decisionId: string;
	status: "open" | "applied";
	/** An open blocking decision holds continuation in the waiting state. */
	blocking: boolean;
	updatedAt: string;
	appliedBy?: string;
};

/**
 * Revocable execution ownership of one programme (operator-approved ownership
 * contract). The owner is the single session allowed to admit continuations,
 * act through the muster command and host the programme's Discord relay.
 * `epoch` increases on every ownership change so stale sessions fence
 * deterministically; `leaseExpiresAt` is advisory recovery context, never a
 * control decision.
 */
export type ProgrammeOwner = {
	sessionId: string;
	processKey: string;
	epoch: number;
	leaseExpiresAt: string;
};

export type OperatorActionKind = "start" | "pause" | "resume" | "off";

/** Operator audit trail; `operatorRef` is null only when the API did not carry one. */
export type OperatorAction = {
	action: OperatorActionKind;
	operatorRef: string | null;
	at: string;
	fromStatus: ProgrammeControlStatus;
	toStatus: ProgrammeControlStatus;
	reason?: string;
};

export type LastRunOutcome = {
	outcome: ContinuationOutcome;
	claimId: string;
	runGeneration: number;
	completedAt: string;
};

export type ProgrammeExecution = OwnerFence & { id: string; toolName: string; admittedAt: string };

/**
 * An agent identity the operator retired (R1 item 5), typically an old parent
 * session. Claims held only by retired identities stop blocking edits. The row
 * is evidence and is never deleted.
 */
export type RetiredAgent = {
	agentId: string;
	retiredAt: string;
	operatorRef: string;
	reason?: string;
};

/**
 * One guarded-run log offered as evidence, with the input identity the
 * verification tooling already captures for that run: the checkout it consumed,
 * the commit it ran against and that checkout's content fingerprint.
 */
export type OfferEvidenceEntry = {
	/** Guarded-run log the evidence came from. */
	log: string;
	/** Checkout the run consumed. */
	root: string;
	/** Commit the run ran against. */
	head_sha: string;
	/** Content fingerprint of that checkout when the run started. */
	fingerprint: string;
};

/** What a worker offers: the base it started from, its head and its evidence. */
export type OfferEvidence = {
	base_sha: string;
	head_sha: string;
	evidence: OfferEvidenceEntry[];
	/** Attached only by the existing verification owner, never accepted from tool parameters. */
	proof?: DelegateCheckEvidence[];
	/** The actual offering session/model, supplied by runtime wiring rather than arguments. */
	runtime?: RuntimeActorIdentity;
};

export type IntegrationPhase = "prepared" | "accepted" | "landed";
export type TaskIntegrationProgress = { phase: IntegrationPhase; branch: string; at: string };

/** One task's durable offer row. */
export type TaskOffer = OfferEvidence & { taskId: string; offeredBy: string; at: string; integration?: TaskIntegrationProgress };

/** An independent reviewer's verdict on one task's offered head. */
export type ReviewVerdict = {
	taskId: string;
	reviewer: string;
	verdict: "approve" | "reject";
	head_sha: string;
	at: string;
	/** Runtime evidence at review time; old unbound rows are readable but cannot approve integration. */
	runtime?: RuntimeActorIdentity;
	parentRuntime?: RuntimeActorIdentity;
};

/** The programme's merge queue. Bounded; one row per task at most. */
export type MergeQueueState = { offers: TaskOffer[]; reviews: ReviewVerdict[] };

/** Bounded retired-identity list per record. */
const MAX_RETIRED_AGENTS = 200;

export type ParentWriteBudget = {
	taskId: string;
	path: string;
	changedLines: number;
	updatedAt: string;
};

export type LaneLaunchPhase = "reserved" | "worktree-ready" | "pane-created" | "starting" | "started" | "failed";
export type LaneLaunchRecord = {
	ownerRef: string;
	taskId: string;
	attemptId: string;
	agentName: string;
	phase: LaneLaunchPhase;
	checkoutRoot?: string;
	worktreePath?: string;
	branch?: string;
	baseSha?: string;
	paneId?: string;
	paneClosed?: boolean;
	failureStep?: string;
	updatedAt: string;
};

export type ProgrammeControlRecord = {
	schemaVersion: typeof PROGRAMME_CONTROL_SCHEMA_VERSION;
	programmeId: string;
	/** Compare-and-set revision; every persisted transition increments it. */
	revision: number;
	status: ProgrammeControlStatus;
	runGeneration: number;
	pauseReason: string | null;
	enrolledSessions: string[];
	/**
	 * Current execution owner (ownership contract). Optional on read for records
	 * written before ownership existed (normalized to `null`); always written by
	 * attach/stop. `null` means no session owns the programme right now.
	 */
	owner: ProgrammeOwner | null;
	pendingWakes: PendingWake[];
	activeClaim: ContinuationClaim | null;
	/** Execution-owned tickets. Absent means a legacy owner without settlement guarantees. */
	executions?: ProgrammeExecution[];
	/** Writer slots counted against the ceiling, descendants included. */
	reservations: WriterReservation[];
	/**
	 * P3 descendant reservations: the files each lane/leaf writer of the
	 * programme subtree has claimed. Optional on read for records written before
	 * P3 (normalized to `[]`); always written by a transition.
	 */
	reservedPaths: DescendantReservation[];
	ceiling: number;
	decisionRefs: DecisionRef[];
	operatorActions: OperatorAction[];
	lastOutcome: LastRunOutcome | null;
	/**
	 * Latest watchdog heartbeat (plan §7 P4.2). Optional on read for records
	 * written before P4.2 (normalized to `null`); always written by a update.
	 */
	lastHeartbeat: ProgrammeHeartbeat | null;
	/**
	 * Operator-retired agent identities. Optional on read for records written
	 * before retirement existed (normalized to `[]`); always written by a transition.
	 */
	retiredAgents: RetiredAgent[];
	/**
	 * The merge queue (R2): what each worker offered and which independent review
	 * verdicts exist for it. Optional on read for records written before R2
	 * (normalized to an empty queue); always written by an offer or verdict.
	 */
	mergeQueue: MergeQueueState;
	/** Changed lines committed by successful parent writes, keyed by task and repository-relative file. */
	parentWriteBudgets: ParentWriteBudget[];
	/** Durable identities for lane launch attempts; released with the writer reservation. */
	laneLaunches: LaneLaunchRecord[];
	/**
	 * The current or last parent rotation. Optional on read for records written
	 * before R1.5 (normalized to `null`); always written by a transition.
	 */
	rotation: RotationState | null;
	createdAt: string;
	updatedAt: string;
};

// ─── Results ─────────────────────────────────────────────────────────────────

export type WakeEvent = {
	/** Idempotency key: a replay of the same source event never enqueues twice. */
	sourceEventId: string;
	kind: WakeKind;
	reason: string;
	sessionRef?: string;
};

export type WakeEnqueueResult = {
	outcome: "enqueued" | "coalesced";
	pendingWakeCount: number;
};

export type ClaimContinuationResult =
	| { outcome: "admitted"; claimId: string }
	| { outcome: "waiting"; reasons: ContinuationWaitingReason[] }
	| { outcome: "denied"; reason: ContinuationDenialReason };

export type WriterReservationResult =
	| { outcome: "admitted"; activeReservations: number }
	| { outcome: "denied"; reason: "ceiling"; activeReservations: number };

export type WriterReleaseResult = {
	released: boolean;
	activeReservations: number;
};

export type DescendantReservationCommit = {
	reservation: DescendantReservation;
	/** Files newly claimed by this call; empty when the reservation was already covered. */
	added: string[];
	/** True when this call created the owner's reservation row. */
	created: boolean;
	/** Writer slots held by the programme, descendant writers included. */
	activeWriters: number;
	descendantReservations: number;
};

export type DescendantReservationReleaseResult = {
	released: boolean;
	activeWriters: number;
	descendantReservations: number;
};

/**
 * Result of the P4.2 interruption probe. `recovered` is the only outcome that
 * changes the record: it clears an interrupted claim and re-queues the wakes it
 * consumed, with stable `recovery/<claimId>/<wakeId>` identities. Every other
 * outcome is a read-only fence that leaves the record untouched.
 */
export type InterruptedClaimRecovery =
	| { outcome: "none"; reason: "no-record" | "no-open-claim" }
	| {
			outcome: "fenced";
			reason: "generation-mismatch" | "programme-off" | "programme-paused" | "kill-file" | "other-owner";
			generation: number;
			/** Generation on disk when it differs from the requested one. */
			currentGeneration?: number;
			/** Owner of the claim that was left in place. */
			owner?: string;
	  }
	| { outcome: "recovered"; generation: number; claim: ContinuationClaim; replays: PendingWake[] };

export type StartProgrammeOptions = {
	/** Operator identity; start/resume are never agent-issued. */
	operatorRef: string;
	ceiling?: number;
};

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Typed control-store failure, shaped like `DecompositionStateError`:
 * - `missing`: no record exists for the programme;
 * - `malformed`: persisted JSON is unreadable or fails validation (never reset);
 * - `conflict`: compare-and-set/existing-record/stale-claim conflict;
 * - `descendant-conflict`: a descendant writer reservation overlaps another
 *   owner's reservation (`DescendantReservationConflictError`);
 * - `descendant-limit`: the bounded descendant row or writer-slot limit is
 *   reached (`DescendantReservationLimitError`);
 * - `io`: invalid input or filesystem failure.
 */
export class ProgrammeControlStateError extends Error {
	constructor(
		readonly code:
			| "missing"
			| "malformed"
			| "conflict"
			| "io"
			| "descendant-conflict"
			| "descendant-limit",
		message: string,
	) {
		super(message);
		this.name = "ProgrammeControlStateError";
	}
}

/**
 * A new reservation overlaps an existing one. The error names both owners and
 * the contested files so the caller can refuse the dispatch and record why.
 */
export class DescendantReservationConflictError extends ProgrammeControlStateError {
	constructor(
		readonly ownerRef: string,
		readonly conflictingOwnerRef: string,
		readonly files: string[],
	) {
		super(
			"descendant-conflict",
			`Descendant writer conflict for ${ownerRef}: ${conflictingOwnerRef} already reserves ${files.join(", ")}`,
		);
		this.name = "DescendantReservationConflictError";
	}
}

/** Either the bounded descendant row cap or the programme writer ceiling is full. */
export class DescendantReservationLimitError extends ProgrammeControlStateError {
	constructor(
		readonly limit: "reservations" | "writers",
		readonly limitValue: number,
		readonly descendantReservations: number,
		readonly activeWriters: number,
	) {
		super(
			"descendant-limit",
			descendantLimitMessage(limit, limitValue, descendantReservations, activeWriters),
		);
		this.name = "DescendantReservationLimitError";
	}
}

function descendantLimitMessage(
	limit: "reservations" | "writers",
	limitValue: number,
	descendantReservations: number,
	activeWriters: number,
): string {
	return limit === "reservations"
		? `Descendant reservation limit reached: ${descendantReservations} of ${limitValue} rows are in use`
		: `Writer ceiling reached: ${activeWriters} of ${limitValue} writer slots are in use`;
}

// ─── Store ───────────────────────────────────────────────────────────────────

export type ProgrammeControlStore = {
	dir: string;
	/** Fresh disk read; `undefined` when the record does not exist yet. */
	read(programmeId: string): ProgrammeControlRecord | undefined;
	/**
	 * Atomic compare-and-set. `expectedRevision === undefined` creates a new
	 * record; otherwise the stored revision must match exactly.
	 */
	update(
		programmeId: string,
		expectedRevision: number | undefined,
		mutate: (current: ProgrammeControlRecord | undefined) => ProgrammeControlRecord,
	): ProgrammeControlRecord;
};

/**
 * Control records live in a dedicated subdirectory because
 * `state/muster/programmes/<programmeId>.json` is already the Agile programme
 * record. `PI_MUSTER_CONTROL_DIR` is the test seam.
 */
export function programmeControlStateDir(): string {
	const override = process.env.PI_MUSTER_CONTROL_DIR?.trim();
	if (override) return resolve(override);
	return join(piAgentDir(), "state", "muster", "programmes", "control");
}

/**
 * Kill files that deny continuation: the documented operator path
 * (`~/.pi/agent/state/muster.disabled`, skills/muster/SKILL.md) and the path
 * the existing Muster breaker resolves (`binding.killFilePath()`).
 */
export function programmeControlKillFilePaths(): string[] {
	return [join(piAgentDir(), "state", "muster.disabled"), killFilePath()];
}

export function fileProgrammeControlStore(dir = programmeControlStateDir()): ProgrammeControlStore {
	return fileCasStore<ProgrammeControlRecord>({
		dir,
		idPattern: PROGRAMME_ID_PATTERN,
		idKind: "programme",
		noun: "programme control",
		validate: validateProgrammeControlRecord,
		errorClass: ProgrammeControlStateError,
	});
}

/**
 * The programme-control store the switch names (LC5, LC-D2): the ledger's
 * `programme-control` record when `backend.json` says so, the files store
 * otherwise. Only the store changes; every transition rule below is the same in
 * both backends.
 */
export function programmeControlStore(dir = programmeControlStateDir()): ProgrammeControlStore {
	if (readBackend(musterStateDir()) === "ledger") {
		return ledgerCasStore<ProgrammeControlRecord>(PROGRAMME_CONTROL_STORE, ownerLedgerSocket(musterStateDir()), {
			idPattern: PROGRAMME_ID_PATTERN,
			idKind: "programme",
			noun: "programme control",
			validate: validateProgrammeControlRecord,
			errorClass: ProgrammeControlStateError,
		});
	}
	return fileProgrammeControlStore(dir);
}

/** What one enumeration found: the records by programme id, and the records it skipped. */
export type ProgrammeControlScan = {
	records: Map<string, ProgrammeControlRecord>;
	skipped: { file: string; error: string }[];
};

/**
 * Every programme-control record, one owner for the bridge's scan (LC5): a store
 * that can list (the ledger's) lists its records; the files store enumerates `dir`
 * and reads each file through itself. A malformed record is skipped and returned to
 * the caller to report — never reset and never a crash.
 */
export function listProgrammeControlRecords(store: ProgrammeControlStore, dir = store.dir): ProgrammeControlScan {
	const records = new Map<string, ProgrammeControlRecord>();
	const skipped: { file: string; error: string }[] = [];
	const lister = (store as Partial<LedgerCasStore<ProgrammeControlRecord>>).list;
	if (typeof lister === "function") {
		for (const row of lister.call(store)) records.set(row.id, row.record);
		return { records, skipped };
	}
	let files: string[];
	try {
		files = existsSync(dir) ? readdirSync(dir) : [];
	} catch (error) {
		skipped.push({ file: dir, error: error instanceof Error ? error.message : String(error) });
		return { records, skipped };
	}
	for (const file of files.sort()) {
		if (!file.endsWith(".json")) continue;
		const programmeId = file.slice(0, -".json".length);
		try {
			const record = store.read(programmeId);
			if (record !== undefined) records.set(programmeId, record);
		} catch (error) {
			skipped.push({ file, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { records, skipped };
}

// ─── Validation ──────────────────────────────────────────────────────────────

const RECORD_KEYS = new Set([
	"schemaVersion",
	"programmeId",
	"revision",
	"status",
	"runGeneration",
	"pauseReason",
	"enrolledSessions",
	"owner",
	"pendingWakes",
	"activeClaim",
	"executions",
	"reservations",
	"reservedPaths",
	"ceiling",
	"decisionRefs",
	"operatorActions",
	"lastOutcome",
	"lastHeartbeat",
	"retiredAgents",
	"mergeQueue",
	"parentWriteBudgets",
	"laneLaunches",
	"rotation",
	"createdAt",
	"updatedAt",
]);
const WAKE_KEYS = new Set(["sourceEventId", "kind", "reason", "sessionRef", "enqueuedAt"]);
const CLAIM_KEYS = new Set(["claimId", "owner", "sessionRef", "runGeneration", "admittedAt", "wakeIds", "wakes"]);
const RESERVATION_KEYS = new Set(["ownerRef", "reservedAt"]);
const DESCENDANT_RESERVATION_KEYS = new Set(["ownerRef", "kind", "files", "reservedAt"]);
const DECISION_KEYS = new Set(["decisionId", "status", "blocking", "updatedAt", "appliedBy"]);
const OPERATOR_ACTION_KEYS = new Set(["action", "operatorRef", "at", "fromStatus", "toStatus", "reason"]);
const OUTCOME_KEYS = new Set(["outcome", "claimId", "runGeneration", "completedAt"]);
const HEARTBEAT_KEYS = new Set(["pid", "sessionId", "generation", "at", "idleSince", "contextTokens", "contextWindow", "compaction", "paneId", "wakeHold", "lastInputAt"]);
const ROTATION_KEYS = new Set(["ticket", "phase", "reason", "requestedAt", "fromSessionId", "checkpointedAt", "launchedAt", "finishedAt", "toSessionId", "brief", "detail", "consecutiveFailures", "lastCompleted"]);
const OFFER_KEYS = new Set(["taskId", "offeredBy", "base_sha", "head_sha", "evidence", "proof", "runtime", "integration", "at"]);
const INTEGRATION_PROGRESS_KEYS = new Set(["phase", "branch", "at"]);
const EVIDENCE_KEYS = new Set(["log", "root", "head_sha", "fingerprint"]);
const REVIEW_KEYS = new Set(["taskId", "reviewer", "verdict", "head_sha", "at", "runtime", "parentRuntime"]);
const MERGE_QUEUE_KEYS = new Set(["offers", "reviews"]);
const PARENT_WRITE_BUDGET_KEYS = new Set(["taskId", "path", "changedLines", "updatedAt"]);
const LANE_LAUNCH_KEYS = new Set(["ownerRef", "taskId", "attemptId", "agentName", "phase", "checkoutRoot", "worktreePath", "branch", "baseSha", "paneId", "paneClosed", "failureStep", "updatedAt"]);
const MAX_MERGE_OFFERS = 64;
const MAX_PARENT_WRITE_BUDGETS = 4096;
const MAX_LANE_LAUNCHES = 256;
const MAX_ROTATION_BRIEF = 8000;
const ROTATION_PHASES: readonly RotationPhase[] = ["checkpoint", "launched", "completed", "failed", "cancelled"];
const ROTATION_REASONS: readonly RotationReason[] = ["context", "compaction", "idle"];

const PROGRAMME_STATUSES: readonly ProgrammeControlStatus[] = ["off", "running", "paused", "waiting"];
const WAKE_KINDS: readonly WakeKind[] = [
	"handoff",
	"delegate-completion",
	"operator-answer",
	"state-transition",
	"watchdog",
	"frontier",
	"rotation",
];
const CONTINUATION_OUTCOMES: readonly ContinuationOutcome[] = [
	"progressed",
	"waiting_worker",
	"waiting_check",
	"waiting_decision",
	"completed",
	"paused",
	"failed",
];
const OPERATOR_ACTION_KINDS: readonly OperatorActionKind[] = ["start", "pause", "resume", "off"];

/**
 * Validate a durable control record. Unknown fields and any structural
 * deviation fail closed, so a tampered or foreign file is never treated as a
 * valid programme record.
 */
export function validateProgrammeControlRecord(
	input: unknown,
): { ok: true; record: ProgrammeControlRecord } | { ok: false; errors: string[] } {
	const errors: string[] = [];
	if (!isPlainObject(input)) return { ok: false, errors: ["record must be an object"] };
	const extra = unknownKeys(input, RECORD_KEYS);
	if (extra.length > 0) errors.push(`record has unknown fields: ${extra.join(", ")}`);
	if (input.schemaVersion !== PROGRAMME_CONTROL_SCHEMA_VERSION) errors.push("record.schemaVersion must be 1");
	if (typeof input.programmeId !== "string" || !PROGRAMME_ID_PATTERN.test(input.programmeId)) {
		errors.push("record.programmeId must match agp_<12 hex>");
	}
	if (!Number.isInteger(input.revision) || (input.revision as number) < 1) {
		errors.push("record.revision must be a positive integer");
	}
	if (!oneOf(PROGRAMME_STATUSES, input.status)) errors.push("record.status must be off, running, paused or waiting");
	if (!Number.isInteger(input.runGeneration) || (input.runGeneration as number) < 1) {
		errors.push("record.runGeneration must be a positive integer");
	}
	if (input.pauseReason !== null && !nonEmptyString(input.pauseReason)) {
		errors.push("record.pauseReason must be null or a non-empty string");
	}
	if (input.status === "paused" && !nonEmptyString(input.pauseReason)) {
		errors.push("record.status paused requires a non-empty pauseReason");
	}
	validateOwner(input.owner, errors);
	validateEnrolledSessions(input.enrolledSessions, errors);
	validatePendingWakes(input.pendingWakes, errors);
	validateActiveClaim(input.activeClaim, errors);
	if (input.executions !== undefined) {
		if (!Array.isArray(input.executions) || input.executions.length > 256) errors.push("record.executions must be a bounded array");
		else {
			const ids = new Set<string>();
			for (const row of input.executions) {
				if (!isPlainObject(row) || unknownKeys(row, new Set(["id", "toolName", "admittedAt", "sessionId", "processKey", "epoch"])).length > 0 ||
					!nonEmptyString(row.id) || !nonEmptyString(row.toolName) || !nonEmptyString(row.admittedAt) ||
					!nonEmptyString(row.sessionId) || !nonEmptyString(row.processKey) || !Number.isInteger(row.epoch) || (row.epoch as number) < 1) {
					errors.push("invalid execution ticket"); continue;
				}
				if (ids.has(row.id as string)) errors.push("duplicate execution ticket");
				ids.add(row.id as string);
			}
		}
	}
	validateReservations(input.reservations, errors);
	// Additive P3 upgrade: records written before descendant reservations existed
	// have no `reservedPaths` and normalize to an empty list instead of failing.
	if (input.reservedPaths !== undefined) validateDescendantReservations(input.reservedPaths, errors);
	if (!Number.isInteger(input.ceiling) || (input.ceiling as number) < 1 || (input.ceiling as number) > MAX_WRITER_CEILING) {
		errors.push(`record.ceiling must be an integer between 1 and ${MAX_WRITER_CEILING}`);
	}
	validateDecisionRefs(input.decisionRefs, errors);
	validateOperatorActions(input.operatorActions, errors);
	validateLastOutcome(input.lastOutcome, errors);
	// Additive P4.2 upgrade: records written before heartbeats existed have no
	// `lastHeartbeat` and normalize to null instead of failing.
	if (input.lastHeartbeat !== undefined) validateHeartbeat(input.lastHeartbeat, errors);
	// Additive R1 upgrade: records written before retirement existed have no
	// `retiredAgents` and normalize to an empty list instead of failing.
	if (input.retiredAgents !== undefined) validateRetiredAgents(input.retiredAgents, errors);
	// Additive R1.5 upgrade: records written before rotation existed have no
	// `rotation` and normalize to null instead of failing.
	if (input.rotation !== undefined) validateRotation(input.rotation, errors);
	// Additive R2 upgrade: records written before the merge queue existed have no
	// `mergeQueue` and normalize to an empty queue instead of failing.
	if (input.mergeQueue !== undefined) validateMergeQueue(input.mergeQueue, errors);
	if (input.parentWriteBudgets !== undefined) validateParentWriteBudgets(input.parentWriteBudgets, errors);
	if (input.laneLaunches !== undefined) validateLaneLaunches(input.laneLaunches, errors);
	if (!nonEmptyString(input.createdAt)) errors.push("record.createdAt must be a non-empty string");
	if (!nonEmptyString(input.updatedAt)) errors.push("record.updatedAt must be a non-empty string");
	if (errors.length > 0) return { ok: false, errors };
	const record = cloneJson(input) as unknown as ProgrammeControlRecord;
	if (!Array.isArray(record.reservedPaths)) record.reservedPaths = [];
	if (record.lastHeartbeat === undefined) record.lastHeartbeat = null;
	if (!Array.isArray(record.retiredAgents)) record.retiredAgents = [];
	if (record.rotation === undefined) record.rotation = null;
	if (record.mergeQueue === undefined) record.mergeQueue = { offers: [], reviews: [] };
	if (!Array.isArray(record.parentWriteBudgets)) record.parentWriteBudgets = [];
	if (!Array.isArray(record.laneLaunches)) record.laneLaunches = [];
	// Additive ownership upgrade: records written before ownership existed have
	// no `owner` and normalize to null instead of failing.
	if (record.owner === undefined) record.owner = null;
	// Additive P4.2 upgrade: claims written before generation fencing carry only
	// wake IDs and the session ref; normalize the owner and the full wake rows
	// from the identity that is present so every consumer sees one shape.
	if (record.activeClaim !== null && record.activeClaim !== undefined) {
		if (!nonEmptyString(record.activeClaim.owner)) {
			record.activeClaim.owner = laneOwnerRef(record.activeClaim.sessionRef);
		}
		if (!Array.isArray(record.activeClaim.wakes)) record.activeClaim.wakes = [];
	}
	return { ok: true, record };
}

function validateRetiredAgents(value: unknown, errors: string[]): void {
	if (!Array.isArray(value) || value.length > MAX_RETIRED_AGENTS) {
		errors.push(`record.retiredAgents must be an array of at most ${MAX_RETIRED_AGENTS} rows`);
		return;
	}
	const known = new Set(["agentId", "retiredAt", "operatorRef", "reason"]);
	const seen = new Set<string>();
	value.forEach((row, index) => {
		const path = `record.retiredAgents[${index}]`;
		if (!isPlainObject(row)) {
			errors.push(`${path} must be an object`);
			return;
		}
		const extra = unknownKeys(row, known);
		if (extra.length > 0) errors.push(`${path} has unknown fields: ${extra.join(", ")}`);
		if (!nonEmptyString(row.agentId)) errors.push(`${path}.agentId must be a non-empty string`);
		else if (seen.has(row.agentId)) errors.push(`${path}.agentId is duplicated: ${row.agentId}`);
		else seen.add(row.agentId);
		if (!nonEmptyString(row.retiredAt)) errors.push(`${path}.retiredAt must be a non-empty string`);
		if (!nonEmptyString(row.operatorRef)) errors.push(`${path}.operatorRef must be a non-empty string`);
		if (row.reason !== undefined && !nonEmptyString(row.reason)) errors.push(`${path}.reason must be a non-empty string when present`);
	});
}

function validParentWritePath(path: string): boolean {
	return nonEmptyString(path) && path.length <= 2000 && !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..");
}

function validateParentWriteBudgets(value: unknown, errors: string[]): void {
	if (!Array.isArray(value) || value.length > MAX_PARENT_WRITE_BUDGETS) {
		errors.push(`record.parentWriteBudgets must be an array of at most ${MAX_PARENT_WRITE_BUDGETS} rows`);
		return;
	}
	const seen = new Set<string>();
	for (const [index, row] of value.entries()) {
		if (!isPlainObject(row) || unknownKeys(row, PARENT_WRITE_BUDGET_KEYS).length > 0 ||
			!nonEmptyString(row.taskId) || row.taskId.length > 500 ||
			!nonEmptyString(row.path) || row.path.length > 2000 || row.path.startsWith("/") || row.path.includes("\\") || row.path.split("/").includes("..") ||
			!Number.isInteger(row.changedLines) || (row.changedLines as number) < 1 || !nonEmptyString(row.updatedAt)) {
			errors.push(`record.parentWriteBudgets[${index}] is invalid`);
			continue;
		}
		const key = `${row.taskId}\u0000${row.path}`;
		if (seen.has(key)) errors.push(`record.parentWriteBudgets has duplicate entry for ${row.taskId}:${row.path}`);
		seen.add(key);
	}
}

function validateLaneLaunches(value: unknown, errors: string[]): void {
	const phases: readonly LaneLaunchPhase[] = ["reserved", "worktree-ready", "pane-created", "starting", "started", "failed"];
	if (!Array.isArray(value) || value.length > MAX_LANE_LAUNCHES) {
		errors.push(`record.laneLaunches must be an array of at most ${MAX_LANE_LAUNCHES} rows`);
		return;
	}
	const owners = new Set<string>();
	for (const [index, row] of value.entries()) {
		if (!isPlainObject(row) || unknownKeys(row, LANE_LAUNCH_KEYS).length > 0 ||
			parseDescendantOwnerRef(String(row.ownerRef ?? ""))?.kind !== "lane" ||
			!nonEmptyString(row.taskId) || row.taskId.length > 500 || !nonEmptyString(row.attemptId) || row.attemptId.length > 128 ||
			!nonEmptyString(row.agentName) || row.agentName.length > 120 || !oneOf(phases, row.phase) || !nonEmptyString(row.updatedAt)) {
			errors.push(`record.laneLaunches[${index}] has an invalid identity or phase`);
			continue;
		}
		if (owners.has(row.ownerRef as string)) errors.push(`record.laneLaunches has duplicate owner ${String(row.ownerRef)}`);
		owners.add(row.ownerRef as string);
		for (const key of ["checkoutRoot", "worktreePath"] as const) {
			if (row[key] !== undefined && (typeof row[key] !== "string" || !isAbsolute(row[key]) || row[key].length > 4000)) errors.push(`record.laneLaunches[${index}].${key} must be an absolute path`);
		}
		if (row.branch !== undefined && (typeof row.branch !== "string" || row.branch.length > 500 || !/^muster\/[A-Za-z0-9_/-]+$/.test(row.branch))) errors.push(`record.laneLaunches[${index}].branch is invalid`);
		if (row.baseSha !== undefined && (typeof row.baseSha !== "string" || !/^[0-9a-f]{40,64}$/.test(row.baseSha))) errors.push(`record.laneLaunches[${index}].baseSha is invalid`);
		if (row.paneId !== undefined && (typeof row.paneId !== "string" || row.paneId.length > 500)) errors.push(`record.laneLaunches[${index}].paneId is invalid`);
		if (row.paneClosed !== undefined && typeof row.paneClosed !== "boolean") errors.push(`record.laneLaunches[${index}].paneClosed must be boolean`);
		if (row.paneClosed === true && !nonEmptyString(row.paneId)) errors.push(`record.laneLaunches[${index}].paneClosed requires its pane identity`);
		if (row.failureStep !== undefined && (typeof row.failureStep !== "string" || row.failureStep.length > 200)) errors.push(`record.laneLaunches[${index}].failureStep is invalid`);
		if (row.phase === "started" && (!nonEmptyString(row.worktreePath) || !nonEmptyString(row.branch) || !nonEmptyString(row.baseSha))) errors.push(`record.laneLaunches[${index}] started state lacks its checkout identity`);
		if (row.phase === "failed" && !nonEmptyString(row.failureStep)) errors.push(`record.laneLaunches[${index}] failed state lacks its failure step`);
	}
}

function validateMergeQueue(value: unknown, errors: string[]): void {
	if (!isPlainObject(value)) {
		errors.push("record.mergeQueue must be an object");
		return;
	}
	const extra = unknownKeys(value, MERGE_QUEUE_KEYS);
	if (extra.length > 0) errors.push(`record.mergeQueue has unknown fields: ${extra.join(", ")}`);
	const offers = value.offers;
	if (offers !== undefined) {
		if (!Array.isArray(offers) || offers.length > MAX_MERGE_OFFERS) {
			errors.push(`record.mergeQueue.offers must be an array of at most ${MAX_MERGE_OFFERS} rows`);
		} else {
			const seen = new Set<string>();
			offers.forEach((row, index) => {
				const path = `record.mergeQueue.offers[${index}]`;
				if (!isPlainObject(row)) {
					errors.push(`${path} must be an object`);
					return;
				}
				const unknown = unknownKeys(row, OFFER_KEYS);
				if (unknown.length > 0) errors.push(`${path} has unknown fields: ${unknown.join(", ")}`);
				if (!nonEmptyString(row.taskId)) errors.push(`${path}.taskId must be a non-empty string`);
				else if (seen.has(row.taskId)) errors.push(`${path}.taskId is duplicated: ${row.taskId}`);
				else seen.add(row.taskId);
				if (!nonEmptyString(row.offeredBy)) errors.push(`${path}.offeredBy must be a non-empty string`);
				if (!nonEmptyString(row.base_sha)) errors.push(`${path}.base_sha must be a non-empty string`);
				if (!nonEmptyString(row.head_sha)) errors.push(`${path}.head_sha must be a non-empty string`);
				if (!nonEmptyString(row.at)) errors.push(`${path}.at must be a non-empty string`);
				if (row.runtime !== undefined && !isRuntimeActorIdentity(row.runtime)) errors.push(`${path}.runtime must carry session/provider/model/harness identity`);
				if (row.integration !== undefined) {
					const progress = row.integration;
					if (!isPlainObject(progress)) errors.push(`${path}.integration must be an object`);
					else {
						const unknownProgress = unknownKeys(progress, INTEGRATION_PROGRESS_KEYS);
					if (unknownProgress.length > 0) errors.push(`${path}.integration has unknown fields: ${unknownProgress.join(", ")}`);
						if (!oneOf(["prepared", "accepted", "landed"] as const, progress.phase)) errors.push(`${path}.integration.phase is invalid`);
						for (const field of ["branch", "at"] as const) if (!nonEmptyString(progress[field])) errors.push(`${path}.integration.${field} must be a non-empty string`);
					}
				}
				if (row.proof !== undefined && (!Array.isArray(row.proof) || !Array.isArray(row.evidence) || row.proof.length !== row.evidence.length || row.proof.some((entry) => !isDelegateCheckEvidence(entry)))) errors.push(`${path}.proof must contain one valid owner binding per evidence reference`);
				if (!Array.isArray(row.evidence) || row.evidence.length === 0) {
					errors.push(`${path}.evidence must be a non-empty array`);
				} else {
					row.evidence.forEach((entry, entryIndex) => {
						const entryPath = `${path}.evidence[${entryIndex}]`;
						if (!isPlainObject(entry)) {
							errors.push(`${entryPath} must be an object`);
							return;
						}
						const unknownEntry = unknownKeys(entry, EVIDENCE_KEYS);
						if (unknownEntry.length > 0) errors.push(`${entryPath} has unknown fields: ${unknownEntry.join(", ")}`);
						for (const field of ["log", "root", "head_sha", "fingerprint"] as const) {
							if (!nonEmptyString(entry[field])) errors.push(`${entryPath}.${field} must be a non-empty string`);
						}
					});
				}
			});
		}
	}
	const reviews = value.reviews;
	if (reviews !== undefined) {
		if (!Array.isArray(reviews) || reviews.length > MAX_MERGE_OFFERS) {
			errors.push(`record.mergeQueue.reviews must be an array of at most ${MAX_MERGE_OFFERS} rows`);
		} else {
			reviews.forEach((row, index) => {
				const path = `record.mergeQueue.reviews[${index}]`;
				if (!isPlainObject(row)) {
					errors.push(`${path} must be an object`);
					return;
				}
				const unknown = unknownKeys(row, REVIEW_KEYS);
				if (unknown.length > 0) errors.push(`${path} has unknown fields: ${unknown.join(", ")}`);
				for (const field of ["taskId", "reviewer", "head_sha", "at"] as const) {
					if (!nonEmptyString(row[field])) errors.push(`${path}.${field} must be a non-empty string`);
				}
				if (!oneOf(["approve", "reject"] as const, row.verdict)) errors.push(`${path}.verdict must be approve or reject`);
				for (const field of ["runtime", "parentRuntime"] as const) if (row[field] !== undefined && !isRuntimeActorIdentity(row[field])) errors.push(`${path}.${field} must carry session/provider/model/harness identity`);
			});
		}
	}
}

function validateOwner(value: unknown, errors: string[]): void {
	// Additive ownership upgrade: records written before ownership existed have
	// no `owner` and normalize to null instead of failing.
	if (value === undefined || value === null) return;
	if (typeof value !== "object") {
		errors.push("record.owner must be an object or null");
		return;
	}
	const owner = value as Record<string, unknown>;
	if (!nonEmptyString(owner.sessionId)) errors.push("record.owner.sessionId must be a non-empty string");
	if (!nonEmptyString(owner.processKey)) errors.push("record.owner.processKey must be a non-empty string");
	if (!Number.isInteger(owner.epoch) || (owner.epoch as number) < 1) {
		errors.push("record.owner.epoch must be a positive integer");
	}
	if (!nonEmptyString(owner.leaseExpiresAt)) errors.push("record.owner.leaseExpiresAt must be a non-empty string");
}

function validateEnrolledSessions(value: unknown, errors: string[]): void {
	if (!Array.isArray(value)) {
		errors.push("record.enrolledSessions must be an array");
		return;
	}
	const seen = new Set<string>();
	for (const entry of value) {
		if (!nonEmptyString(entry)) {
			errors.push("record.enrolledSessions entries must be non-empty strings");
			return;
		}
		if (seen.has(entry)) {
			errors.push(`record.enrolledSessions has a duplicate entry: ${entry}`);
			return;
		}
		seen.add(entry);
	}
}

function validatePendingWakes(value: unknown, errors: string[], path = "record.pendingWakes"): void {
	if (!Array.isArray(value)) {
		errors.push(`${path} must be an array`);
		return;
	}
	const seen = new Set<string>();
	value.forEach((wake, index) => {
		const rowPath = `${path}[${index}]`;
		if (!isPlainObject(wake)) {
			errors.push(`${rowPath} must be an object`);
			return;
		}
		const extra = unknownKeys(wake, WAKE_KEYS);
		if (extra.length > 0) errors.push(`${rowPath} has unknown fields: ${extra.join(", ")}`);
		if (!nonEmptyString(wake.sourceEventId)) errors.push(`${rowPath}.sourceEventId must be a non-empty string`);
		else if (seen.has(wake.sourceEventId)) errors.push(`${rowPath}.sourceEventId is duplicated: ${wake.sourceEventId}`);
		else seen.add(wake.sourceEventId);
		if (!oneOf(WAKE_KINDS, wake.kind)) errors.push(`${rowPath}.kind is invalid`);
		if (!nonEmptyString(wake.reason)) errors.push(`${rowPath}.reason must be a non-empty string`);
		if (wake.sessionRef !== undefined && !nonEmptyString(wake.sessionRef)) {
			errors.push(`${rowPath}.sessionRef must be a non-empty string when present`);
		}
		if (!nonEmptyString(wake.enqueuedAt)) errors.push(`${rowPath}.enqueuedAt must be a non-empty string`);
	});
}

function validateActiveClaim(value: unknown, errors: string[]): void {
	if (value === null) return;
	const path = "record.activeClaim";
	if (!isPlainObject(value)) {
		errors.push(`${path} must be null or an object`);
		return;
	}
	const extra = unknownKeys(value, CLAIM_KEYS);
	if (extra.length > 0) errors.push(`${path} has unknown fields: ${extra.join(", ")}`);
	if (!nonEmptyString(value.claimId)) errors.push(`${path}.claimId must be a non-empty string`);
	// Additive P4.2 field: absent on records written before generation fencing.
	if (value.owner !== undefined && parseDescendantOwnerRef(String(value.owner)) === undefined) {
		errors.push(`${path}.owner must be lane:<id> or leaf:<id> when present`);
	}
	if (!nonEmptyString(value.sessionRef)) errors.push(`${path}.sessionRef must be a non-empty string`);
	if (!Number.isInteger(value.runGeneration) || (value.runGeneration as number) < 1) {
		errors.push(`${path}.runGeneration must be a positive integer`);
	}
	if (!nonEmptyString(value.admittedAt)) errors.push(`${path}.admittedAt must be a non-empty string`);
	if (!Array.isArray(value.wakeIds) || !value.wakeIds.every(nonEmptyString)) {
		errors.push(`${path}.wakeIds must be an array of non-empty strings`);
	}
	// Additive P4.2 field: the full consumed wake rows, absent on older claims.
	if (value.wakes !== undefined) {
		if (!Array.isArray(value.wakes)) {
			errors.push(`${path}.wakes must be an array when present`);
		} else {
			validatePendingWakes(value.wakes, errors, `${path}.wakes`);
		}
	}
}

function validateHeartbeat(value: unknown, errors: string[]): void {
	if (value === null) return;
	const path = "record.lastHeartbeat";
	if (!isPlainObject(value)) {
		errors.push(`${path} must be null or an object`);
		return;
	}
	const extra = unknownKeys(value, HEARTBEAT_KEYS);
	if (extra.length > 0) errors.push(`${path} has unknown fields: ${extra.join(", ")}`);
	if (!Number.isInteger(value.pid) || (value.pid as number) <= 0) {
		errors.push(`${path}.pid must be a positive integer`);
	}
	if (!nonEmptyString(value.sessionId)) errors.push(`${path}.sessionId must be a non-empty string`);
	if (!Number.isInteger(value.generation) || (value.generation as number) < 1) {
		errors.push(`${path}.generation must be a positive integer`);
	}
	if (!nonEmptyString(value.at)) errors.push(`${path}.at must be a non-empty string`);
	if (value.idleSince !== undefined && value.idleSince !== null && !nonEmptyString(value.idleSince)) {
		errors.push(`${path}.idleSince must be null or a non-empty string when present`);
	}
	if (value.contextTokens !== undefined && (!Number.isInteger(value.contextTokens) || (value.contextTokens as number) < 0)) {
		errors.push(`${path}.contextTokens must be a non-negative integer when present`);
	}
	if (value.contextWindow !== undefined && (!Number.isInteger(value.contextWindow) || (value.contextWindow as number) < 1)) {
		errors.push(`${path}.contextWindow must be a positive integer when present`);
	}
	if (value.paneId !== undefined && !nonEmptyString(value.paneId)) errors.push(`${path}.paneId must be a non-empty string when present`);
	if (value.lastInputAt !== undefined && !nonEmptyString(value.lastInputAt)) errors.push(`${path}.lastInputAt must be a non-empty string when present`);
	if (value.wakeHold !== undefined) {
		const w = value.wakeHold;
		if (!isPlainObject(w) || unknownKeys(w, new Set(["reason", "at"])).length > 0 || !nonEmptyString(w.reason) || !nonEmptyString(w.at)) {
			errors.push(`${path}.wakeHold must be {reason, at}`);
		}
	}
	if (value.compaction !== undefined) {
		const c = value.compaction;
		if (!isPlainObject(c) || unknownKeys(c, new Set(["at", "outcome", "tokensAfter"])).length > 0 || !nonEmptyString(c.at) ||
			(c.outcome !== "failed" && c.outcome !== "completed") ||
			(c.tokensAfter !== undefined && (!Number.isInteger(c.tokensAfter) || (c.tokensAfter as number) < 0))) {
			errors.push(`${path}.compaction must be {at, outcome: failed|completed, tokensAfter?}`);
		}
	}
}

function validateRotation(value: unknown, errors: string[]): void {
	if (value === null) return;
	const path = "record.rotation";
	if (!isPlainObject(value)) {
		errors.push(`${path} must be null or an object`);
		return;
	}
	const extra = unknownKeys(value, ROTATION_KEYS);
	if (extra.length > 0) errors.push(`${path} has unknown fields: ${extra.join(", ")}`);
	if (!nonEmptyString(value.ticket)) errors.push(`${path}.ticket must be a non-empty string`);
	if (!oneOf(ROTATION_PHASES, value.phase)) errors.push(`${path}.phase must be one of ${ROTATION_PHASES.join(", ")}`);
	if (!oneOf(ROTATION_REASONS, value.reason)) errors.push(`${path}.reason must be one of ${ROTATION_REASONS.join(", ")}`);
	if (!nonEmptyString(value.requestedAt)) errors.push(`${path}.requestedAt must be a non-empty string`);
	if (!nonEmptyString(value.fromSessionId)) errors.push(`${path}.fromSessionId must be a non-empty string`);
	for (const key of ["checkpointedAt", "launchedAt", "finishedAt", "toSessionId", "detail"] as const) {
		if (value[key] !== undefined && !nonEmptyString(value[key])) errors.push(`${path}.${key} must be a non-empty string when present`);
	}
	if (value.brief !== undefined && (!nonEmptyString(value.brief) || (value.brief as string).length > MAX_ROTATION_BRIEF)) {
		errors.push(`${path}.brief must be a non-empty string of at most ${MAX_ROTATION_BRIEF} characters when present`);
	}
	if (!Number.isInteger(value.consecutiveFailures) || (value.consecutiveFailures as number) < 0) {
		errors.push(`${path}.consecutiveFailures must be a non-negative integer`);
	}
	if (value.lastCompleted !== undefined) {
		const l = value.lastCompleted;
		if (!isPlainObject(l) || unknownKeys(l, new Set(["at", "reason"])).length > 0 || !nonEmptyString(l.at) || !oneOf(ROTATION_REASONS, l.reason)) {
			errors.push(`${path}.lastCompleted must be {at, reason}`);
		}
	}
}

function validateReservations(value: unknown, errors: string[]): void {
	if (!Array.isArray(value)) {
		errors.push("record.reservations must be an array");
		return;
	}
	const seen = new Set<string>();
	value.forEach((reservation, index) => {
		const path = `record.reservations[${index}]`;
		if (!isPlainObject(reservation)) {
			errors.push(`${path} must be an object`);
			return;
		}
		const extra = unknownKeys(reservation, RESERVATION_KEYS);
		if (extra.length > 0) errors.push(`${path} has unknown fields: ${extra.join(", ")}`);
		if (!nonEmptyString(reservation.ownerRef)) errors.push(`${path}.ownerRef must be a non-empty string`);
		else if (seen.has(reservation.ownerRef)) errors.push(`${path}.ownerRef is duplicated: ${reservation.ownerRef}`);
		else seen.add(reservation.ownerRef);
		if (!nonEmptyString(reservation.reservedAt)) errors.push(`${path}.reservedAt must be a non-empty string`);
	});
}

function validateDescendantReservations(value: unknown, errors: string[]): void {
	if (!Array.isArray(value)) {
		errors.push("record.reservedPaths must be an array");
		return;
	}
	const seenOwners = new Set<string>();
	value.forEach((reservation, index) => {
		const path = `record.reservedPaths[${index}]`;
		if (!isPlainObject(reservation)) {
			errors.push(`${path} must be an object`);
			return;
		}
		const extra = unknownKeys(reservation, DESCENDANT_RESERVATION_KEYS);
		if (extra.length > 0) errors.push(`${path} has unknown fields: ${extra.join(", ")}`);
		if (!nonEmptyString(reservation.ownerRef)) {
			errors.push(`${path}.ownerRef must be a non-empty string`);
		} else if (seenOwners.has(reservation.ownerRef)) {
			errors.push(`${path}.ownerRef is duplicated: ${reservation.ownerRef}`);
		} else {
			seenOwners.add(reservation.ownerRef);
		}
		const parsed = nonEmptyString(reservation.ownerRef) ? parseDescendantOwnerRef(reservation.ownerRef) : undefined;
		if (nonEmptyString(reservation.ownerRef) && parsed === undefined) {
			errors.push(`${path}.ownerRef must be lane:<id> or leaf:<id>`);
		}
		if (reservation.kind !== "lane" && reservation.kind !== "leaf") {
			errors.push(`${path}.kind must be lane or leaf`);
		} else if (parsed !== undefined && parsed.kind !== reservation.kind) {
			errors.push(`${path}.kind does not match ownerRef ${String(reservation.ownerRef)}`);
		}
		if (!Array.isArray(reservation.files) || reservation.files.length === 0) {
			errors.push(`${path}.files must be a non-empty array`);
		} else {
			const seen = new Set<string>();
			for (const file of reservation.files) {
				const normalized = normalizeDescendantPath(file);
				if (normalized === undefined || normalized !== file) {
					errors.push(`${path}.files entries must be canonical non-empty relative POSIX paths`);
					break;
				}
				if (seen.has(file)) {
					errors.push(`${path}.files has a duplicate entry: ${file}`);
					break;
				}
				seen.add(file);
			}
		}
		if (!nonEmptyString(reservation.reservedAt)) errors.push(`${path}.reservedAt must be a non-empty string`);
	});
}

function validateDecisionRefs(value: unknown, errors: string[]): void {
	if (!Array.isArray(value)) {
		errors.push("record.decisionRefs must be an array");
		return;
	}
	const seen = new Set<string>();
	value.forEach((ref, index) => {
		const path = `record.decisionRefs[${index}]`;
		if (!isPlainObject(ref)) {
			errors.push(`${path} must be an object`);
			return;
		}
		const extra = unknownKeys(ref, DECISION_KEYS);
		if (extra.length > 0) errors.push(`${path} has unknown fields: ${extra.join(", ")}`);
		if (!nonEmptyString(ref.decisionId)) errors.push(`${path}.decisionId must be a non-empty string`);
		else if (seen.has(ref.decisionId)) errors.push(`${path}.decisionId is duplicated: ${ref.decisionId}`);
		else seen.add(ref.decisionId);
		if (ref.status !== "open" && ref.status !== "applied") errors.push(`${path}.status must be open or applied`);
		if (typeof ref.blocking !== "boolean") errors.push(`${path}.blocking must be a boolean`);
		if (!nonEmptyString(ref.updatedAt)) errors.push(`${path}.updatedAt must be a non-empty string`);
		if (ref.appliedBy !== undefined && !nonEmptyString(ref.appliedBy)) {
			errors.push(`${path}.appliedBy must be a non-empty string when present`);
		}
	});
}

function validateOperatorActions(value: unknown, errors: string[]): void {
	if (!Array.isArray(value)) {
		errors.push("record.operatorActions must be an array");
		return;
	}
	value.forEach((action, index) => {
		const path = `record.operatorActions[${index}]`;
		if (!isPlainObject(action)) {
			errors.push(`${path} must be an object`);
			return;
		}
		const extra = unknownKeys(action, OPERATOR_ACTION_KEYS);
		if (extra.length > 0) errors.push(`${path} has unknown fields: ${extra.join(", ")}`);
		if (!oneOf(OPERATOR_ACTION_KINDS, action.action)) errors.push(`${path}.action must be start, pause, resume or off`);
		if (action.operatorRef !== null && !nonEmptyString(action.operatorRef)) {
			errors.push(`${path}.operatorRef must be null or a non-empty string`);
		}
		if (!nonEmptyString(action.at)) errors.push(`${path}.at must be a non-empty string`);
		if (!oneOf(PROGRAMME_STATUSES, action.fromStatus)) errors.push(`${path}.fromStatus is invalid`);
		if (!oneOf(PROGRAMME_STATUSES, action.toStatus)) errors.push(`${path}.toStatus is invalid`);
		if (action.reason !== undefined && !nonEmptyString(action.reason)) {
			errors.push(`${path}.reason must be a non-empty string when present`);
		}
	});
}

function validateLastOutcome(value: unknown, errors: string[]): void {
	if (value === null) return;
	const path = "record.lastOutcome";
	if (!isPlainObject(value)) {
		errors.push(`${path} must be null or an object`);
		return;
	}
	const extra = unknownKeys(value, OUTCOME_KEYS);
	if (extra.length > 0) errors.push(`${path} has unknown fields: ${extra.join(", ")}`);
	if (!oneOf(CONTINUATION_OUTCOMES, value.outcome)) errors.push(`${path}.outcome is invalid`);
	if (!nonEmptyString(value.claimId)) errors.push(`${path}.claimId must be a non-empty string`);
	if (!Number.isInteger(value.runGeneration) || (value.runGeneration as number) < 1) {
		errors.push(`${path}.runGeneration must be a positive integer`);
	}
	if (!nonEmptyString(value.completedAt)) errors.push(`${path}.completedAt must be a non-empty string`);
}

// ─── Operations ──────────────────────────────────────────────────────────────

/**
 * Start a programme or restart one whose status is `off`. Idempotent while the
 * programme is running/waiting. Requires an operator reference; a paused
 * programme must be resumed rather than started again.
 */
export function startProgramme(
	programmeId: string,
	options: StartProgrammeOptions,
	context?: ProgrammeControlContext,
): ProgrammeControlRecord {
	assertProgrammeId(programmeId);
	const operator = operatorRefFrom(options?.operatorRef, "startProgramme");
	const ceiling = options?.ceiling ?? DEFAULT_WRITER_CEILING;
	if (!Number.isInteger(ceiling) || ceiling < 1 || ceiling > MAX_WRITER_CEILING) {
		throw invalidInput(`startProgramme ceiling must be an integer between 1 and ${MAX_WRITER_CEILING}`);
	}
	const store = resolveProgrammeControlStore(context);
	const now = new Date().toISOString();
	let lastConflict: string | undefined;
	for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
		const current = store.read(programmeId);
		if (current === undefined) {
			try {
				return store.update(programmeId, undefined, () => newProgrammeControlRecord(programmeId, operator, ceiling, now));
			} catch (error) {
				if (error instanceof ProgrammeControlStateError && error.code === "conflict") {
					lastConflict = error.message;
					continue;
				}
				throw error;
			}
		}
		if (current.status === "running" || current.status === "waiting") return current;
		if (current.status === "paused") {
			throw new ProgrammeControlStateError(
				"conflict",
				`Programme ${programmeId} is paused; resumeProgramme requires an operator reference`,
			);
		}
		const next = restartRecord(current, operator, now);
		try {
			return store.update(programmeId, current.revision, () => next);
		} catch (error) {
			if (error instanceof ProgrammeControlStateError && error.code === "conflict") {
				lastConflict = error.message;
				continue;
			}
			throw error;
		}
	}
	throw new ProgrammeControlStateError(
		"conflict",
		`Programme control start contended for ${programmeId}: ${lastConflict ?? "revision conflict"}`,
	);
}

// Execution tickets share the same CAS store as ownership: admission and transfer
// cannot race past each other. Only the captured core finalizer may release a ticket.
export function beginProgrammeExecution(programmeId: string, ticket: ProgrammeExecution, context?: ProgrammeControlContext): void {
	casProgrammeControl(programmeId, context, (current) => {
		if (!ownerFenceSatisfied(current.owner, ticket)) throw invalidInput("stale programme execution owner");
		if (current.executions === undefined) throw invalidInput("owner has no settlement protocol");
		if (current.status !== "running" || killFilePresent(context) || current.decisionRefs.some((ref) => ref.status === "open" && ref.blocking)) {
			throw invalidInput("programme paused, stopped, waiting, or decision-blocked");
		}
		if (current.executions.length >= 256 || current.executions.some((row) => row.id === ticket.id)) throw invalidInput("execution ticket capacity or identity conflict");
		return { next: { ...current, executions: [...current.executions, ticket], revision: current.revision + 1, updatedAt: new Date().toISOString() }, value: undefined };
	});
}

export function settleProgrammeExecution(programmeId: string, ticket: ProgrammeExecution, context?: ProgrammeControlContext): boolean {
	return casProgrammeControl(programmeId, context, (current) => {
		const found = current.executions?.find((row) => row.id === ticket.id);
		if (found === undefined) return { value: false };
		if (!ownerFenceSatisfied(found, ticket)) throw invalidInput("execution settlement identity mismatch");
		return { next: { ...current, executions: current.executions!.filter((row) => row.id !== ticket.id), revision: current.revision + 1, updatedAt: new Date().toISOString() }, value: true };
	}).value;
}

// ─── Ownership attach/stop (operator-approved ownership contract) ───────────

/** Advisory owner-lease lifetime; renewal is evidence of liveness, never a control decision. */
export const PROGRAMME_OWNER_LEASE_MS = 15 * 60 * 1000;

export type AttachProgrammeOptions = {
	/** Owning session identity: the session that ran `/muster on`. */
	sessionId: string;
	/** Process-unique key (pid + boot identity); fences two processes of one saved session. */
	processKey: string;
	/** Operator identity; attach is never agent-issued. */
	operatorRef: string;
	/** Only compatible final-admission/settlement runtimes may set this. */
	guarded?: boolean;
	/** Leadership attachment does not resume a paused programme. */
	preserveState?: boolean;
};

export type AttachProgrammeResult = {
	programmeId: string;
	status: ProgrammeControlStatus;
	owner: ProgrammeOwner;
	/** Owner recorded before this attach, when one existed. */
	previousOwner: ProgrammeOwner | null;
	/** True when a different session or physical process previously owned the programme. */
	takeover: boolean;
	created: boolean;
};

export type StopProgrammeOptions = {
	/** Durable reason recorded in the operator audit trail. */
	reason: string;
	/** Optional operator identity for the audit trail. */
	operatorRef?: string;
};

function leaseExpiry(now: string): string {
	return new Date(Date.parse(now) + PROGRAMME_OWNER_LEASE_MS).toISOString();
}

/**
 * Operator attach (`on`): give one session exclusive, renewable execution
 * ownership of the programme and connect its Discord binding to it. Attaching
 * from another session is a takeover: the epoch increases, so every stale
 * session's next read sees that it lost authority, and its in-flight work
 * settles or is recovered by the new owner instead of being silently killed.
 * A completed programme stays terminal; `off` and `paused` become `running`
 * because attach is the explicit operator reactivation.
 */
export function attachProgramme(
	programmeId: string,
	options: AttachProgrammeOptions,
	context?: ProgrammeControlContext,
): AttachProgrammeResult {
	assertProgrammeId(programmeId);
	const sessionId = nonEmptyString(options?.sessionId) ? options.sessionId.trim() : "";
	const processKey = nonEmptyString(options?.processKey) ? options.processKey.trim() : "";
	const operator = operatorRefFrom(options?.operatorRef, "attachProgramme");
	if (!nonEmptyString(sessionId)) throw invalidInput("attachProgramme requires a non-empty sessionId");
	if (!nonEmptyString(processKey)) throw invalidInput("attachProgramme requires a non-empty processKey");
	const store = resolveProgrammeControlStore(context);
	const now = new Date().toISOString();
	let lastConflict: string | undefined;
	for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
		const current = store.read(programmeId);
		if (current === undefined) {
			try {
				const created = store.update(programmeId, undefined, () => ({
					...newProgrammeControlRecord(programmeId, operator, DEFAULT_WRITER_CEILING, now),
					owner: { sessionId, processKey, epoch: 1, leaseExpiresAt: leaseExpiry(now) },
					enrolledSessions: [sessionId],
					...(options.guarded ? { executions: [] } : {}),
				}));
				return {
					programmeId,
					status: created.status,
					owner: cloneJson(created.owner) as ProgrammeOwner,
					previousOwner: null,
					takeover: false,
					created: true,
				};
			} catch (error) {
				if (error instanceof ProgrammeControlStateError && error.code === "conflict") {
					lastConflict = error.message;
					continue;
				}
				throw error;
			}
		}
		if (current.status === "off" && current.lastOutcome?.outcome === "completed") {
			throw new ProgrammeControlStateError(
				"conflict",
				`Cannot attach ${programmeId}: the programme is completed; use a fresh programme id`,
			);
		}
		const previousOwner: ProgrammeOwner | null = current.owner ?? null;
		const sameOwner = previousOwner?.sessionId === sessionId && previousOwner?.processKey === processKey;
		if (!sameOwner && (current.executions?.length ?? 0) > 0) {
			throw new ProgrammeControlStateError("conflict", "Ownership blocked: old executions are unsettled; do not expire or clear their tickets by age");
		}
		if (options.guarded && current.executions === undefined && !sameOwner && previousOwner !== null) {
			throw new ProgrammeControlStateError("conflict", "Legacy owner has no execution settlement guarantee; upgrade and settle the old session before transfer");
		}
		// AM1.4 (supersedes the 10-02 "no hot takeover with live workers" rule):
		// worker reservations belong to running lanes and stay as they are, and
		// the open continuation claim stays with the run that holds it: that run
		// settles it by claim id, and the new owner recovers it only through the
		// stale path. Only an unsettled execution ticket (the old session's current
		// tool call) blocks.
		if (sameOwner && options.preserveState && (!options.guarded || current.executions !== undefined)) {
			return { programmeId, status: current.status, owner: cloneJson(previousOwner!), previousOwner: cloneJson(previousOwner!), takeover: false, created: false };
		}
		const targetStatus = options.preserveState ? current.status : "running";
		const targetPause = options.preserveState ? current.pauseReason : null;
		if (
			previousOwner !== null &&
			previousOwner.sessionId === sessionId &&
			previousOwner.processKey === processKey
		) {
			// The owning process re-attaching (any status): no ownership change and
			// no epoch bump — attach is the operator's on, so it resumes and
			// refreshes the lease. A different process of the same saved session
			// still bumps the epoch below, fencing the dead process.
			const next: ProgrammeControlRecord = {
				...current,
				status: targetStatus,
				pauseReason: targetPause,
				...(options.guarded ? { executions: current.executions ?? [] } : {}),
				owner: { ...previousOwner, leaseExpiresAt: leaseExpiry(now) },
				revision: current.revision + 1,
				updatedAt: now,
				operatorActions: appendOperatorAction(current, {
					action: "start",
					operatorRef: operator,
					at: now,
					fromStatus: current.status,
					toStatus: targetStatus,
				}),
			};
			try {
				const record = store.update(programmeId, current.revision, () => next);
				return {
					programmeId,
					status: record.status,
					owner: cloneJson(record.owner) as ProgrammeOwner,
					previousOwner: cloneJson(previousOwner) as ProgrammeOwner,
					takeover: false,
					created: false,
				};
			} catch (error) {
				if (error instanceof ProgrammeControlStateError && error.code === "conflict") {
					lastConflict = error.message;
					continue;
				}
				throw error;
			}
		}
		const owner: ProgrammeOwner = {
			sessionId,
			processKey,
			epoch: (previousOwner?.epoch ?? 0) + 1,
			leaseExpiresAt: leaseExpiry(now),
		};
		const takeover = previousOwner !== null && (previousOwner.sessionId !== sessionId || previousOwner.processKey !== processKey);
		const next: ProgrammeControlRecord = {
			...current,
			status: targetStatus,
			pauseReason: targetPause,
			...(options.guarded ? { executions: current.executions ?? [] } : {}),
			owner,
			enrolledSessions: current.enrolledSessions.includes(sessionId)
				? current.enrolledSessions
				: [...current.enrolledSessions, sessionId],
			revision: current.revision + 1,
			updatedAt: now,
			operatorActions: appendOperatorAction(current, {
				action: "start",
				operatorRef: operator,
				at: now,
				fromStatus: current.status,
				toStatus: targetStatus,
				...(takeover ? { reason: `ownership takeover from ${previousOwner.sessionId}` } : {}),
			}),
		};
		try {
			const record = store.update(programmeId, current.revision, () => next);
			return {
				programmeId,
				status: record.status,
				owner: cloneJson(record.owner) as ProgrammeOwner,
				previousOwner: cloneJson(previousOwner) as ProgrammeOwner | null,
				takeover,
				created: false,
			};
		} catch (error) {
			if (error instanceof ProgrammeControlStateError && error.code === "conflict") {
				lastConflict = error.message;
				continue;
			}
			throw error;
		}
	}
	throw new ProgrammeControlStateError(
		"conflict",
		`Programme ownership attach contended for ${programmeId}: ${lastConflict ?? "revision conflict"}`,
	);
}

/**
 * Operator off: autonomous execution authorization is revoked and the Discord
 * binding is released. The owner is cleared, so nothing routes to a session
 * that must not act. Pending wakes stay persisted but inert (admission denies
 * `off`), and an in-flight claim settles through completion without
 * re-enabling the programme.
 */
export function stopProgramme(
	programmeId: string,
	options: StopProgrammeOptions,
	context?: ProgrammeControlContext,
): ProgrammeControlRecord {
	assertProgrammeId(programmeId);
	const reason = nonEmptyString(options?.reason) ? options.reason.trim() : "";
	if (!nonEmptyString(reason)) throw invalidInput("stopProgramme requires a non-empty reason");
	const operatorRef =
		typeof options?.operatorRef === "string" && nonEmptyString(options.operatorRef)
			? operatorRefFrom(options.operatorRef, "stopProgramme")
			: null;
	const now = new Date().toISOString();
	const result = casProgrammeControl(programmeId, context, (current): ProgrammeControlPlan<ProgrammeControlRecord> => {
		if (current.status === "off" && (current.owner ?? null) === null) return { value: current };
		const next: ProgrammeControlRecord = {
			...current,
			status: "off",
			pauseReason: null,
			owner: null,
			revision: current.revision + 1,
			updatedAt: now,
			operatorActions: appendOperatorAction(current, {
				action: "off",
				operatorRef,
				at: now,
				fromStatus: current.status,
				toStatus: "off",
				reason,
			}),
		};
		return { next, value: next };
	});
	return result.record ?? result.value;
}

/**
 * Renew the advisory owner lease when less than half of it remains. Called by
 * the owner session's relay drain tick; a control decision never depends on
 * the lease.
 */
export function touchProgrammeOwnerLease(
	programmeId: string,
	fence: OwnerFence,
	context?: ProgrammeControlContext,
): { touched: boolean; owner: ProgrammeOwner | null } {
	assertProgrammeId(programmeId);
	const now = new Date().toISOString();
	const result = casProgrammeControl(
		programmeId,
		context,
		(current): ProgrammeControlPlan<{ touched: boolean; owner: ProgrammeOwner | null }> => {
			const owner: ProgrammeOwner | null = current.owner ?? null;
			if (!ownerFenceSatisfied(owner, fence)) return { value: { touched: false, owner } };
			if (owner === null) return { value: { touched: false, owner: null } };
			const remaining = Date.parse(owner.leaseExpiresAt) - Date.parse(now);
			if (remaining > PROGRAMME_OWNER_LEASE_MS / 2) return { value: { touched: false, owner } };
			const next: ProgrammeControlRecord = {
				...current,
				owner: { ...owner, leaseExpiresAt: leaseExpiry(now) },
				revision: current.revision + 1,
				updatedAt: now,
			};
			return { next, value: { touched: true, owner: next.owner } };
		},
	);
	return result.value;
}

/** Fresh disk read of the persisted record; throws `missing` when absent. */
export function readProgrammeSnapshot(programmeId: string, context?: ProgrammeControlContext): ProgrammeControlRecord {
	assertProgrammeId(programmeId);
	const record = resolveProgrammeControlStore(context).read(programmeId);
	if (record === undefined) {
		throw new ProgrammeControlStateError("missing", `No programme control record for ${programmeId}`);
	}
	return record;
}

/**
 * Record one wake reason. Idempotent by `sourceEventId`: a replay coalesces
 * onto the existing pending entry (or onto the active claim that already
 * consumed it) and no second entry is persisted.
 */
export function enqueueWake(
	programmeId: string,
	event: WakeEvent,
	context?: ProgrammeControlContext,
): WakeEnqueueResult {
	assertProgrammeId(programmeId);
	const sourceEventId = typeof event?.sourceEventId === "string" ? event.sourceEventId : "";
	const kind = event?.kind;
	const reason = typeof event?.reason === "string" ? event.reason : "";
	const sessionRef = event?.sessionRef;
	if (!nonEmptyString(sourceEventId)) throw invalidInput("enqueueWake event.sourceEventId must be a non-empty string");
	if (!oneOf(WAKE_KINDS, kind)) throw invalidInput(`enqueueWake event.kind must be one of ${WAKE_KINDS.join(", ")}`);
	if (!nonEmptyString(reason)) throw invalidInput("enqueueWake event.reason must be a non-empty string");
	if (sessionRef !== undefined && !nonEmptyString(sessionRef)) {
		throw invalidInput("enqueueWake event.sessionRef must be a non-empty string when present");
	}
	const now = new Date().toISOString();
	const result = casProgrammeControl(programmeId, context, (current): ProgrammeControlPlan<WakeEnqueueResult> => {
		const alreadyPending = current.pendingWakes.some((wake) => wake.sourceEventId === sourceEventId);
		const alreadyClaimed = current.activeClaim?.wakeIds.includes(sourceEventId) === true;
		if (alreadyPending || alreadyClaimed) {
			return { value: { outcome: "coalesced", pendingWakeCount: current.pendingWakes.length } };
		}
		const wake: PendingWake = {
			sourceEventId,
			kind,
			reason,
			enqueuedAt: now,
			...(sessionRef !== undefined ? { sessionRef } : {}),
		};
		const next: ProgrammeControlRecord = {
			...current,
			pendingWakes: [...current.pendingWakes, wake],
			revision: current.revision + 1,
			updatedAt: now,
		};
		return { next, value: { outcome: "enqueued", pendingWakeCount: next.pendingWakes.length } };
	});
	return result.value;
}

/**
 * Atomically evaluate the plan §3 admission predicates and, when admitted,
 * take the single active continuation claim (draining pending wake IDs into
 * it). Only a `running` programme is admitted: `off`, `paused` and the kill
 * file deny, and the visible `waiting` state returns `waiting` until an
 * operator applies the decision or resumes. An active claim, an open blocking
 * decision or a full writer ceiling also return `waiting` with concrete
 * reasons. A wake never authorizes admission by itself.
 */
export function claimContinuation(
	programmeId: string,
	sessionRef: string,
	context?: ProgrammeControlContext,
	ownerFence?: OwnerFence,
): ClaimContinuationResult {
	assertProgrammeId(programmeId);
	if (!nonEmptyString(sessionRef)) throw invalidInput("claimContinuation requires a non-empty sessionRef");
	const now = new Date().toISOString();
	const result = casProgrammeControl(programmeId, context, (current): ProgrammeControlPlan<ClaimContinuationResult> => {
		if (!ownerFenceSatisfied(current.owner, ownerFence) || (ownerFence !== undefined && ownerFence.sessionId !== sessionRef)) {
			// Ownership fencing: the caller's epoch is stale (takeover/off happened
			// after it resolved its enrollment), so admission is denied without
			// touching the claim state of the current owner.
			return { value: { outcome: "denied", reason: "ownership-lost" } };
		}
		const decision = evaluateContinuationAdmission(current, killFilePresent(context));
		if (decision.outcome !== "admitted") return { value: decision };
		const claimId = `clm_${randomUUID()}`;
		const next: ProgrammeControlRecord = {
			...current,
			enrolledSessions: current.enrolledSessions.includes(sessionRef)
				? current.enrolledSessions
				: [...current.enrolledSessions, sessionRef],
			activeClaim: {
				claimId,
				owner: laneOwnerRef(sessionRef),
				sessionRef,
				runGeneration: current.runGeneration,
				admittedAt: now,
				wakeIds: current.pendingWakes.map((wake) => wake.sourceEventId),
				// The drained rows are persisted with the claim (plan §7 P4.2): a crash
				// between admission and delivery replays the same owner with the
				// original reasons instead of losing the continuation.
				wakes: current.pendingWakes.map((wake) => cloneJson(wake)),
			},
			pendingWakes: [],
			// Advisory lease renewal: an admitted continuation is honest evidence
			// the owner process is alive.
			...(current.owner !== null && current.owner.sessionId === sessionRef
				? { owner: { ...current.owner, leaseExpiresAt: leaseExpiry(now) } }
				: {}),
			revision: current.revision + 1,
			updatedAt: now,
		};
		return { next, value: { outcome: "admitted", claimId } };
	});
	// CAS commits release their file lock before returning. Another OS process
	// may take ownership in that interval; never deliver a stale admission. Keep
	// the committed claim as recovery evidence rather than erasing new-owner state.
	if (result.value.outcome === "admitted" && ownerFence !== undefined &&
		!ownerFenceSatisfied(resolveProgrammeControlStore(context).read(programmeId)?.owner, ownerFence)) {
		return { outcome: "denied", reason: "ownership-lost" };
	}
	return result.value;
}

/**
 * Release the active claim, persist the structured outcome and bump the run
 * generation so an older generation cannot be resumed. Unknown or
 * already-completed `claimId` values are a typed `conflict`, never a silent
 * success.
 */
export function completeContinuation(
	programmeId: string,
	claimId: string,
	outcome: ContinuationOutcome,
	context?: ProgrammeControlContext,
): ProgrammeControlRecord {
	assertProgrammeId(programmeId);
	if (!nonEmptyString(claimId)) throw invalidInput("completeContinuation requires a non-empty claimId");
	if (!oneOf(CONTINUATION_OUTCOMES, outcome)) {
		throw invalidInput(`completeContinuation outcome must be one of ${CONTINUATION_OUTCOMES.join(", ")}`);
	}
	const now = new Date().toISOString();
	const result = casProgrammeControl(programmeId, context, (current): ProgrammeControlPlan<ProgrammeControlRecord> => {
		if (current.activeClaim === null || current.activeClaim.claimId !== claimId) {
			throw new ProgrammeControlStateError(
				"conflict",
				`No active continuation claim ${claimId} for ${programmeId}: it is unknown or already completed`,
			);
		}
		const runGeneration = current.runGeneration + 1;
		// Once `off`, an in-flight worker's settlement cannot silently re-enable
		// the programme: the operator's off decision holds until explicit on.
		const status =
			current.status === "off" && statusAfterOutcome(outcome) === "running"
				? "off"
				: statusAfterOutcome(outcome);
		const next: ProgrammeControlRecord = {
			...current,
			revision: current.revision + 1,
			updatedAt: now,
			status,
			runGeneration,
			pauseReason: outcome === "paused" ? (current.pauseReason ?? "run outcome: paused") : null,
			activeClaim: null,
			lastOutcome: { outcome, claimId, runGeneration, completedAt: now },
		};
		return { next, value: next };
	});
	return result.record ?? result.value;
}

/** Operator pause. Idempotent while already paused; an `off` programme cannot pause. */
export function pauseProgramme(
	programmeId: string,
	reason: string,
	context?: ProgrammeControlContext,
	ownerFence?: OwnerFence,
): ProgrammeControlRecord {
	assertProgrammeId(programmeId);
	if (!nonEmptyString(reason)) throw invalidInput("pauseProgramme requires a non-empty reason");
	const now = new Date().toISOString();
	const result = casProgrammeControl(programmeId, context, (current): ProgrammeControlPlan<ProgrammeControlRecord> => {
		if (!ownerFenceSatisfied(current.owner, ownerFence)) {
			throw new ProgrammeControlStateError(
				"conflict",
				`Cannot pause ${programmeId}: ownership changed (stale epoch ${String(ownerFence?.epoch)}); this session no longer owns the programme`,
			);
		}
		if (current.status === "off") {
			throw new ProgrammeControlStateError("conflict", `Cannot pause ${programmeId}: the programme is off`);
		}
		if (current.status === "paused") return { value: current };
		const next: ProgrammeControlRecord = {
			...current,
			status: "paused",
			pauseReason: reason,
			revision: current.revision + 1,
			updatedAt: now,
			operatorActions: appendOperatorAction(current, {
				action: "pause",
				operatorRef: null,
				at: now,
				fromStatus: current.status,
				toStatus: "paused",
				reason,
			}),
		};
		return { next, value: next };
	});
	return result.record ?? result.value;
}

/**
 * Operator resume. A non-empty `operatorRef` is mandatory and recorded, so an
 * agent call with an empty/absent identity is rejected before any mutation.
 */
export function resumeProgramme(
	programmeId: string,
	operatorRef: string,
	context?: ProgrammeControlContext,
	ownerFence?: OwnerFence,
): ProgrammeControlRecord {
	assertProgrammeId(programmeId);
	const operator = operatorRefFrom(operatorRef, "resumeProgramme");
	const now = new Date().toISOString();
	const result = casProgrammeControl(programmeId, context, (current): ProgrammeControlPlan<ProgrammeControlRecord> => {
		if (!ownerFenceSatisfied(current.owner, ownerFence)) {
			throw new ProgrammeControlStateError(
				"conflict",
				`Cannot resume ${programmeId}: ownership changed (stale epoch ${String(ownerFence?.epoch)}); this session no longer owns the programme`,
			);
		}
		if (current.status === "off") {
			throw new ProgrammeControlStateError(
				"conflict",
				`Cannot resume ${programmeId}: the programme is off; use startProgramme`,
			);
		}
		if (current.status === "running") return { value: current };
		if (current.status !== "paused" && current.status !== "waiting") {
			throw new ProgrammeControlStateError("conflict", `Cannot resume ${programmeId}: status ${current.status} is not paused`);
		}
		const next: ProgrammeControlRecord = {
			...current,
			status: "running",
			pauseReason: null,
			revision: current.revision + 1,
			updatedAt: now,
			operatorActions: appendOperatorAction(current, {
				action: "resume",
				operatorRef: operator,
				at: now,
				fromStatus: current.status,
				toStatus: "running",
			}),
		};
		return { next, value: next };
	});
	return result.record ?? result.value;
}

/**
 * Atomically reserve one writer slot against the programme ceiling. Repeating
 * the same `ownerRef` is idempotent and does not consume a second slot.
 */
export function reserveWriter(
	programmeId: string,
	ownerRef: string,
	context?: ProgrammeControlContext,
): WriterReservationResult {
	assertProgrammeId(programmeId);
	if (!nonEmptyString(ownerRef)) throw invalidInput("reserveWriter requires a non-empty ownerRef");
	const now = new Date().toISOString();
	const result = casProgrammeControl(programmeId, context, (current): ProgrammeControlPlan<WriterReservationResult> => {
		if (current.reservations.some((reservation) => reservation.ownerRef === ownerRef)) {
			return { value: { outcome: "admitted", activeReservations: current.reservations.length } };
		}
		if (current.reservations.length >= current.ceiling) {
			return {
				value: { outcome: "denied", reason: "ceiling", activeReservations: current.reservations.length },
			};
		}
		const next: ProgrammeControlRecord = {
			...current,
			reservations: [...current.reservations, { ownerRef, reservedAt: now }],
			revision: current.revision + 1,
			updatedAt: now,
		};
		return { next, value: { outcome: "admitted", activeReservations: next.reservations.length } };
	});
	return result.value;
}

/** Release a writer slot. Releasing an unreserved owner is an idempotent no-op. */
export function releaseWriter(
	programmeId: string,
	ownerRef: string,
	context?: ProgrammeControlContext,
): WriterReleaseResult {
	assertProgrammeId(programmeId);
	if (!nonEmptyString(ownerRef)) throw invalidInput("releaseWriter requires a non-empty ownerRef");
	const now = new Date().toISOString();
	const result = casProgrammeControl(programmeId, context, (current): ProgrammeControlPlan<WriterReleaseResult> => {
		const hadReservation = current.reservations.some((reservation) => reservation.ownerRef === ownerRef);
		const laneLaunches = current.laneLaunches.filter((launch) => launch.ownerRef !== ownerRef);
		if (!hadReservation && laneLaunches.length === current.laneLaunches.length) {
			return { value: { released: false, activeReservations: current.reservations.length } };
		}
		const reservations = current.reservations.filter((reservation) => reservation.ownerRef !== ownerRef);
		const next: ProgrammeControlRecord = {
			...current,
			reservations,
			laneLaunches,
			revision: current.revision + 1,
			updatedAt: now,
		};
		return { next, value: { released: hadReservation, activeReservations: reservations.length } };
	});
	return result.value;
}

// ─── Descendant writer reservations (plan §7 P3) ─────────────────────────────

/**
 * Atomically reserve the files one lane/leaf writer will touch, before that
 * writer is dispatched. A new owner takes both a descendant row and a writer
 * slot, so the plan §3 ceiling covers the whole descendant set rather than only
 * the lane processes; repeating the same owner with files it already claims is
 * idempotent and writes nothing.
 *
 * Overlap with any other owner's reservation — including the reservation of the
 * programme's own active claim owner, which is an ordinary row here — is a
 * typed `DescendantReservationConflictError` naming both owners and the
 * contested files. The bounded row cap and the writer ceiling are
 * `DescendantReservationLimitError`s. Provenance is the reservation's
 * `reservedAt`; a completed programme needs no release, and the rows stay
 * readable through `listDescendantReservations`.
 */
export function reserveDescendantWriter(
	programmeId: string,
	ownerRef: string,
	kind: DescendantOwnerKind,
	files: readonly string[],
	context?: ProgrammeControlContext,
	options?: { parentOwnerRef?: string },
): DescendantReservationCommit {
	assertProgrammeId(programmeId);
	const parentRef = options?.parentOwnerRef === undefined ? undefined : parseDescendantOwnerRef(options.parentOwnerRef) === undefined ? undefined : options.parentOwnerRef;
	if (options?.parentOwnerRef !== undefined && parentRef === undefined) {
		throw invalidInput(`reserveDescendantWriter parentOwnerRef must be lane:<id> or leaf:<id>, got ${String(options.parentOwnerRef)}`);
	}
	if (parentRef === ownerRef) {
		throw invalidInput(`reserveDescendantWriter ownerRef ${ownerRef} cannot be its own parent`);
	}
	const owner = parseDescendantOwnerRef(ownerRef);
	if (owner === undefined) {
		throw invalidInput(`reserveDescendantWriter ownerRef must be lane:<id> or leaf:<id>, got ${String(ownerRef)}`);
	}
	if (owner.kind !== kind) {
		throw invalidInput(`reserveDescendantWriter ownerRef ${ownerRef} does not match kind ${kind}`);
	}
	if (!Array.isArray(files) || files.length === 0) {
		throw invalidInput("reserveDescendantWriter requires at least one file");
	}
	const requested: string[] = [];
	for (const entry of files) {
		const normalized = normalizeDescendantPath(entry);
		if (normalized === undefined) {
			throw invalidInput(
				`reserveDescendantWriter file must be a non-empty relative POSIX path, got ${JSON.stringify(entry)}`,
			);
		}
		if (!requested.includes(normalized)) requested.push(normalized);
	}
	requested.sort();
	const store = resolveProgrammeControlStore(context);
	const now = new Date().toISOString();
	let lastConflict: string | undefined;
	for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
		const current = store.read(programmeId);
		if (current === undefined) {
			throw new ProgrammeControlStateError("missing", `No programme control record for ${programmeId}`);
		}
		const existing = current.reservedPaths.find((entry) => entry.ownerRef === ownerRef);
		const held = existing?.files ?? [];
		// A requested file already covered (exactly or by directory containment) by
		// this owner's own claim is not a new claim; a plain `reserveWriter` slot
		// does not cover files.
		const added = requested.filter((file) => !held.some((claimed) => descendantPathsOverlap(claimed, file)));
		const hasSlot = current.reservations.some((slot) => slot.ownerRef === ownerRef);
		if (existing !== undefined && added.length === 0 && hasSlot) {
			// Fully covered with its writer slot in place: the identical reservation
			// is already on disk, so nothing is written.
			return {
				reservation: cloneJson(existing),
				added: [],
				created: false,
				activeWriters: current.reservations.length,
				descendantReservations: current.reservedPaths.length,
			};
		}
		if (existing === undefined && current.reservedPaths.length >= MAX_DESCENDANT_RESERVATIONS) {
			throw new DescendantReservationLimitError(
				"reservations",
				MAX_DESCENDANT_RESERVATIONS,
				current.reservedPaths.length,
				current.reservations.length,
			);
		}
		if (!hasSlot && current.reservations.length >= current.ceiling) {
			throw new DescendantReservationLimitError(
				"writers",
				current.ceiling,
				current.reservedPaths.length,
				current.reservations.length,
			);
		}
		const conflict = firstDescendantConflict(current.reservedPaths, ownerRef, added, parentRef);
		if (conflict !== undefined) {
			throw new DescendantReservationConflictError(ownerRef, conflict.ownerRef, conflict.files);
		}
		const reservation: DescendantReservation = {
			ownerRef,
			kind,
			files: existing === undefined ? requested : [...new Set([...held, ...added])].sort(),
			reservedAt: existing?.reservedAt ?? now,
		};
		const reservedPaths =
			existing === undefined
				? [...current.reservedPaths, reservation]
				: current.reservedPaths.map((entry) => (entry.ownerRef === ownerRef ? reservation : entry));
		const reservations = hasSlot
			? current.reservations
			: [...current.reservations, { ownerRef, reservedAt: now }];
		const next: ProgrammeControlRecord = {
			...current,
			reservations,
			reservedPaths,
			revision: current.revision + 1,
			updatedAt: now,
		};
		try {
			const record = store.update(programmeId, current.revision, () => next);
			return {
				reservation: cloneJson(
					record.reservedPaths.find((entry) => entry.ownerRef === ownerRef) ?? reservation,
				),
				added,
				created: existing === undefined,
				activeWriters: record.reservations.length,
				descendantReservations: record.reservedPaths.length,
			};
		} catch (error) {
			if (error instanceof ProgrammeControlStateError && error.code === "conflict") {
				lastConflict = error.message;
				continue;
			}
			throw error;
		}
	}
	throw new ProgrammeControlStateError(
		"conflict",
		`Descendant reservation contended for ${programmeId}: ${lastConflict ?? "revision conflict"}`,
	);
}

/** Adopt a pre-launch slot into the authenticated fresh worker session without consuming a second slot. */
export function adoptLaunchReservation(programmeId: string, pendingOwnerRef: string, ownerRef: string, context?: ProgrammeControlContext): void {
	assertProgrammeId(programmeId);
	if (parseDescendantOwnerRef(pendingOwnerRef)?.kind !== "lane" || parseDescendantOwnerRef(ownerRef)?.kind !== "lane" || pendingOwnerRef === ownerRef) throw invalidInput("invalid launch reservation adoption identity");
	casProgrammeControl(programmeId, context, (current) => {
		if (current.status !== "running" || killFilePresent(context) || current.decisionRefs.some((ref) => ref.status === "open" && ref.blocking)) throw invalidInput("worker bootstrap is paused, stopped or decision-blocked");
		if (!current.reservations.some((row) => row.ownerRef === pendingOwnerRef) || current.reservations.some((row) => row.ownerRef === ownerRef)) throw invalidInput("worker bootstrap launch slot is absent or already adopted");
		return { next: { ...current,
			reservations: current.reservations.map((row) => row.ownerRef === pendingOwnerRef ? { ...row, ownerRef } : row),
			reservedPaths: current.reservedPaths.map((row) => row.ownerRef === pendingOwnerRef ? { ...row, ownerRef } : row),
			laneLaunches: current.laneLaunches.map((row) => row.ownerRef === pendingOwnerRef ? { ...row, ownerRef } : row),
			revision: current.revision + 1, updatedAt: new Date().toISOString() }, value: undefined };
	});
}

/**
 * Release one writer's descendant reservation. Releasing an owner with no
 * reservation is an idempotent no-op. When a row exists, the writer slot the
 * reservation acquired is released with it (that owner has stopped writing); a
 * slot acquired only through `reserveWriter` stays until `releaseWriter`.
 */
export function releaseDescendantWriter(
	programmeId: string,
	ownerRef: string,
	context?: ProgrammeControlContext,
): DescendantReservationReleaseResult {
	assertProgrammeId(programmeId);
	if (!nonEmptyString(ownerRef)) throw invalidInput("releaseDescendantWriter requires a non-empty ownerRef");
	const now = new Date().toISOString();
	const result = casProgrammeControl(
		programmeId,
		context,
		(current): ProgrammeControlPlan<DescendantReservationReleaseResult> => {
			const hadPathReservation = current.reservedPaths.some((entry) => entry.ownerRef === ownerRef);
			const laneLaunches = current.laneLaunches.filter((launch) => launch.ownerRef !== ownerRef);
			if (!hadPathReservation && laneLaunches.length === current.laneLaunches.length) {
				return {
					value: {
						released: false,
						activeWriters: current.reservations.length,
						descendantReservations: current.reservedPaths.length,
					},
				};
			}
			const reservedPaths = current.reservedPaths.filter((entry) => entry.ownerRef !== ownerRef);
			const reservations = current.reservations.filter((slot) => slot.ownerRef !== ownerRef);
			const next: ProgrammeControlRecord = {
				...current,
				reservations,
				reservedPaths,
				laneLaunches,
				revision: current.revision + 1,
				updatedAt: now,
			};
			return {
				next,
				value: {
					released: true,
					activeWriters: reservations.length,
					descendantReservations: reservedPaths.length,
				},
			};
		},
	);
	return result.value;
}

/**
 * The descendant reservations currently on disk, in stored order. A completed
 * programme keeps its rows: reservations are moot, not deleted, and an operator
 * or recovery pass can still inspect who held what.
 */
export function listDescendantReservations(
	programmeId: string,
	context?: ProgrammeControlContext,
): DescendantReservation[] {
	assertProgrammeId(programmeId);
	const record = resolveProgrammeControlStore(context).read(programmeId);
	if (record === undefined) {
		throw new ProgrammeControlStateError("missing", `No programme control record for ${programmeId}`);
	}
	return record.reservedPaths.map((entry) => cloneJson(entry));
}

export type DecisionRefInput = {
	decisionId: string;
	/** Defaults to true: an open decision blocks continuation until applied. */
	blocking?: boolean;
};

/** Record a reference-only link to an open human decision (no decision content). */
export function recordDecisionRef(
	programmeId: string,
	input: DecisionRefInput,
	context?: ProgrammeControlContext,
): ProgrammeControlRecord {
	assertProgrammeId(programmeId);
	const decisionId = typeof input?.decisionId === "string" ? input.decisionId : "";
	if (!nonEmptyString(decisionId)) throw invalidInput("recordDecisionRef requires a non-empty decisionId");
	const blocking = input?.blocking ?? true;
	if (typeof blocking !== "boolean") throw invalidInput("recordDecisionRef blocking must be a boolean when present");
	const now = new Date().toISOString();
	const result = casProgrammeControl(programmeId, context, (current): ProgrammeControlPlan<ProgrammeControlRecord> => {
		if (current.decisionRefs.some((ref) => ref.decisionId === decisionId)) return { value: current };
		const next: ProgrammeControlRecord = {
			...current,
			decisionRefs: [
				...current.decisionRefs,
				{
					decisionId,
					status: "open",
					blocking,
					updatedAt: now,
				},
			],
			revision: current.revision + 1,
			updatedAt: now,
		};
		return { next, value: next };
	});
	return result.record ?? result.value;
}

export type ApplyDecisionInput = {
	/** Operator identity; agents must not apply human decisions. */
	operatorRef: string;
};

/**
 * Mark a referenced decision applied. When the programme was visibly waiting
 * and no blocking open decision remains, it returns to `running`.
 */
export function applyDecisionRef(
	programmeId: string,
	decisionId: string,
	input: ApplyDecisionInput,
	context?: ProgrammeControlContext,
): ProgrammeControlRecord {
	assertProgrammeId(programmeId);
	if (!nonEmptyString(decisionId)) throw invalidInput("applyDecisionRef requires a non-empty decisionId");
	const operator = operatorRefFrom(input?.operatorRef, "applyDecisionRef");
	const now = new Date().toISOString();
	const result = casProgrammeControl(programmeId, context, (current): ProgrammeControlPlan<ProgrammeControlRecord> => {
		const ref = current.decisionRefs.find((candidate) => candidate.decisionId === decisionId);
		if (ref === undefined) {
			throw new ProgrammeControlStateError("conflict", `Unknown decision reference ${decisionId} for ${programmeId}`);
		}
		if (ref.status === "applied") return { value: current };
		const decisionRefs: DecisionRef[] = current.decisionRefs.map((candidate) =>
			candidate.decisionId === decisionId
				? { ...candidate, status: "applied", appliedBy: operator, updatedAt: now }
				: candidate,
		);
		const stillBlocking = decisionRefs.some((candidate) => candidate.status === "open" && candidate.blocking);
		const next: ProgrammeControlRecord = {
			...current,
			decisionRefs,
			status: current.status === "waiting" && !stillBlocking ? "running" : current.status,
			revision: current.revision + 1,
			updatedAt: now,
		};
		return { next, value: next };
	});
	return result.record ?? result.value;
}

// ─── Retired identities (R1 item 5) ──────────────────────────────────────────

export type RetireAgentInput = {
	agentId: string;
	/** Operator identity; retirement is never agent-issued. */
	operatorRef: string;
	reason?: string;
};

/**
 * Record an operator's decision that an agent identity is retired. Idempotent:
 * retiring an id twice writes nothing the second time. The row is kept as
 * evidence; this never deletes or edits a claim, task or message.
 */
export function retireAgent(
	programmeId: string,
	input: RetireAgentInput,
	context?: ProgrammeControlContext,
): ProgrammeControlRecord {
	assertProgrammeId(programmeId);
	const operator = operatorRefFrom(input?.operatorRef, "retireAgent");
	const agentId = typeof input?.agentId === "string" ? input.agentId.trim() : "";
	if (agentId === "" || validateAgentId(agentId) !== agentId) {
		throw invalidInput("retireAgent requires a valid agent id (lowercase letters, digits, - and _)");
	}
	const reason = typeof input?.reason === "string" && input.reason.trim() !== "" ? input.reason.trim() : undefined;
	const now = new Date().toISOString();
	const result = casProgrammeControl(programmeId, context, (current): ProgrammeControlPlan<ProgrammeControlRecord> => {
		if (current.retiredAgents.some((row) => row.agentId === agentId)) return { value: current };
		if (current.retiredAgents.length >= MAX_RETIRED_AGENTS) {
			throw new ProgrammeControlStateError("conflict", `Cannot retire ${agentId}: ${MAX_RETIRED_AGENTS} identities are already retired for ${programmeId}`);
		}
		const next: ProgrammeControlRecord = {
			...current,
			retiredAgents: [...current.retiredAgents, { agentId, retiredAt: now, operatorRef: operator, ...(reason !== undefined ? { reason } : {}) }],
			revision: current.revision + 1,
			updatedAt: now,
		};
		return { next, value: next };
	});
	return result.record ?? result.value;
}

// ─── Merge queue (R2) ───────────────────────────────────────────────────────

/**
 * Record what a worker offered for one task: the base it rebased on, its head
 * and the guarded-run logs it verified that head with. One row per task; a new
 * offer replaces the old one and drops that task's review verdicts, because a
 * verdict names a head. Nothing is deleted: the previous row is replaced in the
 * record and its loss is visible as the new row's `at`.
 */
export function recordTaskOffer(
	programmeId: string,
	input: { taskId: string; offeredBy: string } & OfferEvidence,
	context?: ProgrammeControlContext,
): ProgrammeControlRecord {
	assertProgrammeId(programmeId);
	const taskId = requiredText(input?.taskId, "recordTaskOffer taskId");
	const offeredBy = requiredText(input?.offeredBy, "recordTaskOffer offeredBy");
	const baseSha = requiredText(input?.base_sha, "recordTaskOffer base_sha");
	const headSha = requiredText(input?.head_sha, "recordTaskOffer head_sha");
	if (!Array.isArray(input?.evidence) || input.evidence.length === 0) throw invalidInput("recordTaskOffer requires at least one evidence log");
	const rows = input.evidence.map((entry, index) => ({
		log: requiredText(entry?.log, `recordTaskOffer evidence[${index}].log`),
		root: requiredText(entry?.root, `recordTaskOffer evidence[${index}].root`),
		head_sha: requiredText(entry?.head_sha, `recordTaskOffer evidence[${index}].head_sha`),
		fingerprint: requiredText(entry?.fingerprint, `recordTaskOffer evidence[${index}].fingerprint`),
	}));
	const now = new Date().toISOString();
	const row: TaskOffer = { taskId, offeredBy, base_sha: baseSha, head_sha: headSha, evidence: rows, ...(input.proof ? { proof: cloneJson(input.proof) } : {}), ...(input.runtime ? { runtime: cloneJson(input.runtime) } : {}), at: now };
	const result = casProgrammeControl(programmeId, context, (current): ProgrammeControlPlan<ProgrammeControlRecord> => {
		const queue = current.mergeQueue ?? { offers: [], reviews: [] };
		const kept = queue.offers.filter((offer) => offer.taskId !== taskId);
		const offers = [...kept, row];
		if (offers.length > MAX_MERGE_OFFERS) throw new ProgrammeControlStateError("conflict", `The merge queue holds ${MAX_MERGE_OFFERS} offers; clear an integrated task before offering another`);
		const next: ProgrammeControlRecord = {
			...current,
			mergeQueue: { offers, reviews: queue.reviews.filter((review) => review.taskId !== taskId) },
			revision: current.revision + 1,
			updatedAt: now,
		};
		return { next, value: next };
	});
	return result.record ?? result.value;
}

/**
 * Record an independent reviewer's verdict on a task's offered head. The
 * reviewer must be neither the worker that offered the head nor the session
 * that owns the programme: a verdict from either of them is not independent.
 */
export function recordReviewVerdict(
	programmeId: string,
	input: Omit<ReviewVerdict, "at"> & { at?: string },
	context?: ProgrammeControlContext,
): ProgrammeControlRecord {
	assertProgrammeId(programmeId);
	const taskId = requiredText(input?.taskId, "recordReviewVerdict taskId");
	const reviewer = requiredText(input?.reviewer, "recordReviewVerdict reviewer");
	const headSha = requiredText(input?.head_sha, "recordReviewVerdict head_sha");
	if (!oneOf(["approve", "reject"] as const, input?.verdict)) throw invalidInput("recordReviewVerdict verdict must be approve or reject");
	if (!isRuntimeActorIdentity(input.runtime) || !isRuntimeActorIdentity(input.parentRuntime)) throw invalidInput("recordReviewVerdict: independent reviewer/parent runtime model identity is unavailable");
	const reviewerRuntime = cloneJson(input.runtime);
	const parentRuntime = cloneJson(input.parentRuntime);
	const now = new Date().toISOString();
	const result = casProgrammeControl(programmeId, context, (current): ProgrammeControlPlan<ProgrammeControlRecord> => {
		const queue = current.mergeQueue ?? { offers: [], reviews: [] };
		const offer = queue.offers.find((row) => row.taskId === taskId);
		if (offer === undefined) throw invalidInput(`recordReviewVerdict: no offer is recorded for ${taskId}`);
		const verdict: ReviewVerdict = { taskId, reviewer, verdict: input.verdict, head_sha: headSha, at: now, runtime: reviewerRuntime, parentRuntime };
		if (current.owner?.sessionId !== parentRuntime.sessionId || offer.offeredBy === reviewer || !reviewIsIndependent(offer, verdict, parentRuntime)) {
			throw invalidInput(`recordReviewVerdict: the reviewer must be an independent session and model, neither the offering worker (${offer.offeredBy}) nor the programme owner`);
		}
		const reviews = [...queue.reviews.filter((review) => review.taskId !== taskId), verdict];
		const next: ProgrammeControlRecord = {
			...current,
			mergeQueue: { offers: queue.offers, reviews },
			revision: current.revision + 1,
			updatedAt: now,
		};
		return { next, value: next };
	});
	return result.record ?? result.value;
}

/** The offer recorded for one task, if any. */
export function readTaskOffer(programmeId: string, taskId: string, context?: ProgrammeControlContext): TaskOffer | undefined {
	assertProgrammeId(programmeId);
	const record = readProgrammeSnapshot(programmeId, context);
	return (record.mergeQueue?.offers ?? []).find((row) => row.taskId === taskId);
}

/** Committed out-of-glob parent edits for one task and repository-relative path. */
export function readParentWriteBudgetLines(programmeId: string, taskId: string, path: string, context?: ProgrammeControlContext): number {
	assertProgrammeId(programmeId);
	if (!nonEmptyString(taskId) || !validParentWritePath(path)) throw invalidInput("readParentWriteBudgetLines requires a taskId and repository-relative path");
	const record = readProgrammeSnapshot(programmeId, context);
	const existing = record.parentWriteBudgets.find((row) => row.taskId === taskId && row.path === path);
	if (existing === undefined && record.parentWriteBudgets.length >= MAX_PARENT_WRITE_BUDGETS) {
		throw new ProgrammeControlStateError("conflict", `Parent write budget store reached ${MAX_PARENT_WRITE_BUDGETS} entries`);
	}
	return existing?.changedLines ?? 0;
}

/** Persist a successful parent write's actual changed-line charge. */
export function recordParentWriteBudgetLines(
	programmeId: string,
	taskId: string,
	path: string,
	changedLines: number,
	maxLines: number,
	context?: ProgrammeControlContext,
): number {
	assertProgrammeId(programmeId);
	if (!nonEmptyString(taskId) || !validParentWritePath(path) || !Number.isSafeInteger(changedLines) || changedLines < 1 || !Number.isSafeInteger(maxLines) || maxLines < 0) {
		throw invalidInput("recordParentWriteBudgetLines requires task, path, positive changedLines and non-negative maxLines");
	}
	const updatedAt = new Date().toISOString();
	const result = casProgrammeControl(programmeId, context, (current): ProgrammeControlPlan<number> => {
		const rows = current.parentWriteBudgets ?? [];
		const existing = rows.find((row) => row.taskId === taskId && row.path === path);
		const total = (existing?.changedLines ?? 0) + changedLines;
		if (total > maxLines) throw new ProgrammeControlStateError("conflict", `Parent write budget for ${taskId}:${path} would exceed ${maxLines} changed lines`);
		if (existing === undefined && rows.length >= MAX_PARENT_WRITE_BUDGETS) {
			throw new ProgrammeControlStateError("conflict", `Parent write budget store reached ${MAX_PARENT_WRITE_BUDGETS} entries`);
		}
		const budget: ParentWriteBudget = { taskId, path, changedLines: total, updatedAt };
		const next: ProgrammeControlRecord = {
			...current,
			parentWriteBudgets: [...rows.filter((row) => row !== existing), budget],
			revision: current.revision + 1,
			updatedAt,
		};
		return { next, value: total };
	});
	return result.value;
}

/** Persist the integration phase on the existing offer row for crash-safe retry. */
export function recordTaskIntegrationPhase(
	programmeId: string,
	taskId: string,
	phase: IntegrationPhase,
	branch: string,
	context?: ProgrammeControlContext,
): TaskOffer {
	assertProgrammeId(programmeId);
	requiredText(branch, "recordTaskIntegrationPhase branch");
	if (!oneOf(["prepared", "accepted", "landed"] as const, phase)) throw invalidInput("recordTaskIntegrationPhase phase is invalid");
	const ranks: Record<IntegrationPhase, number> = { prepared: 0, accepted: 1, landed: 2 };
	const now = new Date().toISOString();
	return casProgrammeControl(programmeId, context, (current): ProgrammeControlPlan<TaskOffer> => {
		const queue = current.mergeQueue ?? { offers: [], reviews: [] };
		const offer = queue.offers.find((row) => row.taskId === taskId);
		if (!offer) throw invalidInput(`recordTaskIntegrationPhase: no offer is recorded for ${taskId}`);
		if (offer.integration && offer.integration.branch !== branch) throw invalidInput("recordTaskIntegrationPhase branch does not match the existing integration attempt");
		if (offer.integration && ranks[offer.integration.phase] > ranks[phase]) return { value: offer };
		const nextOffer: TaskOffer = { ...offer, integration: { phase, branch, at: now } };
		const next: ProgrammeControlRecord = { ...current, mergeQueue: { ...queue, offers: queue.offers.map((row) => row.taskId === taskId ? nextOffer : row) }, revision: current.revision + 1, updatedAt: now };
		return { next, value: nextOffer };
	}).value;
}

/** The verdict recorded for one task, if any. */
/** Persist/update one lane's resource ownership under its pre-existing writer reservation. */
export function recordLaneLaunch(
	programmeId: string,
	ownerRef: string,
	patch: Omit<LaneLaunchRecord, "ownerRef" | "updatedAt">,
	context?: ProgrammeControlContext,
): LaneLaunchRecord {
	assertProgrammeId(programmeId);
	if (parseDescendantOwnerRef(ownerRef)?.kind !== "lane" || ownerRef !== `lane:${patch.agentName}` || patch.phase === undefined || !nonEmptyString(patch.taskId) || !nonEmptyString(patch.attemptId)) {
		throw invalidInput("recordLaneLaunch requires a lane owner matching the task, attempt and agent identity");
	}
	const updatedAt = new Date().toISOString();
	const result = casProgrammeControl(programmeId, context, (current): ProgrammeControlPlan<LaneLaunchRecord> => {
		if (!current.reservations.some((reservation) => reservation.ownerRef === ownerRef)) throw invalidInput(`lane launch ${ownerRef} has no writer reservation`);
		const rows = current.laneLaunches ?? [];
		const existing = rows.find((row) => row.ownerRef === ownerRef);
		if (existing === undefined && patch.phase !== "reserved") throw invalidInput("a lane launch must be reserved before resource phases are recorded");
		if (existing === undefined && rows.length >= MAX_LANE_LAUNCHES) throw new ProgrammeControlStateError("conflict", `Lane launch ledger reached ${MAX_LANE_LAUNCHES} entries`);
		if (existing !== undefined && (existing.taskId !== patch.taskId || existing.attemptId !== patch.attemptId || existing.agentName !== patch.agentName)) {
			throw new ProgrammeControlStateError("conflict", `Lane launch identity changed for ${ownerRef}`);
		}
		const rank: Record<LaneLaunchPhase, number> = { reserved: 0, "worktree-ready": 1, "pane-created": 2, starting: 3, started: 4, failed: 5 };
		if (existing !== undefined && (existing.phase === "failed" || (patch.phase !== "failed" && rank[patch.phase] < rank[existing.phase]))) {
			throw new ProgrammeControlStateError("conflict", `Lane launch phase cannot move from ${existing.phase} to ${patch.phase}`);
		}
		for (const key of ["checkoutRoot", "worktreePath", "branch", "baseSha", "paneId"] as const) {
			if (existing?.[key] !== undefined && patch[key] !== undefined && existing[key] !== patch[key]) throw new ProgrammeControlStateError("conflict", `Lane launch resource identity ${key} changed for ${ownerRef}`);
		}
		const nextRow: LaneLaunchRecord = { ...existing, ...patch, ownerRef, updatedAt };
		const next: ProgrammeControlRecord = { ...current, laneLaunches: [...rows.filter((row) => row.ownerRef !== ownerRef), nextRow], revision: current.revision + 1, updatedAt };
		return { next, value: nextRow };
	});
	return result.record ?? result.value;
}

export function readReviewVerdict(programmeId: string, taskId: string, context?: ProgrammeControlContext): ReviewVerdict | undefined {
	assertProgrammeId(programmeId);
	const record = readProgrammeSnapshot(programmeId, context);
	return (record.mergeQueue?.reviews ?? []).find((row) => row.taskId === taskId);
}

/** Drop one task's offer and verdict once its head is integrated. */
export function clearTaskOffer(programmeId: string, taskId: string, context?: ProgrammeControlContext): ProgrammeControlRecord {
	assertProgrammeId(programmeId);
	const now = new Date().toISOString();
	const result = casProgrammeControl(programmeId, context, (current): ProgrammeControlPlan<ProgrammeControlRecord> => {
		const queue = current.mergeQueue ?? { offers: [], reviews: [] };
		const offers = queue.offers.filter((row) => row.taskId !== taskId);
		const reviews = queue.reviews.filter((row) => row.taskId !== taskId);
		if (offers.length === queue.offers.length && reviews.length === queue.reviews.length) return { value: current };
		const next: ProgrammeControlRecord = { ...current, mergeQueue: { offers, reviews }, revision: current.revision + 1, updatedAt: now };
		return { next, value: next };
	});
	return result.record ?? result.value;
}

// ─── Watchdog heartbeat and interrupted-claim recovery (plan §7 P4.2) ────────

/**
 * Persist the latest heartbeat for one programme. Read-on-write validated, CAS
 * serialized and bounded to the newest observation. A heartbeat never changes
 * status, generation, claims or reservations, so a late beat cannot resurrect a
 * paused or completed programme; it is recorded for any existing record so a
 * live session cannot look like a missed beat.
 */
export function recordHeartbeat(
	programmeId: string,
	heartbeat: {
		pid: number;
		sessionId: string;
		generation: number;
		idleSince?: string | null;
		contextTokens?: number;
		contextWindow?: number;
		compaction?: CompactionObservation;
		paneId?: string;
		wakeHold?: { reason: string; at: string };
		lastInputAt?: string;
	},
	context?: ProgrammeControlContext,
): ProgrammeControlRecord {
	assertProgrammeId(programmeId);
	const pid = heartbeat?.pid;
	const sessionId = typeof heartbeat?.sessionId === "string" ? heartbeat.sessionId.trim() : "";
	const generation = heartbeat?.generation;
	if (!Number.isInteger(pid) || (pid as number) <= 0) {
		throw invalidInput("recordHeartbeat requires a positive integer pid");
	}
	if (sessionId === "") throw invalidInput("recordHeartbeat requires a non-empty sessionId");
	if (!Number.isInteger(generation) || (generation as number) < 1) {
		throw invalidInput("recordHeartbeat requires a positive integer generation");
	}
	const now = new Date().toISOString();
	const result = casProgrammeControl(programmeId, context, (current): ProgrammeControlPlan<ProgrammeControlRecord> => {
		const next: ProgrammeControlRecord = {
			...current,
			lastHeartbeat: {
				pid: pid as number,
				sessionId,
				generation: generation as number,
				at: now,
				...(heartbeat.idleSince !== undefined ? { idleSince: heartbeat.idleSince } : {}),
				...(heartbeat.contextTokens !== undefined ? { contextTokens: heartbeat.contextTokens } : {}),
				...(heartbeat.contextWindow !== undefined ? { contextWindow: heartbeat.contextWindow } : {}),
				...(heartbeat.compaction !== undefined ? { compaction: heartbeat.compaction } : {}),
				...(heartbeat.paneId !== undefined ? { paneId: heartbeat.paneId } : {}),
				...(heartbeat.wakeHold !== undefined ? { wakeHold: heartbeat.wakeHold } : {}),
				...(heartbeat.lastInputAt !== undefined ? { lastInputAt: heartbeat.lastInputAt } : {}),
			},
			revision: current.revision + 1,
			updatedAt: now,
		};
		return { next, value: next };
	});
	return result.record ?? result.value;
}

// ─── Parent rotation (R1.5, AM4) ─────────────────────────────────────────────

/** Rotation never repeats more often than this, whatever the outcome of the last one. */
export const ROTATION_SPACING_MS = 30 * 60_000;
/** A launched session may take over with its ticket for this long. */
export const ROTATION_TAKEOVER_WINDOW_MS = 10 * 60_000;

const DEFAULT_ROTATION_WAKE_REASON =
	"rotation: a fresh orchestrator will replace this session. Refresh your continuation snapshot and the project checkpoint now, then stop. Do not start new work.";

export type RotationRequestResult =
	| { outcome: "requested" }
	| {
			outcome: "denied";
			reason: "kill-file" | "programme-off" | "programme-paused" | "programme-waiting" | "no-owner" | "not-the-leader" | "in-flight" | "too-soon";
	  };

function rotationInFlight(rotation: RotationState | null): boolean {
	return rotation !== null && (rotation.phase === "checkpoint" || rotation.phase === "launched");
}

/**
 * Start a rotation: record it and queue one `rotation` wake for the leader, in
 * one atomic step. Denied under the kill file, pause, off and waiting, when the
 * caller is not the current leader, while another rotation is in flight, and
 * within 30 minutes of the last one.
 */
export function requestRotation(
	programmeId: string,
	input: { ticket: string; reason: RotationReason; fromSessionId: string; now?: number; wakeReason?: string; brief?: string },
	context?: ProgrammeControlContext,
): RotationRequestResult {
	assertProgrammeId(programmeId);
	if (!nonEmptyString(input?.ticket)) throw invalidInput("requestRotation requires a non-empty ticket");
	if (!oneOf(ROTATION_REASONS, input?.reason)) throw invalidInput(`requestRotation reason must be one of ${ROTATION_REASONS.join(", ")}`);
	if (!nonEmptyString(input?.fromSessionId)) throw invalidInput("requestRotation requires a non-empty fromSessionId");
	if (input.brief !== undefined && (!nonEmptyString(input.brief) || input.brief.length > MAX_ROTATION_BRIEF)) {
		throw invalidInput(`requestRotation brief must be a non-empty string of at most ${MAX_ROTATION_BRIEF} characters`);
	}
	const nowMs = input.now ?? Date.now();
	const now = new Date(nowMs).toISOString();
	const result = casProgrammeControl(programmeId, context, (current): ProgrammeControlPlan<RotationRequestResult> => {
		const deny = (reason: Extract<RotationRequestResult, { outcome: "denied" }>["reason"]): ProgrammeControlPlan<RotationRequestResult> => ({ value: { outcome: "denied", reason } });
		if (killFilePresent(context)) return deny("kill-file");
		if (current.status !== "running") return deny(`programme-${current.status}` as "programme-off" | "programme-paused" | "programme-waiting");
		if (current.owner === null) return deny("no-owner");
		if (current.owner.sessionId !== input.fromSessionId) return deny("not-the-leader");
		const previous = current.rotation ?? null;
		if (rotationInFlight(previous)) return deny("in-flight");
		if (previous !== null && nowMs - Date.parse(previous.requestedAt) < ROTATION_SPACING_MS) return deny("too-soon");
		const rotation: RotationState = {
			ticket: input.ticket,
			phase: "checkpoint",
			reason: input.reason,
			requestedAt: now,
			fromSessionId: input.fromSessionId,
			...(input.brief !== undefined ? { brief: input.brief } : {}),
			// Failures belong to the leader they tried to replace; a different leader starts clean.
			consecutiveFailures: previous !== null && previous.fromSessionId === input.fromSessionId ? previous.consecutiveFailures : 0,
			...(previous?.lastCompleted !== undefined ? { lastCompleted: previous.lastCompleted } : {}),
		};
		const wake: PendingWake = {
			sourceEventId: `rotation/${input.ticket}`,
			kind: "rotation",
			reason: input.wakeReason ?? DEFAULT_ROTATION_WAKE_REASON,
			enqueuedAt: now,
			sessionRef: input.fromSessionId,
		};
		const next: ProgrammeControlRecord = {
			...current,
			rotation,
			pendingWakes: [...current.pendingWakes, wake],
			revision: current.revision + 1,
			updatedAt: now,
		};
		return { next, value: { outcome: "requested" } };
	});
	return result.value;
}

/** Plan a change to the current rotation when it is `ticket` and in one of `phases`; otherwise stale. */
function rotationUpdate<T>(
	programmeId: string,
	ticket: string,
	phases: readonly RotationPhase[],
	context: ProgrammeControlContext | undefined,
	change: (current: ProgrammeControlRecord, rotation: RotationState) => { rotation: RotationState; value: T } | { value: T; rotation?: undefined },
	stale: T,
): T {
	assertProgrammeId(programmeId);
	const result = casProgrammeControl(programmeId, context, (current): ProgrammeControlPlan<T> => {
		const rotation = current.rotation ?? null;
		if (rotation === null || rotation.ticket !== ticket || !phases.includes(rotation.phase)) return { value: stale };
		const changed = change(current, rotation);
		if (changed.rotation === undefined) return { value: changed.value };
		return { next: { ...current, rotation: changed.rotation, revision: current.revision + 1, updatedAt: new Date().toISOString() }, value: changed.value };
	});
	return result.value;
}

/** The leader finished its checkpoint turn. Recorded once; the first time stands. */
export function markRotationCheckpointed(
	programmeId: string,
	ticket: string,
	context?: ProgrammeControlContext,
	nowMs: number = Date.now(),
): { outcome: "recorded" | "already" | "stale" } {
	return rotationUpdate(programmeId, ticket, ["checkpoint"], context, (_current, rotation) =>
		rotation.checkpointedAt !== undefined
			? { value: { outcome: "already" as const } }
			: { rotation: { ...rotation, checkpointedAt: new Date(nowMs).toISOString() }, value: { outcome: "recorded" as const } },
		{ outcome: "stale" as const });
}

export type RotationLaunchResult = { outcome: "launching" } | { outcome: "stale" } | { outcome: "cancelled"; reason: string };

/**
 * Record that the fresh parent is about to be launched. Re-checks the conditions
 * that deny rotation (kill file, pause, off, waiting, a replaced leader) and
 * cancels the rotation instead of launching when one holds.
 */
export function recordRotationLaunch(
	programmeId: string,
	ticket: string,
	context?: ProgrammeControlContext,
	nowMs: number = Date.now(),
): RotationLaunchResult {
	const at = new Date(nowMs).toISOString();
	return rotationUpdate<RotationLaunchResult>(programmeId, ticket, ["checkpoint"], context, (current, rotation) => {
		const cancel = (reason: string): { rotation: RotationState; value: RotationLaunchResult } => ({
			rotation: { ...rotation, phase: "cancelled", finishedAt: at, detail: reason },
			value: { outcome: "cancelled", reason },
		});
		if (killFilePresent(context)) return cancel("kill-file");
		if (current.status !== "running") return cancel(`programme-${current.status}`);
		if (current.owner === null || current.owner.sessionId !== rotation.fromSessionId) return cancel("leader-changed");
		return { rotation: { ...rotation, phase: "launched", launchedAt: at }, value: { outcome: "launching" } };
	}, { outcome: "stale" });
}

/** The rotation was called off: pause, off, the kill file or a replaced leader. Not a failure. */
export function cancelRotation(
	programmeId: string,
	ticket: string,
	reason: string,
	context?: ProgrammeControlContext,
	nowMs: number = Date.now(),
): { outcome: "cancelled" | "stale" } {
	return rotationUpdate(programmeId, ticket, ["checkpoint", "launched"], context, (_current, rotation) => ({
		rotation: { ...rotation, phase: "cancelled", finishedAt: new Date(nowMs).toISOString(), detail: reason },
		value: { outcome: "cancelled" as const },
	}), { outcome: "stale" as const });
}

/** The rotation failed: the launch did not work, or nobody took over in time. */
export function failRotation(
	programmeId: string,
	ticket: string,
	detail: string,
	context?: ProgrammeControlContext,
	nowMs: number = Date.now(),
): { outcome: "failed" | "stale" } {
	return rotationUpdate(programmeId, ticket, ["checkpoint", "launched"], context, (_current, rotation) => ({
		rotation: { ...rotation, phase: "failed", finishedAt: new Date(nowMs).toISOString(), detail, consecutiveFailures: rotation.consecutiveFailures + 1 },
		value: { outcome: "failed" as const },
	}), { outcome: "stale" as const });
}

export type RotationTakeoverCheck =
	| { outcome: "valid" }
	| { outcome: "invalid"; reason: "not-launched" | "wrong-ticket" | "same-session" | "expired" | "not-running" | "kill-file" };

/**
 * May `sessionId` take over with `ticket`? A launched rotation's ticket stands in
 * for the operator-origin check at the fresh session's first orchestration act,
 * once, for another session than the leader being replaced, for 10 minutes. It
 * grants nothing else: ownership still moves through the ordinary attach.
 */
export function claimRotationTakeover(
	programmeId: string,
	ticket: string,
	sessionId: string,
	context?: ProgrammeControlContext,
	nowMs: number = Date.now(),
): RotationTakeoverCheck {
	const record = readProgrammeSnapshot(programmeId, context);
	const rotation = record.rotation ?? null;
	if (rotation === null || rotation.phase !== "launched") return { outcome: "invalid", reason: "not-launched" };
	if (rotation.ticket !== ticket) return { outcome: "invalid", reason: "wrong-ticket" };
	if (rotation.fromSessionId === sessionId) return { outcome: "invalid", reason: "same-session" };
	if (nowMs - Date.parse(rotation.launchedAt ?? rotation.requestedAt) > ROTATION_TAKEOVER_WINDOW_MS) return { outcome: "invalid", reason: "expired" };
	// Pause, off and the kill file stop a takeover that is already launched, not only a rotation not yet launched.
	if (record.status !== "running") return { outcome: "invalid", reason: "not-running" };
	if (killFilePresent(context)) return { outcome: "invalid", reason: "kill-file" };
	return { outcome: "valid" };
}

/** The fresh session took over: the rotation is complete and the ticket is spent. */
export function completeRotation(
	programmeId: string,
	ticket: string,
	toSessionId: string,
	context?: ProgrammeControlContext,
	nowMs: number = Date.now(),
): { outcome: "completed" | "stale" } {
	const at = new Date(nowMs).toISOString();
	return rotationUpdate(programmeId, ticket, ["launched"], context, (_current, rotation) => ({
		rotation: { ...rotation, phase: "completed", finishedAt: at, toSessionId, consecutiveFailures: 0, lastCompleted: { at, reason: rotation.reason } },
		value: { outcome: "completed" as const },
	}), { outcome: "stale" as const });
}

/**
 * Recover a continuation claim that was admitted but never completed — the
 * crash-between-admission-and-delivery gap (plan §7 P4.2).
 *
 * The probe is generation-fenced twice: the requested `generation` must equal
 * the record's current run generation and the open claim's own generation, so a
 * supervisor or a resumed session bound to an older generation can never touch
 * a newer programme. Operator stops win: `off`, `paused` and the kill file
 * return `fenced` and leave the claim in place rather than replaying work past
 * a stop. With `options.sessionRef` only that owner's claim is recoverable.
 * Takeover semantics: when `options.ownerFence` proves the caller is the
 * programme's CURRENT owner, a PREVIOUS owner's claim is recoverable once it is
 * older than the advisory owner lease — the previous session either settles it
 * first (the open-claim probe is then already gone) or crashed, and the wakes
 * must replay for the new owner instead of sticking forever.
 *
 * A successful recovery atomically clears the claim and re-queues the wakes it
 * consumed under stable `recovery/<claimId>/<wakeId>` keys, so the admission
 * owner can admit the same session again with the original reasons. It does not
 * admit, deliver or complete anything by itself, and it never deletes evidence:
 * the claim row is preserved in the returned result.
 */
export function recoverInterruptedClaim(
	programmeId: string,
	generation: number,
	context?: ProgrammeControlContext,
	options?: { sessionRef?: string; ownerFence?: OwnerFence },
): InterruptedClaimRecovery {
	assertProgrammeId(programmeId);
	if (!Number.isInteger(generation) || generation < 1) {
		throw invalidInput("recoverInterruptedClaim requires a positive integer generation");
	}
	const expectSession = typeof options?.sessionRef === "string" ? options.sessionRef.trim() : undefined;
	const store = resolveProgrammeControlStore(context);
	let lastConflict: string | undefined;
	for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
		const current = store.read(programmeId);
		if (current === undefined) return { outcome: "none", reason: "no-record" };
		if (current.runGeneration !== generation) {
			return {
				outcome: "fenced",
				reason: "generation-mismatch",
				generation,
				currentGeneration: current.runGeneration,
			};
		}
		const claim = current.activeClaim;
		if (claim === null) return { outcome: "none", reason: "no-open-claim" };
		if (claim.runGeneration !== generation) {
			return {
				outcome: "fenced",
				reason: "generation-mismatch",
				generation,
				currentGeneration: claim.runGeneration,
				owner: claim.owner,
			};
		}
		if (expectSession !== undefined && claim.sessionRef !== expectSession) {
			// Cross-session recovery only through the ownership fence AND only for a
			// stale claim: a fresh claim belongs to a live previous owner, whose work
			// settles on its own instead of being stolen.
			const staleRecoverable =
				options?.ownerFence !== undefined &&
				ownerFenceSatisfied(current.owner, options.ownerFence) &&
				Date.now() - Date.parse(claim.admittedAt) > PROGRAMME_OWNER_LEASE_MS;
			if (!staleRecoverable) {
				return { outcome: "fenced", reason: "other-owner", generation, owner: claim.owner };
			}
		}
		if (current.status === "off") return { outcome: "fenced", reason: "programme-off", generation, owner: claim.owner };
		if (current.status === "paused") {
			return { outcome: "fenced", reason: "programme-paused", generation, owner: claim.owner };
		}
		if (killFilePresent(context)) return { outcome: "fenced", reason: "kill-file", generation, owner: claim.owner };
		const replays = interruptedClaimReplays(claim);
		const now = new Date().toISOString();
		const next: ProgrammeControlRecord = {
			...current,
			activeClaim: null,
			pendingWakes: mergePendingWakes(current.pendingWakes, replays),
			revision: current.revision + 1,
			updatedAt: now,
		};
		try {
			store.update(programmeId, current.revision, () => next);
			return { outcome: "recovered", generation, claim: cloneJson(claim), replays: cloneJson(replays) };
		} catch (error) {
			if (error instanceof ProgrammeControlStateError && error.code === "conflict") {
				lastConflict = error.message;
				continue;
			}
			throw error;
		}
	}
	throw new ProgrammeControlStateError(
		"conflict",
		`Interrupted-claim recovery contended for ${programmeId}: ${lastConflict ?? "revision conflict"}`,
	);
}

/**
 * Stable replay rows for an interrupted claim. Keys derive from the claim id,
 * so probing the same claim twice is idempotent instead of enqueueing a second
 * continuation. A claim written before P4.2 has only wake IDs; those replay with
 * a reason that names the preserved identity rather than inventing a prompt.
 */
function interruptedClaimReplays(claim: ContinuationClaim): PendingWake[] {
	const now = new Date().toISOString();
	const rows: PendingWake[] =
		Array.isArray(claim.wakes) && claim.wakes.length > 0
			? claim.wakes
			: claim.wakeIds.map((sourceEventId) => ({
					sourceEventId,
					kind: "state-transition" as WakeKind,
					reason: `interrupted continuation wake ${sourceEventId}`,
					enqueuedAt: claim.admittedAt,
				}));
	return rows.map((wake) => ({
		sourceEventId: `recovery/${claim.claimId}/${wake.sourceEventId}`,
		kind: wake.kind,
		reason: wake.reason,
		...(wake.sessionRef !== undefined ? { sessionRef: wake.sessionRef } : {}),
		enqueuedAt: now,
	}));
}

function mergePendingWakes(existing: readonly PendingWake[], replays: readonly PendingWake[]): PendingWake[] {
	const seen = new Set(existing.map((wake) => wake.sourceEventId));
	const merged = existing.map((wake) => cloneJson(wake));
	for (const wake of replays) {
		if (seen.has(wake.sourceEventId)) continue;
		seen.add(wake.sourceEventId);
		merged.push(cloneJson(wake));
	}
	return merged;
}

// ─── Context and helpers ─────────────────────────────────────────────────────

export type ProgrammeControlContext = {
	/** Explicit store (tests, isolated programmes); defaults to the real root. */
	store?: ProgrammeControlStore;
	/** Single kill-file override; defaults to both known kill-file paths. */
	killFilePath?: string;
};

type ProgrammeControlPlan<T> = {
	/** When absent the helper performs no write and returns `value` unchanged. */
	next?: ProgrammeControlRecord;
	value: T;
};

function resolveProgrammeControlStore(context: ProgrammeControlContext | undefined): ProgrammeControlStore {
	// The switch decides the default store (LC5): the files store or the ledger.
	return context?.store ?? programmeControlStore();
}

function casProgrammeControl<T>(
	programmeId: string,
	context: ProgrammeControlContext | undefined,
	plan: (current: ProgrammeControlRecord) => ProgrammeControlPlan<T>,
): { record?: ProgrammeControlRecord; value: T } {
	const store = resolveProgrammeControlStore(context);
	let lastConflict: string | undefined;
	for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
		const current = store.read(programmeId);
		if (current === undefined) {
			throw new ProgrammeControlStateError("missing", `No programme control record for ${programmeId}`);
		}
		const planned = plan(current);
		const next = planned.next;
		if (next === undefined) return { value: planned.value };
		try {
			const record = store.update(programmeId, current.revision, () => next);
			return { record, value: planned.value };
		} catch (error) {
			if (error instanceof ProgrammeControlStateError && error.code === "conflict") {
				lastConflict = error.message;
				continue;
			}
			throw error;
		}
	}
	throw new ProgrammeControlStateError(
		"conflict",
		`Programme control update contended for ${programmeId}: ${lastConflict ?? "revision conflict"}`,
	);
}

function evaluateContinuationAdmission(
	record: ProgrammeControlRecord,
	killPresent: boolean,
): Exclude<ClaimContinuationResult, { outcome: "admitted" }> | { outcome: "admitted" } {
	if (record.status === "off") return { outcome: "denied", reason: "programme-off" };
	if (record.status === "paused") return { outcome: "denied", reason: "programme-paused" };
	if (killPresent) return { outcome: "denied", reason: "kill-file" };
	const blockingDecisions = record.decisionRefs.some((ref) => ref.status === "open" && ref.blocking);
	if (record.status === "waiting") {
		// Waiting is entered only when a run ended `waiting_decision`; an operator
		// apply or resume is the deterministic exit (no agent wake can authorize it).
		return { outcome: "waiting", reasons: [blockingDecisions ? "decision-pending" : "programme-waiting"] };
	}
	const reasons: ContinuationWaitingReason[] = [];
	if (record.activeClaim !== null) reasons.push("claim-active");
	if (blockingDecisions) reasons.push("decision-pending");
	if (record.reservations.length >= record.ceiling) reasons.push("capacity");
	// A leader whose checkpoint is done, or whose replacement is launching, starts no new run:
	// it would be cut in half by the handover. The checkpoint turn itself is admitted before this.
	const rotation = record.rotation ?? null;
	if (rotation !== null && (rotation.phase === "launched" || (rotation.phase === "checkpoint" && rotation.checkpointedAt !== undefined))) reasons.push("rotating");
	if (reasons.length > 0) return { outcome: "waiting", reasons };
	return { outcome: "admitted" };
}

function killFilePresent(context: ProgrammeControlContext | undefined): boolean {
	const paths = context?.killFilePath !== undefined ? [context.killFilePath] : programmeControlKillFilePaths();
	return paths.some((path) => existsSync(path));
}

function statusAfterOutcome(outcome: ContinuationOutcome): ProgrammeControlStatus {
	switch (outcome) {
		case "completed":
			return "off";
		case "paused":
			return "paused";
		case "waiting_decision":
			return "waiting";
		default:
			// progressed / waiting_worker / waiting_check / failed keep the programme
			// enabled; the next relevant event or deterministic reconciliation decides.
			return "running";
	}
}

function newProgrammeControlRecord(
	programmeId: string,
	operatorRef: string,
	ceiling: number,
	now: string,
): ProgrammeControlRecord {
	return {
		schemaVersion: PROGRAMME_CONTROL_SCHEMA_VERSION,
		programmeId,
		revision: 1,
		status: "running",
		runGeneration: 1,
		pauseReason: null,
		enrolledSessions: [],
		owner: null,
		pendingWakes: [],
		activeClaim: null,
		reservations: [],
		reservedPaths: [],
		ceiling,
		decisionRefs: [],
		operatorActions: [
			{ action: "start", operatorRef, at: now, fromStatus: "off", toStatus: "running" },
		],
		lastOutcome: null,
		lastHeartbeat: null,
		retiredAgents: [],
		rotation: null,
		mergeQueue: { offers: [], reviews: [] },
		parentWriteBudgets: [],
		laneLaunches: [],
		createdAt: now,
		updatedAt: now,
	};
}

function restartRecord(current: ProgrammeControlRecord, operatorRef: string, now: string): ProgrammeControlRecord {
	return {
		...current,
		status: "running",
		pauseReason: null,
		revision: current.revision + 1,
		updatedAt: now,
		operatorActions: appendOperatorAction(current, {
			action: "start",
			operatorRef,
			at: now,
			fromStatus: "off",
			toStatus: "running",
		}),
	};
}

function appendOperatorAction(current: ProgrammeControlRecord, action: OperatorAction): OperatorAction[] {
	return [...current.operatorActions, action].slice(-OPERATOR_ACTION_CAP);
}

function operatorRefFrom(value: unknown, functionName: string): string {
	const operator = typeof value === "string" ? value.trim() : "";
	if (operator === "") {
		throw invalidInput(`${functionName} requires a non-empty operatorRef; agents must not self-authorize`);
	}
	return operator;
}

function assertProgrammeId(programmeId: string): void {
	if (typeof programmeId !== "string" || !PROGRAMME_ID_PATTERN.test(programmeId)) {
		throw new ProgrammeControlStateError("io", `invalid programme id: ${String(programmeId)}`);
	}
}

function invalidInput(message: string): ProgrammeControlStateError {
	return new ProgrammeControlStateError("io", message);
}

// ─── Small helpers (mirrors agile.ts conventions) ────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

/** A required non-empty input string, trimmed; throws with the caller's field name. */
function requiredText(value: unknown, field: string): string {
	if (!nonEmptyString(value)) throw invalidInput(`${field} must be a non-empty string`);
	return value.trim();
}

function unknownKeys(value: Record<string, unknown>, known: ReadonlySet<string>): string[] {
	return Object.keys(value).filter((key) => !known.has(key));
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
	return typeof value === "string" && (values as readonly string[]).includes(value);
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Canonical descendant file key: repository-relative POSIX, `./` stripped,
 * duplicate slashes collapsed, no trailing slash, no `..`, no absolute path,
 * no backslashes. Mirrors agile.ts `normalizeArtifactKey`/`isSafeRelativePath`,
 * kept local so this control store stays standalone (no Pi/Agile imports).
 */
function normalizeDescendantPath(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed === "" || trimmed.includes("\\") || trimmed.includes("\0")) return undefined;
	if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) return undefined;
	const segments: string[] = [];
	for (const segment of trimmed.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") return undefined;
		segments.push(segment);
	}
	return segments.length === 0 ? undefined : segments.join("/");
}

/** Same containment rule as agile.ts `artifactKeysOverlap`. */
function descendantPathsOverlap(a: string, b: string): boolean {
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Deterministically first other owner whose files overlap `files`. */
/**
 * Overlap is a conflict only between owners with no declared ancestry: a leaf
 * inside the subtree its own lane reserved is covered by the lane reservation,
 * so overlap with the declared parent (or the parent of the parent chain as
 * recorded) is coexistence, never a conflict. Sibling owners still conflict.
 */
function firstDescendantConflict(
	rows: readonly DescendantReservation[],
	ownerRef: string,
	files: readonly string[],
	parentOwnerRef?: string,
): { ownerRef: string; files: string[] } | undefined {
	const conflicts: { ownerRef: string; files: string[] }[] = [];
	for (const row of rows) {
		if (row.ownerRef === ownerRef) continue;
		if (parentOwnerRef !== undefined && row.ownerRef === parentOwnerRef) continue;
		const shared = files.filter((file) => row.files.some((claimed) => descendantPathsOverlap(claimed, file)));
		if (shared.length > 0) conflicts.push({ ownerRef: row.ownerRef, files: [...new Set(shared)].sort() });
	}
	conflicts.sort((left, right) => left.ownerRef.localeCompare(right.ownerRef));
	return conflicts[0];
}
