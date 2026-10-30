/**
 * The receipt reader's own state under `<stateDir>/receipts` (UB0 B-2).
 *
 * Two files, one meaning each:
 *
 *  - `seen.json` holds the Gmail ids the reader has already handled, per mailbox profile, so the next run
 *    reads only what is new. An id is a name and nothing else: no address, no subject and no body is kept.
 *  - `last-run.json` holds what the reader did last: when it last ran per profile, and the Sofia day it
 *    last raised the sign-in ask for that profile, so a mailbox whose sign-in has lapsed asks the operator once a
 *    day rather than once an hour.
 *
 * Both files are written whole: a temporary file, then a rename, so a reader never sees half a record. A
 * torn or hand-edited file is no record, and the reader then re-reads what it has not seen and asks again
 * today, which is the safe direction for both.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The directory the reader owns under the Muster state dir. */
export const RECEIPTS_DIR = "receipts";
/** The file of ids the reader has already handled. */
export const RECEIPTS_SEEN_FILE = "seen.json";
/** The file of what the reader did last. */
export const RECEIPTS_LAST_RUN_FILE = "last-run.json";
/** How many ids one profile keeps; the oldest go, so the file stays small. */
export const RECEIPT_SEEN_MAX = 500;

/** `<stateDir>/receipts`. */
export function receiptsDir(stateDir: string): string {
	return join(stateDir, RECEIPTS_DIR);
}

/** `<stateDir>/receipts/seen.json`. */
export function receiptsSeenPath(stateDir: string): string {
	return join(receiptsDir(stateDir), RECEIPTS_SEEN_FILE);
}

/** `<stateDir>/receipts/last-run.json`. */
export function receiptsLastRunPath(stateDir: string): string {
	return join(receiptsDir(stateDir), RECEIPTS_LAST_RUN_FILE);
}

/** What one profile has already been read for. */
export interface ReceiptSeenProfile {
	/** The ids already handled, oldest first. */
	ids: string[];
}

/** The whole of `seen.json`. */
export interface ReceiptSeen {
	version: 1;
	/** When the file was last written, ISO. */
	at: string;
	/** Per mailbox profile. */
	profiles: Record<string, ReceiptSeenProfile>;
}

/** What one profile did last. */
export interface ReceiptLastRunProfile {
	/** When the reader last ran for this profile, ISO. */
	at: string;
	/** The Sofia day the sign-in ask was last raised for this profile. */
	askDay?: string;
}

/** The whole of `last-run.json`. */
export interface ReceiptLastRun {
	version: 1;
	/** When the file was last written, ISO. */
	at: string;
	/** Per mailbox profile. */
	profiles: Record<string, ReceiptLastRunProfile>;
}

function readJson(path: string): unknown {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return undefined;
	}
}

function writeJson(stateDir: string, file: string, value: unknown): void {
	mkdirSync(receiptsDir(stateDir), { recursive: true, mode: 0o700 });
	const path = join(receiptsDir(stateDir), file);
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	renameSync(temporary, path);
}

/** The ids already handled, as a set the reader can ask about. */
export function readReceiptSeen(stateDir: string): ReceiptSeen {
	const parsed = readJson(receiptsSeenPath(stateDir));
	if (parsed === null || typeof parsed !== "object") return { version: 1, at: "", profiles: {} };
	const file = parsed as Record<string, unknown>;
	const profiles: Record<string, ReceiptSeenProfile> = {};
	const raw = file["profiles"];
	if (raw !== null && typeof raw === "object") {
		for (const [name, record] of Object.entries(raw as Record<string, unknown>)) {
			if (record === null || typeof record !== "object") continue;
			const ids = (record as Record<string, unknown>)["ids"];
			if (!Array.isArray(ids)) continue;
			profiles[name] = { ids: ids.filter((id): id is string => typeof id === "string") };
		}
	}
	return { version: 1, at: typeof file["at"] === "string" ? file["at"] : "", profiles };
}

/** Write the ids the reader has handled. */
export function writeReceiptSeen(stateDir: string, seen: ReceiptSeen): void {
	writeJson(stateDir, RECEIPTS_SEEN_FILE, seen);
}

/** The ids one profile has already been read for. */
export function seenIds(seen: ReceiptSeen, profile: string): Set<string> {
	return new Set(seen.profiles[profile]?.ids ?? []);
}

/** Remember one id, keeping the file bounded: the oldest ids go first. */
export function rememberSeen(seen: ReceiptSeen, profile: string, id: string): void {
	const current = seen.profiles[profile]?.ids ?? [];
	if (current.includes(id)) return;
	const ids = [...current, id];
	seen.profiles[profile] = { ids: ids.slice(Math.max(0, ids.length - RECEIPT_SEEN_MAX)) };
}

/** What the reader did last, or an empty record when there is none. */
export function readReceiptLastRun(stateDir: string): ReceiptLastRun {
	const parsed = readJson(receiptsLastRunPath(stateDir));
	if (parsed === null || typeof parsed !== "object") return { version: 1, at: "", profiles: {} };
	const file = parsed as Record<string, unknown>;
	const profiles: Record<string, ReceiptLastRunProfile> = {};
	const raw = file["profiles"];
	if (raw !== null && typeof raw === "object") {
		for (const [name, record] of Object.entries(raw as Record<string, unknown>)) {
			if (record === null || typeof record !== "object") continue;
			const entry = record as Record<string, unknown>;
			if (typeof entry["at"] !== "string") continue;
			const askDay = entry["askDay"];
			profiles[name] = {
				at: entry["at"],
				...(typeof askDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(askDay) ? { askDay } : {}),
			};
		}
	}
	return { version: 1, at: typeof file["at"] === "string" ? file["at"] : "", profiles };
}

/** Write what the reader did last. */
export function writeReceiptLastRun(stateDir: string, run: ReceiptLastRun): void {
	writeJson(stateDir, RECEIPTS_LAST_RUN_FILE, run);
}
