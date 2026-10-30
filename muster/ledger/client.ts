/**
 * The ledger client: the only way anything outside `musterd` talks to it (DL3).
 * Newline-delimited JSON over the daemon's Unix socket.
 *
 * One connection per client, opened lazily, carrying both requests and
 * subscriptions. Sharing it matters: a `subscribe` line and a following
 * `request` line are written in order to the same socket, so the daemon
 * registers the subscription before it handles the request that might trigger
 * the event.
 *
 * DL6 fail-open: when the daemon is unreachable and the method is a one-time
 * write (`appendEvent`), the request goes to the spool and the call resolves
 * `{ spooled: true }` instead of rejecting. Every other method rejects with
 * `musterd is not running`.
 *
 * Runtime imports are `node:net`, `node:crypto` and `./spool.ts` only, so the
 * Claude hook bundle stays small. `MusterEventData` and `LedgerDocKind` are
 * type-only imports and are erased.
 */

import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { connect, type Socket } from "node:net";
import type { LedgerDocKind, MusterEventData } from "./schema.ts";
import { spoolWrite } from "./spool.ts";

export type { LedgerDocKind };

/**
 * A document wake (CRP, blueprint D30 first part): the kind of the document and its
 * key, never its value. A frame is a nudge; the reader reads through the owner.
 */
export type LedgerDoc = { kind: string; key: string };

/**
 * What a subscription asks for: events by type and lane, documents by kind. A
 * subscriber that names `docs` and no `types` gets no event frame (CRP 2).
 */
export type LedgerFilter = { types?: string[]; lanes?: string[]; docs?: LedgerDocKind[] };

const UNREACHABLE = "musterd is not running";
/**
 * The framing guard's default: a reply line past it tears the connection down, so
 * a desynced stream fails instead of growing without end. A caller that
 * legitimately asks `musterd` for a whole store in one reply — the rollback
 * export — raises the bound on its own connection (`ClientOptions.maxLineBytes`,
 * finding 28); every other client keeps this default.
 */
export const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;

type Reply = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };

/** The caller could not reach `musterd`. Only this class is spooled. */
export class MusterdUnreachable extends Error {
	constructor() {
		super(UNREACHABLE);
		this.name = "MusterdUnreachable";
	}
}

/**
 * The DL6 hook timeout: 3 x the p99 of the one-file hook bundle measured through
 * the synchronous bridge (LC3-R1, architect 2026-10-17). The accepting run: 161 ms
 * p99 over 200 calls through the bundle on 2026-10-17 (`/tmp/lc3-logs/latency-200.log`,
 * a second accepting run measured 190 ms p99 in `/tmp/lc3-logs/latency-200-r1.log`),
 * so 3 x 161 = 483. It replaces the pilot's 273 ms, which came from the async hook's
 * 91 ms p99 (gate G2, 2026-10-13, `plans/muster-autonomy/ledger-pilot-evidence/`)
 * before the bridge added a worker thread to every hook call.
 * Hooks pass it as `timeoutMs`; every other caller keeps the 2000 ms default.
 */
export const HOOK_TIMEOUT_MS = 483;

export type ClientOptions = {
	/** How long one call may take before it is treated as unreachable. Default 2000. */
	timeoutMs?: number;
	/**
	 * Tear the connection down when one reply line passes this many characters.
	 * Default 1 MiB (`DEFAULT_MAX_LINE_BYTES`). The rollback export raises it on
	 * its own connection: its whole-store dumps (`messages`, `asksAll`, `events`)
	 * legitimately pass 1 MiB (finding 28), and the bound only has to stop a
	 * desynced stream, not a real answer.
	 */
	maxLineBytes?: number;
};

export type LedgerClient = {
	request<T>(method: string, params?: object, options?: { spool?: boolean }): Promise<T>;
	subscribe(
		filter: LedgerFilter,
		onEvent: (event: MusterEventData) => void,
		onDoc?: (doc: LedgerDoc) => void,
	): () => void;
	close(): void;
};

type Pending = {
	resolve: (reply: Reply) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

export function createClient(socketPath: string, options: ClientOptions = {}): LedgerClient {
	const timeoutMs = options.timeoutMs ?? 2000;
	const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
	const ledgerDir = dirname(socketPath);
	const pending = new Map<string, Pending>();
	const subscriptions = new Map<
		string,
		{ filter: LedgerFilter; onEvent: (event: MusterEventData) => void; onDoc?: (doc: LedgerDoc) => void }
	>();
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let socket: Socket | null = null;
	let connecting: Promise<void> | null = null;
	let buffer = "";
	let closed = false;

	function unreachable(): MusterdUnreachable {
		return new MusterdUnreachable();
	}

	function failAll(error: Error): void {
		const entries = [...pending.values()];
		pending.clear();
		for (const entry of entries) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
	}

	function teardown(): void {
		if (socket !== null) {
			socket.removeAllListeners();
			socket.destroy();
			socket = null;
		}
	}

	function onData(chunk: string): void {
		buffer += chunk;
		if (buffer.length > maxLineBytes) {
			teardown();
			failAll(unreachable());
			return;
		}
		let newline: number;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			let frame: { id?: unknown; sub?: unknown; event?: unknown; doc?: unknown; ok?: unknown; result?: unknown; error?: unknown };
			try {
				frame = JSON.parse(line) as typeof frame;
			} catch {
				continue;
			}
			if (typeof frame.sub === "string" && frame.event !== undefined) {
				subscriptions.get(frame.sub)?.onEvent(frame.event as MusterEventData);
				continue;
			}
			// CRP: a document wake reaches the subscription's `onDoc`, and a subscription
			// without one drops it instead of waking its `onEvent`.
			if (typeof frame.sub === "string" && frame.doc !== undefined) {
				const doc = frame.doc as { kind?: unknown; key?: unknown };
				if (typeof doc.kind === "string" && typeof doc.key === "string") {
					subscriptions.get(frame.sub)?.onDoc?.({ kind: doc.kind, key: doc.key });
				}
				continue;
			}
			if (typeof frame.id !== "string") continue;
			const entry = pending.get(frame.id);
			if (entry === undefined) continue;
			pending.delete(frame.id);
			clearTimeout(entry.timer);
			entry.resolve(frame as Reply);
		}
	}

	/**
	 * A subscription outlives a `musterd` restart (G4): while any subscriber is
	 * registered the client reconnects once a second, sends every subscription
	 * again and wakes each subscriber once, because a frame is only a wake and the
	 * subscriber then reads what it missed from its own cursor (spec §3.3).
	 */
	function scheduleReconnect(): void {
		if (closed || subscriptions.size === 0 || reconnectTimer !== null) return;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			if (closed || subscriptions.size === 0) return;
			ensureSocket().then(
				() => {
					for (const [sub, entry] of subscriptions) {
						void write(`${JSON.stringify({ id: sub, method: "subscribe", params: entry.filter })}\n`).catch(() => {});
					}
					for (const entry of [...subscriptions.values()]) entry.onEvent({ type: "RECONNECT", text: "", at: Date.now(), id: 0 } as MusterEventData);
				},
				() => scheduleReconnect(),
			);
		}, 1000);
	}

	function attach(connected: Socket): void {
		socket = connected;
		connected.setEncoding("utf8");
		connected.on("data", onData);
		connected.on("error", () => {
			teardown();
			failAll(unreachable());
			scheduleReconnect();
		});
		connected.on("close", () => {
			teardown();
			failAll(unreachable());
			scheduleReconnect();
		});
	}

	function ensureSocket(): Promise<void> {
		if (socket !== null && !socket.destroyed && socket.writable) return Promise.resolve();
		if (connecting !== null) return connecting;
		const attempt = new Promise<void>((resolve, reject) => {
			const connected = connect(socketPath);
			let settled = false;
			const fail = (): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				connected.removeListener("error", fail);
				connected.destroy();
				if (connecting === attempt) connecting = null;
				reject(unreachable());
			};
			const timer = setTimeout(fail, timeoutMs);
			connected.once("error", fail);
			connected.once("connect", () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				connected.removeListener("error", fail);
				if (connecting === attempt) connecting = null;
				attach(connected);
				resolve();
			});
		});
		connecting = attempt;
		return attempt;
	}

	/**
	 * Write one line. Both `request` and `subscribe` await the same connect, and a
	 * caller that writes first is continued first, so lines reach the socket in
	 * call order.
	 */
	async function write(line: string): Promise<void> {
		await ensureSocket();
		const connected = socket;
		if (connected === null || connected.destroyed) throw unreachable();
		connected.write(line);
	}

	async function request<T>(
		method: string,
		params: object = {},
		requestOptions: { spool?: boolean } = {},
	): Promise<T> {
		if (closed) throw new Error("client is closed");
		const id = randomUUID();
		const line = `${JSON.stringify({ id, method, params })}\n`;
		try {
			const reply = await new Promise<Reply>((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(unreachable());
				}, timeoutMs);
				pending.set(id, { resolve, reject, timer });
				void write(line).catch((error: unknown) => {
					const entry = pending.get(id);
					if (entry === undefined) return;
					pending.delete(id);
					clearTimeout(entry.timer);
					entry.reject(error instanceof Error ? error : unreachable());
				});
			});
			if (reply.ok) return reply.result as T;
			throw new Error(reply.error);
		} catch (error) {
			if (
				requestOptions.spool === true &&
				error instanceof MusterdUnreachable &&
				method === "appendEvent"
			) {
				spoolWrite(ledgerDir, {
					method,
					params: params as { requestId: string } & Record<string, unknown>,
				});
				return { spooled: true } as T;
			}
			throw error;
		}
	}

	function subscribe(
		filter: LedgerFilter,
		onEvent: (event: MusterEventData) => void,
		onDoc?: (doc: LedgerDoc) => void,
	): () => void {
		if (closed) return () => {};
		const sub = randomUUID();
		subscriptions.set(sub, { filter, onEvent, ...(onDoc === undefined ? {} : { onDoc }) });
		void write(`${JSON.stringify({ id: sub, method: "subscribe", params: filter })}\n`).catch(() => {
			// Unreachable: the subscription is sent again once `musterd` answers.
			scheduleReconnect();
		});
		return () => {
			subscriptions.delete(sub);
		};
	}

	function close(): void {
		closed = true;
		if (reconnectTimer !== null) clearTimeout(reconnectTimer);
		reconnectTimer = null;
		subscriptions.clear();
		teardown();
		failAll(unreachable());
	}

	return { request, subscribe, close };
}
