import "./muster-test-isolation.ts";
/**
 * Model-free regressions for the P1.2 programme control bridge (plan §7 P1.2,
 * §3 continuation admission).
 *
 * Pure resolution/admission tests: OS temp directories only, no network,
 * provider, Concord or Pi API. The kill file is a local temp file and both
 * record roots are explicit fixture directories; nothing here touches
 * `~/.pi/agent/state`.
 *
 * Authored here; executed by the parent through the guarded runner.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileProgrammeStore } from "../../core/programme.ts";
import { type ProgrammeRecord } from "../../core/programme.ts";
import {
	attachProgramme,
	fileProgrammeControlStore,
	pauseProgramme,
	readProgrammeSnapshot,
	resumeProgramme,
	startProgramme,
	type ProgrammeControlStore,
	type WakeEvent,
	type WakeKind,
} from "../control.ts";
import {
	activeProgrammeContinuation,
	admitProgrammeContinuation,
	completeProgrammeContinuation,
	listProgrammeEnrollments,
	noteProgrammeWake,
	programmeKillFileActive,
	programmeOutcomeFromSignals,
	programmeWakeForDelivery,
	resetProgrammeContinuations,
	resolveEnrolledProgramme,
	type ControlBridgeContext,
} from "../control-bridge.ts";

const PROGRAMME_ID = "agp_0123456789ab";
const SESSION = "session-parent";

type BridgeFixture = {
	root: string;
	controlDir: string;
	programmeDir: string;
	ctx: ControlBridgeContext;
	store: ProgrammeControlStore;
};

function withBridge(run: (fixture: BridgeFixture) => void): void {
	const root = mkdtempSync(join(tmpdir(), "muster-bridge-"));
	const controlDir = join(root, "control");
	const programmeDir = join(root, "programmes");
	mkdirSync(controlDir, { recursive: true });
	mkdirSync(programmeDir, { recursive: true });
	const store = fileProgrammeControlStore(controlDir);
	const ctx: ControlBridgeContext = {
		store,
		controlDir,
		programmeDir,
		killFilePath: join(root, "muster.disabled"),
	};
	resetProgrammeContinuations();
	try {
		run({ root, controlDir, programmeDir, ctx, store });
	} finally {
		resetProgrammeContinuations();
		rmSync(root, { recursive: true, force: true });
	}
}

function wake(sourceEventId: string, kind: WakeKind = "handoff"): WakeEvent {
	return { sourceEventId, kind, reason: `test event ${sourceEventId}` };
}

/** A minimal valid Agile programme record naming its parent session. */
function agileRecord(sessionId: string): ProgrammeRecord {
	const now = new Date().toISOString();
	return {
		schemaVersion: 1,
		programmeId: PROGRAMME_ID,
		revision: 1,
		controllerEpoch: 1,
		phase: "active",
		title: "Bridge fixture programme",
		createdAt: now,
		updatedAt: now,
		backlogSource: { kind: "approved-plan", reference: "plans/autonomous-loop-architecture-2026-09-23.md" },
		stableAgentId: "pi-bridge-fixture",
		sessionId,
		increments: [],
		operatorDecisions: [],
	};
}

/** Bootstrap enrolment: Agile programme record names the session; control record started. */
function enroll(fixture: BridgeFixture, sessionId = SESSION): void {
	fileProgrammeStore(fixture.programmeDir).create(agileRecord(sessionId));
	startProgramme(PROGRAMME_ID, { operatorRef: "operator" }, fixture.ctx);
}

function countingStore(inner: ProgrammeControlStore): { store: ProgrammeControlStore; calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		store: {
			dir: inner.dir,
			read(programmeId) {
				calls.push(`read:${programmeId}`);
				return inner.read(programmeId);
			},
			update(programmeId, expectedRevision, mutate) {
				calls.push(`update:${programmeId}`);
				return inner.update(programmeId, expectedRevision, mutate);
			},
		},
	};
}

// ─── Enrolment resolution ────────────────────────────────────────────────────

test("muster-control-bridge: resolves the programme parent session and ignores strangers", () => {
	withBridge((fixture) => {
		enroll(fixture);
		const resolved = resolveEnrolledProgramme(SESSION, fixture.ctx);
		assert.equal(resolved?.programmeId, PROGRAMME_ID);
		assert.equal(resolved?.status, "running");
		assert.equal(resolved?.pendingWakeCount, 0);
		assert.equal(resolveEnrolledProgramme("session-stranger", fixture.ctx), undefined);
		assert.equal(resolveEnrolledProgramme("", fixture.ctx), undefined);
		assert.deepEqual(
			listProgrammeEnrollments(fixture.ctx).map((entry) => `${entry.programmeId}:${entry.sessionRef}:${entry.status}`),
			[`${PROGRAMME_ID}:${SESSION}:running`],
		);
	});
});

test("muster-control-bridge: a claim-written enrolment resolves without the Agile programme record", () => {
	withBridge((fixture) => {
		// No Agile programme record exists: the control record's own enrolment is
		// the only source, as it is after `claimContinuation` writes it.
		startProgramme(PROGRAMME_ID, { operatorRef: "operator" }, fixture.ctx);
		const snapshot = readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx);
		fixture.store.update(PROGRAMME_ID, snapshot.revision, (record) => ({
			...record,
			enrolledSessions: [SESSION],
			revision: record.revision + 1,
		}));
		assert.equal(resolveEnrolledProgramme(SESSION, fixture.ctx)?.programmeId, PROGRAMME_ID);
		assert.equal(resolveEnrolledProgramme("session-other", fixture.ctx), undefined);
		assert.deepEqual(
			listProgrammeEnrollments(fixture.ctx).map((entry) => entry.sessionRef),
			[SESSION],
		);
	});
});

test("muster-control-bridge: owned programmes enumerate only the current owner session", () => {
	withBridge((fixture) => {
		startProgramme(PROGRAMME_ID, { operatorRef: "operator" }, fixture.ctx);
		const snapshot = readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx);
		fixture.store.update(PROGRAMME_ID, snapshot.revision, (record) => ({
			...record,
			enrolledSessions: ["session-historical"],
			revision: record.revision + 1,
		}));
		attachProgramme(PROGRAMME_ID, {
			sessionId: "session-current-owner",
			processKey: "pid-123-boot-test",
			operatorRef: "operator",
		}, fixture.ctx);

		assert.deepEqual(listProgrammeEnrollments(fixture.ctx).map((entry) => entry.sessionRef), ["session-current-owner"]);
		assert.equal(resolveEnrolledProgramme("session-historical", fixture.ctx), undefined);
	});
});

test("muster-control-bridge: a finished programme stops enrolling its session", () => {
	withBridge((fixture) => {
		enroll(fixture);
		const admitted = admitProgrammeContinuation({ sessionRef: SESSION, owner: "muster", events: [wake("evt-finish")] }, fixture.ctx);
		assert.equal(admitted.outcome, "admitted");
		completeProgrammeContinuation(SESSION, "completed", fixture.ctx);
		assert.equal(readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx).status, "off");
		assert.equal(resolveEnrolledProgramme(SESSION, fixture.ctx), undefined);
	});
});

test("muster-control-bridge: malformed control records are skipped, never reset", () => {
	withBridge((fixture) => {
		enroll(fixture);
		const malformedPath = join(fixture.controlDir, "agp_ffffffffffff.json");
		writeFileSync(malformedPath, "{not json", "utf8");
		assert.equal(resolveEnrolledProgramme(SESSION, fixture.ctx)?.programmeId, PROGRAMME_ID);
		assert.equal(readFileSync(malformedPath, "utf8"), "{not json", "malformed record is never repaired or reset");
	});
});

test("muster-control-bridge: non-enrolled sessions make no control call and create no record", () => {
	withBridge((fixture) => {
		const counting = countingStore(fileProgrammeControlStore(fixture.controlDir));
		const ctx: ControlBridgeContext = { ...fixture.ctx, store: counting.store };
		// An Agile programme exists for another session; no control record exists.
		fileProgrammeStore(fixture.programmeDir).create(agileRecord("session-other"));
		assert.deepEqual(admitProgrammeContinuation({ sessionRef: SESSION, owner: "muster", events: [wake("evt-1")] }, ctx), {
			outcome: "not-enrolled",
		});
		assert.equal(resolveEnrolledProgramme(SESSION, ctx), undefined);
		assert.equal(noteProgrammeWake(SESSION, wake("evt-1"), ctx), false);
		assert.equal(programmeKillFileActive(ctx), false);
		assert.deepEqual(counting.calls, [], "no control-store read, write or claim without a control record");
		assert.deepEqual(readdirSync(fixture.controlDir), [], "no control record was created");
	});
});

// ─── Wake coalescing and admission ───────────────────────────────────────────

test("muster-control-bridge: duplicate source events coalesce into one admitted continuation", () => {
	withBridge((fixture) => {
		enroll(fixture);
		const first = admitProgrammeContinuation({ sessionRef: SESSION, owner: "muster", events: [wake("evt-1")] }, fixture.ctx);
		assert.equal(first.outcome, "admitted");
		const claimId = first.outcome === "admitted" ? first.claimId : "";

		// Replay while the claim is active: coalesced, no second claim.
		assert.deepEqual(admitProgrammeContinuation({ sessionRef: SESSION, owner: "muster", events: [wake("evt-1")] }, fixture.ctx), {
			outcome: "waiting",
			programmeId: PROGRAMME_ID,
			reasons: ["claim-active"],
		});
		let snapshot = readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx);
		assert.equal(snapshot.activeClaim?.claimId, claimId);
		assert.deepEqual(snapshot.pendingWakes, [], "the replay did not add a second pending wake");
		assert.deepEqual(snapshot.enrolledSessions, [SESSION], "enrolment stays deduplicated");

		// A different event while the claim is active stays queued.
		assert.deepEqual(admitProgrammeContinuation({ sessionRef: SESSION, owner: "muster", events: [wake("evt-2")] }, fixture.ctx), {
			outcome: "waiting",
			programmeId: PROGRAMME_ID,
			reasons: ["claim-active"],
		});
		snapshot = readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx);
		assert.deepEqual(snapshot.pendingWakes.map((pending) => pending.sourceEventId), ["evt-2"]);

		// Completion releases the claim and records the outcome; the queued event is
		// admitted exactly once afterwards.
		const completed = completeProgrammeContinuation(SESSION, "progressed", fixture.ctx);
		assert.equal(completed?.released, true);
		assert.equal(completed?.runGeneration, 2);
		snapshot = readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx);
		assert.equal(snapshot.activeClaim, null);
		assert.equal(snapshot.lastOutcome?.outcome, "progressed");
		const next = admitProgrammeContinuation({ sessionRef: SESSION, owner: "muster", events: [wake("evt-2")] }, fixture.ctx);
		assert.equal(next.outcome, "admitted");
		assert.notEqual(next.outcome === "admitted" ? next.claimId : "", claimId);
		assert.deepEqual(readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx).pendingWakes, []);
	});
});

test("muster-control-bridge: a recorded wake coalesces with the delivery that admits it", () => {
	withBridge((fixture) => {
		enroll(fixture);
		const event = programmeWakeForDelivery("msg/abc");
		assert.equal(noteProgrammeWake(SESSION, event, fixture.ctx), true);
		assert.equal(noteProgrammeWake(SESSION, event, fixture.ctx), true);
		assert.deepEqual(
			readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx).pendingWakes.map((pending) => pending.sourceEventId),
			["muster-inbox/abc"],
			"duplicate discovery coalesces on the shared delivery identity",
		);
		const admitted = admitProgrammeContinuation({ sessionRef: SESSION, owner: "muster", events: [event] }, fixture.ctx);
		assert.equal(admitted.outcome, "admitted");
		const snapshot = readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx);
		assert.deepEqual(snapshot.pendingWakes, []);
		assert.deepEqual(snapshot.activeClaim?.wakeIds, ["muster-inbox/abc"]);
	});
});

test("muster-control-bridge: a paused programme queues the wake and admits it only after resume", () => {
	withBridge((fixture) => {
		enroll(fixture);
		pauseProgramme(PROGRAMME_ID, "operator pause", fixture.ctx);
		assert.deepEqual(admitProgrammeContinuation({ sessionRef: SESSION, owner: "muster", events: [wake("evt-pause")] }, fixture.ctx), {
			outcome: "denied",
			programmeId: PROGRAMME_ID,
			reason: "programme-paused",
		});
		let snapshot = readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx);
		assert.equal(snapshot.activeClaim, null);
		assert.deepEqual(snapshot.pendingWakes.map((pending) => pending.sourceEventId), ["evt-pause"]);

		// A second event while paused is also queued, not admitted.
		assert.equal(
			admitProgrammeContinuation({ sessionRef: SESSION, owner: "muster", events: [wake("evt-pause-2")] }, fixture.ctx).outcome,
			"denied",
		);
		assert.equal(readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx).pendingWakes.length, 2);

		// Operator resume restores admission; the queued wake is consumed once.
		resumeProgramme(PROGRAMME_ID, "operator", fixture.ctx);
		const admitted = admitProgrammeContinuation({ sessionRef: SESSION, owner: "muster", events: [wake("evt-pause")] }, fixture.ctx);
		assert.equal(admitted.outcome, "admitted");
		snapshot = readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx);
		assert.deepEqual(snapshot.pendingWakes, []);
		assert.equal(snapshot.lastOutcome, null);
	});
});

test("muster-control-bridge: a caller-side hold defers admission and keeps the wake queued", () => {
	withBridge((fixture) => {
		enroll(fixture);
		const busy = admitProgrammeContinuation(
			{ sessionRef: SESSION, owner: "muster", events: [wake("evt-busy")], hold: () => true },
			fixture.ctx,
		);
		assert.deepEqual(busy, { outcome: "deferred", programmeId: PROGRAMME_ID, reason: "session-busy" });
		const snapshot = readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx);
		assert.equal(snapshot.activeClaim, null);
		assert.deepEqual(snapshot.pendingWakes.map((pending) => pending.sourceEventId), ["evt-busy"]);
		// The same event is admitted once the caller reports the session free.
		const admitted = admitProgrammeContinuation(
			{ sessionRef: SESSION, owner: "muster", events: [wake("evt-busy")], hold: () => false },
			fixture.ctx,
		);
		assert.equal(admitted.outcome, "admitted");
		assert.deepEqual(readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx).pendingWakes, []);
	});
});

test("muster-control-bridge: an enrolled empty wake batch is held, never sent unadmitted", () => {
	withBridge((fixture) => {
		enroll(fixture);
		assert.deepEqual(
			admitProgrammeContinuation({ sessionRef: SESSION, owner: "muster", events: [] }, fixture.ctx),
			{ outcome: "unavailable", programmeId: PROGRAMME_ID, reason: "empty wake batch" },
		);
		assert.equal(readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx).activeClaim, null);
	});
});

test("muster-control-bridge: the kill file denies admission without losing the queued wake", () => {
	withBridge((fixture) => {
		enroll(fixture);
		const killFile = fixture.ctx.killFilePath as string;
		writeFileSync(killFile, "", "utf8");
		assert.equal(programmeKillFileActive(fixture.ctx), true);
		assert.deepEqual(admitProgrammeContinuation({ sessionRef: SESSION, owner: "muster", events: [wake("evt-kill")] }, fixture.ctx), {
			outcome: "denied",
			programmeId: PROGRAMME_ID,
			reason: "kill-file",
		});
		assert.deepEqual(
			readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx).pendingWakes.map((pending) => pending.sourceEventId),
			["evt-kill"],
		);
		rmSync(killFile, { force: true });
		assert.equal(admitProgrammeContinuation({ sessionRef: SESSION, owner: "muster", events: [wake("evt-kill")] }, fixture.ctx).outcome, "admitted");
	});
});

// ─── Completion and outcome mapping ──────────────────────────────────────────

test("muster-control-bridge: completion records the outcome and releases the claim exactly once", () => {
	withBridge((fixture) => {
		enroll(fixture);
		const admitted = admitProgrammeContinuation({ sessionRef: SESSION, owner: "muster", events: [wake("evt-done")] }, fixture.ctx);
		assert.equal(admitted.outcome, "admitted");
		const claimId = admitted.outcome === "admitted" ? admitted.claimId : "";
		assert.equal(activeProgrammeContinuation(SESSION)?.claimId, claimId);

		const completed = completeProgrammeContinuation(SESSION, "waiting_worker", fixture.ctx);
		assert.equal(completed?.released, true);
		assert.equal(completed?.outcome, "waiting_worker");
		assert.equal(activeProgrammeContinuation(SESSION), undefined);
		const snapshot = readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx);
		assert.equal(snapshot.activeClaim, null);
		assert.equal(snapshot.lastOutcome?.outcome, "waiting_worker");
		assert.equal(snapshot.lastOutcome?.claimId, claimId);
		assert.equal(snapshot.lastOutcome?.runGeneration, snapshot.runGeneration);

		// The same claim cannot complete twice through the bridge.
		assert.equal(completeProgrammeContinuation(SESSION, "progressed", fixture.ctx), undefined);
		assert.equal(readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx).lastOutcome?.outcome, "waiting_worker");
	});
});

test("muster-control-bridge: run signals map onto the structured continuation outcomes", () => {
	assert.equal(programmeOutcomeFromSignals({}), "progressed");
	assert.equal(programmeOutcomeFromSignals({ stopReason: "stop" }), "progressed");
	assert.equal(programmeOutcomeFromSignals({ workersOutstanding: true }), "waiting_worker");
	assert.equal(programmeOutcomeFromSignals({ stopReason: "aborted", workersOutstanding: true }), "paused");
	assert.equal(programmeOutcomeFromSignals({ stopReason: "error" }), "failed");
});

test("muster-control-bridge: delivery wake identities are stable per delivery key", () => {
	assert.deepEqual(programmeWakeForDelivery("msg/123"), {
		kind: "handoff",
		sourceEventId: "muster-inbox/123",
		reason: "muster inbox delivery 123",
	});
	assert.deepEqual(programmeWakeForDelivery("task-event/t1/2/-/handoff_offered"), {
		kind: "handoff",
		sourceEventId: "muster-reconcile/task-event/t1/2/-/handoff_offered",
		reason: "muster task event task-event/t1/2/-/handoff_offered",
	});
});
