/**
 * PB3: exactly one live `muster.tick`, a restart that sleeps until stored
 * `dueAt`, per-lane errors that do not abort the pass, and spool replay
 * through `onPass`. Rehearsal directories only — never ~/.pi/agent/state/muster.
 */

import "./muster-test-isolation.ts";
process.env.MUSTER_LEDGER_TEST = "1";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import type { JsonObject } from "@earendil-works/pi-durable";
import { createRegistry, defineExtension, defineTask, Harness as DurableHarness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { startDaemon } from "../ledger/daemon.ts";
import {
	bindLaneTaskPorts,
	LANE_TASK,
	LaneTask,
	type LaneCheckpoint,
	type LaneInput,
	type LanePorts,
	type LaneResult,
} from "../ledger/lane-task.ts";
import { casRead, eventsSince } from "../ledger/methods.ts";
import { MUSTER_LEDGER_TASKS, openLedger, type Ledger, type OpenLedgerOptions } from "../ledger/open.ts";
import { CasFamily, type MusterEventData } from "../ledger/schema.ts";
import { readSpool, spoolWrite } from "../ledger/spool.ts";
import { LANE_RECORD_STORE } from "../ledger/stores.ts";
import { createTaskPorts, type TaskPorts } from "../ledger/task-ports.ts";
import {
	bindTickTaskPorts,
	TICK_TASK,
	TickTask,
	type TickCheckpoint,
} from "../ledger/tick-task.ts";
import type { LaneRecord, LifecycleAction } from "../lane-lifecycle.ts";
import { recordingTickPass } from "./tick-pass-fixture.ts";

const tempDir = () => mkdtempSync(join(tmpdir(), "ledger-tick-"));

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = tempDir();
	try {
		await run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function fakeLaunch(): LanePorts["launch"] {
	return async () => ({ sessionId: "s1" });
}

/**
 * A `muster.lane` definition that holds the task at `live` and never settles
 * it, so a test can put a lane record in any phase while the tick still sees
 * a live lane task (the window between `muster close` and the lane's watch).
 */
const HeldLaneTask = defineTask<LaneInput, LaneCheckpoint, LaneResult>({
	name: LANE_TASK,
	version: 1,
	initial: () => ({ phase: "live" }),
	phases: {
		live: async (_task, runtime, context) => {
			await runtime.sleep(Number.MAX_SAFE_INTEGER, context);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

/**
 * Open a rehearsal ledger with `TickTask` registered. Tests create the tick
 * themselves; ensureTick (PB4) is the only production creator.
 */
async function openTickLedger(
	dir: string,
	options: {
		now?: () => number;
		withLaneTask?: boolean;
		heldLaneTask?: boolean;
		wrapLane?: Partial<LanePorts>;
		decide?: (records: ReadonlyMap<string, LaneRecord>) => Promise<LifecycleAction[]>;
	} = {},
): Promise<{ ledger: Ledger; ports: TaskPorts }> {
	const storage = await openNodeSqliteStorage(join(dir, "ledger.sqlite"));
	const registry = createRegistry();
	registry.install(
		defineExtension({
			name: "muster",
			tasks:
				options.heldLaneTask === true
					? [TickTask, HeldLaneTask]
					: options.withLaneTask === true
						? [TickTask, LaneTask]
						: [TickTask],
		}),
	);
	const harness = await DurableHarness.open(
		storage,
		{
			models: createModels(),
			registry,
			...(options.now === undefined ? {} : { now: options.now }),
		},
		ctx,
	);
	const root = await harness.root(ctx);
	const ledger: Ledger = {
		harness,
		root,
		storage,
		dir,
		async close(): Promise<void> {
			await harness.close(ctx);
		},
	};
	const ports = createTaskPorts(ledger);
	const lane: LanePorts = {
		launch: options.wrapLane?.launch ?? fakeLaunch(),
		stop: options.wrapLane?.stop ?? (async () => {}),
		park: options.wrapLane?.park ?? (async () => {}),
		alive: options.wrapLane?.alive ?? (async () => true),
	};
	// PB5: the pass decides through the lifecycle port; these tests hand it the actions to apply.
	const lifecycle = { decide: async (records: ReadonlyMap<string, LaneRecord>) => (options.decide === undefined ? [] : options.decide(records)) };
	bindTickTaskPorts({ ports: { ...ports, lane, lifecycle }, harness, passPorts: recordingTickPass(dir, { replaySpool: () => ports.onPass() }).ports });
	if (options.withLaneTask === true) bindLaneTaskPorts(lane);
	harness.resume();
	return { ledger, ports };
}

async function createTick(ledger: Ledger, intervalMs: number): Promise<void> {
	await ledger.root.commit(
		(tx) =>
			tx.createTask(TickTask, { intervalMs }, { ownership: { kind: "conversation" }, background: true }),
		ctx,
	);
}

/** The production path: `openLedger` with `MUSTER_LEDGER_TASKS=1` set only while it opens. */
async function openProdLedger(dir: string, options: OpenLedgerOptions = {}): Promise<Ledger> {
	const saved = process.env[MUSTER_LEDGER_TASKS];
	process.env[MUSTER_LEDGER_TASKS] = "1";
	try {
		return await openLedger(dir, { ...options, tickPass: recordingTickPass(dir).ports });
	} finally {
		if (saved === undefined) delete process.env[MUSTER_LEDGER_TASKS];
		else process.env[MUSTER_LEDGER_TASKS] = saved;
	}
}

function seedRecord(laneId: string, cwd: string, at: number): LaneRecord {
	return {
		laneId,
		harness: "pi",
		cwd,
		branch: null,
		launchedAt: at,
		launchedBy: "test",
		phase: "working",
		phaseSince: at,
	};
}

async function seedAndLaunch(
	ledger: Ledger,
	laneId: string,
	options: { phase?: LaneRecord["phase"]; held?: boolean } = {},
): Promise<void> {
	const at = Date.now();
	await ledger.root.commit(async (tx) => {
		const doc = await tx.doc(CasFamily, `${LANE_RECORD_STORE}:${laneId}`, { store: LANE_RECORD_STORE, id: laneId });
		doc.record = {
			...seedRecord(laneId, ledger.dir, at),
			...(options.phase === undefined ? {} : { phase: options.phase }),
		} as unknown as JsonObject;
		doc.revision = 1;
		await tx.createTask(options.held === true ? HeldLaneTask : LaneTask, { laneId }, { ownership: { kind: "conversation" } });
	}, ctx);
}

async function lanePhase(ledger: Ledger, laneId: string): Promise<string | undefined> {
	const doc = await casRead(ledger, { store: LANE_RECORD_STORE, id: laneId });
	return (doc?.record as { phase?: string } | null | undefined)?.phase;
}

async function tickStatus(ledger: Ledger): Promise<string> {
	const { tasks } = await ledger.harness.inspect(ctx);
	const tick = tasks.find(({ record }) => record.kind === TICK_TASK);
	if (tick === undefined) throw new Error("no tick task");
	return (tick.record.state as { status: string }).status;
}

async function tickPassNo(ledger: Ledger): Promise<number> {
	const { tasks } = await ledger.harness.inspect(ctx);
	const tick = tasks.find(({ record }) => record.kind === TICK_TASK);
	if (tick === undefined) throw new Error("no live tick");
	const state = tick.record.state as { checkpoint?: TickCheckpoint };
	if (state.checkpoint === undefined) throw new Error("the live tick has no checkpoint");
	return state.checkpoint.passNo;
}

async function liveTickCount(ledger: Ledger): Promise<number> {
	const { tasks } = await ledger.harness.inspect(ctx);
	return tasks.filter(({ record }) => record.kind === TICK_TASK).length;
}

async function waitTickPasses(ledger: Ledger, n: number, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	for (;;) {
		if ((await tickPassNo(ledger)) >= n) return;
		if (Date.now() > deadline) throw new Error(`the tick did not reach pass ${n}`);
		await delay(10);
	}
}

async function waitLane(ledger: Ledger, laneId: string, phase: string, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	for (;;) {
		const { tasks } = await ledger.harness.inspect(ctx);
		const found = tasks.find(({ record }) => {
			if (record.kind !== LANE_TASK) return false;
			const input = record.input as { laneId?: string } | null;
			const state = record.state as { checkpoint?: { phase?: string } };
			return input?.laneId === laneId && state.checkpoint?.phase === phase;
		});
		if (found !== undefined) return;
		if (Date.now() > deadline) throw new Error(`lane ${laneId} did not reach ${phase}`);
		await delay(10);
	}
}

async function waitEvent(
	ledger: Ledger,
	type: string,
	ms = 5000,
	matches?: (event: MusterEventData) => boolean,
): Promise<MusterEventData> {
	const deadline = Date.now() + ms;
	for (;;) {
		const found = (await eventsSince(ledger)).find(
			(event) => event.type === type && (matches === undefined || matches(event)),
		);
		if (found !== undefined) return found;
		if (Date.now() > deadline) throw new Error(`event ${type} did not arrive`);
		await delay(10);
	}
}

describe("muster.tick PB3", { concurrency: false }, () => {
	test("a restart does not run a pass before the stored due time", async () => {
		await withDir(async (dir) => {
			let clock = 1_000_000;
			const first = await openTickLedger(dir, { now: () => clock });
			try {
				await createTick(first.ledger, 60_000);
				await waitTickPasses(first.ledger, 1);
			} finally {
				await first.ledger.close();
			}
			clock += 10_000; // restarted 10 s later, 50 s before the next due time
			const second = await openTickLedger(dir, { now: () => clock });
			try {
				await delay(200);
				assert.equal(await tickPassNo(second.ledger), 1);
			} finally {
				await second.ledger.close();
			}
		});
	});

	test("one rh- lane's failing action does not skip the rest of the pass", async () => {
		await withDir(async (dir) => {
			const { ledger } = await openTickLedger(dir, {
				withLaneTask: true,
				wrapLane: {
					park: async (lane) => {
						if (lane.laneId === "rh-bad") throw new Error("probe");
					},
				},
				decide: async (records) =>
					[...records.keys()].map(
						(laneId): LifecycleAction =>
							laneId === "rh-bad"
								? { kind: "park", lane: laneId, why: "idle-30m" }
								: { kind: "close", lane: laneId, outcome: "abandoned", reason: "died", sha: null },
					),
			});
			try {
				await seedAndLaunch(ledger, "rh-bad");
				await seedAndLaunch(ledger, "rh-good");
				await waitLane(ledger, "rh-bad", "live");
				await waitLane(ledger, "rh-good", "live");
				await createTick(ledger, 50);
				await waitEvent(ledger, "TICK ERROR", 5000, (event) => event.lane === "rh-bad");
				await waitEvent(ledger, "ABANDONED", 5000, (event) => event.lane === "rh-good");
			} finally {
				await ledger.close();
			}
		});
	});

	test("a spool item filed while the ledger is down is replayed on the next pass", async () => {
		await withDir(async (dir) => {
			const first = await openTickLedger(dir);
			try {
				await createTick(first.ledger, 50);
				await waitTickPasses(first.ledger, 1);
			} finally {
				await first.ledger.close();
			}
			const spoolPath = spoolWrite(dir, {
				method: "appendEvent",
				params: { requestId: "pb3-spool-1", type: "WORKING", text: "filed-while-down" },
			});
			assert.equal(existsSync(spoolPath), true);
			const second = await openTickLedger(dir);
			try {
				const event = await waitEvent(
					second.ledger,
					"WORKING",
					5000,
					(row) => row.text === "filed-while-down" && row.requestId === "pb3-spool-1",
				);
				assert.equal(event.text, "filed-while-down");
				assert.equal(existsSync(spoolPath), false);
				assert.equal(readSpool(dir).length, 0);
			} finally {
				await second.ledger.close();
			}
		});
	});

	test("R4: a restart whose clock is already past dueAt runs the pass at once", async () => {
		await withDir(async (dir) => {
			let clock = 1_000_000;
			const first = await openTickLedger(dir, { now: () => clock });
			try {
				await createTick(first.ledger, 60_000);
				await waitTickPasses(first.ledger, 1);
			} finally {
				await first.ledger.close();
			}
			clock += 120_000; // restarted 2 min later, past the stored dueAt
			const second = await openTickLedger(dir, { now: () => clock });
			try {
				await waitTickPasses(second.ledger, 2, 2000);
			} finally {
				await second.ledger.close();
			}
		});
	});

	test("R1: a dead lane whose record is already merged stays merged and gets no ABANDONED event", async () => {
		await withDir(async (dir) => {
			const close = (laneId: string): LifecycleAction => ({ kind: "close", lane: laneId, outcome: "abandoned", reason: "died", sha: null });
			// The port names the merged lane too: a terminal record is final, so the pass must not act on it.
			const { ledger } = await openTickLedger(dir, { heldLaneTask: true, decide: async () => [close("rh-merged"), close("rh-dead")] });
			try {
				await seedAndLaunch(ledger, "rh-merged", { phase: "merged", held: true });
				await seedAndLaunch(ledger, "rh-dead", { held: true });
				await waitLane(ledger, "rh-merged", "live");
				await waitLane(ledger, "rh-dead", "live");
				await createTick(ledger, 50);
				await waitEvent(ledger, "ABANDONED", 5000, (event) => event.lane === "rh-dead");
				await waitTickPasses(ledger, 2, 5000);
				assert.equal(await lanePhase(ledger, "rh-merged"), "merged");
				assert.equal(await lanePhase(ledger, "rh-dead"), "abandoned");
				const abandoned = (await eventsSince(ledger)).filter(
					(event) => event.type === "ABANDONED" && event.lane === "rh-merged",
				);
				assert.equal(abandoned.length, 0);
			} finally {
				await ledger.close();
			}
		});
	});

	test("R1: a record that turns terminal after the decision is not overwritten", async () => {
		await withDir(async (dir) => {
			let ledgerRef: Ledger | undefined;
			const { ledger } = await openTickLedger(dir, {
				heldLaneTask: true,
				decide: async (records) => {
					if (ledgerRef === undefined || !records.has("rh-race")) return [];
					// `muster close` lands between the decision and the action.
					await ledgerRef.root.commit(async (tx) => {
						const doc = await tx.doc(CasFamily, `${LANE_RECORD_STORE}:rh-race`, { store: LANE_RECORD_STORE, id: "rh-race" });
						doc.record = { ...(doc.record as object), phase: "closed" } as unknown as JsonObject;
						doc.revision += 1;
					}, ctx);
					return [{ kind: "close", lane: "rh-race", outcome: "abandoned", reason: "died", sha: null }];
				},
			});
			ledgerRef = ledger;
			try {
				await seedAndLaunch(ledger, "rh-race", { held: true });
				await waitLane(ledger, "rh-race", "live");
				await createTick(ledger, 50);
				await waitTickPasses(ledger, 2, 5000);
				assert.equal(await lanePhase(ledger, "rh-race"), "closed");
				const abandoned = (await eventsSince(ledger)).filter(
					(event) => event.type === "ABANDONED" && event.lane === "rh-race",
				);
				assert.equal(abandoned.length, 0);
			} finally {
				await ledger.close();
			}
		});
	});

	test("R2/R3: the production openLedger registers both tasks and binds their ports before resume", async () => {
		await withDir(async (dir) => {
			let clock = 1_000_000;
			const first = await openProdLedger(dir, { now: () => clock });
			try {
				await createTick(first, 60_000);
				await waitTickPasses(first, 1);
			} finally {
				await first.close();
			}
			spoolWrite(dir, {
				method: "appendEvent",
				params: { requestId: "pb3-prod-spool", type: "WORKING", text: "filed-while-down" },
			});
			clock += 120_000; // past dueAt: the resumed pass reaches the ports at once
			const second = await openProdLedger(dir, { now: () => clock });
			try {
				await waitEvent(second, "WORKING", 5000, (row) => row.requestId === "pb3-prod-spool");
				await waitTickPasses(second, 2, 5000);
				assert.equal(await tickStatus(second), "running");
				assert.equal(
					(await eventsSince(second)).filter((event) => event.type === "TICK ERROR").length,
					0,
				);
				assert.equal(readSpool(dir).length, 0);
			} finally {
				await second.close();
			}
		});
	});

	test("R5: a failure between appendEvent and removeSpoolFile yields exactly one event after the next pass", async () => {
		if (process.getuid?.() === 0) return; // root ignores the directory mode this test uses
		await withDir(async (dir) => {
			const spoolPath = spoolWrite(dir, {
				method: "appendEvent",
				params: { requestId: "pb3-r5", type: "WORKING", text: "once" },
			});
			const spoolFolder = join(dir, "spool");
			chmodSync(spoolFolder, 0o555); // the event is appended, then the file cannot be removed
			const { ledger } = await openTickLedger(dir);
			try {
				await createTick(ledger, 50);
				await waitEvent(ledger, "TICK ERROR", 5000);
				assert.equal(existsSync(spoolPath), true);
				chmodSync(spoolFolder, 0o755);
				const deadline = Date.now() + 5000;
				while (existsSync(spoolPath) && Date.now() < deadline) await delay(10);
				assert.equal(existsSync(spoolPath), false);
				const events = (await eventsSince(ledger)).filter((event) => event.requestId === "pb3-r5");
				assert.equal(events.length, 1);
			} finally {
				chmodSync(spoolFolder, 0o755);
				await ledger.close();
			}
		});
	});

	test("ensureTick is the only creator: a pass does not add a second tick, and the daemon starts exactly one", async () => {
		await withDir(async (dir) => {
			const { ledger } = await openTickLedger(dir);
			try {
				await createTick(ledger, 50);
				await waitTickPasses(ledger, 2, 5000);
				assert.equal(await liveTickCount(ledger), 1);
			} finally {
				await ledger.close();
			}
		});
		await withDir(async (dir) => {
			const savedTasks = process.env[MUSTER_LEDGER_TASKS];
			const savedMusterd = process.env["MUSTERD"];
			process.env[MUSTER_LEDGER_TASKS] = "1";
			const daemon = await startDaemon(dir, { tickPass: recordingTickPass(dir).ports });
			try {
				await daemon.stop();
			} finally {
				if (savedTasks === undefined) delete process.env[MUSTER_LEDGER_TASKS];
				else process.env[MUSTER_LEDGER_TASKS] = savedTasks;
				if (savedMusterd === undefined) delete process.env["MUSTERD"];
				else process.env["MUSTERD"] = savedMusterd;
			}
			const ledger = await openProdLedger(dir);
			try {
				// PB4: the daemon's `ensureTick` made the one tick, and it runs on the registered ports.
				assert.equal(await liveTickCount(ledger), 1);
				await waitTickPasses(ledger, 1, 5000);
			} finally {
				await ledger.close();
			}
		});
	});
});
