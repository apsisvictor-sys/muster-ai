import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listInboxMessages } from "../lib/agent-inbox.ts";
import { resolveAttachment, storeAttachment } from "../lib/inbox-attachments.ts";
import { command as sendCommand } from "../cli/send.ts";
import type { CliContext } from "../cli/types.ts";
import { DEFAULT_MAILBOX_ASSIGNEE, DEFAULT_MAILBOX_REPO, wakeGrokbot, wakeTitle } from "../grokbot-wake.ts";
import { laneSendDeps } from "../send-deps.ts";
import { deliverLaneMessage, type SendLogRecord } from "../send.ts";

function withState(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "muster-send-attach-"));
	return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

async function fileRef(state: string, name: string, body: string, to: string) {
	const source = join(state, `src-${name}`);
	writeFileSync(source, body);
	return storeAttachment(state, { sourcePath: source, name, from: "pi-a", to });
}

test("a wake message to grokbot carries the files on the inbox message, one id line per file, and calls the wake once", async () => {
	await withState(async (state) => {
		const ref = await fileRef(state, "plan.pdf", "pdf bytes", "grokbot");
		const wakes: Array<{ messageId: string; firstLine: string; attachmentCount: number }> = [];
		const outcome = await deliverLaneMessage(
			{ laneId: "grokbot", mode: "wake", text: "Plan for the operator\nsecond line stays local", attachments: [ref] },
			laneSendDeps(state, "pi-a", { confirmArrival: false, wakeGrokbot: async (wake) => { wakes.push(wake); } }),
		);
		assert.equal(outcome.transport, "inbox");
		const [message] = listInboxMessages(state, "grokbot");
		assert.ok(message);
		assert.deepEqual(message.attachments, [ref]);
		assert.equal(message.mode, "wake");
		assert.match(message.text, new RegExp(`Attached: plan\\.pdf \\(9 B\\), id ${ref.id}; download it with attachment_link`));
		assert.ok(!message.text.includes(state), "a path on this machine means nothing to Henry and is not sent");
		assert.deepEqual(wakes, [{ messageId: message.id, firstLine: "Plan for the operator", attachmentCount: 1 }]);
		assert.equal(outcome.transport === "inbox" && outcome.messageId, message.id);
	});
});

test("a failing wake is logged once and never fails the send", async () => {
	await withState(async (state) => {
		const ref = await fileRef(state, "a.txt", "x", "grokbot");
		const outcome = await deliverLaneMessage(
			{ laneId: "grokbot", mode: "wake", text: "hello", attachments: [ref] },
			laneSendDeps(state, "pi-a", { confirmArrival: false, wakeGrokbot: async () => { throw new Error("gh issue create failed (exit 1): no auth"); } }),
		);
		assert.equal(outcome.transport, "inbox");
		assert.equal(listInboxMessages(state, "grokbot").length, 1);
		const log = readFileSync(join(state, "send-log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as SendLogRecord);
		assert.equal(log.filter((record) => record.wake === "failed").length, 1);
		assert.match(log.find((record) => record.wake === "failed")?.error ?? "", /no auth/);
	});
});

test("every message to grokbot wakes whatever the mode, and a wake to another agent does not", async () => {
	await withState(async (state) => {
		let wakes = 0;
		const deps = laneSendDeps(state, "pi-a", { confirmArrival: false, wakeGrokbot: async () => { wakes += 1; } });
		await deliverLaneMessage({ laneId: "orchestrator", mode: "wake", text: "to the orchestrator" }, { ...deps, endpointless: () => "its inbox" });
		assert.equal(wakes, 0);
		await deliverLaneMessage({ laneId: "grokbot", mode: "followup", text: "plain" }, deps);
		assert.equal(wakes, 1);
		await deliverLaneMessage({ laneId: "grokbot", mode: "wake", text: "now" }, deps);
		assert.equal(wakes, 2);
	});
});

test("a lane reads the file from the absolute path in the message text", async () => {
	await withState(async (state) => {
		const ref = await fileRef(state, "data.csv", "1,2", "pi-b");
		const prompts: string[] = [];
		await deliverLaneMessage(
			{ laneId: "pi-b", mode: "followup", text: "see file", attachments: [ref] },
			{ ...laneSendDeps(state, "pi-a", { confirmArrival: false }), concord: { callTool: async (_name, args) => { prompts.push(String(args["content"])); return { structuredContent: { message_id: "c1", status: "delivered" } }; } } },
		);
		assert.equal(prompts.length, 1);
		assert.ok(prompts[0]!.includes(`Attached: data.csv (3 B), ${resolveAttachment(state, ref.id)!.path}`));
	});
});

test("wakeGrokbot opens one issue with the first line only, in the configured repo, assigned to the configured account, through the injected client", async () => {
	const calls: Array<{ command: string; args: string[]; timeoutMs: number }> = [];
	const exec = async (command: string, args: string[], timeoutMs: number) => { calls.push({ command, args, timeoutMs }); return { exitCode: 0, stdout: "https://github.com/x/y/issues/1", stderr: "" }; };
	await wakeGrokbot({ messageId: "m-9", from: "pi-a", firstLine: `${"x".repeat(100)}`, attachmentCount: 2 }, { exec, env: { GH_TOKEN: "fake-send-attach-token" } });
	assert.equal(calls.length, 1);
	const args = calls[0]!.args;
	assert.equal(calls[0]!.command, "gh");
	assert.equal(calls[0]!.timeoutMs, 5000);
	assert.deepEqual(args.slice(0, 4), ["issue", "create", "--repo", DEFAULT_MAILBOX_REPO]);
	assert.equal(args[args.indexOf("--assignee") + 1], DEFAULT_MAILBOX_ASSIGNEE);
	assert.equal(args[args.indexOf("--title") + 1], `pi-a: ${"x".repeat(80)}`);
	assert.equal(args[args.indexOf("--body") + 1], "Delivery m-9 with 2 file(s). Read it with outbox_read.");
	await wakeGrokbot({ messageId: "m-9", from: "pi-a", firstLine: "t", attachmentCount: 0 }, { exec, env: { GH_TOKEN: "fake-send-attach-token" }, repo: "someone/else", assignee: "someone-else" });
	assert.equal(calls[1]!.args[3], "someone/else");
	assert.equal(calls[1]!.args[calls[1]!.args.indexOf("--assignee") + 1], "someone-else");
	assert.equal(wakeTitle("pi-a", "line\u0007with\tcontrol"), "pi-a: line with control");
	await assert.rejects(() => wakeGrokbot({ messageId: "m", from: "a", firstLine: "b", attachmentCount: 0 }, { exec: async () => ({ exitCode: 1, stdout: "", stderr: "HTTP 404: Not Found" }) }), /exit 1\): HTTP 404/);
});

test("the relay admission path marks the inbox entries it admits; an unmarked wiring leaves no mark (LD35)", async () => {
	await withState(async (state) => {
		const admitted = laneSendDeps(state, "orchestrator", { confirmArrival: false, relayAdmitted: true });
		await deliverLaneMessage({ laneId: "pi-lane", mode: "followup", text: "marked" }, { ...admitted, endpointless: () => "its inbox" });
		const [marked] = listInboxMessages(state, "pi-lane");
		assert.ok(marked);
		assert.equal(marked.relayAdmitted, true);

		const plain = laneSendDeps(state, "orchestrator", { confirmArrival: false });
		await deliverLaneMessage({ laneId: "pi-other", mode: "followup", text: "not admitted" }, { ...plain, endpointless: () => "its inbox" });
		const [unmarked] = listInboxMessages(state, "pi-other");
		assert.ok(unmarked);
		assert.equal(unmarked.relayAdmitted, undefined, "without the CLI admission the entry carries no launcher authority");
	});
});

test("muster send --attach stores the files first, defaults to wake for grokbot, and calls gh once through a fake binary", async () => {
	await withState(async (state) => {
		const bin = join(state, "fake-bin");
		mkdirSync(bin);
		const ghLog = join(state, "gh.log");
		writeFileSync(join(bin, "gh"), `#!/bin/sh\nif [ "$1" = "auth" ]; then echo "fake-login-token"; exit 0; fi\necho "$@" >> "${ghLog}"\nexit 0\n`);
		chmodSync(join(bin, "gh"), 0o755);
		const saved = { PATH: process.env.PATH, PI_MUSTER_STATE_DIR: process.env.PI_MUSTER_STATE_DIR, GROKBOT_MAILBOX_REPO: process.env.GROKBOT_MAILBOX_REPO, GROKBOT_MAILBOX_ASSIGNEE: process.env.GROKBOT_MAILBOX_ASSIGNEE };
		process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
		process.env.PI_MUSTER_STATE_DIR = state;
		delete process.env.GROKBOT_MAILBOX_REPO;
		delete process.env.GROKBOT_MAILBOX_ASSIGNEE;
		try {
			const a = join(state, "one.txt");
			const b = join(state, "two.txt");
			writeFileSync(a, "1");
			writeFileSync(b, "22");
			const out: string[] = [];
			const err: string[] = [];
			const ctx = (argv: string[]): CliContext => ({ argv, repoRoot: state, agentId: "pi-a", json: true, cwd: state, env: { ...process.env, PI_MUSTER_STATE_DIR: state }, io: { out: (line) => out.push(line), err: (line) => err.push(line) }, readStdin: async () => "" });
			const code = await sendCommand.run(ctx(["grokbot", "two files", "--attach", a, "--attach", b]));
			assert.equal(code, 0, err.join("\n"));
			const [message] = listInboxMessages(state, "grokbot");
			assert.ok(message);
			assert.equal(message.mode, "wake");
			assert.deepEqual(message.attachments?.map((file) => [file.name, file.size]), [["one.txt", 1], ["two.txt", 2]]);
			for (const file of message.attachments ?? []) assert.ok(resolveAttachment(state, file.id), "every file is stored before the message names it");
			assert.equal(JSON.parse(out.join("")).messageId, message.id);

			// The same wiring reads the assignee from its environment beside the repo.
			process.env.GROKBOT_MAILBOX_ASSIGNEE = "someone-else";
			assert.equal(await sendCommand.run(ctx(["grokbot", "env override", "--attach", a])), 0, err.join("\n"));
			const ghLines = readFileSync(ghLog, "utf8").trim().split("\n");
			assert.equal(ghLines.length, 2);
			assert.match(ghLines[0]!, /issue create --repo muster-dev\/henry-mailbox --assignee muster-dev --title pi-a: two files --body Delivery /);
			assert.match(ghLines[1]!, /--assignee someone-else --title pi-a: env override/);

			// A file that is not there sends nothing, and stores nothing new.
			const before = readdirSync(join(state, "attachments")).length;
			const missing = await sendCommand.run(ctx(["grokbot", "nope", "--attach", join(state, "missing.txt")]));
			assert.equal(missing, 2);
			assert.equal(listInboxMessages(state, "grokbot").length, 2);
			assert.equal(readdirSync(join(state, "attachments")).length, before);
			assert.match(err.join("\n"), /--attach failed .*nothing was sent/);
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});
