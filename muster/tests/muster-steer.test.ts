import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MusterJournal, WakePump, type WakePumpDeps } from "../inbox.ts";
import { attachProgramme, claimContinuation, enqueueWake, fileProgrammeControlStore, pauseProgramme, readProgrammeSnapshot } from "../control.ts";
import { admitProgrammeSteer, resetProgrammeContinuations, wakeBatchNeedsAdmission } from "../control-bridge.ts";
import type { SessionBinding, WakeSendOptions } from "../types.ts";

/**
 * R1 item 3: handoffs interrupt. A `handoff-offered` relay reaches a parent that
 * is mid-turn as a steer instead of waiting for the turn to end, and still goes
 * as a follow-up when the parent is idle. Everything else keeps waiting.
 */

type State = {
	/** When set, isIdle answers from this list call by call, then keeps the last value. */
	idleScript?: boolean[];
	idle: boolean;
	promptDepth: number;
	editorDraft: boolean;
	globalPause: boolean;
	sends: WakeSendOptions[];
	/** The pending count seen at each onPendingChange call (the lane card's pendingIn). */
	pendingSeen: number[];
};

function pumpFixture(journal: MusterJournal): { pump: WakePump; state: State } {
	const state: State = { idle: true, promptDepth: 0, editorDraft: false, globalPause: false, sends: [], pendingSeen: [] };
	const binding: SessionBinding = {
		schemaVersion: 1,
		sessionId: "sess-steer",
		defaultRepo: "sandbox",
		repos: [{ alias: "sandbox", repoKey: "repo-1", primaryRoot: "/r", checkoutRoots: ["/r"], workspaceId: "ws_x", agentId: "pi-sandbox-parent", supervisedTaskIds: [] }],
	};
	const recorded = new Map<string, string[]>();
	let pump: WakePump | undefined;
	const deps: WakePumpDeps = {
		onPendingChange: () => { state.pendingSeen.push(pump?.pendingCount() ?? 0); },
		generation: () => 1,
		binding: () => binding,
		groupOf: (entry) => (entry.target.kind === "task-event" ? `task:${entry.target.taskId}` : "other"),
		groupPaused: () => false,
		globalPause: () => state.globalPause,
		killFileExists: () => false,
		isEnvDisabled: () => false,
		isIdle: () => (state.idleScript !== undefined ? (state.idleScript.length > 1 ? state.idleScript.shift()! : state.idleScript[0]!) : state.idle),
		extensionPromptDepth: () => state.promptDepth,
		editorDraftNonEmpty: () => state.editorDraft,
		sendBatch: async (options) => {
			state.sends.push(options);
			for (const delivery of options.details.deliveries as Array<{ deliveryKey: string }>) recorded.set(delivery.deliveryKey, [`entry-${state.sends.length}`]);
		},
		findRecordedEntries: async (deliveryKey) => recorded.get(deliveryKey) ?? [],
		sessionFile: () => undefined,
		journal: { append: (record) => journal.append(record) },
		recordingPoll: { attempts: 2, intervalMs: 1 },
		retryDelayMs: 60_000,
	};
	pump = new WakePump(deps);
	return { pump, state };
}

const handoff = (taskId = "t1", version = 3, handoffId = 9) => ({ repoKey: "repo-1", taskId, version, pendingHandoffId: handoffId, eventKind: "handoff-offered", content: `${taskId} offered` });
const completed = (taskId = "t2", version = 5) => ({ repoKey: "repo-1", taskId, version, eventKind: "complete", content: `${taskId} complete` });

async function withPump(run: (f: ReturnType<typeof pumpFixture>) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "muster-steer-"));
	try {
		await run(pumpFixture(new MusterJournal("sess-steer", dir)));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("a handoff offered while the parent is mid-turn is delivered as a steer", async () => {
	await withPump(async ({ pump, state }) => {
		state.idle = false;
		pump.enqueueTaskEvent(handoff());
		const result = await pump.pump();
		assert.equal(result.delivered, true);
		assert.equal(state.sends.length, 1);
		assert.equal(state.sends[0]!.deliverAs, "steer");
		assert.match(state.sends[0]!.content, /t1 offered/);
	});
});

test("the same handoff reaches an idle parent as a follow-up", async () => {
	await withPump(async ({ pump, state }) => {
		pump.enqueueTaskEvent(handoff());
		await pump.pump();
		assert.equal(state.sends[0]!.deliverAs, "followUp");
	});
});

test("other events still wait for the turn to end, then go as a follow-up", async () => {
	await withPump(async ({ pump, state }) => {
		state.idle = false;
		pump.enqueueTaskEvent(completed());
		const held = await pump.pump();
		assert.deepEqual(held, { delivered: false, reason: "not-idle" });
		assert.equal(state.sends.length, 0);
		state.idle = true;
		await pump.pump();
		assert.equal(state.sends.length, 1);
		assert.equal(state.sends[0]!.deliverAs, "followUp");
	});
});

test("the pending count is published when a message is queued and again when it is taken", async () => {
	await withPump(async ({ pump, state }) => {
		state.idle = false;
		pump.enqueueTaskEvent(completed());
		assert.deepEqual(state.pendingSeen, [1], "queued: the lane card shows 1 held");
		await pump.pump();
		assert.deepEqual(state.pendingSeen, [1], "held by the not-idle gate: still 1, nothing new to publish");
		state.idle = true;
		await pump.pump();
		assert.deepEqual(state.pendingSeen, [1, 0], "recorded in the conversation: the card goes back to 0");
	});
});

test("a mixed backlog mid-turn steers only the handoff, and the handoff is never sent twice", async () => {
	await withPump(async ({ pump, state }) => {
		state.idle = false;
		pump.enqueueTaskEvent(completed("t2"));
		pump.enqueueTaskEvent(handoff("t1"));
		await pump.pump();
		assert.equal(state.sends.length, 1);
		assert.equal(state.sends[0]!.deliverAs, "steer");
		assert.doesNotMatch(state.sends[0]!.content, /t2 complete/);
		state.idle = true;
		await pump.pump();
		assert.equal(state.sends.length, 2);
		assert.match(state.sends[1]!.content, /t2 complete/);
		assert.doesNotMatch(state.sends[1]!.content, /t1 offered/);
	});
});

test("a batch the gates cleared as a follow-up is not turned into a steer by a turn that starts meanwhile (F18)", async () => {
	await withPump(async ({ pump, state }) => {
		pump.enqueueTaskEvent(completed());
		// idle at the interaction gate and at the recheck, busy by the time the send is decided
		state.idleScript = [true, true, false];
		await pump.pump();
		assert.equal(state.sends.length, 1);
		assert.equal(state.sends[0]!.deliverAs, "followUp");
	});
});

test("the same handoff enqueued twice while mid-turn is steered once", async () => {
	await withPump(async ({ pump, state }) => {
		state.idle = false;
		pump.enqueueTaskEvent(handoff());
		pump.enqueueTaskEvent(handoff());
		await pump.pump();
		await pump.pump();
		assert.equal(state.sends.length, 1);
	});
});

test("a steer still respects global pause, an open extension prompt and an editor draft", async () => {
	await withPump(async ({ pump, state }) => {
		state.idle = false;
		pump.enqueueTaskEvent(handoff());
		state.globalPause = true;
		assert.equal((await pump.pump()).reason, "global-pause");
		state.globalPause = false;
		state.promptDepth = 1;
		assert.equal((await pump.pump()).reason, "extension-prompt-open");
		state.promptDepth = 0;
		state.editorDraft = true;
		assert.equal((await pump.pump()).reason, "editor-draft");
		assert.equal(state.sends.length, 0);
		state.editorDraft = false;
		assert.equal((await pump.pump()).delivered, true);
	});
});

// ─── A programme wake needs an admitted claim (F9) ───────────────────────────

const wakeDetails = { deliveries: [{ deliveryKey: "pwake/frontier/3-abc", reason: "work waiting" }], source: "muster" };
const relayDetails = { deliveries: [{ deliveryKey: "msg/m-1", messageId: "m-1" }], source: "muster" };

test("a batch with a programme wake may not go out unless admission admitted it", () => {
	assert.equal(wakeBatchNeedsAdmission("not-enrolled", wakeDetails), true, "a session that is not the owner must not run a continuation");
	assert.equal(wakeBatchNeedsAdmission("admitted", wakeDetails), false);
	assert.equal(wakeBatchNeedsAdmission("not-enrolled", relayDetails), false, "ordinary relays keep their old path for sessions with no programme");
	assert.equal(wakeBatchNeedsAdmission("not-enrolled", { deliveries: [...wakeDetails.deliveries, ...relayDetails.deliveries] }), true, "one wake in the batch is enough");
	assert.equal(wakeBatchNeedsAdmission("not-enrolled", undefined), false);
});

// ─── Steer admission: no claim, the programme gates still apply ──────────────

const ID = "agp_5a5a5a5a5a5a";
const OWNER = { sessionId: "owner", processKey: "pi-1-boot-1", operatorRef: "operator", guarded: true };

function withControl(run: (ctx: { store: ReturnType<typeof fileProgrammeControlStore>; killFilePath: string; controlDir: string; processKey: string }) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "muster-steer-control-"));
	mkdirSync(dir, { recursive: true });
	resetProgrammeContinuations();
	try {
		const store = fileProgrammeControlStore(dir);
		attachProgramme(ID, OWNER, { store, killFilePath: join(dir, "kill") });
		run({ store, killFilePath: join(dir, "kill"), controlDir: dir, processKey: OWNER.processKey });
	} finally {
		resetProgrammeContinuations();
		rmSync(dir, { recursive: true, force: true });
	}
}

const events = [{ sourceEventId: "task-event/t1", kind: "handoff" as const, reason: "t1 offered" }];

test("steer admission admits a running owner mid-run without taking or disturbing the claim", () => {
	withControl((ctx) => {
		enqueueWake(ID, { sourceEventId: "w0", kind: "handoff", reason: "earlier" }, ctx);
		const claim = claimContinuation(ID, OWNER.sessionId, ctx) as { outcome: "admitted"; claimId: string };
		const before = readProgrammeSnapshot(ID, ctx);
		assert.deepEqual(admitProgrammeSteer({ sessionRef: OWNER.sessionId, events }, ctx), { outcome: "admitted", programmeId: ID });
		const after = readProgrammeSnapshot(ID, ctx);
		assert.equal(after.activeClaim?.claimId, claim.claimId);
		assert.equal(after.revision, before.revision, "nothing was written");
	});
});

test("steer admission is denied for a paused programme, the kill file and a stranger", () => {
	withControl((ctx) => {
		assert.deepEqual(admitProgrammeSteer({ sessionRef: "stranger", events }, ctx), { outcome: "not-enrolled" });
		writeFileSync(ctx.killFilePath, "stop");
		assert.deepEqual(admitProgrammeSteer({ sessionRef: OWNER.sessionId, events }, ctx), { outcome: "denied", programmeId: ID, reason: "kill-file" });
		rmSync(ctx.killFilePath);
		pauseProgramme(ID, "operator pause", ctx);
		assert.deepEqual(admitProgrammeSteer({ sessionRef: OWNER.sessionId, events }, ctx), { outcome: "denied", programmeId: ID, reason: "programme-paused" });
	});
});
