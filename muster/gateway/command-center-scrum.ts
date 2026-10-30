/**
 * The Scrum views the command center shows, derived from the work-item records and nothing else (spec Revision 3,
 * CUTOVER's three fields; VR24-229 item 7).
 *
 * `muster/work-items.ts` owns `priority`, `points` and `sprint`, their vocabularies and their states. This module
 * holds no second copy of any of them: it reads the owner's enums for order and its unestimated sentinel for the
 * empty estimate, groups the records, and returns rows for the page to word. Nothing here writes, and nothing here
 * invents a value the record does not carry:
 *
 * - an item with no points is unestimated, and its points stay 0; a total that includes it says how many it could
 *   not count;
 * - an item in no sprint is in the backlog, where the record puts it;
 * - the burndown's days come from the records' own event times, because no sprint carries a start or an end date,
 *   and the panel says so rather than drawing a series nobody recorded.
 */

import {
	WORK_ITEM_PRIORITIES,
	WORK_ITEM_UNESTIMATED_POINTS,
	type WorkItemPriority,
	type WorkItemRecord,
} from "../work-items.ts";

/** One record as the views need it: the owner's fields, already plain. */
export type ScrumItem = {
	code: string;
	heading: string;
	priority: WorkItemPriority;
	points: number;
	sprint: string;
	/** The record's own state, `gated:<reason>` and `launched:<lane>` included. */
	state: string;
	goal: string;
	/** The lane a `launched:<lane>` state names, or null. */
	lane: string | null;
};

export type ScrumRow = ScrumItem & { done: boolean };

/** One column of the board: a group of the record's states, with what it holds. */
export type ScrumColumn = {
	/** The board column's own key; the page words it. */
	key: "todo" | "held" | "underway" | "done";
	items: ScrumRow[];
	/** Records in the column, including the unestimated ones. */
	count: number;
	/** Points in the column; `unestimated` of these records contributed none. */
	points: number;
	unestimated: number;
};

export type ScrumBacklog = {
	rows: ScrumRow[];
	points: number;
	unestimated: number;
};

export type ScrumSprint = {
	/** The sprint id the board shows, or null when no record is in a sprint. */
	id: string | null;
	columns: ScrumColumn[];
	/** Points across every column; `unestimated` records carry none. */
	points: number;
	count: number;
	unestimated: number;
};

export type ScrumBurnDay = { day: string; remaining: number };

export type ScrumBurndown = {
	days: ScrumBurnDay[];
	/** The sprint's points on the day the series starts. */
	total: number;
	/**
	 * `record-events`: the days were read from the records' own event times. `none`: no record in the sprint carries
	 * a time, so there is no honest series and `days` is empty.
	 */
	from: "record-events" | "none";
};

/** One goal's story count: what is done against what the records promise. */
export type ScrumEpic = {
	goal: string;
	done: number;
	total: number;
	pointsDone: number;
	pointsTotal: number;
	unestimated: number;
};

export type ScrumPanel = {
	/** Records read, and the files the owner's reader skipped, so a page never shows a total it cannot stand behind. */
	read: number;
	skipped: number;
	backlog: ScrumBacklog;
	sprint: ScrumSprint;
	burndown: ScrumBurndown;
	epics: ScrumEpic[];
};

const PRIORITY_ORDER = new Map<string, number>(WORK_ITEM_PRIORITIES.map((priority, index) => [priority, index]));

/** The lane a state names: `launched:<lane>`, or null for every other state. */
export function laneOfState(state: string): string | null {
	return state.startsWith("launched:") ? state.slice("launched:".length) || null : null;
}

/** The board column a record's state belongs to. `gated:` holds work, `launched:` is under way, `done` is done. */
export function columnOfState(state: string): ScrumColumn["key"] {
	if (state === "done") return "done";
	if (state.startsWith("gated:")) return "held";
	if (state.startsWith("launched:") || state === "launch-uncertain") return "underway";
	return "todo";
}

export function isDone(state: string): boolean {
	return state === "done";
}

/** Points the record contributes to a total: its own, or none while nobody estimated it. */
export function pointsOf(item: { points: number }): number {
	return Number.isInteger(item.points) && item.points > WORK_ITEM_UNESTIMATED_POINTS ? item.points : 0;
}

export function isUnestimated(item: { points: number }): boolean {
	return pointsOf(item) === 0;
}

export function toScrumItem(record: WorkItemRecord): ScrumItem {
	return {
		code: record.code,
		heading: record.heading,
		priority: record.priority,
		points: pointsOf(record),
		sprint: record.sprint,
		state: record.state,
		goal: record.goal,
		lane: laneOfState(record.state),
	};
}

/** Priority first, then the order the owner lists the records in — no other ranking exists. */
export function rankRows(items: readonly ScrumItem[]): ScrumRow[] {
	return items
		.map((item, index) => ({ item, index }))
		.sort((left, right) => {
			const byPriority = (PRIORITY_ORDER.get(left.item.priority) ?? PRIORITY_ORDER.size) - (PRIORITY_ORDER.get(right.item.priority) ?? PRIORITY_ORDER.size);
			return byPriority !== 0 ? byPriority : left.index - right.index;
		})
		.map(({ item }) => ({ ...item, done: isDone(item.state) }));
}

function tally(rows: readonly ScrumRow[]): { points: number; unestimated: number } {
	return {
		points: rows.reduce((sum, row) => sum + row.points, 0),
		unestimated: rows.filter((row) => row.points === 0).length,
	};
}

/** Every record in no sprint, ranked by priority then by the record's own order, with its points total. */
export function backlogOf(items: readonly ScrumItem[]): ScrumBacklog {
	const rows = rankRows(items.filter((item) => item.sprint === ""));
	return { rows, ...tally(rows) };
}

const COLUMN_KEYS: ScrumColumn["key"][] = ["todo", "held", "underway", "done"];

function columnsOf(rows: readonly ScrumRow[]): ScrumColumn[] {
	return COLUMN_KEYS.map((key) => {
		const columnRows = rows.filter((row) => columnOfState(row.state) === key);
		return { key, items: columnRows, count: columnRows.length, ...tally(columnRows) };
	});
}

/**
 * The sprint the board shows: the id with the most records still open, and where that ties, the most recently
 * created one. A sprint that is entirely done stays visible only while no sprint has open work, so the board is
 * never empty while a sprint exists.
 */
export function currentSprintOf(items: readonly ScrumItem[], records: readonly WorkItemRecord[]): string | null {
	const ids = [...new Set(items.map((item) => item.sprint).filter((sprint) => sprint !== ""))];
	if (ids.length === 0) return null;
	const firstEvent = (sprint: string): string => {
		let earliest = "";
		for (const record of records) {
			if (record.sprint !== sprint) continue;
			const at = record.events[0]?.at ?? "";
			if (at !== "" && (earliest === "" || at > earliest)) earliest = at;
		}
		return earliest;
	};
	const scored = ids
		.map((id) => {
			const rows = items.filter((item) => item.sprint === id);
			return { id, open: rows.filter((item) => !isDone(item.state)).length, at: firstEvent(id) };
		})
		.sort((left, right) => right.open - left.open || (left.at < right.at ? 1 : left.at > right.at ? -1 : 0));
	return scored[0]?.id ?? null;
}

export function sprintOf(items: readonly ScrumItem[], records: readonly WorkItemRecord[]): ScrumSprint {
	const id = currentSprintOf(items, records);
	if (id === null) return { id: null, columns: columnsOf([]), points: 0, count: 0, unestimated: 0 };
	const rows = rankRows(items.filter((item) => item.sprint === id));
	return { id, columns: columnsOf(rows), ...{ points: tally(rows).points, count: rows.length, unestimated: tally(rows).unestimated } };
}

/** The Sofia day of an instant, so a day boundary is the one people live in. */
function dayOf(at: string): string {
	const date = new Date(at);
	if (Number.isNaN(date.getTime())) return "";
	return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** The day an item finished, from its own state event; null while it has not finished. */
function doneDayOf(record: WorkItemRecord): string | null {
	if (record.state !== "done") return null;
	for (let index = record.events.length - 1; index >= 0; index -= 1) {
		const event = record.events[index];
		if (event.verb === "state" && /to done$/.test(event.detail)) return dayOf(event.at);
	}
	return dayOf(record.events[record.events.length - 1]?.at ?? "");
}

function daysBetween(first: string, last: string): string[] {
	const days: string[] = [];
	const start = new Date(`${first}T12:00:00Z`);
	const end = new Date(`${last}T12:00:00Z`);
	if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return days;
	for (const cursor = start; cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) days.push(cursor.toISOString().slice(0, 10));
	return days;
}

/**
 * Points remaining across the sprint's days. The days start at the sprint's earliest record event — no sprint
 * carries dates — and end today. An item counts as remaining until the day its own state event says it finished, so
 * a sprint where nothing has closed is a flat line at its total rather than a curve nobody recorded.
 */
export function burndownOf(items: readonly ScrumItem[], records: readonly WorkItemRecord[], today: string): ScrumBurndown {
	const id = currentSprintOf(items, records);
	if (id === null) return { days: [], total: 0, from: "none" };
	const members = records.filter((record) => record.sprint === id);
	const total = members.reduce((sum, record) => sum + pointsOf(record), 0);
	const times = members.map((record) => dayOf(record.events[0]?.at ?? "")).filter((day) => day !== "");
	if (times.length === 0) return { days: [], total, from: "none" };
	const first = times.sort()[0];
	const last = today > first ? today : first;
	const done = members.map((record) => ({ points: pointsOf(record), day: doneDayOf(record) }));
	const days = daysBetween(first, last).map((day) => {
		const closed = done.reduce((sum, record) => sum + (record.day !== null && record.day <= day ? record.points : 0), 0);
		return { day, remaining: total - closed };
	});
	return { days, total, from: "record-events" };
}

/** Every goal the records name, with its stories done against its stories promised, `done` first. */
export function epicsOf(items: readonly ScrumItem[]): ScrumEpic[] {
	const goals = [...new Set(items.map((item) => item.goal))];
	return goals
		.map((goal) => {
			const rows = items.filter((item) => item.goal === goal);
			const finished = rows.filter((item) => isDone(item.state));
			return {
				goal,
				done: finished.length,
				total: rows.length,
				pointsDone: finished.reduce((sum, item) => sum + item.points, 0),
				pointsTotal: rows.reduce((sum, item) => sum + item.points, 0),
				unestimated: rows.filter((item) => item.points === 0).length,
			};
		})
		.sort((left, right) => right.total - left.total || left.goal.localeCompare(right.goal));
}

/** The whole panel, from the owner's records and the day the page is showing. */
export function buildScrumPanel(records: readonly WorkItemRecord[], today: string, skipped = 0): ScrumPanel {
	const items = records.map(toScrumItem);
	return {
		read: items.length,
		skipped,
		backlog: backlogOf(items),
		sprint: sprintOf(items, records),
		burndown: burndownOf(items, records, today),
		epics: epicsOf(items),
	};
}
