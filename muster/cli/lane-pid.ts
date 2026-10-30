/**
 * `muster lane-pid add <pid>` — register a helper process (a dev server, a browser) a lane started.
 *
 * `closeLane` (`lane-lifecycle.ts`) stops each registered pid that is still the same process when the
 * lane parks or closes, so a QA lane leaves no server behind (LD11). The registration keeps the pid's
 * start time, which is what tells a stopped process from a pid another process has since been given.
 * The lane is the caller's own: `--lane`, else the session's lane (the same resolution `muster report`
 * uses). A lane with no lane record has nothing to register against and is refused.
 */

import { procPidAlive, procStartTime } from "../lib/lane-directory.ts";
import { readFileSync } from "node:fs";
import { recordHelperPid, recordHelperScope } from "../lane-lifecycle.ts";
import { lanesStateDir } from "./lanes.ts";
import { parseFlags, type CliCommand } from "./types.ts";

function commOf(pid: number): string | undefined {
	try {
		return readFileSync(`/proc/${pid}/comm`, "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

export const command: CliCommand = {
	name: "lane-pid",
	summary: "Register a helper process (dev server, browser) or the systemd scope it runs in, so closing the lane stops it",
	usage: [
		"muster lane-pid add <pid> [--lane <lane>] [--json]",
		"muster lane-pid add-scope <unit.scope> [--lane <lane>] [--json]",
		"  add records the live process <pid>, add-scope the systemd scope unit a helper runs in; closing or parking",
		"  the lane stops each by that exact pid or unit name (a scope takes its whole cgroup with it)",
	].join("\n"),
	async run(ctx) {
		const parsed = parseFlags(ctx.argv, ["lane"]);
		const verb = parsed.positionals[0];
		if ((verb !== "add" && verb !== "add-scope") || parsed.positionals[1] === undefined) {
			ctx.io.err(`muster lane-pid: usage: add <pid> | add-scope <unit.scope>\n${command.usage}`);
			return 2;
		}
		const laneId = parsed.values.get("lane")?.trim() || ctx.agentId?.trim();
		if (laneId === undefined || laneId === "") {
			ctx.io.err("muster lane-pid: no lane: pass --lane <lane>, or run from a lane's own session");
			return 2;
		}
		if (verb === "add-scope") {
			const unit = parsed.positionals[1].trim();
			// A helper scope is registered by name before it is started (dev-server.sh names it, systemd-run creates
			// it), so only the name is checked here, not a live unit: a scope that never came up reads as gone at close.
			let written: boolean;
			try {
				written = recordHelperScope(lanesStateDir(ctx.env), laneId, { unit, addedAt: Date.now() });
			} catch (error) {
				ctx.io.err(`muster lane-pid: ${error instanceof Error ? error.message : String(error)}`);
				return 2;
			}
			if (!written) {
				ctx.io.err(`muster lane-pid: ${laneId} has no lane record to register against`);
				return 3;
			}
			ctx.io.out(ctx.json ? JSON.stringify({ laneId, unit }) : `muster lane-pid: ${laneId} will stop scope ${unit} when it parks or closes`);
			return 0;
		}
		const pid = Number(parsed.positionals[1]);
		if (!Number.isSafeInteger(pid) || pid <= 1) {
			ctx.io.err(`muster lane-pid: ${JSON.stringify(parsed.positionals[1])} is not a process id`);
			return 2;
		}
		const startTime = procPidAlive(pid) ? procStartTime(pid) : undefined;
		if (startTime === undefined) {
			ctx.io.err(`muster lane-pid: process ${pid} is not running`);
			return 3;
		}
		const comm = commOf(pid);
		let written: boolean;
		try {
			written = recordHelperPid(lanesStateDir(ctx.env), laneId, { pid, startTime, ...(comm !== undefined ? { comm } : {}), addedAt: Date.now() });
		} catch (error) {
			ctx.io.err(`muster lane-pid: ${error instanceof Error ? error.message : String(error)}`);
			return 3;
		}
		if (!written) {
			ctx.io.err(`muster lane-pid: ${laneId} has no lane record to register against`);
			return 3;
		}
		ctx.io.out(ctx.json ? JSON.stringify({ laneId, pid, startTime, comm: comm ?? null }) : `muster lane-pid: ${laneId} will stop process ${pid}${comm !== undefined ? ` (${comm})` : ""} when it parks or closes`);		return 0;
	},
};
