import "./muster-test-isolation.ts";
/**
 * SK7a (plans/secrets/key-management-blueprint-2026-10-16.md §12, SK7): the gateway's `toolbelt`
 * tool. It runs the shared run engine (`harness/toolbelt/toolbelt-run.ts`, `createToolbeltRunner`)
 * over the pi-toolbelt CLI, with the toolbelt's own description and parameter schema
 * (`harness/toolbelt/toolbelt-tool-spec.ts`), and passes the class from the toolbelt's envelope back
 * unchanged so Grok Bot can see — and ask the operator about — a command that changes an account.
 *
 * The class stays advisory (SK-D13): the gateway adds no gate of its own, and a call is audited by
 * the server exactly like every other tool call. The CLI itself is faked here: the engine parses a
 * canned envelope, so nothing runs and nothing leaves the machine. The only value in these
 * fixtures is a canary, and the tests assert it never reaches the caller or the audit log.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway, type RunningGateway } from "../gateway/server.ts";
import { AUDIT_FILE } from "../gateway/state.ts";
import { createGatewayTools, type GatewayTool, type GatewayToolDeps } from "../gateway/tools.ts";
import { createToolbeltRunner } from "../../toolbelt/toolbelt-run.ts";
import { TOOLBELT_ACTIONS, TOOLBELT_TOOL_DESCRIPTION } from "../../toolbelt/toolbelt-tool-spec.ts";

const TOKEN = "t".repeat(40);
/** A secret-shaped canary: no value in a provider answer may reach the caller or the audit log. */
const CANARY = "sk-canary0000000000000000000000";

type Fixture = { root: string; stateDir: string; tools: GatewayTool[]; calls: string[][]; gateway: RunningGateway };

/** The deps every gateway tool needs, without the action group. */
function baseDeps(stateDir: string): GatewayToolDeps {
	return { stateDir, lanes: () => [], notesRoot: stateDir, agentId: "grokbot", sendToOrchestrator: async () => "delivered" };
}

/**
 * The deps with the action group wired. The toolbelt dep is the REAL run engine over a fake exec:
 * the canned envelope is parsed, rendered and classed by the shipped code, and the exec records the
 * argv it was handed so the test can read the ledger attribution and the separator.
 */
function deps(stateDir: string, envelope: Record<string, unknown>, calls: string[][]): GatewayToolDeps {
	const runner = createToolbeltRunner({
		bin: "/fake/pi-toolbelt",
		exec: async (_bin, args) => {
			calls.push(args);
			return { code: 0, stdout: JSON.stringify(envelope), stderr: "" };
		},
	});
	return {
		...baseDeps(stateDir),
		actions: {
			deliverLaneMessage: async () => ({ ok: true, detail: "" }),
			readLaneCard: () => undefined,
			enqueueLaneControl: () => join(stateDir, "control.json"),
			launchLane: async () => ({ ok: true, detail: "" }),
			readLaneLatestReport: () => undefined,
			canWriteBrief: () => ({ ok: false, reason: "test" }),
			toolbelt: runner.runToolbelt,
		},
	};
}

async function withGateway(envelope: Record<string, unknown>, run: (fixture: Fixture) => Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "muster-gateway-toolbelt-"));
	const stateDir = join(root, "state");
	const calls: string[][] = [];
	const tools = createGatewayTools(deps(stateDir, envelope, calls));
	const gateway = await startGateway({ stateDir, token: TOKEN, tools, port: 0 });
	try {
		await run({ root, stateDir, tools, calls, gateway });
	} finally {
		await gateway.close();
		rmSync(root, { recursive: true, force: true });
	}
}

/** One JSON-RPC call; the streamable transport answers as an event stream. */
async function rpc(gateway: RunningGateway, body: unknown): Promise<{ status: number; json: any }> {
	const response = await fetch(`http://127.0.0.1:${gateway.port}/mcp`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKEN}` },
		body: JSON.stringify(body),
	});
	const text = await response.text();
	const data = text.split("\n").find((line) => line.startsWith("data: "));
	return { status: response.status, json: data !== undefined ? JSON.parse(data.slice(6)) : JSON.parse(text) };
}

const call = (gateway: RunningGateway, name: string, args: Record<string, unknown>) =>
	rpc(gateway, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
const replyText = (reply: { json: any }): string => reply.json.result.content.map((part: { text: string }) => part.text).join("\n");
const refused = (reply: { json: any }): boolean => reply.json.result.isError === true;
const auditRows = (stateDir: string): Array<Record<string, unknown>> => readFileSync(join(stateDir, AUDIT_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line));

const toolbeltTool = (tools: GatewayTool[]): GatewayTool => {
	const found = tools.find((candidate) => candidate.name === "toolbelt");
	assert.ok(found, "the gateway must offer the toolbelt tool when the action group is wired");
	return found;
};

test("the gateway offers the toolbelt tool from the toolbelt's own description and schema", () => {
	const tool = toolbeltTool(createGatewayTools(deps("/tmp/sk7a", {}, [])));
	assert.equal(tool.description, TOOLBELT_TOOL_DESCRIPTION, "the description has one owner (toolbelt-tool-spec.ts)");
	assert.equal(tool.inputSchema.additionalProperties, false);
	assert.deepEqual((tool.inputSchema.properties["action"] as { enum: string[] }).enum, [...TOOLBELT_ACTIONS], "the actions come from the one owner's schema");
	// The tool is part of the action group: a gateway with no action group reaches no provider CLI.
	assert.equal(createGatewayTools(baseDeps("/tmp/sk7a")).some((candidate) => candidate.name === "toolbelt"), false);
});

test("the one owner's schema decides what a well-formed call is", async () => {
	const tool = toolbeltTool(createGatewayTools(deps("/tmp/sk7a", {}, [])));
	await assert.rejects(tool.run({}), /invalid toolbelt arguments: \/ must have required propert/);
	await assert.rejects(tool.run({ action: "not-an-action" }), /invalid toolbelt arguments/);
});

test("a read call runs the shared engine, returns the envelope's class, and is audited once", async () => {
	await withGateway({ ok: true, status: "success", operationClass: "read", text: "ok vercel status" }, async ({ gateway, stateDir, calls }) => {
		const reply = await call(gateway, "toolbelt", { action: "status", service: "vercel" });
		assert.equal(refused(reply), false);
		assert.match(replyText(reply), /^class=read\n/, "the class from the toolbelt's envelope is passed back unchanged");
		assert.match(replyText(reply), /ok vercel status/);
		// The CLI is dispatched with the gateway's ledger attribution, through the shared engine's argv.
		assert.deepEqual(calls[0]?.slice(0, 3), ["status", "--json", "--agent"]);
		assert.equal(calls[0]?.[3], "grokbot");
		// The server audits every tool call: one intent row before it runs and one result row after.
		// The toolbelt tool writes nothing of its own, so one call leaves exactly that pair.
		const rows = auditRows(stateDir).filter((row) => row["tool"] === "toolbelt");
		assert.deepEqual(rows.map((row) => row["phase"]), ["intent", "result"]);
		assert.equal(rows.filter((row) => row["refused"] === true).length, 0);
	});
});

test("a mutating call returns mutate unchanged, is audited, and no value leaves the gateway", async () => {
	await withGateway({ ok: true, status: "success", operationClass: "mutate", stdout: `created a deployment\nAPI_KEY=${CANARY}` }, async ({ gateway, stateDir, calls }) => {
		const reply = await call(gateway, "toolbelt", { action: "run", service: "vercel", command: ["deploy"] });
		assert.equal(refused(reply), false);
		assert.match(replyText(reply), /^class=mutate\n/, "the mutating class is passed back as the envelope states it");
		assert.match(replyText(reply), /created a deployment/, "the provider's own output still reaches the caller");
		assert.ok(!replyText(reply).includes(CANARY), "the canary must not reach the caller");
		assert.ok(!readFileSync(join(stateDir, AUDIT_FILE), "utf8").includes(CANARY), "the canary must not reach the audit log");
		// The provider argv keeps its separator, so the command cannot become a wrapper flag.
		assert.ok(calls[0]?.includes("--") === true);
		assert.equal(calls[0]?.[calls[0].indexOf("--") + 1], "deploy");
		const rows = auditRows(stateDir).filter((row) => row["tool"] === "toolbelt");
		assert.deepEqual(rows.map((row) => row["phase"]), ["intent", "result"]);
	});
});

test("the class is the envelope's own and is never invented", async () => {
	const withoutClass = toolbeltTool(createGatewayTools(deps("/tmp/sk7a-no-class", { ok: true, status: "success", stdout: "raw output" }, [])));
	assert.equal(await withoutClass.run({ action: "status", service: "vercel" }), "ok success\nraw output", "no envelope class means no class line");
	const destructive = toolbeltTool(createGatewayTools(deps("/tmp/sk7a-destructive", { ok: true, status: "success", operationClass: "destructive", text: "removed" }, [])));
	assert.equal(await destructive.run({ action: "run", service: "vercel", command: ["remove"] }), "class=destructive\nremoved");
});
