/**
 * A stdio MCP server over the pi-toolbelt CLI, for Claude Code and Hermes.
 *
 * It is a thin adapter. The CLI stays the only owner of providers, accounts, policy, redaction and the
 * ledger; this server runs it exactly as the Pi wrapper does, through the same run engine
 * (`toolbelt-run.ts`: deadlines, hints, result rendering, payload preservation) and with the
 * same description and parameters (`toolbelt-tool-spec.ts`), which are imported, never copied.
 * It adds only what an MCP client needs:
 *   - one tool, `toolbelt`, with the same actions as `pi_toolbelt`;
 *   - the CALLER's `cwd`, required as in memory/bin/mcp-server.ts (M6): the server is launched by a client,
 *     often from `/`, so its own cwd is meaningless and a missing, empty or relative `cwd` is refused;
 *   - ledger attribution: the CLI's `--agent` is `claude-code` or `hermes` (from `--agent`, else the client's
 *     own name), never `pi`;
 *   - output under Claude Code's MCP limit: text past 24,000 characters is cut and the whole of it goes to a
 *     0600 file named in the text (Claude Code warns above 10,000 tokens and saves anything over 50,000
 *     characters to a file of its own);
 *   - an abort or a timeout reaching the CLI: the CLI runs in its own process group, which is killed.
 *
 * It never reads or logs a tool argument. Secret-shaped input is refused by the CLI before any provider runs.
 * stdout carries the protocol and nothing else; diagnostics go to stderr.
 *
 * Known limits, recorded by the HR22 review and not changed here:
 *   - the CLI's own meta probes (the ones that read the catalogue before a call) are attributed to
 *     `pi-extension-meta` in the ledger for every caller, so they do not show as `claude-code` or `hermes`;
 *   - the auto-start guard below tests only that `process.argv[1]` ends in `server.ts` or `server.js`, so a launch
 *     through a symlink or wrapper with another name imports the module and does not serve, and any other script
 *     named `server.js` that imports this one would start it.
 */
import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Value } from "typebox/value";
import { createToolbeltRunner, type ToolbeltExec } from "../toolbelt-run.ts";
import { TOOLBELT_PARAMS_SCHEMA, TOOLBELT_TOOL_DESCRIPTION, type ToolbeltParams } from "../toolbelt-tool-spec.ts";

/** Inline text cap, in characters: well under Claude Code's 10,000-token warning for the densest text. */
export const MCP_TEXT_CAP = 24_000;
/** The CLI's own rule for `--agent`, so a name it would refuse stops the server at startup instead of a call. */
const AGENT_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const OUTPUT_LIMIT_BYTES = 32 * 1024 * 1024;
/** How long a session's preserved payloads are kept. They exist so a cut result can be re-read, not as a record. */
export const PAYLOAD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** The directory names this server gives a session (`<agent>-<pid>-<start>`): only these are ever pruned. */
const SESSION_DIR_PATTERN = /^[A-Za-z0-9._-]+-\d+-\d+$/;
const KILL_GRACE_MS = 2_000;

const CWD_ERROR = "cwd is required: pass the calling project's absolute working directory. The server's own cwd is not a substitute for it.";
const CWD_DESCRIPTION = "The CALLING project's absolute working directory. Required. For action 'run'/'call' it is also the provider CLI's working directory.";

type SchemaShape = { type: string; properties: Record<string, unknown>; required?: string[] };
const base = JSON.parse(JSON.stringify(TOOLBELT_PARAMS_SCHEMA)) as SchemaShape;
/** The shared parameters, with `cwd` required and described for a caller that is not Pi. */
export const MCP_INPUT_SCHEMA = {
	...base,
	properties: { ...base.properties, cwd: { type: "string", description: CWD_DESCRIPTION } },
	required: [...new Set([...(base.required ?? []), "cwd"])],
};

export interface ToolbeltServerOptions {
	/** Ledger name. Default: the connecting client's own name. */
	agent?: string;
	/** The pi-toolbelt binary. Default: PI_TOOLBELT_BIN or the CLI beside this file (S9). */
	bin?: string;
	/** Where payloads past the cap are kept. Default: PI_TOOLBELT_MCP_STATE or <toolbelt home>/state/mcp. */
	stateDir?: string;
	exec?: ToolbeltExec;
}

function toolbeltHome(): string {
	return process.env.PI_TOOLBELT_HOME ?? join(homedir(), ".pi", "agent", "toolbelt");
}

/**
 * Collects a child's output as bytes and decodes it once at the end, so a multibyte character split across pipe
 * chunks stays whole. The limit counts bytes. A chunk that would pass it is dropped and so is everything after it,
 * so the text is a prefix of the output and never has a hole.
 */
export function createOutputCollector(limitBytes: number): { push(chunk: Buffer): void; text(): string } {
	const chunks: Buffer[] = [];
	let size = 0;
	let full = false;
	return {
		push(chunk) {
			if (full) return;
			if (size + chunk.length > limitBytes) {
				full = true;
				return;
			}
			chunks.push(chunk);
			size += chunk.length;
		},
		text: () => Buffer.concat(chunks).toString("utf8"),
	};
}

/**
 * Removes the preserved-payload directories of sessions that ended long ago. Every session leaves one under
 * `<state>/toolbelt-results/` (Pi's own payloads live in Pi's session directories and go with those, so this is the
 * MCP server's own state and nothing else prunes it). Only a real directory named as this server names a session is
 * touched, by its own modification time, and a link is never followed. Returns the names removed.
 */
export function pruneStalePayloads(stateDir: string, now: number, maxAgeMs: number = PAYLOAD_MAX_AGE_MS): string[] {
	const root = join(stateDir, "toolbelt-results");
	const removed: string[] = [];
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return removed;
	}
	for (const name of names) {
		if (!SESSION_DIR_PATTERN.test(name)) continue;
		try {
			const stat = lstatSync(join(root, name));
			if (!stat.isDirectory() || now - stat.mtimeMs <= maxAgeMs) continue;
			rmSync(join(root, name), { recursive: true, force: true });
			removed.push(name);
		} catch {
			// One entry that cannot be read or removed does not stop the rest.
		}
	}
	return removed;
}

/** Run a command in its own process group so an abort or a timeout takes the CLI and the provider it started. */
export const spawnExec: ToolbeltExec = (command, args, options) =>
	new Promise((resolve) => {
		const child = spawn(command, args, { cwd: options.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: process.env });
		const stdout = createOutputCollector(OUTPUT_LIMIT_BYTES);
		const stderr = createOutputCollector(OUTPUT_LIMIT_BYTES);
		let spawnError = "";
		let killed = false;
		let escalate: NodeJS.Timeout | undefined;
		const stop = () => {
			if (killed || child.pid === undefined) return;
			killed = true;
			const group = -child.pid;
			try { process.kill(group, "SIGTERM"); } catch { /* already gone */ }
			escalate = setTimeout(() => { try { process.kill(group, "SIGKILL"); } catch { /* already gone */ } }, KILL_GRACE_MS);
			escalate.unref();
		};
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		const timer = options.timeout !== undefined ? setTimeout(stop, options.timeout) : undefined;
		const onAbort = () => stop();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) stop();
		const finish = (code: number) => {
			if (timer) clearTimeout(timer);
			if (escalate) clearTimeout(escalate);
			options.signal?.removeEventListener("abort", onAbort);
			resolve({ stdout: stdout.text(), stderr: stderr.text() + spawnError, code, killed });
		};
		child.on("error", (error) => { spawnError = error.message; finish(127); });
		child.on("close", (code, signal) => finish(code ?? (signal ? 1 : 0)));
	});

/** Why a path cannot be a working directory, or undefined when it can. */
function directoryProblem(path: string): string | undefined {
	try {
		return statSync(path).isDirectory() ? undefined : "is not a directory";
	} catch {
		return "does not exist or cannot be read";
	}
}

function sanitizeAgent(name: string | undefined): string | undefined {
	const cleaned = (name ?? "").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
	return AGENT_PATTERN.test(cleaned) ? cleaned : undefined;
}

export function createToolbeltServer(options: ToolbeltServerOptions = {}): Server {
	if (options.agent !== undefined && !AGENT_PATTERN.test(options.agent)) {
		throw new Error(`toolbelt mcp: --agent "${options.agent}" is not a name the toolbelt ledger accepts (letters, digits, . _ -, up to 64).`);
	}
	const bin = options.bin ?? process.env.PI_TOOLBELT_BIN ?? join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "pi-toolbelt");
	const stateDir = options.stateDir ?? process.env.PI_TOOLBELT_MCP_STATE ?? join(toolbeltHome(), "state", "mcp");
	try {
		mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	} catch {
		// Without a payload directory a truncated result says so in its own text; the call still runs.
	}
	pruneStalePayloads(stateDir, Date.now());
	const runner = createToolbeltRunner({ exec: options.exec ?? spawnExec, bin, textCap: MCP_TEXT_CAP });
	const startedAt = Date.now();
	const server = new Server({ name: "pi-toolbelt", version: "0.1.0" }, { capabilities: { tools: {} } });

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [{ name: "toolbelt", description: TOOLBELT_TOOL_DESCRIPTION, inputSchema: MCP_INPUT_SCHEMA }],
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const refuse = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
		if (request.params.name !== "toolbelt") return refuse(`toolbelt mcp: no tool named "${request.params.name}".`);
		const args = (request.params.arguments ?? {}) as Record<string, unknown>;

		const cwd = typeof args.cwd === "string" ? args.cwd.trim() : "";
		if (cwd.length === 0) return refuse(CWD_ERROR);
		if (!isAbsolute(cwd)) return refuse(`${CWD_ERROR} Got "${cwd}", which is not an absolute path.`);
		// A spawn in a directory that is gone fails with ENOENT, which the CLI wrapper reports as the toolbelt's own failure.
		const kind = directoryProblem(cwd);
		if (kind !== undefined) return refuse(`${CWD_ERROR} Got "${cwd}", which ${kind}.`);

		// The shared schema decides what a well-formed call is. Only the path and the rule are reported, never the value.
		if (!Value.Check(TOOLBELT_PARAMS_SCHEMA, args)) {
			const issues = [...Value.Errors(TOOLBELT_PARAMS_SCHEMA, args)].slice(0, 5).map((issue) => `${issue.instancePath || "/"} ${issue.message}`);
			return refuse(`toolbelt mcp: invalid arguments: ${issues.join("; ")}`);
		}

		const agent = options.agent ?? process.env.PI_TOOLBELT_AGENT ?? sanitizeAgent(server.getClientVersion()?.name) ?? "mcp";
		try {
			const result = await runner.runToolbelt({ ...args, cwd } as ToolbeltParams, {
				cwd,
				signal: extra.signal,
				agent,
				session: { sessionDir: stateDir, sessionId: `${agent}-${process.pid}-${startedAt}` },
			});
			return { content: [{ type: "text" as const, text: result.text }], isError: !result.ok || result.infrastructureFailure !== undefined };
		} catch (error) {
			return refuse(`toolbelt mcp: the call failed unexpectedly (${error instanceof Error ? error.name : "error"}).`);
		}
	});

	return server;
}

function agentFromArgv(argv: string[]): string | undefined {
	const index = argv.indexOf("--agent");
	return index !== -1 ? argv[index + 1] : undefined;
}

async function main(): Promise<void> {
	const server = createToolbeltServer({ agent: agentFromArgv(process.argv) });
	await server.connect(new StdioServerTransport());
}

// Only start when run as the server itself, so tests can import the factory.
if (process.argv[1] && /server\.(ts|js)$/.test(process.argv[1])) {
	main().catch((error) => {
		console.error(`pi-toolbelt mcp server failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 2;
	});
}
