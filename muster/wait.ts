/**
 * Event wait for the parent (R1 item 7, AM2): `muster_wait` returns on the first
 * thing that needs the parent, instead of the parent sleeping in a shell loop.
 *
 * A sleeping parent cannot receive a relay, not even a steer one. This module
 * holds the decision and the loop; `index.ts` supplies the reader (Concord and
 * Herdr, through the existing frontier reader) and registers the tool. It reads
 * and reports. It never starts, prompts or stops anything.
 *
 * Events:
 * - `handoff`: a handoff is offered to the project mailbox. Reported whenever it
 *   is pending, since the parent must accept it.
 * - `idle-worker`: a worker's agent is idle in Herdr while its task is still
 *   `assigned` or `active` with no offer. Reported once per idle episode.
 * - `blocked`, `decision`, `claim-conflict`: a task that became blocked, an open
 *   question, or a claim overlap that was not there when the wait began.
 */

import type { HerdrAgentRow } from "./herdr.ts";
import type { FrontierRoster, FrontierTask } from "./frontier.ts";

export const WAIT_DEFAULT_SECONDS = 120;
export const WAIT_MAX_SECONDS = 600;

export type WaitSnapshot = FrontierRoster & {
	/** Herdr's agents, or undefined when Herdr cannot be read (outside Herdr, or the call failed). */
	agents: HerdrAgentRow[] | undefined;
};

export type WaitEventKind = "handoff" | "idle-worker" | "blocked" | "decision" | "claim-conflict";

export type WaitEvent = { kind: WaitEventKind; taskId?: string; detail: string };

export type WaitOutcome = {
	events: WaitEvent[];
	timedOut: boolean;
	aborted: boolean;
	/** True when the snapshot could not be read for the whole wait: silence is not "nothing is waiting". */
	unreadable: boolean;
	elapsedMs: number;
};

/**
 * Seconds to wait: 2 minutes by default, at least 1 second, at most 10 minutes.
 * `allowNoTimeout` (the inbox waiter, LD18) lets 0 through: it means no timeout.
 */
export function clampWaitSeconds(value: unknown, options: { allowNoTimeout?: boolean } = {}): number {
	const requested = typeof value === "string" ? Number(value) : value;
	if (typeof requested !== "number" || !Number.isFinite(requested)) return WAIT_DEFAULT_SECONDS;
	if (requested === 0 && options.allowNoTimeout === true) return 0;
	return Math.min(WAIT_MAX_SECONDS, Math.max(1, Math.trunc(requested)));
}

const IDLE_AGENT_STATUSES = new Set(["done", "idle"]);
const WORKER_STATUSES = new Set(["assigned", "active"]);

function workerOf(task: FrontierTask): string | undefined {
	return task.assignedAgentId ?? task.ownerAgentId;
}

/** Tasks whose worker's agent is idle in Herdr while the task has no offer, keyed by task id. */
export function idleWorkers(snapshot: WaitSnapshot, mailbox: string): Map<string, string> {
	const idle = new Map<string, string>();
	if (snapshot.agents === undefined) return idle;
	for (const task of snapshot.tasks) {
		const worker = workerOf(task);
		if (!WORKER_STATUSES.has(task.status) || worker === undefined || worker === mailbox) continue;
		const agent = snapshot.agents.find((candidate) => candidate.task !== undefined && candidate.task.toLowerCase() === task.taskId.toLowerCase());
		if (agent !== undefined && IDLE_AGENT_STATUSES.has(agent.status)) idle.set(task.taskId, agent.name);
	}
	return idle;
}

/**
 * The events in `snapshot`. `baseline` is the first reading of this wait: blockers,
 * questions and overlaps count only when they are new against it. `reportedIdle`
 * is shared across waits, so one idle worker ends one wait, not every wait.
 */
export function waitEvents(input: { snapshot: WaitSnapshot; baseline: WaitSnapshot; mailbox: string; reportedIdle: Set<string> }): WaitEvent[] {
	const { snapshot, baseline, mailbox, reportedIdle } = input;
	const events: WaitEvent[] = [];
	for (const task of snapshot.tasks) {
		if (task.status === "handoff_offered" && task.pendingHandoffTo === mailbox) {
			events.push({ kind: "handoff", taskId: task.taskId, detail: `a handoff for ${task.taskId} is offered to you${task.ownerAgentId === undefined ? "" : ` by ${task.ownerAgentId}`}; accept or decline it` });
		}
	}
	const wasBlocked = new Set(baseline.tasks.filter((task) => task.status === "blocked").map((task) => task.taskId));
	for (const task of snapshot.tasks) {
		if (task.status === "blocked" && !wasBlocked.has(task.taskId)) events.push({ kind: "blocked", taskId: task.taskId, detail: `${task.taskId} is now blocked${workerOf(task) === undefined ? "" : ` (worker ${workerOf(task)})`}` });
	}
	const knownQuestions = new Set(baseline.questions);
	for (const question of snapshot.questions) {
		if (!knownQuestions.has(question)) events.push({ kind: "decision", detail: `a new open question or decision update: ${question}` });
	}
	const knownOverlaps = new Set(baseline.overlaps);
	for (const overlap of snapshot.overlaps) {
		if (!knownOverlaps.has(overlap)) events.push({ kind: "claim-conflict", detail: `a new claim overlap: ${overlap}` });
	}
	const idle = idleWorkers(snapshot, mailbox);
	// An agent that is working again has ended its idle episode: report it next time it stops.
	for (const taskId of [...reportedIdle]) if (!idle.has(taskId)) reportedIdle.delete(taskId);
	for (const [taskId, agentName] of idle) {
		if (reportedIdle.has(taskId)) continue;
		reportedIdle.add(taskId);
		events.push({ kind: "idle-worker", taskId, detail: `${agentName} is idle while ${taskId} is still active with no offer: re-prompt it or resolve its blocker` });
	}
	return events;
}

/** Wait until something needs the parent, the timeout passes or the signal aborts. */
export async function runWait(input: {
	read: () => Promise<WaitSnapshot | undefined>;
	mailbox: string;
	timeoutMs: number;
	pollMs: number;
	reportedIdle: Set<string>;
	signal?: AbortSignal;
}): Promise<WaitOutcome> {
	const started = Date.now();
	const elapsed = (): number => Date.now() - started;
	let baseline: WaitSnapshot | undefined;
	let everRead = false;
	for (;;) {
		if (input.signal?.aborted === true) return { events: [], timedOut: false, aborted: true, unreadable: !everRead, elapsedMs: elapsed() };
		const snapshot = await input.read().catch(() => undefined);
		if (snapshot !== undefined) {
			everRead = true;
			baseline ??= snapshot;
			const events = waitEvents({ snapshot, baseline, mailbox: input.mailbox, reportedIdle: input.reportedIdle });
			if (events.length > 0) return { events, timedOut: false, aborted: false, unreadable: false, elapsedMs: elapsed() };
		}
		const remaining = input.timeoutMs - elapsed();
		if (remaining <= 0) return { events: [], timedOut: true, aborted: false, unreadable: !everRead, elapsedMs: elapsed() };
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, Math.min(input.pollMs, remaining));
			input.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
		});
	}
}

/** The text the parent reads. */
export function formatWaitOutcome(outcome: WaitOutcome): string {
	const seconds = Math.round(outcome.elapsedMs / 1000);
	if (outcome.aborted) return "muster_wait: stopped before anything needed you.";
	if (outcome.events.length > 0) {
		return `muster_wait: ${outcome.events.length === 1 ? "something needs you" : `${outcome.events.length} things need you`} (after ${seconds} s):\n${outcome.events.map((event) => `- ${event.kind}: ${event.detail}`).join("\n")}`;
	}
	if (outcome.unreadable) return `muster_wait: Concord could not be read for ${seconds} s, so this is not a sign that nothing is waiting. Check coordination with muster_status.`;
	return `muster_wait: nothing needed you in ${seconds} s. Wait again, or do other work.`;
}
