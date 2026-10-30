import "./muster-test-isolation.ts";
/**
 * Model-free regressions for P4.2 — thin watchdog, durable claims and fenced
 * recovery (plan §7 P4.2, §3 "Recovery").
 *
 * Pure store/journal tests under OS temp directories: no network, provider,
 * Concord, Pi API or Herdr calls, and no terminal scraping anywhere. The
 * supervisor's `checkCycle()` is imported and driven directly (the loop only
 * starts when the script is executed, never when it is imported), so nothing
 * here spawns a process, installs a service or schedules work.
 *
 * Authored here; executed by the parent through the guarded runner.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MusterJournal, WakePump } from "../inbox.ts";
import {
	claimContinuation,
	completeContinuation,
	enqueueWake,
	fileProgrammeControlStore,
	pauseProgramme,
	readProgrammeSnapshot,
	recoverInterruptedClaim,
	recordHeartbeat,
	resumeProgramme,
	startProgramme,
	type ProgrammeControlContext,
} from "../control.ts";
import {
	activeProgrammeContinuation,
	admitProgrammeContinuation,
	programmeWakeForDelivery,
	resetProgrammeContinuations,
	type ControlBridgeContext,
} from "../control-bridge.ts";
import {
	clearSupervisorHeartbeatState,
	publishRecoveryObservation,
	publishSupervisorHeartbeat,
	readBootId,
	readProcessStartTicks,
	readSupervisorHeartbeatState,
	supervisorLeasePath,
	type SupervisorHeartbeatState,
} from "../recovery.ts";

const PROGRAMME_ID = "agp_0123456789ab";
const SESSION = "session-a";

type SupervisorModule = {
	checkCycle: (options?: Record<string, unknown>) => Promise<Record<string, unknown>>;
	main: (argv?: string[]) => Promise<Record<string, unknown>>;
	parseSupervisorState: (input: unknown) => unknown;
	readSupervisorState: (path: string) => { ok: boolean; reason?: string; state?: Record<string, unknown> };
	observeProcess: (state: Record<string, unknown>, nowMs?: number) => { observation: string; evidence: string };
	recoveryObservationMessage: (input: Record<string, unknown>) => string;
};

const SUPERVISOR_PATH = fileURLToPath(new URL("../../../scripts/pi-supervisor.mjs", import.meta.url));
const supervisor = (await import(pathToFileURL(SUPERVISOR_PATH).href)) as SupervisorModule;

// ─── Fixture ─────────────────────────────────────────────────────────────────

type Fixture = {
	root: string;
	controlDir: string;
	programmeDir: string;
	sessionsDir: string;
	leaseDir: string;
	statePath: string;
	killFilePath: string;
	ctx: ProgrammeControlContext;
	bridge: ControlBridgeContext;
	journal: MusterJournal;
};

async function withRecovery(run: (fixture: Fixture) => Promise<void> | void): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "muster-recovery-"));
	const controlDir = join(root, "control");
	const programmeDir = join(root, "programmes");
	const sessionsDir = join(root, "sessions");
	const leaseDir = join(root, "leases");
	mkdirSync(controlDir, { recursive: true });
	mkdirSync(programmeDir, { recursive: true });
	mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
	mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
	const store = fileProgrammeControlStore(controlDir);
	const killFilePath = join(root, "muster.disabled");
	const ctx: ProgrammeControlContext = { store, killFilePath };
	const fixture: Fixture = {
		root,
		controlDir,
		programmeDir,
		sessionsDir,
		leaseDir,
		statePath: join(root, "supervisor.json"),
		killFilePath,
		ctx,
		bridge: { store, controlDir, programmeDir, killFilePath },
		journal: new MusterJournal(SESSION, sessionsDir),
	};
	resetProgrammeContinuations();
	try {
		await run(fixture);
	} finally {
		resetProgrammeContinuations();
		rmSync(root, { recursive: true, force: true });
	}
}

function start(fixture: Fixture) {
	return startProgramme(PROGRAMME_ID, { operatorRef: "operator" }, fixture.ctx);
}

function rawRecord(fixture: Fixture): Record<string, any> {
	return JSON.parse(readFileSync(join(fixture.controlDir, `${PROGRAMME_ID}.json`), "utf8")) as Record<string, any>;
}

/** Capture stdout for the CLI-shaped calls without letting the test log noise. */
async function quietStdout<T>(run: () => Promise<T>): Promise<T> {
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = (() => true) as typeof process.stdout.write;
	try {
		return await run();
	} finally {
		process.stdout.write = original;
	}
}

/** A pid above `/proc/sys/kernel/pid_max`: no live process can occupy it. */
function impossiblePid(): number {
	try {
		const max = Number.parseInt(readFileSync("/proc/sys/kernel/pid_max", "utf8").trim(), 10);
		if (Number.isInteger(max) && max > 0) return max + 1;
	} catch {
		/* fall through to a value above common pid maxima */
	}
	return 1 << 22;
}

// ─── Heartbeat ───────────────────────────────────────────────────────────────

test("P4.2 heartbeat: recordHeartbeat keeps only the latest identity and publishSupervisorHeartbeat writes a 0600 state file", async () => {
	await withRecovery(async fixture => {
		start(fixture);
		const first = recordHeartbeat(
			PROGRAMME_ID,
			{ pid: 4242, sessionId: SESSION, generation: 1 },
			fixture.ctx,
		);
		assert.deepEqual(first.lastHeartbeat, {
			pid: 4242,
			sessionId: SESSION,
			generation: 1,
			at: first.lastHeartbeat?.at,
		});
		assert.equal(typeof first.lastHeartbeat?.at, "string");

		const second = recordHeartbeat(
			PROGRAMME_ID,
			{ pid: 4243, sessionId: "session-b", generation: 1 },
			fixture.ctx,
		);
		assert.equal(second.lastHeartbeat?.pid, 4243);
		const raw = rawRecord(fixture);
		assert.equal(raw.lastHeartbeat.pid, 4243, "bounded: latest only, never a history");
		assert.equal(Array.isArray(raw.lastHeartbeat), false);
		assert.equal(raw.status, "running");
		assert.equal(raw.runGeneration, 1, "a heartbeat never changes status or generation");

		const state = publishSupervisorHeartbeat(
			{ programmeId: PROGRAMME_ID, sessionId: SESSION, pid: 4242 },
			fixture.ctx,
			{ statePath: fixture.statePath },
		);
		assert.equal(state.schemaVersion, 1);
		assert.equal(state.pid, 4242);
		assert.equal(state.sessionId, SESSION);
		assert.equal(state.programmeId, PROGRAMME_ID);
		assert.equal(state.generation, 1);
		assert.equal(state.status, "running");
		assert.equal(state.claim, null);
		assert.equal(Number.isFinite(Date.parse(state.heartbeatAt)), true);
		assert.ok(state.pidStartTicks === null || Number.isInteger(state.pidStartTicks));
		assert.ok(state.bootId === null || typeof state.bootId === "string");

		const mode = statSync(fixture.statePath).mode & 0o777;
		assert.equal(mode, 0o600, "the watchdog state file is owner-only");
		const reread = readSupervisorHeartbeatState(fixture.statePath);
		assert.deepEqual(reread, state);
		clearSupervisorHeartbeatState(fixture.statePath);
		assert.equal(existsSync(fixture.statePath), false);
	});
});

// ─── Claim durability and interrupted-claim recovery ─────────────────────────

test("P4.2 claims: the admitted claim with owner and consumed wake rows is on disk before claimContinuation returns", async () => {
	await withRecovery(async fixture => {
		start(fixture);
		enqueueWake(
			PROGRAMME_ID,
			{ sourceEventId: "handoff-1", kind: "handoff", reason: "worker offered handoff 1" },
			fixture.ctx,
		);
		enqueueWake(
			PROGRAMME_ID,
			{ sourceEventId: "delegate-1", kind: "delegate-completion", reason: "leaf 1 settled" },
			fixture.ctx,
		);
		const claim = claimContinuation(PROGRAMME_ID, SESSION, fixture.ctx);
		assert.equal(claim.outcome, "admitted");
		if (claim.outcome !== "admitted") return;

		// The durable record, not the return value, is the proof: read the file.
		const raw = rawRecord(fixture);
		assert.equal(raw.activeClaim.claimId, claim.claimId);
		assert.equal(raw.activeClaim.owner, `lane:${SESSION}`);
		assert.equal(raw.activeClaim.sessionRef, SESSION);
		assert.equal(raw.activeClaim.runGeneration, 1);
		assert.deepEqual(raw.activeClaim.wakeIds, ["handoff-1", "delegate-1"]);
		assert.deepEqual(
			raw.activeClaim.wakes.map((wake: Record<string, unknown>) => wake.sourceEventId),
			["handoff-1", "delegate-1"],
			"consumed wake rows keep their reason text for crash replay",
		);
		assert.deepEqual(raw.pendingWakes, []);
	});
});

test("P4.2 claims: recoverInterruptedClaim replays the same owner and the admission path re-wakes idempotently", async () => {
	await withRecovery(async fixture => {
		start(fixture);
		enqueueWake(
			PROGRAMME_ID,
			{ sourceEventId: "handoff-1", kind: "handoff", reason: "worker offered handoff 1" },
			fixture.ctx,
		);
		const first = claimContinuation(PROGRAMME_ID, SESSION, fixture.ctx);
		assert.equal(first.outcome, "admitted");
		if (first.outcome !== "admitted") return;

		const recovery = recoverInterruptedClaim(PROGRAMME_ID, 1, fixture.ctx);
		assert.equal(recovery.outcome, "recovered");
		if (recovery.outcome !== "recovered") return;
		assert.equal(recovery.claim.claimId, first.claimId);
		assert.equal(recovery.claim.owner, `lane:${SESSION}`);
		assert.deepEqual(
			recovery.replays.map(wake => wake.sourceEventId),
			[`recovery/${first.claimId}/handoff-1`],
		);
		assert.equal(recovery.replays[0]?.reason, "worker offered handoff 1", "the original reason is preserved");
		assert.equal(readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx).activeClaim, null);
		assert.equal(readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx).pendingWakes.length, 1);
		assert.deepEqual(recoverInterruptedClaim(PROGRAMME_ID, 1, fixture.ctx), {
			outcome: "none",
			reason: "no-open-claim",
		});

		// A crash after admission with no recovery call yet: the admission path
		// itself recovers the claim and admits the same owner again.
		enqueueWake(
			PROGRAMME_ID,
			{ sourceEventId: "handoff-2", kind: "handoff", reason: "worker offered handoff 2" },
			fixture.ctx,
		);
		const second = claimContinuation(PROGRAMME_ID, SESSION, fixture.ctx);
		assert.equal(second.outcome, "admitted");
		if (second.outcome !== "admitted") return;
		resetProgrammeContinuations(); // process restart: no in-memory claim
		const admission = admitProgrammeContinuation(
			{
				sessionRef: SESSION,
				owner: "muster",
				events: [
					{ sourceEventId: "muster-inbox/msg-9", kind: "handoff", reason: "muster inbox delivery msg-9" },
				],
			},
			fixture.bridge,
		);
		assert.equal(admission.outcome, "admitted");
		if (admission.outcome !== "admitted") return;
		assert.equal(admission.recoveredClaimId, second.claimId, "the crashed claim is replayed for the same owner");
		const snapshot = readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx);
		assert.ok(snapshot.activeClaim?.wakeIds.includes(`recovery/${second.claimId}/handoff-2`));
		assert.ok(snapshot.activeClaim?.wakeIds.includes("muster-inbox/msg-9"));
		assert.equal(
			snapshot.activeClaim?.wakes.find(wake => wake.sourceEventId === `recovery/${second.claimId}/handoff-2`)
				?.reason,
			"worker offered handoff 2",
		);
		// Idempotency: replaying the same source event coalesces, never doubles.
		const replayed = enqueueWake(
			PROGRAMME_ID,
			{
				sourceEventId: `recovery/${second.claimId}/handoff-2`,
				kind: "handoff",
				reason: "replay",
			},
			fixture.ctx,
		);
		assert.equal(replayed.outcome, "coalesced");
		assert.equal(readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx).pendingWakes.length, 0);
		assert.equal(activeProgrammeContinuation(SESSION)?.claimId, admission.claimId);
	});
});

// ─── Recovery observations ───────────────────────────────────────────────────

test("P4.2 observations: proven death enqueues one fenced watchdog wake, the observation is durable and no prompt is composed", async () => {
	await withRecovery(async fixture => {
		start(fixture);
		recordHeartbeat(PROGRAMME_ID, { pid: 999999, sessionId: SESSION, generation: 1 }, fixture.ctx);
		const published = await publishRecoveryObservation(
			{
				programmeId: PROGRAMME_ID,
				generation: 1,
				observation: "process-death-proven",
				evidence: "pid 999999 has no /proc entry and does not exist",
				sessionRef: SESSION,
				journal: fixture.journal,
			},
			fixture.ctx,
		);
		assert.equal(published.outcome, "published");
		if (published.outcome !== "published") return;
		assert.equal(published.sourceEventId, "supervisor-1-1");
		assert.equal(published.deliveryKey, "recovery/supervisor-1-1");
		assert.equal(published.wakeEnqueued, true);
		assert.match(published.message, /process death is proven/);
		assert.match(published.message, /not a continuation prompt/);
		assert.match(published.message, /schedules no product work/);

		const snapshot = readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx);
		assert.equal(snapshot.pendingWakes.length, 1);
		assert.equal(snapshot.pendingWakes[0]?.sourceEventId, "supervisor-1-1");
		assert.equal(snapshot.pendingWakes[0]?.kind, "watchdog");
		assert.equal(snapshot.pendingWakes[0]?.sessionRef, SESSION);
		assert.equal(snapshot.pendingWakes[0]?.reason, published.message);

		const fold = await fixture.journal.fold();
		const row = fold.deliveries.get("recovery/supervisor-1-1");
		assert.equal(row?.type, "pending");
		if (row?.type === "pending" && row.target.kind === "recovery-observation") {
			assert.equal(row.deliveryKey, "recovery/supervisor-1-1");
			assert.equal(row.target.sourceEventId, "supervisor-1-1");
			assert.equal(row.target.observation, "process-death-proven");
			assert.equal(row.target.generation, 1);
			assert.equal(row.target.evidence, "pid 999999 has no /proc entry and does not exist");
			assert.equal(row.target.admitsWake, true);
			assert.equal(row.payload, published.message);
		} else {
			assert.fail("expected a recovery-observation delivery record");
		}

		// Re-publishing the same identity is one wake, never two.
		const replay = await publishRecoveryObservation(
			{
				programmeId: PROGRAMME_ID,
				generation: 1,
				observation: "process-death-proven",
				evidence: "pid 999999 absent",
				sessionRef: SESSION,
				sequence: 1,
				journal: fixture.journal,
			},
			fixture.ctx,
		);
		assert.equal(replay.outcome, "published");
		assert.equal(readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx).pendingWakes.length, 1);

		// A second, distinct observation gets the next fenced number.
		const next = await publishRecoveryObservation(
			{
				programmeId: PROGRAMME_ID,
				generation: 1,
				observation: "process-death-proven",
				evidence: "pid 999999 absent (second check)",
				sessionRef: SESSION,
				journal: fixture.journal,
			},
			fixture.ctx,
		);
		assert.equal(next.outcome === "published" && next.sourceEventId, "supervisor-1-2");
	});
});

test("P4.2 observations: alive and ambiguous observations enqueue no wake and carry an actionable blocker", async () => {
	await withRecovery(async fixture => {
		start(fixture);
		recordHeartbeat(PROGRAMME_ID, { pid: 1234, sessionId: SESSION, generation: 1 }, fixture.ctx);

		const alive = await publishRecoveryObservation(
			{
				programmeId: PROGRAMME_ID,
				generation: 1,
				observation: "process-alive",
				evidence: "pid 1234 exists (state S, start tick 991)",
				sessionRef: SESSION,
				journal: fixture.journal,
			},
			fixture.ctx,
		);
		assert.equal(alive.outcome, "published");
		if (alive.outcome !== "published") return;
		assert.equal(alive.wakeEnqueued, false);
		assert.equal(alive.blockedBy, "process-alive");
		assert.match(alive.message, /still alive/);
		assert.match(alive.message, /What could not be proven/);
		assert.match(alive.message, /No replacement writer was authorized/);

		const ambiguous = await publishRecoveryObservation(
			{
				programmeId: PROGRAMME_ID,
				generation: 1,
				observation: "ambiguous",
				evidence: "pid 1234 is a zombie: its children are not shown to be settled",
				sessionRef: SESSION,
				journal: fixture.journal,
			},
			fixture.ctx,
		);
		assert.equal(ambiguous.outcome, "published");
		if (ambiguous.outcome !== "published") return;
		assert.equal(ambiguous.wakeEnqueued, false);
		assert.equal(ambiguous.blockedBy, "ambiguous");
		assert.match(ambiguous.message, /could not be determined/);
		assert.match(ambiguous.message, /whether it can still write/);

		// Stale heartbeat or not: neither observation authorized a wake at all.
		assert.deepEqual(readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx).pendingWakes, []);
		const fold = await fixture.journal.fold();
		const aliveRow = fold.deliveries.get("recovery/supervisor-1-1");
		const ambiguousRow = fold.deliveries.get("recovery/supervisor-1-2");
		assert.equal(aliveRow?.type, "pending");
		assert.equal(ambiguousRow?.type, "pending");
		if (aliveRow?.type === "pending" && aliveRow.target.kind === "recovery-observation") {
			assert.equal(aliveRow.target.observation, "process-alive");
			assert.equal(aliveRow.target.admitsWake, false, "a live process never admits a recovery wake");
		} else {
			assert.fail("expected the alive observation to be durable");
		}
		if (ambiguousRow?.type === "pending" && ambiguousRow.target.kind === "recovery-observation") {
			assert.equal(ambiguousRow.target.observation, "ambiguous");
			assert.equal(ambiguousRow.target.admitsWake, false, "ambiguous evidence never admits a recovery wake");
		} else {
			assert.fail("expected the ambiguous observation to be durable");
		}
	});
});

test("P4.2 observations: pause, kill file, waiting status and a generation mismatch never admit a wake", async () => {
	await withRecovery(async fixture => {
		start(fixture);
		recordHeartbeat(PROGRAMME_ID, { pid: 4242, sessionId: SESSION, generation: 1 }, fixture.ctx);
		pauseProgramme(PROGRAMME_ID, "operator pause during recovery test", fixture.ctx);

		const paused = await publishRecoveryObservation(
			{
				programmeId: PROGRAMME_ID,
				generation: 1,
				observation: "process-death-proven",
				evidence: "pid 4242 absent",
				sessionRef: SESSION,
				journal: fixture.journal,
			},
			fixture.ctx,
		);
		assert.equal(paused.outcome, "published");
		if (paused.outcome !== "published") return;
		assert.equal(paused.wakeEnqueued, false);
		assert.equal(paused.blockedBy, "programme-paused");
		assert.match(paused.message, /no recovery wake was admitted/);
		assert.deepEqual(readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx).pendingWakes, []);
		assert.deepEqual(claimContinuation(PROGRAMME_ID, SESSION, fixture.ctx), {
			outcome: "denied",
			reason: "programme-paused",
		});

		resumeProgramme(PROGRAMME_ID, "operator", fixture.ctx);
		writeFileSync(fixture.killFilePath, "operator stop\n", "utf8");
		const killed = await publishRecoveryObservation(
			{
				programmeId: PROGRAMME_ID,
				generation: 1,
				observation: "process-death-proven",
				evidence: "pid 4242 absent",
				sessionRef: SESSION,
				journal: fixture.journal,
			},
			fixture.ctx,
		);
		assert.equal(killed.outcome === "published" && killed.blockedBy, "kill-file");
		assert.equal(readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx).pendingWakes.length, 0);
		assert.deepEqual(claimContinuation(PROGRAMME_ID, SESSION, fixture.ctx), {
			outcome: "denied",
			reason: "kill-file",
		});
		rmSync(fixture.killFilePath, { force: true });

		// The visible waiting state (only a human decision remains) is also closed.
		enqueueWake(
			PROGRAMME_ID,
			{ sourceEventId: "operator-answer-1", kind: "operator-answer", reason: "operator answered" },
			fixture.ctx,
		);
		const claimed = claimContinuation(PROGRAMME_ID, SESSION, fixture.ctx);
		assert.equal(claimed.outcome, "admitted");
		if (claimed.outcome !== "admitted") return;
		completeContinuation(PROGRAMME_ID, claimed.claimId, "waiting_decision", fixture.ctx);
		const waiting = await publishRecoveryObservation(
			{
				programmeId: PROGRAMME_ID,
				generation: 2,
				observation: "process-death-proven",
				evidence: "pid 4242 absent",
				sessionRef: SESSION,
				journal: fixture.journal,
			},
			fixture.ctx,
		);
		assert.equal(waiting.outcome === "published" && waiting.blockedBy, "programme-waiting");

		// Fencing: an observer bound to the previous generation is refused, and it
		// writes no observation and no wake for the newer programme.
		const fenced = await publishRecoveryObservation(
			{
				programmeId: PROGRAMME_ID,
				generation: 1,
				observation: "process-death-proven",
				evidence: "pid 4242 absent",
				sessionRef: SESSION,
				journal: fixture.journal,
			},
			fixture.ctx,
		);
		assert.equal(fenced.outcome, "refused");
		assert.equal(fenced.outcome === "refused" && fenced.reason, "generation-mismatch");
		assert.deepEqual(readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx).pendingWakes, []);
	});
});

// ─── Supervisor cycle ────────────────────────────────────────────────────────

function supervisorOptions(fixture: Fixture, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		statePath: fixture.statePath,
		controlDir: fixture.controlDir,
		sessionsDir: fixture.sessionsDir,
		leaseDir: fixture.leaseDir,
		killFiles: [fixture.killFilePath],
		...extra,
	};
}

test("P4.2 supervisor: a fresh heartbeat acts on nothing and a stale proven-death heartbeat publishes one observation", async () => {
	await withRecovery(async fixture => {
		start(fixture);
		const beat = publishSupervisorHeartbeat(
			{ programmeId: PROGRAMME_ID, sessionId: SESSION, pid: 987654 },
			fixture.ctx,
			{ statePath: fixture.statePath },
		);
		const revisionBefore = readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx).revision;

		const fresh = await supervisor.checkCycle(supervisorOptions(fixture, { graceMs: 120_000 }));
		assert.equal(fresh.action, "fresh");
		assert.equal(existsSync(join(fixture.sessionsDir, `${SESSION}.jsonl`)), false, "no observation while fresh");

		const nowMs = Date.parse(beat.heartbeatAt) + 120_000 + 1_000;
		const published = await supervisor.checkCycle(
			supervisorOptions(fixture, {
				graceMs: 120_000,
				nowMs,
				observe: () => ({
					observation: "process-death-proven",
					evidence: "pid 987654 has no /proc entry and does not exist",
				}),
			}),
		);
		assert.equal(published.action, "published");
		assert.equal(published.observation, "process-death-proven");
		assert.equal(published.sourceEventId, "supervisor-1-1");
		assert.equal(published.deliveryKey, "recovery/supervisor-1-1");
		assert.equal(published.admitsWake, true);
		assert.equal(published.blockedBy, undefined);
		assert.match(String(published.message), /process death is proven/);
		assert.equal(published.journalPath, join(fixture.sessionsDir, `${SESSION}.jsonl`));

		// The watchdog is read-only apart from its lease and the observation.
		const raw = rawRecord(fixture);
		assert.equal(raw.revision, revisionBefore, "the control record is untouched by the watchdog");
		assert.deepEqual(raw.pendingWakes, [], "the watchdog enqueues no wake itself");

		const fold = await new MusterJournal(SESSION, fixture.sessionsDir).fold();
		const row = fold.deliveries.get("recovery/supervisor-1-1");
		assert.equal(row?.type, "pending");
		if (row?.type === "pending" && row.target.kind === "recovery-observation") {
			assert.equal(row.target.observation, "process-death-proven");
			assert.equal(row.sessionId, SESSION);
		} else {
			assert.fail("expected the supervisor's observation in the folded journal");
		}
	});
});

test("P4.2 supervisor: leases fence an older generation, a live same-generation owner and a newer supervisor", async () => {
	await withRecovery(async fixture => {
		start(fixture);
		const stale = {
			schemaVersion: 1,
			pid: 987654,
			sessionId: SESSION,
			programmeId: PROGRAMME_ID,
			generation: 1,
			heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString(),
			claim: null,
			status: "running",
			pidStartTicks: null,
			bootId: readBootId() ?? null,
			updatedAt: new Date().toISOString(),
		} satisfies SupervisorHeartbeatState;
		writeFileSync(fixture.statePath, `${JSON.stringify(stale)}\n`, { mode: 0o600 });
		const death = () => ({ observation: "process-death-proven", evidence: "pid 987654 absent" });

		// A newer programme generation than the heartbeat names: no action. The
		// programme advances by completing one run, which is exactly the change an
		// older generation's watchdog must not act on.
		enqueueWake(
			PROGRAMME_ID,
			{ sourceEventId: "progress-1", kind: "state-transition", reason: "run progressed" },
			fixture.ctx,
		);
		const progressed = claimContinuation(PROGRAMME_ID, SESSION, fixture.ctx);
		assert.equal(progressed.outcome, "admitted");
		if (progressed.outcome !== "admitted") return;
		completeContinuation(PROGRAMME_ID, progressed.claimId, "progressed", fixture.ctx);
		assert.equal(readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx).runGeneration, 2);
		const mismatch = await supervisor.checkCycle(supervisorOptions(fixture, { graceMs: 1, observe: death }));
		assert.equal(mismatch.action, "fenced");
		assert.equal(mismatch.reason, "generation-mismatch");
		assert.equal(mismatch.currentGeneration, 2);
		assert.equal(existsSync(join(fixture.sessionsDir, `${SESSION}.jsonl`)), false);

		// Back to a stale, matching heartbeat for the new generation: a live
		// same-generation lease holder with a different pid fences this watchdog.
		writeFileSync(
			fixture.statePath,
			`${JSON.stringify({ ...stale, generation: 2 })}\n`,
			{ mode: 0o600 },
		);
		const leasePath = supervisorLeasePath(PROGRAMME_ID, fixture.leaseDir);
		writeFileSync(
			leasePath,
			`${JSON.stringify({
				schemaVersion: 1,
				programmeId: PROGRAMME_ID,
				supervisorGeneration: 2,
				observationSequence: 0,
				pid: process.pid,
				pidStartTicks: readProcessStartTicks(process.pid) ?? null,
				bootId: readBootId() ?? null,
				acquiredAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			})}\n`,
			{ mode: 0o600 },
		);
		const held = await supervisor.checkCycle(
			supervisorOptions(fixture, { graceMs: 1, observe: death, pid: process.pid + 1 }),
		);
		assert.equal(held.action, "fenced");
		assert.equal(held.reason, "lease-held");
		assert.equal(existsSync(join(fixture.sessionsDir, `${SESSION}.jsonl`)), false);

		// A lease owned by a newer supervisor generation also fences this one.
		writeFileSync(
			leasePath,
			`${JSON.stringify({
				schemaVersion: 1,
				programmeId: PROGRAMME_ID,
				supervisorGeneration: 3,
				observationSequence: 4,
				pid: process.pid,
				pidStartTicks: readProcessStartTicks(process.pid) ?? null,
				bootId: readBootId() ?? null,
				acquiredAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			})}\n`,
			{ mode: 0o600 },
		);
		const superseded = await supervisor.checkCycle(
			supervisorOptions(fixture, { graceMs: 1, observe: death, pid: process.pid + 1 }),
		);
		assert.equal(superseded.action, "fenced");
		assert.equal(superseded.reason, "newer-supervisor");
		assert.equal(existsSync(join(fixture.sessionsDir, `${SESSION}.jsonl`)), false);

		// A missing programme record is a fence too, never an invented wake.
		rmSync(leasePath, { force: true });
		rmSync(join(fixture.controlDir, `${PROGRAMME_ID}.json`));
		const missing = await supervisor.checkCycle(supervisorOptions(fixture, { graceMs: 1, observe: death }));
		assert.equal(missing.action, "fenced");
		assert.equal(missing.reason, "programme-record-missing");
	});
});

test("P4.2 supervisor: two consecutive runs in one generation publish distinct fenced observations", async () => {
	await withRecovery(async fixture => {
		start(fixture);
		const beat = publishSupervisorHeartbeat(
			{ programmeId: PROGRAMME_ID, sessionId: SESSION, pid: 987654 },
			fixture.ctx,
			{ statePath: fixture.statePath },
		);
		const options = supervisorOptions(fixture, {
			graceMs: 1_000,
			nowMs: Date.parse(beat.heartbeatAt) + 60_000,
			observe: () => ({ observation: "process-death-proven", evidence: "pid 987654 absent" }),
		});
		const first = await supervisor.checkCycle(options);
		const second = await supervisor.checkCycle(options);
		assert.equal(first.action, "published");
		assert.equal(second.action, "published");
		assert.equal(first.sourceEventId, "supervisor-1-1");
		assert.equal(second.sourceEventId, "supervisor-1-2", "the lease counter never repeats an identity");
		const fold = await new MusterJournal(SESSION, fixture.sessionsDir).fold();
		assert.equal(fold.deliveries.get("recovery/supervisor-1-1")?.type, "pending");
		assert.equal(fold.deliveries.get("recovery/supervisor-1-2")?.type, "pending");
	});
});

test("P4.2 supervisor: --once mode reports a paused programme as a blocker and refuses unknown state", async () => {
	await withRecovery(async fixture => {
		start(fixture);
		publishSupervisorHeartbeat(
			{ programmeId: PROGRAMME_ID, sessionId: SESSION, pid: impossiblePid() },
			fixture.ctx,
			{ statePath: fixture.statePath },
		);
		const argv = [
			"--once",
			"--state",
			fixture.statePath,
			"--control-dir",
			fixture.controlDir,
			"--sessions-dir",
			fixture.sessionsDir,
			"--lease-dir",
			fixture.leaseDir,
			"--kill-file",
			fixture.killFilePath,
		];

		// A fresh heartbeat with a wide grace window is reported as fresh.
		const fresh = await quietStdout(() => supervisor.main([...argv, "--grace-ms", "3600000"]));
		assert.equal(fresh.action, "fresh");
		assert.equal(existsSync(join(fixture.sessionsDir, `${SESSION}.jsonl`)), false);

		// Paused programme plus a heartbeat naming a pid that cannot exist: the
		// real observer proves death, and the operator pause still blocks the wake.
		pauseProgramme(PROGRAMME_ID, "operator paused before the watchdog ran", fixture.ctx);
		const paused = await quietStdout(() => supervisor.main([...argv, "--grace-ms", "1"]));
		assert.equal(paused.action, "published");
		assert.equal(paused.observation, "process-death-proven");
		assert.equal(paused.admitsWake, false);
		assert.equal(paused.blockedBy, "programme-paused");
		assert.match(String(paused.message), /no recovery wake was admitted/);
		assert.deepEqual(readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx).pendingWakes, []);

		// Unknown or malformed state is never acted on.
		const missingState = await quietStdout(() =>
			supervisor.main(["--once", "--state", join(fixture.root, "absent.json")]),
		);
		assert.equal(missingState.action, "no-state");
		writeFileSync(fixture.statePath, "{not json", "utf8");
		const malformed = await quietStdout(() => supervisor.main(["--once", "--state", fixture.statePath]));
		assert.equal(malformed.action, "no-state");
		assert.equal(malformed.reason, "unreadable");
	});
});

// ─── Consumption path ────────────────────────────────────────────────────────

test("P4.2 consumption: a published observation becomes one pump delivery whose admission wake keeps the supervisor identity", async () => {
	await withRecovery(async fixture => {
		start(fixture);
		const beat = publishSupervisorHeartbeat(
			{ programmeId: PROGRAMME_ID, sessionId: SESSION, pid: 987654 },
			fixture.ctx,
			{ statePath: fixture.statePath },
		);
		const published = await supervisor.checkCycle(
			supervisorOptions(fixture, {
				graceMs: 1_000,
				nowMs: Date.parse(beat.heartbeatAt) + 60_000,
				observe: () => ({ observation: "process-death-proven", evidence: "pid 987654 absent" }),
			}),
		);
		assert.equal(published.action, "published");

		// Replay exactly as the extension's session_start replay does.
		const journal = new MusterJournal(SESSION, fixture.sessionsDir);
		const fold = await journal.fold();
		const row = fold.deliveries.get("recovery/supervisor-1-1");
		assert.equal(row?.type, "pending");
		// Establish the session's enrollment the way a supervised session has it
		// in production: one muster-owned claim writes `enrolledSessions` (a
		// fresh control record carries no session linkage on its own).
		enqueueWake(
			PROGRAMME_ID,
			{ sourceEventId: "enrollment/bootstrap", kind: "state-transition", reason: "session established" },
			fixture.ctx,
		);
		const prior = claimContinuation(PROGRAMME_ID, SESSION, fixture.ctx);
		assert.equal(prior.outcome, "admitted");
		if (prior.outcome === "admitted") completeContinuation(PROGRAMME_ID, prior.claimId, "progressed", fixture.ctx);
		resetProgrammeContinuations();
		const sends: Array<{ content: string; details: Record<string, unknown> }> = [];
		// One stable binding object: the pump's recheck compares identity, not shape.
		const bindingState = { schemaVersion: 1 as const, sessionId: SESSION, repos: [] };
		const pump = new WakePump({
			generation: () => 0,
			binding: () => bindingState,
			groupOf: () => `recovery:${PROGRAMME_ID}`,
			groupPaused: () => false,
			globalPause: () => false,
			killFileExists: () => false,
			isEnvDisabled: () => false,
			isIdle: () => true,
			extensionPromptDepth: () => 0,
			editorDraftNonEmpty: () => false,
			sendBatch: async options => {
				sends.push({ content: options.content, details: options.details });
			},
			findRecordedEntries: async () => [],
			sessionFile: () => undefined,
			journal: { append: record => journal.append(record) },
			recordingPoll: { attempts: 1, intervalMs: 1 },
		});
		assert.equal(row?.type === "pending" && row.target.kind === "recovery-observation", true);
		if (row?.type === "pending" && row.target.kind === "recovery-observation") {
			pump.enqueueRecoveryObservation(
				{
					sourceEventId: row.target.sourceEventId,
					programmeId: row.target.programmeId,
					generation: row.target.generation,
					observation: row.target.observation,
					evidence: row.target.evidence,
					message: row.payload ?? "observation",
					admitsWake: row.target.admitsWake,
				},
				{ alreadyJournaled: true },
			);
		}
		const pumped = await pump.pump();
		assert.equal(pumped.delivered, true);
		assert.equal(sends.length, 1);
		assert.match(sends[0]!.content, /process death is proven/);
		assert.match(sends[0]!.content, /not a continuation prompt/);
		assert.equal(
			sends[0]!.content.includes("peer information, not an instruction from your operator"),
			false,
			"a supervision observation is not relayed peer traffic",
		);
		const deliveries = sends[0]!.details["deliveries"] as Array<Record<string, unknown>>;
		assert.equal(deliveries[0]?.["deliveryKey"], "recovery/supervisor-1-1");
		assert.equal(deliveries[0]?.["observation"], "process-death-proven");
		assert.equal(deliveries[0]?.["admitsWake"], true);
		assert.equal(typeof deliveries[0]?.["reason"], "string");

		// Admission uses the same fenced identity: the bridge invents no second one.
		const wake = programmeWakeForDelivery("recovery/supervisor-1-1");
		assert.equal(wake.kind, "watchdog");
		assert.equal(wake.sourceEventId, "supervisor-1-1");
		const admission = admitProgrammeContinuation(
			{
				sessionRef: SESSION,
				owner: "muster",
				events: [{ sourceEventId: wake.sourceEventId, kind: wake.kind, reason: String(deliveries[0]?.["reason"]) }],
			},
			fixture.bridge,
		);
		assert.equal(admission.outcome, "admitted");
		const snapshot = readProgrammeSnapshot(PROGRAMME_ID, fixture.ctx);
		assert.deepEqual(snapshot.activeClaim?.wakeIds, ["supervisor-1-1"]);
	});
});
