#!/usr/bin/env node
/**
 * LC14's import: the frozen file stores go into the ledger, once, through
 * `musterd` (plan §5 step 3, §2.1's family table).
 *
 * The run only belongs to the flip tool, with the source frozen. Everything it
 * writes goes through the ledger's methods (`importBatch`, one commit per chunk),
 * so no owner needs a second store and a kill anywhere leaves the ledger either
 * fully before or fully after a chunk:
 *
 * - the chunks are cut from the frozen source deterministically (each source
 *   sorted by path, then by line, then 200 writes per chunk), so a rerun cuts the
 *   same chunks;
 * - each chunk carries the request id `import:<flipId>:<chunk>`. A rerun after a
 *   kill answers `duplicate` for every chunk already committed and commits the
 *   rest (G2), so the import is complete exactly when every chunk's request row
 *   exists;
 * - the source records go in verbatim (LC-D3): the ledger keeps an owner's record
 *   as the owner wrote it and the revision beside it, never inside it.
 *
 * What is imported, and what is listed as skipped, is §2.1's table: every lane
 * record (terminal ones included), the cards and registry rows of lanes that are
 * live, recorded or the operator's, control requests for live lanes, every seat, open
 * programme-control records, every message, every ask event, every goal record, the research desk record and the last 7 days
 * of the two event logs. `flip-artifacts/manifest-<flipId>.md` beside the state
 * dir lists the counts per source and every skipped item with its reason, and
 * `flip-artifacts/import-<flipId>.json` beside it holds the flip record's data
 * (`{ flipId, cursor, askCounts }`) for the flip tool.
 *
 * The source is the file stores: the script refuses to run when `backend.json`
 * already names the ledger.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { agentInboxDir, agentInboxReadDir, agentInboxRoot, findInboxMessage, listDeliveredMessages, listInboxMessages } from "../lib/agent-inbox.ts";
import type { InboxMessage } from "../lib/agent-inbox.ts";
import { laneCardsDir } from "../lib/lane-card.ts";
import { laneControlDir } from "../lib/lane-control.ts";
import type { LaneControlRequest } from "../lib/lane-control.ts";
import { enumerateLanes, laneRegistryPath, readLaneRegistryRows } from "../lib/lane-directory.ts";
import { EVENT_KINDS } from "../lane-report.ts";
import { asksEventsPath } from "../asks.ts";
import type { AskEvent } from "../asks.ts";
import { musterStateDir } from "../binding.ts";
import { fileProgrammeControlStore, programmeControlStateDir } from "../control.ts";
import { fileGoalStore, goalsDir } from "../goals.ts";
import { deskDir, fileDeskStore } from "../research-desk.ts";
import type { ProgrammeControlRecord } from "../control.ts";
import { readBackend } from "../ledger/backend.ts";
import { requestSync } from "../ledger/client-sync.ts";
import type { CasWrite, ImportMessage, ImportResult } from "../ledger/methods.ts";
import type { MusterEventValue } from "../ledger/schema.ts";
import { DESK_STORE, GOAL_STORE, LANE_CARD_STORE, LANE_CONTROL_STORE, LANE_RECORD_STORE, LANE_REGISTRY_STORE, PROGRAMME_CONTROL_STORE, ownerLedgerSocket } from "../ledger/stores.ts";
import { TERMINAL_PHASES, laneRecordsDir } from "../lane-lifecycle.ts";
import type { LaneRecord } from "../lane-lifecycle.ts";
import { fileSeatStore, seatsDir } from "../seats.ts";

/** The store name of the seat family (§2.1: `seat`, id = role). */
const SEAT_STORE = "seat";
/** The seam the plan fixes: 200 writes per chunk (§2.2). */
export const CHUNK_WRITES = 200;
/** Import and export batches set their own timeout per call (global constraints). */
const BATCH_TIMEOUT_MS = 30_000;
/** How much of the two event logs is imported: the last 7 days (§2.1's table). */
const LOG_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** One source of §2.1's import table, so the manifest counts and names every one. */
export type ImportSource =
	| "lane-record"
	| "lane-card"
	| "lane-registry"
	| "lane-control"
	| "seat"
	| "programme-control"
	| "goal"
	| "research-desk"
	| "message-accepted"
	| "message-delivered"
	| "ask"
	| "event-orchestrator"
	| "event-send-log";

export const IMPORT_SOURCES: readonly ImportSource[] = [
	"lane-record",
	"lane-card",
	"lane-registry",
	"lane-control",
	"seat",
	"programme-control",
	"goal",
	"research-desk",
	"message-accepted",
	"message-delivered",
	"ask",
	"event-orchestrator",
	"event-send-log",
];

/** One item the import left as a file, with the reason it did (§2.1's "not imported" column). */
export type ImportSkip = { source: ImportSource; path: string; reason: string };

export type SourceCount = { read: number; imported: number; skipped: number };

/** One chunk: the request id, the writes, and how many writes it carries. */
export type ImportChunk = {
	index: number;
	requestId: string;
	cas: CasWrite[];
	messages: ImportMessage[];
	asks: { askId: string; events: AskEvent[] }[];
	events: MusterEventValue[];
	writes: number;
};

/** One message file the import took: enough to find it again by the owner's own file-name suffix. */
export type MessageFile = { dir: string; id: string };

export type ImportPlan = {
	flipId: string;
	chunks: ImportChunk[];
	/** Each ask's event count at import, for the flip record (`askCounts`, §2.2). */
	askCounts: Record<string, number>;
	counts: Record<ImportSource, SourceCount>;
	skipped: ImportSkip[];
	/** The message files the import wrote into the ledger; the flip's backup tar holds them. */
	messageFiles: MessageFile[];
	/** The lanes the import kept: cards, registry rows and control requests are chosen from this set. */
	laneIds: string[];
};

export type ImportOptions = {
	flipId: string;
	/** The Muster state directory the file stores are read from. Defaults to `musterStateDir()`. */
	stateDir?: string;
	/** The programme-control directory, whose owner derives it from the agent folder. */
	programmeDir?: string;
	/** The clock the 7-day window is measured from; tests pass it, production reads `Date.now`. */
	nowMs?: number;
};

export type ImportRun = ImportPlan & {
	/** The chunks the ledger already held, and the ones this run committed. */
	committedChunks: number[];
	skippedChunks: number[];
	/** What this run put in the ledger per source; a chunk already committed adds nothing. */
	written: Record<ImportSource, number>;
	/** The last event entry id at the end of the import: the flip record's cursor. */
	cursor: string;
	/** The message files removed from `inbox/` and `read/` because the backup tar holds them. */
	movedMessages: number;
	/** The message files left in place because no backup tar was found. */
	leftMessages: number;
	manifestPath: string;
	summaryPath: string;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type ReadJson = { ok: true; value: unknown } | { ok: false; reason: string };

/** One JSON file as the owner would read it: a torn or absent file is a skip, never a crash. */
function readJson(path: string): ReadJson {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		return { ok: false, reason: `unreadable (${messageOf(error)})` };
	}
	if (raw.trim() === "") return { ok: false, reason: "empty file" };
	try {
		return { ok: true, value: JSON.parse(raw) as unknown };
	} catch {
		return { ok: false, reason: "not JSON" };
	}
}

/** A JSON object as a record, with the store's own `revision` field removed (the ledger keeps it beside the record). */
/** One store record as the ledger takes it: the body the owner wrote, without the store's own revision. */
function recordBody(value: unknown): { ok: true; record: NonNullable<CasWrite["record"]> } | { ok: false; reason: string } {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "not a JSON object" };
	const { revision: _revision, ...record } = value as Record<string, unknown>;
	return { ok: true, record: record as NonNullable<CasWrite["record"]> };
}

/** The `*.json` files of one directory, sorted by name: the plan's "sorted by path". */
function jsonFiles(dir: string): string[] {
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
	return names.sort().map((name) => join(dir, name));
}

/** The lane id a store file names: its own name without the extension. */
function idOf(file: string): string {
	return file.slice(file.lastIndexOf("/") + 1, -".json".length);
}

/** One line of `orchestrator-events.log`: `date -Iseconds` and the line `formatEventLine` built. */
const ORCHESTRATOR_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2}|Z)) (.*)$/;
/** The event kinds the file holds, in `formatEventLine`'s shape: `<KIND>: <lane>[ |]<detail>`. */
const EVENT_LINE = /^(REVIEW READY|BLOCKED|QUESTION|ALREADY DONE|QUOTA WALL|STALLED|CRASHED|ASLEEP): ([^ |]+)(?: \| )?(.*)$/;

/**
 * One `orchestrator-events.log` line as a `muster.event` value, or undefined when
 * the line is not one (a stray line stays in the file: "older lines stay in the
 * files", and so does anything this reader cannot read).
 *
 * The reader knows the one shape `lane-report.ts:formatEventLine` writes: the date
 * prefix the line is appended with, then `<KIND>: <lane> | <detail>` (REVIEW READY
 * follows the lane after a space). LC9 builds `muster event`, the reader of this
 * log on main; when it lands a parser, this is the call to replace with it.
 */
function orchestratorEvent(line: string, requestId: string): MusterEventValue | undefined {
	const dated = ORCHESTRATOR_LINE.exec(line);
	if (dated === null) return undefined;
	const at = Date.parse(dated[1] as string);
	if (!Number.isFinite(at)) return undefined;
	const event = EVENT_LINE.exec(dated[2] as string);
	if (event === null) return undefined;
	return { type: event[1] as string, lane: event[2] as string, text: (event[3] as string).trim(), at, requestId };
}

/**
 * One `send-log.jsonl` line as a `muster.event` value: the lane and the time are
 * what the ledger can hold (`SendLogRecord`'s mode, transport, attempts and error
 * have no `muster.event` field). The line's own `at` is the event's time, the
 * recipient is its lane, and what the record says about the attempt rides in the
 * text.
 */
function sendLogEvent(raw: string, requestId: string): MusterEventValue | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== "object") return undefined;
	const record = parsed as { at?: unknown; laneId?: unknown; status?: unknown; mode?: unknown; transport?: unknown };
	if (typeof record.at !== "string" || typeof record.laneId !== "string") return undefined;
	const at = Date.parse(record.at);
	if (!Number.isFinite(at)) return undefined;
	const detail = [record.mode, record.transport, record.status].filter((part): part is string => typeof part === "string" && part !== "").join(" ");
	return { type: "SENT", lane: record.laneId, text: detail, at, requestId };
}

/** The time a log line carries, or undefined when the line holds neither shape. */
function logLineAt(line: string): number | undefined {
	const dated = ORCHESTRATOR_LINE.exec(line);
	if (dated !== null) {
		const at = Date.parse(dated[1] as string);
		return Number.isFinite(at) ? at : undefined;
	}
	try {
		const parsed = JSON.parse(line) as { at?: unknown };
		if (typeof parsed.at !== "string") return undefined;
		const at = Date.parse(parsed.at);
		return Number.isFinite(at) ? at : undefined;
	} catch {
		return undefined;
	}
}

/** The lines of a log file inside the 7-day window, in file order with their line numbers; a missing file reads as no lines. */
function logLines(path: string, sinceMs: number): { line: string; number: number }[] {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const lines: { line: string; number: number }[] = [];
	for (const [index, line] of raw.split("\n").entries()) {
		if (line.trim() === "") continue;
		const at = logLineAt(line);
		if (at !== undefined && at >= sinceMs) lines.push({ line, number: index + 1 });
	}
	return lines;
}

/** The ask events of `asks/events.jsonl`, grouped by the ask id each line carries (`AskEventBase.id`), in line order. */
function readAskEvents(path: string): { asks: { askId: string; events: AskEvent[] }[]; skipped: { path: string; reason: string }[] } {
	const skipped: { path: string; reason: string }[] = [];
	const byId = new Map<string, AskEvent[]>();
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { asks: [], skipped };
		return { asks: [], skipped: [{ path, reason: `unreadable (${messageOf(error)})` }] };
	}
	for (const [index, line] of raw.split("\n").entries()) {
		if (line.trim() === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line) as unknown;
		} catch {
			skipped.push({ path: `${path}:${index + 1}`, reason: "not JSON" });
			continue;
		}
		const event = parsed as Partial<AskEvent>;
		if (typeof event.id !== "string" || event.id === "" || typeof event.type !== "string" || typeof event.at !== "string") {
			skipped.push({ path: `${path}:${index + 1}`, reason: "not an ask event" });
			continue;
		}
		const events = byId.get(event.id) ?? [];
		events.push(parsed as AskEvent);
		byId.set(event.id, events);
	}
	const asks = [...byId.entries()].map(([askId, events]) => ({ askId, events }));
	asks.sort((left, right) => left.askId.localeCompare(right.askId));
	return { asks, skipped };
}

/** The file of a message in one folder, found by the owner's own file-name suffix rule. */
function messageFileIn(dir: string, id: string): string | undefined {
	try {
		const name = readdirSync(dir).find((entry) => entry.endsWith(`-${id}.json`));
		return name === undefined ? undefined : join(dir, name);
	} catch {
		return undefined;
	}
}

/**
 * The lanes the import keeps, and why a card is a ghost (§2.1's table).
 *
 * The machine evidence is `enumerateLanes` (LC5's owner of the directory): a lane
 * is live when the directory does not answer `gone` for it, and the operator's own
 * sessions are the rows it marks `origin: "operator"`. The owner reads the cards and
 * the registry from the state dir it is given, so the import passes both paths.
 */
function laneFacts(stateDir: string): { live: Set<string>; operator: Set<string> } {
	const live = new Set<string>();
	const operator = new Set<string>();
	for (const card of enumerateLanes({ stateDir: dirname(stateDir), laneCardsDir: laneCardsDir(stateDir), laneRegistryPath: laneRegistryPath(stateDir) })) {
		if (card.state !== "gone") live.add(card.laneId);
		if (card.origin === "operator") operator.add(card.laneId);
	}
	return { live, operator };
}

/**
 * The whole plan, read off the frozen files. Pure: it reads files and answers the
 * chunks, so the same call after a kill cuts the same chunks, and a test can hand
 * one chunk to `musterd` itself.
 */
export function planImport(options: ImportOptions): ImportPlan {
	const stateDir = resolve(options.stateDir ?? musterStateDir());
	const programmeDir = options.programmeDir ?? programmeControlStateDir();
	const nowMs = options.nowMs ?? Date.now();
	const counts = Object.fromEntries(IMPORT_SOURCES.map((source) => [source, { read: 0, imported: 0, skipped: 0 }])) as Record<ImportSource, SourceCount>;
	const skipped: ImportSkip[] = [];
	const cas: CasWrite[] = [];
	const messages: ImportMessage[] = [];
	const asks: { askId: string; events: AskEvent[] }[] = [];

	const take = (source: ImportSource, path: string, reason?: string): void => {
		counts[source].read += 1;
		if (reason === undefined) {
			counts[source].imported += 1;
			return;
		}
		counts[source].skipped += 1;
		skipped.push({ source, path, reason });
	};

	// 1. Lane records: all of them, terminal ones too (LD26 reads `merged` and `closed` from them).
	const records = new Map<string, LaneRecord>();
	for (const file of jsonFiles(laneRecordsDir(stateDir))) {
		const laneId = idOf(file);
		const read = readJson(file);
		if (!read.ok) {
			take("lane-record", file, read.reason);
			continue;
		}
		const body = recordBody(read.value);
		if (!body.ok) {
			take("lane-record", file, body.reason);
			continue;
		}
		records.set(laneId, read.value as LaneRecord);
		cas.push({ store: LANE_RECORD_STORE, id: laneId, expectedRevision: undefined, record: body.record });
		take("lane-record", file);
	}

	const facts = laneFacts(stateDir);
	const terminal = (laneId: string): boolean => {
		const record = records.get(laneId);
		return record !== undefined && (TERMINAL_PHASES as readonly string[]).includes(record.phase);
	};
	/** §2.1: a lane whose card and registry row are kept. */
	const kept = (laneId: string): boolean => records.has(laneId) || facts.live.has(laneId) || facts.operator.has(laneId);
	/** §2.1: a lane a control request can still reach. */
	const reachable = (laneId: string): boolean => facts.live.has(laneId) || (records.has(laneId) && !terminal(laneId));

	// 2. Lane cards: the lanes that are live, recorded or the operator's. A ghost card stays a file.
	const laneIds = new Set<string>();
	for (const file of jsonFiles(laneCardsDir(stateDir))) {
		const laneId = idOf(file);
		const read = readJson(file);
		if (!read.ok) {
			take("lane-card", file, read.reason);
			continue;
		}
		const body = recordBody(read.value);
		if (!body.ok) {
			take("lane-card", file, body.reason);
			continue;
		}
		if (terminal(laneId)) {
			take("lane-card", file, "ghost card: terminal record");
			continue;
		}
		if (!kept(laneId)) {
			take("lane-card", file, "ghost card: no process and no record");
			continue;
		}
		cas.push({ store: LANE_CARD_STORE, id: laneId, expectedRevision: undefined, record: body.record });
		laneIds.add(laneId);
		take("lane-card", file);
	}
	for (const laneId of records.keys()) laneIds.add(laneId);
	for (const laneId of [...facts.operator, ...facts.live]) if (kept(laneId)) laneIds.add(laneId);

	// 3. The registry: the rows of the imported lanes, retired rows included.
	const registryPath = laneRegistryPath(stateDir);
	const registry = readLaneRegistryRows(registryPath, stateDir);
	for (const [laneId, row] of [...registry.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
		const path = `${registryPath}#${laneId}`;
		if (!kept(laneId)) {
			take("lane-registry", path, "ghost row: the lane is not imported");
			continue;
		}
		cas.push({ store: LANE_REGISTRY_STORE, id: laneId, expectedRevision: undefined, record: { ...row } as unknown as NonNullable<CasWrite["record"]> });
		laneIds.add(laneId);
		take("lane-registry", path);
	}

	// 4. Lane control: requests for live lanes. A request for a lane nothing can deliver to stays a file.
	for (const file of jsonFiles(laneControlDir(stateDir))) {
		const read = readJson(file);
		if (!read.ok) {
			take("lane-control", file, read.reason);
			continue;
		}
		const request = read.value as Partial<LaneControlRequest>;
		if (typeof request.laneId !== "string" || request.laneId === "") {
			take("lane-control", file, "not a control request");
			continue;
		}
		const body = recordBody(read.value);
		if (!body.ok) {
			take("lane-control", file, body.reason);
			continue;
		}
		if (!reachable(request.laneId)) {
			take("lane-control", file, "request for a lane that is not live");
			continue;
		}
		cas.push({ store: LANE_CONTROL_STORE, id: request.laneId, expectedRevision: undefined, record: body.record });
		take("lane-control", file);
	}

	// 5. Seats: every record, with the owner's own validation and its revision and epoch.
	const seatDir = seatsDir({ stateDir });
	const seatStore = fileSeatStore(seatDir);
	for (const file of jsonFiles(seatDir)) {
		const role = idOf(file);
		let record: Record<string, unknown> | undefined;
		try {
			record = seatStore.read(role) as unknown as Record<string, unknown> | undefined;
		} catch (error) {
			take("seat", file, `not a seat record (${messageOf(error)})`);
			continue;
		}
		if (record === undefined) {
			take("seat", file, "not a seat record");
			continue;
		}
		const body = recordBody(record);
		if (!body.ok) {
			take("seat", file, body.reason);
			continue;
		}
		// The seat store's own file keeps its revision; the ledger keeps it beside the
		// record, so the import hands it over and a rollback writes the same one back.
		const revision = typeof record["revision"] === "number" ? (record["revision"] as number) : undefined;
		cas.push({ store: SEAT_STORE, id: role, expectedRevision: undefined, record: body.record, ...(revision === undefined ? {} : { revision }) });
		take("seat", file);
	}

	// 6. Programme control: open records. A programme turned off stays a file.
	const programmeStore = fileProgrammeControlStore(programmeDir);
	for (const file of jsonFiles(programmeDir)) {
		const programmeId = idOf(file);
		let record: ProgrammeControlRecord | undefined;
		try {
			record = programmeStore.read(programmeId);
		} catch (error) {
			take("programme-control", file, `not a programme-control record (${messageOf(error)})`);
			continue;
		}
		if (record === undefined) {
			take("programme-control", file, "not a programme-control record");
			continue;
		}
		if (record.status === "off") {
			take("programme-control", file, "closed record: the programme is off");
			continue;
		}
		const body = recordBody(record);
		if (!body.ok) {
			take("programme-control", file, body.reason);
			continue;
		}
		cas.push({ store: PROGRAMME_CONTROL_STORE, id: programmeId, expectedRevision: undefined, record: body.record });
		take("programme-control", file);
	}

	// 6b. Goals: every record. The file keeps its revision; the ledger keeps it beside the record, so a rollback writes the same one back.
	const goalDir = goalsDir(stateDir);
	const goalFiles = fileGoalStore(goalDir);
	for (const file of jsonFiles(goalDir)) {
		const code = idOf(file);
		let record: Record<string, unknown> | undefined;
		try {
			record = goalFiles.read(code) as unknown as Record<string, unknown> | undefined;
		} catch (error) {
			take("goal", file, `not a goal record (${messageOf(error)})`);
			continue;
		}
		if (record === undefined) {
			take("goal", file, "not a goal record");
			continue;
		}
		const body = recordBody(record);
		if (!body.ok) {
			take("goal", file, body.reason);
			continue;
		}
		const revision = typeof record["revision"] === "number" ? (record["revision"] as number) : undefined;
		cas.push({ store: GOAL_STORE, id: code, expectedRevision: undefined, record: body.record, ...(revision === undefined ? {} : { revision }) });
		take("goal", file);
	}

	// 6c. The research desk: the one record. The file keeps its revision; the ledger keeps it beside the record.
	const desk = deskDir(stateDir);
	const deskFiles = fileDeskStore(desk);
	for (const file of jsonFiles(desk)) {
		const id = idOf(file);
		let record: Record<string, unknown> | undefined;
		try {
			record = deskFiles.read(id) as unknown as Record<string, unknown> | undefined;
		} catch (error) {
			take("research-desk", file, `not a research desk record (${messageOf(error)})`);
			continue;
		}
		if (record === undefined) {
			take("research-desk", file, "not a research desk record");
			continue;
		}
		const body = recordBody(record);
		if (!body.ok) {
			take("research-desk", file, body.reason);
			continue;
		}
		const revision = typeof record["revision"] === "number" ? (record["revision"] as number) : undefined;
		cas.push({ store: DESK_STORE, id, expectedRevision: undefined, record: body.record, ...(revision === undefined ? {} : { revision }) });
		take("research-desk", file);
	}

	// 7. Messages: every one, with its state and its read time. The readers are the
	// owner's; a file neither reader hands over stays where it is and is counted.
	const messageFiles: MessageFile[] = [];
	const inboxRoot = agentInboxRoot(stateDir);
	const addresses = new Set<string>();
	try {
		for (const name of readdirSync(inboxRoot)) if (!name.startsWith(".")) addresses.add(name);
	} catch {
		/* no inbox yet */
	}
	for (const agent of [...addresses].sort()) {
		const inboxDir = agentInboxDir(stateDir, agent);
		const readDir = agentInboxReadDir(stateDir, agent);
		let names: string[];
		try {
			names = readdirSync(inboxDir).filter((name) => name.endsWith(".json"));
		} catch {
			names = [];
		}
		const accepted = listInboxMessages(stateDir, agent);
		for (const message of accepted) {
			messages.push({ address: agent, message, state: "accepted", deliveredAt: null });
			messageFiles.push({ dir: inboxDir, id: message.id });
		}
		counts["message-accepted"].read += names.length;
		counts["message-accepted"].imported += accepted.length;
		if (names.length > accepted.length) {
			counts["message-accepted"].skipped += names.length - accepted.length;
			skipped.push({ source: "message-accepted", path: inboxDir, reason: `${names.length - accepted.length} file(s) are not a message` });
		}
		let readNames: string[];
		try {
			readNames = readdirSync(readDir).filter((name) => name.endsWith(".json"));
		} catch {
			readNames = [];
		}
		const delivered = listDeliveredMessages(stateDir, agent, Number.MAX_SAFE_INTEGER);
		for (const message of delivered) {
			const file = messageFileIn(readDir, message.id);
			messages.push({ address: agent, message, state: "delivered", deliveredAt: file === undefined ? null : statSync(file).mtimeMs });
			messageFiles.push({ dir: readDir, id: message.id });
		}
		counts["message-delivered"].read += readNames.length;
		counts["message-delivered"].imported += delivered.length;
		if (readNames.length > delivered.length) {
			counts["message-delivered"].skipped += readNames.length - delivered.length;
			skipped.push({ source: "message-delivered", path: readDir, reason: `${readNames.length - delivered.length} file(s) are not a message` });
		}
	}

	// 8. Asks: every ask with all its events.
	const askPath = asksEventsPath(stateDir);
	const askRead = readAskEvents(askPath);
	for (const skip of askRead.skipped) {
		counts.ask.read += 1;
		counts.ask.skipped += 1;
		skipped.push({ source: "ask", path: skip.path, reason: skip.reason });
	}
	for (const ask of askRead.asks) {
		asks.push(ask);
		counts.ask.read += 1;
		counts.ask.imported += 1;
	}
	const askCounts: Record<string, number> = {};
	for (const ask of asks) askCounts[ask.askId] = ask.events.length;

	// 9. The two event logs: the last 7 days, as `muster.event` values.
	const sinceMs = nowMs - LOG_WINDOW_MS;
	const events: MusterEventValue[] = [];
	const orchestratorPath = join(dirname(stateDir), "orchestrator-events.log");
	for (const entry of logLines(orchestratorPath, sinceMs)) {
		const event = orchestratorEvent(entry.line, `import-log:orchestrator:${entry.number}`);
		if (event === undefined) {
			take("event-orchestrator", `${orchestratorPath}:${entry.number}`, "not an event line");
			continue;
		}
		events.push(event);
		take("event-orchestrator", `${orchestratorPath}:${entry.number}`);
	}
	const sendLogPath = join(stateDir, "send-log.jsonl");
	for (const entry of logLines(sendLogPath, sinceMs)) {
		const event = sendLogEvent(entry.line, `import-log:send-log:${entry.number}`);
		if (event === undefined) {
			take("event-send-log", `${sendLogPath}:${entry.number}`, "not a send-log line");
			continue;
		}
		events.push(event);
		take("event-send-log", `${sendLogPath}:${entry.number}`);
	}

	// The chunks: 200 writes each, cut from the one ordered list, so a rerun cuts the same ones.
	const chunks: ImportChunk[] = [];
	const fresh = (index: number): ImportChunk => ({ index, requestId: `import:${options.flipId}:${index}`, cas: [], messages: [], asks: [], events: [], writes: 0 });
	let current = fresh(0);
	for (const write of cas) {
		if (current.writes >= CHUNK_WRITES) {
			chunks.push(current);
			current = fresh(chunks.length);
		}
		current.cas.push(write);
		current.writes += 1;
	}
	for (const row of messages) {
		if (current.writes >= CHUNK_WRITES) {
			chunks.push(current);
			current = fresh(chunks.length);
		}
		current.messages.push(row);
		current.writes += 1;
	}
	for (const ask of asks) {
		if (current.writes >= CHUNK_WRITES) {
			chunks.push(current);
			current = fresh(chunks.length);
		}
		current.asks.push(ask);
		current.writes += 1;
	}
	for (const event of events) {
		if (current.writes >= CHUNK_WRITES) {
			chunks.push(current);
			current = fresh(chunks.length);
		}
		current.events.push(event);
		current.writes += 1;
	}
	chunks.push(current);

	return { flipId: options.flipId, chunks, askCounts, counts, skipped, messageFiles, laneIds: [...laneIds].sort() };
}

/** One chunk through `musterd`, with the batch's own timeout. */
export function sendChunk(socketPath: string, chunk: ImportChunk): ImportResult {
	return requestSync<ImportResult>(
		socketPath,
		"importBatch",
		{ requestId: chunk.requestId, cas: chunk.cas, messages: chunk.messages, asks: chunk.asks, events: chunk.events },
		{ timeoutMs: BATCH_TIMEOUT_MS },
	);
}

/** The last `muster.event` entry id the ledger holds: the flip record's cursor. */
export function ledgerCursor(socketPath: string): string {
	const events = requestSync<{ id: number }[]>(socketPath, "events", {}, { timeoutMs: BATCH_TIMEOUT_MS });
	let last = 0;
	for (const event of events) if (event.id > last) last = event.id;
	return String(last);
}

/**
 * Where the flip's artifacts go: `flip-artifacts/` beside the state dir the flip
 * moved, next to the backup tar `flipTarPath` writes, never the checkout the flip
 * happens to run from. LC14 wrote the two files under the repository, so a flip
 * run on a copy inside a worktree wrote into that worktree, and the rollback —
 * which reads the flip record from this same path — then could not find it where
 * the flip had left it (finding 17, 2026-10-18). The state dir's parent is the
 * install's own root, and both the flip and the rollback derive it the same way.
 */
export function flipArtifactsDir(stateDir: string): string {
	return join(dirname(stateDir), "flip-artifacts");
}

/** The flip record's data, beside the manifest (the flip tool's and the rollback's input). */
export function flipRecordPath(stateDir: string, flipId: string): string {
	return join(flipArtifactsDir(stateDir), `import-${flipId}.json`);
}

/** The import's manifest, beside the flip record's data. */
export function manifestPathFor(stateDir: string, flipId: string): string {
	return join(flipArtifactsDir(stateDir), `manifest-${flipId}.md`);
}

/** The manifest's table and its list of skipped items. */
export function renderManifest(plan: ImportPlan, run: Pick<ImportRun, "cursor" | "committedChunks" | "skippedChunks">): string {
	const lines = [
		`# Ledger import manifest — ${plan.flipId}`,
		"",
		`${plan.chunks.length} chunks of at most ${CHUNK_WRITES} writes, request id \`import:${plan.flipId}:<chunk>\`.`,
		`This run committed ${run.committedChunks.length} chunks and found ${run.skippedChunks.length} already committed. Cursor ${run.cursor}.`,
		"",
		"| Source | Read | Imported | Skipped |",
		"|---|---|---|---|",
		...IMPORT_SOURCES.map((source) => `| ${source} | ${plan.counts[source].read} | ${plan.counts[source].imported} | ${plan.counts[source].skipped} |`),
		"",
		"The stores that stay files (LC0-R5) are not touched: `supervisor.json`, `programmes/*.decisions.json`, `programmes/relay.sock.token`, `gateway-code.json`, `trials/`, `resume/`, `claude-resume/`, `attachments/` and the archive folders.",
		"",
	];
	if (plan.skipped.length === 0) lines.push("Nothing was skipped.");
	else {
		lines.push(`${plan.skipped.length} skipped items:`, "");
		for (const skip of plan.skipped) lines.push(`- ${skip.source}: \`${skip.path}\` — ${skip.reason}`);
	}
	lines.push("");
	return lines.join("\n");
}

export type ImportRunOptions = ImportOptions & { stateDir: string; socketPath?: string };

/**
 * The whole run: plan, send every chunk, write the manifest and the flip record's
 * data, and move the message files the backup tar already holds out of the folders
 * (§2.1). Idempotent by flip id: a second run writes nothing and reports the
 * chunks it found committed.
 */
export function importLedger(options: ImportRunOptions): ImportRun {
	const stateDir = options.stateDir;
	const socketPath = options.socketPath ?? ownerLedgerSocket(stateDir);
	const plan = planImport(options);
	const committedChunks: number[] = [];
	const skippedChunks: number[] = [];
	const written = Object.fromEntries(IMPORT_SOURCES.map((source) => [source, 0])) as Record<ImportSource, number>;
	for (const chunk of plan.chunks) {
		const answer = sendChunk(socketPath, chunk);
		if (!answer.ok) throw new Error(`import chunk ${chunk.index} refused: ${answer.code} at write ${answer.index}`);
		if (answer.duplicate === true) skippedChunks.push(chunk.index);
		else committedChunks.push(chunk.index);
		written["lane-record"] += chunk.cas.filter((write) => write.store === LANE_RECORD_STORE).length;
		written["lane-card"] += chunk.cas.filter((write) => write.store === LANE_CARD_STORE).length;
		written["lane-registry"] += chunk.cas.filter((write) => write.store === LANE_REGISTRY_STORE).length;
		written["lane-control"] += chunk.cas.filter((write) => write.store === LANE_CONTROL_STORE).length;
		written["seat"] += chunk.cas.filter((write) => write.store === SEAT_STORE).length;
		written["programme-control"] += chunk.cas.filter((write) => write.store === PROGRAMME_CONTROL_STORE).length;
		written["goal"] += chunk.cas.filter((write) => write.store === GOAL_STORE).length;
		written["research-desk"] += chunk.cas.filter((write) => write.store === DESK_STORE).length;
		written["message-accepted"] += chunk.messages.filter((row) => row.state === "accepted").length;
		written["message-delivered"] += chunk.messages.filter((row) => row.state === "delivered").length;
		written.ask += chunk.asks.length;
		written["event-orchestrator"] += chunk.events.filter((event) => (EVENT_KINDS as readonly string[]).includes(event.type)).length;
		written["event-send-log"] += chunk.events.filter((event) => !(EVENT_KINDS as readonly string[]).includes(event.type)).length;
	}
	const cursor = ledgerCursor(socketPath);

	// The message files the flip's backup tar holds are moved out of the folders, so
	// the inbox folders hold only doorbells (LC8). Without a tar nothing is removed:
	// an unbacked message file is not this script's to delete.
	const tarPath = join(dirname(stateDir), `muster-flip-${options.flipId}.tar`);
	let movedMessages = 0;
	let leftMessages = 0;
	if (existsSync(tarPath)) {
		for (const entry of plan.messageFiles) {
			const file = messageFileIn(entry.dir, entry.id);
			if (file === undefined) {
				leftMessages += 1;
				continue;
			}
			try {
				rmSync(file, { force: true });
				movedMessages += 1;
			} catch {
				leftMessages += 1;
			}
		}
	} else {
		leftMessages = plan.messageFiles.length;
	}

	const manifestPath = manifestPathFor(stateDir, options.flipId);
	const summaryPath = flipRecordPath(stateDir, options.flipId);
	const run: ImportRun = { ...plan, committedChunks, skippedChunks, written, cursor, movedMessages, leftMessages, manifestPath, summaryPath };
	mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 });
	writeFileSync(manifestPath, renderManifest(plan, run), { mode: 0o600 });
	writeFileSync(
		summaryPath,
		`${JSON.stringify({ flipId: options.flipId, cursor, askCounts: plan.askCounts, chunks: plan.chunks.length, counts: plan.counts, written, skippedChunks, movedMessages, leftMessages, lanes: plan.laneIds }, null, 2)}\n`,
		{ mode: 0o600 },
	);
	return run;
}

// ─── The command ─────────────────────────────────────────────────────────────

const USAGE = [
	"usage: node --import tsx scripts/muster-ledger-import.mts --flip-id <id> [--state-dir <dir>] [--json]",
	"",
	"  --flip-id    the flip's id: it names the chunks, the manifest and the flip record's data (required)",
	"  --state-dir  the Muster state directory to read (default: PI_MUSTER_STATE_DIR, else the agent's state/muster);",
	"               the manifest and the flip record's data are written beside it, in flip-artifacts/",
	"  --json       print the run as JSON instead of the summary lines",
	"",
	"Runs only with the source frozen and `musterd` serving its ledger: the source is the file stores and the",
	"writes go through `importBatch`. A rerun with the same id completes an interrupted import and writes nothing again.",
].join("\n");

function out(text: string): void {
	process.stdout.write(`${text}\n`);
}

type Parsed = { ok: true; options: ImportRunOptions; json: boolean } | { ok: false; error: string };

export function parseArguments(argv: readonly string[]): Parsed {
	let flipId = "";
	let stateDir = process.env["PI_MUSTER_STATE_DIR"]?.trim() ?? "";
	let json = false;
	for (let at = 0; at < argv.length; at += 1) {
		const word = argv[at];
		if (word === "--json") {
			json = true;
			continue;
		}
		if (word === "--flip-id" || word === "--state-dir") {
			const value = argv[at + 1];
			if (value === undefined || value.startsWith("--")) return { ok: false, error: `${word} needs a value` };
			at += 1;
			if (word === "--flip-id") flipId = value;
			else stateDir = value;
			continue;
		}
		return { ok: false, error: `unknown argument ${word}` };
	}
	if (flipId === "") return { ok: false, error: "--flip-id is required" };
	const resolved = stateDir === "" ? resolve(musterStateDir()) : resolve(stateDir);
	return { ok: true, json, options: { flipId, stateDir: resolved } };
}

/** The run, or the exit code to leave with. */
export function run(options: ImportRunOptions, json: boolean, write: (text: string) => void): number {
	if (readBackend(options.stateDir) === "ledger") {
		write(`muster-ledger-import: ${options.stateDir} already names the ledger; the source is the file stores`);
		return 2;
	}
	let result: ImportRun;
	try {
		result = importLedger(options);
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
	for (const source of IMPORT_SOURCES) {
		write(`${source}: read ${result.counts[source].read}, imported ${result.counts[source].imported}, skipped ${result.counts[source].skipped}`);
	}
	write(`chunks: ${result.committedChunks.length} committed, ${result.skippedChunks.length} already committed; cursor ${result.cursor}`);
	write(`messages: ${result.movedMessages} moved out with the backup tar, ${result.leftMessages} left in place`);
	write(`manifest ${result.manifestPath}`);
	write(`flip record data ${result.summaryPath}`);
	return 0;
}
/**
 * The entry `scripts/muster-ledger-import.mts` (the start file) runs: the same argument parsing,
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
		out(`muster-ledger-import: ${messageOf(error)}`);
		return 1;
	}
}

const SELF = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === SELF) process.exitCode = main(process.argv.slice(2));
