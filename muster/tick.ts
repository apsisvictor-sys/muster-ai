/**
 * The external tick (R1 item 4): a timer-driven check that keeps a programme
 * from sitting idle and tells the operator when its parent has gone quiet.
 *
 * It reads what the owners already record, the programme control record (status,
 * owner, claim, heartbeat) and Concord (through an injected reader), and does
 * exactly two things:
 *
 * - the parent is idle for at least 3 minutes and work is waiting: enqueue a
 *   `watchdog` wake in the control record. The owner session turns it into a
 *   continuation through the same pump and single-claim admission as every other
 *   wake, so pause, waiting, the kill file and the breaker all still win;
 * - the parent's heartbeat is at least 5 minutes old: send ONE Discord alert for
 *   that outage, with the restart instruction.
 *
 * It never restarts, kills or signals anything. This library has no process
 * capability at all: sending is an injected port, and the script supplies it.
 * A paused, waiting or off project, and the kill file, are operator decisions:
 * the tick neither wakes nor alerts for them.
 *
 * Automatic parent rotation (R1.5, AM4) runs here too: the tick starts it from
 * the leader's heartbeat, waits for the leader's checkpoint, and launches a
 * fresh parent through an injected port (the script fills it with Herdr
 * commands). The policy is in `rotation.ts`, the state in the control record.
 * The tick still starts, stops and signals nothing itself.
 *
 * Damaged state is never silent: a catalogue or control record that cannot be
 * read is returned as an `unreadable` action, because the outage alert is the
 * thing that would otherwise fail first.
 *
 * Charter widened (efficiency blueprint DS3, 2026-10-09): the tick also moves a
 * walled Pi or OpenCode lane off its quota wall, `quotaFallback`. It queues one
 * `muster control <lane> set-model <ref>` for the next unwalled ref of that
 * harness's `laneDefaults` list, or sets one resume timer at the earliest reset
 * when the list is exhausted, and appends one QUOTA WALL event line. Still no
 * worker is started and nothing is restarted: a model switch is a verb the lane
 * applies to itself. Only provider-pool.json's `laneDefaults.<harness>` is walked,
 * so adding a paid ref there stays the operator's call.
 *
 * AR16 (VR24-218) widens it once more: a lane that meets a quota wall on one account of a plan Pi
 * holds twice moves to the other account of that plan before it falls to the next ref. The model never
 * changes, only the account, and the live move sits behind one routing flag (`routing.accountFailover`,
 * off in the shipped file): with the flag off the intended move is recorded in the routing decisions log
 * beside the lane's real one, and the lane keeps the ref chain it had.
 *
 * WAKE1 (Henry via the operator 2026-10-29 03:29) takes the tick out of the seat's wake path. The orchestrator's
 * one wake path is now the `muster-orch-waker` unit (`orch-waker.ts`, `bin/muster-orch-waker.mts`): it
 * blocks on the ledger's event lines and the seat's inbox, delivers through the send owner and proves the
 * seat took a turn. The tick keeps one job for it: restart the unit when systemd says it is down, or when
 * a handoff has waited past `WAKER_HANDOFF_STALE_MS` with no turn from the seat since. The tick's own
 * waiter-guard notice (which asked the seat to re-arm `orch-wait.sh`) and the empty-slot wake to the
 * orchestrator's inbox are gone: a second waker beside the waker is the defect that brief removes.
 *
 * WAKEHEALTH (Henry 2026-10-27 18:56) is about the tick's own voice to Henry. The batched wake flushes
 * queued payloads every pass; a flush that failed twice in a row used to leave one stderr line and
 * nothing else, so a broken `gh` could stop every message to Henry while the tick kept succeeding. The
 * count of consecutive failed flushes lives in the tick's own state file, a flush that answers clears it,
 * and the second in a row - then one an hour while it persists - sends one line to the orchestrator's
 * inbox, a path that does not depend on `gh`. The payloads are the wake owner's and stay queued either way.
 *
 * OL3b (spec §4) gives the tick the repair side of the service contracts. One step, `contractPass`, reads the
 * doctor's published rows and acts on the contract table's own declared answer to a red state: one bounded
 * repair per contract per day, recorded in `state/muster/repairs.json`, never on a unit a live lane holds as a
 * helper scope; then one fully prepared ask, 15 minutes after the repair or at once for a contract that asks,
 * deduped by the contract's `askCode` and withdrawn when the contract is green. A `panel` contract never asks.
 * The two contracts the tick cannot report itself - its own heartbeat and the doctor's result - are the
 * doctor's asks, and the tick leaves them to it. The policy is one module, `health/contract-asks.ts`, so the
 * tick and the doctor cannot answer the same red contract two different ways.
 *
 * SL2 (blueprint WP-SL2) gives the tick the other direction of a spent plan: the seat. When Claude's own window
 * is at or over the headroom (`PAID_HEADROOM_PERCENT`) while a thinking seat is held by a live Claude session,
 * one fully prepared item tells the operator which seat it is, which window it is, when that window resets in Sofia
 * time, and that the seat moves to Pi. It is raised once per crossing, not once per pass: the queue's own
 * duplicate check answers, and a drop under the line withdraws the item so a second crossing raises a second
 * one. Nothing here moves a seat or types a phrase: only the operator moves a seat (VR24-225), and the item only tells
 * him what he may type. The percentage is the usage snapshot's, the holder is `seats.ts`'s, and the ask is
 * `asks.ts`'s, so neither the reading nor the seat is read a second way.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { musterStateDir } from "./binding.ts";

import { TICK_LOCK_FILE, TICK_LOCK_HELD, holdTickLock } from "./tick-lock.ts";
import {
	ProgrammeControlStateError,
	ROTATION_TAKEOVER_WINDOW_MS,
	cancelRotation,
	completeRotation,
	enqueueWake,
	failRotation,
	readProgrammeSnapshot,
	recordRotationLaunch,
	requestRotation,
	type ProgrammeControlContext,
	type ProgrammeControlRecord,
	type ProgrammeHeartbeat,
} from "./control.ts";
import { programmeKillFileActive } from "./control-bridge.ts";
import { isCardGone, type LaneCard } from "./lib/lane-card.ts";
import { contractStep, type ContractOutcome, type DoctorResultRead } from "./health/contract-asks.ts";
import type { SeatHarness, SeatRole } from "./seats.ts";
import type { UsageSnapshot } from "./bin/usage-snapshot.mts";
import {
	PAID_HEADROOM_PERCENT,
	accountWallKey,
	providerAccounts,
	providerOf,
	routeDecisionLine,
	routingDecisionsTarget,
	wallForCandidate,
	wallKey,
	type PoolConfig,
	type RouteDecision,
	type Wall,
} from "../routing/provider-pool.ts";
import { WAKER_UNIT } from "./orch-waker.ts";
import { appendFsyncedLine } from "../core/append-line.ts";
import { redactSensitiveText } from "../core/self-improving-redactor.ts";
import { formatEventLine } from "./lane-report.ts";
import { evaluateActionableWork, frontierReason, type FrontierTask } from "./frontier.ts";
import { GATEWAY_AGENT_ID } from "./gateway/state.ts";
import { type ProgrammeRegistration, type ProjectCatalogue, type ProjectRegistration } from "./projects.ts";
import {
	ROTATION_BUSY_CAP_MS,
	ROTATION_CHECKPOINT_WAIT_MS,
	ROTATION_GIVE_UP_FAILURES,
	buildLaunchPlan,
	checkpointWakeReason,
	rotationFailedAlert,
	rotationNoHelpAlert,
	rotationPolicy,
	rotationUnavailableAlert,
	resumeBrief,
	rotationHeld,
	rotationTrigger,
	type RotationLaunchPlan,
} from "./rotation.ts";
import {
	dispatchPass,
	nextBestStepCandidates,
	nextBestStepText,
	readyItems,
	type DispatchPort,
	type DispatchQueue,
} from "./dispatch.ts";
import { askIsPrepared, readAsks, type AskQueue } from "./asks.ts";

/** The parent must have been idle this long before a wake is enqueued. */
export const TICK_IDLE_MS = 3 * 60_000;
/** A heartbeat this old means the parent is down. */
export const TICK_STALE_MS = 5 * 60_000;

export type TickPorts = {
	now(): number;
	/** The catalogue, undefined when none exists yet; throws when it exists and cannot be read. */
	catalogue(): ProjectCatalogue | undefined;
	/** Control store and kill-file override (tests); defaults to the real ones. */
	control: ProgrammeControlContext;
	/**
	 * Concord tasks for a programme's repository, or undefined when unreadable. This is the roster the
	 * frontier wake reads (handoffs, returned, blocked); it launches nothing since OL2 (VR24-220): the work
	 * items are the queue, and `dispatch` is what starts a lane.
	 */
	readTasks(programme: ProgrammeRegistration): FrontierTask[] | undefined;
	/** Completions from Concord's event log, or undefined when unreadable. */
	completions?(programme: ProgrammeRegistration): { done: number; cursor: number } | undefined;
	/** Which outage (heartbeat timestamp) was last alerted, per programme. */
	alerts: { get(programmeId: string): string | undefined; set(programmeId: string, heartbeatAt: string): void };
	/**
	 * One person-facing alert, through the mailbox owner (Henry's inbox). It is the only way an alert
	 * leaves the tick: no project thread, no Discord channel and no webhook is reachable from this port
	 * (the operator, 2026-10-29 22:24). The key is the mailbox owner's own dedupe, so a repeated pass is one
	 * message to Henry.
	 */
	alert(text: string, key: string): Promise<{ delivered: boolean; error?: string }>;
	/** Launch the fresh parent of a rotation. The script supplies it; without one a rotation fails. */
	launch?(plan: RotationLaunchPlan): Promise<{ launched: boolean; error?: string }>;
	/** Whether a launch can work at all, checked before the leader is asked to stop. Absent means assumed. */
	launchReady?(): Promise<{ ready: boolean; reason?: string }>;
	/**
	 * OL2 (VR24-220, spec §10): the dispatcher's port. `dispatch.ts` decides and stays pure; the script supplies
	 * this, and the work-item store, the switch, the gate, the launcher, the slot count, the lane records and
	 * the asks writer live behind it. `runTick` also runs in-process under a test, so absent means no dispatch
	 * pass at all: no pass can consult the machine's gate or start a process by itself.
	 */
	dispatch?: DispatchPort;
	/**
	 * Concord custody for this project's database (T5): whether a live Concord
	 * MCP holds the file the path names. Absent means the tick cannot see a split,
	 * and says nothing about custody at all.
	 */
	custody?(programme: ProgrammeRegistration): { verdict: string; summary: string } | undefined;
	/**
	 * The decision store as the tick sees it (R4). `open` throws when the file is
	 * malformed, and the tick reports that instead of reading it as "no cards".
	 * `applyDefault` is the store's own deadline policy: the tick passes a card on
	 * only when the store says it is auto-appliable, and a refusal throws.
	 * `armWindow` starts the response window at the delivery the tick confirmed.
	 */
	decisions?:
		| {
				open(programmeId: string): TickDecision[];
				armWindow(programmeId: string, decisionId: string, deliveredAtIso: string): TickDecision;
				applyDefault(programmeId: string, decisionId: string, threadId: string): OperatorDefaultResult;
		  }
		| undefined;
	/**
	 * The metrics line the status line uses, or undefined when it cannot be
	 * computed. The same metrics owner produces it, so a digest and `/muster
	 * status` can never print different numbers for the same window.
	 */
	metrics?(programme: ProgrammeRegistration): Promise<string | undefined> | string | undefined;
	/**
	 * WAKE1: what the orchestrator waker's watchdog needs from the machine. The script supplies it - the
	 * unit's state in systemd, the restart, the seat's turn clock and the waiting handoffs all live
	 * behind it - because `runTick` also runs in-process under a test: absent means no watch, so no pass
	 * can read the machine's unit or restart it by itself.
	 */
	/**
	 * UBEMPTY: what the empty-slot wake reads and how it speaks. The script supplies it - the lane
	 * listing, the seat, the backlog's path and the orchestrator inbox all live behind it - because
	 * `runTick` also runs in-process under a test: absent means no wake, so no pass can read the
	 * machine's lanes or message the orchestrator by itself.
	 */
	/**
	 * OL3's conductor wake reads the machine through this port: the lane rows, the seats and the send
	 * path. The empty-slot wake that once used it is gone (WAKE1); the conductor is its reader now.
	 */
	emptySlot?: EmptySlotPort;
	wakerGuard?: WakerGuardPort;
	/**
	 * WAKEHEALTH: the Henry wake's flush and the orchestrator's inbox. The script supplies it - the wake
	 * owner's queue and the send path all live behind it - because `runTick` also runs in-process under a
	 * test: absent means no flush and no alert, so no pass can touch the queue or message the
	 * orchestrator by itself.
	 */
	henryWake?: HenryWakePort;
	/**
	 * OL3b: the contract repairs and system asks (spec §4). The script supplies the doctor's result file, the
	 * state directory the repair log and the asks store live in, the live lanes' helper scopes and the one
	 * process a declared repair may run; absent means no contract step, so an in-process tick pass under a
	 * test repairs nothing and raises no ask on this machine.
	 */
	contracts?: ContractPassPort;
	/**
	 * SL2: the usage snapshot and the seats, for the seat-move item. The script supplies both - the snapshot is
	 * its owner's read and the seats are the seat owner's - because `runTick` also runs in-process under a test:
	 * absent means no seat item, so no pass can read the machine's snapshot or seat by itself, and no test raises
	 * an ask for the operator by accident.
	 */
	seatMove?: SeatMovePort;
};

/**
 * OL3b: what the contract step needs from the machine. The policy - once a day, the helper-scope guard, the
 * 15-minute ask, dedupe by `askCode`, withdraw on green - is `health/contract-asks.ts`; this port is only the
 * reading and the one command.
 */
export type ContractPassPort = {
	/** The muster state directory: `repairs.json` and the asks store. */
	stateDir(): string;
	/** The doctor's published rows, or why they could not be read. */
	result(): DoctorResultRead;
	/** Units a live lane record registers as a helper scope: never repaired (spec §4 item 2). */
	helperScopeUnits(): readonly string[];
	/** Run one declared repair as an argv; the command comes from the contract table, never from a report. */
	repair(argv: readonly string[]): { ok: boolean; detail: string };
};

/** One open decision card, as the decision owner renders it. */
export type TickDecision = {
	decisionId: string;
	/** The card exactly as the operator reads it. */
	cardText: string;
	/** Recommended option id. */
	recommendation: string;
	/** When the recommendation applies itself, or null when it never does. */
	autoApplyAt: string | null;
	/** The store's verdict: due, reversible, still open. */
	autoAppliable: boolean;
};

/** What applying a default produced, for the message that records it. */
export type OperatorDefaultResult = {
	applied: boolean;
	duplicate: boolean;
	optionId: string;
	actorId: string;
	cardText: string;
};

export type TickConfig = { idleMs?: number; staleMs?: number };

export type TickAction = {
	programmeId: string;
	project: string;
	action:
		| "wake-enqueued"
		| "alert-sent"
		| "alert-failed"
		| "unreadable"
		| "rotation-requested"
		| "rotation-launched"
		| "rotation-completed"
		| "rotation-failed"
		| "rotation-cancelled"
		| "rotation-alert"
		| "dispatched"
		| "dispatch-held"
		| "dispatch-waiting"
		| "dispatch-blocked"
		| "decision-card"
		| "card-failed"
		| "decision-default"
		| "decision-default-refused"
		| "decision-unreadable"
		| "digest"
		| "conductor-wake"
		| "conductor-failed"
		| "waker-restart"
		| "waker-restart-failed"
		| "henry-wake-failed"
		| "henry-wake-alert"
		| "henry-wake-alert-failed"
		| "contract-repaired"
		| "contract-repair-failed"
		| "contract-repair-skipped"
		| "contract-ask"
		| "contract-ask-withdrawn"
		| "contracts-unreadable"
		| "seat-move-ask"
		| "seat-move-ask-withdrawn"
		| "seat-move-unreadable"
		| "none";
	detail: string;
};

function minutes(ms: number): number {
	return Math.floor(ms / 60_000);
}

function alertText(project: string, quietMs: number): string {
	return (
		`${project}: the orchestrator has not reported for ${minutes(quietMs)} min and may be down. Nothing was restarted. ` +
		`To resume it, run \`pi -r\`, open the "${project} orchestrator" session and type "continue" ` +
		`(or start pi anywhere and say "continue ${project}").`
	);
}

/** A rotation of this programme that has not ended. */
function rotationInFlight(record: ProgrammeControlRecord): boolean {
	return record.rotation !== null && record.rotation !== undefined && (record.rotation.phase === "checkpoint" || record.rotation.phase === "launched");
}

/** Send an alert at most once per `key`/`marker` pair. Returns the action to report, or undefined when already sent. */
async function alertOnce(project: ProjectRegistration, programmeId: string, ports: TickPorts, key: string, marker: string, text: string, detail: string): Promise<TickAction | undefined> {
	const base = { programmeId, project: project.name };
	if (ports.alerts.get(`${programmeId}#${key}`) === marker) return undefined;
	const result = await ports.alert(text, `${programmeId}#${key}#${marker}`);
	if (!result.delivered) return { ...base, action: "alert-failed", detail: result.error ?? "the mailbox did not take the alert" };
	ports.alerts.set(`${programmeId}#${key}`, marker);
	return { ...base, action: "rotation-alert", detail };
}

/**
 * Move a rotation that is in flight one step: wait for the leader's checkpoint
 * (at most 5 minutes), then launch the fresh parent, then see it take over. A
 * rotation that fails twice in a row for one leader alerts the operator once.
 */
async function advanceRotation(
	project: ProjectRegistration,
	programme: ProgrammeRegistration,
	record: ProgrammeControlRecord,
	heartbeat: ProgrammeHeartbeat,
	ownerSessionId: string,
	ports: TickPorts,
): Promise<TickAction> {
	const rotation = record.rotation!;
	const base = { programmeId: programme.programmeId, project: project.name };
	const now = ports.now();
	const none = (detail: string): TickAction => ({ ...base, action: "none", detail });
	const failed = async (detail: string): Promise<TickAction> => {
		if (failRotation(programme.programmeId, rotation.ticket, detail, ports.control, now).outcome === "stale") return none("the rotation changed under the tick");
		const after = readProgrammeSnapshot(programme.programmeId, ports.control).rotation;
		if (after !== null && after.consecutiveFailures >= ROTATION_GIVE_UP_FAILURES) {
			await alertOnce(project, programme.programmeId, ports, "rotation-failed", after.ticket, rotationFailedAlert(project.name, detail), detail);
		}
		return { ...base, action: "rotation-failed", detail };
	};

	if (rotation.phase === "checkpoint") {
		if (rotation.checkpointedAt === undefined && now - Date.parse(rotation.requestedAt) < ROTATION_CHECKPOINT_WAIT_MS) {
			return none("waiting for the leader's checkpoint");
		}
		// Never cut a run in half: wait while the leader is mid-run, up to a hard cap.
		if (heartbeat.idleSince === null && now - Date.parse(rotation.requestedAt) < ROTATION_BUSY_CAP_MS) return none("waiting for the leader to finish its run");
		const launching = recordRotationLaunch(programme.programmeId, rotation.ticket, ports.control, now);
		if (launching.outcome === "stale") return none("the rotation changed under the tick");
		if (launching.outcome === "cancelled") return { ...base, action: "rotation-cancelled", detail: launching.reason };
		const plan = buildLaunchPlan({
			rotation,
			programmeId: programme.programmeId,
			project: project.name,
			checkoutRoot: programme.checkoutRoot,
			settings: project.settings?.rotation,
			heartbeat,
		});
		if (ports.launch === undefined) return failed("no launcher is configured for this tick");
		let result: { launched: boolean; error?: string };
		try {
			result = await ports.launch(plan);
		} catch (error) {
			result = { launched: false, error: error instanceof Error ? error.message : String(error) };
		}
		if (!result.launched) return failed(result.error ?? "the launch failed");
		return { ...base, action: "rotation-launched", detail: `fresh parent ${plan.name} launched next to pane ${plan.paneId}` };
	}

	// Launched: the fresh session records its own takeover; this covers one that could not.
	if (ownerSessionId !== rotation.fromSessionId) {
		completeRotation(programme.programmeId, rotation.ticket, ownerSessionId, ports.control, now);
		return { ...base, action: "rotation-completed", detail: `${ownerSessionId} took over` };
	}
	if (now - Date.parse(rotation.launchedAt ?? rotation.requestedAt) > ROTATION_TAKEOVER_WINDOW_MS) {
		return failed("no takeover within 10 minutes of the launch");
	}
	return none("waiting for the fresh parent to take over");
}

/**
 * R4 deadlines: one store policy call per due card. The store decides what is
 * auto-appliable; the tick only carries it out and records it in the thread.
 * A card the store refuses is reported and stays open for a person.
 */
async function applyDueDefaults(
	project: ProjectRegistration,
	programme: ProgrammeRegistration,
	record: ProgrammeControlRecord,
	now: number,
	ports: TickPorts,
): Promise<TickAction | undefined> {
	const base = { programmeId: programme.programmeId, project: project.name };
	if (ports.decisions === undefined) return undefined;
	let cards: TickDecision[];
	try {
		cards = ports.decisions.open(programme.programmeId);
	} catch (error) {
		return { ...base, action: "decision-unreadable", detail: `the decision store could not be read: ${errorMessage(error)}` };
	}
	for (const card of cards) {
		if (!card.autoAppliable) continue;
		// A card answers itself only after the operator has actually received it. The
		// delivery marker is the evidence; a configured channel is not.
		if (ports.alerts.get(`${programme.programmeId}#card#${card.decisionId}`) !== (card.autoApplyAt ?? "none")) continue;
		let outcome: OperatorDefaultResult;
		try {
			outcome = ports.decisions.applyDefault(programme.programmeId, card.decisionId, GATEWAY_AGENT_ID);
		} catch (error) {
			return { ...base, action: "decision-default-refused", detail: `${card.decisionId}: ${errorMessage(error)}` };
		}
		if (outcome.duplicate) {
			return { ...base, action: "decision-default", detail: `${card.decisionId} was already applied as an operator default; nothing changed` };
		}
		const message = [
			`[Muster decision ${card.decisionId} · ${project.name}] Applied the recommendation (${outcome.optionId}) as an operator default.`,
			card.autoApplyAt === null ? undefined : `Its ${card.autoApplyAt} deadline passed with no answer.`,
			"The record says an operator default closed it, not that you did. Ask the parent to change it.",
		].filter((line) => line !== undefined).join("\n");
		const sent = await ports.alert(message, `${programme.programmeId}#card#${card.decisionId}#applied`);
		if (!sent.delivered) {
			return { ...base, action: "card-failed", detail: `${card.decisionId} applied as an operator default, but the thread message failed: ${sent.error ?? "send failed"}` };
		}
		ports.alerts.set(`${programme.programmeId}#card#${card.decisionId}`, card.autoApplyAt ?? "applied");
		return { ...base, action: "decision-default", detail: `${card.decisionId} applied ${outcome.optionId} as an operator default (actor ${outcome.actorId})` };
	}
	return undefined;
}

/**
 * R4 cards: an open card nobody has delivered yet goes to the project's thread,
 * once. The marker is the card's own deadline, so a card whose deadline changed
 * is announced again instead of staying silent forever.
 */
async function deliverDecisionCard(
	project: ProjectRegistration,
	programme: ProgrammeRegistration,
	record: ProgrammeControlRecord,
	now: number,
	ports: TickPorts,
): Promise<TickAction | undefined> {
	const base = { programmeId: programme.programmeId, project: project.name };
	if (ports.decisions === undefined) return undefined;
	let cards: TickDecision[];
	try {
		cards = ports.decisions.open(programme.programmeId);
	} catch (error) {
		return { ...base, action: "decision-unreadable", detail: `the decision store could not be read: ${errorMessage(error)}` };
	}
	const marker = "none";
	for (const card of cards) {
		const key = `${programme.programmeId}#card#${card.decisionId}`;
		if (ports.alerts.get(key) === (card.autoApplyAt ?? marker)) continue;
		// The window starts when the question is asked, not when the record was
		// written, so the deadline the card states is the one the operator is given.
		let armed = card;
		if (card.autoApplyAt !== null && ports.decisions.armWindow !== undefined) {
			try {
				armed = ports.decisions.armWindow(programme.programmeId, card.decisionId, new Date(now).toISOString());
			} catch (error) {
				return { ...base, action: "decision-unreadable", detail: `${card.decisionId}: its response window could not be armed: ${errorMessage(error)}` };
			}
		}
		const sent = await ports.alert(armed.cardText, key);
		if (!sent.delivered) {
			return { ...base, action: "card-failed", detail: `${card.decisionId} was not delivered: ${sent.error ?? "the mailbox did not take it"}` };
		}
		ports.alerts.set(key, armed.autoApplyAt ?? marker);
		return { ...base, action: "decision-card", detail: `${card.decisionId} delivered to Henry's mailbox (recommended ${card.recommendation}${card.autoApplyAt === null ? ", waits for your answer" : `, applies itself at ${armed.autoApplyAt}`})` };
	}
	return undefined;
}

/** Four hours of quiet running is a digest's own milestone (release plan §R4). */
const DIGEST_INTERVAL_MS = 4 * 60 * 60_000;

/**
 * R4 digest: one message per milestone (a task finished) and otherwise one per
 * four hours, with done, running, blocked, the lane counts and the same metrics
 * line the status line prints. The numbers come from the roster the frontier
 * already read, so a digest never reports a task the frontier cannot see.
 */
async function sendDigest(
	project: ProjectRegistration,
	programme: ProgrammeRegistration,
	record: ProgrammeControlRecord,
	readWork: () => ReturnType<typeof evaluateActionableWork> | undefined,
	now: number,
	ports: TickPorts,
): Promise<TickAction | undefined> {
	const base = { programmeId: programme.programmeId, project: project.name };
	const work = readWork();
	if (work === undefined) return undefined;
	const tasks = ports.readTasks(programme);
	if (tasks === undefined) return undefined;
	const count = (...statuses: string[]): number => tasks.filter((task) => statuses.includes(task.status)).length;
	// Completions come from Concord's own event log when the port offers it: the
	// roster the frontier reads drops finished tasks, so counting it can never
	// report one. The cursor is the milestone, not a count that moved.
	const completions = ports.completions?.(programme);
	const done = completions?.done ?? count("complete", "closed");
	const milestone = String(completions?.cursor ?? `roster:${done}`);
	const running = count("active", "handoff_offered", "review_ready");
	const blocked = count("blocked");
	const key = `${programme.programmeId}#digest`;
	const previous = ports.alerts.get(key);
	if (previous === undefined) {
		// First pass after an install or a new state file: record the baseline and
		// stay quiet. A digest is not an announcement that the tick is alive.
		ports.alerts.set(key, `${milestone}@${new Date(now).toISOString()}`);
		return undefined;
	}
	const dueByTime = now - digestSentAt(previous) >= DIGEST_INTERVAL_MS;
	if (digestMarker(previous) === milestone && !dueByTime) return undefined;
	const metrics = await ports.metrics?.(programme);
	const lines = [
		`[${project.name} · digest ${new Date(now).toISOString()}]`,
		`done ${done} · running ${running} · blocked ${blocked} · lanes ${work.liveLanes} live, ${work.freeLanes} free of ${project.settings?.ceiling ?? record.ceiling}`,
		...(work.nextCandidates !== undefined && work.nextCandidates.length > 0 ? [nextBestStepText(work.nextCandidates)] : []),
		...(metrics !== undefined ? [metrics] : []),
	];
	const sent = await ports.alert(lines.join("\n"), key);
	if (!sent.delivered) return { ...base, action: "card-failed", detail: `the digest was not delivered: ${sent.error ?? "the mailbox did not take it"}` };
	ports.alerts.set(key, `${milestone}@${new Date(now).toISOString()}`);
	return { ...base, action: "digest", detail: `done ${done}, running ${running}, blocked ${blocked} · lanes ${work.liveLanes} live of ${project.settings?.ceiling ?? record.ceiling}` };
}

/** The message body of a failed tool result must never vanish into "unknown". */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** `done@at` markers, as stored by `sendDigest`. */
function digestMarker(marker: string): string {
	const at = marker.indexOf("@");
	return at < 0 ? marker : marker.slice(0, at);
}

function digestSentAt(marker: string): number {
	const at = marker.indexOf("@");
	const parsed = Date.parse(at < 0 ? marker : marker.slice(at + 1));
	return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Briefs live under the Muster state directory, one directory per programme, so
 * a brief is never in a watched working tree and never in the repository.
 */
export function briefsDirFor(programmeId: string): string {
	return join(musterStateDir(), "briefs", programmeId);
}

async function tickProgramme(project: ProjectRegistration, programme: ProgrammeRegistration, ports: TickPorts, idleMs: number, staleMs: number): Promise<TickAction> {
	const base = { programmeId: programme.programmeId, project: project.name };
	const none = (detail: string): TickAction => ({ ...base, action: "none", detail });
	let record;
	try {
		record = readProgrammeSnapshot(programme.programmeId, ports.control);
	} catch (error) {
		if (error instanceof ProgrammeControlStateError && error.code === "missing") return none("no control record");
		return { ...base, action: "unreadable", detail: `control record unreadable: ${error instanceof Error ? error.message : String(error)}` };
	}
	const now = ports.now();
	// A rotation in flight is called off, not failed, when the operator pauses or stops
	// the programme or the kill file appears.
	if (rotationInFlight(record) && (record.status !== "running" || programmeKillFileActive(ports.control))) {
		const reason = record.status !== "running" ? `programme-${record.status}` : "kill-file";
		cancelRotation(programme.programmeId, record.rotation!.ticket, reason, ports.control, now);
		return { ...base, action: "rotation-cancelled", detail: reason };
	}
	// Pause, waiting, off and the kill file are operator decisions, not outages.
	if (record.status !== "running") return none(`programme is ${record.status}`);
	if (programmeKillFileActive(ports.control)) return none("kill file present");
	const heartbeat = record.lastHeartbeat;
	const owner = record.owner;
	if (owner === null || heartbeat === null) return none("no live orchestrator recorded");

	if (rotationInFlight(record)) return advanceRotation(project, programme, record, heartbeat, owner.sessionId, ports);

	const quietMs = now - Date.parse(heartbeat.at);
	if (quietMs >= staleMs) {
		if (ports.alerts.get(programme.programmeId) === heartbeat.at) return none("this outage was already alerted");
		const result = await ports.alert(alertText(project.name, quietMs), `${programme.programmeId}#stale#${heartbeat.at}`);
		if (!result.delivered) return { ...base, action: "alert-failed", detail: result.error ?? "the mailbox did not take the alert" };
		ports.alerts.set(programme.programmeId, heartbeat.at);
		return { ...base, action: "alert-sent", detail: `no heartbeat for ${minutes(quietMs)} min` };
	}

	// What is waiting for the parent, read at most once per pass. The project's own lane
	// ceiling applies when it has one, as it does for the frontier in the session.
	let work: ReturnType<typeof evaluateActionableWork> | undefined | null = null;
	const readWork = (): ReturnType<typeof evaluateActionableWork> | undefined => {
		if (work !== null) return work;
		const tasks = ports.readTasks(programme);
		work = tasks === undefined ? undefined : evaluateActionableWork({ tasks, mailbox: programme.parentAgentId, ceiling: project.settings?.ceiling ?? record.ceiling });
		return work;
	};

	// Replace the leader when its own context has become the problem. A heartbeat from
	// a session that no longer owns the project says nothing about the leader.
	const held = rotationHeld({
		heartbeat,
		blockingDecisionOpen: record.decisionRefs.some((ref) => ref.status === "open" && ref.blocking),
		reservations: record.reservations.length,
		ceiling: project.settings?.ceiling ?? record.ceiling,
		now,
	});
	if (heartbeat.sessionId === owner.sessionId && held === undefined) {
		const trigger = rotationTrigger({ heartbeat, settings: project.settings?.rotation, now, wakeIdleMs: idleMs, workWaiting: () => record.activeClaim === null && readWork()?.actionable === true });
		if (trigger !== undefined) {
			const policy = rotationPolicy({ rotation: record.rotation ?? null, ownerSessionId: owner.sessionId, reason: trigger.reason, now });
			if (!policy.allowed) {
				// "gave-up" and "reclaimed" are silent: the first already alerted, the second is the operator's choice.
				if (policy.why === "did-not-help") {
					const alerted = await alertOnce(project, programme.programmeId, ports, "rotation-no-help", record.rotation!.lastCompleted!.at, rotationNoHelpAlert(project.name), "rotation did not help: the replacement is idle with work waiting too");
					if (alerted !== undefined) return alerted;
				}
			} else {
				// Never ask the leader to stop for a rotation that cannot launch.
				const launcher = ports.launchReady === undefined ? { ready: true } : await ports.launchReady();
				if (!launcher.ready) {
					const day = new Date(now).toISOString().slice(0, 10);
					const alerted = await alertOnce(project, programme.programmeId, ports, "rotation-unavailable", day, rotationUnavailableAlert(project.name, launcher.reason ?? "the launcher is not available"), `rotation not started: ${launcher.reason ?? "the launcher is not available"}`);
					if (alerted !== undefined) return alerted;
					return none(`rotation not started: ${launcher.reason ?? "the launcher is not available"}`);
				}
				const requested = requestRotation(
					programme.programmeId,
					{
						ticket: `rot-${randomUUID().slice(0, 8)}`,
						reason: trigger.reason,
						fromSessionId: owner.sessionId,
						now,
						wakeReason: checkpointWakeReason({ project: project.name, reason: trigger.reason, ...(project.settings?.rotation?.checkpoint !== undefined ? { checkpoint: project.settings.rotation.checkpoint } : {}) }),
						brief: resumeBrief({ project: project.name, reason: trigger.reason, ...(project.settings?.rotation?.checkpoint !== undefined ? { checkpoint: project.settings.rotation.checkpoint } : {}), ...(project.settings?.rotation?.resumeBrief !== undefined ? { override: project.settings.rotation.resumeBrief } : {}) }),
					},
					ports.control,
				);
				if (requested.outcome === "requested") return { ...base, action: "rotation-requested", detail: trigger.detail };
			}
		}
	}

	// T5: a live Concord MCP writing an inode the path no longer names. One alert
	// per split, through the alert path that already exists, and never a restart.
	const custody = ports.custody?.(programme);
	if (custody !== undefined && custody.verdict !== "ok") {
		const alerted = await alertOnce(project, programme.programmeId, ports, "concord-custody", custody.summary, custody.summary, `concord custody is ${custody.verdict}`);
		if (alerted !== undefined) return alerted;
	}

	// R4: a card that ran out of time applies its own recommendation here, with no
	// parent turn and no session. Nothing else in the tick may write a decision.
	const defaulted = await applyDueDefaults(project, programme, record, now, ports);
	if (defaulted !== undefined) return defaulted;

	// R4: an open card reaches the thread once, whichever process noticed it.
	const card = await deliverDecisionCard(project, programme, record, now, ports);
	if (card !== undefined) return card;

	// R4: one message per milestone, then every four hours while running.
	const digest = await sendDigest(project, programme, record, readWork, now, ports);
	if (digest !== undefined) return digest;

	// OL2 (VR24-220): starting a lane is no longer a programme pass's business. The work items launch
	// through `dispatchPass`, once per tick, outside any programme (`runTick`), so a paused or rotating
	// programme no longer decides whether the machine's free slots stay idle.

	const idleSince = heartbeat.idleSince === undefined || heartbeat.idleSince === null ? undefined : Date.parse(heartbeat.idleSince);
	const idleLongEnough = idleSince !== undefined && !Number.isNaN(idleSince) && now - idleSince >= idleMs;
	const found = readWork();
	if (found !== undefined && found.actionable && idleLongEnough && record.activeClaim === null && !record.pendingWakes.some((wake) => wake.kind === "watchdog" || wake.kind === "frontier")) {
		const reason = `watchdog: the parent has been idle ${minutes(now - idleSince)} min while work is waiting: ${frontierReason(found)}`;
		enqueueWake(
			programme.programmeId,
			{ sourceEventId: `watchdog/tick-${record.runGeneration}-${found.fingerprint}`, kind: "watchdog", reason, sessionRef: owner.sessionId },
			ports.control,
		);
		return { ...base, action: "wake-enqueued", detail: reason };
	}
	// Nothing here needed the parent.
	if (!idleLongEnough) return none("the parent is busy or only just idle");
	if (record.activeClaim !== null) return none("a continuation is already running");
	if (record.pendingWakes.some((wake) => wake.kind === "watchdog" || wake.kind === "frontier")) return none("a wake is already pending");
	if (found === undefined) return none("Concord could not be read");
	return none("nothing is waiting");
}

// ─── The orchestrator seat's waiter (WAITER-GUARD, Henry 11:11, 2026-10-27) ───

/**
 * The orchestrator seat is the one session a lane event wakes, and only a running waiter wakes it. A
 * seat whose waiter has been missing for longer than this is a programme waiting for nobody, so the
 * watchdog asks Henry to have the seat arm `scripts/orch-wait.sh` again. Nothing here starts, stops or
 * signals anything: the waiter stays the seat's own action, and the manual re-arm rule holds.
 */
export const WAITER_GUARD_AFTER_MS = 10 * 60_000;
/** One notice an hour at most, whatever the pass rate: the mark below is a clock bucket, not a counter. */
export const WAITER_GUARD_KEY_WINDOW_MS = 3_600_000;
/** The `alerts` port's key for that hourly mark, so the tick keeps one dedupe store rather than a second. */
export const WAITER_GUARD_MARK_KEY = "waiter-guard";
/**
 * WGFIX2 (alert 4d123d16, Henry 17:42): when this seat's waiter was first seen missing, in the tick's
 * own state file, so the notice measures the unarmed spell and not the seat's tenure.
 */
export const WAITER_UNARMED_KEY = "waiter-unarmed-since";

/** The unarmed mark's key for one holding: a new holder starts its own spell. */
export function waiterUnarmedMark(epoch: number, sessionId: string): string {
	return `${WAITER_UNARMED_KEY}:${epoch}:${sessionId}`;
}

/** What the watchdog reads from the machine, which only the script can do. */
export type WaiterGuardPort = {
	/** The orchestrator seat as the seat owner describes it; undefined when it was never claimed. */
	seat(): { epoch: number; since: string; sessionId: string; harness: string } | undefined;
	/** Is a live `scripts/orch-wait.sh` armed for the orchestrator? The waiter owner's exact-pid read. */
	armed(): boolean;
	/** One line to Henry through the tick's own reminder path (`tellGrokbot`, the hourly mailbox wake). */
	tell(text: string, key: string): void;
};

/**
 * The notice for this pass, or undefined, and the two mark transitions that make the clock real: the
 * first pass with no armed waiter writes when the unarmed spell started, and a pass with a waiter armed
 * clears it. The notice measures that spell, never the seat's tenure - a seat held for three days with a
 * waiter that fired a minute ago is the normal gap, not an outage (WGFIX2, alert 4d123d16).
 *
 * Every read fails open: a seat, a waiter or a mark that cannot be read is never evidence that the
 * waiter is missing, and a read that fails leaves the mark where it was.
 */
export function orchestratorWaiterNotice(ports: TickPorts): { text: string; key: string; minutes: number } | undefined {
	const guard = ports.waiterGuard;
	if (guard === undefined) return undefined;
	let seat: ReturnType<WaiterGuardPort["seat"]>;
	try {
		seat = guard.seat();
	} catch {
		return undefined;
	}
	if (seat === undefined || seat.epoch === 0) return undefined;
	// The clock is the unarmed mark below, never the holding's own `since`: the seat's age says how long
	// the role has been held, not how long the waiter has been missing (WGFIX2, alert 4d123d16).
	let armed: boolean;
	try {
		armed = guard.armed();
	} catch {
		return undefined;
	}
	const now = ports.now();
	const unarmedKey = waiterUnarmedMark(seat.epoch, seat.sessionId);
	if (armed) {
		// The waiter came back: the next spell starts its own clock.
		if (readTickMark(ports, unarmedKey) !== undefined) writeTickMark(ports, unarmedKey, "");
		return undefined;
	}
	const marked = readTickMark(ports, unarmedKey);
	const unarmedSince = marked === undefined || marked === "" ? Number.NaN : Number(marked);
	if (!Number.isFinite(unarmedSince)) {
		// The first pass that finds no waiter starts the clock; only a later pass can call it an outage.
		writeTickMark(ports, unarmedKey, String(now));
		return undefined;
	}
	const unarmedMs = now - unarmedSince;
	if (!(unarmedMs > WAITER_GUARD_AFTER_MS)) return undefined;
	const unarmed = minutes(unarmedMs);
	return {
		minutes: unarmed,
		text: `Orchestrator seat has no armed waiter for more than ${WAITER_GUARD_AFTER_MS / 60_000} minutes while it holds the seat; ask it to arm orch-wait.sh (${unarmed} minutes, ${seat.harness} session ${seat.sessionId}).`,
		key: `${WAITER_GUARD_MARK_KEY}:${seat.epoch}:${seat.sessionId}:${Math.floor(now / WAITER_GUARD_KEY_WINDOW_MS)}`,
	};
}

/** One pass of the watchdog with its one effect: a line to Henry, once per hour bucket. */
export function orchestratorWaiterGuard(ports: TickPorts): TickAction | undefined {
	const guard = ports.waiterGuard;
	const notice = orchestratorWaiterNotice(ports);
	if (guard === undefined || notice === undefined) return undefined;
	let marked: string | undefined;
	try {
		marked = ports.alerts.get(WAITER_GUARD_MARK_KEY);
	} catch {
		marked = undefined;
	}
	if (marked === notice.key) return undefined;
	try {
		guard.tell(notice.text, notice.key);
	} catch (error) {
		return { programmeId: "-", project: "-", action: "waiter-guard-failed", detail: `${notice.text} (the tell failed: ${error instanceof Error ? error.message : String(error)})` };
	}
	try {
		ports.alerts.set(WAITER_GUARD_MARK_KEY, notice.key);
	} catch {
		// The mark is a rate limit, not the delivery's idempotency (the send's own key does that): an
		// unwritable mark costs one repeat next pass, never a lost notice.
	}
	return { programmeId: "-", project: "-", action: "waiter-guard", detail: notice.text };
}

// ─── The empty-slot wake (UBEMPTY, VR24-215, 2026-10-27) ───

/**
 * Below this many running Pi worker lanes the machine is under-filled, and the orchestrator backlog's
 * ready rows are work nobody launched. The number is the programme's slot target as the brief states
 * it (`< 3`), not a cap: nothing here limits how many lanes may run.
 */
export const EMPTY_SLOT_MIN_LANES = 3;
/** The under-fill must hold this long before it is news: one lane between turns is not an empty machine. */
export const EMPTY_SLOT_IDLE_MS = 15 * 60_000;
/** One wake per distinct ready list per hour; a clock bucket, like the waiter watchdog's, not a counter. */
export const EMPTY_SLOT_REPEAT_MS = 3_600_000;
/** When the machine first fell below the floor, in the tick's own state file. Empty means "not below". */
export const EMPTY_SLOT_BELOW_KEY = "empty-slot:below-since";
/** The list woken most recently and its hour bucket: `<ids>@<bucket>`. */
export const EMPTY_SLOT_WAKE_KEY = "empty-slot:last-wake";

/**
 * What the empty-slot wake reads from the machine, which only the tick script can do. The lane rows are
 * the one lane directory's, the seats are the seat owner's, and the wake leaves on the send path the
 * waiter watchdog already uses - to the orchestrator's inbox instead of Henry's.
 */
export type EmptySlotPort = {
	/** Every lane row (the lane directory's own list); no rows means an empty machine. */
	lanes(): readonly LaneCard[];
	/** The seats' current holders (`readSeat`, both roles). No orchestrator holder means nobody to wake. */
	seats(): readonly SeatHold[];
	/**
	 * The ready rows, from the work-item records (CUTOVER: the records are the queue, the hand table is retired).
	 * The shape is the reader's the wake always had - the codes, or the reason the store could not be read, which
	 * becomes one log line rather than a crashed pass.
	 */
	readyItems(): { ok: true; ready: string[] } | { ok: false; reason: string };
	/** One message to the orchestrator inbox in `wake` mode, through the script's own send path. */
	wake(text: string, key: string): void;
};

/** One seat's holder as the seat owner records it: the role, its lane id when it has one, and its session. */
export type SeatHold = { role: SeatRole; laneId?: string; sessionId: string };

/**
 * The rows that are worker slots: `running` only, never a session the operator started himself and never a seat
 * holder — the orchestrator's own session is a seat, not a slot it should count as filled, whichever harness
 * holds it (a Pi holder's card carries its session id). The slot cap (`routing.slots`, VR24-208) counts every
 * worker lane, so the dispatcher's own fill level is read through this and not through the Pi-only view.
 */
export function runningWorkerLanes(rows: readonly LaneCard[], seats: readonly SeatHold[]): LaneCard[] {
	const heldLanes = new Set(seats.flatMap((seat) => (seat.laneId === undefined ? [] : [seat.laneId])));
	const heldSessions = new Set(seats.map((seat) => seat.sessionId));
	return rows.filter(
		(row) =>
			row.state === "running" &&
			row.origin !== "operator" &&
			!row.laneId.startsWith("operator:") &&
			!heldLanes.has(row.laneId) &&
			!(row.sessionId !== undefined && heldSessions.has(row.sessionId)),
	);
}

/**
 * The rows that are worker slots on this floor. Pi only (a Claude or OpenCode lane is not this floor's
 * business, and Hermes is not the bus's).
 */
export function runningPiWorkerLanes(rows: readonly LaneCard[], seats: readonly SeatHold[]): LaneCard[] {
	return runningWorkerLanes(rows, seats).filter((row) => row.harness === "pi");
}

// ─── The orchestrator waker's watchdog (WAKE1, Henry via the operator 2026-10-29 03:29) ───

/**
 * The seat's one wake path is the `muster-orch-waker` unit (`orch-waker.ts`): it blocks on the ledger's
 * event lines and the orchestrator's inbox, delivers into the seat through the send owner, and proves the
 * seat took a turn. The tick no longer wakes anything itself. It asks systemd one question - is the waker
 * up - and restarts it when it is not, or when a handoff has been waiting longer than this with no turn
 * from the seat since. systemd owns the process (`Restart=always`); this is the one control surface the
 * tick uses, so no waker is ever started twice.
 */
export const WAKER_HANDOFF_STALE_MS = 15 * 60_000;
/** One restart per this window, whatever the pass rate: a failing unit is not restarted every two minutes. */
export const WAKER_RESTART_RATE_MS = 10 * 60_000;
/** The `alerts` port's key for the last restart: the same dedupe store every other mark uses. */
export const WAKER_RESTART_MARK_KEY = "waker:last-restart";

/** What the watchdog reads from the machine, which only the script can do. */
export type WakerGuardPort = {
	/** systemd's own answer for the unit, or `unknown` when systemd cannot be asked. */
	unit(): "active" | "inactive" | "failed" | "unknown";
	/** Restart the unit through systemd. */
	restart(): { ok: boolean; detail: string };
	/** The orchestrator seat's newest turn (epoch ms), from the lane directory's row for the holder. */
	lastTurnAt(): number | undefined;
	/** The handoffs waiting on the orchestrator: every lane whose latest report is unreviewed. */
	waiting(): readonly { laneId: string; kind: string; at: number }[];
};

/**
 * Why this pass restarts the waker, or undefined.
 *
 * Both conditions are the brief's: the unit is not active, or a handoff has waited past the threshold
 * with no orchestrator turn since it landed. A machine that cannot answer (no systemd, an unreadable
 * listing) is never evidence of a stopped waker, so every read fails open.
 */
export function wakerGuardReason(ports: TickPorts): { reason: string; detail: string } | undefined {
	const guard = ports.wakerGuard;
	if (guard === undefined) return undefined;
	let unit: ReturnType<WakerGuardPort["unit"]>;
	try {
		unit = guard.unit();
	} catch {
		return undefined;
	}
	if (unit === "unknown") return undefined;
	if (unit !== "active") return { reason: `the ${WAKER_UNIT} unit is ${unit}`, detail: unit };
	const now = ports.now();
	let waiting: readonly { laneId: string; kind: string; at: number }[];
	let lastTurnAt: number | undefined;
	try {
		waiting = guard.waiting();
		lastTurnAt = guard.lastTurnAt();
	} catch {
		return undefined;
	}
	const stale = waiting.filter((handoff) => now - handoff.at > WAKER_HANDOFF_STALE_MS && (lastTurnAt === undefined || handoff.at > lastTurnAt));
	if (stale.length === 0) return undefined;
	const oldest = stale.reduce((a, b) => (b.at < a.at ? b : a));
	return {
		reason: `${stale.length} handoff(s) waiting more than ${WAKER_HANDOFF_STALE_MS / 60_000} min with no turn from the seat since`,
		detail: `${oldest.laneId} ${oldest.kind} ${minutes(now - oldest.at)} min; the seat's last turn ${lastTurnAt === undefined ? "is unknown" : `was ${minutes(now - lastTurnAt)} min ago`}`,
	};
}

/** One pass of the watchdog with its one effect: a systemd restart, at most once per `WAKER_RESTART_RATE_MS`. */
export function orchestratorWakerGuard(ports: TickPorts): TickAction | undefined {
	const guard = ports.wakerGuard;
	const reason = wakerGuardReason(ports);
	if (guard === undefined || reason === undefined) return undefined;
	const now = ports.now();
	const marked = readTickMark(ports, WAKER_RESTART_MARK_KEY);
	const last = marked === undefined || marked === "" ? Number.NaN : Number(marked);
	if (Number.isFinite(last) && now - last < WAKER_RESTART_RATE_MS) {
		return { programmeId: "-", project: "-", action: "waker-restart", detail: `${reason.reason}; restart held, one went out ${minutes(now - last)} min ago` };
	}
	let result: { ok: boolean; detail: string };
	try {
		result = guard.restart();
	} catch (error) {
		return { programmeId: "-", project: "-", action: "waker-restart-failed", detail: `${reason.reason}: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!result.ok) return { programmeId: "-", project: "-", action: "waker-restart-failed", detail: `${reason.reason}: ${result.detail}` };
	writeTickMark(ports, WAKER_RESTART_MARK_KEY, String(now));
	return { programmeId: "-", project: "-", action: "waker-restart", detail: `${reason.reason} (${reason.detail}); restarted ${WAKER_UNIT}` };
}

/** A tick mark, read and written through the tick's own state file. A mark that cannot be read is absent. */
function readTickMark(ports: TickPorts, key: string): string | undefined {
	try {
		return ports.alerts.get(key);
	} catch {
		return undefined;
	}
}

function writeTickMark(ports: TickPorts, key: string, value: string): void {
	try {
		ports.alerts.set(key, value);
	} catch {
		// The mark is a rate limit, not the delivery's idempotency (the send's own key does that): an
		// unwritable mark costs one repeat next pass, never a lost wake.
	}
}

function emptySlotAction(action: "empty-slot-wake" | "empty-slot-unreadable" | "empty-slot-failed", detail: string): TickAction {
	return { programmeId: "-", project: "-", action, detail };
}

/**
 * The empty-slot wake for this pass, or undefined.
 *
 * The order is the one that reads least: the seats and the lane count first, so a machine at or above the
 * floor never opens the work-item store; then the 15-minute continuous-below clock in the tick's own state
 * file; then the orchestrator's seat; then the ready items; then the mark that makes one distinct list wake
 * once an hour. Every read fails closed into "no wake", except the items, whose failure is content: it is
 * reported with the reason the reader gave.
 */
/** The wake's text: the count, how long, and the ready ids. No brief content, no paths, no instruction. */
export function emptySlotText(running: number, belowMs: number, ready: readonly string[]): string {
	const lanes = running === 1 ? "1 Pi worker lane" : `${running} Pi worker lanes`;
	const rows = ready.length === 1 ? "1 backlog row is ready" : `${ready.length} backlog rows are ready`;
	return `muster-tick: ${lanes} running for ${minutes(belowMs)} minutes (fewer than ${EMPTY_SLOT_MIN_LANES}) and ${rows}: ${ready.join(", ")}. Nothing was launched.`;
}

export function emptySlotWake(ports: TickPorts): TickAction | undefined {
	const slot = ports.emptySlot;
	if (slot === undefined) return undefined;
	// OL2 (spec §11 rule 3, §12 F2): while the dispatcher may launch, A1 owns the work items, so this wake must
	// not also ask the orchestrator to place a lane. With the mode off it speaks exactly as before, and off is
	// the rollback. OL3 carries the progress alert for an item that stays unlaunched.
	if (ports.dispatch !== undefined && ports.dispatch.mode() !== "off") return undefined;
	const now = ports.now();
	let seats: readonly SeatHold[];
	let running: number;
	try {
		seats = slot.seats();
		running = runningPiWorkerLanes(slot.lanes(), seats).length;
	} catch {
		// A seat record or a listing that cannot be read is not evidence of an empty machine: this pass says nothing.
		return undefined;
	}
	const belowSince = readTickMark(ports, EMPTY_SLOT_BELOW_KEY);
	if (running >= EMPTY_SLOT_MIN_LANES) {
		// The floor held: the next spell below it starts its own 15 minutes.
		if (belowSince !== undefined && belowSince !== "") writeTickMark(ports, EMPTY_SLOT_BELOW_KEY, "");
		return undefined;
	}
	const since = belowSince === undefined || belowSince === "" ? Number.NaN : Number(belowSince);
	if (!Number.isFinite(since)) {
		writeTickMark(ports, EMPTY_SLOT_BELOW_KEY, String(now));
		return undefined;
	}
	const belowMs = now - since;
	if (belowMs < EMPTY_SLOT_IDLE_MS) return undefined;
	// No holder on the orchestrator's seat, nobody to wake: the architect's seat alone is not the reader.
	if (!seats.some((seat) => seat.role === "orchestrator")) return undefined;
	const read = slot.readyItems();
	if (!read.ok) return emptySlotAction("empty-slot-unreadable", `no wake: ${read.reason}`);
	if (read.ready.length === 0) return undefined;
	const mark = `${read.ready.join(",")}@${Math.floor(now / EMPTY_SLOT_REPEAT_MS)}`;
	if (readTickMark(ports, EMPTY_SLOT_WAKE_KEY) === mark) return undefined;
	const text = emptySlotText(running, belowMs, read.ready);
	try {
		slot.wake(text, `${EMPTY_SLOT_WAKE_KEY}:${mark}`);
	} catch (error) {
		return emptySlotAction("empty-slot-failed", `${text} (the wake failed: ${error instanceof Error ? error.message : String(error)})`);
	}
	writeTickMark(ports, EMPTY_SLOT_WAKE_KEY, mark);
	return emptySlotAction("empty-slot-wake", text);
}

// ─── A2's wakes (OL3, spec §10, 2026-10-29) ───

/**
 * A review that has waited this long is A2's to triage (spec OL3 item 4). REVIEW READY used to wake the seat
 * itself; under OL3 the loop carries the wait instead, so a review nobody took is the thing that wakes it.
 */
export const REVIEW_AWAITING_MS = 60 * 60_000;
/** The distinct set of things woken about last; an unchanged set is never woken about twice. */
export const CONDUCTOR_WAKE_KEY = "conductor:last-wake";
/** How many rows one wake spells out. A wake is one message in a seat's turn, so it stays bounded. */
export const CONDUCTOR_WAKE_ROWS = 8;

/** One thing A2 must decide, in the words its owner gave it. `key` is stable for as long as the thing is. */
export type ConductorItem = { key: string; line: string };

/**
 * The ready items the dispatcher's pass did not launch, each with the reason it gave (spec OL3 item 1). The
 * queue is `readyItems`' own verdict, handed over rather than recomputed, so the dispatchable predicate has
 * one owner and a wake can never disagree with the pass that stayed its hand.
 */
export function undispatchedItems(queue: DispatchQueue | undefined): ConductorItem[] {
	if (queue === undefined) return [];
	return queue.held.map((row) => ({ key: `held:${row.code}`, line: `${row.code} is ready and not launched: ${row.why}` }));
}

/**
 * The open asks nobody has prepared (spec OL3 items 2 and 3): a free-text ask, or the dispatcher's own ask for
 * an item the gate has held. Both are one unprepared ask, and A2 prepares them for the operator. The prepared state
 * is `asks.ts`'s (`askIsPrepared`), never a second copy of the rule.
 */
export function unpreparedAskItems(queue: AskQueue): ConductorItem[] {
	return queue.asks
		.filter((ask) => (ask.status === "open" || ask.status === "awaiting-operator") && !askIsPrepared(ask))
		.map((ask) => ({ key: `ask:${ask.id}`, line: `prepare ask ${ask.code ?? ask.id}: ${ask.question}` }));
}

/**
 * The lanes whose last report is REVIEW READY and whose review has waited past the hour (spec OL3 item 4). The
 * lane row is the owner of a report's kind, time and commit, so the wait is read there and not from a second
 * record of who is waiting for a review.
 */
export function awaitingReviewItems(rows: readonly LaneCard[], now: number): ConductorItem[] {
	const items: ConductorItem[] = [];
	for (const row of rows) {
		const report = row.lastReport;
		if (report === undefined || report.kind !== "review_ready") continue;
		// A lane that is gone with no process left has nobody to take its review, and its row keeps the last
		// report on purpose (a parked question is not lost with the process). The line would ask the seat to
		// take a review on a lane that was closed and merged hours ago: the row's own state answers whether a
		// lane is still there, and a live idle or running one keeps the line (TICK-STALE-CARDS, 2026-10-29).
		if (row.state === "gone" && row.alive !== true) continue;
		if (report.at === undefined || now - report.at < REVIEW_AWAITING_MS) continue;
		const commit = report.sha ?? report.branch ?? "its branch";
		items.push({
			key: `review:${row.laneId}@${commit}`,
			line: `${row.laneId} reported ${commit} ready for review ${minutes(now - report.at)} minutes ago and nobody has taken it`,
		});
	}
	return items;
}

/** The wake's text: what waits, then the rows, then how many were left out. No brief content, no instruction. */
export function conductorWakeText(items: readonly ConductorItem[], shown = CONDUCTOR_WAKE_ROWS): string {
	const head = items.length === 1 ? "1 thing is waiting on the orchestrator seat" : `${items.length} things are waiting on the orchestrator seat`;
	const rest = items.length > shown ? `\nand ${items.length - shown} more` : "";
	return `muster-tick: ${head}:\n${items.slice(0, shown).map((item) => `- ${item.line}`).join("\n")}${rest}`;
}

function conductorAction(action: "conductor-wake" | "conductor-failed", detail: string): TickAction {
	return { programmeId: "-", project: "-", action, detail };
}

/**
 * A2's wake for this pass, or undefined (spec §10 OL3). One message for the three things the loop can see that
 * need the seat's judgment: the ready items the dispatcher is not launching, with its own reason; the asks
 * nobody has prepared; and a review that has waited past the hour.
 *
 * One message, once per distinct set: the mark holds the set's keys, so a pass repeats nothing and a set that
 * grows wakes again with the new row. The send path is the empty-slot wake's - one wire to the orchestrator's
 * inbox in wake mode - because a second send path would be a second way to reach the same seat. Every read is
 * an owner's: the queue from `readyItems`, the prepared state from `asks.ts`, the reports from the lane rows.
 * Nothing here launches, prepares or answers anything.
 *
 * The events that must not wake the seat are the report owner's to withhold (`REVIEW READY`, `ALREADY DONE`);
 * this pass adds no second filter over them.
 */
export function conductorWake(ports: TickPorts): TickAction | undefined {
	const wire = ports.emptySlot;
	const dispatch = ports.dispatch;
	if (wire === undefined || dispatch === undefined) return undefined;
	const now = ports.now();
	let seats: readonly SeatHold[];
	try {
		seats = wire.seats();
	} catch {
		return undefined;
	}
	// No holder on the seat, nobody to wake: the wake would land in an inbox no session reads.
	if (!seats.some((seat) => seat.role === "orchestrator")) return undefined;
	const items: ConductorItem[] = [];
	try {
		const read = dispatch.items();
		items.push(...undispatchedItems(readyItems({ items: read.items, liveLanes: dispatch.liveLanes(), brief: (path) => dispatch.brief(path) })));
	} catch {
		// An unreadable item store is the dispatch pass's to report. This wake says nothing it cannot see.
	}
	try {
		items.push(...unpreparedAskItems(readAsks(musterStateDir())));
	} catch {
		// The ask store's own reader never throws on content; an unreadable one adds no row here.
	}
	try {
		items.push(...awaitingReviewItems(wire.lanes(), now));
	} catch {
		// A lane listing that cannot be read is not evidence that nobody is waiting for a review.
	}
	const mark = [...new Set(items.map((item) => item.key))].sort().join(",");
	const previous = readTickMark(ports, CONDUCTOR_WAKE_KEY) ?? "";
	if (mark === "") {
		// Everything cleared: the next occurrence is news again.
		if (previous !== "") writeTickMark(ports, CONDUCTOR_WAKE_KEY, "");
		return undefined;
	}
	if (mark === previous) return undefined;
	const text = conductorWakeText(items);
	try {
		wire.wake(text, `${CONDUCTOR_WAKE_KEY}:${mark}`);
	} catch (error) {
		return conductorAction("conductor-failed", `${text} (the wake failed: ${error instanceof Error ? error.message : String(error)})`);
	}
	writeTickMark(ports, CONDUCTOR_WAKE_KEY, mark);
	return conductorAction("conductor-wake", text);
}

// ─── The Henry wake's health (WAKEHEALTH, Henry 2026-10-27 18:56) ───

/**
 * Failed flushes in a row before the orchestrator hears about it. One is the retry the queue exists for:
 * `henry-wake.json` keeps the payload and the next pass opens its issue. Two in a row is the wake path
 * itself being down - the 18:54 tick's `gh issue create failed (exit 1): HTTP 401` - which only a stderr
 * line nobody reads was reporting.
 */
export const HENRY_WAKE_ALERT_AFTER = 2;
/** One alert an hour while the failure persists. A timestamp, not an hour bucket: two alerts are never closer than this. */
export const HENRY_WAKE_REPEAT_MS = 3_600_000;
/** Consecutive failed flushes, in the tick's own state file (`tick-alerts.json`, through `ports.alerts`). */
export const HENRY_WAKE_FAILURES_KEY = "henry-wake:failures";
/** When the last alert went out, in the same file: the rate limit on the alerts while the failure persists. */
export const HENRY_WAKE_ALERT_KEY = "henry-wake:last-alert";
/** The error class's cap in the alert's text: long enough for gh's own words, short enough for one line. */
export const HENRY_WAKE_ERROR_CHARS = 160;

/**
 * What the wake's health reads and how it speaks, which only the tick script can do: the wake owner's
 * flush, and the orchestrator's inbox through the send path the waiter watchdog and the empty-slot wake
 * already use (`tellOrchestrator`). No second store either: the count and the hour are `ports.alerts`.
 */
export type HenryWakePort = {
	/**
	 * The wake owner's flush (`flushGrokbotWake`): true when it opened the issue, false when nothing was
	 * due. A failure throws - `gh`'s own words in the message - and leaves the queue exactly as it was.
	 */
	flush(): Promise<boolean>;
	/** One message to the orchestrator's inbox in `wake` mode. */
	wake(text: string, key: string): void;
};

/**
 * The failure in the alert's words: gh's own class at the front (`gh issue create failed (exit 1): HTTP
 * 401`), secrets redacted through the redactor the wake's title uses, control characters flattened to
 * spaces so it stays one line, and cut at `HENRY_WAKE_ERROR_CHARS`. A token or an environment value in
 * gh's stderr never reaches the inbox or the tick log.
 */
export function henryWakeErrorClass(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	return redactSensitiveText(raw, { preservePaths: true, strictAssignments: true })
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.trim()
		.slice(0, HENRY_WAKE_ERROR_CHARS);
}

/** The alert and the tick log line: how many failures, the class, and that nothing was lost. */
export function henryWakeText(failures: number, errorClass: string): string {
	const times = failures === 1 ? "once" : `${failures} times in a row`;
	return `The Henry wake flush failed ${times}: ${errorClass}. The payloads stay queued and the next flush retries them.`;
}

/**
 * The wake's health for this pass, or undefined when the flush answered.
 *
 * The flush runs here because the queue is the wake owner's (`flushGrokbotWake`): this pass counts its
 * failures and never reads or writes the queue. A failure writes the count and returns its log line; the
 * second in a row, and any later one at least `HENRY_WAKE_REPEAT_MS` after the last alert, sends ONE line
 * to the orchestrator's inbox - a path `gh` cannot take down with it. A flush that answers, with or
 * without an issue to open, clears the count, so a recovered wake raises nothing and the next failure is
 * a first failure again. The alert's own send cannot fail the pass: a refused send is reported and the
 * hour is left unmarked, so the next pass retries it.
 */
export async function henryWakeHealth(ports: TickPorts): Promise<TickAction | undefined> {
	const wake = ports.henryWake;
	if (wake === undefined) return undefined;
	const now = ports.now();
	const marked = readTickMark(ports, HENRY_WAKE_FAILURES_KEY);
	const before = marked === undefined || marked === "" ? 0 : Number(marked);
	const failures = Number.isFinite(before) ? before : 0;
	const action = (name: "henry-wake-failed" | "henry-wake-alert" | "henry-wake-alert-failed", detail: string): TickAction => ({
		programmeId: "-",
		project: "-",
		action: name,
		detail,
	});
	try {
		await wake.flush();
	} catch (error) {
		const count = failures + 1;
		writeTickMark(ports, HENRY_WAKE_FAILURES_KEY, String(count));
		const text = henryWakeText(count, henryWakeErrorClass(error));
		if (count < HENRY_WAKE_ALERT_AFTER) return action("henry-wake-failed", text);
		const lastAt = readTickMark(ports, HENRY_WAKE_ALERT_KEY);
		const since = lastAt === undefined || lastAt === "" ? Number.NaN : Number(lastAt);
		if (Number.isFinite(since) && now - since < HENRY_WAKE_REPEAT_MS) return action("henry-wake-failed", text);
		try {
			wake.wake(text, `${HENRY_WAKE_ALERT_KEY}:${Math.floor(now / HENRY_WAKE_REPEAT_MS)}`);
		} catch (sendError) {
			// Not marked: the hour is a rate limit on alerts that went out, so a failed one is retried at once.
			return action("henry-wake-alert-failed", `${text} (the alert's own send failed: ${henryWakeErrorClass(sendError)})`);
		}
		writeTickMark(ports, HENRY_WAKE_ALERT_KEY, String(now));
		return action("henry-wake-alert", text);
	}
	// The wake path answered: the next failure starts its own count.
	if (failures !== 0) writeTickMark(ports, HENRY_WAKE_FAILURES_KEY, "0");
	return undefined;
}

// ─── SL2: the seat-move item ────────────────────────────────────────────────

/** The ask each seat's item carries, one per seat so the second is never hidden behind the first (WP-SL2 item 1). */
export const SEAT_MOVE_ASK_CODES: Readonly<Record<SeatRole, string>> = {
	orchestrator: "C-CLAUDE-ORCH",
	architect: "C-CLAUDE-ARCH",
};
/** Where a thinking seat goes when Claude runs out: the harness the item names. */
export const SEAT_MOVE_TARGET_HARNESS: SeatHarness = "pi";
/** The snapshot's own row for Claude Code (`muster usage` prints the same id). */
export const CLAUDE_SNAPSHOT_PROVIDER = "claude-code";
/** A snapshot this old is not a reading: the item is not raised and is not withdrawn (WP-SL2 item 4). */
export const SEAT_MOVE_SNAPSHOT_FRESH_MS = 6 * 60 * 60_000;
/** The item's owner: only the operator moves a seat (VR24-225, Authority 4, LD36a). */
export const SEAT_MOVE_OWNER = "the operator (only he moves a seat)";
/** What the item protects, in the blueprint's words (WP-SL2 item 1). */
export const SEAT_MOVE_PURPOSE = "Claude has room for the seat it holds, so a thinking seat moves to Pi before Claude stops answering.";

/** One seat as the item needs it: the role, and the holder's harness and liveness from `seats.ts`. */
export type SeatMoveSeat = { role: SeatRole; holder: { harness: SeatHarness; processAlive: boolean } | null };

/**
 * What the seat-move item needs from the machine. The snapshot is the usage owner's read, the seats are the seat
 * owner's, and the state directory is where `asks.ts` writes; the policy is this module's.
 */
export type SeatMovePort = {
	/** The muster state directory the asks store lives in. */
	stateDir(): string;
	/** The usage snapshot as its one owner reads it; an empty snapshot when there is no file. */
	snapshot(): UsageSnapshot;
	/** Who holds each seat now. */
	seats(): readonly SeatMoveSeat[];
};

/** A window the item can name: the reading, its own length as a name, and when it resets (epoch seconds). */
export type SeatMoveWindow = { name: string; usedPercent: number; resetsAt: number };

/** A window's own name, as the item says it (WP-SL2 item 4: 300 is 5-hour, 10 080 is weekly). */
export function seatMoveWindowName(windowMinutes: number): string {
	if (windowMinutes === 300) return "5-hour";
	if (windowMinutes === 10_080) return "weekly";
	if (windowMinutes === 43_200) return "monthly";
	return `${Math.max(1, Math.round(windowMinutes / 60))}-hour`;
}

/** The reset as the operator reads it: the weekday and the clock in the day he is living in (Europe/Sofia). */
const SEAT_MOVE_RESET_CLOCK = new Intl.DateTimeFormat("en-GB", {
	timeZone: "Europe/Sofia",
	weekday: "long",
	hour: "2-digit",
	minute: "2-digit",
	hour12: false,
});

export function seatMoveResetText(resetsAt: number): string {
	const ms = resetsAt * 1_000;
	if (!Number.isFinite(ms) || ms <= 0) return "the reset the reading names";
	return SEAT_MOVE_RESET_CLOCK.format(new Date(ms));
}

/**
 * What the pass can say about Claude's own window: either it cannot measure it (no snapshot, one from the future,
 * one older than `SEAT_MOVE_SNAPSHOT_FRESH_MS`, a null `quota`, or no Claude row), or it can, and either a window is
 * at or over the headroom or none is. `measured: false` is silence, never green: it neither raises nor withdraws.
 */
export type ClaudeSeatReading = { measured: false } | { measured: true; window: SeatMoveWindow | undefined };

/**
 * The window the item names: the first of Claude's two slots at or over the headroom, in the snapshot's own order
 * (`primary` then `secondary`). Both windows can be over; the first qualifying one is named, never the largest, so
 * the item reads the same on every pass.
 */
export function claudeSeatReading(snapshot: UsageSnapshot | undefined, now: number): ClaudeSeatReading {
	if (snapshot === undefined || !(snapshot.capturedAt > 0)) return { measured: false };
	if (snapshot.capturedAt > now || now - snapshot.capturedAt > SEAT_MOVE_SNAPSHOT_FRESH_MS) return { measured: false };
	const quota = snapshot.providers.find((provider) => provider.provider === CLAUDE_SNAPSHOT_PROVIDER && provider.routed !== false)?.quota;
	if (quota === undefined || quota === null) return { measured: false };
	for (const window of [quota.primary, quota.secondary]) {
		if (window === null || window === undefined) continue;
		if (!(window.usedPercent >= PAID_HEADROOM_PERCENT)) continue;
		return { measured: true, window: { name: seatMoveWindowName(window.windowMinutes), usedPercent: window.usedPercent, resetsAt: window.resetsAt } };
	}
	return { measured: true, window: undefined };
}

/**
 * The item one seat gets (WP-SL2 items 1-2): one line naming the seat, the window and its reset in Sofia time, then
 * the two things the operator may do, with the move first because it is what the row protects. Nothing here is a move.
 */
export function seatMoveAsk(role: SeatRole, window: SeatMoveWindow): { question: string; options: string[]; recommendation: string } {
	const reset = seatMoveResetText(window.resetsAt);
	const harness = SEAT_MOVE_TARGET_HARNESS;
	const options = [
		`Move the ${role} to ${harness} now: open \`pi\` in a terminal and type \`become the ${role}\`.`,
		`Keep it on Claude until the window resets at ${reset}. Claude stops answering in that seat once the window is full.`,
	];
	return {
		question: `${role} is on Claude and Claude's ${window.name} window is at ${Math.round(window.usedPercent)}%, resetting ${reset}. ${SEAT_MOVE_PURPOSE} The seat moves to ${harness}.`,
		options,
		recommendation: options[0]!,
	};
}

/**
 * The ask store, loaded when the pass needs it: `asks.ts` is a large module and one of its dependencies awaits at
 * load time, the same reason `health/contract-asks.ts` loads it late.
 */
type AskStore = typeof import("./asks.ts");
let seatMoveAskStore: AskStore | undefined;
async function askStoreOf(): Promise<AskStore> {
	if (seatMoveAskStore === undefined) seatMoveAskStore = await import("./asks.ts");
	return seatMoveAskStore;
}

function seatMoveAction(action: "seat-move-ask" | "seat-move-ask-withdrawn" | "seat-move-unreadable", detail: string): TickAction {
	return { programmeId: "-", project: "-", action, detail };
}

/**
 * SL2, one pass: raise the seat-move item while a live Claude session holds a seat and Claude's window is at or
 * over the headroom, once per crossing; withdraw it when the seat is no longer on a live Claude session or the
 * window is back under the line. An unmeasurable snapshot raises nothing and withdraws nothing, because silence
 * is honest and a withdrawal is a claim.
 */
export async function seatMovePass(ports: TickPorts): Promise<TickAction[]> {
	const port = ports.seatMove;
	if (port === undefined) return [];
	const now = ports.now();
	let store: AskStore;
	let seats: readonly SeatMoveSeat[];
	let queue: ReturnType<AskStore["readAsks"]>;
	try {
		store = await askStoreOf();
		seats = port.seats();
		queue = store.readAsks(port.stateDir());
	} catch (error) {
		return [seatMoveAction("seat-move-unreadable", `the seat or the ask queue could not be read: ${errorMessage(error)}`)];
	}
	const reading = claudeSeatReading(port.snapshot(), now);
	const stateDir = port.stateDir();
	const at = new Date(now).toISOString();
	const actions: TickAction[] = [];
	for (const seat of seats) {
		const code = SEAT_MOVE_ASK_CODES[seat.role];
		const open = store.findOpenDuplicate(queue, { code });
		const onClaude = seat.holder !== null && seat.holder.harness === "claude" && seat.holder.processAlive;
		if (!onClaude) {
			// The item names a seat that has to move; a seat that is not on a live Claude session has no such ground.
			if (open === undefined) continue;
			actions.push(withdrawSeatMoveAsk(store, stateDir, open.id, `the ${seat.role} seat is no longer on a live Claude session`, at));
			continue;
		}
		// A snapshot the pass cannot measure says nothing: no raise, and no withdrawal it cannot justify either.
		if (!reading.measured) continue;
		if (reading.window === undefined) {
			// A reading under the line: the ground for the item is gone, so it goes with it.
			if (open === undefined) continue;
			actions.push(withdrawSeatMoveAsk(store, stateDir, open.id, `Claude's window is back under ${PAID_HEADROOM_PERCENT}%`, at));
			continue;
		}
		if (open !== undefined) continue;
		const content = seatMoveAsk(seat.role, reading.window);
		try {
			const ask = store.raiseAsk(stateDir, {
				by: "desk",
				kind: "operator-action",
				question: content.question,
				code,
				owner: SEAT_MOVE_OWNER,
				source: `seat-move:${seat.role}`,
				at,
			});
			store.prepareAsk(stateDir, { by: "desk", ref: ask.id, options: content.options, recommendation: content.recommendation, at });
			actions.push(seatMoveAction("seat-move-ask", `${ask.id} raised for the ${seat.role}: ${content.question}`));
		} catch (error) {
			actions.push(seatMoveAction("seat-move-unreadable", `the item for the ${seat.role} could not be raised: ${errorMessage(error)}`));
		}
	}
	return actions;
}

function withdrawSeatMoveAsk(store: AskStore, stateDir: string, ref: string, reason: string, at: string): TickAction {
	try {
		store.withdrawAsk(stateDir, { by: "desk", ref, reason, at });
		return seatMoveAction("seat-move-ask-withdrawn", `${ref} withdrawn: ${reason}`);
	} catch (error) {
		return seatMoveAction("seat-move-unreadable", `ask ${ref} could not be withdrawn: ${errorMessage(error)}`);
	}
}

/**
 * OL3b (spec §4): what a red contract causes. The policy is `health/contract-asks.ts` - the declared repair
 * once per contract per day, never on a live lane's helper scope, the prepared ask 15 minutes after the repair
 * or at once for a contract that asks, one ask per `askCode`, withdrawn when the contract is green, and
 * nothing at all for a panel contract. This step only carries the outcomes into the pass's own lines.
 */
export async function contractPass(ports: TickPorts): Promise<TickAction[]> {
	const contract = ports.contracts;
	if (contract === undefined) return [];
	const action: Record<ContractOutcome["action"], TickAction["action"]> = {
		repaired: "contract-repaired",
		"repair-failed": "contract-repair-failed",
		"repair-skipped": "contract-repair-skipped",
		"ask-raised": "contract-ask",
		"ask-withdrawn": "contract-ask-withdrawn",
		unreadable: "contracts-unreadable",
	};
	let outcomes: ContractOutcome[];
	try {
		outcomes = await contractStep({
			writer: "tick",
			stateDir: contract.stateDir(),
			now: ports.now(),
			rows: contract.result().rows,
			helperScopeUnits: contract.helperScopeUnits(),
			repair: contract.repair,
		});
	} catch (error) {
		return [{ programmeId: "-", project: "-", action: "contracts-unreadable", detail: `the contract step failed: ${error instanceof Error ? error.message : String(error)}` }];
	}
	return outcomes.map((outcome) => ({ programmeId: "-", project: "-", action: action[outcome.action], detail: outcome.detail }));
}

/** One pass over every registered programme. Never throws for one programme's failure. */
export async function runTick(ports: TickPorts, config: TickConfig = {}): Promise<TickAction[]> {
	const actions: TickAction[] = [];
	// The seat's waker is not a programme's business: one check a pass, whatever the catalogue holds.
	const guard = orchestratorWakerGuard(ports);
	if (guard !== undefined) actions.push(guard);
	// OL3b: and neither is a red contract: the repairs and the system asks are the machine's, not a programme's.
	actions.push(...(await contractPass(ports)));
	// SL2: nor is a seat on Claude while Claude's window is spent. One item per crossing, never a move.
	actions.push(...(await seatMovePass(ports)));
	// OL2 (VR24-220): A1 is the machine's too. Once per pass, outside every programme, the dispatcher starts at
	// most one lane for the next dispatchable work item, so a paused or rotating programme cannot keep a free
	// slot idle. `dispatch.ts` decides; the port the script supplies is where the gate and the launcher live.
	if (ports.dispatch !== undefined) {
		const outcome = await dispatchPass(ports.dispatch);
		if (outcome !== undefined) actions.push({ programmeId: "-", project: "-", action: outcome.action, detail: outcome.detail });
	}
	// OL3 (spec §10): A2's wakes are the machine's too - the ready items nothing launched, the asks nobody has
	// prepared and a review past the hour. After the dispatch pass, because its queue is what the wake names.
	const conductor = conductorWake(ports);
	if (conductor !== undefined) actions.push(conductor);
	let catalogue;
	try {
		catalogue = ports.catalogue();
	} catch (error) {
		return [...actions, { programmeId: "-", project: "-", action: "unreadable", detail: `catalogue unreadable: ${error instanceof Error ? error.message : String(error)}` }];
	}
	if (catalogue === undefined) return actions;
	const idleMs = config.idleMs ?? TICK_IDLE_MS;
	const staleMs = config.staleMs ?? TICK_STALE_MS;
	for (const project of catalogue.projects) {
		for (const programme of project.programmes) {
			try {
				actions.push(await tickProgramme(project, programme, ports, idleMs, staleMs));
			} catch (error) {
				actions.push({ programmeId: programme.programmeId, project: project.name, action: "none", detail: `tick failed: ${error instanceof Error ? error.message : String(error)}` });
			}
		}
	}
	return actions;
}

/** What the resume timer says to a lane that waited out its wall. */
export const QUOTA_RESUME_TEXT = "Continue where you stopped.";

export type QuotaFallbackAction =
	| { kind: "switch"; lane: string; ref: string; event: string; accountSwitch?: AccountSwitch }
	| { kind: "switch-account"; lane: string; ref: string; account: string; walledAccount: string; event: string; fallbackRef?: string }
	| { kind: "resume-timer"; lane: string; at: number; event: string; accountSwitch?: AccountSwitch }
	| { kind: "notify"; lane: string; event: string; accountSwitch?: AccountSwitch };

/**
 * One account failover (AR16): the same model on another account of the same plan. The model never
 * changes, only the account does, so the lane's work and its rules stay what they were.
 */
export interface AccountSwitch {
	/** The model the lane keeps. */
	ref: string;
	/** The account the lane would move to. */
	account: string;
	/** The account the lane is on, the one that met the wall. */
	walledAccount: string;
}

function isoSeconds(at: number): string {
	return `${new Date(at).toISOString().slice(0, 19)}Z`;
}

/** The ordered refs a harness may be moved through: `laneDefaults.<harness>`, nothing else. */
function harnessCandidates(pool: PoolConfig, harness: string): string[] | undefined {
	const defaults = pool.laneDefaults;
	if (defaults === undefined) return undefined;
	if (harness === "pi") return defaults.pi.candidates;
	if (harness === "opencode") return defaults.opencode;
	return undefined;
}

/**
 * The account a walled lane would move to (AR16): the same model on another account of the same plan,
 * when that account is free.
 *
 * The account list is the inventory's own (A-2/UD11), every account's wall is read through
 * `wallForCandidate` (the one wall lookup), and the model never changes: only the account moves. The
 * ref must be one the harness's own candidate list allows, so a lane is never moved onto a model its
 * rule does not carry (VR24-218: no GLM or Go implementation lane).
 *
 * The card carries no account (AR14's follow-up), so the walled account is read from the walls
 * themselves: exactly one walled account is the lane's own account, and the free one takes it.
 */
function accountFailoverTarget(
	card: LaneCard,
	pool: PoolConfig,
	walls: Readonly<Record<string, Wall>>,
	refs: readonly string[],
	now: number,
): AccountSwitch | undefined {
	const model = card.model;
	if (model === null || !refs.includes(model)) return undefined;
	const accounts = providerAccounts(providerOf(model));
	if (accounts.length < 2) return undefined;
	const walled = (label: string): boolean => {
		const found = wallForCandidate(pool, walls, { ref: model, account: label });
		return found !== undefined && found.until > now;
	};
	const blocked = accounts.filter((account) => walled(account.label));
	const free = accounts.filter((account) => !walled(account.label));
	// One walled account and one free account: the lane met the wall on one and the other can take it.
	// Two walled accounts, or none, mean the wall is not one account's alone.
	if (blocked.length !== 1 || free.length === 0) return undefined;
	return { ref: model, account: free[0].label, walledAccount: blocked[0].label };
}

/**
 * The actions a walled Pi or OpenCode lane needs (DS3). Pure: cards, the pool, the
 * walls in force and the clock in; a list of actions out, so it is tested without ports.
 *
 * A lane is acted on once per wall: `wall.handledAt` on its card marks it. A card the
 * heartbeat no longer refreshes is skipped, because nothing would apply the switch.
 * The next ref is the list's first ref this process can use, read from the list head in
 * the owner's order, and it skips the current model and every ref whose wall lifts later
 * than `now`. OpenCode
 * refs are free and wall alone or with their provider (the rule `resolveLaneModel` uses);
 * a Pi ref walls by `wallKey`.
 */
export function quotaFallback(cards: readonly LaneCard[], pool: PoolConfig, walls: Readonly<Record<string, Wall>>, now: number): QuotaFallbackAction[] {
	const actions: QuotaFallbackAction[] = [];
	for (const card of cards) {
		if (card.state !== "quota-walled" || card.wall === null || card.wall.handledAt !== undefined) continue;
		if (card.harness !== "pi" && card.harness !== "opencode") continue;
		if (isCardGone(card.updatedAt, now)) continue;
		const lane = card.laneId;
		const old = card.model ?? "its model";
		const until = card.wall.resetAt === undefined ? "an unknown time" : isoSeconds(card.wall.resetAt);
		const head = `${old} walled until ${until}`;
		const refs = harnessCandidates(pool, card.harness);
		if (refs === undefined || refs.length === 0) {
			actions.push({ kind: "notify", lane, event: formatEventLine("QUOTA WALL", lane, `${head}; no ${card.harness} candidates in provider-pool.json laneDefaults`) });
			continue;
		}
		const wallOf = (ref: string): Wall | undefined => {
			// An OpenCode ref walls alone (its own key) or with its provider; a Pi ref by `wallKey`.
			// Each key carries this process's account when the provider is split (SK4, SK-D7).
			const keys = card.harness === "opencode" ? [accountWallKey(pool, ref), accountWallKey(pool, providerOf(ref))] : [wallKey(pool, ref)];
			return keys.map((key) => walls[key]).find((wall) => wall !== undefined && wall.until > now);
		};
		// The list is the owner's preference order ("the ordered candidates to try wherever there is
		// usage"), so the move is its first ref this process can use: the walk starts at the head and
		// never at the lane's own place in the list. Rotating forward from a mid-list lane descends
		// onto the refs the owner ranked last — S14 put the three OpenCode Go flash refs after z.ai,
		// so rotating from z.ai moved a walled Pi lane to opencode-go/deepseek-v4.1-flash while
		// Command Code, the head, was free (VR24-215 keeps Pi lanes on DeepSeek and MiniMax).
		const next = refs.find((ref) => ref !== card.model && wallOf(ref) === undefined);
		// AR16: the account failover comes before the ref chain. The lane moves to the other account of
		// its plan when that account is free; the model never changes.
		const failover = accountFailoverTarget(card, pool, walls, refs, now);
		if (failover !== undefined && pool.routing?.accountFailover === "on") {
			actions.push({
				kind: "switch-account",
				lane,
				ref: failover.ref,
				account: failover.account,
				walledAccount: failover.walledAccount,
				event: formatEventLine("QUOTA WALL", lane, `${head}; switched to ${failover.account}`),
				...(next === undefined ? {} : { fallbackRef: next }),
			});
			continue;
		}
		// The flag is off: the intended move is recorded beside the lane's real one, and the lane keeps
		// the ref chain it had (AR14's shadow posture: recorded, not applied).
		const intended = failover === undefined ? "" : `; intended switch to ${failover.account} recorded`;
		if (next !== undefined) {
			actions.push({
				kind: "switch",
				lane,
				ref: next,
				event: formatEventLine("QUOTA WALL", lane, failover === undefined ? `${head}; switched to ${next}` : `${head}${intended}, switched to ${next}`),
				...(failover === undefined ? {} : { accountSwitch: failover }),
			});
			continue;
		}
		// Pool exhausted. A cooldown is a guess, not a reset, so only a time a provider or the file named counts.
		const known = [card.wall.resetAt, ...refs.map((ref) => wallOf(ref)).map((wall) => (wall !== undefined && wall.source !== "cooldown" ? wall.until : undefined))]
			.filter((at): at is number => at !== undefined && at > now);
		if (known.length === 0) {
			actions.push({
				kind: "notify",
				lane,
				event: formatEventLine("QUOTA WALL", lane, `${head}${intended}; pool exhausted, no reset time known`),
				...(failover === undefined ? {} : { accountSwitch: failover }),
			});
			continue;
		}
		const at = Math.min(...known);
		actions.push({
			kind: "resume-timer",
			lane,
			at,
			event: formatEventLine("QUOTA WALL", lane, `${head}${intended}; pool exhausted, resume timer at ${isoSeconds(at)}`),
			...(failover === undefined ? {} : { accountSwitch: failover }),
		});
	}
	return actions;
}

export type QuotaFallbackPorts = {
	/** Queue `muster control <lane> set-model <ref>`. */
	setModel(lane: string, ref: string): { ok: boolean; error?: string };
	/**
	 * Move the lane to another account of the same plan (AR16). Optional: a lane's account is fixed at
	 * launch, so this port is the launcher's own verb. A tick without it names the refusal in the event
	 * line and falls back to the ref chain, so a walled lane is never left without a next step.
	 */
	setAccount?(lane: string, ref: string, account: string): { ok: boolean; error?: string };
	/** `scheduleLaneResume`, the one owner of resume timers. */
	scheduleResume(lane: string, at: Date, text: string): { unit: string } | { error: string };
	/** Append one line to the orchestrator's events file (`appendOrchestratorEvent`). */
	event(line: string): void;
	/** Write `wall.handledAt` onto the lane's card. */
	markHandled(lane: string, at: number): void;
	now(): number;
};

/**
 * Carry out the actions: the effect, then the event line, then the mark. A failed
 * effect is named in the event and the wall is still marked, so one refusal reports
 * once per wall and is not retried every tick. The orchestrator decides after that.
 */
export function applyQuotaFallback(actions: readonly QuotaFallbackAction[], ports: QuotaFallbackPorts): Array<{ lane: string; action: QuotaFallbackAction["kind"]; detail: string }> {
	return actions.map((action) => {
		let event = action.event;
		// Whether the account switch itself was applied: the chain's own switch never counts as one.
		let accountApplied = false;
		if (action.kind === "switch") {
			const queued = ports.setModel(action.lane, action.ref);
			if (!queued.ok) event = event.replace(`switched to ${action.ref}`, `switch to ${action.ref} failed: ${queued.error ?? "no reason given"}`);
		} else if (action.kind === "switch-account") {
			const setter = ports.setAccount;
			if (setter === undefined) {
				// No account verb: the lane keeps the ref chain it would have had.
				event = event.replace(`switched to ${action.account}`, `switch to ${action.account} was not applied (this tick has no account verb)`);
				if (action.fallbackRef !== undefined) {
					const queued = ports.setModel(action.lane, action.fallbackRef);
					event = queued.ok ? `${event}; switched to ${action.fallbackRef} instead` : `${event}; the switch to ${action.fallbackRef} failed: ${queued.error ?? "no reason given"}`;
				}
			} else {
				const queued = setter(action.lane, action.ref, action.account);
				accountApplied = queued.ok;
				if (!queued.ok) event = event.replace(`switched to ${action.account}`, `switch to ${action.account} failed: ${queued.error ?? "no reason given"}`);
			}
		} else if (action.kind === "resume-timer") {
			const timer = ports.scheduleResume(action.lane, new Date(action.at), QUOTA_RESUME_TEXT);
			if ("error" in timer) event = event.replace(/resume timer at (\S+)/, `resume timer at $1 failed: ${timer.error}`);
		}
		// The routing decision line: the intended account switch beside the lane's real one (AR16).
		const target = accountSwitchOf(action);
		if (target !== undefined) {
			const failure = writeAccountDecision(action, target, accountApplied, ports.now());
			if (failure !== undefined) event = `${event}; the account switch was not recorded: ${failure}`;
		}
		ports.event(event);
		ports.markHandled(action.lane, ports.now());
		return { lane: action.lane, action: action.kind, detail: event };
	});
}

/** The account switch an action carries, if it carries one. */
function accountSwitchOf(action: QuotaFallbackAction): AccountSwitch | undefined {
	if (action.kind === "switch-account") return { ref: action.ref, account: action.account, walledAccount: action.walledAccount };
	return action.accountSwitch;
}

/**
 * The routing decision line for an account failover: the intended move beside the lane's real one
 * (AR14's shadow posture — recorded, not applied). The shape and the path are the routing log's own
 * (`routeDecisionLine`, `routingDecisionsTarget`) and the append is the one append body, so the log
 * is written here no other way than through its owner. A failure is named, never swallowed.
 */
function writeAccountDecision(action: QuotaFallbackAction, target: AccountSwitch, applied: boolean, now: number): string | undefined {
	try {
		const entry: RouteDecision = {
			at: now,
			lane: action.lane,
			chosen: target.ref,
			by: "failover",
			account: target.account,
			laneAccount: target.walledAccount,
			...(applied ? {} : { shadow: true }),
			candidates: [
				{ ref: target.ref, account: target.walledAccount, verdict: "walled", reason: "the lane's own account met the wall" },
				{ ref: target.ref, account: target.account, verdict: "chosen", reason: "the other account of the same plan is free" },
			],
			reason: `a quota wall on ${target.walledAccount}; the move to ${target.account} ${applied ? "was applied" : "is recorded, not applied"}`,
		};
		const where = routingDecisionsTarget();
		appendFsyncedLine(where.stateDir, where.fileName, routeDecisionLine(entry));
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

// ─── OL4: one pass, its order, and its lock ───────────────────────────────────

/**
 * OL4 (spec §10): the timer and the durable task each run the same pass, and only one of them runs it
 * at a time. This section is the pass's one owner: the order `muster-tick.mts`'s `main()` had, the
 * per-step containment it had; `tick-lock.ts` holds the lock that decides which of the two owners acts.
 *
 * The steps are ports, because the two processes bind them to different sources for the same owners:
 * the timer process is a client (`ledger/boundary.replaySpool`), the durable task runs beside the
 * store (`createTaskPorts.onPass`), and their state directories differ in a rehearsal. The order and the
 * error containment are here and nowhere else, and the lock is `tick-lock.ts`'s: a copy in either caller
 * is the defect this section exists to prevent.
 */

/**
 * The lock's names and its one implementation are `tick-lock.ts`'s, re-exported where the pass and its
 * callers already read them. The primitive moved out of this library because taking the lock runs a holder
 * process, and this library must stay unable to start or stop one: `muster-rotation.test.ts` guards exactly
 * that. The pass keeps the order and what losing means; the module keeps the one way to take the lock.
 */
export { TICK_LOCK_FILE, TICK_LOCK_HELD, holdTickLock };
export type { TickLockResult, TickPassLock } from "./tick-lock.ts";

/** One step's own output: the lines it prints, the error lines it adds, and whether it marks the run failed. */
export type TickPassStep = {
	out?: readonly string[];
	err?: readonly string[];
	failed?: boolean;
};

/**
 * One pass's steps, in `main()`'s order. The two callers bind the same port names to the owner that is
 * right for their process; nothing here reads a file, a clock or the machine by itself.
 */
export type TickPassPorts = {
	/** The state directory this pass acts on: the live one for the timer, the ledger's directory for the durable task. */
	stateDir(): string;
	/**
	 * The ledger's own lane reconcile, which the timer has no equivalent of: it runs inside the lock, so
	 * the owner that lost the lock does not reconcile either.
	 */
	reconcile?(): Promise<void>;
	/** `main()`'s first step: the heartbeat file the doctor reads, written before the work so a dying pass still says it began. */
	heartbeat(): void;
	/** The spool replay (`ledger/boundary.replaySpool` as a client, `createTaskPorts.onPass` beside the store). */
	replaySpool?(): void | Promise<void>;
	quota(): TickPassStep;
	graphRefresh(): TickPassStep;
	gatewayFreshness(): TickPassStep;
	askPush(): TickPassStep;
	standingRules(): TickPassStep;
	wakeHealth(): Promise<TickPassStep>;
	tick(): Promise<TickPassStep>;
	/** The timer's `--lifecycle` pass: it prints its own human-readable lines and is never on for the durable task. */
	lifecycle?(): Promise<void>;
	out(line: string): void;
	err(line: string): void;
	/** Mark the run failed (the timer's `process.exitCode`); the durable task has no exit code to set. */
	fail(): void;
};

/** What one pass did: `skipped` names the lock line when another owner held the lock. */
export type TickPassOutcome = { skipped?: string };

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * One step, contained. A throw becomes this step's one line and the next step still runs; the label is
 * the timer's existing wording, so the journal reads the same after this change. Henry wake health is
 * the one step that reports without marking the run failed, as it already did.
 */
async function runPassStep(ports: TickPassPorts, label: string, fails: boolean, step: () => TickPassStep | Promise<TickPassStep>): Promise<void> {
	try {
		const result = (await step()) ?? {};
		for (const line of result.out ?? []) ports.out(line);
		for (const line of result.err ?? []) ports.err(line);
		if (result.failed === true && fails) ports.fail();
	} catch (error) {
		ports.err(`muster-tick: ${label} failed: ${messageOf(error)}`);
		if (fails) ports.fail();
	}
}

/**
 * The whole pass (OL4): one lock, then `main()`'s sequence and the caller's own steps, each contained.
 *
 * The lock is taken for the pass and released by a `finally`, so no path leaves it held. The loser
 * prints exactly `skipped: lock held` and runs nothing: not the heartbeat, not the reconcile. A missing
 * `flock` is not a loser — the pass runs and says so in one line, because a tool that cannot be run must
 * not stop the machine's tick silently.
 */
export async function runTickPass(ports: TickPassPorts): Promise<TickPassOutcome> {
	const lock = await holdTickLock(join(ports.stateDir(), TICK_LOCK_FILE));
	if (lock.kind === "busy") {
		ports.out(TICK_LOCK_HELD);
		return { skipped: TICK_LOCK_HELD };
	}
	if (lock.kind === "unavailable") ports.err(`muster-tick: tick lock unavailable (${lock.reason}); running without it`);
	try {
		// 1. The pass's proof of life, before any work (main's first step).
		await runPassStep(ports, "heartbeat", true, () => {
			ports.heartbeat();
			return {};
		});
		// 2. One-time signals that waited for a store, through whichever owner this process has.
		await runPassStep(ports, "spool replay", true, async () => {
			await ports.replaySpool?.();
			return {};
		});
		// 2b. The ledger's lane reconcile, which the timer's pass has no step for.
		if (ports.reconcile !== undefined) {
			const reconcile = ports.reconcile;
			await runPassStep(ports, "lane reconcile", true, async () => {
				await reconcile();
				return {};
			});
		}
		// 3-9. main()'s own sequence, in its order.
		await runPassStep(ports, "quota fallback", true, ports.quota);
		await runPassStep(ports, "graph refresh pass", true, ports.graphRefresh);
		await runPassStep(ports, "gateway freshness pass", true, ports.gatewayFreshness);
		await runPassStep(ports, "ask push", true, ports.askPush);
		await runPassStep(ports, "standing-rule pass", true, ports.standingRules);
		await runPassStep(ports, "Henry wake health pass", false, ports.wakeHealth);
		await runPassStep(ports, "tick pass", true, ports.tick);
		// 10. main()'s `--lifecycle` pass, when the caller asked for it.
		if (ports.lifecycle !== undefined) {
			const lifecycle = ports.lifecycle;
			await runPassStep(ports, "lifecycle pass", true, async () => {
				await lifecycle();
				return {};
			});
		}
	} finally {
		if (lock.kind === "held") lock.lock.release();
	}
	return {};
}
