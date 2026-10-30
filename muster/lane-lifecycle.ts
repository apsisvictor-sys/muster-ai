/**
 * The lane record — the owner of a lane's life from launch to close
 * (lifecycle blueprint 2026-10-11, "The lifecycle").
 *
 * The lane card (`lib/lane-card.ts`) is the live heartbeat of a running process
 * and goes away with it. The lane record is the lane's life: it survives the
 * process, so a parked lane keeps its question and its commit. One JSON file per
 * lane, `<Muster state dir>/lifecycle/<laneId>.json`, written atomically.
 *
 * Imports from `lib/lane-card.ts` are types only: that module calls
 * `recordReport` from here, and a runtime import back would be a cycle.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LaneCard, LaneHarness, LaneOrigin, LaneReportMark } from "./lib/lane-card.ts";
import { HANDOFF_VERDICTS, type HandoffVerdict, type LaneHandoff } from "./lane-stage.ts";
import { backendState } from "./ledger/backend.ts";
import { ledgerCasStore, ledgerCommit, type LedgerCasStore } from "./ledger/cas-store.ts";
import { LANE_RECORD_STORE, ownerLedgerSocket } from "./ledger/stores.ts";
import { CAS_ATTEMPTS } from "./owner-fence.ts";
import { seatHeldBy, type SeatRole } from "./seats.ts";

/** What a lane is for (LD14). A `conversation` lane is a design or product session in talk with the operator: the tick never parks or closes it and the Stop hook never asks it for a report. Absent means `worker`. */
export type LaneKind = "worker" | "conversation";

export type LanePhase = "working" | "review_ready" | "blocked" | "question" | "parked" | "merged" | "abandoned" | "closed";

export interface LaneRecord {
	laneId: string;
	harness: LaneHarness;
	cwd: string | null;
	branch: string | null;
	sessionId?: string;
	/**
	 * Every session id the lane has had, oldest first, ending with `sessionId`. A parked or dead
	 * lane that is resumed starts a new session, so the chain keeps the earlier ones findable.
	 */
	sessionChain?: string[];
	/** The lane's Concord workspace (`CONCORD_REPO_ROOT`), so closing it finds the right database. */
	repoRoot?: string;
	launchedAt: number;
	/** `orchestrator`, `grokbot` or a lane id. */
	launchedBy: string;
	/** `conversation` for a design or product session (LD14); absent for a worker. Set by the launcher's `--conversation`. */
	kind?: LaneKind;
	/**
	 * What the lane delivers, in plain words for the operator (D27): one line, trimmed, 3 to 80 characters, no
	 * control characters (`validateLaneTitle`). Sticky across launches like `browser` and `kind`, never one
	 * of the routing facts a launch replaces; `muster lane-record title` replaces it. Absent on older records.
	 */
	title?: string;
	/** The launch named a model on a walled provider: "model <ref> walled at launch, until <time>". Replaced on every launch; the weekly digest counts it. */
	launchWarning?: string;
	/** The model the lane runs on (`provider/model`, or a harness alias). Replaced on every launch. */
	model?: string;
	/** The lane's class (`flash`, `H1`..`H5`): the methodology's class table, machine-readable. Replaced on every launch. */
	class?: string;
	/** What the lane does (`ui`, `copy`, `test`, `shared-owner`, ...): the closed kind list. Replaced on every launch. */
	taskKind?: string;
	/** How the lane was placed: `rule`, `orchestrator` or `failover`. Replaced on every launch. */
	routeBy?: string;
	/**
	 * The work item this lane serves (`OL2B`), written by a launch that came from the dispatcher (spec §10 OL2).
	 * It is how a crash is resolved: an item left `launch-uncertain` finds its lane here instead of relaunching
	 * blind. Absent on a lane the orchestrator placed by hand.
	 */
	item?: string;
	/** Copied on every report. */
	lastReport?: LaneReportMark;
	/** Every handoff the orchestrator made on this lane, oldest first (D27): every one is kept, because rounds count them all. */
	handoffs?: LaneHandoff[];
	phase: LanePhase;
	phaseSince: number;
	parkedAt?: number;
	reminded?: { stalledAt?: number; orchestratorAt?: number; operatorAt?: number; nudgedAt?: number };
	terminal?: { outcome: "merged" | "abandoned"; reason: string; sha: string | null; at: number; closedAt?: number };
	/** A browser QA lane (Claude in Chrome): set by the launcher, or by the first tab the lane opens (LD11). */
	browser?: boolean;
	/** The Chrome tab ids this lane opened and has not closed. The Stop hook asks for them to be closed; the janitor lists what a closed lane left. */
	openTabs?: number[];
	/** Helper processes (dev servers, browsers) the lane registered with `muster lane-pid add`. `closeLane` stops the ones still alive. */
	helperPids?: HelperPid[];
	/**
	 * Helper systemd scopes the lane registered with `muster lane-pid add-scope`. A dev server runs in its own
	 * memory-capped scope, and stopping the wrapper's pid alone leaves the server tree it started alive (measured
	 * 2026-10-18: two idle lanes left 5.4 GB next-server trees behind), so `closeLane` stops each scope by its exact
	 * unit name and the whole cgroup goes with it.
	 */
	helperScopes?: HelperScope[];
}

/** A registered helper process. `startTime` is its `/proc/<pid>/stat` start time: the same pid with another start time is another process. */
export interface HelperPid {
	pid: number;
	startTime: string;
	comm?: string;
	addedAt: number;
}

/** A registered helper systemd scope. The unit name is the identity: a scope is stopped by its exact name, never by pattern. */
export interface HelperScope {
	unit: string;
	addedAt: number;
}

/**
 * The scope unit names a lane may register. Strict, because the name reaches `systemctl` as one argument:
 * a plain scope unit name, never a pattern, a path or an option.
 */
export const HELPER_SCOPE_UNIT = /^[A-Za-z0-9][A-Za-z0-9@_.-]{0,200}\.scope$/;

/** The phase a report kind puts the lane in. A handoff that is not a review (discovery, already done) waits like one. */
export const PHASE_OF_REPORT: Readonly<Record<string, LanePhase>> = {
	working: "working",
	review_ready: "review_ready",
	discovery_ready: "review_ready",
	already_done: "review_ready",
	blocked: "blocked",
	question: "question",
};

export const TERMINAL_PHASES: readonly LanePhase[] = ["merged", "abandoned", "closed"];

/** The verdict that sends the work back and the one that accepts it, looked up in `lane-stage.ts`, which owns the words (CRS 3). */
export const SENT_BACK: HandoffVerdict = HANDOFF_VERDICTS[0];
export const ACCEPTED: HandoffVerdict = HANDOFF_VERDICTS[1];

/** A newline or any other control character would break the single line D27 asks for. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * A lane's title (D27): one line, trimmed, 3 to 80 characters, no control characters. One check, so the
 * launcher, the CLI and a record read back from the ledger agree on what a title is.
 */
export function validateLaneTitle(raw: unknown): { title: string } | { error: string } {
	if (typeof raw !== "string") return { error: "a lane title must be text" };
	const title = raw.trim();
	if (CONTROL_CHARS.test(title)) return { error: "a lane title must be one line: no newline or control character" };
	if (title.length < 3 || title.length > 80) return { error: `a lane title must be 3 to 80 characters (this one is ${title.length})` };
	return { title };
}

/** The record directory under a Muster state dir (`<musterStateDir>/lifecycle`). */
export function laneRecordsDir(musterStateDir: string): string {
	return join(musterStateDir, "lifecycle");
}

/** Where archived records go (`<musterStateDir>/lifecycle-archive`). */
export function laneRecordsArchiveDir(musterStateDir: string): string {
	return join(musterStateDir, "lifecycle-archive");
}

/** The same shape the gateway accepts for a lane id; a record path is never built from anything else. */
const SAFE_LANE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

function recordFile(musterStateDir: string, laneId: string): string {
	if (!SAFE_LANE_ID.test(laneId)) throw new Error(`lane record: ${JSON.stringify(laneId)} is not a valid lane id`);
	return join(laneRecordsDir(musterStateDir), `${laneId}.json`);
}

// ─── The ledger backend (LC5) ────────────────────────────────────────────────
//
// One owner, two stores (LC-D2): `lifecycle/<laneId>.json` (today's store,
// untouched) or the ledger's `lane-record` record, whose body is the same
// `LaneRecord`. Only the store branch changes; every rule above and below runs
// the same in both backends.

/** The owner's `CasStoreError` code set, so a caller can tell a stale record from an unreachable daemon. */
export class LaneRecordStateError extends Error {
	readonly code: "missing" | "malformed" | "conflict" | "io";
	constructor(code: "missing" | "malformed" | "conflict" | "io", message: string) {
		super(message);
		this.code = code;
		this.name = "LaneRecordStateError";
	}
}

/** The ledger keeps its revision beside the record, never inside it (LC-D3). */
type StoredLaneRecord = LaneRecord & { revision: number };

function validateStoredRecord(raw: unknown): { ok: true; record: StoredLaneRecord } | { ok: false; errors: string[] } {
	const record = raw as (Partial<LaneRecord> & { revision?: unknown }) | null | undefined;
	if (record === null || record === undefined || typeof record !== "object") return { ok: false, errors: ["not a lane record"] };
	const errors: string[] = [];
	if (typeof record.laneId !== "string" || SAFE_LANE_ID.test(record.laneId) === false) errors.push("laneId must be a lane id");
	if (typeof record.phase !== "string") errors.push("phase must be a string");
	if (typeof record.phaseSince !== "number") errors.push("phaseSince must be a number");
	if (typeof record.launchedAt !== "number") errors.push("launchedAt must be a number");
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, record: { ...(record as LaneRecord), revision: typeof record.revision === "number" ? record.revision : 0 } };
}

/** The record store on the ledger: the shared compare-and-set store, nothing added. */
function laneRecordStore(stateDir: string): LedgerCasStore<StoredLaneRecord> {
	return ledgerCasStore<StoredLaneRecord>(LANE_RECORD_STORE, ownerLedgerSocket(stateDir), {
		idPattern: SAFE_LANE_ID,
		idKind: "lane",
		noun: "lane record",
		validate: validateStoredRecord,
		errorClass: LaneRecordStateError,
	});
}

/** Empty a record in the live store, the ledger's "removed": `casList` skips an empty record and reads answer absent. */
function clearLedgerRecord(stateDir: string, laneId: string): void {
	const store = laneRecordStore(stateDir);
	for (let attempt = 0; ; attempt += 1) {
		const current = store.readWithRevision(laneId);
		if (current === undefined) return;
		const result = ledgerCommit(ownerLedgerSocket(stateDir), {
			requestId: `remove:${LANE_RECORD_STORE}:${laneId}:${current.revision}`,
			cas: [{ store: LANE_RECORD_STORE, id: laneId, expectedRevision: current.revision, record: null }],
		});
		if (result.ok) return;
		if (attempt >= CAS_ATTEMPTS - 1) throw new LaneRecordStateError("conflict", `Lane record ${laneId} changed while it was archived`);
	}
}

/**
 * Read one lane record. Returns undefined when missing, empty, torn or not a
 * record: an unreadable record is a stale leftover, never a record and never a crash.
 */
export function readLaneRecord(stateDir: string, laneId: string): LaneRecord | undefined {
	if (backendState(stateDir).backend === "ledger") {
		try {
			const stored = laneRecordStore(stateDir).readWithRevision(laneId);
			if (stored === undefined) return undefined;
			const { revision: _revision, ...record } = stored.record;
			return record;
		} catch (error) {
			// Symmetry with the file store: a torn record reads as absent, while an
			// unreachable store fails closed (LC-D4).
			if (error instanceof LaneRecordStateError && error.code === "malformed") return undefined;
			throw error;
		}
	}
	try {
		const file = recordFile(stateDir, laneId);
		if (!existsSync(file)) return undefined;
		const raw = readFileSync(file, "utf8").trim();
		if (raw === "") return undefined;
		const parsed = JSON.parse(raw) as Partial<LaneRecord> | null;
		if (parsed === null || typeof parsed !== "object" || parsed.laneId !== laneId) return undefined;
		if (typeof parsed.phase !== "string" || typeof parsed.phaseSince !== "number" || typeof parsed.launchedAt !== "number") return undefined;
		return parsed as LaneRecord;
	} catch {
		return undefined;
	}
}

/**
 * The record with the ledger revision the store tracks (LC5's report commit needs
 * it: one commit spans the card and the record). Files mode has no revision, so it
 * reads as 0; every caller lives in the ledger branch.
 */
export function readLaneRecordWithRevision(stateDir: string, laneId: string): { record: LaneRecord; revision: number } | undefined {
	if (backendState(stateDir).backend === "ledger") {
		try {
			const stored = laneRecordStore(stateDir).readWithRevision(laneId);
			if (stored === undefined) return undefined;
			const { revision: _revision, ...record } = stored.record;
			return { record, revision: stored.revision };
		} catch (error) {
			if (error instanceof LaneRecordStateError && error.code === "malformed") return undefined;
			throw error;
		}
	}
	const record = readLaneRecord(stateDir, laneId);
	return record === undefined ? undefined : { record, revision: 0 };
}

/** Every live (not archived) lane record. An unreadable file is skipped, never an error. */
export function listLaneRecords(stateDir: string): LaneRecord[] {
	if (backendState(stateDir).backend === "ledger") {
		const records: LaneRecord[] = [];
		for (const row of laneRecordStore(stateDir).list()) {
			const { revision: _revision, ...record } = row.record;
			records.push(record);
		}
		return records;
	}
	let names: string[];
	try {
		names = readdirSync(laneRecordsDir(stateDir));
	} catch {
		return [];
	}
	const records: LaneRecord[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const record = readLaneRecord(stateDir, name.slice(0, -".json".length));
		if (record !== undefined) records.push(record);
	}
	return records;
}

/** Write a lane record atomically (tmp + rename), so a reader never sees half a record. */
export function writeLaneRecord(stateDir: string, record: LaneRecord): void {
	if (backendState(stateDir).backend === "ledger") {
		writeLedgerRecord(stateDir, record);
		return;
	}
	const target = recordFile(stateDir, record.laneId);
	mkdirSync(laneRecordsDir(stateDir), { recursive: true, mode: 0o700 });
	const tmp = `${target}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
	renameSync(tmp, target);
}

/** A record write on the ledger: read the current revision, compare-and-set, retry a contended write. */
function writeLedgerRecord(stateDir: string, record: LaneRecord): void {
	const store = laneRecordStore(stateDir);
	for (let attempt = 0; ; attempt += 1) {
		const current = store.readWithRevision(record.laneId);
		try {
			store.update(record.laneId, current?.revision, () => ({ ...record, revision: current?.revision ?? 0 }));
			return;
		} catch (error) {
			if (!(error instanceof LaneRecordStateError) || error.code !== "conflict" || attempt >= CAS_ATTEMPTS - 1) throw error;
		}
	}
}

/**
 * Record one report on the lane's record: copy it, move the phase it names, and
 * start the reminders over (a new report is a new handoff). A lane with no record
 * is left alone: the launcher creates the record, and a report cannot invent a
 * launch. A record already in a terminal phase keeps its phase and takes only the line.
 */
export function recordReport(stateDir: string, laneId: string, mark: LaneReportMark): void {
	const record = readLaneRecord(stateDir, laneId);
	if (record === undefined) return;
	writeLaneRecord(stateDir, recordWithReport(record, mark, mark.at ?? Date.now()));
}

/**
 * The pure transform a report makes on a record (LC5's owner split): copy it, move
 * the phase the report kind names, and start the reminders over. A record already in
 * a terminal phase keeps its phase and takes only the line. One implementation, used
 * by the file path above and by the card owner's single ledger commit.
 */
export function recordWithReport(record: LaneRecord, mark: LaneReportMark, at: number): LaneRecord {
	const phase = PHASE_OF_REPORT[mark.kind];
	if (TERMINAL_PHASES.includes(record.phase) || phase === undefined) {
		return { ...record, lastReport: mark };
	}
	const { parkedAt: _parkedAt, ...rest } = record;
	return { ...rest, lastReport: mark, phase, phaseSince: at, reminded: {} };
}

/** Change one record in place; a lane with no record is left alone (the launcher creates it). A change that returns the record itself writes nothing. True when the lane has a record. */
function updateRecord(stateDir: string, laneId: string, change: (record: LaneRecord) => LaneRecord): boolean {
	const record = readLaneRecord(stateDir, laneId);
	if (record === undefined) return false;
	const changed = change(record);
	if (changed !== record) writeLaneRecord(stateDir, changed);
	return true;
}

/** A tab the lane opened (LD11). The lane is a browser lane from then on, whatever its launch flags said. */
export function recordTabOpened(stateDir: string, laneId: string, tabId: number): boolean {
	return updateRecord(stateDir, laneId, (record) => ({ ...record, browser: true, openTabs: [...new Set([...(record.openTabs ?? []), tabId])] }));
}

/** A tab the lane closed. The empty list is dropped, so a clean lane carries no `openTabs`. */
export function recordTabClosed(stateDir: string, laneId: string, tabId: number): boolean {
	return updateRecord(stateDir, laneId, (record) => {
		const { openTabs, ...rest } = record;
		const left = (openTabs ?? []).filter((id) => id !== tabId);
		return left.length === 0 ? rest : { ...rest, openTabs: left };
	});
}

/** Register a helper process the lane started. The same pid registered again replaces its entry. */
export function recordHelperPid(stateDir: string, laneId: string, helper: HelperPid): boolean {
	return updateRecord(stateDir, laneId, (record) => ({ ...record, helperPids: [...(record.helperPids ?? []).filter((entry) => entry.pid !== helper.pid), helper] }));
}

/** Register a helper systemd scope the lane started. The same unit registered again replaces its entry; a name that is not a plain scope unit is refused. */
export function recordHelperScope(stateDir: string, laneId: string, scope: HelperScope): boolean {
	if (!HELPER_SCOPE_UNIT.test(scope.unit)) throw new Error(`${JSON.stringify(scope.unit)} is not a systemd scope unit name`);
	return updateRecord(stateDir, laneId, (record) => ({ ...record, helperScopes: [...(record.helperScopes ?? []).filter((entry) => entry.unit !== scope.unit), scope] }));
}

/** The phases in which a lane runs nothing: the set the janitor reads as "no longer running" (a parked lane and a finished one). */
export const LANE_NOT_RUNNING_PHASES: readonly LanePhase[] = ["parked", "merged", "abandoned", "closed"];

/** A helper scope registered on a lane that is not running: a candidate for the janitor's sweep. */
export interface IdleHelperScope {
	laneId: string;
	unit: string;
	phase: LanePhase;
}

/**
 * The helper scopes registered on a record whose lane is not running any more. Pure, so the sweep's candidate
 * list is testable without systemd; the stopping is `stopIdleHelperScopes` in `lane-lifecycle-ports.ts`.
 */
export function idleLaneHelperScopes(records: readonly LaneRecord[]): IdleHelperScope[] {
	return records.flatMap((record) =>
		LANE_NOT_RUNNING_PHASES.includes(record.phase) ? (record.helperScopes ?? []).map((scope) => ({ laneId: record.laneId, unit: scope.unit, phase: record.phase })) : [],
	);
}

/**
 * A session started for this lane: make it the record's `sessionId` and append it to the
 * chain. Called by the Claude hook at SessionStart, so a parked-lane resume, a dead-lane
 * resume and a `/clear` all land in one place. A lane with no record is left alone, and
 * an id the chain already ends with changes nothing.
 */
export function recordSession(stateDir: string, laneId: string, sessionId: string): void {
	if (sessionId === "") return;
	updateRecord(stateDir, laneId, (record) => {
		const chain = record.sessionChain ?? (record.sessionId !== undefined ? [record.sessionId] : []);
		if (chain[chain.length - 1] === sessionId && record.sessionId === sessionId) return record.sessionChain === undefined ? { ...record, sessionChain: chain } : record;
		return { ...record, sessionId, sessionChain: [...chain.filter((id) => id !== sessionId), sessionId] };
	});
}

/**
 * Move a record out of the live directory into
 * `<musterStateDir>/lifecycle-archive/<YYYY-MM>/`. The file is moved, never deleted;
 * a name already taken in that month keeps the older file and takes a timestamp suffix.
 */
export function archiveLaneRecord(stateDir: string, laneId: string, now: number): void {
	if (backendState(stateDir).backend === "ledger") {
		// The archive stays a file (LC0-R5, non-store state): the record is written to
		// the same cold path the file backend used, then emptied in the live store, so a
		// relaunched name never overwrites history and nothing reads the archive as live.
		const record = readLaneRecord(stateDir, laneId);
		if (record === undefined) return;
		const month = new Date(now).toISOString().slice(0, 7);
		const dir = join(laneRecordsArchiveDir(stateDir), month);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		let target = join(dir, `${laneId}.json`);
		if (existsSync(target)) target = join(dir, `${laneId}.${now}.json`);
		writeFileSync(target, JSON.stringify(record, null, 2), { mode: 0o600 });
		clearLedgerRecord(stateDir, laneId);
		return;
	}
	const source = recordFile(stateDir, laneId);
	if (!existsSync(source)) return;
	const month = new Date(now).toISOString().slice(0, 7);
	const dir = join(laneRecordsArchiveDir(stateDir), month);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	let target = join(dir, `${laneId}.json`);
	if (existsSync(target)) target = join(dir, `${laneId}.${now}.json`);
	renameSync(source, target);
}

/** What a launch tells the record (the launcher is the only caller). */
export interface LaunchInput {
	laneId: string;
	harness: LaneHarness;
	cwd: string | null;
	branch: string | null;
	sessionId?: string;
	repoRoot?: string;
	/** `orchestrator` (the default), `grokbot` or a lane id. */
	launchedBy?: string;
	/** The launch names Claude in Chrome (`--chrome`, or a brief that uses its tools): a browser QA lane (LD11). */
	browser?: boolean;
	/** `--conversation`: a design or product session in talk with the operator (LD14). */
	kind?: LaneKind;
	/** What the lane delivers, in plain words (D27): required for a new worker lane, sticky on a relaunch. */
	title?: string;
	/** The launcher's warning for an explicit model on a walled provider (WARN1). */
	launchWarning?: string;
	/** The model the lane starts on, as the launcher resolved it. */
	model?: string;
	/** The lane's class (`flash`, `H1`..`H5`). */
	class?: string;
	/** What the lane does (`ui`, `copy`, `test`, `shared-owner`, ...). */
	taskKind?: string;
	/** How the lane was placed: `rule`, `orchestrator` or `failover`. */
	routeBy?: string;
	/** The work item this lane serves, when the dispatcher started it (spec §10 OL2). */
	item?: string;
}

/**
 * Record a launch. A lane with no record gets one in `working`. A record that is
 * `parked` is the same lane coming back: it keeps its history, returns to `working`
 * and starts the reminders over. A record in a live phase (`working`, `review_ready`,
 * `blocked`, `question`) is the same lane coming back — a relaunch or a respawn — so it takes
 * the new facts and keeps its phase and its history. A FRESH launch over a live id is refused
 * by the dispatcher before anything starts (`dispatch.ts`, `gated:live-record`), so a running
 * session's record is never replaced by a second launch of the same lane.
 * A finished record (merged, abandoned, closed) under a reused name is archived first, so a
 * relaunched name never overwrites history.
 */
export function recordLaunch(stateDir: string, input: LaunchInput, now: number = Date.now()): LaneRecord {
	let existing = readLaneRecord(stateDir, input.laneId);
	// Checked before anything moves: a refused launch writes nothing, so the archive of a reused name
	// waits for a launch that will actually start (D27, CRR 1).
	const title = input.title === undefined ? undefined : validateLaneTitle(input.title);
	if (title !== undefined && "error" in title) throw new LaneRecordStateError("invalid", title.error);
	// A new lane says what it delivers. A reused name whose record is terminal counts as new: that record is
	// archived first and the next lane starts with no handoffs (Review Focus 1). A relaunch, a resume of an
	// older record and a `--conversation` session need no title.
	const newLane = existing === undefined || TERMINAL_PHASES.includes(existing.phase);
	if (newLane && input.kind !== "conversation" && title === undefined) {
		throw new LaneRecordStateError("invalid", "a new lane needs --title: what it delivers, in plain words");
	}
	if (existing !== undefined && TERMINAL_PHASES.includes(existing.phase)) {
		archiveLaneRecord(stateDir, input.laneId, now);
		existing = undefined;
	}
	const facts = {
		harness: input.harness,
		cwd: input.cwd,
		branch: input.branch,
		...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
		...(input.repoRoot !== undefined ? { repoRoot: input.repoRoot } : {}),
		// Never cleared by a later launch: a resume that forgets the flag is still the same browser lane.
		...(input.browser === true ? { browser: true } : {}),
		// Sticky for the same reason: a conversation lane resumed by a launch without the flag is still a conversation.
		...(input.kind === "conversation" ? { kind: "conversation" as const } : {}),
		// Sticky too: the work item a dispatcher lane serves does not change when the lane is resumed.
		...(input.item !== undefined ? { item: input.item } : {}),
	};
	const chainOf = (base: LaneRecord | undefined): { sessionChain: string[] } | Record<string, never> => {
		const chain = base?.sessionChain ?? (base?.sessionId !== undefined ? [base.sessionId] : []);
		const next = input.sessionId !== undefined ? [...chain.filter((id) => id !== input.sessionId), input.sessionId] : chain;
		return next.length > 0 ? { sessionChain: next } : {};
	};
	// Each launch states its own warning: a relaunch on an open provider drops the earlier one.
	const warning = input.launchWarning !== undefined ? { launchWarning: input.launchWarning } : {};
	// The routing facts are stated the same way: each launch names the model, the class, the kind and
	// the placement it ran with, and a launch that names none drops the earlier ones.
	const routing = {
		...(input.model !== undefined ? { model: input.model } : {}),
		...(input.class !== undefined ? { class: input.class } : {}),
		...(input.taskKind !== undefined ? { taskKind: input.taskKind } : {}),
		...(input.routeBy !== undefined ? { routeBy: input.routeBy } : {}),
	};
	let record: LaneRecord;
	if (existing === undefined) {
		record = { laneId: input.laneId, ...facts, ...(title !== undefined ? { title: title.title } : {}), ...warning, ...routing, ...chainOf(undefined), launchedAt: now, launchedBy: input.launchedBy ?? "orchestrator", phase: "working", phaseSince: now };
	} else if (existing.phase === "parked") {
		const { parkedAt: _parkedAt, launchWarning: _launchWarning, model: _model, class: _class, taskKind: _taskKind, routeBy: _routeBy, ...rest } = existing;
		// The title rides through `...rest` like `browser` and `kind`, and a launch that names a new one replaces it.
		record = { ...rest, ...(title !== undefined ? { title: title.title } : {}), ...facts, ...warning, ...routing, ...chainOf(existing), phase: "working", phaseSince: now, reminded: {} };
	} else {
		const { launchWarning: _launchWarning, model: _model, class: _class, taskKind: _taskKind, routeBy: _routeBy, ...rest } = existing;
		record = { ...rest, ...(title !== undefined ? { title: title.title } : {}), ...facts, ...warning, ...routing, ...chainOf(existing) };
	}
	writeLaneRecord(stateDir, record);
	return record;
}

/** Why a handoff write is refused (D27, blueprint CRR 3). */
export type LaneHandoffRefusal = "no-record" | "terminal" | "no-review-report" | "invalid";

/** A refused handoff: the lane has no record, it is closed, it was sent back with no review since, or the handoff is malformed. */
export class LaneHandoffRefused extends Error {
	readonly code: LaneHandoffRefusal;
	constructor(code: LaneHandoffRefusal, message: string) {
		super(message);
		this.code = code;
		this.name = "LaneHandoffRefused";
	}
}

/** The limits D27 states for a handoff's two text cells. */
const HANDOFF_LIMITS = { cause: 200, waits: 140 } as const;
/** A commit id, short enough for a card and long enough to name one commit. */
const HANDOFF_SHA = /^[0-9a-f]{7,40}$/i;

/** Check one handoff and return it trimmed, so a blank cell never lands on the record as an empty string. */
function validateHandoff(input: Omit<LaneHandoff, "at">): { handoff: Omit<LaneHandoff, "at"> } | { error: string } {
	if (!HANDOFF_VERDICTS.includes(input.verdict)) return { error: `a handoff verdict is ${HANDOFF_VERDICTS.join(" or ")}, not ${JSON.stringify(input.verdict)}` };
	if (typeof input.by !== "string" || input.by.trim() === "") return { error: "a handoff needs the writer that made it" };
	const line = (key: "cause" | "waits"): string | { error: string } => {
		const value = input[key];
		if (value === undefined) return "";
		if (typeof value !== "string") return { error: `a handoff ${key} must be text` };
		const text = value.trim();
		if (text === "") return "";
		if (CONTROL_CHARS.test(text)) return { error: `a handoff ${key} must be one line: no newline or control character` };
		if (text.length > HANDOFF_LIMITS[key]) return { error: `a handoff ${key} is at most ${HANDOFF_LIMITS[key]} characters (this one is ${text.length})` };
		return text;
	};
	const cause = line("cause");
	if (typeof cause !== "string") return cause;
	const waits = line("waits");
	if (typeof waits !== "string") return waits;
	const sha = input.sha?.trim();
	if (sha !== undefined && sha !== "" && !HANDOFF_SHA.test(sha)) return { error: "a handoff sha is 7 to 40 hexadecimal characters" };
	return {
		handoff: {
			by: input.by.trim(),
			verdict: input.verdict,
			...(cause !== "" ? { cause } : {}),
			...(waits !== "" ? { waits } : {}),
			...(sha !== undefined && sha !== "" ? { sha } : {}),
		},
	};
}

/**
 * Record one handoff on a lane (D27). Every handoff is kept, because rounds count them all.
 *
 * Three refusals, typed so a caller prints the reason and writes nothing: no record for the lane,
 * a record that is already closed, and a second send-back with no review report after the previous
 * one (blueprint CRR 3). A review report is any report whose kind `PHASE_OF_REPORT` maps to
 * `review_ready`, later than that send-back.
 */
export function recordHandoff(stateDir: string, laneId: string, handoff: Omit<LaneHandoff, "at">, now: number = Date.now()): LaneRecord {
	const record = readLaneRecord(stateDir, laneId);
	if (record === undefined) throw new LaneHandoffRefused("no-record", `no lane record for ${laneId}: a handoff needs a launched lane`);
	if (record.terminal !== undefined || TERMINAL_PHASES.includes(record.phase)) {
		throw new LaneHandoffRefused("terminal", `${laneId} is ${record.terminal?.outcome ?? record.phase}: a handoff is written only on a live lane`);
	}
	const valid = validateHandoff(handoff);
	if ("error" in valid) throw new LaneHandoffRefused("invalid", valid.error);
	const handoffs = [...(record.handoffs ?? [])];
	// R2 (VR24-172): D27 refuses a second send-back when the LATEST handoff is already a send-back and no
	// review report came after it. An accept between two send-backs is the review that clears the guard, so
	// asking the latest *sent-back* refused a send-back that legitimately follows an accept.
	const latest = handoffs[handoffs.length - 1];
	if (handoff.verdict !== ACCEPTED && latest !== undefined && latest.verdict !== ACCEPTED) {
		const report = record.lastReport;
		const reviewed = report !== undefined && PHASE_OF_REPORT[report.kind] === "review_ready" && (report.at ?? 0) > latest.at;
		if (!reviewed) throw new LaneHandoffRefused("no-review-report", `${laneId} was sent back and no review report came after it: a second send-back needs one`);
	}
	const next: LaneRecord = { ...record, handoffs: [...handoffs, { ...valid.handoff, at: now }] };
	writeLaneRecord(stateDir, next);
	return next;
}

/**
 * The process-level steps `closeLane` needs. They are ports so this module keeps
 * to file IO (the Claude hook bundle hashes it, and `lib/lane-card.ts` calls into
 * it), and so each harness's stop path can be proved with fakes. The live ports
 * are `lane-close-ports.ts`.
 */
export interface CloseLanePorts {
	now(): number;
	sleep(ms: number): Promise<void>;
	/** What the lane's card says, when it has one. */
	/** `live` is true while the lane still beats: not a farewell `gone` card and not older than three heartbeats. */
	card(laneId: string): { harness: LaneHarness; sessionId?: string; live: boolean } | undefined;
	/** The harness of a lane's row in `pi-lanes.json`, when it has one. */
	registryHarness(laneId: string): LaneHarness | undefined;
	/** The two rows `sessionUntouchable` reads besides the lane record: the directory row (origin) and the `claude agents` row (kind). Absent in a fake that has neither. */
	sessionRows?(laneId: string): { registryRow?: { origin?: LaneOrigin }; agentsRow?: { kind?: string } };
	/**
	 * `claude stop` through the Claude lane owner; removes the card on success. `handle` is set when a live session was found.
	 * `absent` is set only when the registry was read and held no session for the lane; a table that could not be read, or a
	 * refusal of any kind, leaves it unset.
	 */
	stopClaude(laneId: string): { ok: boolean; handle?: string; absent?: boolean; reason?: string; detail: string };
	/** Queue the lane's own `stop` (Pi/OpenCode read it within one poll). */
	enqueueStop(laneId: string, from: string): void;
	/** The lane's tmux pane: running, dead (kept by remain-on-exit) or no window at all. */
	paneState(harness: LaneHarness, laneId: string): "alive" | "dead" | "absent";
	killWindow(harness: LaneHarness, laneId: string): void;
	removeCard(laneId: string): void;
	/** Stop one registered helper process: "stopped" (it was ours and is gone now), "gone" (already dead) or "reused" (the pid now belongs to another process, left alone). */
	stopHelper(pid: number, startTime: string): Promise<"stopped" | "gone" | "reused">;
	/**
	 * Stop one registered helper systemd scope by its exact unit name: "stopped" (the whole cgroup is gone), "gone"
	 * (the unit was already inactive) or "refused" (the lane scope does not cover it, so it is left registered).
	 * Throws when the scope is still active afterwards, so the registration is kept for the janitor's sweep.
	 */
	stopHelperScope(unit: string): Promise<"stopped" | "gone" | "refused">;
	/**
	 * Empty the lane's own launcher scope (VR21-42 S4): pi-lane-launch.sh runs the pane command
	 * inside a transient `lane-<lane>-<epoch>.scope` (pi-lanes.slice), and processes the pane left
	 * behind — an orphaned tool shell, a server that ignored its stop — keep that cgroup alive
	 * after the window is gone. Kills the cgroup and then checks it is empty before the close
	 * reports closed; a unit that did not empty is named, never a silent leftover. Optional: the
	 * fakes that predate VR21-42 omit it and the close skips the step.
	 */
	closeOwnScope?(laneId: string): Promise<OwnScopeOutcome>;
	/** `pi-lane-launch.sh --lane <lane> --unregister`, which owns the registry. */
	unregister(harness: LaneHarness, laneId: string): Promise<{ ok: boolean; detail: string }>;
	/** Concord, through its own repositories: disconnect the lane's endpoints and mark its agent finished. */
	closeConcord(repoRoot: string | undefined, laneId: string): Promise<{ endpoints: number; agent: "done" | "absent" | "no-database" }>;
}

/**
 * What the own-scope port answers: the launcher scopes it emptied and what its
 * emptiness check kept (VR21-42 S4). `emptied` naming every unit means the check
 * passed; a unit in `held` is a leftover the close warns about, never one it stays
 * silent about.
 */
export interface OwnScopeOutcome {
	/** The units the close emptied; `[]` when the lane has no active launcher scope. */
	emptied: string[];
	/** The units that still hold processes after the cgroup kill. */
	held: string[];
	/** Why `held` is not empty, or what the check could not do. */
	detail: string;
}

export interface CloseLaneOptions {
	/** Park keeps the registry row and the Concord agent; close removes both. */
	park: boolean;
	/** How a close ends the lane. A close with none keeps the record's own, else `abandoned`. */
	terminal?: { outcome: "merged" | "abandoned"; reason: string };
	/** Who asked, for the control request and the default reason. */
	caller?: string;
	/** How long a Pi/OpenCode pane gets to die after its own `stop`; default 60 s. */
	paneWaitMs?: number;
	pollMs?: number;
	/**
	 * Set only by `muster close <lane> --end-conversation` (LD17): the operator ended the topic, so a
	 * conversation session may be stopped. It lifts the conversation reason only. The orchestrator,
	 * the operator's own sessions and interactive rows stay refused. No gateway wiring sets it.
	 */
	endConversation?: boolean;
}

export interface CloseLaneResult {
	ok: boolean;
	/** The phase the record was left in, when there is a record. */
	phase?: LanePhase;
	/** Each thing done, in order. */
	steps: string[];
	/** Things that failed after the process was already stopped; the lane is still closed. */
	warnings: string[];
	detail: string;
}

export const PANE_STOP_WAIT_MS = 60_000;

/**
 * The one stop owner (blueprint WP4, audit a6). The CLI's `stop`/`close`, the
 * gateway's `lane_control stop` and the tick all call this, so a stop always
 * leaves the same thing behind. In order:
 *   1. stop the process the harness's own way (Pi/OpenCode: its own `stop`, then
 *      up to 60 s for the pane to die and a window kill if it does not; Claude: `claude stop`);
 *   2. kill the tmux window (the launcher sets remain-on-exit, so a dead one stays);
 *   3. unless parking: remove the registry row and clean up Concord;
 *   4. record the result on the lane record.
 * A process that cannot be stopped changes nothing and reports why. A session
 * `sessionUntouchable` names is refused here, whoever calls (LD17); only a conversation
 * session is lifted, and only by `options.endConversation`.
 */
export async function closeLane(stateDir: string, laneId: string, options: CloseLaneOptions, ports: CloseLanePorts): Promise<CloseLaneResult> {
	const steps: string[] = [];
	const warnings: string[] = [];
	const refuse = (detail: string): CloseLaneResult => ({ ok: false, steps, warnings, detail });
	const untouchable = sessionUntouchable({ stateDir, laneId, ...ports.sessionRows?.(laneId) });
	if (untouchable !== undefined && !(untouchable.why === "conversation" && options.endConversation === true)) {
		return refuse(untouchable.why === "conversation" ? `${untouchable.detail}; only \`muster close ${laneId} --end-conversation\`, run when the operator ends the topic, stops it` : `${untouchable.detail}`);
	}
	const caller = options.caller ?? "unknown";
	const record = readLaneRecord(stateDir, laneId);
	const card = ports.card(laneId);
	const harness: LaneHarness | undefined = [card?.harness, record?.harness, ports.registryHarness(laneId)].find((h) => h !== undefined && h !== "unknown");
	if (harness === undefined) return refuse(`no card, lane record or registry row names the harness of ${laneId}`);
	const sessionId = card?.sessionId ?? record?.sessionId;

	// 1. The process.
	if (harness === "claude") {
		const stopped = ports.stopClaude(laneId);
		if (stopped.ok) steps.push(`stopped the process (${stopped.detail})`);
		else if (stopped.absent === true) {
			ports.removeCard(laneId);
			steps.push("no live Claude session to stop, so its card is removed");
		}
		else return refuse(`claude stop failed, nothing else was changed: ${stopped.reason ?? stopped.detail}`);
	} else {
		let pane = ports.paneState(harness, laneId);
		if (card?.live === true) {
			// A beating lane drains its control queue within one poll. A stale or farewell card has no reader,
			// and a request left in the queue would stop whichever lane next takes the name.
			ports.enqueueStop(laneId, caller);
			const waitMs = options.paneWaitMs ?? PANE_STOP_WAIT_MS;
			const deadline = ports.now() + waitMs;
			for (;;) {
				pane = ports.paneState(harness, laneId);
				if (pane !== "alive" && ports.card(laneId)?.live !== true) break;
				if (ports.now() >= deadline) break;
				await ports.sleep(options.pollMs ?? 1_000);
			}
			if (pane === "absent" && ports.card(laneId)?.live === true) {
				return refuse(`${laneId} did not stop within ${Math.round(waitMs / 1000)} s and has no tmux window to kill; nothing else was changed`);
			}
			steps.push(pane === "alive" ? `its own stop did not end the pane within ${Math.round(waitMs / 1000)} s` : "stopped the process through its own stop");
		} else if (pane === "alive") {
			steps.push("no live card to ask, so the process is ended with its window");
		} else {
			steps.push("the process was already stopped");
		}
		// 2. The window (also ends a pane that ignored its stop).
		if (pane !== "absent") {
			ports.killWindow(harness, laneId);
			steps.push("killed the tmux window");
		}
		ports.removeCard(laneId);
	}

	// 2b. Helper processes the lane registered (dev servers, browsers), by exact pid, whether the lane parks or closes:
	// a parked lane runs nothing, and a resumed one starts what it needs again (LD11).
	const unstopped: HelperPid[] = [];
	for (const helper of record?.helperPids ?? []) {
		const label = `helper process ${helper.pid}${helper.comm !== undefined ? ` (${helper.comm})` : ""}`;
		try {
			const outcome = await ports.stopHelper(helper.pid, helper.startTime);
			steps.push(outcome === "stopped" ? `stopped ${label}` : outcome === "gone" ? `${label} had already exited` : `${label} was left alone: the pid now belongs to another process`);
		} catch (error) {
			unstopped.push(helper);
			warnings.push(`${label} not stopped: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	// The scopes the lane's helpers ran in. A helper process is often only the wrapper in front of a server tree
	// (dev-server.sh in front of `next dev`), so the scope is stopped too, by its exact unit name, which ends every
	// process in its cgroup.
	const unstoppedScopes: HelperScope[] = [];
	for (const scope of record?.helperScopes ?? []) {
		try {
			const outcome = await ports.stopHelperScope(scope.unit);
			if (outcome === "refused") unstoppedScopes.push(scope);
			steps.push(outcome === "stopped" ? `stopped helper scope ${scope.unit}` : outcome === "gone" ? `helper scope ${scope.unit} was already gone` : `helper scope ${scope.unit} was left alone: the lane scope does not cover it`);
		} catch (error) {
			unstoppedScopes.push(scope);
			warnings.push(`helper scope ${scope.unit} not stopped: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// 2c. The lane's own launcher scope (VR21-42 S4). The launcher runs each pane command inside a
	// transient `lane-<lane>-<epoch>.scope`, so stopping the pane and killing the window can still
	// leave processes in that cgroup. Empty it, and check the cgroup IS empty before the close
	// says the lane is closed: what survived is a warning, never a silent leftover.
	if (ports.closeOwnScope !== undefined) {
		const own = await ports.closeOwnScope(laneId).catch((error) => ({ emptied: [], held: [], detail: error instanceof Error ? error.message : String(error) }) satisfies OwnScopeOutcome);
		for (const unit of own.emptied) steps.push(`emptied lane scope ${unit} (cgroup empty)`);
		if (own.held.length > 0) warnings.push(`lane scope ${own.held.join(", ")} still holds processes: ${own.detail}`);
		else if (own.emptied.length === 0 && own.detail !== "") warnings.push(`lane scope not checked: ${own.detail}`);
	}

	// 3. Registry and Concord, closing only.
	if (!options.park) {
		if (harness !== "claude") {
			const unregistered = await ports.unregister(harness, laneId);
			steps.push(unregistered.detail);
			if (!unregistered.ok) warnings.push(`registry row not removed: ${unregistered.detail}`);
		}
		try {
			const concord = await ports.closeConcord(record?.repoRoot, laneId);
			steps.push(concord.agent === "no-database" ? "no Concord database to clean" : `Concord: ${concord.endpoints} endpoint(s) disconnected, agent ${concord.agent}`);
		} catch (error) {
			warnings.push(`Concord not cleaned: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// 4. The record.
	const now = ports.now();
	let phase: LanePhase | undefined;
	if (record !== undefined) {
		try {
			let next: LaneRecord;
			// The helpers and their scopes were stopped above (or were already gone or refused); only the ones that
			// could not be stopped stay registered, so the janitor's sweep can retry them.
			const { helperPids: _helperPids, helperScopes: _helperScopes, ...rest } = record;
			const bare: LaneRecord = {
				...rest,
				...(unstopped.length > 0 ? { helperPids: unstopped } : {}),
				...(unstoppedScopes.length > 0 ? { helperScopes: unstoppedScopes } : {}),
			};
			if (options.park) {
				next = TERMINAL_PHASES.includes(record.phase)
					? bare
					: { ...bare, ...(sessionId !== undefined ? { sessionId } : {}), phase: "parked", phaseSince: now, parkedAt: now };
			} else {
				const kept = record.terminal;
				const terminal = {
					outcome: options.terminal?.outcome ?? kept?.outcome ?? "abandoned",
					reason: options.terminal?.reason ?? kept?.reason ?? `closed by ${caller}`,
					sha: kept?.sha ?? record.lastReport?.sha ?? null,
					at: kept?.at ?? now,
					closedAt: now,
				} satisfies NonNullable<LaneRecord["terminal"]>;
				next = { ...bare, ...(sessionId !== undefined ? { sessionId } : {}), phase: "closed", phaseSince: now, terminal };
			}
			writeLaneRecord(stateDir, next);
			phase = next.phase;
			steps.push(`record: ${next.phase}`);
		} catch (error) {
			warnings.push(`lane record not written: ${error instanceof Error ? error.message : String(error)}`);
		}
	} else {
		steps.push("no lane record to update");
	}
	return { ok: true, ...(phase !== undefined ? { phase } : {}), steps, warnings, detail: `${options.park ? "parked" : "closed"} ${laneId}: ${steps.join("; ")}${warnings.length > 0 ? ` (warnings: ${warnings.join("; ")})` : ""}` };
}

// ─── The reconciler (blueprint WP3; LD1, LD5, the idle cap) ────────────────────────────────────

/**
 * The stop-gap that predates the `conversation` kind (LD14): lanes the tick never acts on, and that the Stop hook
 * never asks for a report. It stays until `sn-product` is relaunched as a conversation. `orchestrator` is protected
 * whatever the file says.
 */
export const DEFAULT_PROTECTED_LANES: readonly string[] = ["sn-product", "orchestrator"];

const MINUTE_MS = 60_000;
/** LD1: no turn for this long, after a handoff and with a clean worktree, parks a lane. */
export const IDLE_PARK_MS = 30 * MINUTE_MS;
/** LD5: a handoff nobody absorbed reminds the orchestrator after this long. */
export const REMIND_ORCHESTRATOR_MS = 2 * 60 * MINUTE_MS;
/** LD5: and the operator, through Henry, after this long. */
export const REMIND_OPERATOR_MS = 12 * 60 * MINUTE_MS;
/** The standing 3-idle-lane rule. */
export const IDLE_LANE_CAP = 3;
/** The local refs a merge is read from; the orchestrator's push moves them and the tick never fetches. */
export const MERGE_REFS: readonly string[] = ["origin/dev", "origin/main"];

export function protectedLanesFile(stateDir: string): string {
	return join(stateDir, "protected-lanes.json");
}

/**
 * The lanes the tick leaves alone: `<Muster state dir>/protected-lanes.json`, a JSON array of lane names,
 * or `DEFAULT_PROTECTED_LANES` when the file is absent. A file that is there but unreadable is an
 * `error`, and the caller must not act on guesses about who is protected.
 */
export function readProtectedLanes(stateDir: string): { lanes: string[]; error?: string } {
	const file = protectedLanesFile(stateDir);
	if (!existsSync(file)) return { lanes: [...DEFAULT_PROTECTED_LANES] };
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
			return { lanes: [...DEFAULT_PROTECTED_LANES], error: `${file} must be a JSON array of lane names` };
		}
		return { lanes: (parsed as string[]).map((entry) => entry.trim()) };
	} catch (error) {
		return { lanes: [...DEFAULT_PROTECTED_LANES], error: `${file}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/**
 * Is this lane a conversation session (LD14): its record says `kind: "conversation"`, or it is named in the
 * protected-lanes stop-gap. The one answer the tick (`decideLifecycle`, through the same two facts) and the report
 * nudge (Claude Stop hook, Pi `agent_end`) share. A file that cannot be read still answers with the built-in list.
 */
export function isConversationLane(stateDir: string, laneId: string): boolean {
	if (readLaneRecord(stateDir, laneId)?.kind === "conversation") return true;
	return readProtectedLanes(stateDir).lanes.includes(laneId);
}

/** Why a session is out of reach of every automation (LD17). `why` is the class, `detail` the sentence a refusal prints. */
export type Untouchable = { why: "orchestrator" | "seat" | "operator" | "interactive" | "conversation"; detail: string };

/** The facts `untouchableSession` decides from. `sessionUntouchable` reads them from disk. */
export interface UntouchableFacts {
	laneId: string;
	/** The lane record's kind. */
	recordKind?: LaneKind;
	/** The protected-lanes stop-gap. */
	protectedLanes: readonly string[];
	/** The registry (directory) row's origin. */
	origin?: LaneOrigin;
	/** The `claude agents` row's kind. */
	agentsKind?: string;
	/** The seat this lane's session holds (LD24). A holder whose process died still holds it. */
	heldSeat?: SeatRole;
}

/**
 * LD17: the sessions no automation stops or resumes. In order: the `orchestrator`, a seat holder (LD24), the operator's own
 * (a `operator:` lane id or a registry row of origin `operator`), an interactive `claude agents` row,
 * and a conversation session (LD14: record kind `conversation` or the protected-lanes stop-gap).
 * Pure, so the tick's reconciler (which holds the records already) reads the same answer.
 */
export function untouchableSession(facts: UntouchableFacts): Untouchable | undefined {
	if (facts.laneId === "orchestrator") return { why: "orchestrator", detail: "the orchestrator lane is never stopped by the bus" };
	if (facts.heldSeat !== undefined) return { why: "seat", detail: `${facts.laneId} holds the ${facts.heldSeat} seat (LD24), never stopped by the bus` };
	if (facts.laneId.startsWith("operator:") || facts.origin === "operator") return { why: "operator", detail: "the operator's own session (LD2) is never stopped by the bus" };
	if (facts.agentsKind === "interactive") return { why: "interactive", detail: "an interactive session is never stopped by the bus" };
	if (facts.recordKind === "conversation" || facts.protectedLanes.includes(facts.laneId)) {
		return { why: "conversation", detail: `${facts.laneId} is a conversation session (LD14, LD17), never stopped by the bus` };
	}
	return undefined;
}

/**
 * The one predicate `closeLane`, `muster control`, the gateway's `lane_control` and the tick share.
 * Reads the lane record and the protected-lanes file from `stateDir`; the registry row (origin) and the
 * `claude agents` row (kind) come from the caller, which has them.
 */
export function sessionUntouchable(input: { stateDir: string; laneId: string; registryRow?: { origin?: LaneOrigin }; agentsRow?: { kind?: string } }): Untouchable | undefined {
	const recordKind = readLaneRecord(input.stateDir, input.laneId)?.kind;
	const heldSeat = seatHeldBy(input.laneId, { stateDir: input.stateDir });
	return untouchableSession({
		laneId: input.laneId,
		...(heldSeat !== undefined ? { heldSeat } : {}),
		...(recordKind !== undefined ? { recordKind } : {}),
		protectedLanes: readProtectedLanes(input.stateDir).lanes,
		...(input.registryRow?.origin !== undefined ? { origin: input.registryRow.origin } : {}),
		...(input.agentsRow?.kind !== undefined ? { agentsKind: input.agentsRow.kind } : {}),
	});
}

/** The reminders a record tracks for the tick (the hook's `nudgedAt` is not one of them). */
export type LaneReminder = "stalledAt" | "orchestratorAt" | "operatorAt";

/** Stamp one reminder as sent. A record that is gone or unreadable is left alone. */
export function markReminded(stateDir: string, laneId: string, reminder: LaneReminder, at: number): void {
	const record = readLaneRecord(stateDir, laneId);
	if (record === undefined) return;
	writeLaneRecord(stateDir, { ...record, reminded: { ...record.reminded, [reminder]: at } });
}

export type LifecycleAction =
	| { kind: "park"; lane: string; why: "idle-30m" | "idle-cap" }
	| { kind: "close"; lane: string; outcome: "merged" | "abandoned"; reason: string; sha: string | null }
	/** A STALLED event to the orchestrator. `reminder` is the stamp to set once it is sent, so it fires once. */
	| { kind: "event"; lane: string; detail: string; reminder?: LaneReminder }
	/** One line to the operator through Henry's outbox. `afterClose`: only if the close in the same list worked. */
	| { kind: "tell-operator"; lane: string; text: string; reminder?: LaneReminder; afterClose?: boolean }
	| { kind: "flag-dirty"; lane: string; reminder?: LaneReminder };

/**
 * The git facts the rules read, three-valued: `undefined` is "could not tell" (missing cwd, timeout, an
 * error), and a rule that needs a fact it cannot get never stops or closes a lane.
 */
export type GitFacts = {
	isAncestor(cwd: string, sha: string, ref: string): boolean | undefined;
	isClean(cwd: string): boolean | undefined;
	onBranch(cwd: string, sha: string, branch: string): boolean | undefined;
	/** True for a linked worktree of a repository (not its main checkout): where a lane lives. */
	isLinkedWorktree(cwd: string): boolean | undefined;
};

export interface DecideLifecycleOptions {
	/** Lanes never acted on; default `DEFAULT_PROTECTED_LANES`. `orchestrator` is always included. */
	protectedLanes?: readonly string[];
	/** The lane id of every seat holder (`seatHolderLanes`): untouchable whatever the protected-lanes file says (LD24). */
	seatLanes?: ReadonlyArray<{ role: SeatRole; laneId: string }>;
	/** Says why a lane got no action, for the dry run. */
	trace?: (laneId: string, note: string) => void;
}

const HANDOFF_PHASES: readonly LanePhase[] = ["review_ready", "blocked", "question"];

function duration(ms: number): string {
	const minutes = Math.round(ms / MINUTE_MS);
	return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 6) / 10} h`;
}

function short(sha: string): string {
	return sha.slice(0, 7);
}

/**
 * The reconciler: what the tick should do about each lane record, from the directory rows
 * (`enumerateLanes`: liveness, last turn, origin), the lane records and git. Pure: it reads the
 * facts it is given, calls `git` for the three-valued git facts, and returns actions.
 *
 * Skipped without a word: a record in `closed`, a `conversation` lane (LD14), a protected lane, the lane `orchestrator`, a `operator`
 * row, a lane with no cwd or whose cwd is not a linked worktree (it is not a lane we can verify).
 * A fact git cannot give (`undefined`) never stops or closes a lane; one STALLED event says so instead.
 * A dirty worktree is never stopped; one STALLED event flags it. Each reminder fires once per
 * record, tracked by `reminded`.
 */
export function decideLifecycle(rows: readonly LaneCard[], records: ReadonlyMap<string, LaneRecord>, git: GitFacts, now: number, options: DecideLifecycleOptions = {}): LifecycleAction[] {
	const actions: LifecycleAction[] = [];
	const trace = options.trace ?? ((): void => undefined);
	const protectedLanes = new Set<string>([...(options.protectedLanes ?? DEFAULT_PROTECTED_LANES), "orchestrator"]);
	const byLane = new Map(rows.map((row) => [row.laneId, row]));
	/** Alive, idle, verified handoff lanes: the pool the idle cap counts. */
	const idle: Array<{ laneId: string; cwd: string; quietSince: number; sha: string | undefined; branch: string | null; blocked: boolean; refuse(why: "dirty" | "unknown", what: string): void }> = [];

	for (const laneId of [...records.keys()].sort()) {
		const record = records.get(laneId)!;
		if (record.phase === "closed") {
			trace(laneId, "closed");
			continue;
		}
		const row = byLane.get(laneId);
		const heldSeat = options.seatLanes?.find((entry) => entry.laneId === laneId)?.role;
		const untouchable = untouchableSession({ laneId, protectedLanes: [...protectedLanes], ...(heldSeat !== undefined ? { heldSeat } : {}), ...(record.kind !== undefined ? { recordKind: record.kind } : {}), ...(row?.origin !== undefined ? { origin: row.origin } : {}) });
		if (untouchable !== undefined) {
			trace(laneId, record.kind === "conversation" ? "conversation session (LD14): never parked, closed or reminded" : "protected or the operator's own session: never touched");
			continue;
		}
		const cwd = record.cwd ?? row?.cwd ?? null;
		if (cwd === null) {
			trace(laneId, "no cwd on the record or the row, so it is not a lane worktree we can verify");
			continue;
		}
		const linked = git.isLinkedWorktree(cwd);
		if (linked === false) {
			trace(laneId, `${cwd} is not a linked worktree: not a lane we act on`);
			continue;
		}
		const reminded = record.reminded ?? {};
		const sent = new Set<LaneReminder>();
		const once = (reminder: LaneReminder, action: LifecycleAction): void => {
			if (reminded[reminder] !== undefined || sent.has(reminder)) return;
			sent.add(reminder);
			actions.push({ ...action, reminder } as LifecycleAction);
		};
		const refuse = (why: "dirty" | "unknown", what: string): void => {
			if (why === "dirty") once("stalledAt", { kind: "flag-dirty", lane: laneId });
			else once("stalledAt", { kind: "event", lane: laneId, detail: `cannot verify ${what} for ${laneId}; not stopped` });
		};
		/** The merge check could not be answered, so nothing may be stopped on a guess this tick. */
		let mergeUnknown = false;
		let cleanFact: boolean | undefined | "unread" = "unread";
		const isClean = (): boolean | undefined => {
			if (cleanFact === "unread") cleanFact = git.isClean(cwd);
			return cleanFact;
		};
		/** Whether a stop or close may happen: the worktree is verified, clean, and a reported commit is on its branch. */
		const mayStop = (needBranch: boolean): boolean => {
			const clean = linked === undefined ? undefined : isClean();
			const branch = record.lastReport?.branch ?? record.branch;
			const onBranch = clean === true && needBranch && record.lastReport?.sha !== undefined && branch !== null ? git.onBranch(cwd, record.lastReport.sha, branch) : true;
			if (clean === false) refuse("dirty", "worktree");
			else if (linked === undefined) refuse("unknown", `the worktree ${cwd}`);
			else if (clean === undefined) refuse("unknown", "whether its worktree is clean");
			else if (onBranch !== true) refuse("unknown", `that the reported commit ${short(record.lastReport?.sha ?? "")} is on ${branch ?? "its branch"}`);
			return clean === true && linked === true && onBranch === true && !mergeUnknown;
		};

		const lastTurn = row?.lastTurnAt ?? row?.lastActivityMs ?? null;
		const quietSince = Math.max(lastTurn ?? 0, record.phaseSince);
		const quietMs = now - quietSince;
		const busy = row?.state === "running" || (row?.toolStartedAt !== undefined && row.toolStartedAt !== null);
		const sha = record.lastReport?.sha;
		let parkedNow = false;

		// 1. A merged or abandoned record that never reached closed: finish the close.
		if (record.phase === "merged" || record.phase === "abandoned") {
			if (mayStop(false)) {
				actions.push({ kind: "close", lane: laneId, outcome: record.phase, reason: record.terminal?.reason ?? record.phase, sha: record.terminal?.sha ?? sha ?? null });
			}
			continue;
		}

		// 2. The reported commit is in origin/dev or origin/main: merged. A lane still working on feedback is not.
		if (sha !== undefined && (record.phase !== "working" || row?.alive === false)) {
			let mergedRef: string | undefined;
			let unknown = linked === undefined;
			if (linked === true) {
				for (const ref of MERGE_REFS) {
					const inRef = git.isAncestor(cwd, sha, ref);
					if (inRef === true) {
						mergedRef = ref;
						break;
					}
					if (inRef === undefined) unknown = true;
				}
			}
			if (mergedRef !== undefined) {
				if (mayStop(false)) {
					actions.push({ kind: "close", lane: laneId, outcome: "merged", reason: `reported ${short(sha)} is in ${mergedRef}`, sha });
				}
				continue;
			}
			if (unknown) {
				mergeUnknown = true;
				if (quietMs >= IDLE_PARK_MS) refuse("unknown", `whether ${short(sha)} is in ${MERGE_REFS.join(" or ")}`);
			}
		}

		// 3. The process is gone and the lane never reported: it died.
		if (record.phase === "working" && row?.alive === false && quietMs >= IDLE_PARK_MS) {
			if (mayStop(false)) {
				const wall = row.wall !== null && row.wall !== undefined ? `quota wall ${row.wall.shapeId}` : "process gone";
				const reason = `died: ${wall}, last turn ${lastTurn === null ? "unknown" : new Date(lastTurn).toISOString()}`;
				actions.push({ kind: "close", lane: laneId, outcome: "abandoned", reason, sha: sha ?? null });
				actions.push({ kind: "tell-operator", lane: laneId, afterClose: true, text: `${laneId} died with no report (${reason}). The tick closed it as abandoned. Its worktree ${cwd} is untouched.` });
			}
			continue;
		}

		// 4. A handoff nobody has touched for 30 minutes: park it.
		if (HANDOFF_PHASES.includes(record.phase) && quietMs >= IDLE_PARK_MS && !busy) {
			if (mayStop(true)) {
				actions.push({ kind: "park", lane: laneId, why: "idle-30m" });
				parkedNow = true;
			}
		}

		// 5. Working, alive and silent for 30 minutes: tell the orchestrator once.
		if (record.phase === "working" && row?.alive !== false && quietMs >= IDLE_PARK_MS) {
			once("stalledAt", { kind: "event", lane: laneId, detail: `working with no report and no turn for ${duration(quietMs)}` });
		}

		// 6. A handoff nobody absorbed: remind the orchestrator at 2 h and the operator at 12 h (LD5).
		const lastKind = PHASE_OF_REPORT[record.lastReport?.kind ?? ""];
		const handoff = HANDOFF_PHASES.includes(record.phase) ? record.phase : record.phase === "parked" && lastKind !== undefined && HANDOFF_PHASES.includes(lastKind) ? lastKind : undefined;
		if (handoff !== undefined) {
			const handedAt = record.phase === "parked" ? (record.lastReport?.at ?? record.phaseSince) : record.phaseSince;
			const waited = now - handedAt;
			const summary = record.lastReport?.summary ?? handoff;
			if (waited >= REMIND_ORCHESTRATOR_MS) once("orchestratorAt", { kind: "event", lane: laneId, detail: `${handoff} not absorbed for ${duration(waited)}: ${summary}` });
			if (waited >= REMIND_OPERATOR_MS) {
				const branch = record.lastReport?.branch ?? record.branch;
				const advice = handoff === "review_ready"
					? `Recommendation: review and merge ${branch ?? "its branch"}${sha !== undefined ? `@${short(sha)}` : ""}, or close it with muster close ${laneId} --abandoned "<reason>".`
					: `Recommendation: answer it with muster send ${laneId} "<answer>", or close it with muster close ${laneId} --abandoned "<reason>".`;
				once("operatorAt", { kind: "tell-operator", lane: laneId, text: `${laneId} has waited ${duration(waited)} with ${handoff}: ${summary}. ${advice}` });
			}
		}

		// The idle cap counts verified lanes that are alive, idle and handed off, and are not already being parked.
		if (linked === true && HANDOFF_PHASES.includes(record.phase) && row?.alive === true && !busy && !parkedNow) {
			idle.push({ laneId, cwd, quietSince, sha, branch: record.lastReport?.branch ?? record.branch, blocked: mergeUnknown, refuse });
		}
	}

	// 7. More than 3 idle lanes: park the oldest first, even before 30 minutes. A lane that cannot be parked still counts.
	let excess = idle.length - IDLE_LANE_CAP;
	for (const lane of [...idle].sort((a, b) => a.quietSince - b.quietSince || a.laneId.localeCompare(b.laneId))) {
		if (excess <= 0) break;
		if (lane.blocked) continue;
		const clean = git.isClean(lane.cwd);
		if (clean !== true) {
			lane.refuse(clean === false ? "dirty" : "unknown", "whether its worktree is clean");
			continue;
		}
		if (lane.sha !== undefined && lane.branch !== null && git.onBranch(lane.cwd, lane.sha, lane.branch) !== true) {
			lane.refuse("unknown", `that the reported commit ${short(lane.sha)} is on ${lane.branch}`);
			continue;
		}
		actions.push({ kind: "park", lane: lane.laneId, why: "idle-cap" });
		excess -= 1;
	}
	return actions;
}
