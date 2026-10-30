/**
 * Concord state outside the working tree (R1 item 9, AM3).
 *
 * Concord writes `.concord/` (database, WAL, work state, events) in the project
 * root every few seconds while lanes run. Those were the only changing files in
 * the the CRM app checkout, and the dev server's file watcher reacted to
 * each one. Concord 0.10.4 has no configurable database path (it opens
 * `<root>/.concord/concord.db`), so nothing can be configured and nothing
 * vendored is patched. Instead the directory lives under Muster's state and a
 * symlink named `.concord` takes its place: every Concord process, and Muster's
 * `workspaceInitialized`, open the same path as before.
 *
 * The move is a rename on one filesystem, so the files keep their inodes. It is
 * refused while any process holds a file of the directory open, because moving a
 * live WAL database under a running lane is exactly what must not happen: run
 * it at a cutover window with the lanes settled. Nothing is ever deleted or
 * overwritten, and a dry run (the default) changes nothing.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";

import { musterStateDir, normalizePrimaryRoot } from "./binding.ts";

export type RelocationAction = "migrate" | "create" | "already-relocated" | "refuse";

export type RelocationResult = {
	action: RelocationAction;
	/** Whether this call changed anything on disk. */
	applied: boolean;
	source: string;
	target: string;
	reason?: string;
};

export type RelocationInput = {
	primaryRoot: string;
	repoKey: string;
	/** Directory holding every repository's external state; defaults to `<muster state>/concord`. */
	stateRoot?: string;
	/** Without it the call only reports what it would do. */
	apply?: boolean;
	/** Test seam: whether two paths are on one filesystem. */
	sameFilesystem?: (a: string, b: string) => boolean;
	/** Test seam: paths of the directory's files that some process holds open. */
	openFiles?: (directory: string) => string[];
};

/** `<stateRoot>/<repo-name>-<12 hex of the repo key hash>`: stable, readable, collision-free. */
export function concordStateDirFor(repoKey: string, stateRoot: string = path.join(musterStateDir(), "concord")): string {
	const name = path.basename(normalizePrimaryRoot(repoKey)).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40) || "repo";
	return path.join(stateRoot, `${name}-${createHash("sha256").update(repoKey).digest("hex").slice(0, 12)}`);
}

function sameDevice(a: string, b: string): boolean {
	return statSync(a).dev === statSync(b).dev;
}

/** Files of `directory` that any process has open, found from /proc (Linux). */
function filesOpenByAnyProcess(directory: string): string[] {
	const root = realpathSync(directory);
	const held = new Set<string>();
	let pids: string[];
	try {
		pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
	} catch {
		return [];
	}
	for (const pid of pids) {
		let fds: string[];
		try {
			fds = readdirSync(`/proc/${pid}/fd`);
		} catch {
			continue;
		}
		for (const fd of fds) {
			try {
				const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
				if (target === root || target.startsWith(`${root}${path.sep}`)) held.add(target);
			} catch {
				/* the descriptor closed while scanning */
			}
		}
	}
	return [...held];
}

function isEmptyDirectory(directory: string): boolean {
	return readdirSync(directory).length === 0;
}

/** Keep `.concord` out of `git status` through the repository's local exclude file, once. */
function excludeFromGit(primaryRoot: string, repoKey: string): void {
	const gitDir = path.basename(repoKey) === ".git" ? repoKey : path.join(primaryRoot, ".git");
	if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) return;
	const file = path.join(gitDir, "info", "exclude");
	mkdirSync(path.dirname(file), { recursive: true });
	const current = existsSync(file) ? readFileSync(file, "utf8") : "";
	if (current.split("\n").some((line) => line.trim() === ".concord")) return;
	appendFileSync(file, `${current === "" || current.endsWith("\n") ? "" : "\n"}.concord\n`);
}

export function relocateConcordState(input: RelocationInput): RelocationResult {
	const source = path.join(input.primaryRoot, ".concord");
	const target = concordStateDirFor(input.repoKey, input.stateRoot);
	const apply = input.apply === true;
	const refuse = (reason: string): RelocationResult => ({ action: "refuse", applied: false, source, target, reason });

	let entry: ReturnType<typeof lstatSync> | undefined;
	try {
		entry = lstatSync(source);
	} catch {
		entry = undefined;
	}

	if (entry?.isSymbolicLink()) {
		const resolved = path.resolve(path.dirname(source), readlinkSync(source));
		if (resolved === path.resolve(target)) return { action: "already-relocated", applied: false, source, target };
		return refuse(`${source} is a link that points elsewhere (${resolved}); it is left alone`);
	}
	if (entry !== undefined && !entry.isDirectory()) return refuse(`${source} exists and is not a directory`);

	if (existsSync(target) && !isEmptyDirectory(target)) {
		return refuse(`${target} already holds files; it is never overwritten`);
	}

	if (entry === undefined) {
		if (apply) {
			mkdirSync(target, { recursive: true });
			symlinkSync(target, source);
			excludeFromGit(input.primaryRoot, input.repoKey);
		}
		return { action: "create", applied: apply, source, target };
	}

	// Moving a live WAL database is the one unsafe step: check before any change.
	const held = (input.openFiles ?? filesOpenByAnyProcess)(source);
	if (held.length > 0) {
		return refuse(`a process still has ${held.length} file${held.length === 1 ? "" : "s"} of ${source} open (${held.slice(0, 3).join(", ")}); settle the lanes and run it again`);
	}
	// The target's parent may not exist yet: its nearest existing ancestor is on the same filesystem.
	let ancestor = path.dirname(target);
	while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
	if (!(input.sameFilesystem ?? sameDevice)(source, ancestor)) {
		return refuse(`${source} and ${path.dirname(target)} are on different filesystems; a copy of a live database is not safe, so nothing is moved`);
	}
	if (apply) {
		mkdirSync(path.dirname(target), { recursive: true });
		// rename(2) also replaces an empty directory left by an earlier attempt.
		renameSync(source, target);
		symlinkSync(target, source);
		excludeFromGit(input.primaryRoot, input.repoKey);
	}
	return { action: "migrate", applied: apply, source, target };
}
