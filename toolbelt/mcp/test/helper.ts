/**
 * Test support for the toolbelt MCP server: a fixture toolbelt home in a temp directory, every provider CLI
 * resolving to test/support/fake-provider-cli.js (no network, no real provider, each call audited), and
 * a stdio MCP client that launches the real server against it.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
/** The tree that holds the packages: `packages/` under Pi's profile, the repository root in the clone. */
const HARNESS_ROOT = join(dirname(new URL(import.meta.url).pathname), "..", "..", "..");
const TOOLBELT = join(HARNESS_ROOT, "toolbelt");
const FAKE = join(TOOLBELT, "test", "support", "fake-provider-cli.js");
export const SERVER_PATH = join(TOOLBELT, "mcp", "server.ts");
// RS2b: HARNESS_ROOT is the harness folder (packages/), so the loader is the checkout's
// own node_modules until RS3 installs the harness's (RD8).
// The checkout's own install: beside `packages/` in Pi's profile, at the repository root in the clone.
const CHECKOUT = existsSync(join(HARNESS_ROOT, "node_modules", "tsx")) ? HARNESS_ROOT : join(HARNESS_ROOT, "..");
const TSX_LOADER = pathToFileURL(join(CHECKOUT, "node_modules", "tsx", "dist", "loader.mjs")).href;
const FIXTURE_CLIS = ["resend", "gh", "vercel", "stripe", "sentry-cli", "railway", "tailscale", "gws", "supabase", "wrangler", "portal", "pixellab", "runware", "studio", "stitch"];

export interface ToolbeltFixture {
	home: string;
	dataDir: string;
	ledgerPath: string;
	auditPath: string;
	stateDir: string;
	env: Record<string, string>;
	ledger(): Array<Record<string, any>>;
	audit(): Array<{ cli: string; args: string[] }>;
	cleanup(): void;
}

export function createToolbeltFixture(): ToolbeltFixture {
	const root = mkdtempSync(join(tmpdir(), "toolbelt-mcp-"));
	const home = join(root, "toolbelt");
	const dataDir = join(home, "data");
	const bin = join(root, "bin");
	const stateDir = join(root, "state");
	mkdirSync(dataDir, { recursive: true });
	mkdirSync(bin, { recursive: true });
	cpSync(join(TOOLBELT, "data", "surface"), join(dataDir, "surface"), { recursive: true });
	cpSync(join(TOOLBELT, "data", "policy"), join(dataDir, "policy"), { recursive: true });
	cpSync(join(TOOLBELT, "data", "providers.json"), join(dataDir, "providers.json"));
	writeFileSync(join(dataDir, "accounts.json"), `${JSON.stringify({ version: 1, accounts: { "resend-fixture": { provider: "resend", profile: "fixture-profile", enabled: true } }, projects: {} }, null, 2)}\n`);
	const auditPath = join(root, "invocations.jsonl");
	writeFileSync(auditPath, "");
	for (const name of FIXTURE_CLIS) {
		const path = join(bin, name);
		writeFileSync(path, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} ${name} "$@"\n`);
		chmodSync(path, 0o755);
	}
	const env: Record<string, string> = {
		PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
		HOME: root,
		PI_TOOLBELT_HOME: home,
		PI_TOOLBELT_BIN: join(TOOLBELT, "bin", "pi-toolbelt"),
		PI_TOOLBELT_MCP_STATE: stateDir,
		PI_TOOLBELT_FIXTURE: "1",
		PI_TOOLBELT_FAKE_AUDIT: auditPath,
		PI_TOOLBELT_FAKE_CLIS: FIXTURE_CLIS.join(" "),
	};
	const ledgerPath = join(dataDir, "ledger.jsonl");
	return {
		home,
		dataDir,
		ledgerPath,
		auditPath,
		stateDir,
		env,
		ledger: () => (existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []),
		audit: () => readFileSync(auditPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

export interface McpSession {
	client: Client;
	close(): Promise<void>;
}

/** Every session started here, so a test that fails before closing its own cannot leave a server child behind. */
const open = new Set<McpSession>();
export async function closeAll(): Promise<void> {
	await Promise.allSettled([...open].map((session) => session.close()));
	open.clear();
}

/** Launch the real server over stdio against the fixture and complete the MCP handshake. */
export async function startServer(fixture: ToolbeltFixture, options: { agent?: string; clientName?: string; extraArgs?: string[] } = {}): Promise<McpSession> {
	const args = ["--import", TSX_LOADER, SERVER_PATH, ...(options.agent ? ["--agent", options.agent] : []), ...(options.extraArgs ?? [])];
	const transport = new StdioClientTransport({ command: process.execPath, args, env: fixture.env, stderr: "pipe" });
	const client = new Client({ name: options.clientName ?? "toolbelt-mcp-test", version: "0.0.0" });
	// A server that never answers the handshake must fail the test, not hang it.
	const connected = client.connect(transport);
	const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the MCP server did not complete the handshake in 20 s")), 20_000).unref());
	try {
		await Promise.race([connected, timer]);
	} catch (error) {
		await client.close().catch(() => undefined);
		await transport.close().catch(() => undefined);
		throw error;
	}
	const session: McpSession = { client, close: async () => { open.delete(session); await client.close(); } };
	open.add(session);
	return session;
}

/** The text of a tool result's first content block. */
export function textOf(result: object): string {
	const blocks = ((result as { content?: unknown }).content ?? []) as Array<{ type: string; text?: string }>;
	return blocks.map((block) => (block.type === "text" ? block.text ?? "" : "")).join("\n");
}

/** Whether any process still runs the fake provider with these words in its command line. */
export function fakeProviderRunning(needle: string): boolean {
	const run = spawnSync("pgrep", ["-f", `fake-provider-cli.js.*${needle}`], { encoding: "utf8" });
	return run.status === 0 && run.stdout.trim() !== "";
}
