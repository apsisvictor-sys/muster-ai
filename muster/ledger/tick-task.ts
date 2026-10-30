/**
 * The `muster.tick` task (PB3): one background task, exactly one live, whose
 * single `pass` phase is the 2-minute tick. Its checkpoint holds the next due
 * time, so a restart sleeps until the stored `dueAt` instead of running early,
 * and every pass commits a new checkpoint, so Durable Pi's "checkpoint
 * unchanged" rule can never fault it.
 *
 * A failure inside a pass is caught per lane and per step and committed as a
 * `TICK ERROR`. The handler never throws on purpose. A fault that escapes
 * anyway ends the task `faulted`; `ensureTick` (PB4) appends `TICK FAULTED`
 * and creates the replacement.
 *
 * `onPass` is PB1's spool replay (DL6). `registerMusterTasks` (task-ports.ts)
 * binds it, before `harness.resume()`, when tasks are on.
 *
 * Impact map (VR22-30):
 * - task-ports.ts: the pass calls PB1's `LanePorts.alive` and `onPass`. The
 *   ports are bound once, in `registerMusterTasks`, which `open.ts` runs before
 *   `harness.resume()`. A bind after open (the daemon, as PB3 first did) lets a
 *   tick resumed past its `dueAt` reach unbound ports and fault. A second port
 *   set would probe liveness and replay the spool differently from musterd.
 *   Unbound ports throw.
 * - open.ts: declares `TickTask` and `LaneTask` on the Muster extension before
 *   `registry.install` (the registry takes tasks at install only), and only
 *   when `MUSTER_LEDGER_TASKS=1`. Tasks off, no task is registered.
 * - lane-task.ts `liveLaneTasks`: the pass walks live `muster.lane` tasks. A
 *   private scan would miss UNCERTAIN lanes the tick is supposed to settle.
 * - lane-lifecycle TERMINAL_PHASES (K2): a terminal record (`merged`, `closed`,
 *   `abandoned`) is final. The pass skips such a record, and `abandon` re-checks
 *   inside its transaction, writing no phase and no ABANDONED event if the
 *   record became terminal after the probe (`muster close` racing the tick
 *   while the lane task is still `live`). A dead lane that is not terminal is
 *   written `abandoned` on `LaneRecord` in `CasFamily` / `LANE_RECORD_STORE`. A
 *   made-up family (pilot `LaneDoc`) would leave LD26 and the lane task's
 *   watch on the wrong document.
 * - PB5 (K3, C1): the pass no longer judges death itself. It reads the live
 *   lane tasks' records, asks `ports.lifecycle.decide` (the owner's
 *   `decideLifecycle`, with `enumerateLanes` liveness: pane or scope, not card
 *   age alone) and applies the actions. A second copy of the 30-minute rule,
 *   the idle cap or the reminder windows here would let the file tick and this
 *   one disagree. `park` stops the process through `ports.lane.park`, then
 *   writes `parked` on the record; `close` writes the terminal phase and the
 *   `terminal` stamp as the intent the lane task watches, and the lane task
 *   then stops the process (`closing`). The tick itself never stops a closing
 *   lane. `event`, `flag-dirty` and `tell-operator` become ledger events, with
 *   the reminder stamp written in the same commit, so each fires once.
 * - `tell-operator` has no ledger sink: Henry's outbox is outward-facing and its
 *   owner is not in the ledger. The line is a `TELL OPERATOR` event and nothing
 *   leaves the machine. `afterClose` lines wait for their close to be written.
 * - A lane whose record changed between the decision and the action (a report,
 *   a resume, a `muster close`) is skipped: each action re-reads the record
 *   and compares phase and `phaseSince` with what was decided on.
 * - runtime.ts crash points: `inside-tick-pass` and `tick-escape` stay the
 *   armed points; a new name would break PB4's fault rehearsal.
 * - spool replay: `onPass` appends then removes the file. A failure between
 *   the two replays the file on the next pass, and `appendEvent` dedupes by
 *   requestId, so the event exists once.
 * - daemon.ts: binds nothing. musterd replays the spool through the ports
 *   `open.ts` bound, so a spool file filed while musterd was down is replayed
 *   on the first pass after the restart.
 * - ensureTick (PB4): this module does not create a tick. A second creator
 *   here would race PB4 and could leave two live `muster.tick` tasks.
 * - deploy: live `musterd.service` leaves `MUSTER_LEDGER_TASKS` unset
 *   (PB-D3). `muster-tick.timer` is untouched until PB7.
 */

import type { Context } from "@earendil-works/chord";
import type { ConversationId, Harness, JsonObject, Tx } from "@earendil-works/pi-durable";
import { defineTask } from "@earendil-works/pi-durable";
import type { LaneRecord, LifecycleAction } from "../lane-lifecycle.ts";
import { runTickPass, type TickPassPorts } from "../tick.ts";
import { isTerminalPhase, liveLaneTasks } from "./lane-task.ts";
import { crashKill, crashThrowOnce } from "./runtime.ts";
import { CasFamily, MusterEvent, type CasDoc } from "./schema.ts";
import { LANE_RECORD_STORE } from "./stores.ts";
import type { TaskPorts } from "./task-ports.ts";

/** The task kind, as it appears in the task graph. */
export const TICK_TASK = "muster.tick";

/** 2 minutes, the same as `OnUnitActiveSec=2min`. */
export const TICK_INTERVAL_MS = 2 * 60 * 1000;

/** The tick's input: the pass interval the creator opened with. */
export type TickInput = { intervalMs: number };

/** The one phase, with the next due time and the pass counter. */
export type TickCheckpoint = { phase: "pass"; dueAt: number; passNo: number };

/** The tick never completes; the type only satisfies `defineTask`. */
export type TickResult = null;

export type TickBindings = {
	ports: TaskPorts;
	harness: Harness;
	/**
	 * OL4 (spec §10): the timer's whole pass, bound to the owner that is right for this process. The one
	 * binder is `registerMusterTasks` (task-ports.ts): the live bindings in `bin/muster-tick.mts`, with
	 * the ledger's own in-process spool replay. A fixture binds its own and never touches the machine.
	 */
	passPorts: TickPassPorts;
};

let bound: TickBindings | undefined;

/** Bind the ports and harness this process's tick calls. */
export function bindTickTaskPorts(bindings: TickBindings): void {
	bound = bindings;
}

function bindings(): TickBindings {
	if (bound === undefined) throw new Error("muster.tick has no ports bound");
	return bound;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function laneKey(laneId: string): string {
	return `${LANE_RECORD_STORE}:${laneId}`;
}

function asLaneRecord(doc: CasDoc | Readonly<CasDoc> | null | undefined): LaneRecord | undefined {
	if (doc === undefined || doc === null || doc.record === null) return undefined;
	const record = doc.record as unknown as Partial<LaneRecord>;
	if (typeof record.laneId !== "string" || typeof record.phase !== "string") return undefined;
	return record as LaneRecord;
}

/** The lane task checkpoints whose records the reconciler decides about. */
const DECIDED_PHASES: readonly string[] = ["live", "parked", "resuming"];

type Commit = (change: (tx: Tx) => Promise<undefined>, context: Context) => Promise<void>;

/** The record as the decision saw it: an action applies only while the record still reads the same. */
function unchanged(now: LaneRecord | undefined, decided: LaneRecord): now is LaneRecord {
	return now !== undefined && !isTerminalPhase(now.phase) && now.phase === decided.phase && now.phaseSince === decided.phaseSince;
}

function stamp(lane: LaneRecord, reminder: string | undefined, at: number): LaneRecord {
	return reminder === undefined ? lane : { ...lane, reminded: { ...lane.reminded, [reminder]: at } };
}

/** One lane's failure, or a failing step, as a `TICK ERROR` event. A report must not fail the pass. */
async function reportError(
	commit: (change: (tx: Tx) => Promise<undefined>, context: Context) => Promise<void>,
	conversationId: ConversationId,
	laneId: string | undefined,
	error: unknown,
	at: number,
	context: Context,
): Promise<void> {
	try {
		await commit(async (tx) => {
			await tx.appendEntry(MusterEvent, conversationId, {
				data: { type: "TICK ERROR", ...(laneId === undefined ? {} : { lane: laneId }), text: messageOf(error), at },
			});
			return undefined;
		}, context);
	} catch {
		// A failing report must not end the pass.
	}
}

/** The one phase: sleep to the due time, settle the lanes, replay the spool, commit the next pass. */
export const TickTask = defineTask<TickInput, TickCheckpoint, TickResult>({
	name: TICK_TASK,
	version: 1,
	initial: () => ({ phase: "pass", dueAt: 0, passNo: 0 }),
	phases: {
		pass: async (task, runtime, context) => {
			const { dueAt, passNo } = task.state.checkpoint;
			await runtime.sleep(dueAt, context);
			crashKill("inside-tick-pass");
			crashThrowOnce("tick-escape");
			const { ports, harness, passPorts } = bindings();
			const commit: Commit = (change, ctx) => runtime.commit(change, ctx);
			const fail = (laneId: string | undefined, error: unknown): Promise<void> =>
				reportError(commit, runtime.conversationId, laneId, error, runtime.now(), context);

			/** PB5's reconcile, unchanged: the ledger's own lane step, run inside the pass lock (OL4). */
			const reconcile = async (): Promise<void> => {
				// The records the decision reads: every live lane task that is live, parked or resuming.
				const records = new Map<string, LaneRecord>();
				for (const lane of await liveLaneTasks(harness, context)) {
					if (!DECIDED_PHASES.includes(lane.phase)) continue;
					try {
						const record = asLaneRecord(await runtime.snapshot(CasFamily, laneKey(lane.laneId), context));
						if (record !== undefined && !isTerminalPhase(record.phase)) records.set(lane.laneId, record);
					} catch (error) {
						await fail(lane.laneId, error);
					}
				}
				let actions: LifecycleAction[] = [];
				try {
					actions = await ports.lifecycle.decide(records, runtime.now());
				} catch (error) {
					await fail(undefined, error);
				}
				/** Lanes whose close was written in this pass: an `afterClose` line follows only these. */
				const closed = new Set<string>();
				for (const action of actions) {
					const decided = records.get(action.lane);
					if (decided === undefined) continue;
					try {
						const current = async (): Promise<LaneRecord | undefined> => {
							const record = asLaneRecord(await runtime.snapshot(CasFamily, laneKey(action.lane), context));
							return unchanged(record, decided) ? record : undefined;
						};
						/** Write the record and append events in one commit, only while the record still reads as decided. */
						const apply = async (change: (lane: LaneRecord, at: number) => { record?: LaneRecord; events: Array<{ type: string; text: string }> }): Promise<boolean> => {
							const written: { record?: LaneRecord } = {};
							await runtime.commit(async (tx) => {
								const doc = await tx.doc(CasFamily, laneKey(action.lane), { store: LANE_RECORD_STORE, id: action.lane });
								const lane = asLaneRecord(doc);
								// K2: the record is re-read inside the transaction; a terminal one is final.
								if (!unchanged(lane, decided)) return undefined;
								const at = runtime.now();
								const result = change(lane, at);
								if (result.record !== undefined) {
									doc.record = result.record as unknown as JsonObject;
									doc.revision += 1;
								}
								for (const event of result.events) {
									await tx.appendEntry(MusterEvent, runtime.conversationId, { data: { type: event.type, lane: action.lane, text: event.text, at } });
								}
								written.record = result.record ?? lane;
								return undefined;
							}, context);
							// A later action for this lane in the same list (a park, then its reminder) decides on what this wrote.
							if (written.record !== undefined) records.set(action.lane, written.record);
							return written.record !== undefined;
						};
						if (action.kind === "park") {
							// The process stops first and the record second: a death between the two is a lane the next pass parks again.
							if ((await current()) === undefined) continue;
							await ports.lane.park(decided);
							await apply((lane, at) => ({ record: { ...lane, phase: "parked", phaseSince: at, parkedAt: at }, events: [] }));
						} else if (action.kind === "close") {
							const written = await apply((lane, at) => ({
								record: { ...lane, phase: action.outcome, phaseSince: at, terminal: { outcome: action.outcome, reason: action.reason, sha: action.sha, at } },
								events: action.outcome === "abandoned" ? [{ type: "ABANDONED", text: action.reason }] : [],
							}));
							if (written) closed.add(action.lane);
						} else if (action.kind === "event") {
							await apply((lane, at) => ({ record: stamp(lane, action.reminder, at), events: [{ type: "STALLED", text: action.detail }] }));
						} else if (action.kind === "flag-dirty") {
							await apply((lane, at) => ({ record: stamp(lane, action.reminder, at), events: [{ type: "STALLED", text: `${action.lane} has uncommitted changes in its worktree; not stopped` }] }));
						} else if (action.kind === "tell-operator") {
							if (action.afterClose === true && !closed.has(action.lane)) continue;
							// After a close the record is terminal, so this line is not tied to the record as decided.
							await runtime.commit(async (tx) => {
								const at = runtime.now();
								await tx.appendEntry(MusterEvent, runtime.conversationId, { data: { type: "TELL OPERATOR", lane: action.lane, text: action.text, at } });
								return undefined;
							}, context);
						}
					} catch (error) {
						await fail(action.lane, error);
					}
				}
			};

			// OL4 (spec §10): the one pass owner, `runTickPass`, and the lock inside it decide which owner
			// acts. The pass's error lines are also ledger events through this task's own reporter, so a
			// step that failed is in the record, not only in the journal.
			const reported: string[] = [];
			await runTickPass({
				...passPorts,
				reconcile,
				err: (line) => {
					reported.push(line);
					passPorts.err(line);
				},
			});
			if (reported.length > 0) await fail(undefined, reported.join("; "));
			await runtime.commit(
				() => ({
					status: "running",
					checkpoint: {
						phase: "pass",
						dueAt: Math.max(runtime.now(), dueAt) + task.input.intervalMs,
						passNo: passNo + 1,
					},
				}),
				context,
			);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});
