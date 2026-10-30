/**
 * The waker's own lock (WAKE1, rev4 finding F1).
 *
 * One waker per machine. Two of them would read the same events from the same cursor and
 * deliver the same wake twice, which is the defect class the retired waiter had (WGGUARD,
 * VR24-215): two readers of one seat's events.
 *
 * The lock is a file the waker owns - `<muster state dir>/orch-waker.pid` - holding its pid
 * and the process's start time, so a pid the kernel handed to another process is never
 * mistaken for the holder. A second waker refuses to start: it prints one line naming the
 * pid and exits 75, and it does not touch the file. A missing, unreadable, garbage or stale
 * file is a file the next waker may take over.
 *
 * The lock is the waker's own, not the inbox waiter's slot (`waiters/<lane>.pid`, which
 * `muster/inbox-waiter.ts` owns): the waker never takes the waiter's lock, and the retired
 * `orch-wait.sh` refuses to arm while this file names a live waker.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { procPidAlive, procStartTime } from "./lib/lane-directory.ts";

/** The lock file's name, in the muster state directory. */
export const WAKER_LOCK_FILE = "orch-waker.pid";

/** The code a refusal exits with: the machine's own "refuses to start" code (the retired waiter uses the same one). */
export const WAKER_REFUSAL_EXIT = 75;

export type WakerLockDeps = {
	/** The pid this process claims the lock for; the process's own by default. */
	pid?: number;
	/** Is that process alive? */
	pidAlive?: (pid: number) => boolean;
	/** When that process started, as `/proc` counts it. */
	startTimeOf?: (pid: number) => string | undefined;
};

export type WakerLock = {
	/** The file the lock lives in. */
	file: string;
	/** The pid that holds it. */
	pid: number;
	/** Give the lock up: the file goes only while it still names this holder. */
	release(): void;
};

export type WakerLockResult = { ok: true; lock: WakerLock } | { ok: false; file: string; pid: number; line: string };

/** The file the lock lives in. */
export function wakerLockFile(stateDir: string): string {
	return join(stateDir, WAKER_LOCK_FILE);
}

/** What the lock file names: the pid and the start time, or undefined when it is missing or unreadable. */
function readHolder(file: string): { pid: number; startTime: string } | undefined {
	try {
		const parts = readFileSync(file, "utf8").trim().split(/\s+/);
		const pid = Number.parseInt(parts[0] ?? "", 10);
		if (!Number.isInteger(pid) || pid <= 0) return undefined;
		return { pid, startTime: parts[1] ?? "" };
	} catch {
		return undefined;
	}
}

/**
 * Is the holder still the process that wrote the file?
 *
 * The pid must be alive, and the process's start time must be the one the file recorded: the
 * kernel reuses pids, and a pid that now belongs to another process is not the holder. A
 * holder that wrote no start time has only the pid to prove itself with.
 */
export function holderAlive(holder: { pid: number; startTime: string }, deps: WakerLockDeps): boolean {
	if (!(deps.pidAlive ?? procPidAlive)(holder.pid)) return false;
	if (holder.startTime === "") return true;
	const startTime = (deps.startTimeOf ?? procStartTime)(holder.pid);
	return startTime !== undefined && startTime === holder.startTime;
}

/**
 * Take the waker's lock, or refuse.
 *
 * A live holder means the machine already has a waker: the answer is one line naming the pid
 * and `ok: false`, never a takeover. A stale file is replaced, and the lock is written with
 * this process's pid and start time.
 */
export function acquireWakerLock(stateDir: string, deps: WakerLockDeps = {}): WakerLockResult {
	const file = wakerLockFile(stateDir);
	const holder = readHolder(file);
	if (holder !== undefined && holderAlive(holder, deps)) {
		return { ok: false, file, pid: holder.pid, line: `muster-orch-waker: refusing to start, pid ${holder.pid} is already a live waker` };
	}
	const pid = deps.pid ?? process.pid;
	const startTime = (deps.startTimeOf ?? procStartTime)(pid) ?? "";
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	writeFileSync(file, `${pid} ${startTime}\n`, { mode: 0o600 });
	return { ok: true, lock: { file, pid, release: () => releaseWakerLock(stateDir, pid, startTime) } };
}

/** Remove the lock file, but only while it still names this holder: another waker's file is not this one's to remove. */
export function releaseWakerLock(stateDir: string, pid: number, startTime?: string): void {
	try {
		const file = wakerLockFile(stateDir);
		if (!existsSync(file)) return;
		const holder = readHolder(file);
		if (holder === undefined || holder.pid !== pid) return;
		if (startTime !== undefined && holder.startTime !== startTime) return;
		rmSync(file, { force: true });
	} catch {
		// A lock file that cannot be removed is a stale file: the next waker reads a dead holder and takes it.
	}
}
