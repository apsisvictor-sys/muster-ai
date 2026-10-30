/**
 * The agent and Muster state dirs of a lab installation. A real (not --dry-run)
 * launch writes the lane's lifecycle record to the Muster state dir, which is
 * $PI_MUSTER_STATE_DIR else <agent dir>/state/muster. The launcher accepts a lab
 * state dir only with a lab agent dir (half-live enrollment is refused), so a
 * launcher test sets both, or its record lands in the live state dir.
 *
 * `liveLaunchRecordGuard` is the check that a launcher test file did not do that:
 * it lists the live lifecycle records read-only before the file runs and names, after
 * it, every record the file left behind. A record counts as the file's when its cwd
 * is under the temp dir, because every lab lives there and no real lane does. Live
 * lanes launched while a long suite runs have a repository cwd and are ignored.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { listLaneRecords } from "../lane-lifecycle.ts";

/**
 * The lab's heavy gate. A lane launch is a heavy job, and a lab launch must be admitted on an idle machine
 * and on a busy one alike: the operator's pause flag, a dev-server window, the machine's own pressure and the last
 * launch's stamp belong to the live machine, and these knobs are the gate's own test surface.
 */
function gateLabEnv(dir: string): Record<string, string> {
	const psi = join(dir, "gate-psi");
	mkdirSync(dir, { recursive: true });
	writeFileSync(psi, "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n");
	const meminfo = join(dir, "gate-meminfo");
	writeFileSync(meminfo, `MemAvailable: ${64 * 1024 * 1024} kB\n`);
	const slice = join(dir, "gate-slice");
	mkdirSync(slice, { recursive: true });
	return {
		HEAVY_GATE_PAUSED_FILE: join(dir, "gate-paused"),
		HEAVY_GATE_UNITS_CMD: "true",
		HEAVY_GATE_PSI_FILE: psi,
		HEAVY_GATE_MEMINFO_FILE: meminfo,
		HEAVY_GATE_SLICE_DIR: slice,
		HEAVY_GATE_SPACING: "0",
	};
}

export function labInstallEnv(dir: string): { PI_CODING_AGENT_DIR: string; PI_MUSTER_STATE_DIR: string } & Record<string, string> {
	const agentDir = join(dir, "lab-agent");
	return { PI_CODING_AGENT_DIR: agentDir, PI_MUSTER_STATE_DIR: join(agentDir, "state", "muster"), ...gateLabEnv(dir) };
}

/** The Muster state dir a launcher resolves when neither PI_MUSTER_STATE_DIR nor PI_CODING_AGENT_DIR is set. */
export const LIVE_MUSTER_STATE_DIR = join(homedir(), ".pi", "agent", "state", "muster");

export function liveLaunchRecordGuard(liveStateDir: string = LIVE_MUSTER_STATE_DIR): { leaked: () => string[]; assertUntouched: () => void } {
	const snapshot = (): Map<string, string> => new Map(listLaneRecords(liveStateDir).map((record) => [record.laneId, JSON.stringify(record)]));
	const before = snapshot();
	const labCwd = (record: string): boolean => {
		const cwd = (JSON.parse(record) as { cwd?: unknown }).cwd;
		return typeof cwd === "string" && (cwd === tmpdir() || cwd.startsWith(`${tmpdir()}/`));
	};
	const leaked = (): string[] =>
		[...snapshot()].filter(([laneId, record]) => before.get(laneId) !== record && labCwd(record)).map(([laneId]) => laneId);
	return {
		leaked,
		assertUntouched: () => {
			const names = leaked();
			if (names.length > 0) throw new Error(`launcher tests wrote lane records into the live state dir ${liveStateDir}/lifecycle: ${names.join(", ")}`);
		},
	};
}
