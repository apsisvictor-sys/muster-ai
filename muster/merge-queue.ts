/**
 * The merge queue (R2, plan §R2).
 *
 * A worker offers what it built: the base it started from, its head, and the
 * guarded-run logs that verified that head. The parent integrates it
 * mechanically or not at all — no model judgment about the code:
 *
 *   - the base is still the integration head, every evidence log was produced at
 *     the offered head, and no risky glob is touched → fast-forward, mark
 *     integrated, finish;
 *   - the integration head moved → the offer goes back to the worker at the
 *     current version with "rebase onto <head> and re-verify", with no parent
 *     turn in between (two workers racing both end integrated, one after the
 *     other);
 *   - a risky glob is touched → no fast-forward until an independent review
 *     verdict for this exact head is recorded on the task;
 *   - evidence produced at another commit, or a shape that does not parse → a
 *     refusal that names what is wrong.
 *
 * R2's switch: `risky-only` demands a verdict for a risky diff, `every-lane` demands one for every offer. The
 * mode's word comes from the `review-mode` file when one is recorded; with none, it starts `risky-only` and
 * turns itself to `every-lane` once the queue holds a verdict a week old (`resolveReviewMode`). The lane card
 * reads a lane's newest verdict from the same rows (`reviewMarkForLane`), so a verdict is kept once.
 *
 * Pure decisions only: the git work (the integration checkout's head, the paths
 * between base and head, the fast-forward itself) is injected, so this module
 * holds no process capability. `control.ts` owns the durable offer and verdict
 * rows.
 */

import type { MergeQueueState, OfferEvidence, OfferEvidenceEntry, ReviewVerdict } from "./control.ts";
import { isRuntimeActorIdentity, type RuntimeActorIdentity } from "./lead.ts";

export type { OfferEvidence, OfferEvidenceEntry, ReviewVerdict, MergeQueueState };

// ─── The review-mode switch (R2, §9) ─────────────────────────────────────────

/**
 * Which offers need an independent verdict: `risky-only` (the switch's first setting) reviews a diff that
 * touches a risky path, `every-lane` reviews every offer before it fast-forwards.
 */
export const REVIEW_MODES = ["risky-only", "every-lane"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

/** Risky-only until verdicts have been landing this long, then every-lane (R2: "after one week of verdicts"). */
export const REVIEW_MODE_WEEK_MS = 7 * 24 * 60 * 60_000;

/** The mode a `review-mode` file's text names, or `undefined` when it names none (never guessed). */
export function parseReviewMode(text: string | undefined): ReviewMode | undefined {
	const value = text?.trim();
	return value === "risky-only" || value === "every-lane" ? value : undefined;
}

/** The oldest verdict's time: where "one week of verdicts" is measured from. */
export function firstVerdictAtMs(reviews: readonly { at: string }[]): number | undefined {
	let first: number | undefined;
	for (const review of reviews) {
		const at = Date.parse(review.at);
		if (!Number.isFinite(at)) continue;
		first = first === undefined ? at : Math.min(first, at);
	}
	return first;
}

/**
 * The mode in force. The file's own word wins, in both directions, so `risky-only` written there is the
 * rollback (§11 rule 1). With no word recorded, the switch starts `risky-only` and turns itself to
 * `every-lane` once the queue holds a verdict a week old, which is a week of verdicts.
 */
export function resolveReviewMode(input: { recorded?: string | undefined; reviews: readonly { at: string }[]; now: number }): ReviewMode {
	const recorded = parseReviewMode(input.recorded);
	if (recorded !== undefined) return recorded;
	const first = firstVerdictAtMs(input.reviews);
	return first !== undefined && input.now - first >= REVIEW_MODE_WEEK_MS ? "every-lane" : "risky-only";
}

/**
 * The card's view of the queue (R2, §9 "the lane card reads the verdict from the queue"): the newest verdict
 * for a task this lane offered. A projection of the stored row, never a second place a verdict is kept.
 */
export type ReviewMark = { verdict: "approve" | "reject"; reviewer: string; head_sha: string; at: string; model?: string };

export function reviewMarkForLane(queue: MergeQueueState | undefined, laneId: string): ReviewMark | undefined {
	if (queue === undefined) return undefined;
	const tasks = new Set(queue.offers.filter((offer) => offer.offeredBy === laneId).map((offer) => offer.taskId));
	let newest: ReviewMark | undefined;
	for (const review of queue.reviews) {
		if (!tasks.has(review.taskId)) continue;
		if (newest !== undefined && Date.parse(review.at) <= Date.parse(newest.at)) continue;
		newest = {
			verdict: review.verdict,
			reviewer: review.reviewer,
			head_sha: review.head_sha,
			at: review.at,
			...(review.runtime?.model !== undefined ? { model: review.runtime.model } : {}),
		};
	}
	return newest;
}

/** What the parent may accept as an offer's evidence fields. */
export type ParsedOffer =
	| { ok: true; value: OfferEvidence }
	| { ok: false; error: string };

const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/**
 * Read the three offer fields off a tool call. Anything missing or malformed is
 * a refusal with the exact field, never a guessed value.
 */
export function parseOfferEvidence(raw: unknown): ParsedOffer {
	if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, error: "the offer carries no base_sha, head_sha and evidence" };
	}
	const input = raw as Record<string, unknown>;
	if (!isText(input["base_sha"])) return { ok: false, error: "evidence: base_sha must be a non-empty commit sha" };
	if (!isText(input["head_sha"])) return { ok: false, error: "evidence: head_sha must be a non-empty commit sha" };
	const evidence = input["evidence"];
	if (!Array.isArray(evidence) || evidence.length === 0) {
		return { ok: false, error: "evidence must list at least one guarded-run log" };
	}
	const rows: OfferEvidenceEntry[] = [];
	for (const [index, entry] of evidence.entries()) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			return { ok: false, error: `evidence[${index}] must be an object` };
		}
		const row = entry as Record<string, unknown>;
		for (const field of ["log", "root", "head_sha", "fingerprint"] as const) {
			if (!isText(row[field])) return { ok: false, error: `evidence[${index}].${field} must be a non-empty string` };
		}
		rows.push({
			log: (row["log"] as string).trim(),
			root: (row["root"] as string).trim(),
			head_sha: (row["head_sha"] as string).trim(),
			fingerprint: (row["fingerprint"] as string).trim(),
		});
	}
	return {
		ok: true,
		value: { base_sha: (input["base_sha"] as string).trim(), head_sha: (input["head_sha"] as string).trim(), evidence: rows },
	};
}

export type IntegrationDecision =
	| { action: "fast-forward" }
	| { action: "reassign"; head: string; note: string }
	| { action: "needs-review"; paths: string[]; mode?: ReviewMode }
	| { action: "refuse"; why: string };

/** What the worker is told when the integration head moved under it. */
export function reassignNote(head: string): string {
	return `The integration head moved to ${head} while you worked, so your evidence no longer describes what would land. Rebase onto ${head} and re-verify, then offer again. This rebase is worker-owned: it needs no parent turn.`;
}

/** One independence predicate for recording and consuming a verdict. Agent aliases alone never establish it. */
export function reviewIsIndependent(offer: OfferEvidence, verdict: ReviewVerdict | undefined, parent: RuntimeActorIdentity | undefined): boolean {
	const author = offer.runtime;
	const reviewer = verdict?.runtime;
	return isRuntimeActorIdentity(author) && isRuntimeActorIdentity(reviewer) && isRuntimeActorIdentity(parent)
		&& isRuntimeActorIdentity(verdict?.parentRuntime)
		&& reviewer.sessionId !== author.sessionId && reviewer.sessionId !== parent.sessionId
		&& reviewer.model !== author.model && reviewer.model !== parent.model;
}

/**
 * Decide what accepting this offer does. `changedPaths` are the repository
 * paths between the offer's base and head, read by the injected git port.
 */
export function integrationDecision(input: {
	offer: OfferEvidence | undefined;
	/** The integration branch's current commit, or undefined when it cannot be read. */
	integrationHead: string | undefined;
	changedPaths: string[];
	risky: (path: string) => boolean;
	verdict?: ReviewVerdict | undefined;
	parentRuntime?: RuntimeActorIdentity;
	/** The switch's setting (`resolveReviewMode`); absent is `risky-only`, so every existing caller is unchanged. */
	reviewMode?: ReviewMode;
}): IntegrationDecision {
	const { offer, integrationHead, changedPaths, risky, verdict } = input;
	const reviewMode = input.reviewMode ?? "risky-only";
	if (integrationHead === undefined || integrationHead.trim() === "") {
		return { action: "refuse", why: "the integration checkout's head could not be read, so nothing was fast-forwarded" };
	}
	if (offer === undefined) {
		return { action: "refuse", why: "the handoff carries no base_sha, head_sha and evidence, so there is nothing to verify or fast-forward" };
	}
	if (offer.base_sha !== integrationHead) {
		return { action: "reassign", head: integrationHead, note: reassignNote(integrationHead) };
	}
	// The offered head is a descendant of the integration head: the port's
	// fast-forward is what proves that, and it fails when it is not.
	const stale = offer.evidence.filter((entry) => entry.head_sha !== offer.head_sha);
	if (stale.length > 0) {
		return {
			action: "refuse",
			why: `stale evidence: ${stale.map((entry) => `${entry.log} ran at ${entry.head_sha}`).join("; ")}; the offered head is ${offer.head_sha}. Re-verify that head and offer again`,
		};
	}
	const riskyPaths = changedPaths.filter((path) => risky(path));
	const independent = reviewIsIndependent(offer, verdict, input.parentRuntime);
	const approved = verdict !== undefined && verdict.verdict === "approve" && verdict.head_sha === offer.head_sha && independent;
	if (independent && verdict?.verdict === "reject") {
		return { action: "refuse", why: `the review verdict for ${offer.head_sha} is a reject (${verdict.reviewer})` };
	}
	if (riskyPaths.length > 0) {
		if (!approved) return { action: "needs-review", paths: riskyPaths };
	} else if (reviewMode === "every-lane" && !approved) {
		// Every-lane: the whole diff needs its verdict, so the paths to review are what the offer changes.
		return { action: "needs-review", paths: changedPaths, mode: "every-lane" };
	}
	return { action: "fast-forward" };
}

/** Human-facing refusal text, including what to do next. */
export function integrationRefusalText(decision: IntegrationDecision, project: string): string {
	switch (decision.action) {
		case "fast-forward":
			return "";
		case "reassign":
			return `${project}: the integration head moved to ${decision.head}. The offer goes back to the worker: ${decision.note}`;
		case "needs-review":
			return decision.mode === "every-lane"
				? `${project}: every offer needs an independent review verdict for its head while review-mode is every-lane, and none is recorded for this one (the diff is ${decision.paths.join(", ")}). No fast-forward was made. Run a reviewer lane on a different model family over the offered diff and record the verdict on the task.`
				: `${project}: this offer touches risky paths (${decision.paths.join(", ")}) and has no independent review verdict for its head. No fast-forward was made. Run a reviewer lane on a different model (a Claude reviewer lane, or a Pi reviewer lane) over the offered diff and record the verdict on the task.`;
		case "refuse":
			return `${project}: this offer was not integrated. ${decision.why}`;
	}
}