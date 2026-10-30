#!/usr/bin/env node
/**
 * lane-keys.mjs — the launcher's read of `~/.config/agent-keys.env`.
 *
 * A thin CLI over `harness/routing/provider-key.ts` (`readAgentKeysFile`, the one parser), so the values a lane starts
 * with and the names `accountConfigured` tests can never disagree about what the file says. The tmux server holds the
 * environment it was started with, so a key added to the file afterwards never reached a lane (2026-10-27); the
 * launcher calls this on every start and hands the window what the file says now.
 *
 *   node lane-keys.mjs
 *
 * Writes one NUL-terminated `NAME=value` per parsed entry on stdout and nothing else: no name or value on stderr
 * beyond the warnings below, no count of them, no JSON. `PI_AGENT_KEYS_PATH` is honoured, so a lab points it at a
 * fixture. An absent or unreadable file prints nothing and exits 0, and a lane without keys starts exactly as before.
 *
 * A value that cannot be trusted is said out loud on stderr, by NAME and length only, and the lane still starts with
 * the parsed value: a file written with a second layer of quotes, or a name whose value is not the machine's second
 * copy of it, is what reaches a lane as 53 characters against 51 and answers 401. The lanes already running are
 * watched by the tick's key health (`lane-key-health.ts`), which reports through Henry.
 */
// RS1 (S8): the credentials port is configured before `provider-key.ts` is loaded, as every reader of it does.
import "../core/pi-ports-profile.ts";
import { harnessRoot, tsxLoaderPath } from "../core/harness-paths.ts";
import { readAgentKeysFile, untrustedAgentKeys, untrustedKeyReason } from "../routing/provider-key.ts";

process.stdout.write([...readAgentKeysFile()].map(([name, value]) => `${name}=${value}\0`).join(""));
for (const [name, untrusted] of untrustedAgentKeys()) process.stderr.write(`pi-lane-launch: key ${untrustedKeyReason(name, untrusted)}\n`);
