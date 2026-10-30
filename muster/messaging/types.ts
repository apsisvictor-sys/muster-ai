/**
 * MG1 of the messaging agent (VR24-62, blueprint
 * `plans/orchestration-2026-10-05/specs/messaging-agent-blueprint-2026-10-25.md`,
 * rule G1): the one channel port, and the shapes a channel hands the archive.
 *
 * The port is types only. WhatsApp (MG2) and Viber (MG16/MG9) implement it, and
 * nothing above it — archive, index, triage, drafts, approval, the send gate —
 * is written twice for a second channel. A pulled item is kept as the channel
 * gave it: `payload` is the channel's own object, never a re-rendering of it, so
 * a field this module does not understand is still in the archive.
 *
 * Chat text is data (MS4): nothing here interprets a body as an instruction.
 */

/** A channel's stable name, used in the archive record and the idempotency key. */
export type ChannelId = string;

/** The channel's own place in its message stream; `null` means "from the beginning". */
export type Cursor = string | null;

/**
 * How a message reached the archive. `vision` marks a message a Viber adapter read
 * from a screenshot: the transcript is lossy, so search has to say so (G2).
 */
export type MessageSource = "channel" | "vision";

/** Bytes the archive copies out of the channel's prunable cache, plus what they are. */
export type MediaBlob = { bytes: Uint8Array; mime?: string; filename?: string };

/** One message as the channel gave it. */
export type ChannelMessage = {
	/** The chat id exactly as the channel sent it, `@c.us`, `@lid`, `@g.us` and so on. */
	chatId: string;
	/** The channel's message id: stable inside the chat, unique inside a thread. */
	messageId: string;
	/** The channel's own timestamp, epoch milliseconds. */
	timestamp: number;
	/** True for a message this account sent. */
	fromMe: boolean;
	senderId?: string;
	/** The channel's message kind (`chat`, `image`, `ptt`, `call_log`, …). */
	type: string;
	/** The plain text the channel holds, when it holds one. */
	text?: string;
	/** The channel's full object, kept verbatim (G2: what was read is kept whole). */
	payload: unknown;
	source?: MessageSource;
	media?: MediaBlob;
};

/**
 * The changes a channel reports about a message it already delivered: an edit, a
 * deletion, a revoke, the delivery mark of a message this account sent (G3: the sync
 * re-reads the last day of sent messages and appends each mark change as one `ack`
 * event, the value itself in the event's own payload), and the bytes a message's media
 * never gave (G2 amended, VR24-70: the message is archived without them and one
 * `media-missing` event carries a reason code, never content).
 */
export type ChannelEventKind = "edited" | "deleted" | "revoked" | "ack" | "media-missing";

/**
 * A change to a message already pulled. It is an event of its own: the original
 * message keeps its text, and search still finds what was said first (G2).
 */
export type ChannelEvent = {
	chatId: string;
	/** The message the event is about. */
	messageId: string;
	event: ChannelEventKind;
	/** When the channel reported the change (ISO 8601). */
	at: string;
	/** The replacement text of an edit; the event's own payload carries the rest. */
	text?: string;
	payload?: unknown;
};

/**
 * One entry of the channel's contact list. `aliases` holds the other id forms the
 * list itself shows for the same person — the only evidence that maps `@lid` onto
 * `@c.us` — and `name` is the name the list holds, never one taken from message text.
 */
export type ChannelContact = { contactId: string; aliases?: string[]; name?: string; payload: unknown };

/** The channel session's state, as `health()` reports it (G13). */
export type HealthState = "working" | "scan-qr" | "failed" | "stopped" | "unknown";

export type Health = {
	state: HealthState;
	/** When the channel answered, ISO 8601. */
	checkedAt: string;
	detail?: string;
};

/**
 * What one send attempt did (G8). `failed` means nothing left the account and a
 * retry is safe; `unknown` means the process cannot tell, so nothing retries it.
 */
export type SendOutcome = {
	state: "sent" | "failed" | "unknown";
	/** When the attempt ended, ISO 8601. */
	at: string;
	/** The channel's id for the sent message, when it gave one. */
	messageId?: string;
	/** The channel's delivery mark (`SERVER`, `DEVICE`, `READ`, …), when it gave one. */
	ack?: string;
	reason?: string;
};

/**
 * The exact text the operator approved, and the thread it belongs to. The send gate
 * recomputes `hash` from the stored draft before it calls `send` (G8 step 2), and
 * the recipient is this stored `chatId`: no model output selects it.
 */
export type ApprovedDraft = {
	draftId: string;
	chatId: string;
	text: string;
	hash: string;
};

/** One poll's worth of data: what the channel has, and where to continue from. */
export type PullResult = {
	messages: ChannelMessage[];
	cursor: Cursor;
	/** Edits, deletions and revokes the channel reported since the cursor (G2). */
	events?: ChannelEvent[];
	/** The contact list, read once a day rather than every poll (G3, G4). */
	contacts?: ChannelContact[];
};

/** A channel call may be answered synchronously (a test double) or by I/O (WAHA). */
export type Awaitable<T> = T | Promise<T>;

/**
 * G1: one port, three calls. `pull` reads from a cursor, `send` posts one approved
 * draft, `health` reports the session. Nothing else is a channel.
 */
export interface ChannelAdapter {
	readonly id: ChannelId;
	pull(cursor: Cursor): Awaitable<PullResult>;
	send(approvedDraft: ApprovedDraft): Awaitable<SendOutcome>;
	health(): Awaitable<Health>;
}

/**
 * One fresh read of one chat, straight from the channel and not from the archive (G8 step 4):
 * the messages the channel holds now, and the edits or revokes it reports against them. The
 * send gate asks this just before it sends, so the sync's lag cannot hide a newer message.
 */
export type ChatRead = {
	messages: ChannelMessage[];
	events: ChannelEvent[];
};

/** The second port the send gate needs besides `ChannelAdapter`: a read of this one chat. */
export interface ChatReader {
	readChat(chatId: string): Awaitable<ChatRead>;
}

