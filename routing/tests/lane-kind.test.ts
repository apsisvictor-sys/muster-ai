/**
 * The lane classifier (auto-routing blueprint 2026-10-25, section 4.3 and the AR4 row, VR24-100).
 *
 * Two things are checked here. First the rule table: each of R1 to R8 answers the kind and class the
 * blueprint names, the three ways to reach `unclear` are `unclear`, and a project without kind
 * patterns never guesses. Second the recorded briefs: 30 briefs whose class a lane record already
 * holds, classified from the paths and flags the brief itself states, with the hit rate, the
 * `unclear` rate and every miss printed for the impact map (`reports/ar4-impact-map.md`).
 *
 * The table test builds its own `kindRules` for one project. That table is test data: the shipped
 * one is `provider-pool.json` `routing.kindRules`, whose owner is `parseRouting` (AR5), and this
 * module reads it as it finds it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	classifyLane,
	isUnclear,
	matchesPattern,
	type LaneKindDecision,
	type LaneKindInput,
	type LaneKindRules,
} from "../lane-kind.ts";
import { TASK_KINDS, TASK_KIND_CLASS, loadPoolConfig, poolConfigPath } from "../provider-pool.ts";
import { harnessRoot } from "../../core/harness-paths.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
const SHIPPED = poolConfigPath();
const FIXTURE = join(HERE, "fixtures", "lane-kind-briefs.json");
const NOW = Date.parse("2026-10-25T18:00:00.000Z");

/** Test data for one project, in the same shape `parseRouting` keeps. Not a seed of the pool. */
const TABLE: LaneKindRules = {
	be: {
		"security-data": ["app/api/**", "**/migrations/**", "lib/auth/**"],
		"shared-owner": ["lib/deals/**", "lib/registers/**"],
		test: ["__tests__/**", "e2e/**"],
		docs: ["docs/**", "**/README.md"],
		config: ["vercel.json", "next.config.*", "ops/**"],
		adapter: ["lib/sources/**"],
		copy: ["content/**"],
		ui: ["components/**"],
	},
};

function decide(input: LaneKindInput, rules: LaneKindRules = TABLE): LaneKindDecision {
	return classifyLane(input, rules);
}

function kindOf(input: LaneKindInput, rules: LaneKindRules = TABLE): string {
	return decide(input, rules).kind;
}

test("R1 to R8 answer the kind and class the blueprint names", () => {
	const cases: Array<[string, LaneKindInput, string, string, string]> = [
		["R1", { project: "be", paths: ["src/widget.ts"], retry: true }, "retry", "H1", "R1"],
		["R2", { project: "be", paths: ["app/api/properties/[id]/register-check/route.ts"] }, "security-data", "H4", "R2"],
		["R2 migration", { project: "be", paths: ["db/migrations/0007-add-column.sql"] }, "security-data", "H4", "R2"],
		["R3", { project: "be", paths: ["src/widget.ts"], causeUnknown: true }, "unknown-cause-bug", "H2", "R3"],
		["R4", { project: "be", paths: ["lib/deals/deal-stages.ts"] }, "shared-owner", "H3", "R4"],
		["R5", { project: "be", paths: ["src/widget.ts"], perf: true }, "perf", "H5", "R5"],
		["R6 test", { project: "be", paths: ["__tests__/lib/registers/kais.test.ts"] }, "test", "flash", "R6"],
		["R6 docs", { project: "be", paths: ["docs/qa/kais-unit-ids-2026-10-21.md"] }, "docs", "flash", "R6"],
		["R6 config", { project: "be", paths: ["vercel.json", "ops/radar/systemd/broker-radar.service"] }, "config", "flash", "R6"],
		["R6 adapter", { project: "be", paths: ["lib/sources/kais.ts"] }, "adapter", "flash", "R6"],
		["R6 copy", { project: "be", paths: ["content/pricing.md"] }, "copy", "flash", "R6"],
		["R6 screen", { project: "be", paths: ["components/assistant/AssistantDock.tsx"] }, "ui", "flash", "R6"],
		["R7", { project: "be", readsOnly: true }, "research-read", "flash", "R7"],
		["R8 review", { project: "be", paths: ["src/widget.ts"], review: true }, "review", "exception", "R8"],
		["R8 product", { project: "be", paths: ["src/widget.ts"], productPass: true }, "product-pass", "exception", "R8"],
	];
	for (const [name, input, kind, klass, rule] of cases) {
		const answer = decide(input);
		assert.equal(answer.kind, kind, `${name} kind`);
		assert.equal(answer.class, klass, `${name} class`);
		assert.equal(answer.rule, rule, `${name} rule`);
		assert.ok(answer.reason.length > 0, `${name} states why it answered`);
		// The class the answer carries is always the closed table's own class, never a parallel one.
		if (answer.kind !== "unclear") assert.equal(answer.class, TASK_KIND_CLASS[answer.kind], `${name} class owner`);
	}
});

test("no rule matched is unclear, with rule none, and never a default kind", () => {
	const answer = decide({ project: "be", paths: ["src/widget.ts"] });
	assert.ok(isUnclear(answer));
	assert.equal(answer.kind, "unclear");
	assert.equal(answer.class, null);
	assert.equal(answer.rule, "none");
	assert.match(answer.reason, /no rule matched/);
	// An empty brief is the same answer: no paths, no flags, nothing to decide.
	assert.equal(kindOf({ project: "be" }), "unclear");
});

test("two rules of different class are unclear and the reason names both", () => {
	// A retried performance lane: H1 and H5 disagree.
	const both = decide({ project: "be", paths: ["components/workspace/TodayOverview.tsx"], retry: true, perf: true });
	assert.ok(isUnclear(both));
	assert.match(both.reason, /R1 \(H1\)/);
	assert.match(both.reason, /R5 \(H5\)/);
	assert.match(both.reason, /disagree/);

	// A performance lane that owns only tests is H5 against R6's flash: the blueprint's own
	// report-only lanes land here as soon as the project has test patterns.
	const report = decide({ project: "be", paths: ["e2e/perf/pf3m-measure.ts"], perf: true });
	assert.ok(isUnclear(report));
	assert.match(report.reason, /R5 \(H5\)/);
	assert.match(report.reason, /R6 \(flash\)/);

	// A retried data-write lane is H1 against H4.
	assert.ok(isUnclear(decide({ project: "be", paths: ["app/api/x/route.ts"], retry: true })));
});

test("two rules of the same class take the earlier rule, not unclear", () => {
	// `review` and `product-pass` are both `exception`: R8 answers with the first.
	const answer = decide({ project: "be", paths: ["src/widget.ts"], review: true, productPass: true });
	assert.equal(answer.kind, "review");
	assert.equal(answer.rule, "R8");
	// R6's kinds are all flash, so a mixed-category answer cannot happen: only one kind can own every path.
	assert.equal(kindOf({ project: "be", paths: ["__tests__/a.test.ts", "docs/b.md"] }), "unclear");
});

test("a project without kind patterns answers unclear for R2, R4 and R6", () => {
	// These paths would be H4, H3 and flash in `be`. In `website`, which has no patterns, they are unclear.
	for (const paths of [["api/property-page.js"], ["lib/deals/flow.ts"], ["tests/district-page.test.js"]]) {
		const answer = decide({ project: "website", paths });
		assert.ok(isUnclear(answer), `${paths.join()} is unclear without patterns`);
		assert.match(answer.reason, /has no kind patterns/);
	}
	// No project named at all is the same: R2, R4 and R6 have nothing to read.
	const unnamed = decide({ paths: ["app/api/x/route.ts"] });
	assert.ok(isUnclear(unnamed));
	assert.match(unnamed.reason, /no project was named/);
	// The flag rules need no table, so they still answer.
	assert.equal(kindOf({ project: "website", paths: ["lib/district-page.js"], perf: true }), "perf");
});

test("a table that has no pattern for the owned path says so rather than guessing", () => {
	const answer = decide({ project: "be", paths: ["src/widget.ts"] }, { be: { test: ["__tests__/**"] } });
	assert.ok(isUnclear(answer));
	assert.match(answer.reason, /has no pattern for the owned paths/);
});

test("a pattern is anchored and ** crosses segments while * does not", () => {
	assert.ok(matchesPattern("__tests__/lib/a.test.ts", "__tests__/**"));
	assert.ok(!matchesPattern("lib/__tests__/a.test.ts", "__tests__/**"));
	assert.ok(matchesPattern("app/api/properties/[id]/route.ts", "app/api/**"));
	assert.ok(matchesPattern("lib/properties/[id]", "lib/*/[id]"));
	assert.ok(!matchesPattern("lib/deals/flow.ts", "lib/*"));
	assert.ok(matchesPattern("ops/radar/run.sh", "ops/"));
	assert.ok(!matchesPattern("src/vercel.json", "vercel.json"));
	assert.ok(matchesPattern("src/vercel.json", "**/vercel.json"));
	assert.ok(matchesPattern("docs/a/b.md", "docs/**/b.md"));
	assert.ok(matchesPattern("docs/b.md", "docs/**/b.md"));
	assert.ok(matchesPattern("~/research/ea-portals-2026-10-21/portals-P-B.md", "~/research/**"));
	assert.ok(matchesPattern("./lib/deals/flow.ts", "lib/deals/flow.ts"));
});

test("the shipped pool is where the table comes from, and it is the only one", () => {
	const loaded = loadPoolConfig(SHIPPED, NOW);
	assert.ok(loaded.ok, "the shipped pool file parses");
	const routing = loaded.config.routing;
	assert.ok(routing, "the routing section is present");
	// The module's answer for a project the file names nothing about is unclear, not a guess today.
	const answer = classifyLane({ project: "be", paths: ["lib/deals/flow.ts"] }, routing.kindRules);
	assert.ok(isUnclear(answer), "an empty kindRules table cannot classify a path");
});

interface FixtureBrief {
	lane: string;
	brief: string;
	project: string;
	class: string;
	paths: string[];
	flags: { retry?: boolean; causeUnknown?: boolean; perf?: boolean; readsOnly?: boolean; review?: boolean; productPass?: boolean };
}

test("30 recorded briefs: the hit rate and the unclear rate", () => {
	const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { briefs: FixtureBrief[] };
	assert.equal(fixture.briefs.length, 30, "the fixture holds 30 briefs");

	const loaded = loadPoolConfig(SHIPPED, NOW);
	assert.ok(loaded.ok, "the shipped pool file parses");
	const kindRules = loaded.config.routing?.kindRules ?? {};

	let hits = 0;
	let unclear = 0;
	let wrongKind = 0;
	const misses: string[] = [];
	const rows: string[] = [];
	for (const brief of fixture.briefs) {
		const answer = classifyLane({ project: brief.project, paths: brief.paths, ...brief.flags }, kindRules);
		if (answer.kind === "unclear") {
			unclear += 1;
			misses.push(`${brief.lane}: unclear (${answer.reason})`);
		} else if (answer.class === brief.class) {
			hits += 1;
		} else {
			wrongKind += 1;
			misses.push(`${brief.lane}: ${answer.kind}/${answer.class} by ${answer.rule}, recorded ${brief.class}`);
		}
		// Every answer is in the closed kind list and carries its own class, whichever way it went.
		assert.ok(answer.kind === "unclear" || (TASK_KINDS as readonly string[]).includes(answer.kind), `${brief.lane} kind`);
		assert.equal(answer.class, answer.kind === "unclear" ? null : TASK_KIND_CLASS[answer.kind], `${brief.lane} class owner`);
		rows.push(`${brief.lane} recorded=${brief.class} answer=${answer.kind}/${String(answer.class)} rule=${answer.rule}`);
	}
	assert.equal(hits + unclear + wrongKind, 30);

	const hitRate = Math.round((hits / 30) * 1000) / 10;
	const unclearRate = Math.round((unclear / 30) * 1000) / 10;
	// The evidence for reports/ar4-impact-map.md, printed so the guarded log carries it.
	console.log(rows.join("\n"));
	console.log(`hits ${hits}/30 (${hitRate}%), unclear ${unclear}/30 (${unclearRate}%), wrong class ${wrongKind}/30`);
	console.log(`misses:\n${misses.join("\n")}`);

	// A fall is a regression in the rules. A rise means the pool's kindRules gained patterns, which is
	// the data AR6 needs; re-read the impact map before moving these bounds.
	assert.ok(hits >= 8, `at least the 8 flag-rule hits of 2026-10-25, got ${hits}`);
	assert.ok(unclear <= 22, `no more than the 21 unclear of 2026-10-25, got ${unclear}`);
});
