/**
 * The `muster.lane` task (PB2): one durable task per lane, from its launch
 * to its close. The task is the lane's life: the lane card and the process go
 * away; the task ends; the `LaneRecord` stays so LD26 still reads `merged` or
 * `closed`.
 *
 * The launch is an effect sandwich. An intent memo is written before the
 * effect, the effect runs, and an outcome memo is written after it. A process
 * that dies between the effect and its record is never launched again: the
 * task flags `LAUNCH UNCERTAIN` and the tick's liveness pass settles the lane
 * as live or abandoned.
 *
 * The stop is the `closing` phase: it retries `ports.stop` (alive-first in the
 * port, so a repeat is safe) and records it in the `stopped` memo.
 *
 * The terminal commit is the one that sets `LaneRecord.phase` to a value of
 * `TERMINAL_PHASES`.
 *
 * `parked` and `resuming` (PB5) follow the lane record, the way `closing` does.
 * `live` goes to `parked` when the record says `parked` (the tick's park, after
 * the process was stopped). `parked` goes to `resuming` when the record leaves
 * `parked`: only `muster resume` does that (`recordLaunch`, cli/resume.ts:82);
 * a send writes the inbox and the ASLEEP line, never the record (A13).
 * `resuming` goes to `live` once the process is up (`ports.alive`).
 *
 * Impact map (PB5 additions, VR22-30):
 * - tick-task.ts: the tick writes `parked` or a terminal phase on the record,
 *   after it stopped the process. This task only observes. A task that wrote
 *   `parked` itself would be a second park decision beside `decideLifecycle`.
 * - `abandoned` and `merged` (C1): they go through `closing`, so `ports.stop`
 *   runs and its failure keeps the task unfinished. They used to finish the
 *   task at once, leaving the process of a lane the tick wrongly judged dead
 *   running with no task. `finish` writes nothing over a terminal phase (K2).
 * - cli/resume.ts and send.ts: not changed. Their contract is the input of this
 *   task: `recordLaunch` moves `parked` to `working`; a send does not.
 * - `resuming` waits with `runtime.sleep`, which rejects when the invocation is
 *   signalled, so a closing ledger ends the wait. It re-reads the record each
 *   poll: a lane that was parked again or closed meanwhile leaves `resuming`.
 *
 * Impact map (VR22-30):
 * - task-ports.ts: the task must call PB1's `LanePorts` (`createTaskPorts().lane`).
 *   A second port set would launch/stop/alive differently from musterd. Unbound
 *   ports throw. `createTaskPorts().launch` runs `pi-lane-launch.sh`; a test that
 *   calls it for real would spawn a lane.
 * - lane-lifecycle TERMINAL_PHASES: finish() writes `merged` | `closed` |
 *   `abandoned` onto `LaneRecord.phase`. A made-up phase would let `muster resume`
 *   wake a finished lane (LD26). Close is a watch on that record, not a second
 *   phase table.
 * - scripts/pi-lane-launch.sh: a death between intent and outcome must not call
 *   launch again. If the memos were not durable, a restart would spawn a second
 *   process. The tick, not this task, settles UNCERTAIN.
 * - tick liveness pass: UNCERTAIN leaves the task at `live`. If the tick never
 *   probes it (PB3), the lane stays live. If this task settled UNCERTAIN itself,
 *   it would steal that owner.
 * - muster resume: LD26 reads `LaneRecord`, not the task graph. A terminal result
 *   only on the task would let resume restart a merged or closed lane. Resume in
 *   ledger mode reads CAS through musterd; a files-only copy of the phase would
 *   not prove that path.
 * - ledger/musterd restarts: SIGKILL after intent or after the effect relies on
 *   sqlite restoring the memos. If LaneTask is not registered in the replacement
 *   process (PB1's `registerMusterTasks` is still a stub), reopen cannot resume
 *   the task.
 * - deploy: live `musterd.service` leaves `MUSTER_LEDGER_TASKS` unset (PB-D3), so
 *   this task stays inert until PB7. This package does not touch the timer or
 *   the live unit.
 */

import type { Context } from "@earendil-works/chord";
import type { Harness, JsonObject, TaskId, TaskRuntime, Tx } from "@earendil-works/pi-durable";
import { defineTask } from "@earendil-works/pi-durable";
import type { LaneRecord } from "../lane-lifecycle.ts";
import { TERMINAL_PHASES } from "../lane-lifecycle.ts";
import { crashKill } from "./runtime.ts";
import { CasFamily, MusterEvent, type CasDoc } from "./schema.ts";
import { LANE_RECORD_STORE } from "./stores.ts";
import type { LanePorts } from "./task-ports.ts";

/** The task kind, as it appears in the task graph. */
export const LANE_TASK = "muster.lane";

export type { LanePorts };

/** The three values a lane task ends with, the values of `TERMINAL_PHASES`. */
export type LaneTerminalPhase = "merged" | "closed" | "abandoned";

/** The task's terminal result: the same value `LaneRecord.phase` takes. */
export type LaneResult = { phase: LaneTerminalPhase };

/** The task's checkpoint phases. */
export type LaneCheckpoint =
	| { phase: "launching" }
	| { phase: "live" }
	| { phase: "parked" }
	| { phase: "resuming" }
	| { phase: "closing" };

/** The task's input. */
export type LaneInput = { laneId: string };

type LaneRuntime = TaskRuntime<LaneInput, LaneCheckpoint, LaneResult, object>;

/** A live lane task, as the tick's pass and `close` need it. */
export type LiveLaneTask = { taskId: TaskId<LaneResult>; laneId: string; phase: string };

let boundPorts: LanePorts | undefined;

/** Bind the launch/stop/alive ports this process's lane tasks call. */
export function bindLaneTaskPorts(ports: LanePorts): void {
	boundPorts = ports;
}

function ports(): LanePorts {
	if (boundPorts === undefined) throw new Error("muster.lane has no lane ports bound");
	return boundPorts;
}

function laneKey(laneId: string): string {
	return `${LANE_RECORD_STORE}:${laneId}`;
}

export function isTerminalPhase(phase: string): phase is LaneTerminalPhase {
	return (TERMINAL_PHASES as readonly string[]).includes(phase);
}

function asLaneRecord(doc: CasDoc | Readonly<CasDoc> | null | undefined): LaneRecord | undefined {
	if (doc === undefined || doc === null || doc.record === null) return undefined;
	const record = doc.record as unknown as Partial<LaneRecord>;
	if (typeof record.laneId !== "string" || typeof record.phase !== "string") return undefined;
	return record as LaneRecord;
}

function writeRecord(doc: { record: JsonObject | null; revision: number }, record: LaneRecord): void {
	doc.record = record as unknown as JsonObject;
	doc.revision += 1;
}

/**
 * Every live lane task with its checkpoint phase. Durable Pi exposes no scan on
 * the task runtime, so the caller passes the Harness (`inspect` is read-only
 * and runs no task code).
 */
export async function liveLaneTasks(harness: Harness, context: Context): Promise<LiveLaneTask[]> {
	const { tasks } = await harness.inspect(context);
	const found: LiveLaneTask[] = [];
	for (const { record } of tasks) {
		if (record.kind !== LANE_TASK) continue;
		const input = record.input as { laneId?: unknown } | null;
		const laneId = input === null || typeof input !== "object" ? undefined : input.laneId;
		if (typeof laneId !== "string") continue;
		const state = record.state as { status: string; checkpoint?: { phase: string } };
		if (state.checkpoint === undefined) continue;
		found.push({ taskId: record.id as TaskId<LaneResult>, laneId, phase: state.checkpoint.phase });
	}
	return found;
}

/** The lane record the ports need. */
async function requireLane(runtime: LaneRuntime, laneId: string, context: Context): Promise<LaneRecord> {
	const lane = asLaneRecord(await runtime.snapshot(CasFamily, laneKey(laneId), context));
	if (lane === undefined) throw new Error(`lane ${laneId} has no document`);
	return lane;
}

/** Commit the task terminal with the outcome its lane record already holds. */
async function finish(
	runtime: LaneRuntime,
	laneId: string,
	context: Context,
	fallback: LaneTerminalPhase = "closed",
): Promise<void> {
	await runtime.commit(async (tx) => {
		const doc = await tx.doc(CasFamily, laneKey(laneId), { store: LANE_RECORD_STORE, id: laneId });
		const lane = asLaneRecord(doc);
		const phase = lane !== undefined && isTerminalPhase(lane.phase) ? lane.phase : fallback;
		// K2: a terminal phase is final. Only a record that is not terminal yet is written.
		if (lane !== undefined && !isTerminalPhase(lane.phase)) writeRecord(doc, { ...lane, phase, phaseSince: runtime.now() });
		return { status: "terminal", outcome: { status: "completed", result: { phase } } };
	}, context);
}

/** What a phase waits for on the lane record: a terminal phase, or the one change that is its own. */
type Wait = "live" | "parked";

function intentOf(value: Readonly<CasDoc> | null, wait: Wait): string | undefined {
	const lane = asLaneRecord(value);
	if (lane === undefined) return undefined;
	if (isTerminalPhase(lane.phase)) return lane.phase;
	if (wait === "live" && lane.phase === "parked") return "parked";
	if (wait === "parked" && lane.phase !== "parked") return lane.phase;
	return undefined;
}

/**
 * Wait for the phase another commit wrote on the lane record. The watch is the
 * durable signal; the checkpoint commit stays the task's own. The Harness
 * closing aborts the invocation, so the wait races the runtime's own signal.
 */
async function waitForIntent(runtime: LaneRuntime, laneId: string, context: Context, wait: Wait): Promise<string> {
	const watch = await runtime.watchDoc(CasFamily, laneKey(laneId), context);
	if (watch === undefined) throw new Error(`lane ${laneId} has no document`);
	let stopListener: (() => void) | undefined;
	const stopped = new Promise<never>((_resolve, reject) => {
		const onAbort = (): void => reject(new Error(`lane ${laneId}: the ledger closed while the lane was ${wait}`));
		if (runtime.signal.aborted) onAbort();
		else {
			runtime.signal.addEventListener("abort", onAbort, { once: true });
			stopListener = () => runtime.signal.removeEventListener("abort", onAbort);
		}
	});
	try {
		let settled: string | undefined;
		const reached = (value: Readonly<CasDoc> | null): void => {
			if (settled !== undefined) return;
			settled = intentOf(value, wait);
		};
		const intent = new Promise<string>((resolve) => {
			watch.start(async (value) => {
				reached(value);
				if (settled !== undefined) resolve(settled);
			});
		});
		reached(watch.value);
		if (settled !== undefined) return settled;
		return await Promise.race([intent, stopped]);
	} finally {
		stopListener?.();
		await watch.stop();
	}
}

/** `live` and `parked`: wait for the record, then take the checkpoint it calls for. */
async function leave(runtime: LaneRuntime, laneId: string, context: Context, wait: Wait): Promise<void> {
	const phase = await waitForIntent(runtime, laneId, context, wait);
	if (isTerminalPhase(phase)) {
		// Every terminal phase is stopped first. `abandoned` is the tick's judgement that the process is
		// dead, and a wrong judgement must not leave the process running with no task (C1).
		await runtime.commit(() => ({ status: "running", checkpoint: { phase: "closing" } }), context);
		return;
	}
	const next = wait === "live" ? "parked" : "resuming";
	await runtime.commit(() => ({ status: "running", checkpoint: { phase: next } }), context);
}

/** How often `resuming` asks whether the process is up. */
export const RESUME_POLL_MS = 2_000;

/** `resuming`: wait for the resumed process, unless the record moved on. */
async function awaitResumed(runtime: LaneRuntime, laneId: string, context: Context): Promise<void> {
	for (;;) {
		const lane = await requireLane(runtime, laneId, context);
		if (isTerminalPhase(lane.phase)) {
			await runtime.commit(() => ({ status: "running", checkpoint: { phase: "closing" } }), context);
			return;
		}
		if (lane.phase === "parked") {
			await runtime.commit(() => ({ status: "running", checkpoint: { phase: "parked" } }), context);
			return;
		}
		if (await ports().alive(lane)) {
			await runtime.commit(() => ({ status: "running", checkpoint: { phase: "live" } }), context);
			return;
		}
		await runtime.sleep(runtime.now() + RESUME_POLL_MS, context);
	}
}

async function stopOnce(runtime: LaneRuntime, laneId: string, context: Context, ignoreMissing: boolean): Promise<void> {
	if ((await runtime.memo<boolean>("stopped", context)) !== undefined) return;
	try {
		const lane = await requireLane(runtime, laneId, context);
		await ports().stop(lane);
	} catch (error) {
		if (!ignoreMissing) throw error;
	}
	await runtime.memo("stopped", true, context);
}

/** One lane's life as a durable task: `launching`, `live`, `closing`. */
export const LaneTask = defineTask<LaneInput, LaneCheckpoint, LaneResult>({
	name: LANE_TASK,
	version: 1,
	initial: () => ({ phase: "launching" }),
	phases: {
		launching: async (task, runtime, context) => {
			const laneId = task.input.laneId;
			let sessionId = (await runtime.memo<string>("launched", context)) ?? null;
			if (sessionId === null) {
				const intent = await runtime.memo<string>("launch-intent", context);
				if (intent === undefined) {
					await runtime.memo("launch-intent", laneId, context);
					crashKill("after-launch-intent");
					const lane = await requireLane(runtime, laneId, context);
					const launched = await ports().launch(lane);
					crashKill("before-launch-memo");
					sessionId = launched.sessionId;
					await runtime.memo("launched", sessionId, context);
					crashKill("after-launch-memo");
				} else {
					// The process died between the intent and its outcome. The task is
					// never launched again; the tick's liveness probe settles it.
					await runtime.commit(async (tx) => {
						const at = runtime.now();
						await tx.appendEntry(MusterEvent, runtime.conversationId, {
							data: { type: "LAUNCH UNCERTAIN", lane: laneId, text: "", at },
						});
						return { status: "running", checkpoint: { phase: "live" } };
					}, context);
					return;
				}
			}
			await runtime.commit(async (tx) => {
				const at = runtime.now();
				const doc = await tx.doc(CasFamily, laneKey(laneId), { store: LANE_RECORD_STORE, id: laneId });
				const lane = asLaneRecord(doc);
				if (lane !== undefined) writeRecord(doc, { ...lane, sessionId });
				await tx.appendEntry(MusterEvent, runtime.conversationId, {
					data: { type: "LIVE", lane: laneId, text: "", at },
				});
				return { status: "running", checkpoint: { phase: "live" } };
			}, context);
		},
		live: async (task, runtime, context) => {
			await leave(runtime, task.input.laneId, context, "live");
		},
		parked: async (task, runtime, context) => {
			await leave(runtime, task.input.laneId, context, "parked");
		},
		resuming: async (task, runtime, context) => {
			await awaitResumed(runtime, task.input.laneId, context);
		},
		closing: async (task, runtime, context) => {
			await stopOnce(runtime, task.input.laneId, context, false);
			await finish(runtime, task.input.laneId, context);
		},
	},
	abort: async (task, runtime, context) => {
		await stopOnce(runtime, task.input.laneId, context, true);
		await finish(runtime, task.input.laneId, context, "abandoned");
	},
});
