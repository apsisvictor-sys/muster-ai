import "./muster-test-isolation.ts";
/**
 * The generated the operator list — model-free regressions for AK3 (the renderer, the
 * temp-file-and-rename write, and the CLI and gateway writers regenerating it).
 *
 * OS temp directories only: the list's own path is a parameter
 * (`MUSTER_OPERATOR_LIST_PATH`, or the `path` option), so nothing here writes
 * `plans/orchestration-2026-10-05/handoffs/operator-only-list.md`.
 *
 * Authored here; executed by the parent through the guarded runner.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	answerAsk,
	finishAsk,
	noteAsk,
	prepareAsk,
	raiseAsk,
	readAsks,
	regenerateOperatorList,
	renderOperatorList,
	operatorListPath,
	withdrawAsk,
} from "../asks.ts";
import { command as askCommand } from "../cli/ask.ts";
import { command as asksCommand } from "../cli/asks.ts";
import type { CliContext } from "../cli/types.ts";
import { createGatewayTools } from "../gateway/tools.ts";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const GOLDEN = resolve(TESTS_DIR, "fixtures", "muster-asks-list.golden.md");
/** A fixed clock: the golden file carries an age line and nothing time-dependent beyond it. */
const NOW = Date.parse("2026-10-16T20:00:00.000Z");

type Dirs = { root: string; state: string; list: string };

function withTempState(run: (dirs: Dirs) => void | Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "muster-asks-list-"));
	const state = join(root, "state", "muster");
	const list = join(root, "generated", "operator-only-list.md");
	mkdirSync(join(root, "programmes"), { recursive: true });
	const saved = {
		state: process.env.PI_MUSTER_STATE_DIR,
		decisions: process.env.PI_MUSTER_DECISIONS_DIR,
		list: process.env.MUSTER_OPERATOR_LIST_PATH,
	};
	process.env.PI_MUSTER_STATE_DIR = state;
	process.env.PI_MUSTER_DECISIONS_DIR = join(root, "programmes");
	process.env.MUSTER_OPERATOR_LIST_PATH = list;
	return Promise.resolve()
		.then(() => run({ root, state, list }))
		.finally(() => {
			for (const [key, value] of [
				["PI_MUSTER_STATE_DIR", saved.state],
				["PI_MUSTER_DECISIONS_DIR", saved.decisions],
				["MUSTER_OPERATOR_LIST_PATH", saved.list],
			] as const) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(root, { recursive: true, force: true });
		});
}

/** the operator's own shell: the store's own directories and the list's own path. */
function shellEnv(list: string): NodeJS.ProcessEnv {
	return {
		PI_MUSTER_STATE_DIR: process.env.PI_MUSTER_STATE_DIR,
		PI_MUSTER_DECISIONS_DIR: process.env.PI_MUSTER_DECISIONS_DIR,
		MUSTER_OPERATOR_LIST_PATH: list,
	};
}

function cli(argv: string[], list: string): { ctx: CliContext; out: string[]; err: string[] } {
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
			env: shellEnv(list),
			io: { out: (line) => out.push(line), err: (line) => err.push(line) },
			readStdin: async () => "",
		},
	};
}

/**
 * The fixture queue: three asks waiting on the operator (one blocking a lane, one kind
 * only he may answer, one prepared with options) and three settled (done with
 * commit evidence, ruled, withdrawn).
 */
function fixtureQueue(state: string): void {
	raiseAsk(state, {
		by: "orchestrator",
		kind: "operator-action",
		question: "The portali.net import URL.",
		code: "VH10",
		owner: "operator",
		source: "operator-only-list.md:21",
		blocks: ["be-lane-w5"],
		at: "2026-10-15T09:00:00.000Z",
	});
	raiseAsk(state, {
		by: "architect",
		kind: "credential",
		question: "The Market Radar photo store credential.",
		code: "DQ20",
		source: "design-inbox.md:44",
		at: "2026-10-16T18:00:00.000Z",
	});
	raiseAsk(state, {
		by: "architect",
		kind: "product-decision",
		question: "Harness review proposals 2026-10-14 A1-A5.",
		code: "VD3",
		link: "plans/orchestration-2026-10-05/harness-review-2026-10-14.md",
		at: "2026-10-12T09:00:00.000Z",
	});
	prepareAsk(state, {
		ref: "VD3",
		by: "architect",
		options: ["approve all", "reject by code"],
		recommendation: "approved unless you reject one by its code",
		at: "2026-10-12T09:05:00.000Z",
	});
	noteAsk(state, { ref: "VD3", by: "architect", text: "the batch is one page", at: "2026-10-12T09:06:00.000Z" });

	raiseAsk(state, {
		by: "orchestrator",
		kind: "product-decision",
		question: "Add the queue to the ledger at cutover?",
		code: "VD8",
		at: "2026-10-16T08:00:00.000Z",
	});
	answerAsk(state, {
		ref: "VD8",
		by: "architect",
		ruling: "yes, the ledger carries it at cutover",
		row: "plans/muster-autonomy/durable-ledger-design-2026-10-13.md:76",
		at: "2026-10-16T18:30:00.000Z",
	});
	raiseAsk(state, {
		by: "orchestrator",
		kind: "product-decision",
		question: "Commit the skill changes left uncommitted since 2026-10-09.",
		code: "VD4",
		at: "2026-10-14T08:00:00.000Z",
	});
	answerAsk(state, {
		ref: "VD4",
		by: "operator-shell",
		ruling: "commit",
		at: "2026-10-15T12:20:00.000Z",
	});
	finishAsk(state, {
		ref: "VD4",
		by: "orchestrator",
		evidence: { commit: "2435625", repo: "pi" },
		at: "2026-10-15T12:21:00.000Z",
	});
	raiseAsk(state, {
		by: "architect",
		kind: "review",
		question: "Ship the pilot now?",
		code: "H1",
		at: "2026-10-13T08:00:00.000Z",
	});
	withdrawAsk(state, {
		ref: "H1",
		by: "architect",
		reason: "the pilot moved to sprint 2",
		at: "2026-10-15T13:00:00.000Z",
	});
}

test("the fixture queue renders to the golden file", async () => {
	await withTempState(({ state }) => {
		fixtureQueue(state);
		const rendered = renderOperatorList(readAsks(state), NOW);
		assert.equal(rendered, readFileSync(GOLDEN, "utf8"));
	});
});

test("regenerate writes the list through a temp file and a rename, mode 0644", async () => {
	await withTempState(({ state, list }) => {
		fixtureQueue(state);
		// A line a person added by hand: the next event regenerates the file whole.
		mkdirSync(dirname(list), { recursive: true });
		writeFileSync(list, "hand-added line\n");
		const result = regenerateOperatorList(state, { env: shellEnv(list), now: NOW });
		assert.deepEqual(result, { written: list });
		assert.equal(readFileSync(list, "utf8"), renderOperatorList(readAsks(state), NOW));
		assert.equal(readFileSync(list, "utf8").includes("hand-added"), false, "the generated file is the queue's, not a hand edit's");
		assert.deepEqual(readdirSync(dirname(list)), ["operator-only-list.md"], "the temp file is renamed, never left behind");
		assert.equal(statSync(list).mode & 0o777, 0o644);
	});
});

test("the list's path is an override: MUSTER_OPERATOR_LIST_PATH, else this install's handoffs copy", () => {
	const saved = process.env.MUSTER_OPERATOR_LIST_PATH;
	assert.equal(operatorListPath({ MUSTER_OPERATOR_LIST_PATH: "/tmp/x.md" }), "/tmp/x.md");
	assert.equal(operatorListPath({}), saved, "a partial env still gets the process's own override");
	delete process.env.MUSTER_OPERATOR_LIST_PATH;
	try {
		assert.match(operatorListPath({}), /plans\/orchestration-2026-10-05\/handoffs\/operator-only-list\.md$/);
	} finally {
		if (saved !== undefined) process.env.MUSTER_OPERATOR_LIST_PATH = saved;
	}
});

test("a failed write is reported, never thrown", async () => {
	await withTempState(({ state, list }) => {
		fixtureQueue(state);
		// A directory in the list's place: the rename cannot land, and the event stands.
		mkdirSync(list, { recursive: true });
		const result = regenerateOperatorList(state, { env: shellEnv(list), now: NOW });
		assert.ok("error" in result && result.error.startsWith(`${list}:`), `expected a reported error, got ${JSON.stringify(result)}`);
		assert.equal(readAsks(state).asks.length, 6);
	});
});

test("muster ask writes the ask first and regenerates the list it cites", async () => {
	await withTempState(async ({ state, list }) => {
		const first = cli(["ask", "--kind", "review", "--question", "From the CLI", "--code", "AK3C"], list);
		assert.equal(await askCommand.run(first.ctx), 0, first.err.join("\n"));
		const rendered = readFileSync(list, "utf8");
		assert.equal(rendered.split("\n")[0], "Generated from Muster's ask queue; change it with `muster ask` or `muster asks`");
		assert.match(rendered, /\| AK3C \| From the CLI \|/);
		assert.deepEqual(readdirSync(dirname(list)), ["operator-only-list.md"]);
		assert.equal(readAsks(state).asks.length, 1);

		// A ruling regenerates it again: the row moves to Settled, struck through.
		const second = cli(["answer", "AK3C", "--ruling", "approve"], list);
		assert.equal(await asksCommand.run(second.ctx), 0, second.err.join("\n"));
		const after = readFileSync(list, "utf8");
		assert.equal(after.includes("| AK3C |"), false, "a settled ask is no longer a waiting row");
		assert.match(after, /\| ~~AK3C~~ \| ~~From the CLI~~ \| Ruled \d{4}-/);
	});
});

test("the gateway's asks_add regenerates the same list", async () => {
	await withTempState(async ({ root, list }) => {
		const tools = createGatewayTools({
			stateDir: join(root, "muster"),
			lanes: () => [],
			notesRoot: join(root, "notes"),
			agentId: "grokbot",
			sendToOrchestrator: async () => "delivered",
		});
		const asksAdd = tools.find((tool) => tool.name === "asks_add");
		assert.ok(asksAdd !== undefined);
		await asksAdd.run({ kind: "product-decision", question: "From the gateway", code: "AK3G" });
		assert.match(readFileSync(list, "utf8"), /\| AK3G \| From the gateway \|/);
	});
});
