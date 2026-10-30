import "./muster-test-isolation.ts";
/**
 * Tests for `muster pool admit` (UM11 of
 * `plans/provider-accounts/usage-monitor-blueprint-2026-10-16.md`, P5-D2).
 *
 * The verb's contract:
 *  - with the authorization ask for this ref answered yes and a `pass` probe
 *    signal from the last 24 hours, the ref joins `freeRefs` and the end of
 *    every chat chain, and one routing-log line names the ask;
 *  - `laneDefaults` and the non-chat roles are never touched, and the loader
 *    still accepts the file;
 *  - no ask, an unanswered ask, a refused ask and no passing probe each admit
 *    nothing.
 *
 * The pure shape function (`withAdmittedFreeRef`) is exercised here too, because
 * the file's own rules (free refs in a chat role, a free ref may share its
 * provider) are what it has to keep true.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPoolConfig, parsePoolConfig, readRouteDecisions, type RouteDecision } from "../../routing/provider-pool.ts";
import { answerAsk, raiseAsk, readAsks, type Ask } from "../asks.ts";
import { command as poolCommand, rulingIsYes } from "../cli/pool.ts";
import type { CliContext } from "../cli/types.ts";
import { raiseSignal } from "../signals.ts";

const REF = "opencode-go/glm-5.3-flash-free";
const PROVIDER = "opencode-go";
const MODEL = "glm-5.3-flash-free";

type Fixture = { root: string; state: string; pool: string; routing: string };

/** A pool file with one free ref, one chat role and the classifier. */
function poolFile(): Record<string, unknown> {
	return {
		version: 1,
		_note: "test fixture",
		virtualProvider: "pool",
		cooldownMs: 3_600_000,
		resetHorizonMs: 3_024_000_000,
		freeRefs: ["alpha/paid-free"],
		employerAccounts: [],
		laneDefaults: { pi: { candidates: ["alpha/a", "alpha/paid-free"], fallbackRole: "session" }, opencode: ["alpha/paid-free"], claude: "sonnet" },
		nonChatRoles: ["classifier"],
		ceilings: { classifier: { usdPerMonth: 2 } },
		providerWalls: {},
		roles: { session: ["alpha/a", "alpha/paid-free"], classifier: ["gamma/c"] },
		quotaShapes: [{ id: "wall", match: "QUOTA_WALL" }],
	};
}

const ENV_KEYS = ["PI_MUSTER_STATE_DIR", "PI_PROVIDER_POOL_PATH", "PI_ROUTING_DECISIONS_PATH", "PI_PROVIDER_WALLS_PATH"] as const;

async function withFixture(run: (f: Fixture) => Promise<void> | void, file: Record<string, unknown> = poolFile()): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "muster-pool-admit-"));
	const state = join(root, "state", "muster");
	const pool = join(root, "provider-pool.json");
	const routing = join(root, "routing", "decisions.jsonl");
	writeFileSync(pool, `${JSON.stringify(file, null, "\t")}\n`);
	const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	process.env.PI_MUSTER_STATE_DIR = state;
	process.env.PI_PROVIDER_POOL_PATH = pool;
	process.env.PI_ROUTING_DECISIONS_PATH = routing;
	process.env.PI_PROVIDER_WALLS_PATH = join(root, "provider-walls.json");
	try {
		await run({ root, state, pool, routing });
	} finally {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key] as string;
		}
		rmSync(root, { recursive: true, force: true });
	}
}

function cli(argv: string[]): { ctx: CliContext; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	return {
		out,
		err,
		ctx: {
			argv,
			repoRoot: "/tmp/no-repo",
			agentId: undefined,
			json: false,
			cwd: "/tmp/no-repo",
			env: { PI_ROUTING_DECISIONS_PATH: process.env.PI_ROUTING_DECISIONS_PATH },
			io: { out: (line) => out.push(line), err: (line) => err.push(line) },
			readStdin: async () => "",
		},
	};
}

/** The store's own question for a free launch; no code, because the store's long machine code is refused by the queue. */
function raiseLaunchAsk(state: string, modelId = MODEL, provider = PROVIDER): Ask {
	return raiseAsk(state, {
		by: "grokbot",
		kind: "authorization",
		question: `${modelId} on ${provider} went free (https://example.com/x). Probe: passed. Terms: training no, retention 30 days. Add it to the pool's free models?`,
	});
}

function answer(state: string, ask: Ask, ruling: string): void {
	answerAsk(state, { ref: ask.id, by: "operator-shell", ruling });
}

function probePassed(state: string, modelId = MODEL, provider = PROVIDER, text = "pass 120ms via pi-ai"): void {
	raiseSignal(state, "model-probe", {
		kind: "probe",
		source: "local",
		provider,
		modelId,
		observedAt: new Date().toISOString(),
		confidence: "high",
		text,
	});
}

const readPool = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const rolesOf = (file: Record<string, unknown>): Record<string, string[]> => file["roles"] as Record<string, string[]>;

test("rulingIsYes reads the first word of the operator's ruling", () => {
	for (const yes of ["yes", "Yes", "yes, add it", "Yes, up to the ceiling", "  yes  ", "y"]) {
		assert.equal(rulingIsYes(yes), true, yes);
	}
	for (const no of [undefined, "", "no", "No, not yet", "later", "yesn't"]) {
		assert.equal(rulingIsYes(no), false, String(no));
	}
});

test("a yes ask and a passing probe admit the ref into freeRefs and every chat chain", async () => {
	await withFixture(async ({ state, pool, routing }) => {
		const ask = raiseLaunchAsk(state);
		answer(state, ask, "yes, add it");
		probePassed(state);
		const { ctx, out, err } = cli(["admit", REF, "--ask", ask.id]);

		assert.equal(await poolCommand.run(ctx), 0, err.join("\n"));
		assert.match(out.join("\n"), /admitted .*opencode-go\/glm-5\.3-flash-free/);

		const file = readPool(pool);
		assert.deepEqual(file["freeRefs"], ["alpha/paid-free", REF]);
		const roles = rolesOf(file);
		assert.deepEqual(roles["session"], ["alpha/a", "alpha/paid-free", REF]);
		assert.deepEqual(roles["classifier"], ["gamma/c"], "the non-chat role is never a chain to admit into");
		assert.deepEqual(file["laneDefaults"], poolFile()["laneDefaults"], "laneDefaults is never touched");
		assert.deepEqual(file["ceilings"], { classifier: { usdPerMonth: 2 } }, "an admission never drops the classifier ceiling, the only spending cap");
		assert.equal(parsePoolConfig(file).ok, true);
		assert.equal(loadPoolConfig(pool).ok, true, "the loader still accepts the file");

		const decisions = readRouteDecisions(routing) as RouteDecision[];
		assert.equal(decisions.length, 1);
		assert.equal(decisions[0]!.chosen, REF);
		assert.equal(decisions[0]!.by, "orchestrator");
		assert.match(decisions[0]!.reason ?? "", new RegExp(ask.id));
	});

	await withFixture(
		async ({ state, pool }) => {
			// A ref the chains already carry: the admission is the freeRefs entry, and the
			// chains keep one copy.
			const ask = raiseLaunchAsk(state);
			answer(state, ask, "yes");
			probePassed(state);
			const { ctx, out } = cli(["admit", REF, "--ask", ask.id]);
			assert.equal(await poolCommand.run(ctx), 0);
			const written = readPool(pool);
			assert.equal((written["freeRefs"] as string[]).filter((entry) => entry === REF).length, 1, "freeRefs holds it once");
			assert.equal((rolesOf(written)["session"] as string[]).filter((entry) => entry === REF).length, 1, "the chain holds it once");
			assert.match(out.join("\n"), /already in every chat chain/);
		},
		(() => {
			const file = poolFile();
			(rolesOf(file))["session"] = ["alpha/a", "alpha/paid-free", REF];
			return file;
		})(),
	);
});

test("no ask admits nothing", async () => {
	await withFixture(async ({ state, pool, routing }) => {
		const { ctx, err } = cli(["admit", REF, "--ask", "ask_00000000-0000-0000-0000-000000000000"]);
		assert.equal(await poolCommand.run(ctx), 1);
		assert.match(err.join("\n"), /no live ask matches/);
		assert.deepEqual(readPool(pool)["freeRefs"], ["alpha/paid-free"]);
		assert.equal(readRouteDecisions(routing).length, 0);
	});
});

test("an unanswered ask admits nothing", async () => {
	await withFixture(async ({ state, pool }) => {
		const ask = raiseLaunchAsk(state);
		probePassed(state);
		const { ctx, err } = cli(["admit", REF, "--ask", ask.id]);
		assert.equal(await poolCommand.run(ctx), 1);
		assert.match(err.join("\n"), /is open; a free model joins only on the ask answered yes/);
		assert.deepEqual(readPool(pool)["freeRefs"], ["alpha/paid-free"]);
		assert.equal(readAsks(state).asks[0]!.status, "open");
	});
});

test("a refused ask admits nothing and is not repeated", async () => {
	await withFixture(async ({ state, pool }) => {
		const ask = raiseLaunchAsk(state);
		answer(state, ask, "no");
		probePassed(state);
		const { ctx, err } = cli(["admit", REF, "--ask", ask.id]);
		assert.equal(await poolCommand.run(ctx), 1);
		assert.match(err.join("\n"), /only a new launch signal raises a new ask/);
		assert.deepEqual(readPool(pool)["freeRefs"], ["alpha/paid-free"]);
	});
});

test("no passing probe admits nothing", async () => {
	await withFixture(async ({ state, pool }) => {
		const ask = raiseLaunchAsk(state);
		answer(state, ask, "yes");
		const { ctx, err } = cli(["admit", REF, "--ask", ask.id]);
		assert.equal(await poolCommand.run(ctx), 1, "no probe signal at all");
		assert.match(err.join("\n"), /no pass probe signal/);

		probePassed(state, MODEL, PROVIDER, "fail quota-wall 300ms via pi-ai");
		const second = cli(["admit", REF, "--ask", ask.id]);
		assert.equal(await poolCommand.run(second.ctx), 1, "a failed probe is not a pass");
		assert.deepEqual(readPool(pool)["freeRefs"], ["alpha/paid-free"]);
	});
});

test("an ask that names another model admits nothing", async () => {
	await withFixture(async ({ state, pool }) => {
		const other = raiseLaunchAsk(state, "other-model-free", PROVIDER);
		answer(state, other, "yes");
		probePassed(state);
		const { ctx, err } = cli(["admit", REF, "--ask", other.id]);
		assert.equal(await poolCommand.run(ctx), 1);
		assert.match(err.join("\n"), /does not name opencode-go\/glm-5\.3-flash-free/);
		assert.deepEqual(readPool(pool)["freeRefs"], ["alpha/paid-free"]);
	});
});

test("an already-admitted ref is refused, and the usage errors exit 2", async () => {
	await withFixture(async ({ state }) => {
		const ask = raiseLaunchAsk(state);
		answer(state, ask, "yes");
		probePassed(state);
		const first = cli(["admit", REF, "--ask", ask.id]);
		assert.equal(await poolCommand.run(first.ctx), 0);
		const again = cli(["admit", REF, "--ask", ask.id]);
		assert.equal(await poolCommand.run(again.ctx), 1);
		assert.match(again.err.join("\n"), /already in freeRefs/);

		for (const argv of [["admit", REF], ["admit", "not-a-ref", "--ask", ask.id], ["frobnicate", REF, "--ask", ask.id], ["admit", REF, "--ask", ask.id, "extra"]]) {
			const bad = cli(argv);
			assert.equal(await poolCommand.run(bad.ctx), 2, argv.join(" "));
			assert.ok(bad.err.length > 0);
		}
	});
});
