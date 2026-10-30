/**
 * `muster mission` — the `pi:mission` window (acceptance check 7, design §4.6).
 *
 * Creates the live-table window in a tmux session, at index 0 so `tmux attach`
 * lands on it, and selects it. Idempotent: an existing `mission` window is
 * reused, never duplicated. It starts a viewer only — no lane is moved,
 * restarted or written to.
 *
 * The window runs this CLI's own `muster lanes --watch`, so the table and the
 * command line show exactly the same rows.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { piAgentDir } from "../../core/pi-ports.ts";
import { parseFlags, type CliCommand } from "./types.ts";

const WINDOW = "mission";

function tmux(args: string[]): { ok: boolean; stdout: string; stderr: string } {
	const result = spawnSync("tmux", args, { encoding: "utf8", timeout: 10_000 });
	return { ok: result.status === 0, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

export const command: CliCommand = {
	name: "mission",
	summary: "Create or select the pi:mission live lane table (tmux window index 0)",
	usage: [
		"muster mission [--session <tmux session>] [--refresh-seconds N] [--no-select] [--dry-run]",
		"  the window runs `muster lanes --watch`; attach lands on it because it is index 0",
	].join("\n"),
	async run(ctx) {
		const parsed = parseFlags(ctx.argv, ["session", "refresh-seconds"]);
		const session = parsed.values.get("session")?.trim() ?? ctx.env["PI_LANES_TMUX_SESSION"]?.trim() ?? "pi";
		const refresh = parsed.values.get("refresh-seconds")?.trim() ?? "2";
		const dryRun = parsed.flags.has("dry-run");
		const select = !parsed.flags.has("no-select");

		const sessions = tmux(["list-sessions", "-F", "#{session_name}"]);
		if (!sessions.ok) {
			ctx.io.err(`muster mission: tmux is not available (${sessions.stderr || "no sessions"})`);
			return 1;
		}
		if (!sessions.stdout.split("\n").includes(session)) {
			ctx.io.err(`muster mission: no tmux session ${session} (sessions: ${sessions.stdout.split("\n").join(", ")})`);
			return 3;
		}

		const command = [join(piAgentDir(), "extensions", "muster", "launchers", "muster"), "lanes", "--watch", "--session", session, "--refresh-seconds", refresh];
		const existing = tmux(["list-windows", "-t", session, "-F", "#{window_name}"]);
		const already = existing.ok && existing.stdout.split("\n").includes(WINDOW);
		if (!already) {
			if (dryRun) {
				ctx.io.out(`would run: tmux new-window -d -t ${session}: -n ${WINDOW} -- ${command.join(" ")}; then swap-window to index 0`);
			} else {
				// Appended, then swapped to index 0: tmux refuses to create a window
				// at an occupied index ("index 0 in use"), and `swap-window` puts the
				// table first without disturbing any other window's identity.
				const args = ["new-window", "-d", "-t", `${session}:`, "-n", WINDOW];
				const stateDir = ctx.env["PI_MUSTER_STATE_DIR"]?.trim();
				if (stateDir !== undefined && stateDir !== "") args.push("-e", `PI_MUSTER_STATE_DIR=${stateDir}`);
				if (ctx.env["PI_LANES_JSON"]?.trim()) args.push("-e", `PI_LANES_JSON=${ctx.env["PI_LANES_JSON"]!.trim()}`);
				args.push("--", ...command);
				const created = tmux(args);
				if (!created.ok) {
					ctx.io.err(`muster mission: creating ${session}:${WINDOW} failed (${created.stderr})`);
					return 1;
				}
			}
		}
		if (!dryRun) {
			// First window: the table is what a fresh attach should look at.
			const indexes = tmux(["list-windows", "-t", session, "-F", "#{window_index} #{window_name}"]);
			const index = indexes.ok ? indexes.stdout.split("\n").find((line) => line.endsWith(` ${WINDOW}`))?.split(" ")[0] : undefined;
			if (index !== undefined && index !== "0") {
				const swapped = tmux(["swap-window", "-s", `${session}:${WINDOW}`, "-t", `${session}:0`]);
				if (!swapped.ok) ctx.io.err(`muster mission: could not put ${WINDOW} first (${swapped.stderr})`);
			}
		}
		if (select && !dryRun) {
			const selected = tmux(["select-window", "-t", `${session}:${WINDOW}`]);
			if (!selected.ok) ctx.io.err(`muster mission: the window exists but could not be selected (${selected.stderr})`);
		}
		const order = tmux(["list-windows", "-t", session, "-F", "#{window_index}:#{window_name}"]);
		if (ctx.json) {
			ctx.io.out(JSON.stringify({ session, window: WINDOW, already, selected: select && !dryRun, order: order.ok ? order.stdout.split("\n") : [] }, null, 2));
			return 0;
		}
		ctx.io.out(`muster mission: ${already ? "existing" : "created"} ${session}:${WINDOW}${select && !dryRun ? " (selected)" : ""}`);
		if (order.ok) ctx.io.out(order.stdout.split("\n").map((line) => `  ${line}`).join("\n"));
		return 0;
	},
};
