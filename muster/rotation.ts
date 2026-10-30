/**
 * Automatic parent rotation: the policy (R1.5, AM4).
 *
 * Three stalls in two days came from the parent's own context, and each needed a
 * human restart into a fresh session under the stable project mailbox. This
 * module decides WHEN to replace a project's leader and WHAT the replacement is
 * told. Pure functions only: the control record holds the state
 * (`control.ts`), the tick sequences the steps (`tick.ts`), and the tick
 * script launches the fresh parent through Herdr (`scripts/muster-tick.mts`).
 * Nothing here starts or stops a process.
 */

import type { ProgrammeHeartbeat, RotationReason, RotationState } from "./control.ts";
import { DEFAULT_ROTATE_AT_TOKENS, type RotationSettings } from "./projects.ts";

/** The leader gets this long to refresh its checkpoint before the tick launches anyway. */
export const ROTATION_CHECKPOINT_WAIT_MS = 5 * 60_000;
/** An idle leader is rotated this long after the tick's wake window, if work still waits. */
export const ROTATION_IDLE_EXTRA_MS = 5 * 60_000;
/** A leader that is mid-run is not replaced for this long after its checkpoint: a run that long is the stuck case. */
export const ROTATION_BUSY_CAP_MS = 20 * 60_000;
/** After a completed rotation, an owner that is not the fresh session (the operator took it back) is left alone this long. */
export const ROTATION_RECLAIM_QUIET_MS = 2 * 60 * 60_000;
/** The context threshold never exceeds this share of the model's window, so a small window can still trigger. */
export const ROTATION_WINDOW_SHARE = 0.8;
/** An idle rotation is not repeated this soon after a completed one: it did not help. */
export const ROTATION_REPEAT_IDLE_MS = 2 * 60 * 60_000;
/** After this many failed rotations in a row for one leader, rotation only alerts. */
export const ROTATION_GIVE_UP_FAILURES = 2;

export type RotationTrigger = { reason: RotationReason; detail: string };

/**
 * Why the leader should be replaced now, or undefined. Context size alone is not a
 * reason: self_compact and Pi's own auto-compaction own normal growth, and rotation
 * below their thresholds pre-empted them. A compaction that failed or did not
 * shrink the context is the fallback, and then the leader idle with actionable work
 * after the tick's wake.
 */
export function rotationTrigger(input: {
	heartbeat: ProgrammeHeartbeat;
	settings: RotationSettings | undefined;
	now: number;
	/** The tick's idle window before it enqueues a wake. */
	wakeIdleMs: number;
	/** Called only when the idle reason could apply. */
	workWaiting: () => boolean;
}): RotationTrigger | undefined {
	const { heartbeat, now } = input;
	const configured = input.settings?.rotateAtTokens ?? DEFAULT_ROTATE_AT_TOKENS;
	const threshold = heartbeat.contextWindow === undefined ? configured : Math.min(configured, Math.floor(heartbeat.contextWindow * ROTATION_WINDOW_SHARE));
	const compaction = heartbeat.compaction;
	if (compaction?.outcome === "failed") return { reason: "compaction", detail: "the last compaction failed" };
	if (compaction?.outcome === "completed" && compaction.tokensAfter !== undefined && compaction.tokensAfter >= threshold) {
		return { reason: "compaction", detail: `the last compaction left ${compaction.tokensAfter} tokens, over the ${threshold} threshold` };
	}
	const idleSince = heartbeat.idleSince === undefined || heartbeat.idleSince === null ? undefined : Date.parse(heartbeat.idleSince);
	if (idleSince !== undefined && !Number.isNaN(idleSince) && now - idleSince >= input.wakeIdleMs + ROTATION_IDLE_EXTRA_MS && input.workWaiting()) {
		return { reason: "idle", detail: `idle for ${Math.floor((now - idleSince) / 60_000)} min with work waiting, after the wake` };
	}
	return undefined;
}

/** Holds on a wake that belong to the operator, not to a stuck leader. */
const OPERATOR_HOLDS = new Set(["group-paused", "editor-draft", "extension-prompt-open", "global-pause", "kill-file", "env-disabled"]);
/** Operator input this recent means the operator is driving the session: do not replace it under him. */
export const ROTATION_QUIET_AFTER_INPUT_MS = 10 * 60_000;

/**
 * Why a rotation must wait, or undefined. The leader's own view of why it is idle
 * comes from its heartbeat: a wake held by the no-progress breaker, an editor
 * draft, an open dialog or a pause is the operator's gate, not a stuck leader.
 * A blocking decision, a full lane ceiling and recent operator input also wait
 * for the operator. A hold the pump reports while the session is plainly idle (for
 * example "not-idle") is the stuck case and does not wait.
 */
export function rotationHeld(input: {
	heartbeat: ProgrammeHeartbeat;
	blockingDecisionOpen: boolean;
	reservations: number;
	ceiling: number;
	now: number;
}): string | undefined {
	const { heartbeat, now } = input;
	if (heartbeat.lastInputAt !== undefined && now - Date.parse(heartbeat.lastInputAt) < ROTATION_QUIET_AFTER_INPUT_MS) return "the operator typed in this session in the last 10 minutes";
	if (heartbeat.wakeHold !== undefined && OPERATOR_HOLDS.has(heartbeat.wakeHold.reason)) return `the leader holds its wakes on purpose (${heartbeat.wakeHold.reason})`;
	if (input.blockingDecisionOpen) return "a blocking decision is waiting for the operator";
	if (input.reservations >= input.ceiling) return "every lane slot is in use";
	return undefined;
}

export type RotationPolicy = { allowed: true } | { allowed: false; why: "gave-up" | "did-not-help" | "reclaimed" };

/**
 * Rules that sit on top of the record's own (kill file, pause, one at a time,
 * 30 minutes apart). Failures count against the leader they tried to replace: a
 * different leader starts clean. An idle rotation that was done recently is not
 * repeated, because replacing the leader did not make work move.
 */
export function rotationPolicy(input: { rotation: RotationState | null; ownerSessionId: string; reason: RotationReason; now: number }): RotationPolicy {
	const { rotation } = input;
	if (rotation === null) return { allowed: true };
	// The operator went back to the replaced session on purpose (AM1.3): that is his choice.
	if (rotation.phase === "completed" && rotation.toSessionId !== undefined && rotation.toSessionId !== input.ownerSessionId
		&& input.now - Date.parse(rotation.finishedAt ?? rotation.requestedAt) < ROTATION_RECLAIM_QUIET_MS) {
		return { allowed: false, why: "reclaimed" };
	}
	if (rotation.fromSessionId === input.ownerSessionId && rotation.consecutiveFailures >= ROTATION_GIVE_UP_FAILURES) return { allowed: false, why: "gave-up" };
	if (input.reason === "idle" && rotation.lastCompleted?.reason === "idle" && input.now - Date.parse(rotation.lastCompleted.at) < ROTATION_REPEAT_IDLE_MS) {
		return { allowed: false, why: "did-not-help" };
	}
	return { allowed: true };
}

const REASON_TEXT: Record<RotationReason, string> = {
	context: "its context had grown too large",
	compaction: "a compaction failed or did not shrink its context",
	idle: "it sat idle while work was waiting",
};

/**
 * The fixed brief the fresh parent starts from: read the checkpoint, reconcile
 * Concord and Herdr, continue. A catalogue entry may replace it.
 */
export function resumeBrief(input: { project: string; reason: RotationReason; checkpoint?: string; override?: string }): string {
	if (input.override !== undefined) return input.override;
	const checkpoint = input.checkpoint ?? "the project's checkpoint (its master plan or latest handoff notes)";
	return [
		`You are the fresh orchestrator of ${input.project}. Automatic parent rotation started you because the previous orchestrator's ${REASON_TEXT[input.reason]}. You replace it now; nobody is waiting to hand you anything else.`,
		`1. Join the project with muster_join, checkout "${input.project}". Your first orchestration act takes the project over: the rotation ticket already authorizes it.`,
		`2. Read the checkpoint: ${checkpoint}.`,
		"3. Reconcile it with Concord (muster_inspect) and Herdr (herdr agent list). Running workers keep running. Accept the handoffs addressed to you, then continue the plan.",
		"Never touch a running worker except through its task.",
	].join("\n");
}

export type RotationLaunchPlan = {
	ticket: string;
	programmeId: string;
	project: string;
	/** Herdr agent name for the fresh parent. */
	name: string;
	/**
	 * The pane to split: the leader's own pane, from its heartbeat. Absent for a
	 * leader outside Herdr: the launcher then creates an isolated workspace.
	 */
	paneId?: string;
	cwd: string;
	model?: string;
	thinking?: string;
	/**
	 * Environment for the fresh session: the ticket and the programme, never
	 * CONCORD_AGENT_ID. The brief is not here and is never typed into the pane: the
	 * session reads it from the rotation record and submits it itself, so that its
	 * first run is automatic and the ticket is the only authority it has.
	 */
	env: Record<string, string>;
};

export const ROTATION_TICKET_ENV = "PI_MUSTER_ROTATION";
export const ROTATION_PROGRAMME_ENV = "PI_MUSTER_ROTATION_PROGRAMME";

export function buildLaunchPlan(input: {
	rotation: RotationState;
	programmeId: string;
	project: string;
	checkoutRoot: string;
	settings: RotationSettings | undefined;
	heartbeat: ProgrammeHeartbeat;
}): RotationLaunchPlan {
	const { rotation, settings } = input;
	const paneId = input.heartbeat.paneId;
	return {
		ticket: rotation.ticket,
		programmeId: input.programmeId,
		project: input.project,
		name: `${input.project}-parent-${rotation.ticket.replace(/[^a-zA-Z0-9]/g, "").slice(-6)}`,
		...(paneId !== undefined ? { paneId } : {}),
		cwd: settings?.cwd ?? input.checkoutRoot,
		...(settings?.parentModel !== undefined ? { model: settings.parentModel } : {}),
		...(settings?.parentThinking !== undefined ? { thinking: settings.parentThinking } : {}),
		env: { [ROTATION_TICKET_ENV]: rotation.ticket, [ROTATION_PROGRAMME_ENV]: input.programmeId },
	};
}

/** What the leader is told in the wake that asks it to checkpoint before it is replaced. */
export function checkpointWakeReason(input: { project: string; reason: RotationReason; checkpoint?: string }): string {
	const where = input.checkpoint === undefined ? "the project's checkpoint" : `the project's checkpoint (${input.checkpoint})`;
	return `rotation: a fresh orchestrator will replace this session because ${REASON_TEXT[input.reason]}. Refresh your continuation snapshot and ${where} now, so the fresh one can resume from it, then stop. Do not start new work.`;
}

export function rotationUnavailableAlert(project: string, reason: string): string {
	return `${project}: automatic parent rotation cannot start (${reason}). Nothing was restarted or stopped and the orchestrator was not asked to stop. It will be tried again as soon as the launcher works; you will hear about this at most once a day.`;
}

export function rotationFailedAlert(project: string, detail: string): string {
	return `${project}: automatic parent rotation failed twice in a row (${detail}). It will not try again for this orchestrator. Nothing was restarted or stopped, and the workers are untouched. To replace the orchestrator yourself, run \`pi -r\`, or start pi and say "continue ${project}".`;
}

export function rotationNoHelpAlert(project: string): string {
	return `${project}: the orchestrator was replaced for sitting idle with work waiting, and the new one is idle with work waiting again. Another rotation would not help (rotation did not help), so none is started. Nothing was restarted or stopped. Check the work in Concord and tell the orchestrator what to do next.`;
}
