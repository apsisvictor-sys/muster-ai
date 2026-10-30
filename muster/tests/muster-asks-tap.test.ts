import "./muster-test-isolation.ts";
/**
 * NLT, the store part (Revision 6, D15): a tap answer on a prepared ask.
 *
 * `answerAsk` takes `tap: {option, version}` only from the page (`operator-page`, relay
 * `command-center`), records the ruling as the option with no words and the new event field `tap`,
 * and skips the words guards for that form alone. The page's own `answer` action (acceptance 4) goes
 * with NLP and is not tested here.
 *
 * OS temp directories only; the ledger case runs the real daemon in its own process.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
	AskStateError,
	answerAsk,
	answerAskResult,
	askVersion,
	finishAsk,
	prepareAsk,
	raiseAsk,
	readAsks,
	withdrawAsk,
	type Ask,
	type AskKind,
	type AskRelay,
	type AskWriter,
} from "../asks.ts";
import { backendPath } from "../ledger/backend.ts";
import { command as asksCommand } from "../cli/asks.ts";
import type { CliContext } from "../cli/types.ts";
import { harnessRoot, nodeBinary, tsxLoaderPath } from "../../core/harness-paths.ts";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
const NODE = nodeBinary();
const DAEMON = join(HARNESS_ROOT, "muster", "ledger", "daemon.ts");

const PAGE_RELAY = (): AskRelay => ({ via: "command-center", ref: "page-call-1", at: "2026-10-25T06:00:00.000Z" });
const OPTIONS = ["Approve", "Hold", "Reject"];

function withState(run: (state: string) => void | Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "muster-asks-tap-"));
	const state = join(root, "state", "muster");
	mkdirSync(state, { recursive: true });
	const saved = process.env.PI_MUSTER_STATE_DIR;
	process.env.PI_MUSTER_STATE_DIR = state;
	return Promise.resolve()
		.then(() => run(state))
		.finally(() => {
			if (saved === undefined) delete process.env.PI_MUSTER_STATE_DIR;
			else process.env.PI_MUSTER_STATE_DIR = saved;
			rmSync(root, { recursive: true, force: true });
		});
}

/** A prepared ask of the given kind, in the state the page lists it. */
function prepared(state: string, kind: AskKind, question = `Question about ${kind}?`): Ask {
	const ask = raiseAsk(state, { by: "orchestrator", kind, question, blocks: ["lane-a"] });
	return prepareAsk(state, { ref: ask.id, by: "orchestrator", options: OPTIONS, recommendation: "Approve" });
}

/** The page's tap, as the gateway makes it. */
function tapInput(ask: Ask, option: string, extra: Partial<Parameters<typeof answerAsk>[1]> = {}): Parameters<typeof answerAsk>[1] {
	return { ref: ask.id, by: "operator-page", ruling: option, relay: PAGE_RELAY(), tap: { option, version: askVersion(ask) }, ...extra };
}

function refused(state: string, ask: Ask, input: Parameters<typeof answerAsk>[1], pattern: RegExp, code?: AskStateError["code"]): void {
	const before = JSON.stringify(readAsks(state).asks);
	assert.throws(
		() => answerAsk(state, input),
		(error) => error instanceof AskStateError && pattern.test(error.message) && (code === undefined || error.code === code),
	);
	assert.equal(JSON.stringify(readAsks(state).asks), before, "a refused tap leaves the ask unchanged");
	assert.equal(readAsks(state).asks.find((candidate) => candidate.id === ask.id)!.status, ask.status);
}

// ─── 1. A tap records the ruling as the option ───────────────────────────────

for (const kind of ["authorization", "product-decision", "human-login"] as const) {
	test(`NLT 1: a page tap on a prepared ${kind} ask records the option, no words, and tap`, async () => {
		await withState((state) => {
			const ask = prepared(state, kind);
			const { ask: answered, already } = answerAskResult(state, tapInput(ask, "Hold", { at: "2026-10-25T06:01:00.000Z" }));
			assert.equal(already, false);
			assert.equal(answered.status, "decided");
			assert.equal(answered.ruling, "Hold");
			assert.equal(answered.words, undefined, "a tap is never the operator's words");
			assert.equal(answered.answeredBy, "operator-page");
			assert.deepEqual(answered.relay, PAGE_RELAY());
			assert.deepEqual(answered.tap, { option: "Hold", version: askVersion(ask) });
			// What the queue folds back from the store is the same.
			assert.deepEqual(readAsks(state).asks.find((candidate) => candidate.id === ask.id)!.tap, answered.tap);
		});
	});
}

// ─── 2. Repeats and refusals ─────────────────────────────────────────────────

test("NLT 2: a second tap of the recorded option answers already and appends nothing, even with an old version", async () => {
	await withState((state) => {
		const ask = prepared(state, "authorization");
		answerAsk(state, tapInput(ask, "Approve"));
		const eventsBefore = JSON.stringify(readAsks(state).asks);
		const again = answerAskResult(state, tapInput(ask, "Approve"));
		assert.equal(again.already, true);
		assert.equal(again.ask.ruling, "Approve");
		assert.equal(JSON.stringify(readAsks(state).asks), eventsBefore, "nothing was appended");
	});
});

test("NLT 2: refused with the ask unchanged: a different option on an answered ask, an option not listed, a changed version, an unprepared ask", async () => {
	await withState((state) => {
		const ask = prepared(state, "authorization");
		answerAsk(state, tapInput(ask, "Approve"));
		const answered = readAsks(state).asks.find((candidate) => candidate.id === ask.id)!;
		refused(state, answered, tapInput(ask, "Hold"), /already decided|only an open or awaiting-operator/, "conflict");
		// With the fresh version too: an answered ask is not tapped again with another option.
		refused(state, answered, tapInput(answered, "Hold"), /only an open or awaiting-operator/, "conflict");

		const fresh = prepared(state, "authorization", "Another?");
		refused(state, fresh, tapInput(fresh, "approve"), /not one of this ask's options/, "invalid");
		refused(state, fresh, tapInput(fresh, "Maybe"), /not one of this ask's options/, "invalid");
		refused(state, fresh, { ...tapInput(fresh, "Approve"), tap: { option: "Approve", version: "0000000000000000" } }, /this ask changed/, "conflict");

		const bare = raiseAsk(state, { by: "orchestrator", kind: "authorization", question: "Unprepared?" });
		refused(state, bare, tapInput(bare, "Approve"), /it has none: it is not prepared/, "invalid");
	});
});

test("NLT 2: a version the ask has moved past is refused; the tap with the new version goes through", async () => {
	await withState((state) => {
		const ask = prepared(state, "authorization");
		const stale = askVersion(ask);
		prepareAsk(state, { ref: ask.id, by: "orchestrator", options: OPTIONS, recommendation: "Hold", at: "2099-01-01T00:00:00.000Z" });
		const moved = readAsks(state).asks.find((candidate) => candidate.id === ask.id)!;
		assert.notEqual(askVersion(moved), stale);
		refused(state, moved, { ...tapInput(moved, "Approve"), tap: { option: "Approve", version: stale } }, /this ask changed/, "conflict");
		assert.equal(answerAsk(state, tapInput(moved, "Approve")).status, "decided");
	});
});

test("NLT 2: a tap with words, or a ruling that is not its option, is refused", async () => {
	await withState((state) => {
		const ask = prepared(state, "authorization");
		refused(state, ask, tapInput(ask, "Approve", { words: "yes please" }), /carries no words/, "refused");
		refused(state, ask, tapInput(ask, "Approve", { ruling: "Hold" }), /ruling is its option/, "invalid");
	});
});

test("NLT 2: a tap by grokbot, architect, orchestrator or operator-shell is refused, and so is the relay grokbot-gateway or none", async () => {
	await withState((state) => {
		const ask = prepared(state, "authorization");
		for (const by of ["grokbot", "architect", "orchestrator", "operator-shell"] as AskWriter[]) {
			refused(state, ask, tapInput(ask, "Approve", { by, ...(by === "grokbot" ? { relay: { via: "grokbot-gateway", ref: "call", at: "2026-10-25T06:00:00.000Z" } as AskRelay } : {}) }), /only from the command center page/, "refused");
			refused(state, ask, tapInput(ask, "Approve", { by }), /only from the command center page/, "refused");
		}
		refused(state, ask, tapInput(ask, "Approve", { relay: { via: "grokbot-gateway", ref: "call", at: "2026-10-25T06:00:00.000Z" } }), /only from the command center page/, "refused");
		refused(state, ask, tapInput(ask, "Approve", { relay: { via: "architect-session", ref: "s", at: "2026-10-25T06:00:00.000Z" } }), /only from the command center page/, "refused");
		const { relay: _relay, ...noRelay } = tapInput(ask, "Approve");
		refused(state, ask, noRelay, /only from the command center page/, "refused");
		refused(state, ask, tapInput(ask, "Approve", { relay: { via: "command-center", ref: " ", at: "2026-10-25T06:00:00.000Z" } }), /only from the command center page/, "refused");
	});
});

test("NLT 2: a card-linked ask and a closed ask refuse a tap", async () => {
	await withState((state) => {
		const linked = raiseAsk(state, { by: "orchestrator", kind: "product-decision", question: "On a card?", link: "card:agp_0123456789ab/dec_01234567-89ab-4def-8123-456789abcdef" });
		const linkedPrepared = prepareAsk(state, { ref: linked.id, by: "orchestrator", options: OPTIONS, recommendation: "Approve" });
		refused(state, linkedPrepared, tapInput(linkedPrepared, "Approve"), /defers to card/, "refused");

		const done = prepared(state, "authorization", "Done soon?");
		finishAsk(state, { ref: done.id, by: "orchestrator", evidence: { commit: "abc1234", repo: "/tmp/r" } });
		refused(state, readAsks(state).asks.find((candidate) => candidate.id === done.id)!, tapInput(done, "Approve"), /already done/, "conflict");

		const gone = prepared(state, "authorization", "Withdrawn soon?");
		withdrawAsk(state, { ref: gone.id, by: "orchestrator", reason: "no longer needed" });
		refused(state, readAsks(state).asks.find((candidate) => candidate.id === gone.id)!, tapInput(gone, "Approve"), /already withdrawn/, "conflict");
	});
});

test("NLT 2: the words form is unchanged: the guards still apply, and an answer in words clears a recorded tap", async () => {
	await withState((state) => {
		const ask = prepared(state, "authorization");
		// A operator-page words answer on a the operator-only kind still needs words and the relay.
		assert.throws(() => answerAsk(state, { ref: ask.id, by: "operator-page", ruling: "Approve" }), /answered only with the operator's words/);
		assert.throws(() => answerAsk(state, { ref: ask.id, by: "grokbot", ruling: "Approve", relay: { via: "grokbot-gateway", ref: "c", at: "2026-10-25T06:00:00.000Z" } }), /answered only with the operator's words/);
		answerAsk(state, tapInput(ask, "Approve"));
		const words = answerAsk(state, { ref: ask.id, by: "operator-page", ruling: "Hold", words: "hold it", relay: PAGE_RELAY() });
		assert.equal(words.ruling, "Hold");
		assert.equal(words.tap, undefined, "the later answer in words replaces the tap");
		assert.equal("tap" in words, false);
	});
});

// ─── 3. The CLI prints tap; the ledger keeps it ──────────────────────────────

function cli(argv: string[], json = false, env: NodeJS.ProcessEnv = { PI_MUSTER_STATE_DIR: process.env.PI_MUSTER_STATE_DIR }, agentId?: string): { ctx: CliContext; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	return {
		out,
		err,
		ctx: {
			argv,
			repoRoot: "/tmp/no-repo",
			agentId,
			json,
			cwd: "/tmp/no-repo",
			env,
			io: { out: (line) => out.push(line), err: (line) => err.push(line) },
			readStdin: async () => "",
		},
	};
}

test("NLT 3: muster asks --json and show carry tap; an ask answered in words prints none", async () => {
	await withState(async (state) => {
		const tapped = prepared(state, "authorization", "Tapped?");
		answerAsk(state, tapInput(tapped, "Reject"));
		const typed = prepared(state, "authorization", "Typed?");
		answerAsk(state, { ref: typed.id, by: "operator-page", ruling: "Hold", words: "hold", relay: PAGE_RELAY() });

		const list = cli([], true);
		assert.equal(await asksCommand.run(list.ctx), 0, list.err.join("\n"));
		const printed = (JSON.parse(list.out.join("\n")) as { asks: Ask[] }).asks;
		assert.deepEqual(printed.find((ask) => ask.id === tapped.id)!.tap, { option: "Reject", version: askVersion(tapped) });
		assert.equal("tap" in printed.find((ask) => ask.id === typed.id)!, false);

		const one = cli(["show", tapped.id], true);
		assert.equal(await asksCommand.run(one.ctx), 0, one.err.join("\n"));
		assert.equal((JSON.parse(one.out.join("\n")) as Ask).tap?.option, "Reject");
		const plain = cli(["show", tapped.id]);
		assert.equal(await asksCommand.run(plain.ctx), 0, plain.err.join("\n"));
		assert.match(plain.out.join("\n"), /^ {2}tap: Reject \(version [0-9a-f]{16}\)$/m);
		const plainTyped = cli(["show", typed.id]);
		assert.equal(await asksCommand.run(plainTyped.ctx), 0, plainTyped.err.join("\n"));
		assert.doesNotMatch(plainTyped.out.join("\n"), /\btap:/);
	});
});

type Box = { root: string; stateDir: string; ledgerDir: string; close: () => void };

function box(): Box {
	const root = mkdtempSync(join(tmpdir(), "muster-nlt-"));
	const stateDir = join(root, "state", "muster");
	const ledgerDir = join(root, "ledger");
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(ledgerDir, { recursive: true });
	return { root, stateDir, ledgerDir, close: () => rmSync(root, { recursive: true, force: true }) };
}

function loaderArgs(): string[] {
	const args: string[] = [];
	for (let at = 0; at < process.execArgv.length; at++) {
		if (process.execArgv[at] === "--import" && process.execArgv[at + 1] !== undefined) args.push("--import", process.execArgv[at + 1] as string);
	}
	return args.length > 0 ? args : ["--import", tsxLoaderPath()];
}

function startDaemon(t: TestContext, dir: string): Promise<void> {
	const file = join(dir, "fixture-daemon.mjs");
	writeFileSync(
		file,
		[`import { startDaemon } from ${JSON.stringify(DAEMON)};`, "await startDaemon(process.env.MUSTER_FIXTURE_DIR);", 'process.stdout.write("READY\\n");'].join("\n"),
	);
	const child: ChildProcess = spawn(NODE, [...loaderArgs(), file], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MUSTER_FIXTURE_DIR: dir } });
	let output = "";
	const collect = (chunk: Buffer): void => void (output += chunk.toString());
	child.stdout?.on("data", collect);
	child.stderr?.on("data", collect);
	t.after(async () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
		child.kill("SIGKILL");
		await exited;
	});
	return (async () => {
		const deadline = Date.now() + 15_000;
		while (!output.includes("READY")) {
			if (child.exitCode !== null || child.signalCode !== null) throw new Error(`the daemon fixture exited before READY: ${output}`);
			if (Date.now() > deadline) throw new Error(`the daemon fixture did not answer within 15 s: ${output}`);
			await delay(25);
		}
	})();
}

test("NLT 3: the ledger round trip keeps tap, and the tap rules hold in ledger mode", async (t) => {
	const b = box();
	t.after(b.close);
	await startDaemon(t, b.ledgerDir);
	writeFileSync(backendPath(b.stateDir), JSON.stringify({ backend: "ledger", flipId: "nlt-test", at: "2026-10-25T00:00:00+03:00", cursor: "1" }));
	const savedLedger = process.env["MUSTER_LEDGER_DIR"];
	const savedState = process.env["PI_MUSTER_STATE_DIR"];
	process.env["MUSTER_LEDGER_DIR"] = b.ledgerDir;
	process.env["PI_MUSTER_STATE_DIR"] = b.stateDir;
	t.after(() => {
		if (savedLedger === undefined) delete process.env["MUSTER_LEDGER_DIR"];
		else process.env["MUSTER_LEDGER_DIR"] = savedLedger;
		if (savedState === undefined) delete process.env["PI_MUSTER_STATE_DIR"];
		else process.env["PI_MUSTER_STATE_DIR"] = savedState;
	});

	const ask = prepared(b.stateDir, "human-login", "Log in to the portal?");
	const answered = answerAsk(b.stateDir, tapInput(ask, "Approve"));
	assert.deepEqual(answered.tap, { option: "Approve", version: askVersion(ask) });
	const reread = readAsks(b.stateDir).asks.find((candidate) => candidate.id === ask.id)!;
	assert.deepEqual(reread.tap, answered.tap);
	assert.equal(reread.words, undefined);
	assert.equal(answerAskResult(b.stateDir, tapInput(ask, "Approve")).already, true);
	assert.throws(() => answerAsk(b.stateDir, tapInput(ask, "Hold")), /only an open or awaiting-operator/);
});

// ─── 5. The CLI cannot tap or name the page ──────────────────────────────────

test("NLT 5: the CLI still refuses --agent operator-page and --relay command-center, and has no tap flag", async () => {
	await withState(async (state) => {
		const ask = prepared(state, "authorization");

		const asPage = cli(["answer", ask.id, "--ruling", "Approve", "--words", "yes", "--relay", "x"], false, { PI_MUSTER_STATE_DIR: state, CONCORD_AGENT_ID: "operator-page" }, "operator-page");
		assert.equal(await asksCommand.run(asPage.ctx), 2);
		assert.match(asPage.err.join("\n"), /is not a seat/);

		const viaPage = cli(["answer", ask.id, "--ruling", "Approve", "--words", "yes", "--relay", "command-center:call-1"], false, { PI_MUSTER_STATE_DIR: state });
		assert.equal(await asksCommand.run(viaPage.ctx), 0, viaPage.err.join("\n"));
		const recorded = readAsks(state).asks.find((candidate) => candidate.id === ask.id)!;
		// The carrier is not parsed as "command-center": the whole text is the ref, via the writer's own default.
		assert.notEqual(recorded.relay?.via, "command-center");
		assert.equal(recorded.answeredBy, "operator-shell");
		assert.equal(recorded.tap, undefined);

		const other = prepared(state, "authorization", "Second?");
		const withTap = cli(["answer", other.id, "--ruling", "Approve", "--tap", "Approve"], false, { PI_MUSTER_STATE_DIR: state });
		const code = await asksCommand.run(withTap.ctx);
		const after = readAsks(state).asks.find((candidate) => candidate.id === other.id)!;
		// Without the operator's words a shell answer on a the operator-only kind is recorded by operator-shell or refused; never as a tap.
		assert.equal(after.tap, undefined);
		assert.ok(code === 0 || code === 2);
	});
});
