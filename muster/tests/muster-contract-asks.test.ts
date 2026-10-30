import "./muster-test-isolation.ts";
/**
 * Contract repairs and system asks (spec §4, OL3b): the doctor-result staleness rule, pinned in literal minutes.
 *
 * The rule is "a result older than two doctor runs counts as red for `doctor-result`" and the doctor runs
 * every five minutes, so two runs are ten minutes. Those minutes are written out here instead of read back
 * from the constant under test: a constant that drifts from ten minutes must fail this fixture, not pass it
 * quietly (review OL3BREV F1).
 *
 * Every read below points at a file this test wrote under the OS temp dir, so nothing here reads the live
 * doctor's result, and no unit is restarted.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DOCTOR_RESULT_STALE_MS, readDoctorResult } from "../health/contract-asks.ts";
import { DERIVED_CONTRACTS } from "../health/contracts.ts";

const MINUTE = 60_000;
/** 10:00 UTC: far from a day boundary, so no clock difference can trip another rule. */
const T0 = Date.parse("2026-10-28T10:00:00.000Z");

/** One contract row as the doctor publishes it: the fields the reader reads, and nothing more. */
function row(id: string): { kind: "service"; id: string; state: "green"; ok: boolean } {
	return { kind: "service", id, state: "green", ok: true };
}

test("result: a result two doctor runs old counts as red for `doctor-result`, and a fresh one is read as it stands", () => {
	const dir = mkdtempSync(join(tmpdir(), "muster-contract-result-"));
	try {
		const file = join(dir, "doctor-result.json");
		const rows = [row("pi-doctor.timer"), row(DERIVED_CONTRACTS.doctorResult)];
		writeFileSync(file, JSON.stringify({ ts: new Date(T0).toISOString(), checks: { contracts: { rows } } }));

		// The doctor's cadence is one run every five minutes, so two runs behind is ten minutes: the value is
		// pinned in literal minutes, not read back from the constant under test (review OL3BREV F1).
		assert.equal(DOCTOR_RESULT_STALE_MS, 10 * MINUTE, "two doctor runs at a five-minute cadence");

		const fresh = readDoctorResult(file, T0 + 4 * MINUTE);
		assert.equal(fresh.error, undefined);
		assert.deepEqual(fresh.rows.map((entry) => [entry.id, entry.state]), [["pi-doctor.timer", "green"], [DERIVED_CONTRACTS.doctorResult, "green"]], "a fresh result is the rows it carries");

		const justInside = readDoctorResult(file, T0 + 9 * MINUTE);
		assert.equal(justInside.rows.find((entry) => entry.id === DERIVED_CONTRACTS.doctorResult)?.state, "green", "nine minutes is still inside two runs");

		const stale = readDoctorResult(file, T0 + 11 * MINUTE);
		const doctorResult = stale.rows.find((entry) => entry.id === DERIVED_CONTRACTS.doctorResult);
		assert.equal(doctorResult?.state, "red", "two missed runs are not evidence of anything");
		assert.match(doctorResult?.reason ?? "", /two runs behind/);
		assert.equal(stale.rows.filter((entry) => entry.id === DERIVED_CONTRACTS.doctorResult).length, 1, "the stale verdict replaces the row, it does not double it");

		const missing = readDoctorResult(join(dir, "absent.json"), T0);
		assert.equal(missing.atMs, null);
		assert.match(missing.error ?? "", /could not be read/);
		assert.equal(missing.rows.find((entry) => entry.id === DERIVED_CONTRACTS.doctorResult)?.state, "red", "no result at all is red too");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
