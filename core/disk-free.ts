/**
 * Free space on one filesystem, read structurally from the mount itself, never scraped from `df`'s prose
 * (spec §6, §9). One owner for the number: the doctor's `disk-c` contract and the gateway's machine health
 * both ask here, so the 50 GB floor and the `df -P` report can never disagree about what "free" means.
 *
 * `bavail` is what this user may still write, which is the number that runs out, and `bsize` turns it into
 * bytes. It lives in `packages/core` because Pi's doctor imports it back through the `harness/` link, and
 * this module must stay dependency-free: a heavy import here would land in the doctor's own process.
 */

import { statfsSync } from "node:fs";

/** One filesystem's free and total bytes. */
export interface DiskFree {
	/** What this user may still write, in bytes. */
	freeBytes: number;
	/** The filesystem's whole size, in bytes. */
	totalBytes: number;
}

/** The statfs reading a caller may substitute (a fixture), and its shape. */
export type StatfsReader = (path: string) => { bsize: number; blocks: number; bavail: number };

/** Free and total bytes of the filesystem `path` sits on. A path that cannot be read throws its own error. */
export function diskFree(path: string, statfs: StatfsReader = statfsSync): DiskFree {
	const stats = statfs(path);
	return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
}
