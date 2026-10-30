import "./muster-test-isolation.ts";
/**
 * LC12 (plan §4): the Claude hook, the gateway's write verbs and Hermes.
 *
 * The claims proven here, one deliberate test each, all in ledger mode:
 * 1. The built hook bundle drains a pending message into `hookSpecificOutput.additionalContext` once
 *    at a delivering boundary, and leaves it pending at one that does not deliver.
 * 2. A gateway `lane_send` and a gateway `session_send` land one message each in the lane's inbox.
 * 3. A `hermes` lane card round-trips through the card owner on both backends, and the parity
 *    table's hermes column is the three CLI verbs with every other verb refused.
 *
 * The boundaries themselves (LC-D4, DL6) are covered where they live: `atBoundary`/`atBoundaryAsync`
 * in `muster-ledger-backend.test.ts`, and the entry shape in the code under test. Everything here
 * runs in a temp state directory with its own temp ledger directory (`MUSTER_LEDGER_DIR`), so nothing
 * reads or writes live `state/muster/` and no case writes a live `backend.json`.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { countInboxMessages, listInboxMessages, writeInboxMessage } from "../lib/agent-inbox.ts";
import { readLaneCard, writeLaneCard, type LaneCard } from "../lib/lane-card.ts";
import { LANE_BUS_VERBS, LANE_VERB_PARITY, laneVerbCell } from "../lib/lane-control.ts";
import { backendPath } from "../ledger/backend.ts";
import { createGatewayTools, type GatewayTool } from "../gateway/tools.ts";
import { operatorSessionSend } from "../gateway/oversight.ts";
import { GATEWAY_AGENT_ID } from "../gateway/state.ts";
import { gatewayLaneSend, type LaneSendPorts } from "../send-deps.ts";
import type { SendRequest } from "../send.ts";
import { harnessRoot, nodeBinary, tsxLoaderPath } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
const NODE = nodeBinary();
const DAEMON = join(HARNESS_ROOT, "muster", "ledger", "daemon.ts");
const BUNDLE = join(piAgentDir(), "extensions", "muster", "claude-hook.bundle.mjs");

/** The switch file as the flip tool writes it (LC15). */
const LEDGER_SWITCH = { backend: "ledger", flipId: "lc12-test", at: "2026-10-17T00:00:00+03:00", cursor: "1" };

type Box = { root: string; stateDir: string; ledgerDir: string; close: () => void };

/** One disposable install: a Muster state dir and the ledger dir `musterd` serves from. */
function box(): Box {
	const root = mkdtempSync(join(tmpdir(), "muster-lc12-"));
	const stateDir = join(root, "state", "muster");
	const ledgerDir = join(root, "ledger");
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(ledgerDir, { recursive: true });
	return { root, stateDir, ledgerDir, close: () => rmSync(root, { recursive: true, force: true }) };
}

/** Point the owners at the ledger: the switch file, the ledger directory and the state dir they read. */
function useLedger(b: Box): () => void {
	writeFileSync(backendPath(b.stateDir), JSON.stringify(LEDGER_SWITCH));
	const savedLedger = process.env["MUSTER_LEDGER_DIR"];
	const savedState = process.env["PI_MUSTER_STATE_DIR"];
	process.env["MUSTER_LEDGER_DIR"] = b.ledgerDir;
	process.env["PI_MUSTER_STATE_DIR"] = b.stateDir;
	return () => {
		if (savedLedger === undefined) delete process.env["MUSTER_LEDGER_DIR"];
		else process.env["MUSTER_LEDGER_DIR"] = savedLedger;
		if (savedState === undefined) delete process.env["PI_MUSTER_STATE_DIR"];
		else process.env["PI_MUSTER_STATE_DIR"] = savedState;
	};
}

/** The loader this process runs under, so a child fixture loads a `.ts` module the same way. */
function loaderArgs(): string[] {
	const args: string[] = [];
	for (let at = 0; at < process.execArgv.length; at++) {
		if (process.execArgv[at] === "--import" && process.execArgv[at + 1] !== undefined) args.push("--import", process.execArgv[at + 1] as string);
	}
	return args.length > 0 ? args : ["--import", tsxLoaderPath()];
}

/** The real `startDaemon` in its own process: `requestSync` blocks the calling thread in `Atomics.wait`. */
function startDaemon(t: TestContext, dir: string): Promise<void> {
	const file = join(dir, "fixture-daemon.mjs");
	writeFileSync(
		file,
		[`import { startDaemon } from ${JSON.stringify(DAEMON)};`, "await startDaemon(process.env.MUSTER_FIXTURE_DIR);", 'process.stdout.write("READY\\n");'].join("\n"),
	);
	const child: ChildProcess = spawn(NODE, [...loaderArgs(), file], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, MUSTER_FIXTURE_DIR: dir },
	});
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

/** The state a lane card must carry; a test names only the fields it is about. */
function card(fields: Partial<LaneCard> & { laneId: string }): LaneCard {
	return { harness: "pi", cwd: null, branch: null, state: "running", model: null, thinking: null, since: Date.now(), updatedAt: Date.now(), wall: null, ...fields };
}

/** One hook call exactly as Claude Code's plugin makes it: the built bundle, a fresh process, the payload on stdin. */
function runBundle(b: Box, args: string[], input: string): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(NODE, [BUNDLE, ...args], {
		encoding: "utf8",
		input,
		cwd: HARNESS_ROOT,
		timeout: 60_000,
		env: { ...process.env, PI_MUSTER_STATE_DIR: b.stateDir, MUSTER_LEDGER_DIR: b.ledgerDir, HOME: join(b.root, "home"), CLAUDE_CONFIG_DIR: join(b.root, "claude") },
	});
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The payload Claude Code sends for one boundary. */
function payload(event: string): string {
	return JSON.stringify({ hook_event_name: event, session_id: "lc12-session", cwd: "/w/cc-lane" });
}

// ─── 1. The bundle in ledger mode ───────────────────────────────────────────

test("LC12: the hook bundle in ledger mode drains a pending message into additionalContext once", async (t) => {
	const b = box();
	t.after(b.close);
	await startDaemon(t, b.ledgerDir);
	const restore = useLedger(b);
	t.after(restore);

	writeInboxMessage(b.stateDir, { agent: "cc-lane", from: "orchestrator", at: "2026-10-17T06:00:00.000Z", text: "the ledger message", idempotencyKey: "lc12-m1", mode: "steer", source: "send" });
	assert.equal(countInboxMessages(b.stateDir, "cc-lane"), 1, "the message is in the ledger inbox the hook reads");

	// `PreToolUse` is not one of the hook's delivering boundaries (`DELIVERING_EVENTS` in
	// `claude-hook.ts`): a message waits there and the answer stays empty.
	const pre = runBundle(b, ["claude-hook", "PreToolUse", "--lane", "cc-lane"], payload("PreToolUse"));
	assert.equal(pre.status, 0, pre.stderr);
	assert.equal(pre.stdout.trim(), "", "a boundary that does not deliver prints nothing");
	assert.equal(countInboxMessages(b.stateDir, "cc-lane"), 1, "the message is still pending after it");

	const first = runBundle(b, ["claude-hook", "PostToolUse", "--lane", "cc-lane"], payload("PostToolUse"));
	assert.equal(first.status, 0, first.stderr);
	const answer = JSON.parse(first.stdout.trim()) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string[] } };
	assert.equal(answer.hookSpecificOutput?.hookEventName, "PostToolUse");
	assert.equal(answer.hookSpecificOutput?.additionalContext?.length, 1, "one message, one context line");
	assert.match(answer.hookSpecificOutput?.additionalContext?.[0] ?? "", /the ledger message/);
	assert.equal(countInboxMessages(b.stateDir, "cc-lane"), 0, "the drain moved it out of the pending set");

	const second = runBundle(b, ["claude-hook", "PostToolUse", "--lane", "cc-lane"], payload("PostToolUse"));
	assert.equal(second.status, 0, second.stderr);
	assert.equal(second.stdout.trim(), "", "the second boundary answers nothing: the empty answer is the cheap case");
});

// ─── 2. The gateway's write verbs on the ledger ─────────────────────────────

/** The gateway's production wiring, with the machine-reading ports stubbed: the stores are the real ones.
 *  The literal goes straight into the factory (as the gateway's own tests do) so it is checked against
 *  the factory's own parameter type, not the repo's duplicated `GatewayToolDeps` alias. */
function gatewayTools(b: Box, rows: LaneCard[]): GatewayTool[] {
	const sendPorts: LaneSendPorts = {
		readRows: () => [],
		pane: async () => ({ ok: false, command: "none", detail: "no pane in this test" }),
		// The arrival proof waits on a card beat this test does not produce; the inbox write is what it proves.
		confirmArrival: false,
	};
	return createGatewayTools({
		stateDir: b.stateDir,
		lanes: () => rows,
		notesRoot: join(b.root, "notes"),
		agentId: GATEWAY_AGENT_ID,
		sendToOrchestrator: async () => "delivered",
		actions: {
			deliverLaneMessage: (request) => gatewayLaneSend(request as SendRequest, b.stateDir, async () => undefined, sendPorts),
			readLaneCard: (stateDir, laneId) => readLaneCard(stateDir, laneId),
			enqueueLaneControl: () => "/unused.json",
			launchLane: async () => ({ ok: false, detail: "unused" }),
			readLaneLatestReport: () => undefined,
			canWriteBrief: () => ({ ok: false, reason: "unused" }),
		},
		oversight: {
			home: b.root,
			stateDir: b.stateDir,
			lanes: () => rows,
			send: operatorSessionSend({ musterStateDir: b.stateDir, lanes: () => rows }),
		},
	});
}

test("LC12: a gateway lane_send and session_send in ledger mode land one message each", async (t) => {
	const b = box();
	t.after(b.close);
	await startDaemon(t, b.ledgerDir);
	const restore = useLedger(b);
	t.after(restore);

	writeLaneCard(b.stateDir, card({ laneId: "pi-lane", harness: "pi" }));
	const rows = [card({ laneId: "pi-lane", harness: "pi" }), card({ laneId: "operator:claude:abc12345", harness: "claude", origin: "operator" })];
	const tools = gatewayTools(b, rows);
	const byName = (name: string): GatewayTool => tools.find((tool) => tool.name === name)!;

	const sent = await byName("lane_send").run({ lane: "pi-lane", text: "the gateway lane message" });
	assert.match(sent, /delivered to pi-lane/, sent);
	assert.equal(countInboxMessages(b.stateDir, "pi-lane"), 1, "one message, through the inbox owner");
	assert.match(listInboxMessages(b.stateDir, "pi-lane")[0]!.text, /the gateway lane message/);
	assert.equal(listInboxMessages(b.stateDir, "pi-lane")[0]!.from, GATEWAY_AGENT_ID);

	const session = await byName("session_send").run({ lane: "operator:claude:abc12345", text: "the gateway session message" });
	assert.match(session, /^muster send: queued for operator:claude:abc12345 \(inbox;/, session);
	assert.equal(countInboxMessages(b.stateDir, "operator:claude:abc12345"), 1, "one message for the operator's own session");
	assert.match(listInboxMessages(b.stateDir, "operator:claude:abc12345")[0]!.text, /the gateway session message/);
});

// ─── 3. Hermes: the card and the parity column ──────────────────────────────

test("LC12: a hermes lane card round-trips on both backends, and the parity table has its hermes column", async (t) => {
	// Files mode: the owner writes and reads the harness the F17 row adds.
	const files = box();
	t.after(files.close);
	writeLaneCard(files.stateDir, card({ laneId: "hermes-lane", harness: "hermes" }));
	assert.equal(readLaneCard(files.stateDir, "hermes-lane")?.harness, "hermes");

	// The gateway's own check takes the new value (it is not an "unknown harness") and refuses the
	// verb with the parity column's reason, so the column reaches the tool the orchestrator calls.
	const control = gatewayTools(files, []).find((tool) => tool.name === "lane_control")!;
	const refusal = await control.run({ lane: "hermes-lane", verb: "abort" });
	assert.match(refusal, /^refused: .+ Substitute: /);
	assert.doesNotMatch(refusal, /unknown harness/);

	// Ledger mode: the same owner, the same record, over the store.
	const ledger = box();
	t.after(ledger.close);
	await startDaemon(t, ledger.ledgerDir);
	const restore = useLedger(ledger);
	t.after(restore);
	writeLaneCard(ledger.stateDir, card({ laneId: "hermes-lane", harness: "hermes", sessionId: "hermes-session-1" }));
	const stored = readLaneCard(ledger.stateDir, "hermes-lane");
	assert.equal(stored?.harness, "hermes");
	assert.equal(stored?.sessionId, "hermes-session-1", "the record is stored verbatim (LC-D3)");

	// The column: the CLI serves report, wait and send; every other verb refuses with its reason.
	for (const verb of ["send", "report", "wait"] as const) assert.equal(laneVerbCell("hermes", verb).support, "works", `hermes/${verb} works through the CLI`);
	for (const verb of LANE_BUS_VERBS) {
		if (verb === "send" || verb === "report" || verb === "wait") continue;
		const cell = laneVerbCell("hermes", verb);
		assert.equal(cell.support, "cannot", `hermes/${verb} is refused`);
		if (cell.support === "cannot") assert.ok(cell.why.trim() !== "" && cell.substitute.trim() !== "", `hermes/${verb} states a reason and a substitute`);
	}
	for (const verb of LANE_BUS_VERBS) assert.notEqual(LANE_VERB_PARITY[verb]["hermes"], undefined, `${verb} carries the hermes column`);
});
