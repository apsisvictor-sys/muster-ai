/**
 * `muster launch-check` — may this process start a lane with the launcher?
 *
 * `scripts/pi-lane-launch.sh` asks before it launches, so the script holds no seat
 * logic (seats blueprint, Privileges 3). The answer is the lane-control one: from
 * inside an agent session only the orchestrator seat launches; the operator's shell and
 * services pass; a seat nobody ever claimed (epoch 0) changes nothing. The launcher
 * skips the question for a resume (`--resume-brief`, which `muster send` uses for a
 * parked lane), `--unregister` and `--dry-run`.
 */

import { authorizeLaneControl, seatContextFor } from "../seats.ts";
import type { CliCommand } from "./types.ts";

/** The exit code of a refusal; the launcher passes it on. */
const REFUSED_EXIT = 2;

export const command: CliCommand = {
	name: "launch-check",
	summary: "Ask whether this process may launch a lane (the launcher calls this)",
	usage: "muster launch-check",
	async run(ctx) {
		const seat = authorizeLaneControl(ctx.env, seatContextFor(ctx.env));
		if (!seat.allowed) {
			ctx.io.err(`muster launch-check: launching a lane is refused: ${seat.message}`);
			return REFUSED_EXIT;
		}
		return 0;
	},
};
