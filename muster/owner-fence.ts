/**
 * The shared owner fence and compare-and-set file store.
 *
 * Two records give one session exclusive ownership with an epoch that rises on
 * every change of owner: the programme control record (`control.ts`) and the
 * seat record (`seats.ts`). Both use this one fence check and this one store
 * contract, so there is a single implementation of "who may still act".
 *
 * - `OwnerFence` / `ownerFenceSatisfied`: a transition must still find exactly
 *   the session, physical process and epoch it was admitted under.
 * - `fileCasStore`: one JSON file per id, read fresh from disk, written only
 *   through `updateJsonSettingsFile` (lock, fsync, rename) with an
 *   expected-revision check. The caller supplies the record validation and its
 *   own typed error class, so each owner keeps its own error codes and wording;
 *   `fileName`, `recordNoun` and `passThrough` let a caller keep its own stored
 *   file layout, message wording and internal refusals.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { updateJsonSettingsFile } from "../core/atomic-settings.ts";

/** When present, a transition must still find this exact session, physical process and epoch. */
export type OwnerFence = {
	sessionId: string;
	processKey: string;
	epoch: number;
};

/** Fencing predicate: true when no fence is given, or the record still carries exactly that owner epoch. */
export function ownerFenceSatisfied(
	owner: OwnerFence | null | undefined,
	fence: OwnerFence | undefined,
): boolean {
	if (fence === undefined) return true;
	if (owner === null || owner === undefined) return false;
	return owner.sessionId === fence.sessionId && owner.processKey === fence.processKey && owner.epoch === fence.epoch;
}

/** Compare-and-set attempts before a contended transition is reported. */
export const CAS_ATTEMPTS = 5;

export type CasStoreErrorCode = "missing" | "malformed" | "conflict" | "io";

/** The owner's typed store error: a class whose first constructor argument is the code. */
export type CasStoreErrorClass = new (code: CasStoreErrorCode, message: string) => Error;

export type CasRecord = { revision: number };

export type CasStore<T extends CasRecord> = {
	dir: string;
	/** Fresh disk read; `undefined` when the record does not exist yet. */
	read(id: string): T | undefined;
	/**
	 * Atomic compare-and-set. `expectedRevision === undefined` creates a new
	 * record; otherwise the stored revision must match exactly.
	 */
	update(id: string, expectedRevision: number | undefined, mutate: (current: T | undefined) => T): T;
	/**
	 * Create or replace the record, whatever revision is stored: one write that
	 * cannot conflict (LC18). A record that is a fresh snapshot of live state — a
	 * lane card, a heartbeat — is written through this, not `update`: under
	 * contention every `update` but one loses, while the last snapshot is the one
	 * worth keeping. The store stamps the revision the write landed on.
	 */
	put(id: string, record: Omit<T, "revision">): T;
};

export type CasStoreOptions<T extends CasRecord> = {
	dir: string;
	/** Ids are file names: this pattern is what keeps them inside `dir`. */
	idPattern: RegExp;
	/** What an id names in "invalid <idKind> id" (for example `programme`). */
	idKind: string;
	/** Lowercase noun in every message (for example `programme control` gives "Programme control record ..."). */
	noun: string;
	/** Noun for one stored artifact in messages; default `record`. An owner whose messages say `file` or `state` keeps them. */
	recordNoun?: string;
	/** File name for one id; default `${id}.json`. An owner keeps its own layout (for example `<id>.decisions.json`). */
	fileName?: (id: string) => string;
	validate(raw: unknown): { ok: true; record: T } | { ok: false; errors: string[] };
	errorClass: CasStoreErrorClass;
	/** Errors the store returns unchanged instead of mapping: a caller's own refusal thrown from `mutate`. */
	passThrough?: (error: unknown) => boolean;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function fileCasStore<T extends CasRecord>(options: CasStoreOptions<T>): CasStore<T> {
	const { dir, idPattern, idKind, validate, errorClass: StoreError, fileName, passThrough } = options;
	const recordNoun = options.recordNoun ?? "record";
	const sentence = options.noun.charAt(0).toUpperCase() + options.noun.slice(1);
	const pathFor = (id: string): string => {
		if (!idPattern.test(id)) throw new StoreError("io", `invalid ${idKind} id: ${id}`);
		return fileName ? fileName(id) : join(dir, `${id}.json`);
	};
	const parse = (raw: unknown, path: string): T => {
		const validated = validate(raw);
		if (!validated.ok) {
			throw new StoreError("malformed", `${sentence} ${recordNoun} ${path} is invalid: ${validated.errors.join("; ")}`);
		}
		return validated.record;
	};
	const mapStoreError = (error: unknown, path: string): Error => {
		if (error instanceof StoreError) return error;
		if (passThrough?.(error)) return error as Error;
		const message = messageOf(error);
		if (message.includes("Malformed settings file")) return new StoreError("malformed", message);
		return new StoreError("io", `${sentence} store failure at ${path}: ${message}`);
	};
	return {
		dir,
		read(id: string): T | undefined {
			const path = pathFor(id);
			if (!existsSync(path)) return undefined;
			let raw: string;
			try {
				raw = readFileSync(path, "utf8");
			} catch (error) {
				throw new StoreError("io", `${sentence} ${recordNoun} unreadable at ${path}: ${messageOf(error)}`);
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch (error) {
				throw new StoreError("malformed", `${sentence} ${recordNoun} not JSON at ${path}: ${messageOf(error)}`);
			}
			return parse(parsed, path);
		},
		update(id, expectedRevision, mutate) {
			const path = pathFor(id);
			try {
				return updateJsonSettingsFile<Record<string, unknown>>(path, {}, (current) => {
					const stored = Object.keys(current).length === 0 ? undefined : parse(current, path);
					if (expectedRevision === undefined) {
						if (stored !== undefined) throw new StoreError("conflict", `${sentence} ${recordNoun} ${path} already exists`);
					} else if (stored === undefined) {
						throw new StoreError("missing", `No ${options.noun} ${recordNoun} at ${path}`);
					} else if (stored.revision !== expectedRevision) {
						throw new StoreError(
							"conflict",
							`${sentence} revision conflict for ${id}: expected ${expectedRevision}, current ${stored.revision}`,
						);
					}
					const next = mutate(stored);
					return parse(next, path) as unknown as Record<string, unknown>;
				}) as unknown as T;
			} catch (error) {
				throw mapStoreError(error, path);
			}
		},
		put(id, record) {
			const path = pathFor(id);
			try {
				return updateJsonSettingsFile<Record<string, unknown>>(path, {}, (current) => {
					const stored = Object.keys(current).length === 0 ? undefined : parse(current, path);
					// One above whatever is stored, so a writer that held the old revision stays stale.
					return parse({ ...record, revision: (stored?.revision ?? 0) + 1 }, path) as unknown as Record<string, unknown>;
				}) as unknown as T;
			} catch (error) {
				throw mapStoreError(error, path);
			}
		},
	};
}
