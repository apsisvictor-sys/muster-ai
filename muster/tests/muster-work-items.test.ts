import "./muster-test-isolation.ts";
/**
 * OL8 (spec Revision 3, §7a and §10 row OL8; VR24-222 as amended by VR24-229): the work-item record,
 * its validator, its store floor, and the `muster schema` verb that prints the same vocabulary.
 *
 * 1. Every §7a field is required: a record missing one is refused with a message that names it, and a
 *    record carrying a value of the wrong shape for one is refused too. This is the acceptance line
 *    "every field of section 7a validated with a fixture that rejects a record missing it".
 * 2. A valid record is accepted; an unknown field is refused; `state` is the closed set
 *    (`draft`, `ready`, `launch-uncertain`, `done`, `gated:<reason>`, `launched:<lane>`) and a stranger
 *    is refused.
 * 3. The files store round trip: create, read, list, move to a state; the revision advances, a stale
 *    revision is refused by the store, a duplicate code is refused, and a malformed file on disk is
 *    listed as skipped rather than reset.
 * 4. `muster schema work-item` prints every field the validator enforces, and `--json` carries the same
 *    list, so the printed vocabulary and the enforced one cannot drift.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { command as schemaCommand } from "../cli/schema.ts";
import type { CliContext } from "../cli/types.ts";
import {
	createWorkItem,
	fileWorkItemStore,
	isWorkItemState,
	listWorkItems,
	readWorkItem,
	setWorkItemState,
	validateWorkItemRecord,
	WORK_ITEM_DEFAULT_PRIORITY,
	WORK_ITEM_FIELDS,
	WORK_ITEM_PRIORITIES,
	WORK_ITEM_SCHEMA_VERSION,
	type CreateWorkItemInput,
	type WorkItemRecord,
} from "../work-items.ts";

const WHEN = "2026-10-28T12:00:00.000Z";

function validInput(over: Partial<CreateWorkItemInput> = {}): CreateWorkItemInput {
	return {
		code: "OL8",
		heading: "Work items as validated records",
		summary: "the record, its validator and the generated backlog",
		goal: "out-loop",
		project: "pi-agent",
		kind: "build",
		class: "H3",
		harness: "pi",
		acceptance: "every §7a field is validated and the generated backlog diffs to the hand table",
		source: "specs/out-loop-durable-agents-2026-10-27.md §7a",
		brief: "handoffs/msgs/lane-prompt-ol8-1728.md",
		ownedPaths: ["packages/muster/work-items.ts"],
		dependencies: ["OL0b"],
		attempt: 1,
		state: "ready",
		...over,
	};
}

function validRecord(over: Partial<WorkItemRecord> = {}): Record<string, unknown> {
	const built: Record<string, unknown> = {
		schemaVersion: WORK_ITEM_SCHEMA_VERSION,
		revision: 1,
		...validInput(),
		ownedPaths: ["packages/muster/work-items.ts"],
		dependencies: ["OL0b"],
		// CUTOVER: the three Scrum fields, at the values a create writes when the writer names none.
		priority: WORK_ITEM_DEFAULT_PRIORITY,
		points: 0,
		sprint: "",
		events: [{ at: WHEN, by: "orchestrator", verb: "create", detail: "created in state ready" }],
	};
	return { ...built, ...over };
}

/** The record a version 1 writer stored: the same record before CUTOVER added the three Scrum fields. */
function legacyRecord(): Record<string, unknown> {
	const record = validRecord();
	delete record["priority"];
	delete record["points"];
	delete record["sprint"];
	return { ...record, schemaVersion: 1 };
}

function withStore(run: (dir: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "muster-work-items-"));
	const dir = join(root, "work-items");
	mkdirSync(dir, { recursive: true });
	try {
		run(dir);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("every §7a field is required: a record missing one is refused by name", () => {
	for (const field of WORK_ITEM_FIELDS) {
		const record = validRecord();
		delete record[field.name];
		const outcome = validateWorkItemRecord(record);
		assert.equal(outcome.ok, false, `${field.name}: a record without it must be refused`);
		if (outcome.ok) continue;
		assert.ok(
			outcome.errors.some((error) => error.includes(`${field.name} is required`)),
			`${field.name}: the refusal names the field (${outcome.errors.join("; ")})`,
		);
	}
});

test("every §7a field is checked: a value of the wrong shape is refused", () => {
	// null is the one value no field accepts: not a string, not an array, not a count, not a state.
	for (const field of WORK_ITEM_FIELDS) {
		const outcome = validateWorkItemRecord(validRecord({ [field.name]: null }));
		assert.equal(outcome.ok, false, `${field.name}: null must be refused`);
		if (outcome.ok) continue;
		assert.ok(outcome.errors.some((error) => error.includes(`record.${field.name}`)), `${field.name}: the refusal names the field (${outcome.errors.join("; ")})`);
	}
});

test("a valid record is accepted, and an unknown field is refused", () => {
	const accepted = validateWorkItemRecord(validRecord());
	assert.equal(accepted.ok, true, accepted.ok ? "" : accepted.errors.join("; "));
	const extra = validateWorkItemRecord(validRecord({ score: 7 }));
	assert.equal(extra.ok, false);
	if (!extra.ok) assert.ok(extra.errors.some((error) => error.includes("unknown fields: score")));
});

test("state is the closed §7a set, and a stranger is refused", () => {
	for (const state of ["draft", "ready", "launch-uncertain", "done", "gated:dep:OL2", "launched:ol8a"]) {
		assert.equal(isWorkItemState(state), true, `${state} must be a state`);
	}
	for (const state of ["preparing", "gated:", "launched:", "launched:two words", "Launched:x", "ready "]) {
		assert.equal(isWorkItemState(state), false, `${state} must not be a state`);
		const outcome = validateWorkItemRecord(validRecord({ state }));
		assert.equal(outcome.ok, false, `${state} must be refused in a record`);
	}
});

test("the files store: create, read, list, move state; the revision advances and a stale one is refused", () => {
	withStore((dir) => {
		const store = fileWorkItemStore(dir);
		const created = createWorkItem(store, validInput(), { by: "orchestrator", at: WHEN });
		assert.equal(created.revision, 1);
		assert.equal(created.state, "ready");
		assert.equal(created.harness, "pi");
		assert.equal(created.attempt, 1);
		assert.equal(created.events.length, 1);

		const read = readWorkItem(store, "OL8");
		assert.equal(read?.heading, "Work items as validated records");
		assert.equal(readWorkItem(store, "nope"), undefined, "a lowercase id never matches the code pattern, so it reads nothing");
		assert.equal(listWorkItems(store).items.length, 1);

		const moved = setWorkItemState(store, "OL8", "launched:ol8", { by: "orchestrator", at: WHEN });
		assert.equal(moved.revision, 2);
		assert.equal(moved.state, "launched:ol8");
		assert.deepEqual(moved.events.map((event) => event.verb), ["create", "state"]);
		assert.equal(setWorkItemState(store, "OL8", "launched:ol8", { by: "orchestrator", at: WHEN }).revision, 2, "the same state writes nothing");

		// The store's own compare-and-set refuses a revision that has moved on.
		assert.throws(() => store.update("OL8", 1, (current) => ({ ...current!, summary: "stale write" })), /conflict/i);
		assert.throws(() => setWorkItemState(store, "OL8", "waiting", { by: "orchestrator", at: WHEN }), /must be/);
	});
});

test("a duplicate code is refused and the first record stays", () => {
	withStore((dir) => {
		const store = fileWorkItemStore(dir);
		createWorkItem(store, validInput(), { by: "orchestrator", at: WHEN });
		assert.throws(() => createWorkItem(store, validInput({ heading: "a second one" }), { by: "grokbot", at: WHEN }), /already exists/);
		assert.equal(readWorkItem(store, "OL8")?.heading, "Work items as validated records");
		assert.equal(store.read("OL8")?.revision, 1);
	});
});

test("a malformed record on disk is listed as skipped, never reset", () => {
	withStore((dir) => {
		const store = fileWorkItemStore(dir);
		createWorkItem(store, validInput(), { by: "orchestrator", at: WHEN });
		writeFileSync(join(dir, "BROKEN.json"), JSON.stringify({ schemaVersion: 1, revision: 1, code: "BROKEN" }));
		const listing = listWorkItems(store);
		assert.deepEqual(listing.items.map((item) => item.code), ["OL8"]);
		assert.equal(listing.skipped.length, 1);
		assert.equal(listing.skipped[0]!.id, "BROKEN");
		assert.match(listing.skipped[0]!.error, /heading is required/);
	});
});

function fakeContext(argv: string[], json = false): { ctx: CliContext; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	const ctx: CliContext = {
		argv,
		repoRoot: process.cwd(),
		agentId: undefined,
		json,
		cwd: process.cwd(),
		env: process.env,
		io: { out: (line) => out.push(line), err: (line) => err.push(line) },
		readStdin: async () => "",
	};
	return { ctx, out, err };
}

test("muster schema work-item prints every field the validator enforces, and --json carries the same list", async () => {
	const text = fakeContext(["work-item"]);
	assert.equal(await schemaCommand.run(text.ctx), 0);
	const printed = text.out.join("\n");
	for (const field of WORK_ITEM_FIELDS) assert.ok(printed.includes(`${field.name} `) || printed.includes(`  ${field.name}`), `the print names ${field.name}`);
	assert.match(printed, /states: planned, queued, in build, in review, sent for fix, approved, merged, live, done, gated, dropped/);
	assert.match(printed, /writers: operator-shell, architect, orchestrator, grokbot, tick/);

	const machine = fakeContext(["work-item"], true);
	assert.equal(await schemaCommand.run(machine.ctx), 0);
	const payload = JSON.parse(machine.out.join("\n")) as { fields: { name: string }[]; stateRule: string; initialState: string };
	assert.deepEqual(payload.fields.map((field) => field.name), WORK_ITEM_FIELDS.map((field) => field.name));
	assert.match(payload.stateRule, /gated:<reason code>/);
	assert.equal(payload.initialState, "draft");
});

test("muster schema with no kind lists the kinds, and an unknown kind is refused", async () => {
	const listing = fakeContext([]);
	assert.equal(await schemaCommand.run(listing.ctx), 0);
	assert.ok(listing.out.some((line) => line.startsWith("work-item")));
	const stranger = fakeContext(["question"]);
	assert.equal(await schemaCommand.run(stranger.ctx), 2);
	assert.match(stranger.err.join("\n"), /unknown kind "question"/);
});

/** The stories the cutover names: each one carries points and a sprint through the store. */
const SCRUM_CODES = ["SI", "S1", "S2", "S3", "S4", "S5", "S6", "WAKE1", "PIWAIT", "CCSCRUM", "CUTOVER", "SL1", "SL2", "SL3", "SL4", "SL5", "SL6"] as const;

test("the three Scrum fields: a create that names none writes the owner's defaults", () => {
	withStore((dir) => {
		const store = fileWorkItemStore(dir);
		const created = createWorkItem(store, validInput(), { by: "orchestrator", at: WHEN });
		assert.equal(created.schemaVersion, WORK_ITEM_SCHEMA_VERSION);
		assert.equal(created.priority, WORK_ITEM_DEFAULT_PRIORITY, "an unranked item sits last and is never promoted by a default");
		assert.equal(created.points, 0, "0 is the record's one word for \"not estimated\"");
		assert.equal(created.sprint, "", "an item in no sprint says so with no id");
	});
});

test("SI, S1-S6, WAKE1, PIWAIT, CCSCRUM, CUTOVER and the SL set each carry points and a sprint", () => {
	withStore((dir) => {
		const store = fileWorkItemStore(dir);
		const expected = SCRUM_CODES.map((code, index) => ({
			code,
			priority: WORK_ITEM_PRIORITIES[index % WORK_ITEM_PRIORITIES.length]!,
			points: (index % 5) + 1,
			sprint: `s-2026-${45 + (index % 3)}`,
		}));
		for (const row of expected) {
			const created = createWorkItem(store, validInput({ code: row.code, priority: row.priority, points: row.points, sprint: row.sprint }), { by: "orchestrator", at: WHEN });
			assert.equal(created.points, row.points, `${row.code}: the create stores the estimate it was given`);
		}
		for (const row of expected) {
			const read = readWorkItem(store, row.code);
			assert.ok(read !== undefined, `${row.code} reads back`);
			assert.equal(read.priority, row.priority, `${row.code}: priority survives the store`);
			assert.equal(read.points, row.points, `${row.code}: points survive the store`);
			assert.equal(read.sprint, row.sprint, `${row.code}: the sprint id survives the store`);
			assert.equal(read.heading, "Work items as validated records", `${row.code}: every other field is the input's`);
		}
	});
});

test("priority is P0 to P3, points a whole number of 0 or more, and a sprint id lower-case and bounded", () => {
	for (const priority of ["P4", "p1", "", "1"]) {
		const outcome = validateWorkItemRecord(validRecord({ priority }));
		assert.equal(outcome.ok, false, `priority ${JSON.stringify(priority)} must be refused`);
		if (!outcome.ok) assert.ok(outcome.errors.some((error) => error.includes("record.priority")), outcome.errors.join("; "));
	}
	for (const points of [-1, 1.5, "3", null]) {
		const outcome = validateWorkItemRecord(validRecord({ points }));
		assert.equal(outcome.ok, false, `points ${JSON.stringify(points)} must be refused`);
	}
	for (const sprint of ["S 1", "S-2026-45", "x".repeat(33), "-lead", "sprint/"]) {
		const outcome = validateWorkItemRecord(validRecord({ sprint }));
		assert.equal(outcome.ok, false, `sprint ${JSON.stringify(sprint)} must be refused`);
	}
	for (const accepted of [{ priority: "P0" }, { priority: "P3" }, { points: 0 }, { points: 13 }, { sprint: "" }, { sprint: "s-2026-w45" }]) {
		const outcome = validateWorkItemRecord(validRecord(accepted));
		assert.equal(outcome.ok, true, `${JSON.stringify(accepted)} must be accepted: ${outcome.ok ? "" : outcome.errors.join("; ")}`);
	}
});

test("a version 1 record on disk reads as version 2 and loses nothing", () => {
	withStore((dir) => {
		const store = fileWorkItemStore(dir);
		const legacy = legacyRecord();
		writeFileSync(join(dir, "OL8.json"), JSON.stringify(legacy));
		const read = readWorkItem(store, "OL8");
		assert.ok(read !== undefined, "a version 1 record still reads");
		assert.equal(read.schemaVersion, 2, "the read migrates it to the current version");
		assert.equal(read.revision, 1, "the migration is a read, never a write");
		assert.equal(read.heading, "Work items as validated records");
		assert.equal(read.state, "ready");
		assert.deepEqual(read.events, legacy["events"], "the audit trail is carried through untouched");
		assert.equal(read.priority, "P3", "nothing is invented: the default is the record's own");
		assert.equal(read.points, 0);
		assert.equal(read.sprint, "");
		// The next write stores the current version, because every write clones the record it read.
		setWorkItemState(store, "OL8", "draft", { by: "orchestrator", at: WHEN });
		const stored = JSON.parse(readFileSync(join(dir, "OL8.json"), "utf8")) as { schemaVersion: number; revision: number };
		assert.equal(stored.schemaVersion, 2);
		assert.equal(stored.revision, 2);
	});
});

test("a version 1 record that already carries a Scrum field is refused, never silently rewritten", () => {
	for (const [field, value] of [
		["priority", "P1"],
		["points", 5],
		["sprint", "s-1"],
	] as const) {
		const outcome = validateWorkItemRecord({ ...legacyRecord(), [field]: value });
		assert.equal(outcome.ok, false, `a version 1 record with ${field} must be refused`);
		if (!outcome.ok) assert.ok(outcome.errors.some((error) => error.includes(field)), outcome.errors.join("; "));
	}
});
