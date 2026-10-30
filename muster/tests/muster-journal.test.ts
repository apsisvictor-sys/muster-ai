import "./muster-test-isolation.ts";
/**
 * W1 (UB0 UD8, VR24-196 W1, VR24-197 M4/M6): Grokbot's journal.
 * 1. `journal_add` and `journal_read` are on the chat bearer's list and not on the monitor bearer's; a monitor
 *    call is refused, audited, and writes nothing.
 * 2. `journal_add` refuses an unknown field, a field the kind has no place for, an over-long value and a `to`
 *    the gateway cannot write to.
 * 3. Entries round-trip through `muster journal --json`, which also carries the three relay states: a message
 *    holding the quote reads delivered, a missing one not found in the inbox, and other words "the message does
 *    not hold these words". `text` and `quote` both read untrusted, in the JSON and in the plain view.
 * 4. The store is `<stateDir>/journal/events.jsonl`, append only, with a torn tail counted and repaired.
 *
 * Whole path: the real server and tools over the chat bearer, the real inbox owner for the message a relay
 * names, and the real CLI. Every test uses a temp state dir; the quotes are synthetic.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { appendJournal, journalEventsPath, readJournal, JournalRefusal, JOURNAL_QUOTE_MAX_CHARS, JOURNAL_TEXT_MAX_CHARS } from "../journal.ts";
import { writeInboxMessage } from "../lib/agent-inbox.ts";
import { createGatewayTools, EXTERNAL_PREFIX } from "../gateway/tools.ts";
import { startGateway, type RunningGateway } from "../gateway/server.ts";
import { AUDIT_FILE } from "../gateway/state.ts";
import { harnessRoot } from "../../core/harness-paths.ts";
import { musterLauncher } from "../../core/pi-ports.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);
const LAUNCHER = musterLauncher();
const CHAT_TOKEN = "w1-chat-bearer-token-0123456789abcdef";
const MONITOR_TOKEN = "w1-monitor-bearer-token-0123456789abcdef";
const T0 = "2026-10-26T18:00:00.000Z";
/** Synthetic words standing in for the operator's: never his real speech and never a real person. */
const WORDS = "Sample words, 2026-10-26 17:58: send the sample task to the architect";

function withStateDir(run: (dir: string) => void | Promise<void>): void | Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "muster-journal-"));
	const dir = join(root, "muster");
	mkdirSync(dir, { recursive: true });
	const finish = (): void => rmSync(root, { recursive: true, force: true });
	const outcome = run(dir);
	return outcome instanceof Promise ? outcome.finally(finish) : finish();
}

/** One gateway world: the real tools and server, a temp state dir, and the two bearers. */
async function withGateway(run: (world: { muster: string; gateway: RunningGateway; tools: ReturnType<typeof createGatewayTools> }) => Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "muster-journal-gateway-"));
	const muster = join(root, "muster");
	mkdirSync(muster, { recursive: true });
	const saved = process.env["PI_MUSTER_STATE_DIR"];
	process.env["PI_MUSTER_STATE_DIR"] = muster;
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
		await run({ muster, gateway, tools });
	} finally {
		await gateway.close();
		if (saved === undefined) delete process.env["PI_MUSTER_STATE_DIR"];
		else process.env["PI_MUSTER_STATE_DIR"] = saved;
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
const textOf = (reply: any): string => reply.result.content[0].text as string;

/** One message in `address`'s inbox, written the way the gateway's own sends write it. */
function seedRelayedMessage(muster: string, address: string, id: string, text: string): void {
	writeInboxMessage(muster, { id, agent: address, from: "grokbot", at: T0, text, idempotencyKey: `k-${id}`, mode: "followup", source: "send" });
}

test("W1 1: journal_add and journal_read are chat-only, and a monitor call writes nothing", async () => {
	await withGateway(async ({ muster, gateway, tools }) => {
		const chat = await listed(gateway, CHAT_TOKEN);
		const monitor = await listed(gateway, MONITOR_TOKEN);
		for (const name of ["journal_add", "journal_read"]) {
			assert.ok(chat.includes(name), `chat lists ${name}`);
			assert.ok(!monitor.includes(name), `monitor must not list ${name}`);
		}
		const flagged = tools.filter((tool) => tool.chatOnly === true).map((tool) => tool.name);
		assert.ok(flagged.includes("journal_add") && flagged.includes("journal_read"), "both journal tools carry chatOnly");

		const denied = await callTool(gateway, MONITOR_TOKEN, "journal_add", { kind: "error", text: "sample failure" });
		assert.equal(denied.result.isError, true, "the monitor bearer cannot journal");
		const deniedRead = await callTool(gateway, MONITOR_TOKEN, "journal_read", {});
		assert.equal(deniedRead.result.isError, true, "the monitor bearer cannot read the journal");

		const audit = readFileSync(join(muster, AUDIT_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
		const monitorCalls = audit.filter((line) => String(line["tool"]).startsWith("journal_"));
		assert.ok(monitorCalls.length >= 2 && monitorCalls.every((line) => line["refused"] === true), "the refused monitor calls are audited");
		assert.throws(() => readFileSync(journalEventsPath(muster), "utf8"), "nothing reached the journal file");

		const unknown = await callTool(gateway, CHAT_TOKEN, "journal_add", { kind: "error", text: "sample failure", colour: "red" });
		assert.equal(unknown.result.isError, true);
		assert.match(textOf(unknown), /unknown field: colour/);

		const added = await callTool(gateway, CHAT_TOKEN, "journal_add", { kind: "error", text: "sample failure in the sample run" });
		assert.equal(added.result.isError, undefined, textOf(added));
		const entry = JSON.parse(textOf(added)) as Record<string, unknown>;
		assert.equal(entry["by"], "grokbot");
		assert.equal(entry["kind"], "error");
		assert.match(String(entry["id"]), /^jnl_/);
	});
});

test("W1 2: journal_add refuses an unknown field, a misplaced field, an over-long value and a foreign to", () => {
	withStateDir((dir) => {
		const refuses = (input: Record<string, unknown>, pattern: RegExp): void => {
			assert.throws(() => appendJournal(dir, input, T0), (error: unknown) => error instanceof JournalRefusal && pattern.test(error.message), JSON.stringify(input));
		};
		refuses({ kind: "error", text: "sample", colour: "red" }, /unknown field: colour/);
		refuses({ kind: "error", text: "x".repeat(JOURNAL_TEXT_MAX_CHARS + 1) }, /text is longer than 300/);
		refuses({ kind: "relay", text: "sample", quote: "x".repeat(JOURNAL_QUOTE_MAX_CHARS + 1), to: "architect", ref: "m-1" }, /quote is longer than 2000/);
		refuses({ kind: "task", text: "sample", state: "started", quote: "sample words" }, /quote is not a field of a task entry/);
		refuses({ kind: "relay", text: "sample", quote: WORDS, to: "architect" }, /ref is required/);
		refuses({ kind: "relay", text: "sample", quote: WORDS, to: "architect", ref: "m-1", state: "started" }, /state is not a field of a relay entry/);
		refuses({ kind: "relay", text: "sample", quote: WORDS, to: "pi-sample-lane", ref: "m-1" }, /pi-sample-lane is not an inbox address/);
		refuses({ kind: "task", text: "sample", state: "scheduled" }, /a scheduled task needs when/);
		refuses({ kind: "task", text: "sample", state: "started", when: "2026-10-27T08:00:00.000Z" }, /when is for a scheduled task only/);
		refuses({ kind: "task", text: "sample", state: "dropped", why: "x".repeat(201) }, /why is longer than 200/);
		refuses({ kind: "task", text: "sample", state: "done", why: "the sample plan changed" }, /why is for a dropped task only/);
		refuses({ kind: "note", text: "sample" }, /kind must be one of/);
		refuses({ kind: "error" }, /text is required/);

		// The accepted shapes land, one per kind.
		assert.equal(appendJournal(dir, { kind: "error", text: "sample failure" }, T0).kind, "error");
		const relay = appendJournal(dir, { kind: "relay", text: "carried the sample words", quote: WORDS, to: "architect", ref: "m-1" }, T0);
		assert.equal(relay.to, "architect");
		assert.equal(relay.ref, "m-1");
		const scheduled = appendJournal(dir, { kind: "task", text: "sample task", state: "scheduled", when: "2026-10-27T08:00:00.000Z" }, T0);
		assert.equal(scheduled.when, "2026-10-27T08:00:00.000Z");
		assert.equal(appendJournal(dir, { kind: "task", text: "sample task", state: "dropped", why: "the sample plan changed" }, T0).why, "the sample plan changed");
		assert.equal(readJournal(dir).entries.length, 4);
	});
});

test("W1 3: entries round-trip through muster journal --json with the three relay states, text and quote untrusted", () => {
	withStateDir((dir) => {
		// One message that holds the quote (the gateway's own prefix and a line break around it), one address with
		// no such message, and one message with other words.
		seedRelayedMessage(dir, "architect", "m-holds", `${EXTERNAL_PREFIX}Note from Henry.\n\n${WORDS}\n`);
		seedRelayedMessage(dir, "orchestrator", "m-other", `${EXTERNAL_PREFIX}Note from Henry: something else entirely`);
		appendJournal(dir, { kind: "relay", text: "sent to the architect", quote: WORDS, to: "architect", ref: "m-holds" }, T0);
		appendJournal(dir, { kind: "relay", text: "sent to the orchestrator", quote: WORDS, to: "orchestrator", ref: "m-other" }, "2026-10-26T18:01:00.000Z");
		appendJournal(dir, { kind: "relay", text: "sent to the architect", quote: WORDS, to: "architect", ref: "m-missing" }, "2026-10-26T18:02:00.000Z");
		appendJournal(dir, { kind: "task", text: "started the sample task", state: "started" }, "2026-10-26T18:03:00.000Z");

		const json = spawnSync(LAUNCHER, ["--json", "journal"], { encoding: "utf8", timeout: 60_000, env: { ...process.env, PI_MUSTER_STATE_DIR: dir } });
		assert.equal(json.status, 0, json.stderr);
		const read = JSON.parse(json.stdout) as { entries: Array<Record<string, unknown>>; path: string; partialLastLine: number; unreadableLines: number };
		assert.deepEqual(Object.keys(read).sort(), ["entries", "partialLastLine", "path", "unreadableLines"], "the JSON view's keys");
		assert.equal(read.path, journalEventsPath(dir));
		assert.equal(read.entries.length, 4, "every entry round-trips");
		assert.deepEqual(read.entries.map((entry) => entry["kind"]), ["relay", "relay", "relay", "task"], "oldest first");
		assert.deepEqual(read.entries.map((entry) => entry["relay"]), ["delivered", "the message does not hold these words", "not found in the inbox", undefined]);
		for (const entry of read.entries) {
			assert.equal(entry["untrusted"], true, "every entry is Grokbot's");
			assert.ok(String(entry["text"]).startsWith(EXTERNAL_PREFIX), "text reads behind the external-agent prefix");
			assert.equal(entry["by"], "grokbot");
			if (entry["kind"] === "relay") assert.ok(String(entry["quote"]).startsWith(EXTERNAL_PREFIX), "the quote reads behind it too");
		}
		assert.equal(read.entries[0]!["to"], "architect");
		assert.equal(read.entries[0]!["ref"], "m-holds");

		const since = spawnSync(LAUNCHER, ["--json", "journal", "--since", "2026-10-26T18:02:00.000Z"], { encoding: "utf8", timeout: 60_000, env: { ...process.env, PI_MUSTER_STATE_DIR: dir } });
		assert.equal(since.status, 0, since.stderr);
		assert.equal((JSON.parse(since.stdout) as { entries: unknown[] }).entries.length, 2, "--since cuts the older entries");
		const kind = spawnSync(LAUNCHER, ["--json", "journal", "--kind", "task"], { encoding: "utf8", timeout: 60_000, env: { ...process.env, PI_MUSTER_STATE_DIR: dir } });
		assert.equal(kind.status, 0, kind.stderr);
		assert.deepEqual((JSON.parse(kind.stdout) as { entries: Array<Record<string, unknown>> }).entries.map((entry) => entry["state"]), ["started"], "--kind filters");

		const plain = spawnSync(LAUNCHER, ["journal"], { encoding: "utf8", timeout: 60_000, env: { ...process.env, PI_MUSTER_STATE_DIR: dir } });
		assert.equal(plain.status, 0, plain.stderr);
		assert.match(plain.stdout, /UNTRUSTED/);
		assert.match(plain.stdout, /relay: delivered/);
		assert.match(plain.stdout, /quote: .*sample task/);
	});
});

test("W1 4: the journal file is append only, and a torn tail is counted and repaired by the next append", () => {
	withStateDir((dir) => {
		appendJournal(dir, { kind: "error", text: "first sample failure" }, T0);
		appendJournal(dir, { kind: "error", text: "second sample failure" }, "2026-10-26T18:01:00.000Z");
		assert.equal(readFileSync(journalEventsPath(dir), "utf8").trim().split("\n").length, 2, "one line per entry");

		writeFileSync(journalEventsPath(dir), `${readFileSync(journalEventsPath(dir), "utf8")}{"id":"jnl_torn"`, "utf8");
		const torn = readJournal(dir);
		assert.equal(torn.entries.length, 2, "the two whole entries still read");
		assert.equal(torn.partialLastLine, 1, "the torn tail is counted");
		appendJournal(dir, { kind: "error", text: "third sample failure" }, "2026-10-26T18:02:00.000Z");
		const repaired = readJournal(dir);
		assert.equal(repaired.entries.length, 3, "the entry after the repair reads");
		assert.equal(repaired.unreadableLines, 1, "the torn line stays its own unreadable line");
		assert.deepEqual(repaired.entries.map((entry) => entry.text), ["first sample failure", "second sample failure", "third sample failure"]);
	});
});
