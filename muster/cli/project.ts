/**
 * `muster project employer` — the employer a working directory resolves to
 * (SK2 of the secrets blueprint).
 *
 * `run-as` (SK1) and the Pi entry guard (SK5) resolve an employer through this
 * same verb, so the plain output is the bare employer value: shell scripts
 * compare it against `PI_EMPLOYER` without string surgery. `--json` prints the
 * same as an object for diagnostics. Outside the register — `~`, a non-Git
 * path, an unregistered checkout — the resolver answers `personal`.
 */

import type { Employer } from "../projects.ts";
import { employerForCwd } from "../projects.ts";
import { parseFlags, type CliCommand } from "./types.ts";

export const command: CliCommand = {
	name: "project",
	summary: "The employer a working directory resolves to, from the project register",
	usage: [
		"muster project employer [--cwd <dir>] [--json]",
		"  prints the employer of <dir> (default: the current directory): the registered",
		"  project's employer, else personal. Plain output is the bare value; --json",
		"  prints {\"employer\":…}.",
	].join("\n"),
	async run(ctx) {
		const parsed = parseFlags(ctx.argv, ["cwd"]);
		if (parsed.positionals[0] !== "employer") {
			ctx.io.err(`muster project: usage: employer [--cwd <dir>]\n${command.usage}`);
			return 2;
		}
		const cwd = parsed.values.get("cwd")?.trim() || ctx.cwd;
		let employer: Employer;
		try {
			employer = await employerForCwd(cwd);
		} catch (error) {
			ctx.io.err(`muster project: ${error instanceof Error ? error.message : String(error)}`);
			return 3;
		}
		ctx.io.out(ctx.json ? JSON.stringify({ employer }) : employer);
		return 0;
	},
};
