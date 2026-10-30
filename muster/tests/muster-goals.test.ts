import "./muster-test-isolation.ts";
/**
 * WPG (command center blueprint r5, D1, R5.4 "WPG"): the goal registry.
 *
 * Every case that reads or writes a store runs once per backend: the files store under a temp
 * Muster state dir, and the ledger store against the real `musterd` in a disposable install
 * (`ledger-fixture.ts`). Nothing here reads or writes the live `state/muster`, the live ledger
 * or the live project register. The CLI verbs run through `command.run` with a fake `CliContext`,
 * the idiom `muster-asks.test.ts` uses.
 *
 * The acceptance items of R5.4 "WPG" are the numbered claims:
 * 1. `add` then `list --json` returns the record in both backends, and a second add is refused.
 * 2. `finish` from a lane session is refused, the operator's shell, the architect and the orchestrator are accepted.
 * 3. Attaching a lane that sits on another open goal moves it, and both goals log the move.
 * 4. Finishing WP4 before WP3 leaves WP3 the current station, and `reopen` undoes the finish.
 * 5. Export and import: `muster-goals-ledger.test.ts`.
 * 6. Validation refuses a bad code, an unknown project, an unknown colour, a station the goal does not
 *    have, and a newline in the name or the sub.
 * 7. `GOAL_COLOURS` is one exported constant.
 * 8. Two writers that read the same revision: the second is refused with the store's conflict error
 *    and changes nothing, and the first writer's event stays.
 *
 * The acceptance items of R7's CRG are the numbered claims:
 * 1. `cyan` is accepted by `add` and by `colour`.
 * 2. `colour NL cyan` writes one `colour` event, and `colour PP cyan` afterwards is refused because NL holds it.
 * 3. A record with a `colour` event validates (the ledger round trip is `muster-goals-ledger.test.ts`).
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { raiseAsk } from "../asks.ts";
import { command as goalsCommand } from "../cli/goals.ts";
import type { CliContext } from "../cli/types.ts";
import {
	GOAL_COLOURS,
	GoalStateError,
	addGoal,
	currentStation,
	finishStation,
	goalStore,
	listGoals,
	readGoal,
	validateGoalRecord,
	type GoalRecord,
	type GoalStore,
} from "../goals.ts";
import { readBackend } from "../ledger/backend.ts";
import { requestSync } from "../ledger/client-sync.ts";
import { GOAL_STORE, ownerLedgerSocket } from "../ledger/stores.ts";
import { claimSeat, resolveSeatWriter, seatContextFor } from "../seats.ts";
import { ledgerBox, startDaemon, useLedger } from "./ledger-fixture.ts";

type Backend = "files" | "ledger";
type Install = { stateDir: string; store: GoalStore };

/** A minimal valid register with two projects, so a test never reads the live `muster-projects.json`. */
function writeRegister(dir: string): string {
	const file = join(dir, "muster-projects.json");
	const project = (projectId: string, repo: string) => ({
		projectId,
		name: projectId,
		aliases: [],
		programmes: [{ programmeId: `agp_${repo.repeat(12)}`, checkoutRoot: `/tmp/${projectId}`, repoKey: `/tmp/${projectId}/.git`, parentAgentId: `${projectId}-parent` }],
	});
	writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: [project("alpha-project", "a"), project("beta-project", "b")] }));
	return file;
}

/** One install of the named backend, with the process env pointed at it. Restored when the test ends. */
async function install(t: TestContext, backend: Backend): Promise<Install> {
	const saved = { register: process.env["PI_MUSTER_PROJECTS_FILE"], state: process.env["PI_MUSTER_STATE_DIR"] };
	t.after(() => {
		if (saved.register === undefined) delete process.env["PI_MUSTER_PROJECTS_FILE"];
		else process.env["PI_MUSTER_PROJECTS_FILE"] = saved.register;
		if (saved.state === undefined) delete process.env["PI_MUSTER_STATE_DIR"];
		else process.env["PI_MUSTER_STATE_DIR"] = saved.state;
	});
	if (backend === "ledger") {
		const box = ledgerBox();
		t.after(box.close);
		await startDaemon(t, box.ledgerDir);
		t.after(useLedger(box));
		process.env["PI_MUSTER_PROJECTS_FILE"] = writeRegister(box.root);
		return { stateDir: box.stateDir, store: goalStore() };
	}
	const root = mkdtempSync(join(tmpdir(), "muster-goals-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const stateDir = join(root, "state", "muster");
	mkdirSync(stateDir, { recursive: true });
	process.env["PI_MUSTER_STATE_DIR"] = stateDir;
	process.env["PI_MUSTER_PROJECTS_FILE"] = writeRegister(root);
	return { stateDir, store: goalStore() };
}

/** the operator's own shell: no agent-session marker. */
const shellEnv = (): NodeJS.ProcessEnv => ({ PI_MUSTER_STATE_DIR: process.env["PI_MUSTER_STATE_DIR"] });

async function goals(argv: string[], options: { env?: NodeJS.ProcessEnv; agentId?: string; json?: boolean } = {}): Promise<{ code: number; out: string[]; err: string[] }> {
	const out: string[] = [];
	const err: string[] = [];
	const ctx: CliContext = {
		argv,
		repoRoot: "/tmp/no-repo",
		agentId: options.agentId,
		json: options.json ?? false,
		cwd: "/tmp/no-repo",
		env: options.env ?? shellEnv(),
		io: { out: (line) => out.push(line), err: (line) => err.push(line) },
		readStdin: async () => "",
	};
	const code = await goalsCommand.run(ctx);
	return { code, out, err };
}

async function ok(argv: string[], options: Parameters<typeof goals>[1] = {}): Promise<{ out: string[] }> {
	const run = await goals(argv, options);
	assert.equal(run.code, 0, `muster goals ${argv.join(" ")} failed: ${run.err.join("\n")}`);
	return run;
}

async function refused(argv: string[], pattern: RegExp, options: Parameters<typeof goals>[1] = {}): Promise<void> {
	const run = await goals(argv, options);
	assert.equal(run.code, 2, `muster goals ${argv.join(" ")} should be refused (exit ${run.code}): ${run.out.join("\n")}`);
	assert.match(run.err.join("\n"), pattern);
}

const addArgs = (code: string, project = "alpha-project", extra: string[] = []): string[] => [
	"add", code, "--name", `Goal ${code}`, "--sub", `About ${code}`, "--project", project,
	"--station", "wp3=WP3 sessions", "--station", "wp4=WP4 answers", ...extra,
];

const listJson = async (all = false): Promise<GoalRecord[]> =>
	JSON.parse((await ok(["list", ...(all ? ["--all"] : [])], { json: true })).out.join("\n")) as GoalRecord[];

/**
 * A goal record the owner's validation refuses, written the way only an out-of-band writer can:
 * a raw ledger write in ledger mode, a broken file in files mode.
 */
function seedMalformedGoal(stateDir: string, code: string): void {
	if (readBackend(stateDir) === "ledger") {
		requestSync(ownerLedgerSocket(stateDir), "casUpdate", { store: GOAL_STORE, id: code, expectedRevision: null, record: { name: "broken" } });
		return;
	}
	writeFileSync(join(stateDir, "goals", `${code}.json`), "{ not json");
}

for (const backend of ["files", "ledger"] as const) {
	// ─── 1. add, list, a second add refused ──────────────────────────────────────

	test(`WPG 1 (${backend}): add then list --json returns the record, and a second add of the code is refused`, async (t) => {
		const { store } = await install(t, backend);
		await ok(addArgs("PP", "alpha-project", ["--colour", "violet"]));
		const listed = await listJson();
		assert.equal(listed.length, 1);
		const goal = listed[0]!;
		assert.equal(goal.code, "PP");
		assert.equal(goal.name, "Goal PP");
		assert.equal(goal.sub, "About PP");
		assert.equal(goal.project, "alpha-project");
		assert.equal(goal.colour, "violet");
		assert.equal(goal.status, "open");
		assert.deepEqual(goal.stations.map((station) => [station.id, station.name]), [["wp3", "WP3 sessions"], ["wp4", "WP4 answers"]]);
		assert.deepEqual(goal.lanes, []);
		assert.deepEqual(goal.waitsOn, []);
		assert.equal(goal.events.length, 1);
		assert.equal(goal.events[0]!.verb, "add");
		assert.equal(goal.events[0]!.by, "operator-shell");
		assert.deepEqual(readGoal(store, "PP"), goal, "the store holds the record the verb printed");

		await refused(addArgs("PP", "beta-project"), /already exists|conflict/i);
		assert.equal((await listJson()).length, 1);
		assert.equal(readGoal(store, "PP")!.project, "alpha-project", "the refused add changed nothing");
	});

	// ─── 3. attach moves a lane ──────────────────────────────────────────────────

	test(`WPG 3 (${backend}): attaching a lane that sits on another open goal moves it, and both goals log the move`, async (t) => {
		const { store } = await install(t, backend);
		await ok(addArgs("AA"));
		await ok(addArgs("BB"));
		await ok(["attach", "AA", "pi-lane-x", "--station", "wp3"]);
		assert.deepEqual(readGoal(store, "AA")!.lanes, [{ lane: "pi-lane-x", station: "wp3" }]);

		await ok(["attach", "BB", "pi-lane-x", "--station", "wp4"]);
		const from = readGoal(store, "AA")!;
		const to = readGoal(store, "BB")!;
		assert.deepEqual(from.lanes, [], "the lane left the first goal");
		assert.deepEqual(to.lanes, [{ lane: "pi-lane-x", station: "wp4" }]);
		const left = from.events.at(-1)!;
		const arrived = to.events.at(-1)!;
		assert.equal(left.verb, "detach");
		assert.match(left.detail, /pi-lane-x/);
		assert.match(left.detail, /BB/, "the first goal's log names where the lane went");
		assert.equal(arrived.verb, "attach");
		assert.match(arrived.detail, /pi-lane-x/);
		assert.match(arrived.detail, /AA/, "the second goal's log names where the lane came from");

		// Running the same attach again changes nothing more (a crash between the two writes is finished by a rerun).
		const revision = to.revision;
		await ok(["attach", "BB", "pi-lane-x", "--station", "wp4"]);
		assert.equal(readGoal(store, "BB")!.revision, revision, "an attach that is already true writes nothing");
		await ok(["detach", "BB", "pi-lane-x"]);
		assert.deepEqual(readGoal(store, "BB")!.lanes, []);
		await refused(["detach", "BB", "pi-lane-x"], /not attached|no lane/i);
	});

	test(`WPG 3 (${backend}): a lane on a closed goal is free to attach elsewhere without a move`, async (t) => {
		const { store } = await install(t, backend);
		await ok(addArgs("AA"));
		await ok(addArgs("BB"));
		await ok(["attach", "AA", "pi-lane-y", "--station", "wp3"]);
		await ok(["close", "AA", "--outcome", "done"]);
		await ok(["attach", "BB", "pi-lane-y", "--station", "wp3"]);
		assert.deepEqual(readGoal(store, "BB")!.lanes, [{ lane: "pi-lane-y", station: "wp3" }]);
		assert.equal(readGoal(store, "BB")!.events.at(-1)!.detail.includes("AA"), false, "a closed goal is not a move");
	});

	// ─── 4. finish and reopen ────────────────────────────────────────────────────

	test(`WPG 4 (${backend}): finishing WP4 before WP3 leaves WP3 the current station, and reopen undoes a finish`, async (t) => {
		const { store } = await install(t, backend);
		await ok(addArgs("PP"));
		assert.equal(currentStation(readGoal(store, "PP")!)!.id, "wp3");
		await ok(["finish", "PP", "wp4"]);
		const afterFinish = readGoal(store, "PP")!;
		assert.ok(afterFinish.stations.find((station) => station.id === "wp4")!.finishedAt !== undefined);
		assert.equal(currentStation(afterFinish)!.id, "wp3", "stations finish in any order, the first unfinished one is current");
		await ok(["finish", "PP", "wp3"]);
		assert.equal(currentStation(readGoal(store, "PP")!), undefined, "every station finished: no current station");
		await ok(["reopen", "PP", "wp4"]);
		const reopened = readGoal(store, "PP")!;
		assert.equal(reopened.stations.find((station) => station.id === "wp4")!.finishedAt, undefined);
		assert.equal(currentStation(reopened)!.id, "wp4");
		assert.deepEqual(reopened.events.map((event) => event.verb), ["add", "finish", "finish", "reopen"]);
		await refused(["finish", "PP", "wp3"], /already finished/i);
		await refused(["reopen", "PP", "wp4"], /not finished|already open/i);
	});

	// ─── 6. validation ───────────────────────────────────────────────────────────

	test(`WPG 6 (${backend}): validation refuses a bad code, an unknown project, an unknown colour, an unknown station and a newline`, async (t) => {
		const { store } = await install(t, backend);
		for (const code of ["A", "ABC", "a1", "Ab", "A1", "A_", "É1"]) {
			await refused(addArgs(code), /two capital letters|code/i);
		}
		await refused(addArgs("AA", "no-such-project"), /unknown project|not registered/i);
		await refused(addArgs("AA", "alpha-project", ["--colour", "red"]), /colour/i);
		await refused(addArgs("AA", "alpha-project", ["--colour", "chartreuse"]), /colour/i);
		await refused(["add", "AA", "--name", "two\nlines", "--sub", "ok", "--project", "alpha-project", "--station", "s1=One"], /one line|newline/i);
		await refused(["add", "AA", "--name", "ok", "--sub", "two\r\nlines", "--project", "alpha-project", "--station", "s1=One"], /one line|newline/i);
		await refused(["add", "AA", "--name", "ok", "--sub", "ok", "--project", "alpha-project"], /station/i);
		await refused(["add", "AA", "--name", "ok", "--sub", "ok", "--project", "alpha-project", "--station", "s1=One", "--station", "s1=Again"], /duplicate|twice/i);
		assert.deepEqual(listGoals(store, { all: true }).goals, [], "no refused add wrote anything");

		await ok(addArgs("AA"));
		const before = readGoal(store, "AA")!;
		await refused(["finish", "AA", "nope"], /station/i);
		await refused(["reopen", "AA", "nope"], /station/i);
		await refused(["attach", "AA", "pi-lane-z", "--station", "nope"], /station/i);
		await refused(["station", "AA", "wp3", "--before", "nope"], /station/i);
		await refused(["attach", "AA", "bad lane id", "--station", "wp3"], /lane/i);
		await refused(["station", "AA", "wp3", "--owner", "two words"], /owner/i);
		await refused(["station", "AA", "wp3", "--timer", "not-a-timer.service"], /timer/i);
		await refused(["station", "AA", "wp3", "--name", "line\nbreak"], /one line|newline/i);
		await refused(["station", "AA", "new-one"], /name/i);
		await refused(["close", "AA", "--outcome", "finished"], /outcome/i);
		await refused(["close", "AA"], /outcome/i);
		await refused(["show", "ZZ"], /no goal/i);
		assert.deepEqual(readGoal(store, "AA"), before, "no refused write changed the goal");
	});

	// ─── 8. two writers on one revision ──────────────────────────────────────────

	test(`WPG 8 (${backend}): the second of two writers that read the same revision is refused, changes nothing, and the first writer's event stays`, async (t) => {
		const { store } = await install(t, backend);
		const ctx = { by: "orchestrator" as const };
		addGoal(store, { code: "AA", name: "Goal", sub: "Sub", project: "alpha-project", stations: [{ id: "s1", name: "One" }, { id: "s2", name: "Two" }] }, ctx);
		const seen = readGoal(store, "AA")!;
		// The second writer's view: it read the goal before the first writer committed.
		const staleView: GoalStore = { ...store, read: () => seen };

		finishStation(store, "AA", "s1", ctx);
		const afterFirst = readGoal(store, "AA")!;
		assert.ok(afterFirst.revision > seen.revision);

		assert.throws(
			() => finishStation(staleView, "AA", "s2", ctx),
			(error: unknown) => error instanceof GoalStateError && error.code === "conflict",
		);
		const final = readGoal(store, "AA")!;
		assert.deepEqual(final, afterFirst, "the refused write changed nothing");
		assert.equal(final.stations.find((station) => station.id === "s2")!.finishedAt, undefined);
		assert.deepEqual(final.events.map((event) => event.verb), ["add", "finish"], "the first writer's event stays");

		// The writer runs the verb again and it lands.
		finishStation(store, "AA", "s2", ctx);
		assert.deepEqual(readGoal(store, "AA")!.events.map((event) => event.verb), ["add", "finish", "finish"]);
	});

	// ─── The rest of the verbs ───────────────────────────────────────────────────

	test(`WPG (${backend}): station adds and edits a station, wait and unwait link an ask, close ends a goal`, async (t) => {
		const { store, stateDir } = await install(t, backend);
		await ok(addArgs("AA"));
		await ok(["station", "AA", "wp5", "--name", "WP5 ship", "--owner", "orchestrator", "--timer", "learning-digest.timer", "--before", "wp4"]);
		let goal = readGoal(store, "AA")!;
		assert.deepEqual(goal.stations.map((station) => station.id), ["wp3", "wp5", "wp4"], "--before puts the new station ahead of wp4");
		assert.equal(goal.stations[1]!.owner, "orchestrator");
		assert.equal(goal.stations[1]!.timer, "learning-digest.timer");
		await ok(["station", "AA", "wp5", "--owner", "pi-lane-q", "--timer", ""]);
		goal = readGoal(store, "AA")!;
		assert.equal(goal.stations[1]!.owner, "pi-lane-q");
		assert.equal(goal.stations[1]!.timer, undefined, "an empty value clears it");
		assert.equal(goal.stations[1]!.name, "WP5 ship", "an edit leaves what it does not name");
		await ok(["station", "AA", "wp3", "--before", "wp5"]);
		await ok(["station", "AA", "wp4", "--before", "wp3"]);
		assert.deepEqual(readGoal(store, "AA")!.stations.map((station) => station.id), ["wp4", "wp3", "wp5"], "--before moves an existing station");

		const ask = raiseAsk(stateDir, { by: "architect", kind: "product-decision", question: "Which colour?", code: "Q1" });
		await ok(["wait", "AA", "Q1"]);
		assert.deepEqual(readGoal(store, "AA")!.waitsOn, [ask.id], "a code resolves to the ask id");
		await ok(["wait", "AA", ask.id]);
		assert.deepEqual(readGoal(store, "AA")!.waitsOn, [ask.id], "waiting twice on one ask lists it once");
		await refused(["wait", "AA", "no-such-ask"], /ask/i);
		await ok(["unwait", "AA", ask.id]);
		assert.deepEqual(readGoal(store, "AA")!.waitsOn, []);
		await refused(["unwait", "AA", ask.id], /not waiting|does not wait/i);

		await ok(["close", "AA", "--outcome", "dropped"]);
		goal = readGoal(store, "AA")!;
		assert.equal(goal.status, "dropped");
		assert.ok(goal.closedAt !== undefined);
		assert.equal(goal.events.at(-1)!.verb, "close");
		assert.deepEqual(await listJson(), [], "list shows open goals only");
		assert.equal((await listJson(true)).length, 1, "--all shows the closed one");
		await refused(["finish", "AA", "wp3"], /closed/i);
		await refused(["close", "AA", "--outcome", "done"], /closed/i);
		const shown = await ok(["show", "AA"]);
		assert.match(shown.out.join("\n"), /dropped/);
	});

	test(`WPG (${backend}): a goal with no colour takes the first one no open goal uses, else blue`, async (t) => {
		const { store } = await install(t, backend);
		await ok(addArgs("AA"));
		await ok(addArgs("BB"));
		await ok(addArgs("CC", "alpha-project", ["--colour", "violet"]));
		await ok(addArgs("DD"));
		assert.deepEqual(["AA", "BB", "CC", "DD"].map((code) => readGoal(store, code)!.colour), ["blue", "green", "violet", "orange"]);
		await ok(["close", "AA", "--outcome", "done"]);
		await ok(addArgs("EE"));
		assert.equal(readGoal(store, "EE")!.colour, "blue", "a closed goal frees its colour");
		// With every colour in use the default is blue.
		for (const [index, colour] of GOAL_COLOURS.entries()) {
			if (["blue", "green", "violet", "orange"].includes(colour)) continue;
			await ok(addArgs(`F${String.fromCharCode(65 + index)}`, "alpha-project", ["--colour", colour]));
		}
		await ok(addArgs("ZZ"));
		assert.equal(readGoal(store, "ZZ")!.colour, "blue");
	});

	// ─── CRG 1 and 2: the ninth colour and the colour verb ──────────────────────

	test(`CRG 1 (${backend}): cyan is accepted by add and by colour, and red is never one`, async (t) => {
		const { store } = await install(t, backend);
		await ok(addArgs("CY", "alpha-project", ["--colour", "cyan"]));
		assert.equal(readGoal(store, "CY")!.colour, "cyan");
		// The verb takes cyan once CY has moved off it.
		await ok(["colour", "CY", "blue"]);
		assert.equal(readGoal(store, "CY")!.colour, "blue");
		await ok(addArgs("NL"));
		await ok(["colour", "NL", "cyan"]);
		assert.equal(readGoal(store, "NL")!.colour, "cyan");
		await refused(["colour", "CY", "red"], /colour/i);
		await refused(["colour", "CY", "chartreuse"], /colour/i);
		assert.equal(readGoal(store, "CY")!.colour, "blue", "a refused colour changed nothing");
	});

	test(`CRG 2 (${backend}): colour writes one event, and a key another open goal holds is refused`, async (t) => {
		const { store } = await install(t, backend);
		await ok(addArgs("NL"));
		await ok(addArgs("PP"));
		const before = readGoal(store, "NL")!;
		await ok(["colour", "NL", "cyan"]);
		const goal = readGoal(store, "NL")!;
		assert.equal(goal.colour, "cyan");
		assert.equal(goal.revision, before.revision + 1);
		assert.equal(goal.events.length, before.events.length + 1, "one event");
		const event = goal.events.at(-1)!;
		assert.equal(event.verb, "colour");
		assert.equal(event.detail, "colour blue to cyan");
		assert.equal(event.by, "operator-shell");

		await refused(["colour", "PP", "cyan"], /NL/);
		const pp = readGoal(store, "PP")!;
		assert.equal(pp.colour, "green", "the refusal left PP's colour as it was");
		assert.equal(pp.events.length, 1, "the refusal wrote no event");

		await ok(["colour", "NL", "cyan"]);
		assert.deepEqual(readGoal(store, "NL"), goal, "a repeat of the goal's own colour writes nothing");
	});

	test(`CRG 3 (${backend}): a record with a colour event validates`, async (t) => {
		const { store } = await install(t, backend);
		await ok(addArgs("NL"));
		await ok(["colour", "NL", "cyan"]);
		const raw = readGoal(store, "NL")!;
		assert.deepEqual(validateGoalRecord(raw), { ok: true, record: raw });
	});

	// ─── A malformed record is skipped and reported, never a throw for the whole list ──────────

	test(`WPG (${backend}): a malformed goal record is skipped and reported, and the other goals still list`, async (t) => {
		const { store, stateDir } = await install(t, backend);
		await ok(addArgs("AA"));
		await ok(addArgs("BB"));
		seedMalformedGoal(stateDir, "CC");

		const listing = listGoals(store, { all: true });
		assert.deepEqual(listing.goals.map((goal) => goal.code), ["AA", "BB"], "the good goals still list");
		assert.equal(listing.skipped.length, 1, "one record is skipped");
		assert.equal(listing.skipped[0]!.id, "CC", "the skipped record is named");
		assert.ok(listing.skipped[0]!.error.length > 0, "the skipped record says why");

		// The CLI reports it the way the files store does, and the list itself still succeeds.
		const run = await goals(["list", "--all"], { json: true });
		assert.equal(run.code, 0, `the list failed: ${run.err.join("\n")}`);
		assert.deepEqual((JSON.parse(run.out.join("\n")) as GoalRecord[]).map((goal) => goal.code), ["AA", "BB"]);
		assert.match(run.err.join("\n"), /skipped CC/);
	});
}

// ─── 2. the writer is the process ───────────────────────────────────────────────

test("WPG 2: finish from a lane session is refused; the operator's shell, the architect and the orchestrator are accepted", async (t) => {
	const { store, stateDir } = await install(t, "files");
	await ok(addArgs("AA"));

	const base = { ...shellEnv(), CLAUDECODE: "1" };
	const architect = claimSeat("architect", { harness: "claude", sessionId: "s-arch", processKey: "claude-1-1-1" }, { kind: "in-process" }, seatContextFor(base));
	const orchestrator = claimSeat("orchestrator", { harness: "claude", sessionId: "s-orch", processKey: "claude-2-2-2" }, { kind: "in-process" }, seatContextFor(base));
	const asArchitect = { ...base, MUSTER_SEAT: "architect", MUSTER_SEAT_TOKEN: architect.token, CONCORD_AGENT_ID: "pb3fix" };
	const asOrchestrator = { ...base, MUSTER_SEAT: "orchestrator", MUSTER_SEAT_TOKEN: orchestrator.token, CONCORD_AGENT_ID: "pb3fix" };
	const asLane = { ...base, CONCORD_AGENT_ID: "pb3fix" };
	void stateDir;

	// A lane, a seat name without the credential, and a stale credential: refused, nothing written.
	await refused(["finish", "AA", "wp3"], /goals are written by/i, { env: asLane, agentId: "pb3fix" });
	await refused(["add", ...addArgs("BB").slice(1)], /goals are written by/i, { env: asLane, agentId: "pb3fix" });
	await refused(["finish", "AA", "wp3"], /seat|architect/i, { env: { ...asArchitect, MUSTER_SEAT_TOKEN: `s0.${"ab".repeat(32)}` }, agentId: "pb3fix" });
	await refused(["finish", "AA", "wp3"], /seat|architect/i, { env: { ...base, CONCORD_AGENT_ID: "architect" }, agentId: "architect" });
	assert.equal(readGoal(store, "AA")!.stations[0]!.finishedAt, undefined, "the refusals wrote nothing");
	assert.equal(readGoal(store, "BB"), undefined);

	await ok(["finish", "AA", "wp3"], { env: asArchitect, agentId: "pb3fix" });
	await ok(["finish", "AA", "wp4"], { env: asOrchestrator, agentId: "pb3fix" });
	await ok(["reopen", "AA", "wp4"]);
	assert.deepEqual(readGoal(store, "AA")!.events.map((event) => `${event.verb}:${event.by}`), [
		"add:operator-shell",
		"finish:architect",
		"finish:orchestrator",
		"reopen:operator-shell",
	]);
});

test("WPG 2 (ledger): the seat-writer rule holds with the ledger backend: the orchestrator writes, a lane does not", async (t) => {
	const { stateDir } = await install(t, "ledger");
	const base = { ...shellEnv(), CLAUDECODE: "1" };
	const orchestrator = claimSeat("orchestrator", { harness: "claude", sessionId: "s-orch", processKey: "claude-2-2-2" }, { kind: "in-process" }, seatContextFor(base));
	const asOrchestrator = { ...base, MUSTER_SEAT: "orchestrator", MUSTER_SEAT_TOKEN: orchestrator.token, CONCORD_AGENT_ID: "pi-lane-goalsfix" };
	const asLane = { ...base, CONCORD_AGENT_ID: "pi-lane-goalsfix" };
	const asImpostor = { ...base, MUSTER_SEAT: "orchestrator", CONCORD_AGENT_ID: "pi-lane-goalsfix" };

	assert.equal(existsSync(join(stateDir, "seats", "orchestrator.json")), false, "the seat lives in the ledger, not in a file");

	// The orchestrator's seat, claimed in the ledger, writes.
	assert.deepEqual(resolveSeatWriter(asOrchestrator, "pi-lane-goalsfix", seatContextFor(asOrchestrator), () => "never"), { writer: "orchestrator" });
	// A lane is refused, the way it is in files mode.
	const lane = resolveSeatWriter(asLane, "pi-lane-goalsfix", seatContextFor(asLane), (named) => `${named} may not write a thing`);
	assert.ok("error" in lane, `a lane is refused: ${JSON.stringify(lane)}`);
	assert.match(lane.error, /pi-lane-goalsfix/);
	// A lane that names the seat without the credential is refused too: the seat record the ledger
	// holds is the authority, so naming it is not enough.
	const impostor = resolveSeatWriter(asImpostor, "pi-lane-goalsfix", seatContextFor(asImpostor), () => "never");
	assert.ok("error" in impostor, `a lane without the credential is refused: ${JSON.stringify(impostor)}`);
});

test("WPG 2: the seat-writer rule is one function that the ask queue and the goals both call", () => {
	assert.deepEqual(resolveSeatWriter({}, undefined, undefined, () => "never"), { writer: "operator-shell" });
	const refusal = resolveSeatWriter({ CONCORD_AGENT_ID: "pi-lane" }, "pi-lane", undefined, (named) => `${named} may not write a thing`);
	assert.deepEqual(refusal, { error: "pi-lane may not write a thing" });
});

// ─── 7. one colour constant ─────────────────────────────────────────────────────

test("WPG 7: GOAL_COLOURS is one exported constant of the nine line colours (the mockup's eight plus cyan), and red is not one", () => {
	assert.deepEqual([...GOAL_COLOURS], ["blue", "green", "violet", "orange", "teal", "gold", "brown", "magenta", "cyan"]);
	assert.equal((GOAL_COLOURS as readonly string[]).includes("red"), false);
	assert.equal(GOAL_STORE, "goal");
});
