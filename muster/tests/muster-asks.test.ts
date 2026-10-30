import "./muster-test-isolation.ts";
/**
 * the operator's queue — model-free regressions for AK1 (the store, the fold, the
 * writer and answer rules, and the CLI verbs).
 *
 * OS temp directories only: no network, no provider, no Concord. The CLI verbs
 * are called through their `command.run` with a fake `CliContext` (the idiom
 * `muster-send-attach.test.ts` uses); the two-process append case spawns two
 * real `node` children against the same file.
 *
 * Authored here; executed by the parent through the guarded runner.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	ASK_KINDS,
	AskStateError,
	answerAsk,
	askCodeOf,
	asksDir,
	asksEventsPath,
	cardLink,
	finishAsk,
	formatAskAge,
	formatAskLine,
	formatEvidence,
	noteAsk,
	orderAsksForOperator,
	parseCardLink,
	parseEvidence,
	prepareAsk,
	programmeCardReader,
	raiseAsk,
	readAsks,
	resolveAskRef,
	resolveAskWriter,
	waitingOnOperator,
	withdrawAsk,
	type AskEvent,
} from "../asks.ts";
import {
	applyDecisionAnswer,
	fileProgrammeDecisionStore,
	openDecision,
	type DecisionAnswerRef,
} from "../decisions.ts";
import { claimSeat, seatContextFor } from "../seats.ts";
import { command as askCommand } from "../cli/ask.ts";
import { command as asksCommand } from "../cli/asks.ts";
import type { CliContext } from "../cli/types.ts";
import { harnessRoot } from "../../core/harness-paths.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);

const PROGRAMME_ID = "agp_0123456789ab";
const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const ASKS_MODULE = resolve(HARNESS_ROOT, "muster", "asks.ts");

type Dirs = { root: string; state: string; decisions: string };

function withTempState(run: (dirs: Dirs) => void | Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "muster-asks-"));
	const state = join(root, "state", "muster");
	const decisions = join(root, "programmes");
	mkdirSync(decisions, { recursive: true });
	const saved = { state: process.env.PI_MUSTER_STATE_DIR, decisions: process.env.PI_MUSTER_DECISIONS_DIR };
	process.env.PI_MUSTER_STATE_DIR = state;
	process.env.PI_MUSTER_DECISIONS_DIR = decisions;
	return Promise.resolve()
		.then(() => run({ root, state, decisions }))
		.finally(() => {
			if (saved.state === undefined) delete process.env.PI_MUSTER_STATE_DIR;
			else process.env.PI_MUSTER_STATE_DIR = saved.state;
			if (saved.decisions === undefined) delete process.env.PI_MUSTER_DECISIONS_DIR;
			else process.env.PI_MUSTER_DECISIONS_DIR = saved.decisions;
			rmSync(root, { recursive: true, force: true });
		});
}

/** the operator's own shell: no agent-session marker, only the store's own directories. */
function shellEnv(): NodeJS.ProcessEnv {
	return {
		PI_MUSTER_STATE_DIR: process.env.PI_MUSTER_STATE_DIR,
		PI_MUSTER_DECISIONS_DIR: process.env.PI_MUSTER_DECISIONS_DIR,
	};
}

function cli(argv: string[], options: { env?: NodeJS.ProcessEnv; json?: boolean } = {}): { ctx: CliContext; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	return {
		out,
		err,
		ctx: {
			argv,
			repoRoot: "/tmp/no-repo",
			agentId: undefined,
			json: options.json ?? false,
			cwd: "/tmp/no-repo",
			env: options.env ?? shellEnv(),
			io: { out: (line) => out.push(line), err: (line) => err.push(line) },
			readStdin: async () => "",
		},
	};
}

function eventLines(state: string): AskEvent[] {
	return readFileSync(asksEventsPath(state), "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as AskEvent);
}

function cardAnswerRef(): DecisionAnswerRef {
	return {
		transport: "discord",
		platformMessageId: "msg-1",
		actorId: "operator",
		channelId: "chan-1",
		threadId: "thread-1",
		receivedAt: "2026-10-16T12:00:00.000Z",
	};
}

function openCard(decisions: string): string {
	return openDecision(
		PROGRAMME_ID,
		{
			kind: "product-decision",
			question: "Ship the pilot?",
			options: [
				{ id: "approve", label: "Approve" },
				{ id: "hold", label: "Hold" },
			],
			recommendation: "approve",
			blockedTaskIds: [],
			scopeRevision: "sprint-1",
		},
		{ store: fileProgrammeDecisionStore(decisions) },
	).decisionId;
}

function isRefused(error: unknown, pattern: RegExp): boolean {
	return error instanceof AskStateError && error.code === "refused" && pattern.test(error.message);
}

test("a round trip of every event type folds back to the last status", async () => {
	await withTempState(({ state }) => {
		const ask = raiseAsk(state, {
			by: "orchestrator",
			kind: "product-decision",
			question: "Pilot now?",
			code: "H1",
			owner: "architect",
			source: "session 8153a7a7",
			link: "plans/muster-autonomy/operator-queue-proposal-2026-10-16.md",
			blocks: ["be-lane-w5", "TASK-12"],
		});
		assert.match(ask.id, /^ask_[0-9a-f-]{36}$/);
		assert.equal(ask.status, "open");
		assert.deepEqual(ask.blocks, ["be-lane-w5", "TASK-12"]);
		assert.equal(askCodeOf(ask), "H1");

		const prepared = prepareAsk(state, { ref: "H1", by: "orchestrator", options: ["yes", "no"], recommendation: "yes" });
		assert.equal(prepared.status, "awaiting-operator");
		assert.deepEqual(prepared.options, ["yes", "no"]);

		const noted = noteAsk(state, { ref: "H1", by: "orchestrator", text: "the plan names it" });
		assert.equal(noted.status, "awaiting-operator", "a note never changes the status");
		assert.deepEqual(noted.notes, ["the plan names it"]);

		const answered = answerAsk(state, { ref: "H1", by: "architect", ruling: "yes", row: "plans/muster-autonomy/decisions.md:112" });
		assert.equal(answered.status, "decided");
		assert.equal(answered.answeredBy, "architect");
		assert.equal(answered.row, "plans/muster-autonomy/decisions.md:112");

		const finished = finishAsk(state, { ref: "H1", by: "orchestrator", evidence: { row: "LD36", file: "plans/muster-autonomy/decisions.md", line: 112 } });
		assert.equal(finished.status, "done");
		assert.deepEqual(finished.evidence, { row: "LD36", file: "plans/muster-autonomy/decisions.md", line: 112 });
		assert.deepEqual(formatEvidence(finished.evidence!), "row:LD36@plans/muster-autonomy/decisions.md:112");

		const queue = readAsks(state);
		assert.equal(queue.path, join(state, "asks", "events.jsonl"));
		assert.equal(queue.partialLastLine, 0);
		assert.equal(queue.unreadableLines, 0);
		assert.equal(queue.asks.length, 1);
		// One line per event, never a rewrite.
		assert.deepEqual(eventLines(state).map((event) => event.type), ["raised", "prepared", "noted", "answered", "done"]);
		assert.equal(queue.asks[0]!.raisedBy, "orchestrator");
	});

	await withTempState(({ state }) => {
		const withdrawn = raiseAsk(state, { by: "grokbot", kind: "review", question: "Keep the old list?" });
		const after = withdrawAsk(state, { ref: withdrawn.id, by: "grokbot", reason: "the queue replaces it" });
		assert.equal(after.status, "withdrawn");
		assert.equal(after.withdrawnReason, "the queue replaces it");
		assert.equal(readAsks(state).asks[0]!.status, "withdrawn");
	});
});

test("two processes appending 200 events each leave 400 parseable lines with unique ids", async () => {
	await withTempState(async ({ root, state }) => {
		const script = join(root, "append-child.ts");
		writeFileSync(
			script,
			[
				'import { randomUUID } from "node:crypto";',
				`import { appendAskEvent } from ${JSON.stringify(ASKS_MODULE)};`,
				"const [stateDir, tag] = process.argv.slice(2);",
				"for (let index = 0; index < 200; index += 1) {",
				"\tappendAskEvent(stateDir, { v: 1, at: new Date().toISOString(), id: `ask_${randomUUID()}`, type: \"raised\", by: \"orchestrator\", kind: \"review\", question: `${tag} ${index}` });",
				"}",
				"",
			].join("\n"),
		);
		const codeOf = (tag: string): Promise<number | null> =>
			new Promise((settle) => {
				const child = spawn(process.execPath, ["--experimental-transform-types", script, state, tag], { stdio: ["ignore", "ignore", "pipe"] });
				child.on("close", (code) => settle(code));
			});
		assert.deepEqual(await Promise.all([codeOf("a"), codeOf("b")]), [0, 0]);

		const lines = readFileSync(asksEventsPath(state), "utf8").split("\n").filter((line) => line.trim() !== "");
		assert.equal(lines.length, 400);
		const ids = lines.map((line) => (JSON.parse(line) as { id: string }).id);
		assert.equal(new Set(ids).size, 400, "two processes never name one ask");
		const queue = readAsks(state);
		assert.equal(queue.asks.length, 400);
		assert.equal(queue.unreadableLines, 0);
		assert.equal(queue.partialLastLine, 0);
	});
});

test("a torn last line is skipped and counted, and the next append parses", async () => {
	await withTempState(({ state }) => {
		const first = raiseAsk(state, { by: "operator-shell", kind: "review", question: "Still open?" });
		appendFileSync(asksEventsPath(state), '{"v":1,"at":"2026-10-16T10:00:00.000Z","id":"ask_');
		const torn = readAsks(state);
		assert.equal(torn.partialLastLine, 1);
		assert.equal(torn.unreadableLines, 0, "the torn tail is counted once, as the partial last line");
		assert.equal(torn.asks.length, 1);
		assert.equal(torn.asks[0]!.id, first.id);

		const second = raiseAsk(state, { by: "operator-shell", kind: "review", question: "Next one" });
		const after = readAsks(state);
		assert.equal(after.partialLastLine, 0, "the append repaired the torn line");
		assert.equal(after.unreadableLines, 1, "the torn line stays visible as an unreadable line");
		assert.equal(after.asks.length, 2, "the event after the torn write is a clean line");
		assert.ok(after.asks.some((ask) => ask.id === second.id));
	});
});

test("the event file is mode 0600 and its directory 0700", async () => {
	await withTempState(({ state }) => {
		raiseAsk(state, { by: "operator-shell", kind: "review", question: "Check the modes" });
		assert.equal(statSync(asksDir(state)).mode & 0o777, 0o700);
		assert.equal(statSync(asksEventsPath(state)).mode & 0o777, 0o600);
	});
});

test("the writer is the process: the operator's shell, the architect's seat, or a refusal", async () => {
	await withTempState(({ state }) => {
		// the operator's own shell carries no agent-session marker.
		assert.deepEqual(resolveAskWriter({ PI_MUSTER_STATE_DIR: state }, undefined), { writer: "operator-shell" });
		// A lane is an agent session whose name is not a seat.
		const lane = { PI_MUSTER_STATE_DIR: state, CONCORD_AGENT_ID: "pi-ak1" };
		const refused = resolveAskWriter(lane, "pi-ak1");
		assert.ok("error" in refused && /lanes ask the orchestrator/.test(refused.error), JSON.stringify(refused));
		// The architect's seat, with the credential its claim minted.
		const claimed = claimSeat("architect", { harness: "pi", sessionId: "s-1", processKey: "pi-1-1-1" }, { kind: "in-process" }, seatContextFor(lane));
		const architect = { ...lane, CONCORD_AGENT_ID: "architect", MUSTER_SEAT_TOKEN: claimed.token };
		assert.deepEqual(resolveAskWriter(architect, "architect"), { writer: "architect" });
		assert.ok("error" in resolveAskWriter({ ...architect, MUSTER_SEAT_TOKEN: `s0.${"ab".repeat(32)}` }, "architect"));
	});
});

test("a valid seat credential decides the writer; an env agent id never vetoes it", async () => {
	await withTempState(({ state }) => {
		const base = { PI_MUSTER_STATE_DIR: state, CLAUDECODE: "1" };
		const claimed = claimSeat("architect", { harness: "claude", sessionId: "s-seat", processKey: "claude-1-1-1" }, { kind: "in-process" }, seatContextFor(base));
		// The seat session still carries a foreign lane id from its launcher.
		const seat = { ...base, MUSTER_SEAT: "architect", MUSTER_SEAT_TOKEN: claimed.token, CONCORD_AGENT_ID: "pb3fix" };
		assert.deepEqual(resolveAskWriter(seat, "pb3fix"), { writer: "architect" });
		assert.deepEqual(resolveAskWriter(seat, undefined), { writer: "architect" });
		// The same env without the credential is a lane and is refused.
		const lane = { ...base, CONCORD_AGENT_ID: "pb3fix" };
		const refused = resolveAskWriter(lane, "pb3fix");
		assert.ok("error" in refused && /lanes ask the orchestrator/.test(refused.error), JSON.stringify(refused));
		// The seat name alone, with a token that is not the holder's, gets nothing.
		for (const token of [`s0.${"ab".repeat(32)}`, `s1.${"cd".repeat(32)}`, "", undefined]) {
			const forged = { ...seat, ...(token === undefined ? { MUSTER_SEAT_TOKEN: undefined } : { MUSTER_SEAT_TOKEN: token }) };
			assert.ok("error" in resolveAskWriter(forged, "pb3fix"), `token ${token === undefined ? "absent" : "bad"}`);
		}
		// A superseded epoch-1 token fails once another session holds the seat (epoch 2).
		claimSeat("architect", { harness: "claude", sessionId: "s-next", processKey: "claude-2-2-2" }, { kind: "in-process" }, seatContextFor(base));
		const stale = resolveAskWriter(seat, "pb3fix");
		assert.ok("error" in stale && /no longer the architect/.test(stale.error), JSON.stringify(stale));
	});
});

test("`muster asks answer|done` from a seat session whose env carries a lane id; a lane and a stale token stay refused", async () => {
	await withTempState(async ({ state }) => {
		const raised = cli(["--kind", "product-decision", "--question", "Ship it?", "--code", "S6B"]);
		assert.equal(await askCommand.run(raised.ctx), 0, raised.err.join("\n"));

		const base = { ...shellEnv(), CLAUDECODE: "1" };
		const claimed = claimSeat("architect", { harness: "claude", sessionId: "s-seat", processKey: "claude-1-1-1" }, { kind: "in-process" }, seatContextFor(base));
		const seatEnv = { ...base, MUSTER_SEAT: "architect", MUSTER_SEAT_TOKEN: claimed.token, CONCORD_AGENT_ID: "pb3fix" };
		const asSeat = (argv: string[], env: NodeJS.ProcessEnv = seatEnv) => {
			const run = cli(argv, { env });
			run.ctx.agentId = env["CONCORD_AGENT_ID"];
			return run;
		};

		// A lane with the same env minus the credential is refused on product asks.
		const lane = asSeat(["answer", "S6B", "--ruling", "yes"], { ...base, CONCORD_AGENT_ID: "pb3fix" });
		assert.equal(await asksCommand.run(lane.ctx), 2);
		assert.match(lane.err.join("\n"), /lanes ask the orchestrator/);

		// A stale-epoch token with the seat name is refused.
		const stale = asSeat(["answer", "S6B", "--ruling", "yes"], { ...seatEnv, MUSTER_SEAT_TOKEN: `s0.${"ab".repeat(32)}` });
		assert.equal(await asksCommand.run(stale.ctx), 2);
		assert.doesNotMatch(stale.err.join("\n"), /pb3fix is not a seat/, "the refusal names the seat credential, not the lane id");
		assert.equal(readAsks(state).asks[0]!.status, "open", "the refusals wrote nothing");

		// The seat holder answers and finishes it.
		const answered = asSeat(["answer", "S6B", "--ruling", "yes", "--row", "plans/x.md:1"]);
		assert.equal(await asksCommand.run(answered.ctx), 0, answered.err.join("\n"));
		assert.equal(readAsks(state).asks[0]!.answeredBy, "architect");
		const finished = asSeat(["done", "S6B", "--evidence", "log:/tmp/muster-tick.log:42"]);
		assert.equal(await asksCommand.run(finished.ctx), 0, finished.err.join("\n"));
		assert.equal(readAsks(state).asks[0]!.status, "done");
	});
});

test("a card-linked ask defers to its card and refuses an answer of its own", async () => {
	await withTempState(({ state, decisions }) => {
		const decisionId = openCard(decisions);
		assert.equal(parseCardLink(cardLink(PROGRAMME_ID, decisionId))?.decisionId, decisionId);
		assert.equal(parseCardLink("card:not-a-programme/dec_1"), undefined);
		assert.equal(parseCardLink("plans/x.md"), undefined);

		const ask = raiseAsk(state, { by: "orchestrator", kind: "product-decision", question: "Ship the pilot?", link: cardLink(PROGRAMME_ID, decisionId) });
		assert.deepEqual(ask.card, { programmeId: PROGRAMME_ID, decisionId });
		prepareAsk(state, { ref: ask.id, by: "orchestrator", options: ["approve"], recommendation: "approve" });
		assert.throws(
			() => answerAsk(state, { ref: ask.id, by: "architect", ruling: "approve", row: "plans/x.md:1" }),
			(error: unknown) => isRefused(error, /answer it on its card/),
		);

		const before = readAsks(state, { cardState: programmeCardReader() });
		assert.equal(before.asks[0]!.status, "awaiting-operator");
		assert.equal(before.asks[0]!.cardState, "open");

		applyDecisionAnswer(PROGRAMME_ID, decisionId, "approve", cardAnswerRef(), { store: fileProgrammeDecisionStore(decisions) });
		const after = readAsks(state, { cardState: programmeCardReader() });
		assert.equal(after.asks[0]!.status, "decided");
		assert.equal(after.asks[0]!.ruling, "approve");
		assert.equal(after.asks[0]!.answeredBy, "operator");
		assert.equal(after.asks[0]!.answeredByCard, true, "the answer came from the card, not from an asks event");
		assert.equal(eventLines(state).filter((event) => event.type === "answered").length, 0);

		// A card that cannot be read is reported, never invented as an answer.
		const unreadable = readAsks(state, { cardState: () => undefined });
		assert.equal(unreadable.asks[0]!.cardState, "unreadable");
		assert.equal(unreadable.asks[0]!.status, "awaiting-operator");
	});
});

test("the answer rules by kind: the orchestrator passes product questions on, and the operator's words carry the rest", async () => {
	await withTempState(({ state }) => {
		const product = raiseAsk(state, { by: "operator-shell", kind: "product-decision", question: "Pilot now?" });
		assert.throws(
			() => answerAsk(state, { ref: product.id, by: "orchestrator", ruling: "ship it" }),
			(error: unknown) => isRefused(error, /passes a product-decision question on/),
		);
		assert.throws(
			() => answerAsk(state, { ref: product.id, by: "architect", ruling: "ship it" }),
			(error: unknown) => isRefused(error, /decision row/),
		);
		assert.equal(answerAsk(state, { ref: product.id, by: "operator-shell", ruling: "ship it" }).status, "decided");

		const credential = raiseAsk(state, { by: "orchestrator", kind: "authorization", question: "Spend on the paid tier" });
		assert.throws(
			() => answerAsk(state, { ref: credential.id, by: "architect", ruling: "yes" }),
			(error: unknown) => isRefused(error, /the operator's words/),
		);
		assert.throws(
			() => answerAsk(state, { ref: credential.id, by: "architect", ruling: "yes", words: "go ahead" }),
			(error: unknown) => isRefused(error, /relay/),
		);
		const relayed = answerAsk(state, {
			ref: credential.id,
			by: "architect",
			ruling: "yes",
			words: "go ahead, it is fine",
			relay: { via: "architect-session", ref: "8153a7a7-fb35-412a-808e-96e6329464e6", at: "2026-10-16T16:00:00.000Z" },
		});
		assert.equal(relayed.status, "decided");
		assert.equal(relayed.words, "go ahead, it is fine");
		assert.equal(relayed.relay?.via, "architect-session");

		// A transition out of a closed ask is refused.
		withdrawAsk(state, { ref: credential.id, by: "orchestrator", reason: "not needed" });
		assert.throws(
			() => answerAsk(state, { ref: credential.id, by: "operator-shell", ruling: "yes" }),
			(error: unknown) => error instanceof AskStateError && error.code === "conflict",
		);
	});
});

test("a code resolves only to a live ask, and two live asks with one code are ambiguous", async () => {
	await withTempState(({ state }) => {
		const first = raiseAsk(state, { by: "operator-shell", kind: "review", question: "First", code: "VD4" });
		const second = raiseAsk(state, { by: "operator-shell", kind: "review", question: "Second", code: "VD4" });
		const queue = readAsks(state);
		assert.deepEqual(queue.duplicateCodes, ["VD4"]);
		assert.deepEqual(resolveAskRef(queue, "VD4"), { ambiguous: queue.asks });
		assert.deepEqual((resolveAskRef(queue, first.id) as { ask: { id: string } }).ask.id, first.id);

		// A closed ask retires its code: the survivor is the only one left.
		finishAsk(state, { ref: second.id, by: "operator-shell", evidence: { commit: "abc1234", repo: "~/projects/x" } });
		const afterClose = readAsks(state);
		assert.deepEqual(afterClose.duplicateCodes, []);
		assert.deepEqual((resolveAskRef(afterClose, "VD4") as { ask: { id: string } }).ask.id, first.id);
		assert.ok("missing" in resolveAskRef(afterClose, "VD9"));
	});
});

test("the view orders a blocking ask above an older one, and then the kinds only the operator may answer", async () => {
	await withTempState(({ state }) => {
		raiseAsk(state, { by: "operator-shell", kind: "review", question: "The oldest, unblocking nothing", code: "VD1", at: "2026-10-13T00:00:00.000Z" });
		raiseAsk(state, { by: "operator-shell", kind: "operator-action", question: "Needs his terminal", at: "2026-10-14T00:00:00.000Z" });
		raiseAsk(state, { by: "operator-shell", kind: "review", question: "Blocks a lane", blocks: ["be-lane-w5"], at: "2026-10-15T00:00:00.000Z" });
		assert.deepEqual(
			orderAsksForOperator(waitingOnOperator(readAsks(state))).map((ask) => ask.question),
			["Blocks a lane", "Needs his terminal", "The oldest, unblocking nothing"],
		);
		const [ask] = readAsks(state).asks;
		const now = Date.parse("2026-10-16T13:00:00.000Z");
		assert.equal(formatAskAge(ask!.raisedAt, now), "3d");
		assert.equal(formatAskAge("not a date", now), "?");
		assert.equal(formatAskLine(ask!, now), "VD1 The oldest, unblocking nothing [review, open, 3d]");
	});
});

test("evidence parses and formats in the three shapes", () => {
	assert.deepEqual(parseEvidence("commit:abc1234@github.com/owner/repo"), { commit: "abc1234", repo: "github.com/owner/repo" });
	assert.deepEqual(parseEvidence("row:LD36@plans/decisions.md:112"), { row: "LD36", file: "plans/decisions.md", line: 112 });
	assert.deepEqual(parseEvidence("log:/tmp/run.log:9"), { log: "/tmp/run.log", file: "/tmp/run.log", line: 9 });
	assert.equal(parseEvidence("commit:abc1234"), undefined);
	assert.equal(parseEvidence("row:LD36@plans/decisions.md"), undefined);
	assert.equal(parseEvidence("row:LD36@plans/decisions.md:zero"), undefined);
	assert.equal(parseEvidence("plain text"), undefined);
});

test("`muster ask` raises for the operator's shell and refuses a lane", async () => {
	await withTempState(async ({ state }) => {
		const raised = cli(["--kind", "review", "--question", "Review the shared owner", "--code", "DQ20", "--blocks", "be-lane-w5,TASK-12"]);
		assert.equal(await askCommand.run(raised.ctx), 0, raised.err.join("\n"));
		assert.match(raised.out.join("\n"), /^muster ask: ask_[0-9a-f-]{36} \(DQ20\) \[review, open\]$/m);
		const [ask] = readAsks(state).asks;
		assert.equal(ask!.raisedBy, "operator-shell");
		assert.deepEqual(ask!.blocks, ["be-lane-w5", "TASK-12"]);

		// A lane is an agent session whose name is not a seat.
		const lane = cli(["--kind", "review", "--question", "From a lane"], { env: { ...shellEnv(), CONCORD_AGENT_ID: "pi-ak1" } });
		lane.ctx.agentId = "pi-ak1";
		assert.equal(await askCommand.run(lane.ctx), 2);
		assert.match(lane.err.join("\n"), /lanes ask the orchestrator/);
		assert.equal(readAsks(state).asks.length, 1, "the refusal wrote nothing");

		const badKind = cli(["--kind", "spending", "--question", "x"]);
		assert.equal(await askCommand.run(badKind.ctx), 2);
		assert.match(badKind.err.join("\n"), /--kind must be one of/);
		assert.ok(ASK_KINDS.includes("operator-action"), "the extra kind is part of the vocabulary");

		const badLink = cli(["--kind", "review", "--question", "x", "--link", "card:nope"]);
		assert.equal(await askCommand.run(badLink.ctx), 2);
		assert.match(badLink.err.join("\n"), /card:<agp_…>\/<dec_…>/);
	});
});

test("the CLI verbs round-trip one ask and print the operator's view", async () => {
	await withTempState(async ({ state }) => {
		const raised = cli(["--kind", "product-decision", "--question", "Pilot now?", "--code", "H1"]);
		assert.equal(await askCommand.run(raised.ctx), 0, raised.err.join("\n"));

		const listed = cli([]);
		assert.equal(await asksCommand.run(listed.ctx), 0, listed.err.join("\n"));
		assert.match(listed.out.join("\n"), /1 waiting on the operator/);
		assert.match(listed.out.join("\n"), /H1 Pilot now\? \[product-decision, open/);

		const shown = cli(["show", "H1"]);
		assert.equal(await asksCommand.run(shown.ctx), 0, shown.err.join("\n"));
		assert.match(shown.out.join("\n"), /raised by: operator-shell/);

		const prepared = cli(["prepare", "H1", "--option", "yes", "--option", "no", "--recommend", "yes"]);
		assert.equal(await asksCommand.run(prepared.ctx), 0, prepared.err.join("\n"));
		assert.match(prepared.out.join("\n"), /prepared — awaiting-operator, rec yes/);

		const noted = cli(["note", "H1", "kept for the record"]);
		assert.equal(await asksCommand.run(noted.ctx), 0, noted.err.join("\n"));
		assert.deepEqual(readAsks(state).asks[0]!.notes, ["kept for the record"]);

		const noRow = cli(["answer", "H1", "--ruling", "yes"]);
		assert.equal(await asksCommand.run(noRow.ctx), 0, noRow.err.join("\n"));

		const done = cli(["done", "H1", "--evidence", "badly shaped"]);
		assert.equal(await asksCommand.run(done.ctx), 2);
		assert.match(done.err.join("\n"), /--evidence must be/);

		const finished = cli(["done", "H1", "--evidence", "log:/tmp/muster-tick.log:42"]);
		assert.equal(await asksCommand.run(finished.ctx), 0, finished.err.join("\n"));
		assert.match(finished.out.join("\n"), /finished — done/);
		assert.equal(readAsks(state).asks[0]!.status, "done");

		// A closed ask takes no further event, and its code is retired: only the id reaches it.
		const retiredCode = cli(["withdraw", "H1", "--reason", "too late"]);
		assert.equal(await asksCommand.run(retiredCode.ctx), 2);
		assert.match(retiredCode.err.join("\n"), /no live ask matches/);
		const askId = readAsks(state).asks[0]!.id;
		const withdrawn = cli(["withdraw", askId, "--reason", "too late"]);
		assert.equal(await asksCommand.run(withdrawn.ctx), 2);
		assert.match(withdrawn.err.join("\n"), /already done/);

		const all = cli(["--all"], { json: true });
		assert.equal(await asksCommand.run(all.ctx), 0);
		const queue = JSON.parse(all.out.join("")) as { asks: Array<{ status: string }>; path: string };
		assert.equal(queue.asks[0]!.status, "done");
		assert.equal(queue.path, join(state, "asks", "events.jsonl"));
	});
});

test("the CLI acts on neither of two live asks sharing a code", async () => {
	await withTempState(async ({ state }) => {
		raiseAsk(state, { by: "operator-shell", kind: "review", question: "First", code: "VD4" });
		raiseAsk(state, { by: "operator-shell", kind: "review", question: "Second", code: "VD4" });
		const shown = cli(["show", "VD4"]);
		assert.equal(await asksCommand.run(shown.ctx), 2);
		assert.match(shown.err.join("\n"), /belongs to 2 live asks/);
		assert.match(shown.err.join("\n"), /First/);
		assert.match(shown.err.join("\n"), /Second/);

		const reviewed = cli(["note", "VD4", "one note for both"]);
		assert.equal(await asksCommand.run(reviewed.ctx), 2);
		assert.match(reviewed.err.join("\n"), /use the id/);
		assert.equal(readAsks(state).asks[0]!.notes.length, 0);

		const listed = cli([]);
		assert.equal(await asksCommand.run(listed.ctx), 0);
		assert.match(listed.out.join("\n"), /review — 2 live asks share code VD4/);
	});
});

test("each CLI verb is one discoverable module with one command export", async () => {
	assert.equal(askCommand.name, "ask");
	assert.equal(asksCommand.name, "asks");
	assert.match(askCommand.usage, /muster ask --kind/);
	assert.match(asksCommand.usage, /muster asks answer/);
	const unknown = cli(["frobnicate"]);
	assert.equal(await asksCommand.run(unknown.ctx), 2);
	assert.match(unknown.err.join("\n"), /unknown subcommand/);
	// \`sweep\` is a subcommand (AK4); without --files it reports its own usage.
	const sweep = cli(["sweep"]);
	assert.equal(await asksCommand.run(sweep.ctx), 2);
	assert.match(sweep.err.join("\n"), /name one check/);
});
