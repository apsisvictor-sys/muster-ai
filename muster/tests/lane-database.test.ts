/**
 * One owner for a lane's OpenCode database: the path, the move of an existing
 * session into it, and the refusals. OpenCode itself is never run here — the
 * module takes its command runner as an argument, so these cover the decisions
 * (which path, copy or not, complete copy or not) without a real database.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	EXIT_REFUSED,
	ensureSessionInLaneDatabase,
	laneDatabasePath,
	laneEnvironment,
	opencodeDataDir,
	readSession,
	runCli,
	sharedDatabasePath,
	sharedEnvironment,
} from "../lane-database.mjs";

const LANE_DB = "/data/opencode/lanes/oc-db.db";
const SHARED_DB = "/data/opencode/opencode.db";
const SESSION = "ses_ee72aaf21ffeks0c3DexsKbq9z";

interface Call {
	command: string;
	args: string[];
	database: string | undefined;
}

function exportJson(messageCount: number): string {
	return JSON.stringify({ info: { id: SESSION, directory: "/tmp/lane" }, messages: Array.from({ length: messageCount }, (_, index) => ({ info: { id: `msg_${index}`, role: "user" }, parts: [] })) });
}

function ok(stdout: string): { status: number; stdout: string; stderr: string } {
	return { status: 0, stdout, stderr: "" };
}

// ─── The path ────────────────────────────────────────────────────────────────

test("the lane database is <data>/lanes/<lane>.db, and only an absolute --db moves it", () => {
	assert.equal(laneDatabasePath({ lane: "oc-db", dataDir: "/data/opencode" }).path, LANE_DB);
	// --db wins, absolute or in memory, and the lane name then stops mattering.
	assert.equal(laneDatabasePath({ lane: "oc-db", override: "/tmp/other.db", dataDir: "/data/opencode" }).path, "/tmp/other.db");
	assert.equal(laneDatabasePath({ lane: "oc-db", override: ":memory:" }).path, ":memory:");
	assert.equal(laneDatabasePath({ lane: "oc/db", override: "/tmp/other.db" }).path, "/tmp/other.db");
	// A relative --db would be one path here and another inside OpenCode's process.
	assert.match(laneDatabasePath({ lane: "oc-db", override: "lanes/x.db" }).error ?? "", /absolute path/);
	// No data dir and no --db is a refusal, never a default that shares the agent database.
	assert.match(laneDatabasePath({ lane: "oc-db" }).error ?? "", /cannot determine the OpenCode data directory/);
	assert.match(laneDatabasePath({ lane: "oc db" , dataDir: "/data/opencode" }).error ?? "", /plain name/);
});

test("the two environments differ only in OPENCODE_DB", () => {
	const lane = laneEnvironment(LANE_DB, { OPENCODE_DB: SHARED_DB, HOME: "/home/operator" });
	assert.equal(lane.OPENCODE_DB, LANE_DB);
	const shared = sharedEnvironment({ OPENCODE_DB: SHARED_DB, HOME: "/home/operator" });
	assert.equal(shared.OPENCODE_DB, undefined);
	assert.equal(shared.HOME, "/home/operator");
});

test("the data directory and the shared path come from OpenCode, not from a copy of its rule", () => {
	const calls: Call[] = [];
	const run = (command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
		calls.push({ command, args, database: options.env?.OPENCODE_DB });
		if (args[1] === "paths") return ok("home       /home/operator\ndata       /data/opencode\nbin        /cache/opencode/bin\n");
		return ok(`${SHARED_DB}\n`);
	};
	assert.equal(opencodeDataDir("opencode", { run }).dataDir, "/data/opencode");
	assert.equal(sharedDatabasePath("opencode", { run, env: { OPENCODE_DB: LANE_DB } }).path, SHARED_DB);
	// The shared path must be asked for without the lane's variable, or it answers with the lane file.
	assert.equal(calls[1].database, undefined);
	const failing = () => ({ status: 127, stdout: "", stderr: "opencode: command not found" });
	assert.match(opencodeDataDir("opencode", { run: failing }).error ?? "", /command not found/);
	assert.match(sharedDatabasePath("opencode", { run: failing }).error ?? "", /command not found/);
});

test("reading a session is OpenCode's export, and its message count is the check", () => {
	const seen: Array<NodeJS.ProcessEnv | undefined> = [];
	const run = (_command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
		seen.push(options.env);
		if (args[1] === "ses_missing") return { status: 1, stdout: "", stderr: "Error: Session not found: ses_missing\n" };
		if (args[1] === "ses_notjson") return ok("Exporting session: ses_x\n");
		return ok(exportJson(4));
	};
	const found = readSession("opencode", LANE_DB, "ses_x", { run });
	assert.equal(found.ok, true);
	assert.equal(found.ok === true ? found.messages.length : -1, 4);
	assert.equal(seen[0]?.OPENCODE_DB, LANE_DB);
	assert.equal(readSession("opencode", LANE_DB, "ses_missing", { run }).ok, false);
	assert.equal(readSession("opencode", LANE_DB, "ses_notjson", { run }).ok, false);
});

test("a real session is far bigger than Node's 1 MiB default, and reading it is not an error", () => {
	// Measured 2026-10-08: a real lane session exported 43,357,366 bytes of JSON. spawnSync's default maxBuffer is 1 MiB,
	// so the child died with ENOBUFS and the move reported the session as living in neither database.
	const messages = 24_000;
	const bin = join(mkdtempSync(join(tmpdir(), "oc-fake-opencode-")), "opencode");
	writeFileSync(bin, `#!/usr/bin/env node\nconst messages = Array.from({ length: ${messages} }, (_, index) => ({ info: { id: "msg_" + index }, parts: [{ type: "text", text: "x".repeat(200) }] }));\nprocess.stdout.write(JSON.stringify({ info: { id: "${SESSION}" }, messages }));\n`, { mode: 0o755 });
	const read = readSession(bin, SHARED_DB, SESSION);
	assert.equal(read.ok, true, read.ok === true ? "" : read.reason);
	assert.equal(read.ok === true ? read.messages.length : -1, messages);
	assert.ok(Buffer.byteLength(read.ok === true ? read.json : "", "utf8") > 5 * 1024 * 1024, "the export is past the old bound");
});

test("an export that exits without draining a pipe is still read in full", () => {
	// The deeper cause, measured on the real session (2026-10-08): `opencode export` writes its JSON and exits without
	// waiting for the pipe to drain, so a pipe capture loses the tail — 43,357,366 bytes arrived as 8 KB to 1.6 MB of
	// unterminated JSON, and the move read that as a session living in neither database. Written to a file it is complete.
	const messages = 24_000;
	const bin = join(mkdtempSync(join(tmpdir(), "oc-fake-opencode-exit-")), "opencode");
	writeFileSync(bin, `#!/usr/bin/env node\nconst messages = Array.from({ length: ${messages} }, (_, index) => ({ info: { id: "msg_" + index }, parts: [{ type: "text", text: "x".repeat(200) }] }));\nprocess.stdout.write(JSON.stringify({ info: { id: "${SESSION}" }, messages }));\nprocess.exit(0);\n`, { mode: 0o755 });
	const read = readSession(bin, SHARED_DB, SESSION);
	assert.equal(read.ok, true, read.ok === true ? "" : read.reason);
	assert.equal(read.ok === true ? read.messages.length : -1, messages);
});

test("a read that failed is reported by its reason, never as a session that is not in the database", () => {
	// `defaultRun` turns a null status (a killed child) into 127 and keeps the child's own words in stderr.
	const killed = () => ({ status: 127, stdout: "", stderr: "spawnSync /usr/bin/opencode ENOBUFS" });
	const read = readSession("/usr/bin/opencode", SHARED_DB, SESSION, { run: killed });
	assert.equal(read.ok, false);
	assert.match(read.reason, /ENOBUFS/);
	assert.doesNotMatch(read.reason, /is not in/);

	// The same distinction where it matters: a broken read of the shared database is an error, not "in neither".
	const broken = (command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
		if (args[0] === "db") return ok(`${SHARED_DB}\n`);
		if (options.env?.OPENCODE_DB === LANE_DB) return { status: 1, stdout: "", stderr: "Session not found" };
		return { status: 127, stdout: "", stderr: "spawnSync /usr/bin/opencode ENOBUFS" };
	};
	const moved = ensureSessionInLaneDatabase({ lane: "oc-db", sessionId: SESSION, laneDb: LANE_DB, opencodeBin: "opencode", run: broken });
	assert.match(moved.error ?? "", /ENOBUFS/);
	assert.doesNotMatch(moved.error ?? "", /in neither/);
});

// ─── Moving a session into the lane database ─────────────────────────────────

test("a session already in the lane database is left alone", () => {
	const imports: string[] = [];
	const run = (command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
		if (args[0] === "import") imports.push(String(args[1]));
		if (args[0] === "db") return ok(`${SHARED_DB}\n`);
		return ok(exportJson(2));
	};
	const moved = ensureSessionInLaneDatabase({ lane: "oc-db", sessionId: SESSION, laneDb: LANE_DB, opencodeBin: "opencode", run });
	assert.equal(moved.status, "already");
	assert.equal(moved.messages, 2);
	assert.deepEqual(imports, [], "nothing is copied when the lane already has it");
});

test("a session in the shared database is copied into the lane database, and the copy is counted", () => {
	const calls: Call[] = [];
	const imports: string[] = [];
	let laneHas = false;
	const run = (command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
		const database = options.env?.OPENCODE_DB;
		calls.push({ command, args, database });
		if (args[0] === "db" && args[1] === "path") return ok(`${SHARED_DB}\n`);
		if (args[0] === "export") {
			if (database === LANE_DB) return laneHas ? ok(exportJson(4)) : { status: 1, stdout: "", stderr: "Session not found" };
			return ok(exportJson(4));
		}
		if (args[0] === "import") {
			imports.push(String(args[1]));
			laneHas = true;
			return ok(`Imported session: ${SESSION}\n`);
		}
		throw new Error(`unexpected command ${args.join(" ")}`);
	};
	const moved = ensureSessionInLaneDatabase({ lane: "oc-db", sessionId: SESSION, laneDb: LANE_DB, opencodeBin: "opencode", run });
	assert.equal(moved.status, "copied");
	assert.equal(moved.messages, 4);
	assert.equal(imports.length, 1, "the export is imported exactly once");
	assert.equal(imports[0].startsWith(join(tmpdir(), "oc-lane-db-")), true, "the export goes through a private temp file");
	assert.equal(existsSync(imports[0]), false, "the temp file is removed again");
	// The shared database is only ever exported from, never written to.
	const sharedWrites = calls.filter((call) => call.args[0] === "import" && call.database === SHARED_DB);
	assert.deepEqual(sharedWrites, []);
	assert.deepEqual(calls.filter((call) => call.args[0] === "export").map((call) => call.database), [LANE_DB, SHARED_DB, LANE_DB]);
});

test("an incomplete copy is an error, not a started lane", () => {
	let laneHas = false;
	const run = (command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
		if (args[0] === "db") return ok(`${SHARED_DB}\n`);
		if (args[0] === "import") {
			laneHas = true;
			return ok("Imported session\n");
		}
		// Four messages in the shared database, three in the lane's after the import.
		return options.env?.OPENCODE_DB === LANE_DB ? (laneHas ? ok(exportJson(3)) : { status: 1, stdout: "", stderr: "Session not found" }) : ok(exportJson(4));
	};
	const moved = ensureSessionInLaneDatabase({ lane: "oc-db", sessionId: SESSION, laneDb: LANE_DB, opencodeBin: "opencode", run });
	assert.match(moved.error ?? "", /incomplete.*3 messages.*4/s);
});

test("a session in neither database, a shared probe that fails, and a lane database that is the shared one are all refused", () => {
	let laneHas = false;
	const missing = (command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
		if (args[0] === "db") return ok(`${SHARED_DB}\n`);
		if (args[0] === "import") {
			laneHas = true;
			return ok("Imported session\n");
		}
		if (args[0] === "export" && options.env?.OPENCODE_DB !== LANE_DB) return { status: 1, stdout: "", stderr: "Session not found" };
		return laneHas ? ok(exportJson(1)) : { status: 1, stdout: "", stderr: "Session not found" };
	};
	const notFound = ensureSessionInLaneDatabase({ lane: "oc-db", sessionId: SESSION, laneDb: LANE_DB, opencodeBin: "opencode", run: missing });
	assert.match(notFound.error ?? "", /neither .*lanes\/oc-db\.db nor .*opencode\.db/);

	const probeFails = (command: string, args: string[]) => (args[0] === "db" ? { status: 1, stdout: "", stderr: "locked" } : { status: 1, stdout: "", stderr: "Session not found" });
	assert.match(ensureSessionInLaneDatabase({ lane: "oc-db", sessionId: SESSION, laneDb: LANE_DB, opencodeBin: "opencode", run: probeFails }).error ?? "", /db path failed/);

	// The lane variable pointing at the agent database is the failure mode the whole change removes.
	const sharedOwn = (command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
		if (args[0] === "db") return ok(`${SHARED_DB}\n`);
		return options.env?.OPENCODE_DB === SHARED_DB ? ok(exportJson(1)) : { status: 1, stdout: "", stderr: "Session not found" };
	};
	const refused = ensureSessionInLaneDatabase({ lane: "oc-db", sessionId: SESSION, laneDb: SHARED_DB, opencodeBin: "opencode", run: sharedOwn });
	assert.match(refused.error ?? "", /refusing to move/);
});

// ─── The recipe's command line ───────────────────────────────────────────────

test("the command line prints one path, or refuses with a message", () => {
	const printed: string[] = [];
	const run = (command: string, args: string[]) => (args[0] === "debug" ? ok("data       /data/opencode\n") : ok(`${SHARED_DB}\n`));
	const result = runCli(["path", "--lane", "oc-db", "--opencode", "opencode"], { run, stdout: (text: string) => printed.push(text) });
	assert.equal(result.path, LANE_DB);
	assert.deepEqual(printed, [`${LANE_DB}\n`]);

	const explicit = runCli(["path", "--lane", "oc-db", "--db", "/tmp/x.db"], { run, stdout: () => {} });
	assert.equal(explicit.path, "/tmp/x.db");
	assert.match(runCli(["path", "--lane", "oc-db", "--db", "relative.db"], { run, stdout: () => {} }).error ?? "", /absolute path/);
	assert.match(runCli(["path", "--lane", "oc-db"], { run: () => ({ status: 1, stdout: "", stderr: "no" }) }).error ?? "", /debug paths failed/);
	assert.match(runCli(["nope"], { run, stdout: () => {} }).error ?? "", /unknown mode/);
	assert.match(runCli(["ensure", "--lane", "oc-db", "--session", SESSION], { run, stdout: () => {} }).error ?? "", /needs --db/);
	assert.match(runCli(["ensure", "--lane", "oc-db", "--db", ":memory:", "--session", SESSION], { run, stdout: () => {} }).error ?? "", /in-memory/);
});

test("the command line reports a moved session and still refuses an incomplete one", () => {
	const printed: string[] = [];
	let laneHas = false;
	const run = (command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
		if (args[0] === "db") return ok(`${SHARED_DB}\n`);
		if (args[0] === "import") {
			laneHas = true;
			return ok("Imported session\n");
		}
		if (args[0] === "export") return options.env?.OPENCODE_DB === LANE_DB ? (laneHas ? ok(exportJson(2)) : { status: 1, stdout: "", stderr: "Session not found" }) : ok(exportJson(2));
		return ok(exportJson(2));
	};
	const moved = runCli(["ensure", "--lane", "oc-db", "--db", LANE_DB, "--session", SESSION, "--opencode", "opencode"], { run, stdout: (text: string) => printed.push(text) });
	assert.equal(moved.status, "copied");
	assert.deepEqual(printed, [`moved session ${SESSION} into ${LANE_DB} (2 messages)\n`]);

	let brokenLaneHas = false;
	const broken = runCli(["ensure", "--lane", "oc-db", "--db", LANE_DB, "--session", SESSION], {
		run: (command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
			if (args[0] === "db") return ok(`${SHARED_DB}\n`);
			if (args[0] === "import") {
				brokenLaneHas = true;
				return ok("Imported session\n");
			}
			if (options.env?.OPENCODE_DB === LANE_DB) return brokenLaneHas ? ok(exportJson(1)) : { status: 1, stdout: "", stderr: "Session not found" };
			return ok(exportJson(2));
		},
		stdout: () => {},
	});
	assert.match(broken.error ?? "", /incomplete/);
	assert.equal(EXIT_REFUSED, 2);
});

test("a refused run leaves the lane database it refused to write untouched", () => {
	// The move writes nothing when the session is not in the shared database: the
	// recipe must not create a half-lane database it then refuses to start.
	const directory = mkdtempSync(join(tmpdir(), "oc-db-touch-"));
	try {
		const dbPath = join(directory, "lane.db");
		writeFileSync(dbPath, "not a database");
		const run = (command: string, args: string[], _options: { env?: NodeJS.ProcessEnv } = {}) => (args[0] === "db" ? { status: 1, stdout: "", stderr: "locked" } : { status: 1, stdout: "", stderr: "Session not found" });
		const refused = ensureSessionInLaneDatabase({ lane: "oc-db", sessionId: SESSION, laneDb: dbPath, opencodeBin: "opencode", run });
		assert.ok(refused.error);
		assert.equal(existsSync(dbPath), true);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
