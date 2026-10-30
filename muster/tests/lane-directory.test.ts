import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
	enumerateLanes,
	formatLaneJson,
	formatLaneTable,
	readLaneRegistry,
	resolveSeatTarget,
	_internal,
	type LaneCard,
	type LaneEvidence,
} from "../lib/lane-directory.ts";
import { laneControlDecision } from "../lib/lane-control.ts";
import { writeLaneRecord } from "../lane-lifecycle.ts";
import { harnessRoot } from "../../core/harness-paths.ts";
import { poolConfigPath } from "../../routing/provider-pool.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);

const { derivePiSession, stateForPiSession, stateFromClaudeStatus } = _internal;

const NOW = Date.parse("2026-10-07T19:00:00.000Z");
const MIN = 60_000;

/** No tmux server, no process, no systemd unit: a fixture never reads the real machine. */
const NO_SYSTEM: Partial<LaneEvidence> = {
	tmuxPanes: () => [],
	pidAlive: () => false,
	hasAgentEnv: () => false,
	piProcesses: () => [],
	hermesUnits: () => [],
};

/** the operator's own Pi session id: a card keyed by it, carrying no `origin`, is his session and never a worker lane. */
const OPERATOR_SESSION = "01a15fad-62a3-7141-8245-568e071e3c40";

/** A minimal valid provider-pool.json whose single shape matches "quota exceeded". */
const FIXTURE_POOL = JSON.stringify({
	version: 1,
	virtualProvider: "pool",
	cooldownMs: 60_000,
	resetHorizonMs: 3_600_000,
	roles: { chat: ["openai/gpt-5"] },
	quotaShapes: [{ id: "test-wall", match: "quota exceeded" }],
});

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function sessionLine(ms: number, cwd: string): string {
	return JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: iso(ms), cwd }) + "\n";
}

function modelLine(ms: number): string {
	return JSON.stringify({ type: "model_change", timestamp: iso(ms), provider: "openai", modelId: "gpt-5" }) + "\n";
}

function userLine(ms: number): string {
	return JSON.stringify({ type: "message", timestamp: iso(ms), message: { role: "user", content: [{ type: "text", text: "hi" }] } }) + "\n";
}

function assistantLine(ms: number, extra: { stopReason?: string; errorMessage?: string } = {}): string {
	return JSON.stringify({
		type: "message",
		timestamp: iso(ms),
		message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: extra.stopReason ?? "stop", ...(extra.errorMessage ? { errorMessage: extra.errorMessage } : {}) },
	}) + "\n";
}

function writeSession(root: string, dir: string, name: string, body: string, mtimeMs: number): string {
	const sub = join(root, dir);
	mkdirSync(sub, { recursive: true });
	const full = join(sub, name);
	writeFileSync(full, body);
	utimesSync(full, new Date(mtimeMs), new Date(mtimeMs));
	return full;
}

function fixtureHome(): { home: string; sessions: string; cards: string; pool: string } {
	const base = mkdtempSync(join(tmpdir(), "lane-dir-"));
	const home = join(base, "home");
	const sessions = join(home, ".pi", "agent", "sessions");
	const cards = join(home, ".pi", "agent", "state", "muster", "lanes");
	mkdirSync(sessions, { recursive: true });
	mkdirSync(cards, { recursive: true });
	const pool = join(home, ".pi", "agent", "provider-pool.json");
	writeFileSync(pool, FIXTURE_POOL);
	return { home, sessions, cards, pool };
}

test("derivePiSession reads cwd from the session header and the model from the latest model_change", () => {
	const tail =
		sessionLine(NOW - 5 * MIN, "/home/operator/projects/alpha") +
		modelLine(NOW - 4 * MIN) +
		userLine(NOW - 3 * MIN) +
		assistantLine(NOW - 2 * MIN);
	const d = derivePiSession(tail, "lane-1");
	assert.equal(d.cwd, "/home/operator/projects/alpha");
	assert.deepEqual(d.latestModel, { provider: "openai", modelId: "gpt-5" });
	assert.equal(d.lastUserMs, NOW - 3 * MIN);
	assert.equal(d.lastAssistant?.timestampMs, NOW - 2 * MIN);
	assert.equal(d.lastActivityMs, NOW - 2 * MIN);
});

test("a Pi session is running when the assistant answered last and idle when the user spoke last", () => {
	const shapes: never[] = [];
	const assistantLast = derivePiSession(userLine(NOW - 3 * MIN) + assistantLine(NOW - 2 * MIN), "a");
	assert.equal(stateForPiSession(assistantLast, { now: NOW, stalledMin: 20, goneMin: 60, shapes }).state, "running");
	const userLast = derivePiSession(assistantLine(NOW - 3 * MIN) + userLine(NOW - 2 * MIN), "b");
	assert.equal(stateForPiSession(userLast, { now: NOW, stalledMin: 20, goneMin: 60, shapes }).state, "idle");
});

test("a session past the stalled threshold is stalled, past the gone threshold is gone", () => {
	const shapes: never[] = [];
	const d = derivePiSession(userLine(NOW - 25 * MIN) + assistantLine(NOW - 25 * MIN), "c");
	assert.equal(stateForPiSession(d, { now: NOW, stalledMin: 20, goneMin: 60, shapes }).state, "stalled");
	const old = derivePiSession(userLine(NOW - 90 * MIN) + assistantLine(NOW - 90 * MIN), "d");
	const out = stateForPiSession(old, { now: NOW, stalledMin: 20, goneMin: 60, shapes });
	assert.equal(out.state, "gone");
	assert.equal(out.since, NOW - 90 * MIN);
});

test("a quota-shaped assistant error is quota-walled with the shape id as its wall", () => {
	const shapes = [{ id: "test-wall", match: "quota exceeded" }];
	const d = derivePiSession(
		userLine(NOW - 2 * MIN) + assistantLine(NOW - 1 * MIN, { stopReason: "error", errorMessage: "openai: quota exceeded, resets 2026-10-08" }),
		"e",
	);
	const out = stateForPiSession(d, { now: NOW, stalledMin: 20, goneMin: 60, shapes });
	assert.equal(out.state, "quota-walled");
	// The wall is the shared LaneWall object (F2), whatever the source.
	assert.equal(out.wall?.shapeId, "test-wall");
});

test("a plain error that matches no shape is not a quota wall", () => {
	const shapes = [{ id: "test-wall", match: "quota exceeded" }];
	const d = derivePiSession(
		userLine(NOW - 2 * MIN) + assistantLine(NOW - 1 * MIN, { stopReason: "error", errorMessage: "something else broke" }),
		"f",
	);
	const out = stateForPiSession(d, { now: NOW, stalledMin: 20, goneMin: 60, shapes });
	assert.notEqual(out.state, "quota-walled");
	assert.equal(out.wall, null);
});

test("claude agent statuses map to the §4.2 states", () => {
	assert.equal(stateFromClaudeStatus("busy"), "running");
	assert.equal(stateFromClaudeStatus("idle"), "idle");
	assert.equal(stateFromClaudeStatus("waiting"), "waiting");
	assert.equal(stateFromClaudeStatus("blocked"), "waiting");
	assert.equal(stateFromClaudeStatus("working"), "running");
	assert.equal(stateFromClaudeStatus("weird"), "idle");
	// `claude agents --json` background rows carry no `status` at all.
	assert.equal(stateFromClaudeStatus(undefined), "idle");
});

test("a registry-named session is listed as its lane, and an unclaimed session is not a lane by default (check 1)", () => {
	const fx = fixtureHome();
	try {
		const body = sessionLine(NOW - 5 * MIN, "/home/operator/projects/alpha") + modelLine(NOW - 4 * MIN) + userLine(NOW - 3 * MIN) + assistantLine(NOW - 2 * MIN);
		writeSession(fx.sessions, "--home-operator-projects-alpha--", "2026-10-07T18-55-00-000Z_11111111-2222-3333-4444-555555555555.jsonl", body, NOW - 2 * MIN);

		// No registry entry: this is an old session, not a lane.
		const withoutRegistry = enumerateLanes({ evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, skipClaude: true });
		assert.equal(withoutRegistry.length, 0, "a session no lane claims does not appear by default");

		// The launcher's registry names it: one row, under the lane name.
		const registryPath = join(fx.home, "pi-lanes.json");
		writeFileSync(registryPath, JSON.stringify({ "pi-alpha": "11111111-2222-3333-4444-555555555555" }));
		const cards = enumerateLanes({ evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, laneRegistryPath: registryPath, poolConfigPath: fx.pool, nowMs: NOW, skipClaude: true });
		assert.equal(cards.length, 1);
		const card = cards[0]!;
		assert.equal(card.laneId, "pi-alpha", "the lane name, never a session UUID");
		assert.equal(card.harness, "pi");
		assert.equal(card.cwd, "/home/operator/projects/alpha");
		assert.equal(card.model, "openai/gpt-5");
		assert.equal(card.state, "running");
		assert.equal(card.authoritative, false, "no card yet: the bus cannot reach it");

		// --all brings unclaimed sessions back for an operator who wants them.
		const all = enumerateLanes({ evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, laneRegistryPath: registryPath, includeUnregisteredSessions: true, poolConfigPath: fx.pool, nowMs: NOW, skipClaude: true });
		assert.equal(all.length, 1, "the registered lane covers the session; no second row");
		const allWithoutRegistry = enumerateLanes({ evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, includeUnregisteredSessions: true, poolConfigPath: fx.pool, nowMs: NOW, skipClaude: true });
		assert.equal(allWithoutRegistry.length, 1);
		assert.equal(allWithoutRegistry[0]!.laneId, "11111111-2222-3333-4444-555555555555");
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test("enumerateLanes drops sessions whose last activity is past the gone threshold", () => {
	const fx = fixtureHome();
	try {
		const body = sessionLine(NOW - 90 * MIN, "/home/operator/projects/old") + userLine(NOW - 90 * MIN);
		writeSession(fx.sessions, "--home-operator-projects-old--", "2026-10-07T17-00-00-000Z_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl", body, NOW - 90 * MIN);
		const cards = enumerateLanes({ evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, skipClaude: true });
		assert.equal(cards.length, 0);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test("an A2 lane card is authoritative and wins over the session with the same laneId", () => {
	const fx = fixtureHome();
	try {
		const body = sessionLine(NOW - 5 * MIN, "/home/operator/projects/alpha") + userLine(NOW - 5 * MIN) + assistantLine(NOW - 4 * MIN);
		writeSession(fx.sessions, "--home-operator-projects-alpha--", "2026-10-07T18-55-00-000Z_11111111-2222-3333-4444-555555555555.jsonl", body, NOW - 4 * MIN);
		const card: LaneCard = {
			laneId: "11111111-2222-3333-4444-555555555555",
			harness: "pi",
			cwd: "/home/operator/projects/alpha",
			branch: "feat/x",
			state: "stalled",
			model: "openai/gpt-5",
			thinking: null,
			since: NOW - 21 * MIN,
			updatedAt: NOW - 5_000,
			wall: null,
		};
		writeFileSync(join(fx.cards, "11111111-2222-3333-4444-555555555555.json"), JSON.stringify(card));
		const cards = enumerateLanes({ evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, skipClaude: true });
		assert.equal(cards.length, 1);
		assert.equal(cards[0]!.authoritative, true);
		assert.equal(cards[0]!.state, "stalled");
		assert.equal(cards[0]!.branch, "feat/x");
		assert.equal(cards[0]!.since, NOW - 21 * MIN);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test("a card heartbeat is heartbeatAt and never the last turn (audit a2)", () => {
	const fx = fixtureHome();
	try {
		const card = { laneId: "pi-hb", harness: "pi", state: "idle", since: NOW - 40 * MIN, updatedAt: NOW - 5_000 };
		writeFileSync(join(fx.cards, "pi-hb.json"), JSON.stringify(card));
		const [row] = enumerateLanes({ evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, skipClaude: true });
		assert.equal(row!.heartbeatAt, NOW - 5_000);
		assert.equal(row!.lastActivityMs, NOW - 40 * MIN, "the heartbeat does not move the last turn");
		writeFileSync(join(fx.cards, "pi-hb.json"), JSON.stringify({ ...card, lastActivityMs: NOW - 12 * MIN }));
		const [turn] = enumerateLanes({ evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, skipClaude: true });
		assert.equal(turn!.lastActivityMs, NOW - 12 * MIN);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test("an empty or unreadable card is skipped, and its lane still lists from the registry (check 1)", () => {
	const fx = fixtureHome();
	try {
		mkdirSync(fx.cards, { recursive: true });
		writeFileSync(join(fx.cards, "oc-bus1.json"), "");
		writeFileSync(join(fx.cards, "oc-db3.json"), "{ not json");
		writeFileSync(join(fx.cards, "pi-be-g3.json"), JSON.stringify({ laneId: "pi-be-g3", harness: "pi", state: "idle", updatedAt: NOW - 1000 }));
		mkdirSync(join(fx.home, "state"), { recursive: true });
		const registry = join(fx.home, "state", "pi-lanes.json");
		writeFileSync(registry, JSON.stringify({ "oc-bus1": "ses_throwaway", "pi-be-g3": "sess-g3" }));
		const cards = enumerateLanes({ evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, laneRegistryPath: registry, poolConfigPath: fx.pool, nowMs: NOW, skipClaude: true });
		const ids = cards.map((card) => card.laneId);
		// The 0-byte and torn files are not lanes: they must not appear as cards,
		// and reading them must not abort the enumeration.
		assert.equal(ids.includes("oc-bus1"), false);
		assert.equal(ids.includes("oc-db3"), false);
		assert.equal(ids.includes("pi-be-g3"), true, "the healthy card is still listed");
		assert.equal(cards.find((card) => card.laneId === "pi-be-g3")!.authoritative, true);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test("a card row keeps the lane's own report and context, not just its state (checks 3, 4, 7)", () => {
	const fx = fixtureHome();
	try {
		const cardsDir = fx.cards;
		mkdirSync(cardsDir, { recursive: true });
		writeFileSync(
			join(cardsDir, "pi-bus-proof.json"),
			JSON.stringify({
				laneId: "pi-bus-proof",
				harness: "pi",
				cwd: "/home/operator/projects/x",
				state: "waiting",
				model: "openai-codex/gpt-5.6-luna",
				since: NOW - 5 * MIN,
				updatedAt: NOW - 1000,
				wall: null,
				contextPercent: 42,
				lastReport: { kind: "blocked", summary: "BLOCKED: needs a decision", at: NOW - 2000 },
			}),
		);
		// A foreign shape must never reach a view as if it were a report.
		writeFileSync(join(cardsDir, "pi-torn.json"), JSON.stringify({ laneId: "pi-torn", harness: "pi", state: "idle", updatedAt: NOW - 1000, lastReport: { kind: "blocked" } }));
		const cards = enumerateLanes({ evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: cardsDir, poolConfigPath: fx.pool, nowMs: NOW, skipClaude: true });
		const byId = new Map(cards.map((card) => [card.laneId, card]));
		assert.equal(byId.get("pi-bus-proof")!.contextPercent, 42);
		assert.equal(byId.get("pi-bus-proof")!.lastReport!.kind, "blocked");
		assert.equal(byId.get("pi-bus-proof")!.lastReport!.summary, "BLOCKED: needs a decision");
		// `muster wait --lanes` and the mission table read these, so a malformed
		// mark is dropped rather than rendered.
		assert.equal(byId.get("pi-torn")!.lastReport, undefined);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test("enumerateLanes turns `claude agents --json` rows into claude cards with mapped states", () => {
	const fx = fixtureHome();
	try {
		const rows = [
			{ id: "c1", sessionId: "claude-sess-1", pid: 42, cwd: "/home/operator/projects/beta", name: "worker", status: "busy", kind: "worker", startedAt: NOW - 10 * MIN },
			{ id: "c2", sessionId: "claude-sess-2", pid: 43, cwd: "/home/operator/projects/gamma", name: "reviewer", status: "waiting", waitingFor: "user", kind: "worker", startedAt: NOW - 10 * MIN },
			{ id: "c3", sessionId: "claude-sess-3", pid: 44, cwd: "/home/operator/projects/delta", name: "idle-one", status: "idle", kind: "worker", startedAt: NOW - 10 * MIN },
			// The live shape: a background agent has `state` and no `status` at all.
			{ id: "c4", sessionId: "claude-sess-4", cwd: "/home/operator", kind: "background", startedAt: NOW - 10 * MIN, name: "be", state: "blocked" },
			// Neither field: the agent is listed, so it is not gone, and its
			// state is unknown to us — never a crash.
			{ id: "c5", sessionId: "claude-sess-5", cwd: "/home/operator", kind: "background", startedAt: NOW - 10 * MIN, name: "mystery" },
		];
		const cards = enumerateLanes({ evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, claudeAgentsOverride: { stdout: JSON.stringify(rows) } });
		assert.equal(cards.length, 5);
		// Check 1: a Claude lane is listed by its name (`claude attach <name>`),
		// never a session UUID; a row with no name falls back to its short id.
		const byId = new Map(cards.map((card) => [card.laneId, card]));
		assert.equal(byId.get("worker")!.harness, "claude");
		assert.equal(byId.get("worker")!.state, "running");
		assert.equal(byId.get("reviewer")!.state, "waiting");
		assert.equal(byId.get("idle-one")!.state, "idle");
		assert.equal(byId.get("be")!.state, "waiting");
		assert.equal(byId.get("mystery")!.state, "idle");
		assert.equal(byId.get("worker")!.authoritative, true);
		assert.equal(byId.has("claude-sess-1"), false, "the UUID is not the lane's name");
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test("enumerateLanes with a quota-shaped error in a live session reports quota-walled through the pool shapes", () => {
	const fx = fixtureHome();
	try {
		const body =
			sessionLine(NOW - 5 * MIN, "/home/operator/projects/alpha") +
			userLine(NOW - 3 * MIN) +
			assistantLine(NOW - 1 * MIN, { stopReason: "error", errorMessage: "openai: quota exceeded, resets 2026-10-08" });
		writeSession(fx.sessions, "--home-operator-projects-alpha--", "2026-10-07T18-55-00-000Z_99999999-8888-7777-6666-555555555555.jsonl", body, NOW - 1 * MIN);
		const cards = enumerateLanes({ evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, includeUnregisteredSessions: true, poolConfigPath: fx.pool, nowMs: NOW, skipClaude: true });
		assert.equal(cards.length, 1);
		assert.equal(cards[0]!.state, "quota-walled");
		assert.equal(cards[0]!.wall?.shapeId, "test-wall");
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test("a card whose heartbeat expired reads as gone whatever state it last wrote (F3)", () => {
	const fx = fixtureHome();
	try {
		const fresh: LaneCard = {
			laneId: "pi-fresh",
			harness: "pi",
			cwd: "/home/operator/projects/alpha",
			branch: "feat/x",
			state: "running",
			model: "openai/gpt-5",
			thinking: null,
			since: NOW - 5_000,
			updatedAt: NOW - 1_000,
			wall: null,
		};
		// One heartbeat interval past the 45 s window: the process is gone, not stalled.
		const dead: LaneCard = { ...fresh, laneId: "pi-dead", state: "running", updatedAt: NOW - 60_000 };
		// A card with no heartbeat at all cannot claim freshness either way; its own state stands.
		const legacy: LaneCard = { ...fresh, laneId: "pi-legacy", state: "idle", updatedAt: null };
		writeFileSync(join(fx.cards, "pi-fresh.json"), JSON.stringify(fresh));
		writeFileSync(join(fx.cards, "pi-dead.json"), JSON.stringify(dead));
		writeFileSync(join(fx.cards, "pi-legacy.json"), JSON.stringify(legacy));
		const cards = enumerateLanes({ evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, skipClaude: true });
		const byId = new Map(cards.map((card) => [card.laneId, card]));
		assert.equal(byId.get("pi-fresh")!.state, "running", "a fresh heartbeat keeps the writer's state");
		assert.equal(byId.get("pi-dead")!.state, "gone", "three missed beats is gone even when the card says running");
		assert.equal(byId.get("pi-legacy")!.state, "idle");
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test("a card covers its session file: one physical lane is one row (F4)", () => {
	const fx = fixtureHome();
	try {
		const sessionId = "12121212-3434-5656-7878-909090909090";
		const body = sessionLine(NOW - 5 * MIN, "/home/operator/projects/alpha") + userLine(NOW - 5 * MIN) + assistantLine(NOW - 4 * MIN);
		writeSession(fx.sessions, "--home-operator-projects-alpha--", `2026-10-07T18-55-00-000Z_${sessionId}.jsonl`, body, NOW - 4 * MIN);
		const card: LaneCard = {
			laneId: "pi-core",
			harness: "pi",
			cwd: "/home/operator/projects/alpha",
			branch: "feat/x",
			state: "running",
			model: "openai/gpt-5",
			thinking: null,
			since: NOW - 5_000,
			updatedAt: NOW - 1_000,
			wall: null,
			sessionId,
		};
		writeFileSync(join(fx.cards, "pi-core.json"), JSON.stringify(card));
		const cards = enumerateLanes({ evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, skipClaude: true });
		assert.equal(cards.length, 1, "the session file behind the card is not listed again");
		assert.equal(cards[0]!.laneId, "pi-core");
		assert.equal(cards[0]!.sessionId, sessionId);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test("a walled card renders its shape, never an object (F2)", () => {
	const fx = fixtureHome();
	try {
		const card: LaneCard = {
			laneId: "pi-walled",
			harness: "pi",
			cwd: "/home/operator/projects/alpha",
			branch: null,
			state: "quota-walled",
			model: "openai/gpt-5",
			thinking: null,
			since: NOW - 60_000,
			updatedAt: NOW - 1_000,
			wall: { shapeId: "test-wall", resetAt: Date.parse("2026-10-08"), assumed: true },
		};
		writeFileSync(join(fx.cards, "pi-walled.json"), JSON.stringify(card));
		const cards = enumerateLanes({ evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, skipClaude: true });
		assert.equal(cards.length, 1);
		assert.equal(cards[0]!.wall?.shapeId, "test-wall");
		const table = formatLaneTable(cards);
		assert.match(table, /quota-walled \(test-wall\)/);
		assert.doesNotMatch(table, /\[object Object\]/);
		const json = JSON.parse(formatLaneJson(cards)) as Array<{ wall: { shapeId: string } | null }>;
		assert.equal(json[0]!.wall?.shapeId, "test-wall");
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test("enumerateLanes orders running before idle before stalled before gone", () => {
	const fx = fixtureHome();
	try {
		const card = (laneId: string, state: LaneCard["state"], since: number): void => {
			writeFileSync(join(fx.cards, `${laneId}.json`), JSON.stringify({ laneId, harness: "pi", cwd: null, branch: null, state, model: null, thinking: null, since, wall: null }));
		};
		card("gone-lane", "gone", NOW - 90 * MIN);
		card("idle-lane", "idle", NOW - 30 * MIN);
		card("stalled-lane", "stalled", NOW - 25 * MIN);
		card("running-lane", "running", NOW - 1 * MIN);
		const cards = enumerateLanes({ evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, skipClaude: true });
		assert.deepEqual(cards.map((c) => c.laneId), ["running-lane", "idle-lane", "stalled-lane", "gone-lane"]);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test("a malformed card file is skipped without aborting the enumeration", () => {
	const fx = fixtureHome();
	try {
		writeFileSync(join(fx.cards, "bad-card.json"), "{not json");
		writeFileSync(join(fx.cards, "good-card.json"), JSON.stringify({ laneId: "good-card", harness: "pi", cwd: null, branch: null, state: "idle", model: null, thinking: null, since: NOW, wall: null }));
		const cards = enumerateLanes({ evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, skipClaude: true });
		assert.equal(cards.length, 1);
		assert.equal(cards[0]!.laneId, "good-card");
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test("formatLaneJson emits every §4.2 card field as JSON", () => {
	const cards: LaneCard[] = [{
		laneId: "lane-1",
		harness: "pi",
		cwd: "/home/operator/projects/alpha",
		branch: "feat/x",
		state: "running",
		model: "openai/gpt-5",
		thinking: null,
		since: NOW,
		wall: null,
		authoritative: false,
		lastActivityMs: NOW,
	}];
	const parsed = JSON.parse(formatLaneJson(cards)) as LaneCard[];
	assert.equal(parsed.length, 1);
	for (const field of ["laneId", "harness", "cwd", "branch", "state", "model", "thinking", "since", "wall"]) {
		assert.ok(field in parsed[0]!, `missing §4.2 field ${field}`);
	}
});

test("formatLaneTable renders a header and one row per lane", () => {
	const cards: LaneCard[] = [{
		laneId: "lane-1",
		harness: "pi",
		cwd: "/home/operator/projects/alpha",
		branch: null,
		state: "running",
		model: "openai/gpt-5",
		thinking: null,
		since: NOW,
		wall: null,
	}];
	// Check 1's columns: the card's heartbeat age proves a running lane is alive.
	const table = formatLaneTable(cards, NOW);
	assert.match(table, /lane\s+state\s+harness\s+model\s+cwd\s+activity\s+updated/);
	assert.match(table, /lane-1/);
	assert.match(table, /running/);
	assert.match(table, /0s\s+—/, "a row without a heartbeat shows no age rather than a fake one");
	const fresh = formatLaneTable([{ ...cards[0]!, updatedAt: NOW - 4_000, lastActivityMs: NOW - 90_000 }], NOW);
	assert.match(fresh, /2m\s+4s/, "activity and heartbeat ages are separate columns");
	assert.equal(formatLaneTable([]), "no lanes visible (no card files, no registered lane sessions, no claude agents).");
});

test("a registry row in the object shape is read, retired or not", () => {
	const fx = fixtureHome();
	try {
		const registryPath = join(fx.home, "pi-lanes.json");
		writeFileSync(
			registryPath,
			JSON.stringify({
				"pi-alpha": { sessionId: "11111111-2222-3333-4444-555555555555", harness: "pi" },
				"oc-old": { sessionId: "ses_eeeeeeeeeeeeeeeeeeeeeeee", harness: "opencode", retired: true, retiredAt: "2026-10-08" },
			}),
		);
		const registry = readLaneRegistry(registryPath);
		assert.equal(registry.get("11111111-2222-3333-4444-555555555555"), "pi-alpha");
		assert.equal(
			registry.get("ses_eeeeeeeeeeeeeeeeeeeeeeee"),
			"oc-old",
			"a retired row is still a row here; night-watch is the reader that skips it",
		);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
		rmSync(join(fx.home, ".."), { recursive: true, force: true });
	}
});

test("a Claude lane's card keeps its report while `claude agents` supplies state and liveness", () => {
	const fx = fixtureHome();
	try {
		const row = { id: "c9", sessionId: "claude-sess-9", cwd: "/home/operator/work", name: "cc-bus", status: "busy", kind: "background", startedAt: NOW - 5 * MIN };
		const cardOf = (updatedAt: number) => JSON.stringify({
			laneId: "cc-bus", harness: "claude", cwd: null, branch: null, state: "idle", model: null, thinking: null, since: null, updatedAt, wall: null,
			sessionId: "claude-sess-9", endpoint: "inbox: muster wait --inbox cc-bus",
			lastReport: { kind: "review_ready", summary: "2c done", at: NOW - MIN },
		});
		mkdirSync(fx.cards, { recursive: true });
		// Written an hour ago: a Pi card would read as gone, a Claude card is judged by the CLI.
		writeFileSync(join(fx.cards, "cc-bus.json"), cardOf(NOW - 60 * MIN));
		const live = enumerateLanes({ evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, claudeAgentsOverride: { stdout: JSON.stringify([row]) } });
		assert.equal(live.length, 1, "the card and the CLI row are one lane");
		// The card is idle (the Stop hook wrote it) and `claude agents` is busy only for the lane's waiter: idle (LC16 F9).
		assert.equal(live[0]!.state, "idle");
		assert.equal(live[0]!.cwd, "/home/operator/work");
		assert.equal(live[0]!.lastReport?.summary, "2c done");
		assert.equal(live[0]!.endpoint, "inbox: muster wait --inbox cc-bus");
		// The session is no longer listed: the stale card expires like any other.
		const dead = enumerateLanes({ evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, claudeAgentsOverride: { stdout: "[]" } });
		assert.equal(dead.length, 1);
		assert.equal(dead[0]!.state, "gone");
		assert.equal(dead[0]!.lastReport?.summary, "2c done");
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test("a Claude lane that ended its turn reads idle while only its background `muster wait` keeps `claude agents` busy (LC16 F9)", () => {
	const fx = fixtureHome();
	try {
		mkdirSync(fx.cards, { recursive: true });
		const card = (laneId: string, state: string) => writeFileSync(join(fx.cards, `${laneId}.json`), JSON.stringify({
			laneId, harness: "claude", cwd: null, branch: null, state, model: null, thinking: null, since: null, updatedAt: NOW - MIN, wall: null,
			sessionId: `S-${laneId}`, endpoint: `inbox: muster wait --inbox ${laneId}`,
		}));
		// rsmoke2, 2026-10-18: card idle at its Stop, `claude agents` busy because its waiter lives, turn state done.
		card("cc-done", "idle");
		card("cc-blocked", "idle");
		// A short last message leaves `claude agents` at `working` while the waiter lives (lab lane, 2026-10-18): the Stop hook's idle card decides.
		card("cc-working", "idle");
		// A lane in its turn: the card says running and the CLI says working.
		card("cc-turn", "running");
		// The CLI's turn state outranks a card that missed the Stop.
		card("cc-running-card", "running");
		const row = (name: string, state: string) => ({ id: name.slice(0, 8), sessionId: `S-${name}`, pid: 1, cwd: "/w", name, status: "busy", state, kind: "background", startedAt: NOW - 5 * MIN });
		const rows = [row("cc-done", "done"), row("cc-blocked", "blocked"), row("cc-working", "working"), row("cc-turn", "working"), row("cc-running-card", "done")];
		const lanes = enumerateLanes({ evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, claudeAgentsOverride: { stdout: JSON.stringify(rows) } });
		const byId = new Map(lanes.map((lane) => [lane.laneId, lane]));
		assert.equal(byId.get("cc-done")!.state, "idle");
		assert.equal(byId.get("cc-blocked")!.state, "waiting");
		assert.equal(byId.get("cc-working")!.state, "idle");
		assert.equal(byId.get("cc-turn")!.state, "running");
		assert.equal(byId.get("cc-running-card")!.state, "idle");
		// Liveness is still the CLI's: each listed session is one lane, none expired.
		assert.equal(lanes.length, 5);
		// An unenrolled session (no card) reads the same way.
		const bare = enumerateLanes({ evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: join(fx.home, "no-cards"), poolConfigPath: fx.pool, nowMs: NOW, claudeAgentsOverride: { stdout: JSON.stringify([row("cc-bare", "done")]) } });
		assert.equal(bare[0]!.state, "idle");
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test("a listed Claude lane reads as seen now; auto-named sessions are not lanes unless --all", () => {
	const fx = fixtureHome();
	try {
		const rows = [
			{ id: "c1", sessionId: "claude-sess-1", cwd: "/home/operator", name: "orchestrator", status: "busy", kind: "background", startedAt: NOW - 600 * MIN },
			{ id: "c2", sessionId: "claude-sess-2", cwd: "/home/operator", name: "acme-realty real estate agency OS", status: "idle", kind: "interactive", startedAt: NOW - 600 * MIN },
			{ id: "c3", sessionId: "claude-sess-3", cwd: "/home/operator", status: "idle", kind: "interactive", startedAt: NOW - 600 * MIN },
		];
		const base = { evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, claudeAgentsOverride: { stdout: JSON.stringify(rows) } };
		const lanes = enumerateLanes(base);
		assert.deepEqual(lanes.map((card) => card.laneId), ["orchestrator"]);
		// The CLI row has only a start time: "updated" is the moment it was seen alive.
		assert.equal(lanes[0]!.updatedAt, NOW);
		assert.equal(lanes[0]!.since, NOW - 600 * MIN);
		const all = enumerateLanes({ ...base, includeUnregisteredSessions: true });
		assert.equal(all.length, 3);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

// ─── Lifecycle WP2: evidence in the directory (audit a1 a2 a3 a5, LD2) ──────────────────────────

const SHIPPED_POOL_PATH = poolConfigPath();
const PI_UUID = "11111111-2222-3333-4444-555555555555";
const CLAUDE_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function writeCard(cards: string, card: Record<string, unknown>): void {
	mkdirSync(cards, { recursive: true });
	writeFileSync(join(cards, `${card["laneId"]}.json`), JSON.stringify(card));
}

function piCard(laneId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { laneId, harness: "pi", cwd: "/w", branch: null, state: "running", model: "openai/gpt-5", thinking: null, since: NOW - 30 * MIN, updatedAt: NOW - 5_000, wall: null, sessionId: PI_UUID, ...extra };
}

const pane = (window: string, dead = false, session = "pi", pid = 100) => ({ session, window, dead, pid });

test("a Pi lane is alive only while its window is in session pi with a live pane", () => {
	const fx = fixtureHome();
	try {
		writeCard(fx.cards, piCard("pi-up"));
		writeCard(fx.cards, piCard("pi-dead-pane", { sessionId: undefined }));
		writeCard(fx.cards, piCard("pi-no-window", { sessionId: undefined }));
		writeCard(fx.cards, piCard("pi-other-session", { sessionId: undefined }));
		const read = (tmuxPanes: LaneEvidence["tmuxPanes"]) => enumerateLanes({ evidence: { ...NO_SYSTEM, tmuxPanes }, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, skipClaude: true });
		const by = (rows: LaneCard[], id: string) => rows.find((row) => row.laneId === id)!;
		const rows = read(() => [pane("pi-up"), pane("pi-dead-pane", true), pane("pi-other-session", false, "scratch")]);
		assert.deepEqual([by(rows, "pi-up").alive, by(rows, "pi-up").aliveVia], [true, "tmux"]);
		assert.deepEqual([by(rows, "pi-dead-pane").alive, by(rows, "pi-dead-pane").aliveVia], [false, "tmux"], "a dead pane (remain-on-exit) is not alive");
		assert.equal(by(rows, "pi-no-window").alive, false);
		assert.equal(by(rows, "pi-other-session").alive, false, "only session pi holds Pi lanes");
		// tmux that cannot be read is not evidence of death.
		const unknown = read(() => undefined);
		assert.deepEqual([by(unknown, "pi-up").alive, by(unknown, "pi-up").aliveVia], [undefined, "none"]);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test("a Claude row whose pid is gone from /proc is not alive; a live pid is", () => {
	const fx = fixtureHome();
	try {
		const rows = [
			{ id: "d1", pid: 4242, sessionId: "claude-sess-dead", cwd: "/w", name: "sn-wp9", status: "idle", kind: "background", startedAt: NOW - 60 * MIN },
			{ id: "d2", pid: 4243, sessionId: "claude-sess-live", cwd: "/w", name: "sn-wp2", status: "busy", kind: "background", startedAt: NOW - 60 * MIN },
			{ id: "d3", sessionId: "claude-sess-nopid", cwd: "/w", name: "sn-wp10", state: "blocked", kind: "background", startedAt: NOW - 60 * MIN },
		];
		const lanes = enumerateLanes({ evidence: { ...NO_SYSTEM, pidAlive: (pid) => pid === 4243 }, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, claudeAgentsOverride: { stdout: JSON.stringify(rows) } });
		const by = (id: string) => lanes.find((row) => row.laneId === id)!;
		assert.deepEqual([by("sn-wp9").alive, by("sn-wp9").aliveVia], [false, "pid"]);
		assert.deepEqual([by("sn-wp2").alive, by("sn-wp2").aliveVia], [true, "claude-agents"]);
		assert.deepEqual([by("sn-wp10").alive, by("sn-wp10").aliveVia], [false, "claude-agents"], "a listed row with no process is not running");
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test("a carded Pi lane's last turn is read from its session file; the heartbeat no longer moves lastActivityMs", () => {
	const fx = fixtureHome();
	try {
		writeSession(fx.sessions, "--w--", `2026-10-07T18-00-00-000Z_${PI_UUID}.jsonl`, sessionLine(NOW - 60 * MIN, "/w") + userLine(NOW - 45 * MIN) + assistantLine(NOW - 40 * MIN), NOW - 40 * MIN);
		writeCard(fx.cards, piCard("pi-beats", { updatedAt: NOW - 2_000, lastActivityMs: NOW - 2_000 }));
		const [row] = enumerateLanes({ evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, skipClaude: true });
		assert.equal(row!.lastTurnAt, NOW - 40 * MIN);
		assert.equal(row!.lastActivityMs, NOW - 40 * MIN, "lastActivityMs is the last turn");
		assert.equal(row!.heartbeatAt, NOW - 2_000, "the heartbeat is its own field");
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test("a Claude lane's last turn is the last assistant entry of its transcript under ~/.claude/projects/<cwd>", () => {
	const fx = fixtureHome();
	try {
		const projects = join(fx.home, ".claude", "projects");
		const folder = join(projects, "-home-operator--worktrees-lane-x");
		mkdirSync(folder, { recursive: true });
		const entry = (type: string, ms: number, extra: Record<string, unknown> = {}) => JSON.stringify({ type, timestamp: iso(ms), ...extra }) + "\n";
		writeFileSync(join(folder, `${CLAUDE_UUID}.jsonl`), entry("user", NOW - 50 * MIN) + entry("assistant", NOW - 49 * MIN, { message: { content: [{ type: "text", text: "ok" }] } }) + entry("assistant", NOW - 20 * MIN, { isSidechain: true }) + entry("attachment", NOW - MIN));
		const rows = [{ id: "c1", pid: 77, sessionId: CLAUDE_UUID, cwd: "/home/operator/.worktrees/lane-x", name: "sn-lane-x", status: "idle", kind: "background", startedAt: NOW - 90 * MIN }];
		const [lane] = enumerateLanes({ evidence: { ...NO_SYSTEM, pidAlive: () => true }, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, claudeAgentsOverride: { stdout: JSON.stringify(rows) } });
		assert.equal(lane!.lastTurnAt, NOW - 49 * MIN, "a sidechain entry and a hook attachment are not turns");
		assert.equal(lane!.lastActivityMs, NOW - 49 * MIN);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test("the shipped pool classifies the recorded 429 endpoint wall and the disabled Claude subscription", () => {
	const fx = fixtureHome();
	try {
		const wall429 = '429: {"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}';
		writeSession(fx.sessions, "--w--", `2026-10-07T18-00-00-000Z_${PI_UUID}.jsonl`, sessionLine(NOW - 60 * MIN, "/w") + userLine(NOW - 10 * MIN) + assistantLine(NOW - 9 * MIN, { stopReason: "error", errorMessage: wall429 }), NOW - 9 * MIN);
		writeCard(fx.cards, piCard("pi-fixr6"));
		const folder = join(fx.home, ".claude", "projects", "-w");
		mkdirSync(folder, { recursive: true });
		const subscription = "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access";
		writeFileSync(join(folder, `${CLAUDE_UUID}.jsonl`), JSON.stringify({ type: "assistant", timestamp: iso(NOW - 3 * MIN), isApiErrorMessage: true, error: "oauth_org_not_allowed", message: { content: [{ type: "text", text: subscription }] } }) + "\n");
		const rows = [{ id: "c1", pid: 77, sessionId: CLAUDE_UUID, cwd: "/w", name: "sn-wp2", status: "idle", kind: "background", startedAt: NOW - 90 * MIN }];
		const lanes = enumerateLanes({ evidence: { ...NO_SYSTEM, pidAlive: () => true }, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: SHIPPED_POOL_PATH, nowMs: NOW, claudeAgentsOverride: { stdout: JSON.stringify(rows) } });
		const pi = lanes.find((row) => row.laneId === "pi-fixr6")!;
		assert.deepEqual([pi.state, pi.wall?.shapeId], ["quota-walled", "endpoint-unavailable-429"], "a wall in a carded lane's transcript is found");
		const claude = lanes.find((row) => row.laneId === "sn-wp2")!;
		assert.deepEqual([claude.state, claude.wall?.shapeId], ["quota-walled", "claude-subscription-disabled"]);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test("a wall that a later turn has passed is not a wall, and a gone card is never walled", () => {
	const fx = fixtureHome();
	try {
		const wall = "quota exceeded";
		writeSession(fx.sessions, "--w--", `2026-10-07T18-00-00-000Z_${PI_UUID}.jsonl`, sessionLine(NOW - 60 * MIN, "/w") + assistantLine(NOW - 30 * MIN, { stopReason: "error", errorMessage: wall }) + assistantLine(NOW - 20 * MIN), NOW - 20 * MIN);
		writeCard(fx.cards, piCard("pi-recovered"));
		const [row] = enumerateLanes({ evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, skipClaude: true });
		assert.deepEqual([row!.state, row!.wall], ["running", null]);
		writeSession(fx.sessions, "--w--", `2026-10-07T18-00-00-000Z_${PI_UUID}.jsonl`, sessionLine(NOW - 60 * MIN, "/w") + assistantLine(NOW - 30 * MIN, { stopReason: "error", errorMessage: wall }), NOW - 30 * MIN);
		writeCard(fx.cards, piCard("pi-recovered", { updatedAt: NOW - 3 * 60 * MIN }));
		const [stale] = enumerateLanes({ evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, skipClaude: true });
		assert.equal(stale!.state, "gone");
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test("origin: a card, a registry row, a lane record or a launcher environment make a row auto; anything else is operator and read-only", () => {
	const fx = fixtureHome();
	try {
		writeCard(fx.cards, { laneId: "sn-carded", harness: "claude", cwd: "/w", branch: null, state: "idle", model: null, thinking: null, since: null, updatedAt: NOW, wall: null, sessionId: "claude-sess-carded" });
		// the operator's own Pi session, exactly as it writes its own card: no `origin`, its working directory is home,
		// no lane record and no registry row. A card alone is not launch evidence, so the row is his session.
		writeCard(fx.cards, { laneId: OPERATOR_SESSION, harness: "pi", cwd: "/home/operator", branch: "", state: "idle", model: "minimax/MiniMax-M3.1-Flash", thinking: "max", since: NOW - MIN, updatedAt: NOW, wall: null, sessionId: OPERATOR_SESSION });
		writeLaneRecord(join(fx.cards, ".."), { laneId: "sn-recorded", harness: "claude", cwd: "/w", branch: null, launchedAt: NOW - 90 * MIN, launchedBy: "orchestrator", phase: "working", phaseSince: NOW - 90 * MIN });
		const rows = [
			{ id: "k1", pid: 11, sessionId: "claude-sess-carded", cwd: "/w", name: "sn-carded", status: "idle", kind: "background", startedAt: NOW - MIN },
			{ id: "k2", pid: 12, sessionId: "claude-sess-recorded", cwd: "/w", name: "sn-recorded", status: "idle", kind: "background", startedAt: NOW - MIN },
			{ id: "k3", pid: 13, sessionId: "claude-sess-env", cwd: "/w", name: "sn-launched", status: "idle", kind: "background", startedAt: NOW - MIN },
			{ pid: 14, sessionId: "claude-sess-orch", cwd: "/home/operator", name: "orchestrator", status: "busy", kind: "interactive", startedAt: NOW - MIN },
			{ pid: 15, sessionId: "ac71fe1d-7fe7-4176-900d-6fd47c09cdaf", cwd: "/home/operator", status: "idle", kind: "interactive", startedAt: NOW - MIN },
			{ pid: 16, sessionId: "dead-interactive-session", cwd: "/home/operator", status: "idle", kind: "interactive", startedAt: NOW - MIN },
		];
		const lanes = enumerateLanes({ evidence: { ...NO_SYSTEM, pidAlive: (pid) => pid !== 16, hasAgentEnv: (pid) => pid === 13 }, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, claudeAgentsOverride: { stdout: JSON.stringify(rows) } });
		const origins = Object.fromEntries(lanes.map((row) => [row.laneId, row.origin]));
		assert.deepEqual(origins, {
			"sn-carded": "auto",
			"sn-recorded": "auto",
			"sn-launched": "auto",
			[OPERATOR_SESSION]: "operator",
			orchestrator: "operator",
			"operator:claude:ac71fe1d": "operator",
		});
		assert.equal(laneControlDecision("pi", "stop", origins[OPERATOR_SESSION]).allowed, false);
		assert.equal(laneControlDecision("claude", "stop", origins["orchestrator"]).allowed, false);
		const table = formatLaneTable(lanes, NOW);
		assert.match(table, /operator:claude:ac71fe1d \[yours\]/);
		assert.match(table, /orchestrator \[yours\]/);
		assert.doesNotMatch(table, /sn-carded \[yours\]/);
		assert.match(table, /^01a15fad-62a3-7141-8245-… \[yours\]/m);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test("every control verb on a operator row is refused with the same reason, on every harness; an auto row is decided by the table", () => {
	for (const harness of ["pi", "opencode", "claude", "unknown"] as const) {
		for (const operation of ["abort", "stop", "setModel"] as const) {
			const decision = laneControlDecision(harness, operation, "operator");
			assert.equal(decision.allowed, false);
			assert.match(decision.allowed ? "" : decision.reason, /the operator's own session \(LD2\)/);
		}
	}
	assert.equal(laneControlDecision("pi", "stop", "auto").allowed, true);
	assert.equal(laneControlDecision("pi", "stop").allowed, true);
});

test("unenrolled Pi processes outside session pi and active Hermes services are listed as operator rows; a lane's own pane is not", () => {
	const fx = fixtureHome();
	try {
		const lanePanePid = 500;
		const evidence: Partial<LaneEvidence> = {
			...NO_SYSTEM,
			tmuxPanes: () => [pane("pi-be-g3", false, "pi", lanePanePid)],
			piProcesses: () => [
				{ pid: 501, lineage: [501, lanePanePid, 1] },
				{ pid: 900, sessionId: "deadbeef-0000-0000-0000-000000000000", lineage: [900, 800, 1] },
				{ pid: 901, lineage: [901, 800, 1] },
			],
			hermesUnits: () => ["hermes-gateway.service", "hermes-serve.service"],
		};
		const lanes = enumerateLanes({ evidence, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, skipClaude: true });
		assert.deepEqual(lanes.map((row) => row.laneId).sort(), ["operator:hermes:hermes-gateway", "operator:hermes:hermes-serve", "operator:pi:901", "operator:pi:deadbeef"]);
		assert.ok(lanes.every((row) => row.origin === "operator" && row.alive === true));
		assert.equal(lanes.find((row) => row.laneId === "operator:hermes:hermes-serve")!.aliveVia, "systemd");
		// With tmux unreadable the directory cannot tell a lane's pane from an outside one: it lists no Pi process.
		const blind = enumerateLanes({ evidence: { ...evidence, tmuxPanes: () => undefined }, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, skipClaude: true });
		assert.deepEqual(blind.map((row) => row.laneId).sort(), ["operator:hermes:hermes-gateway", "operator:hermes:hermes-serve"]);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test("a lane record with no card is listed as a gone row with its phase and its open question", () => {
	const fx = fixtureHome();
	try {
		const musterDir = join(fx.cards, "..");
		writeLaneRecord(musterDir, {
			laneId: "sn-parked", harness: "claude", cwd: "/w", branch: "lane/x", launchedAt: NOW - 5 * 60 * MIN, launchedBy: "orchestrator",
			phase: "parked", phaseSince: NOW - 40 * MIN, parkedAt: NOW - 40 * MIN,
			lastReport: { kind: "question", summary: "which schema?", at: NOW - 70 * MIN },
		});
		const lanes = enumerateLanes({ evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, skipClaude: true });
		assert.equal(lanes.length, 1);
		assert.deepEqual([lanes[0]!.state, lanes[0]!.phase, lanes[0]!.alive, lanes[0]!.origin], ["gone", "parked", false, "auto"]);
		assert.equal(lanes[0]!.lastReport?.summary, "which schema?");
		assert.match(formatLaneTable(lanes, NOW), /gone \(parked\)/);
		// A record whose lane has a card is one row, the card's.
		writeCard(fx.cards, { laneId: "sn-parked", harness: "claude", cwd: "/w", branch: null, state: "idle", model: null, thinking: null, since: null, updatedAt: NOW, wall: null });
		const withCard = enumerateLanes({ evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, skipClaude: true });
		assert.equal(withCard.length, 1);
		assert.equal(withCard[0]!.authoritative, true);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test("a row carries its lane record's session chain, on a carded lane and on a record-only row", () => {
	const fx = fixtureHome();
	try {
		const musterDir = join(fx.cards, "..");
		const base = { harness: "claude" as const, cwd: "/w", branch: null, launchedAt: NOW - 5 * 60 * MIN, launchedBy: "orchestrator", phase: "working" as const, phaseSince: NOW - MIN };
		writeLaneRecord(musterDir, { laneId: "sn-live", ...base, sessionId: "s-2", sessionChain: ["s-1", "s-2"] });
		writeLaneRecord(musterDir, { laneId: "sn-gone", ...base, phase: "parked", sessionId: "s-9", sessionChain: ["s-8", "s-9"] });
		writeLaneRecord(musterDir, { laneId: "sn-plain", ...base });
		writeCard(fx.cards, { laneId: "sn-live", harness: "claude", cwd: "/w", branch: null, state: "idle", model: null, thinking: null, since: null, updatedAt: NOW, wall: null });
		const lanes = enumerateLanes({ evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, skipClaude: true });
		const chain = (id: string): string[] | undefined => lanes.find((lane) => lane.laneId === id)?.sessionChain;
		assert.deepEqual(chain("sn-live"), ["s-1", "s-2"]);
		assert.deepEqual(chain("sn-gone"), ["s-8", "s-9"]);
		assert.equal(chain("sn-plain"), undefined, "a record with no chain adds nothing");
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

// ─── resolveSeatTarget (seat-move blueprint SM2, LD36) ──────────────────────

const CLAUDE_A = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLAUDE_B = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PI_A = "33333333-cccc-4ccc-8ccc-cccccccccccc";

test("resolveSeatTarget matches a live claude session by full id or 8+ prefix and names the waiter inbox", () => {
	const fx = fixtureHome();
	try {
		const rows = [
			{ sessionId: CLAUDE_A, pid: 4242, name: "orch-lane", kind: "interactive", cwd: "/tmp/a" },
			{ sessionId: CLAUDE_B, pid: 4242, kind: "interactive", cwd: "/tmp/b" },
		];
		const opts = {
			evidence: { ...NO_SYSTEM, pidAlive: (pid: number) => pid === 4242 },
			home: fx.home,
			sessionsRoot: fx.sessions,
			claudeAgentsOverride: { stdout: JSON.stringify(rows) },
			nowMs: NOW,
		};
		const full = resolveSeatTarget(CLAUDE_A, opts);
		assert.ok(full.ok, JSON.stringify(full));
		assert.deepEqual(full.target, { sessionId: CLAUDE_A, harness: "claude", alive: true, inbox: "orch-lane" });
		const prefix = resolveSeatTarget(CLAUDE_A.slice(0, 8), opts);
		assert.ok(prefix.ok && prefix.target.sessionId === CLAUDE_A && prefix.target.inbox === "orch-lane");
		const unnamed = resolveSeatTarget(CLAUDE_B, opts);
		assert.ok(unnamed.ok && unnamed.target.inbox === `operator:claude:${CLAUDE_B.slice(0, 8)}`, "an unnamed row's inbox is the unenrolled claude address");
		const short = resolveSeatTarget(CLAUDE_A.slice(0, 7), opts);
		assert.ok(!short.ok && /8\+ characters/.test(short.reason), JSON.stringify(short));
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test("resolveSeatTarget refuses a dead session, a shared live id and an ambiguous prefix; --harness only disambiguates", () => {
	const fx = fixtureHome();
	try {
		const base = {
			evidence: NO_SYSTEM,
			home: fx.home,
			sessionsRoot: fx.sessions,
			claudeAgentsOverride: { stdout: JSON.stringify([{ sessionId: CLAUDE_A, kind: "interactive" }]) },
			nowMs: NOW,
		};
		const dead = resolveSeatTarget(CLAUDE_A, base);
		assert.ok(!dead.ok && /dead/.test(dead.reason), JSON.stringify(dead));

		const shared = resolveSeatTarget(CLAUDE_A, {
			...base,
			claudeAgentsOverride: { stdout: JSON.stringify([{ sessionId: CLAUDE_A, pid: 4242 }, { sessionId: CLAUDE_A, pid: 4243 }]) },
			evidence: { ...NO_SYSTEM, pidAlive: () => true },
		});
		assert.ok(!shared.ok && /share/.test(shared.reason), JSON.stringify(shared));

		// A claude row and a pi process reporting the same session id: refused until --harness picks one.
		const cross = {
			...base,
			claudeAgentsOverride: { stdout: JSON.stringify([{ sessionId: CLAUDE_A, pid: 4242 }]) },
			evidence: { ...NO_SYSTEM, pidAlive: () => true, piProcesses: () => [{ pid: 91, sessionId: CLAUDE_A, lineage: [91] }] },
		};
		const ambiguous = resolveSeatTarget(CLAUDE_A.slice(0, 8), cross);
		assert.ok(!ambiguous.ok, JSON.stringify(ambiguous));
		const asPi = resolveSeatTarget(CLAUDE_A, { ...cross, harness: "pi" });
		assert.ok(asPi.ok && asPi.target.harness === "pi" && asPi.target.inbox === `operator:pi:${CLAUDE_A.slice(0, 8)}`);
		const asClaude = resolveSeatTarget(CLAUDE_A, { ...cross, harness: "claude" });
		assert.ok(asClaude.ok && asClaude.target.harness === "claude");
		const noPi = resolveSeatTarget(CLAUDE_B.slice(0, 8), { ...base, harness: "pi" });
		assert.ok(!noPi.ok && /no running pi session/.test(noPi.reason), JSON.stringify(noPi));

		// Two different session ids under one 8-character prefix: give more characters.
		const twinA = "aaaaaaaa-1111-4111-8111-111111111111";
		const twinB = "aaaaaaaa-2222-4222-8222-222222222222";
		const twins = resolveSeatTarget("aaaaaaaa", {
			...base,
			claudeAgentsOverride: { stdout: JSON.stringify([{ sessionId: twinA, pid: 4242 }, { sessionId: twinB, pid: 4242 }]) },
			evidence: { ...NO_SYSTEM, pidAlive: () => true },
		});
		assert.ok(!twins.ok && /2 sessions match/.test(twins.reason), JSON.stringify(twins));
		const longer = resolveSeatTarget(twinA.slice(0, 10), { ...base, claudeAgentsOverride: { stdout: JSON.stringify([{ sessionId: twinA, pid: 4242 }]) }, evidence: { ...NO_SYSTEM, pidAlive: () => true } });
		assert.ok(longer.ok && longer.target.sessionId === twinA);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test("resolveSeatTarget reads the pi sources: a live process, a registered lane's tmux window, and a recent file with no process", () => {
	const fx = fixtureHome();
	try {
		const live = resolveSeatTarget(PI_A, {
			skipClaude: true,
			evidence: { ...NO_SYSTEM, piProcesses: () => [{ pid: 91, sessionId: PI_A, lineage: [91] }] },
			home: fx.home,
			sessionsRoot: fx.sessions,
			nowMs: NOW,
		});
		assert.ok(live.ok && live.target.harness === "pi" && live.target.alive === true && live.target.inbox === `operator:pi:${PI_A.slice(0, 8)}`, JSON.stringify(live));

		// A recent session JSONL whose process is gone: the sources report it dead.
		writeSession(fx.sessions, "proj", `20261016T090000_${PI_A}.jsonl`, sessionLine(NOW - MIN, "/tmp/x"), NOW - MIN);
		const base = { skipClaude: true as const, evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, nowMs: NOW };
		const dead = resolveSeatTarget(PI_A, base);
		assert.ok(!dead.ok && /dead/.test(dead.reason), JSON.stringify(dead));

		// Enrolled in the registry, the inbox is the lane id, and tmux decides: a live window proves the
		// session, an unreadable tmux leaves liveness unknown, and no window reports it dead.
		const registryPath = join(fx.home, "state", "pi-lanes.json");
		mkdirSync(dirname(registryPath), { recursive: true });
		writeFileSync(registryPath, JSON.stringify({ "pi-lane-x": { sessionId: PI_A, harness: "pi" } }));
		const enrolled = { ...base, laneRegistryPath: registryPath };
		const windowed = resolveSeatTarget(PI_A.slice(0, 8), { ...enrolled, evidence: { ...NO_SYSTEM, tmuxPanes: () => [{ session: "pi", window: "pi-lane-x", dead: false, pid: 5 }] } });
		assert.ok(windowed.ok && windowed.target.alive === true && windowed.target.inbox === "pi-lane-x", JSON.stringify(windowed));
		const unproven = resolveSeatTarget(PI_A.slice(0, 8), { ...enrolled, evidence: { ...NO_SYSTEM, tmuxPanes: () => undefined } });
		assert.ok(unproven.ok && unproven.target.alive === undefined, `unknown liveness is accepted: ${JSON.stringify(unproven)}`);
		const emptyWindows = resolveSeatTarget(PI_A.slice(0, 8), enrolled);
		assert.ok(!emptyWindows.ok && /dead/.test(emptyWindows.reason), JSON.stringify(emptyWindows));
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

// --- VR21-42 S4: a lane's own launcher scope is liveness the heartbeat cannot deny ---
//
// pi-lane-launch.sh wraps every pane command in a transient `lane-<lane>-<epoch>.scope`
// (pi-lanes.slice; `lane-adopt-cgroup.sh` copies the naming for Claude lanes). A busy wait, a
// background process or a stalled transcript expires every other surface into `gone`, but a
// live cgroup under the lane's own name is the launcher's own proof the process tree still runs.

/** The launcher's scope listing for the tests below, with units that SHOULD and SHOULD NOT name a lane. */
const SCOPED_SYSTEM: Partial<LaneEvidence> = {
	...NO_SYSTEM,
	scopeUnits: () => [
		"lane-pi-x-1698600123.scope",
		"lane-pi-other-1698600456.scope",
		"be-dev-server-close-42-1698600789.scope",
		"lane-pi-x-no-extra.scope",
	],
};

test("a live launcher scope lifts a heartbeaten-expired card from gone to idle/alive-via-systemd (S4)", () => {
	const fx = fixtureHome();
	try {
		// A card whose heartbeat expired three intervals ago would read gone on every other surface.
		writeCard(fx.cards, piCard("pi-x", { updatedAt: NOW - 3 * 60 * MIN }));
		const cards = enumerateLanes({ evidence: SCOPED_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, skipClaude: true });
		const row = cards.find((card) => card.laneId === "pi-x")!;
		assert.deepEqual([row.state, row.alive, row.aliveVia], ["idle", true, "systemd"]);
		assert.equal(row.heartbeatAt, NOW - 3 * 60 * MIN, "the lifted state never invents a newer heartbeat");
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test("without its scope the same expired card still reads gone (S4 lifts only itself)", () => {
	const fx = fixtureHome();
	try {
		writeCard(fx.cards, piCard("pi-x", { updatedAt: NOW - 3 * 60 * MIN }));
		const cards = enumerateLanes({ evidence: NO_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, skipClaude: true });
		const row = cards.find((card) => card.laneId === "pi-x")!;
		assert.deepEqual([row.state, row.alive, row.aliveVia], ["gone", false, "tmux"]);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test("a live scope names only its own lane: pi-x's unit leaves pi-other and pi-x-no alone (S4)", () => {
	const fx = fixtureHome();
	try {
		mkdirSync(join(fx.cards, ".."), { recursive: true });
		writeLaneRecord(join(fx.cards, ".."), { laneId: "pi-x", harness: "pi", cwd: "/w/x", branch: null, launchedAt: NOW - 90 * MIN, launchedBy: "orchestrator", phase: "working", phaseSince: NOW - 90 * MIN });
		writeLaneRecord(join(fx.cards, ".."), { laneId: "pi-other", harness: "pi", cwd: "/w/o", branch: null, launchedAt: NOW - 90 * MIN, launchedBy: "orchestrator", phase: "working", phaseSince: NOW - 90 * MIN });
		writeLaneRecord(join(fx.cards, ".."), { laneId: "pi-x-no", harness: "pi", cwd: "/w/n", branch: null, launchedAt: NOW - 90 * MIN, launchedBy: "orchestrator", phase: "working", phaseSince: NOW - 90 * MIN });
		const lanes = enumerateLanes({ evidence: SCOPED_SYSTEM, home: fx.home, sessionsRoot: fx.sessions, laneCardsDir: fx.cards, poolConfigPath: fx.pool, nowMs: NOW, skipClaude: true });
		const states = Object.fromEntries(lanes.map((card) => [card.laneId, `${card.state}/${card.alive}/${card.aliveVia}`]));
		assert.equal(states["pi-x"], "idle/true/systemd", `pi-x's own scope is live: ${JSON.stringify(states)}`);
		assert.equal(states["pi-other"], "idle/true/systemd", "pi-other's own scope unit is in the listing");
		assert.equal(states["pi-x-no"], "gone/false/none", `another lane's prefix (lane-pi-x-no-extra) is not pi-x-no's scope: ${JSON.stringify(lanes.map((card) => card.laneId))}`);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});
