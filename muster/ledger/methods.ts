/**
 * The ledger's methods: one function per client method, each one commit or one
 * read. The daemon dispatches to these; nothing else mutates the ledger's
 * documents.
 *
 * Every mutating method with a `requestId` reads `RequestFamily[requestId]`
 * *inside* its one `root.commit` callback, never in a read before it. Commits
 * are serialized on the Session line, so two calls with the same id (a spool
 * replay and the client's own retry) cannot both see it absent; the second
 * returns the stored result and writes nothing.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context, Draft } from "@earendil-works/chord";
import type { Cursor, EntryId, JsonObject, Tx } from "@earendil-works/pi-durable";
import type { AskEvent } from "../asks.ts";
import type { InboxMessage } from "../lib/agent-inbox.ts";
import type { Ledger } from "./open.ts";
import {
	AskFamily,
	CasFamily,
	InboxFamily,
	MessageFamily,
	MusterEvent,
	type MessageDoc,
	type MusterEventData,
	type MusterEventValue,
	RequestFamily,
	type CasDoc,
	type RequestDoc,
} from "./schema.ts";
import { crashKill } from "./runtime.ts";

const ctx: Context = BACKGROUND_CONTEXT;

/** Read a request's row; `eventAt > 0` means the request is already committed. */
async function requestRow(tx: Tx, requestId: string): Promise<Draft<RequestDoc>> {
	return tx.doc(RequestFamily, requestId, { requestId });
}

/** Append one event line, for the event lines hooks emit. A repeated request id writes nothing. */
export async function appendEvent(
	l: Ledger,
	p: { type: string; lane?: string; text: string; requestId: string },
): Promise<{ duplicate: boolean }> {
	return l.root.commit(async (tx) => {
		const request = await requestRow(tx, p.requestId);
		if (request.eventAt > 0) return { duplicate: true };
		const at = Date.now();
		await tx.appendEntry(MusterEvent, l.root.id, {
			data: {
				type: p.type,
				...(p.lane === undefined ? {} : { lane: p.lane }),
				text: p.text,
				at,
				requestId: p.requestId,
			},
		});
		request.eventAt = at;
		request.result = {};
		return { duplicate: false };
	}, ctx);
}

/** Every `muster.event` entry after the cursor, oldest first. The cursor is the entry id, never `at`. */
export async function eventsSince(l: Ledger, after?: EntryId): Promise<MusterEventData[]> {
	const collected: MusterEventData[] = [];
	let cursor: Cursor | undefined;
	for (;;) {
		const page = await l.root.entries(after === undefined ? {} : { minEntryId: after }, 256, cursor, ctx);
		for (const record of page.items) {
			if (MusterEvent.is(record) && record.data !== undefined) collected.push({ ...record.data, id: record.id });
		}
		if (page.next === undefined) break;
		cursor = page.next;
	}
	collected.sort((a, b) => a.id - b.id);
	return after === undefined ? collected : collected.filter((event) => event.id > after);
}

/** One compare-and-set record, or `undefined` when it was never created. */
export async function casRead(l: Ledger, p: { store: string; id: string }): Promise<CasDoc | undefined> {
	return l.harness.snapshot(CasFamily, `${p.store}:${p.id}`, ctx);
}

export type CasUpdateResult = { ok: true; revision: number } | { ok: false; code: "conflict" | "missing" };

/**
 * The CAS semantics of `CasStore.update` (`extensions/muster/owner-fence.ts:51-60`):
 * `expectedRevision === undefined` creates, otherwise the stored revision must
 * match. Only the store changes; the seat rules stay in `extensions/muster/seats.ts`.
 *
 * A record whose body was emptied does not exist (LC18). Removing a record is an
 * expected-revision write of `null` (`removeLaneCard`, `takeLaneControl`), because the
 * ledger has no delete, and `casRead`/`casList` already answer absent for one. Reading
 * the revision alone made a create over it refuse "already exists" for good, so a lane
 * whose card was removed — and a lane whose control request was taken — could never be
 * written again.
 */
export async function casUpdate(
	l: Ledger,
	p: { store: string; id: string; expectedRevision: number | null | undefined; record: JsonObject },
): Promise<CasUpdateResult> {
	return l.root.commit(async (tx) => {
		const doc = await tx.doc(CasFamily, `${p.store}:${p.id}`, { store: p.store, id: p.id });
		const existing = doc.revision > 0 && doc.record !== null;
		// `null` is create-or-replace (LC18): the stored revision is ignored, so writers
		// that read the same revision all land. The revision still rises, so a writer
		// holding an older one stays stale.
		if (p.expectedRevision === null) {
			doc.record = p.record;
			doc.revision += 1;
			return { ok: true as const, revision: doc.revision };
		}
		if (p.expectedRevision === undefined) {
			if (existing) return { ok: false as const, code: "conflict" as const };
			doc.record = p.record;
			// One above whatever the emptied record held, so a writer that read that revision stays stale.
			doc.revision += 1;
			return { ok: true as const, revision: doc.revision };
		}
		if (!existing) return { ok: false as const, code: "missing" as const };
		if (doc.revision !== p.expectedRevision) return { ok: false as const, code: "conflict" as const };
		doc.record = p.record;
		doc.revision = p.expectedRevision + 1;
		return { ok: true as const, revision: doc.revision };
	}, ctx);
}

/** One record a commit writes: the same compare-and-set rule as `casUpdate`, several at once. */
export type CasWrite = {
	store: string;
	id: string;
	expectedRevision: number | undefined;
	record: JsonObject | null;
	/**
	 * The revision a create lands on, for the import (LC14): a store whose file keeps
	 * its own revision (the seat store, `seats.ts:116`) is imported at the revision it
	 * had, so a rollback writes that same revision back. Absent on a create means 1,
	 * and it is ignored when `expectedRevision` names an existing record.
	 */
	revision?: number;
};

export type CommitParams = { requestId: string; cas: CasWrite[]; events: MusterEventValue[] };
export type CommitResult =
	| { ok: true; revisions: number[]; eventIds: string[]; duplicate?: true }
	| { ok: false; code: "conflict"; index: number };

/**
 * All writes or none, one commit (LC5).
 *
 * A write that spans two records that used to be two files — a report updating
 * the lane card and the lane record — lands as one commit, so a crash inside it
 * leaves both old or both new, never half. Expected revisions are all checked
 * before anything is written, so a stale revision anywhere refuses the whole
 * commit and names the write that refused. A repeated `requestId` returns the
 * stored result (`duplicate: true`) and writes nothing, exactly as `appendEvent`
 * treats a repeated request: a spool replay that was cut short and run again
 * writes once.
 */
export async function commit(l: Ledger, p: CommitParams): Promise<CommitResult> {
	return l.root.commit(async (tx) => {
		const request = await requestRow(tx, p.requestId);
		if (request.eventAt > 0) {
			const stored = request.result as unknown as { revisions?: number[]; eventIds?: string[] };
			return {
				ok: true as const,
				revisions: stored.revisions ?? [],
				eventIds: stored.eventIds ?? [],
				duplicate: true as const,
			};
		}
		const docs: Draft<CasDoc>[] = [];
		for (let index = 0; index < p.cas.length; index += 1) {
			const write = p.cas[index]!;
			const doc = await tx.doc(CasFamily, `${write.store}:${write.id}`, { store: write.store, id: write.id });
			const existing = doc.revision > 0 && doc.record !== null;
			const matches =
				write.expectedRevision === undefined
					? !existing
					: existing && doc.revision === write.expectedRevision;
			if (!matches) return { ok: false as const, code: "conflict" as const, index };
			docs.push(doc);
		}
		const revisions: number[] = [];
		for (let index = 0; index < p.cas.length; index += 1) {
			const write = p.cas[index]!;
			const doc = docs[index]!;
			doc.record = write.record;
			// A create over an emptied record takes a fresh revision (LC18); a fresh record lands on 1.
			doc.revision = write.expectedRevision === undefined ? doc.revision + 1 : write.expectedRevision + 1;
			revisions.push(doc.revision);
		}
		const at = Date.now();
		// The test's crash point, after every record is staged and before the commit is
		// returned: a SIGKILL here must leave every write uncommitted, which is what
		// `inside-commit` proves (LC5's report commits the card and the record together).
		crashKill("inside-commit");
		const eventIds: string[] = [];
		for (const event of p.events) {
			const written = await tx.appendEntry(MusterEvent, l.root.id, { data: event });
			eventIds.push(String(written.id));
		}
		request.eventAt = at;
		request.result = { revisions, eventIds } as JsonObject;
		return { ok: true as const, revisions, eventIds };
	}, ctx);
}

/** One record of a store, as `casList` returns it. */
export type CasListRow = { id: string; record: JsonObject; revision: number };

/**
 * Every record of one store (LC5).
 *
 * The Session exposes no document-family scan, so the list comes from the
 * storage handle's incarnation scan over `CasFamily` (`open.ts:35-40`), filtered
 * by the store prefix of the document key, and each key is then read through the
 * harness. The daemon is the storage's single writer, so a key the scan returns
 * is a current incarnation; a key whose record was emptied is skipped.
 */
export async function casList(l: Ledger, p: { store: string }): Promise<CasListRow[]> {
	const prefix = `${p.store}:`;
	const keys: string[] = [];
	let cursor: Cursor | undefined;
	for (;;) {
		const page = await l.storage.scanDocuments(
			{ scope: { kind: "session" }, at: "current", kind: CasFamily.definition.kind },
			256,
			cursor,
			ctx,
		);
		for (const doc of page.items) {
			if (typeof doc.key === "string" && doc.key.startsWith(prefix)) keys.push(doc.key);
		}
		if (page.next === undefined) break;
		cursor = page.next;
	}
	const rows: CasListRow[] = [];
	for (const key of keys) {
		const doc = await l.harness.snapshot(CasFamily, key, ctx);
		if (doc === undefined || doc.record === null) continue;
		rows.push({ id: key.slice(prefix.length), record: doc.record, revision: doc.revision });
	}
	rows.sort((a, b) => a.id.localeCompare(b.id));
	return rows;
}

/**
 * A detached plain copy of a committed value. A returned draft is a Chord overlay
 * tied to its transaction and throws once that transaction settles, so any value a
 * method returns is copied inside the commit while it is live (the pilot's rule).
 */
function plain<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * The doc-order of messages (§2.1): the order `<ms>-<id>.json` file names sort by
 * today, so both backends list a set the same way. A message whose `at` is not a
 * time falls back to the moment it was written, as the file name does.
 */
function arrivalKey(doc: MessageDoc, writtenAt: number): [number, string] {
	const parsed = Date.parse(doc.message.at);
	return [Number.isFinite(parsed) ? parsed : writtenAt, doc.message.id];
}

function byArrival(left: MessageDoc, right: MessageDoc): number {
	const [leftMs, leftId] = arrivalKey(left, left.deliveredAt ?? 0);
	const [rightMs, rightId] = arrivalKey(right, right.deliveredAt ?? 0);
	return leftMs === rightMs ? leftId.localeCompare(rightId) : leftMs - rightMs;
}

/**
 * Every `muster.message` document, in no particular order. Like `casList`, the
 * Session exposes no document-family scan, so the keys come from the storage
 * handle's incarnation scan; the daemon is the storage's single writer, so a key
 * the scan returns is a current incarnation.
 */
async function scannedMessages(l: Ledger): Promise<MessageDoc[]> {
	const keys: string[] = [];
	let cursor: Cursor | undefined;
	for (;;) {
		const page = await l.storage.scanDocuments(
			{ scope: { kind: "session" }, at: "current", kind: MessageFamily.definition.kind },
			256,
			cursor,
			ctx,
		);
		for (const doc of page.items) {
			if (typeof doc.key === "string") keys.push(doc.key);
		}
		if (page.next === undefined) break;
		cursor = page.next;
	}
	const rows: MessageDoc[] = [];
	for (const key of keys) {
		const doc = await l.harness.snapshot(MessageFamily, key, ctx);
		if (doc !== undefined) rows.push(doc);
	}
	return rows;
}

/**
 * One message by id, accepted or delivered (LC7), or `undefined` when it was
 * never written. The caller compares the address: a reader must never be handed
 * another address's message.
 */
export async function messageRead(l: Ledger, p: { id: string }): Promise<MessageDoc | undefined> {
	if (p.id === "") return undefined;
	const doc = await l.harness.snapshot(MessageFamily, p.id, ctx);
	return doc === undefined ? undefined : doc;
}

/** One inbox index document, with the address that keys it (`muster.inbox`, §2.1). */
export type InboxRow = { address: string; pending: string[] };

/**
 * The inbox index: the one an address names, else every address with mail waiting (LC7).
 *
 * `includeEmpty` adds the addresses whose index holds nothing: the export (LC14)
 * enumerates the addresses it must write back to files with it, and a delivered
 * message leaves its address's index empty. Readers keep LC7's answer.
 */
export async function inboxes(l: Ledger, p: { address?: string; includeEmpty?: boolean }): Promise<InboxRow[]> {
	if (p.address !== undefined) {
		const doc = await l.harness.snapshot(InboxFamily, p.address, ctx);
		return doc === undefined ? [] : [{ address: p.address, pending: doc.pending }];
	}
	const keys: string[] = [];
	let cursor: Cursor | undefined;
	for (;;) {
		const page = await l.storage.scanDocuments(
			{ scope: { kind: "session" }, at: "current", kind: InboxFamily.definition.kind },
			256,
			cursor,
			ctx,
		);
		for (const doc of page.items) {
			if (typeof doc.key === "string") keys.push(doc.key);
		}
		if (page.next === undefined) break;
		cursor = page.next;
	}
	const rows: InboxRow[] = [];
	for (const key of keys) {
		const doc = await l.harness.snapshot(InboxFamily, key, ctx);
		// An emptied index carries nothing, like a record `casList` skips.
		if (doc === undefined || (doc.pending.length === 0 && p.includeEmpty !== true)) continue;
		rows.push({ address: key, pending: doc.pending });
	}
	rows.sort((left, right) => left.address.localeCompare(right.address));
	return rows;
}

/**
 * The messages of one address (LC7), in arrival order, the newest `limit` when one
 * is given — the order and the slice the file reader answers with today.
 *
 * The accepted ones come from the index the address holds; the delivered ones are
 * scanned, because the index keeps undelivered ids only (§2.1), and sorted by the
 * same key the file names sort by.
 */
export async function messages(
	l: Ledger,
	p: { address: string; state?: "accepted" | "delivered"; limit?: number },
): Promise<MessageDoc[]> {
	const state = p.state ?? "accepted";
	let rows: MessageDoc[];
	if (state === "accepted") {
		const inbox = await l.harness.snapshot(InboxFamily, p.address, ctx);
		rows = [];
		for (const id of inbox?.pending ?? []) {
			const doc = await l.harness.snapshot(MessageFamily, id, ctx);
			if (doc !== undefined && doc.state === "accepted" && doc.address === p.address) rows.push(doc);
		}
	} else {
		rows = (await scannedMessages(l)).filter((doc) => doc.address === p.address && doc.state === "delivered");
	}
	rows.sort(byArrival);
	return p.limit === undefined ? rows : rows.slice(-p.limit);
}

/**
 * Queue one message for its own address (LC7). One commit writes the message, adds
 * its id to the address's index and appends the `SENT` entry the target's
 * subscription wakes on (LD10).
 *
 * The id is the owner's, never minted here (G4), and the request id is the
 * caller's: `writeInboxMessage` derives it from the sender, the retry key and the
 * text, so an exact repeat stores one message and both calls answer with the first
 * id, while distinct mail under one reused key stays distinct (the janitor's
 * `janitor-<date>`).
 */
export async function send(l: Ledger, p: { requestId: string; message: InboxMessage }): Promise<{ id: string; duplicate: boolean }> {
	return l.root.commit(async (tx) => {
		const request = await requestRow(tx, p.requestId);
		if (request.eventAt > 0) return { id: String(request.result["id"] ?? ""), duplicate: true };
		const at = Date.now();
		const doc = await tx.doc(MessageFamily, p.message.id, { id: p.message.id });
		doc.address = p.message.agent;
		doc.message = { ...p.message };
		doc.state = "accepted";
		doc.deliveredAt = null;
		const inbox = await tx.doc(InboxFamily, p.message.agent, { address: p.message.agent });
		// The index holds an id once: a second write of one message must not list it twice.
		if (!inbox.pending.includes(p.message.id)) inbox.pending = [...inbox.pending, p.message.id];
		await tx.appendEntry(MusterEvent, l.root.id, {
			data: { type: "SENT", lane: p.message.agent, text: p.message.text, at, requestId: p.requestId },
		});
		request.eventAt = at;
		request.result = { id: p.message.id };
		crashKill("inside-send-commit");
		return { id: p.message.id, duplicate: false };
	}, ctx);
}

/**
 * Mark one message delivered and take it out of its address's index (LC7). One
 * commit, so a reader that lists first and marks one by one cannot leave the index
 * and the message disagreeing. A repeated request writes nothing and answers as it
 * first did, the rule every request-id method follows.
 */
export async function markDelivered(l: Ledger, p: { address: string; id: string; requestId: string }): Promise<{ ok: boolean }> {
	return l.root.commit(async (tx) => {
		const request = await requestRow(tx, p.requestId);
		if (request.eventAt > 0) return { ok: request.result["ok"] === true };
		const inbox = await tx.doc(InboxFamily, p.address, { address: p.address });
		const doc = await tx.doc(MessageFamily, p.id, { id: p.id });
		// A message another address holds, or one already delivered, is not this call's to move.
		const deliverable = inbox.pending.includes(p.id) && doc.address === p.address && doc.state === "accepted";
		if (deliverable) {
			inbox.pending = inbox.pending.filter((id) => id !== p.id);
			doc.state = "delivered";
			doc.deliveredAt = Date.now();
		}
		request.eventAt = Date.now();
		request.result = { ok: deliverable };
		return { ok: deliverable };
	}, ctx);
}

/**
 * Deliver everything waiting for one address (LC7): one commit marks every accepted
 * message delivered, empties the index and returns the messages oldest first. No
 * request id is needed — a crash before the commit leaves every message pending,
 * and a second call finds an empty index.
 */
export async function drain(l: Ledger, p: { address: string }): Promise<{ messages: InboxMessage[] }> {
	return l.root.commit(async (tx) => {
		const inbox = await tx.doc(InboxFamily, p.address, { address: p.address });
		const at = Date.now();
		const out: InboxMessage[] = [];
		for (const id of inbox.pending) {
			const doc = await tx.doc(MessageFamily, id, { id });
			if (doc.state === "accepted") {
				doc.state = "delivered";
				doc.deliveredAt = at;
			}
			out.push(plain(doc.message));
		}
		inbox.pending = [];
		return { messages: out };
	}, ctx);
}

/**
 * Append one queue event to its ask's document (LD37). One event is one commit,
 * and it appends no entry: an ask never posts a `muster.event`, so a raise never
 * wakes the orchestrator's waiter.
 *
 * A repeated `requestId` returns the stored count and appends nothing, the same
 * rule `commit` and `appendEvent` apply. The caller (`asks.ts`) derives the id
 * from the event itself, so replaying one event is the same write.
 */
export async function askAppend(
	l: Ledger,
	p: { askId: string; event: AskEvent; requestId: string },
): Promise<{ ok: true; count: number }> {
	return l.root.commit(async (tx) => {
		const request = await requestRow(tx, p.requestId);
		if (request.eventAt > 0) {
			const stored = request.result as unknown as { count?: number };
			return { ok: true as const, count: stored.count ?? 0 };
		}
		const doc = await tx.doc(AskFamily, p.askId, { askId: p.askId });
		doc.events = [...doc.events, p.event];
		const at = Date.now();
		request.eventAt = at;
		request.result = { count: doc.events.length } as JsonObject;
		return { ok: true as const, count: doc.events.length };
	}, ctx);
}

/**
 * Every ask's events, in append order, oldest document first (LD37).
 *
 * Like `casList`, the Session exposes no document-family scan, so the keys come
 * from the storage handle's incarnation scan over `AskFamily` and each key is
 * then read through the harness. The daemon is the storage's single writer, so a
 * key the scan returns is a current incarnation; a document with no events is
 * skipped, as `casList` skips an emptied record.
 */
export async function asksAll(l: Ledger): Promise<{ askId: string; events: AskEvent[] }[]> {
	const keys: string[] = [];
	let cursor: Cursor | undefined;
	for (;;) {
		const page = await l.storage.scanDocuments(
			{ scope: { kind: "session" }, at: "current", kind: AskFamily.definition.kind },
			256,
			cursor,
			ctx,
		);
		for (const doc of page.items) {
			if (typeof doc.key === "string") keys.push(doc.key);
		}
		if (page.next === undefined) break;
		cursor = page.next;
	}
	const rows: { askId: string; events: AskEvent[] }[] = [];
	for (const key of keys) {
		const doc = await l.harness.snapshot(AskFamily, key, ctx);
		if (doc === undefined || doc.events.length === 0) continue;
		rows.push({ askId: key, events: doc.events });
	}
	rows.sort((a, b) => a.askId.localeCompare(b.askId));
	return rows;
}

/** One message the import writes into `muster.message` and `muster.inbox` (§2.1, LC14). */
export type ImportMessage = {
	address: string;
	message: InboxMessage;
	state: "accepted" | "delivered";
	deliveredAt: number | null;
};

export type ImportParams = {
	requestId: string;
	cas: CasWrite[];
	messages: ImportMessage[];
	asks: { askId: string; events: AskEvent[] }[];
	events: MusterEventValue[];
};

export type ImportResult =
	| { ok: true; duplicate?: true; counts: ImportCounts }
	| { ok: false; code: "conflict"; index: number };

/** What one chunk put in the ledger, so a rerun can report what it skipped. */
export type ImportCounts = { cas: number; messages: number; asks: number; events: number };

const NO_WRITES: ImportCounts = { cas: 0, messages: 0, asks: 0, events: 0 };

/**
 * One chunk of the flip's import (LC14, G2): every record family the source holds,
 * in one commit, under the chunk's request id.
 *
 * The request row is written inside the same commit as the records, so a kill
 * anywhere in the chunk leaves **nothing** of it committed and a rerun commits it
 * whole; a chunk whose row exists is skipped and answers `duplicate` (§2.2, G2's
 * "per-chunk request ids"). The chunks are cut from a frozen source, so every
 * compare-and-set write is a create: `expectedRevision` is the same refusal rule
 * `commit` applies, and a record that already exists refuses the whole chunk
 * rather than overwriting it.
 *
 * A delivered message never enters its address's index; an accepted one is
 * appended to it in arrival order, as `send` does.
 */
export async function importBatch(l: Ledger, p: ImportParams): Promise<ImportResult> {
	return l.root.commit(async (tx) => {
		const request = await requestRow(tx, p.requestId);
		if (request.eventAt > 0) return { ok: true as const, duplicate: true as const, counts: NO_WRITES };
		const docs: Draft<CasDoc>[] = [];
		for (let index = 0; index < p.cas.length; index += 1) {
			const write = p.cas[index]!;
			const doc = await tx.doc(CasFamily, `${write.store}:${write.id}`, { store: write.store, id: write.id });
			const existing = doc.revision > 0 && doc.record !== null;
			const matches = write.expectedRevision === undefined ? !existing : existing && doc.revision === write.expectedRevision;
			if (!matches) return { ok: false as const, code: "conflict" as const, index };
			docs.push(doc);
		}
		for (let index = 0; index < p.cas.length; index += 1) {
			const write = p.cas[index]!;
			const doc = docs[index]!;
			doc.record = write.record;
			// A create over an emptied record takes a fresh revision (LC18); `write.revision` lands the import on the revision its source had.
			doc.revision = write.expectedRevision === undefined ? Math.max(doc.revision + 1, write.revision ?? 1) : write.expectedRevision + 1;
		}
		for (const row of p.messages) {
			const doc = await tx.doc(MessageFamily, row.message.id, { id: row.message.id });
			doc.address = row.address;
			doc.message = { ...row.message };
			doc.state = row.state;
			doc.deliveredAt = row.deliveredAt;
			if (row.state !== "accepted") continue;
			const inbox = await tx.doc(InboxFamily, row.address, { address: row.address });
			if (!inbox.pending.includes(row.message.id)) inbox.pending = [...inbox.pending, row.message.id];
		}
		for (const ask of p.asks) {
			const doc = await tx.doc(AskFamily, ask.askId, { askId: ask.askId });
			doc.events = [...doc.events, ...ask.events];
		}
		for (const event of p.events) await tx.appendEntry(MusterEvent, l.root.id, { data: event });
		// The test's kill point (LC14's fourth test): every write is staged and the commit
		// has not returned, so a SIGKILL here leaves the whole chunk uncommitted. The
		// request row is written after it, in this same commit.
		crashKill("inside-import-chunk");
		const counts: ImportCounts = { cas: p.cas.length, messages: p.messages.length, asks: p.asks.length, events: p.events.length };
		request.eventAt = Date.now();
		request.result = { ...counts } as JsonObject;
		return { ok: true as const, counts };
	}, ctx);
}
