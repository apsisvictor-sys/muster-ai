import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createGatewayTools } from "../gateway/tools.ts";
import { startGateway, type RunningGateway } from "../gateway/server.ts";
import { AUDIT_FILE } from "../gateway/state.ts";
import { readAsks } from "../asks.ts";

// NLK (VR24-47 D22): `asks_answer` records a ruling as the operator's, so only the chat bearer (Henry, Bob) may call it.

const CHAT_TOKEN = "c".repeat(40);
const MONITOR_TOKEN = "m".repeat(40);

type World = { root: string; muster: string; tools: ReturnType<typeof createGatewayTools>; gateway: RunningGateway };

async function withWorld(run: (w: World) => Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "muster-asks-answer-chat-only-"));
	const muster = join(root, "muster");
	mkdirSync(muster, { recursive: true });
	const tools = createGatewayTools({
		stateDir: muster,
		lanes: () => [],
		notesRoot: join(root, "notes"),
		agentId: "grokbot",
		gatewayStateDir: muster,
		sendToOrchestrator: async () => "ok",
		sendToArchitect: async (_text, _attachments, id) => `delivered ${id}`,
	});
	const gateway = await startGateway({ stateDir: muster, token: CHAT_TOKEN, monitorToken: MONITOR_TOKEN, tools, port: 0 });
	try {
		await run({ root, muster, tools, gateway });
	} finally {
		await gateway.close();
		rmSync(root, { recursive: true, force: true });
	}
}

async function rpc(gateway: RunningGateway, token: string, body: unknown): Promise<any> {
	const response = await fetch(`http://127.0.0.1:${gateway.port}/mcp`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
		body: JSON.stringify(body),
	});
	const text = await response.text();
	const data = text.split("\n").find((line) => line.startsWith("data: "));
	return data !== undefined ? JSON.parse(data.slice(6)) : JSON.parse(text);
}
const listed = async (gateway: RunningGateway, token: string): Promise<string[]> =>
	(await rpc(gateway, token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools.map((t: { name: string }) => t.name);
const callTool = (gateway: RunningGateway, token: string, name: string, args: Record<string, unknown>) =>
	rpc(gateway, token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });

test("NLK 1: asks_answer is on the chat bearer's list and not on the monitor bearer's", async () => {
	await withWorld(async ({ gateway }) => {
		assert.ok((await listed(gateway, CHAT_TOKEN)).includes("asks_answer"), "chat lists asks_answer");
		assert.ok(!(await listed(gateway, MONITOR_TOKEN)).includes("asks_answer"), "monitor must not list asks_answer");
	});
});

test("NLK 1: the monitor bearer cannot record a ruling, and Henry's use on the chat bearer is unchanged", async () => {
	await withWorld(async ({ gateway, muster }) => {
		const raised = await callTool(gateway, CHAT_TOKEN, "asks_add", { kind: "authorization", question: "Approve the pilot spend?", code: "VN1" });
		assert.equal(raised.result.isError, undefined, "chat raises the ask");
		const id = readAsks(muster).asks[0]!.id;

		const denied = await callTool(gateway, MONITOR_TOKEN, "asks_answer", { id, ruling: "yes", words: "yes, go ahead" });
		assert.equal(denied.result.isError, true, "the monitor call is refused");
		const stillOpen = readAsks(muster).asks.find((ask) => ask.id === id)!;
		assert.equal(stillOpen.status, "open", "no ruling was recorded");
		assert.equal(stillOpen.ruling, undefined);

		const ok = await callTool(gateway, CHAT_TOKEN, "asks_answer", { id, ruling: "yes", words: "yes, go ahead" });
		assert.match(ok.result.content[0].text, /^VN1 answered — decided: yes$/);
		const answered = readAsks(muster).asks.find((ask) => ask.id === id)!;
		assert.equal(answered.answeredBy, "grokbot");
		assert.equal(answered.relay?.via, "grokbot-gateway");
		assert.equal(answered.words, "yes, go ahead");

		const audit = readFileSync(join(muster, AUDIT_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
		const monitorCalls = audit.filter((line) => line["tool"] === "asks_answer" && line["role"] === "monitor");
		assert.ok(monitorCalls.length >= 1 && monitorCalls.every((line) => line["refused"] === true), "the refused monitor call is in the audit");
	});
});

test("NLK 2: asks_answer and the NLH card tools carry the flag, and no ask or send tool does; asks_add, asks_read and the send_to_* tools are listed for the monitor as before", async () => {
	await withWorld(async ({ gateway, tools }) => {
		const flagged = tools.filter((tool) => tool.chatOnly === true).map((tool) => tool.name);
		assert.deepEqual(flagged, ["asks_answer", "cards_read", "cards_tap"]);
		const monitor = await listed(gateway, MONITOR_TOKEN);
		for (const name of ["asks_add", "asks_read", "send_to_architect", "send_to_orchestrator"]) assert.ok(monitor.includes(name), `monitor still lists ${name}`);
	});
});
