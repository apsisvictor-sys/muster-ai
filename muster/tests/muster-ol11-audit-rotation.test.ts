import "./muster-test-isolation.ts";
/**
 * OL11 R3 (spec Revision 3, §9 "Review verdicts", §10 row OL11; VR24-225 R3): a weekly audit of one subsystem.
 *
 *   1. The walk follows the contract table's own order, never repeats a subsystem before its turn, wraps, and
 *      restarts at the first row when the cursor names a contract the table no longer has.
 *   2. The cursor lives in `state/muster/audit-rotation.json` — the file `health/doctor.ts` already reads — so
 *      it survives a restart (a fresh read finds it) and one week is what makes the next audit due.
 *   3. The audit's review item is a review item: kind `review`, a reviewer family, no author and no parent, and
 *      the dispatcher launches it.
 *   4. Its findings become work items.
 *   5. `audit-rotation` is in the contract table with `onRed: panel`, so its red state never asks the operator.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { reviewFamilyHeld, type DispatchItem } from "../dispatch.ts";
import { CONTRACT_ASK_CODES, CONTRACT_TABLE, DERIVED_CONTRACTS } from "../health/contracts.ts";
import {
	AUDIT_ROTATION_FILE,
	AUDIT_WEEK_MS,
	auditFindingItems,
	auditRotationPath,
	auditRotationSubjects,
	buildAuditReviewItem,
	buildWorkItemRecord,
	createWorkItem,
	fileWorkItemStore,
	listWorkItems,
	nextAuditReview,
	readAuditRotation,
	REVIEW_CANDIDATE_FAMILIES,
	REVIEW_RESOLVING_FAMILIES,
	validateWorkItemRecord,
	writeAuditRotation,
} from "../work-items.ts";

const DAY_MS = 24 * 60 * 60_000;
const NOW = Date.parse("2026-10-29T00:00:00.000Z");
const SUBJECTS = auditRotationSubjects();

function withStateDir(run: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "muster-ol11-audit-"));
	try {
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("the walk follows the contract table's order and never repeats a subsystem before its turn", () => {
	assert.deepEqual(
		SUBJECTS,
		Object.keys(CONTRACT_TABLE).filter((id) => id !== DERIVED_CONTRACTS.auditRotation),
		"the order is the table's own, the audit's contract aside",
	);
	assert.ok(SUBJECTS.length > 10, "the table's rows are the subsystems it walks");
	assert.ok(!SUBJECTS.includes(DERIVED_CONTRACTS.auditRotation), "the rotation does not audit its own contract");

	const seen: string[] = [];
	let cursor: { subject: string; at: string } | undefined;
	let now = NOW;
	for (let week = 0; week <= SUBJECTS.length; week += 1) {
		const review = nextAuditReview({ order: SUBJECTS, cursor, now });
		assert.equal(review.due, true, `week ${week} is due`);
		seen.push(review.subject);
		cursor = { subject: review.subject, at: new Date(now).toISOString() };
		now += AUDIT_WEEK_MS;
	}
	assert.deepEqual(seen.slice(0, SUBJECTS.length), SUBJECTS, "one week per subsystem, in the table's order");
	assert.equal(seen[SUBJECTS.length], SUBJECTS[0], "the walk wraps to the first row");
	assert.equal(new Set(seen.slice(0, SUBJECTS.length)).size, SUBJECTS.length, "no subsystem repeats before its turn");
	const elsewhere = nextAuditReview({ order: SUBJECTS, cursor: { subject: "gone.timer", at: new Date(NOW).toISOString() }, now: NOW });
	assert.equal(elsewhere.subject, SUBJECTS[0], "a cursor naming a removed contract restarts at the first row");
});

test("the cursor survives a restart and falls due once a week", () => {
	withStateDir((dir) => {
		const first = { subject: SUBJECTS[2]!, at: new Date(NOW).toISOString() };
		writeAuditRotation(dir, first);
		assert.equal(auditRotationPath(dir), join(dir, AUDIT_ROTATION_FILE));

		// A "restart": nothing in memory, read the file back the way the next process would.
		const read = readAuditRotation(dir);
		assert.equal(read.ok, true);
		if (!read.ok) return;
		assert.deepEqual(read.cursor, first);

		const sixDays = nextAuditReview({ order: SUBJECTS, cursor: read.cursor, now: NOW + 6 * DAY_MS });
		assert.equal(sixDays.due, false, "a week has not passed");
		assert.equal(sixDays.subject, SUBJECTS[3]);
		const aWeek = nextAuditReview({ order: SUBJECTS, cursor: read.cursor, now: NOW + AUDIT_WEEK_MS });
		assert.equal(aWeek.due, true);
		assert.equal(aWeek.subject, SUBJECTS[3], "the row after the one audited last");

		// The file is the one the doctor reads: `at` is the run that proves the rotation is alive.
		const stored = JSON.parse(readFileSync(auditRotationPath(dir), "utf8")) as { subject?: unknown; at?: unknown };
		assert.equal(stored.subject, first.subject);
		assert.equal(stored.at, first.at);
	});
});

test("a cursor file that is not a cursor is refused, never guessed", () => {
	withStateDir((dir) => {
		assert.deepEqual(readAuditRotation(dir), { ok: true }, "no file is no run yet");
		writeFileSync(auditRotationPath(dir), "{not json");
		const broken = readAuditRotation(dir);
		assert.equal(broken.ok, false);
		if (!broken.ok) assert.match(broken.error, /is not JSON/);
		writeFileSync(auditRotationPath(dir), JSON.stringify({ at: new Date(NOW).toISOString() }));
		const incomplete = readAuditRotation(dir);
		assert.equal(incomplete.ok, false);
		if (!incomplete.ok) assert.match(incomplete.error, /must be \{subject, at\}/);
		assert.throws(() => writeAuditRotation(dir, { subject: "", at: new Date(NOW).toISOString() }), /must be \{subject, at\}/);
	});
});

test("the weekly audit's item is a review item the dispatcher launches", () => {
	const built = buildAuditReviewItem({ cursor: undefined, now: NOW, goal: "out-loop", project: "muster", ownedPaths: ["muster/tick.ts"] });
	assert.equal(built.review.subject, SUBJECTS[0]);
	assert.equal(built.input.kind, "review");
	assert.ok((REVIEW_CANDIDATE_FAMILIES as readonly string[]).includes(built.input.review?.reviewer ?? ""), "a reviewer family is chosen for it");
	assert.ok((REVIEW_RESOLVING_FAMILIES as readonly string[]).includes(built.input.review?.reviewer ?? ""), "and it is one the audit can actually run on");
	assert.equal(built.input.review?.author, undefined, "an audit names no author");
	assert.equal(built.input.review?.parent, undefined, "an audit names no parent");
	assert.match(built.input.source, new RegExp(`^audit-rotation ${SUBJECTS[0]} at `));

	// Its family rotates with the subject's place, so a year of audits does not land on one model.
	const families = new Set<string>();
	for (let index = 0; index < REVIEW_RESOLVING_FAMILIES.length; index += 1) {
		families.add(buildAuditReviewItem({ cursor: { subject: SUBJECTS[index]!, at: new Date(NOW).toISOString() }, now: NOW + 8 * DAY_MS, goal: "out-loop", project: "muster", ownedPaths: ["muster/tick.ts"] }).input.review?.reviewer ?? "");
	}
	assert.equal(families.size, REVIEW_RESOLVING_FAMILIES.length, "the audits turn over the families that can run");

	const item: DispatchItem = {
		code: built.input.code,
		heading: built.input.heading,
		goal: built.input.goal,
		project: built.input.project,
		kind: built.input.kind,
		class: built.input.class,
		harness: built.input.harness!,
		brief: built.input.brief!,
		ownedPaths: built.input.ownedPaths!,
		dependencies: built.input.dependencies!,
		attempt: 1,
		state: built.input.state!,
		review: built.input.review,
	};
	assert.equal(reviewFamilyHeld(item), undefined, "an audit names no author, so no family can clash");
	assert.equal(validateWorkItemRecord(buildWorkItemRecord(built.input, { by: "tick", at: new Date(NOW).toISOString() })).ok, true);
});

test("the audit's findings become work items", () => {
	const built = buildAuditReviewItem({ cursor: { subject: SUBJECTS[0]!, at: new Date(NOW - 8 * DAY_MS).toISOString() }, now: NOW, goal: "out-loop", project: "muster", ownedPaths: ["muster/tick.ts"] });
	const subject = built.review.subject;
	const at = new Date(NOW).toISOString();
	const findings = auditFindingItems(
		[
			{ code: "AUDIT-F1", heading: "the repair loop outlives its declared bound" },
			{ code: "AUDIT-F2", heading: "the timer's own record is not read back", class: "H4" },
		],
		{ subject, at, goal: "out-loop", project: "muster" },
	);
	assert.equal(findings.length, 2);
	assert.equal(findings[0]!.kind, "fix");
	assert.equal(findings[0]!.state, "idea", "a finding is captured, and a brief is what turns it ready");
	assert.equal(findings[1]!.class, "H4");
	assert.equal(findings[0]!.source, `audit-rotation ${subject} at ${at}`);

	withStateDir((dir) => {
		const store = fileWorkItemStore(join(dir, "work-items"));
		for (const input of findings) createWorkItem(store, input, { by: "tick", at });
		const stored = listWorkItems(store).items;
		assert.deepEqual(stored.map((item) => item.code), ["AUDIT-F1", "AUDIT-F2"]);
		assert.ok(stored.every((item) => item.source.startsWith("audit-rotation ")), "each finding names the audit it came from");
	});
});

test("audit-rotation is a contract row with onRed panel, so its red state never asks the operator", () => {
	const row = CONTRACT_TABLE[DERIVED_CONTRACTS.auditRotation];
	assert.ok(row !== undefined, "the contract table carries the row");
	assert.deepEqual(row.onRed, { action: "panel" });
	assert.ok(CONTRACT_ASK_CODES.has(row.askCode));
	assert.match(row.owner, /weekly review/);
});
