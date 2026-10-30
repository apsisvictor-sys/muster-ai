/**
 * Harness location test (blueprint §11 RS1 Done 3, §10 Review focus 4, S10/S13).
 *
 * A harness file loaded from a folder outside Pi's profile must still name the
 * profile the *start file* configured, and a second copy of `core/pi-ports.ts`
 * (Pi loads every extension with its own jiti and `moduleCache: false`) must
 * read the same store. Ports unset load cleanly and fail at first use, never at
 * import (Review focus 1).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configurePiPorts, musterLauncher, musterStateDir, piAgentDir, piPort } from "../pi-ports.ts";
import { harnessRoot } from "../harness-paths.ts";

// RS2d: this test lives in `packages/core/tests/`, so the checkout root is three levels up.
const HARNESS_ROOT = harnessRoot(import.meta.url);

test("the configured agentDir wins over the file's own location for every derived path", () => {
	const scratch = mkdtempSync(join(tmpdir(), "pi-agent-scratch-"));
	const previous = process.env.PI_MUSTER_STATE_DIR;
	delete process.env.PI_MUSTER_STATE_DIR;
	try {
		configurePiPorts({ agentDir: scratch });
		assert.equal(piAgentDir(), scratch, "piAgentDir() is the configured folder, not the file's location");
		assert.equal(musterStateDir(), join(scratch, "state", "muster"));
		assert.equal(musterLauncher(), join(scratch, "extensions", "muster", "launchers", "muster"));
		assert.notEqual(resolve(scratch), HARNESS_ROOT, "the scratch folder is unlike the file's location");
	} finally {
		if (previous === undefined) delete process.env.PI_MUSTER_STATE_DIR;
		else process.env.PI_MUSTER_STATE_DIR = previous;
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("PI_MUSTER_STATE_DIR still overrides the state root, not the agent folder", () => {
	const scratch = mkdtempSync(join(tmpdir(), "pi-agent-scratch-"));
	const state = mkdtempSync(join(tmpdir(), "pi-muster-state-"));
	const previous = process.env.PI_MUSTER_STATE_DIR;
	try {
		process.env.PI_MUSTER_STATE_DIR = state;
		configurePiPorts({ agentDir: scratch });
		assert.equal(musterStateDir(), resolve(state));
		assert.equal(piAgentDir(), scratch);
	} finally {
		if (previous === undefined) delete process.env.PI_MUSTER_STATE_DIR;
		else process.env.PI_MUSTER_STATE_DIR = previous;
		rmSync(scratch, { recursive: true, force: true });
		rmSync(state, { recursive: true, force: true });
	}
});

test("a second jiti copy of pi-ports.ts (moduleCache: false) reads the same store", async () => {
	const scratch = mkdtempSync(join(tmpdir(), "pi-agent-scratch-"));
	try {
		configurePiPorts({ agentDir: scratch });
		const { createJiti } = (await import("jiti")) as { createJiti: (url: string, options: { moduleCache: boolean }) => { import: (path: string, options?: { default?: boolean }) => Promise<unknown> } };
		const first = (await createJiti(import.meta.url, { moduleCache: false }).import(pathToFileURL(join(HARNESS_ROOT, "core/pi-ports.ts")).href, { default: true })) as { piAgentDir: () => string };
		const second = (await createJiti(import.meta.url, { moduleCache: false }).import(pathToFileURL(join(HARNESS_ROOT, "core/pi-ports.ts")).href, { default: true })) as { piAgentDir: () => string };
		assert.equal(first.piAgentDir(), scratch, "the first copy reads the configured store");
		assert.equal(second.piAgentDir(), scratch, "the second copy reads the same configured store");
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("with ports unset a harness module imports cleanly and fails only at first use", () => {
	// A child process with no preload and no configured ports: the check is
	// about a process whose start file forgot a port (Review focus 1).
	const probe = [
		`const ports = await import(${JSON.stringify(pathToFileURL(join(HARNESS_ROOT, "core/pi-ports.ts")).href)});`,
		`const binding = await import(${JSON.stringify(pathToFileURL(join(HARNESS_ROOT, "muster/binding.ts")).href)});`,
		`const eventWake = await import(${JSON.stringify(pathToFileURL(join(HARNESS_ROOT, "core/event-wake.ts")).href)});`,
		"const out = { imported: true, eventWakeExports: typeof eventWake.getEventWakeOwner };",
		"try { ports.piAgentDir(); out.agentDir = 'no throw'; } catch (error) { out.agentDir = error.message; }",
		"try { ports.piPort('transcripts'); out.transcripts = 'no throw'; } catch (error) { out.transcripts = error.message; }",
		"try { binding.musterStateDir(); out.stateDir = 'no throw'; } catch (error) { out.stateDir = error.message; }",
		"console.log(JSON.stringify(out));",
	].join("\n");
	const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], {
		cwd: HARNESS_ROOT,
		encoding: "utf8",
		timeout: 120_000,
	});
	const line = (run.stdout ?? "").split("\n").filter((l) => l.startsWith("{")).pop();
	assert.ok(line, `the probe printed no result; stderr: ${(run.stderr ?? "").split("\n").slice(-3).join(" | ")}`);
	const parsed = JSON.parse(line) as Record<string, string>;
	assert.equal(parsed.imported, true, "importing a harness module with ports unset must not throw");
	assert.equal(parsed.eventWakeExports, "function", "a port-free harness module still exports its API");
	assert.match(parsed.agentDir ?? "", /^PiPortMissing: agentDir was not configured by this process's start file$/);
	assert.match(parsed.transcripts ?? "", /^PiPortMissing: transcripts was not configured by this process's start file$/);
	assert.match(parsed.stateDir ?? "", /^PiPortMissing: agentDir was not configured by this process's start file$/);
});
