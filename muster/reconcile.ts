/**
 * Muster reconciler — outstanding task inspection and deduplicated
 * handoff/completion events (plan §5.9).
 *
 * While the parent holds supervised task references, inspect those task IDs in
 * code every five seconds and immediately after reconnect or relevant message
 * hints. At most one pass per connection in flight. Ordinary `updated_at`
 * changes never wake the parent. Reconciliation must discover an offered
 * result even when the worker's notification was omitted or failed, including
 * while the parent was offline.
 */

import type { RepoBinding } from "./types.ts";

export type TaskObservation = {
	taskId: string;
	status: string;
	version: number;
	updatedAt?: string;
	ownerAgentId?: string;
	assignedAgentId?: string;
	pendingHandoffId?: number;
	pendingHandoffFrom?: string;
	latestHandoffId?: number;
};

export type ReconcileEvent = {
	/** eventKind: handoff-offered | complete | closed | review-ready | blocked-task */
	eventKind: string;
	taskId: string;
	version: number;
	pendingHandoffId?: number;
	content: string;
};

export type ReconcilerDeps = {
	/** Live client accessor for the binding (undefined = connection unavailable). */
	concordFor: (repoKey: string) =>
		| {
				callTool: (
					name: string,
					args: Record<string, unknown>,
					o?: unknown,
				) => Promise<{ structuredContent?: Record<string, unknown> }>;
		  }
		| undefined;
	/** Supervised task references per binding (references only, no cached truth). */
	supervisedTaskIds: (binding: RepoBinding) => string[];
	/** Durable dedupe: a key already pending/recorded in the journal is skipped. */
	alreadyKnown: (deliveryKey: string) => boolean;
	/** Emit a detected event into the wake pump + journal pipeline. */
	onEvent: (binding: RepoBinding, event: ReconcileEvent) => void;
	/**
	 * Last-good lifecycle observation for every inspected task (Agile admission
	 * reads status/version/owner from the lifecycle owner, never from its own
	 * store). Called for every good observation, not only for state changes.
	 */
	onObservation?: (binding: RepoBinding, observation: TaskObservation) => void;
	/** Default 5000ms between passes; pass immediately on reconnect/hints. */
	intervalMs?: number;
};

const DEFAULT_INTERVAL_MS = 5000;

/**
 * The handoff sender travels on the event object for content construction
 * without widening the exported ReconcileEvent contract.
 */
type ReconcileEventWithSender = ReconcileEvent & { pendingHandoffFrom?: string };

type EventCandidate = {
	eventKind: string;
	pendingHandoffId?: number;
};

/**
 * One reconciler per binding. Duplicates are suppressed with
 * (repoKey, taskId, version, pendingHandoffId, eventKind). A closed parent is
 * not a running scheduler: reopening restores supervised references and
 * reconciles current durable state.
 */
export class Reconciler {
	/** Bindings observed through pass(); the timer reconciles these. */
	private readonly bindings = new Map<string, RepoBinding>();
	/** At most one pass per connection (repoKey) may be in flight. */
	private readonly inFlight = new Map<string, Promise<ReconcileEvent[]>>();
	/** Last good observation per (repoKey, taskId) — drives new-handoff detection. */
	private readonly observations = new Map<string, TaskObservation>();
	private readonly intervalMs: number;
	private timer?: ReturnType<typeof setInterval>;

	constructor(private readonly deps: ReconcilerDeps) {
		const configured = deps.intervalMs;
		this.intervalMs =
			typeof configured === "number" && Number.isFinite(configured) && configured > 0
				? configured
				: DEFAULT_INTERVAL_MS;
	}

	start(): void {
		if (this.timer !== undefined) return;
		const tick = (): void => {
			void this.tick();
		};
		this.timer = setInterval(tick, this.intervalMs);
		this.timer.unref?.();
		// Reconnect/restart path: reconcile immediately instead of waiting a full
		// interval. There is nothing to inspect until pass() has seen a binding.
		tick();
	}

	async stop(): Promise<void> {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		await Promise.allSettled([...this.inFlight.values()]);
		this.inFlight.clear();
	}

	/** Run one inspection pass immediately (reconnect/message hint trigger). */
	async pass(binding: RepoBinding): Promise<ReconcileEvent[]> {
		if (binding === undefined || binding === null || typeof binding.repoKey !== "string") {
			return [];
		}
		this.bindings.set(binding.repoKey, binding);
		if (this.inFlight.has(binding.repoKey)) return [];
		const run = this.runPass(binding);
		this.inFlight.set(binding.repoKey, run);
		try {
			return await run;
		} finally {
			if (this.inFlight.get(binding.repoKey) === run) this.inFlight.delete(binding.repoKey);
		}
	}

	private async tick(): Promise<void> {
		for (const binding of this.bindings.values()) {
			let ids: string[] = [];
			try {
				ids = this.deps.supervisedTaskIds(binding) ?? [];
			} catch {
				ids = [];
			}
			if (ids.length === 0) continue;
			// pass() itself refuses a second concurrent pass for this connection.
			void this.pass(binding).catch(() => undefined);
		}
	}

	private async runPass(binding: RepoBinding): Promise<ReconcileEvent[]> {
		const concord = this.deps.concordFor(binding.repoKey);
		if (concord === undefined) return [];
		let taskIds: string[] = [];
		try {
			taskIds = this.deps.supervisedTaskIds(binding) ?? [];
		} catch {
			return [];
		}
		const events: ReconcileEvent[] = [];
		for (const taskId of taskIds) {
			if (typeof taskId !== "string" || taskId.length === 0) continue;
			let structured: Record<string, unknown> | undefined;
			try {
				const result = await concord.callTool("inspect_work", { task_id: taskId });
				structured = result?.structuredContent;
			} catch {
				// Connection/inspection failure degrades for this pass; the next pass retries.
				continue;
			}
			const observation = observeTask(structured);
			if (observation === null) continue;
			try {
				this.deps.onObservation?.(binding, observation);
			} catch {
				/* Admission evidence is best-effort; reconciliation must not stop. */
			}
			const memoKey = `${binding.repoKey}\u0000${observation.taskId}`;
			const previous = this.observations.get(memoKey);
			// Keep the last good observation even when nothing fires; a malformed
			// response never erases it.
			this.observations.set(memoKey, observation);
			for (const candidate of candidatesFor(observation, previous)) {
				const deliveryKey = taskEventDeliveryKey({
					taskId: observation.taskId,
					version: observation.version,
					pendingHandoffId: candidate.pendingHandoffId,
					eventKind: candidate.eventKind,
				});
				let known = false;
				try {
					known = this.deps.alreadyKnown(deliveryKey);
				} catch {
					known = false;
				}
				if (known) continue;
				const event = {
					eventKind: candidate.eventKind,
					taskId: observation.taskId,
					version: observation.version,
					pendingHandoffId: candidate.pendingHandoffId,
					content: "",
				} as ReconcileEventWithSender;
				if (observation.pendingHandoffFrom !== undefined) {
					event.pendingHandoffFrom = observation.pendingHandoffFrom;
				}
				event.content = reconcileEventContent(event);
				try {
					this.deps.onEvent(binding, event);
				} catch {
					// Leave the key unrecorded so the next pass can retry it.
				}
				events.push(event);
			}
		}
		return events;
	}
}

/** Build the human/mode content for a detected event. */
export function reconcileEventContent(event: ReconcileEvent): string {
	const sender = (event as ReconcileEventWithSender).pendingHandoffFrom;
	const base = `task ${event.taskId} v${event.version}`;
	switch (event.eventKind) {
		case "handoff-offered": {
			const handoff = event.pendingHandoffId === undefined ? "handoff" : `handoff ${event.pendingHandoffId}`;
			const from = sender === undefined ? "" : ` from ${sender}`;
			return `${base}: ${handoff} offered${from} — inspect the task and accept or return it through Concord.`;
		}
		case "complete":
			return `${base}: complete — verify the result before integrating.`;
		case "closed":
			return `${base}: closed.`;
		case "review-ready":
			return `${base}: review ready — inspect the task evidence.`;
		case "blocked-task":
			return `${base}: blocked — an actionable blocker needs attention.`;
		default:
			return `${base}: ${event.eventKind}.`;
	}
}

/**
 * Map one inspect_work task-scope result into observations; returns null for
 * malformed data (callers degrade rather than act on it).
 */
export function observeTask(structured: Record<string, unknown> | undefined): TaskObservation | null {
	if (structured === undefined || structured === null || typeof structured !== "object") return null;
	const scope = structured.scope;
	if (scope !== undefined && scope !== "task") return null;
	const rawTask = structured.task;
	if (rawTask === undefined || rawTask === null || typeof rawTask !== "object" || Array.isArray(rawTask)) {
		return null;
	}
	const task = rawTask as Record<string, unknown>;
	// Nested repo rows are camelCase (Concord passes internal rows directly);
	// only top-level tool output is snake_case.
	const taskId = task.taskId;
	if (typeof taskId !== "string" || taskId.length === 0) return null;
	const status = task.status;
	if (typeof status !== "string" || status.length === 0) return null;
	const version = task.version;
	if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;

	const observation: TaskObservation = { taskId, status, version };
	if (typeof task.updatedAt === "string" && task.updatedAt.length > 0) {
		observation.updatedAt = task.updatedAt;
	}
	if (typeof task.agentId === "string" && task.agentId.length > 0) {
		observation.ownerAgentId = task.agentId;
	}
	if (typeof task.assignedAgentId === "string" && task.assignedAgentId.length > 0) {
		observation.assignedAgentId = task.assignedAgentId;
	}

	const pending = structured.pending_handoff;
	if (pending !== undefined && pending !== null) {
		if (typeof pending !== "object" || Array.isArray(pending)) return null;
		const handoff = pending as Record<string, unknown>;
		const handoffId = handoff.id;
		if (typeof handoffId !== "number" || !Number.isInteger(handoffId)) return null;
		observation.pendingHandoffId = handoffId;
		if (typeof handoff.fromAgentId === "string" && handoff.fromAgentId.length > 0) {
			observation.pendingHandoffFrom = handoff.fromAgentId;
		}
	}

	const latest = structured.latest_handoff;
	if (latest !== undefined && latest !== null && typeof latest === "object" && !Array.isArray(latest)) {
		const latestId = (latest as Record<string, unknown>).id;
		if (typeof latestId === "number" && Number.isInteger(latestId)) {
			observation.latestHandoffId = latestId;
		}
	}
	return observation;
}

/** Candidate events for one observation; ordinary version churn yields none. */
function candidatesFor(observation: TaskObservation, previous: TaskObservation | undefined): EventCandidate[] {
	const candidates: EventCandidate[] = [];
	const handoffId = observation.pendingHandoffId;
	// A pending handoff is "new" only when the previous good observation did not
	// already carry the same pending handoff id.
	if (handoffId !== undefined && previous?.pendingHandoffId !== handoffId) {
		candidates.push({ eventKind: "handoff-offered", pendingHandoffId: handoffId });
	}
	switch (observation.status) {
		case "complete":
			candidates.push({ eventKind: "complete" });
			break;
		case "closed":
			candidates.push({ eventKind: "closed" });
			break;
		case "review_ready":
			candidates.push({ eventKind: "review-ready" });
			break;
		case "blocked":
			candidates.push({ eventKind: "blocked-task" });
			break;
		default:
			break;
	}
	return candidates;
}

/**
 * Delivery key for a task event — mirrors `taskEventDeliveryKey` in inbox.ts.
 * Leaf modules import only types.ts, so the canonical string form is repeated
 * here; both sides must stay the (repoKey, taskId, version, pendingHandoffId,
 * eventKind) tuple from plan §5.9.
 */
function taskEventDeliveryKey(parts: {
	taskId: string;
	version: number;
	pendingHandoffId?: number;
	eventKind: string;
}): string {
	const handoff = parts.pendingHandoffId === undefined ? "-" : String(parts.pendingHandoffId);
	return `task-event/${parts.taskId}/${parts.version}/${handoff}/${parts.eventKind}`;
}
