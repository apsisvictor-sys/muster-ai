/**
 * The lane card contract — design §4.2.
 *
 * ONE owner of the card shape, the state vocabulary and the thresholds. The
 * Pi adapter (extensions/muster) writes cards through this module; the lane
 * directory (lane-directory.ts) reads them through it; a future OpenCode host
 * or Claude adapter imports the same shape here rather than defining its own.
 *
 * A card is one JSON file per lane, written only by that lane's adapter and
 * read by everyone: `<Muster state dir>/lanes/<laneId>.json`. The Muster state
 * dir is what `musterStateDir()` resolves (`<agent dir>/state/muster`, or
 * `PI_MUSTER_STATE_DIR`), the same root the send log and Muster sessions use —
 * so `state/muster/lanes/<laneId>.json` in a default installation. `laneId`
 * is the Concord agent id; `sessionId` carries the harness's own session
 * identity (Pi: the session UUID) so one physical lane is never listed twice.
 *
 * States per §4.2: idle, running, waiting, stalled, quota-walled, gone. A lane
 * that exits writes one farewell card (`gone`, fresh `updatedAt`); a crash
 * writes nothing, and `isCardGone` expires whatever it last said.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readLaneRecordWithRevision, recordReport, recordWithReport, type LanePhase } from "../lane-lifecycle.ts";
import { backendState } from "../ledger/backend.ts";
import { ledgerCasStore, ledgerCommit, type CasCommitWrite, type LedgerCasStore } from "../ledger/cas-store.ts";
import { MusterdUnreachable } from "../ledger/client.ts";
import { spoolWrite } from "../ledger/spool.ts";
import { LANE_CARD_STORE, LANE_RECORD_STORE, ownerLedgerSocket } from "../ledger/stores.ts";
import { CAS_ATTEMPTS } from "../owner-fence.ts";

export type LaneState = "idle" | "running" | "waiting" | "stalled" | "quota-walled" | "blocked" | "gone";

/**
 * The harness a card names. `hermes` is the bus's own name for a Hermes lane
 * (F17, LC12): the owner gains it at cutover, where the pilot read Hermes as
 * `unknown`. It is a harness the bus does not launch and does not retune — its
 * parity column (`LANE_VERB_PARITY`) is the verbs the CLI itself serves.
 */
export type LaneHarness = "pi" | "claude" | "opencode" | "hermes" | "unknown";

/** A quota wall, as `lib/quota-classifier.ts` classifies it. */
export type LaneWall = {
	shapeId: string;
	/** Epoch ms the error text named, when it carried one. */
	resetAt?: number;
	assumed?: boolean;
	/** Epoch ms muster-tick acted on this wall (switched the model or set a timer); it acts once per wall. */
	handledAt?: number;
};

/**
 * The lane's own last report line (A3, acceptance check 3).
 *
 * A lane without a Concord task can still say where it is; the card carries the
 * one line the directory and the mission table show, so the reader never has to
 * parse a pane.
 */
export interface LaneReportMark {
	/** The report kind (`review_ready`, `blocked`, `working`, …). */
	kind: string;
	/** One line, already rendered for a table cell. */
	summary: string;
	/** Epoch ms the report was filed. */
	at?: number;
	/** The reported branch (`review_ready`). */
	branch?: string;
	/** The reported commit (`review_ready`, `discovery_ready`): what the lifecycle checks against origin. */
	sha?: string;
	/** The base the work was cut from (`review_ready`). */
	base?: string;
}

/**
 * Who started a lane: `auto` (the launcher, the orchestrator, Henry or a daemon)
 * or `operator` (a session the operator started himself, read-only on the bus — LD2).
 */
export type LaneOrigin = "auto" | "operator";

/** One lane card. `null` is "unknown/absent"; a reader never invents a value. */
/**
 * What the lane made of the last control request a reader queued for it
 * (check 5). A verb that is taken from the queue and then refused — an unknown
 * model, a session that declines the switch — must be visible afterwards, or the
 * orchestrator cannot tell "not applied yet" from "refused".
 */
export interface LaneControlOutcome {
	operation: string;
	ok: boolean;
	reason?: string;
	at: number;
}

export interface LaneCard {
	laneId: string;
	harness: LaneHarness;
	cwd: string | null;
	branch: string | null;
	state: LaneState;
	model: string | null;
	thinking: string | null;
	/** Epoch ms — when the lane entered its current state. */
	since: number | null;
	/** Epoch ms of the last heartbeat; null when the row comes from a harness surface, not a card. */
	updatedAt: number | null;
	/** Present only when the state is quota-walled. */
	wall: LaneWall | null;
	/** Why the lane's turn ended on an API error that needs the operator; present only when the state is blocked. */
	blockedReason?: string;
	/** Automatic resumes already spent on consecutive transient API errors; a successful turn end resets it to 0. */
	retry?: { count: number };
	/** How to reach the lane (the Pi writer sets it). */
	endpoint?: string;
	/** Delivered-but-not-yet-read messages (the Pi writer sets it). */
	pendingIn?: number;
	/** The harness's own session id, so one physical lane is one row. */
	sessionId?: string;
	/** Reader-set: true when this row came from a card file; false when derived from a harness surface. */
	authoritative?: boolean;
	/**
	 * Reader-set: epoch ms of the last transcript turn. Never the heartbeat (audit
	 * a2): a card heartbeat proves the process is up, not that the lane did anything.
	 */
	lastActivityMs?: number | null;
	/** Reader-set: who started the lane (LD2). */
	origin?: LaneOrigin;
	/** Reader-set: whether the lane's process is up right now. */
	alive?: boolean;
	/** Reader-set: the evidence `alive` came from. */
	aliveVia?: "tmux" | "pid" | "claude-agents" | "systemd" | "none";
	/** Reader-set: epoch ms of the last transcript turn; `lastActivityMs` carries the same value. */
	lastTurnAt?: number | null;
	/** Reader-set: epoch ms of the last card heartbeat (the card's `updatedAt`). */
	heartbeatAt?: number | null;
	/** Reader-set: the lane record's phase, on a row that comes from a record with no card (parked, closed, …). */
	phase?: LanePhase;
	/** Reader-set: every session id the lane record has seen, oldest first (a resumed lane starts a new session). */
	sessionChain?: string[];
	/** The lane's own last report line, when it filed one (check 3). */
	lastReport?: LaneReportMark;
	/** Epoch ms the lane's current work cycle began: a Claude session started or resumed (`SessionStart`). A report older than this belongs to an earlier cycle. */
	cycleStartedAt?: number;
	/** Epoch ms the turn-end hook asked this lane for its report (LD7); once per cycle. */
	reportNudgedAt?: number;
	/**
	 * One short line of the lane's last message to the person, when the harness
	 * can say it without parsing a pane. The Claude bus-agent heartbeat writes it
	 * from the `Stop` hook's `last_assistant_message` (2026-10-09); `null` is "the
	 * lane has not said anything yet", absent is "this harness cannot say".
	 */
	lastMessage?: string | null;
	/** The last control request this lane applied or refused (check 5). */
	lastControl?: LaneControlOutcome;
	/** How full the lane's context window is (0-100), when the harness can say. */
	contextPercent?: number | null;
	/**
	 * Epoch ms when the tool now executing started; absent when no tool is
	 * running. A reader derives how long it has been running (a long test run
	 * writes nothing for a long time, so the state stays `running` and the age is
	 * what a watcher judges). Written by the Pi writer from
	 * `tool_execution_start` / `tool_execution_end` (2026-10-08).
	 */
	toolStartedAt?: number;
}

/** The longest `lastMessage` a card keeps; a longer text is cut and ends in an ellipsis. */
export const LAST_MESSAGE_MAX = 500;

/** The one cut rule for a card's `lastMessage`, for the Claude hook and the Pi writer. */
export function cutLastMessage(text: string): string {
	return text.length > LAST_MESSAGE_MAX ? `${text.slice(0, LAST_MESSAGE_MAX)}…` : text;
}

/** Heartbeat interval in ms (§4.2: every 15 s). */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** Default stalled threshold in minutes (the env override is PI_LANES_STALLED_MINUTES). */
export const DEFAULT_STALLED_MINUTES = 20;

/** Stalled threshold in ms, with the PI_LANES_STALLED_MINUTES override. */
export function stalledThresholdMs(): number {
	const raw = process.env.PI_LANES_STALLED_MINUTES;
	if (raw) {
		const value = Number(raw);
		if (Number.isFinite(value) && value > 0) return value * 60_000;
	}
	return DEFAULT_STALLED_MINUTES * 60_000;
}

/** `gone` after this many ms without a heartbeat (§4.2: 3 missed). */
export function goneAfterMs(): number {
	return HEARTBEAT_INTERVAL_MS * 3;
}

/**
 * The one staleness rule, for the writer's cadence and the reader's verdict:
 * a card whose last heartbeat is older than three intervals is gone, whatever
 * state it last recorded.
 */
export function isCardGone(updatedAt: number | null | undefined, now: number): boolean {
	return typeof updatedAt === "number" && updatedAt > 0 && now - updatedAt >= goneAfterMs();
}

/** Render a wall for a human line (`quota-walled` plus its shape). */
export function formatLaneWall(wall: LaneWall | null | undefined): string {
	if (!wall) return "";
	const reset = wall.resetAt === undefined ? "" : `, resets ${new Date(wall.resetAt).toISOString()}`;
	return `${wall.shapeId}${wall.assumed === true ? " (assumed)" : ""}${reset}`;
}

/** The card directory under a Muster state dir (`<musterStateDir>/lanes`). */
export function laneCardsDir(musterStateDir: string): string {
	return join(musterStateDir, "lanes");
}

// ─── The ledger backend (LC5) ────────────────────────────────────────────────
//
// One owner, two stores (LC-D2): the file above (`lanes/<laneId>.json`, today's
// store, untouched) or the ledger's `lane-card` record, whose body is the same
// `LaneCard`. The switch file decides on every call, so a long-lived process
// follows a flip without a restart. Nothing here changes files mode: the branch
// is taken only when `backend.json` names the ledger.

/** The same shape the record owner accepts; a card path is never built from anything else. */
const SAFE_LANE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

/** The owner's `CasStoreError` code set, so a caller can tell a stale card from an unreachable daemon. */
export class LaneCardStateError extends Error {
	readonly code: "missing" | "malformed" | "conflict" | "io";
	constructor(code: "missing" | "malformed" | "conflict" | "io", message: string) {
		super(message);
		this.code = code;
		this.name = "LaneCardStateError";
	}
}

/** The ledger keeps its revision beside the record, never inside it (LC-D3). */
type StoredLaneCard = LaneCard & { revision: number };

function validateStoredCard(raw: unknown): { ok: true; record: StoredLaneCard } | { ok: false; errors: string[] } {
	const card = raw as (Partial<LaneCard> & { revision?: unknown }) | null | undefined;
	if (card === null || card === undefined || typeof card !== "object" || typeof card.laneId !== "string" || card.laneId === "") {
		return { ok: false, errors: ["not a lane card"] };
	}
	return { ok: true, record: { ...(card as LaneCard), revision: typeof card.revision === "number" ? card.revision : 0 } };
}

/** The lane-card store on the ledger. One factory, so the id rule and the validation are stated once. */
function ledgerCardStore(musterStateDir: string): LedgerCasStore<StoredLaneCard> {
	return ledgerCasStore<StoredLaneCard>(LANE_CARD_STORE, ownerLedgerSocket(musterStateDir), {
		idPattern: SAFE_LANE_ID,
		idKind: "lane",
		noun: "lane card",
		validate: validateStoredCard,
		errorClass: LaneCardStateError,
	});
}

function withoutRevision(card: StoredLaneCard): LaneCard {
	const { revision: _revision, ...rest } = card;
	return rest;
}

/** Ensure the card directory exists (0700). */
export function ensureLaneCardsDir(musterStateDir: string): void {
	const dir = laneCardsDir(musterStateDir);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Write a lane card atomically (tmp + rename), so a reader never sees half a card. */
export function writeLaneCard(musterStateDir: string, card: LaneCard): void {
	if (backendState(musterStateDir).backend === "ledger") {
		writeLedgerCard(musterStateDir, card);
		return;
	}
	ensureLaneCardsDir(musterStateDir);
	const target = join(laneCardsDir(musterStateDir), `${card.laneId}.json`);
	const tmp = `${target}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(card, null, 2), { mode: 0o600 });
	renameSync(tmp, target);
}

/**
 * A card write on the ledger: one create-or-replace, whatever revision is stored,
 * so every heartbeat for a lane lands however many writers run at once (LC18).
 * The card's own shape is unchanged, so a reader sees the same `LaneCard` in both
 * backends.
 */
function writeLedgerCard(musterStateDir: string, card: LaneCard): void {
	ledgerCardStore(musterStateDir).put(card.laneId, card);
}

/**
 * Read one lane card. Returns undefined when missing, empty or unreadable: a
 * 0-byte or torn card is a stale leftover, never a card and never a crash.
 */
export function readLaneCard(musterStateDir: string, laneId: string): LaneCard | undefined {
	if (backendState(musterStateDir).backend === "ledger") {
		const stored = ledgerCardStore(musterStateDir).read(laneId);
		return stored === undefined ? undefined : withoutRevision(stored);
	}
	const file = join(laneCardsDir(musterStateDir), `${laneId}.json`);
	if (!existsSync(file)) return undefined;
	try {
		const raw = readFileSync(file, "utf8").trim();
		if (raw === "") return undefined;
		const parsed = JSON.parse(raw) as Partial<LaneCard> | null;
		if (parsed === null || typeof parsed !== "object" || typeof parsed.laneId !== "string" || parsed.laneId === "") return undefined;
		return parsed as LaneCard;
	} catch {
		return undefined;
	}
}

/**
 * Record one lane-level report on the card, without disturbing the heartbeat.
 *
 * Read-modify-write: the writer is the heartbeat, and a report filed between
 * two ticks is preserved by the next tick (see `preserveLaneReport`). Returns
 * false when the lane has no card, which is the honest answer for a lane the bus
 * cannot see.
 */
export function recordLaneReport(musterStateDir: string, laneId: string, mark: LaneReportMark): boolean | "spooled" {
	const at = mark.at ?? Date.now();
	const requestId = `report:${laneId}:${at}`;
	const backend = backendState(musterStateDir);
	if (backend.backend === "frozen") return spoolLaneReport(musterStateDir, laneId, mark, requestId);
	if (backend.backend === "ledger") {
		// One commit for the two records a report touches (LC5): the card's mark and
		// the record's phase land together or not at all. The lane's life record takes
		// the same report (WP1); a record that does not exist leaves only the card.
		try {
			return commitLedgerReport(musterStateDir, laneId, mark, requestId);
		} catch (error) {
			if (error instanceof MusterdUnreachable) return spoolLaneReport(musterStateDir, laneId, mark, requestId);
			throw error;
		}
	}
	// The lane's life record takes the same report, so there is one report path (WP1).
	// A record that cannot be written never turns a filed report into an error.
	try {
		recordReport(musterStateDir, laneId, mark);
	} catch {
		/* the card below stays the durable line */
	}
	const existing = readLaneCard(musterStateDir, laneId);
	if (existing === undefined) return false;
	writeLaneCard(musterStateDir, { ...existing, lastReport: mark });
	return true;
}

/** One spool file per report input; the request id is fixed by that input, so a repeated report writes once (DL6, §3.2). */
function spoolLaneReport(musterStateDir: string, laneId: string, mark: LaneReportMark, requestId: string): "spooled" {
	spoolWrite(musterStateDir, { method: "appendEvent", params: { owner: "report", laneId, mark, requestId } });
	return "spooled";
}

/**
 * The card's mark and the record's phase in one commit. A stale revision anywhere
 * refuses the whole commit and is retried from a fresh read (`CAS_ATTEMPTS`), the
 * same transition loop the seat and control owners run over a compare-and-set store.
 */
function commitLedgerReport(musterStateDir: string, laneId: string, mark: LaneReportMark, requestId: string): boolean {
	const store = ledgerCardStore(musterStateDir);
	for (let attempt = 0; ; attempt += 1) {
		const card = store.read(laneId);
		if (card === undefined) return false;
		const record = readLaneRecordWithRevision(musterStateDir, laneId);
		const cas: CasCommitWrite[] = [
			{ store: LANE_CARD_STORE, id: laneId, expectedRevision: card.revision, record: { ...withoutRevision(card), lastReport: mark } },
		];
		if (record !== undefined) {
			cas.push({ store: LANE_RECORD_STORE, id: laneId, expectedRevision: record.revision, record: recordWithReport(record.record, mark, mark.at ?? Date.now()) });
		}
		const result = ledgerCommit(ownerLedgerSocket(musterStateDir), { requestId, cas });
		if (result.ok) return true;
		// A stale revision refuses the whole commit; a fresh read and a retry is the
		// same transition loop the seat and control owners run.
		if (result.code === "conflict" && attempt < CAS_ATTEMPTS - 1) continue;
		throw new LaneCardStateError("conflict", `Lane card ${laneId} changed while a report was committed`);
	}
}

/** Is this JSON value a control outcome? Same rule as a report mark. */
export function isLaneControlOutcome(value: unknown): value is LaneControlOutcome {
	const outcome = value as Partial<LaneControlOutcome> | null | undefined;
	return (
		outcome !== null &&
		outcome !== undefined &&
		typeof outcome.operation === "string" &&
		typeof outcome.ok === "boolean" &&
		typeof outcome.at === "number" &&
		Number.isFinite(outcome.at)
	);
}

/** Record what the lane made of one control request, on its own card. */
export function recordLaneControlOutcome(musterStateDir: string, laneId: string, outcome: LaneControlOutcome): boolean {
	const existing = readLaneCard(musterStateDir, laneId);
	if (existing === undefined) return false;
	writeLaneCard(musterStateDir, { ...existing, lastControl: outcome });
	return true;
}

/**
 * The newer of two report marks, for a writer that must not drop one it did not
 * make (the heartbeat rebuilds the card from its own state).
 */
/**
 * Is this JSON value a lane report mark? Every view reads the card from disk, so
 * a torn or foreign field must be rejected here rather than rendered as a report.
 */
export function isLaneReportMark(value: unknown): value is LaneReportMark {
	const mark = value as Partial<LaneReportMark> | null | undefined;
	return (
		mark !== null &&
		mark !== undefined &&
		typeof mark.summary === "string" &&
		typeof mark.kind === "string" &&
		typeof mark.at === "number" &&
		Number.isFinite(mark.at) &&
		(mark.branch === undefined || typeof mark.branch === "string") &&
		(mark.sha === undefined || typeof mark.sha === "string") &&
		(mark.base === undefined || typeof mark.base === "string")
	);
}

export function newerLaneReport(a: LaneReportMark | undefined, b: LaneReportMark | undefined): LaneReportMark | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return (b.at ?? 0) >= (a.at ?? 0) ? b : a;
}

/**
 * A clean stop removes the card.
 *
 * The card is the heartbeat of a *live* lane, so a stopped lane must not leave
 * one behind: a leftover card is what misled the directory (a 0-byte
 * `oc-bus1.json` listed as if the lane were there, 2026-10-08). The lane itself
 * stays visible — the directory derives it from `pi-lanes.json` and the session
 * file, and a silent one reads as `gone` — and the next launch rewrites a card.
 * A crash writes nothing at all; a reader expires whatever is left by age.
 */
export function removeLaneCard(musterStateDir: string, laneId: string): void {
	if (backendState(musterStateDir).backend === "ledger") {
		// Removing a card empties its record rather than dropping the document: the
		// ledger's `casList` skips an empty record, and `readLaneCard` answers absent,
		// exactly as a removed file does.
		const store = ledgerCardStore(musterStateDir);
		for (let attempt = 0; ; attempt += 1) {
			const current = store.read(laneId);
			if (current === undefined) return;
			try {
				const result = ledgerCommit(ownerLedgerSocket(musterStateDir), {
					requestId: `remove:${LANE_CARD_STORE}:${laneId}:${current.revision}`,
					cas: [{ store: LANE_CARD_STORE, id: laneId, expectedRevision: current.revision, record: null }],
				});
				if (result.ok) return;
				if (attempt >= CAS_ATTEMPTS - 1) return;
			} catch (error) {
				if (error instanceof MusterdUnreachable || (error instanceof LaneCardStateError && error.code === "conflict")) {
					if (attempt >= CAS_ATTEMPTS - 1) return;
					continue;
				}
				throw error;
			}
		}
	}
	const file = join(laneCardsDir(musterStateDir), `${laneId}.json`);
	try {
		rmSync(file, { force: true });
	} catch {
		/* an unremovable card is left for the age check rather than crashed on */
	}
}

/**
 * Every card of the store (LC5), through the backend the switch names: the files of
 * `lanes/` in files mode (unreadable, torn and 0-byte files skipped, as the
 * directory already did), the `lane-card` records on the ledger. One owner for the
 * enumeration, so a reader never lists a store's folder itself.
 */
export function listLaneCards(musterStateDir: string): { laneId: string; card: LaneCard }[] {
	if (backendState(musterStateDir).backend === "ledger") {
		const cards: { laneId: string; card: LaneCard }[] = [];
		for (const row of ledgerCardStore(musterStateDir).list()) {
			try {
				cards.push({ laneId: row.id, card: withoutRevision(row.record) });
			} catch {
				/* a malformed record is skipped, never a crash */
			}
		}
		return cards;
	}
	const dir = laneCardsDir(musterStateDir);
	if (!existsSync(dir)) return [];
	const cards: { laneId: string; card: LaneCard }[] = [];
	for (const entry of readdirSync(dir)) {
		if (!entry.endsWith(".json")) continue;
		const laneId = entry.slice(0, -".json".length);
		const card = readLaneCard(musterStateDir, laneId);
		if (card !== undefined) cards.push({ laneId, card });
	}
	return cards;
}
