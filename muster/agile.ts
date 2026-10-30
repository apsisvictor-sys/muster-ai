/**
 * Muster Agile policy and decomposition owner (plan §6.2, §6.3, §7.1, §7.1.1, §8-P4).
 *
 * This module is the single Agile policy brain below the P2 operating
 * controller. It owns:
 * - the decomposition graph schema, structural validation and contract hashes;
 * - dependency-ready frontier computation (lifecycle statuses come from the
 *   task owner, Concord, and are never stored here);
 * - revision impact assessment and carried-forward review evidence;
 * - per-task dispatch admission (`canDispatchTask`), including role/owner,
 *   repository/scope, accepted revision, review evidence, dependencies,
 *   ownership and capacity;
 * - descendant writer reservations and join-before-offer for persistent lanes
 *   (plan §7 P3): a lane's subtree write set is reserved in the programme
 *   control store before its work is admitted, and its handoff is held until
 *   every reserved leaf in that subtree is settled;
 * - the operation classification and admission policy that Muster installs on
 *   `OperatingController.setAdmissionPolicy`, so a raw `muster_*` Concord call,
 *   a nested/programmatic call or a provider/lane launch cannot bypass the
 *   same checks;
 * - the inactive Jira adapter gate (block with a setup condition, never fall
 *   back to a private local backlog);
 * - durable decomposition revisions with serialized compare-and-set.
 *
 * Task contents and lifecycle stay at their existing owners (Concord, or the
 * approved-plan source for the human-readable breakdown). Nothing here invents
 * a second Ready/In-Progress/Done execution status: readiness is computed from
 * the accepted graph plus observed Concord statuses on demand.
 *
 * Pure: no Pi API, no network, no child processes. Only durable-state helpers
 * touch the filesystem, through the shared compare-and-set store (`fileCasStore`).
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";

import { laneOwnerRef, musterSessionsDir } from "./binding.ts";
import { piAgentDir } from "../core/pi-ports.ts";
import {
	DescendantReservationConflictError,
	DescendantReservationLimitError,
	listDescendantReservations,
	ProgrammeControlStateError,
	releaseDescendantWriter,
	reserveDescendantWriter,
	type DescendantReservation,
	type ProgrammeControlContext,
} from "./control.ts";
import { fileCasStore } from "./owner-fence.ts";
import type { LaunchIntent } from "./types.ts";
/**
 * `extensions/lib/operating-mode.ts` owns admission, and the harness may not import Pi's
 * profile at run time or for its types (RD1, RS3 F3), so the shapes this policy is reached
 * by are declared here. They are the owner's own, narrowed to what the policy reads: the
 * controller's `setAdmissionPolicy` call in Pi's profile is checked against the real type
 * where it is made.
 */
type AdmissionRequest = { toolName: string; origin: "model" | "programmatic"; args?: Record<string, unknown> };
type AdmissionSnapshot = {
	mode: string;
	phase?: ProgrammePhase;
	programmeId?: string;
	role?: OperatingRole;
	backlogSource?: BacklogSource;
};
export type AdmissionDecision = { allow: true } | { allow: false; reason: RefusalReason; detail: string };
export type AdmissionPolicy = (request: AdmissionRequest, snapshot: AdmissionSnapshot) => AdmissionDecision;
import {
	AGILE_READ_ONLY_TOOLS,
	hashText,
	type BacklogSource,
	type GrantTerms,
	type OperatingRole,
	type ProgrammePhase,
	type RefusalReason,
	type RepositoryRef,
	type WorkerLaunchIntentFacts,
	type WorkerSeedPort,
	type WorkerSeedQuery,
	type WorkerState,
} from "../core/programme.ts";

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export const DECOMPOSITION_SCHEMA_VERSION = 1 as const;

export type AgileTaskKind = "implementation" | "research" | "review" | "verification" | "integration";
export type DependencyReason = "interface" | "artifact" | "integration";
export type DispatchIntent = "start" | "write" | "launch" | "assign" | "handoff" | "closure" | "research" | "record";
export type PlanningReviewKind = "independent-planning" | "parent-refinement";

/** Deterministic detail codes. Every refusal names one; tests assert them. */
export type AgileDenialCode =
	| "schema_invalid"
	| "decomposition_not_proposed"
	| "decomposition_not_accepted"
	| "decomposition_revision_not_accepted"
	| "stale_accepted_revision"
	| "revision_conflict"
	| "revision_mismatch"
	| "already_accepted"
	| "review_not_accepted"
	| "review_evidence_missing"
	| "independent_review_required"
	| "review_hash_mismatch"
	| "task_not_in_decomposition"
	| "dependency_not_satisfied"
	| "dependency_state_unknown"
	| "task_settled"
	| "unresolved_blocker"
	| "provisional"
	| "capacity_exhausted"
	| "capacity_held"
	| "already_owned"
	| "ownership_mismatch"
	| "task_owned_by_another_agent"
	| "no_admitted_task"
	| "target_outside_task_scope"
	| "repository_not_in_grant"
	| "repository_outside_grant"
	| "increment_not_approved"
	| "investigation_scope_not_authorized"
	| "shared_writer_conflict"
	| "launch_requires_parent"
	| "launch_task_unspecified"
	| "launch_intent_required"
	| "launch_intent_expired"
	| "launch_handshake_pending"
	| "agile_supports_pi_lanes_only"
	| "delegate_not_a_bypass"
	| "handoff_evidence_missing"
	| "descendants_outstanding"
	| "closure_authority_worker_denied"
	| "worker_review_ready_not_admitted"
	| "parent_role_required"
	| "closure_evidence_missing"
	| "stale_task_version"
	| "current_owner_required"
	| "operation_not_classified"
	| "excluded_external_operation"
	| "protected_path"
	| "jira_connector_inactive"
	| "operator_shell_intervention"
	| "state_malformed"
	| "state_io";

export type DispatchDecision =
	| { allow: true }
	| { allow: false; reason: RefusalReason; code: AgileDenialCode; detail: string; setupCondition?: string };

export type DecompositionResult<T = DecompositionState> =
	| { ok: true; state: T }
	| { ok: false; code: AgileDenialCode; detail: string };

/** Lifecycle statuses that satisfy a dependency edge (Concord vocabulary). */
export const DEPENDENCY_SATISFIED_STATUSES: ReadonlySet<string> = new Set(["complete", "closed"]);

/** Statuses that mean the task has a live owner and must not be re-dispatched. */
export const TASK_LIVE_STATUSES: ReadonlySet<string> = new Set([
	"assigned",
	"active",
	"blocked",
	"handoff_offered",
	"handed_off",
	"review_ready",
]);

export const TASK_OBSERVED_STATUSES: ReadonlySet<string> = new Set([
	"proposed",
	...TASK_LIVE_STATUSES,
	"complete",
	"closed",
]);

const ID_PATTERN = /^[a-z][a-z0-9_.:-]{0,63}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const REVIEW_FIELD_NAMES = new Set(["reviewed", "reviewedBy", "reviewPassed", "approved", "approvedBy"]);
const PROGRAMME_ID_PATTERN = /^agp_[0-9a-f]{12}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const PHASE_REFUSALS: Record<ProgrammePhase, { reason: RefusalReason; code: AgileDenialCode }> = {
	setup: { reason: "initiative_not_approved", code: "decomposition_not_accepted" },
	active: { reason: "task_not_active", code: "no_admitted_task" },
	pausing: { reason: "programme_paused", code: "no_admitted_task" },
	paused: { reason: "programme_paused", code: "no_admitted_task" },
	"recovery-required": { reason: "recovery_required", code: "state_malformed" },
	finished: { reason: "initiative_not_approved", code: "decomposition_not_accepted" },
};

// ─── Schema ──────────────────────────────────────────────────────────────────

export type SuccessCondition = { id: string; statement: string; evidence: string };
export type TaskDependency = { taskId: string; reason: DependencyReason; supplies: string };
export type TaskAssumption = { statement: string; status: "evidenced" | "unresolved" };
export type TaskEvidence = { references: string[]; assumptions: TaskAssumption[] };
export type TaskScope = { repository: string; files: string[]; exclusions: string[]; readOnly?: boolean };
export type TaskOwnership = {
	intendedRole: OperatingRole;
	assignedAgentId?: string;
	reviewer: string;
	integrationOwner?: string;
	writes: string[];
};
export type TaskVerification = { checks: string[]; actor: string; handoffContract: string };
export type TaskUncertainty = { blocker?: string; provisional?: boolean };

export type TaskContractInput = {
	taskId: string;
	title: string;
	kind: AgileTaskKind;
	outcome: string;
	acceptanceExamples: string[];
	evidence: TaskEvidence;
	scope: TaskScope;
	dependencies: TaskDependency[];
	ownership: TaskOwnership;
	verification: TaskVerification;
	successConditions: string[];
	uncertainty?: TaskUncertainty;
	contractHash?: string;
};

export type TaskContract = Omit<TaskContractInput, "contractHash"> & { contractHash: string };

export type DecompositionProposalInput = {
	schemaVersion?: 1;
	programmeId: string;
	revision?: number;
	incrementId: string;
	goal: string;
	successConditions: SuccessCondition[];
	tasks: TaskContractInput[];
	proposedBy: "parent-agent" | "operator";
	proposedAt?: string;
};

export type DecompositionProposal = Omit<DecompositionProposalInput, "tasks"> & {
	tasks: TaskContract[];
};

export type PlanningReviewRecord = {
	reviewId: string;
	revision: number;
	kind: PlanningReviewKind;
	reviewerAgentId: string;
	reviewerRole: "reviewer";
	laneReference?: string;
	readOnly: boolean;
	disposition: "accepted" | "changes-required";
	findings: string[];
	reviewedHashes: Record<string, string>;
	at: string;
};

export type AcceptedGraph = {
	revision: number;
	incrementId: string;
	goal: string;
	successConditions: SuccessCondition[];
	tasks: TaskContract[];
	reviewId: string;
	reviewKind: PlanningReviewKind;
	reviewedHashes: Record<string, string>;
	acceptedAt: string;
};

export type DecompositionGraph = {
	revision: number;
	incrementId: string;
	goal: string;
	successConditions: SuccessCondition[];
	tasks: TaskContract[];
};

export type DecompositionState = {
	schemaVersion: 1;
	programmeId: string;
	/** Monotonic graph revision counter; every proposal allocates the next. */
	revision: number;
	status: "proposed" | "accepted";
	graph: DecompositionGraph;
	/** Last accepted graph snapshot; drives impact assessment and dispatch. */
	accepted?: AcceptedGraph;
	reviews: PlanningReviewRecord[];
	updatedAt: string;
};

// ─── Small helpers ───────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

function stringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(nonEmptyString);
}

function unknownKeys(value: Record<string, unknown>, known: ReadonlySet<string>): string[] {
	return Object.keys(value).filter((key) => !known.has(key));
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (isPlainObject(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value ?? null);
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Canonical artifact key: repository-relative, posix-normalized, no trailing slash. */
export function normalizeArtifactKey(value: string): string {
	const trimmed = value.trim().replace(/^\.\//, "").replace(/\\/g, "/");
	const normalized = normalize(trimmed).replace(/\\/g, "/").replace(/\/+$/, "");
	return normalized === "." ? "" : normalized;
}

function isSafeRelativePath(value: string): boolean {
	if (value.trim() === "" || isAbsolute(value) || value.includes("\0")) return false;
	return !normalizeArtifactKey(value).split("/").includes("..");
}

/** True when artifact keys overlap exactly or by directory containment. */
export function artifactKeysOverlap(a: string, b: string): boolean {
	const left = normalizeArtifactKey(a);
	const right = normalizeArtifactKey(b);
	if (left === "" || right === "") return false;
	return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/** Canonical hash of a task contract; review evidence is bound to this value. */
export function taskContractHash(contract: TaskContractInput | TaskContract): string {
	const { contractHash: _ignored, ...rest } = contract as TaskContractInput;
	return hashText(stableStringify(rest));
}

/** The contract as stored: code computes the hash, never the model. */
export function withComputedHash(contract: TaskContractInput): TaskContract {
	return { ...contract, contractHash: taskContractHash(contract) };
}

/** Every declared write target for a task (scope files + ownership writes). */
export function writeTargets(task: TaskContract): string[] {
	return [...new Set([...task.scope.files, ...task.ownership.writes].map((entry) => normalizeArtifactKey(entry)))].filter(
		(entry) => entry !== "",
	);
}

function sharedWriteTargets(left: TaskContract, right: TaskContract): string[] {
	const shared = new Set<string>();
	for (const leftTarget of writeTargets(left)) {
		for (const rightTarget of writeTargets(right)) {
			if (artifactKeysOverlap(leftTarget, rightTarget)) shared.add(leftTarget);
		}
	}
	return [...shared].sort();
}

function dependsOn(candidate: TaskContract, target: TaskContract, tasks: Map<string, TaskContract>): boolean {
	const seen = new Set<string>();
	const stack = [candidate.taskId];
	while (stack.length > 0) {
		const current = stack.pop()!;
		const task = tasks.get(current);
		if (task === undefined) continue;
		for (const dependency of task.dependencies) {
			if (dependency.taskId === target.taskId) return true;
			if (!seen.has(dependency.taskId)) {
				seen.add(dependency.taskId);
				stack.push(dependency.taskId);
			}
		}
	}
	return false;
}

function dependencyCycles(tasks: TaskContract[]): string[][] {
	const byId = new Map(tasks.map((task) => [task.taskId, task]));
	const color = new Map<string, 0 | 1 | 2>();
	const cycles: string[][] = [];
	const stack: string[] = [];
	const visit = (taskId: string): void => {
		color.set(taskId, 1);
		stack.push(taskId);
		for (const dependency of byId.get(taskId)?.dependencies ?? []) {
			const next = dependency.taskId;
			if (!byId.has(next)) continue;
			const state = color.get(next) ?? 0;
			if (state === 1) {
				const start = stack.indexOf(next);
				cycles.push([...stack.slice(start), next]);
			} else if (state === 0) {
				visit(next);
			}
		}
		stack.pop();
		color.set(taskId, 2);
	};
	for (const task of tasks) {
		if ((color.get(task.taskId) ?? 0) === 0) visit(task.taskId);
	}
	return cycles;
}

/** Dependency-first order; ties broken by task id for determinism. */
export function topologicalOrder(tasks: TaskContract[]): string[] {
	const byId = new Map(tasks.map((task) => [task.taskId, task]));
	const visited = new Set<string>();
	const order: string[] = [];
	const visit = (taskId: string): void => {
		if (visited.has(taskId)) return;
		visited.add(taskId);
		const task = byId.get(taskId);
		if (task === undefined) return;
		for (const dependency of [...task.dependencies].sort((a, b) => a.taskId.localeCompare(b.taskId))) {
			visit(dependency.taskId);
		}
		order.push(taskId);
	};
	for (const taskId of [...byId.keys()].sort()) visit(taskId);
	return order;
}

// ─── Structural validation ───────────────────────────────────────────────────

const TASK_KEYS = new Set([
	"taskId",
	"title",
	"kind",
	"outcome",
	"acceptanceExamples",
	"evidence",
	"scope",
	"dependencies",
	"ownership",
	"verification",
	"successConditions",
	"uncertainty",
	"contractHash",
]);
const EVIDENCE_KEYS = new Set(["references", "assumptions"]);
const SCOPE_KEYS = new Set(["repository", "files", "exclusions", "readOnly"]);
const OWNERSHIP_KEYS = new Set(["intendedRole", "assignedAgentId", "reviewer", "integrationOwner", "writes"]);
const VERIFICATION_KEYS = new Set(["checks", "actor", "handoffContract"]);
const UNCERTAINTY_KEYS = new Set(["blocker", "provisional"]);
const CONDITION_KEYS = new Set(["id", "statement", "evidence"]);

function validateConditions(input: unknown, errors: string[]): Map<string, SuccessCondition> {
	const conditions = new Map<string, SuccessCondition>();
	if (!Array.isArray(input) || input.length === 0) {
		errors.push("successConditions must be a non-empty array");
		return conditions;
	}
	input.forEach((condition, index) => {
		const path = `successConditions[${index}]`;
		if (!isPlainObject(condition)) {
			errors.push(`${path} must be an object`);
			return;
		}
		const extra = unknownKeys(condition, CONDITION_KEYS);
		if (extra.length > 0) errors.push(`${path} has unknown fields: ${extra.join(", ")}`);
		if (!nonEmptyString(condition.id) || !ID_PATTERN.test(String(condition.id))) {
			errors.push(`${path}.id must match ${ID_PATTERN}`);
		}
		if (!nonEmptyString(condition.statement)) errors.push(`${path}.statement must be a non-empty string`);
		if (!nonEmptyString(condition.evidence)) errors.push(`${path}.evidence must be a non-empty string`);
		const id = String(condition.id ?? "");
		if (conditions.has(id)) errors.push(`duplicate success condition id: ${id}`);
		else if (nonEmptyString(condition.id)) {
			conditions.set(id, {
				id,
				statement: String(condition.statement ?? ""),
				evidence: String(condition.evidence ?? ""),
			});
		}
	});
	return conditions;
}

function validateTask(input: unknown, index: number, errors: string[]): TaskContract | undefined {
	const path = `tasks[${index}]`;
	const local: string[] = [];
	if (!isPlainObject(input)) {
		errors.push(`${path} must be an object`);
		return undefined;
	}
	// A populated review flag is never authority and is never schema.
	const reviewish = [...REVIEW_FIELD_NAMES].filter((key) => key in input);
	if (reviewish.length > 0) {
		local.push(`${path} must not carry review flags (${reviewish.join(", ")}); review provenance is recorded separately`);
	}
	const extra = unknownKeys(input, TASK_KEYS);
	if (extra.length > 0) local.push(`${path} has unknown fields: ${extra.join(", ")}`);
	if (!nonEmptyString(input.taskId) || !ID_PATTERN.test(String(input.taskId))) {
		local.push(`${path}.taskId must match ${ID_PATTERN}`);
	}
	if (!nonEmptyString(input.title)) local.push(`${path}.title must be a non-empty string`);
	if (!["implementation", "research", "review", "verification", "integration"].includes(String(input.kind))) {
		local.push(`${path}.kind is invalid`);
	}
	if (!nonEmptyString(input.outcome)) local.push(`${path}.outcome must be a non-empty string`);
	if (!stringList(input.acceptanceExamples) || (input.acceptanceExamples as string[]).length === 0) {
		local.push(`${path}.acceptanceExamples must be a non-empty string array`);
	}

	if (!isPlainObject(input.evidence)) {
		local.push(`${path}.evidence must be an object`);
	} else {
		const evidenceExtra = unknownKeys(input.evidence, EVIDENCE_KEYS);
		if (evidenceExtra.length > 0) local.push(`${path}.evidence has unknown fields: ${evidenceExtra.join(", ")}`);
		if (!stringList(input.evidence.references) || (input.evidence.references as string[]).length === 0) {
			local.push(`${path}.evidence.references must be a non-empty string array`);
		}
		if (!Array.isArray(input.evidence.assumptions)) {
			local.push(`${path}.evidence.assumptions must be an array`);
		} else {
			input.evidence.assumptions.forEach((assumption, assumptionIndex) => {
				if (
					!isPlainObject(assumption) ||
					!nonEmptyString(assumption.statement) ||
					(assumption.status !== "evidenced" && assumption.status !== "unresolved")
				) {
					local.push(`${path}.evidence.assumptions[${assumptionIndex}] must be { statement, status: evidenced|unresolved }`);
				}
			});
		}
	}

	if (!isPlainObject(input.scope)) {
		local.push(`${path}.scope must be an object`);
	} else {
		const scopeExtra = unknownKeys(input.scope, SCOPE_KEYS);
		if (scopeExtra.length > 0) local.push(`${path}.scope has unknown fields: ${scopeExtra.join(", ")}`);
		if (!nonEmptyString(input.scope.repository)) local.push(`${path}.scope.repository must be a non-empty string`);
		for (const key of ["files", "exclusions"] as const) {
			if (!stringList(input.scope[key])) local.push(`${path}.scope.${key} must be a string array`);
		}
		for (const entry of (input.scope.files as unknown[]) ?? []) {
			if (typeof entry === "string" && !isSafeRelativePath(entry)) {
				local.push(`${path}.scope.files contains an unsafe repository-relative path: ${entry}`);
			}
		}
		if (input.scope.readOnly !== undefined && typeof input.scope.readOnly !== "boolean") {
			local.push(`${path}.scope.readOnly must be a boolean`);
		}
	}

	if (!isPlainObject(input.ownership)) {
		local.push(`${path}.ownership must be an object`);
	} else {
		const ownershipExtra = unknownKeys(input.ownership, OWNERSHIP_KEYS);
		if (ownershipExtra.length > 0) local.push(`${path}.ownership has unknown fields: ${ownershipExtra.join(", ")}`);
		if (input.ownership.intendedRole !== "parent" && input.ownership.intendedRole !== "worker") {
			local.push(`${path}.ownership.intendedRole must be parent or worker`);
		}
		if (input.ownership.assignedAgentId !== undefined && !nonEmptyString(input.ownership.assignedAgentId)) {
			local.push(`${path}.ownership.assignedAgentId must be a non-empty string when present`);
		}
		if (!nonEmptyString(input.ownership.reviewer)) local.push(`${path}.ownership.reviewer must be a non-empty string`);
		if (input.ownership.integrationOwner !== undefined && !nonEmptyString(input.ownership.integrationOwner)) {
			local.push(`${path}.ownership.integrationOwner must be a non-empty string when present`);
		}
		if (!stringList(input.ownership.writes)) local.push(`${path}.ownership.writes must be a string array`);
		for (const entry of (input.ownership.writes as unknown[]) ?? []) {
			if (typeof entry === "string" && !isSafeRelativePath(entry)) {
				local.push(`${path}.ownership.writes contains an unsafe repository-relative path: ${entry}`);
			}
		}
	}

	if (!isPlainObject(input.verification)) {
		local.push(`${path}.verification must be an object`);
	} else {
		const verificationExtra = unknownKeys(input.verification, VERIFICATION_KEYS);
		if (verificationExtra.length > 0) local.push(`${path}.verification has unknown fields: ${verificationExtra.join(", ")}`);
		if (!stringList(input.verification.checks)) local.push(`${path}.verification.checks must be a string array`);
		if (!nonEmptyString(input.verification.actor)) local.push(`${path}.verification.actor must be a non-empty string`);
		if (!nonEmptyString(input.verification.handoffContract)) {
			local.push(`${path}.verification.handoffContract must be a non-empty string`);
		}
	}

	if (!Array.isArray(input.dependencies)) {
		local.push(`${path}.dependencies must be an array`);
	} else {
		input.dependencies.forEach((dependency, dependencyIndex) => {
			if (
				!isPlainObject(dependency) ||
				!nonEmptyString(dependency.taskId) ||
				!["interface", "artifact", "integration"].includes(String(dependency.reason)) ||
				!nonEmptyString(dependency.supplies)
			) {
				local.push(
					`${path}.dependencies[${dependencyIndex}] must be { taskId, reason: interface|artifact|integration, supplies }`,
				);
				return;
			}
			if (unknownKeys(dependency, new Set(["taskId", "reason", "supplies"])).length > 0) {
				local.push(`${path}.dependencies[${dependencyIndex}] has unknown fields`);
			}
		});
	}

	if (!stringList(input.successConditions) || (input.successConditions as string[]).length === 0) {
		local.push(`${path}.successConditions must be a non-empty string array`);
	}

	if (input.uncertainty !== undefined) {
		if (!isPlainObject(input.uncertainty)) local.push(`${path}.uncertainty must be an object`);
		else {
			const uncertaintyExtra = unknownKeys(input.uncertainty, UNCERTAINTY_KEYS);
			if (uncertaintyExtra.length > 0) local.push(`${path}.uncertainty has unknown fields: ${uncertaintyExtra.join(", ")}`);
			if (input.uncertainty.blocker !== undefined && !nonEmptyString(input.uncertainty.blocker)) {
				local.push(`${path}.uncertainty.blocker must be a non-empty string when present`);
			}
			if (input.uncertainty.provisional !== undefined && typeof input.uncertainty.provisional !== "boolean") {
				local.push(`${path}.uncertainty.provisional must be a boolean when present`);
			}
		}
	}

	if (input.contractHash !== undefined && !nonEmptyString(input.contractHash)) {
		local.push(`${path}.contractHash must be a non-empty string when present`);
	}

	errors.push(...local);
	if (local.length > 0) return undefined;
	const contract = withComputedHash(input as unknown as TaskContractInput);
	if (input.contractHash !== undefined && input.contractHash !== contract.contractHash) {
		errors.push(`${path}.contractHash does not match the canonical contract contents`);
		return undefined;
	}
	return contract;
}

function validateTasks(input: unknown, errors: string[]): Map<string, TaskContract> {
	const tasks = new Map<string, TaskContract>();
	if (!Array.isArray(input) || input.length === 0) {
		errors.push("tasks must be a non-empty array");
		return tasks;
	}
	input.forEach((task, index) => {
		const validated = validateTask(task, index, errors);
		if (validated === undefined) return;
		if (tasks.has(validated.taskId)) errors.push(`duplicate task id: ${validated.taskId}`);
		else tasks.set(validated.taskId, validated);
	});
	return tasks;
}

/** References, DAG, coverage, necessity and ownership coherence. */
function validateGraphSemantics(
	tasks: Map<string, TaskContract>,
	conditions: Map<string, SuccessCondition>,
	errors: string[],
): void {
	for (const task of tasks.values()) {
		for (const dependency of task.dependencies) {
			if (dependency.taskId === task.taskId) {
				errors.push(`dependency_self_reference: ${task.taskId} depends on itself`);
				continue;
			}
			if (!tasks.has(dependency.taskId)) {
				errors.push(`dependency_unknown_task: ${task.taskId} -> ${dependency.taskId}`);
			}
		}
		for (const conditionId of task.successConditions) {
			if (!conditions.has(conditionId)) {
				errors.push(`success_condition_unknown: ${task.taskId} -> ${conditionId}`);
			}
		}
	}
	for (const cycle of dependencyCycles([...tasks.values()])) {
		errors.push(`dependency_cycle: ${cycle.join(" -> ")}`);
	}
	for (const conditionId of conditions.keys()) {
		const covering = [...tasks.values()].filter((task) => task.successConditions.includes(conditionId));
		if (covering.length === 0) {
			errors.push(`success_condition_uncovered: ${conditionId}`);
			continue;
		}
		const verified = covering.some(
			(task) => task.verification.checks.length > 0 && task.verification.actor.trim() !== "",
		);
		if (!verified) errors.push(`success_condition_without_verification: ${conditionId}`);
	}
	for (const task of tasks.values()) {
		if (task.successConditions.length === 0) errors.push(`task_without_success_condition: ${task.taskId}`);
		if (task.kind === "research" || task.kind === "review") {
			if (task.scope.readOnly !== true || task.ownership.writes.length > 0) {
				errors.push(`${task.taskId} is ${task.kind} and must be read-only (scope.readOnly true, no declared writes)`);
			}
		} else if (writeTargets(task).length === 0) {
			errors.push(`task_without_write_scope: ${task.taskId}`);
		}
	}
	// Ownership conflicts: two writers on one shared module/artifact are
	// rejected unless one depends on the other (sequenced) or they share one
	// declared owner.
	const taskList = [...tasks.values()];
	for (let i = 0; i < taskList.length; i += 1) {
		for (let j = i + 1; j < taskList.length; j += 1) {
			const left = taskList[i]!;
			const right = taskList[j]!;
			const sameOwner =
				left.ownership.assignedAgentId !== undefined &&
				left.ownership.assignedAgentId === right.ownership.assignedAgentId;
			if (sameOwner) continue;
			if (dependsOn(left, right, tasks) || dependsOn(right, left, tasks)) continue;
			const shared = sharedWriteTargets(left, right);
			if (shared.length > 0) {
				errors.push(
					`shared_writer_conflict: ${left.taskId} and ${right.taskId} both write ${shared.join(", ")} without sequencing`,
				);
			}
		}
	}
}

const PROPOSAL_KEYS = new Set([
	"schemaVersion",
	"programmeId",
	"revision",
	"incrementId",
	"goal",
	"successConditions",
	"tasks",
	"proposedBy",
	"proposedAt",
]);

export type DecompositionValidation =
	| { ok: true; proposal: DecompositionProposal }
	| { ok: false; errors: string[] };

/** Serialized-but-invalid shapes get rejected before any task creation or path use. */
export function validateDecomposition(input: unknown): DecompositionValidation {
	const errors: string[] = [];
	if (!isPlainObject(input)) return { ok: false, errors: ["decomposition must be an object"] };
	const extra = unknownKeys(input, PROPOSAL_KEYS);
	if (extra.length > 0) errors.push(`decomposition has unknown fields: ${extra.join(", ")}`);
	if (input.schemaVersion !== undefined && input.schemaVersion !== DECOMPOSITION_SCHEMA_VERSION) {
		errors.push("schemaVersion must be 1");
	}
	if (!nonEmptyString(input.programmeId) || !PROGRAMME_ID_PATTERN.test(String(input.programmeId))) {
		errors.push("programmeId must match agp_<12 hex>");
	}
	if (input.revision !== undefined && (!Number.isInteger(input.revision) || (input.revision as number) < 1)) {
		errors.push("revision must be a positive integer when present");
	}
	if (!nonEmptyString(input.incrementId)) errors.push("incrementId must be a non-empty string");
	if (!nonEmptyString(input.goal)) errors.push("goal must be a non-empty string");
	if (input.proposedBy !== "parent-agent" && input.proposedBy !== "operator") {
		errors.push("proposedBy must be parent-agent or operator");
	}
	if (input.proposedAt !== undefined && !nonEmptyString(input.proposedAt)) {
		errors.push("proposedAt must be a non-empty string when present");
	}
	const conditions = validateConditions(input.successConditions, errors);
	const tasks = validateTasks(input.tasks, errors);
	validateGraphSemantics(tasks, conditions, errors);
	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		proposal: {
			schemaVersion: DECOMPOSITION_SCHEMA_VERSION,
			programmeId: String(input.programmeId),
			...(input.revision !== undefined ? { revision: Number(input.revision) } : {}),
			incrementId: String(input.incrementId),
			goal: String(input.goal),
			successConditions: [...conditions.values()],
			tasks: [...tasks.values()],
			proposedBy: input.proposedBy,
			...(nonEmptyString(input.proposedAt) ? { proposedAt: String(input.proposedAt) } : {}),
		},
	};
}

// ─── Lifecycle observations and frontier ─────────────────────────────────────

export type TaskLifecycleObservation = {
	status: string;
	version?: number;
	agentId?: string;
	assignedAgentId?: string;
	observedAtMs?: number;
};

export type ReadyFrontierInput = {
	state: DecompositionState | undefined;
	acceptedRevision?: number;
	taskStates?: Record<string, TaskLifecycleObservation>;
	capacity?: { limit?: number; inFlight?: number };
	currentOwners?: Record<string, string>;
};

export type HeldTask = { taskId: string; code: AgileDenialCode; detail: string };

export type ReadyFrontier = {
	acceptedRevision?: number;
	ready: TaskContract[];
	held: HeldTask[];
	capacityRemaining?: number;
};

/**
 * Dependency-ready work under the accepted revision, filtered by approved
 * capacity and current owners. Statuses come from the lifecycle owner; this
 * function never stores an execution status of its own.
 */
export function computeReadyFrontier(input: ReadyFrontierInput): ReadyFrontier {
	const state = input.state;
	if (state === undefined) return { ready: [], held: [] };
	const accepted = state.accepted;
	if (accepted === undefined) {
		return {
			ready: [],
			held: state.graph.tasks.map((task) => ({
				taskId: task.taskId,
				code: "decomposition_not_accepted" as const,
				detail: "no accepted decomposition revision exists",
			})),
		};
	}
	if (state.graph.revision !== accepted.revision) {
		return {
			acceptedRevision: accepted.revision,
			ready: [],
			held: state.graph.tasks.map((task) => ({
				taskId: task.taskId,
				code: "decomposition_revision_not_accepted" as const,
				detail: `proposed revision ${state.graph.revision} is not the accepted revision ${accepted.revision}`,
			})),
		};
	}
	if (input.acceptedRevision !== undefined && input.acceptedRevision !== accepted.revision) {
		return {
			acceptedRevision: accepted.revision,
			ready: [],
			held: accepted.tasks.map((task) => ({
				taskId: task.taskId,
				code: "stale_accepted_revision" as const,
				detail: `caller holds revision ${input.acceptedRevision}, accepted is ${accepted.revision}`,
			})),
		};
	}
	const taskStates = input.taskStates ?? {};
	const currentOwners = input.currentOwners ?? {};
	const byId = new Map(accepted.tasks.map((task) => [task.taskId, task]));
	const ready: TaskContract[] = [];
	const held: HeldTask[] = [];
	for (const taskId of topologicalOrder(accepted.tasks)) {
		const task = byId.get(taskId)!;
		const observation = taskStates[task.taskId];
		let block: HeldTask | undefined;
		if (task.uncertainty?.blocker !== undefined) {
			block = { taskId, code: "unresolved_blocker", detail: task.uncertainty.blocker };
		} else if (task.uncertainty?.provisional === true) {
			block = { taskId, code: "provisional", detail: "task is provisional until its dependency is established" };
		} else if (observation !== undefined && DEPENDENCY_SATISFIED_STATUSES.has(observation.status)) {
			block = { taskId, code: "task_settled", detail: `lifecycle status ${observation.status} is settled` };
		} else if (observation !== undefined && TASK_LIVE_STATUSES.has(observation.status)) {
			const owner = currentOwners[task.taskId] ?? observation.agentId ?? observation.assignedAgentId;
			block = {
				taskId,
				code: "already_owned",
				detail: `task lifecycle status is ${observation.status}${owner === undefined ? "" : ` for ${owner}`}`,
			};
		}
		if (block === undefined) {
			for (const dependency of task.dependencies) {
				const dependencyState = taskStates[dependency.taskId];
				if (dependencyState === undefined) {
					block = {
						taskId,
						code: "dependency_state_unknown",
						detail: `${dependency.taskId} has no observable lifecycle status (${dependency.reason})`,
					};
					break;
				}
				if (!DEPENDENCY_SATISFIED_STATUSES.has(dependencyState.status)) {
					block = {
						taskId,
						code: "dependency_not_satisfied",
						detail: `${dependency.taskId} is ${dependencyState.status}; needs ${dependency.supplies} (${dependency.reason})`,
					};
					break;
				}
			}
		}
		if (block === undefined) ready.push(task);
		else held.push(block);
	}
	const limit = input.capacity?.limit;
	if (limit === undefined) return { acceptedRevision: accepted.revision, ready, held };
	const inFlight = Math.max(0, input.capacity?.inFlight ?? 0);
	const remaining = Math.max(0, limit - inFlight);
	const admitted = ready.slice(0, remaining);
	for (const task of ready.slice(remaining)) {
		held.push({ taskId: task.taskId, code: "capacity_held", detail: `capacity ${limit} with ${inFlight} in flight` });
	}
	return { acceptedRevision: accepted.revision, ready: admitted, held, capacityRemaining: remaining };
}

// ─── Revision impact ─────────────────────────────────────────────────────────

/** Acceptance-relevant field changes force a new independent planning review. */
const REVIEW_RELEVANT_FIELDS = new Set([
	"acceptanceExamples",
	"verification",
	"dependencies",
	"ownership",
	"scope",
	"successConditions",
	"kind",
]);

export type RevisionImpact = {
	previousRevision?: number;
	added: string[];
	removed: string[];
	changed: string[];
	recontextualised: string[];
	carriedForward: string[];
	requiresParentReview: boolean;
	requiresIndependentReview: boolean;
	requiresOperatorDecision: boolean;
	details: Array<{ taskId: string; reason: string }>;
};

export type ProposedGraph = Pick<DecompositionGraph, "incrementId" | "goal" | "successConditions" | "tasks">;

/**
 * Which task contracts and reviews a proposed change invalidates. Review
 * evidence is carried forward only for an unchanged contract hash whose
 * prerequisite/interface context (dependency edges and the dependency
 * contracts they reference) is also unchanged.
 */
export function assessRevisionImpact(previous: AcceptedGraph | undefined, proposed: ProposedGraph): RevisionImpact {
	const impact: RevisionImpact = {
		added: [],
		removed: [],
		changed: [],
		recontextualised: [],
		carriedForward: [],
		requiresParentReview: true,
		requiresIndependentReview: previous === undefined,
		requiresOperatorDecision: false,
		details: [],
	};
	const details = (taskId: string, reason: string): void => {
		impact.details.push({ taskId, reason });
	};
	if (previous === undefined) {
		impact.added = proposed.tasks.map((task) => task.taskId);
		for (const task of proposed.tasks) details(task.taskId, "initial breakdown requires independent planning review");
		return impact;
	}
	impact.previousRevision = previous.revision;
	const previousTasks = new Map(previous.tasks.map((task) => [task.taskId, task]));
	const proposedTasks = new Map(proposed.tasks.map((task) => [task.taskId, task]));
	for (const [taskId, task] of proposedTasks) {
		const before = previousTasks.get(taskId);
		if (before === undefined) {
			impact.added.push(taskId);
			// A new task contract introduces new dependency edges, ownership and
			// scope, so the separate planning assessment is required. It stays
			// inside the approved grant, so no operator decision is implied.
			impact.requiresIndependentReview = true;
			details(taskId, "new task contract");
			continue;
		}
		if (taskContractHash(task) !== taskContractHash(before)) {
			impact.changed.push(taskId);
			const changedFields = changedContractFields(before, task);
			details(taskId, `contract changed: ${changedFields.join(", ") || "canonical contents"}`);
			if (changedFields.some((field) => REVIEW_RELEVANT_FIELDS.has(field)) || changedFields.length === 0) {
				impact.requiresIndependentReview = true;
			}
		} else if (!dependencyInterfaceUnchanged(before, task, previousTasks, proposedTasks)) {
			impact.recontextualised.push(taskId);
			impact.requiresIndependentReview = true;
			details(taskId, "prerequisite/interface context changed");
		} else if (previous.reviewedHashes[taskId] === task.contractHash) {
			impact.carriedForward.push(taskId);
			details(taskId, "review evidence carried forward (unchanged contract and interface context)");
		} else {
			impact.changed.push(taskId);
			impact.requiresIndependentReview = true;
			details(taskId, "no reviewed hash for this contract revision");
		}
	}
	for (const taskId of previousTasks.keys()) {
		if (!proposedTasks.has(taskId)) {
			impact.removed.push(taskId);
			details(taskId, "task contract removed from the proposed graph");
		}
	}
	const previousConditions = new Map(previous.successConditions.map((condition) => [condition.id, condition]));
	const proposedConditions = new Map(proposed.successConditions.map((condition) => [condition.id, condition]));
	for (const [id, condition] of proposedConditions) {
		const before = previousConditions.get(id);
		if (before === undefined) {
			impact.requiresIndependentReview = true;
			details(id, "success condition added");
		} else if (before.statement !== condition.statement || before.evidence !== condition.evidence) {
			impact.requiresIndependentReview = true;
			details(id, "success condition changed");
		}
	}
	for (const id of previousConditions.keys()) {
		if (!proposedConditions.has(id)) {
			impact.requiresIndependentReview = true;
			impact.requiresOperatorDecision = true;
			details(id, "success condition removed: an agreed outcome boundary changed");
		}
	}
	if (previous.incrementId !== proposed.incrementId || previous.goal !== proposed.goal) {
		impact.requiresIndependentReview = true;
		impact.requiresOperatorDecision = true;
		details(proposed.incrementId, "increment goal changed");
	}
	if (impact.added.length + impact.changed.length + impact.recontextualised.length + impact.removed.length === 0) {
		impact.requiresParentReview = false;
	}
	return impact;
}

function changedContractFields(before: TaskContract, after: TaskContract): string[] {
	const fields = new Set<string>();
	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	for (const key of keys) {
		if (key === "contractHash") continue;
		const left = stableStringify((before as unknown as Record<string, unknown>)[key]);
		const right = stableStringify((after as unknown as Record<string, unknown>)[key]);
		if (left !== right) fields.add(key);
	}
	return [...fields].sort();
}

function dependencyInterfaceUnchanged(
	before: TaskContract,
	after: TaskContract,
	previousTasks: Map<string, TaskContract>,
	proposedTasks: Map<string, TaskContract>,
): boolean {
	const edgeKey = (task: TaskContract, contracts: Map<string, TaskContract>): string =>
		stableStringify(
			[...task.dependencies]
				.map((dependency) => ({
					taskId: dependency.taskId,
					reason: dependency.reason,
					supplies: dependency.supplies,
					dependsOnInterface: interfaceSignature(contracts.get(dependency.taskId)),
				}))
				.sort((a, b) => a.taskId.localeCompare(b.taskId)),
		);
	return edgeKey(before, previousTasks) === edgeKey(after, proposedTasks);
}

/**
 * The part of a contract that dependents actually consume. Prose-only changes
 * (title, evidence references, acceptance examples) do not invalidate a
 * dependent's carried-forward review evidence; an interface change does.
 */
function interfaceSignature(task: TaskContract | undefined): string {
	if (task === undefined) return "null";
	return stableStringify({
		kind: task.kind,
		outcome: task.outcome,
		successConditions: task.successConditions,
		scope: task.scope,
		verification: task.verification,
		ownership: task.ownership,
		dependencies: task.dependencies,
	});
}

// ─── Planning review validation ──────────────────────────────────────────────

const REVIEW_KEYS = new Set([
	"reviewId",
	"revision",
	"kind",
	"reviewerAgentId",
	"reviewerRole",
	"laneReference",
	"readOnly",
	"disposition",
	"findings",
	"reviewedHashes",
	"at",
]);

export function validatePlanningReview(
	input: unknown,
): { ok: true; review: PlanningReviewRecord } | { ok: false; errors: string[] } {
	const errors: string[] = [];
	if (!isPlainObject(input)) return { ok: false, errors: ["review must be an object"] };
	const extra = unknownKeys(input, REVIEW_KEYS);
	if (extra.length > 0) errors.push(`review has unknown fields: ${extra.join(", ")}`);
	if (!nonEmptyString(input.reviewId)) errors.push("review.reviewId must be a non-empty string");
	if (!Number.isInteger(input.revision) || (input.revision as number) < 1) {
		errors.push("review.revision must be a positive integer");
	}
	if (input.kind !== "independent-planning" && input.kind !== "parent-refinement") {
		errors.push("review.kind must be independent-planning or parent-refinement");
	}
	if (!nonEmptyString(input.reviewerAgentId)) errors.push("review.reviewerAgentId must be a non-empty string");
	if (input.reviewerRole !== "reviewer") errors.push("review.reviewerRole must be reviewer");
	if (input.laneReference !== undefined && !nonEmptyString(input.laneReference)) {
		errors.push("review.laneReference must be a non-empty string when present");
	}
	if (typeof input.readOnly !== "boolean") errors.push("review.readOnly must be a boolean");
	if (input.disposition !== "accepted" && input.disposition !== "changes-required") {
		errors.push("review.disposition must be accepted or changes-required");
	}
	if (!stringList(input.findings)) errors.push("review.findings must be a string array");
	if (!isPlainObject(input.reviewedHashes)) {
		errors.push("review.reviewedHashes must be an object of taskId -> contract hash");
	} else {
		for (const [taskId, hash] of Object.entries(input.reviewedHashes)) {
			if (!ID_PATTERN.test(taskId) || typeof hash !== "string" || !HASH_PATTERN.test(hash)) {
				errors.push(`review.reviewedHashes has a malformed entry for ${taskId}`);
			}
		}
	}
	if (!nonEmptyString(input.at)) errors.push("review.at must be a non-empty string");
	if (input.kind === "independent-planning" && (input.readOnly !== true || !nonEmptyString(input.laneReference))) {
		errors.push("independent-planning requires a read-only governed review lane (laneReference)");
	}
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, review: cloneJson(input) as unknown as PlanningReviewRecord };
}

// ─── Dispatch admission ──────────────────────────────────────────────────────

export type LaunchIntentState = {
	recorded: boolean;
	verified: boolean;
	expired: boolean;
};

export type DispatchEvidence = {
	handoff?: string;
	changedFiles?: string[];
	checks?: string[];
	sources?: string[];
};

export type DispatchRequest = {
	state: DecompositionState | undefined;
	taskId: string;
	intent: DispatchIntent;
	phase: ProgrammePhase;
	role: OperatingRole;
	agentId: string;
	acceptedRevision?: number;
	/** The one task this session currently edits under (Muster selected write task). */
	selectedTaskId?: string;
	repository?: string;
	target?: { relativePath: string; repository?: string };
	grant?: Pick<GrantTerms, "repositories" | "authorizedWork" | "excludedExternalOperations" | "acceptanceThreshold">;
	backlogSource?: BacklogSource;
	jiraAdapterActive?: boolean;
	taskStates?: Record<string, TaskLifecycleObservation>;
	currentOwners?: Record<string, string>;
	capacity?: { limit?: number; inFlight?: number };
	lane?: { kind: "pi" | "native" | "delegate" | "unknown"; reference?: string };
	launchIntent?: LaunchIntentState;
	evidence?: DispatchEvidence;
	action?: string;
	ownerAgentId?: string;
	toAgentId?: string;
	version?: number;
	observedVersion?: number;
};

function deny(
	reason: RefusalReason,
	code: AgileDenialCode,
	detail: string,
	setupCondition?: string,
): DispatchDecision {
	return setupCondition
		? { allow: false, reason, code, detail, setupCondition }
		: { allow: false, reason, code, detail };
}

function phaseDenial(phase: ProgrammePhase): DispatchDecision | undefined {
	if (phase === "active") return undefined;
	if (phase === "setup") {
		return deny("initiative_not_approved", "decomposition_not_accepted", "programme is in setup; no approved grant");
	}
	if (phase === "pausing" || phase === "paused") {
		return deny("programme_paused", "no_admitted_task", `admission is closed (${phase})`);
	}
	if (phase === "recovery-required") {
		return deny("recovery_required", "state_malformed", "programme requires recovery");
	}
	const mapping = PHASE_REFUSALS[phase];
	return deny(mapping.reason, mapping.code, `programme is ${phase}`);
}

/** Grant repositories contain the repository/checkout (path or name). */
export function repositoryMatchesGrant(repository: string, repositories: RepositoryRef[]): boolean {
	const target = normalizeArtifactKey(repository);
	if (target === "") return false;
	return repositories.some((entry) => {
		const candidates = [normalizeArtifactKey(entry.name), normalizeArtifactKey(entry.path)].filter(
			(candidate) => candidate !== "",
		);
		return candidates.some(
			(granted) =>
				target === granted || target.startsWith(`${granted}/`) || granted.startsWith(`${target}/`),
		);
	});
}

function scopeCoversPath(task: TaskContract, relativePath: string, repository?: string): boolean {
	if (repository !== undefined && task.scope.repository.trim() !== "") {
		const taskRepo = normalizeArtifactKey(task.scope.repository);
		const targetRepo = normalizeArtifactKey(repository);
		if (
			taskRepo !== "" &&
			targetRepo !== "" &&
			taskRepo !== targetRepo &&
			!taskRepo.startsWith(`${targetRepo}/`) &&
			!targetRepo.startsWith(`${taskRepo}/`)
		) {
			return false;
		}
	}
	const candidate = normalizeArtifactKey(relativePath);
	return writeTargets(task).some((target) => candidate === target || candidate.startsWith(`${target}/`));
}

function dependencyReadiness(
	task: TaskContract,
	taskStates: Record<string, TaskLifecycleObservation>,
): DispatchDecision | undefined {
	for (const dependency of task.dependencies) {
		const observed = taskStates[dependency.taskId];
		if (observed === undefined) {
			return deny(
				"task_not_active",
				"dependency_state_unknown",
				`${dependency.taskId} has no observable lifecycle status (needs ${dependency.supplies})`,
			);
		}
		if (!DEPENDENCY_SATISFIED_STATUSES.has(observed.status)) {
			return deny(
				"task_not_active",
				"dependency_not_satisfied",
				`${dependency.taskId} is ${observed.status}; needs ${dependency.supplies} (${dependency.reason})`,
			);
		}
	}
	return undefined;
}

function ownershipConflictFor(task: TaskContract, request: DispatchRequest): DispatchDecision | undefined {
	const owners = request.currentOwners ?? {};
	const owner = task.ownership.assignedAgentId;
	for (const [otherId, otherOwner] of Object.entries(owners)) {
		if (otherId === task.taskId) continue;
		const other = request.state?.graph.tasks.find((candidate) => candidate.taskId === otherId);
		if (other === undefined) continue;
		if (owner !== undefined && otherOwner === owner) continue;
		const shared = sharedWriteTargets(task, other);
		if (shared.length > 0) {
			return deny(
				"wrong_owner",
				"shared_writer_conflict",
				`${otherId} (owner ${otherOwner}) already writes ${shared.join(", ")}`,
			);
		}
	}
	return undefined;
}

function uncertaintyDenial(task: TaskContract): DispatchDecision | undefined {
	if (task.uncertainty?.blocker !== undefined) {
		return deny("task_not_active", "unresolved_blocker", task.uncertainty.blocker);
	}
	if (task.uncertainty?.provisional === true) {
		return deny("task_not_active", "provisional", "task is provisional until its dependency is established");
	}
	return undefined;
}

function capacityDenial(request: DispatchRequest): DispatchDecision | undefined {
	const limit = request.capacity?.limit;
	if (limit === undefined) return undefined;
	const inFlight = Math.max(0, request.capacity?.inFlight ?? 0);
	if (inFlight >= limit) {
		return deny("task_not_active", "capacity_exhausted", `configured capacity ${limit} is already in flight`);
	}
	return undefined;
}

function bootstrapAllowed(task: TaskContract, request: DispatchRequest): boolean {
	if (task.kind !== "research" && task.kind !== "review") return false;
	if (task.ownership.writes.length > 0 || task.scope.readOnly !== true) return false;
	const authorized = (request.grant?.authorizedWork ?? []).join(" ").toLowerCase();
	return /research|investigation|review|discovery/.test(authorized);
}

function ownershipMatch(task: TaskContract, request: DispatchRequest): DispatchDecision {
	const assigned = task.ownership.assignedAgentId;
	if (assigned !== undefined && assigned !== request.agentId) {
		return deny(
			"wrong_owner",
			"task_owned_by_another_agent",
			`${task.taskId} is assigned to ${assigned}; this session is ${request.agentId}`,
		);
	}
	if (
		assigned === undefined &&
		request.role !== task.ownership.intendedRole &&
		request.role !== "parent"
	) {
		return deny(
			"wrong_owner",
			"ownership_mismatch",
			`${task.taskId} intends the ${task.ownership.intendedRole} role; this session is ${request.role}`,
		);
	}
	return { allow: true };
}

function bootstrapAdmission(task: TaskContract, request: DispatchRequest): DispatchDecision {
	if (request.grant === undefined) {
		return deny("initiative_not_approved", "decomposition_not_accepted", "no approved grant bounds this work");
	}
	if (!bootstrapAllowed(task, request)) {
		return deny(
			"initiative_not_approved",
			"investigation_scope_not_authorized",
			"the approved grant does not authorize governed investigation/review work",
		);
	}
	const ownership = ownershipMatch(task, request);
	if (!ownership.allow) return ownership;
	const dependencies = dependencyReadiness(task, request.taskStates ?? {});
	if (dependencies !== undefined) return dependencies;
	const uncertainty = uncertaintyDenial(task);
	if (uncertainty !== undefined) return uncertainty;
	return { allow: true };
}

function startAdmission(task: TaskContract, request: DispatchRequest): DispatchDecision {
	const ownership = ownershipMatch(task, request);
	if (!ownership.allow) return ownership;
	const dependencies = dependencyReadiness(task, request.taskStates ?? {});
	if (dependencies !== undefined) return dependencies;
	const uncertainty = uncertaintyDenial(task);
	if (uncertainty !== undefined) return uncertainty;
	if (request.role !== "parent") {
		const capacity = capacityDenial(request);
		if (capacity !== undefined) return capacity;
	}
	const conflict = ownershipConflictFor(task, request);
	if (conflict !== undefined) return conflict;
	return { allow: true };
}

function writeAdmission(task: TaskContract, request: DispatchRequest): DispatchDecision {
	if (request.selectedTaskId !== task.taskId) {
		return deny(
			"task_not_active",
			"no_admitted_task",
			request.selectedTaskId === undefined
				? "no admitted task is selected in this session"
				: `the selected write task is ${request.selectedTaskId}, not ${task.taskId}`,
		);
	}
	const ownership = ownershipMatch(task, request);
	if (!ownership.allow) return ownership;
	const uncertainty = uncertaintyDenial(task);
	if (uncertainty !== undefined) return uncertainty;
	const dependencies = dependencyReadiness(task, request.taskStates ?? {});
	if (dependencies !== undefined) return dependencies;
	if (request.repository !== undefined && !repositoryMatchesGrant(request.repository, request.grant?.repositories ?? [])) {
		return deny("wrong_owner", "repository_not_in_grant", `${request.repository} is outside the approved grant repositories`);
	}
	if (request.target !== undefined) {
		if (request.target.repository !== undefined && request.repository === undefined) {
			return deny(
				"wrong_owner",
				"repository_not_in_grant",
				`${request.target.repository} is outside the approved grant repositories`,
			);
		}
		if (!scopeCoversPath(task, request.target.relativePath, request.repository)) {
			return deny(
				"task_not_active",
				"target_outside_task_scope",
				`${request.target.relativePath} is outside ${task.taskId}'s declared write scope`,
			);
		}
	}
	const conflict = ownershipConflictFor(task, request);
	if (conflict !== undefined) return conflict;
	return { allow: true };
}

function launchAdmission(task: TaskContract, request: DispatchRequest): DispatchDecision {
	if (request.role !== "parent") {
		return deny("wrong_owner", "launch_requires_parent", "only the parent role may launch or assign workers");
	}
	if (request.lane !== undefined && request.lane.kind !== "pi") {
		return deny(
			"unsupported_lane",
			"agile_supports_pi_lanes_only",
			`${request.lane.kind} lanes are not supported by this Agile implementation`,
		);
	}
	if (task.ownership.intendedRole === "parent" && request.toAgentId !== undefined && request.toAgentId !== request.agentId) {
		return deny(
			"wrong_owner",
			"ownership_mismatch",
			`${task.taskId} is parent-owned work and is not delegated to a worker lane`,
		);
	}
	if (request.toAgentId !== undefined && request.toAgentId === request.agentId) {
		return deny("wrong_owner", "ownership_mismatch", "the parent cannot assign a task to itself");
	}
	if (
		request.toAgentId !== undefined &&
		task.ownership.assignedAgentId !== undefined &&
		task.ownership.assignedAgentId !== request.toAgentId
	) {
		return deny(
			"wrong_owner",
			"ownership_mismatch",
			`${task.taskId} is assigned to ${task.ownership.assignedAgentId}, not ${request.toAgentId}`,
		);
	}
	const dependencies = dependencyReadiness(task, request.taskStates ?? {});
	if (dependencies !== undefined) return dependencies;
	const uncertainty = uncertaintyDenial(task);
	if (uncertainty !== undefined) return uncertainty;
	const capacity = capacityDenial(request);
	if (capacity !== undefined) return capacity;
	const conflict = ownershipConflictFor(task, request);
	if (conflict !== undefined) return conflict;
	const intent = request.launchIntent;
	if (intent === undefined || !intent.recorded) {
		return deny(
			"task_not_active",
			"launch_intent_required",
			`no persisted launch intent covers ${task.taskId}; launch through the Muster/Herdr path`,
		);
	}
	if (intent.expired) {
		return deny(
			"task_not_active",
			"launch_intent_expired",
			`the launch intent for ${task.taskId} is unverified and expired; reconcile the lane before retrying`,
		);
	}
	// The lane's binding/guard handshake is verified by the Muster owner
	// immediately before it calls Concord assign (after this admission), so an
	// unverified-but-fresh intent does not deny here; a stale one does.
	return { allow: true };
}

function handoffAdmission(task: TaskContract, request: DispatchRequest): DispatchDecision {
	const currentOwner = request.ownerAgentId ?? task.ownership.assignedAgentId;
	if (currentOwner !== undefined && currentOwner !== request.agentId) {
		return deny(
			"wrong_owner",
			"current_owner_required",
			`${task.taskId} is currently owned by ${currentOwner}; this session is ${request.agentId}`,
		);
	}	if (request.version !== undefined && request.observedVersion !== undefined && request.version !== request.observedVersion) {
		return deny(
			"task_not_active",
			"stale_task_version",
			`expected version ${request.version} does not match observed ${request.observedVersion}`,
		);
	}
	if (request.action === "release" || request.action === "decline") return { allow: true };
	if (!hasAttributableEvidence(request.evidence)) {
		return deny(
			"task_not_active",
			"handoff_evidence_missing",
			"a handoff requires attributable evidence (what changed, changed files, checks or sources)",
		);
	}
	return { allow: true };
}

function closureAdmission(task: TaskContract, request: DispatchRequest): DispatchDecision {
	const outcome = request.action ?? "complete";
	if (request.role !== "parent") {
		if (outcome !== "handoff") {
			return deny(
				"wrong_owner",
				outcome === "review_ready" ? "worker_review_ready_not_admitted" : "closure_authority_worker_denied",
				outcome === "review_ready"
					? "directed workers offer a handoff instead of claiming review_ready"
					: "closure authority belongs to the parent; a worker offers a handoff",
			);
		}
		// A worker's `handoff` outcome is an offer: current owner plus evidence.
		return handoffAdmission(task, request);
	}
	if (request.version !== undefined && request.observedVersion !== undefined && request.version !== request.observedVersion) {
		return deny(
			"task_not_active",
			"stale_task_version",
			`expected version ${request.version} does not match observed ${request.observedVersion}`,
		);
	}
	if (outcome === "handoff") return handoffAdmission(task, request);
	if (request.action === "accept") return { allow: true };
	if (!hasAttributableEvidence(request.evidence)) {
		return deny(
			"task_not_active",
			"closure_evidence_missing",
			"closure requires attributable evidence and the approved acceptance requirements",
		);
	}
	return { allow: true };
}

function hasAttributableEvidence(evidence: DispatchEvidence | undefined): boolean {
	if (evidence === undefined) return false;
	return (
		nonEmptyString(evidence.handoff) ||
		(evidence.changedFiles?.length ?? 0) > 0 ||
		(evidence.checks?.length ?? 0) > 0 ||
		(evidence.sources?.length ?? 0) > 0
	);
}

/** Worker-side lifecycle guard reused by the Muster tool path. */
export function assertWorkerLifecycleAllowed(
	role: OperatingRole,
	toolName: string,
	args: Record<string, unknown>,
): DispatchDecision {
	if (role !== "worker") return { allow: true };
	if (toolName === "muster_finish") {
		const outcome = typeof args["outcome"] === "string" ? (args["outcome"] as string) : "complete";
		if (outcome === "complete" || outcome === "closed") {
			return deny(
				"wrong_owner",
				"closure_authority_worker_denied",
				"a worker offers a handoff; the parent verifies and finishes",
			);
		}
		if (outcome === "review_ready") {
			return deny(
				"wrong_owner",
				"worker_review_ready_not_admitted",
				"directed workers offer a handoff instead of claiming review_ready",
			);
		}
	}
	if (toolName === "muster_transfer") {
		const action = typeof args["action"] === "string" ? (args["action"] as string) : "";
		if (action === "reassign") {
			return deny("wrong_owner", "closure_authority_worker_denied", "a worker cannot reassign programme work");
		}
	}
	return { allow: true };
}

/**
 * Task admission: grant, phase, role, accepted revision, required review
 * evidence, dependency satisfaction, ownership and capacity. Lifecycle
 * statuses are read from observations, never invented.
 */
export function canDispatchTask(request: DispatchRequest): DispatchDecision {
	if (request.backlogSource?.kind === "jira" && request.jiraAdapterActive !== true) {
		return deny(
			"unsupported_lane",
			"jira_connector_inactive",
			"the programme's policy requires Jira as the product authority, but the Jira adapter is inactive",
			"Provision and verify the live Jira account/project/policy binding and connector through the approved Toolbelt/official ACLI path, then revalidate. Do not substitute a local backlog.",
		);
	}
	const phase = phaseDenial(request.phase);
	if (phase !== undefined) return phase;
	if (request.grant === undefined) {
		return deny("initiative_not_approved", "decomposition_not_accepted", "no approved grant bounds this work");
	}
	const state = request.state;
	if (state === undefined) {
		return deny("task_not_active", "decomposition_not_proposed", "no decomposition revision exists for this programme");
	}
	const task = state.graph.tasks.find((candidate) => candidate.taskId === request.taskId);
	if (task === undefined) {
		return deny(
			"task_not_active",
			"task_not_in_decomposition",
			`${request.taskId} is not part of the proposed decomposition`,
		);
	}
	// Authorization precedes task state: a worker asking for a parent-only lifecycle
	// outcome is refused for authority, so the reason names the real problem instead
	// of a downstream task-state condition.
	if (request.role !== "parent" && request.intent === "closure") {
		const outcome = request.action ?? "complete";
		if (outcome !== "handoff") {
			return deny(
				"wrong_owner",
				outcome === "review_ready" ? "worker_review_ready_not_admitted" : "closure_authority_worker_denied",
				outcome === "review_ready"
					? "directed workers offer a handoff instead of claiming review_ready"
					: "closure authority belongs to the parent; a worker offers a handoff",
			);
		}
	}
	const accepted = state.accepted;
	const acceptedCurrent = accepted !== undefined && accepted.revision === state.graph.revision;
	if (!acceptedCurrent) {
		if (bootstrapAllowed(task, request) && (request.intent === "start" || request.intent === "research")) {
			return bootstrapAdmission(task, request);
		}
		if (accepted === undefined) {
			return deny(
				"task_not_active",
				"decomposition_not_accepted",
				request.intent === "write" || request.intent === "closure" || request.intent === "handoff"
					? "no accepted decomposition revision exists; implementation work cannot be dispatched"
					: "no accepted decomposition revision exists",
			);
		}
		return deny(
			"task_not_active",
			"decomposition_revision_not_accepted",
			`revision ${state.graph.revision} is not the accepted revision ${accepted.revision}`,
		);
	}
	if (request.acceptedRevision !== undefined && request.acceptedRevision !== accepted!.revision) {
		return deny(
			"task_not_active",
			"stale_accepted_revision",
			`caller holds revision ${request.acceptedRevision}; accepted is ${accepted!.revision}`,
		);
	}
	// Review evidence must bind to this exact contract hash at this revision.
	// The accepted revision records its own reviewed hashes; a mismatch means the
	// accepted revision never covered this contract, so dispatch is refused even
	// if a review record elsewhere still carries the old hash.
	if (accepted!.reviewedHashes[task.taskId] !== task.contractHash) {
		return deny(
			"task_not_active",
			"review_evidence_missing",
			`the accepted revision records no review evidence for ${task.taskId} at contract ${task.contractHash.slice(0, 12)}`,
		);
	}
	const review = state.reviews.find((candidate) => candidate.reviewId === accepted!.reviewId);
	if (review === undefined) {
		return deny("task_not_active", "review_evidence_missing", "the accepted revision has no planning review record");
	}
	if (review.reviewedHashes[task.taskId] !== task.contractHash) {
		return deny(
			"task_not_active",
			"review_evidence_missing",
			`no review evidence covers ${task.taskId} at contract ${task.contractHash.slice(0, 12)}`,
		);
	}
	if (accepted!.reviewKind === "independent-planning" && review.kind !== "independent-planning") {
		return deny(
			"task_not_active",
			"independent_review_required",
			"this revision changed acceptance/dependency/ownership context and needs the separate read-only planning assessment",
		);
	}
	if (review.disposition !== "accepted") {
		return deny("task_not_active", "review_not_accepted", `the recorded planning review disposition is ${review.disposition}`);
	}

	switch (request.intent) {
		case "research":
			return bootstrapAdmission(task, request);
		case "start":
			return startAdmission(task, request);
		case "write":
			return writeAdmission(task, request);
		case "launch":
		case "assign":
			return launchAdmission(task, request);
		case "handoff":
			return handoffAdmission(task, request);
		case "record": {
			// Durable task context, not a lifecycle handoff: the current owner (or
			// the parent supervising it) may record, but the task itself must be
			// admitted by the checks above.
			const currentOwner = request.ownerAgentId ?? task.ownership.assignedAgentId;
			if (request.role !== "parent" && currentOwner !== undefined && currentOwner !== request.agentId) {
				return deny(
					"wrong_owner",
					"current_owner_required",
					`${task.taskId} is currently owned by ${currentOwner}; this session is ${request.agentId}`,
				);
			}
			return { allow: true };
		}
		case "closure":
			return closureAdmission(task, request);
	}
}

// ─── Backlog source adapter (Jira stays inactive) ────────────────────────────

export type BacklogSourceAdapter = {
	kind: "approved-plan" | "jira";
	reference: string;
	ready: true;
};

export type BacklogSourceGate =
	| { ok: true; adapter: BacklogSourceAdapter }
	| { ok: false; code: AgileDenialCode; detail: string; setupCondition: string };

/**
 * Exactly one intent source. The local approved-plan path is implemented; the
 * Jira adapter stays inactive until the separate live account/project/policy
 * binding and connector are approved and verified. A Jira-required policy is
 * blocked with that setup condition, never silently downgraded to a local
 * backlog.
 */
export function resolveBacklogSource(
	source: BacklogSource | undefined,
	deps: { jiraAdapterActive?: boolean; jiraSetupCondition?: string } = {},
): BacklogSourceGate {
	if (source === undefined || source.kind === "approved-plan") {
		return {
			ok: true,
			adapter: { kind: "approved-plan", reference: source?.reference ?? "approved-plan", ready: true },
		};
	}
	if (deps.jiraAdapterActive === true) {
		return { ok: true, adapter: { kind: "jira", reference: source.reference, ready: true } };
	}
	return {
		ok: false,
		code: "jira_connector_inactive",
		detail: "the policy requires Jira as the product authority, but the Jira adapter is inactive",
		setupCondition:
			deps.jiraSetupCondition ??
			"Provision and verify the live Jira account/project/policy binding and connector through the approved Toolbelt/official ACLI path, then revalidate. Do not substitute a local backlog.",
	};
}

// ─── Operation classification and admission policy ───────────────────────────

export type AgileOperationClass =
	| "read-only"
	| "structured-write"
	| "opaque-execution"
	| "external-provider"
	| "operator-shell"
	| "delegated-dispatch"
	| "local-binding"
	| "task-start"
	| "task-update"
	| "task-transfer"
	| "task-closure"
	| "unclassified";

const OPERATION_CLASSES: Record<string, AgileOperationClass> = {
	edit: "structured-write",
	write: "structured-write",
	bash: "opaque-execution",
	powershell: "opaque-execution",
	run_code: "opaque-execution",
	// H3 replaces run_code. opaqueText() reads the script from its `code` argument, and the nested
	// calls (bash, edit, write) are admitted on their own as programmatic calls.
	codemode: "opaque-execution",
	toolbelt: "external-provider",
	pi_toolbelt: "external-provider",
	delegate: "delegated-dispatch",
	user_bash: "operator-shell",
	muster_join: "local-binding",
	muster_status: "read-only",
	muster_inspect: "read-only",
	muster_start: "task-start",
	muster_update: "task-update",
	muster_transfer: "task-transfer",
	muster_finish: "task-closure",
};

/**
 * Classify by the tool's actual owner/contract, never by a model risk score.
 * Unknown/newly registered tools are unclassified: they earn no exemption.
 */
export function classifyAgileOperation(toolName: string): AgileOperationClass {
	if (OPERATION_CLASSES[toolName] !== undefined) return OPERATION_CLASSES[toolName]!;
	if (AGILE_READ_ONLY_TOOLS.has(toolName)) return "read-only";
	return "unclassified";
}

// ─── Opaque command classification ───────────────────────────────────────────

export type LaunchAttempt = {
	laneKind: "pi" | "native" | "unknown";
	taskId?: string;
	agentId?: string;
};

export type OpaqueCommandClassification = {
	launch?: LaunchAttempt;
	protectedPaths: string[];
	excludedOperations: string[];
};

function tokens(command: string): string[] {
	return command
		.split(/[\s;|&()<>`"']+/)
		.map((token) => token.trim())
		.filter((token) => token !== "");
}

function looksLikeLaneLaunch(command: string): boolean {
	const parts = tokens(command);
	const hasHerdr = parts.some((token) => token === "herdr" || token.endsWith("/herdr"));
	if (!hasHerdr) return false;
	const joined = ` ${parts.join(" ")} `;
	return /\b(agent\s+start|pane\s+split)\b/.test(joined);
}

function looksLikeBarePiLaunch(command: string): boolean {
	const parts = tokens(command);
	const piToken = parts.findIndex((token) => token === "pi" || token.endsWith("/pi"));
	if (piToken === -1) return false;
	const rest = parts.slice(piToken + 1);
	return rest.some((token) =>
		["-p", "-e", "--extension", "--session", "--mode", "--continue", "-c", "--fork"].includes(token),
	);
}

function laneKindOf(command: string): "pi" | "native" | "unknown" {
	if (/--kind\s+(claude|codex)\b/.test(command)) return "native";
	if (/--kind\s+pi\b/.test(command)) return "pi";
	return tokens(command).includes("herdr") ? "unknown" : "pi";
}

function envValue(command: string, name: string): string | undefined {
	const match = command.match(new RegExp(`${name}=([A-Za-z0-9_.:-]+)`));
	return match?.[1];
}

/**
 * Inspect an opaque execution request. Lane launches must name the admitted
 * task (`CONCORD_TASK=<task>`) so admission can check dependency readiness,
 * review evidence, lane kind, ownership and capacity before anything spawns.
 */
export function classifyOpaqueCommand(
	command: string,
	options: { protectedPaths?: string[]; excludedExternalOperations?: string[] } = {},
): OpaqueCommandClassification {
	const classification: OpaqueCommandClassification = { protectedPaths: [], excludedOperations: [] };
	if (typeof command !== "string" || command.trim() === "") return classification;
	if (looksLikeLaneLaunch(command) || looksLikeBarePiLaunch(command)) {
		const attempt: LaunchAttempt = { laneKind: laneKindOf(command) };
		const taskId = envValue(command, "CONCORD_TASK");
		const agentId = envValue(command, "CONCORD_AGENT_ID");
		if (taskId !== undefined) attempt.taskId = taskId;
		if (agentId !== undefined) attempt.agentId = agentId;
		classification.launch = attempt;
	}
	const normalizedCommand = command.replace(/\\/g, "/");
	for (const protectedPath of options.protectedPaths ?? []) {
		const normalizedPath = protectedPath.replace(/\\/g, "/").replace(/\/+$/, "");
		if (normalizedPath !== "" && normalizedCommand.includes(normalizedPath)) {
			classification.protectedPaths.push(normalizedPath);
		}
	}
	for (const operation of options.excludedExternalOperations ?? []) {
		if (matchesExcludedOperation(command, [operation])) classification.excludedOperations.push(operation);
	}
	return classification;
}

/** Word-boundary match for a single term; substring for a multi-word phrase. */
export function matchesExcludedOperation(text: string, excluded: readonly string[]): boolean {
	const haystack = text.toLowerCase();
	for (const raw of excluded) {
		const term = raw.trim().toLowerCase();
		if (term === "") continue;
		if (term.includes(" ")) {
			if (haystack.includes(term)) return true;
			continue;
		}
		const pattern = new RegExp(`(^|[^a-z0-9_-])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9_-]|$)`);
		if (pattern.test(haystack)) return true;
	}
	return false;
}

// ─── Muster admission policy ─────────────────────────────────────────────────

export type MusterAdmissionContext = {
	role(): OperatingRole;
	agentId(): string;
	grant(): GrantTerms | undefined;
	decomposition(programmeId: string): DecompositionState | undefined;
	currentWriteTaskId(): string | undefined;
	resolveTarget(
		toolName: string,
		args: Record<string, unknown>,
	): { repository?: string; relativePath?: string } | undefined;
	taskStates(): Record<string, TaskLifecycleObservation>;
	currentOwners(): Record<string, string>;
	capacity(): { limit?: number; inFlight?: number } | undefined;
	launchIntent?(taskId: string, agentId?: string): LaunchIntentState | undefined;
	backlogSource?(): BacklogSource | undefined;
	jiraAdapterActive?: boolean;
	protectedPaths?: string[];
	/**
	 * Optional P3 hooks (descendant writer reservations and join-before-offer).
	 * Absent → admission is unchanged: non-enrolled and non-lane sessions make no
	 * control-store call, and offer gates are inert.
	 */
	descendants?: () => MusterDescendantContext | undefined;
};

function refusalDecision(decision: Extract<DispatchDecision, { allow: false }>): AdmissionDecision {
	const suffix = decision.setupCondition === undefined ? "" : ` Setup condition: ${decision.setupCondition}`;
	return {
		allow: false,
		reason: decision.reason,
		detail: `${decision.code}: ${decision.detail}${suffix}`,
	};
}

function evidenceFromArgs(args: Record<string, unknown>): DispatchEvidence {
	const list = (value: unknown): string[] | undefined =>
		Array.isArray(value) && value.every((entry) => typeof entry === "string") ? (value as string[]) : undefined;
	const evidence: DispatchEvidence = {};
	if (typeof args["what_changed"] === "string") evidence.handoff = args["what_changed"];
	const changedFiles = list(args["changed_files"]);
	if (changedFiles !== undefined) evidence.changedFiles = changedFiles;
	const checks = list(args["tests_run"]);
	if (checks !== undefined) evidence.checks = checks;
	const sources = [...(list(args["sources"]) ?? []), ...(list(args["evidence_refs"]) ?? [])];
	// Concord's finish_work evidence fields: a structured reported outcome, a
	// provenance list and a diff size are all attributable evidence.
	if (isPlainObject(args["reported_outcome"]) && Object.keys(args["reported_outcome"]).length > 0) {
		sources.push("reported_outcome");
	}
	if (Array.isArray(args["provenance"])) {
		for (const entry of args["provenance"] as unknown[]) {
			if (isPlainObject(entry) && nonEmptyString(entry["source"])) sources.push(String(entry["source"]));
		}
	}
	if (typeof args["diff_size"] === "number" && args["diff_size"] > 0) sources.push("diff_size");
	if (sources.length > 0) evidence.sources = sources;
	return evidence;
}

function intentForMusterTool(toolName: string, args: Record<string, unknown>): DispatchIntent | undefined {
	switch (toolName) {
		case "muster_start":
			return "start";
		case "muster_transfer": {
			const action = typeof args["action"] === "string" ? (args["action"] as string) : "";
			if (action === "assign" || action === "reassign") return "assign";
			if (action === "offer") return "handoff";
			if (action === "accept") return typeof args["handoff_id"] === "number" ? "closure" : "start";
			if (action === "reopen") return "closure";
			return undefined;
		}
		case "muster_finish":
			return "closure";
		default:
			return undefined;
	}
}

function opaqueText(args: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const key of ["command", "code", "args", "operation", "action"]) {
		const value = args[key];
		if (typeof value === "string") parts.push(value);
	}
	if (parts.length === 0) parts.push(JSON.stringify(args));
	return parts.join(" ");
}

function scopeAllowsProtected(taskId: string, state: DecompositionState | undefined, protectedPaths: string[]): boolean {
	const task = state?.graph.tasks.find((candidate) => candidate.taskId === taskId);
	if (task === undefined) return false;
	// A harness/control path is reachable only when the approved decomposition
	// declares it in this task's write scope ("related work"), never incidentally.
	const declared = writeTargets(task);
	return protectedPaths.every((candidate) => {
		const normalized = candidate.replace(/\\/g, "/").replace(/\/+$/, "");
		return declared.some((target) => normalized === target || normalized.endsWith(`/${target}`));
	});
}

// ─── P3 — descendant writer reservations and join-before-offer ───────────────
//
// A persistent Muster lane is a scoped local parent of bounded leaf delegates
// (plan §3 L2, §7 P3). Two invariants live here, both against the one programme
// control record (control.ts):
// - a lane's subtree write set is reserved in the control store before its task
//   work is admitted, so the programme's writer ceiling and file ownership
//   cover the whole descendant set rather than only the lane process;
// - a lane offers its handoff only after every reserved leaf in its subtree is
//   settled, and the admitted offer releases the lane's own reservation.
//
// Sibling lanes cannot overlap: `reserveDescendantWriter` refuses an overlapping
// reservation with a typed conflict naming both owners, and the refusal here
// stops the dispatch instead of letting the workers collide.

/** Optional P3 hooks. Absent → admission behaves exactly as before. */
export type MusterDescendantContext = {
	/** This session's lane identity (`lane:<sessionRef>`); undefined when it is not a persistent lane. */
	laneOwnerRef?: () => string | undefined;
	/** Leaf identities (`leaf:<delegateId>`) whose delegate record is settled and joined. */
	settledLeafOwnerRefs?: () => readonly string[];
	/** Programme control store context (tests pass an isolated store). */
	control?: ProgrammeControlContext;
};

/** Build the descendant hooks for one session from its own identity readers. */
export function createMusterDescendantContext(input: {
	sessionRef: () => string | undefined;
	settledLeafOwnerRefs?: () => readonly string[];
	control?: ProgrammeControlContext;
}): MusterDescendantContext {
	const context: MusterDescendantContext = {
		laneOwnerRef: () => {
			const sessionRef = input.sessionRef();
			return typeof sessionRef === "string" && sessionRef.trim() !== "" ? laneOwnerRef(sessionRef) : undefined;
		},
	};
	if (input.settledLeafOwnerRefs !== undefined) context.settledLeafOwnerRefs = input.settledLeafOwnerRefs;
	if (input.control !== undefined) context.control = input.control;
	return context;
}

/** A broken descendant hook must not take admission down: absence is today's behaviour. */
function safeDescendantContext(ctx: MusterAdmissionContext): MusterDescendantContext | undefined {
	try {
		return ctx.descendants?.();
	} catch {
		return undefined;
	}
}

export type DescendantReservationGate =
	| {
			allow: true;
			/** False when there was nothing to reserve (no declared files, or not enrolled). */
			reserved: boolean;
			/** True when this call created the owner's reservation row. */
			created: boolean;
			ownerRef: string;
			files: string[];
			added: string[];
			activeWriters: number;
	  }
	| { allow: false; reason: RefusalReason; code: AgileDenialCode; detail: string };

type DescendantRefusal = Extract<DescendantReservationGate, { allow: false }>;

function descendantRefusal(reason: RefusalReason, code: AgileDenialCode, detail: string): DescendantRefusal {
	return { allow: false, reason, code, detail };
}

/**
 * Reserve the files a lane's whole subtree will touch, before its dispatch.
 * Idempotent for the same lane; an overlap conflict from the control store
 * becomes a refusal naming both owners and the contested files instead of a
 * dispatch that lets two writers collide.
 *
 * A missing control record means the session is not enrolled: nothing can be
 * reserved and today's behaviour applies. State that cannot be read fails
 * closed rather than skipping the reservation silently.
 */
export function reserveLaneDescendants(input: {
	programmeId?: string | undefined;
	laneOwnerRef?: string | undefined;
	files: readonly string[];
	control?: ProgrammeControlContext;
}): DescendantReservationGate {
	const ownerRef = input.laneOwnerRef;
	const programmeId = input.programmeId;
	const files = [...new Set((input.files ?? []).map((file) => String(file).trim()).filter((file) => file !== ""))].sort();
	if (ownerRef === undefined || programmeId === undefined) {
		return { allow: true, reserved: false, created: false, ownerRef: ownerRef ?? "", files: [], added: [], activeWriters: 0 };
	}
	if (files.length === 0) {
		// A lane whose contract declares no writes reserves nothing: an empty file
		// set is not a whole-subtree claim.
		return { allow: true, reserved: false, created: false, ownerRef, files: [], added: [], activeWriters: 0 };
	}
	try {
		const commit = reserveDescendantWriter(programmeId, ownerRef, "lane", files, input.control);
		return {
			allow: true,
			reserved: true,
			created: commit.created,
			ownerRef: commit.reservation.ownerRef,
			files: commit.reservation.files,
			added: commit.added,
			activeWriters: commit.activeWriters,
		};
	} catch (error) {
		if (error instanceof ProgrammeControlStateError && error.code === "missing") {
			// Not enrolled: no control record exists, so there is nothing to reserve.
			return { allow: true, reserved: false, created: false, ownerRef, files: [], added: [], activeWriters: 0 };
		}
		if (error instanceof DescendantReservationConflictError) {
			return descendantRefusal(
				"wrong_owner",
				"shared_writer_conflict",
				`${error.ownerRef} cannot reserve ${error.files.join(", ")}: ${error.conflictingOwnerRef} already owns them`,
			);
		}
		if (error instanceof DescendantReservationLimitError) {
			return descendantRefusal("task_not_active", "capacity_exhausted", error.message);
		}
		if (error instanceof ProgrammeControlStateError) {
			return descendantRefusal(
				"task_not_active",
				"state_io",
				`descendant writer reservation unavailable: ${error.message}`,
			);
		}
		throw error;
	}
}

export type LaneDispatchGate =
	| {
			outcome: "dispatched";
			decision: DispatchDecision;
			reservation: Extract<DescendantReservationGate, { allow: true }>;
	  }
	| { outcome: "refused"; decision: Extract<DispatchDecision, { allow: false }> };

/**
 * The lane dispatch seam: evaluate the ordinary dispatch decision, reserve the
 * lane's descendant files, then run `dispatch` exactly once — only when both
 * gates allow. On any refusal the dispatch callback is never called, so the
 * lane is never created. A dispatch callback that refuses after the reservation
 * was created drops that fresh reservation again so a sibling can claim the
 * files; a reservation the lane already held is left exactly as it was.
 */
export function dispatchLaneWithDescendants(input: {
	programmeId?: string | undefined;
	laneOwnerRef?: string | undefined;
	files: readonly string[];
	control?: ProgrammeControlContext;
	/** Ordinary task/lane admission; defaults to allow because callers usually ran it already. */
	decide?: () => DispatchDecision;
	/** Performs the dispatch (Concord assignment / lane launch). Called at most once. */
	dispatch: () => DispatchDecision;
}): LaneDispatchGate {
	const decision: DispatchDecision = input.decide?.() ?? { allow: true };
	if (!decision.allow) return { outcome: "refused", decision };
	const reservation = reserveLaneDescendants({
		programmeId: input.programmeId,
		laneOwnerRef: input.laneOwnerRef,
		files: input.files,
		control: input.control,
	});
	if (!reservation.allow) return { outcome: "refused", decision: reservation };
	const dispatched = input.dispatch();
	if (!dispatched.allow) {
		if (
			reservation.created &&
			input.laneOwnerRef !== undefined &&
			input.programmeId !== undefined
		) {
			try {
				releaseDescendantWriter(input.programmeId, input.laneOwnerRef, input.control);
			} catch {
				/* the refusal already stands; a stale reservation is reconciled, not hidden */
			}
		}
		return { outcome: "refused", decision: dispatched };
	}
	return { outcome: "dispatched", decision: dispatched, reservation };
}

export type LaneOfferGate =
	| {
			allow: true;
			/** Always false on an admitted offer: the gate exists to withhold it. */
			held: false;
			ownerRef: string;
			/** Settled leaf reservations attributed to this lane, sorted. */
			joinedLeafOwnerRefs: string[];
			/** True when the lane's own reservation was released by this admission. */
			released: boolean;
			/** Present when descendants settled before the offer. */
			note?: string;
	  }
	| {
			allow: false;
			reason: RefusalReason;
			code: AgileDenialCode;
			detail: string;
			/** Unsettled leaf owner refs blocking the offer, sorted. */
			outstanding: string[];
	  };

/**
 * Join-before-offer: a lane may offer only when every leaf reservation in its
 * subtree is settled. `settledLeafOwnerRefs` is the caller's joined set — a
 * settled but unconsumed result must not be reported as joined. Leaf
 * reservations are attributed to the lane by file overlap with the lane's own
 * reservation, which is sound because sibling lanes cannot reserve overlapping
 * files.
 *
 * An admitted offer releases the lane's own reservation (leaf rows are released
 * by their own settlement path) and records that descendants settled first.
 * A lane with no reservation, or a session with no programme, is admitted
 * unchanged, so non-enrolled and non-lane offers pay nothing.
 */
export function joinLaneBeforeOffer(input: {
	programmeId?: string | undefined;
	laneOwnerRef?: string | undefined;
	settledLeafOwnerRefs?: readonly string[];
	control?: ProgrammeControlContext;
}): LaneOfferGate {
	const ownerRef = input.laneOwnerRef;
	const programmeId = input.programmeId;
	if (ownerRef === undefined || programmeId === undefined) {
		return { allow: true, held: false, ownerRef: ownerRef ?? "", joinedLeafOwnerRefs: [], released: false };
	}
	let rows: DescendantReservation[];
	try {
		rows = listDescendantReservations(programmeId, input.control);
	} catch (error) {
		if (error instanceof ProgrammeControlStateError && error.code === "missing") {
			return { allow: true, held: false, ownerRef, joinedLeafOwnerRefs: [], released: false };
		}
		return {
			allow: false,
			reason: "recovery_required",
			code: "state_io",
			detail: `descendant join state unavailable: ${messageOf(error)}`,
			outstanding: [],
		};
	}
	const lane = rows.find((row) => row.ownerRef === ownerRef);
	if (lane === undefined) {
		return { allow: true, held: false, ownerRef, joinedLeafOwnerRefs: [], released: false };
	}
	const settled = new Set(input.settledLeafOwnerRefs ?? []);
	const addressed = rows.filter(
		(row) =>
			row.kind === "leaf" &&
			row.files.some((file) => lane.files.some((claimed) => artifactKeysOverlap(claimed, file))),
	);
	const outstanding = addressed
		.filter((row) => !settled.has(row.ownerRef))
		.map((row) => row.ownerRef)
		.sort();
	if (outstanding.length > 0) {
		return {
			allow: false,
			reason: "task_not_active",
			code: "descendants_outstanding",
			detail: `${ownerRef} cannot offer while leaf descendants are outstanding: ${outstanding.join(", ")}`,
			outstanding,
		};
	}
	const joined = addressed.map((row) => row.ownerRef).sort();
	let released = false;
	try {
		released = releaseDescendantWriter(programmeId, ownerRef, input.control).released;
	} catch (error) {
		// The offer itself is already admissible; a failed release is recorded in the
		// note rather than turned into a hold that would block settled work.
		const note = `${joined.length > 0 ? `descendants settled first: ${joined.join(", ")}; ` : ""}reservation release pending: ${messageOf(error)}`;
		return { allow: true, held: false, ownerRef, joinedLeafOwnerRefs: joined, released: false, note };
	}
	const note = joined.length > 0 ? `descendants settled first: ${joined.join(", ")}` : undefined;
	return {
		allow: true,
		held: false,
		ownerRef,
		joinedLeafOwnerRefs: joined,
		released,
		...(note !== undefined ? { note } : {}),
	};
}

/**
 * The task-level admission policy Muster registers on the P2 controller. The
 * controller's regime gates run first; this function never re-implements them,
 * and it is only consulted while a programme binding exists.
 */
export function createMusterAdmissionPolicy(ctx: MusterAdmissionContext): AdmissionPolicy {
	return (request, snapshot) => {
		if (snapshot.mode !== "agile") return { allow: true };
		const operation = classifyAgileOperation(request.toolName);
		if (operation === "read-only") return { allow: true };
		const phase = snapshot.phase ?? "setup";
		if (phase !== "active") {
			// The controller already refuses here; fail closed if called anyway.
			const gate = phaseDenial(phase);
			if (gate !== undefined) return refusalDecision(gate);
		}
		const args = request.args ?? {};
		const programmeId = snapshot.programmeId;
		const state = programmeId === undefined ? undefined : ctx.decomposition(programmeId);
		// Both resolve to the same runtime binding in production (the Muster layer
		// supplies `() => controller.snapshot().role ?? "parent"`), so the explicit
		// provider is read first and the snapshot is the fallback.
		const role = ctx.role() ?? snapshot.role;
		const agentId = ctx.agentId();
		const grant = ctx.grant();
		const backlogSource = ctx.backlogSource?.() ?? snapshot.backlogSource;
		if (backlogSource?.kind === "jira" && ctx.jiraAdapterActive !== true) {
			const gate = resolveBacklogSource(backlogSource, { jiraAdapterActive: ctx.jiraAdapterActive });
			if (!gate.ok) return refusalDecision(deny("unsupported_lane", gate.code, gate.detail, gate.setupCondition));
		}
		const base = {
			state,
			phase,
			role,
			agentId,
			grant,
			backlogSource,
			jiraAdapterActive: ctx.jiraAdapterActive === true,
			taskStates: ctx.taskStates(),
			currentOwners: ctx.currentOwners(),
			capacity: ctx.capacity(),
		} as const;

		// P3 descendant hooks: absent means today's admission exactly. A lane is a
		// non-parent session with a lane identity; the parent owns the programme,
		// not a story subtree, so it never reserves descendant files.
		const descendants = safeDescendantContext(ctx);
		const lane = descendants?.laneOwnerRef?.() ?? undefined;
		const reserveLaneWork = (taskId: string): Extract<DispatchDecision, { allow: false }> | undefined => {
			if (descendants === undefined || lane === undefined || role === "parent") return undefined;
			const task = state?.graph.tasks.find((candidate) => candidate.taskId === taskId);
			if (task === undefined) return undefined;
			const reservation = reserveLaneDescendants({
				programmeId,
				laneOwnerRef: lane,
				files: writeTargets(task),
				control: descendants.control,
			});
			return reservation.allow ? undefined : reservation;
		};
		const offerJoinGate = (): Extract<DispatchDecision, { allow: false }> | undefined => {
			if (descendants === undefined) return undefined;
			let settled: readonly string[] = [];
			try {
				settled = descendants.settledLeafOwnerRefs?.() ?? [];
			} catch {
				// A broken settled-reader proves no leaf joined: hold the offer rather
				// than let it cite work that may still be running.
				settled = [];
			}
			const gate = joinLaneBeforeOffer({
				programmeId,
				laneOwnerRef: lane,
				settledLeafOwnerRefs: settled,
				control: descendants.control,
			});
			return gate.allow ? undefined : gate;
		};
		switch (operation) {
			case "structured-write": {
				const taskId = ctx.currentWriteTaskId();
				if (taskId === undefined) {
					return refusalDecision(
						deny("task_not_active", "no_admitted_task", "no admitted task is selected in this session"),
					);
				}
				const target = ctx.resolveTarget(request.toolName, args);
				if (target === undefined || target.relativePath === undefined) {
					return refusalDecision(
						deny(
							"task_not_active",
							"target_outside_task_scope",
							"this write cannot be routed to an approved repository in the task scope",
						),
					);
				}
				const decision = canDispatchTask({
					...base,
					taskId,
					intent: "write",
					selectedTaskId: taskId,
					...(target.repository !== undefined ? { repository: target.repository } : {}),
					target: {
						relativePath: target.relativePath,
						...(target.repository !== undefined ? { repository: target.repository } : {}),
					},
				});
				return decision.allow ? { allow: true } : refusalDecision(decision);
			}
			case "opaque-execution":
			case "external-provider": {
				const taskId = ctx.currentWriteTaskId();
				if (taskId === undefined) {
					return refusalDecision(
						deny(
							"task_not_active",
							"no_admitted_task",
							"opaque execution requires an admitted task and its execution permissions",
						),
					);
				}
				const classification = classifyOpaqueCommand(opaqueText(args), {
					protectedPaths: ctx.protectedPaths,
					excludedExternalOperations: grant?.excludedExternalOperations ?? [],
				});
				if (classification.excludedOperations.length > 0) {
					return refusalDecision(
						deny(
							"initiative_not_approved",
							"excluded_external_operation",
							`the approved grant excludes: ${classification.excludedOperations.join(", ")}`,
						),
					);
				}
				if (
					classification.protectedPaths.length > 0 &&
					!scopeAllowsProtected(taskId, state, classification.protectedPaths)
				) {
					return refusalDecision(
						deny(
							"task_not_active",
							"protected_path",
							`the command touches harness/policy/control state outside this task's scope: ${classification.protectedPaths.join(", ")}`,
						),
					);
				}
				if (classification.launch !== undefined) {
					const launch = classification.launch;
					if (launch.taskId === undefined) {
						return refusalDecision(
							deny(
								"task_not_active",
								"launch_task_unspecified",
								"a lane launch must carry the admitted task id (CONCORD_TASK=<task>)",
							),
						);
					}
					const decision = canDispatchTask({
						...base,
						taskId: launch.taskId,
						intent: "launch",
						lane: { kind: launch.laneKind },
						...(launch.agentId !== undefined ? { toAgentId: launch.agentId } : {}),
						...(ctx.launchIntent !== undefined
							? { launchIntent: ctx.launchIntent(launch.taskId, launch.agentId) }
							: {}),
					});
					return decision.allow ? { allow: true } : refusalDecision(decision);
				}
				const decision = canDispatchTask({ ...base, taskId, intent: "write", selectedTaskId: taskId });
				return decision.allow ? { allow: true } : refusalDecision(decision);
			}
			case "delegated-dispatch":
				return refusalDecision(
					deny(
						"unsupported_lane",
						"delegate_not_a_bypass",
						"delegate dispatch is not an Agile route; route programme work through governed Pi Muster lanes",
					),
				);
			case "operator-shell":
				return refusalDecision(
					deny(
						"task_not_active",
						"operator_shell_intervention",
						"this executable request carries no attributable operator provenance in Agile; use a separate Normal session or an agreed operator-intervention record",
					),
				);
			case "local-binding": {
				const checkout = typeof args["checkout"] === "string" ? (args["checkout"] as string) : "";
				if (grant !== undefined && checkout !== "" && !repositoryMatchesGrant(checkout, grant.repositories)) {
					return refusalDecision(
						deny("wrong_owner", "repository_outside_grant", `${checkout} is outside the approved grant repositories`),
					);
				}
				return { allow: true };
			}
			case "task-start": {
				const taskId = typeof args["task_id"] === "string" ? (args["task_id"] as string) : "";
				if (taskId === "") {
					return refusalDecision(
						deny("task_not_active", "task_not_in_decomposition", "muster_start requires a task_id allocated from the decomposition"),
					);
				}
				const lifecycle = assertWorkerLifecycleAllowed(role, request.toolName, args);
				if (!lifecycle.allow) return refusalDecision(lifecycle);
				const decision = canDispatchTask({ ...base, taskId, intent: "start" });
				if (!decision.allow) return refusalDecision(decision);
				const reservation = reserveLaneWork(taskId);
				return reservation === undefined ? { allow: true } : refusalDecision(reservation);
			}
			case "task-update": {
				const operation = typeof args["operation"] === "string" ? (args["operation"] as string) : "record";
				if (operation === "record") {
					const taskId = typeof args["task_id"] === "string" ? (args["task_id"] as string) : "";
					if (taskId === "") {
						return refusalDecision(
							deny("task_not_active", "no_admitted_task", "a durable task record requires an admitted task id"),
						);
					}
					const observation = ctx.taskStates()[taskId];
					const decision = canDispatchTask({
						...base,
						taskId,
						intent: "record",
						ownerAgentId: observation?.agentId ?? observation?.assignedAgentId,
					});
					return decision.allow ? { allow: true } : refusalDecision(decision);
				}
				// prompt/reply: peer information only; the sender must still hold an
				// admitted task or be the parent so the message is attributable.
				if (ctx.currentWriteTaskId() === undefined && role !== "parent") {
					return refusalDecision(
						deny("task_not_active", "no_admitted_task", "messaging requires an admitted task in this session"),
					);
				}
				return { allow: true };
			}
			case "task-transfer": {
				const taskId = typeof args["task_id"] === "string" ? (args["task_id"] as string) : "";
				if (taskId === "") {
					return refusalDecision(
						deny("task_not_active", "task_not_in_decomposition", "muster_transfer requires a task_id"),
					);
				}
				const lifecycle = assertWorkerLifecycleAllowed(role, request.toolName, args);
				if (!lifecycle.allow) return refusalDecision(lifecycle);
				const action = typeof args["action"] === "string" ? (args["action"] as string) : "";
				const intent = intentForMusterTool(request.toolName, args);
				if (intent === undefined) {
					if (action === "decline" || action === "release") {
						const observation = ctx.taskStates()[taskId];
						const decision = canDispatchTask({
							...base,
							taskId,
							intent: "handoff",
							action,
							ownerAgentId:
								ctx.currentWriteTaskId() === taskId ? agentId : (observation?.agentId ?? observation?.assignedAgentId),
							...(typeof args["expected_version"] === "number" ? { version: args["expected_version"] as number } : {}),
							...(observation?.version !== undefined ? { observedVersion: observation.version } : {}),
						});
						return decision.allow ? { allow: true } : refusalDecision(decision);
					}
					return refusalDecision(
						deny("task_not_active", "no_admitted_task", `unclassified muster_transfer action: ${action}`),
					);
				}
				const toAgentId = typeof args["to_agent_id"] === "string" ? (args["to_agent_id"] as string) : undefined;
				const observation = ctx.taskStates()[taskId];
				const decision = canDispatchTask({
					...base,
					taskId,
					intent,
					...(intent === "closure" ? { action } : {}),
					...(toAgentId !== undefined ? { toAgentId } : {}),
					evidence: evidenceFromArgs(args),
					ownerAgentId: observation?.agentId ?? observation?.assignedAgentId,
					...(typeof args["expected_version"] === "number" ? { version: args["expected_version"] as number } : {}),
					...(observation?.version !== undefined ? { observedVersion: observation.version } : {}),
					...(ctx.launchIntent !== undefined && toAgentId !== undefined
						? { launchIntent: ctx.launchIntent(taskId, toAgentId) }
						: {}),
				});
				if (!decision.allow) return refusalDecision(decision);
				// A lane accepting its task claims its declared subtree files before the
				// assignment is recorded (plan §7 P3.2), and a lane offering its handoff
				// must have joined every leaf in that subtree first (plan §7 P3.3).
				if (intent === "start") {
					const reservation = reserveLaneWork(taskId);
					if (reservation !== undefined) return refusalDecision(reservation);
				}
				if (action === "offer") {
					const offer = offerJoinGate();
					if (offer !== undefined) return refusalDecision(offer);
				}
				return { allow: true };
			}
			case "task-closure": {
				const taskId = typeof args["task_id"] === "string" ? (args["task_id"] as string) : "";
				if (taskId === "") {
					return refusalDecision(deny("task_not_active", "task_not_in_decomposition", "muster_finish requires a task_id"));
				}
				const lifecycle = assertWorkerLifecycleAllowed(role, request.toolName, args);
				if (!lifecycle.allow) return refusalDecision(lifecycle);
				const observation = ctx.taskStates()[taskId];
				const outcome = typeof args["outcome"] === "string" ? (args["outcome"] as string) : "complete";
				const decision = canDispatchTask({
					...base,
					taskId,
					intent: "closure",
					action: outcome,
					evidence: evidenceFromArgs(args),
					ownerAgentId: observation?.agentId ?? observation?.assignedAgentId,
					...(typeof args["expected_version"] === "number" ? { version: args["expected_version"] as number } : {}),
					...(observation?.version !== undefined ? { observedVersion: observation.version } : {}),
				});
				if (!decision.allow) return refusalDecision(decision);
				// `outcome=handoff` is the lane's offer: it may cite only settled work.
				if (outcome === "handoff") {
					const offer = offerJoinGate();
					if (offer !== undefined) return refusalDecision(offer);
				}
				return { allow: true };
			}
			default:
				return refusalDecision(
					deny(
						"unsupported_lane",
						"operation_not_classified",
						`no Agile operation contract is classified for tool "${request.toolName}"`,
					),
				);
		}
	};
}

// ─── Muster worker-state provider ────────────────────────────────────────────

export const WORKER_STATE_FRESH_MS = 60_000;

/** An unverified launch intent expires instead of being retried blindly. */
export const LAUNCH_INTENT_TTL_MS = 120_000;

/** Stable launch-intent key: programme + task + target agent (or "-"). */
export function launchIntentKey(programmeId: string, taskId: string, agentId?: string): string {
	return `${programmeId}::${taskId}::${agentId ?? "-"}`;
}

/** Admission view of a persisted launch intent (recorded/verified/expired). */
export function launchIntentState(
	intent: LaunchIntent | undefined,
	nowMs: number,
	ttlMs = LAUNCH_INTENT_TTL_MS,
): LaunchIntentState {
	if (intent === undefined) return { recorded: false, verified: false, expired: false };
	const verified = intent.verifiedAt !== undefined;
	const recordedMs = Date.parse(intent.recordedAt);
	const expired = !verified && Number.isFinite(recordedMs) && nowMs - recordedMs > ttlMs;
	return { recorded: true, verified, expired };
}

/**
 * Sync read of a session's launch intents from its append-only Muster journal.
 * A worker lane verifies the parent-written intent across processes, and
 * adoption runs inside session startup, so this reader cannot await the
 * journal's async fold. Only `launch-intent` records are read; unparseable or
 * torn lines are skipped, exactly like `MusterJournal.fold`.
 */
export function readSessionLaunchIntents(
	sessionId: string,
	sessionsDir: string = musterSessionsDir(),
): Map<string, LaunchIntent> {
	const intents = new Map<string, LaunchIntent>();
	if (!SESSION_ID_PATTERN.test(sessionId) || sessionId.includes("..")) return intents;
	let text: string;
	try {
		text = readFileSync(join(sessionsDir, `${sessionId}.jsonl`), "utf8");
	} catch {
		return intents;
	}
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isPlainObject(record) || record["type"] !== "launch-intent") continue;
		const intent = record["intent"];
		if (
			isPlainObject(intent) &&
			typeof intent["intentKey"] === "string" &&
			typeof intent["programmeId"] === "string" &&
			typeof intent["taskId"] === "string" &&
			typeof intent["recordedAt"] === "string"
		) {
			intents.set(intent["intentKey"], intent as unknown as LaunchIntent);
		}
	}
	return intents;
}

/**
 * The Muster-owned durable-facts port the operating controller's worker
 * issuance/adoption verifies against (plan §4.1, §5.4, §6.1). `readTask`
 * re-derives the task through the same `canDispatchTask` admission the task
 * path uses — accepted revision, review evidence, ownership, dependency edges
 * and uncertainty — so a seed can never name a task outside the accepted
 * revision or one that is not dispatchable for this lane. Capacity is not
 * re-checked here: it is a launch-time decision and the lane already exists.
 */
export type WorkerSeedPortDeps = {
	/** Phase from the controller's durable programme record. */
	phase: () => ProgrammePhase;
	/** Read the decomposition state for a programme; undefined when absent. */
	decomposition: (programmeId: string) => DecompositionState | undefined;
	/** Lifecycle observations from the task owner (Concord). */
	taskStates: () => Record<string, TaskLifecycleObservation>;
	/** Current owners of live tasks, keyed by task id. */
	currentOwners?: () => Record<string, string>;
	/** Persisted launch intents keyed by `launchIntentKey`. */
	launchIntents: () => Map<string, LaunchIntent>;
	/**
	 * The launching parent's persisted launch intents, read from that session's
	 * journal (`readSessionLaunchIntents`). A worker lane's own journal never
	 * holds the parent-written intent, so adoption consults this reader.
	 */
	parentLaunchIntents?: (parentSessionId: string) => Map<string, LaunchIntent> | undefined;
	/** Persist one launch intent through the Muster owner (in memory + journal). */
	persistLaunchIntent: (intent: LaunchIntent) => void;
	/** This process's own Concord lane identity. */
	laneAgentId: () => string | undefined;
	backlogSource?: () => BacklogSource | undefined;
	now?: () => number;
	/** Launch-intent TTL; defaults to `LAUNCH_INTENT_TTL_MS`. */
	ttlMs?: number;
};

function launchIntentFacts(
	intent: LaunchIntent,
	intents: Map<string, LaunchIntent>,
	nowMs: number,
	ttlMs: number,
): WorkerLaunchIntentFacts {
	const state = launchIntentState(intent, nowMs, ttlMs);
	// A newer intent for the same programme/task naming a different lane
	// supersedes this one; an agent-less preflight record does not.
	const superseded = [...intents.values()].some(
		(other) =>
			other.programmeId === intent.programmeId &&
			other.taskId === intent.taskId &&
			other.agentId !== undefined &&
			other.agentId !== intent.agentId &&
			Date.parse(other.recordedAt) > Date.parse(intent.recordedAt),
	);
	return { ...state, superseded };
}

/** Build the port over Muster's decomposition store, observations and launch intents. */
export function createWorkerSeedPort(deps: WorkerSeedPortDeps): WorkerSeedPort {
	const nowMs = (): number => deps.now?.() ?? Date.now();
	const ttlMs = deps.ttlMs ?? LAUNCH_INTENT_TTL_MS;
	return {
		readTask(query: WorkerSeedQuery) {
			const state = deps.decomposition(query.programmeId);
			const decision = canDispatchTask({
				state,
				taskId: query.taskId,
				intent: "start",
				phase: deps.phase(),
				role: "worker",
				agentId: query.agentId,
				grant: query.grant,
				backlogSource: deps.backlogSource?.(),
				taskStates: deps.taskStates(),
				currentOwners: deps.currentOwners?.(),
				lane: { kind: "pi" },
			});
			if (!decision.allow) {
				return { ok: false, reason: decision.reason, detail: `${decision.code}: ${decision.detail}` };
			}
			const accepted = state?.accepted;
			const task = (accepted?.tasks ?? state?.graph.tasks ?? []).find(
				(candidate) => candidate.taskId === query.taskId,
			);
			if (task === undefined || state === undefined) {
				// dispatch admission allowed it, so this is unreachable state drift;
				// fail closed rather than fabricate task facts.
				return { ok: false, reason: "task_not_active", detail: "task_not_in_decomposition" };
			}
			return {
				ok: true,
				task: {
					acceptedRevision: accepted?.revision ?? state.graph.revision,
					incrementId: accepted?.incrementId ?? state.graph.incrementId,
					contractHash: task.contractHash,
					assignedAgentId: task.ownership.assignedAgentId ?? query.agentId,
					intendedRole: task.ownership.intendedRole,
					repository: task.scope.repository,
					writeTargets: writeTargets(task),
					readOnly: task.scope.readOnly === true,
				},
			};
		},
		readLaunchIntent(query: { programmeId: string; taskId: string; agentId: string; parentSessionId?: string }): WorkerLaunchIntentFacts {
			const intents = new Map(deps.launchIntents());
			// The lane's own journal never holds the parent-written intent; read the
			// parent session's journal through the owner's synchronous reader.
			const parent =
				query.parentSessionId !== undefined ? deps.parentLaunchIntents?.(query.parentSessionId) : undefined;
			for (const [key, parentIntent] of parent ?? []) intents.set(key, parentIntent);
			const intent = intents.get(launchIntentKey(query.programmeId, query.taskId, query.agentId));
			if (intent === undefined) return { recorded: false, verified: false, expired: false, superseded: false };
			return launchIntentFacts(intent, intents, nowMs(), ttlMs);
		},
		recordLaunchIntent(query: { programmeId: string; taskId: string; agentId: string }): WorkerLaunchIntentFacts {
			const intents = deps.launchIntents();
			const intentKey = launchIntentKey(query.programmeId, query.taskId, query.agentId);
			const existing = intents.get(intentKey);
			const recordedAt = new Date(nowMs()).toISOString();
			const intent: LaunchIntent = {
				intentKey,
				programmeId: query.programmeId,
				taskId: query.taskId,
				agentId: query.agentId,
				laneKind: "pi",
				// Not the spawn command: the launcher's own preflight replaces this
				// record with the command hash before anything executes.
				commandHash: hashText(`agile-worker-seed:${query.programmeId}:${query.taskId}:${query.agentId}:${recordedAt}`),
				recordedAt,
				...(existing?.verifiedAt !== undefined ? { verifiedAt: existing.verifiedAt } : {}),
			};
			deps.persistLaunchIntent(intent);
			return launchIntentFacts(intent, deps.launchIntents(), nowMs(), ttlMs);
		},
		laneAgentId: () => deps.laneAgentId(),
	};
}

/**
 * Muster's honest worker view: its own supervised tasks and the freshness of
 * lifecycle observations. Herdr owns processes; this provider never claims a
 * process census, and it reports "not established" rather than guessing when
 * an observation is missing or stale.
 */
export function deriveMusterWorkerState(input: {
	supervisedTaskIds: string[];
	observations: Record<string, { status: string; observedAtMs?: number }>;
	nowMs: number;
	freshMs?: number;
	coordinationAvailable: boolean;
}): WorkerState {
	const freshMs = input.freshMs ?? WORKER_STATE_FRESH_MS;
	let liveWorkers = 0;
	let settled = true;
	for (const taskId of input.supervisedTaskIds) {
		const observed = input.observations[taskId];
		if (!input.coordinationAvailable || observed === undefined || observed.observedAtMs === undefined) {
			liveWorkers += 1;
			settled = false;
			continue;
		}
		if (input.nowMs - observed.observedAtMs > freshMs) {
			liveWorkers += 1;
			settled = false;
			continue;
		}
		if (!DEPENDENCY_SATISFIED_STATUSES.has(observed.status)) {
			liveWorkers += 1;
			settled = false;
		}
	}
	return { liveWorkers, settled, source: "muster" };
}

// ─── Durable decomposition store ─────────────────────────────────────────────

export class DecompositionStateError extends Error {
	constructor(
		readonly code: "missing" | "malformed" | "conflict" | "io",
		message: string,
	) {
		super(message);
		this.name = "DecompositionStateError";
	}
}

/** Internal refusal carrying a precise Agile code (CAS/acceptance outcomes). */
class StoreRefusal extends Error {
	constructor(
		readonly agileCode: AgileDenialCode,
		message: string,
	) {
		super(message);
		this.name = "StoreRefusal";
	}
}

/** Existing Muster state root; `PI_AGILE_DECOMPOSITIONS_DIR` is the test seam. */
export function decompositionsStateDir(): string {
	const override = process.env.PI_AGILE_DECOMPOSITIONS_DIR?.trim();
	if (override) return resolve(override);
	return join(piAgentDir(), "state", "muster", "decompositions");
}

export type DecompositionStore = {
	dir: string;
	read(programmeId: string): DecompositionState | undefined;
	update(
		programmeId: string,
		expectedRevision: number | undefined,
		mutate: (current: DecompositionState | undefined) => DecompositionState,
	): DecompositionState;
};

export function fileDecompositionStore(dir = decompositionsStateDir()): DecompositionStore {
	return fileCasStore<DecompositionState>({
		dir,
		idPattern: PROGRAMME_ID_PATTERN,
		idKind: "programme",
		noun: "decomposition",
		recordNoun: "state",
		validate: (raw) => {
			const validated = validateDecompositionState(raw);
			return validated.ok ? { ok: true, record: validated.state } : { ok: false, errors: validated.errors };
		},
		errorClass: DecompositionStateError,
		passThrough: (error) => error instanceof StoreRefusal,
	});
}

const STATE_KEYS = new Set(["schemaVersion", "programmeId", "revision", "status", "graph", "accepted", "reviews", "updatedAt"]);
const GRAPH_KEYS = new Set(["revision", "incrementId", "goal", "successConditions", "tasks"]);
const ACCEPTED_KEYS = new Set([
	"revision",
	"incrementId",
	"goal",
	"successConditions",
	"tasks",
	"reviewId",
	"reviewKind",
	"reviewedHashes",
	"acceptedAt",
]);

function validateGraph(input: unknown, path: string, errors: string[], keys: Set<string> = GRAPH_KEYS): void {
	if (!isPlainObject(input)) {
		errors.push(`${path} must be an object`);
		return;
	}
	const local: string[] = [];
	const extra = unknownKeys(input, keys);
	if (extra.length > 0) local.push(`has unknown fields: ${extra.join(", ")}`);
	if (!Number.isInteger(input.revision) || (input.revision as number) < 1) {
		local.push("revision must be a positive integer");
	}
	if (!nonEmptyString(input.incrementId)) local.push("incrementId must be a non-empty string");
	if (!nonEmptyString(input.goal)) local.push("goal must be a non-empty string");
	const conditions = validateConditions(input.successConditions, local);
	const tasks = validateTasks(input.tasks, local);
	validateGraphSemantics(tasks, conditions, local);
	for (const message of local) errors.push(`${path}: ${message}`);
}

/** Validate the durable decomposition state; a tampered record fails closed. */
export function validateDecompositionState(
	input: unknown,
): { ok: true; state: DecompositionState } | { ok: false; errors: string[] } {
	const errors: string[] = [];
	if (!isPlainObject(input)) return { ok: false, errors: ["state must be an object"] };
	const extra = unknownKeys(input, STATE_KEYS);
	if (extra.length > 0) errors.push(`state has unknown fields: ${extra.join(", ")}`);
	if (input.schemaVersion !== DECOMPOSITION_SCHEMA_VERSION) errors.push("state.schemaVersion must be 1");
	if (typeof input.programmeId !== "string" || !PROGRAMME_ID_PATTERN.test(input.programmeId)) {
		errors.push("state.programmeId must match agp_<12 hex>");
	}
	if (!Number.isInteger(input.revision) || (input.revision as number) < 1) {
		errors.push("state.revision must be a positive integer");
	}
	if (input.status !== "proposed" && input.status !== "accepted") errors.push("state.status must be proposed or accepted");
	if (!nonEmptyString(input.updatedAt)) errors.push("state.updatedAt must be a non-empty string");
	validateGraph(input.graph, "state.graph", errors);
	if (isPlainObject(input.graph) && input.graph.revision !== input.revision) {
		errors.push("state.revision must equal state.graph.revision");
	}
	if (input.accepted !== undefined) {
		if (!isPlainObject(input.accepted)) errors.push("state.accepted must be an object");
		else {
			const acceptedExtra = unknownKeys(input.accepted, ACCEPTED_KEYS);
			if (acceptedExtra.length > 0) errors.push(`state.accepted has unknown fields: ${acceptedExtra.join(", ")}`);
			// The accepted revision carries the graph plus its acceptance metadata, so
			// validate its graph shape against the accepted allowlist rather than the
			// bare graph allowlist, which would reject reviewId/reviewKind/acceptedAt.
			validateGraph(input.accepted, "state.accepted", errors, ACCEPTED_KEYS);
			if (!nonEmptyString(input.accepted.reviewId)) errors.push("state.accepted.reviewId must be a non-empty string");
			if (input.accepted.reviewKind !== "independent-planning" && input.accepted.reviewKind !== "parent-refinement") {
				errors.push("state.accepted.reviewKind is invalid");
			}
			if (!isPlainObject(input.accepted.reviewedHashes)) {
				errors.push("state.accepted.reviewedHashes must be an object");
			} else {
				for (const [taskId, hash] of Object.entries(input.accepted.reviewedHashes)) {
					if (!ID_PATTERN.test(taskId) || typeof hash !== "string" || !HASH_PATTERN.test(hash)) {
						errors.push(`state.accepted.reviewedHashes has a malformed entry for ${taskId}`);
					}
				}
				if (Array.isArray(input.accepted.tasks)) {
					for (const task of input.accepted.tasks as TaskContractInput[]) {
						const hash = (input.accepted.reviewedHashes as Record<string, string>)[String(task?.taskId)];
						if (hash !== undefined && hash !== taskContractHash(task)) {
							errors.push(`state.accepted review hash mismatch for ${String(task?.taskId)}`);
						}
					}
				}
			}
			if (!nonEmptyString(input.accepted.acceptedAt)) errors.push("state.accepted.acceptedAt must be a non-empty string");
		}
	}
	if (input.status === "accepted" && input.accepted === undefined) {
		errors.push("state.status accepted requires an accepted graph");
	}
	if (!Array.isArray(input.reviews)) errors.push("state.reviews must be an array");
	else {
		input.reviews.forEach((review, index) => {
			const validated = validatePlanningReview(review);
			if (!validated.ok) errors.push(`state.reviews[${index}]: ${validated.errors.join("; ")}`);
		});
	}
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, state: cloneJson(input) as unknown as DecompositionState };
}

// ─── Store operations (serialized compare-and-set) ───────────────────────────

function storeFailure(error: unknown): DecompositionResult {
	if (error instanceof StoreRefusal) {
		return { ok: false, code: error.agileCode, detail: error.message };
	}
	if (error instanceof DecompositionStateError) {
		const code: AgileDenialCode =
			error.code === "conflict" ? "revision_conflict" : error.code === "malformed" ? "state_malformed" : "state_io";
		return { ok: false, code, detail: error.message };
	}
	return { ok: false, code: "state_io", detail: messageOf(error) };
}

export type ProposeRevisionInput = {
	programmeId: string;
	proposal: unknown;
	now?: string;
};

/** Validate a model-produced proposal structurally, then persist the next revision. */
export function proposeDecompositionRevision(store: DecompositionStore, input: ProposeRevisionInput): DecompositionResult {
	const validated = validateDecomposition(input.proposal);
	if (!validated.ok) {
		return { ok: false, code: "schema_invalid", detail: validated.errors.join("; ") };
	}
	const proposal = validated.proposal;
	if (proposal.programmeId !== input.programmeId) {
		return { ok: false, code: "schema_invalid", detail: "proposal.programmeId does not match the target programme" };
	}
	const now = input.now ?? new Date().toISOString();
	try {
		const current = store.read(input.programmeId);
		const expectedRevision = current?.revision;
		const nextRevision = (current?.revision ?? 0) + 1;
		if (proposal.revision !== undefined && proposal.revision !== nextRevision) {
			return {
				ok: false,
				code: "revision_mismatch",
				detail: `proposal revision ${proposal.revision} does not match the next code-allocated revision ${nextRevision}`,
			};
		}
		const state = store.update(input.programmeId, expectedRevision, () => ({
			schemaVersion: DECOMPOSITION_SCHEMA_VERSION,
			programmeId: input.programmeId,
			revision: nextRevision,
			status: "proposed",
			graph: {
				revision: nextRevision,
				incrementId: proposal.incrementId,
				goal: proposal.goal,
				successConditions: proposal.successConditions,
				tasks: proposal.tasks,
			},
			...(current?.accepted !== undefined ? { accepted: current.accepted } : {}),
			reviews: current?.reviews ?? [],
			updatedAt: now,
		}));
		return { ok: true, state };
	} catch (error) {
		return storeFailure(error);
	}
}

export type AcceptRevisionInput = {
	programmeId: string;
	expectedRevision: number;
	/**
	 * Role of the lane requesting acceptance. A worker lane never accepts a
	 * decomposition revision (plan §4.1/§5.4); absent means the parent path.
	 */
	role?: OperatingRole;
	review: {
		kind: PlanningReviewKind;
		reviewerAgentId: string;
		laneReference?: string;
		readOnly: boolean;
		disposition: "accepted" | "changes-required";
		findings?: string[];
	};
	reviewId?: string;
	now?: string;
};

/**
 * Accept the current proposed revision under an operator-approved grant. The
 * review hash set is computed by code from the exact graph, so a model-supplied
 * `reviewed: true` (or a fabricated hash map) cannot authorize dispatch.
 */
export function acceptDecompositionRevision(store: DecompositionStore, input: AcceptRevisionInput): DecompositionResult {
	if (input.role === "worker") {
		// Role is an additional gate, not the operator/approval path: a worker
		// lane may propose nothing that becomes dispatch authority for itself.
		return {
			ok: false,
			code: "parent_role_required",
			detail: "a worker lane cannot accept a decomposition revision; the parent reviews and accepts it",
		};
	}
	const now = input.now ?? new Date().toISOString();
	try {
		const state = store.update(input.programmeId, input.expectedRevision, (current) => {
			if (current === undefined) {
				throw new StoreRefusal("decomposition_not_proposed", "no decomposition state to accept");
			}
			if (current.status === "accepted" && current.accepted?.revision === current.graph.revision) {
				throw new StoreRefusal("already_accepted", "this decomposition revision is already accepted");
			}
			const impact = assessRevisionImpact(current.accepted, current.graph);
			const requiresIndependent = current.accepted === undefined || impact.requiresIndependentReview;
			if (
				input.review.kind === "independent-planning" &&
				(input.review.readOnly !== true || !nonEmptyString(input.review.laneReference))
			) {
				throw new StoreRefusal(
					"independent_review_required",
					"an independent planning review requires a read-only governed lane reference",
				);
			}
			if (input.review.disposition !== "accepted") {
				const record: PlanningReviewRecord = {
					reviewId: input.reviewId ?? `rev_${hashText(`${current.programmeId}:${current.graph.revision}:${now}`).slice(0, 12)}`,
					revision: current.graph.revision,
					kind: input.review.kind,
					reviewerAgentId: input.review.reviewerAgentId,
					reviewerRole: "reviewer",
					...(input.review.laneReference !== undefined ? { laneReference: input.review.laneReference } : {}),
					readOnly: input.review.readOnly,
					disposition: "changes-required",
					findings: [...(input.review.findings ?? [])],
					reviewedHashes: hashGraph(current.graph),
					at: now,
				};
				const validated = validatePlanningReview(record);
				if (!validated.ok) throw new StoreRefusal("review_hash_mismatch", validated.errors.join("; "));
				return { ...current, reviews: [...current.reviews, record], updatedAt: now };
			}
			if (requiresIndependent && input.review.kind !== "independent-planning") {
				throw new StoreRefusal(
					"independent_review_required",
					"this revision changed acceptance/dependency/ownership context or is the initial breakdown",
				);
			}
			const reviewId =
				input.reviewId ??
				`rev_${hashText(`${current.programmeId}:${current.graph.revision}:${input.review.reviewerAgentId}:${now}`).slice(0, 12)}`;
			const reviewedHashes = hashGraph(current.graph);
			const record: PlanningReviewRecord = {
				reviewId,
				revision: current.graph.revision,
				kind: input.review.kind,
				reviewerAgentId: input.review.reviewerAgentId,
				reviewerRole: "reviewer",
				...(input.review.laneReference !== undefined ? { laneReference: input.review.laneReference } : {}),
				readOnly: input.review.readOnly,
				disposition: "accepted",
				findings: [...(input.review.findings ?? [])],
				reviewedHashes,
				at: now,
			};
			const validated = validatePlanningReview(record);
			if (!validated.ok) throw new StoreRefusal("review_hash_mismatch", validated.errors.join("; "));
			return {
				...current,
				status: "accepted",
				accepted: {
					revision: current.graph.revision,
					incrementId: current.graph.incrementId,
					goal: current.graph.goal,
					successConditions: current.graph.successConditions,
					tasks: current.graph.tasks,
					reviewId,
					reviewKind: input.review.kind,
					reviewedHashes,
					acceptedAt: now,
				},
				reviews: [...current.reviews, record],
				updatedAt: now,
			};
		});
		return { ok: true, state };
	} catch (error) {
		const failure = storeFailure(error);
		if (failure.code === "revision_conflict") {
			return {
				ok: false,
				code: "revision_conflict",
				detail: "the decomposition revision changed during acceptance (serialized compare-and-set)",
			};
		}
		return failure;
	}
}

/** Reviewed hashes for the exact contracts in a graph (code-computed). */
export function hashGraph(graph: DecompositionGraph): Record<string, string> {
	const hashes: Record<string, string> = {};
	for (const task of graph.tasks) hashes[task.taskId] = taskContractHash(task);
	return hashes;
}

// ─── Programme association helpers ───────────────────────────────────────────

/** Grant repositories contain the joined checkout (path or name). */
export function grantCoversRepository(grant: GrantTerms | undefined, repository: string): boolean {
	if (grant === undefined) return false;
	return repositoryMatchesGrant(repository, grant.repositories);
}

/**
 * Reject a proposal whose increment is not an approved/active increment of the
 * programme record — the decomposition must stay inside the approved scope.
 */
export function incrementIsApproved(
	record: { increments: Array<{ incrementId: string; status: string }> } | undefined,
	incrementId: string,
): boolean {
	if (record === undefined) return false;
	return record.increments.some(
		(increment) =>
			increment.incrementId === incrementId && (increment.status === "approved" || increment.status === "active"),
	);
}
