/**
 * Concord custody: is the database a live Concord MCP holds open the same file
 * as the one at the project's Concord path?
 *
 * The failure this answers is silent. On 2026-10-05 the the CRM app
 * parent kept writing to a `concord.db` inode that had been unlinked: a
 * `git stash -u` / `pop` cycle replaced `.concord` with an older copy, so every
 * path-based reader — the frontier, the tick, a human with `sqlite3` — saw stale
 * state while the lanes were writing somewhere else. Nothing errored. AM3 moves
 * state out of the working tree after cutover and removes that cause, but a
 * replaced directory is not the only way to split the database, so the split
 * itself is what gets checked.
 *
 * The check is read-only and process-free: it reads `/proc/<pid>/fd/*` links and
 * `stat`s them, which resolves to the *open* inode — the only place a deleted
 * inode is still visible. Nothing is opened for writing, no signal is sent, and
 * nothing is decided from a pty.
 *
 * Two ways to find the holder, in order:
 * - pids Muster already knows (in a session, the MCP child it spawned);
 * - otherwise a `/proc` scan for `concord-mcp` processes whose descriptors point
 *   at that database path.
 */

import { readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename } from "node:path";

export type ConcordCustodyVerdict =
	/** Nothing holds the database, or every holder has the file at the path. */
	| "ok"
	/** A holder is writing an inode the path no longer points at. */
	| "split"
	/** The path holds no database at all. */
	| "missing"
	/** The question could not be answered (no permission, no `/proc`). */
	| "unreadable";

export type ConcordCustodyHolder = {
	pid: number;
	/** `dev:ino` of the inode the descriptor really points at. */
	inode: string;
	/** The kernel marks an unlinked inode's link with a `(deleted)` suffix. */
	deleted: boolean;
	/** The path the descriptor's link resolves to. */
	path: string;
	/**
	 * True when that path is this project's database (or its resolved form), which
	 * is what makes a mismatch decisive. A holder of some other `concord.db` is
	 * reported, never used to declare a split: two projects can both have one.
	 */
	atPath: boolean;
};

export type ConcordCustody = {
	dbPath: string;
	/** `dev:ino` at the path, or undefined when the path has no file. */
	onDisk?: string;
	holders: ConcordCustodyHolder[];
	verdict: ConcordCustodyVerdict;
	/** One line, for a status line or one alert. */
	summary: string;
};

export type ConcordCustodyInput = {
	/** The project's Concord database path. */
	dbPath: string;
	/** Pids Muster already knows. Empty or absent means: scan `/proc`. */
	pids?: readonly number[];
	/** Test seam; `/proc` in production. */
	procRoot?: string;
};

const PROC_ROOT = "/proc";
/** What a live Concord MCP's command line looks like, for the fallback scan. */
const MCP_MARKER = "concord-mcp";
/** How the kernel renders the link of an unlinked inode. */
const DELETED_SUFFIX = " (deleted)";

function inodeOf(path: string): string | undefined {
	try {
		const stats = statSync(path);
		return `${stats.dev}:${stats.ino}`;
	} catch {
		return undefined;
	}
}

/** Every `/proc/<pid>` entry that looks like a Concord MCP launcher. */
export function concordMcpPids(procRoot: string = PROC_ROOT): number[] {
	let entries: string[];
	try {
		entries = readdirSync(procRoot);
	} catch {
		return [];
	}
	const pids: number[] = [];
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		let cmdline: string;
		try {
			cmdline = readFileSync(`${procRoot}/${entry}/cmdline`, "utf8").replaceAll("\0", " ");
		} catch {
			continue;
		}
		if (cmdline.includes(MCP_MARKER)) pids.push(Number(entry));
	}
	return pids.sort((a, b) => a - b);
}

/**
 * Descriptors of one process that are a Concord database: this project's path
 * (decisive), a `concord.db` elsewhere (reported, not decisive), or an unlinked
 * inode whose link still names this project's path.
 *
 * The inode is read from the descriptor itself, because that is the only place an
 * unlinked inode is still visible: a path cannot tell you which file a process
 * actually holds.
 */
function holdersOf(pid: number, dbPath: string, procRoot: string): ConcordCustodyHolder[] {
	const holders: ConcordCustodyHolder[] = [];
	let fds: string[];
	try {
		fds = readdirSync(`${procRoot}/${pid}/fd`);
	} catch {
		return holders;
	}
	// A relocated `.concord` makes a descriptor's link a different string than the
	// catalogue path, so the resolved form counts as the same file.
	let resolved: string;
	try {
		resolved = realpathSync(dbPath);
	} catch {
		resolved = dbPath;
	}
	for (const fd of fds) {
		const link = `${procRoot}/${pid}/fd/${fd}`;
		let target: string;
		try {
			target = readlinkSync(link);
		} catch {
			continue;
		}
		const deleted = target.endsWith(DELETED_SUFFIX);
		const path = deleted ? target.slice(0, -DELETED_SUFFIX.length) : target;
		const atPath = path === resolved || path === dbPath;
		if (!atPath && basename(path) !== basename(dbPath)) continue;
		const inode = inodeOf(link);
		if (inode === undefined) continue;
		holders.push({ pid, inode, deleted, path, atPath });
	}
	return holders;
}

/**
 * Is the database a live process holds open the same file as the one at the
 * path? One verdict, the holders that produced it, and one summary line.
 *
 * - `ok` — nothing holds it, or every holder's inode equals the path's inode;
 * - `split` — a holder's inode differs, or the kernel says it is unlinked;
 * - `missing` — there is no database at the path;
 * - `unreadable` — the question itself could not be answered.
 */
export function inspectConcordCustody(input: ConcordCustodyInput): ConcordCustody {
	const procRoot = input.procRoot ?? PROC_ROOT;
	const dbPath = input.dbPath;
	const onDisk = inodeOf(dbPath);
	const pids = input.pids && input.pids.length > 0 ? [...input.pids] : concordMcpPids(procRoot);
	const holders: ConcordCustodyHolder[] = [];
	for (const pid of pids) {
		for (const holder of holdersOf(pid, dbPath, procRoot)) {
			if (!holders.some((existing) => existing.pid === holder.pid && existing.inode === holder.inode)) holders.push(holder);
		}
	}
	if (onDisk === undefined) {
		if (holders.length === 0) {
			return { dbPath, holders, verdict: "missing", summary: `concord custody: no database at ${dbPath}, and no live holder` };
		}
		return {
			dbPath,
			holders,
			verdict: "split",
			summary: `concord custody: SPLIT — nothing at ${dbPath}, while ${pids.join(", ")} still hold ${[...new Set(holders.map((holder) => holder.inode))].join(", ")}. Every path-based reader now sees no state at all`,
		};
	}
	if (holders.length === 0) {
		return { dbPath, onDisk, holders, verdict: "ok", summary: `concord custody: ok (${basename(dbPath)}, no live MCP holds it)` };
	}
	// Only a holder of *this* path's database can prove a split.
	const split = holders.filter((holder) => holder.atPath && (holder.deleted || holder.inode !== onDisk));
	if (split.length === 0) {
		const elsewhere = holders.filter((holder) => !holder.atPath);
		return {
			dbPath,
			onDisk,
			holders,
			verdict: "ok",
			summary: `concord custody: ok (${basename(dbPath)} held by ${holders.filter((holder) => holder.atPath).map((holder) => holder.pid).join(", ") || "nobody at this path"}` +
				(elsewhere.length > 0
					? `; ${[...new Set(elsewhere.map((holder) => `${holder.pid}:${holder.path}`))].join(", ")} hold another ${basename(dbPath)}, which is not this project`
					: ""),
		};
	}
	const pidsSplit = [...new Set(split.map((holder) => holder.pid))];
	const inodes = [...new Set(split.map((holder) => holder.inode))];
	const deleted = split.filter((holder) => holder.deleted).map((holder) => holder.pid);
	return {
		dbPath,
		onDisk,
		holders,
		verdict: "split",
		summary: [
			`concord custody: SPLIT — ${dbPath} is ${onDisk},`,
			`while ${pidsSplit.join(", ")} hold ${inodes.join(", ")}`,
			deleted.length > 0 ? `(unlinked: ${deleted.join(", ")})` : "(replaced under the running process)",
			". Anything reading the path is reading stale state; the live writes go to the inode above.",
		].join(" "),
	};
}
