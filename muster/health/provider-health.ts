/**
 * The provider health probe (brief `providerhealth-0935`; VR24-229 item 7, VR24-231).
 *
 * Tonight a Command Code key expired and an OpenCode Go subscription went inactive, and both were learned
 * by watching lanes fail one after another. Nothing test-calls a provider before or between launches, and
 * nothing tells Henry when a wall appears. This module makes one cheap real call per provider the pool
 * routes and says what each answer means.
 *
 * Owners reused, never re-implemented:
 *   - `routing/provider-pool.ts` `loadPoolConfig` — which refs exist (`roles`) and the wall wording
 *     (`quotaShapes`). This module keeps no provider list: the sweep is whatever the chains name.
 *   - `routing/quota-classifier.ts` `classifyFailure` — the one reading of a failed request (ROUTERFAIL): the pool
 *     shape it matched, an expired credential, a rejected one by status or code, an inactive plan, or capacity.
 *     This module maps its kind onto the class Henry reads; it keeps no wording, no marker list and no shape map.
 *   - Pi's `ModelRuntime` (`models.json` plus `auth.json`) — the supported request path and the one place a
 *     key is resolved. This module never reads a key, an environment variable or `auth.json`.
 *   - `bin/model-probe.mts` `splitModelRef`, `liveModelsPath`, `shortProbeMessage` — the ref split, the
 *     live models file and the one redactor (capped at 200 characters, key-shaped runs removed).
 *   - `grokbot-tell.ts` `tellGrokbot` — delivery to Henry; the CLI passes it in as a port, so the bus owns
 *     the send.
 *
 * What it costs: one request per provider per run, `maxTokens` 8, no retry, no tool call, and nothing is
 * called twice. No secret value is stored or printed: the answer's own words are redacted before they reach
 * a result, a log line or a message, and the request's headers never enter this module.
 *
 * What it remembers: `<state>/provider-health.json`, one row per provider. A wall is told once when it is
 * first seen, repeated at most once an hour while it persists, and told again once when it clears. A row is
 * written only after the message went out, so a failed send is tried again on the next run.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { classifyFailure, type FailureKind, type QuotaShape } from "../../routing/quota-classifier.ts";
import { activeWalls, learnQuotaWall, loadPoolConfig, providerOf, type PoolConfig, type Wall } from "../../routing/provider-pool.ts";
import { PROBE_TIMEOUT_MS, liveModelsPath, shortProbeMessage, splitModelRef } from "../bin/model-probe.mts";

/** What an answer can mean. `healthy` is any answer at all: a provider that replied is not a dead provider. */
export const PROVIDER_HEALTH_CLASSES = ["healthy", "credential", "entitlement", "usage-limit", "other", "walled"] as const;
export type ProviderHealthClass = (typeof PROVIDER_HEALTH_CLASSES)[number];

/**
 * The classes Henry is told about. `other` is recorded and printed, never alerted: it is not an identified wall.
 * `walled` is a provider the pool already records a wall for: it is reported and not called, and the probe does not
 * re-tell a wall another owner recorded.
 */
export const WALL_CLASSES: readonly ProviderHealthClass[] = ["credential", "entitlement", "usage-limit", "walled"];

export function isWallClass(value: ProviderHealthClass): boolean {
	return WALL_CLASSES.includes(value);
}

/**
 * Only the class name a pool shape's wall is reported under, as data the classifier is given: a credential shape
 * reads as a credential and a plan shape as an entitlement. Every other shape - `endpoint-unavailable-429` and
 * `rate-limit-try-again-later` included - is a usage limit, which is what `quotaShapes` is for. This map never
 * decides whether something is a wall: a matched shape always is one, so it always reaches the alert (F20).
 */
const SHAPE_KINDS: Readonly<Record<string, FailureKind>> = {
	"credential-rejected": "auth",
	"claude-subscription-disabled": "entitlement",
};

/**
 * The class one answer belongs to, read by the owner of that reading: a reply is healthy; a matched pool shape,
 * an expired or rejected credential, an inactive plan and a spent allowance are walls; capacity is not a wall.
 */
export function classifyProviderAnswer(ref: string, answer: ProviderAnswer, shapes: readonly QuotaShape[], now: number): ProviderHealth {
	const provider = providerOf(ref);
	const text = shortProbeMessage(answer.errorMessage);
	if (answer.outcome === "answer") return { provider, ref, class: "healthy", text: null, latencyMs: answer.latencyMs };
	const failure = classifyFailure({ stopReason: "error", errorMessage: answer.errorMessage ?? "" }, shapes, now, SHAPE_KINDS);
	if (failure.kind === "none") return { provider, ref, class: "other", text, latencyMs: answer.latencyMs };
	// The classifier's `wall` decides, not the class name: a wall is never reported as `other`, so a shape the pool
	// ships - an endpoint that is down, a spent allowance - reaches the record and the alert like any other wall.
	const klass: ProviderHealthClass = !failure.wall
		? "other"
		: failure.kind === "auth" || failure.kind === "expiry"
			? "credential"
			: failure.kind === "entitlement"
				? "entitlement"
				: "usage-limit";
	return {
		provider,
		ref,
		class: klass,
		...(failure.id === undefined ? {} : failure.source === "shape" ? { shapeId: failure.id } : { marker: failure.id }),
		...(failure.resetAt !== undefined ? { resetAt: failure.resetAt } : {}),
		text,
		latencyMs: answer.latencyMs,
	};
}

/** One cheap request per provider: a short answer, so a provider that replies is proved without spending. */
export const PROVIDER_HEALTH_MAX_TOKENS = 8;
/** One request's own limit; nothing here retries. */
export const PROVIDER_HEALTH_TIMEOUT_MS = PROBE_TIMEOUT_MS;
/** How often a wall that has not cleared is repeated to Henry. */
export const REPEAT_WALL_MS = 60 * 60 * 1000;
/** The state file, under the Muster state directory. */
export const PROVIDER_HEALTH_FILE = "provider-health.json";
/** The sender these messages go out under, the way the janitor has its own name. */
export const PROVIDER_HEALTH_SENDER = "provider-health";

// ─── What the pool routes ────────────────────────────────────────────────────

/** One provider and the one ref its test call is made against. */
export interface ProviderTarget {
	provider: string;
	ref: string;
}

/**
 * Every provider the pool routes, once, in the order the chains name them, with the first ref that names
 * it. The chains are the whole list: there is no provider table here to fall out of step with the pool. A
 * ref under the virtual provider is the pool itself, never a provider to call.
 *
 * The refs a lane can start on count as routed (`laneDefaults`): a free ref that lives only in that list is
 * still a ref a lane dies on, and a lane default's provider is swept exactly like a chain's. A value that is
 * not a `<provider>/<model>` ref (the Claude alias `sonnet`) names no provider and is skipped.
 */
export function providerTargets(config: PoolConfig): ProviderTarget[] {
	const byProvider = new Map<string, string>();
	const consider = (ref: string): void => {
		const trimmed = ref.trim();
		if (splitModelRef(trimmed) === undefined) return;
		const provider = providerOf(trimmed);
		if (provider === "" || provider === config.virtualProvider) return;
		if (!byProvider.has(provider)) byProvider.set(provider, trimmed);
	};
	for (const refs of Object.values(config.roles)) for (const ref of refs) consider(ref);
	const defaults = config.laneDefaults as { pi?: { candidates?: string[]; hard?: string[] }; opencode?: string[] } | undefined;
	for (const ref of defaults?.pi?.candidates ?? []) consider(ref);
	for (const ref of defaults?.pi?.hard ?? []) consider(ref);
	for (const ref of defaults?.opencode ?? []) consider(ref);
	return [...byProvider].map(([provider, ref]) => ({ provider, ref }));
}

// ─── The answer and what it means ────────────────────────────────────────────

/** What the request port hands back: the provider answered, or it did not and said why. */
export interface ProviderAnswer {
	/** `answer`: the provider replied, whatever it said. `error`: no reply, or a reply the client read as an error. */
	outcome: "answer" | "error";
	/** The provider's own error text, as it arrived. It is redacted before anything keeps it. */
	errorMessage?: string;
	latencyMs: number;
}

/** One provider's reading this run. */
export interface ProviderHealth {
	provider: string;
	ref: string;
	class: ProviderHealthClass;
	/** The pool shape id the answer matched, when one did. */
	shapeId?: string;
	/** When the wall lifts, read by the shape's own reset rule. */
	resetAt?: number;
	/** The marker the class came from when no pool shape matched (`http-401`, `expired-credential`, `inactive-subscription`). */
	marker?: string;
	/** The answer's own words, redacted and capped; `null` when it said nothing usable. */
	text: string | null;
	latencyMs: number;
}

/** The identity of a wall: two readings of the same wall share it, a different class or shape does not. */
export function wallKeyOf(health: ProviderHealth): string {
	return `${health.class}:${health.shapeId ?? health.marker ?? "-"}`;
}

// ─── The memory ──────────────────────────────────────────────────────────────

/** What is remembered about one provider between runs. `wallKey` is empty when the provider was not a wall. */
export interface ProviderHealthRow {
	class: ProviderHealthClass;
	wallKey: string;
	/** When this wall was first seen; `0` when the provider was not a wall. */
	firstSeenAt: number;
	/** When Henry was last told about this wall; `0` when he was not. */
	lastAlertAt: number;
}

export type ProviderHealthMemory = Record<string, ProviderHealthRow>;

export function providerHealthFile(stateDir: string): string {
	return join(stateDir, PROVIDER_HEALTH_FILE);
}

/** The rows already kept. An absent, torn or unrecognized file is no memory, never a guess. */
export function readProviderHealthMemory(stateDir: string): ProviderHealthMemory {
	try {
		const file = providerHealthFile(stateDir);
		if (!existsSync(file)) return {};
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const memory: ProviderHealthMemory = {};
		for (const [provider, raw] of Object.entries(parsed as Record<string, unknown>)) {
			if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
			const row = raw as { class?: unknown; wallKey?: unknown; firstSeenAt?: unknown; lastAlertAt?: unknown };
			if (typeof row.class !== "string" || !(PROVIDER_HEALTH_CLASSES as readonly string[]).includes(row.class)) continue;
			memory[provider] = {
				class: row.class as ProviderHealthClass,
				wallKey: typeof row.wallKey === "string" ? row.wallKey : "",
				firstSeenAt: typeof row.firstSeenAt === "number" && Number.isFinite(row.firstSeenAt) ? row.firstSeenAt : 0,
				lastAlertAt: typeof row.lastAlertAt === "number" && Number.isFinite(row.lastAlertAt) ? row.lastAlertAt : 0,
			};
		}
		return memory;
	} catch {
		return {};
	}
}

/** Replace the memory in one write, through a temporary file, so a torn write is never read as one. */
export function writeProviderHealthMemory(stateDir: string, memory: ProviderHealthMemory): void {
	const file = providerHealthFile(stateDir);
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(memory, null, 2), { mode: 0o600 });
	renameSync(tmp, file);
}

// ─── What Henry is told ──────────────────────────────────────────────────────

function stamp(at: number): string {
	return new Date(at).toISOString();
}

/** The class in one clause, with the shape or marker it came from: the evidence, not a verdict on the plan. */
export function classLabel(health: ProviderHealth): string {
	const source = health.shapeId !== undefined ? `shape "${health.shapeId}"` : health.marker !== undefined ? `marker "${health.marker}"` : "no shape";
	switch (health.class) {
		case "credential":
			return `a rejected credential (${source}): the provider will not accept its key`;
		case "entitlement":
			return `no active subscription or entitlement (${source}): the plan it runs on is not active`;
		case "usage-limit":
			return `a usage limit (${source})${health.resetAt === undefined ? "" : `, resetting ${stamp(health.resetAt)}`}`;
		case "other":
			return `an unclassified error (${source})`;
		case "healthy":
			return "a healthy answer";
	}
}

/** One message: the provider, the shape it matched, the provider's own words, and when it was first seen. */
export function providerWallText(health: ProviderHealth, firstSeenAt: number, repeat: boolean): string {
	const words = health.text === null ? "the provider's answer carried no text" : `the provider's own words: "${health.text}"`;
	const head = repeat
		? `Provider ${health.provider} still answers a test call (${health.ref}) with ${classLabel(health)}.`
		: `Provider ${health.provider} answers a test call (${health.ref}) with ${classLabel(health)}.`;
	const tail = repeat
		? `First seen ${stamp(firstSeenAt)}; nothing has cleared it, and lanes routed to it will fail on it.`
		: `First seen ${stamp(firstSeenAt)}. Lanes routed to it will fail on it. Nothing was restarted and nothing was disabled.`;
	return `${head} ${words.charAt(0).toUpperCase()}${words.slice(1)}. ${tail}`;
}

export function providerClearedText(health: ProviderHealth, clearedWall: string, since: number): string {
	const kind = clearedWall.split(":")[0];
	return `Provider ${health.provider} answers a test call (${health.ref}) again. The ${kind === "walled" ? "recorded" : kind} wall first seen ${stamp(since)} is over.`;
}

/** The bus's idempotency key: one per provider, wall and first sighting, so a repeat is never a second message. */
export function providerAlertKey(provider: string, wallKey: string, firstSeenAt: number): string {
	return `${PROVIDER_HEALTH_SENDER}:${provider}:${wallKey}:${firstSeenAt}`;
}

// ─── The pass ────────────────────────────────────────────────────────────────

/** What the pass reads and does; the CLI passes the live ports, a test passes fakes and an injected clock. */
export interface ProviderHealthPorts {
	now(): number;
	/** Where the memory file lives; the pass writes nothing outside it. */
	stateDir(): string;
	targets(): ProviderTarget[];
	shapes(): readonly QuotaShape[];
	/** The walls in force, keyed as the pool keys them; a provider in here is reported, never called. */
	walls(): Record<string, Wall>;
	probe(ref: string): Promise<ProviderAnswer>;
	/**
	 * Record a wall the sweep found, through the pool's own owner (`learnQuotaWall`), so the next launch's ranking
	 * skips the ref and falls to the next one the pool offers. The shape id is the pool's, never a wording of ours.
	 */
	learnWall(ref: string, shapeId: string, resetAt: number | undefined): void;
	/** One message to Henry. */
	tellHenry(text: string, key: string): void;
}

export type ProviderHealthAction = "alert" | "repeat" | "cleared" | "none" | "alert-failed";

export interface ProviderHealthResult extends ProviderHealth {
	action: ProviderHealthAction;
	/** Why a send failed, when it did; never a secret. */
	failure?: string;
	/** The wall or the reason a ref was not called, in the pool's own words. */
	note?: string;
}

/**
 * Sweep every provider the pool routes, once each, and tell Henry about the walls. A wall is alerted when
 * its class or shape is new for that provider, repeated after `REPEAT_WALL_MS`, and told once when it
 * clears. `other` is recorded and returned, never alerted: it is not an identified wall.
 */
export async function providerHealthPass(ports: ProviderHealthPorts, options: { dryRun?: boolean } = {}): Promise<ProviderHealthResult[]> {
	const now = ports.now();
	const shapes = ports.shapes();
	const stateDir = ports.stateDir();
	const walls = ports.walls();
	const targets = ports.targets();
	const memory = readProviderHealthMemory(stateDir);
	const next: ProviderHealthMemory = { ...memory };
	const results: ProviderHealthResult[] = [];
	for (const target of targets) {
		const previous = memory[target.provider];
		// A ref whose wall is in force is not called: the wall is the answer, and a call into it spends for nothing.
		// The pool keys a free ref's wall by its full ref when `freeRefs` carries it, and by its provider otherwise.
		const known = walls[target.ref] ?? walls[target.provider];
		if (known !== undefined && known.until > now) {
			const note = `the pool records a wall until ${stamp(known.until)} (${known.source ?? "config"})${known.reason === undefined ? "" : `: ${known.reason}`}, so it was not called`;
			next[target.provider] = {
				class: "walled",
				wallKey: `walled:${known.reason ?? known.source ?? "-"}`,
				firstSeenAt: previous?.firstSeenAt ?? 0,
				lastAlertAt: previous?.lastAlertAt ?? 0,
			};
			results.push({ provider: target.provider, ref: target.ref, class: "walled", resetAt: known.until, text: known.reason ?? null, latencyMs: 0, action: "none", note });
			continue;
		}
		const health = classifyProviderAnswer(target.ref, await ports.probe(target.ref), shapes, now);
		// A wall the classifier words is recorded where the launcher reads it, under the pool's own shape id or the
		// classifier's own id, so the next launch's ranking skips this ref and the pool's order falls to the next ref a
		// lane may run on. Capacity is not a wall, so it is left to the request's own failover.
		const wallId = health.shapeId ?? health.marker;
		if (!options.dryRun && health.class !== "healthy" && health.class !== "other" && wallId !== undefined) {
			try {
				ports.learnWall(target.ref, wallId, health.resetAt);
			} catch {
				// A wall that cannot be written is still a wall: the alert below is what Henry reads.
			}
		}
		const wall = isWallClass(health.class);
		if (wall) {
			const key = wallKeyOf(health);
			const sameWall = previous !== undefined && previous.wallKey === key && isWallClass(previous.class);
			const firstSeenAt = sameWall ? previous.firstSeenAt : now;
			const repeat = sameWall && now - previous.lastAlertAt >= REPEAT_WALL_MS;
			if (!sameWall || repeat) {
				const action: ProviderHealthAction = repeat ? "repeat" : "alert";
				const text = providerWallText(health, firstSeenAt, repeat);
				const idempotencyKey = providerAlertKey(target.provider, key, firstSeenAt);
				if (options.dryRun === true) {
					results.push({ ...health, action });
					continue;
				}
				try {
					ports.tellHenry(text, idempotencyKey);
					next[target.provider] = { class: health.class, wallKey: key, firstSeenAt, lastAlertAt: now };
					results.push({ ...health, action });
				} catch (error) {
					// The row stays as it was, so the next run tries the same wall again instead of calling it told.
					results.push({ ...health, action: "alert-failed", failure: error instanceof Error ? error.message : String(error) });
				}
				continue;
			}
			next[target.provider] = { ...previous, class: health.class, wallKey: key };
			results.push({ ...health, action: "none" });
			continue;
		}
		if (previous !== undefined && isWallClass(previous.class) && previous.lastAlertAt > 0) {
			if (options.dryRun === true) {
				results.push({ ...health, action: "cleared" });
				continue;
			}
			try {
				ports.tellHenry(
					providerClearedText(health, previous.wallKey, previous.firstSeenAt),
					providerAlertKey(target.provider, `cleared:${previous.wallKey}`, previous.firstSeenAt),
				);
				next[target.provider] = { class: health.class, wallKey: "", firstSeenAt: 0, lastAlertAt: 0 };
				results.push({ ...health, action: "cleared" });
			} catch (error) {
				results.push({ ...health, action: "alert-failed", failure: error instanceof Error ? error.message : String(error) });
			}
			continue;
		}
		next[target.provider] = { class: health.class, wallKey: "", firstSeenAt: 0, lastAlertAt: previous?.lastAlertAt ?? 0 };
		results.push({ ...health, action: "none" });
	}
	// A provider the pool records a wall for and no chain routes is still a wall to report: Command Code was disabled by
	// the vendor and removed from every chain (Henry, 2026-10-29), so a sweep that only walked the chains would forget it.
	// It is not called — the pool's own wall is the answer — and nothing is re-told about it.
	for (const [key, wall] of Object.entries(walls)) {
		if (wall.until <= now) continue;
		if (!/^[a-z0-9][a-z0-9._-]*$/.test(key)) continue;
		if (targets.some((target) => target.provider === key)) continue;
		results.push({
			provider: key,
			ref: "",
			class: "walled",
			resetAt: wall.until,
			text: wall.reason ?? null,
			latencyMs: 0,
			action: "none",
			note: `the pool records a wall until ${stamp(wall.until)} (${wall.source ?? "config"})${wall.reason === undefined ? "" : `: ${wall.reason}`} and no chain routes it, so it was not called`,
		});
	}
	if (options.dryRun !== true) writeProviderHealthMemory(stateDir, next);
	return results;
}

/** The memory row for a provider, or nothing; kept out of the loop so a skipped ref reads the row it had. */

// ─── The request: the supported path ────────────────────────────────────────

/**
 * One cheap real call through Pi's own model registry: `models.json` for the provider and its base URL,
 * `auth.json` plus the environment for the key, one `maxTokens`-capped request and no tool. Auth, headers
 * and provider compatibility stay the registry's, exactly as they are for `muster probe`.
 */
export async function registryProviderAnswer(ref: string, timeoutMs: number = PROVIDER_HEALTH_TIMEOUT_MS): Promise<ProviderAnswer> {
	const started = Date.now();
	const split = splitModelRef(ref);
	if (split === undefined) return { outcome: "error", errorMessage: `${ref} is not a <provider>/<model> ref`, latencyMs: Date.now() - started };
	try {
		const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
		const runtime = await ModelRuntime.create({ modelsPath: liveModelsPath(), refreshOnCreate: false });
		const model = runtime.getModel(split.provider, split.modelId);
		if (model === undefined) return { outcome: "error", errorMessage: `${split.provider}/${split.modelId} is not in the model catalog`, latencyMs: Date.now() - started };
		const message = await runtime.complete(
			model,
			{ messages: [{ role: "user", content: "ping", timestamp: Date.now() }] },
			{ maxTokens: PROVIDER_HEALTH_MAX_TOKENS, sessionId: `pi-provider-health-${randomUUID()}`, signal: AbortSignal.timeout(timeoutMs) },
		);
		const latencyMs = Date.now() - started;
		if (message.stopReason === "error") return { outcome: "error", ...(message.errorMessage !== undefined ? { errorMessage: message.errorMessage } : {}), latencyMs };
		return { outcome: "answer", latencyMs };
	} catch (error) {
		return { outcome: "error", errorMessage: error instanceof Error ? error.message : String(error), latencyMs: Date.now() - started };
	}
}

/** The live ports, from the pool and the machine: what `muster provider check` runs. */
export function liveProviderHealthPorts(
	options: { stateDir: string; tellHenry: (text: string, key: string) => void; poolPath?: string; request?: (ref: string) => Promise<ProviderAnswer> },
): ProviderHealthPorts {
	const loaded = options.poolPath === undefined ? loadPoolConfig() : loadPoolConfig(options.poolPath);
	if (!loaded.ok) throw new Error(`the provider pool did not load: ${loaded.errors.join("; ")}`);
	const config = loaded.config;
	const request = options.request ?? ((ref: string) => registryProviderAnswer(ref));
	return {
		now: () => Date.now(),
		stateDir: () => options.stateDir,
		targets: () => providerTargets(config),
		shapes: () => config.quotaShapes,
		walls: () => activeWalls(config, undefined, Date.now()),
		learnWall: (ref, shapeId, resetAt) => learnQuotaWall(config, ref, resetAt === undefined ? { shapeId } : { shapeId, resetAt }, Date.now()),
		probe: request,
		tellHenry: options.tellHenry,
	};
}
