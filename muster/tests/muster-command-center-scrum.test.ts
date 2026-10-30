/**
 * The command center's Scrum views, derived from the work-item records (CUTOVER; VR24-229 item 7).
 *
 * These are the four views' own facts: what is in the backlog and in what order, what each board column holds in
 * stories and points, what the burndown counts, and how far each goal got. The record's owner (`muster/work-items.ts`)
 * is used to build every record, so no view is tested against a shape the owner would refuse.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildWorkItemRecord, type CreateWorkItemInput } from "../work-items.ts";
import {
	backlogOf,
	burndownOf,
	columnOfState,
	currentSprintOf,
	epicsOf,
	laneOfState,
	pointsOf,
	sprintOf,
	toScrumItem,
} from "../gateway/command-center-scrum.ts";

const AT = "2026-10-29T08:00:00.000Z";

function record(code: string, input: Partial<CreateWorkItemInput> = {}, at = AT) {
	return buildWorkItemRecord(
		{
			code,
			heading: input.heading ?? `Story ${code}`,
			summary: input.summary ?? `What ${code} delivers.`,
			goal: input.goal ?? "SI",
			project: input.project ?? "muster",
			kind: input.kind ?? "build",
			class: input.class ?? "H3",
			acceptance: input.acceptance ?? "The story works.",
			source: input.source ?? "test",
			brief: input.brief ?? "brief",
			ownedPaths: input.ownedPaths ?? ["muster/gateway/command-center-page.html"],
			dependencies: input.dependencies ?? [],
			...input,
		} as CreateWorkItemInput,
		{ by: "tick", at },
	);
}

test("the backlog holds what no sprint took, ranked by the record's priority and then by the order it was filed", () => {
	const items = [
		record("CC-A", { priority: "P2" }),
		record("CC-B", { priority: "P0" }),
		record("CC-C", { priority: "P2" }),
		record("CC-D", { priority: "P1", sprint: "sprint-1" }),
		record("CC-E", { priority: "P3" }),
	].map(toScrumItem);
	const backlog = backlogOf(items);
	assert.deepEqual(backlog.rows.map((row) => row.code), ["CC-B", "CC-A", "CC-C", "CC-E"], "priority first, then the filed order; a sprint's item is not in the backlog");
	assert.equal(backlog.points, 0, "every record here is unestimated, so the total is 0");
	assert.equal(backlog.unestimated, 4, "the unestimated ones are counted rather than hidden");
});

test("an unestimated story is counted, and says so, in a total it could not contribute to", () => {
	const items = [record("CC-F", { points: 5 }), record("CC-G")].map(toScrumItem);
	const backlog = backlogOf(items);
	assert.equal(backlog.points, 5, "the estimated one carries the total");
	assert.equal(backlog.unestimated, 1, "the unestimated one is reported beside it");
	assert.equal(pointsOf({ points: 0 }), 0);
	assert.equal(pointsOf({ points: -3 }), 0, "a number the owner would refuse is never added to a total");
});

test("the board's columns are the record's own states, and each says what it holds in stories and points", () => {
	const records = [
		record("CC-H", { points: 3, sprint: "sprint-1", state: "ready" }),
		record("CC-I", { points: 2, sprint: "sprint-1", state: "launched:ol11" }),
		record("CC-J", { sprint: "sprint-1", state: "gated:waiting on hardware" }),
		record("CC-K", { points: 5, sprint: "sprint-1", state: "done" }),
	];
	const items = records.map(toScrumItem);
	const sprint = sprintOf(items, records);
	assert.equal(sprint.id, "sprint-1");
	assert.equal(sprint.columns.length, 4, "every column is shown, including the empty ones");
	const byKey = new Map(sprint.columns.map((column) => [column.key, column]));
	assert.deepEqual(byKey.get("todo").items.map((row) => row.code), ["CC-H"]);
	assert.deepEqual(byKey.get("underway").items.map((row) => row.code), ["CC-I"]);
	assert.deepEqual(byKey.get("held").items.map((row) => row.code), ["CC-J"]);
	assert.deepEqual(byKey.get("done").items.map((row) => row.code), ["CC-K"]);
	assert.equal(byKey.get("underway").points, 2);
	assert.equal(byKey.get("held").unestimated, 1, "the held story has no estimate and the column says so");
	assert.equal(sprint.points, 10);
	assert.equal(sprint.count, 4);
	assert.equal(laneOfState("launched:ol11"), "ol11", "a launched state names the lane carrying the story");
	assert.equal(columnOfState("launch-uncertain"), "underway");
	assert.equal(laneOfState("ready"), null);
});

test("the current sprint is the one with open work, and no sprint at all is said plainly", () => {
	assert.equal(currentSprintOf([].map(toScrumItem), []), null, "no record names a sprint");
	const records = [record("CC-L", { sprint: "sprint-old", state: "done" }), record("CC-M", { sprint: "sprint-new", state: "ready" })];
	const items = records.map(toScrumItem);
	assert.equal(currentSprintOf(items, records), "sprint-new", "the sprint holding open work wins over a finished one");
	const empty = sprintOf([], []);
	assert.equal(empty.id, null);
	assert.equal(empty.columns.length, 4, "the board still has its columns when no sprint exists");
	assert.equal(empty.count, 0);
});

test("the burndown counts the sprint's points from the records' own event days and is flat until something closes", () => {
	const records = [
		record("CC-N", { points: 5, sprint: "sprint-2", state: "ready" }, "2026-10-27T08:00:00.000Z"),
		record("CC-O", { points: 3, sprint: "sprint-2", state: "ready" }, "2026-10-28T08:00:00.000Z"),
	];
	const items = records.map(toScrumItem);
	const flat = burndownOf(items, records, "2026-10-29");
	assert.deepEqual(flat.days.map((day) => day.remaining), [8, 8, 8], "nothing has closed, so the line is flat at the total");
	assert.equal(flat.total, 8);
	assert.equal(flat.from, "record-events");
	assert.deepEqual(flat.days.map((day) => day.day), ["2026-10-27", "2026-10-28", "2026-10-29"], "days start at the sprint's first record event, because no sprint carries dates");

	const open = record("CC-P", { points: 5, sprint: "sprint-2", state: "launched:s1" }, "2026-10-27T08:00:00.000Z");
	const doneRecord = record("CC-Q2", { points: 4, sprint: "sprint-2", state: "done" }, "2026-10-27T08:00:00.000Z");
	doneRecord.events.push({ at: "2026-10-28T09:00:00.000Z", by: "tick", verb: "state", detail: "launched:s1 to done" });
	const drop = burndownOf([open, doneRecord].map(toScrumItem), [open, doneRecord], "2026-10-29");
	assert.equal(drop.total, 9);
	assert.deepEqual(drop.days.map((day) => day.remaining), [9, 5, 5], "the finished story's points leave on the day the record says it finished");
});

test("epics count the stories each goal promised and the points behind them, `no goal` included", () => {
	const items = [
		record("CC-Q", { goal: "SI", points: 3, state: "done" }),
		record("CC-R", { goal: "SI", points: 2, state: "ready" }),
		record("CC-S", { goal: "S2", state: "ready" }),
	].map(toScrumItem);
	const epics = epicsOf(items);
	const si = epics.find((epic) => epic.goal === "SI");
	assert.equal(si.done, 1);
	assert.equal(si.total, 2);
	assert.equal(si.pointsDone, 3);
	assert.equal(si.pointsTotal, 5);
	const s2 = epics.find((epic) => epic.goal === "S2");
	assert.equal(s2.total, 1);
	assert.equal(s2.unestimated, 1, "a goal whose only story has no estimate says so beside its points");
	assert.deepEqual(epicsOf([]), [], "no record named a goal, so there is no epic row to invent");
	assert.throws(() => record("CC-T", { goal: "" }), /goal must be one non-empty line/, "the owner refuses a story with no goal: the page's no-goal row is only a guard");
});
