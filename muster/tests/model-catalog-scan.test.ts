import "./muster-test-isolation.ts";
/**
 * Tests for UM9's catalog watch (`scripts/model-catalog-scan.ts`).
 *
 * The contract:
 *  - a model id the catalog shows for the first time becomes one `launch`
 *    signal (`source: "provider-catalog"`, writer `model-catalog`) pointing at
 *    the provider's own catalog page;
 *  - a provider's first sight is a baseline: its ids are recorded, no launch
 *    signal is written, so a fresh machine does not dump a catalog into the log;
 *  - a launch Grokbot already announced is noted (the store returns that
 *    signal's id), never duplicated;
 *  - a catalog that does not answer costs only its own provider and leaves that
 *    provider's stored ids as they were;
 *  - the three catalog readers parse the shapes they are given.
 *
 * Every test injects its catalog sources: no test touches a network.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	CATALOGS_STATE_VERSION,
	askForProbedFreeFinds,
	catalogAskPorts,
	commandCodeCatalogModels,
	freeModelId,
	opencodeCatalogModels,
	openRouterCatalogModels,
	probeCandidates,
	readCatalogState,
	scanCatalogs,
	type CatalogModel,
	type CatalogSource,
} from "../bin/model-catalog-scan.mts";
import { raiseAsk, readAsks } from "../asks.ts";
import { freeLaunchAskCode, raiseSignal, readSignalLog, type SignalAskInput } from "../signals.ts";

const T0 = "2026-10-19T06:30:00.000Z";
const T1 = "2026-10-20T06:30:00.000Z";
const CATALOG_URL = "https://example.com/catalog";

async function withStateDir(run: (dir: string) => Promise<void> | void): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "model-catalog-"));
	try {
		await run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const source = (provider: string, models: CatalogModel[]): CatalogSource => ({
	provider,
	catalog: `${provider} fixture`,
	url: CATALOG_URL,
	read: async () => models,
});

/** A state file that already knows one id of `provider`, so the pass is a diff, not a baseline. */
function seed(path: string, provider: string, ids: string[]): void {
	writeFileSync(
		path,
		JSON.stringify({ version: CATALOGS_STATE_VERSION, scannedAt: T0, providers: { [provider]: { catalog: `${provider} fixture`, url: CATALOG_URL, ids, free: [] } } }),
	);
}

test("a model id the catalog has not shown before becomes one launch signal", async () => {
	await withStateDir(async (dir) => {
		const statePath = join(dir, "catalogs.json");
		seed(statePath, "acme", ["acme/old-model"]);
		const scan = await scanCatalogs({
			stateDir: dir,
			statePath,
			now: Date.parse(T1),
			sources: [source("acme", [{ ref: "acme/old-model", free: false }, { ref: "acme/new-free", free: true }])],
		});

		assert.equal(scan.launches.length, 1);
		assert.equal(scan.launches[0]!.provider, "acme");
		assert.equal(scan.launches[0]!.modelId, "new-free");
		assert.equal(scan.launches[0]!.free, true);
		assert.equal(scan.launches[0]!.signal.duplicate, false);
		// The record the raise returns is the one the caller holds: the ask pass asks
		// from it, without reading the log back (SL3 F3-2).
		assert.equal(scan.launches[0]!.signal.signal.id, scan.launches[0]!.signal.id);
		assert.equal(scan.launches[0]!.signal.signal.kind, "launch");
		assert.equal(scan.launches[0]!.signal.signal.provider, "acme");
		assert.deepEqual(scan.noted, []);

		const log = readSignalLog(dir);
		assert.equal(log.signals.length, 1);
		const signal = log.signals[0]!;
		assert.equal(signal.kind, "launch");
		assert.equal(signal.by, "model-catalog");
		assert.equal(signal.source, "provider-catalog");
		assert.equal(signal.url, CATALOG_URL);
		assert.equal(signal.at, T1);
		assert.equal(signal.provider, "acme");
		assert.equal(signal.modelId, "new-free");
		assert.match(signal.text ?? "", /seen in acme fixture/);

		// The probe is for the free model only.
		assert.deepEqual(probeCandidates(scan), [{ provider: "acme", modelId: "new-free" }]);
		// The state file carries ids and no key-shaped string.
		const written = readFileSync(statePath, "utf8");
		assert.deepEqual(readCatalogState(statePath).providers.acme!.ids, ["acme/old-model", "acme/new-free"]);
		assert.deepEqual(readCatalogState(statePath).providers.acme!.free, ["acme/new-free"]);
		assert.doesNotMatch(written, /sk-[A-Za-z0-9]{8,}/);
	});
});

test("a provider's first sight is a baseline, not news", async () => {
	await withStateDir(async (dir) => {
		const statePath = join(dir, "catalogs.json");
		const scan = await scanCatalogs({
			stateDir: dir,
			statePath,
			now: Date.parse(T1),
			sources: [source("opencode", [{ ref: "opencode/glm-5.3-flash-free", free: true }, { ref: "opencode/big-pickle", free: false }])],
		});
		assert.deepEqual(scan.baselines, ["opencode"]);
		assert.equal(scan.launches.length, 0);
		assert.equal(readSignalLog(dir).signals.length, 0);
		assert.deepEqual(readCatalogState(statePath).providers.opencode!.ids, ["opencode/glm-5.3-flash-free", "opencode/big-pickle"]);
	});
});

test("a launch Grokbot already announced is noted, never duplicated", async () => {
	await withStateDir(async (dir) => {
		const statePath = join(dir, "catalogs.json");
		seed(statePath, "acme", ["acme/old-model"]);
		const announced = await raiseSignal(dir, "grokbot", {
			kind: "launch",
			source: "x",
			provider: "acme",
			modelId: "new-free",
			free: true,
			url: "https://x.com/acme/status/1",
			observedAt: T0,
			confidence: "medium",
			text: "acme went free",
		});

		const scan = await scanCatalogs({
			stateDir: dir,
			statePath,
			now: Date.parse(T1),
			sources: [source("acme", [{ ref: "acme/old-model", free: false }, { ref: "acme/new-free", free: true }])],
		});
		assert.equal(scan.launches.length, 1);
		assert.equal(scan.launches[0]!.signal.duplicate, true);
		// A duplicate still hands the caller the existing record, so the ask for
		// Henry's find is built from it, not from a second read of the log.
		assert.equal(scan.launches[0]!.signal.signal.id, announced.id);
		assert.deepEqual(scan.noted, [{ signalId: announced.id, provider: "acme", modelId: "new-free", catalog: "acme fixture" }]);
		// Only Grokbot's own signal is in the log, and the catalog showing the
		// model is what makes it probeable.
		assert.equal(readSignalLog(dir).signals.length, 1);
		assert.deepEqual(probeCandidates(scan), [{ provider: "acme", modelId: "new-free" }]);
	});
});

test("a catalog that does not answer costs only its own provider", async () => {
	await withStateDir(async (dir) => {
		const statePath = join(dir, "catalogs.json");
		writeFileSync(
			statePath,
			JSON.stringify({
				version: CATALOGS_STATE_VERSION,
				scannedAt: T0,
				providers: {
					acme: { catalog: "acme fixture", url: CATALOG_URL, ids: ["acme/old-model"], free: [] },
					other: { catalog: "other fixture", url: CATALOG_URL, ids: ["other/old-model"], free: [] },
				},
			}),
		);
		const failing: CatalogSource = { provider: "acme", catalog: "acme fixture", url: CATALOG_URL, read: async () => { throw new Error("HTTP 503"); } };
		const scan = await scanCatalogs({
			stateDir: dir,
			statePath,
			now: Date.parse(T1),
			sources: [failing, source("other", [{ ref: "other/old-model", free: false }, { ref: "other/one-free", free: true }])],
		});
		assert.deepEqual(scan.failures, ["acme: HTTP 503"]);
		assert.deepEqual(scan.launches.map((launch) => `${launch.provider}/${launch.modelId}`), ["other/one-free"]);
		// The failed provider's stored ids are untouched, so its next pass diffs
		// against what was last really seen.
		assert.deepEqual(readCatalogState(statePath).providers.acme!.ids, ["acme/old-model"]);
	});
});

test("a free find whose probe passed raises one ask, and the next pass raises none", async () => {
	await withStateDir(async (dir) => {
		const statePath = join(dir, "catalogs.json");
		seed(statePath, "acme", ["acme/old-model"]);
		const scan = await scanCatalogs({
			stateDir: dir,
			statePath,
			now: Date.parse(T1),
			sources: [source("acme", [{ ref: "acme/old-model", free: false }, { ref: "acme/new-free", free: true }, { ref: "acme/paid-model", free: false }])],
		});
		// The probe pass wrote its own signals: the free find passed, and the paid
		// model's probe passed on subscription headroom with `free: false`.
		await raiseSignal(dir, "model-probe", { kind: "probe", source: "local", provider: "acme", modelId: "new-free", free: true, observedAt: new Date().toISOString(), confidence: "high", text: "pass 120ms via pi-ai" });
		await raiseSignal(dir, "model-probe", { kind: "probe", source: "local", provider: "acme", modelId: "paid-model", free: false, observedAt: new Date().toISOString(), confidence: "high", text: "pass 90ms via pi-ai" });

		const raise = (ask: SignalAskInput) => raiseAsk(dir, { by: "orchestrator", source: "test", ...ask });
		assert.deepEqual(await askForProbedFreeFinds(scan.launches, catalogAskPorts(dir, raise)), [freeLaunchAskCode("acme", "new-free")]);
		const asks = readAsks(dir).asks;
		assert.equal(asks.length, 1);
		assert.equal(asks[0]!.kind, "authorization");
		assert.equal(asks[0]!.code, freeLaunchAskCode("acme", "new-free"));
		assert.match(asks[0]!.question, /acme\/new-free went free/);

		// The next pass finds the queue already holding it, and raises nothing.
		assert.deepEqual(await askForProbedFreeFinds(scan.launches, catalogAskPorts(dir, raise)), []);
		assert.equal(readAsks(dir).asks.length, 1);
	});
});

test("a failed probe raises no ask", async () => {
	await withStateDir(async (dir) => {
		const statePath = join(dir, "catalogs.json");
		seed(statePath, "acme", ["acme/old-model"]);
		const scan = await scanCatalogs({
			stateDir: dir,
			statePath,
			now: Date.parse(T1),
			sources: [source("acme", [{ ref: "acme/old-model", free: false }, { ref: "acme/new-free", free: true }])],
		});
		await raiseSignal(dir, "model-probe", { kind: "probe", source: "local", provider: "acme", modelId: "new-free", free: true, observedAt: new Date().toISOString(), confidence: "high", text: "fail quota-wall 300ms via pi-ai" });
		assert.deepEqual(await askForProbedFreeFinds(scan.launches, catalogAskPorts(dir, (ask) => raiseAsk(dir, { by: "orchestrator", source: "test", ...ask }))), []);
		assert.equal(readAsks(dir).asks.length, 0);
	});
});

test("the three catalog readers parse the shapes they are given", () => {
	assert.deepEqual(commandCodeCatalogModels({ data: [{ id: "deepseek/deepseek-v4.1-flash" }, { id: "inclusionai/ling-3.1-flash:free" }, { name: "no id" }] }), [
		{ ref: "command-code/deepseek/deepseek-v4.1-flash", free: false },
		{ ref: "command-code/inclusionai/ling-3.1-flash:free", free: true },
	]);
	assert.deepEqual(commandCodeCatalogModels([{ id: "meta/muse-spark-1.3-contributor" }]), [{ ref: "command-code/meta/muse-spark-1.3-contributor", free: false }]);

	assert.deepEqual(
		openRouterCatalogModels({
			data: [
				{ id: "tencent/hy3:free", pricing: { prompt: "0" } },
				{ id: "moonshotai/kimi-k2.6", pricing: { prompt: "0.0000003" } },
				{ id: "vendor/zero-price", pricing: { prompt: 0 } },
			],
		}),
		[
			{ ref: "openrouter/tencent/hy3:free", free: true },
			{ ref: "openrouter/vendor/zero-price", free: true },
		],
	);

	assert.deepEqual(opencodeCatalogModels(["opencode/glm-5.3-flash-free", "opencode-go/step-5-preview-free", "anthropic/claude-sonnet-5", "  ", "opencode/big-pickle"].join("\n")), [
		{ ref: "opencode/glm-5.3-flash-free", free: true },
		{ ref: "opencode-go/step-5-preview-free", free: true },
		{ ref: "opencode/big-pickle", free: false },
	]);

	assert.equal(freeModelId("opencode/glm-5.3-flash-free"), true);
	assert.equal(freeModelId("tencent/hy3:free"), true);
	assert.equal(freeModelId("zai/glm-5.3-flash"), false);
});
