/**
 * The orchestrator waker (WAKE1, Henry via the operator 2026-10-29 03:29).
 *
 * The brief's acceptance ladder, as far as a process-free test can prove it:
 *
 *   C. a delivered wake is proved by the seat's next turn inside 3 minutes;
 *   D. a seat that stays frozen gets one retry, one resume attempt, ONE Henry alert and ONE
 *      Discord alert per outage, and no second alert inside the hour;
 *   E. the pieces the brief removes are gone (checked by the removals' own tests and by the
 *      grep in docs/qa/wake1-proof.md);
 *   and the loop never exits after a batch, which is what the waiter it replaces got wrong.
 *
 * The tick's half - restart on a down unit, restart on an unabsorbed handoff - is here too,
 * because both halves answer one question: is the seat turning?
 */

import "./muster-test-isolation.ts";

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { nodeBinary, tsxLoaderPath } from "../../core/harness-paths.ts";
import { acquireWakerLock, releaseWakerLock, WAKER_REFUSAL_EXIT, wakerLockFile } from "../waker-lock.ts";

import {
	ALERT_REPEAT_MS,
	BUSY_PROOF_WINDOW_MS,
	MAX_BATCH_LINES,
	PROOF_WINDOW_MS,
	WAKER_ACTOR,
	alertAllowed,
	batchOf,
	inboxTrigger,
	isWakeLine,
	outageKey,
	outageText,
	proofWindow,
	runWake,
	runWakerLoop,
	selectLines,
	turnAfter,
	wakerPass,
	type WakerDeps,
	type WakerInboxMessage,
	type WakerMarks,
	type WakerSeat,
	type WakerTurn,
	wakerText,
} from "../orch-waker.ts";
import { WAKER_HANDOFF_STALE_MS, WAKER_RESTART_RATE_MS, orchestratorWakerGuard, wakerGuardReason, type TickPorts } from "../tick.ts";

const T0 = Date.UTC(2026, 9, 29, 1, 0, 0);
const MINUTE = 60_000;

const SEAT: WakerSeat = { laneId: "01a1843e-seat", sessionId: "01a1843e-seat", harness: "pi", epoch: 5 };

/** One fake machine: the clock, the deliveries, the turns and every alert, recorded in order. */
function machine(over: {
	turns?: (at: number) => WakerTurn;
	resume?: () => Promise<{ state: "resumed" | "not-parked" | "inbox-only" | "failed"; detail: string }>;
	events?: string[];
	inbox?: { id: string; at: string; from: string; text: string }[];
	deliverFails?: boolean;
} = {}): {
	deps: WakerDeps;
	log: string[];
	deliveries: Array<{ text: string; key: string; laneId: string }>;
	henry: string[];
	marked: string[];
	advance(ms: number): void;
	marks(): WakerMarks;
} {
	let now = T0;
	let marks: WakerMarks = {};
	const log: string[] = [];
	const deliveries: Array<{ text: string; key: string; laneId: string }> = [];
	const henry: string[] = [];
	const marked: string[] = [];
	let resumeCalls = 0;
	const turn = over.turns ?? (() => ({ lastTurnAt: T0 - 5 * MINUTE, busy: false }));
	const deps: WakerDeps = {
		signal: new AbortController().signal,
		seat: () => SEAT,
		inbox: () => over.inbox ?? [],
		markInboxRead: (ids) => void marked.push(...ids),
		events: async () => over.events ?? [],
		deliver: async (seat, text, key) => {
			deliveries.push({ text, key, laneId: seat.laneId });
			return over.deliverFails === true ? { ok: false, detail: "muster send: refused" } : { ok: true, detail: "muster send: delivered" };
		},
		// The seat's turn clock moves with the fake clock, so a proof window is a fact of the delivery.
		turn: async () => turn(now),
		resume: async () => {
			resumeCalls += 1;
			return over.resume === undefined ? { state: "not-parked" as const, detail: "" } : over.resume();
		},
		alertHenry: (text) => void henry.push(text),
		marks: () => marks,
		saveMarks: (next) => {
			marks = next;
		},
		now: () => now,
		// Time advances by the sleep; nothing waits in real time.
		sleep: async (ms) => {
			now += ms;
		},
		log: (line) => void log.push(line),
	};
	return {
		deps,
		log,
		deliveries,
		henry,
		marked,
		advance: (ms) => {
			now += ms;
		},
		marks: () => marks,
	};
}

const batch = { lines: ["REVIEW READY: wake1 lane/wake1@abc123 | the waker builds"], messages: [] as WakerInboxMessage[] };

// ─── The batch the seat is handed ──────────────────────────────────────────

test("only the kinds the seat acts on are a wake, and each line is cut for a message", () => {
	assert.equal(isWakeLine("2026-10-29T03:00:00+02:00 REVIEW READY: wake1 a@b | done"), true);
	assert.equal(isWakeLine("2026-10-29T03:00:00+02:00 BLOCKED: wake1 | no owner"), true);
	assert.equal(isWakeLine("WORKING: wake1 | turning the crank"), false);
	assert.equal(isWakeLine("not an event"), false);
	const long = `STALLED: wake1 | ${"x".repeat(600)}`;
	const kept = selectLines([long, long, "WORKING: wake1 | ignored", "CRASHED: wake1 | gone"]);
	assert.equal(kept.length, 2, "one copy of each line, and the working note dropped");
	assert.ok(kept[0]!.length < 450);
	assert.equal(kept[1], "CRASHED: wake1 | gone");
	assert.equal(selectLines(Array.from({ length: 90 }, (_, index) => `CRASHED: lane-${index} | gone`)).length, MAX_BATCH_LINES);
});

test("the waker's own message is not a new trigger, and an empty read wakes nobody", () => {
	assert.deepEqual(inboxTrigger([{ id: "1", at: "", from: WAKER_ACTOR, text: "WAKE: 1 item(s)" }]), []);
	assert.equal(batchOf([], []), undefined, "nothing to say is not a wake");
	const inbox = [{ id: "m1", at: "", from: "operator", text: "check the merge" }];
	const read = batchOf([], inbox);
	assert.deepEqual(read?.messages.map((message) => message.id), ["m1"]);
	const withEvent = batchOf(["REVIEW READY: wake1 a@b | done"], inbox);
	assert.deepEqual(withEvent?.messages.map((message) => message.id), ["m1"], "the delivery carries the inbox message, so it is marked read once");
});

test("the delivered text names the count, the lines and where the messages live", () => {
	const read = batchOf(["REVIEW READY: wake1 a@b | done"], [{ id: "m1", at: "", from: "operator", text: "continue" }]);
	assert.ok(read !== undefined);
	const text = wakerText(read, T0 - MINUTE);
	assert.match(text, /^WAKE: 2 item\(s\) for the orchestrator since /, "the count and the batch's own start");
	assert.match(text, /REVIEW READY: wake1 a@b \| done/);
	assert.match(text, /MESSAGE: operator \| continue/, "the message itself travels, because its inbox copy is marked read");
	assert.match(wakerText({ lines: [], messages: [] }, undefined), /^WAKE: 0 item\(s\) for the orchestrator\n/);
});

// ─── C. a delivered wake is proved by the next turn ───────────────────────

test("the first turn after the delivery proves the wake: no retry, no resume, no alert", async () => {
	const m = machine({ turns: (now) => ({ lastTurnAt: now > T0 + 30_000 ? T0 + 40_000 : T0 - 5 * MINUTE, busy: false }) });
	const outcome = await runWake(m.deps, batch);
	assert.equal(outcome.kind, "proved");
	assert.equal(m.deliveries.length, 1, "one delivery when the seat answers");
	assert.equal(m.deliveries[0]!.laneId, "orchestrator", "the wake goes to the role inbox, not the holder's session id");
	assert.match(m.deliveries[0]!.text, /^WAKE: 1 item/);
	assert.match(m.deliveries[0]!.text, /REVIEW READY: wake1/);
	assert.deepEqual(m.henry, []);
	assert.equal("alertDiscord" in m.deps, false, "no Discord sender is reachable from the waker at all");
	assert.ok((m.marks().provenAt ?? 0) > T0, "the proof is kept as the next batch's `since`");
});

test("a message the delivery carried is marked read, once, after the delivery", async () => {
	// The seat answers, so one delivery carries the message and the inbox copy is done.
	const m = machine({ turns: (now) => ({ lastTurnAt: now > T0 + 30_000 ? T0 + 40_000 : T0 - 5 * MINUTE, busy: false }) });
	const read = batchOf([], [{ id: "m1", at: "2026-10-29T01:00:00Z", from: "operator", text: "continue" }]);
	assert.ok(read !== undefined);
	await runWake(m.deps, read);
	assert.deepEqual(m.marked, ["m1"]);
});

// ─── D. a frozen seat: retry, resume, one alert ───────────────────────────

test("a seat that never turns gets one retry, one resume and exactly one alert per outage", async () => {
	const m = machine({
		turns: () => ({ lastTurnAt: T0 - 5 * MINUTE, busy: false }),
		resume: async () => ({ state: "not-parked", detail: "" }),
	});
	const outcome = await runWake(m.deps, batch);
	assert.equal(outcome.kind, "alerted");
	assert.equal(m.deliveries.length, 2, "the brief's one retry");
	assert.equal(m.henry.length, 1, "ONE Henry-mailbox issue");
	assert.match(m.henry[0]!, new RegExp(`orchestrator seat \\(${outageKey(SEAT).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
	assert.match(m.henry[0]!, /two deliveries/);
	assert.match(m.henry[0]!, /resume: not-parked/, "the owner's own answer is named, not assumed");
	assert.match(m.henry[0]!, /no seat was moved/, "the alert says what was not done");
	assert.equal(m.marks().lastAlertAt, m.marks().lastAlertAt);
	assert.ok((m.marks().lastAlertAt ?? 0) > T0);
});

test("no second alert inside the hour, then one an hour while the seat stays frozen", async () => {
	const m = machine({ turns: () => ({ lastTurnAt: T0 - 5 * MINUTE, busy: false }) });
	await runWake(m.deps, batch);
	const first = m.henry.length;
	assert.equal(first, 1);
	// The next pass, five minutes later: the outage continues, and the hour has not passed.
	m.advance(5 * MINUTE);
	const second = await runWake(m.deps, batch);
	assert.equal(second.kind, "alert-held");
	assert.equal(m.henry.length, 1, "no repeat inside the hour");
	assert.ok(m.henry[0] !== undefined);
	// Past the hour: the same outage pages once more, which is the brief's "hourly max".
	m.advance(ALERT_REPEAT_MS);
	const third = await runWake(m.deps, batch);
	assert.equal(third.kind, "alerted");
	assert.equal(m.henry.length, 2);
	assert.equal(m.henry.length, 2, "one an hour, and only to Henry");
});

test("a long turn of the seat's own is not an outage: the busy window is the longer one", async () => {
	assert.equal(proofWindow({ lastTurnAt: T0, busy: true }), BUSY_PROOF_WINDOW_MS);
	assert.equal(proofWindow({ lastTurnAt: T0, busy: false }), PROOF_WINDOW_MS);
	const m = machine({
		// Busy at delivery, proved after eight minutes: inside the busy window, outside the idle one.
		turns: (now) => ({ lastTurnAt: now > T0 + 8 * MINUTE ? T0 + 8 * MINUTE : T0 - 30_000, busy: true }),
	});
	const outcome = await runWake(m.deps, batch);
	assert.equal(outcome.kind, "proved");
	assert.equal(m.deliveries.length, 1);
	assert.deepEqual(m.henry, []);
});

test("a parked seat that the resume relaunches is proved by the new process's turn", async () => {
	const m = machine({
		turns: (now) => (now > T0 + 2 * PROOF_WINDOW_MS + 30_000 ? { lastTurnAt: T0 + 2 * PROOF_WINDOW_MS + 40_000, busy: false } : { lastTurnAt: T0 - 5 * MINUTE, busy: false }),
		resume: async () => ({ state: "resumed", detail: "pi-lane-launch.sh --resume-brief" }),
	});
	const outcome = await runWake(m.deps, batch);
	assert.equal(outcome.kind, "proved");
	assert.equal(outcome.kind === "proved" && outcome.afterResume, true);
	assert.equal(m.deliveries.length, 2, "the retry happened before the resume, as the ladder orders it");
	assert.deepEqual(m.henry, [], "a recovered seat pages nobody");
});

test("a delivery the send owner refuses still walks the ladder, and ends in one alert", async () => {
	const m = machine({ deliverFails: true });
	const outcome = await runWake(m.deps, batch);
	assert.equal(outcome.kind, "alerted");
	assert.equal(m.deliveries.length, 2, "the retry is the ladder's second rung whatever the first answer was");
	assert.equal(m.henry.length, 1);
	assert.match(m.henry[0]!, /both deliveries were refused/, "the alert tells the truth about what failed");
});

test("the alert's rate gate is the hour, whatever the outage", () => {
	assert.equal(alertAllowed({}, T0), true);
	assert.equal(alertAllowed({ lastAlertAt: T0 }, T0 + ALERT_REPEAT_MS - 1), false);
	assert.equal(alertAllowed({ lastAlertAt: T0 }, T0 + ALERT_REPEAT_MS), true);
});

test("the outage line carries the key, every attempt, and what was not done", () => {
	const text = outageText("5:sess", ["two deliveries, no turn in 3 min each", "resume: not-parked"]);
	assert.match(text, /5:sess/);
	assert.match(text, /no turn in 3 min each/);
	assert.match(text, /nothing else was restarted/i);
});

test("a turn before the delivery does not prove it", () => {
	assert.equal(turnAfter({ lastTurnAt: T0 - 1, busy: false }, T0), false);
	assert.equal(turnAfter({ lastTurnAt: T0, busy: false }, T0), true);
	assert.equal(turnAfter({ lastTurnAt: undefined, busy: false }, T0), false);
});

// ─── The loop: a batch never ends the process ────────────────────────────

test("the loop keeps reading after a batch and stops only on the signal", async () => {
	const controller = new AbortController();
	let passes = 0;
	let delivered = 0;
	const deps = {
		...machine({}).deps,
		events: () => {
			passes += 1;
			// Two batches, then nothing, then the signal; the loop must not exit after a batch.
			if (passes <= 2) return ["REVIEW READY: wake1 a@b | done"];
			if (passes === 4) controller.abort();
			return [];
		},
		deliver: () => {
			delivered += 1;
			return { ok: true, detail: "delivered" };
		},
		turn: () => ({ lastTurnAt: T0 + 1, busy: false }),
	} as unknown as WakerDeps;
	await runWakerLoop({ ...deps, signal: controller.signal } as never);
	assert.equal(delivered, 2, "every batch was delivered and the loop went on");
	assert.ok(passes >= 4, "the loop kept reading after the batches");
});

test("a failing pass is logged and the loop continues", async () => {
	const controller = new AbortController();
	let calls = 0;
	const deps = {
		...machine({}).deps,
		events: () => {
			calls += 1;
			if (calls === 1) throw new Error("the ledger socket is not there");
			controller.abort();
			return [];
		},
	} as unknown as WakerDeps & { signal: AbortSignal };
	const log: string[] = [];
	await runWakerLoop({ ...deps, signal: controller.signal, log: (line: string) => void log.push(line) } as never);
	assert.ok(log.some((line) => /pass failed: (Error: )?the ledger socket is not there/.test(line)), "the journal carries the failure, with its stack");
});

test("a pass with nothing to read does not deliver", async () => {
	const m = machine({});
	assert.equal(await wakerPass(m.deps), undefined);
	assert.deepEqual(m.deliveries, []);
});

// ─── The tick's half: restart the waker ──────────────────────────────────

const tickPorts = (over: {
	unit?: "active" | "inactive" | "failed" | "unknown";
	lastTurnAt?: number;
	waiting?: Array<{ laneId: string; kind: string; at: number }>;
	now?: number;
	marks?: Map<string, string>;
	restart?: { ok: boolean; detail: string };
} = {}): { ports: TickPorts; restarts: number[]; marks: Map<string, string> } => {
	const marks = over.marks ?? new Map<string, string>();
	let restarts = 0;
	const restarted: number[] = [];
	const ports: TickPorts = {
		now: () => over.now ?? T0,
		catalogue: () => undefined,
		control: {},
		readTasks: () => undefined,
		alerts: { get: (key) => marks.get(key), set: (key, value) => void marks.set(key, value) },
		alert: async () => ({ delivered: true }),
		wakerGuard: {
			unit: () => {
				restarts += 1;
				return over.unit ?? "active";
			},
			restart: () => {
				restarted.push(T0);
				return over.restart ?? { ok: true, detail: "systemctl --user restart muster-orch-waker.service" };
			},
			lastTurnAt: () => over.lastTurnAt,
			waiting: () => over.waiting ?? [],
		},
	};
	return { ports, restarts: restarted, marks };
};

test("a unit that is not active is restarted", () => {
	for (const unit of ["inactive", "failed"] as const) {
		const { ports, restarts } = tickPorts({ unit });
		const action = orchestratorWakerGuard(ports);
		assert.equal(action?.action, "waker-restart", `${unit} is a stopped waker`);
		assert.equal(restarts.length, 1);
	}
});

test("an active waker with nothing waiting is left alone", () => {
	const { ports, restarts } = tickPorts({ unit: "active" });
	assert.equal(orchestratorWakerGuard(ports), undefined);
	assert.equal(restarts.length, 0);
});

test("a handoff waiting past the threshold with no turn since restarts the waker", () => {
	const { ports, restarts } = tickPorts({
		unit: "active",
		lastTurnAt: T0 - 40 * MINUTE,
		waiting: [{ laneId: "slrev", kind: "review_ready", at: T0 - 20 * MINUTE }],
	});
	const reason = wakerGuardReason(ports);
	assert.ok(reason !== undefined);
	assert.match(reason?.reason ?? "", /1 handoff\(s\) waiting more than 15 min/);
	const action = orchestratorWakerGuard(ports);
	assert.equal(action?.action, "waker-restart");
	assert.equal(restarts.length, 1);
	assert.match(action?.detail ?? "", /slrev/);
});

test("a handoff the seat has taken a turn after is absorbed, not stale", () => {
	const { ports, restarts } = tickPorts({
		unit: "active",
		lastTurnAt: T0 - MINUTE,
		waiting: [{ laneId: "slrev", kind: "review_ready", at: T0 - 20 * MINUTE }],
	});
	assert.equal(orchestratorWakerGuard(ports), undefined);
	assert.equal(restarts.length, 0);
});

test("a handoff inside the threshold is not news yet", () => {
	const { ports, restarts } = tickPorts({ unit: "active", lastTurnAt: T0 - 40 * MINUTE, waiting: [{ laneId: "slrev", kind: "review_ready", at: T0 - WAKER_HANDOFF_STALE_MS + MINUTE }] });
	assert.equal(orchestratorWakerGuard(ports), undefined);
	assert.equal(restarts.length, 0);
});

test("a machine that cannot answer is not evidence of a stopped waker", () => {
	const { ports, restarts } = tickPorts({ unit: "unknown" });
	assert.equal(orchestratorWakerGuard(ports), undefined);
	assert.equal(restarts.length, 0);
});

test("restarts are throttled: a failing unit is not restarted every pass", () => {
	const marks = new Map<string, string>([["waker:last-restart", String(T0)]]);
	const { ports, restarts } = tickPorts({ unit: "inactive", marks, now: T0 + WAKER_RESTART_RATE_MS - MINUTE });
	const action = orchestratorWakerGuard(ports);
	assert.equal(action?.action, "waker-restart");
	assert.match(action?.detail ?? "", /restart held/);
	assert.equal(restarts.length, 0, "inside the window nothing was restarted");
	// Past the window the next pass restarts it.
	const later = tickPorts({ unit: "inactive", marks, now: T0 + WAKER_RESTART_RATE_MS + MINUTE });
	assert.equal(orchestratorWakerGuard(later.ports)?.action, "waker-restart");
	assert.equal(later.restarts.length, 1);
});

test("a restart systemd refuses is reported, and not counted as done", () => {
	const marks = new Map<string, string>();
	const { ports } = tickPorts({ unit: "failed", restart: { ok: false, detail: "systemctl --user restart muster-orch-waker.service: access denied" }, marks });
	const action = orchestratorWakerGuard(ports);
	assert.equal(action?.action, "waker-restart-failed");
	assert.match(action?.detail ?? "", /access denied/);
	assert.equal(marks.get("waker:last-restart"), undefined, "a failed restart does not start the throttle");
});

// ─── The waker's own lock (rev4 finding F1) ─────────────────────────────────

/** The waker's entry point as a child process command: the harness's node with the tsx loader. */
function wakerCommand(): string[] {
	const args: string[] = [];
	for (let at = 0; at < process.execArgv.length; at += 1) {
		if (process.execArgv[at] === "--import" && process.execArgv[at + 1] !== undefined) args.push("--import", process.execArgv[at + 1]);
	}
	if (args.length === 0) {
		const loader = tsxLoaderPath();
		if (loader !== undefined) args.push("--import", loader);
	}
	return [nodeBinary(), ...args, fileURLToPath(new URL("../bin/muster-orch-waker.mts", import.meta.url))];
}

/** A state directory of this waker's own, so the test never touches the machine's. */
function wakerStateDir(prefix: string): { dir: string; stateDir: string; env: NodeJS.ProcessEnv } {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	const stateDir = join(dir, "muster");
	mkdirSync(stateDir, { recursive: true });
	return { dir, stateDir, env: { ...process.env, PI_MUSTER_STATE_DIR: stateDir, PI_AGENT_HOME: dir } };
}

/** Wait for the lock file to appear: the copy takes it before anything else it does. */
async function waitForLock(stateDir: string, withinMs = 30_000): Promise<string> {
	const file = wakerLockFile(stateDir);
	const deadline = Date.now() + withinMs;
	while (!existsSync(file) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.ok(existsSync(file), "the waker took its lock");
	return readFileSync(file, "utf8").trim().split(/\s+/)[0] ?? "";
}

test("the waker's lock has one holder: a live pid refuses the second, a stale file is taken over", () => {
	const { dir, stateDir } = wakerStateDir("wake1-lock-");
	try {
		const first = acquireWakerLock(stateDir, { pid: 4242, pidAlive: () => true, startTimeOf: () => "100" });
		assert.equal(first.ok, true);
		const second = acquireWakerLock(stateDir, { pid: 4343, pidAlive: (pid) => pid === 4242, startTimeOf: () => "100" });
		assert.equal(second.ok, false);
		if (second.ok) return;
		assert.equal(second.pid, 4242);
		assert.match(second.line, /muster-orch-waker: refusing to start, pid 4242 is already a live waker/);
		assert.equal(readFileSync(wakerLockFile(stateDir), "utf8").trim().split(/\s+/)[0], "4242", "the refused copy did not touch the holder's file");
		// A holder that is gone is a stale file: the next waker takes it.
		const third = acquireWakerLock(stateDir, { pid: 4343, pidAlive: () => false, startTimeOf: () => "200" });
		assert.equal(third.ok, true);
		// The lock goes only while the file names its holder.
		releaseWakerLock(stateDir, 4343, "200");
		assert.equal(existsSync(wakerLockFile(stateDir)), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a second copy of the waker refuses to start and names the holder", async () => {
	const { dir, stateDir, env } = wakerStateDir("wake1-copy-");
	const command = wakerCommand();
	const first = spawn(command[0] as string, command.slice(1), { env, stdio: "ignore" });
	try {
		const holder = await waitForLock(stateDir);
		assert.equal(first.exitCode, null, "the first copy is running");
		const second = spawnSync(command[0] as string, command.slice(1), { env, encoding: "utf8", timeout: 60_000 });
		assert.equal(second.status, WAKER_REFUSAL_EXIT, `the second copy must refuse: ${second.stderr}`);
		assert.match(second.stderr, new RegExp(`refusing to start, pid ${holder} is already a live waker`));
	} finally {
		first.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the retired waiter refuses to arm while the waker holds its lock (rev4 finding F2)", async () => {
	const { dir, stateDir, env } = wakerStateDir("wake1-waiter-");
	const command = wakerCommand();
	const waker = spawn(command[0] as string, command.slice(1), { env, stdio: "ignore" });
	try {
		const holder = await waitForLock(stateDir);
		assert.equal(waker.exitCode, null, "the waker is running");
		const waiter = spawnSync("bash", [fileURLToPath(new URL("../scripts/orch-wait.sh", import.meta.url))], {
			encoding: "utf8",
			timeout: 60_000,
			env: { ...env, ORCH_STATE_DIR: join(dir, "state") },
		});
		assert.equal(waiter.status, 75, `the waiter must refuse to arm: ${waiter.stderr}`);
		assert.match(waiter.stderr, new RegExp(`orch-wait: refusing to arm, pid ${holder} is already a live waker`));
	} finally {
		waker.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a stop signal ends the loop: the stopped line is written and the lock is released (rev4 finding W1)", async () => {
	const { dir, stateDir, env } = wakerStateDir("wake1-stop-");
	const command = wakerCommand();
	const child = spawn(command[0] as string, command.slice(1), { env, stdio: ["ignore", "pipe", "pipe"] });
	try {
		await waitForLock(stateDir);
		let stdout = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		const closed = new Promise<number | null>((resolve) => {
			child.once("close", (code) => resolve(code));
		});
		child.kill("SIGTERM");
		const code = await Promise.race([
			closed,
			new Promise<null>((resolve) => {
				const timer = setTimeout(() => resolve(null), 30_000);
				timer.unref();
			}),
		]);
		assert.notEqual(code, null, "the waker ended on its own instead of waiting for a kill");
		assert.equal(code, 0, "the waker ended cleanly, not on a signal");
		assert.match(stdout, /stopped/, "the loop wrote its stopped line");
		assert.equal(existsSync(wakerLockFile(stateDir)), false, "the lock is released");
	} finally {
		child.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	}
});
