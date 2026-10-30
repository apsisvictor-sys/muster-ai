/**
 * `muster wait [--timeout <s>]` — wait until something needs the caller.
 *
 * Two readers, one command:
 *   --lanes   the lane cards (check 4): returns on a lane's REVIEW READY,
 *             BLOCKED or question report, or on a lane that stalled or went.
 *             No Concord, no pane text.
 *   --mailbox the Concord frontier (handoff, blocked task, open question, claim
 *             conflict, idle worker) — the original Muster loop in `wait.ts`.
 *   --inbox   an agent's inbox files (build 1 of the 06:19 brief): an agent
 *             whose harness has no Concord prompt endpoint, today the
 *             orchestrator. Returns on the first whole message, then the
 *             caller moves it into `read/`.
 *   --events  the ledger's `muster.event` entries (LC9): the same lines the
 *             events file carries, read after a cursor. orch-wait.sh uses it in
 *             ledger mode and keeps reading the file in files mode.
 *
 * Every reader follows the switch (`backend.json`): the inbox owner reads it on
 * every call, and this command re-reads it on every turn, so a waiter started
 * before a flip moves to the new store without a restart.
 *
 * It reads and reports; it starts nothing.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ConcordClient } from "../concord.ts";
import { readFrontierRoster } from "../frontier.ts";
import { listHerdrAgents, readHerdrContext } from "../herdr.ts";
import { enumerateLanes } from "../lib/lane-directory.ts";
import { piAgentDir } from "../../core/pi-ports.ts";
import { listInboxMessages, markInboxMessageRead } from "../lib/agent-inbox.ts";
import { musterStateDir } from "../binding.ts";
import { formatInboxWaitResult, waitOnInbox } from "../inbox-wait.ts";
import { findSessionProcess, removeWaiterPid, sessionProcessAlive, writeWaiterPid } from "../inbox-waiter.ts";
import { EVENT_KINDS, ORCHESTRATOR_ADDRESS, formatEventRecord } from "../lane-report.ts";
import { backendState, readBackend } from "../ledger/backend.ts";
import { MusterdUnreachable, createClient, type LedgerClient } from "../ledger/client.ts";
import { ownerLedgerSocket } from "../ledger/stores.ts";
import { formatLaneWaitResult, waitOnLaneCards } from "../lane-wait.ts";
import { clampWaitSeconds, formatWaitOutcome, runWait, WAIT_DEFAULT_SECONDS, WAIT_MAX_SECONDS, type WaitSnapshot } from "../wait.ts";
import { authorizeSeatInboxRead, SEAT_REFUSED_EXIT, seatContextFor } from "../seats.ts";
import { lanesCardsDir, lanesRegistryPath, lanesStateDir } from "./lanes.ts";
import { parseFlags, type CliCommand, type CliContext } from "./types.ts";

/** One row of the ledger's `events` method (`methods.ts`): the kind, the lane, the detail, the commit time and the entry id. */
type LedgerEventRow = { id: number; type: string; lane?: string; text: string; at: number };

/** The cursor file's record: the flip that produced the entry id, so a later flip never resumes at an older store's cursor. */
type LedgerCursor = { flipId: string; cursor: string };

function readLedgerCursor(file: string | undefined): LedgerCursor | undefined {
	if (file === undefined) return undefined;
	try {
		const [flipId, cursor] = readFileSync(file, "utf8").trim().split(/\s+/);
		return flipId === undefined || cursor === undefined || flipId === "" || cursor === "" ? undefined : { flipId, cursor };
	} catch {
		return undefined;
	}
}

function writeLedgerCursor(file: string | undefined, flipId: string, cursor: string): void {
	if (file === undefined) return;
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${flipId}\t${cursor}\n`, { mode: 0o600 });
	} catch {
		// The cursor is a convenience for the next run, not the record: a write that
		// fails re-reads the same batch, which is at least once.
	}
}

/**
 * A waiter's ledger connection (LC9): created only while the switch names the
 * ledger, so a waiter started before a flip picks it up on its next turn. A frame
 * only wakes it — the caller re-reads the store after every wake, because a frame
 * is a nudge and never the record.
 */
function createLedgerWake(
	stateDir: string,
	filter: { types: string[]; lanes?: string[] },
): { sleep: (ms: number) => Promise<void>; read: <T>(method: string, params: object) => Promise<T | undefined>; close: () => void } {
	let client: LedgerClient | undefined;
	let wake: (() => void) | undefined;
	let pending = false;
	const notify = (): void => {
		if (wake !== undefined) {
			const resolve = wake;
			wake = undefined;
			resolve();
		} else {
			pending = true;
		}
	};
	const ensure = (): LedgerClient | undefined => {
		if (client !== undefined) return client;
		if (readBackend(stateDir) !== "ledger") return undefined;
		client = createClient(ownerLedgerSocket(stateDir), { timeoutMs: 2000 });
		// The daemon's `subscribe` reads `lanes` beside `types` (LC9); the client
		// forwards the filter verbatim.
		client.subscribe(filter, notify);
		return client;
	};
	return {
		sleep: (ms) => new Promise<void>((resolve) => {
			ensure();
			if (pending) {
				pending = false;
				resolve();
				return;
			}
			const timer = setTimeout(() => {
				wake = undefined;
				resolve();
			}, Math.max(1, ms));
			wake = () => {
				clearTimeout(timer);
				resolve();
			};
		}),
		read: async <T>(method: string, params: object): Promise<T | undefined> => {
			const active = ensure();
			if (active === undefined) return undefined;
			try {
				return await active.request<T>(method, params);
			} catch (error) {
				// muster is down, or still restarting: the caller's poll tries again.
				if (error instanceof MusterdUnreachable) return undefined;
				throw error;
			}
		},
		close: () => client?.close(),
	};
}

/** Resolves when the signal aborts; used to leave a sleep on SIGINT/SIGTERM. */
function abortedLater(signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

/**
 * `muster wait --events [--after <cursor>]` (LC9): block until the ledger holds an
 * event after the cursor, print every one of them oldest first in the events-file
 * line format, and remember the new cursor. The cursor starts at `--after`, else at
 * the cursor file, else at `backend.json`'s `cursor`, so an imported event never
 * wakes a waiter. The backend is re-read on every turn: a waiter whose switch moves
 * leaves the ledger to the reader of the new store.
 */
async function runEventsWait(
	ctx: CliContext,
	options: { timeoutSeconds: number; after: string | undefined; cursorFile: string | undefined },
): Promise<number> {
	const stateDir = musterStateDir();
	const started = backendState(stateDir);
	if (started.backend !== "ledger") {
		ctx.io.err("muster wait: --events reads the ledger, and the switch names files; in files mode the waiter reads the events file");
		return 4;
	}
	const stored = readLedgerCursor(options.cursorFile);
	let flipId = started.flipId;
	let cursor = options.after ?? (stored !== undefined && stored.flipId === flipId ? stored.cursor : started.cursor);
	const pollMs = Math.max(20, Number(ctx.env["PI_MUSTER_WAIT_POLL_MS"]) || 2_000);
	const finishedAt = Date.now() + options.timeoutSeconds * 1000;
	const wake = createLedgerWake(stateDir, { types: [...EVENT_KINDS] });
	const controller = new AbortController();
	const onSignal = (): void => controller.abort();
	// One abort promise for the whole wait: a listener per loop turn would pile up over an hour-long wait.
	const abortWait = abortedLater(controller.signal);
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	try {
		// Subscribed before the first read, and the cursor file written before it too:
		// an event committed in between is still read by the first read, never missed,
		// and the file's appearance is the waiter's armed signal.
		writeLedgerCursor(options.cursorFile, flipId, cursor);
		for (;;) {
			const live = backendState(stateDir);
			const liveBackend = live.backend === "frozen" ? live.from : live.backend;
			if (liveBackend !== "ledger") return 4;
			if (live.backend === "ledger" && live.flipId !== flipId) {
				// A new flip has its own imported prefix: resume from its cursor.
				flipId = live.flipId;
				cursor = live.cursor;
				writeLedgerCursor(options.cursorFile, flipId, cursor);
			}
			const rows = await wake.read<LedgerEventRow[]>("events", cursor === "" ? {} : { after: cursor });
			if (rows !== undefined && rows.length > 0) {
				cursor = String(rows[rows.length - 1]!.id);
				writeLedgerCursor(options.cursorFile, flipId, cursor);
				if (ctx.json) {
					ctx.io.out(JSON.stringify({ events: rows.map((row) => ({ ...row, line: formatEventRecord(row) })), cursor }, null, 2));
				} else {
					for (const row of rows) ctx.io.out(formatEventRecord(row));
				}
				return 0;
			}
			if (controller.signal.aborted) return 130;
			const remaining = finishedAt - Date.now();
			if (remaining <= 0) return 4;
			await Promise.race([wake.sleep(Math.min(pollMs, remaining)), abortWait]);
		}
	} finally {
		wake.close();
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	}
}

export const command: CliCommand = {
	name: "wait",
	summary: "Wait for the first thing that needs the caller",
	usage: [
		`muster wait --lanes [--lane <id>]... [--timeout <seconds>] [--json]`,
		`muster wait --mailbox <agent-id> [--timeout <seconds>] [--json]`,
		`muster wait --inbox <agent-id> [--timeout <seconds>] [--json]`,
		`muster wait --events [--after <cursor>] [--cursor-file <path>] [--timeout <seconds>] [--json]`,
		`  timeout: 1 to ${WAIT_MAX_SECONDS} seconds, default ${WAIT_DEFAULT_SECONDS}; --inbox also takes 0, which waits with no timeout`,
		"  --lanes waits on the lane cards (a lane report, a stall, a gone lane)",
		"  --mailbox waits on the Concord frontier (handoff, blocked task, question)",
		"  --inbox waits on an agent's inbox files (an agent with no Concord prompt endpoint); it exits on the first message and keeps",
		"          state/muster/waiters/<agent>.pid while it runs. A Claude lane runs it in the background so a message wakes it.",
		"          It follows the claude or pi process it was armed from: when that is gone it exits 0 and leaves the message in the inbox.",
		"  --events waits on the ledger's event entries (ledger mode only) and prints the",
		"          events-file line format; --after starts at a given entry id, --cursor-file",
		"          keeps the last one it printed, and with neither it starts at backend.json's cursor.",
	].join("\n"),
	async run(ctx) {
		const parsed = parseFlags(ctx.argv, ["timeout", "mailbox", "inbox", "lane", "after", "cursor-file"]);
		const laneFilter = parsed.multi.get("lane") ?? [];
		const inboxAgent = (parsed.values.get("inbox") ?? "").trim();
		const inboxMode = !parsed.flags.has("lanes") && laneFilter.length === 0 && inboxAgent !== "";
		const eventsMode = parsed.flags.has("events");
		const requestedTimeout = parsed.values.get("timeout") === undefined ? undefined : Number(parsed.values.get("timeout"));
		if (requestedTimeout === 0 && !inboxMode) {
			ctx.io.err(`muster wait: --timeout 0 (no timeout) is for --inbox only; --lanes, --mailbox and --events take 1 to ${WAIT_MAX_SECONDS} seconds`);
			return 2;
		}
		const timeoutSeconds = clampWaitSeconds(requestedTimeout, { allowNoTimeout: inboxMode });
		if (eventsMode) {
			if (parsed.flags.has("lanes") || laneFilter.length > 0 || inboxAgent !== "" || parsed.values.get("mailbox") !== undefined) {
				ctx.io.err("muster wait: --events is its own reader; it cannot be combined with --lanes, --inbox or --mailbox");
				return 2;
			}
			return await runEventsWait(ctx, {
				timeoutSeconds,
				after: parsed.values.get("after"),
				cursorFile: parsed.values.get("cursor-file"),
			});
		}
		if (parsed.flags.has("lanes") || laneFilter.length > 0) {
			const controller = new AbortController();
			const onSignal = (): void => controller.abort();
			process.once("SIGINT", onSignal);
			process.once("SIGTERM", onSignal);
			try {
				const read = (): ReturnType<typeof enumerateLanes> => enumerateLanes({
					...(ctx.env["HOME"] !== undefined ? { home: ctx.env["HOME"] } : {}),
					laneCardsDir: lanesCardsDir(ctx.env),
					laneRegistryPath: lanesRegistryPath(ctx.env),
					includeUnregisteredSessions: true,
				});
				const result = await waitOnLaneCards({
					read,
					timeoutMs: timeoutSeconds * 1000,
					// 0 returns after the first read: a watcher checking the board.
					pollMs: Math.max(50, Number(ctx.env["PI_MUSTER_WAIT_POLL_MS"]) || 2_000),
					...(laneFilter.length > 0 ? { laneIds: laneFilter } : {}),
					signal: controller.signal,
				});
				if (ctx.json) ctx.io.out(JSON.stringify(result, null, 2));
				else ctx.io.out(formatLaneWaitResult(result));
				return result.events.length > 0 ? 0 : 4;
			} finally {
				process.off("SIGINT", onSignal);
				process.off("SIGTERM", onSignal);
			}
		}
		if (inboxAgent !== "") {
			// A seat inbox is read only by the holder (LD23); the operator's own shell is not asked.
			const seat = authorizeSeatInboxRead(inboxAgent, ctx.env, seatContextFor(ctx.env));
			if (!seat.allowed) {
				ctx.io.err(`muster wait: ${seat.message}`);
				return SEAT_REFUSED_EXIT;
			}
			const stateDir = lanesStateDir(ctx.env);
			const controller = new AbortController();
			const onSignal = (): void => controller.abort();
			process.once("SIGINT", onSignal);
			process.once("SIGTERM", onSignal);
			// N4: with no expiry the wait outlives a session the daemon retires. It follows the claude or pi process
			// it was armed from (found before the pid file, so a session that dies right after arming is still seen), and a message it finds after that process is gone stays in inbox/ unread.
			const session = findSessionProcess();
			// The pid file tells the Stop hook and `muster send` that this lane can be woken (WP9).
			let armed = false;
			try {
				writeWaiterPid(stateDir, inboxAgent);
				armed = true;
			} catch (error) {
				ctx.io.err(`muster wait: the waiter pid file for ${inboxAgent} could not be written (${error instanceof Error ? error.message : String(error)}); the wait goes on`);
			}
			let sessionGone = false;
			const pollMs = Math.max(20, Number(ctx.env["PI_MUSTER_WAIT_POLL_MS"]) || 2_000);
			// LC9: in ledger mode a `SENT` frame for this address wakes the sleep at
			// once; the poll below stays the fallback while the subscription is down.
			const ledgerWake = createLedgerWake(stateDir, { types: ["SENT"], lanes: [inboxAgent] });
			const watch = session === undefined ? undefined : setInterval(() => {
				if (!sessionProcessAlive(session)) {
					sessionGone = true;
					controller.abort();
				}
			}, pollMs);
			try {
				const result = await waitOnInbox({
					agent: inboxAgent,
					read: () => listInboxMessages(stateDir, inboxAgent),
					// 0 seconds is no timeout (LD18): the wait ends on a message or with its process.
					timeoutMs: timeoutSeconds === 0 ? Number.POSITIVE_INFINITY : timeoutSeconds * 1000,
					pollMs,
					sleep: (ms) => ledgerWake.sleep(ms),
					signal: controller.signal,
				});
				if (sessionGone || (session !== undefined && !sessionProcessAlive(session))) {
					ctx.io.err(`muster wait: the session that armed this wait (pid ${session?.pid}) is gone; ${result.messages.length} message(s) stay in ${inboxAgent}'s inbox`);
					return 0;
				}
				// Print first, move after: a reader that dies in between leaves the
				// message pending, so it is delivered again rather than lost.
				if (ctx.json) ctx.io.out(JSON.stringify(result, null, 2));
				else ctx.io.out(formatInboxWaitResult(result, { laneDelivery: inboxAgent !== ORCHESTRATOR_ADDRESS }));
				let moved = 0;
				for (const message of result.messages) {
					if (markInboxMessageRead(stateDir, inboxAgent, message.id)) moved += 1;
				}
				if (result.messages.length > 0 && moved === 0) {
					ctx.io.err(`muster wait: ${result.messages.length} inbox message(s) for ${inboxAgent} could not be moved into read/; they stay pending`);
					return 1;
				}
				if (result.aborted) return 130;
				return result.messages.length > 0 ? 0 : 4;
			} finally {
				ledgerWake.close();
				if (watch !== undefined) clearInterval(watch);
				if (armed) removeWaiterPid(stateDir, inboxAgent);
				process.off("SIGINT", onSignal);
				process.off("SIGTERM", onSignal);
			}
		}
		const mailbox = (parsed.values.get("mailbox") ?? ctx.agentId ?? "").trim();
		if (mailbox === "") {
			ctx.io.err("muster wait: no mailbox: pass --mailbox <agent-id>, --inbox <agent-id>, or --lanes to wait on the lane cards");
			return 2;
		}
		const identity = ctx.agentId ?? mailbox;
		const client = await ConcordClient.connect({
			launcherMcp: join(piAgentDir(), "extensions", "muster", "launchers", "concord-mcp"),
			repoRoot: ctx.repoRoot,
			agentId: identity,
			cwd: ctx.cwd,
		}).catch((error: unknown) => {
			ctx.io.err(`muster wait: Concord is not reachable (${error instanceof Error ? error.message : String(error)}); nothing can be read safely`);
			return undefined;
		});
		if (client === undefined) return 1;

		const controller = new AbortController();
		const onSignal = (): void => controller.abort();
		process.once("SIGINT", onSignal);
		process.once("SIGTERM", onSignal);
		try {
			const read = async (): Promise<WaitSnapshot | undefined> => {
				const roster = await readFrontierRoster((name, args) => client.callTool(name, args, { timeoutMs: 5000 }));
				return { ...roster, agents: await listHerdrAgents(readHerdrContext(ctx.env)) };
			};
			const outcome = await runWait({
				read,
				mailbox,
				timeoutMs: timeoutSeconds * 1000,
				pollMs: Math.max(20, Number(ctx.env["PI_MUSTER_WAIT_POLL_MS"]) || 15_000),
				reportedIdle: new Set<string>(),
				signal: controller.signal,
			});
			if (ctx.json) ctx.io.out(JSON.stringify(outcome, null, 2));
			else ctx.io.out(formatWaitOutcome(outcome));
			if (outcome.aborted) return 130;
			if (outcome.events.length > 0) return 0;
			return outcome.unreadable ? 1 : 3;
		} finally {
			process.removeListener("SIGINT", onSignal);
			process.removeListener("SIGTERM", onSignal);
			await client.close().catch(() => undefined);
		}
	},
};
