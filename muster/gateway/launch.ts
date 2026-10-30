/**
 * `lane_launch` runs `scripts/pi-lane-launch.sh` with a fixed argv and no shell. This module
 * turns the script's output into the one text the tool returns. A failed launch used to give
 * the last stderr line only, which is empty when the script dies under `set -e`; the progress
 * lines on stdout carry the reason.
 */

import { spawn } from "node:child_process";
import { redactSensitiveText } from "../../core/self-improving-redactor.ts";

/** How many trailing lines of each stream a failed launch reports. */
export const LAUNCH_TAIL_LINES = 8;
const LINE_LIMIT = 300;
const DETAIL_LIMIT = 3000;

const safeLine = (line: string): string => redactSensitiveText(line.length > LINE_LIMIT ? `${line.slice(0, LINE_LIMIT)}...` : line, { preservePaths: true, strictAssignments: true });

/** The last `count` non-empty lines of a stream, each cut and redacted. */
export function tailOutput(text: string, count: number = LAUNCH_TAIL_LINES): string[] {
	return text.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line !== "").slice(-count).map(safeLine);
}

/** The text of a finished launch: the last stdout line when it worked, the stream tails when it did not. */
export function launchDetail(result: { code: number | null; stdout: string; stderr: string }): { ok: boolean; detail: string } {
	if (result.code === 0) return { ok: true, detail: (tailOutput(result.stdout, 1)[0] ?? "started").slice(0, 500) };
	const parts = [`exit ${result.code}`];
	const out = tailOutput(result.stdout);
	const err = tailOutput(result.stderr);
	if (out.length > 0) parts.push(`stdout (last ${out.length} lines):`, ...out);
	if (err.length > 0) parts.push(`stderr (last ${err.length} lines):`, ...err);
	if (out.length === 0 && err.length === 0) parts.push("the script printed nothing");
	return { ok: false, detail: parts.join("\n").slice(0, DETAIL_LIMIT) };
}

/** Runs the launch script and reports as `launchDetail` does. Never throws. */
export function runLaunchScript(script: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ ok: boolean; detail: string }> {
	return new Promise((resolveLaunch) => {
		const child = spawn(script, args, { stdio: ["ignore", "pipe", "pipe"], ...(env !== undefined ? { env } : {}) });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		child.on("error", (error) => resolveLaunch({ ok: false, detail: safeLine(error.message) }));
		child.on("close", (code) => resolveLaunch(launchDetail({ code, stdout, stderr })));
	});
}
