import "./muster-test-isolation.ts";
/**
 * Model-free regressions for the P1.1 programme continuation control record
 * (plan §7 P1.1, §3 continuation admission).
 *
 * Pure store/reducer tests: OS temp directories only, no network, provider or
 * Concord calls. The kill file is a local temp file and the store is an
 * explicit per-test `fileProgrammeControlStore(dir)`; nothing here touches
 * `~/.pi/agent/state`.
 *
 * Authored here; executed by the parent through the guarded runner.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as control from "../control.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	ProgrammeControlStateError,
	applyDecisionRef,
	claimContinuation,
	completeContinuation,
	enqueueWake,
	fileProgrammeControlStore,
	pauseProgramme,
	programmeControlKillFilePaths,
	readProgrammeSnapshot,
	recordDecisionRef,
	readParentWriteBudgetLines,
	recordParentWriteBudgetLines,
	releaseWriter,
	reserveWriter,
	resumeProgramme,
	startProgramme,
	validateProgrammeControlRecord,
	type ProgrammeControlContext,
	type ProgrammeControlRecord,
} from "../control.ts";

const PROGRAMME_ID = "agp_0123456789ab";

type ControlFixture = {
	dir: string;
	ctx: ProgrammeControlContext;
};

function withControl(run: (fixture: ControlFixture) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "muster-control-"));
	const ctx: ProgrammeControlContext = {
		store: fileProgrammeControlStore(dir),
		killFilePath: join(dir, "muster.disabled"),
	};
	try {
		run({ dir, ctx });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function started(fixture: ControlFixture, options?: { ceiling?: number }): ProgrammeControlRecord {
	return startProgramme(PROGRAMME_ID, { operatorRef: "operator", ...(options ?? {}) }, fixture.ctx);
}

function controlError(code: ProgrammeControlStateError["code"], run: () => unknown): void {
	let caught: unknown;
	try {
		run();
	} catch (error) {
		caught = error;
	}
	if (!(caught instanceof ProgrammeControlStateError)) {
		assert.fail(
			`expected a ProgrammeControlStateError(${code}), got: ${caught === undefined ? "no error" : String(caught)}`,
		);
	}
	assert.equal(caught.code, code, caught.message);
}

function recordPath(dir: string): string {
	return join(dir, `${PROGRAMME_ID}.json`);
}

// ─── Creation, persistence and fresh reads ───────────────────────────────────

test("F7: parent write budgets persist across store instances and stay keyed by task and path", () => {
	withControl((fixture) => {
		started(fixture);
		assert.equal(recordParentWriteBudgetLines(PROGRAMME_ID, "T-1", "src/main.ts", 2, 4, fixture.ctx), 2);
		assert.equal(recordParentWriteBudgetLines(PROGRAMME_ID, "T-1", "src/main.ts", 2, 4, fixture.ctx), 4);
		controlError("conflict", () => recordParentWriteBudgetLines(PROGRAMME_ID, "T-1", "src/main.ts", 1, 4, fixture.ctx));
		const reopened = { ...fixture.ctx, store: fileProgrammeControlStore(fixture.dir) };
		assert.equal(readParentWriteBudgetLines(PROGRAMME_ID, "T-1", "src/main.ts", reopened), 4);
		assert.equal(readParentWriteBudgetLines(PROGRAMME_ID, "T-2", "src/main.ts", reopened), 0);
		assert.equal(readParentWriteBudgetLines(PROGRAMME_ID, "T-1", "src/other.ts", reopened), 0);
		const legacy = { ...readProgrammeSnapshot(PROGRAMME_ID, reopened) } as Record<string, unknown>;
		delete legacy["parentWriteBudgets"];
		delete legacy["laneLaunches"];
		const migrated = validateProgrammeControlRecord(legacy);
		assert.equal(migrated.ok, true);
		if (migrated.ok) {
			assert.deepEqual(migrated.record.parentWriteBudgets, []);
			assert.deepEqual(migrated.record.laneLaunches, []);
		}
	});
});

test("F13: failed lane launches retain their exact resource identity in programme control", () => {
	withControl((fixture) => {
		started(fixture);
		const ownerRef = "lane:worker-attempt-a";
		reserveWriter(PROGRAMME_ID, ownerRef, fixture.ctx);
		const recordLaunch = (control as unknown as { recordLaneLaunch: (programmeId: string, ownerRef: string, patch: Record<string, unknown>, context: ProgrammeControlContext) => unknown }).recordLaneLaunch;
		recordLaunch(PROGRAMME_ID, ownerRef, { taskId: "T1", attemptId: "attempt-a", agentName: "worker-attempt-a", phase: "reserved", checkoutRoot: "/tmp/integration" }, fixture.ctx);
		recordLaunch(PROGRAMME_ID, ownerRef, { taskId: "T1", attemptId: "attempt-a", agentName: "worker-attempt-a", phase: "worktree-ready", worktreePath: "/tmp/lanes/agp/T1/attempt-a", branch: "muster/agp/T1/attempt-a", baseSha: "a".repeat(40) }, fixture.ctx);
		recordLaunch(PROGRAMME_ID, ownerRef, { taskId: "T1", attemptId: "attempt-a", agentName: "worker-attempt-a", phase: "failed", failureStep: "herdr-agent-start", paneId: "pane-owned-1", paneClosed: true }, fixture.ctx);
		const reopened = { ...fixture.ctx, store: fileProgrammeControlStore(fixture.dir) };
		const launch = readProgrammeSnapshot(PROGRAMME_ID, reopened).laneLaunches[0];
		assert.equal(launch?.phase, "failed"); assert.equal(launch?.taskId, "T1"); assert.equal(launch?.attemptId, "attempt-a");
		assert.equal(launch?.worktreePath, "/tmp/lanes/agp/T1/attempt-a"); assert.equal(launch?.branch, "muster/agp/T1/attempt-a"); assert.equal(launch?.paneId, "pane-owned-1"); assert.equal(launch?.paneClosed, true);
		assert.equal(readProgrammeSnapshot(PROGRAMME_ID, reopened).reservations[0]?.ownerRef, ownerRef, "failed launch remains attached to its writer reservation for reconciliation");
	});
});

test("muster-control: startProgramme creates a running record with operator provenance and is idempotent", () => {
	withControl((fixture) => {
		const record = started(fixture);
		assert.equal(record.schemaVersion, 1);
		assert.equal(record.status, "running");
		assert.equal(record.runGeneration, 1);
		assert.equal(record.ceiling, 5, "default delivery capacity includes descendant writers");
		assert.equal(record.pauseReason, null);
		assert.deepEqual(record.enrolledSessions, []);
		assert.deepEqual(record.pendingWakes, []);
		assert.equal(record.activeClaim, null);
		assert.deepEqual(record.reservations, []);
		assert.deepEqual(record.decisionRefs, []);
		assert.deepEqual(record.operatorActions, [
			{ action: "start", operatorRef: "operator", at: record.createdAt, fromStatus: "off", toStatus: "running" },
		]);

		const again = startProgramme(PROGRAMME_ID, { operatorRef: "operator" }, fixture.ctx);
		assert.equal(again.revision, record.revision, "an already-running programme is not rewritten");
		assert.equal(readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx).revision, record.revision);
	});
});

test("muster-control: readProgrammeSnapshot re-reads disk on every call (never cached)", () => {
	withControl((fixture) => {
		started(fixture);
		const path = recordPath(fixture.dir);
		const external = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		external.updatedAt = "2099-01-01T00:00:00.000Z";
		external.revision = Number(external.revision) + 1;
		writeFileSync(path, JSON.stringify(external, null, 2), "utf8");

		assert.equal(readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx).updatedAt, "2099-01-01T00:00:00.000Z");
	});
});

// ─── Wake deduplication ──────────────────────────────────────────────────────

test("muster-control: duplicate wake events coalesce to one pending entry and persist before returning", () => {
	withControl((fixture) => {
		started(fixture);
		const event = { sourceEventId: "evt-1", kind: "handoff" as const, reason: "worker offered the story" };

		assert.deepEqual(enqueueWake(PROGRAMME_ID, event, fixture.ctx), { outcome: "enqueued", pendingWakeCount: 1 });
		// A fresh store instance proves the wake reached disk before returning.
		assert.equal(fileProgrammeControlStore(fixture.dir).read(PROGRAMME_ID)?.pendingWakes.length, 1);

		assert.deepEqual(
			enqueueWake(PROGRAMME_ID, { ...event, reason: "replayed delivery" }, fixture.ctx),
			{ outcome: "coalesced", pendingWakeCount: 1 },
		);
		const snapshot = readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx);
		assert.equal(snapshot.pendingWakes.length, 1);
		assert.equal(snapshot.pendingWakes[0].reason, "worker offered the story", "the first reason wins");

		// Consumption by an active claim is also remembered: the replay coalesces
		// instead of queueing a second continuation.
		const admitted = claimContinuation(PROGRAMME_ID, "session-a", fixture.ctx);
		assert.equal(admitted.outcome, "admitted");
		assert.deepEqual(enqueueWake(PROGRAMME_ID, event, fixture.ctx), { outcome: "coalesced", pendingWakeCount: 0 });
	});
});

// ─── Malformed state ─────────────────────────────────────────────────────────

test("muster-control: malformed disk state raises a typed error and is never reset to defaults", () => {
	withControl((fixture) => {
		const path = recordPath(fixture.dir);
		const corrupt = "{ this is not json";
		writeFileSync(path, corrupt, "utf8");

		controlError("malformed", () => readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx));
		controlError("malformed", () =>
			enqueueWake(PROGRAMME_ID, { sourceEventId: "evt-1", kind: "watchdog", reason: "poll" }, fixture.ctx),
		);
		controlError("malformed", () => startProgramme(PROGRAMME_ID, { operatorRef: "operator" }, fixture.ctx));
		assert.equal(readFileSync(path, "utf8"), corrupt, "the corrupt file is preserved for inspection");

		// Structurally valid JSON of the wrong shape fails closed the same way.
		writeFileSync(path, JSON.stringify({ schemaVersion: 1, programmeId: PROGRAMME_ID }), "utf8");
		controlError("malformed", () => readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx));
	});
});

test("muster-control: a record with unknown fields is rejected, not treated as authority", () => {
	withControl((fixture) => {
		const record = started(fixture);
		const withExtra = { ...record, surpriseAuthority: true };
		const validated = validateProgrammeControlRecord(withExtra);
		assert.equal(validated.ok, false);
		if (!validated.ok) assert.ok(validated.errors.some((error) => error.includes("unknown fields: surpriseAuthority")));

		writeFileSync(recordPath(fixture.dir), JSON.stringify(withExtra), "utf8");
		controlError("malformed", () => readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx));
	});
});

// ─── Claims ──────────────────────────────────────────────────────────────────

test("muster-control: the first claim is admitted and a competing claim waits with a reason", () => {
	withControl((fixture) => {
		started(fixture);
		const first = claimContinuation(PROGRAMME_ID, "session-a", fixture.ctx);
		assert.equal(first.outcome, "admitted");
		if (first.outcome !== "admitted") return;
		assert.ok(first.claimId.startsWith("clm_"), `claim id must be allocated, got ${first.claimId}`);

		// A competing claim cannot be admitted while the first holds the claim.
		assert.deepEqual(claimContinuation(PROGRAMME_ID, "session-b", fixture.ctx), {
			outcome: "waiting",
			reasons: ["claim-active"],
		});

		const snapshot = readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx);
		assert.equal(snapshot.activeClaim?.claimId, first.claimId);
		assert.equal(snapshot.activeClaim?.sessionRef, "session-a");
		assert.equal(snapshot.activeClaim?.runGeneration, 1);
		assert.deepEqual(snapshot.enrolledSessions, ["session-a"]);
	});
});

test("muster-control: completeContinuation releases the claim, records the outcome and rejects a double complete", () => {
	withControl((fixture) => {
		started(fixture);
		const claim = claimContinuation(PROGRAMME_ID, "session-a", fixture.ctx);
		assert.equal(claim.outcome, "admitted");
		if (claim.outcome !== "admitted") return;

		const completed = completeContinuation(PROGRAMME_ID, claim.claimId, "waiting_decision", fixture.ctx);
		assert.equal(completed.activeClaim, null);
		assert.equal(completed.status, "waiting", "only human decisions remain");
		assert.equal(completed.runGeneration, 2);
		assert.deepEqual(completed.lastOutcome, {
			outcome: "waiting_decision",
			claimId: claim.claimId,
			runGeneration: 2,
			completedAt: completed.updatedAt,
		});

		controlError("conflict", () => completeContinuation(PROGRAMME_ID, claim.claimId, "progressed", fixture.ctx));
		controlError("conflict", () => completeContinuation(PROGRAMME_ID, "clm_does_not_exist", "progressed", fixture.ctx));

		// `waiting` is visible and recoverable only by an operator action, never by
		// an agent wake or a new claim.
		assert.deepEqual(claimContinuation(PROGRAMME_ID, "session-a", fixture.ctx), {
			outcome: "waiting",
			reasons: ["programme-waiting"],
		});
		const resumed = resumeProgramme(PROGRAMME_ID, "operator", fixture.ctx);
		assert.equal(resumed.status, "running");
		const nextClaim = claimContinuation(PROGRAMME_ID, "session-a", fixture.ctx);
		assert.equal(nextClaim.outcome, "admitted");
		assert.equal(readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx).status, "running");
	});
});

test("muster-control: a failed run keeps the programme enabled for deterministic reconciliation", () => {
	withControl((fixture) => {
		started(fixture);
		const claim = claimContinuation(PROGRAMME_ID, "session-a", fixture.ctx);
		if (claim.outcome !== "admitted") throw new Error("expected an admitted claim");
		const failed = completeContinuation(PROGRAMME_ID, claim.claimId, "failed", fixture.ctx);
		assert.equal(failed.status, "running");
		assert.equal(failed.lastOutcome?.outcome, "failed");
		assert.equal(claimContinuation(PROGRAMME_ID, "session-a", fixture.ctx).outcome, "admitted");
	});
});

test("muster-control: run generation is monotonic and a newer generation claims after an older completion", () => {
	withControl((fixture) => {
		assert.equal(started(fixture).runGeneration, 1);
		const generations: number[] = [];
		for (let index = 0; index < 3; index += 1) {
			const claim = claimContinuation(PROGRAMME_ID, "session-a", fixture.ctx);
			assert.equal(claim.outcome, "admitted", `claim ${index} must be admitted after the previous generation completed`);
			if (claim.outcome !== "admitted") return;
			generations.push(readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx).activeClaim?.runGeneration ?? -1);
			const completed = completeContinuation(PROGRAMME_ID, claim.claimId, "progressed", fixture.ctx);
			generations.push(completed.runGeneration);
		}
		for (let index = 2; index < generations.length; index += 2) {
			assert.ok(generations[index] > generations[index - 2], `completed generations must strictly increase: ${generations.join(", ")}`);
		}
		for (let index = 1; index < generations.length; index += 2) {
			assert.equal(generations[index], generations[index - 1] + 1, `completing bumps the generation by exactly one over the claim it closes: ${generations.join(", ")}`);
		}
		assert.deepEqual(generations, [1, 2, 2, 3, 3, 4]);
	});
});

test("muster-control: the completed outcome ends the programme and denies further continuation", () => {
	withControl((fixture) => {
		started(fixture);
		const claim = claimContinuation(PROGRAMME_ID, "session-a", fixture.ctx);
		if (claim.outcome !== "admitted") throw new Error("expected an admitted claim");
		const completed = completeContinuation(PROGRAMME_ID, claim.claimId, "completed", fixture.ctx);
		assert.equal(completed.status, "off");
		assert.deepEqual(claimContinuation(PROGRAMME_ID, "session-a", fixture.ctx), {
			outcome: "denied",
			reason: "programme-off",
		});

		const restarted = startProgramme(PROGRAMME_ID, { operatorRef: "operator" }, fixture.ctx);
		assert.equal(restarted.status, "running");
		assert.ok(restarted.runGeneration >= completed.runGeneration, "restart never rewinds the generation");
		assert.equal(claimContinuation(PROGRAMME_ID, "session-a", fixture.ctx).outcome, "admitted");
	});
});

// ─── Pause / resume / kill file ──────────────────────────────────────────────

test("muster-control: paused programmes deny continuation until an operator resume", () => {
	withControl((fixture) => {
		started(fixture);
		controlError("io", () => pauseProgramme(PROGRAMME_ID, "  ", fixture.ctx));

		const paused = pauseProgramme(PROGRAMME_ID, "operator requested a hold", fixture.ctx);
		assert.equal(paused.status, "paused");
		assert.equal(paused.pauseReason, "operator requested a hold");
		assert.deepEqual(claimContinuation(PROGRAMME_ID, "session-a", fixture.ctx), {
			outcome: "denied",
			reason: "programme-paused",
		});

		// Agents must not be able to auto-resume: an empty operator identity is
		// rejected before any mutation.
		controlError("io", () => resumeProgramme(PROGRAMME_ID, "", fixture.ctx));
		controlError("io", () => resumeProgramme(PROGRAMME_ID, "   ", fixture.ctx));
		assert.equal(readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx).status, "paused", "a rejected resume changes nothing");

		const resumed = resumeProgramme(PROGRAMME_ID, "operator", fixture.ctx);
		assert.equal(resumed.status, "running");
		assert.equal(resumed.pauseReason, null);
		const last = resumed.operatorActions[resumed.operatorActions.length - 1];
		assert.equal(last.action, "resume");
		assert.equal(last.operatorRef, "operator", "the resume record carries the operator identity");
		assert.equal(claimContinuation(PROGRAMME_ID, "session-a", fixture.ctx).outcome, "admitted");
	});
});

test("muster-control: start requires an operator and cannot bypass an operator pause", () => {
	withControl((fixture) => {
		controlError("io", () => startProgramme(PROGRAMME_ID, { operatorRef: "  " }, fixture.ctx));
		controlError("io", () => startProgramme(PROGRAMME_ID, { operatorRef: "operator", ceiling: 0 }, fixture.ctx));
		started(fixture);
		pauseProgramme(PROGRAMME_ID, "hold", fixture.ctx);
		controlError("conflict", () => startProgramme(PROGRAMME_ID, { operatorRef: "operator" }, fixture.ctx));
	});
});

test("muster-control: the operator kill file denies continuation and removal re-admits", () => {
	withControl((fixture) => {
		started(fixture);
		const killPath = join(fixture.dir, "muster.disabled");
		writeFileSync(killPath, "", "utf8");
		assert.deepEqual(claimContinuation(PROGRAMME_ID, "session-a", fixture.ctx), {
			outcome: "denied",
			reason: "kill-file",
		});
		rmSync(killPath, { force: true });
		assert.equal(claimContinuation(PROGRAMME_ID, "session-a", fixture.ctx).outcome, "admitted");
	});
});

test("muster-control: kill-file resolution covers the documented path and the breaker path", () => {
	const paths = programmeControlKillFilePaths();
	assert.equal(new Set(paths).size, paths.length, "no duplicate paths");
	assert.ok(paths.some((path) => path.endsWith(join("state", "muster.disabled"))));
	assert.ok(paths.some((path) => path.endsWith(join("state", "muster", "muster.disabled"))));
});

// ─── Writer ceiling ──────────────────────────────────────────────────────────

test("muster-control: default admits five worker writers and refuses a sixth", () => {
	withControl((fixture) => {
		started(fixture);
		for (let i = 1; i <= 5; i += 1) {
			assert.deepEqual(reserveWriter(PROGRAMME_ID, `lane-${i}`, fixture.ctx), { outcome: "admitted", activeReservations: i });
		}
		assert.deepEqual(reserveWriter(PROGRAMME_ID, "lane-6", fixture.ctx), { outcome: "denied", reason: "ceiling", activeReservations: 5 });
		releaseWriter(PROGRAMME_ID, "lane-1", fixture.ctx);
		assert.equal(reserveWriter(PROGRAMME_ID, "lane-6", fixture.ctx).outcome, "admitted");
	});
});

test("muster-control: writer reservations admit up to the ceiling, deny the next and re-admit after release", () => {
	withControl((fixture) => {
		started(fixture, { ceiling: 2 });
		assert.deepEqual(reserveWriter(PROGRAMME_ID, "lane-a", fixture.ctx), { outcome: "admitted", activeReservations: 1 });
		assert.deepEqual(reserveWriter(PROGRAMME_ID, "lane-b", fixture.ctx), { outcome: "admitted", activeReservations: 2 });
		assert.deepEqual(reserveWriter(PROGRAMME_ID, "lane-b", fixture.ctx), {
			outcome: "admitted",
			activeReservations: 2,
		}, "re-reserving the same owner never consumes a second slot");
		assert.deepEqual(reserveWriter(PROGRAMME_ID, "lane-c", fixture.ctx), {
			outcome: "denied",
			reason: "ceiling",
			activeReservations: 2,
		});

		// A full ceiling is an admission input too: continuation waits, not denies.
		assert.deepEqual(claimContinuation(PROGRAMME_ID, "session-a", fixture.ctx), {
			outcome: "waiting",
			reasons: ["capacity"],
		});

		assert.deepEqual(releaseWriter(PROGRAMME_ID, "lane-a", fixture.ctx), { released: true, activeReservations: 1 });
		assert.deepEqual(releaseWriter(PROGRAMME_ID, "lane-a", fixture.ctx), {
			released: false,
			activeReservations: 1,
		}, "releasing an unreserved owner is an idempotent no-op");
		assert.deepEqual(reserveWriter(PROGRAMME_ID, "lane-c", fixture.ctx), { outcome: "admitted", activeReservations: 2 });
	});
});

// ─── Human decisions ─────────────────────────────────────────────────────────

test("muster-control: blocking open decisions hold continuation, non-blocking ones do not", () => {
	withControl((fixture) => {
		started(fixture);
		recordDecisionRef(PROGRAMME_ID, { decisionId: "dec_1" }, fixture.ctx);
		recordDecisionRef(PROGRAMME_ID, { decisionId: "dec_2", blocking: false }, fixture.ctx);
		assert.deepEqual(claimContinuation(PROGRAMME_ID, "session-a", fixture.ctx), {
			outcome: "waiting",
			reasons: ["decision-pending"],
		});

		controlError("io", () => applyDecisionRef(PROGRAMME_ID, "dec_1", { operatorRef: "" }, fixture.ctx));
		assert.deepEqual(claimContinuation(PROGRAMME_ID, "session-a", fixture.ctx), {
			outcome: "waiting",
			reasons: ["decision-pending"],
		}, "a rejected apply changes nothing");

		applyDecisionRef(PROGRAMME_ID, "dec_1", { operatorRef: "operator" }, fixture.ctx);
		const snapshot = readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx);
		const applied = snapshot.decisionRefs.find((ref) => ref.decisionId === "dec_1");
		assert.equal(applied?.status, "applied");
		assert.equal(applied?.appliedBy, "operator");
		assert.equal(claimContinuation(PROGRAMME_ID, "session-a", fixture.ctx).outcome, "admitted");
		controlError("conflict", () => applyDecisionRef(PROGRAMME_ID, "dec_missing", { operatorRef: "operator" }, fixture.ctx));
	});
});

test("muster-control: applying the last blocking decision returns a waiting programme to running", () => {
	withControl((fixture) => {
		started(fixture);
		const claim = claimContinuation(PROGRAMME_ID, "session-a", fixture.ctx);
		if (claim.outcome !== "admitted") throw new Error("expected an admitted claim");
		completeContinuation(PROGRAMME_ID, claim.claimId, "waiting_decision", fixture.ctx);
		assert.equal(readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx).status, "waiting");

		recordDecisionRef(PROGRAMME_ID, { decisionId: "dec_1" }, fixture.ctx);
		assert.deepEqual(claimContinuation(PROGRAMME_ID, "session-a", fixture.ctx), {
			outcome: "waiting",
			reasons: ["decision-pending"],
		});

		const applied = applyDecisionRef(PROGRAMME_ID, "dec_1", { operatorRef: "operator" }, fixture.ctx);
		assert.equal(applied.status, "running");
		assert.equal(claimContinuation(PROGRAMME_ID, "session-a", fixture.ctx).outcome, "admitted");
	});
});

// ─── Missing / invalid input ─────────────────────────────────────────────────

test("muster-control: missing records raise the typed missing error and invalid ids are rejected", () => {
	withControl((fixture) => {
		controlError("missing", () => readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx));
		controlError("missing", () =>
			enqueueWake(PROGRAMME_ID, { sourceEventId: "evt-1", kind: "watchdog", reason: "poll" }, fixture.ctx),
		);
		controlError("missing", () => claimContinuation(PROGRAMME_ID, "session-a", fixture.ctx));
		controlError("missing", () => completeContinuation(PROGRAMME_ID, "clm_x", "progressed", fixture.ctx));
		controlError("missing", () => reserveWriter(PROGRAMME_ID, "lane-a", fixture.ctx));
		controlError("missing", () => pauseProgramme(PROGRAMME_ID, "hold", fixture.ctx));
		controlError("missing", () => resumeProgramme(PROGRAMME_ID, "operator", fixture.ctx));

		controlError("io", () => readProgrammeSnapshot("programme-1", fixture.ctx));
		controlError("io", () => claimContinuation("agp_NOTHEX", "session-a", fixture.ctx));
		controlError("io", () => claimContinuation(PROGRAMME_ID, "", fixture.ctx));
		controlError("io", () => enqueueWake(PROGRAMME_ID, { sourceEventId: "", kind: "watchdog", reason: "poll" }, fixture.ctx));
	});
});
