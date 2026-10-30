/**
 * MG1 (VR24-62, rule G2), the archive half: `raw/YYYY-MM-DD.jsonl` and `media/`
 * under one store root, and nothing else. The archive is append-only and is the
 * only source of truth; `messages.db` (`messages-db.ts`) is derived from it and
 * `rebuild()` recreates it, so a damaged index costs a rebuild and never a message.
 *
 * - One line per record, one file per day **the record was archived**, so a first
 *   run's backfill lands in that day's file rather than rewriting older files, and
 *   no file is ever opened for writing twice in one process run beyond appending.
 * - A message line holds `payload`, the channel's own object verbatim. What this
 *   module adds beside it (its own fields) never replaces it.
 * - Edits, deletions and revokes are event lines. The message line is never
 *   touched, so the original text stays readable after the sender edits it.
 * - Media is copied under its SHA-256, because the channel's media folder is a
 *   cache that may be pruned.
 * - The root is 0700 and every file the store writes is 0600.
 */
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { ChannelContact, ChannelEvent, ChannelEventKind, ChannelMessage, MediaBlob, MessageSource } from "./types.ts";

/** The environment variable that names the store root when the caller names none. */
export const MESSAGING_ROOT_ENV = "MESSAGING_STORE_ROOT";
/** The sub-folders the store owns, relative to the root. */
export const RAW_DIR = "raw";
export const MEDIA_DIR = "media";
export const INDEX_FILE = "messages.db";
/** The production root: beside WAHA's own folder, outside the bus and outside the repo. */
export const PRODUCTION_ROOT = join(homedir(), ".local", "share", "messaging");
/** Folder and file modes the store guarantees. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
/** A day file's name, and the `recordedAt` day it is derived from. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The store root: the caller's, else `MESSAGING_STORE_ROOT`, else the production
 * folder. Resolving a root creates and reads nothing, so a test that names its own
 * root can never touch the production folder.
 */
export function messagingRoot(explicit?: string): string {
	const named = (explicit ?? "").trim();
	if (named.length > 0) return named;
	const fromEnv = (process.env[MESSAGING_ROOT_ENV] ?? "").trim();
	return fromEnv.length > 0 ? fromEnv : PRODUCTION_ROOT;
}

/** One media copy: where it sits inside the store, and what is inside it. */
export type MediaRecord = {
	/** Path relative to the store root, `media/<sha256>.<ext>`. */
	file: string;
	sha256: string;
	bytes: number;
	mime?: string;
};

/** A pulled message as archived: the channel's message and the store's own envelope. */
export type ArchivedMessage = {
	v: 1;
	kind: "message";
	channel: string;
	/** The chat id exactly as the channel sent it (G4 keeps the arriving form). */
	chatId: string;
	messageId: string;
	/** When the store archived it, ISO 8601; names the day file. */
	recordedAt: string;
	/** The channel's own timestamp, epoch milliseconds. */
	timestamp: number;
	fromMe: boolean;
	senderId?: string;
	type: string;
	text?: string;
	source: MessageSource;
	media?: MediaRecord;
	/** The channel's object, verbatim. Never rewritten, never trimmed. */
	payload: unknown;
};

/** An edit, a deletion or a revoke, archived as an event of the message it is about. */
export type ArchivedEvent = {
	v: 1;
	kind: "event";
	channel: string;
	chatId: string;
	messageId: string;
	event: ChannelEventKind;
	/** When the store archived it, ISO 8601; names the day file. */
	recordedAt: string;
	/** When the channel reported the change, ISO 8601. */
	at: string;
	/** The replacement text of an edit. */
	text?: string;
	payload?: unknown;
};

/** One contact-list entry as archived, with every id form the list showed for it. */
export type ArchivedContact = {
	v: 1;
	kind: "contact";
	channel: string;
	contactId: string;
	aliases?: string[];
	name?: string;
	recordedAt: string;
	payload: unknown;
};

export type ArchiveRecord = ArchivedMessage | ArchivedEvent | ArchivedContact;

/** A message to archive: the channel's message, its channel, and when it was pulled. */
export type MessageInput = ChannelMessage & { channel: string; recordedAt?: string };
/** A change to archive: the channel's event, its channel, and when it was pulled. */
export type EventInput = ChannelEvent & { channel: string; recordedAt?: string };
/** A contact-list entry to archive. */
export type ContactInput = ChannelContact & { channel: string; recordedAt?: string };

/** The day a record belongs to, from its ISO `recordedAt`; names the day file. */
export function dayOf(recordedAt: string): string {
	const day = recordedAt.slice(0, 10);
	if (!DAY_PATTERN.test(day) || Number.isNaN(Date.parse(recordedAt))) {
		throw new Error(`messaging archive: a record needs an ISO 8601 recordedAt, got ${JSON.stringify(recordedAt)}`);
	}
	return day;
}

/** The day file a record belongs to. */
export function dayFileOf(recordedAt: string): string {
	return `${dayOf(recordedAt)}.jsonl`;
}

/** Creates the root and its two folders, and holds them at 0700. */
export function ensureStore(root: string): void {
	for (const dir of [root, join(root, RAW_DIR), join(root, MEDIA_DIR)]) {
		mkdirSync(dir, { recursive: true, mode: DIR_MODE });
		chmodSync(dir, DIR_MODE);
	}
}

/** Appends one record to its day file and holds the file at 0600. */
export function appendArchiveRecord(root: string, record: ArchiveRecord): void {
	ensureStore(root);
	const path = join(root, RAW_DIR, dayFileOf(record.recordedAt));
	const fd = openSync(path, "a", FILE_MODE);
	try {
		// A crash can leave a half line with no newline. Finish it before the new line, so the
		// record is a line of its own and the fragment stays byte for byte as the crash left it.
		if (!endsWithNewline(path)) writeSync(fd, "\n");
		writeSync(fd, `${JSON.stringify(record)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	chmodSync(path, FILE_MODE);
}

function endsWithNewline(path: string): boolean {
	if (statSync(path).size === 0) return true;
	const fd = openSync(path, "r");
	try {
		const last = Buffer.alloc(1);
		readSync(fd, last, 0, 1, statSync(path).size - 1);
		return last[0] === 0x0a;
	} finally {
		closeSync(fd);
	}
}

/** A line the archive holds but cannot read as a record: kept, reported and never rewritten. */
export type SkippedLine = { file: string; line: number; reason: string };

/** What one read of the archive found. */
export type ArchiveContents = { records: ArchiveRecord[]; skipped: SkippedLine[] };

/**
 * Every archived record, oldest day file first and in the order each file holds.
 * A line that is not a record — half a line a crash cut in half, or anything else —
 * is reported and skipped, never thrown over: a rebuild has to keep the records
 * around a broken line, and the skip is what `rebuild()` tells the caller about.
 */
export function readArchiveRecords(root: string): ArchiveContents {
	const records: ArchiveRecord[] = [];
	const skipped: SkippedLine[] = [];
	const dir = join(root, RAW_DIR);
	if (!existsSync(dir)) return { records, skipped };
	for (const name of readdirSync(dir)
		.filter((entry) => entry.endsWith(".jsonl"))
		.sort()) {
		const one = readArchiveFile(join(dir, name));
		records.push(...one.records);
		skipped.push(...one.skipped);
	}
	return { records, skipped };
}

function readArchiveFile(path: string): ArchiveContents {
	const file = basename(path);
	const records: ArchiveRecord[] = [];
	const skipped: SkippedLine[] = [];
	for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
		if (line.trim().length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (err) {
			skipped.push({ file, line: index + 1, reason: (err as Error).message });
			continue;
		}
		if (!isArchiveRecord(parsed)) {
			skipped.push({ file, line: index + 1, reason: "not an archive record" });
			continue;
		}
		records.push(parsed);
	}
	return { records, skipped };
}

/** A line only counts as a record when it carries the fields the index reads. */
function isArchiveRecord(value: unknown): value is ArchiveRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if (record["v"] !== 1 || typeof record["channel"] !== "string" || typeof record["recordedAt"] !== "string") return false;
	switch (record["kind"]) {
		case "message":
			return (
				typeof record["chatId"] === "string" &&
				typeof record["messageId"] === "string" &&
				typeof record["timestamp"] === "number" &&
				typeof record["type"] === "string" &&
				typeof record["fromMe"] === "boolean" &&
				"payload" in record
			);
		case "event":
			return (
				typeof record["chatId"] === "string" &&
				typeof record["messageId"] === "string" &&
				typeof record["event"] === "string" &&
				typeof record["at"] === "string"
			);
		case "contact":
			return typeof record["contactId"] === "string";
		default:
			return false;
	}
}

/**
 * What makes two records the same reading of the channel: everything but when the
 * store archived it. A second pull of what the archive already holds is the same
 * record, so it needs no second line (R2 of the architect's Fix-gate verdict).
 */
export function identityOf(record: ArchiveRecord): string {
	const { recordedAt: _archivedAt, ...rest } = record;
	return stableJson(rest);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/**
 * The archive's own answer to "has this reading already been written", cheap enough to
 * ask per record: each day file is read once per store (the identities it holds), and
 * every append this process makes is remembered. It is what a crash between the append
 * and the index is repaired from — the copy is in `raw/`, the index catches up.
 */
export type ArchiveLedger = {
	holds(record: ArchiveRecord): boolean;
	remember(record: ArchiveRecord): void;
};

export function archiveLedger(root: string): ArchiveLedger {
	const days = new Map<string, Set<string>>();
	const knownOfDay = (record: ArchiveRecord): Set<string> => {
		const day = dayOf(record.recordedAt);
		let known = days.get(day);
		if (known !== undefined) return known;
		known = new Set<string>();
		const file = join(root, RAW_DIR, `${day}.jsonl`);
		if (existsSync(file)) for (const held of readArchiveFile(file).records) known.add(identityOf(held));
		days.set(day, known);
		return known;
	};
	return {
		holds: (record) => knownOfDay(record).has(identityOf(record)),
		remember: (record) => void knownOfDay(record).add(identityOf(record)),
	};
}

/**
 * The bytes the store root holds, and what part of it each part takes. The archive
 * grows without a retention limit by decision, so the size is reported, never pruned.
 */
export function folderSizes(root: string): { total: number; raw: number; media: number; index: number } {
	const sizeOf = (path: string): number => {
		if (!existsSync(path)) return 0;
		const stat = statSync(path);
		if (stat.isFile()) return stat.size;
		let total = 0;
		for (const entry of readdirSync(path)) total += sizeOf(join(path, entry));
		return total;
	};
	return {
		total: sizeOf(root),
		raw: sizeOf(join(root, RAW_DIR)),
		media: sizeOf(join(root, MEDIA_DIR)),
		index:
			sizeOf(join(root, INDEX_FILE)) + sizeOf(join(root, `${INDEX_FILE}-wal`)) + sizeOf(join(root, `${INDEX_FILE}-shm`)),
	};
}

/**
 * Copies one blob into `media/` under its SHA-256. Two pulls of the same bytes cost
 * one file, and the hash is what the index points at.
 */
export function storeMedia(root: string, blob: MediaBlob): MediaRecord {
	const sha256 = createHash("sha256").update(blob.bytes).digest("hex");
	const file = `${MEDIA_DIR}/${sha256}.${extensionOf(blob)}`;
	const path = join(root, file);
	if (!existsSync(path)) writeFileSync(path, blob.bytes, { mode: FILE_MODE });
	chmodSync(path, FILE_MODE);
	return { file, sha256, bytes: blob.bytes.length, ...blob.mime ? { mime: blob.mime } : {} };
}

const MIME_EXTENSIONS: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"image/gif": "gif",
	"video/mp4": "mp4",
	"video/3gpp": "3gp",
	"audio/ogg": "ogg",
	"audio/mpeg": "mp3",
	"audio/mp4": "m4a",
	"application/pdf": "pdf",
	"application/octet-stream": "bin",
};

function extensionOf(blob: MediaBlob): string {
	const byMime = blob.mime ? MIME_EXTENSIONS[blob.mime.toLowerCase()] : undefined;
	if (byMime) return byMime;
	const named = (blob.filename ?? "").match(/\.([A-Za-z0-9]{1,8})$/);
	return named ? named[1].toLowerCase() : "bin";
}
