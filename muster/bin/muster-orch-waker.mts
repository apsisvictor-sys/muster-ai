/**
 * `muster-orch-waker` — the long-lived orchestrator waker (WAKE1, Henry via the operator
 * 2026-10-29 03:29).
 *
 * Thin by design, like `muster-tick.mts`: the ladder (deliver, prove, retry, resume,
 * alert once) lives in `muster/orch-waker.ts`, and this file only supplies the machine
 * — the seat file, the inbox owner, the ledger's event stream, the send owner, the
 * lane directory's turn clock, the parked-lane resume and Henry's mailbox. Discord
 * is not among them: an outage alert reaches Henry and nobody else.
 *
 * It runs under the `muster-orch-waker` systemd user unit (`muster/systemd/`), which
 * restarts it (`Restart=always`) and is watched by the tick. It takes its own lock
 * (`orch-waker.pid`), so one machine has one waker: a second copy refuses to start, prints
 * one line naming the holder and exits 75. The retired waiter's slot stays the waiter's own,
 * and `orch-wait.sh` refuses to arm while the waker's lock names a live waker.
 *
 * It never claims or moves a seat, never touches a `operator:*` session and never starts
 * a second process for a live session: the only launch is the existing parked-lane
 * resume, which answers `not-parked` for a seat whose process is still there.
 *
 * Every wait here yields to the event loop (rev4's W1): the event read, the seat's turn
 * clock and the delivery are child processes the loop can interrupt, so systemd's stop is
 * seen at once - the process writes its `stopped` line, gives the lock back and ends inside
 * the unit's stop timeout, instead of being killed.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { configurePiPorts, musterLauncher } from "../../core/pi-ports.ts";
import { tellGrokbot } from "../grokbot-tell.ts";
import { listInboxMessages, markInboxMessageRead } from "../lib/agent-inbox.ts";
import { parkedLaneResume } from "../lane-lifecycle-ports.ts";
import { readBackend } from "../ledger/backend.ts";
import { readSeat } from "../seats.ts";
import { acquireWakerLock, WAKER_REFUSAL_EXIT } from "../waker-lock.ts";
import {
	runWakerLoop,
	WAKER_ACTOR,
	WAKER_STATE_FILE,
	type WakerDeps,
	type WakerInboxMessage,
	type WakerMarks,
	type WakerResume,
	type WakerSeat,
	type WakerTurn,
} from "../orch-waker.ts";

/** The Pi profile folder: what the unit states, else the documented default. Never derived from this file. */
function configureAgentDir(): string {
	const agentDir = process.env.PI_AGENT_HOME?.trim() || join(homedir(), ".pi", "agent");
	configurePiPorts({ agentDir });
	return agentDir;
}

/** `muster wait --events` prints these; every other line is not an event. */
function eventLines(stdout: string): string[] {
	return stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

/** How long a spawned CLI may run before it is killed: the wait's own timeout plus its boot. */
const CLI_GRACE_MS = 45_000;

function main(): void {
	const agentDir = configureAgentDir();
	const stateDir = process.env.PI_MUSTER_STATE_DIR?.trim() || join(agentDir, "state", "muster");
	const eventsFile = join(dirname(stateDir), "orchestrator-events.log");
	const cursorFile = join(stateDir, "orch-waker.cursor");
	const offsetFile = join(stateDir, "orch-waker.offset");
	const marksFile = join(stateDir, WAKER_STATE_FILE);
	const seatAddress = "orchestrator";
	const controller = new AbortController();

	const log = (line: string): void => {
		process.stdout.write(`${new Date().toISOString()} ${line}\n`);
	};

	/** Wait, and return at once when the process is asked to stop: a stop never waits for the next poll. */
	const sleep = (ms: number): Promise<void> =>
		new Promise<void>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined = undefined;
			const onAbort = (): void => {
				if (timer !== undefined) clearTimeout(timer);
				resolve();
			};
			timer = setTimeout(() => {
				controller.signal.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			controller.signal.addEventListener("abort", onAbort, { once: true });
		});

	/**
	 * One muster CLI call, as a child process the loop can interrupt.
	 *
	 * The call yields: a thread that waits in `spawnSync` cannot see a stop signal, so the
	 * child is killed when the process is asked to stop, and the call answers at once.
	 */
	const cli = async (args: string[], options: { stdin?: string; timeoutMs?: number } = {}): Promise<{ code: number | null; stdout: string; stderr: string; stopped: boolean }> => {
		const child = spawn(musterLauncher(), args, {
			env: { ...process.env, PI_MUSTER_STATE_DIR: stateDir },
			stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		if (options.stdin !== undefined) child.stdin?.end(options.stdin);
		const onAbort = (): void => {
			child.kill("SIGTERM");
		};
		controller.signal.addEventListener("abort", onAbort, { once: true });
		const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
			child.kill("SIGKILL");
		}, options.timeoutMs);
		try {
			const code = await new Promise<number | null>((resolve) => {
				child.once("close", (closed) => resolve(closed));
				child.once("error", () => resolve(null));
			});
			return { code, stdout, stderr, stopped: controller.signal.aborted };
		} finally {
			controller.signal.removeEventListener("abort", onAbort);
			if (timer !== undefined) clearTimeout(timer);
		}
	};

	// One waker per machine: the lock is taken before anything else, so a second copy never
	// reads an event and never delivers a second wake. The refusal is one named line and the
	// machine's own refusal code; the lock file belongs to the holder and to nobody else.
	const lock = acquireWakerLock(stateDir);
	if (!lock.ok) {
		process.stderr.write(`${lock.line}\n`);
		process.exit(WAKER_REFUSAL_EXIT);
	}
	const stop = (): void => {
		controller.abort();
	};
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	process.once("exit", () => lock.lock.release());

	const readMarks = (): WakerMarks => {
		try {
			const parsed = JSON.parse(readFileSync(marksFile, "utf8")) as unknown;
			return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as WakerMarks) : {};
		} catch {
			return {};
		}
	};
	const saveMarks = (marks: WakerMarks): void => {
		mkdirSync(dirname(marksFile), { recursive: true, mode: 0o700 });
		const temp = `${marksFile}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(marks, null, "\t")}\n`, { mode: 0o600 });
		renameSync(temp, marksFile);
	};

	/** The holder, for the proof. The mailbox is always `orchestrator`; `deliveryTarget` enforces that. */
	const seat = (): WakerSeat | undefined => {
		try {
			const record = readSeat("orchestrator", { stateDir });
			const holder = record.holder;
			if (record.epoch === 0 || holder === null) return undefined;
			return { laneId: "orchestrator", sessionId: holder.sessionId, harness: holder.harness, epoch: record.epoch };
		} catch {
			return undefined;
		}
	};

	const inbox = (): WakerInboxMessage[] =>
		listInboxMessages(stateDir, seatAddress).map((message) => ({ id: message.id, at: message.at, from: message.from, text: message.text }));

	/** Block on the event store the switch names: the ledger's entries, or the events file. The wait yields. */
	const events = async (waitSeconds: number): Promise<string[]> => {
		if (readBackend(stateDir) === "ledger") {
			const result = await cli(["wait", "--events", "--cursor-file", cursorFile, "--timeout", String(waitSeconds)], { timeoutMs: waitSeconds * 1000 + CLI_GRACE_MS });
			if (result.stopped) return [];
			if (result.code !== 0) {
				log(`events: muster wait --events exited ${result.code ?? "without a status"}: ${result.stderr.trim().split("\n")[0] ?? ""}`);
				return [];
			}
			return eventLines(result.stdout);
		}
		return await eventsFromFile(eventsFile, offsetFile, waitSeconds);
	};

	/** Files mode: the same tail-and-offset read the retired waiter used, one pass per `waitSeconds`. The poll yields. */
	const eventsFromFile = async (file: string, offsetFile: string, waitSeconds: number): Promise<string[]> => {
		const deadline = Date.now() + waitSeconds * 1000;
		let offset = 0;
		try {
			const parsed = Number.parseInt(readFileSync(offsetFile, "utf8").trim(), 10);
			if (Number.isInteger(parsed) && parsed >= 0) offset = parsed;
		} catch {
			offset = 0;
		}
		for (;;) {
			const lines = readFromOffset(file, offset, (next) => {
				offset = next;
			});
			if (lines.length > 0) {
				mkdirSync(dirname(offsetFile), { recursive: true, mode: 0o700 });
				writeFileSync(offsetFile, `${offset}\n`, { mode: 0o600 });
				return lines;
			}
			if (controller.signal.aborted || Date.now() >= deadline) return [];
			await sleep(1_000);
		}
	};

	/** Whole lines after `offset`; the offset moves only past a line terminator. */
	const readFromOffset = (file: string, offset: number, advance: (next: number) => void): string[] => {
		if (!existsSync(file)) return [];
		let size: number;
		try {
			size = statSync(file).size;
		} catch {
			return [];
		}
		if (size <= offset) return [];
		const length = Math.min(size - offset, 512 * 1024);
		const buffer = Buffer.alloc(length);
		const fd = openSync(file, "r");
		try {
			readSync(fd, buffer, 0, length, offset);
		} finally {
			closeSync(fd);
		}
		const text = buffer.toString("utf8");
		const lastBreak = text.lastIndexOf("\n");
		if (lastBreak < 0) return [];
		const complete = text.slice(0, lastBreak + 1);
		advance(offset + Buffer.byteLength(complete, "utf8"));
		return eventLines(complete);
	};

	/** The seat's turn clock from the lane directory: never a file's mtime, never a byte count. */
	const turn = async (): Promise<WakerTurn> => {
		const current = seat();
		if (current === undefined) return { lastTurnAt: undefined, busy: false };
		const result = await cli(["lanes", "--json"], { timeoutMs: CLI_GRACE_MS });
		if (result.code !== 0) return { lastTurnAt: undefined, busy: false };
		let rows: unknown;
		try {
			rows = JSON.parse(result.stdout);
		} catch {
			return { lastTurnAt: undefined, busy: false };
		}
		if (!Array.isArray(rows)) return { lastTurnAt: undefined, busy: false };
		const row = (rows as Array<Record<string, unknown>>).find((entry) => entry["sessionId"] === current.sessionId || entry["laneId"] === current.laneId);
		const lastTurnAt = typeof row?.["lastTurnAt"] === "number" ? (row["lastTurnAt"] as number) : undefined;
		// A turn in progress is a transcript that moved in the last two minutes: a queued follow-up
		// is read at that turn's boundary, so the proof window is the longer one there.
		const busy = lastTurnAt !== undefined && Date.now() - lastTurnAt < 120_000;
		return { lastTurnAt, busy };
	};

	/** Deliver into the seat: the send owner writes the message the seat's own inbox poll turns into a turn. */
	const deliver = async (target: WakerSeat, text: string, idempotencyKey: string): Promise<{ ok: boolean; detail: string }> => {
		const result = await cli(["--agent", WAKER_ACTOR, "send", target.laneId, "--stdin", "--mode", "wake", "--key", idempotencyKey, "--no-verify"], { stdin: text, timeoutMs: 60_000 });
		const detail = result.stdout.trim().split("\n").pop() ?? "";
		if (result.code === 0) return { ok: true, detail };
		const why = result.stderr.trim().split("\n")[0] ?? "";
		return { ok: false, detail: why === "" ? `muster send exited ${result.code ?? "without a status"}; ${detail}` : why };
	};

	const resume = async (target: WakerSeat, text: string): Promise<WakerResume> => {
		// The one owner of a parked lane's relaunch. A live seat answers `not-parked`; a Claude
		// session answers `inbox-only` (LD16). Nothing here starts a second process on a live session.
		const result = await parkedLaneResume(stateDir, WAKER_ACTOR)({ laneId: target.laneId, text });
		if (result.state === "resumed") return { state: "resumed", detail: result.detail };
		if (result.state === "failed") return { state: "failed", detail: result.reason };
		if (result.state === "inbox-only") return { state: "inbox-only", detail: result.why };
		return { state: "not-parked", detail: "the lane record is not parked" };
	};

	const deps: WakerDeps = {
		signal: controller.signal,
		seat,
		inbox,
		markInboxRead: (ids) => {
			for (const id of ids) markInboxMessageRead(stateDir, seatAddress, id);
		},
		events,
		deliver,
		turn,
		resume,
		alertHenry: (text, key) => tellGrokbot(stateDir, WAKER_ACTOR, text, key),
		marks: readMarks,
		saveMarks,
		now: () => Date.now(),
		sleep,
		log,
	};

	log(`waker: started (state ${stateDir}, events ${readBackend(stateDir) === "ledger" ? "ledger" : "file"})`);
	void runWakerLoop(deps).catch((error: unknown) => {
		log(`waker: stopped with an error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
		lock.lock.release();
		process.exitCode = 1;
	});
}

main();
