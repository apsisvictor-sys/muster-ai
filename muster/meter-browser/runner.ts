/**
 * The meter browser's one run (UB0 U-1, VR24-196 V1, VR24-200, VR24-201): lock, memory gate, two
 * sites, one reading each, and — when a site reads nothing — the one ask or the one message that site
 * earns for the day.
 *
 * The order of a run is the design, in this order, and every step fails closed:
 *
 *  1. the lock (`flock --nonblock`, `withMeterLock`). Held means the run does nothing: the timer exits
 *     0 and `refresh`/`login` say "the meter browser is busy". Nothing ever waits on it.
 *  2. the memory gate, before Chrome starts (UD7): `heavy-gate.sh --status` through the command
 *     center's own reader. `wouldAdmit` false, or `availableMb` under one run's measured peak, means
 *     this run writes nothing and exits 0. The rows then age, and routing reads them as unknown,
 *     which is the honest state rather than a number read from a machine under pressure.
 *  3. each site, in declared order, through its adapter and the read-only facade (UD6), inside 45 s.
 *     A site that fails does not stop the next one: only its own row turns.
 *  4. one `raiseSignal` per site that read. A failed site writes no signal at all, so the store holds
 *     readings and nothing else; its reason goes to `last-run.json`, which the snapshot reads.
 *  5. the ask or the message, once per site per Sofia day: a login wall or a human check raises one
 *     `human-login` ask (nobody solves a CAPTCHA) and then waits — while that ask is open, the next
 *     Sofia day raises nothing (VR24-230) — and a changed page tells the orchestrator, never the operator,
 *     because an adapter's selectors are development (VR24-200).
 *
 * Memory: one run of this reader measures `METER_RUN_PEAK_MB` (recorded in `reports/u1-report.md`),
 * and the gate refuses a run the machine cannot hold. Nothing here sets a CPU or memory limit on the
 * browser itself: the gate is the guard, exactly as it is for every other heavy job on this PC.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { musterStateDir } from "../binding.ts";
import { findOpenDuplicate, raiseAsk, readAsks, type AskQueue } from "../asks.ts";
import { writeInboxMessage } from "../lib/agent-inbox.ts";
import { raiseSignal, type RaiseSignalInput } from "../signals.ts";
import { METER_SITES, meterSiteFor } from "./adapters/index.ts";
import {
	UNREADABLE_HUMAN_CHECK,
	UNREADABLE_LOGIN,
	UNREADABLE_PAGE_CHANGED,
	isUnreadable,
	type AdapterResult,
	type MeterSite,
	type MeterUnreadable,
} from "./adapters/types.ts";
import { createFacade, openMeterBrowser, type FacadePage, type MeterBrowser, type MeterFacade } from "./facade.ts";
import {
	meterLockPath,
	readMeterLastRun,
	sofiaDay,
	writeMeterLastRun,
	type MeterLastRun,
} from "./last-run.ts";

/** One site's turn in a run: the adapter's read is inside this, and a timeout is that site's failure. */
export const METER_SITE_TIMEOUT_MS = 45_000;

/**
 * One run's measured peak resident memory over the whole browser process tree, in MiB (UD7): the gate
 * refuses a run whose `availableMb` is under it, and writes nothing. Measured on this PC: a live
 * headless run over both sites peaked at 1760 MiB (2 026-10-26, `reports/u1-report.md`), so the
 * constant is that measurement rounded up. A change that makes a page heavier re-measures it.
 */
export const METER_RUN_PEAK_MB = 1_800;

/** The writer of every reading and of every ask this reader produces (UD3). */
export const METER_WRITER = "meter-browser";

/** The environment flag that says this process already holds the lock and must do the work. */
export const METER_LOCKED_ENV = "PI_METER_BROWSER_LOCKED";

/** What the ask or the message about a site is about. It is the reader's own name in both records. */
const ASK_SOURCE = METER_WRITER;

/** One site's outcome in a run. */
export type MeterSiteOutcome =
	| { site: string; kind: "reading"; windows: number; written: boolean }
	| { site: string; kind: "unreadable"; reason: MeterUnreadable; asked: boolean; messaged: boolean }
	| { site: string; kind: "error"; message: string };

/** The gate's own answer, as `heavy-gate.sh --status` states it. */
export type MeterGateReading = { wouldAdmit: boolean; availableMb: number | null; reason: string };

/** How a run ended. `skipped-gate` is a decision, not a failure: nothing was written. */
export type MeterRunResult = {
	kind: "ran" | "skipped-gate";
	gate: MeterGateReading;
	sites: MeterSiteOutcome[];
};

/** Everything a run may be handed, so a test drives the whole path without a browser or a live gate. */
export type MeterRunPorts = {
	stateDir?: string;
	now?: () => number;
	/** The sites to read; defaults to the declared list, in its order. */
	sites?: readonly MeterSite[];
	/** One site by id, as `--site` names it. */
	site?: string;
	/** The page to drive. A test passes one for every site; a real run opens a browser instead. */
	page?: FacadePage;
	/** A facade per site, for a test that gives each site its own fixture page instead of a browser. */
	facadeFor?: (site: MeterSite) => MeterFacade;
	openBrowser?: () => Promise<MeterBrowser>;
	gate?: () => Promise<MeterGateReading>;
	/** One run's peak, when a test needs a gate it controls; defaults to `METER_RUN_PEAK_MB`. */
	peakMb?: number;
	timeoutMs?: number;
	/** Where a run's own lines go; defaults to stdout. */
	log?: (line: string) => void;
};

/**
 * The repo's heavy-gate script, the one reader of the machine's headroom.
 *
 * The gate moved with muster (OL12-D8): it sits in this package's own
 * `scripts/` folder, found beside this file rather than through the Pi profile
 * (S10's own-package rule).
 */
export function meterGateScript(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "heavy-gate.sh");
}

/**
 * The gate, through the command center's own reader so there is one parse of `heavy-gate.sh --status`.
 * A gate that cannot be read is a closed gate: a run that cannot prove there is room leaves the
 * machine alone and writes nothing.
 */
async function readMeterGate(port: MeterRunPorts["gate"]): Promise<MeterGateReading> {
	if (port !== undefined) return port();
	try {
		const { gateStatusReader } = await import("../gateway/command-center.ts");
		const status = await gateStatusReader(meterGateScript())();
		return { wouldAdmit: status.wouldAdmit, availableMb: status.availableMb, reason: status.reason };
	} catch (error) {
		return { wouldAdmit: false, availableMb: null, reason: `the gate could not be read: ${errorText(error)}` };
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** One promise, given a deadline. A site that hangs is that site's failure, never the run's. */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} did not answer within ${timeoutMs} ms`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** The sites a run reads: one named by `--site`, or all of them in their declared order. */
function sitesFor(ports: MeterRunPorts): readonly MeterSite[] {
	if (ports.sites !== undefined) {
		const wanted = ports.site?.trim();
		if (wanted === undefined || wanted === "") return ports.sites;
		const match = ports.sites.find((site) => site.site.toLowerCase() === wanted.toLowerCase());
		return match === undefined ? [] : [match];
	}
	if (ports.site === undefined || ports.site.trim() === "") return METER_SITES;
	const match = meterSiteFor(ports.site);
	return match === undefined ? [] : [match];
}

/**
 * One run. The caller holds the lock (`withMeterLock`): this function never locks, so the lock covers
 * exactly the process that opened the profile.
 */
export async function runMeterBrowser(ports: MeterRunPorts = {}): Promise<MeterRunResult> {
	const stateDir = ports.stateDir ?? musterStateDir();
	const now = ports.now ?? Date.now;
	const log = ports.log ?? ((line: string) => process.stdout.write(`${line}\n`));
	const peakMb = ports.peakMb ?? METER_RUN_PEAK_MB;
	const sites = sitesFor(ports);
	if (sites.length === 0) throw new Error(`no meter site is called ${JSON.stringify(ports.site ?? "")}`);

	const gate = await readMeterGate(ports.gate);
	if (!gate.wouldAdmit || (gate.availableMb !== null && gate.availableMb < peakMb)) {
		log(`meter-browser: skipped, the gate has no room (${gate.reason || "no reason stated"}${gate.availableMb === null ? "" : `, ${gate.availableMb} MB free`})`);
		return { kind: "skipped-gate", gate, sites: [] };
	}

	const lastRun: MeterLastRun = readMeterLastRun(stateDir) ?? { version: 1, at: new Date(now()).toISOString(), sites: {} };
	const injected = ports.page !== undefined || ports.facadeFor !== undefined;
	const browser = injected ? undefined : await (ports.openBrowser ?? (() => openMeterBrowser()))();
	const outcomes: MeterSiteOutcome[] = [];
	try {
		for (const site of sites) {
			let result: AdapterResult;
			try {
				// Opening the facade is inside the try too: a browser that will not open for one site is that
				// site's failure, not the run's, so the next site is still read (Review Focus 2).
				const facade = ports.facadeFor?.(site) ?? createFacade(ports.page ?? browser!, site);
				result = await withTimeout(site.read(facade), ports.timeoutMs ?? METER_SITE_TIMEOUT_MS, site.site);
			} catch (error) {
				// A site that throws (a dead pipe, a page that never loaded) is that site's failure: no signal,
				// no ask, and the run continues with the next site. The line names the site and the error's
				// class, never its message: a browser error can quote a URL, a header or the page's own text,
				// and none of that belongs in a log (VR24-207 F3).
				log(`meter-browser: ${site.site} failed (${error instanceof Error ? error.name : "error"})`);
				outcomes.push({ site: site.site, kind: "error", message: errorText(error) });
				continue;
			}
			outcomes.push(await applySiteResult({ stateDir, site, result, now, lastRun, log }));
		}
	} finally {
		if (browser !== undefined) await browser.close();
	}
	lastRun.at = new Date(now()).toISOString();
	writeMeterLastRun(stateDir, lastRun);
	return { kind: "ran", gate, sites: outcomes };
}

/** What one site's answer costs the store, the operator's queue and the orchestrator. */
async function applySiteResult(options: {
	stateDir: string;
	site: MeterSite;
	result: AdapterResult;
	now: () => number;
	lastRun: MeterLastRun;
	log: (line: string) => void;
}): Promise<MeterSiteOutcome> {
	const { stateDir, site, result, now, lastRun, log } = options;
	const atMs = now();
	const at = new Date(atMs).toISOString();
	const previous = lastRun.sites[site.site];

	if (!isUnreadable(result)) {
		const windows = result.windows as RaiseSignalInput["windows"];
		const write = await raiseSignal(stateDir, METER_WRITER, {
			kind: "meter",
			source: "dashboard",
			provider: site.provider,
			observedAt: at,
			confidence: "high",
			windows,
			...(result.billing === undefined ? {} : { billing: result.billing }),
			...(result.balance === undefined ? {} : { balance: result.balance }),
		});
		// A reading clears the reason: a row must not keep yesterday's wall beside today's numbers.
		lastRun.sites[site.site] = {
			at,
			...(previous?.askDay === undefined ? {} : { askDay: previous.askDay }),
			...(previous?.pageChangedDay === undefined ? {} : { pageChangedDay: previous.pageChangedDay }),
		};
		log(`meter-browser: ${site.site} read ${result.windows.length} window${result.windows.length === 1 ? "" : "s"}${write.duplicate ? " (already in the store for this hour)" : ""}`);
		return { site: site.site, kind: "reading", windows: result.windows.length, written: !write.duplicate };
	}

	const reason = result.unreadable;
	const day = sofiaDay(atMs);
	const next = { ...(previous ?? { at }), at, reason } as MeterLastRun["sites"][string];
	let asked = false;
	let held = false;
	let messaged = false;
	if (reason === UNREADABLE_LOGIN || reason === UNREADABLE_HUMAN_CHECK) {
		// One ask per site per Sofia day: the row keeps reading the reason meanwhile, and the queue
		// never fills with the same request (VR24-200). While the reader's own ask is open it waits
		// (VR24-230), so the queue holds one ask for the site, not one per day.
		if (previous?.askDay !== day) {
			const question = `Log the meter browser into ${site.site}: muster usage login ${site.site}`;
			// The reader asks once and waits (VR24-230): while its own open ask holds this question, the
			// next Sofia day does not raise it again. The queue owns the comparison of two questions
			// (`findOpenDuplicate`), so this reader asks it instead of comparing the words itself.
			if (hasOpenAsk(stateDir, question)) {
				held = true;
			} else {
				raiseAsk(stateDir, {
					by: METER_WRITER,
					kind: "human-login",
					question,
					source: ASK_SOURCE,
				});
				next.askDay = day;
				asked = true;
			}
		}
	} else if (reason === UNREADABLE_PAGE_CHANGED) {
		// A changed page is development, not a request to the operator: the orchestrator gets one message a day.
		if (previous?.pageChangedDay !== day) {
			writeInboxMessage(stateDir, {
				agent: "orchestrator",
				from: METER_WRITER,
				at,
				text: `The meter adapter for ${site.site} no longer reads the page`,
				idempotencyKey: `${METER_WRITER}:page-changed:${site.site}:${day}`,
				mode: "followup",
			});
			next.pageChangedDay = day;
			messaged = true;
		}
	}
	lastRun.sites[site.site] = next;
	log(
		`meter-browser: ${site.site} reads "${reason}"${asked ? ", asked the operator once today" : ""}${held ? ", the open ask stands" : ""}${messaged ? ", told the orchestrator once today" : ""}`,
	);
	return { site: site.site, kind: "unreadable", reason, asked, messaged };
}

/**
 * Whether this reader's own open ask already holds this question (VR24-230).
 *
 * The queue owns the comparison of two questions (`findOpenDuplicate`, `asks.ts`), so the reader
 * asks it rather than comparing the words itself. Only the reader's own asks count: an ask another
 * writer raised with the same words is that writer's, and this reader still raises its own. A closed
 * ask covers nothing, so a site whose ask was answered asks again on a later day.
 */
function hasOpenAsk(stateDir: string, question: string): boolean {
	const queue = readAsks(stateDir);
	const mine: AskQueue = { ...queue, asks: queue.asks.filter((ask) => ask.raisedBy === METER_WRITER) };
	return findOpenDuplicate(mine, { question }) !== undefined;
}

// ─── The lock ────────────────────────────────────────────────────────────────

/**
 * What `withMeterLock` answers. Exactly one process in a run does the work: `held` is the child, which
 * was launched under `flock` and owns the profile; `busy` is a caller that found the lock taken; and
 * `finished` is a parent whose wrapped child has already run, carrying that child's exit code.
 */
export type MeterLockResult = { kind: "held" } | { kind: "busy" } | { kind: "finished"; code: number };

/** What the lock wraps: this same command, launched again under `flock`. */
export type MeterLockLaunch = { command: string; args: string[] };

/** This process, launched again: the interpreter, its loader flags and the script it is running. */
export function meterSelfLaunch(argv: readonly string[] = process.argv.slice(2)): MeterLockLaunch {
	const script = process.argv[1];
	if (script === undefined) throw new Error("the meter browser cannot lock: this process has no script path");
	return { command: process.execPath, args: [...process.execArgv, script, ...argv] };
}

/** The whole command line one locked run is: `flock --nonblock <lock> <self>`. */
export function meterLockCommand(stateDir: string, launch: MeterLockLaunch): MeterLockLaunch {
	return { command: "flock", args: ["--nonblock", meterLockPath(stateDir), launch.command, ...launch.args] };
}

/**
 * Run a command under the meter browser's one lock, without waiting for it.
 *
 * The parent process execs `flock --nonblock <lock> <self>`, and the child (flag set) does the work.
 * `flock` itself exits 1 when it cannot take the lock at once, which is why the locked child is
 * required to exit 0 or 2 and never 1 — that contract is what makes "busy" a fact the caller can act
 * on rather than a guess about an exit code.
 */
export async function withMeterLock(options: {
	stateDir: string;
	launch: MeterLockLaunch;
	env?: NodeJS.ProcessEnv;
}): Promise<MeterLockResult> {
	const env = options.env ?? process.env;
	// This process is the locked child: it already holds the lock, so the caller does the work here and
	// never launches itself again.
	if (env[METER_LOCKED_ENV] === "1") return { kind: "held" };
	const command = meterLockCommand(options.stateDir, options.launch);
	const code = await new Promise<number>((resolve, reject) => {
		const child = spawn(command.command, command.args, {
			env: { ...env, [METER_LOCKED_ENV]: "1" },
			stdio: "inherit",
		});
		child.on("error", reject);
		child.on("exit", (exitCode) => resolve(exitCode ?? 1));
	});
	if (code === 1) {
		// `flock` exits 1 both when it cannot take the lock and when the wrapped command exits 1, so the code
		// alone cannot tell a busy reader from a child that crashed. Ask the lock itself: if it can be taken
		// now, nobody held it and the 1 was the child's own failure, which must never read as "busy".
		if (await meterLockIsFree(options.stateDir)) return { kind: "finished", code: 1 };
		return { kind: "busy" };
	}
	return { kind: "finished", code };
}

/** Whether the meter browser's lock can be taken right now, asked of `flock` itself. */
async function meterLockIsFree(stateDir: string): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const child = spawn("flock", ["--nonblock", meterLockPath(stateDir), "true"], { stdio: "ignore" });
		child.on("error", () => resolve(true));
		child.on("exit", (code) => resolve(code === 0));
	});
}

// ─── Lines a run prints ──────────────────────────────────────────────────────

/** One line for the journal, the timer's only need: what the run did, or that it left the machine alone. */
export function formatMeterRun(result: MeterRunResult): string {
	if (result.kind === "skipped-gate") {
		return `meter-browser: skipped, the gate has no room (${result.gate.reason || "no reason stated"})`;
	}
	if (result.sites.length === 0) return "meter-browser: no site read";
	const parts = result.sites.map((site) => {
		if (site.kind === "reading") return `${site.site} ${site.windows} window${site.windows === 1 ? "" : "s"}`;
		if (site.kind === "unreadable") return `${site.site} ${site.reason}`;
		return `${site.site} failed`;
	});
	return `meter-browser: ${parts.join("; ")}`;
}
