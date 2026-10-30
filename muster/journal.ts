/**
 * Grokbot's journal (UB0 UD8, VR24-196 W1: "Yes make the gateway 2 way please").
 *
 * One store for what the bot did with the words it was given: each relay it carried
 * (with the operator's exact words), each task it started, dropped or scheduled, and its
 * errors. The gateway writes it through `journal_add`, `muster journal` and the command
 * center read it, so the operator, the architect and the orchestrator can check a relay
 * against what he actually said.
 *
 * It is its own owner (UD8): not the signal store, whose entries are claims about
 * providers and models, and not the inbox, which is a message path. The append is the
 * one body the send log and the signal store use (`appendFsyncedLine`, `send.ts`).
 *
 * Two rules the shape carries:
 * - Grokbot's text is untrusted. It reads back with `untrusted: true` and both `text`
 *   and `quote` behind the caller's prefix — the gateway and the CLI pass
 *   `EXTERNAL_PREFIX`, the store never invents one.
 * - A relay is checked against the message it claims to have carried
 *   (`findInboxMessage`, the inbox owner, pending or already read). It reads
 *   `delivered` only when that message exists, came from the gateway and holds the
 *   quote with whitespace collapsed. The journal never asserts that a quote is what
 *   the operator said; it shows the words and says whether they reached the inbox.
 */

import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { GATEWAY_AGENT_ID } from "./gateway/state.ts";
import { findInboxMessage, listInboxAgents } from "./lib/agent-inbox.ts";
import { appendFsyncedLine } from "./send.ts";

export const JOURNAL_DIR = "journal";
export const JOURNAL_EVENTS_FILE = "events.jsonl";
/** Grokbot's own line: what it did, in one line of text. */
export const JOURNAL_TEXT_MAX_CHARS = 300;
/** the operator's exact words, as the bot carried them. */
export const JOURNAL_QUOTE_MAX_CHARS = 2000;
export const JOURNAL_WHY_MAX_CHARS = 200;
export const JOURNAL_ADDRESS_MAX_CHARS = 120;
export const JOURNAL_REF_MAX_CHARS = 200;
export const JOURNAL_READ_LIMIT_DEFAULT = 50;
export const JOURNAL_READ_LIMIT_MAX = 500;

export const JOURNAL_KINDS = ["relay", "task", "error"] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];
export const JOURNAL_TASK_STATES = ["started", "scheduled", "dropped", "done"] as const;
export type JournalTaskState = (typeof JOURNAL_TASK_STATES)[number];
/** The seat addresses a relay names by seat: the architect and the orchestrator. */
export const JOURNAL_SEAT_ADDRESSES = ["architect", "orchestrator"] as const;

/** What the relay check says about one entry. The page shows it; it never reads as a verdict on the operator. */
export const JOURNAL_RELAY_STATES = ["delivered", "not found in the inbox", "the message does not hold these words"] as const;
export type JournalRelayState = (typeof JOURNAL_RELAY_STATES)[number];

/** A refusal of the journal's own shape; the tool layer turns it into a `ToolRefusal`. */
export class JournalRefusal extends Error {}

export type JournalEntry = {
	/** `jnl_<uuid>`: unique per entry. */
	id: string;
	/** ISO time the journal recorded it. */
	at: string;
	/** The only writer: the gateway, acting as the bot. */
	by: typeof GATEWAY_AGENT_ID;
	kind: JournalKind;
	/** What the bot did, up to `JOURNAL_TEXT_MAX_CHARS`. */
	text: string;
	/** A relay only: the operator's exact words, up to `JOURNAL_QUOTE_MAX_CHARS`. */
	quote?: string;
	/** A relay only: the inbox address the message went to. */
	to?: string;
	/** A relay only: the muster message id the gateway stored it under. */
	ref?: string;
	/** A task only: what became of it. */
	state?: JournalTaskState;
	/** A scheduled task only: when it will run. */
	when?: string;
	/** A dropped task only: why it was dropped. */
	why?: string;
};

/** An entry as `journal_read` and `muster journal` return it: the bot's text marked untrusted. */
export type UntrustedJournalEntry = JournalEntry & {
	untrusted?: true;
	/** The relay check. Absent on a task or an error. */
	relay?: JournalRelayState;
};

/** What a caller hands the store; the store owns the id, the time, the sender and every limit. */
export type JournalInput = Record<string, unknown>;

/** The fields a caller may set, and the kinds each one belongs to. */
const JOURNAL_FIELDS = ["kind", "text", "quote", "to", "ref", "state", "when", "why"] as const;
const FIELDS_BY_KIND: Record<JournalKind, readonly string[]> = {
	relay: ["kind", "text", "quote", "to", "ref"],
	task: ["kind", "text", "state", "when", "why"],
	error: ["kind", "text"],
};

/** The journal directory under a Muster state dir: `<stateDir>/journal`. */
export function journalDir(musterStateDir: string): string {
	return join(musterStateDir, JOURNAL_DIR);
}

/** The one journal file: `<stateDir>/journal/events.jsonl`. Never deleted. */
export function journalEventsPath(musterStateDir: string): string {
	return join(journalDir(musterStateDir), JOURNAL_EVENTS_FILE);
}

function refuse(reason: string): never {
	throw new JournalRefusal(reason);
}

/** Does a non-empty file end without a newline (the torn tail of a crash)? */
function endsWithoutNewline(path: string): boolean {
	let size: number;
	try {
		size = statSync(path).size;
	} catch {
		return false;
	}
	if (size === 0) return false;
	const fd = openSync(path, "r");
	try {
		const byte = Buffer.alloc(1);
		const read = readSync(fd, byte, 0, 1, size - 1);
		return read === 1 && byte[0] !== 0x0a;
	} catch {
		return false;
	} finally {
		closeSync(fd);
	}
}

/** One text field: present when required, a string, non-empty after trimming, within its limit. */
function textField(input: JournalInput, key: string, max: number, required: boolean): string | undefined {
	const value = input[key];
	if (value === undefined) {
		if (required) refuse(`${key} is required`);
		return undefined;
	}
	if (typeof value !== "string") refuse(`${key} must be a string`);
	if (value.length > max) refuse(`${key} is longer than ${max} characters`);
	const trimmed = value.trim();
	if (trimmed === "") refuse(`${key} is empty`);
	return trimmed;
}

/**
 * A `to` is an address the gateway really writes to: the two seats by name, an agent
 * that holds an inbox here (`listInboxAgents`), or the address the relay itself is
 * stored in (`findInboxMessage`, pending or read) — a message the bot just delivered
 * proves the address even after its reader took it.
 */
function assertInboxAddress(musterStateDir: string, to: string, ref: string): void {
	if ((JOURNAL_SEAT_ADDRESSES as readonly string[]).includes(to)) return;
	if (listInboxAgents(musterStateDir).includes(to)) return;
	if (findInboxMessage(musterStateDir, to, ref) !== undefined) return;
	refuse(`${to} is not an inbox address: it is neither a seat (${JOURNAL_SEAT_ADDRESSES.join(", ")}) nor an agent with an inbox here`);
}

/**
 * Build the entry one input describes, or refuse it: an unknown field, a field its kind
 * has no place for, an over-long value, a missing one, or a `to` the gateway cannot write to.
 */
export function journalEntry(musterStateDir: string, input: JournalInput, at: string): JournalEntry {
	if (input === null || typeof input !== "object" || Array.isArray(input)) refuse("an entry must be an object");
	for (const key of Object.keys(input)) {
		if (!(JOURNAL_FIELDS as readonly string[]).includes(key)) refuse(`journal_add has an unknown field: ${key}`);
	}
	const kind = input["kind"];
	if (typeof kind !== "string" || !(JOURNAL_KINDS as readonly string[]).includes(kind)) refuse(`kind must be one of: ${JOURNAL_KINDS.join(", ")}`);
	const entryKind = kind as JournalKind;
	for (const key of Object.keys(input)) {
		if (!FIELDS_BY_KIND[entryKind].includes(key)) refuse(`${key} is not a field of a ${entryKind} entry`);
	}
	const text = textField(input, "text", JOURNAL_TEXT_MAX_CHARS, true)!;
	if (entryKind === "error") return { id: `jnl_${randomUUID()}`, at, by: GATEWAY_AGENT_ID, kind: entryKind, text };
	if (entryKind === "relay") {
		// A relay is the words it carried: without the quote there is nothing to check.
		const quote = textField(input, "quote", JOURNAL_QUOTE_MAX_CHARS, true)!;
		const to = textField(input, "to", JOURNAL_ADDRESS_MAX_CHARS, true)!;
		const ref = textField(input, "ref", JOURNAL_REF_MAX_CHARS, true)!;
		assertInboxAddress(musterStateDir, to, ref);
		return { id: `jnl_${randomUUID()}`, at, by: GATEWAY_AGENT_ID, kind: entryKind, text, quote, to, ref };
	}
	const state = input["state"];
	if (typeof state !== "string" || !(JOURNAL_TASK_STATES as readonly string[]).includes(state)) refuse(`a task needs state, one of: ${JOURNAL_TASK_STATES.join(", ")}`);
	const taskState = state as JournalTaskState;
	const when = textField(input, "when", 64, false);
	if (when !== undefined && taskState !== "scheduled") refuse("when is for a scheduled task only");
	if (taskState === "scheduled" && when === undefined) refuse("a scheduled task needs when (an ISO time)");
	if (when !== undefined && !/^\d{4}-\d{2}-\d{2}T/.test(when)) refuse("when must be an ISO time, such as 2026-10-27T08:00:00.000Z");
	if (when !== undefined && !Number.isFinite(Date.parse(when))) refuse("when must be an ISO time, such as 2026-10-27T08:00:00.000Z");
	const why = textField(input, "why", JOURNAL_WHY_MAX_CHARS, false);
	if (why !== undefined && taskState !== "dropped") refuse("why is for a dropped task only");
	return {
		id: `jnl_${randomUUID()}`,
		at,
		by: GATEWAY_AGENT_ID,
		kind: entryKind,
		text,
		state: taskState,
		...(when !== undefined ? { when } : {}),
		...(why !== undefined ? { why } : {}),
	};
}

/**
 * Append one entry (file mode 0600, fsynced, directory 0700) through the one append body.
 * The append carries a leading newline when the file does not end on one, so a write torn
 * by a crash stays its own unreadable line instead of swallowing the next entry. Nothing
 * here ever rewrites or deletes a line.
 */
export function appendJournal(musterStateDir: string, input: JournalInput, at: string = new Date().toISOString()): JournalEntry {
	const entry = journalEntry(musterStateDir, input, at);
	const repair = endsWithoutNewline(journalEventsPath(musterStateDir)) ? "\n" : "";
	appendFsyncedLine(journalDir(musterStateDir), JOURNAL_EVENTS_FILE, `${repair}${JSON.stringify(entry)}\n`);
	return entry;
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

function isJournalEntry(value: unknown): value is JournalEntry {
	if (value === null || typeof value !== "object") return false;
	const entry = value as Partial<JournalEntry> & Record<string, unknown>;
	if (!(JOURNAL_KINDS as readonly string[]).includes(String(entry["kind"]))) return false;
	if (entry["by"] !== GATEWAY_AGENT_ID) return false;
	if (entry["state"] !== undefined && !(JOURNAL_TASK_STATES as readonly string[]).includes(String(entry["state"]))) return false;
	return nonEmpty(entry["id"]) && nonEmpty(entry["at"]) && nonEmpty(entry["text"]);
}

export type JournalLog = {
	entries: JournalEntry[];
	path: string;
	/** The count of lines the store could not read (a torn tail counts once). */
	partialLastLine: number;
	unreadableLines: number;
};

/** Read the journal file in append order. It never throws on file content. */
export function readJournalLog(musterStateDir: string): JournalLog {
	const path = journalEventsPath(musterStateDir);
	let raw = "";
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		raw = "";
	}
	const entries: JournalEntry[] = [];
	let unreadableLines = 0;
	let partialLastLine = 0;
	const lines = raw.split("\n");
	// Content after the last newline: a torn write (unusable), or a complete line whose
	// newline was lost (usable, and counted: the next append repairs it).
	const trailing = lines.pop() ?? "";
	if (trailing.trim() !== "") {
		partialLastLine = 1;
		try {
			const parsed: unknown = JSON.parse(trailing);
			if (isJournalEntry(parsed)) entries.push(parsed);
		} catch {
			// The torn write itself: counted by `partialLastLine`, not again below.
		}
	}
	for (const line of lines) {
		if (line.trim() === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			unreadableLines += 1;
			continue;
		}
		if (isJournalEntry(parsed)) entries.push(parsed);
		else unreadableLines += 1;
	}
	return { entries, path, partialLastLine, unreadableLines };
}

/** Whitespace collapsed, so a quote matches across the line breaks a relay adds. */
export function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/**
 * The relay check for one entry (UD8): `delivered` when the message it names exists, came
 * from the gateway and holds the quote; `not found in the inbox` when there is no such
 * message (including one filed under that id from someone else, which is not this relay);
 * `the message does not hold these words` when it exists and the text differs. Undefined
 * for a task or an error: only a relay claims to have carried words.
 */
export function journalRelayState(musterStateDir: string, entry: Pick<JournalEntry, "kind" | "to" | "ref" | "quote">): JournalRelayState | undefined {
	if (entry.kind !== "relay") return undefined;
	const message = entry.to !== undefined && entry.ref !== undefined ? findInboxMessage(musterStateDir, entry.to, entry.ref) : undefined;
	if (message === undefined || message.from !== GATEWAY_AGENT_ID) return "not found in the inbox";
	const words = collapseWhitespace(entry.quote ?? "");
	if (words === "") return "the message does not hold these words";
	return collapseWhitespace(message.text).includes(words) ? "delivered" : "the message does not hold these words";
}

export type JournalReadOptions = {
	/** ISO time; only entries at or after it are returned. */
	since?: string;
	kind?: JournalKind;
	/** The newest N entries. */
	limit?: number;
	/**
	 * When set, every entry comes back with `untrusted: true` and both `text` and `quote`
	 * behind this prefix. The gateway and the CLI pass `EXTERNAL_PREFIX`.
	 */
	untrustedPrefix?: string;
};

export type JournalRead = {
	entries: UntrustedJournalEntry[];
	path: string;
	partialLastLine: number;
	unreadableLines: number;
};

/** Read the journal, oldest first, filtered, checked and (when asked) marked untrusted. */
export function readJournal(musterStateDir: string, options: JournalReadOptions = {}): JournalRead {
	const log = readJournalLog(musterStateDir);
	const kind = options.kind;
	let entries = log.entries.filter((entry) => {
		if (options.since !== undefined && entry.at < options.since) return false;
		if (kind !== undefined && entry.kind !== kind) return false;
		return true;
	});
	const limit = clampLimit(options.limit);
	if (entries.length > limit) entries = entries.slice(entries.length - limit);
	const prefix = options.untrustedPrefix;
	return {
		entries: entries.map((entry) => {
			const relay = journalRelayState(musterStateDir, entry);
			return prefix === undefined ? { ...entry, ...(relay !== undefined ? { relay } : {}) } : markUntrusted(entry, prefix, relay);
		}),
		path: log.path,
		partialLastLine: log.partialLastLine,
		unreadableLines: log.unreadableLines,
	};
}

function clampLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return JOURNAL_READ_LIMIT_DEFAULT;
	return Math.min(Math.max(Math.trunc(limit), 1), JOURNAL_READ_LIMIT_MAX);
}

/** Grokbot's own words are external input: neither its text nor its quote reads back as a plain claim. */
export function markUntrusted(entry: JournalEntry, prefix: string, relay: JournalRelayState | undefined): UntrustedJournalEntry {
	const checked = relay !== undefined ? { relay } : {};
	if (entry.by !== GATEWAY_AGENT_ID) return { ...entry, ...checked };
	return {
		...entry,
		untrusted: true,
		text: `${prefix}${entry.text}`,
		...(entry.quote !== undefined ? { quote: `${prefix}${entry.quote}` } : {}),
		...checked,
	};
}
