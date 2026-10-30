/**
 * Pending PC actions (VR24-74, blueprint WP1c points 3 and 4).
 *
 * The loopback listener runs nothing. An action a process on the PC posts to `/cc/api/act` there is stored here
 * as `{id, kind, exact payload, source: "pc", createdAt}`, and runs only when the operator taps Confirm on the phone
 * (`POST /cc/api/confirm/<id>` on the tailnet listener, which calls the same `act` a direct tap calls).
 *
 * Limits: an action lives 5 minutes, at most 3 are pending at once, and a second one for the same kind and
 * target replaces the first. A settled action (confirmed, rejected, replaced, expired) keeps its id for an hour
 * without its payload, so a replay answers 410 and an unknown id answers 404.
 *
 * The state file holds the payloads (mode 0600, written whole through a rename). It is read once when the store
 * is made, so a gateway restart keeps what is still pending; every record is checked again on the way in.
 */

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const PENDING_TTL_MS = 5 * 60 * 1000;
export const PENDING_MAX = 3;
/** How long a settled action's id is remembered, so a replay is told apart from an id that never existed. */
export const SETTLED_KEEP_MS = 60 * 60 * 1000;
export const PENDING_FILE = "cc-pending.json";
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_FILE_BYTES = 256 * 1024;

export type PendingStatus = "pending" | "confirmed" | "rejected" | "replaced" | "expired";

type PendingRecord = {
	id: string;
	kind: string;
	target: string;
	source: "pc";
	createdAt: string;
	expiresAt: string;
	status: PendingStatus;
	/** Dropped when the action settles: a settled id is only a tombstone. */
	payload?: Record<string, unknown>;
	settledAt?: string;
};

/** What the phone page lists: the exact payload and a digest of it that Confirm sends back. */
export type PendingView = { id: string; kind: string; payload: Record<string, unknown>; digest: string; createdAt: string; expiresAt: string };
/** What the PC page lists: that something waits, never what it says. */
export type PendingPcView = Pick<PendingView, "id" | "kind" | "createdAt" | "expiresAt">;

export type PendingCreated = { ok: true; id: string; kind: string; expiresAt: string; replaced: string | null } | { ok: false; status: number; error: string };
export type PendingClaim = { ok: true; id: string; kind: string; payload: Record<string, unknown> } | { ok: false; status: number; error: string };

export type PendingStore = {
	create: (payload: Record<string, unknown>) => PendingCreated;
	/** Pending and unexpired, oldest first. */
	list: () => PendingView[];
	/** Marks the action confirmed and hands out its payload, once. `digest` must be that of the payload the phone showed. */
	claim: (id: string, digest: string) => PendingClaim;
	reject: (id: string) => { ok: true; id: string; kind: string } | { ok: false; status: number; error: string };
};

/** The digest the phone page carries back: a hash of the payload exactly as stored. */
export function payloadDigest(payload: Record<string, unknown>): string {
	return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 32);
}

/** The thing an action is about, so that a second action on it replaces the first. */
export function pendingTarget(payload: Record<string, unknown>): string {
	const field = ((): string => {
		switch (payload["action"]) {
			case "stop":
				return "lane";
			case "answer":
			case "card":
				return "id";
			case "message":
				return "to";
			default:
				return "";
		}
	})();
	const value = field === "" ? undefined : payload[field];
	return typeof value === "string" ? value : "";
}

function validRecord(value: unknown): value is PendingRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if (typeof record["id"] !== "string" || !ID_PATTERN.test(record["id"])) return false;
	if (typeof record["kind"] !== "string" || typeof record["target"] !== "string" || record["source"] !== "pc") return false;
	if (!["pending", "confirmed", "rejected", "replaced", "expired"].includes(String(record["status"]))) return false;
	for (const key of ["createdAt", "expiresAt"]) if (typeof record[key] !== "string" || Number.isNaN(Date.parse(record[key] as string))) return false;
	if (record["status"] === "pending") return typeof record["payload"] === "object" && record["payload"] !== null && !Array.isArray(record["payload"]);
	return true;
}

export function createPendingStore(options: { file: string; now?: () => Date; newId?: () => string; ttlMs?: number; max?: number }): PendingStore {
	const now = options.now ?? (() => new Date());
	const ttlMs = options.ttlMs ?? PENDING_TTL_MS;
	const max = options.max ?? PENDING_MAX;
	const newId = options.newId ?? ((): string => randomUUID());
	let records: PendingRecord[] = [];

	try {
		const text = readFileSync(options.file, "utf8");
		if (text.length <= MAX_FILE_BYTES) {
			const parsed = JSON.parse(text) as { actions?: unknown };
			if (Array.isArray(parsed.actions)) records = parsed.actions.filter(validRecord);
		}
	} catch {
		// No file, or one that does not parse: nothing is pending.
	}

	const save = (): void => {
		mkdirSync(dirname(options.file), { recursive: true, mode: 0o700 });
		const temp = `${options.file}.${process.pid}.tmp`;
		writeFileSync(temp, JSON.stringify({ version: 1, actions: records }), { mode: 0o600 });
		chmodSync(temp, 0o600);
		renameSync(temp, options.file);
	};

	const settle = (record: PendingRecord, status: Exclude<PendingStatus, "pending">): void => {
		record.status = status;
		record.settledAt = now().toISOString();
		delete record.payload;
	};

	/** Expires what is past its time and forgets old tombstones. Returns whether anything changed. */
	const sweep = (): boolean => {
		const at = now().getTime();
		let changed = false;
		for (const record of records) {
			if (record.status === "pending" && Date.parse(record.expiresAt) <= at) {
				settle(record, "expired");
				changed = true;
			}
		}
		const kept = records.filter((record) => record.status === "pending" || at - Date.parse(record.settledAt ?? record.expiresAt) < SETTLED_KEEP_MS);
		if (kept.length !== records.length) {
			records = kept;
			changed = true;
		}
		return changed;
	};

	const pendingNow = (): PendingRecord[] => records.filter((record) => record.status === "pending");
	if (sweep()) {
		try {
			save();
		} catch {
			// The next write tries again.
		}
	}

	const persist = (): boolean => {
		try {
			save();
			return true;
		} catch {
			return false;
		}
	};

	return {
		create(payload) {
			sweep();
			const kind = typeof payload["action"] === "string" ? payload["action"] : "";
			const target = pendingTarget(payload);
			const before = records.map((record) => ({ ...record }));
			const same = pendingNow().find((record) => record.kind === kind && record.target === target);
			if (same === undefined && pendingNow().length >= max) return { ok: false, status: 429, error: `${max} actions are already waiting for your tap on the phone` };
			if (same !== undefined) settle(same, "replaced");
			const at = now();
			const record: PendingRecord = { id: newId(), kind, target, source: "pc", createdAt: at.toISOString(), expiresAt: new Date(at.getTime() + ttlMs).toISOString(), status: "pending", payload };
			records.push(record);
			if (!persist()) {
				// A pending action that would be lost by a restart is not kept at all.
				records = before;
				return { ok: false, status: 503, error: "the pending action could not be saved" };
			}
			return { ok: true, id: record.id, kind, expiresAt: record.expiresAt, replaced: same?.id ?? null };
		},
		list() {
			if (sweep()) persist();
			return pendingNow().map((record) => ({ id: record.id, kind: record.kind, payload: record.payload!, digest: payloadDigest(record.payload!), createdAt: record.createdAt, expiresAt: record.expiresAt }));
		},
		claim(id, digest) {
			if (sweep()) persist();
			const record = records.find((entry) => entry.id === id);
			if (record === undefined) return { ok: false, status: 404, error: "not found" };
			if (record.status !== "pending") return { ok: false, status: 410, error: record.status === "expired" ? "this action has expired" : `this action was already ${record.status}` };
			const payload = record.payload!;
			// The phone confirms what it showed: a payload swapped since then is refused and stays pending.
			if (digest !== payloadDigest(payload)) return { ok: false, status: 409, error: "this action changed since you saw it" };
			settle(record, "confirmed");
			persist();
			return { ok: true, id, kind: record.kind, payload };
		},
		reject(id) {
			if (sweep()) persist();
			const record = records.find((entry) => entry.id === id);
			if (record === undefined) return { ok: false, status: 404, error: "not found" };
			if (record.status !== "pending") return { ok: false, status: 410, error: record.status === "expired" ? "this action has expired" : `this action was already ${record.status}` };
			settle(record, "rejected");
			persist();
			return { ok: true, id, kind: record.kind };
		},
	};
}
