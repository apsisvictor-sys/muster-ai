/**
 * Agent inbox — one file per message for an agent whose harness has no Concord
 * prompt endpoint (06:19 brief, build 1).
 *
 * Why a file: Concord can prompt an agent only when that agent published a
 * `pull` endpoint (`agent_endpoints` in the workspace db). The orchestrator has
 * none — `update_work prompt` answers `Agent orchestrator has no prompt
 * endpoint` — so a lane's reply to a relayed message had nowhere to land and the
 * bare fallback was tmux, which knows only session `pi`. An inbox file is
 * durable, needs no Concord change, and works for any harness whose session can
 * arm one blocked reader (`muster wait --inbox <agent>`).
 *
 * Contract, and it is the same discipline as the lane card:
 * - one message is one file, written to a temp name and renamed, so no reader
 *   ever sees half a message;
 * - a file that does not parse is skipped, never thrown and never a block;
 * - the reader MOVES a message into `read/` beside the pending inbox. Nothing is
 *   deleted (retain rule) and a second move of the same id does nothing.
 *
 * A lane-level report stays on the lane card too; the inbox also carries the
 * notice of a report that should wake the orchestrator (muster/lane-report.ts).
 *
 * One owner, two backends (LC7): `<musterStateDir>/backend.json` decides, read on
 * every call (LC-D2). In ledger mode this module is the only place that knows a
 * message, and it reaches `musterd` through the synchronous bridge; the file rules
 * below stay exactly what they are while the switch file is absent.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AttachmentRef } from "./inbox-attachments.ts";
import { readBackend, writeBackend } from "../ledger/backend.ts";
import { requestSync } from "../ledger/client-sync.ts";
import type { InboxRow } from "../ledger/methods.ts";
import type { MessageDoc } from "../ledger/schema.ts";
import { ownerLedgerSocket } from "../ledger/stores.ts";

export type InboxMessage = {
	/** Unique per message; a reader takes each message once. */
	id: string;
	/** Recipient agent id. */
	agent: string;
	/** Sender agent id. */
	from: string;
	/** ISO time the sender wrote it. */
	at: string;
	text: string;
	/** The sender's retry key, so a repeated send is recognisable. */
	idempotencyKey: string;
	/** `muster_update reply`: the message being answered. */
	replyTo?: string;
	/** Task the message is about, when it is not the agent's current task. */
	taskId?: string;
	/** Delivery mode the sender asked for (`steer`, `followup`, `wake`). */
	mode?: string;
	/** Which path wrote it. */
	source?: "send" | "reply" | "report";
	/**
	 * Set only by the muster CLI's relay admission path (`muster send`, LD35):
	 * the entry was written under the sender's seat-checked identity. An entry
	 * without it — any other writer — carries no launcher authority and the
	 * boundary text shows it as peer information.
	 */
	relayAdmitted?: true;
	/** Files stored with the message (`inbox-attachments.ts` keeps the bytes). */
	attachments?: AttachmentRef[];
}

/** `<musterStateDir>/inbox` — beside `lanes/` and `control/`, the same root. */
export function agentInboxRoot(musterStateDir: string): string {
	return join(musterStateDir, "inbox");
}

/** An agent id is a Concord agent id: readable, but never a path separator. */
function safeAgentId(agent: string): string {
	const flattened = agent
		.trim()
		.replace(/[\\/]+/g, "_")
		.replace(/\.\.+/g, "_")
		.replace(/^[\s._]+|[\s._]+$/g, "");
	return (flattened === "" ? "unknown" : flattened).slice(0, 120);
}

export function agentInboxDir(musterStateDir: string, agent: string): string {
	return join(agentInboxRoot(musterStateDir), safeAgentId(agent));
}

/** Messages already read, kept beside the pending ones. */
export function agentInboxReadDir(musterStateDir: string, agent: string): string {
	return join(agentInboxDir(musterStateDir, agent), "read");
}

/** `<atMs>-<id>.json`: the file name orders messages by arrival. */
function inboxFileName(message: { id: string; at: string; fallbackMs: number }): string {
	const parsed = Date.parse(message.at);
	const ms = Number.isFinite(parsed) ? parsed : message.fallbackMs;
	return `${String(ms).padStart(13, "0")}-${message.id}.json`;
}

/**
 * Write one message whole: temp file, fsync, rename. Returns the file path, or the
 * message id in ledger mode.
 *
 * Ledger mode (LC7): the id is minted first, as here, and the message goes to
 * `musterd` through the owner's own request id — sender, retry key and text — so an
 * exact repeat is stored once and answers with the first id, while distinct mail
 * under one reused key stays distinct. There is no file to name, so the id is what
 * this returns there.
 */
export function writeInboxMessage(
	musterStateDir: string,
	message: Omit<InboxMessage, "id"> & { id?: string },
): string {
	const full: InboxMessage = { ...message, id: message.id ?? randomUUID() };
	if (writeBackend(musterStateDir) === "ledger") {
		return requestSync<{ id: string }>(ownerLedgerSocket(musterStateDir), "send", { requestId: inboxSendRequestId(full), message: full }).id;
	}
	const dir = agentInboxDir(musterStateDir, message.agent);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const target = join(dir, inboxFileName({ id: full.id, at: full.at, fallbackMs: Date.now() }));
	const tmp = `${target}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
	const fd = openSync(tmp, "w", 0o600);
	try {
		writeFileSync(fd, JSON.stringify(full, null, 2));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, target);
	return target;
}

function parseInboxMessage(raw: string): InboxMessage | undefined {
	try {
		const parsed = JSON.parse(raw) as InboxMessage;
		if (typeof parsed?.id !== "string" || parsed.id === "") return undefined;
		if (typeof parsed?.agent !== "string" || typeof parsed?.from !== "string") return undefined;
		if (typeof parsed?.text !== "string" || typeof parsed?.at !== "string") return undefined;
		// The relay mark (LD35) is true only when the relay admission path wrote it
		// so; any other value a file carries is no mark.
		const { relayAdmitted, ...message } = parsed;
		return {
			...message,
			idempotencyKey: typeof message.idempotencyKey === "string" ? message.idempotencyKey : "",
			...(relayAdmitted === true ? { relayAdmitted: true as const } : {}),
		};
	} catch {
		return undefined;
	}
}

/**
 * The request id of one message write (LC7, G4): the same sender, retry key and
 * text is the same request. A message with no key is its own id, so the janitor's
 * `janitor-<date>` keeps every distinct summary and a CLI retry, which mints a new
 * key after a failure (`sendIdempotencyKey`), stays a new message, as today.
 */
function inboxSendRequestId(message: InboxMessage): string {
	if (message.idempotencyKey === "") return `msg:${message.id}`;
	const text = createHash("sha256").update(message.text).digest("hex").slice(0, 16);
	return `msg:${message.from}:${message.idempotencyKey}:${text}`;
}

/** Pending messages in arrival order; a torn or empty file is skipped. */
export function listInboxMessages(musterStateDir: string, agent: string): InboxMessage[] {
	if (readBackend(musterStateDir) === "ledger") {
		return requestSync<MessageDoc[]>(ownerLedgerSocket(musterStateDir), "messages", { address: agent, state: "accepted" }).map((doc) => doc.message);
	}
	const dir = agentInboxDir(musterStateDir, agent);
	if (!existsSync(dir)) return [];
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
	} catch {
		return [];
	}
	const messages: InboxMessage[] = [];
	for (const name of names) {
		try {
			const parsed = parseInboxMessage(readFileSync(join(dir, name), "utf8"));
			if (parsed !== undefined) messages.push(parsed);
		} catch {
			// A file that cannot be read is not a message; it never blocks a reader.
		}
	}
	return messages;
}

/**
 * One message by id, pending or already read, so no caller scans inbox directories itself.
 * The id is only compared with file names, never used to build a path.
 */
export function findInboxMessage(musterStateDir: string, agent: string, id: string): InboxMessage | undefined {
	if (id === "") return undefined;
	if (readBackend(musterStateDir) === "ledger") {
		// The address is checked here, not by the daemon: the ledger holds every address's
		// messages in one family, and a caller asks for one address's message.
		const doc = requestSync<MessageDoc | undefined>(ownerLedgerSocket(musterStateDir), "messageRead", { id });
		return doc !== undefined && doc.address === agent ? doc.message : undefined;
	}
	const suffix = `-${id}.json`;
	for (const dir of [agentInboxDir(musterStateDir, agent), agentInboxReadDir(musterStateDir, agent)]) {
		try {
			const name = readdirSync(dir).find((entry) => entry.endsWith(suffix));
			if (name === undefined) continue;
			const parsed = parseInboxMessage(readFileSync(join(dir, name), "utf8"));
			if (parsed !== undefined && parsed.id === id) return parsed;
		} catch {
			// A directory that does not exist or a file that cannot be read holds no message.
		}
	}
	return undefined;
}

/**
 * Where a pending message will sit once it is read; "" when its file is not found
 * and, in ledger mode, when no file backs it at all (LC7).
 */
export function inboxReadPath(musterStateDir: string, agent: string, id: string): string {
	if (id === "" || readBackend(musterStateDir) === "ledger") return "";
	const suffix = `-${id}.json`;
	try {
		const name = readdirSync(agentInboxDir(musterStateDir, agent)).find((entry) => entry.endsWith(suffix));
		return name === undefined ? "" : join(agentInboxReadDir(musterStateDir, agent), name);
	} catch {
		return "";
	}
}

/**
 * Messages already delivered, in arrival order, the newest `limit`.
 *
 * In files mode this is the owner's own read of `read/`, where a message lands
 * when it is marked read; in ledger mode the delivered documents, ordered by the
 * same key the file names order by. Both readers are this function, so oversight
 * (Henry's session and outbox views) never reads the layout itself.
 */
export function listDeliveredMessages(musterStateDir: string, agent: string, limit: number): InboxMessage[] {
	if (readBackend(musterStateDir) === "ledger") {
		return requestSync<MessageDoc[]>(ownerLedgerSocket(musterStateDir), "messages", { address: agent, state: "delivered", limit }).map((doc) => doc.message);
	}
	const dir = agentInboxReadDir(musterStateDir, agent);
	if (!existsSync(dir)) return [];
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort().slice(-limit);
	} catch {
		return [];
	}
	const messages: InboxMessage[] = [];
	for (const name of names) {
		try {
			const parsed = parseInboxMessage(readFileSync(join(dir, name), "utf8"));
			if (parsed !== undefined) messages.push(parsed);
		} catch {
			// A file that cannot be read is not a message.
		}
	}
	return messages;
}

/** Whole pending messages only, so a torn file cannot inflate the count. */
export function countInboxMessages(musterStateDir: string, agent: string): number {
	if (readBackend(musterStateDir) === "ledger") {
		const [inbox] = requestSync<InboxRow[]>(ownerLedgerSocket(musterStateDir), "inboxes", { address: agent });
		return inbox?.pending.length ?? 0;
	}
	return listInboxMessages(musterStateDir, agent).length;
}

/** Move one message into `read/`. Keeps the file; a second move does nothing. */
export function markInboxMessageRead(musterStateDir: string, agent: string, id: string): boolean {
	if (writeBackend(musterStateDir) === "ledger") {
		// One request id per message, so a replay of the same move writes nothing.
		const result = requestSync<{ ok: boolean }>(ownerLedgerSocket(musterStateDir), "markDelivered", { address: agent, id, requestId: `msg-delivered:${agent}:${id}` });
		return result.ok;
	}
	const dir = agentInboxDir(musterStateDir, agent);
	if (!existsSync(dir)) return false;
	const suffix = `-${id}.json`;
	let name: string | undefined;
	try {
		name = readdirSync(dir).find((entry) => entry.endsWith(suffix));
	} catch {
		return false;
	}
	if (name === undefined) return false;
	const readDir = agentInboxReadDir(musterStateDir, agent);
	mkdirSync(readDir, { recursive: true, mode: 0o700 });
	try {
		renameSync(join(dir, name), join(readDir, name));
		return true;
	} catch {
		return false;
	}
}

/** The agents that have something pending, for `muster lanes`. */
export function listInboxAgents(musterStateDir: string): string[] {
	if (readBackend(musterStateDir) === "ledger") {
		return requestSync<InboxRow[]>(ownerLedgerSocket(musterStateDir), "inboxes", {})
			.filter((inbox) => inbox.pending.length > 0)
			.map((inbox) => inbox.address);
	}
	const root = agentInboxRoot(musterStateDir);
	if (!existsSync(root)) return [];
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && countInboxMessages(musterStateDir, entry.name) > 0)
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}
