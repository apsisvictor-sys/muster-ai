/**
 * Muster edit guard — canonical paths, fresh overlap checks, retry
 * acknowledgements and safe auto-claim (plan §5.5).
 *
 * The advisory file guard intercepts built-in edit/write tool calls. The
 * promise is "no known active claim", never "free": unregistered agents and
 * check/write races remain outside the guarantee. Direct path-based mutation
 * tools and recognizable shell/run_code writes also enter the parent's scope
 * admission; dynamic commands that conceal their filesystem effects cannot be
 * proven safe by this path.
 */

import { readFileSync, realpathSync } from "node:fs";
import path, { posix } from "node:path";
import type { RepoBinding } from "./types.ts";
import { pathMatchesGlob } from "./projects.ts";

// ─── Path resolution ─────────────────────────────────────────────────────────

export type ToolTarget = {
	/** Absolute resolved target (nearest existing ancestor + suffix for new files). */
	absolute: string;
	/** True when the file does not exist yet (resolved through existing ancestors). */
	isNewFile: boolean;
};

/**
 * Concord CLI path semantics (domain/overlap.js), replicated so the guard
 * compares exactly what `concord check` compares: trim, drop one leading `./`,
 * posix-normalize, strip a trailing slash. Paths stay case-sensitive; `""` is
 * the no-file-identity result.
 */
function normalizePath(value: string): string {
	const trimmed = value.trim().replace(/^\.\//, "");
	const normalized = posix.normalize(trimmed).replace(/\/$/, "");
	return normalized === "." ? "" : normalized;
}

function tryRealpath(candidate: string): string | undefined {
	try {
		return realpathSync(candidate);
	} catch {
		return undefined;
	}
}

/**
 * Resolve the exact tool target using its effective cwd. For a new file,
 * resolve its nearest existing ancestor and append the missing suffix. Existing
 * symlink aliases resolve through realpath (one canonical identity per file).
 */
export function resolveToolTarget(rawPath: string, effectiveCwd: string): ToolTarget {
	const cwd =
		typeof effectiveCwd === "string" && effectiveCwd.trim() !== "" ? effectiveCwd : process.cwd();
	const raw = typeof rawPath === "string" ? rawPath : "";
	// `path.resolve` folds `..` lexically, so traversal is contained only by the
	// real location it names — never by the base the caller stated.
	const resolved = path.resolve(cwd, raw);
	const canonical = tryRealpath(resolved);
	if (canonical !== undefined) {
		return { absolute: canonical, isNewFile: false };
	}
	// New file: canonicalize the nearest existing ancestor, then append the
	// missing suffix (a symlinked ancestor resolves to its real directory).
	let ancestor = path.dirname(resolved);
	const missing = [path.basename(resolved)];
	for (;;) {
		const ancestorReal = tryRealpath(ancestor);
		if (ancestorReal !== undefined) {
			missing.reverse();
			return { absolute: path.join(ancestorReal, ...missing), isNewFile: true };
		}
		const parent = path.dirname(ancestor);
		if (parent === ancestor) break;
		missing.push(path.basename(ancestor));
		ancestor = parent;
	}
	return { absolute: resolved, isNewFile: true };
}

export type RouteResult = {
	binding: RepoBinding;
	/** Repository-relative POSIX path; identical across linked worktrees. */
	relativePosix: string;
	repoKey: string;
};

/**
 * Match a resolved absolute target to a joined checkout. Different linked
 * worktrees of one repository must yield the same logical file key. An
 * outside/unbound target is outside coverage (allow, no "checked" claim).
 * Prevent traversal from routing into an unintended binding; cross-repository
 * symlinks route to the actual bound target or are an explicit limitation.
 */
export function routeToBinding(
	target: ToolTarget,
	bindings: RepoBinding[],
): RouteResult | null {
	const absolute = target?.absolute;
	if (typeof absolute !== "string" || absolute === "") return null;
	// Longest matching checkout root wins: `/repo` must not shadow
	// `/repo/worktree-linked` for a target inside the linked checkout.
	let bestRoot: string | undefined;
	let bestBinding: RepoBinding | undefined;
	for (const binding of bindings ?? []) {
		if (binding === null || typeof binding !== "object") continue;
		for (const root of binding.checkoutRoots ?? []) {
			if (typeof root !== "string" || root === "") continue;
			const resolvedRoot = path.resolve(root);
			const canonical = tryRealpath(resolvedRoot) ?? resolvedRoot;
			if (absolute !== canonical && !absolute.startsWith(canonical + path.sep)) continue;
			if (bestRoot === undefined || canonical.length > bestRoot.length) {
				bestRoot = canonical;
				bestBinding = binding;
			}
		}
	}
	if (bestRoot === undefined || bestBinding === undefined) return null;
	const relative = absolute.slice(bestRoot.length).replace(/^[\\/]+/, "");
	return {
		binding: bestBinding,
		// Strip the matching checkout root — never the primary root — so linked
		// worktrees of one repository share one logical path key.
		relativePosix: normalizePath(relative.split(path.sep).join("/")),
		repoKey: bestBinding.repoKey,
	};
}

// ─── Conflict procedure ──────────────────────────────────────────────────────

export type ClaimConflict = {
	taskId: string;
	title?: string;
	ownerAgentId?: string;
	assignedAgentId?: string;
	status: string;
	/** Exact normalized shared paths. */
	sharedPaths: string[];
};

export type PreflightOutcome =
	| { action: "allow"; autoClaimed?: boolean; notice?: string }
	| { action: "block"; reason: string; conflicts: ClaimConflict[]; repoKey: string }
	| { action: "allow-degraded"; reason: string };

export type EditGuardDeps = {
	/** Joined bindings at call time (fresh, never cached). */
	bindings: () => RepoBinding[];
	/** Live Concord client for a repoKey (undefined when unconnected). */
	concordFor: (repoKey: string) =>
		| {
				callTool: (
					name: string,
					args: Record<string, unknown>,
					o?: unknown,
				) => Promise<{ structuredContent?: Record<string, unknown> }>;
		  }
		| undefined;
	/** Total preflight budget including queue wait and all reads (default 2000ms). */
	budgetMs?: number;
	/** Called when this session successfully writes a file (breaker progress). */
	onFileWritten?: (repoKey: string, relativePath: string) => void;
	/**
	 * Operator-retired agent identities for a repository (R1 item 5). A claim
	 * held only by retired identities does not block. Read fresh on every
	 * preflight; the records behind it are never deleted.
	 */
	retiredAgents?: (repoKey: string) => ReadonlySet<string>;
	/**
	 * The supervising parent identities of a repository's project (AM2 item 8).
	 * A task held only by a parent is an umbrella claim: it does not block a
	 * worker inside that worker's own expected files. Two workers still block.
	 */
	parentAgents?: (repoKey: string) => ReadonlySet<string>;
	/**
	 * This session's parent write scope for a repository (R2 item 3). Present
	 * only when it owns an enrolled programme; `globs` are the catalogue's
	 * parent-writable globs and `maxLines` the per-file, per-task limit for
	 * everything else. Read fresh on every preflight.
	 */
	parentWriteScope?: (repoKey: string) => {
		globs: readonly string[];
		maxLines: number;
		readChargedLines?: (taskId: string, path: string) => number;
		recordChargedLines?: (taskId: string, path: string, changedLines: number, maxLines: number) => void;
	} | undefined;
};

/** Changed lines a parent may write into one file on one task, outside its globs. */
export const DEFAULT_PARENT_LINES_PER_FILE = 20;

/** Concord task statuses that count as a live claim (CLI check semantics). */
const CLAIMED_STATUSES = new Set(["assigned", "active", "blocked", "handoff_offered"]);
const DEFAULT_BUDGET_MS = 2000;
const ACK_WINDOW_MS = 10 * 60 * 1000;
const BUDGET_NOTICE = "muster: guard budget exceeded — claim check skipped";
const SAME_FILE_PREFIX = "same file(s):";

type ConcordCall = { structuredContent?: Record<string, unknown> };
type ConcordLike = {
	callTool: (
		name: string,
		args: Record<string, unknown>,
		options?: unknown,
	) => Promise<ConcordCall>;
};

type RosterRow = {
	taskId: string;
	status: string;
	agentId?: string;
	assignedAgentId?: string;
};

type RosterRead =
	| { kind: "ok"; rows: RosterRow[] }
	| { kind: "malformed"; detail: string }
	| { kind: "failed"; detail: string };

type TaskRead =
	| { kind: "ok"; task: Record<string, unknown>; expectedFiles: string[] }
	| { kind: "malformed"; detail: string }
	| { kind: "failed"; detail: string };

type Raced<T> = { ok: true; value: T } | { ok: false; error?: unknown };

type MergeOutcome =
	| { kind: "skipped" }
	| { kind: "unchanged" }
	| { kind: "claimed" }
	| { kind: "block"; conflicts: ClaimConflict[] }
	| { kind: "degraded"; key: string; reason: string }
	| { kind: "expired" };

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((entry): entry is string => typeof entry === "string");
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message;
	return typeof error === "string" ? error : "unknown error";
}

/**
 * Changed lines a single write brings into a file: the text it writes, or the
 * replacement text of an edit. A write whose size cannot be read is not
 * counted, so the guard never blocks on a guess.
 */
function fileLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

/** Myers edit distance: insertions plus deletions, bounded by the remaining budget. */
function changedLineCount(before: string, after: string, limit: number): number {
	const a = fileLines(before);
	const b = fileLines(after);
	const cap = Math.max(0, Math.min(limit, a.length + b.length));
	const furthest = new Map<number, number>([[1, 0]]);
	for (let distance = 0; distance <= cap; distance += 1) {
		for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
			let x: number;
			if (diagonal === -distance || (diagonal !== distance && (furthest.get(diagonal - 1) ?? -1) < (furthest.get(diagonal + 1) ?? -1))) {
				x = furthest.get(diagonal + 1) ?? 0;
			} else {
				x = (furthest.get(diagonal - 1) ?? 0) + 1;
			}
			let y = x - diagonal;
			while (x < a.length && y < b.length && a[x] === b[y]) { x += 1; y += 1; }
			furthest.set(diagonal, x);
			if (x >= a.length && y >= b.length) return distance;
		}
	}
	return cap + 1;
}

function intendedFileContent(input: { path: string; [key: string]: unknown }, current: string): string | undefined {
	const apply = (entry: Record<string, unknown>, content: string): string | undefined => {
		const oldText = entry["oldText"] ?? entry["old_text"] ?? entry["old_string"];
		const newText = entry["newText"] ?? entry["new_text"] ?? entry["new_string"];
		if (typeof newText !== "string") return undefined;
		if (typeof oldText !== "string") return newText;
		if (oldText === "") return newText + content;
		const start = content.indexOf(oldText);
		if (start < 0 || content.indexOf(oldText, start + oldText.length) >= 0) return undefined;
		return content.slice(0, start) + newText + content.slice(start + oldText.length);
	};
	if (typeof input["content"] === "string") return input["content"];
	if (Array.isArray(input["edits"]) && input["edits"].length > 0) {
		let content = current;
		for (const edit of input["edits"]) {
			if (edit === null || typeof edit !== "object") return undefined;
			const next = apply(edit as Record<string, unknown>, content);
			if (next === undefined) return undefined;
			content = next;
		}
		return content;
	}
	return apply(input, current);
}

/** Concord's ownership identity: agent_id first, then the owner field. */
function ownerAgentOf(
	task: Record<string, unknown>,
	fallback?: { agentId?: string; assignedAgentId?: string },
): string | undefined {
	return (
		asString(task.agentId) ??
		asString(task.owner) ??
		fallback?.agentId ??
		fallback?.assignedAgentId
	);
}

/** Parse `same file(s): a, b` reasons from a merge-time overlap result. */
function sharedFilesFromReasons(reasons: string[]): string[] {
	const shared = new Set<string>();
	for (const reason of reasons) {
		const marker = reason.indexOf(SAME_FILE_PREFIX);
		if (marker < 0) continue;
		for (const part of reason.slice(marker + SAME_FILE_PREFIX.length).split(",")) {
			const normalized = normalizePath(part);
			if (normalized !== "") shared.add(normalized);
		}
	}
	return [...shared];
}

/**
 * The acknowledgement key binds repository, logical path and the sorted set of
 * claimant identities (task ids + owner ids). A new claimant changes the key
 * and therefore warns again.
 */
function acknowledgementKey(conflicts: ClaimConflict[], repoKey: string): string {
	const paths = [
		...new Set(
			conflicts.flatMap((conflict) => conflict.sharedPaths.map((shared) => normalizePath(shared))),
		),
	]
		.filter((shared) => shared !== "")
		.sort();
	const identities = new Set<string>();
	for (const conflict of conflicts) {
		identities.add(`task:${conflict.taskId}`);
		const owner = conflict.ownerAgentId ?? conflict.assignedAgentId;
		if (owner !== undefined && owner !== "") identities.add(`owner:${owner}`);
	}
	return `${repoKey}\u0000${paths.join(",")}\u0000${[...identities].sort().join(",")}`;
}

function parseRoster(structured: Record<string, unknown> | undefined): RosterRead {
	if (structured === undefined) {
		return { kind: "malformed", detail: "no structured content" };
	}
	if (!Array.isArray(structured.active)) {
		return { kind: "malformed", detail: "active roster is missing" };
	}
	const rows: RosterRow[] = [];
	for (const entry of structured.active) {
		const record = asRecord(entry);
		const taskId = asString(record?.taskId);
		const status = asString(record?.status);
		if (record === undefined || taskId === undefined || status === undefined) {
			return { kind: "malformed", detail: "roster row without taskId/status" };
		}
		rows.push({
			taskId,
			status,
			agentId: asString(record.agentId),
			assignedAgentId: asString(record.assignedAgentId),
		});
	}
	return { kind: "ok", rows };
}

function parseTask(structured: Record<string, unknown> | undefined): TaskRead {
	if (structured === undefined) {
		return { kind: "malformed", detail: "no structured content" };
	}
	const task = asRecord(structured.task);
	if (task === undefined) return { kind: "malformed", detail: "no task row" };
	const taskId = asString(task.taskId);
	const status = asString(task.status);
	const expectedFiles = asStringArray(task.expectedFiles);
	if (taskId === undefined || status === undefined || expectedFiles === undefined) {
		return { kind: "malformed", detail: "task row without taskId/status/expectedFiles" };
	}
	return { kind: "ok", task, expectedFiles };
}

/**
 * Fresh (never cached across turns) overlap check:
 * 1. inspect_work({}) roster → other claimed tasks (assigned/active/blocked/
 *    handoff_offered) — workspace `touches` is NOT a path list;
 * 2. inspect_work({task_id}) details → expectedFiles;
 * 3. exact normalized path comparison (CLI check semantics);
 * 4. first conflict → block with task/owner + explicit retry instructions;
 * 5. acknowledged retry within 10 minutes with the SAME claimant set → allow
 *    plus one result annotation for this tool-call id; a NEW claimant warns again;
 * 6. before allowing an operation under the selected write task, merge the
 *    intended file via start_work only after fresh confirmation that this agent
 *    owns ACTIVE work; apply returned overlap information; never accept/reopen/
 *    reclaim offered or terminal work through this path;
 * 7. unavailable Concord / malformed data / deadline / internal exception →
 *    allow-degraded with a deduplicated notice. Never describe fail-open as
 *    "no conflict". The whole hook is caught — a thrown hook error would block
 *    the tool.
 */
export class EditGuard {
	private readonly deps: EditGuardDeps;
	/** In-flight reads coalesced per process; entries are removed on settle so
	 *  a new claim can never be hidden by a cache from an earlier turn. */
	private readonly inflight = new Map<string, Promise<unknown>>();
	private readonly acknowledgements = new Map<string, { at: number; toolCallId: string }>();
	/** Notice keys already surfaced; later identical degradations return an
	 *  empty reason so the caller does not repeat the same notice. */
	private readonly notices = new Set<string>();
	/** Fallback committed counts for unit clients without the durable control owner. */
	private readonly parentLines = new Map<string, number>();
	/** Reservations exist only between preflight and the matching tool_result. */
	private readonly pendingParentWrites = new Map<string, { key: string; taskId: string; path: string; repoKey: string; changedLines: number; maxLines: number; record?: (taskId: string, path: string, changedLines: number, maxLines: number) => void }>();

	constructor(deps: EditGuardDeps) {
		this.deps = deps;
	}

	/** Entry point from the tool_call hook for edit/write. */
	async preflight(
		input: { path: string; [key: string]: unknown },
		effectiveCwd: string,
		toolCallId: string,
	): Promise<PreflightOutcome> {
		let outcome: PreflightOutcome;
		try {
			outcome = await this.runPreflight(input, effectiveCwd, toolCallId);
		} catch (error) {
			outcome = this.degraded(
				`internal:${messageOf(error)}`,
				`muster: edit guard internal error (${messageOf(error)}) — claim check skipped for this write (fail-open, not a conflict check)`,
			);
		}
		if (outcome.action === "block") this.settleParentWrite(toolCallId, false);
		return outcome;
	}

	/** Commit a budget charge only after the matching file-writing tool succeeds. */
	settleParentWrite(toolCallId: string, succeeded: boolean): boolean {
		const pending = this.pendingParentWrites.get(toolCallId);
		if (pending === undefined) return true;
		if (succeeded) {
			try {
				if (pending.record) pending.record(pending.taskId, pending.path, pending.changedLines, pending.maxLines);
				else this.parentLines.set(pending.key, (this.parentLines.get(pending.key) ?? 0) + pending.changedLines);
			} catch {
				// Keep the reservation in memory so later writes fail closed if durable
				// state could not record this already-completed effect.
				return false;
			}
		}
		this.pendingParentWrites.delete(toolCallId);
		return true;
	}

	/** Acknowledgement keyed by repoKey + logical path + claimant identities. */
	hasAcknowledgement(conflicts: ClaimConflict[], repoKey: string): boolean {
		if (conflicts.length === 0) return false;
		const key = acknowledgementKey(conflicts, repoKey);
		const record = this.acknowledgements.get(key);
		if (record === undefined) return false;
		if (Date.now() - record.at >= ACK_WINDOW_MS) {
			this.acknowledgements.delete(key);
			return false;
		}
		return true;
	}

	/** Record an acknowledgement for this retry (10-minute window, same claimants). */
	rememberAcknowledgement(
		conflicts: ClaimConflict[],
		repoKey: string,
		toolCallId: string,
	): void {
		if (conflicts.length === 0) return;
		const key = acknowledgementKey(conflicts, repoKey);
		const existing = this.acknowledgements.get(key);
		// The same blocked tool result must not extend its own window.
		if (existing !== undefined && existing.toolCallId === toolCallId) return;
		this.acknowledgements.set(key, { at: Date.now(), toolCallId });
	}

	/** Human block reason with task/owner and the exact retry instruction. */
	formatBlockReason(conflicts: ClaimConflict[], repoKey: string): string {
		if (conflicts.length === 0) {
			return `muster: edit blocked in repository ${repoKey} — claim conflict data was empty; retry after re-running the claim check`;
		}
		const lines = [
			`muster: edit blocked in repository ${repoKey} — ${conflicts.length === 1 ? "a claimed task covers" : `${conflicts.length} claimed tasks cover`} the intended file:`,
		];
		for (const conflict of conflicts) {
			const owner = conflict.ownerAgentId ?? conflict.assignedAgentId ?? "unknown";
			const title = conflict.title === undefined ? "" : ` "${conflict.title}"`;
			lines.push(
				`  - task ${conflict.taskId}${title} [status ${conflict.status}, owner ${owner}] claims ${conflict.sharedPaths.join(", ")}`,
			);
		}
		lines.push(conflictNotice(conflicts));
		return lines.join("\n");
	}

	// ── Internals ─────────────────────────────────────────────────────────────

	private budgetMs(): number {
		const configured = this.deps.budgetMs;
		return typeof configured === "number" && Number.isFinite(configured) && configured >= 0
			? configured
			: DEFAULT_BUDGET_MS;
	}

	/**
	 * Degraded (fail-open) outcome. The notice is surfaced once per key; later
	 * identical degradation returns `reason: ""` so the caller does not repeat
	 * the same user-facing notice. An empty reason still means allow-degraded —
	 * the action, never the text, carries the authority.
	 */
	private degraded(key: string, reason: string): PreflightOutcome {
		if (this.notices.has(key)) return { action: "allow-degraded", reason: "" };
		this.notices.add(key);
		return { action: "allow-degraded", reason };
	}

	/**
	 * The parent write scope for one write. Returns a block when this write
	 * would exceed the parent's per-file, per-task budget outside its globs, and
	 * `undefined` when the scope does not apply or the write is inside it.
	 */
	private parentScope(
		input: { path: string; [key: string]: unknown },
		repoKey: string,
		intended: string,
		absolutePath: string,
		binding: RepoBinding,
		toolCallId: string,
	): { blocked: PreflightOutcome } | undefined {
		const scope = this.deps.parentWriteScope?.(repoKey);
		if (scope === undefined) return undefined;
		const taskId = binding.currentWriteTaskId;
		if (scope.globs.some((glob) => pathMatchesGlob(intended, glob))) return undefined;
		if (taskId === undefined || taskId === "") return { blocked: { action: "block", reason: `muster: parent edit out of scope — select a task before changing ${intended} outside the project's parent-writable globs`, conflicts: [], repoKey } };
		let currentContent = "";
		try { currentContent = readFileSync(absolutePath, "utf8"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { blocked: { action: "block", reason: `muster: cannot determine the changed-line count for ${intended}; the parent write is refused`, conflicts: [], repoKey } }; }
		const nextContent = intendedFileContent(input, currentContent);
		if (nextContent === undefined) return { blocked: { action: "block", reason: `muster: cannot determine the changed-line count for ${intended}; use a supported edit/write schema or add the path to parent-writable globs`, conflicts: [], repoKey } };
		const key = `${repoKey}\u0000${intended}\u0000${taskId}`;
		let already: number;
		try { already = scope.readChargedLines?.(taskId, intended) ?? this.parentLines.get(key) ?? 0; }
		catch { return { blocked: { action: "block", reason: `muster: cannot read the durable parent write budget for ${intended}; the parent write is refused`, conflicts: [], repoKey } }; }
		const pending = [...this.pendingParentWrites.values()].filter((row) => row.repoKey === repoKey && row.path === intended && row.taskId === taskId).reduce((sum, row) => sum + row.changedLines, 0);
		const remaining = Math.max(0, scope.maxLines - already - pending);
		const incoming = changedLineCount(currentContent, nextContent, remaining);
		const total = already + pending + incoming;
		if (total > scope.maxLines) {
			return {
				blocked: {
					action: "block",
					reason: `muster: parent edit out of scope — ${intended} is not in this project's parent-writable globs (${scope.globs.join(", ") || "none"}) and this orchestrator has already changed ${already + pending} of ${scope.maxLines} allowed lines in it on task ${taskId}. This write would exceed the remaining budget. Dispatch a fixer lane for ${intended}, or add the path to the project's parent-writable globs.`,
					conflicts: [],
					repoKey,
				},
			};
		}
		if (incoming > 0) this.pendingParentWrites.set(toolCallId, { key, taskId, path: intended, repoKey, changedLines: incoming, maxLines: scope.maxLines, ...(scope.recordChargedLines ? { record: scope.recordChargedLines } : {}) });
		return undefined;
	}

	private async runPreflight(
		input: { path: string; [key: string]: unknown },
		effectiveCwd: string,
		toolCallId: string,
	): Promise<PreflightOutcome> {
		const budgetMs = this.budgetMs();
		const started = performance.now();
		const remaining = (): number => Math.max(0, budgetMs - (performance.now() - started));
		const expired = (): boolean => performance.now() - started >= budgetMs;

		const target = resolveToolTarget(input?.path ?? "", effectiveCwd);
		const route = routeToBinding(target, this.deps.bindings() ?? []);
		if (route === null || route.relativePosix === "") return { action: "allow" };
		const { binding, repoKey } = route;
		const intended = route.relativePosix;

		// R2 item 3: the parent's own scope. A parent that owns an enrolled
		// programme writes its catalogue globs freely; anything else stays a
		// small fix of its own task. Claim checks still run afterwards.
		const scope = this.parentScope(input, repoKey, intended, target.absolute, binding, toolCallId);
		if (scope?.blocked !== undefined) return scope.blocked;

		const client = this.deps.concordFor(repoKey);
		if (client === undefined) {
			return this.degraded(
				`no-client:${repoKey}:${intended}`,
				`muster: no Concord connection for repository ${repoKey} — claim check skipped for ${intended} (fail-open, not a conflict check)`,
			);
		}

		const rosterRaced = await this.race(remaining(), this.readRoster(repoKey, client));
		if (!rosterRaced.ok) return this.readFailure("roster", repoKey, intended, rosterRaced.error);
		const roster = rosterRaced.value;
		if (roster.kind === "failed") {
			return this.degraded(
				`roster-failed:${repoKey}`,
				`muster: Concord inspect_work roster failed (${roster.detail}) — claim check skipped for ${intended} (fail-open, not a conflict check)`,
			);
		}
		if (roster.kind === "malformed") {
			return this.degraded(
				`roster-malformed:${repoKey}`,
				`muster: Concord inspect_work roster returned malformed data (${roster.detail}) — claim check skipped for ${intended} (fail-open, not a conflict check)`,
			);
		}

		const myTaskId = binding.currentWriteTaskId;
		const candidates = roster.rows.filter(
			(row) => row.taskId !== myTaskId && CLAIMED_STATUSES.has(row.status),
		);
		const detailReads = await Promise.all(
			candidates.map(async (row) => ({
				row,
				raced: await this.race(remaining(), this.readTask(repoKey, row.taskId, client)),
			})),
		);
		const claimedDetails: Array<{
			row: RosterRow;
			task: Record<string, unknown>;
			expectedFiles: string[];
		}> = [];
		for (const { row, raced } of detailReads) {
			if (!raced.ok) return this.readFailure(`task ${row.taskId}`, repoKey, intended, raced.error);
			if (raced.value.kind === "failed") {
				return this.degraded(
					`task-failed:${repoKey}:${row.taskId}`,
					`muster: Concord inspect_work for ${row.taskId} failed (${raced.value.detail}) — claim check skipped for ${intended} (fail-open, not a conflict check)`,
				);
			}
			if (raced.value.kind !== "ok") {
				return this.degraded(
					`task-malformed:${repoKey}:${row.taskId}`,
					`muster: Concord inspect_work for ${row.taskId} returned malformed data (${raced.value.detail}) — claim check skipped for ${intended} (fail-open, not a conflict check)`,
				);
			}
			claimedDetails.push({ row, task: raced.value.task, expectedFiles: raced.value.expectedFiles });
		}

		const conflicts: ClaimConflict[] = [];
		const retired = this.deps.retiredAgents?.(repoKey);
		const parents = this.deps.parentAgents?.(repoKey);
		const heldOnlyByParent = (task: Record<string, unknown>, row: RosterRow): boolean => {
			if (parents === undefined || parents.size === 0) return false;
			const holders = [ownerAgentOf(task, row), asString(task.assignedAgentId) ?? row.assignedAgentId].filter(
				(id): id is string => id !== undefined,
			);
			return holders.length > 0 && holders.every((id) => parents.has(id));
		};
		// What this worker declared for its own task. Read only when an umbrella claim
		// could matter, and never for the parent itself; unread means no exemption.
		let ownDeclared: Set<string> | undefined;
		if (
			myTaskId !== undefined &&
			parents !== undefined &&
			!parents.has(binding.agentId) &&
			claimedDetails.some(({ row, task }) => heldOnlyByParent(task, row))
		) {
			const mine = await this.race(remaining(), this.readTask(repoKey, myTaskId, client));
			if (mine.ok && mine.value.kind === "ok") {
				ownDeclared = new Set(mine.value.expectedFiles.map((file) => normalizePath(file)).filter((file) => file !== ""));
			}
		}
		for (const { row, task, expectedFiles } of claimedDetails) {
			// Re-check the status from the fresh detail: the roster may already be
			// stale, and release/complete must stop flagging.
			const status = asString(task.status) ?? row.status;
			if (!CLAIMED_STATUSES.has(status)) continue;
			// A claim held only by retired identities (an old parent session) is
			// not a live claimant. A live assigned worker keeps the claim real.
			if (retired !== undefined && retired.size > 0) {
				const holders = [ownerAgentOf(task, row), asString(task.assignedAgentId) ?? row.assignedAgentId].filter(
					(id): id is string => id !== undefined,
				);
				if (holders.length > 0 && holders.every((id) => retired.has(id))) continue;
			}
			if (ownDeclared?.has(intended) === true && heldOnlyByParent(task, row)) continue;
			const shared = [
				...new Set(
					expectedFiles
						.map((file) => normalizePath(file))
						.filter((file) => file !== "" && file === intended),
				),
			];
			if (shared.length === 0) continue;
			conflicts.push({
				taskId: asString(task.taskId) ?? row.taskId,
				title: asString(task.title),
				ownerAgentId: ownerAgentOf(task, row),
				assignedAgentId: asString(task.assignedAgentId) ?? row.assignedAgentId,
				status,
				sharedPaths: shared,
			});
		}
		conflicts.sort((left, right) => left.taskId.localeCompare(right.taskId));

		if (conflicts.length > 0 && !this.hasAcknowledgement(conflicts, repoKey)) {
			if (!expired()) this.rememberAcknowledgement(conflicts, repoKey, toolCallId);
			return {
				action: "block",
				reason: this.formatBlockReason(conflicts, repoKey),
				conflicts,
				repoKey,
			};
		}

		let merge: MergeOutcome = { kind: "skipped" };
		if (myTaskId !== undefined) {
			merge = await this.mergeIntendedFile({
				repoKey,
				client,
				binding,
				myTaskId,
				intended,
				acknowledgedTaskIds: new Set(conflicts.map((conflict) => conflict.taskId)),
				roster: candidates,
				remaining,
				expired,
			});
		}
		if (merge.kind === "expired") {
			return this.degraded(`budget:${repoKey}`, BUDGET_NOTICE);
		}
		if (merge.kind === "degraded") {
			return this.degraded(merge.key, merge.reason);
		}
		if (merge.kind === "block") {
			if (!expired()) this.rememberAcknowledgement(merge.conflicts, repoKey, toolCallId);
			return {
				action: "block",
				reason: this.formatBlockReason(merge.conflicts, repoKey),
				conflicts: merge.conflicts,
				repoKey,
			};
		}

		const allowed: Extract<PreflightOutcome, { action: "allow" }> = { action: "allow" };
		if (conflicts.length > 0) allowed.notice = retryAnnotation(conflicts);
		if (merge.kind === "claimed") allowed.autoClaimed = true;
		return allowed;
	}

	/**
	 * Merge the intended file into the selected write task. Fresh verification
	 * first: the task detail read must show this agent as owner and status
	 * `active`. start_work is never used to accept an assignment, take a pending
	 * handoff, reopen review-ready/terminal work, or reclaim foreign work.
	 */
	private async mergeIntendedFile(args: {
		repoKey: string;
		client: ConcordLike;
		binding: RepoBinding;
		myTaskId: string;
		intended: string;
		acknowledgedTaskIds: Set<string>;
		roster: RosterRow[];
		remaining: () => number;
		expired: () => boolean;
	}): Promise<MergeOutcome> {
		const { repoKey, client, binding, myTaskId, intended, acknowledgedTaskIds, roster } = args;
		const readRaced = await this.race(args.remaining(), this.readTask(repoKey, myTaskId, client));
		if (!readRaced.ok) {
			if (readRaced.error === undefined) return { kind: "expired" };
			return {
				kind: "degraded",
				key: `verify:${repoKey}:${myTaskId}`,
				reason: `muster: cannot verify task ${myTaskId} for ${intended} (${messageOf(readRaced.error)}) — claim not updated (fail-open)`,
			};
		}
		const read = readRaced.value;
		if (read.kind === "failed") {
			return {
				kind: "degraded",
				key: `verify:${repoKey}:${myTaskId}`,
				reason: `muster: cannot verify task ${myTaskId} for ${intended} (${read.detail}) — claim not updated (fail-open)`,
			};
		}
		if (read.kind !== "ok") {
			return {
				kind: "degraded",
				key: `verify-malformed:${repoKey}:${myTaskId}`,
				reason: `muster: task detail for ${myTaskId} is malformed (${read.detail}) — claim not updated for ${intended} (fail-open)`,
			};
		}
		const task = read.task;
		const status = asString(task.status) ?? "unknown";
		const owner = ownerAgentOf(task);
		if (owner !== binding.agentId || status !== "active") {
			return {
				kind: "degraded",
				key: `verify-state:${repoKey}:${myTaskId}:${status}:${owner ?? "unknown"}`,
				reason:
					`muster: task ${myTaskId} is ${status}${owner === undefined ? "" : ` and owned by ${owner}`} — ` +
					`refusing to merge ${intended} into a claim this agent does not hold active (no claim change)`,
			};
		}
		const normalizedFiles = read.expectedFiles
			.map((file) => normalizePath(file))
			.filter((file) => file !== "");
		if (normalizedFiles.includes(intended)) return { kind: "unchanged" };
		if (args.expired()) return { kind: "expired" };

		const mergedRaw: string[] = [];
		const seen = new Set<string>();
		for (const raw of [...read.expectedFiles, intended]) {
			const key = normalizePath(raw);
			if (key === "" || seen.has(key)) continue;
			seen.add(key);
			mergedRaw.push(raw);
		}
		const startArgs: Record<string, unknown> = {
			task_id: myTaskId,
			title: asString(task.title) ?? myTaskId,
			kind: asString(task.agent) ?? "pi",
			expected_files: mergedRaw,
		};
		const timeoutMs = Math.max(1, args.remaining());
		const work = await this.race(
			args.remaining(),
			this.callToolOrError(client, "start_work", startArgs, timeoutMs),
		);
		if (!work.ok) {
			if (work.error === undefined) return { kind: "expired" };
			return {
				kind: "degraded",
				key: `merge-error:${repoKey}:${myTaskId}`,
				reason: `muster: claim merge (start_work) for ${intended} threw (${messageOf(work.error)}) — claim not updated (fail-open)`,
			};
		}
		if (!work.value.ok) {
			return {
				kind: "degraded",
				key: `merge-failed:${repoKey}:${myTaskId}`,
				reason: `muster: claim merge (start_work) for ${intended} failed (${messageOf(work.value.error)}) — claim not updated (fail-open)`,
			};
		}
		const structured = asRecord(work.value.value?.structuredContent);
		if (structured === undefined || asString(structured.task_id) !== myTaskId) {
			return {
				kind: "degraded",
				key: `merge-malformed:${repoKey}:${myTaskId}`,
				reason: `muster: claim merge for ${intended} returned malformed data — claim state not trusted (fail-open)`,
			};
		}
		const resultStatus = asString(structured.status);
		const resumedBy = asString(structured.resumed_by);
		if (
			resultStatus !== "active" ||
			(resumedBy !== undefined && resumedBy !== "claim" && resumedBy !== "new_claim")
		) {
			return {
				kind: "degraded",
				key: `merge-state:${repoKey}:${myTaskId}:${resultStatus ?? "unknown"}:${resumedBy ?? "unknown"}`,
				reason:
					`muster: claim merge for ${intended} returned status ${resultStatus ?? "unknown"}` +
					`${resumedBy === undefined ? "" : ` (${resumedBy})`} — not treating it as a fresh active claim (fail-open)`,
			};
		}

		const rosterById = new Map(roster.map((row) => [row.taskId, row]));
		const newConflicts: ClaimConflict[] = [];
		const seenConflicts = new Set<string>();
		for (const entry of asArray(structured.overlaps)) {
			const record = asRecord(entry);
			const conflictTaskId = asString(record?.task_id);
			if (conflictTaskId === undefined || conflictTaskId === myTaskId) continue;
			// The acknowledged claimant set is already covered by the recorded
			// acknowledgement; only genuinely new same-file overlap blocks.
			if (acknowledgedTaskIds.has(conflictTaskId)) continue;
			const reasons = asStringArray(record?.reasons) ?? [];
			if (!reasons.some((reason) => reason.startsWith(SAME_FILE_PREFIX))) continue;
			if (seenConflicts.has(conflictTaskId)) continue;
			seenConflicts.add(conflictTaskId);
			const shared = sharedFilesFromReasons(reasons).filter((file) => file === intended);
			const row = rosterById.get(conflictTaskId);
			newConflicts.push({
				taskId: conflictTaskId,
				title: asString(record?.title),
				ownerAgentId: row?.agentId ?? row?.assignedAgentId,
				assignedAgentId: row?.assignedAgentId,
				status: row?.status ?? "active",
				sharedPaths: shared.length > 0 ? shared : [intended],
			});
		}
		newConflicts.sort((left, right) => left.taskId.localeCompare(right.taskId));
		if (newConflicts.length > 0) return { kind: "block", conflicts: newConflicts };
		return { kind: "claimed" };
	}

	private readRoster(repoKey: string, client: ConcordLike): Promise<RosterRead> {
		return this.coalesce<RosterRead>(`roster:${repoKey}`, async () => {
			try {
				const response = await client.callTool("inspect_work", {});
				return parseRoster(response?.structuredContent);
			} catch (error) {
				return { kind: "failed", detail: messageOf(error) };
			}
		});
	}

	private readTask(repoKey: string, taskId: string, client: ConcordLike): Promise<TaskRead> {
		return this.coalesce<TaskRead>(`task:${repoKey}:${taskId}`, async () => {
			try {
				const response = await client.callTool("inspect_work", { task_id: taskId });
				return parseTask(response?.structuredContent);
			} catch (error) {
				return { kind: "failed", detail: messageOf(error) };
			}
		});
	}

	private coalesce<T>(key: string, load: () => Promise<T>): Promise<T> {
		const existing = this.inflight.get(key) as Promise<T> | undefined;
		if (existing !== undefined) return existing;
		const pending = load();
		this.inflight.set(key, pending);
		const clear = (): void => {
			if (this.inflight.get(key) === pending) this.inflight.delete(key);
		};
		pending.then(clear, clear);
		return pending;
	}

	private race<T>(remainingMs: number, work: Promise<T>): Promise<Raced<T>> {
		return new Promise<Raced<T>>((resolve) => {
			let settled = false;
			const finish = (result: Raced<T>): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(result);
			};
			const timer = setTimeout(() => finish({ ok: false }), Math.max(0, remainingMs));
			work.then(
				(value) => finish({ ok: true, value }),
				(error: unknown) => finish({ ok: false, error }),
			);
		});
	}

	private async callToolOrError(
		client: ConcordLike,
		name: string,
		args: Record<string, unknown>,
		timeoutMs: number,
	): Promise<{ ok: true; value: ConcordCall } | { ok: false; error: unknown }> {
		try {
			const value = await client.callTool(name, args, { timeoutMs });
			return { ok: true, value };
		} catch (error) {
			return { ok: false, error };
		}
	}

	private readFailure(
		stage: string,
		repoKey: string,
		intended: string,
		error: unknown,
	): PreflightOutcome {
		if (error !== undefined) {
			return this.degraded(
				`read-error:${repoKey}:${stage}`,
				`muster: Concord ${stage} read threw (${messageOf(error)}) — claim check skipped for ${intended} (fail-open, not a conflict check)`,
			);
		}
		return this.degraded(`budget:${repoKey}`, BUDGET_NOTICE);
	}
}

/** Result annotation appended to a permitted retry. */
export function retryAnnotation(conflicts: ClaimConflict[]): string {
	const taskIds = [...new Set(conflicts.map((conflict) => conflict.taskId))].sort();
	return `muster: proceed — acknowledged conflict(s): ${taskIds.join(", ")}`;
}

/**
 * The block text must include the conflict task(s), owner, and the exact retry
 * instruction wording (plan §5.5): the model must be told it may retry after
 * acknowledging the named conflict within ten minutes.
 */
export function conflictNotice(conflicts: ClaimConflict[]): string {
	const taskIds = [...new Set(conflicts.map((conflict) => conflict.taskId))].sort();
	const paths = [
		...new Set(conflicts.flatMap((conflict) => conflict.sharedPaths.map((shared) => normalizePath(shared)))),
	]
		.filter((shared) => shared !== "")
		.sort();
	const targets = paths.length > 0 ? paths.join(", ") : "the intended file";
	return [
		`muster: if you have read the conflicting claim(s) on ${targets} (${taskIds.join(", ")}) and still intend to write,`,
		"acknowledge the named conflict explicitly and retry within ten minutes — the same path and the same claimants then resolve to one recorded acknowledgement and the write proceeds.",
		"This acknowledgement covers only the claimant(s) named above: a new claimant requires a fresh warning.",
	].join(" ");
}
