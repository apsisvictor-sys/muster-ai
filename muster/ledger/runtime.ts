/**
 * The ledger's crash points.
 *
 * A test arms one point per process with `MUSTER_LEDGER_TEST=1` and
 * `MUSTER_LEDGER_CRASH_AT=<point>`: the process dies or throws exactly there,
 * so a production process can never reach them.
 */

const thrown = new Set<string>();

/** The crash point this process was armed with, or undefined. */
function armed(point: string): string | undefined {
	if (process.env.MUSTER_LEDGER_TEST !== "1") return undefined;
	return process.env.MUSTER_LEDGER_CRASH_AT === point ? point : undefined;
}

/** Die like a crash, the same death the crash gate uses. */
export function crashKill(point: string): void {
	if (armed(point) === undefined) return;
	process.kill(process.pid, "SIGKILL");
}

/** Throw once per process at this point, for a fault a test forces. */
export function crashThrowOnce(point: string): void {
	if (armed(point) === undefined || thrown.has(point)) return;
	thrown.add(point);
	throw new Error(`Muster ledger crash point ${point}`);
}
