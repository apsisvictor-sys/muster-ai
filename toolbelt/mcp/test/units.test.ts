/**
 * The server's two pieces that need no CLI: how a child's output is collected, and which preserved payloads are
 * removed at startup. The server is imported for them, so these run against the real functions with real files
 * and a real child process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PAYLOAD_MAX_AGE_MS, createOutputCollector, pruneStalePayloads, spawnExec } from "../server.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

test("a multibyte character split across chunks is read whole", () => {
	const bytes = Buffer.from("Привет, свят", "utf8");
	// Byte 3 is inside the second letter (two bytes each): a per-chunk decode turns both halves into U+FFFD.
	const collector = createOutputCollector(1024);
	collector.push(bytes.subarray(0, 3));
	collector.push(bytes.subarray(3));
	assert.equal(collector.text(), "Привет, свят");
});

test("the limit counts bytes, not UTF-16 characters", () => {
	const collector = createOutputCollector(10);
	collector.push(Buffer.from("Прив", "utf8")); // 4 characters, 8 bytes
	collector.push(Buffer.from("ет", "utf8")); // 4 bytes: 12 in all, past the limit
	assert.equal(collector.text(), "Прив", "the chunk that would pass the limit is not kept");
	collector.push(Buffer.from("a", "utf8"));
	assert.equal(collector.text(), "Прив", "and nothing is kept after it, so the output never has a hole");
});

test("a real child that writes a character in two pieces is read whole through spawnExec", async () => {
	const script = [
		"const bytes = Buffer.from('Съобщение: Привет', 'utf8');",
		"process.stdout.write(bytes.subarray(0, 3));",
		"setTimeout(() => process.stdout.write(bytes.subarray(3)), 80);",
	].join("");
	const result = await spawnExec(process.execPath, ["-e", script], { cwd: tmpdir() });
	assert.equal(result.code, 0);
	assert.equal(result.stdout, "Съобщение: Привет");
});

function stateWith(sessions: Record<string, number>): { state: string; results: string; cleanup(): void } {
	const state = mkdtempSync(join(tmpdir(), "toolbelt-mcp-prune-"));
	const results = join(state, "toolbelt-results");
	mkdirSync(results, { recursive: true });
	const now = Date.now();
	for (const [name, ageMs] of Object.entries(sessions)) {
		const dir = join(results, name);
		mkdirSync(dir);
		writeFileSync(join(dir, "toolbelt-result-abc-1.txt"), "payload");
		const at = new Date(now - ageMs);
		utimesSync(dir, at, at);
	}
	return { state, results, cleanup: () => rmSync(state, { recursive: true, force: true }) };
}

test("a session's payload directory older than the retention is removed, a newer one is kept", () => {
	const fixture = stateWith({ "claude-code-100-1": 8 * DAY_MS, "claude-code-200-2": 1 * DAY_MS });
	try {
		const removed = pruneStalePayloads(fixture.state, Date.now());
		assert.deepEqual(removed, ["claude-code-100-1"]);
		assert.equal(existsSync(join(fixture.results, "claude-code-100-1")), false);
		assert.equal(existsSync(join(fixture.results, "claude-code-200-2", "toolbelt-result-abc-1.txt")), true);
		assert.equal(PAYLOAD_MAX_AGE_MS, 7 * DAY_MS);
	} finally {
		fixture.cleanup();
	}
});

test("only directories this server names are removed: other names, plain files and links are left alone", () => {
	const fixture = stateWith({ "notes-by-hand": 30 * DAY_MS, "claude-code-100-1": 30 * DAY_MS });
	const outside = mkdtempSync(join(tmpdir(), "toolbelt-mcp-outside-"));
	try {
		writeFileSync(join(outside, "keep.txt"), "not ours");
		symlinkSync(outside, join(fixture.results, "hermes-300-3"));
		writeFileSync(join(fixture.results, "claude-code-400-4"), "a file, not a session directory");
		const removed = pruneStalePayloads(fixture.state, Date.now());
		assert.deepEqual(removed, ["claude-code-100-1"]);
		assert.equal(existsSync(join(fixture.results, "notes-by-hand")), true);
		assert.equal(existsSync(join(fixture.results, "claude-code-400-4")), true);
		assert.equal(existsSync(join(outside, "keep.txt")), true, "a link is never followed");
	} finally {
		fixture.cleanup();
		rmSync(outside, { recursive: true, force: true });
	}
});

test("a state directory with nothing to prune, or none at all, is not an error", () => {
	assert.deepEqual(pruneStalePayloads(join(tmpdir(), "toolbelt-mcp-does-not-exist-9"), Date.now()), []);
	const fixture = stateWith({});
	try {
		assert.deepEqual(pruneStalePayloads(fixture.state, Date.now()), []);
	} finally {
		fixture.cleanup();
	}
});
