/**
 * Lane control requests (check 5): one queue, one-shot, one verb vocabulary —
 * plus the parity table that says which harness gets which verb (2026-10-09).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	enqueueLaneControl,
	harnessAcceptsModel,
	harnessModelCatalog,
	harnessModelRefusal,
	LANE_BUS_VERBS,
	LANE_VERB_PARITY,
	laneControlDecision,
	laneControlFile,
	laneVerbCell,
	normalizeLaneControlOperation,
	takeLaneControl,
} from "../lib/lane-control.ts";
import type { LaneHarness } from "../lib/lane-card.ts";

test("a queued control request is written once and taken once", () => {
	const dir = mkdtempSync(join(tmpdir(), "lane-control-"));
	try {
		const file = enqueueLaneControl(dir, { laneId: "pi-be-g3", operation: "abort", from: "cc-orchestrator", at: 111 });
		assert.equal(file, laneControlFile(dir, "pi-be-g3"));
		assert.equal(statSync(file).mode & 0o777, 0o600);
		const taken = takeLaneControl(dir, "pi-be-g3");
		assert.equal(taken?.operation, "abort");
		assert.equal(taken?.laneId, "pi-be-g3");
		assert.equal(taken?.from, "cc-orchestrator");
		assert.equal(typeof taken?.id, "string");
		assert.equal(takeLaneControl(dir, "pi-be-g3"), undefined, "a request is never applied twice");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("setModel carries its model id", () => {
	const dir = mkdtempSync(join(tmpdir(), "lane-control-"));
	try {
		enqueueLaneControl(dir, { laneId: "lane", operation: "setModel", params: { modelId: "openai-codex/gpt-5.6-luna" } });
		const taken = takeLaneControl(dir, "lane");
		assert.deepEqual(taken?.params, { modelId: "openai-codex/gpt-5.6-luna" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a control word is normalised, and an unknown word is refused", () => {
	assert.equal(normalizeLaneControlOperation("abort"), "abort");
	assert.equal(normalizeLaneControlOperation("STOP"), "stop");
	assert.equal(normalizeLaneControlOperation("cancel"), "abort");
	assert.equal(normalizeLaneControlOperation("set-model"), "setModel");
	assert.equal(normalizeLaneControlOperation("model"), "setModel");
	assert.equal(normalizeLaneControlOperation("delete-everything"), undefined);
	assert.equal(normalizeLaneControlOperation(undefined), undefined);
});

test("a stop request is queued and taken like abort, and is never read as abort", () => {
	const dir = mkdtempSync(join(tmpdir(), "lane-control-"));
	try {
		enqueueLaneControl(dir, { laneId: "oc-x", operation: "stop", from: "cc-xfer", at: 222 });
		const taken = takeLaneControl(dir, "oc-x");
		assert.equal(taken?.operation, "stop");
		assert.equal(takeLaneControl(dir, "oc-x"), undefined, "a stop request is applied once");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a malformed request is dropped rather than retried forever", () => {
	const dir = mkdtempSync(join(tmpdir(), "lane-control-"));
	try {
		const file = laneControlFile(dir, "lane");
		mkdirSync(join(dir, "control"), { recursive: true });
		writeFileSync(file, "{ not json");
		assert.equal(takeLaneControl(dir, "lane"), undefined);
		assert.equal(takeLaneControl(dir, "lane"), undefined, "the file is gone, not left to fail again");
		// A well-formed file naming an unknown verb is dropped too.
		enqueueLaneControl(dir, { laneId: "lane", operation: "abort" });
		writeFileSync(file, JSON.stringify({ laneId: "lane", operation: "rm -rf", at: Date.now() }));
		assert.equal(takeLaneControl(dir, "lane"), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a lane id can never escape the control directory", () => {
	const dir = mkdtempSync(join(tmpdir(), "lane-control-"));
	try {
		const file = laneControlFile(dir, "../../etc/passwd");
		assert.equal(file.startsWith(join(dir, "control")), true);
		enqueueLaneControl(dir, { laneId: "../../etc/passwd", operation: "abort" });
		assert.match(readFileSync(file, "utf8"), /abort/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ─── The parity table (2026-10-09) ───────────────────────────────────────────

/** Every harness the parity table carries a column for, plus `unknown` (F17, LC12). */
const HARNESSES: LaneHarness[] = ["pi", "claude", "opencode", "hermes", "unknown"];

test("every bus verb has a cell for every harness, and each cell says one of the three things", () => {
	for (const verb of LANE_BUS_VERBS) {
		for (const harness of HARNESSES) {
			const cell = laneVerbCell(harness, verb);
			if (cell.support === "works") continue;
			if (cell.support === "adapter") {
				assert.ok(cell.adapter.trim() !== "", `${verb}/${harness} names its adapter`);
				continue;
			}
			assert.equal(cell.support, "cannot", `${verb}/${harness} is one of works/adapter/cannot`);
			assert.ok(cell.why.trim() !== "" && cell.substitute.trim() !== "", `${verb}/${harness} states a reason and a substitute`);
		}
	}
	assert.equal(Object.keys(LANE_VERB_PARITY).length, LANE_BUS_VERBS.length, "the table covers the verb vocabulary exactly");
});

test("an unknown harness can never be reached: every verb says so with the same reason", () => {
	for (const verb of LANE_BUS_VERBS) {
		const cell = laneVerbCell("unknown", verb);
		assert.equal(cell.support, "cannot", `unknown/${verb} refuses`);
		if (cell.support === "cannot") assert.match(cell.why, /does not name a harness/);
	}
});

test("stop is one verb on every harness: the lane ends itself, or the CLI runs the harness's own stop", () => {
	for (const harness of HARNESSES) {
		const cell = laneVerbCell(harness, "stop");
		// A harness the bus never starts (unknown, hermes) has nothing for the stop owner to stop.
		if (harness === "unknown" || harness === "hermes") {
			assert.equal(cell.support, "cannot", `stop/${harness} refuses: the bus does not run that lane`);
			continue;
		}
		assert.equal(cell.support, "adapter", `stop/${harness} is an adapter`);
	}
	assert.deepEqual(laneControlDecision("pi", "stop"), { allowed: true, applier: "lane" });
	assert.deepEqual(laneControlDecision("opencode", "stop"), { allowed: true, applier: "lane" });
	assert.deepEqual(laneControlDecision("claude", "stop"), { allowed: true, applier: "claude-cli" });
	assert.deepEqual(laneControlDecision("pi", "abort"), { allowed: true, applier: "lane" });
	assert.deepEqual(laneControlDecision("opencode", "setModel"), { allowed: true, applier: "lane" });
});

test("a verb a harness cannot do is refused with the table's reason and its stated substitute", () => {
	const abort = laneControlDecision("claude", "abort");
	assert.equal(abort.allowed, false);
	if (!abort.allowed) {
		assert.match(abort.reason, /no remote interrupt/);
		assert.match(abort.substitute, /muster send/);
	}
	const model = laneControlDecision("claude", "setModel");
	assert.equal(model.allowed, false);
	if (!model.allowed) {
		assert.match(model.reason, /no verified remote model switch/);
		assert.match(model.substitute, /muster resume <lane>/);
		assert.match(model.substitute, /the lane's own `\/model`/);
		assert.doesNotMatch(model.substitute, /--resume/);
	}
});

// --- the P5-D6 guard on an explicit model ----------------------------------------------------

test("P5-D6: a Pi model outside the pool is refused, and a role ref, a free ref and a Claude alias pass", () => {
	const dir = mkdtempSync(join(tmpdir(), "lane-guard-"));
	try {
		const poolPath = join(dir, "provider-pool.json");
		writeFileSync(poolPath, JSON.stringify({
			version: 1,
			virtualProvider: "pool",
			cooldownMs: 3_600_000,
			resetHorizonMs: 3_024_000_000,
			freeRefs: ["x/free-model:free"],
			laneDefaults: { pi: { candidates: ["a/paid"], fallbackRole: "w", hard: ["h/hard"] }, opencode: ["oc/free-one-free"], claude: "sonnet" },
			roles: { build: ["a/paid"], w: ["b/paid2", "x/free-model:free"] },
			quotaShapes: [{ id: "wall", match: "QUOTA_WALL" }],
		}));
		// Pi's own settings may enable a model beside the pool: it is listed, and never admitted.
		const pi = harnessModelCatalog("pi", { poolPath, piSettingsModels: ["c/from-settings"] });
		assert.equal(harnessModelRefusal(pi, "a/paid"), undefined, "a lane default candidate passes");
		assert.equal(harnessModelRefusal(pi, "b/paid2"), undefined, "a role ref passes");
		assert.equal(harnessModelRefusal(pi, "x/free-model:free"), undefined, "a free ref passes");
		assert.equal(harnessModelRefusal(pi, "h/hard"), undefined, "a laneDefaults.pi.hard ref passes (VR19-51)");
		assert.match(harnessModelRefusal(pi, "c/from-settings") ?? "", /P5-D6/);
		// The gateway's own check is the same owner, so `lane_launch` and `set-model` refuse it too.
		assert.equal(harnessAcceptsModel(pi, "c/from-settings"), false);
		assert.match(harnessModelRefusal(pi, "nope/nope") ?? "", /not in the pi catalog/);

		const claude = harnessModelCatalog("claude");
		for (const alias of ["haiku", "sonnet", "opus"]) assert.equal(harnessModelRefusal(claude, alias), undefined, alias);
		assert.equal(harnessModelRefusal(claude, "claude-sonnet-4-6"), undefined, "a full claude-* id passes");
		assert.match(harnessModelRefusal(claude, "gpt-6") ?? "", /not in the claude catalog/);

		const opencode = harnessModelCatalog("opencode", { opencodeModelsOutput: "oc/free-one-free\noc/paid-two" });
		assert.equal(harnessModelRefusal(opencode, "oc/free-one-free"), undefined);
		assert.match(harnessModelRefusal(opencode, "oc/paid-two") ?? "", /paid and OpenCode lanes run free models only/);

		// An unreadable catalog is itself the refusal, never a guess.
		assert.match(harnessModelRefusal(harnessModelCatalog("opencode"), "oc/free-one-free") ?? "", /could not be read/);
		assert.match(harnessModelRefusal(harnessModelCatalog("pi", { poolPath: join(dir, "missing.json") }), "a/paid") ?? "", /could not be read/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
