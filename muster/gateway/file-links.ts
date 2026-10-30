/**
 * Link tokens for `/files/`: the capability Henry's `curl` carries, because it has no bearer token.
 *
 * A token is 32 random bytes, base64url. Only its SHA-256 is stored, as
 * `<gatewayStateDir>/links/<hash>.json`, written with a temp file and a rename. A link lasts one
 * hour. A `get` link serves one attachment at most five times and minting a new one for the same
 * attachment revokes the old ones. A `put` link takes one successful upload and is spent only after
 * the file is stored and delivered. Expired files are removed at start and whenever a link is made.
 *
 * Nothing here ever returns, logs or stores a token. `linkShortId` is the first 8 hex characters of
 * the hash: the only form of a link that may appear in the audit log.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

export const LINK_TTL_MS = 60 * 60 * 1000;
export const MAX_GETS_PER_LINK = 5;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const HASH_SHAPE = /^[0-9a-f]{64}$/;

export type LinkRecord = {
	kind: "get" | "put";
	expiresAt: number;
	attachmentId?: string;
	to?: string;
	note?: string;
	gets?: number;
	spent?: boolean;
};

export function linksDir(gatewayStateDir: string): string {
	return join(gatewayStateDir, "links");
}

export function tokenHash(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/** First 8 hex characters of the token's hash. Safe to log. Works for any string a client sent. */
export function linkShortId(token: string): string {
	return tokenHash(token.slice(0, 256)).slice(0, 8);
}

function linkFile(gatewayStateDir: string, hash: string): string {
	return join(linksDir(gatewayStateDir), `${hash}.json`);
}

function writeLink(gatewayStateDir: string, hash: string, record: LinkRecord): void {
	const dir = linksDir(gatewayStateDir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const target = linkFile(gatewayStateDir, hash);
	const tmp = `${target}.tmp-${process.pid}`;
	const fd = openSync(tmp, "w", 0o600);
	try {
		writeSync(fd, JSON.stringify(record));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, target);
}

function parseLink(raw: string): LinkRecord | undefined {
	try {
		const parsed = JSON.parse(raw) as LinkRecord;
		if ((parsed.kind !== "get" && parsed.kind !== "put") || typeof parsed.expiresAt !== "number") return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

/** Remove expired link files. Returns how many were removed. */
export function sweepExpiredLinks(gatewayStateDir: string, now: Date): number {
	const dir = linksDir(gatewayStateDir);
	if (!existsSync(dir)) return 0;
	let removed = 0;
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		try {
			const record = parseLink(readFileSync(join(dir, name), "utf8"));
			if (record === undefined || record.expiresAt <= now.getTime()) {
				rmSync(join(dir, name), { force: true });
				removed += 1;
			}
		} catch {
			// A file that cannot be read is left for the next sweep.
		}
	}
	return removed;
}

/**
 * Make a link and return its token. Expired links are swept first. A new `get` link for an
 * attachment revokes the earlier `get` links for it.
 */
export function mintLink(gatewayStateDir: string, link: Omit<LinkRecord, "expiresAt" | "gets" | "spent">, now: Date): string {
	sweepExpiredLinks(gatewayStateDir, now);
	if (link.kind === "get" && link.attachmentId !== undefined) revokeGetLinks(gatewayStateDir, link.attachmentId);
	const token = randomBytes(32).toString("base64url");
	writeLink(gatewayStateDir, tokenHash(token), { ...link, expiresAt: now.getTime() + LINK_TTL_MS, ...(link.kind === "get" ? { gets: 0 } : { spent: false }) });
	return token;
}

function revokeGetLinks(gatewayStateDir: string, attachmentId: string): void {
	const dir = linksDir(gatewayStateDir);
	if (!existsSync(dir)) return;
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		try {
			const record = parseLink(readFileSync(join(dir, name), "utf8"));
			if (record?.kind === "get" && record.attachmentId === attachmentId) rmSync(join(dir, name), { force: true });
		} catch {
			// An unreadable file is not a live link.
		}
	}
}

/** The link a token names, or undefined for a token of the wrong shape, one that was never made, was revoked or has expired. */
export function readLink(gatewayStateDir: string, token: string, now: Date): { hash: string; record: LinkRecord } | undefined {
	if (!TOKEN_SHAPE.test(token)) return undefined;
	const hash = tokenHash(token);
	try {
		const record = parseLink(readFileSync(linkFile(gatewayStateDir, hash), "utf8"));
		if (record === undefined || record.expiresAt <= now.getTime()) return undefined;
		return { hash, record };
	} catch {
		return undefined;
	}
}

/** Count one GET. False when the link has been used five times. Synchronous, so two requests cannot both take the last use. */
export function spendGet(gatewayStateDir: string, hash: string): boolean {
	if (!HASH_SHAPE.test(hash)) return false;
	const record = parseLink(readFileSync(linkFile(gatewayStateDir, hash), "utf8"));
	if (record === undefined || record.kind !== "get") return false;
	const gets = record.gets ?? 0;
	if (gets >= MAX_GETS_PER_LINK) return false;
	writeLink(gatewayStateDir, hash, { ...record, gets: gets + 1 });
	return true;
}

/** Mark a `put` link spent. Called only after the file is stored and delivered. */
export function markSpent(gatewayStateDir: string, hash: string): void {
	if (!HASH_SHAPE.test(hash)) return;
	const record = parseLink(readFileSync(linkFile(gatewayStateDir, hash), "utf8"));
	if (record !== undefined) writeLink(gatewayStateDir, hash, { ...record, spent: true });
}
