import "./muster-test-isolation.ts";
/**
 * `muster steer` — the steer layer's one writer door (S-steer, blueprint sections 3 and 7; review finding 4).
 *
 * The verb's contract, case by case:
 *  - the author is the identity the session proves: `operator` writes, and a lane that claims `--agent operator`
 *    acts as the lane and is refused, with no line written;
 *  - `add`, `cap`, `list` and `retire` print the journal's own record, and `retire` is a second line;
 *  - `list --live` shows only what a placement would apply, and a manual steer past its review is live with
 *    the review marked due;
 *  - a refusal (an expiry further than seven days out, a cap field that is not capacity, an unknown id) exits
 *    3 and leaves the journal as it was; a bad invocation exits 2;
 *  - `explain` prints the pool file as a placement would read it, and the pool file itself is never written.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { command } from "../cli/steer.ts";
import type { CliContext } from "../cli/types.ts";
import { readSteerJournal } from "../../routing/steers.ts";
import { TASK_KINDS, type TaskKind } from "../../routing/provider-pool.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const XAI = "xai/grok-4.6";
const ZAI = "zai/glm-5.3-flash";
const FREE_REF = "opencode/free-one";

const HARD_KINDS: readonly TaskKind[] = ["retry", "unknown-cause-bug", "shared-owner", "security-data", "perf"];

function poolFile(): Record<string, unknown> {
	const policy = Object.fromEntries(TASK_KINDS.map((kind) => [kind, HARD_KINDS.includes(kind) ? [ZAI, XAI] : [XAI, ZAI]]));
	return {
		version: 1,
		virtualProvider: "pool",
		cooldownMs: HOUR,
		resetHorizonMs: 3_024_000_000,
		freeRefs: [FREE_REF],
		employerAccounts: [],
		laneDefaults: { pi: { candidates: [XAI, ZAI], fallbackRole: "session", hard: [ZAI, XAI] }, opencode: [FREE_REF], claude: "sonnet" },
		nonChatRoles: ["classifier"],
		providerWalls: {},
		roles: { session: [XAI, ZAI, FREE_REF], review: [ZAI, XAI], classifier: [ZAI] },
		routing: { pick: "on", slots: 7, claudeMax: 2, hardMax: 2, paused: [], policy, kindRules: {} },
		quotaShapes: [{ id: "wall", match: "QUOTA_WALL" }],
	};
}

const ENV_KEYS = ["PI_STEERS_PATH", "PI_PROVIDER_POOL_PATH", "PI_PROVIDER_WALLS_PATH", "PI_USAGE_SNAPSHOT_PATH"] as const;

interface Fixture {
	root: string;
	journal: string;
	pool: string;
}

async function withFixture(run: (fixture: Fixture) => Promise<void> | void): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "muster-steer-"));
	const journal = join(root, "state", "steers.jsonl");
	const pool = join(root, "provider-pool.json");
	writeFileSync(pool, `${JSON.stringify(poolFile(), null, "\t")}\n`);
	const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	process.env["PI_STEERS_PATH"] = journal;
	process.env["PI_PROVIDER_POOL_PATH"] = pool;
	process.env["PI_PROVIDER_WALLS_PATH"] = join(root, "no-walls.json");
	process.env["PI_USAGE_SNAPSHOT_PATH"] = join(root, "no-snapshot.json");
	try {
		await run({ root, journal, pool });
	} finally {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key] as string;
		}
		rmSync(root, { recursive: true, force: true });
	}
}

/** One `muster steer` invocation. `identity` is what the frame plus the seat owner proved for the session. */
function cli(argv: string[], identity: { session: string; claim?: string } = { session: "operator" }): { ctx: CliContext; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	return {
		out,
		err,
		ctx: {
			argv,
			repoRoot: "/tmp/no-repo",
			agentId: identity.claim,
			sessionAgentId: identity.session,
			json: argv.includes("--json"),
			cwd: "/tmp/no-repo",
			env: {},
			io: { out: (line) => out.push(line), err: (line) => err.push(line) },
			readStdin: async () => "",
		},
	};
}

const until = (ms: number): string => new Date(Date.now() + ms).toISOString();

test("operator writes a steer and the journal holds the line the verb printed", async () => {
	await withFixture(async ({ journal }) => {
		const { ctx, out, err } = cli(["add", "--action", "exclude", "--ref", XAI, "--role", "ui", "--project", "muster", "--reason", "the flagship is out today", "--at", until(6 * HOUR)]);
		assert.equal(await command.run(ctx), 0, err.join("\n"));
		assert.match(out.join("\n"), /^st-[\w-]+ exclude until/, out.join("\n"));
		const read = readSteerJournal(journal);
		assert.equal(read.entries.length, 1);
		assert.equal(read.entries[0]?.record.author, "operator", "the author is the identity the channel proved");
		assert.equal(read.entries[0]?.record.reason, "the flagship is out today");
		assert.deepEqual(read.entries[0]?.record.scope, { ref: XAI, role: "ui", project: "muster" });

		const listed = cli(["list", "--live"]);
		assert.equal(await command.run(listed.ctx), 0, listed.err.join("\n"));
		assert.match(listed.out.join("\n"), /live until .*xai\/grok-4\.6/);
	});
});

test("a lane cannot write as operator: the claim is dropped and the write is refused", async () => {
	await withFixture(async ({ journal }) => {
		const { ctx, err } = cli(["add", "--action", "exclude", "--ref", XAI, "--reason", "not mine to say", "--at", until(6 * HOUR)], { session: "pi-lane-abc", claim: "operator" });
		assert.equal(await command.run(ctx), 3);
		assert.match(err.join("\n"), /accepted from operator, henry, orchestrator only; this session is pi-lane-abc/);
		assert.equal(readSteerJournal(journal).entries.length, 0, "a refused author leaves no line");
	});
});

test("a cap is capacity with a clock; a field that is not capacity is refused", async () => {
	await withFixture(async ({ journal }) => {
		const cap = cli(["cap", "--field", "claudeMax", "--value", "0", "--until", until(6 * HOUR), "--reason", "no Claude lane today", "--project", "muster"]);
		assert.equal(await command.run(cap.ctx), 0, cap.err.join("\n"));
		assert.equal(readSteerJournal(journal).entries[0]?.record.kind, "cap");

		for (const field of ["pick", "paused", "policy"]) {
			const refused = cli(["cap", "--field", field, "--value", "0", "--until", until(6 * HOUR), "--reason", "x"]);
			assert.equal(await command.run(refused.ctx), 2, `${field} is not a capacity field`);
		}
		const noClock = cli(["cap", "--field", "slots", "--value", "3", "--reason", "x"]);
		assert.equal(await command.run(noClock.ctx), 2, "a capacity override carries a clock");
		assert.equal(readSteerJournal(journal).entries.length, 1, "no refusal wrote a line");
	});
});

test("refusals exit 3 and change nothing", async () => {
	await withFixture(async ({ journal }) => {
		const tooFar = cli(["add", "--action", "exclude", "--ref", XAI, "--reason", "x", "--at", new Date(Date.now() + 8 * DAY).toISOString()]);
		assert.equal(await command.run(tooFar.ctx), 3);
		assert.match(tooFar.err.join("\n"), /further than seven days/);

		const noReason = cli(["add", "--action", "exclude", "--ref", XAI, "--at", until(6 * HOUR)]);
		assert.equal(await command.run(noReason.ctx), 2, "a missing --reason is a bad invocation");

		const unknown = cli(["retire", "st-nothing"]);
		assert.equal(await command.run(unknown.ctx), 3);
		assert.match(unknown.err.join("\n"), /no steer st-nothing/);
		assert.equal(readSteerJournal(journal).entries.length, 0);
	});
});

test("retire is a second line, and the second retirement is refused", async () => {
	await withFixture(async ({ journal }) => {
		const added = cli(["add", "--action", "demote", "--ref", ZAI, "--reason", "sits behind", "--review-at", until(DAY), "--json"]);
		assert.equal(await command.run(added.ctx), 0, added.err.join("\n"));
		const record = JSON.parse(added.out.join("")) as { id: string };
		assert.equal(readFileSync(journal, "utf8").trim().split("\n").length, 1);

		const retired = cli(["retire", record.id]);
		assert.equal(await command.run(retired.ctx), 0, retired.err.join("\n"));
		assert.match(retired.out.join("\n"), new RegExp(`${record.id} retired at .* by operator`));
		assert.equal(readFileSync(journal, "utf8").trim().split("\n").length, 2, "a retirement appends, it never edits");
		assert.equal(readSteerJournal(journal).entries[0]?.retiredBy, "operator");

		const again = cli(["retire", record.id]);
		assert.equal(await command.run(again.ctx), 3);
		assert.match(again.err.join("\n"), /already retired/);
	});
});

test("a manual steer stays live past its review, and list says the review is due", async () => {
	await withFixture(async () => {
		const added = cli(["add", "--action", "exclude", "--ref", XAI, "--reason", "his word, to be reviewed", "--review-at", new Date(Date.now() - HOUR).toISOString()]);
		assert.equal(await command.run(added.ctx), 0, added.err.join("\n"));
		const listed = cli(["list", "--live", "--json"]);
		assert.equal(await command.run(listed.ctx), 0, listed.err.join("\n"));
		const view = JSON.parse(listed.out.join("")) as Array<{ live: boolean; reviewDue: boolean; record: { action: string } }>;
		assert.equal(view.length, 1);
		assert.equal(view[0]?.live, true, "a review that came due lifts nothing by itself");
		assert.equal(view[0]?.reviewDue, true);
	});
});

test("explain prints the composed file, and no verb writes the pool file", async () => {
	await withFixture(async ({ pool }) => {
		const before = statSync(pool).mtimeMs;
		const content = readFileSync(pool, "utf8");
		const added = cli(["add", "--action", "exclude", "--ref", XAI, "--role", "session", "--reason", "out of the chain", "--review-at", until(DAY)]);
		assert.equal(await command.run(added.ctx), 0, added.err.join("\n"));

		const explained = cli(["explain", "--role", "session"]);
		assert.equal(await command.run(explained.ctx), 0, explained.err.join("\n"));
		const text = explained.out.join("\n");
		assert.match(text, /role session: zai\/glm-5\.3-flash, opencode\/free-one\s+\(was xai\/grok-4\.6, zai\/glm-5\.3-flash, opencode\/free-one\)/, text);
		assert.match(text, /capacity: claudeMax 2, hardMax 2, slots 7/);

		const machine = cli(["explain", "--role", "session", "--json"]);
		assert.equal(await command.run(machine.ctx), 0);
		const parsed = JSON.parse(machine.out.join("")) as { chains: Array<{ name: string; before: string[]; after: string[] }>; live: string[] };
		assert.deepEqual(parsed.chains.find((chain) => chain.name === "role session")?.after, [ZAI, FREE_REF]);
		assert.equal(parsed.live.length, 1);

		const listed = cli(["list"]);
		assert.equal(await command.run(listed.ctx), 0);
		const retired = cli(["retire", parsed.live[0] as string]);
		assert.equal(await command.run(retired.ctx), 0);

		assert.equal(statSync(pool).mtimeMs, before, "the tracked file's mtime is unchanged after every verb");
		assert.equal(readFileSync(pool, "utf8"), content);
	});
});

test("a missing or unknown action is exit 2 with the usage", async () => {
	await withFixture(async () => {
		const none = cli([]);
		assert.equal(await command.run(none.ctx), 2);
		assert.match(none.err.join("\n"), /an action is needed/);
		const unknown = cli(["pause", "--ref", XAI]);
		assert.equal(await command.run(unknown.ctx), 2);
		assert.match(unknown.err.join("\n"), /unknown action "pause"/);
	});
});
