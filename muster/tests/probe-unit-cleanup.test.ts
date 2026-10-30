import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { harnessRoot } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);

/**
 * A probe that starts a transient unit clears it when it ends (S6 of VR24-209, report O7).
 *
 * `cc-killprobe-target.service` sat in the failed list from 2026-10-21 21:14 (`Sent signal SIGKILL ...
 * on client request` / `Failed with result 'signal'`) because the probe stopped the unit and never ran
 * `systemctl --user reset-failed`: a stopped unit with a failed result stays failed for good, and the
 * user manager reports itself degraded from then on. That probe was typed by hand in a session and no
 * longer exists in this repository (`git log -S killprobe --all` finds plan text only), so what is left
 * to guard is the rule itself, on the probes the repository does own: every `--unit=<name>` a script
 * starts must be cleared by a `reset-failed` in that same script.
 *
 * The check is a property of the script text, so it is cheap and it cannot start a unit itself.
 */

const SCRIPTS = join(piAgentDir(), "scripts");

/** The probes that start their own transient units and end: each must clean up after itself. */
const PROBES = ["pi-psi-guard-lab.sh", "pi-psi-guard-live.sh"];

/** Unit names a script starts through `systemd-run --unit=<name>` (or `--unit <name>`). */
function startedUnits(script: string): string[] {
	const names = new Set<string>();
	for (const match of script.matchAll(/--unit[= ]"?([A-Za-z0-9@:_.-]+)"?/g)) names.add(match[1]!.replace(/\.service$/, ""));
	return [...names];
}

/** What a script's `reset-failed` calls clear: exact names and `prefix-*` globs. */
function clearedUnits(script: string): { exact: string[]; globs: string[] } {
	const exact: string[] = [];
	const globs: string[] = [];
	for (const match of script.matchAll(/reset-failed\s+(?:"|')?([A-Za-z0-9@:_.*-]+)(?:"|')?/g)) {
		const name = match[1]!.replace(/\.service$/, "");
		if (name.includes("*")) globs.push(name.replace(/\*.*$/, ""));
		else exact.push(name);
	}
	return { exact, globs };
}

/** The units a script leaves in the failed list, as names. Empty means it cleans up after itself. */
function unclearedUnits(script: string): string[] {
	const { exact, globs } = clearedUnits(script);
	return startedUnits(script).filter((unit) => !exact.includes(unit) && !globs.some((prefix) => unit.startsWith(prefix)));
}

test("the check reads both the started units and the cleanup of a real probe", () => {
	const lab = readFileSync(join(SCRIPTS, "pi-psi-guard-lab.sh"), "utf8");
	assert.deepEqual(startedUnits(lab).sort(), ["psi-lab-decoy", "psi-lab-guard", "psi-lab-ramp"]);
	assert.deepEqual(unclearedUnits(lab), []);
});

test("every probe clears every unit it starts", () => {
	for (const probe of PROBES) {
		const script = readFileSync(join(SCRIPTS, probe), "utf8");
		assert.ok(startedUnits(script).length > 0, `${probe} starts a unit, so it has something to clear`);
		assert.deepEqual(unclearedUnits(script), [], `${probe} leaves a failed unit behind`);
	}
});

test("a probe that stops its unit without reset-failed is caught", () => {
	const probe = readFileSync(join(SCRIPTS, "pi-psi-guard-live.sh"), "utf8");
	const stripped = probe.replace(/^\s*systemctl --user reset-failed.*$/gm, "");
	assert.notEqual(stripped, probe, "the live probe does clear its units today");
	assert.deepEqual(unclearedUnits(stripped).sort(), ["psi-live-deadman", "psi-live-ramp"]);
	const fixture = join(mkdtempSync(join(tmpdir(), "probe-cleanup-")), "probe.sh");
	writeFileSync(fixture, stripped);
	assert.deepEqual(unclearedUnits(readFileSync(fixture, "utf8")).sort(), ["psi-live-deadman", "psi-live-ramp"]);
});
