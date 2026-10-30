import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createClient } from "../ledger/client.ts";
import { startDaemon } from "../ledger/daemon.ts";
import { readSpool } from "../ledger/spool.ts";

const tempDir = () => mkdtempSync(join(tmpdir(), "ledger-daemon-"));

/** A raw connection with a line reader, for the wire-level tests. */
function rawConnect(socketPath: string) {
	const socket = net.connect(socketPath);
	const lines: string[] = [];
	const waiters: ((line: string) => void)[] = [];
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		let newline: number;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			const waiter = waiters.shift();
			if (waiter === undefined) lines.push(line);
			else waiter(line);
		}
	});
	return {
		write: (text: string) => socket.write(text),
		nextLine: (): Promise<string> =>
			new Promise<string>((resolve) => {
				const line = lines.shift();
				if (line === undefined) waiters.push(resolve);
				else resolve(line);
			}),
		end: () => socket.end(),
	};
}

test("a client round-trips casUpdate and casRead through the socket", async () => {
	const d = await startDaemon(tempDir());
	const c = createClient(d.socketPath);
	assert.deepEqual(
		await c.request("casUpdate", {
			store: "seat",
			id: "orchestrator",
			expectedRevision: undefined,
			record: { epoch: 1 },
		}),
		{ ok: true, revision: 1 },
	);
	assert.deepEqual(await c.request("casRead", { store: "seat", id: "orchestrator" }), {
		record: { epoch: 1 },
		revision: 1,
	});
	c.close();
	await d.stop();
});

test("a subscriber gets the appended event pushed", async () => {
	const d = await startDaemon(tempDir());
	const c = createClient(d.socketPath);
	const seen = new Promise<{ type: string }>((resolve) =>
		c.subscribe({ types: ["WORKING"] }, (event) => resolve(event as { type: string })),
	);
	await c.request("appendEvent", { type: "WORKING", text: "s", requestId: "r-sub" });
	assert.equal((await seen).type, "WORKING");
	c.close();
	await d.stop();
});

test("a subscription survives a musterd restart: one wake on reconnect, then events again (G4)", async () => {
	const dir = tempDir();
	let d = await startDaemon(dir);
	const c = createClient(d.socketPath);
	const seen: string[] = [];
	c.subscribe({}, (event) => seen.push(event.type));
	await c.request("casRead", { store: "seat", id: "orchestrator" });
	await d.stop();
	d = await startDaemon(dir);
	const until = Date.now() + 10_000;
	while (!seen.includes("RECONNECT") && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
	assert.ok(seen.includes("RECONNECT"), "the subscriber is woken once the client reconnects");
	const other = createClient(d.socketPath);
	await other.request("appendEvent", { type: "WORKING", text: "s", requestId: "r-after" });
	const afterUntil = Date.now() + 5000;
	while (!seen.includes("WORKING") && Date.now() < afterUntil) await new Promise((resolve) => setTimeout(resolve, 100));
	assert.ok(seen.includes("WORKING"), "an event filed after the restart is pushed to the old subscriber");
	other.close();
	c.close();
	await d.stop();
});

test("a retry after the daemon restarts keeps one event", async () => {
	const dir = tempDir();
	let d = await startDaemon(dir);
	let c = createClient(d.socketPath);
	await c.request("appendEvent", { type: "BLOCKED", text: "x", requestId: "same" });
	c.close();
	await d.stop();
	d = await startDaemon(dir);
	c = createClient(d.socketPath);
	assert.deepEqual(await c.request("appendEvent", { type: "BLOCKED", text: "x", requestId: "same" }), {
		duplicate: true,
	});
	const events = await c.request<{ type: string }[]>("events", {});
	assert.equal(events.filter((event) => event.type === "BLOCKED").length, 1);
	c.close();
	await d.stop();
});

test("a second daemon on the same directory refuses to start", async () => {
	const dir = tempDir();
	const d = await startDaemon(dir);
	await assert.rejects(startDaemon(dir), /already running/);
	await d.stop();
});

test("no daemon: the client fails fast with the fixed message", async () => {
	const c = createClient(join(tempDir(), "absent.sock"), { timeoutMs: 300 });
	const started = Date.now();
	await assert.rejects(c.request("casRead", { store: "seat", id: "orchestrator" }), /musterd is not running/);
	assert.ok(Date.now() - started < 1000);
});

test("a one-time write while musterd is down is spooled for the replay", async () => {
	const dir = tempDir();
	const c = createClient(join(dir, "ledger.sock"), { timeoutMs: 300 });
	const queued = await c.request("appendEvent", { type: "WORKING", text: "offline", requestId: "down-1" }, { spool: true });
	assert.deepEqual(queued, { spooled: true });
	const spooled = readSpool(dir);
	assert.equal(spooled.length, 1);
	assert.equal(spooled[0]?.req.method, "appendEvent");
	assert.equal(spooled[0]?.req.params.requestId, "down-1");
	c.close();
});

test("a bad line gets an error reply and the connection keeps working", async () => {
	const d = await startDaemon(tempDir());
	const raw = rawConnect(d.socketPath);
	raw.write("not json\n");
	assert.equal(JSON.parse(await raw.nextLine()).ok, false);
	raw.write(`${JSON.stringify({ id: "1", method: "events", params: {} })}\n`);
	assert.equal(JSON.parse(await raw.nextLine()).ok, true);
	raw.end();
	await d.stop();
});

test("an unknown method is refused and the connection keeps working", async () => {
	const d = await startDaemon(tempDir());
	const raw = rawConnect(d.socketPath);
	raw.write(`${JSON.stringify({ id: "1", method: "notAMethod", params: {} })}\n`);
	const refused = JSON.parse(await raw.nextLine()) as { ok: boolean; error: string };
	assert.equal(refused.ok, false);
	assert.match(refused.error, /unknown method notAMethod/);
	raw.write(`${JSON.stringify({ id: "2", method: "events", params: {} })}\n`);
	assert.equal(JSON.parse(await raw.nextLine()).ok, true);
	raw.end();
	await d.stop();
});
