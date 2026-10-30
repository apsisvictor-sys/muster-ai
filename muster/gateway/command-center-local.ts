/**
 * The command center's loopback listener (VR24-74, blueprint WP1c points 1 to 3).
 *
 * the operator opens the full page on the PC at `http://localhost:<CC_LOCAL_PORT>/cc/`. Lanes run on the same PC and can call
 * anything this listener serves, so it can read and can not act:
 *
 * - It serves the page, the assets and the read routes from the same functions as the tailnet listener (`serveRead`).
 * - It carries no message-thread text, draft text or contact name. Any panel outside `LOOPBACK_PANELS` is cut to its counts.
 *   `/cc/api/messages` is not a read route, so it is 404 here, and a message action is not in `ACT_ACTIONS`, so it is 400.
 * - R2 (VR24-82): a session that handles chat text is withheld from the loopback `feed` by default (`feedWithheld`, `CHAT_TEXT_LANE`).
 * - A POST to `/cc/api/act` runs nothing. It files a pending action (`command-center-pending.ts`), answers 202 with the id,
 *   and the action runs only when the operator taps Confirm on the phone (`/cc/api/confirm/<id>`, tailnet listener only).
 * - It trusts no client header: there is no identity here, and a `Tailscale-User-Login` header changes nothing.
 * - No CORS header is ever sent.
 *
 * Order of refusals, each one audited: a Host other than `localhost:<port>` or `127.0.0.1:<port>` (closes DNS rebinding), the
 * off switch, the path and method, then for a POST the JSON content type, an Origin equal to the listener's own and the per-load
 * CSRF token. `server.ts` binds it to 127.0.0.1 and nothing else.
 */

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
	ACT_ACTIONS,
	CC_ACT_PATH,
	CSRF_HEADER,
	csrfToken,
	csrfValid,
	json,
	loadPage,
	readActBody,
	readRouteOf,
	serveRead,
	type CommandCenterHandlerHooks,
	type CommandCenterState,
	type FeedReader,
	type PanelResult,
	type ReportReader,
} from "./command-center.ts";
import type { PendingPcView, PendingStore } from "./command-center-pending.ts";
import type { LiveHub } from "./command-center-live.ts";

/**
 * The panels whose text comes from the ledger, the lanes, the desk or the machine. Every other panel (the messaging ones, MG7) is cut to counts here.
 * D30 and D45: `activity`, `usage` and `history` join the list in the packages that add them.
 */
export const LOOPBACK_PANELS: readonly string[] = ["lanes", "machine", "decisions", "delivery", "goals", "team", "shipped", "next", "ideas", "pendingPc", "activity", "usage", "history", "scrum"];
/** What the PC page shows in place of a withheld panel's text. */
export const OPEN_ON_PHONE = "open on the phone";
/**
 * Lanes named for the messaging work. Their live session may hold chat text, so the loopback feed never serves them, whatever
 * else is registered (`feedWithheld`). Any other lane that will handle chat text is registered by the composition root.
 */
export const CHAT_TEXT_LANE = /^(?:msg|messaging)(?:[-_.].*)?$/i;

export type LoopbackListener = {
	/** 0 picks a free port (tests). */
	port: number;
	state: () => Promise<CommandCenterState>;
	/** D30: the process's one live hub, the same one the tailnet listener serves. */
	live?: LiveHub;
	feed?: FeedReader;
	report?: ReportReader;
	pending: PendingStore;
	/** R2: true for a lane (or seat role) whose session handles chat text; its feed is withheld here. Read on every request. */
	feedWithheld?: (lane: string) => boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A panel's `counts` when it has numbers to show; nothing else of it leaves. */
function countsOf(data: unknown): Record<string, number> {
	const counts = isRecord(data) && isRecord(data["counts"]) ? data["counts"] : {};
	return Object.fromEntries(Object.entries(counts).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
}

/**
 * The state as the loopback listener serves it: the listed panels as they are, the pending PC actions without their payload, and
 * every other panel as `{openOnPhone, counts}`. A new panel is withheld until it is listed, never served by default.
 *
 * The loopback listener serves no message text: `/cc/api/messages` is not a read route, so it answers 404 here. The state
 * says so (`countsOnly`), and the page asks for that route only when a listener serves it (D2).
 *
 * `withheld` is the feed's own rule (R2 of VR24-82): a lane whose session handles chat text loses `lastMessage` here, so the PC
 * page carries no message text it withholds in the feed.
 */
export function loopbackState(state: CommandCenterState, withheld?: (lane: string) => boolean): CommandCenterState {
	// The live stream's ping frame carries no panels (2026-10-27: it crashed the gateway). Only its time passes, so a
	// frame of any other shape without panels stays withheld, as a new panel is.
	if (!isRecord(state.panels)) return { at: (state as unknown as { at?: unknown }).at } as unknown as CommandCenterState;
	const panels: Record<string, PanelResult<unknown>> = {};
	for (const [name, panel] of Object.entries(state.panels) as [string, PanelResult<unknown>][]) {
		if (name === "pendingPc") {
			const rows = Array.isArray(panel.data) ? (panel.data as PendingPcView[]).map((row) => ({ id: row.id, kind: row.kind, createdAt: row.createdAt, expiresAt: row.expiresAt })) : null;
			panels[name] = { readAt: panel.readAt, error: panel.error, data: rows };
		} else if (name === "activity" && withheld !== undefined) {
			const rows = (panel.data ?? {}) as Record<string, { lastMessage: string | null; lastActivityMs: number | null; contextPercent: number | null }>;
			const cut: typeof rows = {};
			for (const [lane, row] of Object.entries(rows)) cut[lane] = withheld(lane) ? { ...row, lastMessage: null } : row;
			panels[name] = { readAt: panel.readAt, error: panel.error, data: cut };
		} else if (LOOPBACK_PANELS.includes(name)) panels[name] = panel;
		else panels[name] = { readAt: panel.readAt, error: null, data: { openOnPhone: true, note: OPEN_ON_PHONE, counts: countsOf(panel.data) } };
	}
	return { ...state, countsOnly: true, panels: panels as unknown as CommandCenterState["panels"] };
}

export function createLoopbackHandler(options: LoopbackListener, hooks: CommandCenterHandlerHooks): (req: IncomingMessage, res: ServerResponse, port: number) => Promise<void> {
	// Its own secret: a token from the tailnet listener opens nothing here, and the reverse.
	const secret = randomBytes(32);
	const pageSource = loadPage();
	const feedIsWithheld = (lane: string): boolean => CHAT_TEXT_LANE.test(lane) || (options.feedWithheld?.(lane) ?? false);
	// R2: the withheld lanes answer 404, the same answer a lane that does not exist gets, so the feed does not say which lanes hold chat text.
	const feed: FeedReader | undefined =
		options.feed === undefined
			? undefined
			: async (query) => {
					if (feedIsWithheld(query.lane)) return undefined;
					return options.feed!(query);
				};
	/** D30: the activity panel drops the withheld lanes' last message, the rule the feed already applies. */
	const withheldOf = (lane: string): boolean => feedIsWithheld(lane);

	return async (req, res, port) => {
		const pathname = req.url?.split("?")[0] ?? "";
		const refuse = (status: number, reason: string): void => {
			hooks.refusal({ method: req.method, path: pathname, listener: "cc-local" }, reason);
			json(res, status, { error: reason });
		};
		const host = req.headers.host?.toLowerCase();
		if (host !== `localhost:${port}` && host !== `127.0.0.1:${port}`) return refuse(403, "host not allowed");
		if (hooks.isOff()) return refuse(503, "gateway is off");

		const route = readRouteOf(pathname);
		const isAct = pathname === CC_ACT_PATH;
		if (route === undefined && !isAct) return refuse(404, "not found");
		if (req.method !== (isAct ? "POST" : "GET")) return refuse(405, "method not allowed");
		// A page loaded from this listener sends its own origin. A foreign one is refused on a GET too; a POST must carry it.
		const origin = req.headers.origin;
		const own = `http://${host}`;
		if (origin !== undefined && !(typeof origin === "string" && origin.toLowerCase() === own)) return refuse(403, "origin not allowed");

		if (route !== undefined) return serveRead(route, req, res, pathname, { page: pageSource, csrf: csrfToken(secret, "loopback"), state: options.state, live: options.live, feed, report: options.report, shapeState: (state) => loopbackState(state, withheldOf), refuse });

		// POST /cc/api/act: filed, never run.
		if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) return refuse(403, "content type must be application/json");
		if (origin === undefined) return refuse(403, "origin not allowed");
		const sent = req.headers[CSRF_HEADER];
		if (!csrfValid(secret, "loopback", typeof sent === "string" ? sent : undefined)) return refuse(403, "csrf token missing or invalid");
		const raw = await readActBody(req);
		if (raw === undefined) return refuse(413, "request too large");
		let body: unknown;
		try {
			body = JSON.parse(raw);
		} catch {
			return refuse(400, "request is not JSON");
		}
		if (!isRecord(body) || typeof body["action"] !== "string" || !(ACT_ACTIONS as readonly string[]).includes(body["action"])) return refuse(400, `action must be one of ${ACT_ACTIONS.join(", ")}`);
		const filed = options.pending.create(body);
		if (!filed.ok) return refuse(filed.status, filed.error);
		// The line names the kind, the source and the pending id, never the payload.
		try {
			hooks.audit("(cc:pending)", { action: filed.kind, source: "pc", pending: filed.id, ...(filed.replaced !== null ? { replaced: filed.replaced } : {}) }, null, false);
		} catch {
			options.pending.reject(filed.id);
			json(res, 500, { error: "gateway error" });
			return;
		}
		json(res, 202, { pending: true, id: filed.id, kind: filed.kind, expiresAt: filed.expiresAt, message: "Waiting for your tap on the phone" });
	};
}
