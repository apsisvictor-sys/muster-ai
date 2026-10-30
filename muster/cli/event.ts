/**
 * `muster event <KIND> <lane> [detail]` — the one writer of an orchestrator event
 * line (LC9, LC0-R8).
 *
 * The line's shape is `extensions/muster/lane-report.ts`'s (`formatEventLine`), and
 * this verb writes it through that owner: the events file in files mode, one
 * `muster.event` entry in ledger mode, the spool while `musterd` is down. night-watch
 * and the lane-worker fallback call this instead of appending the log themselves, so
 * one process is the writer and a ledger-mode waiter is woken by what they write.
 *
 * Files mode keeps today's bytes: the same `date -Iseconds` prefix and the same line.
 */

import { EVENT_KINDS, formatEventLine, recordOrchestratorEvent, type EventKind } from "../lane-report.ts";
import { musterStateDir } from "../binding.ts";
import { parseFlags, type CliCommand } from "./types.ts";

/** `REVIEW READY`, `stalled` and `review-ready` all name one kind; anything else is refused. */
function eventKind(word: string): EventKind | undefined {
	const normalized = word.trim().toUpperCase().replace(/-/g, " ").replace(/\s+/g, " ");
	return (EVENT_KINDS as readonly string[]).includes(normalized) ? (normalized as EventKind) : undefined;
}

export const command: CliCommand = {
	name: "event",
	summary: "Append one orchestrator event line through its owner",
	usage: [
		"muster event <KIND> <lane> [detail]",
		`  kind: ${EVENT_KINDS.join(", ")}`,
		"  the line is `<date -Iseconds> <KIND>: <lane> | <detail>`, the one format",
		"  `orchestrator-events.log` carries; in ledger mode the same line is one",
		"  `muster.event` entry, and the event is kept for replay while musterd is down.",
	].join("\n"),
	async run(ctx) {
		// `--` keeps a detail that starts with a dash out of the flag parser.
		const parsed = parseFlags(ctx.argv, []);
		const [kindWord, lane, ...rest] = parsed.positionals;
		const kind = kindWord === undefined ? undefined : eventKind(kindWord);
		if (kind === undefined) {
			ctx.io.err(`muster event: a kind is required and must be one of ${EVENT_KINDS.join(", ")}\n${command.usage}`);
			return 2;
		}
		if (lane === undefined || lane.trim() === "") {
			ctx.io.err(`muster event: a lane is required\n${command.usage}`);
			return 2;
		}
		const line = formatEventLine(kind, lane.trim(), rest.join(" "));
		const outcome = recordOrchestratorEvent(musterStateDir(), line);
		if (outcome === "spooled") {
			// DL6: the event is kept and written when musterd starts, so this is not a failure.
			ctx.io.out(`muster event: musterd is down; the event is kept and written when it starts: ${line}`);
			return 0;
		}
		if (outcome === false) {
			ctx.io.err(`muster event: the event could not be written: ${line}`);
			return 1;
		}
		ctx.io.out(line);
		return 0;
	},
};
