/**
 * `meter-browser` — the start file `pi-meter-browser.service` runs (UB0 U-1, VR24-196 V1).
 *
 * One hourly run of the reader on this PC: it takes the meter browser's lock without waiting, asks the
 * memory gate whether the machine has room, reads grok.com and platform.openai.com through the
 * read-only facade, writes one `meter` signal per site that read, and leaves one ask or one message a
 * site a day when a site reads nothing.
 *
 * Exit codes are the timer's whole contract: 0 for a run that read, was skipped by the gate, or found
 * the lock held (a run wrote nothing, which is the designed answer), and 2 for a call that could not
 * be made at all. It never exits 1, because 1 is `flock` saying the lock is held and the two must not
 * be confused (`runner.ts` `withMeterLock`).
 */

import { musterStateDir } from "../binding.ts";
import { formatMeterRun, meterSelfLaunch, runMeterBrowser, withMeterLock } from "../meter-browser/runner.ts";

/** `--site <id>` reads one site; everything else reads them all, in the declared order. */
function siteArg(argv: readonly string[]): string | undefined {
	const at = argv.indexOf("--site");
	return at === -1 ? undefined : argv[at + 1];
}

export async function run(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
	const stateDir = musterStateDir();
	const lock = await withMeterLock({ stateDir, launch: meterSelfLaunch(argv) });
	if (lock.kind === "busy") {
		// The hour found the lock held: nothing is opened and nothing is written, and the timer is content.
		process.stdout.write("meter-browser: skipped, another run holds the lock\n");
		return 0;
	}
	if (lock.kind === "finished") {
		// The parent's wrapped child has already run this same command, under the lock; the parent's whole job
		// was to hand it the lock, so it ends with that child's code and does no work of its own.
		return lock.code;
	}
	const site = siteArg(argv);
	try {
		const result = await runMeterBrowser({ stateDir, ...(site === undefined ? {} : { site }) });
		process.stdout.write(`${formatMeterRun(result)}\n`);
		return 0;
	} catch (error) {
		// A run that threw is 2, never 1: 1 is `flock` saying the lock is held, and a crash read as "busy"
		// would hide the failure behind a skip.
		process.stderr.write(`meter-browser: ${error instanceof Error ? error.message : String(error)}\n`);
		return 2;
	}
}

// The start file that runs this is `scripts/meter-browser.ts` (Pi's profile, where the ports are
// configured); it calls `run()` and exits with its code.
