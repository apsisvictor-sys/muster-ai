/**
 * Resume timer tests: the one owner of "resume this lane at time T" (blueprint DS4).
 * The exec port is injected, so no real systemd runs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { musterLauncher } from "../../core/pi-ports.ts";
import { scheduleLaneResume, type ResumeTimerPorts } from "../resume-timer.ts";

function ports(result: { status: number | null; stderr: string }, calls: Array<{ file: string; args: string[] }>): ResumeTimerPorts {
	return {
		exec: (file, args) => {
			calls.push({ file, args });
			return result;
		},
		musterPath: "/agent/extensions/muster/launchers/muster",
		path: "/agent/bin:/usr/bin",
		now: () => new Date("2026-10-09T20:00:00Z"),
	};
}

test("a future time sets a transient user timer that runs muster send --mode wake", () => {
	const calls: Array<{ file: string; args: string[] }> = [];
	const at = new Date("2026-10-09T22:30:00Z");
	const result = scheduleLaneResume("cc-wp2", at, "Continue where you stopped.", ports({ status: 0, stderr: "" }, calls));
	assert.deepEqual(result, { unit: `muster-resume-cc-wp2-${at.getTime() / 1000}` });
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.file, "systemd-run");
	assert.deepEqual(calls[0]!.args, [
		"--user",
		`--unit=muster-resume-cc-wp2-${at.getTime() / 1000}`,
		"--on-calendar=2026-10-09 22:30:00 UTC",
		"--timer-property=AccuracySec=30s",
		"--setenv=PATH=/agent/bin:/usr/bin",
		"/agent/extensions/muster/launchers/muster", "--agent", "muster-tick", "send", "cc-wp2", "Continue where you stopped.", "--mode", "wake",
	]);
});

test("a time already past fires a few seconds from now, not never", () => {
	const calls: Array<{ file: string; args: string[] }> = [];
	const result = scheduleLaneResume("pi-a", new Date("2026-10-09T19:00:00Z"), "go", ports({ status: 0, stderr: "" }, calls));
	assert.ok("unit" in result);
	assert.ok(calls[0]!.args.includes("--on-calendar=2026-10-09 20:00:05 UTC"));
});

test("a lane id with characters a unit name refuses is made safe", () => {
	const calls: Array<{ file: string; args: string[] }> = [];
	const result = scheduleLaneResume("lane/x y", new Date("2026-10-09T21:00:00Z"), "go", ports({ status: 0, stderr: "" }, calls));
	assert.ok("unit" in result && /^muster-resume-lane-x-y-\d+$/.test(result.unit));
	assert.ok(calls[0]!.args.includes("lane/x y"), "the lane id passed to muster send stays exact");
});

test("a systemd-run failure returns the reason instead of throwing", () => {
	const calls: Array<{ file: string; args: string[] }> = [];
	const result = scheduleLaneResume("cc-a", new Date("2026-10-09T21:00:00Z"), "go", ports({ status: 1, stderr: "Failed to connect to bus" }, calls));
	assert.deepEqual(result, { error: "systemd-run failed (exit 1): Failed to connect to bus" });
});

test("bad input never reaches systemd-run", () => {
	const calls: Array<{ file: string; args: string[] }> = [];
	const p = ports({ status: 0, stderr: "" }, calls);
	assert.ok("error" in scheduleLaneResume("", new Date("2026-10-09T21:00:00Z"), "go", p));
	assert.ok("error" in scheduleLaneResume("cc-a", new Date("nope"), "go", p));
	assert.ok("error" in scheduleLaneResume("cc-a", new Date("2026-10-09T21:00:00Z"), "  ", p));
	assert.equal(calls.length, 0);
});

test("the default launcher is the one the CLI ships", () => {
	assert.match(musterLauncher(), /extensions\/muster\/launchers\/muster$/);
});
