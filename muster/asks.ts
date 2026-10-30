/**
 * the operator's queue — the durable, append-only place for everything waiting on
 * the operator (AK1 of `plans/muster-autonomy/operator-queue-proposal-2026-10-16.md`,
 * the architect's "AK1. Store and CLI" section).
 *
 * One store, one file: `<musterStateDir()>/asks/events.jsonl`, append-only and
 * never rewritten. The current state of an ask is the fold of its events, so a
 * crash can only ever remove the tail of the file, never a status. `ask_<uuid>`
 * ids (the card store's own id shape, `decisions.ts`) make the append lock-free:
 * two writers cannot name the same ask.
 *
 * This module is the only reader and writer of that file, and it owns the ask's
 * status vocabulary, its event vocabulary and its writer vocabulary. A programme
 * decision card stays the one place its answer is recorded: an ask whose `link`
 * is `card:<programmeId>/<decisionId>` *defers* to it — the fold reads the card's
 * state and `answerAsk` refuses an answer of its own.
 *
 * No transcript text ever becomes an answer here, and an ask to the operator exists
 * when it is in this file: writers raise the ask first and cite its id or code in
 * what they send him.
 *
 * Beside the events file this module owns the sweeper's review list (AK4,
 * `review.jsonl`) and the deterministic file diff that feeds it: the list rows
 * that match no open ask, and the open asks whose own list line is struck or
 * gone. The sweeper records findings and never changes an ask's status.
 */

import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	DEFAULT_PENDING_ACTIONS,
	parseDesignInbox,
	parsePendingActions,
	parseOperatorList,
	sourceTokensOf,
} from "./bin/asks-import.mts";
import {
	REPO_SOURCE_PATHS,
	parseDesignSnapshot,
	parseOrchestratorSnapshot,
	textMatch,
} from "./asks-import-lib.ts";
import { listInboxMessages } from "./lib/agent-inbox.ts";
import { isOwnAncestor, ownClaudeLane } from "./lib/claude-lane-card.ts";
import { laneRegistryPath, readLaneRegistryRows } from "./lib/lane-directory.ts";
import { DECISION_KINDS, type DecisionKind } from "../core/decision-types.ts";
// The contract table's ask codes: the only codes the `tick` and `doctor` writers may use (spec §4, OL0b).
import { CONTRACT_ASK_CODES } from "./health/contracts.ts";
import { musterStateDir, piAgentDir } from "./binding.ts";
import {
	fileProgrammeDecisionStore,
	getDecision,
	type DecisionAnswerRef,
	type DecisionStatus,
	type ProgrammeDecisionContext,
} from "./decisions.ts";
import { readBackend, writeBackend } from "./ledger/backend.ts";
import { requestSync } from "./ledger/client-sync.ts";
import { ownerLedgerSocket } from "./ledger/stores.ts";
import { resolveSeatWriter, type SeatContext } from "./seats.ts";
import { appendFsyncedLine } from "./send.ts";

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/** The event file, one JSON object per line. */
export const ASK_EVENTS_FILE = "events.jsonl";
/** The event line's own schema version, so a later reader can migrate. */
export const ASK_EVENT_VERSION = 1;

/**
 * The ask's kind vocabulary. The decision card's kinds are the owner
 * (`DECISION_KINDS`, `decisions.ts`), plus `operator-action` for a step that needs
 * the operator's hands or devices (P4-D2).
 */
export type AskKind = DecisionKind | "operator-action";

export const ASK_EXTRA_KINDS: readonly AskKind[] = ["operator-action"];
export const ASK_KINDS: readonly AskKind[] = [...DECISION_KINDS, ...ASK_EXTRA_KINDS];

/**
 * The kinds answered only from the operator's own words: whoever records the ruling
 * that is not him must name the words and the relay that carried them.
 */
export const OPERATOR_ONLY_KINDS: readonly AskKind[] = ["authorization", "credential", "human-login", "operator-action"];

/**
 * The steps only the operator can do himself: the page groups them into one "Next sitting" card (D16),
 * and his list shows them in its "Only you can do" section. The rest are decisions. The composer
 * marks a ticket from this list, so the page never decides kinds.
 */
export const SITTING_KINDS: readonly AskKind[] = ["operator-action", "human-login", "credential"];

/**
 * What an ask is about, in the closed list VR24-43 (3) gives (D16). The raiser sets it, and only an
 * ask that carries one can count toward a standing rule. The list is closed on purpose: a free-text
 * rule would let two raisers spell one rule two ways.
 */
export const ASK_RULES = ["spend", "pay", "sign", "publish", "delete", "outside", "production-data", "device", "ap5", "product"] as const;
export type AskRule = (typeof ASK_RULES)[number];

function isAskRule(value: unknown): value is AskRule {
	return typeof value === "string" && (ASK_RULES as readonly string[]).includes(value);
}

/**
 * The kinds the operator or the architect rules on: the architect writes the decision
 * row, and the orchestrator passes product questions on instead of answering
 * them (methodology, Authority 2 and 3).
 */
export const PRODUCT_KINDS: readonly AskKind[] = ["product-decision", "review"];

/** `withdrawn` is the one status beyond the operator's four (P4-D2). */
export type AskStatus = "open" | "awaiting-operator" | "decided" | "done" | "withdrawn";
export const ASK_STATUSES: readonly AskStatus[] = ["open", "awaiting-operator", "decided", "done", "withdrawn"];
/** A status nothing moves an ask out of, and which retires its code. */
export const CLOSED_ASK_STATUSES: readonly AskStatus[] = ["done", "withdrawn"];

/**
 * Every ask event's writer (`by`). `operator-page` is the command center's page (VR24-30, CC1): it
 * records the operator's typed words behind his tailnet login, and is never a process identity, so
 * `resolveAskWriter` does not return it. `desk` is the tick's standing-rule pass (D23): it raises
 * and prepares a draft in-process, never records a ruling, and `resolveAskWriter` does not return
 * it either. `messaging` is the messaging agent's approval pass (MG6, G7): it raises and prepares the
 * ask for a draft, withdraws it when the chat moves on, and finishes it with the send's evidence. It
 * records no ruling, and `resolveAskWriter` does not return it. `meter-browser` is UB0's browser
 * reader on this PC (U-1): a systemd job, so without its own writer its login ask would be written as
 * `operator-shell` and the queue would say the operator raised it. It raises one `human-login` ask for a site
 * that wants a login or a human check, and records no ruling. `receipt-reader` is UB0's receipt reader
 * on this PC (B-2): the same systemd kind of job, and it too would otherwise write its sign-in ask as
 * `operator-shell`. It raises one `human-login` ask for a mailbox whose sign-in has lapsed, and records no
 * ruling. An older reader counts an event by
 * `desk`, `messaging`, `meter-browser` or `receipt-reader` as unreadable, so the gateway restarts after
 * the change merges.
 *
 * `chat-session` is a harness session talking to the operator that holds no seat and is not a lane
 * (VR24-230, `resolveAskWriter`): the sweep files an agent's question to the operator with the transcript it
 * read as its source, and this is the session that can close it once his message in that thread
 * completes or answers it. It closes only the ask its own thread raised, records its own session id
 * on the event, raises nothing, records no ruling, and passes every other ask to the orchestrator.
 * An older reader counts an event by `chat-session` as unreadable, so the gateway restarts after the
 * change merges.
 *
 * `tick` and `doctor` are the two system writers (spec §4, OL0b): the tick raises and withdraws the
 * ask for a red contract's repair, and the doctor raises the two the tick cannot report itself. They
 * may raise, prepare and withdraw only the asks their contract table declares — the code must be one
 * of `CONTRACT_ASK_CODES` — and they record no ruling. An older reader counts an event by `tick` or
 * `doctor` as unreadable, so the gateway restarts after the change merges.
 */
export type AskWriter = "operator-shell" | "architect" | "orchestrator" | "grokbot" | "operator-page" | "desk" | "messaging" | "meter-browser" | "receipt-reader" | "chat-session" | "tick" | "doctor";
export const ASK_WRITERS: readonly AskWriter[] = ["operator-shell", "architect", "orchestrator", "grokbot", "operator-page", "desk", "messaging", "meter-browser", "receipt-reader", "chat-session", "tick", "doctor"];

/**
 * The system writers (spec §4, OL0b): the tick's repair asks and the doctor's own two contracts. They
 * raise and withdraw their own contract asks and nothing else, so a system job can never write for the operator.
 */
export type ContractAskWriter = "tick" | "doctor";
export const CONTRACT_ASK_WRITERS: readonly ContractAskWriter[] = ["tick", "doctor"];

/** The relay that carried the operator's words to whoever recorded them. `command-center` is set only by the page's gateway; the CLI's `--relay` does not accept it. */
export type AskRelay = { via: "architect-session" | "grokbot-gateway" | "command-center"; ref: string; at: string };

/** The programme card this ask defers to, parsed from `link`. */
export type AskCardLink = { programmeId: string; decisionId: string };

/** What closed an ask, in one of the three shapes a reader can follow. */
export type AskEvidence =
	| { commit: string; repo: string }
	| { row: string; file: string; line: number }
	| { log: string; file: string; line: number };

/** The card's state where the queue reads it, so the two records never disagree. */
export type AskCardState = {
	status: DecisionStatus;
	appliedOptionId: string | null;
	appliedAt: string | null;
	answerRef: DecisionAnswerRef | null;
};

// ─── Events ──────────────────────────────────────────────────────────────────

export type AskEventType = "raised" | "prepared" | "answered" | "done" | "withdrawn" | "noted";
export const ASK_EVENT_TYPES: readonly AskEventType[] = ["raised", "prepared", "answered", "done", "withdrawn", "noted"];

/**
 * The event every ask event carries. `session` is the thread a `chat-session` event was written from
 * (`sweep:<harness>:<session>@…` names it back), and no other writer sets it.
 */
type AskEventBase = { v: number; at: string; id: string; type: AskEventType; by: AskWriter; session?: string };

export type AskRaisedEvent = AskEventBase & {
	type: "raised";
	code?: string;
	kind: AskKind;
	question: string;
	owner?: string;
	source?: string;
	/** What the ask is about; `card:<programmeId>/<decisionId>` links a decision card. */
	link?: string;
	blocks?: string[];
	/** What the ask is about (`ASK_RULES`); absent on an ask the raiser did not classify. */
	rule?: AskRule;
};
/** The options and the recommendation, as `prepare` adds them. */
export type AskPreparedEvent = AskEventBase & { type: "prepared"; options: string[]; recommendation: string };
/** A tap on one option of a prepared ask: the option and the `askVersion` the page showed (D15). */
export type AskTap = { option: string; version: string };

export type AskAnsweredEvent = AskEventBase & {
	type: "answered";
	ruling: string;
	/** the operator's own words, when someone else recorded them. */
	words?: string;
	relay?: AskRelay;
	/** Set only by a tap answer (`answerAsk` with `tap`); such an event carries no `words`. */
	tap?: AskTap;
	/** The decision row the ruling is recorded as (`file:line`). */
	row?: string;
};
export type AskDoneEvent = AskEventBase & { type: "done"; evidence: AskEvidence };
export type AskWithdrawnEvent = AskEventBase & { type: "withdrawn"; reason: string };
/** A pointer or a comment: it never changes the ask's status. */
export type AskNotedEvent = AskEventBase & { type: "noted"; text: string };

export type AskEvent =
	| AskRaisedEvent
	| AskPreparedEvent
	| AskAnsweredEvent
	| AskDoneEvent
	| AskWithdrawnEvent
	| AskNotedEvent;

// ─── The folded ask ──────────────────────────────────────────────────────────

export type Ask = {
	id: string;
	code: string | undefined;
	kind: AskKind;
	question: string;
	owner: string | undefined;
	/** The writer that raised it: the `raised` event's `by`. */
	raisedBy: string;
	raisedAt: string;
	updatedAt: string;
	source: string | undefined;
	link: string | undefined;
	/** Parsed from `link`; the ask then defers to this card. */
	card: AskCardLink | undefined;
	/** Lanes or task ids waiting on the answer. */
	blocks: string[];
	/** What the ask is about (`ASK_RULES`); absent when the raiser did not say. */
	rule?: AskRule;
	status: AskStatus;
	options: string[];
	recommendation: string | undefined;
	ruling: string | undefined;
	/** Who answered: the `answered` event's `by`, or the card's actor. */
	answeredBy: string | undefined;
	answeredAt: string | undefined;
	/**
	 * When a `done` or `withdrawn` event closed it: the event's own time, and absent while the ask is
	 * live or settled without closing. The sweep reads it to tell a need raised again from one the
	 * queue has already settled (F2ASKS, VR24-166).
	 */
	closedAt: string | undefined;
	words: string | undefined;
	relay: AskRelay | undefined;
	/** The option the operator tapped, when the ruling is a tap answer (D15); absent for an answer in words. */
	tap?: AskTap;
	row: string | undefined;
	/** True when the status and ruling came from the linked card, not from an asks event. */
	answeredByCard: boolean;
	/** The linked card's read state; `unreadable` when the card could not be read. */
	cardState: "open" | "applied" | "unreadable" | undefined;
	evidence: AskEvidence | undefined;
	withdrawnReason: string | undefined;
	notes: string[];
};

export type AskQueue = {
	asks: Ask[];
	/** 1 when the file does not end on a newline (a torn write), else 0. */
	partialLastLine: number;
	/** Complete lines that are not a usable ask event. */
	unreadableLines: number;
	/** Codes carried by more than one unclosed ask: list both, act on neither. */
	duplicateCodes: string[];
	path: string;
};

/** How the queue reads a linked card; the caller supplies the card store. */
export type AskCardReader = (card: AskCardLink) => AskCardState | undefined;

export type ReadAsksOptions = { cardState?: AskCardReader };

// ─── Errors ──────────────────────────────────────────────────────────────────

/** Typed ask-store failure, shaped like `ProgrammeDecisionStateError`. */
export class AskStateError extends Error {
	// No parameter property: this file is loaded by plain node (strip-only) in the lanes.
	readonly code: "missing" | "invalid" | "conflict" | "refused" | "ambiguous" | "io";
	constructor(code: AskStateError["code"], message: string) {
		super(message);
		this.code = code;
		this.name = "AskStateError";
	}
}

const ID_PATTERN = /^ask_[0-9a-f-]{36}$/;
/** Human codes from the live lists: `VD4`, `VH10`, `DQ20`, `H1`, `D5`. */
const CODE_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,23}$/;
const PROGRAMME_ID_PATTERN = /^agp_[0-9a-f]{12}$/;
const DECISION_ID_PATTERN = /^dec_[0-9a-f-]{36}$/;
/** The link that makes an ask defer to a programme decision card. */
export const CARD_LINK_PREFIX = "card:";

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

// ─── The store ───────────────────────────────────────────────────────────────

/** The asks directory under a Muster state dir: `<stateDir>/asks`. */
export function asksDir(musterStateDir: string): string {
	return join(musterStateDir, "asks");
}

/** The one event file: `<stateDir>/asks/events.jsonl`. */
export function asksEventsPath(musterStateDir: string): string {
	return join(asksDir(musterStateDir), ASK_EVENTS_FILE);
}

/**
 * Append one event (file mode 0600, fsynced, directory 0700), through the one
 * append body the send log also uses (`appendFsyncedLine`, `send.ts`).
 *
 * The append carries its own leading newline when the file does not end on one:
 * a write torn by a crash stays its own unreadable line instead of swallowing
 * the next event.
 *
 * In ledger mode the event joins its ask's `muster.ask` document (LD37) through
 * `askAppend` (LC6). One event is one commit, and it posts no `muster.event`.
 */
export function appendAskEvent(musterStateDir: string, event: AskEvent): void {
	if (writeBackend(musterStateDir) === "ledger") {
		requestSync<{ ok: true; count: number }>(ownerLedgerSocket(musterStateDir), "askAppend", {
			askId: event.id,
			event,
			requestId: askAppendRequestId(event),
		});
		return;
	}
	const repair = endsWithoutNewline(asksEventsPath(musterStateDir)) ? "\n" : "";
	appendFsyncedLine(asksDir(musterStateDir), ASK_EVENTS_FILE, `${repair}${JSON.stringify(event)}\n`);
}

/**
 * One event's idempotency key. An `AskEvent` carries no id of its own, so its
 * identity is the ask it belongs to plus the type and the moment the fold reads
 * together: replaying the same event is the same write, never a second line.
 */
function askAppendRequestId(event: AskEvent): string {
	return `ask:${event.id}:${event.type}:${event.at}`;
}

/** Does a non-empty file end without a newline (the torn tail of a crash)? */
function endsWithoutNewline(path: string): boolean {
	let size: number;
	try {
		size = statSync(path).size;
	} catch {
		return false;
	}
	if (size === 0) return false;
	const fd = openSync(path, "r");
	try {
		const byte = Buffer.alloc(1);
		const read = readSync(fd, byte, 0, 1, size - 1);
		return read === 1 && byte[0] !== 0x0a;
	} catch {
		return false;
	} finally {
		closeSync(fd);
	}
}

function askEventBase(by: AskWriter, id: string, now: string, session?: string): AskEventBase {
	return { v: ASK_EVENT_VERSION, at: now, id, type: "raised", by, ...(session !== undefined ? { session } : {}) };
}

// ─── The card link ───────────────────────────────────────────────────────────

/** `card:<agp_…>/<dec_…>`: the one spelling of a card link. */
export function cardLink(programmeId: string, decisionId: string): string {
	return `${CARD_LINK_PREFIX}${programmeId}/${decisionId}`;
}

/** The card a link names, or `undefined` for any other link. */
export function parseCardLink(link: string | undefined): AskCardLink | undefined {
	if (link === undefined || !link.startsWith(CARD_LINK_PREFIX)) return undefined;
	const rest = link.slice(CARD_LINK_PREFIX.length);
	const at = rest.indexOf("/");
	if (at < 1) return undefined;
	const programmeId = rest.slice(0, at);
	const decisionId = rest.slice(at + 1);
	return PROGRAMME_ID_PATTERN.test(programmeId) && DECISION_ID_PATTERN.test(decisionId)
		? { programmeId, decisionId }
		: undefined;
}

/**
 * The reader `readAsks` uses for a linked card: the card owner's own fresh read
 * (`getDecision`). A missing or malformed card is `unreadable`, never an answer
 * and never a crash.
 */
export function programmeCardReader(context?: ProgrammeDecisionContext): AskCardReader {
	return (card) => {
		try {
			const decision = getDecision(card.programmeId, card.decisionId, context);
			return {
				status: decision.status,
				appliedOptionId: decision.appliedOptionId,
				appliedAt: decision.appliedAt,
				answerRef: decision.answerRef,
			};
		} catch {
			return undefined;
		}
	};
}

// ─── Evidence ────────────────────────────────────────────────────────────────

/** `commit:<sha>@<repo>`, `row:<row>@<file>:<line>` or `log:<file>:<line>`. */
export function parseEvidence(text: string): AskEvidence | undefined {
	const trimmed = text.trim();
	const colon = trimmed.indexOf(":");
	if (colon < 1) return undefined;
	const kind = trimmed.slice(0, colon);
	const rest = trimmed.slice(colon + 1);
	if (kind === "commit") {
		const at = rest.lastIndexOf("@");
		if (at < 1) return undefined;
		const commit = rest.slice(0, at).trim();
		const repo = rest.slice(at + 1).trim();
		return nonEmpty(commit) && nonEmpty(repo) ? { commit, repo } : undefined;
	}
	if (kind === "row") {
		const at = rest.lastIndexOf("@");
		if (at < 1) return undefined;
		const row = rest.slice(0, at).trim();
		const place = parsePlace(rest.slice(at + 1));
		return nonEmpty(row) && place !== undefined ? { row, ...place } : undefined;
	}
	if (kind === "log") {
		const place = parsePlace(rest);
		return place !== undefined ? { log: place.file, file: place.file, line: place.line } : undefined;
	}
	return undefined;
}

function parsePlace(text: string): { file: string; line: number } | undefined {
	const at = text.lastIndexOf(":");
	if (at < 1) return undefined;
	const file = text.slice(0, at).trim();
	const line = Number(text.slice(at + 1).trim());
	return nonEmpty(file) && Number.isInteger(line) && line > 0 ? { file, line } : undefined;
}

/** The one spelling of evidence, the one `parseEvidence` reads. */
export function formatEvidence(evidence: AskEvidence): string {
	if ("commit" in evidence) return `commit:${evidence.commit}@${evidence.repo}`;
	if ("row" in evidence) return `row:${evidence.row}@${evidence.file}:${evidence.line}`;
	return `log:${evidence.file}:${evidence.line}`;
}

/** Is this a usable evidence record? */
export function isAskEvidence(value: unknown): value is AskEvidence {
	if (value === null || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (typeof record["commit"] === "string") return nonEmpty(record["repo"]);
	if (typeof record["row"] === "string") return nonEmpty(record["file"]) && Number.isInteger(record["line"]);
	if (typeof record["log"] === "string") return Number.isInteger(record["line"]);
	return false;
}

// ─── Who writes ──────────────────────────────────────────────────────────────

export type AskWriterResolution = { writer: AskWriter; session?: string } | { error: string };

/** the operator's own session is listed as `operator:<harness>:<short id>` (LD2); every other lane id is a lane's. */
const OPERATOR_LANE_PREFIX = "operator:";

/** The answer `resolveSeatWriter` gives for "this session holds no seat", told apart from its refusals. */
const NO_SEAT = "\u0000no-seat";

/**
 * The harness session this process talks to the operator in: Pi exports `PI_SESSION_ID`, Claude Code
 * `CLAUDE_CODE_SESSION_ID`. A process that runs no session (the operator's shell, a service) has none.
 *
 * A Claude session launched from inside a Pi session carries both, the parent's `PI_SESSION_ID` and its
 * own `CLAUDE_CODE_SESSION_ID`. The harness the process runs in decides: Claude's id inside a real Claude
 * session, Pi's otherwise, because the inherited parent id is the one the own-thread rule must not accept.
 */
export function chatSessionId(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const pi = (env["PI_SESSION_ID"] ?? "").trim();
	const claude = (env["CLAUDE_CODE_SESSION_ID"] ?? "").trim();
	if (claude !== "" && insideClaudeSession(env)) return claude;
	return pi !== "" ? pi : claude !== "" ? claude : undefined;
}

/**
 * The session a sweep source names: `sweep:<harness>:<session>@<time>`, the transcript the sweep read
 * it from (`asks-scan.ts`). This is the one reading of that source, so the session that closes an ask
 * and the routine that raised it agree on which thread it belongs to.
 */
export function sourceSession(source: string | undefined): string | undefined {
	if (source === undefined || !source.startsWith(SWEEP_SOURCE_PREFIX)) return undefined;
	const rest = source.slice(SWEEP_SOURCE_PREFIX.length);
	const at = rest.lastIndexOf("@");
	const body = at < 0 ? rest : rest.slice(0, at);
	const colon = body.indexOf(":");
	const session = colon < 0 ? "" : body.slice(colon + 1).trim();
	return session === "" ? undefined : session;
}

/**
 * Does this process run inside a real Claude session? `CLAUDE_PID` must name a process of this one's own
 * tree: a tmux server started from a Claude tool inherits the variables, and every session after it would
 * otherwise read as Claude's (VR24-109).
 */
function insideClaudeSession(env: NodeJS.ProcessEnv): boolean {
	const pid = Number(env["CLAUDE_PID"]);
	return Number.isInteger(pid) && pid > 1 && isOwnAncestor(pid);
}

/**
 * Is this agent session a lane? A lane asks the orchestrator (methodology Authority 4) and writes
 * nothing in the queue, as it did before VR24-230.
 *
 * The lane id the launcher gave the session decides first, except inside a real Claude session:
 * `claude --bg` hands the job to a daemon that spawns every session from its own environment, so
 * `CONCORD_AGENT_ID` there names whichever lane launched first, not this one — the check `sessionProof`
 * makes in `seats.ts` (VR24-109). A `operator:` id is the operator's own session, never a lane.
 *
 * Otherwise the launcher's registry decides by the session id: the test `asks-scan.ts` skips a lane by.
 * The registry is read through the backend switch, so in ledger mode the row comes from the
 * `lane-registry` store and a lane launched after the flip is seen.
 */
export function isLaneSession(env: NodeJS.ProcessEnv, agentId: string | undefined): boolean {
	if (ownClaudeLane(env) !== undefined) return true;
	if (!insideClaudeSession(env)) {
		const id = (agentId ?? "").trim() || (env["CONCORD_AGENT_ID"] ?? "").trim();
		if (id !== "") return !id.startsWith(OPERATOR_LANE_PREFIX);
	}
	const session = chatSessionId(env);
	if (session === undefined) return false;
	const state = musterStateDir();
	for (const row of readLaneRegistryRows(laneRegistryPath(state), state).values()) {
		if (row.sessionId === session) return true;
	}
	return false;
}

/**
 * The writer of an ask event, from the process it runs in: a process that is not
 * an agent session is the operator's own shell; an agent session must hold the
 * architect or orchestrator seat, and a lane is refused because lanes ask the
 * orchestrator (methodology, Authority 4). A harness session talking to the operator
 * that holds no seat and is not a lane is `chat-session` (VR24-230); the
 * resolution then also carries the session id, which the write records on the
 * event and the own-thread rule compares.
 *
 * A valid seat credential (`MUSTER_SEAT` with the holder's current `MUSTER_SEAT_TOKEN`) decides
 * first: a seat session can still carry a lane id in `CONCORD_AGENT_ID` from its launcher, and that
 * id never vetoes the credential. Without a valid credential the name resolves as before, so an id
 * from the env alone gains nothing and a stale or forged token is refused.
 */
/**
 * The refusal a session that is no seat reads, and the desk verb quotes: one wording for one rule.
 */
export function notASeatRefusal(named: string): string {
	return `${named === "" ? "this session" : named} is not a seat: lanes ask the orchestrator (methodology Authority 4), and the queue is written by the operator's shell, the architect or the orchestrator`;
}

export function resolveAskWriter(
	env: NodeJS.ProcessEnv,
	agentId: string | undefined,
	context?: SeatContext,
): AskWriterResolution {
	let named = "";
	const seat = resolveSeatWriter(env, agentId, context, (name) => {
		named = name;
		return NO_SEAT;
	});
	if ("writer" in seat) return seat;
	// A seat that exists and refuses this session (a stale or forged token) keeps its refusal.
	if (seat.error !== NO_SEAT) return seat;
	if (isLaneSession(env, agentId)) return { error: notASeatRefusal(named) };
	const session = chatSessionId(env);
	return session === undefined ? { error: notASeatRefusal(named) } : { writer: "chat-session", session };
}

// ─── The fold ────────────────────────────────────────────────────────────────

function isAskEvent(value: unknown): value is AskEvent {
	if (value === null || typeof value !== "object") return false;
	const event = value as Partial<AskEvent> & Record<string, unknown>;
	if (event["v"] !== ASK_EVENT_VERSION) return false;
	if (typeof event["type"] !== "string" || !(ASK_EVENT_TYPES as readonly string[]).includes(event["type"])) return false;
	if (!(ASK_WRITERS as readonly string[]).includes(String(event["by"]))) return false;
	return nonEmpty(event["id"]) && nonEmpty(event["at"]);
}

function isAskTap(value: unknown): value is AskTap {
	if (value === null || typeof value !== "object") return false;
	const tap = value as Record<string, unknown>;
	return nonEmpty(tap["option"]) && nonEmpty(tap["version"]);
}

function askFromRaised(raised: AskRaisedEvent): Ask {
	return {
		id: raised.id,
		code: nonEmpty(raised.code) ? raised.code : undefined,
		kind: raised.kind,
		question: raised.question,
		owner: nonEmpty(raised.owner) ? raised.owner : undefined,
		raisedBy: raised.by,
		raisedAt: raised.at,
		updatedAt: raised.at,
		source: nonEmpty(raised.source) ? raised.source : undefined,
		link: nonEmpty(raised.link) ? raised.link : undefined,
		card: parseCardLink(raised.link),
		blocks: [...(raised.blocks ?? [])],
		...(isAskRule(raised.rule) ? { rule: raised.rule } : {}),
		status: "open",
		options: [],
		recommendation: undefined,
		ruling: undefined,
		answeredBy: undefined,
		answeredAt: undefined,
		closedAt: undefined,
		words: undefined,
		relay: undefined,
		row: undefined,
		answeredByCard: false,
		cardState: undefined,
		evidence: undefined,
		withdrawnReason: undefined,
		notes: [],
	};
}

function applyAskEvent(ask: Ask, event: AskEvent): void {
	ask.updatedAt = event.at;
	switch (event.type) {
		case "raised":
			return;
		case "prepared":
			ask.options = [...event.options];
			ask.recommendation = event.recommendation;
			ask.status = "awaiting-operator";
			return;
		case "answered":
			ask.answeredBy = event.by;
			ask.ruling = event.ruling;
			ask.answeredAt = event.at;
			ask.words = event.words;
			ask.relay = event.relay;
			if (isAskTap(event.tap)) ask.tap = event.tap;
			else delete ask.tap;
			ask.row = event.row;
			ask.answeredByCard = false;
			ask.status = "decided";
			return;
		case "done":
			ask.evidence = event.evidence;
			ask.status = "done";
			ask.closedAt = event.at;
			return;
		case "withdrawn":
			ask.withdrawnReason = event.reason;
			ask.status = "withdrawn";
			ask.closedAt = event.at;
			return;
		case "noted":
			ask.notes.push(event.text);
			return;
	}
}

/**
 * Read the queue and fold it into the current state. It never throws on store
 * content.
 *
 * Files mode reads the one event file. Ledger mode (LC6, LD37) reads `asksAll`,
 * each ask's own document in append order; the fold below is the file's,
 * unchanged, so both backends give the same queue for the same events. A
 * document store has no torn tail, so `partialLastLine` is 0 there.
 */
export function readAsks(musterStateDir: string, options: ReadAsksOptions = {}): AskQueue {
	const path = asksEventsPath(musterStateDir);
	const byId = new Map<string, Ask>();
	let unreadableLines = 0;
	let partialLastLine = 0;

	const use = (event: AskEvent): boolean => {
		if (event.type === "raised") {
			byId.set(event.id, askFromRaised(event));
			return true;
		}
		const ask = byId.get(event.id);
		if (ask === undefined) return false;
		applyAskEvent(ask, event);
		return true;
	};

	if (readBackend(musterStateDir) === "ledger") {
		const docs = requestSync<{ askId: string; events: unknown[] }[]>(ownerLedgerSocket(musterStateDir), "asksAll", {});
		for (const doc of docs) {
			for (const rawEvent of doc.events) {
				if (!isAskEvent(rawEvent) || !use(rawEvent)) unreadableLines += 1;
			}
		}
	} else {
		let raw = "";
		try {
			raw = readFileSync(path, "utf8");
		} catch {
			raw = "";
		}
		const lines = raw.split("\n");
		// Content after the last newline: a torn write (unusable), or a complete line whose
		// newline was lost (usable, and still counted: the next append repairs it).
		const trailing = lines.pop() ?? "";
		if (trailing.trim() !== "") {
			partialLastLine = 1;
			try {
				const parsed: unknown = JSON.parse(trailing);
				if (isAskEvent(parsed)) use(parsed);
			} catch {
				// The torn write itself: counted by `partialLastLine`, not again below.
			}
		}
		for (const line of lines) {
			if (line.trim() === "") continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				unreadableLines += 1;
				continue;
			}
			if (!isAskEvent(parsed) || !use(parsed)) unreadableLines += 1;
		}
	}

	// Oldest first, and inside one millisecond the journal's own append order: the sort is stable and
	// `byId` keeps insertion order, so two raises in the same millisecond never swap places by id.
	const asks = [...byId.values()].sort((left, right) => left.raisedAt.localeCompare(right.raisedAt));
	// The card keeps the one answer. An ask that links one folds the card's state
	// and refuses an answer of its own, so the two records never close differently.
	if (options.cardState !== undefined) {
		for (const ask of asks) {
			if (ask.card === undefined) continue;
			const state = options.cardState(ask.card);
			if (state === undefined) {
				ask.cardState = "unreadable";
				continue;
			}
			ask.cardState = state.status === "applied" ? "applied" : "open";
			const terminal = CLOSED_ASK_STATUSES.includes(ask.status);
			if (state.status !== "applied" || terminal) continue;
			ask.status = "decided";
			ask.ruling = state.appliedOptionId ?? ask.ruling;
			ask.answeredAt = state.appliedAt ?? ask.answeredAt;
			ask.answeredBy = state.answerRef?.actorId ?? ask.answeredBy;
			ask.answeredByCard = true;
		}
	}

	const openCodes = new Map<string, number>();
	for (const ask of asks) {
		if (ask.code === undefined || CLOSED_ASK_STATUSES.includes(ask.status)) continue;
		openCodes.set(ask.code, (openCodes.get(ask.code) ?? 0) + 1);
	}
	const duplicateCodes = [...openCodes.entries()]
		.filter(([, count]) => count > 1)
		.map(([code]) => code)
		.sort();

	return { asks, partialLastLine, unreadableLines, duplicateCodes, path };
}

/** Every ask still waiting on the operator: a lane cannot proceed, or he has not ruled. */
export function waitingOnOperator(queue: AskQueue): Ask[] {
	return queue.asks.filter((ask) => ask.status === "open" || ask.status === "awaiting-operator");
}

/** Where a thread line's `log:` evidence points: the transcript, and the line the operator's message lands on. */
export type ThreadAskEvidence = { transcript: string; line: number | undefined };

/** What a harness hook tells the session that raised an ask in its own thread (VR24-230 AC2, AC3). */
export type ThreadAskLineInput = {
	musterStateDir: string;
	/** This session's id, as the sweep wrote it into the ask's source. */
	session: string;
	/**
	 * Resolved only when this thread raised an open ask, so a session with nothing on the operator's list pays no
	 * transcript read. Undefined when the harness knows no transcript for this session.
	 */
	evidence?: () => ThreadAskEvidence | undefined;
};

/**
 * One line per ask the operator's list holds from this session's own thread, and nothing when it holds none: the
 * harness hook carries it to the agent on each of his messages, so the session can close the ask in the same
 * turn his words complete or answer it (`finishAsk`, `withdrawAsk`, VR24-230). Reads the queue and writes
 * nothing — closing is the session's own write, with his words as the evidence.
 */
export function threadAskLines(input: ThreadAskLineInput): string[] {
	if (input.session.trim() === "") return [];
	const mine = waitingOnOperator(readAsks(input.musterStateDir)).filter((ask) => sourceSession(ask.source) === input.session);
	if (mine.length === 0) return [];
	const evidence = input.evidence?.();
	return mine.map((ask) => threadAskLine(ask, evidence));
}

/**
 * One ask's line: the code (or the id) and the question he already has, then the two commands that close it,
 * the `done` one carrying this thread's transcript line as its evidence. One line, whatever the question's
 * own wrapping.
 */
function threadAskLine(ask: Ask, evidence: ThreadAskEvidence | undefined): string {
	const log = evidence?.line !== undefined ? `log:${evidence.transcript}:${evidence.line}` : "log:<file>:<line>";
	const question = ask.question.replace(/\s+/g, " ").trim();
	const asked = /[.?!:]$/.test(question) ? question : `${question}.`;
	return `On the operator's list from this thread: ${ask.code ?? ask.id}, ${asked} If his message completes or answers it, close it this turn: muster asks done ${ask.id} --evidence ${log}, or withdraw ${ask.id} --reason "his words".`;
}

/**
 * How many complete lines a transcript holds, counted in one pass without loading it. A harness that writes his
 * message after its hook cites `count + 1`, and one that has already written it cites the count itself.
 * Undefined when the file cannot be read.
 */
export function countTranscriptLines(path: string): number | undefined {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return undefined;
	}
	try {
		const buffer = Buffer.allocUnsafe(1 << 20);
		let lines = 0;
		for (;;) {
			const read = readSync(fd, buffer, 0, buffer.length, null);
			if (read <= 0) break;
			for (let index = 0; index < read; index += 1) if (buffer[index] === 0x0a) lines += 1;
		}
		return lines;
	} finally {
		closeSync(fd);
	}
}

/**
 * The comparison side of the queue's dedupe: case and spacing do not tell two
 * questions apart, and the sweep's own tail — the verbatim quote it found the
 * ask in (`sweepQuestion`, `asks-scan.ts`) — is dropped, because it names the
 * message, not the question, and two runs can take a different substring off the
 * same message.
 */
function normalizeAskQuestion(question: string): string {
	return question.replace(/ — "[\s\S]*"$/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * What a candidate brings to the queue's dedupe (HO3, F2ASKS): the code the message
 * named, the question as it would be raised, when the message was written, and the
 * ask a labeller matched it to by meaning.
 */
export type AskDuplicateCandidate = {
	code?: string;
	question?: string;
	/**
	 * ISO when the message was written. A closed ask covers only what was written at
	 * or before its close (F2ASKS, VR24-166); a candidate with no date is covered by no
	 * closed ask, because the ordering cannot be established.
	 */
	at?: string;
	/** An ask id a labeller matched the candidate to by meaning; an id the queue does not hold is ignored. */
	sameAs?: string;
};

/**
 * When a settled ask stops covering a candidate (F2ASKS, VR24-171 (3)): the close of a
 * `done` or `withdrawn` ask, the answer of a `decided` one. An ask with neither covers
 * nothing: the queue cannot say when the need it holds stopped being open.
 */
function settledAtOf(ask: Ask): string | undefined {
	if (CLOSED_ASK_STATUSES.includes(ask.status)) return ask.closedAt;
	if (ask.status === "decided") return ask.answeredAt;
	return undefined;
}

/**
 * The ask a candidate is already covered by (HO3, F2ASKS; VR24-166, VR24-171 (3)), in
 * the queue's own order:
 *
 * - an ask still waiting on the operator covers a candidate that carries its code or asks
 *   the same question after normalization, whatever the candidate's date;
 * - an ask that is `done` or `withdrawn` covers only a candidate written at or before
 *   its close time (`closedAt`), and an ask that is `decided` only one written at or
 *   before the moment the operator answered it (`answeredAt`): a need raised again after
 *   either is a new need, and is raised;
 * - the ask `sameAs` names covers the candidate under those same rules, and an id the
 *   queue does not hold is ignored.
 *
 * `raiseAsk` has no dedupe of its own, so the sweep asks here before it raises: the
 * hourly 2-hour pass and the nightly 24-hour pass raise one ask between them, and
 * neither repeats one the queue already holds or has settled.
 */
export function findOpenDuplicate(queue: AskQueue, candidate: AskDuplicateCandidate): Ask | undefined {
	const code = nonEmpty(candidate.code) ? candidate.code.trim() : undefined;
	const wanted = candidate.question === undefined ? undefined : normalizeAskQuestion(candidate.question);
	const atMs = nonEmpty(candidate.at) ? Date.parse(candidate.at) : undefined;
	/** Live asks cover always; a settled one covers only what was written at or before it was settled. */
	const covers = (ask: Ask): boolean => {
		if (ask.status === "open" || ask.status === "awaiting-operator") return true;
		const settledAt = settledAtOf(ask);
		if (settledAt === undefined || atMs === undefined || Number.isNaN(atMs)) return false;
		const settledMs = Date.parse(settledAt);
		return !Number.isNaN(settledMs) && atMs <= settledMs;
	};
	const sameAs = nonEmpty(candidate.sameAs) ? candidate.sameAs.trim() : undefined;
	if (sameAs !== undefined) {
		const named = queue.asks.find((ask) => ask.id === sameAs);
		if (named !== undefined && covers(named)) return named;
	}
	return queue.asks.find(
		(ask) =>
			((code !== undefined && ask.code === code) ||
				(wanted !== undefined && wanted !== "" && normalizeAskQuestion(ask.question) === wanted)) &&
			covers(ask),
	);
}

export type AskRefResolution = { ask: Ask } | { ambiguous: Ask[] } | { missing: true };

/**
 * Resolve a reference. An id resolves to its ask, whatever its status. A code
 * resolves only to an ask whose code is still live (not `done` or `withdrawn`),
 * so a code reused after its ask was closed is not shadowed; two live asks with
 * one code are `ambiguous` — the caller lists both and acts on neither.
 */
export function resolveAskRef(queue: AskQueue, ref: string): AskRefResolution {
	const wanted = ref.trim();
	if (wanted === "") return { missing: true };
	const byId = queue.asks.find((ask) => ask.id === wanted);
	if (byId !== undefined) return { ask: byId };
	const live = queue.asks.filter((ask) => ask.code === wanted && !CLOSED_ASK_STATUSES.includes(ask.status));
	if (live.length === 1) return { ask: live[0]! };
	if (live.length > 1) return { ambiguous: live };
	return { missing: true };
}

// ─── Writes ──────────────────────────────────────────────────────────────────

function requireAsk(musterStateDir: string, ref: string): Ask {
	const resolution = resolveAskRef(readAsks(musterStateDir), ref);
	if ("ambiguous" in resolution) {
		throw new AskStateError(
			"ambiguous",
			`code ${ref} belongs to ${resolution.ambiguous.length} live asks (${resolution.ambiguous.map((ask) => ask.id).join(", ")}); use the id`,
		);
	}
	if ("missing" in resolution) {
		throw new AskStateError(
			"missing",
			`no live ask matches ${JSON.stringify(ref)}: a code resolves only to an ask that is not done or withdrawn (use the id)`,
		);
	}
	return resolution.ask;
}

function requireWritable(ask: Ask, transition: string): void {
	if (CLOSED_ASK_STATUSES.includes(ask.status)) {
		throw new AskStateError("conflict", `ask ${ask.id} is already ${ask.status}; ${transition} is refused`);
	}
}

function requireWriter(by: AskWriter): AskWriter {
	if (!(ASK_WRITERS as readonly string[]).includes(by)) {
		throw new AskStateError("invalid", `by must be one of: ${ASK_WRITERS.join(", ")}`);
	}
	return by;
}

/** This writer is one of the two system writers, whose reach stops at its own contract asks. */
function isContractWriter(by: AskWriter): by is ContractAskWriter {
	return (CONTRACT_ASK_WRITERS as readonly string[]).includes(by);
}

/**
 * The scope a system writer has (spec §4, OL0b): only the ask codes its contract table declares, and only
 * raising, preparing and withdrawing. It records no ruling, so a red contract can never answer for the operator.
 */
function requireContractAsk(by: ContractAskWriter, code: string | undefined, action: string): void {
	if (code === undefined || code.trim() === "") {
		throw new AskStateError("refused", `${by} ${action} only a contract ask, and a contract ask carries its contract's code (${[...CONTRACT_ASK_CODES].join(", ")})`);
	}
	if (!CONTRACT_ASK_CODES.has(code)) {
		throw new AskStateError("refused", `${by} ${action} only the asks the contract table declares: ${JSON.stringify(code)} is not one of ${[...CONTRACT_ASK_CODES].join(", ")}`);
	}
}

/** The one thing a system writer may not do: record a ruling or a note on any ask. */
function refuseContractRuling(by: AskWriter, action: string): void {
	if (!isContractWriter(by)) return;
	throw new AskStateError("refused", `${by} ${action} nothing: the tick and the doctor raise and withdraw their own contract asks and record no ruling`);
}

/**
 * What one chat session may close (VR24-230). The sweep records the transcript it read as
 * `sweep:<harness>:<session>@<time>`, so the session id a source names is the thread that may finish,
 * withdraw or note the ask. Every other ask belongs to another thread, or to no thread: the session
 * passes the id and the operator's words to the orchestrator instead.
 */
function requireOwnThread(ask: Ask, session: string | undefined, action: string): void {
	if (session !== undefined && sourceSession(ask.source) === session) return;
	throw new AskStateError(
		"refused",
		`a chat session ${action} only the ask its own thread raised; ask ${ask.id} ${ask.source === undefined ? "names no thread" : "came from another thread"}: send it and the operator's words to the orchestrator`,
	);
}

/**
 * The session a write runs in. Only a chat session has one, and only its event records it; a process
 * that names none writes from its own session (`chatSessionId`), the way the CLI resolves its writer
 * from the process it runs in.
 */
function chatSessionOf(by: AskWriter, named: string | undefined, ask: Ask, action: string): string | undefined {
	if (by !== "chat-session") return undefined;
	const session = (named ?? "").trim() || chatSessionId();
	requireOwnThread(ask, session, action);
	return session;
}

export type RaiseAskInput = {
	by: AskWriter;
	kind: AskKind;
	question: string;
	code?: string;
	owner?: string;
	source?: string;
	/** A path, a report, or `card:<programmeId>/<decisionId>`. */
	link?: string;
	blocks?: string[];
	/** One of `ASK_RULES`. */
	rule?: AskRule;
	/** Overridable for tests and for a replayed import; defaults to now. */
	at?: string;
};

/** Raise one ask. It exists from this moment; the writer cites it to the operator. */
export function raiseAsk(musterStateDir: string, input: RaiseAskInput): Ask {
	const by = requireWriter(input.by);
	if (by === "chat-session") {
		throw new AskStateError("refused", "a chat session raises no ask: send the question to the orchestrator, who raises it and cites its id or code to the operator (VR24-230)");
	}
	if (!(ASK_KINDS as readonly string[]).includes(input.kind)) {
		throw new AskStateError("invalid", `kind must be one of: ${ASK_KINDS.join(", ")}`);
	}
	if (!nonEmpty(input.question)) throw new AskStateError("invalid", "an ask needs a question");
	if (input.code !== undefined && !CODE_PATTERN.test(input.code)) {
		throw new AskStateError("invalid", `code ${JSON.stringify(input.code)} must match ${CODE_PATTERN.source}`);
	}
	if (isContractWriter(by)) requireContractAsk(by, input.code, "raises");
	if (input.rule !== undefined && !isAskRule(input.rule)) {
		throw new AskStateError("invalid", `rule must be one of: ${ASK_RULES.join(", ")}`);
	}
	if (nonEmpty(input.link) && input.link.startsWith(CARD_LINK_PREFIX) && parseCardLink(input.link) === undefined) {
		throw new AskStateError("invalid", `card link ${JSON.stringify(input.link)} must be card:<agp_…>/<dec_…>`);
	}
	const id = `ask_${randomUUID()}`;
	const at = input.at ?? new Date().toISOString();
	const event: AskRaisedEvent = {
		...askEventBase(by, id, at),
		type: "raised",
		kind: input.kind,
		question: input.question.trim(),
		...(nonEmpty(input.code) ? { code: input.code.trim() } : {}),
		...(nonEmpty(input.owner) ? { owner: input.owner.trim() } : {}),
		...(nonEmpty(input.source) ? { source: input.source.trim() } : {}),
		...(nonEmpty(input.link) ? { link: input.link.trim() } : {}),
		...(input.blocks !== undefined && input.blocks.length > 0 ? { blocks: [...input.blocks] } : {}),
		...(input.rule !== undefined ? { rule: input.rule } : {}),
	};
	appendAskEvent(musterStateDir, event);
	return askFromRaised(event);
}

export type PrepareAskInput = { ref: string; by: AskWriter; options: string[]; recommendation: string; at?: string };

/** Add the options and the recommendation: the ask is now ready for the operator. */
export function prepareAsk(musterStateDir: string, input: PrepareAskInput): Ask {
	const by = requireWriter(input.by);
	if (by === "chat-session") {
		throw new AskStateError("refused", "a chat session prepares no ask: the orchestrator prepares it and carries the operator's answer (VR24-230)");
	}
	const ask = requireAsk(musterStateDir, input.ref);
	if (isContractWriter(by)) requireContractAsk(by, ask.code, "prepares");
	requireWritable(ask, "prepared");
	const options = input.options.map((option) => option.trim()).filter((option) => option !== "");
	if (options.length === 0) throw new AskStateError("invalid", "prepared needs at least one option");
	if (!nonEmpty(input.recommendation)) throw new AskStateError("invalid", "prepared needs a recommendation");
	const event: AskPreparedEvent = {
		...askEventBase(by, ask.id, input.at ?? new Date().toISOString()),
		type: "prepared",
		options,
		recommendation: input.recommendation.trim(),
	};
	appendAskEvent(musterStateDir, event);
	return applyAndReturn(musterStateDir, ask.id);
}

export type AnswerAskInput = {
	ref: string;
	by: AskWriter;
	ruling: string;
	/** the operator's own words, when the writer is not him. */
	words?: string;
	relay?: AskRelay;
	/** The decision row the ruling is recorded as (`file:line`). */
	row?: string;
	/**
	 * A tap on one option (D15). Accepted only from the page: `by` `operator-page` with the relay
	 * `command-center`, no `words`, `ruling` equal to the option, an option the ask lists exactly, and
	 * the version the store holds now. The CLI and Henry's `asks_answer` have no such input.
	 */
	tap?: AskTap;
	at?: string;
};

/** What `answerAskResult` reports: the ask, and whether the tap repeated the option it already records. */
export type AnswerAskResult = { ask: Ask; already: boolean };

/**
 * Record a ruling.
 *
 * A card-linked ask is answered on its card and refused here. A product question
 * or a review is answered by the operator or the architect, with the row the architect
 * wrote; the orchestrator passes it on. A kind only the operator may approve is
 * recorded from someone else only with his words and the relay that carried them.
 */
export function answerAsk(musterStateDir: string, input: AnswerAskInput): Ask {
	return answerAskResult(musterStateDir, input).ask;
}

/**
 * `answerAsk` plus whether the answer was a repeat. Only a tap can repeat: a tap of the option the
 * ask already records appends nothing and reports `already` (D15).
 */
export function answerAskResult(musterStateDir: string, input: AnswerAskInput): AnswerAskResult {
	const by = requireWriter(input.by);
	refuseContractRuling(by, "answers");
	if (by === "desk") throw new AskStateError("refused", "the desk writer raises standing-rule drafts and records no ruling");
	if (by === "messaging") throw new AskStateError("refused", "the messaging writer raises the ask for a draft and records no ruling: only the page's tap answers it");
	if (by === "chat-session") {
		throw new AskStateError(
			"refused",
			"a chat session records no ruling, and a product-decision is the architect's or the orchestrator's: send the ask and the operator's words to the orchestrator (VR24-230)",
		);
	}
	const ask = requireAsk(musterStateDir, input.ref);
	if (input.tap !== undefined) return answerByTap(musterStateDir, ask, by, input, input.tap);
	requireWritable(ask, "answered");
	if (ask.card !== undefined) {
		throw new AskStateError(
			"refused",
			`ask ${ask.id} defers to card ${ask.card.decisionId}: answer it on its card`,
		);
	}
	if (!nonEmpty(input.ruling)) throw new AskStateError("invalid", "an answer needs a ruling");
	if (PRODUCT_KINDS.includes(ask.kind)) {
		if (by === "orchestrator") {
			throw new AskStateError("refused", `the orchestrator passes a ${ask.kind} question on (methodology Authority 3); it is answered by the operator or the architect`);
		}
		if (by === "architect" && !nonEmpty(input.row)) {
			throw new AskStateError("refused", `the architect records the decision row the ruling lives in (--row file:line)`);
		}
		if (by !== "operator-shell" && by !== "architect" && !(nonEmpty(input.words) && input.relay !== undefined)) {
			throw new AskStateError("refused", `a ${ask.kind} answer recorded by ${by} needs the operator's words (--words) and the relay that carried them (--relay)`);
		}
	}
	if (OPERATOR_ONLY_KINDS.includes(ask.kind) && by !== "operator-shell") {
		if (!nonEmpty(input.words)) {
			throw new AskStateError("refused", `a ${ask.kind} ask is answered only with the operator's words (--words); nothing was recorded`);
		}
		if (input.relay === undefined || !nonEmpty(input.relay.ref)) {
			throw new AskStateError("refused", `a ${ask.kind} ask needs the relay that carried the operator's words (--relay)`);
		}
	}
	const event: AskAnsweredEvent = {
		...askEventBase(by, ask.id, input.at ?? new Date().toISOString()),
		type: "answered",
		ruling: input.ruling.trim(),
		...(nonEmpty(input.words) ? { words: input.words.trim() } : {}),
		...(input.relay !== undefined ? { relay: input.relay } : {}),
		...(nonEmpty(input.row) ? { row: input.row.trim() } : {}),
	};
	appendAskEvent(musterStateDir, event);
	return { ask: applyAndReturn(musterStateDir, ask.id), already: false };
}

/**
 * The tap form of `answerAsk` (D15). It skips the words guards above, and only it does: the
 * writer is the operator on his own page behind his login. Every other writer, relay or shape is refused
 * before the ask's state is judged, so a caller that is not the page learns nothing about it.
 *
 * The version compare and the append below run with no await between them, so two taps cannot
 * both pass: `askVersion` hashes the status and the ruling, and the second sees the first.
 */
function answerByTap(musterStateDir: string, ask: Ask, by: AskWriter, input: AnswerAskInput, tap: AskTap): AnswerAskResult {
	if (by !== "operator-page" || input.relay?.via !== "command-center" || !nonEmpty(input.relay.ref)) {
		throw new AskStateError("refused", "a tap answer is accepted only from the command center page (operator-page, relay command-center)");
	}
	if (nonEmpty(input.words)) throw new AskStateError("refused", "a tap answer carries no words: answer in words or tap an option, not both");
	if (!isAskTap(tap)) throw new AskStateError("invalid", "a tap needs an option and the version the page showed");
	if (input.ruling !== tap.option) throw new AskStateError("invalid", "a tap's ruling is its option");
	if (CLOSED_ASK_STATUSES.includes(ask.status)) {
		throw new AskStateError("conflict", `ask ${ask.id} is already ${ask.status}; answered is refused`);
	}
	if (ask.card !== undefined) {
		throw new AskStateError("refused", `ask ${ask.id} defers to card ${ask.card.decisionId}: answer it on its card`);
	}
	if (!ask.options.includes(tap.option)) {
		throw new AskStateError(
			"invalid",
			`option ${JSON.stringify(tap.option)} is not one of this ask's options (${ask.options.length === 0 ? "it has none: it is not prepared" : ask.options.join(" | ")})`,
		);
	}
	// The option the ask already records is a repeat of the same tap, even from an older page.
	if (ask.status === "decided" && ask.tap?.option === tap.option) return { ask, already: true };
	if (ask.status !== "open" && ask.status !== "awaiting-operator") {
		throw new AskStateError("conflict", `ask ${ask.id} is ${ask.status}; a tap answers only an open or awaiting-operator ask`);
	}
	if (askVersion(ask) !== tap.version) throw new AskStateError("conflict", "this ask changed, reload");
	const event: AskAnsweredEvent = {
		...askEventBase(by, ask.id, input.at ?? new Date().toISOString()),
		type: "answered",
		ruling: tap.option,
		relay: input.relay,
		tap: { option: tap.option, version: tap.version },
	};
	appendAskEvent(musterStateDir, event);
	return { ask: applyAndReturn(musterStateDir, ask.id), already: false };
}

export type FinishAskInput = {
	ref: string;
	by: AskWriter;
	evidence: AskEvidence;
	/** The chat session's own id, for `by` `chat-session`; every other writer leaves it unset. */
	session?: string;
	at?: string;
};

/** Finish an ask, naming the artifact that carries the outcome. */
export function finishAsk(musterStateDir: string, input: FinishAskInput): Ask {
	const by = requireWriter(input.by);
	refuseContractRuling(by, "finishes");
	const ask = requireAsk(musterStateDir, input.ref);
	requireWritable(ask, "done");
	if (!isAskEvidence(input.evidence)) {
		throw new AskStateError("invalid", "done needs evidence: commit:<sha>@<repo>, row:<row>@<file>:<line> or log:<file>:<line>");
	}
	const session = chatSessionOf(by, input.session, ask, "finishes");
	const event: AskDoneEvent = {
		...askEventBase(by, ask.id, input.at ?? new Date().toISOString(), session),
		type: "done",
		evidence: input.evidence,
	};
	appendAskEvent(musterStateDir, event);
	return applyAndReturn(musterStateDir, ask.id);
}

export type WithdrawAskInput = {
	ref: string;
	by: AskWriter;
	reason: string;
	/** The chat session's own id, for `by` `chat-session`; every other writer leaves it unset. */
	session?: string;
	at?: string;
};

/** Withdraw an ask that is no longer needed, with the reason (P4-D2). */
export function withdrawAsk(musterStateDir: string, input: WithdrawAskInput): Ask {
	const by = requireWriter(input.by);
	const ask = requireAsk(musterStateDir, input.ref);
	if (isContractWriter(by)) requireContractAsk(by, ask.code, "withdraws");
	requireWritable(ask, "withdrawn");
	if (!nonEmpty(input.reason)) throw new AskStateError("invalid", "withdrawn needs a reason");
	const session = chatSessionOf(by, input.session, ask, "withdraws");
	const event: AskWithdrawnEvent = {
		...askEventBase(by, ask.id, input.at ?? new Date().toISOString(), session),
		type: "withdrawn",
		reason: input.reason.trim(),
	};
	appendAskEvent(musterStateDir, event);
	return applyAndReturn(musterStateDir, ask.id);
}

export type NoteAskInput = {
	ref: string;
	by: AskWriter;
	text: string;
	/** The chat session's own id, for `by` `chat-session`; every other writer leaves it unset. */
	session?: string;
	at?: string;
};

/** Add a pointer or a comment. It never changes the ask's status. */
export function noteAsk(musterStateDir: string, input: NoteAskInput): Ask {
	const by = requireWriter(input.by);
	refuseContractRuling(by, "notes");
	const ask = requireAsk(musterStateDir, input.ref);
	if (!nonEmpty(input.text)) throw new AskStateError("invalid", "a note needs text");
	const session = chatSessionOf(by, input.session, ask, "notes");
	const event: AskNotedEvent = {
		...askEventBase(by, ask.id, input.at ?? new Date().toISOString(), session),
		type: "noted",
		text: input.text.trim(),
	};
	appendAskEvent(musterStateDir, event);
	return applyAndReturn(musterStateDir, ask.id);
}

/**
 * The token a reader holds to show an ask has not changed since it read it. An event carries no id of
 * its own (`askAppendRequestId`), so the token is a hash of what every event type moves: the latest
 * event's time, the status, the options, the recommendation, the ruling and the count of notes.
 */
export function askVersion(ask: Ask): string {
	return createHash("sha256")
		.update(JSON.stringify([ask.updatedAt, ask.status, ask.options, ask.recommendation ?? null, ask.ruling ?? null, ask.notes.length]))
		.digest("hex")
		.slice(0, 16);
}

function applyAndReturn(musterStateDir: string, id: string): Ask {
	const ask = readAsks(musterStateDir).asks.find((candidate) => candidate.id === id);
	if (ask === undefined) throw new AskStateError("io", `ask ${id} was appended but did not fold back; the event file is unreadable`);
	return ask;
}

// ─── the operator's view ───────────────────────────────────────────────────────────

/** The ask's human code when it has one, else its id: what a view and a message cite. */
export function askCodeOf(ask: Ask): string {
	return ask.code ?? ask.id;
}

/** Age in the compact form a one-line view needs: `3d`, `2h`, `15m`. */
export function formatAskAge(from: string, nowMs: number): string {
	const raised = Date.parse(from);
	if (!Number.isFinite(raised)) return "?";
	const minutes = Math.max(0, Math.floor((nowMs - raised) / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

/**
 * The option the ask recommends: the one whose trimmed text equals the trimmed recommendation,
 * ignoring case (D16). Undefined when the ask is unprepared or the recommendation names no option
 * word for word, and then a reader shows every option alike. The page, `asks_read` and the
 * standing-rule drafts all read "recommended" here.
 */
export function recommendedOption(ask: Ask): string | undefined {
	if (ask.recommendation === undefined) return undefined;
	const wanted = ask.recommendation.trim().toLowerCase();
	return ask.options.find((option) => option.trim().toLowerCase() === wanted);
}

/**
 * Whether the ask is ready to put in front of the operator (spec §7a, OL3): it carries its options and a
 * recommendation, and until it does it is a free-text one that stays out of his list and waits for A2 to
 * prepare it. One owner for the question, because the page, the push and the tick's wake must not each
 * answer it differently.
 */
export function askIsPrepared(ask: Ask): boolean {
	return ask.options.length > 0 && nonEmpty(ask.recommendation);
}

/** The lanes and tasks an ask blocks, counted once each: a repeated or blank entry adds nothing. */
function blockedCount(ask: Ask): number {
	return new Set(ask.blocks.map((entry) => entry.trim()).filter((entry) => entry !== "")).size;
}

/**
 * What waits on the operator, in the one order every view shares (D17): the asks that block the most
 * lanes or tasks first, then the kinds only he may answer, then the older ask.
 */
export function orderAsksForOperator(asks: Ask[]): Ask[] {
	const operatorOnly = (ask: Ask): number => (OPERATOR_ONLY_KINDS.includes(ask.kind) ? 0 : 1);
	return [...asks].sort(
		(left, right) =>
			blockedCount(right) - blockedCount(left) ||
			operatorOnly(left) - operatorOnly(right) ||
			left.raisedAt.localeCompare(right.raisedAt),
	);
}

// ─── Standing-rule drafts (D23) ──────────────────────────────────────────────

/** The `source` of a standing-rule draft: `near-loop:standing-rule:<kind>:<rule>:<third ask id>`. It makes the pass idempotent. */
export const STANDING_RULE_SOURCE_PREFIX = "near-loop:standing-rule:";
/** Rules whose answers are never drafted into a standing rule (VR24-40 (1)). */
export const STANDING_RULE_NEVER: readonly AskRule[] = ["pay", "sign", "publish", "delete"];
/** How many consecutive, equal answers make a pattern. */
export const STANDING_RULE_RUN = 3;
export const STANDING_RULE_APPROVE = "Approve this rule";
export const STANDING_RULE_DECLINE = "Not now";

export type StandingRuleDraft = {
	kind: AskKind;
	rule: AskRule;
	/** The shared answer as the third ask recorded it. */
	answer: string;
	/** The ask codes or ids the pattern rests on, oldest first. */
	asks: string[];
	source: string;
	code: string;
	question: string;
	/** Empty for `spend`: the answer must carry the operator's words and the ceiling he names. */
	options: string[];
};

function normalisedAnswer(ruling: string): string {
	return ruling.trim().toLowerCase().replace(/\s+/g, " ");
}

function sharedValue(values: Array<string | undefined>): string | undefined {
	const first = values[0];
	return first !== undefined && values.every((value) => value === first) ? first : undefined;
}

function standingRuleText(rule: AskRule, answer: string, asks: Ask[], code: string): string {
	const lines = [
		`Standing rule proposed: ${STANDING_RULE_RUN} ${asks[0]!.kind} asks about ${rule} in a row were answered "${answer}".`,
		...asks.map((ask) => `- ${askCodeOf(ask)}: ${ask.question}`),
		`Answer given: ${answer}`,
	];
	const owner = sharedValue(asks.map((ask) => ask.owner));
	const source = sharedValue(asks.map((ask) => ask.source));
	if (owner !== undefined) lines.push(`Owner: ${owner}`);
	if (source !== undefined) lines.push(`Source: ${source}`);
	lines.push("Covers only: the same kind and rule and the fields the three share. Not covered: anything else.");
	if (rule === "spend") lines.push("To approve, answer in your own words and name the ceiling the rule may spend.");
	lines.push(`Revoke: tell the architect or Henry "revoke standing rule ${code}".`);
	return lines.join("\n");
}

/**
 * The standing-rule drafts the queue calls for (D23), none of them raised yet. For one (kind, rule)
 * pair, in the order the asks were answered, counted from the last draft for that pair: the last
 * three were each given a rule and the same answer (trimmed, lower case, spaces collapsed). An ask
 * without a rule is in no pair. A draft exists once its third ask's id is in some ask's `source`,
 * whatever that ask's status, so a withdrawn or answered draft is never raised again. Pure: no
 * model, no clock, no write.
 */
export function standingRuleDrafts(queue: AskQueue): StandingRuleDraft[] {
	const existing = queue.asks.filter((ask) => ask.source !== undefined && ask.source.startsWith(STANDING_RULE_SOURCE_PREFIX));
	const pairs = new Map<string, Ask[]>();
	for (const ask of queue.asks) {
		if (ask.rule === undefined || STANDING_RULE_NEVER.includes(ask.rule)) continue;
		if (ask.status === "withdrawn" || ask.ruling === undefined || ask.answeredAt === undefined) continue;
		if (ask.source !== undefined && ask.source.startsWith(STANDING_RULE_SOURCE_PREFIX)) continue;
		const key = `${ask.kind}:${ask.rule}`;
		pairs.set(key, [...(pairs.get(key) ?? []), ask]);
	}
	const drafts: StandingRuleDraft[] = [];
	for (const [key, members] of pairs) {
		const sequence = [...members].sort((left, right) => left.answeredAt!.localeCompare(right.answeredAt!) || left.id.localeCompare(right.id));
		const prefix = `${STANDING_RULE_SOURCE_PREFIX}${key}:`;
		const drafted = existing.filter((ask) => ask.source!.startsWith(prefix));
		const last = drafted.sort((left, right) => left.raisedAt.localeCompare(right.raisedAt)).at(-1);
		let counted = sequence;
		if (last !== undefined) {
			const thirdId = last.source!.slice(prefix.length);
			const at = sequence.findIndex((ask) => ask.id === thirdId);
			counted = at >= 0 ? sequence.slice(at + 1) : sequence.filter((ask) => ask.answeredAt! > last.raisedAt);
		}
		const run = counted.slice(-STANDING_RULE_RUN);
		if (run.length < STANDING_RULE_RUN) continue;
		if (new Set(run.map((ask) => normalisedAnswer(ask.ruling!))).size !== 1) continue;
		const third = run[run.length - 1]!;
		const source = `${prefix}${third.id}`;
		if (drafted.some((ask) => ask.source === source)) continue;
		const rule = third.rule!;
		const code = `SR-${createHash("sha256").update(source).digest("hex").slice(0, 8)}`;
		const answer = third.ruling!.trim();
		drafts.push({
			kind: third.kind,
			rule,
			answer,
			asks: run.map(askCodeOf),
			source,
			code,
			question: standingRuleText(rule, answer, run, code),
			options: rule === "spend" ? [] : [STANDING_RULE_APPROVE, STANDING_RULE_DECLINE],
		});
	}
	return drafts;
}

/**
 * Raise one draft as the writer `desk`: an `authorization` ask with no `rule` of its own, so it never
 * counts toward a rule. A draft with options is prepared in a second event, recommending `Not now`:
 * the desk proposes and does not push the operator towards a rule.
 */
export function raiseStandingRuleDraft(musterStateDir: string, draft: StandingRuleDraft, at?: string): Ask {
	const raised = raiseAsk(musterStateDir, {
		by: "desk",
		kind: "authorization",
		question: draft.question,
		code: draft.code,
		source: draft.source,
		...(at !== undefined ? { at } : {}),
	});
	if (draft.options.length === 0) return raised;
	return prepareAsk(musterStateDir, { ref: raised.id, by: "desk", options: draft.options, recommendation: STANDING_RULE_DECLINE, ...(at !== undefined ? { at } : {}) });
}

/**
 * The source prefix of an ask the transcript sweep raised (HO3). Its `source` is
 * `sweep:<harness>:<session>@<time>`, and every line a reader sees says so. The
 * sweep writes the same prefix, from here: one owner, no second literal.
 */
export const SWEEP_SOURCE_PREFIX = "sweep:";

/** True when the sweep raised the ask, so a reader sees why it is in the queue. */
function foundBySweep(ask: Ask): boolean {
	return ask.source !== undefined && ask.source.startsWith(SWEEP_SOURCE_PREFIX);
}

/** One line: code, question, recommendation, age, what it unblocks. */
export function formatAskLine(ask: Ask, nowMs: number): string {
	return [
		askCodeOf(ask),
		` ${ask.question}`,
		` [${ask.kind}, ${ask.status}`,
		foundBySweep(ask) ? ", found by the sweep" : "",
		ask.recommendation !== undefined ? `, rec ${ask.recommendation}` : "",
		`, ${formatAskAge(ask.raisedAt, nowMs)}`,
		ask.blocks.length > 0 ? `, unblocks ${ask.blocks.join(", ")}` : "",
		"]",
	].join("");
}

/** The whole ask as a reader sees it: one line, then everything recorded about it. */
export function formatAskDetail(ask: Ask, nowMs: number): string[] {
	const lines = [formatAskLine(ask, nowMs)];
	const says = (label: string, value: string | undefined): void => {
		if (value !== undefined) lines.push(`  ${label}: ${value}`);
	};
	says("owner", ask.owner);
	says("rule", ask.rule);
	says("raised by", `${ask.raisedBy} ${ask.raisedAt}`);
	says("source", ask.source);
	says("link", ask.link);
	if (ask.blocks.length > 0) says("blocks", ask.blocks.join(", "));
	if (ask.options.length > 0) says("options", ask.options.join(" | "));
	says("card", ask.card !== undefined ? `${cardLink(ask.card.programmeId, ask.card.decisionId)} (${ask.cardState ?? "unread"})` : undefined);
	says("ruling", ask.ruling);
	says("tap", ask.tap !== undefined ? `${ask.tap.option} (version ${ask.tap.version})` : undefined);
	says("answered by", ask.answeredBy !== undefined ? `${ask.answeredBy}${ask.answeredAt !== undefined ? ` ${ask.answeredAt}` : ""}${ask.answeredByCard ? " (on the card)" : ""}` : undefined);
	says("row", ask.row);
	says("the operator's words", ask.words);
	says("relay", ask.relay !== undefined ? `${ask.relay.via} ${ask.relay.ref} (${ask.relay.at})` : undefined);
	says("evidence", ask.evidence !== undefined ? formatEvidence(ask.evidence) : undefined);
	says("withdrawn", ask.withdrawnReason);
	for (const note of ask.notes) says("note", note);
	return lines;
}

// ─── The generated list ──────────────────────────────────────────────────────

/**
 * The list the operator reads (`plans/orchestration-2026-10-05/handoffs/operator-only-list.md`),
 * generated from the queue on every write (AK3). It is a view of the queue and
 * never a second store: the writers regenerate it, and a hand edit lasts only
 * until the next event.
 */
export const OPERATOR_LIST_ENV = "MUSTER_OPERATOR_LIST_PATH";
export const OPERATOR_LIST_RELATIVE_PATH = join("plans", "orchestration-2026-10-05", "handoffs", "operator-only-list.md");
export const OPERATOR_LIST_FIRST_LINE =
	"Generated from Muster's ask queue; change it with `muster ask` or `muster asks`";

/**
 * Where the generated list lives: the path `MUSTER_OPERATOR_LIST_PATH` names, else
 * this install's own handoffs copy.
 *
 * The caller's env is read first and the process's own override second, because a
 * caller may pass a partial env (a CLI frame, a test harness) while the override
 * is a property of the process the writers run in. That is how a test renders to
 * its own file instead of the tree it runs in.
 */
export function operatorListPath(env: NodeJS.ProcessEnv = process.env): string {
	const named = env[OPERATOR_LIST_ENV]?.trim();
	const ambient = process.env[OPERATOR_LIST_ENV]?.trim();
	const override = named !== undefined && named !== "" ? named : ambient;
	return override !== undefined && override !== "" ? override : join(piAgentDir(), OPERATOR_LIST_RELATIVE_PATH);
}

/** One table cell: no question breaks the table it sits in. */
function listCell(text: string): string {
	const flat = text.replace(/\|/g, "/").replace(/\s+/g, " ").trim();
	return flat === "" ? "-" : flat;
}

function listTable(headers: readonly string[], rows: readonly string[][]): string[] {
	return [
		`| ${headers.join(" | ")} |`,
		`|${headers.map(() => "---").join("|")}|`,
		...rows.map((cells) => `| ${cells.map(listCell).join(" | ")} |`),
	];
}

/** What closed a settled ask, as the third cell of its row. */
function listOutcome(ask: Ask): string {
	if (ask.status === "withdrawn") return `Withdrawn: ${ask.withdrawnReason ?? ""}`;
	if (ask.status === "done") return `Done: ${ask.evidence !== undefined ? formatEvidence(ask.evidence) : ""}`;
	return `Ruled${ask.answeredAt !== undefined ? ` ${ask.answeredAt}` : ""}: ${ask.ruling ?? ""}`;
}

/**
 * the operator's list as Markdown: what waits on him in the view's own order (most
 * lanes or tasks blocked first, then the kinds only he may answer, then the rest by
 * age), then the settled asks, struck through and never renumbered.
 */
export function renderOperatorList(queue: AskQueue, nowMs: number = Date.now()): string {
	const waiting = orderAsksForOperator(waitingOnOperator(queue));
	const waitingIds = new Set(waiting.map((ask) => ask.id));
	const settled = queue.asks
		.filter((ask) => !waitingIds.has(ask.id))
		.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id));
	const doing = waiting.filter((ask) => SITTING_KINDS.includes(ask.kind));
	const deciding = waiting.filter((ask) => !SITTING_KINDS.includes(ask.kind));
	// The sweep's own note rides on the item cell, so the operator sees why an ask he
	// never typed is in his list (HO3).
	const item = (ask: Ask): string => (foundBySweep(ask) ? `${ask.question} (found by the sweep)` : ask.question);
	return [
		OPERATOR_LIST_FIRST_LINE,
		"",
		`- ${waiting.length} waiting on you, updated ${new Date(nowMs).toISOString()}. Codes stay fixed; a settled ask is struck through, never renumbered.`,
		"",
		"## Only you can do (VH)",
		"",
		...listTable(["Code", "Task", "Unblocks"], doing.map((ask) => [
			askCodeOf(ask),
			item(ask),
			ask.blocks.length > 0 ? ask.blocks.join(", ") : "-",
		])),
		"",
		"## Only you can decide (VD)",
		"",
		...listTable(["Code", "Decision", "Recommendation"], deciding.map((ask) => [
			askCodeOf(ask),
			item(ask),
			ask.recommendation ?? "-",
		])),
		"",
		"## Settled",
		"",
		...listTable(["Code", "Item", "Outcome"], settled.map((ask) => [
			`~~${askCodeOf(ask)}~~`,
			`~~${item(ask)}~~`,
			listOutcome(ask),
		])),
		"",
	].join("\n");
}

export type OperatorListResult = { written: string } | { error: string };

export type RegenerateOperatorListOptions = {
	/** The list's own path; defaults to `operatorListPath(env)`. */
	path?: string;
	/** The environment the override is read from. */
	env?: NodeJS.ProcessEnv;
	now?: number;
};

/**
 * Regenerate the list from the queue's own fold (AK3). It is written to a temp
 * file in the target's directory and renamed over it, so a reader never sees a
 * half-written file. It never throws: the ask that was just appended is already
 * durable, and the caller reports a failed view write instead of losing it.
 */
export function regenerateOperatorList(
	musterStateDir: string,
	options: RegenerateOperatorListOptions = {},
): OperatorListResult {
	const path = options.path ?? operatorListPath(options.env ?? process.env);
	const queue = readAsks(musterStateDir, { cardState: programmeCardReader() });
	const content = renderOperatorList(queue, options.now ?? Date.now());
	const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
		writeFileSync(temp, content, { mode: 0o644 });
		renameSync(temp, path);
		return { written: path };
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {
			// Nothing to remove: the temp file is only ours where it was written.
		}
		return { error: `${path}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

// ─── The sweeper's review list (AK4) ─────────────────────────────────────────

/** The review list, beside the events file: `<stateDir>/asks/review.jsonl`. */
export const REVIEW_FILE = "review.jsonl";

/**
 * The findings the sweeper records: the file diff's two (AK4), plus the transcript scan's
 * `may-be-answered` — the operator's own deferral of something the queue may already hold (AK5). The
 * sweeper never changes an ask's status, so a finding asks the architect for a queue event; it is
 * never a status of its own.
 */
export type ReviewFindingKind = "not-in-queue" | "may-be-done" | "may-be-answered";

/**
 * One finding as the sweeper writes it: what it is, where the item reads, what it
 * says, and when the run saw it. The sweeper never changes an ask's status, so an
 * entry asks the architect for a queue event; it is never a status of its own.
 */
export type ReviewFinding = { finding: ReviewFindingKind; source: string; text: string; at: string };

/** The one review list. */
export function reviewPath(musterStateDir: string): string {
	return join(asksDir(musterStateDir), REVIEW_FILE);
}

function isReviewFinding(value: unknown): value is ReviewFinding {
	if (value === null || typeof value !== "object") return false;
	const entry = value as Record<string, unknown>;
	if (entry["finding"] !== "not-in-queue" && entry["finding"] !== "may-be-done" && entry["finding"] !== "may-be-answered") return false;
	return nonEmpty(entry["source"]) && nonEmpty(entry["text"]) && nonEmpty(entry["at"]);
}

export type ReviewList = { findings: ReviewFinding[]; partialLastLine: number; unreadableLines: number; path: string };

/** Read the review list. It never throws on file content, as `readAsks` does not. */
export function readReviewFindings(musterStateDir: string): ReviewList {
	const path = reviewPath(musterStateDir);
	let raw = "";
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		raw = "";
	}
	const findings: ReviewFinding[] = [];
	let unreadableLines = 0;
	let partialLastLine = 0;
	const take = (line: string): void => {
		if (line.trim() === "") return;
		try {
			const parsed: unknown = JSON.parse(line);
			if (isReviewFinding(parsed)) findings.push(parsed);
			else unreadableLines += 1;
		} catch {
			unreadableLines += 1;
		}
	};
	const lines = raw.split("\n");
	const trailing = lines.pop() ?? "";
	if (trailing.trim() !== "") {
		partialLastLine = 1;
		try {
			const parsed: unknown = JSON.parse(trailing);
			if (isReviewFinding(parsed)) findings.push(parsed);
		} catch {
			// The torn write itself: counted once, as the partial last line.
		}
	}
	for (const line of lines) take(line);
	return { findings, partialLastLine, unreadableLines, path };
}

/** Append one finding through the one fsynced append the events file uses. */
export function appendReviewFinding(musterStateDir: string, finding: ReviewFinding): void {
	const repair = endsWithoutNewline(reviewPath(musterStateDir)) ? "\n" : "";
	appendFsyncedLine(asksDir(musterStateDir), REVIEW_FILE, `${repair}${JSON.stringify(finding)}\n`);
}

export type ReviewAppendResult = { appended: ReviewFinding[]; alreadyThere: number };

/**
 * Write this run's findings to the review list, skipping any finding the list
 * already carries (the same kind, source and text). The list is append-only and
 * the run is hourly, so an unsettled finding must not be repeated every hour.
 */
export function recordReviewFindings(
	musterStateDir: string,
	findings: readonly SweepFinding[],
	now: string = new Date().toISOString(),
): ReviewAppendResult {
	const seen = new Set(readReviewFindings(musterStateDir).findings.map(reviewKey));
	const appended: ReviewFinding[] = [];
	let alreadyThere = 0;
	for (const finding of findings) {
		const entry: ReviewFinding = { finding: finding.finding, source: finding.source, text: finding.text, at: now };
		const key = reviewKey(entry);
		if (seen.has(key)) {
			alreadyThere += 1;
			continue;
		}
		seen.add(key);
		appendReviewFinding(musterStateDir, entry);
		appended.push(entry);
	}
	return { appended, alreadyThere };
}

function reviewKey(entry: ReviewFinding): string {
	return `${entry.finding}\u0000${entry.source}\u0000${entry.text}`;
}

// ─── The sweeper's file diff (AK4, "The sweeper" step 1) ─────────────────────

/** A list row as the parser yields it: the import script's own shape. */
export type ParsedListRow = { token: string; code?: string; question: string; struck: boolean };

/**
 * One list the sweeper reads: a file a person or an agent edits by hand, or a
 * source that is not one file (the outbox store). The parser is the import
 * script's own (`scripts/asks-import.mts`), so a list has one reader here.
 */
export type ListSource =
	| { path: string; parse: (file: string, text: string) => ParsedListRow[] }
	| { path: string; items: () => ParsedListRow[] };

export type SweepFinding = { finding: ReviewFindingKind; source: string; text: string };

/** One live item of a list, as the diff matches it. */
export type SweepItem = { source: string; codes: string[]; text: string };

export type SweepSourceReport = { path: string; items: number; missing: boolean };

export type ListDiff = {
	findings: SweepFinding[];
	/** Every live item the lists hold, one per row. */
	items: SweepItem[];
	matched: number;
	notInQueue: number;
	mayBeDone: number;
	waiting: number;
	sources: SweepSourceReport[];
};

/** The checkout the hand-edited lists are read from; this install's own by default. */
export const SWEEP_LISTS_ROOT_ENV = "MUSTER_ASKS_LISTS_ROOT";
/** The agent whose inbox is the outbox the design names. */
export const OUTBOX_AGENT = "grokbot";
/** A code-shaped token in an outbox message; only a registered code makes the item. */
const OUTBOX_CODE = /\b[A-Za-z]{1,3}\d{1,3}\b/g;
/** The queue's own series, which a list may carry before any ask does. */
const QUEUE_SERIES = /^(?:VH|VD|DQ)\d{1,3}$/;
const MAX_OUTBOX_MESSAGES = 200;
/** The longest text a finding or a review row carries, so one quote cannot flood the list. */
export const MAX_FINDING_TEXT = 200;

export type AskListSourceOptions = { env?: NodeJS.ProcessEnv; root?: string; home?: string };

/**
 * Every list the sweeper reads, in the design's order: the generated the operator list
 * (which a person may still hand-edit), the design inbox, the two snapshots,
 * global memory's action list, and the outbox messages to Grokbot that name a
 * code. `MUSTER_ASKS_LISTS_ROOT` points a caller at another checkout's lists.
 */
export function askListSources(musterStateDir: string, options: AskListSourceOptions = {}): ListSource[] {
	const env = options.env ?? process.env;
	const named = options.root ?? env[SWEEP_LISTS_ROOT_ENV]?.trim();
	const root = named !== undefined && named !== "" ? named : piAgentDir();
	return [
		{ path: operatorListPath(env), parse: parseOperatorList },
		{ path: join(root, REPO_SOURCE_PATHS.designInbox), parse: parseDesignInbox },
		{ path: join(root, REPO_SOURCE_PATHS.orchestratorSnapshot), parse: parseOrchestratorSnapshot },
		{ path: join(root, REPO_SOURCE_PATHS.designSnapshot), parse: parseDesignSnapshot },
		{ path: expandHome(DEFAULT_PENDING_ACTIONS, options.home ?? homedir()), parse: parsePendingActions },
		{ path: `inbox/${OUTBOX_AGENT}`, items: () => outboxRows(musterStateDir) },
	];
}

function expandHome(path: string, home: string): string {
	return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/**
 * The messages written for Grokbot that name a code: one row each, never fatal.
 *
 * A code counts when the queue owns its series (VH, VD, DQ) or when a live ask
 * already carries it: prose that happens to mention a letter and a digit must not
 * become a queue item. A done ask's code no longer registers, so a reused code
 * shows up as an item and is reviewed.
 */
function outboxRows(musterStateDir: string): ParsedListRow[] {
	let messages: { id: string; text: string }[];
	try {
		messages = listInboxMessages(musterStateDir, OUTBOX_AGENT).slice(0, MAX_OUTBOX_MESSAGES);
	} catch {
		return [];
	}
	const registered = new Set<string>();
	try {
		for (const ask of readAsks(musterStateDir).asks) {
			if (ask.code !== undefined && !CLOSED_ASK_STATUSES.includes(ask.status)) registered.add(ask.code);
		}
	} catch {
		// A queue that cannot be read registers no code; the series still does.
	}
	const rows: ParsedListRow[] = [];
	for (const message of messages) {
		const codes = [...new Set(message.text.match(OUTBOX_CODE) ?? [])].filter(
			(token) => QUEUE_SERIES.test(token) || registered.has(token),
		);
		if (codes.length === 0) continue;
		const question = firstLine(message.text);
		if (question === "") continue;
		rows.push({ token: `inbox/${OUTBOX_AGENT}/${message.id}`, code: codes[0]!, question, struck: false });
	}
	return rows;
}

function firstLine(text: string): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed !== "") return trimmed.slice(0, MAX_FINDING_TEXT);
	}
	return "";
}

/** The bar a text match must clear: the import script's own (`textMatch`). */
export function textMatchCounts(text: string, question: string): boolean {
	const match = textMatch(text, question);
	const threshold = match.shorterSize <= 1 ? 0.5 : 0.7;
	return match.score >= threshold && (match.shorterSize <= 1 || match.exactWords > 0);
}

/** Does an item already answer to an open ask: its code, its source line, or its words? */
export function matchesWaiting(item: SweepItem, waiting: readonly Ask[]): boolean {
	return waiting.some((ask) => {
		if (item.codes.length > 0 && ask.code !== undefined && item.codes.includes(ask.code)) return true;
		if (sourceTokensOf(ask).includes(item.source)) return true;
		return textMatchCounts(item.text, ask.question);
	});
}

/** `path:line`, with the `#k` a token carries when one line holds several items. */
export function parseSourceToken(token: string): { file: string; line: number } | undefined {
	const withoutItem = token.replace(/#\d+$/, "");
	const at = withoutItem.lastIndexOf(":");
	if (at < 1) return undefined;
	const file = withoutItem.slice(0, at).trim();
	const line = Number(withoutItem.slice(at + 1).trim());
	return file !== "" && Number.isInteger(line) && line > 0 ? { file, line } : undefined;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A line that settles this code: a struck code, or a DQ line whose status is not `open`. */
function settledLine(line: string, code: string | undefined): boolean {
	if (code === undefined) return false;
	const escaped = escapeRegExp(code);
	if (new RegExp(`~~\\s*${escaped}\\s*~~`).test(line)) return true;
	return new RegExp(`^${escaped}\\s*\\|\\s*(done|settled|answered|closed|withdrawn)\\b`, "i").test(line.trim());
}

/**
 * An open ask whose own list line is struck, settled or gone: the second half of
 * the diff. A snapshot section is matched by its text, because a replace-only
 * snapshot moves its lines; every other list keeps its recorded line. A file that
 * cannot be read cannot say a line is gone, so it is silent.
 */
function settledFinding(
	ask: Ask,
	files: Map<string, string>,
	sections: ReadonlyMap<string, readonly SweepItem[]>,
): SweepFinding | undefined {
	const readFile = (path: string): string | undefined => {
		const cached = files.get(path);
		if (cached !== undefined) return cached;
		let text: string | undefined;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			return undefined;
		}
		files.set(path, text);
		return text;
	};

	for (const token of sourceTokensOf(ask)) {
		const place = parseSourceToken(token);
		if (place === undefined) continue;
		const text = readFile(place.file);
		if (text === undefined) continue;
		const section = sections.get(place.file);
		if (section !== undefined) {
			if (livesInSection(section, ask)) continue;
			return { finding: "may-be-done", source: token, text: `${ask.question} — the item is gone from the section` };
		}
		const line = text.split("\n")[place.line - 1];
		if (line === undefined || line.trim() === "") {
			return { finding: "may-be-done", source: token, text: `${ask.question} — the source line is gone` };
		}
		if (settledLine(line, ask.code) || /~~/.test(line)) {
			return { finding: "may-be-done", source: token, text: line.trim().slice(0, MAX_FINDING_TEXT) };
		}
	}
	if (ask.code !== undefined) {
		for (const [path, text] of files) {
			const lines = text.split("\n");
			const at = lines.findIndex((candidate) => settledLine(candidate, ask.code));
			if (at >= 0) {
				return { finding: "may-be-done", source: `${path}:${at + 1}`, text: lines[at]!.trim().slice(0, MAX_FINDING_TEXT) };
			}
		}
	}
	return undefined;
}

/**
 * A list whose items live in one section of a replace-only snapshot rather than at
 * a fixed line: the design snapshot's `## the operator's list` section and the
 * orchestrator snapshot's `Waits on the operator:` line. A line number is no evidence
 * there, because the snapshot is replaced whole and the section moves; the ask's
 * code or id is what stays (AK10).
 */
function isSectionSource(source: ListSource): boolean {
	return "parse" in source && (source.parse === parseDesignSnapshot || source.parse === parseOrchestratorSnapshot);
}

/** `ask_` plus the first 8 hex of the id: the shorthand a snapshot may cite. */
const ASK_ID_SHORT_LENGTH = 12;

/** The id forms a section may carry: the id in full, and its `ask_` plus 8-hex form. */
function askIdForms(ask: Ask): string[] {
	return [ask.id, ask.id.slice(0, ASK_ID_SHORT_LENGTH)];
}

/**
 * Does the section still carry the ask (AK10): its code, or its id in full or as
 * `ask_` plus the first 8 hex. Both snapshots are rewritten whole at every
 * update, so their lines move and a line number is no evidence; the code or the
 * id is what stays behind. The code is matched whole, so `H1` is not found inside
 * `H10`.
 */
function livesInSection(rows: readonly SweepItem[], ask: Ask): boolean {
	return rows.some((row) => {
		if (ask.code !== undefined) {
			if (row.codes.includes(ask.code)) return true;
			const asToken = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(ask.code)}(?![A-Za-z0-9])`);
			if (asToken.test(row.text)) return true;
		}
		return askIdForms(ask).some((form) => row.text.includes(form));
	});
}

function dedupeFindings(findings: readonly SweepFinding[]): SweepFinding[] {
	const seen = new Map<string, SweepFinding>();
	for (const finding of findings) {
		const key = `${finding.finding}\u0000${finding.source}\u0000${finding.text}`;
		if (!seen.has(key)) seen.set(key, finding);
	}
	return [...seen.values()].sort(
		(left, right) =>
			left.finding.localeCompare(right.finding) ||
			left.source.localeCompare(right.source) ||
			left.text.localeCompare(right.text),
	);
}

/**
 * The deterministic file diff: every live item of every list that matches no
 * open ask, and every open ask whose own list line is struck or gone. It reads
 * and compares; it writes nothing and never changes an ask's status.
 */
export function diffLists(musterStateDir: string, options: { sources: readonly ListSource[]; queue?: AskQueue }): ListDiff {
	const queue = options.queue ?? readAsks(musterStateDir, { cardState: programmeCardReader() });
	const waiting = waitingOnOperator(queue);
	const findings: SweepFinding[] = [];
	const items: SweepItem[] = [];
	const sources: SweepSourceReport[] = [];
	const files = new Map<string, string>();
	const sections = new Map<string, SweepItem[]>();
	let matched = 0;

	for (const source of options.sources) {
		let rows: ParsedListRow[] = [];
		if ("parse" in source) {
			let text: string | undefined;
			try {
				text = readFileSync(source.path, "utf8");
			} catch {
				text = undefined;
			}
			if (text === undefined) {
				sources.push({ path: source.path, items: 0, missing: true });
				continue;
			}
			files.set(source.path, text);
			try {
				rows = source.parse(source.path, text);
			} catch {
				rows = [];
			}
		} else {
			try {
				rows = source.items();
			} catch {
				rows = [];
			}
		}
		const live = rows.filter((row) => !row.struck);
		sources.push({ path: source.path, items: live.length, missing: false });
		const section = isSectionSource(source) ? [] : undefined;
		if (section !== undefined) sections.set(source.path, section);
		for (const row of live) {
			const item: SweepItem = {
				source: row.token,
				codes: nonEmpty(row.code) ? [row.code] : [],
				text: row.question,
			};
			items.push(item);
			section?.push(item);
			if (matchesWaiting(item, waiting)) {
				matched += 1;
				continue;
			}
			findings.push({ finding: "not-in-queue", source: item.source, text: item.text });
		}
	}

	for (const ask of waiting) {
		const settled = settledFinding(ask, files, sections);
		if (settled !== undefined) findings.push(settled);
	}

	const unique = dedupeFindings(findings);
	return {
		findings: unique,
		items,
		matched,
		notInQueue: unique.filter((finding) => finding.finding === "not-in-queue").length,
		mayBeDone: unique.filter((finding) => finding.finding === "may-be-done").length,
		waiting: waiting.length,
		sources,
	};
}

/** One count with the noun it counts: `1 item`, `3 items`. */
export function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The one accounting line a run prints: every item and every finding, counted. */
export function formatFileDiffAccounting(diff: ListDiff, recorded: ReviewAppendResult): string {
	const read = diff.sources.filter((source) => !source.missing).length;
	const missing = diff.sources.length - read;
	return [
		"asks sweep --files",
		`${plural(diff.sources.length, "list")} (${read} read${missing > 0 ? `, ${missing} missing` : ""})`,
		plural(diff.items.length, "item"),
		`${diff.matched} matched an open ask of ${diff.waiting}`,
		`${diff.notInQueue} not-in-queue`,
		`${diff.mayBeDone} may-be-done`,
		`${recorded.appended.length} written to the review list, ${recorded.alreadyThere} already there`,
	].join(", ");
}
