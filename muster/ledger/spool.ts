/**
 * The DL6 spool: the one-time writes a lane makes while `musterd` is down.
 *
 * One file per request. The JSON goes to `<dir>/spool/.<requestId>.tmp`, is
 * fsynced, and is renamed to `<dir>/spool/<requestId>.json`, so a file is whole
 * or absent, two writers never share one, and a client that writes the same
 * request again replaces it with the same content. A replay reads the files
 * oldest first, replays each through the same method and deletes it after its
 * commit (LC2, outside `musterd`); the request id makes a replay of an
 * already-committed request write nothing.
 *
 * Node builtins only: the client bundles this module.
 */

import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";

/** A request waiting for `musterd`. Only the one-time writes are spooled (DL6). */
export type SpoolRequest = {
	method: "appendEvent";
	params: { requestId: string } & Record<string, unknown>;
};

/** A `<requestId>.tmp` older than this was torn by a crash; it is removed and ignored. */
const TMP_MAX_AGE_MS = 60_000;

function spoolDir(dir: string): string {
	return join(dir, "spool");
}

/** Never let a request id become a path separator. */
function safeName(requestId: string): string {
	return requestId.replace(/[\\/]/g, "_");
}

/** Write one request as its own file, whole or absent. Returns the file written. */
export function spoolWrite(dir: string, req: SpoolRequest): string {
	const target = spoolDir(dir);
	mkdirSync(target, { recursive: true });
	const name = safeName(req.params.requestId);
	const temporary = join(target, `.${name}.tmp`);
	const final = join(target, `${name}.json`);
	const fd = openSync(temporary, "w");
	try {
		writeSync(fd, JSON.stringify(req));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, final);
	return final;
}

/** Every spooled request, oldest first. Torn temporary files older than a minute are removed and ignored. */
export function readSpool(dir: string): { path: string; req: SpoolRequest }[] {
	const target = spoolDir(dir);
	if (!existsSync(target)) return [];
	const now = Date.now();
	const files: { path: string; name: string; mtime: number }[] = [];
	for (const name of readdirSync(target)) {
		const path = join(target, name);
		if (name.endsWith(".tmp")) {
			try {
				if (now - statSync(path).mtimeMs > TMP_MAX_AGE_MS) rmSync(path, { force: true });
			} catch {
				// Already gone; nothing to clean.
			}
			continue;
		}
		if (!name.endsWith(".json")) continue;
		try {
			files.push({ path, name, mtime: statSync(path).mtimeMs });
		} catch {
			// Already gone; nothing to read.
		}
	}
	files.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
	const requests: { path: string; req: SpoolRequest }[] = [];
	for (const file of files) {
		try {
			requests.push({ path: file.path, req: JSON.parse(readFileSync(file.path, "utf8")) as SpoolRequest });
		} catch {
			// Unreadable or torn: leave it for a later pass rather than dropping a request.
		}
	}
	return requests;
}

/** Delete one spool file after its request committed. */
export function removeSpoolFile(path: string): void {
	rmSync(path, { force: true });
}
