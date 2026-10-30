/**
 * S4: the crm-app kind-rules table (VR24-209, report O1.1).
 *
 * The table is data, not code: `provider-pool.json` -> `routing.kindRules.crm-app`
 * holds the path patterns a brief's owned paths are classified by. This file is the measurement
 * the AR4 acceptance asks for: the 30 recorded briefs, the kind each one must answer, and the
 * hit, wrong and unclear rates over them.
 *
 * The classification is the classifier's own (`packages/routing/lane-kind.ts`, the AR4 module):
 * a pattern is a path glob anchored at both ends, `**` crosses segments, `*` does not, `?` is one
 * character that is not `/`, and a trailing `/` is shorthand for `/**`. The rules are the
 * blueprint's (auto-routing blueprint 2026-10-25, section 4.3), first match wins: R1 `retry`,
 * R2 `security-data`, R3 `unknown-cause-bug`, R4 `shared-owner`, R5 `perf`, R6 the flash kinds when
 * every owned path belongs to one of them, R7 `research-read`, R8 `review` and `product-pass`. Two
 * rules of different class answer `unclear`, never a guess.
 *
 * The fixture beside this file (`fixtures/kind-rules-crm-app.json`) holds the 30 briefs
 * with their owned paths, the recorded class and the kind the table must answer. AR4's own fixture
 * (`fixtures/lane-kind-briefs.json`) measures the classifier's rules; this one measures the shipped
 * table, under the canonical project id of the CRM app.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyLane, isUnclear, type LaneKindInput } from "../lane-kind.ts";
import { TASK_KIND_CLASS, loadPoolConfig, poolConfigPath, type TaskKind } from "../provider-pool.ts";
import { harnessRoot } from "../../core/harness-paths.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIPPED = poolConfigPath();
const FIXTURE = join(HERE, "fixtures", "kind-rules-crm-app.json");
const PROJECT = "crm-app";
const NOW = Date.parse("2026-10-26T20:00:00.000Z");

/** The kinds the blueprint gives this project, derived from the recorded lanes. */
const EXPECTED_KINDS: readonly TaskKind[] = ["security-data", "shared-owner", "test", "docs", "config", "adapter", "copy", "ui"];

interface FixtureBrief {
	lane: string;
	brief: string;
	project: string;
	class: string;
	paths: string[];
	flags: {
		retry?: boolean;
		causeUnknown?: boolean;
		perf?: boolean;
		readsOnly?: boolean;
		review?: boolean;
		productPass?: boolean;
	};
	expectedKind: string;
}

function fixture(): FixtureBrief[] {
	const parsed = JSON.parse(readFileSync(FIXTURE, "utf8")) as { briefs: FixtureBrief[] };
	return parsed.briefs;
}

function input(brief: FixtureBrief): LaneKindInput {
	return { project: brief.project, paths: brief.paths, ...brief.flags };
}

test("the shipped pool carries the crm-app table and nothing is dropped", () => {
	const loaded = loadPoolConfig(SHIPPED, NOW);
	assert.ok(loaded.ok, loaded.ok ? "" : loaded.errors.join("; "));
	const warnings = (loaded as { warnings?: string[] }).warnings ?? [];
	assert.deepEqual(warnings, [], "the routing section is not refused");
	const routing = (loaded as { config: { routing?: { kindRules: Record<string, Partial<Record<TaskKind, string[]>>> } } }).config.routing;
	assert.ok(routing, "the routing section is present");
	const table = routing.kindRules[PROJECT];
	assert.ok(table, `routing.kindRules.${PROJECT} exists`);
	assert.deepEqual(Object.keys(table).sort(), [...EXPECTED_KINDS].sort(), "the kinds of this project");
	for (const kind of EXPECTED_KINDS) {
		const patterns = table[kind];
		assert.ok(patterns && patterns.length > 0, `${kind} has patterns`);
		for (const pattern of patterns) assert.ok(pattern.trim().length > 0, `${kind} pattern is a path`);
	}
});

test("30 recorded briefs: the kind the table must answer, and the three rates", () => {
	const briefs = fixture();
	assert.equal(briefs.length, 30, "the fixture holds 30 briefs");

	const loaded = loadPoolConfig(SHIPPED, NOW);
	assert.ok(loaded.ok, loaded.ok ? "" : loaded.errors.join("; "));
	const rules = (loaded as { config: { routing?: { kindRules: Record<string, Partial<Record<TaskKind, string[]>>> } } }).config.routing?.kindRules ?? {};

	let hits = 0;
	let unclear = 0;
	let wrong = 0;
	const rows: string[] = [];
	const misses: string[] = [];
	for (const brief of briefs) {
		const answer = classifyLane(input(brief), rules);
		assert.equal(answer.kind, brief.expectedKind, `${brief.lane} kind`);
		if (isUnclear(answer)) {
			unclear += 1;
			misses.push(`${brief.lane}: unclear (${answer.reason})`);
		} else if (answer.class === brief.class) {
			hits += 1;
		} else {
			wrong += 1;
			misses.push(`${brief.lane}: ${answer.kind}/${answer.class} by ${answer.rule}, recorded ${brief.class}`);
		}
		assert.equal(answer.class, isUnclear(answer) ? null : TASK_KIND_CLASS[answer.kind], `${brief.lane} class owner`);
		rows.push(`${brief.lane} recorded=${brief.class} answer=${answer.kind}/${String(answer.class)} rule=${answer.rule}`);
	}
	assert.equal(hits + unclear + wrong, 30);

	// The evidence for reports/s4rules-evidence.md, printed so the guarded log carries it.
	console.log(rows.join("\n"));
	const hitRate = Math.round((hits / 30) * 1000) / 10;
	const unclearRate = Math.round((unclear / 30) * 1000) / 10;
	console.log(`hits ${hits}/30 (${hitRate}%), unclear ${unclear}/30 (${unclearRate}%), wrong class ${wrong}/30`);
	console.log(`misses:\n${misses.join("\n")}`);

	// A wrong match is worse than an unclear one, so it is never allowed. A fall in hits or a rise
	// in unclear is a regression in the table; a rise means a pattern changed, which needs a
	// recorded decision and a new measurement, not a relaxed bound.
	assert.equal(wrong, 0, "no brief is answered with the wrong class");
	assert.ok(hits >= 19, `at least the 19 hits measured on 2026-10-26, got ${hits}`);
	assert.ok(unclear <= 11, `no more than the 11 unclear measured on 2026-10-26, got ${unclear}`);
});

test("a project without patterns answers unclear instead of guessing", () => {
	const briefs = fixture();
	const loaded = loadPoolConfig(SHIPPED, NOW);
	assert.ok(loaded.ok);
	const rules = (loaded as { config: { routing?: { kindRules: Record<string, Partial<Record<TaskKind, string[]>>> } } }).config.routing?.kindRules ?? {};
	const research = briefs.find((brief) => brief.lane === "resb");
	const website = briefs.find((brief) => brief.lane === "vf2");
	assert.ok(research && website);
	assert.equal(rules[research.project], undefined, "the research project has no patterns");
	assert.equal(rules[website.project], undefined, "the website project has no patterns");
	// The website lane is a retry, which the flags answer without any pattern; the research lane
	// owns a file, so no rule answers it and the orchestrator classes it by hand.
	assert.equal(classifyLane(input(website), rules).kind, "retry");
	assert.equal(classifyLane(input(research), rules).kind, "unclear");
});
