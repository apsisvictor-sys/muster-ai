import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	attachProgramme,
	claimContinuation,
	claimRotationTakeover,
	enqueueWake,
	completeContinuation,
	completeRotation,
	failRotation,
	fileProgrammeControlStore,
	markRotationCheckpointed,
	pauseProgramme,
	readProgrammeSnapshot,
	recordHeartbeat,
	recordRotationLaunch,
	requestRotation,
	validateProgrammeControlRecord,
	type ProgrammeControlContext,
} from "../control.ts";

/**
 * R1.5 (AM4): the rotation state machine in the control record. The record is
 * the one owner of ownership and wakes, so the rotation of a project's parent is
 * a set of CAS transitions here. Policy (when to rotate) lives in rotation.ts.
 */

const ID = "agp_5b5b5b5b5b5b";
const OWNER = { sessionId: "old-leader", processKey: "pi-1-boot-1", operatorRef: "operator", guarded: true };
const MIN = 60_000;
const T0 = Date.parse("2026-10-04T12:00:00.000Z");

function withStore(run: (ctx: ProgrammeControlContext, dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "muster-rotation-control-"));
	try {
		const ctx = { store: fileProgrammeControlStore(dir), killFilePath: join(dir, "kill") };
		attachProgramme(ID, OWNER, ctx);
		run(ctx, dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function completeContinuationForTest(ctx: ProgrammeControlContext, claimId: string): void {
	completeContinuation(ID, claimId, "progressed", ctx);
}

const request = (ctx: ProgrammeControlContext, now = T0, ticket = "rot-1") =>
	requestRotation(ID, { ticket, reason: "context", fromSessionId: OWNER.sessionId, now }, ctx);

// ─── Heartbeat fields ────────────────────────────────────────────────────────

test("a heartbeat carries context size, the last compaction and the Herdr pane", () => withStore((ctx) => {
	recordHeartbeat(ID, {
		pid: 123, sessionId: OWNER.sessionId, generation: 1,
		contextTokens: 262_000, contextWindow: 1_000_000,
		compaction: { at: "2026-10-04T11:59:00.000Z", outcome: "completed", tokensAfter: 260_000 },
		paneId: "wD:pA",
	}, ctx);
	const beat = readProgrammeSnapshot(ID, ctx).lastHeartbeat!;
	assert.equal(beat.contextTokens, 262_000);
	assert.equal(beat.contextWindow, 1_000_000);
	assert.deepEqual(beat.compaction, { at: "2026-10-04T11:59:00.000Z", outcome: "completed", tokensAfter: 260_000 });
	assert.equal(beat.paneId, "wD:pA");
}));

test("a malformed heartbeat observation is refused on read, not trusted", () => withStore((ctx) => {
	const raw = JSON.parse(JSON.stringify(readProgrammeSnapshot(ID, ctx)));
	raw.lastHeartbeat = { pid: 1, sessionId: "s", generation: 1, at: "x", compaction: { at: "x", outcome: "maybe" } };
	assert.equal(validateProgrammeControlRecord(raw).ok, false);
	raw.lastHeartbeat = { pid: 1, sessionId: "s", generation: 1, at: "x", contextTokens: -4 };
	assert.equal(validateProgrammeControlRecord(raw).ok, false);
}));

// ─── Request ─────────────────────────────────────────────────────────────────

test("a request records the rotation and queues one rotation wake for the leader", () => withStore((ctx) => {
	const result = request(ctx);
	assert.equal(result.outcome, "requested");
	const record = readProgrammeSnapshot(ID, ctx);
	assert.equal(record.rotation?.phase, "checkpoint");
	assert.equal(record.rotation?.ticket, "rot-1");
	assert.equal(record.rotation?.reason, "context");
	assert.equal(record.rotation?.fromSessionId, OWNER.sessionId);
	const wake = record.pendingWakes.find((row) => row.sourceEventId === "rotation/rot-1");
	assert.equal(wake?.kind, "rotation");
	assert.equal(wake?.sessionRef, OWNER.sessionId);
}));

test("rotation is denied for pause, off, the kill file, no owner and a replaced leader", () => withStore((ctx, dir) => {
	writeFileSync(join(dir, "kill"), "stop");
	assert.deepEqual(request(ctx), { outcome: "denied", reason: "kill-file" });
	rmSync(join(dir, "kill"));
	pauseProgramme(ID, "operator pause", ctx);
	assert.deepEqual(request(ctx), { outcome: "denied", reason: "programme-paused" });
	assert.equal(readProgrammeSnapshot(ID, ctx).rotation, null);
	assert.deepEqual(requestRotation(ID, { ticket: "r", reason: "context", fromSessionId: "someone-else", now: T0 }, ctx), { outcome: "denied", reason: "programme-paused" }, "pause is checked first");
}));

test("a request from a session that is not the owner is denied", () => withStore((ctx) => {
	assert.deepEqual(requestRotation(ID, { ticket: "r", reason: "context", fromSessionId: "someone-else", now: T0 }, ctx), { outcome: "denied", reason: "not-the-leader" });
}));

test("a second request while one is in flight is denied", () => withStore((ctx) => {
	assert.equal(request(ctx).outcome, "requested");
	assert.deepEqual(request(ctx, T0 + MIN, "rot-2"), { outcome: "denied", reason: "in-flight" });
}));

test("rotation never repeats within 30 minutes, whatever the outcome", () => withStore((ctx) => {
	request(ctx);
	failRotation(ID, "rot-1", "launch failed", ctx, T0 + MIN);
	assert.deepEqual(request(ctx, T0 + 29 * MIN, "rot-2"), { outcome: "denied", reason: "too-soon" });
	assert.equal(request(ctx, T0 + 31 * MIN, "rot-2").outcome, "requested");
}));

// ─── Checkpoint, launch ──────────────────────────────────────────────────────

test("the leader's acknowledgement is recorded once and only for the current ticket", () => withStore((ctx) => {
	request(ctx);
	assert.deepEqual(markRotationCheckpointed(ID, "other-ticket", ctx, T0 + MIN), { outcome: "stale" });
	assert.equal(markRotationCheckpointed(ID, "rot-1", ctx, T0 + MIN).outcome, "recorded");
	assert.equal(readProgrammeSnapshot(ID, ctx).rotation?.checkpointedAt, new Date(T0 + MIN).toISOString());
	assert.equal(markRotationCheckpointed(ID, "rot-1", ctx, T0 + 2 * MIN).outcome, "already");
	assert.equal(readProgrammeSnapshot(ID, ctx).rotation?.checkpointedAt, new Date(T0 + MIN).toISOString(), "the first acknowledgement stands");
}));

test("launch is recorded from the checkpoint phase and is cancelled instead when the programme is no longer running", () => withStore((ctx, dir) => {
	request(ctx);
	assert.equal(recordRotationLaunch(ID, "rot-1", ctx, T0 + 3 * MIN).outcome, "launching");
	assert.equal(readProgrammeSnapshot(ID, ctx).rotation?.phase, "launched");
	assert.equal(recordRotationLaunch(ID, "rot-1", ctx, T0 + 4 * MIN).outcome, "stale", "a launch is recorded once");
	failRotation(ID, "rot-1", "x", ctx, T0 + 5 * MIN);
	request(ctx, T0 + 40 * MIN, "rot-2");
	writeFileSync(join(dir, "kill"), "stop");
	const cancelled = recordRotationLaunch(ID, "rot-2", ctx, T0 + 41 * MIN);
	assert.deepEqual(cancelled, { outcome: "cancelled", reason: "kill-file" });
	assert.equal(readProgrammeSnapshot(ID, ctx).rotation?.phase, "cancelled");
}));

test("a failure counts toward consecutive failures, and a completed rotation resets them", () => withStore((ctx) => {
	request(ctx);
	recordRotationLaunch(ID, "rot-1", ctx, T0 + MIN);
	failRotation(ID, "rot-1", "no takeover within 10 minutes", ctx, T0 + 12 * MIN);
	assert.equal(readProgrammeSnapshot(ID, ctx).rotation?.phase, "failed");
	assert.equal(readProgrammeSnapshot(ID, ctx).rotation?.consecutiveFailures, 1);
	request(ctx, T0 + 40 * MIN, "rot-2");
	assert.equal(readProgrammeSnapshot(ID, ctx).rotation?.consecutiveFailures, 1, "carried into the next attempt");
	recordRotationLaunch(ID, "rot-2", ctx, T0 + 41 * MIN);
	failRotation(ID, "rot-2", "again", ctx, T0 + 52 * MIN);
	assert.equal(readProgrammeSnapshot(ID, ctx).rotation?.consecutiveFailures, 2);
	request(ctx, T0 + 90 * MIN, "rot-3");
	recordRotationLaunch(ID, "rot-3", ctx, T0 + 91 * MIN);
	assert.equal(claimRotationTakeover(ID, "rot-3", "fresh-leader", ctx, T0 + 92 * MIN).outcome, "valid");
	completeRotation(ID, "rot-3", "fresh-leader", ctx, T0 + 92 * MIN);
	const done = readProgrammeSnapshot(ID, ctx).rotation!;
	assert.equal(done.phase, "completed");
	assert.equal(done.consecutiveFailures, 0);
	assert.deepEqual(done.lastCompleted, { at: new Date(T0 + 92 * MIN).toISOString(), reason: "context" });
}));

// ─── Takeover authority ──────────────────────────────────────────────────────

test("the ticket authorizes a takeover only once, for another session, within 10 minutes of launch", () => withStore((ctx) => {
	request(ctx);
	assert.deepEqual(claimRotationTakeover(ID, "rot-1", "fresh", ctx, T0 + MIN), { outcome: "invalid", reason: "not-launched" });
	recordRotationLaunch(ID, "rot-1", ctx, T0 + 2 * MIN);
	assert.deepEqual(claimRotationTakeover(ID, "wrong", "fresh", ctx, T0 + 3 * MIN), { outcome: "invalid", reason: "wrong-ticket" });
	assert.deepEqual(claimRotationTakeover(ID, "rot-1", OWNER.sessionId, ctx, T0 + 3 * MIN), { outcome: "invalid", reason: "same-session" });
	assert.deepEqual(claimRotationTakeover(ID, "rot-1", "fresh", ctx, T0 + 13 * MIN), { outcome: "invalid", reason: "expired" });
	assert.equal(claimRotationTakeover(ID, "rot-1", "fresh", ctx, T0 + 5 * MIN).outcome, "valid");
	completeRotation(ID, "rot-1", "fresh", ctx, T0 + 5 * MIN);
	assert.deepEqual(claimRotationTakeover(ID, "rot-1", "fresh", ctx, T0 + 6 * MIN), { outcome: "invalid", reason: "not-launched" }, "single use");
}));

test("the resume brief is kept in the record with the rotation, and an oversized one is refused", () => withStore((ctx) => {
	requestRotation(ID, { ticket: "rot-b", reason: "context", fromSessionId: OWNER.sessionId, now: T0, brief: "Read the checkpoint, then continue." }, ctx);
	assert.equal(readProgrammeSnapshot(ID, ctx).rotation?.brief, "Read the checkpoint, then continue.");
	assert.throws(() => requestRotation(ID, { ticket: "rot-c", reason: "context", fromSessionId: OWNER.sessionId, now: T0 + 40 * MIN, brief: "x".repeat(9000) }, ctx), /brief/);
}));

test("the ticket is refused once the programme is paused or the kill file exists, even before it expires", () => withStore((ctx, dir) => {
	request(ctx);
	recordRotationLaunch(ID, "rot-1", ctx, T0 + MIN);
	assert.equal(claimRotationTakeover(ID, "rot-1", "fresh", ctx, T0 + 2 * MIN).outcome, "valid");
	writeFileSync(join(dir, "kill"), "stop");
	assert.deepEqual(claimRotationTakeover(ID, "rot-1", "fresh", ctx, T0 + 2 * MIN), { outcome: "invalid", reason: "kill-file" });
	rmSync(join(dir, "kill"));
	pauseProgramme(ID, "operator pause", ctx);
	assert.deepEqual(claimRotationTakeover(ID, "rot-1", "fresh", ctx, T0 + 2 * MIN), { outcome: "invalid", reason: "not-running" });
}));

test("no continuation is admitted once the leader has acknowledged its checkpoint or the fresh parent is launched, and admission resumes when the rotation ends (review F5)", () => withStore((ctx) => {
	request(ctx);
	enqueueWake(ID, { sourceEventId: "rotation/rot-1-wake", kind: "state-transition", reason: "x" }, ctx);
	const first = claimContinuation(ID, OWNER.sessionId, ctx);
	assert.equal(first.outcome, "admitted", "the checkpoint turn itself runs");
	assert.ok(first.outcome === "admitted");
	markRotationCheckpointed(ID, "rot-1", ctx, T0 + MIN);
	completeContinuationForTest(ctx, first.claimId);
	enqueueWake(ID, { sourceEventId: "frontier/1-a", kind: "frontier", reason: "work waiting" }, ctx);
	const rotating = claimContinuation(ID, OWNER.sessionId, ctx);
	assert.deepEqual(rotating.outcome === "waiting" ? rotating.reasons : rotating, ["rotating"], "no second run beside the one that is about to be replaced");
	recordRotationLaunch(ID, "rot-1", ctx, T0 + 2 * MIN);
	assert.equal(claimContinuation(ID, OWNER.sessionId, ctx).outcome, "waiting", "still rotating while the fresh parent starts");
	failRotation(ID, "rot-1", "x", ctx, T0 + 12 * MIN);
	assert.equal(claimContinuation(ID, OWNER.sessionId, ctx).outcome, "admitted", "a failed rotation no longer holds the leader back");
}));

test("a record with rotation state round-trips, a damaged one is refused, and an older record reads as having none", () => withStore((ctx) => {
	request(ctx);
	const record = JSON.parse(JSON.stringify(readProgrammeSnapshot(ID, ctx)));
	assert.equal(validateProgrammeControlRecord(record).ok, true);
	const damaged = JSON.parse(JSON.stringify(record));
	damaged.rotation.phase = "sideways";
	assert.equal(validateProgrammeControlRecord(damaged).ok, false);
	const older = JSON.parse(JSON.stringify(record));
	delete older.rotation;
	const validated = validateProgrammeControlRecord(older);
	assert.equal(validated.ok, true);
	if (validated.ok) assert.equal(validated.record.rotation, null);
}));
