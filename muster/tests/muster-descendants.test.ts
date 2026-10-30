import "./muster-test-isolation.ts";
/**
 * Model-free regressions for P3 hierarchical workers: descendant writer
 * reservations in the one programme control record, lane dispatch that refuses
 * an overlapping reservation instead of letting sibling writers collide, and
 * join-before-offer for a persistent lane's bounded leaves (plan §7 P3, §3
 * "count actual active descendant writers against the programme ceiling").
 *
 * Pure store/policy tests: OS temp directories only, no network, no provider,
 * no Concord process and no model turns. The admission policy is driven
 * directly with a hand-built context and snapshot, so the already-wired
 * `tool_execute_admission` seam is exercised without a controller.
 *
 * Authored here; executed by the parent through the guarded runner.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	acceptDecompositionRevision, createMusterAdmissionPolicy, dispatchLaneWithDescendants, fileDecompositionStore, joinLaneBeforeOffer, proposeDecompositionRevision, reserveLaneDescendants, type MusterAdmissionContext, } from "../agile.ts";
import {
	descendantOwnerRef, laneOwnerRef, laneSessionRefForOwnerRef, leafDelegateIdForOwnerRef, leafOwnerRef, ownerKindForProgrammeContinuationOwner, parseDescendantOwnerRef, } from "../binding.ts";
import {
	DescendantReservationConflictError, DescendantReservationLimitError, MAX_DESCENDANT_RESERVATIONS, MAX_WRITER_CEILING, ProgrammeControlStateError, claimContinuation, completeContinuation, fileProgrammeControlStore, listDescendantReservations, releaseDescendantWriter, reserveDescendantWriter, startProgramme, type ProgrammeControlContext, } from "../control.ts";
import type { GrantTerms } from "../../core/programme.ts";
import { OperatingSnapshot } from "../../core/programme.ts";

const PROGRAMME_ID = "agp_0123456789ab";

type Fixture = {
	dir: string;
	ctx: ProgrammeControlContext;
};

function withControl(run: (fixture: Fixture) => void, options?: { ceiling?: number }): void {
	const dir = mkdtempSync(join(tmpdir(), "muster-descendants-"));
	const ctx: ProgrammeControlContext = {
		store: fileProgrammeControlStore(dir),
		killFilePath: join(dir, "muster.disabled"),
	};
	try {
		startProgramme(
			PROGRAMME_ID,
			{ operatorRef: "operator", ...(options?.ceiling !== undefined ? { ceiling: options.ceiling } : {}) },
			ctx,
		);
		run({ dir, ctx });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function controlError(code: ProgrammeControlStateError["code"], run: () => unknown): void {
	let caught: unknown;
	try {
		run();
	} catch (error) {
		caught = error;
	}
	if (!(caught instanceof ProgrammeControlStateError)) {
		assert.fail(
			`expected a ProgrammeControlStateError(${code}), got: ${caught === undefined ? "no error" : String(caught)}`,
		);
	}
	assert.equal(caught.code, code, caught.message);
}

function recordRevision(dir: string): number {
	return fileProgrammeControlStore(dir).read(PROGRAMME_ID)?.revision ?? -1;
}

function ownerRefs(fixture: Fixture): string[] {
	return listDescendantReservations(PROGRAMME_ID, fixture.ctx).map((row) => row.ownerRef);
}

// ─── Owner vocabulary (binding.ts) ───────────────────────────────────────────

test("muster-descendants: lane and leaf owner refs round-trip through the binding vocabulary", () => {
	assert.equal(laneOwnerRef("session-a"), "lane:session-a");
	assert.equal(leafOwnerRef("del-1"), "leaf:del-1");
	assert.equal(descendantOwnerRef("leaf", "del-2"), "leaf:del-2");
	assert.deepEqual(parseDescendantOwnerRef("lane:session-a"), { kind: "lane", id: "session-a" });
	assert.deepEqual(parseDescendantOwnerRef("leaf:del-1"), { kind: "leaf", id: "del-1" });
	// Anything outside the vocabulary fails closed instead of being coerced.
	assert.equal(parseDescendantOwnerRef("muster:session-a"), undefined);
	assert.equal(parseDescendantOwnerRef("lane:"), undefined);
	assert.equal(parseDescendantOwnerRef("lane:two words"), undefined);
	assert.equal(laneSessionRefForOwnerRef("lane:session-a"), "session-a");
	assert.equal(laneSessionRefForOwnerRef("leaf:del-1"), undefined);
	assert.equal(leafDelegateIdForOwnerRef("leaf:del-1"), "del-1");
	assert.equal(leafDelegateIdForOwnerRef("lane:session-a"), undefined);
	// Control-bridge continuation owners map onto the same two writer kinds.
	assert.equal(ownerKindForProgrammeContinuationOwner("muster"), "lane");
	assert.equal(ownerKindForProgrammeContinuationOwner("delegate"), "leaf");
	assert.throws(() => laneOwnerRef("   "), /non-empty/);
	assert.throws(() => leafOwnerRef(""), /non-empty/);
});

// ─── Reservations in the programme control record ────────────────────────────

test("muster-descendants: a lane reservation is persisted in the control record, listed and counts against the ceiling", () => {
	withControl((fixture) => {
		const lane = laneOwnerRef("session-lane-a");
		const commit = reserveDescendantWriter(
			PROGRAMME_ID,
			lane,
			"lane",
			["src/story/y.ts", "src/story/x.ts", "src/story/x.ts"],
			fixture.ctx,
		);
		assert.equal(commit.created, true);
		assert.deepEqual(commit.added, ["src/story/x.ts", "src/story/y.ts"], "duplicate files collapse and the set is canonical");
		assert.equal(commit.activeWriters, 1, "the descendant writer takes a writer slot from the same CAS");
		assert.equal(commit.descendantReservations, 1);
		assert.deepEqual(commit.reservation.files, ["src/story/x.ts", "src/story/y.ts"]);
		assert.equal(commit.reservation.kind, "lane");
		assert.ok(commit.reservation.reservedAt.length > 0);

		// A fresh store instance proves the row reached disk inside the same record.
		const stored = listDescendantReservations(PROGRAMME_ID, {
			store: fileProgrammeControlStore(fixture.dir),
		});
		assert.deepEqual(stored, [commit.reservation]);
		const raw = JSON.parse(readFileSync(join(fixture.dir, `${PROGRAMME_ID}.json`), "utf8")) as {
			reservedPaths?: unknown[];
		};
		assert.equal(raw.reservedPaths?.length, 1, "the reservation lives in the programme control record");

		// The descendant writer occupies one of the programme ceiling slots, so the
		// continuation capacity input sees the whole subtree.
		const slot = reserveDescendantWriter(
			PROGRAMME_ID,
			leafOwnerRef("delegate-1"),
			"leaf",
			["src/other/part.ts"],
			fixture.ctx,
		);
		assert.equal(slot.created, true);
		assert.equal(slot.activeWriters, 2);
	});
});

test("muster-descendants: re-reserving the same owner and covered files is idempotent", () => {
	withControl((fixture) => {
		const lane = laneOwnerRef("session-lane-a");
		const first = reserveDescendantWriter(PROGRAMME_ID, lane, "lane", ["src/story/x.ts"], fixture.ctx);
		const revision = recordRevision(fixture.dir);
		const again = reserveDescendantWriter(PROGRAMME_ID, lane, "lane", ["./src/story/x.ts"], fixture.ctx);
		assert.equal(again.created, false);
		assert.deepEqual(again.added, []);
		assert.deepEqual(again.reservation, first.reservation);
		assert.equal(recordRevision(fixture.dir), revision, "an identical re-reservation does not rewrite the record");
		assert.equal(ownerRefs(fixture).length, 1, "no duplicate rows");

		// A same-owner refinement below its own claim is covered, not conflicted.
		const covered = reserveDescendantWriter(PROGRAMME_ID, lane, "lane", ["src/story/x.ts/deeper.ts"], fixture.ctx);
		assert.deepEqual(covered.added, []);
		assert.deepEqual(covered.reservation.files, ["src/story/x.ts"]);

		// A genuinely new file extends the owner's claim in place.
		const extended = reserveDescendantWriter(PROGRAMME_ID, lane, "lane", ["src/story/z.ts"], fixture.ctx);
		assert.deepEqual(extended.added, ["src/story/z.ts"]);
		assert.deepEqual(extended.reservation.files, ["src/story/x.ts", "src/story/z.ts"]);
		assert.equal(ownerRefs(fixture).length, 1);
		assert.equal(extended.activeWriters, 1);
	});
});

test("muster-descendants: an overlapping reservation from another owner is a typed conflict naming both and the files", () => {
	withControl((fixture) => {
		const lane = laneOwnerRef("session-lane-a");
		const leaf = leafOwnerRef("delegate-1");
		reserveDescendantWriter(PROGRAMME_ID, lane, "lane", ["src/story"], fixture.ctx);

		let caught: unknown;
		try {
			reserveDescendantWriter(PROGRAMME_ID, leaf, "leaf", ["src/story/x.ts", "src/other.ts"], fixture.ctx);
		} catch (error) {
			caught = error;
		}
		if (!(caught instanceof DescendantReservationConflictError)) {
			assert.fail(`expected a DescendantReservationConflictError, got: ${String(caught)}`);
		}
		assert.equal(caught.code, "descendant-conflict");
		assert.equal(caught.ownerRef, leaf);
		assert.equal(caught.conflictingOwnerRef, lane);
		assert.deepEqual(caught.files, ["src/story/x.ts"], "only the contested files are named");
		assert.match(caught.message, /lane:session-lane-a/);

		// The refused reservation left no row and no writer slot behind.
		assert.deepEqual(ownerRefs(fixture), [lane]);
		assert.equal(recordRevision(fixture.dir), 2, "the refused reservation did not rewrite the record");
	});
});

test("muster-descendants: release clears exactly the named owner and frees its writer slot", () => {
	withControl((fixture) => {
		const lane = laneOwnerRef("session-lane-a");
		const leaf = leafOwnerRef("delegate-1");
		reserveDescendantWriter(PROGRAMME_ID, lane, "lane", ["src/a.ts"], fixture.ctx);
		reserveDescendantWriter(PROGRAMME_ID, leaf, "leaf", ["src/b.ts"], fixture.ctx);

		assert.deepEqual(releaseDescendantWriter(PROGRAMME_ID, leaf, fixture.ctx), {
			released: true,
			activeWriters: 1,
			descendantReservations: 1,
		});
		assert.deepEqual(ownerRefs(fixture), [lane]);
		assert.deepEqual(
			releaseDescendantWriter(PROGRAMME_ID, leaf, fixture.ctx),
			{ released: false, activeWriters: 1, descendantReservations: 1 },
			"releasing an unreserved owner is an idempotent no-op",
		);
		// The freed slot is available again: a third writer would now fit under the
		// pilot ceiling.
		assert.equal(
			reserveDescendantWriter(PROGRAMME_ID, leafOwnerRef("delegate-2"), "leaf", ["src/c.ts"], fixture.ctx).activeWriters,
			2,
		);
	});
});

test("muster-descendants: invalid paths, empty files and mismatched owner kinds are refused before any write", () => {
	withControl((fixture) => {
		const lane = laneOwnerRef("session-lane-a");
		controlError("io", () => reserveDescendantWriter(PROGRAMME_ID, lane, "lane", ["/absolute/file.ts"], fixture.ctx));
		controlError("io", () => reserveDescendantWriter(PROGRAMME_ID, lane, "lane", ["../escape.ts"], fixture.ctx));
		controlError("io", () => reserveDescendantWriter(PROGRAMME_ID, lane, "lane", ["src\\windows.ts"], fixture.ctx));
		controlError("io", () => reserveDescendantWriter(PROGRAMME_ID, lane, "lane", [], fixture.ctx));
		controlError("io", () => reserveDescendantWriter(PROGRAMME_ID, lane, "leaf", ["src/a.ts"], fixture.ctx));
		controlError("io", () => reserveDescendantWriter(PROGRAMME_ID, "not-an-owner", "lane", ["src/a.ts"], fixture.ctx));
		controlError("io", () => releaseDescendantWriter(PROGRAMME_ID, "  ", fixture.ctx));
		controlError("missing", () => listDescendantReservations("agp_ffffffffffff", fixture.ctx));
		controlError("io", () => listDescendantReservations("not-a-programme", fixture.ctx));
		assert.deepEqual(listDescendantReservations(PROGRAMME_ID, fixture.ctx), [], "a refused call writes nothing");
		assert.equal(recordRevision(fixture.dir), 1);
	});
});

test("muster-descendants: the writer ceiling and the bounded row cap are typed limits", () => {
	const ceilingDir = mkdtempSync(join(tmpdir(), "muster-descendants-ceiling-"));
	const ceilingCtx: ProgrammeControlContext = {
		store: fileProgrammeControlStore(ceilingDir),
		killFilePath: join(ceilingDir, "muster.disabled"),
	};
	try {
		startProgramme(PROGRAMME_ID, { operatorRef: "operator", ceiling: 2 }, ceilingCtx);
		reserveDescendantWriter(PROGRAMME_ID, laneOwnerRef("session-lane-a"), "lane", ["src/a"], ceilingCtx);
		reserveDescendantWriter(PROGRAMME_ID, laneOwnerRef("session-lane-b"), "lane", ["src/b"], ceilingCtx);
		let caught: unknown;
		try {
			reserveDescendantWriter(PROGRAMME_ID, leafOwnerRef("delegate-c1"), "leaf", ["src/c"], ceilingCtx);
		} catch (error) {
			caught = error;
		}
		if (!(caught instanceof DescendantReservationLimitError)) {
			assert.fail(`expected a DescendantReservationLimitError, got: ${String(caught)}`);
		}
		assert.equal(caught.code, "descendant-limit");
		assert.equal(caught.limit, "writers");
		assert.equal(caught.limitValue, 2);
		assert.equal(caught.activeWriters, 2);
		// A lane that already holds a slot may still extend its own files at the cap.
		assert.deepEqual(
			reserveDescendantWriter(PROGRAMME_ID, laneOwnerRef("session-lane-a"), "lane", ["src/other.ts"], ceilingCtx).added,
			["src/other.ts"],
		);
	} finally {
		rmSync(ceilingDir, { recursive: true, force: true });
	}

	withControl((fixture) => {
		for (let index = 0; index < MAX_DESCENDANT_RESERVATIONS; index += 1) {
			reserveDescendantWriter(PROGRAMME_ID, leafOwnerRef(`delegate-${index}`), "leaf", [`src/f${index}.ts`], fixture.ctx);
		}
		let caught: unknown;
		try {
			reserveDescendantWriter(PROGRAMME_ID, leafOwnerRef("delegate-overflow"), "leaf", ["src/overflow.ts"], fixture.ctx);
		} catch (error) {
			caught = error;
		}
		if (!(caught instanceof DescendantReservationLimitError)) {
			assert.fail(`expected a DescendantReservationLimitError, got: ${String(caught)}`);
		}
		assert.equal(caught.limit, "reservations");
		assert.equal(caught.limitValue, MAX_DESCENDANT_RESERVATIONS);
		assert.equal(caught.descendantReservations, MAX_DESCENDANT_RESERVATIONS);
		assert.equal(listDescendantReservations(PROGRAMME_ID, fixture.ctx).length, MAX_DESCENDANT_RESERVATIONS);
	}, { ceiling: MAX_WRITER_CEILING });
});

// ─── Dispatch guard ──────────────────────────────────────────────────────────

test("muster-descendants: a dispatch-time conflict refuses the lane without dispatching it", () => {
	withControl((fixture) => {
		const dispatched: string[] = [];
		const first = dispatchLaneWithDescendants({
			programmeId: PROGRAMME_ID,
			laneOwnerRef: laneOwnerRef("session-lane-a"),
			files: ["src/story"],
			control: fixture.ctx,
			dispatch: () => {
				dispatched.push("lane-a");
				return { allow: true };
			},
		});
		assert.equal(first.outcome, "dispatched");
		assert.deepEqual(dispatched, ["lane-a"]);

		const conflicting = dispatchLaneWithDescendants({
			programmeId: PROGRAMME_ID,
			laneOwnerRef: laneOwnerRef("session-lane-b"),
			files: ["src/story/feature.ts"],
			control: fixture.ctx,
			decide: () => ({ allow: true }),
			dispatch: () => {
				dispatched.push("lane-b");
				return { allow: true };
			},
		});
		assert.equal(conflicting.outcome, "refused");
		assert.deepEqual(dispatched, ["lane-a"], "the conflicting lane is never dispatched");
		if (conflicting.outcome !== "refused") return;
		assert.equal(conflicting.decision.code, "shared_writer_conflict");
		assert.match(conflicting.decision.detail, /lane:session-lane-b/);
		assert.match(conflicting.decision.detail, /lane:session-lane-a/);
		assert.match(conflicting.decision.detail, /src\/story\/feature\.ts/);
		assert.deepEqual(ownerRefs(fixture), ["lane:session-lane-a"]);

		// An ordinary dispatch refusal comes before any reservation: a refused lane
		// leaves the store untouched.
		const ordinary = dispatchLaneWithDescendants({
			programmeId: PROGRAMME_ID,
			laneOwnerRef: laneOwnerRef("session-lane-c"),
			files: ["src/lane-c"],
			control: fixture.ctx,
			decide: () => ({
				allow: false,
				reason: "task_not_active",
				code: "dependency_not_satisfied",
				detail: "t_other is not complete",
			}),
			dispatch: () => {
				dispatched.push("lane-c");
				return { allow: true };
			},
		});
		assert.equal(ordinary.outcome, "refused");
		assert.deepEqual(dispatched, ["lane-a"]);
		assert.deepEqual(ownerRefs(fixture), ["lane:session-lane-a"]);

		// A dispatch callback that refuses after a fresh reservation drops it again.
		const lateRefusal = dispatchLaneWithDescendants({
			programmeId: PROGRAMME_ID,
			laneOwnerRef: laneOwnerRef("session-lane-d"),
			files: ["src/lane-d"],
			control: fixture.ctx,
			dispatch: () => ({
				allow: false,
				reason: "wrong_owner",
				code: "task_owned_by_another_agent",
				detail: "someone else owns it",
			}),
		});
		assert.equal(lateRefusal.outcome, "refused");
		assert.deepEqual(ownerRefs(fixture), ["lane:session-lane-a"]);
	});
});

// ─── Join-before-offer ───────────────────────────────────────────────────────

test("muster-descendants: an offer is held while a leaf is outstanding and admitted once it settles", () => {
	withControl((fixture) => {
		const lane = laneOwnerRef("session-lane-a");
		const leafOne = leafOwnerRef("delegate-1");
		const leafTwo = leafOwnerRef("delegate-2");
		reserveDescendantWriter(PROGRAMME_ID, lane, "lane", ["src/story"], fixture.ctx);
		reserveDescendantWriter(PROGRAMME_ID, leafOne, "leaf", ["src/story/one.ts"], fixture.ctx, { parentOwnerRef: lane });
		reserveDescendantWriter(PROGRAMME_ID, leafTwo, "leaf", ["src/story/two.ts"], fixture.ctx, { parentOwnerRef: lane });

		const held = joinLaneBeforeOffer({
			programmeId: PROGRAMME_ID,
			laneOwnerRef: lane,
			settledLeafOwnerRefs: [],
			control: fixture.ctx,
		});
		assert.equal(held.allow, false);
		if (held.allow) return;
		assert.equal(held.code, "descendants_outstanding");
		assert.deepEqual(held.outstanding, [leafOne, leafTwo]);
		assert.equal(listDescendantReservations(PROGRAMME_ID, fixture.ctx).length, 3, "a hold changes nothing on disk");

		const stillHeld = joinLaneBeforeOffer({
			programmeId: PROGRAMME_ID,
			laneOwnerRef: lane,
			settledLeafOwnerRefs: [leafOne],
			control: fixture.ctx,
		});
		assert.equal(stillHeld.allow, false);
		if (!stillHeld.allow) assert.deepEqual(stillHeld.outstanding, [leafTwo]);

		const admitted = joinLaneBeforeOffer({
			programmeId: PROGRAMME_ID,
			laneOwnerRef: lane,
			settledLeafOwnerRefs: [leafOne, leafTwo],
			control: fixture.ctx,
		});
		assert.equal(admitted.allow, true);
		if (!admitted.allow) return;
		assert.deepEqual(admitted.joinedLeafOwnerRefs, [leafOne, leafTwo]);
		assert.equal(admitted.released, true);
		assert.match(admitted.note ?? "", /descendants settled first: leaf:delegate-1, leaf:delegate-2/);
		// Offer emit released the lane's own reservation; leaf rows are released by
		// their own settlement path.
		assert.deepEqual(ownerRefs(fixture).sort(), [leafOne, leafTwo]);
		releaseDescendantWriter(PROGRAMME_ID, leafOne, fixture.ctx);
		releaseDescendantWriter(PROGRAMME_ID, leafTwo, fixture.ctx);
		assert.deepEqual(listDescendantReservations(PROGRAMME_ID, fixture.ctx), []);
	});
});

test("muster-descendants: join-before-offer ignores another lane's outstanding leaves", () => {
	withControl((fixture) => {
		const laneA = laneOwnerRef("session-lane-a");
		const laneB = laneOwnerRef("session-lane-b");
		reserveDescendantWriter(PROGRAMME_ID, laneA, "lane", ["src/story-a"], fixture.ctx);
		reserveDescendantWriter(PROGRAMME_ID, laneB, "lane", ["src/story-b"], fixture.ctx);
		reserveDescendantWriter(PROGRAMME_ID, leafOwnerRef("delegate-b1"), "leaf", ["src/story-b/part.ts"], fixture.ctx, { parentOwnerRef: laneB });

		const gate = joinLaneBeforeOffer({
			programmeId: PROGRAMME_ID,
			laneOwnerRef: laneA,
			settledLeafOwnerRefs: [],
			control: fixture.ctx,
		});
		assert.equal(gate.allow, true, gate.allow ? "" : gate.detail);
		if (!gate.allow) return;
		assert.deepEqual(gate.joinedLeafOwnerRefs, [], "lane B's leaf is not attributed to lane A");
		assert.equal(gate.released, true);
		assert.equal(gate.note, undefined);
		// Lane A is released; lane B and its leaf keep their claims.
		assert.deepEqual(ownerRefs(fixture).sort(), [laneB, "leaf:delegate-b1"].sort());
	});
});

// ─── Programme end and unreadable state ──────────────────────────────────────

test("muster-descendants: programme completion makes reservations moot but leaves them readable", () => {
	withControl((fixture) => {
		const lane = laneOwnerRef("session-lane-a");
		reserveDescendantWriter(PROGRAMME_ID, lane, "lane", ["src/story"], fixture.ctx);
		const claim = claimContinuation(PROGRAMME_ID, "session-parent", fixture.ctx);
		if (claim.outcome !== "admitted") assert.fail("expected an admitted continuation claim");
		assert.equal(completeContinuation(PROGRAMME_ID, claim.claimId, "completed", fixture.ctx).status, "off");

		// No release requirement: the rows stay on disk for inspection.
		assert.deepEqual(listDescendantReservations(PROGRAMME_ID, fixture.ctx).map((row) => row.ownerRef), [lane]);
		assert.deepEqual(claimContinuation(PROGRAMME_ID, "session-parent", fixture.ctx), {
			outcome: "denied",
			reason: "programme-off",
		});
		// A post-completion release still works; it is cleanup, not a prerequisite.
		assert.equal(releaseDescendantWriter(PROGRAMME_ID, lane, fixture.ctx).released, true);
		assert.deepEqual(listDescendantReservations(PROGRAMME_ID, fixture.ctx), []);
	});
});

test("muster-descendants: an unreadable control record fails the reservation closed; a missing one reserves nothing", () => {
	withControl((fixture) => {
		writeFileSync(join(fixture.dir, `${PROGRAMME_ID}.json`), "{ not json", "utf8");
		const malformed = reserveLaneDescendants({
			programmeId: PROGRAMME_ID,
			laneOwnerRef: laneOwnerRef("session-lane-a"),
			files: ["src/story"],
			control: fixture.ctx,
		});
		assert.equal(malformed.allow, false);
		if (!malformed.allow) assert.equal(malformed.code, "state_io");

		// A missing record means the session is not enrolled: nothing to reserve and
		// no refusal (today's behaviour is preserved).
		const missing = reserveLaneDescendants({
			programmeId: "agp_ffffffffffff",
			laneOwnerRef: laneOwnerRef("session-lane-a"),
			files: ["src/story"],
			control: fixture.ctx,
		});
		assert.deepEqual(missing, {
			allow: true,
			reserved: false,
			created: false,
			ownerRef: laneOwnerRef("session-lane-a"),
			files: [],
			added: [],
			activeWriters: 0,
		});
		// No programme/lane identity (non-enrolled session) also reserves nothing.
		assert.deepEqual(
			reserveLaneDescendants({ files: ["src/story"], control: fixture.ctx }),
			{ allow: true, reserved: false, created: false, ownerRef: "", files: [], added: [], activeWriters: 0 },
		);
	});
});

// ─── Admission-policy integration (the already-wired dispatch/offer seam) ────

const CONDITION = { id: "sc_p3", statement: "the story files exist", evidence: "focused check" };

function task(input: { taskId: string; files: string[]; agentId: string }): Record<string, unknown> {
	return {
		taskId: input.taskId,
		title: `Work ${input.taskId}`,
		kind: "implementation",
		outcome: `${input.taskId} is implemented`,
		acceptanceExamples: ["the declared files change"],
		evidence: { references: input.files, assumptions: [] },
		scope: { repository: "agent", files: input.files, exclusions: [], readOnly: false },
		dependencies: [],
		ownership: { intendedRole: "worker", assignedAgentId: input.agentId, reviewer: "parent", writes: input.files },
		verification: { checks: ["focused check"], actor: "parent", handoffContract: "muster six-label handoff" },
		successConditions: ["sc_p3"],
	};
}

function acceptedDecomposition(dir: string) {
	const store = fileDecompositionStore(join(dir, "decompositions"));
	const proposed = proposeDecompositionRevision(store, {
		programmeId: PROGRAMME_ID,
		proposal: {
			schemaVersion: 1,
			programmeId: PROGRAMME_ID,
			incrementId: "inc_p3",
			goal: "Hierarchical story work",
			successConditions: [CONDITION],
			tasks: [
				task({ taskId: "t_build_a", files: ["src/story-a"], agentId: "pi-worker-a" }),
				task({ taskId: "t_build_b", files: ["src/story-b"], agentId: "pi-worker-b" }),
			],
			proposedBy: "parent-agent",
		},
	});
	if (!proposed.ok) assert.fail(`proposal rejected: ${proposed.detail}`);
	const accepted = acceptDecompositionRevision(store, {
		programmeId: PROGRAMME_ID,
		expectedRevision: proposed.state.revision,
		review: {
			kind: "independent-planning",
			reviewerAgentId: "pi-reviewer",
			laneReference: "herdr-review-1",
			readOnly: true,
			disposition: "accepted",
		},
	});
	if (!accepted.ok) assert.fail(`acceptance rejected: ${accepted.detail}`);
	return store;
}

const GRANT: GrantTerms = {
	outcome: "hierarchical story work",
	repositories: [{ name: "agent", path: "/tmp/p3-agent" }],
	nonGoals: [],
	backlogSource: { kind: "approved-plan", reference: "local:p3" },
	authorizedWork: ["implementation"],
	excludedExternalOperations: [],
	acceptanceThreshold: "the focused check accepts the story",
	initialIncrement: { title: "P3", sprintGoal: "hierarchical story work" },
	parentReviewer: { parent: "Pi parent", reviewer: "independent review lane" },
};

function workerContext(input: {
	store: ReturnType<typeof fileDecompositionStore>;
	agentId: string;
	sessionRef: string;
	taskId: string;
	control: ProgrammeControlContext;
	settledLeaves?: () => readonly string[];
}): MusterAdmissionContext {
	return {
		role: () => "worker",
		agentId: () => input.agentId,
		grant: () => GRANT,
		decomposition: () => input.store.read(PROGRAMME_ID),
		currentWriteTaskId: () => input.taskId,
		resolveTarget: () => undefined,
		taskStates: () => ({
			[input.taskId]: {
				status: "active",
				version: 1,
				agentId: input.agentId,
				assignedAgentId: input.agentId,
			},
		}),
		currentOwners: () => ({ [input.taskId]: input.agentId }),
		capacity: () => undefined,
		descendants: () => ({
			laneOwnerRef: () => laneOwnerRef(input.sessionRef),
			settledLeafOwnerRefs: input.settledLeaves ?? (() => []),
			control: input.control,
		}),
	};
}

function workerSnapshot(): OperatingSnapshot {
	return { mode: "agile", revision: 2, phase: "active", role: "worker", programmeId: PROGRAMME_ID };
}

test("muster-descendants: a lane's muster_start reserves its declared subtree files before dispatch", () => {
	withControl((fixture) => {
		const store = acceptedDecomposition(fixture.dir);
		const policy = createMusterAdmissionPolicy(
			workerContext({
				store,
				agentId: "pi-worker-a",
				sessionRef: "session-lane-a",
				taskId: "t_build_a",
				control: fixture.ctx,
			}),
		);
		const decision = policy({ toolName: "muster_start", origin: "model", args: { task_id: "t_build_a" } }, workerSnapshot());
		assert.equal(decision.allow, true, decision.allow ? "" : decision.detail);
		const rows = listDescendantReservations(PROGRAMME_ID, fixture.ctx);
		assert.deepEqual(rows.map((row) => row.ownerRef), [laneOwnerRef("session-lane-a")]);
		assert.deepEqual(rows[0].files, ["src/story-a"]);
	});
});

test("muster-descendants: the policy refuses a lane start whose subtree files are already reserved", () => {
	withControl((fixture) => {
		const store = acceptedDecomposition(fixture.dir);
		// A child of lane A expanded its subtree into lane B's planned file set.
		reserveDescendantWriter(PROGRAMME_ID, leafOwnerRef("delegate-a1"), "leaf", ["src/story-b"], fixture.ctx);
		const policy = createMusterAdmissionPolicy(
			workerContext({
				store,
				agentId: "pi-worker-b",
				sessionRef: "session-lane-b",
				taskId: "t_build_b",
				control: fixture.ctx,
			}),
		);
		const decision = policy({ toolName: "muster_start", origin: "model", args: { task_id: "t_build_b" } }, workerSnapshot());
		if (decision.allow) assert.fail("a lane start overlapping another owner's reservation must be refused");
		assert.match(decision.detail, /shared_writer_conflict/);
		assert.match(decision.detail, /leaf:delegate-a1/);
		assert.match(decision.detail, /src\/story-b/);
		// The refused lane was never dispatched and the conflicting child is intact.
		assert.deepEqual(ownerRefs(fixture), ["leaf:delegate-a1"]);
	});
});

test("muster-descendants: the policy holds a lane offer until its leaves settle, then releases the lane row", () => {
	withControl((fixture) => {
		const store = acceptedDecomposition(fixture.dir);
		const lane = laneOwnerRef("session-lane-a");
		const leaf = leafOwnerRef("delegate-a1");
		reserveDescendantWriter(PROGRAMME_ID, lane, "lane", ["src/story-a"], fixture.ctx);
		reserveDescendantWriter(PROGRAMME_ID, leaf, "leaf", ["src/story-a/part.ts"], fixture.ctx, { parentOwnerRef: lane });
		const settled: string[] = [];
		const policy = createMusterAdmissionPolicy(
			workerContext({
				store,
				agentId: "pi-worker-a",
				sessionRef: "session-lane-a",
				taskId: "t_build_a",
				control: fixture.ctx,
				settledLeaves: () => settled,
			}),
		);
		const offer = {
			task_id: "t_build_a",
			action: "offer",
			to_agent_id: "pi-parent",
			expected_version: 1,
			what_changed: "implemented the story",
			changed_files: ["src/story-a/part.ts"],
		};
		const held = policy({ toolName: "muster_transfer", origin: "model", args: offer }, workerSnapshot());
		if (held.allow) assert.fail("an offer with an outstanding leaf must be held");
		assert.match(held.detail, /descendants_outstanding/);
		assert.match(held.detail, /leaf:delegate-a1/);
		assert.equal(listDescendantReservations(PROGRAMME_ID, fixture.ctx).length, 2, "the hold released nothing");

		settled.push(leaf);
		const admitted = policy({ toolName: "muster_transfer", origin: "model", args: offer }, workerSnapshot());
		assert.equal(admitted.allow, true, admitted.allow ? "" : admitted.detail);
		// Offer emit released the lane's own reservation; the leaf row is released by
		// its own settlement path.
		assert.deepEqual(ownerRefs(fixture), [leaf]);
		releaseDescendantWriter(PROGRAMME_ID, leaf, fixture.ctx);
		assert.deepEqual(listDescendantReservations(PROGRAMME_ID, fixture.ctx), []);
	});
});

test("muster-descendants: without descendant hooks the policy behaves exactly as before", () => {
	withControl((fixture) => {
		const store = acceptedDecomposition(fixture.dir);
		const context = workerContext({
			store,
			agentId: "pi-worker-a",
			sessionRef: "session-lane-a",
			taskId: "t_build_a",
			control: fixture.ctx,
		});
		delete context.descendants;
		const policy = createMusterAdmissionPolicy(context);
		const decision = policy({ toolName: "muster_start", origin: "model", args: { task_id: "t_build_a" } }, workerSnapshot());
		assert.equal(decision.allow, true, decision.allow ? "" : decision.detail);
		assert.deepEqual(listDescendantReservations(PROGRAMME_ID, fixture.ctx), [], "no hook → no control-store write");
	});
});
