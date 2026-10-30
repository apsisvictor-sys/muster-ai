import "./muster-test-isolation.ts";
/**
 * The labeller's route walk — ASKFIX (2026-10-29).
 *
 * The hourly sweep lost every candidate of the 00:20 run: the primary route's
 * credential was rejected (401) and the only other ref in the role chain was
 * walled, so `offloadLabeller` marked the whole window `unscanned` and the unit
 * exited 1 (`docs/qa/asksfix-impact-map-2026-10-29.md`). These tests pin the two
 * rules the run turned on: what a run with no usable route reports, and whether
 * a run whose labels the verbatim check refused is an outage.
 *
 * OS temp directories only: the session roots, the muster state directory and
 * the provider list are all parameters.
 *
 * Authored here; executed by the parent through the guarded runner.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configurePiPorts } from "../../core/pi-ports.ts";
import {
	CHUNK_UNSCANNED_QUOTE,
	LabellerRunError,
	SCAN_CLAUDE_ROOT_ENV,
	SCAN_SESSIONS_ROOT_ENV,
	offloadLabeller,
	scanTranscripts,
	unreadableCause,
	unreadableRunIsOutage,
	type ScanCandidate,
	type ScanUnreadableReasons,
} from "../asks-scan.ts";

/** One candidate, in the shape the scan builds from a transcript message. */
function candidate(id: string): ScanCandidate {
	return { id: `pi:s1#${id}`, source: "pi", sessionId: "s1", cwd: "/tmp/asksfix-neutral", kind: "agent-question", text: `Shall I ship change ${id}?` };
}

function emptyReasons(): ScanUnreadableReasons {
	return { "chunk-failed": 0, "no-label": 0, "not-verbatim": 0, unscanned: 0 };
}

/** A provider list with one role and, optionally, a walled provider. */
function writePool(dir: string, worker: readonly string[], walls: Record<string, { until: string; reason?: string }> = {}): string {
	const path = join(dir, "provider-pool.json");
	writeFileSync(
		path,
		JSON.stringify({
			version: 1,
			virtualProvider: "pool-asksfix-test",
			cooldownMs: 3_600_000,
			resetHorizonMs: 7 * 24 * 3_600_000,
			roles: { worker },
			quotaShapes: [{ id: "credential-rejected", match: "Invalid credential" }],
			providerWalls: walls,
		}),
		"utf8",
	);
	return path;
}

/** A rejected credential, in the wording the unit's journal carried. */
function rejectedCredential(): LabellerRunError {
	return new LabellerRunError(
		"the labeller's Pi run exited 1: 401: {\"message\":\"Invalid 'Authorization' header or token.\"}",
		"401: {\"message\":\"Invalid 'Authorization' header or token.\"}",
	);
}

/** The labs' own files: one pi session holding one message that asks a question, and no claude sessions. */
const NOW = Date.parse("2026-10-29T00:20:00+02:00");

function writeSessions(root: string): void {
	const dir = join(root, "pi", "projects");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "s1.jsonl");
	writeFileSync(file, "{}\n", "utf8");
	utimesSync(file, new Date(NOW), new Date(NOW));
}

/** The transcripts port, so a run reads the fixture message instead of a real session file. */
function fakeTranscripts(): void {
	const transcript = {
		sessionId: "s1",
		cwd: "/tmp/asksfix-neutral",
		messages: [{ role: "assistant" as const, speaker: "agent" as const, content: "Shall I ship the change?", timestamp: NOW }],
	};
	configurePiPorts({
		transcripts: {
			readPiTranscript: () => transcript,
			readClaudeTranscript: () => undefined,
			listClaudeTranscriptFiles: () => [],
			readPiTranscriptTail: () => undefined,
		} as never,
	});
}

/** One whole path: session file → candidate → the labeller's route walk → the bucket and the accounting line. */
async function runSweep(dir: string, poolPath: string, run: (command: string, args: readonly string[], timeoutMs: number) => Promise<string>) {
	fakeTranscripts();
	const sessions = join(dir, "sessions");
	const state = join(dir, "state");
	mkdirSync(state, { recursive: true });
	writeSessions(sessions);
	const labeller = offloadLabeller({ poolPath, role: "worker", env: {}, now: () => NOW, deadlineMs: NOW + 600_000, run });
	return scanTranscripts(state, {
		window: "2h",
		now: NOW,
		env: { [SCAN_SESSIONS_ROOT_ENV]: join(sessions, "pi"), [SCAN_CLAUDE_ROOT_ENV]: join(sessions, "claude") } as NodeJS.ProcessEnv,
		labeller,
	});
}

function scratch(name: string): { dir: string; close: () => void } {
	const dir = mkdtempSync(join(tmpdir(), `muster-asks-scan-${name}-`));
	return { dir, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a rejected primary and a walled fallback leave every candidate unscanned, and the report names the count", async () => {
	const { dir, close } = scratch("route");
	try {
		// The 00:20 shape: the primary's credential is rejected and the chain's second ref is walled
		// for longer than the run's whole budget, so no attempt can reach a model at all.
		const poolPath = writePool(dir, ["alpha/model-one", "beta/model-two"], { beta: { until: new Date(NOW + 93 * 60_000).toISOString(), reason: "test wall" } });
		const errors: string[] = [];
		const labels = await offloadLabeller({
			poolPath,
			role: "worker",
			env: {},
			now: () => NOW,
			deadlineMs: NOW + 600_000,
			run: async (_command, args) => {
				if (args.includes("alpha/model-one")) throw rejectedCredential();
				throw new Error(`the walk reached ${args.join(" ")} after the chain was exhausted`);
			},
		})([candidate("a"), candidate("b")], (message) => errors.push(message));

		assert.equal(labels.length, 2, "one label per candidate, so the scan can count them");
		for (const label of labels) assert.equal(label.quote, CHUNK_UNSCANNED_QUOTE, "no attempt labelled this candidate");
		assert.ok(
			errors.some((message) => message === 'no further model in the provider list\'s "worker" chain after alpha/model-one: 2 candidates were not labelled'),
			`the report must name the exhausted chain and what it left behind; got ${JSON.stringify(errors)}`,
		);
		const reasons = { ...emptyReasons(), unscanned: 2 };
		assert.equal(unreadableRunIsOutage({ unreadableReasons: reasons }), true, "a route that could not run is an outage, and the unit must go red");
		assert.match(unreadableCause({ unreadableReasons: reasons }, errors[0]!), /401/, "the warning still carries the rejection's own words");
	} finally {
		close();
	}
});

test("the sweep prints a candidate the labeller never labelled, and stays an outage", async () => {
	const { dir, close } = scratch("sweep-outage");
	try {
		const poolPath = writePool(dir, ["alpha/model-one", "beta/model-two"], { beta: { until: new Date(NOW + 93 * 60_000).toISOString(), reason: "test wall" } });
		const result = await runSweep(dir, poolPath, async (_command, args) => {
			if (args.includes("alpha/model-one")) throw rejectedCredential();
			throw new Error(`the walk reached ${args.join(" ")} after the chain was exhausted`);
		});

		assert.equal(result.candidates, 1, "the fixture session holds one message that asks a question");
		assert.equal(result.buckets.unreadable, 1);
		assert.equal(result.unreadableReasons.unscanned, 1);
		assert.equal(result.findings.length, 0, "nothing is written for a candidate no label reached");
		assert.match(result.accounting, /1 unreadable \(0 chunk-failed, 0 no-label, 0 not-verbatim, 1 unscanned\)/);
		assert.ok(
			result.chunkFailures.some((message) => message.endsWith('after alpha/model-one: 1 candidates were not labelled')),
			`the run's own report must name what it left unlabelled; got ${JSON.stringify(result.chunkFailures)}`,
		);
		assert.equal(unreadableRunIsOutage(result), true);
	} finally {
		close();
	}
});

test("a route that healed and answered with a label the scan refuses is a content rejection, not an outage", async () => {
	const { dir, close } = scratch("sweep-content");
	try {
		// No wall anywhere: the primary is rejected, the fallback answers, and its quote is not in the
		// message. The candidate is unreadable because the verbatim check worked, so the unit stays green.
		const poolPath = writePool(dir, ["alpha/model-one", "beta/model-two"]);
		const result = await runSweep(dir, poolPath, async (_command, args) => {
			if (args.includes("alpha/model-one")) throw rejectedCredential();
			return JSON.stringify([{ id: "pi:s1#0", isAsk: true, kind: "review", question: "Ship the change?", codes: [], sameAs: "", quote: "words the message never held" }]);
		});

		assert.equal(result.candidates, 1);
		assert.equal(result.buckets.unreadable, 1);
		assert.equal(result.unreadableReasons["not-verbatim"], 1, "the label was produced and the scan refused it");
		assert.equal(result.unreadableReasons.unscanned, 0);
		assert.ok(result.chunkFailures.some((message) => /401/.test(message)), "the healed attempt's error is still reported");
		assert.equal(
			unreadableRunIsOutage(result),
			false,
			"the refusal came from the verbatim check, so the contract must not turn red for the model's mistake",
		);
	} finally {
		close();
	}
});
