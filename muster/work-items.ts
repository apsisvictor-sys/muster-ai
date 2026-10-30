/**
 * The work-item registry (out-loop spec Revision 3, §7a and §10 row OL8; VR24-222 as amended by
 * VR24-229): one validated record per item a lane can be launched from.
 *
 * One record per item, stored under its code. The ledger holds it while the ledger is live
 * (`WORK_ITEM_STORE`), the files store under `<muster state>/work-items/` otherwise, switched the way
 * `goals.ts` switches. The store, its record shape and its writers are the spec's §7a contract, so
 * adding them is not an undecided data-shape change.
 *
 * CUTOVER (the operator 04:00 2026-10-29, all planning is Scrum): the record carries the three fields the command
 * center ranks and burns down by - `priority`, `points` and `sprint` - so the ledger's work items are the one
 * queue. They are version 2, and a version 1 record written before them is read through
 * `migrateWorkItemRecord`, which fills the three at their defaults and changes nothing else.
 *
 * The §7a fields are one table (`WORK_ITEM_FIELDS`): the validator reads it, `muster schema` prints it,
 * and a field without a check fails at module load, so the vocabulary a surface renders and the
 * vocabulary a record is refused against are the same list.
 *
 * R2's review identity is the one addition outside that table: `review` is a nested field the table's
 * fixed §7a list does not carry, and it is refused by the one rule in `reviewFamilyProblem`. Its values are
 * model families the record never renders to the operator as prose, and the record carries whatever the R2 builder
 * chose, so the table keeps the spec's list and the rule keeps one statement.
 *
 * Every write reads the record, builds the next one and hands the store the revision it read, never
 * `put`. A write that lost the race is refused with the store's conflict error and changes nothing.
 *
 * The writer is the process: the operator's shell, the architect, the orchestrator or Henry's gateway. A lane
 * is refused, as it is on goals (`resolveGoalWriter`).
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { musterStateDir, validateAgentId } from "./binding.ts";
import { CONTRACT_TABLE, DERIVED_CONTRACTS } from "./health/contracts.ts";
import { readBackend } from "./ledger/backend.ts";
import { ledgerCasStore, type LedgerCasStore } from "./ledger/cas-store.ts";
import { ownerLedgerSocket, WORK_ITEM_STORE } from "./ledger/stores.ts";
import { fileCasStore, type CasStore } from "./owner-fence.ts";
import { resolveSeatWriter, type SeatContext, type SeatRole } from "./seats.ts";

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/** The version this module writes, as `muster schema work-item` prints it. Version 2 added the three Scrum fields. */
export const WORK_ITEM_SCHEMA_VERSION = 2 as const;

/** The code the operator sees: one capital letter, then capitals, digits and dashes (spec §7a). */
export const WORK_ITEM_CODE_PATTERN = /^[A-Z][A-Z0-9-]{1,23}$/;

/** What kind of work the item is, so a dispatcher can pick a lane without reading the prose. */
export const WORK_ITEM_KINDS = ["build", "fix", "review", "research", "ops"] as const;
export type WorkItemKind = (typeof WORK_ITEM_KINDS)[number];

/**
 * The families R2 knows (VR24-229 item 5, amended by Henry 2026-10-29 01:36): what a model label belongs to. An
 * author or a parent may be any of them; a reviewer is one of `REVIEW_CANDIDATES` and never the pair's.
 */
export const REVIEW_FAMILIES = ["deepseek", "mimo", "glm", "minimax"] as const;
export type ReviewFamily = (typeof REVIEW_FAMILIES)[number];

/**
 * The families a reviewer may run on, in preference order, and whether each resolves here (Henry, 2026-10-29
 * 01:36, correcting the 00:23 wording): mimo — opencode-go/mimo-v2.6-flash — is the one that runs on this
 * machine; the free Zen GLM label — opencode/glm-5.3-flash-free — is the named free option and cannot serve a
 * Pi lane (FreeTierError, the operator 2026-10-18), so it is a candidate that does not resolve; beam-free is the
 * routing fallback. DeepSeek is an author's or a parent's family, never the reviewer's.
 */
export const REVIEW_CANDIDATES = [
	{ family: "mimo", resolves: true, why: "opencode-go/mimo-v2.6-flash runs on this machine" },
	{ family: "glm", resolves: false, why: "opencode/glm-5.3-flash-free cannot serve a Pi lane (FreeTierError, the operator 2026-10-18)" },
] as const satisfies readonly { family: ReviewFamily; resolves: boolean; why: string }[];
export type ReviewCandidate = (typeof REVIEW_CANDIDATES)[number]["family"];
/** The candidate families in preference order: who may appear as a reviewer on a record. */
export const REVIEW_CANDIDATE_FAMILIES: readonly ReviewCandidate[] = REVIEW_CANDIDATES.map((candidate) => candidate.family);
/** The candidates that can run here: the weekly audit rotates over these. */
export const REVIEW_RESOLVING_FAMILIES: readonly ReviewCandidate[] = REVIEW_CANDIDATES.filter((candidate) => candidate.resolves).map(
	(candidate) => candidate.family,
);

/**
 * The family a model belongs to, read from the model's own name. `undefined` when it names none of the known
 * families: the caller refuses and says which identity it could not read, never guesses a family. The free Zen
 * GLM label reads as family glm, which is a candidate that cannot serve a Pi lane.
 */
export function reviewFamilyOf(model: string | null | undefined): ReviewFamily | undefined {
	if (typeof model !== "string") return undefined;
	const name = model.trim().toLowerCase();
	if (name === "") return undefined;
	return REVIEW_FAMILIES.find((family) => name.includes(family));
}

/**
 * R2's review identity: the author's family and the parent's (both or neither — the weekly audit of a
 * subsystem has no author session) and the reviewer's, which differs from both.
 */
export type ReviewIdentity = { author?: ReviewFamily; parent?: ReviewFamily; reviewer?: ReviewFamily };

/**
 * The reviewer's family: the first candidate, in preference order, that differs from both the author's and the
 * parent's and can run here. When both differ, mimo wins, so the choice is deterministic and DeepSeek never
 * reviews. With none left (mimo authors, and the GLM label cannot serve a Pi lane), nothing independent exists
 * to review, and the refusal says exactly that: the operator's flag for the collision is a refusal, never a same-family
 * review.
 */
export function chooseReviewFamily(author: ReviewFamily, parent: ReviewFamily): ReviewCandidate {
	const differing = REVIEW_CANDIDATES.filter((candidate) => candidate.family !== author && candidate.family !== parent);
	const chosen = differing.find((candidate) => candidate.resolves);
	if (chosen === undefined) {
		const because =
			differing.length === 0
				? `no candidate family (${REVIEW_CANDIDATE_FAMILIES.join(", ")}) differs from both`
				: `the one left, ${differing.map((candidate) => `${candidate.family}, ${candidate.why}`).join("; ")}, does not resolve, and beam-free is the fallback`;
		throw invalid(`no independent reviewer family available: the author is ${author} and the parent ${parent}, and ${because}`);
	}
	return chosen.family;
}

/** The change classes a brief states (methodology.md, "Checks match the size of the change"). */
export const WORK_ITEM_CLASSES = ["H1", "H2", "H3", "H4", "H5"] as const;
export type WorkItemClass = (typeof WORK_ITEM_CLASSES)[number];

/**
 * The rank the queue is ordered by (CUTOVER): `P0` first, `P3` last. The record owns this ladder - no other
 * module holds a second priority vocabulary - and an item nobody ranked sits at the default, so a default never
 * promotes work above an item someone ranked.
 */
export const WORK_ITEM_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type WorkItemPriority = (typeof WORK_ITEM_PRIORITIES)[number];
export const WORK_ITEM_DEFAULT_PRIORITY: WorkItemPriority = "P3";

/**
 * A sprint id: lower case, so one sprint has one spelling, and bounded, so a cell stays a cell. Empty while the
 * item is in no sprint - the backlog before a sprint takes it up.
 */
export const WORK_ITEM_SPRINT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/** `points` while nobody estimated the item: the one meaning of 0, so no second "unestimated" flag exists. */
export const WORK_ITEM_UNESTIMATED_POINTS = 0;

/** The harness a lane runs on; `pi` when the item does not say. */
export const WORK_ITEM_HARNESSES = ["pi", "opencode", "claude"] as const;
export type WorkItemHarness = (typeof WORK_ITEM_HARNESSES)[number];
export const WORK_ITEM_DEFAULT_HARNESS: WorkItemHarness = "pi";

/**
 * The labels the operator reads (the operator, 2026-10-29): the board's one vocabulary. A label is what a work item's state
 * means; `gated` and `dropped` carry their reason in the state's own prefix, and `done` closes an increment no
 * probe can answer (a docs-only one goes merged, then done). The label a record actually stands in is computed
 * from evidence by `work-item-state.ts` — never read off the stored claim, which is why a record can hold a
 * claim its evidence does not back and still say so.
 */
export const WORK_ITEM_LABELS = ["planned", "queued", "in build", "in review", "sent for fix", "approved", "merged", "live", "done", "gated", "dropped"] as const;
export type WorkItemLabel = (typeof WORK_ITEM_LABELS)[number];

/**
 * The encodings the current writers write: the dispatcher's `ready`/`launch-uncertain`, the hand-table
 * backfill's `idea`/`draft`/`gated:...`, and `done`. Every one of them maps to a label through
 * `workItemStateLabel`, so a record written by an older writer keeps reading on every surface.
 */
export const LEGACY_WORK_ITEM_STATES = ["draft", "ready", "launch-uncertain", "done", "idea"] as const;
export type LegacyWorkItemState = (typeof LEGACY_WORK_ITEM_STATES)[number];

/** The vocabulary `muster schema` prints: the labels, with the prefixed forms below carrying their argument. */
export const WORK_ITEM_STATES = WORK_ITEM_LABELS;
export type WorkItemState = WorkItemLabel | LegacyWorkItemState;
/** The prefixes that carry an argument: `gated:<reason code>`, `launched:<lane>` and `dropped:<reason>`. */
export const WORK_ITEM_STATE_PREFIXES = ["gated:", "launched:", "dropped:"] as const;
/** The state a record is created in: captured, and planned once a plan names it. */
export const WORK_ITEM_INITIAL_STATE: LegacyWorkItemState = "draft";
/** The state an item is filed in when it is ready to dispatch: the empty-slot wake counts these rows as work nobody launched. */
export const WORK_ITEM_READY_STATE: LegacyWorkItemState = "ready";

/**
 * The reason codes a `gated` state carries (the operator, 2026-10-29): who has to act, or `after:<work item code>`
 * for an item that waits on another one. A state written before the codes existed keeps its free-text reason
 * and reads as gated with no code — the reconciler says which, the drift check reports it.
 */
export const GATED_REASON_CODES = ["needs-operators-ok", "needs-decision", "needs-credential", "wrong-owner"] as const;
export type GatedReasonCode = (typeof GATED_REASON_CODES)[number];
/** The prefix of a gate that waits on another work item: `after:<CODE>`. */
export const GATED_AFTER_PREFIX = "after:";
/** The prefix of a dropped item, whose reason names what replaced it or why it is not wanted. */
export const DROPPED_PREFIX = "dropped:";

/**
 * The states a create may name: an item is filed ready to dispatch, or captured as an idea. Every other
 * state belongs to a record that is already under way, so a create refuses it.
 */
export const WORK_ITEM_CREATE_STATES = ["ready", "idea"] as const;
export type WorkItemCreateState = (typeof WORK_ITEM_CREATE_STATES)[number];

export const WORK_ITEM_VERBS = ["create", "state"] as const;
export type WorkItemVerb = (typeof WORK_ITEM_VERBS)[number];

/** Who wrote a change: the operator's shell, a seat holding its credential, Henry's gateway, or the tick's dispatcher (OL2). */
export type WorkItemWriter = "operator-shell" | SeatRole | "grokbot" | "tick";
/** The processes that may write a work item. A lane is not one of them; the tick writes the two launch states (OL2). */
export const WORK_ITEM_WRITERS: readonly string[] = ["operator-shell", "architect", "orchestrator", "grokbot", "tick"];

const LAUNCHED_LANE_PATTERN = /^launched:[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const GATED_REASON_MAX = 120;

// ─── The §7a fields, one table ───────────────────────────────────────────────

/** Which side of the contract a field belongs to: what the operator reads, or what the machine acts on. */
export type WorkItemAudience = "operator" | "machine";
export type WorkItemFieldType = "code" | "line" | "enum" | "list" | "count" | "number" | "state";

export type WorkItemField = {
	name: string;
	audience: WorkItemAudience;
	type: WorkItemFieldType;
	/** The rule, in one sentence, as `muster schema` prints it. */
	rule: string;
};

export const WORK_ITEM_FIELDS: readonly WorkItemField[] = [
	{ name: "code", audience: "operator", type: "code", rule: "one capital letter, then capitals, digits or dashes, 2 to 24 characters (`^[A-Z][A-Z0-9-]{1,23}$`)" },
	{ name: "heading", audience: "operator", type: "line", rule: "one non-empty line: the item in one sentence" },
	{ name: "summary", audience: "operator", type: "line", rule: "one non-empty line under the heading: where the work stands and its detail" },
	{ name: "goal", audience: "operator", type: "line", rule: "the goal it serves: a goal code from the goal registry, or the sprint goal the hand table named before the registry had a code" },
	{ name: "project", audience: "machine", type: "line", rule: "the project the item is tracked in, as the register names it" },
	{ name: "kind", audience: "machine", type: "enum", rule: `one of ${WORK_ITEM_KINDS.join(", ")}` },
	{ name: "class", audience: "machine", type: "enum", rule: `one of ${WORK_ITEM_CLASSES.join(", ")}: the change class a brief states` },
	{ name: "priority", audience: "machine", type: "enum", rule: `one of ${WORK_ITEM_PRIORITIES.join(", ")}: ${WORK_ITEM_PRIORITIES[0]} first and ${WORK_ITEM_DEFAULT_PRIORITY} last; ${WORK_ITEM_DEFAULT_PRIORITY} when the item does not say` },
	{ name: "points", audience: "machine", type: "number", rule: "a whole number of 0 or more: the item's estimate, and 0 while nobody estimated it" },
	{ name: "sprint", audience: "machine", type: "line", rule: "the sprint id the item is planned into: lower-case letters, digits, dot, dash or underscore, 1 to 32 characters; empty while the item is in no sprint" },
	{ name: "harness", audience: "machine", type: "enum", rule: `one of ${WORK_ITEM_HARNESSES.join(", ")}; ${WORK_ITEM_DEFAULT_HARNESS} when the item does not say` },
	{ name: "acceptance", audience: "machine", type: "line", rule: "one non-empty line: what proves the item done" },
	{ name: "source", audience: "machine", type: "line", rule: "where the item came from: a path, a ruling or a message" },
	{ name: "brief", audience: "machine", type: "line", rule: "the brief file a lane launches with; empty while the item has none" },
	{ name: "ownedPaths", audience: "machine", type: "list", rule: "the paths the lane owns; empty while the item owns none" },
	{ name: "dependencies", audience: "machine", type: "list", rule: "the work items, or the conditions, it waits on; each one line" },
	{ name: "attempt", audience: "machine", type: "count", rule: "1 or more: which attempt this item is on" },
	{ name: "state", audience: "machine", type: "state", rule: `${WORK_ITEM_LABELS.join(", ")}, \`gated:<reason code>\`, \`dropped:<reason>\` or \`launched:<lane>\`` },
] as const;

export type WorkItemFieldName = (typeof WORK_ITEM_FIELDS)[number]["name"];

// ─── The record ──────────────────────────────────────────────────────────────

export type WorkItemEvent = { at: string; by: WorkItemWriter; verb: WorkItemVerb; detail: string };

export type WorkItemRecord = {
	schemaVersion: typeof WORK_ITEM_SCHEMA_VERSION;
	revision: number;
	code: string;
	heading: string;
	summary: string;
	goal: string;
	project: string;
	kind: WorkItemKind;
	class: WorkItemClass;
	/**
	 * The three fields Scrum needs (CUTOVER): the rank the queue is ordered by, the estimate the burndown sums, and
	 * the sprint that holds the item. A version 1 record gains them through `migrateWorkItemRecord` on read, so
	 * every record a surface reads carries all three.
	 */
	priority: WorkItemPriority;
	points: number;
	sprint: string;
	harness: WorkItemHarness;
	/**
	 * R2's review identity, carried only by `kind: review`: the author's family and the parent's (both or neither)
	 * and the reviewer's, which differs from both. Absent until a family is chosen, and the dispatcher then holds
	 * the item. One nested field, so the §7a table stays the spec's list.
	 */
	review?: ReviewIdentity;
	acceptance: string;
	source: string;
	brief: string;
	ownedPaths: string[];
	dependencies: string[];
	attempt: number;
	state: string;
	/** Who changed what, in order. One field more than §7a: the sibling owners keep their audit trail. */
	events: WorkItemEvent[];
};

export class WorkItemStateError extends Error {
	constructor(
		readonly code: "missing" | "malformed" | "conflict" | "io" | "invalid",
		message: string,
	) {
		super(message);
		this.name = "WorkItemStateError";
	}
}

// ─── Validation of a stored record ───────────────────────────────────────────

const RECORD_KEYS = new Set<string>(["schemaVersion", "revision", "events", "review", ...WORK_ITEM_FIELDS.map((field) => field.name)]);
const EVENT_KEYS = new Set(["at", "by", "verb", "detail"]);

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const oneLine = (value: string): boolean => !/[\u0000-\u001f\u007f\u2028\u2029]/.test(value);
const nonEmptyLine = (value: unknown): value is string => typeof value === "string" && value.trim() !== "" && oneLine(value);
const line = (value: unknown): value is string => typeof value === "string" && oneLine(value);
const isTime = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

/** True for one of the operator's labels (2026-10-29). */
export function isWorkItemLabel(value: unknown): value is WorkItemLabel {
	return typeof value === "string" && (WORK_ITEM_LABELS as readonly string[]).includes(value);
}

/**
 * Why a gate's reason is not a reason code (the operator, 2026-10-29), or undefined when it is one: a code from
 * `GATED_REASON_CODES`, or `after:<CODE>` naming another work item.
 */
export function gatedCodeProblem(reason: string): string | undefined {
	if ((GATED_REASON_CODES as readonly string[]).includes(reason)) return undefined;
	if (reason.startsWith(GATED_AFTER_PREFIX)) {
		const code = reason.slice(GATED_AFTER_PREFIX.length);
		return WORK_ITEM_CODE_PATTERN.test(code) ? undefined : `after: must name a work item code (one capital letter, then capitals, digits or dashes), not ${JSON.stringify(code)}`;
	}
	return `must be one of ${GATED_REASON_CODES.join(", ")} or ${GATED_AFTER_PREFIX}<work item code>, not ${JSON.stringify(reason)}`;
}

/**
 * Why a gate's stored reason cannot be read at all, or undefined: a reason is one line of 1 to 120 characters.
 * A free-text reason is accepted here because the records written before the codes existed carry one; the code
 * rule is `gatedCodeProblem`, and the reconciler reports a free reason as a gate with no code.
 */
function gatedReasonProblem(reason: string): string | undefined {
	if (reason.length === 0) return "must not be empty";
	if (reason.length > GATED_REASON_MAX) return `must be at most ${GATED_REASON_MAX} characters`;
	if (!oneLine(reason) || reason.trim() !== reason) return "must be one line with no surrounding space";
	return undefined;
}

/** Why a dropped item's stored reason cannot be read, or undefined: it names what replaced the item or why it is not wanted. */
function droppedReasonProblem(reason: string): string | undefined {
	return gatedReasonProblem(reason);
}

/**
 * The label a stored state stands for: the state itself when it is one, else the encoding it came in. One
 * mapping, so a record written by the dispatcher (`ready`, `launch-uncertain`, `launched:<lane>`) and a record
 * filed by the backfill (`idea`, `draft`, `gated:...`) read as the same vocabulary the operator sees.
 */
export function workItemStateLabel(state: string): WorkItemLabel {
	if (isWorkItemLabel(state)) return state;
	switch (state) {
		case "draft":
		case "idea":
			return "planned";
		case "ready":
			return "queued";
		case "launch-uncertain":
			return "in build";
		case "done":
			return "done";
	}
	if (state.startsWith("launched:")) return "in build";
	if (state.startsWith("gated:")) return "gated";
	if (state.startsWith(DROPPED_PREFIX)) return "dropped";
	// The validator refuses every other string, so this is the captured state rather than a guess.
	return "planned";
}

/**
 * The reason code a stored gate's reason maps to, or undefined when it names none. The mapping is mechanical and
 * only reads the reason: `dep:<X>` and `after-<x>` become `after:<CODE>` when they shape as a code, a reason that
 * names the operator or a credential becomes that code, and every other free reason has no code. The drift check is
 * what says whether an `after:<CODE>` names a work item that exists.
 */
export function gateReasonCode(reason: string): string | undefined {
	const text = reason.trim();
	if (gatedCodeProblem(text) === undefined) return text;
	const lower = text.toLowerCase();
	const after = lower.startsWith("dep:") ? text.slice("dep:".length) : lower.startsWith("after-") ? text.slice("after-".length) : undefined;
	if (after !== undefined) {
		const code = after
			.trim()
			.replace(/[\s_:]+/g, "-")
			.toUpperCase();
		return WORK_ITEM_CODE_PATTERN.test(code) ? `${GATED_AFTER_PREFIX}${code}` : undefined;
	}
	if (lower.startsWith("operator") || lower.includes("operators-ok") || lower.includes("operator's ok")) return "needs-operators-ok";
	if (lower.includes("credential") || lower.includes("login") || lower.includes("token")) return "needs-credential";
	if (lower.startsWith("wrong-owner") || lower.includes("not-ours")) return "wrong-owner";
	return undefined;
}

/** A stored state: a label, a legacy encoding, `gated:<reason>`, `launched:<lane>` or `dropped:<reason>`. */
export function isWorkItemState(value: unknown): value is string {
	if (typeof value !== "string") return false;
	if (isWorkItemLabel(value)) return true;
	if ((LEGACY_WORK_ITEM_STATES as readonly string[]).includes(value)) return true;
	if (value.startsWith("launched:")) return LAUNCHED_LANE_PATTERN.test(value);
	if (value.startsWith("gated:")) return gatedReasonProblem(value.slice("gated:".length)) === undefined;
	if (value.startsWith(DROPPED_PREFIX)) return droppedReasonProblem(value.slice(DROPPED_PREFIX.length)) === undefined;
	return false;
}

/** True for a state a create may name: the pair above and nothing else. */
export function isWorkItemCreateState(value: unknown): value is WorkItemCreateState {
	return typeof value === "string" && (WORK_ITEM_CREATE_STATES as readonly string[]).includes(value);
}

/** The one-line rule of every `state` a caller may write, for a refusal that says what it wanted. */
export const WORK_ITEM_STATE_RULE = `${WORK_ITEM_LABELS.join(", ")}, gated:<reason code>, dropped:<reason> or launched:<lane>`;

const stringList = (value: unknown, what: string): string | undefined => {
	if (!Array.isArray(value)) return `${what} must be an array of one-line strings`;
	for (const entry of value) {
		if (!nonEmptyLine(entry)) return `${what} must be an array of one-line strings, and every entry must not be empty`;
	}
	if (new Set(value as string[]).size !== (value as string[]).length) return `${what} must not repeat an entry`;
	return undefined;
};

/**
 * One check per §7a field. The table above is the list of fields; this map is the rule for each. The
 * module refuses to load when the two disagree, so no field is ever printed by `muster schema` without
 * being enforced, and no field is enforced without being printed.
 */
const FIELD_CHECKS: Record<string, (value: unknown) => string | undefined> = {
	code: (value) => (typeof value === "string" && WORK_ITEM_CODE_PATTERN.test(value) ? undefined : "must be one capital letter, then capitals, digits or dashes (2 to 24 characters)"),
	heading: (value) => (nonEmptyLine(value) ? undefined : "must be one non-empty line"),
	summary: (value) => (nonEmptyLine(value) ? undefined : "must be one non-empty line"),
	goal: (value) => (nonEmptyLine(value) ? undefined : "must be one non-empty line"),
	project: (value) => (nonEmptyLine(value) ? undefined : "must be one non-empty line"),
	kind: (value) => ((WORK_ITEM_KINDS as readonly unknown[]).includes(value) ? undefined : `must be one of ${WORK_ITEM_KINDS.join(", ")}`),
	class: (value) => ((WORK_ITEM_CLASSES as readonly unknown[]).includes(value) ? undefined : `must be one of ${WORK_ITEM_CLASSES.join(", ")}`),
	priority: (value) => ((WORK_ITEM_PRIORITIES as readonly unknown[]).includes(value) ? undefined : `must be one of ${WORK_ITEM_PRIORITIES.join(", ")}`),
	points: (value) => (Number.isInteger(value) && (value as number) >= 0 ? undefined : "must be a whole number of 0 or more"),
	sprint: (value) => (value === "" || (typeof value === "string" && WORK_ITEM_SPRINT_PATTERN.test(value)) ? undefined : "must be empty, or a lower-case sprint id of letters, digits, dot, dash or underscore (1 to 32 characters)"),
	harness: (value) => ((WORK_ITEM_HARNESSES as readonly unknown[]).includes(value) ? undefined : `must be one of ${WORK_ITEM_HARNESSES.join(", ")}`),
	acceptance: (value) => (nonEmptyLine(value) ? undefined : "must be one non-empty line"),
	source: (value) => (nonEmptyLine(value) ? undefined : "must be one non-empty line"),
	brief: (value) => (line(value) ? undefined : "must be one line (empty while the item has no brief)"),
	ownedPaths: (value) => stringList(value, "ownedPaths"),
	dependencies: (value) => stringList(value, "dependencies"),
	attempt: (value) => (Number.isInteger(value) && (value as number) >= 1 ? undefined : "must be an integer of 1 or more"),
	state: (value) => (isWorkItemState(value) ? undefined : `must be ${WORK_ITEM_STATE_RULE}`),
};

const unchecked = WORK_ITEM_FIELDS.map((field) => field.name).filter((name) => FIELD_CHECKS[name] === undefined);
if (unchecked.length > 0) throw new Error(`work-items: §7a field(s) with no check: ${unchecked.join(", ")}`);

/**
 * The one rule the review identity answers to (R2): the reviewer's family differs from the author's and the
 * parent's, the first two are named together or not at all (the weekly audit of a subsystem names neither), and
 * every family is known and the reviewer's can run here. A review item with no identity yet is a capture — the dispatcher holds it
 * until one is chosen, so nothing launches on a guess. The record validator and the dispatcher both read this.
 */
export function reviewFamilyProblem(input: { kind?: unknown; review?: unknown }): string | undefined {
	const review = input.review;
	if (input.kind !== "review") {
		return review === undefined ? undefined : `record.review is carried only by kind review`;
	}
	if (review === undefined) return undefined;
	if (review === null || typeof review !== "object" || Array.isArray(review)) return `record.review must be {author?, parent?, reviewer}`;
	const row = review as Record<string, unknown>;
	const extra = Object.keys(row).filter((key) => !["author", "parent", "reviewer"].includes(key));
	if (extra.length > 0) return `record.review has unknown fields: ${extra.join(", ")}`;
	for (const key of ["author", "parent"] as const) {
		const value = row[key];
		if (value === undefined) continue;
		if (!(REVIEW_FAMILIES as readonly unknown[]).includes(value)) return `record.review.${key} must be one of ${REVIEW_FAMILIES.join(", ")}`;
	}
	if (row["reviewer"] !== undefined && !(REVIEW_CANDIDATE_FAMILIES as readonly unknown[]).includes(row["reviewer"])) {
		return `record.review.reviewer must be one of ${REVIEW_CANDIDATE_FAMILIES.join(", ")}: DeepSeek is never the reviewer's family`;
	}
	for (const candidate of REVIEW_CANDIDATES) {
		if (row["reviewer"] !== candidate.family || candidate.resolves) continue;
		return `record.review.reviewer family ${candidate.family} cannot review here: ${candidate.why}`;
	}
	const author = row["author"] as ReviewFamily | undefined;
	const parent = row["parent"] as ReviewFamily | undefined;
	const reviewer = row["reviewer"] as ReviewFamily | undefined;
	if ((author === undefined) !== (parent === undefined)) {
		return `record.review.author and record.review.parent are named together or not at all: a review of a work item names both, the weekly audit of a subsystem names neither`;
	}
	if (reviewer !== undefined && reviewer === author) return `record.review.reviewer must differ from record.review.author: a review never runs on the author's family`;
	if (reviewer !== undefined && reviewer === parent) return `record.review.reviewer must differ from record.review.parent: a review never runs on the parent's family`;
	return undefined;
}

/** The three fields CUTOVER added, in the record's order, so the migration names them once. */
const SCRUM_FIELDS = ["priority", "points", "sprint"] as const;
const SCRUM_DEFAULTS = { priority: WORK_ITEM_DEFAULT_PRIORITY, points: WORK_ITEM_UNESTIMATED_POINTS, sprint: "" } as const;

/**
 * A stored record at the version it was written with, as the current version. A version 1 record, written before
 * CUTOVER, gains the three Scrum fields at their defaults and is otherwise carried through untouched, so nothing
 * is dropped and no read fails. A version 1 record that already carries one of them is the other half of
 * "without loss": such a value cannot come from a version 1 writer, so it is refused by name rather than
 * discarded. The next write stores the current version, because every write clones the record it read.
 */
export function migrateWorkItemRecord(input: unknown): { record: unknown; error?: string } {
	if (!isObject(input) || input["schemaVersion"] !== 1) return { record: input };
	const carried = SCRUM_FIELDS.filter((field) => field in input);
	if (carried.length > 0) {
		return { record: input, error: `a version 1 record cannot carry ${carried.join(", ")}: CUTOVER added ${SCRUM_FIELDS.join(", ")} at version ${WORK_ITEM_SCHEMA_VERSION}` };
	}
	return { record: { ...input, schemaVersion: WORK_ITEM_SCHEMA_VERSION, ...SCRUM_DEFAULTS } };
}

/**
 * A stored record fails closed: an unknown field or any structural deviation is `malformed`, and the
 * store never resets it. Every §7a field is required, so a record missing one is refused by name. A version 1
 * record is migrated first (`migrateWorkItemRecord`), so the three Scrum fields are required of everything this
 * module writes and defaulted only for what it reads from before the cutover.
 */
export function validateWorkItemRecord(input: unknown): { ok: true; record: WorkItemRecord } | { ok: false; errors: string[] } {
	const migrated = migrateWorkItemRecord(input);
	if (migrated.error !== undefined) return { ok: false, errors: [migrated.error] };
	const record = migrated.record;
	if (!isObject(record)) return { ok: false, errors: ["record must be an object"] };
	const errors: string[] = [];
	const extra = Object.keys(record).filter((key) => !RECORD_KEYS.has(key));
	if (extra.length > 0) errors.push(`record has unknown fields: ${extra.join(", ")}`);
	if (record["schemaVersion"] !== WORK_ITEM_SCHEMA_VERSION) errors.push(`record.schemaVersion must be ${WORK_ITEM_SCHEMA_VERSION}`);
	if (!Number.isInteger(record["revision"]) || (record["revision"] as number) < 1) errors.push("record.revision must be a positive integer");
	for (const field of WORK_ITEM_FIELDS) {
		if (!(field.name in record)) {
			errors.push(`record.${field.name} is required`);
			continue;
		}
		const problem = FIELD_CHECKS[field.name]!(record[field.name]);
		if (problem !== undefined) errors.push(`record.${field.name} ${problem}`);
	}
	const reviewProblem = reviewFamilyProblem(record);
	if (reviewProblem !== undefined) errors.push(reviewProblem);
	if (!Array.isArray(record["events"])) errors.push("record.events must be an array");
	else {
		for (const event of record["events"]) {
			if (!isObject(event) || Object.keys(event).some((key) => !EVENT_KEYS.has(key))) {
				errors.push("record.events holds an invalid event");
				continue;
			}
			if (!isTime(event["at"])) errors.push("an event.at must be a time");
			if (typeof event["by"] !== "string" || !WORK_ITEM_WRITERS.includes(event["by"])) errors.push(`an event.by must be one of ${WORK_ITEM_WRITERS.join(", ")}`);
			if (typeof event["verb"] !== "string" || !(WORK_ITEM_VERBS as readonly string[]).includes(event["verb"])) errors.push(`an event.verb must be one of ${WORK_ITEM_VERBS.join(", ")}`);
			if (!nonEmptyLine(event["detail"])) errors.push("an event.detail must be one non-empty line");
		}
	}
	return errors.length > 0 ? { ok: false, errors } : { ok: true, record: record as unknown as WorkItemRecord };
}

// ─── Store ───────────────────────────────────────────────────────────────────

export type WorkItemStore = CasStore<WorkItemRecord>;

/** Files-mode location: `<muster state>/work-items/<CODE>.json`. */
export function workItemsDir(stateDir: string = musterStateDir()): string {
	return join(stateDir, "work-items");
}

const storeOptions = {
	idPattern: WORK_ITEM_CODE_PATTERN,
	idKind: "work item",
	noun: "work item",
	validate: validateWorkItemRecord,
	errorClass: WorkItemStateError,
	passThrough: (error: unknown): boolean => error instanceof WorkItemStateError && error.code === "invalid",
} as const;

export function fileWorkItemStore(dir: string = workItemsDir()): WorkItemStore {
	return fileCasStore<WorkItemRecord>({ dir, ...storeOptions });
}

export function ledgerWorkItemStore(socketPath: string): LedgerCasStore<WorkItemRecord> {
	return ledgerCasStore<WorkItemRecord>(WORK_ITEM_STORE, socketPath, storeOptions);
}

/**
 * The work-item store the switch names: the ledger's `work-item` records while `backend.json` says
 * ledger, the files store otherwise. Only the store changes; every rule below is the same in both.
 */
export function workItemStore(dir: string = workItemsDir()): WorkItemStore {
	const stateDir = musterStateDir();
	return readBackend(stateDir) === "ledger" ? ledgerWorkItemStore(ownerLedgerSocket(stateDir)) : fileWorkItemStore(dir);
}

export type WorkItemListing = { items: WorkItemRecord[]; skipped: { id: string; error: string }[] };

/** Every work item, by code. A record that fails to read is listed as skipped, never reset. */
export function listWorkItems(store: WorkItemStore): WorkItemListing {
	const skipped: WorkItemListing["skipped"] = [];
	const items: WorkItemRecord[] = [];
	const ledgerStore = store as Partial<LedgerCasStore<WorkItemRecord>>;
	const tolerantLister = ledgerStore.listWithSkipped;
	if (typeof tolerantLister === "function") {
		const outcome = tolerantLister.call(store);
		for (const row of outcome.rows) items.push(row.record);
		for (const bad of outcome.skipped) skipped.push(bad);
	} else {
		let names: string[] = [];
		try {
			names = readdirSync(store.dir).filter((name) => name.endsWith(".json") && WORK_ITEM_CODE_PATTERN.test(name.slice(0, -".json".length)));
		} catch {
			/* no work items yet */
		}
		for (const name of names) {
			const id = name.slice(0, -".json".length);
			try {
				const item = store.read(id);
				if (item !== undefined) items.push(item);
			} catch (error) {
				skipped.push({ id, error: error instanceof Error ? error.message : String(error) });
			}
		}
	}
	items.sort((left, right) => left.code.localeCompare(right.code));
	return { items, skipped };
}

export function readWorkItem(store: WorkItemStore, code: string): WorkItemRecord | undefined {
	return WORK_ITEM_CODE_PATTERN.test(code) ? store.read(code) : undefined;
}

// ─── Who writes ──────────────────────────────────────────────────────────────

export type WorkItemWriterResolution = { writer: WorkItemWriter } | { error: string };

/** The writer of a work item, from the process it runs in. The rule is the goal registry's. */
export function resolveWorkItemWriter(env: NodeJS.ProcessEnv, agentId: string | undefined, context?: SeatContext): WorkItemWriterResolution {
	return resolveSeatWriter(env, agentId, context, (named) =>
		`${named === "" ? "this session" : named} is not a seat: work items are written by the operator's shell, the architect, the orchestrator or Henry's gateway, and a lane never writes one`,
	) as WorkItemWriterResolution;
}

// ─── Writes ──────────────────────────────────────────────────────────────────

export type WorkItemContext = { by: WorkItemWriter; at?: string };

const invalid = (message: string): WorkItemStateError => new WorkItemStateError("invalid", message);
const timeOf = (context: WorkItemContext): string => context.at ?? new Date().toISOString();

function requireCode(code: string): void {
	if (!WORK_ITEM_CODE_PATTERN.test(code)) throw invalid(`work item code ${JSON.stringify(code)} must be one capital letter, then capitals, digits or dashes (2 to 24 characters)`);
}

export type CreateWorkItemInput = {
	code: string;
	heading: string;
	summary: string;
	goal: string;
	project: string;
	kind: string;
	class: string;
	/** CUTOVER: the rank, the estimate and the sprint. Omitted, the record's defaults stand. */
	priority?: string;
	points?: number;
	sprint?: string;
	harness?: string;
	/** R2: the review identity, when the item is a review of a work item or the weekly audit of a subsystem. */
	review?: ReviewIdentity;
	acceptance: string;
	source: string;
	brief?: string;
	ownedPaths?: readonly string[];
	dependencies?: readonly string[];
	attempt?: number;
	state?: string;
};

/**
 * The record a create would store, validated. One builder: `createWorkItem` writes what this returns,
 * and the hand-table backfill (`work-items-backlog.ts`) builds the same way without writing a store.
 */
export function buildWorkItemRecord(input: CreateWorkItemInput, context: WorkItemContext): WorkItemRecord {
	requireCode(input.code);
	const state = input.state ?? WORK_ITEM_INITIAL_STATE;
	const record: WorkItemRecord = {
		schemaVersion: WORK_ITEM_SCHEMA_VERSION,
		revision: 1,
		code: input.code,
		heading: input.heading,
		summary: input.summary,
		goal: input.goal,
		project: input.project,
		kind: input.kind as WorkItemKind,
		class: input.class as WorkItemClass,
		priority: (input.priority ?? WORK_ITEM_DEFAULT_PRIORITY) as WorkItemPriority,
		points: input.points ?? WORK_ITEM_UNESTIMATED_POINTS,
		sprint: input.sprint ?? "",
		harness: (input.harness ?? WORK_ITEM_DEFAULT_HARNESS) as WorkItemHarness,
		...(input.review !== undefined ? { review: { ...input.review } } : {}),
		acceptance: input.acceptance,
		source: input.source,
		brief: input.brief ?? "",
		ownedPaths: [...(input.ownedPaths ?? [])],
		dependencies: [...(input.dependencies ?? [])],
		attempt: input.attempt ?? 1,
		state,
		events: [{ at: timeOf(context), by: context.by, verb: "create", detail: `created in state ${state}` }],
	};
	const validated = validateWorkItemRecord(record);
	if (!validated.ok) throw invalid(`work item ${input.code} is refused: ${validated.errors.join("; ")}`);
	return record;
}

/**
 * Creates one item. Every §7a field is filled in when it is created: the required ones from the input,
 * `harness` from the record's default, and the rest as the empty value the contract allows. The store
 * refuses a code already taken, because the create carries no revision.
 */
export function createWorkItem(store: WorkItemStore, input: CreateWorkItemInput, context: WorkItemContext): WorkItemRecord {
	const record = buildWorkItemRecord(input, context);
	return store.update(record.code, undefined, () => record);
}

/** Moves one item to a state (§7a's closed set), recording who moved it and, when the caller says, why. */
export function setWorkItemState(store: WorkItemStore, code: string, state: string, context: WorkItemContext, note?: string): WorkItemRecord {
	requireCode(code);
	if (!isWorkItemState(state)) throw invalid(`state ${JSON.stringify(state)} must be ${WORK_ITEM_STATE_RULE}`);
	const current = store.read(code);
	if (current === undefined) throw new WorkItemStateError("missing", `no work item ${code}`);
	if (current.state === state) return current;
	const next: WorkItemRecord = structuredClone(current);
	next.state = state;
	next.events.push({ at: timeOf(context), by: context.by, verb: "state", detail: `${current.state} to ${state}${note === undefined ? "" : ` (${note})`}` });
	next.revision = current.revision + 1;
	return store.update(code, current.revision, () => next);
}

// ─── R2: the review item ─────────────────────────────────────────────────────

/** Who made a change the review judges: the session and the model it ran on. */
export type ReviewActorIdentity = { sessionId?: string; model?: string | null };

/** The item a review is opened from: the fields the review item inherits. */
export type ReviewedItem = {
	code: string;
	heading: string;
	goal: string;
	project: string;
	class: string;
	harness: string;
	ownedPaths?: readonly string[];
	brief?: string;
};

export type ReviewItemInput = {
	/** The work item under review: the review is created from its code. */
	item: ReviewedItem;
	/** The reviewed work's author: the lane session that built it. */
	author: ReviewActorIdentity | undefined;
	/** The session that owns the reviewed work: the orchestrator or the Conductor. */
	parent: ReviewActorIdentity | undefined;
	/** The review item's own code; `REVIEW-<item code>` when the caller names none. */
	code?: string;
	summary?: string;
	acceptance?: string;
	brief?: string;
	ownedPaths?: readonly string[];
	source?: string;
	state?: string;
};

/** One line of text, whitespace collapsed and bounded, so a heading copied from another record stays a line. */
function boundedLine(text: string, chars = 160): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > chars ? `${line.slice(0, chars - 1)}…` : line;
}

/** The identity as the refusal names it: what was given, not what was expected. */
function describeReviewIdentity(actor: ReviewActorIdentity | undefined): string {
	if (actor === undefined) return "no identity was given";
	const parts: string[] = [];
	if (actor.sessionId !== undefined && actor.sessionId.trim() !== "") parts.push(`session ${JSON.stringify(actor.sessionId)}`);
	if (typeof actor.model === "string" && actor.model.trim() !== "") parts.push(`model ${JSON.stringify(actor.model)}`);
	return parts.length > 0 ? parts.join(", ") : "no session and no model";
}

/** The review item's code when the caller names none: `REVIEW-<item code>`. */
export function reviewItemCode(itemCode: string): string {
	const code = `REVIEW-${itemCode}`;
	if (!WORK_ITEM_CODE_PATTERN.test(code)) {
		throw invalid(`review item code ${JSON.stringify(code)} is not one capital letter, then capitals, digits or dashes (2 to 24 characters); name the review item's own code`);
	}
	return code;
}

/**
 * The review item R2 opens from an item code: the author's and the parent's families are read off their
 * identities, and the reviewer's family is the one that differs from both. An identity whose model names none
 * of the three families is refused with that identity named — never passed as if it had a family.
 */
export function buildReviewWorkItem(input: ReviewItemInput, context: WorkItemContext): CreateWorkItemInput {
	const code = input.code ?? reviewItemCode(input.item.code);
	const problems: string[] = [];
	for (const [role, actor] of [
		["author", input.author],
		["parent", input.parent],
	] as const) {
		if (reviewFamilyOf(actor?.model) !== undefined) continue;
		problems.push(`the ${role} identity could not be read: ${describeReviewIdentity(actor)} names none of ${REVIEW_FAMILIES.join(", ")}`);
	}
	if (problems.length > 0) {
		throw invalid(`review item ${code} is refused: ${problems.join("; ")}. A reviewer's family is chosen against both, so the review does not open until both identities are readable`);
	}
	const author = reviewFamilyOf(input.author?.model)!;
	const parent = reviewFamilyOf(input.parent?.model)!;
	let reviewer: ReviewFamily;
	try {
		reviewer = chooseReviewFamily(author, parent);
	} catch (error) {
		// the operator's flag for the collision (2026-10-29 00:23): the refusal is where the loop reports it.
		throw invalid(`review item ${code} is refused: ${error instanceof Error ? error.message : String(error)}`);
	}
	const ownedPaths = input.ownedPaths ?? input.item.ownedPaths ?? [];
	return {
		code,
		heading: boundedLine(`Review ${input.item.code}: ${input.item.heading}`),
		summary: input.summary ?? `an independent review of ${input.item.code} on a ${reviewer} lane; the author is ${author}, the parent ${parent}`,
		goal: input.item.goal,
		project: input.item.project,
		kind: "review",
		class: input.item.class,
		harness: input.item.harness,
		review: { author, parent, reviewer },
		acceptance:
			input.acceptance ?? `an independent ${reviewer} verdict for ${input.item.code}'s head is recorded in the merge queue`,
		source: input.source ?? `review of work item ${input.item.code}`,
		brief: input.brief ?? "",
		ownedPaths: [...ownedPaths],
		dependencies: [],
		state: input.state ?? "ready",
	};
}

/** Creates the review item R2 opens from an item code, through the one create path. */
export function createReviewWorkItem(store: WorkItemStore, input: ReviewItemInput, context: WorkItemContext): WorkItemRecord {
	return createWorkItem(store, buildReviewWorkItem(input, context), context);
}

// ─── R3: the weekly audit rotation ──────────────────────────────────────────

/** The cursor's file under the muster state dir, which `health/doctor.ts` reads as this contract's proof. */
export const AUDIT_ROTATION_FILE = "audit-rotation.json";
/** One week between audits of two subsystems (R3). */
export const AUDIT_WEEK_MS = 7 * 24 * 60 * 60_000;

/** Where the rotation stands: the subsystem audited last and when that run happened. */
export type AuditRotationCursor = { subject: string; at: string };

export function auditRotationPath(stateDir: string = musterStateDir()): string {
	return join(stateDir, AUDIT_ROTATION_FILE);
}

export type AuditRotationRead =
	| { ok: true; cursor?: AuditRotationCursor }
	| { ok: false; error: string };

/** The cursor as stored. A file that cannot be read is an error naming it; no file is "no run yet". */
export function readAuditRotation(stateDir: string = musterStateDir()): AuditRotationRead {
	const file = auditRotationPath(stateDir);
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return { ok: true };
		return { ok: false, error: `the audit rotation cursor ${file} could not be read: ${error instanceof Error ? error.message : String(error)}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { ok: false, error: `the audit rotation cursor ${file} is not JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!isObject(parsed) || !nonEmptyLine(parsed["subject"]) || !isTime(parsed["at"])) {
		return { ok: false, error: `the audit rotation cursor ${file} must be {subject, at}` };
	}
	return { ok: true, cursor: { subject: parsed["subject"], at: parsed["at"] } };
}

/** Writes the cursor atomically, so the doctor reads a whole cursor or the previous one. */
export function writeAuditRotation(stateDir: string, cursor: AuditRotationCursor): void {
	if (!nonEmptyLine(cursor.subject) || !isTime(cursor.at)) throw invalid("the audit rotation cursor must be {subject, at}");
	const file = auditRotationPath(stateDir);
	mkdirSync(stateDir, { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify({ subject: cursor.subject, at: cursor.at }, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, file);
}

/**
 * The subsystems the weekly review walks, in the contract table's own order: every contract, the audit's own
 * row aside (it is this rotation's contract, not one of its subjects). The order is `CONTRACT_TABLE`'s; nothing
 * here restates it.
 */
export function auditRotationSubjects(): string[] {
	return Object.keys(CONTRACT_TABLE).filter((id) => id !== DERIVED_CONTRACTS.auditRotation);
}

export type AuditReview = {
	/** The subsystem to audit next. */
	subject: string;
	/** Its place in the table's order. */
	position: number;
	/** True when a week has passed since the cursor's run, or nothing has run yet. */
	due: boolean;
	/** When it falls due: now for the first run, else one week after the cursor. */
	dueAtMs: number;
};

/**
 * The next subsystem in the table's order, and whether it is due. The walk advances one row per run and wraps,
 * so no subsystem is audited twice before its turn; a cursor naming a row the table no longer has restarts at
 * the first row instead of reviewing a removed contract.
 */
export function nextAuditReview(input: { order: readonly string[]; cursor: AuditRotationCursor | undefined; now: number }): AuditReview {
	const { order, cursor, now } = input;
	if (order.length === 0) throw invalid("the audit rotation has no subject: the contract table is empty");
	if (cursor === undefined) return { subject: order[0]!, position: 0, due: true, dueAtMs: now };
	const last = order.indexOf(cursor.subject);
	const position = last === -1 ? 0 : (last + 1) % order.length;
	const dueAtMs = Date.parse(cursor.at) + AUDIT_WEEK_MS;
	return { subject: order[position]!, position, due: now >= dueAtMs, dueAtMs };
}

export type AuditReviewItemInput = {
	order?: readonly string[];
	cursor: AuditRotationCursor | undefined;
	now: number;
	goal: string;
	project: string;
	class?: WorkItemClass;
	harness?: string;
	/** The reviewed subsystem's paths: the audit lane needs at least one to be dispatchable. */
	ownedPaths: readonly string[];
	brief?: string;
	code?: string;
};

/**
 * The weekly audit's review item, built the same way as any review item: kind `review`, a reviewer family that
 * can run here, and no author or parent (the subsystem has no author session). The family rotates with the
 * subject, so a year of audits spreads over the resolving candidates.
 */
export function buildAuditReviewItem(input: AuditReviewItemInput): { review: AuditReview; input: CreateWorkItemInput } {	const review = nextAuditReview({ order: input.order ?? auditRotationSubjects(), cursor: input.cursor, now: input.now });
	const reviewer = REVIEW_RESOLVING_FAMILIES[review.position % REVIEW_RESOLVING_FAMILIES.length]!;
	const code = input.code ?? `AUDIT-${review.position + 1}`;
	return {
		review,
		input: {
			code,
			heading: boundedLine(`Audit ${review.subject} against its contract`),
			summary: `the week's review of ${review.subject}, next in the contract table's order, run on a ${reviewer} lane`,
			goal: input.goal,
			project: input.project,
			kind: "review",
			class: input.class ?? "H3",
			harness: input.harness ?? WORK_ITEM_DEFAULT_HARNESS,
			review: { reviewer },
			acceptance: `every finding is filed as a work item, and ${review.subject} is checked against its contract row`,
			source: `audit-rotation ${review.subject} at ${new Date(input.now).toISOString()}`,
			brief: input.brief ?? "",
			ownedPaths: [...input.ownedPaths],
			dependencies: [],
			state: "ready",
		},
	};
}

/** One finding the audit filed: the audit assigns its codes, the way any review numbers its findings. */
export type AuditFinding = {
	code: string;
	heading: string;
	summary?: string;
	class?: WorkItemClass;
	acceptance?: string;
};

/**
 * The audit's findings as work items (R3): each one captured as an `idea`, so it reaches the queue with the
 * audit it came from named in its source, and a brief is what turns it ready.
 */
export function auditFindingItems(
	findings: readonly AuditFinding[],
	base: { subject: string; at: string; goal: string; project: string; class?: WorkItemClass; harness?: string; brief?: string; ownedPaths?: readonly string[] },
): CreateWorkItemInput[] {
	return findings.map((finding) => ({
		code: finding.code,
		heading: boundedLine(finding.heading),
		summary: finding.summary ?? `a finding of the ${base.subject} audit`,
		goal: base.goal,
		project: base.project,
		kind: "fix",
		class: finding.class ?? base.class ?? "H3",
		harness: base.harness ?? WORK_ITEM_DEFAULT_HARNESS,
		acceptance: finding.acceptance ?? `the finding is fixed and ${base.subject}'s contract row reads green`,
		source: `audit-rotation ${base.subject} at ${base.at}`,
		brief: base.brief ?? "",
		ownedPaths: [...(base.ownedPaths ?? [])],
		dependencies: [],
		state: "idea",
	}));
}

// ─── Reading a state back ────────────────────────────────────────────────────

/** The argument of a `gated:`, `launched:` or `dropped:` state, or the state itself when it carries none. */
export function workItemStateDetail(state: string): string {
	for (const prefix of WORK_ITEM_STATE_PREFIXES) if (state.startsWith(prefix)) return state.slice(prefix.length);
	return "";
}

/** True for a lane id the agent-id rule accepts, for `launched:<lane>`. */
export function isLaneId(value: string): boolean {
	return validateAgentId(value) === value;
}
