#!/usr/bin/env node
/**
 * Muster watch host — owns the `concord inbox watch` child for one binding and
 * ties its lifetime to the parent Pi process via a liveness pipe (plan §5.6).
 *
 * Contract:
 * - spawned by the Pi extension with argv:
 *     node watch-host.mjs --agent <id> --interval <ms> [--liveness-fd <n>]
 *         [--watch-cmd <json array>]   (test-only override)
 * - the liveness fd is a pipe held only by Pi; EOF or read error on it means
 *   the parent is gone → terminate the whole watch process group (SIGTERM,
 *   bounded SIGKILL) and exit. The watch child must NOT inherit that pipe:
 *   the liveness fd is explicitly redirected to /dev/null in the child stdio.
 * - forwards the watch child's stdout bytes verbatim (Pi-side LineBuffer owns
 *   partial-line and split-UTF-8 safety) and its stderr to this stderr.
 * - NOT a daemon: exits when the parent exits, the watch child exits, or the
 *   pipe closes. Never restarts the watch child itself (the Pi-side
 *   ReceiverHost owns bounded restart backoff).
 */

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";

const EXIT_USAGE = 64;
const SIGKILL_GRACE_MS = 2000;

function parseArgs(argv) {
	const args = { agent: undefined, interval: 1000, livenessFd: undefined, watchCmd: undefined };
	for (let i = 2; i < argv.length; i += 1) {
		const flag = argv[i];
		if (flag === "--agent") args.agent = argv[++i];
		else if (flag === "--interval") args.interval = Number.parseInt(argv[++i], 10);
		else if (flag === "--liveness-fd") args.livenessFd = Number.parseInt(argv[++i], 10);
		else if (flag === "--watch-cmd") args.watchCmd = JSON.parse(argv[++i]);
	}
	return args;
}

let args;
try {
	args = parseArgs(process.argv);
} catch {
	process.stderr.write("watch-host: --watch-cmd must be valid JSON\n");
	process.exit(EXIT_USAGE);
}
if (typeof args.agent !== "string" || args.agent.length === 0) {
	process.stderr.write("watch-host: --agent is required\n");
	process.exit(EXIT_USAGE);
}
if (
	args.watchCmd !== undefined &&
	(!Array.isArray(args.watchCmd) ||
		args.watchCmd.length === 0 ||
		args.watchCmd.some((part) => typeof part !== "string"))
) {
	process.stderr.write("watch-host: --watch-cmd must be a JSON array of strings\n");
	process.exit(EXIT_USAGE);
}
const interval = Number.isFinite(args.interval) ? args.interval : 1000;
const livenessFd =
	Number.isInteger(args.livenessFd) && args.livenessFd >= 3 ? args.livenessFd : undefined;

// ─── Watch child stdio ───────────────────────────────────────────────────────
// fd 0 ignore, fd 1 pipe (forwarded), fd 2 inherit. The liveness fd is
// explicitly mapped to "ignore" so the watch child cannot inherit the parent
// liveness pipe and keep it open past this host's death. `ignore` opens
// /dev/null over that slot in the child, which is exactly "excluded".

function watchChildStdio() {
	const stdio = ["ignore", "pipe", "inherit"];
	if (livenessFd !== undefined) {
		while (stdio.length < livenessFd) stdio.push("ignore");
		stdio[livenessFd] = "ignore";
	}
	return stdio;
}

// ─── Watch child lifecycle ───────────────────────────────────────────────────

let watchChild;
let terminating = false;
let killTimer;

function killWatchGroup(signal) {
	if (watchChild === undefined) return;
	const pid = watchChild.pid;
	if (pid !== undefined && pid > 0) {
		try {
			process.kill(-pid, signal);
			return;
		} catch {
			/* fall through to the direct child */
		}
	}
	try {
		watchChild.kill(signal);
	} catch {
		/* already gone */
	}
}

function terminate(reason) {
	if (terminating) return;
	terminating = true;
	process.stderr.write(`watch-host: terminating (${reason})\n`);
	if (watchChild === undefined) {
		process.exit(0);
		return;
	}
	killWatchGroup("SIGTERM");
	// Referenced on purpose: the bounded SIGKILL must land even when every
	// other handle has already closed. The watch child's exit clears it.
	killTimer = setTimeout(() => {
		killWatchGroup("SIGKILL");
		process.exit(0);
	}, SIGKILL_GRACE_MS);
}

function finish(code) {
	if (killTimer !== undefined) {
		clearTimeout(killTimer);
		killTimer = undefined;
	}
	process.exit(code);
}

// ─── Liveness pipe ───────────────────────────────────────────────────────────
// Pi holds the write end. EOF (parent exit or explicit close) or a read error
// means the session is gone: terminate the watch group and exit promptly.

if (livenessFd !== undefined) {
	try {
		const liveness = createReadStream(null, { fd: livenessFd, autoClose: true });
		liveness.on("data", () => {
			/* Pi sends nothing; any data is drained and ignored */
		});
		liveness.on("end", () => terminate("parent pipe EOF"));
		liveness.on("error", () => terminate("parent pipe error"));
	} catch (error) {
		process.stderr.write(`watch-host: liveness fd ${livenessFd} unavailable: ${String(error)}\n`);
	}
}

process.on("SIGTERM", () => terminate("SIGTERM"));
process.on("SIGHUP", () => terminate("SIGHUP"));
process.on("SIGINT", () => terminate("SIGINT"));

// A dead Pi closes the output pipe; write errors are shutdown signals, not
// crashes. stderr errors are swallowed so the final diagnostics can still be
// attempted without an unhandled stream error.
process.stdout.on("error", () => terminate("stdout pipe closed"));
process.stderr.on("error", () => {
	/* diagnostics only */
});

// ─── Spawn the watch command ─────────────────────────────────────────────────

function defaultWatchCommand() {
	// The launcher lives with the Pi extension, not with this file: RS2c moved this file into the
	// muster package and the lookup beside it then failed with ENOENT for every Pi lane (2026-10-18).
	const launcher = fileURLToPath(new URL("../../extensions/muster/launchers/concord", import.meta.url));
	return [
		launcher,
		"inbox",
		"watch",
		"--agent",
		args.agent,
		"--provider",
		"pi",
		"--interval",
		String(interval),
	];
}

const watchCommand = args.watchCmd ?? defaultWatchCommand();

try {
	watchChild = spawn(watchCommand[0], watchCommand.slice(1), {
		cwd: process.cwd(),
		env: process.env,
		stdio: watchChildStdio(),
		detached: true, // own process group so one kill clears the whole tree
	});
} catch (error) {
	process.stderr.write(`watch-host: failed to spawn watch command: ${String(error)}\n`);
	process.exit(1);
}

watchChild.stdout?.on("error", () => {
	/* watch child gone; exit handling covers lifecycle */
});
watchChild.stdout?.on("data", (chunk) => {
	// Plain byte forwarding: the Pi-side LineBuffer handles partial lines and
	// split UTF-8 sequences, so no second buffering layer is needed here.
	process.stdout.write(chunk);
});
watchChild.on("error", (error) => {
	process.stderr.write(`watch-host: watch command error: ${String(error)}\n`);
	finish(1);
});
watchChild.on("exit", (code, signal) => {
	// The watch child exiting without a parent request ends the host; the
	// Pi-side ReceiverHost observes this exit and owns restart backoff.
	if (!terminating) {
		process.stderr.write(`watch-host: watch child exited code=${code} signal=${signal}\n`);
		finish(code === null ? 1 : code);
	}
	finish(0);
});
