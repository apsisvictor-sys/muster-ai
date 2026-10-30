/**
 * OL4 (spec Revision 3 §10 row OL4; VR24-220, VR24-229 items 1 and 8): the durable task runs the
 * timer's whole `main()` sequence, not `runTick` alone, and the two owners cannot run it twice.
 *
 * One fixture per acceptance line:
 *   1. the whole sequence runs in `main()`'s order, each step named;
 *   2. one failing step is reported and the pass continues, and does not fault the durable task;
 *   3. the loser of `state/muster/tick.lock` logs exactly `skipped: lock held` and runs no step;
 *   4. `passNo` advances under the durable task with no timer process at all;
 *   5. a ready work item is dispatched by the durable pass, with no timer;
 *   6. the rollback in fixture terms: tasks off creates no tick, and the pass still runs.
 *
 * Every state directory is a `mkdtemp`; no unit, timer, browser or live path is touched. The live
 * bindings are never bound here: `recordingTickPass` is the pass, so no step can read the machine.
 */

import "./muster-test-isolation.ts";
process.env.MUSTER_LEDGER_TEST = "1";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT as BACKGROUND } from "@earendil-works/chord/context";

import type { DispatchItem, DispatchPort, GateReading, LaunchRequest } from "../dispatch.ts";
import { MUSTER_LEDGER_TASKS, ensureTick, openLedger, type Ledger } from "../ledger/open.ts";
import { TICK_TASK, type TickCheckpoint } from "../ledger/tick-task.ts";
import { runTick, runTickPass, TICK_LOCK_HELD, type TickPassPorts, type TickPorts } from "../tick.ts";
import { liveTickPassPorts } from "../bin/muster-tick.mts";
import { recordingTickPass, type RecordedPass } from "./tick-pass-fixture.ts";

const PASS_STEPS = [
	"heartbeat",
	"spool replay",
	"quota fallback",
	"graph refresh pass",
	"gateway freshness pass",
	"ask push",
	"standing-rule pass",
	"Henry wake health pass",
	"tick pass",
];

/** In the durable task the binder owns the spool replay (`onPass`), so that step records there and not here. */
const DURABLE_STEPS = PASS_STEPS.filter((step) => step !== "spool replay");

const tempDir = () => mkdtempSync(join(tmpdir(), "tick-pass-"));

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = tempDir();
	try {
		await run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Run one pass over `dir` with the recording ports, and hand back what it recorded. */
async function onePass(dir: string, overrides: Partial<TickPassPorts> = {}): Promise<RecordedPass> {
	const recorded = recordingTickPass(dir, overrides);
	await runTickPass(recorded.ports);
	return recorded;
}

/** Open a ledger the way production does, with the recording pass instead of the live one. */
async function openDurable(dir: string, recorded: RecordedPass, intervalMs: number): Promise<Ledger> {
	const saved = process.env[MUSTER_LEDGER_TASKS];
	process.env[MUSTER_LEDGER_TASKS] = "1";
	try {
		const ledger = await openLedger(dir, { tickPass: recorded.ports });
		await ensureTick(ledger, intervalMs);
		return ledger;
	} finally {
		if (saved === undefined) delete process.env[MUSTER_LEDGER_TASKS];
		else process.env[MUSTER_LEDGER_TASKS] = saved;
	}
}

async function tickState(ledger: Ledger): Promise<{ status: string; passNo: number }> {
	const { tasks } = await ledger.harness.inspect(BACKGROUND);
	const tick = tasks.find(({ record }) => record.kind === TICK_TASK);
	if (tick === undefined) throw new Error("no tick task");
	const state = tick.record.state as { status: string; checkpoint?: TickCheckpoint };
	if (state.checkpoint === undefined) throw new Error("the tick has no checkpoint");
	return { status: state.status, passNo: state.checkpoint.passNo };
}

async function waitPassNo(ledger: Ledger, n: number, ms = 5000): Promise<number> {
	const deadline = Date.now() + ms;
	for (;;) {
		const state = await tickState(ledger);
		if (state.passNo >= n) return state.passNo;
		if (Date.now() > deadline) throw new Error(`the tick did not reach pass ${n}`);
		await delay(10);
	}
}

/** A `flock` holder that takes `file` and keeps it for a few seconds, independent of the pass's own holder. */
async function holdLock(file: string, seconds = 5): Promise<ChildProcess> {
	const holder = spawn("flock", [file, "sh", "-c", `echo ready; sleep ${seconds}`], { stdio: ["ignore", "pipe", "ignore"] });
	holder.stdout?.setEncoding("utf8");
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("the lock holder did not start")), 3000);
		holder.stdout?.on("data", (chunk: string) => {
			if (!chunk.includes("ready")) return;
			clearTimeout(timer);
			resolve();
		});
	});
	return holder;
}

function readyItem(brief: string): DispatchItem {
	return {
		code: "OL4X",
		heading: "a ready item launches under the durable pass",
		goal: "out-loop",
		project: "pi",
		kind: "build",
		class: "H3",
		harness: "pi",
		brief,
		ownedPaths: ["muster/tick.ts"],
		dependencies: [],
		attempt: 1,
		state: "ready",
	};
}

/** A dispatch port with one ready item and a launch spy: no gate process, no Herdr, no worktree. */
function dispatchPort(dir: string, brief: string, launches: LaunchRequest[]): DispatchPort {
	const gate: GateReading = { admitted: true, reason: "" };
	const items = [readyItem(brief)];
	const marks = new Map<string, string>();
	return {
		now: () => Date.now(),
		stateDir: () => dir,
		mode: () => "on",
		items: () => ({ items, skipped: [] }),
		liveLanes: () => [],
		freeSlots: () => 3,
		killed: () => undefined,
		gate: async () => gate,
		brief: () => ({ ok: true, text: readFileSync(brief, "utf8") }),
		launch: async (request) => {
			launches.push(request);
			return { launched: true };
		},
		setState: (code, state) => {
			const item = items.find((row) => row.code === code);
			if (item !== undefined) item.state = state;
			return { ok: true };
		},
		mark: { get: (key) => marks.get(key), set: (key, value) => void marks.set(key, value) },
		shadow: () => {},
		event: () => {},
		ask: () => ({ ok: true }),
	};
}

/** The tick's programme ports with no catalogue: the dispatcher is the machine's step, not a programme's. */
function programmePorts(dispatch: DispatchPort): TickPorts {
	return {
		now: () => Date.now(),
		catalogue: () => undefined,
		control: {},
		readTasks: () => undefined,
		alerts: { get: () => undefined, set: () => undefined },
		alert: async () => ({ delivered: true }),
		dispatch,
	};
}

describe("OL4: one durable pass, the timer's whole sequence", { concurrency: false }, () => {
	test("the pass runs the timer's whole sequence, in main's order", async () => {
		await withDir(async (dir) => {
			const recorded = await onePass(dir, {
				quota: () => ({ out: ["quota line"] }),
				graphRefresh: () => ({ out: ["graph line"] }),
				gatewayFreshness: () => ({ out: ["gateway line"] }),
				askPush: () => ({ out: ["ask line"] }),
				standingRules: () => ({ out: ["standing line"] }),
				wakeHealth: async () => ({ out: ["wake line"], err: ["wake detail"] }),
				tick: async () => ({ out: ["tick line"] }),
			});
			assert.deepEqual(recorded.steps, PASS_STEPS, "each step runs once, in main's order");
			assert.deepEqual(recorded.out, ["quota line", "graph line", "gateway line", "ask line", "standing line", "wake line", "tick line"]);
			assert.deepEqual(recorded.err, ["wake detail"]);
			assert.equal(recorded.failed, 0, "a clean pass marks nothing failed");
		});
	});

	test("a failing step is reported and the pass continues", async () => {
		await withDir(async (dir) => {
			const recorded = await onePass(dir, {
				quota: () => {
					throw new Error("provider-pool.json: broken");
				},
				// Henry wake health reports without marking the run failed, as it already did on the base.
				wakeHealth: async () => {
					throw new Error("gh is broken");
				},
			});
			assert.deepEqual(recorded.steps, PASS_STEPS, "no later step is skipped");
			assert.deepEqual(recorded.err, [
				"muster-tick: quota fallback failed: provider-pool.json: broken",
				"muster-tick: Henry wake health pass failed: gh is broken",
			]);
			assert.equal(recorded.failed, 1, "only the quota step marks the run failed");
		});
	});

	test("the second owner skips: one line, no step", async () => {
		await withDir(async (dir) => {
			const holder = await holdLock(join(dir, "tick.lock"));
			try {
				const recorded = await onePass(dir);
				assert.deepEqual(recorded.out, [TICK_LOCK_HELD], "the loser logs exactly the line");
				assert.equal(TICK_LOCK_HELD, "skipped: lock held");
				assert.deepEqual(recorded.steps, [], "no step runs, not even the heartbeat");
				assert.equal(recorded.failed, 0);
			} finally {
				holder.kill();
				await new Promise<void>((resolve) => holder.once("exit", () => resolve()));
			}
		});
	});

	test("the durable task's pass advances with no timer", async () => {
		await withDir(async (dir) => {
			const recorded = recordingTickPass(dir);
			const ledger = await openDurable(dir, recorded, 25);
			try {
				const passNo = await waitPassNo(ledger, 2);
				assert.ok(passNo >= 2, `passNo advanced to ${passNo}`);
				assert.equal((await tickState(ledger)).status, "running");
				assert.ok(recorded.steps.length >= DURABLE_STEPS.length * 2, "each pass ran the whole sequence");
				assert.deepEqual(recorded.steps.slice(0, DURABLE_STEPS.length), DURABLE_STEPS);

				// The other owner holds the lock: the durable pass does nothing, and its counter still moves.
				const stepsBefore = recorded.steps.length;
				const outBefore = recorded.out.length;
				const holder = await holdLock(join(dir, "tick.lock"));
				try {
					const next = await waitPassNo(ledger, passNo + 1);
					assert.ok(next > passNo);
					assert.equal(recorded.steps.length, stepsBefore, "a skipped pass runs no step");
					assert.deepEqual(recorded.out.slice(outBefore), [TICK_LOCK_HELD]);
				} finally {
					holder.kill();
					await new Promise<void>((resolve) => holder.once("exit", () => resolve()));
				}
			} finally {
				await ledger.close();
			}
		});
	});

	test("a ready item is dispatched by the durable pass, with no timer", async () => {
		await withDir(async (dir) => {
			const brief = join(dir, "lane-prompt-ol4x.md");
			writeFileSync(brief, "Outcome: a fixture item.\nCut from: Pi main at bfd73551624f (~/.pi/agent), worktree ~/projects/muster-lane-ol4\nOwned paths: muster/tick.ts\n");
			const launches: LaunchRequest[] = [];
			const dispatch = dispatchPort(dir, brief, launches);
			const recorded = recordingTickPass(dir, {
				tick: async () => {
					const actions = await runTick(programmePorts(dispatch));
					return { out: actions.filter((action) => action.action !== "none").map((action) => `${action.action}: ${action.detail}`) };
				},
			});
			const ledger = await openDurable(dir, recorded, 25);
			try {
				await waitPassNo(ledger, 1);
				const deadline = Date.now() + 5000;
				while (launches.length === 0 && Date.now() < deadline) await delay(10);
				assert.equal(launches.length, 1, `the durable pass launched the one ready item; out=${recorded.out.join(" | ")} err=${recorded.err.join(" | ")}`);
				assert.equal(launches[0]?.code, "OL4X");
				assert.ok(recorded.steps.includes("tick pass"));
			} finally {
				await ledger.close();
			}
		});
	});

	test("live bindings: every step is bound, over the directory the caller names", async () => {
		await withDir(async (dir) => {
			const ports = liveTickPassPorts(dir);
			assert.equal(ports.stateDir(), dir, "the lock and the steps use the caller's state dir, never the live one");
			for (const key of ["heartbeat", "replaySpool", "quota", "graphRefresh", "gatewayFreshness", "askPush", "standingRules", "wakeHealth", "tick", "out", "err", "fail"] as const) {
				assert.equal(typeof ports[key], "function", `${key} is bound`);
			}
		});
	});

	test("rollback: with the flag off no task is created, and the pass still runs", async () => {
		await withDir(async (dir) => {
			const saved = process.env[MUSTER_LEDGER_TASKS];
			delete process.env[MUSTER_LEDGER_TASKS];
			try {
				const ledger = await openLedger(dir);
				try {
					const { tasks } = await ledger.harness.inspect(BACKGROUND);
					assert.equal(tasks.filter(({ record }) => record.kind === TICK_TASK).length, 0, "no tick task with the flag off");
				} finally {
					await ledger.close();
				}
			} finally {
				if (saved !== undefined) process.env[MUSTER_LEDGER_TASKS] = saved;
			}
			const recorded = await onePass(dir);
			assert.deepEqual(recorded.steps, PASS_STEPS, "the timer's entry still runs the whole sequence");
		});
	});
});
