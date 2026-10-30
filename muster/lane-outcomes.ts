/**
 * The lane-outcomes file: its path and its columns, one owner (blueprint D33, plan correction C2).
 *
 * `cli/lane-outcome.ts` appends a closed lane's row and `scripts/backfill-lane-outcomes.mts`
 * rewrites the file, so the path and the column list live here and both import them; a second
 * copy in the script was a second owner of the same file. CRH adds the reader
 * (`readLaneOutcomes`) to this module.
 *
 * The writer is header-keyed: a row follows the header the file actually carries, so a file
 * written before a column existed keeps its rows aligned. Nothing here reads or writes disk, so
 * the backfill script and the CLI can import it without dragging the Muster store with them.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { piAgentDir } from "../core/pi-ports.ts";

/**
 * The file's columns, in order: the ten the file started with, the three the lane record writes
 * (AR1), then D27's two, `goal` (the goal holding the lane at close) and `title`.
 */
export const LANE_OUTCOME_COLUMNS = [
	"date",
	"lane",
	"project",
	"class",
	"model",
	"launched_at",
	"closed_at",
	"rounds_sent_back",
	"outcome",
	"send_back_causes",
	"task_kind",
	"harness",
	"route_by",
	"goal",
	"title",
] as const;
export type LaneOutcomeColumn = (typeof LANE_OUTCOME_COLUMNS)[number];

/** The lane-outcomes file of the installation this code belongs to (`PI_LANE_OUTCOMES_TSV` for a lab). */
export function laneOutcomesPath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env["PI_LANE_OUTCOMES_TSV"]?.trim();
	if (override !== undefined && override !== "") return resolve(override);
	// S10: the installation's `plans/` comes from the agentDir port the start file configured,
	// never from this file's own location (PIREDS).
	return join(piAgentDir(), "plans", "lane-outcomes.tsv");
}

/**
 * One row as the reader hands it on (D33): the file's cells by name, and nothing invented. A column the
 * file predates is `null`, so a row written before D27's `goal` and `title` reads "No goal recorded"
 * rather than a guess.
 */
export type LaneOutcomeRow = {
	/** The Sofia day the lane closed, as the writer recorded it. */
	date: string;
	lane: string;
	project: string | null;
	class: string | null;
	model: string | null;
	launchedAt: string | null;
	closedAt: string | null;
	/** `rounds_sent_back` as a number; a row whose cell is not one is skipped. */
	rounds: number;
	outcome: string;
	causes: string | null;
	taskKind: string | null;
	harness: string | null;
	routeBy: string | null;
	goal: string | null;
	title: string | null;
};

export type LaneOutcomesRead = { rows: LaneOutcomeRow[]; skipped: number };

/** The columns a row cannot be read without: the day, the lane and what became of it (D33). */
const REQUIRED_HEADERS = ["date", "lane", "outcome"] as const;

/**
 * One row's cells by header name, or undefined when the row is not the header's shape. A row shorter than
 * the header is a row an older writer wrote before the last columns existed (F7): its missing cells read as
 * empty, so a file whose header gained `goal` and `title` still yields the rows beneath it.
 */
function readRow(cells: readonly string[], index: ReadonlyMap<string, number>): LaneOutcomeRow | undefined {
	const cell = (name: string): string | null => {
		const at = index.get(name);
		if (at === undefined) return null;
		const value = cells[at]?.trim() ?? "";
		return value === "" ? null : value;
	};
	for (const name of REQUIRED_HEADERS) if (cell(name) === null) return undefined;
	const roundsText = cell("rounds_sent_back") ?? "0";
	if (!/^\d+$/.test(roundsText)) return undefined;
	return {
		date: cell("date")!,
		lane: cell("lane")!,
		project: cell("project"),
		class: cell("class"),
		model: cell("model"),
		launchedAt: cell("launched_at"),
		closedAt: cell("closed_at"),
		rounds: Number(roundsText),
		outcome: cell("outcome")!,
		causes: cell("send_back_causes"),
		taskKind: cell("task_kind"),
		harness: cell("harness"),
		routeBy: cell("route_by"),
		goal: cell("goal"),
		title: cell("title"),
	};
}

/**
 * Read the lane-outcomes file, header-keyed like the digest's parser (D33): the header decides which
 * cell holds what, so a file written before a column existed still reads. A missing file is no rows, and
 * a row that has more cells than the header, or lacks a required cell, is counted and skipped rather
 * than failing the whole read; a row with fewer cells than the header is read with those cells empty.
 */
export function readLaneOutcomes(path: string): LaneOutcomesRead {
	if (!existsSync(path)) return { rows: [], skipped: 0 };
	const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "");
	if (lines.length === 0) return { rows: [], skipped: 0 };
	const header = lines[0]!.split("\t").map((name) => name.trim());
	const missing = REQUIRED_HEADERS.filter((name) => !header.includes(name));
	if (missing.length > 0) throw new Error(`${path}: the header names no ${missing.join(", ")}; the file is not a lane-outcomes file`);
	const index = new Map(header.map((name, at) => [name, at]));
	const rows: LaneOutcomeRow[] = [];
	let skipped = 0;
	for (const line of lines.slice(1)) {
		const cells = line.split("\t");
		// Fewer cells than the header: an older writer's row, read with the missing cells empty. More cells than
		// the header: a different file, or a broken line, and the row is counted rather than guessed at.
		const row = cells.length <= header.length ? readRow(cells, index) : undefined;
		if (row === undefined) skipped += 1;
		else rows.push(row);
	}
	return { rows, skipped };
}
