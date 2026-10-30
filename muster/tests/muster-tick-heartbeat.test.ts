import "./muster-test-isolation.ts";
/**
 * The tick's heartbeat (spec §4, OL0b): every real pass writes `state/muster/tick-heartbeat.json` as
 * `{at, pass}`, one pass number further than the last, and that file is the doctor's proof of life for
 * the `muster tick` contract. The doctor's reader side is `health/doctor-contracts.test.ts`; this is the
 * writer's.
 *
 * OS temp directories only: no provider, no Concord, no ledger.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeTickHeartbeat } from "../bin/muster-tick.mts";
import { TICK_HEARTBEAT_FILE } from "../health/contracts.ts";

const AT = new Date("2026-10-28T13:42:11.000Z");

function stateDir(): string {
	return mkdtempSync(join(tmpdir(), "muster-tick-heartbeat-"));
}

test("heartbeat: the tick writes `{at, pass}` into `tick-heartbeat.json` in the muster state directory", () => {
	const dir = stateDir();
	try {
		writeTickHeartbeat(dir, AT);
		const file = join(dir, TICK_HEARTBEAT_FILE);
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { at: AT.toISOString(), pass: 1 }, "the first pass is pass one");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("heartbeat: each pass counts up from the file it finds, so a missed pass is visible", () => {
	const dir = stateDir();
	try {
		writeTickHeartbeat(dir, AT);
		writeTickHeartbeat(dir, new Date(AT.getTime() + 120_000));
		writeTickHeartbeat(dir, new Date(AT.getTime() + 240_000));
		const written = JSON.parse(readFileSync(join(dir, TICK_HEARTBEAT_FILE), "utf8")) as { at: string; pass: number };
		assert.equal(written.pass, 3, "three real passes are pass three");
		assert.equal(written.at, new Date(AT.getTime() + 240_000).toISOString(), "the time is the pass that just ran");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("heartbeat: a torn or missing file starts the count again and never stops the pass", () => {
	const dir = stateDir();
	try {
		writeFileSync(join(dir, TICK_HEARTBEAT_FILE), "{");
		assert.doesNotThrow(() => writeTickHeartbeat(dir, AT), "a heartbeat is never the end of a pass");
		assert.deepEqual(JSON.parse(readFileSync(join(dir, TICK_HEARTBEAT_FILE), "utf8")), { at: AT.toISOString(), pass: 1 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
