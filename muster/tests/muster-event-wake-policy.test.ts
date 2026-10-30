/**
 * A3: the event-wake policy answers "may this session be woken right now" for
 * non-Muster producers, using the WakePump owner's own predicates.
 *
 * The policy under test is the installed one (`createEventWakePolicy`), driven
 * through port fakes. Every hold asserted here is one the pump already
 * consults: a hold that exists only in this file would be a second owner.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createEventWakePolicy, type EventWakePolicyPorts, type ContinuationOutcome } from "../event-wake-policy.ts";
import type { EventWakeRequest } from "../../core/event-wake.ts";

const SESSION = "parent-1";
const REQUEST: EventWakeRequest = {
	text: "watch reported a new commit",
	origin: "watcher",
	mode: "followUp",
	dedupeKey: "event:watcher:abc",
};

/** Ports where nothing holds; each test re-states only the hold it exercises. */
function ports(overrides: Partial<EventWakePolicyPorts> = {}): EventWakePolicyPorts & { admissions: unknown[]; steers: unknown[]; completed: string[]; automatic: string[]; recorded: unknown[] } {
	const admissions: unknown[] = [];
	const steers: unknown[] = [];
	const completed: string[] = [];
	const automatic: string[] = [];
	const recorded: unknown[] = [];
	const base: EventWakePolicyPorts = {
		sessionRef: () => SESSION,
		leadsProgramme: () => true,
		globalPause: () => false,
		killFileActive: () => false,
		envDisabled: () => false,
		groupPaused: () => false,
		interactionHold: () => undefined,
		sessionHasPendingHumanInput: () => false,
		admitContinuation: (input) => {
			admissions.push(input);
			return { outcome: "admitted" } satisfies ContinuationOutcome;
		},
		admitSteer: (input) => {
			steers.push(input);
			return { outcome: "admitted" } satisfies ContinuationOutcome;
		},
		noteAutomatic: (group) => void automatic.push(group),
		completeContinuationFailed: (sessionId) => void completed.push(sessionId),
		recordWakeOutcome: (outcome, reason) => void recorded.push({ outcome, reason }),
	};
	return { ...base, ...overrides, admissions, steers, completed, automatic, recorded };
}

test("an unheld request is admitted, claims the continuation and marks the run automatic under its event group", () => {
	const p = ports();
	const policy = createEventWakePolicy(p);
	assert.equal(policy.admit(REQUEST, undefined), true);
	assert.equal(p.admissions.length, 1, "admission is the store's decision, not this policy's");
	assert.equal(p.automatic.length, 1);
	assert.equal(p.automatic[0], "event:watcher", "D1: the group is the producer's own, so the breaker can trip it");
	assert.equal(policy.eventGroupKey("watcher"), "event:watcher");
	assert.equal(policy.holdsClaim(REQUEST.dedupeKey), true, "admitted ⇒ a claim was taken");
});

test("every protected hold denies", () => {
	const cases: Array<[string, Partial<EventWakePolicyPorts>]> = [
		["no session", { sessionRef: () => undefined }],
		["global pause", { globalPause: () => true }],
		["kill file", { killFileActive: () => true }],
		["MUSTER_DISABLED", { envDisabled: () => true }],
		["breaker group", { groupPaused: (group) => group === "event:watcher" }],
		["session busy", { interactionHold: () => "not-idle" }],
		["extension prompt open", { interactionHold: () => "extension-prompt" }],
		["editor draft", { interactionHold: () => "editor-draft" }],
		["waiting on a worker", { admitContinuation: () => ({ outcome: "waiting", reason: "waiting-worker" }) }],
		["waiting on a check", { admitContinuation: () => ({ outcome: "waiting", reason: "waiting-check" }) }],
		["denied", { admitContinuation: () => ({ outcome: "denied", reason: "programme-off" }) }],
		["deferred, session busy", { admitContinuation: () => ({ outcome: "deferred", reason: "session-busy" }) }],
		["unavailable", { admitContinuation: () => ({ outcome: "unavailable", reason: "no programme record" }) }],
	];
	for (const [label, override] of cases) {
		const p = ports(override);
		const policy = createEventWakePolicy(p);
		assert.equal(policy.admit(REQUEST, undefined), false, `${label} must deny`);
		assert.equal(p.automatic.length, 0, `${label}: a denied request is never an automatic run`);
		assert.equal(policy.holdsClaim(REQUEST.dedupeKey), false, `${label}: no claim to release`);
	}
});

test("pending human input is the admission owner's hold, not a second rule here", () => {
	let holdCalls = 0;
	const p = ports({
		sessionHasPendingHumanInput: () => {
			holdCalls += 1;
			return true;
		},
		admitContinuation: (input) => {
			// The real admission asks its own hold; the policy only supplies it.
			return input.hold() ? { outcome: "waiting", reason: "waiting-check" } : ({ outcome: "admitted" } satisfies ContinuationOutcome);
		},
	});
	const policy = createEventWakePolicy(p);
	assert.equal(policy.admit(REQUEST, undefined), false, "a hold the admission reports is a deny");
	assert.equal(holdCalls, 1, "the policy passes the hold through instead of re-reading it");
});

test("a steer request uses the steer admission and takes no claim", () => {
	const p = ports();
	const policy = createEventWakePolicy(p);
	assert.equal(policy.admit({ ...REQUEST, mode: "steer" }, undefined), true);
	assert.equal(p.steers.length, 1);
	assert.equal(p.admissions.length, 0, "a steer never claims a continuation");
	assert.equal(policy.holdsClaim(REQUEST.dedupeKey), false);
});

test("a session that leads no programme is admitted without a claim", () => {
	const p = ports({ leadsProgramme: () => false });
	const policy = createEventWakePolicy(p);
	assert.equal(policy.admit(REQUEST, undefined), true, "not-enrolled keeps today's behaviour: nothing is held by it");
	assert.equal(p.admissions.length, 0);
	assert.equal(policy.holdsClaim(REQUEST.dedupeKey), false);
	assert.equal(p.automatic.length, 1, "the run is still automatic and still breaker-attributable");
});

test("the breaker hold is checked per producer group, and only that group", () => {
	const asked: string[] = [];
	const p = ports({ groupPaused: (group) => { asked.push(group); return false; } });
	createEventWakePolicy(p).admit(REQUEST, undefined);
	assert.deepEqual(asked, ["event:watcher"]);
	const paused = ports({ groupPaused: (group) => group === "event:sleep-timer" });
	assert.equal(createEventWakePolicy(paused).admit({ ...REQUEST, origin: "watcher" }, undefined), true);
});