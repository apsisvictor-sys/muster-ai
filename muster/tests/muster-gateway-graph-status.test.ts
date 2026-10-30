/**
 * HO12: the two graph state tools — `graph_status` across the repository set, and
 * `graph_refresh_request`, the one graph tool that starts something. The transient unit is stubbed;
 * the tool registry, the catalogue-only rule and the repository's real `graph-refresh.sh --status`
 * are not, so the "already running" answer comes from the script's own flock.
 *
 * `gateway/server.ts` is deliberately not imported: it needs the MCP SDK, which a worktree's
 * `packages/muster/node_modules` may not carry, and this file has to run wherever the lane is cut.
 */

import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { graphRefreshScript } from "../../core/graph-refresh.ts";
import { createGatewayTools, ToolRefusal } from "../gateway/tools.ts";

/** A catalogue of two repositories: one git checkout with a refresh stamp, one plain directory. */
function harness() {
	const root = mkdtempSync(join(tmpdir(), "gateway-graph-status-"));
	const repo = join(root, "projects", "demo");
	mkdirSync(join(repo, "graphify-out"), { recursive: true });
	writeFileSync(join(repo, "graphify-out", "graph.json"), "{}");
	writeFileSync(join(repo, "graphify-out", "GRAPH_REPORT.md"), "# Graph Report - demo\n");
	spawnSync("git", ["-C", repo, "init", "-q"]);
	writeFileSync(join(repo, "graphify-out", ".refreshed-at"), "2026-10-12T03:00:00+03:00 1234567890abcdef\n");
	const bare = join(root, "projects", "nograph");
	mkdirSync(bare, { recursive: true });
	const starts: string[][] = [];
	const tools = createGatewayTools({
		knowledge: {
			wikiRoot: root, planRoots: [], gitRepos: [], skillRoots: [], projectRoots: [], memoryRoots: [], reportsRoot: { name: "r", dir: root }, instructionsRoots: [],
			recall: async () => "", historySearch: () => ({ content: [], details: {} }), historyRead: () => ({ content: [], details: {} }),
			graphRepos: () => [{ name: "demo", dir: repo }, { name: "nograph", dir: bare }],
			graphify: async () => "answer\n",
			graphRefreshRun: (argv) => {
				starts.push(argv);
				return { ok: true, detail: "started" };
			},
			home: root,
		},
		stateDir: root, lanes: () => [], notesRoot: root, agentId: "grokbot", sendToOrchestrator: async () => "",
	});
	const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
	return { root, repo, starts, tools, tool, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("the graph state tools are offered only when the gateway is given a catalogue", () => {
	const names = (graphRepos?: () => Array<{ name: string; dir: string }>) =>
		createGatewayTools({
			knowledge: {
				wikiRoot: "/tmp", planRoots: [], gitRepos: [], skillRoots: [], projectRoots: [], memoryRoots: [], reportsRoot: { name: "r", dir: "/tmp" }, instructionsRoots: [],
				recall: async () => "", historySearch: () => ({ content: [], details: {} }), historyRead: () => ({ content: [], details: {} }),
				...(graphRepos ? { graphRepos } : {}),
			},
			stateDir: "/tmp", lanes: () => [], notesRoot: "/tmp", agentId: "grokbot", sendToOrchestrator: async () => "",
		}).map((tool) => tool.name).filter((name) => name.startsWith("graph_"));
	assert.deepEqual(names(), []);
	assert.deepEqual(names(() => []), ["graph_report", "graph_query", "graph_path", "graph_explain", "graph_status", "graph_refresh_request"]);
});

test("graph_status reads each catalogue repository's own state, and reports the one the script cannot read", async () => {
	const h = harness();
	try {
		const text = await h.tool("graph_status").run({});
		assert.match(text, /^graph of demo: refreshed 2026-10-12T00:00:00\.000Z, built at 1234567, no refresh due\n/);
		assert.match(text, /\ngraph of nograph: the graph's state could not be read$/);
	} finally {
		h.cleanup();
	}
});

test("graph_refresh_request starts one unit for a known repository, refuses an unknown one, and starts nothing while a refresh runs", async () => {
	const h = harness();
	try {
		await assert.rejects(
			() => h.tool("graph_refresh_request").run({ repo: "somewhere-else" }),
			(error: unknown) => error instanceof ToolRefusal && /unknown repo/.test(error.message) && /demo, nograph/.test(error.message),
		);
		assert.equal(await h.tool("graph_refresh_request").run({ repo: "demo" }), `started graph-refresh-demo: started graph-refresh-demo for ${h.repo}`);
		assert.deepEqual(h.starts, [["--user", "--unit", "graph-refresh-demo", "--collect", graphRefreshScript(), h.repo]], "a fixed argument list, and the script from the agent folder");
		assert.match(await h.tool("graph_refresh_request").run({ repo: "nograph" }), /^not started: .* is not a repository the graph script can read$/);
		assert.equal(h.starts.length, 1, "nothing was started for a repository the graph script cannot read");
		const holder = spawn("flock", [join(h.repo, "graphify-out", ".refresh.lock"), "sleep", "3"]);
		await new Promise((done) => setTimeout(done, 400));
		try {
			assert.match(await h.tool("graph_refresh_request").run({ repo: "demo" }), /^not started: a refresh is already running in /);
			assert.equal(h.starts.length, 1, "no second unit was started while the lock was held");
		} finally {
			holder.kill();
		}
	} finally {
		h.cleanup();
	}
});

test("a refused start is not reported as one", async () => {
	const h = harness();
	try {
		const refused = createGatewayTools({
			knowledge: {
				wikiRoot: h.root, planRoots: [], gitRepos: [], skillRoots: [], projectRoots: [], memoryRoots: [], reportsRoot: { name: "r", dir: h.root }, instructionsRoots: [],
				recall: async () => "", historySearch: () => ({ content: [], details: {} }), historyRead: () => ({ content: [], details: {} }),
				graphRepos: () => [{ name: "demo", dir: h.repo }],
				graphify: async () => "answer\n",
				graphRefreshRun: () => ({ ok: false, detail: "Unit graph-refresh-demo.service already exists." }),
				home: h.root,
			},
			stateDir: h.root, lanes: () => [], notesRoot: h.root, agentId: "grokbot", sendToOrchestrator: async () => "",
		}).find((candidate) => candidate.name === "graph_refresh_request")!;
		const answer = await refused.run({ repo: "demo" });
		assert.match(answer, /^not started: systemd-run refused graph-refresh-demo: Unit graph-refresh-demo\.service already exists\.$/);
	} finally {
		h.cleanup();
	}
});
