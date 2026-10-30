/**
 * The event-loop lag line of `musterd` (LC16 finding 16).
 *
 * A timer that should fire every `intervalMs` and fires late says the loop did not
 * run for that long. The lag alone cannot tell the two causes apart, so each report
 * carries the CPU time the process used while it waited: a daemon blocked by its own
 * synchronous call uses CPU for the whole lag, a daemon the host did not schedule
 * (a stalled PC, swap) uses almost none.
 */

export type LoopLag = {
	/** How late the timer fired, in milliseconds. */
	lagMs: number;
	/** User and system CPU the process used during that lag, in milliseconds. */
	cpuMs: number;
};

export type LoopLagOptions = {
	intervalMs?: number;
	/** A lag at or above this is reported; shorter ones are scheduling noise. */
	thresholdMs?: number;
};

/** A reply to a hook has 483 ms, a caller's default 2000 ms: 250 ms is a lag a caller can feel. */
const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_THRESHOLD_MS = 250;

/** Start watching this process's event loop; the returned function stops it. The timer never keeps the process alive. */
export function watchEventLoop(report: (lag: LoopLag) => void, options: LoopLagOptions = {}): () => void {
	const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
	const thresholdMs = options.thresholdMs ?? DEFAULT_THRESHOLD_MS;
	let lastAt = performance.now();
	let lastCpu = process.cpuUsage();
	const timer = setInterval(() => {
		const now = performance.now();
		const cpu = process.cpuUsage();
		const lagMs = now - lastAt - intervalMs;
		const cpuMs = (cpu.user - lastCpu.user + (cpu.system - lastCpu.system)) / 1000;
		lastAt = now;
		lastCpu = cpu;
		if (lagMs >= thresholdMs) report({ lagMs: Math.round(lagMs), cpuMs: Math.round(cpuMs) });
	}, intervalMs);
	timer.unref();
	return () => clearInterval(timer);
}
