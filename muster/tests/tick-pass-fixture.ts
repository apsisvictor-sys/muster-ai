/**
 * OL4: the recording pass the ledger fixtures bind.
 *
 * The durable task runs the timer's whole pass, and the live bindings in `bin/muster-tick.mts` read the
 * machine: the heartbeat file, the project catalogue, lane cards, the ask queue. A ledger fixture must not
 * touch any of them, so it binds this pass instead: every step records its name and returns what the
 * override returns (nothing by default), the sinks record their lines, and `stateDir` is the fixture's own
 * directory (the lock lives there, never in the live `state/muster`).
 */

import type { TickPassPorts, TickPassStep } from "../tick.ts";

export type RecordedPass = {
	ports: TickPassPorts;
	/** The steps that ran, in order, by the pass's own step names. */
	steps: string[];
	/** What the pass wrote to its stdout sink. */
	out: string[];
	/** What the pass wrote to its stderr sink. */
	err: string[];
	/** How many times the pass marked the run failed. */
	failed: number;
};

/** A pass over `stateDir` whose steps record and whose sinks record. `overrides` replaces a step's work, not its name. */
export function recordingTickPass(stateDir: string, overrides: Partial<TickPassPorts> = {}): RecordedPass {
	const steps: string[] = [];
	const out: string[] = [];
	const err: string[] = [];
	const recorded: RecordedPass = { ports: undefined as never, steps, out, err, failed: 0 };
	const step = (name: string, run: () => TickPassStep | Promise<TickPassStep>) => async (): Promise<TickPassStep> => {
		steps.push(name);
		return await run();
	};
	recorded.ports = {
		stateDir: overrides.stateDir ?? (() => stateDir),
		heartbeat: () => {
			steps.push("heartbeat");
			overrides.heartbeat?.();
		},
		replaySpool: async () => {
			steps.push("spool replay");
			await overrides.replaySpool?.();
		},
		quota: step("quota fallback", overrides.quota ?? (() => ({}))),
		graphRefresh: step("graph refresh pass", overrides.graphRefresh ?? (() => ({}))),
		gatewayFreshness: step("gateway freshness pass", overrides.gatewayFreshness ?? (() => ({}))),
		askPush: step("ask push", overrides.askPush ?? (() => ({}))),
		standingRules: step("standing-rule pass", overrides.standingRules ?? (() => ({}))),
		wakeHealth: step("Henry wake health pass", overrides.wakeHealth ?? (() => ({}))),
		tick: step("tick pass", overrides.tick ?? (() => ({}))),
		out: overrides.out ?? ((line) => void out.push(line)),
		err: overrides.err ?? ((line) => void err.push(line)),
		fail: overrides.fail ?? (() => void (recorded.failed += 1)),
		...(overrides.reconcile === undefined ? {} : { reconcile: overrides.reconcile }),
		...(overrides.lifecycle === undefined ? {} : { lifecycle: overrides.lifecycle }),
	};
	return recorded;
}
