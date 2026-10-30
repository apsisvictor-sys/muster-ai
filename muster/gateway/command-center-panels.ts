/**
 * The command center's composer panels (blueprint r5 R5.3, D2, D3, D7): the summary, the goals, the team,
 * what shipped today and what comes next. `command-center.ts` owns the state and its isolation (each panel
 * runs inside `readPanel`); this file owns what a panel is made of. Every builder is a pure function of the
 * rows and readers it is handed, and every reader is the existing owner (the seat store, the inbox, the lane
 * history, the ask queue), so nothing here re-implements one.
 */

import { execFile } from "node:child_process";
import { SITTING_KINDS, askCodeOf, type Ask } from "../asks.ts";
import type { LaneOutcomeRow } from "../lane-outcomes.ts";
import { METER_ROW_SOURCES, type SnapshotProvider, type SnapshotQuota, type SnapshotWindow } from "../bin/usage-snapshot.mts";
import { exhaustedUntil, providerAtHeadroom, resetsAtMs, snapshotIsFresh, type RoutingSnapshot } from "../../routing/provider-pool.ts";
import type { PlanKind, SubscriptionPlan } from "../../routing/subscriptions.ts";
import { listDeliveredMessages, listInboxMessages, type InboxMessage } from "../lib/agent-inbox.ts";
import type { ProjectCatalogue } from "../projects.ts";
import { readSeat, resolveSeatRole, seatHolderLanes, SEAT_ROLES, type SeatContext, type SeatRole } from "../seats.ts";
import type { LaneCard } from "../lib/lane-card.ts";
import type { LaneRow } from "./command-center.ts";
import { LANE_STAGE_SENT_BACK, LANE_STAGE_WAITING_TO_MERGE, LANE_WORKING_STAGES } from "../lane-stage.ts";
import type { LaneHistoryEntry } from "./lane-history.ts";
import { GATEWAY_AGENT_ID } from "./state.ts";
import { ARCHITECT_TO_LINE, EXTERNAL_PREFIX, ID_LINE_PREFIX } from "./tools.ts";

// ─── What the goal registry hands over (D1) ─────────────────────────────────

/**
 * One goal as the registry's `GoalRecord` (D1) stores it. The composer takes it through a dep so the panels do not wait
 * for the registry's merge: the fields are the ones D1 names, and nothing here writes a goal (Henry relays to the architect, S2).
 */
export type GoalSource = {
	code: string;
	name: string;
	sub: string;
	/** A register `projectId`. */
	project: string;
	colour: string;
	stations: Array<{ id: string; name: string; owner?: string; timer?: string; finishedAt?: string }>;
	/** `lane` is a lane id or a seat role; a seat role resolves to its holder at read time. */
	lanes: Array<{ lane: string; station: string }>;
	waitsOn: string[];
	status: "open" | "done" | "dropped";
	closedAt?: string;
	events: Array<{ at: string; by: string; verb: string; detail: string }>;
};

// ─── Panel shapes (R5.3) ────────────────────────────────────────────────────

/**
 * Everything only the operator can clear, counted once each (D32). A messaging authorization ask is answered in
 * Messages, so it is a reply (`drafts`) and never also a decision; the sitting kinds are steps, not decisions.
 */
export type NeedsYou = { total: number; decisions: number; steps: number; drafts: number; pc: number; holdGoals: string[] };
export type DecidedToday = { code: string; question: string };
export type ModelCount = { name: string; count: number };

/** The four R5 numbers the old page reads stay, so the page keeps working until CRW (R7.4 step 2). */
export type SummaryData = {
	running: number;
	readyForReview: number;
	goals: number;
	stuck: number;
	needsYou: NeedsYou;
	decidedToday: DecidedToday[];
	working: { count: number; byModel: ModelCount[] };
	review: { verifying: number; waiting: number; sentBack: number };
	shipped: { today: number; thisHour: number; perHour: number[] };
};

/** The writers whose answer is the operator's own, for `decidedToday` (D32). */
const OPERATOR_WRITERS: readonly string[] = ["operator-shell", "operator-page"];

export type Train = { kind: "work" | "review" | "you" | "sched"; station: string; lane?: string; ask?: string };
export type GoalStationView = { id: string; name: string; done: boolean; now: boolean; owner: string | null; timer: string | null };
export type GoalView = { code: string; name: string; sub: string; colour: string; project: string; stations: GoalStationView[]; trains: Train[]; lanes: string[]; waitsOn: string[] };
export type GoalsPanel = { groups: Array<{ project: string; title: string; goals: GoalView[] }>; sideTrack: string[] };

export type TeamMember = {
	role: SeatRole | "henry";
	held: boolean;
	lane: string | null;
	harness: string | null;
	model: string | null;
	state: string | null;
	line: string | null;
	/** Epoch ms of the line. */
	lineAt: number | null;
	/** Epoch ms the member was last active. */
	lastActiveAt: number | null;
};
export type TeamPanel = { members: TeamMember[] };

export type ShippedItem = { at: string; kind: "merge" | "station" | "goal"; text: string; sha?: string; goal?: string; title?: string | null };
export type ShippedPanel = { items: ShippedItem[] };

export type NextItem = { when: string; kind: "timer" | "station" | "review"; text: string; who: string };
export type NextPanel = { items: NextItem[] };

/** One user timer as systemd says it: the next run in epoch ms, or null when it has none. */
export type TimerInfo = { unit: string; nextMs: number | null };

// ─── Worker lanes and the summary ───────────────────────────────────────────

const STUCK_STATES: readonly string[] = ["stalled", "quota-walled", "blocked"];

/** A lane is ready for review while its last report says so and it is not closed. */
export function reviewReady(row: Pick<LaneRow, "report" | "phase">): boolean {
	return row.report?.kind === "review_ready" && row.phase !== "closed";
}

/** The rows that are worker lanes: no seat holds them and their origin is not the operator. */
export function workerRows(rows: readonly LaneRow[], seatHeld: (laneId: string) => boolean): LaneRow[] {
	return rows.filter((row) => row.origin !== "operator" && !seatHeld(row.laneId));
}

export type SummaryInput = {
	/** The worker lanes: no seat holds them and their origin is not the operator. */
	workers: readonly LaneRow[];
	openGoals: number;
	/** The registry's goals, for the goals an open ask holds. */
	goals: readonly GoalSource[];
	/** The whole ask queue: only `decidedToday` reads beyond the open asks. */
	asks: readonly Ask[];
	/** `waitingOnOperator` of the same queue, applied once by the composer (D32, Q4). */
	openAsks: readonly Pick<Ask, "id">[];
	draftsWaiting: number;
	pendingPc: number;
	/** The lane history, for the merges shipped today. */
	entries: readonly LaneHistoryEntry[];
	now: Date;
};

const WORKING_STAGES: readonly string[] = LANE_WORKING_STAGES;

function countByModel(rows: readonly LaneRow[]): ModelCount[] {
	const counts = new Map<string, number>();
	for (const row of rows) {
		const name = row.modelName ?? "No model recorded";
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** The Sofia clock hour `ms` falls in, as a whole number from 0 to 23. */
function localHourOf(ms: number, timeZone: string): number {
	return zoneParts(ms, timeZone).hour;
}

export function buildSummary(input: SummaryInput): SummaryData {
	const { workers } = input;
	const openAsks = input.openAsks;
	// D32, Q4: each item counts once. A sitting kind is a step; a messaging authorization ask is the reply
	// Messages already counts, so it is never also a decision.
	const steps = openAsks.filter((ask) => SITTING_KINDS.includes((ask as Pick<Ask, "kind">).kind)).length;
	const decisions = openAsks.filter((ask) => {
		const row = ask as Pick<Ask, "kind" | "raisedBy">;
		return !SITTING_KINDS.includes(row.kind) && !(row.raisedBy === "messaging" && row.kind === "authorization");
	}).length;
	const needsYou: NeedsYou = {
		total: decisions + steps + input.draftsWaiting + input.pendingPc,
		decisions,
		steps,
		drafts: input.draftsWaiting,
		pc: input.pendingPc,
		holdGoals: input.goals.filter((goal) => goal.status === "open" && goal.waitsOn.some((id) => openAsks.some((ask) => ask.id === id))).map((goal) => goal.code),
	};

	const midnight = localMidnight(input.now).getTime();
	const decidedToday: DecidedToday[] = [];
	for (const ask of input.tasks) {
		if (ask.status !== "decided" && ask.status !== "done") continue;
		const answeredAt = ask.answeredAt === undefined ? Number.NaN : Date.parse(ask.answeredAt);
		if (!Number.isFinite(answeredAt) || answeredAt < midnight) continue;
		// D31/S8: his own answers and a seat's relay of his words, never a seat answering on its own.
		if (ask.answeredBy === undefined || !OPERATOR_WRITERS.includes(ask.answeredBy)) {
			if (ask.relay === undefined) continue;
		}
		decidedToday.push({ code: askCodeOf(ask), question: ask.question });
	}

	const merged: number[] = [];
	for (const entry of input.entries) {
		if (entry.merge === null || entry.merge.at === undefined) continue;
		const at = Date.parse(entry.merge.at);
		if (Number.isFinite(at) && at >= midnight) merged.push(at);
	}
	const thisHour = localHourOf(input.now.getTime(), PAGE_TIME_ZONE);
	const perHour = new Array<number>(24).fill(0);
	for (const at of merged) {
		const hour = localHourOf(at, PAGE_TIME_ZONE);
		perHour[hour] = (perHour[hour] ?? 0) + 1;
	}

	const workingRows = workers.filter((row) => WORKING_STAGES.includes(row.stage));
	return {
		running: workers.filter((row) => row.state === "running").length,
		readyForReview: workers.filter(reviewReady).length,
		goals: input.openGoals,
		stuck: workers.filter((row) => STUCK_STATES.includes(row.state)).length,
		needsYou,
		decidedToday,
		working: { count: workingRows.length, byModel: countByModel(workingRows) },
		review: {
			verifying: workers.filter((row) => row.stage === "verifying").length,
			waiting: workers.filter((row) => row.stage === LANE_STAGE_WAITING_TO_MERGE).length,
			sentBack: workers.filter((row) => row.stage === LANE_STAGE_SENT_BACK).length,
		},
		shipped: { today: merged.length, thisHour: perHour[thisHour] ?? 0, perHour },
	};
}

// ─── Goals (R5.3, D2) ───────────────────────────────────────────────────────

export type GoalsInput = {
	goals: readonly GoalSource[];
	rows: readonly LaneRow[];
	workers: readonly LaneRow[];
	/** The open asks: a `waitsOn` id that is not among them is dropped. */
	asks: readonly Pick<Ask, "id">[];
	register: ProjectCatalogue | undefined;
	/** The lane a seat role's holder runs in, when it has one. */
	seatLane: (role: SeatRole) => string | undefined;
};

export function buildGoals(input: GoalsInput): GoalsPanel {
	const shown = new Map(input.rows.map((row) => [row.laneId, row]));
	const openAsks = new Set(input.asks.map((candidate) => candidate.id));
	const attachedAnywhere = new Set<string>();
	const resolve = (ref: string): string | undefined => {
		const role = resolveSeatRole(ref);
		return role === undefined ? ref : input.seatLane(role);
	};

	const views: GoalView[] = [];
	for (const goal of input.goals) {
		if (goal.status !== "open") continue;
		const firstOpen = goal.stations.findIndex((station) => station.finishedAt === undefined);
		const current = goal.stations[firstOpen === -1 ? goal.stations.length - 1 : firstOpen];
		const waitsOn = goal.waitsOn.filter((id) => openAsks.has(id));

		const trains: Train[] = [];
		if (waitsOn.length > 0 && current !== undefined) trains.push({ kind: "you", station: current.id, ask: waitsOn[0]! });
		const lanes: string[] = [];
		for (const attachment of goal.lanes) {
			const laneId = resolve(attachment.lane);
			if (laneId === undefined) continue;
			attachedAnywhere.add(laneId);
			const row = shown.get(laneId);
			if (row === undefined) continue;
			if (!lanes.includes(laneId)) lanes.push(laneId);
			if (row.phase === "closed") continue;
			trains.push({ kind: reviewReady(row) ? "review" : "work", station: attachment.station, lane: laneId });
		}
		if (trains.length === 0 && current !== undefined) trains.push({ kind: "sched", station: current.id });

		views.push({
			code: goal.code,
			name: goal.name,
			sub: goal.sub,
			colour: goal.colour,
			project: goal.project,
			stations: goal.stations.map((station, index) => ({
				id: station.id,
				name: station.name,
				done: station.finishedAt !== undefined,
				now: index === firstOpen || trains.some((train) => train.station === station.id),
				owner: station.owner ?? null,
				timer: station.timer ?? null,
			})),
			trains,
			lanes,
			waitsOn,
		});
	}

	// Groups follow the register's order, then any project the register does not know; the title is the register's.
	const registered = input.register?.projects ?? [];
	const order = new Map(registered.map((project, index) => [project.projectId, index]));
	const titleOf = (projectId: string): string => {
		const project = registered.find((candidate) => candidate.projectId === projectId);
		return project === undefined ? projectId : (project.title ?? project.name);
	};
	const byProject = new Map<string, GoalView[]>();
	for (const view of views) byProject.set(view.project, [...(byProject.get(view.project) ?? []), view]);
	const groups = [...byProject.entries()]
		.map(([project, goals]) => ({ project, title: titleOf(project), goals }))
		.sort((a, b) => (order.get(a.project) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.project) ?? Number.MAX_SAFE_INTEGER));

	// The side track: worker lanes on no goal. A closed lane is finished work unless its scope is still running.
	const sideTrack = input.workers.filter((row) => !attachedAnywhere.has(row.laneId) && (row.phase !== "closed" || row.leftover)).map((row) => row.laneId);
	return { groups, sideTrack };
}

// ─── Team (R5.3) ────────────────────────────────────────────────────────────

/** The header lines the gateway puts above Henry's words; they are removed with the owner's own constants, never a copy of their text. */
function withoutHeaders(text: string): string {
	let rest = text.startsWith(EXTERNAL_PREFIX) ? text.slice(EXTERNAL_PREFIX.length) : text.startsWith(EXTERNAL_PREFIX.trimEnd()) ? text.slice(EXTERNAL_PREFIX.trimEnd().length) : text;
	for (;;) {
		const trimmed = rest.replace(/^\s*\n/, "").replace(/^[ \t]+/, "");
		const newline = trimmed.indexOf("\n");
		const first = newline === -1 ? trimmed : trimmed.slice(0, newline);
		if (first !== ARCHITECT_TO_LINE && !first.startsWith(ID_LINE_PREFIX)) return trimmed.trim();
		rest = newline === -1 ? "" : trimmed.slice(newline + 1);
	}
}

const HENRY_LINE_CHARS = 300;
const HENRY_DELIVERED_SCAN = 20;
const HENRY_INBOXES = ["architect", "orchestrator"] as const;

/** Henry's messages to the architect and the orchestrator, pending and read, through the inbox owner. */
export function readHenryMessages(stateDir: string): InboxMessage[] {
	const found: InboxMessage[] = [];
	for (const agent of HENRY_INBOXES) {
		for (const message of [...listDeliveredMessages(stateDir, agent, HENRY_DELIVERED_SCAN), ...listInboxMessages(stateDir, agent)]) {
			if (message.from === GATEWAY_AGENT_ID) found.push(message);
		}
	}
	return found;
}

function henryLine(messages: readonly InboxMessage[]): { line: string; at: number } | undefined {
	const newest = [...messages].sort((a, b) => b.at.localeCompare(a.at)).find((message) => Number.isFinite(Date.parse(message.at)));
	if (newest === undefined) return undefined;
	const first = withoutHeaders(newest.text).split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
	return { line: first.length > HENRY_LINE_CHARS ? `${first.slice(0, HENRY_LINE_CHARS)}…` : first, at: Date.parse(newest.at) };
}

/** The newest time of an audit line written for Henry's bearer (`role: "chat"`). Lines are parsed raw: masked text is never parsed. */
export function henryLastActive(rawLines: readonly string[]): number | null {
	let newest: number | null = null;
	for (const line of rawLines) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof parsed !== "object" || parsed === null) continue;
		const record = parsed as { role?: unknown; at?: unknown };
		if (record.role !== "chat" || typeof record.at !== "string") continue;
		const at = Date.parse(record.at);
		if (Number.isFinite(at) && (newest === null || at > newest)) newest = at;
	}
	return newest;
}

export type TeamInput = {
	cards: readonly LaneCard[];
	seatContext: SeatContext;
	henryMessages: readonly InboxMessage[];
	/** Raw audit lines, or undefined when the gateway has no audit reader. */
	auditLines: readonly string[] | undefined;
};

export function buildTeam(input: TeamInput): TeamPanel {
	const seatLanes = seatHolderLanes(input.seatContext);
	const members: TeamMember[] = [];
	for (const role of [...SEAT_ROLES].sort()) {
		const holder = readSeat(role, input.seatContext).holder;
		if (holder === null) {
			members.push({ role, held: false, lane: null, harness: null, model: null, state: null, line: null, lineAt: null, lastActiveAt: null });
			continue;
		}
		const laneId = seatLanes.find((entry) => entry.role === role)?.laneId ?? null;
		const card = laneId === null ? undefined : input.cards.find((candidate) => candidate.laneId === laneId);
		const line = card?.lastMessage ?? null;
		const activeAt = card?.lastActivityMs ?? null;
		members.push({ role, held: true, lane: laneId, harness: card?.harness ?? holder.harness, model: card?.model ?? null, state: card?.state ?? null, line, lineAt: line === null ? null : activeAt, lastActiveAt: activeAt });
	}
	const said = henryLine(input.henryMessages);
	members.push({ role: "henry", held: true, lane: null, harness: "Grok Bot", model: null, state: "idle", line: said?.line ?? null, lineAt: said?.at ?? null, lastActiveAt: input.auditLines === undefined ? null : henryLastActive(input.auditLines) });
	return { members };
}

// ─── Time (Europe/Sofia) ────────────────────────────────────────────────────

export const PAGE_TIME_ZONE = "Europe/Sofia";

type ZoneParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };
const formatters = new Map<string, Intl.DateTimeFormat>();

function zoneParts(ms: number, timeZone: string): ZoneParts {
	let formatter = formatters.get(timeZone);
	if (formatter === undefined) {
		formatter = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
		formatters.set(timeZone, formatter);
	}
	const part = (type: string): number => Number(formatter!.formatToParts(new Date(ms)).find((entry) => entry.type === type)?.value);
	return { year: part("year"), month: part("month"), day: part("day"), hour: part("hour"), minute: part("minute"), second: part("second") };
}

/** The zone's offset from UTC at an instant, in ms: its wall clock read as UTC, minus the instant. */
function zoneOffsetMs(ms: number, timeZone: string): number {
	const p = zoneParts(ms, timeZone);
	return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant of the zone's midnight that starts the day `now` falls in, from the time zone database. The offset at `now` can differ
 * from the offset at midnight (the day summer time ends), so the guess is corrected once at the instant it names.
 */
export function localMidnight(now: Date, timeZone: string = PAGE_TIME_ZONE): Date {
	const p = zoneParts(now.getTime(), timeZone);
	const wall = Date.UTC(p.year, p.month - 1, p.day);
	const guess = wall - zoneOffsetMs(now.getTime(), timeZone);
	return new Date(wall - zoneOffsetMs(guess, timeZone));
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** D3: "12:00" today, "Sun 20:00" within the next six days, else "3 Nov 20:00". */
export function whenText(atMs: number, now: Date, timeZone: string = PAGE_TIME_ZONE): string {
	const at = zoneParts(atMs, timeZone);
	const today = zoneParts(now.getTime(), timeZone);
	const clock = `${String(at.hour).padStart(2, "0")}:${String(at.minute).padStart(2, "0")}`;
	const days = Math.round((Date.UTC(at.year, at.month - 1, at.day) - Date.UTC(today.year, today.month - 1, today.day)) / 86_400_000);
	if (days === 0) return clock;
	if (days >= 1 && days <= 6) return `${WEEKDAYS[new Date(Date.UTC(at.year, at.month - 1, at.day)).getUTCDay()]} ${clock}`;
	return `${at.day} ${MONTHS[at.month - 1]} ${clock}`;
}

// ─── Shipped today (R5.3) ───────────────────────────────────────────────────

const SHIPPED_MAX_ITEMS = 50;

export function buildShipped(input: { entries: readonly LaneHistoryEntry[]; goals: readonly GoalSource[]; now: Date }): ShippedPanel {
	const since = localMidnight(input.now).getTime();
	const items: ShippedItem[] = [];
	for (const entry of input.entries) {
		const merged = entry.merge?.at === undefined ? Number.NaN : Date.parse(entry.merge.at);
		if (entry.merge === null || !Number.isFinite(merged) || merged < since) continue;
		const owner = input.goals.find((goal) => goal.lanes.some((attachment) => attachment.lane === entry.lane));
		const said = entry.outcome?.summary.split("\n").find((line) => line.trim() !== "")?.trim();
		items.push({ at: new Date(merged).toISOString(), kind: "merge", text: said !== undefined && said !== "" ? said : entry.merge.subject, sha: entry.merge.sha.slice(0, 7), title: entry.title ?? null, ...(owner !== undefined ? { goal: owner.code } : {}) });
	}
	// Station finishes and goal closes are read from the goal's own stored times, so they do not depend on how an event describes them.
	for (const goal of input.goals) {
		for (const station of goal.stations) {
			const finished = station.finishedAt === undefined ? Number.NaN : Date.parse(station.finishedAt);
			if (Number.isFinite(finished) && finished >= since) items.push({ at: new Date(finished).toISOString(), kind: "station", text: `${station.name} · ${goal.name}`, goal: goal.code });
		}
		const closed = goal.closedAt === undefined ? Number.NaN : Date.parse(goal.closedAt);
		if (goal.status === "done" && Number.isFinite(closed) && closed >= since) items.push({ at: new Date(closed).toISOString(), kind: "goal", text: `${goal.name} done`, goal: goal.code });
	}
	items.sort((a, b) => b.at.localeCompare(a.at));
	return { items: items.slice(0, SHIPPED_MAX_ITEMS) };
}

// ─── Next (D3) ──────────────────────────────────────────────────────────────

const TIMER_UNIT = /^[A-Za-z0-9@._:][A-Za-z0-9@._:-]*\.timer$/;

/** The timer units the open goals' unfinished stations name, each once. */
export function timerUnitsOf(groups: GoalsPanel["groups"]): string[] {
	const units = new Set<string>();
	for (const group of groups) for (const goal of group.goals) for (const station of goal.stations) if (!station.done && station.timer !== null) units.add(station.timer);
	return [...units].sort();
}

export function buildNext(input: { groups: GoalsPanel["groups"]; workers: readonly LaneRow[]; timers: readonly TimerInfo[]; now: Date }): NextPanel {
	const nextOf = new Map(input.timers.map((timer) => [timer.unit, timer.nextMs]));
	type Ranked = { rank: number; item: NextItem };
	const timed: Ranked[] = [];
	const soon: Ranked[] = [];
	const unscheduled: Ranked[] = [];
	const listed = new Set<string>();

	// 1. A station timer: its unit's next run, or the plain "not scheduled" line.
	for (const group of input.groups) {
		for (const goal of group.goals) {
			for (const station of goal.stations) {
				if (station.done || station.timer === null) continue;
				listed.add(`${goal.code}/${station.id}`);
				const nextMs = nextOf.get(station.timer) ?? null;
				if (nextMs === null) unscheduled.push({ rank: 0, item: { when: "not scheduled", kind: "timer", text: station.name, who: `timer ${station.timer}` } });
				else timed.push({ rank: nextMs, item: { when: whenText(nextMs, input.now), kind: "timer", text: station.name, who: "starts on its own" } });
			}
		}
	}
	// 2. Each open goal's next station: the first unfinished one nothing is working on, unless a timer already lists it.
	for (const group of input.groups) {
		for (const goal of group.goals) {
			const next = goal.stations.find((station) => !station.done && !goal.trains.some((train) => train.kind !== "sched" && train.station === station.id));
			if (next === undefined || listed.has(`${goal.code}/${next.id}`)) continue;
			soon.push({ rank: 0, item: { when: "soon", kind: "station", text: `${next.name} · ${goal.name}`, who: next.owner ?? "unassigned" } });
		}
	}
	// 3. A worker lane parked at review_ready.
	for (const row of input.workers) {
		if (reviewReady(row)) soon.push({ rank: 0, item: { when: "soon", kind: "review", text: `${row.laneId} review`, who: "waits for review" } });
	}
	timed.sort((a, b) => a.rank - b.rank);
	return { items: [...soon, ...timed, ...unscheduled].map((entry) => entry.item) };
}

// ─── systemd timers ─────────────────────────────────────────────────────────

export type TimerRun = (file: string, args: readonly string[]) => Promise<{ ok: boolean; stdout: string; detail?: string }>;

const TIMERS_TIMEOUT_MS = 10_000;

const execTimers: TimerRun = (file, args) =>
	new Promise((resolveRun) => {
		execFile(file, [...args], { timeout: TIMERS_TIMEOUT_MS, encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
			resolveRun({ ok: error === null, stdout: stdout.trim(), detail: (error === null ? stdout : `${stderr}${stdout}`).trim().split("\n").slice(-1)[0] ?? "" });
		});
	});

/**
 * `systemctl --user list-timers --all --output=json <units>` for exactly the units goals name (D3). systemd 255 prints `next`
 * in microseconds since the epoch; 0 or absent means the unit has no next run. With no unit named nothing is run. A unit name
 * that is not a plain timer unit never reaches the argument list.
 */
export function systemTimersReader(run: TimerRun = execTimers): (units: readonly string[]) => Promise<TimerInfo[]> {
	return async (units) => {
		if (units.length === 0) return [];
		for (const unit of units) if (!TIMER_UNIT.test(unit)) throw new Error(`${JSON.stringify(unit)} is not a timer unit name`);
		const result = await run("systemctl", ["--user", "list-timers", "--all", "--output=json", ...units]);
		if (!result.ok) throw new Error(`systemctl list-timers failed: ${result.detail ?? ""}`.trim());
		let parsed: unknown;
		try {
			parsed = JSON.parse(result.stdout);
		} catch {
			throw new Error("systemctl list-timers did not print JSON");
		}
		if (!Array.isArray(parsed)) throw new Error("systemctl list-timers printed an unexpected shape");
		const wanted = new Set(units);
		const timers: TimerInfo[] = [];
		for (const row of parsed as unknown[]) {
			const record = (typeof row === "object" && row !== null ? row : {}) as { unit?: unknown; next?: unknown };
			if (typeof record.unit !== "string" || !wanted.has(record.unit)) continue;
			timers.push({ unit: record.unit, nextMs: typeof record.next === "number" && Number.isFinite(record.next) && record.next > 0 ? Math.floor(record.next / 1000) : null });
		}
		return timers;
	};
}

// ─── Your plans (D41): the snapshot's own rows, plus the router's own facts ─────

/** One window of a plan row, in the router's own unit (epoch ms), converted once (D41). */
export type UsageWindowRow = { name?: string; usedPercent: number; windowMinutes: number; resetsAt: number };

/** What the router does with a provider, from the routing owner's own facts (D41): no threshold is computed here. */
export type UsageRouterRow = { spentUntil?: number; atHeadroom: boolean; runningLanes: number; claudeMax?: number };

/**
 * One plan row (D41, in place of D32's usage row names): the snapshot's own fields, `provider` plus
 * `account` as its key, and `router` from `readRoutingSnapshot`. `billing` stays absent until B-1 lands,
 * and the key exists now so a later billing or freshness field needs no rename.
 */
export type UsageRow = {
	provider: string;
	/** The provider's display name: one map, because nothing in `packages/muster` names providers for people. */
	label: string;
	account?: string;
	kind: PlanKind | "unknown";
	plan: { name: string; monthlyUsd: number | null } | null;
	quotaState: string;
	windows: UsageWindowRow[];
	/** The snapshot's own per-model windows (UB0 UD4); no router fact is drawn from them. */
	modelWindows?: UsageWindowRow[];
	/** The reading's age, as the snapshot states it. */
	ageMs: number | null;
	source: string;
	/**
	 * Whether the reading came from a meter source (`METER_ROW_SOURCES`): the page says "browser" for one and
	 * "API" for any other reading (R7a.1). The owner's list decides it here, and the page keeps no copy of it.
	 */
	meter?: boolean;
	balance?: { amount: number; currency: string };
	walls: Array<{ until: number; source: string }>;
	unreadable?: string;
	billing?: { renewsAt?: number; amountUsd?: number; source: string };
	router: UsageRouterRow;
};

export type UsagePanel = {
	capturedAt: number;
	rows: UsageRow[];
	/**
	 * Whether this snapshot is past the router's own freshness rule (`snapshotIsFresh`, `SNAPSHOT_FRESH_MS`). The
	 * router reads this very file, so past that age `freshRoutingSnapshot` refuses it and the page's line "the
	 * router is not using it" states a fact. Judged here with the owner's function, never in the page (D41).
	 * An older gateway sends no such field, and the page then shows no line.
	 */
	stale?: boolean;
	/** D42: the daily digest's own savings sentence (`plans30d.line`), or null when it is not written yet. */
	valueLine?: string | null;
};

/** Provider ids in words. The one map: the page holds none (D32, R7a.1). */
export const PROVIDER_LABELS: Readonly<Record<string, string>> = {
	"claude-code": "Claude",
	"command-code": "DeepSeek",
	minimax: "MiniMax",
	zai: "GLM",
	xai: "Grok",
};

/** The one provider whose lane ceiling the router states (`PoolRouting.claudeMax`, D41). */
const CLAUDE_PROVIDER = "claude-code";

/** The monitor writes `resetsAt` in epoch seconds; the router's unit is ms. The same conversion `readUsageWindow` makes, once. */
function windowRow(raw: SnapshotWindow, name?: string): UsageWindowRow {
	return { ...(name !== undefined ? { name } : {}), usedPercent: raw.usedPercent, windowMinutes: raw.windowMinutes, resetsAt: resetsAtMs(raw.resetsAt) };
}

/**
 * Every window the reading named (UD4's `quota.windows`, which carries the monthly window too), else the two the
 * row's own shape names (CRH F4). The named list is the reading's own order, so nothing is reordered here.
 */
function quotaWindows(quota: SnapshotQuota | null): UsageWindowRow[] {
	if (quota === null) return [];
	if (quota.windows !== undefined && quota.windows.length > 0) return quota.windows.map((window) => windowRow(window, window.name));
	const windows: UsageWindowRow[] = [];
	if (quota.primary !== null) windows.push(windowRow(quota.primary));
	if (quota.secondary !== null) windows.push(windowRow(quota.secondary));
	return windows;
}

/** The per-model windows the snapshot row carries (UB0 UD4), passed through with the same conversion. */
function modelWindowsOf(row: SnapshotProvider): UsageWindowRow[] | undefined {
	const raw = (row as { modelWindows?: unknown }).modelWindows;
	if (!Array.isArray(raw)) return undefined;
	const windows: UsageWindowRow[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const cell = entry as { model?: unknown; name?: unknown; usedPercent?: unknown; windowMinutes?: unknown; resetsAt?: unknown };
		if (typeof cell.usedPercent !== "number" || !Number.isFinite(cell.usedPercent)) continue;
		if (typeof cell.windowMinutes !== "number" || !Number.isFinite(cell.windowMinutes)) continue;
		if (typeof cell.resetsAt !== "number" || !Number.isFinite(cell.resetsAt)) continue;
		const name = typeof cell.name === "string" && cell.name !== "" ? cell.name : typeof cell.model === "string" && cell.model !== "" ? cell.model : undefined;
		windows.push({ ...(name !== undefined ? { name } : {}), usedPercent: cell.usedPercent, windowMinutes: cell.windowMinutes, resetsAt: resetsAtMs(cell.resetsAt) });
	}
	return windows.length === 0 ? undefined : windows;
}

export type UsageInput = {
	snapshot: { capturedAt: number; providers: readonly SnapshotProvider[] };
	/** The inventory, for each account's `kind` (D41). */
	plans: readonly SubscriptionPlan[];
	/** The router's own read of the same file; undefined leaves the router facts empty rather than guessed. */
	routing: RoutingSnapshot | undefined;
	claudeMax: number | undefined;
	runningLanes: (provider: string) => number;
	/** D42: the digest's own sentence, read by the composer from `cost-digest.json`; null reads as "not computed yet". */
	valueLine?: string | null;
	now: number;
};

/** One row per snapshot row, keyed `provider` plus `account` (D41): a split account gives two rows. */
export function buildUsage(input: UsageInput): UsagePanel {
	const freshRouting = input.routing !== undefined && snapshotIsFresh(input.routing, input.now) ? input.routing : undefined;
	// The one freshness rule, asked about the file the router itself reads (`routingSnapshotPath` is
	// `usageSnapshotPath`): past `SNAPSHOT_FRESH_MS` the router refuses this snapshot, so the page's line is true.
	const stale = !snapshotIsFresh({ capturedAt: input.snapshot.capturedAt, rows: [] }, input.now);
	const rows = input.snapshot.providers.map((row): UsageRow => {
		// `snapshotIsFresh` is the usage owner's own rule (provider-pool.ts): a snapshot the router would ignore at
		// this instant is one whose spent-until or headroom would be shown as a fact the router never acts on.
		const routingRow = freshRouting === undefined ? undefined : freshRouting.rows.find((candidate) => candidate.provider === row.provider);
		const spentUntil = routingRow === undefined ? undefined : exhaustedUntil(routingRow, input.now);
		const windows = quotaWindows(row.quota);
		const modelWindows = modelWindowsOf(row);
		const plan = input.plans.find((candidate) => candidate.provider === row.provider);
		return {
			provider: row.provider,
			label: PROVIDER_LABELS[row.provider] ?? row.provider,
			...(row.account !== undefined ? { account: row.account } : {}),
			kind: plan?.kind ?? "unknown",
			plan: row.plan === null ? null : { name: row.plan.name, monthlyUsd: row.plan.monthlyUsd },
			quotaState: row.quotaState,
			windows,
			...(modelWindows !== undefined ? { modelWindows } : {}),
			ageMs: row.quota === null ? null : row.quota.ageMs,
			source: row.quota === null ? "none" : row.quota.source,
			meter: row.quota !== null && METER_ROW_SOURCES.includes(row.quota.source),
			...(row.balance !== undefined ? { balance: { amount: row.balance.amount, currency: row.balance.currency } } : {}),
			// `SnapshotWall.until` is already ms (`Wall.until`); the router's own reader writes it, not the monitor.
			walls: row.walls.map((wall) => ({ until: wall.until, source: wall.source })),
			...(row.unreadable !== undefined ? { unreadable: row.unreadable } : {}),
			router: {
				...(spentUntil !== undefined ? { spentUntil } : {}),
				atHeadroom: freshRouting === undefined ? false : providerAtHeadroom(freshRouting, row.provider),
				runningLanes: input.runningLanes(row.provider),
				...(row.provider === CLAUDE_PROVIDER && input.claudeMax !== undefined ? { claudeMax: input.claudeMax } : {}),
			},
		};
	});
	return { capturedAt: input.snapshot.capturedAt, rows, stale, valueLine: input.valueLine ?? null };
}

// ─── History from lane-outcomes (D33) ───────────────────────────────────────

export type HistoryRangeName = "today" | "7d" | "30d";
export type HistoryPoint = { at: number; count: number };
export type HistoryModelRow = { name: string; lanes: number; rounds: number; sentBack: number };
export type HistoryGoalRow = { code: string | null; lanes: number };

export type HistoryRange = {
	range: HistoryRangeName;
	/** Per hour for Today (24), per Sofia day for 7 and 30 days. */
	merges: HistoryPoint[];
	lanes: number;
	byModel: HistoryModelRow[];
	byGoal: HistoryGoalRow[];
	medianLaunchToMergeMs: number | null;
};

export type HistoryPanel = { ranges: HistoryRange[]; skipped: number };

const HISTORY_RANGES: ReadonlyArray<{ range: HistoryRangeName; days: number }> = [
	{ range: "today", days: 1 },
	{ range: "7d", days: 7 },
	{ range: "30d", days: 30 },
];

/** The Sofia calendar day of an instant, as `YYYY-MM-DD`. */
export function localDayKey(ms: number, timeZone: string = PAGE_TIME_ZONE): string {
	const p = zoneParts(ms, timeZone);
	return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** The Sofia day keys of the `days` days ending with the day `now` falls in, oldest first. */
function dayKeys(now: Date, days: number, timeZone: string): Array<{ key: string; at: number }> {
	const p = zoneParts(now.getTime(), timeZone);
	const today = Date.UTC(p.year, p.month - 1, p.day);
	const keys: Array<{ key: string; at: number }> = [];
	for (let back = days - 1; back >= 0; back -= 1) {
		const wall = today - back * 86_400_000;
		const date = new Date(wall);
		const key = `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
		keys.push({ key, at: wall });
	}
	return keys;
}

/** The instant a row is counted at: when it closed, else when it launched, else its day. */
function rowInstant(row: LaneOutcomeRow): number | null {
	for (const value of [row.closedAt, row.launchedAt]) {
		if (value === null) continue;
		const at = Date.parse(value);
		if (Number.isFinite(at)) return at;
	}
	const day = Date.parse(`${row.date}T00:00:00Z`);
	return Number.isFinite(day) ? day : null;
}

const median = (values: readonly number[]): number | null => {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
};

/**
 * One range of history (D33): merges per hour or per day, lanes per model with their rounds, lanes per
 * goal and the median launch-to-merge time. Only a `merged` row counts as a merge; `already_done` and
 * `abandoned` rows count as lanes.
 */
export function buildHistory(
	rows: readonly LaneOutcomeRow[],
	now: Date,
	range: HistoryRangeName,
	modelName: (ref: string | null) => string = (ref) => ref ?? "No model recorded",
): HistoryRange {
	const spec = HISTORY_RANGES.find((candidate) => candidate.range === range)!;
	const keys = dayKeys(now, spec.days, PAGE_TIME_ZONE);
	const inRange = new Set(keys.map((entry) => entry.key));
	const perHour = new Map<number, number>(Array.from({ length: 24 }, (_, hour) => [hour, 0]));
	const perDay = new Map<string, number>(keys.map((entry) => [entry.key, 0]));
	const byModel = new Map<string, HistoryModelRow>();
	const byGoal = new Map<string | null, number>();
	const durations: number[] = [];
	let lanes = 0;

	for (const row of rows) {
		const at = rowInstant(row);
		if (at === null) continue;
		const key = localDayKey(at);
		if (!inRange.has(key)) continue;
		lanes += 1;
		const merged = row.outcome === "merged";
		if (merged) {
			if (range === "today") {
				const hour = localHourOf(at, PAGE_TIME_ZONE);
				perHour.set(hour, (perHour.get(hour) ?? 0) + 1);
			} else perDay.set(key, (perDay.get(key) ?? 0) + 1);
			const launched = row.launchedAt === null ? Number.NaN : Date.parse(row.launchedAt);
			const closed = row.closedAt === null ? Number.NaN : Date.parse(row.closedAt);
			if (Number.isFinite(launched) && Number.isFinite(closed) && closed >= launched) durations.push(closed - launched);
		}
		const model = modelName(row.model);
		const aggregate = byModel.get(model) ?? { name: model, lanes: 0, rounds: 0, sentBack: 0 };
		aggregate.lanes += 1;
		aggregate.rounds += row.rounds;
		if (row.rounds > 0) aggregate.sentBack += 1;
		byModel.set(model, aggregate);
		byGoal.set(row.goal, (byGoal.get(row.goal) ?? 0) + 1);
	}

	const merges: HistoryPoint[] =
		range === "today"
			? [...perHour.entries()].sort((a, b) => a[0] - b[0]).map(([hour, count]) => ({ at: hour, count }))
			: keys.map((entry) => ({ at: entry.at, count: perDay.get(entry.key) ?? 0 }));
	return {
		range,
		merges,
		lanes,
		byModel: [...byModel.values()].sort((a, b) => b.lanes - a.lanes || a.name.localeCompare(b.name)),
		byGoal: [...byGoal.entries()].map(([code, count]) => ({ code, lanes: count })).sort((a, b) => b.lanes - a.lanes || (a.code ?? "").localeCompare(b.code ?? "")),
		medianLaunchToMergeMs: median(durations),
	};
}

/** All three ranges, so the range switch needs no request (D33). */
export function buildHistoryPanel(
	rows: readonly LaneOutcomeRow[],
	now: Date,
	skipped: number,
	modelName?: (ref: string | null) => string,
): HistoryPanel {
	return { ranges: HISTORY_RANGES.map((spec) => buildHistory(rows, now, spec.range, modelName)), skipped };
}

/** One contract the doctor checks, as the Services panel shows it: its state and the age of its proof. */
export type ContractRow = {
	id: string;
	/** The kind the doctor's row carries: a timer unit, one of the services, a desk, or C:. */
	kind: string;
	ok: boolean;
	proofAt: string | null;
	proofAgeMs: number | null;
	reason: string | null;
};

/** The Services panel: every contract the doctor checked, and when it checked them. */
export type ContractsPanel = { capturedAt: string | null; rows: ContractRow[]; ok: number; red: number };

/**
 * The Services panel's data, from the doctor's own result file (spec §4, OL6). The doctor is the one owner of
 * the contract rules, so this adds no threshold and no verdict of its own: a row it cannot parse is skipped, and
 * a result it cannot read is an empty panel that the page states as not yet written.
 */
export function buildContracts(result: unknown): ContractsPanel {
	const root = (typeof result === "object" && result !== null ? result : {}) as { ts?: unknown; checks?: { contracts?: { rows?: unknown } } };
	const source = root.checks?.contracts?.rows;
	const rows: ContractRow[] = [];
	if (Array.isArray(source)) {
		for (const entry of source) {
			if (typeof entry !== "object" || entry === null) continue;
			const row = entry as { id?: unknown; kind?: unknown; ok?: unknown; proofAt?: unknown; proofAgeMs?: unknown; reason?: unknown };
			if (typeof row.id !== "string" || row.id === "") continue;
			rows.push({
				id: row.id,
				kind: typeof row.kind === "string" ? row.kind : "",
				ok: row.ok === true,
				proofAt: typeof row.proofAt === "string" ? row.proofAt : null,
				proofAgeMs: typeof row.proofAgeMs === "number" && Number.isFinite(row.proofAgeMs) ? row.proofAgeMs : null,
				reason: typeof row.reason === "string" && row.reason !== "" ? row.reason : null,
			});
		}
	}
	const red = rows.filter((row) => !row.ok).length;
	return { capturedAt: typeof root.ts === "string" ? root.ts : null, rows, ok: rows.length - red, red };
}

// ─── Reuse ──────────────────────────────────────────────────────────────────

/** How long a git, `systemctl` or inbox result is reused (R5.3, "Reuse"). */
export const REUSE_MS = 60_000;

/**
 * Reuses one result per key for `ttlMs`. A result `expired` says is read again at once (a timer whose cached next run has passed).
 * Concurrent reads share one call, and a failure is never kept.
 */
export function reusing<T>(ttlMs: number, now: () => Date, expired?: (value: T, nowMs: number) => boolean): (key: string, read: () => T | Promise<T>) => Promise<T> {
	type Entry = { at: number; promise: Promise<T>; settled: boolean; value?: T };
	const entries = new Map<string, Entry>();
	return (key, read) => {
		const nowMs = now().getTime();
		const held = entries.get(key);
		if (held !== undefined && nowMs - held.at < ttlMs && !(held.settled && expired?.(held.value as T, nowMs) === true)) return held.promise;
		const entry: Entry = { at: nowMs, settled: false, promise: Promise.resolve().then(read) };
		entry.promise.then(
			(value) => {
				entry.settled = true;
				entry.value = value;
			},
			() => {
				if (entries.get(key) === entry) entries.delete(key);
			},
		);
		entries.set(key, entry);
		return entry.promise;
	};
}
