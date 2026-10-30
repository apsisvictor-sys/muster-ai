/**
 * The worker half of the synchronous bridge (`client-sync.ts`, §3.2).
 *
 * `Atomics.wait` blocks the whole thread, so the socket work cannot run on the
 * caller's thread: the caller must be able to time a request out and carry on
 * while this worker keeps the one `createClient` connection open (`DL3`). The
 * worker never decides a timeout: the caller owns the deadline, and a reply that
 * arrives after it is a late answer the caller drops.
 *
 * It is bundled as a string by `extensions/muster/build-hook-bundle.mjs` and
 * started with `new Worker(code, { eval: true })`, so a one-file Claude hook
 * bundle needs no second file. Under tsx the same module is started from its own
 * file URL. Node builtins plus `client.ts` only.
 */

import { parentPort, type MessagePort } from "node:worker_threads";
import { DEFAULT_MAX_LINE_BYTES, MusterdUnreachable, createClient, type LedgerClient } from "./client.ts";

/** One request, posted by the caller. `maxLineBytes` raises the socket connection's reply-line guard (finding 28); the connection's bound is the highest any of its requests asked for. */
export type SyncRequest = { seq: number; socket: string; method: string; params: object; maxLineBytes?: number };

/** One reply, posted back. `unreachable` is `MusterdUnreachable`; `error` is the daemon's own message. */
export type SyncReply =
	| { seq: number; ok: true; result: unknown }
	| { seq: number; ok: false; reason: "unreachable" }
	| { seq: number; ok: false; reason: "error"; message: string };

/** The caller's first post: the reply port and the counter every reply bumps. */
type Start = { port: MessagePort; counter: SharedArrayBuffer };

/**
 * The worker's own client timeout sits above the longest caller budget (30 s,
 * the import and export batches), so the caller's deadline decides and a slow
 * answer is still delivered as a late reply rather than turned into a second
 * `MusterdUnreachable` inside the worker.
 */
const CLIENT_TIMEOUT_MS = 30_000;

const clients = new Map<string, { client: LedgerClient; maxLineBytes: number }>();
let replyPort: MessagePort | undefined;
let counter: Int32Array | undefined;

/** Bump the counter and wake the caller: it drains the port itself. */
function notify(): void {
	if (counter === undefined) return;
	Atomics.add(counter, 0, 1);
	Atomics.notify(counter, 0);
}

function reply(message: SyncReply): void {
	replyPort?.postMessage(message);
	notify();
}

/**
 * The socket's one connection, with the reply-line guard its requests asked for.
 * A request may only raise the bound (the export's whole-store dumps pass 1 MiB,
 * finding 28), never lower it; a raised connection is replaced, and the worker
 * holds no subscriptions, so the replace drops nothing.
 */
function clientFor(socket: string, maxLineBytes: number): LedgerClient {
	const existing = clients.get(socket);
	if (existing !== undefined && existing.maxLineBytes >= maxLineBytes) return existing.client;
	existing?.client.close();
	const client = createClient(socket, { timeoutMs: CLIENT_TIMEOUT_MS, maxLineBytes });
	clients.set(socket, { client, maxLineBytes });
	return client;
}

async function handle(request: SyncRequest): Promise<void> {
	try {
		const result = await clientFor(request.socket, request.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES).request(request.method, request.params);
		reply({ seq: request.seq, ok: true, result });
	} catch (error) {
		if (error instanceof MusterdUnreachable) reply({ seq: request.seq, ok: false, reason: "unreachable" });
		else reply({ seq: request.seq, ok: false, reason: "error", message: error instanceof Error ? error.message : String(error) });
	}
}

parentPort?.on("message", (start: Start) => {
	replyPort = start.port;
	counter = new Int32Array(start.counter);
	replyPort.on("message", (request: SyncRequest) => {
		void handle(request);
	});
});
