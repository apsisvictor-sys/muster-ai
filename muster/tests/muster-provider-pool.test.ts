/**
 * Muster reads its worker model and its approved fallback roster from the one provider list (P3).
 * The seed no longer names a worker model; provider-policy keeps its const only as the default when no list exists.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const shipped = readFileSync(poolConfigPath(), "utf8");
const dir = mkdtempSync(join(tmpdir(), "pi-muster-pool-"));
process.env.PI_PROVIDER_POOL_PATH = join(dir, "provider-pool.json");
process.env.PI_PROVIDER_WALLS_PATH = join(dir, "provider-walls.json");
writeFileSync(process.env.PI_PROVIDER_WALLS_PATH, "{}\n");

import { approvedWorkerRoutes } from "../../routing/delegate-pool.ts";
import { resolveWorkerFallback, APPROVED_CHEAP_WORKER_ROUTES } from "../../routing/provider-policy.ts";
import { enclosingProfile } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";
import { poolConfigPath } from "../../routing/provider-pool.ts";

function writePool(roles: Record<string, string[]>): void {
	writeFileSync(process.env.PI_PROVIDER_POOL_PATH!, JSON.stringify({
		version: 1, virtualProvider: "pool", cooldownMs: 3_600_000, resetHorizonMs: 86_400_000, roles,
		quotaShapes: [{ id: "wall", match: "QUOTA_WALL" }],
	}));
}

test("the approved worker fallback roster is the list's worker role, minus routes workers may not use", () => {
	writePool({ worker: ["alpha/a", "beta/b", "native/claude-opus-5-5", "openrouter/x/y"] });
	assert.deepEqual(approvedWorkerRoutes(), ["alpha/a", "beta/b"]);
	const ok = resolveWorkerFallback("alpha/a", ["beta/b"], { approvedRoutes: approvedWorkerRoutes() });
	assert.equal(ok.kind, "route");
	const refused = resolveWorkerFallback("alpha/a", ["zai/glm-5.3-flash"], { approvedRoutes: approvedWorkerRoutes() });
	assert.equal(refused.kind, "blocked", "a route the list does not name is not approved by similarity");
});

test("without a list file or a worker role there is no roster, so provider-policy's default holds", () => {
	writeFileSync(process.env.PI_PROVIDER_POOL_PATH!, "{ not json");
	assert.equal(approvedWorkerRoutes(), undefined);
	writePool({ build: ["alpha/a", "beta/b"] });
	assert.equal(approvedWorkerRoutes(), undefined);
	assert.ok(APPROVED_CHEAP_WORKER_ROUTES.length > 0);
});

test("the shipped list's worker role is a valid roster: no Codex, no frontier, no metered route", () => {
	writeFileSync(process.env.PI_PROVIDER_POOL_PATH!, shipped);
	const roster = approvedWorkerRoutes()!;
	assert.ok(roster.length >= 2);
	for (const route of roster) assert.doesNotMatch(route, /sol|luna|astra|opus|sonnet|openrouter|anthropic/i, route);
	const worker = (JSON.parse(shipped) as { roles: { worker: string[] } }).roles.worker;
	assert.deepEqual(roster, worker, "nothing in the shipped worker role is refused");
});

test("the the CRM app seed names no worker model: the list owns it. Its parent model stays explicit", () => {
	const seed = JSON.parse(readFileSync(join(enclosingProfile(import.meta.url) ?? piAgentDir(), "docs", "muster-seeds", "muster-projects.seed.json"), "utf8")) as {
		projects: Array<{ settings?: { workerModel?: string; rotation?: { parentModel?: string } } }>;
	};
	for (const project of seed.projects) {
		assert.equal(project.settings?.workerModel, undefined);
		assert.equal(typeof project.settings?.rotation?.parentModel, "string");
	}
});

test("the live caller uses the list: the delegate fallback seam", () => {
	const delegate = readFileSync(join(piAgentDir(), "extensions", "delegate.ts"), "utf8");
	assert.match(delegate, /resolveWorkerFallback\([^)]*\{[^}]*approvedRoutes:\s*approvedWorkerRoutes\(\)/s);
});
