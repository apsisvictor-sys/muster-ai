/**
 * A3: the Muster side of the shared event-wake transport.
 *
 * `EventWakeOwner` (extensions/lib/event-wake.ts) is a common transport: it
 * queues, rate-limits and dedupes, and asks this policy whether a session may be
 * woken right now. Every hold here is one WakePump already consults — the
 * transport must not become a way around the operator's pause, the kill file,
 * the no-progress breaker or the continuation claim, so this module *reads* those
 * predicates through ports and never re-expresses them.
 *
 * What it deliberately does not do: send. `WakePump.pump()` keeps its own send
 * path, because only it verifies durable session recording before marking a wake
 * delivered (inbox.ts `awaitRecording`). Relay delivery also stays on its own
 * path: an operator answer must not be breaker-gated or re-admitted.
 */

import type { EventWakePolicy, EventWakeRequest } from "../core/event-wake.ts";
import type { GroupKey } from "./types.ts";

/** Why a wake was held. Reported, never used to re-derive the hold itself. */
export type EventWakeHold =
	| "no-session"
	| "no-binding"
	| "global-pause"
	| "kill-file"
	| "env-disabled"
	| "breaker-group"
	| "not-idle"
	| "extension-prompt"
	| "editor-draft"
	| "continuation-waiting"
	| "continuation-denied"
	| "continuation-deferred"
	| "continuation-unavailable";

export type ContinuationOutcome =
	| { outcome: "not-enrolled" }
	| { outcome: "admitted" }
	| { outcome: "waiting" | "denied" | "deferred" | "unavailable"; reason?: string };

export type WakeEventInput = { sourceEventId: string; kind: string; reason: string };

export interface EventWakePolicyPorts {
	/** This session's ref; undefined when no session owns the transport. */
	sessionRef(): string | undefined;
	/** True when the session leads at least one programme. */
	leadsProgramme(): boolean;
	globalPause(): boolean;
	killFileActive(): boolean;
	envDisabled(): boolean;
	/** The breaker's own per-group hold. */
	groupPaused(group: GroupKey): boolean;
	/** undefined when the session may be woken. */
	interactionHold(): "not-idle" | "extension-prompt" | "editor-draft" | undefined;
	/** Passed to the admission as its hold, so the owner of that rule keeps it. */
	sessionHasPendingHumanInput(): boolean;
	admitContinuation(input: { sessionRef: string; events: WakeEventInput[]; hold: () => boolean }): ContinuationOutcome;
	admitSteer(input: { sessionRef: string; events: WakeEventInput[] }): ContinuationOutcome;
	/** Mark the run automatic, under the group the breaker can trip. */
	noteAutomatic(group: GroupKey): void;
	/** The pump's own cleanup for a failed send. */
	completeContinuationFailed(sessionId: string): void;
	recordWakeOutcome(outcome: string, reason: string): void;
}

export interface EventWakeBinding extends EventWakePolicy {
	/** `event:<origin>`: the producer's own group, so a no-progress loop of that
	 * producer trips only its own group and never another producer's. */
	eventGroupKey(origin: string): string;
	holdsClaim(dedupeKey: string): boolean;
	claimedCount(): number;
	lastHold(): EventWakeHold | undefined;
}

/**
 * The wake event an admitted request submits for admission. `state-transition`
 * is the honest kind: this is an external state change, not operator input and
 * not a worker handoff.
 */
function wakeEventFor(request: EventWakeRequest): WakeEventInput {
	return { sourceEventId: request.dedupeKey, kind: "state-transition", reason: request.text.trim() };
}

export function eventWakeGroupKey(origin: string): GroupKey {
	return `event:${origin}`;
}

export function createEventWakePolicy(ports: EventWakePolicyPorts): EventWakeBinding {
	/**
	 * D4: which requests hold a continuation claim. A steer never claims, a
	 * not-enrolled session never claims, and a denied admission never claims — so
	 * `sendFailed` releases exactly the claims `admit` took, exactly once.
	 */
	const claims = new Map<string, string>();
	let lastHold: EventWakeHold | undefined;

	function deny(request: EventWakeRequest, hold: EventWakeHold): false {
		lastHold = hold;
		// The continuation metric's own vocabulary: a held wake is a wake waiting,
		// and the reason names which hold. The pump reports nothing when a send
		// throws either, so `sendFailed` reports nothing.
		ports.recordWakeOutcome("waiting", hold);
		return false;
	}

	function admit(request: EventWakeRequest): boolean {
		const sessionRef = ports.sessionRef();
		if (sessionRef === undefined || sessionRef === "") return deny(request, "no-session");
		// No control record covers this session. Today's behaviour applies: a
		// non-programme wake is not held by the programme rules, but the
		// operator's own switches still are.
		const enrolled = ports.leadsProgramme();
		if (ports.globalPause()) return deny(request, "global-pause");
		if (ports.killFileActive()) return deny(request, "kill-file");
		if (ports.envDisabled()) return deny(request, "env-disabled");
		const group = eventWakeGroupKey(request.origin);
		if (ports.groupPaused(group)) return deny(request, "breaker-group");
		const interaction = ports.interactionHold();
		if (interaction !== undefined) return deny(request, interaction);

		if (!enrolled) {
			// Nothing to claim and nothing to gate: today's not-enrolled wake.
			ports.noteAutomatic(group);
			claims.delete(request.dedupeKey);
			lastHold = undefined;
			return true;
		}

		const event = wakeEventFor(request);
		const outcome = request.mode === "steer" ? ports.admitSteer({ sessionRef, events: [event] }) : ports.admitContinuation({ sessionRef, events: [event], hold: () => ports.sessionHasPendingHumanInput() });

		switch (outcome.outcome) {
			case "not-enrolled":
				ports.noteAutomatic(group);
				claims.delete(request.dedupeKey);
				lastHold = undefined;
				return true;
			case "admitted":
				ports.noteAutomatic(group);
				if (request.mode !== "steer") claims.set(request.dedupeKey, sessionRef);
				lastHold = undefined;
				return true;
			case "waiting":
			case "denied":
			case "deferred":
			case "unavailable":
				return deny(request, `continuation-${outcome.outcome}`);
		}
	}

	return {
		admit(request: EventWakeRequest): boolean {
			return admit(request);
		},
		sendFailed(request: EventWakeRequest, error: unknown): void {
			const sessionRef = claims.get(request.dedupeKey);
			if (sessionRef === undefined) {
				// No claim of ours: a steer, a not-enrolled session, or a request the
				// transport retried after a previous release. Nothing to release.
				return;
			}
			claims.delete(request.dedupeKey);
			ports.completeContinuationFailed(sessionRef);
		},
		eventGroupKey: eventWakeGroupKey,
		holdsClaim: (dedupeKey: string): boolean => claims.has(dedupeKey),
		claimedCount: (): number => claims.size,
		lastHold: (): EventWakeHold | undefined => lastHold,
	};
}

function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return "unknown error";
}