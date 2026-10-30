/**
 * Model probe (UM9 of
 * `plans/provider-accounts/usage-monitor-blueprint-2026-10-16.md`).
 *
 * One bounded request with one tool, through the same model registry Pi uses
 * (`ModelRuntime`, the registry Pi's own sessions read: `models.json` plus
 * `auth.json`), asserting a well-formed tool call. The result is one `probe`
 * signal in the UM8 store: `pass`, or `fail` with the error class from
 * `classifyQuota` and the latency. `muster probe <provider/model>` is the verb.
 *
 * Who may be probed (UM9, and the P5-D6 ruling quoted at blueprint line 111):
 * a model the provider's own catalog shows as free (a `:free` or `-free` id, or
 * a zero price in the catalog), or a model on a subscription provider whose
 * snapshot row shows headroom. Never a metered provider: no probe spends.
 *
 * Owners reused, never re-implemented:
 *   - `extensions/muster/signals.ts` — the store owns the signal's id, time,
 *     dedupe key and daily cap (`raiseSignal`).
 *   - `extensions/muster/probe-verdict.ts` — the one reader of a probe verdict
 *     (`probePassedFor`, `probePassedPort`, `parseProbeText`), re-exported here
 *     for the callers that still name this module. It lives in Muster because
 *     Muster code (`muster pool admit`, the gateway's `signals_add`) reads it and
 *     no Muster module imports `scripts/*`.
 *   - `extensions/muster/provider-policy.ts` `poolKeyFor` — the one owner of
 *     which pool is metered; `normalizeProviderId` normalizes the provider the
 *     way the store does.
 *   - `extensions/lib/provider-pool.ts` `loadPoolConfig` — the `quotaShapes`
 *     `classifyQuota` reads.
 *   - `extensions/lib/quota-classifier.ts` `classifyQuota` — the error class.
 *   - `scripts/usage-snapshot.ts` `readUsageSnapshot` — the headroom reading.
 *
 * The probe never writes a key or a response body: a failure keeps the
 * classifier's shape id and a short, redacted message. A model that is not in
 * `models.json` is probed from a temporary models file in a throwaway
 * directory, never by editing the live file.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { classifyQuota } from "../../routing/quota-classifier.ts";
import { loadPoolConfig } from "../../routing/provider-pool.ts";
import { normalizeProviderId, poolKeyFor } from "../../routing/provider-policy.ts";
import { raiseSignal, type RaiseSignalResult } from "../signals.ts";
import { execCaptured } from "../send-deps.ts";
import { readUsageSnapshot, usageSnapshotPath, type SnapshotWindow, type UsageSnapshot } from "./usage-snapshot.mts";

// The verdict readers live in `extensions/muster/probe-verdict.ts` (see the header). Re-exported
// here so the callers and tests that name this module keep working unchanged.
export { PROBE_PASS_WINDOW_MS, parseProbeText, probePassedFor, probePassedPort } from "../probe-verdict.ts";

/** One bounded request: no retry, no loop, and this is its own limit. */
export const PROBE_TIMEOUT_MS = 20_000;
/** The one tool the request must call; a well-formed call to it is the assertion. */
export const PROBE_TOOL_NAME = "probe_echo";
export const PROBE_TOKEN = "pi-probe";
/**
 * The request's own output budget: a small request, but enough for a reasoning
 * model to finish a short thought and the one tool call. A budget cut short is
 * reported as such, never read as "the model cannot call a tool".
 */
export const PROBE_MAX_TOKENS = 512;
/** The percent a window may not reach for a subscription row to count as headroom (UM10's own step). */
export const SNAPSHOT_HEADROOM_PERCENT = 95;
export const PROBE_VERDICTS = ["pass", "fail"] as const;
export type ProbeVerdict = (typeof PROBE_VERDICTS)[number];

/** A refusal before any request: the ref is not one a probe may call. */
export class ProbeRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProbeRefusal";
	}
}

export type ProbePlan = {
	provider: string;
	modelId: string;
	free: boolean;
	clientVersion: string;
	timeoutMs: number;
};

/** What a request port returns: the answer's stop reason, its content and its latency. */
export type ProbeResponse = {
	stopReason?: string;
	errorMessage?: string;
	content: Array<{ type: string; name?: string; arguments?: unknown }>;
	latencyMs: number;
	clientVersion: string;
};

/**
 * The request port. The default builds Pi's own registry and makes the request;
 * a test injects a faux one, so no test touches the network.
 */
export type ProbeRequestPort = (plan: ProbePlan) => Promise<ProbeResponse>;

export type ProbeOutcome = {
	ref: string;
	provider: string;
	modelId: string;
	free: boolean;
	verdict: ProbeVerdict;
	/** The `classifyQuota` shape id when the provider answered with a quota error, else "error"; null on a pass. */
	errorClass: string | null;
	toolCall: string | null;
	latencyMs: number;
	clientVersion: string;
	/** The short, redacted message behind a failure, when there is one. */
	message: string | null;
	signal: RaiseSignalResult;
};

export type ProbeOptions = {
	stateDir: string;
	now?: number;
	/** The catalog's own word on free (`:free`, `-free`, or a zero price). */
	catalogSaysFree?: (provider: string, modelId: string) => boolean;
	snapshot?: UsageSnapshot;
	snapshotPath?: string;
	request?: ProbeRequestPort;
	detectClientVersion?: (provider: string) => Promise<string>;
	timeoutMs?: number;
	modelsPath?: string;
	authPath?: string;
};

/** Split one `<provider>/<model id>` ref, the pool's own spelling. */
export function splitModelRef(ref: string): { provider: string; modelId: string } | undefined {
	const trimmed = ref.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	const provider = trimmed.slice(0, slash).trim();
	const modelId = trimmed.slice(slash + 1).trim();
	if (provider === "" || modelId === "") return undefined;
	return { provider, modelId };
}

/** A window's used share, when the snapshot row carries one. */
function usedPercent(window: SnapshotWindow | null | undefined): number | undefined {
	return window === null || window === undefined || typeof window.usedPercent !== "number" ? undefined : window.usedPercent;
}

/**
 * Whether a subscription provider's snapshot row shows headroom: a usable quota
 * with every window below `SNAPSHOT_HEADROOM_PERCENT`.
 */
export function snapshotHeadroom(snapshot: UsageSnapshot, provider: string): { ok: true; capturedAt: number } | { ok: false; reason: string } {
	const row = snapshot.providers.find((candidate) => candidate.provider === provider);
	if (row === undefined) return { ok: false, reason: `the snapshot has no ${provider} row` };
	if (row.quota === null) return { ok: false, reason: `the snapshot shows no quota for ${provider}` };
	const windows = [usedPercent(row.quota.primary), usedPercent(row.quota.secondary)].filter((value): value is number => value !== undefined);
	if (windows.length === 0) return { ok: false, reason: `the snapshot shows no usable window for ${provider}` };
	const highest = Math.max(...windows);
	if (highest >= SNAPSHOT_HEADROOM_PERCENT) {
		return { ok: false, reason: `${provider} is at ${highest}% in a window (the probe calls a subscription only while it has headroom)` };
	}
	return { ok: true, capturedAt: snapshot.capturedAt };
}

/** Redact anything key-shaped: a probe's output never carries a credential. */
export function redactProbeText(text: string): string {
	return text
		.replace(/Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, "Bearer [redacted]")
		.replace(/\b(sk|pk|rk|api|key|xai|ghp|glpat)[-_][A-Za-z0-9_-]{8,}/gi, "[redacted]")
		.replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]");
}

/** One short, single-line message, capped and redacted. */
export function shortProbeMessage(message: string | undefined): string | null {
	if (message === undefined) return null;
	const line = redactProbeText(message).replace(/\s+/g, " ").trim();
	if (line === "") return null;
	return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

/** A well-formed call to the probe tool, or null. */
export function probeToolCall(content: ProbeResponse["content"]): string | null {
	for (const block of content) {
		if (block.type !== "toolCall" || block.name !== PROBE_TOOL_NAME) continue;
		const args = block.arguments;
		if (args === null || typeof args !== "object" || Array.isArray(args)) continue;
		const token = (args as { token?: unknown }).token;
		if (typeof token !== "string" || token.trim() === "") continue;
		return block.name;
	}
	return null;
}

/** The verdict one answer carries: a well-formed tool call passes, everything else fails. */
export function probeVerdictFrom(response: ProbeResponse): { verdict: ProbeVerdict; toolCall: string | null; message: string | null } {
	const message = shortProbeMessage(response.errorMessage) ?? (response.stopReason === "length" ? "the answer hit the token budget before a tool call" : null);
	if (response.stopReason === "error" || response.stopReason === "aborted") return { verdict: "fail", toolCall: null, message };
	const toolCall = probeToolCall(response.content);
	return toolCall === null ? { verdict: "fail", toolCall: null, message: message ?? "the answer carried no well-formed tool call" } : { verdict: "pass", toolCall, message: null };
}

// ─── The models file ─────────────────────────────────────────────────────────

export type PreparedModels = { path: string; temporary: boolean; cleanup: () => void };

/** The live models file this machine's Pi reads. */
export function liveModelsPath(): string {
	return join(homedir(), ".pi", "agent", "models.json");
}

/**
 * The models file one probe reads: the live one when it already holds the model,
 * otherwise a temporary copy in a throwaway directory that adds the model entry.
 * The live file is never written.
 */
export function prepareModelsFile(options: { provider: string; modelId: string; modelsPath?: string }): PreparedModels {
	const modelsPath = options.modelsPath ?? liveModelsPath();
	let live: { providers?: Record<string, unknown> } = {};
	try {
		live = JSON.parse(readFileSync(modelsPath, "utf8")) as { providers?: Record<string, unknown> };
	} catch {
		live = {};
	}
	const providers = live.providers ?? {};
	const entry = providers[options.provider];
	if (entry === null || typeof entry !== "object") {
		throw new ProbeRefusal(`${options.provider} is not in ${modelsPath}; a probe does not invent a provider`);
	}
	const models = Array.isArray((entry as { models?: unknown }).models) ? ((entry as { models: unknown[] }).models) : [];
	const present = models.some((model) => model !== null && typeof model === "object" && (model as { id?: unknown }).id === options.modelId);
	if (present) return { path: modelsPath, temporary: false, cleanup: () => undefined };
	const dir = mkdtempSync(join(tmpdir(), "pi-model-probe-"));
	const path = join(dir, "models.json");
	// The temporary entry carries the provider's own entry, a zero cost (the
	// probe bills nothing and never claims a price) and the model id.
	writeFileSync(
		path,
		JSON.stringify(
			{ providers: { ...providers, [options.provider]: { ...(entry as object), models: [...models, { id: options.modelId, name: options.modelId, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } },
			null,
			2,
		),
	);
	return { path, temporary: true, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ─── The request ─────────────────────────────────────────────────────────────

/** The client whose version governs the answer. `opencode models`' own client is a separate install. */
async function defaultClientVersion(provider: string): Promise<string> {
	if (provider !== "opencode" && provider !== "opencode-go") return "pi-ai";
	const result = await execCaptured("opencode", ["--version"], 5_000);
	const version = result.exitCode === 0 ? result.stdout.trim().split("\n")[0]?.trim() ?? "" : "";
	return version === "" ? "opencode unknown" : `opencode ${version}`;
}

/**
 * The default port: Pi's own model registry (`ModelRuntime`: `models.json` plus
 * `auth.json`), one `maxTokens`-capped request carrying the one probe tool.
 * Auth resolution, headers and provider compatibility stay the registry's.
 *
 * `sessionId` is the request's own: OpenCode's Go and Zen endpoints reject a
 * request without their `x-opencode-session` routing header (read from this
 * option), and the probe is its own one-request session.
 */
async function registryProbeRequest(plan: ProbePlan, modelsPath?: string, authPath?: string): Promise<ProbeResponse> {
	const started = Date.now();
	const prepared = prepareModelsFile({ provider: plan.provider, modelId: plan.modelId, ...(modelsPath !== undefined ? { modelsPath } : {}) });
	try {
		const [{ ModelRuntime }, { Type }] = await Promise.all([import("@earendil-works/pi-coding-agent"), import("@earendil-works/pi-ai")]);
		const runtime = await ModelRuntime.create({
			modelsPath: prepared.path,
			...(authPath !== undefined ? { authPath } : {}),
			refreshOnCreate: false,
		});
		const model = runtime.getModel(plan.provider, plan.modelId);
		const latency = (): number => Date.now() - started;
		if (model === undefined) {
			return { stopReason: "error", errorMessage: `${plan.provider}/${plan.modelId} is not in the model catalog`, content: [], latencyMs: latency(), clientVersion: plan.clientVersion };
		}
		const message = await runtime.complete(
			model,
			{
				systemPrompt: `Call the ${PROBE_TOOL_NAME} tool exactly once, with token "${PROBE_TOKEN}".`,
				messages: [{ role: "user", content: `Probe: call ${PROBE_TOOL_NAME}.`, timestamp: Date.now() }],
				tools: [{ name: PROBE_TOOL_NAME, description: "Echo the probe token back as a tool call.", parameters: Type.Object({ token: Type.String({ description: "The probe token." }) }) }],
			},
			{ maxTokens: PROBE_MAX_TOKENS, sessionId: `pi-probe-${randomUUID()}`, signal: AbortSignal.timeout(plan.timeoutMs) },
		);
		return {
			stopReason: message.stopReason,
			...(message.errorMessage !== undefined ? { errorMessage: message.errorMessage } : {}),
			content: message.content as ProbeResponse["content"],
			latencyMs: latency(),
			clientVersion: plan.clientVersion,
		};
	} finally {
		prepared.cleanup();
	}
}

/** The answer a request that never returned produces: a fail, never a hang. */
function timedOut(plan: ProbePlan): ProbeResponse {
	return { stopReason: "error", errorMessage: `no answer within ${plan.timeoutMs} ms`, content: [], latencyMs: plan.timeoutMs, clientVersion: plan.clientVersion };
}

// ─── The probe ───────────────────────────────────────────────────────────────

/**
 * Probe one model and write its `probe` signal. Throws `ProbeRefusal` before
 * any request when the model is not one a probe may call.
 */
export async function runProbe(ref: string, options: ProbeOptions): Promise<ProbeOutcome> {
	const split = splitModelRef(ref);
	if (split === undefined) throw new ProbeRefusal(`${ref} is not a <provider>/<model> ref`);
	const provider = normalizeProviderId(split.provider);
	const modelId = split.modelId.toLowerCase();
	const pool = poolKeyFor(provider, undefined, modelId);
	if (pool.quotaState === "metered") {
		throw new ProbeRefusal(`${provider} is a metered provider; a probe calls only a free model or a subscription with quota left`);
	}
	const freeByCatalog = options.catalogSaysFree?.(provider, modelId) ?? false;
	const free = /(?::free|-free)$/i.test(modelId) || freeByCatalog;
	const nowMs = options.now ?? Date.now();
	if (!free) {
		const snapshot = options.snapshot ?? readUsageSnapshot(options.snapshotPath ?? usageSnapshotPath());
		const headroom = snapshotHeadroom(snapshot, provider);
		if (headroom.ok === false) {
			throw new ProbeRefusal(`${provider}/${modelId} is not free in the catalog and ${headroom.reason}; a probe does not spend`);
		}
	}
	const clientVersion = options.detectClientVersion === undefined ? await defaultClientVersion(provider) : await options.detectClientVersion(provider);
	const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
	const plan: ProbePlan = { provider, modelId, free, clientVersion, timeoutMs };
	const request = options.request ?? ((next: ProbePlan) => registryProbeRequest(next, options.modelsPath, options.authPath));
	const response = await Promise.race([
		request(plan),
		new Promise<ProbeResponse>((resolveTimeout) => {
			const timer = setTimeout(() => resolveTimeout(timedOut(plan)), timeoutMs);
			timer.unref?.();
		}),
	]);
	const { verdict, toolCall, message } = probeVerdictFrom(response);
	const poolConfig = loadPoolConfig();
	const shapes = poolConfig.ok ? poolConfig.config.quotaShapes : [];
	const classification = classifyQuota({ stopReason: response.stopReason, errorMessage: response.errorMessage }, shapes, nowMs);
	const errorClass = verdict === "pass" ? null : classification.quota ? classification.shapeId : "error";
	const text = [verdict, ...(errorClass === null ? [] : [errorClass]), `${response.latencyMs}ms`, `via ${response.clientVersion}`, ...(message === null ? [] : [`— ${message}`])].join(" ");
	const signal = await raiseSignal(
		options.stateDir,
		"model-probe",
		{
			kind: "probe",
			source: "local",
			provider,
			modelId,
			free,
			observedAt: new Date(nowMs).toISOString(),
			confidence: "high",
			text,
		},
		{ now: () => new Date(nowMs) },
	);
	return {
		ref: `${provider}/${modelId}`,
		provider,
		modelId,
		free,
		verdict,
		errorClass,
		toolCall,
		latencyMs: response.latencyMs,
		clientVersion: response.clientVersion,
		message,
		signal,
	};
}

// The verdict readers (`parseProbeText`, `probePassedFor`, `probePassedPort`, `PROBE_PASS_WINDOW_MS`)
// moved to `extensions/muster/probe-verdict.ts` and are re-exported at the top of this file.
