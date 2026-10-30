/**
 * The Concord workspace of the shared bus (decided 2026-10-08): every lane joins
 * `$PI_LANES_REPO_ROOT`, else the agent directory, so a lane and the orchestrator
 * see each other. `scripts/pi-lane-launch.sh` applies the same default to lanes.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function sharedBusRoot(env: NodeJS.ProcessEnv = process.env): string {
	return env["PI_LANES_REPO_ROOT"]?.trim() || env["PI_CODING_AGENT_DIR"]?.trim() || join(env["HOME"]?.trim() || homedir(), ".pi", "agent");
}

/**
 * The workspace a `muster` command uses: `--repo`, else `CONCORD_REPO_ROOT`, else
 * the shared bus root. Never the caller's cwd: a sender run from another repo or
 * from $HOME would otherwise talk to a workspace no lane is registered in.
 */
export function cliRepoRoot(options: { flag?: string; env?: NodeJS.ProcessEnv }): string {
	const env = options.env ?? process.env;
	return resolve(options.flag ?? (env["CONCORD_REPO_ROOT"]?.trim() || sharedBusRoot(env)));
}
