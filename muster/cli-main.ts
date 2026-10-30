/**
 * The `muster` command line, independent of how its commands are found.
 *
 * `scripts/muster.mts` discovers every command under `extensions/muster/cli/`;
 * the prebuilt `claude-hook` bundle (`extensions/muster/build-hook-bundle.mjs`)
 * hands in just that one. Both run this same argv parsing, identity resolution
 * and exit handling, so the hook path has no second implementation of the verb.
 */

import { cliRepoRoot } from "./lib/bus-root.ts";
import { ownClaudeLane } from "./lib/claude-lane-card.ts";
import { atBoundaryAsync } from "./ledger/boundary.ts";
import type { CliCommand } from "./cli/types.ts";

function globalArgv(argv: string[]): { command: string | undefined; rest: string[]; repoRoot?: string; agentId?: string; json: boolean; help: boolean } {
	const rest: string[] = [];
	let command: string | undefined;
	let repoRoot: string | undefined;
	let agentId: string | undefined;
	let json = false;
	let help = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]!;
		if (command === undefined && arg === "--repo") {
			repoRoot = argv[++index];
			continue;
		}
		if (command === undefined && arg === "--agent") {
			agentId = argv[++index];
			continue;
		}
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			help = true;
			continue;
		}
		if (command === undefined && !arg.startsWith("-")) {
			command = arg;
			continue;
		}
		rest.push(arg);
	}
	return { command, rest, repoRoot, agentId, json, help };
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * Writes still in flight. `process.stdout` and `process.stderr` are asynchronous
 * when they are pipes, and `process.exit()` drops whatever libuv has not flushed
 * (Node's own caveat): `muster lanes --json` lost its tail as soon as the
 * directory outgrew the 64 KiB pipe buffer — 116 974 bytes redirected to a file,
 * 65 536 through a pipe (F2, LC0-R3, 2026-10-17). Every line is tracked, and the
 * exit waits for them.
 */
const inFlight = new Set<Promise<void>>();

function writeLine(stream: NodeJS.WriteStream, line: string): void {
	const done = new Promise<void>((resolve) => { stream.write(`${line}\n`, () => resolve()); });
	inFlight.add(done);
	void done.then(() => inFlight.delete(done));
}

/** A consumer that stops reading closes its end, and writing then raises EPIPE. Its reader wanted part of
 * the output, not all of it: that is not a failure of the command. Any other stream error still surfaces. */
function ignoreBrokenPipe(stream: NodeJS.WriteStream): void {
	stream.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code !== "EPIPE") throw error;
	});
}

/** Wait for every write to reach the pipe or file, then exit with the command's code. */
async function flushAndExit(code: number): Promise<void> {
	await Promise.all([...inFlight]);
	process.exit(code);
}

async function main(loadCommands: () => Promise<Map<string, CliCommand>>): Promise<number> {
	const commands = await loadCommands();
	const parsed = globalArgv(process.argv.slice(2));
	const out = (line: string): void => writeLine(process.stdout, line);
	const err = (line: string): void => writeLine(process.stderr, line);

	if (parsed.help && parsed.command === undefined) {
		usage(commands, out);
		return 0;
	}
	if (parsed.command === undefined) {
		usage(commands, err);
		return 2;
	}
	const command = commands.get(parsed.command);
	if (command === undefined) {
		err(`muster: unknown command ${parsed.command}\n`);
		usage(commands, err);
		return 2;
	}
	if (parsed.help) {
		out(command.usage);
		return 0;
	}
	const repoRoot = cliRepoRoot({ flag: parsed.repoRoot, env: process.env });
	// The identity this session proves it has: the Claude lane it runs, else the id its
	// launcher gave it. Inside a Claude lane the session names the lane, not
	// CONCORD_AGENT_ID: the daemon spawns every `claude --bg` session from its own
	// environment, so that variable holds whichever lane launched first.
	const sessionAgentId = (ownClaudeLane(process.env) ?? process.env["CONCORD_AGENT_ID"]?.trim() ?? "").trim() || undefined;
	// A `--agent` on the command line is a claim, not an identity: it never replaces the
	// session's own identity (REPREF), so a command string copied out of a brief cannot
	// make a lane act as another lane or as a seat.
	const agentId = (parsed.agentId !== undefined ? parsed.agentId.trim() || undefined : sessionAgentId) ?? undefined;
	// LC2 (§3.3): a command whose store is unavailable exits 75 with one line,
	// instead of looking like a success or like the command's own refusal. A verb
	// that answers its own store failure never reaches here.
	return atBoundaryAsync("cli", parsed.command, () => command.run({
		argv: parsed.rest,
		repoRoot,
		agentId,
		sessionAgentId,
		json: parsed.json,
		cwd: process.cwd(),
		env: process.env,
		io: { out, err },
		readStdin,
	}), 75);
}

function usage(commands: Map<string, CliCommand>, out: (line: string) => void): void {
	out("muster — Muster's harness-neutral interface over Concord\n");
	out("Usage: muster [--repo <path>] [--agent <id>] [--json] <command> [args]\n");
	for (const command of [...commands.values()].sort((a, b) => a.name.localeCompare(b.name))) {
		out(`  ${command.name.padEnd(8)} ${command.summary}`);
	}
	out("\nRun `muster <command> --help` for the fields one command takes.");
	out("\n`--agent` names the identity a caller claims: a session that has an identity of its own keeps it,");
	out("\nand a seat name stands only with the seat's credential.");
}

/** Run the CLI over `process.argv` and exit the process with the command's code. */
export function musterMain(loadCommands: () => Promise<Map<string, CliCommand>>): void {
	ignoreBrokenPipe(process.stdout);
	ignoreBrokenPipe(process.stderr);
	main(loadCommands)
		.then((code) => flushAndExit(code))
		.catch((error: unknown) => {
			writeLine(process.stderr, `muster: ${error instanceof Error ? error.message : String(error)}`);
			return flushAndExit(1);
		});
}
