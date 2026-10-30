/**
 * The tick pass's lock and its only owner (OL4, spec §10).
 *
 * The timer and the durable task run the same pass, so one of them has to lose: the winner holds an
 * exclusive `flock` on `state/muster/tick.lock` for the length of its pass, and the loser prints one line
 * and runs nothing.
 *
 * The primitive is here rather than in `tick.ts` because taking a `flock` means running a holder process,
 * and the tick library is deliberately incapable of starting or stopping one: `muster-rotation.test.ts`
 * guards that rule by reading `tick.ts` and `rotation.ts` for any process-control surface. The pass keeps
 * the order and the meaning of losing, this module keeps the one way to take the lock, and the guard is
 * unchanged.
 *
 * The janitor's pass keeps its own lock (`bin/muster-janitor.mts`'s `holdPassLock` on `janitor.lock`): two
 * passes protecting two different files, so neither lock is a second implementation of the other.
 */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** The pass's lock file under the state directory (OL4, spec §10). */
export const TICK_LOCK_FILE = "tick.lock";

/** What the loser of the lock logs, exactly (OL4, spec §10). */
export const TICK_LOCK_HELD = "skipped: lock held";

/** A held lock. Releasing closes the holder's read, so `flock` exits and the lock is free. */
export type TickPassLock = { file: string; release(): void };

/** The lock's answer: held, held elsewhere (`busy`), or `flock` could not be run at all. */
export type TickLockResult =
	| { kind: "held"; lock: TickPassLock }
	| { kind: "busy" }
	| { kind: "unavailable"; reason: string };

/**
 * Take the pass's exclusive `flock` on `file` (OL4), so the timer and the durable task can never act on
 * the same pass at once. The holder is `flock -n <file> sh -c 'echo HELD; read'`, the shape
 * `muster-janitor.mts`'s `holdPassLock` uses: it prints `HELD` once it has the lock and stays until the
 * pipe closes. A `busy` answer is `flock -n`'s own refusal; `unavailable` means the tool could not be
 * run, which is not the same thing and is reported rather than read as a busy lock.
 */
export function holdTickLock(file: string): Promise<TickLockResult> {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (value: TickLockResult): void => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		let holder: ReturnType<typeof spawn>;
		try {
			mkdirSync(dirname(file), { recursive: true });
			holder = spawn("flock", ["-n", file, "sh", "-c", "echo HELD; read -r _ || true"], { stdio: ["pipe", "pipe", "pipe"] });
		} catch (error) {
			settle({ kind: "unavailable", reason: error instanceof Error ? error.message : String(error) });
			return;
		}
		holder.stdout?.setEncoding("utf8");
		holder.stdout?.on("data", (chunk: string) => {
			if (!chunk.includes("HELD")) return;
			settle({
				kind: "held",
				lock: {
					file,
					release() {
						try {
							holder.stdin?.end();
						} catch {
							// the holder is already gone
						}
						holder.unref();
						holder.kill();
					},
				},
			});
		});
		holder.on("error", (error) => settle({ kind: "unavailable", reason: error.message }));
		// `flock -n` exits 1 at once without printing when another run holds the lock.
		holder.on("exit", (code) => settle(code === 1 ? { kind: "busy" } : { kind: "unavailable", reason: `flock exited ${String(code)}` }));
	});
}
