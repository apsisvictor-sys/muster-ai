/**
 * `muster inbox list|read` — the non-blocking reader the orchestrator waiter uses.
 * `list` must never move a message; `read` moves only the ids it is given.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listInboxMessages, writeInboxMessage } from "../lib/agent-inbox.ts";
import { harnessRoot } from "../../core/harness-paths.ts";
import { musterLauncher } from "../../core/pi-ports.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);

const LAUNCHER = musterLauncher();

function muster(state: string, args: string[]) {
	const result = spawnSync(LAUNCHER, args, { encoding: "utf8", timeout: 60_000, env: { ...process.env, PI_MUSTER_STATE_DIR: state } });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("inbox list prints one tab line per message and moves nothing; inbox read moves only the named id", () => {
	const root = mkdtempSync(join(tmpdir(), "muster-inbox-cli-"));
	const state = join(root, "muster");
	try {
		writeInboxMessage(state, { agent: "orchestrator", from: "grokbot", at: "2026-10-10T17:05:00.000Z", text: "first\tline\nsecond line", idempotencyKey: "a", source: "send", id: "id-a" });
		writeInboxMessage(state, { agent: "orchestrator", from: "pi-core", at: "2026-10-10T17:06:00.000Z", text: "other", idempotencyKey: "b", id: "id-b" });
		const listed = muster(state, ["inbox", "list", "orchestrator"]);
		assert.equal(listed.status, 0, listed.stderr);
		const rows = listed.stdout.trim().split("\n").map((line) => line.split("\t"));
		assert.equal(rows.length, 2);
		assert.deepEqual([rows[0]![0], rows[0]![1], rows[0]![2], rows[0]![3], rows[0]![5]], ["id-a", "2026-10-10T17:05:00.000Z", "grokbot", "send", "first\\tline\\nsecond line"]);
		assert.match(rows[0]![4]!, /\/read\/\d+-id-a\.json$/);
		assert.equal(rows[1]![3], "-", "an empty field is a dash so columns stay aligned");
		assert.equal(listInboxMessages(state, "orchestrator").length, 2, "list moves nothing");

		const read = muster(state, ["inbox", "read", "orchestrator", "id-a"]);
		assert.equal(read.status, 0, read.stderr);
		assert.deepEqual(listInboxMessages(state, "orchestrator").map((message) => message.id), ["id-b"]);
		const again = muster(state, ["inbox", "read", "orchestrator", "id-a"]);
		assert.equal(again.status, 1, "a message already read is reported, not an error to hide");
		assert.equal(muster(state, ["inbox", "list"]).status, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
