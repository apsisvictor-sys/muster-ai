import "./muster-test-isolation.ts";
/**
 * Tests for UM9's probe (`harness/muster/bin/model-probe.mts`).
 *
 * The contract:
 *  - one bounded request with one tool, through Pi's own registry, writes
 *    exactly one `probe` signal (`pass`, or `fail` with the `classifyQuota`
 *    shape id and the latency);
 *  - a metered provider is refused and no request is made;
 *  - a model the catalog does not show as free needs a subscription snapshot
 *    row with headroom;
 *  - a request that never answers is a fail inside its own limit;
 *  - a model the live `models.json` lacks is probed from a temporary file, and
 *    the live file is never written;
 *  - `probePassedFor` is the verdict UM11 and the gateway's ask read.
 *
 * Every test injects its request port: no test touches a network or a provider.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ProbeRefusal, probePassedFor, probeVerdictFrom, prepareModelsFile, runProbe, type ProbeResponse } from "../bin/model-probe.mts";
import { dedupeKeyFor, readSignalLog } from "../signals.ts";
import type { SnapshotProvider, UsageSnapshot } from "../bin/usage-snapshot.mts";
import { harnessRoot } from "../../core/harness-paths.ts";
import { musterLauncher } from "../../core/pi-ports.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);
const LAUNCHER = musterLauncher();

async function withStateDir(run: (dir: string) => Promise<void> | void): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "model-probe-"));
	try {
		await run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** A well-formed answer: one call to the probe tool with the probe token. */
const wellFormed = (): ProbeResponse => ({
	stopReason: "toolUse",
	content: [{ type: "toolCall", name: "probe_echo", arguments: { token: "pi-probe" } }],
	latencyMs: 12,
	clientVersion: "fake 1.0",
});

const failing = (errorMessage: string): ProbeResponse => ({ stopReason: "error", errorMessage, content: [], latencyMs: 40, clientVersion: "fake 1.0" });

const row = (provider: string, usedPercent: number | undefined): SnapshotProvider => ({
	provider,
	quotaState: "observable",
	plan: null,
	quota: usedPercent === undefined ? null : { source: "http", planType: null, capturedAt: 1, ageMs: 0, primary: { usedPercent, windowMinutes: 300, resetsAt: 0 }, secondary: null },
	error: null,
	walls: [],
	reason: null,
	readerWired: true,
});

const snapshot = (providers: SnapshotProvider[]): UsageSnapshot => ({ version: 1, capturedAt: 1, providers });

test("a probe against a faux provider writes one probe signal and reads back as a pass", async () => {
	await withStateDir(async (dir) => {
		const outcome = await runProbe("opencode/big-pickle", {
			stateDir: dir,
			catalogSaysFree: () => true,
			request: async () => wellFormed(),
			detectClientVersion: async () => "fake 1.0",
		});
		assert.equal(outcome.verdict, "pass");
		assert.equal(outcome.toolCall, "probe_echo");
		assert.equal(outcome.free, true);
		assert.equal(outcome.errorClass, null);

		const log = readSignalLog(dir);
		assert.equal(log.signals.length, 1);
		const signal = log.signals[0]!;
		assert.equal(signal.kind, "probe");
		assert.equal(signal.by, "model-probe");
		assert.equal(signal.source, "local");
		assert.equal(signal.provider, "opencode");
		assert.equal(signal.modelId, "big-pickle");
		assert.equal(signal.free, true);
		assert.match(signal.text ?? "", /^pass 12ms via fake 1\.0$/);
		// The key's day is the day the run observed, so it comes from this run's own clock.
		assert.equal(signal.dedupeKey, `probe|opencode|big-pickle|pass|${signal.observedAt.slice(0, 10)}`);
		assert.equal(probePassedFor(dir, "opencode", "big-pickle"), true);
	});
});

test("a fail then a pass is two probe signals; the same result on the same day is one", async () => {
	await withStateDir(async (dir) => {
		const pass = async (): Promise<ProbeResponse> => wellFormed();
		const fail = async (): Promise<ProbeResponse> => failing("Insufficient Balance");
		const at = (instant: string, request: () => Promise<ProbeResponse>) => ({
			stateDir: dir,
			catalogSaysFree: () => true,
			request,
			detectClientVersion: async () => "fake 1.0",
			now: Date.parse(instant),
		});

		const failed = await runProbe("opencode/big-pickle", at("2026-10-17T05:00:00.000Z", fail));
		assert.equal(failed.verdict, "fail");
		// The same result again on the same UTC day is one signal.
		const failedAgain = await runProbe("opencode/big-pickle", at("2026-10-17T06:00:00.000Z", fail));
		assert.equal(failedAgain.signal.duplicate, true);
		assert.equal(failedAgain.signal.id, failed.signal.id);
		// A pass later the same day is its own signal: the key carries the result.
		const passed = await runProbe("opencode/big-pickle", at("2026-10-17T07:00:00.000Z", pass));
		assert.equal(passed.verdict, "pass");
		assert.equal(passed.signal.duplicate, false);
		assert.notEqual(passed.signal.id, failed.signal.id);
		// The next UTC day is its own key, so the same result is measurable again.
		const passedNextDay = await runProbe("opencode/big-pickle", at("2026-10-18T07:00:00.000Z", pass));
		assert.equal(passedNextDay.signal.duplicate, false);
		assert.deepEqual(
			readSignalLog(dir).signals.map((entry) => entry.dedupeKey),
			["probe|opencode|big-pickle|fail|2026-10-17", "probe|opencode|big-pickle|pass|2026-10-17", "probe|opencode|big-pickle|pass|2026-10-18"],
		);
		// The verdict the gateway and UM11 read is the newest signal's: the pass.
		assert.equal(probePassedFor(dir, "opencode", "big-pickle", { now: Date.parse("2026-10-18T08:00:00.000Z") }), true);
	});
});

test("a text that names no result keeps its own key, and the other kinds' keys are unchanged", () => {
	const at = "2026-10-17T05:00:00.000Z";
	assert.equal(dedupeKeyFor({ kind: "probe", provider: "opencode", modelId: "big-pickle", observedAt: at, text: undefined }), "probe|opencode|big-pickle|-|2026-10-17");
	assert.equal(dedupeKeyFor({ kind: "launch", provider: "acme", modelId: "new-free", url: "https://example.com/a?b=1#c", observedAt: at, text: "went free" }), "launch|acme|new-free");
	assert.equal(dedupeKeyFor({ kind: "price", provider: "acme", modelId: "new-free", url: "https://example.com/a?b=1#c", observedAt: at }), "price|acme|new-free");
	assert.equal(dedupeKeyFor({ kind: "terms", provider: "acme", url: "https://example.com/a?b=1#c", observedAt: at }), "terms|acme|https://example.com/a");
	assert.equal(dedupeKeyFor({ kind: "meter", provider: "zai", observedAt: at, text: "used_percent 40" }), "meter|zai||2026-10-17T05");
	assert.equal(dedupeKeyFor({ kind: "usage", provider: "zai", observedAt: at, text: "Walled  at  100%" }), "usage|zai|walled at 100%");
});

test("the probe refuses a metered ref and never makes a request", async () => {
	await withStateDir(async (dir) => {
		let called = false;
		await assert.rejects(
			() =>
				runProbe("openrouter/tencent/hy3:free", {
					stateDir: dir,
					catalogSaysFree: () => true,
					request: async () => {
						called = true;
						return wellFormed();
					},
				}),
			(error: unknown) => error instanceof ProbeRefusal && /metered provider/.test(error.message),
		);
		assert.equal(called, false);
		assert.equal(readSignalLog(dir).signals.length, 0);
	});
});

test("a free id needs no catalog entry; a subscription ref needs snapshot headroom", async () => {
	await withStateDir(async (dir) => {
		const request = async (): Promise<ProbeResponse> => wellFormed();
		const detect = async (): Promise<string> => "fake 1.0";

		// A `:free` id is the catalog's own word, even with no catalog read at all.
		const freeOutcome = await runProbe("command-code/inclusionai/ling-3.1-flash:free", { stateDir: dir, request, detectClientVersion: detect, snapshot: snapshot([]) });
		assert.equal(freeOutcome.verdict, "pass");
		assert.equal(freeOutcome.free, true);

		// A subscription ref with no row is refused before any request.
		let called = false;
		await assert.rejects(
			() =>
				runProbe("zai/glm-5.3-flash", {
					stateDir: dir,
					snapshot: snapshot([]),
					request: async () => {
						called = true;
						return wellFormed();
					},
				}),
			(error: unknown) => error instanceof ProbeRefusal && /does not spend/.test(error.message),
		);
		assert.equal(called, false);

		// One at 97% in a window has no headroom.
		await assert.rejects(
			() => runProbe("zai/glm-5.3-flash", { stateDir: dir, snapshot: snapshot([row("zai", 97)]), request }),
			(error: unknown) => error instanceof ProbeRefusal && /97%/.test(error.message),
		);

		// Headroom: the probe runs.
		const headroom = await runProbe("zai/glm-5.3-flash", { stateDir: dir, snapshot: snapshot([row("zai", 20)]), request, detectClientVersion: detect });
		assert.equal(headroom.verdict, "pass");
		assert.equal(headroom.free, false);
	});
});

test("a quota failure keeps the classifier's shape id and no key-shaped text", async () => {
	await withStateDir(async (dir) => {
		const outcome = await runProbe("opencode/big-pickle", {
			stateDir: dir,
			catalogSaysFree: () => true,
			request: async () => failing("Insufficient Balance for this request (Authorization: Bearer sk-abcdefgh12345678ijkl)"),
			detectClientVersion: async () => "fake 1.0",
		});
		assert.equal(outcome.verdict, "fail");
		assert.equal(outcome.errorClass, "insufficient-balance");
		const log = readSignalLog(dir);
		assert.equal(log.signals.length, 1);
		const written = JSON.stringify(log.signals[0]);
		assert.ok(!written.includes("sk-abcdefgh"), `the signal carries no key: ${written}`);
		assert.ok(!written.includes("abcdefgh12345678"), `the signal carries no key: ${written}`);
		assert.match(log.signals[0]!.text ?? "", /^fail insufficient-balance 40ms via fake 1\.0/);
		assert.equal(probePassedFor(dir, "opencode", "big-pickle"), false);
	});
});

test("a request that never answers is a fail inside its own limit", async () => {
	await withStateDir(async (dir) => {
		const outcome = await runProbe("opencode/big-pickle", {
			stateDir: dir,
			catalogSaysFree: () => true,
			timeoutMs: 30,
			request: () => new Promise<ProbeResponse>(() => undefined),
			detectClientVersion: async () => "fake 1.0",
		});
		assert.equal(outcome.verdict, "fail");
		assert.match(outcome.message ?? "", /no answer within 30 ms/);
		assert.equal(readSignalLog(dir).signals.length, 1);
	});
});

test("a model the live models.json lacks is probed from a temporary file, never the live one", async () => {
	await withStateDir((dir) => {
		const live = join(dir, "models.json");
		writeFileSync(live, JSON.stringify({ providers: { faux: { name: "Faux", baseUrl: "https://example.invalid/v1", api: "openai-completions", models: [{ id: "known" }] } } }));

		const known = prepareModelsFile({ provider: "faux", modelId: "known", modelsPath: live });
		assert.equal(known.temporary, false);
		assert.equal(known.path, live);

		const missing = prepareModelsFile({ provider: "faux", modelId: "brand-new-free", modelsPath: live });
		assert.equal(missing.temporary, true);
		assert.notEqual(missing.path, live);
		const temporary = JSON.parse(readFileSync(missing.path, "utf8")) as { providers: { faux: { models: Array<{ id: string }> } } };
		assert.deepEqual(temporary.providers.faux.models.map((model) => model.id), ["known", "brand-new-free"]);
		assert.equal((JSON.parse(readFileSync(live, "utf8")) as { providers: { faux: { models: unknown[] } } }).providers.faux.models.length, 1);
		missing.cleanup();
		assert.equal(existsSync(missing.path), false);

		assert.throws(
			() => prepareModelsFile({ provider: "absent", modelId: "x", modelsPath: live }),
			(error: unknown) => error instanceof ProbeRefusal && /does not invent a provider/.test(error.message),
		);
	});
});

test("a well-formed tool call passes, a bare answer fails", () => {
	assert.equal(probeVerdictFrom(wellFormed()).verdict, "pass");
	assert.equal(probeVerdictFrom({ stopReason: "stop", content: [{ type: "text" }], latencyMs: 5, clientVersion: "fake" }).verdict, "fail");
	assert.equal(probeVerdictFrom({ stopReason: "toolUse", content: [{ type: "toolCall", name: "probe_echo", arguments: {} }], latencyMs: 5, clientVersion: "fake" }).verdict, "fail");
	// A budget cut short is named as such, never read as "cannot call a tool".
	const truncated = probeVerdictFrom({ stopReason: "length", content: [{ type: "text" }], latencyMs: 5, clientVersion: "fake" });
	assert.equal(truncated.verdict, "fail");
	assert.equal(truncated.message, "the answer hit the token budget before a tool call");
});

test("muster probe refuses a metered ref with exit 2 and writes nothing", async () => {
	await withStateDir(async (dir) => {
		const result = spawnSync(LAUNCHER, ["probe", "openrouter/tencent/hy3:free"], {
			encoding: "utf8",
			timeout: 120_000,
			env: { ...process.env, PI_MUSTER_STATE_DIR: join(dir, "muster"), PI_MODEL_CATALOGS_PATH: join(dir, "catalogs.json"), PI_USAGE_SNAPSHOT_PATH: join(dir, "snapshot.json") },
		});
		assert.equal(result.status, 2, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
		assert.match(result.stderr, /metered provider/);
		assert.equal(existsSync(join(dir, "muster", "signals", "events.jsonl")), false);
	});
});
