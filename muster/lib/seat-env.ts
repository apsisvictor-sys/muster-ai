/**
 * The three environment names a seat holder's session carries (seats blueprint): the role, its credential
 * and the epoch the credential was minted at. The adapters set them and the bus reads them. This leaf owns the
 * list (it imports nothing, so `seats.ts` and `claude-lane-card.ts` can both use it), and every launcher that
 * starts a session for someone else scrubs exactly these names: a Claude daemon spawns every session from the
 * environment of the `claude --bg` call that started it, so a credential in a launcher's environment becomes
 * every later lane's credential (seat1, 2026-10-23). `scripts/pi-lane-launch.sh` keeps the same list as
 * `SEAT_SCRUB`; a test holds the two equal.
 */

export const SEAT_ENV_ROLE = "MUSTER_SEAT";
export const SEAT_ENV_TOKEN = "MUSTER_SEAT_TOKEN";
export const SEAT_ENV_EPOCH = "MUSTER_SEAT_EPOCH";
export const SEAT_ENV_NAMES = [SEAT_ENV_ROLE, SEAT_ENV_TOKEN, SEAT_ENV_EPOCH] as const;

/** A copy of `env` without the seat credential, for a process that starts another session. */
export function withoutSeatCredential(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const copy: NodeJS.ProcessEnv = { ...env };
	for (const name of SEAT_ENV_NAMES) delete copy[name];
	return copy;
}
