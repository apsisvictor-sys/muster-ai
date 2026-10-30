import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	attachProgramme,
	enqueueWake,
	fileProgrammeControlStore,
	readProgrammeSnapshot,
	recordHeartbeat,
	requestRotation,
	retireAgent,
} from "../control.ts";
import { downgradeDecisionsForBaseRelease, downgradeForBaseRelease } from "../record-downgrade.ts";
import { fileProgrammeDecisionStore, getDecision, openDecision, applyDecisionDefault, validateProgrammeDecisionsFile } from "../decisions.ts";

/**
 * Rollback safety for the single R1 + R1.5 cutover. The release before R1
 * (`bc016f9`) validates a control record strictly and refuses unknown fields and
 * wake kinds, so a record the new release has written cannot be read by the old
 * one: the programme would stop working after a rollback. This downgrade returns
 * a record to the shape the old release accepts. It was checked once against the
 * real old validator (`autonomy/r1_5/rollback-check.txt`); the frozen rules
 * below are copied from it so the test needs no old checkout.
 */

const BASE_RECORD_KEYS = new Set([
	"schemaVersion", "programmeId", "revision", "status", "runGeneration", "pauseReason", "enrolledSessions", "owner",
	"pendingWakes", "activeClaim", "executions", "reservations", "reservedPaths", "ceiling", "decisionRefs",
	"operatorActions", "lastOutcome", "lastHeartbeat", "createdAt", "updatedAt",
]);
const BASE_HEARTBEAT_KEYS = new Set(["pid", "sessionId", "generation", "at"]);
const BASE_WAKE_KINDS = new Set(["handoff", "delegate-completion", "operator-answer", "state-transition", "watchdog"]);

/** What the old release would complain about. */
function baseProblems(record: Record<string, any>): string[] {
	const problems: string[] = [];
	for (const key of Object.keys(record)) if (!BASE_RECORD_KEYS.has(key)) problems.push(`record field ${key}`);
	for (const key of Object.keys(record.lastHeartbeat ?? {})) if (!BASE_HEARTBEAT_KEYS.has(key)) problems.push(`heartbeat field ${key}`);
	for (const wake of [...(record.pendingWakes ?? []), ...(record.activeClaim?.wakes ?? [])]) {
		if (!BASE_WAKE_KINDS.has(wake.kind)) problems.push(`wake kind ${wake.kind}`);
	}
	return problems;
}

const ID = "agp_8e8e8e8e8e8e";
const OWNER = { sessionId: "leader", processKey: "pi-1-boot-1", operatorRef: "operator", guarded: true };
type Ctx = { store: ReturnType<typeof fileProgrammeControlStore>; killFilePath: string };

function withStore(run: (ctx: Ctx, dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "muster-downgrade-"));
	try {
		run({ store: fileProgrammeControlStore(dir), killFilePath: join(dir, "kill") }, dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** A record carrying every R1 and R1.5 addition. */
function richRecord(ctx: Ctx): Record<string, any> {
	attachProgramme(ID, OWNER, ctx);
	recordHeartbeat(ID, {
		pid: 1, sessionId: OWNER.sessionId, generation: 1, idleSince: null, contextTokens: 300_000, contextWindow: 1_000_000,
		compaction: { at: "2026-10-04T12:00:00.000Z", outcome: "failed" }, paneId: "wD:pA",
	}, ctx);
	retireAgent(ID, { agentId: "pi-old-parent", operatorRef: "operator" }, ctx);
	enqueueWake(ID, { sourceEventId: "frontier/3-abc", kind: "frontier", reason: "work waiting" }, ctx);
	requestRotation(ID, { ticket: "rot-d1", reason: "context", fromSessionId: OWNER.sessionId }, ctx);
	return JSON.parse(JSON.stringify(readProgrammeSnapshot(ID, ctx))) as Record<string, any>;
}

test("the current release's record has things the old release refuses, and the downgrade removes exactly those", () => withStore((ctx) => {
	const record = richRecord(ctx);
	const before = baseProblems(record);
	for (const expected of ["record field retiredAgents", "record field rotation", "record field mergeQueue", "heartbeat field idleSince", "heartbeat field contextTokens", "heartbeat field paneId", "wake kind frontier", "wake kind rotation"]) {
		assert.ok(before.includes(expected), `${expected} is in the current record: ${before.join(", ")}`);
	}
	const result = downgradeForBaseRelease(record);
	const after = result.record as Record<string, any>;
	assert.deepEqual(baseProblems(after), []);
	assert.ok(result.changes.length >= 5);
	// Everything else is untouched.
	const { retiredAgents: _r, rotation: _t, mergeQueue: _m, laneLaunches: _l, parentWriteBudgets: _p, lastHeartbeat: _h, pendingWakes: _w, ...restBefore } = record;
	const { lastHeartbeat: _h2, pendingWakes: _p2, ...restAfter } = after;
	assert.deepEqual(restAfter, restBefore);
	assert.deepEqual(Object.keys(after.lastHeartbeat).sort(), ["at", "generation", "pid", "sessionId"]);
	const wakes = after.pendingWakes as Array<{ kind: string; sourceEventId: string }>;
	assert.deepEqual(wakes.map((wake) => [wake.kind, wake.sourceEventId]), [["watchdog", "frontier/3-abc"], ["watchdog", "rotation/rot-d1"]], "an old kind that carries the same meaning: a hint to look");
}));

test("a wake held by the active continuation claim is mapped too", () => {
	const record = {
		schemaVersion: 1,
		pendingWakes: [],
		activeClaim: { claimId: "c", owner: "lane:s", sessionRef: "s", runGeneration: 1, admittedAt: "x", wakeIds: ["w"], wakes: [{ sourceEventId: "w", kind: "frontier", reason: "r", enqueuedAt: "x" }] },
	};
	const result = downgradeForBaseRelease(record);
	assert.equal((result.record as any).activeClaim.wakes[0].kind, "watchdog");
	assert.deepEqual(baseProblems(result.record as any), []);
});

test("a record the old release already accepts comes back unchanged, and downgrading twice changes nothing more", () => withStore((ctx) => {
	const result = downgradeForBaseRelease(richRecord(ctx));
	const again = downgradeForBaseRelease(result.record);
	assert.deepEqual(again.changes, []);
	assert.deepEqual(again.record, result.record);
	assert.deepEqual(downgradeForBaseRelease({ schemaVersion: 1, status: "running", pendingWakes: [] }).changes, []);
}));

// ─── The command ─────────────────────────────────────────────────────────────

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
	const script = new URL("../../../scripts/muster-record-downgrade.mts", import.meta.url).pathname;
	try {
		const stdout = execFileSync(process.execPath, ["--import", "tsx", script, ...args], { env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { code: 0, stdout, stderr: "" };
	} catch (error) {
		const failure = error as { status?: number; stdout?: string; stderr?: string };
		return { code: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
	}
}

test("the command is a dry run by default, backs the record up and rewrites it with --apply, and never loses the original", () => withStore((ctx, dir) => {
	richRecord(ctx);
	const file = join(dir, `${ID}.json`);
	// A heartbeat older than the freshness window: no live session is writing.
	const record = JSON.parse(readFileSync(file, "utf8"));
	record.lastHeartbeat.at = new Date(Date.now() - 10 * 60_000).toISOString();
	writeFileSync(file, JSON.stringify(record));
	const stale = readFileSync(file, "utf8");
	const dry = runCli([dir]);
	assert.equal(dry.code, 0, dry.stderr);
	assert.match(dry.stdout, /agp_8e8e8e8e8e8e/);
	assert.equal(readFileSync(file, "utf8"), stale, "a dry run writes nothing");
	assert.equal(readdirSync(dir).some((name) => name.includes("before-downgrade")), false);
	const applied = runCli([dir, "--apply"]);
	assert.equal(applied.code, 0, applied.stderr);
	assert.deepEqual(baseProblems(JSON.parse(readFileSync(file, "utf8"))), []);
	assert.equal(readFileSync(`${file}.before-downgrade`, "utf8"), stale, "the new-release record is kept beside it");
	const second = runCli([dir, "--apply"]);
	assert.equal(second.code, 0, second.stderr);
	assert.equal(readFileSync(`${file}.before-downgrade`, "utf8"), stale, "a second run does not overwrite the backup");
}));

test("the command refuses a record whose leader beat in the last 2 minutes unless forced, and skips files that are not records", () => withStore((ctx, dir) => {
	richRecord(ctx);
	writeFileSync(join(dir, "notes.txt"), "not a record");
	mkdirSync(join(dir, "sub"));
	const file = join(dir, `${ID}.json`);
	const before = readFileSync(file, "utf8");
	const refused = runCli([dir, "--apply"]);
	assert.equal(refused.code, 1);
	assert.match(refused.stderr, /beat in the last 2 minutes/);
	assert.equal(readFileSync(file, "utf8"), before, "nothing was rewritten");
	assert.equal(existsSync(`${file}.before-downgrade`), false);
	const forced = runCli([dir, "--apply", "--force"]);
	assert.equal(forced.code, 0, forced.stderr);
	assert.deepEqual(baseProblems(JSON.parse(readFileSync(file, "utf8"))), []);
}));

// ─── F16: the R4 decision file is part of the same rollback ──────────────────

/** What the pre-R4 decision reader would complain about. */
function baseDecisionProblems(file: Record<string, any>): string[] {
	const problems: string[] = [];
	if (file.schemaVersion !== 1) problems.push(`schemaVersion ${file.schemaVersion}`);
	for (const decision of file.decisions ?? []) {
		for (const key of Object.keys(decision)) {
			if (["decisionId", "kind", "question", "options", "recommendation", "blockedTaskIds", "scopeRevision", "status", "answerRef", "appliedOptionId", "appliedAt", "createdAt", "updatedAt"].includes(key)) continue;
			problems.push(`decision ${decision.decisionId} field ${key}`);
		}
	}
	return problems;
}

test("F16: the decision file the R4 release wrote is downgraded to what the old reader accepts", () => {
	const dir = mkdtempSync(join(tmpdir(), "muster-decision-downgrade-"));
	try {
		const store = fileProgrammeDecisionStore(dir);
		const open = { kind: "product-decision" as const, question: "Ship the pilot?", options: [
			{ id: "approve", label: "Approve" }, { id: "hold", label: "Hold" },
		], recommendation: "approve", blockedTaskIds: [], scopeRevision: "main", reversible: true, autoApplyHours: 2 };
		const { decisionId } = openDecision(ID, open, { store });
		// The deadline is the real clock plus autoApplyHours, so the clock the default is applied at is read from it.
		applyDecisionDefault(ID, decisionId, "thread-1", { store }, Date.parse(getDecision(ID, decisionId, { store }).autoApplyAt!));
		const file = JSON.parse(readFileSync(join(dir, `${ID}.decisions.json`), "utf8"));
		assert.ok(baseDecisionProblems(file).length >= 4, `the R4 file has fields the old reader refuses: ${baseDecisionProblems(file).join(", ")}`);
		const result = downgradeDecisionsForBaseRelease(file);
		assert.deepEqual(baseDecisionProblems(result.record), [], "nothing is left that the old reader rejects");
		assert.ok(result.changes.length >= 4);
		const after = getDecision(ID, decisionId, { store: fileProgrammeDecisionStore(dir) });
		assert.equal(after.status, "applied", "the outcome the record already carried is preserved");
		// The provenance of an operator default survives in the backup the command writes.
		assert.equal(file.decisions[0].answerRef.actorId, "operator-default");
		assert.equal(validateProgrammeDecisionsFile({ ...result.record, schemaVersion: 2 }).ok, false,
			"the downgraded file no longer carries R4 fields, so declaring schema 2 again would be a lie");
		assert.equal(downgradeDecisionsForBaseRelease(result.record).changes.length, 0, "downgrading twice changes nothing more");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("F16: the rollback command downgrades the decision file too, with its own backup", () => {
	const dir = mkdtempSync(join(tmpdir(), "muster-decision-cli-"));
	try {
		const store = fileProgrammeDecisionStore(dir);
		const { decisionId } = openDecision(ID, { kind: "product-decision", question: "Ship the pilot?", options: [
			{ id: "approve", label: "Approve" }, { id: "hold", label: "Hold" },
		], recommendation: "approve", blockedTaskIds: [], scopeRevision: "main", reversible: true, autoApplyHours: 2 }, { store });
		applyDecisionDefault(ID, decisionId, "thread-1", { store }, Date.parse(getDecision(ID, decisionId, { store }).autoApplyAt!));
		const file = join(dir, `${ID}.decisions.json`);
		const original = readFileSync(file, "utf8");
		const dry = runCli([dir]);
		assert.equal(dry.code, 0, dry.stderr);
		assert.match(dry.stdout, new RegExp(`"programmeId":"${ID}"`), "the plan names the decision file too");
		assert.equal(readFileSync(file, "utf8"), original, "a dry run writes nothing");
		const applied = runCli([dir, "--apply"]);
		assert.equal(applied.code, 0, applied.stderr);
		assert.deepEqual(baseDecisionProblems(JSON.parse(readFileSync(file, "utf8"))), []);
		assert.equal(readFileSync(`${file}.before-downgrade`, "utf8"), original, "the new-release decision file is kept beside it, with its operator-default provenance");
		assert.equal(JSON.parse(readFileSync(`${file}.before-downgrade`, "utf8")).decisions[0].answerRef.actorId, "operator-default");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the downgrade code starts and stops no process and deletes nothing", () => {
	for (const file of ["../record-downgrade.ts", "../../../scripts/muster-record-downgrade.mts"]) {
		const source = readFileSync(new URL(file, import.meta.url), "utf8");
		assert.doesNotMatch(source, /child_process|process\.kill|\.kill\(|unlinkSync|rmSync|rmdirSync/, file);
	}
});
