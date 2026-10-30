import "./muster-test-isolation.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Native-lane edit gate — the Claude Code PreToolUse path.
 *
 * Concord 0.10.4's `concord hook pre-tool-use` compares the payload path against
 * task `expectedFiles` with `normalizePath`, which is not repo-relative, while
 * Claude Code sends absolute paths. The raw hook therefore never matches; the
 * shipped shim (`hooks/claude-pre-tool-use`) relativizes first. These tests pin
 * both halves: the defect (so the shim's reason is verifiable) and the fix.
 *
 * Zero LLM calls; disposable git repository under the OS temp dir.
 */

const MUSTER_DIR = fileURLToPath(new URL("../../../extensions/muster", import.meta.url));
/** The moved Muster sources (RD4: the Pi adapter keeps the launchers, the Claude shim and the bundles). */
const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));
const LAUNCHER_CONCORD = join(MUSTER_DIR, "launchers", "concord");
const LAUNCHER_MCP = join(MUSTER_DIR, "launchers", "concord-mcp");
const SHIM = join(MUSTER_DIR, "hooks", "claude-pre-tool-use");

const { ConcordClient } = await import(join(SRC_DIR, "concord.ts"));

function git(repo: string, ...args: string[]): string {
	return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

async function withClaimedRepo(
	claiming: { taskId: string; title: string; owner: string; files: string[] },
	fn: (repo: string) => Promise<void>,
): Promise<void> {
	const repo = mkdtempSync(join(tmpdir(), "muster-claude-hook-"));
	try {
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
		writeFileSync(join(repo, "README.md"), "# disposable hook repo\n");
		mkdirSync(join(repo, "src"), { recursive: true });
		writeFileSync(join(repo, "src", "hello.ts"), "export const hello = 1;\n");
		execFileSync("git", ["-C", repo, "add", "-A"], { encoding: "utf8" });
		execFileSync("git", ["-C", repo, "-c", "user.email=operator@local", "-c", "user.name=operator", "commit", "-qm", "init"], {
			encoding: "utf8",
		});
		execFileSync(LAUNCHER_CONCORD, ["setup", "--no-mcp", "--no-adapters"], { cwd: repo, encoding: "utf8" });
		const owner = await ConcordClient.connect({
			launcherMcp: LAUNCHER_MCP,
			repoRoot: repo,
			agentId: claiming.owner,
			connectTimeoutMs: 15000,
		});
		try {
			const created = await owner.callTool("start_work", {
				task_id: claiming.taskId,
				title: claiming.title,
				kind: "pi",
				expected_files: claiming.files,
				status: "active",
			});
			assert.equal(created.structuredContent?.["task_id"], claiming.taskId, "claiming task was created");
			await fn(repo);
		} finally {
			await owner.close();
		}
	} finally {
		rmSync(repo, { recursive: true, force: true, maxRetries: 3 });
	}
}

/** A PreToolUse payload in the shape Claude Code sends: absolute file path. */
function payload(repo: string, absoluteFile: string): string {
	return JSON.stringify({
		session_id: "hook-test-session",
		cwd: repo,
		hook_event_name: "PreToolUse",
		tool_name: "Write",
		tool_input: { file_path: absoluteFile, content: "export const hello = 2;\n" },
	});
}

function runHook(
	command: string,
	body: string,
	repo: string,
	extraEnv: Record<string, string> = {},
	args: string[] = [],
) {
	return spawnSync(command, args, {
		input: body,
		encoding: "utf8",
		timeout: 30000,
		env: {
			...process.env,
			CONCORD_REPO_ROOT: repo,
			CLAUDE_PROJECT_DIR: repo,
			CONCORD_AGENT_ID: "pi-hooktest01",
			...extraEnv,
		},
	});
}

const CLAIMING = { taskId: "TASK-HOOK-1", title: "Holds src/hello.ts", owner: "pi-hookowner01", files: ["src/hello.ts"] };

test("hook defect: the raw Concord hook does not match an absolute payload path", async () => {
	await withClaimedRepo(CLAIMING, async (repo) => {
		const file = join(repo, "src", "hello.ts");
		const raw = runHook(LAUNCHER_CONCORD, payload(repo, file), repo, { CONCORD_TASK: "TASK-OTHER" }, [
			"hook",
			"pre-tool-use",
		]);
		assert.equal(raw.status, 0, "raw hook exits 0");
		assert.equal(`${raw.stdout}${raw.stderr}`.trim(), "", "raw hook stays silent (no overlap detected — the defect)");
		// The same file expressed relative to the checkout IS detected, which is
		// what the shim produces and what makes the gate work.
		const relative = runHook(SHIM, payload(repo, "src/hello.ts"), repo, { CONCORD_TASK: "TASK-OTHER" });
		assert.match(relative.stderr, /TASK-HOOK-1/, "relative path detects the claim");
	});
});

test("hook fix: the shipped shim relativizes and warns without CONCORD_TASK", async () => {
	await withClaimedRepo(CLAIMING, async (repo) => {
		const result = runHook(SHIM, payload(repo, join(repo, "src", "hello.ts")), repo);
		assert.equal(result.status, 0, "warn mode never blocks");
		assert.match(result.stderr, /src\/hello\.ts is also claimed by TASK-HOOK-1/, "names the claiming task");
		assert.match(result.stderr, /CONCORD_TASK/, "tells the model how to arm blocking");
	});
});

test("hook fix: CONCORD_TASK makes a colliding write a hard block (exit 2)", async () => {
	await withClaimedRepo(CLAIMING, async (repo) => {
		const result = runHook(SHIM, payload(repo, join(repo, "src", "hello.ts")), repo, { CONCORD_TASK: "TASK-OTHER" });
		assert.equal(result.status, 2, "exit 2 blocks the tool call in Claude Code");
		assert.match(result.stderr, /claimed by another active task/, "explains the block");
	});
});

test("hook fix: the agent's own claim and unrelated files stay silent", async () => {
	await withClaimedRepo(CLAIMING, async (repo) => {
		const own = runHook(SHIM, payload(repo, join(repo, "src", "hello.ts")), repo, { CONCORD_TASK: "TASK-HOOK-1" });
		assert.equal(own.status, 0, "your own claim is not a conflict");
		assert.equal(`${own.stdout}${own.stderr}`.trim(), "", "no noise for your own file");

		const other = runHook(SHIM, payload(repo, join(repo, "src", "unrelated.ts")), repo);
		assert.equal(other.status, 0, "unclaimed file passes");
		assert.equal(`${other.stdout}${other.stderr}`.trim(), "", "no noise for an unclaimed file");
	});
});

test("hook fix: a malformed payload fails open rather than blocking", async () => {
	await withClaimedRepo(CLAIMING, async (repo) => {
		const result = runHook(SHIM, "not json", repo);
		assert.equal(result.status, 0, "garbage input must not block the model");
	});
});
