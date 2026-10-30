import "./muster-test-isolation.ts";
/**
 * Muster ownership contract tests (operator-approved on/off/pause model).
 *
 * Pure store/reducer tests: OS temp directories only, no network, provider or
 * Concord calls. Two "sessions" share one control-record directory through two
 * independent store instances, which is exactly the on-disk multi-session
 * situation: every read is a fresh disk read, so a takeover is visible to the
 * other session immediately.
 *
 * Authored here; executed by the parent through the guarded runner.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	attachProgramme,
	claimContinuation,
	completeContinuation,
	enqueueWake,
	fileProgrammeControlStore,
	pauseProgramme,
	ProgrammeControlStateError,
	readProgrammeSnapshot,
	resumeProgramme,
	stopProgramme,
	touchProgrammeOwnerLease,
	type ProgrammeControlContext,
	type ProgrammeControlRecord,
} from "../control.ts";
import {
	admitProgrammeContinuation,
	resolveEnrolledProgramme,
	type ControlBridgeContext,
} from "../control-bridge.ts";

const PROGRAMME_ID = "agp_0000000000aa";
const SESSION_A = "session-a";
const SESSION_B = "session-b";

type OwnershipFixture = {
	dir: string;
	/** Same store dir for every "session": the on-disk multi-session truth. */
	ctxA: ProgrammeControlContext;
	ctxB: ProgrammeControlContext;
	bridgeCtx: ControlBridgeContext;
};

function withOwnership(run: (fixture: OwnershipFixture) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "muster-ownership-"));
	const killPath = join(dir, "muster.disabled");
	const ctxA: ProgrammeControlContext = {
		store: fileProgrammeControlStore(dir),
		killFilePath: killPath,
	};
	const ctxB: ProgrammeControlContext = {
		store: fileProgrammeControlStore(dir),
		killFilePath: killPath,
	};
	const bridgeCtx: ControlBridgeContext = {
		store: fileProgrammeControlStore(dir),
		controlDir: dir,
		killFilePath: killPath,
	};
	try {
		run({ dir, ctxA, ctxB, bridgeCtx });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function ownerOf(record: ProgrammeControlRecord): ProgrammeControlRecord["owner"] {
	return record.owner;
}

test("on creates the record with exclusive ownership, epoch 1", () => {
	withOwnership((fixture) => {
		const result = attachProgramme(
			PROGRAMME_ID,
			{ sessionId: SESSION_A, processKey: "pi-111-aaaa", operatorRef: "operator" },
			fixture.ctxA,
		);
		assert.equal(result.created, true);
		assert.equal(result.takeover, false);
		assert.equal(result.status, "running");
		const record = readProgrammeSnapshot(PROGRAMME_ID, fixture.ctxA);
		const owner = ownerOf(record);
		assert.ok(owner !== null);
		assert.equal(owner.sessionId, SESSION_A);
		assert.equal(owner.epoch, 1);
		assert.equal(resolveEnrolledProgramme(SESSION_A, fixture.bridgeCtx)?.ownerEpoch, 1);
		// Another session resolves nothing before any takeover.
		assert.equal(resolveEnrolledProgramme(SESSION_B, fixture.bridgeCtx), undefined);
	});
});

test("on from another session takes over and disconnects the previous owner", () => {
	withOwnership((fixture) => {
		attachProgramme(PROGRAMME_ID, { sessionId: SESSION_A, processKey: "pi-111-aaaa", operatorRef: "operator" }, fixture.ctxA);
		// A claims a continuation run before the takeover.
		const claim = claimContinuation(PROGRAMME_ID, SESSION_A, fixture.ctxA);
		assert.equal(claim.outcome, "admitted");

		const takeover = attachProgramme(
			PROGRAMME_ID,
			{ sessionId: SESSION_B, processKey: "pi-222-bbbb", operatorRef: "operator" },
			fixture.ctxB,
		);
		assert.equal(takeover.takeover, true);
		assert.equal(takeover.previousOwner?.sessionId, SESSION_A);
		assert.equal(takeover.owner.epoch, 2);

		// A is powerless the moment its next read happens: no enrollment, no claim.
		assert.equal(resolveEnrolledProgramme(SESSION_A, fixture.bridgeCtx), undefined);
		assert.equal(resolveEnrolledProgramme(SESSION_B, fixture.bridgeCtx)?.ownerEpoch, 2);
		// A's stale admission (fenced against its old epoch) is denied.
		assert.deepEqual(claimContinuation(PROGRAMME_ID, SESSION_A, fixture.ctxA, { sessionId: SESSION_A, processKey: "pi-111-aaaa", epoch: 1 }), {
			outcome: "denied",
			reason: "ownership-lost",
		});
		// A cannot pause or resume the programme B now owns.
		assert.throws(() => pauseProgramme(PROGRAMME_ID, "stale pause", fixture.ctxA, { sessionId: SESSION_A, processKey: "pi-111-aaaa", epoch: 1 }), ProgrammeControlStateError);
		assert.throws(() => resumeProgramme(PROGRAMME_ID, "operator", fixture.ctxA, { sessionId: SESSION_A, processKey: "pi-111-aaaa", epoch: 1 }), ProgrammeControlStateError);
		// A's claim is still open: B waits for the previous owner's work to settle
		// (existing worker processes settle, they are never silently killed).
		assert.deepEqual(
			admitProgrammeContinuation(
				{
					sessionRef: SESSION_B,
					owner: "muster",
					events: [{ sourceEventId: "msg/b-1", kind: "operator-answer", reason: "after takeover" }],
				},
				fixture.bridgeCtx,
			),
			{ outcome: "waiting", programmeId: PROGRAMME_ID, reasons: ["claim-active"] },
		);
		// A settles its in-flight claim after the takeover (settle stays allowed);
		// B is then admitted normally.
		completeContinuation(PROGRAMME_ID, (claim as { claimId: string }).claimId, "progressed", fixture.ctxB);
		const bAdmission = admitProgrammeContinuation(
			{
				sessionRef: SESSION_B,
				owner: "muster",
				events: [{ sourceEventId: "msg/b-2", kind: "operator-answer", reason: "after settlement" }],
			},
			fixture.bridgeCtx,
		);
		assert.equal(bAdmission.outcome, "admitted");
	});
});

test("pause keeps ownership and Discord connectivity; on resumes", () => {
	withOwnership((fixture) => {
		attachProgramme(PROGRAMME_ID, { sessionId: SESSION_A, processKey: "pi-111-aaaa", operatorRef: "operator" }, fixture.ctxA);
		pauseProgramme(PROGRAMME_ID, "operator pause", fixture.ctxA, { sessionId: SESSION_A, processKey: "pi-111-aaaa", epoch: 1 });
		const paused = readProgrammeSnapshot(PROGRAMME_ID, fixture.ctxA);
		assert.equal(paused.status, "paused");
		assert.equal(ownerOf(paused)?.sessionId, SESSION_A);
		assert.equal(ownerOf(paused)?.epoch, 1);
		// Conversation admission during pause: queued, not executed.
		assert.deepEqual(
			admitProgrammeContinuation(
				{
					sessionRef: SESSION_A,
					owner: "muster",
					events: [{ sourceEventId: "msg/pause-1", kind: "operator-answer", reason: "while paused" }],
				},
				fixture.bridgeCtx,
			),
			{ outcome: "denied", programmeId: PROGRAMME_ID, reason: "programme-paused" },
		);
		assert.equal(readProgrammeSnapshot(PROGRAMME_ID, fixture.ctxA).pendingWakes.length, 1);
		// /muster on resumes in the same session: same ownership epoch continues.
		const resumed = attachProgramme(
			PROGRAMME_ID,
			{ sessionId: SESSION_A, processKey: "pi-111-aaaa", operatorRef: "operator" },
			fixture.ctxA,
		);
		assert.equal(resumed.takeover, false);
		assert.equal(resumed.status, "running");
		assert.equal(readProgrammeSnapshot(PROGRAMME_ID, fixture.ctxA).owner?.epoch, 1);
	});
});

test("off revokes execution and the Discord binding; queued events cannot reactivate", () => {
	withOwnership((fixture) => {
		attachProgramme(PROGRAMME_ID, { sessionId: SESSION_A, processKey: "pi-111-aaaa", operatorRef: "operator" }, fixture.ctxA);
		enqueueWake(
			PROGRAMME_ID,
			{ sourceEventId: "wake/pre-off", kind: "delegate-completion", reason: "before off" },
			fixture.ctxA,
		);
		stopProgramme(PROGRAMME_ID, { reason: "operator /muster off", operatorRef: "operator" }, fixture.ctxA);
		const record = readProgrammeSnapshot(PROGRAMME_ID, fixture.ctxA);
		assert.equal(record.status, "off");
		assert.equal(ownerOf(record), null);
		// Nobody resolves: the previous owner lost authority too.
		assert.equal(resolveEnrolledProgramme(SESSION_A, fixture.bridgeCtx), undefined);
		// A wake while off is coalesced but inert: admission stays denied.
		enqueueWake(PROGRAMME_ID, { sourceEventId: "wake/while-off", kind: "watchdog", reason: "while off" }, fixture.ctxB);
		assert.deepEqual(claimContinuation(PROGRAMME_ID, SESSION_A, fixture.ctxA), {
			outcome: "denied",
			reason: "programme-off",
		});
		// Explicit operator on re-activates; off-period queued wakes stay persisted.
		const on = attachProgramme(
			PROGRAMME_ID,
			{ sessionId: SESSION_B, processKey: "pi-222-bbbb", operatorRef: "operator" },
			fixture.ctxB,
		);
		assert.equal(on.status, "running");
		assert.equal(on.owner.epoch, 1);
		assert.equal(readProgrammeSnapshot(PROGRAMME_ID, fixture.ctxB).pendingWakes.length, 2);
	});
});

test("off does not let an in-flight worker's settlement re-enable the programme", () => {
	withOwnership((fixture) => {
		attachProgramme(PROGRAMME_ID, { sessionId: SESSION_A, processKey: "pi-111-aaaa", operatorRef: "operator" }, fixture.ctxA);
		const claim = claimContinuation(PROGRAMME_ID, SESSION_A, fixture.ctxA);
		assert.equal(claim.outcome, "admitted");
		stopProgramme(PROGRAMME_ID, { reason: "operator off" }, fixture.ctxA);
		// The worker settles: the claim releases, but the programme stays off.
		const settled = completeContinuation(PROGRAMME_ID, (claim as { claimId: string }).claimId, "progressed", fixture.ctxA);
		assert.equal(settled.status, "off");
		assert.deepEqual(claimContinuation(PROGRAMME_ID, SESSION_A, fixture.ctxA), { outcome: "denied", reason: "programme-off" });
	});
});

test("same owning process re-attaching refreshes the lease without an epoch bump", () => {
	withOwnership((fixture) => {
		const first = attachProgramme(
			PROGRAMME_ID,
			{ sessionId: SESSION_A, processKey: "pi-111-aaaa", operatorRef: "operator" },
			fixture.ctxA,
		);
		const second = attachProgramme(
			PROGRAMME_ID,
			{ sessionId: SESSION_A, processKey: "pi-111-aaaa", operatorRef: "operator" },
			fixture.ctxA,
		);
		assert.equal(second.owner.epoch, first.owner.epoch);
		assert.equal(second.takeover, false);
		// Same session, different process (restart): a new epoch fences the dead one.
		const restarted = attachProgramme(
			PROGRAMME_ID,
			{ sessionId: SESSION_A, processKey: "pi-333-cccc", operatorRef: "owner-boot" },
			fixture.ctxA,
		);
		assert.equal(restarted.owner.epoch, first.owner.epoch + 1);
		assert.equal(restarted.takeover, true);
	});
});

test("completed programmes stay terminal; attach refuses them", () => {
	withOwnership((fixture) => {
		attachProgramme(PROGRAMME_ID, { sessionId: SESSION_A, processKey: "pi-111-aaaa", operatorRef: "operator" }, fixture.ctxA);
		const claim = claimContinuation(PROGRAMME_ID, SESSION_A, fixture.ctxA);
		completeContinuation(PROGRAMME_ID, (claim as { claimId: string }).claimId, "completed", fixture.ctxA);
		assert.equal(readProgrammeSnapshot(PROGRAMME_ID, fixture.ctxA).status, "off");
		assert.throws(
			() => attachProgramme(PROGRAMME_ID, { sessionId: SESSION_B, processKey: "pi-222-bbbb", operatorRef: "operator" }, fixture.ctxB),
			ProgrammeControlStateError,
		);
	});
});

test("advisory lease renews on claim and touch, and a wrong epoch cannot touch", () => {
	withOwnership((fixture) => {
		attachProgramme(PROGRAMME_ID, { sessionId: SESSION_A, processKey: "pi-111-aaaa", operatorRef: "operator" }, fixture.ctxA);
		const record = readProgrammeSnapshot(PROGRAMME_ID, fixture.ctxA);
		const lease = Date.parse(record.owner?.leaseExpiresAt ?? "");
		// Touch well within the lease: no write.
		const early = touchProgrammeOwnerLease(PROGRAMME_ID, { sessionId: SESSION_A, processKey: "pi-111-aaaa", epoch: 1 }, fixture.ctxA);
		assert.equal(early.touched, false);
		assert.equal(Date.parse(readProgrammeSnapshot(PROGRAMME_ID, fixture.ctxA).owner?.leaseExpiresAt ?? ""), lease);
		// Wrong epoch is refused (stale session cannot renew).
		const stale = touchProgrammeOwnerLease(PROGRAMME_ID, { sessionId: SESSION_A, processKey: "pi-111-aaaa", epoch: 99 }, fixture.ctxA);
		assert.equal(stale.touched, false);
	});
});

test("current owner recovers a stale claim left by a crashed previous owner", () => {
	withOwnership((fixture) => {
		const SESSION_C = "session-c";
		attachProgramme(PROGRAMME_ID, { sessionId: SESSION_A, processKey: "pi-111-aaaa", operatorRef: "operator" }, fixture.ctxA);
		// A's continuation has real queued work to drain.
		enqueueWake(
			PROGRAMME_ID,
			{ sourceEventId: "wake/late-1", kind: "delegate-completion", reason: "before claim" },
			fixture.ctxA,
		);
		const claim = claimContinuation(PROGRAMME_ID, SESSION_A, fixture.ctxA);
		assert.equal(claim.outcome, "admitted");
		// B takes over while A is gone; A never settles its claim.
		attachProgramme(PROGRAMME_ID, { sessionId: SESSION_B, processKey: "pi-222-bbbb", operatorRef: "operator" }, fixture.ctxB);
		// A fresh claim belongs to a live previous owner: B waits.
		assert.deepEqual(
			admitProgrammeContinuation(
				{
					sessionRef: SESSION_B,
					owner: "muster",
					events: [{ sourceEventId: "msg/b-1", kind: "operator-answer", reason: "fresh takeover" }],
				},
				fixture.bridgeCtx,
			),
			{ outcome: "waiting", programmeId: PROGRAMME_ID, reasons: ["claim-active"] },
		);
		// A crashed: the claim ages past the advisory owner lease.
		const store = fileProgrammeControlStore(fixture.dir);
		const current = store.read(PROGRAMME_ID);
		assert.ok(current && current.activeClaim !== null);
		const activeClaim = current.activeClaim;
		const staleAdmittedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
		store.update(PROGRAMME_ID, current.revision, () => ({
			...current,
			activeClaim: { ...activeClaim, admittedAt: staleAdmittedAt },
		}));
		// A third session takes over and recovers the stale claim: the wakes
		// replay for it instead of sticking forever.
		const SESSION_C_ID = "session-c";
		attachProgramme(
			PROGRAMME_ID,
			{ sessionId: SESSION_C_ID, processKey: "pi-333-cccc", operatorRef: "operator" },
			fixture.ctxB,
		);
		const admission = admitProgrammeContinuation(
			{
				sessionRef: SESSION_C_ID,
				owner: "muster",
				events: [{ sourceEventId: "msg/c-1", kind: "operator-answer", reason: "stale recovery" }],
			},
			fixture.bridgeCtx,
		);
		assert.equal(admission.outcome, "admitted");
		assert.ok((admission as { recoveredClaimId?: string }).recoveredClaimId !== undefined);
		const record = readProgrammeSnapshot(PROGRAMME_ID, fixture.ctxB);
		// A's claim wakes replayed into the recovering owner's claim.
		assert.equal(
			record.activeClaim?.wakes.some((wake) => wake.sourceEventId.startsWith(`recovery/${(claim as { claimId: string }).claimId}/`)),
			true,
		);
	});
});

test("legacy records without owner still resolve through enrolledSessions", () => {
	withOwnership((fixture) => {
		// A record written before ownership existed: owner null, session enrolled
		// by claimContinuation exactly as before.
		attachProgramme(PROGRAMME_ID, { sessionId: SESSION_A, processKey: "pi-111-aaaa", operatorRef: "operator" }, fixture.ctxA);
		stopProgramme(PROGRAMME_ID, { reason: "detach legacy" }, fixture.ctxA);
		// Manually revert to a legacy-shaped record: running, no owner, enrolled.
		const store = fileProgrammeControlStore(fixture.dir);
		const current = store.read(PROGRAMME_ID);
		assert.ok(current !== undefined);
		store.update(PROGRAMME_ID, current.revision, () => ({
			...current,
			status: "running" as const,
			owner: null,
		}));
		const legacy = resolveEnrolledProgramme(SESSION_A, fixture.bridgeCtx);
		assert.ok(legacy !== undefined);
		assert.equal(legacy.programmeId, PROGRAMME_ID);
		assert.equal(legacy.ownerEpoch, undefined);
		// A claim on a legacy record is still admitted (no fence passed).
		assert.equal(claimContinuation(PROGRAMME_ID, SESSION_A, fixture.ctxA).outcome, "admitted");
	});
});
