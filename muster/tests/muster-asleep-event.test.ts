import "./muster-test-isolation.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeJob } from "../lib/claude-lane-card.ts";
import type { ClaudeLaneRow } from "../lib/lane-directory.ts";
import { listInboxMessages } from "../lib/agent-inbox.ts";
import { writeLaneCard } from "../lib/lane-card.ts";
import { ASLEEP_REPEAT_MS, asleepRaisedFile } from "../asleep-event.ts";
import { formatEventLine, orchestratorEventsPath } from "../lane-report.ts";
import { recordLaunch, readLaneRecord, writeLaneRecord } from "../lane-lifecycle.ts";
import { claimSeat, writeSeatTicket } from "../seats.ts";
import { deliverLaneMessage, type SendRequest } from "../send.ts";
import { laneHoldsSeat, laneSendDeps, type LaneSendPorts } from "../send-deps.ts";

const SESSION = "7a1b2c3d-1111-4222-8333-444455556666";
const row = (pid: number | null, name = "cc-w"): ClaudeLaneRow => ({ id: "7a1b2c3d", sessionId: SESSION, cwd: "/work/w", name, kind: "background", state: "done", startedAt: 3_000, pid } as unknown as ClaudeLaneRow);
const job: ClaudeJob = { sessionId: SESSION, name: "cc-w", template: "bg", cwd: "/work/w", respawnFlags: [] } as unknown as ClaudeJob;
const T0 = Date.parse("2026-10-12T09:00:00+03:00");

type World = { root: string; stateDir: string; eventsFile: string; events: () => string[]; at: { ms: number }; ports: (extra?: Partial<LaneSendPorts>) => LaneSendPorts; send: (extra?: Partial<LaneSendPorts>, from?: string, lane?: string) => Promise<Awaited<ReturnType<typeof deliverLaneMessage>>> };

function world(run: (w: World) => Promise<void> | void, options: { pid?: number | null; kind?: "conversation"; lane?: string } = {}): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "muster-asleep-"));
	const stateDir = join(root, "muster");
	mkdirSync(stateDir, { recursive: true });
	const lane = options.lane ?? "cc-w";
	recordLaunch(stateDir, { laneId: lane, harness: "claude", cwd: "/work/w", branch: null, sessionId: SESSION, title: "A lane the event fixture launches", ...(options.kind !== undefined ? { kind: options.kind } : {}) });
	writeLaneCard(stateDir, { laneId: lane, harness: "claude", cwd: "/work/w", branch: "main", state: "idle", model: null, thinking: null, since: 1, updatedAt: 1, wall: null, sessionId: SESSION });
	const at = { ms: T0 };
	const eventsFile = orchestratorEventsPath(stateDir);
	const ports = (extra: Partial<LaneSendPorts> = {}): LaneSendPorts => ({
		readRows: () => [row(options.pid === undefined ? null : options.pid, lane)],
		readJob: () => job,
		pidAlive: (pid) => pid === 4300,
		waiterAlive: () => false,
		sessionRows: () => ({}),
		holdsSeat: () => false,
		pane: async () => ({ ok: false, command: "none" }),
		confirmArrival: false,
		now: () => new Date(at.ms),
		...extra,
	});
	const send = (extra: Partial<LaneSendPorts> = {}, from = "henry", target = lane) => {
		const request: SendRequest = { laneId: target, mode: "followup", text: "please rebase" };
		return deliverLaneMessage(request, laneSendDeps(stateDir, from, ports(extra)));
	};
	const w: World = { root, stateDir, eventsFile, events: () => (existsSync(eventsFile) ? readFileSync(eventsFile, "utf8").split("\n").filter((line) => line !== "") : []), at, ports, send };
	return Promise.resolve(run(w)).finally(() => { rmSync(root, { recursive: true, force: true }); });
}

test("a message queued for an asleep worker raises one ASLEEP line, is suppressed within 30 min, and is raised again after (LD25)", async () => {
	await world(async (w) => {
		const first = await w.send();
		assert.equal((first as { queued?: string }).queued, "asleep");
		assert.equal(w.events().length, 1);
		// The line is the one the other events use: date -Iseconds prefix, then formatEventLine's shape.
		assert.match(w.events()[0]!, /^2026-10-12T09:00:00\+03:00 ASLEEP: cc-w \| a message from henry is queued for the asleep lane \(its process is gone\); wake it with `muster resume cc-w`$/);
		assert.equal(w.events()[0]!.slice(w.events()[0]!.indexOf(" ") + 1), formatEventLine("ASLEEP", "cc-w", "a message from henry is queued for the asleep lane (its process is gone); wake it with `muster resume cc-w`"));

		w.at.ms = T0 + ASLEEP_REPEAT_MS - 1_000;
		await w.send();
		assert.equal(w.events().length, 1, "29 min 59 s later: suppressed");
		assert.equal(listInboxMessages(w.stateDir, "cc-w").length, 2, "both messages are in the inbox all the same");

		w.at.ms = T0 + ASLEEP_REPEAT_MS;
		await w.send();
		assert.equal(w.events().length, 2, "30 min after the first: raised again");
		assert.match(w.events()[1]!, /^2026-10-12T09:30:00\+03:00 ASLEEP: cc-w \| /);
	});
});

test("the rate limit is per lane, and it leaves the lane's card and record byte-identical (the LD16 proof)", async () => {
	await world(async (w) => {
		recordLaunch(w.stateDir, { laneId: "cc-x", harness: "claude", cwd: "/work/x", branch: null, sessionId: "9f9f9f9f-1111-4222-8333-444455556666", title: "The lane the asleep event names" });
		writeLaneCard(w.stateDir, { laneId: "cc-x", harness: "claude", cwd: "/work/x", branch: "main", state: "idle", model: null, thinking: null, since: 1, updatedAt: 1, wall: null, sessionId: "9f9f9f9f-1111-4222-8333-444455556666" });
		const files = ["lanes/cc-w.json", "lifecycle/cc-w.json"].map((name) => join(w.stateDir, name));
		const before = files.map((file) => readFileSync(file, "utf8"));
		await w.send();
		await w.send({ readRows: () => [row(null, "cc-x")], readJob: () => ({ ...job, sessionId: "9f9f9f9f-1111-4222-8333-444455556666" } as ClaudeJob) }, "henry", "cc-x");
		assert.deepEqual(w.events().map((line) => /ASLEEP: (\S+)/.exec(line)?.[1]), ["cc-w", "cc-x"]);
		assert.deepEqual(files.map((file) => readFileSync(file, "utf8")), before);
		assert.ok(existsSync(asleepRaisedFile(w.stateDir)));
	});
});

test("no ASLEEP line for a live lane, whether or not its waiter is armed", async () => {
	await world(async (w) => {
		const outcome = await w.send();
		assert.equal((outcome as { queued?: string }).queued, "no-waiter");
		assert.equal(((await w.send({ waiterAlive: () => true })) as { queued?: string }).queued, "waiter");
		assert.deepEqual(w.events(), []);
	}, { pid: 4300 });
});

test("no ASLEEP line for a conversation session (LD14), though its message still waits in the inbox", async () => {
	await world(async (w) => {
		const outcome = await w.send();
		assert.equal((outcome as { queued?: string }).queued, "asleep");
		assert.deepEqual(w.events(), []);
		assert.equal(listInboxMessages(w.stateDir, "cc-w").length, 1);
	}, { kind: "conversation" });
});

test("no ASLEEP line for the operator's own session (LD2), an interactive row or the orchestrator's own send", async () => {
	await world(async (w) => {
		await w.send({ sessionRows: () => ({ registryRow: { origin: "operator" } }) });
		await w.send({ sessionRows: () => ({ agentsRow: { kind: "interactive" } }) });
		assert.deepEqual(w.events(), []);
		await w.send({}, "orchestrator");
		assert.deepEqual(w.events(), [], "the orchestrator reads the outcome text of its own send");
		await w.send();
		assert.equal(w.events().length, 1, "a worker lane that is none of those still raises it, so the suppression above was not a rate limit");
	});
});

test("no ASLEEP line for a seat holder (LD24): by lane name, by session, and through the real seat files", async () => {
	await world(async (w) => {
		await w.send({ holdsSeat: () => true });
		assert.deepEqual(w.events(), []);
		assert.equal(laneHoldsSeat(w.stateDir, "cc-w"), false);
		const holder = { harness: "claude" as const, sessionId: SESSION, processKey: "claude-9-1" };
		const ctx = { stateDir: w.stateDir };
		claimSeat("architect", holder, { kind: "ticket", nonce: writeSeatTicket("architect", SESSION, ctx) }, ctx);
		assert.equal(laneHoldsSeat(w.stateDir, "cc-w"), true, "the lane's session holds the architect seat");
		const outcome = await w.send({ holdsSeat: undefined });
		assert.equal((outcome as { queued?: string }).queued, "asleep");
		assert.deepEqual(w.events(), [], "the default seat check keeps the holder quiet");
	});
});

test("no ASLEEP line for a lane that is merged or closed (LD26: a follow-up is a new lane)", async () => {
	await world(async (w) => {
		const record = readLaneRecord(w.stateDir, "cc-w")!;
		writeLaneRecord(w.stateDir, { ...record, phase: "merged", terminal: { outcome: "merged", reason: "test", sha: null, at: 1 } });
		await w.send();
		assert.deepEqual(w.events(), []);
	});
});

test("deliverLaneMessage reports a parked Claude lane as asleep once, and a waiter, a failed inbox write or a non-inbox transport as not asleep", async () => {
	const calls: Array<{ laneId: string; why: string }> = [];
	const base = { pane: async () => ({ ok: false, command: "none" }), log: () => undefined, onAsleep: (info: { laneId: string; why: string }) => { calls.push(info); } };
	const request: SendRequest = { laneId: "cc-w", mode: "followup", text: "x" };
	const inbox = async () => ({ ok: true, path: "/state/inbox/1.json" });
	await deliverLaneMessage(request, { ...base, concord: undefined, resumeParked: async () => ({ state: "inbox-only", why: "its process was stopped on purpose" }), inbox });
	assert.deepEqual(calls, [{ laneId: "cc-w", why: "it is parked: its process was stopped on purpose" }]);
	calls.length = 0;
	await deliverLaneMessage(request, { ...base, concord: undefined, endpointless: () => "x", inboxState: () => ({ state: "live", waiter: true }), inbox });
	await deliverLaneMessage(request, { ...base, concord: undefined, endpointless: () => "x", inboxState: () => ({ state: "asleep", why: "gone" }), inbox: async () => ({ ok: false, error: "disk full" }) });
	await deliverLaneMessage(request, { ...base, concord: { callTool: async () => ({ structuredContent: { message_id: "m", status: "delivered" } }) } });
	assert.deepEqual(calls, []);
	await deliverLaneMessage(request, { ...base, concord: undefined, endpointless: () => "x", inboxState: () => ({ state: "asleep", why: "gone" }), inbox, onAsleep: () => { throw new Error("boom"); } });
});
