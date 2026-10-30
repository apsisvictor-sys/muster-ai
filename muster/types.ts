/**
 * Muster shared types — the seam between the parent-owned wiring (index.ts,
 * concord.ts, binding.ts) and the leaf modules (edit-guard, inbox, reconcile,
 * breaker, herdr). Leaf modules import types from here only; never from each
 * other. The parent owns this file.
 */

// ─── Session binding (plan §5.3) ─────────────────────────────────────────────

export type RepoBinding = {
	/** Short display alias chosen at join time (e.g. "sandbox", "be"). */
	alias: string;
	/** Canonical absolute Git common directory — the logical repository key. */
	repoKey: string;
	/** Primary checkout holding `.concord/` (linked worktrees resolve here). */
	primaryRoot: string;
	/** Explicitly joined checkout roots sharing this repoKey. */
	checkoutRoots: string[];
	/** Learned from Concord at first successful operation (`ws_` + base64url). */
	workspaceId: string;
	/** Stable transport id, e.g. `pi-<20 hex>` or a validated launcher id. */
	agentId: string;
	/** The one task this session edits under (claims file scope against it). */
	currentWriteTaskId?: string;
	/** Supervised task references — pointers only, never cached task authority. */
	supervisedTaskIds: string[];
};

export type SessionBinding = {
	schemaVersion: 1;
	sessionId: string;
	defaultRepo?: string;
	repos: RepoBinding[];
};

// ─── Delivery journal (plan §5.6) ────────────────────────────────────────────

/**
 * What one liveness observation proved about the process a heartbeat recorded
 * (plan §7 P4.2). Only `process-death-proven` may produce a recovery wake;
 * a stale heartbeat alone is never proof.
 */
export type RecoveryObservationKind = "process-death-proven" | "process-alive" | "ambiguous";

export type DeliveryTarget =
	| { kind: "message"; messageId: string }
	| {
			kind: "task-event";
			taskId: string;
			version: number;
			handoffId?: number;
			eventKind: string;
	  }
	| {
			kind: "recovery-observation";
			/** `supervisor-<generation>-<n>`: the fenced wake identity for admission. */
			sourceEventId: string;
			programmeId: string;
			/** Programme run generation the observation was made against. */
			generation: number;
			observation: RecoveryObservationKind;
			/** Process liveness evidence (pid check, timestamps) — never a transcript. */
			evidence: string;
			/**
			 * True only for evidence that may produce a recovery wake
			 * (`process-death-proven` with every operator gate clear). A false row is a
			 * durable operator-facing blocker: it is never pumped as a wake.
			 */
			admitsWake: boolean;
	  }
	| {
			kind: "programme-wake";
			/** Programme whose frontier or watchdog produced this wake. */
			programmeId: string;
			wakeKind: "frontier" | "watchdog" | "rotation";
			/** Idempotent identity of the wake (generation and work fingerprint). */
			sourceEventId: string;
			/** Plain-words reason; the wake is a hint, never authority. */
			reason: string;
	  }
	| {
			kind: "programme-relay";
			/** Programme the bound transport traffic belongs to. */
			programmeId: string;
			/** Envelope kind the bridge classified: `conversation|pause|status`. */
			envelopeKind: "conversation" | "pause" | "status";
			/** Idempotent transport identity (Discord message id). */
			platformMessageId: string;
			/** Verified sender identity from the transport, never from message text. */
			actorId: string;
			/** Raw message body as received (no interpretation). */
			body: string;
	  };

export type DeliveryRecord =
	| {
			type: "pending";
			deliveryKey: string;
			repoKey: string;
			sessionId: string;
			target: DeliveryTarget;
			/** Canonical content snapshot for message targets (retrieved via inspect). */
			payload?: string;
			at: string;
	  }
	| { type: "recorded"; deliveryKey: string; sessionEntryId: string; at: string };

/** Delivery states: Concord pending → transport delivered → recorded in Pi → reply/transition. */

// ─── Wake pump gate (plan §5.7) ──────────────────────────────────────────────

export type WakeGateReason =
	| "old-generation"
	| "binding-left"
	| "global-pause"
	| "kill-file"
	| "env-disabled"
	| "group-paused"
	| "nothing-eligible"
	| "not-idle"
	| "extension-prompt-open"
	| "editor-draft"
	| "batch-in-flight";

export type WakeSendOptions = {
	/** Custom message type used for relay envelopes. */
	customType: string;
	/** Envelope text: sender, repository/task context, peer-information boundary. */
	content: string;
	/** Delivery keys and routing metadata in details. */
	details: Record<string, unknown>;
	/** `steer` interrupts a running turn (handoffs); `followUp` waits for the next one. */
	deliverAs?: "steer" | "followUp";
};

// ─── Breaker (plan §5.8) ─────────────────────────────────────────────────────

/** Group keys: `task:<repoKey>:<taskId>`, `thread:<repoKey>:<rootMessageId>`, `pair:<repoKey>:<sender>-><recipient>`. */
export type GroupKey = string;

export type BreakerGroupState = {
	consecutiveNoProgressRuns: number;
	pausedAt?: string;
	pauseReason?: string;
	/** Fingerprints of substantive content already seen for this group. */
	seenFingerprints?: string[];
};

export type BreakerState = {
	schemaVersion: 1;
	/** Default 20 consecutive no-progress runs; configurable via programme policy. */
	threshold: number;
	groups: Record<string, BreakerGroupState>;
};

// ─── Concord tool surface (plan §5.4) ────────────────────────────────────────

export type MusterToolName =
	| "muster_start"
	| "muster_inspect"
	| "muster_update"
	| "muster_transfer"
	| "muster_finish";

export type MusterToolCall = {
	name: MusterToolName;
	args: Record<string, unknown>;
	/** Optional explicit repo alias routing; stripped before forwarding. */
	musterRepo?: string;
};

// ─── Agile launch intents (plan §6.3) ────────────────────────────────────────

/**
 * Persisted before a governed lane spawns: admission records the intent, the
 * parent verifies the lane's binding/guard handshake before assignment, and an
 * unverified intent expires instead of being retried blindly.
 */
export type LaunchIntent = {
	/** Stable key: programme + task + target agent (or "-"). */
	intentKey: string;
	programmeId: string;
	taskId: string;
	agentId?: string;
	laneKind: "pi" | "native" | "unknown";
	commandHash: string;
	recordedAt: string;
	verifiedAt?: string;
	laneReference?: string;
};

// ─── Journal fold ────────────────────────────────────────────────────────────

export type ContinuationDecisionOutcome = "admitted" | "steered" | "waiting" | "denied" | "deferred" | "unavailable";

/**
 * Observations the metrics read back (R1 item 7). They live in the existing
 * per-session journal, not in a new ledger: parent turn boundaries, each
 * continuation decision with its reason, and each blocked edit with the
 * identities that held the claim.
 */
export type MetricEvent =
	| { event: "run-start" | "run-end" }
	| { event: "continuation"; outcome: ContinuationDecisionOutcome; reason?: string }
	| { event: "edit-block"; repoKey: string; taskIds: string[]; holders: string[] };

/**
 * A metric event as read back: the journal's ISO timestamp parsed to epoch
 * milliseconds, and the session whose journal held it (the journal file is named
 * after the session, so the row itself does not repeat it).
 */
export type MetricRow = MetricEvent & { at: number; session: string };

export type JournalRecord =
	| { type: "binding"; data: SessionBinding; at: string }
	| { type: "delivery"; record: DeliveryRecord; at: string }
	| { type: "breaker"; data: BreakerState; at: string }
	| { type: "launch-intent"; intent: LaunchIntent; at: string }
	| ({ type: "metric"; at: string } & MetricEvent);

export type JournalFold = {
	binding?: SessionBinding;
	deliveries: Map<string, DeliveryRecord>;
	breaker?: BreakerState;
	/** Agile lane launch intents, keyed by intentKey. */
	launchIntents?: Map<string, LaunchIntent>;
	/** True when the final line failed to parse (torn write) — state is still usable. */
	tornTail: boolean;
};

// ─── Observability ───────────────────────────────────────────────────────────

export type DegradationNotice = {
	scope: string;
	reason: string;
	at: string;
};

/** Compact status contract (plan §7): coordination state, not filesystem truth. */
export type MusterStatus = {
	repo?: string;
	task?: string;
	files?: number;
	inboxPending?: number;
	coordinated: boolean;
	degraded: DegradationNotice[];
	pausedGroups: GroupKey[];
	additionalBindings: number;
};
