#!/usr/bin/env node
/**
 * LC14's export: the ledger goes back to the file stores, on a rollback (plan §5
 * CV3's `muster ledger rollback`, RF4).
 *
 * The flip tool runs it with the ledger frozen for writes and `backend.json`
 * naming the **files** backend: the write target is the files, so every record is
 * written by its owner's own files-mode writer (`writeLaneCard`, `writeLaneRecord`,
 * `writeLaneRegistryRow`, `enqueueLaneControl`, `fileProgrammeControlStore`,
 * `fileSeatStore`, `writeInboxMessage`, `appendAskEvent`,
 * `appendOrchestratorEvent`) and no format is implemented twice. The reads come
 * from `musterd`, which serves the ledger whatever the switch file says, so the
 * ledger stays the source of truth until the files hold everything.
 *
 * It removes the doorbells, writes every compare-and-set store back to its owner's
 * files, writes messages back to `inbox/` (accepted) and `read/` (delivered),
 * appends each ask's events past its count in `askCounts` (and every event of an
 * ask raised after the flip) to `asks/events.jsonl` in `at` order, and appends the
 * `muster.event` entries after the flip's cursor to `orchestrator-events.log` and
 * `send-log.jsonl` in their line formats. Seat records keep their epoch, so a
 * holder's token stays valid.
 *
 * Every step is idempotent, so a rerun after a crash in the middle of the export
 * finishes it: a record write replaces the record, a message write replaces the
 * file, and the two logs are appended only with the events after the cursor, which
 * the caller advances to the ledger's last entry id once the export returned.
 *
 * Fidelity the ledger cannot carry, reported rather than invented: a `send-log`
 * line keeps the lane, the time and the attempt's mode, transport and status, and
 * nothing else (`SendLogRecord`'s other fields have no `muster.event` field); a
 * registry row is written through the owner's register writer, which drops a
 * retirement (`lane-directory.ts:1248`), and such a row is counted.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { markInboxMessageRead, writeInboxMessage } from "../lib/agent-inbox.ts";
import type { InboxMessage } from "../lib/agent-inbox.ts";
import { writeLaneCard } from "../lib/lane-card.ts";
import type { LaneCard } from "../lib/lane-card.ts";
import { enqueueLaneControl, LANE_CONTROL_OPERATIONS } from "../lib/lane-control.ts";
import type { LaneControlOperation } from "../lib/lane-control.ts";
import { writeLaneRegistryRow } from "../lib/lane-directory.ts";
import { appendAskEvent, readAsks } from "../asks.ts";
import type { AskEvent } from "../asks.ts";
import { musterStateDir } from "../binding.ts";
import { fileProgrammeControlStore, programmeControlStateDir } from "../control.ts";
import { fileGoalStore, goalsDir } from "../goals.ts";
import { deskDir, fileDeskStore } from "../research-desk.ts";
import { EVENT_KINDS, appendOrchestratorEvent, formatEventLine } from "../lane-report.ts";
import type { EventKind } from "../lane-report.ts";
import { backendState } from "../ledger/backend.ts";
import { requestSync } from "../ledger/client-sync.ts";
import { writeLaneRecord } from "../lane-lifecycle.ts";
import type { LaneRecord } from "../lane-lifecycle.ts";
import { sweepInboxDoorbells } from "../ledger/doorbell.ts";
import type { MessageDoc } from "../ledger/schema.ts";
import { DESK_STORE, GOAL_STORE, LANE_CARD_STORE, LANE_CONTROL_STORE, LANE_RECORD_STORE, LANE_REGISTRY_STORE, PROGRAMME_CONTROL_STORE, ownerLedgerSocket } from "../ledger/stores.ts";
import { SEND_LOG_FILE, appendFsyncedLine } from "../send.ts";
import { fileSeatStore, seatsDir } from "../seats.ts";

/** The store name of the seat family (§2.1). */
const SEAT_STORE = "seat";
/** Import and export batches set their own timeout per call (global constraints). */
const BATCH_TIMEOUT_MS = 30_000;
/**
 * The reply-line bound on this export's own connections (finding 28, LC16c
 * 2026-10-18): the daemon answers `messages`, `asksAll` and `events` for a whole
 * store in one line, and the live orchestrator inbox's delivered history
 * measured 1,232,333 bytes in one reply — past the client's default 1 MiB, which
 * tore the connection down and failed the rollback while `musterd` answered.
 * 64 MiB is about 50x that measured largest reply and still bounded: a desynced
 * stream tears down at this line size instead of growing without end. Every
 * other ledger client keeps the default.
 */
const EXPORT_MAX_LINE_BYTES = 64 * 1024 * 1024;

export type ExportSkip = { what: string; id: string; reason: string };

export type ExportResult = {
	flipId: string;
	cursor: string;
	stores: Record<string, number>;
	accepted: number;
	delivered: number;
	asks: number;
	orchestratorLines: number;
	sendLogLines: number;
	/** Events after the cursor that belong to neither file (they stay in the ledger). */
	otherEvents: number;
	doorbellsRemoved: number;
	skipped: ExportSkip[];
};

export type ExportOptions = {
	flipId: string;
	/** The flip cursor: only entries after it are appended to the two logs. */
	cursor: string;
	/** Each ask's event count at import, from the flip record. */
	askCounts: Record<string, number>;
	stateDir: string;
	socketPath?: string;
	/** The programme-control directory, whose owner derives it from the agent folder. */
	programmeDir?: string;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type CasListRow = { id: string; record: Record<string, unknown>; revision: number };

/** One store's rows, as `casList` answers them. */
function listStore(socketPath: string, store: string): CasListRow[] {
	return requestSync<CasListRow[]>(socketPath, "casList", { store }, { timeoutMs: BATCH_TIMEOUT_MS, maxLineBytes: EXPORT_MAX_LINE_BYTES });
}

/** One record's body with the revision the ledger kept beside it (LC-D3), for a writer whose file holds it. */
function withRevision(row: CasListRow): Record<string, unknown> {
	return { ...row.record, revision: row.revision };
}

/** One record's body without a revision, for a writer whose file format is the record alone. */
function withoutRevision(row: CasListRow): Record<string, unknown> {
	const { revision: _revision, ...record } = row.record;
	return record;
}

/** A message document as the owner's writer takes it. */
function asMessage(doc: MessageDoc): Omit<InboxMessage, "id"> & { id: string } {
	return { ...doc.message };
}

/**
 * The whole export, or the throw the flip tool reads. Idempotent: every write
 * replaces what the file already holds.
 */
export function exportLedger(options: ExportOptions): ExportResult {
	const stateDir = options.stateDir;
	const socketPath = options.socketPath ?? ownerLedgerSocket(stateDir);
	const programmeDir = options.programmeDir ?? programmeControlStateDir();
	const backend = backendState(stateDir).backend;
	if (backend !== "files") {
		throw new Error(`the export writes files: backend.json must name files, not ${backend}`);
	}
	const skipped: ExportSkip[] = [];
	const stores: Record<string, number> = {};

	// 1. Compare-and-set stores, each through its owner's own files-mode writer.
	const cards = listStore(socketPath, LANE_CARD_STORE);
	for (const row of cards) {
		try {
			const card = withoutRevision(row) as unknown as LaneCard;
			if (typeof card.laneId !== "string" || card.laneId === "") {
				skipped.push({ what: LANE_CARD_STORE, id: row.id, reason: "not a lane card" });
				continue;
			}
			writeLaneCard(stateDir, card);
			stores[LANE_CARD_STORE] = (stores[LANE_CARD_STORE] ?? 0) + 1;
		} catch (error) {
			skipped.push({ what: LANE_CARD_STORE, id: row.id, reason: messageOf(error) });
		}
	}
	for (const row of listStore(socketPath, LANE_RECORD_STORE)) {
		try {
			writeLaneRecord(stateDir, withoutRevision(row) as unknown as LaneRecord);
			stores[LANE_RECORD_STORE] = (stores[LANE_RECORD_STORE] ?? 0) + 1;
		} catch (error) {
			skipped.push({ what: LANE_RECORD_STORE, id: row.id, reason: messageOf(error) });
		}
	}
	for (const row of listStore(socketPath, LANE_REGISTRY_STORE)) {
		const sessionId = typeof row.record["sessionId"] === "string" ? (row.record["sessionId"] as string) : "";
		const harness = typeof row.record["harness"] === "string" ? (row.record["harness"] as string) : "";
		if (sessionId === "" || harness === "") {
			skipped.push({ what: LANE_REGISTRY_STORE, id: row.id, reason: "row has no sessionId and harness to register" });
			continue;
		}
		try {
			// The owner's register writer is the registry file's one writer; it drops a
			// retirement, which is counted rather than written by a second format owner.
			writeLaneRegistryRow(stateDir, row.id, { sessionId, harness });
			if (row.record["retired"] === true) skipped.push({ what: LANE_REGISTRY_STORE, id: row.id, reason: "registered without its retirement (the register writer drops it)" });
			stores[LANE_REGISTRY_STORE] = (stores[LANE_REGISTRY_STORE] ?? 0) + 1;
		} catch (error) {
			skipped.push({ what: LANE_REGISTRY_STORE, id: row.id, reason: messageOf(error) });
		}
	}
	for (const row of listStore(socketPath, LANE_CONTROL_STORE)) {
		const operation = row.record["operation"] as LaneControlOperation;
		if (!(LANE_CONTROL_OPERATIONS as readonly unknown[]).includes(operation)) {
			skipped.push({ what: LANE_CONTROL_STORE, id: row.id, reason: "not a lane control operation" });
			continue;
		}
		try {
			enqueueLaneControl(stateDir, {
				laneId: typeof row.record["laneId"] === "string" ? (row.record["laneId"] as string) : row.id,
				operation,
				...(typeof row.record["id"] === "string" ? { id: row.record["id"] as string } : {}),
				...(typeof row.record["at"] === "number" ? { at: row.record["at"] as number } : {}),
				...("params" in row.record ? { params: row.record["params"] as Record<string, unknown> } : {}),
				...("from" in row.record ? { from: row.record["from"] as string } : {}),
			} as Parameters<typeof enqueueLaneControl>[1]);
			stores[LANE_CONTROL_STORE] = (stores[LANE_CONTROL_STORE] ?? 0) + 1;
		} catch (error) {
			skipped.push({ what: LANE_CONTROL_STORE, id: row.id, reason: messageOf(error) });
		}
	}
	const seatDir = seatsDir({ stateDir });
	const seatStore = fileSeatStore(seatDir);
	mkdirSync(seatDir, { recursive: true, mode: 0o700 });
	for (const row of listStore(socketPath, SEAT_STORE)) {
		try {
			const current = seatStore.read(row.id);
			seatStore.update(row.id, current?.revision, () => withRevision(row) as never);
			stores[SEAT_STORE] = (stores[SEAT_STORE] ?? 0) + 1;
		} catch (error) {
			skipped.push({ what: SEAT_STORE, id: row.id, reason: messageOf(error) });
		}
	}
	const programmeStore = fileProgrammeControlStore(programmeDir);
	mkdirSync(programmeDir, { recursive: true, mode: 0o700 });
	for (const row of listStore(socketPath, PROGRAMME_CONTROL_STORE)) {
		try {
			const current = programmeStore.read(row.id);
			programmeStore.update(row.id, current?.revision, () => withRevision(row) as never);
			stores[PROGRAMME_CONTROL_STORE] = (stores[PROGRAMME_CONTROL_STORE] ?? 0) + 1;
		} catch (error) {
			skipped.push({ what: PROGRAMME_CONTROL_STORE, id: row.id, reason: messageOf(error) });
		}
	}
	// Goals: through the owner's files-mode store, the revision kept, so a rerun replaces what it wrote.
	const goalDir = goalsDir(stateDir);
	const goalFiles = fileGoalStore(goalDir);
	mkdirSync(goalDir, { recursive: true, mode: 0o700 });
	for (const row of listStore(socketPath, GOAL_STORE)) {
		try {
			const current = goalFiles.read(row.id);
			goalFiles.update(row.id, current?.revision, () => withRevision(row) as never);
			stores[GOAL_STORE] = (stores[GOAL_STORE] ?? 0) + 1;
		} catch (error) {
			skipped.push({ what: GOAL_STORE, id: row.id, reason: messageOf(error) });
		}
	}

	// The research desk: through the owner's files-mode store, the revision kept, so a rerun replaces what it wrote.
	const desk = deskDir(stateDir);
	const deskFiles = fileDeskStore(desk);
	mkdirSync(desk, { recursive: true, mode: 0o700 });
	for (const row of listStore(socketPath, DESK_STORE)) {
		try {
			const current = deskFiles.read(row.id);
			deskFiles.update(row.id, current?.revision, () => withRevision(row) as never);
			stores[DESK_STORE] = (stores[DESK_STORE] ?? 0) + 1;
		} catch (error) {
			skipped.push({ what: DESK_STORE, id: row.id, reason: messageOf(error) });
		}
	}

	// 2. Messages: the addresses come from the ledger's own index, emptied ones included,
	// because a delivered message leaves its address's index empty.
	const addresses = requestSync<{ address: string }[]>(socketPath, "inboxes", { includeEmpty: true }, { timeoutMs: BATCH_TIMEOUT_MS, maxLineBytes: EXPORT_MAX_LINE_BYTES }).map((row) => row.address);
	let accepted = 0;
	let delivered = 0;
	for (const address of addresses) {
		for (const state of ["accepted", "delivered"] as const) {
			const docs = requestSync<MessageDoc[]>(socketPath, "messages", { address, state }, { timeoutMs: BATCH_TIMEOUT_MS, maxLineBytes: EXPORT_MAX_LINE_BYTES });
			for (const doc of docs) {
				try {
					writeInboxMessage(stateDir, asMessage(doc));
					if (state === "delivered") {
						markInboxMessageRead(stateDir, address, doc.message.id);
						delivered += 1;
					} else {
						accepted += 1;
					}
				} catch (error) {
					skipped.push({ what: `message-${state}`, id: doc.message.id, reason: messageOf(error) });
				}
			}
		}
	}

	// 3. Asks: each ask's events past its count at import, and every event of an ask
	// raised after the flip. The file's own fold (`readAsks`) says what it already
	// holds, so a rerun after a crash appends nothing a second time.
	const heldAt = new Map(readAsks(stateDir).asks.map((ask) => [ask.id, Date.parse(ask.updatedAt)]));
	const docs = requestSync<{ askId: string; events: AskEvent[] }[]>(socketPath, "asksAll", {}, { timeoutMs: BATCH_TIMEOUT_MS, maxLineBytes: EXPORT_MAX_LINE_BYTES });
	const fresh: AskEvent[] = [];
	for (const doc of docs) {
		const had = options.askCounts[doc.askId] ?? 0;
		const last = heldAt.get(doc.askId);
		for (const [index, event] of doc.events.entries()) {
			if (index < had) continue;
			if (last !== undefined && Number.isFinite(last) && Date.parse(event.at) <= last) continue;
			fresh.push(event);
		}
	}
	fresh.sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
	let asks = 0;
	for (const event of fresh) {
		try {
			appendAskEvent(stateDir, event);
			asks += 1;
		} catch (error) {
			skipped.push({ what: "ask", id: event.id, reason: messageOf(error) });
		}
	}

	// 4. Events after the cursor, each log in its own line format.
	const cursor = Number(options.cursor);
	const events = requestSync<{ id: number; type: string; lane?: string; text: string; at: number }[]>(socketPath, "events", {}, { timeoutMs: BATCH_TIMEOUT_MS, maxLineBytes: EXPORT_MAX_LINE_BYTES });
	let orchestratorLines = 0;
	let sendLogLines = 0;
	let otherEvents = 0;
	for (const event of events) {
		if (Number.isFinite(cursor) && event.id <= cursor) continue;
		if ((EVENT_KINDS as readonly string[]).includes(event.type)) {
			appendOrchestratorEvent(stateDir, formatEventLine(event.type as EventKind, event.lane ?? "", event.text), new Date(event.at));
			orchestratorLines += 1;
			continue;
		}
		if (event.type !== "SENT") {
			// Any other ledger event (`revision`, `report`, a tick's) never had a line in
			// either file, so the ledger is where it stays.
			otherEvents += 1;
			continue;
		}
		// A `send-log` line: the file's own JSONL format, with the fields a `muster.event` holds.
		appendFsyncedLine(stateDir, SEND_LOG_FILE, `${JSON.stringify({ at: new Date(event.at).toISOString(), laneId: event.lane ?? "", transport: "inbox", idempotencyKey: `imported:${event.id}`, status: event.text === "" ? undefined : event.text })}\n`);
		sendLogLines += 1;
	}

	// 5. The doorbells go: a files-mode inbox holds message files, never doorbells.
	const sweep = sweepInboxDoorbells(stateDir, new Map());
	return {
		flipId: options.flipId,
		cursor: options.cursor,
		stores,
		accepted,
		delivered,
		asks,
		orchestratorLines,
		sendLogLines,
		otherEvents,
		doorbellsRemoved: sweep.changed.reduce((total, change) => total + change.removed.length, 0),
		skipped,
	};
}

// ─── The command ─────────────────────────────────────────────────────────────

const USAGE = [
	"usage: node --import tsx scripts/muster-ledger-export.mts --flip-id <id> (--summary <path> | --cursor <id>) [--ask-counts <json>] [--state-dir <dir>] [--json]",
	"",
	"  --flip-id     the flip's id, for the report (required)",
	"  --summary     the import's summary file (`import-<flipId>.json`): its cursor and askCounts are used",
	"  --cursor      the flip cursor: only entries after it are appended to the two logs",
	"  --ask-counts  the flip record's askCounts as JSON, when it is not read from the summary",
	"  --state-dir   the Muster state directory to write (default: PI_MUSTER_STATE_DIR, else the agent's state/muster)",
	"  --json        print the run as JSON instead of the summary lines",
	"",
	"The flip tool runs it on a rollback with `backend.json` naming files: the reads come from `musterd`",
	"(the ledger), the writes go through each owner's own files-mode writer.",
].join("\n");

function out(text: string): void {
	process.stdout.write(`${text}\n`);
}

type Parsed = { ok: true; options: ExportOptions; json: boolean } | { ok: false; error: string };

export function parseArguments(argv: readonly string[]): Parsed {
	let flipId = "";
	let stateDir = process.env["PI_MUSTER_STATE_DIR"]?.trim() ?? "";
	let summaryPath = "";
	let cursor = "";
	let askCountsJson = "";
	let json = false;
	const value = (word: string): string | undefined => {
		const next = argv[argv.indexOf(word) + 1];
		return next === undefined || next.startsWith("--") ? undefined : next;
	};
	for (const word of argv) {
		if (word === "--json") json = true;
		else if (word.startsWith("--")) {
			const given = value(word);
			if (given === undefined) return { ok: false, error: `${word} needs a value` };
			if (word === "--flip-id") flipId = given;
			else if (word === "--state-dir") stateDir = given;
			else if (word === "--summary") summaryPath = given;
			else if (word === "--cursor") cursor = given;
			else if (word === "--ask-counts") askCountsJson = given;
			else return { ok: false, error: `unknown argument ${word}` };
		}
	}
	if (flipId === "") return { ok: false, error: "--flip-id is required" };
	let askCounts: Record<string, number> = {};
	if (summaryPath !== "") {
		let parsed: { cursor?: unknown; askCounts?: unknown };
		try {
			parsed = JSON.parse(readFileSync(summaryPath, "utf8")) as { cursor?: unknown; askCounts?: unknown };
		} catch (error) {
			return { ok: false, error: `--summary ${summaryPath} cannot be read (${messageOf(error)})` };
		}
		if (typeof parsed.cursor === "string" && cursor === "") cursor = parsed.cursor;
		if (parsed.askCounts !== null && typeof parsed.askCounts === "object") askCounts = parsed.askCounts as Record<string, number>;
	}
	if (askCountsJson !== "") {
		try {
			askCounts = JSON.parse(askCountsJson) as Record<string, number>;
		} catch (error) {
			return { ok: false, error: `--ask-counts is not JSON (${messageOf(error)})` };
		}
	}
	if (cursor === "") return { ok: false, error: "--cursor or --summary is required" };
	return { ok: true, json, options: { flipId, cursor, askCounts, stateDir: resolve(stateDir === "" ? musterStateDir() : stateDir) } };
}

/** The run, or the exit code to leave with. */
export function run(options: ExportOptions, json: boolean, write: (text: string) => void): number {
	let result: ExportResult;
	try {
		result = exportLedger(options);
	} catch (error) {
		if (error instanceof Error && error.name === "MusterdUnreachable") {
			write("musterd is not running");
			return 75;
		}
		throw error;
	}
	if (json) {
		write(JSON.stringify(result, null, 2));
		return 0;
	}
	for (const [store, count] of Object.entries(result.stores)) write(`${store}: ${count} records written`);
	write(`messages: ${result.accepted} accepted, ${result.delivered} delivered; asks: ${result.asks}`);
	write(`logs: ${result.orchestratorLines} orchestrator-events lines, ${result.sendLogLines} send-log lines; doorbells removed: ${result.doorbellsRemoved}`);
	for (const skip of result.skipped) write(`skipped ${skip.what} ${skip.id}: ${skip.reason}`);
	return 0;
}
/**
 * The entry `scripts/muster-ledger-export.mts` (the start file) runs: the same argument parsing,
 * output and exit code the script ran by its own path before RS2c.
 */
export function main(argv: string[]): number {
	const parsed = parseArguments(argv);
	if (!parsed.ok) {
		out(parsed.error);
		out(USAGE);
		return 2;
	}
	try {
		return run(parsed.options, parsed.json, out);
	} catch (error) {
		out(`muster-ledger-export: ${messageOf(error)}`);
		return 1;
	}
}

const SELF = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === SELF) process.exitCode = main(process.argv.slice(2));
