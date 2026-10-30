/**
 * `muster lane-outcome` — the lane-outcomes row, written by code (AR1).
 *
 * `plans/lane-outcomes.tsv` had no writer: the orchestrator typed each row, so a closed
 * lane could not say what it ran on or as which kind, and 342 of 546 rows had no model at
 * all. This verb builds the row from the lane's own record and appends it, so the row and
 * the record cannot drift apart.
 *
 *   muster lane-outcome <lane> [--rounds <n>] [--causes <list>] --outcome <merged|already_done|abandoned>
 *
 * The row's cells are the file's own columns (`LANE_OUTCOME_COLUMNS` in `lane-outcomes.ts`, which owns
 * the path and the column list): date, lane, project, class, model, launched_at, closed_at,
 * rounds_sent_back, outcome, send_back_causes, the three this lane added (task_kind, harness, route_by),
 * and D27's goal and title. With no `--rounds` the record's own send-backs answer, and with no
 * `--causes` their causes follow in order (C6); a given value still wins. The file's header decides how
 * many cells a row has: a file that still carries an older header gets fewer cells, and the missing
 * columns are named on stderr, so a row never lands under a header that does not have its cells. The
 * digest's parser is header-keyed, so old rows and old readers keep reading.
 *
 * The append goes through the one append body (`appendFsyncedLineTo`, the same body as the
 * send log and the routing decisions log). One lane, one launch, one row: a second call for a
 * record that already has a row for its `launched_at` is refused with exit 4 and one line, and
 * nothing is written, so the digest cannot count the same lane twice. The file is the one the
 * installation owns: the repo the running code lives in, the same root
 * `scripts/learning-digest.py` reads, with `PI_LANE_OUTCOMES_TSV` for a lab.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { appendFsyncedLineTo } from "../../core/append-line.ts";
import { findProjectByRepoKey, projectCataloguePath, projectNameForRepoKey, readProjectCatalogue } from "../projects.ts";
import { goalStore, goalsDir, listGoals } from "../goals.ts";
import { readLaneRecord, SENT_BACK, TERMINAL_PHASES, type LaneRecord } from "../lane-lifecycle.ts";
import { roundsOf } from "../lane-stage.ts";
import { LANE_OUTCOME_COLUMNS, laneOutcomesPath } from "../lane-outcomes.ts";
import { lanesStateDir } from "./lanes.ts";
import { parseFlags, type CliCommand } from "./types.ts";

const VALUE_FLAGS = ["rounds", "causes", "outcome"];
const OUTCOMES = ["merged", "already_done", "abandoned"];

const USAGE = [
	"muster lane-outcome <lane> [--rounds <n>] [--causes <list>] --outcome <merged|already_done|abandoned> [--json]",
	"  builds the lane-outcomes row from the lane's own record and appends it to plans/lane-outcomes.tsv",
	"  with no --rounds the record's send-backs are the rounds, and with no --causes their causes follow in order",
].join("\n");

/** The repository a path belongs to: the git common directory, so every worktree of one repository names the same project. */
function repoCommonDir(start: string): string | undefined {
	let dir = resolve(start);
	for (let depth = 0; depth < 64; depth += 1) {
		const dotGit = join(dir, ".git");
		let isDirectory = false;
		try {
			isDirectory = statSync(dotGit).isDirectory();
		} catch {
			isDirectory = false;
		}
		if (isDirectory) return dotGit;
		if (existsSync(dotGit)) {
			// A worktree's `.git` is a file that points at the main repository's git dir.
			try {
				const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
				const gitdir = match?.[1]?.trim();
				if (gitdir !== undefined) {
					const worktrees = gitdir.lastIndexOf("/worktrees/");
					return worktrees > 0 ? gitdir.slice(0, worktrees) : gitdir;
				}
			} catch {
				return undefined;
			}
			return undefined;
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
}

/** The project the lane ran in: the catalogue's name for its repository, else the repository's own folder name. */
function projectForLane(record: LaneRecord): string {
	const cwd = record.cwd ?? record.repoRoot;
	if (cwd === undefined || cwd.trim() === "") return "unknown";
	const commonDir = repoCommonDir(cwd);
	if (commonDir === undefined) return "unknown";
	try {
		const found = findProjectByRepoKey(readProjectCatalogue(projectCataloguePath()), commonDir);
		if (found !== undefined) return found.project.name;
	} catch {
		// No catalogue to read: the repository's own folder names the project.
	}
	return projectNameForRepoKey(commonDir);
}

/** One cell never breaks the row: a tab or a newline would split it. */
function cell(value: string): string {
	return value.replace(/[\t\r\n]+/g, " ").trim();
}

/** `2026-10-25T12:19:25Z`: the file's own timestamp shape. */
function stamp(at: number): string {
	return new Date(at).toISOString().replace(/\.\d+Z$/, "Z");
}

/**
 * The goal that holds the lane at close (D27), read from the registry with its finished goals too: a merged
 * lane's goal is often done by then. `none` when no goal holds it, `unknown` when the registry cannot be
 * read, because a missing goal cell must not cost the row the record already answers.
 */
function goalHoldingLane(stateDir: string, laneId: string): string {
	try {
		const goals = listGoals(goalStore(goalsDir(stateDir)), { all: true }).goals;
		return goals.find((goal) => goal.lanes.some((attachment) => attachment.lane === laneId))?.code ?? "none";
	} catch {
		return "unknown";
	}
}

export const command: CliCommand = {
	name: "lane-outcome",
	summary: "Write a closed lane's lane-outcomes row from its own record",
	usage: USAGE,
	async run(ctx) {
		const parsed = parseFlags(ctx.argv, VALUE_FLAGS);
		const laneId = parsed.positionals[0]?.trim() ?? parsed.values.get("lane")?.trim();
		if (laneId === undefined || laneId === "") {
			ctx.io.err(`muster lane-outcome: a lane is needed\n${command.usage}`);
			return 2;
		}
		const outcome = parsed.values.get("outcome")?.trim();
		if (outcome === undefined || !OUTCOMES.includes(outcome)) {
			ctx.io.err(`muster lane-outcome: --outcome must be one of ${OUTCOMES.join(", ")}\n${command.usage}`);
			return 2;
		}
		const stateDir = lanesStateDir(ctx.env);
		const record = readLaneRecord(stateDir, laneId);
		if (record === undefined) {
			ctx.io.err(`muster lane-outcome: no lane record for ${laneId}`);
			return 3;
		}
		// C6: the record answers the two counts. Every send-back is one round, and the causes follow in the
		// order the orchestrator wrote them; a value the caller gives still wins.
		const sentBack = (record.handoffs ?? []).filter((handoff) => handoff.verdict === SENT_BACK);
		const roundsRaw = parsed.values.get("rounds")?.trim() ?? String(roundsOf(record.handoffs));
		if (!/^\d+$/.test(roundsRaw)) {
			ctx.io.err(`muster lane-outcome: --rounds needs a whole number of send-back rounds\n${command.usage}`);
			return 2;
		}
		const rounds = Number(roundsRaw);

		const path = laneOutcomesPath(ctx.env);
		if (!existsSync(path)) {
			ctx.io.err(`muster lane-outcome: no lane-outcomes file at ${path}`);
			return 3;
		}
		const fileLines = readFileSync(path, "utf8").split("\n");
		const header = fileLines[0]?.split("\t") ?? [];
		// The file's own header decides the row's shape and order: today's header gives a fifteen-cell row,
		// the 13-column one gives thirteen, an older one gives fewer, and none shifts a column already in
		// the file.
		const columns = header.filter((column) => (LANE_OUTCOME_COLUMNS as readonly string[]).includes(column));
		if (columns.length === 0) {
			ctx.io.err(`muster lane-outcome: ${path} has no lane-outcomes header; nothing was written`);
			return 3;
		}
		const laneColumn = header.indexOf("lane");
		const launchedColumn = header.indexOf("launched_at");
		if (laneColumn < 0 || launchedColumn < 0) {
			ctx.io.err(`muster lane-outcome: ${path} has no lane or launched_at column, so a repeated row could not be recognised; nothing was written`);
			return 3;
		}
		const missing = LANE_OUTCOME_COLUMNS.filter((column) => !header.includes(column));

		const closedAt = record.terminal?.closedAt ?? (TERMINAL_PHASES.includes(record.phase) ? record.phaseSince : Date.now());
		const causes = parsed.values.get("causes")?.trim() ?? (sentBack.length === 0 ? "none" : sentBack.map((handoff) => handoff.cause ?? "unknown").join(", "));
		const values: Record<string, string> = {
			date: stamp(closedAt).slice(0, 10),
			lane: record.laneId,
			project: projectForLane(record),
			class: record.class ?? "unknown",
			model: record.model ?? `${record.harness}/unknown`,
			launched_at: stamp(record.launchedAt),
			closed_at: stamp(closedAt),
			rounds_sent_back: String(rounds),
			outcome,
			send_back_causes: causes,
			task_kind: record.taskKind ?? "unknown",
			harness: record.harness,
			route_by: record.routeBy ?? "unknown",
			goal: goalHoldingLane(stateDir, record.laneId),
			title: record.title ?? "unknown",
		};
		const row = columns.map((column) => cell(values[column] ?? "unknown"));
		// One lane, one launch, one row: a second call for the same launch would be counted twice by
		// the digest, so it is refused and nothing is written.
		const already = fileLines.slice(1).some((line) => {
			if (line.trim() === "") return false;
			const cells = line.split("\t");
			return cells[laneColumn] === values["lane"] && cells[launchedColumn] === values["launched_at"];
		});
		if (already) {
			ctx.io.err(`muster lane-outcome: ${values["lane"]} already has a row for ${values["launched_at"]} in ${path}; nothing was written`);
			return 4;
		}
		appendFsyncedLineTo(path, `${row.join("\t")}\n`);

		if (missing.length > 0) {
			ctx.io.err(`muster lane-outcome: ${path} has no ${missing.join(", ")} column yet; the row was written without them`);
		}
		if (ctx.json) ctx.io.out(JSON.stringify({ lane: record.laneId, outcome, rounds, row: Object.fromEntries(columns.map((column, index) => [column, row[index]])), file: path }, null, 2));
		else ctx.io.out(`muster lane-outcome: ${record.laneId} ${outcome} (${values["class"]}, ${values["model"]}, ${values["task_kind"]}) -> ${path}`);
		return 0;
	},
};
