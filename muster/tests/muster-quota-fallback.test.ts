import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { LaneCard } from "../lib/lane-card.ts";
import { activeWalls, loadPoolConfig, poolConfigPath, type Wall, wallKey } from "../../routing/provider-pool.ts";
import { QUOTA_RESUME_TEXT, applyQuotaFallback, quotaFallback, type QuotaFallbackPorts } from "../tick.ts";
import { harnessRoot } from "../../core/harness-paths.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);

/**
 * DS3: muster-tick moves a walled Pi or OpenCode lane through
 * laneDefaults.<harness>, one action per wall, with no model call and no worker.
 */

const POOL_PATH = poolConfigPath();
const loaded = loadPoolConfig(POOL_PATH, 0);
if (!loaded.ok) throw new Error(loaded.errors.join("; "));
const pool = loaded.config;
const PI = pool.laneDefaults!.pi.candidates;
const OC = pool.laneDefaults!.opencode;
const NOW = Date.parse("2026-10-10T08:00:00.000Z");
const RESET = Date.parse("2026-10-10T14:00:00.000Z");

function card(over: Partial<LaneCard> = {}): LaneCard {
	return {
		laneId: "pi-a", harness: "pi", cwd: null, branch: null, state: "quota-walled", model: PI[0], thinking: null,
		since: NOW - 60_000, updatedAt: NOW - 5_000, wall: { shapeId: "weekly-plan-limit", resetAt: RESET }, ...over,
	};
}
const wall = (until: number, source: Wall["source"] = "error"): Wall => ({ until, source });
const walls = (entries: Record<string, Wall>) => entries;

test("a walled Pi lane moves to the next ref of laneDefaults.pi.candidates", () => {
	const [action] = quotaFallback([card()], pool, walls({}), NOW);
	assert.deepEqual({ kind: action.kind, ref: (action as { ref: string }).ref }, { kind: "switch", ref: PI[1] });
	assert.equal(action.event, `QUOTA WALL: pi-a | ${PI[0]} walled until 2026-10-10T14:00:00Z; switched to ${PI[1]}`);
});

test("a walled ref is skipped, an expired wall is not", () => {
	// PI[1] is a free ref (OpenCode Go Step 5 Preview, the operator 2026-10-11), and a free ref is walled
	// by its own key, never by its provider's: wallKey names the key the walk reads.
	const nextKey = wallKey(pool, PI[1]);
	const skipped = quotaFallback([card()], pool, walls({ [nextKey]: wall(NOW + 60_000) }), NOW);
	assert.equal((skipped[0] as { ref: string }).ref, PI[2]);
	const expired = quotaFallback([card()], pool, walls({ [nextKey]: wall(NOW - 1) }), NOW);
	assert.equal((expired[0] as { ref: string }).ref, PI[1]);
});

test("the walk wraps to the top of the list and never returns the current model", () => {
	const last = card({ model: PI[PI.length - 1] });
	assert.equal((quotaFallback([last], pool, walls({}), NOW)[0] as { ref: string }).ref, PI[0]);
	const unknown = card({ model: "zai/glm-other" });
	assert.equal((quotaFallback([unknown], pool, walls({}), NOW)[0] as { ref: string }).ref, PI[0]);
});

test("an OpenCode lane on its one ref is left to its QUOTA WALL when walled (2026-10-23: MiniMax M3.1 Flash only)", () => {
	assert.deepEqual([...OC], ["minimax/MiniMax-M3.1-Flash"]);
});

test("an OpenCode lane with both of its refs walled pauses on one QUOTA WALL line and queues no switch", () => {
	// The free ref's own wall wording names no reset, so the lane waits on an unknown time. Both
	// refs carry the cooldown a learned wall is recorded as (`persistProviderWall`), which is a
	// guess and never a reset the resume timer may trust.
	const lane = card({ laneId: "oc-a", harness: "opencode", model: OC[0], wall: { shapeId: "free-tier-limit" } });
	const all = walls({ [OC[0]]: wall(NOW + 3_600_000, "cooldown"), [OC[1]]: wall(NOW + 3_600_000, "cooldown") });
	const actions = quotaFallback([lane], pool, all, NOW);
	assert.equal(actions.length, 1);
	const [action] = actions;
	assert.equal(action.kind, "notify");
	assert.equal(action.event, `QUOTA WALL: oc-a | ${OC[0]} walled until an unknown time; pool exhausted, no reset time known`);
	const calls: string[] = [];
	const events: string[] = [];
	applyQuotaFallback(actions, {
		setModel: (l, r) => (calls.push(`${l} ${r}`), { ok: true }),
		scheduleResume: () => ({ unit: "never" }),
		event: (line) => void events.push(line),
		markHandled: (l, at) => void calls.push(`mark ${l} ${at}`),
		now: () => NOW,
	});
	assert.deepEqual(calls, [`mark oc-a ${NOW}`], "the wall is marked once and no set-model is queued");
	assert.deepEqual(events, [action.event]);
});

test("SK4: an OpenCode lane reads walls per account, so a work wall never blocks a personal process", () => {
	const split: typeof pool = {
		...pool,
		employerAccounts: ["opencode-go"],
		freeRefs: [...pool.freeRefs, "opencode-go/free-a", "opencode-go/free-b"],
		laneDefaults: { ...pool.laneDefaults!, opencode: ["opencode-go/free-a", "opencode-go/free-b"] },
	};
	const lane = card({ laneId: "oc-a", harness: "opencode", model: "opencode-go/free-a" });
	const workWalls = walls({ "opencode-go/free-a@acme-realty": wall(NOW + 3_600_000), "opencode-go/free-b@acme-realty": wall(NOW + 3_600_000) });
	const prior = process.env.PI_EMPLOYER;
	try {
		process.env.PI_EMPLOYER = "acme-realty";
		assert.equal(quotaFallback([lane], split, workWalls, NOW)[0].kind, "resume-timer", "the work process sees both keys of its own account");
		process.env.PI_EMPLOYER = "personal";
		const [personal] = quotaFallback([lane], split, workWalls, NOW);
		assert.equal(personal.kind, "switch");
		assert.equal((personal as { ref: string }).ref, "opencode-go/free-b", "the same walls leave the personal process free");
	} finally {
		process.env.PI_EMPLOYER = prior;
	}
});

test("pool exhausted with a known reset sets a resume timer at the earliest reset", () => {
	const all = walls(Object.fromEntries(PI.map((ref, index) => [wallKey(pool, ref), wall(RESET + index * 3_600_000)])));
	const lane = card({ wall: { shapeId: "weekly-plan-limit", resetAt: RESET + 86_400_000 } });
	const [action] = quotaFallback([lane], pool, all, NOW);
	assert.equal(action.kind, "resume-timer");
	assert.equal((action as { at: number }).at, RESET);
	assert.equal(action.event, `QUOTA WALL: pi-a | ${PI[0]} walled until 2026-10-11T14:00:00Z; pool exhausted, resume timer at 2026-10-10T14:00:00Z`);
});

test("pool exhausted with no reset time sends the event only: a cooldown is a guess", () => {
	const cooldowns = walls(Object.fromEntries(PI.map((ref) => [wallKey(pool, ref), wall(NOW + 3_600_000, "cooldown")])));
	const lane = card({ wall: { shapeId: "insufficient-credits" } });
	const [action] = quotaFallback([lane], pool, cooldowns, NOW);
	assert.equal(action.kind, "notify");
	assert.equal(action.event, `QUOTA WALL: pi-a | ${PI[0]} walled until an unknown time; pool exhausted, no reset time known`);
});

test("a wall already handled, a lane that is not walled, a Claude lane and a dead card are left alone", () => {
	const cards = [
		card({ wall: { shapeId: "weekly-plan-limit", resetAt: RESET, handledAt: NOW - 1000 } }),
		card({ laneId: "pi-b", state: "running", wall: null }),
		card({ laneId: "cc-a", harness: "claude" }),
		card({ laneId: "pi-gone", updatedAt: NOW - 10 * 60_000 }),
	];
	assert.deepEqual(quotaFallback(cards, pool, walls({}), NOW), []);
});

test("learned walls from provider-walls.json reach the walk through activeWalls", () => {
	// PI[1] shares its provider with paid refs, so its learned wall is keyed by the ref (wallKey).
	const learned = { ...pool, providerWalls: { [wallKey(pool, PI[1])]: { until: NOW + 60_000, source: "error" as const } } };
	const [action] = quotaFallback([card()], learned, activeWalls(learned, undefined, NOW), NOW);
	assert.equal((action as { ref: string }).ref, PI[2]);
});

function fakePorts(over: Partial<QuotaFallbackPorts> = {}) {
	const calls: string[] = [];
	const ports: QuotaFallbackPorts = {
		setModel: (lane, ref) => (calls.push(`set-model ${lane} ${ref}`), { ok: true }),
		scheduleResume: (lane, at, text) => (calls.push(`timer ${lane} ${at.toISOString()} ${text}`), { unit: "u" }),
		event: (line) => void calls.push(`event ${line}`),
		markHandled: (lane, at) => void calls.push(`mark ${lane} ${at}`),
		now: () => NOW,
		...over,
	};
	return { ports, calls };
}

test("a switch queues set-model, then the event, then marks the wall handled", () => {
	const { ports, calls } = fakePorts();
	applyQuotaFallback(quotaFallback([card()], pool, walls({}), NOW), ports);
	assert.deepEqual(calls, [`set-model pi-a ${PI[1]}`, `event QUOTA WALL: pi-a | ${PI[0]} walled until 2026-10-10T14:00:00Z; switched to ${PI[1]}`, `mark pi-a ${NOW}`]);
});

test("a resume timer carries the continuation text; a refusal is named in the event and the wall is still marked once", () => {
	const all = walls(Object.fromEntries(PI.map((ref) => [wallKey(pool, ref), wall(RESET)])));
	const ok = fakePorts();
	applyQuotaFallback(quotaFallback([card()], pool, all, NOW), ok.ports);
	assert.equal(ok.calls[0], `timer pi-a ${new Date(RESET).toISOString()} ${QUOTA_RESUME_TEXT}`);

	const refused = fakePorts({ scheduleResume: () => ({ error: "systemd-run failed (exit 1): no bus" }) });
	applyQuotaFallback(quotaFallback([card()], pool, all, NOW), refused.ports);
	assert.match(refused.calls[0], /^event QUOTA WALL: pi-a \| .*resume timer at 2026-10-10T14:00:00Z failed: systemd-run failed \(exit 1\): no bus$/);
	assert.equal(refused.calls[1], `mark pi-a ${NOW}`);

	const declined = fakePorts({ setModel: () => ({ ok: false, error: "no card" }) });
	applyQuotaFallback(quotaFallback([card()], pool, walls({}), NOW), declined.ports);
	assert.match(declined.calls[0], new RegExp(`switch to ${PI[1].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} failed: no card$`));
});
