/**
 * PB5: the tick makes its park, abandon, close and remind decisions through
 * `decideLifecycle` behind an async port, and the lane task carries `parked`
 * and `resuming` checkpoints. Rehearsal directories only, never
 * ~/.pi/agent/state/muster.
 *
 * Every test goes through `createTaskPorts` and `registerMusterTasks`. Only the
 * effects that touch a process (`launch`, `stop`, `park`) are replaced by spies;
 * the lifecycle port, the liveness port and the cards are the real ones, fed by
 * fixture cards, fixture tmux panes and fixture git facts.
 */

import "./muster-test-isolation.ts";
process.env.MUSTER_LEDGER_TEST = "1";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import type { JsonObject } from "@earendil-works/pi-durable";
import { createRegistry, defineExtension, Harness as DurableHarness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { resumeCommand, type ResumeDeps } from "../cli/resume.ts";
import type { CliContext } from "../cli/types.ts";
import { LANE_TASK, LaneTask } from "../ledger/lane-task.ts";
import { casRead, eventsSince } from "../ledger/methods.ts";
import type { Ledger } from "../ledger/open.ts";
import { CasFamily, type MusterEventData } from "../ledger/schema.ts";
import { LANE_RECORD_STORE } from "../ledger/stores.ts";
import {
	createTaskPorts,
	musterTaskDefinitions,
	registerMusterTasks,
	type TaskPorts,
	type TaskPortOptions,
} from "../ledger/task-ports.ts";
import { recordingTickPass } from "./tick-pass-fixture.ts";
import { TICK_TASK, TickTask, type TickCheckpoint } from "../ledger/tick-task.ts";
import type { ClaudeJob } from "../lib/claude-lane-card.ts";
import { writeLaneCard, type LaneCard } from "../lib/lane-card.ts";
import { writeLaneRegistryRow, type ClaudeLaneRow } from "../lib/lane-directory.ts";
import { readLaneRecord, type GitFacts, type LaneRecord } from "../lane-lifecycle.ts";
import { orchestratorEventsPath } from "../lane-report.ts";
import { deliverLaneMessage, type SendRequest } from "../send.ts";
import { laneSendDeps } from "../send-deps.ts";
import { harnessRoot, nodeBinary, tsxLoaderPath } from "../../core/harness-paths.ts";

const here = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
const DAEMON = join(HARNESS_ROOT, "muster", "ledger", "daemon.ts");
const NODE = nodeBinary();

const MIN = 60_000;
const SESSION = "7a1b2c3d-1111-4222-8333-444455556666";

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "ledger-reconciler-"));
	try {
		await run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** A linked, clean worktree whose reported commit is on its branch and in no merge ref. */
const okGit: GitFacts = {
	isAncestor: () => false,
	isClean: () => true,
	onBranch: () => true,
	isLinkedWorktree: () => true,
};

type Spies = { parks: string[]; stops: Array<{ laneId: string; phase: string }>; failStop: boolean; failPark?: string[] };

/** `createTaskPorts` + `registerMusterTasks`, as `open.ts` runs them, over a rehearsal ledger. */
async function openReconciler(
	dir: string,
	options: { taskPorts?: TaskPortOptions; spies?: Spies; resume?: boolean } = {},
): Promise<{ ledger: Ledger; spies: Spies; ports: TaskPorts }> {
	const spies: Spies = options.spies ?? { parks: [], stops: [], failStop: false };
	const storage = await openNodeSqliteStorage(join(dir, "ledger.sqlite"));
	const registry = createRegistry();
	registry.install(defineExtension({ name: "muster", tasks: musterTaskDefinitions() }));
	const harness = await DurableHarness.open(storage, { models: createModels(), registry }, ctx);
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
	const ports = createTaskPorts(ledger, {
		git: okGit,
		...options.taskPorts,
		directory: {
			skipClaude: true,
			home: dir,
			laneRegistryPath: join(dir, "pi-lanes.json"),
			poolConfigPath: join(dir, "no-pool.json"),
			evidence: {
				tmuxPanes: () => [],
				pidAlive: () => false,
				hasAgentEnv: () => false,
				piProcesses: () => [],
				hermesUnits: () => [],
				scopeUnits: () => [],
			},
			...options.taskPorts?.directory,
		},
	});
	registerMusterTasks(ledger, {
		...ports,
		lane: {
			...ports.lane,
			launch: async () => ({ sessionId: SESSION }),
			stop: async (lane) => {
				spies.stops.push({ laneId: lane.laneId, phase: lane.phase });
				if (spies.failStop) throw new Error("stop refused");
			},
			park: async (lane) => {
				if (spies.failPark?.includes(lane.laneId)) throw new Error("park refused");
				spies.parks.push(lane.laneId);
			},
		},
	}, { tickPass: recordingTickPass(dir, { replaySpool: () => ports.onPass() }).ports });
	if (options.resume !== false) ledger.harness.resume();
	return { ledger, spies, ports };
}

function record(laneId: string, over: Partial<LaneRecord> = {}): LaneRecord {
	const at = Date.now() - 31 * MIN;
	return {
		laneId,
		harness: "pi",
		cwd: "/work/w",
		branch: null,
		launchedAt: at,
		launchedBy: "test",
		phase: "review_ready",
		phaseSince: at,
		...over,
	};
}

async function seedLane(ledger: Ledger, rec: LaneRecord, reaches = "live"): Promise<void> {
	await ledger.root.commit(async (tx) => {
		const doc = await tx.doc(CasFamily, `${LANE_RECORD_STORE}:${rec.laneId}`, { store: LANE_RECORD_STORE, id: rec.laneId });
		doc.record = rec as unknown as JsonObject;
		doc.revision = 1;
		await tx.createTask(LaneTask, { laneId: rec.laneId }, { ownership: { kind: "conversation" } });
	}, ctx);
	await waitLane(ledger, rec.laneId, reaches);
}

async function createTick(ledger: Ledger, intervalMs = 50): Promise<void> {
	await ledger.root.commit((tx) => tx.createTask(TickTask, { intervalMs }, { ownership: { kind: "conversation" }, background: true }), ctx);
}

async function readRecord(ledger: Ledger, laneId: string): Promise<LaneRecord | undefined> {
	const doc = await casRead(ledger, { store: LANE_RECORD_STORE, id: laneId });
	return (doc?.record ?? undefined) as unknown as LaneRecord | undefined;
}

async function until(what: string, check: () => Promise<boolean> | boolean, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	for (;;) {
		if (await check()) return;
		if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
		await delay(10);
	}
}

async function laneTask(ledger: Ledger, laneId: string): Promise<{ phase?: string; status?: string; outcome?: string } | undefined> {
	const { tasks } = await ledger.harness.inspect(ctx);
	for (const { record: task } of tasks) {
		if (task.kind !== LANE_TASK) continue;
		if ((task.input as { laneId?: string } | null)?.laneId !== laneId) continue;
		const state = task.state as { status?: string; checkpoint?: { phase?: string }; outcome?: { status?: string } };
		return { phase: state.checkpoint?.phase, status: state.status, outcome: state.outcome?.status };
	}
	return undefined;
}

async function waitLane(ledger: Ledger, laneId: string, phase: string): Promise<void> {
	try {
		await until(`lane ${laneId} at ${phase}`, async () => (await laneTask(ledger, laneId))?.phase === phase);
	} catch (error) {
		const state = JSON.stringify(await laneTask(ledger, laneId));
		throw new Error(`${(error as Error).message}; task ${state}, record ${(await readRecord(ledger, laneId))?.phase}`);
	}
}

async function tickPassNo(ledger: Ledger): Promise<number> {
	const { tasks } = await ledger.harness.inspect(ctx);
	const tick = tasks.find(({ record: task }) => task.kind === TICK_TASK);
	return (tick?.record.state as { checkpoint?: TickCheckpoint } | undefined)?.checkpoint?.passNo ?? 0;
}

async function passes(ledger: Ledger, more: number): Promise<void> {
	const target = (await tickPassNo(ledger)) + more;
	await until(`tick pass ${target}`, async () => (await tickPassNo(ledger)) >= target);
}

async function events(ledger: Ledger, type: string, lane?: string): Promise<MusterEventData[]> {
	return (await eventsSince(ledger)).filter((event) => event.type === type && (lane === undefined || event.lane === lane));
}

/** A lane the bus started: a registry row, so the directory does not take it for the operator's own session. */
function enroll(dir: string, laneId: string, harness = "pi"): void {
	writeLaneRegistryRow(join(dir, "muster"), laneId, { sessionId: SESSION, harness });
}

function card(laneId: string, over: Partial<LaneCard> = {}): LaneCard {
	return { laneId, harness: "pi", cwd: "/work/w", branch: null, state: "idle", model: null, thinking: null, since: 1, updatedAt: Date.now(), wall: null, ...over };
}

describe("PB5 reconciler: the tick decides through decideLifecycle", { concurrency: false }, () => {
	test("acceptance 1: a handoff idle for 31 minutes is parked through the port, and the lane task reaches parked", async () => {
		await withDir(async (dir) => {
			const { ledger, spies } = await openReconciler(dir);
			try {
				await seedLane(ledger, record("rh-park"));
				await createTick(ledger);
				await waitLane(ledger, "rh-park", "parked");
				assert.deepEqual(spies.parks, ["rh-park"]);
				const parked = await readRecord(ledger, "rh-park");
				assert.equal(parked?.phase, "parked");
				assert.equal(typeof parked?.parkedAt, "number");
				await passes(ledger, 3);
				assert.deepEqual(spies.parks, ["rh-park"], "a parked lane is parked once");
			} finally {
				await ledger.close();
			}
		});
	});

	test("acceptance 1: a kind:conversation lane is not parked (untouchableSession)", async () => {
		await withDir(async (dir) => {
			const { ledger, spies } = await openReconciler(dir);
			try {
				await seedLane(ledger, record("rh-talk", { kind: "conversation" }));
				await seedLane(ledger, record("rh-work"));
				await createTick(ledger);
				await waitLane(ledger, "rh-work", "parked");
				await passes(ledger, 3);
				assert.deepEqual(spies.parks, ["rh-work"]);
				assert.equal((await readRecord(ledger, "rh-talk"))?.phase, "review_ready");
				assert.equal((await laneTask(ledger, "rh-talk"))?.phase, "live");
			} finally {
				await ledger.close();
			}
		});
	});

	test("a reminder is sent once, with its stamp in the same commit", async () => {
		await withDir(async (dir) => {
			const { ledger } = await openReconciler(dir);
			try {
				await seedLane(ledger, record("rh-remind", { phaseSince: Date.now() - 3 * 60 * MIN, lastReport: { kind: "review_ready", at: Date.now() - 3 * 60 * MIN, summary: "done" } as LaneRecord["lastReport"] }));
				await createTick(ledger);
				await until("STALLED", async () => (await events(ledger, "STALLED", "rh-remind")).length > 0);
				await passes(ledger, 4);
				assert.equal((await events(ledger, "STALLED", "rh-remind")).length, 1);
				assert.equal(typeof (await readRecord(ledger, "rh-remind"))?.reminded?.orchestratorAt, "number");
			} finally {
				await ledger.close();
			}
		});
	});

	test("one lane's failing park does not skip the rest of the pass", async () => {
		await withDir(async (dir) => {
			const spies: Spies = { parks: [], stops: [], failStop: false, failPark: ["rh-aaa-bad"] };
			const { ledger } = await openReconciler(dir, { spies });
			try {
				await seedLane(ledger, record("rh-aaa-bad"));
				await seedLane(ledger, record("rh-zzz-good"));
				await createTick(ledger);
				await waitLane(ledger, "rh-zzz-good", "parked");
				await until("TICK ERROR", async () => (await events(ledger, "TICK ERROR", "rh-aaa-bad")).length > 0);
				assert.equal((await readRecord(ledger, "rh-aaa-bad"))?.phase, "review_ready", "a failed park leaves the record");
			} finally {
				await ledger.close();
			}
		});
	});

	test("acceptance 3 (C1): a 60 s old card whose pane is alive is not abandoned", async () => {
		await withDir(async (dir) => {
			const alive = { current: true };
			// Card age alone read a 60 s old card as gone (3 x 15 s heartbeat). The pane says otherwise.
			const { ledger, spies } = await openReconciler(dir, {
				taskPorts: {
					directory: {
						evidence: {
							tmuxPanes: () => (alive.current ? [{ session: "pi", window: "rh-live", dead: false, pid: 1 }] : []),
							pidAlive: () => false,
							hasAgentEnv: () => false,
							piProcesses: () => [],
							hermesUnits: () => [],
							scopeUnits: () => [],
						},
					},
				},
			});
			try {
				enroll(dir, "rh-live");
				writeLaneCard(dir, card("rh-live", { state: "running", updatedAt: Date.now() - 60_000 }));
				await seedLane(ledger, record("rh-live", { phase: "working" }));
				await createTick(ledger);
				await passes(ledger, 4);
				assert.equal((await readRecord(ledger, "rh-live"))?.phase, "working");
				assert.equal((await events(ledger, "ABANDONED", "rh-live")).length, 0);
				assert.deepEqual(spies.stops, []);
			} finally {
				await ledger.close();
			}
		});
	});

	test("acceptance 3: an abandoned lane's process is stopped before its task ends, and the task never ends without it", async () => {
		await withDir(async (dir) => {
			const { ledger, spies } = await openReconciler(dir);
			try {
				spies.failStop = true;
				enroll(dir, "rh-dead");
				writeLaneCard(dir, card("rh-dead", { state: "running", updatedAt: Date.now() - 31 * MIN }));
				await seedLane(ledger, record("rh-dead", { phase: "working" }));
				await createTick(ledger);
				await until("stop attempted", () => spies.stops.length > 0);
				assert.equal(spies.stops[0]?.phase, "abandoned", "the stop sees the abandoned record");
				await delay(300);
				const state = await laneTask(ledger, "rh-dead");
				assert.notEqual(state?.outcome, "completed", "a failed stop leaves the task unfinished");

				spies.failStop = false;
			} finally {
				await ledger.close();
			}
		});
	});

	test("acceptance 3: a dead lane is closed as abandoned once, with a stop and one ABANDONED event", async () => {
		await withDir(async (dir) => {
			const { ledger, spies } = await openReconciler(dir);
			try {
				enroll(dir, "rh-gone");
				writeLaneCard(dir, card("rh-gone", { state: "running", updatedAt: Date.now() - 31 * MIN }));
				await seedLane(ledger, record("rh-gone", { phase: "working" }));
				await createTick(ledger);
				await until("task ended", async () => {
					const state = await laneTask(ledger, "rh-gone");
					return state === undefined || state.status === "terminal";
				});
				assert.equal(spies.stops.length, 1);
				const after = await readRecord(ledger, "rh-gone");
				assert.equal(after?.phase, "abandoned");
				assert.equal(after?.terminal?.outcome, "abandoned");
				await passes(ledger, 3);
				assert.equal((await events(ledger, "ABANDONED", "rh-gone")).length, 1);
				assert.equal((await events(ledger, "TELL OPERATOR", "rh-gone")).length, 1, "the afterClose line follows the close, once");
			} finally {
				await ledger.close();
			}
		});
	});

	test("K2: a record that is already terminal is never written by the tick", async () => {
		await withDir(async (dir) => {
			const { ledger, spies } = await openReconciler(dir);
			try {
				enroll(dir, "rh-done");
				writeLaneCard(dir, card("rh-done", { state: "running", updatedAt: Date.now() - 60_000 }));
				await seedLane(ledger, record("rh-done", { phase: "working" }));
				// The record turns closed, then the tick runs: nothing may overwrite it.
				await ledger.root.commit(async (tx) => {
					const doc = await tx.doc(CasFamily, `${LANE_RECORD_STORE}:rh-done`, { store: LANE_RECORD_STORE, id: "rh-done" });
					doc.record = { ...(doc.record as object), phase: "merged" } as unknown as JsonObject;
					doc.revision += 1;
				}, ctx);
				await createTick(ledger);
				await passes(ledger, 3);
				assert.equal((await readRecord(ledger, "rh-done"))?.phase, "merged");
				assert.equal((await events(ledger, "ABANDONED", "rh-done")).length, 0);
				assert.ok(spies.parks.length === 0);
			} finally {
				await ledger.close();
			}
		});
	});
});

describe("PB5 alive() stays off musterd's event loop (P2)", { concurrency: false }, () => {
	const countingEvidence = (count: { reads: number }) => ({
		tmuxPanes: () => {
			count.reads += 1;
			return [];
		},
		pidAlive: () => false,
		hasAgentEnv: () => false,
		piProcesses: () => [],
		hermesUnits: () => [],
		scopeUnits: () => [],
	});

	test("many alive() calls inside the maximum age read the machine once; a decision and an expired age read it again", async () => {
		await withDir(async (dir) => {
			const count = { reads: 0 };
			const { ledger, ports } = await openReconciler(dir, { resume: false, taskPorts: { rowsMaxAgeMs: 60, directory: { evidence: countingEvidence(count) } } });
			try {
				const lane = record("rh-poll", { phase: "working" });
				for (let call = 0; call < 20; call++) await ports.lane.alive(lane);
				assert.equal(count.reads, 1, "20 calls, one read of tmux, systemctl and claude agents");
				await ports.lifecycle.decide(new Map(), Date.now());
				assert.equal(count.reads, 2, "a decision always reads fresh rows");
				await delay(90);
				await ports.lane.alive(lane);
				assert.equal(count.reads, 3, "rows older than the maximum age are read again");
			} finally {
				await ledger.close();
			}
		});
	});

	test("three resuming lanes polling for their process do not read the machine once each", async () => {
		await withDir(async (dir) => {
			const count = { reads: 0 };
			const { ledger } = await openReconciler(dir, { taskPorts: { directory: { evidence: countingEvidence(count) } } });
			try {
				const lanes = ["rh-r1", "rh-r2", "rh-r3"];
				for (const id of lanes) await seedLane(ledger, record(id, { harness: "claude", phase: "parked", parkedAt: Date.now() }), "parked");
				for (const id of lanes) {
					await ledger.root.commit(async (tx) => {
						const doc = await tx.doc(CasFamily, `${LANE_RECORD_STORE}:${id}`, { store: LANE_RECORD_STORE, id });
						doc.record = { ...(doc.record as object), phase: "working" } as unknown as JsonObject;
						doc.revision += 1;
					}, ctx);
				}
				for (const id of lanes) await waitLane(ledger, id, "resuming");
				await delay(300);
				assert.ok(count.reads <= 1, `3 resuming lanes read the machine ${count.reads} times`);
			} finally {
				await ledger.close();
			}
		});
	});
});

// ─── The wake contract (A13): a send never resumes, only `muster resume` does ──

const asleepRow: ClaudeLaneRow = { id: "7a1b2c3d", sessionId: SESSION, cwd: "/work/w", name: "rh-wake", kind: "background", state: "done", startedAt: 3_000 } as unknown as ClaudeLaneRow;
const liveRow: ClaudeLaneRow = { ...asleepRow, pid: 4300, state: "working" } as ClaudeLaneRow;
const job: ClaudeJob = { sessionId: SESSION, name: "rh-wake", template: "bg", cwd: "/work/w", respawnFlags: ["--name", "rh-wake", "--model", "haiku"] } as unknown as ClaudeJob;

function loaderArgs(): string[] {
	const args: string[] = [];
	for (let at = 0; at < process.execArgv.length; at++) {
		if (process.execArgv[at] === "--import" && process.execArgv[at + 1] !== undefined) args.push("--import", process.execArgv[at + 1] as string);
	}
	return args.length > 0 ? args : ["--import", tsxLoaderPath()];
}

function startDaemonChild(dir: string): { child: ChildProcess; ready: Promise<void> } {
	const file = join(dir, "fixture-daemon.mjs");
	writeFileSync(file, [`import { startDaemon } from ${JSON.stringify(DAEMON)};`, "await startDaemon(process.env.MUSTER_FIXTURE_DIR);", 'process.stdout.write("READY\\n");'].join("\n"));
	const env = { ...process.env, MUSTER_FIXTURE_DIR: dir };
	delete env.MUSTER_LEDGER_CRASH_AT;
	delete env.MUSTER_LEDGER_TASKS;
	const child = spawn(NODE, [...loaderArgs(), file], { stdio: ["ignore", "pipe", "pipe"], env });
	let output = "";
	const collect = (chunk: Buffer): void => void (output += chunk.toString());
	child.stdout?.on("data", collect);
	child.stderr?.on("data", collect);
	const ready = (async () => {
		const deadline = Date.now() + 15_000;
		while (!output.includes("READY")) {
			if (child.exitCode !== null || child.signalCode !== null) throw new Error(`the daemon fixture exited before READY: ${output}`);
			if (Date.now() > deadline) throw new Error(`the daemon fixture did not answer within 15 s: ${output}`);
			await delay(25);
		}
	})();
	return { child, ready };
}

async function stopDaemonChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise<void>((done) => child.once("exit", () => done()));
	child.kill("SIGKILL");
	await exited;
}

function cliCtx(dir: string, argv: string[]): { ctx: CliContext; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	const env = { ...process.env, PI_MUSTER_STATE_DIR: dir, MUSTER_LEDGER_DIR: dir };
	delete env.MUSTERD;
	return { out, err, ctx: { argv, HARNESS_ROOT: dir, agentId: "orchestrator", json: false, cwd: dir, env, io: { out: (l) => out.push(l), err: (l) => err.push(l) }, readStdin: async () => "" } };
}

describe("PB5 wake contract (A13)", { concurrency: false }, () => {
	test("acceptance 2: a send leaves a parked Claude lane parked and raises ASLEEP once; only muster resume moves it to resuming, then live, and records the launch again", async () => {
		await withDir(async (dir) => {
			// 1. A parked Claude lane in the ledger, the way the tick leaves it (the park itself is the first test).
			const parkedAt = Date.now() - 5 * MIN;
			const parked = record("rh-wake", { harness: "claude", sessionId: SESSION, phase: "parked", phaseSince: parkedAt, parkedAt });
			const seeded = await openReconciler(dir);
			try {
				await seeded.ledger.root.commit(async (tx) => {
					const doc = await tx.doc(CasFamily, `${LANE_RECORD_STORE}:rh-wake`, { store: LANE_RECORD_STORE, id: "rh-wake" });
					doc.record = parked as unknown as JsonObject;
					doc.revision = 1;
				}, ctx);
			} finally {
				await seeded.ledger.close();
			}

			// 2. Two sends and one resume through the real owners, over the ledger backend (a daemon child on the same directory).
			writeFileSync(join(dir, "backend.json"), JSON.stringify({ backend: "ledger", flipId: "pb5-test", at: "2026-10-23T00:00:00+03:00", cursor: "1" }));
			const daemon = startDaemonChild(dir);
			let woken: LaneRecord | undefined;
			let fileAsleep = 0;
			try {
				await daemon.ready;
				writeLaneCard(dir, { laneId: "rh-wake", harness: "claude", cwd: "/work/w", branch: "main", state: "idle", model: null, thinking: null, since: 1, updatedAt: 1, wall: null, sessionId: SESSION });
				const send = (): ReturnType<typeof deliverLaneMessage> => {
					const request: SendRequest = { laneId: "rh-wake", mode: "followup", text: "please rebase" };
					return deliverLaneMessage(
						request,
						laneSendDeps(dir, "henry", {
							readRows: () => [{ ...asleepRow, pid: null } as unknown as ClaudeLaneRow],
							readJob: () => job,
							pidAlive: () => false,
							waiterAlive: () => false,
							sessionRows: () => ({}),
							holdsSeat: () => false,
							pane: async () => ({ ok: false, command: "none" }),
							confirmArrival: false,
							now: () => new Date(),
						}),
					);
				};
				await send();
				await send();
				assert.equal(readLaneRecord(dir, "rh-wake")?.phase, "parked", "a send never moves parked");
				fileAsleep = existsSync(orchestratorEventsPath(dir)) ? readFileSync(orchestratorEventsPath(dir), "utf8").split("\n").filter((line) => line.includes("ASLEEP: rh-wake")).length : 0;

				// muster resume --message wakes it and records the launch again (cli/resume.ts:82).
				let t = 1_000_000;
				const listings: ClaudeLaneRow[][] = [[]];
				const resumeDeps: ResumeDeps = {
					sessionRows: () => ({}),
					claude: {
						readRows: () => listings.shift() ?? [liveRow],
						runCli: () => ({ status: 0, stdout: "backgrounded · 7a1b2c3d · rh-wake\n", stderr: "" }),
						readJob: () => job,
						pidAlive: (pid) => pid === 4300,
						now: () => t,
						sleep: (ms) => {
							t += ms;
						},
					},
				};
				const resumed = cliCtx(dir, ["rh-wake", "--message", "go"]);
				assert.equal(await resumeCommand(resumed.ctx, resumeDeps), 0, resumed.err.join("\n"));
				woken = readLaneRecord(dir, "rh-wake");
				assert.equal(woken?.phase, "working");
				assert.equal(woken?.parkedAt, undefined);
				assert.deepEqual(woken?.reminded, {});
			} finally {
				await stopDaemonChild(daemon.child);
			}
			assert.ok(woken !== undefined);
			// In ledger mode the event is a ledger entry, so it is counted there.
			const reopened = await openReconciler(dir, { resume: false });
			try {
				const ledgerAsleep = (await events(reopened.ledger, "ASLEEP", "rh-wake")).length;
				assert.equal(fileAsleep + ledgerAsleep, 1, "two sends raised ASLEEP once");
			} finally {
				await reopened.ledger.close();
			}

			// 3. The lane task of a parked lane: it stays parked until the record leaves parked, goes resuming, and goes live once its process is up.
			await withDir(async (other) => {
				const up = { current: false };
				const { ledger, spies } = await openReconciler(other, {
					taskPorts: {
						rowsMaxAgeMs: 20,
						directory: {
							skipClaude: false,
							claudeAgentsOverride: { stdout: JSON.stringify([liveRow]) },
							evidence: { tmuxPanes: () => [], pidAlive: (pid) => up.current && pid === 4300, hasAgentEnv: () => false, piProcesses: () => [], hermesUnits: () => [], scopeUnits: () => [] },
						},
					},
				});
				try {
					// A lane task whose record is already parked passes through live and rests at parked.
					await seedLane(ledger, parked, "parked");
					await createTick(ledger);
					await passes(ledger, 3);
					assert.equal((await laneTask(ledger, "rh-wake"))?.phase, "parked", "neither a send nor a tick pass resumes a parked lane");
					assert.deepEqual(spies.parks, [], "a parked lane is not parked again");
					await ledger.root.commit(async (tx) => {
						const doc = await tx.doc(CasFamily, `${LANE_RECORD_STORE}:rh-wake`, { store: LANE_RECORD_STORE, id: "rh-wake" });
						doc.record = woken as unknown as JsonObject;
						doc.revision += 1;
					}, ctx);
					await waitLane(ledger, "rh-wake", "resuming");
					await delay(150);
					assert.equal((await laneTask(ledger, "rh-wake"))?.phase, "resuming", "not live while its process is not up");
					up.current = true;
					await waitLane(ledger, "rh-wake", "live");
				} finally {
					await ledger.close();
				}
			});
		});
	});
});
