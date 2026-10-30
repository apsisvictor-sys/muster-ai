/**
 * `muster close <lane> --abandoned "<reason>" | --merged` — end a lane for good.
 *
 * One path with `muster control <lane> stop`: both call `closeLane`
 * (`lane-lifecycle.ts`), which stops the process, kills the tmux window, removes
 * the registry row and the Concord agent, and records the lane as closed with
 * its terminal outcome. This command needs no card, so it also cleans up what a
 * stop used to leave behind (a dead window and a registry row).
 *
 * The orchestrator, the operator's own sessions and conversation sessions are refused by `closeLane`
 * (`sessionUntouchable`, LD17). `--end-conversation` lifts the conversation refusal only: the
 * orchestrator runs it when the operator ends the topic. No other caller sets it.
 */

import { closeLaneLive } from "../lane-lifecycle-ports.ts";
import { authorizeLaneControl, seatContextFor } from "../seats.ts";
import { lanesStateDir } from "./lanes.ts";
import { parseFlags, type CliCommand } from "./types.ts";

export const command: CliCommand = {
	name: "close",
	summary: "Stop a lane and clean up after it (window, registry row, Concord agent), recording how it ended",
	usage: [
		"muster close <lane> --abandoned \"<reason>\" [--from <agent>] [--json]",
		"muster close <lane> --merged [--from <agent>] [--json]",
		"muster close <conversation lane> --abandoned \"<reason>\" --end-conversation   (only when the operator has ended the topic)",
		"  stops the process the harness's own way (a Pi or OpenCode pane gets 60 s), kills the tmux window, removes the registry row and",
		"  marks the Concord agent done, then records the lane as closed. The lane record keeps the reason and the reported SHA.",
	].join("\n"),
	async run(ctx) {
		const parsed = parseFlags(ctx.argv, ["abandoned", "from"]);
		const laneId = parsed.positionals[0]?.trim();
		const abandoned = parsed.values.get("abandoned")?.trim();
		const merged = parsed.flags.has("merged");
		if (laneId === undefined || laneId === "") {
			ctx.io.err(`muster close: a lane is required\n${command.usage}`);
			return 2;
		}
		if (merged === (abandoned !== undefined)) {
			ctx.io.err(`muster close: give exactly one of --abandoned "<reason>" or --merged\n${command.usage}`);
			return 2;
		}
		if (abandoned !== undefined && abandoned === "") {
			ctx.io.err(`muster close: --abandoned needs a reason\n${command.usage}`);
			return 2;
		}
		// From inside an agent session only the orchestrator seat closes lanes (seats blueprint, Privileges 3).
		const seat = authorizeLaneControl(ctx.env, seatContextFor(ctx.env));
		if (!seat.allowed) {
			ctx.io.err(`muster close: refused: ${seat.message}`);
			return 2;
		}
		const caller = parsed.values.get("from")?.trim() || ctx.agentId || "muster close";
		const terminal = merged ? { outcome: "merged" as const, reason: `closed as merged by ${caller}` } : { outcome: "abandoned" as const, reason: abandoned! };
		const closed = await closeLaneLive(lanesStateDir(ctx.env), laneId, { park: false, terminal, caller, ...(parsed.flags.has("end-conversation") ? { endConversation: true } : {}) }, ctx.env);
		if (ctx.json) {
			ctx.io.out(JSON.stringify({ laneId, ok: closed.ok, phase: closed.phase ?? null, steps: closed.steps, warnings: closed.warnings, detail: closed.detail }, null, 2));
			return closed.ok ? 0 : 3;
		}
		if (!closed.ok) {
			ctx.io.err(`muster close: ${laneId} was not closed: ${closed.detail}`);
			return 3;
		}
		ctx.io.out(`muster close: ${closed.detail}`);
		return 0;
	},
};
