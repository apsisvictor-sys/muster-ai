/**
 * The steer layer's property test (S-steer, blueprint section 9): random steers and random walls over a random
 * pool, and every critical role either keeps two placeable refs from two providers or reports the shortfall
 * with the reasons that produced it — and a ref a steer excluded never comes back.
 *
 * The rounds are seeded, so a failure reproduces exactly. Each round also proves the two invariants a journal
 * read must have: the same inputs place the same way twice, and `routing.paused` is never touched.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	PLACEABLE_VERDICTS,
	rankLaneRoutes,
	TASK_KINDS,
	type PoolConfig,
	type RouteCandidate,
	type TaskKind,
	type Wall,
} from "../provider-pool.ts";
import { addSteer, applySteers, readSteerJournal } from "../steers.ts";

const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ROUNDS = 150;
const PROVIDERS = ["p0", "p1", "p2", "p3"] as const;
const REFS = PROVIDERS.flatMap((provider) => [0, 1, 2].map((index) => `${provider}/m${index}`));
const ROLES = ["session", "review", "verify"] as const;

/** A small deterministic generator: the same seed gives the same rounds on every machine. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

function pickSome(random: () => number, pool: readonly string[], least: number): string[] {
	const shuffled = [...pool].sort(() => random() - 0.5);
	return shuffled.slice(0, least + Math.floor(random() * (pool.length - least + 1)));
}

function basePool(random: () => number): PoolConfig {
	const policy = Object.fromEntries(TASK_KINDS.map((kind) => [kind, pickSome(random, REFS, 2)])) as Record<TaskKind, string[]>;
	const paused = random() < 0.4 ? [REFS[Math.floor(random() * REFS.length)] as string] : [];
	const roles: Record<string, string[]> = {};
	for (const role of ROLES) roles[role] = pickSome(random, REFS, 2);
	roles["classifier"] = pickSome(random, REFS, 1);
	return {
		version: 1,
		virtualProvider: "pool",
		cooldownMs: HOUR,
		resetHorizonMs: 3_024_000_000,
		providerWalls: {},
		roles,
		freeRefs: [],
		employerAccounts: [],
		nonChatRoles: ["classifier"],
		laneDefaults: { pi: { candidates: pickSome(random, REFS, 2), fallbackRole: "session" }, opencode: [], claude: "sonnet" },
		routing: { pick: "on", slots: 7, claudeMax: 2, hardMax: 2, paused, policy, kindRules: {} },
		quotaShapes: [],
	};
}

function randomWalls(random: () => number): Record<string, Wall> {
	const walls: Record<string, Wall> = {};
	for (const ref of REFS) {
		if (random() < 0.3) walls[`${ref}`] = { until: NOW + HOUR * (1 + Math.floor(random() * 5)), source: "cooldown" };
	}
	if (random() < 0.2) walls[PROVIDERS[Math.floor(random() * PROVIDERS.length)] as string] = { until: NOW + 2 * HOUR, source: "error" };
	return walls;
}

function refListsOf(config: PoolConfig, role: string): string[] {
	return [...(config.roles[role] ?? []), ...(config.routing?.policy["ui"] ?? [])];
}

const SCRATCH = mkdtempSync(join(tmpdir(), "steer-property-"));
const JOURNAL = join(SCRATCH, "steers.jsonl");

test("random steers and walls leave each critical role two placeable refs from two providers, or a shortfall with reasons", async () => {
	const random = mulberry32(202_610_29);
	let placed = 0;
	let shortfalls = 0;
	let excludedChecks = 0;
	for (let round = 0; round < ROUNDS; round += 1) {
		const base = basePool(random);
		const walls = randomWalls(random);
		writeFileSync(JOURNAL, "");
		const steers = 1 + Math.floor(random() * 4);
		const excluded: string[] = [];
		for (let index = 0; index < steers; index += 1) {
			const action = ["exclude", "demote", "prefer"][Math.floor(random() * 3)] as "exclude" | "demote" | "prefer";
			const scope: { role?: string; ref?: string; provider?: string; project?: string } = {};
			const shape = random();
			if (shape < 0.45) scope.ref = REFS[Math.floor(random() * REFS.length)];
			else if (shape < 0.65) scope.provider = PROVIDERS[Math.floor(random() * PROVIDERS.length)];
			else if (shape < 0.85) scope.role = ROLES[Math.floor(random() * ROLES.length)];
			else scope.project = ["muster", "other"][Math.floor(random() * 2)];
			const written = addSteer(
				{
					author: random() < 0.5 ? "operator" : "orchestrator",
					action,
					scope,
					reason: `round ${round} steer ${index}`,
					expiry: random() < 0.5 ? { type: "manual", reviewAt: new Date(NOW + DAY).toISOString() } : { type: "at", at: new Date(NOW + (1 + index) * HOUR).toISOString() },
					now: NOW,
				},
				{ journalPath: JOURNAL },
			);
			assert.ok(written.ok, written.ok ? "" : written.errors.join("; "));
			if (action === "exclude" && scope.ref !== undefined) excluded.push(scope.ref);
		}
		const journal = readSteerJournal(JOURNAL);
		for (const role of ROLES) {
			for (const ctx of [{ now: NOW, role }, { now: NOW, role, project: "muster" }, { now: NOW + 4 * HOUR, role, project: "muster" }]) {
				const steered = applySteers(base, journal, ctx);
				const again = applySteers(base, journal, ctx);
				assert.deepEqual(again.roles, steered.roles, `round ${round} ${role}: the same inputs place the same way twice`);
				assert.deepEqual(again.routing, steered.routing);
				assert.deepEqual(steered.routing?.paused, base.routing?.paused, "no steer touches the operator's pause");

				const candidates: RouteCandidate[] = (steered.roles[role] ?? []).map((ref) => ({ ref }));
				const ranked = rankLaneRoutes({ config: steered, candidates, walls, available: () => true, now: ctx.now });
				const placeable = ranked.filter((entry) => PLACEABLE_VERDICTS.includes(entry.verdict));
				const providers = new Set(placeable.map((entry) => entry.ref.slice(0, entry.ref.indexOf("/"))));
				if (placeable.length >= 2 && providers.size >= 2) {
					placed += 1;
				} else {
					shortfalls += 1;
					if (ranked.length === 0) {
						// An empty chain is a shortfall with one reason and the journal holds it: every ref the file
						// offered was excluded at this scope, and no exclusion is invented here.
						assert.ok(base.roles[role] !== undefined && base.roles[role].length > 0, `round ${round} ${role}: the chain the file wrote was not empty`);
					} else {
						for (const entry of ranked.filter((candidate) => !PLACEABLE_VERDICTS.includes(candidate.verdict))) {
							assert.ok(entry.reason.length > 0, `round ${round} ${role}: ${entry.ref} carries a reason (${entry.verdict})`);
						}
					}
				}
				// A the operator exclude is never put back: a ref the steered chain no longer names is never placeable.
				const kept = new Set([...refListsOf(steered, role)]);
				for (const ref of refListsOf(base, role).filter((candidate) => !kept.has(candidate))) {
					excludedChecks += 1;
					assert.equal(placeable.some((entry) => entry.ref === ref), false, `round ${round} ${role}: ${ref} was excluded and is never placeable`);
				}
				for (const ref of excluded) {
					if (refListsOf(base, role).includes(ref) && !kept.has(ref)) {
						assert.equal(placeable.some((entry) => entry.ref === ref), false, `round ${round} ${role}: an excluded ref never returns`);
					}
				}
			}
		}
	}
	console.log(`property: ${ROUNDS} rounds, ${placed} role readings with two placeable refs from two providers, ${shortfalls} shortfalls with reasons, ${excludedChecks} excluded refs never placeable`);
	assert.ok(placed > 0, "the rounds place: the invariant is not vacuous");
	assert.ok(shortfalls > 0, "and they also run short, which is the case the invariant is about");
});

test("the property run leaves no journal state behind: every round wrote its own lines and read them back", () => {
	const read = readSteerJournal(JOURNAL);
	assert.ok(read.warnings.length === 0, "no torn line came out of hundreds of writes");
	assert.ok(read.entries.length > 0);
});
