/**
 * The switch (LC2, §3.1): `<musterStateDir>/backend.json` says where every store
 * owner reads and writes.
 *
 * Phase A lands the ledger inert behind this file (LC-D2, LD41) and every owner
 * reads it on every call, so a long-lived process — a Pi session, the gateway,
 * the tick — follows a flip on its own next owner call without a restart. The
 * file is about 100 bytes and only the flip tool writes it, by temporary name,
 * fsync and rename (LC15); nothing else in Muster writes it.
 *
 * LC-D4 fail-closed: a missing file means `files`, which is today's behaviour,
 * and an unparseable or unknown file throws on read and write alike. An owner
 * that guessed would read or write the wrong store, and a read that answered
 * "absent" while `musterd` was down would let the tick treat live lanes as gone.
 *
 * Node builtins only, no cache: the Claude hook bundle loads this module.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type BackendName = "files" | "ledger";

export type BackendState =
	| { backend: "files" }
	| { backend: "frozen"; from: BackendName; to: BackendName; flipId: string; at: string }
	| { backend: "ledger"; flipId: string; at: string; cursor: string };

/** The one switch file. Exported so the flip tool and the owners name it in one place. */
export function backendPath(musterStateDir: string): string {
	return join(musterStateDir, "backend.json");
}

/** A write was attempted while the stores were frozen for a flip. Owners spool their one-time signals, else they fail. */
export class MusterFrozen extends Error {
	constructor() {
		super("muster is switching stores; retry in a minute");
		this.name = "MusterFrozen";
	}
}

/** The switch file exists but is not a switch record. Owners do not guess; the flip tool or a hand edit must fix it. */
export class BackendStateError extends Error {
	constructor(detail: string) {
		super(`backend.json is unusable: ${detail}`);
		this.name = "BackendStateError";
	}
}

function backendName(value: unknown): BackendName | undefined {
	return value === "files" || value === "ledger" ? value : undefined;
}

/** The file's text, or undefined when there is no file. Any other read failure is a broken switch, not a missing one. */
function readSwitchFile(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new BackendStateError(`${file} cannot be read (${error instanceof Error ? error.message : String(error)})`);
	}
}

/** Reads `<musterStateDir>/backend.json` on every call. Missing file: files. */
export function backendState(musterStateDir: string): BackendState {
	const file = backendPath(musterStateDir);
	const text = readSwitchFile(file);
	if (text === undefined) return { backend: "files" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new BackendStateError(`${file} is not JSON`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new BackendStateError(`${file} is not an object`);
	const record = parsed as Record<string, unknown>;
	switch (record["backend"]) {
		case "files":
			return { backend: "files" };
		case "ledger": {
			const flipId = record["flipId"];
			const at = record["at"];
			const cursor = record["cursor"];
			if (typeof flipId !== "string" || typeof at !== "string" || typeof cursor !== "string") {
				throw new BackendStateError(`${file} names the ledger without flipId, at and cursor`);
			}
			return { backend: "ledger", flipId, at, cursor };
		}
		case "frozen": {
			const from = backendName(record["from"]);
			const to = backendName(record["to"]);
			const flipId = record["flipId"];
			const at = record["at"];
			if (from === undefined || to === undefined || typeof flipId !== "string" || typeof at !== "string") {
				throw new BackendStateError(`${file} names a freeze without from, to, flipId and at`);
			}
			return { backend: "frozen", from, to, flipId, at };
		}
		default:
			throw new BackendStateError(`${file} names an unknown backend ${JSON.stringify(record["backend"])}`);
	}
}

/** The backend an owner reads from now: `files`, `ledger`, or for `frozen` its `from`. */
export function readBackend(musterStateDir: string): BackendName {
	const state = backendState(musterStateDir);
	return state.backend === "frozen" ? state.from : state.backend;
}

/** The backend an owner writes to now. Throws `MusterFrozen` while frozen. */
export function writeBackend(musterStateDir: string): BackendName {
	const state = backendState(musterStateDir);
	if (state.backend === "frozen") throw new MusterFrozen();
	return state.backend;
}
