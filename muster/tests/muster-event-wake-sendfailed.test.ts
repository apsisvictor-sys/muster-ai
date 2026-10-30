/**
 * A3 (D4): a send that throws must leave no continuation claim behind, exactly
 * one release, and the request must stay pending for the owner's retry.
 *
 * The release is the pump's own cleanup
 * (`completeProgrammeContinuation(…, "failed", undefined, "muster")`), asserted
 * through the port, because that call is the single owner of the claim.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { EventWakeOwner } from "../../core/event-wake.ts";
import { createEventWakePolicy, type ContinuationOutcome, type EventWakePolicyPorts } from "../event-wake-policy.ts";
import type { EventWakeRequest } from "../../core/event-wake.ts";

const REQUEST: EventWakeRequest = {
	text: "watch reported a new commit",
	origin: "watcher",
	mode: "followUp",
	dedupeKey: "event:watcher:abc",
};

function ports(overrides: Partial<EventWakePolicyPorts> = {}) {
	const completed: string[] = [];
	const automatic: string[] = [];
	const recorded: unknown[] = [];
	const base: EventWakePolicyPorts = {
		sessionRef: () => "parent-1",
		leadsProgramme: () => true,
		globalPause: () => false,
		killFileActive: () => false,
		envDisabled: () => false,
		groupPaused: () => false,
		interactionHold: () => undefined,
		sessionHasPendingHumanInput: () => false,
		admitContinuation: () => ({ outcome: "admitted" }) as ContinuationOutcome,
		admitSteer: () => ({ outcome: "admitted" }) as ContinuationOutcome,
		noteAutomatic: (group) => void automatic.push(group),
		completeContinuationFailed: (sessionId) => void completed.push(sessionId),
		recordWakeOutcome: (outcome, reason) => void recorded.push({ outcome, reason }),
	};
	return { ports: { ...base, ...overrides }, completed, automatic, recorded };
}

test("a failed send releases the claim exactly once and keeps the request pending", () => {
	const f = ports();
	const policy = createEventWakePolicy(f.ports);
	const sent: unknown[] = [];
	const owner = new EventWakeOwner((message: unknown) => {
		sent.push(message);
		throw new Error("session busy");
	}, { now: () => 0 });
	owner.setPolicy(policy);

	owner.request(REQUEST);
	assert.deepEqual(f.completed, ["parent-1"], "one release, on the pump's own cleanup path");
	assert.equal(owner.pendingCount, 1, "the event stays queued for the next flush");

	// The retry is a fresh admission and therefore a fresh claim, exactly as the
	// pump re-admits on every attempt: one release per claim, never two releases
	// for one claim.
	owner.flush();
	assert.equal(sent.length, 2, "both attempts were made");
	assert.deepEqual(f.completed, ["parent-1", "parent-1"], "one release per admitted claim");
});

test("a successful send takes the claim through delivery and releases nothing", () => {
	const f = ports();
	const owner = new EventWakeOwner((_message: unknown) => {}, { now: () => 0 });
	owner.setPolicy(createEventWakePolicy(f.ports));
	owner.request(REQUEST);
	assert.deepEqual(f.completed, [], "delivery is not a failure");
	assert.equal(owner.pendingCount, 0);
	assert.equal(f.automatic.length, 1);
});

test("a steer never releases a claim, because it never took one", () => {
	const f = ports();
	const owner = new EventWakeOwner((_message: unknown) => { throw new Error("no"); }, { now: () => 0 });
	owner.setPolicy(createEventWakePolicy(f.ports));
	owner.request({ ...REQUEST, mode: "steer" });
	assert.deepEqual(f.completed, [], "a steer holds no continuation claim");
});

test("a denied request that fails to send is not a release path", () => {
	const f = ports({ admitContinuation: () => ({ outcome: "denied", reason: "programme-paused" }) as ContinuationOutcome });
	const policy = createEventWire(f);
	assert.equal(policy.admit(REQUEST, undefined), false);
	policy.sendFailed?.(REQUEST, new Error("unused"));
	assert.deepEqual(f.completed, [], "nothing was claimed, so nothing is released");
	assert.equal(policy.holdsClaim(REQUEST.dedupeKey), false);
});

function createEventWire(f: ReturnType<typeof ports>) {
	return createEventWakePolicy(f.ports);
}

test("one claim per request key, released once even if sendFailed is called twice", () => {
	const f = ports();
	const policy = createEventWakePolicy(f.ports);
	policy.admit(REQUEST, undefined);
	policy.sendFailed?.(REQUEST, new Error("first"));
	policy.sendFailed?.(REQUEST, new Error("second"));
	assert.deepEqual(f.completed, ["parent-1"]);
	assert.equal(policy.claimedCount(), 0, "the record is dropped with the release");
});