/**
 * The guard that keeps launcher tests out of the live lifecycle dir
 * (lane-state-lab.ts). It is exercised against a fake live state dir, never the
 * real one.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordLaunch } from "../lane-lifecycle.ts";
import { labInstallEnv, liveLaunchRecordGuard } from "./lane-state-lab.ts";

function withFakeLive(run: (stateDir: string) => void): void {
	const stateDir = mkdtempSync(join(tmpdir(), "live-guard-"));
	try {
		run(stateDir);
	} finally {
		rmSync(stateDir, { recursive: true, force: true });
	}
}

test("a launcher test that leaves a lab-cwd record in the live state dir fails the guard", () => {
	withFakeLive((stateDir) => {
		const guard = liveLaunchRecordGuard(stateDir);
		recordLaunch(stateDir, { laneId: "hyg-leftover", harness: "pi", cwd: join(tmpdir(), "lane-hygiene-x"), branch: null, launchedBy: "orchestrator", title: "A lane the lab leaves behind" });
		assert.deepEqual(guard.leaked(), ["hyg-leftover"]);
		assert.throws(() => guard.assertUntouched(), /hyg-leftover/);
	});
});

test("a record that was already there, or a real lane launched meanwhile, is not the test's leak", () => {
	withFakeLive((stateDir) => {
		recordLaunch(stateDir, { laneId: "old-lab", harness: "pi", cwd: join(tmpdir(), "old"), branch: null, launchedBy: "orchestrator", title: "A lane of an older lab" });
		const guard = liveLaunchRecordGuard(stateDir);
		recordLaunch(stateDir, { laneId: "sn-real", harness: "claude", cwd: "/home/operator/.worktrees/real-lane", branch: "lane/real", launchedBy: "orchestrator", title: "A lane somewhere outside the lab" });
		assert.deepEqual(guard.leaked(), []);
		assert.doesNotThrow(() => guard.assertUntouched());
	});
});

test("the lab install env pairs a lab agent dir with the state dir under it", () => {
	const env = labInstallEnv("/tmp/lab-x");
	assert.equal(env.PI_MUSTER_STATE_DIR, join(env.PI_CODING_AGENT_DIR, "state", "muster"));
	assert.ok(env.PI_CODING_AGENT_DIR.startsWith("/tmp/lab-x/"));
});
