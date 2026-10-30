/**
 * AR15: the two placement doors ask Jev inside the candidate set code built, in shadow first.
 *
 * AR13 built the step (`packages/routing/jev-choice.ts`: the methodology's prompt, the closed answer list over the
 * candidate refs, the fallback to the deterministic top) and left the two doors to call it. This file is that, at
 * the two doors: the Pi launcher's helper (`muster/lane-model.mjs`, plain node) and `muster route pick`
 * (`muster/cli/route.ts`), each run here as the program it is in production.
 *
 * What the whole-path cases prove:
 * - a lane that names no model is placed by the rule, and Jev's answer is recorded beside that placement on a line
 *   of its own (`shadow: true`), so a reader compares the two instead of assuming Jev's answer was applied;
 * - the launch stays on the rule's pick: the shadow phase changes what is recorded, not what runs;
 * - a lane that names a model is untouched: the operator's choice is the placement and nothing is asked;
 * - the mode file decides: `off` asks nobody and writes no shadow line;
 * - a Jev failure leaves the rule's pick standing and says why on the line.
 *
 * No live model and no spend: the pool these cases read names a classifier no model registry has, so the call fails
 * where it is made instead of reaching one, and the router's month is a file of its own, so the test's records never
 * reach the live telemetry database.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readRouteDecisions, type RouteDecision } from "../provider-pool.ts";
import { childImportArgs, enclosingProfile, harnessRoot, tsxLoaderPath } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
/**
 * The profile this checkout stands in, when it stands in one. The launcher's Jev child wires the ports of the
 * `agentDir` it reads, so a run from this checkout names its own profile: otherwise the child imports the
 * installed profile's start file, which is not the code under test (RS3FIXB). A standalone clone has none, and
 * then the child gets the `agentDir` the run configured, as before.
 */
const PROFILE = enclosingProfile(import.meta.url);
const CLI = join(HARNESS_ROOT, "muster", "lane-model.mjs");
const MUSTER_CLI = join(piAgentDir(), "scripts", "muster.mts");
const TSX_LOADER = tsxLoaderPath();

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// The fixture's own refs. They name providers Pi has no key for, so the launcher reads them as present by the name
// rule (VR24-213) without any credential, and the classifier names a provider no model registry has, so the Jev call
// fails where it is made instead of reaching one.
const A = "a/paid";
const B = "b/paid";
const HARD = "c/hard";
const JEV = "jev/classifier";

const FLASH_KINDS = ["ui", "copy", "test", "adapter", "config", "docs", "research-read"];
const HARD_KINDS = ["retry", "unknown-cause-bug", "shared-owner", "security-data", "perf"];

/** The pool file both doors read: a routing section, the router's own ceiling, and a classifier nobody has. */
function poolFile(): Record<string, unknown> {
	const flash = [A, B];
	const policy: Record<string, string[]> = {};
	for (const kind of FLASH_KINDS) policy[kind] = [...flash];
	for (const kind of HARD_KINDS) policy[kind] = [HARD];
	policy["review"] = [HARD];
	policy["product-pass"] = [HARD];
	return {
		version: 1,
		virtualProvider: "pool",
		cooldownMs: HOUR,
		resetHorizonMs: 40 * DAY,
		freeRefs: [],
		ceilings: { classifier: { usdPerMonth: 2 }, routing: { usdPerMonth: 1 } },
		roles: { worker: [A, B], classifier: [JEV] },
		nonChatRoles: ["classifier"],
		laneDefaults: { pi: { candidates: [A, B], fallbackRole: "worker", hard: [HARD] }, opencode: [B], claude: "sonnet" },
		quotaShapes: [{ id: "wall", match: "QUOTA_WALL" }],
		routing: { pick: "on", slots: 7, claudeMax: 0, hardMax: 2, paused: [], policy, kindRules: {} },
	};
}

interface Lab {
	dir: string;
	env: NodeJS.ProcessEnv;
	decisions: string;
}

/** A lab: a temp agent dir with the fixture pool, an empty state, and the router's month in a file of its own. */
function lab(mode: string): Lab {
	const dir = mkdtempSync(join(tmpdir(), "ar15-door-"));
	const state = join(dir, "state");
	mkdirSync(join(state, "routing"), { recursive: true });
	mkdirSync(join(state, "muster"), { recursive: true });
	const poolPath = join(dir, "provider-pool.json");
	writeFileSync(poolPath, JSON.stringify(poolFile()));
	const decisions = join(state, "routing", "decisions.jsonl");
	if (mode !== "") writeFileSync(join(state, "routing", "jev-mode"), `${mode}\n`);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...(PROFILE === undefined ? {} : { PI_AGENT_DIR: PROFILE }),
		PI_PROVIDER_POOL_PATH: poolPath,
		PI_ROUTING_DECISIONS_PATH: decisions,
		PI_MUSTER_STATE_DIR: join(state, "muster"),
		PI_SUBSCRIPTIONS_PATH: join(dir, "no-inventory.json"),
		// The router's month is a file of its own, so the test's records never reach the live telemetry database.
		PI_TELEMETRY_DB_PATH: join(dir, "telemetry.db"),
	};
	return { dir, env, decisions };
}

/** The launcher's door: plain node, the program the shell launcher runs. */
function launcher(l: Lab, extra: string[] = []): { stdout: string; stderr: string } {
	try {
		const stdout = execFileSync("node", [CLI, "--harness", "pi", "--agent-dir", l.dir, "--lane", "ar15", "--task-kind", "ui", "--json", ...extra], {
			encoding: "utf8",
			env: l.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { stdout, stderr: "" };
	} catch (error) {
		const failure = error as { stdout?: string; stderr?: string };
		return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
	}
}

/** The route door: the muster CLI, as the orchestrator calls it. */
function routePick(l: Lab, extra: string[] = []): { stdout: string; stderr: string } {
	try {
		const stdout = execFileSync(process.execPath, [...childImportArgs(), MUSTER_CLI, "route", "pick", "--lane", "ar15", "--task-kind", "ui", "--json", ...extra], {
			encoding: "utf8",
			env: l.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { stdout, stderr: "" };
	} catch (error) {
		const failure = error as { stdout?: string; stderr?: string };
		return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
	}
}

/** The two lines the log holds: the placement and, beside it, the shadow answer. */
function lines(l: Lab): { placement?: RouteDecision; shadow?: RouteDecision } {
	const read = readRouteDecisions(l.decisions);
	return {
		placement: read.find((line) => line.shadow !== true),
		shadow: read.find((line) => line.shadow === true),
	};
}

test("the launcher asks Jev for a model-less lane, and the rule's pick still launches", () => {
	const l = lab("shadow");
	const run = launcher(l);
	assert.equal(run.stderr.includes("usage:"), false, run.stderr);
	const payload = JSON.parse(run.stdout) as { model: string; jev?: { accepted: boolean; fallback?: string; reason?: string } };
	const { placement, shadow } = lines(l);

	assert.ok(payload.model !== "", "the lane still resolves a model");
	assert.ok(placement !== undefined, "the placement is on the log");
	assert.equal(payload.model, placement.chosen, "the launch is the rule's pick, whatever Jev answered");
	assert.ok(shadow !== undefined, "Jev's answer is on a line of its own");
	assert.equal(shadow.chosen, placement.chosen, "and the shadow line places the rule's pick too");
	assert.equal(shadow.jev?.accepted, false, "the fixture's classifier names a provider no registry has");
	assert.equal(shadow.jev?.fallback, "failed");
	assert.match(shadow.jev?.reason ?? "", /not available/, "the line says why the answer is missing");
});

test("the route door records the same shadow answer beside its placement", () => {
	const l = lab("shadow");
	const run = routePick(l);
	const payload = JSON.parse(run.stdout) as { status: string; ref: string; jev?: { accepted: boolean; fallback?: string } };
	const { placement, shadow } = lines(l);

	assert.equal(payload.status, "placed", run.stderr);
	assert.ok(placement !== undefined, "the placement is on the log");
	assert.equal(payload.ref, placement.chosen, "the door placed what the rule placed");
	assert.ok(shadow !== undefined, "Jev's answer is on a line of its own");
	assert.equal(shadow.chosen, placement.chosen);
	assert.equal(shadow.jev?.accepted, false);
	assert.equal(payload.jev?.accepted, false, "and the door says so to the caller");
});

test("the mode off asks nobody and writes no shadow line", () => {
	const l = lab("off");
	const run = launcher(l);
	const payload = JSON.parse(run.stdout) as { model: string; jev?: unknown };
	const { placement, shadow } = lines(l);

	assert.ok(payload.model !== "", "the lane still resolves a model");
	assert.equal(payload.jev, undefined, "nobody was asked");
	assert.ok(placement !== undefined, "the placement is still on the log");
	assert.equal(shadow, undefined, "and no shadow line was written");
});

test("a lane that names a model is unchanged: nothing is asked and nothing is written beside it", () => {
	const l = lab("shadow");
	const run = routePick(l, ["--model", B, "--override", "because"]);
	const payload = JSON.parse(run.stdout) as { status: string; ref: string; jev?: unknown };
	const { placement, shadow } = lines(l);

	assert.equal(payload.status, "placed", run.stderr);
	assert.equal(payload.ref, B, "the operator's choice is the placement");
	assert.equal(payload.jev, undefined, "nobody was asked about it");
	assert.equal(shadow, undefined, "and no shadow line was written");
	assert.equal(placement?.by, "orchestrator", "the line is the hand placement it always was");
});
