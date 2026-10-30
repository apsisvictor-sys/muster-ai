/**
 * MG7 of the messaging agent (blueprint
 * `plans/orchestration-2026-10-05/specs/messaging-agent-blueprint-2026-10-25.md`, row MG7 and rules
 * G9 to G12): the words the Messages panel shows, in one place.
 *
 * The page paints these strings as text and words nothing itself, so the panel has one owner: a
 * state's wording is decided here, tested here, and the same line is what the operator reads. No line
 * holds an id, a chat id or a phone number: a WhatsApp chat id is a phone number (G11).
 *
 * Nothing here reads a file or calls a channel.
 */

/** A line's tone: the page paints a dot and a colour from it. */
export type PanelTone = "ok" | "attention" | "error";

/** One line of the panel's head: the connection strip. */
export type PanelStrip = { tone: PanelTone; text: string };

/** What one thread row says it is waiting for. */
export type PanelRowState = "draft" | "sending" | "sent" | "failed" | "unknown" | "needs-you";

export const NOTHING_WAITING = "Nothing is waiting";
export const NOT_CONNECTED = "WhatsApp is not connected";
export const LOGGED_OUT = "WhatsApp logged out: scan the QR";
export const NO_HISTORY = "Messages from before the link are not on this PC; only new ones arrive";

/** The clock the page shows, in the operator's zone: one formatter, so a line reads the same on the server and in a test. */
const CLOCK = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Sofia", hour: "2-digit", minute: "2-digit", hour12: false });

/** `14:07` for an ISO time, `--:--` for anything else. */
export function clockOf(iso: string): string {
	const at = new Date(iso);
	return Number.isNaN(at.getTime()) ? "--:--" : CLOCK.format(at);
}

/**
 * How long something waited, in two parts at most: `40 s`, `5 min`, `3 h`, `2 d`. A negative span
 * (a channel clock slightly ahead of this machine) reads as `0 s`.
 */
export function ageOf(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds} s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h`;
	return `${Math.round(hours / 24)} d`;
}

/**
 * The connection strip (blueprint §3.4). `loggedOut` is the open `human-login` ask the sync raises
 * when the session leaves WORKING (G13), and `lastAt` is when the archive last took a record in.
 * Nothing is claimed about a session while that ask is open, and nothing is claimed when the archive
 * has never taken anything: "connected" needs evidence.
 */
export function healthStrip(health: { loggedOut: boolean; lastAt: string | null }, at: Date): PanelStrip {
	if (health.loggedOut) return { tone: "attention", text: LOGGED_OUT };
	if (health.lastAt === null) return { tone: "error", text: NOT_CONNECTED };
	const age = at.getTime() - Date.parse(health.lastAt);
	return { tone: "ok", text: `WhatsApp connected · last message ${ageOf(Number.isNaN(age) ? 0 : age)} ago` };
}

/** The channel's delivery mark in the panel's words; null when the mark is not one it knows. */
const DELIVERY: Readonly<Record<string, string>> = { sent: "sent", server: "delivered", device: "delivered", delivered: "delivered", read: "read" };

function deliveryOf(ack: string | null): string | null {
	if (ack === null) return null;
	return DELIVERY[ack.trim().toLowerCase()] ?? null;
}

/** One row's one line (blueprint §3.1 and §3.3): no id, no text, the same words every time. */
export function rowLine(row: { state: PanelRowState; at: string | null; ack: string | null; reason: string | null }): string {
	switch (row.state) {
		case "draft":
			return "Draft ready";
		case "sending":
			return "Sending";
		case "sent": {
			const mark = deliveryOf(row.ack);
			return `Sent${row.at === null ? "" : ` ${clockOf(row.at)}`}${mark === null ? "" : ` · ${mark}`}`;
		}
		case "failed": {
			const reason = (row.reason ?? "").trim();
			return reason === "" ? "Failed" : `Failed · ${reason.slice(0, 60)}`;
		}
		case "unknown":
			return "Not sure this was sent · check the chat";
		case "needs-you":
			return "Needs you, no draft";
	}
}

/**
 * What the empty list says: the notice while the archive holds nothing, otherwise that nothing waits.
 * A list with rows says nothing here (the rows speak).
 */
export function emptyLine(list: { rows: number; history: boolean }): string | null {
	if (list.rows > 0) return null;
	return list.history ? NOTHING_WAITING : NO_HISTORY;
}

/** The preview of a message in the list: one line, cut, never a wall of chat text. */
export function previewOf(text: string | null | undefined, max = 90): string | null {
	if (typeof text !== "string") return null;
	const line = text.replace(/\s+/g, " ").trim();
	if (line === "") return null;
	return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}
