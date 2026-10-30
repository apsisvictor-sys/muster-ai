import "./muster-test-isolation.ts";
/**
 * Derived work-item state (statederived-0005, the operator 2026-10-29): the reconciliation owner, the evidence-bound
 * transitions, `rounds` on a story that bounces, and the drift check that reports a record whose claim its
 * evidence does not back.
 *
 * The six proofs the brief names, in its order:
 *   a. a hand claim of `merged` with no commit is not accepted as fact and reads as unproven;
 *   b. `merged` is derived from a real commit in the integration branch;
 *   c. `sent for fix` counts its rounds, so a bouncing story is visible;
 *   d. `gated` needs a reason code and refuses a free string;
 *   e. the drift fixture (a claimed merge with no commit) fails the check, and passes once the commit exists;
 *   f. the stored encodings the current readers read are unchanged, and the label is the only vocabulary added.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	NO_AUTHORITIES,
	deriveWorkItemState,
	driftCheck,
	gateStates,
	laneOfClaim,
	mergeProblem,
	moveWorkItem,
	revertOf,
	roundsOf,
	runWorkItemDrift,
	workItemDriftPath,
	workItemStateFor,
	workItemStateLine,
	WORK_ITEM_DRIFT_FILE,
	type GitLogRow,
	type WorkItemAuthorities,
	type WorkItemReviewRow,
} from "../work-item-state.ts";
import {
	createWorkItem,
	fileWorkItemStore,
	isWorkItemState,
	listWorkItems,
	readWorkItem,
	setWorkItemState,
	workItemStateDetail,
	workItemStateLabel,
	WORK_ITEM_LABELS,
	type CreateWorkItemInput,
	type WorkItemRecord,
	type WorkItemStore,
} from "../work-items.ts";

const WHEN = "2026-10-29T10:00:00.000Z";
const OWNER = { by: "orchestrator", at: WHEN } as const;

function input(over: Partial<CreateWorkItemInput> = {}): CreateWorkItemInput {
	return {
		code: "SD-1",
		heading: "A work item's state is derived from its evidence",
		summary: "the board cannot show a claim as a fact",
		goal: "statederived",
		project: "muster",
		kind: "build",
		class: "H3",
		acceptance: "a claim with no evidence reads as unproven",
		source: "handoffs/msgs/statederived-0005.md",
		state: "ready",
		...over,
	};
}

function authorities(over: Partial<WorkItemAuthorities> = {}): WorkItemAuthorities {
	return { ...NO_AUTHORITIES, ...over };
}

function withStore(run: (store: WorkItemStore, dir: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "muster-work-item-state-"));
	const dir = join(root, "work-items");
	mkdirSync(dir, { recursive: true });
	try {
		run(fileWorkItemStore(dir), root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** A record as a writer left it, without going through a transition: the fixture every proof starts from. */
function recordIn(store: WorkItemStore, state: string, over: Partial<CreateWorkItemInput> = {}): WorkItemRecord {
	const created = createWorkItem(store, input(over), OWNER);
	return state === created.state ? created : setWorkItemState(store, created.code, state, OWNER);
}

// ─── (a) a claim is not a fact ──────────────────────────────────────────────

test("(a) a hand claim of merged with no commit is refused as a transition, and reads as unproven when recorded as a claim", () => {
	withStore((store) => {
		recordIn(store, "ready");
		assert.throws(
			() => moveWorkItem({ store, code: "SD-1", target: "merged", context: OWNER, authorities: authorities() }),
			/cannot be merged: no commit on the integration branch names it, unreverted/,
			"an evidence-bound state with no evidence is refused",
		);

		const claimed = moveWorkItem({ store, code: "SD-1", target: "merged", context: OWNER, authorities: authorities(), claim: true });
		assert.equal(claimed.state, "merged", "the claim is what the writer said");
		assert.match(claimed.events[claimed.events.length - 1]!.detail, /\(claimed, unproven: no commit on the integration branch names it, unreverted\)/, "the event records who, when and why it is unproven");

		const derivation = deriveWorkItemState(claimed, authorities());
		assert.equal(derivation.label, "merged", "the claim is kept, because the record is what the writer said");
		assert.equal(derivation.unproven, "no commit on the integration branch names it, unreverted");
		assert.match(workItemStateLine(derivation), /\[claimed, unproven: no commit/, "every reader shows it as claimed");
	});
});

// ─── (b) merged comes from a commit ─────────────────────────────────────────

test("(b) merged is derived from a commit in the integration branch, and names it", () => {
	withStore((store) => {
		recordIn(store, "ready");
		const moved = moveWorkItem({
			store,
			code: "SD-1",
			target: "merged",
			context: OWNER,
			authorities: authorities({ mergedCommit: (code) => (code === "SD-1" ? { commit: "abc1234def", onIntegrationBranch: true, patchPresent: true } : undefined) }),
		});
		assert.equal(moved.state, "merged");
		assert.match(moved.events[moved.events.length - 1]!.detail, /\(evidence: commit abc1234def is on the integration branch and its change is present now\)/);

		const derivation = deriveWorkItemState(moved, authorities({ mergedCommit: () => ({ commit: "abc1234def", onIntegrationBranch: true, patchPresent: true }) }));
		assert.equal(derivation.label, "merged");
		assert.equal(derivation.unproven, undefined, "a derived state is not a claim");
		assert.match(derivation.proof, /commit abc1234def is on the integration branch and its change is present now/);
		assert.doesNotMatch(derivation.proof, /nothing reverted it/);
		assert.doesNotMatch(workItemStateLine(derivation), /unproven/);
	});
});

test("(b) an item no probe can answer ends done once merged, and one a probe can answer stays merged", () => {
	const merged = authorities({ mergedCommit: () => ({ commit: "abc1234def", onIntegrationBranch: true, patchPresent: true }) });
	withStore((store) => {
		const done = recordIn(store, "done");
		assert.equal(deriveWorkItemState(done, authorities({ ...merged, liveApplies: () => false })).label, "done", "a docs-only increment goes merged then done");
		assert.equal(deriveWorkItemState(done, authorities({ ...merged, liveApplies: () => true })).label, "merged", "an increment a probe answers for is not done until the probe says so");
	});
});

// ─── (c) a bouncing story shows its rounds ─────────────────────────────────

test("(c) sent for fix counts the rounds it is on", () => {
	const fixes: WorkItemReviewRow[] = [
		{ verdict: "fix", at: "2026-10-29T11:00:00.000Z", head: "aaa1111" },
		{ verdict: "fix", at: "2026-10-29T12:00:00.000Z", head: "bbb2222" },
	];
	const reviews = (rows: WorkItemReviewRow[]) => authorities({ reviews: () => rows });
	withStore((store) => {
		const launched = recordIn(store, "launched:sd-1a");
		assert.equal(laneOfClaim(launched.state), "sd-1a");

		const once = deriveWorkItemState(launched, reviews(fixes.slice(0, 1)));
		assert.equal(once.label, "sent for fix");
		assert.equal(once.rounds, 1);

		const twice = deriveWorkItemState(launched, reviews(fixes));
		assert.equal(twice.rounds, 2, "the second send-back is the second round");
		assert.match(workItemStateLine(twice), /sent for fix \(round 2\)/);

		const moved = moveWorkItem({ store, code: "SD-1", target: "sent for fix", context: OWNER, authorities: reviews(fixes) });
		assert.equal(moved.state, "sent for fix");
		assert.match(moved.events[moved.events.length - 1]!.detail, /round 2/);
	});
});

test("(c) a verdict that passed is approved only with CI, and in review without it", () => {
	const passed: WorkItemReviewRow[] = [{ verdict: "approve", at: "2026-10-29T11:00:00.000Z", head: "aaa1111" }];
	withStore((store) => {
		const launched = recordIn(store, "launched:sd-1a");
		const waiting = deriveWorkItemState(launched, authorities({ reviews: () => passed }));
		assert.equal(waiting.label, "in review");
		assert.match(waiting.proof, /CI reads no conclusion/, "the reviewer's pass is not the CI conclusion");

		const approved = deriveWorkItemState(launched, authorities({ reviews: () => passed, ciConclusion: () => "success" }));
		assert.equal(approved.label, "approved");
		assert.throws(
			() => moveWorkItem({ store, code: "SD-1", target: "approved", context: OWNER, authorities: authorities({ reviews: () => passed }) }),
			/CI reads no conclusion/,
		);
	});
});

// ─── (d) gated carries a code ──────────────────────────────────────────────

test("(d) gated needs a reason code and refuses a free string", () => {
	for (const target of ["gated:parked", "gated:live-record", "gated:held", "gated:dep:OL2", "gated:", "gated:after:two words"]) {
		assert.throws(() => workItemStateFor(target), /must be one of needs-operators-ok, needs-decision, needs-credential, wrong-owner or after:<work item code>|after: must name a work item code|must not be empty/, `${target} is not a reason code`);
	}
	for (const target of ["gated:needs-operators-ok", "gated:needs-decision", "gated:needs-credential", "gated:wrong-owner", "gated:after:PS-2"]) {
		assert.equal(workItemStateFor(target).state, target, `${target} is a reason code`);
	}
	withStore((store) => {
		recordIn(store, "ready");
		assert.throws(() => moveWorkItem({ store, code: "SD-1", target: "gated:parked", context: OWNER, authorities: authorities() }), /gated .* no reason code|must be one of/);
		assert.equal(moveWorkItem({ store, code: "SD-1", target: "gated:needs-decision", context: OWNER, authorities: authorities() }).state, "gated:needs-decision");
		const derivation = deriveWorkItemState(readWorkItem(store, "SD-1")!, authorities());
		assert.equal(derivation.label, "gated");
		assert.equal(derivation.reason, "needs-decision");
	});
});

test("(d) a gate written before the codes existed still reads, and the reconciler says it carries no code", () => {
	withStore((store) => {
		const legacy = recordIn(store, "gated:parked");
		const derivation = deriveWorkItemState(legacy, authorities());
		assert.equal(derivation.label, "gated", "an existing record keeps its state");
		assert.equal(derivation.reason, "parked");
		assert.match(derivation.unproven ?? "", /no reason code/);
		const named = deriveWorkItemState(recordIn(store, "gated:dep:OL2", { code: "SD-2" }), authorities());
		assert.equal(named.reason, "after:OL2", "a dependency names the item it waits on");
		assert.equal(named.unproven, undefined);
	});
});

test("(d) dropped carries the reason that replaced it, and a dropped item stays dropped", () => {
	withStore((store) => {
		recordIn(store, "ready");
		const merged = authorities({ mergedCommit: () => ({ commit: "abc1234", onIntegrationBranch: true, patchPresent: true }) });
		const dropped = moveWorkItem({ store, code: "SD-1", target: "dropped:replaced-by:PS-2", context: OWNER, authorities: merged });
		const derivation = deriveWorkItemState(dropped, merged);
		assert.equal(derivation.label, "dropped", "a decision outranks the evidence under it");
		assert.equal(derivation.reason, "replaced-by:PS-2");
		assert.throws(() => moveWorkItem({ store, code: "SD-1", target: "dropped:", context: OWNER, authorities: authorities() }), /must name what replaced the item/);
	});
});

// ─── (e) the drift check ───────────────────────────────────────────────────

test("(e) the drift fixture fails before the evidence arrives and passes after", () => {
	withStore((store) => {
		const claimed = recordIn(store, "merged");
		// Before the reconciler the record's state was the fact every reader showed; it still reads that way
		// through the claim's own encoding, which is why the check has to be the one that refuses it.
		assert.equal(claimed.state, "merged");
		assert.equal(workItemStateLabel(claimed.state), "merged");

		const broken = driftCheck({ records: [claimed], authorities: authorities() });
		assert.equal(broken.ok, false, "a claimed merge with no commit fails the check");
		assert.deepEqual(broken.mismatches, [
			{ code: "SD-1", claimed: "merged", derived: "merged", because: "no commit on the integration branch names it, unreverted" },
		]);

		const fixed = driftCheck({ records: [claimed], authorities: authorities({ mergedCommit: () => ({ commit: "abc1234def", onIntegrationBranch: true, patchPresent: true }) }) });
		assert.equal(fixed.ok, true, "the same record passes once the commit is in the integration branch");
		assert.deepEqual(fixed.mismatches, []);
		assert.equal(fixed.checked, 1);
	});
});

test("(e) the drift job writes the contract's proof and reports the exact mismatches once per set", () => {
	withStore((store, root) => {
		recordIn(store, "merged");
		const sent: { line: string; key: string }[] = [];
		const run = runWorkItemDrift({ store, stateDir: root, authorities: authorities(), report: (line, key) => sent.push({ line, key }), now: Date.parse(WHEN) });
		assert.equal(run.ok, false);
		assert.equal(run.reported, true);
		assert.equal(sent.length, 1);
		assert.match(sent[0]!.line, /1 of 1 records do not match their evidence: SD-1 says merged, evidence says merged \(no commit on the integration branch names it, unreverted\)/);
		assert.match(sent[0]!.key, /^work-item-drift:SD-1@merged$/);

		const written = JSON.parse(readFileSync(workItemDriftPath(root), "utf8")) as { ok: boolean; checked: number; mismatches: { code: string }[] };
		assert.equal(written.ok, false);
		assert.equal(written.checked, 1);
		assert.equal(written.mismatches[0]!.code, "SD-1");
		assert.equal(run.file, join(root, WORK_ITEM_DRIFT_FILE));
	});
});

test("(e) a clean store writes a passing proof and reports nothing", () => {
	withStore((store, root) => {
		recordIn(store, "ready");
		const sent: string[] = [];
		const run = runWorkItemDrift({ store, stateDir: root, authorities: authorities(), report: (line) => sent.push(line) });
		assert.equal(run.ok, true);
		assert.equal(run.reported, false);
		assert.deepEqual(sent, []);
		assert.equal((JSON.parse(readFileSync(workItemDriftPath(root), "utf8")) as { ok: boolean }).ok, true);
	});
});

// ─── (g) a round names who sent it back, and why ──────────────────────────

test("(g) sent for fix names the reviewer and the reason, not just the count", () => {
	const fixes: WorkItemReviewRow[] = [
		{ verdict: "fix", at: "2026-10-29T11:00:00.000Z", head: "aaa1111", reviewer: "mimo-v2.6-flash", reason: "the drift line names no code" },
		{ verdict: "fix", at: "2026-10-29T12:00:00.000Z", head: "bbb2222", reviewer: "mimo-v2.6-flash", reason: "the gate test does not prove the claim" },
	];
	withStore((store) => {
		const launched = recordIn(store, "launched:sd-1a");
		const derivation = deriveWorkItemState(launched, authorities({ reviews: () => fixes }));
		assert.equal(derivation.label, "sent for fix");
		assert.equal(derivation.rounds, 2);
		assert.equal(derivation.sentBackBy, "mimo-v2.6-flash", "the round carries who sent it back");
		assert.equal(derivation.sentBackWhy, "the gate test does not prove the claim", "and the one line they gave");
		const line = workItemStateLine(derivation);
		assert.match(line, /sent for fix \(round 2\)/);
		assert.match(line, /sent back by mimo-v2\.6-flash/, "the reader sees the reviewer");
		assert.match(line, /"the gate test does not prove the claim"/, "and the reason in their words");

		const moved = moveWorkItem({ store, code: "SD-1", target: "sent for fix", context: OWNER, authorities: authorities({ reviews: () => fixes }) });
		assert.match(moved.events[moved.events.length - 1]!.detail, /\(evidence: round 2, sent back by mimo-v2\.6-flash at 2026-10-29T12:00:00\.000Z: the gate test does not prove the claim\)/);
	});
});

test("(g) a verdict with no reviewer still says a person's verdict, never a bare count", () => {
	withStore((store) => {
		const launched = recordIn(store, "launched:sd-1a");
		const derivation = deriveWorkItemState(launched, authorities({ reviews: () => [{ verdict: "fix", at: "2026-10-29T11:00:00.000Z" }] }));
		assert.match(derivation.proof, /sent back by the reviewer/);
		assert.equal(derivation.sentBackWhy, undefined, "no reason is invented");
	});
});

// ─── (h) a revert or a dropped branch is not a merge ──────────────────────

test("(h) the CCSCRUM case: a merge that a later commit reverted does not read as merged", () => {
	// dbaea06 is the real revert of 3d999ab, and git wrote it the way git writes one.
	const log: GitLogRow[] = [
		{ sha: "dbaea06", subject: 'Revert "merge CCSCRUM: the Scrum views read the work-item records (rev8 approve except F1)"', body: "This reverts commit 3d999ab.\n" },
	];
	const revertedBy = revertOf("3d999ab", log);
	assert.equal(revertedBy, "dbaea06", "the revert is found from the log alone");
	assert.equal(revertOf("3d999ab1234", log), "dbaea06", "a short sha in the message is the same commit");
	assert.equal(revertOf("990271f", log), undefined, "a commit nothing reverts has no revert");
	assert.match(mergeProblem({ commit: "3d999ab", onIntegrationBranch: true, patchPresent: false, revertedBy })!, /commit 3d999ab was reverted by dbaea06 and never re-landed/);
	assert.match(mergeProblem({ commit: "abc1234", onIntegrationBranch: false, patchPresent: false })!, /commit abc1234 is not on the integration branch/, "a commit left on a dropped branch never reached the board's branch");
	assert.equal(mergeProblem({ commit: "3d999ab", onIntegrationBranch: true, patchPresent: true }), undefined, "on the branch and not reverted is merged");

	withStore((store) => {
		recordIn(store, "done", { code: "CCSCRUM" });
		const reverted = authorities({ mergedCommit: () => ({ commit: "3d999ab", onIntegrationBranch: true, patchPresent: false, revertedBy }), liveApplies: () => false });
		const derivation = deriveWorkItemState(readWorkItem(store, "CCSCRUM")!, reverted);
		assert.equal(derivation.unproven, "commit 3d999ab was reverted by dbaea06 and never re-landed", "the board says why it is not merged");
		assert.match(workItemStateLine(derivation), /\[claimed, unproven: commit 3d999ab was reverted by dbaea06 and never re-landed\]/);
		assert.equal(driftCheck({ records: [readWorkItem(store, "CCSCRUM")!], authorities: reverted }).ok, false);
		assert.throws(
			() => moveWorkItem({ store, code: "CCSCRUM", target: "merged", context: OWNER, authorities: reverted }),
			/cannot be merged: commit 3d999ab was reverted by dbaea06 and never re-landed/,
			"a reverted merge cannot be typed back into fact",
		);
	});
});

// ─── (i) a claim never opens a gate ───────────────────────────────────────

test("(i) an after: gate stays open while the item it waits on is only claimed", () => {
	withStore((store) => {
		recordIn(store, "done", { code: "STEER-LAYER" });
		recordIn(store, "gated:after:STEER-LAYER", { code: "STEER-INTAKE" });
		const records = listWorkItems(store).items;
		const [gate] = gateStates({ records, authorities: authorities() });
		assert.equal(gate!.code, "STEER-INTAKE");
		assert.equal(gate!.satisfied, false, "a hand-typed done satisfies nothing");
		assert.match(gate!.because, /STEER-LAYER is done, only claimed: no merged commit on the integration branch closes it/);

		const drift = driftCheck({ records, authorities: authorities() });
		assert.equal(drift.ok, false);
		assert.ok(
			drift.mismatches.some((row) => row.code === "STEER-INTAKE" && /its gate is open/.test(row.because)),
			"the drift check reports the open gate",
		);

		const proven = authorities({ mergedCommit: (code) => (code === "STEER-LAYER" ? { commit: "7c1d2e3", onIntegrationBranch: true, patchPresent: true } : undefined) });
		assert.equal(gateStates({ records, authorities: proven }).find((entry) => entry.code === "STEER-INTAKE")!.satisfied, true, "evidence opens it");
		const settled = driftCheck({ records, authorities: proven });
		assert.equal(settled.mismatches.some((row) => row.code === "STEER-INTAKE"), false, "and the gate line is gone");
	});
});

test("(i) a gate on a code the store does not carry stays open and says so", () => {
	withStore((store) => {
		recordIn(store, "gated:after:PI-HOOKS", { code: "IDLE-ACTOR" });
		const [gate] = gateStates({ records: listWorkItems(store).items, authorities: authorities() });
		assert.equal(gate!.satisfied, false);
		assert.match(gate!.because, /no work item carries the code PI-HOOKS/);
	});
});

test("(g) rounds count the verdicts that sent it back, not the messages", () => {
	// Two findings from one review: two rows on one head, and that is one round.
	const oneRound: WorkItemReviewRow[] = [
		{ verdict: "fix", at: "2026-10-29T11:00:00.000Z", head: "aaa1111", reviewer: "mimo-v2.6-flash", reason: "the gate test does not prove the claim" },
		{ verdict: "fix", at: "2026-10-29T11:04:00.000Z", head: "aaa1111", reviewer: "mimo-v2.6-flash", reason: "and the drift line names no code" },
	];
	assert.equal(roundsOf(oneRound), 1, "two messages in one round are one round");
	const twoRounds: WorkItemReviewRow[] = [
		...oneRound,
		{ verdict: "fix", at: "2026-10-29T12:00:00.000Z", head: "bbb2222", reviewer: "mimo-v2.6-flash", reason: "the second pass still leaves the table stale" },
	];
	assert.equal(roundsOf(twoRounds), 2, "a second verdict on a new head is the second round");
	assert.equal(
		roundsOf([
			{ verdict: "fix", at: "2026-10-29T11:00:00.000Z", head: "ccc3333", round: 1 },
			{ verdict: "fix", at: "2026-10-29T11:05:00.000Z", head: "ccc3333", round: 1 },
			{ verdict: "fix", at: "2026-10-29T12:00:00.000Z", head: "ddd4444", round: 2 },
		]),
		2,
		"a round the reviewer numbers counts by that number",
	);
	assert.equal(roundsOf([{ verdict: "approve", at: "2026-10-29T11:00:00.000Z", head: "eee5555" }]), 0, "a pass is not a round");

	withStore((store) => {
		const launched = recordIn(store, "launched:sd-1a");
		const derivation = deriveWorkItemState(launched, authorities({ reviews: () => twoRounds }));
		assert.equal(derivation.label, "sent for fix");
		assert.equal(derivation.rounds, 2, "the record shows two rounds, not three messages");
		assert.equal(derivation.sentBackWhy, "the second pass still leaves the table stale", "and the newest round's reason");
	});
});

test("(h) a revert that was re-landed is merged: the branch's current state decides", () => {
	// CCSCRUM: 3d999ab merged, dbaea06 reverted it, and the change came back on main at bcfa046 (merge cc1).
	const reLand = { commit: "3d999ab", onIntegrationBranch: true, patchPresent: true, revertedBy: "dbaea06" };
	assert.equal(mergeProblem(reLand), undefined, "a change the branch carries is merged, whatever was undone in between");
	withStore((store) => {
		recordIn(store, "done", { code: "CCSCRUM" });
		const record = readWorkItem(store, "CCSCRUM")!;
		const reLanded = authorities({ mergedCommit: () => reLand, liveApplies: () => false });
		const derivation = deriveWorkItemState(record, reLanded);
		assert.equal(derivation.label, "done");
		assert.equal(derivation.unproven, undefined, "not unproven for good");
		assert.match(derivation.proof, /reverted by dbaea06 and re-landed/);
		assert.doesNotMatch(derivation.proof, /nothing reverted it/);
		assert.equal(driftCheck({ records: [record], authorities: reLanded }).ok, true);
		// The stored claim cannot restore it either way: only the branch's state decides.
		const standing = authorities({ mergedCommit: () => ({ ...reLand, patchPresent: false }), liveApplies: () => false });
		assert.equal(deriveWorkItemState(record, standing).unproven, "commit 3d999ab was reverted by dbaea06 and never re-landed");
	});
});

test("(i) every reason code is a gate, and says who or what it waits on", () => {
	withStore((store) => {
		recordIn(store, "gated:needs-operators-ok", { code: "G-OPERATOR" });
		recordIn(store, "gated:needs-decision", { code: "G-DECISION" });
		recordIn(store, "gated:needs-credential", { code: "G-CREDENTIAL" });
		recordIn(store, "gated:wrong-owner", { code: "G-OWNER" });
		recordIn(store, "gated:after:IDLE-METRIC", { code: "G-AFTER" });
		const records = listWorkItems(store).items;
		const gates = new Map(gateStates({ records, authorities: authorities() }).map((gate) => [gate.code, gate]));
		assert.deepEqual(
			[...gates.values()].map((gate) => [gate.code, gate.gate, gate.waitsOn, gate.satisfied]),
			[
				["G-AFTER", "after:IDLE-METRIC", "evidence", false],
				["G-CREDENTIAL", "needs-credential", "credential", false],
				["G-DECISION", "needs-decision", "decision", false],
				["G-OPERATOR", "needs-operators-ok", "operator", false],
				["G-OWNER", "wrong-owner", "another-owner", false],
			],
			"each code is a gate, with who it waits on",
		);
		assert.equal(gates.get("G-AFTER")!.target, "IDLE-METRIC");
		assert.match(gates.get("G-OPERATOR")!.because, /waits on the operator's own approval/);
		assert.equal(driftCheck({ records, authorities: authorities() }).ok, false, "G-AFTER waits on a record the store does not carry");
	});

	withStore((store) => {
		recordIn(store, "gated:needs-operators-ok", { code: "G-OPERATOR" });
		recordIn(store, "gated:needs-decision", { code: "G-DECISION" });
		recordIn(store, "gated:needs-credential", { code: "G-CREDENTIAL" });
		recordIn(store, "gated:wrong-owner", { code: "G-OWNER" });
		const records = listWorkItems(store).items;
		assert.equal(driftCheck({ records, authorities: authorities() }).ok, true, "waiting on a person is the board's normal state, not drift");
	});
});

test("(i) a free reason is a gate too, and says it names no code", () => {
	withStore((store) => {
		recordIn(store, "gated:parked", { code: "G-NOCODE" });
		const [gate] = gateStates({ records: listWorkItems(store).items, authorities: authorities() });
		assert.equal(gate!.gate, "parked");
		assert.equal(gate!.waitsOn, "code");
		assert.equal(gate!.satisfied, false);
		assert.match(gate!.because, /no reason code, so nobody can be named/);
	});
});

// ─── (j) a plan that carries the code under another name ──────────────────

test("(j) a plan naming WP-SL1 does not file SL1 as planned silently: the mapping gap is reported", () => {
	const plan = (codes: string[]) => authorities({ planCodesLike: (code) => codes.filter((other) => other !== code && other.endsWith(`-${code}`)) });
	withStore((store) => {
		recordIn(store, "idea", { code: "SL1" });
		const records = listWorkItems(store).items;
		const drift = driftCheck({ records, authorities: plan(["WP-SL1"]) });
		assert.equal(drift.ok, false, "a near-miss code is not a plan increment");
		assert.match(drift.mismatches[0]!.because, /the plan names WP-SL1 and not SL1, so the mapping to this record is not recorded/);
		const derivation = deriveWorkItemState(records[0]!, plan(["WP-SL1"]));
		assert.match(derivation.proof, /the plan names WP-SL1/, "the reader sees which code the plan carries");

		const mapped = authorities({ planIncrement: (code) => (code === "SL1" ? "WP-SL1" : undefined) });
		assert.equal(driftCheck({ records, authorities: mapped }).ok, true, "once the mapping is recorded, nothing is reported");
		assert.equal(deriveWorkItemState(records[0]!, mapped).label, "planned");
	});
});

// ─── (f) the readers every surface already uses ────────────────────────────

test("(f) every stored encoding the current writers write still validates and maps to one label", () => {
	const encodings: [string, string][] = [
		["draft", "planned"],
		["idea", "planned"],
		["ready", "queued"],
		["launch-uncertain", "in build"],
		["launched:sd-1a", "in build"],
		["done", "done"],
		["gated:parked", "gated"],
		["gated:dep:OL2", "gated"],
		["gated:wrong-owner", "gated"],
		["gated:live-record", "gated"],
		["dropped:replaced-by:PS-2", "dropped"],
	];
	for (const [state, label] of encodings) {
		assert.equal(isWorkItemState(state), true, `${state} stays a readable state`);
		assert.equal(workItemStateLabel(state), label, `${state} reads as ${label}`);
	}
	for (const label of WORK_ITEM_LABELS) assert.equal(isWorkItemState(label), true, `the label ${label} is a state`);
	assert.equal(workItemStateDetail("dropped:replaced-by:PS-2"), "replaced-by:PS-2", "a drop's reason reads back");
	assert.equal(isWorkItemState("preparing"), false, "a stranger is still refused");
});

test("(f) a store written in the dispatcher's and the backfill's own encodings still lists, reads and moves", () => {
	withStore((store) => {
		recordIn(store, "launched:sd-1a");
		recordIn(store, "gated:parked", { code: "SD-2" });
		recordIn(store, "idea", { code: "SD-3" });
		const listing = listWorkItems(store);
		assert.deepEqual(listing.items.map((item) => [item.code, item.state]), [
			["SD-1", "launched:sd-1a"],
			["SD-2", "gated:parked"],
			["SD-3", "idea"],
		]);
		assert.deepEqual(listing.skipped, []);
		assert.deepEqual(
			listing.items.map((item) => workItemStateLabel(item.state)),
			["in build", "gated", "planned"],
			"the board's label comes from the same record, without a second store",
		);
		const moved = setWorkItemState(store, "SD-3", "ready", OWNER);
		assert.equal(moved.state, "ready", "the dispatcher's own word still round-trips");
	});
});
