import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	attachProgramme,
	beginProgrammeExecution,
	claimContinuation,
	completeContinuation,
	enqueueWake,
	fileProgrammeControlStore,
	ownerFenceSatisfied,
	readProgrammeSnapshot,
	reserveDescendantWriter,
	type ProgrammeControlContext,
} from "../control.ts";
import { admitProgrammeContinuation, resetProgrammeContinuations } from "../control-bridge.ts";

/**
 * AM1.4: takeover is immediate and live workers keep running. Writer
 * reservations and pending wakes survive it. The open continuation claim stays
 * with the run that holds it (review F4): that run settles it by claim id, and
 * the new owner recovers it only once it is stale. Only an unsettled execution
 * ticket of the old owner still blocks, because that is the old session's
 * current tool call settling. This supersedes the 10-02 rule "no hot takeover
 * with live workers".
 */

const ID = "agp_0a1b2c3d4e5f";
const OLD = { sessionId: "old-session", processKey: "pi-1-boot-1", operatorRef: "operator", guarded: true };
const NEW = { sessionId: "new-session", processKey: "pi-2-boot-1", operatorRef: "operator", guarded: true };

function withStore(run: (ctx: ProgrammeControlContext, dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "muster-hot-"));
	resetProgrammeContinuations();
	try {
		run({ store: fileProgrammeControlStore(dir), killFilePath: join(dir, "kill") }, dir);
	} finally {
		resetProgrammeContinuations();
		rmSync(dir, { recursive: true, force: true });
	}
}

test("guarded takeover with two live worker reservations and an open claim keeps all of them, the claim still with its run", () => {
	withStore((ctx) => {
		const first = attachProgramme(ID, OLD, ctx);
		reserveDescendantWriter(ID, "lane:worker-1", "lane", ["src/a.ts"], ctx);
		reserveDescendantWriter(ID, "lane:worker-2", "lane", ["src/b.ts"], ctx);
		enqueueWake(ID, { sourceEventId: "msg/1", kind: "handoff", reason: "handoff offered" }, ctx);
		const claim = claimContinuation(ID, OLD.sessionId, ctx);
		assert.equal(claim.outcome, "admitted");

		const taken = attachProgramme(ID, NEW, ctx);
		assert.equal(taken.takeover, true);
		assert.equal(taken.owner.epoch, first.owner.epoch + 1);

		const record = readProgrammeSnapshot(ID, ctx);
		assert.deepEqual(record.reservedPaths.map((r) => r.ownerRef).sort(), ["lane:worker-1", "lane:worker-2"]);
		assert.equal(record.reservations.length, 2);
		assert.equal(record.activeClaim?.sessionRef, OLD.sessionId, "the claim stays with the run that holds it");
		assert.equal(record.activeClaim?.owner, `lane:${OLD.sessionId}`);
		assert.equal(record.activeClaim?.claimId, (claim as { claimId: string }).claimId, "same claim identity, so the old run can still settle it");
		assert.equal(record.activeClaim?.wakes.length, 1, "wakes consumed by the claim are not lost");
	});
});

test("after takeover the old fence is refused and the new owner waits for a live run's claim instead of starting a second continuation", () => {
	withStore((ctx, dir) => {
		const first = attachProgramme(ID, OLD, ctx);
		enqueueWake(ID, { sourceEventId: "msg/1", kind: "handoff", reason: "handoff offered" }, ctx);
		const claim = claimContinuation(ID, OLD.sessionId, ctx) as { outcome: "admitted"; claimId: string };
		const taken = attachProgramme(ID, NEW, ctx);

		const record = readProgrammeSnapshot(ID, ctx);
		assert.equal(ownerFenceSatisfied(record.owner, { sessionId: OLD.sessionId, processKey: OLD.processKey, epoch: first.owner.epoch }), false);
		assert.equal(ownerFenceSatisfied(record.owner, { sessionId: NEW.sessionId, processKey: NEW.processKey, epoch: taken.owner.epoch }), true);

		const admission = admitProgrammeContinuation(
			{ sessionRef: NEW.sessionId, owner: "muster", events: [{ sourceEventId: "msg/2", kind: "handoff", reason: "next" }] },
			{ ...ctx, controlDir: dir, processKey: NEW.processKey },
		);
		assert.notEqual(admission.outcome, "admitted", JSON.stringify(admission));
		assert.equal(readProgrammeSnapshot(ID, ctx).activeClaim?.claimId, claim.claimId, "the live run's claim is untouched");
		// The old run then settles its own claim; its outcome is recorded, not dropped.
		const done = completeContinuation(ID, claim.claimId, "progressed", ctx);
		assert.equal(done.activeClaim, null);
		assert.equal(done.lastOutcome?.claimId, claim.claimId);
	});
});

test("a claim whose run is gone, older than the owner lease, is recovered by the new owner", () => {
	withStore((ctx, dir) => {
		attachProgramme(ID, OLD, ctx);
		enqueueWake(ID, { sourceEventId: "msg/1", kind: "handoff", reason: "handoff offered" }, ctx);
		const claim = claimContinuation(ID, OLD.sessionId, ctx) as { outcome: "admitted"; claimId: string };
		attachProgramme(ID, NEW, ctx);
		const stale = new Date(Date.now() - 60 * 60_000).toISOString();
		ctx.store.update(ID, readProgrammeSnapshot(ID, ctx).revision, (record) => ({
			...record,
			activeClaim: { ...record.activeClaim!, admittedAt: stale },
			revision: record.revision + 1,
		}));
		const admission = admitProgrammeContinuation(
			{ sessionRef: NEW.sessionId, owner: "muster", events: [{ sourceEventId: "msg/2", kind: "handoff", reason: "next" }] },
			{ ...ctx, controlDir: dir, processKey: NEW.processKey },
		);
		assert.equal(admission.outcome, "admitted", JSON.stringify(admission));
		assert.equal((admission as { recoveredClaimId?: string }).recoveredClaimId, claim.claimId);
	});
});

test("the old session settling its run after takeover releases the claim without disturbing the new owner", () => {
	withStore((ctx) => {
		attachProgramme(ID, OLD, ctx);
		const claim = claimContinuation(ID, OLD.sessionId, ctx) as { outcome: "admitted"; claimId: string };
		const taken = attachProgramme(ID, NEW, ctx);
		const done = completeContinuation(ID, claim.claimId, "progressed", ctx);
		assert.equal(done.activeClaim, null);
		assert.equal(done.owner?.sessionId, NEW.sessionId);
		assert.equal(done.owner?.epoch, taken.owner.epoch);
	});
});

test("an unsettled execution ticket of the old owner still blocks that takeover", () => {
	withStore((ctx) => {
		const first = attachProgramme(ID, OLD, ctx);
		beginProgrammeExecution(
			ID,
			{ sessionId: OLD.sessionId, processKey: OLD.processKey, epoch: first.owner.epoch, id: "t1", toolName: "bash", admittedAt: new Date().toISOString() },
			ctx,
		);
		assert.throws(() => attachProgramme(ID, NEW, ctx), /unsettled/);
		assert.equal(readProgrammeSnapshot(ID, ctx).owner?.sessionId, OLD.sessionId);
	});
});

test("a legacy owner with no settlement protocol is still refused", () => {
	withStore((ctx) => {
		attachProgramme(ID, { ...OLD, guarded: false }, ctx);
		assert.throws(() => attachProgramme(ID, NEW, ctx), /settlement guarantee/);
	});
});
