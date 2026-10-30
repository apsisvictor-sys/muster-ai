import "./muster-test-isolation.ts";
/**
 * R4 decision cards and operator defaults (release plan §R4 items 1-3).
 *
 * A card is what the operator reads in the Discord thread: the id he answers with,
 * the question, every option, the recommendation, whether the recommendation
 * will apply itself, and when. The policy under test:
 *
 * - only a `product-decision` may auto-apply, and only when it was opened as
 *   reversible: an authorization, a credential and a human login always wait
 *   for a person, whatever the record says about reversibility;
 * - an irreversible card has no deadline at all, so there is nothing to fire;
 * - the deadline comes from the per-catalogue hour setting when the card is
 *   opened, not from the moment the tick happens to notice it;
 * - applying a default is the same single write as answering a card, so a
 *   replay cannot apply twice and a later human answer is a conflict;
 * - the record says who applied it (`autoApplied`, answerRef actor
 *   `operator-default`), so an operator default is never mistakable for a human
 *   answer;
 * - a schema-1 record written before this release still validates, and reads
 *   back as not reversible with no deadline: nothing old can auto-apply.
 *
 * Temp directories only. No Discord, no tick, no Hermes, no network.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	PROGRAMME_DECISIONS_SCHEMA_VERSION,
	ProgrammeDecisionStateError,
	applyDecisionAnswer,
	applyDecisionDefault,
	autoAppliableDecisions,
	decisionCardText,
	fileProgrammeDecisionStore,
	getDecision,
	listOpenDecisions,
	openDecision,
	validateProgrammeDecisionsFile,
	type DecisionAnswerRef,
	type ProgrammeDecisionContext,
} from "../decisions.ts";
import type { OpenDecisionInput } from "../../core/decision-types.ts";

const PROGRAMME_ID = "agp_0123456789ab";
/** A due instant far from any deadline these tests create. */
const FAR_FUTURE = Date.parse("2030-01-01T00:00:00.000Z");

async function withTempDir(run: (dir: string) => void | Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "muster-decision-cards-"));
	try {
		await run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function ctx(dir: string): ProgrammeDecisionContext {
	return { store: fileProgrammeDecisionStore(dir) };
}

function input(overrides: Partial<OpenDecisionInput> = {}): OpenDecisionInput {
	return {
		kind: "product-decision",
		question: "Ship the pilot?",
		options: [
			{ id: "approve", label: "Approve", recommendation: "preferred" },
			{ id: "hold", label: "Hold" },
		],
		recommendation: "approve",
		blockedTaskIds: [],
		scopeRevision: "sprint-1",
		...overrides,
	};
}

function humanRef(overrides: Partial<DecisionAnswerRef> = {}): DecisionAnswerRef {
	return {
		transport: "hermes",
		platformMessageId: "msg-answer-1",
		actorId: "operator",
		channelId: "chan-1",
		threadId: "thread-1",
		receivedAt: "2026-10-04T10:00:00.000Z",
		...overrides,
	};
}

// ─── Cards ───────────────────────────────────────────────────────────────────

test("R4: a reversible card carries the id, the question, every option, the recommendation, and when it applies itself", async () => {
	await withTempDir((dir) => {
		const { decisionId } = openDecision(PROGRAMME_ID, input({ reversible: true, autoApplyHours: 2 }), ctx(dir));
		const text = decisionCardText(getDecision(PROGRAMME_ID, decisionId, ctx(dir)), "crm-app");
		assert.match(text, new RegExp(decisionId), "the id the operator answers with is in the card");
		assert.match(text, /Ship the pilot\?/);
		assert.match(text, /approve — Approve/);
		assert.match(text, /hold — Hold/);
		assert.match(text, /Recommended: approve/);
		assert.match(text, /crm-app/);
		assert.match(text, /applies itself in 2h \(/, "the card says how long it waits before answering itself");
		assert.match(text, /\/decide \S+ approve/, "the answer command is in the card");
	});
});

test("R4: an irreversible card says it waits, and names no time", async () => {
	await withTempDir((dir) => {
		const { decisionId } = openDecision(PROGRAMME_ID, input({ kind: "authorization", reversible: false }), ctx(dir));
		const record = getDecision(PROGRAMME_ID, decisionId, ctx(dir));
		assert.equal(record.autoApplyAt, null, "an irreversible decision has no deadline to fire");
		const text = decisionCardText(record, "crm-app");
		assert.match(text, /waits for your answer/);
		assert.doesNotMatch(text, /applies itself/);
	});
});

test("R4: the deadline is the catalogue hours the card was opened with", async () => {
	await withTempDir((dir) => {
		const { decisionId } = openDecision(PROGRAMME_ID, input({ reversible: true, autoApplyHours: 4 }), ctx(dir));
		const record = getDecision(PROGRAMME_ID, decisionId, ctx(dir));
		assert.equal(Date.parse(record.autoApplyAt as string), Date.parse(record.createdAt) + 4 * 60 * 60 * 1000);
	});
});

// ─── Auto-apply policy ───────────────────────────────────────────────────────

test("R4: a reversible product decision is auto-appliable only at and after its deadline", async () => {
	await withTempDir((dir) => {
		const { decisionId } = openDecision(PROGRAMME_ID, input({ reversible: true, autoApplyHours: 2 }), ctx(dir));
		const record = getDecision(PROGRAMME_ID, decisionId, ctx(dir));
		const at = Date.parse(record.autoApplyAt as string);
		assert.deepEqual(autoAppliableDecisions(PROGRAMME_ID, at - 1, ctx(dir)), [], "a second early");
		assert.equal(autoAppliableDecisions(PROGRAMME_ID, at, ctx(dir)).length, 1, "at the deadline");
		assert.equal(autoAppliableDecisions(PROGRAMME_ID, at + 60_000, ctx(dir)).length, 1, "after the deadline");
	});
});

test("R4: production data, deploys, spending and outside messages never auto-apply", async () => {
	await withTempDir((dir) => {
		for (const kind of ["authorization", "credential", "human-login"] as const) {
			const error = captureError(() => openDecision(PROGRAMME_ID, input({ kind, reversible: true, autoApplyHours: 1 }), ctx(dir)));
			assert.equal(error?.code, "io", `${kind} cannot be opened with a deadline at all`);
			assert.match(error?.message ?? "", /only a product decision may answer itself/);
		}
	});
});

test("R4: a hand-written deadline on a non-product card fails closed before anything can read it", async () => {
	// Defence in depth: `openDecision` refuses the deadline, and a file written or
	// edited outside it is rejected on read, so a deploy, a purchase or a login can
	// never be armed by editing a record.
	await withTempDir((dir) => {
		for (const kind of ["authorization", "credential", "human-login"] as const) {
			const decisionId = `dec_${kind}`;
			writeSchema2(dir, decisionId, kind, { reversible: true, autoApplyAt: "2020-01-01T00:00:00.000Z" });
			const listed = captureError(() => autoAppliableDecisions(PROGRAMME_ID, FAR_FUTURE, ctx(dir)));
			assert.equal(listed?.code, "malformed", `${kind} with a deadline is an invalid record, not a due card`);
			assert.match(listed?.message ?? "", /only a product decision may answer itself/);
			const applied = captureError(() => applyDecisionDefault(PROGRAMME_ID, decisionId, "thread-1", ctx(dir), FAR_FUTURE));
			assert.equal(applied?.code, "malformed");
		}
	});
});

test("R4: a hand-written reversible flag on a non-product card is refused, not applied", async () => {
	await withTempDir((dir) => {
		const decisionId = "dec_authorization";
		writeSchema2(dir, decisionId, "authorization", { reversible: true, autoApplyAt: null });
		assert.deepEqual(autoAppliableDecisions(PROGRAMME_ID, FAR_FUTURE, ctx(dir)), [], "no deadline, nothing to apply");
		const applied = captureError(() => applyDecisionDefault(PROGRAMME_ID, decisionId, "thread-1", ctx(dir), FAR_FUTURE));
		assert.equal(applied?.code, "refused");
		assert.match(applied?.message ?? "", /never auto-applied/);
		assert.equal(getDecision(PROGRAMME_ID, decisionId, ctx(dir)).status, "open", "the card stays open for a person");
	});
});

test("R4: an irreversible reversible-typed card never auto-applies either", async () => {
	await withTempDir((dir) => {
		const { decisionId } = openDecision(PROGRAMME_ID, input({ reversible: false }), ctx(dir));
		assert.deepEqual(autoAppliableDecisions(PROGRAMME_ID, FAR_FUTURE, ctx(dir)), []);
		const error = captureError(() => applyDecisionDefault(PROGRAMME_ID, decisionId, "thread-1", ctx(dir)));
		assert.equal(error?.code, "refused");
		assert.equal(getDecision(PROGRAMME_ID, decisionId, ctx(dir)).status, "open");
	});
});

// ─── The operator default itself ─────────────────────────────────────────────

test("R4: an operator default applies the recommended option once and says who applied it", async () => {
	await withTempDir((dir) => {
		const { decisionId } = openDecision(PROGRAMME_ID, input({ reversible: true, autoApplyHours: 1 }), ctx(dir));
		const applied = applyDecisionDefault(PROGRAMME_ID, decisionId, "thread-1", ctx(dir), FAR_FUTURE);
		assert.equal(applied.optionId, "approve", "the recommendation is what applies");
		assert.equal(applied.answerRef.actorId, "operator-default");
		assert.equal(applied.answerRef.transport, "auto-apply");
		assert.equal(applied.answerRef.threadId, "thread-1");
		const record = getDecision(PROGRAMME_ID, decisionId, ctx(dir));
		assert.equal(record.status, "applied");
		assert.equal(record.autoApplied, true, "an operator default is never mistakable for a human answer");
		assert.equal(record.appliedOptionId, "approve");
		assert.deepEqual(listOpenDecisions(PROGRAMME_ID, ctx(dir)), []);
	});
});

test("R4: a repeated pass cannot apply the default twice, and a human answer after it is a conflict", async () => {
	await withTempDir((dir) => {
		const { decisionId } = openDecision(PROGRAMME_ID, input({ reversible: true, autoApplyHours: 1 }), ctx(dir));
		applyDecisionDefault(PROGRAMME_ID, decisionId, "thread-1", ctx(dir), FAR_FUTURE);
		assert.deepEqual(autoAppliableDecisions(PROGRAMME_ID, FAR_FUTURE, ctx(dir)), [], "a closed card is never due again");
		const again = applyDecisionDefault(PROGRAMME_ID, decisionId, "thread-1", ctx(dir));
		assert.equal(again.duplicate, true, "the same default replays as a duplicate");
		const error = captureError(() => applyDecisionAnswer(PROGRAMME_ID, decisionId, "hold", humanRef(), ctx(dir)));
		assert.equal(error?.code, "conflict");
		assert.equal(getDecision(PROGRAMME_ID, decisionId, ctx(dir)).appliedOptionId, "approve", "the first application stands");
	});
});

test("R4: a human answer first means no default ever applies", async () => {
	await withTempDir((dir) => {
		const { decisionId } = openDecision(PROGRAMME_ID, input({ reversible: true, autoApplyHours: 1 }), ctx(dir));
		applyDecisionAnswer(PROGRAMME_ID, decisionId, "hold", humanRef(), ctx(dir));
		assert.deepEqual(autoAppliableDecisions(PROGRAMME_ID, FAR_FUTURE, ctx(dir)), []);
		const record = getDecision(PROGRAMME_ID, decisionId, ctx(dir));
		assert.equal(record.autoApplied, false, "an answered card is a human decision");
		assert.equal(record.appliedOptionId, "hold");
	});
});

test("R4: a default for a card that is not yet due is refused", async () => {
	await withTempDir((dir) => {
		const { decisionId } = openDecision(PROGRAMME_ID, input({ reversible: true, autoApplyHours: 2 }), ctx(dir));
		const error = captureError(() => applyDecisionDefault(PROGRAMME_ID, decisionId, "thread-1", ctx(dir), 0));
		assert.equal(error?.code, "refused");
		assert.match(error?.message ?? "", /not yet due/);
		assert.equal(getDecision(PROGRAMME_ID, decisionId, ctx(dir)).status, "open");
	});
});

// ─── Legacy records ──────────────────────────────────────────────────────────

test("R4: a schema-1 record still validates and reads as never auto-appliable", () => {
	const legacy = {
		schemaVersion: 1,
		programmeId: PROGRAMME_ID,
		revision: 1,
		createdAt: "2026-09-23T09:00:00.000Z",
		updatedAt: "2026-09-23T09:00:00.000Z",
		decisions: [
			{
				decisionId: "dec_legacy",
				kind: "product-decision",
				question: "Ship the pilot?",
				options: [{ id: "approve", label: "Approve" }],
				recommendation: "approve",
				blockedTaskIds: [],
				scopeRevision: "sprint-1",
				status: "open",
				answerRef: null,
				appliedOptionId: null,
				appliedAt: null,
				createdAt: "2026-09-23T09:00:00.000Z",
				updatedAt: "2026-09-23T09:00:00.000Z",
			},
		],
	};
	const result = validateProgrammeDecisionsFile(legacy);
	assert.equal(result.ok, true, result.ok ? "" : result.errors.join("; "));
	if (!result.ok) return;
	const record = result.file.decisions[0];
	assert.equal(record.reversible, false, "a record written before this release must not become reversible");
	assert.equal(record.autoApplyAt, null);
	assert.equal(record.autoApplied, false);
});

test("R4: a legacy file on disk keeps working, and the next transition writes schema 2", async () => {
	await withTempDir((dir) => {
		const legacy = {
			schemaVersion: 1,
			programmeId: PROGRAMME_ID,
			revision: 1,
			createdAt: "2026-09-23T09:00:00.000Z",
			updatedAt: "2026-09-23T09:00:00.000Z",
			decisions: [
				{
					decisionId: "dec_legacy",
					kind: "product-decision",
					question: "Ship the pilot?",
					options: [{ id: "approve", label: "Approve" }],
					recommendation: "approve",
					blockedTaskIds: [],
					scopeRevision: "sprint-1",
					status: "open",
					answerRef: null,
					appliedOptionId: null,
					appliedAt: null,
					createdAt: "2026-09-23T09:00:00.000Z",
					updatedAt: "2026-09-23T09:00:00.000Z",
				},
			],
		};
		writeFileSync(join(dir, `${PROGRAMME_ID}.decisions.json`), JSON.stringify(legacy), "utf8");
		const open = listOpenDecisions(PROGRAMME_ID, ctx(dir));
		assert.equal(open.length, 1);
		assert.equal(open[0].reversible, false);
		const { decisionId } = openDecision(PROGRAMME_ID, input({ reversible: true, autoApplyHours: 2 }), ctx(dir));
		assert.ok(decisionId);
		const written = JSON.parse(readFileSync(join(dir, `${PROGRAMME_ID}.decisions.json`), "utf8")) as { schemaVersion: number };
		assert.equal(written.schemaVersion, PROGRAMME_DECISIONS_SCHEMA_VERSION);
	});
});

test("R4: an unknown schema version still fails closed", () => {
	const result = validateProgrammeDecisionsFile({ schemaVersion: 99, programmeId: PROGRAMME_ID, revision: 1, createdAt: "x", updatedAt: "x", decisions: [] });
	assert.equal(result.ok, false);
	assert.match(result.ok ? "" : result.errors.join(" "), /schemaVersion/);
});

/** Write one schema-2 decision by hand, the way a foreign or edited file would look. */
function writeSchema2(
	dir: string,
	decisionId: string,
	kind: string,
	overrides: { reversible: boolean; autoApplyAt: string | null },
): void {
	const now = new Date().toISOString();
	writeFileSync(
		join(dir, `${PROGRAMME_ID}.decisions.json`),
		JSON.stringify({
			schemaVersion: PROGRAMME_DECISIONS_SCHEMA_VERSION,
			programmeId: PROGRAMME_ID,
			revision: 1,
			createdAt: now,
			updatedAt: now,
			decisions: [
				{
					decisionId,
					kind,
					question: "Deploy to production?",
					options: [{ id: "approve", label: "Approve" }, { id: "hold", label: "Hold" }],
					recommendation: "approve",
					blockedTaskIds: [],
					scopeRevision: "main",
					status: "open",
					reversible: overrides.reversible,
					autoApplyAt: overrides.autoApplyAt,
					autoApplied: false,
					answerRef: null,
					appliedOptionId: null,
					appliedAt: null,
					createdAt: now,
					updatedAt: now,
				},
			],
		}),
		"utf8",
	);
}

function captureError(run: () => unknown): ProgrammeDecisionStateError | undefined {
	try {
		run();
	} catch (error) {
		if (error instanceof ProgrammeDecisionStateError) return error;
		throw error;
	}
	return undefined;
}
