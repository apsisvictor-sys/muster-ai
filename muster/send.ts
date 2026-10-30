/**
 * `muster send` — A3 of the harness bus design, section 4.3 delivery.
 *
 * One delivery decision, transport injected: try Concord first, fall back to
 * the lane's pane only when Concord cannot deliver, and log every attempt.
 * The fallback is never silent — it is printed and appended to the send log,
 * because a pane-typed message is operator-visible input, not a Concord row.
 *
 * Concord carries the mode it can carry in v1 (`delivery_mode: steer`). The
 * other modes travel as an unmarked prompt: the recipient's adapter owns what
 * `followup` and `wake` mean there (Pi delivers a follow-up with triggerTurn,
 * so an idle lane starts and a busy lane reads it at its turn boundary).
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { appendFsyncedLine } from "../core/append-line.ts";
import { readBackend } from "./ledger/backend.ts";
import { formatAttachmentSize, type AttachmentRef } from "./lib/inbox-attachments.ts";
import { GATEWAY_AGENT_ID } from "./gateway/state.ts";
import { boundaryReason } from "./ledger/boundary.ts";

export const SEND_MODES = ["steer", "followup", "wake"] as const;
export type SendMode = (typeof SEND_MODES)[number];

export const SEND_LOG_FILE = "send-log.jsonl";

/** The tmux session a lane's window lives in, by harness (the launch recipe's layout). */
export function tmuxSessionForHarness(harness: string | undefined): string | undefined {
	if (harness === "opencode") return "oc";
	return undefined;
}

export type SendRequest = {
	/** Concord agent id (also the Herdr agent name) of the recipient lane. */
	laneId: string;
	mode: SendMode;
	text: string;
	/** Task the message is about, when it is not the lane's current task. */
	taskId?: string;
	/** Retry key; a fresh one is generated per attempt when absent. */
	idempotencyKey?: string;
	/** Files already stored (`inbox-attachments.ts`). They ride on the inbox message and as one plain line each in the text. */
	attachments?: AttachmentRef[];
};

export type PaneDelivery = (request: { laneId: string; text: string }) => Promise<{ ok: boolean; command: string; exitCode?: number; detail?: string }>;

/**
 * The inbox transport: one file for an agent whose harness has no Concord
 * prompt endpoint (the orchestrator today). Durable, needs no Concord change,
 * and the recipient's own blocked reader picks it up (`muster wait --inbox`).
 */
export type InboxDelivery = (request: {
	laneId: string;
	text: string;
	idempotencyKey: string;
	mode: SendMode;
	taskId?: string;
	attachments?: AttachmentRef[];
}) => Promise<{ ok: boolean; path?: string; messageId?: string; error?: string }>;

/**
 * What happened to a message Concord accepted. Concord's own `delivered` only
 * means the lane's watch process drained its inbox row; the lane's extension may
 * still hold the message (mid-turn, an unsent draft, an open prompt). The lane's
 * card says what is still held: `pendingIn`.
 */
export type ArrivalProof =
	/** A card written after delivery shows nothing held. */
	| { state: "confirmed" }
	/** The lane publishes no pending count (or has no card): Concord's answer is all there is. */
	| { state: "unverifiable" }
	/** The lane is beating and holds the message (mid-turn, a draft, an open prompt): Concord delivers it when the lane is free. The pane is not used. */
	| { state: "queued"; detail: string }
	/** The lane stopped writing its card (or is gone) before taking the message: nothing is reading Concord's row. */
	| { state: "held"; detail: string };

/**
 * What a message to a parked lane did: the lane was relaunched with it, could not be, was not parked
 * at all, or is a parked Claude session. A Claude session is never relaunched by a message (LD16):
 * `inbox-only` leaves the message to its inbox, read when the session is next opened.
 */
export type ParkedResumeResult = { state: "not-parked" } | { state: "resumed"; detail: string; brief: string } | { state: "failed"; reason: string } | { state: "inbox-only"; why: string };

/** Is the process behind an inbox-only recipient (a Claude Code session) there to read its inbox? */
export type InboxState = { state: "live"; waiter: boolean } | { state: "asleep"; why: string };

export type SendDeps = {
	/** Concord client, or undefined when the connection itself failed. */
	concord: { callTool: (name: string, args: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<{ structuredContent?: Record<string, unknown> }> } | undefined;
	pane: PaneDelivery;
	/**
	 * The Concord client for the recipient's own workspace, when that is not the sender's. A lane
	 * publishes its endpoint in the workspace it was launched into (`repoRoot` in its lifecycle
	 * record), which is the shared bus root unless the launch named another; asking the sender's
	 * workspace for it answers "Agent X is not registered" for ever. Undefined (or a rejection)
	 * leaves `concord`. Opened clients are closed with `dispose`.
	 */
	concordFor?: (laneId: string) => Promise<SendDeps["concord"]>;
	/** Closes what `concordFor` opened. */
	dispose?: () => Promise<void>;
	/** Used only when Concord answers "no prompt endpoint" for the recipient. */
	inbox?: InboxDelivery;
	/** Durable append-only log (one JSON object per attempt). */
	log: (record: SendLogRecord) => void;
	now?: () => Date;
	newKey?: () => string;
	/**
	 * Is this lane enrolled (does its card exist)? A lane is enrolled the moment
	 * the launch recipe writes the registry and the lane's card, but Concord only
	 * learns the agent when that lane's extension connects and publishes its
	 * endpoint (about a second later, TTL ~90 s). A send in that window answers
	 * "Agent X is not registered in this workspace" — the pane fallback then
	 * carries it, which is how the first live sends looked (2026-10-08).
	 */
	recipientEnrolled?: (laneId: string) => boolean;
	/** Sleep between those retries; tests inject it. */
	sleep?: (ms: number) => Promise<void>;
	/**
	 * Waits for proof that the lane took a message Concord accepted. A `queued`
	 * answer leaves it on Concord (one delivery per message id). Only `held` (the
	 * lane stopped writing its card) sends the message to the pane.
	 */
	confirmArrival?: (accepted: { laneId: string; messageId: string; acceptedAt: number }) => Promise<ArrivalProof>;
	/**
	 * Does this recipient never publish a Concord prompt endpoint (a Claude Code
	 * session, the Grokbot gateway)? Concord is not asked: the inbox carries the
	 * message. The answer is how the recipient reads its inbox, for the outcome text.
	 */
	endpointless?: (laneId: string) => string | undefined;
	/**
	 * Read-only. For a recipient that reads an inbox only at tool boundaries (a Claude Code
	 * session): is its process there, and is its waiter armed? Used for the outcome text only. A
	 * message to a Claude session is never delivered by stopping or resuming it (LD16).
	 */
	inboxState?: (laneId: string) => InboxState | undefined;
	/**
	 * A lane the tick parked has no process, no window and no endpoint, so no transport reaches
	 * it. Asked first: a parked Pi or OpenCode lane is relaunched with the text as its resume
	 * brief (lane lifecycle WP4); a parked Claude session answers `inbox-only`; `not-parked`
	 * leaves delivery to the transports below.
	 */
	resumeParked?: (request: { laneId: string; text: string }) => Promise<ParkedResumeResult>;
	/**
	 * Called once when a message was written to the inbox of a Claude lane whose process is gone (LD25).
	 * The wiring decides whether the lane may raise the ASLEEP event (`raiseAsleepEvent`); a failure here
	 * never changes the outcome.
	 */
	onAsleep?: (asleep: { laneId: string; why: string }) => void;
	/** Absolute path of a stored attachment's bytes, for the line a lane reads. Absent: the line carries the id only. */
	attachmentPath?: (attachmentId: string) => string | undefined;
	/**
	 * Called once after a message to the gateway agent was written to its inbox (the Henry wake,
	 * `grokbot-wake.ts`). It runs after the write and its failure is logged once, never an outcome.
	 */
	wakeGrokbot?: (wake: { messageId: string; firstLine: string; attachmentCount: number }) => Promise<void>;
	/**
	 * Ledger mode (LC13): Concord is not asked, so every lane takes the inbox branch, and a lane the
	 * pane can reach proves its arrival from its card — only a lane that stopped beating gets the
	 * message typed into its pane as well. A store error is never swallowed here: it goes to the
	 * process boundary (DL6), which the CLI turns into exit 75.
	 */
	ledgerMode?: boolean;
};

/** How long a sender waits for an idle lane to take an accepted message before calling it queued. */
export const ARRIVAL_TIMEOUT_MS = 60_000;
/** A card must be written this long after acceptance to count: the lane needs a moment to enqueue the hint. */
export const ARRIVAL_SETTLE_MS = 4_000;
export const ARRIVAL_POLL_MS = 1_000;

/**
 * Proof of arrival from the lane's card. Confirmed when a card written at least
 * `settleMs` after acceptance shows `pendingIn` 0; unverifiable when the card
 * publishes no pending count; held when the timeout passes with the count above
 * 0, or with no fresh card at all (a lane that stopped beating is not reading).
 * A beating lane that holds the message is `queued`: Concord's row is the one
 * delivery, and the lane reads it at its next turn end (2026-10-09, F2).
 */
export async function awaitLaneArrival(options: {
	laneId: string;
	acceptedAt: number;
	readCard: (laneId: string) => { updatedAt?: number; pendingIn?: number; state?: string } | undefined;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	timeoutMs?: number;
	pollMs?: number;
	settleMs?: number;
}): Promise<ArrivalProof> {
	const now = options.now ?? (() => Date.now());
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
	const timeoutMs = options.timeoutMs ?? ARRIVAL_TIMEOUT_MS;
	const pollMs = options.pollMs ?? ARRIVAL_POLL_MS;
	const settleMs = options.settleMs ?? ARRIVAL_SETTLE_MS;
	const deadline = options.acceptedAt + timeoutMs;
	let last: { updatedAt?: number; pendingIn?: number; state?: string } | undefined;
	for (;;) {
		last = options.readCard(options.laneId);
		if (last === undefined || typeof last.pendingIn !== "number") return { state: "unverifiable" };
		if (last.state === "gone") return { state: "held", detail: "the lane's card says it is gone" };
		const fresh = typeof last.updatedAt === "number" && last.updatedAt >= options.acceptedAt + settleMs;
		if (fresh && last.pendingIn === 0) return { state: "confirmed" };
		// A lane in a turn holds follow-ups until the turn ends. That is the normal case, not a
		// failure, so it is answered now. An idle lane that holds one is about to take it: wait.
		if (fresh && last.state !== "idle") return queuedProof(last);
		if (now() >= deadline) break;
		await sleep(pollMs);
	}
	const fresh = typeof last.updatedAt === "number" && last.updatedAt >= options.acceptedAt + settleMs;
	if (fresh) return queuedProof(last);
	return { state: "held", detail: "the lane wrote no card after the message was accepted" };
}

function queuedProof(card: { pendingIn?: number; state?: string }): ArrivalProof {
	return { state: "queued", detail: `the lane holds ${card.pendingIn} message(s) (state ${card.state ?? "unknown"}) and reads them when it is free` };
}

/** Bounded Concord retries for an enrolled lane whose endpoint is not live yet. */
export const CONCORD_RETRY_ATTEMPTS = 4;
export const CONCORD_RETRY_DELAY_MS = 2_000;
/** Concord's wording for "no live endpoint for that agent" (its own message is kept). */
const ENROLMENT_RACE = /not registered|unknown agent|not found/i;
/**
 * Concord's wording for "this agent has no prompt endpoint at all" — the lane
 * has nothing to publish because its harness never published one. That is the
 * one failure the pane cannot fix and the inbox can (2026-10-08).
 */
export const NO_PROMPT_ENDPOINT = /no prompt endpoint/i;

export type SendLogRecord = {
	at: string;
	laneId: string;
	mode: SendMode;
	transport: "concord" | "pane" | "inbox" | "resume";
	idempotencyKey: string;
	messageId?: string;
	status?: string;
	taskId?: string;
	reason?: string;
	command?: string;
	/** Set when the inbox carried it: the file the recipient will read. */
	path?: string;
	error?: string;
	/** Concord attempts made before the pane carried the message. */
	attempts?: number;
	/** Set when the Henry wake failed: the wake never changes the delivery outcome. */
	wake?: "failed";
};

export type SendOutcome =
	| { transport: "concord"; messageId: string; status: string; arrival?: "confirmed" | "unverifiable" | "queued" | "held"; arrivalDetail?: string }
	/** `inboxPath` is the file the reader finds; in ledger mode there is none, and `messageId` names the stored message. `ledger` marks a delivery Concord was not asked about. */
	| { transport: "inbox"; inboxPath?: string; messageId?: string; fallbackReason: string; queued?: "waiter" | "no-waiter" | "asleep"; asleepWhy?: string; ledger?: true }
	| { transport: "resume"; detail: string }
	| { transport: "pane"; fallbackReason: string; command: string; concordMessageId?: string; ledger?: true }
	| { transport: "none"; error: string; fallbackReason?: string };

/** One attempt key per send: a retry after failure must use a new key (Concord poisons failed keys). */
export function sendIdempotencyKey(request: SendRequest, newKey: () => string): string {
	return request.idempotencyKey ?? `muster-send/${request.laneId}/${newKey()}`;
}

/**
 * One plain line per attached file appended to the text. A lane reads the file from the absolute
 * path. The gateway agent gets the attachment id instead, because its files travel as links
 * (`attachment_link`) and a path on this machine means nothing to it.
 */
export function withAttachmentLines(request: SendRequest, deps: Pick<SendDeps, "attachmentPath">): string {
	if (request.attachments === undefined || request.attachments.length === 0) return request.text;
	const lines = request.attachments.map((file) => {
		const where = request.laneId === GATEWAY_AGENT_ID ? `id ${file.id}; download it with attachment_link` : (deps.attachmentPath?.(file.id) ?? `id ${file.id}`);
		return `Attached: ${file.name} (${formatAttachmentSize(file.size)}), ${where}`;
	});
	return `${request.text}\n\n${lines.join("\n")}`;
}

/**
 * Why the inbox carries the message in ledger mode (LC13): Concord is not asked at all, and a lane
 * whose harness reads an inbox says so. The reason is the send log's and the outcome's only; no
 * delivery decision depends on it.
 */
function ledgerInboxReason(laneId: string, inboxReader: string | undefined): string {
	const reader = inboxReader === undefined ? "" : `${laneId} reads its inbox with ${inboxReader}; `;
	return `${reader}ledger mode: Concord is not asked and the message goes to the inbox`;
}

/**
 * Deliver one message. Concord first; on a delivery failure the pane transport
 * runs unless the failure was the transport's absence itself, and the outcome
 * names which path carried it. Never throws for a delivery failure: the caller
 * prints the outcome and exits accordingly.
 *
 * In ledger mode (LC13) Concord is skipped, not deleted: the inbox owner carries every message and
 * the arrival proof decides about the pane, exactly as it does after Concord today.
 */
export async function deliverLaneMessage(request: SendRequest, deps: SendDeps): Promise<SendOutcome> {
	const now = (): Date => deps.now?.() ?? new Date();
	const key = sendIdempotencyKey(request, deps.newKey ?? (() => randomUUID()));
	// Every message to Henry is a wake, whatever mode the sender typed: his inbox is read only after a wake.
	const mode: SendMode = request.laneId === GATEWAY_AGENT_ID ? "wake" : request.mode;
	const base = { at: now().toISOString(), laneId: request.laneId, mode, idempotencyKey: key, ...(request.taskId !== undefined ? { taskId: request.taskId } : {}) };
	const text = withAttachmentLines(request, deps);

	const parked = await deps.resumeParked?.({ laneId: request.laneId, text }).catch((error: unknown): ParkedResumeResult => {
		// A store that is down is the process boundary's to report (DL6, LC13), not a parking failure:
		// `muster send` exits 75 with the reason instead of claiming it could not resume the lane.
		if (boundaryReason(error) !== undefined) throw error;
		return { state: "failed", reason: error instanceof Error ? error.message : String(error) };
	});
	if (parked?.state === "resumed") {
		deps.log({ ...base, transport: "resume", reason: "the lane was parked", command: parked.detail, path: parked.brief });
		return { transport: "resume", detail: `parked lane relaunched with ${parked.brief}: ${parked.detail}` };
	}
	if (parked?.state === "failed") {
		deps.log({ ...base, transport: "resume", reason: "the lane was parked", error: parked.reason });
		return { transport: "none", error: `${request.laneId} is parked and resuming it failed: ${parked.reason}` };
	}

	let concordError: string | undefined;
	let attempts = 0;
	/** A Claude session is never stopped or resumed to deliver (LD16): its message waits in the inbox for its waiter, its next tool step, or the next time it is opened. */
	let queued: "waiter" | "no-waiter" | "asleep" | undefined;
	let asleepWhy: string | undefined;
	/** LC13: in ledger mode Concord carries nothing, so every lane takes the inbox branch below. */
	const ledger = deps.ledgerMode === true;
	const inboxReader = deps.endpointless?.(request.laneId) ?? (parked?.state === "inbox-only" ? `\`muster wait --inbox ${request.laneId}\`` : undefined);
	/** A lane a pane can reach (Pi, OpenCode): an endpointless lane reads an inbox instead, and a parked Claude session is never typed into. In ledger mode this is the lane whose arrival the card proves. */
	const paneLane = inboxReader === undefined;
	/** The client of the workspace the recipient lives in: Concord is asked only for a lane that is neither endpointless nor in ledger mode. */
	const laneConcord = inboxReader === undefined && !ledger ? ((await deps.concordFor?.(request.laneId).catch((): undefined => undefined)) ?? deps.concord) : undefined;
	if (inboxReader !== undefined || ledger) {
		concordError = ledger
			? ledgerInboxReason(request.laneId, inboxReader)
			: `${request.laneId} has no prompt endpoint; it reads its inbox with ${inboxReader}`;
		let inbox: InboxState | undefined;
		// Only a lane that reads an inbox has a waiter state to word. In ledger mode this branch is
		// every lane's, and reading a Pi lane's state here would ask another owner for nothing.
		if (inboxReader !== undefined) {
			try {
				inbox = parked?.state === "inbox-only" ? { state: "asleep", why: `it is parked: ${parked.why}` } : deps.inboxState?.(request.laneId);
			} catch {
				// The state only words the outcome; a failed read leaves the message in the inbox all the same.
			}
		}
		if (inbox?.state === "live") queued = inbox.waiter ? "waiter" : "no-waiter";
		if (inbox?.state === "asleep") {
			queued = "asleep";
			asleepWhy = inbox.why;
		}
	} else if (laneConcord === undefined) {
		concordError = "no Concord connection for this repository";
	} else {
		const enrolled = deps.recipientEnrolled?.(request.laneId) ?? false;
		const maxAttempts = enrolled ? CONCORD_RETRY_ATTEMPTS : 1;
		const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			attempts = attempt;
			try {
				const result = await laneConcord.callTool(
					"update_work",
					{
						operation: "prompt",
						to_agent_id: request.laneId,
						content: text,
						idempotency_key: key,
						...(request.mode === "steer" ? { delivery_mode: "steer" } : {}),
						...(request.taskId !== undefined ? { task_id: request.taskId } : {}),
					},
					{ timeoutMs: 20_000 },
				);
				const messageId = result.structuredContent?.["message_id"];
				const status = result.structuredContent?.["status"];
				if (typeof messageId === "string" && messageId !== "") {
					const recorded: SendLogRecord = { ...base, transport: "concord", messageId, attempts, ...(typeof status === "string" ? { status } : {}) };
					deps.log(recorded);
					const accepted = { transport: "concord" as const, messageId, status: typeof status === "string" ? status : "unknown" };
					if (deps.confirmArrival === undefined) return accepted;
					const proof = await deps.confirmArrival({ laneId: request.laneId, messageId, acceptedAt: now().getTime() }).catch((): ArrivalProof => ({ state: "unverifiable" }));
					if (proof.state === "queued") return { ...accepted, arrival: "queued", arrivalDetail: proof.detail };
					if (proof.state !== "held") return { ...accepted, arrival: proof.state };
					// The lane stopped beating: nothing reads Concord's row, so the pane carries the message.
					const reason = `Concord accepted ${messageId} but ${proof.detail} after ${Math.round(ARRIVAL_TIMEOUT_MS / 1000)} s`;
					const typed = await deps.pane({ laneId: request.laneId, text }).catch(() => ({ ok: false, command: "pane delivery" }));
					if (typed.ok) {
						deps.log({ ...base, transport: "pane", messageId, reason, command: typed.command, attempts });
						return { transport: "pane", fallbackReason: reason, command: typed.command, concordMessageId: messageId };
					}
					deps.log({ ...base, transport: "pane", messageId, reason, command: typed.command, error: "pane delivery failed", attempts });
					return { ...accepted, arrival: "held", arrivalDetail: `${proof.detail}; the pane fallback failed too` };
				}
				concordError = "Concord returned no message id for the prompt";
			} catch (error) {
				concordError = error instanceof Error ? error.message : String(error);
			}
			// Only the enrolment race is worth waiting for: an enrolled lane whose
			// Concord endpoint has not been published yet registers within seconds.
			if (attempt < maxAttempts && ENROLMENT_RACE.test(concordError)) {
				await sleep(CONCORD_RETRY_DELAY_MS);
				continue;
			}
			break;
		}
	}
	if (concordError !== undefined && attempts > 1) {
		concordError = `${concordError} (after ${attempts} Concord attempts: the lane is enrolled, so its endpoint was not published yet)`;
	}

	// Inbox before pane: an agent with no prompt endpoint at all is not a lane
	// whose tmux window a pane fallback can reach (the orchestrator has no
	// window in session `pi`), and a durable file survives a restart.
	// LC13: in ledger mode the inbox carries every lane; in files mode only the failure the pane cannot fix.
	const inboxCarries = ledger || (concordError !== undefined && NO_PROMPT_ENDPOINT.test(concordError));
	if (inboxCarries && deps.inbox !== undefined) {
		let inbox: Awaited<ReturnType<InboxDelivery>>;
		try {
			inbox = await deps.inbox({
				laneId: request.laneId,
				text,
				idempotencyKey: key,
				mode,
				...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
				...(request.attachments !== undefined && request.attachments.length > 0 ? { attachments: request.attachments } : {}),
			});
		} catch (error) {
			// A store that is down is the process boundary's to report (DL6, LC13): `muster send` exits
			// 75 with the reason instead of reporting a failed delivery and trying the pane.
			if (boundaryReason(error) !== undefined) throw error;
			inbox = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		// In ledger mode there is no file: the owner returns the id it stored, which is proof enough.
		if (inbox.ok && (inbox.path !== undefined || inbox.messageId !== undefined)) {
			deps.log({ ...base, transport: "inbox", reason: concordError, ...(inbox.path !== undefined ? { path: inbox.path } : {}), ...(attempts > 0 ? { attempts } : {}) });
			// The Henry wake runs after the write. It is logged once on failure and never fails the send.
			if (request.laneId === GATEWAY_AGENT_ID && inbox.messageId !== undefined && deps.wakeGrokbot !== undefined) {
				try {
					await deps.wakeGrokbot({ messageId: inbox.messageId, firstLine: request.text.split("\n")[0] ?? "", attachmentCount: request.attachments?.length ?? 0 });
				} catch (error) {
					deps.log({ ...base, transport: "inbox", reason: "the Grok Bot wake failed", wake: "failed", error: error instanceof Error ? error.message : String(error) });
				}
			}
			if (queued === "asleep") {
				try {
					deps.onAsleep?.({ laneId: request.laneId, why: asleepWhy ?? "its process is gone" });
				} catch {
					// The event only wakes the orchestrator sooner; the message is already in the inbox.
				}
			}
			// LC13: in ledger mode a lane the pane can reach proves it took the message from its card.
			// Only a card that stopped beating gets it typed into the pane as well, exactly as after
			// Concord today; the inbox copy is written either way.
			if (ledger && paneLane && deps.confirmArrival !== undefined && inbox.messageId !== undefined) {
				const proof = await deps.confirmArrival({ laneId: request.laneId, messageId: inbox.messageId, acceptedAt: now().getTime() }).catch((): ArrivalProof => ({ state: "unverifiable" }));
				if (proof.state === "held") {
					const reason = `the inbox holds ${inbox.messageId} but ${proof.detail} after ${Math.round(ARRIVAL_TIMEOUT_MS / 1000)} s`;
					const typed = await deps.pane({ laneId: request.laneId, text }).catch(() => ({ ok: false, command: "pane delivery" }));
					if (typed.ok) {
						deps.log({ ...base, transport: "pane", messageId: inbox.messageId, reason, command: typed.command });
						return { transport: "pane", fallbackReason: reason, command: typed.command, ledger: true };
					}
					deps.log({ ...base, transport: "pane", messageId: inbox.messageId, reason, command: typed.command, error: "pane delivery failed" });
					return { transport: "inbox", ...(inbox.path !== undefined ? { inboxPath: inbox.path } : {}), messageId: inbox.messageId, fallbackReason: `${reason}; the pane fallback failed too`, ledger: true };
				}
			}
			return { transport: "inbox", ...(inbox.path !== undefined ? { inboxPath: inbox.path } : {}), ...(inbox.messageId !== undefined ? { messageId: inbox.messageId } : {}), fallbackReason: concordError ?? "the inbox carries the message", ...(queued !== undefined ? { queued } : {}), ...(asleepWhy !== undefined ? { asleepWhy } : {}), ...(ledger ? { ledger: true as const } : {}) };
		}
		concordError = `${concordError}; its inbox could not be written (${inbox.error ?? "unknown error"})`;
	}

	const pane = await deps.pane({ laneId: request.laneId, text }).catch((error: unknown) => ({
		ok: false,
		command: "pane delivery",
		detail: error instanceof Error ? error.message : String(error),
	}));
	if (pane.ok) {
		deps.log({ ...base, transport: "pane", reason: concordError, command: pane.command, ...(attempts > 0 ? { attempts } : {}) });
		return { transport: "pane", fallbackReason: concordError, command: pane.command };
	}
	deps.log({ ...base, transport: "pane", reason: concordError, command: pane.command, error: pane.detail ?? "pane delivery failed", ...(attempts > 0 ? { attempts } : {}) });
	return {
		transport: "none",
		error: `Concord could not deliver to ${request.laneId} (${concordError}) and the pane fallback failed (${pane.detail ?? "unknown error"})`,
		fallbackReason: concordError,
	};
}

/**
 * Concord starts every error of a workspace-routed call with a `Workspace: ws_<id> (<root>)`
 * line, and the reason follows on the next. Shown as it is, a send that arrived by inbox or
 * pane reads as "update_work failed: Workspace" (2026-10-11). The reason comes first and the
 * workspace root, which says which store answered, goes after it.
 */
export function readableConcordReason(reason: string): string {
	const match = /^(?:muster: \w+ failed: )?Workspace: ws_\S+ \((.*?)\)\n([\s\S]+)$/.exec(reason);
	return match === null ? reason : `${match[2]!.trim()} (Concord workspace ${match[1]})`;
}

/** Human text for one outcome. */
export function formatSendOutcome(outcome: SendOutcome, request: SendRequest): string {
	switch (outcome.transport) {
		case "concord":
			return `muster send: ${outcome.messageId} to ${request.laneId} via concord (${outcome.status})${outcome.arrival === "confirmed" ? ", lane took it" : outcome.arrival === "queued" ? `, queued: ${outcome.arrivalDetail ?? "the lane reads it when it is free"}` : outcome.arrival === "held" ? `, NOT taken: ${outcome.arrivalDetail ?? "held"}` : ""}`;
		case "resume":
			return `muster send: ${request.laneId} was parked, so it was relaunched with the message (${outcome.detail})`;
		case "inbox": {
			// In ledger mode there is no file to name; the message's own id is what the reader holds.
			const where = outcome.inboxPath ?? outcome.messageId ?? "";
			if (outcome.queued === "waiter") return `muster send: queued for ${request.laneId} (inbox; the lane's waiter wakes it): ${where}`;
			if (outcome.queued === "asleep") return `muster send: queued for ${request.laneId}. ${request.laneId} is asleep (${outcome.asleepWhy ?? "its process is gone"}). The message waits in its inbox and is read when the session is next opened. To wake a worker lane now: \`muster resume ${request.laneId}\`. ${where}`;
			if (outcome.queued === "no-waiter") return `muster send: queued for ${request.laneId} (inbox; no waiter is armed: a busy lane reads it at its next tool step, an idle one when it next runs): ${where}`;
			if (outcome.ledger === true) return `muster send: delivered to ${request.laneId} by its inbox${where === "" ? "" : ` (${where})`}`;
			return `muster send: delivered to ${request.laneId} by inbox (${where}); Concord cannot prompt it: ${readableConcordReason(outcome.fallbackReason)}`;
		}
		case "pane":
			if (outcome.ledger === true) return `muster send: delivered to ${request.laneId} by pane fallback (${outcome.command}); the message is also in its inbox: ${readableConcordReason(outcome.fallbackReason)}`;
			return `muster send: delivered to ${request.laneId} by pane fallback (${outcome.command}); ${outcome.concordMessageId === undefined ? "Concord could not carry it" : "Concord also has it queued"}: ${readableConcordReason(outcome.fallbackReason)}`;
		case "none":
			return `muster send: not delivered. ${outcome.error}`;
	}
}

/**
 * The fsynced append moved to `lib/core/append-line.ts` (send-back F2):
 * `lib/delegate-pool.ts` (routing) shares it and may not import Muster. It is
 * re-exported here so this module's callers keep their path.
 */
export { appendFsyncedLine };

/** Append one send-log record under `stateDir` (mode 0700, fsynced). */
export function appendSendLog(stateDir: string, record: SendLogRecord): void {
	// Ledger mode writes no send log: the ledger's `send` method appends the `SENT`
	// entry that replaces this line (LC9, §3.2). Files mode keeps the fsynced line.
	if (readBackend(stateDir) === "ledger") return;
	appendFsyncedLine(stateDir, SEND_LOG_FILE, `${JSON.stringify(record)}\n`);
}

/** The pane transport in this environment: Herdr's prompt for the lane's agent. */
export function herdrPaneDelivery(options: { bin?: string; spawn: (command: string, args: string[], timeoutMs: number) => Promise<{ exitCode: number | null; stdout: string; stderr: string }> }): PaneDelivery {
	const bin = options.bin ?? process.env.HERDR_BIN_PATH?.trim() ?? "herdr";
	return async ({ laneId, text }) => {
		const command = `${bin} agent prompt ${laneId} <text>`;
		const result = await options.spawn(bin, ["agent", "prompt", laneId, text], 30_000);
		if (result.exitCode === 0) return { ok: true, command };
		const detail = (result.stderr || result.stdout).trim().slice(-300);
		return { ok: false, command, exitCode: result.exitCode ?? undefined, detail: detail === "" ? `exit ${result.exitCode}` : detail };
	};
}

/**
 * The tmux pane transport: type the message into the lane's own window.
 *
 * A lane enrolled from tmux (session `pi`, window = lane name) has no Herdr
 * agent, so `herdr agent prompt` answers agent_not_found and the message never
 * arrives (measured on the first enrolled lane, 2026-10-08). tmux is the pane
 * this lane actually has.
 *
 * Two refusals protect the caller: the window must exist, and the target pane
 * must not be the pane the caller runs in.
 */
export function tmuxPaneDelivery(options: {
	session?: string;
	tmuxBin?: string;
	spawn: (command: string, args: string[], timeoutMs: number) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
}): PaneDelivery {
	const bin = options.tmuxBin ?? "tmux";
	return async ({ laneId, text }) => {
		const session = options.session ?? process.env.PI_LANES_TMUX_SESSION?.trim() ?? "pi";
		const target = `${session}:${laneId}`;
		const command = `${bin} send-keys -t ${target} <text> Enter`;
		const listed = await options.spawn(bin, ["list-panes", "-t", target, "-F", "#{pane_id}"], 10_000);
		const paneId = listed.stdout.trim().split("\n")[0] ?? "";
		if (listed.exitCode !== 0 || paneId === "") {
			return { ok: false, command, exitCode: listed.exitCode ?? undefined, detail: `no tmux window ${target}` };
		}
		const ownPane = process.env.TMUX_PANE?.trim();
		if (ownPane !== undefined && ownPane !== "" && ownPane === paneId) {
			return { ok: false, command, detail: `refusing to type into the caller's own pane ${paneId}` };
		}
		// One line only: a stray newline would submit the text in pieces.
		const oneLine = text.replace(/[\r\n]+/g, " ").trim();
		const typed = await options.spawn(bin, ["send-keys", "-t", target, "-l", "--", oneLine], 10_000);
		if (typed.exitCode !== 0) {
			const detail = (typed.stderr || typed.stdout).trim().slice(-300);
			return { ok: false, command, exitCode: typed.exitCode ?? undefined, detail: detail === "" ? `exit ${typed.exitCode}` : detail };
		}
		const submitted = await options.spawn(bin, ["send-keys", "-t", target, "Enter"], 10_000);
		if (submitted.exitCode !== 0) {
			return { ok: false, command, exitCode: submitted.exitCode ?? undefined, detail: `text typed but Enter failed in ${target}` };
		}
		return { ok: true, command };
	};
}
