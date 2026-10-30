/**
 * Seats (LD20 to LD24): one holder per role, an epoch that rises on every change of holder, a
 * credential only the holder has, and a ticket as proof that the operator typed the phrase at a terminal.
 * Every test runs on a temp state dir; nothing reads or writes the live one.
 */

import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { listInboxMessages } from "../lib/agent-inbox.ts";
import { fileCasStore } from "../owner-fence.ts";
import {
	assignSeat,
	authorizeSeatActor,
	claimSeat,
	describeSeat,
	editSeatDossier,
	fileSeatStore,
	processKeyAlive,
	readSeat,
	readSeatAssignment,
	rebindSeat,
	releaseSeat,
	resolveSeatRole,
	seatAssignmentPath,
	seatBadgePath,
	seatFenceSatisfied,
	seatNoticeInbox,
	seatOf,
	seatsDir,
	SEAT_ASSIGNMENT_TTL_MS,
	SEAT_TICKET_TTL_MS,
	SeatStateError,
	touchSeat,
	validateSeatRecord,
	verifySeatCredential,
	writeSeatTicket,
	type SeatContext,
	type SeatHolderInput,
	type SeatRecord,
} from "../seats.ts";
import { harnessRoot } from "../../core/harness-paths.ts";
import { musterLauncher } from "../../core/pi-ports.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);

const LAUNCHER = musterLauncher();

const SESSION_A = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_B = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const holderA: SeatHolderInput = { harness: "claude", sessionId: SESSION_A, processKey: "claude-4001-777", laneId: "lane-a" };
const holderB: SeatHolderInput = { harness: "pi", sessionId: SESSION_B, processKey: "pi-4002-boot-888" };

type Sandbox = { root: string; ctx: SeatContext; advance: (ms: number) => void; alive: Set<string>; recordPath: (role: string) => string };

function sandbox(): Sandbox {
	const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "muster-seats-"));
	let clock = Date.parse("2026-10-12T05:00:00.000Z");
	const alive = new Set<string>();
	const ctx: SeatContext = { stateDir: join(root, "muster"), now: () => clock, processAlive: (key) => alive.has(key) };
	return { root, ctx, advance: (ms) => { clock += ms; }, alive, recordPath: (role) => join(seatsDir(ctx), `${role}.json`) };
}

function withSandbox(run: (box: Sandbox) => void): void {
	const box = sandbox();
	try {
		run(box);
	} finally {
		rmSync(box.root, { recursive: true, force: true });
	}
}

/** What the Claude adapter does: write the ticket, then claim with its nonce. */
function ticketedClaim(box: Sandbox, role: string, holder: SeatHolderInput) {
	return claimSeat(role, holder, { kind: "ticket", nonce: writeSeatTicket(role, holder.sessionId, box.ctx) }, box.ctx);
}

function refusal(run: () => unknown): SeatStateError {
	try {
		run();
	} catch (error) {
		assert.ok(error instanceof SeatStateError, `expected a SeatStateError, got ${String(error)}`);
		return error;
	}
	assert.fail("expected the call to be refused");
}

test("a claim by session B over A raises the epoch by one, and A's token stops working", () => {
	withSandbox((box) => {
		const first = ticketedClaim(box, "orchestrator", holderA);
		assert.equal(first.epoch, 1);
		assert.equal(first.previous, null);
		assert.equal(verifySeatCredential("orchestrator", first.token, box.ctx), true);

		box.advance(60_000);
		const second = ticketedClaim(box, "orchestrator", holderB);
		assert.equal(second.epoch, 2);
		assert.equal(second.previous?.sessionId, SESSION_A);
		assert.equal(verifySeatCredential("orchestrator", first.token, box.ctx), false);
		assert.equal(verifySeatCredential("orchestrator", second.token, box.ctx), true);

		const decision = authorizeSeatActor("orchestrator", first.token, box.ctx);
		assert.equal(decision.allowed, false);
		assert.equal(decision.allowed === false && decision.reason, "superseded");
		assert.match(decision.allowed === false ? decision.message : "", /you are no longer the orchestrator \(#1, now #2\)/);

		const record = readSeat("orchestrator", box.ctx);
		assert.equal(record.holder?.sessionId, SESSION_B);
		assert.equal(record.holder?.harness, "pi");
		assert.equal(record.history.length, 1);
		assert.deepEqual({ ...record.history[0]!, from: undefined, to: undefined }, { epoch: 1, sessionId: SESSION_A, harness: "claude", from: undefined, to: undefined, how: "claim" });
		assert.equal(JSON.stringify(record).includes(second.token), false, "the token itself is never stored");
		assert.equal(JSON.stringify(record).includes(first.token), false);
		assert.deepEqual(seatOf(SESSION_B, box.ctx), ["orchestrator"]);
		assert.deepEqual(seatOf(SESSION_A, box.ctx), []);

		const badge = JSON.parse(readFileSync(seatBadgePath("orchestrator", box.ctx), "utf8"));
		assert.deepEqual({ role: badge.role, epoch: badge.epoch, sessionId: badge.sessionId }, { role: "orchestrator", epoch: 2, sessionId: SESSION_B });
	});
});

test("the previous holder gets one inbox notice, in its lane's inbox, or a per-session one without a lane", () => {
	withSandbox((box) => {
		ticketedClaim(box, "orchestrator", holderA);
		ticketedClaim(box, "orchestrator", holderB);
		const notices = listInboxMessages(box.ctx.stateDir!, "lane-a");
		assert.equal(notices.length, 1);
		assert.match(notices[0]!.text, /orchestrator seat moved to pi session 22222222 \(#2\)/);
		assert.match(notices[0]!.text, /You no longer hold it/);
	assert.match(notices[0]!.text, /by the operator at the terminal/);

		ticketedClaim(box, "orchestrator", holderA);
		const noLane = listInboxMessages(box.ctx.stateDir!, seatNoticeInbox({ sessionId: SESSION_B }));
		assert.equal(noLane.length, 1, "a holder with no lane id is told through its per-session inbox");
	});
});

test("the same session claiming again keeps the epoch and gets a fresh token", () => {
	withSandbox((box) => {
		const first = ticketedClaim(box, "architect", holderA);
		const again = ticketedClaim(box, "architect", { ...holderA, processKey: "claude-4003-999" });
		assert.equal(again.epoch, 1);
		assert.notEqual(again.token, first.token);
		assert.equal(verifySeatCredential("architect", first.token, box.ctx), false);
		assert.equal(verifySeatCredential("architect", again.token, box.ctx), true);
		assert.equal(readSeat("architect", box.ctx).history.length, 0);
	});
});

test("a claim with no ticket, a stale ticket or a ticket for another session is refused and the record is byte-identical", () => {
	withSandbox((box) => {
		const held = ticketedClaim(box, "orchestrator", holderA);
		const before = readFileSync(box.recordPath("orchestrator"), "utf8");
		const unchanged = (): void => assert.equal(readFileSync(box.recordPath("orchestrator"), "utf8"), before);

		refusal(() => claimSeat("orchestrator", holderB, { kind: "ticket", nonce: "anything" }, box.ctx));
		unchanged();

		const stale = writeSeatTicket("orchestrator", SESSION_B, box.ctx);
		box.advance(SEAT_TICKET_TTL_MS + 1);
		assert.match(refusal(() => claimSeat("orchestrator", holderB, { kind: "ticket", nonce: stale }, box.ctx)).message, /stale/);
		unchanged();

		const forOther = writeSeatTicket("orchestrator", SESSION_A, box.ctx);
		assert.match(refusal(() => claimSeat("orchestrator", holderB, { kind: "ticket", nonce: forOther }, box.ctx)).message, /another session/);
		unchanged();

		const wrongNonce = writeSeatTicket("orchestrator", SESSION_B, box.ctx);
		assert.match(refusal(() => claimSeat("orchestrator", holderB, { kind: "ticket", nonce: `${wrongNonce.slice(0, -1)}${wrongNonce.endsWith("0") ? "1" : "0"}` }, box.ctx)).message, /does not match/);
		unchanged();

		assert.equal(verifySeatCredential("orchestrator", held.token, box.ctx), true, "the holder is untouched by refused attempts");
	});
});

test("an assignment claim succeeds, consumes the file, and the holder records the actor", () => {
	withSandbox((box) => {
		assert.equal(refusal(() => assignSeat("gatekeeper", { harness: "claude", sessionId: SESSION_A, inbox: "lane-a" }, "shell", box.ctx)).code, "unknown-role");

		const assigned = assignSeat("architect", { harness: "claude", sessionId: SESSION_A, inbox: "lane-a" }, "gateway", box.ctx);
		assert.equal(assigned.role, "architect");
		assert.equal(assigned.sessionId, SESSION_A);
		const path = seatAssignmentPath("architect", box.ctx);
		assert.equal(statSync(path).mode & 0o777, 0o600);
		const planted = JSON.parse(readFileSync(path, "utf8")) as { nonce: string; role: string; sessionId: string; harness: string; assignedBy: string; writtenAt: string };
		assert.deepEqual({ role: planted.role, sessionId: planted.sessionId, harness: planted.harness, assignedBy: planted.assignedBy }, { role: "architect", sessionId: SESSION_A, harness: "claude", assignedBy: "gateway" });
		assert.deepEqual(readSeatAssignment("architect", box.ctx), planted);
		assert.equal(assigned.expiresAt, new Date(Date.parse(planted.writtenAt) + SEAT_ASSIGNMENT_TTL_MS).toISOString());

		const claimed = claimSeat("architect", holderA, { kind: "assignment", nonce: planted.nonce }, box.ctx);
		assert.equal(claimed.epoch, 1);
		assert.equal(claimed.assignedBy, "gateway");
		assert.equal(claimed.writtenAt, planted.writtenAt);
		assert.equal(existsSync(path), false, "a consumed assignment is gone");
		assert.equal(readSeatAssignment("architect", box.ctx), undefined);
		const record = readSeat("architect", box.ctx);
		assert.equal(record.holder?.assignedBy, "gateway");
		assert.equal(record.holder?.writtenAt, planted.writtenAt);
		assert.equal(verifySeatCredential("architect", claimed.token, box.ctx), true);

		const terminal = ticketedClaim(box, "architect", holderB);
		assert.equal(terminal.assignedBy, "terminal");
		assert.equal(terminal.writtenAt, undefined);
		assert.equal(readSeat("architect", box.ctx).history.at(-1)?.how, "claim");
	});
});

test("an assignment with a previous holder ends it with how: assign, and the notices name the actor", () => {
	withSandbox((box) => {
		ticketedClaim(box, "orchestrator", holderA);
		box.advance(30_000);
		assignSeat("orchestrator", { harness: "pi", sessionId: SESSION_B, inbox: "pi-b" }, "shell", box.ctx);
		const nonce = (JSON.parse(readFileSync(seatAssignmentPath("orchestrator", box.ctx), "utf8")) as { nonce: string }).nonce;

		const claimed = claimSeat("orchestrator", holderB, { kind: "assignment", nonce }, box.ctx);
		assert.equal(claimed.epoch, 2);
		const record = readSeat("orchestrator", box.ctx);
		const entry = record.history.at(-1);
		assert.equal(entry?.how, "assign");
		assert.equal(entry?.sessionId, SESSION_A);
		assert.equal(entry?.harness, "claude");
		assert.equal(entry?.to, record.holder?.since);

		const notices = listInboxMessages(box.ctx.stateDir!, "lane-a");
		assert.match(notices.at(-1)!.text, /by assignment from the operator's shell/);
		const target = listInboxMessages(box.ctx.stateDir!, "pi-b");
		assert.equal(target.length, 1);
		assert.match(target[0]!.text, /orchestrator seat was assigned to you/);
		assert.equal(target[0]!.text.includes(nonce), false, "the notice never carries the nonce");
	});
});

test("assignment refusals change nothing: wrong session, stale, future skew, replaced nonce, the holder's own process", () => {
	withSandbox((box) => {
		const held = ticketedClaim(box, "orchestrator", holderA);
		assert.match(refusal(() => assignSeat("orchestrator", { harness: "claude", sessionId: SESSION_A, inbox: "lane-a" }, "shell", box.ctx)).message, /already holds/);
		assert.equal(existsSync(seatAssignmentPath("orchestrator", box.ctx)), false);

		assignSeat("orchestrator", { harness: "pi", sessionId: SESSION_B, inbox: "pi-b" }, "gateway", box.ctx);
		const recordBefore = readFileSync(box.recordPath("orchestrator"), "utf8");
		const path = seatAssignmentPath("orchestrator", box.ctx);
		const fileAt = (): string => readFileSync(path, "utf8");
		const nonceAt = (): string => (JSON.parse(fileAt()) as { nonce: string }).nonce;
		const assignmentBefore = fileAt();

		assert.match(refusal(() => claimSeat("orchestrator", { ...holderB, sessionId: SESSION_A }, { kind: "assignment", nonce: nonceAt() }, box.ctx)).message, /not this one/);
		box.advance(SEAT_ASSIGNMENT_TTL_MS + 1);
		assert.match(refusal(() => claimSeat("orchestrator", holderB, { kind: "assignment", nonce: nonceAt() }, box.ctx)).message, /stale/);
		const writtenAt = (JSON.parse(assignmentBefore) as { writtenAt: string }).writtenAt;
		assert.match(refusal(() => claimSeat("orchestrator", holderB, { kind: "assignment", nonce: nonceAt() }, { ...box.ctx, now: () => Date.parse(writtenAt) - 2_000 })).message, /stale/);
		assert.equal(readFileSync(box.recordPath("orchestrator"), "utf8"), recordBefore);
		assert.equal(fileAt(), assignmentBefore, "every refused claim left the assignment as it was");

		box.advance(1_000);
		const replacedNonce = nonceAt();
		assignSeat("orchestrator", { harness: "pi", sessionId: SESSION_B, inbox: "pi-b" }, "gateway", box.ctx);
		const replaced = fileAt();
		assert.notEqual(nonceAt(), replacedNonce);
		assert.match(refusal(() => claimSeat("orchestrator", holderB, { kind: "assignment", nonce: replacedNonce }, box.ctx)).message, /does not match/);
		assert.equal(fileAt(), replaced, "a refused older nonce leaves the newer assignment in place");

		const taken = claimSeat("orchestrator", holderB, { kind: "assignment", nonce: nonceAt() }, box.ctx);
		assert.equal(taken.epoch, 2);
		assert.equal(existsSync(path), false);
		assert.equal(verifySeatCredential("orchestrator", held.token, box.ctx), false);

		const forged = `${JSON.stringify({ nonce: "forged-assignment-nonce-01", role: "orchestrator", sessionId: SESSION_B, harness: "pi", assignedBy: "shell", writtenAt: new Date(box.ctx.now!()).toISOString() })}\n`;
		writeFileSync(path, forged, { mode: 0o600 });
		const recordAfterMove = readFileSync(box.recordPath("orchestrator"), "utf8");
		assert.match(refusal(() => claimSeat("orchestrator", holderB, { kind: "assignment", nonce: "forged-assignment-nonce-01" }, box.ctx)).message, /current holder/);
		assert.equal(readFileSync(box.recordPath("orchestrator"), "utf8"), recordAfterMove);
		assert.equal(fileAt(), forged, "the holder's process refused and left the planted file alone");
	});
});

test("a ticket claim of the role removes a pending assignment, and the displaced target is refused as no assignment", () => {
	withSandbox((box) => {
		ticketedClaim(box, "architect", holderA);
		assignSeat("architect", { harness: "pi", sessionId: SESSION_B, inbox: "pi-b" }, "shell", box.ctx);
		const nonce = (JSON.parse(readFileSync(seatAssignmentPath("architect", box.ctx), "utf8")) as { nonce: string }).nonce;

		box.advance(60_000);
		ticketedClaim(box, "architect", holderB);
		assert.equal(existsSync(seatAssignmentPath("architect", box.ctx)), false, "the ticket claim removed the pending assignment");
		assert.match(refusal(() => claimSeat("architect", holderB, { kind: "assignment", nonce }, box.ctx)).message, /no assignment/);
		assert.equal(readSeat("architect", box.ctx).holder?.sessionId, SESSION_B, "the terminal claim kept the seat");
	});
});

test("a release or a rebind also removes a pending assignment", () => {
	withSandbox((box) => {
		const a = ticketedClaim(box, "orchestrator", holderA);
		assignSeat("orchestrator", { harness: "pi", sessionId: SESSION_B, inbox: "pi-b" }, "gateway", box.ctx);
		releaseSeat("orchestrator", a.token, box.ctx);
		assert.equal(existsSync(seatAssignmentPath("orchestrator", box.ctx)), false, "a release removes the pending assignment");

		ticketedClaim(box, "orchestrator", holderA);
		assignSeat("orchestrator", { harness: "pi", sessionId: SESSION_B, inbox: "pi-b" }, "gateway", box.ctx);
		box.advance(60_000);
		rebindSeat("orchestrator", { ...holderA, processKey: "claude-5001-999" }, { kind: "ticket", nonce: writeSeatTicket("orchestrator", SESSION_A, box.ctx) }, box.ctx);
		assert.equal(existsSync(seatAssignmentPath("orchestrator", box.ctx)), false, "a rebind removes the pending assignment");
	});
});

test("a claim by a CLI process with no ticket is refused and writes nothing; a ticketed claim succeeds once and the ticket is gone", () => {
	withSandbox((box) => {
		const run = (args: string[], env: Record<string, string> = {}) => {
			const result = spawnSync(LAUNCHER, ["seat", ...args], { encoding: "utf8", timeout: 60_000, env: { ...process.env, PI_MUSTER_STATE_DIR: box.ctx.stateDir!, ...env } });
			return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
		};
		const claimArgs = (nonce?: string) => ["claim", "orchestrator", "--session", SESSION_A, "--harness", "claude", "--process-key", "claude-4001-777", ...(nonce === undefined ? [] : ["--ticket", nonce]), "--json"];

		const bare = run(claimArgs());
		assert.equal(bare.status, 3, bare.stderr);
		assert.match(bare.stderr, /no ticket/);
		assert.equal(existsSync(box.recordPath("orchestrator")), false, "a refused first claim creates no record");

		const nonce = writeSeatTicket("orchestrator", SESSION_A, { stateDir: box.ctx.stateDir });
		const ticketPath = join(seatsDir(box.ctx), "orchestrator.ticket");
		assert.equal(statSync(ticketPath).mode & 0o777, 0o600);
		const claimed = run(claimArgs(nonce));
		assert.equal(claimed.status, 0, claimed.stderr);
		const parsed = JSON.parse(claimed.stdout);
		assert.equal(parsed.epoch, 1);
		assert.match(parsed.token, /^s1\.[0-9a-f]{64}$/);
		assert.equal(existsSync(ticketPath), false, "a used ticket is gone");
		assert.equal(run(claimArgs(nonce)).status, 3, "a used ticket cannot claim again");

		const shown = run(["show", "orchestrator", "--json"]);
		assert.equal(shown.status, 0, shown.stderr);
		const view = JSON.parse(shown.stdout);
		assert.equal(view.holder.sessionId, SESSION_A);
		assert.equal("tokenSha256" in view.holder, false, "show never prints the credential hash");
		assert.equal(shown.stdout.includes(parsed.token), false);

		assert.equal(run(["release", "orchestrator"]).status, 3, "release without the credential is refused");
		const released = run(["release", "orchestrator"], { MUSTER_SEAT_TOKEN: parsed.token });
		assert.equal(released.status, 0, released.stderr);
		assert.equal(JSON.parse(run(["show", "orchestrator", "--json"]).stdout).holder, null);
		assert.equal(run(["nonsense", "orchestrator"]).status, 2);
		assert.equal(run(["claim", "gatekeeper"]).status, 2);
	});
});

test("the CLI builds the assignment proof from --assignment, and --json names the actor", () => {
	withSandbox((box) => {
		const run = (args: string[]): { status: number | null; stdout: string; stderr: string } => {
			const result = spawnSync(LAUNCHER, ["seat", ...args], { encoding: "utf8", timeout: 60_000, env: { ...process.env, PI_MUSTER_STATE_DIR: box.ctx.stateDir! } });
			return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
		};
		assignSeat("architect", { harness: "claude", sessionId: SESSION_A, inbox: "lane-a" }, "shell", { stateDir: box.ctx.stateDir });
		const nonce = (JSON.parse(readFileSync(seatAssignmentPath("architect", box.ctx), "utf8")) as { nonce: string }).nonce;

		const claimed = run(["claim", "architect", "--session", SESSION_A, "--harness", "claude", "--process-key", "claude-4001-777", "--assignment", nonce, "--json"]);
		assert.equal(claimed.status, 0, claimed.stderr);
		const parsed = JSON.parse(claimed.stdout) as { epoch: number; assignedBy: string; writtenAt?: string };
		assert.equal(parsed.epoch, 1);
		assert.equal(parsed.assignedBy, "shell");
		assert.equal(typeof parsed.writtenAt, "string");
		assert.equal(existsSync(seatAssignmentPath("architect", box.ctx)), false);

		const shown = JSON.parse(run(["show", "architect", "--json"]).stdout) as { holder: { assignedBy?: string; writtenAt?: string } };
		assert.equal(shown.holder.assignedBy, "shell");
		assert.equal(shown.holder.writtenAt, parsed.writtenAt);

		assert.equal(run(["claim", "orchestrator", "--session", SESSION_A, "--harness", "claude", "--process-key", "claude-4001-777", "--ticket", "t", "--assignment", "a"]).status, 2, "both proof flags are a usage error");
	});
});

test("a rebind keeps the epoch and invalidates the old process's token", () => {
	withSandbox((box) => {
		const first = ticketedClaim(box, "orchestrator", holderA);
		const since = readSeat("orchestrator", box.ctx).holder?.since;
		box.advance(60_000);
		const reopened: SeatHolderInput = { ...holderA, processKey: "claude-5001-999" };
		const rebound = rebindSeat("orchestrator", reopened, { kind: "ticket", nonce: writeSeatTicket("orchestrator", SESSION_A, box.ctx) }, box.ctx);
		assert.equal(rebound.epoch, 1);
		assert.equal(verifySeatCredential("orchestrator", first.token, box.ctx), false);
		assert.equal(verifySeatCredential("orchestrator", rebound.token, box.ctx), true);
		const record = readSeat("orchestrator", box.ctx);
		assert.equal(record.holder?.processKey, "claude-5001-999");
		assert.equal(record.holder?.since, since, "the holding began when it was first claimed");
		assert.equal(record.history.length, 0, "a rebind is not a change of holder");
		assert.equal(seatFenceSatisfied("orchestrator", { sessionId: SESSION_A, processKey: "claude-5001-999", epoch: 1 }, box.ctx), true);
		assert.equal(seatFenceSatisfied("orchestrator", { sessionId: SESSION_A, processKey: "claude-4001-777", epoch: 1 }, box.ctx), false, "the old process is fenced");
		assert.equal(seatFenceSatisfied("orchestrator", { sessionId: SESSION_A, processKey: "claude-5001-999", epoch: 2 }, box.ctx), false);
	});
});

test("a rebind is refused while the recorded process is alive, for a non-holder, and with no ticket", () => {
	withSandbox((box) => {
		ticketedClaim(box, "orchestrator", holderA);
		const before = readFileSync(box.recordPath("orchestrator"), "utf8");
		const reopened: SeatHolderInput = { ...holderA, processKey: "claude-5001-999" };
		const ticketFor = (session: string) => ({ kind: "ticket" as const, nonce: writeSeatTicket("orchestrator", session, box.ctx) });

		box.alive.add("claude-4001-777");
		assert.match(refusal(() => rebindSeat("orchestrator", reopened, ticketFor(SESSION_A), box.ctx)).message, /still running/);
		box.alive.clear();

		assert.match(refusal(() => rebindSeat("orchestrator", { ...holderB, processKey: "pi-9-x-1" }, ticketFor(SESSION_B), box.ctx)).message, /not the orchestrator holder/);
		assert.match(refusal(() => rebindSeat("architect", reopened, ticketFor(SESSION_A), box.ctx)).message, /not the architect holder/);
		assert.match(refusal(() => rebindSeat("orchestrator", reopened, { kind: "ticket", nonce: "forged" }, box.ctx)).message, /(does not match|no ticket)/);
		assert.equal(readFileSync(box.recordPath("orchestrator"), "utf8"), before);

		refusal(() => rebindSeat("orchestrator", reopened, { kind: "ticket", nonce: writeSeatTicket("orchestrator", SESSION_A, box.ctx) }, { ...box.ctx, now: () => Date.parse("2026-10-12T05:10:00.000Z") }));
		assert.equal(readFileSync(box.recordPath("orchestrator"), "utf8"), before, "a stale ticket on rebind changes nothing either");
	});
});

test("an unclaimed seat reads with today's dossier: snapshot, inbox and the live rulings, no 10-11 files (F3, the operator 2026-10-22)", () => {
	withSandbox((box) => {
		assert.deepEqual(readSeat("architect", box.ctx).dossier, [
			"~/.claude/skills/design-session/SKILL.md",
			"plans/orchestration-2026-10-05/handoffs/design-snapshot.md",
			"plans/orchestration-2026-10-05/design-inbox.md",
			"plans/orchestration-2026-10-05/operator-rulings-2026-10-19.md",
		]);
		assert.deepEqual(readSeat("orchestrator", box.ctx).dossier, [
			"plans/orchestration-2026-10-05/handoffs/orchestrator-snapshot.md",
			"plans/orchestration-2026-10-05/operator-rulings-2026-10-19.md",
			"state/orchestrator-events.log",
			"~/.claude/skills/continuous-orchestration/SKILL.md",
		]);
	});
});

test("after a release the seat name is refused from epoch 1 on, and accepted at epoch 0", () => {
	withSandbox((box) => {
		const never = authorizeSeatActor("orchestrator", undefined, box.ctx);
		assert.deepEqual(never, { allowed: true, reason: "legacy-epoch-0", epoch: 0 }, "an unclaimed seat enforces nothing");
		assert.equal(verifySeatCredential("orchestrator", undefined, box.ctx), false);
		assert.equal(existsSync(box.recordPath("orchestrator")), false, "reading an unclaimed seat writes nothing");
		assert.ok(readSeat("orchestrator", box.ctx).dossier.length > 0, "an unclaimed seat reads with its default dossier");

		const held = ticketedClaim(box, "orchestrator", holderA);
		assert.deepEqual(authorizeSeatActor("orchestrator", held.token, box.ctx), { allowed: true, reason: "holder", epoch: 1 });
		const nameOnly = authorizeSeatActor("orchestrator", undefined, box.ctx);
		assert.equal(nameOnly.allowed, false);
		assert.match(nameOnly.allowed === false ? nameOnly.message : "", /you do not hold the orchestrator seat; the operator gives it by typing 'become the orchestrator' in your terminal/);

		assert.deepEqual(releaseSeat("orchestrator", held.token, box.ctx), { role: "orchestrator", epoch: 1 });
		for (const token of [held.token, undefined, ""]) {
			assert.equal(authorizeSeatActor("orchestrator", token, box.ctx).allowed, false, "an empty seat is acted as by nobody");
		}
		assert.equal(readSeat("orchestrator", box.ctx).epoch, 1, "a release leaves the epoch, so the seat stays enforced");
		assert.equal(readSeat("orchestrator", box.ctx).history.at(-1)?.how, "release");
		assert.equal(authorizeSeatActor("architect", undefined, box.ctx).allowed, true, "the other seat is still at epoch 0");
	});
});

test("two claims that collide on the revision leave exactly one holder and each caller learns its result", () => {
	withSandbox((box) => {
		const inner = fileSeatStore(seatsDir(box.ctx));
		const rivalTicket = () => ({ kind: "ticket" as const, nonce: writeSeatTicket("orchestrator", SESSION_B, box.ctx) });
		let rival: ReturnType<typeof claimSeat> | undefined;
		// A's first update finds that B's claim landed between A's read and A's write.
		const racing: SeatContext = {
			...box.ctx,
			store: {
				dir: inner.dir,
				read: (id) => inner.read(id),
				update: (id, expected, mutate) => {
					if (rival === undefined) rival = claimSeat("orchestrator", holderB, rivalTicket(), { ...box.ctx, store: inner });
					return inner.update(id, expected, mutate);
				},
			},
		};
		// A claims in process (the Pi path), because the role has one ticket slot and B's claim uses it.
		const mine = claimSeat("orchestrator", holderA, { kind: "in-process" }, racing);

		assert.equal(rival?.epoch, 1, "the rival's claim succeeded and it knows it");
		assert.equal(mine.epoch, 2, "the loser retried against the new revision and then holds the seat");
		assert.equal(mine.previous?.sessionId, SESSION_B);
		const record = readSeat("orchestrator", box.ctx);
		assert.equal(record.holder?.sessionId, SESSION_A, "exactly one holder");
		assert.equal(verifySeatCredential("orchestrator", rival!.token, box.ctx), false);
		assert.equal(verifySeatCredential("orchestrator", mine.token, box.ctx), true);
	});
});

test("a claim that keeps colliding is reported, not silently dropped", () => {
	withSandbox((box) => {
		const inner = fileSeatStore(seatsDir(box.ctx));
		const never: SeatContext = {
			...box.ctx,
			store: { dir: inner.dir, read: (id) => inner.read(id), update: () => { throw new SeatStateError("conflict", "always"); } },
		};
		assert.equal(refusal(() => claimSeat("orchestrator", holderA, { kind: "in-process" }, never)).code, "conflict");
	});
});

test("only the holder can release, touch or edit the dossier", () => {
	withSandbox((box) => {
		const a = ticketedClaim(box, "orchestrator", holderA);
		const b = ticketedClaim(box, "architect", holderB);
		const before = readFileSync(box.recordPath("orchestrator"), "utf8");

		for (const token of [undefined, "", b.token, `${a.token}x`]) {
			refusal(() => releaseSeat("orchestrator", token, box.ctx));
			refusal(() => touchSeat("orchestrator", token, box.ctx));
			refusal(() => editSeatDossier("orchestrator", token, "add", "plans/x.md", box.ctx));
		}
		assert.equal(readFileSync(box.recordPath("orchestrator"), "utf8"), before);

		ticketedClaim(box, "orchestrator", holderB);
		refusal(() => releaseSeat("orchestrator", a.token, box.ctx));
		assert.equal(readSeat("orchestrator", box.ctx).holder?.sessionId, SESSION_B, "the superseded holder cannot release the new holder's seat");

		const held = ticketedClaim(box, "orchestrator", holderA);
		box.advance(5_000);
		touchSeat("orchestrator", held.token, box.ctx);
		assert.equal(readSeat("orchestrator", box.ctx).holder?.lastTypedAt, "2026-10-12T05:00:05.000Z");
		const dossier = editSeatDossier("orchestrator", held.token, "add", "plans/extra.md", box.ctx);
		assert.equal(dossier.at(-1), "plans/extra.md");
		assert.equal(editSeatDossier("orchestrator", held.token, "add", "plans/extra.md", box.ctx).filter((path) => path === "plans/extra.md").length, 1);
		assert.equal(editSeatDossier("orchestrator", held.token, "remove", "plans/extra.md", box.ctx).includes("plans/extra.md"), false);
		assert.deepEqual(releaseSeat("orchestrator", held.token, box.ctx), { role: "orchestrator", epoch: readSeat("orchestrator", box.ctx).epoch });
	});
});

test("designer is an alias of architect, and nothing else is a seat", () => {
	assert.equal(resolveSeatRole("designer"), "architect");
	assert.equal(resolveSeatRole("Designer"), "architect");
	assert.equal(resolveSeatRole("architect"), "architect");
	assert.equal(resolveSeatRole("orchestrator"), "orchestrator");
	assert.equal(resolveSeatRole("sn-product"), undefined);
	withSandbox((box) => {
		const claimed = ticketedClaim(box, "designer", holderB);
		assert.equal(claimed.role, "architect");
		assert.equal(readSeat("designer", box.ctx).holder?.sessionId, SESSION_B);
		assert.equal(existsSync(box.recordPath("designer")), false);
		assert.equal(existsSync(box.recordPath("architect")), true);
		assert.equal(refusal(() => readSeat("gatekeeper", box.ctx)).code, "unknown-role");
	});
});

test("process keys: a gone or reused pid is dead, a key that names no pid cannot be proven gone", () => {
	assert.equal(processKeyAlive(`claude-${process.pid}-nostart`), true, "this process is alive and the key carries no start ticks");
	assert.equal(processKeyAlive("claude-2147483000-12345"), false, "no such pid");
	assert.equal(processKeyAlive(`claude-${process.pid}-1`), false, "a live pid with other start ticks is another process");
	assert.equal(processKeyAlive("something-unparseable"), true);
});

test("the stored record is validated and the credential hash is hidden from the description", () => {
	withSandbox((box) => {
		ticketedClaim(box, "orchestrator", holderA);
		const record = readSeat("orchestrator", box.ctx);
		assert.equal(validateSeatRecord(record).ok, true);
		assert.equal(validateSeatRecord({ ...record, epoch: -1 }).ok, false);
		assert.equal(validateSeatRecord({ ...record, role: "gatekeeper" }).ok, false);
		assert.equal(validateSeatRecord({ ...record, history: new Array(21).fill(record.history) }).ok, false);
		const view = describeSeat(record, box.ctx);
		assert.equal(view.holder !== null && "tokenSha256" in view.holder, false);
		assert.equal(view.holder?.processAlive, false);

		writeFileSync(box.recordPath("orchestrator"), "{ not json");
		assert.equal(refusal(() => readSeat("orchestrator", box.ctx)).code, "malformed");
	});
});

test("the history keeps the last 20 finished holdings", () => {
	withSandbox((box) => {
		for (let round = 0; round < 24; round += 1) ticketedClaim(box, "orchestrator", round % 2 === 0 ? holderA : holderB);
		const record: SeatRecord = readSeat("orchestrator", box.ctx);
		assert.equal(record.epoch, 24);
		assert.equal(record.history.length, 20);
		assert.equal(record.history.at(-1)?.epoch, 23);
		assert.equal(record.history[0]?.epoch, 4);
	});
});

test("the generic store keeps the programme store's messages", () => {
	withSandbox((box) => {
		class Err extends Error {
			constructor(readonly code: string, message: string) { super(message); }
		}
		const store = fileCasStore<{ revision: number }>({ dir: box.root, idPattern: /^x_[0-9]$/, idKind: "thing", noun: "thing control", validate: (raw) => ({ ok: true, record: raw as { revision: number } }), errorClass: Err });
		assert.throws(() => store.read("bad"), /invalid thing id: bad/);
		assert.equal(store.update("x_1", undefined, () => ({ revision: 1 })).revision, 1);
		assert.throws(() => store.update("x_1", undefined, () => ({ revision: 1 })), /Thing control record .* already exists/);
		assert.throws(() => store.update("x_1", 5, () => ({ revision: 6 })), /Thing control revision conflict for x_1: expected 5, current 1/);
		assert.throws(() => store.update("x_2", 1, () => ({ revision: 2 })), /No thing control record at /);
	});
});
