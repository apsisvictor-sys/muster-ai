/**
 * Catalog watch (UM9 of
 * `plans/provider-accounts/usage-monitor-blueprint-2026-10-16.md`).
 *
 * One daily pass over the providers' own catalogs — Command Code's
 * `GET /provider/v1/models`, the OpenCode runtime list (`opencode models`,
 * read through the gateway's own reader) and OpenRouter's model list filtered
 * to its free entries — records the ids it saw in
 * `<pi-agent>/state/usage/catalogs.json` and raises one `launch` signal
 * (`source: "provider-catalog"`, writer `model-catalog`) for a model id it has
 * not seen before. The free models it finds are probed by
 * `scripts/model-probe.ts`, and the probe result is its own `probe` signal.
 *
 * Owners reused, never re-implemented:
 *   - `extensions/muster/signals.ts` — the signal store owns the id, the time,
 *     the dedupe key and the per-writer daily cap. A model Grokbot already
 *     announced carries an equal dedupe key, so the store returns that
 *     signal's id with `duplicate: true`: that is the `noted` link between the
 *     launch news and the catalog entry.
 *   - `extensions/muster/gateway/catalog.ts` `opencodeModelsReader` — the one
 *     reader of `opencode models`.
 *   - `extensions/lib/provider-key.ts` `providerApiKey` — the one owner of how
 *     a provider credential is resolved. This script never reads a key file
 *     and never prints a key.
 *   - `scripts/model-probe.ts` `runProbe` — one bounded request per free model.
 *
 * A signal is evidence. The scan writes launch signals and probes catalog-free
 * models; nothing here routes, admits, or changes configuration (the UM8 trust
 * rule), and a catalog read that fails costs only its own provider.
 *
 * First sight of a provider is a baseline, not news: with no state entry for a
 * provider the scan records its ids and writes no launch signals, so a fresh
 * machine does not dump a whole catalog into the log.
 *
 *   bin/node --import node_modules/tsx/dist/loader.mjs scripts/model-catalog-scan.ts
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { opencodeModelsReader } from "../gateway/catalog.ts";
import { execCaptured } from "../send-deps.ts";
import { musterStateDir } from "../binding.ts";
import { ASK_WRITERS, raiseAsk, readAsks, type AskWriter } from "../asks.ts";
import { providerApiKey } from "../../routing/provider-key.ts";
import { providerOf } from "../../routing/provider-pool.ts";
import { probePassedPort } from "../probe-verdict.ts";
import {
	hasFreeLaunchAsk,
	raiseFreeLaunchAskFor,
	raiseSignal,
	type RaiseSignalResult,
	type SignalAlertPorts,
} from "../signals.ts";
import { runProbe, type ProbeOutcome } from "./model-probe.mts";

/** The state file's own version: ids seen per provider, keyed by catalog. */
export const CATALOGS_STATE_VERSION = 1;
/** A catalog read that does not answer in this long costs its own provider. */
export const CATALOG_FETCH_TIMEOUT_MS = 15_000;

/** The providers whose refs the OpenCode runtime list contributes: the two surfaces the inventory holds. */
export const OPENCODE_CATALOG_PROVIDERS: readonly string[] = ["opencode", "opencode-go"];

/** A model id whose own name says it is free (`:free` or `-free`), the marker the pool's free refs carry. */
export function freeModelId(modelId: string): boolean {
	return /(?::free|-free)$/i.test(modelId.trim());
}

/** One catalog entry, always as a full `<provider>/<model id>` ref, the spelling the pool uses. */
export type CatalogModel = { ref: string; free: boolean };

/** One provider's catalog as one successful read returned it. */
export type CatalogRead = {
	provider: string;
	/** What was read, for the signal's text: `Command Code /provider/v1/models`, `opencode models`, ... */
	catalog: string;
	/** The https page a launch signal points at: the provider's own catalog listing. */
	url: string;
	models: CatalogModel[];
};

/** One catalog source: what it reads and how. `read` resolves to null when the read failed. */
export type CatalogSource = {
	provider: string;
	catalog: string;
	url: string;
	read: () => Promise<CatalogModel[] | null>;
};

/** The stored state: the last ids seen per provider, plus when the pass ran. */
export type CatalogState = {
	version: typeof CATALOGS_STATE_VERSION;
	scannedAt: string;
	providers: Record<string, { catalog: string; url: string; ids: string[]; free: string[] }>;
};

export type CatalogScan = {
	scannedAt: string;
	statePath: string;
	/** The providers whose catalog answered this pass. */
	reads: CatalogRead[];
	/** The providers whose first-ever sight was recorded without launch signals. */
	baselines: string[];
	launches: Array<{ provider: string; modelId: string; free: boolean; signal: RaiseSignalResult }>;
	/** A Grokbot launch whose model id now appears in a catalog: the store returned its id. */
	noted: Array<{ signalId: string; provider: string; modelId: string; catalog: string }>;
	/** One line per catalog that did not answer. */
	failures: string[];
};

/** Where the catalog state lives: overridable for a fixture home and for tests. */
export function catalogsPath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env["PI_MODEL_CATALOGS_PATH"]?.trim();
	return override !== undefined && override !== "" ? resolve(override) : catalogsDefaultPath();
}

/** The default state path: `<pi-agent>/state/usage/catalogs.json`, beside the snapshot. */
export function catalogsDefaultPath(): string {
	return join(homedir(), ".pi", "agent", "state", "usage", "catalogs.json");
}

/** Read the state file; a missing or unreadable file is the empty baseline, never an error. */
export function readCatalogState(path: string): CatalogState {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CatalogState>;
		if (parsed.version !== CATALOGS_STATE_VERSION || typeof parsed.providers !== "object" || parsed.providers === null) {
			return emptyCatalogState();
		}
		return { version: CATALOGS_STATE_VERSION, scannedAt: typeof parsed.scannedAt === "string" ? parsed.scannedAt : "", providers: parsed.providers };
	} catch {
		return emptyCatalogState();
	}
}

function emptyCatalogState(): CatalogState {
	return { version: CATALOGS_STATE_VERSION, scannedAt: "", providers: {} };
}

/** Write the state file the snapshot writer's way: a temp file, then a rename. */
export function writeCatalogState(path: string, state: CatalogState): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temp, JSON.stringify(state, null, 2));
		renameSync(temp, path);
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {
			// The temp file is already gone.
		}
		throw error;
	}
}

/** The ids a catalog adds, or the fact that this is the provider's first sight (a baseline). */
export function diffCatalog(previous: CatalogState, read: CatalogRead): { newModels: CatalogModel[]; baseline: boolean } {
	const known = previous.providers[read.provider];
	if (known === undefined) return { newModels: [], baseline: true };
	const seen = new Set(known.ids);
	return { newModels: read.models.filter((model) => !seen.has(model.ref)), baseline: false };
}

// ─── The sources ─────────────────────────────────────────────────────────────

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
	const response = await fetch(url, { headers, signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS) });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return (await response.json()) as unknown;
}

/** `GET /provider/v1/models` rows as refs. The route returns `id`, `name` and `context_length` (wiki `pi-agent.md`). */
export function commandCodeCatalogModels(body: unknown): CatalogModel[] {
	const rows = Array.isArray(body)
		? body
		: Array.isArray((body as { data?: unknown }).data)
			? ((body as { data: unknown[] }).data)
			: Array.isArray((body as { models?: unknown }).models)
				? ((body as { models: unknown[] }).models)
				: [];
	const models: CatalogModel[] = [];
	for (const row of rows) {
		if (row === null || typeof row !== "object") continue;
		const id = (row as { id?: unknown }).id;
		if (typeof id !== "string" || id.trim() === "") continue;
		models.push({ ref: `command-code/${id.trim()}`, free: freeModelId(id) });
	}
	return models;
}

/** `GET /provider/v1/models` on the provider's own API, with the key Pi resolves for it. */
async function readCommandCodeCatalog(): Promise<CatalogModel[] | null> {
	const key = providerApiKey("command-code");
	if (key === null) return null;
	return commandCodeCatalogModels(await fetchJson("https://api.commandcode.ai/provider/v1/models", { Authorization: `Bearer ${key}` }));
}

/** OpenRouter's public list as refs, filtered to the free entries (`:free`, or a zero prompt price). */
export function openRouterCatalogModels(body: unknown): CatalogModel[] {
	const rows = Array.isArray((body as { data?: unknown }).data) ? ((body as { data: unknown[] }).data) : [];
	const models: CatalogModel[] = [];
	for (const row of rows) {
		if (row === null || typeof row !== "object") continue;
		const record = row as { id?: unknown; pricing?: { prompt?: unknown } };
		const id = typeof record.id === "string" ? record.id.trim() : "";
		if (id === "") continue;
		const prompt = record.pricing?.prompt;
		const zeroPrice = prompt === 0 || prompt === "0" || (typeof prompt === "string" && prompt.trim() !== "" && Number(prompt) === 0);
		if (!freeModelId(id) && !zeroPrice) continue;
		models.push({ ref: `openrouter/${id}`, free: true });
	}
	return models;
}

async function readOpenRouterCatalog(): Promise<CatalogModel[] | null> {
	return openRouterCatalogModels(await fetchJson("https://openrouter.ai/api/v1/models", {}));
}

/**
 * `opencode models` output as refs, restricted to the two OpenCode surfaces the
 * inventory holds: the other providers in that runtime list have their own
 * catalogs, and a pass over them would write signals about providers nothing
 * here routes to.
 */
export function opencodeCatalogModels(output: string): CatalogModel[] {
	const models: CatalogModel[] = [];
	for (const line of output.split("\n")) {
		const ref = line.trim();
		const provider = ref.slice(0, ref.indexOf("/"));
		if (!OPENCODE_CATALOG_PROVIDERS.includes(provider)) continue;
		models.push({ ref, free: freeModelId(ref) });
	}
	return models;
}

/** The OpenCode runtime list, read through the gateway's own reader. */
function opencodeCatalogReader(bin: string): CatalogSource["read"] {
	const reader = opencodeModelsReader({ run: execCaptured, bin });
	return async () => {
		const output = await reader();
		return output === undefined ? null : opencodeCatalogModels(output);
	};
}

/** The three catalogs this pass reads: each provider's own words, nothing inferred. */
export function defaultCatalogSources(options: { opencodeBin?: string } = {}): CatalogSource[] {
	return [
		{ provider: "command-code", catalog: "Command Code /provider/v1/models", url: "https://commandcode.ai/pricing", read: readCommandCodeCatalog },
		{ provider: "opencode", catalog: "opencode models", url: "https://opencode.ai/zen", read: opencodeCatalogReader(options.opencodeBin ?? "opencode") },
		{ provider: "openrouter", catalog: "OpenRouter /api/v1/models (free entries)", url: "https://openrouter.ai/models", read: readOpenRouterCatalog },
	];
}

// ─── The pass ────────────────────────────────────────────────────────────────

/**
 * Read every catalog, record the ids, and raise one `launch` signal per model id
 * not seen before. Signals go through the store (`raiseSignal`), so the dedupe,
 * the daily cap and the alert lines stay the store's.
 */
export async function scanCatalogs(options: {
	sources?: readonly CatalogSource[];
	statePath?: string;
	stateDir: string;
	now?: number;
}): Promise<CatalogScan> {
	const nowMs = options.now ?? Date.now();
	const scannedAt = new Date(nowMs).toISOString();
	const statePath = options.statePath ?? catalogsPath();
	const previous = readCatalogState(statePath);
	const sources = options.sources ?? defaultCatalogSources();

	const settled = await Promise.allSettled(sources.map(async (source) => ({ source, models: await source.read() })));
	const reads: CatalogRead[] = [];
	const failures: string[] = [];
	for (const [index, result] of settled.entries()) {
		const source = sources[index]!;
		if (result.status === "rejected") {
			failures.push(`${source.provider}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
			continue;
		}
		const models = result.value.models;
		if (models === null) {
			failures.push(`${source.provider}: the catalog did not answer`);
			continue;
		}
		reads.push({ provider: source.provider, catalog: source.catalog, url: source.url, models });
	}

	const launches: CatalogScan["launches"] = [];
	const noted: CatalogScan["noted"] = [];
	const baselines: string[] = [];
	const nextState: CatalogState = { version: CATALOGS_STATE_VERSION, scannedAt, providers: { ...previous.providers } };

	for (const read of reads) {
		const { newModels, baseline } = diffCatalog(previous, read);
		if (baseline) baselines.push(read.provider);
		for (const model of newModels) {
			const provider = model.ref.slice(0, model.ref.indexOf("/"));
			const modelId = model.ref.slice(model.ref.indexOf("/") + 1);
			const signal = await raiseSignal(
				options.stateDir,
				"model-catalog",
				{
					kind: "launch",
					source: "provider-catalog",
					provider,
					modelId,
					free: model.free,
					url: read.url,
					observedAt: scannedAt,
					confidence: "high",
					text: `seen in ${read.catalog}`,
				},
				{ now: () => new Date(nowMs) },
			);
			launches.push({ provider, modelId, free: model.free, signal });
			// The store returns the existing signal's id with `duplicate: true` when
			// Grokbot already announced this model: that id is the noted link.
			if (signal.duplicate) noted.push({ signalId: signal.id, provider, modelId, catalog: read.catalog });
		}
		nextState.providers[read.provider] = {
			catalog: read.catalog,
			url: read.url,
			ids: read.models.map((model) => model.ref),
			free: read.models.filter((model) => model.free).map((model) => model.ref),
		};
	}

	writeCatalogState(statePath, nextState);
	return { scannedAt, statePath, reads, baselines, launches, noted, failures };
}

/**
 * The free models this pass found in the catalog and had not seen before: the
 * ones a probe is for. A model Grokbot announced first is included: the catalog
 * showing it is exactly what UM8's ask waits for.
 */
export function probeCandidates(scan: CatalogScan): Array<{ provider: string; modelId: string }> {
	const seen = new Set<string>();
	const candidates: Array<{ provider: string; modelId: string }> = [];
	for (const launch of scan.launches) {
		if (!launch.free) continue;
		const key = `${launch.provider}/${launch.modelId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		candidates.push({ provider: launch.provider, modelId: launch.modelId });
	}
	return candidates;
}

/**
 * Probe every free model this pass found, through UM9's one probe. One bounded
 * request per model, no retry and no loop over failures; a refusal (a metered
 * provider, nothing free, no headroom) is reported and the next model runs.
 */
export async function probeNewFreeModels(
	scan: CatalogScan,
	options: { stateDir: string; now?: number; probe?: typeof runProbe },
): Promise<Array<{ ref: string; outcome?: ProbeOutcome; refusal?: string }>> {
	const probe = options.probe ?? runProbe;
	const free = new Set(scan.reads.flatMap((read) => read.models.filter((model) => model.free).map((model) => model.ref)));
	const results: Array<{ ref: string; outcome?: ProbeOutcome; refusal?: string }> = [];
	for (const candidate of probeCandidates(scan)) {
		const ref = `${candidate.provider}/${candidate.modelId}`;
		try {
			const outcome = await probe(ref, {
				stateDir: options.stateDir,
				...(options.now !== undefined ? { now: options.now } : {}),
				catalogSaysFree: (provider, modelId) => free.has(`${provider}/${modelId}`),
			});
			results.push({ ref, outcome });
		} catch (error) {
			results.push({ ref, refusal: error instanceof Error ? error.message : String(error) });
		}
	}
	return results;
}

// ─── The free-launch ask ─────────────────────────────────────────────────────

/**
 * The ask writer this scan raises as (spec WP-SL3 item 5): its own, never another
 * surface's, because a raise under a name that is not its would say the wrong
 * thing about who put the item in front of the operator. Kept as a plain string so the
 * check below can ask the queue whether it knows the name yet.
 */
export const CATALOG_ASK_WRITER: string = "model-catalog";

/** Whether the queue carries this scan's writer (`asks.ts` `ASK_WRITERS`). */
export function catalogAskWriterKnown(): boolean {
	return (ASK_WRITERS as readonly string[]).includes(CATALOG_ASK_WRITER);
}

/**
 * The ports the store's free-launch ask needs, from this scan's own state: the
 * probe verdict read from the probe signals the pass just wrote (`probe-verdict.ts`
 * `probePassedPort`, the same reader the gateway hands the store) and the queue's
 * own one-ask-per-ref guard. The raise itself is passed in: the writer is the
 * caller's, the store's ask body is not.
 *
 * `now` is the guard's clock, for a test that pins the window.
 */
export function catalogAskPorts(
	stateDir: string,
	raise: NonNullable<SignalAlertPorts["raiseAsk"]>,
	now: () => Date = () => new Date(),
): SignalAlertPorts {
	return {
		probePassed: probePassedPort(stateDir),
		raiseAsk: raise,
		hasAskForModel: (ref) => hasFreeLaunchAsk(readAsks(stateDir).asks, providerOf(ref), ref.slice(ref.indexOf("/") + 1), now().getTime()),
		now,
	};
}

/**
 * One ask per free find whose probe passed, after the probes ran. The record the
 * store returned from the launch raise is what the ask is built from, whether the
 * find is the catalog's own or one Grokbot announced first (`signal.duplicate`):
 * no second read of the log, and no second ask body (SL3 F3-2). A find whose probe
 * failed, or passed on subscription headroom with `free: false`, raises nothing.
 *
 * Returns the ask codes it raised, for the pass's own output.
 */
export async function askForProbedFreeFinds(launches: CatalogScan["launches"], ports: SignalAlertPorts): Promise<string[]> {
	const asked: string[] = [];
	for (const launch of launches) {
		if (!launch.free) continue;
		const code = await raiseFreeLaunchAskFor(launch.signal.signal, ports);
		if (code !== undefined) asked.push(code);
	}
	return asked;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<number> {
	const stateDir = musterStateDir();
	const lines: string[] = [];
	const scan = await scanCatalogs({ stateDir });
	lines.push(`model catalog scan ${scan.scannedAt} -> ${scan.statePath}`);
	for (const read of scan.reads) {
		const free = read.models.filter((model) => model.free).length;
		lines.push(`  ${read.provider}: ${read.models.length} model(s), ${free} free (${read.catalog})`);
	}
	for (const failure of scan.failures) lines.push(`  review — ${failure}`);
	for (const baseline of scan.baselines) lines.push(`  ${baseline}: first sight recorded as the baseline; no launch signals`);
	for (const launch of scan.launches) {
		lines.push(
			`  launch ${launch.provider}/${launch.modelId}${launch.free ? " free" : ""} -> ${launch.signal.id}${launch.signal.duplicate ? " (already in the log)" : ""}`,
		);
	}
	for (const note of scan.noted) lines.push(`  noted ${note.signalId}: ${note.provider}/${note.modelId} now appears in ${note.catalog}`);
	const probes = await probeNewFreeModels(scan, { stateDir });
	for (const probe of probes) {
		lines.push(
			probe.outcome === undefined
				? `  probe ${probe.ref} refused: ${probe.refusal ?? "unknown"}`
				: `  probe ${probe.ref} ${probe.outcome.verdict} ${probe.outcome.latencyMs}ms via ${probe.outcome.clientVersion} -> ${probe.outcome.signal.id}`,
		);
	}
	// The free finds whose probe passed become one ask each, from the record this
	// pass raised, through the store's own ask body and this scan's writer. The
	// probes wrote their signals first, so the verdict the store reads is the one
	// that just landed.
	const asksOn = catalogAskWriterKnown();
	const asked = asksOn
		? await askForProbedFreeFinds(
				scan.launches,
				catalogAskPorts(stateDir, (ask) => raiseAsk(stateDir, { by: CATALOG_ASK_WRITER as AskWriter, source: "provider-catalog", ...ask })),
			)
		: [];
	for (const code of asked) lines.push(`  ask ${code} in the operator's queue`);
	// The writer is the queue's vocabulary (`asks.ts` `ASK_WRITERS`), not this
	// scan's to add; until it carries the name the pass reports itself off rather
	// than putting the item in front of the operator under another surface's name.
	if (!asksOn && scan.launches.some((launch) => launch.free)) {
		lines.push(`  ask pass off: the queue has no ${CATALOG_ASK_WRITER} writer yet (spec WP-SL3 item 5)`);
	}
	for (const line of lines) process.stdout.write(`${line}\n`);
	return 0;
}

/** The entry the start file runs (`scripts/model-catalog-scan.ts`). */
export function run(): void {
	void main().then(
		(code) => process.exit(code),
		(error: unknown) => {
			process.stderr.write(`model catalog scan failed: ${error instanceof Error ? error.message : String(error)}\n`);
			process.exit(1);
		},
	);
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
	run();
}
