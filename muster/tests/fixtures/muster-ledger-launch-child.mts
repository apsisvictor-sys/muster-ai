/**
 * The child a `muster.lane` crash test runs (PB2).
 *
 * It opens a rehearsal ledger in the directory it is given, binds PB1's
 * `createTaskPorts` (stop/alive are the real wrappers; launch is a recording
 * stand-in so the sandwich can run without spawning a lane), starts `rh-pb2-a`,
 * and stays alive so the armed crash point kills it inside `launching`.
 *
 * Run directly:
 *   node --import tsx extensions/tests/fixtures/muster-ledger-launch-child.mts <dir> <launchLog>
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import type { JsonObject } from "@earendil-works/pi-durable";
import { createRegistry, defineExtension, Harness as DurableHarness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { bindLaneTaskPorts, LaneTask, type LanePorts } from "../../ledger/lane-task.ts";
import type { Ledger } from "../../ledger/open.ts";
import { CasFamily } from "../../ledger/schema.ts";
import { LANE_RECORD_STORE } from "../../ledger/stores.ts";
import { createTaskPorts, type TaskPorts } from "../../ledger/task-ports.ts";
import type { LaneRecord } from "../../lane-lifecycle.ts";

export const PB2_LANE_ID = "rh-pb2-a";

/** Recording launch used by the crash sandwich: one line per call, no real process. */
export function loggingLaunch(log: string): LanePorts["launch"] {
	return async () => {
		appendFileSync(log, "launch\n");
		return { sessionId: "s1" };
	};
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

/**
 * Open a rehearsal ledger with `LaneTask` registered and PB1's `createTaskPorts`
 * bound. `wrap.launch` replaces only the launch effect so crash tests do not
 * spawn a lane; stop and alive stay `closeLaneLive` / `readLaneCard`.
 */
export async function openLaneTaskLedger(
	dir: string,
	wrap: Partial<LanePorts> = {},
): Promise<{ ledger: Ledger; ports: TaskPorts }> {
	const storage = await openNodeSqliteStorage(join(dir, "ledger.sqlite"));
	const registry = createRegistry();
	registry.install(defineExtension({ name: "muster", tasks: [LaneTask] }));
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
	// Liveness reads fixture evidence only: no tmux, no `claude agents`, nothing of this machine.
	const ports = createTaskPorts(ledger, {
		directory: {
			skipClaude: true,
			home: dir,
			poolConfigPath: join(dir, "no-pool.json"),
			evidence: { tmuxPanes: () => [], pidAlive: () => false, hasAgentEnv: () => false, piProcesses: () => [], hermesUnits: () => [], scopeUnits: () => [] },
		},
	});
	bindLaneTaskPorts({
		launch: wrap.launch ?? ((lane) => ports.lane.launch(lane)),
		stop: wrap.stop ?? ((lane) => ports.lane.stop(lane)),
		park: wrap.park ?? ((lane) => ports.lane.park(lane)),
		alive: wrap.alive ?? ((lane) => ports.lane.alive(lane)),
	});
	harness.resume();
	return { ledger, ports };
}

/** Seed the lane record and create the `muster.lane` task in one commit. */
export async function seedAndLaunch(l: Ledger, laneId: string = PB2_LANE_ID): Promise<void> {
	const at = Date.now();
	await l.root.commit(async (tx) => {
		const doc = await tx.doc(CasFamily, `${LANE_RECORD_STORE}:${laneId}`, { store: LANE_RECORD_STORE, id: laneId });
		doc.record = seedRecord(laneId, l.dir, at) as unknown as JsonObject;
		doc.revision = 1;
		await tx.createTask(LaneTask, { laneId }, { ownership: { kind: "conversation" } });
	}, ctx);
}

async function main(): Promise<void> {
	const [dir, log] = process.argv.slice(2);
	if (dir === undefined || log === undefined) {
		throw new Error("usage: muster-ledger-launch-child.mts <dir> <launchLog>");
	}
	const { ledger } = await openLaneTaskLedger(dir, { launch: loggingLaunch(log) });
	await seedAndLaunch(ledger);
	// The crash point kills this process inside the launching phase; if it never
	// does, the test's spawn timeout reports it.
	await new Promise(() => {});
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
