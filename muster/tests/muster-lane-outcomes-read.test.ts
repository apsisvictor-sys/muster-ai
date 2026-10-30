import "./muster-test-isolation.ts";
/**
 * CRH F7: the lane-outcomes reader over a file whose header gained columns.
 *
 * The file is appended by more than one writer, so a header can name `goal` and `title` while the rows
 * beneath it were written before those columns existed. The reader is header-keyed: a short row reads with
 * the missing cells empty, a long row or one without a required cell is counted and skipped.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LANE_OUTCOME_COLUMNS, readLaneOutcomes } from "../lane-outcomes.ts";

const HEADER = LANE_OUTCOME_COLUMNS.join("\t");

test("CRH F7: a row written before the header gained goal and title still reads, with those cells empty", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "lane-outcomes-read-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "lane-outcomes.tsv");
	// The thirteen columns the file carried before D27 added `goal` and `title`, then a full row.
	const old = ["2026-10-20", "crh", "pi-lane-crh", "harness", "claude-code/opus-5", "2026-10-20T08:00:00Z", "2026-10-20T12:00:00Z", "1", "review_ready", "F2", "harness", "pi", "launcher"];
	const full = [...old, "CC", "The live hub"];
	writeFileSync(path, [HEADER, old.join("\t"), full.join("\t")].join("\n") + "\n");

	const read = readLaneOutcomes(path);
	assert.equal(read.skipped, 0, "a short row is not a broken row");
	assert.equal(read.rows.length, 2);
	assert.deepEqual(
		{ lane: read.rows[0]!.lane, rounds: read.rows[0]!.rounds, outcome: read.rows[0]!.outcome, goal: read.rows[0]!.goal, title: read.rows[0]!.title },
		{ lane: "crh", rounds: 1, outcome: "review_ready", goal: null, title: null },
	);
	assert.deepEqual({ goal: read.rows[1]!.goal, title: read.rows[1]!.title }, { goal: "CC", title: "The live hub" }, "the full row keeps its cells");
});

test("CRH F7: a row longer than the header, or without a required cell, is counted and skipped", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "lane-outcomes-read-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "lane-outcomes.tsv");
	const full = ["2026-10-20", "crh", "pi-lane-crh", "harness", "model", "a", "b", "0", "review_ready", "", "", "", "", "CC", "T"];
	const tooLong = [...full, "extra"];
	const noOutcome = ["2026-10-20", "crh", "pi-lane-crh", "harness", "model", "a", "b", "0", "", "", "", "", "", "CC", "T"];
	writeFileSync(path, [HEADER, tooLong.join("\t"), noOutcome.join("\t")].join("\n") + "\n");
	const read = readLaneOutcomes(path);
	assert.equal(read.rows.length, 0);
	assert.equal(read.skipped, 2);
});
