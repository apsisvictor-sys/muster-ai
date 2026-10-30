/**
 * Muster binding — repository/checkout routing, identity, resume/fork rules,
 * OS identity leases and connection generation (plan §5.3).
 *
 * Key rules enforced here:
 * - a repository is keyed by its canonical absolute Git common directory;
 *   linked worktrees share one Concord database and one logical file namespace;
 * - the default Pi transport id is `pi-` + 20 hex characters from the session
 *   UUID; a launcher-supplied id must match [a-z][a-z0-9_-]{0,31};
 * - a nonblocking OS flock lease guards (repoKey, agentId): a duplicate live
 *   resumed identity refuses coordination activation instead of stealing an
 *   inbox. Lease release follows the owning process; lock files are never
 *   unlinked;
 * - the connection generation increments synchronously on leave/switch/shutdown
 *   so stale callbacks cannot write into a new session;
 * - an ordinary cwd of /home/operator (or any unbound checkout) stays inert.
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { musterStateDir, piAgentDir } from "../core/pi-ports.ts";
import type { RepoBinding, SessionBinding } from "./types.ts";

const require_ = createRequire(import.meta.url);

/**
 * S10/S13: the agent folder and Muster's state root moved to
 * `lib/core/pi-ports.ts`, their one owner, where the value comes from the
 * `agentDir` port the process's start file configured. They are re-exported
 * here so the existing importers keep their path until RS2 moves the files.
 */
export { musterStateDir, piAgentDir };

export function musterSessionsDir(): string {
	return path.join(musterStateDir(), "sessions");
}

export function musterLeasesDir(): string {
	return path.join(musterStateDir(), "leases");
}

export function killFilePath(): string {
	return path.join(musterStateDir(), "muster.disabled");
}

// ─── Identity ────────────────────────────────────────────────────────────────

const AGENT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/** Validate a launcher/operator-supplied transport id. */
export function validateAgentId(candidate: string): string | undefined {
	const trimmed = (candidate ?? "").trim();
	return AGENT_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

/**
 * Why a CONCORD_AGENT_ID given to a launched lane is not usable, or undefined
 * when it is. A launch is refused with this text before the pane exists, so a
 * case slip never produces a lane that cannot join.
 */
export function agentIdLaunchProblem(raw: string): string | undefined {
	if (validateAgentId(raw) === raw) return undefined;
	const lower = raw.toLowerCase();
	if (validateAgentId(lower) === lower) {
		return `CONCORD_AGENT_ID "${raw}" is not a valid id; use "${lower}" (ids are lowercase letters, digits, - and _)`;
	}
	if (!/^[a-z]/.test(lower)) return `CONCORD_AGENT_ID "${raw}" is not a valid id: ids must start with a letter`;
	if (lower.length > 32) return `CONCORD_AGENT_ID "${raw}" is not a valid id: ids are at most 32 characters`;
	return `CONCORD_AGENT_ID "${raw}" is not a valid id: use lowercase letters, digits, - and _ only`;
}

/** Default Pi transport id: `pi-` + 20 hex characters from the session UUID. */
export function defaultAgentId(sessionId: string): string {
	const hex = createHash("sha256").update(`muster:${sessionId}`).digest("hex").slice(0, 20);
	return `pi-${hex}`;
}

/** Agent id for a session: launcher-supplied wins when valid, else the default. */
export function agentIdForSession(sessionId: string, launcherSupplied?: string): string {
	if (launcherSupplied !== undefined && launcherSupplied.trim() !== "") {
		const validated = validateAgentId(launcherSupplied);
		if (validated === undefined) {
			throw new Error(
				`muster: invalid CONCORD_AGENT_ID "${launcherSupplied}" — must match [a-z][a-z0-9_-]{0,31}`,
			);
		}
		return validated;
	}
	return defaultAgentId(sessionId);
}

// ─── Programme writer identity (plan §7 P3) ──────────────────────────────────

/**
 * The descendant-reservation owner vocabulary shared with the programme
 * control store: a persistent lane is `lane:<sessionId>` and a bounded leaf
 * delegate is `leaf:<delegateId>`. This mirrors the control bridge's
 * continuation-owner vocabulary (`"muster"` = the lane's own session,
 * `"delegate"` = a bounded leaf), so a reservation addresses the same identity
 * the admission owner already uses.
 */
export type DescendantOwnerKind = "lane" | "leaf";

const DESCENDANT_OWNER_PREFIXES: Record<DescendantOwnerKind, string> = {
	lane: "lane:",
	leaf: "leaf:",
};

/** `lane:<sessionId>` / `leaf:<delegateId>`; an empty or whitespace id is refused. */
export function descendantOwnerRef(kind: DescendantOwnerKind, id: string): string {
	const trimmed = (id ?? "").trim();
	const prefix = DESCENDANT_OWNER_PREFIXES[kind];
	if (prefix === undefined || trimmed === "" || /\s/.test(trimmed)) {
		throw new Error(`muster: a ${kind} owner requires a non-empty, whitespace-free id`);
	}
	return `${prefix}${trimmed}`;
}

/** Owner ref for a persistent lane session: `lane:<sessionId>`. */
export function laneOwnerRef(sessionRef: string): string {
	return descendantOwnerRef("lane", sessionRef);
}

/** Owner ref for a bounded leaf delegate: `leaf:<delegateId>`. */
export function leafOwnerRef(delegateId: string): string {
	return descendantOwnerRef("leaf", delegateId);
}

/** Parse the owner vocabulary; `undefined` for any other shape (fail closed). */
export function parseDescendantOwnerRef(
	ownerRef: string,
): { kind: DescendantOwnerKind; id: string } | undefined {
	const value = (ownerRef ?? "").trim();
	for (const kind of ["lane", "leaf"] as const) {
		const prefix = DESCENDANT_OWNER_PREFIXES[kind];
		if (!value.startsWith(prefix)) continue;
		const id = value.slice(prefix.length);
		return id === "" || /\s/.test(id) ? undefined : { kind, id };
	}
	return undefined;
}

/** `lane:<sessionId>` → the session ref, or `undefined` for any other owner. */
export function laneSessionRefForOwnerRef(ownerRef: string): string | undefined {
	const parsed = parseDescendantOwnerRef(ownerRef);
	return parsed?.kind === "lane" ? parsed.id : undefined;
}

/** `leaf:<delegateId>` → the delegate id, or `undefined` for any other owner. */
export function leafDelegateIdForOwnerRef(ownerRef: string): string | undefined {
	const parsed = parseDescendantOwnerRef(ownerRef);
	return parsed?.kind === "leaf" ? parsed.id : undefined;
}

/** Control-bridge continuation owners (`muster` | `delegate`) map onto the same two kinds. */
export function ownerKindForProgrammeContinuationOwner(owner: "muster" | "delegate"): DescendantOwnerKind {
	return owner === "delegate" ? "leaf" : "lane";
}

// ─── Repository routing ──────────────────────────────────────────────────────

export type RepoTopology = {
	repoKey: string;
	primaryRoot: string;
};

function runGit(args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd, timeout: 5000 }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(String(stderr || error.message).trim()));
				return;
			}
			resolve(stdout.trim());
		});
	});
}

/**
 * Canonical repository identity for an explicitly joined checkout. The key is
 * the realpath of the Git common directory; linked worktrees resolve to the
 * primary checkout's `.git`, so they share one key and one Concord store.
 */
export async function repoTopologyForCheckout(checkoutRoot: string): Promise<RepoTopology> {
	const absolute = path.resolve(checkoutRoot);
	let commonDir: string;
	try {
		commonDir = await runGit(["rev-parse", "--git-common-dir"], absolute);
	} catch (error) {
		throw new Error(`muster: ${absolute} is not inside a Git repository: ${String(error)}`);
	}
	const resolvedCommon = path.isAbsolute(commonDir)
		? commonDir
		: path.resolve(absolute, commonDir);
	let repoKey = resolvedCommon;
	try {
		// realpath via fs.realpath through node (sync) for canonical comparison.
		const fs = await import("node:fs");
		repoKey = fs.realpathSync(resolvedCommon);
	} catch {
		/* keep unresolved path */
	}
	return { repoKey, primaryRoot: normalizePrimaryRoot(repoKey) };
}

export function normalizePrimaryRoot(repoKey: string): string {
	// `.../<name>/.git` → `.../<name>`; bare repos keep their own directory.
	if (path.basename(repoKey) === ".git") {
		return path.dirname(repoKey);
	}
	return repoKey;
}

/** The Concord database for a primary root must exist before binding activates. */
export function concordDbPath(primaryRoot: string): string {
	return path.join(primaryRoot, ".concord", "concord.db");
}

export function workspaceInitialized(primaryRoot: string): boolean {
	return existsSync(concordDbPath(primaryRoot));
}

// ─── OS identity leases ──────────────────────────────────────────────────────

export type Lease = {
	release: () => Promise<void>;
	/** Child-handle evidence, not a PID-liveness guess (safe against PID reuse). */
	isHeld: () => boolean;
	/** The flock holder child pid (diagnostics). */
	holderPid: number;
};

function leaseFileName(repoKey: string, agentId: string): string {
	const hash = createHash("sha256").update(`${repoKey}::${agentId}`).digest("hex").slice(0, 24);
	return `lease-${hash}.lock`;
}

/**
 * Acquire a nonblocking flock lease for (repoKey, agentId). The holder is a
 * tiny shell that prints HELD once the lock is taken and exits when the
 * write end of its stdin closes — i.e. when this process dies — so the OS
 * releases the lease on crash or kill. The lock file itself is never unlinked.
 */
export async function acquireIdentityLease(
	repoKey: string,
	agentId: string,
): Promise<Lease> {
	const dir = musterLeasesDir();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const lockPath = path.join(dir, leaseFileName(repoKey, agentId));
	const { spawn } = require_("node:child_process") as typeof import("node:child_process");
	// flock runs `sh -c 'echo HELD; read _; exit 0'`: refusal (lock busy) exits
	// immediately with code 1; a granted lock stays alive until stdin EOF.
	const holder = spawn(
		"flock",
		["-n", lockPath, "sh", "-c", "echo HELD; read _; exit 0"],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
	const lease = await new Promise<{ pid: number; release: () => Promise<void> }>((resolve, reject) => {
		let settled = false;
		let stderr = "";
		const fail = (message: string): void => {
			if (settled) return;
			settled = true;
			try {
				holder.kill("SIGKILL");
			} catch {
				/* already gone */
			}
			reject(new Error(message));
		};
		const succeed = (): void => {
			if (settled) return;
			settled = true;
			resolve({ pid: holder.pid ?? -1, release: makeRelease(holder) });
		};
		holder.stdout?.on("data", (chunk: Buffer) => {
			if (chunk.includes("HELD")) succeed();
		});
		holder.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		holder.on("error", (error) => fail(`muster: lease holder failed to start: ${String(error)}`));
		holder.on("exit", (code) => {
			fail(
				`muster: identity ${agentId} in this repository already has a live coordination lease (${lockPath}). ` +
					`Refusing to duplicate or steal it. ${stderr.trim()}`,
			);
		});
		setTimeout(() => fail(`muster: lease acquisition timed out for ${lockPath}`), 5000).unref?.();
	});
	return {
		holderPid: lease.pid,
		release: lease.release,
		isHeld: () => holder.exitCode === null && holder.signalCode === null && !holder.killed,
	};
}

function makeRelease(holder: import("node:child_process").ChildProcess): () => Promise<void> {
	return () => {
		if (holder.exitCode !== null || holder.signalCode !== null) return Promise.resolve();
		return new Promise<void>((resolve) => {
			let settled = false;
			const finish = (): void => {
				if (settled) return;
				settled = true;
				resolve();
			};
			holder.once("exit", finish);
			// End the holder's stdin read: the shell exits, flock releases, and the
			// OS lock goes away without unlinking the lock file.
			try {
				holder.stdin?.end();
			} catch {
				/* fall through to signal */
			}
			setTimeout(() => {
				try {
					holder.kill("SIGKILL");
				} catch {
					/* already gone */
				}
			}, 1500).unref?.();
			setTimeout(finish, 3000).unref?.();
		});
	};
}

// ─── Session binding persistence ─────────────────────────────────────────────

export function newBinding(input: {
	alias: string;
	repoKey: string;
	primaryRoot: string;
	checkoutRoot: string;
	agentId: string;
	workspaceId?: string;
}): RepoBinding {
	return {
		alias: input.alias,
		repoKey: input.repoKey,
		primaryRoot: input.primaryRoot,
		checkoutRoots: [input.checkoutRoot],
		workspaceId: input.workspaceId ?? "",
		agentId: input.agentId,
		supervisedTaskIds: [],
	};
}

export function upsertBinding(
	bindingState: SessionBinding,
	next: RepoBinding,
): SessionBinding {
	const existing = bindingState.repos.find((repo) => repo.repoKey === next.repoKey);
	if (existing === undefined) {
		return { ...bindingState, repos: [...bindingState.repos, next] };
	}
	// Merge checkout roots; keep learned identity/workspace.
	const mergedRoots = [...new Set([...existing.checkoutRoots, ...next.checkoutRoots])];
	const merged: RepoBinding = {
		...existing,
		...next,
		checkoutRoots: mergedRoots,
		workspaceId: existing.workspaceId || next.workspaceId,
	};
	return {
		...bindingState,
		repos: bindingState.repos.map((repo) => (repo.repoKey === next.repoKey ? merged : repo)),
	};
}

/** Route a tool call to a binding by alias (or the single/default binding). */
export function routeBinding(
	state: SessionBinding,
	alias?: string,
): { binding: RepoBinding } | { error: string } {
	if (state.repos.length === 0) {
		return { error: "muster: no repository joined in this session" };
	}
	if (alias === undefined || alias.trim() === "") {
		const byDefault = state.defaultRepo
			? state.repos.find((repo) => repo.alias === state.defaultRepo)
			: undefined;
		const chosen = byDefault ?? (state.repos.length === 1 ? state.repos[0] : undefined);
		if (chosen === undefined) {
			return { error: `muster: multiple repositories joined; specify --repo or muster_repo` };
		}
		return { binding: chosen };
	}
	const found = state.repos.find(
		(repo) => repo.alias === alias.trim() || repo.repoKey === alias.trim(),
	);
	if (found === undefined) {
		return { error: `muster: no joined repository matches "${alias}"` };
	}
	return { binding: found };
}

/** New sessions do not inherit previous sessions' projects automatically. */
export function freshBindingState(sessionId: string): SessionBinding {
	return { schemaVersion: 1, sessionId, repos: [] };
}

/** Restore only this session's own binding state (resume keeps it, fork is fresh). */
export function bindingForResume(
	sessionId: string,
	fold: { binding?: SessionBinding } | undefined,
): SessionBinding {
	const restored = fold?.binding;
	if (restored === undefined || restored.schemaVersion !== 1) {
		return freshBindingState(sessionId);
	}
	// A stale sessionId field never happens for per-session files, but be strict.
	return { ...restored, sessionId };
}

/** Stable random id for local identity footprints (not a transport id). */
export function randomOperationId(): string {
	return randomUUID();
}
