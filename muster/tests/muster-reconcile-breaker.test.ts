import "./muster-test-isolation.ts";
/**
 * Model-free regressions for the Muster reconciler, no-progress breaker and
 * Herdr integration (acceptance V6, V9, V11).
 *
 * These use only fakes: a fake Concord client for reconciliation, an in-memory
 * persist/restore pair for the breaker, a fake event emitter for the balanced
 * attention span, and pure argv construction for the Herdr metadata report.
 * No model turns, no network, no live sessions.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { NoProgressBreaker, threadRootId } from "../breaker.ts";
import type { BreakerDeps } from "../breaker.ts";
import { Reconciler, observeTask, reconcileEventContent } from "../reconcile.ts";
import type { ReconcileEvent } from "../reconcile.ts";
import {
	BreakerAttentionSpan,
	buildMetadataArgs,
	clearMetadata,
	readHerdrContext,
	reportMetadata,
} from "../herdr.ts";
import type { BreakerState, RepoBinding } from "../types.ts";

// ─── Shared fixtures ─────────────────────────────────────────────────────────

type StructuredResult = { structuredContent?: Record<string, unknown> };

type FakeConcord = {
	callTool: (name: string, args: Record<string, unknown>, o?: unknown) => Promise<StructuredResult>;
	calls: Array<{ name: string; taskId: string | undefined }>;
	responses: Map<string, Record<string, unknown>>;
};

function taskScope(
	task: Record<string, unknown>,
	pendingHandoff: Record<string, unknown> | null = null,
): Record<string, unknown> {
	return {
		scope: "task",
		task,
		pending_handoff: pendingHandoff,
		latest_handoff: null,
		ownership_history: [],
		updates: [],
	};
}

function fakeConcord(): FakeConcord {
	const responses = new Map<string, Record<string, unknown>>();
	const calls: FakeConcord["calls"] = [];
	return {
		responses,
		calls,
		callTool: async (name, args) => {
			const taskId = typeof args.task_id === "string" ? args.task_id : undefined;
			void taskId;
			calls.push({ name, taskId });
			const structured = taskId === undefined ? undefined : responses.get(taskId);
			return structured === undefined ? {} : { structuredContent: structuredClone(structured) };
		},
	};
}

function bindingFor(supervisedTaskIds: string[]): RepoBinding {
	return {
		alias: "sandbox",
		repoKey: "/repo/sandbox",
		primaryRoot: "/repo/sandbox",
		checkoutRoots: ["/repo/sandbox"],
		workspaceId: "ws_test",
		agentId: "pi-parent",
		supervisedTaskIds,
	};
}

/** Same key shape as inbox.taskEventDeliveryKey (repoKey is not part of the string). */
function deliveryKeyOf(event: ReconcileEvent): string {
	const handoff = event.pendingHandoffId === undefined ? "-" : String(event.pendingHandoffId);
	return `task-event/${event.taskId}/${event.version}/${handoff}/${event.eventKind}`;
}

type BreakerHarness = {
	deps: BreakerDeps;
	persisted: BreakerState[];
	store: { state?: BreakerState };
};

function breakerHarness(threshold = 20): BreakerHarness {
	const store: { state?: BreakerState } = {};
	const persisted: BreakerState[] = [];
	const deps: BreakerDeps = {
		threshold,
		persist: async (state) => {
			const copy = structuredClone(state);
			store.state = copy;
			persisted.push(copy);
		},
		restore: async () => (store.state === undefined ? undefined : structuredClone(store.state)),
	};
	return { deps, persisted, store };
}

// ─── V6 — completion reconciliation ──────────────────────────────────────────

test("V6: reconciliation fires one new handoff, ignores churn, then reports completion", async () => {
	const client = fakeConcord();
	const binding = bindingFor(["task-a"]);
	const known = new Set<string>();
	const delivered: ReconcileEvent[] = [];
	const reconciler = new Reconciler({
		concordFor: (repoKey) => (repoKey === binding.repoKey ? client : undefined),
		supervisedTaskIds: (b) => b.supervisedTaskIds,
		alreadyKnown: (key) => known.has(key),
		onEvent: (_binding, event) => {
			known.add(deliveryKeyOf(event));
			delivered.push(event);
		},
	});

	client.responses.set(
		"task-a",
		taskScope({ taskId: "task-a", status: "active", version: 3, agentId: "worker-1", assignedAgentId: "worker-1" }),
	);
	assert.deepEqual(await reconciler.pass(binding), [], "baseline active inspection must not wake the parent");
	assert.equal(delivered.length, 0);
	assert.deepEqual(client.calls, [{ name: "inspect_work", taskId: "task-a" }]);

	client.responses.set(
		"task-a",
		taskScope(
			{
				taskId: "task-a",
				status: "handoff_offered",
				version: 4,
				agentId: "worker-1",
				assignedAgentId: "pi-parent",
			},
			{ id: 7, taskId: "task-a", fromAgentId: "worker-1", toAgentId: "pi-parent" },
		),
	);
	const offered = await reconciler.pass(binding);
	assert.equal(offered.length, 1);
	assert.equal(offered[0].eventKind, "handoff-offered");
	assert.equal(offered[0].taskId, "task-a");
	assert.equal(offered[0].version, 4);
	assert.equal(offered[0].pendingHandoffId, 7);
	assert.match(offered[0].content, /task-a/);
	assert.match(offered[0].content, /v4/);
	assert.match(offered[0].content, /handoff 7/);
	assert.match(offered[0].content, /worker-1/);

	assert.deepEqual(await reconciler.pass(binding), [], "an unchanged pending handoff must not re-fire");
	assert.equal(delivered.length, 1);

	// Ordinary version churn without a pending handoff is not an event.
	client.responses.set(
		"task-a",
		taskScope({ taskId: "task-a", status: "active", version: 5, agentId: "worker-1", assignedAgentId: "worker-1" }),
	);
	assert.deepEqual(await reconciler.pass(binding), []);
	assert.equal(delivered.length, 1);

	client.responses.set(
		"task-a",
		taskScope({ taskId: "task-a", status: "complete", version: 6, agentId: "worker-1", assignedAgentId: "worker-1" }),
	);
	const completed = await reconciler.pass(binding);
	assert.equal(completed.length, 1);
	assert.equal(completed[0].eventKind, "complete");
	assert.equal(completed[0].version, 6);
	assert.deepEqual(await reconciler.pass(binding), [], "a terminal result is delivered once");
	await reconciler.stop();
});

test("V6: a handoff offered while the parent was offline fires on the first pass", async () => {
	const known = new Set<string>(["task-event/task-a/4/7/handoff-offered"]);
	const client = fakeConcord();
	client.responses.set(
		"task-a",
		taskScope(
			{
				taskId: "task-a",
				status: "handoff_offered",
				version: 4,
				agentId: "worker-1",
				assignedAgentId: "pi-parent",
			},
			{ id: 7, taskId: "task-a", fromAgentId: "worker-1", toAgentId: "pi-parent" },
		),
	);
	client.responses.set(
		"task-b",
		taskScope(
			{
				taskId: "task-b",
				status: "handoff_offered",
				version: 2,
				agentId: "worker-2",
				assignedAgentId: "pi-parent",
			},
			{ id: 9, taskId: "task-b", fromAgentId: "worker-2", toAgentId: "pi-parent" },
		),
	);
	const delivered: ReconcileEvent[] = [];
	const reconciler = new Reconciler({
		concordFor: () => client,
		supervisedTaskIds: (b) => b.supervisedTaskIds,
		alreadyKnown: (key) => known.has(key),
		onEvent: (_binding, event) => {
			known.add(deliveryKeyOf(event));
			delivered.push(event);
		},
	});
	const events = await reconciler.pass(bindingFor(["task-a", "task-b"]));
	assert.equal(events.length, 1, "only the offline-offered handoff is new");
	assert.equal(events[0].taskId, "task-b");
	assert.equal(events[0].eventKind, "handoff-offered");
	assert.equal(events[0].pendingHandoffId, 9);
	assert.equal(delivered.length, 1);
	await reconciler.stop();
});

test("V6: malformed inspection payloads degrade to null and produce no events", async () => {
	assert.equal(observeTask(undefined), null);
	assert.equal(observeTask({ scope: "message", task: { taskId: "t", status: "active", version: 1 } }), null);
	assert.equal(observeTask({ scope: "task", task: { taskId: "", status: "active", version: 1 } }), null);
	assert.equal(observeTask({ scope: "task", task: { taskId: "t", status: "active", version: 0 } }), null);
	assert.equal(
		observeTask({ scope: "task", task: { taskId: "t", status: "active", version: 2 }, pending_handoff: { id: "7" } }),
		null,
	);
	const observation = observeTask({
		scope: "task",
		task: {
			taskId: "t",
			status: "handoff_offered",
			version: 4,
			updatedAt: "2026-09-13T00:00:00.000Z",
			agentId: "worker-1",
			assignedAgentId: "pi-parent",
		},
		pending_handoff: { id: 7, fromAgentId: "worker-1" },
		latest_handoff: { id: 6 },
	});
	assert.ok(observation);
	assert.equal(observation.pendingHandoffId, 7);
	assert.equal(observation.pendingHandoffFrom, "worker-1");
	assert.equal(observation.ownerAgentId, "worker-1");
	assert.equal(observation.assignedAgentId, "pi-parent");
	assert.equal(observation.latestHandoffId, 6);

	const client = fakeConcord();
	client.responses.set("task-a", { scope: "task", task: { taskId: "task-a", status: "active", version: Number.NaN } });
	const delivered: ReconcileEvent[] = [];
	const reconciler = new Reconciler({
		concordFor: () => client,
		supervisedTaskIds: (b) => b.supervisedTaskIds,
		alreadyKnown: () => false,
		onEvent: (_binding, event) => delivered.push(event),
	});
	assert.deepEqual(await reconciler.pass(bindingFor(["task-a"])), []);
	assert.equal(delivered.length, 0);
	await reconciler.stop();
});

test("V6: at most one inspection pass per connection is in flight", async () => {
	let releasePass: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		releasePass = resolve;
	});
	let calls = 0;
	const client = {
		callTool: async (): Promise<StructuredResult> => {
			calls += 1;
			await gate;
			return { structuredContent: taskScope({ taskId: "task-a", status: "active", version: 3 }) };
		},
	};
	const reconciler = new Reconciler({
		concordFor: () => client,
		supervisedTaskIds: (b) => b.supervisedTaskIds,
		alreadyKnown: () => false,
		onEvent: () => undefined,
	});
	const first = reconciler.pass(bindingFor(["task-a"]));
	const skipped = await reconciler.pass(bindingFor(["task-a"]));
	assert.deepEqual(skipped, [], "a second pass for the same connection is skipped, not queued");
	releasePass?.();
	assert.deepEqual(await first, []);
	assert.equal(calls, 1);
	await reconciler.stop();
});

test("V6: the reconciler timer starts and stops idempotently", async () => {
	const reconciler = new Reconciler({
		concordFor: () => undefined,
		supervisedTaskIds: () => [],
		alreadyKnown: () => false,
		onEvent: () => undefined,
		intervalMs: 10,
	});
	assert.doesNotThrow(() => reconciler.start());
	assert.doesNotThrow(() => reconciler.start());
	await reconciler.stop();
	await reconciler.stop();
});

test("V6: event content names task, kind, version and handoff sender", () => {
	const content = reconcileEventContent({
		eventKind: "handoff-offered",
		taskId: "task-a",
		version: 4,
		pendingHandoffId: 7,
		content: "",
	});
	assert.match(content, /task-a/);
	assert.match(content, /v4/);
	assert.match(content, /handoff 7/);
	assert.equal(reconcileEventContent({ eventKind: "blocked-task", taskId: "task-b", version: 2, content: "" }), "task task-b v2: blocked — an actionable blocker needs attention.");
});

// ─── V9 — no-progress loop breaker ───────────────────────────────────────────

test("V9: a fresh-ID taskless A↔B loop trips at the threshold and stays paused", async () => {
	const { deps } = breakerHarness();
	const breaker = new NoProgressBreaker(deps);
	const pairAtoB = "pair:/repo/one:a->b";
	const pairBtoA = "pair:/repo/one:b->a";
	const threadFor = (direction: "a-b" | "b-a", run: number): string => {
		const [sender, recipient] = direction === "a-b" ? ["a", "b"] : ["b", "a"];
		return breaker.groupKey({
			repoKey: "/repo/one",
			threadRootMessageId: `root-${direction}-${run}`,
			senderAgentId: sender,
			recipientAgentId: recipient,
		});
	};
	const firstRoot = threadFor("a-b", 1);
	assert.equal(firstRoot, "thread:/repo/one:root-a-b-1");

	let tripped: string[] = [];
	for (let run = 1; run <= 20; run += 1) {
		breaker.beginRun([threadFor("a-b", run), threadFor("b-a", run)]);
		const outcome = await breaker.endRun();
		if (run < 20) assert.deepEqual(outcome.tripped, [], `run ${run} must not trip`);
		else tripped = outcome.tripped;
	}
	// Fresh roots never reset the shared pair counters, so the pair groups trip.
	assert.deepEqual([...tripped].sort(), [pairAtoB, pairBtoA]);
	assert.deepEqual(breaker.pausedGroups().sort(), [pairAtoB, pairBtoA].sort());
	for (const group of [pairAtoB, pairBtoA]) {
		assert.equal(breaker.state().groups[group].consecutiveNoProgressRuns, 20);
		assert.equal(breaker.isPaused(group), true);
	}

	// Intake is retained while paused: a fresh root between the same two agents
	// resolves to a paused pair, and the 21st run counts nothing.
	const freshRoot = threadFor("a-b", 21);
	const freshRootB = threadFor("b-a", 21);
	assert.equal(breaker.isPaused(freshRoot), true, "a paused pair gates new roots between the same agents");
	breaker.beginRun([freshRoot, freshRootB]);
	const suppressed = await breaker.endRun();
	assert.deepEqual(suppressed.tripped, []);
	for (const group of [pairAtoB, pairBtoA]) {
		assert.equal(breaker.state().groups[group].consecutiveNoProgressRuns, 20);
		assert.equal(breaker.isPaused(group), true);
	}

	// Explicit resume of the gated root clears the shared pair for that direction.
	await breaker.resume(freshRoot);
	assert.equal(breaker.isPaused(freshRoot), false);
	assert.equal(breaker.isPaused(freshRootB), true, "the other direction stays paused until explicitly resumed");
	assert.equal(breaker.state().groups[pairAtoB].consecutiveNoProgressRuns, 0);
	await breaker.resume(freshRootB);
	assert.deepEqual(breaker.pausedGroups(), []);
});

test("V9: observed new progress permits far more than 20 autonomous runs", async () => {
	const { deps } = breakerHarness();
	const breaker = new NoProgressBreaker(deps);
	const group = "task:/repo/one/task-progress";
	for (let run = 1; run <= 25; run += 1) {
		const fingerprint = `sha256:round-${run}`;
		assert.equal(breaker.fingerprintIsNew(group, fingerprint), true);
		breaker.noteProgress({ kind: "file-fingerprint", group, fingerprint, paths: ["src/loop.ts"] });
		breaker.beginRun([group]);
		const outcome = await breaker.endRun();
		assert.deepEqual(outcome.tripped, [], `run ${run} progressed`);
	}
	assert.equal(breaker.state().groups[group].consecutiveNoProgressRuns, 0);
	assert.equal(breaker.state().groups[group].seenFingerprints?.length, 25);
	assert.equal(breaker.isPaused(group), false);
});

test("V9: seen fingerprints are capped FIFO at 200", async () => {
	const { deps } = breakerHarness();
	const breaker = new NoProgressBreaker(deps);
	const group = "task:/repo/one/task-cap";
	for (let index = 0; index < 205; index += 1) {
		breaker.noteProgress({ kind: "file-fingerprint", group, fingerprint: `fp-${index}`, paths: [] });
	}
	const seen = breaker.state().groups[group].seenFingerprints ?? [];
	assert.equal(seen.length, 200);
	assert.equal(seen[0], "fp-5");
	assert.equal(seen[199], "fp-204");
	assert.equal(breaker.fingerprintIsNew(group, "fp-0"), true, "an evicted fingerprint is new again");
	assert.equal(breaker.fingerprintIsNew(group, "fp-204"), false);
});

test("V9: timestamp/prose/new-root churn never resets a group", async () => {
	const { deps } = breakerHarness();
	const breaker = new NoProgressBreaker(deps);
	const pair = "pair:/repo/one:a->b";
	const firstRoot = breaker.groupKey({
		repoKey: "/repo/one",
		threadRootMessageId: "root-1",
		senderAgentId: "a",
		recipientAgentId: "b",
	});
	breaker.beginRun([firstRoot]);
	assert.equal(breaker.fingerprintIsNew(pair, "unchanged-content"), true);
	breaker.noteProgress({ kind: "file-fingerprint", group: pair, fingerprint: "unchanged-content", paths: ["x.ts"] });
	await breaker.endRun();
	assert.equal(breaker.state().groups[pair].consecutiveNoProgressRuns, 0);

	// Re-noting the same fingerprint (toggling back to a seen state) is not progress.
	assert.equal(breaker.fingerprintIsNew(pair, "unchanged-content"), false);
	breaker.noteProgress({ kind: "file-fingerprint", group: pair, fingerprint: "unchanged-content", paths: ["x.ts"] });
	const secondRoot = breaker.groupKey({
		repoKey: "/repo/one",
		threadRootMessageId: "root-2",
		senderAgentId: "a",
		recipientAgentId: "b",
	});
	breaker.beginRun([secondRoot]);
	await breaker.endRun();
	assert.equal(breaker.state().groups[pair].consecutiveNoProgressRuns, 1, "a re-seen fingerprint must not reset");

	// New roots between the same two agents keep incrementing the shared pair counter.
	for (let index = 3; index <= 5; index += 1) {
		const root = breaker.groupKey({
			repoKey: "/repo/one",
			threadRootMessageId: `root-${index}`,
			senderAgentId: "a",
			recipientAgentId: "b",
		});
		breaker.beginRun([root]);
		await breaker.endRun();
	}
	assert.equal(breaker.state().groups[pair].consecutiveNoProgressRuns, 4);
	assert.equal(breaker.state().groups[firstRoot].consecutiveNoProgressRuns, 1);
	assert.equal(breaker.state().groups[secondRoot].consecutiveNoProgressRuns, 1);
});

test("V9: progress on task A cannot reset or pause unrelated task B", async () => {
	const { deps } = breakerHarness();
	const breaker = new NoProgressBreaker(deps);
	const taskA = "task:/repo/one/task-a";
	const taskB = "task:/repo/one/task-b";
	breaker.beginRun([taskA, taskB]);
	breaker.noteProgress({ kind: "ownership-transition", group: taskA, transition: "offer→accepted", taskId: "task-a" });
	const { tripped } = await breaker.endRun();
	assert.deepEqual(tripped, []);
	assert.equal(breaker.state().groups[taskA].consecutiveNoProgressRuns, 0);
	assert.equal(breaker.state().groups[taskB].consecutiveNoProgressRuns, 1);
	assert.equal(breaker.isPaused(taskB), false);
});

test("V9: restart preserves counters and pauses; explicit resume clears them", async () => {
	const { deps } = breakerHarness(3);
	const breaker = new NoProgressBreaker(deps);
	const group = "task:/repo/one/task-restart";
	breaker.noteProgress({ kind: "file-fingerprint", group, fingerprint: "fp-keep", paths: ["a.ts"] });
	for (let run = 1; run <= 4; run += 1) {
		breaker.beginRun([group]);
		await breaker.endRun();
	}
	assert.equal(breaker.isPaused(group), true);
	assert.equal(breaker.state().groups[group].consecutiveNoProgressRuns, 3);

	const restarted = new NoProgressBreaker(deps);
	await restarted.restore();
	assert.equal(restarted.state().groups[group].consecutiveNoProgressRuns, 3);
	assert.equal(restarted.isPaused(group), true);
	assert.deepEqual(restarted.pausedGroups(), [group]);
	assert.deepEqual(restarted.state().groups[group].seenFingerprints, ["fp-keep"]);

	// Replayed runs for a paused group count nothing.
	restarted.beginRun([group]);
	assert.deepEqual((await restarted.endRun()).tripped, []);
	assert.equal(restarted.state().groups[group].consecutiveNoProgressRuns, 3);

	await restarted.resume(group);
	assert.equal(restarted.isPaused(group), false);
	assert.equal(restarted.state().groups[group].consecutiveNoProgressRuns, 0);
	assert.deepEqual(restarted.pausedGroups(), []);
	assert.deepEqual(restarted.state().groups[group].seenFingerprints, ["fp-keep"], "resume preserves seen fingerprints");

	const third = new NoProgressBreaker(deps);
	await third.restore();
	assert.equal(third.isPaused(group), false);
	assert.equal(third.state().groups[group].consecutiveNoProgressRuns, 0);
});

// ─── V9 — thread root resolution ─────────────────────────────────────────────

test("V9: thread roots come from the structured thread, never the newest reply", () => {
	assert.equal(threadRootId([]), undefined);
	assert.equal(
		threadRootId([
			{ messageId: "root-1", replyToMessageId: null },
			{ messageId: "reply-2", replyToMessageId: "root-1" },
		]),
		"root-1",
	);
	assert.equal(
		threadRootId([
			{ messageId: "reply-2", replyToMessageId: "root-1" },
			{ messageId: "root-1", replyToMessageId: null },
		]),
		"root-1",
		"an explicit root row wins regardless of array order",
	);
	assert.equal(
		threadRootId([
			{ messageId: "newest-3", replyToMessageId: "middle-2" },
			{ messageId: "middle-2", replyToMessageId: "missing-root" },
		]),
		"middle-2",
		"a partial thread resolves to the oldest row present, not the newest reply",
	);
	assert.equal(threadRootId([{ replyToMessageId: "x" }]), undefined);
});

// ─── V11 — Herdr attention, metadata and context ─────────────────────────────

test("V11: Herdr context is enabled only with HERDR_ENV=1", () => {
	const disabled = readHerdrContext({});
	assert.equal(disabled.enabled, false);
	assert.equal(disabled.paneId, undefined);
	assert.equal(readHerdrContext({ HERDR_ENV: "0", HERDR_PANE_ID: "pane-7" }).enabled, false);
	const enabled = readHerdrContext({
		HERDR_ENV: "1",
		HERDR_PANE_ID: "pane-7",
		HERDR_BIN_PATH: "/opt/herdr/bin/herdr",
	});
	assert.equal(enabled.enabled, true);
	assert.equal(enabled.paneId, "pane-7");
	assert.equal(enabled.binPath, "/opt/herdr/bin/herdr");
});

test("V11: metadata argv uses the documented source, seq and token shape", () => {
	const ctx = { enabled: true, paneId: "pane-7", binPath: "/opt/herdr/bin/herdr" };
	const argv = buildMetadataArgs(ctx, { repo: "sandbox", task: "task-9", files: 3, inboxPending: 2 }, 42);
	assert.equal(argv[0], "/opt/herdr/bin/herdr");
	assert.deepEqual(argv.slice(1, 10), [
		"pane",
		"report-metadata",
		"pane-7",
		"--source",
		"muster",
		"--agent",
		"muster",
		"--seq",
		"42",
	]);
	assert.equal(argv[10], "--title");
	assert.equal(argv[11], "muster");
	const tokens = argv.filter((value, index) => index > 0 && argv[index - 1] === "--token");
	assert.deepEqual(tokens, ["repo=sandbox", "task=task-9", "files=3", "inbox=2"]);

	const sparseTokens = buildMetadataArgs(ctx, {}, 1).filter(
		(value, index, all) => index > 0 && all[index - 1] === "--token",
	);
	assert.deepEqual(sparseTokens, ["repo=-", "task=-", "files=0", "inbox=0"]);

	const multiTokens = buildMetadataArgs(ctx, { repo: "sandbox" }, 1, 2).filter(
		(value, index, all) => index > 0 && all[index - 1] === "--token",
	);
	assert.deepEqual(multiTokens, ["repo=sandbox+2", "task=-", "files=0", "inbox=0"]);
});

test("V11: fire-and-forget reporting never throws into the session", () => {
	const disabled = { enabled: false, paneId: "pane-7" };
	assert.doesNotThrow(() => reportMetadata(disabled, { repo: "sandbox" }));
	assert.doesNotThrow(() => clearMetadata(disabled));

	// A missing binary and a missing pane must both stay silent and non-throwing.
	const unavailable = { enabled: true, paneId: "pane-7", binPath: "/nonexistent/herdr-muster-test" };
	assert.doesNotThrow(() => reportMetadata(unavailable, { repo: "sandbox", files: 1 }));
	assert.doesNotThrow(() => clearMetadata(unavailable));
	assert.doesNotThrow(() => reportMetadata({ enabled: true }, { repo: "sandbox" }));
});

test("V11: breaker attention span is one balanced active:true / active:false pair", () => {
	const calls: Array<{ name: string; data: unknown }> = [];
	const emitter = {
		emit: (name: string, data: unknown) => {
			calls.push({ name, data });
		},
	};
	const span = new BreakerAttentionSpan({ enabled: true, paneId: "pane-7" });
	assert.equal(span.open, false);
	span.ensure("Muster paused: 2 task loop(s) awaiting resume", emitter);
	assert.equal(span.open, true);
	assert.deepEqual(calls, [
		{ name: "herdr:blocked", data: { active: true, label: "Muster paused: 2 task loop(s) awaiting resume" } },
	]);

	span.ensure("Muster paused: 3 task loop(s) awaiting resume", emitter);
	assert.equal(calls.length, 1, "a second ensure must not open another span");

	span.clear(emitter);
	assert.equal(span.open, false);
	assert.deepEqual(calls[1], { name: "herdr:blocked", data: { active: false } });
	span.clear(emitter);
	assert.equal(calls.length, 2, "clear only when the span is open");

	span.ensure("Muster paused: 1 task loop(s) awaiting resume", emitter);
	assert.equal(calls.length, 3);
	assert.deepEqual(calls[2], {
		name: "herdr:blocked",
		data: { active: true, label: "Muster paused: 1 task loop(s) awaiting resume" },
	});
});

test("V11: attention spans stay silent without a Herdr pane", () => {
	const calls: unknown[] = [];
	const emitter = {
		emit: (name: string, data: unknown) => {
			calls.push({ name, data });
		},
	};
	const span = new BreakerAttentionSpan({ enabled: false });
	span.ensure("Muster paused: 1 task loop(s) awaiting resume", emitter);
	span.clear(emitter);
	assert.deepEqual(calls, []);
	assert.equal(span.open, false);
});
