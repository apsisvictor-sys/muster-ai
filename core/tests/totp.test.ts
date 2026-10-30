import assert from "node:assert/strict";
import test from "node:test";

import { TotpSecretError, totpCode, totpCodeWhenFresh } from "../totp.ts";

/** RFC 6238 Appendix B's SHA-1 secret, "12345678901234567890", in base32. */
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

// The RFC lists 8-digit codes; the 6-digit code is the last six digits of the same truncated value.
const VECTORS: Array<[seconds: number, code: string]> = [
	[59, "287082"],
	[1111111109, "081804"],
	[1111111111, "050471"],
	[1234567890, "005924"],
	[2000000000, "279037"],
	[20000000000, "353130"],
];

test("totpCode matches the RFC 6238 SHA-1 test vectors", () => {
	for (const [seconds, code] of VECTORS) assert.equal(totpCode(RFC_SECRET, seconds * 1000).code, code, `T=${seconds}`);
});

test("totpCode reports the seconds left in the step and takes a Date", () => {
	assert.deepEqual(totpCode(RFC_SECRET, new Date(59_000)), { code: "287082", validForSeconds: 1 });
	assert.equal(totpCode(RFC_SECRET, 30_000).validForSeconds, 30);
	assert.equal(totpCode(RFC_SECRET, 44_999).validForSeconds, 16);
});

test("totpCode reads a secret as a site prints it: lower case, grouped, padded", () => {
	assert.equal(totpCode("gezd gnbv-gy3t qojq gezd gnbv gy3t qojq====", 59_000).code, "287082");
});

test("a secret that is not base32 is refused without echoing it", () => {
	const bad = "not*base32!secret";
	assert.throws(() => totpCode(bad, 0), (error: unknown) => error instanceof TotpSecretError && !(error as Error).message.includes(bad));
	assert.throws(() => totpCode("  ", 0), TotpSecretError);
});

test("totpCodeWhenFresh returns at once when 5 seconds or more remain", async () => {
	const slept: number[] = [];
	const result = await totpCodeWhenFresh(RFC_SECRET, { now: () => new Date(55_000), sleep: async (ms) => void slept.push(ms) });
	assert.deepEqual(result, { code: "287082", validForSeconds: 5 });
	assert.deepEqual(slept, []);
});

test("totpCodeWhenFresh waits for the next step when under 5 seconds remain", async () => {
	let clock = 56_000;
	const slept: number[] = [];
	const result = await totpCodeWhenFresh(RFC_SECRET, {
		now: () => new Date(clock),
		sleep: async (ms) => {
			slept.push(ms);
			clock += ms;
		},
	});
	assert.deepEqual(slept, [4000]);
	assert.deepEqual(result, { code: totpCode(RFC_SECRET, 60_000).code, validForSeconds: 30 });
	assert.notEqual(result.code, totpCode(RFC_SECRET, 56_000).code);
});
