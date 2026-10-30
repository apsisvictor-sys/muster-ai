/**
 * `core/programme.ts` — the programme data layer (RS1, S1): the durable Agile
 * programme record, its schema validation, the file store and the vocabulary
 * its callers share.
 *
 * Moved out of `lib/operating-mode.ts`, which keeps the controller and now
 * imports these symbols from here. The store owns nothing Pi-specific: the
 * programme state root comes from the `agentDir` port (S10), and the
 * settings lock/atomic-rename helper is `lib/atomic-settings.ts`, already a
 * core file. No module-level read touches a port; `programmesStateDir()` is
 * read when it is called.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { readJsonSettingsFile, updateJsonSettingsFile } from "./atomic-settings.ts";
import { piAgentDir } from "./pi-ports.ts";

// ─── Frozen read contract ────────────────────────────────────────────────────
export type OperatingMode = "normal" | "agile";

export type ProgrammePhase =
	| "setup"
	| "active"
	| "pausing"
	| "paused"
	| "recovery-required"
	| "finished";

export type OperatingRole = "parent" | "worker";

export type OperatingSnapshot = {
	mode: OperatingMode;
	phase?: ProgrammePhase;
	role?: OperatingRole;
	programmeId?: string;
	/** The one task a worker binding admits; absent for the parent role. */
	taskId?: string;
	revision: number;
	stableAgentId?: string;
	policyHash?: string;
	policyVersion?: string;
	instructionBundleHash?: string;
	grantRevision?: number;
	initiativeTitle?: string;
	backlogSource?: { kind: "approved-plan" | "jira"; reference: string };
	reason?: string;
};

export const NORMAL_SNAPSHOT: OperatingSnapshot = { mode: "normal", revision: 0 };

// ─── Structured refusals ─────────────────────────────────────────────────────
export type RefusalReason =
	| "initiative_not_approved"
	| "task_not_active"
	| "wrong_owner"
	| "policy_changed"
	| "programme_paused"
	| "unsupported_lane"
	| "recovery_required";


export class RefusalSignal extends Error {
	readonly reason: RefusalReason;
	readonly detail: string;
	constructor(reason: RefusalReason, detail: string) {
		super(`${reason}: ${detail}`);
		this.reason = reason;
		this.detail = detail;
		this.name = "RefusalSignal";
	}
}

// ─── Durable record schema ───────────────────────────────────────────────────
export const PROGRAMME_SCHEMA_VERSION = 1 as const;

export type BacklogSource = { kind: "approved-plan" | "jira"; reference: string };

export type RepositoryRef = { name: string; path: string };

export type PolicyIdentity = { path: string; hash: string; version: string };

export type GrantTerms = {
	outcome: string;
	repositories: RepositoryRef[];
	nonGoals: string[];
	backlogSource: BacklogSource;
	authorizedWork: string[];
	excludedExternalOperations: string[];
	acceptanceThreshold: string;
	initialIncrement: { title: string; sprintGoal: string };
	parentReviewer: { parent: string; reviewer: string; capacity?: number };
};

export type GrantProposal = GrantTerms & {
	proposalRevision: number;
	proposedBy: "operator" | "parent-agent";
	proposedAt: string;
	amendedFields: string[];
};

export type ApprovedGrant = GrantTerms & {
	grantRevision: number;
	approvedAt: string;
	approvedBy: "operator";
	termsHash: string;
};

export type IncrementRecord = {
	incrementId: string;
	title: string;
	sprintGoal: string;
	status: "proposed" | "approved" | "active" | "completed" | "withdrawn";
	grantRevision: number;
	proposalRevision: number;
	createdAt: string;
};

export type OperatorDecision = {
	at: string;
	action: string;
	detail?: string;
	fromPhase?: ProgrammePhase;
	toPhase?: ProgrammePhase;
	grantRevision?: number;
};

export type ProgrammeRecord = {
	schemaVersion: 1;
	programmeId: string;
	revision: number;
	controllerEpoch: number;
	phase: ProgrammePhase;
	/** Human title derived from the approved/proposed outcome — never an id. */
	title: string;
	createdAt: string;
	updatedAt: string;
	backlogSource: BacklogSource;
	stableAgentId: string;
	sessionId: string;
	policy?: PolicyIdentity;
	instructionBundleHash?: string;
	proposal?: GrantProposal;
	grant?: ApprovedGrant;
	increments: IncrementRecord[];
	operatorDecisions: OperatorDecision[];
	recoveryReason?: string;
	resumePhase?: ProgrammePhase;
};

export const PROGRAMME_PHASES: readonly ProgrammePhase[] = [
	"setup",
	"active",
	"pausing",
	"paused",
	"recovery-required",
	"finished",
];

// ─── Record validation ───────────────────────────────────────────────────────
const RECORD_KEYS = new Set([
	"schemaVersion",
	"programmeId",
	"revision",
	"controllerEpoch",
	"phase",
	"title",
	"createdAt",
	"updatedAt",
	"backlogSource",
	"stableAgentId",
	"sessionId",
	"policy",
	"instructionBundleHash",
	"proposal",
	"grant",
	"increments",
	"operatorDecisions",
	"recoveryReason",
	"resumePhase",
]);

const TERMS_KEYS = [
	"outcome",
	"repositories",
	"nonGoals",
	"backlogSource",
	"authorizedWork",
	"excludedExternalOperations",
	"acceptanceThreshold",
	"initialIncrement",
	"parentReviewer",
] as const;

const PROPOSAL_KEYS = new Set([...TERMS_KEYS, "proposalRevision", "proposedBy", "proposedAt", "amendedFields"]);
const GRANT_KEYS = new Set([...TERMS_KEYS, "grantRevision", "approvedAt", "approvedBy", "termsHash"]);
const POLICY_KEYS = new Set(["path", "hash", "version"]);
const INCREMENT_KEYS = new Set([
	"incrementId",
	"title",
	"sprintGoal",
	"status",
	"grantRevision",
	"proposalRevision",
	"createdAt",
]);
const DECISION_KEYS = new Set(["at", "action", "detail", "fromPhase", "toPhase", "grantRevision"]);
export const PROGRAMME_ID_PATTERN = /^agp_[0-9a-f]{12}$/;
const INCREMENT_ID_PATTERN = /^inc_[0-9a-f]{12}$/;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

export function stringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(nonEmptyString);
}

export function unknownKeys(value: Record<string, unknown>, known: Set<string>): string[] {
	return Object.keys(value).filter((key) => !known.has(key));
}

export function validateBacklogSource(value: unknown, path: string, errors: string[]): BacklogSource | undefined {
	if (!isPlainObject(value)) {
		errors.push(`${path} must be an object`);
		return undefined;
	}
	if (value.kind !== "approved-plan" && value.kind !== "jira") errors.push(`${path}.kind must be approved-plan or jira`);
	if (!nonEmptyString(value.reference)) errors.push(`${path}.reference must be a non-empty string`);
	return value.kind === "approved-plan" || value.kind === "jira"
		? { kind: value.kind, reference: String(value.reference ?? "") }
		: undefined;
}

function validateTerms(
	value: Record<string, unknown>,
	path: string,
	errors: string[],
	knownExtra: Set<string> = new Set(),
): GrantTerms | undefined {
	const local: string[] = [];
	const extra = unknownKeys(value, new Set([...TERMS_KEYS, ...knownExtra]));
	if (extra.length > 0) local.push(`${path} has unknown fields: ${extra.join(", ")}`);
	if (!nonEmptyString(value.outcome)) local.push(`${path}.outcome must be a non-empty string`);
	if (!Array.isArray(value.repositories) || value.repositories.length === 0) {
		local.push(`${path}.repositories must be a non-empty array`);
	} else {
		value.repositories.forEach((repo, index) => {
			if (!isPlainObject(repo) || !nonEmptyString(repo.name) || !nonEmptyString(repo.path)) {
				local.push(`${path}.repositories[${index}] must be { name, path }`);
			} else if (unknownKeys(repo, new Set(["name", "path"])).length > 0) {
				local.push(`${path}.repositories[${index}] has unknown fields`);
			}
		});
	}
	if (!stringList(value.nonGoals)) local.push(`${path}.nonGoals must be a string array`);
	if (!stringList(value.authorizedWork)) local.push(`${path}.authorizedWork must be a string array`);
	if (!stringList(value.excludedExternalOperations)) {
		local.push(`${path}.excludedExternalOperations must be a string array`);
	}
	if (!nonEmptyString(value.acceptanceThreshold)) local.push(`${path}.acceptanceThreshold must be a non-empty string`);
	if (!isPlainObject(value.initialIncrement) || !nonEmptyString(value.initialIncrement.title) || !nonEmptyString(value.initialIncrement.sprintGoal)) {
		local.push(`${path}.initialIncrement must be { title, sprintGoal }`);
	} else if (unknownKeys(value.initialIncrement, new Set(["title", "sprintGoal"])).length > 0) {
		local.push(`${path}.initialIncrement has unknown fields`);
	}
	const reviewer = value.parentReviewer;
	if (!isPlainObject(reviewer) || !nonEmptyString(reviewer.parent) || !nonEmptyString(reviewer.reviewer)) {
		local.push(`${path}.parentReviewer must be { parent, reviewer }`);
	} else {
		if (unknownKeys(reviewer, new Set(["parent", "reviewer", "capacity"])).length > 0) {
			local.push(`${path}.parentReviewer has unknown fields`);
		}
		if (reviewer.capacity !== undefined && (!Number.isInteger(reviewer.capacity) || (reviewer.capacity as number) < 1)) {
			local.push(`${path}.parentReviewer.capacity must be a positive integer`);
		}
	}
	const backlogSource = validateBacklogSource(value.backlogSource, `${path}.backlogSource`, local);
	errors.push(...local);
	if (local.length > 0 || !backlogSource || !isPlainObject(value.parentReviewer) || !isPlainObject(value.initialIncrement)) {
		return undefined;
	}
	return {
		outcome: value.outcome as string,
		repositories: (value.repositories as RepositoryRef[]).map((repo) => ({ name: repo.name, path: repo.path })),
		nonGoals: [...(value.nonGoals as string[])],
		backlogSource,
		authorizedWork: [...(value.authorizedWork as string[])],
		excludedExternalOperations: [...(value.excludedExternalOperations as string[])],
		acceptanceThreshold: value.acceptanceThreshold as string,
		initialIncrement: {
			title: (value.initialIncrement as { title: string }).title,
			sprintGoal: (value.initialIncrement as { sprintGoal: string }).sprintGoal,
		},
		parentReviewer: {
			parent: (value.parentReviewer as { parent: string }).parent,
			reviewer: (value.parentReviewer as { reviewer: string }).reviewer,
			capacity: (value.parentReviewer as { capacity?: number }).capacity,
		},
	};
}

export function validateProgrammeRecord(
	input: unknown,
): { ok: true; record: ProgrammeRecord } | { ok: false; errors: string[] } {
	const errors: string[] = [];
	if (!isPlainObject(input)) return { ok: false, errors: ["record must be an object"] };
	const extra = unknownKeys(input, RECORD_KEYS);
	if (extra.length > 0) errors.push(`record has unknown fields: ${extra.join(", ")}`);
	if (input.schemaVersion !== PROGRAMME_SCHEMA_VERSION) errors.push("schemaVersion must be 1");
	if (typeof input.programmeId !== "string" || !PROGRAMME_ID_PATTERN.test(input.programmeId)) {
		errors.push("programmeId must match agp_<12 hex>");
	}
	if (!Number.isInteger(input.revision) || (input.revision as number) < 1) errors.push("revision must be a positive integer");
	if (!Number.isInteger(input.controllerEpoch) || (input.controllerEpoch as number) < 1) {
		errors.push("controllerEpoch must be a positive integer");
	}
	if (typeof input.phase !== "string" || !PROGRAMME_PHASES.includes(input.phase as ProgrammePhase)) {
		errors.push(`phase must be one of ${PROGRAMME_PHASES.join(", ")}`);
	}
	if (!nonEmptyString(input.title)) errors.push("title must be a non-empty string");
	if (!nonEmptyString(input.createdAt)) errors.push("createdAt must be a non-empty string");
	if (!nonEmptyString(input.updatedAt)) errors.push("updatedAt must be a non-empty string");
	if (!nonEmptyString(input.stableAgentId)) errors.push("stableAgentId must be a non-empty string");
	if (!nonEmptyString(input.sessionId)) errors.push("sessionId must be a non-empty string");
	const backlogSource = validateBacklogSource(input.backlogSource, "backlogSource", errors);
	if (input.policy !== undefined) {
		if (!isPlainObject(input.policy)) errors.push("policy must be an object");
		else {
			const policyExtra = unknownKeys(input.policy, POLICY_KEYS);
			if (policyExtra.length > 0) errors.push(`policy has unknown fields: ${policyExtra.join(", ")}`);
			if (!nonEmptyString(input.policy.path)) errors.push("policy.path must be a non-empty string");
			if (!nonEmptyString(input.policy.hash)) errors.push("policy.hash must be a non-empty string");
			if (!nonEmptyString(input.policy.version)) errors.push("policy.version must be a non-empty string");
		}
	}
	if (input.instructionBundleHash !== undefined && !nonEmptyString(input.instructionBundleHash)) {
		errors.push("instructionBundleHash must be a non-empty string when present");
	}
	if (input.proposal !== undefined) {
		if (!isPlainObject(input.proposal)) errors.push("proposal must be an object");
		else {
			const proposalExtra = unknownKeys(input.proposal, PROPOSAL_KEYS);
			if (proposalExtra.length > 0) errors.push(`proposal has unknown fields: ${proposalExtra.join(", ")}`);
			validateTerms(input.proposal, "proposal", errors, PROPOSAL_KEYS);
			if (!Number.isInteger(input.proposal.proposalRevision) || (input.proposal.proposalRevision as number) < 1) {
				errors.push("proposal.proposalRevision must be a positive integer");
			}
			if (input.proposal.proposedBy !== "operator" && input.proposal.proposedBy !== "parent-agent") {
				errors.push("proposal.proposedBy must be operator or parent-agent");
			}
			if (!nonEmptyString(input.proposal.proposedAt)) errors.push("proposal.proposedAt must be a non-empty string");
			if (!stringList(input.proposal.amendedFields)) errors.push("proposal.amendedFields must be a string array");
		}
	}
	if (input.grant !== undefined) {
		if (!isPlainObject(input.grant)) errors.push("grant must be an object");
		else {
			const grantExtra = unknownKeys(input.grant, GRANT_KEYS);
			if (grantExtra.length > 0) errors.push(`grant has unknown fields: ${grantExtra.join(", ")}`);
			validateTerms(input.grant, "grant", errors, GRANT_KEYS);
			if (!Number.isInteger(input.grant.grantRevision) || (input.grant.grantRevision as number) < 1) {
				errors.push("grant.grantRevision must be a positive integer");
			}
			if (!nonEmptyString(input.grant.approvedAt)) errors.push("grant.approvedAt must be a non-empty string");
			if (input.grant.approvedBy !== "operator") errors.push("grant.approvedBy must be operator");
			if (!nonEmptyString(input.grant.termsHash)) errors.push("grant.termsHash must be a non-empty string");
		}
	}
	if (!Array.isArray(input.increments)) errors.push("increments must be an array");
	else {
		input.increments.forEach((increment, index) => {
			if (!isPlainObject(increment)) {
				errors.push(`increments[${index}] must be an object`);
				return;
			}
			const incrementExtra = unknownKeys(increment, INCREMENT_KEYS);
			if (incrementExtra.length > 0) errors.push(`increments[${index}] has unknown fields: ${incrementExtra.join(", ")}`);
			if (typeof increment.incrementId !== "string" || !INCREMENT_ID_PATTERN.test(increment.incrementId)) {
				errors.push(`increments[${index}].incrementId must match inc_<12 hex>`);
			}
			if (!nonEmptyString(increment.title)) errors.push(`increments[${index}].title must be a non-empty string`);
			if (!nonEmptyString(increment.sprintGoal)) errors.push(`increments[${index}].sprintGoal must be a non-empty string`);
			if (!["proposed", "approved", "active", "completed", "withdrawn"].includes(String(increment.status))) {
				errors.push(`increments[${index}].status is invalid`);
			}
			if (!Number.isInteger(increment.grantRevision)) errors.push(`increments[${index}].grantRevision must be an integer`);
			if (!Number.isInteger(increment.proposalRevision)) errors.push(`increments[${index}].proposalRevision must be an integer`);
			if (!nonEmptyString(increment.createdAt)) errors.push(`increments[${index}].createdAt must be a non-empty string`);
		});
	}
	if (!Array.isArray(input.operatorDecisions)) errors.push("operatorDecisions must be an array");
	else {
		input.operatorDecisions.forEach((decision, index) => {
			if (!isPlainObject(decision)) {
				errors.push(`operatorDecisions[${index}] must be an object`);
				return;
			}
			const decisionExtra = unknownKeys(decision, DECISION_KEYS);
			if (decisionExtra.length > 0) errors.push(`operatorDecisions[${index}] has unknown fields: ${decisionExtra.join(", ")}`);
			if (!nonEmptyString(decision.at)) errors.push(`operatorDecisions[${index}].at must be a non-empty string`);
			if (!nonEmptyString(decision.action)) errors.push(`operatorDecisions[${index}].action must be a non-empty string`);
		});
	}
	if (input.recoveryReason !== undefined && !nonEmptyString(input.recoveryReason)) {
		errors.push("recoveryReason must be a non-empty string when present");
	}
	if (input.resumePhase !== undefined && !PROGRAMME_PHASES.includes(input.resumePhase as ProgrammePhase)) {
		errors.push("resumePhase must be a valid programme phase when present");
	}
	if (errors.length > 0 || !backlogSource) return { ok: false, errors };
	return { ok: true, record: input as unknown as ProgrammeRecord };
}

// ─── Hashing ─────────────────────────────────────────────────────────────────
export function hashText(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

// ─── Durable store ───────────────────────────────────────────────────────────
export type ProgrammeStateErrorCode = "missing" | "malformed" | "conflict" | "io";

export class ProgrammeStateError extends Error {
	readonly code: ProgrammeStateErrorCode;
	constructor(code: ProgrammeStateErrorCode, message: string) {
		super(message);
		this.code = code;
		this.name = "ProgrammeStateError";
	}
}

export type ProgrammeStore = {
	dir: string;
	read(programmeId: string): ProgrammeRecord;
	list(): { records: ProgrammeRecord[]; invalid: Array<{ file: string; error: string }> };
	create(record: ProgrammeRecord): ProgrammeRecord;
	update(programmeId: string, expectedRevision: number, mutate: (current: ProgrammeRecord) => ProgrammeRecord): ProgrammeRecord;
};

export function programmesStateDir(): string {
	const override = process.env.PI_AGILE_PROGRAMMES_DIR?.trim();
	if (override) return resolve(override);
	return join(piAgentDir(), "state", "muster", "programmes");
}

/**
 * Atomic replacement and serialized compare-and-set are delegated to the
 * repo's settings lock/atomic-rename helper so programme transitions follow
 * the same conventions as every other durable controller state.
 */
export function fileProgrammeStore(dir = programmesStateDir()): ProgrammeStore {
	const pathFor = (programmeId: string): string => {
		if (!PROGRAMME_ID_PATTERN.test(programmeId)) {
			throw new ProgrammeStateError("io", `invalid programme id: ${programmeId}`);
		}
		return join(dir, `${programmeId}.json`);
	};
	const parse = (raw: unknown, path: string): ProgrammeRecord => {
		const validated = validateProgrammeRecord(raw);
		if (!validated.ok) {
			throw new ProgrammeStateError("malformed", `Programme record ${path} is invalid: ${validated.errors.join("; ")}`);
		}
		return validated.record;
	};
	return {
		dir,
		read(programmeId: string): ProgrammeRecord {
			const path = pathFor(programmeId);
			if (!existsSync(path)) throw new ProgrammeStateError("missing", `No programme record at ${path}`);
			const raw = readJsonSettingsFile<Record<string, unknown>>(path, {});
			if (Object.keys(raw).length === 0) {
				throw new ProgrammeStateError("malformed", `Programme record ${path} is empty`);
			}
			return parse(raw, path);
		},
		list() {
			const records: ProgrammeRecord[] = [];
			const invalid: Array<{ file: string; error: string }> = [];
			if (!existsSync(dir)) return { records, invalid };
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".json")) continue;
				const path = join(dir, file);
				try {
					const raw = readJsonSettingsFile<Record<string, unknown>>(path, {});
					records.push(parse(raw, path));
				} catch (error) {
					invalid.push({ file, error: messageOf(error) });
				}
			}
			return { records, invalid };
		},
		create(record: ProgrammeRecord): ProgrammeRecord {
			const path = pathFor(record.programmeId);
			try {
				return updateJsonSettingsFile<Record<string, unknown>>(path, {}, (current) => {
					if (typeof current.programmeId === "string") {
						throw new ProgrammeStateError("conflict", `Programme record ${path} already exists`);
					}
					const next = parse(record, path);
					return next as unknown as Record<string, unknown>;
				}) as unknown as ProgrammeRecord;
			} catch (error) {
				throw mapStoreError(error, path);
			}
		},
		update(programmeId, expectedRevision, mutate) {
			const path = pathFor(programmeId);
			try {
				return updateJsonSettingsFile<Record<string, unknown>>(path, {}, (current) => {
					if (typeof current.programmeId !== "string") {
						throw new ProgrammeStateError("missing", `No programme record at ${path}`);
					}
					const stored = parse(current, path);
					if (stored.revision !== expectedRevision) {
						throw new ProgrammeStateError(
							"conflict",
							`Programme revision conflict for ${programmeId}: expected ${expectedRevision}, current ${stored.revision}`,
						);
					}
					const next = mutate(stored);
					return parse(next, path) as unknown as Record<string, unknown>;
				}) as unknown as ProgrammeRecord;
			} catch (error) {
				throw mapStoreError(error, path);
			}
		},
	};
}

function mapStoreError(error: unknown, path: string): ProgrammeStateError {
	if (error instanceof ProgrammeStateError) return error;
	if (error instanceof RefusalSignal) throw error;
	const message = messageOf(error);
	if (message.includes("Malformed settings file")) return new ProgrammeStateError("malformed", message);
	return new ProgrammeStateError("io", `Programme store failure at ${path}: ${message}`);
}

export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ─── Worker adoption facts (plan §4.1, §5.4) ─────────────────────────────────
/**
 * Durable-facts port for worker adoption. The decomposition and launch-intent
 * schemas stay at their existing owners (Muster); this controller only states
 * what it needs to re-verify, and receives a refusal when the owner cannot
 * establish it. Every method is read-only and synchronous so adoption can run
 * inside session startup without awaiting a model or a network turn.
 */
export type WorkerSeedQuery = {
	programmeId: string;
	taskId: string;
	agentId: string;
	/** Approved grant terms from the durable programme record. */
	grant: GrantTerms;
};

export type WorkerSeedTaskFacts = {
	acceptedRevision: number;
	incrementId: string;
	contractHash: string;
	assignedAgentId: string;
	intendedRole: OperatingRole;
	repository: string;
	writeTargets: string[];
	readOnly: boolean;
};

export type WorkerLaunchIntentFacts = {
	recorded: boolean;
	verified: boolean;
	expired: boolean;
	superseded: boolean;
};

export type WorkerSeedPort = {
	/** Facts from the accepted decomposition revision (Muster owns that schema). */
	readTask(query: WorkerSeedQuery):
		| { ok: true; task: WorkerSeedTaskFacts }
		| { ok: false; reason: RefusalReason; detail: string };
	/** The parent-written launch intent for this exact programme/task/lane. */
	readLaunchIntent(query: {
		programmeId: string;
		taskId: string;
		agentId: string;
		/**
		 * Session whose journal holds the parent-written intent. A worker lane and
		 * the parent that launched it are separate processes, so the port reads the
		 * parent's journal rather than the lane's own.
		 */
		parentSessionId?: string;
	}): WorkerLaunchIntentFacts;
	/**
	 * Persist the parent's launch intent for this exact programme/task/lane
	 * (`issueWorkerSeed`, before the lane is spawned). The Muster owner keeps
	 * writing its own preflight record through the same store.
	 */
	recordLaunchIntent(query: { programmeId: string; taskId: string; agentId: string }): WorkerLaunchIntentFacts;
	/** This process's own stable lane identity, never the seed's claim. */
	laneAgentId(): string | undefined;
};

// ─── Admission classification ────────────────────────────────────────────────
/**
 * Read-only tools allowed during Agile discovery/setup/pause. Everything not
 * listed requires an admitted task: P4 replaces this conservative fallback
 * with Toolbelt's operation classification through `setAdmissionPolicy`.
 * "Conservative" means the whole mixed-tool call needs admission, never that
 * the tool's functions are removed.
 */
export const AGILE_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"harness_status",
	"verify_status",
	"session_status",
	"history_index_status",
	"context_lookup",
	"recall",
	"recall_expand",
	"history_search",
	"history_read",
	"graphify_query",
	"graphify_explain",
	"graphify_path",
	"graphify_status",
	"self_improvements_query",
	"background_list",
	"background_output",
	// Stopping your own runaway process is a safety action, not programme work;
	// the existing resource guards still apply.
	"background_kill",
	"expand_result",
	"review_chunk_read",
	"muster_status",
	// Recovery joins for already-running delegates (plan §6.3) stay usable.
	"delegate_join",
	"delegate_result",
	// External reads are evidence, never authority; mutations stay blocked.
	"web_search",
	"fetch_content",
	"code_search",
]);

// ─── Worker state ────────────────────────────────────────────────────────────
export const WORKER_STATE_UNKNOWN: WorkerState = { liveWorkers: 1, settled: false, source: "unknown" };

export type WorkerState = { liveWorkers: number; settled: boolean; source: "muster" | "operator" | "unknown" };
