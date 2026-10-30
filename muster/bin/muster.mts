#!/usr/bin/env node
/**
 * `muster` — the harness-neutral Muster CLI (A3 of the harness bus design,
 * section 4.7). Every harness calls these commands; the Pi extension's tools
 * are the same operations for Pi sessions. Nothing here holds state: Concord
 * owns messages and tasks, the lane cards own live state, and each command
 * reports what it did.
 *
 * Commands are discovered from the `cli/` folder next to this entry: one module,
 * one `command` export. Adding `muster lanes` is one file, never an edit here.
 *
 * Runs under the pi Node with the tsx loader, through the start file Pi's profile
 * keeps (`scripts/muster.mts`):
 *   bin/node --import node_modules/tsx/dist/loader.mjs scripts/muster.mts <command>
 * (extensions/muster/launchers/muster does exactly that.)
 */

import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { musterMain } from "../cli-main.ts";
import { verbOf } from "../cli-verb.ts";
import type { CliCommand } from "../cli/types.ts";

// The commands live in the cli/ folder next to this entry (S10); the start file in
// Pi's profile names this file, not the folder.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = resolve(SCRIPT_DIR, "..", "cli");

async function discoverCommands(): Promise<Map<string, CliCommand>> {
	const commands = new Map<string, CliCommand>();
	const entries = readdirSync(CLI_DIR).sort();
	// A verb with a module of its own loads only that module: every other command's imports (the
	// gateway's typebox, zod and the MCP SDK) cost seconds on a call that never reaches them. No verb
	// (usage text), or none by that file name, discovers every command, as before.
	const verb = verbOf(process.argv.slice(2));
	const own = verb === undefined ? undefined : entries.find((entry) => entry === `${verb}.ts` && entry !== "types.ts");
	for (const entry of own === undefined ? entries : [own]) {
		if (!entry.endsWith(".ts") || entry.endsWith(".d.ts") || entry === "types.ts") continue;
		const module = (await import(pathToFileURL(join(CLI_DIR, entry)).href)) as { command?: CliCommand };
		if (module.command === undefined) continue;
		commands.set(module.command.name, module.command);
	}
	return commands;
}

/**
 * The entry the start file runs (`scripts/muster.mts`), and the entry a direct run of
 * this file runs.
 */
export function run(): void {
	musterMain(discoverCommands);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	run();
}
