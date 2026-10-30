import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { musterStateDir } from "../binding.ts";
import { programmeControlStateDir } from "../control.ts";
import { programmeDecisionStateDir } from "../decisions.ts";
import { relaySocketPath } from "../bridge.ts";
import { projectCataloguePath } from "../projects.ts";
import { supervisorStatePath } from "../recovery.ts";
import { lanesRegistryPath } from "../cli/lanes.ts";
import { decompositionsStateDir } from "../agile.ts";
import { programmesStateDir } from "../../core/programme.ts";
import { learnedWallsPath } from "../../routing/provider-pool.ts";
import { harnessRoot } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);

// The A0 gate fixture starts a real Pi agent that loads the live Muster extension.
// Its environment must send every registry write to a temp root (a lane card, a
// pi-lanes.json row, programme state) and keep it out of the live Concord workspace.
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");
const extensionsDir = resolve(piAgentDir(), "extensions");
const liveAgentDir = resolve(extensionsDir, "..");
const liveStateDir = join(liveAgentDir, "state");

type Env = Record<string, string>;
const LIVE_LOOKING: Env = {
	PATH: process.env.PATH ?? "",
	CONCORD_REPO_ROOT: liveAgentDir,
	CONCORD_AGENT_ID: "orchestrator",
	CONCORD_TASK: "T-live",
	PI_LANES_REPO_ROOT: liveAgentDir,
	PI_MUSTER_STATE_DIR: join(liveStateDir, "muster"),
	PI_MUSTER_CONTROL_DIR: join(liveStateDir, "muster", "programmes", "control"),
	PI_ACTIVITY_LOG: join(liveAgentDir, "logs", "activity.log"),
};

/** The fixture's own env construction, run through python so the test reads what the fixture uses. */
function fixtureEnv(base: Env, root: string): Env {
	const script = "import sys, json; sys.path.insert(0, sys.argv[1]); from herdr_gate_env import isolated_env; print(json.dumps(isolated_env(json.loads(sys.argv[2]), sys.argv[3])))";
	return JSON.parse(execFileSync("python3", ["-I", "-c", script, fixtures, JSON.stringify(base), root], { encoding: "utf8" })) as Env;
}

const root = "/tmp/a0-state-testroot";
const under = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);

/** Lane cards in the live registry that belong to a throwaway gate agent (cwd /tmp/a0-lane-*). */
function liveGateLaneRows(): string[] {
	const dir = join(liveStateDir, "muster", "lanes");
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((name) => {
		try { return String(JSON.parse(readFileSync(join(dir, name), "utf8")).cwd ?? "").startsWith("/tmp/a0-lane-"); } catch { return false; }
	}).sort();
}

test("the gate agent's env carries no live-bus identity and no path under the live state dir", () => {
	const env = fixtureEnv(LIVE_LOOKING, root);
	for (const name of ["CONCORD_REPO_ROOT", "CONCORD_AGENT_ID", "CONCORD_TASK", "PI_LANES_REPO_ROOT"]) assert.equal(env[name], undefined, name);
	for (const [name, value] of Object.entries(env)) {
		if (name === "PATH") continue;
		assert.ok(!under(resolve(value), liveAgentDir), `${name}=${value} points into the live agent dir`);
	}
	assert.ok(under(env.PI_MUSTER_STATE_DIR!, root));
});

test("every state path the Muster extension resolves lands in the temp root under the gate env, and no lane row is added to the live registry", () => {
	const before = liveGateLaneRows();
	const env = fixtureEnv(LIVE_LOOKING, root);
	const saved = { ...process.env };
	try {
		for (const name of Object.keys(process.env)) delete process.env[name];
		Object.assign(process.env, env);
		const resolved: Record<string, string> = {
			musterStateDir: musterStateDir(),
			programmeControlStateDir: programmeControlStateDir(),
			programmeDecisionStateDir: programmeDecisionStateDir(),
			relaySocketPath: relaySocketPath(),
			projectCataloguePath: projectCataloguePath(),
			supervisorStatePath: supervisorStatePath(),
			lanesRegistryPath: lanesRegistryPath(),
			decompositionsStateDir: decompositionsStateDir(),
			programmesStateDir: programmesStateDir(),
			learnedWallsPath: learnedWallsPath(),
			PI_ACTIVITY_LOG: process.env.PI_ACTIVITY_LOG!,
		};
		for (const [name, path] of Object.entries(resolved)) assert.ok(under(path, root), `${name} resolves to ${path}, outside ${root}`);
	} finally {
		for (const name of Object.keys(process.env)) delete process.env[name];
		Object.assign(process.env, saved);
	}
	assert.deepEqual(liveGateLaneRows(), before);
});

test("a state-path env name read by the Muster extension or lib is isolated, dropped or explicitly left live", () => {
	// Left live on purpose: read-only configuration, a test-log path, or the agent root, which also holds the model credentials.
	const leftLive = new Set(["PI_CODING_AGENT_DIR", "PI_PROVIDER_POOL_PATH", "PI_TOOLBELT_HOME", "PI_TEST_LOG"]);
	const handled = new Set(Object.keys(fixtureEnv({}, root)));
	const dropped = ["CONCORD_REPO_ROOT", "PI_LANES_REPO_ROOT"];
	const names = new Set<string>();
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir)) {
			if (entry === "node_modules" || entry === "tests") continue;
			const path = join(dir, entry);
			if (statSync(path).isDirectory()) walk(path);
			else if (path.endsWith(".ts")) {
				for (const match of readFileSync(path, "utf8").matchAll(/env(?:\.|\["|\[')((?:PI|CONCORD|MUSTER)_[A-Z_]+)/g)) names.add(match[1]!);
			}
		}
	};
	walk(join(extensionsDir, "muster"));
	walk(join(extensionsDir, "lib"));
	const statePaths = [...names].filter((name) => /(STATE|DIR|FILE|PATH|SOCKET|JSON|LOG|ROOT|HOME)$/.test(name));
	const unhandled = statePaths.filter((name) => !handled.has(name) && !dropped.includes(name) && !leftLive.has(name));
	assert.deepEqual(unhandled, [], `add these to fixtures/herdr_gate_env.py (or leftLive here, with a reason)`);
});
