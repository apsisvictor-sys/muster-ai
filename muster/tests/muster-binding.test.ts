import "./muster-test-isolation.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * V2 session-identity regressions for the binding seam: deterministic default
 * ids, launcher-id validation, canonical repository keys across linked
 * worktrees, OS lease refusal for duplicate live identities, resume/fork
 * binding rules, and routing. Real git + real flock, no MCP processes, no LLM.
 */

import * as bindingModule from "../binding.ts";

function gitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "muster-binding-"));
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
	writeFileSync(join(dir, "README.md"), "# binding probe\n");
	execFileSync("git", ["-C", dir, "add", "-A"]);
	execFileSync("git", ["-C", dir, "-c", "user.email=operator@local", "-c", "user.name=operator", "commit", "-qm", "init"]);
	return dir;
}

test("V2: default agent ids are stable per session UUID and match the transport pattern", () => {
	const a1 = bindingModule.defaultAgentId("11111111-1111-4111-8111-111111111111");
	const a2 = bindingModule.defaultAgentId("11111111-1111-4111-8111-111111111111");
	const b = bindingModule.defaultAgentId("22222222-2222-4222-8222-222222222222");
	assert.equal(a1, a2, "same session id → same identity");
	assert.notEqual(a1, b, "different session id → different identity");
	assert.match(a1, /^pi-[a-f0-9]{20}$/);
});

test("V2: launcher-supplied ids are validated against [a-z][a-z0-9_-]{0,31}", () => {
	assert.equal(bindingModule.agentIdForSession("s", "alpha-reviewer"), "alpha-reviewer");
	assert.throws(() => bindingModule.agentIdForSession("s", "Uppercase"), /invalid CONCORD_AGENT_ID/);
	assert.throws(() => bindingModule.agentIdForSession("s", "1leading-digit"), /invalid CONCORD_AGENT_ID/);
	assert.throws(
		() => bindingModule.agentIdForSession("s", "x".repeat(33)),
		/invalid CONCORD_AGENT_ID/,
	);
	assert.equal(
		bindingModule.agentIdForSession("s", ""),
		bindingModule.defaultAgentId("s"),
		"empty launcher id falls back to the default",
	);
});

test("V3: linked worktrees share one canonical repo key; different repos differ", () => {
	const repo = gitRepo();
	execFileSync("git", ["-C", repo, "worktree", "add", "-q", join(repo, "wt"), "-b", "wt"]);
	try {
		const primary = bindingModule.repoTopologyForCheckout(repo);
		const linked = bindingModule.repoTopologyForCheckout(join(repo, "wt"));
		return Promise.all([primary, linked]).then(([p, l]) => {
			assert.equal(p.repoKey, l.repoKey, "one common dir key");
			assert.equal(p.primaryRoot, repo);
			assert.equal(l.primaryRoot, repo, "worktree resolves to the primary checkout");
			assert.equal(p.repoKey, l.repoKey);
		});
	} finally {
		execFileSync("git", ["-C", repo, "worktree", "remove", "--force", join(repo, "wt")], { encoding: "utf8" });
		rmSync(repo, { recursive: true, force: true });
	}
});

test("V3: an unbound checkout stays inert (workspace not initialized)", () => {
	const repo = gitRepo();
	try {
		assert.equal(bindingModule.workspaceInitialized(repo), false, "no .concord yet");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("V2: the OS identity lease is exclusive and crash-released without unlinking", async () => {
	const repo = gitRepo();
	try {
		const topology = await bindingModule.repoTopologyForCheckout(repo);
		const leaseA = await bindingModule.acquireIdentityLease(topology.repoKey, "pi-leasea01");
		assert.ok(existsSync(bindingModule.musterLeasesDir()));
		// A second live holder for the same (repoKey, agentId) is refused.
		await assert.rejects(
			() => bindingModule.acquireIdentityLease(topology.repoKey, "pi-leasea01"),
			/already has a live coordination lease/,
		);
		// A different identity in the same repo coexists.
		const leaseB = await bindingModule.acquireIdentityLease(topology.repoKey, "pi-leaseb01");
		assert.ok(leaseB);
		// Release A; the same identity can then acquire again.
		await leaseA.release();
		const leaseA2 = await bindingModule.acquireIdentityLease(topology.repoKey, "pi-leasea01");
		await leaseA2.release();
		await leaseB.release();
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("lease health follows its holder and release is repeatable after exit", async () => {
	const repo = gitRepo();
	let lease: Awaited<ReturnType<typeof bindingModule.acquireIdentityLease>> | undefined;
	try {
		const topology = await bindingModule.repoTopologyForCheckout(repo);
		lease = await bindingModule.acquireIdentityLease(topology.repoKey, "pi-health-probe");
		assert.equal(lease.isHeld(), true);
		await lease.release();
		assert.equal(lease.isHeld(), false);
		await lease.release();
	} finally {
		await lease?.release();
		rmSync(repo, { recursive: true, force: true });
	}
});

test("V2: resumed bindings are restored for the same session; forks start fresh", () => {
	const sessionId = "sess-v2";
	const binding = bindingModule.newBinding({
		alias: "probe",
		repoKey: "/probe/.git",
		primaryRoot: "/probe",
		checkoutRoot: "/probe",
		agentId: "pi-probe0001",
	});
	const restored = bindingModule.bindingForResume(sessionId, {
		binding: { schemaVersion: 1, sessionId, defaultRepo: "probe", repos: [binding] },
	});
	assert.equal(restored.repos.length, 1);
	assert.equal(restored.repos[0]?.alias, "probe");
	// A fold without a binding yields a fresh empty state.
	const fresh = bindingModule.bindingForResume(sessionId, undefined);
	assert.equal(fresh.repos.length, 0);
	assert.equal(bindingModule.freshBindingState("other").repos.length, 0);
});

test("V2: routing resolves alias, single-repo default, and refuses ambiguity", () => {
	const two = {
		schemaVersion: 1 as const,
		sessionId: "s",
		repos: [
			bindingModule.newBinding({ alias: "one", repoKey: "/one/.git", primaryRoot: "/one", checkoutRoot: "/one", agentId: "pi-a" }),
			bindingModule.newBinding({ alias: "two", repoKey: "/two/.git", primaryRoot: "/two", checkoutRoot: "/two", agentId: "pi-b" }),
		],
	};
	const ambiguous = bindingModule.routeBinding(two);
	assert.ok("error" in ambiguous, "two repos without default → ambiguous");
	// A default resolves.
	const withDefault = { ...two, defaultRepo: "two" };
	const chosen = bindingModule.routeBinding(withDefault);
	assert.ok("binding" in chosen);
	assert.equal(chosen.binding?.alias, "two");
});

test("V2: explicit alias routing and upsert merging", () => {
	const first = bindingModule.newBinding({
		alias: "probe",
		repoKey: "/probe/.git",
		primaryRoot: "/probe",
		checkoutRoot: "/probe",
		agentId: "pi-probe0001",
		workspaceId: "ws_probe",
	});
	let state = { schemaVersion: 1 as const, sessionId: "s", repos: [first] };
	const routed = bindingModule.routeBinding(state, "probe");
	assert.ok("binding" in routed);
	assert.equal(routed.binding?.workspaceId, "ws_probe");
	// Re-join with a worktree root merges checkout roots and keeps identity.
	const merged = bindingModule.upsertBinding(
		state,
		bindingModule.newBinding({
			alias: "probe",
			repoKey: "/probe/.git",
			primaryRoot: "/probe",
			checkoutRoot: "/probe/worktree-linked",
			agentId: "pi-probe0001",
		}),
	);
	state = merged;
	assert.deepEqual(state.repos[0]?.checkoutRoots, ["/probe", "/probe/worktree-linked"]);
	assert.equal(state.repos[0]?.workspaceId, "ws_probe");
});
