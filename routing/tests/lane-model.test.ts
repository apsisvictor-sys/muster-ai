/**
 * The P5-D6 guard at the shell (UM10): `lane-model.mjs --explicit <model>` checks the
 * operator's choice against the harness's own catalog (`lib/lane-control.ts`, the one owner)
 * before the launcher starts a lane. Every model the shipped pool lists must still pass —
 * the guard refuses only what the pool does not route — and a Pi model outside the pool is
 * refused with the P5-D6 note whatever reason is offered, because the ruling keeps no
 * override. The launcher's own path is covered by pi-lane-launch-model.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPoolConfig, poolConfigPath, type PoolConfig, type RouteDecision } from "../provider-pool.ts";
import { harnessRoot, tsxLoaderPath } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);
const CLI = join(HARNESS_ROOT, "muster", "lane-model.mjs");
const MUSTER_CLI = join(piAgentDir(), "scripts", "muster.mts");
const TSX_LOADER = tsxLoaderPath();
const SHIPPED = poolConfigPath();

function helper(agentDir: string, harness: string, extra: string[] = [], env: NodeJS.ProcessEnv = process.env): { status: number; stdout: string; stderr: string } {
	try {
		const stdout = execFileSync("node", [CLI, "--harness", harness, "--agent-dir", agentDir, "--json", ...extra], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
		return { status: 0, stdout, stderr: "" };
	} catch (error) {
		const failure = error as { status?: number; stdout?: string; stderr?: string };
		return { status: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
	}
}

test("the guard accepts every model the shipped pool lists, so no lane the pool routes today is refused", () => {
	const dir = mkdtempSync(join(tmpdir(), "lane-model-guard-"));
	try {
		copyFileSync(SHIPPED, join(dir, "provider-pool.json"));
		const loaded = loadPoolConfig(SHIPPED);
		assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.errors.join("; "));
		const { config } = loaded as { ok: true; config: PoolConfig };
		const refs = new Set<string>();
		for (const chain of Object.values(config.roles)) for (const ref of chain) refs.add(ref);
		for (const ref of config.freeRefs) refs.add(ref);
		for (const ref of config.laneDefaults?.pi.candidates ?? []) refs.add(ref);
		for (const ref of config.laneDefaults?.opencode ?? []) refs.add(ref);
		// VR18 removed the personal OpenCode Go refs and Henry's option C removed the three weaker
		// free OpenCode lane refs (2026-10-18 22:00), so the shipped list holds 10.
		assert.ok(refs.size >= 2, /* 2026-10-23: DeepSeek CC, MiniMax, classifier, grok hard */ `the shipped pool lists ${refs.size} refs`);
		for (const ref of refs) {
			const result = helper(dir, "pi", ["--explicit", ref]);
			assert.equal(result.status, 0, `${ref} was refused: ${result.stderr}`);
			assert.equal(JSON.parse(result.stdout).model, ref);
		}
		// Claude keeps its own alias catalog: it runs on the Claude Max subscription and is never
		// treated as the metered `anthropic` provider.
		const aliases = ["haiku", "sonnet", "opus", config.laneDefaults?.claude ?? ""].filter((alias) => alias !== "");
		for (const alias of aliases) {
			const result = helper(dir, "claude", ["--explicit", alias]);
			assert.equal(result.status, 0, `${alias} was refused: ${result.stderr}`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a Pi model outside the pool is refused, and no reason flag admits it (P5-D6)", () => {
	const dir = mkdtempSync(join(tmpdir(), "lane-model-refuse-"));
	try {
		writeFileSync(join(dir, "provider-pool.json"), JSON.stringify({
			version: 1,
			virtualProvider: "pool",
			cooldownMs: 3_600_000,
			resetHorizonMs: 3_024_000_000,
			freeRefs: ["x/free-model:free"],
			laneDefaults: { pi: { candidates: ["a/paid"], fallbackRole: "w" }, opencode: ["oc/one-free"], claude: "sonnet" },
			roles: { w: ["a/paid", "x/free-model:free"] },
			quotaShapes: [{ id: "wall", match: "QUOTA_WALL" }],
		}));
		const refused = helper(dir, "pi", ["--explicit", "nowhere/at-all"]);
		assert.equal(refused.status, 1, refused.stdout + refused.stderr);
		const payload = JSON.parse(refused.stdout);
		assert.equal(payload.model, null);
		assert.match(payload.reason, /not in the pi catalog/);
		assert.equal(helper(dir, "pi", ["--explicit", "a/paid"]).status, 0, "a lane default candidate passes");
		assert.equal(helper(dir, "pi", ["--explicit", "x/free-model:free"]).status, 0, "a free ref passes");
		assert.equal(helper(dir, "claude", ["--explicit", "opus"]).status, 0, "a Claude alias passes");
		// There is no override: an unknown flag is a bad invocation, never a reason that admits a model.
		const withReason = helper(dir, "pi", ["--explicit", "a/paid", "--reason", "because"]);
		assert.equal(withReason.status, 2, withReason.stdout + withReason.stderr);
		// Pi's own settings list models beside the pool; a settings-only model is listed and refused.
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ enabledModels: ["someone/else"] }));
		const settingsOnly = helper(dir, "pi", ["--explicit", "someone/else"]);
		assert.equal(settingsOnly.status, 1, "Pi's settings do not admit a model to the pool");
		const settingsPayload = JSON.parse(settingsOnly.stdout);
		assert.equal(settingsPayload.model, null);
		assert.match(settingsPayload.reason, /P5-D6/);
		assert.match(settingsPayload.reason, /outside provider-pool\.json/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** WARN1: a pool with a paid and a free ref, an agent dir holding the given walls, and the launcher-free helper call. */
function withWallLab(walls: Record<string, unknown> | undefined, employerAccounts: string[], run: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "lane-model-warn-"));
	try {
		writeFileSync(join(dir, "provider-pool.json"), JSON.stringify({
			version: 1,
			virtualProvider: "pool",
			cooldownMs: 3_600_000,
			resetHorizonMs: 3_024_000_000,
			freeRefs: ["x/free-model:free"],
			employerAccounts,
			laneDefaults: { pi: { candidates: ["a/paid"], fallbackRole: "w" }, opencode: ["oc/one-free"], claude: "sonnet" },
			roles: { w: ["a/paid", "b/other", "x/free-model:free"] },
			quotaShapes: [{ id: "wall", match: "QUOTA_WALL" }],
		}));
		if (walls) {
			mkdirSync(join(dir, "state"), { recursive: true });
			writeFileSync(join(dir, "state", "provider-walls.json"), `${JSON.stringify(walls)}\n`);
		}
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

test("WARN1: a walled explicit model warns with the wall's time and still launches with exit 0", () => {
	withWallLab({ a: { until: inAnHour() } }, [], (dir) => {
		const until = "2099-01-15T05:03:35.757Z";
		writeFileSync(join(dir, "state", "provider-walls.json"), JSON.stringify({ a: { until } }));
		const run = helper(dir, "pi", ["--explicit", "a/paid"]);
		assert.equal(run.status, 0, run.stdout + run.stderr);
		const payload = JSON.parse(run.stdout);
		assert.equal(payload.model, "a/paid", "the choice is the operator's, never refused or swapped");
		assert.equal(payload.source, "explicit");
		assert.equal(payload.warning, "walled at launch, until 2099-01-15T05:03:35Z (07:03 EET)");
		// Summer date: the Sofia reading is EEST.
		writeFileSync(join(dir, "state", "provider-walls.json"), JSON.stringify({ a: { until: "2099-07-15T05:03:35.757Z" } }));
		assert.equal(JSON.parse(helper(dir, "pi", ["--explicit", "a/paid"]).stdout).warning, "walled at launch, until 2099-07-15T05:03:35Z (08:03 EEST)");
	});
});

test("WARN1: the warning also reaches stderr in plain mode, and the decision is still logged as the orchestrator's", () => {
	withWallLab({ a: { until: inAnHour() } }, [], (dir) => {
		const env: NodeJS.ProcessEnv = { ...process.env };
		delete env.PI_ROUTING_DECISIONS_PATH;
		const run = execFileSyncPlain(dir, ["--explicit", "a/paid", "--lane", "pi-warn1"], env);
		assert.equal(run.status, 0, run.stdout + run.stderr);
		assert.match(run.stderr, /lane-model: warning: a\/paid walled at launch, until /);
		const lines = readFileSync(join(dir, "state", "routing", "decisions.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as RouteDecision);
		assert.equal(lines.length, 1);
		assert.equal(lines[0].by, "orchestrator");
	});
});

test("WARN1: an unwalled explicit model prints nothing new", () => {
	withWallLab({ b: { until: inAnHour() } }, [], (dir) => {
		const run = helper(dir, "pi", ["--explicit", "a/paid"]);
		assert.equal(run.status, 0, run.stdout + run.stderr);
		assert.equal(JSON.parse(run.stdout).warning, undefined);
		assert.equal(run.stderr, "");
		const plain = execFileSyncPlain(dir, ["--explicit", "a/paid"], process.env);
		assert.equal(plain.stderr, "");
		// An expired wall is not a wall.
		writeFileSync(join(dir, "state", "provider-walls.json"), JSON.stringify({ a: { until: new Date(Date.now() - 60_000).toISOString() } }));
		assert.equal(JSON.parse(helper(dir, "pi", ["--explicit", "a/paid"]).stdout).warning, undefined);
	});
});

test("WARN1: a free ref walls alone, and a default (no --explicit) resolution carries no warning", () => {
	withWallLab({ "x/free-model:free": { until: inAnHour() } }, [], (dir) => {
		assert.match(JSON.parse(helper(dir, "pi", ["--explicit", "x/free-model:free"]).stdout).warning, /^walled at launch, until /);
		assert.equal(JSON.parse(helper(dir, "pi", ["--explicit", "a/paid"]).stdout).warning, undefined, "the free ref's wall does not touch a paid ref");
		const defaulted = helper(dir, "pi");
		assert.equal(defaulted.status, 0, defaulted.stdout + defaulted.stderr);
		assert.equal(JSON.parse(defaulted.stdout).warning, undefined);
	});
});

test("WARN1: a wall on another account's key does not warn", () => {
	withWallLab({ "a@acme-realty": { until: inAnHour() } }, ["a"], (dir) => {
		const personalEnv: NodeJS.ProcessEnv = { ...process.env };
		delete personalEnv.PI_EMPLOYER;
		assert.equal(JSON.parse(helper(dir, "pi", ["--explicit", "a/paid"], personalEnv).stdout).warning, undefined, "the work wall never blocks a personal process");
		const workRun = helper(dir, "pi", ["--explicit", "a/paid"], { ...process.env, PI_EMPLOYER: "acme-realty" });
		assert.match(JSON.parse(workRun.stdout).warning, /^walled at launch, until /, "the work process sees its own wall");
		// And the personal wall does not warn the work process.
		writeFileSync(join(dir, "state", "provider-walls.json"), JSON.stringify({ a: { until: inAnHour() } }));
		assert.equal(JSON.parse(helper(dir, "pi", ["--explicit", "a/paid"], { ...process.env, PI_EMPLOYER: "acme-realty" }).stdout).warning, undefined);
		assert.match(JSON.parse(helper(dir, "pi", ["--explicit", "a/paid"], personalEnv).stdout).warning, /^walled at launch/);
	});
});

/** The helper without `--json`: the plain stdout/stderr an operator sees. */
function execFileSyncPlain(agentDir: string, extra: string[], env: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } {
	const result = spawnSync("node", [CLI, "--harness", "pi", "--agent-dir", agentDir, ...extra], { encoding: "utf8", env });
	return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("the helper logs its own decision under bare node, and `muster route explain` reads it back", () => {
	const dir = mkdtempSync(join(tmpdir(), "lane-model-bare-"));
	try {
		copyFileSync(SHIPPED, join(dir, "provider-pool.json"));
		// The helper derives the log's path from --agent-dir; an inherited override would move it.
		const env: NodeJS.ProcessEnv = { ...process.env };
		delete env.PI_ROUTING_DECISIONS_PATH;
		const run = helper(dir, "pi", ["--lane", "pi-um10b"], env);
		assert.equal(run.status, 0, run.stdout + run.stderr);
		const resolved = (JSON.parse(run.stdout) as { model: string }).model;
		// No tsx subprocess and no second writer: stderr would carry the failure note otherwise.
		assert.equal(run.stderr, "", "the helper writes the line itself under bare node");
		const path = join(dir, "state", "routing", "decisions.jsonl");
		assert.ok(existsSync(path), "the decision line lands under --agent-dir");
		const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as RouteDecision);
		assert.equal(lines.length, 1, "one start, one line");
		const [entry] = lines;
		assert.equal(entry.chosen, resolved);
		assert.equal(entry.lane, "pi-um10b");
		assert.equal(entry.by, "rule");
		assert.ok(entry.candidates.length > 0, "the alternatives are recorded beside the choice");
		// The one reader reads back what the helper wrote.
		const readBack = muster({ ...env, PI_ROUTING_DECISIONS_PATH: path }, "", ["route", "explain", "pi-um10b"]);
		assert.equal(readBack.status, 0, readBack.output);
		assert.ok(readBack.stdout.includes(`lane pi-um10b -> ${resolved} (rule`), readBack.stdout);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a lane's line is recorded through the CLI and read back by `muster route explain`", () => {
	const dir = mkdtempSync(join(tmpdir(), "lane-model-log-"));
	try {
		const path = join(dir, "decisions.jsonl");
		const env = { ...process.env, PI_ROUTING_DECISIONS_PATH: path };
		const entry = { at: Date.now(), lane: "pi-um10", role: "worker", chosen: "alpha/a", by: "rule", candidates: [{ ref: "alpha/a", verdict: "chosen", reason: "usable" }] };
		const recorded = muster(env, JSON.stringify(entry), ["route", "record"]);
		assert.equal(recorded.status, 0, recorded.output);
		assert.ok(existsSync(path), "the record action appends the line");
		const explain = muster(env, "", ["route", "explain", "pi-um10"]);
		assert.equal(explain.status, 0, explain.output);
		assert.match(explain.stdout, /lane pi-um10 -> alpha\/a \(rule/);
		assert.match(explain.stdout, /alpha\/a: chosen \(usable\)/);
		const listed = muster(env, "", ["route", "log"]);
		assert.equal(listed.status, 0, listed.output);
		assert.match(listed.stdout, /1 of 1 decision/);
		// A decision without the minimum is refused rather than written.
		const bad = muster(env, JSON.stringify({ at: Date.now(), chosen: "", by: "rule", candidates: [] }), ["route", "record"]);
		assert.equal(bad.status, 2, bad.output);
		assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 1, "nothing else was written");
		const noLane = muster(env, "", ["route", "explain", "lane-nobody"]);
		assert.equal(noLane.status, 3, noLane.output);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

function muster(env: NodeJS.ProcessEnv, input: string, args: string[]): { status: number; stdout: string; stderr: string; output: string } {
	try {
		const stdout = execFileSync(process.execPath, ["--import", `file://${TSX_LOADER}`, MUSTER_CLI, ...args], { encoding: "utf8", input, env, stdio: ["pipe", "pipe", "pipe"] });
		return { status: 0, stdout, stderr: "", output: stdout };
	} catch (error) {
		const failure = error as { status?: number; stdout?: string; stderr?: string };
		return { status: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
	}
}
