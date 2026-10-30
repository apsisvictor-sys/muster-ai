/**
 * `ledgerCasStore`: the ledger's compare-and-set store, the ledger half of the
 * `CasStore` contract (`owner-fence.ts:51-60`) that `fileCasStore` fills today.
 * One owner keeps one store choice: the caller passes the same `validate` and
 * the same typed error class it gives `fileCasStore`, so `read`/`update`, the
 * `missing`/`conflict` outcomes and every message a caller relies on are the
 * same in both backends (LC4).
 *
 * The revision decision itself is the daemon's: `casUpdate` (`methods.ts`)
 * compares the stored revision inside its one commit, exactly as
 * `updateJsonSettingsFile` does under its lock, and this module only maps its
 * answer. Neither store retries — `CAS_ATTEMPTS` belongs to the caller's
 * transition loop (`seats.ts`, `control.ts`), which re-reads and retries on
 * `conflict`.
 *
 * One call is one request through the synchronous bridge (`client-sync.ts`), so
 * a synchronous owner keeps calling `read(id)` and `update(id, expectedRevision,
 * mutate)` with no `await`: the seat rules (`seats.ts`) and the Claude hook
 * bundle both run on threads that cannot await.
 *
 * Errors. `MusterdUnreachable` is the boundary's own error and leaves unchanged
 * (RF1: a tick pass prints one line and touches nothing). A daemon refusal
 * becomes the owner's `io` error; an invalid id, a malformed record, a `missing`
 * and a `conflict` become the owner's own codes, in `fileCasStore`'s wording. An
 * error the caller's `mutate` throws propagates as it is: the transition runs in
 * this process, not inside a store callback, and `seats.ts` refuses with its own
 * `SeatStateError` from there.
 *
 * Node builtins plus `client-sync.ts` only: the one-file Claude hook bundle and
 * the OpenCode lane host both load this module.
 */

import { dirname, join } from "node:path";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { CasRecord, CasStore, CasStoreOptions } from "../owner-fence.ts";
import { MusterdUnreachable } from "./client.ts";
import { requestSync } from "./client-sync.ts";

/** The record body the ledger keeps: the record without the revision the store's own track carries. */
type CasBody<T> = Omit<T, "revision">;

/** `casRead`'s answer (`methods.ts`); `undefined` when the record was never created. */
type CasReadResult<T> = { record: T; revision: number } | undefined;
/** `casUpdate`'s answer: the new revision, or the reason it refused. */
type CasUpdateResult = { ok: true; revision: number } | { ok: false; code: "conflict" | "missing" };

/** The socket `musterd` serves on inside the ledger directory it was started with (`daemon.ts`). */
export function ledgerSocketPath(dir: string): string {
	return join(dir, "ledger.sock");
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A record the store listed: its id, the owner's record and the ledger revision the store tracks. */
export type CasListed<T> = { id: string; record: T; revision: number };

/** One stored record with the ledger revision the store tracks beside it. */
export type CasStored<T> = { record: T; revision: number };

/** The listing outcome: the records that read, and the ones that did not, each with why. */
export type CasListOutcome<T> = { rows: CasListed<T>[]; skipped: { id: string; error: string }[] };

/** `ledgerCasStore` plus the two reads a store-family list and a multi-record commit need (LC5). */
export type LedgerCasStore<T extends CasRecord> = CasStore<T> & {
	list(): CasListed<T>[];
	/** The listing that reports what it could not read: the records that read, and the ones that did not. */
	listWithSkipped(): CasListOutcome<T>;
	/** The raw read: the owner's record and the ledger revision, before the store merges one into the other. */
	readWithRevision(id: string): CasStored<T> | undefined;
};

/** One listed record as `casList` returns it before the owner's own validation. */
type CasListRow = { id: string; record: JsonObject; revision: number };

/**
 * The ledger store for one record family. `store` is the family name the
 * document id is built from (`<store>:<id>`, the G5 gate's `seat`), `socketPath`
 * is `musterd`'s socket, and `owner` carries everything the caller keeps from
 * `fileCasStore`'s options except `dir`.
 */
export function ledgerCasStore<T extends CasRecord>(
	store: string,
	socketPath: string,
	owner: Omit<CasStoreOptions<T>, "dir">,
): LedgerCasStore<T> {
	const { idPattern, idKind, validate, errorClass: StoreError, passThrough } = owner;
	const recordNoun = owner.recordNoun ?? "record";
	const sentence = owner.noun.charAt(0).toUpperCase() + owner.noun.slice(1);
	/** What a message names in place of the file path a file store names. */
	const docId = (id: string): string => `${store}:${id}`;
	const idFor = (id: string): string => {
		if (!idPattern.test(id)) throw new StoreError("io", `invalid ${idKind} id: ${id}`);
		return id;
	};
	const parse = (raw: unknown, id: string): T => {
		const validated = validate(raw);
		if (!validated.ok) {
			throw new StoreError("malformed", `${sentence} ${recordNoun} ${docId(id)} is invalid: ${validated.errors.join("; ")}`);
		}
		return validated.record;
	};
	const mapStoreError = (error: unknown, id: string): Error => {
		if (error instanceof MusterdUnreachable) return error;
		if (error instanceof StoreError) return error;
		if (passThrough?.(error)) return error as Error;
		return new StoreError("io", `${sentence} store failure at ${docId(id)}: ${messageOf(error)}`);
	};

	const readWithRevision = (id: string): CasStored<T> | undefined => {
		try {
			const doc = requestSync<CasReadResult<CasBody<T>>>(socketPath, "casRead", { store, id: idFor(id) });
			// An emptied record is a removed record: absent, never a malformed one.
			if (doc === undefined || doc.record === null) return undefined;
			return { record: parse({ ...doc.record, revision: doc.revision }, id), revision: doc.revision };
		} catch (error) {
			throw mapStoreError(error, id);
		}
	};

	const read = (id: string): T | undefined => readWithRevision(id)?.record;

	const update = (id: string, expectedRevision: number | undefined, mutate: (current: T | undefined) => T): T => {
		const current = read(id);
		if (expectedRevision === undefined) {
			if (current !== undefined) {
				throw new StoreError("conflict", `${sentence} ${recordNoun} ${docId(id)} already exists`);
			}
		} else if (current === undefined) {
			throw new StoreError("missing", `No ${owner.noun} ${recordNoun} at ${docId(id)}`);
		} else if (current.revision !== expectedRevision) {
			throw new StoreError("conflict", `${sentence} revision conflict for ${id}: expected ${expectedRevision}, current ${current.revision}`);
		}
		// Exactly as `fileCasStore` validates the record it is about to write, so a
		// caller's bad transition fails here rather than in the ledger.
		const next = parse(mutate(current), id);
		const { revision: _revision, ...body } = next;
		let result: CasUpdateResult;
		try {
			result = requestSync<CasUpdateResult>(socketPath, "casUpdate", { store, id: idFor(id), expectedRevision, record: body });
		} catch (error) {
			throw mapStoreError(error, id);
		}
		if (!result.ok) {
			if (result.code === "missing") throw new StoreError("missing", `No ${owner.noun} ${recordNoun} at ${docId(id)}`);
			if (expectedRevision === undefined) {
				throw new StoreError("conflict", `${sentence} ${recordNoun} ${docId(id)} already exists`);
			}
			throw new StoreError("conflict", `${sentence} revision conflict for ${id}: expected ${expectedRevision}, current ${current?.revision}`);
		}
		return { ...body, revision: result.revision } as T;
	};

	/**
	 * Create or replace the record, whatever revision is stored (LC18): one
	 * `casUpdate` with no expected revision, so writers that read the same revision
	 * both land. The daemon answers with the revision it wrote.
	 */
	const put = (id: string, record: Omit<T, "revision">): T => {
		// The same validation `update` gives the record it is about to write, so a
		// caller's bad transition fails here rather than in the ledger.
		const { revision: _revision, ...body } = parse({ ...record, revision: 0 }, id);
		let result: CasUpdateResult;
		try {
			result = requestSync<CasUpdateResult>(socketPath, "casUpdate", { store, id: idFor(id), expectedRevision: null, record: body });
		} catch (error) {
			throw mapStoreError(error, id);
		}
		if (!result.ok) {
			// A create-or-replace carries no expected revision, so only the store itself can refuse it.
			throw new StoreError("io", `${sentence} store failure at ${docId(id)}: the ledger refused a create-or-replace (${result.code})`);
		}
		return { ...body, revision: result.revision } as T;
	};

	// `dir` is the contract's field for the store's own location. A ledger store keeps
	// no files of its own, so it names the ledger directory the socket serves from.
	const listRows = (): CasListRow[] => {
		try {
			return requestSync<CasListRow[]>(socketPath, "casList", { store });
		} catch (error) {
			throw mapStoreError(error, "*");
		}
	};

	const listed = (row: CasListRow): CasListed<T> => {
		const id = idFor(row.id);
		return { id, record: parse({ ...row.record, revision: row.revision }, id), revision: row.revision };
	};

	/** Every record of the store. A record the owner's validation refuses stops the listing. */
	const list = (): CasListed<T>[] => listRows().map(listed);

	/**
	 * Every record of the store, and the records it could not read reported beside them: a record
	 * the owner's validation refuses is skipped, never a throw for the whole listing. The owner
	 * decides what a skipped record means; the store only says which ones it could not read.
	 */
	const listWithSkipped = (): CasListOutcome<T> => {
		const rows: CasListed<T>[] = [];
		const skipped: { id: string; error: string }[] = [];
		for (const row of listRows()) {
			try {
				rows.push(listed(row));
			} catch (error) {
				skipped.push({ id: row.id, error: messageOf(error) });
			}
		}
		return { rows, skipped };
	};

	return { dir: dirname(socketPath), read, update, put, list, listWithSkipped, readWithRevision };
}

/** One write of a `commit`: the same compare-and-set rule as `update`, several at once. `record` is the owner's own record (JSON-serializable by construction) or null for a removal. */
export type CasCommitWrite = {
	store: string;
	id: string;
	expectedRevision: number | undefined;
	record: unknown;
};

/** `commit`'s answer: the new revisions and event ids, or the index of the stale write that refused the whole commit. */
export type CasCommitResult =
	| { ok: true; revisions: number[]; eventIds: string[] }
	| { ok: false; code: "conflict"; index: number };

/**
 * One commit over several store records (LC5): all writes or none, for a change
 * that spans two records that used to be two files. The caller passes the
 * expected revision it read for each record; a stale revision refuses the whole
 * commit and names the write. `requestId` makes a repeated commit write nothing.
 */
export function ledgerCommit(
	socketPath: string,
	params: { requestId: string; cas: CasCommitWrite[]; events?: JsonObject[] },
): CasCommitResult {
	return requestSync<CasCommitResult>(socketPath, "commit", {
		requestId: params.requestId,
		// The owner's record is serialized as it stands; the daemon stores the JSON object.
		cas: params.cas as unknown as JsonObject[],
		events: params.events ?? [],
	});
}
