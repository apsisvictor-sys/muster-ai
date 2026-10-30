/**
 * `extensions/lib/core/append-line.ts` — the one owner of an fsynced JSONL
 * append (blueprint §5 `core`, send-back F2).
 *
 * Two owners need the same append body: Muster's send log and the operator's queue
 * (`muster/asks.ts`) through `muster/send.ts`, and the routing file
 * `lib/delegate-pool.ts`, which may not import Muster (§5: routing → muster is
 * not allowed). It lives here so neither re-implements it, and `muster/send.ts`
 * re-exports it so its existing callers keep their path.
 */

import { appendFileSync, chmodSync, closeSync, fsyncSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

/**
 * Append one JSONL line under `stateDir` (file mode 0600, fsynced) — the one append body,
 * shared by the send log and the operator's queue (`asks.ts`), so neither is written twice over.
 * The directory is created 0700; a pre-existing directory with wider permissions is not this
 * call's to fix.
 */
export function appendFsyncedLine(stateDir: string, fileName: string, line: string): void {
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(stateDir, 0o700);
	} catch {
		// A pre-existing directory with wider permissions is not this call's to fix.
	}
	appendFsyncedLineTo(join(stateDir, fileName), line);
}

/**
 * The same append body for a file whose path the caller owns: the line is fsynced and a file
 * this call creates gets mode 0600, but the directory keeps the mode it has. A repo tree
 * (`plans/`) is not this call's to chmod, so `appendFsyncedLine` (which owns a state dir)
 * and this entry point share one body and one write.
 */
export function appendFsyncedLineTo(filePath: string, line: string): void {
	const fd = openSync(filePath, "a", 0o600);
	try {
		appendFileSync(fd, line);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
