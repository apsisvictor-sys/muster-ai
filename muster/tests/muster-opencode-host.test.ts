/**
 * Muster OpenCode host (harness bus A4) — lib units, owner guards, and one
 * end-to-end host run against a stub opencode server plus a stub Concord watch
 * child. The stub enforces the per-lane Basic auth, so a host that forgets the
 * Authorization header fails here.
 */

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { countInboxMessages, listDeliveredMessages, listInboxMessages, writeInboxMessage } from "../lib/agent-inbox.ts";
import { laneCardsDir, readLaneCard, recordLaneReport, writeLaneCard } from "../lib/lane-card.ts";
import { enqueueLaneControl, laneControlFile } from "../lib/lane-control.ts";
import { backendPath } from "../ledger/backend.ts";
import {
	MESSAGE_SCAN_QUERY,
	MESSAGE_TAIL_QUERY,
	PEER_BOUNDARY_BASE,
	assistantErrorFrom,
	basicAuthHeader,
	deliveryBody,
	deliveryMessageId,
	formatModelRef,
	interpretControlMessage,
	laneConfigContent,
	laneRuntimeDir,
	ledgerPathFor,
	parseHostArgs,
	parseModelRef,
	parseMonitorLine,
	parseSseChunk,
	readLedger,
	resolveModelSwitch,
	serverRecordPathFor,
	shouldHold,
	withLedgerId,
} from "../opencode-host-lib.mjs";
import { EXIT_REFUSED } from "../lane-database.mjs";

import { harnessRoot, nodeBinary, tsxLoaderPath } from "../../core/harness-paths.ts";
import { poolConfigPath } from "../../routing/provider-pool.ts";
const HOST = fileURLToPath(new URL("../opencode-host.mjs", import.meta.url));
const PASSWORD = "test-lane-password";
const AUTH = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`;
/** The ledger daemon fixture (LC7's pattern) and the node that starts it. */
const HARNESS_ROOT = harnessRoot(import.meta.url);
const DAEMON = join(HARNESS_ROOT, "muster", "ledger", "daemon.ts");
const NODE = nodeBinary();

// ─── Lib units ───────────────────────────────────────────────────────────────

test("args: --lane required, defaults come from the owners, bad input is refused", () => {
	assert.deepEqual(parseHostArgs(["node", "host"]).error, "--lane is required");
	const parsed = parseHostArgs(["node", "host", "--lane", "oc-1", "--model", "opencode/mimo-v2.6-flash-free", "--stalled-minutes", "5", "--interval", "250"]);
	assert.equal(parsed.lane, "oc-1");
	assert.deepEqual(parsed.modelRef, { providerID: "opencode", modelID: "mimo-v2.6-flash-free" });
	assert.equal(parsed.stalledMinutes, 5);
	assert.equal(parsed.defaultMode, "steer");
	// The card lives in the owner's directory: <musterStateDir>/lanes, where the
	// muster state dir is PI_MUSTER_STATE_DIR else <agent>/state/muster.
	assert.ok(parsed.stateDir.endsWith(join(".pi", "agent", "state", "muster")), parsed.stateDir);
	assert.equal(ledgerPathFor(parsed.stateDir, "oc-1"), join(parsed.stateDir, "opencode", "oc-1.ledger.json"));
	assert.ok(parsed.agentDir.endsWith(join(".pi", "agent")));
	assert.equal(parsed.heartbeatMs, 15_000);
	// The Concord workspace follows --repo-root, else CONCORD_REPO_ROOT, else the lane's cwd.
	assert.equal(parseHostArgs(["node", "host", "--lane", "oc-1", "--cwd", "/tmp/lane-repo"]).repoRoot, "/tmp/lane-repo");
	assert.equal(parseHostArgs(["node", "host", "--lane", "oc-1", "--repo-root", "/tmp/bus-root"]).repoRoot, "/tmp/bus-root");
	assert.equal(parseHostArgs(["node", "host", "--lane", "oc-1", "--model", "mimo"]).error, "--model must be provider/model, got mimo");
	assert.match(parseHostArgs(["node", "host", "--lane", "oc-1", "--default-mode", "shout"]).error, /default-mode/);
	assert.match(parseHostArgs(["node", "host", "--lane", "oc-1", "--watch-cmd", "["]).error, /valid JSON/);
	assert.match(parseHostArgs(["node", "host", "--lane", "oc-1", "--nope"]).error, /unknown argument/);
	assert.equal(parseHostArgs(["node", "host", "--lane", "oc-1"]).registerMcp, true);
	assert.equal(parseHostArgs(["node", "host", "--lane", "oc-1", "--no-mcp"]).registerMcp, false);
	// The first message is the launcher's lane-worker trigger plus the brief pointer;
	// with no flag there is none, so an adopted lane's conversation is not reopened.
	assert.equal(parseHostArgs(["node", "host", "--lane", "oc-1"]).firstMessage, undefined);
	assert.equal(parseHostArgs(["node", "host", "--lane", "oc-1", "--first-message", "/lane-worker Read /tmp/b.md and do it."]).firstMessage, "/lane-worker Read /tmp/b.md and do it.");
});

test("model refs and the auth header are the shapes the API expects", () => {
	assert.deepEqual(parseModelRef("opencode/ling-3.1-flash-free"), { providerID: "opencode", modelID: "ling-3.1-flash-free" });
	assert.equal(parseModelRef("opencode"), undefined);
	assert.equal(parseModelRef("/x"), undefined);
	assert.equal(formatModelRef({ providerID: "opencode", modelID: "m" }), "opencode/m");
	assert.equal(basicAuthHeader("pw"), `Basic ${Buffer.from("opencode:pw").toString("base64")}`);
});

test("monitor lines parse the concord 0.10.4 shape", () => {
	assert.deepEqual(parseMonitorLine("[concord from oc-1 id=m_1] hello world"), { from: "oc-1", messageId: "m_1", text: "hello world" });
	assert.deepEqual(parseMonitorLine("[concord from oc-1 id=m_2] "), { from: "oc-1", messageId: "m_2", text: "" });
	assert.equal(parseMonitorLine("noise"), undefined);
	assert.equal(parseMonitorLine("[concord from oc-1] missing id"), undefined);
});

test("delivery ids are stable, prefixed, and scoped to one session", () => {
	const a = deliveryMessageId("ses_1", "m_1");
	assert.match(a, /^msg_oc_[0-9a-f]{20}$/);
	assert.equal(a, deliveryMessageId("ses_1", "m_1"));
	assert.notEqual(a, deliveryMessageId("ses_1", "m_2"));
	// OpenCode drops a repeated message id globally, so a new session needs a fresh one.
	assert.notEqual(a, deliveryMessageId("ses_2", "m_1"));
});

test("SSE parsing survives chunk splits, multiple frames and non-JSON lines", () => {
	const first = 'data: {"id":"e1","type":"session.idle","properties":{"sessionID":"ses_1"}}\n\ndata: {"id":"e2"';
	const parsed = parseSseChunk("", first);
	assert.equal(parsed.events.length, 1);
	assert.equal(parsed.events[0].type, "session.idle");
	const second = parseSseChunk(parsed.rest, ',"type":"session.status"}\n\n: keepalive\n\n');
	assert.equal(second.events.length, 1);
	assert.equal(second.events[0].type, "session.status");
	assert.equal(second.rest, "");
	assert.equal(parseSseChunk("", "data: not-json\n\n").events.length, 0);
});

test("control messages use A2's shape: operation plus params", () => {
	assert.deepEqual(interpretControlMessage('{"operation":"abort"}'), { operation: "abort" });
	assert.deepEqual(interpretControlMessage('{"operation":"setModel","params":{"modelId":"opencode/x"}}'), { operation: "setModel", modelId: "opencode/x" });
	assert.equal(interpretControlMessage('{"operation":"setModel","params":{}}').error, "setModel: modelId required");
	assert.equal(interpretControlMessage("please add a test"), undefined);
	assert.equal(interpretControlMessage('{"muster":"abort"}'), undefined);
	assert.equal(interpretControlMessage('{"operation":"deliver"}'), undefined);
	// A bare modelId keeps the lane's provider; provider/model wins when given.
	assert.deepEqual(resolveModelSwitch("ling-3.1-flash-free", { providerID: "opencode", modelID: "mimo" }), { providerID: "opencode", modelID: "ling-3.1-flash-free" });
	assert.deepEqual(resolveModelSwitch("zai/glm-5.3", { providerID: "opencode", modelID: "mimo" }), { providerID: "zai", modelID: "glm-5.3" });
	assert.equal(resolveModelSwitch("m", undefined), undefined);
});

test("delivery: steer and wake go now, followup waits only while busy", () => {
	assert.equal(shouldHold("steer", true), false);
	assert.equal(shouldHold("wake", true), false);
	assert.equal(shouldHold("followup", true), true);
	assert.equal(shouldHold("followup", false), false);
	const body = deliveryBody("do the thing", "unknown");
	assert.ok(body.startsWith("[Muster bus · from unknown]\ndo the thing"));
	assert.ok(body.endsWith(PEER_BOUNDARY_BASE));
	// Without a message id there is no reply target, so no reply line.
	assert.equal(deliveryBody("do the thing", "unknown", "").includes("reply_to_message_id"), false);
	// A lane with no lane_report tool is told how to put a report on its card.
	assert.match(deliveryBody("x", "orch", "m_1", "oc-c6"), /run: muster --agent oc-c6 report <kind>/);
	assert.equal(deliveryBody("x", "orch", "m_1").includes("muster --agent"), false, "no lane id, no report line");
	// With one, the lane is told what to reply to: that is how the sender reads
	// the answer through the bus instead of the pane.
	const withTarget = deliveryBody("do the thing", "orch", "c6fa7f29-92d7-47a2-9004-d18923a872d1");
	assert.ok(withTarget.endsWith(`${PEER_BOUNDARY_BASE} Reply through the bus when you have an answer or result: update_work operation:"reply" reply_to_message_id:"c6fa7f29-92d7-47a2-9004-d18923a872d1" with a fresh idempotency_key; do not acknowledge acknowledgements.`));
});

test("the peer boundary copy matches its owner in harness/muster/inbox.ts", () => {
	// inbox.ts cannot be imported here (TypeScript parameter properties are not
	// strip-only), so the literal is read and compared instead. If the owner
	// changes, this fails rather than letting the copy drift.
	const source = readFileSync(fileURLToPath(new URL("../inbox.ts", import.meta.url)), "utf8");
	const match = /const PEER_BOUNDARY_BASE =\s*\n?\s*"([^"]+)"/.exec(source);
	assert.ok(match, "PEER_BOUNDARY_BASE is still declared in inbox.ts");
	assert.equal(PEER_BOUNDARY_BASE, match[1]);
});

test("ledger: absent or corrupt reads as empty, ids dedupe and are bounded", () => {
	const dir = mkdtempSync(join(tmpdir(), "oc-ledger-"));
	const path = ledgerPathFor(dir, "oc-1");
	assert.deepEqual(readLedger(path, readFileSync), []);
	// Sidecars never sit in the card directory: the lane directory reads every
	// *.json there as a card, so a ledger in it would be a phantom lane.
	assert.equal(path, join(laneRuntimeDir(dir), "oc-1.ledger.json"));
	assert.notEqual(dirname(path), laneCardsDir(dir));
	assert.equal(serverRecordPathFor(dir, "oc-1"), join(laneRuntimeDir(dir), "oc-1.server.json"));
	mkdirSync(laneRuntimeDir(dir), { recursive: true });
	writeFileSync(path, "{ not json");
	assert.deepEqual(readLedger(path, readFileSync), []);
	let ids: string[] = [];
	ids = withLedgerId(ids, "m_1");
	ids = withLedgerId(ids, "m_2");
	ids = withLedgerId(ids, "m_1");
	assert.deepEqual(ids, ["m_2", "m_1"]);
	assert.deepEqual(withLedgerId(["a", "b", "c"], "d", 3), ["b", "c", "d"]);
});

test("the assistant error comes from the newest assistant message, and the read asks for the tail only", () => {
	assert.equal(MESSAGE_TAIL_QUERY, "?limit=1");
	assert.equal(MESSAGE_SCAN_QUERY, "?limit=20");
	const err = { info: { role: "assistant", error: { name: "UnknownError", data: { message: "wall" } } }, parts: [] };
	assert.equal(assistantErrorFrom([err]), "UnknownError: wall");
	assert.equal(assistantErrorFrom([{ info: { role: "assistant" }, parts: [] }]), undefined, "a clean assistant message clears the error");
	assert.equal(assistantErrorFrom([err, { info: { role: "user" }, parts: [] }]), "UnknownError: wall", "a trailing user prompt does not hide the error");
	assert.equal(assistantErrorFrom([]), undefined);
	assert.equal(assistantErrorFrom(undefined), undefined);
});

test("lane config turns snapshots off and keeps whatever else the caller passed", () => {
	assert.deepEqual(JSON.parse(laneConfigContent(undefined)), { snapshot: false });
	assert.deepEqual(JSON.parse(laneConfigContent("")), { snapshot: false });
	assert.deepEqual(JSON.parse(laneConfigContent('{"snapshot":true,"theme":"x"}')), { snapshot: false, theme: "x" });
	assert.deepEqual(JSON.parse(laneConfigContent("{ not json")), { snapshot: false });
	assert.deepEqual(JSON.parse(laneConfigContent("[1]")), { snapshot: false });
});

// ─── End-to-end host run against a stub opencode server ──────────────────────

interface StubState {
	port: number;
	requests: Array<{ method: string; path: string; auth: string | undefined; body: unknown }>;
	sse: ServerResponse | undefined;
	prompts: Array<Record<string, unknown>>;
	modelSwitches: Array<Record<string, unknown>>;
	aborts: number;
	mcp: Array<Record<string, unknown>>;
	messageList: Array<Record<string, unknown>>;
	permissions: Array<Record<string, unknown>>;
	/** What GET /session/status reports for this session (the real server does too). */
	busyType: "idle" | "busy" | "retry";
	/** What GET /session/<id> reports: the adopted conversation's own model and directory. */
	sessionModel: { id: string; providerID: string; variant?: string };
	sessionDirectory: string;
	/** Query string of every GET /session/<id>/message (the list route) the host made. */
	messageReads: string[];
	messageReadDelayMs: number;
	openMessageReads: number;
	maxOpenMessageReads: number;
}

/** A lane host is spawned with its own database, exactly as the recipe does. */
function laneEnv(stateDir: string, lane: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	// The learned walls live under the lane's own state dir: a host that learns a wall must
	// not write into the live `~/.pi/agent/state/provider-walls.json` from a test.
	return { ...process.env, OPENCODE_SERVER_PASSWORD: PASSWORD, OPENCODE_DB: join(stateDir, "lanes", `${lane}.db`), PI_PROVIDER_WALLS_PATH: join(stateDir, "provider-walls.json"), ...extra };
}

/** The same environment with no lane database, which is the state the host must refuse. */
function withoutLaneDatabase(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const copy = { ...env };
	delete copy.OPENCODE_DB;
	return copy;
}

async function startStub(): Promise<{ stub: StubState; server: Server }> {
	const stub: StubState = { port: 0, requests: [], sse: undefined, prompts: [], modelSwitches: [], aborts: 0, mcp: [], messageList: [], permissions: [], busyType: "idle", sessionModel: { id: "mimo-v2.6-flash-free", providerID: "opencode", variant: "default" }, sessionDirectory: process.cwd(), messageReads: [], messageReadDelayMs: 0, openMessageReads: 0, maxOpenMessageReads: 0 };
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => (raw += chunk));
		req.on("end", () => {
			let body: unknown;
			try {
				body = raw === "" ? undefined : JSON.parse(raw);
			} catch {
				body = raw;
			}
			stub.requests.push({ method: req.method ?? "", path: req.url ?? "", auth: req.headers.authorization, body });
			if (req.headers.authorization !== AUTH) {
				res.writeHead(401).end('{"name":"Unauthorized"}');
				return;
			}
			const url = new URL(req.url ?? "", "http://stub");
			const path = url.pathname;
			if (path === "/global/health") return void res.writeHead(200, { "Content-Type": "application/json" }).end('{"healthy":true,"version":"1.18.35"}');
			if (path === "/session" && req.method === "POST") return void res.writeHead(200, { "Content-Type": "application/json" }).end('{"id":"ses_test1"}');
			if (path === "/session/status") return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ses_test1: { type: stub.busyType } }));
			if (path === "/permission") return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(stub.permissions));
			if (path === "/question") return void res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
			if (path === "/mcp" && req.method === "POST") {
				stub.mcp.push(body as Record<string, unknown>);
				return void res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
			}
			if (path === "/session/ses_test1/message") {
				// The real server honors ?limit=N as the newest N messages.
				const limit = Number(url.searchParams.get("limit") ?? "0");
				const rows = limit > 0 ? stub.messageList.slice(-limit) : stub.messageList;
				stub.messageReads.push(url.search);
				stub.openMessageReads += 1;
				stub.maxOpenMessageReads = Math.max(stub.maxOpenMessageReads, stub.openMessageReads);
				// A slow read: a host that stacks reads shows it as overlap.
				return void setTimeout(() => {
					stub.openMessageReads -= 1;
					res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(rows));
				}, stub.messageReadDelayMs);
			}
			if (path === "/session/ses_test1" && req.method === "GET") {
				return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: "ses_test1", directory: stub.sessionDirectory, model: stub.sessionModel }));
			}
			if (path.startsWith("/session/ses_test1/message/")) {
				const id = path.slice("/session/ses_test1/message/".length);
				const found = stub.messageList.find((message) => (message as { info?: { id?: string } }).info?.id === id);
				return found === undefined ? void res.writeHead(404).end("{}") : void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(found));
			}
			if (path === "/session/ses_test1/prompt_async" && req.method === "POST") {
				stub.prompts.push(body as Record<string, unknown>);
				return void res.writeHead(204).end();
			}
			if (path === "/api/session/ses_test1/model" && req.method === "POST") {
				stub.modelSwitches.push(body as Record<string, unknown>);
				return void res.writeHead(204).end();
			}
			if (path === "/session/ses_test1/abort" && req.method === "POST") {
				stub.aborts += 1;
				return void res.writeHead(200, { "Content-Type": "application/json" }).end("true");
			}
			if (path === "/event") {
				res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
				stub.sse = res;
				return;
			}
			res.writeHead(404).end("{}");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	stub.port = typeof address === "object" && address !== null ? address.port : 0;
	return { stub, server };
}

async function waitFor<T>(check: () => T | undefined | false, timeoutMs: number, label: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = check();
		if (value !== undefined && value !== false) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/**
 * An agent dir with the live provider-pool's first quota shape only, so the
 * wall path is exercised hermetically: the error text the stub reports is built
 * from that shape's own `match`.
 */
/**
 * The repository's own provider-pool.json as a lane's agent dir, shapes and all.
 * The wall wordings a provider really sends are matched against the owner's whole
 * list, so removing a wording that a provider uses fails here.
 */
function agentDirWithRepoQuotaShapes(): string {
	const agentDir = mkdtempSync(join(tmpdir(), "oc-agent-repo-"));
	writeFileSync(join(agentDir, "provider-pool.json"), readFileSync(poolConfigPath(), "utf8"));
	return agentDir;
}

function agentDirWithFirstQuotaShape(): { agentDir: string; shape: { id: string; match: string } } {
	const live = JSON.parse(readFileSync(join(process.env.HOME ?? "/home/operator", ".pi", "agent", "provider-pool.json"), "utf8"));
	const shape = live.quotaShapes[0] as { id: string; match: string };
	const agentDir = mkdtempSync(join(tmpdir(), "oc-agent-"));
	writeFileSync(join(agentDir, "provider-pool.json"), `${JSON.stringify({ ...live, quotaShapes: [shape] }, null, "\t")}\n`);
	return { agentDir, shape };
}

test("host: adopting a session keeps that session's model, and a different directory is warned about", { timeout: 60_000 }, async () => {
	const { stub, server } = await startStub();
	stub.sessionModel = { id: "mimo-v2.6-flash-free", providerID: "opencode", variant: "default" };
	stub.sessionDirectory = "/somewhere/else";
	const stateDir = mkdtempSync(join(tmpdir(), "oc-adopt-"));
	const { agentDir } = agentDirWithFirstQuotaShape();
	const messageFile = join(stateDir, "watch-lines.txt");
	writeFileSync(messageFile, "");
	let stdout = "";
	let stderr = "";
	let child: ChildProcess | undefined;
	try {
		child = spawn(process.execPath, [
			...loaderArgs(),
			HOST,
			"--lane", "oc-adopt",
			"--cwd", process.cwd(),
			// No --model: the adopted session's own model is the model of the lane.
			"--session", "ses_test1",
			"--endpoint", `http://127.0.0.1:${stub.port}`,
			"--state-dir", stateDir,
			"--agent-dir", agentDir,
			"--repo-root", stateDir,
			"--heartbeat-ms", "300",
			"--watch-cmd", JSON.stringify(["bash", "-c", `tail -n +1 -f ${messageFile}`]),
		], {
			env: laneEnv(stateDir, "oc-adopt"),
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
		child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

		const card = await waitFor(() => readLaneCard(stateDir, "oc-adopt"), 20_000, "adopted-session card");
		assert.equal(card.sessionId, "ses_test1", "the session was adopted, not created");
		assert.equal(card.model, "opencode/mimo-v2.6-flash-free", "the adopted session's model is kept when --model is absent");
		assert.ok(stdout.includes("adopted session ses_test1"), `stdout should name the adoption, got: ${stdout.slice(0, 200)}`);
		assert.ok(stdout.includes("adopted session model opencode/mimo-v2.6-flash-free"), `stdout should name the kept model, got: ${stdout.slice(0, 200)}`);
		assert.ok(stderr.includes("session directory /somewhere/else differs from"), `stderr should warn about the directory, got: ${stderr.slice(0, 200)}`);
	} finally {
		if (child !== undefined && child.exitCode === null) {
			child.kill("SIGTERM");
			await new Promise((resolve) => child?.on("exit", resolve));
		}
		server.close();
	}
});

test("host: card through the owner, auth, one delivery per messageId, held followup, verbs, teardown", { timeout: 60_000 }, async () => {
	const { stub, server } = await startStub();
	const stateDir = mkdtempSync(join(tmpdir(), "oc-host-"));
	const { agentDir, shape } = agentDirWithFirstQuotaShape();
	const lane = "oc-test";
	const messageFile = join(stateDir, "watch-lines.txt");
	writeFileSync(messageFile, "");
	const say = (line: string) => appendFileSync(messageFile, `${line}\n`);
	let child: ChildProcess | undefined;
	try {
		child = spawn(process.execPath, [
			...loaderArgs(),
			HOST,
			"--lane", lane,
			"--cwd", process.cwd(),
			"--model", "opencode/mimo-v2.6-flash-free",
			"--endpoint", `http://127.0.0.1:${stub.port}`,
			"--state-dir", stateDir,
			"--agent-dir", agentDir,
			"--repo-root", stateDir,
			"--default-mode", "followup",
			"--heartbeat-ms", "300",
			"--watch-cmd", JSON.stringify(["bash", "-c", `tail -n +1 -f ${messageFile}`]),
		], {
			env: laneEnv(stateDir, lane),
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout?.on("data", () => {});
		child.stderr?.on("data", () => {});

		// The card is written through the owner: <stateDir>/muster/lanes/<lane>.json.
		const card = await waitFor(() => readLaneCard(stateDir, lane), 20_000, "first card");
		assert.equal(card.laneId, lane);
		assert.equal(card.harness, "opencode");
		assert.equal(card.state, "idle");
		assert.equal(card.model, "opencode/mimo-v2.6-flash-free");
		assert.equal(card.wall, null);
		assert.equal(card.endpoint, `http://127.0.0.1:${stub.port}`);
		assert.equal(card.sessionId, "ses_test1");
		assert.equal(typeof card.since, "number");
		assert.equal(typeof card.updatedAt, "number");
		assert.ok(existsSync(join(laneCardsDir(stateDir), `${lane}.json`)), "the owner's card path is used");
		const record = JSON.parse(readFileSync(serverRecordPathFor(stateDir, lane), "utf8"));
		assert.equal(record.endpoint, `http://127.0.0.1:${stub.port}`);
		assert.equal(record.sessionId, "ses_test1");
		assert.equal(record.password, PASSWORD);
		assert.equal(statSync(serverRecordPathFor(stateDir, lane)).mode & 0o777, 0o600);

		// One brief, sent twice with the same Concord message id, is delivered once.
		say("[concord from orch id=m_1] please add one unit test");
		say("[concord from orch id=m_1] please add one unit test");
		await waitFor(() => stub.prompts.length >= 1, 15_000, "first delivery");
		await new Promise((resolve) => setTimeout(resolve, 600));
		assert.equal(stub.prompts.length, 1, "duplicate messageId is not delivered twice");
		const first = stub.prompts[0] as { messageID?: string; parts: Array<{ text: string }> };
		assert.equal(first.messageID, deliveryMessageId("ses_test1", "m_1"));
		assert.ok(first.parts[0].text.includes("please add one unit test"));
		assert.ok(first.parts[0].text.includes(PEER_BOUNDARY_BASE));
		// The lane is told which bus message to answer, so the sender reads the
		// answer through the bus rather than the pane.
		assert.ok(first.parts[0].text.includes('reply_to_message_id:"m_1"'), "the reply target is in the delivered prompt");
		assert.ok(first.parts[0].text.includes(`muster --agent ${lane} report`), "the lane is told how to report to its card");
		assert.ok(stub.requests.every((entry) => entry.auth === AUTH), "every request carries the per-lane password");

		// Concord MCP is registered through POST /mcp.
		assert.equal(stub.mcp.length, 1);
		const config = (stub.mcp[0] as { config: { type: string; command: string[]; environment: Record<string, string> } }).config;
		assert.equal(config.type, "local");
		assert.ok(config.command[0].endsWith("concord-mcp"));
		assert.equal(config.environment.CONCORD_AGENT_ID, lane);
		assert.equal(config.environment.CONCORD_REPO_ROOT, stateDir, "the lane's Concord workspace is --repo-root");

		// Delivery proof: the message id is readable from the session, pendingIn returns to 0.
		await waitFor(() => (readLaneCard(stateDir, lane)?.pendingIn as number) >= 1, 5000, "pendingIn counts the delivery");
		stub.messageList.push({ info: { id: deliveryMessageId("ses_test1", "m_1"), role: "user" }, parts: [{ type: "text", text: deliveryBody("please add one unit test", "orch") }] });
		await waitFor(() => (readLaneCard(stateDir, lane)?.pendingIn as number) === 0, 5000, "pendingIn clears once the message is readable");
		assert.ok(stub.requests.some((entry) => entry.path === `/session/ses_test1/message/${deliveryMessageId("ses_test1", "m_1")}`), "delivery proof reads the exact message id");

		// The owner's wall reading: the last assistant message carries a shape from the pool.
		// A report filed on the card (`muster report` does this) survives the host's
		// own heartbeat, which rebuilds the card every beat (OpenCode lanes showed
		// lastReport none even after they reported, 2026-10-08).
		assert.equal(recordLaneReport(stateDir, lane, { kind: "working", summary: "halfway through the brief", at: Date.now() }), true);
		await new Promise((resolve) => setTimeout(resolve, 1000));
		assert.equal(readLaneCard(stateDir, lane)?.lastReport?.summary, "halfway through the brief", "the heartbeat keeps the lane's last report");
		// It is read when the turn ends (busy to idle), not on a timer.
		await waitFor(() => stub.sse !== undefined, 15_000, "event stream");
		const readsBeforeWall = stub.messageReads.length;
		await new Promise((resolve) => setTimeout(resolve, 1000));
		assert.equal(stub.messageReads.length, readsBeforeWall, "an idle lane does not read its session on the heartbeat");
		stub.messageList.push({ info: { id: "msg_err", role: "assistant", error: { name: "UnknownError", data: { message: shape.match } } }, parts: [] });
		stub.busyType = "busy";
		stub.sse?.write(`data: ${JSON.stringify({ type: "session.status", properties: { sessionID: "ses_test1", status: { type: "busy" } } })}\n\n`);
		await waitFor(() => readLaneCard(stateDir, lane)?.state === "running", 10_000, "running before the wall");
		stub.busyType = "idle";
		stub.sse?.write(`data: ${JSON.stringify({ type: "session.idle", properties: { sessionID: "ses_test1" } })}\n\n`);
		await waitFor(() => readLaneCard(stateDir, lane)?.state === "quota-walled", 10_000, "quota-walled state");
		assert.equal((readLaneCard(stateDir, lane)?.wall as { shapeId: string }).shapeId, shape.id);
		// The next turn starts clean.
		stub.messageList.pop();
		stub.busyType = "busy";
		stub.sse?.write(`data: ${JSON.stringify({ type: "session.status", properties: { sessionID: "ses_test1", status: { type: "busy" } } })}\n\n`);
		await waitFor(() => readLaneCard(stateDir, lane)?.state === "running", 10_000, "wall clears when the next turn starts");

		// A busy session holds a followup until session.idle, then delivers it.
		await waitFor(() => readLaneCard(stateDir, lane)?.state === "running", 15_000, "running state");
		// An open permission request is OpenCode's own `waiting`, and it wins over running.
		stub.permissions.push({ id: "perm_1", sessionID: "ses_test1", permission: "bash" });
		await waitFor(() => readLaneCard(stateDir, lane)?.state === "waiting", 15_000, "waiting state on an open permission request");
		stub.permissions.length = 0;
		await waitFor(() => readLaneCard(stateDir, lane)?.state === "running", 15_000, "back to running once the request closes");
		say("[concord from orch id=m_2] second note");
		await new Promise((resolve) => setTimeout(resolve, 800));
		assert.equal(stub.prompts.length, 1, "followup waits while the session is busy");
		assert.equal(readLaneCard(stateDir, lane)?.pendingIn, 1, "a held followup counts as pending in");
		stub.busyType = "idle";
		stub.sse?.write(`data: ${JSON.stringify({ type: "session.idle", properties: { sessionID: "ses_test1" } })}\n\n`);
		await waitFor(() => stub.prompts.length === 2, 15_000, "held followup delivered on idle");
		assert.ok((stub.prompts[1] as { parts: Array<{ text: string }> }).parts[0].text.includes("second note"));

		// A malformed control message is refused without taking the host down.
		say(`[concord from orch id=m_bad] ${JSON.stringify({ operation: "setModel", params: {} })}`);
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.equal(stub.modelSwitches.length, 0, "a malformed setModel switches nothing");

		// The verbs arrive as control messages on the peer channel (A2's shape).
		const promptsBeforeControls = stub.prompts.length;
		say(`[concord from orch id=m_3] ${JSON.stringify({ operation: "abort" })}`);
		await waitFor(() => stub.aborts === 1, 15_000, "abort verb");
		say(`[concord from orch id=m_4] ${JSON.stringify({ operation: "setModel", params: { modelId: "ling-3.1-flash-free" } })}`);
		await waitFor(() => stub.modelSwitches.length === 1, 15_000, "setModel verb");
		assert.deepEqual(stub.modelSwitches[0], { model: { id: "ling-3.1-flash-free", providerID: "opencode" } });
		await waitFor(() => readLaneCard(stateDir, lane)?.model === "opencode/ling-3.1-flash-free", 15_000, "card model update");
		// Control is control: it never reaches the conversation as a prompt.
		assert.equal(stub.prompts.length, promptsBeforeControls, "a control message is not delivered as a prompt");

		// `muster control <lane> <verb>` leaves a request file (lib/lane-control.ts), the queue a Pi lane drains.
		// The host takes it, applies the verb and writes the outcome on the card (F4).
		enqueueLaneControl(stateDir, { laneId: lane, operation: "abort", from: "cc-bus" });
		await waitFor(() => stub.aborts === 2, 15_000, "abort verb from the control queue");
		await waitFor(() => readLaneCard(stateDir, lane)?.lastControl?.operation === "abort", 15_000, "abort outcome on the card");
		assert.equal(readLaneCard(stateDir, lane)?.lastControl?.ok, true);
		assert.equal(existsSync(laneControlFile(stateDir, lane)), false, "the request is taken, not left to repeat");
		enqueueLaneControl(stateDir, { laneId: lane, operation: "setModel", params: { modelId: "ling-3.1-flash-free" }, from: "cc-bus" });
		await waitFor(() => stub.modelSwitches.length === 2, 15_000, "setModel verb from the control queue");
		await waitFor(() => readLaneCard(stateDir, lane)?.lastControl?.operation === "setModel", 15_000, "setModel outcome on the card");
		assert.equal(stub.prompts.length, promptsBeforeControls, "a queued control request is not delivered as a prompt");

		// Teardown removes the card and the server record, and keeps the ledger.
		child.kill("SIGTERM");
		await new Promise((resolve) => child?.on("exit", resolve));
		assert.equal(readLaneCard(stateDir, lane), undefined, "the card is removed on a clean exit");
		assert.equal(existsSync(serverRecordPathFor(stateDir, lane)), false, "the server record is removed");
		assert.ok(existsSync(ledgerPathFor(stateDir, lane)), "the ledger survives the restart");
		// The card directory holds cards only: a sidecar there would be read as a lane.
		const sidecars = readdirSync(laneCardsDir(stateDir)).filter((name) => name.includes(".ledger.") || name.includes(".server."));
		assert.deepEqual(sidecars, [], `card directory should hold no sidecars, found ${sidecars.join(", ")}`);
		assert.deepEqual(readdirSync(laneRuntimeDir(stateDir)), [`${lane}.ledger.json`], "the ledger lives in the runtime directory and survives the restart");
	} finally {
		if (child !== undefined && child.exitCode === null) child.kill("SIGKILL");
		server.close();
	}
});

test("host: a queued stop shuts the lane down through its own teardown; abort still only cancels a turn", { timeout: 60_000 }, async () => {
	const { stub, server } = await startStub();
	const stateDir = mkdtempSync(join(tmpdir(), "oc-host-stop-"));
	const { agentDir } = agentDirWithFirstQuotaShape();
	const lane = "oc-stop";
	const messageFile = join(stateDir, "watch-lines.txt");
	writeFileSync(messageFile, "");
	let child: ChildProcess | undefined;
	try {
		child = spawn(process.execPath, [
			...loaderArgs(),
			HOST,
			"--lane", lane,
			"--cwd", process.cwd(),
			"--model", "opencode/mimo-v2.6-flash-free",
			"--endpoint", `http://127.0.0.1:${stub.port}`,
			"--state-dir", stateDir,
			"--agent-dir", agentDir,
			"--repo-root", stateDir,
			"--default-mode", "followup",
			"--heartbeat-ms", "300",
			"--watch-cmd", JSON.stringify(["bash", "-c", `tail -n +1 -f ${messageFile}`]),
		], {
			env: laneEnv(stateDir, lane),
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout?.on("data", () => {});
		child.stderr?.on("data", () => {});
		const exited = new Promise<void>((resolve) => child?.on("exit", () => resolve()));

		await waitFor(() => readLaneCard(stateDir, lane), 20_000, "first card");
		await waitFor(() => existsSync(serverRecordPathFor(stateDir, lane)) || undefined, 20_000, "server record");

		enqueueLaneControl(stateDir, { laneId: lane, operation: "abort", from: "cc-xfer" });
		await waitFor(() => stub.aborts === 1, 15_000, "abort verb from the control queue");
		await waitFor(() => readLaneCard(stateDir, lane)?.lastControl?.operation === "abort", 15_000, "abort outcome on the card");
		assert.equal(child.exitCode, null, "abort does not stop the lane");

		enqueueLaneControl(stateDir, { laneId: lane, operation: "stop", from: "cc-xfer" });
		await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("the host did not exit on stop")), 15_000))]);
		assert.equal(stub.aborts, 1, "stop is not applied as an abort");
		assert.equal(readLaneCard(stateDir, lane), undefined, "a stopped lane removes its card (F4)");
		assert.equal(existsSync(serverRecordPathFor(stateDir, lane)), false, "the server record is removed");
		assert.equal(existsSync(laneControlFile(stateDir, lane)), false, "the stop request is taken, not left to repeat");
	} finally {
		if (child !== undefined && child.exitCode === null) child.kill("SIGKILL");
		server.close();
	}
});

test("host: a lane with no OPENCODE_DB refuses to start instead of sharing the agent's database", { timeout: 30_000 }, async () => {
	// The shared database is what makes three lanes stall on SQLite's one writer
	// per database, so a lane without its own must not start at all: the host
	// refuses before it spawns anything, names the variable, writes no card.
	const stateDir = mkdtempSync(join(tmpdir(), "oc-nodb-"));
	const lane = "oc-nodb";
	let stdout = "";
	let stderr = "";
	let child: ChildProcess | undefined;
	try {
		child = spawn(process.execPath, [
			...loaderArgs(),
			HOST,
			"--lane", lane,
			"--cwd", stateDir,
			// A binary that cannot be executed: if the guard runs first, nothing is spawned.
			"--opencode", join(stateDir, "opencode-that-does-not-exist"),
			"--state-dir", stateDir,
			"--repo-root", stateDir,
			"--heartbeat-ms", "300",
		], {
			env: withoutLaneDatabase({ ...process.env, OPENCODE_SERVER_PASSWORD: PASSWORD }),
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
		child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
		const code = await new Promise<number | null>((resolve) => child?.on("exit", resolve));
		assert.equal(code, EXIT_REFUSED, `expected a refusal, got ${code} (stdout: ${stdout}, stderr: ${stderr})`);
		assert.match(stderr, /OPENCODE_DB is not set/);
		assert.match(stderr, /--db/);
		assert.equal(readLaneCard(stateDir, lane), undefined, "a refused host writes no card");
		assert.equal(existsSync(join(laneRuntimeDir(stateDir), `${lane}.server.json`)), false, "a refused host publishes no server record");
	} finally {
		if (child !== undefined && child.exitCode === null) child.kill("SIGKILL");
	}
});

test("host: the lane database it starts on is named in its startup log", { timeout: 60_000 }, async () => {
	const { stub, server } = await startStub();
	const stateDir = mkdtempSync(join(tmpdir(), "oc-dbname-"));
	const { agentDir } = agentDirWithFirstQuotaShape();
	const messageFile = join(stateDir, "watch-lines.txt");
	writeFileSync(messageFile, "");
	const lane = "oc-dbname";
	const dbPath = join(stateDir, "lanes", `${lane}.db`);
	let stdout = "";
	let child: ChildProcess | undefined;
	try {
		child = spawn(process.execPath, [
			...loaderArgs(),
			HOST,
			"--lane", lane,
			"--cwd", process.cwd(),
			"--session", "ses_test1",
			"--endpoint", `http://127.0.0.1:${stub.port}`,
			"--state-dir", stateDir,
			"--agent-dir", agentDir,
			"--repo-root", stateDir,
			"--heartbeat-ms", "300",
			"--watch-cmd", JSON.stringify(["bash", "-c", `tail -n +1 -f ${messageFile}`]),
		], {
			env: laneEnv(stateDir, lane),
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
		await waitFor(() => readLaneCard(stateDir, lane) !== undefined, 20_000, "card with the lane database");
		assert.match(stdout, new RegExp(`lane database ${dbPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
	} finally {
		if (child !== undefined && child.exitCode === null) {
			child.kill("SIGTERM");
			await new Promise((resolve) => child?.on("exit", resolve));
		}
		server.close();
	}
});

test("host: session reads are bounded to the tail and never overlap", { timeout: 60_000 }, async () => {
	const { stub, server } = await startStub();
	stub.messageReadDelayMs = 1200;
	const stateDir = mkdtempSync(join(tmpdir(), "oc-reads-"));
	const { agentDir } = agentDirWithFirstQuotaShape();
	const messageFile = join(stateDir, "watch-lines.txt");
	writeFileSync(messageFile, "");
	const lane = "oc-reads";
	let child: ChildProcess | undefined;
	try {
		child = spawn(process.execPath, [
			...loaderArgs(),
			HOST,
			"--lane", lane,
			"--cwd", process.cwd(),
			"--session", "ses_test1",
			"--endpoint", `http://127.0.0.1:${stub.port}`,
			"--state-dir", stateDir,
			"--agent-dir", agentDir,
			"--repo-root", stateDir,
			"--heartbeat-ms", "200",
			"--watch-cmd", JSON.stringify(["bash", "-c", `tail -n +1 -f ${messageFile}`]),
		], {
			env: laneEnv(stateDir, lane),
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout?.on("data", () => {});
		child.stderr?.on("data", () => {});
		await waitFor(() => readLaneCard(stateDir, lane), 20_000, "first card");
		await waitFor(() => stub.sse !== undefined, 15_000, "event stream");
		// Several turn ends in a row, while each read takes longer than the heartbeat.
		for (let i = 0; i < 5; i += 1) {
			stub.sse?.write(`data: ${JSON.stringify({ type: "session.idle", properties: { sessionID: "ses_test1" } })}\n\n`);
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
		await new Promise((resolve) => setTimeout(resolve, 3000));
		assert.ok(stub.messageReads.length >= 2, `turn ends are read (got ${stub.messageReads.length})`);
		assert.ok(stub.messageReads.every((query) => query === MESSAGE_TAIL_QUERY), `only the tail is ever read, got ${[...new Set(stub.messageReads)].join(" ")}`);
		assert.equal(stub.maxOpenMessageReads, 1, "two session reads never run at once");
		// A read that outlasts the heartbeat does not stop the card from beating.
		const first = readLaneCard(stateDir, lane)?.updatedAt as number;
		await waitFor(() => (readLaneCard(stateDir, lane)?.updatedAt as number) > first, 5000, "card keeps beating");
	} finally {
		if (child !== undefined && child.exitCode === null) {
			child.kill("SIGTERM");
			await new Promise((resolve) => child?.on("exit", resolve));
		}
		server.close();
	}
});

test("host: the opencode server it spawns gets snapshots turned off", { timeout: 60_000 }, async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "oc-env-"));
	const envFile = join(stateDir, "opencode-env.txt");
	// A stand-in `opencode serve` that records the config env and answers the few
	// routes the host needs to come up.
	const fake = join(stateDir, "fake-opencode.mjs");
	writeFileSync(fake, `#!/usr/bin/env node
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(envFile)}, process.env.OPENCODE_CONFIG_CONTENT ?? "<unset>");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const json = (res, body) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
createServer((req, res) => {
	const path = new URL(req.url, "http://x").pathname;
	if (path === "/global/health") return json(res, { healthy: true });
	if (path === "/session" && req.method === "POST") return json(res, { id: "ses_fake" });
	if (path === "/session/status") return json(res, {});
	if (path === "/event") return void res.writeHead(200, { "Content-Type": "text/event-stream" });
	return json(res, []);
}).listen(port, "127.0.0.1");
`, { mode: 0o755 });
	const { agentDir } = agentDirWithFirstQuotaShape();
	const lane = "oc-env";
	let child: ChildProcess | undefined;
	try {
		child = spawn(process.execPath, [
			...loaderArgs(),
			HOST,
			"--lane", lane,
			"--cwd", process.cwd(),
			"--opencode", fake,
			"--state-dir", stateDir,
			"--agent-dir", agentDir,
			"--repo-root", stateDir,
			"--no-mcp",
			"--heartbeat-ms", "300",
			"--watch-cmd", JSON.stringify(["bash", "-c", "sleep 600"]),
		], {
			// A caller-supplied config survives; only snapshot is forced off.
			env: laneEnv(stateDir, lane, { OPENCODE_CONFIG_CONTENT: '{"snapshot":true,"autoupdate":false}' }),
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout?.on("data", () => {});
		child.stderr?.on("data", () => {});
		await waitFor(() => readLaneCard(stateDir, lane), 30_000, "card from the spawned server");
		assert.deepEqual(JSON.parse(readFileSync(envFile, "utf8")), { snapshot: false, autoupdate: false });
	} finally {
		if (child !== undefined && child.exitCode === null) {
			child.kill("SIGTERM");
			await new Promise((resolve) => child?.on("exit", resolve));
		}
	}
});

// ─── LC11: the host on the ledger ────────────────────────────────────────────

/**
 * The loader this process runs under, so a child loads the `.ts` owners the same way this file does (LC7's
 * helper). The host needs it too: `opencode-host.mjs` imports `control.ts`, whose parameter property a
 * type-stripping Node refuses, so a bare `node` dies at import before the host's own guards can answer.
 */
function loaderArgs(): string[] {
	const args: string[] = [];
	for (let at = 0; at < process.execArgv.length; at++) {
		if (process.execArgv[at] === "--import" && process.execArgv[at + 1] !== undefined) args.push("--import", process.execArgv[at + 1] as string);
	}
	return args.length > 0 ? args : ["--import", tsxLoaderPath()];
}

/** The real `startDaemon` in its own process: the owners block on it, so it cannot run in this one. */
function startLedgerDaemon(t: TestContext, dir: string): Promise<void> {
	const file = join(dir, "fixture-daemon.mjs");
	writeFileSync(
		file,
		[`import { startDaemon } from ${JSON.stringify(DAEMON)};`, "await startDaemon(process.env.MUSTER_FIXTURE_DIR);", 'process.stdout.write("READY\\n");'].join("\n"),
	);
	const child = spawn(NODE, [...loaderArgs(), file], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MUSTER_FIXTURE_DIR: dir } });
	let output = "";
	const collect = (chunk: Buffer): void => void (output += chunk.toString());
	child.stdout?.on("data", collect);
	child.stderr?.on("data", collect);
	t.after(async () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
		child.kill("SIGKILL");
		await exited;
	});
	return (async () => {
		const deadline = Date.now() + 20_000;
		while (!output.includes("READY")) {
			if (child.exitCode !== null || child.signalCode !== null) throw new Error(`the ledger daemon fixture exited before READY: ${output}`);
			if (Date.now() > deadline) throw new Error(`the ledger daemon fixture did not answer within 20 s: ${output}`);
			await new Promise((resolveWait) => setTimeout(resolveWait, 25));
		}
	})();
}

/**
 * LC11: `<stateDir>/backend.json` names the ledger, so the host takes the lane's
 * mail from the inbox owner, wakes on the ledger subscription, and writes no
 * `opencode/<lane>.ledger.json`. The round trip is the plan's: send, deliver
 * once, report.
 */
test("host: ledger mode drains through the inbox owner, delivers once, and keeps the report", { timeout: 120_000 }, async (t) => {
	const { stub, server } = await startStub();
	const stateDir = mkdtempSync(join(tmpdir(), "oc-ledger-"));
	const { agentDir } = agentDirWithFirstQuotaShape();
	const lane = "oc-ledger";
	// The switch file the flip tool writes (LC15); every owner reads it on every call.
	writeFileSync(backendPath(stateDir), JSON.stringify({ backend: "ledger", flipId: "lc11-test", at: "2026-10-17T00:00:00+03:00", cursor: "1" }));
	// Both sides are pointed at the state dir's own socket: a stale override in the
	// environment would send an owner to another `musterd`.
	const savedLedgerDir = process.env.MUSTER_LEDGER_DIR;
	delete process.env.MUSTER_LEDGER_DIR;
	t.after(() => {
		if (savedLedgerDir === undefined) delete process.env.MUSTER_LEDGER_DIR;
		else process.env.MUSTER_LEDGER_DIR = savedLedgerDir;
	});
	await startLedgerDaemon(t, stateDir);
	// One message, written through the owner exactly as `muster send` writes it.
	const firstId = writeInboxMessage(stateDir, { agent: lane, from: "orch", at: "2026-10-17T00:01:00.000Z", text: "please add one unit test", idempotencyKey: "lc11-1" });
	assert.match(firstId, /^[0-9a-f-]{36}$/u, "ledger mode answers with the message id, not a file path");
	const watchMarker = join(stateDir, "watch-ran.txt");
	let stdout = "";
	let stderr = "";
	let child: ChildProcess | undefined;
	try {
		const env = laneEnv(stateDir, lane);
		delete env.MUSTER_LEDGER_DIR;
		child = spawn(process.execPath, [
			...loaderArgs(),
			HOST,
			"--lane", lane,
			"--cwd", process.cwd(),
			"--model", "opencode/mimo-v2.6-flash-free",
			"--endpoint", `http://127.0.0.1:${stub.port}`,
			"--state-dir", stateDir,
			"--agent-dir", agentDir,
			"--repo-root", stateDir,
			"--no-mcp",
			"--heartbeat-ms", "300",
			// A watch command that would leave a mark: in ledger mode no Concord child runs.
			"--watch-cmd", JSON.stringify(["bash", "-c", `echo ran >> ${watchMarker}; sleep 600`]),
		], { env, stdio: ["ignore", "pipe", "pipe"] });
		child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
		child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

		// The card beats through the ledger owner, and the host names its mode. The message
		// waiting at start is delivered by the drain the subscription opens, so the lane is
		// already working when this first card lands; lane state itself is asserted by the
		// files-mode tests, not here.
		const card = await waitFor(() => readLaneCard(stateDir, lane), 30_000, "ledger card");
		assert.equal(card.harness, "opencode");
		assert.equal(card.sessionId, "ses_test1");
		assert.ok(stdout.includes("ledger mode: the inbox owner carries this lane's messages"), `stdout should name the mode, got: ${stdout.slice(0, 300)} / ${stderr.slice(-300)}`);

		// The message waiting at start is delivered once, under the id the bus holds.
		await waitFor(() => stub.prompts.length >= 1, 20_000, "the ledger message is delivered");
		const first = stub.prompts[0] as { messageID?: string; parts: Array<{ text: string }> };
		assert.equal(first.messageID, deliveryMessageId("ses_test1", firstId));
		assert.ok(first.parts[0].text.includes("please add one unit test"));
		// The ledger says delivered: nothing waiting, the message in the delivered history.
		await waitFor(() => listInboxMessages(stateDir, lane).length === 0, 15_000, "the message leaves the pending index");
		assert.equal(countInboxMessages(stateDir, lane), 0);
		assert.deepEqual(listDeliveredMessages(stateDir, lane, 5).map((message) => message.id), [firstId]);

		// A second send wakes the subscription, with no watch child and no poll.
		const secondId = writeInboxMessage(stateDir, { agent: lane, from: "orch", at: "2026-10-17T00:02:00.000Z", text: "and one more note", idempotencyKey: "lc11-2" });
		await waitFor(() => stub.prompts.length >= 2, 20_000, "the wake delivers the next message");
		await new Promise((resolveWait) => setTimeout(resolveWait, 800));
		assert.equal(stub.prompts.length, 2, "one message, one delivery");
		assert.equal((stub.prompts[1] as { messageID?: string }).messageID, deliveryMessageId("ses_test1", secondId));

		// No delivery ledger file and no Concord child in ledger mode (LC11).
		assert.equal(existsSync(ledgerPathFor(stateDir, lane)), false, "the ledger-mode host reads and writes no delivery ledger file");
		assert.equal(existsSync(watchMarker), false, "no concord inbox watch child runs in ledger mode");

		// A report lands on the card through the owners, and the heartbeat keeps it.
		assert.equal(recordLaneReport(stateDir, lane, { kind: "working", summary: "halfway through the brief", at: Date.now() }), true);
		await waitFor(() => readLaneCard(stateDir, lane)?.lastReport?.summary === "halfway through the brief", 15_000, "the report is on the ledger card");
		await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
		assert.equal(readLaneCard(stateDir, lane)?.lastReport?.summary, "halfway through the brief", "the heartbeat keeps the lane's last report");

		// A clean stop removes the card through the owner; the ledger keeps the messages.
		child.kill("SIGTERM");
		await new Promise((resolveExit) => child?.on("exit", resolveExit));
		assert.equal(readLaneCard(stateDir, lane), undefined, "the card is removed on a clean exit");
		assert.equal(listDeliveredMessages(stateDir, lane, 5).length, 2, "the delivered messages stay in the ledger");
		assert.equal(existsSync(ledgerPathFor(stateDir, lane)), false, "still no delivery ledger file");
	} finally {
		if (child !== undefined && child.exitCode === null) child.kill("SIGKILL");
		server.close();
	}
});

/**
 * A provider that fails every call must be reported, not silent. OpenCode carries a
 * wall as a `session.status` retry whose `message` is the provider's own wording: no
 * `session.error`, no `session.idle`, and the turn never becomes busy. Observed
 * 2026-10-18: an OpenCode lane on the free Zen ref read "running" with `wall: null`
 * for the best part of an hour, 405 stream errors in the log, no event to the
 * orchestrator — the retry text was "Free usage exceeded, subscribe to Go", which
 * matched no shape, and each retry status refreshed the activity clock, so the card
 * could not even reach its stall threshold.
 */
test("host: a session that only retries is walled by its recorded wording, and stalls when no shape matches", { timeout: 90_000 }, async () => {
	const { stub, server } = await startStub();
	const stateDir = mkdtempSync(join(tmpdir(), "oc-retry-"));
	const agentDir = agentDirWithRepoQuotaShapes();
	const lane = "oc-retry";
	const messageFile = join(stateDir, "watch-lines.txt");
	writeFileSync(messageFile, "");
	let child: ChildProcess | undefined;
	try {
		child = spawn(process.execPath, [
			...loaderArgs(),
			HOST,
			"--lane", lane,
			"--cwd", process.cwd(),
			"--model", "opencode/glm-5.3-flash-free",
			"--endpoint", `http://127.0.0.1:${stub.port}`,
			"--state-dir", stateDir,
			"--agent-dir", agentDir,
			"--repo-root", stateDir,
			"--no-mcp",
			"--heartbeat-ms", "300",
			"--watch-cmd", JSON.stringify(["bash", "-c", `tail -n +1 -f ${messageFile}`]),
		], {
			// The stall threshold is the owner's own override; a test needs it observable.
			env: laneEnv(stateDir, lane, { PI_LANES_STALLED_MINUTES: "0.05" }),
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout?.on("data", () => {});
		child.stderr?.on("data", () => {});
		await waitFor(() => readLaneCard(stateDir, lane), 30_000, "first card");
		await waitFor(() => stub.sse !== undefined, 15_000, "event stream");

		// The wording the free refs use, verbatim from the live server (GET /session/status).
		stub.busyType = "retry";
		stub.sse?.write(
			`data: ${JSON.stringify({ type: "session.status", properties: { sessionID: "ses_test1", status: { type: "retry", attempt: 1, message: "Free usage exceeded, subscribe to Go", next: Date.now() + 3_600_000 } } })}\n\n`,
		);
		const walled = await waitFor(
			() => {
				const card = readLaneCard(stateDir, lane);
				return card?.state === "quota-walled" ? card : undefined;
			},
			15_000,
			"quota-walled on the recorded retry wording",
		);
		assert.equal((walled.wall as { shapeId: string }).shapeId, "free-tier-limit");

		// A busy turn is progress and clears the wall.
		stub.busyType = "busy";
		stub.sse?.write(`data: ${JSON.stringify({ type: "session.status", properties: { sessionID: "ses_test1", status: { type: "busy" } } })}\n\n`);
		await waitFor(() => readLaneCard(stateDir, lane)?.state === "running", 15_000, "running on a busy turn");

		// The same stream of retries, with a wording no shape records, is not progress:
		// the clock ages and the lane reports stalled instead of running forever.
		stub.busyType = "retry";
		const retries = setInterval(
			() =>
				stub.sse?.write(
					`data: ${JSON.stringify({ type: "session.status", properties: { sessionID: "ses_test1", status: { type: "retry", attempt: 2, message: "Internal Server Error" } } })}\n\n`,
				),
			200,
		);
		try {
			const stalled = await waitFor(
				() => {
					const card = readLaneCard(stateDir, lane);
					return card?.state === "stalled" ? card : undefined;
				},
				30_000,
				"stalled while the provider only retries",
			);
			assert.equal(stalled.wall, null, "an unrecorded wording is not a wall");
		} finally {
			clearInterval(retries);
		}

		child.kill("SIGTERM");
		await new Promise((resolveExit) => child?.on("exit", resolveExit));
		assert.equal(readLaneCard(stateDir, lane), undefined, "the card is removed on a clean exit");
	} finally {
		// SIGTERM is the host's own teardown, which stops the watch child it spawned; a bare
		// SIGKILL leaves that child behind and the guarded runner waiting on it forever.
		if (child !== undefined && child.exitCode === null) {
			const exited = new Promise((resolveExit) => child?.on("exit", resolveExit));
			child.kill("SIGTERM");
			await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 3000))]);
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
		server.close();
	}
});

/**
 * A model switch must start the lane clean, and the wall must stay with the ref that
 * produced it. Observed live 2026-10-18 22:01 on oc-maps: the free ref walled,
 * `muster control set-model` moved the lane to zai-coding-plan/glm-5.3-flash, the host
 * kept the free ref's "Free usage exceeded" and the card stayed quota-walled on the new
 * ref, so muster-tick moved the lane back to the free ref and then cycled it through the
 * weaker free shortlist every two minutes (events log 21:49-22:01).
 */
test("host: a model switch clears the wall keyed to the ref the lane left, learns it under that full ref, and the new ref walls on its own wording", { timeout: 90_000 }, async () => {
	const { stub, server } = await startStub();
	const stateDir = mkdtempSync(join(tmpdir(), "oc-switch-"));
	const agentDir = agentDirWithRepoQuotaShapes();
	const lane = "oc-switch";
	const messageFile = join(stateDir, "watch-lines.txt");
	writeFileSync(messageFile, "");
	const say = (line: string) => appendFileSync(messageFile, `${line}\n`);
	let child: ChildProcess | undefined;
	try {
		child = spawn(process.execPath, [
			...loaderArgs(),
			HOST,
			"--lane", lane,
			"--cwd", process.cwd(),
			"--model", "opencode/glm-5.3-flash-free",
			"--endpoint", `http://127.0.0.1:${stub.port}`,
			"--state-dir", stateDir,
			"--agent-dir", agentDir,
			"--repo-root", stateDir,
			"--no-mcp",
			"--heartbeat-ms", "300",
			"--watch-cmd", JSON.stringify(["bash", "-c", `tail -n +1 -f ${messageFile}`]),
		], { env: laneEnv(stateDir, lane), stdio: ["ignore", "pipe", "pipe"] });
		child.stdout?.on("data", () => {});
		child.stderr?.on("data", () => {});
		await waitFor(() => readLaneCard(stateDir, lane), 30_000, "first card");
		await waitFor(() => stub.sse !== undefined, 15_000, "event stream");

		// The free ref's own wall: the retry wording, verbatim from the live server.
		stub.busyType = "retry";
		stub.sse?.write(
			`data: ${JSON.stringify({ type: "session.status", properties: { sessionID: "ses_test1", status: { type: "retry", attempt: 1, message: "Free usage exceeded, subscribe to Go", next: Date.now() + 3_600_000 } } })}\n\n`,
		);
		const walled = await waitFor(
			() => {
				const card = readLaneCard(stateDir, lane);
				return card?.state === "quota-walled" ? card : undefined;
			},
			15_000,
			"quota-walled on the free ref",
		);
		assert.equal(walled.model, "opencode/glm-5.3-flash-free");
		assert.equal((walled.wall as { shapeId: string }).shapeId, "free-tier-limit");

		// The wall is learned through the pool's one owner (learnQuotaWall), so the tick's walk
		// reads it and skips a ref that is still walled. The owner keys it by the pool's own
		// rule: `opencode/glm-5.3-flash-free` is not in the file's `freeRefs`, so it carries the
		// `opencode` provider key — the key `quotaFallback` reads for this ref as well.
		const wallsPath = join(stateDir, "provider-walls.json");
		const learned = await waitFor(
			() => {
				try {
					const walls = JSON.parse(readFileSync(wallsPath, "utf8")) as Record<string, { reason?: string }>;
					return walls["opencode"] ?? undefined;
				} catch {
					return undefined;
				}
			},
			10_000,
			"the free ref's wall learned in the pool's walls file",
		);
		assert.equal(learned.reason, "free-tier-limit");

		// The tick marks the wall it acted on (`wall.handledAt`); the beat rebuilds the card, so
		// the mark has to survive or the tick acts on one wall every beat.
		const marked = readLaneCard(stateDir, lane);
		assert.ok(marked?.wall);
		writeLaneCard(stateDir, { ...marked, wall: { ...marked.wall, handledAt: 1234 } });
		await waitFor(() => readLaneCard(stateDir, lane)?.wall?.handledAt === 1234, 10_000, "the handledAt mark survives a heartbeat");

		// The switch the tick queues for a walled lane: `muster control <lane> set-model <ref>`.
		say(`[concord from orch id=m_sw] ${JSON.stringify({ operation: "setModel", params: { modelId: "zai-coding-plan/glm-5.3-flash" } })}`);
		await waitFor(() => stub.modelSwitches.length === 1, 20_000, "the model switch");
		const clean = await waitFor(
			() => {
				const card = readLaneCard(stateDir, lane);
				return card?.model === "zai-coding-plan/glm-5.3-flash" && card.state !== "quota-walled" ? card : undefined;
			},
			20_000,
			"the switched-to ref starts clean",
		);
		assert.equal(clean.wall, null, "a switch starts the lane clean until a turn on the new model fails");

		// A turn on the new model that fails with its own wording walls the lane on the new ref.
		stub.sse?.write(
			`data: ${JSON.stringify({ type: "session.status", properties: { sessionID: "ses_test1", status: { type: "retry", attempt: 1, message: "Weekly usage limit, resets at 2026-10-19T04:00:00Z", next: Date.now() + 3_600_000 } } })}\n\n`,
		);
		const rewalled = await waitFor(
			() => {
				const card = readLaneCard(stateDir, lane);
				return card?.state === "quota-walled" ? card : undefined;
			},
			15_000,
			"walled on the new ref's own wording",
		);
		assert.equal(rewalled.model, "zai-coding-plan/glm-5.3-flash");
		assert.equal((rewalled.wall as { shapeId: string }).shapeId, "weekly-plan-limit");

		child.kill("SIGTERM");
		await new Promise((resolveExit) => child?.on("exit", resolveExit));
		assert.equal(readLaneCard(stateDir, lane), undefined, "the card is removed on a clean exit");
	} finally {
		if (child !== undefined && child.exitCode === null) {
			const exited = new Promise((resolveExit) => child?.on("exit", resolveExit));
			child.kill("SIGTERM");
			await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 3000))]);
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
		server.close();
	}
});
