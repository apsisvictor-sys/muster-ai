/**
 * `core/delegate-evidence.ts` — the shared check-evidence envelope (S2).
 *
 * The shape a child session uses to hand its captured verification bindings to
 * the parent through the existing structured delegate result, and the tolerant
 * predicate the parent's verify gate reads it back with, plus the execution
 * observation and binding identity the envelope transports.
 *
 * This file imports nothing: the moved vocabulary stays usable in every
 * profile without reaching Pi's profile or the files it left.
 */

export const EXECUTION_EVIDENCE_VERSION = 1;

/** Lifecycle of the observed process, from the harness's point of view. */
export type ExecutionState = "running" | "exited" | "failed";

export interface ExecutionEvidence {
	version: 1;
	/** The background registry's own task id. Reused, never re-minted. */
	executionId: string;
	toolCallId: string;
	sessionId?: string;
	/** The actual spawn cwd, not `process.cwd()` guessed later. */
	cwd: string;
	/** The original executed command; existing redaction rules apply. */
	command: string;
	state: ExecutionState;
	/** `null` never means success; a `failed` state may carry no precise code. */
	exitCode: number | null;
	startedAt: number;
	endedAt?: number;
	outputPath: string;
	failureReason?: string;
}

/** Structural validation. A partial or mis-typed envelope is not evidence. */
export function isExecutionEvidence(value: unknown): value is ExecutionEvidence {
	if (value === null || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (v.version !== EXECUTION_EVIDENCE_VERSION) return false;
	if (typeof v.executionId !== "string" || v.executionId === "") return false;
	if (typeof v.toolCallId !== "string" || v.toolCallId === "") return false;
	if (v.sessionId !== undefined && typeof v.sessionId !== "string") return false;
	if (typeof v.cwd !== "string" || typeof v.command !== "string") return false;
	if (v.state !== "running" && v.state !== "exited" && v.state !== "failed") return false;
	if (v.exitCode !== null && typeof v.exitCode !== "number") return false;
	if (typeof v.startedAt !== "number") return false;
	if (v.endedAt !== undefined && typeof v.endedAt !== "number") return false;
	if (typeof v.outputPath !== "string" || v.outputPath === "") return false;
	if (v.failureReason !== undefined && typeof v.failureReason !== "string") return false;
	return true;
}

/** Who requested the executed check. Provenance, never authority. */
export type VerificationBindingActorKind = "builder" | "verifier" | "parent";

/**
 * Identity fields captured before execution. Stable across transport: the
 * binding id is derived from exactly these, never from the result.
 */
export interface VerificationBindingIdentity {
	sessionId?: string;
	actorKind: VerificationBindingActorKind;
	/** The actual checkout root the run executed against. */
	checkoutRoot: string;
	/** Content fingerprint of the checkout the run consumed. */
	fingerprint: string;
	/** Root mutation generation at execution start (producer session). */
	mutationGeneration: number;
	recipeId: string;
	recipeDigest: string;
	/** Units the invocation actually covered. */
	unitKeys: string[];
	/** The original executed command. */
	command: string;
	startedAt: number;
	/** Hash of the relevant config/lockfile content at run time. */
	configIdentity: string;
}

/** One completed, structurally transportable check execution. */
export interface VerificationBinding extends VerificationBindingIdentity {
	bindingId: string;
	/** Background-registry execution id (`ExecutionEvidence.executionId`). */
	executionRef: string;
	endedAt?: number;
	/** `null` never means success. */
	exitCode: number | null;
	/** Resolved output/log path; a reference, never a copied transcript. */
	artifactPath: string;
}

/** One check execution a delegate child captured and transported. */
export interface DelegateCheckEvidence {
	/** Trusted shell-execution envelope from the background registry. */
	executionEvidence: ExecutionEvidence;
	recipeId: string;
	/** Units the invocation actually covered. */
	unitKeys: string[];
	/** The actual checkout root the run executed against. */
	checkoutRoot: string;
	/** Hash of the relevant config/lockfile content at run time. */
	configHash: string;
	/** Full transported binding when the producer captured one (P2.2). */
	binding?: VerificationBinding;
	/** Start content fingerprint of the execution; absent = not importable. */
	fingerprint?: string;
	/** Root mutation generation at execution start (producer session). */
	mutationGeneration?: number;
	recipeDigest?: string;
	actorKind?: "builder" | "verifier" | "parent";
}

/** Structural validation of the transport envelope only. */
export function isDelegateCheckEvidence(value: unknown): value is DelegateCheckEvidence {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const v = value as Record<string, unknown>;
	if (!isExecutionEvidence(v.executionEvidence)) return false;
	if (typeof v.recipeId !== "string" || v.recipeId === "") return false;
	if (!Array.isArray(v.unitKeys) || v.unitKeys.length === 0) return false;
	if (!v.unitKeys.every((unit) => typeof unit === "string" && unit !== "")) return false;
	if (typeof v.checkoutRoot !== "string" || v.checkoutRoot === "") return false;
	if (typeof v.configHash !== "string" || v.configHash === "") return false;
	if (v.binding !== undefined && (v.binding === null || typeof v.binding !== "object" || Array.isArray(v.binding))) return false;
	if (v.fingerprint !== undefined && (typeof v.fingerprint !== "string" || v.fingerprint === "")) return false;
	if (v.mutationGeneration !== undefined && (!Number.isInteger(v.mutationGeneration) || (v.mutationGeneration as number) < 0)) return false;
	if (v.recipeDigest !== undefined && (typeof v.recipeDigest !== "string" || v.recipeDigest === "")) return false;
	if (v.actorKind !== undefined && v.actorKind !== "builder" && v.actorKind !== "verifier" && v.actorKind !== "parent") return false;
	return true;
}
