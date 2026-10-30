/**
 * The one owner of "resume this lane at time T" (efficiency blueprint, DS4).
 *
 * A walled lane, or a lane whose turn ended on a transient API error, is woken
 * by a transient systemd user timer, never a session cron: the durable-wake rule,
 * because a session cron dies with the VM. The Claude StopFailure hook (S2) and
 * muster-tick (S4) both call `scheduleLaneResume`; neither builds its own
 * `systemd-run` line.
 */

import { spawnSync } from "node:child_process";
import { musterLauncher } from "../core/pi-ports.ts";
import { LabUnitRefusal, labUnitOperand } from "../core/lab-units.ts";

/** The principal a resume timer sends as: its own, never the orchestrator seat (seats blueprint, WP-S4 item 3). */
export const RESUME_TIMER_SENDER = "muster-tick";

/** A timer set for a moment already past would never fire; it fires this long from now instead. */
const PAST_GRACE_MS = 5_000;

export interface ResumeTimerPorts {
	/** Run one command to completion. */
	exec(file: string, args: string[]): { status: number | null; stderr: string };
	/** The `muster` launcher the timer's service will run. */
	musterPath: string;
	/** The PATH the service needs to find `node` (a systemd user service starts with a bare one). */
	path: string | undefined;
	now(): Date;
	/** Where the lab unit marker is read from; `process.env` when the port is used, never at load. */
	env?: NodeJS.ProcessEnv;
}

const defaultPorts: ResumeTimerPorts = {
	exec(file, args) {
		const result = spawnSync(file, args, { encoding: "utf8", timeout: 15_000 });
		return { status: result.status, stderr: `${result.error?.message ?? ""}${result.stderr ?? ""}`.trim() };
	},
	// S10: read from the port when the port is used, never while this module loads.
	get musterPath() {
		return musterLauncher();
	},
	path: process.env["PATH"],
	now: () => new Date(),
	// S10: read from the port when the port is used, never while this module loads.
	get env() {
		return process.env;
	},
};

/** `YYYY-MM-DD HH:MM:SS UTC`: an unambiguous systemd calendar time. */
function calendarUtc(at: Date): string {
	return `${at.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** A unit name may hold only letters, digits and `:_.\-`. */
function unitSafe(lane: string): string {
	return lane.replace(/[^A-Za-z0-9:_.-]/g, "-");
}

/**
 * Wake `lane` at `at` with `text` (`muster send <lane> <text> --mode wake`).
 * Returns the transient unit name, or the reason systemd refused. A time already
 * past fires a few seconds from now instead of never.
 */
export function scheduleLaneResume(lane: string, at: Date, text: string, ports: ResumeTimerPorts = defaultPorts): { unit: string } | { error: string } {
	if (lane.trim() === "") return { error: "scheduleLaneResume: a lane id is required" };
	if (Number.isNaN(at.getTime())) return { error: "scheduleLaneResume: the resume time is not a date" };
	if (text.trim() === "") return { error: "scheduleLaneResume: the resume text is empty" };
	const now = ports.now();
	const fireAt = at.getTime() <= now.getTime() ? new Date(now.getTime() + PAST_GRACE_MS) : at;
	const liveUnit = `muster-resume-${unitSafe(lane)}-${Math.floor(fireAt.getTime() / 1000)}`;
	// The lab unit guard (lab-units.ts): in a marked lab only a unit the lab mapped is started, so a lab's
	// resume timer can never land in the live install's namespace unannounced (R2). A refusal starts nothing.
	let unit: string;
	try {
		unit = labUnitOperand(liveUnit, ports.env ?? process.env);
	} catch (error) {
		if (!(error instanceof LabUnitRefusal)) throw error;
		return { error: error.message };
	}
	const args = [
		"--user",
		`--unit=${unit}`,
		`--on-calendar=${calendarUtc(fireAt)}`,
		"--timer-property=AccuracySec=30s",
		...(ports.path !== undefined ? [`--setenv=PATH=${ports.path}`] : []),
		// `muster send` needs a sender identity, and a timer has no enrolled session.
		ports.musterPath, "--agent", RESUME_TIMER_SENDER, "send", lane, text, "--mode", "wake",
	];
	const result = ports.exec("systemd-run", args);
	if (result.status !== 0) return { error: `systemd-run failed${result.status === null ? "" : ` (exit ${result.status})`}: ${result.stderr || "no output"}` };
	return { unit };
}
