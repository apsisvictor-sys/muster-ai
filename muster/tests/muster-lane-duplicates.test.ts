/**
 * The duplicate guard (WP12, LD15): two live sessions under one lane name, or in one lane's session
 * chain, are found from raw `claude agents` rows and tmux panes, and a set is reported once.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeLaneRow, TmuxPane } from "../lib/lane-directory.ts";
import {
	DUPLICATE_MEMORY_MS,
	duplicateDetail,
	duplicatesReportedFile,
	duplicateOperatorText,
	findDuplicateLanes,
	markDuplicateReported,
	readReportedDuplicates,
	type DuplicateEvidence,
} from "../lane-duplicates.ts";

const LIVE = new Set([101, 102, 103, 104]);

function evidence(overrides: Partial<DuplicateEvidence> = {}): DuplicateEvidence {
	return { claudeRows: [], panes: [], records: [], knownLanes: new Set(["sn-product", "sn-a", "sn-x", "pi-x", "sn-other"]), pidAlive: (pid) => LIVE.has(pid), ...overrides };
}

function row(sessionId: string, name: string | undefined, pid: number | undefined, extra: Partial<ClaudeLaneRow> = {}): ClaudeLaneRow {
	return { sessionId, ...(name !== undefined ? { name } : {}), ...(pid !== undefined ? { pid } : {}), ...extra };
}

const pane = (session: string, window: string, extra: Partial<TmuxPane> = {}): TmuxPane => ({ session, window, dead: false, pid: 9000, ...extra });

test("two live rows named sn-product are one duplicate set, with a readable detail and a key that names both", () => {
	const sets = findDuplicateLanes(evidence({ claudeRows: [row("aaaaaaaa-1", "sn-product", 101), row("bbbbbbbb-2", "sn-product", 102), row("cccccccc-3", "sn-other", 103)] }));
	assert.equal(sets.length, 1);
	assert.equal(sets[0]!.lane, "sn-product");
	assert.equal(sets[0]!.key, "claude:aaaaaaaa+claude:bbbbbbbb");
	assert.equal(duplicateDetail(sets[0]!), "duplicate: claude:aaaaaaaa, claude:bbbbbbbb");
	assert.match(duplicateOperatorText(sets[0]!), /Lane sn-product has 2 live sessions .*Nothing was stopped or changed\./);
});

test("a row whose pid is gone or missing is a dead lane, not a second holder", () => {
	assert.deepEqual(findDuplicateLanes(evidence({ claudeRows: [row("aaaaaaaa-1", "sn-a", 101), row("bbbbbbbb-2", "sn-a", 999_999)] })), [], "pid not in /proc");
	assert.deepEqual(findDuplicateLanes(evidence({ claudeRows: [row("aaaaaaaa-1", "sn-a", 101), row("bbbbbbbb-2", "sn-a", undefined)] })), [], "no pid");
});

test("a name nothing on the bus knows is not a lane: two windows called claude, or two sessions with a stray name, are no fork", () => {
	assert.deepEqual(findDuplicateLanes(evidence({ panes: [pane("pi", "claude", { windowId: "@0" }), pane("pi", "claude", { windowId: "@1" })] })), [], "the operator's own windows in the pi session");
	assert.deepEqual(findDuplicateLanes(evidence({ claudeRows: [row("aaaaaaaa-1", "scratch", 101), row("bbbbbbbb-2", "scratch", 102)] })), []);
	assert.equal(findDuplicateLanes(evidence({ panes: [pane("pi", "claude", { windowId: "@0" }), pane("pi", "claude", { windowId: "@1" })], knownLanes: new Set(["claude"]) })).length, 1, "the same windows are a fork once the bus knows the name");
});

test("free-text session names are not lane names and never group", () => {
	assert.deepEqual(findDuplicateLanes(evidence({ claudeRows: [row("aaaaaaaa-1", "parallel audit", 101), row("bbbbbbbb-2", "parallel audit", 102)] })), []);
});

test("a Claude row and a Pi window under one name, and two windows of one name, are duplicates; one window with two panes is not", () => {
	const mixed = findDuplicateLanes(evidence({ claudeRows: [row("aaaaaaaa-1", "sn-x", 101)], panes: [pane("pi", "sn-x", { windowId: "@3" })] }));
	assert.equal(mixed.length, 1);
	assert.deepEqual(mixed[0]!.holders.map((h) => h.harness).sort(), ["claude", "tmux"]);
	const twoWindows = findDuplicateLanes(evidence({ panes: [pane("pi", "pi-x", { windowId: "@3", pid: 1 }), pane("pi", "pi-x", { windowId: "@4", pid: 2 })] }));
	assert.equal(twoWindows.length, 1);
	assert.equal(findDuplicateLanes(evidence({ panes: [pane("pi", "pi-x", { windowId: "@3", pid: 1 }), pane("pi", "pi-x", { windowId: "@3", pid: 2 })] })).length, 0, "split panes of one window are one holder");
	assert.equal(findDuplicateLanes(evidence({ panes: [pane("pi", "pi-x", { windowId: "@3" }), pane("pi", "pi-x", { windowId: "@4", dead: true })] })).length, 0, "a dead pane held by remain-on-exit is not a holder");
	assert.equal(findDuplicateLanes(evidence({ panes: [pane("work", "pi-x", { windowId: "@3" }), pane("work", "pi-x", { windowId: "@4" })] })).length, 0, "only the lane sessions (pi, oc) count");
	assert.deepEqual(findDuplicateLanes(evidence({ panes: undefined, claudeRows: [row("aaaaaaaa-1", "sn-x", 101)] })), [], "an unreadable tmux invents no holder");
});

test("a renamed copy is caught through the session chain of the lane's record", () => {
	const sets = findDuplicateLanes(
		evidence({
			claudeRows: [row("aaaaaaaa-old", "sn-product", 101), row("bbbbbbbb-new", "sn-product-copy", 102), row("cccccccc-3", undefined, 103)],
			records: [{ laneId: "sn-product", sessionChain: ["aaaaaaaa-old", "bbbbbbbb-new"], sessionId: "bbbbbbbb-new" }],
		}),
	);
	assert.equal(sets.length, 1);
	assert.equal(sets[0]!.lane, "sn-product");
	assert.equal(sets[0]!.holders.length, 2);
	// Only the live row counts: the same chain with the old session gone is one holder.
	assert.deepEqual(findDuplicateLanes(evidence({ claudeRows: [row("aaaaaaaa-old", "sn-product", 999_999), row("bbbbbbbb-new", "sn-product", 102)], records: [{ laneId: "sn-product", sessionChain: ["aaaaaaaa-old", "bbbbbbbb-new"] }] })), []);
});

test("one set found by name and by chain is one set, and one holder is never a duplicate of itself", () => {
	const sets = findDuplicateLanes(evidence({ claudeRows: [row("aaaaaaaa-1", "sn-a", 101), row("bbbbbbbb-2", "sn-a", 102)], records: [{ laneId: "sn-a", sessionChain: ["aaaaaaaa-1", "bbbbbbbb-2"] }] }));
	assert.equal(sets.length, 1);
	assert.equal(findDuplicateLanes(evidence({ claudeRows: [row("aaaaaaaa-1", "sn-a", 101)], records: [{ laneId: "sn-a", sessionChain: ["aaaaaaaa-1"], sessionId: "aaaaaaaa-1" }] })).length, 0);
});

test("a reported set is remembered by key, older entries are dropped, and a missing or broken file reads as none", () => {
	const dir = mkdtempSync(join(tmpdir(), "lane-duplicates-"));
	try {
		assert.deepEqual(readReportedDuplicates(dir), {});
		const at = Date.parse("2026-10-12T10:00:00Z");
		markDuplicateReported(dir, "claude:aaaaaaaa+claude:bbbbbbbb", at - DUPLICATE_MEMORY_MS - 1);
		markDuplicateReported(dir, "claude:cccccccc+claude:dddddddd", at);
		assert.deepEqual(readReportedDuplicates(dir), { "claude:cccccccc+claude:dddddddd": at }, "the 30-day-old entry went with the next write");
		assert.equal(readFileSync(duplicatesReportedFile(dir), "utf8").includes("aaaaaaaa"), false);
		rmSync(duplicatesReportedFile(dir));
		assert.deepEqual(readReportedDuplicates(dir), {});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
