/**
 * `openLedger(dir)` is the one way to open the Muster ledger: a Durable Pi
 * `Harness` over the ledger's SQLite storage, with an empty model registry and
 * the Muster extension, which declares no task unless `MUSTER_LEDGER_TASKS=1`
 * (DL2, PB-D3: the live service leaves that flag unset, so phase A stays inert).
 * Durable Pi is imported only under `extensions/muster/ledger/` (DL4); this is
 * the only module that opens it.
 *
 * `ensureTick` (PB4) is the one creator of `muster.tick`. `keepTick` runs it at
 * daemon start and again whenever the tick it holds settles.
 *
 * Impact map (VR22-30):
 * - tick-task.ts: this module creates the task and never edits it. A tick that
 *   escapes its catch ends `faulted` and Durable Pi never reruns a terminal
 *   task, so without a replacement the ledger would have no tick until the next
 *   restart. A second creator elsewhere (a test helper is the only one) could
 *   leave two live ticks.
 * - schema.ts `MetaFamily["tick"]`: the live tick's id lives in the same commit
 *   as the task, so the id and the task cannot disagree. A crash between a fault
 *   and its replacement leaves the terminal id, and the next start appends the
 *   `TICK FAULTED` event then.
 * - daemon.ts: the only production caller of `openLedger` (C3) and so of
 *   `keepTick`. `stop()` closes the ledger, and `close()` ends the keeper first:
 *   the keeper checks `stopped` before each `ensureTick`, so a close starts no new
 *   one (a call already in flight finishes before the Harness closes).
 * - MUSTER_LEDGER_TASKS (PB-D3): `keepTick` returns at once when the flag is
 *   unset, so the live unit creates no task and no meta record. With the flag
 *   unset a stored tick has no definition; the scheduler leaves it blocked, so
 *   it neither faults nor is replaced (C4), and a restart with the flag set
 *   resumes the same task.
 * - runtime.ts crash point `tick-escape`: throws once per process, so the first
 *   tick faults and the replacement runs.
 * - a tick that faults on every pass (F1): the wait before each replacement doubles
 *   from `TICK_REPLACE_DELAY_MS` up to the tick interval and resets after a tick
 *   lives a full interval, so a persistent fault (a locked database, a full disk)
 *   writes at most one task and one `TICK FAULTED` event per interval, the old
 *   timer's rate, and does not flood the orchestrator's waiter.
 * - `doc.tickId` is re-read inside the creating commit (F2), so a tick that
 *   appeared since the outside read is returned, not duplicated.
 * - deploy: live `musterd.service` leaves the flag unset and `muster-tick.timer`
 *   stays enabled until PB7.
 */

import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import type { Conversation, Harness, Storage, TaskId } from "@earendil-works/pi-durable";
import { createRegistry, defineExtension, Harness as DurableHarness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { musterStateDir } from "../binding.ts";
import type { TickPassPorts } from "../tick.ts";
import { META_TICK_KEY, MetaFamily, MusterEvent } from "./schema.ts";
import { createTaskPorts, musterTaskDefinitions, registerMusterTasks } from "./task-ports.ts";
import { TICK_INTERVAL_MS, TickTask } from "./tick-task.ts";

const ctx = BACKGROUND_CONTEXT;

/**
 * The directory the ledger lives in: `<musterStateDir>/ledger.sqlite`,
 * `<musterStateDir>/ledger.sock` and the spool `<musterStateDir>/spool/`.
 * `MUSTER_LEDGER_DIR` overrides it for the tests and the rehearsal.
 */
export function ledgerDir(): string {
	const override = process.env.MUSTER_LEDGER_DIR?.trim();
	return override ? override : musterStateDir();
}

/** The open ledger: the Harness, its root conversation, and the way to close it. */
export type Ledger = {
	harness: Harness;
	root: Conversation;
	/**
	 * The one storage handle this process owns. The Session exposes no
	 * document-family scan, so a family list reads its incarnation records through
	 * this handle; the daemon is the storage's single writer.
	 */
	storage: Storage;
	/** Directory this ledger was opened under (sqlite, socket, spool). */
	dir: string;
	close(): Promise<void>;
};

export type OpenLedgerOptions = {
	/** The Harness clock, injectable so a test can move time. Defaults to `Date.now`. */
	now?: () => number;
	/**
	 * OL4 (spec §10): the pass the durable task runs, for a fixture that must not touch the machine. Live
	 * leaves it unset, so `registerMusterTasks` binds the tick's own live ports over `ledger.dir`.
	 */
	tickPass?: TickPassPorts;
};

/** Lab daemons set this so `openLedger` can register tasks; the live unit does not. */
export const MUSTER_LEDGER_TASKS = "MUSTER_LEDGER_TASKS";

function ledgerTasksEnabled(): boolean {
	return process.env[MUSTER_LEDGER_TASKS] === "1";
}

/**
 * The Muster extension. It declares the tick and lane tasks only when
 * `MUSTER_LEDGER_TASKS=1`, because the registry takes tasks at install.
 */
function musterExtension() {
	return defineExtension({
		name: "muster",
		...(ledgerTasksEnabled() ? { tasks: musterTaskDefinitions() } : {}),
	});
}

/**
 * Open the ledger under `dir` (the ledger directory by default), creating
 * `dir/ledger.sqlite` when absent.
 *
 * The registry holds no model provider: the ledger runs no agent (DL2). The
 * root conversation is created on first use.
 */
export async function openLedger(dir: string = ledgerDir(), options: OpenLedgerOptions = {}): Promise<Ledger> {
	const storage = await openNodeSqliteStorage(join(dir, "ledger.sqlite"));
	const registry = createRegistry();
	const extension = musterExtension();
	registry.install(extension);
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
			await tickKeepers.get(ledger)?.();
			await harness.close(ctx);
		},
	};
	if (ledgerTasksEnabled()) {
		registerMusterTasks(ledger, createTaskPorts(ledger), options.tickPass === undefined ? {} : { tickPass: options.tickPass });
	}
	harness.resume();
	return ledger;
}

/** First wait between a tick settling and its replacement; it doubles per consecutive fault (`nextReplaceDelay`). */
export const TICK_REPLACE_DELAY_MS = 1000;

/**
 * The wait before the next replacement and the fault count to carry on with (F1). The wait doubles
 * with each consecutive fault from `baseMs` up to the tick interval, and the count resets once a
 * tick has lived a full interval. A persistent fault so costs at most one task and one `TICK FAULTED`
 * event per interval, the rate of the 2-minute timer this replaces.
 */
export function nextReplaceDelay(
	faults: number,
	livedMs: number,
	intervalMs: number,
	baseMs: number = TICK_REPLACE_DELAY_MS,
): { waitMs: number; faults: number } {
	const carried = livedMs >= intervalMs ? 0 : faults;
	return { waitMs: Math.min(intervalMs, baseMs * 2 ** carried), faults: carried + 1 };
}

/** Ends one ledger's tick keeper; `close()` runs it before the Harness closes. */
const tickKeepers = new WeakMap<Ledger, () => Promise<void>>();

/** Calls to `ensureTick` on one ledger run one at a time. */
const ensuring = new WeakMap<Ledger, Promise<unknown>>();

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function ensureTickOnce(ledger: Ledger, intervalMs: number): Promise<TaskId<null>> {
	const meta = await ledger.harness.snapshot(MetaFamily, META_TICK_KEY, ctx);
	const knownId = meta?.tickId ?? null;
	const known = knownId === null ? undefined : await ledger.harness.getTask(Number(knownId) as unknown as TaskId<null>, ctx);
	if (known !== undefined && known.state.status !== "terminal") return known.id;
	return ledger.root.commit(async (tx) => {
		const doc = await tx.doc(MetaFamily, META_TICK_KEY, { key: META_TICK_KEY });
		// F2: the id was read outside this transaction. If it moved meanwhile, that tick is the live one.
		if ((doc.tickId ?? null) !== knownId) return Number(doc.tickId) as unknown as TaskId<null>;
		if (known !== undefined && known.state.status === "terminal") {
			const { outcome } = known.state;
			const detail = outcome.error?.message ?? outcome.reason;
			await tx.appendEntry(MusterEvent, ledger.root.id, {
				data: {
					type: "TICK FAULTED",
					text: detail === undefined ? outcome.status : `${outcome.status}: ${detail}`,
					at: Date.now(),
				},
			});
		}
		const id = await tx.createTask(TickTask, { intervalMs }, { ownership: { kind: "conversation" }, background: true });
		doc.tickId = String(id); // `MetaDoc.tickId` is a string; a TaskId is a number
		return id;
	}, ctx);
}

/**
 * The id of the one live `muster.tick`, created when none is live. A tick that
 * ended (`faulted`, or any terminal outcome) is recorded as `TICK FAULTED` in the
 * same commit that creates its replacement. Needs the task definitions, so the
 * ledger must have been opened with `MUSTER_LEDGER_TASKS=1`.
 */
export function ensureTick(ledger: Ledger, intervalMs: number = TICK_INTERVAL_MS): Promise<TaskId<null>> {
	const next = (ensuring.get(ledger) ?? Promise.resolve())
		.catch(() => undefined)
		.then(() => ensureTickOnce(ledger, intervalMs));
	ensuring.set(ledger, next);
	return next;
}

/**
 * Keep one tick alive for the life of `ledger`: ensure it now, then again each time
 * the tick settles. Resolves after the first `ensureTick`. Does nothing when tasks
 * are off (PB-D3). `ledger.close()` ends it first and waits for an `ensureTick` already in flight.
 */
export async function keepTick(
	ledger: Ledger,
	intervalMs: number = TICK_INTERVAL_MS,
	options: { replaceDelayMs?: number } = {},
): Promise<void> {
	if (!ledgerTasksEnabled()) return;
	const { context, cancel } = withCancel(ctx);
	let stopped = false;
	let current: TaskId<null> | undefined;
	try {
		current = await ensureTick(ledger, intervalMs);
	} catch (error) {
		process.stderr.write(`musterd: the first ensureTick failed (${messageOf(error)}); retrying\n`);
	}
	const loop = (async (): Promise<void> => {
		let faults = 0;
		while (!stopped) {
			let startedAt = Date.now();
			try {
				if (current === undefined) {
					if (stopped) return; // F4: a close that began during the last wait creates no tick
					current = await ensureTick(ledger, intervalMs);
					startedAt = Date.now();
				}
			} catch (error) {
				if (stopped) return;
				process.stderr.write(`musterd: ensureTick failed (${messageOf(error)}); retrying\n`);
				await delay(options.replaceDelayMs ?? TICK_REPLACE_DELAY_MS, undefined, { signal: context.abortSignal }).catch(() => undefined);
				continue;
			}
			try {
				const settled = await ledger.harness.waitForTask(current, context);
				// F3: a tick that ended is the keeper's normal work, logged apart from a failure to ensure one.
				const next = nextReplaceDelay(faults, Date.now() - startedAt, intervalMs, options.replaceDelayMs);
				faults = next.faults;
				process.stderr.write(`musterd: muster.tick settled (${settled.state.outcome.status}); replacing in ${next.waitMs} ms\n`);
				current = undefined;
				await delay(next.waitMs, undefined, { signal: context.abortSignal });
			} catch (error) {
				if (stopped) return;
				current = undefined;
				process.stderr.write(`musterd: waiting for muster.tick failed (${messageOf(error)}); retrying\n`);
				await delay(options.replaceDelayMs ?? TICK_REPLACE_DELAY_MS, undefined, { signal: context.abortSignal }).catch(() => undefined);
			}
		}
	})();
	tickKeepers.set(ledger, async () => {
		stopped = true;
		cancel();
		await loop;
	});
}
