import "./muster-test-isolation.ts";
/**
 * UM14 (plans/provider-accounts/usage-monitor-blueprint-2026-10-16.md): `dashboard_login`, the
 * gateway tool that hands the monitor bot a stored dashboard username, password and TOTP code.
 *
 * The vault is faked (a reader over fixed maps) and the clock is fixed. Every value here is a
 * fake: an email-shaped username and a token-shaped password prove the result arrives without
 * redaction, and the tests assert that none of the three stored values, nor the TOTP secret, is
 * in any refusal, tool list or audit line.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway, type GatewayOptions, type RunningGateway } from "../gateway/server.ts";
import { AUDIT_FILE, MONITOR_TOKEN_ENV, readMonitorToken } from "../gateway/state.ts";
import { createGatewayTools, type GatewayTool } from "../gateway/tools.ts";
import { DASHBOARD_CONSUMERS, dashboardEnvNames, runAsReader, type DashboardSecretsReader } from "../gateway/dashboard-login.ts";
import { redactSensitiveText } from "../../core/self-improving-redactor.ts";
import { totpCode } from "../../core/totp.ts";
import { SIGNAL_ACCOUNTS } from "../signals.ts";

const CHAT_TOKEN = "c".repeat(40);
const MONITOR_TOKEN = "m".repeat(40);
/** RFC 6238's SHA-1 secret in base32. It is a fake: no real account uses it. */
const TOTP_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
/** 1234567890 s is a step boundary (30 s left) and RFC 6238's code for it is 005924. */
const FIXED_CLOCK = new Date(1234567890_000);

const EMAIL = (account: string): string => `monitor.${account}@example.test`;
const PASSWORD = (account: string): string => `sk-${account.replace(/\W/g, "")}0000000000000000000000000000`;

/** One run-as consumer's variables, for a provider and account. */
const stored = (provider: string, account: string, withTotp = true): Record<string, string> => {
	const names = dashboardEnvNames(provider);
	return { [names.username]: EMAIL(account), [names.password]: PASSWORD(account), ...(withTotp ? { [names.totpSecret]: TOTP_SECRET } : {}) };
};

type Fixture = { root: string; stateDir: string; gateway: RunningGateway; reads: Array<{ consumer: string; names: readonly string[] }> };

/** An ordinary tool whose output is exactly what dashboard_login returns, to prove the redactor still runs on it. */
const echoTool = (text: string): GatewayTool => ({
	name: "echo_probe",
	description: "test tool",
	inputSchema: { type: "object", properties: {}, additionalProperties: false },
	run: async () => text,
});

async function withGateway(
	vault: Record<string, Record<string, string>>,
	run: (fixture: Fixture) => Promise<void>,
	options: { monitorToken?: string | null; read?: DashboardSecretsReader; extraTools?: GatewayTool[]; now?: () => Date; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "muster-gateway-dashboard-"));
	const stateDir = join(root, "state");
	const reads: Fixture["reads"] = [];
	const read: DashboardSecretsReader =
		options.read ??
		(async (consumer, names) => {
			reads.push({ consumer, names });
			const folder = vault[consumer] ?? {};
			return Object.fromEntries(names.filter((name) => folder[name] !== undefined).map((name) => [name, folder[name] as string]));
		});
	const tools = [
		...createGatewayTools({
			stateDir,
			lanes: () => [],
			notesRoot: stateDir,
			agentId: "grokbot",
			sendToOrchestrator: async () => "delivered",
			dashboardLogin: { read, now: options.now ?? (() => FIXED_CLOCK), ...(options.sleep !== undefined ? { sleep: options.sleep } : {}) },
		}),
		...(options.extraTools ?? []),
	];
	const monitorToken = options.monitorToken === null ? undefined : (options.monitorToken ?? MONITOR_TOKEN);
	const gateway = await startGateway({ stateDir, token: CHAT_TOKEN, ...(monitorToken !== undefined ? { monitorToken } : {}), tools, port: 0 });
	try {
		await run({ root, stateDir, gateway, reads });
	} finally {
		await gateway.close();
		rmSync(root, { recursive: true, force: true });
	}
}

async function rpc(gateway: RunningGateway, token: string, body: unknown): Promise<{ status: number; json: any }> {
	const response = await fetch(`http://127.0.0.1:${gateway.port}/mcp`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
		body: JSON.stringify(body),
	});
	const text = await response.text();
	const data = text.split("\n").find((line) => line.startsWith("data: "));
	return { status: response.status, json: data !== undefined ? JSON.parse(data.slice(6)) : text === "" ? undefined : JSON.parse(text) };
}

const call = (gateway: RunningGateway, token: string, name: string, args: Record<string, unknown>) => rpc(gateway, token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
const listed = async (gateway: RunningGateway, token: string): Promise<string[]> => (await rpc(gateway, token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json.result.tools.map((tool: { name: string }) => tool.name);
const replyText = (reply: { json: any }): string => reply.json.result.content.map((part: { text: string }) => part.text).join("\n");
const refused = (reply: { json: any }): boolean => reply.json.result.isError === true;
const auditText = (stateDir: string): string => readFileSync(join(stateDir, AUDIT_FILE), "utf8");

test("the fixtures are what the redactor would mask, so a delivered value proves the exemption", () => {
	const sample = JSON.stringify({ username: EMAIL("personal"), password: PASSWORD("personal") });
	const redacted = redactSensitiveText(sample, { preservePaths: true, strictAssignments: true });
	assert.ok(!redacted.includes(EMAIL("personal")), "an email-shaped username is masked by the redactor");
	assert.ok(!redacted.includes(PASSWORD("personal")), "a token-shaped password is masked by the redactor");
});

test("the monitor bearer gets the username, the password and a TOTP code for each account, intact", async () => {
	const vault = Object.fromEntries(SIGNAL_ACCOUNTS.map((account) => [DASHBOARD_CONSUMERS[account], stored("xai", account)]));
	await withGateway(vault, async ({ gateway, reads }) => {
		for (const account of SIGNAL_ACCOUNTS) {
			const reply = await call(gateway, MONITOR_TOKEN, "dashboard_login", { provider: "xai", account });
			assert.equal(refused(reply), false, `${account}`);
			const result = JSON.parse(replyText(reply));
			assert.deepEqual(result, { provider: "xai", account, username: EMAIL(account), password: PASSWORD(account), totp: { code: "005924", validForSeconds: 30 } });
			assert.equal(result.totp.code, totpCode(TOTP_SECRET, FIXED_CLOCK).code);
		}
		// The account picked the vault: one run-as consumer layer each, and only the three dashboard names were asked for.
		assert.deepEqual(reads.map((read) => read.consumer), ["gateway-dashboards", "gateway-dashboards-work", "gateway-dashboards-studio"]);
		for (const read of reads) assert.deepEqual(read.names, ["XAI_DASHBOARD_USERNAME", "XAI_DASHBOARD_PASSWORD", "XAI_DASHBOARD_TOTP_SECRET"]);
	});
});

test("a hyphenated provider id becomes an underscored name", async () => {
	await withGateway({ "gateway-dashboards": stored("opencode-go", "personal") }, async ({ gateway, reads }) => {
		const reply = await call(gateway, MONITOR_TOKEN, "dashboard_login", { provider: "OpenCode-Go", account: "personal" });
		assert.equal(JSON.parse(replyText(reply)).username, EMAIL("personal"));
		assert.deepEqual(reads[0]?.names, ["OPENCODE_GO_DASHBOARD_USERNAME", "OPENCODE_GO_DASHBOARD_PASSWORD", "OPENCODE_GO_DASHBOARD_TOTP_SECRET"]);
	});
});

test("a provider with no stored login is not stored, and the refusal carries no value", async () => {
	await withGateway({ "gateway-dashboards": stored("xai", "personal") }, async ({ gateway, stateDir }) => {
		const missing = await call(gateway, MONITOR_TOKEN, "dashboard_login", { provider: "kie", account: "personal" });
		assert.equal(refused(missing), true);
		assert.equal(replyText(missing), "no dashboard login is stored for kie (personal)");
		// The same provider on an account whose vault holds nothing.
		const other = await call(gateway, MONITOR_TOKEN, "dashboard_login", { provider: "xai", account: "acme-realty" });
		assert.equal(replyText(other), "no dashboard login is stored for xai (acme-realty)");
		for (const value of [EMAIL("personal"), PASSWORD("personal"), TOTP_SECRET]) assert.ok(!auditText(stateDir).includes(value));
	});
});

test("a login with no authenticator secret returns totp null", async () => {
	await withGateway({ "gateway-dashboards": stored("tavily", "personal", false) }, async ({ gateway }) => {
		const result = JSON.parse(replyText(await call(gateway, MONITOR_TOKEN, "dashboard_login", { provider: "tavily", account: "personal" })));
		assert.equal(result.totp, null);
		assert.equal(result.username, EMAIL("personal"));
	});
});

test("a code with under 5 seconds left waits for the next step", async () => {
	let clock = FIXED_CLOCK.getTime() + 26_000;
	const slept: number[] = [];
	await withGateway(
		{ "gateway-dashboards": stored("xai", "personal") },
		async ({ gateway }) => {
			const result = JSON.parse(replyText(await call(gateway, MONITOR_TOKEN, "dashboard_login", { provider: "xai", account: "personal" })));
			assert.deepEqual(slept, [4000]);
			assert.deepEqual(result.totp, totpCode(TOTP_SECRET, FIXED_CLOCK.getTime() + 30_000));
		},
		{ now: () => new Date(clock), sleep: async (ms) => void (slept.push(ms), (clock += ms)) },
	);
});

test("the chat bearer neither lists nor reaches dashboard_login", async () => {
	await withGateway({ "gateway-dashboards": stored("xai", "personal") }, async ({ gateway, stateDir, reads }) => {
		assert.ok(!(await listed(gateway, CHAT_TOKEN)).includes("dashboard_login"));
		assert.ok((await listed(gateway, MONITOR_TOKEN)).includes("dashboard_login"));
		// The monitor's list is the chat list plus the monitor-only tool, minus the chat-only tools (asks_answer, NLK; cards_read and cards_tap, NLH).
		const chat = await listed(gateway, CHAT_TOKEN);
		assert.deepEqual((await listed(gateway, MONITOR_TOKEN)).filter((name) => name !== "dashboard_login"), chat.filter((name) => !["asks_answer", "cards_read", "cards_tap"].includes(name)));
		const reply = await call(gateway, CHAT_TOKEN, "dashboard_login", { provider: "xai", account: "personal" });
		assert.equal(refused(reply), true);
		assert.equal(replyText(reply), "unknown tool dashboard_login");
		assert.deepEqual(reads, [], "the vault was not read for the chat bearer");
		const rows = auditText(stateDir).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
		assert.ok(rows.some((row) => row["tool"] === "dashboard_login" && row["refused"] === true && row["reason"] === "not in this bearer's tool list"));
	});
});

test("with no monitor token set, dashboard_login is served to no one", async () => {
	await withGateway({ "gateway-dashboards": stored("xai", "personal") }, async ({ gateway, reads }) => {
		assert.ok(!(await listed(gateway, CHAT_TOKEN)).includes("dashboard_login"));
		assert.equal((await call(gateway, CHAT_TOKEN, "dashboard_login", { provider: "xai", account: "personal" })).json.result.isError, true);
		assert.equal((await rpc(gateway, MONITOR_TOKEN, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 401);
		assert.deepEqual(reads, []);
	}, { monitorToken: null });
});

test("the gateway refuses to start with one token for both bearers", async () => {
	await assert.rejects(startGateway({ stateDir: join(tmpdir(), "muster-gateway-same-token"), token: CHAT_TOKEN, monitorToken: CHAT_TOKEN, tools: [], port: 0 } satisfies GatewayOptions), /monitor token must differ/);
});

test("only the flagged tool skips redaction: every other tool is redacted, on both bearers", async () => {
	const payload = JSON.stringify({ username: EMAIL("personal"), password: PASSWORD("personal") });
	await withGateway({ "gateway-dashboards": stored("xai", "personal") }, async ({ gateway }) => {
		for (const token of [CHAT_TOKEN, MONITOR_TOKEN]) {
			const text = replyText(await call(gateway, token, "echo_probe", {}));
			assert.ok(!text.includes(EMAIL("personal")) && !text.includes(PASSWORD("personal")), "an unflagged tool's result is still redacted");
		}
		const delivered = replyText(await call(gateway, MONITOR_TOKEN, "dashboard_login", { provider: "xai", account: "personal" }));
		assert.ok(delivered.includes(EMAIL("personal")) && delivered.includes(PASSWORD("personal")));
	}, { extraTools: [echoTool(payload)] });
});

test("no refusal, tool list or audit line carries the TOTP secret or a vault value", async () => {
	const leaky = new Error(`vault said ${PASSWORD("personal")} ${TOTP_SECRET} ${EMAIL("personal")}`);
	const badSecret = "not*base32!secret";
	const flaky: DashboardSecretsReader = async (consumer) => {
		if (consumer === "gateway-dashboards-work") throw leaky;
		if (consumer === "gateway-dashboards-studio") return { XAI_DASHBOARD_USERNAME: EMAIL("pa"), XAI_DASHBOARD_PASSWORD: PASSWORD("pa"), XAI_DASHBOARD_TOTP_SECRET: badSecret };
		return stored("xai", "personal");
	};
	await withGateway({}, async ({ gateway, stateDir }) => {
		const texts: string[] = [];
		for (const account of SIGNAL_ACCOUNTS) texts.push(replyText(await call(gateway, MONITOR_TOKEN, "dashboard_login", { provider: "xai", account })));
		texts.push(replyText(await call(gateway, MONITOR_TOKEN, "dashboard_login", { provider: "xai!", account: "personal" })));
		texts.push(replyText(await call(gateway, MONITOR_TOKEN, "dashboard_login", { provider: "xai", account: "elsewhere" })));
		texts.push(JSON.stringify((await rpc(gateway, MONITOR_TOKEN, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json));
		// The unreadable vault and the invalid secret are refusals that name the provider and account only.
		assert.equal(texts[1], "the vault for acme-realty could not be read for xai");
		assert.equal(texts[2], "the stored TOTP secret for xai (studio) is not valid base32");
		// texts[0] is the one delivered login; everything after it is a refusal or the tool list.
		const everythingElse = [...texts.slice(1), auditText(stateDir)].join("\n");
		for (const value of [TOTP_SECRET, badSecret, EMAIL("personal"), PASSWORD("personal"), EMAIL("pa"), PASSWORD("pa"), "vault said"]) assert.ok(!everythingElse.includes(value), "a value reached a refusal, a tool list or the audit log");
		// The delivered result holds the stored login and no TOTP secret.
		assert.ok(texts[0]?.includes(EMAIL("personal")) && texts[0].includes(PASSWORD("personal")));
		assert.ok(!(texts[0] ?? "").includes(TOTP_SECRET));
	}, { read: flaky });
});

test("the audit holds the call and the result size, never the result", async () => {
	await withGateway({ "gateway-dashboards": stored("xai", "personal") }, async ({ gateway, stateDir }) => {
		const text = replyText(await call(gateway, MONITOR_TOKEN, "dashboard_login", { provider: "xai", account: "personal" }));
		const rows = auditText(stateDir).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>).filter((row) => row["tool"] === "dashboard_login");
		assert.deepEqual(rows.map((row) => row["phase"]), ["intent", "result"]);
		assert.equal(rows[1]?.["resultBytes"], Buffer.byteLength(text));
		assert.deepEqual(JSON.parse(String(rows[0]?.["args"])), { provider: "xai", account: "personal" });
	});
});

test("readMonitorToken: unset is undefined, a set token is taken off the environment, a short one is refused by name", () => {
	assert.equal(readMonitorToken({}), undefined);
	const env: NodeJS.ProcessEnv = { [MONITOR_TOKEN_ENV]: ` ${MONITOR_TOKEN} ` };
	assert.equal(readMonitorToken(env), MONITOR_TOKEN);
	assert.equal(env[MONITOR_TOKEN_ENV], undefined, "no lane the gateway launches inherits the token");
	const short: NodeJS.ProcessEnv = { [MONITOR_TOKEN_ENV]: "short-value-9" };
	assert.throws(() => readMonitorToken(short), (error: unknown) => (error as Error).message.includes(MONITOR_TOKEN_ENV) && !(error as Error).message.includes("short-value-9"));
});

test("runAsReader asks run-as for the consumer, prints only the named variables, and surfaces no stderr", async () => {
	const root = mkdtempSync(join(tmpdir(), "muster-gateway-runas-"));
	try {
		// A stand-in for infisical-agent: it checks the argv shape, injects fake variables like run-as would, and execs the command.
		const bin = join(root, "infisical-agent");
		writeFileSync(
			bin,
			[
				"#!/bin/sh",
				'[ "$1" = run-as ] || exit 9',
				'consumer="$2"; shift 3',
				'[ "$consumer" = gateway-dashboards ] || { echo "no such consumer" >&2; exit 78; }',
				'export XAI_DASHBOARD_USERNAME="fake.user@example.test" XAI_DASHBOARD_PASSWORD="fake-pass" UNRELATED_NAME="not-asked-for"',
				'exec "$@"',
			].join("\n"),
		);
		chmodSync(bin, 0o755);
		const read = runAsReader({ bin });
		assert.deepEqual(await read("gateway-dashboards", ["XAI_DASHBOARD_USERNAME", "XAI_DASHBOARD_PASSWORD", "XAI_DASHBOARD_TOTP_SECRET"]), { XAI_DASHBOARD_USERNAME: "fake.user@example.test", XAI_DASHBOARD_PASSWORD: "fake-pass" });
		await assert.rejects(read("gateway-dashboards-work", ["XAI_DASHBOARD_USERNAME"]), (error: unknown) => (error as Error).message === "run-as gateway-dashboards-work failed");
		await assert.rejects(runAsReader({ bin: join(root, "missing") })("gateway-dashboards", ["XAI_DASHBOARD_USERNAME"]), /run-as gateway-dashboards failed/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
