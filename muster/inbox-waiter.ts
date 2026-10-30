/**
 * The inbox waiter's pid file (lifecycle WP9, LD10).
 *
 * A Claude lane that has ended its turn is woken by its own background
 * `muster wait --inbox <lane>`, which exits on the first message. The waiter
 * writes `<Muster state dir>/waiters/<lane>.pid` while it runs and removes it on
 * exit. Whoever needs to know whether a lane can be woken (the Stop hook, the
 * send outcome) asks `waiterAlive`; nobody else reads the file.
 *
 * Imports only the pid check of the lane directory, so the Claude hook bundle
 * stays small.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { procPidAlive, procStartTime, readProcStat } from "./lib/lane-directory.ts";

/** What the Stop hook tells a lane whose waiter is down (the launch brief asks the same in `scripts/pi-lane-launch.sh`). */
export function waiterNudgeText(laneId: string): string {
	return `Before you end your turn, run \`muster wait --inbox ${laneId} --timeout 0\` with run_in_background true, so messages can wake you.`;
}

/** The same shape the lane record accepts for a lane id; a path is never built from anything else. */
const SAFE_LANE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export function waiterPidFile(musterStateDir: string, laneId: string): string {
	if (!SAFE_LANE_ID.test(laneId)) throw new Error(`inbox waiter: ${JSON.stringify(laneId)} is not a valid lane id`);
	return join(musterStateDir, "waiters", `${laneId}.pid`);
}

/** Record that this process is the lane's waiter. */
export function writeWaiterPid(musterStateDir: string, laneId: string, pid: number = process.pid): void {
	const file = waiterPidFile(musterStateDir, laneId);
	mkdirSync(join(musterStateDir, "waiters"), { recursive: true, mode: 0o700 });
	writeFileSync(file, `${pid}\n`, { mode: 0o600 });
}

/** Remove the pid file, but only while it still names `pid`: a newer waiter's file is not this one's to remove. */
export function removeWaiterPid(musterStateDir: string, laneId: string, pid: number = process.pid): void {
	try {
		const file = waiterPidFile(musterStateDir, laneId);
		if (!existsSync(file)) return;
		if (Number.parseInt(readFileSync(file, "utf8").trim(), 10) !== pid) return;
		rmSync(file, { force: true });
	} catch {
		// A pid file that cannot be removed is a stale file; `waiterAlive` reads it as a dead waiter.
	}
}

/** Is a waiter running for this lane? A missing, unreadable or stale pid file is "no". */
export function waiterAlive(musterStateDir: string, laneId: string, pidAlive: (pid: number) => boolean = procPidAlive): boolean {
	try {
		const pid = Number.parseInt(readFileSync(waiterPidFile(musterStateDir, laneId), "utf8").trim(), 10);
		return Number.isInteger(pid) && pid > 0 && pidAlive(pid);
	} catch {
		return false;
	}
}

/** One process as `/proc` shows it: its parent, its command name and its argv. */
export interface ProcInfo {
	ppid: number;
	comm: string;
	args: string[];
}

/** `/proc/<pid>/stat` (through the lane directory's reader) and `cmdline`; undefined when the process is gone or unreadable. */
export function readProcInfo(pid: number): ProcInfo | undefined {
	const stat = readProcStat(pid);
	if (stat === undefined) return undefined;
	let args: string[] = [];
	try {
		args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter((arg) => arg !== "");
	} catch {
		// A kernel thread has no cmdline; comm still answers.
	}
	return { ppid: stat.ppid, comm: stat.comm, args };
}

/**
 * Is this the `claude` or the `pi` process: its command name or argv[0] (a background Claude session
 * runs as `2.1.296` with argv[0] `claude`), or a node/bun host (`node` or `MainThread`) running a `claude` or `pi` script.
 */
export function isSessionProcess(info: ProcInfo): boolean {
	const named = (value: string | undefined): boolean => value === "claude" || value === "pi";
	// A background session rewrites its title, so argv[0] reads `claude bg-spare` as one string (2026-10-17):
	// its first word names the program.
	if (named(info.comm) || named(basename((info.args[0] ?? "").split(" ")[0] ?? ""))) return true;
	if (info.comm !== "node" && info.comm !== "bun" && info.comm !== "MainThread") return false;
	return named(basename(info.args[1] ?? ""));
}

/** The session process a waiter belongs to. The start time guards against a reused pid. */
export interface SessionProcess {
	pid: number;
	startTime: string;
}

/**
 * The nearest ancestor of `from` (default: this process) that is the `claude` or `pi` process
 * (N4). A waiter outlives its session when the daemon retires it, and with no expiry (LD18) it
 * would read the next message into a dead session; this is the process whose life it follows.
 * Undefined when no ancestor is one (the wait runs from a plain terminal or a unit), and then
 * nothing is checked.
 */
export function findSessionProcess(options: { from?: number; read?: (pid: number) => ProcInfo | undefined; startTime?: (pid: number) => string | undefined } = {}): SessionProcess | undefined {
	const read = options.read ?? readProcInfo;
	const startTime = options.startTime ?? procStartTime;
	let current = options.from ?? process.pid;
	for (let depth = 0; depth < 64 && current > 1; depth += 1) {
		const info = read(current);
		if (info === undefined) return undefined;
		if (current !== (options.from ?? process.pid) && isSessionProcess(info)) {
			const started = startTime(current);
			return started === undefined ? undefined : { pid: current, startTime: started };
		}
		current = info.ppid;
	}
	return undefined;
}

/** Is the session process still the one the waiter recorded? A dead pid, or a pid another process now holds, is no. */
export function sessionProcessAlive(session: SessionProcess, deps: { pidAlive?: (pid: number) => boolean; startTime?: (pid: number) => string | undefined } = {}): boolean {
	if (!(deps.pidAlive ?? procPidAlive)(session.pid)) return false;
	return (deps.startTime ?? procStartTime)(session.pid) === session.startTime;
}
