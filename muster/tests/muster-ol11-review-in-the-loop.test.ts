import "./muster-test-isolation.ts";
/**
 * OL11 R2 (spec Revision 3, §9 "Review verdicts", §10 row OL11; VR24-225 R2, VR24-229 item 5): a review is a
 * work item in the loop.
 *
 *   1. A review item is created from an item code: it carries the author's family, the parent's family and the
 *      reviewer's family: author DeepSeek with parent MiniMax gives mimo, and a DeepSeek pair gives mimo too.
 *   2. An identity whose model names none of the three families is refused, and the refusal names the identity
 *      it could not read (the parent's in the fixture).
 *   3. The reviewer family differs from both: the record refuses a reviewer on the author's or the parent's
 *      family, and the dispatcher holds such an item instead of launching it.
 *   4. `review-mode` starts `risky-only` and turns `every-lane` after a week of verdicts; the file's own word is
 *      the rollback. `every-lane` makes an offer with no independent verdict `needs-review`.
 *   5. The merge queue records the verdict and the lane card reads it: a recorded verdict for a lane's offer
 *      reaches `buildLaneCard`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { attachProgramme, fileProgrammeControlStore, recordReviewVerdict, recordTaskOffer, type ProgrammeControlContext } from "../control.ts";
import { readyItems, reviewFamilyHeld, type DispatchItem } from "../dispatch.ts";
import { buildLaneCard } from "../lane-card.ts";
import {
	integrationDecision,
	integrationRefusalText,
	parseReviewMode,
	resolveReviewMode,
	reviewMarkForLane,
	type ReviewVerdict,
} from "../merge-queue.ts";
import {
	buildReviewWorkItem,
	chooseReviewFamily,
	REVIEW_CANDIDATE_FAMILIES,
	REVIEW_RESOLVING_FAMILIES,
	createReviewWorkItem,
	fileWorkItemStore,
	listWorkItems,
	reviewFamilyOf,
	reviewItemCode,
	validateWorkItemRecord,
	WorkItemStateError,
	type ReviewActorIdentity,
	type ReviewedItem,
} from "../work-items.ts";

const DAY_MS = 24 * 60 * 60_000;
const NOW = Date.parse("2026-10-29T00:00:00.000Z");
const WHEN = new Date(NOW).toISOString();

const ITEM: ReviewedItem = {
	code: "OL11",
	heading: "Review in the loop",
	goal: "out-loop",
	project: "muster",
	class: "H3",
	harness: "pi",
	ownedPaths: ["muster/work-items.ts", "muster/dispatch.ts"],
};

const DEEPSEEK: ReviewActorIdentity = { sessionId: "pi-author", model: "deepseek/deepseek-v4.1-flash" };
const MINIMAX: ReviewActorIdentity = { sessionId: "pi-parent", model: "minimax/m3.1-flash" };

const reviewInput = (over: Partial<{ parent: ReviewActorIdentity | undefined; author: ReviewActorIdentity | undefined }> = {}) =>
	buildReviewWorkItem({ item: ITEM, author: DEEPSEEK, parent: MINIMAX, ...over }, { by: "orchestrator", at: WHEN });

function withStore(run: (dir: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "muster-ol11-review-"));
	try {
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

// ─── The family choice ───────────────────────────────────────────────────────

test("a review item is created from an item code, and DeepSeek author with MiniMax parent gives mimo", () => {
	assert.equal(reviewFamilyOf("deepseek/deepseek-v4.1-flash"), "deepseek");
	assert.equal(reviewFamilyOf("MiniMax/M3.1-Flash"), "minimax");
	assert.equal(reviewFamilyOf("opencode-go/mimo-v2.6-flash"), "mimo");
	assert.equal(reviewFamilyOf("opencode/glm-5.3-flash-free"), "glm", "the free Zen label is a family, and a candidate that cannot serve a Pi lane");
	assert.equal(reviewFamilyOf("xai/grok-4.6"), undefined, "a family is never guessed");
	assert.equal(chooseReviewFamily("deepseek", "minimax"), "mimo", "MiniMax is the parent, so mimo reviews");
	assert.deepEqual(REVIEW_CANDIDATE_FAMILIES, ["mimo", "glm"], "the candidates are mimo and the free Zen GLM label");
	assert.deepEqual(REVIEW_RESOLVING_FAMILIES, ["mimo"], "only mimo can serve a Pi lane here");
	assert.ok(!(REVIEW_CANDIDATE_FAMILIES as readonly string[]).includes("deepseek"), "DeepSeek never reviews");
	assert.throws(() => chooseReviewFamily("deepseek", "mimo"), /no independent reviewer family available/);

	const input = reviewInput();
	assert.equal(input.code, reviewItemCode("OL11"));
	assert.equal(input.code, "REVIEW-OL11");
	assert.equal(input.kind, "review");
	assert.deepEqual(input.review, { author: "deepseek", parent: "minimax", reviewer: "mimo" });
	assert.equal(input.state, "ready");
	assert.deepEqual(input.dependencies, []);
	assert.match(input.heading, /^Review OL11:/);
	assert.match(input.acceptance, /mimo verdict for OL11/);

	withStore((root) => {
		const store = fileWorkItemStore(join(root, "work-items"));
		const record = createReviewWorkItem(store, { item: ITEM, author: DEEPSEEK, parent: MINIMAX }, { by: "orchestrator", at: WHEN });
		assert.equal(record.kind, "review");
		assert.deepEqual(record.review, { author: "deepseek", parent: "minimax", reviewer: "mimo" });
		assert.equal(record.state, "ready");
		assert.equal(listWorkItems(store).items.length, 1, "the review is one item in the one registry");
	});
});

test("DeepSeek author and DeepSeek parent give mimo, the live lane model", () => {
	// the operator's ruling (2026-10-29 00:23, relayed by Henry): MiniMax or mimo reviews; with both DeepSeek, mimo runs.
	const shared = chooseReviewFamily("deepseek", "deepseek");
	assert.equal(shared, "mimo");
	assert.equal(shared, chooseReviewFamily("deepseek", "deepseek"), "the same inputs give the same family");
	assert.equal(chooseReviewFamily("minimax", "minimax"), "mimo", "only mimo is left for a MiniMax pair");
	assert.throws(() => chooseReviewFamily("mimo", "mimo"), /no independent reviewer family available/, "the GLM label is the only family left and it cannot serve a Pi lane");
	assert.throws(() => chooseReviewFamily("mimo", "deepseek"), /glm, .*does not resolve/, "the refusal says why the one family left cannot run");

	const input = buildReviewWorkItem({ item: ITEM, author: DEEPSEEK, parent: { ...DEEPSEEK, sessionId: "pi-parent" } }, { by: "orchestrator", at: WHEN });
	assert.deepEqual(input.review, { author: "deepseek", parent: "deepseek", reviewer: "mimo" });
});

test("no independent reviewer family is a refusal, not a same-family review", () => {
	assert.throws(() => chooseReviewFamily("minimax", "mimo"), /no independent reviewer family available/);
	try {
		buildReviewWorkItem(
			{ item: ITEM, author: { sessionId: "pi-a", model: "minimax/m3.1-flash" }, parent: { sessionId: "pi-p", model: "opencode-go/mimo-v2.6-flash" } },
			{ by: "orchestrator", at: WHEN },
		);
		assert.fail("a review with no family left to review it must be refused");
	} catch (error) {
		assert.ok(error instanceof WorkItemStateError);
		assert.match((error as WorkItemStateError).message, /review item REVIEW-OL11 is refused: no independent reviewer family available/);
		assert.match((error as WorkItemStateError).message, /the author is minimax and the parent mimo/);
	}
});

// ─── The refusal ────────────────────────────────────────────────────────────

test("an unreadable parent identity is named in the refusal rather than silently passing", () => {
	const refusal = (parent: ReviewActorIdentity | undefined) => {
		try {
			reviewInput({ parent });
			assert.fail("a review must not open without a readable parent identity");
		} catch (error) {
			assert.ok(error instanceof WorkItemStateError, "the refusal is the registry's own error");
			return (error as WorkItemStateError).message;
		}
	};
	const unreadable = refusal({ sessionId: "pi-boss", model: "xai/grok-4.6" });
	assert.match(unreadable, /parent identity could not be read/);
	assert.match(unreadable, /xai\/grok-4\.6/, "the refusal names the identity it read");
	assert.match(unreadable, /deepseek, mimo, glm, minimax/);

	const missing = refusal(undefined);
	assert.match(missing, /the parent identity could not be read: no identity was given/);

	const author = (() => {
		try {
			reviewInput({ author: { sessionId: "pi-author", model: "" } });
			return "";
		} catch (error) {
			return (error as WorkItemStateError).message;
		}
	})();
	assert.match(author, /author identity could not be read/);
});

// ─── The record and the dispatcher ──────────────────────────────────────────

function reviewRecord(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
	return {
		schemaVersion: 1,
		revision: 1,
		code: "REVIEW-OL11",
		heading: "Review OL11: review in the loop",
		summary: "an independent review",
		goal: "out-loop",
		project: "muster",
		kind: "review",
		class: "H3",
		harness: "pi",
		review: { author: "deepseek", parent: "minimax", reviewer: "mimo" },
		acceptance: "a verdict is recorded",
		source: "review of work item OL11",
		brief: "",
		ownedPaths: ["muster/work-items.ts"],
		dependencies: [],
		attempt: 1,
		state: "ready",
		events: [{ at: WHEN, by: "orchestrator", verb: "create", detail: "created in state ready" }],
		...over,
	};
}

test("the record refuses a reviewer on the author's or the parent's family", () => {
	assert.equal(validateWorkItemRecord(reviewRecord()).ok, true);
	const cases: [Partial<Record<string, unknown>>, RegExp][] = [
		[{ review: { author: "mimo", parent: "deepseek", reviewer: "mimo" } }, /reviewer must differ from record\.review\.author/],
		[{ review: { author: "deepseek", parent: "mimo", reviewer: "mimo" } }, /reviewer must differ from record\.review\.parent/],
		[{ review: { author: "deepseek", parent: "minimax", reviewer: "deepseek" } }, /reviewer must be one of mimo, glm/],
		[{ review: { author: "deepseek", reviewer: "mimo" } }, /author and record\.review\.parent are named together or not at all/],
		[{ review: { author: "deepseek", parent: "minimax", reviewer: "kimi" } }, /must be one of mimo, glm/],
		[{ review: { author: "deepseek", parent: "minimax", reviewer: "glm" } }, /family glm cannot review here/, "the free Zen GLM label cannot serve a Pi lane (FreeTierError, the operator 2026-10-18)"],
		[{ review: { author: "deepseek", parent: "minimax", reviewer: "mimo", extra: 1 } }, /unknown fields: extra/],
	];
	for (const [over, pattern] of cases) {
		const outcome = validateWorkItemRecord(reviewRecord(over));
		assert.equal(outcome.ok, false, JSON.stringify(over));
		if (!outcome.ok) assert.match(outcome.errors.join("; "), pattern, JSON.stringify(over));
	}
	// A review item whose family is not chosen yet is a capture: the record accepts it and the dispatcher holds it.
	const capture = reviewRecord({ review: undefined });
	assert.equal(validateWorkItemRecord(capture).ok, true);
	assert.match(reviewFamilyHeld({ ...dispatchItem(), review: undefined }) ?? "", /review identity is not on the item the dispatcher reads/);
	// A non-review item that carries a review identity is refused: one meaning per field.
	const build = validateWorkItemRecord(reviewRecord({ kind: "build" }));
	assert.equal(build.ok, false);
	if (!build.ok) assert.match(build.errors.join("; "), /carried only by kind review/);
});

function dispatchItem(over: Partial<DispatchItem> = {}): DispatchItem {
	return {
		code: "REVIEW-OL11",
		heading: "Review OL11: review in the loop",
		goal: "out-loop",
		project: "muster",
		kind: "review",
		class: "H3",
		harness: "pi",
		brief: "/briefs/review-ol11.md",
		ownedPaths: ["muster/work-items.ts"],
		dependencies: [],
		attempt: 1,
		state: "ready",
		review: { author: "deepseek", parent: "minimax", reviewer: "mimo" },
		...over,
	};
}

test("a review item is dispatchable only with a reviewer family that differs from both", () => {
	const brief = () => ({ ok: true, text: "Cut from: main@8f436e7b (~/projects/muster)" });
	const queue = readyItems({
		items: [
			dispatchItem(),
			dispatchItem({ code: "REVIEW-OLD", review: { author: "mimo", parent: "deepseek", reviewer: "mimo" } }),
			dispatchItem({ code: "REVIEW-NEW", review: { author: "deepseek", parent: "mimo", reviewer: "mimo" } }),
			dispatchItem({ code: "REVIEW-GLM", review: { author: "deepseek", parent: "minimax", reviewer: "glm" } }),
			dispatchItem({ code: "REVIEW-DEEPSEEK", review: { author: "minimax", parent: "mimo", reviewer: "deepseek" } }),
			dispatchItem({ code: "REVIEW-NONE", review: undefined }),
			dispatchItem({ code: "REVIEW-STRANGER", review: { author: "deepseek", parent: "minimax", reviewer: "kimi" } }),
			dispatchItem({ code: "BUILD-OK", kind: "build", review: undefined }),
		],
		liveLanes: [],
		brief,
	});
	assert.deepEqual(
		queue.ready.map((row) => row.item.code),
		["BUILD-OK", "REVIEW-OL11"],
		"only the review whose three families differ is launchable",
	);
	const held = new Map(queue.held.map((row) => [row.code, row.why] as const));
	assert.match(held.get("REVIEW-OLD") ?? "", /reviewer must differ from record\.review\.author/);
	assert.match(held.get("REVIEW-NEW") ?? "", /reviewer must differ from record\.review\.parent/);
	assert.match(held.get("REVIEW-NONE") ?? "", /review identity is not on the item the dispatcher reads/);
	assert.match(held.get("REVIEW-STRANGER") ?? "", /record\.review\.reviewer must be one of/);
	assert.match(held.get("REVIEW-DEEPSEEK") ?? "", /record\.review\.reviewer must be one of mimo, glm/);
	assert.match(held.get("REVIEW-GLM") ?? "", /family glm cannot review here/);
	assert.equal(reviewFamilyHeld(dispatchItem()), undefined);
	assert.equal(reviewFamilyHeld(dispatchItem({ kind: "build", review: undefined })), undefined, "a build item is not held by the review rule");
});

// ─── The review-mode switch ─────────────────────────────────────────────────

test("review-mode starts risky-only and turns every-lane after one week of verdicts", () => {
	assert.equal(parseReviewMode(undefined), undefined);
	assert.equal(parseReviewMode("  \n"), undefined);
	assert.equal(parseReviewMode("nonsense"), undefined, "a word the switch does not use is not guessed at");
	assert.equal(parseReviewMode("every-lane\n"), "every-lane");

	assert.equal(resolveReviewMode({ reviews: [], now: NOW }), "risky-only", "no verdicts yet: the first setting");
	assert.equal(resolveReviewMode({ reviews: [{ at: new Date(NOW - 6 * DAY_MS).toISOString() }], now: NOW }), "risky-only");
	assert.equal(resolveReviewMode({ reviews: [{ at: new Date(NOW - 8 * DAY_MS).toISOString() }], now: NOW }), "every-lane", "a week of verdicts switches it");
	assert.equal(resolveReviewMode({ reviews: [], now: NOW, recorded: "every-lane" }), "every-lane");
	assert.equal(resolveReviewMode({ reviews: [{ at: new Date(NOW - 30 * DAY_MS).toISOString() }], now: NOW, recorded: "risky-only" }), "risky-only", "the file's word is the rollback");
});

const AUTHOR = { sessionId: "worker-session", provider: "deepseek", model: "deepseek/deepseek-v4.1-flash", harness: "pi" };
const PARENT = { sessionId: "parent-1", provider: "minimax", model: "minimax/m3.1-flash", harness: "pi" };
const REVIEWER = { sessionId: "reviewer-session", provider: "opencode-go", model: "opencode-go/mimo-v2.6-flash", harness: "pi" };
const offer = { base_sha: "a1", head_sha: "b1", evidence: [{ log: "/logs/worker.log", root: "/worktrees/w1", head_sha: "b1", fingerprint: "fp-1" }], runtime: AUTHOR };
const review = (over: Partial<ReviewVerdict> = {}): ReviewVerdict => ({ taskId: "OL11", reviewer: "ol11-review", verdict: "approve", head_sha: "b1", at: WHEN, runtime: REVIEWER, parentRuntime: PARENT, ...over });
const noRisky = () => false;

test("every-lane needs an independent verdict for the head; risky-only leaves a plain diff alone", () => {
	const base = { integrationHead: "a1", changedPaths: ["muster/work-items.ts"], risky: noRisky, parentRuntime: PARENT };
	assert.deepEqual(integrationDecision({ ...base, offer }), { action: "fast-forward" }, "the default is risky-only");

	const undecided = integrationDecision({ ...base, offer, reviewMode: "every-lane" });
	assert.equal(undecided.action, "needs-review");
	assert.equal(undecided.action === "needs-review" ? undecided.mode : "", "every-lane");
	assert.match(integrationRefusalText(undecided, "muster"), /every-lane/);

	assert.equal(integrationDecision({ ...base, offer, verdict: review({ runtime: AUTHOR, parentRuntime: PARENT }), reviewMode: "every-lane" }).action, "needs-review", "the author's own verdict is not independent");
	assert.equal(integrationDecision({ ...base, offer, verdict: review({ head_sha: "a0" }), reviewMode: "every-lane" }).action, "needs-review", "a verdict for another head does not count");
	assert.deepEqual(integrationDecision({ ...base, offer, verdict: review(), reviewMode: "every-lane" }), { action: "fast-forward" });
});

// ─── The verdict reaches the lane card ──────────────────────────────────────

const PROGRAMME = "agp_8d8d8d8d8d8d";
const OWNER = { sessionId: "parent-1", processKey: "pi-1-boot-1", operatorRef: "operator", guarded: true };

test("the merge queue records the verdict and the lane card reads it", () => {
	const root = mkdtempSync(join(tmpdir(), "muster-ol11-card-"));
	const controlDir = join(root, "control");
	const ctx: ProgrammeControlContext = { store: fileProgrammeControlStore(controlDir), killFilePath: join(root, "kill") };
	const saved = process.env.PI_MUSTER_CONTROL_DIR;
	try {
		attachProgramme(PROGRAMME, OWNER, ctx);
		recordTaskOffer(PROGRAMME, { taskId: "OL11", offeredBy: "ol11-a1", ...offer }, ctx);
		recordReviewVerdict(PROGRAMME, { taskId: "OL11", reviewer: "ol11-review", verdict: "approve", head_sha: "b1", runtime: REVIEWER, parentRuntime: PARENT }, ctx);

		// The queue's own projection: the lane that offered, not any lane.
		const queue = ctx.store.read(PROGRAMME)?.mergeQueue;
		assert.equal(reviewMarkForLane(queue, "ol11-a1")?.verdict, "approve");
		assert.equal(reviewMarkForLane(queue, "another-lane"), undefined);

		// The card reads it from the queue's own location, which is what the Pi writer reaches.
		process.env.PI_MUSTER_CONTROL_DIR = controlDir;
		const card = buildLaneCard({
			laneId: "ol11-a1",
			cwd: root,
			branch: "lane/ol11-a1",
			model: AUTHOR.model,
			thinking: "max",
			isIdle: true,
			lastLifecycle: "agent_end",
			lastEventAt: NOW,
			lastAssistantText: "",
			since: NOW,
			pendingIn: 0,
			agentDir: root,
			now: NOW,
		});
		assert.deepEqual(card.review, { verdict: "approve", reviewer: "ol11-review", head_sha: "b1", at: card.review?.at ?? "", model: REVIEWER.model });
		assert.equal(card.state, "idle", "the verdict rides on the card; the card's own state rules are untouched");

		const unoffered = buildLaneCard({
			laneId: "ol11-a2",
			cwd: root,
			branch: "lane/ol11-a2",
			model: AUTHOR.model,
			thinking: "max",
			isIdle: true,
			lastLifecycle: "agent_end",
			lastEventAt: NOW,
			lastAssistantText: "",
			since: NOW,
			pendingIn: 0,
			agentDir: root,
			now: NOW,
		});
		assert.equal(unoffered.review, undefined, "a lane that offered nothing has no verdict");
	} finally {
		if (saved === undefined) delete process.env.PI_MUSTER_CONTROL_DIR;
		else process.env.PI_MUSTER_CONTROL_DIR = saved;
		rmSync(root, { recursive: true, force: true });
	}
});
