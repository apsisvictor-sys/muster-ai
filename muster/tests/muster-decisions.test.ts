import "./muster-test-isolation.ts";
/**
 * Model-free regressions for the P1.3 programme decisions and the local relay
 * bridge (plan §7 P1.3, plan §5 D3).
 *
 * Pure store and local-socket tests: OS temp directories and a Unix domain
 * socket only. No network, provider, Concord or Pi-session wiring, and no
 * external delivery — the outbox default transport is `none`.
 *
 * Authored here; executed by the parent through the guarded runner.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as decisionsModule from "../decisions.ts";
import {
	ProgrammeDecisionStateError,
	applyDecisionAnswer,
	fileProgrammeDecisionStore,
	getDecision,
	listOpenDecisions,
	openDecision,
	programmeDecisionStateDir,
	type DecisionAnswerRef,
	type ProgrammeDecisionContext,
} from "../decisions.ts";
import { piAgentDir, PiPortMissing, configurePiPorts } from "../../core/pi-ports.ts";
import { programmesStateDir } from "../../core/programme.ts";
import type { OpenDecisionInput } from "../../core/decision-types.ts";
import {
	ProgrammeRelayError,
	RELAY_MAX_FRAME_BYTES,
	createRelayServer,
	sendProgrammeNotification,
	validateRelayEnvelope,
	type RelayEnvelope,
	type RelayServerHandle,
} from "../bridge.ts";

const PROGRAMME_ID = "agp_0123456789ab";

// ─── Fixtures and helpers ────────────────────────────────────────────────────

async function withTempDir(run: (dir: string) => void | Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "muster-decisions-"));
	try {
		await run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function decisionContext(dir: string): ProgrammeDecisionContext {
	return { store: fileProgrammeDecisionStore(dir) };
}

function decisionsPath(dir: string): string {
	return join(dir, `${PROGRAMME_ID}.decisions.json`);
}

function openInput(overrides: Partial<OpenDecisionInput> = {}): OpenDecisionInput {
	return {
		kind: "product-decision",
		question: "Ship the pilot?",
		options: [
			{ id: "approve", label: "Approve", recommendation: "preferred" },
			{ id: "hold", label: "Hold" },
		],
		recommendation: "approve",
		blockedTaskIds: ["task_b", "task_a"],
		scopeRevision: "sprint-1",
		...overrides,
	};
}

function openExample(ctx: ProgrammeDecisionContext, overrides: Partial<OpenDecisionInput> = {}): string {
	return openDecision(PROGRAMME_ID, openInput(overrides), ctx).decisionId;
}

function answerRef(overrides: Partial<DecisionAnswerRef> = {}): DecisionAnswerRef {
	return {
		transport: "hermes",
		platformMessageId: "msg-answer-1",
		actorId: "operator",
		channelId: "chan-1",
		threadId: "thread-1",
		receivedAt: "2026-09-23T10:00:00.000Z",
		...overrides,
	};
}

function decisionError(code: ProgrammeDecisionStateError["code"], run: () => unknown): ProgrammeDecisionStateError {
	let caught: unknown;
	try {
		run();
	} catch (error) {
		caught = error;
	}
	if (!(caught instanceof ProgrammeDecisionStateError)) {
		assert.fail(
			`expected a ProgrammeDecisionStateError(${code}), got: ${caught === undefined ? "no error" : String(caught)}`,
		);
	}
	assert.equal(caught.code, code, caught.message);
	return caught;
}

function envelope(overrides: Partial<RelayEnvelope> = {}): RelayEnvelope {
	return {
		programmeId: PROGRAMME_ID,
		kind: "conversation",
		platformMessageId: "msg-1",
		actorId: "operator",
		channelId: "chan-1",
		threadId: "thread-1",
		body: "why?",
		...overrides,
	};
}

function relayToken(handle: RelayServerHandle): string {
	return readFileSync(handle.tokenPath, "utf8").trim();
}

function jsonLines(path: string): Array<Record<string, unknown>> {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function inboxLines(handle: RelayServerHandle): Array<Record<string, unknown>> {
	return jsonLines(handle.inboxPathFor(PROGRAMME_ID));
}

function outboxLines(dir: string): Array<Record<string, unknown>> {
	return jsonLines(join(dir, `${PROGRAMME_ID}.relay-outbox.jsonl`));
}

// ─── Relay socket client (independent framing implementation) ────────────────

function encodeFrame(payload: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(payload), "utf8");
	const frame = Buffer.allocUnsafe(4 + body.length);
	frame.writeUInt32BE(body.length, 0);
	body.copy(frame, 4);
	return frame;
}

async function connectRelay(socketPath: string): Promise<Socket> {
	return await new Promise((resolveConnect, rejectConnect) => {
		const socket = connect(socketPath);
		const onError = (error: Error): void => {
			socket.removeListener("connect", onConnect);
			rejectConnect(error);
		};
		const onConnect = (): void => {
			socket.removeListener("error", onError);
			// Late socket errors (e.g. a server destroying the connection after a
			// refusal) are asserted through reply frames, never as unhandled events.
			socket.on("error", () => {});
			resolveConnect(socket);
		};
		socket.once("error", onError);
		socket.once("connect", onConnect);
	});
}

function readFrame(socket: Socket): Promise<Record<string, unknown>> {
	return new Promise((resolveFrame, rejectFrame) => {
		let buffer = Buffer.alloc(0);
		const cleanup = (): void => {
			socket.off("data", onData);
			socket.off("error", onError);
			socket.off("close", onClose);
		};
		const onData = (chunk: Buffer): void => {
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.length < 4) return;
			const length = buffer.readUInt32BE(0);
			if (length === 0 || length > RELAY_MAX_FRAME_BYTES) {
				cleanup();
				rejectFrame(new Error(`relay frame length ${length} is invalid`));
				return;
			}
			if (buffer.length < 4 + length) return;
			const payload = buffer.subarray(4, 4 + length).toString("utf8");
			cleanup();
			try {
				resolveFrame(JSON.parse(payload) as Record<string, unknown>);
			} catch (error) {
				rejectFrame(error);
			}
		};
		const onError = (error: Error): void => {
			cleanup();
			rejectFrame(error);
		};
		const onClose = (): void => {
			cleanup();
			rejectFrame(new Error("relay connection closed before a reply frame"));
		};
		socket.on("data", onData);
		socket.on("error", onError);
		socket.on("close", onClose);
	});
}

async function relayRequest(
	socketPath: string,
	token: string,
	payload: unknown,
): Promise<Record<string, unknown>> {
	const socket = await connectRelay(socketPath);
	try {
		socket.write(encodeFrame({ type: "relay-auth", token }));
		const reply = readFrame(socket);
		socket.write(encodeFrame(payload));
		return await reply;
	} finally {
		socket.destroy();
	}
}

// ─── Decision store ──────────────────────────────────────────────────────────

test("muster-decisions: open persists the record, lists it and applies the authenticated answer", async () => {
	await withTempDir((dir) => {
		const ctx = decisionContext(dir);
		const decisionId = openExample(ctx);

		const persisted = JSON.parse(readFileSync(decisionsPath(dir), "utf8")) as {
			revision: number;
			decisions: Array<Record<string, unknown>>;
		};
		assert.equal(persisted.revision, 1);
		assert.equal(persisted.decisions.length, 1);
		assert.equal(persisted.decisions[0].decisionId, decisionId);
		assert.equal(persisted.decisions[0].status, "open");

		const open = listOpenDecisions(PROGRAMME_ID, ctx);
		assert.equal(open.length, 1);
		assert.equal(open[0].kind, "product-decision");
		assert.equal(open[0].scopeRevision, "sprint-1");
		assert.deepEqual(open[0].blockedTaskIds, ["task_a", "task_b"], "blocked task IDs are stored in a deterministic order");
		assert.equal(getDecision(PROGRAMME_ID, decisionId, ctx).status, "open");
		decisionError("missing", () => getDecision(PROGRAMME_ID, "dec_missing", ctx));

		const ref = answerRef({ platformMessageId: "msg-answer-1" });
		const applied = applyDecisionAnswer(PROGRAMME_ID, decisionId, "approve", ref, ctx);
		assert.equal(applied.applied, true);
		assert.equal(applied.duplicate, false);
		assert.equal(applied.status, "applied");
		assert.deepEqual(applied.answerRef, ref);

		assert.deepEqual(listOpenDecisions(PROGRAMME_ID, ctx), []);
		const closed = getDecision(PROGRAMME_ID, decisionId, ctx);
		assert.equal(closed.status, "applied");
		assert.equal(closed.appliedOptionId, "approve");
		assert.equal(closed.appliedAt, closed.updatedAt);
		assert.deepEqual(closed.answerRef, ref);
	});
});

test("muster-decisions: an unchanged open request deduplicates instead of duplicating", async () => {
	await withTempDir((dir) => {
		const ctx = decisionContext(dir);
		const first = openDecision(PROGRAMME_ID, openInput(), ctx);
		assert.equal(first.deduplicated, false);
		const second = openDecision(PROGRAMME_ID, openInput(), ctx);
		assert.equal(second.deduplicated, true);
		assert.equal(second.decisionId, first.decisionId);
		assert.equal(second.revision, first.revision, "a deduplicated request performs no write");
		assert.equal(listOpenDecisions(PROGRAMME_ID, ctx).length, 1);

		const changed = openDecision(PROGRAMME_ID, openInput({ question: "Different question?" }), ctx);
		assert.equal(changed.deduplicated, false);
		assert.equal(listOpenDecisions(PROGRAMME_ID, ctx).length, 2);
	});
});

test("muster-decisions: a duplicate answer is idempotent and never applies twice", async () => {
	await withTempDir((dir) => {
		const ctx = decisionContext(dir);
		const decisionId = openExample(ctx);
		const ref = answerRef({ platformMessageId: "msg-dup" });
		const first = applyDecisionAnswer(PROGRAMME_ID, decisionId, "approve", ref, ctx);
		const revisionAfterFirst = (JSON.parse(readFileSync(decisionsPath(dir), "utf8")) as { revision: number }).revision;

		const second = applyDecisionAnswer(PROGRAMME_ID, decisionId, "approve", ref, ctx);
		assert.equal(second.applied, false);
		assert.equal(second.duplicate, true);
		assert.equal(second.appliedAt, first.appliedAt);
		assert.deepEqual(second.answerRef, ref);
		const revisionAfterSecond = (JSON.parse(readFileSync(decisionsPath(dir), "utf8")) as { revision: number }).revision;
		assert.equal(revisionAfterSecond, revisionAfterFirst, "a duplicate answer performs no write");
	});
});

test("muster-decisions: a stale answer to a closed decision is a typed conflict", async () => {
	await withTempDir((dir) => {
		const ctx = decisionContext(dir);
		const decisionId = openExample(ctx);
		applyDecisionAnswer(PROGRAMME_ID, decisionId, "approve", answerRef({ platformMessageId: "msg-first" }), ctx);

		decisionError("conflict", () =>
			applyDecisionAnswer(PROGRAMME_ID, decisionId, "hold", answerRef({ platformMessageId: "msg-stale" }), ctx),
		);
		decisionError("conflict", () =>
			applyDecisionAnswer(PROGRAMME_ID, decisionId, "hold", answerRef({ platformMessageId: "msg-first" }), ctx),
		);
		assert.equal(getDecision(PROGRAMME_ID, decisionId, ctx).appliedOptionId, "approve");
	});
});

test("muster-decisions: an unknown option is a typed error and leaves the decision open", async () => {
	await withTempDir((dir) => {
		const ctx = decisionContext(dir);
		const decisionId = openExample(ctx);
		decisionError("io", () =>
			applyDecisionAnswer(PROGRAMME_ID, decisionId, "nope", answerRef({ platformMessageId: "msg-nope" }), ctx),
		);
		assert.equal(getDecision(PROGRAMME_ID, decisionId, ctx).status, "open");
	});
});

test("muster-decisions: a failed persistence surfaces as a typed error and preserves the file", async () => {
	await withTempDir((dir) => {
		const ctx = decisionContext(dir);
		const path = decisionsPath(dir);
		const corrupt = "{ this is not json";
		writeFileSync(path, corrupt, "utf8");

		decisionError("malformed", () => openExample(ctx));
		decisionError("malformed", () => listOpenDecisions(PROGRAMME_ID, ctx));
		decisionError("malformed", () => getDecision(PROGRAMME_ID, "dec_missing", ctx));
		assert.equal(readFileSync(path, "utf8"), corrupt, "corrupt state is preserved for diagnosis, never reset");

		if (typeof process.getuid === "function" && process.getuid() === 0) return;
		const readOnly = join(dir, "readonly");
		mkdirSync(readOnly, { recursive: true, mode: 0o500 });
		chmodSync(readOnly, 0o500);
		try {
			decisionError("io", () =>
				openDecision(PROGRAMME_ID, openInput(), { store: fileProgrammeDecisionStore(readOnly) }),
			);
			assert.equal(existsSync(join(readOnly, `${PROGRAMME_ID}.decisions.json`)), false, "no partial record is left");
		} finally {
			chmodSync(readOnly, 0o700);
		}
	});
});

test("muster-decisions: input validation rejects unknown kinds and empty blocked task ids", async () => {
	await withTempDir((dir) => {
		const ctx = decisionContext(dir);
		decisionError("io", () => openDecision(PROGRAMME_ID, openInput({ kind: "made-up" as never }), ctx));
		decisionError("io", () => openDecision(PROGRAMME_ID, openInput({ blockedTaskIds: ["task_a", ""] }), ctx));
		decisionError("io", () => openDecision(PROGRAMME_ID, openInput({ options: [] }), ctx));
		decisionError("io", () => openDecision(PROGRAMME_ID, openInput({ scopeRevision: "" }), ctx));
		assert.equal(existsSync(decisionsPath(dir)), false, "invalid input persists nothing");
	});
});

// ─── Relay bridge ────────────────────────────────────────────────────────────

type RelayFixture = {
	dir: string;
	ctx: ProgrammeDecisionContext;
	handle: RelayServerHandle;
};

async function withRelay(run: (fixture: RelayFixture) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "muster-relay-"));
	const ctx = decisionContext(dir);
	const handle = createRelayServer({
		socketPath: join(dir, "relay.sock"),
		stateDir: dir,
		decisions: ctx,
		authTimeoutMs: 1000,
	});
	await handle.start();
	try {
		await run({ dir, ctx, handle });
	} finally {
		await handle.stop();
		rmSync(dir, { recursive: true, force: true });
	}
}

test("muster-bridge: a pause envelope is enqueued exactly once per platformMessageId", async () => {
	await withRelay(async ({ handle }) => {
		const token = relayToken(handle);
		const pause = envelope({ kind: "pause", body: "pause", platformMessageId: "msg-pause" });

		const first = await relayRequest(handle.socketPath, token, pause);
		assert.equal(first.ok, true);
		assert.equal(first.accepted, true);
		assert.equal(first.delivered, false);
		assert.equal(first.duplicate, false);

		const second = await relayRequest(handle.socketPath, token, pause);
		assert.equal(second.ok, true);
		assert.equal(second.accepted, true);
		assert.equal(second.duplicate, true);

		const lines = inboxLines(handle);
		assert.equal(lines.length, 1, "the replayed platform message is not enqueued twice");
		const line = lines[0];
		assert.equal(line.schemaVersion, 1);
		assert.equal(typeof line.receivedAt, "string");
		const stored = line.envelope as RelayEnvelope;
		assert.equal(stored.kind, "pause");
		assert.equal(stored.platformMessageId, "msg-pause");
		assert.equal(stored.actorId, "operator");
		assert.equal(stored.channelId, "chan-1");
		assert.equal(stored.threadId, "thread-1");

		await relayRequest(handle.socketPath, token, envelope({ kind: "conversation", platformMessageId: "msg-chat" }));
		await relayRequest(handle.socketPath, token, envelope({ kind: "status", platformMessageId: "msg-status" }));
		assert.equal(inboxLines(handle).length, 3, "conversation and status share the durable inbox");
	});
});

test("muster-bridge: decision answers apply locally and replay idempotently", async () => {
	await withRelay(async ({ ctx, handle }) => {
		const decisionId = openExample(ctx);
		const token = relayToken(handle);
		const answer = {
			kind: "decision-answer" as const,
			decisionId,
			optionId: "approve",
			platformMessageId: "msg-answer",
		};

		const applied = await relayRequest(handle.socketPath, token, envelope(answer));
		assert.equal(applied.ok, true);
		assert.equal(applied.accepted, true);
		assert.equal(applied.applied, true);
		assert.equal(applied.decisionId, decisionId);
		assert.equal(getDecision(PROGRAMME_ID, decisionId, ctx).appliedOptionId, "approve");

		const replay = await relayRequest(handle.socketPath, token, envelope(answer));
		assert.equal(replay.ok, true);
		assert.equal(replay.accepted, true);
		assert.equal(replay.applied, false);
		assert.equal(replay.duplicate, true);

		const stale = await relayRequest(
			handle.socketPath,
			token,
			envelope({ ...answer, optionId: "hold", platformMessageId: "msg-other" }),
		);
		assert.equal(stale.ok, false);
		assert.equal(stale.accepted, false);
		assert.match(String((stale.errors as string[])[0]), /conflict/);

		const unknown = await relayRequest(
			handle.socketPath,
			token,
			envelope({ ...answer, optionId: "nope", platformMessageId: "msg-unknown-option" }),
		);
		assert.equal(unknown.ok, false);
		assert.match(String((unknown.errors as string[])[0]), /Unknown optionId/);
		assert.equal(getDecision(PROGRAMME_ID, decisionId, ctx).appliedOptionId, "approve");
	});
});

test("muster-bridge: a wrong token or an unauthenticated frame is refused without side effects", async () => {
	await withRelay(async ({ handle }) => {
		const refused = await relayRequest(handle.socketPath, "0".repeat(64), envelope({ kind: "pause" }));
		assert.equal(refused.ok, false);
		assert.equal(refused.accepted, false);
		assert.match(String((refused.errors as string[])[0]), /unauthorized/);

		const socket = await connectRelay(handle.socketPath);
		try {
			const reply = readFrame(socket);
			socket.write(encodeFrame(envelope({ kind: "conversation", platformMessageId: "msg-no-auth" })));
			const result = await reply;
			assert.equal(result.ok, false);
			assert.match(String((result.errors as string[])[0]), /unauthorized/);
		} finally {
			socket.destroy();
		}
		assert.deepEqual(inboxLines(handle), []);
	});
});

test("muster-bridge: a frame above the 256 KiB ceiling is refused and the server keeps serving", async () => {
	await withRelay(async ({ handle }) => {
		const token = relayToken(handle);
		const socket = await connectRelay(handle.socketPath);
		try {
			socket.write(encodeFrame({ type: "relay-auth", token }));
			const reply = readFrame(socket);
			const header = Buffer.alloc(4);
			header.writeUInt32BE(RELAY_MAX_FRAME_BYTES + 1, 0);
			socket.write(header);
			const result = await reply;
			assert.equal(result.ok, false);
			assert.match(String((result.errors as string[])[0]), /frame length/);
		} finally {
			socket.destroy();
		}
		assert.deepEqual(inboxLines(handle), []);

		const accepted = await relayRequest(
			handle.socketPath,
			token,
			envelope({ kind: "pause", platformMessageId: "msg-after-oversize" }),
		);
		assert.equal(accepted.accepted, true);
	});
});

test("muster-bridge: outbound notifications are recorded undelivered with transport none", async () => {
	await withRelay(async ({ dir }) => {
		const result = await sendProgrammeNotification(
			PROGRAMME_ID,
			{
				kind: "decision",
				text: "Decision dec_1 needs an answer",
				decisionRef: { decisionId: "dec_1", revision: 4 },
			},
			{ stateDir: dir },
		);
		assert.equal(result.delivered, false);
		assert.equal(result.transport, "none");
		assert.equal(result.transportMessageId, null);

		const lines = outboxLines(dir);
		assert.equal(lines.length, 1, "transport none records the message and never claims delivery");
		assert.equal(lines[0].type, "notification");
		assert.equal(lines[0].delivered, false);
		assert.equal(lines[0].transportMessageId, null);
		assert.deepEqual(lines[0].decisionRef, { decisionId: "dec_1", revision: 4 });
	});
});

test("muster-bridge: a failing transport still leaves the recorded notification and its outcome", async () => {
	await withTempDir(async (dir) => {
		const result = await sendProgrammeNotification(
			PROGRAMME_ID,
			{ kind: "stop", text: "worker lane stopped" },
			{
				stateDir: dir,
				transport: {
					name: "fixture",
					send: () => {
						throw new Error("external delivery disabled in this phase");
					},
				},
			},
		);
		assert.equal(result.delivered, false);
		assert.equal(result.transport, "fixture");

		const lines = outboxLines(dir);
		assert.equal(lines.length, 2, "the intent record is written before the transport runs");
		assert.equal(lines[0].type, "notification");
		assert.equal(lines[0].delivered, false);
		assert.equal(lines[1].type, "delivery");
		assert.equal(lines[1].delivered, false);
		assert.match(String(lines[1].error), /disabled/);
	});
});

test("muster-bridge: envelope validation fails closed on unknown fields and missing identity", () => {
	const result = validateRelayEnvelope(envelope());
	assert.equal(result.ok, true);

	const envelopeErrors = (input: unknown): string[] => {
		const validated = validateRelayEnvelope(input);
		assert.equal(validated.ok, false);
		return validated.ok ? [] : validated.errors;
	};
	assert.match(envelopeErrors({ ...envelope(), role: "user" }).join(" "), /unknown fields/);
	assert.match(envelopeErrors({ ...envelope(), threadId: "" }).join(" "), /threadId/);
	assert.match(envelopeErrors({ ...envelope(), programmeId: "programme-1" }).join(" "), /programmeId/);
	assert.match(envelopeErrors(envelope({ kind: "decision-answer", decisionId: "dec_1" })).join(" "), /optionId/);
	assert.match(envelopeErrors(envelope({ kind: "made-up" as never })).join(" "), /kind/);
});

test("muster-bridge: a second server refuses a socket that is already served", async () => {
	await withRelay(async ({ dir, handle }) => {
		const second = createRelayServer({ socketPath: handle.socketPath, stateDir: dir });
		await assert.rejects(
			() => second.start(),
			(error: unknown) => error instanceof ProgrammeRelayError && error.code === "conflict",
		);
	});
});

test("muster-bridge: a stale socket file from a dead server is replaced", async () => {
	await withTempDir(async (dir) => {
		const socketPath = join(dir, "relay.sock");
		const dead = createServer();
		await new Promise<void>((resolveListen) => dead.listen(socketPath, () => resolveListen()));
		await new Promise<void>((resolveClose) => dead.close(() => resolveClose()));
		// Node leaves the unix socket file behind on close (Linux), so the next
		// start exercises clearStaleSocket; if a runtime unlinks it, rebinding the
		// same path must still succeed.
		const leftover = existsSync(socketPath);

		const handle = createRelayServer({ socketPath, stateDir: dir });
		await handle.start();
		try {
			assert.equal(handle.isListening(), true);
			if (leftover) assert.equal(existsSync(socketPath), true, "a replaced stale socket is still the live path");
		} finally {
			await handle.stop();
		}
	});
});

test("muster-bridge: stop() while start() is still in flight leaves nothing listening", async () => {
	const dir = mkdtempSync(join(tmpdir(), "muster-relay-race-"));
	const handle = createRelayServer({ socketPath: join(dir, "relay.sock"), stateDir: dir });
	try {
		const starting = handle.start();
		// A stop that lands before the bind completes must wait for it, then close it.
		await handle.stop();
		await starting.catch(() => undefined);
		assert.equal(handle.isListening(), false, "the late bind must not outlive stop()");
		assert.equal(existsSync(join(dir, "relay.sock")), false, "the socket path is removed");
	} finally {
		// Idempotent: closes a late bind if the assertions above found one, so a
		// failing run exits instead of hanging on the leaked listener.
		await handle.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

// ─── One owner for the programmes folder (RS7) ───────────────────────────────

/**
 * The configured agent dir, or `undefined` when this process has no port yet:
 * the guarded runner preloads `harness-test-setup.ts`, a bare
 * `node --import tsx --test` run has no such start file.
 */
function configuredAgentDir(): string | undefined {
	try {
		return piAgentDir();
	} catch (error) {
		if (error instanceof PiPortMissing) return undefined;
		throw error;
	}
}

/**
 * RS7: core's `programmesStateDir()` is the one owner of the programmes folder.
 * `programmeDecisionStateDir()` keeps `PI_MUSTER_DECISIONS_DIR` as its own seam
 * and otherwise follows the owner's `PI_AGILE_PROGRAMMES_DIR` seam, so a test
 * that sets only the latter writes decisions and relay logs into its own folder
 * instead of the real state folder. The owner needs core's `agentDir` port, so
 * this test configures it itself; the env overrides and the port are
 * process-global and both are restored.
 */
test("muster-decisions: the programmes folder has one owner", async () => {
	await withTempDir(async (agileDir) => {
		await withTempDir(async (decisionsDir) => {
			const agentDir = mkdtempSync(join(tmpdir(), "muster-decisions-agent-"));
			const previousAgentDir = configuredAgentDir();
			const savedAgile = process.env.PI_AGILE_PROGRAMMES_DIR;
			const savedDecisions = process.env.PI_MUSTER_DECISIONS_DIR;
			configurePiPorts({ agentDir });
			try {
				// The owner's override alone must reach the decision folder.
				delete process.env.PI_MUSTER_DECISIONS_DIR;
				process.env.PI_AGILE_PROGRAMMES_DIR = agileDir;
				assert.equal(programmeDecisionStateDir(), agileDir, "PI_AGILE_PROGRAMMES_DIR alone must move the decision folder");

				// The muster seam still wins over the owner's override.
				process.env.PI_MUSTER_DECISIONS_DIR = decisionsDir;
				assert.equal(programmeDecisionStateDir(), decisionsDir, "PI_MUSTER_DECISIONS_DIR stays the decision seam");

				// Neither override: today's default path, delegated to the owner.
				delete process.env.PI_MUSTER_DECISIONS_DIR;
				delete process.env.PI_AGILE_PROGRAMMES_DIR;
				assert.equal(programmeDecisionStateDir(), programmesStateDir(), "the decision folder follows the one owner");
				assert.equal(
					programmeDecisionStateDir(),
					join(agentDir, "state", "muster", "programmes"),
					"the default path is unchanged",
				);

				// The deleted second owner is gone, not re-exported.
				assert.equal("programmeStateDir" in decisionsModule, false, "muster keeps no second programmes-folder owner");
			} finally {
				if (savedAgile === undefined) delete process.env.PI_AGILE_PROGRAMMES_DIR;
				else process.env.PI_AGILE_PROGRAMMES_DIR = savedAgile;
				if (savedDecisions === undefined) delete process.env.PI_MUSTER_DECISIONS_DIR;
				else process.env.PI_MUSTER_DECISIONS_DIR = savedDecisions;
				if (previousAgentDir !== undefined) {
					configurePiPorts({ agentDir: previousAgentDir });
					rmSync(agentDir, { recursive: true, force: true });
				}
			}
		});
	});
});
