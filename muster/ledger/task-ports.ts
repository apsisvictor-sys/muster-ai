/**
 * In-process ports the ledger tasks call (PB1, PB-D2). They wrap `methods.ts`
 * and today's launch/close owners. They never call `requestSync`, so they stay
 * usable inside `musterd` where the socket is this process.
 *
 * Impact map for PB5 (VR22-30):
 * - lane-lifecycle.ts `decideLifecycle`: `lifecycle.decide` is the only caller
 *   in the ledger tasks. It passes the owner's own inputs (`enumerateLanes`
 *   rows, the protected-lanes file, `seatHolderLanes`) and forks nothing, so the
 *   30-minute rule, the idle cap and the reminders stay in the owner. A copy of
 *   them here would let the file tick and the ledger tick disagree.
 * - lib/lane-directory.ts `enumerateLanes`: the rows and `alive` come from
 *   here (tmux pane, `claude agents` pid, lane scope). It reads tmux,
 *   systemctl and `claude agents` with blocking calls (about 1 s), and musterd
 *   carries every send on the same event loop. So the rows are read in one
 *   place, `directoryRows`: `decide` always reads fresh (once per pass), and
 *   `alive` (polled every 2 s by each resuming lane) reuses the last rows
 *   while they are younger than `rowsMaxAgeMs` (30 s), after a cheap card
 *   check that needs no rows at all. The worst case is one blocking read per
 *   max age for the whole daemon, not one per lane per poll. A `resuming`
 *   lane sees its process up within one max age.
 * - `lane.alive` (C1): liveness is the row's `alive` (pane or scope) or a fresh
 *   card, never card age alone. A pane-alive lane whose card is 60 s old is
 *   alive. Card age alone read it as dead and the tick finished it `abandoned`.
 * - `lane.park` and `lane.stop`: both call `closeLaneLive`, the one stop owner
 *   (LD17 refusals included). A refusal throws, so a lane that was not stopped
 *   is never recorded as stopped. The one tolerated refusal is a record already
 *   `closed`: that is `muster close` having stopped it, and the task's own stop
 *   is the repeat.
 * - cli/resume.ts and send.ts: untouched. `parked` to `working` is
 *   `recordLaunch`'s (resume.ts:82); a send writes the inbox and the ASLEEP
 *   line, never the record.
 * - GitFacts: `liveGitFacts` (lib/git-facts.ts, moved out of
 *   bin/muster-tick.mts) is the one implementation, shared with the file tick.
 *   Its protections (GIT_OPTIONAL_LOCKS=0, the sha and ref checks,
 *   `refs/heads/<branch>`, the existsSync guard) come with it. An answer it
 *   cannot give is `undefined`, which the owner reads as "could not tell" and
 *   never stops or closes on.
 * - deploy: live `musterd.service` leaves `MUSTER_LEDGER_TASKS` unset, so none
 *   of this runs live. `muster-tick.timer` is untouched until PB7.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnyTask } from "@earendil-works/pi-durable";
import { musterStateDir } from "../binding.ts";
import { runLaunchScript } from "../gateway/launch.ts";
import { closeLaneLive } from "../lane-lifecycle-ports.ts";
import { decideLifecycle, readProtectedLanes, type GitFacts, type LaneRecord, type LifecycleAction } from "../lane-lifecycle.ts";
import { isCardGone, laneCardsDir, readLaneCard, type LaneCard } from "../lib/lane-card.ts";
import { liveGitFacts } from "../lib/git-facts.ts";
import { enumerateLanes, laneRegistryPath, type LaneDirectoryOptions } from "../lib/lane-directory.ts";
import { seatHolderLanes } from "../seats.ts";
import { liveTickPassPorts } from "../bin/muster-tick.mts";
import type { TickPassPorts } from "../tick.ts";
import { bindLaneTaskPorts, LaneTask } from "./lane-task.ts";
import { appendEvent, casList, casRead, casUpdate, commit, drain } from "./methods.ts";
import type { Ledger } from "./open.ts";
import { readSpool, removeSpoolFile } from "./spool.ts";
import { bindTickTaskPorts, TickTask } from "./tick-task.ts";

/** Launch, stop and liveness of one lane, wrapping today's owners. */
export type LanePorts = {
	launch(lane: LaneRecord): Promise<{ sessionId: string }>;
	stop(lane: LaneRecord): Promise<void>;
	/** Stop the process and keep the lane (`closeLaneLive` with `park: true`). */
	park(lane: LaneRecord): Promise<void>;
	alive(lane: LaneRecord): Promise<boolean>;
};

/** The reconciler's one read: what `decideLifecycle` says to do about these records, now. */
export type LifecyclePorts = {
	decide(records: ReadonlyMap<string, LaneRecord>, now: number): Promise<LifecycleAction[]>;
};

/** What a rehearsal replaces: the directory's evidence readers and the git facts. Live leaves both unset. */
export type TaskPortOptions = {
	directory?: Partial<LaneDirectoryOptions>;
	git?: GitFacts;
	/** How old the last directory rows may be when `alive` reuses them; default `ROWS_MAX_AGE_MS`. */
	rowsMaxAgeMs?: number;
};

/** The default age `alive` tolerates in the cached directory rows. */
export const ROWS_MAX_AGE_MS = 30_000;

/** Ledger reads and writes the tasks use instead of `requestSync`. */
export type ReconcilePorts = {
	casRead: typeof casRead extends (ledger: Ledger, p: infer P) => infer R ? (p: P) => R : never;
	casUpdate: typeof casUpdate extends (ledger: Ledger, p: infer P) => infer R ? (p: P) => R : never;
	casList: typeof casList extends (ledger: Ledger, p: infer P) => infer R ? (p: P) => R : never;
	commit: typeof commit extends (ledger: Ledger, p: infer P) => infer R ? (p: P) => R : never;
	drain: typeof drain extends (ledger: Ledger, p: infer P) => infer R ? (p: P) => R : never;
};

export type TaskPorts = {
	lane: LanePorts;
	lifecycle: LifecyclePorts;
	reconcile: ReconcilePorts;
	onPass: () => Promise<void>;
};

/**
 * The launcher moved with muster (OL12-D8): it sits in this package's own
 * `scripts/` folder, found beside this file rather than through the Pi profile
 * (S10's own-package rule).
 */
function launchScript(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "pi-lane-launch.sh");
}

/**
 * Ports bound to one open ledger. `lane` calls `runLaunchScript` and
 * `closeLaneLive`; `reconcile` calls `methods.ts`; `onPass` replays the spool
 * through `appendEvent`.
 */
export function createTaskPorts(ledger: Ledger, options: TaskPortOptions = {}): TaskPorts {
	const readDirectory = (): LaneCard[] =>
		enumerateLanes({ laneCardsDir: laneCardsDir(ledger.dir), laneRegistryPath: laneRegistryPath(ledger.dir), ...options.directory });
	const rowsMaxAgeMs = options.rowsMaxAgeMs ?? ROWS_MAX_AGE_MS;
	let last: { at: number; rows: LaneCard[] } | undefined;
	/** The directory rows no older than `maxAgeMs`; a read refreshes the rows every caller shares. */
	const directoryRows = (maxAgeMs: number): LaneCard[] => {
		const now = Date.now();
		if (last !== undefined && now - last.at < maxAgeMs) return last.rows;
		last = { at: now, rows: readDirectory() };
		return last.rows;
	};
	const facts = options.git ?? liveGitFacts;
	return {
		lane: {
			async launch(lane: LaneRecord): Promise<{ sessionId: string }> {
				if (lane.cwd === null) throw new Error(`lane ${lane.laneId} has no cwd to launch in`);
				const args = [
					"--lane",
					lane.laneId,
					"--harness",
					lane.harness,
					"--cwd",
					lane.cwd,
					"--no-attach",
					"--launched-by",
					lane.launchedBy,
					...(lane.sessionId === undefined ? [] : ["--session", lane.sessionId]),
					...(lane.repoRoot === undefined ? [] : ["--repo-root", lane.repoRoot]),
				];
				const result = await runLaunchScript(launchScript(), args);
				if (!result.ok) throw new Error(result.detail);
				return { sessionId: lane.sessionId ?? result.detail };
			},
			async stop(lane: LaneRecord): Promise<void> {
				const result = await closeLaneLive(ledger.dir, lane.laneId, { park: false, caller: "musterd" });
				// `closed` is `muster close` having stopped it already: this stop is the repeat. Any other
				// phase that was not stopped must not end the task.
				if (!result.ok && lane.phase !== "closed") throw new Error(result.detail);
			},
			async park(lane: LaneRecord): Promise<void> {
				const result = await closeLaneLive(ledger.dir, lane.laneId, { park: true, caller: "musterd" });
				if (!result.ok) throw new Error(result.detail);
			},
			async alive(lane: LaneRecord): Promise<boolean> {
				// A fresh card needs no machine read. Pane or scope evidence comes from the shared rows.
				const card = readLaneCard(ledger.dir, lane.laneId);
				if (card !== undefined && card.state !== "gone" && !isCardGone(card.updatedAt, Date.now())) return true;
				return directoryRows(rowsMaxAgeMs).find((row) => row.laneId === lane.laneId)?.alive === true;
			},
		},
		lifecycle: {
			async decide(records, now): Promise<LifecycleAction[]> {
				const seatLanes = seatHolderLanes({ stateDir: ledger.dir });
				const protectedLanes = readProtectedLanes(ledger.dir).lanes;
				return decideLifecycle(directoryRows(0), records, facts, now, { protectedLanes, seatLanes });
			},
		},
		reconcile: {
			casRead: (p) => casRead(ledger, p),
			casUpdate: (p) => casUpdate(ledger, p),
			casList: (p) => casList(ledger, p),
			commit: (p) => commit(ledger, p),
			drain: (p) => drain(ledger, p),
		},
		async onPass(): Promise<void> {
			for (const { path, req } of readSpool(ledger.dir)) {
				if (req.method !== "appendEvent") continue;
				await appendEvent(ledger, req.params as Parameters<typeof appendEvent>[1]);
				removeSpoolFile(path);
			}
		},
	};
}

/**
 * The Muster task definitions. `open.ts` declares them on the extension before
 * `registry.install` when `MUSTER_LEDGER_TASKS=1`: the registry takes tasks at
 * install only.
 */
export function musterTaskDefinitions(): readonly AnyTask[] {
	return [TickTask, LaneTask];
}

/**
 * The one place the tasks' ports are bound. `open.ts` calls it when
 * `MUSTER_LEDGER_TASKS=1`, before `harness.resume()`, so a task resumed past its
 * due time finds its ports. Nothing else binds them (not `daemon.ts`).
 *
 * OL4 (spec §10): the tick's pass is the timer's whole `main()` sequence, bound here to the live steps in
 * `bin/muster-tick.mts` over the ledger's own directory. Two steps this process binds differently: the
 * spool replay is beside the store (`ports.onPass`), because `ledger/boundary.replaySpool` calls
 * `requestSync`, which refuses inside `musterd` (LC-D4); and a failing step sets no exit code, because
 * there is no per-pass process here to exit. The step's line still reaches the journal, and the pass's
 * error lines become `TICK ERROR` events through this task's own reporter. A fixture passes its own
 * `tickPass`, so no ledger test can read the machine's state dir or take its lock.
 */
export function registerMusterTasks(ledger: Ledger, ports: TaskPorts, options: { tickPass?: TickPassPorts } = {}): void {
	bindLaneTaskPorts(ports.lane);
	const pass = options.tickPass ?? liveTickPassPorts(ledger.dir, { replaySpool: () => ports.onPass(), fail: () => {} });
	// The spool replay belongs to this process, not to the caller: beside the store it is `onPass`, never
	// `ledger/boundary.replaySpool`, which calls `requestSync` and refuses inside `musterd` (LC-D4).
	bindTickTaskPorts({ ports, harness: ledger.harness, passPorts: { ...pass, replaySpool: () => ports.onPass() } });
}
