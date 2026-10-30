/**
 * `muster goals` — the goal registry, read and written (command center blueprint r5, D1).
 *
 * The read side lists the open goals and shows one whole; `--json` prints the records for the page's
 * composer and for the architect's save before a revert. The write side adds a goal, edits its
 * stations, sets its colour, attaches and detaches lanes, finishes and reopens a station, links a
 * goal to an ask it waits on, and closes it. Every write goes through `goals.ts`, and every one is
 * refused unless this process may write goals: the operator's shell, the architect or the orchestrator. A
 * lane is refused.
 */

import { musterStateDir } from "../binding.ts";
import { readAsks, resolveAskRef } from "../asks.ts";
import {
	GOAL_COLOURS,
	addGoal,
	attachLane,
	closeGoal,
	currentStation,
	detachLane,
	finishStation,
	goalStore,
	listGoals,
	readGoal,
	reopenStation,
	resolveGoalWriter,
	setGoalColour,
	setStation,
	unwaitOn,
	waitOn,
	type GoalContext,
	type GoalRecord,
} from "../goals.ts";
import { parseFlags, type CliCommand, type CliContext } from "./types.ts";

const VALUE_FLAGS = ["name", "sub", "project", "colour", "station", "owner", "timer", "before", "outcome"];
const SUBCOMMANDS = ["add", "station", "colour", "attach", "detach", "finish", "reopen", "wait", "unwait", "close", "list", "show"] as const;

export const command: CliCommand = {
	name: "goals",
	summary: "Read the goal registry, or add a goal, edit its stations and lanes, set its colour, finish a station, link an ask, or close it",
	usage: [
		"muster goals list [--all] [--json]            # open goals; --all adds the closed ones",
		"muster goals show <code> [--json]",
		`muster goals add <code> --name <n> --sub <s> --project <id> [--colour <${GOAL_COLOURS.join("|")}>] --station <id>=<name> [--station …]`,
		"muster goals station <code> <id> [--name <n>] [--owner <o>] [--timer <unit.timer>] [--before <id>]   # adds or edits; an empty value clears owner or timer",
		`muster goals colour <code> <${GOAL_COLOURS.join("|")}>   # a key another open goal holds is refused`,
		"muster goals attach <code> <lane> --station <id>   # a lane on another open goal moves here",
		"muster goals detach <code> <lane>",
		"muster goals finish <code> <station>   |   muster goals reopen <code> <station>",
		"muster goals wait <code> <ask id|code>   |   muster goals unwait <code> <ask id|code>",
		"muster goals close <code> --outcome done|dropped",
		"  a code is two capital letters; the writer is the process: the operator's shell, the architect or the orchestrator (a lane is refused)",
	].join("\n"),
	async run(ctx) {
		const parsed = parseFlags(ctx.argv, VALUE_FLAGS);
		const subcommand = parsed.positionals[0];
		if (subcommand === undefined || !(SUBCOMMANDS as readonly string[]).includes(subcommand)) {
			ctx.io.err(`muster goals: ${subcommand === undefined ? "a subcommand is required" : `unknown subcommand ${subcommand}`}\n${command.usage}`);
			return 2;
		}
		const fail = (message: string): number => {
			ctx.io.err(`muster goals ${subcommand}: ${message}`);
			return 2;
		};
		const store = goalStore();
		const code = parsed.positionals[1]?.trim() ?? "";
		try {
			if (subcommand === "list") {
				const listing = listGoals(store, { all: parsed.flags.has("all") });
				if (ctx.json) ctx.io.out(JSON.stringify(listing.goals, null, 2));
				else if (listing.goals.length === 0) ctx.io.out("no goals");
				else for (const goal of listing.goals) ctx.io.out(goalLine(goal));
				for (const skipped of listing.skipped) ctx.io.err(`skipped ${skipped.id}: ${skipped.error}`);
				return 0;
			}
			if (code === "") return fail("a goal code is required");
			if (subcommand === "show") {
				const goal = readGoal(store, code);
				if (goal === undefined) return fail(`no goal ${code}`);
				ctx.io.out(ctx.json ? JSON.stringify(goal, null, 2) : goalDetail(goal));
				return 0;
			}
			const writer = resolveGoalWriter(ctx.env, ctx.agentId);
			if ("error" in writer) return fail(writer.error);
			const context: GoalContext = { by: writer.writer };
			const arg = (index: number, what: string): string => {
				const value = parsed.positionals[index]?.trim();
				if (value === undefined || value === "") throw new Error(`${what} is required`);
				return value;
			};
			let result: GoalRecord;
			switch (subcommand) {
				case "add":
					result = addGoal(store, {
						code,
						name: parsed.values.get("name") ?? "",
						sub: parsed.values.get("sub") ?? "",
						project: parsed.values.get("project") ?? "",
						...(parsed.values.get("colour") !== undefined ? { colour: parsed.values.get("colour")! } : {}),
						stations: (parsed.multi.get("station") ?? []).map(parseStation),
					}, context);
					break;
				case "station":
					result = setStation(store, code, {
						id: arg(2, "a station id"),
						...(parsed.values.get("name") !== undefined ? { name: parsed.values.get("name")! } : {}),
						...(parsed.values.get("owner") !== undefined ? { owner: parsed.values.get("owner")! } : {}),
						...(parsed.values.get("timer") !== undefined ? { timer: parsed.values.get("timer")! } : {}),
						...(parsed.values.get("before") !== undefined ? { before: parsed.values.get("before")! } : {}),
					}, context);
					break;
				case "colour":
					result = setGoalColour(store, code, arg(2, "a colour"), context);
					break;
				case "attach": {
					const attached = attachLane(store, code, arg(2, "a lane"), parsed.values.get("station")?.trim() ?? "", context);
					if (attached.movedFrom.length > 0) ctx.io.out(`moved from ${attached.movedFrom.join(", ")}`);
					result = attached.goal;
					break;
				}
				case "detach":
					result = detachLane(store, code, arg(2, "a lane"), context);
					break;
				case "finish":
					result = finishStation(store, code, arg(2, "a station"), context);
					break;
				case "reopen":
					result = reopenStation(store, code, arg(2, "a station"), context);
					break;
				case "wait":
				case "unwait": {
					const id = askIdOf(arg(2, "an ask id or code"));
					result = subcommand === "wait" ? waitOn(store, code, id, context) : unwaitOn(store, code, id, context);
					break;
				}
				default:
					result = closeGoal(store, code, parsed.values.get("outcome") ?? "", context);
			}
			ctx.io.out(ctx.json ? JSON.stringify(result, null, 2) : `${subcommand} ${result.code}: ${result.events.at(-1)?.detail ?? ""} (revision ${result.revision})`);
			return 0;
		} catch (error) {
			return fail(error instanceof Error ? error.message : String(error));
		}
	},
};

/** `--station <id>=<name>`. */
function parseStation(text: string): { id: string; name: string } {
	const at = text.indexOf("=");
	if (at < 1) throw new Error(`--station ${JSON.stringify(text)} must be <id>=<name>`);
	return { id: text.slice(0, at).trim(), name: text.slice(at + 1) };
}

/** An ask id, or a code that resolves to one live ask. */
function askIdOf(ref: string): string {
	const resolution = resolveAskRef(readAsks(musterStateDir()), ref);
	if ("ambiguous" in resolution) throw new Error(`code ${ref} belongs to ${resolution.ambiguous.length} live asks (${resolution.ambiguous.map((ask) => ask.id).join(", ")}); use the id`);
	if ("missing" in resolution) throw new Error(`no ask matches ${JSON.stringify(ref)}`);
	return resolution.ask.id;
}

function goalLine(goal: GoalRecord): string {
	const now = currentStation(goal);
	const state = goal.status === "open" ? (now === undefined ? "all stations finished" : `now ${now.id} (${now.name})`) : goal.status;
	return `${goal.code}  ${goal.colour}  ${goal.project}  ${goal.name} — ${state}`;
}

function goalDetail(goal: GoalRecord): string {
	const now = currentStation(goal);
	return [
		goalLine(goal),
		`  ${goal.sub}`,
		...goal.stations.map((station) => `  ${station.finishedAt !== undefined ? "[x]" : station.id === now?.id ? "[>]" : "[ ]"} ${station.id}  ${station.name}${station.owner !== undefined ? `  owner ${station.owner}` : ""}${station.timer !== undefined ? `  timer ${station.timer}` : ""}`),
		`  lanes: ${goal.lanes.length === 0 ? "none" : goal.lanes.map((row) => `${row.lane}@${row.station}`).join(", ")}`,
		`  waits on: ${goal.waitsOn.length === 0 ? "nothing" : goal.waitsOn.join(", ")}`,
		`  status: ${goal.status}${goal.closedAt !== undefined ? ` at ${goal.closedAt}` : ""}`,
	].join("\n");
}
