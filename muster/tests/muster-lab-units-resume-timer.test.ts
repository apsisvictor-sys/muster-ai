/**
 * The lab unit guard over the resume timer (R2, after LC16c run 2, 2026-10-18 22:23).
 *
 * `scheduleLaneResume` is the one owner of "resume this lane at time T" and it starts a
 * transient user unit with `systemd-run --unit=…`. Before this seam was guarded, a
 * marked lab handed that name to the real command whatever it was: a unit the lab
 * never named became a real timer in the live user manager.
 *
 * The claim proven here, one case each:
 * 1. A marked lab refuses a unit name it did not map, before `systemd-run` is called.
 * 2. A marked lab maps the name it named, and the whole argv follows the lab's unit.
 * 3. An unmarked run is untouched: the live install's name goes straight through.
 *
 * `exec` is a stub that records its argv; no unit on this machine is started.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { scheduleLaneResume, type ResumeTimerPorts } from "../resume-timer.ts";

interface Call {
	file: string;
	args: string[];
}

function ports(env: NodeJS.ProcessEnv | undefined, calls: Call[]): ResumeTimerPorts {
	return {
		exec: (file, args) => {
			calls.push({ file, args });
			return { status: 0, stderr: "" };
		},
		musterPath: "/nonexistent/muster",
		path: undefined,
		now: () => new Date("2026-10-19T00:00:00Z"),
		...(env === undefined ? {} : { env }),
	};
}

const AT = new Date("2026-10-19T01:30:00Z");
const LIVE_UNIT = `muster-resume-cc-x-${AT.getTime() / 1000}`;
const LAB_UNIT = "rh-resume-cc-x";

test("a marked lab resumes through the unit it mapped and refuses one it did not; an unmarked run is untouched (2026-10-18 22:23)", () => {
	// 1. The lab mapped a different unit: ours is not one of its pair values, so nothing is spawned.
	const refusedCalls: Call[] = [];
	const refused = scheduleLaneResume("cc-x", AT, "Continue.", ports({ MUSTER_LAB_UNITS: "muster-tick.timer=rh-tick.timer" }, refusedCalls));
	assert.ok("error" in refused, `a marked lab refuses an unmapped resume unit: ${JSON.stringify(refused)}`);
	assert.match(refused.error, /lab unit guard/);
	assert.deepEqual(refusedCalls, [], "nothing reached systemd-run");
	// 2. The lab mapped this unit: the argv carries the lab's own name.
	const mappedCalls: Call[] = [];
	const mapped = scheduleLaneResume("cc-x", AT, "Continue.", ports({ MUSTER_LAB_UNITS: `${LIVE_UNIT}=${LAB_UNIT}` }, mappedCalls));
	assert.deepEqual(mapped, { unit: LAB_UNIT });
	assert.equal(mappedCalls.length, 1);
	assert.equal(mappedCalls[0]!.file, "systemd-run");
	assert.ok(mappedCalls[0]!.args.includes(`--unit=${LAB_UNIT}`), `the lab's unit is the one started: ${mappedCalls[0]!.args.join(" ")}`);
	assert.ok(!mappedCalls[0]!.args.some((arg) => arg.includes(LIVE_UNIT)), "the live name never reaches systemd-run");
	// 3. A bare marker fails closed.
	const bareCalls: Call[] = [];
	const bare = scheduleLaneResume("cc-x", AT, "Continue.", ports({ MUSTER_LAB_UNITS: "" }, bareCalls));
	assert.ok("error" in bare, `a bare marker refuses the resume unit: ${JSON.stringify(bare)}`);
	assert.deepEqual(bareCalls, [], "nothing reached systemd-run under a bare marker");
	// 4. No marker: the live install's name goes through, exactly as before.
	const liveCalls: Call[] = [];
	assert.deepEqual(scheduleLaneResume("cc-x", AT, "Continue.", ports(undefined, liveCalls)), { unit: LIVE_UNIT });
	assert.equal(liveCalls.length, 1);
	assert.ok(liveCalls[0]!.args.includes(`--unit=${LIVE_UNIT}`), liveCalls[0]!.args.join(" "));
});
