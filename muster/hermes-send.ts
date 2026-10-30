/**
 * `hermes send` with the text on stdin: the Discord transport the digest, the relay and
 * the tick's alerts already use.
 *
 * One owner. It lived in `bin/muster-tick.mts` until WAKE1 (the waker's outage alert uses
 * the same transport); a second copy there would have been a second way to speak to
 * Discord. Six sends in one tick pass fit the unit's 90 s start timeout at the default.
 */

import { spawn } from "node:child_process";

/** Send one message to a `hermes` target (`discord:<channel>:<thread>`). Never throws for a delivery failure. */
export function hermesSend(target: string, text: string, timeoutMs = 15_000): Promise<{ delivered: boolean; error?: string }> {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(process.env.PI_MUSTER_HERMES_BIN?.trim() || "hermes", ["send", "--to", target, "--json", "--file", "-"], { stdio: ["pipe", "pipe", "pipe"] });
		} catch (error) {
			resolve({ delivered: false, error: error instanceof Error ? error.message : String(error) });
			return;
		}
		let output = "";
		const timer = setTimeout(() => {
			// A child left running could still deliver after this alert was recorded as failed.
			child.kill("SIGKILL");
			resolve({ delivered: false, error: "hermes send timed out" });
		}, timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
		child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
		child.on("error", (error: Error) => {
			clearTimeout(timer);
			resolve({ delivered: false, error: error.message });
		});
		child.on("close", (code: number | null) => {
			clearTimeout(timer);
			resolve(code === 0 ? { delivered: true } : { delivered: false, error: `hermes send exit ${code}: ${output.slice(-300)}` });
		});
		child.stdin?.on("error", () => undefined);
		child.stdin?.end(text);
	});
}
