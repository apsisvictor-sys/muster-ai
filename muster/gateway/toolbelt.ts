/**
 * The gateway's `toolbelt` tool wiring (SK7a): the shared run engine
 * (`harness/toolbelt/toolbelt-run.ts`, `createToolbeltRunner`) over the pi-toolbelt CLI, with the
 * shared description and parameter schema (`harness/toolbelt/toolbelt-tool-spec.ts`) as the one owner
 * of what the tool says and accepts. This module adds only what a gateway process needs — the CLI's
 * path and a child-process exec that honours the engine's cwd, abort signal and wrapper deadline.
 *
 * The CLI stays the only owner of providers, accounts, policy, redaction and the ledger. The class
 * it classifies each command into travels back unchanged and stays advisory (SK-D13): the caller
 * asks the operator in chat before a mutating or destructive command, and the gateway adds no gate of its
 * own (a hard read-only limit is built only if the operator asks for one).
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createToolbeltRunner, type ToolbeltCall, type ToolbeltExec, type ToolbeltRunResult } from "../../toolbelt/toolbelt-run.ts";
import { TOOLBELT_PARAMS_SCHEMA, type ToolbeltParams } from "../../toolbelt/toolbelt-tool-spec.ts";

/**
 * The CLI's own output ceiling, as the MCP server applies it: a chunk that would pass the limit is
 * dropped and so is everything after it, so the collected text is a prefix of the output and never
 * has a hole. The engine's inline cap is far smaller; this is only the memory backstop.
 */
const OUTPUT_LIMIT_BYTES = 32 * 1024 * 1024;

/** How long a SIGTERM gets before the process group is killed outright. */
const KILL_GRACE_MS = 2_000;

/**
 * The toolbelt CLI the gateway runs. `PI_TOOLBELT_BIN` is the same override the MCP server reads, so
 * one setting points every surface at one binary.
 */
export function toolbeltBin(home: string = process.env["HOME"] ?? homedir()): string {
	return process.env["PI_TOOLBELT_BIN"]?.trim() || join(home, ".pi", "agent", "harness", "toolbelt", "bin", "pi-toolbelt");
}

/**
 * The injected run engine: the engine's own `runToolbelt` signature, so the gateway tool and the
 * tests call the same function (the tests build the real engine over a fake exec).
 */
export type GatewayToolbeltRun = (params: ToolbeltParams, call: ToolbeltCall) => Promise<ToolbeltRunResult>;

/**
 * The JSON schema the gateway advertises: the shared owner's schema as plain JSON, with the closed
 * object rule every gateway tool carries. It is converted, never re-declared, so what the model is
 * told about the tool cannot drift between the Pi tool, the MCP server and the gateway.
 */
export const TOOLBELT_INPUT_SCHEMA = {
	...(JSON.parse(JSON.stringify(TOOLBELT_PARAMS_SCHEMA)) as { type: "object"; properties: Record<string, unknown>; required?: string[] }),
	additionalProperties: false as const,
};

/**
 * Run the CLI in its own process group, so an abort or a deadline takes the CLI and the provider it
 * started. A deadline kill is reported as `killed`, which the engine already classifies as a
 * lifecycle fact; the CLI's own structured timeout envelope is preferred whenever it arrives first.
 */
export function spawnToolbeltExec(): ToolbeltExec {
	return (command, args, options) =>
		new Promise((resolve) => {
			const child = spawn(command, args, { cwd: options.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			let killed = false;
			let settled = false;
			let escalate: NodeJS.Timeout | undefined;
			let timer: NodeJS.Timeout | undefined;
			const stop = (): void => {
				if (killed || child.pid === undefined) return;
				killed = true;
				const group = -child.pid;
				try { process.kill(group, "SIGTERM"); } catch { /* already gone */ }
				escalate = setTimeout(() => { try { process.kill(group, "SIGKILL"); } catch { /* already gone */ } }, KILL_GRACE_MS);
				escalate.unref();
			};
			const finish = (code: number): void => {
				if (settled) return;
				settled = true;
				if (timer !== undefined) clearTimeout(timer);
				if (escalate !== undefined) clearTimeout(escalate);
				options.signal?.removeEventListener("abort", stop);
				resolve({ stdout, stderr, code, killed });
			};
			child.stdout?.on("data", (chunk: Buffer) => { if (stdout.length < OUTPUT_LIMIT_BYTES) stdout += chunk.toString("utf8"); });
			child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < OUTPUT_LIMIT_BYTES) stderr += chunk.toString("utf8"); });
			if (options.timeout !== undefined && options.timeout > 0) timer = setTimeout(stop, options.timeout);
			options.signal?.addEventListener("abort", stop, { once: true });
			if (options.signal?.aborted === true) stop();
			child.on("error", (error) => { stderr += `${stderr === "" ? "" : "\n"}${error.message}`; finish(127); });
			child.on("close", (code) => finish(code ?? 1));
		});
}

/** The gateway's own engine: one `pi-toolbelt` dispatch per call, attributed to the gateway in the CLI's ledger. */
export function createGatewayToolbelt(options: { bin?: string; exec?: ToolbeltExec; textCap?: number } = {}): GatewayToolbeltRun {
	const runner = createToolbeltRunner({
		bin: options.bin ?? toolbeltBin(),
		exec: options.exec ?? spawnToolbeltExec(),
		...(options.textCap !== undefined ? { textCap: options.textCap } : {}),
	});
	return runner.runToolbelt;
}
