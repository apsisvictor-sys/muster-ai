import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	attachProgramme,
	claimRotationTakeover,
	completeRotation,
	fileProgrammeControlStore,
	markRotationCheckpointed,
	pauseProgramme,
	readProgrammeSnapshot,
	recordHeartbeat,
	recordDecisionRef,
	reserveWriter,
	type CompactionObservation,
	type ProgrammeControlContext,
} from "../control.ts";
import { parseProjectCatalogue, type ProjectCatalogue } from "../projects.ts";
import { programmeWakeEnvelopeText } from "../inbox.ts";
import { resumeBrief } from "../rotation.ts";
import { runTick, type TickAction, type TickPorts } from "../tick.ts";

/**
 * R1.5 (AM4): the tick rotates a project's parent. Triggers (a failed or
 * ineffective compaction, an idle leader with work waiting after the wake), the
 * checkpoint step, the launch through an injected port, and the safety rules
 * (never touches workers, once per 30 minutes, a second consecutive failure
 * only alerts, pause and the kill file deny it). Since T1 a healthy leader's
 * growing context is compaction's business, not rotation's.
 */

const PROGRAMME = "agp_6c6c6c6c6c6c";
const OLD = { sessionId: "old-leader", processKey: "pi-1-boot-1", operatorRef: "operator", guarded: true };
const MIN = 60_000;
const T0 = Date.parse("2026-10-04T12:00:00.000Z");
const THRESHOLD = 100_000;
/** The leader's compaction failed. Since T1 this, and an ineffective compaction, are the context reasons. */
const FAILED_COMPACTION: CompactionObservation = { at: new Date(T0).toISOString(), outcome: "failed" };

const catalogue = (rotation: Record<string, unknown> = {}): ProjectCatalogue =>
	parseProjectCatalogue({
		schemaVersion: 1,
		projects: [{
			projectId: "sandbox",
			name: "sandbox",
			aliases: [],
			programmes: [{ programmeId: PROGRAMME, checkoutRoot: "/home/operator/projects/sandbox", repoKey: "/home/operator/projects/sandbox/.git", parentAgentId: "pi-sandbox-parent" }],
			discord: { channelId: "1100000000000000001", threadId: "1100000000000000002" },
			settings: { rotation: { rotateAtTokens: THRESHOLD, parentModel: "provider/model-x", parentThinking: "high", checkpoint: "docs/plan.md section 4", ...rotation } },
		}],
	});

type Launch = { ticket: string; paneId?: string; model?: string; thinking?: string; cwd: string; name: string; env: Record<string, string> };

type Fixture = {
	dir: string;
	ctx: ProgrammeControlContext;
	clock: { now: number };
	mailbox: Array<{ key: string; text: string }>;
	launches: Launch[];
	launchResult: { launched: boolean; error?: string };
	ready: { value: { ready: boolean; reason?: string } };
	tasks: { value: Array<Record<string, unknown>> };
	tick: () => Promise<TickAction[]>;
	/** Write a heartbeat as the leader would, with the clock under test control. */
	beat: (options?: { contextTokens?: number; compaction?: CompactionObservation; idleSince?: number | null; paneId?: string | null; sessionId?: string; at?: number; wakeHold?: { reason: string; at: string }; lastInputAt?: number }) => void;
	record: () => ReturnType<typeof readProgrammeSnapshot>;
	setCatalogue: (value: ProjectCatalogue) => void;
};

function withRotation(run: (f: Fixture) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "muster-rotation-"));
	mkdirSync(join(dir, "control"), { recursive: true });
	const ctx: ProgrammeControlContext = { store: fileProgrammeControlStore(join(dir, "control")), killFilePath: join(dir, "kill") };
	attachProgramme(PROGRAMME, OLD, ctx);
	const clock = { now: T0 };
	const mailbox: Array<{ key: string; text: string }> = [];
	const alerts = new Map<string, string>();
	const launches: Launch[] = [];
	const launchResult = { launched: true } as { launched: boolean; error?: string };
	const ready = { value: { ready: true } as { ready: boolean; reason?: string } };
	const tasks = { value: [] as Array<Record<string, unknown>> };
	let current = catalogue();
	const ports: TickPorts = {
		now: () => clock.now,
		catalogue: () => current,
		control: ctx,
		readTasks: () => tasks.value as never,
		alerts: { get: (id) => alerts.get(id), set: (id, at) => void alerts.set(id, at) },
		alert: async (text, key) => { mailbox.push({ key, text }); return { delivered: true }; },
		launch: async (plan) => { launches.push(plan as unknown as Launch); return launchResult; },
		launchReady: async () => ready.value,
	};
	const record = () => readProgrammeSnapshot(PROGRAMME, ctx);
	const beat: Fixture["beat"] = (options = {}) => {
		recordHeartbeat(PROGRAMME, {
			pid: process.pid,
			sessionId: options.sessionId ?? record().owner!.sessionId,
			generation: record().runGeneration,
			contextTokens: options.contextTokens ?? 10_000,
			contextWindow: 1_000_000,
			...(options.compaction !== undefined ? { compaction: options.compaction } : {}),
			...(options.wakeHold !== undefined ? { wakeHold: options.wakeHold } : {}),
			...(options.lastInputAt !== undefined ? { lastInputAt: new Date(options.lastInputAt).toISOString() } : {}),
			...(options.paneId === null ? {} : { paneId: options.paneId ?? "wD:pA" }),
			...(options.idleSince === undefined ? {} : { idleSince: options.idleSince === null ? null : new Date(options.idleSince).toISOString() }),
		}, ctx);
		const written = record();
		ctx.store!.update(PROGRAMME, written.revision, () => ({
			...written,
			revision: written.revision + 1,
			lastHeartbeat: { ...written.lastHeartbeat!, at: new Date(options.at ?? clock.now).toISOString() },
		}));
	};
	const fixture: Fixture = { dir, ctx, clock, mailbox, launches, launchResult, ready, tasks, tick: () => runTick(ports), beat, record, setCatalogue: (value) => { current = value; } };
	return run(fixture).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const actionsOf = (actions: TickAction[]) => actions.map((action) => action.action);

// ─── Triggers ────────────────────────────────────────────────────────────────

test("a leader whose context has simply grown is compacted, not rotated (T1)", () => withRotation(async (f) => {
	// 300k on a 400k window: above the notice and well past any threshold the tick
	// would use, but self_compact and auto-compaction own normal growth. Rotation
	// pre-empting them replaced a healthy orchestrator every 250k.
	for (const tokens of [THRESHOLD - 1, THRESHOLD, 300_000, 400_000]) {
		f.beat({ contextTokens: tokens });
		assert.deepEqual(actionsOf(await f.tick()), ["none"], `${tokens} tokens must not start a rotation`);
	}
	assert.equal(f.record().rotation, null);
}));

test("a completed compaction that left context at or above the threshold starts a rotation", () => withRotation(async (f) => {
	f.beat({ contextTokens: 40_000, compaction: { at: new Date(T0).toISOString(), outcome: "completed", tokensAfter: THRESHOLD - 1 } });
	assert.deepEqual(actionsOf(await f.tick()), ["none"]);
	f.beat({ contextTokens: 40_000, compaction: { at: new Date(T0).toISOString(), outcome: "completed", tokensAfter: THRESHOLD } });
	const [action] = await f.tick();
	assert.equal(action!.action, "rotation-requested");
	assert.equal(f.record().rotation?.reason, "compaction");
	assert.equal(f.record().rotation?.phase, "checkpoint");
	assert.ok(f.record().pendingWakes.some((wake) => wake.kind === "rotation"));
}));

test("the default threshold is 250k tokens when the catalogue sets none", () => withRotation(async (f) => {
	f.setCatalogue(catalogue({ rotateAtTokens: undefined }));
	f.beat({ contextTokens: 40_000, compaction: { at: new Date(T0).toISOString(), outcome: "completed", tokensAfter: 249_000 } });
	assert.deepEqual(actionsOf(await f.tick()), ["none"]);
	f.beat({ contextTokens: 40_000, compaction: { at: new Date(T0).toISOString(), outcome: "completed", tokensAfter: 250_000 } });
	assert.deepEqual(actionsOf(await f.tick()), ["rotation-requested"]);
}));

test("a compaction that completed well does not start a rotation", () => withRotation(async (f) => {
	f.beat({ compaction: { at: new Date(T0).toISOString(), outcome: "completed", tokensAfter: 20_000 } });
	assert.deepEqual(actionsOf(await f.tick()), ["none"]);
}));

test("a failed compaction is the reason even when context is far below the threshold", () => withRotation(async (f) => {
	f.beat({ contextTokens: 40_000, compaction: FAILED_COMPACTION });
	assert.equal((await f.tick())[0]!.action, "rotation-requested");
	assert.equal(f.record().rotation?.reason, "compaction");
}));

test("a compaction that left context above the threshold is the reason when context was not re-measured since", () => withRotation(async (f) => {
	f.beat({ contextTokens: 40_000, compaction: { at: new Date(T0).toISOString(), outcome: "completed", tokensAfter: THRESHOLD + 1 } });
	assert.equal((await f.tick())[0]!.action, "rotation-requested");
	assert.equal(f.record().rotation?.reason, "compaction");
}));

test("an idle leader with work waiting after the wake window starts a rotation; a shorter idle only gets the wake", () => withRotation(async (f) => {
	f.tasks.value = [{ taskId: "t1", status: "handoff_offered", ownerAgentId: "worker-1", pendingHandoffTo: "pi-sandbox-parent" }];
	f.clock.now = T0 + 4 * MIN;
	f.beat({ idleSince: T0 });
	assert.deepEqual(actionsOf(await f.tick()), ["wake-enqueued"], "4 minutes idle: the existing wake");
	f.clock.now = T0 + 9 * MIN;
	f.beat({ idleSince: T0 });
	const [action] = await f.tick();
	assert.equal(action!.action, "rotation-requested", "9 minutes idle and the wake did not help");
	assert.equal(f.record().rotation?.reason, "idle");
}));

const WAITING = [{ taskId: "t1", status: "handoff_offered", ownerAgentId: "worker-1", pendingHandoffTo: "pi-sandbox-parent" }];

test("a wake the leader holds on purpose is not a stuck leader: breaker, editor draft, open dialog and pause deny the idle rotation (review F2)", () => withRotation(async (f) => {
	f.tasks.value = WAITING;
	f.clock.now = T0 + 9 * MIN;
	for (const reason of ["group-paused", "editor-draft", "extension-prompt-open", "global-pause"]) {
		f.beat({ idleSince: T0, wakeHold: { reason, at: new Date(f.clock.now).toISOString() } });
		assert.notEqual((await f.tick())[0]!.action, "rotation-requested", reason);
	}
	assert.equal(f.record().rotation, null);
	// A hold the pump reports while the session is plainly idle is the stuck case rotation exists for.
	f.beat({ idleSince: T0, wakeHold: { reason: "not-idle", at: new Date(f.clock.now).toISOString() } });
	assert.equal((await f.tick())[0]!.action, "rotation-requested");
}));

test("a blocking decision, a full lane ceiling and recent operator input each deny rotation, for every reason (review F2)", () => withRotation(async (f) => {
	f.beat({ compaction: FAILED_COMPACTION });
	recordDecisionRef(PROGRAMME, { decisionId: "d1", blocking: true }, f.ctx);
	assert.notEqual((await f.tick())[0]!.action, "rotation-requested", "a blocking decision waits for the operator");
}));

test("a full lane ceiling denies the idle rotation", () => withRotation(async (f) => {
	f.tasks.value = WAITING;
	for (let lane = 0; lane < 5; lane += 1) reserveWriter(PROGRAMME, `lane:w${lane}`, f.ctx);
	f.clock.now = T0 + 9 * MIN;
	f.beat({ idleSince: T0 });
	assert.notEqual((await f.tick())[0]!.action, "rotation-requested");
}));

test("operator input in the last 10 minutes denies rotation, whatever the trigger; after that it may go ahead", () => withRotation(async (f) => {
	f.beat({ compaction: FAILED_COMPACTION, lastInputAt: T0 - 5 * MIN });
	assert.deepEqual(actionsOf(await f.tick()), ["none"], "the operator is driving this session");
	f.clock.now = T0 + 6 * MIN;
	f.beat({ compaction: FAILED_COMPACTION, lastInputAt: T0 - 5 * MIN });
	assert.equal((await f.tick())[0]!.action, "rotation-requested", "11 minutes since he last typed");
}));

test("an idle leader with nothing waiting is left alone however long it is idle", () => withRotation(async (f) => {
	f.clock.now = T0 + 60 * MIN;
	f.beat({ idleSince: T0 });
	assert.deepEqual(actionsOf(await f.tick()), ["none"]);
}));

test("pause and the kill file deny rotation", () => withRotation(async (f) => {
	f.beat({ compaction: FAILED_COMPACTION });
	writeFileSync(join(f.dir, "kill"), "stop");
	assert.deepEqual(actionsOf(await f.tick()), ["none"]);
	rmSync(join(f.dir, "kill"));
	pauseProgramme(PROGRAMME, "operator pause", f.ctx);
	assert.deepEqual(actionsOf(await f.tick()), ["none"]);
	assert.equal(f.record().rotation, null);
}));

test("a stale heartbeat is the existing outage alert, not a rotation", () => withRotation(async (f) => {
	f.beat({ compaction: FAILED_COMPACTION, at: T0 - 10 * MIN });
	assert.deepEqual(actionsOf(await f.tick()), ["alert-sent"]);
	assert.equal(f.record().rotation, null);
}));

test("a heartbeat written by another session than the owner does not trigger a rotation", () => withRotation(async (f) => {
	f.beat({ compaction: FAILED_COMPACTION, sessionId: "somebody-else" });
	assert.deepEqual(actionsOf(await f.tick()), ["none"]);
}));

// ─── Checkpoint and launch ───────────────────────────────────────────────────

async function requested(f: Fixture): Promise<string> {
	f.beat({ compaction: FAILED_COMPACTION });
	assert.equal((await f.tick())[0]!.action, "rotation-requested");
	return f.record().rotation!.ticket;
}

test("the tick waits for the leader's checkpoint, then launches a fresh parent with the catalogue's model, pane and brief", () => withRotation(async (f) => {
	const ticket = await requested(f);
	f.clock.now = T0 + 2 * MIN;
	f.beat({ compaction: FAILED_COMPACTION });
	assert.deepEqual(actionsOf(await f.tick()), ["none"], "no launch before the leader has checkpointed");
	assert.equal(f.launches.length, 0);
	markRotationCheckpointed(PROGRAMME, ticket, f.ctx, f.clock.now);
	const [action] = await f.tick();
	assert.equal(action!.action, "rotation-launched");
	assert.equal(f.launches.length, 1);
	const launch = f.launches[0]!;
	assert.equal(launch.ticket, ticket);
	assert.equal(launch.paneId, "wD:pA");
	assert.equal(launch.model, "provider/model-x");
	assert.equal(launch.thinking, "high");
	assert.equal(launch.cwd, "/home/operator/projects/sandbox", "the project checkout when the catalogue names no directory");
	assert.deepEqual(Object.keys(launch.env).sort(), ["PI_MUSTER_ROTATION", "PI_MUSTER_ROTATION_PROGRAMME"], "ticket and programme, never CONCORD_AGENT_ID");
	assert.ok(!("brief" in launch), "the brief is not part of the launch: it is typed nowhere");
	const brief = f.record().rotation!.brief!;
	assert.match(brief, /sandbox/);
	assert.match(brief, /docs\/plan\.md section 4/);
	assert.equal(f.record().rotation?.phase, "launched");
	assert.deepEqual(actionsOf(await f.tick()), ["none"], "a launched rotation is not launched twice");
	assert.equal(f.launches.length, 1);
}));

test("without an acknowledgement the tick launches after 5 minutes", () => withRotation(async (f) => {
	await requested(f);
	f.clock.now = T0 + 4 * MIN;
	f.beat({ compaction: FAILED_COMPACTION });
	assert.deepEqual(actionsOf(await f.tick()), ["none"]);
	f.clock.now = T0 + 5 * MIN + 1;
	f.beat({ compaction: FAILED_COMPACTION });
	assert.deepEqual(actionsOf(await f.tick()), ["rotation-launched"]);
}));

test("the kill file between the request and the launch cancels the rotation and launches nothing", () => withRotation(async (f) => {
	const ticket = await requested(f);
	markRotationCheckpointed(PROGRAMME, ticket, f.ctx, f.clock.now);
	writeFileSync(join(f.dir, "kill"), "stop");
	f.clock.now = T0 + MIN;
	f.beat({ compaction: FAILED_COMPACTION });
	await f.tick();
	assert.equal(f.launches.length, 0);
	assert.equal(f.record().rotation?.phase, "cancelled");
}));

test("the rotation wake's envelope tells the leader to checkpoint and stop, not to continue the programme (review F5)", () => {
	const rotation = programmeWakeEnvelopeText({ content: "rotation: refresh the checkpoint now" }, { wakeKind: "rotation", programmeId: PROGRAMME, sourceEventId: "rot-1" });
	assert.match(rotation, /\[Muster rotation/);
	assert.match(rotation, /refresh the checkpoint now/);
	assert.doesNotMatch(rotation, /continue the programme/i);
	assert.match(rotation, /checkpoint/i);
	const frontier = programmeWakeEnvelopeText({ content: "work waiting" }, { wakeKind: "frontier", programmeId: PROGRAMME, sourceEventId: "3-abc" });
	assert.match(frontier, /continue the programme/i, "other wakes are unchanged");
});

test("the launch waits while the leader is mid-run, up to 20 minutes, and goes at once when it is idle (review F5)", () => withRotation(async (f) => {
	const ticket = await requested(f);
	markRotationCheckpointed(PROGRAMME, ticket, f.ctx, f.clock.now);
	f.clock.now = T0 + 6 * MIN;
	f.beat({ compaction: FAILED_COMPACTION, idleSince: null });
	assert.deepEqual(actionsOf(await f.tick()), ["none"], "the leader is busy: replacing it now would cut a run in half");
	assert.equal(f.launches.length, 0);
	f.clock.now = T0 + 19 * MIN;
	f.beat({ compaction: FAILED_COMPACTION, idleSince: null });
	assert.deepEqual(actionsOf(await f.tick()), ["none"]);
	f.clock.now = T0 + 21 * MIN;
	f.beat({ compaction: FAILED_COMPACTION, idleSince: null });
	assert.deepEqual(actionsOf(await f.tick()), ["rotation-launched"], "a run that long is the stuck case the plan targets");
}));

test("the launch goes at once when the leader is idle after its checkpoint", () => withRotation(async (f) => {
	const ticket = await requested(f);
	markRotationCheckpointed(PROGRAMME, ticket, f.ctx, f.clock.now);
	f.clock.now = T0 + MIN;
	f.beat({ compaction: FAILED_COMPACTION, idleSince: T0 });
	assert.deepEqual(actionsOf(await f.tick()), ["rotation-launched"]);
}));

test("the fixed resume brief names the checkpoint, the reconcile and that workers are not touched", () => {
	const brief = resumeBrief({ project: "sandbox", checkpoint: "docs/plan.md section 4", reason: "compaction" });
	assert.match(brief, /muster_join/);
	assert.match(brief, /docs\/plan\.md section 4/);
	assert.match(brief, /Concord/);
	assert.match(brief, /Herdr/);
	assert.match(brief, /running worker/i);
	assert.equal(resumeBrief({ project: "sandbox", reason: "compaction", override: "Custom brief." }), "Custom brief.");
});

// ─── Failures, spacing and alerts ────────────────────────────────────────────

test("a failed launch is recorded, not alerted the first time, and not retried within 30 minutes", () => withRotation(async (f) => {
	const ticket = await requested(f);
	markRotationCheckpointed(PROGRAMME, ticket, f.ctx, f.clock.now);
	f.launchResult.launched = false;
	f.launchResult.error = "herdr pane split failed";
	f.clock.now = T0 + MIN;
	f.beat({ compaction: FAILED_COMPACTION });
	assert.deepEqual(actionsOf(await f.tick()), ["rotation-failed"]);
	assert.equal(f.record().rotation?.consecutiveFailures, 1);
	assert.equal(f.mailbox.length, 0, "one failure alerts nobody");
	f.clock.now = T0 + 20 * MIN;
	f.beat({ compaction: FAILED_COMPACTION });
	assert.deepEqual(actionsOf(await f.tick()), ["none"], "too soon for another rotation");
	assert.equal(f.launches.length, 1);
}));

test("a second consecutive failure alerts the operator once and rotation then stops trying for that leader", () => withRotation(async (f) => {
	f.launchResult.launched = false;
	f.launchResult.error = "no pane";
	for (const [index, start] of [0, 40].entries()) {
		f.clock.now = T0 + start * MIN;
		f.beat({ compaction: FAILED_COMPACTION });
		assert.equal((await f.tick())[0]!.action, "rotation-requested", `attempt ${index + 1}`);
		const ticket = f.record().rotation!.ticket;
		markRotationCheckpointed(PROGRAMME, ticket, f.ctx, f.clock.now);
		f.clock.now += MIN;
		f.beat({ compaction: FAILED_COMPACTION });
		assert.equal((await f.tick())[0]!.action, "rotation-failed");
	}
	assert.equal(f.mailbox.length, 1, "the second failure sends one alert");
	assert.ok(f.mailbox[0]!.key.startsWith(`${PROGRAMME}#rotation-failed#`), "the alert carries the mailbox path and the episode it is about");
	assert.match(f.mailbox[0]!.text, /sandbox/);
	assert.match(f.mailbox[0]!.text, /twice/);
	assert.match(f.mailbox[0]!.text, /Nothing was restarted/);
	for (const later of [90, 200]) {
		f.clock.now = T0 + later * MIN;
		f.beat({ compaction: FAILED_COMPACTION });
		assert.deepEqual(actionsOf(await f.tick()), ["none"], "no third attempt, no repeated alert");
	}
	assert.equal(f.mailbox.length, 1);
	assert.equal(f.launches.length, 2);
}));

test("a different leader starts clean: earlier failures belonged to the session they tried to replace", () => withRotation(async (f) => {
	f.launchResult.launched = false;
	for (const start of [0, 40]) {
		f.clock.now = T0 + start * MIN;
		f.beat({ compaction: FAILED_COMPACTION });
		await f.tick();
		markRotationCheckpointed(PROGRAMME, f.record().rotation!.ticket, f.ctx, f.clock.now);
		f.clock.now += MIN;
		f.beat({ compaction: FAILED_COMPACTION });
		await f.tick();
	}
	assert.equal(f.record().rotation?.consecutiveFailures, 2);
	attachProgramme(PROGRAMME, { sessionId: "operator-restarted", processKey: "pi-2-boot-1", operatorRef: "operator", guarded: true }, f.ctx);
	f.clock.now = T0 + 120 * MIN;
	f.beat({ compaction: FAILED_COMPACTION });
	assert.equal((await f.tick())[0]!.action, "rotation-requested");
	assert.equal(f.record().rotation?.consecutiveFailures, 0);
}));

test("a leader outside Herdr is replaced in an isolated workspace: the launch carries no pane (review F4)", () => withRotation(async (f) => {
	f.beat({ compaction: FAILED_COMPACTION, paneId: null });
	await f.tick();
	markRotationCheckpointed(PROGRAMME, f.record().rotation!.ticket, f.ctx, f.clock.now);
	f.clock.now += MIN;
	f.beat({ compaction: FAILED_COMPACTION, paneId: null });
	assert.equal((await f.tick())[0]!.action, "rotation-launched");
	assert.equal(f.launches[0]!.paneId, undefined);
}));

test("when the launcher cannot work, nothing starts and the leader is never asked to stop; the operator hears once a day (review F3 F4)", () => withRotation(async (f) => {
	f.ready.value = { ready: false, reason: "herdr was not found on PATH" };
	f.beat({ compaction: FAILED_COMPACTION });
	assert.notEqual((await f.tick())[0]!.action, "rotation-requested");
	assert.equal(f.record().rotation, null, "no rotation recorded");
	assert.equal(f.record().pendingWakes.some((wake) => wake.kind === "rotation"), false, "the leader was not told to stop");
	assert.equal(f.mailbox.length, 1);
	assert.match(f.mailbox[0]!.text, /herdr was not found on PATH/);
	assert.match(f.mailbox[0]!.text, /Nothing was restarted/);
	f.clock.now += 10 * MIN;
	f.beat({ compaction: FAILED_COMPACTION });
	await f.tick();
	assert.equal(f.mailbox.length, 1, "the same day: no second alert");
	f.clock.now += 24 * 60 * MIN;
	f.beat({ compaction: FAILED_COMPACTION });
	await f.tick();
	assert.equal(f.mailbox.length, 2, "the next day: again");
	f.ready.value = { ready: true };
	f.beat({ compaction: FAILED_COMPACTION });
	assert.equal((await f.tick())[0]!.action, "rotation-requested", "and as soon as the launcher works, rotation proceeds");
}));

test("a launched parent that never takes over fails the rotation after 10 minutes", () => withRotation(async (f) => {
	const ticket = await requested(f);
	markRotationCheckpointed(PROGRAMME, ticket, f.ctx, f.clock.now);
	f.clock.now = T0 + MIN;
	f.beat({ compaction: FAILED_COMPACTION });
	assert.equal((await f.tick())[0]!.action, "rotation-launched");
	f.clock.now = T0 + 9 * MIN;
	f.beat({ compaction: FAILED_COMPACTION });
	assert.deepEqual(actionsOf(await f.tick()), ["none"]);
	f.clock.now = T0 + 12 * MIN;
	f.beat({ compaction: FAILED_COMPACTION });
	assert.deepEqual(actionsOf(await f.tick()), ["rotation-failed"]);
	assert.match(f.record().rotation!.detail!, /no takeover/);
}));

test("a takeover the fresh session did not get to record is completed by the tick", () => withRotation(async (f) => {
	const ticket = await requested(f);
	markRotationCheckpointed(PROGRAMME, ticket, f.ctx, f.clock.now);
	f.clock.now = T0 + MIN;
	f.beat({ compaction: FAILED_COMPACTION });
	await f.tick();
	attachProgramme(PROGRAMME, { sessionId: "fresh-leader", processKey: "pi-9-boot-1", operatorRef: "operator", guarded: true }, f.ctx);
	f.clock.now = T0 + 2 * MIN;
	f.beat({ contextTokens: 5_000 });
	assert.deepEqual(actionsOf(await f.tick()), ["rotation-completed"]);
	assert.equal(f.record().rotation?.phase, "completed");
	assert.equal(f.record().rotation?.toSessionId, "fresh-leader");
}));

test("an idle rotation is not repeated within 2 hours of a completed one: it alerts instead", () => withRotation(async (f) => {
	f.tasks.value = [{ taskId: "t1", status: "handoff_offered", ownerAgentId: "worker-1", pendingHandoffTo: "pi-sandbox-parent" }];
	f.clock.now = T0 + 9 * MIN;
	f.beat({ idleSince: T0 });
	await f.tick();
	const ticket = f.record().rotation!.ticket;
	markRotationCheckpointed(PROGRAMME, ticket, f.ctx, f.clock.now);
	f.clock.now += MIN;
	f.beat({ idleSince: T0 });
	await f.tick();
	claimRotationTakeover(PROGRAMME, ticket, "fresh", f.ctx, f.clock.now);
	attachProgramme(PROGRAMME, { sessionId: "fresh", processKey: "pi-9-boot-1", operatorRef: "operator", guarded: true }, f.ctx);
	completeRotation(PROGRAMME, ticket, "fresh", f.ctx, f.clock.now);
	// The fresh leader is idle with work waiting again 40 minutes later: rotating did not help.
	f.clock.now += 40 * MIN;
	f.beat({ idleSince: f.clock.now - 10 * MIN });
	const [action] = await f.tick();
	assert.equal(action!.action, "rotation-alert");
	assert.match(action!.detail, /did not help/);
	assert.equal(f.mailbox.length, 1);
	assert.equal(f.record().rotation?.phase, "completed", "no new rotation was started");
}));

test("after a completed rotation, an owner that is not the fresh session (the operator took the project back) is left alone for 2 hours (review F7)", () => withRotation(async (f) => {
	const ticket = await requested(f);
	markRotationCheckpointed(PROGRAMME, ticket, f.ctx, f.clock.now);
	f.clock.now = T0 + MIN;
	f.beat({ compaction: FAILED_COMPACTION });
	await f.tick();
	attachProgramme(PROGRAMME, { sessionId: "fresh", processKey: "pi-9-boot-1", operatorRef: "operator", guarded: true }, f.ctx);
	completeRotation(PROGRAMME, ticket, "fresh", f.ctx, f.clock.now);
	// the operator goes back to the old session on purpose.
	attachProgramme(PROGRAMME, { sessionId: "old-leader", processKey: "pi-1-boot-1", operatorRef: "operator", guarded: true }, f.ctx);
	f.clock.now = T0 + 40 * MIN;
	f.beat({ compaction: FAILED_COMPACTION });
	assert.deepEqual(actionsOf(await f.tick()), ["none"], "his choice stands");
	f.clock.now = T0 + 130 * MIN;
	f.beat({ compaction: FAILED_COMPACTION });
	assert.equal((await f.tick())[0]!.action, "rotation-requested", "after 2 hours it may be rotated again");
}));

test("the threshold is at most 80% of the model's window (review F9)", () => withRotation(async (f) => {
	// A 200k model with the default 250k threshold would never reach it: the effective threshold is 160k.
	f.setCatalogue(catalogue({ rotateAtTokens: 250_000 }));
	recordHeartbeat(PROGRAMME, {
		pid: process.pid,
		sessionId: f.record().owner!.sessionId,
		generation: 1,
		contextTokens: 170_000,
		contextWindow: 200_000,
		compaction: { at: new Date(T0).toISOString(), outcome: "completed", tokensAfter: 170_000 },
	}, f.ctx);
	const written = f.record();
	f.ctx.store!.update(PROGRAMME, written.revision, () => ({ ...written, revision: written.revision + 1, lastHeartbeat: { ...written.lastHeartbeat!, at: new Date(f.clock.now).toISOString() } }));
	assert.equal((await f.tick())[0]!.action, "rotation-requested");
	assert.equal(f.record().rotation?.reason, "compaction");
}));

test("the tick library still holds no process-control capability", () => {
	for (const file of ["../tick.ts", "../rotation.ts"]) {
		const source = readFileSync(new URL(file, import.meta.url), "utf8");
		assert.doesNotMatch(source, /child_process|process\.kill|\.kill\(|execSync|spawn/, `${file} cannot start or stop a process`);
	}
});
