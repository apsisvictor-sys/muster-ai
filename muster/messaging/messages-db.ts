/**
 * MG1 (VR24-62, rules G2 and G4), the derived half: `messages.db`, a `node:sqlite`
 * index over `raw/` with an FTS5 search. Nothing here is a second source of truth —
 * `rebuild()` replays the archive and the two must match, so any state this file
 * keeps must be derivable from a raw record.
 *
 * Identity (G4): a chat arrives under one id form at a time (`@c.us`, `@lid`,
 * `@g.us`, …). `thread_ids` maps every form the contact list proves to be the same
 * person onto one canonical thread — the `@c.us` form when the list shows it — and
 * `threads` holds that thread once. A message keeps the form it arrived with in
 * `chat_id`; its idempotency key is `<channel>:<thread_id>:<messageId>`, so the same
 * message under both forms is one row. A display name comes from `contacts` only:
 * message text is never consulted (a name a peer controls would be a name it could
 * choose).
 *
 * A thread belongs to its channel (ride-along a, MG3): two channels may use the same
 * chat id, and they are two conversations, so the channel is part of a thread's
 * identity everywhere — the tables, the resolution and the search.
 *
 * Search covers the text of the messages and the replacement text of the edits
 * (ride-along b, MG3): a message that was edited is found by either text, and it
 * shows the text it carries now.
 */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { ArchiveRecord, ArchivedContact, ArchivedEvent, ArchivedMessage, MediaRecord } from "./archive.ts";
import type { ChannelEventKind, MessageSource } from "./types.ts";

/** The thread row: one conversation, under its canonical chat id. */
export type ThreadRow = {
	threadId: string;
	channel: string;
	/** The name the contact list holds, or null when it holds none (the page shows the number). */
	displayName: string | null;
	firstRecordedAt: string;
	/** The channel timestamp of the newest message, epoch ms, or null for a thread with no message. */
	lastMessageAt: number | null;
	messageCount: number;
};

/** One message of a thread, with the changes archived against it. */
export type ThreadMessage = {
	threadId: string;
	channel: string;
	messageId: string;
	/** The chat id form this message arrived with. */
	chatId: string;
	timestamp: number;
	fromMe: boolean;
	senderId: string | null;
	type: string;
	/** The text as first archived. An edit never changes it; the event carries the new text. */
	text: string;
	source: MessageSource;
	media: MediaRecord | null;
	recordedAt: string;
	events: ThreadEvent[];
};

/** One edit, deletion or revoke. */
export type ThreadEvent = {
	threadId: string;
	messageId: string;
	event: ChannelEventKind;
	/** When the channel reported the change. */
	at: string;
	/** The replacement text of an edit. */
	text: string | null;
	recordedAt: string;
};

export type ThreadView = { thread: ThreadRow; messages: ThreadMessage[]; events: ThreadEvent[] };

/** One search result: the match marked in its own neighbourhood. */
/** MG4: the closed answer sets of `classifier-questions/messaging-triage.json`, as stored. */
export type TriageNeedsReply = "yes" | "no" | "unsure";
export type TriageUrgency = "now" | "today" | "later";
export type TriageKind = "personal" | "business" | "vendor" | "automated" | "other";

/**
 * `triaged` when the classifier answered inside its sets, `untriaged` when the call
 * failed or the answer was outside them. An untriaged row is what the page shows as
 * needing an eye; it never holds an invented answer.
 */
export type TriageState = "triaged" | "untriaged";

/**
 * One thread's triage, and the call that produced it. Ids, closed sets, token counts
 * and money only: a chat's text is never written here (rule G5).
 */
export type TriageRow = {
	channel: string;
	threadId: string;
	state: TriageState;
	/** Null unless the thread was triaged. */
	needsReply: TriageNeedsReply | null;
	urgency: TriageUrgency | null;
	kind: TriageKind | null;
	/** The newest message the answer covers: what "new inbound text" is measured from next run. */
	basisMessageId: string;
	basisTimestamp: number;
	questionSet: string;
	setVersion: number;
	triagedAt: string;
	model: string;
	/** Why the thread is untriaged (`ceiling`, `error`, a stop reason), null when it was triaged. */
	stopReason: string | null;
	inputTokens: number | null;
	outputTokens: number | null;
	costUsd: number | null;
	/** Bytes of the state handed to the classifier, never the state. */
	stateBytes: number;
};

/**
 * MG5: one draft of one thread, and the call that produced it. Like the triage row,
 * a draft names its thread by a fingerprint and never by its chat id: a WhatsApp chat
 * id is a phone number (G11). The draft's text is here because it is the text the operator
 * reads before anything is sent; it never leaves the store.
 */
export type DraftRow = {
	/** The draft's own id: the thread, the basis and the text, hashed. */
	draftId: string;
	channel: string;
	/** The first 12 hex of the SHA-256 of the thread id. */
	threadFingerprint: string;
	/** SHA-256 of the canonical chat id and the text (G6, recomputed by the send gate). */
	hash: string;
	/** The first 12 hex of the hash: the short form the ask's source carries. */
	hash12: string;
	/** The text of the draft. */
	text: string;
	/** The channel timestamp of the newest message the draft was written from. */
	basisTimestamp: number;
	/** The fingerprint of the basis message id, never the id: a WAHA id carries the chat id. */
	basisMessageHash: string;
	createdAt: string;
	/** The model that wrote it. */
	model: string;
};

/** What one writer call did: a draft written, a draft refused, or a call that failed. */
export type DraftCallStatus = "written" | "rejected" | "error";

export type DraftCallRow = {
	/** The draft the call wrote, null when it wrote none. */
	draftId: string | null;
	channel: string;
	threadFingerprint: string;
	at: string;
	model: string;
	status: DraftCallStatus;
	/** Why no draft was written (`empty`, `too-long`, `not-text`), or the error's own words. */
	stopReason: string;
	/** Characters of the answer the validator accepted. */
	textLength: number;
	/** Bytes of the prompt handed to the writer. */
	promptBytes: number;
	inputTokens: number | null;
	outputTokens: number | null;
	costUsd: number | null;
	latencyMs: number;
	error: string | null;
};

export type SearchHit = {
	threadId: string;
	channel: string;
	displayName: string | null;
	messageId: string;
	timestamp: number;
	/** The message text with `[…]` around the match and its neighbouring words. */
	snippet: string;
	source: MessageSource;
	/** The text the message carries now: the newest edit's replacement, else the text as first archived. */
	currentText: string;
	/** True when the message was edited after it was archived (the original stays findable). */
	edited: boolean;
};

export type StoreCounts = { messages: number; events: number; threads: number; contacts: number };

/** What one indexed record did: which thread it belongs to, and whether the index already held it. */
export type IndexOutcome = { threadId: string; duplicate: boolean };

/** How many messages one thread view returns unless the caller asks for another number. */
export const DEFAULT_THREAD_LIMIT = 200;
/** How many threads or search results a listing returns unless the caller asks for another number. */
export const DEFAULT_LIST_LIMIT = 100;
/** FTS5 keeps this many words around a match in a snippet. */
const SNIPPET_TOKENS = 12;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
	channel TEXT NOT NULL,
	thread_id TEXT NOT NULL,
	display_name TEXT,
	first_recorded_at TEXT NOT NULL,
	last_message_at INTEGER,
	PRIMARY KEY (channel, thread_id)
);
CREATE TABLE IF NOT EXISTS thread_ids (
	channel TEXT NOT NULL,
	chat_id TEXT NOT NULL,
	thread_id TEXT NOT NULL,
	PRIMARY KEY (channel, chat_id)
);
CREATE INDEX IF NOT EXISTS thread_ids_by_thread ON thread_ids(channel, thread_id);
CREATE TABLE IF NOT EXISTS contacts (
	channel TEXT NOT NULL,
	contact_id TEXT NOT NULL,
	thread_id TEXT NOT NULL,
	name TEXT,
	payload TEXT NOT NULL,
	recorded_at TEXT NOT NULL,
	PRIMARY KEY (channel, contact_id)
);
CREATE TABLE IF NOT EXISTS messages (
	thread_id TEXT NOT NULL,
	channel TEXT NOT NULL,
	message_id TEXT NOT NULL,
	chat_id TEXT NOT NULL,
	idem_key TEXT NOT NULL,
	timestamp INTEGER NOT NULL,
	from_me INTEGER NOT NULL,
	sender_id TEXT,
	type TEXT NOT NULL,
	text TEXT NOT NULL DEFAULT '',
	source TEXT NOT NULL,
	media TEXT,
	payload TEXT NOT NULL,
	recorded_at TEXT NOT NULL,
	PRIMARY KEY (channel, thread_id, message_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_idem_key ON messages(idem_key);
CREATE INDEX IF NOT EXISTS messages_by_thread ON messages(channel, thread_id, timestamp);
CREATE TABLE IF NOT EXISTS message_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	channel TEXT NOT NULL,
	thread_id TEXT NOT NULL,
	message_id TEXT NOT NULL,
	event TEXT NOT NULL,
	at TEXT NOT NULL,
	recorded_at TEXT NOT NULL,
	text TEXT,
	payload TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS message_events_identity ON message_events(channel, thread_id, message_id, event, at);
CREATE INDEX IF NOT EXISTS message_events_by_thread ON message_events(channel, thread_id, at);
-- MG4: one triage row per (channel, thread). The one table the archive cannot replay.
CREATE TABLE IF NOT EXISTS thread_triage (
	channel TEXT NOT NULL,
	thread_id TEXT NOT NULL,
	state TEXT NOT NULL,
	needs_reply TEXT,
	urgency TEXT,
	kind TEXT,
	basis_message_id TEXT NOT NULL,
	basis_timestamp INTEGER NOT NULL,
	question_set TEXT NOT NULL,
	set_version INTEGER NOT NULL,
	triaged_at TEXT NOT NULL,
	model TEXT NOT NULL,
	stop_reason TEXT,
	input_tokens INTEGER,
	output_tokens INTEGER,
	cost_usd REAL,
	state_bytes INTEGER NOT NULL,
	PRIMARY KEY (channel, thread_id)
);
CREATE INDEX IF NOT EXISTS thread_triage_by_state ON thread_triage(state, triaged_at);
-- MG5: one draft row per (thread, basis, text), and one row per writer call. The other
-- tables the archive cannot replay: a draft is written by a model, never by a channel.
CREATE TABLE IF NOT EXISTS thread_drafts (
	draft_id TEXT NOT NULL PRIMARY KEY,
	channel TEXT NOT NULL,
	thread_fingerprint TEXT NOT NULL,
	hash TEXT NOT NULL,
	hash12 TEXT NOT NULL,
	text TEXT NOT NULL,
	basis_timestamp INTEGER NOT NULL,
	basis_message_hash TEXT NOT NULL,
	created_at TEXT NOT NULL,
	model TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS thread_drafts_by_thread ON thread_drafts(channel, thread_fingerprint, created_at);
CREATE TABLE IF NOT EXISTS draft_calls (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	draft_id TEXT,
	channel TEXT NOT NULL,
	thread_fingerprint TEXT NOT NULL,
	at TEXT NOT NULL,
	model TEXT NOT NULL,
	status TEXT NOT NULL,
	stop_reason TEXT NOT NULL,
	text_length INTEGER NOT NULL,
	prompt_bytes INTEGER NOT NULL,
	input_tokens INTEGER,
	output_tokens INTEGER,
	cost_usd REAL,
	latency_ms INTEGER NOT NULL,
	error TEXT
);
CREATE INDEX IF NOT EXISTS draft_calls_by_draft ON draft_calls(draft_id);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
	text,
	content='messages',
	content_rowid='rowid',
	tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
	INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
	INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN
	INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
	INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE VIRTUAL TABLE IF NOT EXISTS message_events_fts USING fts5(
	event_id UNINDEXED,
	text,
	tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS message_events_fts_insert AFTER INSERT ON message_events BEGIN
	INSERT INTO message_events_fts(event_id, text) VALUES (new.id, COALESCE(new.text, ''));
END;
CREATE TRIGGER IF NOT EXISTS message_events_fts_delete AFTER DELETE ON message_events BEGIN
	DELETE FROM message_events_fts WHERE event_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS message_events_fts_update AFTER UPDATE ON message_events BEGIN
	DELETE FROM message_events_fts WHERE event_id = old.id;
	INSERT INTO message_events_fts(event_id, text) VALUES (new.id, COALESCE(new.text, ''));
END;
`;

/**
 * The schema version the index carries. The index is derived state, so a file written
 * by another version of the schema is not migrated: it is recreated from `raw/`,
 * which is the truth (G2).
 */
export const SCHEMA_VERSION = 3;

/** Opens (or creates) one index and holds its schema. */
export function openIndex(path: string): DatabaseSync {
	const db = new DatabaseSync(path);
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = FULL");
	db.exec(SCHEMA);
	db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	return db;
}

/**
 * Whether an index file was written by another schema version.
 *
 * A file that cannot be opened because another process holds it is *not* stale: the
 * sync job may be using the index right now, and a database in use is never deleted
 * (R1). Only a file that is not a database, or a damaged one, may be rebuilt — and
 * the index is derived state, so the archive rebuilds it (G2).
 */
export function indexIsStale(path: string): boolean {
	if (!existsSync(path)) return false;
	let version = -1;
	try {
		const db = new DatabaseSync(path);
		try {
			const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
			version = row === undefined ? -1 : Number(row.user_version);
		} finally {
			db.close();
		}
	} catch (err) {
		return isDamagedIndex(err);
	}
	return version !== SCHEMA_VERSION;
}

/** The SQLite codes that mean the file itself is damaged: SQLITE_CORRUPT and SQLITE_NOTADB. */
const DAMAGED_INDEX_CODES = new Set([11, 26]);

/**
 * True when the error says the file is damaged, not that it is in use by someone else.
 * The store's rebuild asks the same question (R1): only a damaged file may yield no rows.
 */
export function isDamagedIndex(err: unknown): boolean {
	const code = (err as { errcode?: unknown }).errcode;
	if (typeof code === "number") return DAMAGED_INDEX_CODES.has(code);
	const text = err instanceof Error ? err.message : String(err);
	return /not a database|malformed|corrupt/i.test(text);
}

/** Runs `work` in one immediate transaction, so a merge cannot land half done. */
export function inTransaction<T>(db: DatabaseSync, work: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = work();
		db.exec("COMMIT");
		return result;
	} catch (err) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// The transaction is already gone; the caller's error is the one worth raising.
		}
		throw err;
	}
}

/**
 * The canonical form of a set of id forms: the `@c.us` one when the contact list
 * shows it, else the first. The mapping is evidence, never a guess at digits.
 */
export function canonicalForm(ids: string[]): string {
	const forms = ids.map((id) => id.trim()).filter((id) => id.length > 0);
	if (forms.length === 0) throw new Error("messaging index: a thread needs at least one chat id");
	return forms.find((id) => id.endsWith("@c.us")) ?? forms[0];
}

/** Indexes one archived record. The only write path; `rebuild()` uses it too. */
export function indexRecord(db: DatabaseSync, record: ArchiveRecord): IndexOutcome {
	switch (record.kind) {
		case "contact":
			return indexContact(db, record);
		case "message":
			return indexMessage(db, record);
		case "event":
			return indexEvent(db, record);
	}
}

/** What the index says about a record the caller is about to archive. */
export type HeldCheck = { held: false } | { held: true; threadId: string };

/**
 * Whether the index already holds this record, asked before the archive is written so
 * an overlapping pull adds no second copy to `raw/` (R2 of the Fix-gate verdict). The
 * index is read-only here: an unknown chat is simply a record it cannot hold yet.
 */
export function heldRecord(db: DatabaseSync, record: ArchiveRecord): HeldCheck {
	switch (record.kind) {
		case "message": {
			const threadId = mappingOf(db, record.channel, record.chatId);
			if (threadId === null) return { held: false };
			const row = db
				.prepare("SELECT 1 FROM messages WHERE channel = ? AND thread_id = ? AND message_id = ?")
				.get(record.channel, threadId, record.messageId);
			return row === undefined ? { held: false } : { held: true, threadId };
		}
		case "event": {
			const threadId = mappingOf(db, record.channel, record.chatId);
			if (threadId === null) return { held: false };
			const row = db
				.prepare("SELECT 1 FROM message_events WHERE channel = ? AND thread_id = ? AND message_id = ? AND event = ? AND at = ?")
				.get(record.channel, threadId, record.messageId, record.event, record.at);
			return row === undefined ? { held: false } : { held: true, threadId };
		}
		case "contact": {
			const threadId = mappingOf(db, record.channel, record.contactId);
			if (threadId === null) return { held: false };
			const row = db.prepare("SELECT name, payload FROM contacts WHERE channel = ? AND contact_id = ?").get(
				record.channel,
				record.contactId,
			) as { name: string | null; payload: string } | undefined;
			const same =
				row !== undefined && row.name === (record.name ?? null) && row.payload === JSON.stringify(record.payload ?? null);
			return same ? { held: true, threadId } : { held: false };
		}
	}
}

/** The thread of one id form, creating it when this is the first sighting. */
function threadOfChat(db: DatabaseSync, channel: string, chatId: string, recordedAt: string): string {
	const mapped = mappingOf(db, channel, chatId);
	if (mapped !== null) return mapped;
	ensureThread(db, channel, chatId, recordedAt);
	return chatId;
}

function mappingOf(db: DatabaseSync, channel: string, chatId: string): string | null {
	const row = db.prepare("SELECT thread_id FROM thread_ids WHERE channel = ? AND chat_id = ?").get(channel, chatId) as
		| { thread_id: string }
		| undefined;
	return row?.thread_id ?? null;
}

function ensureThread(db: DatabaseSync, channel: string, threadId: string, recordedAt: string): void {
	const existing = db.prepare("SELECT thread_id FROM threads WHERE channel = ? AND thread_id = ?").get(channel, threadId);
	if (existing === undefined) {
		db.prepare("INSERT INTO threads (channel, thread_id, display_name, first_recorded_at, last_message_at) VALUES (?, ?, NULL, ?, NULL)").run(
			channel,
			threadId,
			recordedAt,
		);
	}
	mapFormTo(db, channel, threadId, threadId, recordedAt);
}

/** Maps one id form onto a canonical thread, merging a thread the form already had. */
function mapFormTo(db: DatabaseSync, channel: string, form: string, canonical: string, recordedAt: string): void {
	const current = mappingOf(db, channel, form);
	if (current === canonical) return;
	if (current === null) {
		db.prepare("INSERT INTO thread_ids (channel, chat_id, thread_id) VALUES (?, ?, ?)").run(channel, form, canonical);
		return;
	}
	ensureThread(db, channel, canonical, recordedAt);
	mergeThread(db, channel, current, canonical);
}

/**
 * Moves everything the thread `from` holds onto `to`. A message both threads already
 * hold is dropped from `from`: the same message is one row, and `raw/` keeps both
 * records for a rebuild to dedupe the same way.
 */
function mergeThread(db: DatabaseSync, channel: string, from: string, to: string): void {
	if (from === to) return;
	const source = db
		.prepare("SELECT thread_id, first_recorded_at, last_message_at FROM threads WHERE channel = ? AND thread_id = ?")
		.get(channel, from) as { thread_id: string; first_recorded_at: string; last_message_at: number | null } | undefined;
	const target = db
		.prepare("SELECT thread_id, first_recorded_at, last_message_at FROM threads WHERE channel = ? AND thread_id = ?")
		.get(channel, to) as { thread_id: string; first_recorded_at: string; last_message_at: number | null } | undefined;
	if (source === undefined) return;

	const messages = db.prepare("SELECT message_id FROM messages WHERE channel = ? AND thread_id = ?").all(channel, from) as Array<{
		message_id: string;
	}>;
	for (const message of messages) {
		const clash = db
			.prepare("SELECT 1 FROM messages WHERE channel = ? AND thread_id = ? AND message_id = ?")
			.get(channel, to, message.message_id);
		if (clash !== undefined) {
			db.prepare("DELETE FROM messages WHERE channel = ? AND thread_id = ? AND message_id = ?").run(channel, from, message.message_id);
		} else {
			db.prepare("UPDATE messages SET thread_id = ?, idem_key = ? WHERE channel = ? AND thread_id = ? AND message_id = ?").run(
				to,
				`${channel}:${to}:${message.message_id}`,
				channel,
				from,
				message.message_id,
			);
		}
	}
	db.prepare("UPDATE message_events SET thread_id = ? WHERE channel = ? AND thread_id = ?").run(to, channel, from);
	db.prepare("UPDATE contacts SET thread_id = ? WHERE channel = ? AND thread_id = ?").run(to, channel, from);
	db.prepare("UPDATE thread_ids SET thread_id = ? WHERE channel = ? AND thread_id = ?").run(to, channel, from);
	db.prepare("DELETE FROM threads WHERE channel = ? AND thread_id = ?").run(channel, from);

	const firstRecordedAt =
		target !== undefined && target.first_recorded_at < source.first_recorded_at ? target.first_recorded_at : source.first_recorded_at;
	const lastMessageAt = Math.max(target?.last_message_at ?? Number.NEGATIVE_INFINITY, source.last_message_at ?? Number.NEGATIVE_INFINITY);
	db.prepare("UPDATE threads SET first_recorded_at = ?, last_message_at = ? WHERE channel = ? AND thread_id = ?").run(
		firstRecordedAt,
		Number.isFinite(lastMessageAt) ? lastMessageAt : null,
		channel,
		to,
	);
}

function indexMessage(db: DatabaseSync, record: ArchivedMessage): IndexOutcome {
	const threadId = threadOfChat(db, record.channel, record.chatId, record.recordedAt);
	const info = db
		.prepare(
			`INSERT OR IGNORE INTO messages
				(thread_id, channel, message_id, chat_id, idem_key, timestamp, from_me, sender_id, type, text, source, media, payload, recorded_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			threadId,
			record.channel,
			record.messageId,
			record.chatId,
			`${record.channel}:${threadId}:${record.messageId}`,
			record.timestamp,
			record.fromMe ? 1 : 0,
			record.senderId ?? null,
			record.type,
			record.text ?? "",
			record.source,
			record.media ? JSON.stringify(record.media) : null,
			JSON.stringify(record.payload ?? null),
			record.recordedAt,
		);
	db.prepare(
		"UPDATE threads SET last_message_at = ? WHERE channel = ? AND thread_id = ? AND (last_message_at IS NULL OR last_message_at < ?)",
	).run(record.timestamp, record.channel, threadId, record.timestamp);
	return { threadId, duplicate: Number(info.changes) === 0 };
}

function indexEvent(db: DatabaseSync, record: ArchivedEvent): IndexOutcome {
	const threadId = threadOfChat(db, record.channel, record.chatId, record.recordedAt);
	const info = db
		.prepare(
			`INSERT OR IGNORE INTO message_events (channel, thread_id, message_id, event, at, recorded_at, text, payload)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			record.channel,
			threadId,
			record.messageId,
			record.event,
			record.at,
			record.recordedAt,
			record.text ?? null,
			record.payload === undefined ? null : JSON.stringify(record.payload),
		);
	return { threadId, duplicate: Number(info.changes) === 0 };
}

function indexContact(db: DatabaseSync, record: ArchivedContact): IndexOutcome {
	const forms = [record.contactId, ...(record.aliases ?? [])];
	const canonical = canonicalForm(forms);
	ensureThread(db, record.channel, canonical, record.recordedAt);
	for (const form of forms) mapFormTo(db, record.channel, form.trim(), canonical, record.recordedAt);

	const payload = JSON.stringify(record.payload ?? null);
	const name = record.name ?? null;
	const existing = db.prepare("SELECT thread_id, name, payload FROM contacts WHERE channel = ? AND contact_id = ?").get(
		record.channel,
		record.contactId,
	) as { thread_id: string; name: string | null; payload: string } | undefined;
	const duplicate = existing !== undefined && existing.thread_id === canonical && existing.name === name && existing.payload === payload;
	db.prepare(
		`INSERT INTO contacts (channel, contact_id, thread_id, name, payload, recorded_at) VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(channel, contact_id) DO UPDATE SET thread_id = excluded.thread_id, name = excluded.name,
			payload = excluded.payload, recorded_at = excluded.recorded_at`,
	).run(record.channel, record.contactId, canonical, name, payload, record.recordedAt);
	refreshThreadName(db, record.channel, canonical);
	return { threadId: canonical, duplicate };
}

/** The thread's name is the contact list's, preferring the entry for the canonical form. */
function refreshThreadName(db: DatabaseSync, channel: string, threadId: string): void {
	const row = db
		.prepare(
			`SELECT name FROM contacts WHERE channel = ? AND thread_id = ? AND name IS NOT NULL AND name <> ''
			 ORDER BY (contact_id = ?) DESC, contact_id LIMIT 1`,
		)
		.get(channel, threadId, threadId) as { name: string } | undefined;
	db.prepare("UPDATE threads SET display_name = ? WHERE channel = ? AND thread_id = ?").run(row?.name ?? null, channel, threadId);
}

/** One thread as the index names it: the channel it belongs to, and its canonical chat id. */
export type ThreadRef = { channel: string; threadId: string };

/**
 * Every thread an id form or a thread id names. A chat id can live in more than one
 * channel (ride-along a: two channels may share one chat id), and those are two
 * conversations, so the caller names the channel when it wants one of them.
 */
export function resolveThreadRefs(db: DatabaseSync, chatOrThreadId: string, channel?: string): ThreadRef[] {
	const refs = new Map<string, ThreadRef>();
	const add = (refChannel: string, threadId: string): void => {
		refs.set(`${refChannel}\u0000${threadId}`, { channel: refChannel, threadId });
	};
	if (channel !== undefined) {
		const direct = db.prepare("SELECT thread_id FROM threads WHERE channel = ? AND thread_id = ?").get(channel, chatOrThreadId) as
			| { thread_id: string }
			| undefined;
		if (direct !== undefined) add(channel, direct.thread_id);
		const mapped = db.prepare("SELECT thread_id FROM thread_ids WHERE channel = ? AND chat_id = ?").get(channel, chatOrThreadId) as
			| { thread_id: string }
			| undefined;
		if (mapped !== undefined) add(channel, mapped.thread_id);
		return [...refs.values()];
	}
	const direct = db.prepare("SELECT channel, thread_id FROM threads WHERE thread_id = ?").all(chatOrThreadId) as Array<{
		channel: string;
		thread_id: string;
	}>;
	for (const row of direct) add(row.channel, row.thread_id);
	const mapped = db.prepare("SELECT channel, thread_id FROM thread_ids WHERE chat_id = ?").all(chatOrThreadId) as Array<{
		channel: string;
		thread_id: string;
	}>;
	for (const row of mapped) add(row.channel, row.thread_id);
	return [...refs.values()];
}

/**
 * The thread id an id form or a thread id names, or null when nothing holds it — or
 * when more than one channel holds it, because a thread belongs to its channel and
 * the caller has to name which one it means.
 */
export function resolveThreadId(db: DatabaseSync, chatOrThreadId: string, channel?: string): string | null {
	const refs = resolveThreadRefs(db, chatOrThreadId, channel);
	return refs.length === 1 ? refs[0]!.threadId : null;
}

/** Every id form mapped onto one thread of one channel. */
export function threadIdsOf(db: DatabaseSync, channel: string, threadId: string): string[] {
	const rows = db
		.prepare("SELECT chat_id FROM thread_ids WHERE channel = ? AND thread_id = ? ORDER BY chat_id")
		.all(channel, threadId) as Array<{ chat_id: string }>;
	return rows.map((row) => row.chat_id);
}

/** The threads, newest message first, with a thread that has none last. */
export function listThreads(db: DatabaseSync, limit: number = DEFAULT_LIST_LIMIT): ThreadRow[] {
	const rows = db
		.prepare(
			`SELECT t.thread_id, t.channel, t.display_name, t.first_recorded_at, t.last_message_at,
				(SELECT COUNT(*) FROM messages m WHERE m.channel = t.channel AND m.thread_id = t.thread_id) AS message_count
				FROM threads t
				ORDER BY (t.last_message_at IS NULL), t.last_message_at DESC, t.thread_id, t.channel
				LIMIT ?`,
		)
		.all(limit) as Array<{
		thread_id: string;
		channel: string;
		display_name: string | null;
		first_recorded_at: string;
		last_message_at: number | null;
		message_count: number;
	}>;
	return rows.map(threadOf);
}

function threadOf(row: {
	thread_id: string;
	channel: string;
	display_name: string | null;
	first_recorded_at: string;
	last_message_at: number | null;
	message_count: number;
}): ThreadRow {
	return {
		threadId: row.thread_id,
		channel: row.channel,
		displayName: row.display_name,
		firstRecordedAt: row.first_recorded_at,
		lastMessageAt: row.last_message_at,
		messageCount: Number(row.message_count),
	};
}

/** One thread row, or null when nothing holds that thread of that channel. */
export function threadRow(db: DatabaseSync, channel: string, threadId: string): ThreadRow | null {
	const row = db
		.prepare(
			`SELECT t.thread_id, t.channel, t.display_name, t.first_recorded_at, t.last_message_at,
				(SELECT COUNT(*) FROM messages m WHERE m.channel = t.channel AND m.thread_id = t.thread_id) AS message_count
				FROM threads t WHERE t.channel = ? AND t.thread_id = ?`,
		)
		.get(channel, threadId) as
		| {
				thread_id: string;
				channel: string;
				display_name: string | null;
				first_recorded_at: string;
				last_message_at: number | null;
				message_count: number;
		  }
		| undefined;
	return row === undefined ? null : threadOf(row);
}

/** One thread: its newest `limit` messages in order, every event of the thread, and each message's own events. */
export function readThread(
	db: DatabaseSync,
	chatOrThreadId: string,
	limit: number = DEFAULT_THREAD_LIMIT,
	channel?: string,
): ThreadView {
	const refs = resolveThreadRefs(db, chatOrThreadId, channel);
	if (refs.length === 0) throw new Error(`messaging index: no thread for ${chatOrThreadId}`);
	if (refs.length > 1) {
		const channels = refs.map((ref) => ref.channel).join(", ");
		throw new Error(`messaging index: ${chatOrThreadId} is in ${refs.length} channels (${channels}); name one`);
	}
	const ref = refs[0]!;
	const threadId = ref.threadId;
	const thread = threadRow(db, ref.channel, threadId);
	if (thread === null) throw new Error(`messaging index: thread ${threadId} holds no row`);

	const rows = db
		.prepare(
			`SELECT * FROM (
				SELECT thread_id, channel, message_id, chat_id, timestamp, from_me, sender_id, type, text, source, media, recorded_at
				FROM messages WHERE channel = ? AND thread_id = ? ORDER BY timestamp DESC, message_id DESC LIMIT ?
			) ORDER BY timestamp, message_id`,
		)
		.all(ref.channel, threadId, limit) as Array<{
		thread_id: string;
		channel: string;
		message_id: string;
		chat_id: string;
		timestamp: number;
		from_me: number;
		sender_id: string | null;
		type: string;
		text: string;
		source: string;
		media: string | null;
		recorded_at: string;
	}>;
	const eventRows = db
		.prepare(
			"SELECT thread_id, message_id, event, at, text, recorded_at FROM message_events WHERE channel = ? AND thread_id = ? ORDER BY at, id",
		)
		.all(ref.channel, threadId) as Array<{
		thread_id: string;
		message_id: string;
		event: string;
		at: string;
		text: string | null;
		recorded_at: string;
	}>;
	const events: ThreadEvent[] = eventRows.map((row) => ({
		threadId: row.thread_id,
		messageId: row.message_id,
		event: row.event as ChannelEventKind,
		at: row.at,
		text: row.text,
		recordedAt: row.recorded_at,
	}));

	const messages: ThreadMessage[] = rows.map((row) => ({
		threadId: row.thread_id,
		channel: row.channel,
		messageId: row.message_id,
		chatId: row.chat_id,
		timestamp: Number(row.timestamp),
		fromMe: Number(row.from_me) === 1,
		senderId: row.sender_id,
		type: row.type,
		text: row.text,
		source: row.source as MessageSource,
		media: row.media === null ? null : (JSON.parse(row.media) as MediaRecord),
		recordedAt: row.recorded_at,
		events: events.filter((event) => event.messageId === row.message_id),
	}));
	return { thread, messages, events };
}

/** One row of a search, before the current text of the message it points at is known. */
type HitRow = {
	thread_id: string;
	channel: string;
	display_name: string | null;
	message_id: string;
	timestamp: number;
	source: string;
	snippet: string;
	text: string;
};

/** The key one hit is one message: its channel, its thread and its message id. */
function hitKey(row: { channel: string; thread_id: string; message_id: string }): string {
	return `${row.channel}\u0000${row.thread_id}\u0000${row.message_id}`;
}

/**
 * Searches the archived text: the messages as they were first archived, and the
 * replacement text of the edits (ride-along b). The words are first taken together as
 * one phrase — the match is then one block inside its own neighbourhood — and a query
 * whose words are not adjacent falls back to every word being present, so a sentence
 * typed into the box still finds what it describes.
 *
 * A message that was edited is found by either text and shows the text it carries
 * now; the text it was archived with stays findable, because the archive keeps both
 * (G2).
 */
export function searchIndex(db: DatabaseSync, query: string, limit: number = DEFAULT_LIST_LIMIT): SearchHit[] {
	const tokens = query.match(/[\p{L}\p{N}]+/gu) ?? [];
	if (tokens.length === 0) return [];
	const phrase = `"${tokens.join(" ")}"`;
	const everyWord = tokens.map((token) => `"${token}"`).join(" AND ");
	const messageRows = firstRows([rowsFor(db, phrase, limit), rowsFor(db, everyWord, limit)]);
	const eventRows = firstRows([eventRowsFor(db, phrase, limit), eventRowsFor(db, everyWord, limit)]);

	const merged = new Map<string, HitRow>();
	for (const row of messageRows) merged.set(hitKey(row), row);
	for (const row of eventRows) {
		const key = hitKey(row);
		if (!merged.has(key)) merged.set(key, row);
	}

	const events = eventsOf(db, [...merged.values()]);
	const hits: SearchHit[] = [];
	for (const row of merged.values()) {
		const own = events.get(hitKey(row)) ?? [];
		const edits = own.filter((event) => event.event === "edited" && event.text !== null);
		const newest = edits[edits.length - 1];
		const currentText = newest?.text ?? row.text;
		hits.push({
			threadId: row.thread_id,
			channel: row.channel,
			displayName: row.display_name,
			messageId: row.message_id,
			timestamp: Number(row.timestamp),
			snippet: newest === undefined ? row.snippet : contextWindow(currentText, tokens),
			source: row.source as MessageSource,
			currentText,
			edited: newest !== undefined,
		});
	}
	hits.sort((left, right) => right.timestamp - left.timestamp || left.messageId.localeCompare(right.messageId));
	return hits.slice(0, limit);
}

/** The first set of rows that holds anything: the phrase first, the words second. */
function firstRows(sets: HitRow[][]): HitRow[] {
	for (const rows of sets) if (rows.length > 0) return rows;
	return [];
}

/** The messages that hold the words of the query. */
function rowsFor(db: DatabaseSync, match: string, limit: number): HitRow[] {
	return db
		.prepare(
			`SELECT m.thread_id, m.channel, t.display_name, m.message_id, m.timestamp, m.source, m.text,
				snippet(messages_fts, 0, '[', ']', '…', ${SNIPPET_TOKENS}) AS snippet
				FROM messages_fts
				JOIN messages m ON m.rowid = messages_fts.rowid
				JOIN threads t ON t.channel = m.channel AND t.thread_id = m.thread_id
				WHERE messages_fts MATCH ?
				ORDER BY m.timestamp DESC, m.message_id
				LIMIT ?`,
		)
		.all(match, limit) as HitRow[];
}

/** The messages whose edit carries the words of the query. */
function eventRowsFor(db: DatabaseSync, match: string, limit: number): HitRow[] {
	return db
		.prepare(
			`SELECT m.thread_id, m.channel, t.display_name, m.message_id, m.timestamp, m.source, m.text,
				snippet(message_events_fts, 1, '[', ']', '…', ${SNIPPET_TOKENS}) AS snippet
				FROM message_events_fts
				JOIN message_events e ON e.id = message_events_fts.event_id
				JOIN messages m ON m.channel = e.channel AND m.thread_id = e.thread_id AND m.message_id = e.message_id
				JOIN threads t ON t.channel = m.channel AND t.thread_id = m.thread_id
				WHERE message_events_fts MATCH ?
				ORDER BY m.timestamp DESC, m.message_id
				LIMIT ?`,
		)
		.all(match, limit) as HitRow[];
}

/** The archived changes of the messages a search hit. */
function eventsOf(db: DatabaseSync, rows: HitRow[]): Map<string, ThreadEvent[]> {
	const byKey = new Map<string, ThreadEvent[]>();
	if (rows.length === 0) return byKey;
	const wanted = new Set(rows.map(hitKey));
	const threadIds = [...new Set(rows.map((row) => row.thread_id))];
	const placeholders = threadIds.map(() => "?").join(", ");
	const found = db
		.prepare(
			`SELECT channel, thread_id, message_id, event, at, text, recorded_at FROM message_events
				WHERE thread_id IN (${placeholders}) ORDER BY at, id`,
		)
		.all(...threadIds) as Array<{
		channel: string;
		thread_id: string;
		message_id: string;
		event: string;
		at: string;
		text: string | null;
		recorded_at: string;
	}>;
	for (const row of found) {
		const key = `${row.channel}\u0000${row.thread_id}\u0000${row.message_id}`;
		if (!wanted.has(key)) continue;
		const list = byKey.get(key) ?? [];
		list.push({
			threadId: row.thread_id,
			messageId: row.message_id,
			event: row.event as ChannelEventKind,
			at: row.at,
			text: row.text,
			recordedAt: row.recorded_at,
		});
		byKey.set(key, list);
	}
	return byKey;
}

/**
 * A window of the text around the first word of the query, marked the way the FTS
 * snippet marks it. It is what a message that was edited shows: the text it carries
 * now, with the words around the match.
 */
function contextWindow(text: string, tokens: string[]): string {
	const words = text.split(/\s+/).filter((word) => word.length > 0);
	if (words.length === 0) return "";
	const lowered = words.map((word) => word.toLowerCase());
	let hit = -1;
	for (const token of tokens) {
		const needle = token.toLowerCase();
		hit = lowered.findIndex((word) => word.includes(needle));
		if (hit >= 0) break;
	}
	if (hit < 0) {
		const head = words.slice(0, SNIPPET_TOKENS * 2).join(" ");
		return words.length > SNIPPET_TOKENS * 2 ? `${head}…` : head;
	}
	const start = Math.max(0, hit - SNIPPET_TOKENS);
	const end = Math.min(words.length, hit + SNIPPET_TOKENS + 1);
	const window = words
		.slice(start, end)
		.map((word, index) => (index === hit - start ? `[${word}]` : word))
		.join(" ");
	return start > 0 ? `…${window}` : window;
}

export function storeCounts(db: DatabaseSync): StoreCounts {
	const count = (table: string): number => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
	return { messages: count("messages"), events: count("message_events"), threads: count("threads"), contacts: count("contacts") };
}

type TriageDbRow = {
	channel: string;
	thread_id: string;
	state: string;
	needs_reply: string | null;
	urgency: string | null;
	kind: string | null;
	basis_message_id: string;
	basis_timestamp: number;
	question_set: string;
	set_version: number;
	triaged_at: string;
	model: string;
	stop_reason: string | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cost_usd: number | null;
	state_bytes: number;
};

const triageRowOf = (row: TriageDbRow): TriageRow => ({
	channel: row.channel,
	threadId: row.thread_id,
	state: row.state as TriageState,
	needsReply: row.needs_reply as TriageNeedsReply | null,
	urgency: row.urgency as TriageUrgency | null,
	kind: row.kind as TriageKind | null,
	basisMessageId: row.basis_message_id,
	basisTimestamp: Number(row.basis_timestamp),
	questionSet: row.question_set,
	setVersion: Number(row.set_version),
	triagedAt: row.triaged_at,
	model: row.model,
	stopReason: row.stop_reason,
	inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
	outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
	costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
	stateBytes: Number(row.state_bytes),
});

const TRIAGE_COLUMNS =
	"channel, thread_id, state, needs_reply, urgency, kind, basis_message_id, basis_timestamp, question_set, set_version, triaged_at, model, stop_reason, input_tokens, output_tokens, cost_usd, state_bytes";

/** Writes one thread's triage row, replacing that thread's previous one in its channel. */
export function recordTriage(db: DatabaseSync, row: TriageRow): void {
	db.prepare(
		`INSERT INTO thread_triage (${TRIAGE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(channel, thread_id) DO UPDATE SET state = excluded.state, needs_reply = excluded.needs_reply,
		 urgency = excluded.urgency, kind = excluded.kind, basis_message_id = excluded.basis_message_id, basis_timestamp = excluded.basis_timestamp,
		 question_set = excluded.question_set, set_version = excluded.set_version, triaged_at = excluded.triaged_at, model = excluded.model,
		 stop_reason = excluded.stop_reason, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
		 cost_usd = excluded.cost_usd, state_bytes = excluded.state_bytes`,
	).run(
		row.channel,
		row.threadId,
		row.state,
		row.needsReply,
		row.urgency,
		row.kind,
		row.basisMessageId,
		row.basisTimestamp,
		row.questionSet,
		row.setVersion,
		row.triagedAt,
		row.model,
		row.stopReason,
		row.inputTokens,
		row.outputTokens,
		row.costUsd,
		row.stateBytes,
	);
}

/** One thread's row, inside its channel: the same thread id on two channels keeps two rows. */
export function readTriage(db: DatabaseSync, channel: string, threadId: string): TriageRow | null {
	const row = db.prepare("SELECT * FROM thread_triage WHERE channel = ? AND thread_id = ?").get(channel, threadId) as TriageDbRow | undefined;
	return row === undefined ? null : triageRowOf(row);
}

/** Every triage row, newest first, or one channel's or one state's rows. */
export function listTriage(db: DatabaseSync, options?: { channel?: string; state?: TriageState; limit?: number }): TriageRow[] {
	const limit = options?.limit ?? DEFAULT_LIST_LIMIT;
	const where: string[] = [];
	const args: Array<string | number> = [];
	if (options?.channel !== undefined) {
		where.push("channel = ?");
		args.push(options.channel);
	}
	if (options?.state !== undefined) {
		where.push("state = ?");
		args.push(options.state);
	}
	args.push(limit);
	const sql = `SELECT * FROM thread_triage${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY triaged_at DESC, channel, thread_id LIMIT ?`;
	return (db.prepare(sql).all(...args) as TriageDbRow[]).map(triageRowOf);
}

/** Every triage row, for the recreation that carries them across (`store.ts`). */
export function allTriageRows(db: DatabaseSync): TriageRow[] {
	return (db.prepare("SELECT * FROM thread_triage ORDER BY triaged_at DESC, channel, thread_id").all() as TriageDbRow[]).map(triageRowOf);
}

/**
 * The triage rows of an index this code is about to replace, or none when the file predates
 * the table. `raw/` holds every message, event and contact, but it holds no classifier answer.
 */
export function triageRowsIfAny(db: DatabaseSync): TriageRow[] {
	const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_triage'").get();
	return table === undefined ? [] : allTriageRows(db);
}

// ─── MG5: the drafts and the writer calls ─────────────────────────────────────────────────────

type DraftDbRow = {
	draft_id: string;
	channel: string;
	thread_fingerprint: string;
	hash: string;
	hash12: string;
	text: string;
	basis_timestamp: number;
	basis_message_hash: string;
	created_at: string;
	model: string;
};

const draftRowOf = (row: DraftDbRow): DraftRow => ({
	draftId: row.draft_id,
	channel: row.channel,
	threadFingerprint: row.thread_fingerprint,
	hash: row.hash,
	hash12: row.hash12,
	text: row.text,
	basisTimestamp: Number(row.basis_timestamp),
	basisMessageHash: row.basis_message_hash,
	createdAt: row.created_at,
	model: row.model,
});

const DRAFT_COLUMNS =
	"draft_id, channel, thread_fingerprint, hash, hash12, text, basis_timestamp, basis_message_hash, created_at, model";

/**
 * Writes one draft. A draft is immutable (G6): the same id written twice changes
 * nothing, so the first text of a draft is the text of that draft.
 */
export function recordDraft(db: DatabaseSync, row: DraftRow): void {
	db.prepare(
		`INSERT INTO thread_drafts (${DRAFT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(draft_id) DO NOTHING`,
	).run(
		row.draftId,
		row.channel,
		row.threadFingerprint,
		row.hash,
		row.hash12,
		row.text,
		row.basisTimestamp,
		row.basisMessageHash,
		row.createdAt,
		row.model,
	);
}

/** One draft by its id. */
export function readDraft(db: DatabaseSync, draftId: string): DraftRow | null {
	const row = db.prepare("SELECT * FROM thread_drafts WHERE draft_id = ?").get(draftId) as DraftDbRow | undefined;
	return row === undefined ? null : draftRowOf(row);
}

/** The drafts of a channel, of one thread (by its fingerprint), or all of them. */
export function listDrafts(db: DatabaseSync, options?: { channel?: string; threadFingerprint?: string; limit?: number }): DraftRow[] {
	const where: string[] = [];
	const args: Array<string | number> = [];
	if (options?.channel !== undefined) {
		where.push("channel = ?");
		args.push(options.channel);
	}
	if (options?.threadFingerprint !== undefined) {
		where.push("thread_fingerprint = ?");
		args.push(options.threadFingerprint);
	}
	args.push(options?.limit ?? DEFAULT_LIST_LIMIT);
	const sql = `SELECT * FROM thread_drafts${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, draft_id LIMIT ?`;
	return (db.prepare(sql).all(...args) as DraftDbRow[]).map(draftRowOf);
}

/** The newest draft of one thread, by its fingerprint. */
export function latestDraft(db: DatabaseSync, channel: string, threadFingerprint: string): DraftRow | null {
	const row = db
		.prepare(
			"SELECT * FROM thread_drafts WHERE channel = ? AND thread_fingerprint = ? ORDER BY created_at DESC, draft_id DESC LIMIT 1",
		)
		.get(channel, threadFingerprint) as DraftDbRow | undefined;
	return row === undefined ? null : draftRowOf(row);
}

/** Every draft row, for the recreation that carries them across (`store.ts`). */
export function allDraftRows(db: DatabaseSync): DraftRow[] {
	return (db.prepare("SELECT * FROM thread_drafts ORDER BY created_at DESC, draft_id").all() as DraftDbRow[]).map(draftRowOf);
}

/**
 * The draft rows of an index this code is about to replace, or none when the file predates
 * the table. `raw/` holds every message, event and contact, but it holds no draft.
 */
export function draftRowsIfAny(db: DatabaseSync): DraftRow[] {
	const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_drafts'").get();
	return table === undefined ? [] : allDraftRows(db);
}

type DraftCallDbRow = {
	id: number;
	draft_id: string | null;
	channel: string;
	thread_fingerprint: string;
	at: string;
	model: string;
	status: string;
	stop_reason: string;
	text_length: number;
	prompt_bytes: number;
	input_tokens: number | null;
	output_tokens: number | null;
	cost_usd: number | null;
	latency_ms: number;
	error: string | null;
};

const draftCallRowOf = (row: DraftCallDbRow): DraftCallRow => ({
	draftId: row.draft_id,
	channel: row.channel,
	threadFingerprint: row.thread_fingerprint,
	at: row.at,
	model: row.model,
	status: row.status as DraftCallStatus,
	stopReason: row.stop_reason,
	textLength: Number(row.text_length),
	promptBytes: Number(row.prompt_bytes),
	inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
	outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
	costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
	latencyMs: Number(row.latency_ms),
	error: row.error,
});

const DRAFT_CALL_COLUMNS =
	"draft_id, channel, thread_fingerprint, at, model, status, stop_reason, text_length, prompt_bytes, input_tokens, output_tokens, cost_usd, latency_ms, error";

/** Writes one writer call's record. */
export function recordDraftCall(db: DatabaseSync, call: DraftCallRow): void {
	db.prepare(
		`INSERT INTO draft_calls (${DRAFT_CALL_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		call.draftId,
		call.channel,
		call.threadFingerprint,
		call.at,
		call.model,
		call.status,
		call.stopReason,
		call.textLength,
		call.promptBytes,
		call.inputTokens,
		call.outputTokens,
		call.costUsd,
		call.latencyMs,
		call.error,
	);
}

/** The writer calls, newest first, of one draft or of every draft. */
export function listDraftCalls(db: DatabaseSync, options?: { draftId?: string; limit?: number }): DraftCallRow[] {
	const where = options?.draftId === undefined ? [] : ["draft_id = ?"];
	const args: Array<string | number> = options?.draftId === undefined ? [] : [options.draftId];
	args.push(options?.limit ?? DEFAULT_LIST_LIMIT);
	const sql = `SELECT * FROM draft_calls${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC, id DESC LIMIT ?`;
	return (db.prepare(sql).all(...args) as DraftCallDbRow[]).map(draftCallRowOf);
}

/** Every writer call row, for the recreation that carries them across (`store.ts`). */
export function allDraftCallRows(db: DatabaseSync): DraftCallRow[] {
	return (db.prepare("SELECT * FROM draft_calls ORDER BY at DESC, id DESC").all() as DraftCallDbRow[]).map(draftCallRowOf);
}

/**
 * The writer call rows of an index this code is about to replace, or none when the file
 * predates the table.
 */
export function draftCallRowsIfAny(db: DatabaseSync): DraftCallRow[] {
	const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'draft_calls'").get();
	return table === undefined ? [] : allDraftCallRows(db);
}

/**
 * The channel payloads of one thread's newest messages, by message id. A group-chat filter
 * has to see a quote and no page does, so this is the narrow way to it rather than a payload
 * on every thread read.
 */
export function messagePayloads(db: DatabaseSync, channel: string, threadId: string, limit: number = DEFAULT_THREAD_LIMIT): Map<string, unknown> {
	const rows = db
		.prepare("SELECT message_id, payload FROM messages WHERE channel = ? AND thread_id = ? ORDER BY timestamp DESC, message_id DESC LIMIT ?")
		.all(channel, threadId, limit) as Array<{ message_id: string; payload: string }>;
	const payloads = new Map<string, unknown>();
	for (const row of rows) {
		try {
			payloads.set(row.message_id, JSON.parse(row.payload));
		} catch {
			// A payload that is not JSON tells a filter nothing, and the archive still holds it.
		}
	}
	return payloads;
}
