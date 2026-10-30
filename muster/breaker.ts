/**
 * Muster no-progress loop breaker (plan §5.8).
 *
 * Group by (repoKey, taskId) when a message/event belongs to a task; otherwise
 * by the original Concord message-thread root (resolved from the structured
 * thread, never the newest reply id); taskless senders that keep starting new
 * roots additionally share a sender→recipient pair counter. Message ids, new
 * roots, updated_at, prose progress claims and routine version churn are NOT
 * progress. The breaker counts one no-progress run per included group at
 * settled run end and pauses that group at the threshold; unrelated groups
 * keep waking. Pause state persists through the session journal and explicit
 * /muster resume is the deterministic recovery (never self-issued by agents).
 */

import type { BreakerGroupState, BreakerState, GroupKey } from "./types.ts";

export type RunGroupInput = {
	/** When the message/event belongs to a task: the causal task group. */
	taskId?: string;
	repoKey: string;
	/** Thread root resolved from the structured thread for taskless groups. */
	threadRootMessageId?: string;
	/** Sender→recipient pair for taskless chatters that keep starting roots. */
	senderAgentId?: string;
	recipientAgentId?: string;
};

export type ProgressObservation =
	| {
			kind: "file-fingerprint";
			group: GroupKey;
			/** Fingerprint of the new substantive content (hash of scoped file states). */
			fingerprint: string;
			paths: string[];
	  }
	| {
			kind: "ownership-transition";
			group: GroupKey;
			/** e.g. offer→accepted, assign→accepted, terminal result with evidence. */
			transition: string;
			taskId: string;
	  };

export type BreakerDeps = {
	/** Durable counters/pause state live in the session journal. */
	persist: (state: BreakerState) => Promise<void>;
	restore: () => Promise<BreakerState | undefined>;
	/** Default 20 consecutive no-progress runs (programme-policy configurable). */
	threshold?: number;
};

const DEFAULT_THRESHOLD = 20;
/** Seen-fingerprint memory per group (FIFO, plan §5.8 "toggling" protection). */
const FINGERPRINT_CAP = 200;

function nonEmptyText(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function validThreshold(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function validCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Deterministic recovery: only the explicit /muster resume command resets a
 * group's counter/pause. Herdr can inject user-shaped input, so role:user
 * records are never treated as a human un-pause. The skill forbids agents
 * from issuing the resume to clear their own breaker.
 */
export class NoProgressBreaker {
	private groups: Record<string, BreakerGroupState> = {};
	private threshold: number;
	/** Groups included in the run currently being settled (thread + pair). */
	private currentRun = new Set<GroupKey>();
	/** Groups with genuine (new-fingerprint or ownership) progress since last settle. */
	private progressMarked = new Set<GroupKey>();
	/** thread group → its taskless sender/recipient pair group, learned at groupKey(). */
	private readonly threadPairs = new Map<GroupKey, GroupKey>();
	/** Serialized durable writes: noteProgress is sync, endRun/resume await. */
	private persistTail: Promise<void> = Promise.resolve();

	constructor(private readonly deps: BreakerDeps) {
		this.threshold = validThreshold(deps.threshold) ?? DEFAULT_THRESHOLD;
	}

	/** Deterministic group key for a message/event. */
	groupKey(input: RunGroupInput): GroupKey {
		const repoKey = typeof input?.repoKey === "string" ? input.repoKey : "";
		const taskId = nonEmptyText(input?.taskId);
		if (taskId !== undefined) return `task:${repoKey}:${taskId}`;
		const root = nonEmptyText(input?.threadRootMessageId);
		const sender = nonEmptyText(input?.senderAgentId);
		const recipient = nonEmptyText(input?.recipientAgentId);
		if (root !== undefined) {
			const threadKey = `thread:${repoKey}:${root}`;
			// Bookkeeping only: new roots between the same two agents must not reset
			// the shared pair counter. The pair is counted alongside the thread.
			if (sender !== undefined && recipient !== undefined) {
				this.threadPairs.set(threadKey, `pair:${repoKey}:${sender}->${recipient}`);
			}
			return threadKey;
		}
		if (sender !== undefined && recipient !== undefined) return `pair:${repoKey}:${sender}->${recipient}`;
		if (sender !== undefined) return `pair:${repoKey}:${sender}->*`;
		// Degenerate input (no task, root, or sender): one bucket per repository so
		// callers still have a stable gating key.
		return `thread:${repoKey}:`;
	}

	/**
	 * Record the groups that caused a successful Muster-triggered run start.
	 * The same group may appear from multiple messages; it is counted once.
	 * Taskless thread groups are expanded to the registered sender/recipient
	 * pair group for this run.
	 */
	beginRun(groups: GroupKey[]): void {
		if (!Array.isArray(groups)) return;
		for (const group of groups) {
			if (typeof group !== "string" || group.length === 0) continue;
			this.currentRun.add(group);
			const pair = this.threadPairs.get(group);
			if (pair !== undefined) this.currentRun.add(pair);
		}
	}

	/**
	 * At settled run end: one no-progress run for each included group with no
	 * new observed progress. Retried delivery and replay of the same run/event
	 * never count twice. Returns the groups that tripped to a paused state
	 * (empty when none) so the caller can raise attention.
	 */
	async endRun(): Promise<{ tripped: GroupKey[] }> {
		const groups = [...this.currentRun];
		this.currentRun.clear();
		if (groups.length === 0) return { tripped: [] };
		const tripped: GroupKey[] = [];
		const pausedAt = new Date().toISOString();
		for (const group of groups) {
			const state = this.groupStateFor(group);
			// A paused group stays paused (the same pair pause also gates its thread
			// groups, so a new root cannot keep counting after the pair tripped).
			if (this.isPaused(group)) continue;
			if (this.progressMarked.delete(group)) {
				state.consecutiveNoProgressRuns = 0;
				continue;
			}
			state.consecutiveNoProgressRuns += 1;
			if (state.consecutiveNoProgressRuns >= this.threshold) {
				// Durable pause before the caller can start the next run.
				state.pausedAt = pausedAt;
				state.pauseReason = `muster: ${state.consecutiveNoProgressRuns} Muster-triggered runs without observed progress`;
				tripped.push(group);
			}
		}
		await this.enqueuePersist();
		return { tripped };
	}

	/** Observe substantive progress for a group (files or ownership evidence). */
	noteProgress(observation: ProgressObservation): void {
		if (observation === null || observation === undefined || typeof observation !== "object") return;
		const group = nonEmptyText(observation.group);
		if (group === undefined) return;
		let substantive = false;
		if (observation.kind === "file-fingerprint") {
			const fingerprint = nonEmptyText(observation.fingerprint);
			if (fingerprint === undefined) return;
			const state = this.groupStateFor(group);
			const seen = (state.seenFingerprints ??= []);
			if (!seen.includes(fingerprint)) {
				seen.push(fingerprint);
				if (seen.length > FINGERPRINT_CAP) seen.splice(0, seen.length - FINGERPRINT_CAP);
				substantive = true;
			}
		} else if (observation.kind === "ownership-transition") {
			substantive = true;
		} else {
			return;
		}
		if (!substantive) return;
		this.markProgress(group);
		void this.enqueuePersist().catch(() => undefined);
	}

	/** Compare a candidate fingerprint against the group's seen set (no reset on toggling). */
	fingerprintIsNew(group: GroupKey, fingerprint: string): boolean {
		const key = nonEmptyText(group);
		const candidate = nonEmptyText(fingerprint);
		if (key === undefined || candidate === undefined) return false;
		const seen = this.groups[key]?.seenFingerprints;
		return seen === undefined ? true : !seen.includes(candidate);
	}

	isPaused(group: GroupKey): boolean {
		if (this.groups[group]?.pausedAt !== undefined) return true;
		// Taskless thread groups are gated by their shared pair counter as well, so a
		// paused pair stops new roots between the same two agents.
		const pair = this.threadPairs.get(group);
		return pair !== undefined && this.groups[pair]?.pausedAt !== undefined;
	}

	pausedGroups(): GroupKey[] {
		return Object.keys(this.groups).filter((group) => this.groups[group].pausedAt !== undefined);
	}

	/** Operator pause via /muster pause (never self-issued by agents). */
	async pause(group: GroupKey, reason: string): Promise<void> {
		const state = this.groupStateFor(group);
		if (state.pausedAt !== undefined) return; // already paused
		state.pausedAt = new Date().toISOString();
		state.pauseReason = nonEmptyText(reason) ?? "operator pause";
		await this.enqueuePersist();
	}

	/** Explicit /muster resume — resets the counter and clears the pause. */
	async resume(group: GroupKey): Promise<void> {
		// Resuming a taskless thread also clears its registered pair: the pair is the
		// conversation counter that gated that thread in the first place.
		const pair = this.threadPairs.get(group);
		const targets: GroupKey[] = pair !== undefined && pair !== group ? [group, pair] : [group];
		for (const target of targets) {
			const state = this.groups[target];
			if (state !== undefined) {
				state.consecutiveNoProgressRuns = 0;
				delete state.pausedAt;
				delete state.pauseReason;
			}
			this.progressMarked.delete(target);
		}
		await this.enqueuePersist();
	}

	/** Restore persisted state on session resume. */
	async restore(): Promise<void> {
		const restored = await this.deps.restore();
		if (restored === null || restored === undefined || typeof restored !== "object") return;
		if (restored.schemaVersion !== 1 || restored.groups === null || typeof restored.groups !== "object") return;
		const groups: Record<string, BreakerGroupState> = {};
		for (const [key, raw] of Object.entries(restored.groups)) {
			if (raw === null || raw === undefined || typeof raw !== "object") continue;
			const value = raw as Partial<BreakerGroupState>;
			const count = validCount(value.consecutiveNoProgressRuns) ?? 0;
			const state: BreakerGroupState = { consecutiveNoProgressRuns: count };
			const pausedAt = nonEmptyText(value.pausedAt);
			if (pausedAt !== undefined) state.pausedAt = pausedAt;
			const pauseReason = nonEmptyText(value.pauseReason);
			if (pauseReason !== undefined) state.pauseReason = pauseReason;
			if (Array.isArray(value.seenFingerprints)) {
				const seen = value.seenFingerprints.filter(
					(entry): entry is string => typeof entry === "string" && entry.length > 0,
				);
				if (seen.length > 0) state.seenFingerprints = seen.slice(-FINGERPRINT_CAP);
			}
			groups[key] = state;
		}
		this.groups = groups;
		// Programme policy (constructor config) wins; otherwise adopt the stored value.
		if (validThreshold(this.deps.threshold) === undefined) {
			this.threshold = validThreshold(restored.threshold) ?? DEFAULT_THRESHOLD;
		}
		this.currentRun.clear();
		this.progressMarked.clear();
	}

	/** Snapshot for status/metadata display. */
	state(): BreakerState {
		const groups: Record<string, BreakerGroupState> = {};
		for (const [key, value] of Object.entries(this.groups)) {
			const snapshot: BreakerGroupState = {
				consecutiveNoProgressRuns: value.consecutiveNoProgressRuns,
			};
			if (value.pausedAt !== undefined) snapshot.pausedAt = value.pausedAt;
			if (value.pauseReason !== undefined) snapshot.pauseReason = value.pauseReason;
			if (value.seenFingerprints !== undefined) snapshot.seenFingerprints = [...value.seenFingerprints];
			groups[key] = snapshot;
		}
		return { schemaVersion: 1, threshold: this.threshold, groups };
	}

	private groupStateFor(group: GroupKey): BreakerGroupState {
		const existing = this.groups[group];
		if (existing !== undefined) return existing;
		const created: BreakerGroupState = { consecutiveNoProgressRuns: 0 };
		this.groups[group] = created;
		return created;
	}

	/**
	 * Mark genuine progress for a group (and its registered taskless pair).
	 * A paused group is never cleared here: only explicit resume recovers it.
	 */
	private markProgress(group: GroupKey): void {
		const targets: GroupKey[] = [group];
		const pair = this.threadPairs.get(group);
		if (pair !== undefined && pair !== group) targets.push(pair);
		for (const target of targets) {
			this.progressMarked.add(target);
			const state = this.groupStateFor(target);
			if (state.pausedAt === undefined) state.consecutiveNoProgressRuns = 0;
		}
	}

	/** Snapshot and write through a serialized chain so writes never race. */
	private enqueuePersist(): Promise<void> {
		const snapshot: BreakerState = {
			schemaVersion: 1,
			threshold: this.threshold,
			groups: {},
		};
		for (const [key, value] of Object.entries(this.groups)) {
			const copy: BreakerGroupState = { consecutiveNoProgressRuns: value.consecutiveNoProgressRuns };
			if (value.pausedAt !== undefined) copy.pausedAt = value.pausedAt;
			if (value.pauseReason !== undefined) copy.pauseReason = value.pauseReason;
			if (value.seenFingerprints !== undefined) copy.seenFingerprints = [...value.seenFingerprints];
			snapshot.groups[key] = copy;
		}
		const run = this.persistTail.then(
			() => this.deps.persist(snapshot),
			() => this.deps.persist(snapshot),
		);
		this.persistTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}
}

/** Thread-root resolution helper: walk a structured thread to its root id. */
export function threadRootId(thread: Array<{ messageId?: unknown; replyToMessageId?: unknown }>): string | undefined {
	if (!Array.isArray(thread) || thread.length === 0) return undefined;
	const rows = thread.filter(
		(row): row is { messageId?: unknown; replyToMessageId?: unknown } =>
			row !== null && row !== undefined && typeof row === "object",
	);
	if (rows.length === 0) return undefined;
	const idOf = (row: { messageId?: unknown }): string | undefined =>
		typeof row.messageId === "string" && row.messageId.length > 0 ? row.messageId : undefined;
	// Primary rule: the row with no reply parent is the root (array order does not
	// matter, and this can never be a reply).
	for (const row of rows) {
		if (row.replyToMessageId === null || row.replyToMessageId === undefined) {
			const id = idOf(row);
			if (id !== undefined) return id;
		}
	}
	// Fallback for a partial thread: walk parent links upward to the oldest row
	// present. Never return the newest reply just because it sorts first.
	const byId = new Map<string, { messageId?: unknown; replyToMessageId?: unknown }>();
	for (const row of rows) {
		const id = idOf(row);
		if (id !== undefined && !byId.has(id)) byId.set(id, row);
	}
	const start = rows.find((row) => idOf(row) !== undefined);
	if (start === undefined) return undefined;
	const visited = new Set<string>();
	let current = start;
	for (;;) {
		const id = idOf(current);
		if (id === undefined || visited.has(id)) break;
		visited.add(id);
		const parent = typeof current.replyToMessageId === "string" ? current.replyToMessageId : undefined;
		if (parent === undefined || parent.length === 0) return id;
		const next = byId.get(parent);
		if (next === undefined) return id;
		current = next;
	}
	return idOf(start);
}
