import "./muster-test-isolation.ts";
/**
 * NLR (Revision 6, D16 and D17): the ask's `rule`, `recommendedOption`, `SITTING_KINDS`, and the
 * order the five callers share (the CLI list, the operator's list, the page's tickets, `asks_read`, the
 * deferred items).
 *
 * OS temp directories only; the CLI verbs run through `command.run` with a fake `CliContext`.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	ASK_RULES,
	AskStateError,
	SITTING_KINDS,
	OPERATOR_ONLY_KINDS,
	orderAsksForOperator,
	prepareAsk,
	raiseAsk,
	readAsks,
	recommendedOption,
	renderOperatorList,
	waitingOnOperator,
	type Ask,
} from "../asks.ts";
import { command as askCommand } from "../cli/ask.ts";
import { command as asksCommand } from "../cli/asks.ts";
import type { CliContext } from "../cli/types.ts";

type Dirs = { root: string; state: string };

function withState(run: (dirs: Dirs) => void | Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "muster-asks-rule-"));
	const state = join(root, "state", "muster");
	mkdirSync(state, { recursive: true });
	const saved = process.env.PI_MUSTER_STATE_DIR;
	process.env.PI_MUSTER_STATE_DIR = state;
	return Promise.resolve()
		.then(() => run({ root, state }))
		.finally(() => {
			if (saved === undefined) delete process.env.PI_MUSTER_STATE_DIR;
			else process.env.PI_MUSTER_STATE_DIR = saved;
			rmSync(root, { recursive: true, force: true });
		});
}

function cli(argv: string[], json = false): { ctx: CliContext; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	return {
		out,
		err,
		ctx: {
			argv,
			repoRoot: "/tmp/no-repo",
			agentId: undefined,
			json,
			cwd: "/tmp/no-repo",
			env: { PI_MUSTER_STATE_DIR: process.env.PI_MUSTER_STATE_DIR },
			io: { out: (line) => out.push(line), err: (line) => err.push(line) },
			readStdin: async () => "",
		},
	};
}

const T = (day: number): string => `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`;

/** The same six asks as every order test: raised oldest first, so a wrong order cannot pass by luck. */
function raiseOrderFixture(state: string): void {
	raiseAsk(state, { by: "operator-shell", kind: "review", question: "plain-old", at: T(1) });
	raiseAsk(state, { by: "operator-shell", kind: "operator-action", question: "only-operator", at: T(2) });
	raiseAsk(state, { by: "operator-shell", kind: "review", question: "one-lane", blocks: ["a"], at: T(3) });
	raiseAsk(state, { by: "operator-shell", kind: "review", question: "three-lanes", blocks: ["a", "b", "c"], at: T(4) });
	raiseAsk(state, { by: "operator-shell", kind: "authorization", question: "one-lane-operator-only", blocks: ["z"], at: T(5) });
	raiseAsk(state, { by: "operator-shell", kind: "review", question: "padded", blocks: ["a", " a ", "", "  ", "a"], at: T(6) });
}

/** blocking three first; one lane each next, a the operator-only kind first; then no blocks, a the operator-only kind first. */
const ORDER = ["three-lanes", "one-lane-operator-only", "one-lane", "padded", "only-operator", "plain-old"];

// ─── 1. `rule` ───────────────────────────────────────────────────────────────

test("NLR 1: muster ask --rule spend stores it, a value outside ASK_RULES is refused, no --rule changes nothing", async () => {
	await withState(async ({ state }) => {
		assert.deepEqual([...ASK_RULES], ["spend", "pay", "sign", "publish", "delete", "outside", "production-data", "device", "ap5", "product"]);

		const withRule = cli(["--kind", "authorization", "--question", "Pay the plan?", "--code", "R1", "--rule", "spend"]);
		assert.equal(await askCommand.run(withRule.ctx), 0, withRule.err.join("\n"));
		const without = cli(["--kind", "review", "--question", "Look at this?", "--code", "R2"]);
		assert.equal(await askCommand.run(without.ctx), 0, without.err.join("\n"));

		const bad = cli(["--kind", "review", "--question", "Whatever?", "--rule", "everything"]);
		assert.equal(await askCommand.run(bad.ctx), 2);
		assert.match(bad.err.join("\n"), /rule must be one of/);
		assert.equal(readAsks(state).asks.length, 2, "a refused rule writes nothing");

		const asks = readAsks(state).asks;
		assert.equal(asks.find((ask) => ask.code === "R1")!.rule, "spend");
		assert.equal(asks.find((ask) => ask.code === "R2")!.rule, undefined);

		const json = cli([], true);
		assert.equal(await asksCommand.run(json.ctx), 0, json.err.join("\n"));
		const printed = (JSON.parse(json.out.join("\n")) as { asks: Ask[] }).asks;
		assert.equal(printed.find((ask) => ask.code === "R1")!.rule, "spend");
		assert.equal("rule" in printed.find((ask) => ask.code === "R2")!, false, "an ask without a rule prints no rule key");

		const shown = cli(["show", "R1"]);
		assert.equal(await asksCommand.run(shown.ctx), 0, shown.err.join("\n"));
		assert.match(shown.out.join("\n"), /^ {2}rule: spend$/m);
		const shownPlain = cli(["show", "R2"]);
		assert.equal(await asksCommand.run(shownPlain.ctx), 0, shownPlain.err.join("\n"));
		assert.doesNotMatch(shownPlain.out.join("\n"), /rule:/);

		assert.throws(
			() => raiseAsk(state, { by: "operator-shell", kind: "review", question: "q", rule: "bogus" as never }),
			(error) => error instanceof AskStateError && error.code === "invalid" && /rule must be one of/.test(error.message),
		);
	});
});

// ─── 3. Order ────────────────────────────────────────────────────────────────

test("NLR 3: more blocked lanes rank first; a repeated or blank entry counts once; ties go to the the operator-only kind, then the older ask; no blocks keeps today's order", async () => {
	await withState(async ({ state }) => {
		raiseOrderFixture(state);
		const ordered = orderAsksForOperator(waitingOnOperator(readAsks(state)));
		assert.deepEqual(ordered.map((ask) => ask.question), ORDER);
		// Today's order for the asks with no blocks: the the operator-only kind, then the rest by age.
		const bare = orderAsksForOperator(waitingOnOperator(readAsks(state)).filter((ask) => ask.blocks.length === 0));
		assert.deepEqual(bare.map((ask) => ask.question), ["only-operator", "plain-old"]);
	});
});

// ─── 4. The five callers return the owner's order ────────────────────────────

test("NLR 4: the CLI list and the operator's list print the owner's order", async () => {
	await withState(async ({ state }) => {
		raiseOrderFixture(state);
		const listed = cli([]);
		assert.equal(await asksCommand.run(listed.ctx), 0, listed.err.join("\n"));
		const lines = listed.out.filter((line) => line.startsWith("  "));
		assert.deepEqual(lines.map((line) => ORDER.find((question) => line.includes(` ${question} `))), ORDER);

		// The list splits the kinds only the operator can do from the decisions; each section keeps the owner's order.
		const rendered = renderOperatorList(readAsks(state), Date.parse("2026-10-20T00:00:00.000Z"));
		const deciding = ORDER.filter((question) => question !== "only-operator");
		const positions = deciding.map((question) => rendered.indexOf(question));
		assert.ok(positions.every((at) => at >= 0) && rendered.includes("only-operator"), "every waiting ask is in the list");
		assert.deepEqual([...positions].sort((a, b) => a - b), positions, "the decisions keep the owner's order");
	});
});

// ─── 5. recommendedOption and SITTING_KINDS ──────────────────────────────────

test("NLR 5: recommendedOption finds the option equal to the recommendation, ignoring case and outer spaces", async () => {
	await withState(async ({ state }) => {
		const raised = raiseAsk(state, { by: "operator-shell", kind: "authorization", question: "Which plan?" });
		assert.equal(recommendedOption(readAsks(state).asks[0]!), undefined, "an unprepared ask has none");
		prepareAsk(state, { ref: raised.id, by: "orchestrator", options: ["Pay the Max plan", "Stay on Pro", "Hold"], recommendation: "  pay the MAX plan " });
		assert.equal(recommendedOption(readAsks(state).asks[0]!), "Pay the Max plan");

		const loose = raiseAsk(state, { by: "operator-shell", kind: "review", question: "Which branch?" });
		prepareAsk(state, { ref: loose.id, by: "orchestrator", options: ["A", "B"], recommendation: "A, because it is smaller" });
		assert.equal(recommendedOption(readAsks(state).asks.find((ask) => ask.id === loose.id)!), undefined, "no match shows every option as a plain button");
	});
});

test("NLR 5: SITTING_KINDS is the three steps only the operator can do, all the operator-only kinds", () => {
	assert.deepEqual([...SITTING_KINDS], ["operator-action", "human-login", "credential"]);
	for (const kind of SITTING_KINDS) assert.ok(OPERATOR_ONLY_KINDS.includes(kind), kind);
});
