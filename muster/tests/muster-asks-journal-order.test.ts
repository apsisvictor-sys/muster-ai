import "./muster-test-isolation.ts";
/**
 * The ask record keeps the journal's own order. Two asks raised inside the same millisecond
 * are ordered by the order their `raised` events were appended, never by their random ids:
 * the `signals-free-launch-ask` suite reads asks by position and CI caught that tie landing
 * the wrong way round.
 */

import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { asksEventsPath, readAsks, orderAsksForOperator, type Ask } from "../asks.ts";

function prepare(dir: string): string {
	const path = asksEventsPath(dir);
	mkdirSync(dirname(path), { recursive: true });
	return path;
}

function withState(run: (dir: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "muster-asks-journal-"));
	const state = join(root, "state", "muster");
	mkdirSync(state, { recursive: true });
	const saved = process.env.PI_MUSTER_STATE_DIR;
	process.env.PI_MUSTER_STATE_DIR = state;
	try {
		run(state);
	} finally {
		if (saved === undefined) delete process.env.PI_MUSTER_STATE_DIR;
		else process.env.PI_MUSTER_STATE_DIR = saved;
		rmSync(root, { recursive: true, force: true });
	}
}

const at = "2026-10-29T15:00:00.000Z";

function raised(id: string, question: string): string {
	return `${JSON.stringify({
		v: 1,
		at,
		id,
		type: "raised",
		by: "orchestrator",
		kind: "decision",
		question,
		options: [],
		rule: "any",
	})}\n`;
}

test("two asks raised in the same millisecond keep the order they were appended in, not their id order", () => {
	withState((dir) => {
		// The journal appends "zebra" first and "alpha" second: the record must read that way round even
		// though the ids sort the other way.
		appendFileSync(prepare(dir), raised("zebra", "first asked") + raised("alpha", "asked second"));

		const asks = readAsks(dir).asks;
		assert.equal(asks.length, 2);
		assert.deepEqual(
			asks.map((ask) => ask.question),
			["first asked", "asked second"],
		);
	});
});

test("the operator's order also keeps the journal order inside one millisecond", () => {
	withState((dir) => {
		appendFileSync(prepare(dir), raised("zebra", "first asked") + raised("alpha", "asked second"));

		const ordered: Ask[] = orderAsksForOperator(readAsks(dir).asks);
		assert.deepEqual(
			ordered.map((ask) => ask.question),
			["first asked", "asked second"],
		);
	});
});
