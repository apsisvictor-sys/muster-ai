/**
 * The lab unit guard (LC16c run 2, 2026-10-18 22:23): a bare `muster ledger
 * rollback` from a lab shell stopped the LIVE `muster-tick.timer`, because the
 * lab's systemctl shim was not on PATH and the flip tool's own `systemctl` call
 * went to the real user manager. The root fix lives at that spawn: in a marked
 * lab, a `systemctl` operand must be one the lab mapped to its own unit names
 * (`MUSTER_LAB_UNITS="live=lab,live2=lab2"`); anything else is refused. When
 * the variable is absent nothing is rewritten — the live install behaves
 * exactly as before.
 *
 * The mapping is the marker: its presence says "this process serves a lab",
 * and its pairs are the only units the lab may touch through this seam. A lab
 * that maps nothing therefore refuses every operand (fail closed), and a unit
 * the lab did not name — the live install's tick timer, the gateway, another
 * business's tunnel — can never be reached from a lab command, shim or no shim.
 */

/** `live=lab` pairs; set and empty refuses every operand (fail closed). */
export const MUSTER_LAB_UNITS = "MUSTER_LAB_UNITS";

/**
 * The lab's unit mapping: `undefined` when the variable is absent (no lab),
 * else the pairs the lab named — possibly none, which refuses every operand.
 */
export function labUnitMapping(env: NodeJS.ProcessEnv): Map<string, string> | undefined {
	const raw = env[MUSTER_LAB_UNITS];
	if (raw === undefined) return undefined;
	const mapping = new Map<string, string>();
	for (const pair of raw.split(",")) {
		const equals = pair.indexOf("=");
		if (equals <= 0) continue;
		const live = pair.slice(0, equals).trim();
		const lab = pair.slice(equals + 1).trim();
		if (live !== "" && lab !== "") mapping.set(live, lab);
	}
	return mapping;
}

/**
 * A seam's refusal: the operand is not a unit this lab mapped, so nothing was
 * spawned. A seam whose own vocabulary differs (the gateway's `LogsReadRefusal`,
 * a tool result, an error string) catches this and says it in its own words.
 */
export class LabUnitRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LabUnitRefusal";
	}
}

/**
 * One unit operand through a guarded seam — the unit after a `systemctl` verb,
 * a `kill`/`stop` target, the unit of a `systemd-run` line. Without the marker
 * the operand is returned untouched; in a marked lab an operand the lab named is
 * rewritten to the lab's own unit name and an operand it did not name is
 * refused, so the call fails before any real command is spawned. Every seam
 * applies it exactly once, to the live name, before the spawn.
 */
export function labUnitOperand(unit: string, env: NodeJS.ProcessEnv): string {
	const mapping = labUnitMapping(env);
	if (mapping === undefined) return unit;
	const mapped = mapping.get(unit);
	if (mapped !== undefined) return mapped;
	throw new LabUnitRefusal(
		`lab unit guard: '${unit}' is not a unit this lab mapped (${MUSTER_LAB_UNITS}); a lab command must never reach a live systemd unit (LC16c run 2, 2026-10-18 22:23). Map it in ${MUSTER_LAB_UNITS} or run without the lab marker.`,
	);
}

/** The ledger seam's name for `labUnitOperand`: it was the first caller, and `cli/ledger.ts` keeps it. */
export function labSystemctlOperand(operand: string, env: NodeJS.ProcessEnv): string {
	return labUnitOperand(operand, env);
}
