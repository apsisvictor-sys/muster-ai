/**
 * The pool and the methodology must say the same thing (VR24-209 row S3, VR24-207, VR24-208).
 *
 * `provider-pool.json` is the one owner of which model serves which role, and
 * `instructions/methodology.md` states the lane model in prose. Nothing compared them, so they drifted:
 * `routing.paused` still held `xai/grok-4.6` while VR24-207 runs Fix-gate reviews on it, and
 * `laneDefaults.pi.hard` named Grok as the hard-lane ref while the Hard bullet puts hard lanes on
 * Command Code DeepSeek V4.1 Flash and reserves Grok for the review. This test derives each expected value
 * from the sentence that states it and holds no copy of the rule: an edit on either side fails here.
 *
 * One value flipped in `provider-pool.json` fails exactly one assertion (the flip table is in
 * `reports/s3pool-impact-map.md` §4).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { TASK_KINDS, TASK_KIND_CLASS, loadPoolConfig, poolConfigPath, resolveLaneModel, type PoolConfig, type PoolRouting } from "../../routing/provider-pool.ts";
import { harnessModelCatalog, harnessModelRefusal } from "../lib/lane-control.ts";
import { enclosingProfile, harnessRoot } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);
const POOL = poolConfigPath();
const profileRoot = () => enclosingProfile(import.meta.url) ?? piAgentDir();
const METHODOLOGY = join(profileRoot(), "instructions", "methodology.md");
const NOW = Date.parse("2026-10-06T12:00:00.000Z");

/** The methodology's hard class: H1 to H5, the kinds only a `laneDefaults.pi.hard` ref may serve. */
const HARD_KINDS = TASK_KINDS.filter((kind) => TASK_KIND_CLASS[kind].startsWith("H"));

// Learned walls live in a temp file so the live agent's walls never decide this test.
process.env.PI_PROVIDER_WALLS_PATH = join(mkdtempSync(join(tmpdir(), "s3pool-walls-")), "provider-walls.json");
writeFileSync(process.env.PI_PROVIDER_WALLS_PATH, "{}\n");

const WORDS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** The first backticked token the methodology names in `pattern`; the failure names the sentence, not a rule. */
function named(pattern: RegExp, what: string): string {
	const match = readFileSync(METHODOLOGY, "utf8").match(pattern);
	assert.ok(match, `the methodology no longer states ${what}`);
	return (match as RegExpMatchArray)[1] as string;
}

/** A count the methodology writes as a word ("two") or a figure ("10"). */
function namedCount(pattern: RegExp, what: string): number {
	const raw = named(pattern, what);
	const value = /^\d+$/.test(raw) ? Number(raw) : WORDS[raw.toLowerCase()];
	assert.equal(typeof value, "number", `the methodology's ${what} reads "${raw}", and this test knows no such count`);
	return value as number;
}

/** The Hard bullet: the model a hard lane runs on. */
const hardModel = () => named(/\*\*Hard:\*\* these run on `([^`]+)`/, "which model a hard lane runs on (the Hard bullet)");
/** The Hard and Claude-is-scarce bullets: the ref reserved for the Fix-gate review. */
const reviewRef = () => named(/`([^`]+)` is reserved for the Fix-gate review/, "the ref reserved for the Fix-gate review");
/** Grok limits: "At most two Grok lanes run at a time". */
const grokCap = () => namedCount(/At most (\w+) Grok lanes run at a time/, "how many Grok lanes run at once (Grok limits)");
/** Claude is scarce: "Free slots up to 10 Pi sessions". */
const piSessionCap = () => namedCount(/Free slots up to (\w+) Pi sessions/, "how many Pi sessions fill the free slots (Claude is scarce)");

function pool(): { config: PoolConfig; warnings: string[] } {
	const loaded = loadPoolConfig(POOL, NOW);
	assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.errors.join("; "));
	const parsed = loaded as { ok: true; config: PoolConfig; warnings?: string[] };
	return { config: parsed.config, warnings: parsed.warnings ?? [] };
}

function routing(): PoolRouting {
	const { config } = pool();
	assert.ok(config.routing, "the shipped pool carries a routing section");
	return config.routing;
}

test("(e) the shipped pool loads with no parse warning, so its routing section is in force", () => {
	const { config, warnings } = pool();
	assert.deepEqual(warnings, [], "a refused routing section would be dropped here, not used");
	assert.ok(config.routing, "the shipped pool carries a routing section");
});

test("(a) the hard-lane model the methodology names is the first laneDefaults.pi.hard ref (VR24-208)", () => {
	const { config } = pool();
	assert.equal(config.laneDefaults?.pi.hard?.[0], hardModel(), "the Hard bullet names the model a hard lane runs on");
});

test("(a2) every hard kind is placed on the hard-lane model, and none of them on the review ref (VR24-208)", () => {
	const policy = routing().policy;
	assert.deepEqual(
		HARD_KINDS.map((kind) => policy[kind]),
		HARD_KINDS.map(() => [hardModel()]),
		"the Hard bullet puts hard lanes on its model and reserves the review ref for the Fix-gate review",
	);
});

test("(b) the ref the methodology reserves for the Fix-gate review is xai/grok-4.6 and is not paused (VR24-207, VR24-209 S3)", () => {
	assert.equal(reviewRef(), "xai/grok-4.6", "VR24-207 runs the Fix-gate review on this ref");
	assert.ok(!routing().paused.includes(reviewRef()), "a paused review ref would contradict VR24-207: the pause is lifted");
});

test("(c) routing.hardMax is the at-most-two of the Grok limits", () => {
	assert.equal(routing().hardMax, grokCap(), "the Grok limits bullet caps how many Grok lanes run at once");
});

test("(d) routing.slots is the up-to-10 Pi sessions, and claudeMax is 0 while a Claude lane stays the exception (VR24-207)", () => {
	const text = readFileSync(METHODOLOGY, "utf8");
	assert.equal(routing().slots, piSessionCap(), "the Claude-is-scarce bullet fills the free slots with Pi sessions");
	assert.match(text, /Claude is scarce/, "the methodology states Claude is scarce");
	assert.match(text, /A Claude lane is an exception/, "the methodology keeps a Claude lane the exception, never a default");
	assert.equal(
		routing().claudeMax,
		0,
		"VR24-207: no new lane on Claude while the weekly window is high, so the pool carries 0, stricter than the bullet's 1 or 2 (switch board S2 restores 2 on Fri 30 Oct 07:00)",
	);
});

test("whole path: the real pool's launch pick is the hard-lane model, and a Grok review lane is still admitted", () => {
	const { config } = pool();
	// The launcher's answer for a Pi lane that names no model: lane-model.mjs → resolveLaneModel.
	const resolved = resolveLaneModel(config, { harness: "pi", now: NOW });
	assert.equal(resolved.model, hardModel(), "no lane starts anywhere but the hard-lane model the methodology names");
	assert.notEqual(resolved.model, reviewRef(), "no lane starts on the ref reserved for the Fix-gate review");
	// The launcher's check for an explicit model: lane-model.mjs → harnessModelCatalog + harnessModelRefusal.
	const catalog = harnessModelCatalog("pi", { poolPath: POOL });
	assert.equal(catalog.ok, true, catalog.ok ? "" : catalog.reason);
	assert.equal(
		harnessModelRefusal(catalog, reviewRef()),
		undefined,
		"a Fix-gate review lane launched with --model xai/grok-4.6 passes the pool check (VR24-207)",
	);
	assert.equal(harnessModelRefusal(catalog, hardModel()), undefined, "a hard lane launched with --model on the hard-lane model passes too");
	// What the table says when pick turns on (AR6): the review still starts on the reserved ref.
	assert.equal(config.routing?.policy.review?.[0], reviewRef(), "the review kind's row starts on the ref the methodology reserves");
});
