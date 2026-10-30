import "./muster-test-isolation.ts";
/**
 * CRR: the lane record's title and handoffs, and the verbs that write them — blueprint R7 D27, CRR 1 to 5.
 *
 * 1. `launch --title` stores a title, a relaunch that names none keeps it (both the live and the parked
 *    branch), and a launch that names one replaces it. A title of 2 or 81 characters, or one with a
 *    newline, is refused and writes no record. A new worker lane without a title is refused with the
 *    brief's own words; a `--conversation` session and a relaunch of an older record are not refused.
 * 2. Review Focus 1: a reused name whose record is terminal is a new lane, so it needs a title, the closed
 *    record is archived first, and the new lane starts with no handoffs.
 * 3. `title`, `sendback` and `accept` are written by the operator's shell, the architect and the orchestrator; a
 *    lane is refused with the writer message and nothing is written.
 * 4. A second send-back with no review report after the previous one is refused, and after a review report
 *    it is accepted and the rounds are two. A closed record takes neither.
 * 5. The fields survive a files-mode write and a ledger round trip (a lab ledger, never the live one).
 * 6. `lane-outcome` takes the rounds and the causes from the record when they are not given, writes the
 *    `goal` and `title` cells, and a file with the older 13-column header still gets 13 cells with the
 *    missing columns named on stderr.
 */

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readLaneRecord, recordHandoff, recordLaunch, recordReport, SENT_BACK, validateLaneTitle, writeLaneRecord, type LaneRecord } from "../lane-lifecycle.ts";
import { roundsOf } from "../lane-stage.ts";
import { addGoal, attachLane, fileGoalStore, goalsDir } from "../goals.ts";
import { backendState } from "../ledger/backend.ts";
import { claimSeat, seatContextFor } from "../seats.ts";
import { ledgerBox, useLedger } from "./ledger-fixture.ts";
import { harnessRoot, tsxLoaderPath } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
const LAUNCHER = join(piAgentDir(), "extensions", "muster", "launchers", "muster");

/** The columns the file carried before CRR, and the two D27 adds at the end. */
const HEADER_13 = ["date", "lane", "project", "class", "model", "launched_at", "closed_at", "rounds_sent_back", "outcome", "send_back_causes", "task_kind", "harness", "route_by"];
const HEADER_15 = [...HEADER_13, "goal", "title"];

const TITLE_REFUSAL = "a new lane needs --title: what it delivers, in plain words";

type Lab = { root: string; state: string; tsv: string; env: NodeJS.ProcessEnv; close: () => void };

/** A lab installation: its own Muster state dir, its own lane-outcomes file, its own project catalogue. */
function lab(header: readonly string[] = HEADER_15): Lab {
	const root = mkdtempSync(join(tmpdir(), "muster-crr-"));
	const state = join(root, "state", "muster");
	const home = join(root, "home");
	const bin = join(root, "bin");
	const tsv = join(root, "lane-outcomes.tsv");
	const catalogue = join(root, "muster-projects.json");
	mkdirSync(state, { recursive: true });
	mkdirSync(home, { recursive: true });
	mkdirSync(bin, { recursive: true });
	symlinkSync("/usr/bin/bash", join(bin, "bash"));
	symlinkSync(process.execPath, join(bin, "node"));
	writeFileSync(tsv, `${header.join("\t")}\n`, "utf8");
	writeFileSync(catalogue, JSON.stringify({ schemaVersion: 1, projects: [] }), "utf8");
	const env: NodeJS.ProcessEnv = {
		PI_MUSTER_STATE_DIR: state,
		PI_LANE_OUTCOMES_TSV: tsv,
		PI_MUSTER_PROJECTS_FILE: catalogue,
		HOME: home,
		PATH: `${bin}:/usr/bin:${dirname(process.execPath)}`,
	};
	return { root, state, tsv, env, close: () => rmSync(root, { recursive: true, force: true }) };
}

function runMuster(l: Lab, args: string[], extra: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(LAUNCHER, args, { encoding: "utf8", timeout: 60_000, cwd: HARNESS_ROOT, env: { ...l.env, ...extra } });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The rows of the lane-outcomes file, one array of cells each. */
function rowsOf(path: string): string[][] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => line.split("\t"));
}

/**
 * The real ledger `startDaemon` in its own process, with the child's own output in the failure, so a daemon
 * that dies says why instead of leaving an empty message. Nothing here reads or writes the live ledger.
 */
async function startLedgerDaemon(t: TestContext, ledgerDir: string): Promise<void> {
	const daemonModule = join(HARNESS_ROOT, "muster", "ledger", "daemon.ts");
	const file = join(ledgerDir, "crr-fixture-daemon.mjs");
	writeFileSync(
		file,
		[`import { startDaemon } from ${JSON.stringify(daemonModule)};`, "await startDaemon(process.env.MUSTER_FIXTURE_DIR);", 'process.stdout.write("READY\\n");'].join("\n"),
	);
	const loader: string[] = [];
	for (let at = 0; at < process.execArgv.length; at += 1) {
		if (process.execArgv[at] === "--import" && process.execArgv[at + 1] !== undefined) loader.push("--import", process.execArgv[at + 1] as string);
	}
	const args = loader.length > 0 ? loader : ["--import", tsxLoaderPath()];
	const child: ChildProcess = spawn(process.execPath, [...args, file], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MUSTER_FIXTURE_DIR: ledgerDir } });
	let output = "";
	const collect = (chunk: Buffer): void => void (output += chunk.toString());
	child.stdout?.on("data", collect);
	child.stderr?.on("data", collect);
	t.after(async () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		const exited = new Promise<void>((done) => child.once("exit", () => done()));
		child.kill("SIGKILL");
		await exited;
	});
	const deadline = Date.now() + 20_000;
	while (!output.includes("READY")) {
		if (child.exitCode !== null || child.signalCode !== null) throw new Error(`the ledger fixture exited before READY (${child.exitCode ?? child.signalCode}): ${output}`);
		if (Date.now() > deadline) throw new Error(`the ledger fixture did not answer within 20 s: ${output}`);
		await new Promise((done) => setTimeout(done, 25));
	}
}

/** A record as a closed lane leaves it: `closeLane` always stores the terminal fact (D26 rule 3). */
const closed = (record: LaneRecord, now = Date.now()): LaneRecord => ({
	...record,
	phase: "merged",
	phaseSince: now,
	terminal: { outcome: "merged", reason: "merged", sha: "04a29d40", at: now, closedAt: now },
});

test("CRR 1: launch --title stores the title, a relaunch keeps it, and one that names a new title replaces it", () => {
	const l = lab();
	try {
		const first = runMuster(l, ["lane-record", "launch", "--lane", "lane-a", "--harness", "pi", "--title", "The lane card counts its fix rounds"]);
		assert.equal(first.status, 0, first.stderr);
		assert.equal(readLaneRecord(l.state, "lane-a")?.title, "The lane card counts its fix rounds");

		const live = runMuster(l, ["lane-record", "launch", "--lane", "lane-a", "--harness", "pi"]);
		assert.equal(live.status, 0, live.stderr);
		assert.equal(readLaneRecord(l.state, "lane-a")?.title, "The lane card counts its fix rounds", "the live branch keeps the title through its rest spread");

		// The parked branch spreads the record the same way.
		writeLaneRecord(l.state, { ...(readLaneRecord(l.state, "lane-a") as LaneRecord), phase: "parked", phaseSince: Date.now(), parkedAt: Date.now() });
		const resumed = runMuster(l, ["lane-record", "launch", "--lane", "lane-a", "--harness", "pi"]);
		assert.equal(resumed.status, 0, resumed.stderr);
		const back = readLaneRecord(l.state, "lane-a") as LaneRecord;
		assert.equal(back.phase, "working", "the parked lane comes back");
		assert.equal(back.title, "The lane card counts its fix rounds", "the parked branch keeps the title");

		const replaced = runMuster(l, ["lane-record", "launch", "--lane", "lane-a", "--harness", "pi", "--title", "  The card waits for its merge  "]);
		assert.equal(replaced.status, 0, replaced.stderr);
		assert.equal(readLaneRecord(l.state, "lane-a")?.title, "The card waits for its merge", "trimmed, and the new title replaces the old one");
	} finally {
		l.close();
	}
});

test("CRR 1: a new worker lane without a title, or with one outside 3 to 80 characters, is refused and nothing is written", () => {
	const l = lab();
	try {
		const noTitle = runMuster(l, ["lane-record", "launch", "--lane", "lane-a", "--harness", "pi"]);
		assert.notEqual(noTitle.status, 0, "a new lane needs a title");
		assert.match(noTitle.stderr, new RegExp(TITLE_REFUSAL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.equal(readLaneRecord(l.state, "lane-a"), undefined, "the refusal writes no record");

		const titles: Array<[string, string]> = [["ab", "two characters"], ["x".repeat(81), "eighty-one characters"], ["two\nlines", "a newline"]];
		for (const [title, why] of titles) {
			const refused = runMuster(l, ["lane-record", "launch", "--lane", "lane-a", "--harness", "pi", "--title", title]);
			assert.notEqual(refused.status, 0, why);
			assert.match(refused.stderr, /title/, why);
			assert.equal(readLaneRecord(l.state, "lane-a"), undefined, `${why}: nothing written`);
		}

		// A conversation session is in talk with the operator and needs no title.
		const talk = runMuster(l, ["lane-record", "launch", "--lane", "desk", "--harness", "pi", "--conversation"]);
		assert.equal(talk.status, 0, talk.stderr);
		assert.equal(readLaneRecord(l.state, "desk")?.title, undefined);

		// A record written before this revision has no title: resuming it, as `muster resume` does, is not refused.
		const now = Date.now();
		writeLaneRecord(l.state, { laneId: "old-lane", harness: "pi", cwd: null, branch: null, launchedAt: now - 600_000, launchedBy: "orchestrator", phase: "parked", phaseSince: now - 600_000, parkedAt: now - 600_000 });
		const resumed = runMuster(l, ["lane-record", "launch", "--lane", "old-lane", "--harness", "pi"]);
		assert.equal(resumed.status, 0, resumed.stderr);
		assert.equal(readLaneRecord(l.state, "old-lane")?.title, undefined);
	} finally {
		l.close();
	}
});

test("validateLaneTitle: one line, trimmed, 3 to 80 characters, no control characters", () => {
	assert.deepEqual(validateLaneTitle("abc"), { title: "abc" });
	assert.deepEqual(validateLaneTitle("  the card waits for its merge  "), { title: "the card waits for its merge" });
	assert.deepEqual(validateLaneTitle("a".repeat(80)), { title: "a".repeat(80) });
	assert.ok("error" in validateLaneTitle("ab"));
	assert.ok("error" in validateLaneTitle("a".repeat(81)));
	assert.ok("error" in validateLaneTitle("two\nlines"));
	assert.ok("error" in validateLaneTitle("tab\there"));
	assert.ok("error" in validateLaneTitle(undefined), "a title is text");
});

test("Review Focus 1: a reused name whose record is terminal needs a title, archives the old record and starts with no handoffs", () => {
	const l = lab();
	try {
		assert.equal(runMuster(l, ["lane-record", "launch", "--lane", "lane-a", "--harness", "pi", "--title", "The first life of the lane"]).status, 0);
		const first = readLaneRecord(l.state, "lane-a") as LaneRecord;
		writeLaneRecord(l.state, { ...closed(first), handoffs: [{ at: Date.now(), by: "orchestrator", verdict: SENT_BACK, cause: "one round, in the first life" }] });

		const refused = runMuster(l, ["lane-record", "launch", "--lane", "lane-a", "--harness", "pi"]);
		assert.notEqual(refused.status, 0, "a reused name is a new lane");
		assert.match(refused.stderr, new RegExp(TITLE_REFUSAL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		const untouched = readLaneRecord(l.state, "lane-a") as LaneRecord;
		assert.equal(untouched.terminal?.outcome, "merged", "the refusal archived nothing");
		assert.equal(untouched.handoffs?.length, 1);

		const relaunched = runMuster(l, ["lane-record", "launch", "--lane", "lane-a", "--harness", "pi", "--title", "The second life of the lane"]);
		assert.equal(relaunched.status, 0, relaunched.stderr);
		const second = readLaneRecord(l.state, "lane-a") as LaneRecord;
		assert.equal(second.title, "The second life of the lane");
		assert.equal(second.phase, "working");
		assert.equal(second.terminal, undefined, "a new lane, not the closed one");
		assert.equal(second.handoffs, undefined, "the new lane starts with no handoffs");

		const archived = readdirSync(join(l.state, "lifecycle-archive"), { recursive: true }).map(String).filter((name) => name.endsWith(".json"));
		assert.equal(archived.length, 1, "the merged record is in the archive");
	} finally {
		l.close();
	}
});

test("CRR 2: title, sendback and accept are written by the operator's shell, the architect and the orchestrator, and a lane is refused", () => {
	const l = lab();
	try {
		assert.equal(runMuster(l, ["lane-record", "launch", "--lane", "lane-a", "--harness", "pi", "--title", "A lane the orchestrator hands back"]).status, 0);

		// the operator's own shell carries no agent-session marker, so the writer is the process.
		assert.equal(runMuster(l, ["lane-record", "title", "lane-a", "the operator names what the lane delivers"]).status, 0);
		assert.equal(readLaneRecord(l.state, "lane-a")?.title, "the operator names what the lane delivers");
		const sent = runMuster(l, ["lane-record", "sendback", "lane-a", "--cause", "the card lost its title", "--waits", "a title on the card", "--sha", "04a29d40"]);
		assert.equal(sent.status, 0, sent.stderr);
		assert.equal(runMuster(l, ["lane-record", "accept", "lane-a", "--sha", "43f90743"]).status, 0);

		// The architect and the orchestrator hold their seats in this lab's registry.
		const base: NodeJS.ProcessEnv = { ...l.env, CLAUDECODE: "1" };
		const context = seatContextFor(base);
		const architect = claimSeat("architect", { harness: "claude", sessionId: "s-arch", processKey: "claude-1-1-1" }, { kind: "in-process" }, context);
		const orchestrator = claimSeat("orchestrator", { harness: "claude", sessionId: "s-orch", processKey: "claude-2-2-2" }, { kind: "in-process" }, context);
		const asArchitect = { ...base, MUSTER_SEAT: "architect", MUSTER_SEAT_TOKEN: architect.token, CONCORD_AGENT_ID: "pi-crr" };
		const asOrchestrator = { ...base, MUSTER_SEAT: "orchestrator", MUSTER_SEAT_TOKEN: orchestrator.token, CONCORD_AGENT_ID: "pi-crr" };

		// Round two needs a review report after round one.
		recordReport(l.state, "lane-a", { kind: "review_ready", summary: "the title is on the card now", at: Date.now() + 1_000 });
		const architectSend = runMuster(l, ["lane-record", "sendback", "lane-a", "--cause", "the waits line is missing"], asArchitect);
		assert.equal(architectSend.status, 0, architectSend.stderr);
		const orchestratorAccept = runMuster(l, ["lane-record", "accept", "lane-a", "--waits", "the merge of the card"], asOrchestrator);
		assert.equal(orchestratorAccept.status, 0, orchestratorAccept.stderr);
		const orchestratorTitle = runMuster(l, ["lane-record", "title", "lane-a", "The orchestrator names the lane"], asOrchestrator);
		assert.equal(orchestratorTitle.status, 0, orchestratorTitle.stderr);

		const record = readLaneRecord(l.state, "lane-a") as LaneRecord;
		assert.deepEqual(record.handoffs?.map((handoff) => handoff.verdict), [SENT_BACK, "accepted", SENT_BACK, "accepted"]);
		assert.equal(roundsOf(record.handoffs), 2);
		assert.equal(record.handoffs?.[0]?.by, "operator-shell");
		assert.equal(record.handoffs?.[2]?.by, "architect");
		assert.equal(record.handoffs?.[3]?.by, "orchestrator");
		assert.equal(record.title, "The orchestrator names the lane");

		// A lane is an agent session whose name is not a seat: refused with the writer message, and nothing written.
		const asLane = { ...base, CONCORD_AGENT_ID: "pi-crr" };
		const before = readFileSync(join(l.state, "lifecycle", "lane-a.json"), "utf8");
		for (const verb of [["title", "lane-a", "A lane names itself"], ["sendback", "lane-a", "--cause", "a lane sends itself back"], ["accept", "lane-a"]]) {
			const refused = runMuster(l, ["lane-record", ...verb], asLane);
			assert.notEqual(refused.status, 0, `${verb[0]} from a lane is refused`);
			assert.match(refused.stderr, /is not a seat/, `${verb[0]}: the writer message`);
			assert.match(refused.stderr, /never writes one/);
		}
		assert.equal(readFileSync(join(l.state, "lifecycle", "lane-a.json"), "utf8"), before, "the refusals wrote nothing");
	} finally {
		l.close();
	}
});

test("CRR 3: a second send-back needs a review report after the previous one, and a closed record takes neither", () => {
	const l = lab();
	try {
		assert.equal(runMuster(l, ["lane-record", "launch", "--lane", "lane-a", "--harness", "pi", "--title", "A lane sent back twice"]).status, 0);
		const first = runMuster(l, ["lane-record", "sendback", "lane-a", "--cause", "the card counted no rounds"]);
		assert.equal(first.status, 0, first.stderr);

		const second = runMuster(l, ["lane-record", "sendback", "lane-a", "--cause", "still no rounds"]);
		assert.notEqual(second.status, 0, "a second send-back with no review report between is refused");
		assert.match(second.stderr, /no review report came after it/);
		assert.equal(readLaneRecord(l.state, "lane-a")?.handoffs?.length, 1, "the refusal wrote nothing");

		recordReport(l.state, "lane-a", { kind: "review_ready", summary: "the rounds are on the card now", at: Date.now() + 1_000 });
		const accepted = runMuster(l, ["lane-record", "sendback", "lane-a", "--cause", "the title lost its words"]);
		assert.equal(accepted.status, 0, accepted.stderr);
		const record = readLaneRecord(l.state, "lane-a") as LaneRecord;
		assert.equal(roundsOf(record.handoffs), 2, "after a review report the second send-back is accepted and the rounds are two");
		assert.deepEqual(record.handoffs?.map((handoff) => handoff.cause), ["the card counted no rounds", "the title lost its words"]);

		// A closed lane takes neither: its handoffs are the ledger's history.
		const at = Date.now();
		writeLaneRecord(l.state, { ...closed(record, at), launchedAt: record.launchedAt });
		const closedSend = runMuster(l, ["lane-record", "sendback", "lane-a", "--cause", "after the merge"]);
		assert.notEqual(closedSend.status, 0);
		assert.match(closedSend.stderr, /merged: a handoff is written only on a live lane/);
		const closedAccept = runMuster(l, ["lane-record", "accept", "lane-a"]);
		assert.notEqual(closedAccept.status, 0);
		assert.equal(readLaneRecord(l.state, "lane-a")?.handoffs?.length, 2, "neither refused write touched the record");

		// A lane with no record at all is refused too.
		const nothing = runMuster(l, ["lane-record", "sendback", "lane-nothing"]);
		assert.notEqual(nothing.status, 0);
		assert.match(nothing.stderr, /no lane record for lane-nothing/);
	} finally {
		l.close();
	}
});

test("CRR 4: the title and the handoffs survive a files-mode write and a ledger round trip", async (t) => {
	const b = ledgerBox();
	t.after(b.close);

	// Files mode: today's store, with the new fields on it.
	const filesRecord = { laneId: "lane-a", harness: "pi" as const, cwd: b.root, branch: null, launchedAt: Date.now(), launchedBy: "orchestrator", phase: "working" as const, phaseSince: Date.now(), title: "The files store keeps the title", handoffs: undefined };
	writeLaneRecord(b.stateDir, filesRecord);
	const filesBack = readLaneRecord(b.stateDir, "lane-a") as LaneRecord;
	assert.equal(filesBack.title, "The files store keeps the title");
	assert.deepEqual(filesBack.handoffs, undefined);

	// The ledger: the record is a compare-and-set document there, and the fields travel with it.
	const daemon = startLedgerDaemon(t, b.ledgerDir);
	await daemon;
	const restore = useLedger(b);
	t.after(restore);
	assert.equal(backendState(b.stateDir).backend, "ledger", "the round trip runs on the lab ledger, not the files store");

	const launchedAt = Date.now();
	const launched = recordLaunch(b.stateDir, { laneId: "lane-b", harness: "pi", cwd: b.root, branch: null, title: "The ledger keeps the title" }, launchedAt);
	assert.equal(launched.title, "The ledger keeps the title");
	const handed = recordHandoff(b.stateDir, "lane-b", { by: "orchestrator", verdict: SENT_BACK, cause: "the ledger lost the cause", sha: "04a29d40", waits: "the cause on the record" }, launchedAt + 1_000);
	assert.equal(handed.handoffs?.length, 1);
	const ledgerBack = readLaneRecord(b.stateDir, "lane-b") as LaneRecord;
	assert.equal(ledgerBack.title, "The ledger keeps the title");
	assert.deepEqual(ledgerBack.handoffs, handed.handoffs, "the handoff travels as the record's own field");
	assert.equal(roundsOf(ledgerBack.handoffs), 1);
	assert.equal(ledgerBack.handoffs?.[0]?.sha, "04a29d40");
});

test("CRR 5: lane-outcome takes the rounds and the causes from the record and writes the goal and title cells", () => {
	const l = lab();
	try {
		assert.equal(runMuster(l, ["lane-record", "launch", "--lane", "lane-a", "--harness", "pi", "--cwd", l.root, "--title", "The row takes the record's rounds"]).status, 0);
		assert.equal(runMuster(l, ["lane-record", "sendback", "lane-a", "--cause", "the goal cell was empty"]).status, 0);
		recordReport(l.state, "lane-a", { kind: "review_ready", summary: "the goal cell has a code now", at: Date.now() + 1_000 });
		assert.equal(runMuster(l, ["lane-record", "sendback", "lane-a", "--cause", "the title cell lost its words"]).status, 0);

		// A goal holds the lane at close.
		const store = fileGoalStore(goalsDir(l.state));
		addGoal(store, { code: "AA", name: "Lane records", sub: "the lane record's fields", project: "pi", stations: [{ id: "wp1", name: "Fields" }] }, { by: "operator-shell", projectIds: ["pi"] });
		attachLane(store, "AA", "lane-a", "wp1", { by: "operator-shell" });

		writeLaneRecord(l.state, closed(readLaneRecord(l.state, "lane-a") as LaneRecord));
		const written = runMuster(l, ["lane-outcome", "lane-a", "--outcome", "merged"]);
		assert.equal(written.status, 0, written.stderr);
		const row = rowsOf(l.tsv)[1] as string[];
		assert.equal(row.length, HEADER_15.length, "one cell per column of the file's own header");
		assert.equal(row[7], "2", "the rounds are the record's send-backs");
		assert.equal(row[9], "the goal cell was empty, the title cell lost its words", "the causes follow in order");
		assert.equal(row[13], "AA", "the goal that holds the lane at close");
		assert.equal(row[14], "The row takes the record's rounds");
		assert.doesNotMatch(written.stderr, /has no .* column/);

		// A value the caller gives still wins, and a lane no goal holds says none.
		assert.equal(runMuster(l, ["lane-record", "launch", "--lane", "lane-b", "--harness", "pi", "--cwd", l.root, "--title", "A lane with no goal"]).status, 0);
		writeLaneRecord(l.state, closed(readLaneRecord(l.state, "lane-b") as LaneRecord));
		const given = runMuster(l, ["lane-outcome", "lane-b", "--rounds", "7", "--causes", "two rounds by hand", "--outcome", "merged"]);
		assert.equal(given.status, 0, given.stderr);
		const second = rowsOf(l.tsv)[2] as string[];
		assert.equal(second[7], "7", "a given --rounds wins over the record");
		assert.equal(second[9], "two rounds by hand");
		assert.equal(second[13], "none", "no goal holds this lane");
		assert.equal(second[14], "A lane with no goal");
	} finally {
		l.close();
	}
});

test("CRR 5: a lane-outcomes file with the older 13-column header still gets 13 cells, and the missing columns are named", () => {
	const l = lab(HEADER_13);
	try {
		assert.equal(runMuster(l, ["lane-record", "launch", "--lane", "lane-a", "--harness", "pi", "--cwd", l.root, "--title", "The old file keeps its width"]).status, 0);
		writeLaneRecord(l.state, closed(readLaneRecord(l.state, "lane-a") as LaneRecord));
		const written = runMuster(l, ["lane-outcome", "lane-a", "--outcome", "merged"]);
		assert.equal(written.status, 0, written.stderr);
		assert.match(written.stderr, /has no goal, title column yet; the row was written without them/);
		const row = rowsOf(l.tsv)[1] as string[];
		assert.equal(row.length, HEADER_13.length, "the row follows the file's own header");
		assert.equal(row[7], "0", "a lane with no send-back round");
		assert.equal(row[9], "none");
	} finally {
		l.close();
	}
});

test("CRL R2: a send-back that follows an acceptance is allowed, and the rounds count both send-backs", () => {
	const l = lab();
	try {
		assert.equal(runMuster(l, ["lane-record", "launch", "--lane", "lane-a", "--harness", "pi", "--cwd", l.root, "--title", "A lane sent back twice"]).status, 0);
		assert.equal(runMuster(l, ["lane-record", "sendback", "lane-a", "--cause", "the rounds were not counted"]).status, 0);
		const accepted = runMuster(l, ["lane-record", "accept", "lane-a", "--sha", "04a29d40"]);
		assert.equal(accepted.status, 0, accepted.stderr);
		const again = runMuster(l, ["lane-record", "sendback", "lane-a", "--cause", "the acceptance was premature"]);
		assert.equal(again.status, 0, again.stderr, "an accept between two send-backs clears the guard");
		const record = readLaneRecord(l.state, "lane-a") as LaneRecord;
		assert.equal(roundsOf(record.handoffs), 2, "two send-backs, two rounds");
	} finally {
		l.close();
	}
});

