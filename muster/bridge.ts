/**
 * Pi-side relay endpoint for the D3 same-chat bridge (plan §5, §7 P1.3).
 *
 * One local Unix domain socket owns the Hermes-side receive path:
 * - bounded framing: 4-byte big-endian length prefix + UTF-8 JSON, max 256 KiB;
 * - per-connection shared-secret token read from a 0600 file created at bind
 *   (`~/.pi/agent/state/muster/programmes/relay.sock.token`), compared in
 *   constant time. Node 24's `net` module exposes no `socket.remoteUid`, so the
 *   documented fallback applies: the token is the same-user gate. If a future
 *   Node exposes `remoteUid`, a mismatch is rejected before authentication;
 *   the token stays required either way. The token is never included in any
 *   reply, record or error message.
 * - envelope: `{programmeId, kind, platformMessageId, actorId, channelId,
 *   threadId, body, decisionId?, optionId?}`. Identity fields are transport
 *   metadata matched against the binding by the Hermes hook; Pi never derives
 *   them from message text and never logs the body.
 *
 * Receive path:
 * - `decision-answer` -> `applyDecisionAnswer` (idempotent by transport message
 *   id) and a reply `{ok, accepted, applied, decisionId, duplicate?, errors?}`.
 * - `conversation` / `pause` / `status` -> appended exactly once per
 *   `platformMessageId` to `<programmeId>.relay-inbox.jsonl` (append-only,
 *   fsync, locked) and a reply `{ok, accepted:true, delivered:false}`. Session
 *   routing is deliberately absent: P1.2 injects accepted inbox entries.
 *
 * Outbound side: `sendProgrammeNotification` appends the message to
 * `<programmeId>.relay-outbox.jsonl` before any transport runs. The default
 * transport is `"none"`: the message is recorded and stays undelivered.
 * External delivery is intentionally disabled in this phase.
 *
 * Ownership: nothing listens on import. Callers create a server and call
 * `start()` / `stop()`; `stop()` destroys live connections and removes the
 * socket and token files.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { basename, dirname, join, resolve } from "node:path";

import {
	ProgrammeDecisionStateError,
	applyDecisionAnswer,
	programmeDecisionStateDir,
	type DecisionAnswerRef,
	type ProgrammeDecisionContext,
} from "./decisions.ts";

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export const RELAY_SCHEMA_VERSION = 1 as const;
/** Hard frame ceiling shared with the Hermes plugin (`MAX_FRAME_BYTES`). */
export const RELAY_MAX_FRAME_BYTES = 256 * 1024;
export const RELAY_DEFAULT_AUTH_TIMEOUT_MS = 5_000;
export const RELAY_TRANSPORT_NONE = "none";
const AUTH_FRAME_TYPE = "relay-auth";
const PROGRAMME_ID_PATTERN = /^agp_[0-9a-f]{12}$/;
/** Unix socket path budget (`sun_path` 108 bytes incl. terminator). */
const MAX_SOCKET_PATH_BYTES = 100;
const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const PROBE_TIMEOUT_MS = 300;

export type RelayEnvelopeKind = "conversation" | "decision-answer" | "pause" | "status" | "off";

export const RELAY_ENVELOPE_KINDS: readonly RelayEnvelopeKind[] = [
	"conversation",
	"decision-answer",
	"pause",
	"status",
	"off",
];

export type RelayEnvelope = {
	programmeId: string;
	kind: RelayEnvelopeKind;
	platformMessageId: string;
	actorId: string;
	channelId: string;
	threadId: string;
	body: string;
	decisionId?: string;
	optionId?: string;
};

export type RelayReply = {
	ok: boolean;
	accepted: boolean;
	applied?: boolean;
	delivered?: boolean;
	duplicate?: boolean;
	decisionId?: string;
	errors?: string[];
};

export type RelayInboxLine = {
	schemaVersion: typeof RELAY_SCHEMA_VERSION;
	receivedAt: string;
	envelope: RelayEnvelope;
};

// ─── Errors ──────────────────────────────────────────────────────────────────

export class ProgrammeRelayError extends Error {
	constructor(
		readonly code: "missing" | "malformed" | "conflict" | "io" | "protocol",
		message: string,
	) {
		super(message);
		this.name = "ProgrammeRelayError";
	}
}

// ─── Outbound notifications ──────────────────────────────────────────────────

export type ProgrammeNotificationKind = "decision" | "stop" | "failure" | "increment" | "status" | "conversation";

export const PROGRAMME_NOTIFICATION_KINDS: readonly ProgrammeNotificationKind[] = [
	"decision",
	"stop",
	"failure",
	"increment",
	"status",
	"conversation",
];

export type ProgrammeNotificationDecisionRef = {
	decisionId: string;
	revision?: number;
};

export type ProgrammeNotification = {
	kind: ProgrammeNotificationKind;
	text: string;
	/** Reference-only link back to the decision that prompted the notification. */
	decisionRef?: string | ProgrammeNotificationDecisionRef;
};

export type RelayOutboxNotificationRecord = {
	schemaVersion: typeof RELAY_SCHEMA_VERSION;
	type: "notification";
	deliveryId: string;
	programmeId: string;
	kind: ProgrammeNotificationKind;
	text: string;
	decisionRef: ProgrammeNotificationDecisionRef | null;
	transport: string;
	/** Always false at write time: the record is persisted before any transport runs. */
	delivered: boolean;
	transportMessageId: string | null;
	createdAt: string;
};

export type RelayOutboxDeliveryRecord = {
	schemaVersion: typeof RELAY_SCHEMA_VERSION;
	type: "delivery";
	deliveryId: string;
	delivered: boolean;
	transportMessageId: string | null;
	error?: string;
	at: string;
};

export type RelayOutboxRecord = RelayOutboxNotificationRecord | RelayOutboxDeliveryRecord;

export type ProgrammeNotificationTransport = {
	name: string;
	send(
		record: RelayOutboxNotificationRecord,
	): Promise<{ delivered: boolean; transportMessageId?: string; error?: string }>
		| { delivered: boolean; transportMessageId?: string; error?: string };
};

/** Default transport: records the message and marks it undelivered. */
export const noneProgrammeNotificationTransport: ProgrammeNotificationTransport = {
	name: RELAY_TRANSPORT_NONE,
	send: () => ({ delivered: false }),
};

export type ProgrammeNotificationOptions = {
	stateDir?: string;
	transport?: ProgrammeNotificationTransport;
};

export type ProgrammeNotificationResult = {
	deliveryId: string;
	delivered: boolean;
	transport: string;
	transportMessageId: string | null;
	outboxPath: string;
};

// ─── Server ──────────────────────────────────────────────────────────────────

export type RelayServerOptions = {
	/** Defaults to `PI_MUSTER_RELAY_SOCKET` or `<state>/relay.sock`. */
	socketPath?: string;
	/** Defaults to `<socketPath>.token`; written 0600 at bind. */
	tokenPath?: string;
	/** Inbox/outbox directory; defaults to the decision state directory. */
	stateDir?: string;
	/** `answerRef.transport` value stamped on applied answers; defaults to `hermes`. */
	transportName?: string;
	/** Decision store context; defaults to the real state root. */
	decisions?: ProgrammeDecisionContext;
	authTimeoutMs?: number;
	maxFrameBytes?: number;
	/** Optional diagnostics sink; the token is never passed to it. */
	onError?: (message: string) => void;
};

export type RelayServerHandle = {
	readonly socketPath: string;
	readonly tokenPath: string;
	readonly transportName: string;
	inboxPathFor(programmeId: string): string;
	outboxPathFor(programmeId: string): string;
	start(): Promise<void>;
	stop(): Promise<void>;
	isListening(): boolean;
};

/** `PI_MUSTER_RELAY_SOCKET` overrides the documented default path. */
export function relaySocketPath(): string {
	const override = process.env.PI_MUSTER_RELAY_SOCKET?.trim();
	if (override) return resolve(override);
	return join(programmeDecisionStateDir(), "relay.sock");
}

export function createRelayServer(options: RelayServerOptions = {}): RelayServerHandle {
	const socketPath = options.socketPath ?? relaySocketPath();
	const tokenPath = options.tokenPath ?? `${socketPath}.token`;
	const stateDir = options.stateDir ?? programmeDecisionStateDir();
	const transportName = options.transportName ?? "hermes";
	const authTimeoutMs = options.authTimeoutMs ?? RELAY_DEFAULT_AUTH_TIMEOUT_MS;
	const maxFrameBytes = options.maxFrameBytes ?? RELAY_MAX_FRAME_BYTES;
	const decisionsContext = options.decisions;
	const onError = options.onError;
	let server: Server | undefined;
	let token: string | undefined;
	let ownsPaths = false;
	const connections = new Set<Socket>();

	const inboxPathFor = (programmeId: string): string => join(stateDir, `${assertProgrammeId(programmeId)}.relay-inbox.jsonl`);
	const outboxPathFor = (programmeId: string): string => join(stateDir, `${assertProgrammeId(programmeId)}.relay-outbox.jsonl`);

	const writeFrame = (socket: Socket, payload: unknown): void => {
		try {
			const body = Buffer.from(JSON.stringify(payload), "utf8");
			if (body.length > maxFrameBytes) return;
			const frame = Buffer.allocUnsafe(4 + body.length);
			frame.writeUInt32BE(body.length, 0);
			body.copy(frame, 4);
			socket.write(frame);
		} catch {
			// A destroyed peer must not break the accept loop.
		}
	};

	const handleEnvelope = (envelope: RelayEnvelope): RelayReply => {
		if (envelope.kind === "decision-answer") {
			const decisionId = envelope.decisionId ?? "";
			const optionId = envelope.optionId ?? "";
			const answerRef: DecisionAnswerRef = {
				transport: transportName,
				platformMessageId: envelope.platformMessageId,
				actorId: envelope.actorId,
				channelId: envelope.channelId,
				threadId: envelope.threadId,
				receivedAt: new Date().toISOString(),
			};
			try {
				const applied = applyDecisionAnswer(
					envelope.programmeId,
					decisionId,
					optionId,
					answerRef,
					decisionsContext,
				);
				return {
					ok: true,
					accepted: true,
					applied: applied.applied,
					duplicate: applied.duplicate,
					decisionId: applied.decisionId,
				};
			} catch (error) {
				if (error instanceof ProgrammeDecisionStateError) {
					return { ok: false, accepted: false, decisionId, errors: [`${error.code}: ${error.message}`] };
				}
				return { ok: false, accepted: false, decisionId, errors: [messageOf(error)] };
			}
		}
		try {
			const enqueued = appendRelayInbox(inboxPathFor(envelope.programmeId), envelope);
			return { ok: true, accepted: true, delivered: false, duplicate: !enqueued };
		} catch (error) {
			return { ok: false, accepted: false, delivered: false, errors: [messageOf(error)] };
		}
	};

	const onConnection = (socket: Socket): void => {
		connections.add(socket);
		let authenticated = false;
		let buffer = Buffer.alloc(0);
		let closed = false;
		const authTimer = setTimeout(() => {
			if (authenticated || closed) return;
			refuse({
				ok: false,
				accepted: false,
				errors: ["relay authentication timeout"],
			});
		}, authTimeoutMs);
		authTimer.unref?.();
		const release = (): void => {
			closed = true;
			clearTimeout(authTimer);
			connections.delete(socket);
		};
		/** Refuse with one final frame: flush before closing so the peer sees it. */
		const refuse = (payload: unknown): void => {
			clearTimeout(authTimer);
			try {
				const body = Buffer.from(JSON.stringify(payload), "utf8");
				if (body.length > maxFrameBytes) {
					socket.destroy();
					return;
				}
				const frame = Buffer.allocUnsafe(4 + body.length);
				frame.writeUInt32BE(body.length, 0);
				body.copy(frame, 4);
				// end() flushes the frame before FIN; the timer bounds a peer that never closes.
				socket.end(frame);
				const lingerTimer = setTimeout(() => socket.destroy(), 2000);
				lingerTimer.unref?.();
			} catch {
				socket.destroy();
			}
		};
		socket.on("close", release);
		socket.on("error", () => {
			/* peer errors are reported through close/release */
		});
		const remoteUid = peerUid(socket);
		if (remoteUid !== undefined && typeof process.getuid === "function" && remoteUid !== process.getuid()) {
			refuse({ ok: false, accepted: false, errors: ["relay peer uid mismatch"] });
			return;
		}
		socket.on("data", (chunk: Buffer) => {
			if (closed) return;
			buffer = Buffer.concat([buffer, chunk]);
			while (!closed) {
				if (buffer.length < 4) return;
				const length = buffer.readUInt32BE(0);
				if (length === 0 || length > maxFrameBytes) {
					refuse({
						ok: false,
						accepted: false,
						errors: [`relay frame length ${length} outside 1..${maxFrameBytes}`],
					});
					return;
				}
				if (buffer.length < 4 + length) return;
				const payload = buffer.subarray(4, 4 + length);
				buffer = buffer.subarray(4 + length);
				if (!processFrame(payload)) return;
			}
		});

		function processFrame(payload: Buffer): boolean {
			let parsed: unknown;
			try {
				parsed = JSON.parse(payload.toString("utf8"));
			} catch {
				writeFrame(socket, { ok: false, accepted: false, errors: ["relay frame is not JSON"] });
				return true;
			}
			if (!authenticated) {
				if (!isAuthFrame(parsed) || !tokenMatches(token ?? "", parsed.token)) {
					refuse({ ok: false, accepted: false, errors: ["relay client unauthorized"] });
					return false;
				}
				authenticated = true;
				clearTimeout(authTimer);
				return true;
			}
			const validated = validateRelayEnvelope(parsed);
			if (!validated.ok) {
				writeFrame(socket, { ok: false, accepted: false, errors: validated.errors });
				return true;
			}
			writeFrame(socket, handleEnvelope(validated.envelope));
			return true;
		}
	};

	// A bind in flight. `stop()` waits for it, so a stop that lands before the
	// bind completes cannot leave a listener behind that nothing owns.
	let starting: Promise<void> | undefined;

	const start = (): Promise<void> => {
		if (server !== undefined) return Promise.resolve();
		if (starting !== undefined) return starting;
		const attempt = bind().finally(() => {
			if (starting === attempt) starting = undefined;
		});
		starting = attempt;
		return attempt;
	};

	const bind = async (): Promise<void> => {
		if (server !== undefined) return;
		if (Buffer.byteLength(socketPath, "utf8") > MAX_SOCKET_PATH_BYTES) {
			throw new ProgrammeRelayError("io", `relay socket path is too long for a unix socket: ${socketPath}`);
		}
		mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
		await clearStaleSocket(socketPath);
		const secret = randomBytes(32).toString("hex");
		writeFileSync(tokenPath, `${secret}\n`, { mode: 0o600 });
		try {
			chmodSync(tokenPath, 0o600);
		} catch {
			/* best effort; unless running as a different owner, mode is already 0600 */
		}
		const created = createServer(onConnection);
		try {
			await new Promise<void>((resolveStart, rejectStart) => {
				const onListenError = (error: Error): void => {
					created.removeListener("listening", onListening);
					rejectStart(error);
				};
				const onListening = (): void => {
					created.removeListener("error", onListenError);
					resolveStart();
				};
				created.once("error", onListenError);
				created.once("listening", onListening);
				created.listen(socketPath);
			});
		} catch (error) {
			removeFileQuietly(tokenPath);
			throw new ProgrammeRelayError("io", `relay socket failed to bind at ${socketPath}: ${messageOf(error)}`);
		}
		created.on("error", (error: Error) => {
			onError?.(`relay server error at ${socketPath}: ${messageOf(error)}`);
		});
		try {
			chmodSync(socketPath, 0o600);
		} catch {
			/* best effort */
		}
		token = secret;
		server = created;
		ownsPaths = true;
	};

	const stop = async (): Promise<void> => {
		if (starting !== undefined) await starting.catch(() => undefined);
		const current = server;
		server = undefined;
		token = undefined;
		if (current !== undefined) {
			for (const socket of connections) socket.destroy();
			connections.clear();
			await new Promise<void>((resolveStop) => current.close(() => resolveStop()));
		}
		if (ownsPaths) {
			removeFileQuietly(socketPath);
			removeFileQuietly(tokenPath);
			ownsPaths = false;
		}
	};

	return {
		socketPath,
		tokenPath,
		transportName,
		inboxPathFor,
		outboxPathFor,
		start,
		stop,
		isListening: () => server?.listening === true,
	};
}

// ─── Envelope validation ─────────────────────────────────────────────────────

const ENVELOPE_KEYS = new Set([
	"programmeId",
	"kind",
	"platformMessageId",
	"actorId",
	"channelId",
	"threadId",
	"body",
	"decisionId",
	"optionId",
]);

/**
 * Strict envelope validation. Unknown fields fail closed so a Hermes plugin
 * cannot smuggle extra authority fields past this boundary.
 */
export function validateRelayEnvelope(
	input: unknown,
): { ok: true; envelope: RelayEnvelope } | { ok: false; errors: string[] } {
	const errors: string[] = [];
	if (!isPlainObject(input)) return { ok: false, errors: ["envelope must be an object"] };
	const extra = unknownKeys(input, ENVELOPE_KEYS);
	if (extra.length > 0) errors.push(`envelope has unknown fields: ${extra.join(", ")}`);
	if (!nonEmptyString(input.programmeId) || !PROGRAMME_ID_PATTERN.test(input.programmeId)) {
		errors.push("envelope.programmeId must match agp_<12 hex>");
	}
	if (!oneOf(RELAY_ENVELOPE_KINDS, input.kind)) {
		errors.push(`envelope.kind must be one of: ${RELAY_ENVELOPE_KINDS.join(", ")}`);
	}
	for (const field of ["platformMessageId", "actorId", "channelId", "threadId", "body"]) {
		if (!nonEmptyString(input[field])) errors.push(`envelope.${field} must be a non-empty string`);
	}
	if (input.decisionId !== undefined && !nonEmptyString(input.decisionId)) {
		errors.push("envelope.decisionId must be a non-empty string when present");
	}
	if (input.optionId !== undefined && !nonEmptyString(input.optionId)) {
		errors.push("envelope.optionId must be a non-empty string when present");
	}
	if (input.kind === "decision-answer") {
		if (!nonEmptyString(input.decisionId)) errors.push("envelope kind decision-answer requires decisionId");
		if (!nonEmptyString(input.optionId)) errors.push("envelope kind decision-answer requires optionId");
	}
	if (errors.length > 0) return { ok: false, errors };
	const envelope: RelayEnvelope = {
		programmeId: input.programmeId as string,
		kind: input.kind as RelayEnvelopeKind,
		platformMessageId: input.platformMessageId as string,
		actorId: input.actorId as string,
		channelId: input.channelId as string,
		threadId: input.threadId as string,
		body: input.body as string,
	};
	if (input.decisionId !== undefined) envelope.decisionId = input.decisionId;
	if (input.optionId !== undefined) envelope.optionId = input.optionId;
	return { ok: true, envelope };
}

// ─── Durable inbox / outbox ──────────────────────────────────────────────────

/**
 * Append one envelope to the program's inbox unless its platform message ID is
 * already present. The duplicate check and the append share one per-file lock,
 * so two concurrent relay connections cannot enqueue the same message twice.
 * Returns true when a new line was written.
 */
export function appendRelayInbox(inboxPath: string, envelope: RelayEnvelope): boolean {
	mkdirSync(dirname(inboxPath), { recursive: true, mode: 0o700 });
	return withRelayFileLock(inboxPath, () => {
		if (relayInboxHasMessage(inboxPath, envelope.platformMessageId)) return false;
		const line: RelayInboxLine = {
			schemaVersion: RELAY_SCHEMA_VERSION,
			receivedAt: new Date().toISOString(),
			envelope,
		};
		appendLineFsync(inboxPath, `${JSON.stringify(line)}\n`);
		return true;
	});
}

function relayInboxHasMessage(inboxPath: string, platformMessageId: string): boolean {
	if (!existsSync(inboxPath)) return false;
	let raw: string;
	try {
		raw = readFileSync(inboxPath, "utf8");
	} catch (error) {
		throw new ProgrammeRelayError("io", `relay inbox unreadable at ${inboxPath}: ${messageOf(error)}`);
	}
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			// Append-only log: a torn or foreign line must not block legitimate acceptance.
			continue;
		}
		const envelope = isPlainObject(parsed) ? parsed.envelope : undefined;
		if (isPlainObject(envelope) && envelope.platformMessageId === platformMessageId) return true;
	}
	return false;
}

/**
 * Record one programme notification, then run the configured transport.
 * The notification line is fsynced before the transport call: a failed send
 * leaves durable evidence instead of losing the message.
 */
export async function sendProgrammeNotification(
	programmeId: string,
	notification: ProgrammeNotification,
	options: ProgrammeNotificationOptions = {},
): Promise<ProgrammeNotificationResult> {
	assertProgrammeId(programmeId);
	const normalized = normalizeNotification(notification);
	const transport = options.transport ?? noneProgrammeNotificationTransport;
	const outboxPath = join(
		options.stateDir ?? programmeDecisionStateDir(),
		`${programmeId}.relay-outbox.jsonl`,
	);
	const deliveryId = `dlv_${randomUUID()}`;
	const record: RelayOutboxNotificationRecord = {
		schemaVersion: RELAY_SCHEMA_VERSION,
		type: "notification",
		deliveryId,
		programmeId,
		kind: normalized.kind,
		text: normalized.text,
		decisionRef: normalized.decisionRef,
		transport: transport.name,
		delivered: false,
		transportMessageId: null,
		createdAt: new Date().toISOString(),
	};
	appendOutboxRecord(outboxPath, record);
	let delivered = false;
	let transportMessageId: string | null = null;
	let error: string | undefined;
	if (transport.name !== RELAY_TRANSPORT_NONE) {
		try {
			const outcome = await transport.send(record);
			delivered = outcome.delivered === true;
			transportMessageId = outcome.transportMessageId ?? null;
			error = outcome.error;
		} catch (sendError) {
			error = messageOf(sendError);
		}
		const delivery: RelayOutboxDeliveryRecord = {
			schemaVersion: RELAY_SCHEMA_VERSION,
			type: "delivery",
			deliveryId,
			delivered,
			transportMessageId,
			at: new Date().toISOString(),
		};
		if (error !== undefined) delivery.error = error;
		appendOutboxRecord(outboxPath, delivery);
	}
	return { deliveryId, delivered, transport: transport.name, transportMessageId, outboxPath };
}

function appendOutboxRecord(outboxPath: string, record: RelayOutboxRecord): void {
	mkdirSync(dirname(outboxPath), { recursive: true, mode: 0o700 });
	withRelayFileLock(outboxPath, () => {
		appendLineFsync(outboxPath, `${JSON.stringify(record)}\n`);
	});
}

function normalizeNotification(
	input: ProgrammeNotification,
): { kind: ProgrammeNotificationKind; text: string; decisionRef: ProgrammeNotificationDecisionRef | null } {
	if (!isPlainObject(input)) throw new ProgrammeRelayError("io", "sendProgrammeNotification requires a notification object");
	const extra = unknownKeys(input, new Set(["kind", "text", "decisionRef"]));
	if (extra.length > 0) throw new ProgrammeRelayError("io", `notification has unknown fields: ${extra.join(", ")}`);
	const kind = input.kind;
	const text = input.text;
	if (!oneOf(PROGRAMME_NOTIFICATION_KINDS, kind)) {
		throw new ProgrammeRelayError("io", `notification kind must be one of: ${PROGRAMME_NOTIFICATION_KINDS.join(", ")}`);
	}
	if (!nonEmptyString(text)) throw new ProgrammeRelayError("io", "notification text must be a non-empty string");
	return {
		kind,
		text,
		decisionRef: normalizeDecisionRef(input.decisionRef),
	};
}

function normalizeDecisionRef(value: unknown): ProgrammeNotificationDecisionRef | null {
	if (value === undefined || value === null) return null;
	if (typeof value === "string") {
		if (!nonEmptyString(value)) throw new ProgrammeRelayError("io", "notification decisionRef must be a non-empty decision id");
		return { decisionId: value };
	}
	if (!isPlainObject(value)) {
		throw new ProgrammeRelayError("io", "notification decisionRef must be a decision id or an object");
	}
	const extra = unknownKeys(value, new Set(["decisionId", "revision"]));
	if (extra.length > 0) throw new ProgrammeRelayError("io", `notification decisionRef has unknown fields: ${extra.join(", ")}`);
	const decisionId = value.decisionId;
	const revision = value.revision;
	if (!nonEmptyString(decisionId)) {
		throw new ProgrammeRelayError("io", "notification decisionRef.decisionId must be a non-empty string");
	}
	const ref: ProgrammeNotificationDecisionRef = { decisionId };
	if (revision !== undefined) {
		if (!Number.isInteger(revision) || (revision as number) < 1) {
			throw new ProgrammeRelayError("io", "notification decisionRef.revision must be a positive integer when present");
		}
		ref.revision = revision as number;
	}
	return ref;
}

// ─── Locking and small filesystem helpers ────────────────────────────────────

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
	Atomics.wait(sleepBuffer, 0, 0, ms);
}

function relayLockPathFor(path: string): string {
	return join(dirname(path), `.${basename(path)}.lock`);
}

/**
 * Per-file mkdir lock with stale recovery, mirroring `atomic-settings.ts`.
 * Used for the append-only inbox/outbox where the shared JSON CAS helper does
 * not apply.
 */
function withRelayFileLock<T>(path: string, action: () => T): T {
	const lockPath = relayLockPathFor(path);
	const ownerToken = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	while (true) {
		try {
			mkdirSync(lockPath, { mode: 0o700 });
			writeFileSync(
				join(lockPath, "owner.json"),
				JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: ownerToken }),
				{ mode: 0o600 },
			);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw new ProgrammeRelayError("io", `relay lock failure for ${path}: ${messageOf(error)}`);
			}
			if (recoverRelayStaleLock(lockPath)) continue;
			if (Date.now() >= deadline) {
				throw new ProgrammeRelayError("conflict", `Timed out waiting for relay lock ${lockPath}`);
			}
			sleepSync(LOCK_WAIT_MS);
		}
	}
	try {
		return action();
	} finally {
		try {
			const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as { token?: unknown };
			if (owner.token === ownerToken) rmSync(lockPath, { recursive: true, force: true });
		} catch {
			// Another owner recovered the lock; never remove it.
		}
	}
}

function recoverRelayStaleLock(lockPath: string): boolean {
	try {
		const ageMs = Date.now() - statSync(lockPath).mtimeMs;
		if (ageMs < LOCK_STALE_MS && !relayLockOwnerIsDead(lockPath)) return false;
		rmSync(lockPath, { recursive: true, force: true });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		return false;
	}
}

function relayLockOwnerIsDead(lockPath: string): boolean {
	try {
		const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as { pid?: unknown };
		if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
		try {
			process.kill(owner.pid, 0);
			return false;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ESRCH";
		}
	} catch {
		return false;
	}
}

function appendLineFsync(path: string, line: string): void {
	const buffer = Buffer.from(line, "utf8");
	const fd = openSync(path, "a", 0o600);
	try {
		let offset = 0;
		while (offset < buffer.length) {
			offset += writeSync(fd, buffer, offset, buffer.length - offset);
		}
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

async function clearStaleSocket(path: string): Promise<void> {
	if (!existsSync(path)) return;
	if (!lstatSync(path).isSocket()) {
		throw new ProgrammeRelayError("conflict", `relay path exists and is not a unix socket: ${path}`);
	}
	if (await probeSocket(path)) {
		throw new ProgrammeRelayError("conflict", `relay socket is already served: ${path}`);
	}
	try {
		unlinkSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new ProgrammeRelayError("io", `stale relay socket could not be removed at ${path}: ${messageOf(error)}`);
		}
	}
}

function probeSocket(path: string): Promise<boolean> {
	return new Promise((resolveProbe) => {
		const socket = connect(path);
		const timer = setTimeout(() => {
			socket.destroy();
			resolveProbe(false);
		}, PROBE_TIMEOUT_MS);
		timer.unref?.();
		socket.once("connect", () => {
			clearTimeout(timer);
			socket.destroy();
			resolveProbe(true);
		});
		socket.once("error", () => {
			clearTimeout(timer);
			socket.destroy();
			resolveProbe(false);
		});
	});
}

function removeFileQuietly(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		/* already gone or not removable; nothing else to do here */
	}
}

// ─── Frame authentication helpers ────────────────────────────────────────────

function isAuthFrame(value: unknown): value is { type: string; token: string } {
	if (!isPlainObject(value)) return false;
	if (unknownKeys(value, new Set(["type", "token"])).length > 0) return false;
	return value.type === AUTH_FRAME_TYPE && typeof value.token === "string";
}

function tokenMatches(expected: string, provided: string): boolean {
	if (expected === "") return false;
	const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
	const providedDigest = createHash("sha256").update(provided, "utf8").digest();
	return timingSafeEqual(expectedDigest, providedDigest);
}

/**
 * Node 24.18's `net.Socket` has no public `remoteUid`; this stays undefined and
 * the 0600 token file is the enforced same-user gate. When a runtime exposes
 * it, a mismatching peer is rejected before authentication.
 */
function peerUid(socket: Socket): number | undefined {
	const value = (socket as unknown as { remoteUid?: unknown }).remoteUid;
	return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

// ─── Small helpers (mirrors decisions.ts conventions) ────────────────────────

function assertProgrammeId(programmeId: string): string {
	if (typeof programmeId !== "string" || !PROGRAMME_ID_PATTERN.test(programmeId)) {
		throw new ProgrammeRelayError("io", `invalid programme id: ${String(programmeId)}`);
	}
	return programmeId;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

function unknownKeys(value: Record<string, unknown>, known: ReadonlySet<string>): string[] {
	return Object.keys(value).filter((key) => !known.has(key));
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
	return typeof value === "string" && (values as readonly string[]).includes(value);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
