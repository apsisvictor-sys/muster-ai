/**
 * The one TOTP owner (UM14): RFC 6238 over HMAC-SHA-1, a 30 second step and
 * 6 digits, which is what an authenticator app computes from the secret a
 * site shows at enrolment. Any later caller that needs a one-time code uses
 * `totpCode`, or `totpCodeWhenFresh` when a person or a browser has to type it.
 *
 * Neither function logs, and no error carries the secret.
 */

import { createHmac } from "node:crypto";

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** A code with fewer seconds than this left may expire before it is typed. */
export const TOTP_MIN_VALID_SECONDS = 5;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export type TotpCode = { code: string; validForSeconds: number };

/** The secret is not base32. The message never holds the secret. */
export class TotpSecretError extends Error {}

/** Base32 (RFC 4648) as sites print it: any case, with spaces or hyphens between groups and optional padding. */
function decodeBase32(secret: string): Buffer {
	const text = secret.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
	if (text === "") throw new TotpSecretError("the TOTP secret is empty");
	let bits = 0;
	let value = 0;
	const bytes: number[] = [];
	for (const char of text) {
		const index = BASE32.indexOf(char);
		if (index < 0) throw new TotpSecretError("the TOTP secret is not base32");
		value = (value << 5) | index;
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((value >>> bits) & 0xff);
		}
	}
	return Buffer.from(bytes);
}

/** The code for the step that contains `now` (a Date or epoch milliseconds), and the whole seconds left in that step. */
export function totpCode(secret: string, now: Date | number): TotpCode {
	const seconds = Math.floor((now instanceof Date ? now.getTime() : now) / 1000);
	const counter = Math.floor(seconds / TOTP_STEP_SECONDS);
	const message = Buffer.alloc(8);
	message.writeBigUInt64BE(BigInt(counter));
	const digest = createHmac("sha1", decodeBase32(secret)).update(message).digest();
	const offset = (digest[digest.length - 1] as number) & 0x0f;
	const binary = digest.readUInt32BE(offset) & 0x7fffffff;
	return {
		code: String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0"),
		validForSeconds: TOTP_STEP_SECONDS - (seconds % TOTP_STEP_SECONDS),
	};
}

/**
 * `totpCode`, except that a code with under `TOTP_MIN_VALID_SECONDS` left waits
 * for the next step and returns that step's code. `now` and `sleep` are the
 * clock and the wait, so a test can drive both.
 */
export async function totpCodeWhenFresh(
	secret: string,
	options: { now?: () => Date; sleep?: (ms: number) => Promise<void> } = {},
): Promise<TotpCode> {
	const now = options.now ?? (() => new Date());
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const first = totpCode(secret, now());
	if (first.validForSeconds >= TOTP_MIN_VALID_SECONDS) return first;
	await sleep(first.validForSeconds * 1000);
	return totpCode(secret, now());
}
