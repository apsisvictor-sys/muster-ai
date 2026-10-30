/**
 * `system_health` (HO7, Henry's observability blueprint 2026-10-17): this machine's
 * health in four read-only sections — RAM and swap from /proc/meminfo, disk use of
 * /, /home and /mnt/c from `df -P`, the top 10 processes by RSS from `ps` with
 * command names only (argv can carry secrets, so the arguments are never read),
 * and failed user units from `systemctl --user --failed --no-legend`, `none` when
 * there are no failed units. The tool takes no input.
 *
 * Every command runs through one typed exec seam with a fixed argv and no shell
 * (the knowledge module's `execGit`/`execGraphify` pattern), bounded by a timeout
 * and a 1 MB cap. A section whose command fails or times out prints a note instead
 * of failing the tool.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { redactSensitiveText } from "../../core/self-improving-redactor.ts";

/**
 * The one free-space reading, re-exported here where spec §6/§9 names it: the gateway's machine health and
 * the doctor's `disk-c` contract both ask `packages/core/disk-free.ts`, never their own `df` or `statfs`.
 */
export { diskFree, type DiskFree } from "../../core/disk-free.ts";

/** One finished run, exit code included: `systemctl --failed` exits non-zero when units failed, and that is a normal answer, not an error. */
export type HealthRun = { exitCode: number | null; stdout: string; stderr: string };

/** The one exec seam: a fixed argv, no shell, a timeout and a bounded buffer. Tests stub it. */
export type RunHealth = (file: string, args: string[], timeoutMs: number) => Promise<HealthRun>;

export const SYSTEM_HEALTH_TIMEOUT_MS = 10_000;
export const TOP_PROCESS_ROWS = 10;
const MAX_BUFFER = 1024 * 1024;
/** A failure note carries the redacted first line only, so one bad binary cannot flood the answer. */
const NOTE_CHARS = 300;
const KIB_PER_GIB = 1024 * 1024;

export const execHealth: RunHealth = (file, args, timeoutMs) =>
	new Promise((resolveRun, rejectRun) => {
		execFile(file, args, { timeout: timeoutMs, maxBuffer: MAX_BUFFER, env: process.env }, (error, stdout, stderr) => {
			if (error === null) return resolveRun({ exitCode: 0, stdout, stderr });
			// The command's own non-zero exit is a normal answer (df of a missing mount,
			// systemctl reporting failed units); only a spawn or timeout failure rejects.
			if (typeof error.code === "number") return resolveRun({ exitCode: error.code, stdout, stderr });
			rejectRun(new Error(failureNote(stderr, error.message)));
		});
	});

/** What a failure says: the redacted first line of stderr or the error, nothing more. */
function failureNote(stderr: string, fallback: string): string {
	const said = redactSensitiveText((stderr || fallback).trim(), { preservePaths: true }).split("\n")[0] ?? "";
	return said.slice(0, NOTE_CHARS) || "the command failed";
}

/** The production /proc/meminfo reader; tests stub the whole dep. */
export const readProcMeminfo = (): string => readFileSync("/proc/meminfo", "utf8");

export type SystemHealthDeps = {
	/** The process seam; production wires `execHealth`, tests stub it. */
	run: RunHealth;
	/** The /proc/meminfo text; production wires `readProcMeminfo`, tests stub it. */
	meminfo: () => string;
};

const kib = (value: number | undefined): string => (value === undefined ? "unknown" : `${value} kB (${(value / KIB_PER_GIB).toFixed(1)} GiB)`);

/** The parsed /proc/meminfo numbers; each field undefined when the line is missing. */
export type MeminfoData = {
	total?: number;
	free?: number;
	available?: number;
	swapTotal?: number;
	swapFree?: number;
};

/** The meminfo data view (command-center WP2): the prose below renders this, nothing else. */
export function meminfoData(text: string): MeminfoData {
	const values = new Map<string, number>();
	for (const line of text.split("\n")) {
		const match = /^(\w+):\s+(\d+)\s+kB$/.exec(line.trim());
		if (match !== null) values.set(match[1]!, Number(match[2]));
	}
	return {
		total: values.get("MemTotal"),
		free: values.get("MemFree"),
		available: values.get("MemAvailable"),
		swapTotal: values.get("SwapTotal"),
		swapFree: values.get("SwapFree"),
	};
}

/** Section 1: RAM and swap, the prose rendered from `meminfoData`. */
export function meminfoSection(text: string): string {
	const memory = meminfoData(text);
	if (memory.total === undefined) return "memory (/proc/meminfo)\n  unavailable: no MemTotal line";
	return [
		"memory (/proc/meminfo)",
		`  ram: total ${kib(memory.total)}, free ${kib(memory.free)}, available ${kib(memory.available)}`,
		`  swap: total ${kib(memory.swapTotal)}, free ${kib(memory.swapFree)}`,
	].join("\n");
}

/** One parsed `df -P` row; a line that does not parse is skipped. */
export type DiskRow = { mount: string; blocks: number; used: number; available: number; capacity: string };

function parseDfLine(line: string): DiskRow | undefined {
	const tokens = line.trim().split(/\s+/);
	if (tokens.length < 6) return undefined;
	const [blocks, used, available] = [Number(tokens[1]), Number(tokens[2]), Number(tokens[3])];
	if (![blocks, used, available].every(Number.isFinite)) return undefined;
	return { mount: tokens.slice(5).join(" "), blocks, used, available, capacity: tokens[4] ?? "?" };
}

const gib = (kibValue: number): string => `${(kibValue / KIB_PER_GIB).toFixed(1)} GiB`;

/** The disk data view (command-center WP2): the usable `df -P` rows, header dropped. */
export function diskData(run: HealthRun): DiskRow[] {
	return run.stdout
		.split("\n")
		.slice(1) // the header
		.map(parseDfLine)
		.filter((row): row is DiskRow => row !== undefined);
}

/** Section 2: the disk prose rendered from `diskData`, a note when df flagged something. */
export function diskSection(run: HealthRun): string {
	const rows = diskData(run);
	if (rows.length === 0) return `disk (df -P)\n  unavailable: ${failureNote(run.stderr, "no usable output")}`;
	const lines = rows.map((row) => `  ${row.mount}: ${row.capacity} used, ${gib(row.used)} of ${gib(row.blocks)}, ${gib(row.available)} free`);
	if (run.exitCode !== 0) lines.push(`  note: ${failureNote(run.stderr, "df exited non-zero")}`);
	return ["disk (df -P)", ...lines].join("\n");
}

/** The process data view (command-center WP2): at most `TOP_PROCESS_ROWS` trimmed non-empty rows of the ps answer; `comm` carries command names, never arguments. */
export function processesData(run: HealthRun): string[] {
	return run.stdout
		.split("\n")
		.slice(1) // the header
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.slice(0, TOP_PROCESS_ROWS);
}

/** Section 3: the process prose rendered from `processesData`. */
export function processesSection(run: HealthRun): string {
	const rows = processesData(run);
	if (rows.length === 0) return `processes (top ${TOP_PROCESS_ROWS} by RSS, command names only)\n  unavailable: no rows`;
	return [`processes (top ${TOP_PROCESS_ROWS} by RSS, command names only)`, ...rows.map((row) => `  ${row}`)].join("\n");
}

/** Section 4: the failed user units, `none` when systemctl reports no failures, a note when it could not ask. */
export function failedUnitsSection(run: HealthRun): string {
	const units = run.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
	if (units.length > 0) return ["failed user units", ...units.map((unit) => `  ${unit}`)].join("\n");
	if (run.exitCode === 0) return "failed user units\n  none";
	return `failed user units\n  unavailable: ${failureNote(run.stderr, "systemctl failed")}`;
}

/** One section; a rejected seam becomes a note so one bad command never fails the tool. */
async function section(name: string, work: () => Promise<string>): Promise<string> {
	try {
		return await work();
	} catch (error) {
		return `${name}\n  unavailable: ${failureNote("", error instanceof Error ? error.message : "unknown failure")}`;
	}
}

/** The whole four-section answer, always all four headers, each section on its own evidence. */
export async function systemHealthReport(deps: SystemHealthDeps): Promise<string> {
	const memory = await section("memory", async () => meminfoSection(deps.meminfo()));
	const [disk, processes, units] = await Promise.all([
		section("disk (df -P)", async () => diskSection(await deps.run("df", ["-P", "/", "/home", "/mnt/c"], SYSTEM_HEALTH_TIMEOUT_MS))),
		section(`processes (top ${TOP_PROCESS_ROWS} by RSS, command names only)`, async () => processesSection(await deps.run("ps", ["-eo", "pid,rss,etime,comm", "--sort=-rss"], SYSTEM_HEALTH_TIMEOUT_MS))),
		section("failed user units", async () => failedUnitsSection(await deps.run("systemctl", ["--user", "--failed", "--no-legend"], SYSTEM_HEALTH_TIMEOUT_MS))),
	]);
	return [memory, disk, processes, units].join("\n\n");
}
