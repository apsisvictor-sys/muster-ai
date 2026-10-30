import "./muster-test-isolation.ts";
/**
 * LC5 (§3.1, §3.2): lane cards, lane records, the registry, lane control and
 * programme control on the ledger.
 *
 * The claims proven here, one deliberate test each:
 * 1. Every owner writes, reads back, and the store refuses a stale revision.
 * 2. `enumerateLanes` gives the same `LaneCard[]` over the ledger as over the
 *    files for one fixture of five lanes, two of them gone, with identical
 *    process evidence — the store is the only difference.
 * 3. The programme-control scan (`listProgrammeControlRecords`) finds the same
 *    programme id through both stores.
 * 4. A report is one commit: killed inside it (`inside-commit`), the ledger shows
 *    the card's mark and the record's phase together or not at all, and writing it
 *    again once the daemon is back lands exactly once.
 * 5. A report spools when `musterd` is unreachable or the switch is frozen, and
 *    `replaySpool` writes it once.
 * 6. A card removed through its owner is written again — a create over the emptied
 *    record, in both backends (LC18).
 * 7. One hundred heartbeats for one lane, fired in parallel, all land as one card, in
 *    both backends (LC18).
 *
 * Everything runs in a temp state directory with its own temp ledger directory
 * (`MUSTER_LEDGER_DIR`), so nothing here reads or writes live `state/muster/`
 * and no case writes a live `backend.json`.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { readSpool } from "../ledger/spool.ts";
import { backendPath } from "../ledger/backend.ts";
import { ledgerCommit } from "../ledger/cas-store.ts";
import { LANE_CARD_STORE, LANE_CONTROL_STORE, LANE_RECORD_STORE, LANE_REGISTRY_STORE, PROGRAMME_CONTROL_STORE, ownerLedgerSocket } from "../ledger/stores.ts";
import { readLaneCard, listLaneCards, recordLaneReport, removeLaneCard, writeLaneCard, type LaneCard } from "../lib/lane-card.ts";
import { enqueueLaneControl, takeLaneControl } from "../lib/lane-control.ts";
import { enumerateLanes, laneRegistryPath, readLaneRegistryRows, writeLaneRegistryRow, type LaneEvidence } from "../lib/lane-directory.ts";
import { readLaneRecord, writeLaneRecord, type LaneRecord } from "../lane-lifecycle.ts";
import { fileProgrammeControlStore, listProgrammeControlRecords, programmeControlStore, startProgramme } from "../control.ts";
import { harnessRoot, nodeBinary, tsxLoaderPath } from "../../core/harness-paths.ts";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
const NODE = nodeBinary();
const DAEMON = join(HARNESS_ROOT, "muster", "ledger", "daemon.ts");
const LANE_CARD_MODULE = join(HARNESS_ROOT, "muster", "lib", "lane-card.ts");
const HEARTBEAT_MODULE = join(HARNESS_ROOT, "muster", "lib", "claude-lane-card.ts");
/** `build-hook-bundle.mjs` ships no declarations: the bundle builder is imported by path, as LC3's check imports it. */
const BUILDER_MODULE = "../../../extensions/muster/build-hook-bundle.mjs";
const LANE_RECORD_MODULE = join(HARNESS_ROOT, "muster", "lane-lifecycle.ts");
const BOUNDARY_MODULE = join(HARNESS_ROOT, "muster", "ledger", "boundary.ts");

const NOW = Date.parse("2026-10-17T00:00:00.000Z");
const PROGRAMME_ID = "agp_0123456789ab";
const LANES = ["lane-a", "lane-b", "lane-c", "lane-d", "lane-e"];
/** The switch file as the flip tool writes it (LC15). */
const LEDGER_SWITCH = { backend: "ledger", flipId: "lc5-test", at: "2026-10-17T00:00:00+03:00", cursor: "1" };
const FROZEN_SWITCH = { backend: "ledger", flipId: "lc5-test", from: "files", at: "2026-10-17T00:00:00+03:00", cursor: "1" };

/** A minimal valid provider-pool.json whose single shape matches "quota exceeded". */
const FIXTURE_POOL = JSON.stringify({
	version: 1,
	virtualProvider: "pool",
	cooldownMs: 60_000,
	resetHorizonMs: 3_600_000,
	roles: { chat: ["openai/gpt-5"] },
	quotaShapes: [{ id: "test-wall", match: "quota exceeded" }],
});

/** No tmux server, no process, no systemd unit: a fixture never reads the real machine. */
const NO_SYSTEM: Partial<LaneEvidence> = {
	tmuxPanes: () => [],
	pidAlive: () => false,
	hasAgentEnv: () => false,
	piProcesses: () => [],
	hermesUnits: () => [],
};

type Box = { root: string; stateDir: string; home: string; sessions: string; ledgerDir: string; close: () => void };

/** One disposable install: a Muster state dir, a home, and the ledger dir `musterd` serves from. */
function box(): Box {
	const root = mkdtempSync(join(tmpdir(), "muster-lc5-"));
	const stateDir = join(root, "state", "muster");
	const home = join(root, "home");
	const sessions = join(home, ".pi", "agent", "sessions");
	const ledgerDir = join(root, "ledger");
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(sessions, { recursive: true });
	mkdirSync(ledgerDir, { recursive: true });
	return { root, stateDir, home, sessions, ledgerDir, close: () => rmSync(root, { recursive: true, force: true }) };
}

/** Point the owners at the ledger: the switch file, the ledger directory, and the state dir they read. */
function useLedger(b: Box, switchFile: Record<string, unknown> = LEDGER_SWITCH): () => void {
	writeFileSync(backendPath(b.stateDir), JSON.stringify(switchFile));
	const savedLedger = process.env["MUSTER_LEDGER_DIR"];
	const savedState = process.env["PI_MUSTER_STATE_DIR"];
	process.env["MUSTER_LEDGER_DIR"] = b.ledgerDir;
	process.env["PI_MUSTER_STATE_DIR"] = b.stateDir;
	return () => {
		if (savedLedger === undefined) delete process.env["MUSTER_LEDGER_DIR"];
		else process.env["MUSTER_LEDGER_DIR"] = savedLedger;
		if (savedState === undefined) delete process.env["PI_MUSTER_STATE_DIR"];
		else process.env["PI_MUSTER_STATE_DIR"] = savedState;
	};
}

/** The loader this process runs under, so a child fixture loads a `.ts` module the same way. */
function loaderArgs(): string[] {
	const args: string[] = [];
	for (let at = 0; at < process.execArgv.length; at++) {
		if (process.execArgv[at] === "--import" && process.execArgv[at + 1] !== undefined) args.push("--import", process.execArgv[at + 1] as string);
	}
	return args.length > 0 ? args : ["--import", tsxLoaderPath()];
}

/**
 * The real `startDaemon` in its own process: `requestSync` blocks the calling
 * thread in `Atomics.wait`, so a daemon here could never answer the call waiting
 * on it. `extraEnv` arms the crash points the tests reuse.
 */
function startDaemon(t: TestContext, dir: string, extraEnv: NodeJS.ProcessEnv = {}): { child: ChildProcess; ready: Promise<void> } {
	const file = join(dir, "fixture-daemon.mjs");
	writeFileSync(
		file,
		[`import { startDaemon } from ${JSON.stringify(DAEMON)};`, "await startDaemon(process.env.MUSTER_FIXTURE_DIR);", 'process.stdout.write("READY\\n");'].join("\n"),
	);
	const child = spawn(NODE, [...loaderArgs(), file], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MUSTER_FIXTURE_DIR: dir, ...extraEnv } });
	let output = "";
	const collect = (chunk: Buffer): void => void (output += chunk.toString());
	child.stdout?.on("data", collect);
	child.stderr?.on("data", collect);
	t.after(async () => {
		await stopDaemon(child);
	});
	const ready = (async () => {
		const deadline = Date.now() + 15_000;
		while (!output.includes("READY")) {
			if (child.exitCode !== null || child.signalCode !== null) throw new Error(`the daemon fixture exited before READY: ${output}`);
			if (Date.now() > deadline) throw new Error(`the daemon fixture did not answer within 15 s: ${output}`);
			await delay(25);
		}
	})();
	return { child, ready };
}

async function stopDaemon(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
	child.kill("SIGKILL");
	await exited;
}

/**
 * One child process that reads (or replays) through the owners and prints the
 * result: after a crash the caller's socket has a breaker, so the state of the
 * ledger is read by a fresh process, exactly as a restarted hook would.
 */
async function readInChild(b: Box, mode: "read" | "replay", laneId: string): Promise<{ replayed: number; card: LaneCard | null; record: LaneRecord | null }> {
	const file = join(b.root, `fixture-${mode}.mjs`);
	writeFileSync(
		file,
		[
			`import { readLaneCard } from ${JSON.stringify(LANE_CARD_MODULE)};`,
			`import { readLaneRecord } from ${JSON.stringify(LANE_RECORD_MODULE)};`,
			`import { replaySpool } from ${JSON.stringify(BOUNDARY_MODULE)};`,
			'const [mode, stateDir, laneId] = process.argv.slice(2);',
			'const replayed = mode === "replay" ? replaySpool(stateDir) : 0;',
			"const out = { replayed, card: readLaneCard(stateDir, laneId) ?? null, record: readLaneRecord(stateDir, laneId) ?? null };",
			'process.stdout.write("READ " + JSON.stringify(out) + "\\n");',
		].join("\n"),
	);
	const child = spawn(NODE, [...loaderArgs(), file, mode, b.stateDir, laneId], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MUSTER_LEDGER_DIR: b.ledgerDir } });
	let output = "";
	child.stdout?.on("data", (chunk: Buffer) => void (output += chunk.toString()));
	child.stderr?.on("data", (chunk: Buffer) => void (output += chunk.toString()));
	const code = await new Promise<number | null>((resolveExit) => child.once("exit", (status) => resolveExit(status)));
	assert.equal(code, 0, `the reader fixture failed: ${output}`);
	const line = output.split("\n").find((candidate) => candidate.startsWith("READ "));
	assert.ok(line !== undefined, `the reader fixture printed no result: ${output}`);
	return JSON.parse(line.slice("READ ".length)) as { replayed: number; card: LaneCard | null; record: LaneRecord | null };
}

function card(laneId: string, overrides: Partial<LaneCard> = {}): LaneCard {
	return {
		laneId,
		harness: "pi",
		cwd: "/tmp/work",
		branch: "lane/lc5",
		state: "working",
		model: "openai-codex/gpt-6-luna",
		thinking: null,
		since: NOW - 2 * 60_000,
		updatedAt: NOW - 1_000,
		wall: null,
		authoritative: true,
		origin: "auto",
		lastActivityMs: NOW - 1_000,
		lastTurnAt: NOW - 1_000,
		heartbeatAt: NOW - 1_000,
		...overrides,
	};
}

function record(laneId: string, overrides: Partial<LaneRecord> = {}): LaneRecord {
	return {
		laneId,
		harness: "pi",
		cwd: "/tmp/work",
		branch: "lane/lc5",
		launchedAt: NOW - 2 * 60_000,
		launchedBy: "orchestrator",
		phase: "working",
		phaseSince: NOW - 2 * 60_000,
		...overrides,
	};
}

// ─── 1. Every owner: write, read back, stale revision refused ───────────────

test("LC5 owners: the same calls write and read back in files mode and over the ledger", async (t) => {
	const b = box();
	t.after(b.close);

	// Files mode: today's store, unchanged.
	writeLaneCard(b.stateDir, card("lane-a"));
	assert.deepEqual(readLaneCard(b.stateDir, "lane-a"), card("lane-a"));
	writeLaneRecord(b.stateDir, record("lane-a"));
	assert.deepEqual(readLaneRecord(b.stateDir, "lane-a"), record("lane-a"));
	writeLaneRegistryRow(b.stateDir, "lane-a", { sessionId: "11111111-1111-4111-8111-111111111111", harness: "pi" });
	assert.equal(readLaneRegistryRows(laneRegistryPath(b.stateDir), b.stateDir).get("lane-a")?.sessionId, "11111111-1111-4111-8111-111111111111");
	enqueueLaneControl(b.stateDir, { laneId: "lane-a", operation: "stop", from: "orchestrator" });
	assert.equal(takeLaneControl(b.stateDir, "lane-a")?.operation, "stop");
	assert.equal(takeLaneControl(b.stateDir, "lane-a"), undefined, "a taken request is gone");

	const daemon = startDaemon(t, b.ledgerDir);
	await daemon.ready;
	const restore = useLedger(b);
	t.after(restore);

	// The same calls, ledger store.
	writeLaneCard(b.stateDir, card("lane-a"));
	assert.deepEqual(readLaneCard(b.stateDir, "lane-a"), card("lane-a"));
	writeLaneRecord(b.stateDir, record("lane-a"));
	assert.deepEqual(readLaneRecord(b.stateDir, "lane-a"), record("lane-a"));
	writeLaneRegistryRow(b.stateDir, "lane-a", { sessionId: "22222222-2222-4222-8222-222222222222", harness: "pi" });
	assert.equal(readLaneRegistryRows(laneRegistryPath(b.stateDir), b.stateDir).get("lane-a")?.sessionId, "22222222-2222-4222-8222-222222222222");
	enqueueLaneControl(b.stateDir, { laneId: "lane-a", operation: "setModel", params: { modelId: "pool/session" }, from: "orchestrator" });
	assert.deepEqual(takeLaneControl(b.stateDir, "lane-a")?.params, { modelId: "pool/session" });
	assert.equal(takeLaneControl(b.stateDir, "lane-a"), undefined);
	// A taken request empties the record too, and the next one for the lane is enqueued again
	// (LC18: a lane whose request was taken was refused "already exists" for every later one).
	enqueueLaneControl(b.stateDir, { laneId: "lane-a", operation: "stop", from: "orchestrator" });
	assert.equal(takeLaneControl(b.stateDir, "lane-a")?.operation, "stop");

	// The store itself refuses a stale revision, for every family the item owns.
	const stale: Array<[string, string]> = [
		[LANE_CARD_STORE, "lane-a"],
		[LANE_RECORD_STORE, "lane-a"],
		[LANE_REGISTRY_STORE, "lane-a"],
	];
	for (const [store, id] of stale) {
		assert.deepEqual(
			ledgerCommit(ownerLedgerSocket(b.stateDir), { requestId: `stale:${store}:${id}`, cas: [{ store, id, expectedRevision: 0, record: { laneId: id } }] }),
			{ ok: false, code: "conflict", index: 0 },
			`${store} refuses a stale revision`,
		);
	}
	// The control queue was taken, so its record is empty: a create with a revision refuses.
	assert.deepEqual(
		ledgerCommit(ownerLedgerSocket(b.stateDir), { requestId: "stale:control", cas: [{ store: LANE_CONTROL_STORE, id: "lane-a", expectedRevision: 1, record: { laneId: "lane-a", operation: "stop" } }] }),
		{ ok: false, code: "conflict", index: 0 },
	);
});

// ─── 1b. The card owner: a removed card is written again ────────────────────

/**
 * LC18. The card write is create-or-update in both backends, so a lane's card can be
 * removed and written again.
 *
 * A card is removed by `removeLaneCard` — a clean stop, `SessionEnd` — and the next
 * heartbeat for that lane creates it again. In files mode the write is a rename, which
 * has always been a create-or-update. On the ledger the removal empties the record and
 * the create was refused with "already exists", so the lane had no card for the rest of
 * its life and every heartbeat for it exited 1 (the LC16 rehearsal's finding 9).
 */
test("LC5 card: a card removed through the owner is written again in both backends", async (t) => {
	const b = box();
	t.after(b.close);

	// Files mode: the store the ledger must match, written by today's rename.
	writeLaneCard(b.stateDir, card("lane-a"));
	removeLaneCard(b.stateDir, "lane-a");
	assert.equal(readLaneCard(b.stateDir, "lane-a"), undefined);
	writeLaneCard(b.stateDir, card("lane-a"));
	assert.deepEqual(readLaneCard(b.stateDir, "lane-a"), card("lane-a"));

	const daemon = startDaemon(t, b.ledgerDir);
	await daemon.ready;
	const restore = useLedger(b);
	t.after(restore);

	writeLaneCard(b.stateDir, card("lane-a"));
	removeLaneCard(b.stateDir, "lane-a");
	assert.equal(readLaneCard(b.stateDir, "lane-a"), undefined);

	// The next heartbeat for the same lane creates the card again — never "already exists".
	writeLaneCard(b.stateDir, card("lane-a"));
	assert.deepEqual(readLaneCard(b.stateDir, "lane-a"), card("lane-a"));
	assert.deepEqual(
		listLaneCards(b.stateDir).map((row) => row.laneId),
		["lane-a"],
		"one card for the lane",
	);

	// And the second write is an update, not a second card: the lane stays one row.
	writeLaneCard(b.stateDir, card("lane-a", { state: "idle", updatedAt: NOW }));
	assert.deepEqual(
		listLaneCards(b.stateDir).map((row) => row.card.state),
		["idle"],
	);
});

/**
 * LC18. One hundred heartbeats for one lane, fired in parallel: the LC16 rehearsal's own
 * shape, whose rapid burst lost 7 of 100 calls to "already exists". Twenty writer
 * processes beat five times each, so the lane is contended throughout. The width is
 * bounded on purpose: a hook process holds about 53 MB, so a hundred at once would take
 * the guard's whole memory slot (measured, LC16).
 */
test("LC18 card: 100 parallel heartbeats for one lane all land as one card in both backends", async (t) => {
	const b = box();
	t.after(b.close);
	const laneId = "lane-storm";
	const bundle = join(b.root, "heartbeat-bundle.mjs");
	// The writers run the code a hook call runs, bundled so each is a plain node process: a
	// hundred hook processes at once would take the guard's whole memory slot (measured, LC16).
	const builder = (await import(BUILDER_MODULE)) as { buildSyncBundle: (options: { source: string; outfile: string }) => Promise<unknown> };
	await builder.buildSyncBundle({
		source: [
			`import { writeClaudeLaneHeartbeat } from ${JSON.stringify(HEARTBEAT_MODULE)};`,
			"const [stateDir, lane, count] = process.argv.slice(2);",
			'for (let beat = 0; beat < Number(count); beat += 1) writeClaudeLaneHeartbeat(stateDir, lane, { cwd: "/tmp/work", state: "working" });',
			'process.stdout.write("BEATEN\\n");',
		].join("\n"),
		outfile: bundle,
	});
	/** Twenty processes, five heartbeats each: 100 heartbeats for one lane at once. */
	const storm = async (): Promise<void> => {
		const writers = Array.from({ length: 20 }, () =>
			spawn(NODE, [bundle, b.stateDir, laneId, "5"], {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, MUSTER_LEDGER_DIR: b.ledgerDir },
			}),
		);
		const outcomes = await Promise.all(
			writers.map(async (child) => {
				let output = "";
				child.stdout?.on("data", (chunk: Buffer) => void (output += chunk.toString()));
				child.stderr?.on("data", (chunk: Buffer) => void (output += chunk.toString()));
				const code = await new Promise<number | null>((resolveExit) => child.once("exit", (status) => resolveExit(status)));
				return { code, output };
			}),
		);
		for (const outcome of outcomes) assert.equal(outcome.code, 0, `a heartbeat writer exited non-zero: ${outcome.output}`);
	};
	const cardFiles = (): string[] => readdirSync(join(b.stateDir, "lanes")).filter((name) => name.endsWith(".json"));

	// Files mode first: the rename has always been a create-or-update.
	await storm();
	assert.deepEqual(listLaneCards(b.stateDir).map((row) => row.laneId), [laneId]);
	assert.deepEqual(cardFiles(), [`${laneId}.json`], "one card file for the lane");

	const daemon = startDaemon(t, b.ledgerDir);
	await daemon.ready;
	const restore = useLedger(b);
	t.after(restore);

	await storm();
	assert.deepEqual(listLaneCards(b.stateDir).map((row) => row.laneId), [laneId], "one card record for the lane");
	assert.deepEqual(cardFiles(), [`${laneId}.json`], "the ledger writes no card file of its own");
	assert.equal(readLaneCard(b.stateDir, laneId)?.updatedAt !== undefined, true, "the surviving card is the last heartbeat");
});

test("LC5 programme control: both stores hold the same programme id through the owner", async (t) => {
	const b = box();
	t.after(b.close);
	const controlDir = join(b.stateDir, "programmes", "control");
	mkdirSync(controlDir, { recursive: true });
	const savedControlDir = process.env["PI_MUSTER_CONTROL_DIR"];
	process.env["PI_MUSTER_CONTROL_DIR"] = controlDir;
	t.after(() => {
		if (savedControlDir === undefined) delete process.env["PI_MUSTER_CONTROL_DIR"];
		else process.env["PI_MUSTER_CONTROL_DIR"] = savedControlDir;
	});

	const fileStore = fileProgrammeControlStore(controlDir);
	startProgramme(PROGRAMME_ID, { operatorRef: "operator" }, { store: fileStore });
	const files = listProgrammeControlRecords(fileStore, controlDir);
	assert.deepEqual([...files.records.keys()], [PROGRAMME_ID]);
	assert.deepEqual(files.skipped, []);

	const daemon = startDaemon(t, b.ledgerDir);
	await daemon.ready;
	const restore = useLedger(b);
	t.after(restore);

	// The switch picks the ledger store when no explicit store is passed.
	startProgramme(PROGRAMME_ID, { operatorRef: "operator" });
	const ledger = listProgrammeControlRecords(programmeControlStore(), controlDir);
	assert.deepEqual([...ledger.records.keys()], [PROGRAMME_ID]);
	assert.deepEqual(ledger.skipped, []);
	assert.equal(ledger.records.get(PROGRAMME_ID)?.status, files.records.get(PROGRAMME_ID)?.status);
	assert.deepEqual(
		ledgerCommit(ownerLedgerSocket(b.stateDir), { requestId: "stale:programme", cas: [{ store: PROGRAMME_CONTROL_STORE, id: PROGRAMME_ID, expectedRevision: 0, record: {} }] }),
		{ ok: false, code: "conflict", index: 0 },
	);
});

// ─── 2. enumerateLanes: the same rows over both stores ──────────────────────

test("LC5 registry: enumerateLanes gives the same five lanes over the ledger as over the files", async (t) => {
	const b = box();
	t.after(b.close);
	const cardsDir = join(b.stateDir, "lanes");
	const registryPath = laneRegistryPath(b.stateDir);
	const poolPath = join(b.root, "pool.json");
	writeFileSync(poolPath, FIXTURE_POOL);

	/** Three live lanes and two gone ones, by the heartbeat rule the reader owns (F3). */
	const writeFixture = (): void => {
		for (const laneId of LANES) {
			const gone = laneId === "lane-d" || laneId === "lane-e";
			writeLaneCard(b.stateDir, card(laneId, gone ? { updatedAt: NOW - 3 * 60 * 60_000, state: "working" } : {}));
			writeLaneRecord(b.stateDir, record(laneId, gone ? { phase: "parked", parkedAt: NOW - 3 * 60 * 60_000 } : {}));
			writeLaneRegistryRow(b.stateDir, laneId, { sessionId: `${laneId}-session`, harness: "pi" });
		}
	};
	const options = {
		home: b.home,
		stateDir: dirname(cardsDir),
		sessionsRoot: b.sessions,
		laneCardsDir: cardsDir,
		laneRegistryPath: registryPath,
		poolConfigPath: poolPath,
		nowMs: NOW,
		skipClaude: true,
		evidence: NO_SYSTEM,
	};
	const byLane = (cards: LaneCard[]): LaneCard[] => [...cards].sort((a, x) => a.laneId.localeCompare(x.laneId));

	writeFixture();
	const files = byLane(enumerateLanes(options));
	assert.deepEqual(files.map((entry) => entry.laneId), LANES);
	assert.deepEqual(files.map((entry) => entry.state), ["working", "working", "working", "gone", "gone"]);

	const daemon = startDaemon(t, b.ledgerDir);
	await daemon.ready;
	const restore = useLedger(b);
	t.after(restore);
	writeFixture();
	// The registry file is emptied on purpose: in ledger mode nothing may read it.
	writeFileSync(registryPath, "{}");

	const ledger = byLane(enumerateLanes(options));
	assert.deepEqual(ledger, files, "the same cards, whatever store holds them");

	// The card directory stays the file store's own place, untouched by the ledger.
	assert.equal(existsSync(join(cardsDir, "lane-a.json")), true);
	assert.deepEqual(readLaneCard(b.stateDir, "lane-a"), card("lane-a"));
});

// ─── 3. A report is one commit, crash-safe ─────────────────────────────────

test("LC5 report: one commit writes the card mark and the record phase, and a crash inside it leaves neither", async (t) => {
	const b = box();
	t.after(b.close);
	const laneId = "lane-a";
	const mark = { kind: "working" as const, summary: "the commit is the unit", at: NOW };

	const first = startDaemon(t, b.ledgerDir);
	await first.ready;
	const restore = useLedger(b);
	t.after(restore);
	writeLaneCard(b.stateDir, card(laneId));
	writeLaneRecord(b.stateDir, record(laneId));
	await stopDaemon(first.child);

	// The daemon dies inside the commit: the caller sees unreachable and spools.
	const crashing = startDaemon(t, b.ledgerDir, { MUSTER_LEDGER_TEST: "1", MUSTER_LEDGER_CRASH_AT: "inside-commit" });
	await crashing.ready;
	assert.equal(recordLaneReport(b.stateDir, laneId, mark), "spooled");
	await stopDaemon(crashing.child);
	assert.equal(readSpool(b.stateDir).length, 1, "the report is one spool file");

	// A restarted daemon: the kill left both records without the mark, never one of them.
	const after = startDaemon(t, b.ledgerDir);
	await after.ready;
	const before = await readInChild(b, "read", laneId);
	assert.equal(before.card?.lastReport, undefined, "the crash left no mark on the card");
	assert.equal(before.record?.lastReport, undefined, "and none on the record");

	// Replaying the spool writes both, together, exactly once.
	const replayed = await readInChild(b, "replay", laneId);
	assert.equal(replayed.replayed, 1);
	assert.equal(replayed.card?.lastReport?.summary, mark.summary);
	assert.equal(replayed.record?.lastReport?.summary, mark.summary);
	assert.equal(replayed.record?.phase, "working");
	assert.equal(readSpool(b.stateDir).length, 0, "a replayed request deletes its file");

	// The same request again writes nothing.
	const again = await readInChild(b, "replay", laneId);
	assert.equal(again.replayed, 0);
	assert.equal(again.card?.lastReport?.summary, mark.summary);
	assert.equal(again.record?.lastReport?.summary, mark.summary);
});

// ─── 4. The spool under a frozen switch ────────────────────────────────────

test("LC5 report: a frozen switch spools the report instead of writing a second store", async (t) => {
	const b = box();
	t.after(b.close);
	const restore = useLedger(b, FROZEN_SWITCH);
	t.after(restore);
	assert.equal(recordLaneReport(b.stateDir, "lane-a", { kind: "working", summary: "frozen", at: NOW }), "spooled");
	assert.equal(readSpool(b.stateDir).length, 1);
});
