/**
 * The steer layer's own tests (S-steer, `~/research/router-steers-2026-10-29/architecture-v2.md` sections 3,
 * 4, 7 and 9; findings 1, 2, 4, 6, 10, 14 and 21).
 *
 * What this file proves, one case each:
 * - the journal is the record: an add reads back as written, a retire is a second line, and a refused steer
 *   leaves no line at all;
 * - two writers cannot interleave (four real processes appending at once) and a stale lock is taken;
 * - a torn last line is skipped with a warning, so a crashed write leaves the journal readable;
 * - expiry is per type at the reading's own clock, and a `manual` steer stays live past its review;
 * - a project, harness or account scope is applied where the placement is made, and nowhere else;
 * - a demote never empties a chain and a prefer never puts back a the operator exclude;
 * - capacity is its own record, scoped and expiring;
 * - `routing.paused` is the operator's, untouched, and a steer cannot lift it;
 * - the pool file is never written and the base a caller holds is never mutated;
 * - the same journal places the same way twice;
 * - compaction keeps every live record and drops what the retention window has passed;
 * - a full placement reads the composed file, and the read fails open to the base.
 */

// The placement reads two files besides the pool: the usage snapshot (headroom) and the plan inventory
// (refills). Both are named once, before any test runs, and neither exists: a missing reading leaves that
// step out, which is what these cases want.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parsePoolConfig, placeLaneModel, TASK_KINDS, type PoolConfig, type TaskKind } from "../provider-pool.ts";
import {
	addCapOverride,
	addSteer,
	applySteers,
	compactSteerJournal,
	loadSteeredPool,
	readSteerJournal,
	retireSteer,
	STEER_JOURNAL_MAX_BYTES,
	STEER_MAX_AHEAD_MS,
	steerExpiresAt,
	steersJournalPath,
	steersLockPath,
	steerView,
	type SteerJournalRead,
} from "../steers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SCRATCH = mkdtempSync(join(tmpdir(), "steer-layer-"));
process.env["PI_USAGE_SNAPSHOT_PATH"] = join(SCRATCH, "no-snapshot.json");
process.env["PI_SUBSCRIPTIONS_PATH"] = join(SCRATCH, "no-inventory.json");
process.env["PI_PROVIDER_WALLS_PATH"] = join(SCRATCH, "no-walls.json");

const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const XAI = "xai/grok-4.6";
const ZAI = "zai/glm-5.3-flash";
const MM = "minimax/MiniMax-M3.1-Flash";
const FREE = "opencode/free-one";

const HARD_KINDS: readonly TaskKind[] = ["retry", "unknown-cause-bug", "shared-owner", "security-data", "perf"];

/** The pool file every case stands on: three providers, a free ref, and a routing table that places. */
function poolFile(): Record<string, unknown> {
	const policy = Object.fromEntries(TASK_KINDS.map((kind) => [kind, HARD_KINDS.includes(kind) ? [ZAI, MM] : [XAI, ZAI]]));
	return {
		version: 1,
		_note: "steer-layer test fixture",
		virtualProvider: "pool",
		cooldownMs: HOUR,
		resetHorizonMs: 3_024_000_000,
		freeRefs: [FREE],
		employerAccounts: [],
		laneDefaults: {
			pi: { candidates: [XAI, ZAI, FREE], fallbackRole: "session", hard: [ZAI, MM] },
			opencode: [FREE],
			claude: "sonnet",
		},
		nonChatRoles: ["classifier"],
		providerWalls: {},
		roles: { session: [XAI, ZAI, FREE], review: [ZAI, XAI], verify: [MM, ZAI], classifier: [ZAI] },
		routing: { pick: "on", slots: 7, claudeMax: 2, hardMax: 2, paused: [], policy, kindRules: {} },
		quotaShapes: [{ id: "wall", match: "QUOTA_WALL" }],
	};
}

function configOf(file: Record<string, unknown> = poolFile()): PoolConfig {
	const parsed = parsePoolConfig(file);
	assert.ok(parsed.ok, parsed.ok ? "" : parsed.errors.join("; "));
	assert.deepEqual(parsed.warnings ?? [], [], "the fixture's routing section never drops");
	return parsed.config;
}

function scratchDir(name: string): string {
	const dir = join(SCRATCH, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function journalIn(name: string): string {
	return join(scratchDir(name), "steers.jsonl");
}

function emptyRead(): SteerJournalRead {
	return { entries: [], warnings: [] };
}

function readOf(...records: Array<Parameters<typeof JSON.stringify>[0]>): SteerJournalRead {
	const path = join(scratchDir("reads"), `journal-${Math.random().toString(36).slice(2)}.jsonl`);
	writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
	return readSteerJournal(path);
}

let counter = 0;
function add(input: Partial<Parameters<typeof addSteer>[0]> & { journalPath?: string } = {}) {
	counter += 1;
	const { journalPath, ...rest } = input;
	return addSteer(
		{
			author: "operator",
			action: "exclude",
			scope: { ref: XAI },
			reason: `test steer ${counter}`,
			expiry: { type: "at", at: new Date(NOW + 6 * HOUR).toISOString() },
			now: NOW,
			...rest,
		},
		{ journalPath: journalPath ?? journalIn(`add-${counter}`) },
	);
}

test("the journal is the record: an add reads back as written, a retire is a second line", () => {
	const journalPath = journalIn("record");
	const written = add({ journalPath });
	assert.ok(written.ok);
	const first = readSteerJournal(journalPath);
	assert.equal(first.entries.length, 1);
	assert.deepEqual(first.entries[0]?.record, written.record, "the record the verb printed is the line the journal holds");
	assert.equal(first.warnings.length, 0);
	assert.equal((statSync(journalPath).mode & 0o777).toString(8), "600", "a journal this call creates is 0600");

	const retired = retireSteer(written.record.id, "orchestrator", { journalPath, now: NOW + HOUR });
	assert.ok(retired.ok);
	const second = readSteerJournal(journalPath);
	assert.equal(second.entries.length, 1, "a retirement adds a line, never a record");
	assert.equal(second.entries[0]?.retiredAt, new Date(NOW + HOUR).toISOString());
	assert.equal(second.entries[0]?.retiredBy, "orchestrator");
	assert.equal(readFileSync(journalPath, "utf8").trim().split("\n").length, 2, "the add line is still there");
	assert.equal(steerView(second, NOW + 2 * HOUR)[0]?.live, false);

	const again = retireSteer(written.record.id, "orchestrator", { journalPath, now: NOW + 2 * HOUR });
	assert.equal(again.ok, false, "a second retirement is a refusal");
	assert.equal(retireSteer("st-nothing", "operator", { journalPath }).ok, false, "an unknown id is a refusal");
});

test("a refused steer leaves no line", () => {
	const journalPath = journalIn("refused");
	const day = 24 * HOUR;
	const cases: Array<[string, Parameters<typeof addSteer>[0]]> = [
		["an author the channel would not name", { author: "pi-lane-abc", action: "exclude", scope: {}, reason: "x", expiry: { type: "at", at: new Date(NOW + HOUR).toISOString() }, now: NOW }],
		["no reason", { author: "operator", action: "exclude", scope: {}, reason: "   ", expiry: { type: "at", at: new Date(NOW + HOUR).toISOString() }, now: NOW }],
		["an expiry further than seven days", { author: "operator", action: "exclude", scope: {}, reason: "x", expiry: { type: "at", at: new Date(NOW + STEER_MAX_AHEAD_MS + day).toISOString() }, now: NOW }],
		["an expiry already passed", { author: "operator", action: "exclude", scope: {}, reason: "x", expiry: { type: "at", at: new Date(NOW - HOUR).toISOString() }, now: NOW }],
		["an action that is not one", { author: "operator", action: "pause" as never, scope: {}, reason: "x", expiry: { type: "at", at: new Date(NOW + HOUR).toISOString() }, now: NOW }],
		["a ref that is not provider/model", { author: "operator", action: "exclude", scope: { ref: "grok" }, reason: "x", expiry: { type: "at", at: new Date(NOW + HOUR).toISOString() }, now: NOW }],
	];
	for (const [why, input] of cases) {
		const refused = addSteer(input, { journalPath });
		assert.equal(refused.ok, false, why);
	}
	const cap = (field: string, extra: Record<string, unknown> = {}) =>
		addCapOverride({ author: "operator", scope: {}, field: field as never, value: 0, until: new Date(NOW + HOUR).toISOString(), reason: "x", now: NOW, ...extra }, { journalPath });
	assert.equal(cap("pick").ok, false, "pick is not capacity");
	assert.equal(cap("paused").ok, false, "a pause is the operator's word, not a steer");
	assert.equal(cap("claudeMax", { value: -1 }).ok, false, "a cap is zero or more");
	assert.equal(cap("claudeMax", { until: new Date(NOW - HOUR).toISOString() }).ok, false, "a cap carries a clock");
	assert.equal(readSteerJournal(journalPath).entries.length, 0, "not one refusal left a line");
});

test("two writers cannot interleave: four processes append whole lines at once", async () => {
	const journalPath = journalIn("concurrent");
	const script = join(scratchDir("concurrent"), "writer.mjs");
	writeFileSync(
		script,
		[
			`import { addSteer } from ${JSON.stringify(join(ROOT, "routing", "steers.ts"))};`,
			"const [journalPath, tag, count] = process.argv.slice(2);",
			"for (let index = 0; index < Number(count); index += 1) {",
			"  const written = addSteer({",
			"    author: 'operator',",
			"    action: 'exclude',",
			`    scope: { ref: \`xai/\${tag}-\${index}\` },`,
			"    reason: 'concurrent add',",
			`    expiry: { type: 'manual', reviewAt: new Date(Date.now() + 86_400_000).toISOString() },`,
			"  }, { journalPath });",
			"  if (!written.ok) { console.error(JSON.stringify(written.errors)); process.exit(1); }",
			"}",
		].join("\n"),
	);
	const runs = ["one", "two", "three", "four"].map(
		(tag) =>
			new Promise<number>((resolve, reject) => {
				const child = spawn(process.execPath, [script, journalPath, tag, "8"], { stdio: ["ignore", "pipe", "pipe"] });
				let err = "";
				child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
				child.on("error", reject);
				child.on("exit", (code) => (code === 0 ? resolve(code) : reject(new Error(`${tag} exited ${code}: ${err}`))));
			}),
	);
	await Promise.all(runs);
	const read = readSteerJournal(journalPath);
	assert.equal(read.warnings.length, 0, "no writer left a torn line");
	assert.equal(read.entries.length, 32, "every add landed exactly once");
	assert.equal(new Set(read.entries.map((entry) => entry.record.id)).size, 32, "no id is shared");
	assert.equal(readFileSync(journalPath, "utf8").trim().split("\n").length, 32, "one line per add, nothing interleaved");
});

test("a live lock makes a writer wait, and a stale lock is taken", () => {
	const journalPath = journalIn("lock");
	const lockPath = steersLockPath(journalPath);
	mkdirSync(dirname(lockPath), { recursive: true });
	writeFileSync(lockPath, "999999 now\n");

	const blocked = addSteer(
		{ author: "operator", action: "exclude", scope: {}, reason: "waits", expiry: { type: "at", at: new Date(NOW + HOUR).toISOString() }, now: NOW },
		{ journalPath, lockWaitMs: 40 },
	);
	assert.equal(blocked.ok, false);
	assert.match(blocked.ok ? "" : blocked.errors.join(" "), /another writer holds/);

	const old = new Date(Date.now() - 120_000);
	utimesSync(lockPath, old, old);
	const taken = addSteer(
		{ author: "operator", action: "exclude", scope: {}, reason: "takes the stale lock", expiry: { type: "at", at: new Date(NOW + HOUR).toISOString() }, now: NOW },
		{ journalPath, lockWaitMs: 2_000 },
	);
	assert.ok(taken.ok, taken.ok ? "" : taken.errors.join("; "));
	assert.equal(statSync(lockPath, { throwIfNoEntry: false }), undefined, "the writer releases its lock");
});

test("a torn last line is skipped with a warning, so a crashed write leaves the journal readable", () => {
	const journalPath = journalIn("torn");
	assert.ok(add({ journalPath }).ok);
	writeFileSync(journalPath, `${readFileSync(journalPath, "utf8")}{"op":"add","kind":"steer","id":"st-tor`, { flag: "a" });
	const read = readSteerJournal(journalPath);
	assert.equal(read.entries.length, 1, "the whole line before the tear still reads");
	assert.equal(read.warnings.length, 1);
	assert.match(read.warnings[0] as string, /^line \d+ skipped: /);
	const steered = applySteers(configOf(), read, { now: NOW });
	assert.equal(steered.roles["session"]?.includes(XAI), false, "the journal that still reads still applies");
});

test("expiry is per type at the reading's own clock, and a manual steer stays live past its review", () => {
	const journalPath = journalIn("expiry");
	const at = add({ journalPath, action: "exclude", scope: { ref: XAI }, expiry: { type: "at", at: new Date(NOW + HOUR).toISOString() } });
	const meter = add({ journalPath, action: "exclude", scope: { ref: ZAI }, expiry: { type: "meter-reset", meter: "zai", fallbackAt: new Date(NOW + 3 * HOUR).toISOString() } });
	const manual = add({ journalPath, action: "demote", scope: { ref: MM }, expiry: { type: "manual", reviewAt: new Date(NOW + HOUR).toISOString() } });
	assert.ok(at.ok && meter.ok && manual.ok);

	const later = steerView(readSteerJournal(journalPath), NOW + 2 * HOUR);
	assert.deepEqual(
		later.map((entry) => [entry.record.id, entry.live]),
		[
			[at.ok ? at.record.id : "", false],
			[meter.ok ? meter.record.id : "", true],
			[manual.ok ? manual.record.id : "", true],
		],
		"at lifts at its clock; a meter-reset steer holds to its fallback; a manual steer stays live",
	);
	assert.equal(later[2]?.reviewDue, true, "the manual steer's review is due, and it is still live");
	const withMeter = steerView(readSteerJournal(journalPath), NOW + 2 * HOUR, { meterResetAt: () => NOW + 30 * 60_000 });
	assert.equal(withMeter[1]?.live, false, "the meter's own reset lifts it earlier than the fallback");
	assert.equal(steerExpiresAt((meter as { record: never }).record, { meterResetAt: () => NOW + 1000 }), NOW + 1000);
});

test("a project, harness or account scope applies where the placement is made, and nowhere else", () => {
	const base = configOf();
	const journal = readOf(
		{ op: "add", kind: "steer", id: "st-project", scope: { project: "muster", ref: XAI }, action: "exclude", reason: "for muster only", author: "operator", source: { ts: new Date(NOW).toISOString() }, expiry: { type: "manual", reviewAt: new Date(NOW + DAY).toISOString() }, createdAt: new Date(NOW).toISOString() },
		{ op: "add", kind: "steer", id: "st-opencode", scope: { harness: "opencode" }, action: "exclude", reason: "no free model on opencode lanes", author: "operator", source: { ts: new Date(NOW).toISOString() }, expiry: { type: "manual", reviewAt: new Date(NOW + DAY).toISOString() }, createdAt: new Date(NOW).toISOString() },
		{ op: "add", kind: "steer", id: "st-account", scope: { account: "acme-realty", ref: ZAI }, action: "exclude", reason: "the employer account is out of quota", author: "operator", source: { ts: new Date(NOW).toISOString() }, expiry: { type: "manual", reviewAt: new Date(NOW + DAY).toISOString() }, createdAt: new Date(NOW).toISOString() },
	);
	const inMuster = applySteers(base, journal, { now: NOW, project: "muster", harness: "pi" });
	assert.equal(inMuster.roles["session"]?.includes(XAI), false, "the project scope applies inside its project");
	assert.equal(inMuster.laneDefaults?.opencode.includes(FREE), true, "a project scope never reaches another harness's list");
	const elsewhere = applySteers(base, journal, { now: NOW, project: "muster-lane-steerlayer", harness: "pi" });
	assert.equal(elsewhere.roles["session"]?.includes(XAI), true, "and not outside it");
	const opencode = applySteers(base, journal, { now: NOW, project: "muster", harness: "opencode" });
	assert.deepEqual(opencode.laneDefaults?.opencode, [], "the harness scope empties only its own list");
	assert.equal(applySteers(base, journal, { now: NOW, harness: "pi" }).roles["session"]?.includes(ZAI), true, "an account scope waits for a placement that names the account");
	assert.equal(applySteers(base, journal, { now: NOW, harness: "pi", account: "acme-realty" }).roles["session"]?.includes(ZAI), false);
});

test("a demote never empties a chain, and a prefer never puts back a the operator exclude", () => {
	const base = configOf();
	const demote = readOf({ op: "add", kind: "steer", id: "st-demote", scope: { role: "session", ref: XAI }, action: "demote", reason: "sits behind", author: "operator", source: { ts: new Date(NOW).toISOString() }, expiry: { type: "manual", reviewAt: new Date(NOW + DAY).toISOString() }, createdAt: new Date(NOW).toISOString() });
	const demoted = applySteers(base, demote, { now: NOW, role: "session" });
	assert.deepEqual(demoted.roles["session"], [ZAI, FREE, XAI], "the demoted ref keeps its place at the end");
	assert.deepEqual(demoted.roles["review"], base.roles["review"], "a role scope touches only its own chain");

	const both = readOf(
		{ op: "add", kind: "steer", id: "st-exclude", scope: { role: "session", ref: XAI }, action: "exclude", reason: "his word", author: "operator", source: { ts: new Date(NOW).toISOString() }, expiry: { type: "manual", reviewAt: new Date(NOW + DAY).toISOString() }, createdAt: new Date(NOW).toISOString() },
		{ op: "add", kind: "steer", id: "st-prefer", scope: { role: "session", ref: XAI }, action: "prefer", reason: "wants it first", author: "orchestrator", source: { ts: new Date(NOW + 1000).toISOString() }, expiry: { type: "manual", reviewAt: new Date(NOW + DAY).toISOString() }, createdAt: new Date(NOW + 1000).toISOString() },
	);
	assert.deepEqual(applySteers(base, both, { now: NOW, role: "session" }).roles["session"], [ZAI, FREE], "a prefer has nothing to move once the operator excluded the ref");
	assert.deepEqual(base.roles["session"], [XAI, ZAI, FREE], "the base a caller holds is never mutated");
});

test("capacity is its own record: scoped, expiring, and never eligibility", () => {
	const base = configOf();
	const journal = readOf({
		op: "add",
		kind: "cap",
		id: "st-cap",
		scope: { project: "muster" },
		capOverride: { field: "claudeMax", value: 0, until: new Date(NOW + 6 * HOUR).toISOString() },
		reason: "no Claude lane today",
		author: "operator",
		source: { ts: new Date(NOW).toISOString() },
		createdAt: new Date(NOW).toISOString(),
	});
	assert.equal(applySteers(base, journal, { now: NOW, project: "muster" }).routing?.claudeMax, 0);
	assert.equal(applySteers(base, journal, { now: NOW, project: "another" }).routing?.claudeMax, 2, "another project keeps the file's cap");
	assert.equal(applySteers(base, journal, { now: NOW + 7 * HOUR, project: "muster" }).routing?.claudeMax, 2, "and the cap returns at its clock");
	assert.deepEqual(applySteers(base, journal, { now: NOW, project: "muster" }).roles, base.roles, "a cap never removes a ref");
	assert.equal(applySteers(base, journal, { now: NOW, project: "muster" }).routing?.claudeMax, 0);
	const newestWins = readOf(
		{ op: "add", kind: "cap", id: "st-cap-old", scope: {}, capOverride: { field: "slots", value: 2, until: new Date(NOW + 6 * HOUR).toISOString() }, reason: "old", author: "operator", source: { ts: new Date(NOW).toISOString() }, createdAt: new Date(NOW).toISOString() },
		{ op: "add", kind: "cap", id: "st-cap-new", scope: {}, capOverride: { field: "slots", value: 5, until: new Date(NOW + 6 * HOUR).toISOString() }, reason: "new", author: "operator", source: { ts: new Date(NOW + 1000).toISOString() }, createdAt: new Date(NOW + 1000).toISOString() },
	);
	assert.equal(applySteers(base, newestWins, { now: NOW }).routing?.slots, 5, "the newest override of a field is the one that holds");
});

test("routing.paused is the operator's: a steer changes nothing about it", () => {
	const file = poolFile();
	(file["routing"] as Record<string, unknown>)["paused"] = [XAI];
	const base = configOf(file);
	const journal = readOf(
		{ op: "add", kind: "steer", id: "st-x", scope: { ref: XAI }, action: "exclude", reason: "gone", author: "operator", source: { ts: new Date(NOW).toISOString() }, expiry: { type: "manual", reviewAt: new Date(NOW + DAY).toISOString() }, createdAt: new Date(NOW).toISOString() },
		{ op: "add", kind: "steer", id: "st-y", scope: { ref: XAI }, action: "prefer", reason: "back", author: "orchestrator", source: { ts: new Date(NOW + 1000).toISOString() }, expiry: { type: "manual", reviewAt: new Date(NOW + DAY).toISOString() }, createdAt: new Date(NOW + 1000).toISOString() },
	);
	const steered = applySteers(base, journal, { now: NOW });
	assert.deepEqual(steered.routing?.paused, [XAI], "exclude and prefer both leave the pause exactly as the file has it");
	assert.equal(steered.roles["session"]?.includes(XAI), false);
});

test("the pool file is never written and the base is never mutated: a full run changes no mtime", () => {
	const dir = scratchDir("mtime");
	const poolPath = join(dir, "provider-pool.json");
	writeFileSync(poolPath, `${JSON.stringify(poolFile(), null, "\t")}\n`);
	const journalPath = join(dir, "steers.jsonl");
	const before = statSync(poolPath);
	const content = readFileSync(poolPath, "utf8");

	const added = addSteer({ author: "operator", action: "exclude", scope: { ref: XAI }, reason: "mtime run", expiry: { type: "manual", reviewAt: new Date(Date.now() + DAY).toISOString() } }, { journalPath });
	assert.ok(added.ok);
	const loaded = loadSteeredPool({ now: NOW, project: "muster" }, { poolPath, journalPath });
	assert.ok(loaded.ok);
	assert.equal(loaded.ok ? loaded.config.roles["session"]?.includes(XAI) : true, false, "the run applied the journal");
	assert.ok(loaded.ok ? loaded.journal.entries.length === 1 : false);
	const placed = placeLaneModel(loaded.ok ? loaded.config : configOf(), { harness: "pi", now: NOW, kind: "ui", snapshot: null });
	assert.ok(placed.status === "placed");
	compactSteerJournal(journalPath, NOW);
	assert.ok(retireSteer(added.record.id, "operator", { journalPath }).ok);

	const after = statSync(poolPath);
	assert.equal(after.mtimeMs, before.mtimeMs, "the tracked file's mtime is unchanged after a full run");
	assert.equal(readFileSync(poolPath, "utf8"), content, "and so is its content");
});

test("the same journal places the same way twice, and applying a steer twice equals applying it once", () => {
	const base = configOf();
	const journal = readOf(
		{ op: "add", kind: "steer", id: "st-a", scope: { role: "session", ref: XAI }, action: "exclude", reason: "a", author: "operator", source: { ts: new Date(NOW).toISOString() }, expiry: { type: "manual", reviewAt: new Date(NOW + DAY).toISOString() }, createdAt: new Date(NOW).toISOString() },
		{ op: "add", kind: "steer", id: "st-b", scope: { role: "session", ref: ZAI }, action: "demote", reason: "b", author: "operator", source: { ts: new Date(NOW + 1000).toISOString() }, expiry: { type: "manual", reviewAt: new Date(NOW + DAY).toISOString() }, createdAt: new Date(NOW + 1000).toISOString() },
		{ op: "add", kind: "steer", id: "st-c", scope: { role: "session", ref: FREE }, action: "prefer", reason: "c", author: "orchestrator", source: { ts: new Date(NOW + 2000).toISOString() }, expiry: { type: "manual", reviewAt: new Date(NOW + DAY).toISOString() }, createdAt: new Date(NOW + 2000).toISOString() },
	);
	const once = applySteers(base, journal, { now: NOW, role: "session" });
	const twice = applySteers(once, journal, { now: NOW, role: "session" });
	assert.deepEqual(twice.roles, once.roles, "each action is idempotent, so a second read is the same read");
	assert.deepEqual(applySteers(base, journal, { now: NOW, role: "session" }).roles, once.roles, "and a fresh read of the same journal is too");
	const first = placeLaneModel(once, { harness: "pi", now: NOW, kind: "ui", snapshot: null });
	const second = placeLaneModel(applySteers(base, journal, { now: NOW, role: "session" }), { harness: "pi", now: NOW, kind: "ui", snapshot: null });
	assert.deepEqual(
		{ status: first.status, ref: first.ref, candidates: first.candidates.map((entry) => [entry.ref, entry.verdict]) },
		{ status: second.status, ref: second.ref, candidates: second.candidates.map((entry) => [entry.ref, entry.verdict]) },
	);
});

test("two steers in one millisecond keep the journal's order, not their id order", () => {
	const base = configOf();
	const sameMs = new Date(NOW).toISOString();
	// Written "st-z" first and "st-a" second inside one millisecond: the ids sort the other way round, so
	// only the journal's own order can decide. The two caps repeat the case for the oldest-first loop.
	const journal = readOf(
		{ op: "add", kind: "steer", id: "st-z", scope: { role: "session", ref: XAI }, action: "prefer", reason: "first written", author: "orchestrator", source: { ts: sameMs }, expiry: { type: "manual", reviewAt: new Date(NOW + DAY).toISOString() }, createdAt: sameMs },
		{ op: "add", kind: "steer", id: "st-a", scope: { role: "session", ref: ZAI }, action: "prefer", reason: "written second", author: "orchestrator", source: { ts: sameMs }, expiry: { type: "manual", reviewAt: new Date(NOW + DAY).toISOString() }, createdAt: sameMs },
		{ op: "add", kind: "cap", id: "st-z-cap", scope: {}, capOverride: { field: "slots", value: 3, until: new Date(NOW + 6 * HOUR).toISOString() }, reason: "first written", author: "operator", source: { ts: sameMs }, createdAt: sameMs },
		{ op: "add", kind: "cap", id: "st-a-cap", scope: {}, capOverride: { field: "slots", value: 9, until: new Date(NOW + 6 * HOUR).toISOString() }, reason: "written second", author: "operator", source: { ts: sameMs }, createdAt: sameMs },
	);
	assert.deepEqual(
		journal.entries.map((entry) => entry.record.id),
		["st-z", "st-a", "st-z-cap", "st-a-cap"],
		"the reader keeps the journal's own order, so only the comparators can discard it",
	);

	const placed = applySteers(base, journal, { now: NOW, role: "session" });
	assert.deepEqual(placed.roles["session"], [ZAI, XAI, FREE], "the second-written prefer is the newest of the tie, so its ref leads");
	assert.equal(placed.routing?.slots, 9, "and the second-written cap is the override that wins");
});

test("compaction keeps every live record and drops what the retention window passed", () => {
	const journalPath = journalIn("compaction");
	const longAgo = NOW - 40 * DAY;
	const old = addSteer({ author: "operator", action: "exclude", scope: { ref: MM }, reason: "ancient", expiry: { type: "at", at: new Date(longAgo + HOUR).toISOString() }, now: longAgo }, { journalPath });
	const live = addSteer({ author: "operator", action: "exclude", scope: { ref: XAI }, reason: "live", expiry: { type: "manual", reviewAt: new Date(NOW + DAY).toISOString() }, now: NOW }, { journalPath });
	const retired = addSteer({ author: "operator", action: "demote", scope: { ref: ZAI }, reason: "retired", expiry: { type: "manual", reviewAt: new Date(NOW + DAY).toISOString() }, now: NOW }, { journalPath });
	assert.ok(old.ok && live.ok && retired.ok);
	assert.ok(retireSteer(retired.record.id, "operator", { journalPath, now: NOW }).ok);
	const sizes = compactSteerJournal(journalPath, NOW);
	assert.ok(sizes.after < sizes.before, `compaction shrank the journal (${sizes.before} -> ${sizes.after})`);
	const read = readSteerJournal(journalPath);
	assert.deepEqual(
		read.entries.map((entry) => entry.record.id),
		[live.record.id, retired.record.id],
		"the long-expired record is gone and the live and recently retired ones stay, with the retirement",
	);
	assert.equal(read.entries[1]?.retiredAt !== undefined, true);

	// The writer compacts by itself at the size trigger: a journal past its bound never grows without limit.
	const small = journalIn("compaction-trigger");
	for (let index = 0; index < 6; index += 1) {
		const written = addSteer(
			{ author: "operator", action: "exclude", scope: { ref: `xai/m-${index}` }, reason: `bounded ${index}`, expiry: { type: "at", at: new Date(NOW + 2 * DAY + index * HOUR).toISOString() }, now: NOW + index * HOUR },
			{ journalPath: small, maxJournalBytes: 400 },
		);
		assert.ok(written.ok);
	}
	assert.ok(statSync(small).size < 3_000, "the writer compacts inside its own lock");
	assert.equal(readSteerJournal(small).entries.length, 6, "and compacts to the records that are still live");
});

test("a full placement reads the composed file, and the read fails open to the base", () => {
	const base = configOf();
	const before = placeLaneModel(base, { harness: "pi", now: NOW, kind: "ui", snapshot: null });
	assert.equal(before.status, "placed");
	assert.equal(before.ref, XAI, "the fixture's first policy ref is where the file places");

	const journalPath = journalIn("placement");
	const written = addSteer({ author: "operator", action: "exclude", scope: { role: "ui", ref: XAI }, reason: "the flagship is out", expiry: { type: "manual", reviewAt: new Date(NOW + DAY).toISOString() } }, { journalPath });
	assert.ok(written.ok);
	const composed = applySteers(base, readSteerJournal(journalPath), { now: NOW, role: "ui", harness: "pi" });
	const after = placeLaneModel(composed, { harness: "pi", now: NOW, kind: "ui", snapshot: null });
	assert.equal(after.ref, ZAI, "the placement reads the composed file, not the excluded ref");
	assert.equal(after.candidates.some((entry) => entry.ref === XAI), false, "an excluded ref is not a candidate at all");

	const poolPath = join(scratchDir("failopen"), "provider-pool.json");
	writeFileSync(poolPath, `${JSON.stringify(poolFile(), null, "\t")}\n`);
	const unreadable = loadSteeredPool({ now: NOW }, { poolPath, journalPath: scratchDir("failopen") });
	assert.ok(unreadable.ok);
	assert.deepEqual(unreadable.ok ? unreadable.config.roles["session"] : [], base.roles["session"], "an unreadable journal leaves the file's own answer");
	assert.ok(unreadable.ok ? unreadable.warnings.some((warning) => warning.startsWith("steers:")) : false, "and says so");
	const off = loadSteeredPool({ now: NOW }, { poolPath, journalPath, env: { MUSTER_STEERS: "off" } });
	assert.ok(off.ok);
	assert.deepEqual(off.ok ? off.config.roles["session"] : [], base.roles["session"], "MUSTER_STEERS=off is the kill switch");
	assert.equal(steersJournalPath({ PI_STEERS_PATH: journalPath }), journalPath);
	assert.equal(steersJournalPath({}), join(process.env["HOME"] ?? "", ".pi", "agent", "state", "steers.jsonl"));
	assert.equal(STEER_JOURNAL_MAX_BYTES, 1_048_576, "the size trigger the writer uses");
	assert.deepEqual(emptyRead(), { entries: [], warnings: [] });
});
