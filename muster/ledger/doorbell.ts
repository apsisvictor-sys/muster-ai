/**
 * Doorbells (LC8, plan §2 and LC-D5): the derived signal that tells a reader a
 * message is waiting, without the reader owning the ledger.
 *
 * In files mode a pending message *is* the file in `state/muster/inbox/<address>/`,
 * and the Claude plugin's cached inbox folder probes exactly that: any `*.json`
 * file in the folder means "pending" (`claude-hook.core.ts`, `isPendingInbox`).
 * Ledger mode keeps the messages in `muster.message` and the index in
 * `muster.inbox`, so the folder would stay empty and a session started before the
 * flip would never wake (RF2).
 *
 * A doorbell is one empty `<messageId>.json` in that same folder. Only `musterd`
 * writes and removes them (LC-D5), after the commit that changed
 * `muster.inbox.pending` and when it starts. A message file is named
 * `<13-digit ms>-<id>.json` (`agent-inbox.ts:85-88`), so a doorbell's name never
 * matches a message file's, and no owner reads a doorbell as a message.
 *
 * The folder rules are the owner's, imported: `agentInboxDir` and
 * `agentInboxRoot` (`lib/agent-inbox.ts:75`). This module is filesystem-only, so
 * it names no ledger type and a test proves it without a daemon.
 */

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { agentInboxDir, agentInboxRoot } from "../lib/agent-inbox.ts";

/** The one doorbell name rule: a doorbell is the message id. A message file is `<13-digit ms>-<id>.json`. */
export function doorbellFileName(id: string): string {
	return `${id}.json`;
}

/** One address's doorbell folder — the owner's rule, named here so no caller types the layout. */
function inboxFolder(stateDir: string, address: string): string {
	return agentInboxDir(stateDir, address);
}

/** One `*.json` file in a folder. A doorbell is empty; anything else is a message file the sweep must not touch. */
type FolderFile = { name: string; empty: boolean };

function listFolder(dir: string): FolderFile[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		// A folder that does not exist holds no doorbell and no stray.
		return [];
	}
	const files: FolderFile[] = [];
	for (const name of names.sort()) {
		if (!name.endsWith(".json")) continue;
		try {
			files.push({ name, empty: statSync(join(dir, name)).size === 0 });
		} catch {
			// A file that vanished between the listing and the stat is not there to reconcile.
		}
	}
	return files;
}

/** The addresses with an inbox folder on disk. A doorbell folder is a plain directory; `read/` sits inside one. */
function inboxFolders(stateDir: string): string[] {
	try {
		return readdirSync(agentInboxRoot(stateDir), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

/** Raise one doorbell: create the file only when it is absent, empty and mode 0600. */
function raiseDoorbell(dir: string, name: string): boolean {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = join(dir, name);
	try {
		const fd = openSync(file, "wx", 0o600);
		closeSync(fd);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		return false;
	}
	// `openSync`'s mode is masked by the umask; a doorbell is exactly 0600.
	chmodSync(file, 0o600);
	return true;
}

/** Remove one doorbell. Never a non-empty file: in ledger mode that is a stray message file. */
function removeDoorbell(dir: string, name: string): boolean {
	const file = join(dir, name);
	try {
		if (statSync(file).size !== 0) return false;
	} catch {
		return false;
	}
	rmSync(file, { force: true });
	return true;
}

/** What one address's reconcile changed, named so a caller can log it. */
export type DoorbellChange = {
	address: string;
	/** Doorbell names created. */
	raised: string[];
	/** Doorbell names removed. */
	removed: string[];
	/** Non-empty `*.json` files left in place. */
	strays: string[];
};

/**
 * Make one address's folder hold exactly the doorbells of its pending ids, and
 * nothing else that is empty.
 *
 * A file that is not empty is left in place and reported as a stray: in ledger
 * mode a message file belongs to the flip's backup (LC14), not to this sweep.
 */
export function syncInboxDoorbells(
	stateDir: string,
	address: string,
	pending: readonly string[],
): DoorbellChange {
	const dir = inboxFolder(stateDir, address);
	const wanted = new Set(pending.map(doorbellFileName));
	const change: DoorbellChange = { address, raised: [], removed: [], strays: [] };
	for (const file of listFolder(dir)) {
		if (!file.empty) {
			change.strays.push(file.name);
			continue;
		}
		if (wanted.has(file.name)) continue;
		if (removeDoorbell(dir, file.name)) change.removed.push(file.name);
	}
	for (const id of pending) {
		const name = doorbellFileName(id);
		if (existsSync(join(dir, name))) continue;
		if (raiseDoorbell(dir, name)) change.raised.push(name);
	}
	return change;
}

/** One start sweep: what changed, and the strays it left behind. */
export type DoorbellSweep = {
	/** The addresses whose folder changed. */
	changed: DoorbellChange[];
	/** Non-empty `*.json` files left in place, the strays `muster ledger status` counts. */
	strays: { address: string; name: string }[];
};

/**
 * Reconcile every inbox folder at once, for `musterd`'s start (LC8): the folders
 * the pending index names, plus the folders already on disk, so a folder whose
 * index was emptied while `musterd` was down still loses its doorbells.
 */
export function sweepInboxDoorbells(
	stateDir: string,
	pendingByAddress: ReadonlyMap<string, readonly string[]>,
): DoorbellSweep {
	const addresses = new Set<string>(pendingByAddress.keys());
	for (const address of inboxFolders(stateDir)) addresses.add(address);
	const sweep: DoorbellSweep = { changed: [], strays: [] };
	for (const address of [...addresses].sort()) {
		const change = syncInboxDoorbells(stateDir, address, pendingByAddress.get(address) ?? []);
		if (change.raised.length > 0 || change.removed.length > 0) sweep.changed.push(change);
		for (const name of change.strays) sweep.strays.push({ address, name });
	}
	return sweep;
}

/** The strays left in place, read-only, for `muster ledger status` (LC15). */
export function inboxDoorbellStrays(stateDir: string): { address: string; name: string }[] {
	const strays: { address: string; name: string }[] = [];
	for (const address of inboxFolders(stateDir).sort()) {
		for (const file of listFolder(inboxFolder(stateDir, address))) {
			if (!file.empty) strays.push({ address, name: file.name });
		}
	}
	return strays;
}
