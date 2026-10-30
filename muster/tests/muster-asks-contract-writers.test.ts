import "./muster-test-isolation.ts";
/**
 * The two system writers (spec §4, OL0b): `ASK_WRITERS` gains `tick` and `doctor` and nothing else, and
 * their reach stops at the asks the contract table declares — raise, prepare and withdraw, never a ruling.
 *
 * OS temp directories only: no network, no provider, no Concord. The codes are driven through the owner
 * (`CONTRACT_ASK_CODES`), so a contract code that stops satisfying `CODE_PATTERN` fails here.
 *
 * Authored here; executed by the parent through the guarded runner.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	ASK_WRITERS,
	CONTRACT_ASK_WRITERS,
	AskStateError,
	answerAsk,
	finishAsk,
	noteAsk,
	prepareAsk,
	raiseAsk,
	withdrawAsk,
} from "../asks.ts";
import { CONTRACT_ASK_CODES, CONTRACT_TABLE } from "../health/contracts.ts";

function stateDir(): string {
	return mkdtempSync(join(tmpdir(), "muster-contract-writers-"));
}

test("writers: ASK_WRITERS gains `tick` and `doctor`, and only those two", () => {
	assert.deepEqual([...CONTRACT_ASK_WRITERS], ["tick", "doctor"]);
	assert.ok(ASK_WRITERS.includes("tick"), "the tick raises its repair asks in its own name");
	assert.ok(ASK_WRITERS.includes("doctor"), "the doctor raises the two the tick cannot report itself");
	assert.equal(ASK_WRITERS.length, 12, "the ten writers before this change plus exactly two");
	assert.equal(new Set(ASK_WRITERS).size, ASK_WRITERS.length, "no writer is listed twice");
});

test("writers: every contract ask code satisfies the queue's own code pattern, through `raiseAsk` itself", () => {
	const dir = stateDir();
	try {
		assert.ok(CONTRACT_ASK_CODES.size >= 40, "the table declares a code per contract");
		for (const code of CONTRACT_ASK_CODES) {
			const ask = raiseAsk(dir, { by: "tick", kind: "authorization", question: `contract ${code} is red`, code });
			assert.equal(ask.code, code, `${code} was accepted by the queue`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writers: the tick raises, prepares and withdraws its own contract ask", () => {
	const dir = stateDir();
	try {
		const raised = raiseAsk(dir, { by: "tick", kind: "authorization", question: "muster-tick.timer is red: restart it", code: "C-TICK-TIMER" });
		const prepared = prepareAsk(dir, { by: "tick", ref: raised.id, options: ["Restart the tick", "Leave it red"], recommendation: "Restart the tick" });
		assert.equal(prepared.status, "awaiting-operator");
		const withdrawn = withdrawAsk(dir, { by: "tick", ref: raised.id, reason: "the contract is green again" });
		assert.equal(withdrawn.status, "withdrawn");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writers: the doctor raises and withdraws its own contract ask", () => {
	const dir = stateDir();
	try {
		const raised = raiseAsk(dir, { by: "doctor", kind: "authorization", question: "muster tick has not passed for ten minutes", code: "C-TICK" });
		assert.equal(raised.raisedBy, "doctor");
		const withdrawn = withdrawAsk(dir, { by: "doctor", ref: raised.id, reason: "the tick's heartbeat is fresh" });
		assert.equal(withdrawn.status, "withdrawn");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writers: a system writer cannot raise an ask without a contract code, or with a stranger's", () => {
	const dir = stateDir();
	try {
		assert.throws(
			() => raiseAsk(dir, { by: "tick", kind: "authorization", question: "something is wrong" }),
			(err: unknown) => err instanceof AskStateError && err.code === "refused" && /only a contract ask/.test(err.message),
		);
		assert.throws(
			() => raiseAsk(dir, { by: "doctor", kind: "authorization", question: "something is wrong", code: "C-NOT-A-CONTRACT" }),
			(err: unknown) => err instanceof AskStateError && err.code === "refused" && /only the asks the contract table declares/.test(err.message),
		);
		// A code a human writer may use freely is still refused to a system writer when no contract declares it.
		assert.ok(!CONTRACT_ASK_CODES.has("VR24-999"));
		assert.throws(() => raiseAsk(dir, { by: "tick", kind: "authorization", question: "x", code: "VR24-999" }), AskStateError);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writers: a system writer prepares and withdraws only a contract ask", () => {
	const dir = stateDir();
	try {
		const human = raiseAsk(dir, { by: "orchestrator", kind: "product-decision", question: "which shape?", code: "OL0B-Q1" });
		assert.throws(
			() => prepareAsk(dir, { by: "tick", ref: human.id, options: ["a", "b"], recommendation: "a" }),
			(err: unknown) => err instanceof AskStateError && err.code === "refused",
		);
		assert.throws(
			() => withdrawAsk(dir, { by: "doctor", ref: human.id, reason: "not mine" }),
			(err: unknown) => err instanceof AskStateError && err.code === "refused",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writers: a system writer records no ruling and no note", () => {
	const dir = stateDir();
	try {
		const ask = raiseAsk(dir, { by: "tick", kind: "authorization", question: "C: is under the floor", code: "C-DISK" });
		for (const [label, run] of [
			["answers", () => answerAsk(dir, { by: "tick", ref: ask.id, ruling: "freed space" })],
			["finishes", () => finishAsk(dir, { by: "doctor", ref: ask.id, evidence: "commit:0a1b2c3@pi" })],
			["notes", () => noteAsk(dir, { by: "doctor", ref: ask.id, text: "still red" })],
		] as const) {
			assert.throws(
				() => run(),
				(err: unknown) => err instanceof AskStateError && err.code === "refused" && err.message.includes(label),
				`${label} is refused to a system writer`,
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writers: the human writers are unchanged by the new scope", () => {
	const dir = stateDir();
	try {
		const ask = raiseAsk(dir, { by: "orchestrator", kind: "product-decision", question: "which shape?" });
		assert.equal(ask.raisedBy, "orchestrator");
		const prepared = prepareAsk(dir, { by: "architect", ref: ask.id, options: ["a", "b"], recommendation: "a" });
		assert.equal(prepared.status, "awaiting-operator");
		const noted = noteAsk(dir, { by: "orchestrator", ref: ask.id, text: "waiting on the design session" });
		assert.equal(noted.notes.length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writers: every contract's own code is the one its row would raise", () => {
	for (const [id, declared] of Object.entries(CONTRACT_TABLE)) {
		assert.ok(CONTRACT_ASK_CODES.has(declared.askCode), `${id}'s code is in the set`);
	}
});
