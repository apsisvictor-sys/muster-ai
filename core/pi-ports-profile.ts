/**
 * `core/pi-ports-profile.ts` — the wiring a package's own start file gives the ports (RS3 F2).
 *
 * The harness never imports Pi's profile (RD1), and a CLI inside the packages cannot
 * import Pi's start file either: `extensions/lib/harness-ports.ts` lives in the profile,
 * which the repository does not carry. What it may import is the Pi *packages*, which it
 * declares as dependencies, so a package CLI wires the same two ports that start file does:
 * the agent folder, and the credential reader the key logic reaches Pi's storage through.
 *
 * Import it for its effect, before the module that reads a port:
 *
 *   import "../core/pi-ports-profile.ts";
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { findEnvKeys } from "@earendil-works/pi-ai/compat";
import { getProviderEnvValue } from "@earendil-works/pi-ai/utils/provider-env";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";

import { configurePiPorts } from "./pi-ports.ts";

/**
 * The agent folder when no start file stands in it: `PI_AGENT_DIR` when set, else Pi's
 * default, `~/.pi/agent` — the same default `routing/provider-pool.ts` reads its pool from.
 */
export function defaultAgentDir(): string {
	return process.env["PI_AGENT_DIR"]?.trim() || join(homedir(), ".pi", "agent");
}

configurePiPorts({
	agentDir: defaultAgentDir(),
	credentials: { findEnvKeys, getProviderEnvValue, readStoredCredential },
});
