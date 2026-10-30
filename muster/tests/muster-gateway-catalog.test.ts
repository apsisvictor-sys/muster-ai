import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { OPENCODE_MODELS_RETRY_MS, OPENCODE_MODELS_TTL_MS, opencodeModelsReader, readPiSettingsModels, type RunCaptured } from "../gateway/catalog.ts";
import { LAUNCH_TAIL_LINES, launchDetail, runLaunchScript } from "../gateway/launch.ts";
import { findBriefRedaction } from "../gateway/brief-redaction.ts";
import { AUDIT_FILE } from "../gateway/state.ts";
import { SEND_LOG_FILE } from "../send.ts";
import { createGatewayTools, ToolRefusal, type ActionToolDeps, type GatewayTool } from "../gateway/tools.ts";
import { redactSensitiveText } from "../../core/self-improving-redactor.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT = readFileSync(join(HERE, "fixtures", "gateway-test-report-2026-10-10.md"), "utf8");

const tmp = (): string => mkdtempSync(join(tmpdir(), "muster-gateway-catalog-"));

// ─── P1: the OpenCode and Pi catalogs ────────────────────────────────────────

test("opencode models: one run per TTL, shared by concurrent callers, retried soon after a failure", async () => {
	let time = 1_000;
	const calls: string[][] = [];
	let answer: { exitCode: number | null; stdout: string; stderr: string } = { exitCode: 0, stdout: "oc/a-free\noc/b\n", stderr: "" };
	const run: RunCaptured = async (command, args) => { calls.push([command, ...args]); return answer; };
	const read = opencodeModelsReader({ run, bin: "opencode", now: () => time });
	const [first, second] = await Promise.all([read(), read()]);
	assert.equal(first, "oc/a-free\noc/b\n");
	assert.equal(second, first);
	assert.deepEqual(calls, [["opencode", "models"]], "concurrent callers share one run");
	time += OPENCODE_MODELS_TTL_MS - 1;
	await read();
	assert.equal(calls.length, 1, "inside the TTL the cached list is used");
	time += 2;
	answer = { exitCode: 1, stdout: "", stderr: "boom" };
	assert.equal(await read(), undefined, "a failed read is no list, never a guess");
	assert.equal(calls.length, 2);
	await read();
	assert.equal(calls.length, 2, "a failure is not retried on every call");
	time += OPENCODE_MODELS_RETRY_MS + 1;
	answer = { exitCode: 0, stdout: "oc/c-free\n", stderr: "" };
	assert.equal(await read(), "oc/c-free\n", "after the retry window the next call reads again");
});

test("opencode models: empty output and a missing binary give no list", async () => {
	assert.equal(await opencodeModelsReader({ run: async () => ({ exitCode: 0, stdout: "  \n", stderr: "" }), bin: "opencode" })(), undefined);
	assert.equal(await opencodeModelsReader({ run: async () => ({ exitCode: null, stdout: "", stderr: "spawn opencode ENOENT" }), bin: "opencode" })(), undefined);
});

test("pi settings models: the enabled ids, without glob patterns, and nothing for a missing or broken file", () => {
	const dir = tmp();
	try {
		const file = join(dir, "settings.json");
		assert.deepEqual(readPiSettingsModels(file), []);
		writeFileSync(file, JSON.stringify({ enabledModels: ["zai/glm-5.3", " command-code/x/y ", "openai/*", "", 7] }));
		assert.deepEqual(readPiSettingsModels(file), ["zai/glm-5.3", "command-code/x/y"]);
		writeFileSync(file, "{not json");
		assert.deepEqual(readPiSettingsModels(file), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

function launchTools(root: string, actions: Partial<ActionToolDeps>): { tools: GatewayTool[]; launched: string[]; brief: string; cwd: string } {
	const msgs = join(root, ".pi", "agent", "plans", "orchestration-2026-10-05", "handoffs", "msgs");
	const cwd = join(root, ".worktrees", "scope");
	mkdirSync(msgs, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	mkdirSync(join(root, ".pi", "agent"), { recursive: true });
	writeFileSync(join(root, ".pi", "agent", "provider-pool.json"), JSON.stringify({
		version: 1, virtualProvider: "pool", cooldownMs: 3600000, resetHorizonMs: 3024000000, quotaShapes: [{ id: "q", match: "usage limit" }], freeRefs: [],
		laneDefaults: { pi: { candidates: ["pool/pi-default"], fallbackRole: "worker" }, opencode: ["opencode/pool-default"], claude: "sonnet" },
		roles: { worker: ["pool/pi-default"] },
	}));
	const brief = join(msgs, "b.md");
	writeFileSync(brief, "do it");
	const launched: string[] = [];
	const tools = createGatewayTools({
		stateDir: join(root, "muster"),
		lanes: () => [],
		notesRoot: join(root, "notes"),
		agentId: "grokbot",
		sendToOrchestrator: async () => "delivered",
		actions: {
			home: root,
			handoffsMsgsDir: msgs,
			deliverLaneMessage: async () => ({ ok: true, detail: "" }),
			readLaneCard: () => undefined,
			enqueueLaneControl: () => "",
			launchLane: async (request) => { launched.push(`${request.harness}:${request.model}`); return { ok: true, detail: "started" }; },
			readLaneLatestReport: () => undefined,
			canWriteBrief: (name) => ({ ok: true, path: join(msgs, name) }),
			...actions,
		},
	});
	return { tools, launched, brief, cwd };
}

const tool = (tools: GatewayTool[], name: string): GatewayTool => tools.find((t) => t.name === name)!;

test("lane_launch validates OpenCode and Pi models against the catalogs the gateway supplies", async () => {
	const root = tmp();
	try {
		const { tools, launched, brief, cwd } = launchTools(root, {
			opencodeModelsOutput: async () => "opencode/muse-spark-1.3-contributor-free\nopencode/paid-one",
			piSettingsModels: () => ["settings/only-in-settings"],
		});
		const launch = (harness: string, model: string) => tool(tools, "lane_launch").run({ title: "A launch-standard lane", lane: "grokbot-test-x", harness, cwd, brief, model });
		assert.match(await launch("opencode", "opencode/muse-spark-1.3-contributor-free"), /^launched/);
		await assert.rejects(launch("opencode", "opencode/not-listed"), /not in the opencode catalog/);
		await assert.rejects(launch("opencode", "opencode/paid-one"), /paid/);
		// Pi's own settings list models beside the pool, and P5-D6 refuses one no pool role,
		// freeRefs entry or laneDefaults candidate names: the pool is the only place work goes.
		await assert.rejects(launch("pi", "settings/only-in-settings"), /outside provider-pool\.json/);
		assert.match(await launch("pi", "pool/pi-default"), /^launched/);
		await assert.rejects(launch("pi", "grokbot/not-a-model"), /not in the pi catalog/);
		assert.deepEqual(launched, ["opencode:opencode/muse-spark-1.3-contributor-free", "pi:pool/pi-default"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("lane_launch refuses an OpenCode model, never guesses one, when the list could not be read", async () => {
	const root = tmp();
	try {
		const { tools, brief, cwd } = launchTools(root, { opencodeModelsOutput: async () => undefined });
		await assert.rejects(tool(tools, "lane_launch").run({ title: "A launch-standard lane", lane: "grokbot-test-x", harness: "opencode", cwd, brief, model: "opencode/x-free" }), /OpenCode model list could not be read/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ─── P2(b): what a failed launch reports ─────────────────────────────────────

test("a failed launch reports the last lines of stdout and stderr, redacted", () => {
	const stdout = Array.from({ length: 20 }, (_, i) => `pi-lane-launch: step ${i + 1}`).join("\n");
	const stderr = "warn one\nAPI_KEY=hunter2hunter2\nfatal: window is gone";
	const result = launchDetail({ code: 1, stdout, stderr });
	assert.equal(result.ok, false);
	assert.match(result.detail, /^exit 1\n/);
	assert.match(result.detail, new RegExp(`stdout \\(last ${LAUNCH_TAIL_LINES} lines\\):`));
	assert.match(result.detail, /step 20/);
	assert.match(result.detail, /step 13/);
	assert.doesNotMatch(result.detail, /step 12\b/);
	assert.match(result.detail, /stderr \(last 3 lines\):/);
	assert.match(result.detail, /fatal: window is gone/);
	assert.doesNotMatch(result.detail, /hunter2/);
});

test("a launch that exits 1 with nothing on stderr still says what the script printed", () => {
	const result = launchDetail({ code: 1, stdout: "pi-lane-launch: registered\npi-lane-launch: starting window\n", stderr: "" });
	assert.match(result.detail, /pi-lane-launch: starting window/);
	assert.doesNotMatch(result.detail, /stderr/);
	assert.match(launchDetail({ code: 1, stdout: "", stderr: "" }).detail, /printed nothing/);
});

test("a launch that worked reports the last stdout line", () => {
	assert.deepEqual(launchDetail({ code: 0, stdout: "a\nstarted Claude lane x (id 1)\n", stderr: "noise" }), { ok: true, detail: "started Claude lane x (id 1)" });
});

test("runLaunchScript runs the script with its argv, no shell, and reports a failure with both tails", async () => {
	const dir = tmp();
	try {
		const script = join(dir, "launch.sh");
		writeFileSync(script, '#!/usr/bin/env bash\necho "progress $1 $2"\necho "bad thing" >&2\n[ "$1" = "--ok" ] && exit 0\nexit 3\n');
		chmodSync(script, 0o755);
		const failed = await runLaunchScript(script, ["--fail", "a b;c"]);
		assert.equal(failed.ok, false);
		assert.match(failed.detail, /exit 3/);
		assert.match(failed.detail, /progress --fail a b;c/);
		assert.match(failed.detail, /bad thing/);
		assert.deepEqual(await runLaunchScript(script, ["--ok"]), { ok: true, detail: "progress --ok" });
		assert.equal((await runLaunchScript(join(dir, "missing.sh"), [])).ok, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ─── P12: brief_write redaction ──────────────────────────────────────────────

test("the 16 KB gateway test report passes the brief_write check", () => {
	assert.ok(Buffer.byteLength(REPORT) > 16_000);
	assert.equal(findBriefRedaction(REPORT), undefined);
});

test("hyphenated file names, ids and local paths are not secrets", () => {
	for (const text of [
		"grokbot-gateway-test-report-2026-10-10.md",
		"task-5f2a9c1e8b7d4e3f9a0b1c2d3e4f and risk-assessmentofthegatewaybriefwriter and disk-0123456789abcdefghij0123",
		"568240b1-9a3e-4c1d-8e2f-0123456789ab lane/gw-catalog@a24b871f0c3d5e6a7b8c9d0e1f2a3b4c5d6e7f80",
		"wrote /home/operator/.pi/agent/plans/orchestration-2026-10-05/handoffs/msgs/x.md and ~/.worktrees/scope",
	]) assert.equal(findBriefRedaction(text), undefined, text);
});

test("the sk- key rule still catches real keys, also glued to a word", () => {
	for (const secret of ["sk-" + "a1B2c3D4e5F6g7H8i9J0k1L2", "sk-ant-api03-abcdefghijklmnopqrstuv", "AAAAsk-proj-abcdefghijklmnop12", "key=sk-" + "a1B2c3D4e5F6g7H8i9J0k1L2"]) {
		assert.notEqual(redactSensitiveText(secret), secret, secret);
	}
});

test("a refused brief names the rule and a masked excerpt, never the value", () => {
	const secret = "live_51Habcdefghijkl";
	const finding = findBriefRedaction(`# Brief\nok line\nSet STRIPE_SECRET_KEY=${secret} for the run\nlast`);
	assert.ok(finding);
	assert.deepEqual(finding.rules, ["secret-assignment"]);
	assert.equal(finding.line, 3);
	assert.match(finding.excerpt!, /STRIPE_SECRET_KEY=\[REDACTED\]/);
	assert.doesNotMatch(JSON.stringify(finding), new RegExp(secret));
	const block = findBriefRedaction("a\n-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----\n");
	assert.deepEqual(block?.rules, ["private-key"]);
});

test("brief_write refuses with that explanation and writes a plain report", async () => {
	const root = tmp();
	try {
		const { tools } = launchTools(root, {});
		const write = tool(tools, "brief_write");
		await assert.rejects(write.run({ name: "leaky.md", content: "x\nPASSWORD=abc12345678\n" }), (error: unknown) => {
			assert.ok(error instanceof ToolRefusal);
			assert.match(error.message, /rule secret-assignment, first at line 2/);
			assert.match(error.message, /PASSWORD=\[REDACTED\]/);
			assert.doesNotMatch(error.message, /abc12345678/);
			return true;
		});
		assert.match(await write.run({ name: "report.md", content: REPORT }), /^wrote /);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ─── P10: audit_read and send_log_read ───────────────────────────────────────

function logTools(root: string, gatewayStateDir: string | undefined): GatewayTool[] {
	return createGatewayTools({ stateDir: join(root, "muster"), lanes: () => [], notesRoot: join(root, "notes"), agentId: "grokbot", sendToOrchestrator: async () => "delivered", ...(gatewayStateDir !== undefined ? { gatewayStateDir } : {}) });
}

test("audit_read and send_log_read return the last N lines, redacted, and say so when there is no log", async () => {
	const root = tmp();
	try {
		const gatewayDir = join(root, "gateway");
		const musterDir = join(root, "muster");
		mkdirSync(gatewayDir, { recursive: true });
		mkdirSync(musterDir, { recursive: true });
		const tools = logTools(root, gatewayDir);
		assert.equal(await tool(tools, "audit_read").run({}), "no audit log yet");
		assert.equal(await tool(tools, "send_log_read").run({}), "no send log yet");
		writeFileSync(join(gatewayDir, AUDIT_FILE), Array.from({ length: 120 }, (_, i) => JSON.stringify({ n: i + 1, tool: "lanes", note: i === 119 ? "token=abcdef1234567890" : "ok" })).join("\n") + "\n");
		writeFileSync(join(musterDir, SEND_LOG_FILE), [{ laneId: "a", transport: "inbox" }, { laneId: "b", transport: "resume", error: "password: hunter2hunter2" }].map((r) => JSON.stringify(r)).join("\n") + "\n");
		const audit = (await tool(tools, "audit_read").run({})).split("\n");
		assert.equal(audit.length, 50, "default 50 lines");
		assert.equal(JSON.parse(audit[0]!).n, 71);
		assert.match(audit[49]!, /"n":120/);
		assert.doesNotMatch(audit[49]!, /abcdef1234567890/);
		const three = (await tool(tools, "audit_read").run({ lines: 3 })).split("\n");
		assert.deepEqual(three.map((l) => JSON.parse(l).n), [118, 119, 120]);
		const sends = (await tool(tools, "send_log_read").run({ lines: 1 })).split("\n");
		assert.equal(sends.length, 1);
		assert.match(sends[0]!, /"laneId":"b"/);
		assert.doesNotMatch(sends[0]!, /hunter2/);
		await assert.rejects(tool(tools, "audit_read").run({ lines: 0 }), /lines must be an integer from 1 to 200/);
		await assert.rejects(tool(tools, "audit_read").run({ lines: 201 }), /lines must be an integer from 1 to 200/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("audit_read reads only the end of a large log and drops the partial first line", async () => {
	const root = tmp();
	try {
		const gatewayDir = join(root, "gateway");
		mkdirSync(gatewayDir, { recursive: true });
		const line = (n: number): string => JSON.stringify({ n, pad: "x".repeat(1000) });
		writeFileSync(join(gatewayDir, AUDIT_FILE), Array.from({ length: 2000 }, (_, i) => line(i + 1)).join("\n") + "\n");
		const out = (await tool(logTools(root, gatewayDir), "audit_read").run({ lines: 200 })).split("\n");
		assert.ok(out.length <= 200);
		for (const l of out) assert.doesNotThrow(() => JSON.parse(l), "every returned line is a whole record");
		assert.equal(JSON.parse(out.at(-1)!).n, 2000);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("audit_read is not offered without a gateway state dir; send_log_read is", () => {
	const root = tmp();
	try {
		const names = logTools(root, undefined).map((t) => t.name);
		assert.ok(names.includes("send_log_read"));
		assert.ok(!names.includes("audit_read"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ─── AK2: the queue tools ride with the always-available read tools ───────────

test("the three queue tools are offered without the action group", () => {
	const root = tmp();
	try {
		const names = logTools(root, undefined).map((t) => t.name).filter((name) => name.startsWith("asks_")).sort();
		assert.deepEqual(names, ["asks_add", "asks_answer", "asks_read"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
