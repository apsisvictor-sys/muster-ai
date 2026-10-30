/**
 * The synchronous bridge (LC3, §3.2): one request to `musterd`, answered
 * synchronously, for the callers that cannot await — the Claude hook, the Pi
 * extension handlers and the owners they call (LC-D2).
 *
 * A worker thread holds the one `createClient` connection (DL3) because
 * `Atomics.wait` blocks the calling thread: the caller posts `{seq, socket,
 * method, params}` on a `MessageChannel` port and waits on a shared counter the
 * worker bumps after every reply, for at most its own deadline. Replies are
 * drained with `receiveMessageOnPort`, so a reply to an earlier `seq` is a late
 * answer to a call that already timed out: it is dropped, and a call is never
 * paired with an earlier call's result.
 *
 * `requestSync` never retries. A mutating call that timed out may still have
 * committed; the caller is where a files-mode write leaves it when the process
 * dies after the rename. A timeout opens a 60 s breaker for that socket and a
 * refused or missing socket a 5 s one, so a hook is not charged the deadline
 * again on every tool step while `musterd` is down (DL6).
 *
 * Three loaders must work: tsx (Pi extension, CLI, tick, gateway, OpenCode
 * host) starts the worker from its own file URL, and the one-file Claude hook
 * bundle inlines the worker's code as a string (`build-hook-bundle.mjs`) —
 * there is no second file to load from inside a bundle. Node builtins plus
 * `client.ts` only.
 */

import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import { MusterdUnreachable } from "./client.ts";
import type { SyncReply, SyncRequest } from "./client-sync-worker.ts";

export type SyncOptions = {
	/** How long one call may take before it is treated as unreachable. */
	timeoutMs?: number;
	/** Raises the connection's reply-line guard for this call (finding 28): the rollback export's whole-store dumps pass the 1 MiB default. */
	maxLineBytes?: number;
};

/** The daemon answered with its own error: an unknown method, a refused revision, a torn store. */
export class LedgerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LedgerError";
	}
}

/** The longest caller budget outside hooks: the import and export batches (global constraints). A hook passes `HOOK_TIMEOUT_MS`. */
const DEFAULT_TIMEOUT_MS = 2000;
/** A call that ran out of time may still have committed, and a restarted `musterd` must be given room (LC-D6). */
const TIMEOUT_BREAKER_MS = 60_000;
/** A refused or missing socket is answered at once; the next call may try again sooner. */
const REFUSED_BREAKER_MS = 5_000;

/**
 * The worker's file, held in a variable on purpose: a literal `new URL("…",
 * import.meta.url)` in a bundle would be rewritten to a second emitted file,
 * which is exactly what the one-file hook bundle cannot have.
 */
const WORKER_FILE = "./client-sync-worker.ts";

/** The worker's code when this module is inside the one-file bundle, else undefined (`build-hook-bundle.mjs`). */
const bundledWorkerCode = (globalThis as { __MUSTER_SYNC_WORKER_CODE__?: string }).__MUSTER_SYNC_WORKER_CODE__;

type Bridge = { worker: Worker; port: MessagePort; counter: Int32Array; seq: number };

/** One worker per socket: it holds that socket's `createClient` connection. Created on the first call, unref'd. */
const bridges = new Map<string, Bridge>();
/** Per socket: epoch ms before which every call throws `MusterdUnreachable` at once. */
const breakerUntil = new Map<string, number>();

/**
 * The caller's deadline is real elapsed time on a monotonic clock, so a test
 * that moves the wall clock (`Date`, the breaker's own clock) can never move a
 * deadline and stall a wait.
 */
function monotonicMs(): number {
	return Number(process.hrtime.bigint()) / 1_000_000;
}

function startBridge(socket: string): Bridge {
	const worker =
		bundledWorkerCode === undefined
			? new Worker(new URL(WORKER_FILE, import.meta.url))
			: new Worker(bundledWorkerCode, { eval: true });
	worker.unref();
	// A worker that cannot even start (the file path under a Node without a loader for it) must never crash the
	// caller: with no reply the deadline gives the same `MusterdUnreachable` a missing daemon gives, and a hook
	// keeps its fail-open boundary (DL6). The listener exists to turn the crash into that deadline.
	worker.on("error", () => {});
	const channel = new MessageChannel();
	const counter = new Int32Array(new SharedArrayBuffer(4));
	const bridge: Bridge = { worker, port: channel.port1, counter, seq: 0 };
	worker.postMessage({ port: channel.port2, counter: counter.buffer }, [channel.port2]);
	bridges.set(socket, bridge);
	return bridge;
}

function bridgeFor(socket: string): Bridge {
	return bridges.get(socket) ?? startBridge(socket);
}

/** Wait for `seq`'s reply until `deadline`, dropping late replies to earlier calls. Undefined when the deadline passed. */
function waitForReply(bridge: Bridge, seq: number, deadline: number): SyncReply | undefined {
	let seen = Atomics.load(bridge.counter, 0);
	for (;;) {
		let received = receiveMessageOnPort(bridge.port);
		while (received !== undefined) {
			const reply = received.message as SyncReply;
			if (reply.seq === seq) return reply;
			received = receiveMessageOnPort(bridge.port);
		}
		const remaining = deadline - monotonicMs();
		if (remaining <= 0) return undefined;
		Atomics.wait(bridge.counter, 0, seen, remaining);
		seen = Atomics.load(bridge.counter, 0);
	}
}

/**
 * One request to `musterd`, answered synchronously. Throws `MusterdUnreachable`
 * when the socket cannot be reached or the deadline passes, or `LedgerError`
 * with the daemon's own message when the method failed.
 */
export function requestSync<T>(socketPath: string, method: string, params?: object, options?: SyncOptions): T {
	// RF5: the daemon must never wait on itself. `scripts/musterd.mts` marks its process, so an owner pulled in by a method fails here instead of deadlocking.
	if (process.env["MUSTERD"] === "1") throw new LedgerError("requestSync inside musterd");
	const until = breakerUntil.get(socketPath);
	if (until !== undefined && Date.now() < until) throw new MusterdUnreachable();
	const bridge = bridgeFor(socketPath);
	const seq = ++bridge.seq;
	const deadline = monotonicMs() + (options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const request: SyncRequest = { seq, socket: socketPath, method, params: params ?? {} };
	if (options?.maxLineBytes !== undefined) request.maxLineBytes = options.maxLineBytes;
	bridge.port.postMessage(request);
	const reply = waitForReply(bridge, seq, deadline);
	if (reply === undefined) {
		breakerUntil.set(socketPath, Date.now() + TIMEOUT_BREAKER_MS);
		throw new MusterdUnreachable();
	}
	if (reply.ok) return reply.result as T;
	if (reply.reason === "unreachable") {
		breakerUntil.set(socketPath, Date.now() + REFUSED_BREAKER_MS);
		throw new MusterdUnreachable();
	}
	throw new LedgerError(reply.message);
}
