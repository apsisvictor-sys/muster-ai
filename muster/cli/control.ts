/**
 * `muster control <lane> <verb>` — the orchestrator's control verbs (A2 §4.5,
 * acceptance check 5).
 *
 * One request per call, written to `<muster state dir>/control/<lane>.json`
 * through the one owner (`lib/lane-control.ts`) and taken by the lane's own
 * heartbeat. Nothing is typed into a TUI and nothing is sent as free text: the
 * lane applies `abort`, `stop` or `setModel` through the same handler its
 * Concord `details.control` envelope uses.
 *
 * Which verb works on which harness is not decided here: the parity table in
 * `lib/lane-control.ts` answers it, so a refusal carries the table's reason and
 * its stated substitute. A harness whose lane does not read the queue is
 * applied by this CLI through its own adapter (Claude: `stopClaudeLane`).
 *
 * A lane without a card cannot be reached by the bus, so the command refuses
 * rather than leaving a request nobody will ever read.
 */

import { readLaneCard } from "../lib/lane-card.ts";
import { enqueueLaneControl, laneControlDecision, normalizeLaneControlOperation, operatorSessionRefusal } from "../lib/lane-control.ts";
import { sessionUntouchable } from "../lane-lifecycle.ts";
import { closeLaneLive } from "../lane-lifecycle-ports.ts";
import { authorizeLaneControl, seatContextFor } from "../seats.ts";
import { lanesCardsDir, lanesDirectoryRow, lanesStateDir } from "./lanes.ts";
import { parseFlags, type CliCommand } from "./types.ts";

const VALUE_FLAGS = ["from"];

export const command: CliCommand = {
	name: "control",
	summary: "Queue one control verb for a lane (abort, stop, set-model <model-id>)",
	usage: [
		"muster control <lane> abort [--from <agent>] [--json]",
		"muster control <lane> stop [--from <agent>] [--json]        # every harness: stops the process, kills the window, removes the registry row and the Concord agent, closes the lane as abandoned",
		"muster control <lane> set-model <model-id> [--from <agent>] [--json]",
		"  a Pi or OpenCode lane applies abort and set-model within one poll (2 s); stop waits up to 60 s for its pane to end, then kills the window",
		"  a verb a harness cannot do is refused with the reason and the path to use instead",
	].join("\n"),
	async run(ctx) {
		const parsed = parseFlags(ctx.argv, VALUE_FLAGS);
		const laneId = parsed.positionals[0]?.trim();
		const verbWord = parsed.positionals[1]?.trim();
		if (laneId === undefined || laneId === "" || verbWord === undefined || verbWord === "") {
			ctx.io.err(`muster control: a lane and a verb are required\n${command.usage}`);
			return 2;
		}
		const operation = normalizeLaneControlOperation(verbWord);
		if (operation === undefined) {
			ctx.io.err(`muster control: unknown verb ${verbWord} (abort, stop, set-model)\n${command.usage}`);
			return 2;
		}
		let params: Record<string, unknown> | undefined;
		if (operation === "setModel") {
			const modelId = parsed.positionals[2]?.trim();
			if (modelId === undefined || modelId === "") {
				ctx.io.err(`muster control: set-model needs a model id\n${command.usage}`);
				return 2;
			}
			params = { modelId };
		}
		// From inside an agent session only the orchestrator seat controls lanes (seats blueprint, Privileges 3).
		const seat = authorizeLaneControl(ctx.env, seatContextFor(ctx.env));
		if (!seat.allowed) {
			ctx.io.err(`muster control: ${operation} is refused: ${seat.message}`);
			return 2;
		}
		// The same root the CLI's lane table reads: PI_MUSTER_STATE_DIR wins.
		const stateDir = lanesStateDir(ctx.env);
		const cardsDir = lanesCardsDir(ctx.env);
		// the operator's own sessions are read-only on the bus (LD2): refused before anything else is looked up.
		const origin = lanesDirectoryRow(ctx.env, laneId)?.origin;
		const mine = operatorSessionRefusal(origin);
		if (mine !== undefined) {
			ctx.io.err(`muster control: ${operation} is refused on ${laneId}: ${mine.reason}`);
			return 2;
		}
		const card = readLaneCard(stateDir, laneId);
		if (card === undefined) {
			ctx.io.err(`muster control: no lane ${laneId} in ${cardsDir} (an unenrolled lane has no card to read the verb from)`);
			return 3;
		}
		// One decision owner: the parity table. A harness that cannot do the verb
		// is refused with the table's reason and the substitute it names.
		const decision = laneControlDecision(card.harness, operation, origin, sessionUntouchable({ stateDir, laneId, ...(origin !== undefined ? { registryRow: { origin } } : {}) })?.detail);
		if (!decision.allowed) {
			ctx.io.err(`muster control: ${operation} is not available on a ${card.harness} lane: ${decision.reason}\n  instead: ${decision.substitute}`);
			return 2;
		}
		const from = parsed.values.get("from")?.trim() ?? ctx.agentId ?? undefined;
		if (operation === "stop") {
			const caller = from !== undefined && from !== "" ? from : "muster control";
			const closed = await closeLaneLive(stateDir, laneId, { park: false, terminal: { outcome: "abandoned", reason: `stopped by ${caller}` }, caller }, ctx.env);
			if (ctx.json) {
				ctx.io.out(JSON.stringify({ laneId, operation, appliedBy: "close-lane", ok: closed.ok, phase: closed.phase ?? null, steps: closed.steps, warnings: closed.warnings }, null, 2));
				return closed.ok ? 0 : 3;
			}
			if (!closed.ok) {
				ctx.io.err(`muster control: ${laneId} was not stopped: ${closed.detail}`);
				return 3;
			}
			ctx.io.out(`muster control: ${closed.detail}`);
			return 0;
		}
		const file = enqueueLaneControl(stateDir, {
			laneId,
			operation,
			...(params !== undefined ? { params } : {}),
			...(from !== undefined && from !== "" ? { from } : {}),
		});
		if (ctx.json) {
			ctx.io.out(JSON.stringify({ laneId, operation, params: params ?? null, from: from ?? null, file }, null, 2));
			return 0;
		}
		ctx.io.out(`muster control: ${operation}${params === undefined ? "" : ` ${String(params["modelId"])}`} queued for ${laneId} (${file})`);
		return 0;
	},
};
