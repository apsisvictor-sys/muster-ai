/**
 * A typo in provider-pool.json must fail here, not during a live failover: every ref in every role has to
 * resolve in the model registry Pi loads (the repo's models.json plus the built-in catalogs), including the
 * command-code refs whose model ids contain a slash.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { chatRoles, loadPoolConfig, poolConfigPath, type PoolConfig } from "../provider-pool.ts";
import { harnessRoot } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);

test("every ref in provider-pool.json resolves in the model registry Pi loads", async () => {
	const loaded = loadPoolConfig(poolConfigPath());
	assert.equal(loaded.ok, true);
	const pool = (loaded as { config: PoolConfig }).config;
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: join(piAgentDir(), "models.json"), allowModelNetwork: false, refreshOnCreate: false });
	const missing: string[] = [];
	// Only chat roles: a classifier-type model is not in the chat catalogue.
	for (const role of chatRoles(pool)) {
		for (const ref of pool.roles[role]) {
			const slash = ref.indexOf("/");
			if (!runtime.getModel(ref.slice(0, slash), ref.slice(slash + 1))) missing.push(`${role}: ${ref}`);
		}
	}
	assert.deepEqual(missing, [], "refs that do not resolve");
});

test("the slash-bearing command-code refs are covered by the guard", () => {
	const loaded = loadPoolConfig(poolConfigPath()) as { config: PoolConfig };
	const refs = Object.values(loaded.config.roles).flat();
	assert.ok(refs.includes("command-code/deepseek/deepseek-v4.1-flash"));
	// z.ai GLM refs left every chain on 2026-10-23 (weekly cap spent, the operator).
	assert.ok(!refs.some((r) => r.includes("glm")));
});
