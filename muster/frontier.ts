/**
 * The frontier (R1, "never idle"): the work that is waiting for the parent.
 *
 * Concord owns tasks, handoffs and their status, so this module only reads
 * them and answers one question: is there something the parent should act on
 * right now? The answer is a hint that enqueues a wake; it grants no authority,
 * and the control record still decides whether a continuation may start
 * (pause, waiting, kill file, decisions and the 20-run breaker all still win).
 *
 * R3 tightens "dispatchable" with dependencies, briefs and file overlap in this
 * same predicate; R1 only needs "a proposed task while a lane is free".
 */

import { createHash } from "node:crypto";

import { nextBestStepCandidates, nextBestStepText, type NextStepCandidate } from "./dispatch.ts";

export type FrontierTask = {
	taskId: string;
	status: string;
	ownerAgentId?: string;
	assignedAgentId?: string;
	/** Addressee of the pending handoff, when the task has one. */
	pendingHandoffTo?: string;
	/** Declared write scope. R3's dispatcher refuses a task whose files are claimed. */
	expectedFiles?: string[];
	/** Structured `key: value` lines the dispatcher and the next-best-step list read. */
	notes?: string;
	riskTags?: string[];
};

/** What one reading of the Concord roster holds: tasks, plus the overlap and question rows `muster_wait` compares. */
export type FrontierRoster = {
	tasks: FrontierTask[];
	/** Each roster overlap row as JSON text, so a new one can be told from a known one. */
	overlaps: string[];
	/** Each open question row as JSON text. */
	questions: string[];
};

export type ActionableWork = {
	/** Handoffs addressed to the parent mailbox, waiting to be accepted. */
	handoffs: string[];
	/** Tasks a worker returned (review ready or handed off). */
	returned: string[];
	/** Tasks a worker reports blocked. */
	blocked: string[];
	/** Proposed tasks that can start now because a lane is free. */
	dispatchable: string[];
	liveLanes: number;
	/**
	 * R3: with lanes free and nothing dispatchable, the next best step is not
	 * chosen here. These are the candidates the parent ranks.
	 */
	nextCandidates?: NextStepCandidate[];
	freeLanes: number;
	actionable: boolean;
	/** Stable identity of this work set; it changes when the set changes. */
	fingerprint: string;
};

/** A lane stays resident, and counts against the ceiling, until its task is accepted or closed. */
const LANE_STATUSES = new Set(["assigned", "active", "blocked", "handoff_offered"]);
const RETURNED_STATUSES = new Set(["review_ready", "handed_off"]);

export function evaluateActionableWork(input: { tasks: readonly FrontierTask[]; mailbox: string; ceiling: number }): ActionableWork {
	const { tasks, mailbox, ceiling } = input;
	const workerOf = (task: FrontierTask): string | undefined => task.assignedAgentId ?? task.ownerAgentId;
	const liveLanes = tasks.filter((task) => {
		const worker = workerOf(task);
		return LANE_STATUSES.has(task.status) && worker !== undefined && worker !== mailbox;
	}).length;
	const freeLanes = Math.max(0, ceiling - liveLanes);
	const ids = (predicate: (task: FrontierTask) => boolean): string[] =>
		tasks.filter(predicate).map((task) => task.taskId).sort();
	const handoffs = ids((task) => task.status === "handoff_offered" && task.pendingHandoffTo === mailbox);
	const returned = ids((task) => RETURNED_STATUSES.has(task.status));
	const blocked = ids((task) => task.status === "blocked");
	const dispatchable = freeLanes > 0 ? ids((task) => task.status === "proposed") : [];
	const fingerprint = createHash("sha256")
		.update(JSON.stringify({ handoffs, returned, blocked, dispatchable, freeLanes }))
		.digest("hex")
		.slice(0, 16);
	// Nothing to dispatch and a free lane: name what the parent could brief next.
	const nextCandidates = freeLanes > 0 && dispatchable.length === 0
		? nextBestStepCandidates({ tasks: tasks.map((task) => ({ ...task, notes: task.notes, riskTags: task.riskTags })) })
		: undefined;
	return {
		handoffs,
		returned,
		blocked,
		dispatchable,
		liveLanes,
		freeLanes,
		...(nextCandidates !== undefined ? { nextCandidates } : {}),
		actionable: handoffs.length + returned.length + blocked.length + dispatchable.length > 0 || (nextCandidates?.length ?? 0) > 0,
		fingerprint,
	};
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** One plain-words line naming what is waiting; it becomes the wake reason. */
export function frontierReason(work: ActionableWork): string {
	const parts: string[] = [];
	if (work.handoffs.length > 0) parts.push(`${plural(work.handoffs.length, "handoff")} addressed to you to accept (${work.handoffs.join(", ")})`);
	if (work.returned.length > 0) parts.push(`${plural(work.returned.length, "returned task")} to integrate (${work.returned.join(", ")})`);
	if (work.blocked.length > 0) parts.push(`${plural(work.blocked.length, "blocked task")} (${work.blocked.join(", ")})`);
	if (work.dispatchable.length > 0) {
		parts.push(`${plural(work.freeLanes, "free lane")} and ${plural(work.dispatchable.length, "task")} ready to dispatch (${work.dispatchable.join(", ")})`);
	}
	if (parts.length === 0 && work.freeLanes > 0) {
		return nextBestStepText(work.nextCandidates ?? []);
	}
	return parts.join("; ");
}

type ConcordCall = (
	name: string,
	args: Record<string, unknown>,
) => Promise<{ structuredContent?: Record<string, unknown> }>;

const MAX_HANDOFF_DETAILS = 25;

function nonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Read the roster, and the addressee of each offered handoff, from Concord.
 * A roster that is not the expected shape yields no tasks rather than a guess.
 */
export async function readFrontierTasks(call: ConcordCall): Promise<FrontierTask[]> {
	return (await readFrontierRoster(call)).tasks;
}

function rowTexts(value: unknown): string[] {
	return Array.isArray(value) ? value.map((row) => (typeof row === "string" ? row : JSON.stringify(row))) : [];
}

export async function readFrontierRoster(call: ConcordCall): Promise<FrontierRoster> {
	const roster = await call("inspect_work", {});
	const overlaps = rowTexts(roster.structuredContent?.["overlaps"]);
	const questions = rowTexts(roster.structuredContent?.["open_questions"]);
	const active = roster.structuredContent?.["active"];
	if (!Array.isArray(active)) return { tasks: [], overlaps, questions };
	const tasks: FrontierTask[] = [];
	let detailReads = 0;
	for (const raw of active) {
		if (raw === null || typeof raw !== "object") continue;
		const row = raw as Record<string, unknown>;
		const taskId = nonEmpty(row["taskId"]);
		const status = nonEmpty(row["status"]);
		if (taskId === undefined || status === undefined) continue;
		const task: FrontierTask = { taskId, status };
		const owner = nonEmpty(row["agentId"]);
		const assigned = nonEmpty(row["assignedAgentId"]);
		if (owner !== undefined) task.ownerAgentId = owner;
		if (assigned !== undefined) task.assignedAgentId = assigned;
		const expectedFiles = Array.isArray(row["expectedFiles"]) ? row["expectedFiles"].filter((file): file is string => typeof file === "string") : undefined;
		if (expectedFiles !== undefined) task.expectedFiles = expectedFiles;
		if (typeof row["notes"] === "string") task.notes = row["notes"];
		if (Array.isArray(row["riskTags"])) task.riskTags = row["riskTags"].filter((tag): tag is string => typeof tag === "string");
		if (status === "handoff_offered" && detailReads < MAX_HANDOFF_DETAILS) {
			detailReads += 1;
			try {
				const detail = await call("inspect_work", { task_id: taskId });
				const pending = detail.structuredContent?.["pending_handoff"] as Record<string, unknown> | null | undefined;
				const to = nonEmpty(pending?.["toAgentId"]) ?? nonEmpty(pending?.["to_agent_id"]);
				if (to !== undefined) task.pendingHandoffTo = to;
			} catch {
				/* an unreadable detail leaves the addressee unknown, which is not the parent's work */
			}
		}
		tasks.push(task);
	}
	return { tasks, overlaps, questions };
}
