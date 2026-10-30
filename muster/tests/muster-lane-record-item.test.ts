import "./muster-test-isolation.ts";
/**
 * OL2 (out-loop spec Revision 3 §10 row OL2): the launcher's `--item`, proved at the command's own entry.
 *
 * `muster-lane-record-crr.test.ts` drives the **deployed** profile launcher, whose code is the released
 * checkout, so a flag that has not been deployed yet cannot be proved through it. This file calls the
 * command in this checkout instead, with a scratch state directory:
 *   1. `launch --item <code> --launched-by dispatcher` reaches the record, which is how a crash is resolved;
 *   2. a relaunch that names no item keeps the item, because a resumed lane still serves it;
 *   3. the usage text names both, so a launcher's author finds them.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { command } from "../cli/lane-record.ts";
import type { CliContext } from "../cli/types.ts";
import { readLaneRecord, type LaneRecord } from "../lane-lifecycle.ts";

type Run = { status: number; out: string[]; err: string[] };

/** One invocation of the command, as the CLI frame would hand it over. */
async function run(stateDir: string, argv: string[]): Promise<Run> {
	const out: string[] = [];
	const err: string[] = [];
	const ctx: CliContext = {
		argv,
		repoRoot: process.cwd(),
		agentId: undefined,
		json: false,
		cwd: stateDir,
		env: { PI_MUSTER_STATE_DIR: stateDir, HOME: stateDir },
		io: { out: (line) => out.push(line), err: (line) => err.push(line) },
		readStdin: async () => "",
	};
	const status = await command.run(ctx);
	return { status, out, err };
}

test("launch --item names the work item the lane serves, and a relaunch that names none keeps it", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "muster-lane-record-item-"));
	try {
		const launched = await run(stateDir, ["launch", "--lane", "ol2b-a1", "--harness", "pi",
			"--title", "Rebuild the dispatcher on the current main", "--launched-by", "dispatcher", "--item", "OL2B"]);
		assert.equal(launched.status, 0, launched.err.join("\n"));
		const record = readLaneRecord(stateDir, "ol2b-a1") as LaneRecord;
		assert.equal(record.item, "OL2B", "the record says which work item the lane serves, so a crash is resolvable");
		assert.equal(record.launchedBy, "dispatcher", "the dispatcher is a value the record accepts");
		const again = await run(stateDir, ["launch", "--lane", "ol2b-a1", "--harness", "pi"]);
		assert.equal(again.status, 0, again.err.join("\n"));
		assert.equal(readLaneRecord(stateDir, "ol2b-a1")?.item, "OL2B", "sticky: a relaunch that names no item keeps it");
	} finally {
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("the usage names --item and the dispatcher, so a launcher's author finds both", () => {
	const usage = command.usage;
	assert.match(usage, /--item <code>/);
	assert.match(usage, /--launched-by orchestrator\|dispatcher\|grokbot\|<lane>/);
});
