/**
 * `muster` CLI tests — A3 of the harness bus design, section 4.7.
 *
 * The frame discovers command modules, prints usage, and refuses bad input
 * before any Concord connection: these cases need no workspace.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { writeLaneCard, type LaneCard } from "../lib/lane-card.ts";
import { writeLaneRegistryRow } from "../lib/lane-directory.ts";
import { agentInboxReadDir, listInboxMessages, writeInboxMessage } from "../lib/agent-inbox.ts";
import { harnessRoot } from "../../core/harness-paths.ts";
import { musterLauncher } from "../../core/pi-ports.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = musterLauncher();

function runMuster(args: string[], input?: string, env?: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(LAUNCHER, args, {
		encoding: "utf8",
		timeout: 60_000,
		input,
		cwd: join(HARNESS_ROOT),
		...(env !== undefined ? { env: { ...process.env, ...env } } : {}),
	});
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** A temp installation: cards under PI_MUSTER_STATE_DIR, no other harness CLI on PATH. */
function tempInstall(): { state: string; home: string; bin: string; env: NodeJS.ProcessEnv; card: (laneId: string, fields: Partial<LaneCard>) => void; fakeClaude: (script?: string) => void; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "muster-cli-"));
	const state = join(root, "state", "muster");
	const home = join(root, "home");
	// PATH has the shell the launcher runs under and the node it needs, but not
	// the `claude` CLI: these tests assert what the lane cards say, nothing else.
	const bin = join(root, "bin");
	mkdirSync(bin, { recursive: true });
	symlinkSync("/usr/bin/bash", join(bin, "bash"));
	symlinkSync(process.execPath, join(bin, "node"));
	// `/usr/bin` keeps the shell utilities the launcher needs; `claude` lives in
	// ~/.local/bin, which is deliberately absent.
	// A tmux session that does not exist: `stop` must never look at (or kill) a real lane window.
	const env = { PI_MUSTER_STATE_DIR: state, HOME: home, PI_LANES_SYSTEM_EVIDENCE: "off", PI_LANES_TMUX_SESSION: "muster-cli-test-nosuch", PATH: `${bin}:/usr/bin:${dirname(process.execPath)}` };
	return {
		state,
		home,
		bin,
		env,
		card(laneId, fields) {
			const now = Date.now();
			writeLaneCard(state, {
				laneId,
				harness: "pi",
				cwd: "/tmp/lane",
				branch: null,
				state: "idle",
				model: null,
				thinking: null,
				since: now,
				updatedAt: now,
				wall: null,
				...fields,
			} as LaneCard);
			// The launcher names every lane it starts in its registry. A card nothing else names is the operator's own
			// session and read-only on the bus (LD2, LD46), so these lanes get the row a launch would have written.
			writeLaneRegistryRow(state, laneId, { sessionId: fields.sessionId ?? `sess-${laneId}`, harness: fields.harness ?? "pi" });
		},
		// A `claude` stand-in: `agents --json` answers with one background row,
		// `stop <id>` records its arguments. It never touches a real session.
		fakeClaude(script?: string) {
			writeFileSync(join(bin, "claude"), script ?? CLAUDE_STUB, { mode: 0o755 });
		},
		cleanup() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

const CLAUDE_STUB = [
	"#!/usr/bin/bash",
	'if [ "$1" = agents ]; then',
	'  if [ "${CLAUDE_FAKE_MODE:-}" = no-row ]; then echo "[]"; exit 0; fi',
	"  cat <<'JSON'",
	'[{"id":"15d51acb","cwd":"/tmp/lane","kind":"background","startedAt":1,"sessionId":"15d51acb-f02a-45a9-828f-063f4faf9356","name":"cc-test","state":"idle"}]',
	'JSON',
	'  exit 0',
	'fi',
	`printf '%s\\n' "$*" >> "$(dirname "$0")/claude-calls.log"`,
	'if [ "${CLAUDE_FAKE_MODE:-}" = fail-stop ]; then echo "couldn\'t confirm it was stopped" >&2; exit 1; fi',
	'exit 0',
].join("\n") + "\n";

function claudeCalls(bin: string): string[] {
	try {
		return readFileSync(join(bin, "claude-calls.log"), "utf8").trim().split("\n").filter((line) => line !== "");
	} catch {
		return [];
	}
}

test("muster --help lists the discovered commands", () => {
	const result = runMuster(["--help"]);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /muster — Muster's harness-neutral interface over Concord/);
	assert.match(result.stdout, /send {2,}Deliver a message/);
	assert.match(result.stdout, /wait {2,}Wait for the first thing/);
	assert.match(result.stdout, /report {2,}File one lane report/);
	assert.match(result.stdout, /lanes {2,}Print the lane directory/);
});

test("an unknown command is refused with usage", () => {
	const result = runMuster(["nonsense"]);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /unknown command nonsense/);
	assert.match(result.stderr, /Usage: muster/);
});

test("send without a lane is refused before any connection", () => {
	const result = runMuster(["send"]);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /a lane id is required/);
});

test("send refuses a mode outside the three", () => {
	const result = runMuster(["send", "lane", "--mode", "hurry", "text"]);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /mode must be one of steer, followup, wake/);
});

test("send refuses an empty message", () => {
	const result = runMuster(["send", "lane", "--agent", "x"], "");
	assert.equal(result.status, 2);
});

test("send reads the message from stdin with --stdin", () => {
	// No Concord workspace at the repo under test, so the delivery is refused —
	// but the refusal proves the message travelled: it is about the recipient.
	const result = runMuster(["--repo", "/nonexistent-repo", "--agent", "pi-core", "send", "lane", "--stdin"], "text from stdin");
	assert.match(`${result.stderr}${result.stdout}`, /lane/);
});

test("report without a task is lane level, and without an identity it is refused", () => {
	const inst = tempInstall();
	try {
		const noIdentity = runMuster(["report", "working", "summary"], undefined, inst.env);
		assert.equal(noIdentity.status, 2);
		assert.match(noIdentity.stderr, /no agent identity/);

		// Lane level: the card carries the line even when Concord cannot be reached,
		// which is exactly the case the pilot hit on pi-be-g3 (check 3).
		inst.card("pi-test-lane", { state: "idle" });
		const laneLevel = runMuster(["--repo", "/nonexistent-repo", "--agent", "pi-test-lane", "report", "working", "half way"], undefined, inst.env);
		assert.equal(laneLevel.status, 0);
		assert.match(`${laneLevel.stderr}${laneLevel.stdout}`, /half way/);
		const card = readFileSync(join(inst.state, "lanes", "pi-test-lane.json"), "utf8");
		assert.match(card, /"lastReport"/);
		assert.match(card, /progress: half way/);
	} finally {
		inst.cleanup();
	}

	const badQuestion = runMuster(["--repo", "/nonexistent-repo", "--agent", "x", "report", "question", "--task", "T-1", "--question-kind", "curiosity", "--text", "why?"]);
	assert.equal(badQuestion.status, 2);
	assert.match(badQuestion.stderr, /question\.kind must be one of product-rule, decision-conflict, schema-change, outward-facing, data-deletion/);

	const missingNeeds = runMuster(["--repo", "/nonexistent-repo", "--agent", "x", "report", "blocked", "--task", "T-1", "a reason"]);
	assert.equal(missingNeeds.status, 2);
	assert.match(missingNeeds.stderr, /blocked requires needs/);
});

test("control queues one verb for a lane with a card, and refuses the rest (check 5)", () => {
	const inst = tempInstall();
	try {
		inst.card("pi-test-lane", { state: "idle" });
		const unknown = runMuster(["control", "pi-test-lane", "rm-rf"], undefined, inst.env);
		assert.equal(unknown.status, 2);
		assert.match(unknown.stderr, /unknown verb rm-rf/);

		const noModel = runMuster(["control", "pi-test-lane", "set-model"], undefined, inst.env);
		assert.equal(noModel.status, 2);
		assert.match(noModel.stderr, /set-model needs a model id/);

		const noLane = runMuster(["control", "pi-ghost", "abort"], undefined, inst.env);
		assert.equal(noLane.status, 3, "a lane the bus cannot see has no card to read the verb from");

		const queued = runMuster(["control", "pi-test-lane", "abort", "--from", "cc-orchestrator"], undefined, inst.env);
		assert.equal(queued.status, 0);
		assert.match(queued.stdout, /abort queued for pi-test-lane/);
		const file = JSON.parse(readFileSync(join(inst.state, "control", "pi-test-lane.json"), "utf8"));
		assert.equal(file.operation, "abort");
		assert.equal(file.from, "cc-orchestrator");

		const model = runMuster(["control", "pi-test-lane", "set-model", "openai-codex/gpt-5.6-luna"], undefined, inst.env);
		assert.equal(model.status, 0);
		assert.equal(JSON.parse(readFileSync(join(inst.state, "control", "pi-test-lane.json"), "utf8")).params.modelId, "openai-codex/gpt-5.6-luna");

		// stop is `closeLane`: a card with no heartbeat has no reader, so nothing is queued for it
		// (a stale request would stop whichever lane next takes the name), and the stale card goes.
		inst.card("pi-test-lane", { updatedAt: Date.now() - 10 * 60_000 });
		const stop = runMuster(["control", "pi-test-lane", "stop"], undefined, inst.env);
		assert.equal(stop.status, 0, stop.stderr);
		assert.match(stop.stdout, /closed pi-test-lane/);
		assert.notEqual(JSON.parse(readFileSync(join(inst.state, "control", "pi-test-lane.json"), "utf8")).operation, "stop", "no stop request is queued for a lane that does not beat");
		assert.equal(existsSync(join(inst.state, "lanes", "pi-test-lane.json")), false, "a stopped lane leaves no card");
	} finally {
		inst.cleanup();
	}
});

test("control on a Claude lane: stop runs `claude stop <short id>` and removes the card", () => {
	const inst = tempInstall();
	try {
		inst.fakeClaude();
		inst.card("cc-test", { harness: "claude", sessionId: "15d51acb-f02a-45a9-828f-063f4faf9356" });
		const stopped = runMuster(["control", "cc-test", "stop", "--from", "orchestrator"], undefined, inst.env);
		assert.equal(stopped.status, 0, stopped.stderr);
		// The short background id, not the card's sessionId: `claude stop`
		// resolves the former and answers "No job matching" for the latter
		// (verified live 2026-10-09).
		assert.deepEqual(claudeCalls(inst.bin), ["stop 15d51acb"]);
		assert.equal(existsSync(join(inst.state, "lanes", "cc-test.json")), false, "a clean stop leaves no card");
		assert.equal(existsSync(join(inst.state, "control", "cc-test.json")), false, "nothing is queued for a lane that runs no host");

		// A CLI refusal changes nothing: the card stays and the caller sees why.
		inst.card("cc-test", { harness: "claude", sessionId: "15d51acb-f02a-45a9-828f-063f4faf9356" });
		const refused = runMuster(["control", "cc-test", "stop"], undefined, { ...inst.env, CLAUDE_FAKE_MODE: "fail-stop" });
		assert.equal(refused.status, 3);
		assert.match(refused.stderr, /couldn't confirm it was stopped/);
		assert.equal(existsSync(join(inst.state, "lanes", "cc-test.json")), true, "a refused stop keeps the card");

		// No live row: the lane is not running, so there is nothing to stop and its leftover card goes.
		const absent = runMuster(["control", "cc-test", "stop"], undefined, { ...inst.env, CLAUDE_FAKE_MODE: "no-row" });
		assert.equal(absent.status, 0, absent.stderr);
		assert.match(absent.stdout, /no live Claude session to stop/);
		assert.equal(existsSync(join(inst.state, "lanes", "cc-test.json")), false);
	} finally {
		inst.cleanup();
	}
});

test("control asks the parity table: a Claude lane refuses abort and set-model with the stated path", () => {
	const inst = tempInstall();
	try {
		inst.fakeClaude();
		inst.card("cc-test", { harness: "claude", sessionId: "15d51acb-f02a-45a9-828f-063f4faf9356" });
		const abort = runMuster(["control", "cc-test", "abort"], undefined, inst.env);
		assert.equal(abort.status, 2);
		assert.match(abort.stderr, /not available on a claude lane/);
		assert.match(abort.stderr, /no remote interrupt/);
		assert.match(abort.stderr, /instead: .*muster send/);

		const model = runMuster(["control", "cc-test", "set-model", "openai-codex/gpt-5.6-luna"], undefined, inst.env);
		assert.equal(model.status, 2);
		assert.match(model.stderr, /no verified remote model switch/);
		assert.match(model.stderr, /--resume/);
		assert.deepEqual(claudeCalls(inst.bin), [], "a refused verb runs no harness command");

		// A card that does not name a harness cannot be reached: the table says so.
		inst.card("mystery", { harness: "unknown" });
		const unknown = runMuster(["control", "mystery", "abort"], undefined, inst.env);
		assert.equal(unknown.status, 2);
		assert.match(unknown.stderr, /does not name a harness/);
	} finally {
		inst.cleanup();
	}
});

test("control stop on an OpenCode lane is closeLane, and runs no Claude CLI", () => {
	const inst = tempInstall();
	try {
		inst.fakeClaude();
		inst.card("oc-test", { harness: "opencode", updatedAt: Date.now() - 10 * 60_000 });
		const stop = runMuster(["control", "oc-test", "stop"], undefined, inst.env);
		assert.equal(stop.status, 0, stop.stderr);
		assert.match(stop.stdout, /closed oc-test/);
		assert.equal(existsSync(join(inst.state, "control", "oc-test.json")), false);
		assert.deepEqual(claudeCalls(inst.bin), []);
	} finally {
		inst.cleanup();
	}
});

test("wait --lanes answers from the cards, with no Concord and no pane text (check 4)", () => {
	const inst = tempInstall();
	try {
		inst.card("pi-test-lane", { state: "idle" });
		const result = runMuster(["wait", "--lanes", "--timeout", "1"], undefined, inst.env);
		assert.equal(result.status, 4, "nothing needs the caller");
		assert.match(result.stdout, /nothing needs you/);

		const filtered = runMuster(["wait", "--lanes", "--lane", "pi-test-lane", "--timeout", "1", "--json"], undefined, inst.env);
		assert.equal(filtered.status, 4);
		const parsed = JSON.parse(filtered.stdout);
		assert.equal(parsed.timedOut, true);
		assert.equal(parsed.events.length, 0);
	} finally {
		inst.cleanup();
	}
});

test("wait without a mailbox is refused before any connection", () => {
	const result = runMuster(["wait"]);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /no mailbox: pass --mailbox/);
});

test("inside a Claude lane the session names the lane for report, whatever CONCORD_AGENT_ID says", () => {
	const inst = tempInstall();
	try {
		// The daemon spawns every `claude --bg` session from its own env, so this lane's
		// CONCORD_AGENT_ID is the first launch's (`cc-first-launch`).
		const session = "0a1b2c3d-1111-4222-8333-444455556666";
		const claudeDir = join(inst.home, "claude");
		mkdirSync(join(claudeDir, "jobs", session.slice(0, 8)), { recursive: true });
		writeFileSync(join(claudeDir, "jobs", session.slice(0, 8), "state.json"), JSON.stringify({ name: "cc-scratch-a", sessionId: session, template: "bg" }));
		inst.card("cc-scratch-a", { harness: "claude", state: "running" });
		const env = { ...inst.env, CLAUDE_CONFIG_DIR: claudeDir, CLAUDE_CODE_SESSION_ID: session, CLAUDE_PID: String(process.pid), CONCORD_AGENT_ID: "cc-first-launch" };

		const result = runMuster(["--repo", "/nonexistent-repo", "report", "review_ready", "--summary", "all green", "--branch", "lane/x", "--sha", "abc1234"], undefined, env);
		assert.equal(result.status, 0, result.stderr);
		assert.match(readFileSync(join(inst.state, "lanes", "cc-scratch-a.json"), "utf8"), /REVIEW READY: lane\/x@abc1234/);
		assert.equal(existsSync(join(inst.state, "lanes", "cc-first-launch.json")), false, "the daemon's env lane gets no card from this session");
		const [message] = listInboxMessages(inst.state, "orchestrator");
		assert.equal(message?.from, "cc-scratch-a", "the report reaches the orchestrator inbox as this lane's");
		assert.match(message?.text ?? "", /REVIEW READY: lane\/x@abc1234/);
		// The report command also appends the event line to the shared file (plan
		// section 1), so the file-based waiter sees a Claude lane's review.
		const events = readFileSync(join(inst.state, "..", "orchestrator-events.log"), "utf8");
		assert.match(events, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2} REVIEW READY: cc-scratch-a lane\/x@abc1234 \| all green$/m);

		// Not this process's session (CLAUDE_PID is no ancestor): the env identity stands, as for a Pi lane.
		runMuster(["--repo", "/nonexistent-repo", "report", "working", "stale vars"], undefined, { ...env, CLAUDE_PID: "2000000000" });
		assert.doesNotMatch(readFileSync(join(inst.state, "lanes", "cc-scratch-a.json"), "utf8"), /stale vars/, "a session that is not this process's does not speak for the lane");
	} finally {
		inst.cleanup();
	}
});

test("report accepts a full JSON report object on stdin", () => {
	const result = runMuster(
		["--repo", "/nonexistent-repo", "--agent", "x", "report", "--task", "T-1", "--stdin"],
		JSON.stringify({ kind: "working", summary: "still going" }),
	);
	assert.match(result.stderr, /Concord (is not reachable|refused)/);
	assert.notEqual(result.status, 2, "the report validated; only the workspace is missing");
});

test("lanes --json prints the lane directory from PI_MUSTER_STATE_DIR", () => {
	const fx = tempInstall();
	try {
		const now = Date.now();
		fx.card("pi-core", { state: "running", model: "command-code/x", branch: "harness-bus-a3", updatedAt: now });
		fx.card("stalled-one", { state: "stalled", updatedAt: now });
		// No heartbeat for ten minutes: the reader concludes gone (F3).
		fx.card("crashed", { state: "running", updatedAt: now - 10 * 60_000 });
		const result = runMuster(["--json", "lanes"], undefined, fx.env);
		assert.equal(result.status, 0, result.stderr);
		const cards = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
		const byId = new Map(cards.map((card) => [card["laneId"], card]));
		assert.equal(byId.get("pi-core")!["state"], "running");
		assert.equal(byId.get("pi-core")!["authoritative"], true);
		assert.equal(byId.get("pi-core")!["branch"], "harness-bus-a3");
		assert.equal(byId.get("stalled-one")!["state"], "stalled");
		assert.equal(byId.get("crashed")!["state"], "gone");
	} finally {
		fx.cleanup();
	}
});

test("lanes --stalled and --lane narrow the rows a watcher gets", () => {
	const fx = tempInstall();
	try {
		fx.card("pi-core", { state: "running" });
		fx.card("stalled-one", { state: "stalled" });
		const stalled = runMuster(["--json", "lanes", "--stalled"], undefined, fx.env);
		assert.equal(stalled.status, 0, stalled.stderr);
		const rows = JSON.parse(stalled.stdout) as Array<Record<string, unknown>>;
		assert.deepEqual(rows.map((row) => row["laneId"]), ["stalled-one"]);

		const one = runMuster(["--json", "lanes", "--lane", "pi-core"], undefined, fx.env);
		assert.equal(one.status, 0, one.stderr);
		assert.deepEqual((JSON.parse(one.stdout) as Array<Record<string, unknown>>).map((row) => row["laneId"]), ["pi-core"]);

		const missing = runMuster(["lanes", "--lane", "nobody"], undefined, fx.env);
		assert.equal(missing.status, 3);
		assert.match(missing.stderr, /no lane nobody/);
	} finally {
		fx.cleanup();
	}
});

test("lanes refuses an unknown option and reports an empty directory as nothing found", () => {
	const fx = tempInstall();
	try {
		const bad = runMuster(["lanes", "--hurry"], undefined, fx.env);
		assert.equal(bad.status, 2);
		assert.match(bad.stderr, /unknown option --hurry/);

		// An empty directory is not an error for a watcher: valid JSON, exit 3.
		const empty = runMuster(["--json", "lanes"], undefined, fx.env);
		assert.equal(empty.status, 3);
		assert.equal(empty.stdout.trim(), "[]");
		assert.match(empty.stderr, /the directory sees 0 lanes/);
	} finally {
		fx.cleanup();
	}
});

test("muster wait --inbox returns the first message, moves it into read/, and exits 4 when nothing is pending", () => {
	const install = tempInstall();
	try {
		writeInboxMessage(install.state, { agent: "orchestrator", from: "pi-core", at: new Date().toISOString(), text: "REVIEW READY: harness-bus-inbox@abc", idempotencyKey: "k1", source: "send" });
		const first = runMuster(["wait", "--inbox", "orchestrator", "--timeout", "5"], undefined, install.env);
		assert.equal(first.status, 0, first.stderr);
		assert.match(first.stdout, /orchestrator inbox: pi-core -> REVIEW READY: harness-bus-inbox@abc/);
		assert.equal(listInboxMessages(install.state, "orchestrator").length, 0, "the pending inbox is empty after the wait");
		assert.equal(readdirSync(agentInboxReadDir(install.state, "orchestrator")).length, 1, "the message is kept under read/");
		const second = runMuster(["wait", "--inbox", "orchestrator", "--timeout", "1"], undefined, install.env);
		assert.equal(second.status, 4, "nothing pending is a timeout, not a delivery");
		assert.match(second.stdout, /nothing in orchestrator's inbox/);
	} finally {
		install.cleanup();
	}
});

test("muster lanes --inbox counts pending messages and the table view summarises them", () => {
	const install = tempInstall();
	try {
		install.card("pi-core", {});
		writeInboxMessage(install.state, { agent: "orchestrator", from: "pi-core", at: "2026-10-08T04:00:00.000Z", text: "one", idempotencyKey: "k1" });
		writeInboxMessage(install.state, { agent: "orchestrator", from: "pi-core", at: "2026-10-08T04:00:01.000Z", text: "two", idempotencyKey: "k2" });
		const json = runMuster(["lanes", "--inbox", "--json"], undefined, install.env);
		assert.equal(json.status, 0, json.stderr);
		assert.deepEqual(JSON.parse(json.stdout), [{ agent: "orchestrator", pending: 2 }]);
		const table = runMuster(["lanes"], undefined, install.env);
		assert.equal(table.status, 0, table.stderr);
		assert.match(table.stdout, /inbox: orchestrator 2 pending/);
		const empty = runMuster(["lanes", "--inbox"], undefined, { ...install.env, PI_MUSTER_STATE_DIR: join(install.state, "nowhere") });
		assert.equal(empty.status, 0);
		assert.match(empty.stdout, /inbox: no pending messages/);
	} finally {
		install.cleanup();
	}
});
