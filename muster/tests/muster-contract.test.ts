import "./muster-test-isolation.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * P1 protocol baseline — the pinned public Concord protocol exercised with two
 * real concord-mcp server processes and zero LLM calls (plan §9, V1 + P1 exit).
 *
 * Uses disposable git repositories under the OS temp dir; nothing outside is
 * touched. All processes run through the muster launchers (explicit Pi Node +
 * D5 environment).
 */

const MUSTER_DIR = fileURLToPath(new URL("../../../extensions/muster", import.meta.url));
/** The moved Muster sources (RD4: the Pi adapter keeps the launchers, the bundles and the runtime record). */
const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));
const LAUNCHER_CONCORD = join(MUSTER_DIR, "launchers", "concord");
const LAUNCHER_MCP = join(MUSTER_DIR, "launchers", "concord-mcp");

function git(repo: string, ...args: string[]): string {
	return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function setupWorkspace(at: string): void {
	execFileSync(LAUNCHER_CONCORD, ["setup", "--no-mcp", "--no-adapters"], {
		cwd: at,
		encoding: "utf8",
	});
}

async function withRepo(fn: (repo: string) => Promise<void>): Promise<void> {
	const base = mkdtempSync(join(tmpdir(), "muster-protocol-"));
	try {
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: base });
		writeFileSync(join(base, "README.md"), "# disposable protocol repo\n");
		mkdirSync(join(base, "src"), { recursive: true });
		writeFileSync(join(base, "src", "mod.ts"), "export const x = 1;\n");
		execFileSync("git", ["-C", base, "add", "-A"], { encoding: "utf8" });
		execFileSync("git", ["-C", base, "-c", "user.email=operator@local", "-c", "user.name=operator", "commit", "-qm", "init"], {
			encoding: "utf8",
		});
		await fn(base);
	} finally {
		rmSync(base, { recursive: true, force: true, maxRetries: 3 });
	}
}

const { ConcordClient, adaptToolSchema, concordNameFor, validateTaskFields } = await import(
	join(SRC_DIR, "concord.ts")
);

function client(repo: string, agentId: string, extra: Record<string, string> = {}) {
	return ConcordClient.connect({
		launcherMcp: LAUNCHER_MCP,
		repoRoot: repo,
		agentId,
		connectTimeoutMs: 15000,
		extraEnv: extra,
	});
}

// ─── V1: runtime/schema facts ────────────────────────────────────────────────

test("V1: pinned runtime matches the recorded provenance", () => {
	const prov = JSON.parse(readFileSync(join(MUSTER_DIR, "runtime-provenance.json"), "utf8"));
	assert.equal(prov.node.modules, process.versions.modules);
	assert.equal(prov.node.platform, process.platform);
	assert.equal(prov.dependencies["@concord-ai/concord-mcp"], "0.10.4");
	// better-sqlite3 resolves to the lockfile version; the record pins what was
	// installed — it must match the actual node_modules resolution.
	const installed = JSON.parse(
		readFileSync(join(MUSTER_DIR, "node_modules/better-sqlite3/package.json"), "utf8"),
	);
	assert.equal(installed.version, prov.dependencies["better-sqlite3"]);
});

test("V1: the actual locked SQLite dependency loads and transacts", async () => {
	const { default: Database } = await import(
		join(MUSTER_DIR, "node_modules/better-sqlite3/lib/index.js")
	);
	const db = new Database(":memory:");
	db.exec("CREATE TABLE probe (x TEXT)");
	const insert = db.prepare("INSERT INTO probe VALUES (?)");
	db.transaction(() => {
		insert.run("one");
		insert.run("two");
	})();
	const rows = db.prepare("SELECT x FROM probe ORDER BY rowid").all();
	assert.deepEqual(rows, [{ x: "one" }, { x: "two" }]);
	db.close();
});

test("V1: schema adaptation strips the actor from mutations, keeps inspect selectors, adds routing", async () => {
	const liveSchema = {
		type: "object",
		properties: {
			task_id: { type: "string" },
			title: { type: "string" },
			agent_id: { type: "string", description: "actor" },
			workspace_id: { type: "string" },
		},
		required: ["task_id", "title"],
		additionalProperties: false,
	};
	const adapted = adaptToolSchema({
		name: "start_work",
		inputSchema: liveSchema,
	});
	assert.ok(adapted);
	const props = adapted.schema.properties as Record<string, unknown>;
	assert.equal(props["agent_id"], undefined, "mutation tools lose the actor property");
	assert.deepEqual(props["task_id"], liveSchema.properties["task_id"]);
	assert.ok(props["muster_repo"], "routing field added");
	assert.deepEqual(adapted.schema.required, ["task_id", "title"], "required list preserved minus actor");
	const inspectAdapted = adaptToolSchema({
		name: "inspect_work",
		inputSchema: { type: "object", properties: { agent_id: { type: "string" } }, required: [] },
	});
	assert.ok(inspectAdapted);
	assert.ok(
		(inspectAdapted.schema.properties as Record<string, unknown>)["agent_id"],
		"inspect keeps agent_id as a selector",
	);
	assert.equal(concordNameFor("muster_transfer"), "transfer_work");
});

// ─── Full lifecycle with two real MCP processes ──────────────────────────────

test("V1: the pinned server exposes exactly the five public workflow tools", async () => {
	await withRepo(async (repo) => {
		setupWorkspace(repo);
		const probe = await client(repo, "pi-toolprobe01");
		try {
			const tools = await probe.listTools({ timeoutMs: 10000 });
			const names = tools.map((t) => t.name).sort();
			for (const expected of ["start_work", "inspect_work", "update_work", "transfer_work", "finish_work"]) {
				assert.ok(names.includes(expected), `missing ${expected} in ${JSON.stringify(names)}`);
				const def = tools.find((t) => t.name === expected);
				assert.equal((def?.inputSchema as { type?: string })?.type, "object");
			}
		} finally {
			await probe.close();
		}
	});
});

test("P1: registration → assign → accept → offer → parent accept → complete across two processes", async () => {
	await withRepo(async (repo) => {
		setupWorkspace(repo);
		const parent = await client(repo, "pi-parenttest01");
		const worker = await client(repo, "pi-workertest01");
		try {
			// Parent creates the task (allocated id; parent initially owns it).
			const started = await parent.callTool("start_work", {
				task_id: "TASK-101",
				title: "Implement the probe module",
				kind: "pi",
			});
			assert.equal(started.structuredContent?.["task_id"], "TASK-101");
			const v1 = started.structuredContent?.["version"] as number;
			assert.equal(typeof v1, "number");

			// Registration is observable through the workspace roster.
			const roster = await parent.callTool("inspect_work", {});
			const communications = roster.structuredContent?.["communications"] as Array<Record<string, unknown>>;
			assert.ok(communications.some((c) => c["agentId"] === "pi-parenttest01"));
			assert.ok(communications.some((c) => c["agentId"] === "pi-workertest01"));

			// Assign before registration would fail; both are registered now.
			const assigned = await parent.callTool("transfer_work", {
				task_id: "TASK-101",
				action: "assign",
				to_agent_id: "pi-workertest01",
				expected_version: v1,
			});
			assert.equal(assigned.structuredContent?.["status"], "assigned");
			const v2 = assigned.structuredContent?.["version"] as number;

			// Worker accepts the assignment through start_work.
			const accepted = await worker.callTool("start_work", {
				task_id: "TASK-101",
				title: "Implement the probe module",
				kind: "pi",
			});
			assert.equal(accepted.structuredContent?.["status"], "active");
			assert.equal(accepted.structuredContent?.["resumed_by"], "assignment");
			const v3 = accepted.structuredContent?.["version"] as number;

			// Worker records evidence and offers the handoff back to the parent.
			const offered = await worker.callTool("transfer_work", {
				task_id: "TASK-101",
				action: "offer",
				to_agent_id: "pi-parenttest01",
				expected_version: v3,
				what_changed: "probe module implemented",
				changed_files: ["src/mod.ts"],
				tests_run: [],
				known_risks: [],
			});
			assert.equal(offered.structuredContent?.["status"], "handoff_offered");
			const handoffId = offered.structuredContent?.["handoff_id"] as number;
			assert.equal(typeof handoffId, "number");
			const v4 = offered.structuredContent?.["version"] as number;

			// Task-scoped inspection attributes the handoff independently.
			const detail = await parent.callTool("inspect_work", { task_id: "TASK-101" });
			assert.equal(detail.structuredContent?.["scope"], "task");
			const pending = detail.structuredContent?.["pending_handoff"] as Record<string, unknown> | null;
			assert.ok(pending, "pending handoff visible via task inspection");
			assert.equal(pending?.["id"], handoffId);
			assert.equal(pending?.["fromAgentId"], "pi-workertest01");

			// Parent accepts the handoff → ownership returns to the parent.
			const acceptedHandoff = await parent.callTool("transfer_work", {
				task_id: "TASK-101",
				action: "accept",
				handoff_id: handoffId,
				expected_version: v4,
			});
			assert.equal(acceptedHandoff.structuredContent?.["status"], "active");
			assert.equal(acceptedHandoff.structuredContent?.["agent_id"], "pi-parenttest01");
			const v5 = acceptedHandoff.structuredContent?.["version"] as number;

			// Parent verifies and finishes the work.
			const finished = await parent.callTool("finish_work", {
				task_id: "TASK-101",
				expected_version: v5,
				outcome: "complete",
				what_changed: "integrated probe module",
				changed_files: ["src/mod.ts"],
				tests_run: [],
			});
			assert.equal(finished.structuredContent?.["status"], "complete");

			// Durable evidence via the SQLite store.
			const { default: Database } = await import(
				join(MUSTER_DIR, "node_modules/better-sqlite3/lib/index.js")
			);
			const db = new Database(join(repo, ".concord", "concord.db"), { readonly: true });
			const row = db.prepare("SELECT status FROM tasks WHERE task_id = ?").get("TASK-101") as
				| { status: string }
				| undefined;
			assert.ok(row, "task row durably present");
			assert.equal(row?.status, "complete");
			db.close();
		} finally {
			await parent.close();
			await worker.close();
		}
	});
});

test("V1: inspect rejects two selectors; stale versions fail; spoofed actor resolves to the session identity", async () => {
	await withRepo(async (repo) => {
		setupWorkspace(repo);
		const parent = await client(repo, "pi-parenttest02");
		const worker = await client(repo, "pi-workertest02");
		try {
			const started = await parent.callTool("start_work", {
				task_id: "TASK-201",
				title: "Selector probes",
				kind: "pi",
			});
			const v1 = started.structuredContent?.["version"] as number;

			// inspect_work with two selectors → real tool error.
			await assert.rejects(
				() =>
					parent.callTool("inspect_work", {
						task_id: "TASK-201",
						agent_id: "pi-parenttest02",
					} as never),
				/only one of task_id, agent_id, or message_id/,
			);

			// MCP isError becomes a real thrown error.
			await assert.rejects(
				() => parent.callTool("inspect_work", { task_id: "TASK-NONE" }),
				/muster: inspect_work failed/,
			);

			// Stale version conflict on transfer.
			await assert.rejects(
				() =>
					parent.callTool("transfer_work", {
						task_id: "TASK-201",
						action: "assign",
						to_agent_id: "pi-workertest02",
						expected_version: 9999,
					}),
				/version conflict/,
			);

			// Mutation with a spoofed agent_id: the spawned session identity wins.
			// The OWNER records the progress (update_work requires ownership).
			const recorded = await parent.callTool("update_work", {
				task_id: "TASK-201",
				kind: "progress",
				content: "progress note",
				agent_id: "claude-code:spoofed",
			} as never);
			assert.ok(recorded.structuredContent?.["update_id"]);
			assert.equal(recorded.structuredContent?.["agent"], "pi-parenttest02");
		} finally {
			await parent.close();
			await worker.close();
		}
	});
});

test("V1: required start fields retained; messages poison failed idempotency keys", async () => {
	await withRepo(async (repo) => {
		setupWorkspace(repo);
		const parent = await client(repo, "pi-parenttest03");
		const worker = await client(repo, "pi-workertest03");
		try {
			// start_work without required title/kind → schema validation error.
			await assert.rejects(
				() => parent.callTool("start_work", { task_id: "TASK-301" } as never),
				(error: unknown) => {
					const message = String((error as Error).message);
					return /muster: start_work failed/.test(message);
				},
			);

			await parent.callTool("start_work", {
				task_id: "TASK-301",
				title: "Message probes",
				kind: "pi",
			});

			// Prompt to a promptless (registered but endpoint-less) agent fails and
			// the SAME key replays that failure (permanently poisoned).
			const poisonedKey = "attempt/1";
			const promptArgs = {
				operation: "prompt",
				to_agent_id: "pi-workertest03",
				task_id: "TASK-301",
				content: "please look",
				idempotency_key: poisonedKey,
			};
			await assert.rejects(() => parent.callTool("update_work", promptArgs as never));
			await assert.rejects(
				() => parent.callTool("update_work", promptArgs as never),
				(error: unknown) => /previously failed delivery|no prompt endpoint|not registered/.test(String((error as Error).message)),
			);

			// A fresh attempt key after the recipient becomes promptable succeeds.
			execFileSync(LAUNCHER_CONCORD, ["inbox", "register", "--agent", "pi-workertest03", "--provider", "pi"], {
				cwd: repo,
				encoding: "utf8",
			});
			const delivered = await parent.callTool("update_work", {
				...promptArgs,
				idempotency_key: "attempt/2",
			} as never);
			assert.ok(delivered.structuredContent?.["message_id"]);
			assert.equal(delivered.structuredContent?.["operation"], "prompt");
		} finally {
			await parent.close();
			await worker.close();
		}
	});
});

test("V1: linked worktrees resolve to one workspace; cross-repo stays separate", async () => {
	await withRepo(async (repo) => {
		setupWorkspace(repo);
		execFileSync("git", ["-C", repo, "worktree", "add", "-q", join(repo, "worktree-linked"), "-b", "wl"], {
			encoding: "utf8",
		});
		const primary = await client(repo, "pi-parenttest04");
		const viaWorktree = await client(join(repo, "worktree-linked"), "pi-workertest04");
		try {
			const started = await primary.callTool("start_work", {
				task_id: "TASK-401",
				title: "Worktree sharing probe",
				kind: "pi",
				expected_files: ["src/mod.ts"],
			});
			assert.equal(started.structuredContent?.["task_id"], "TASK-401");
			const wsPrimaryId = started.structuredContent?.["workspace_id"] as string | undefined;
			const viaWorktreeRoster = await viaWorktree.callTool("inspect_work", {});
			const wsWorktreeId = viaWorktreeRoster.structuredContent?.["workspace_id"] as string | undefined;
			assert.ok(wsPrimaryId || wsWorktreeId, "workspace id present in structured output");
			if (wsPrimaryId && wsWorktreeId) {
				assert.equal(wsPrimaryId, wsWorktreeId, "linked worktrees share one workspace");
			}
			const roster = await viaWorktree.callTool("inspect_work", {});
			const active = roster.structuredContent?.["active"] as Array<Record<string, unknown>>;
			assert.ok(active.some((t) => t["taskId"] === "TASK-401"), "task visible from the linked worktree");

			// A different repository is a different workspace entirely.
			const other = mkdtempSync(join(tmpdir(), "muster-other-repo-"));
			try {
				execFileSync("git", ["init", "-q", "-b", "main"], { cwd: other });
				writeFileSync(join(other, "README.md"), "# other repo\n");
				execFileSync("git", ["-C", other, "add", "-A"], { encoding: "utf8" });
				execFileSync("git", ["-C", other, "-c", "user.email=operator@local", "-c", "user.name=operator", "commit", "-qm", "init"], { encoding: "utf8" });
				setupWorkspace(other);
				const otherClient = await client(other, "pi-parenttest04b");
				try {
					const otherRoster = await otherClient.callTool("inspect_work", {});
					const otherActive = otherRoster.structuredContent?.["active"] as Array<Record<string, unknown>>;
					assert.equal(otherActive.length, 0, "cross-repository isolation");
				} finally {
					await otherClient.close();
				}
			} finally {
				rmSync(other, { recursive: true, force: true });
			}
		} finally {
			await primary.close();
			await viaWorktree.close();
		}
	});
});

test("V5: ownership negative cases — assign-before-register, review-ready offer, foreign finish", async () => {
	await withRepo(async (repo) => {
		setupWorkspace(repo);
		const parent = await client(repo, "pi-parenttest05");
		try {
			// Assign to an unregistered future name fails (plan §6.3 step 1).
			const started = await parent.callTool("start_work", {
				task_id: "TASK-501",
				title: "Ownership negatives",
				kind: "pi",
			});
			const v1 = started.structuredContent?.["version"] as number;
			await assert.rejects(
				() =>
					parent.callTool("transfer_work", {
						task_id: "TASK-501",
						action: "assign",
						to_agent_id: "pi-unregistered",
						expected_version: v1,
					}),
				/is not registered/,
			);

			// Parent-owned task cannot be finished by another agent (owner check).
			const worker = await client(repo, "pi-workertest05");
			try {
				await assert.rejects(
					() =>
						worker.callTool("finish_work", {
							task_id: "TASK-501",
							expected_version: v1,
							outcome: "complete",
							what_changed: "foreign close attempt",
						}),
					/cannot record handoff evidence|current owner is/,
				);

				// review_ready cannot be offered: offer is valid only from active/blocked.
				await parent.callTool("finish_work", {
					task_id: "TASK-501",
					expected_version: v1,
					outcome: "review_ready",
					what_changed: "review ready",
					needs_review_from: ["human"],
				});
				const after = await parent.callTool("inspect_work", { task_id: "TASK-501" });
				assert.equal(after.structuredContent?.["task"]?.["status"], "review_ready");
				const vReview = after.structuredContent?.["task"]?.["version"] as number;
				await assert.rejects(
					() =>
						parent.callTool("transfer_work", {
							task_id: "TASK-501",
							action: "offer",
							to_agent_id: "pi-workertest05",
							expected_version: vReview,
							what_changed: "offer after review_ready",
						}),
					/only active or blocked work can be offered/,
				);
			} finally {
				await worker.close();
			}
		} finally {
			await parent.close();
		}
	});
});

test("V1: structured content validation rejects malformed task fields", () => {
	assert.throws(() => validateTaskFields("probe", { status: "bogus-status" }), /unknown task status/);
	assert.throws(() => validateTaskFields("probe", { version: 0 }), /malformed version/);
	assert.throws(() => validateTaskFields("probe", null), /no structured content/);
	// message-scope results (update_work prompt/reply) carry message statuses
	// and null task ids for taskless prompts
	assert.doesNotThrow(() => validateTaskFields("muster_update", { status: "pending" }, "message"));
	assert.doesNotThrow(() =>
		validateTaskFields("muster_update", { status: "pending", task_id: null, task_updated_at: null }, "message"),
	);
	assert.throws(() => validateTaskFields("muster_update", { status: "complete" }, "message"), /unknown message status/);
});
