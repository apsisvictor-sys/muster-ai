/**
 * The event-wake transport against Pi's real run lifecycle (port step C2).
 *
 * The fake-Pi harness used by the other event-wake tests reports `idle = true`
 * at `agent_end`. In a real session `agent_end` fires inside the run, while
 * `ctx.isIdle()` is still false (`_isAgentRunActive` is cleared only when the
 * run settles), so a policy that holds an event while the session is busy, as
 * Muster's does, keeps it through the `agent_end` flush. Nothing then flushes it
 * until the next tool result or input, so an idle session is never woken. A real
 * `AgentSession` with the faux provider shows it. No real provider, key or
 * network is involved.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { getEventWakeOwner } from "../event-wake.ts";

type Mode = "followUp" | "steer";

/** An extension that holds an event while the session is busy, exactly as Muster's interaction hold does, and requests one wake at the start of a run. */
function holdingExtension(mode: Mode) {
	return (pi: ExtensionAPI): void => {
		let current: ExtensionContext | undefined;
		const owner = getEventWakeOwner(pi);
		owner.setPolicy({ admit: () => current?.isIdle() !== false });
		pi.on("session_start", (_event, ctx) => {
			current = ctx;
		});
		pi.on("agent_start", (_event, ctx) => {
			current = ctx;
			owner.request({ text: "a background task finished", origin: "background", mode, dedupeKey: `background:${mode}` });
		});
	};
}

async function withRealSession(
	extension: (pi: ExtensionAPI) => void,
	check: (session: Awaited<ReturnType<typeof createAgentSession>>["session"], pending: () => number) => Promise<void>,
): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "event-wake-lifecycle-"));
	const faux = registerFauxProvider();
	faux.setResponses([fauxAssistantMessage("first run done"), fauxAssistantMessage("woken run done")]);
	const model = faux.getModel();
	try {
		const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, allowModelNetwork: false });
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((registered) => ({
				id: registered.id,
				name: registered.name,
				api: registered.api,
				reasoning: registered.reasoning,
				input: registered.input,
				inputLimits: registered.inputLimits,
				cost: registered.cost,
				contextWindow: registered.contextWindow,
				maxTokens: registered.maxTokens,
				baseUrl: registered.baseUrl,
			})),
		});
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		const resourceLoader = new DefaultResourceLoader({
			cwd: dir,
			agentDir: dir,
			settingsManager,
			extensionFactories: [extension],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			model,
			modelRuntime,
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(dir),
			noTools: "all",
		});
		try {
			await session.bindExtensions({});
			await check(session, () => faux.getPendingResponseCount());
		} finally {
			session.dispose();
		}
	} finally {
		faux.unregister();
		rmSync(dir, { recursive: true, force: true });
	}
}

async function waitUntil(condition: () => boolean, ms = 3000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return condition();
}

function assistantTexts(session: { messages: ReadonlyArray<{ role: string; content?: unknown }> }): string[] {
	return session.messages
		.filter((message) => message.role === "assistant")
		.map((message) => (Array.isArray(message.content) ? message.content.map((part) => (part as { text?: string }).text ?? "").join("") : ""));
}

for (const mode of ["followUp", "steer"] as const) {
	test(`a ${mode} event held while the run was busy wakes the idle session once the run settles`, async () => {
		await withRealSession(holdingExtension(mode), async (session, pending) => {
			await session.prompt("do the work");
			const woken = await waitUntil(() => assistantTexts(session).length === 2);
			assert.equal(woken, true, `the held event was never delivered; assistant turns: ${JSON.stringify(assistantTexts(session))}, faux responses left: ${pending()}`);
			assert.deepEqual(assistantTexts(session), ["first run done", "woken run done"]);
			const wake = session.messages.find((message) => message.role === "custom" && (message as { customType?: string }).customType === "event-wake");
			assert.ok(wake, "the wake is in the transcript as an event-wake custom message");
			assert.equal(pending(), 0);
		});
	});
}
