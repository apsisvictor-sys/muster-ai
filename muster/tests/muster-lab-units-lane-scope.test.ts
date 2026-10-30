/**
 * The lab unit guard over a lane's helper scope (R2, after LC16c run 2, 2026-10-18 22:23).
 *
 * `closeLane` and the janitor stop a lane's dev-server scope through
 * `stopHelperScopeProcess`, which spawns `systemctl` by PATH. Before this seam was
 * guarded, a marked lab reached the real command with any scope name it was given:
 * the incident shape is a lab stop aimed at a unit the lab never mapped.
 *
 * The claim proven here, one case each:
 * 1. A marked lab maps a live scope to its own, and every call names the lab's unit.
 * 2. A marked lab refuses a scope it did not map, and nothing is spawned.
 * 3. A marker that maps nothing refuses every operand (fail closed).
 * 4. An unmarked run is untouched: the live name goes straight through.
 *
 * Every `systemctl` here is a fake script that records its argv, so no unit on this
 * machine is touched.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { realCloseLanePorts, stopIdleHelperScopes } from "../lane-lifecycle-ports.ts";

const LIVE_UNIT = "muster-lane-dev-server-live.scope";
const OTHER_LIVE_UNIT = "muster-lane-dev-server-other.scope";
const LAB_UNIT = "rh-lane-dev-server-live.scope";

interface Fixture {
	dir: string;
	calls: string;
	active: string;
	/** The live ports with a marker set (`undefined` leaves the live install's behaviour). */
	ports(marker: string | undefined): ReturnType<typeof realCloseLanePorts>;
	/** What the fake `systemctl` recorded so far. */
	recorded(): string[];
}

function fixture(t: { after(fn: () => void): void }): Fixture {
	const dir = mkdtempSync(join(tmpdir(), "muster-lab-units-lane-scope-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const bin = join(dir, "bin");
	mkdirSync(bin);
	const calls = join(dir, "systemctl-calls.log");
	const active = join(dir, "active");
	// Records every argv. `is-active` answers "active" once while the marker file is there, then
	// "inactive", so one stop runs to its end without waiting out a grace.
	writeFileSync(
		join(bin, "systemctl"),
		[
			"#!/usr/bin/env bash",
			`printf '%s\\n' "$*" >> ${JSON.stringify(calls)}`,
			'if [ "$2" = "is-active" ]; then',
			`  if [ -f ${JSON.stringify(active)} ]; then rm -f ${JSON.stringify(active)}; exit 0; fi`,
			"  exit 3",
			"fi",
			"exit 0",
			"",
		].join("\n"),
	);
	chmodSync(join(bin, "systemctl"), 0o755);
	const originalPath = process.env["PATH"];
	process.env["PATH"] = `${bin}:${originalPath ?? ""}`;
	t.after(() => {
		if (originalPath === undefined) delete process.env["PATH"];
		else process.env["PATH"] = originalPath;
	});
	const envWith = (marker: string | undefined): NodeJS.ProcessEnv => ({ ...process.env, ...(marker === undefined ? {} : { MUSTER_LAB_UNITS: marker }) });
	return {
		dir,
		calls,
		active,
		ports: (marker) => realCloseLanePorts(dir, envWith(marker)),
		recorded: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter((line) => line !== "") : []),
	};
}

test("a marked lab stops the scope it mapped and never the live one; an unmarked run is untouched (2026-10-18 22:23)", async (t) => {
	const f = fixture(t);
	const marker = `${LIVE_UNIT}=${LAB_UNIT}`;
	// 1. The lab's own mapping: the live scope name is rewritten, and only the lab's unit is acted on.
	writeFileSync(f.active, "");
	assert.equal(await f.ports(marker).stopHelperScope(LIVE_UNIT), "stopped");
	const mapped = f.recorded();
	assert.ok(mapped.includes(`--user kill --signal=TERM ${LAB_UNIT}`), `the lab's scope is killed: ${mapped.join("\n")}`);
	assert.ok(mapped.includes(`--user stop ${LAB_UNIT}`), `the lab's scope is stopped: ${mapped.join("\n")}`);
	assert.ok(mapped.every((line) => line.endsWith(LAB_UNIT)), `no call names the live unit: ${mapped.join("\n")}`);
	// 2. A scope the lab did not map: refused before any spawn.
	rmSync(f.calls, { force: true });
	await assert.rejects(f.ports(marker).stopHelperScope(OTHER_LIVE_UNIT), /lab unit guard/, "an unmapped live scope is refused");
	assert.equal(existsSync(f.calls), false, "nothing reached systemctl for the unmapped scope");
	// The janitor's sweep goes through the same guard: its candidate list never reaches an unmapped unit.
	await assert.rejects(stopIdleHelperScopes(f.dir, [{ unit: OTHER_LIVE_UNIT, laneId: "pi-x", phase: "closed" }], [OTHER_LIVE_UNIT], { ...process.env, MUSTER_LAB_UNITS: marker }), /lab unit guard/);
	assert.equal(existsSync(f.calls), false, "nothing reached systemctl from the janitor's sweep");
	// 3. A marker that maps nothing fails closed.
	await assert.rejects(f.ports("").stopHelperScope(LIVE_UNIT), /lab unit guard/, "a bare marker refuses the live scope");
	assert.equal(existsSync(f.calls), false, "nothing reached systemctl under a bare marker");
	// 4. No marker: the live install's own name goes through, exactly as before.
	writeFileSync(f.active, "");
	assert.equal(await f.ports(undefined).stopHelperScope(LIVE_UNIT), "stopped");
	const unmarked = f.recorded();
	assert.ok(unmarked.includes(`--user kill --signal=TERM ${LIVE_UNIT}`), `an unmarked run is untouched: ${unmarked.join("\n")}`);
	assert.ok(unmarked.includes(`--user stop ${LIVE_UNIT}`), `an unmarked run is untouched: ${unmarked.join("\n")}`);
});
