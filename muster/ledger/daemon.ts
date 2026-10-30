/**
 * `musterd` — the one process that owns the Muster ledger (DL3).
 *
 * It opens the Harness over the ledger's SQLite storage, takes an exclusive
 * lock so two daemons never share one storage (Durable Pi has no cross-process
 * locking), then serves newline-delimited JSON on `dir/ledger.sock`.
 * Subscribers are pushed every committed `muster.event` entry, and — when they name
 * `docs` — a wake for every committed document change of that kind (CRP, blueprint
 * D30 first part); `events` reads them by cursor, so a `muster wait` never depends on
 * one frame per commit.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { CommitPublication, EntryId } from "@earendil-works/pi-durable";
import { readBackend } from "./backend.ts";
import { sweepInboxDoorbells, syncInboxDoorbells } from "./doorbell.ts";
import { appendEvent, askAppend, asksAll, casList, casRead, casUpdate, commit, drain, eventsSince, importBatch, inboxes, markDelivered, messageRead, messages, send } from "./methods.ts";
import { watchEventLoop } from "./loop-lag.ts";
import { keepTick, openLedger, type Ledger } from "./open.ts";
import type { TickPassPorts } from "../tick.ts";
import { MusterEvent, type MusterEventData, type MusterEventValue } from "./schema.ts";

const MAX_REQUEST_BYTES = 1024 * 1024;

export type Daemon = {
	socketPath: string;
	stop(): Promise<void>;
};

/** What one subscriber asks for, without its socket: the frame selection reads only this. */
export type LedgerSubscriber = { id: string; types?: string[]; lanes?: string[]; docs?: string[] };

type Subscriber = LedgerSubscriber & { socket: Socket };

/**
 * One frame for one subscriber: an event, or a document wake carrying the kind and
 * key of what changed and never its value, because the reader reads through the owner.
 */
export type CommitFrame = { sub: string; event?: MusterEventData; doc?: { kind: string; key: string } };

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Take the daemon's exclusive lock, replacing one whose PID is dead. */
function acquireLock(dir: string): string {
	const lockPath = join(dir, "musterd.lock");
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(lockPath, "wx");
			try {
				writeSync(fd, String(process.pid));
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			return lockPath;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const pid = Number(readFileSync(lockPath, "utf8").trim());
			if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
				throw new Error(`musterd already running (pid ${pid})`);
			}
			rmSync(lockPath, { force: true });
		}
	}
	throw new Error("musterd could not take its lock");
}

async function dispatch(l: Ledger, method: string, params: Record<string, unknown>): Promise<unknown> {
	switch (method) {
		case "appendEvent":
			return appendEvent(l, params as unknown as Parameters<typeof appendEvent>[1]);
		case "askAppend":
			return askAppend(l, params as unknown as Parameters<typeof askAppend>[1]);
		case "asksAll":
			return asksAll(l);
		case "casRead":
			return casRead(l, params as unknown as Parameters<typeof casRead>[1]);
		case "casList":
			return casList(l, params as unknown as Parameters<typeof casList>[1]);
		case "casUpdate":
			return casUpdate(l, params as unknown as Parameters<typeof casUpdate>[1]);
		case "commit":
			return commit(l, params as unknown as Parameters<typeof commit>[1]);
		case "drain":
			return drain(l, params as unknown as Parameters<typeof drain>[1]);
		case "importBatch":
			return importBatch(l, params as unknown as Parameters<typeof importBatch>[1]);
		case "inboxes":
			return inboxes(l, params as unknown as Parameters<typeof inboxes>[1]);
		case "markDelivered":
			return markDelivered(l, params as unknown as Parameters<typeof markDelivered>[1]);
		case "messageRead":
			return messageRead(l, params as unknown as Parameters<typeof messageRead>[1]);
		case "messages":
			return messages(l, params as unknown as Parameters<typeof messages>[1]);
		case "send":
			return send(l, params as unknown as Parameters<typeof send>[1]);
		case "events": {
			const after = typeof params.after === "string" && params.after !== "" ? (Number(params.after) as EntryId) : undefined;
			return eventsSince(l, after);
		}
		default:
			throw new Error(`unknown method ${method}`);
	}
}

/**
 * The address whose `muster.inbox.pending` a method's commit changes, or undefined
 * when the method leaves the index (and so the doorbells) alone (LC8).
 */
function changedInboxAddress(method: string, params: Record<string, unknown>): string | undefined {
	if (method === "send") {
		const message = params["message"] as { agent?: unknown } | undefined;
		return typeof message?.agent === "string" ? message.agent : undefined;
	}
	if (method === "drain" || method === "markDelivered") {
		return typeof params["address"] === "string" ? params["address"] : undefined;
	}
	return undefined;
}

/**
 * Keep one address's doorbells in step with its index after a committed change
 * (LC8): raise the missing ones, remove the ones whose message is no longer
 * pending. Only in ledger mode — in files mode the folder holds the messages
 * themselves. A doorbell is derived, so a failure here is logged and never fails
 * the committed method it follows.
 */
async function reconcileDoorbells(ledger: Ledger, dir: string, address: string): Promise<void> {
	try {
		if (readBackend(dir) !== "ledger") return;
		const [inbox] = await inboxes(ledger, { address });
		syncInboxDoorbells(dir, address, inbox?.pending ?? []);
	} catch (error) {
		process.stderr.write(`musterd: the doorbells for ${address} were not reconciled (${messageOf(error)})\n`);
	}
}

/**
 * Rebuild the whole doorbell set when `musterd` starts (LC8): the pending index is
 * the truth and the folder is a projection, so a doorbell deleted by hand comes
 * back and a stale one goes. A non-empty file in the folder is a message file,
 * logged once here and left in place; `muster ledger status` counts it.
 */
async function rebuildDoorbells(ledger: Ledger, dir: string): Promise<void> {
	try {
		if (readBackend(dir) !== "ledger") return;
		const pending = new Map<string, string[]>();
		for (const inbox of await inboxes(ledger, {})) pending.set(inbox.address, inbox.pending);
		const sweep = sweepInboxDoorbells(dir, pending);
		for (const stray of sweep.strays) {
			process.stderr.write(
				`musterd: ${stray.address}/${stray.name} is a non-empty file in an inbox folder and is left in place; muster ledger status counts it\n`,
			);
		}
	} catch (error) {
		process.stderr.write(`musterd: the doorbell sweep failed (${messageOf(error)})\n`);
	}
}

function writeLine(socket: Socket, value: unknown): void {
	if (socket.destroyed) return;
	socket.write(`${JSON.stringify(value)}\n`);
}

/**
 * The frames one publication sends one subscriber (CRP, blueprint D30 first part).
 *
 * An event frame is what this daemon has always sent. A `doc` frame is a wake for a
 * document change whose kind the subscriber named; the key is `<store>:<id>` for a
 * compare-and-set write and the ask id for an ask append. A subscriber that names
 * `docs` gets event frames only when it also names `types`: today's "no `types`
 * means every event type" stays true only for a subscriber that asked for no
 * documents, so one filter never widens the other by surprise.
 */
export function framesFor(publication: CommitPublication, subscriber: LedgerSubscriber): CommitFrame[] {
	const frames: CommitFrame[] = [];
	for (const change of publication.changes) {
		if (change.type === "document") {
			const { kind, key } = change.record;
			if (key === undefined || subscriber.docs === undefined || !subscriber.docs.includes(kind)) continue;
			frames.push({ sub: subscriber.id, doc: { kind, key } });
			continue;
		}
		if (change.type !== "entry" || change.value.kind !== MusterEvent.kind) continue;
		if (subscriber.docs !== undefined && subscriber.types === undefined) continue;
		const event = { ...(change.value.data as MusterEventValue | undefined), id: change.value.id } as MusterEventData;
		if (subscriber.types !== undefined && !subscriber.types.includes(event.type)) continue;
		// LC9: the `lanes` filter matches the event's `lane`, so an inbox waiter is woken by
		// the `SENT` entry addressed to it and never by another address's mail.
		if (subscriber.lanes !== undefined && (event.lane === undefined || !subscriber.lanes.includes(event.lane))) continue;
		frames.push({ sub: subscriber.id, event });
	}
	return frames;
}

function pushCommits(publication: CommitPublication, subscribers: readonly Subscriber[]): void {
	for (const subscriber of subscribers) {
		for (const frame of framesFor(publication, subscriber)) writeLine(subscriber.socket, frame);
	}
}

async function handleLine(
	socket: Socket,
	line: string,
	ledger: Ledger,
	subscribers: Subscriber[],
	dir: string,
): Promise<void> {
	let request: { id?: unknown; method?: unknown; params?: unknown };
	try {
		request = JSON.parse(line) as typeof request;
	} catch {
		writeLine(socket, { id: "", ok: false, error: "invalid request" });
		return;
	}
	const id = typeof request.id === "string" ? request.id : "";
	const method = typeof request.method === "string" ? request.method : "";
	const params = (request.params ?? {}) as Record<string, unknown>;
	if (method === "subscribe") {
		const raw = params.types;
		const types = Array.isArray(raw) ? raw.filter((type): type is string => typeof type === "string") : undefined;
		// LC9: `lanes` beside the pilot's `types`, matched against the event's `lane`.
		const rawLanes = params.lanes;
		const lanes = Array.isArray(rawLanes) ? rawLanes.filter((lane): lane is string => typeof lane === "string") : undefined;
		// CRP: the document kinds whose writes wake this subscriber. Absent is today's
		// subscriber: events only, exactly as before.
		const rawDocs = params.docs;
		const docs = Array.isArray(rawDocs) ? rawDocs.filter((doc): doc is string => typeof doc === "string") : undefined;
		subscribers.push({
			socket,
			id,
			...(types === undefined ? {} : { types }),
			...(lanes === undefined ? {} : { lanes }),
			...(docs === undefined ? {} : { docs }),
		});
		writeLine(socket, { id, ok: true, result: { sub: id } });
		return;
	}
	try {
		const result = await dispatch(ledger, method, params);
		const address = changedInboxAddress(method, params);
		if (address !== undefined) await reconcileDoorbells(ledger, dir, address);
		writeLine(socket, { id, ok: true, result });
	} catch (error) {
		writeLine(socket, { id, ok: false, error: messageOf(error) });
	}
}

function serve(socket: Socket, ledger: Ledger, subscribers: Subscriber[], dir: string): void {
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("error", () => {
		// A client that goes away mid-request is not the daemon's failure.
	});
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		if (buffer.length > MAX_REQUEST_BYTES) {
			socket.destroy();
			return;
		}
		let newline: number;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			void handleLine(socket, line, ledger, subscribers, dir);
		}
	});
	socket.on("close", () => {
		for (let index = subscribers.length - 1; index >= 0; index--) {
			if (subscribers[index]?.socket === socket) subscribers.splice(index, 1);
		}
	});
}

/**
 * Start the daemon under `dir`. Refuses when another live process holds the
 * lock and unlinks a stale socket only after taking the lock, then serves.
 */
export async function startDaemon(dir: string, options: { tickPass?: TickPassPorts } = {}): Promise<Daemon> {
	// RF5 (plan §3.2): mark this process as `musterd` before it serves anything, so an owner pulled in by a
	// method that calls `requestSync` fails at once instead of deadlocking on the daemon it is running inside.
	// PB1: MUSTER_LEDGER_TASKS is the caller's. This process never sets it; the live unit leaves it unset.
	process.env["MUSTERD"] = "1";
	mkdirSync(dir, { recursive: true });
	const lockPath = acquireLock(dir);
	const socketPath = join(dir, "ledger.sock");
	rmSync(socketPath, { force: true });
	let ledger: Ledger;
	try {
		ledger = await openLedger(dir, options.tickPass === undefined ? {} : { tickPass: options.tickPass });
	} catch (error) {
		rmSync(lockPath, { force: true });
		throw error;
	}
	// PB4: with MUSTER_LEDGER_TASKS=1 exactly one `muster.tick` lives from here on; with the flag unset
	// `keepTick` returns at once and the live unit creates no task (PB-D3).
	await keepTick(ledger);
	// The doorbells are the inbox folders of the state directory this ledger belongs to: `dir` is
	// that directory — `MUSTER_LEDGER_DIR` names it in production (LC8, LC-D5) — so a daemon started
	// against some other directory leaves those folders alone.
	await rebuildDoorbells(ledger, dir);
	const subscribers: Subscriber[] = [];
	const connections = new Set<Socket>();
	const unsubscribeCommits = ledger.harness.subscribeCommits((publication) => {
		try {
			pushCommits(publication, subscribers);
		} catch {
			// An observer must not fail the commit it observes.
		}
	});
	const server: Server = createServer((socket) => {
		connections.add(socket);
		socket.on("close", () => connections.delete(socket));
		serve(socket, ledger, subscribers, dir);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});
	// LC16 finding 16: a stall of the loop is written to the daemon's log with the CPU the
	// process used meanwhile, so a blocking call (CPU spent) reads differently from a host
	// that did not schedule the process (no CPU).
	const stopLoopWatch = watchEventLoop(({ lagMs, cpuMs }) => {
		process.stderr.write(`musterd: event loop stalled ${lagMs} ms (cpu ${cpuMs} ms) at ${new Date().toISOString()}\n`);
	});
	let stopped = false;
	return {
		socketPath,
		async stop(): Promise<void> {
			if (stopped) return;
			stopped = true;
			stopLoopWatch();
			unsubscribeCommits();
			for (const subscriber of subscribers.splice(0)) subscriber.socket.destroy();
			const closing = new Promise<void>((resolve) => server.close(() => resolve()));
			for (const connection of connections) connection.destroy();
			await closing;
			await ledger.close();
			rmSync(socketPath, { force: true });
			rmSync(lockPath, { force: true });
		},
	};
}
