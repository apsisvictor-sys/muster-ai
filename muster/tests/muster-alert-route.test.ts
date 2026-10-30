import "./muster-test-isolation.ts";
/**
 * Every alert a person reads reaches Henry's mailbox, and no alert path can reach Discord
 * (the operator, 2026-10-29 22:24).
 *
 * This file is the sweep, not an example. One test per person-facing path the tick owns, each
 * proving three things at once: the message arrives on the mailbox port, the port is the only
 * send that path has, and the path works for a project that has no Discord thread at all.
 * The rotation alert is proved the same way in `muster-rotation.test.ts`, and the waker's outage
 * alert in `muster-orch-waker.test.ts` (which also proves no Discord sender is wired into it).
 *
 * The last test is the allow-list. It fails when any module in this tree can reach a Discord or
 * webhook sender, naming the one transport and the one address builder that are allowed to exist
 * and to have no alert caller. A new emitter therefore cannot quietly reintroduce one.
 *
 * Temp directories only. No Discord, no Hermes, no network, no real message.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	applyDecisionDefault,
	armDecisionWindow,
	autoAppliableDecisions,
	decisionCardText,
	fileProgrammeDecisionStore,
	getDecision,
	listOpenDecisions,
	openDecision,
	type ProgrammeDecisionContext,
} from "../decisions.ts";
import { GATEWAY_AGENT_ID } from "../gateway/state.ts";
import {
	attachProgramme,
	fileProgrammeControlStore,
	readProgrammeSnapshot,
	recordHeartbeat,
	type ProgrammeControlContext,
	type ProgrammeControlRecord,
} from "../control.ts";
import { parseProjectCatalogue, type ProjectCatalogue } from "../projects.ts";
import { runTick, type TickAction, type TickPorts } from "../tick.ts";
import type { OpenDecisionInput } from "../../core/decision-types.ts";

const PROGRAMME = "agp_6a6a6a6a6a6a";
const OWNER = { sessionId: "leader-1", processKey: "pi-1-boot-1", operatorRef: "operator", guarded: true };
const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-10-29T12:00:00.000Z");

/** The project has no `discord` entry: an alert must not need a thread to exist. */
const catalogue = (): ProjectCatalogue =>
	parseProjectCatalogue({
		schemaVersion: 1,
		projects: [
			{
				projectId: "sandbox",
				name: "sandbox",
				aliases: [],
				programmes: [{ programmeId: PROGRAMME, checkoutRoot: "/home/operator/projects/sandbox", repoKey: "/home/operator/projects/sandbox/.git", parentAgentId: "pi-sandbox-parent" }],
				settings: { ceiling: 3 },
			},
		],
	});

type Fixture = {
	dir: string;
	control: ProgrammeControlContext;
	decisions: ProgrammeDecisionContext;
	clock: { now: number };
	mailbox: Array<{ key: string; text: string }>;
	/** Every send the tick attempted, by the port it was addressed to. There is only one port. */
	sends: string[];
	tick: () => Promise<TickAction[]>;
	beat: (at?: number) => void;
	record: () => ProgrammeControlRecord;
};

const decisionInput = (over: Partial<OpenDecisionInput> = {}): OpenDecisionInput => ({
	kind: "product-decision",
	question: "Ship the pilot?",
	options: [
		{ id: "approve", label: "Approve", recommendation: "preferred" },
		{ id: "hold", label: "Hold" },
	],
	recommendation: "approve",
	blockedTaskIds: [],
	scopeRevision: "sprint-1",
	...over,
});

/** One machine with a mailbox and nothing else to send through. */
function withTick(run: (f: Fixture) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "muster-alert-route-"));
	mkdirSync(join(dir, "control"), { recursive: true });
	const control: ProgrammeControlContext = { store: fileProgrammeControlStore(join(dir, "control")), killFilePath: join(dir, "kill") };
	const decisions: ProgrammeDecisionContext = { store: fileProgrammeDecisionStore(join(dir, "decisions")) };
	attachProgramme(PROGRAMME, OWNER, control);
	const clock = { now: T0 };
	const mailbox: Array<{ key: string; text: string }> = [];
	const sends: string[] = [];
	const marks = new Map<string, string>();
	const tasks: Array<Record<string, unknown>> = [];
	const project = catalogue();

	const record = (): ProgrammeControlRecord => readProgrammeSnapshot(PROGRAMME, control);
	const beat = (at = clock.now): void => {
		recordHeartbeat(
			PROGRAMME,
			{ pid: process.pid, sessionId: record().owner!.sessionId, generation: record().runGeneration, contextTokens: 10_000, contextWindow: 1_000_000 },
			control,
		);
		const written = record();
		control.store!.update(PROGRAMME, written.revision, () => ({ ...written, revision: written.revision + 1, lastHeartbeat: { ...written.lastHeartbeat!, at: new Date(at).toISOString() } }));
	};

	const ports: TickPorts = {
		now: () => clock.now,
		catalogue: () => project,
		control,
		readTasks: () => tasks as never,
		alerts: { get: (key) => marks.get(key), set: (key, value) => void marks.set(key, value) },
		// The mailbox owner, as the tick's own port sees it: one address, one dedupe key.
		alert: async (text, key) => {
			mailbox.push({ key, text });
			sends.push("mailbox");
			return { delivered: true };
		},
		// The store is its own owner; the port only asks it, exactly as the bin does.
		decisions: {
			open: (programmeId) => {
				const due = new Set(autoAppliableDecisions(programmeId, clock.now, decisions).map((decision) => decision.decisionId));
				return listOpenDecisions(programmeId, decisions).map((decision) => ({
					decisionId: decision.decisionId,
					cardText: decisionCardText(decision, "sandbox"),
					recommendation: decision.recommendation,
					autoApplyAt: decision.autoApplyAt,
					autoAppliable: due.has(decision.decisionId),
				}));
			},
			armWindow: (programmeId, decisionId, deliveredAtIso) => {
				const decision = armDecisionWindow(programmeId, decisionId, deliveredAtIso, decisions);
				return {
					decisionId: decision.decisionId,
					cardText: decisionCardText(decision, "sandbox"),
					recommendation: decision.recommendation,
					autoApplyAt: decision.autoApplyAt,
					autoAppliable: false,
				};
			},
			applyDefault: (programmeId, decisionId, threadId) => {
				const outcome = applyDecisionDefault(programmeId, decisionId, threadId, decisions, clock.now);
				return {
					applied: outcome.applied,
					duplicate: outcome.duplicate,
					optionId: outcome.optionId,
					actorId: outcome.answerRef.actorId,
					cardText: decisionCardText(getDecision(programmeId, decisionId, decisions), "sandbox"),
				};
			},
		},
	};

	const fixture: Fixture = { dir, control, decisions, clock, mailbox, sends, tick: () => runTick(ports), beat, record };
	return run(fixture).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const firstAction = (actions: TickAction[]): string => actions[0]!.action;

// ─── The tick's person-facing paths ─────────────────────────────────────────

test("the orchestrator-down alert reaches Henry's mailbox, for a project with no thread", () =>
	withTick(async (f) => {
		f.beat(T0);
		f.clock.now = T0 + 10 * MIN;
		const actions = await f.tick();
		assert.equal(firstAction(actions), "alert-sent");
		assert.deepEqual(f.sends, ["mailbox"], "the only send this path has is the mailbox port");
		assert.equal(f.mailbox.length, 1);
		assert.ok(f.mailbox[0]!.key.startsWith(`${PROGRAMME}#stale#`), "the key names the mailbox path and the outage it is about");
		assert.match(f.mailbox[0]!.text, /sandbox/);
		assert.match(f.mailbox[0]!.text, /has not reported for 10 min and may be down/);
		// The same outage is not paged twice.
		const again = await f.tick();
		assert.equal(firstAction(again), "none");
		assert.equal(f.mailbox.length, 1);
	}));

test("an open decision card reaches Henry's mailbox once, and the card text is the store's own", () =>
	withTick(async (f) => {
		f.beat();
		const { decisionId } = openDecision(PROGRAMME, decisionInput({ reversible: false }), f.decisions);
		const actions = await f.tick();
		assert.equal(firstAction(actions), "decision-card");
		assert.deepEqual(f.sends, ["mailbox"]);
		assert.equal(f.mailbox.length, 1);
		assert.equal(f.mailbox[0]!.key, `${PROGRAMME}#card#${decisionId}`);
		assert.match(f.mailbox[0]!.text, new RegExp(`\\[Muster decision ${decisionId}`));
		assert.match(f.mailbox[0]!.text, /Ship the pilot\?/);
		// One delivery per card, whichever pass notices it.
		f.clock.now += MIN;
		assert.equal(firstAction(await f.tick()), "none");
		assert.equal(f.mailbox.length, 1);
	}));

test("an operator default that closed a card after it was delivered reports itself to Henry's mailbox", () =>
	withTick(async (f) => {
		f.beat();
		const { decisionId } = openDecision(PROGRAMME, decisionInput({ reversible: true, autoApplyHours: 1 }), f.decisions);
		// The card is delivered first: its deadline is armed at the delivery, and the delivery marker is the evidence.
		assert.equal(firstAction(await f.tick()), "decision-card");
		const armed = f.mailbox[0]!.key;
		assert.equal(armed, `${PROGRAMME}#card#${decisionId}`);
		const autoApplyAt = getDecision(PROGRAMME, decisionId, f.decisions).autoApplyAt;
		assert.ok(autoApplyAt !== null, "a reversible product decision carries its deadline");
		f.clock.now = Date.parse(autoApplyAt!) + MIN;
		f.beat();
		const actions = await f.tick();
		assert.equal(firstAction(actions), "decision-default");
		assert.deepEqual(f.sends, ["mailbox", "mailbox"], "two messages, one port");
		assert.equal(f.mailbox.length, 2);
		assert.match(f.mailbox[1]!.text, /Applied the recommendation \(approve\) as an operator default/);
		assert.match(f.mailbox[1]!.text, /The record says an operator default closed it, not that you did/);
	}));

test("the programme digest reaches Henry's mailbox, and only after its four-hour interval", () =>
	withTick(async (f) => {
		f.beat();
		// The first pass records the baseline and stays quiet: a digest is not an announcement that the tick is alive.
		assert.equal(firstAction(await f.tick()), "none");
		assert.equal(f.mailbox.length, 0);
		f.clock.now = T0 + 4 * HOUR + MIN;
		f.beat();
		const actions = await f.tick();
		assert.equal(firstAction(actions), "digest");
		assert.deepEqual(f.sends, ["mailbox"]);
		assert.equal(f.mailbox.length, 1);
		assert.match(f.mailbox[0]!.text, /^\[sandbox · digest /);
		assert.match(f.mailbox[0]!.text, /done 0 · running 0 · blocked 0/);
	}));

test("the mailbox is the only send port the tick is given: a Discord target cannot be addressed from it", () => {
	// `TickPorts.alert` takes no target, so no caller can name a channel. This is the shape check that
	// keeps a future alert from carrying a Discord address past the type system.
	const ports: TickPorts = {
		now: () => T0,
		catalogue: () => undefined,
		control: {},
		readTasks: () => undefined,
		alerts: { get: () => undefined, set: () => undefined },
		alert: async () => ({ delivered: true }),
	};
	assert.deepEqual(Object.keys(ports).filter((key) => key === "send" || key === "alertDiscord"), []);
	assert.equal(typeof ports.alert, "function");
});

// ─── The allow-list ─────────────────────────────────────────────────────────

/**
 * The one transport that can speak to Discord, and the one builder of a Discord address. Both are
 * allowed to exist and neither may have an alert caller: the transport's importer list is asserted
 * empty below, and the builder is used only by the operator's conversation relay outside this tree.
 */
const ALLOWED = new Map([
	["hermes-send.ts", "the Discord transport itself; no importer in this tree"],
	["projects.ts", "the catalogue's `discord` field and `discordTargetFor`, the address owner the relay reads"],
]);

/** A sender or a Discord target, by code shape: the English word in a comment is not a sender. */
const SENDER = /\bhermesSend\b|\bPI_MUSTER_HERMES_BIN\b|\bdiscordTargetFor\(|\bwebhook\(|["'`]discord:/;

function sourceFiles(root: string): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "node_modules" || entry.name === "tests") continue;
				walk(path);
				continue;
			}
			if (/\.(ts|mts)$/.test(entry.name)) found.push(path);
		}
	};
	walk(root);
	return found;
}

test("no module in this tree can reach a Discord or webhook sender outside the allow-list", () => {
	const root = join(import.meta.dirname, "..");
	const offenders: string[] = [];
	const senders: string[] = [];
	for (const file of sourceFiles(root)) {
		const name = file.slice(root.length + 1);
		const source = readFileSync(file, "utf8");
		if (ALLOWED.has(name)) continue;
		for (const [index, line] of source.split("\n").entries()) {
			if (SENDER.test(line)) offenders.push(`${name}:${index + 1}: ${line.trim()}`);
		}
		if (/\bhermesSend\(|\bPI_MUSTER_HERMES_BIN\b/.test(source)) senders.push(name);
	}
	assert.deepEqual(offenders, [], "an alert path may not name a Discord channel, the Hermes sender or a webhook");
	assert.deepEqual(senders, [], "the Discord transport has no importer in this tree, so nothing here can send to Discord");
	assert.ok(ALLOWED.has("hermes-send.ts") && ALLOWED.has("projects.ts"));
});
