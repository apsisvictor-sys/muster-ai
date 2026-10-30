/**
 * PB4: `ensureTick` keeps exactly one live `muster.tick` after a daemon start with
 * tasks on, and replaces one that faulted. Whole path: `startDaemon` →
 * `openLedger` (PB1 ports) → `ensureTick` → the PB3 tick task. Rehearsal
 * directories only — never ~/.pi/agent/state/muster.
 */

import "./muster-test-isolation.ts";
process.env.MUSTER_LEDGER_TEST = "1";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createClient } from "../ledger/client.ts";
import { startDaemon } from "../ledger/daemon.ts";
import { ensureTick, keepTick, MUSTER_LEDGER_TASKS, nextReplaceDelay, openLedger, type Ledger } from "../ledger/open.ts";
import { eventsSince } from "../ledger/methods.ts";
import { META_TICK_KEY, MetaFamily, type MusterEventData } from "../ledger/schema.ts";
import { readSpool, spoolWrite } from "../ledger/spool.ts";
import { bindTickTaskPorts, TICK_TASK } from "../ledger/tick-task.ts";
import { recordingTickPass } from "./tick-pass-fixture.ts";

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "ledger-ensure-tick-"));
	try {
		await run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Run `body` with the environment variables set, then restore them. */
async function withEnv<T>(vars: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
	const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
	for (const [key, value] of Object.entries(vars)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await body();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

const TASKS_ON = { [MUSTER_LEDGER_TASKS]: "1", MUSTERD: undefined };
const TASKS_OFF = { [MUSTER_LEDGER_TASKS]: undefined, MUSTERD: undefined };

/** Every tick task in the graph, live or not, with its state status. */
async function tickTasks(ledger: Ledger): Promise<{ id: string; status: string }[]> {
	const { tasks } = await ledger.harness.inspect(ctx);
	return tasks
		.filter(({ record }) => record.kind === TICK_TASK)
		.map(({ record }) => ({ id: String(record.id), status: (record.state as { status: string }).status }));
}

/** Inspect the ledger of a stopped daemon without running any task (the flag is unset). */
async function inspectTicks(dir: string): Promise<{ id: string; status: string }[]> {
	return withEnv(TASKS_OFF, async () => {
		const ledger = await openLedger(dir, { tickPass: recordingTickPass(dir).ports });
		try {
			return await tickTasks(ledger);
		} finally {
			await ledger.close();
		}
	});
}

async function metaTickId(dir: string): Promise<string | null | undefined> {
	return withEnv(TASKS_OFF, async () => {
		const ledger = await openLedger(dir, { tickPass: recordingTickPass(dir).ports });
		try {
			const doc = await ledger.harness.snapshot(MetaFamily, META_TICK_KEY, ctx);
			return doc?.tickId;
		} finally {
			await ledger.close();
		}
	});
}

/** Every event the live daemon holds, read through its socket. */
async function daemonEvents(socketPath: string): Promise<MusterEventData[]> {
	const client = createClient(socketPath);
	try {
		return (await client.request("events", {})) as MusterEventData[];
	} finally {
		client.close();
	}
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, ms = 8000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const found = await probe();
		if (found !== undefined) return found;
		if (Date.now() > deadline) throw new Error(`${what} did not happen`);
		await delay(20);
	}
}

describe("ensureTick PB4", { concurrency: false }, () => {
	test("A1: a daemon start with an empty task graph and tasks on leaves exactly one live tick", async () => {
		await withDir(async (dir) => {
			await withEnv(TASKS_ON, async () => {
				const daemon = await startDaemon(dir, { tickPass: recordingTickPass(dir).ports });
				await daemon.stop();
			});
			const ticks = await inspectTicks(dir);
			assert.equal(ticks.length, 1);
			assert.notEqual(ticks[0]?.status, "terminal");
			assert.equal(await metaTickId(dir), ticks[0]?.id);
		});
	});

	test("A2: a tick that faults is replaced and TICK FAULTED is appended", async () => {
		await withDir(async (dir) => {
			await withEnv({ ...TASKS_ON, MUSTER_LEDGER_CRASH_AT: "tick-escape" }, async () => {
				const daemon = await startDaemon(dir, { tickPass: recordingTickPass(dir).ports });
				try {
					const faulted = await waitFor("TICK FAULTED", async () =>
						(await daemonEvents(daemon.socketPath)).find((event) => event.type === "TICK FAULTED"),
					);
					assert.match(faulted.text, /muster\.tick|faulted/);
					assert.match(faulted.text, /tick-escape/);
				} finally {
					await daemon.stop();
				}
			});
			// One live tick remains, and it is not the one that faulted.
			const live = (await inspectTicks(dir)).filter((tick) => tick.status !== "terminal");
			assert.equal(live.length, 1);
			assert.equal(await metaTickId(dir), live[0]?.id);
		});
	});

	test("A3: a second start while the first tick is live keeps that one tick", async () => {
		await withDir(async (dir) => {
			await withEnv(TASKS_ON, async () => {
				await (await startDaemon(dir, { tickPass: recordingTickPass(dir).ports })).stop();
			});
			const first = await inspectTicks(dir);
			assert.equal(first.length, 1);
			await withEnv(TASKS_ON, async () => {
				await (await startDaemon(dir, { tickPass: recordingTickPass(dir).ports })).stop();
			});
			const second = await inspectTicks(dir);
			assert.deepEqual(second, first);
			assert.equal(await metaTickId(dir), first[0]?.id);
		});
	});

	test("A3b: concurrent ensureTick calls create one tick", async () => {
		await withDir(async (dir) => {
			await withEnv(TASKS_ON, async () => {
				const ledger = await openLedger(dir, { tickPass: recordingTickPass(dir).ports });
				try {
					await Promise.all([ensureTick(ledger), ensureTick(ledger), ensureTick(ledger)]);
					assert.equal((await tickTasks(ledger)).length, 1);
				} finally {
					await ledger.close();
				}
			});
		});
	});

	test("A4 (PB-D3): with the flag unset a daemon start creates no task and no tick record", async () => {
		await withDir(async (dir) => {
			await withEnv(TASKS_OFF, async () => {
				const daemon = await startDaemon(dir, { tickPass: recordingTickPass(dir).ports });
				await delay(100);
				await daemon.stop();
			});
			assert.equal((await inspectTicks(dir)).length, 0);
			assert.equal(await metaTickId(dir), undefined);
		});
	});

	test("C4: with the flag unset a stored tick stays blocked, neither faulted nor replaced, and resumes under the flag", async () => {
		await withDir(async (dir) => {
			await withEnv(TASKS_ON, async () => {
				await (await startDaemon(dir, { tickPass: recordingTickPass(dir).ports })).stop();
			});
			const before = await inspectTicks(dir);
			assert.equal(before.length, 1);
			await withEnv(TASKS_OFF, async () => {
				const daemon = await startDaemon(dir, { tickPass: recordingTickPass(dir).ports });
				try {
					await delay(300);
					const events = await daemonEvents(daemon.socketPath);
					assert.equal(events.filter((event) => event.type === "TICK FAULTED").length, 0);
				} finally {
					await daemon.stop();
				}
			});
			assert.deepEqual(await inspectTicks(dir), before);
			await withEnv(TASKS_ON, async () => {
				await (await startDaemon(dir, { tickPass: recordingTickPass(dir).ports })).stop();
			});
			assert.deepEqual(await inspectTicks(dir), before);
		});
	});

	test("whole path: the ensured tick runs its first pass on the ports openLedger bound and replays the spool", async () => {
		await withDir(async (dir) => {
			// Filed while no daemon runs; only the tick's pass through `createTaskPorts().onPass` appends it.
			spoolWrite(dir, {
				method: "appendEvent",
				params: { requestId: "pb4-spool", type: "WORKING", text: "filed-while-down" },
			});
			await withEnv(TASKS_ON, async () => {
				const daemon = await startDaemon(dir, { tickPass: recordingTickPass(dir).ports });
				try {
					await waitFor("the spool replay", async () =>
						(await daemonEvents(daemon.socketPath)).find((event) => event.requestId === "pb4-spool"),
					);
					const events = await daemonEvents(daemon.socketPath);
					assert.equal(events.filter((event) => event.type === "TICK ERROR").length, 0);
				} finally {
					await daemon.stop();
				}
			});
			assert.equal(readSpool(dir).length, 0);
		});
	});

	test("F1: a fault on every pass backs off, doubling from the base wait", async () => {
		await withDir(async (dir) => {
			await withEnv(TASKS_ON, async () => {
				const ledger = await openLedger(dir, { tickPass: recordingTickPass(dir).ports });
				try {
					// A tick whose pass escapes its catch every time: no harness to scan the lanes with.
					bindTickTaskPorts({ ports: undefined as never, harness: undefined as never, passPorts: undefined as never });
					await keepTick(ledger, 60_000, { replaceDelayMs: 50 });
					const faulted = async () => (await eventsSince(ledger)).filter((event) => event.type === "TICK FAULTED");
					await waitFor("four replacements", async () => ((await faulted()).length >= 4 ? true : undefined), 5000);
					const at = (await faulted()).map((event) => event.at);
					const gaps = at.slice(1).map((value, index) => value - (at[index] ?? 0));
					// 50, 100, 200 ms plus the commit time: each gap about double the one before.
					assert.ok((gaps[2] ?? 0) >= 2.5 * (gaps[0] ?? Infinity), `gaps ${gaps.join(", ")} do not grow`);
					await delay(1000);
					// Without the back-off a 50 ms wait would add some 15 more in this second; doubling adds at most 3.
					assert.ok((await faulted()).length <= 4 + 3, "the replacements kept spinning");
				} finally {
					await ledger.close();
				}
			});
		});
	});

	test("F1: the wait doubles per consecutive fault up to the interval and resets after a full interval", () => {
		const interval = 120_000;
		let state = { waitMs: 0, faults: 0 };
		const waits: number[] = [];
		for (let index = 0; index < 9; index++) {
			state = nextReplaceDelay(state.faults, 10, interval);
			waits.push(state.waitMs);
		}
		assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000, 32000, 64000, 120000, 120000]);
		assert.deepEqual(nextReplaceDelay(state.faults, interval, interval), { waitMs: 1000, faults: 1 });
		assert.deepEqual(nextReplaceDelay(state.faults, interval - 1, interval).waitMs, 120000);
	});
});
