/**
 * Derived work-item state: the one place a work item's state is reconciled (statederived-0005, the operator 2026-10-29).
 *
 * The board used to show the `state` a writer typed. Now the stored state is a *claim* — who said it and when —
 * and this module derives what the item actually stands in from the authorities that can answer for it:
 *
 *   planned      the plan increment that names the item     (`planIncrement`)
 *   queued       the writer's word that it may go            (the claim: nothing verifies a queue position)
 *   in build     the lane id, and that the lane is live      (`lanes`)
 *   in review    a review asked for, or a verdict that passed while CI has not (`reviewAsked`, `reviews`)
 *   sent for fix the reviewer's verdict, with the round, who sent it back and why (`reviews`)
 *   approved     the reviewer passed it and CI concluded success (`reviews`, `ciConclusion`)
 *   merged       a commit on the integration branch whose change is present now (`mergedCommit`)
 *   live         the live probe answers                      (`liveProbe`)
 *   done         merged, for an increment no probe can answer (`liveApplies`)
 *   gated        the writer's word, carrying a reason code    (the claim, `gatedCodeProblem`)
 *   dropped      the writer's word, carrying its reason       (the claim)
 *
 * A claim the evidence does not back is never shown as fact: the derivation keeps the claim as the state and
 * says `unproven`, so every reader renders it as claimed, with who said it and when. A claim never satisfies
 * anything either: a gate that waits on another item (`after:<CODE>`) is open until that item's own evidence
 * answers, and `gateStates` is the one place that judgement is made.
 *
 * `moveWorkItem` is the evidence-bound writer: a state whose authority cannot answer is refused, unless the
 * caller says that what it is recording is a claim. `driftCheck` is the same comparison across the store, and
 * `runWorkItemDrift` is the job that writes its proof file (the `work-item-drift` contract) and reports the
 * exact mismatches to Henry's mailbox once per distinct set.
 *
 * The store is the existing one (`work-items.ts`), and nothing here writes a second one. The authorities are a
 * port: this module holds no process, git or network capability, so a test states what each authority answers,
 * and the git rules that produce those answers are pure functions here (`revertOf`, `mergeProblem`).
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { musterStateDir } from "./binding.ts";
import { tellGrokbot } from "./grokbot-tell.ts";
import {
	DROPPED_PREFIX,
	GATED_AFTER_PREFIX,
	gateReasonCode,
	gatedCodeProblem,
	isWorkItemLabel,
	listWorkItems,
	setWorkItemState,
	WORK_ITEM_LABELS,
	workItemStateDetail,
	workItemStateLabel,
	WorkItemStateError,
	type WorkItemContext,
	type WorkItemLabel,
	type WorkItemRecord,
	type WorkItemStore,
} from "./work-items.ts";

// ─── The authorities ────────────────────────────────────────────────────────

/**
 * One reviewer verdict on the item's head, as the merge queue kept it. `fix` is a rejection that sends it back.
 * `round` is the reviewer's own round number when it names one; otherwise a round is the head it judged, so two
 * findings in one review are one round and a re-offer is the next.
 */
export type WorkItemReviewRow = { verdict: "approve" | "fix"; at: string; head?: string; reviewer?: string; reason?: string; round?: number };

/**
 * How many rounds a story has been sent back on: one round is one verdict that sent it back, never one message or
 * one file touched. A verdict that names its round counts by that number; one that does not is grouped by the head
 * it judged, so two findings on the same head are one round and a second verdict on a new head is two.
 */
export function roundsOf(reviews: readonly WorkItemReviewRow[]): number {
	const rounds = new Set<string>();
	for (const row of reviews) {
		if (row.verdict !== "fix") continue;
		rounds.add(row.round !== undefined ? `round:${row.round}` : row.head !== undefined ? `head:${row.head}` : `at:${row.at}`);
	}
	return rounds.size;
}

/**
 * What git says about the commit an item's merge points at. The reconciler decides from these three facts, so
 * the authority answers facts and never a verdict:
 *
 *   - `onIntegrationBranch`: the commit is reachable from the integration branch. From git alone that is
 *     `git merge-base --is-ancestor <commit> <integration branch>`, which a commit left on a dropped branch
 *     fails — a dropped branch's commits are not ancestors of the branch that dropped it.
 *   - `patchPresent`: the commit's change is in the integration branch now, whatever happened in between. From git
 *     alone that is `git cherry <integration branch> <commit>`: `-` says the change is upstream, `+` says it is
 *     not. This is the fact that decides a revert: reverting a merge leaves the merge an ancestor but takes its
 *     change out, and re-landing it (a revert of the revert, a cherry-pick, a rebase) puts the change back. The
 *     current state of the branch decides, never the history of events.
 *   - `revertedBy`: the commit that undoes it, when one does, for the reader's sentence only. From git alone that
 *     is `git log <integration branch> --grep="This reverts commit <commit>"`: `git revert` writes that line into
 *     the revert's own body, whatever the reverted commit's subject was, so a revert cannot hide behind a
 *     rewritten message. `revertOf` reads it out of a parsed log.
 */
export type MergeEvidence = {
	commit: string;
	/** Whether the commit is an ancestor of the integration branch now. */
	onIntegrationBranch: boolean;
	/** Whether the commit's change is present in the integration branch now (`git cherry`: `-` is present). */
	patchPresent: boolean;
	/** The commit that reverts it, when one does: the reader's sentence, never the decision. */
	revertedBy?: string;
};

/** One row of `git log` as the caller parsed it: the escalated facts a revert is found from. */
export type GitLogRow = { sha: string; subject: string; body: string };

/**
 * The revert of `commit`, read from a log the way git writes one: the reverting commit's body carries
 * `This reverts commit <sha>.` The match is on the whole hash or a prefix of it, because a short sha in the
 * message is still the same commit. `undefined` when no commit reverts it.
 */
export function revertOf(commit: string, log: readonly GitLogRow[]): string | undefined {
	const wanted = commit.trim().toLowerCase();
	if (!/^[0-9a-f]{7,40}$/.test(wanted)) return undefined;
	for (const row of log) {
		const text = `${row.subject}\n${row.body}`.toLowerCase();
		const pattern = /this reverts commit ([0-9a-f]{7,40})/g;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(text)) !== null) {
			const named = match[1]!;
			if (named === wanted || wanted.startsWith(named) || named.startsWith(wanted)) return row.sha;
		}
	}
	return undefined;
}

/**
 * Why a merge's evidence does not make the item merged, or undefined when it does. The integration branch's current
 * state decides: a commit whose change the branch carries is merged even if it was reverted and re-landed, and a
 * commit whose change the branch does not carry is not merged, whether nothing ever carried it or a revert that
 * still stands took it out.
 */
export function mergeProblem(evidence: MergeEvidence): string | undefined {
	if (!evidence.onIntegrationBranch) return `commit ${evidence.commit} is not on the integration branch`;
	if (evidence.patchPresent) return undefined;
	if (evidence.revertedBy !== undefined) return `commit ${evidence.commit} was reverted by ${evidence.revertedBy} and never re-landed`;
	return `commit ${evidence.commit}'s change is not present in the integration branch`;
}

/** The sentence a reader sees when the branch carries the change. A revert that was re-landed is named, never denied. */
export function mergedProof(evidence: MergeEvidence): string {
	const present = `commit ${evidence.commit} is on the integration branch and its change is present now`;
	if (evidence.revertedBy !== undefined) return `${present}; reverted by ${evidence.revertedBy} and re-landed`;
	return present;
}

/**
 * What the authorities answer about one work item. Every method answers about a fact outside the record, and
 * `undefined` means "no answer" — never "no": an authority that says nothing cannot prove a state, so the item
 * falls back to its claim and reads as unproven.
 */
export type WorkItemAuthorities = {
	/** The commit the item's merge points at, with what git says about it, or undefined when none names the item. */
	mergedCommit(code: string): MergeEvidence | undefined;
	/** The CI conclusion for the item's head, or undefined when CI has said nothing about it. */
	ciConclusion(code: string): string | undefined;
	/** The reviewer verdicts recorded for the item's head, oldest first. */
	reviews(code: string, lane: string | undefined): readonly WorkItemReviewRow[];
	/** When a review was asked for and none has answered yet, or undefined. */
	reviewAsked(code: string, lane: string | undefined): string | undefined;
	/** The lane ids that are live now. */
	lanes(): readonly string[];
	/** The live probe's answer for the item's increment, or undefined when no probe answers. */
	liveProbe(code: string): { probe: string; value: string } | undefined;
	/** Whether a probe can answer for this increment at all: a docs-only one cannot, and goes merged then done. */
	liveApplies(code: string): boolean;
	/** The plan increment that names the item, or undefined when no approved plan carries it. */
	planIncrement(code: string): string | undefined;
	/**
	 * The plan's own codes that look like this one but are not it (`WP-SL1` for `SL1`), so a mapping nobody
	 * recorded is reported instead of blessed. Absent: no plan codes are known.
	 */
	planCodesLike?(code: string): readonly string[];
};

/** An authority that answers nothing: what a reader without evidence has, and what every claim falls back to. */
export const NO_AUTHORITIES: WorkItemAuthorities = {
	mergedCommit: () => undefined,
	ciConclusion: () => undefined,
	reviews: () => [],
	reviewAsked: () => undefined,
	lanes: () => [],
	liveProbe: () => undefined,
	liveApplies: () => false,
	planIncrement: () => undefined,
	planCodesLike: () => [],
};

// ─── The derivation ─────────────────────────────────────────────────────────

/** The claim a record carries: the state a writer stored, the label it maps to, and who said it when. */
export type WorkItemClaim = { state: string; label: WorkItemLabel; by: string; at: string };

/**
 * What a record stands in, and why. `label` is what a reader shows. `unproven` is present exactly when the
 * stored claim is the only thing that says so, and names what the evidence lacks.
 */
export type WorkItemDerivation = {
	code: string;
	label: WorkItemLabel;
	/** The evidence that carries the label, one line, or the claim when only the claim says it. */
	proof: string;
	claim: WorkItemClaim;
	/** The lane the item's state names, when it names one. */
	lane?: string;
	/** On `sent for fix` (and on a story that passed after bouncing): how many times it was sent back. */
	rounds?: number;
	/** Who sent it back, and the one line they gave: a round the reader cannot attribute is a count, not a story. */
	sentBackBy?: string;
	sentBackWhy?: string;
	/** `gated`'s reason code, or `dropped`'s reason. */
	reason?: string;
	/** Present when the claim is not backed: one line naming what the evidence lacks. Rendered as claimed/unproven. */
	unproven?: string;
};

/** The last event on a record is who last wrote it: the claim's author and time. */
function claimOf(record: WorkItemRecord): WorkItemClaim {
	const last = record.events[record.events.length - 1];
	return { state: record.state, label: workItemStateLabel(record.state), by: last?.by ?? "unknown", at: last?.at ?? "" };
}

/** The lane a state names, or undefined: `launched:<lane>` is the one encoding that carries one. */
export function laneOfClaim(state: string): string | undefined {
	return state.startsWith("launched:") ? workItemStateDetail(state) || undefined : undefined;
}

/** What the evidence lacks for a label whose authority did not answer. */
function missingEvidence(label: WorkItemLabel, lane: string | undefined): string {
	switch (label) {
		case "merged":
			return "no commit on the integration branch names it, unreverted";
		case "live":
			return "no live probe answers for it";
		case "approved":
			return "no reviewer verdict and CI conclusion back it";
		case "in review":
			return "no review was asked for and no verdict is recorded";
		case "sent for fix":
			return "no reviewer verdict sent it back";
		case "in build":
			return lane === undefined ? "it names no lane" : `lane ${lane} is not live`;
		case "done":
			return "no merged commit on the integration branch closes it";
		default:
			return "no authority backs it";
	}
}

/** Who sent it back and why, from the verdict that did: the reviewer's own words, never a count on its own. */
function sendBack(row: WorkItemReviewRow | undefined): { sentBackBy?: string; sentBackWhy?: string } {
	return {
		...(row?.reviewer === undefined ? {} : { sentBackBy: row.reviewer }),
		...(row?.reason === undefined || row.reason === "" ? {} : { sentBackWhy: row.reason }),
	};
}

/**
 * The label a record stands in, from the authorities. The decisions a machine cannot check come first — a
 * dropped item stays dropped and a gated one stays gated, both carrying the reason their writer gave — and then
 * the evidence, strongest first: the live probe, the merged commit, the reviewer's verdict, CI, the lane.
 */
export function deriveWorkItemState(record: WorkItemRecord, authorities: WorkItemAuthorities): WorkItemDerivation {
	const code = record.code;
	const claim = claimOf(record);
	const lane = laneOfClaim(record.state);
	const at = (label: WorkItemLabel, proof: string, extra: Partial<WorkItemDerivation> = {}): WorkItemDerivation => ({
		code,
		claim,
		label,
		proof,
		...(lane === undefined ? {} : { lane }),
		...extra,
	});

	if (claim.label === "dropped") {
		const reason = workItemStateDetail(record.state);
		return at("dropped", `dropped by ${claim.by} at ${claim.at}: ${reason}`, { reason });
	}
	if (claim.label === "gated") {
		const raw = workItemStateDetail(record.state);
		const mapped = gateReasonCode(raw);
		return at("gated", `gated by ${claim.by} at ${claim.at}: ${raw}`, {
			reason: mapped ?? raw,
			...(mapped === undefined ? { unproven: `gated with the free reason ${JSON.stringify(raw)}: it carries no reason code` } : {}),
		});
	}

	const probe = authorities.liveProbe(code);
	if (probe !== undefined) return at("live", `the live probe ${probe.probe} reads ${probe.value}`);
	const merge = authorities.mergedCommit(code);
	const mergeWhy = merge === undefined ? undefined : mergeProblem(merge);
	if (merge !== undefined && mergeWhy === undefined) {
		const proof = mergedProof(merge);
		if (claim.label === "done" && !authorities.liveApplies(code)) return at("done", `${proof}, and no probe applies to this increment`);
		return at("merged", proof);
	}

	const reviews = authorities.reviews(code, lane);
	const rounds = roundsOf(reviews);
	const last = reviews[reviews.length - 1];
	const lastFix = [...reviews].reverse().find((entry) => entry.verdict === "fix");
	if (last?.verdict === "fix") {
		const who = last.reviewer === undefined ? "the reviewer" : last.reviewer;
		const why = last.reason === undefined || last.reason === "" ? "" : `: ${last.reason}`;
		return at("sent for fix", `round ${rounds}, sent back by ${who} at ${last.at}${why}`, { rounds, ...sendBack(lastFix ?? last) });
	}
	if (last?.verdict === "approve") {
		const ci = authorities.ciConclusion(code);
		if (ci === "success") {
			return at("approved", `the reviewer passed ${last.head ?? "its head"} at ${last.at} and CI concluded success`, { rounds, ...sendBack(lastFix) });
		}
		return at("in review", `the reviewer passed ${last.head ?? "its head"} at ${last.at}; CI reads ${ci ?? "no conclusion"}`);
	}
	const asked = authorities.reviewAsked(code, lane);
	if (asked !== undefined) return at("in review", `a review was asked for at ${asked} and none has answered`);
	if (lane !== undefined && authorities.lanes().includes(lane)) return at("in build", `lane ${lane} is live`);

	const increment = authorities.planIncrement(code);
	if (claim.label === "queued") return at("queued", `filed ready to dispatch by ${claim.by} at ${claim.at}`);
	if (claim.label === "planned") {
		const near = authorities.planCodesLike?.(code) ?? [];
		const mapping = near.length === 0 ? "" : `; the plan names ${near.join(", ")}, so the mapping to this record is not recorded`;
		return at("planned", increment === undefined ? `filed by ${claim.by} at ${claim.at}${mapping}` : `plan increment ${increment}`);
	}
	if (increment !== undefined) return at("planned", `plan increment ${increment}`);
	// Nothing backs the claim: the record keeps it, and every reader renders it as claimed rather than as fact.
	const why = mergeWhy ?? missingEvidence(claim.label, lane);
	return at(claim.label, `claimed by ${claim.by} at ${claim.at}`, { unproven: why });
}

/** One line a reader shows the operator: the label, its proof, and — when it is only a claim — that it is unproven. */
export function workItemStateLine(derivation: WorkItemDerivation): string {
	const round = derivation.rounds === undefined ? "" : ` (round ${derivation.rounds})`;
	const reason = derivation.reason === undefined || derivation.reason === "" ? "" : ` ${derivation.reason}`;
	const unproven = derivation.unproven === undefined ? "" : ` [claimed, unproven: ${derivation.unproven}]`;
	const proof =
		derivation.sentBackBy === undefined
			? derivation.proof
			: `${derivation.proof}${derivation.sentBackWhy === undefined ? "" : ` — "${derivation.sentBackWhy}"`}`;
	return `${derivation.label}${reason}${round} — ${proof}${unproven}`;
}

// ─── Evidence-bound transitions ─────────────────────────────────────────────

export type MoveWorkItemInput = {
	store: WorkItemStore;
	code: string;
	/** The label to move to, `gated:<reason code>` or `dropped:<reason>`. */
	target: string;
	context: WorkItemContext;
	authorities: WorkItemAuthorities;
	/** The lane the item is in build on, when the caller knows it and the record does not yet name it. */
	lane?: string;
	/**
	 * What a move with no evidence is: `true` records it as a claim, which every reader renders as unproven;
	 * absent or `false` refuses it.
	 */
	claim?: boolean;
};

const refuse = (message: string): WorkItemStateError => new WorkItemStateError("invalid", message);

/** The state a target stores, validated: only a label, a coded gate or a dropped reason gets past here. */
export function workItemStateFor(target: string): { label: WorkItemLabel; state: string; reason?: string } {
	if (target.startsWith("gated:")) {
		const reason = target.slice("gated:".length).trim();
		const problem = gatedCodeProblem(reason);
		if (problem !== undefined) throw refuse(`gated ${JSON.stringify(reason)}: ${problem}`);
		return { label: "gated", state: `gated:${reason}`, reason };
	}
	if (target.startsWith(DROPPED_PREFIX)) {
		const reason = target.slice(DROPPED_PREFIX.length).trim();
		if (reason === "") throw refuse(`${DROPPED_PREFIX} must name what replaced the item or why it is not wanted`);
		return { label: "dropped", state: `${DROPPED_PREFIX}${reason}`, reason };
	}
	if (!isWorkItemLabel(target)) {
		throw refuse(`state ${JSON.stringify(target)} must be one of ${WORK_ITEM_LABELS.join(", ")}, gated:<reason code> or dropped:<reason>`);
	}
	return { label: target, state: target };
}

/** The evidence a label needs, and what the authorities answer: `why` names what is missing. */
function evidenceFor(
	label: WorkItemLabel,
	input: MoveWorkItemInput & { record: WorkItemRecord },
	store: { state: string; reason?: string },
): { ok: true; state: string; proof: string } | { ok: false; why: string } {
	const { code, authorities, record } = input;
	const lane = input.lane ?? laneOfClaim(record.state);
	const reviews = authorities.reviews(code, lane);
	const last = reviews[reviews.length - 1];
	const merge = authorities.mergedCommit(code);
	const mergeWhy = merge === undefined ? "no commit on the integration branch names it, unreverted" : mergeProblem(merge);
	switch (label) {
		case "merged":
			return mergeWhy === undefined && merge !== undefined
				? { ok: true, state: "merged", proof: mergedProof(merge) }
				: { ok: false, why: mergeWhy ?? "no commit names it" };
		case "live": {
			const probe = authorities.liveProbe(code);
			return probe === undefined ? { ok: false, why: "no live probe answers for it" } : { ok: true, state: "live", proof: `the live probe ${probe.probe} reads ${probe.value}` };
		}
		case "approved": {
			if (last?.verdict !== "approve") return { ok: false, why: "no reviewer verdict passed it" };
			const ci = authorities.ciConclusion(code);
			if (ci !== "success") return { ok: false, why: `CI reads ${ci ?? "no conclusion"}` };
			return { ok: true, state: "approved", proof: `the reviewer passed ${last.head ?? "its head"} at ${last.at} and CI concluded success` };
		}
		case "in review": {
			if (reviews.length > 0) return { ok: true, state: "in review", proof: `the reviewer's verdict of ${last?.verdict} at ${last?.at} is recorded` };
			const asked = authorities.reviewAsked(code, lane);
			if (asked === undefined) return { ok: false, why: "no review was asked for and no verdict is recorded" };
			return { ok: true, state: "in review", proof: `a review was asked for at ${asked}` };
		}
		case "sent for fix": {
			if (last?.verdict !== "fix") return { ok: false, why: "no reviewer verdict sent it back" };
			const rounds = roundsOf(reviews);
			const who = last.reviewer === undefined ? "the reviewer" : last.reviewer;
			const why = last.reason === undefined || last.reason === "" ? "" : `: ${last.reason}`;
			return { ok: true, state: "sent for fix", proof: `round ${rounds}, sent back by ${who} at ${last.at}${why}` };
		}
		case "in build": {
			if (lane === undefined) return { ok: false, why: "it names no lane" };
			if (!authorities.lanes().includes(lane)) return { ok: false, why: `lane ${lane} is not live` };
			return { ok: true, state: `launched:${lane}`, proof: `lane ${lane} is live` };
		}
		case "done": {
			if (mergeWhy !== undefined || merge === undefined) return { ok: false, why: mergeWhy ?? "no commit names it" };
			if (authorities.liveApplies(code)) return { ok: false, why: "a live probe applies to this increment, so it ends live, not done" };
			return { ok: true, state: "done", proof: `commit ${merge.commit} is on the integration branch, and no probe applies` };
		}
		case "planned": {
			const increment = authorities.planIncrement(code);
			return increment === undefined ? { ok: false, why: "no approved plan increment names it" } : { ok: true, state: "planned", proof: `plan increment ${increment}` };
		}
		case "queued":
		case "gated":
		case "dropped":
			// A queue position, a gate and a drop are decisions: nothing outside the record can answer for them.
			return { ok: true, state: store.state, proof: "the writer's own word" };
	}
}

/**
 * Moves an item to a state, with the evidence that state needs. An evidence-bound state whose authority answers
 * nothing is refused, unless `claim` says that a claim is what is being recorded — and then the move is stored
 * with the reason it is not proven, so every reader shows it as claimed.
 */
export function moveWorkItem(input: MoveWorkItemInput): WorkItemRecord {
	const record = input.store.read(input.code);
	if (record === undefined) throw new WorkItemStateError("missing", `no work item ${input.code}`);
	const target = workItemStateFor(input.target);
	const evidence = evidenceFor(target.label, { ...input, record }, target);
	if (evidence.ok) return setWorkItemState(input.store, input.code, evidence.state, input.context, `evidence: ${evidence.proof}`);
	if (input.claim !== true) {
		throw refuse(`${input.code} cannot be ${target.label}: ${evidence.why}. Record it as a claim if that is what it is`);
	}
	return setWorkItemState(input.store, input.code, target.state, input.context, `claimed, unproven: ${evidence.why}`);
}

// ─── Gates ─────────────────────────────────────────────────────────────────

/**
 * One gated record's gate: the code the operator fixed, who or what it waits on, and whether it is open.
 *
 *   `needs-operators-ok`   waits on the operator's own approval      — open until he gives it and the record moves
 *   `needs-decision`     waits on a decision                 — open until the architect records it
 *   `needs-credential`   waits on a credential               — open until the operator places it
 *   `after:<CODE>`       waits on another item's evidence     — open until that item is merged, live or done on
 *                                                              evidence, because a claim satisfies nothing
 *   `wrong-owner`        waits on whoever owns it            — open here, closed by handing it over
 *
 * A gate whose record carries no code waits on a code: the reader is told so instead of being told nothing.
 */
export type GateState = {
	code: string;
	/** The gate itself: the approved reason code, or the free reason when the record carries no code. */
	gate: string;
	/** Who or what the gate waits on. */
	waitsOn: "operator" | "decision" | "credential" | "evidence" | "another-owner" | "code";
	/** The item an `after:` gate waits on. */
	target?: string;
	satisfied: boolean;
	because: string;
};

/** What each coded gate waits on, in one table: the vocabulary is the operator's and nothing restates it. */
const GATE_WAITS_ON: Readonly<Record<string, { waitsOn: GateState["waitsOn"]; because: string }>> = {
	"needs-operators-ok": { waitsOn: "operator", because: "waits on the operator's own approval" },
	"needs-decision": { waitsOn: "decision", because: "waits on a decision the architect records" },
	"needs-credential": { waitsOn: "credential", because: "waits on a credential only the operator can place" },
	"wrong-owner": { waitsOn: "another-owner", because: "not this programme's work: it waits on whoever owns it" },
};

/**
 * Every gated record's gate, and whether it is open. A claim never satisfies a gate: an `after:` item must itself
 * rest on evidence (merged, live or done, with nothing unproven), because a hand-typed `done` says only that
 * someone typed it. This is the one place that judgement is made.
 */
export function gateStates(input: { records: readonly WorkItemRecord[]; authorities: WorkItemAuthorities }): GateState[] {
	const derivations = new Map(input.records.map((record) => [record.code, deriveWorkItemState(record, input.authorities)]));
	const gates: GateState[] = [];
	for (const record of input.records) {
		if (derivations.get(record.code)!.label !== "gated") continue;
		const raw = workItemStateDetail(record.state);
		const code = gateReasonCode(raw);
		if (code === undefined) {
			gates.push({ code: record.code, gate: raw, waitsOn: "code", satisfied: false, because: `it carries the free reason ${JSON.stringify(raw)}: no reason code, so nobody can be named` });
			continue;
		}
		const named = GATE_WAITS_ON[code];
		if (named !== undefined) {
			gates.push({ code: record.code, gate: code, waitsOn: named.waitsOn, satisfied: false, because: named.because });
			continue;
		}
		const target = code.startsWith(GATED_AFTER_PREFIX) ? code.slice(GATED_AFTER_PREFIX.length) : code;
		const other = derivations.get(target);
		if (other === undefined) {
			gates.push({ code: record.code, gate: code, waitsOn: "evidence", target, satisfied: false, because: `no work item carries the code ${target}` });
			continue;
		}
		const proven = other.unproven === undefined && (other.label === "merged" || other.label === "live" || other.label === "done");
		gates.push({
			code: record.code,
			gate: code,
			waitsOn: "evidence",
			target,
			satisfied: proven,
			because: proven ? `${target} is ${other.label} (${other.proof})` : `${target} is ${other.label}, only claimed: ${other.unproven ?? other.proof}`,
		});
	}
	return gates;
}

// ─── The drift check ────────────────────────────────────────────────────────

/** One record whose stored state its evidence does not back, with the exact reason. */
export type WorkItemDriftMismatch = { code: string; claimed: WorkItemLabel; derived: WorkItemLabel; because: string };

/** What one drift pass found. `ok` is the contract's verdict: every record matched its evidence. */
export type WorkItemDriftReport = { at: string; checked: number; ok: boolean; mismatches: WorkItemDriftMismatch[] };

/**
 * Why a gate's stored reason is not a usable code, or undefined when it is one. The `after:` half is
 * `gateStates`', because whether the item it names exists — and whether that item's own evidence opens the gate —
 * is a question about the records, not about the string.
 */
function gateProblem(record: WorkItemRecord): string | undefined {
	if (workItemStateLabel(record.state) !== "gated") return undefined;
	const raw = workItemStateDetail(record.state);
	if (gateReasonCode(raw) === undefined) return `it is gated with the free reason ${JSON.stringify(raw)}, which is no reason code`;
	return undefined;
}

/**
 * Every record whose stored state its evidence does not back, or that a reader cannot act on: an unproven
 * claim, a label the evidence moved past, a gate with no usable reason code, an `after:` gate whose target is
 * only claimed, and a record whose code the plan carries under another name. One pass, one report.
 */
export function driftCheck(input: { records: readonly WorkItemRecord[]; authorities: WorkItemAuthorities; now?: number }): WorkItemDriftReport {
	const gates = new Map(gateStates({ records: input.records, authorities: input.authorities }).map((gate) => [gate.code, gate]));
	const mismatches: WorkItemDriftMismatch[] = [];
	for (const record of input.records) {
		const derivation = deriveWorkItemState(record, input.authorities);
		const because: string[] = [];
		if (derivation.unproven !== undefined) because.push(derivation.unproven);
		else if (derivation.label !== derivation.claim.label) because.push(`the record says ${derivation.claim.label}; the evidence says ${derivation.proof}`);
		const gate = gateProblem(record);
		if (gate !== undefined) because.push(gate);
		const gateState = gates.get(record.code);
		// A gate that waits on a person is the board's normal state, not drift. An `after:` gate is drift when the
		// item it waits on cannot answer, and a gate with no code is reported by `gateProblem` above.
		if (gateState !== undefined && !gateState.satisfied && gateState.waitsOn === "evidence") because.push(`its gate is open: ${gateState.because}`);
		const near = input.authorities.planCodesLike?.(record.code) ?? [];
		if (near.length > 0) because.push(`the plan names ${near.join(", ")} and not ${record.code}, so the mapping to this record is not recorded`);
		if (because.length === 0) continue;
		mismatches.push({ code: record.code, claimed: derivation.claim.label, derived: derivation.label, because: because.join("; ") });
	}
	const at = new Date(input.now ?? Date.now()).toISOString();
	return { at, checked: input.records.length, ok: mismatches.length === 0, mismatches };
}

// ─── The job ────────────────────────────────────────────────────────────────

/** The contract's proof file, under the muster state dir: the last drift pass, as it ran. */
export const WORK_ITEM_DRIFT_FILE = "work-item-drift.json";
/** How many mismatches one line names; the rest are counted, and the proof file holds them all. */
export const DRIFT_LINE_ROWS = 6;
/** The sender of the drift line, as the bus knows it (`tellGrokbot`'s `from`). */
export const WORK_ITEM_DRIFT_SENDER = "work-item-drift";

export function workItemDriftPath(stateDir: string = musterStateDir()): string {
	return join(stateDir, WORK_ITEM_DRIFT_FILE);
}

/** Writes the pass atomically, so the doctor reads a whole report or the previous one. */
export function writeWorkItemDrift(stateDir: string, report: WorkItemDriftReport): string {
	const file = workItemDriftPath(stateDir);
	mkdirSync(stateDir, { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, file);
	return file;
}

/** The one line the mailbox and the panel get: what failed, in codes and reasons, never a count alone. */
export function driftLine(report: WorkItemDriftReport): string {
	if (report.ok) return `muster work items: all ${report.checked} records match their evidence`;
	const shown = report.mismatches.slice(0, DRIFT_LINE_ROWS).map((row) => `${row.code} says ${row.claimed}, evidence says ${row.derived} (${row.because})`);
	const rest = report.mismatches.length - shown.length;
	return `muster work items: ${report.mismatches.length} of ${report.checked} records do not match their evidence: ${shown.join("; ")}${rest > 0 ? `; and ${rest} more in ${WORK_ITEM_DRIFT_FILE}` : ""}`;
}

export type WorkItemDriftRun = WorkItemDriftReport & { file: string; reported: boolean };

/**
 * The job: read the store, diff every record against its authorities, write the contract's proof, and report the
 * exact mismatches to Henry's mailbox once per distinct set. The key is the set itself (`tellGrokbot`'s
 * idempotency key), so an unchanged set is not sent twice and a set that grows is sent again with the new row.
 * A clean pass writes its proof and reports nothing.
 */
export function runWorkItemDrift(input: {
	authorities: WorkItemAuthorities;
	store: WorkItemStore;
	stateDir?: string;
	/** Where the line goes; absent, Henry's inbox through the one send path. */
	report?: (line: string, key: string) => void;
	now?: number;
}): WorkItemDriftRun {
	const stateDir = input.stateDir ?? musterStateDir();
	const report = driftCheck({ records: listWorkItems(input.store).items, authorities: input.authorities, now: input.now });
	const file = writeWorkItemDrift(stateDir, report);
	if (report.ok) return { ...report, file, reported: false };
	const line = driftLine(report);
	const key = `work-item-drift:${report.mismatches.map((row) => `${row.code}@${row.derived}`).join(",")}`;
	const send = input.report ?? ((text: string, idempotencyKey: string) => tellGrokbot(stateDir, WORK_ITEM_DRIFT_SENDER, text, idempotencyKey));
	send(line, key);
	return { ...report, file, reported: true };
}
