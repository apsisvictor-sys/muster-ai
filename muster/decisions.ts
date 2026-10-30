/**
 * Programme decision records (plan §7 P1.3, plan §5 D3 same-chat decisions).
 *
 * The P1.1 control record keeps reference-only decision links (`DecisionRef`).
 * This store owns the decision itself: the typed kind, the question, concrete
 * option IDs, the recommendation, the blocked task IDs, the scope revision and
 * the authenticated transport answer reference. One file per programme keeps
 * decision writes from contending with continuation transitions on
 * `control/<programmeId>.json`.
 *
 * Storage: `<agentDir>/state/muster/programmes/<programmeId>.decisions.json`
 * (the folder is core's `programmesStateDir()`, the one owner, so
 * `PI_AGILE_PROGRAMMES_DIR` moves it too; `PI_MUSTER_DECISIONS_DIR` is this
 * store's own seam), the same directory the relay inbox/outbox logs use. Every
 * transition goes through the shared compare-and-set
 * store (`fileCasStore` in `owner-fence.ts`, the primitive `control.ts` uses),
 * which serializes it through the repository's locked atomic write.
 * A malformed record fails closed with a typed error and is never reset.
 *
 * Store-then-deliver: `openDecision` returns only after the record is durably
 * persisted; it never returns an ID whose write failed. Answers are idempotent
 * by `answerRef.transport + answerRef.platformMessageId`, so a replayed
 * transport event cannot apply twice; a different answer to an already-closed
 * decision is a typed conflict, not a second application.
 *
 * Decision cards and operator defaults (release plan §R4) live here too,
 * because this file is the decision's only owner: `reversible`,
 * `autoApplyAt` and `autoApplied` are record fields, the card text is the
 * record rendered for a human, and the deadline policy is one function. The
 * tick delivers cards and fires defaults through these; it keeps no policy of
 * its own. `autoApplied` is derived from the answer's transport, so the record
 * and the answer it holds can never disagree about who applied a card.
 *
 * Standalone by design: no Pi API, no socket, no control-record or Concord
 * coupling. `bridge.ts` is the receive-path caller in this phase; linking a
 * decision to the control record (`recordDecisionRef`/`applyDecisionRef`) and
 * releasing blocked tasks belong to the P1.2 wiring step.
 */

import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import {
	DECISION_KINDS,
	type DecisionKind,
	type DecisionOption,
	type OpenDecisionInput,
	type ScopeRevision,
} from "../core/decision-types.ts";
import { programmesStateDir } from "../core/programme.ts";
import { fileCasStore } from "./owner-fence.ts";

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export const PROGRAMME_DECISIONS_SCHEMA_VERSION = 2 as const;
/** Files written before the R4 card fields still read; they gain them as defaults. */
const LEGACY_SCHEMA_VERSION = 1;
const ACCEPTED_SCHEMA_VERSIONS: readonly number[] = [LEGACY_SCHEMA_VERSION, PROGRAMME_DECISIONS_SCHEMA_VERSION];
/** Hours a reversible card waits for the operator before its recommendation applies (R4). */
export const DECISION_DEFAULT_AUTO_APPLY_HOURS = 2;
/** A card outside this range of hours is a mistake, not a decision. */
const MAX_AUTO_APPLY_HOURS = 24 * 7;
/** Only a product question may answer itself. Production data, deploys,
 * spending, credentials and human logins are the operator's alone, whatever a
 * record claims about reversibility. */
const AUTO_APPLIABLE_KINDS: readonly DecisionKind[] = ["product-decision"];
/** The only transport that counts as an operator default rather than an answer. */
export const AUTO_APPLY_TRANSPORT = "auto-apply";
export const OPERATOR_DEFAULT_ACTOR_ID = "operator-default";

const PROGRAMME_ID_PATTERN = /^agp_[0-9a-f]{12}$/;
/** Compare-and-set attempts before a contended transition is reported. */
const CAS_ATTEMPTS = 5;

/**
 * Authenticated transport reference for an answer. Pi never derives any of
 * these fields from message text; they come from the transport metadata the
 * relay hook matched against its own binding.
 */
export type DecisionAnswerRef = {
	transport: string;
	platformMessageId: string;
	actorId: string;
	channelId: string;
	threadId: string;
	receivedAt: string;
};

export type DecisionStatus = "open" | "applied";

export type DecisionRecord = {
	decisionId: string;
	kind: DecisionKind;
	question: string;
	options: DecisionOption[];
	recommendation: string;
	blockedTaskIds: string[];
	scopeRevision: ScopeRevision;
	status: DecisionStatus;
	/**
	 * True when this card's own recommendation may apply without an answer.
	 * A schema-1 record reads as false: nothing written before R4 auto-applies.
	 */
	reversible: boolean;
	/**
	 * When the recommendation applies itself, or null when it never does
	 * (irreversible, or a kind only the operator may answer).
	 */
	autoApplyAt: string | null;
	/**
	 * The configured length of the response window in hours. Recorded so that a
	 * window re-armed at delivery keeps advertising the same hours it was
	 * configured with; a record written before this field reads it back as the
	 * difference between its deadline and its creation.
	 */
	autoApplyHours?: number;
	/** True when the recommendation, not a person, closed the card. */
	autoApplied: boolean;
	/** Set once, together with `appliedOptionId` and `appliedAt`. */
	answerRef: DecisionAnswerRef | null;
	appliedOptionId: string | null;
	appliedAt: string | null;
	createdAt: string;
	updatedAt: string;
};

export type ProgrammeDecisionsFile = {
	schemaVersion: typeof PROGRAMME_DECISIONS_SCHEMA_VERSION;
	programmeId: string;
	/** Compare-and-set revision; every persisted transition increments it. */
	revision: number;
	decisions: DecisionRecord[];
	createdAt: string;
	updatedAt: string;
};

// ─── Results ─────────────────────────────────────────────────────────────────

export type OpenDecisionResult = {
	decisionId: string;
	/** Current file revision after the write. */
	revision: number;
	/** True when an unchanged open request already existed and was returned instead. */
	deduplicated: boolean;
};

export type ApplyDecisionAnswerResult = {
	decisionId: string;
	optionId: string;
	/** False for an idempotent replay of an already-applied answer. */
	applied: boolean;
	duplicate: boolean;
	status: "applied";
	appliedAt: string;
	revision: number;
	answerRef: DecisionAnswerRef;
};

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Typed decision-store failure, shaped like `ProgrammeControlStateError`:
 * - `missing`: no decision file or no such decision exists;
 * - `malformed`: persisted JSON is unreadable or fails validation (never reset);
 * - `conflict`: the decision is already closed with a different answer;
 * - `refused`: an operator default that policy does not allow (R4);
 * - `io`: invalid input or filesystem failure.
 */
export class ProgrammeDecisionStateError extends Error {
	constructor(
		readonly code: "missing" | "malformed" | "conflict" | "io" | "refused",
		message: string,
	) {
		super(message);
		this.name = "ProgrammeDecisionStateError";
	}
}

// ─── Store ───────────────────────────────────────────────────────────────────

export type ProgrammeDecisionStore = {
	dir: string;
	/** Fresh disk read; `undefined` when no decision file exists yet. */
	read(programmeId: string): ProgrammeDecisionsFile | undefined;
	/**
	 * Atomic compare-and-set. `expectedRevision === undefined` creates a new
	 * file; otherwise the stored revision must match exactly.
	 */
	update(
		programmeId: string,
		expectedRevision: number | undefined,
		mutate: (current: ProgrammeDecisionsFile | undefined) => ProgrammeDecisionsFile,
	): ProgrammeDecisionsFile;
};

/**
 * `PI_MUSTER_DECISIONS_DIR` is this store's test seam, mirroring
 * `PI_MUSTER_CONTROL_DIR`; otherwise the folder is core's one owner.
 */
export function programmeDecisionStateDir(): string {
	const override = process.env.PI_MUSTER_DECISIONS_DIR?.trim();
	if (override) return resolve(override);
	return programmesStateDir();
}

export function programmeDecisionFilePath(programmeId: string, dir = programmeDecisionStateDir()): string {
	assertProgrammeId(programmeId);
	return join(dir, `${programmeId}.decisions.json`);
}

export function fileProgrammeDecisionStore(dir = programmeDecisionStateDir()): ProgrammeDecisionStore {
	return fileCasStore<ProgrammeDecisionsFile>({
		dir,
		idPattern: PROGRAMME_ID_PATTERN,
		idKind: "programme",
		noun: "programme decisions",
		recordNoun: "file",
		fileName: (programmeId) => programmeDecisionFilePath(programmeId, dir),
		validate: (raw) => {
			const validated = validateProgrammeDecisionsFile(raw);
			return validated.ok ? { ok: true, record: validated.file } : { ok: false, errors: validated.errors };
		},
		errorClass: ProgrammeDecisionStateError,
	});
}

// ─── Validation ──────────────────────────────────────────────────────────────

const FILE_KEYS = new Set(["schemaVersion", "programmeId", "revision", "decisions", "createdAt", "updatedAt"]);
const DECISION_KEYS = new Set([
	"decisionId",
	"kind",
	"question",
	"options",
	"recommendation",
	"blockedTaskIds",
	"scopeRevision",
	"status",
	"reversible",
	"autoApplyAt",
	"autoApplyHours",
	"autoApplied",
	"answerRef",
	"appliedOptionId",
	"appliedAt",
	"createdAt",
	"updatedAt",
]);
const OPTION_KEYS = new Set(["id", "label", "recommendation"]);
const ANSWER_REF_KEYS = new Set(["transport", "platformMessageId", "actorId", "channelId", "threadId", "receivedAt"]);
const OPEN_DECISION_KEYS = new Set([
	"kind",
	"question",
	"options",
	"recommendation",
	"blockedTaskIds",
	"scopeRevision",
	"reversible",
	"autoApplyHours",
]);
const DECISION_STATUSES: readonly DecisionStatus[] = ["open", "applied"];

/**
 * Validate a durable decisions file. Unknown fields and any structural
 * deviation fail closed, so a tampered or foreign file is never treated as a
 * valid decision set.
 */
export function validateProgrammeDecisionsFile(
	input: unknown,
): { ok: true; file: ProgrammeDecisionsFile } | { ok: false; errors: string[] } {
	const errors: string[] = [];
	if (!isPlainObject(input)) return { ok: false, errors: ["file must be an object"] };
	const extra = unknownKeys(input, FILE_KEYS);
	if (extra.length > 0) errors.push(`file has unknown fields: ${extra.join(", ")}`);
	if (!ACCEPTED_SCHEMA_VERSIONS.includes(input.schemaVersion as number)) {
		errors.push(`file.schemaVersion must be ${ACCEPTED_SCHEMA_VERSIONS.join(" or ")}`);
	}
	if (!nonEmptyString(input.programmeId) || !PROGRAMME_ID_PATTERN.test(input.programmeId)) {
		errors.push("file.programmeId must match agp_<12 hex>");
	}
	if (!Number.isInteger(input.revision) || (input.revision as number) < 1) {
		errors.push("file.revision must be a positive integer");
	}
	if (!nonEmptyString(input.createdAt)) errors.push("file.createdAt must be a non-empty string");
	if (!nonEmptyString(input.updatedAt)) errors.push("file.updatedAt must be a non-empty string");
	if (!Array.isArray(input.decisions)) {
		errors.push("file.decisions must be an array");
	} else {
		const seen = new Set<string>();
		const legacy = (input as { schemaVersion: number }).schemaVersion === LEGACY_SCHEMA_VERSION;
		input.decisions.forEach((decision, index) => {
			validateDecision(decision, `file.decisions[${index}]`, seen, errors, legacy);
		});
	}
	if (errors.length > 0) return { ok: false, errors };
	// A schema-1 record carries no card fields; they read as "waits for a person",
	// and the next transition persists the current schema.
	const normalized = (input as { schemaVersion: number }).schemaVersion === LEGACY_SCHEMA_VERSION
		? { ...(cloneJson(input) as unknown as ProgrammeDecisionsFile), schemaVersion: PROGRAMME_DECISIONS_SCHEMA_VERSION, decisions: input.decisions.map((decision) => ({ ...(cloneJson(decision) as DecisionRecord), reversible: false, autoApplyAt: null, autoApplied: false })) }
		: (cloneJson(input) as unknown as ProgrammeDecisionsFile);
	return { ok: true, file: normalized };
}

function validateDecision(value: unknown, path: string, seen: Set<string>, errors: string[], legacy = false): void {
	if (!isPlainObject(value)) {
		errors.push(`${path} must be an object`);
		return;
	}
	const extra = unknownKeys(value, DECISION_KEYS);
	if (extra.length > 0) errors.push(`${path} has unknown fields: ${extra.join(", ")}`);
	if (!nonEmptyString(value.decisionId)) errors.push(`${path}.decisionId must be a non-empty string`);
	else if (seen.has(value.decisionId)) errors.push(`${path}.decisionId is duplicated: ${value.decisionId}`);
	else seen.add(value.decisionId);
	if (!oneOf(DECISION_KINDS, value.kind)) errors.push(`${path}.kind is invalid`);
	if (!nonEmptyString(value.question)) errors.push(`${path}.question must be a non-empty string`);
	const optionIds = validateOptions(value.options, `${path}.options`, errors);
	if (!nonEmptyString(value.recommendation)) errors.push(`${path}.recommendation must be a non-empty string`);
	validateStringList(value.blockedTaskIds, `${path}.blockedTaskIds`, errors);
	if (!validScopeRevision(value.scopeRevision)) errors.push(`${path}.scopeRevision must be a non-empty string or integer`);
	if (!oneOf(DECISION_STATUSES, value.status)) errors.push(`${path}.status must be open or applied`);
	if (!legacy) {
		if (typeof value.reversible !== "boolean") errors.push(`${path}.reversible must be a boolean`);
		if (value.autoApplyAt !== null && !nonEmptyString(value.autoApplyAt)) {
			errors.push(`${path}.autoApplyAt must be null or a non-empty string`);
		}
		if (typeof value.autoApplied !== "boolean") errors.push(`${path}.autoApplied must be a boolean`);
		if (value.autoApplyHours !== undefined && (typeof value.autoApplyHours !== "number" || !Number.isFinite(value.autoApplyHours) || value.autoApplyHours <= 0)) {
			errors.push(`${path}.autoApplyHours must be a positive number when present`);
		}
		if (value.autoApplied === true && value.answerRef === null) errors.push(`${path}.autoApplied requires answerRef`);
		if (value.reversible === false && value.autoApplyAt !== null) {
			errors.push(`${path}.reversible false must carry autoApplyAt null`);
		}
		if (!oneOf(AUTO_APPLIABLE_KINDS, value.kind) && value.autoApplyAt !== null) {
			errors.push(`${path}.autoApplyAt must be null for kind ${String(value.kind)}: only a product decision may answer itself`);
		}
	}
	validateAnswerRef(value.answerRef, `${path}.answerRef`, errors);
	if (value.appliedOptionId !== null && !nonEmptyString(value.appliedOptionId)) {
		errors.push(`${path}.appliedOptionId must be null or a non-empty string`);
	}
	if (value.appliedAt !== null && !nonEmptyString(value.appliedAt)) {
		errors.push(`${path}.appliedAt must be null or a non-empty string`);
	}
	if (value.status === "applied") {
		if (value.answerRef === null) errors.push(`${path} applied requires answerRef`);
		if (value.appliedAt === null) errors.push(`${path} applied requires appliedAt`);
		if (value.appliedOptionId === null) errors.push(`${path} applied requires appliedOptionId`);
		else if (typeof value.appliedOptionId === "string" && !optionIds.includes(value.appliedOptionId)) {
			errors.push(`${path}.appliedOptionId is not one of the declared options: ${value.appliedOptionId}`);
		}
	} else {
		if (value.answerRef !== null) errors.push(`${path} open must not carry answerRef`);
		if (value.appliedOptionId !== null) errors.push(`${path} open must not carry appliedOptionId`);
		if (value.appliedAt !== null) errors.push(`${path} open must not carry appliedAt`);
	}
	if (!nonEmptyString(value.createdAt)) errors.push(`${path}.createdAt must be a non-empty string`);
	if (!nonEmptyString(value.updatedAt)) errors.push(`${path}.updatedAt must be a non-empty string`);
}

function validateOptions(value: unknown, path: string, errors: string[]): string[] {
	if (!Array.isArray(value) || value.length === 0) {
		errors.push(`${path} must be a non-empty array`);
		return [];
	}
	const ids: string[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const option = value[index];
		const optionPath = `${path}[${index}]`;
		if (!isPlainObject(option)) {
			errors.push(`${optionPath} must be an object`);
			continue;
		}
		const extra = unknownKeys(option, OPTION_KEYS);
		if (extra.length > 0) errors.push(`${optionPath} has unknown fields: ${extra.join(", ")}`);
		if (!nonEmptyString(option.id)) errors.push(`${optionPath}.id must be a non-empty string`);
		else if (ids.includes(option.id)) errors.push(`${optionPath}.id is duplicated: ${option.id}`);
		else ids.push(option.id);
		if (!nonEmptyString(option.label)) errors.push(`${optionPath}.label must be a non-empty string`);
		if (option.recommendation !== undefined && !nonEmptyString(option.recommendation)) {
			errors.push(`${optionPath}.recommendation must be a non-empty string when present`);
		}
	}
	return ids;
}

function validateStringList(value: unknown, path: string, errors: string[]): void {
	if (!Array.isArray(value)) {
		errors.push(`${path} must be an array`);
		return;
	}
	const seen = new Set<string>();
	for (const entry of value) {
		if (!nonEmptyString(entry)) {
			errors.push(`${path} entries must be non-empty strings`);
			return;
		}
		if (seen.has(entry)) {
			errors.push(`${path} has a duplicate entry: ${entry}`);
			return;
		}
		seen.add(entry);
	}
}

function validateAnswerRef(value: unknown, path: string, errors: string[]): void {
	if (value === null) return;
	if (!isPlainObject(value)) {
		errors.push(`${path} must be null or an object`);
		return;
	}
	const extra = unknownKeys(value, ANSWER_REF_KEYS);
	if (extra.length > 0) errors.push(`${path} has unknown fields: ${extra.join(", ")}`);
	for (const field of ANSWER_REF_KEYS) {
		if (!nonEmptyString(value[field])) errors.push(`${path}.${field} must be a non-empty string`);
	}
}

// ─── Operations ──────────────────────────────────────────────────────────────

/**
 * Open one decision and persist it before returning. An unchanged open request
 * (same kind, question, options, recommendation, blocked task IDs and scope
 * revision) returns the existing decision instead of duplicating it.
 */
export function openDecision(
	programmeId: string,
	input: OpenDecisionInput,
	context?: ProgrammeDecisionContext,
): OpenDecisionResult {
	assertProgrammeId(programmeId);
	const normalized = normalizeOpenDecisionInput(input);
	const store = resolveProgrammeDecisionStore(context);
	const now = new Date().toISOString();
	let lastConflict: string | undefined;
	for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
		const current = store.read(programmeId);
		if (current !== undefined) {
			const existing = current.decisions.find(
				(decision) => decision.status === "open" && sameOpenRequest(decision, normalized),
			);
			if (existing !== undefined) {
				return { decisionId: existing.decisionId, revision: current.revision, deduplicated: true };
			}
		}
		const decisionId = `dec_${randomUUID()}`;
		const decisions = [...(current?.decisions ?? []), newDecisionRecord(decisionId, normalized, now)];
		const next: ProgrammeDecisionsFile = current === undefined
			? { schemaVersion: PROGRAMME_DECISIONS_SCHEMA_VERSION, programmeId, revision: 1, decisions, createdAt: now, updatedAt: now }
			: { ...current, decisions, revision: current.revision + 1, updatedAt: now };
		try {
			const record = store.update(programmeId, current?.revision, () => next);
			return { decisionId, revision: record.revision, deduplicated: false };
		} catch (error) {
			if (error instanceof ProgrammeDecisionStateError && error.code === "conflict") {
				lastConflict = error.message;
				continue;
			}
			throw error;
		}
	}
	throw new ProgrammeDecisionStateError(
		"conflict",
		`Programme decision open contended for ${programmeId}: ${lastConflict ?? "revision conflict"}`,
	);
}

/** Open decisions, oldest first. A missing file is an empty set, not an error. */
export function listOpenDecisions(programmeId: string, context?: ProgrammeDecisionContext): DecisionRecord[] {
	assertProgrammeId(programmeId);
	const file = resolveProgrammeDecisionStore(context).read(programmeId);
	if (file === undefined) return [];
	return file.decisions
		.filter((decision) => decision.status === "open")
		.sort((left, right) =>
			left.createdAt === right.createdAt
				? left.decisionId.localeCompare(right.decisionId)
				: left.createdAt.localeCompare(right.createdAt),
		);
}

/** Fresh disk read of one decision; throws typed `missing` when absent. */
export function getDecision(programmeId: string, decisionId: string, context?: ProgrammeDecisionContext): DecisionRecord {
	assertProgrammeId(programmeId);
	if (!nonEmptyString(decisionId)) throw invalidInput("getDecision requires a non-empty decisionId");
	const file = resolveProgrammeDecisionStore(context).read(programmeId);
	if (file === undefined) {
		throw new ProgrammeDecisionStateError("missing", `No programme decisions file for ${programmeId}`);
	}
	const decision = file.decisions.find((candidate) => candidate.decisionId === decisionId);
	if (decision === undefined) {
		throw new ProgrammeDecisionStateError("missing", `Unknown decision ${decisionId} for ${programmeId}`);
	}
	return decision;
}

/**
 * Start a card's response window at the moment its question was actually
 * delivered. The window belongs to the operator reading the card, not to the record
 * being written: a card that sat undelivered through an outage gets the full
 * advertised window from its delivery instead of a deadline that expired while
 * he could not read it. A card delivered inside its original window keeps that
 * window, so the tick cannot shorten or re-roll a deadline that is still ahead.
 */
export function armDecisionWindow(
	programmeId: string,
	decisionId: string,
	deliveredAt: string | number,
	context?: ProgrammeDecisionContext,
): DecisionRecord {
	assertProgrammeId(programmeId);
	if (!nonEmptyString(decisionId)) throw invalidInput("armDecisionWindow requires a non-empty decisionId");
	const at = typeof deliveredAt === "number" ? deliveredAt : Date.parse(deliveredAt);
	if (!Number.isFinite(at)) throw invalidInput("armDecisionWindow requires a delivery time");
	const store = resolveProgrammeDecisionStore(context);
	const result = store.update(programmeId, store.read(programmeId)?.revision, (current) => {
		if (current === undefined) throw new ProgrammeDecisionStateError("missing", `No programme decisions file for ${programmeId}`);
		const decision = current.decisions.find((candidate) => candidate.decisionId === decisionId);
		if (decision === undefined) throw new ProgrammeDecisionStateError("missing", `Unknown decision ${decisionId} for ${programmeId}`);
		if (decision.status !== "open") return current;
		if (decision.autoApplyAt === null) return current;
		const hours = decision.autoApplyHours ?? (Date.parse(decision.autoApplyAt) - Date.parse(decision.createdAt)) / 3_600_000;
		if (!Number.isFinite(hours) || hours <= 0) return current;
		const armedAt = new Date(at + hours * 3_600_000).toISOString();
		if (armedAt <= decision.autoApplyAt) return current;
		return {
			...current,
			decisions: current.decisions.map((candidate) => candidate.decisionId === decisionId
				? { ...candidate, autoApplyAt: armedAt, updatedAt: new Date(at).toISOString() }
				: candidate),
			revision: current.revision + 1,
		};
	});
	const armed = result.decisions.find((candidate) => candidate.decisionId === decisionId);
	if (armed === undefined) throw new ProgrammeDecisionStateError("missing", `Unknown decision ${decisionId} for ${programmeId}`);
	return armed;
}

/**
 * Apply one authenticated answer. Idempotent by
 * `answerRef.transport + answerRef.platformMessageId`: a replay of the same
 * message for the same option returns the stored result without writing.
 * Any other answer to an already-closed decision is a typed conflict, so a
 * stale or cross-programme reply can never re-open or re-apply authority.
 */
export function applyDecisionAnswer(
	programmeId: string,
	decisionId: string,
	optionId: string,
	answerRef: DecisionAnswerRef,
	context?: ProgrammeDecisionContext,
): ApplyDecisionAnswerResult {
	assertProgrammeId(programmeId);
	if (!nonEmptyString(decisionId)) throw invalidInput("applyDecisionAnswer requires a non-empty decisionId");
	if (!nonEmptyString(optionId)) throw invalidInput("applyDecisionAnswer requires a non-empty optionId");
	const ref = normalizeAnswerRef(answerRef);
	const store = resolveProgrammeDecisionStore(context);
	const now = new Date().toISOString();
	let lastConflict: string | undefined;
	for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
		const current = store.read(programmeId);
		if (current === undefined) {
			throw new ProgrammeDecisionStateError("missing", `No programme decisions file for ${programmeId}`);
		}
		const index = current.decisions.findIndex((candidate) => candidate.decisionId === decisionId);
		if (index < 0) {
			throw new ProgrammeDecisionStateError("missing", `Unknown decision ${decisionId} for ${programmeId}`);
		}
		const decision = current.decisions[index];
		if (!decision.options.some((option) => option.id === optionId)) {
			throw invalidInput(`Unknown optionId ${optionId} for decision ${decisionId}`);
		}
		if (decision.status === "applied") {
			const stored = decision.answerRef;
			const sameMessage = stored !== null
				&& stored.transport === ref.transport
				&& stored.platformMessageId === ref.platformMessageId;
			if (sameMessage && decision.appliedOptionId === optionId) {
				return {
					decisionId,
					optionId,
					applied: false,
					duplicate: true,
					status: "applied",
					appliedAt: decision.appliedAt ?? now,
					revision: current.revision,
					answerRef: stored,
				};
			}
			throw new ProgrammeDecisionStateError(
				"conflict",
				`Decision ${decisionId} is already closed with option ${decision.appliedOptionId ?? "unknown"}; stale answer rejected`,
			);
		}
		const applied: DecisionRecord = {
			...decision,
			status: "applied",
			// Derived, never passed: the record's "who applied it" cannot disagree
			// with the authenticated answer it stores.
			autoApplied: decision.answerRef === null && ref.transport === AUTO_APPLY_TRANSPORT,
			answerRef: ref,
			appliedOptionId: optionId,
			appliedAt: now,
			updatedAt: now,
		};
		const next: ProgrammeDecisionsFile = {
			...current,
			decisions: current.decisions.map((candidate, candidateIndex) => (candidateIndex === index ? applied : candidate)),
			revision: current.revision + 1,
			updatedAt: now,
		};
		try {
			const record = store.update(programmeId, current.revision, () => next);
			return {
				decisionId,
				optionId,
				applied: true,
				duplicate: false,
				status: "applied",
				appliedAt: now,
				revision: record.revision,
				answerRef: ref,
			};
		} catch (error) {
			if (error instanceof ProgrammeDecisionStateError && error.code === "conflict") {
				lastConflict = error.message;
				continue;
			}
			throw error;
		}
	}
	throw new ProgrammeDecisionStateError(
		"conflict",
		`Programme decision answer contended for ${programmeId}: ${lastConflict ?? "revision conflict"}`,
	);
}

// ─── Cards, deadlines and operator defaults (R4) ────────────────────────────

/**
 * The card the operator reads in the thread: the id he answers with, the question,
 * every option with its label, the recommendation, whether the card applies
 * itself and when, and the exact command. One line per fact, no prose that
 * could be read as an instruction.
 */
export function decisionCardText(record: DecisionRecord, project?: string): string {
	const projectPart = project === undefined || project === "" ? "" : ` · ${project}`;
	const options = record.options.map((option) => `- ${option.id} — ${option.label}`).join("\n");
	const lines = [
		`[Muster decision ${record.decisionId}${projectPart}]`,
		record.question,
		"",
		"Options:",
		options,
		"",
		`Recommended: ${record.recommendation}`,
	];
	lines.push(record.autoApplyAt === null ? "This one waits for your answer." : deadlineLine(record));
	if (record.options.some((option) => option.id === record.recommendation)) {
		lines.push(`Answer with: /decide ${record.decisionId} ${record.recommendation}`);
	}
	return lines.join("\n");
}

/** The sentence that says the card answers itself, and when. */
function deadlineLine(record: DecisionRecord): string {
	const hours = Math.max(1, Math.round(record.autoApplyHours ?? (Date.parse(record.autoApplyAt as string) - Date.parse(record.createdAt)) / 3_600_000));
	return `Reversible: applies itself in ${hours}h (${record.autoApplyAt}) unless you answer first; the record then says an operator default did it.`;
}

/**
 * Open cards whose recommendation may apply now: reversible, a product
 * question, still open, and past their deadline. An unknown file or a
 * malformed one throws; a caller that wants silence catches it.
 */
export function autoAppliableDecisions(
	programmeId: string,
	now: number,
	context?: ProgrammeDecisionContext,
): DecisionRecord[] {
	return listOpenDecisions(programmeId, context).filter((decision) => {
		if (!decision.reversible) return false;
		if (!AUTO_APPLIABLE_KINDS.includes(decision.kind)) return false;
		if (decision.autoApplyAt === null) return false;
		return now >= Date.parse(decision.autoApplyAt);
	});
}

/**
 * Apply one card's recommendation at its deadline. This is the same single
 * write as answering a card, under a reserved transport, so the first
 * application stands, a repeated pass is a duplicate, and a human answer that
 * arrived first is a conflict. Refuses (never applies) when the card is not due
 * yet, is irreversible, is not a product question, or recommends free text
 * rather than one of its options.
 */
export function applyDecisionDefault(
	programmeId: string,
	decisionId: string,
	threadId: string,
	context?: ProgrammeDecisionContext,
	now: number = Date.now(),
): ApplyDecisionAnswerResult {
	const decision = getDecision(programmeId, decisionId, context);
	if (decision.status !== "applied") {
		if (!AUTO_APPLIABLE_KINDS.includes(decision.kind)) {
			throw new ProgrammeDecisionStateError(
				"refused",
				`Decision ${decisionId} is a ${decision.kind} and is never auto-applied; only a product decision may answer itself`,
			);
		}
		if (!decision.reversible) {
			throw new ProgrammeDecisionStateError("refused", `Decision ${decisionId} is not reversible and is never auto-applied`);
		}
		if (decision.autoApplyAt === null) {
			throw new ProgrammeDecisionStateError("refused", `Decision ${decisionId} carries no deadline and is never auto-applied`);
		}
		if (now < Date.parse(decision.autoApplyAt)) {
			throw new ProgrammeDecisionStateError(
				"refused",
				`Decision ${decisionId} is not yet due (deadline ${decision.autoApplyAt})`,
			);
		}
		if (!decision.options.some((option) => option.id === decision.recommendation)) {
			throw new ProgrammeDecisionStateError(
				"refused",
				`Decision ${decisionId} recommends free text, not one of its options, so nothing auto-applies`,
			);
		}
	}
	return applyDecisionAnswer(programmeId, decisionId, decision.recommendation, {
		transport: AUTO_APPLY_TRANSPORT,
		platformMessageId: `${AUTO_APPLY_TRANSPORT}/${decisionId}`,
		actorId: OPERATOR_DEFAULT_ACTOR_ID,
		channelId: OPERATOR_DEFAULT_ACTOR_ID,
		threadId: nonEmptyString(threadId) ? threadId : OPERATOR_DEFAULT_ACTOR_ID,
		receivedAt: new Date(now).toISOString(),
	}, context);
}

// ─── Context and helpers ─────────────────────────────────────────────────────

export type ProgrammeDecisionContext = {
	/** Explicit store (tests, isolated programmes); defaults to the real root. */
	store?: ProgrammeDecisionStore;
};

function resolveProgrammeDecisionStore(context: ProgrammeDecisionContext | undefined): ProgrammeDecisionStore {
	return context?.store ?? fileProgrammeDecisionStore();
}

function newDecisionRecord(decisionId: string, input: OpenDecisionInput, now: string): DecisionRecord {
	const reversible = input.reversible ?? false;
	const hours = input.autoApplyHours ?? DECISION_DEFAULT_AUTO_APPLY_HOURS;
	// Only a product question carries a deadline. Everything else has nothing to fire.
	const deadline = reversible && AUTO_APPLIABLE_KINDS.includes(input.kind)
		? new Date(Date.parse(now) + hours * 60 * 60 * 1000).toISOString()
		: null;
	return {
		decisionId,
		kind: input.kind,
		question: input.question,
		options: input.options,
		recommendation: input.recommendation,
		blockedTaskIds: input.blockedTaskIds,
		scopeRevision: input.scopeRevision,
		status: "open",
		reversible,
		autoApplyAt: deadline,
		...(deadline === null ? {} : { autoApplyHours: hours }),
		autoApplied: false,
		answerRef: null,
		appliedOptionId: null,
		appliedAt: null,
		createdAt: now,
		updatedAt: now,
	};
}

function sameOpenRequest(decision: DecisionRecord, input: OpenDecisionInput): boolean {
	if (decision.kind !== input.kind) return false;
	if (decision.question !== input.question) return false;
	if (decision.recommendation !== input.recommendation) return false;
	if (decision.scopeRevision !== input.scopeRevision) return false;
	if (decision.reversible !== (input.reversible ?? false)) return false;
	if (decision.blockedTaskIds.length !== input.blockedTaskIds.length) return false;
	if (!decision.blockedTaskIds.every((taskId, index) => taskId === input.blockedTaskIds[index])) return false;
	if (decision.options.length !== input.options.length) return false;
	return decision.options.every((option, index) => {
		const candidate = input.options[index];
		return option.id === candidate.id
			&& option.label === candidate.label
			&& (option.recommendation ?? null) === (candidate.recommendation ?? null);
	});
}

function normalizeOpenDecisionInput(input: OpenDecisionInput): OpenDecisionInput {
	if (!isPlainObject(input)) throw invalidInput("openDecision requires an input object");
	const extra = unknownKeys(input, OPEN_DECISION_KEYS);
	if (extra.length > 0) throw invalidInput(`openDecision input has unknown fields: ${extra.join(", ")}`);
	if (!oneOf(DECISION_KINDS, input.kind)) {
		throw invalidInput(`openDecision kind must be one of: ${DECISION_KINDS.join(", ")}`);
	}
	if (!nonEmptyString(input.question)) throw invalidInput("openDecision requires a non-empty question");
	if (!Array.isArray(input.options) || input.options.length === 0) {
		throw invalidInput("openDecision requires a non-empty options array");
	}
	const optionIds = new Set<string>();
	const options: DecisionOption[] = input.options.map((option, index) => {
		if (!isPlainObject(option)) throw invalidInput(`openDecision options[${index}] must be an object`);
		const optionExtra = unknownKeys(option, OPTION_KEYS);
		if (optionExtra.length > 0) {
			throw invalidInput(`openDecision options[${index}] has unknown fields: ${optionExtra.join(", ")}`);
		}
		if (!nonEmptyString(option.id)) throw invalidInput(`openDecision options[${index}].id must be a non-empty string`);
		if (optionIds.has(option.id)) throw invalidInput(`openDecision option id is duplicated: ${option.id}`);
		optionIds.add(option.id);
		if (!nonEmptyString(option.label)) throw invalidInput(`openDecision options[${index}].label must be a non-empty string`);
		if (option.recommendation !== undefined && !nonEmptyString(option.recommendation)) {
			throw invalidInput(`openDecision options[${index}].recommendation must be a non-empty string when present`);
		}
		const normalized: DecisionOption = { id: option.id, label: option.label };
		if (option.recommendation !== undefined) normalized.recommendation = option.recommendation;
		return normalized;
	});
	if (!nonEmptyString(input.recommendation)) throw invalidInput("openDecision requires a non-empty recommendation");
	if (!Array.isArray(input.blockedTaskIds)) throw invalidInput("openDecision blockedTaskIds must be an array");
	const blockedTaskIds: string[] = [];
	for (const taskId of input.blockedTaskIds) {
		if (!nonEmptyString(taskId)) throw invalidInput("openDecision blockedTaskIds entries must be non-empty strings");
		if (blockedTaskIds.includes(taskId)) throw invalidInput(`openDecision blockedTaskIds has a duplicate entry: ${taskId}`);
		blockedTaskIds.push(taskId);
	}
	if (!validScopeRevision(input.scopeRevision)) {
		throw invalidInput("openDecision scopeRevision must be a non-empty string or an integer");
	}
	if (input.reversible !== undefined && typeof input.reversible !== "boolean") {
		throw invalidInput("openDecision reversible must be a boolean when present");
	}
	const reversible = input.reversible ?? false;
	if (input.autoApplyHours !== undefined) {
		if (typeof input.autoApplyHours !== "number" || !Number.isFinite(input.autoApplyHours)) {
			throw invalidInput("openDecision autoApplyHours must be a finite number when present");
		}
		if (input.autoApplyHours <= 0 || input.autoApplyHours > MAX_AUTO_APPLY_HOURS) {
			throw invalidInput(`openDecision autoApplyHours must be greater than 0 and at most ${MAX_AUTO_APPLY_HOURS}`);
		}
		if (!reversible) {
			throw invalidInput("openDecision autoApplyHours needs reversible: true; an irreversible card never applies itself");
		}
		if (!AUTO_APPLIABLE_KINDS.includes(input.kind)) {
			throw invalidInput(`openDecision autoApplyHours is not allowed for kind ${input.kind}: only a product decision may answer itself`);
		}
	}
	return {
		kind: input.kind,
		question: input.question,
		options,
		recommendation: input.recommendation,
		blockedTaskIds: blockedTaskIds.slice().sort(),
		scopeRevision: input.scopeRevision,
		reversible,
		...(input.autoApplyHours !== undefined ? { autoApplyHours: input.autoApplyHours } : {}),
	};
}

function normalizeAnswerRef(value: DecisionAnswerRef): DecisionAnswerRef {
	if (!isPlainObject(value)) throw invalidInput("applyDecisionAnswer requires an answerRef object");
	const extra = unknownKeys(value, ANSWER_REF_KEYS);
	if (extra.length > 0) throw invalidInput(`applyDecisionAnswer answerRef has unknown fields: ${extra.join(", ")}`);
	const transport = value.transport;
	const platformMessageId = value.platformMessageId;
	const actorId = value.actorId;
	const channelId = value.channelId;
	const threadId = value.threadId;
	const receivedAt = value.receivedAt;
	if (!nonEmptyString(transport)) throw invalidInput("applyDecisionAnswer answerRef.transport must be a non-empty string");
	if (!nonEmptyString(platformMessageId)) {
		throw invalidInput("applyDecisionAnswer answerRef.platformMessageId must be a non-empty string");
	}
	if (!nonEmptyString(actorId)) throw invalidInput("applyDecisionAnswer answerRef.actorId must be a non-empty string");
	if (!nonEmptyString(channelId)) throw invalidInput("applyDecisionAnswer answerRef.channelId must be a non-empty string");
	if (!nonEmptyString(threadId)) throw invalidInput("applyDecisionAnswer answerRef.threadId must be a non-empty string");
	if (!nonEmptyString(receivedAt)) throw invalidInput("applyDecisionAnswer answerRef.receivedAt must be a non-empty string");
	return { transport, platformMessageId, actorId, channelId, threadId, receivedAt };
}

function validScopeRevision(value: unknown): value is ScopeRevision {
	if (nonEmptyString(value)) return true;
	return typeof value === "number" && Number.isInteger(value);
}

function assertProgrammeId(programmeId: string): void {
	if (typeof programmeId !== "string" || !PROGRAMME_ID_PATTERN.test(programmeId)) {
		throw new ProgrammeDecisionStateError("io", `invalid programme id: ${String(programmeId)}`);
	}
}

function invalidInput(message: string): ProgrammeDecisionStateError {
	return new ProgrammeDecisionStateError("io", message);
}

// ─── Small helpers (mirrors control.ts conventions) ──────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

function unknownKeys(value: Record<string, unknown>, known: ReadonlySet<string>): string[] {
	return Object.keys(value).filter((key) => !known.has(key));
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
	return typeof value === "string" && (values as readonly string[]).includes(value);
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}
