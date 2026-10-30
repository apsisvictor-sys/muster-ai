import "./muster-test-isolation.ts";
/**
 * CUTOVER (2026-10-29, spec §10 row OL8's next step; VR24-231 item g): the hand backlog's rows as work-item
 * records, and the generated view that replaces the hand table.
 *
 * 1. One row per hand entry: the hand ids and the codes are each unique, and the table is the 40 rows the hand
 *    backlog carried at the cutover. Two hand ids are not valid §7a codes (`OL3b` is lower case,
 *    `WGFIX2 + WGGUARD` names two changes) and each has one explained override.
 * 2. Every backfilled row validates as a §7a record, through the same builder `createWorkItem` writes, and the
 *    three Scrum fields the record now carries sit at their defaults on a row that names none.
 * 3. The committed `backlog.generated.md` at the repository root is exactly what the renderer produces now, so a
 *    hand edit to the generated file fails this test.
 * 4. The hand table's snapshot at the cutover (`fixtures/backlog-hand-2026-10-29.md`) and the generated view
 *    carry the same 40 rows: `outcome`, `brief / source` and `sprint goal` are the hand cell verbatim on every
 *    row, `deps` is the hand cell except on the five rows that dropped the dependency's own state, and `state` is
 *    the record's §7a spelling of the hand row. Both differences are named here and in
 *    `docs/qa/cutover-impact-map-2026-10-29.md`.
 * 5. The generated row of one record keeps every column, and `deps` folds an empty dependency list to the hand
 *    table's word `none`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BACKLOG_COLUMNS, parseBacklogTable } from "../backlog.ts";
import { validateWorkItemRecord, WORK_ITEM_DEFAULT_PRIORITY } from "../work-items.ts";
import {
	BACKLOG_GENERATED_FILE,
	BACKLOG_MIGRATION,
	backfillRecords,
	backlogCodeOf,
	backlogIdOf,
	backlogRow,
	renderGeneratedBacklog,
} from "../work-items-backlog.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The repository root: `muster/tests` is two directories below it, where `backlog.generated.md` lives. */
const REPO_ROOT = join(HERE, "..", "..");
/** The hand table as it read on 2026-10-29, the day the records became the queue. */
const HAND_AT_CUTOVER = join(HERE, "fixtures", "backlog-hand-2026-10-29.md");

/**
 * The `state` column the cutover gives each hand row: the record's §7a spelling of what the hand table wrote. A
 * hand cell's argument is not lost with it - a `done:<sha>` row carries the whole argument in the record's
 * `summary`, and a `gated:` row carries the reason after its prefix.
 */
const STATE_AT_CUTOVER: Record<string, string> = {
	"GL2-ONLY": "launched:watcher",
	D11FIX: "done",
	CR1: "done",
	CR2: "done",
	WP9: "done",
	"T2-BATCH": "gated:dep:GL2-FRESH",
	"UB-EMPTY": "launched:ubempty",
	"WGFIX2 + WGGUARD": "launched:ubempty",
	GL2COOL: "done",
	WAITWIN: "done",
	WAKEHEALTH: "done",
	BAL: "gated:dep:usage-monitor data",
	GL2MEM: "gated:parked",
	GHTOKEN: "ready",
	CCACCT2: "launched:ccacct2",
	PRUNE2: "gated:held",
	BEDEPS: "gated:dep:J14 run",
	"WT-INV": "done",
	"AI-LIVE": "gated:dep:quiet-machine",
	A1: "gated:operator:Wed 28 Oct",
	CRQ: "gated:operator:phone",
	MSG: "gated:operator:at the PC",
	"EA-IMPORT": "gated:dep:fresh-T2",
	PRUNE: "gated:dep:GL2-FRESH",
	HELD: "gated:held",
	OL0: "done",
	OL1: "done",
	OL2: "gated:held",
	OL3: "gated:dep:OL2",
	OL4: "gated:dep:OL2",
	OL5: "gated:dep:OL4",
	OL6: "gated:dep:OL0",
	OL7: "done",
	OL8: "gated:dep:OL2",
	OL9: "gated:dep:OL8",
	OL0B: "launched:oldoc",
	OL10: "gated:dep:OL8",
	OL1B: "launched:oldoc",
	OL1R2: "gated:held",
	OL3b: "gated:held",
};

/** The five rows whose hand `deps` cell names the dependency's state too; the record keeps the dependency's id. */
const DEPENDENCIES_AT_CUTOVER: Record<string, string> = {
	WP9: "CR2",
	GHTOKEN: "tickgh",
	BEDEPS: "J14",
	OL0B: "OL0",
	OL1B: "OL0",
};

test("one row per hand entry: ids and codes are unique, and the table is the hand backlog's 40 rows", () => {
	assert.equal(BACKLOG_MIGRATION.length, 40, "the hand backlog carried 40 rows at the cutover");
	const ids = BACKLOG_MIGRATION.map((row) => row.backlogId);
	const codes = BACKLOG_MIGRATION.map((row) => row.input.code);
	assert.equal(new Set(ids).size, ids.length, `duplicate hand ids: ${ids.filter((id, index) => ids.indexOf(id) !== index).join(", ")}`);
	assert.equal(new Set(codes).size, codes.length, `duplicate codes: ${codes.filter((code, index) => codes.indexOf(code) !== index).join(", ")}`);
	for (const id of ids) assert.equal(backlogIdOf(backlogCodeOf(id)!), id, `${id} reads back`);
});

test("the two hand ids that are not §7a codes have exactly one override each", () => {
	assert.equal(backlogCodeOf("OL3b"), "OL3B", "the hand table spells one id with a lower-case b");
	assert.equal(backlogCodeOf("WGFIX2 + WGGUARD"), "WGFIX2-WGGUARD", "one hand row for two changes");
	const overrides = BACKLOG_MIGRATION.filter((row) => row.backlogId !== row.input.code).map((row) => row.backlogId);
	assert.deepEqual(overrides.sort(), ["OL3b", "WGFIX2 + WGGUARD"]);
});

test("every backfilled row validates as a §7a record, with the Scrum fields at their defaults", () => {
	const records = backfillRecords();
	assert.equal(records.length, BACKLOG_MIGRATION.length);
	for (const record of records) {
		const outcome = validateWorkItemRecord(record);
		assert.equal(outcome.ok, true, outcome.ok ? "" : `${record.code}: ${outcome.errors.join("; ")}`);
		assert.equal(record.revision, 1);
		assert.equal(record.harness, "pi", `${record.code}: the hand table names no harness, so the default stands`);
		assert.equal(record.events.length, 1, `${record.code}: the backfill is one create event`);
		assert.equal(record.priority, WORK_ITEM_DEFAULT_PRIORITY, `${record.code}: the hand table ranks nothing, so an unranked item sits last`);
		assert.equal(record.points, 0, `${record.code}: the hand table estimates nothing, so the row is unestimated`);
		assert.equal(record.sprint, "", `${record.code}: the hand table names no sprint, so the row is in none`);
	}
});

test("the committed backlog.generated.md at the repository root is exactly what the renderer produces now", () => {
	const committed = readFileSync(join(REPO_ROOT, BACKLOG_GENERATED_FILE), "utf8");
	assert.equal(committed, renderGeneratedBacklog(backfillRecords()), "the generated file is stale or edited by hand: render it again");
	const header = committed.split("\n").find((line) => line.startsWith("| id "));
	assert.equal(header, `| ${BACKLOG_COLUMNS.join(" | ")} |`, "the generated table uses the hand table's own columns");
	assert.equal(committed.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| id ")).length, BACKLOG_MIGRATION.length + 1, "the separator plus one row per record");
});

test("the hand table at the cutover and the generated view carry the same 40 rows, and only the named cells differ", () => {
	const hand = parseBacklogTable(readFileSync(HAND_AT_CUTOVER, "utf8"), "hand table at the cutover");
	assert.equal(hand.ok, true, hand.ok ? "" : hand.reason);
	if (!hand.ok) return;
	const generated = parseBacklogTable(renderGeneratedBacklog(backfillRecords()), "generated view");
	assert.equal(generated.ok, true, generated.ok ? "" : generated.reason);
	if (!generated.ok) return;
	assert.equal(hand.rows.length, 40, "the hand table carried 40 rows at the cutover");
	assert.equal(generated.rows.length, hand.rows.length, "the generated view carries one row per hand row");
	const records = new Map(generated.rows.map((row) => [row.column["id"]!, row]));
	for (const row of hand.rows) {
		const handId = row.column["id"]!;
		const code = backlogCodeOf(handId);
		assert.ok(code !== undefined, `${handId}: every hand row has a record code`);
		const record = records.get(code!);
		assert.ok(record !== undefined, `${handId}: the generated view carries ${code}`);
		assert.equal(record!.column["outcome"], row.column["outcome"], `${handId}: the heading is the hand outcome, verbatim`);
		assert.equal(record!.column["brief / source"], row.column["brief / source"], `${handId}: the source is the hand cell, verbatim`);
		assert.equal(record!.column["sprint goal"], row.column["sprint goal"], `${handId}: the goal is the hand sprint goal, verbatim`);
		assert.equal(record!.column["deps"], DEPENDENCIES_AT_CUTOVER[handId] ?? row.column["deps"], `${handId}: deps are the hand cell, except where it named the dependency's state`);
		assert.equal(record!.column["state"], STATE_AT_CUTOVER[handId], `${handId}: the state is the record's §7a spelling of the hand row`);
	}
	assert.equal(new Set(hand.rows.map((row) => row.column["id"])).size, hand.rows.length, "no hand id repeats");
	assert.equal(Object.keys(STATE_AT_CUTOVER).length, hand.rows.length, "every hand row's state is named above, none is left as a guess");
	for (const row of generated.rows) assert.ok(backlogIdOf(row.column["id"]!) !== undefined, `${row.column["id"]}: every record came from a hand row`);
});

test("one generated row keeps every column, and an empty dependency list renders as the hand table's `none`", () => {
	const [record] = backfillRecords().filter((item) => item.code === "CR1");
	assert.ok(record !== undefined);
	const row = backlogRow(record);
	assert.deepEqual(Object.keys(row), [...BACKLOG_COLUMNS], "the row carries the hand table's columns, in its order");
	assert.equal(row["deps"], "none");
	assert.equal(row["id"], "CR1");
});
