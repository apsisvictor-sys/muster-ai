/**
 * The launch recipe's model resolution (2026-10-09).
 *
 * With no `--model`, `scripts/pi-lane-launch.sh` asks the one owner of the
 * per-harness defaults (provider-pool.json laneDefaults, through
 * harness/muster/lane-model.mjs) and prints the model and its reason. An
 * explicit `--model` is checked against the harness's own model catalog first:
 * a Pi model outside the pool is refused and the launcher stops with the note
 * (P5-D6, no override). These are dry runs: nothing is created.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeBrief } from "./lane-brief-fixture.ts";
import { harnessRoot } from "../../core/harness-paths.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);
const RECIPE = join(HARNESS_ROOT, "muster", "scripts", "pi-lane-launch.sh");
const NOW = Date.now();
const HOUR = 3_600_000;

type Lab = { dir: string; env: NodeJS.ProcessEnv; agentDir: string };

const POOL = (laneDefaults: unknown) => ({
	version: 1,
	virtualProvider: "pool",
	cooldownMs: HOUR,
	resetHorizonMs: 24 * HOUR,
	roles: { worker: ["alpha/a", "beta/b"] },
	laneDefaults,
	quotaShapes: [{ id: "wall", match: "QUOTA_WALL" }],
});

const PI_DEFAULTS = { pi: { candidates: ["cc/ds-flash", "ocg/ds-flash"], fallbackRole: "worker" }, opencode: ["opencode/one-free"], claude: "sonnet" };

/** A private tmux server (TMUX_TMPDIR) and a fixture agent dir holding the pool and its walls. */
function withLab(laneDefaults: unknown, walls: Record<string, unknown> | undefined, run: (lab: Lab) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "lane-model-"));
	const agentDir = join(dir, "agent");
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "provider-pool.json"), `${JSON.stringify(POOL(laneDefaults), null, "\t")}\n`);
	if (walls) {
		mkdirSync(join(agentDir, "state"), { recursive: true });
		writeFileSync(join(agentDir, "state", "provider-walls.json"), `${JSON.stringify(walls)}\n`);
	}
	const fakePi = join(dir, "fake-pi.sh");
	writeFileSync(fakePi, "#!/bin/sh\nexec sleep 30\n");
	chmodSync(fakePi, 0o755);
	const fakeClaude = join(dir, "claude");
	writeFileSync(fakeClaude, '#!/bin/sh\nif [ "$1" = "agents" ]; then echo "[]"; exit 0; fi\necho deadbeef\n');
	chmodSync(fakeClaude, 0o755);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		TMUX_TMPDIR: dir,
		PI_BIN: fakePi,
		PI_LANES_TMUX_SESSION: "lm-test",
		PI_LANES_JSON: join(dir, "pi-lanes.json"),
		PATH: `${dir}:${process.env.PATH}`,
	};
	delete env["TMUX"];
	try {
		run({ dir, env, agentDir });
	} finally {
		spawnSync("tmux", ["kill-server"], { env, stdio: "ignore" });
		rmSync(dir, { recursive: true, force: true });
	}
}

function dry(lab: Lab, args: string[]): { status: number | null; output: string } {
	const result = spawnSync(RECIPE, ["--lane", "lm-lane", "--cwd", lab.dir, "--agent-dir", lab.agentDir, "--dry-run", ...args], { encoding: "utf8", timeout: 60_000, env: lab.env });
	return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

test("pi: with no --model the harness default is printed and passed to the pi command", () => {
	withLab(PI_DEFAULTS, undefined, (lab) => {
		const result = dry(lab, ["--harness", "pi"]);
		assert.equal(result.status, 0, result.output);
		assert.match(result.output, /pi-lane-launch: model cc\/ds-flash \(pi default\)/);
		assert.match(result.output, /--model cc\/ds-flash/);
	});
});

test("pi: a walled first candidate is skipped and the choice names it", () => {
	withLab(PI_DEFAULTS, { cc: { until: new Date(NOW + HOUR).toISOString() } }, (lab) => {
		const result = dry(lab, ["--harness", "pi"]);
		assert.equal(result.status, 0, result.output);
		assert.match(result.output, /model ocg\/ds-flash \(pi default; skipped cc\/ds-flash \(walled\)\)/);
	});
});

test("pi: every candidate walled falls through the pool's fallback role", () => {
	const walls = { cc: { until: new Date(NOW + HOUR).toISOString() }, ocg: { until: new Date(NOW + HOUR).toISOString() } };
	withLab(PI_DEFAULTS, walls, (lab) => {
		const result = dry(lab, ["--harness", "pi"]);
		assert.equal(result.status, 0, result.output);
		assert.match(result.output, /model alpha\/a \(fallback through the pool's "worker" role/);
	});
});

test("pi: an explicit --model wins as is and nothing is resolved", () => {
	withLab(PI_DEFAULTS, undefined, (lab) => {
		// A pool ref, because an explicit model outside the pool is refused (P5-D6, below).
		const result = dry(lab, ["--harness", "pi", "--model", "alpha/a"]);
		assert.equal(result.status, 0, result.output);
		assert.match(result.output, /--model alpha\/a/);
		assert.doesNotMatch(result.output, /pi-lane-launch: model /);
	});
});

test("pi: an explicit model on a walled provider warns and the dry launch still succeeds (WARN1)", () => {
	withLab(PI_DEFAULTS, { alpha: { until: new Date(NOW + HOUR).toISOString() } }, (lab) => {
		const result = dry(lab, ["--harness", "pi", "--model", "alpha/a"]);
		assert.equal(result.status, 0, result.output);
		assert.match(result.output, /pi-lane-launch: warning: model alpha\/a walled at launch, until \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ \(\d\d:\d\d EES?T\)/);
		assert.match(result.output, /--model alpha\/a/, "the lane is still started on the named model");
		// A model on an open provider, with the same wall file, prints no warning.
		const open = dry(lab, ["--harness", "pi", "--model", "beta/b"]);
		assert.equal(open.status, 0, open.output);
		assert.doesNotMatch(open.output, /walled at launch/);
	});
});

test("pi: an explicit model outside the pool is refused by the shell (P5-D6)", () => {
	withLab(PI_DEFAULTS, undefined, (lab) => {
		// A model Pi's own settings enable is listed and still refused: the pool is the only place work goes.
		writeFileSync(join(lab.agentDir, "settings.json"), JSON.stringify({ enabledModels: ["someone/else"] }));
		const result = dry(lab, ["--harness", "pi", "--model", "someone/else"]);
		assert.equal(result.status, 2, result.output);
		assert.match(result.output, /model someone\/else is refused/);
		assert.match(result.output, /P5-D6/);
		assert.doesNotMatch(result.output, /would create/);
	});
});

test("claude: with no --model the alias is used, and an explicit one wins", () => {
	withLab(PI_DEFAULTS, undefined, (lab) => {
		const fixture = makeBrief();
		try {
			const auto = dry(lab, ["--harness", "claude", "--brief", fixture.path]);
			assert.equal(auto.status, 0, auto.output);
			assert.match(auto.output, /model sonnet \(claude default\)/);
			assert.match(auto.output, /--model sonnet/);
			const explicit = dry(lab, ["--harness", "claude", "--brief", fixture.path, "--model", "opus"]);
			assert.equal(explicit.status, 0, explicit.output);
			assert.match(explicit.output, /--model opus/);
		} finally {
			fixture.remove();
		}
	});
});

test("opencode: every free model walled refuses instead of falling back to a paid one", { skip: spawnSync("opencode", ["--version"]).status !== 0 }, () => {
	const walls = { "opencode/one-free": { until: new Date(NOW + HOUR).toISOString() } };
	withLab(PI_DEFAULTS, walls, (lab) => {
		const result = dry(lab, ["--harness", "opencode"]);
		assert.equal(result.status, 2, result.output);
		assert.match(result.output, /no default model for harness opencode: every free OpenCode model is walled/);
		assert.doesNotMatch(result.output, /would create/);
	});
});
