#!/usr/bin/env node
/**
 * One owner for a lane's OpenCode database (harness bus, 2026-10-08).
 *
 * OpenCode reads its database path from `OPENCODE_DB` — an absolute path, a
 * `:memory:` database, or a name it joins onto its data directory — and there is
 * no flag and no configuration key for it (`opencode db path` proves it). Every
 * lane would otherwise open the agent-wide `opencode.db`, and SQLite serialises
 * writers per database, which is the `database is locked` stall the lanes hit
 * every 20 to 40 minutes.
 *
 * The recipe asks this module for the path before it creates the window (so the
 * variable is set for the host and the TUI pane) and asks it to move an existing
 * session into that database when the lane has one that lives in the shared
 * database. The host asks it whether the variable is set at all and refuses to
 * start a server without it, so a lane can never fall back to the shared
 * database silently.
 *
 * The shared database is only ever read here (`export`), and the source session
 * stays in it: the move copies into the lane's own file and checks that the copy
 * carries the same number of messages before the lane starts.
 */

import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where a lane's database sits inside OpenCode's data directory. */
export const LANES_SUBDIR = "lanes";

export const EXIT_REFUSED = 2;

/**
 * The most output a child may print. The biggest lane session on disk exported 43 MB, so this is a bound that a real
 * session cannot reach, and a child killed for exceeding it is reported by ENOBUFS rather than as a missing session.
 */
const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;

/** OpenCode's own words for a session that is not in the database it was asked about. */
const SESSION_NOT_FOUND = /session not found/i;

/** A lane id is also a file name: keep it plain so the path stays predictable. */
const LANE_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * The database this lane must use.
 *
 * `override` is the recipe's `--db`: absolute or `:memory:`, never relative,
 * because this module prints the path, migrates into it and hands it to the
 * host, so a value that depends on a process's cwd would not be one path.
 * The default is `<OpenCode data dir>/lanes/<lane>.db`, derived from the lane
 * name so the lane store needs no new column.
 */
export function laneDatabasePath({ lane, override = "", dataDir = "" } = {}) {
	const value = typeof override === "string" ? override.trim() : "";
	if (value !== "") {
		if (value === ":memory:") return { path: value };
		if (!isAbsolute(value)) return { error: `--db must be an absolute path or :memory:, got ${value}` };
		return { path: value };
	}
	// The lane name only has to be a file name when the path is derived from it.
	if (typeof lane !== "string" || !LANE_NAME.test(lane)) return { error: `--lane must be a plain name for the database file, got ${JSON.stringify(lane)}` };
	if (typeof dataDir !== "string" || dataDir.trim() === "") return { error: "cannot determine the OpenCode data directory; pass --db <absolute path>" };
	return { path: join(dataDir, LANES_SUBDIR, `${lane}.db`) };
}

/** The environment a lane's own database is used with. */
export function laneEnvironment(dbPath, env = process.env) {
	return { ...env, OPENCODE_DB: dbPath };
}

/** The environment the agent-wide database is read with, whoever runs this. */
export function sharedEnvironment(env = process.env) {
	const copy = { ...env };
	delete copy.OPENCODE_DB;
	return copy;
}

/**
 * OpenCode's own answer to "where do you keep your data", asked of the binary
 * the lane will run, so the data-dir rule stays OpenCode's (it follows
 * `XDG_DATA_HOME`, and `debug paths` is the command that reports it).
 */
export function opencodeDataDir(opencodeBin, { run = defaultRun } = {}) {
	const result = run(opencodeBin, ["debug", "paths"]);
	if (result.status !== 0) return { error: `opencode debug paths failed (${result.status}): ${firstLine(result.stderr)}` };
	const row = result.stdout.split("\n").map((line) => line.trim().split(/\s+/)).find((fields) => fields[0] === "data");
	const dir = row?.[1] ?? "";
	return dir === "" ? { error: "opencode debug paths printed no data row" } : { dataDir: dir };
}

/** The database OpenCode would use for everything if this lane had no override. */
export function sharedDatabasePath(opencodeBin, { run = defaultRun, env = process.env } = {}) {
	const result = run(opencodeBin, ["db", "path"], { env: sharedEnvironment(env) });
	const path = result.stdout.trim();
	if (result.status !== 0 || path === "") return { error: `opencode db path failed (${result.status}): ${firstLine(result.stderr)}` };
	return { path };
}

/** One session read through OpenCode's own export, with its message count. */
export function readSession(opencodeBin, dbPath, sessionId, { run = defaultRun, env = process.env } = {}) {
	const result = run(opencodeBin, ["export", sessionId], { env: laneEnvironment(dbPath, env), capture: "file" });
	if (result.status !== 0) {
		// "Not here" and "the read did not work" are different answers, and the callers above must not confuse them:
		// a 43 MB export killed for exceeding a buffer bound once read as a session that was in neither database.
		if (SESSION_NOT_FOUND.test(String(result.stderr ?? ""))) return { ok: false, missing: true, reason: `session ${sessionId} is not in ${dbPath}` };
		return { ok: false, reason: `reading session ${sessionId} from ${dbPath} failed (status ${result.status ?? "none"}): ${firstLine(result.stderr) || "no error output"}` };
	}
	let parsed;
	try {
		parsed = JSON.parse(result.stdout);
	} catch (error) {
		return { ok: false, reason: `opencode export ${sessionId} printed unreadable JSON (${Buffer.byteLength(result.stdout ?? "", "utf8")} bytes): ${firstLine(error?.message)}` };
	}
	if (!Array.isArray(parsed?.messages)) return { ok: false, reason: `opencode export ${sessionId} printed no messages array` };
	return { ok: true, json: result.stdout, messages: parsed.messages };
}

/**
 * Make sure the lane's database holds `sessionId`, copying it out of the shared
 * database when that is where it lives. The shared database is only read, the
 * source session stays in it, and the copy is checked against the source's
 * message count before this returns — an incomplete copy is an error, never a
 * started lane.
 */
export function ensureSessionInLaneDatabase({ lane, sessionId, laneDb, opencodeBin, run = defaultRun, env = process.env, log = () => {} } = {}) {
	// The one thing that must never happen is this lane reading the agent-wide
	// database, so the path is checked before anything is copied into it.
	const shared = sharedDatabasePath(opencodeBin, { run, env });
	if (shared.error !== undefined) return { error: shared.error };
	if (resolve(shared.path) === resolve(laneDb)) {
		return { error: `the lane database is the agent's shared database (${laneDb}); refusing to move ${sessionId} into it` };
	}
	const here = readSession(opencodeBin, laneDb, sessionId, { run, env });
	if (here.ok) return { status: "already", messages: here.messages.length };
	// A lane database that could not be read is broken, not empty: only a real miss lets the move look further.
	if (here.missing !== true) return { error: here.reason };
	const source = readSession(opencodeBin, shared.path, sessionId, { run, env });
	if (!source.ok) {
		return { error: source.missing === true ? `session ${sessionId} is in neither ${laneDb} nor ${shared.path}` : source.reason };
	}
	const directory = mkdtempSync(join(tmpdir(), "oc-lane-db-"));
	const file = join(directory, `${sessionId}.json`);
	try {
		writeFileSync(file, source.json, { mode: 0o600 });
		const imported = run(opencodeBin, ["import", file], { env: laneEnvironment(laneDb, env) });
		if (imported.status !== 0) return { error: `opencode import into ${laneDb} failed (${imported.status}): ${firstLine(imported.stderr)}` };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
	const target = readSession(opencodeBin, laneDb, sessionId, { run, env });
	if (!target.ok) return { error: target.missing === true ? `the copied session ${sessionId} is not readable in ${laneDb}` : target.reason };
	if (target.messages.length !== source.messages.length) {
		return { error: `the copy of ${sessionId} is incomplete: ${laneDb} has ${target.messages.length} messages, the source has ${source.messages.length}` };
	}
	log(`moved session ${sessionId} into ${laneDb} (${target.messages.length} messages)`);
	return { status: "copied", messages: target.messages.length };
}

function firstLine(text) {
	return String(text ?? "").split("\n")[0].trim();
}

/**
 * The real command runner: no shell, explicit environment, captured output.
 *
 * `maxBuffer` is a generous fixed bound rather than Node's 1 MiB default: a real lane session exported 43,357,366 bytes
 * (2026-10-08), and at the default the child was killed with ENOBUFS — which every caller above then read as "this session
 * is not in that database", refusing a move that would have worked. A killed or failed child keeps its own words in
 * `stderr`, because the callers tell a miss from a broken read by that text.
 *
 * `capture: "file"` writes the child's stdout to a private file instead of a pipe. `opencode export` prints its 43 MB of
 * JSON and exits without waiting for a pipe to drain, so a pipe capture loses the tail: measured on the real session, the
 * same command produced 8 KB to 1.6 MB of unterminated JSON through a pipe and the complete 43,357,366 bytes through a file.
 */
export function defaultRun(command, args, { env = process.env, cwd, capture = "pipe" } = {}) {
	if (capture === "file") {
		const directory = mkdtempSync(join(tmpdir(), "oc-capture-"));
		const file = join(directory, "stdout.json");
		const descriptor = openSync(file, "w", 0o600);
		let result;
		try {
			// stdout goes to the file descriptor (a synchronous write target), stderr stays a pipe for the failure text.
			result = spawnSync(command, args, { stdio: ["ignore", descriptor, "pipe"], encoding: "utf8", env, cwd });
		} finally {
			closeSync(descriptor);
		}
		const captured = runResult(result);
		if (captured.status === 0) captured.stdout = readFileSync(file, "utf8");
		rmSync(directory, { recursive: true, force: true });
		return captured;
	}
	return runResult(spawnSync(command, args, { encoding: "utf8", env, cwd, maxBuffer: MAX_OUTPUT_BYTES }));
}

/** A spawnSync result in the shape this module's callers use, with a spawn failure named in `stderr`. */
function runResult(result) {
	const spawnError = result.error;
	return {
		status: result.status ?? (spawnError === undefined ? 1 : 127),
		stdout: result.stdout ?? "",
		stderr: String(result.stderr ?? "") !== "" ? result.stderr : spawnError === undefined ? "" : String(spawnError.message ?? spawnError),
	};
}

// ─── Command line ────────────────────────────────────────────────────────────
// The recipe calls `path` before it creates the window and `ensure` before it
// replaces one; a refusal is exit 2 and a message on stderr, never a silent
// fallback to the shared database.

const USAGE = `lane-database.mjs path --lane <lane> [--db <absolute path>] [--opencode <bin>]
lane-database.mjs ensure --lane <lane> --db <absolute path> --session <ses_...> [--opencode <bin>]`;

export function runCli(argv, { run = defaultRun, env = process.env, stdout = (text) => process.stdout.write(text), stderr = (text) => process.stderr.write(text) } = {}) {
	const [mode, ...rest] = argv;
	const flags = {};
	for (let i = 0; i < rest.length; i += 1) {
		const flag = rest[i];
		if (!flag.startsWith("--")) return { error: `unexpected argument ${flag}`, usage: true };
		const next = rest[i + 1];
		if (next === undefined) return { error: `${flag} needs a value`, usage: true };
		flags[flag.slice(2)] = next;
		i += 1;
	}
	const lane = flags.lane ?? "";
	const opencodeBin = flags.opencode ?? env.OPENCODE_BIN ?? "opencode";
	if (mode === "path") {
		let dataDir = "";
		if ((flags.db ?? "") === "") {
			const probed = opencodeDataDir(opencodeBin, { run });
			if (probed.error !== undefined) return { error: probed.error };
			dataDir = probed.dataDir;
		}
		const resolved = laneDatabasePath({ lane, override: flags.db ?? "", dataDir });
		if (resolved.error !== undefined) return { error: resolved.error };
		stdout(`${resolved.path}\n`);
		return { path: resolved.path };
	}
	if (mode === "ensure") {
		if ((flags.db ?? "") === "") return { error: "ensure needs --db <absolute path>", usage: true };
		if ((flags.session ?? "") === "") return { error: "ensure needs --session <ses_...>", usage: true };
		if (flags.db === ":memory:") return { error: "a session cannot be moved into an in-memory database" };
		const moved = ensureSessionInLaneDatabase({ lane, sessionId: flags.session, laneDb: flags.db, opencodeBin, run, env, log: (line) => stdout(`${line}\n`) });
		if (moved.error !== undefined) return { error: moved.error };
		if (moved.status === "already") stdout(`lane database ${flags.db} already holds ${flags.session} (${moved.messages} messages)\n`);
		return moved;
	}
	void stderr;
	return { error: mode === undefined ? "a mode is required" : `unknown mode ${mode}`, usage: true };
}

/**
 * True when this module is the process entry. Symlink-tolerant: the harness link
 * (`<agent>/harness` -> `<agent>/packages`) is a sanctioned invocation path (§7), and
 * Node resolves `import.meta.url` to the real path, so a plain comparison misses it.
 */
function isProcessEntry() {
	if (process.argv[1] === undefined) return false;
	const real = (path) => {
		try {
			return realpathSync(path);
		} catch {
			return resolve(path);
		}
	};
	return real(process.argv[1]) === real(fileURLToPath(import.meta.url));
}

if (isProcessEntry()) {
	const result = runCli(process.argv.slice(2));
	if (result.error !== undefined) {
		process.stderr.write(`lane-database: ${result.error}\n`);
		if (result.usage === true) process.stderr.write(`${USAGE}\n`);
		process.exit(EXIT_REFUSED);
	}
}
