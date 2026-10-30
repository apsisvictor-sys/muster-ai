/**
 * MG1 (VR24-62, rules G1, G2 and G4): the store a sync job, a CLI or a page talks
 * to. It owns the one order that matters — a record is appended to `raw/` first and
 * indexed second — so the archive is always the truth and the index is always
 * behind it at worst, never ahead.
 *
 * The root is the caller's or `MESSAGING_STORE_ROOT` (`archive.ts`). Tests pass a
 * temp folder, so the production folder is never created or read by a test.
 */
import { chmodSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
	INDEX_FILE,
	appendArchiveRecord,
	archiveLedger,
	ensureStore,
	messagingRoot,
	readArchiveRecords,
	storeMedia,
	type ArchiveRecord,
	type ArchivedContact,
	type ArchivedEvent,
	type ArchivedMessage,
	type ContactInput,
	type EventInput,
	type MediaRecord,
	type MessageInput,
	type SkippedLine,
} from "./archive.ts";
import {
	DEFAULT_LIST_LIMIT,
	DEFAULT_THREAD_LIMIT,
	heldRecord,
	indexIsStale,
	indexRecord,
	inTransaction,
	isDamagedIndex,
	listThreads,
	messagePayloads,
	openIndex,
	allTriageRows,
	listTriage,
	readTriage,
	recordTriage,
	triageRowsIfAny,
	readThread,
	resolveThreadRefs,
	searchIndex,
	storeCounts,
	threadIdsOf,
	draftCallRowsIfAny,
	draftRowsIfAny,
	listDraftCalls,
	listDrafts,
	latestDraft,
	readDraft,
	recordDraft,
	recordDraftCall,
	type SearchHit,
	type StoreCounts,
	type ThreadRow,
	type ThreadView,
	type TriageRow,
	type TriageState,
	type DraftCallRow,
	type DraftCallStatus,
	type DraftRow,
} from "./messages-db.ts";

export type { MediaRecord } from "./archive.ts";
export type {
	DraftCallRow,
	DraftCallStatus,
	DraftRow,
	SearchHit,
	StoreCounts,
	ThreadEvent,
	ThreadMessage,
	ThreadRow,
	ThreadView,
	TriageKind,
	TriageNeedsReply,
	TriageRow,
	TriageState,
	TriageUrgency,
} from "./messages-db.ts";

/** What one archive call did. */
export type ArchiveOutcome = {
	/** The canonical thread the record belongs to. */
	threadId: string;
	/** True when the index already held this record, so nothing new was indexed. */
	duplicate: boolean;
	/** The record as it was appended to `raw/`. */
	record: ArchiveRecord;
};

/** What a rebuild recreated. */
export type RebuildResult = {
	/** How many archived records were replayed. */
	records: number;
	/** How many message rows the recreated index holds. */
	messages: number;
	/** Lines the archive holds that are not records — kept in `raw/`, reported, not indexed. */
	skipped: SkippedLine[];
};

/** The derived index, the archive, and the one path that writes both. */
export type MessagingStore = {
	readonly root: string;
	readonly indexPath: string;
	archiveMessage(input: MessageInput): ArchiveOutcome;
	archiveEvent(input: EventInput): ArchiveOutcome;
	archiveContact(input: ContactInput): ArchiveOutcome;
	search(query: string, options?: { limit?: number }): SearchHit[];
	threads(options?: { limit?: number }): ThreadRow[];
	/** Every id form of one thread; a chat id that lives in two channels needs the channel. */
	threadIds(chatOrThreadId: string, channel?: string): string[];
	readThread(chatOrThreadId: string, options?: { limit?: number; channel?: string }): ThreadView;
	/**
	 * The channel payloads of a thread's newest messages, by message id: what the group-chat
	 * filter reads, and no page does. A thread id belongs to one channel, so the channel is
	 * part of the question.
	 */
	payloads(channel: string, threadId: string, options?: { limit?: number }): Map<string, unknown>;
	counts(): StoreCounts;
	/** MG4: one triage row per (channel, thread). The index's one table the archive cannot replay. */
	triage: {
		record(row: TriageRow): void;
		read(channel: string, threadId: string): TriageRow | null;
		list(options?: { channel?: string; state?: TriageState; limit?: number }): TriageRow[];
	};
	/**
	 * MG5: the drafts of the threads that need the operator, and the writer calls that made them.
	 * A draft names its thread by a fingerprint, never by its chat id (G11), and is immutable:
	 * the same draft id written twice changes nothing.
	 */
	drafts: {
		record(row: DraftRow): void;
		recordCall(call: DraftCallRow): void;
		read(draftId: string): DraftRow | null;
		list(options?: { channel?: string; threadFingerprint?: string; limit?: number }): DraftRow[];
		/** The newest draft of one thread, named by its fingerprint. */
		latest(channel: string, threadFingerprint: string): DraftRow | null;
		calls(options?: { draftId?: string; limit?: number }): DraftCallRow[];
	};
	/** When the archive last took a record in. */
	lastPull(): string | null;
	/** Recreates the index from `raw/` alone; the archive is not touched. */
	rebuild(): RebuildResult;
	close(): void;
};

const nowIso = (): string => new Date().toISOString();

/**
 * Opens the store at `root` (or the resolved root), creating its folders and index
 * when they do not exist yet.
 */
export function openMessagingStore(root?: string): MessagingStore {
	const storeRoot = messagingRoot(root);
	const indexPath = join(storeRoot, INDEX_FILE);
	ensureStore(storeRoot);
	// An index written by another schema is derived state that no longer matches the
	// code, so it is recreated from `raw/`, which is the truth (G2). Nothing is lost:
	// the archive holds every record. A database another process holds is never
	// touched (R1), so the sync job's own index is safe while it runs.
	const stale = indexIsStale(indexPath);
	// A stale file is recreated through the same function a rebuild uses, so the two paths
	// cannot drift; that function also carries the rows `raw/` cannot replay (R1: a database
	// another process holds is never touched, so the rebuild stops with "index in use").
	let db: DatabaseSync = stale ? recreateIndex(storeRoot, indexPath, existingIndexRows(indexPath)).db : openIndex(indexPath);
	secureFiles(storeRoot);
	const ledger = archiveLedger(storeRoot);

	/**
	 * The one write order: the index is asked first, the archive is written second. A record
	 * the index already holds is not archived again (an overlapping pull adds no line), and a
	 * copy already in `raw/` whose indexing was cut off is indexed now instead of appended
	 * twice. A crash between the two steps therefore repairs itself on the next call.
	 */
	const commit = (record: ArchiveRecord): ArchiveOutcome => {
		const held = inTransaction(db, () => heldRecord(db, record));
		if (held.held) return { threadId: held.threadId, duplicate: true, record };
		const archivedCopy = ledger.holds(record);
		if (!archivedCopy) {
			appendArchiveRecord(storeRoot, record);
			ledger.remember(record);
		}
		const outcome = inTransaction(db, () => indexRecord(db, record));
		secureFiles(storeRoot);
		return { threadId: outcome.threadId, duplicate: outcome.duplicate, record };
	};

	return {
		root: storeRoot,
		indexPath,
		archiveMessage(input: MessageInput): ArchiveOutcome {
			const recordedAt = input.recordedAt ?? nowIso();
			const media: MediaRecord | undefined = input.media ? storeMedia(storeRoot, input.media) : undefined;
			const record: ArchivedMessage = {
				v: 1,
				kind: "message",
				channel: input.channel,
				chatId: input.chatId,
				messageId: input.messageId,
				recordedAt,
				timestamp: input.timestamp,
				fromMe: input.fromMe,
				type: input.type,
				text: input.text,
				source: input.source ?? "channel",
				payload: input.payload,
				...(input.senderId === undefined ? {} : { senderId: input.senderId }),
				...(media === undefined ? {} : { media }),
			};
			return commit(record);
		},
		archiveEvent(input: EventInput): ArchiveOutcome {
			const record: ArchivedEvent = {
				v: 1,
				kind: "event",
				channel: input.channel,
				chatId: input.chatId,
				messageId: input.messageId,
				event: input.event,
				recordedAt: input.recordedAt ?? nowIso(),
				at: input.at,
				...(input.text === undefined ? {} : { text: input.text }),
				...(input.payload === undefined ? {} : { payload: input.payload }),
			};
			return commit(record);
		},
		archiveContact(input: ContactInput): ArchiveOutcome {
			const record: ArchivedContact = {
				v: 1,
				kind: "contact",
				channel: input.channel,
				contactId: input.contactId,
				recordedAt: input.recordedAt ?? nowIso(),
				payload: input.payload,
				...(input.name === undefined ? {} : { name: input.name }),
				...(input.aliases === undefined ? {} : { aliases: input.aliases }),
			};
			return commit(record);
		},
		search(query: string, options?: { limit?: number }): SearchHit[] {
			return searchIndex(db, query, options?.limit ?? DEFAULT_LIST_LIMIT);
		},
		threads(options?: { limit?: number }): ThreadRow[] {
			return listThreads(db, options?.limit ?? DEFAULT_LIST_LIMIT);
		},
		threadIds(chatOrThreadId: string, channel?: string): string[] {
			const refs = resolveThreadRefs(db, chatOrThreadId, channel);
			if (refs.length !== 1) return [];
			return threadIdsOf(db, refs[0]!.channel, refs[0]!.threadId);
		},
		readThread(chatOrThreadId: string, options?: { limit?: number; channel?: string }): ThreadView {
			return readThread(db, chatOrThreadId, options?.limit ?? DEFAULT_THREAD_LIMIT, options?.channel);
		},
		payloads(channel: string, threadId: string, options?: { limit?: number }): Map<string, unknown> {
			return messagePayloads(db, channel, threadId, options?.limit ?? DEFAULT_THREAD_LIMIT);
		},
		triage: {
			record(row: TriageRow): void {
				inTransaction(db, () => recordTriage(db, row));
			},
			read(channel: string, threadId: string): TriageRow | null {
				return readTriage(db, channel, threadId);
			},
			list(options?: { channel?: string; state?: TriageState; limit?: number }): TriageRow[] {
				return listTriage(db, options);
			},
		},
		drafts: {
			record(row: DraftRow): void {
				inTransaction(db, () => recordDraft(db, row));
			},
			recordCall(call: DraftCallRow): void {
				inTransaction(db, () => recordDraftCall(db, call));
			},
			read(draftId: string): DraftRow | null {
				return readDraft(db, draftId);
			},
			list(options?: { channel?: string; threadFingerprint?: string; limit?: number }): DraftRow[] {
				return listDrafts(db, options);
			},
			latest(channel: string, threadFingerprint: string): DraftRow | null {
				return latestDraft(db, channel, threadFingerprint);
			},
			calls(options?: { draftId?: string; limit?: number }): DraftCallRow[] {
				return listDraftCalls(db, options);
			},
		},
		counts(): StoreCounts {
			return storeCounts(db);
		},
		lastPull(): string | null {
			const row = db
				.prepare(
					`SELECT MAX(recorded_at) AS at FROM (
						SELECT recorded_at FROM messages
						UNION ALL SELECT recorded_at FROM message_events
						UNION ALL SELECT recorded_at FROM contacts
					)`,
				)
				.get() as { at: string | null };
			return row.at ?? null;
		},
		rebuild(): RebuildResult {
			// The rows `raw/` cannot replay are read before anything is closed or deleted: a
			// database another process holds stops the rebuild here, with the rows where they are.
			const carried = existingIndexRows(indexPath);
			db.close();
			const recreated = recreateIndex(storeRoot, indexPath, carried);
			db = recreated.db;
			return recreated.result;
		},
		close(): void {
			db.close();
		},
	};
}

/** The rows of the index about to be replaced: everything `raw/` cannot replay. */
type CarriedRows = {
	/** The classifier's answers (MG4). */
	triage: TriageRow[];
	/** The drafts (MG5). */
	drafts: DraftRow[];
	/** The writer calls that made them (MG5). */
	calls: DraftCallRow[];
};

/** No rows: a file that holds none, or none at all. */
const noRows = (): CarriedRows => ({ triage: [], drafts: [], calls: [] });

/**
 * Recreates the index file: the archive replayed, and the rows `raw/` cannot replay — the
 * classifier's answers and the drafts — carried across. Both a deliberate `rebuild()` and the
 * stale-schema open of `openMessagingStore` come through here, so the two cannot drift.
 */
function recreateIndex(storeRoot: string, indexPath: string, carried: CarriedRows = noRows()): { db: DatabaseSync; result: RebuildResult } {
	for (const suffix of ["", "-wal", "-shm"]) rmSync(`${indexPath}${suffix}`, { force: true });
	const contents = readArchiveRecords(storeRoot);
	const db = openIndex(indexPath);
	replayArchive(db, contents.records, carried);
	secureFiles(storeRoot);
	return { db, result: { records: contents.records.length, messages: storeCounts(db).messages, skipped: contents.skipped } };
}

/**
 * The rows of the index about to be replaced: the classifier's answers, the drafts and the
 * writer calls.
 *
 * Only a damaged file may yield none: it is replaced anyway, and the archive is the truth for
 * everything else. A database another process holds is not damaged, so the rebuild stops with
 * "index in use" and the rows stay where they are (R1). The rows are read before the file is
 * closed or deleted, so a stop leaves the index exactly as it was.
 */
function existingIndexRows(indexPath: string): CarriedRows {
	if (!existsSync(indexPath)) return noRows();
	let old: DatabaseSync;
	try {
		old = new DatabaseSync(indexPath);
	} catch (error) {
		if (isDamagedIndex(error)) return noRows();
		throw indexInUse(error);
	}
	try {
		return readIndexRows(old);
	} finally {
		old.close();
	}
}

/**
 * The rows of an open index.
 *
 * The write lock is the one SQLite hands to a writer, so a database another process is
 * writing right now cannot take it and says so (SQLITE_BUSY). That database is in use,
 * it is not damaged, and it is not ours to replace: the rebuild stops (R1).
 *
 * A damaged file is the one case that yields no rows: it is replaced anyway, and the
 * archive is the truth for everything else.
 */
function readIndexRows(old: DatabaseSync): CarriedRows {
	try {
		old.exec("BEGIN IMMEDIATE");
		old.exec("COMMIT");
	} catch (error) {
		try {
			old.exec("ROLLBACK");
		} catch {
			// The lock was never taken; the error below is the one worth raising.
		}
		if (isDamagedIndex(error)) return noRows();
		throw indexInUse(error);
	}
	try {
		return { triage: triageRowsIfAny(old), drafts: draftRowsIfAny(old), calls: draftCallRowsIfAny(old) };
	} catch (error) {
		if (isDamagedIndex(error)) return noRows();
		throw indexInUse(error);
	}
}

/**
 * The error a rebuild stops with when the index cannot be read because another process holds
 * it. Nothing is deleted, so the rows only the index holds stay.
 */
function indexInUse(error: unknown): Error {
	const detail = error instanceof Error ? error.message : String(error);
	return new Error(`index in use: the messaging index could not be read, so nothing was rebuilt (${detail})`);
}

/**
 * Replays archived records into an index, and the rows the archive does not hold.
 * The archive is the truth, so this is how an index is created, rebuilt, or brought back
 * from another schema version.
 */
function replayArchive(db: DatabaseSync, records: ArchiveRecord[], carried: CarriedRows = noRows()): void {
	inTransaction(db, () => {
		for (const record of records) indexRecord(db, record);
		for (const row of carried.triage) recordTriage(db, row);
		for (const row of carried.drafts) recordDraft(db, row);
		for (const call of carried.calls) recordDraftCall(db, call);
	});
}

/**
 * Holds the index and its write-ahead files at 0600. The folder is 0700, so nothing
 * outside this account can reach them either way; the files carry the same mode so a
 * copy of one is not readable by another user.
 */
function secureFiles(root: string): void {
	for (const name of [INDEX_FILE, `${INDEX_FILE}-wal`, `${INDEX_FILE}-shm`]) {
		const path = join(root, name);
		if (existsSync(path)) chmodSync(path, 0o600);
	}
}
