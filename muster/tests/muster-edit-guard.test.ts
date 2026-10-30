import "./muster-test-isolation.ts";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	EditGuard,
	conflictNotice,
	resolveToolTarget,
	retryAnnotation,
	routeToBinding,
} from "../edit-guard.ts";
import type { ClaimConflict, EditGuardDeps, PreflightOutcome } from "../edit-guard.ts";
import type { RepoBinding } from "../types.ts";

/**
 * Model-free regressions for the Muster edit guard (plan §5.5).
 *
 * The Concord client is a fake returning canned structuredContent per
 * scenario; bindings are plain RepoBinding values. No Concord, no LLM, no
 * harness. The only real filesystem objects are the temp checkout/symlink
 * trees, because path canonicalization must actually resolve them.
 */

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "muster-edit-guard-")));
const REPO_A = join(TMP, "repo-a");
const REPO_A_LINKED = join(TMP, "repo-a-linked");
const REPO_B = join(TMP, "repo-b");
const OUTSIDE = join(TMP, "outside");

mkdirSync(join(REPO_A, "src", "nested"), { recursive: true });
mkdirSync(join(REPO_A_LINKED, "src"), { recursive: true });
mkdirSync(REPO_B, { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });
writeFileSync(join(REPO_A, "src", "file.ts"), "a\n");
writeFileSync(join(REPO_A_LINKED, "src", "file.ts"), "linked\n");
writeFileSync(join(REPO_B, "target.ts"), "b\n");
writeFileSync(join(OUTSIDE, "note.ts"), "outside\n");
symlinkSync(join(REPO_A, "src", "file.ts"), join(REPO_A, "src", "alias.ts"));
symlinkSync(REPO_A_LINKED, join(REPO_A, "worktree-linked"));
symlinkSync(join(REPO_B, "target.ts"), join(REPO_A, "cross.ts"));
symlinkSync(OUTSIDE, join(REPO_A, "escape"));

after(() => {
	rmSync(TMP, { recursive: true, force: true });
});

const SELF = "pi-self";
const OTHER = "pi-other";
const A_KEY = "/logical/concord/repo-a";
const B_KEY = "/logical/concord/repo-b";

function bindingAt(root: string, repoKey: string, overrides: Partial<RepoBinding> = {}): RepoBinding {
	return {
		alias: repoKey === A_KEY ? "a" : "b",
		repoKey,
		primaryRoot: root,
		checkoutRoots: [root],
		workspaceId: `ws-${repoKey}`,
		agentId: SELF,
		supervisedTaskIds: [],
		...overrides,
	};
}

function bindingA(overrides: Partial<RepoBinding> = {}): RepoBinding {
	return bindingAt(REPO_A, A_KEY, overrides);
}

function bindingB(overrides: Partial<RepoBinding> = {}): RepoBinding {
	return bindingAt(REPO_B, B_KEY, overrides);
}

// ─── Concord / roster fakes ──────────────────────────────────────────────────

type PlanResponse = { structuredContent?: Record<string, unknown> } | "error" | "hang";

function ok(structured: Record<string, unknown> | undefined): PlanResponse {
	return { structuredContent: structured };
}

type Call = { name: string; args: Record<string, unknown> };

class FakeConcord {
	readonly calls: Call[] = [];

	constructor(
		private readonly plan: {
			workspace?: () => PlanResponse;
			workspaceDelayMs?: number;
			details?: (taskId: string) => PlanResponse;
			startWork?: (args: Record<string, unknown>) => PlanResponse;
		} = {},
	) {}

	callTool = async (
		name: string,
		args: Record<string, unknown>,
		_options?: unknown,
	): Promise<{ structuredContent?: Record<string, unknown> }> => {
		this.calls.push({ name, args: { ...args } });
		if (name === "inspect_work" && args.task_id === undefined) {
			if (this.plan.workspaceDelayMs !== undefined) {
				await new Promise((resolve) => setTimeout(resolve, this.plan.workspaceDelayMs));
			}
			return this.respond(this.plan.workspace?.() ?? ok(workspaceRoster([])));
		}
		if (name === "inspect_work") {
			return this.respond(this.plan.details?.(String(args.task_id)) ?? ok(undefined));
		}
		if (name === "start_work") {
			return this.respond(this.plan.startWork?.(args) ?? ok(startWorkResult(String(args.task_id))));
		}
		throw new Error(`muster-test: unexpected tool ${name}`);
	};

	count(name: string): number {
		return this.calls.filter((call) => call.name === name).length;
	}

	workspaceCalls(): number {
		return this.calls.filter(
			(call) => call.name === "inspect_work" && call.args.task_id === undefined,
		).length;
	}

	detailReads(): string[] {
		return this.calls
			.filter((call) => call.name === "inspect_work" && call.args.task_id !== undefined)
			.map((call) => String(call.args.task_id));
	}

	startWorkCalls(): Array<Record<string, unknown>> {
		return this.calls.filter((call) => call.name === "start_work").map((call) => call.args);
	}

	private async respond(response: PlanResponse): Promise<{ structuredContent?: Record<string, unknown> }> {
		if (response === "error") throw new Error("concord-test: call failed");
		if (response === "hang") return new Promise<never>(() => {});
		return response;
	}
}

function makeGuard(options: {
	bindings?: RepoBinding[] | (() => RepoBinding[]);
	clients?: Record<string, FakeConcord>;
	budgetMs?: number;
}): { guard: EditGuard; bindingCalls: () => number } {
	const current =
		typeof options.bindings === "function" ? options.bindings : () => options.bindings ?? [];
	let calls = 0;
	const deps: EditGuardDeps = {
		bindings: () => {
			calls += 1;
			return current();
		},
		concordFor: (repoKey: string) => options.clients?.[repoKey],
		budgetMs: options.budgetMs,
	};
	return { guard: new EditGuard(deps), bindingCalls: () => calls };
}

// ─── Structured-content builders ─────────────────────────────────────────────

function workspaceRoster(active: Array<Record<string, unknown>>): Record<string, unknown> {
	return {
		scope: "workspace",
		presence: [],
		active,
		overlaps: [],
		stale_claims: [],
		review_ready: [],
		open_questions: [],
		communications: [],
	};
}

function rosterRow(input: {
	taskId: string;
	status?: string;
	agentId?: string | null;
	assignedAgentId?: string | null;
	touches?: string;
}): Record<string, unknown> {
	return {
		taskId: input.taskId,
		agent: "-",
		agentId: input.agentId ?? null,
		assignedAgentId: input.assignedAgentId ?? null,
		status: input.status ?? "active",
		version: 1,
		updatedAt: "2026-01-01T00:00:00.000Z",
		branch: "-",
		touches: input.touches ?? "-",
		parentTaskId: null,
	};
}

type TaskDetailInput = {
	taskId: string;
	status?: string;
	title?: string;
	expectedFiles?: string[];
	agentId?: string | null;
	assignedAgentId?: string | null;
	owner?: string | null;
	agentKind?: string | null;
};

/** Concord `inspect_work({task_id})` workspace payload: task row at `task`. */
function taskDetail(input: TaskDetailInput): Record<string, unknown> {
	return {
		taskId: input.taskId,
		title: input.title ?? `${input.taskId} work`,
		owner: input.owner ?? null,
		agent: input.agentKind ?? null,
		branch: null,
		worktree: null,
		expectedFiles: input.expectedFiles ?? [],
		modules: [],
		domains: [],
		riskTags: [],
		notes: null,
		status: input.status ?? "active",
		parentTaskId: null,
		agentId: input.agentId ?? null,
		version: 1,
		assignedAgentId: input.assignedAgentId ?? null,
		leaseExpiresAt: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

/** Task-scope structuredContent as the Concord MCP server actually emits it. */
function taskRead(input: TaskDetailInput): PlanResponse {
	return ok({ scope: "task", task: taskDetail(input), updates: [], overlaps: [] });
}

function startWorkResult(
	taskId: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		task_id: taskId,
		status: "active",
		version: 2,
		updated_at: "2026-01-01T00:00:00.000Z",
		agent_id: SELF,
		assigned_agent_id: null,
		resumed_by: "claim",
		overlaps: [],
		...overrides,
	};
}

type Blocked = Extract<PreflightOutcome, { action: "block" }>;
type Degraded = Extract<PreflightOutcome, { action: "allow-degraded" }>;
type Allowed = Extract<PreflightOutcome, { action: "allow" }>;

function blockedOf(outcome: PreflightOutcome): Blocked {
	assert.equal(outcome.action, "block");
	return outcome as Blocked;
}

function degradedOf(outcome: PreflightOutcome): Degraded {
	assert.equal(outcome.action, "allow-degraded");
	return outcome as Degraded;
}

function allowedOf(outcome: PreflightOutcome): Allowed {
	assert.equal(outcome.action, "allow");
	return outcome as Allowed;
}

/** A guard whose only other claimant is T2 covering the given paths. */
function conflictingGuard(paths: string[] = ["src/file.ts"]): { guard: EditGuard; fake: FakeConcord } {
	const fake = new FakeConcord({
		workspace: () =>
			ok(workspaceRoster([rosterRow({ taskId: "T2", status: "active", agentId: OTHER, touches: "src" })])),
		details: (taskId) =>
			taskId === "T2"
				? taskRead({ taskId: "T2", title: "Parser work", expectedFiles: paths, agentId: OTHER })
				: ok(undefined),
	});
	const { guard } = makeGuard({ bindings: [bindingA()], clients: { [A_KEY]: fake } });
	return { guard, fake };
}

// ─── R1: retired identities do not block ─────────────────────────────────────

function retiringGuard(retired: string[], claim: { agentId?: string; assignedAgentId?: string }): EditGuard {
	const fake = new FakeConcord({
		workspace: () =>
			ok(workspaceRoster([rosterRow({ taskId: "T2", status: "active", touches: "src", ...claim })])),
		details: (taskId) =>
			taskId === "T2" ? taskRead({ taskId: "T2", title: "Old parent work", expectedFiles: ["src/file.ts"], ...claim }) : ok(undefined),
	});
	return new EditGuard({
		bindings: () => [bindingA()],
		concordFor: (repoKey: string) => (repoKey === A_KEY ? fake : undefined),
		retiredAgents: () => new Set(retired),
	});
}

test("R1: a claim held only by a retired identity no longer blocks an edit", async () => {
	const guard = retiringGuard([OTHER], { agentId: OTHER });
	allowedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "retired-1"));
});

test("R1: a claim held by a live identity still blocks, even when other identities are retired", async () => {
	const guard = retiringGuard(["pi-someone-else"], { agentId: OTHER });
	blockedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "live-1"));
});

test("R1: a claim whose owner is retired but whose assigned worker is live still blocks", async () => {
	const guard = retiringGuard([OTHER], { agentId: OTHER, assignedAgentId: "pi-worker-live" });
	blockedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "mixed-1"));
});

test("R1: a claim with both identities retired no longer blocks", async () => {
	const guard = retiringGuard([OTHER, "pi-worker-old"], { agentId: OTHER, assignedAgentId: "pi-worker-old" });
	allowedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "both-retired-1"));
});

test("R1: without a retired list the guard behaves as before", async () => {
	const { guard } = conflictingGuard();
	blockedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "default-1"));
});

// ─── AM2 item 8: the supervising parent's umbrella claim does not block its workers ──

const PARENT = "pi-sandbox-parent";

/** A worker (SELF, task MINE) edits src/file.ts while the parent's umbrella task UMB also lists it. */
function umbrellaGuard(options: { mineFiles: string[]; umbrella?: { agentId?: string; assignedAgentId?: string }; otherWorker?: boolean; withParents?: boolean; mineUnreadable?: boolean }) {
	const umbrella = options.umbrella ?? { agentId: PARENT };
	const rows = [
		rosterRow({ taskId: "UMB", status: "active", ...umbrella }),
		rosterRow({ taskId: "MINE", status: "active", agentId: SELF }),
		...(options.otherWorker ? [rosterRow({ taskId: "L2", status: "active", agentId: OTHER })] : []),
	];
	const fake = new FakeConcord({
		workspace: () => ok(workspaceRoster(rows)),
		details: (taskId) => {
			if (taskId === "UMB") return taskRead({ taskId: "UMB", title: "Umbrella", expectedFiles: ["src/file.ts", "src/other.ts"], ...umbrella });
			if (taskId === "L2") return taskRead({ taskId: "L2", title: "Other lane", expectedFiles: ["src/file.ts"], agentId: OTHER });
			if (taskId === "MINE") return options.mineUnreadable ? "error" : taskRead({ taskId: "MINE", title: "My lane", expectedFiles: options.mineFiles, agentId: SELF });
			return ok(undefined);
		},
	});
	const guard = new EditGuard({
		bindings: () => [bindingA({ currentWriteTaskId: "MINE" })],
		concordFor: (repoKey: string) => (repoKey === A_KEY ? fake : undefined),
		...(options.withParents === false ? {} : { parentAgents: () => new Set([PARENT]) }),
	});
	return { guard, fake };
}

test("AM2: the parent's umbrella claim does not block a worker inside the worker's own expected files", async () => {
	const { guard, fake } = umbrellaGuard({ mineFiles: ["src/file.ts"] });
	const outcome = allowedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "umb-1"));
	assert.equal(outcome.notice, undefined);
	assert.equal(fake.count("start_work"), 0);
});

test("AM2: a file the worker has not declared still hits the umbrella claim", async () => {
	const { guard } = umbrellaGuard({ mineFiles: ["docs/readme.md"] });
	const outcome = blockedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "umb-2"));
	assert.deepEqual(outcome.conflicts.map((conflict) => conflict.taskId), ["UMB"]);
});

test("AM2: two workers still block each other, and the umbrella is not named in that conflict", async () => {
	const { guard } = umbrellaGuard({ mineFiles: ["src/file.ts"], otherWorker: true });
	const outcome = blockedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "umb-3"));
	assert.deepEqual(outcome.conflicts.map((conflict) => conflict.taskId), ["L2"]);
});

test("AM2: a claim the parent shares with a live worker is not an umbrella claim", async () => {
	const { guard } = umbrellaGuard({ mineFiles: ["src/file.ts"], umbrella: { agentId: PARENT, assignedAgentId: OTHER } });
	blockedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "umb-4"));
});

test("AM2: without a known parent identity the guard behaves as before", async () => {
	const { guard } = umbrellaGuard({ mineFiles: ["src/file.ts"], withParents: false });
	blockedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "umb-5"));
});

test("AM2: when the worker's own task cannot be read the umbrella claim keeps blocking", async () => {
	const { guard } = umbrellaGuard({ mineFiles: ["src/file.ts"], mineUnreadable: true });
	blockedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "umb-6"));
});

// ─── V3: canonical resolution and binding routing ────────────────────────────

test("V3: resolveToolTarget resolves relative and absolute targets against the effective cwd", () => {
	const relative = resolveToolTarget("src/file.ts", REPO_A);
	assert.equal(relative.absolute, join(REPO_A, "src", "file.ts"));
	assert.equal(relative.isNewFile, false);

	const absolute = resolveToolTarget(join(REPO_A, "src", "file.ts"), OUTSIDE);
	assert.equal(absolute.absolute, join(REPO_A, "src", "file.ts"));
	assert.equal(absolute.isNewFile, false);
});

test("V3: resolveToolTarget resolves a new file through its nearest existing ancestor", () => {
	const target = resolveToolTarget("src/new/deep/created.ts", REPO_A);
	assert.equal(target.absolute, join(REPO_A, "src", "new", "deep", "created.ts"));
	assert.equal(target.isNewFile, true);
});

test("V3: resolveToolTarget canonicalizes existing symlink aliases to one file identity", () => {
	const alias = resolveToolTarget("src/alias.ts", REPO_A);
	assert.equal(alias.absolute, join(REPO_A, "src", "file.ts"));
	assert.equal(alias.isNewFile, false);

	const cross = resolveToolTarget("cross.ts", REPO_A);
	assert.equal(cross.absolute, join(REPO_B, "target.ts"));
});

test("V3: a new file under a symlinked ancestor resolves at the real location", () => {
	const target = resolveToolTarget("worktree-linked/src/fresh.ts", REPO_A);
	assert.equal(target.absolute, join(REPO_A_LINKED, "src", "fresh.ts"));
	assert.equal(target.isNewFile, true);
});

test("V3: routeToBinding strips the matching checkout root, never the primary root", () => {
	const shared = bindingA({ checkoutRoots: [REPO_A, join(REPO_A, "worktree-linked")] });
	const routed = routeToBinding(resolveToolTarget("src/file.ts", REPO_A_LINKED), [shared]);
	assert.equal(routed?.repoKey, A_KEY);
	assert.equal(routed?.relativePosix, "src/file.ts");
	assert.equal(routed?.binding, shared);
});

test("V3: linked worktrees of one repository yield the same relativePosix and repoKey", () => {
	const shared = bindingA({ checkoutRoots: [REPO_A, join(REPO_A, "worktree-linked")] });
	const inPrimary = routeToBinding(resolveToolTarget("src/file.ts", REPO_A), [shared]);
	const inLinked = routeToBinding(resolveToolTarget("src/file.ts", REPO_A_LINKED), [shared]);
	assert.equal(inPrimary?.repoKey, A_KEY);
	assert.equal(inLinked?.repoKey, A_KEY);
	assert.equal(inPrimary?.relativePosix, "src/file.ts");
	assert.equal(inLinked?.relativePosix, "src/file.ts");
});

test("V3: traversal resolves to its true location and cannot route into an unintended binding", () => {
	const escaped = resolveToolTarget("../outside/note.ts", REPO_A);
	assert.equal(escaped.absolute, join(OUTSIDE, "note.ts"));
	assert.equal(routeToBinding(escaped, [bindingA()]), null);

	const nested = resolveToolTarget("../../../outside/note.ts", join(REPO_A, "src", "nested"));
	assert.equal(nested.absolute, join(OUTSIDE, "note.ts"));
	assert.equal(routeToBinding(nested, [bindingA(), bindingB()]), null);

	const rerouted = routeToBinding(resolveToolTarget("../repo-b/target.ts", REPO_A), [
		bindingA(),
		bindingB(),
	]);
	assert.equal(rerouted?.repoKey, B_KEY);
	assert.equal(rerouted?.relativePosix, "target.ts");
});

test("V3: a cross-repository symlink routes to the binding containing the real target", () => {
	const routed = routeToBinding(resolveToolTarget("cross.ts", REPO_A), [bindingA(), bindingB()]);
	assert.equal(routed?.repoKey, B_KEY);
	assert.equal(routed?.relativePosix, "target.ts");
});

test("V3: an unbound target allows without any checked claim", async () => {
	const fake = new FakeConcord({ workspace: () => ok(workspaceRoster([])) });
	const { guard } = makeGuard({ bindings: [bindingA()], clients: { [A_KEY]: fake } });
	const outcome = await guard.preflight({ path: join(OUTSIDE, "note.ts") }, OUTSIDE, "call-unbound");
	assert.deepEqual(outcome, { action: "allow" });
	assert.equal(fake.calls.length, 0);
});

test("V3: the same relative path in a different repository stays a separate binding", async () => {
	const fakeA = new FakeConcord({
		workspace: () => ok(workspaceRoster([rosterRow({ taskId: "TA", agentId: OTHER })])),
		details: () => taskRead({ taskId: "TA", expectedFiles: ["src/file.ts"], agentId: OTHER }),
	});
	const fakeB = new FakeConcord({
		workspace: () => ok(workspaceRoster([rosterRow({ taskId: "TB", agentId: OTHER })])),
		details: () => taskRead({ taskId: "TB", expectedFiles: ["src/file.ts"], agentId: OTHER }),
	});
	const { guard } = makeGuard({
		bindings: [bindingA(), bindingB()],
		clients: { [A_KEY]: fakeA, [B_KEY]: fakeB },
	});

	const inA = blockedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "call-a"));
	assert.equal(inA.conflicts[0]?.taskId, "TA");
	assert.equal(fakeB.calls.length, 0, "the other repository is never consulted");

	const inB = blockedOf(await guard.preflight({ path: "src/file.ts" }, REPO_B, "call-b"));
	assert.equal(inB.conflicts[0]?.taskId, "TB");
	assert.equal(fakeA.calls.length, 2, "repository A is not re-read for a repository B target");
});

// ─── V4: conflict procedure ──────────────────────────────────────────────────

test("V4: the roster has no path list — expectedFiles come from the task detail, touches is ignored", async () => {
	const fake = new FakeConcord({
		workspace: () =>
			ok(workspaceRoster([rosterRow({ taskId: "T2", status: "active", agentId: OTHER, touches: "src" })])),
		// touches says `src`; the detail says the claim is docs only.
		details: () => taskRead({ taskId: "T2", expectedFiles: ["docs/other.md"], agentId: OTHER }),
	});
	const { guard } = makeGuard({ bindings: [bindingA()], clients: { [A_KEY]: fake } });
	const outcome = allowedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "call-detail"));
	assert.deepEqual(fake.detailReads(), ["T2"], "the claimed candidate's detail is read");
	assert.equal(outcome.notice, undefined);
	assert.equal(fake.count("start_work"), 0);
});

test("V4: the first same-file conflict blocks with task, owner, path and the retry instruction", async () => {
	const { guard, fake } = conflictingGuard();
	const outcome = blockedOf(await guard.preflight({ path: "./src//file.ts" }, REPO_A, "call-block"));
	assert.equal(outcome.conflicts.length, 1);
	assert.equal(outcome.conflicts[0]?.taskId, "T2");
	assert.equal(outcome.conflicts[0]?.title, "Parser work");
	assert.equal(outcome.conflicts[0]?.ownerAgentId, OTHER);
	assert.equal(outcome.conflicts[0]?.status, "active");
	assert.deepEqual(outcome.conflicts[0]?.sharedPaths, ["src/file.ts"]);
	assert.match(outcome.reason, /T2/);
	assert.match(outcome.reason, new RegExp(OTHER));
	assert.match(outcome.reason, /Parser work/);
	assert.match(outcome.reason, /src\/file\.ts/);
	assert.match(outcome.reason, /acknowledge the named conflict/);
	assert.match(outcome.reason, /retry within ten minutes/);
	assert.match(outcome.reason, /a new claimant requires a fresh warning/);
	assert.deepEqual(fake.detailReads(), ["T2"]);
});

test("V4: an informed retry inside ten minutes permits with the acknowledgement annotation", async () => {
	const { guard, fake } = conflictingGuard();
	const blocked = blockedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "call-1"));
	const retry = allowedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "call-2"));
	assert.equal(retry.notice, "muster: proceed — acknowledged conflict(s): T2");
	assert.equal(retry.notice, retryAnnotation(blocked.conflicts));
	assert.equal(retry.autoClaimed, undefined);
	assert.equal(fake.count("start_work"), 0, "no current write task means no claim merge");
});

test("V4: a new claimant warns again even inside the acknowledgement window", async () => {
	let active = [rosterRow({ taskId: "T2", status: "active", agentId: OTHER })];
	const details: Record<string, PlanResponse> = {
		T2: taskRead({ taskId: "T2", expectedFiles: ["src/file.ts"], agentId: OTHER }),
	};
	const fake = new FakeConcord({
		workspace: () => ok(workspaceRoster(active)),
		details: (taskId) => details[taskId] ?? ok(undefined),
	});
	const { guard } = makeGuard({ bindings: [bindingA()], clients: { [A_KEY]: fake } });

	const first = blockedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "call-1"));
	assert.equal(first.conflicts.length, 1);

	active = [...active, rosterRow({ taskId: "T3", status: "blocked", agentId: OTHER })];
	details["T3"] = taskRead({
		taskId: "T3",
		status: "blocked",
		expectedFiles: ["src/file.ts"],
		agentId: OTHER,
	});
	const second = blockedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "call-2"));
	assert.equal(second.conflicts.length, 2);
	assert.match(second.reason, /T3/);

	const third = allowedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "call-3"));
	assert.equal(third.notice, "muster: proceed — acknowledged conflict(s): T2, T3");
});

test("V4: an acknowledgement older than ten minutes blocks again", async (t) => {
	const base = 1_700_000_000_000;
	t.mock.timers.enable({ apis: ["Date"], now: base });
	const { guard } = conflictingGuard();

	const first = blockedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "call-1"));
	assert.equal(first.action, "block");

	t.mock.timers.setTime(base + 9 * 60_000);
	const within = allowedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "call-2"));
	assert.equal(within.action, "allow");

	t.mock.timers.setTime(base + 11 * 60_000);
	const expired = blockedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "call-3"));
	assert.equal(expired.conflicts[0]?.taskId, "T2");
});

test("V4: the acknowledgement key binds repoKey, logical path and the sorted claimant set", () => {
	const { guard } = makeGuard({ bindings: [bindingA()] });
	const alpha: ClaimConflict = {
		taskId: "T1",
		ownerAgentId: "pi-a",
		status: "active",
		sharedPaths: ["src/file.ts"],
	};
	const beta: ClaimConflict = {
		taskId: "T2",
		ownerAgentId: "pi-b",
		status: "assigned",
		sharedPaths: ["src/file.ts"],
	};

	assert.equal(guard.hasAcknowledgement([alpha, beta], A_KEY), false);
	guard.rememberAcknowledgement([beta, alpha], A_KEY, "call-1");
	assert.equal(guard.hasAcknowledgement([alpha, beta], A_KEY), true, "order does not matter");
	assert.equal(guard.hasAcknowledgement([alpha, beta], B_KEY), false, "another repo never matches");
	assert.equal(
		guard.hasAcknowledgement([{ ...alpha, sharedPaths: ["src/other.ts"] }, beta], A_KEY),
		false,
		"another logical path never matches",
	);
	assert.equal(
		guard.hasAcknowledgement([{ ...alpha, taskId: "T9" }, beta], A_KEY),
		false,
		"a different claimant never matches",
	);
	assert.equal(
		guard.hasAcknowledgement([alpha, { ...beta, ownerAgentId: "pi-c" }], A_KEY),
		false,
		"a changed owner identity never matches",
	);

	assert.equal(retryAnnotation([beta, alpha]), "muster: proceed — acknowledged conflict(s): T1, T2");
	assert.equal(conflictNotice([beta, alpha]), conflictNotice([alpha, beta]));
	assert.match(conflictNotice([alpha, beta]), /T1, T2/);
});

test("V4: simultaneous preflights coalesce reads while later turns see new claims", async () => {
	let active = [rosterRow({ taskId: "T2", status: "active", agentId: OTHER })];
	const details: Record<string, PlanResponse> = {
		T2: taskRead({ taskId: "T2", expectedFiles: ["docs/other.md"], agentId: OTHER }),
	};
	const fake = new FakeConcord({
		workspace: () => ok(workspaceRoster(active)),
		workspaceDelayMs: 15,
		details: (taskId) => details[taskId] ?? ok(undefined),
	});
	const { guard } = makeGuard({ bindings: [bindingA()], clients: { [A_KEY]: fake } });

	const [first, second] = await Promise.all([
		guard.preflight({ path: "src/file.ts" }, REPO_A, "call-1"),
		guard.preflight({ path: "src/file.ts" }, REPO_A, "call-2"),
	]);
	assert.equal(allowedOf(first).action, "allow");
	assert.equal(allowedOf(second).action, "allow");
	assert.equal(fake.workspaceCalls(), 1, "simultaneous roster reads coalesce");

	active = [...active, rosterRow({ taskId: "T3", status: "active", agentId: OTHER })];
	details["T3"] = taskRead({ taskId: "T3", expectedFiles: ["src/file.ts"], agentId: OTHER });
	const third = blockedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "call-3"));
	assert.equal(third.conflicts[0]?.taskId, "T3", "a new claim is never hidden by a stale cache");
	assert.equal(fake.workspaceCalls(), 2, "each later turn re-reads the roster");
});

test("V4: a missing Concord client is allow-degraded and never reported as no conflict", async () => {
	const { guard } = makeGuard({ bindings: [bindingA()] });
	const first = degradedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "call-1"));
	assert.match(first.reason, /no Concord connection/);
	assert.match(first.reason, /claim check skipped/);
	assert.doesNotMatch(first.reason, /no conflict/i);

	const second = degradedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "call-2"));
	assert.equal(second.reason, "", "the notice is deduplicated per repoKey and path");

	const otherPath = degradedOf(await guard.preflight({ path: "src/other.ts" }, REPO_A, "call-3"));
	assert.match(otherPath.reason, /no Concord connection/);
});

test("V4: a throwing Concord client is visibly allow-degraded", async () => {
	const fake = new FakeConcord({ workspace: () => "error" });
	const { guard } = makeGuard({ bindings: [bindingA()], clients: { [A_KEY]: fake } });
	const outcome = degradedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "call-1"));
	assert.match(outcome.reason, /roster failed/);
	assert.match(outcome.reason, /fail-open/);
	assert.doesNotMatch(outcome.reason, /no conflict/i);
	assert.equal(fake.count("start_work"), 0);
});

test("V4: malformed workspace structuredContent is allow-degraded", async () => {
	const variants: Array<() => PlanResponse> = [
		() => ok(undefined),
		() => ok({ scope: "workspace" }),
		() => ok({ scope: "workspace", active: "nope" }),
		() => ok(workspaceRoster([{ status: "active" }])),
	];
	for (const workspace of variants) {
		const fake = new FakeConcord({ workspace });
		const { guard } = makeGuard({ bindings: [bindingA()], clients: { [A_KEY]: fake } });
		const outcome = degradedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "call-1"));
		assert.match(outcome.reason, /malformed data/);
		assert.match(outcome.reason, /fail-open/);
		assert.equal(fake.count("start_work"), 0);
	}
});

test("V4: a malformed or failing task detail read is allow-degraded", async () => {
	const malformed = new FakeConcord({
		workspace: () => ok(workspaceRoster([rosterRow({ taskId: "T2", agentId: OTHER })])),
		details: () => ok({ scope: "task", task: { taskId: "T2", status: "active" } }),
	});
	const first = degradedOf(
		await makeGuard({ bindings: [bindingA()], clients: { [A_KEY]: malformed } }).guard.preflight(
			{ path: "src/file.ts" },
			REPO_A,
			"call-1",
		),
	);
	assert.match(first.reason, /T2 returned malformed data/);
	assert.equal(malformed.count("start_work"), 0);

	const failing = new FakeConcord({
		workspace: () => ok(workspaceRoster([rosterRow({ taskId: "T2", agentId: OTHER })])),
		details: () => "error",
	});
	const second = degradedOf(
		await makeGuard({ bindings: [bindingA()], clients: { [A_KEY]: failing } }).guard.preflight(
			{ path: "src/file.ts" },
			REPO_A,
			"call-1",
		),
	);
	assert.match(second.reason, /T2 failed/);
	assert.equal(failing.count("start_work"), 0);
});

test("V4: a stale roster status is re-checked in the task detail", async () => {
	const fake = new FakeConcord({
		workspace: () => ok(workspaceRoster([rosterRow({ taskId: "T2", agentId: OTHER })])),
		details: () =>
			taskRead({ taskId: "T2", status: "complete", expectedFiles: ["src/file.ts"], agentId: OTHER }),
	});
	const { guard } = makeGuard({ bindings: [bindingA()], clients: { [A_KEY]: fake } });
	const outcome = allowedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "call-1"));
	assert.equal(outcome.notice, undefined);
});

test("V4: the current write task is excluded from the conflict scan", async () => {
	const fake = new FakeConcord({
		workspace: () => ok(workspaceRoster([rosterRow({ taskId: "MINE", agentId: SELF })])),
		details: () => taskRead({ taskId: "MINE", expectedFiles: ["src/file.ts"], agentId: SELF }),
	});
	const { guard } = makeGuard({
		bindings: [bindingA({ currentWriteTaskId: "MINE" })],
		clients: { [A_KEY]: fake },
	});
	const outcome = allowedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "call-1"));
	assert.equal(outcome.notice, undefined);
	assert.equal(fake.count("start_work"), 0, "the file is already inside the selected claim");
});

test("V4: an internal guard exception is allow-degraded, never a block", async () => {
	const deps: EditGuardDeps = {
		bindings: () => {
			throw new Error("bindings exploded");
		},
		concordFor: () => undefined,
	};
	const guard = new EditGuard(deps);
	const outcome = degradedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "call-1"));
	assert.match(outcome.reason, /internal error/);
	assert.match(outcome.reason, /fail-open/);
});

// ─── V4: auto-claim merge ────────────────────────────────────────────────────

test("V4: the intended file is merged only into active work owned by this agent", async () => {
	const fake = new FakeConcord({
		workspace: () => ok(workspaceRoster([])),
		details: () =>
			taskRead({
				taskId: "MINE",
				status: "active",
				title: "Current slice",
				expectedFiles: ["docs/readme.md"],
				agentId: SELF,
				agentKind: "build",
			}),
		startWork: () => ok(startWorkResult("MINE", { version: 7 })),
	});
	const { guard } = makeGuard({
		bindings: [bindingA({ currentWriteTaskId: "MINE" })],
		clients: { [A_KEY]: fake },
	});
	const outcome = allowedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "call-1"));
	assert.equal(outcome.autoClaimed, true);
	const starts = fake.startWorkCalls();
	assert.equal(starts.length, 1);
	assert.equal(starts[0]?.task_id, "MINE");
	assert.equal(starts[0]?.title, "Current slice");
	assert.equal(starts[0]?.kind, "build");
	assert.deepEqual(starts[0]?.expected_files, ["docs/readme.md", "src/file.ts"]);
});

test("V4: no current write task means no claim mutation", async () => {
	const fake = new FakeConcord({ workspace: () => ok(workspaceRoster([])) });
	const { guard } = makeGuard({ bindings: [bindingA()], clients: { [A_KEY]: fake } });
	const outcome = allowedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "call-1"));
	assert.equal(outcome.autoClaimed, undefined);
	assert.equal(fake.count("start_work"), 0);
});

test("V4: offered, review-ready, terminal or foreign work is never merged or accepted", async () => {
	const cases: Array<{ status: string; agentId: string | null }> = [
		{ status: "handoff_offered", agentId: SELF },
		{ status: "review_ready", agentId: SELF },
		{ status: "complete", agentId: SELF },
		{ status: "closed", agentId: SELF },
		{ status: "assigned", agentId: SELF },
		{ status: "active", agentId: OTHER },
		{ status: "active", agentId: null },
	];
	for (const scenario of cases) {
		const fake = new FakeConcord({
			workspace: () => ok(workspaceRoster([])),
			details: () =>
				taskRead({
					taskId: "MINE",
					status: scenario.status,
					expectedFiles: [],
					agentId: scenario.agentId,
				}),
			startWork: () => ok(startWorkResult("MINE")),
		});
		const { guard } = makeGuard({
			bindings: [bindingA({ currentWriteTaskId: "MINE" })],
			clients: { [A_KEY]: fake },
		});
		const outcome = degradedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "call-1"));
		assert.match(outcome.reason, /refusing to merge/);
		assert.equal(
			fake.count("start_work"),
			0,
			`start_work must not run for ${scenario.status} owned by ${String(scenario.agentId)}`,
		);
	}
});

test("V4: a new same-file overlap returned by the merge blocks like a preflight conflict", async () => {
	const fake = new FakeConcord({
		workspace: () => ok(workspaceRoster([rosterRow({ taskId: "TX", status: "active", agentId: OTHER })])),
		details: (taskId) =>
			taskId === "TX"
				? taskRead({ taskId: "TX", expectedFiles: ["docs/x.md"], agentId: OTHER })
				: taskRead({ taskId: "MINE", expectedFiles: [], agentId: SELF }),
		startWork: () =>
			ok(
				startWorkResult("MINE", {
					overlaps: [{ task_id: "TX", title: "Other work", reasons: ["same file(s): src/file.ts"] }],
				}),
			),
	});
	const { guard } = makeGuard({
		bindings: [bindingA({ currentWriteTaskId: "MINE" })],
		clients: { [A_KEY]: fake },
	});
	const outcome = blockedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "call-1"));
	assert.equal(outcome.conflicts.length, 1);
	assert.equal(outcome.conflicts[0]?.taskId, "TX");
	assert.equal(outcome.conflicts[0]?.ownerAgentId, OTHER);
	assert.deepEqual(outcome.conflicts[0]?.sharedPaths, ["src/file.ts"]);
	assert.match(outcome.reason, /TX/);
	assert.match(outcome.reason, new RegExp(OTHER));
});

test("V4: merge overlaps that are not the same file do not block", async () => {
	const fake = new FakeConcord({
		workspace: () => ok(workspaceRoster([rosterRow({ taskId: "TX", status: "active", agentId: OTHER })])),
		details: (taskId) =>
			taskId === "TX"
				? taskRead({ taskId: "TX", expectedFiles: [], agentId: OTHER })
				: taskRead({ taskId: "MINE", expectedFiles: [], agentId: SELF }),
		startWork: () =>
			ok(
				startWorkResult("MINE", {
					overlaps: [{ task_id: "TX", title: "Other", reasons: ["shared module(s): src"] }],
				}),
			),
	});
	const { guard } = makeGuard({
		bindings: [bindingA({ currentWriteTaskId: "MINE" })],
		clients: { [A_KEY]: fake },
	});
	const outcome = allowedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "call-1"));
	assert.equal(outcome.autoClaimed, true);
});

test("V4: a failed or malformed start_work result is allow-degraded, never a fake success", async () => {
	const plans: Array<() => PlanResponse> = [
		() => "error",
		() => ok(undefined),
		() => ok({ task_id: "MINE", status: "handoff_offered", resumed_by: "handoff" }),
		() => ok({ task_id: "MINE", status: "active", resumed_by: "reopen" }),
	];
	for (const startWork of plans) {
		const fake = new FakeConcord({
			workspace: () => ok(workspaceRoster([])),
			details: () => taskRead({ taskId: "MINE", expectedFiles: [], agentId: SELF }),
			startWork,
		});
		const { guard } = makeGuard({
			bindings: [bindingA({ currentWriteTaskId: "MINE" })],
			clients: { [A_KEY]: fake },
		});
		const outcome = degradedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "call-1"));
		assert.match(outcome.reason, /claim merge/);
	}
});

// ─── V4: budget and deadline ─────────────────────────────────────────────────

test("V4: budget expiry before the merge prevents start_work (no claim after the deadline)", async () => {
	const fake = new FakeConcord({
		workspace: () => ok(workspaceRoster([])),
		details: () => taskRead({ taskId: "MINE", expectedFiles: [], agentId: SELF }),
		startWork: () => ok(startWorkResult("MINE")),
	});
	const { guard } = makeGuard({
		bindings: [bindingA({ currentWriteTaskId: "MINE" })],
		clients: { [A_KEY]: fake },
		budgetMs: 0,
	});
	const outcome = degradedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "call-1"));
	assert.equal(outcome.reason, "muster: guard budget exceeded — claim check skipped");
	assert.equal(fake.count("start_work"), 0);
});

test("V4: a preflight that times out after the roster does not claim", async () => {
	const fake = new FakeConcord({
		workspace: () =>
			ok(workspaceRoster([rosterRow({ taskId: "T2", status: "active", agentId: OTHER })])),
		details: (taskId) =>
			taskId === "T2" ? "hang" : taskRead({ taskId: "MINE", expectedFiles: [], agentId: SELF }),
		startWork: () => ok(startWorkResult("MINE")),
	});
	const { guard } = makeGuard({
		bindings: [bindingA({ currentWriteTaskId: "MINE" })],
		clients: { [A_KEY]: fake },
		budgetMs: 50,
	});
	const outcome = degradedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "call-1"));
	assert.equal(outcome.reason, "muster: guard budget exceeded — claim check skipped");
	assert.ok(fake.workspaceCalls() >= 1, "the roster read happened before the deadline");
	assert.equal(fake.count("start_work"), 0);
});

test("V4: bindings are read fresh on every preflight", async () => {
	let joined: RepoBinding[] = [];
	const fake = new FakeConcord({ workspace: () => ok(workspaceRoster([])) });
	const { guard, bindingCalls } = makeGuard({
		bindings: () => joined,
		clients: { [A_KEY]: fake },
	});
	const before = await guard.preflight({ path: "src/file.ts" }, REPO_A, "call-1");
	assert.deepEqual(before, { action: "allow" });
	joined = [bindingA()];
	const after = allowedOf(await guard.preflight({ path: "src/file.ts" }, REPO_A, "call-2"));
	assert.equal(after.action, "allow");
	assert.equal(fake.workspaceCalls(), 1, "the newly joined binding is used on the next call");
	assert.equal(bindingCalls(), 2);
});
