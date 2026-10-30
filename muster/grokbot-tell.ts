/**
 * How a scheduled process (the tick, the janitor) sends through the one send path: it runs
 * `muster send`, so that path writes the inbox and owns the wake. Neither process writes an inbox
 * itself.
 *
 * One sender, two addresses. Henry's inbox (`grokbot`) is batched to at most one assigned issue an
 * hour for these senders (`grokbot-wake.ts`). The orchestrator's inbox (`orchestrator`) is the one
 * `muster wait --inbox orchestrator` reads, so a message there in `wake` mode is a wake (UBEMPTY,
 * VR24-215).
 */

import { spawnSync } from "node:child_process";
import { musterLauncher } from "../core/pi-ports.ts";
import { GATEWAY_AGENT_ID } from "./gateway/state.ts";
import { ORCHESTRATOR_ADDRESS } from "./lane-report.ts";

/** The text goes on stdin, so a line that starts with a dash or runs long needs no quoting. `--no-verify` returns once the bus has taken the message. */
function sendViaMuster(stateDir: string, from: string, to: string, text: string, idempotencyKey: string): void {
	const result = spawnSync(musterLauncher(), ["--agent", from, "send", to, "--stdin", "--mode", "wake", "--key", idempotencyKey, "--no-verify"], {
		encoding: "utf8",
		input: text,
		timeout: 60_000,
		env: { ...process.env, PI_MUSTER_STATE_DIR: stateDir },
	});
	if (result.status === 0) return;
	const detail = `${result.error?.message ?? ""}${result.stderr ?? ""}`.trim().split("\n")[0] ?? "";
	throw new Error(`muster send exited ${result.status ?? "without a status"}${detail === "" ? "" : `: ${detail}`}`);
}

/** One line into Henry's inbox, in wake mode (his messenger batches these senders). */
export function tellGrokbot(stateDir: string, from: string, text: string, idempotencyKey: string): void {
	sendViaMuster(stateDir, from, GATEWAY_AGENT_ID, text, idempotencyKey);
}

/** One line into the orchestrator's inbox, in wake mode: the wake the holder's own waiter turns into a turn. */
export function tellOrchestrator(stateDir: string, from: string, text: string, idempotencyKey: string): void {
	sendViaMuster(stateDir, from, ORCHESTRATOR_ADDRESS, text, idempotencyKey);
}
