/**
 * The toolbelt MCP server against a fixture toolbelt home: the real server over real stdio, the real pi-toolbelt
 * CLI, and every provider CLI resolving to the fake (no network, no real provider). The adapter owns nothing the
 * CLI owns, so these tests drive the CLI's own behaviour through it and read the CLI's own ledger and audit.
 */
import { after, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TOOLBELT_ACTIONS, TOOLBELT_PARAMS_SCHEMA, TOOLBELT_TOOL_DESCRIPTION } from "../../toolbelt-tool-spec.ts";
import { closeAll, createToolbeltFixture, fakeProviderRunning, startServer, textOf, type McpSession, type ToolbeltFixture } from "./helper.js";

// No test may outlive its budget, and no server child may outlive the file: a hung test holds the shared test lock.
const test = (name: string, body: () => Promise<void>) => nodeTest(name, { timeout: 90_000 }, body);
after(closeAll);

const CWD = tmpdir();
const SECRET = "ghp_FAKEfakefakefakefake1234567890ab";

async function withServer(
	options: { agent?: string; clientName?: string },
	body: (ctx: { fixture: ToolbeltFixture; session: McpSession; call: (args: Record<string, unknown>) => Promise<{ isError?: boolean; text: string }> }) => Promise<void>,
): Promise<void> {
	const fixture = createToolbeltFixture();
	const session = await startServer(fixture, options);
	try {
		await body({
			fixture,
			session,
			call: async (args) => {
				const result = await session.client.callTool({ name: "toolbelt", arguments: args });
				return { isError: result.isError as boolean | undefined, text: textOf(result) };
			},
		});
	} finally {
		await session.close();
		fixture.cleanup();
	}
}

test("the handshake lists one tool, `toolbelt`, with the shared description and the shared actions, and cwd required", async () => {
	await withServer({ agent: "claude-code" }, async ({ session }) => {
		const listed = await session.client.listTools();
		assert.equal(listed.tools.length, 1);
		const tool = listed.tools[0];
		assert.equal(tool.name, "toolbelt");
		assert.equal(tool.description, TOOLBELT_TOOL_DESCRIPTION, "one owner for the description");
		const schema = tool.inputSchema as { required?: string[]; properties: Record<string, { enum?: string[] }> };
		assert.deepEqual([...(schema.required ?? [])].sort(), ["action", "cwd"]);
		assert.deepEqual(schema.properties.action.enum, [...TOOLBELT_ACTIONS]);
		for (const key of Object.keys(TOOLBELT_PARAMS_SCHEMA.properties)) assert.ok(key in schema.properties, `parameter ${key}`);
	});
});

test("each action reaches the CLI and comes back as the CLI's own text", async () => {
	await withServer({ agent: "claude-code" }, async ({ fixture, call }) => {
		const cases: Array<{ args: Record<string, unknown>; command?: string }> = [
			{ args: { action: "providers" }, command: "providers" },
			{ args: { action: "find", query: "deployment logs" }, command: "find" },
			{ args: { action: "menu", service: "railway" }, command: "menu" },
			{ args: { action: "status", fast: true }, command: "status" },
			{ args: { action: "accounts" }, command: "accounts" },
			{ args: { action: "links" }, command: "links" },
			{ args: { action: "ledger", limit: 5 } },
			{ args: { action: "run", service: "railway", command: ["fixture-ok"] }, command: "run" },
		];
		for (const { args, command } of cases) {
			const result = await call({ cwd: CWD, ...args });
			assert.notEqual(result.isError, true, `${String(args.action)}: ${result.text.slice(0, 200)}`);
			assert.ok(result.text.length > 0, `${String(args.action)} returned text`);
			if (command) assert.equal(fixture.ledger().at(-1)?.command, command, `${String(args.action)} is in the CLI's own ledger`);
		}
		assert.ok(fixture.audit().some((entry) => entry.cli === "railway" && entry.args[0] === "fixture-ok"), "run reached the provider CLI");
	});
});

test("a missing, empty or relative cwd is refused before anything is dispatched", async () => {
	await withServer({ agent: "claude-code" }, async ({ fixture, call }) => {
		for (const args of [{ action: "status" }, { action: "status", cwd: "" }, { action: "status", cwd: "relative/dir" }]) {
			const result = await call(args);
			assert.equal(result.isError, true);
			assert.match(result.text, /cwd is required/);
		}
		assert.equal(fixture.ledger().length, 0, "the CLI was never run");
		assert.equal(fixture.audit().length, 0);
	});
});

test("a cwd that is not an existing directory is refused with its own message, before anything is dispatched", async () => {
	await withServer({ agent: "claude-code" }, async ({ fixture, call }) => {
		const missing = join(tmpdir(), `toolbelt-mcp-no-such-dir-${process.pid}`);
		const file = join(fixture.dataDir, "providers.json");
		const gone = await call({ action: "status", cwd: missing });
		assert.equal(gone.isError, true);
		assert.match(gone.text, /does not exist/);
		assert.doesNotMatch(gone.text, /exited 127|JSON envelope/, "the toolbelt is not blamed for the caller's directory");
		const notDir = await call({ action: "status", cwd: file });
		assert.equal(notDir.isError, true);
		assert.match(notDir.text, /not a directory/);
		for (const text of [gone.text, notDir.text]) assert.match(text, /cwd is required/, "both carry the cwd rule");
		assert.equal(fixture.ledger().length, 0, "the CLI was never run");
		assert.equal(fixture.audit().length, 0);
	});
});

test("arguments the shared schema rejects are refused with the path and the rule, and nothing is dispatched", async () => {
	await withServer({ agent: "claude-code" }, async ({ fixture, call }) => {
		const result = await call({ action: "not-an-action", cwd: CWD });
		assert.equal(result.isError, true);
		assert.match(result.text, /invalid arguments: \/action /);
		assert.equal(fixture.ledger().length, 0, "the CLI was never run");
		assert.equal(fixture.audit().length, 0);
	});
});

test("payload directories older than the retention are removed when the server starts, newer ones are kept", async () => {
	const fixture = createToolbeltFixture();
	const results = join(fixture.stateDir, "toolbelt-results");
	const old = join(results, "claude-code-100-1");
	const recent = join(results, "claude-code-200-2");
	for (const dir of [old, recent]) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "toolbelt-result-abc-1.txt"), "payload");
	}
	const aged = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
	utimesSync(old, aged, aged);
	const session = await startServer(fixture, { agent: "claude-code" });
	try {
		assert.equal(existsSync(old), false, "the stale session directory is gone");
		assert.equal(existsSync(join(recent, "toolbelt-result-abc-1.txt")), true, "the recent one stays");
	} finally {
		await session.close();
		fixture.cleanup();
	}
});

test("secret-shaped input is refused, never echoed, and never reaches a provider or the ledger", async () => {
	await withServer({ agent: "claude-code" }, async ({ fixture, call }) => {
		const result = await call({ action: "run", service: "railway", cwd: CWD, command: ["deploy", "--token", SECRET] });
		assert.equal(result.isError, true);
		assert.doesNotMatch(result.text, /ghp_FAKE/);
		assert.equal(fixture.audit().filter((entry) => entry.cli === "railway").length, 0, "no provider call");
		assert.doesNotMatch(JSON.stringify(fixture.ledger()), /ghp_FAKE/);
	});
});

test("the CLI's ledger names the agent that called: claude-code or hermes, never pi", async () => {
	for (const agent of ["claude-code", "hermes"]) {
		await withServer({ agent }, async ({ fixture, call }) => {
			await call({ action: "status", fast: true, cwd: CWD });
			assert.equal(fixture.ledger().at(-1)?.agent, agent);
		});
	}
	// With no --agent flag the connecting client names itself.
	await withServer({ clientName: "claude-code" }, async ({ fixture, call }) => {
		await call({ action: "status", fast: true, cwd: CWD });
		assert.equal(fixture.ledger().at(-1)?.agent, "claude-code");
	});
});

test("an agent name the CLI would refuse stops the server at startup", async () => {
	const fixture = createToolbeltFixture();
	const started = await startServer(fixture, { agent: "bad agent!" }).then((session) => session, () => undefined);
	try {
		assert.equal(started, undefined, "the server must not start with that agent name");
	} finally {
		await started?.close();
		fixture.cleanup();
	}
});

test("a large payload is cut to the MCP cap and the whole of it goes to a private file", async () => {
	await withServer({ agent: "claude-code" }, async ({ fixture, call }) => {
		// The CLI cuts a provider's own stdout to about 4,000 characters, so the large result comes from a menu:
		// the fixture's copy of one provider's command surface is made large, and the CLI renders it as it does any.
		const surfacePath = join(fixture.dataDir, "surface", "railway.json");
		const surface = JSON.parse(readFileSync(surfacePath, "utf8")) as { leaves: unknown[]; leafCount: number };
		for (let index = 0; index < 1500; index++) surface.leaves.push({ cmd: `synthetic-command-${index}`, flags: ["json", "verbose"], desc: `A synthetic command number ${index} that exists only to make the menu large` });
		surface.leafCount = surface.leaves.length;
		writeFileSync(surfacePath, JSON.stringify(surface));
		const result = await call({ action: "menu", service: "railway", cwd: CWD });
		assert.notEqual(result.isError, true);
		assert.ok(result.text.length <= 26_000, `inline text is ${result.text.length} chars, under the MCP cap`);
		const reference = result.text.match(/(?:^|\n)full=(\S+)/);
		assert.ok(reference, "the text names the preserved file");
		const path = reference![1];
		assert.ok(existsSync(path));
		assert.equal(statSync(path).mode & 0o777, 0o600, "owner-only");
		assert.ok(readFileSync(path, "utf8").length > 30_000, "the file holds the whole payload");
	});
});

test("an abort from the client reaches the CLI and the provider command it started", async () => {
	await withServer({ agent: "claude-code" }, async ({ fixture, session, call }) => {
		const controller = new AbortController();
		const pending = session.client.callTool(
			{ name: "toolbelt", arguments: { action: "run", service: "railway", cwd: CWD, command: ["fixture-sleep", "20000"] } },
			undefined,
			{ signal: controller.signal },
		);
		for (let i = 0; i < 40 && !fixture.audit().some((entry) => entry.args[0] === "fixture-sleep"); i++) await new Promise((resolve) => setTimeout(resolve, 150));
		assert.ok(fixture.audit().some((entry) => entry.args[0] === "fixture-sleep"), "the provider command started");
		controller.abort();
		await assert.rejects(pending);
		for (let i = 0; i < 30 && fakeProviderRunning("fixture-sleep"); i++) await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(fakeProviderRunning("fixture-sleep"), false, "no provider process left behind");
		const after = await call({ action: "status", fast: true, cwd: CWD });
		assert.notEqual(after.isError, true, "the server still answers");
	});
});

test("a timeout is forwarded to the CLI, which reports it and ends the provider command", async () => {
	await withServer({ agent: "claude-code" }, async ({ call }) => {
		const started = Date.now();
		const result = await call({ action: "run", service: "railway", cwd: CWD, command: ["fixture-sleep", "20000"], timeoutMs: 1500 });
		assert.equal(result.isError, true);
		assert.match(result.text, /time/i);
		assert.ok(Date.now() - started < 9_000, "the CLI's own timeout fired, not the wrapper's grace");
		for (let i = 0; i < 30 && fakeProviderRunning("fixture-sleep"); i++) await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(fakeProviderRunning("fixture-sleep"), false);
	});
});
