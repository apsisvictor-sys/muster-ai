/**
 * Delegates on the one provider list. The pool decides which workhorse model a delegate mode starts
 * on and which model it falls back to; provider-policy stays the owner of the process-local cooldown
 * that records a wall. Pure over provider-policy's state: no network, no settings writes.
 */
import { classifyFailure, type QuotaClassification } from "./quota-classifier.ts";
import { fallbackRef, accountWallKey, freshRoutingSnapshot, learnedWallsPath, loadPoolConfig, persistProviderWall, providerOf, rankLaneRoutes, routeDecisionLine, routingDecisionsTarget, startRef, wallFor, wallKey, type PoolConfig, type Wall } from "./provider-pool.ts";
import { appendFsyncedLine } from "../core/append-line.ts";
import { cooldownUntil, poolCooldown, poolKeyFor, poolWorkerRole, routeExclusionFor } from "./provider-policy.ts";
import { accountFor } from "./provider-key.ts";

/** The pool, or undefined when its file is missing or invalid: delegates then resolve as they did before. */
export function loadDelegatePool(): PoolConfig | undefined {
	const loaded = loadPoolConfig();
	return loaded.ok ? loaded.config : undefined;
}

function splitRef(ref: string): { provider: string; model: string } {
	return { provider: providerOf(ref), model: ref.slice(ref.indexOf("/") + 1) };
}

/** Walls from the pools cooling down in provider-policy: a paid ref walls its provider, a free ref only itself. */
function cooldownWalls(pool: PoolConfig, now: number): Record<string, Wall> {
	const walls: Record<string, Wall> = {};
	for (const chain of Object.values(pool.roles)) {
		for (const ref of chain) {
			const { provider, model } = splitRef(ref);
			const cooling = poolCooldown(poolKeyFor(provider, accountFor(provider), model).poolKey, now);
			if (cooling) walls[wallKey(pool, ref)] = { until: cooling.until, source: "cooldown" };
		}
	}
	return walls;
}

/**
 * Log one delegate placement (UM10, P5-D1 O1): the pool's choice for the mode plus the
 * alternatives the one rule ranked. Written here because a delegate placed through this
 * layer never reaches an extension that could log it. An unwritable log is never fatal
 * to the placement it describes.
 */
function logDelegateDecision(pool: PoolConfig, mode: string, chosen: string, by: "rule" | "failover", now: number, reason?: string): void {
	const snapshot = freshRoutingSnapshot(now);
	const walls = cooldownWalls(pool, now);
	try {
		const target = routingDecisionsTarget();
		appendFsyncedLine(target.stateDir, target.fileName, routeDecisionLine({
			at: now,
			delegate: mode,
			role: mode,
			chosen,
			by,
			candidates: rankLaneRoutes({ config: pool, candidates: pool.roles[mode] ?? [], walls, available: () => true, now, ...(snapshot ? { snapshot } : {}) }),
			...(snapshot ? { snapshotAt: snapshot.capturedAt } : {}),
			...(reason ? { reason } : {}),
		}));
	} catch {
		// A delegate that resolves is a delegate that runs.
	}
}

/** The model a delegate mode starts on, or undefined when the pool has no such role. */
export function pooledDelegateStart(mode: string, now: number = Date.now()): string | undefined {
	const pool = loadDelegatePool();
	if (!pool) return undefined;
	const snapshot = freshRoutingSnapshot(now);
	const ref = startRef(pool, mode, { now, walls: cooldownWalls(pool, now), ...(snapshot ? { snapshot } : {}) });
	if (ref !== undefined) logDelegateDecision(pool, mode, ref, "rule", now);
	return ref;
}

/**
 * Whether the pool can place `ref` right now, i.e. its provider is not sitting in a cooldown that
 * provider-policy keeps. `undefined` when there is no pool to ask, so a caller keeps its previous
 * behaviour. This is what makes an operator's own `fallbackModels` entry safe: it is honoured only
 * while the pool would use it, and falls through to the role's chain when its provider is walled.
 */
export function pooledRefUsable(ref: string, now: number = Date.now()): boolean | undefined {
	const pool = loadDelegatePool();
	if (!pool) return undefined;
	const { provider, model } = splitRef(ref);
	return poolCooldown(poolKeyFor(provider, accountFor(provider), model).poolKey, now) === undefined;
}

/**
 * The pool's fallback for the role a delegate mode fails over through, given that mode's primary.
 * The role comes from the delegate's own table, so a mode is never a pool role by assumption, and
 * `undefined` means the mode has no failover by design. The caller still applies
 * delegateFallbackRefusal.
 */
export function pooledDelegateFallback(role: string | undefined, primary: string, now: number = Date.now()): string | undefined {
	if (!role) return undefined;
	const pool = loadDelegatePool();
	if (!pool) return undefined;
	const snapshot = freshRoutingSnapshot(now);
	const ref = fallbackRef(pool, role, primary, { now, walls: cooldownWalls(pool, now), ...(snapshot ? { snapshot } : {}) });
	if (ref !== undefined) logDelegateDecision(pool, role, ref, "failover", now, `fallback from ${primary}`);
	return ref;
}

/** Next usable ref after `primary` in the role, skipping already-tried refs and current walls. */
export function nextPooledDelegateRef(role: string | undefined, primary: string, tried: ReadonlySet<string>, now: number = Date.now()): string | undefined {
	if (!role) return undefined;
	const pool = loadDelegatePool();
	return pool && fallbackRef(pool, role, primary, { now, walls: cooldownWalls(pool, now), skip: tried });
}

/**
 * Whether `message` is a wall, read by the one classifier (ROUTERFAIL): the pool's shapes first, then a status, the
 * provider's own error code or the wording. Delegates and memory extraction go through this door, so a rejected key
 * cools them exactly as it cools a lane; capacity is not a wall and is left to the request's own failover.
 */
export function poolQuotaWall(message: string, now: number = Date.now()): QuotaClassification {
	const pool = loadDelegatePool();
	if (!pool) return { quota: false };
	const failure = classifyFailure({ stopReason: "error", errorMessage: message }, pool.quotaShapes, now);
	if (!failure.wall) return { quota: false };
	return {
		quota: true,
		shapeId: failure.id ?? failure.kind,
		...(failure.resetAt !== undefined ? { resetAt: failure.resetAt } : {}),
		...(failure.assumed === true ? { assumed: true } : {}),
	};
}

/** Cool a pool after a quota wall: until the time the error names when usable, else for the pool's cooldown. */
export function recordDelegateQuotaWall(poolKey: string, message: string, now: number = Date.now(), ref?: string): void {
	const pool = loadDelegatePool();
	if (!pool) {
		cooldownUntil(poolKey, now);
		return;
	}
	const wall = poolQuotaWall(message, now);
	const lift = wallFor(wall.quota ? wall.resetAt : undefined, now, pool);
	// provider-policy keeps the later of observation + cooldown and the reset, so a known reset uses the minimum cooldown.
	cooldownUntil(poolKey, now, lift.source === "error" ? { cooldownMs: 1, resetAt: lift.until } : { cooldownMs: pool.cooldownMs });
	const key = ref ? wallKey(pool, ref) : accountWallKey(pool, providerOf(poolKey));
	persistProviderWall(key, lift.until, wall.quota ? wall.shapeId : undefined, now, learnedWallsPath());
}

/**
 * The routes a Muster worker may fall back to: the list's worker role without any route workers may not
 * use (frontier, metered). Undefined when there is no list or no worker role, so provider-policy's
 * default roster holds. A route is approved by being in the list, never by model-name similarity.
 * The roster itself is the provider list's worker role read through provider-policy
 * (`poolWorkerRole`), the one owner of that read; this seam only applies worker exclusions.
 */
export function approvedWorkerRoutes(): readonly string[] | undefined {
	return poolWorkerRole()?.filter((ref) => routeExclusionFor(ref, "worker") === undefined);
}
