/**
 * `muster gateway serve` records the commit it started from (WP-E, LD19), in a fixture Muster
 * state dir: the live `state/muster` is never read or written.
 */

import "./muster-test-isolation.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initGatewayToken } from "../gateway/state.ts";
import { gatewayCodePath, readGatewayCode } from "../gateway-code.ts";
import { harnessRoot } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);
const LAUNCHER = join(piAgentDir(), "extensions", "muster", "launchers", "muster");

function freePort(): Promise<number> {
	return new Promise((done, fail) => {
		const server = createServer();
		server.once("error", fail);
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			server.close(() => done(port));
		});
	});
}

test("gateway serve writes gateway-code.json with the checkout's HEAD, its start time and its own pid", async () => {
	const root = mkdtempSync(join(tmpdir(), "muster-gateway-code-"));
	const musterState = join(root, "state", "muster");
	const tokenFile = join(root, "config", "token");
	mkdirSync(musterState, { recursive: true });
	mkdirSync(dirname(tokenFile), { recursive: true });
	initGatewayToken(tokenFile);
	const port = await freePort();
	const env = {
		...process.env,
		HOME: root,
		PI_MUSTER_STATE_DIR: musterState,
		GROKBOT_GATEWAY_STATE_DIR: join(root, "gateway-state"),
		GROKBOT_GATEWAY_TOKEN_FILE: tokenFile,
		GROKBOT_GATEWAY_PORT: String(port),
	};
	const child = spawn(LAUNCHER, ["gateway", "serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
	child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
	const closed = new Promise<void>((done) => child.on("close", () => done()));
	try {
		const deadline = Date.now() + 30_000;
		while (readGatewayCode(musterState) === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
		const code = readGatewayCode(musterState);
		assert.ok(code, `gateway-code.json was written (${gatewayCodePath(musterState)}); output: ${output}`);
		assert.equal(code.sha, execFileSync("git", ["-C", HARNESS_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
		assert.equal(code.pid, child.pid, "the launcher execs node, so the pid is the process that serves");
		assert.ok(Number.isFinite(Date.parse(code.startedAt)));
		assert.equal(code.staleReportedFor, undefined);
	} finally {
		child.kill("SIGTERM");
		await closed;
		rmSync(root, { recursive: true, force: true });
	}
	assert.equal(existsSync(root), false);
});

test("gateway serve takes its bearer from GROKBOT_GATEWAY_TOKEN alone and refuses a wrong one (SK-D11)", async () => {
	const root = mkdtempSync(join(tmpdir(), "muster-gateway-env-bearer-"));
	const musterState = join(root, "state", "muster");
	mkdirSync(musterState, { recursive: true });
	const port = await freePort();
	const bearer = "env".repeat(16);
	const env = {
		...process.env,
		HOME: root,
		PI_MUSTER_STATE_DIR: musterState,
		GROKBOT_GATEWAY_STATE_DIR: join(root, "gateway-state"),
		// No token file exists: the env bearer is the only source, so a start proves it was read.
		GROKBOT_GATEWAY_TOKEN_FILE: join(root, "config", "token"),
		GROKBOT_GATEWAY_PORT: String(port),
		GROKBOT_GATEWAY_TOKEN: bearer,
	};
	const child = spawn(LAUNCHER, ["gateway", "serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
	child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
	const closed = new Promise<void>((done) => child.on("close", () => done()));
	try {
		const deadline = Date.now() + 30_000;
		while (readGatewayCode(musterState) === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
		assert.ok(readGatewayCode(musterState), `the gateway started with only the env bearer; output: ${output}`);
		const rpc = (authorization: string) =>
			fetch(`http://127.0.0.1:${port}/mcp`, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			});
		assert.equal((await rpc(`Bearer ${bearer}-wrong`)).status, 401, "a wrong bearer is refused");
		assert.equal((await rpc(`Bearer ${bearer}`)).status, 200, "the env bearer is the one the gateway checks");
		assert.equal(existsSync(join(root, "config", "token")), false, "no token file was needed or created");
	} finally {
		child.kill("SIGTERM");
		await closed;
		rmSync(root, { recursive: true, force: true });
	}
});
