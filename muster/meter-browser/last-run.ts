/**
 * The meter browser's own record of what each site answered last (UB0 U-1).
 *
 * `<stateDir>/meter-browser/last-run.json` exists for two readers and holds nothing else:
 *
 *  - the snapshot, which shows a `browser` row's reason from it while the row has no reading, so a
 *    login wall reads "needs your login" instead of "no reading yet" (the store keeps readings only);
 *  - the runner itself, which needs one fact the store cannot give it: which site already had its ask
 *    or its message for today, so a site that stays broken asks the operator once per Sofia day rather than
 *    every hour (VR24-200).
 *
 * One shape, one writer, one reader of the day key. The day is Europe/Sofia everywhere, because that
 * is the day the operator reads things on (the command center's own zone, D46), and a run at 00:30 Sofia is
 * still the day he is living in rather than the UTC day before it.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MeterUnreadable } from "./adapters/types.ts";

/** The directory the meter browser owns under the Muster state dir. */
export const METER_BROWSER_DIR = "meter-browser";
/** The one record of a site's last answer. */
export const METER_LAST_RUN_FILE = "last-run.json";
/** The lock every run takes, beside the directory and never inside the profile (the browser owns that). */
export const METER_LOCK_FILE = "meter-browser.lock";
/** The zone a "day" means to the operator and to this reader. */
export const METER_TIME_ZONE = "Europe/Sofia";

/** What one site answered last, and what has already been raised about it today. */
export type MeterSiteLastRun = {
	/** When the site last answered, ISO. */
	at: string;
	/** The reason it read nothing, when it read nothing; absent after a reading. */
	reason?: MeterUnreadable;
	/** The Sofia day the login ask was last raised for this site (login wall or human check). */
	askDay?: string;
	/** The Sofia day the orchestrator was last told this site's page changed. */
	pageChangedDay?: string;
};

/** The file's whole shape. `sites` is keyed by the site id an adapter declares. */
export type MeterLastRun = {
	version: 1;
	/** When the file was last written, ISO. */
	at: string;
	sites: Record<string, MeterSiteLastRun>;
};

/** `<stateDir>/meter-browser`. */
export function meterBrowserDir(stateDir: string): string {
	return join(stateDir, METER_BROWSER_DIR);
}

/** `<stateDir>/meter-browser/last-run.json`. */
export function meterLastRunPath(stateDir: string): string {
	return join(meterBrowserDir(stateDir), METER_LAST_RUN_FILE);
}

/** `<stateDir>/meter-browser.lock`: the one lock the timer, `refresh` and `login` share. */
export function meterLockPath(stateDir: string): string {
	return join(stateDir, METER_LOCK_FILE);
}

/** One instant as the day the operator is living in: YYYY-MM-DD in Europe/Sofia. */
export function sofiaDay(at: number, timeZone: string = METER_TIME_ZONE): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
		new Date(at),
	);
}

const REASONS: readonly string[] = ["needs your login", "the site asks for a human check", "the page changed"];

function isSiteRecord(value: unknown): value is MeterSiteLastRun {
	if (value === null || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (typeof record["at"] !== "string" || !Number.isFinite(Date.parse(record["at"]))) return false;
	if (record["reason"] !== undefined && !REASONS.includes(String(record["reason"]))) return false;
	for (const key of ["askDay", "pageChangedDay"]) {
		const day = record[key];
		if (day !== undefined && (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day))) return false;
	}
	return true;
}

/**
 * The file as it is on disk, or undefined when it is absent or unreadable. A torn or hand-edited file
 * is no record: the runner then re-raises today's ask, which is the safe direction for an ask and the
 * only direction that never hides a broken site.
 */
export function readMeterLastRun(stateDir: string): MeterLastRun | undefined {
	let raw: string;
	try {
		raw = readFileSync(meterLastRunPath(stateDir), "utf8");
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== "object") return undefined;
	const file = parsed as Record<string, unknown>;
	if (file["version"] !== 1 || typeof file["at"] !== "string") return undefined;
	const sites = file["sites"];
	if (sites === null || typeof sites !== "object") return undefined;
	const out: Record<string, MeterSiteLastRun> = {};
	for (const [site, record] of Object.entries(sites as Record<string, unknown>)) {
		if (isSiteRecord(record)) out[site] = record;
	}
	return { version: 1, at: file["at"], sites: out };
}

/** Write the file whole: temp file, fsync, rename, so a reader never sees half a record. */
export function writeMeterLastRun(stateDir: string, run: MeterLastRun): void {
	mkdirSync(meterBrowserDir(stateDir), { recursive: true, mode: 0o700 });
	const target = meterLastRunPath(stateDir);
	const temporary = `${target}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
	const fd = openSync(temporary, "r+");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, target);
}

/**
 * The reason any of `hosts` read nothing, while it is fresher than `maxAgeMs`, or undefined. A site's
 * id is its hostname (`grok.com`), so a snapshot row finds its site from the inventory's usage URL
 * without importing the adapters.
 */
export function meterUnreadableReasonByHost(
	stateDir: string,
	hosts: readonly string[],
	now: number,
	maxAgeMs: number,
): MeterUnreadable | undefined {
	for (const host of hosts) {
		const reason = meterUnreadableReason(stateDir, host.toLowerCase(), now, maxAgeMs);
		if (reason !== undefined) return reason;
	}
	return undefined;
}

/**
 * The reason a site reads nothing, while it is fresher than `maxAgeMs`, or undefined. The snapshot
 * passes its own `METER_STALE_MS`, so a failure older than a reading is never shown as the current
 * state: past that age the row is back to "no reading yet", exactly as a stale reading stops
 * claiming numbers.
 */
export function meterUnreadableReason(
	stateDir: string,
	site: string,
	now: number,
	maxAgeMs: number,
): MeterUnreadable | undefined {
	const record = readMeterLastRun(stateDir)?.sites[site];
	if (record === undefined || record.reason === undefined) return undefined;
	const at = Date.parse(record.at);
	if (!Number.isFinite(at) || now - at > maxAgeMs) return undefined;
	return record.reason;
}
