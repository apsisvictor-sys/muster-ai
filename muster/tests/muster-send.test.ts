/**
 * `muster send` tests — A3 of the harness bus design, section 4.3 delivery.
 *
 * Concord first, pane fallback only when Concord cannot deliver, and every
 * attempt appended to the send log.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSendLog, awaitLaneArrival, deliverLaneMessage, formatSendOutcome, herdrPaneDelivery, SEND_LOG_FILE, tmuxPaneDelivery, tmuxSessionForHarness, type ArrivalProof, type SendLogRecord } from "../send.ts";

function collector(): { records: SendLogRecord[]; log: (record: SendLogRecord) => void } {
	const records: SendLogRecord[] = [];
	return { records, log: (record) => { records.push(record); } };
}

test("Concord carries the message and the log names the transport", async () => {
	const { records, log } = collector();
	const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	const outcome = await deliverLaneMessage(
		{ laneId: "pi-core", mode: "followup", text: "brief" },
		{
			concord: {
				callTool: async (name, args) => {
					calls.push({ name, args });
					return { structuredContent: { message_id: "msg_1", status: "delivered" } };
				},
			},
			pane: async () => ({ ok: true, command: "unused" }),
			log,
		},
	);
	assert.deepEqual(outcome, { transport: "concord", messageId: "msg_1", status: "delivered" });
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.name, "update_work");
	assert.equal(calls[0]!.args["operation"], "prompt");
	assert.equal(calls[0]!.args["to_agent_id"], "pi-core");
	assert.equal(calls[0]!.args["content"], "brief");
	assert.equal(typeof calls[0]!.args["idempotency_key"], "string");
	assert.equal("delivery_mode" in calls[0]!.args, false, "followup is not a Concord v1 steer");
	assert.equal(records.length, 1);
	assert.equal(records[0]!.transport, "concord");
	assert.equal(records[0]!.messageId, "msg_1");
});

test("steer carries delivery_mode steer", async () => {
	let seen: Record<string, unknown> | undefined;
	await deliverLaneMessage(
		{ laneId: "pi-core", mode: "steer", text: "correction" },
		{
			concord: { callTool: async (_name, args) => { seen = args; return { structuredContent: { message_id: "m", status: "delivered" } }; } },
			pane: async () => ({ ok: true, command: "unused" }),
			log: () => undefined,
		},
	);
	assert.equal(seen?.["delivery_mode"], "steer");
});

test("Concord failure falls back to the pane and logs the reason", async () => {
	const { records, log } = collector();
	const panes: Array<{ laneId: string; text: string }> = [];
	const outcome = await deliverLaneMessage(
		{ laneId: "oc-1", mode: "followup", text: "brief", taskId: "T-3" },
		{
			concord: { callTool: async () => { throw new Error("muster: update_work failed: recipient has no live endpoint"); } },
			pane: async (request) => {
				panes.push(request);
				return { ok: true, command: "herdr agent prompt oc-1 <text>" };
			},
			log,
		},
	);
	assert.equal(outcome.transport, "pane");
	if (outcome.transport === "pane") {
		assert.match(outcome.fallbackReason, /no live endpoint/);
		assert.equal(outcome.command, "herdr agent prompt oc-1 <text>");
	}
	assert.deepEqual(panes, [{ laneId: "oc-1", text: "brief" }]);
	assert.equal(records.length, 1);
	assert.equal(records[0]!.transport, "pane");
	assert.equal(records[0]!.taskId, "T-3");
	assert.match(String(records[0]!.reason), /no live endpoint/);
	assert.equal(formatSendOutcome(outcome, { laneId: "oc-1", mode: "followup", text: "brief" }), "muster send: delivered to oc-1 by pane fallback (herdr agent prompt oc-1 <text>); Concord could not carry it: muster: update_work failed: recipient has no live endpoint");
});

test("no Concord connection at all still reaches the pane", async () => {
	const { records, log } = collector();
	const outcome = await deliverLaneMessage(
		{ laneId: "lane", mode: "wake", text: "wake up" },
		{
			concord: undefined,
			pane: async () => ({ ok: true, command: "herdr agent prompt lane <text>" }),
			log,
		},
	);
	assert.equal(outcome.transport, "pane");
	assert.equal(records[0]!.reason, "no Concord connection for this repository");
});

test("both transports failing is 'none' and names both reasons", async () => {
	const { records, log } = collector();
	const outcome = await deliverLaneMessage(
		{ laneId: "lane", mode: "followup", text: "brief" },
		{
			concord: { callTool: async () => { throw new Error("no endpoint"); } },
			pane: async () => ({ ok: false, command: "herdr agent prompt lane <text>", exitCode: 1, detail: "no such agent" }),
			log,
		},
	);
	assert.equal(outcome.transport, "none");
	if (outcome.transport === "none") {
		assert.match(outcome.error, /Concord could not deliver/);
		assert.match(outcome.error, /no such agent/);
	}
	assert.match(formatSendOutcome(outcome, { laneId: "lane", mode: "followup", text: "brief" }), /not delivered/);
	assert.equal(records[0]!.error, "no such agent");
});

test("a Concord result without a message id is not a success", async () => {
	const { records, log } = collector();
	const outcome = await deliverLaneMessage(
		{ laneId: "lane", mode: "followup", text: "brief" },
		{
			concord: { callTool: async () => ({ structuredContent: { status: "pending" } }) },
			pane: async () => ({ ok: true, command: "herdr agent prompt lane <text>" }),
			log,
		},
	);
	assert.equal(outcome.transport, "pane");
	if (outcome.transport === "pane") assert.match(outcome.fallbackReason, /no message id/);
	assert.equal(records[0]!.reason !== undefined && /no message id/.test(records[0]!.reason), true);
});

test("an explicit idempotency key is kept; the default is one per attempt", async () => {
	const keys: string[] = [];
	const deps = {
		concord: { callTool: async (_name: string, args: Record<string, unknown>) => { keys.push(String(args["idempotency_key"])); return { structuredContent: { message_id: "m", status: "delivered" } }; } },
		pane: async () => ({ ok: true, command: "unused" }),
		log: () => undefined,
	};
	await deliverLaneMessage({ laneId: "l", mode: "followup", text: "x", idempotencyKey: "attempt-7" }, deps);
	await deliverLaneMessage({ laneId: "l", mode: "followup", text: "x" }, deps);
	await deliverLaneMessage({ laneId: "l", mode: "followup", text: "x" }, deps);
	assert.equal(keys[0], "attempt-7");
	assert.notEqual(keys[1], keys[2]);
	assert.match(keys[1]!, /^muster-send\/l\//);
});

test("the send log is an fsynced 0600 JSONL file", () => {
	const dir = mkdtempSync(join(tmpdir(), "send-log-test-"));
	const stateDir = join(dir, "state");
	try {
		appendSendLog(stateDir, { at: "2026-10-07T00:00:00.000Z", laneId: "l", mode: "steer", transport: "concord", idempotencyKey: "k", messageId: "m" });
		appendSendLog(stateDir, { at: "2026-10-07T00:00:01.000Z", laneId: "l", mode: "steer", transport: "pane", idempotencyKey: "k", reason: "r", command: "c" });
		const lines = readFileSync(join(stateDir, SEND_LOG_FILE), "utf8").trim().split("\n");
		assert.equal(lines.length, 2);
		assert.equal(JSON.parse(lines[0]!).transport, "concord");
		assert.equal(JSON.parse(lines[1]!).command, "c");
		assert.equal(statSync(stateDir).mode & 0o777, 0o700);
		assert.equal(statSync(join(stateDir, SEND_LOG_FILE)).mode & 0o777, 0o600);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the pane delivery names Herdr's prompt command and passes the text as one argument", async () => {
	const seen: Array<{ command: string; args: string[] }> = [];
	const pane = herdrPaneDelivery({
		bin: "herdr",
		spawn: async (command, args) => {
			seen.push({ command, args });
			return { exitCode: 0, stdout: "", stderr: "" };
		},
	});
	const result = await pane({ laneId: "pi-core", text: "two\nwords" });
	assert.equal(result.ok, true);
	assert.deepEqual(seen, [{ command: "herdr", args: ["agent", "prompt", "pi-core", "two\nwords"] }]);
});

test("the tmux fallback types one line into the lane's window and presses Enter", async () => {
	const seen: string[][] = [];
	const pane = tmuxPaneDelivery({
		session: "pi",
		spawn: async (_command, args) => {
			seen.push(args);
			if (args[0] === "list-panes") return { exitCode: 0, stdout: "%7\n", stderr: "" };
			return { exitCode: 0, stdout: "", stderr: "" };
		},
	});
	const result = await pane({ laneId: "pi-be-g3", text: "one\ntwo words" });
	assert.equal(result.ok, true);
	assert.match(result.command, /tmux send-keys -t pi:pi-be-g3/);
	assert.deepEqual(seen, [
		["list-panes", "-t", "pi:pi-be-g3", "-F", "#{pane_id}"],
		["send-keys", "-t", "pi:pi-be-g3", "-l", "--", "one two words"],
		["send-keys", "-t", "pi:pi-be-g3", "Enter"],
	]);
});

test("the tmux fallback refuses a window that does not exist", async () => {
	const pane = tmuxPaneDelivery({
		session: "pi",
		spawn: async () => ({ exitCode: 1, stdout: "", stderr: "can't find window" }),
	});
	const result = await pane({ laneId: "pi-ghost", text: "hello" });
	assert.equal(result.ok, false);
	assert.match(result.detail ?? "", /no tmux window pi:pi-ghost/);
});

test("the tmux fallback refuses to type into the caller's own pane", async () => {
	const previous = process.env.TMUX_PANE;
	process.env.TMUX_PANE = "%9";
	try {
		const pane = tmuxPaneDelivery({
			session: "pi",
			spawn: async () => ({ exitCode: 0, stdout: "%9\n", stderr: "" }),
		});
		const result = await pane({ laneId: "pi-core", text: "hello" });
		assert.equal(result.ok, false);
		assert.match(result.detail ?? "", /caller's own pane/);
	} finally {
		if (previous === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = previous;
	}
});

test("an enrolled lane whose Concord endpoint is not published yet is retried, then delivered by Concord", async () => {
	const { records, log } = collector();
	const sleeps: number[] = [];
	let calls = 0;
	const outcome = await deliverLaneMessage(
		{ laneId: "pi-be-g4", mode: "followup", text: "brief" },
		{
			// The enrolment race: the lane has a card, but Concord has not seen its
			// endpoint yet (the first live sends fell through to the pane this way).
			concord: {
				callTool: async () => {
					calls += 1;
					if (calls === 1) throw new Error("muster: update_work failed: Workspace: ws_x (/home/operator/.pi/agent) Agent pi-be-g4 is not registered in this workspace.");
					return { structuredContent: { message_id: "m-1", status: "pending" } };
				},
			},
			recipientEnrolled: () => true,
			sleep: async (ms) => { sleeps.push(ms); },
			pane: async () => ({ ok: true, command: "tmux send-keys" }),
			log,
		},
	);
	assert.equal(outcome.transport, "concord");
	assert.equal(calls, 2);
	assert.deepEqual(sleeps, [2000]);
	assert.equal(records.length, 1);
	assert.equal(records[0]!.attempts, 2);
	assert.equal(records[0]!.transport, "concord");
});

test("a lane that is not enrolled is tried once, and an enrolled one gives up after the bounded retries", async () => {
	const { records, log } = collector();
	const sleeps: number[] = [];
	let calls = 0;
	const unregistered = await deliverLaneMessage(
		{ laneId: "ghost", mode: "followup", text: "brief" },
		{
			concord: { callTool: async () => { calls += 1; throw new Error("Agent ghost is not registered in this workspace"); } },
			recipientEnrolled: () => false,
			sleep: async (ms) => { sleeps.push(ms); },
			pane: async () => ({ ok: true, command: "tmux send-keys" }),
			log,
		},
	);
	assert.equal(unregistered.transport, "pane");
	assert.equal(calls, 1, "a lane with no card is not the enrolment race");
	assert.deepEqual(sleeps, []);

	calls = 0;
	const exhausted = await deliverLaneMessage(
		{ laneId: "pi-be-g4", mode: "followup", text: "brief" },
		{
			concord: { callTool: async () => { calls += 1; throw new Error("Agent pi-be-g4 is not registered in this workspace"); } },
			recipientEnrolled: () => true,
			sleep: async (ms) => { sleeps.push(ms); },
			pane: async () => ({ ok: true, command: "tmux send-keys" }),
			log,
		},
	);
	assert.equal(exhausted.transport, "pane");
	assert.equal(calls, 4, "the retry budget is bounded");
	assert.equal(sleeps.length, 3, "and it sleeps only between attempts");
	if (exhausted.transport === "pane") {
		assert.match(exhausted.fallbackReason, /after 4 Concord attempts/);
		assert.match(exhausted.fallbackReason, /endpoint was not published/);
	}
});

test("an agent with no Concord prompt endpoint gets the message in its inbox, not the pane", async () => {
	const { records, log } = collector();
	let paneCalls = 0;
	const inboxed: Array<Record<string, unknown>> = [];
	const outcome = await deliverLaneMessage(
		{ laneId: "orchestrator", mode: "followup", text: "REVIEW READY: harness-bus-o1@c76dcf4", idempotencyKey: "key-9" },
		{
			concord: { callTool: async () => { throw new Error("muster: update_work failed: Workspace: ws_x\nAgent orchestrator has no prompt endpoint."); } },
			inbox: async (message) => {
				inboxed.push(message as unknown as Record<string, unknown>);
				return { ok: true, path: "/state/muster/inbox/orchestrator/1750-abc.json" };
			},
			pane: async () => { paneCalls += 1; return { ok: true, command: "tmux send-keys" }; },
			log,
		},
	);
	assert.equal(outcome.transport, "inbox");
	assert.equal(paneCalls, 0, "the pane is not a transport for an agent that has no window");
	assert.equal(inboxed.length, 1);
	assert.equal(inboxed[0]!["laneId"], "orchestrator");
	assert.equal(inboxed[0]!["idempotencyKey"], "key-9");
	assert.equal(inboxed[0]!["mode"], "followup");
	assert.equal(records.length, 1);
	assert.equal(records[0]!.transport, "inbox");
	assert.equal(records[0]!.path, "/state/muster/inbox/orchestrator/1750-abc.json");
	assert.match(String(records[0]!.reason), /no prompt endpoint/);
	assert.match(formatSendOutcome(outcome, { laneId: "orchestrator", mode: "followup", text: "x" }), /by inbox \(.*orchestrator\/1750-abc\.json\)/);
});

test("a Claude Code lane is not sent through Concord at all: the inbox carries it and says how it reads it", async () => {
	const { records, log } = collector();
	let concordCalls = 0;
	let paneCalls = 0;
	const inboxed: Array<Record<string, unknown>> = [];
	const outcome = await deliverLaneMessage(
		{ laneId: "cc-voice", mode: "steer", text: "please rebase", idempotencyKey: "key-cc" },
		{
			concord: { callTool: async () => { concordCalls += 1; throw new Error("Agent cc-voice is not registered in this workspace"); } },
			endpointless: (laneId) => (laneId === "cc-voice" ? "`muster wait --inbox cc-voice`" : undefined),
			recipientEnrolled: () => true,
			inbox: async (message) => { inboxed.push(message as unknown as Record<string, unknown>); return { ok: true, path: "/state/muster/inbox/cc-voice/1-a.json" }; },
			pane: async () => { paneCalls += 1; return { ok: true, command: "tmux send-keys" }; },
			log,
		},
	);
	assert.equal(outcome.transport, "inbox");
	assert.equal(concordCalls, 0, "no Concord attempt and no enrolment retries");
	assert.equal(paneCalls, 0, "a background session has no pane");
	assert.equal(inboxed.length, 1);
	assert.match(formatSendOutcome(outcome, { laneId: "cc-voice", mode: "steer", text: "x" }), /muster wait --inbox cc-voice/);
});

test("a Claude lane whose process is gone is asleep: the message goes to its inbox, nothing is resumed (LD16)", async () => {
	const { records, log } = collector();
	const inboxed: unknown[] = [];
	const outcome = await deliverLaneMessage(
		{ laneId: "cc-voice", mode: "followup", text: "use option B" },
		{
			concord: { callTool: async () => { throw new Error("Concord must not be asked"); } },
			endpointless: () => "`muster wait --inbox cc-voice`",
			inboxState: () => ({ state: "asleep", why: "its process is gone" }),
			inbox: async (message) => { inboxed.push(message); return { ok: true, path: "/state/inbox/1.json" }; },
			pane: async () => ({ ok: false, command: "none" }),
			log,
		},
	);
	assert.equal(outcome.transport, "inbox");
	assert.equal((outcome as { queued?: string }).queued, "asleep");
	assert.equal(inboxed.length, 1);
	assert.equal(records[0]?.transport, "inbox");
	const text = formatSendOutcome(outcome, { laneId: "cc-voice", mode: "followup", text: "x" });
	assert.match(text, /cc-voice is asleep \(its process is gone\)\. The message waits in its inbox and is read when the session is next opened\. To wake a worker lane now: `muster resume cc-voice`/);
});

test("a live idle Claude lane is queued for its waiter and never resumed; with no waiter armed the outcome says so", async () => {
	for (const [waiter, queued, text] of [
		[true, "waiter", /queued for cc-voice \(inbox; the lane's waiter wakes it\)/],
		[false, "no-waiter", /queued for cc-voice \(inbox; no waiter is armed/],
	] as const) {
		const { records, log } = collector();
		const inboxed: unknown[] = [];
		const outcome = await deliverLaneMessage(
			{ laneId: "cc-voice", mode: "followup", text: "hello" },
			{
				concord: undefined,
				endpointless: () => "`muster wait --inbox cc-voice`",
				inboxState: () => ({ state: "live", waiter }),
				inbox: async (message) => { inboxed.push(message); return { ok: true, path: "/state/inbox/1.json" }; },
				pane: async () => ({ ok: false, command: "none" }),
				log,
			},
		);
		assert.equal(outcome.transport, "inbox", "never `resume` for a live lane");
		assert.equal((outcome as { queued?: string }).queued, queued);
		assert.equal(inboxed.length, 1);
		assert.equal(records[0]?.transport, "inbox");
		assert.match(formatSendOutcome(outcome, { laneId: "cc-voice", mode: "followup", text: "x" }), text);
	}
});

test("a Claude lane whose state cannot be read still gets the inbox, and the outcome claims nothing about its process", async () => {
	for (const inboxState of [(): undefined => undefined, (): never => { throw new Error("claude agents timed out"); }]) {
		const { log } = collector();
		const inboxed: unknown[] = [];
		const outcome = await deliverLaneMessage(
			{ laneId: "cc-voice", mode: "followup", text: "hello" },
			{
				concord: undefined,
				endpointless: () => "`muster wait --inbox cc-voice`",
				inboxState,
				inbox: async (message) => { inboxed.push(message); return { ok: true, path: "/state/inbox/1.json" }; },
				pane: async () => ({ ok: false, command: "none" }),
				log,
			},
		);
		assert.equal(outcome.transport, "inbox");
		assert.equal((outcome as { queued?: string }).queued, undefined);
		assert.equal(inboxed.length, 1);
	}
});

test("a parked Claude session answers inbox-only: the inbox carries the message, Concord and the pane are not asked, and the outcome says parked", async () => {
	const { records, log } = collector();
	const inboxed: unknown[] = [];
	let concordCalls = 0;
	let paneCalls = 0;
	const outcome = await deliverLaneMessage(
		{ laneId: "cc-voice", mode: "followup", text: "next step" },
		{
			concord: { callTool: async () => { concordCalls += 1; throw new Error("Concord must not be asked"); } },
			// A parked lane's card is gone, so nothing else names it a Claude lane.
			endpointless: () => undefined,
			resumeParked: async () => ({ state: "inbox-only", why: "its process was stopped on purpose" }),
			inboxState: () => { throw new Error("a parked session is not read from claude agents"); },
			inbox: async (message) => { inboxed.push(message); return { ok: true, path: "/state/inbox/1.json" }; },
			pane: async () => { paneCalls += 1; return { ok: true, command: "never" }; },
			log,
		},
	);
	assert.equal(outcome.transport, "inbox");
	assert.equal((outcome as { queued?: string }).queued, "asleep");
	assert.equal(inboxed.length, 1);
	assert.equal(concordCalls + paneCalls, 0);
	assert.equal(records[0]?.transport, "inbox");
	assert.match(formatSendOutcome(outcome, { laneId: "cc-voice", mode: "followup", text: "x" }), /asleep \(it is parked: its process was stopped on purpose\)/);
});

test("a Concord refusal that is not about a prompt endpoint still goes to the pane", async () => {
	const { records, log } = collector();
	let inboxCalls = 0;
	let paneCalls = 0;
	const outcome = await deliverLaneMessage(
		{ laneId: "pi-be-g4", mode: "followup", text: "brief" },
		{
			concord: { callTool: async () => { throw new Error("Agent pi-be-g4 is not registered in this workspace"); } },
			inbox: async () => { inboxCalls += 1; return { ok: true, path: "/never" }; },
			pane: async () => { paneCalls += 1; return { ok: true, command: "herdr agent prompt pi-be-g4" }; },
			log,
		},
	);
	assert.equal(outcome.transport, "pane");
	assert.equal(inboxCalls, 0, "the enrolment race is a lane that will publish an endpoint: the pane carries it");
	assert.equal(paneCalls, 1);
	assert.equal(records[0]!.transport, "pane");
});

test("with no inbox transport a no-prompt-endpoint refusal falls through to the pane exactly as before", async () => {
	const { records, log } = collector();
	let paneCalls = 0;
	const outcome = await deliverLaneMessage(
		{ laneId: "salon", mode: "followup", text: "hello" },
		{
			concord: { callTool: async () => { throw new Error("Agent salon has no prompt endpoint."); } },
			pane: async () => { paneCalls += 1; return { ok: true, command: "tmux send-keys -t pi:salon" }; },
			log,
		},
	);
	assert.equal(outcome.transport, "pane");
	assert.equal(paneCalls, 1);
	assert.equal(records[0]!.transport, "pane");
});

test("when the inbox itself cannot be written the pane still gets its chance", async () => {
	const { records, log } = collector();
	let paneCalls = 0;
	const outcome = await deliverLaneMessage(
		{ laneId: "orchestrator", mode: "followup", text: "hello" },
		{
			concord: { callTool: async () => { throw new Error("Agent orchestrator has no prompt endpoint."); } },
			inbox: async () => ({ ok: false, error: "EACCES: permission denied" }),
			pane: async () => { paneCalls += 1; return { ok: false, command: "tmux send-keys", detail: "no tmux window pi:orchestrator" }; },
			log,
		},
	);
	assert.equal(outcome.transport, "none");
	assert.equal(paneCalls, 1);
	assert.match(outcome.transport === "none" ? outcome.error : "", /inbox could not be written \(EACCES/);
	assert.equal(records[0]!.transport, "pane");
});

// ─── Arrival: Concord's "delivered" is not the lane taking the message ───────

/** A fake clock whose sleep advances it, so a 60 s wait costs nothing. */
function fakeClock(start = 1_000_000) {
	let t = start;
	return { now: () => t, sleep: async (ms: number) => { t += ms; }, set: (value: number) => { t = value; } };
}

test("arrival is confirmed by the first card written after acceptance that holds nothing", async () => {
	const clock = fakeClock();
	const cards = [
		{ updatedAt: 1_000_500, pendingIn: 0, state: "running" }, // before the settle window: proves nothing
		{ updatedAt: 1_005_000, pendingIn: 1, state: "idle" }, // enqueued, about to be taken (an idle lane is waited for)
		{ updatedAt: 1_020_000, pendingIn: 0, state: "running" }, // taken
	];
	let reads = 0;
	const proof = await awaitLaneArrival({ laneId: "pi-core", acceptedAt: 1_000_000, now: clock.now, sleep: async (ms) => { await clock.sleep(ms); }, readCard: () => cards[Math.min(reads++, cards.length - 1)] });
	assert.deepEqual(proof, { state: "confirmed" });
});

test("a busy lane that holds the message is queued at once, and an idle one is waited for before it is called queued", async () => {
	const clock = fakeClock();
	const busy = await awaitLaneArrival({ laneId: "pi-core", acceptedAt: 1_000_000, now: clock.now, sleep: clock.sleep, timeoutMs: 60_000, readCard: () => ({ updatedAt: 1_005_000, pendingIn: 2, state: "running" }) });
	assert.equal(busy.state, "queued");
	assert.match((busy as { detail: string }).detail, /holds 2 message/);
	assert.ok(clock.now() < 1_010_000, "no 60 s wait for a lane that is in a turn");
	const idle = await awaitLaneArrival({ laneId: "pi-core", acceptedAt: 1_000_000, now: clock.now, sleep: clock.sleep, timeoutMs: 60_000, readCard: () => ({ updatedAt: clock.now(), pendingIn: 1, state: "idle" }) });
	assert.equal(idle.state, "queued");
	assert.ok(clock.now() >= 1_060_000, "an idle lane holding a message gets the full wait");
});

test("a lane that stopped writing its card is held, and one without a pending count is unverifiable", async () => {
	const clock = fakeClock();
	const stale = await awaitLaneArrival({ laneId: "pi-core", acceptedAt: 1_000_000, now: clock.now, sleep: clock.sleep, readCard: () => ({ updatedAt: 900_000, pendingIn: 0, state: "idle" }) });
	assert.equal(stale.state, "held");
	assert.match((stale as { detail: string }).detail, /no card after/);
	assert.deepEqual(await awaitLaneArrival({ laneId: "x", acceptedAt: 1_000_000, now: clock.now, sleep: clock.sleep, readCard: () => ({ updatedAt: 1_010_000, state: "idle" }) }), { state: "unverifiable" });
	assert.deepEqual(await awaitLaneArrival({ laneId: "x", acceptedAt: 1_000_000, now: clock.now, sleep: clock.sleep, readCard: () => undefined }), { state: "unverifiable" });
	// A gone lane is not waited for.
	const before = clock.now();
	const gone = await awaitLaneArrival({ laneId: "x", acceptedAt: before, now: clock.now, sleep: clock.sleep, readCard: () => ({ updatedAt: before + 9_000, pendingIn: 1, state: "gone" }) });
	assert.equal(gone.state, "held");
	assert.equal(clock.now(), before, "no waiting on a lane that is gone");
});

test("a message Concord accepted for a lane that stopped beating goes to the pane, and the log says both", async () => {
	const { records, log } = collector();
	const panes: string[] = [];
	const outcome = await deliverLaneMessage(
		{ laneId: "pi-core", mode: "followup", text: "brief" },
		{
			concord: { callTool: async () => ({ structuredContent: { message_id: "msg_9", status: "pending" } }) },
			pane: async (request) => { panes.push(request.text); return { ok: true, command: "tmux send-keys -t pi:pi-core <text> Enter" }; },
			log,
			confirmArrival: async (): Promise<ArrivalProof> => ({ state: "held", detail: "the lane wrote no card after the message was accepted" }),
		},
	);
	assert.equal(outcome.transport, "pane");
	if (outcome.transport === "pane") {
		assert.equal(outcome.concordMessageId, "msg_9");
		assert.match(outcome.fallbackReason, /Concord accepted msg_9 but the lane wrote no card/);
		assert.match(formatSendOutcome(outcome, { laneId: "pi-core", mode: "followup", text: "brief" }), /Concord also has it queued/);
	}
	assert.deepEqual(panes, ["brief"]);
	assert.deepEqual(records.map((record) => record.transport), ["concord", "pane"]);
	assert.equal(records[1]!.messageId, "msg_9");
});

test("a queued arrival stays on Concord: one delivery per message id, nothing typed into the pane", async () => {
	const { records, log } = collector();
	const outcome = await deliverLaneMessage(
		{ laneId: "pi-recall", mode: "followup", text: "brief" },
		{
			concord: { callTool: async () => ({ structuredContent: { message_id: "msg_q", status: "pending" } }) },
			pane: async () => { throw new Error("must not be typed"); },
			log,
			confirmArrival: async (): Promise<ArrivalProof> => ({ state: "queued", detail: "the lane holds 1 message(s) (state running) and reads them when it is free" }),
		},
	);
	assert.equal(outcome.transport, "concord");
	if (outcome.transport === "concord") {
		assert.equal(outcome.arrival, "queued");
		assert.match(formatSendOutcome(outcome, { laneId: "pi-recall", mode: "followup", text: "brief" }), /queued: the lane holds 1 message/);
	}
	assert.deepEqual(records.map((record) => record.transport), ["concord"]);
});

test("a confirmed or unverifiable arrival stays on Concord, and a pane that fails too is named", async () => {
	for (const state of ["confirmed", "unverifiable"] as const) {
		const outcome = await deliverLaneMessage(
			{ laneId: "pi-core", mode: "followup", text: "brief" },
			{
				concord: { callTool: async () => ({ structuredContent: { message_id: "m", status: "delivered" } }) },
				pane: async () => { throw new Error("must not be typed"); },
				log: () => undefined,
				confirmArrival: async (): Promise<ArrivalProof> => ({ state }),
			},
		);
		assert.deepEqual(outcome, { transport: "concord", messageId: "m", status: "delivered", arrival: state });
	}
	const held = await deliverLaneMessage(
		{ laneId: "pi-core", mode: "followup", text: "brief" },
		{
			concord: { callTool: async () => ({ structuredContent: { message_id: "m", status: "pending" } }) },
			pane: async () => ({ ok: false, command: "tmux", detail: "no tmux window pi:pi-core" }),
			log: () => undefined,
			confirmArrival: async (): Promise<ArrivalProof> => ({ state: "held", detail: "x" }),
		},
	);
	assert.equal(held.transport, "concord");
	if (held.transport === "concord") {
		assert.equal(held.arrival, "held");
		assert.match(formatSendOutcome(held, { laneId: "pi-core", mode: "followup", text: "brief" }), /NOT taken/);
	}
});

test("the pane for an OpenCode lane is its window in the oc session", () => {
	assert.equal(tmuxSessionForHarness("opencode"), "oc");
	assert.equal(tmuxSessionForHarness("pi"), undefined, "Pi keeps the default session");
});
