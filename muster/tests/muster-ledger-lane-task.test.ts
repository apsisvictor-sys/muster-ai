/**
 * PB2: exactly-once launch and stop for `muster.lane`. Rehearsal directories
 * only — never ~/.pi/agent/state/muster.
 *
 * Ports come from PB1 `createTaskPorts`. Launch is replaced in these tests so
 * the sandwich can run without spawning a lane; stop and alive are
 * `closeLaneLive` / `readLaneCard`. LD26 reads the task's CAS `LaneRecord`
 * through a child musterd (requestSync cannot share this process).
 */

import "./muster-test-isolation.ts";
process.env.MUSTER_LEDGER_TEST = "1";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { JsonObject } from "@earendil-works/pi-durable";
import { bindLaneTaskPorts, LANE_TASK, type LanePorts } from "../ledger/lane-task.ts";
import { eventsSince } from "../ledger/methods.ts";
import type { Ledger } from "../ledger/open.ts";
import { CasFamily, type MusterEventData } from "../ledger/schema.ts";
import { LANE_RECORD_STORE } from "../ledger/stores.ts";
import { readLaneRecord, type LaneRecord } from "../lane-lifecycle.ts";
import { resumeCommand, type ResumeDeps } from "../cli/resume.ts";
import type { CliContext } from "../cli/types.ts";
import {
	loggingLaunch,
	openLaneTaskLedger,
	PB2_LANE_ID,
	seedAndLaunch,
} from "./fixtures/muster-ledger-launch-child.mts";
import { harnessRoot, nodeBinary, tsxLoaderPath } from "../../core/harness-paths.ts";

const here = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
const fixturePath = join(here, "fixtures", "muster-ledger-launch-child.mts");
const DAEMON = join(HARNESS_ROOT, "muster", "ledger", "daemon.ts");
const NODE = nodeBinary();
const tempDir = () => mkdtempSync(join(tmpdir(), "ledger-lane-"));

/** Launch that does not spawn: the sandwich tests the task, not `pi-lane-launch.sh`. */
const quietLaunch: LanePorts["launch"] = async () => ({ sessionId: "s1" });

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = tempDir();
	try {
		await run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function loaderArgs(): string[] {
	const args: string[] = [];
	for (let at = 0; at < process.execArgv.length; at++) {
		if (process.execArgv[at] === "--import" && process.execArgv[at + 1] !== undefined) {
			args.push("--import", process.execArgv[at + 1] as string);
		}
	}
	return args.length > 0 ? args : ["--import", tsxLoaderPath()];
}

/**
 * Child musterd on `dir`. requestSync blocks this thread, so the daemon cannot
 * live in this process (same pattern as ledger-lc5-owners).
 */
function startDaemonChild(dir: string): { child: ChildProcess; ready: Promise<void> } {
	const file = join(dir, "fixture-daemon.mjs");
	writeFileSync(
		file,
		[`import { startDaemon } from ${JSON.stringify(DAEMON)};`, "await startDaemon(process.env.MUSTER_FIXTURE_DIR);", 'process.stdout.write("READY\\n");'].join("\n"),
	);
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
			if (child.exitCode !== null || child.signalCode !== null) {
				throw new Error(`the daemon fixture exited before READY: ${output}`);
			}
			if (Date.now() > deadline) throw new Error(`the daemon fixture did not answer within 15 s: ${output}`);
			await delay(25);
		}
	})();
	return { child, ready };
}

async function stopDaemonChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
	child.kill("SIGKILL");
	await exited;
}

/** Wait until the lane's task reaches a checkpoint phase. */
async function waitLane(l: Ledger, laneId: string, phase: string, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	for (;;) {
		const { tasks } = await l.harness.inspect(ctx);
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

async function waitLaneGone(l: Ledger, laneId: string, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	for (;;) {
		const { tasks } = await l.harness.inspect(ctx);
		const found = tasks.find(({ record }) => {
			if (record.kind !== LANE_TASK) return false;
			const input = record.input as { laneId?: string } | null;
			const state = record.state as { status?: string };
			return input?.laneId === laneId && state.status !== "terminal";
		});
		if (found === undefined) return;
		if (Date.now() > deadline) throw new Error(`lane ${laneId} did not leave the task graph`);
		await delay(10);
	}
}

/** Wait for an event, optionally one matching `matches`. */
async function waitEvent(
	l: Ledger,
	type: string,
	ms = 5000,
	matches?: (event: MusterEventData) => boolean,
): Promise<MusterEventData> {
	const deadline = Date.now() + ms;
	for (;;) {
		const found = (await eventsSince(l)).find((event) => event.type === type && (matches === undefined || matches(event)));
		if (found !== undefined) return found;
		if (Date.now() > deadline) throw new Error(`event ${type} did not arrive`);
		await delay(10);
	}
}

async function closeLane(l: Ledger, laneId: string, phase: "closed" | "merged" | "abandoned" = "closed"): Promise<void> {
	await l.root.commit(async (tx) => {
		const doc = await tx.doc(CasFamily, `${LANE_RECORD_STORE}:${laneId}`, { store: LANE_RECORD_STORE, id: laneId });
		const record = doc.record as unknown as LaneRecord;
		doc.record = { ...record, phase, phaseSince: Date.now() } as unknown as JsonObject;
		doc.revision += 1;
	}, ctx);
	await waitLaneGone(l, laneId);
}

/** Run the fixture child, which dies at `crashAt`. */
function runChild(dir: string, log: string, crashAt: string) {
	return spawnSync(process.execPath, ["--import", "tsx", fixturePath, dir, log], {
		cwd: HARNESS_ROOT,
		env: { ...process.env, MUSTER_LEDGER_TEST: "1", MUSTER_LEDGER_CRASH_AT: crashAt },
		timeout: 20_000,
	});
}

const launchCount = (log: string) => {
	try {
		return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length;
	} catch {
		return 0;
	}
}

function resumeCtx(dir: string): { ctx: CliContext; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	const env = { ...process.env, PI_MUSTER_STATE_DIR: dir, MUSTER_LEDGER_DIR: dir };
	delete env.MUSTERD;
	return {
		out,
		err,
		ctx: {
			argv: [PB2_LANE_ID],
			HARNESS_ROOT: dir,
			agentId: "orchestrator",
			json: false,
			cwd: dir,
			env,
			io: { out: (line) => out.push(line), err: (line) => err.push(line) },
			readStdin: async () => "",
		},
	};
}

const resumeDeps: ResumeDeps = {
	sessionRows: () => ({}),
	claude: {
		readRows: () => [],
		runCli: () => ({ status: 0, stdout: "", stderr: "" }),
		readJob: () => undefined,
		pidAlive: () => false,
		now: () => 1_000_000,
		sleep: () => {},
	},
};

describe("muster.lane PB2", { concurrency: false }, () => {
	test("launch intent without outcome: restart does not launch and flags LAUNCH UNCERTAIN", async () => {
		await withDir(async (dir) => {
			const log = join(dir, "launches.log");
			assert.equal(runChild(dir, log, "after-launch-intent").signal, "SIGKILL");
			const { ledger } = await openLaneTaskLedger(dir, { launch: loggingLaunch(log) });
			try {
				await waitEvent(ledger, "LAUNCH UNCERTAIN", 5000, (event) => event.lane === PB2_LANE_ID);
				assert.equal(launchCount(log), 0);
			} finally {
				await ledger.close();
			}
		});
	});

	test("kill -9 after the launch effect, before the outcome: no second launch, flags LAUNCH UNCERTAIN", async () => {
		await withDir(async (dir) => {
			const log = join(dir, "launches.log");
			assert.equal(runChild(dir, log, "before-launch-memo").signal, "SIGKILL");
			const { ledger } = await openLaneTaskLedger(dir, { launch: loggingLaunch(log) });
			try {
				await waitEvent(ledger, "LAUNCH UNCERTAIN", 5000, (event) => event.lane === PB2_LANE_ID);
				assert.equal(launchCount(log), 1);
			} finally {
				await ledger.close();
			}
		});
	});

	test("stop on an already-dead process writes one stopped memo and phase closed", async () => {
		await withDir(async (dir) => {
			let stops = 0;
			const { ledger, ports } = await openLaneTaskLedger(dir, { launch: quietLaunch });
			bindLaneTaskPorts({
				launch: quietLaunch,
				stop: async (lane) => {
					stops += 1;
					await ports.lane.stop(lane);
				},
				alive: (lane) => ports.lane.alive(lane),
			});
			try {
				await seedAndLaunch(ledger);
				await waitLane(ledger, PB2_LANE_ID, "live");
				assert.equal(await ports.lane.alive({ laneId: PB2_LANE_ID } as LaneRecord), false);
				await closeLane(ledger, PB2_LANE_ID, "closed");
				assert.equal(stops, 1);
				const cas = await ports.reconcile.casRead({ store: LANE_RECORD_STORE, id: PB2_LANE_ID });
				assert.equal((cas?.record as LaneRecord | null)?.phase, "closed");
				const graph = await ledger.harness.taskGraph(ctx);
				assert.equal(
					Object.values(graph.value.tasks).some((task) => task.kind === LANE_TASK),
					false,
				);
			} finally {
				await ledger.close();
			}
		});
	});

	test("muster resume of a closed lane still refuses via the CAS record, not the task (LD26)", async () => {
		await withDir(async (dir) => {
			const { ledger, ports } = await openLaneTaskLedger(dir, { launch: quietLaunch });
			try {
				await seedAndLaunch(ledger);
				await waitLane(ledger, PB2_LANE_ID, "live");
				await closeLane(ledger, PB2_LANE_ID, "closed");
				const cas = await ports.reconcile.casRead({ store: LANE_RECORD_STORE, id: PB2_LANE_ID });
				assert.equal((cas?.record as LaneRecord | null)?.phase, "closed");
			} finally {
				await ledger.close();
			}

			writeFileSync(
				join(dir, "backend.json"),
				JSON.stringify({ backend: "ledger", flipId: "pb2-test", at: "2026-10-23T00:00:00+03:00", cursor: "1" }),
			);
			const daemon = startDaemonChild(dir);
			try {
				await daemon.ready;
				const { ctx: cli, out, err } = resumeCtx(dir);
				assert.equal(await resumeCommand(cli, resumeDeps), 3);
				assert.equal(readLaneRecord(dir, PB2_LANE_ID)?.phase, "closed");
				assert.equal(out.length, 0);
				assert.equal(
					err.join("\n"),
					`muster resume: ${PB2_LANE_ID} was not resumed: ${PB2_LANE_ID} is merged (or closed); start a new lane`,
				);
			} finally {
				await stopDaemonChild(daemon.child);
			}
		});
	});
});
