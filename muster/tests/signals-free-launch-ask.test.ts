import "./muster-test-isolation.ts";
/**
 * Tests for the store's free-launch ask (UM11, SL3 F3-1 and F3-2).
 *
 * The contract:
 *  - a free launch whose probe passed raises exactly one `authorization` ask,
 *    whose code is `freeLaunchAskCode(provider, modelId)` and whose question
 *    carries the model's full `<provider>/<model id>` ref;
 *  - a second raise for the same ref raises nothing while the queue holds the
 *    ask, and nothing while a settled answer is inside the window;
 *  - a model id two providers share does not let one suppress the other's ask;
 *  - the port that guards the second raise is handed the ref, not the bare id;
 *  - the raise reports the signal record it wrote, and a duplicate reports the
 *    existing one, so a caller never reads the log back to ask for its find.
 *
 * Every ask here goes into a real queue in a temporary state dir: the guard is
 * the queue's own reader, not a stand-in for it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { providerOf } from "../../routing/provider-pool.ts";
import { answerAsk, raiseAsk, readAsks } from "../asks.ts";
import {
	FREE_LAUNCH_ASK_SETTLE_WINDOW_MS,
	freeLaunchAskCode,
	hasFreeLaunchAsk,
	raiseFreeLaunchAskFor,
	raiseSignal,
	type SignalAlertPorts,
} from "../signals.ts";

const T0 = "2026-10-19T06:30:00.000Z";
const CATALOG_URL = "https://example.com/catalog";

async function withStateDir(run: (dir: string) => Promise<void> | void): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "free-launch-ask-"));
	try {
		await run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** The ports the scan wires: the probe verdict stands in as `true`, the guard is the queue's own. */
function ports(dir: string, probePassed = true): SignalAlertPorts {
	return {
		probePassed: () => probePassed,
		raiseAsk: (ask) => raiseAsk(dir, { by: "orchestrator", source: "test", ...ask }),
		hasAskForModel: (ref) => hasFreeLaunchAsk(readAsks(dir).asks, providerOf(ref), ref.slice(ref.indexOf("/") + 1)),
	};
}

/** One free launch signal for `provider/model`, raised the way the catalog scan raises it. */
async function freeLaunch(dir: string, writer: "model-catalog" | "grokbot", provider: string, modelId: string) {
	return raiseSignal(dir, writer, {
		kind: "launch",
		source: "provider-catalog",
		provider,
		modelId,
		free: true,
		url: CATALOG_URL,
		observedAt: T0,
		confidence: "high",
		text: "seen in acme fixture",
		terms: { training: "no", retention: "no" },
	});
}

test("a free launch whose probe passed raises one ask that names its ref", async () => {
	await withStateDir(async (dir) => {
		const launch = await freeLaunch(dir, "model-catalog", "acme", "new-free");

		const code = await raiseFreeLaunchAskFor(launch.signal, ports(dir));
		assert.equal(code, freeLaunchAskCode("acme", "new-free"));
		const asks = readAsks(dir).asks;
		assert.equal(asks.length, 1);
		assert.equal(asks[0]!.kind, "authorization");
		assert.equal(asks[0]!.code, code);
		assert.equal(asks[0]!.raisedBy, "orchestrator");
		assert.equal(asks[0]!.link, CATALOG_URL);
		assert.match(asks[0]!.question, /acme\/new-free went free/);
		assert.match(asks[0]!.question, /training no, retention no/);
	});

	// A second raise while the queue holds the ask raises nothing.
	await withStateDir(async (dir) => {
		const launch = await freeLaunch(dir, "model-catalog", "acme", "new-free");
		await raiseFreeLaunchAskFor(launch.signal, ports(dir));
		assert.equal(await raiseFreeLaunchAskFor(launch.signal, ports(dir)), undefined);
		assert.equal(readAsks(dir).asks.length, 1);
	});

	// Henry's announcement of the same model reaches the same queue once.
	await withStateDir(async (dir) => {
		await freeLaunch(dir, "grokbot", "acme", "new-free");
		const catalog = await freeLaunch(dir, "model-catalog", "acme", "new-free");
		assert.equal(catalog.duplicate, true);
		await raiseFreeLaunchAskFor(catalog.signal, ports(dir));
		assert.equal(await raiseFreeLaunchAskFor(catalog.signal, ports(dir)), undefined);
		assert.equal(readAsks(dir).asks.length, 1);
	});
});

test("an answered ask keeps the next raise away for the window, and no longer", async () => {
	await withStateDir(async (dir) => {
		const launch = await freeLaunch(dir, "model-catalog", "acme", "new-free");
		await raiseFreeLaunchAskFor(launch.signal, ports(dir));
		const ask = readAsks(dir).asks[0]!;
		answerAsk(dir, { ref: ask.id, by: "operator-shell", ruling: "yes" });
		assert.equal(readAsks(dir).asks[0]!.status, "decided");

		// the operator's answer stands for the window: the same free find asks nothing.
		assert.equal(await raiseFreeLaunchAskFor(launch.signal, ports(dir)), undefined);
		assert.equal(readAsks(dir).asks.length, 1);

		// Past the window the next free find may ask again.
		const settledAt = Date.parse(readAsks(dir).asks[0]!.answeredAt!);
		const late = { ...ports(dir), hasAskForModel: (ref: string) => hasFreeLaunchAsk(readAsks(dir).asks, providerOf(ref), ref.slice(ref.indexOf("/") + 1), settledAt + FREE_LAUNCH_ASK_SETTLE_WINDOW_MS + 1) };
		assert.equal(await raiseFreeLaunchAskFor(launch.signal, late), freeLaunchAskCode("acme", "new-free"));
		assert.equal(readAsks(dir).asks.length, 2);
	});
});

test("a model id two providers share does not let one suppress the other's ask", async () => {
	await withStateDir(async (dir) => {
		const acme = await freeLaunch(dir, "model-catalog", "acme", "new-free");
		const other = await freeLaunch(dir, "model-catalog", "other", "new-free");
		assert.equal(await raiseFreeLaunchAskFor(acme.signal, ports(dir)), freeLaunchAskCode("acme", "new-free"));
		// Same model id, different provider: its own code, its own ask.
		assert.equal(await raiseFreeLaunchAskFor(other.signal, ports(dir)), freeLaunchAskCode("other", "new-free"));
		assert.notEqual(freeLaunchAskCode("acme", "new-free"), freeLaunchAskCode("other", "new-free"));
		const asks = readAsks(dir).asks;
		assert.equal(asks.length, 2);
		assert.match(asks[0]!.question, /acme\/new-free/);
		assert.match(asks[1]!.question, /other\/new-free/);
		// The guard knows which of the two is already asked.
		assert.equal(hasFreeLaunchAsk(asks, "acme", "new-free"), true);
		assert.equal(hasFreeLaunchAsk(asks, "other", "new-free"), true);
		assert.equal(hasFreeLaunchAsk(asks, "third", "new-free"), false);
	});
});

test("the raise hands the guard the ref and reports the record it wrote", async () => {
	await withStateDir(async (dir) => {
		const seen: string[] = [];
		const launch = await raiseSignal(
			dir,
			"model-catalog",
			{
				kind: "launch",
				source: "provider-catalog",
				provider: "acme",
				modelId: "new-free",
				free: true,
				url: CATALOG_URL,
				observedAt: T0,
				confidence: "high",
				text: "seen in acme fixture",
			},
			{
				probePassed: () => true,
				raiseAsk: () => undefined,
				hasAskForModel: (ref) => {
					seen.push(ref);
					return false;
				},
			},
		);
		assert.deepEqual(seen, ["acme/new-free"]);
		// F3-2: the caller holds the record it raised, without reading the log back.
		assert.equal(launch.signal.id, launch.id);
		assert.equal(launch.signal.kind, "launch");
		assert.equal(launch.signal.provider, "acme");
		assert.equal(launch.signal.modelId, "new-free");

		// A duplicate reports the existing record, so a find Henry announced first
		// asks from the same record.
		const again = await raiseSignal(dir, "grokbot", {
			kind: "launch",
			source: "provider-catalog",
			provider: "acme",
			modelId: "new-free",
			free: true,
			url: CATALOG_URL,
			observedAt: T0,
			confidence: "high",
			text: "acme went free",
		});
		assert.equal(again.duplicate, true);
		assert.equal(again.signal.id, launch.signal.id);
	});
});

test("no ask without a probe pass, and none for a launch that is not free", async () => {
	await withStateDir(async (dir) => {
		const launch = await freeLaunch(dir, "model-catalog", "acme", "new-free");
		assert.equal(await raiseFreeLaunchAskFor(launch.signal, ports(dir, false)), undefined);
		assert.equal(readAsks(dir).asks.length, 0);

		const paid = await raiseSignal(dir, "model-catalog", {
			kind: "launch",
			source: "provider-catalog",
			provider: "acme",
			modelId: "paid-model",
			free: false,
			url: CATALOG_URL,
			observedAt: T0,
			confidence: "high",
			text: "seen in acme fixture",
		});
		assert.equal(await raiseFreeLaunchAskFor(paid.signal, ports(dir)), undefined);
		assert.equal(readAsks(dir).asks.length, 0);

		// No ports at all is a local reader: no ask, and no error.
		assert.equal(await raiseFreeLaunchAskFor(launch.signal, {}), undefined);
	});
});
