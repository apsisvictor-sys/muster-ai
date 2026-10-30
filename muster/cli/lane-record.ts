/**
 * `muster lane-record` — the owner's CLI face for a lane's record and the
 * launcher's registry.
 *
 * `launch` writes a lane's lifecycle record at launch (`recordLaunch` in
 * `lane-lifecycle.ts`). `title`, `sendback` and `accept` are D27's three writes of the
 * record's new fields, and they take the writer check the goal registry uses
 * (`resolveSeatWriter`): the operator's shell, the architect and the orchestrator write them, and a
 * lane is refused. `register`, `unregister` and `session` are the one write
 * and the two reads of the launcher's registry (`lib/lane-directory.ts`: LC5), so
 * `scripts/pi-lane-launch.sh` never opens `pi-lanes.json` itself and the same
 * calls work when the ledger is the store. `registry` prints the rows a reader
 * needs (night-watch), through the same owner.
 */

import { laneRegistryPath, readLaneRegistryRows, removeLaneRegistryRow, writeLaneRegistryRow } from "../lib/lane-directory.ts";
import { ACCEPTED, readLaneRecord, recordHandoff, recordLaunch, SENT_BACK, validateLaneTitle, writeLaneRecord } from "../lane-lifecycle.ts";
import { resolveSeatWriter } from "../seats.ts";
import { lanesStateDir } from "./lanes.ts";
import { parseFlags, type CliCommand } from "./types.ts";

const VALUE_FLAGS = ["lane", "harness", "cwd", "branch", "session", "repo-root", "launched-by", "launch-warning", "model", "class", "task-kind", "route-by", "title", "cause", "sha", "waits", "item"];

const USAGE = [
	"muster lane-record launch --lane <lane> --harness pi|opencode|claude --title <text> [--cwd <dir>] [--branch <name>] [--session <id>] [--repo-root <dir>] [--launched-by orchestrator|dispatcher|grokbot|<lane>] [--launch-warning <text>] [--model <ref>] [--class <flash|H1..H5>] [--task-kind <kind>] [--route-by <rule|orchestrator|failover>] [--item <code>] [--browser] [--conversation] [--json]",
	"  --item names the work item the lane serves, so a crash is resolved from the record instead of a relaunch (spec OL2)",
	"  --title says what the lane delivers, in plain words for the operator: one line, 3 to 80 characters; a new worker lane needs one",
	"  --browser marks a browser QA lane (Claude in Chrome): it must close its tabs before a turn ends (LD11)",
	"  --conversation marks a design or product session in talk with the operator (LD14): never parked or closed by the tick, never asked for a report, and it needs no title",
	"  --model, --class, --task-kind and --route-by state what the lane runs on and as which kind; a later launch replaces them, as it replaces the launch warning and never the title",
	"  creates the record in `working`, or brings a parked lane back to `working`; a finished record under the same name is archived first, so the next lane needs a title",
	"muster lane-record show <lane> [--json]                                # the lane's record through its owner, in either backend",
	"muster lane-record title-check <text>                                  # D27's title rule: the trimmed text, or its error (exit 3)",
	"muster lane-record title <lane> <text>                                 # replace the lane's title (D27)",
	"muster lane-record sendback <lane> [--cause <text>] [--sha <sha>] [--waits <text>]   # the work goes back to the lane",
	"muster lane-record accept <lane> [--sha <sha>] [--waits <text>]                     # accepted: the work waits for the merge",
	"  the title, a send-back and an acceptance are written by the operator's shell, the architect or the orchestrator; a lane is refused",
	"muster lane-record register <lane> --session <id> --harness <harness>   # register a running lane, or replace its session",
	"muster lane-record unregister <lane>                                   # remove a lane's row (the launcher's --unregister)",
	"muster lane-record session <lane>                                      # print the lane's registered session id, nothing when it has none",
	"muster lane-record registry [--json]                                   # print the registry rows",
].join("\n");

/** `register`/`unregister`/`session` take the lane positionally; `--lane` is accepted for the launch shape. */
function givenLane(parsed: ReturnType<typeof parseFlags>): string | undefined {
	const positional = parsed.positionals[1]?.trim();
	return positional !== undefined && positional !== "" ? positional : parsed.values.get("lane")?.trim() || undefined;
}

export const command: CliCommand = {
	name: "lane-record",
	summary: "Write a lane's lifecycle record at launch, and read or write the launcher's registry",
	usage: USAGE,
	async run(ctx) {
		const parsed = parseFlags(ctx.argv, VALUE_FLAGS);
		const subcommand = parsed.positionals[0];
		const stateDir = lanesStateDir(ctx.env);
		const value = (key: string): string | undefined => parsed.values.get(key)?.trim() || undefined;

		if (subcommand === "register") {
			const laneId = givenLane(parsed);
			const session = parsed.values.get("session")?.trim();
			const harness = parsed.values.get("harness")?.trim();
			if (laneId === undefined || session === undefined || session === "" || harness === undefined || harness === "") {
				ctx.io.err(`muster lane-record: register needs a lane, --session and --harness\n${command.usage}`);
				return 2;
			}
			try {
				writeLaneRegistryRow(stateDir, laneId, { sessionId: session, harness });
			} catch (error) {
				ctx.io.err(`muster lane-record: ${error instanceof Error ? error.message : String(error)}`);
				return 3;
			}
			if (ctx.json) ctx.io.out(JSON.stringify({ laneId, sessionId: session, harness, file: laneRegistryPath(stateDir) }, null, 2));
			else ctx.io.out(`muster lane-record: registered ${laneId} -> ${session} (${harness})`);
			return 0;
		}

		if (subcommand === "unregister") {
			const laneId = givenLane(parsed);
			if (laneId === undefined) {
				ctx.io.err(`muster lane-record: unregister needs a lane\n${command.usage}`);
				return 2;
			}
			try {
				removeLaneRegistryRow(stateDir, laneId);
			} catch (error) {
				ctx.io.err(`muster lane-record: ${error instanceof Error ? error.message : String(error)}`);
				return 3;
			}
			if (ctx.json) ctx.io.out(JSON.stringify({ laneId, removed: true, file: laneRegistryPath(stateDir) }, null, 2));
			else ctx.io.out(`muster lane-record: removed ${laneId} from the registry`);
			return 0;
		}

		if (subcommand === "session") {
			const laneId = givenLane(parsed);
			if (laneId === undefined) {
				ctx.io.err(`muster lane-record: session needs a lane\n${command.usage}`);
				return 2;
			}
			// Nothing when the lane has no row, exactly as the launcher's own reader answered: the
			// caller assigns an empty string and starts a fresh session.
			const row = readLaneRegistryRows(laneRegistryPath(stateDir), stateDir).get(laneId);
			if (row?.sessionId !== undefined) ctx.io.out(row.sessionId);
			return 0;
		}

		if (subcommand === "registry") {
			const rows: Record<string, unknown> = {};
			for (const [laneId, row] of readLaneRegistryRows(laneRegistryPath(stateDir), stateDir)) {
				rows[laneId] = { sessionId: row.sessionId ?? "", harness: row.harness ?? "pi", retired: row.retired === true };
			}
			if (ctx.json) ctx.io.out(JSON.stringify(rows, null, 2));
			else for (const [laneId, row] of Object.entries(rows)) ctx.io.out(`${laneId}\t${(row as { sessionId: string }).sessionId}\t${(row as { harness: string }).harness}`);
			return 0;
		}

		if (subcommand === "show") {
			const shown = givenLane(parsed);
			if (shown === undefined) {
				ctx.io.err(`muster lane-record: show needs a lane\n${command.usage}`);
				return 2;
			}
			const found = readLaneRecord(stateDir, shown);
			if (found === undefined) {
				ctx.io.err(`muster lane-record: no lane record for ${shown}`);
				return 3;
			}
			ctx.io.out(ctx.json ? JSON.stringify(found, null, 2) : `${shown}\t${found.phase}\t${found.title ?? ""}`);
			return 0;
		}

		if (subcommand === "title-check") {
			// D27's rule has one owner, `validateLaneTitle`, and the launcher asks it instead of counting characters
			// of its own: Python counts code points and JavaScript counts UTF-16 units, so a title at the length edge
			// (an emoji) would pass a shell-side check and then be refused by the record write after the lane had
			// started (VR24-178 R3). The raw text goes in, so an empty title gets the owner's own answer.
			const raw = parsed.positionals[2] ?? parsed.values.get("title");
			if (raw === undefined) {
				ctx.io.err(`muster lane-record: title-check needs the text\n${command.usage}`);
				return 2;
			}
			const checked = validateLaneTitle(raw);
			if ("error" in checked) {
				ctx.io.err(`muster lane-record: ${checked.error}`);
				return 3;
			}
			ctx.io.out(checked.title);
			return 0;
		}

		if (subcommand === "title" || subcommand === "sendback" || subcommand === "accept") {
			const laneId = givenLane(parsed);
			if (laneId === undefined) {
				ctx.io.err(`muster lane-record: ${subcommand} needs a lane\n${command.usage}`);
				return 2;
			}
			// The writer is the process, as for the goal registry and the ask queue: a lane never writes its own handoff.
			const writer = resolveSeatWriter(ctx.env, ctx.agentId, undefined, (named) =>
				`${named === "" ? "this session" : named} is not a seat: a lane's title, send-backs and acceptances are written by the operator's shell, the architect or the orchestrator, and a lane never writes one`,
			);
			if ("error" in writer) {
				ctx.io.err(`muster lane-record ${subcommand}: ${writer.error}`);
				return 2;
			}
			if (subcommand === "title") {
				const text = parsed.positionals[2] ?? value("title");
				if (text === undefined) {
					ctx.io.err(`muster lane-record: title needs a lane and the text\n${command.usage}`);
					return 2;
				}
				const valid = validateLaneTitle(text);
				if ("error" in valid) {
					ctx.io.err(`muster lane-record title: ${valid.error}`);
					return 2;
				}
				const existing = readLaneRecord(stateDir, laneId);
				if (existing === undefined) {
					ctx.io.err(`muster lane-record: no lane record for ${laneId}`);
					return 3;
				}
				writeLaneRecord(stateDir, { ...existing, title: valid.title });
				ctx.io.out(ctx.json ? JSON.stringify({ laneId, title: valid.title }, null, 2) : `muster lane-record: ${laneId} is "${valid.title}"`);
				return 0;
			}
			const cause = value("cause");
			const sha = value("sha");
			const waits = value("waits");
			try {
				recordHandoff(stateDir, laneId, {
					by: writer.writer,
					verdict: subcommand === "sendback" ? SENT_BACK : ACCEPTED,
					...(cause !== undefined ? { cause } : {}),
					...(sha !== undefined ? { sha } : {}),
					...(waits !== undefined ? { waits } : {}),
				});
			} catch (error) {
				ctx.io.err(`muster lane-record ${subcommand}: ${error instanceof Error ? error.message : String(error)}`);
				return 3;
			}
			const handed = readLaneRecord(stateDir, laneId);
			ctx.io.out(
				ctx.json
					? JSON.stringify(handed, null, 2)
					: `muster lane-record: ${laneId} ${subcommand === "sendback" ? "sent back" : "accepted"} (${handed?.handoffs?.length ?? 0} handoffs)`,
			);
			return 0;
		}

		if (subcommand !== "launch") {
			ctx.io.err(`muster lane-record: unknown subcommand ${JSON.stringify(subcommand ?? "")}\n${command.usage}`);
			return 2;
		}
		const laneId = parsed.values.get("lane")?.trim();
		const harness = parsed.values.get("harness")?.trim();
		if (laneId === undefined || laneId === "" || (harness !== "pi" && harness !== "opencode" && harness !== "claude")) {
			ctx.io.err(`muster lane-record: --lane and --harness (pi, opencode or claude) are required\n${command.usage}`);
			return 2;
		}
		const cwd = value("cwd");
		const sessionId = value("session");
		const repoRoot = value("repo-root");
		const launchWarning = value("launch-warning");
		const model = value("model");
		const laneClass = value("class");
		const taskKind = value("task-kind");
		const routeBy = value("route-by");
		const title = value("title");
		let record;
		try {
			record = recordLaunch(lanesStateDir(ctx.env), {
				laneId,
				harness,
				cwd: cwd ?? null,
				branch: value("branch") ?? null,
				...(sessionId !== undefined ? { sessionId } : {}),
				...(repoRoot !== undefined ? { repoRoot } : {}),
				launchedBy: value("launched-by") ?? "orchestrator",
				...(launchWarning !== undefined ? { launchWarning } : {}),
				...(model !== undefined ? { model } : {}),
				...(laneClass !== undefined ? { class: laneClass } : {}),
				...(taskKind !== undefined ? { taskKind } : {}),
				...(routeBy !== undefined ? { routeBy } : {}),
				...(title !== undefined ? { title } : {}),
				...(value("item") !== undefined ? { item: value("item")! } : {}),
				...(parsed.flags.has("browser") ? { browser: true } : {}),
				...(parsed.flags.has("conversation") ? { kind: "conversation" as const } : {}),
			});
		} catch (error) {
			ctx.io.err(`muster lane-record: ${error instanceof Error ? error.message : String(error)}`);
			return 3;
		}
		ctx.io.out(ctx.json ? JSON.stringify(record, null, 2) : `muster lane-record: ${laneId} is ${record.phase} (launched by ${record.launchedBy})`);
		return 0;
	},
};
