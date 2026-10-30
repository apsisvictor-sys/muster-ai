/**
 * Attachment store — the bytes behind a file sent with an inbox message.
 *
 * The message (`agent-inbox.ts`) stays the one record of who sent what to whom. This
 * store keeps bytes only: `<musterStateDir>/attachments/<attachmentId>/` holds `data`
 * and `meta.json`. It is the only code that writes, lists and resolves those files, and
 * a file is always resolved by its id, never by its name.
 *
 * The upload path is reachable from the internet (gateway `/files/`), so the caps live
 * here, in one place. Attachments are kept; nothing deletes them automatically.
 */

import { createReadStream } from "node:fs";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";

export type AttachmentRef = { id: string; name: string; size: number; sha256: string };

export type AttachmentMeta = AttachmentRef & { from: string; to: string; at: string };

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 200 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENTS = 10;
const MAX_NAME_CHARS = 120;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class AttachmentTooLarge extends Error {
	readonly limit: number;
	constructor(limit: number) {
		super(`the file is larger than ${limit} bytes`);
		this.limit = limit;
	}
}

export function attachmentsRoot(musterStateDir: string): string {
	return join(musterStateDir, "attachments");
}

export function isAttachmentId(id: string): boolean {
	return UUID.test(id);
}

/** Base name only; separators, `..`, control characters, `"` and `\` are replaced. */
export function sanitizeAttachmentName(name: string): string {
	const base = basename(name.replace(/\\/g, "/"));
	const cleaned = base
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f"\\/]/g, "_")
		.replace(/\.\.+/g, "_")
		.trim()
		.slice(0, MAX_NAME_CHARS);
	return cleaned === "" || cleaned === "." ? "file" : cleaned;
}

/** A set of files for one message: at most 10 files and 200 MiB, each at most 50 MiB. */
export function assertAttachmentSet(sizes: readonly number[]): void {
	if (sizes.length > MAX_MESSAGE_ATTACHMENTS) throw new Error(`at most ${MAX_MESSAGE_ATTACHMENTS} files can be attached to one message (got ${sizes.length})`);
	for (const size of sizes) if (size > MAX_ATTACHMENT_BYTES) throw new AttachmentTooLarge(MAX_ATTACHMENT_BYTES);
	if (sizes.reduce((sum, size) => sum + size, 0) > MAX_MESSAGE_ATTACHMENT_BYTES) throw new AttachmentTooLarge(MAX_MESSAGE_ATTACHMENT_BYTES);
}

function writeWhole(path: string, body: string): void {
	const tmp = `${path}.tmp-${process.pid}`;
	const fd = openSync(tmp, "w", 0o600);
	try {
		writeSync(fd, body);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
}

/**
 * Copy or stream one file into the store. Hashes while writing, fsyncs, renames `data` into
 * place and writes `meta.json` last, so a reader never sees a stored file without its meta.
 * Over the cap, or on a stream error, the whole attachment directory is removed.
 */
export async function storeAttachment(
	musterStateDir: string,
	input: { sourcePath: string; stream?: undefined; name?: string; from: string; to: string; maxBytes?: number } | { stream: AsyncIterable<Buffer | string>; sourcePath?: undefined; name: string; from: string; to: string; maxBytes?: number },
): Promise<AttachmentRef> {
	const id = randomUUID();
	const dir = join(attachmentsRoot(musterStateDir), id);
	const limit = input.maxBytes ?? MAX_ATTACHMENT_BYTES;
	const name = sanitizeAttachmentName(input.name ?? input.sourcePath ?? "file");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tmp = join(dir, `data.tmp-${process.pid}`);
	const fd = openSync(tmp, "w", 0o600);
	const hash = createHash("sha256");
	let size = 0;
	try {
		try {
			const source: AsyncIterable<Buffer | string> = input.stream ?? createReadStream(input.sourcePath!);
			for await (const chunk of source) {
				const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
				size += buffer.length;
				if (size > limit) throw new AttachmentTooLarge(limit);
				hash.update(buffer);
				writeSync(fd, buffer);
			}
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, join(dir, "data"));
		const ref: AttachmentRef = { id, name, size, sha256: hash.digest("hex") };
		const meta: AttachmentMeta = { ...ref, from: input.from, to: input.to, at: new Date().toISOString() };
		writeWhole(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
		return ref;
	} catch (error) {
		rmSync(dir, { recursive: true, force: true });
		throw error;
	}
}

/** The path of `data` and the meta, or undefined. The id must be a UUID before any path is built. */
export function resolveAttachment(musterStateDir: string, id: string): { path: string; meta: AttachmentMeta } | undefined {
	if (!isAttachmentId(id)) return undefined;
	const dir = join(attachmentsRoot(musterStateDir), id);
	const path = join(dir, "data");
	if (!existsSync(path)) return undefined;
	try {
		const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as AttachmentMeta;
		if (meta.id !== id) return undefined;
		return { path, meta };
	} catch {
		return undefined;
	}
}

/** `1.5 MiB` style size for the one plain line per file in a message. */
export function formatAttachmentSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** The refs of a parsed message field; anything that is not a well-formed ref is dropped. */
export function attachmentRefs(value: unknown): AttachmentRef[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is AttachmentRef => typeof item?.id === "string" && typeof item?.name === "string" && typeof item?.size === "number" && typeof item?.sha256 === "string");
}
