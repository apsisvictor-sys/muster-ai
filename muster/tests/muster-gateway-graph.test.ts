/**
 * WP11 (LD12): Henry's read-only graph tools. `graphify` is stubbed; the gateway, the tool registry,
 * the catalogue-only rule and the audit log are the real ones.
 */

import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startGateway } from "../gateway/server.ts";
import { createGatewayTools, ToolRefusal } from "../gateway/tools.ts";
import { AUDIT_FILE } from "../gateway/state.ts";
import { catalogueRepos, parseProjectCatalogue } from "../projects.ts";

const TOKEN = "t".repeat(40);

function harness() {
	const root = mkdtempSync(join(tmpdir(), "gateway-graph-"));
	const repo = join(root, "projects", "demo");
	mkdirSync(join(repo, "graphify-out"), { recursive: true });
	writeFileSync(join(repo, "graphify-out", "graph.json"), "{}");
	writeFileSync(join(repo, "graphify-out", "GRAPH_REPORT.md"), "# Graph Report - demo\n\n- god node: Foo\n");
	// A git repository with a refresh stamp, so the first page can say how old the graph is.
	spawnSync("git", ["-C", repo, "init", "-q"]);
	writeFileSync(join(repo, "graphify-out", ".refreshed-at"), "2026-10-12T03:00:00+03:00 1234567890abcdef\n");
	const bare = join(root, "projects", "nograph");
	mkdirSync(bare, { recursive: true });
	const calls: string[][] = [];
	const tools = createGatewayTools({
		knowledge: {
			wikiRoot: root, planRoots: [], gitRepos: [], skillRoots: [], projectRoots: [], memoryRoots: [], reportsRoot: { name: "r", dir: root }, instructionsRoots: [],
			recall: async () => "", historySearch: () => ({ content: [{ type: "text", text: "" }], details: {} }), historyRead: () => ({ content: [{ type: "text", text: "" }], details: {} }),
			graphRepos: () => [{ name: "demo", dir: repo }, { name: "nograph", dir: bare }],
			graphify: async (args) => { calls.push(args); return `answer for ${args[0]}\n`; },
			home: root,
		},
		stateDir: root, lanes: () => [], notesRoot: root, agentId: "grokbot", sendToOrchestrator: async () => "",
	});
	const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
	return { root, repo, calls, tools, tool, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("graph_query, graph_path and graph_explain run graphify with a fixed argument list against the repository's own graph", async () => {
	const h = harness();
	try {
		assert.equal(await h.tool("graph_query").run({ repo: "demo", question: "how does auth work" }), "answer for query");
		assert.equal(await h.tool("graph_path").run({ repo: "demo", a: "Foo", b: "Bar" }), "answer for path");
		assert.equal(await h.tool("graph_explain").run({ repo: "demo", node: "Foo" }), "answer for explain");
		const graph = join(h.repo, "graphify-out", "graph.json");
		assert.deepEqual(h.calls, [
			["query", "how does auth work", "--graph", graph, "--budget", "2000"],
			["path", "Foo", "Bar", "--graph", graph],
			["explain", "Foo", "--graph", graph],
		]);
	} finally {
		h.cleanup();
	}
});

test("a repository outside the catalogue, a missing graph and an argument that could become a flag are refused", async () => {
	const h = harness();
	try {
		await assert.rejects(() => h.tool("graph_query").run({ repo: "/etc", question: "x" }), (error: unknown) => error instanceof ToolRefusal && /unknown repo/.test(error.message) && /demo, nograph/.test(error.message));
		await assert.rejects(() => h.tool("graph_report").run({ repo: "somewhere-else" }), ToolRefusal);
		await assert.rejects(() => h.tool("graph_query").run({ repo: "nograph", question: "x" }), (error: unknown) => error instanceof ToolRefusal && /no graph yet/.test(error.message));
		await assert.rejects(() => h.tool("graph_query").run({ repo: "demo", question: "--graph /etc/passwd" }), (error: unknown) => error instanceof ToolRefusal && /must not start with/.test(error.message));
		await assert.rejects(() => h.tool("graph_path").run({ repo: "demo", a: "ok", b: "-x" }), ToolRefusal);
		await assert.rejects(() => h.tool("graph_query").run({ repo: "demo", question: "q".repeat(301) }), ToolRefusal);
		assert.deepEqual(h.calls, [], "graphify never ran for a refused call");
	} finally {
		h.cleanup();
	}
});

test("graph_report returns the report text, with the graph's age and commit on the first page", async () => {
	const h = harness();
	try {
		const text = await h.tool("graph_report").run({ repo: "demo" });
		assert.match(text, /^graph of demo: refreshed 2026-10-12T00:00:00\.000Z, built at 1234567\n/);
		assert.match(text, /# Graph Report - demo\n\n- god node: Foo/);
	} finally {
		h.cleanup();
	}
});

test("the graph tools are offered only when the gateway is given a catalogue", () => {
	const names = (graphRepos?: () => Array<{ name: string; dir: string }>) =>
		createGatewayTools({
			knowledge: { wikiRoot: "/tmp", planRoots: [], gitRepos: [], skillRoots: [], projectRoots: [], memoryRoots: [], reportsRoot: { name: "r", dir: "/tmp" }, instructionsRoots: [], recall: async () => "", historySearch: () => ({ content: [], details: {} }), historyRead: () => ({ content: [], details: {} }), ...(graphRepos ? { graphRepos } : {}) },
			stateDir: "/tmp", lanes: () => [], notesRoot: "/tmp", agentId: "grokbot", sendToOrchestrator: async () => "",
		}).map((tool) => tool.name).filter((name) => name.startsWith("graph_"));
	assert.deepEqual(names(), []);
	assert.deepEqual(names(() => []), ["graph_report", "graph_query", "graph_path", "graph_explain", "graph_status", "graph_refresh_request"]);
});

test("a graph_query over HTTP answers and is audited twice, like every other tool", async () => {
	const h = harness();
	const stateDir = join(h.root, "gateway");
	mkdirSync(stateDir, { recursive: true });
	const gateway = await startGateway({ stateDir, token: TOKEN, tools: h.tools, port: 0 });
	try {
		const response = await fetch(`http://127.0.0.1:${gateway.port}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKEN}` },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_query", arguments: { repo: "demo", question: "who calls Foo" } } }),
		});
		const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
		assert.match(JSON.parse(data!.slice(6)).result.content[0].text, /answer for query/);
		const audit = readFileSync(join(stateDir, AUDIT_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
		assert.deepEqual(audit.filter((line) => line["tool"] === "graph_query").map((line) => line["phase"]), ["intent", "result"]);
	} finally {
		await gateway.close();
		h.cleanup();
	}
});

test("the catalogue's repositories are listed once each, by project name", () => {
	let counter = 0;
	const programme = (repoKey: string) => ({ programmeId: `agp_${++counter}`, checkoutRoot: repoKey.replace(/\/\.git$/, ""), repoKey, parentAgentId: `pi-x${counter}-parent` });
	const catalogue = parseProjectCatalogue({
		schemaVersion: 1,
		projects: [
			{ projectId: "alpha", name: "alpha", aliases: [], programmes: [programme("/r/alpha/.git"), programme("/r/alpha/.git")], settings: {} },
			{ projectId: "beta", name: "beta", aliases: [], programmes: [programme("/r/beta")], settings: {} },
		],
	});
	assert.deepEqual(catalogueRepos(catalogue), [{ name: "alpha", dir: "/r/alpha" }, { name: "beta", dir: "/r/beta" }]);
});
