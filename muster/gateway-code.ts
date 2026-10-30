/**
 * Which commit the running gateway started from (LD19).
 *
 * A long-running bus service never runs code older than main. The gateway records the commit it
 * started from in `<Muster state dir>/gateway-code.json`; the tick compares that commit with the
 * checkout's HEAD and tells the orchestrator once per HEAD when `extensions/muster` or
 * `extensions/lib` changed since. The tick only reports: restarting the gateway is the
 * orchestrator's, in the same push.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { procPidAlive } from "./lib/lane-directory.ts";

export const GATEWAY_CODE_FILE = "gateway-code.json";

/** The paths whose change makes a running gateway stale. */
export const GATEWAY_CODE_PATHS = ["extensions/muster", "extensions/lib"] as const;

export interface GatewayCode {
	/** `git rev-parse HEAD` of the checkout the gateway started from. */
	sha: string;
	startedAt: string;
	pid: number;
	/** The HEAD a GATEWAY STALE event was already written for; a restart writes a fresh file without it. */
	staleReportedFor?: string;
}

export function gatewayCodePath(musterStateDir: string): string {
	return join(musterStateDir, GATEWAY_CODE_FILE);
}

export function writeGatewayCode(musterStateDir: string, code: GatewayCode): void {
	const file = gatewayCodePath(musterStateDir);
	mkdirSync(dirname(file), { recursive: true });
	const staging = `${file}.${process.pid}.tmp`;
	writeFileSync(staging, `${JSON.stringify(code)}\n`, { mode: 0o600 });
	renameSync(staging, file);
}

/** The record, or undefined when it is missing or not one (the gateway has not started from a version that writes it). */
export function readGatewayCode(musterStateDir: string): GatewayCode | undefined {
	const file = gatewayCodePath(musterStateDir);
	if (!existsSync(file)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<GatewayCode>;
		if (typeof raw.sha !== "string" || raw.sha === "" || typeof raw.startedAt !== "string" || !Number.isInteger(raw.pid)) return undefined;
		return { sha: raw.sha, startedAt: raw.startedAt, pid: raw.pid as number, ...(typeof raw.staleReportedFor === "string" ? { staleReportedFor: raw.staleReportedFor } : {}) };
	} catch {
		return undefined;
	}
}

function git(checkout: string, args: string[]): { status: number; stdout: string } | undefined {
	try {
		const run = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
		return run.status === null ? undefined : { status: run.status, stdout: run.stdout };
	} catch {
		return undefined;
	}
}

/** `git rev-parse HEAD` of a checkout, or undefined when git cannot say. */
export function checkoutHead(checkout: string): string | undefined {
	const run = git(checkout, ["rev-parse", "--verify", "HEAD"]);
	const sha = run?.status === 0 ? run.stdout.trim() : "";
	return sha === "" ? undefined : sha;
}

/** The gateway-relevant files that differ between `sha` and HEAD; undefined when git cannot compare (an unknown commit). */
export function gatewayChangedFiles(checkout: string, sha: string): string[] | undefined {
	const run = git(checkout, ["diff", "--name-only", sha, "HEAD", "--", ...GATEWAY_CODE_PATHS]);
	return run?.status === 0 ? run.stdout.split("\n").filter((line) => line !== "") : undefined;
}

export interface GatewayFreshnessPorts {
	stateDir: string;
	head: () => string | undefined;
	changedFiles: (sha: string) => string[] | undefined;
	pidAlive?: (pid: number) => boolean;
	/** Appends one line to the orchestrator's events file; false when it could not be written. */
	event: (line: string) => boolean;
}

export interface GatewayFreshnessResult {
	action: "gateway-stale" | "gateway-code-unreadable";
	detail: string;
}

/**
 * One tick's check. Returns the action to log, or undefined when there is nothing to say: no record,
 * the gateway is gone, nothing relevant changed, or this HEAD was already reported. The event is
 * stamped as reported only after it was written, so a failed write is tried again next tick.
 * `dryRun` names the stale gateway and writes nothing: no event, no stamp.
 */
export function gatewayFreshnessPass(ports: GatewayFreshnessPorts, options: { dryRun?: boolean } = {}): GatewayFreshnessResult | undefined {
	const code = readGatewayCode(ports.stateDir);
	if (code === undefined || !(ports.pidAlive ?? procPidAlive)(code.pid)) return undefined;
	const head = ports.head();
	if (head === undefined || head === code.sha || code.staleReportedFor === head) return undefined;
	const changed = ports.changedFiles(code.sha);
	if (changed === undefined) return { action: "gateway-code-unreadable", detail: `the gateway's start commit ${code.sha.slice(0, 7)} cannot be compared with HEAD ${head.slice(0, 7)}` };
	if (changed.length === 0) return undefined;
	const detail = `started at ${code.sha.slice(0, 7)}, main is ${head.slice(0, 7)}; restart muster-gateway.service`;
	if (options.dryRun !== true) {
		if (!ports.event(`GATEWAY STALE: ${detail}`)) return undefined;
		writeGatewayCode(ports.stateDir, { ...code, staleReportedFor: head });
	}
	return { action: "gateway-stale", detail: `${detail} (${changed.length} file${changed.length === 1 ? "" : "s"} changed under ${GATEWAY_CODE_PATHS.join(", ")})` };
}
