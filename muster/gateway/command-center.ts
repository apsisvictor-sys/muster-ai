/**
 * The command center (VR24-21, blueprint `command-center-blueprint-2026-10-22.md`, WP1a: the backend).
 *
 * One page for the operator over his tailnet only. It runs inside the gateway process on a second listener
 * that `server.ts` binds to the PC's tailnet address and that serves only `/cc/` (the page, `command-center-page.html`),
 * `/cc/assets/` (the vendored design library and its README, `cc-assets/`), `/cc/api/state`, `/cc/api/act`, `/cc/api/feed` and `/cc/api/report`. This file owns what
 * that listener does: who may ask (tailscaled `whois` on the peer address, no client header trusted),
 * the state composer `commandCenterState()` (four panels, each with `readAt` and `error`), and the
 * three safe actions behind `/cc/api/act`. Every panel calls its existing owner; nothing here
 * re-implements one.
 *
 * Order of refusals on the listener, each one audited: a Host that is not the listener's own, the off
 * switch (503), the peer's login, then its node (403: never the gateway's own node, only a listed one), the path and method, then for a POST the JSON content type,
 * a same-origin `Origin` and the per-load CSRF token.
 *
 * WP1c (VR24-74): the same page and read routes are also served on a loopback listener (`command-center-local.ts`)
 * that runs no action: a POST to act there becomes a pending action (`command-center-pending.ts`), and
 * `POST /cc/api/confirm/<id>` on this listener, behind the same whois and CSRF checks, runs it through the same
 * `act` a direct tap calls. This listener can also terminate TLS itself (`tls`, `command-center-tls.ts`).
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readActiveScopeUnits, laneScopeAlive } from "../lib/lane-directory.ts";
import { newerLaneReport, type LaneCard } from "../lib/lane-card.ts";
import { redactSensitiveText } from "../../core/self-improving-redactor.ts";
import { AskStateError, SITTING_KINDS, answerAskResult, askCodeOf, askVersion, orderAsksForOperator, readAsks, recommendedOption, regenerateOperatorList, type Ask, type AskRelay } from "../asks.ts";
import { CARD_ID_PATTERN, CARD_TAPS, DeskRefusal, DeskStateError, cardsForPage, readDesk, reportFileFor, researchRoot, tapCard, type DeskDeliver, type DeskTarget, type IdeasPanel } from "../research-desk.ts";
import { resolveSeatRole, seatHeldBy, seatHolderLanes } from "../seats.ts";
import { operatorSessionRefusal } from "../lib/lane-control.ts";
import { briefOutcome, laneTranscriptTail, readLaneBriefs, SESSION_MESSAGES_DEFAULT, type LaneTail, type OversightToolDeps } from "./oversight.ts";
import { deliverLaneMessage } from "../send.ts";
import type { TlsFiles } from "./command-center-tls.ts";
import type { PendingPcView, PendingStore, PendingView } from "./command-center-pending.ts";
import { laneSendDeps, type LaneSendPorts } from "../send-deps.ts";
import { CC_AGENT_ID, GATEWAY_AGENT_ID, PAGE_CALLER } from "./state.ts";
import { ID_LINE_PREFIX, LANE_ID, MAX_MESSAGE_CHARS, MESSAGE_TO_LINES, inboxSender } from "./tools.ts";

import { readLaneRecord, type LaneRecord } from "../lane-lifecycle.ts";
import { LANE_HEALTH_LABELS, LANE_STAGES, LANE_STAGE_LABELS, laneHealth, laneStage, roundsOf, type LaneHandoff, type LaneHealth, type LaneStageOrOff } from "../lane-stage.ts";
import type { InboxMessage } from "../lib/agent-inbox.ts";
import type { ProjectCatalogue } from "../projects.ts";
import type { LaneHistoryEntry } from "./lane-history.ts";
import {
	REUSE_MS,
	buildGoals,
	buildHistoryPanel,
	buildNext,
	buildContracts,
	buildShipped,
	buildSummary,
	buildTeam,
	buildUsage,
	localMidnight,
	readHenryMessages,
	reusing,
	timerUnitsOf,
	workerRows,
	type GoalSource,
	type GoalsPanel,
	type ContractsPanel,
	type HistoryPanel,
	type NextPanel,
	type ShippedPanel,
	type SummaryData,
	type TeamPanel,
	type TimerInfo,
	type UsagePanel,
} from "./command-center-panels.ts";
import { createLiveHub, ledgerWakeSource, PANEL_NAMES, type LiveHub, type LiveWake, type PanelName } from "./command-center-live.ts";
import { laneOutcomesPath, readLaneOutcomes, type LaneOutcomesRead } from "../lane-outcomes.ts";
import { listWorkItems, workItemStore, workItemsDir, type WorkItemRecord } from "../work-items.ts";
import { buildScrumPanel, type ScrumPanel } from "./command-center-scrum.ts";
import { readUsageSnapshot, usageSnapshotPath, type UsageSnapshot } from "../bin/usage-snapshot.mts";
import { loadPoolConfig, providerOf, readRoutingSnapshot, type PoolRouting, type RoutingSnapshot } from "../../routing/provider-pool.ts";
import { loadSubscriptionPlans, type SubscriptionPlan } from "../../routing/subscriptions.ts";
import { piAgentDir, piPort } from "../../core/pi-ports.ts";
import { waitingOnOperator, type AskQueue } from "../asks.ts";

export { CC_AGENT_ID, PAGE_CALLER };

export const CC_PREFIX = "/cc/";
export const CC_STATE_PATH = "/cc/api/state";
export const CC_ACT_PATH = "/cc/api/act";
export const CC_ASSETS_PATH = "/cc/assets/";
/** WP1c: `POST /cc/api/confirm/<id>` and `POST /cc/api/reject/<id>`, on the tailnet listener only. */
export const CC_CONFIRM_PREFIX = "/cc/api/confirm/";
export const CC_REJECT_PREFIX = "/cc/api/reject/";
/** The actions `act` runs; the loopback listener files each of them as a pending action instead. */
export const ACT_ACTIONS = ["stop", "pause", "resume", "answer", "card", "message"] as const;
export const CC_FEED_PATH = "/cc/api/feed";
/** D30: the live stream, a read route on both listeners, `text/event-stream`. */
export const CC_LIVE_PATH = "/cc/api/live";
/**
 * MG6 (G11): `GET /cc/api/messages`, the waiting drafts with their text. A route of the tailnet listener only: it is not a read
 * route (`readRouteOf`), so the loopback listener, which serves every read route, answers 404 for it.
 */
export const CC_MESSAGES_PATH = "/cc/api/messages";
/**
 * MG6: the actions on a waiting draft. They run on the tailnet listener only. They are not in `ACT_ACTIONS`, so the loopback
 * listener refuses them with 400 and files no pending action: a tap that approves a send is the operator's own, on the page, with
 * the text in front of him, and never a confirm of something a process on the PC filed.
 *
 * MG7 adds `msg-edit-send` (the operator's own text, one request: the draft, its ask and the tap as `operator-page`) and `msg-redraft`
 * (the writer is asked for a new draft of that thread; nothing is sent). Neither is a second send route: the action builds the
 * draft and answers its ask on the page's path, and the send gate stays the only code that sends.
 */
export const MESSAGE_ACTIONS = ["msg-send", "msg-drop", "msg-edit-send", "msg-redraft"] as const;
/** D21: `GET /cc/api/report?card=<id>` serves the report attached to that card. */
export const CC_REPORT_PATH = "/cc/api/report";
/** The most messages one feed read returns: `session_read`'s range. */
export const CC_FEED_LIMIT_MAX = 50;
export const CSRF_HEADER = "x-cc-csrf";
export const TAILSCALE_SOCKET = "/var/run/tailscale/tailscaled.sock";
/** An ask this old gets a red age (blueprint §4: "if it stays for 2 or 3 days, I know its open for my decision"). */
export const STALE_ASK_MS = 2 * 24 * 60 * 60 * 1000;
const MAX_ACT_BODY_BYTES = 16 * 1024;
/** MG7: the longest one-line instruction a redraft carries to the writer. */
export const MAX_INSTRUCTION_CHARS = 500;
const WHOIS_TIMEOUT_MS = 3_000;
const GATE_TIMEOUT_MS = 10_000;

// ─── Who is asking: tailscaled's own answer ────────────────────────────────

export type WhoisIdentity = { login: string; /** tailscaled's stable node id of the peer's machine. */ nodeId: string };
/** Asks tailscaled who the peer at this address and port is; undefined for anything it cannot name. */
export type Whois = (remoteAddress: string, remotePort: number) => Promise<WhoisIdentity | undefined>;

function localApi(socketPath: string, path: string, timeoutMs: number): Promise<unknown> {
	return new Promise((resolveCall, rejectCall) => {
		const req = httpRequest({ socketPath, path, method: "GET", headers: { host: "local-tailscaled.sock" }, timeout: timeoutMs }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => {
				if (res.statusCode !== 200) return rejectCall(new Error(`tailscaled answered ${res.statusCode}`));
				try {
					resolveCall(JSON.parse(Buffer.concat(chunks).toString("utf8")));
				} catch (error) {
					rejectCall(error);
				}
			});
		});
		req.on("timeout", () => req.destroy(new Error("tailscaled did not answer in time")));
		req.on("error", rejectCall);
		req.end();
	});
}

/** The Tailscale LocalAPI `whois` on the peer's address: the user login and the stable node id. A tagged node has no user login and is never named. */
export function tailscaleWhois(socketPath: string = TAILSCALE_SOCKET, timeoutMs: number = WHOIS_TIMEOUT_MS): Whois {
	return async (remoteAddress, remotePort) => {
		try {
			const addr = remoteAddress.includes(":") ? `[${remoteAddress}]:${remotePort}` : `${remoteAddress}:${remotePort}`;
			const answer = (await localApi(socketPath, `/localapi/v0/whois?addr=${encodeURIComponent(addr)}`, timeoutMs)) as { Node?: { StableID?: unknown }; UserProfile?: { LoginName?: unknown } } | null;
			const login = answer?.UserProfile?.LoginName;
			const nodeId = answer?.Node?.StableID;
			return typeof login === "string" && login !== "" && typeof nodeId === "string" && nodeId !== "" ? { login, nodeId } : undefined;
		} catch {
			return undefined;
		}
	};
}

/** This machine's tailnet address (IPv4), stable node id and MagicDNS name, from tailscaled; undefined when tailscaled cannot say. */
export async function readTailnetSelf(socketPath: string = TAILSCALE_SOCKET, timeoutMs: number = WHOIS_TIMEOUT_MS): Promise<{ address: string; nodeId: string; dnsName?: string } | undefined> {
	try {
		const status = (await localApi(socketPath, "/localapi/v0/status", timeoutMs)) as { Self?: { ID?: unknown; TailscaleIPs?: unknown; DNSName?: unknown } } | null;
		const ips = Array.isArray(status?.Self?.TailscaleIPs) ? (status!.Self!.TailscaleIPs as unknown[]) : [];
		const address = ips.find((ip): ip is string => typeof ip === "string" && /^100\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip));
		const nodeId = status?.Self?.ID;
		if (address === undefined || typeof nodeId !== "string" || nodeId === "") return undefined;
		const dns = typeof status?.Self?.DNSName === "string" ? status.Self.DNSName.replace(/\.$/, "").toLowerCase() : "";
		return { address, nodeId, ...(dns !== "" ? { dnsName: dns } : {}) };
	} catch {
		return undefined;
	}
}

// ─── The state composer ────────────────────────────────────────────────────

/** One panel: when it was read, why it could not be, and its data. A failed owner leaves the other panels alone. */
export type PanelResult<T> = { readAt: string; error: string | null; data: T | null };

export type LaneRow = {
	laneId: string;
	harness: string;
	model: string | null;
	/** D32: the model's display name, from Pi's own registry, or the part of the ref after the slash. */
	modelName: string | null;
	/** D27: what the lane delivers, in plain words. The brief's outcome line, then the lane id, for an older record. */
	title: string;
	/** D26: where the lane stands on the board. */
	stage: LaneStageOrOff;
	/** D26: a flag beside the stage, never a stage. */
	alreadyDone: boolean;
	/** D26: how the lane is doing, independent of its stage. */
	health: LaneHealth;
	/** D28: the first line of the lane's latest report, capped at 140 characters. */
	now: string | null;
	/** D32: the goal that holds this lane, from the goal registry's attachments. */
	goal: string | null;
	/** D32: the station of that goal the lane sits at. */
	station: string | null;
	/** D27: every `sent-back` handoff on the record. */
	rounds: number;
	/** D27: what an accepted handoff waits for, when the orchestrator named it. */
	waits: string | null;
	/** D32: the lane's class from its record. */
	class: string | null;
	/** D32: what the lane does, from its record. */
	taskKind: string | null;
	/** D27: the handoffs, oldest first, for the sheet's timeline. */
	handoffs: LaneHandoff[];
	state: string;
	phase: string | null;
	origin: string | null;
	alive: boolean | null;
	/** Epoch ms the lane entered its state (the card's `since`). */
	since: number | null;
	branch: string | null;
	/** The first line of the lane's newest brief outcome, when a brief is on file. */
	brief: string | null;
	/** The lane card's own STALLED rule (`lane-directory`). */
	stalled: boolean;
	/** Epoch ms the lane was launched (the lane record's `launchedAt`); null when no record says. */
	startedAt: number | null;
	/** The lane's own last report, from its card. */
	report: { kind: string; summary: string; at: number | null } | null;
	/** Closed, with its launcher scope still alive: the one lane the page may stop. */
	leftover: boolean;
	canStop: boolean;
	/** D7: a stalled, quota-walled, blocked or leftover lane shows its state in words in the attention tone, never red. */
	tone: "attention" | null;
	reason: string | null;
};
export type LanesPanel = { rows: LaneRow[]; hiddenGone: number };

/**
 * D30: the three volatile lane fields move here, so a chatty lane does not resend the board. One entry per lane
 * the directory lists, keyed by lane id.
 */
export type ActivityRow = { lastMessage: string | null; lastActivityMs: number | null; contextPercent: number | null };
export type ActivityPanel = Record<string, ActivityRow>;

export type GateStatus = { wouldAdmit: boolean; reason: string; psi: number | null; availableMb: number | null; sliceUsedPct: number | null; paused: boolean; devServerWindow: string };
export type PsiKill = { at: string; text: string };
export type MachinePanel = { gate: GateStatus; tone: "red" | "amber" | null; kills: PsiKill[] };

export type DecisionTicket = {
	id: string;
	code: string | null;
	kind: string;
	question: string;
	owner: string | null;
	raisedBy: string;
	raisedAt: string;
	ageMs: number | null;
	/** Older than two days: the page shows the age in red. */
	stale: boolean;
	blocks: string[];
	options: string[];
	recommendation: string | null;
	status: string;
	/** A card-linked ask is answered on its card, never on the page (blueprint WP4). */
	answerOnCard: boolean;
	/** D16: a step only the operator can do (`SITTING_KINDS`); the page groups these into one "Next sitting" card and never decides kinds itself. */
	sitting: boolean;
	/** D16: the option equal to the recommendation (`recommendedOption`), the page's main button; null when none matches word for word. */
	recommended: string | null;
	/** `askVersion`: the answer POST carries it back, and an ask that changed since the page loaded is refused. */
	version: string;
};
/** One ask the queue settled today (D31): what the change lines need to say who answered. */
export type SettledAsk = { id: string; code: string; question: string; by: string | null; relay: boolean; at: string };
export type DecisionsPanel = { tickets: DecisionTicket[]; settledToday: SettledAsk[] };

/** One live-session read: the lane (an id or a seat role), how many messages, and the byte-offset cursor of the message to page back from. */
export type FeedQuery = { lane: string; limit: number; before?: number };
/** Undefined for a lane the feed does not serve. */
export type FeedReader = (query: FeedQuery) => Promise<LaneTail | undefined>;
/** The text of the report attached to one card (D21); undefined for a card with none, an unchecked path or any other name. */
export type ReportReader = (cardId: string) => string | undefined;

export type CommandCenterState = {
	generatedAt: string;
	/** When this gateway process made the composer (D11): a page that sees another value reloads itself. */
	startedAt: string;
	/** D32: the stage vocabulary, so the page holds no stage words. */
	stages: Array<{ key: (typeof LANE_STAGES)[number]; label: string }>;
	/** D31: the newest 20 change lines, newest last. */
	recent: string[];
	/**
	 * MG7: the messages route belongs to the tailnet listener. A listener that does not serve it says so here, and the
	 * page asks for the message text only when the state says the view may have it (D2): a listener is never asked
	 * for a route it does not have.
	 */
	countsOnly?: boolean;
	summary: PanelResult<SummaryData>;
	panels: {
		lanes: PanelResult<LanesPanel>;
		machine: PanelResult<MachinePanel>;
		decisions: PanelResult<DecisionsPanel>;
		delivery: PanelResult<unknown>;
		goals: PanelResult<GoalsPanel>;
		team: PanelResult<TeamPanel>;
		shipped: PanelResult<ShippedPanel>;
		next: PanelResult<NextPanel>;
		/** D21: the research desk's cards (`cardsForPage`), its own panel. */
		ideas: PanelResult<IdeasPanel>;
		/** D30: the three volatile lane fields, apart from the board. */
		activity: PanelResult<ActivityPanel>;
		/** D41: one row per usage snapshot row, keyed `provider` plus `account`, with the router's own facts. */
		usage: PanelResult<UsagePanel>;
		/** OL6: every contract the doctor checks, with the age of its proof, for the Systems tab's Services section. */
		contracts: PanelResult<ContractsPanel>;
		/** D33: merges, models, rounds, goals and the median from `lane-outcomes.tsv`, in all three ranges. */
		history: PanelResult<HistoryPanel>;
		/**
		 * CUTOVER: the Scrum views, derived from the work-item records' own priority, points and sprint. Absent only on a
		 * gateway built without them, where the page says the panel is not wired rather than showing an empty board.
		 */
		scrum?: PanelResult<ScrumPanel>;
		/** WP1c: actions a process on the PC asked for, waiting for the operator's tap on the phone. Present only when the gateway keeps them. */
		pendingPc?: PanelResult<PendingView[] | PendingPcView[]>;
		/** MG6: counts of waiting drafts and chats that need him, and nothing else. The text is on `/cc/api/messages`, tailnet only. */
		messages?: PanelResult<{ counts: { draftsWaiting: number; needYou: number } }>;
	};
};

/** What one compose returns: the summary is its own key of the state, as it always was. */
export type ComposedPanels = { summary?: PanelResult<SummaryData>; panels: Partial<CommandCenterState["panels"]> };

/** One waiting draft as the tailnet page shows it. The text and the name are here, so this never leaves the tailnet listener. */
export type MessageDraftView = {
	draftId: string;
	/** The first 12 hex of the hash of the text: the page sends it back, so a tap names the text it showed. */
	hash12: string;
	askId: string;
	code: string | null;
	/** `askVersion` of the draft's ask: the tap carries it back. */
	version: string;
	status: "waiting" | "decided";
	/** The first 12 hex of the SHA-256 of the thread id; the audit line holds this and never the id. */
	thread: string;
	name: string | null;
	text: string;
	createdAt: string;
};

export type MessageTap = { draftId: string; hash12: string; version: string; option: "send" | "dont-send"; relay: AskRelay; at: string };
export type MessageTapResult = { ok: true; code: string | null; thread: string; already: boolean } | { ok: false; status: number; error: string };

/** What one thread row of the Messages panel says it is waiting for (MG7). */
export type MessageRowState = "draft" | "sending" | "sent" | "failed" | "unknown" | "needs-you";

/**
 * One row of the Messages panel (MG7). It holds a name and a cut preview of chat text, so it exists on the tailnet listener only.
 * `line` is the row's one line, worded by the messaging module: the page paints it as text and words nothing itself.
 */
export type MessageRowView = {
	/** The first 12 hex of the SHA-256 of the thread id; the row never carries the id itself. */
	thread: string;
	name: string | null;
	channel: string;
	state: MessageRowState;
	/** The row's one line: "Draft ready", "Sent 14:07 · delivered", "Needs you, no draft". */
	line: string;
	preview: string | null;
	/** When the chat started waiting, ISO; null when it is not waiting for him. */
	waitingSince: string | null;
	/** The draft this row opens, when it has one. */
	draftId: string | null;
};

/** The Messages panel (MG7): the connection strip, the counts, and the threads that need him. */
export type MessagesPanelView = {
	strip: { tone: "ok" | "attention" | "error"; text: string };
	counts: { draftsWaiting: number; needYou: number };
	/** False while the archive holds no thread at all: the row list then says so. */
	history: boolean;
	/** "Nothing is waiting", or the notice that nothing from before the link is on this PC; null when rows speak. */
	empty: string | null;
	rows: MessageRowView[];
};

/** One open thread (MG7): the last messages of the chat, then the draft the operator may send, change, drop or replace. */
export type MessageThreadView = {
	thread: string;
	name: string | null;
	channel: string;
	state: MessageRowState;
	line: string;
	/** Oldest first: no message id leaves the module, and no chat id either. */
	messages: Array<{ at: string; fromMe: boolean; text: string }>;
	/** The draft the buttons act on; null when the thread has no draft left (the row then says what happened). */
	draft: { draftId: string; hash12: string; version: string; text: string; createdAt: string } | null;
};

/** MG7: the request behind `msg-edit-send` and `msg-redraft`: the draft, the text the page showed, the ask's version. */
export type MessageActionRequest = { draftId: string; hash12: string; version: string; relay: AskRelay; at: string };
export type MessageEditSend = MessageActionRequest & { text: string };
export type MessageRedraft = MessageActionRequest & { instruction: string | null };
export type MessageActionResult =
	| { ok: true; draftId: string; thread: string; code: string | null; already: boolean }
	| { ok: false; status: number; error: string };

/**
 * What the center asks of the messaging module (MG6, MG7). The composition root wires it (`cli/gateway.ts`); this file imports
 * nothing from `messaging/`, so the public gateway's code does not reach the message store through it.
 */
export type MessagesPort = {
	counts: () => { draftsWaiting: number; needYou: number };
	list: () => MessageDraftView[];
	/** the operator's tap on one waiting draft; the module checks the text the tap names and answers the ask as `operator-page`. */
	tap: (tap: MessageTap) => MessageTapResult;
	/** MG7: the panel's rows, its strip and its empty line. Tailnet only, since the rows hold names and text. */
	panel: () => MessagesPanelView;
	/** MG7: one thread by the draft a row named, with the chat's last messages and the draft. */
	thread: (draftId: string) => MessageThreadView | undefined;
	/** MG7: the operator's own text. It builds the draft, raises and prepares its ask and answers it as `operator-page`; it sends nothing. */
	editSend: (input: MessageEditSend) => MessageActionResult;
	/** MG7: asks the writer for a new draft of that thread. Nothing is sent. Absent writer: `503`. */
	redraft: (input: MessageRedraft) => Promise<MessageActionResult>;
};

export type CommandCenterDeps = {
	/** Muster state dir: the seat tickets live under it. */
	stateDir: string;
	home: string;
	now?: () => Date;
	/** The lane directory, as `muster lanes` reads it. */
	lanes: () => LaneCard[];
	/** The active systemd scope units, read once per state or action. */
	scopeUnits?: () => readonly string[];
	/** The lane's brief title; the default reads the newest `lane-prompt-*-<lane>-*.md`. */
	briefTitle?: (laneId: string) => string | undefined;
	/** `heavy-gate.sh --status`. */
	gateStatus: () => Promise<GateStatus>;
	/** The psi guard's kill events, newest last. */
	psiKills: () => PsiKill[];
	/** The open asks, as the ask queue reads them. */
	asks: () => Ask[];
	/** Absent until WP5: the delivery panel then says so. */
	delivery?: () => Promise<unknown>;
	closeLane: (laneId: string, caller: string) => Promise<{ ok: boolean; detail: string }>;
	/** The message box (D4): stores `text` for the recipient as `operator-page` and answers the id it was stored under. `id` is the one a seat's `ID:` line holds. Absent: the action is refused 503. */
	sendMessage?: (to: MessageTarget, text: string, id: string) => Promise<{ messageId?: string }>;
	/** The one send path, to the seat that raised an answered ask (`orchestrator`, `architect` or `grokbot`); throws when the line is not delivered. Absent: no line is sent. */
	notifyRaiser?: (recipient: string, text: string) => Promise<void>;
	/** `heavy-gate-pause.sh pause|resume`. */
	heavyJobs: (verb: "pause" | "resume") => Promise<{ ok: boolean; detail: string }>;
	/** Where the live session reads: the transcript roots and, in tests, the tail readers. Absent means the defaults under `home`. */
	transcripts?: Pick<OversightToolDeps, "sessionsRoot" | "claudeProjectsRoot" | "readPiTail" | "readClaudeTail">;
	/** The project register: a project's display title (D2). Absent or undefined: the page shows the project id. */
	register?: () => ProjectCatalogue | undefined;
	/** Every goal the registry holds (D1). Absent until the registry is wired: no goals, and every worker lane sits on the side track. */
	goals?: () => GoalSource[];
	/** The lane history, newest start first, for "Shipped today" (the merge times). Absent: the shipped panel says it is not wired. */
	laneHistory?: () => Promise<LaneHistoryEntry[]>;
	/** The next runs of the given systemd user timers (D3). Absent: the next panel says it is not wired. */
	timers?: (units: string[]) => Promise<TimerInfo[]>;
	/** The last complete lines of the gateway's audit file, raw, for Henry's last active time. Absent: that time is null. */
	auditLines?: () => string[];
	/** Henry's messages to the architect and the orchestrator; the default reads the inbox owner. */
	henryMessages?: () => InboxMessage[];
	/** MG7: the writer a redraft asks. Absent: no `messages` panel. */
	/** The lane record for one lane (C4): the stage, the title, the class, the handoffs and the rounds all need it, read once per lane per compose. */
	laneRecord?: (laneId: string) => LaneRecord | undefined;
	/** The work-item records (CUTOVER), as the owner's reader lists them. Absent: the owner's own store under `stateDir`. */
	workItems?: () => { items: WorkItemRecord[]; skipped: unknown[] };
	/** The usage owner's snapshot (D41). Absent: `readUsageSnapshot` on the owner's own path. */
	usageSnapshot?: () => UsageSnapshot;
	/**
	 * OL0/OL6: the doctor's own result file, for the Systems tab's Services section. Absent: `DOCTOR_RESULT_FILE`
	 * from the doctor, which stays the one owner of both the path and the verdicts.
	 */
	doctorResult?: () => unknown;
	/** The inventory, for each account's `kind` (D41). Absent: `loadSubscriptionPlans`. */
	plans?: () => SubscriptionPlan[];
	/** The router's own read of the same file. Absent: `readRoutingSnapshot`. */
	routing?: () => RoutingSnapshot | undefined;
	/** `PoolRouting` for `claudeMax`. Absent: `loadPoolConfig`. */
	poolRouting?: () => PoolRouting | undefined;
	/** Running lanes per provider, for the plan row's router facts. Absent: counted from the lane directory. */
	runningLanes?: (provider: string) => number;
	/**
	 * D42: the daily digest's own savings sentence, `plans30d.line`. Absent: `cost-digest.json` beside the
	 * snapshot, where `scripts/agent-usage-digest.py` writes it. Null (or a file that cannot be read) means the
	 * page says the value is not computed yet.
	 */
	costDigest?: () => string | null;
	/** The lane-outcomes read (D33). Absent: `readLaneOutcomes` on the owner's own path. */
	laneOutcomes?: () => LaneOutcomesRead;
	/** Where the live hub's wakes come from (D30). Absent: the hub's own 10 s clock, which is the files backend. */
	liveWakes?: (onWake: (wake: LiveWake) => void) => (() => void) | undefined;
	/** Pi's model registry, for `modelName`. Absent: `<agentDir>/models.json`. */
	modelsFile?: string;
	/** The research desk store (D13), or the Muster state dir whose switch picks one. Absent: the ideas panel says it is not wired and the card action is refused. */
	desk?: DeskTarget;
	/** How a card tap reaches a seat (`deskDelivery`, D14). Absent: the card action is refused 503, before anything is recorded. */
	deliverCard?: DeskDeliver;
	/** Where reports live (D21). Absent: `~/research/` under `home`. */
	researchRoot?: string;
	/** WP1c: the actions the loopback listener filed for the operator's tap. Absent: the state carries no `pendingPc` panel. */
	pending?: PendingStore;
	/** MG6: the waiting drafts. Absent: no `messages` panel, `/cc/api/messages` answers 404 and the message actions are refused 503. */
	messages?: MessagesPort;
};

const CLOSED_PHASE = "closed";

/** Who the message box can write to (D4). */
export const MESSAGE_TARGETS = ["architect", "henry", "orchestrator"] as const;
export type MessageTarget = (typeof MESSAGE_TARGETS)[number];
const isMessageAction = (value: unknown): value is (typeof MESSAGE_ACTIONS)[number] => typeof value === "string" && (MESSAGE_ACTIONS as readonly string[]).includes(value);
const isMessageTarget = (value: unknown): value is MessageTarget => typeof value === "string" && (MESSAGE_TARGETS as readonly string[]).includes(value);
/** First line of every box message: the recipient reads it as the operator's own words (D4, CC1). */
const MESSAGE_HEADER = "[the operator typed this on the command center. These are his own words.]";

/** The stored text: the header, the recipient's TO line, an ID line for a seat (Henry's path takes no id), a blank line, then his words. */
function messageText(to: MessageTarget, id: string, words: string): string {
	return [MESSAGE_HEADER, MESSAGE_TO_LINES[to], ...(to === "henry" ? [] : [`${ID_LINE_PREFIX}${id}`]), "", words].join("\n");
}

/**
 * The box's two existing send paths with `operator-page` as the sender. A seat gets `inboxSender` (the path of
 * Henry's `send_to_architect` and `send_to_orchestrator`). Henry gets `deliverLaneMessage` as a wake, the path
 * `muster send grokbot` takes: the message lands in his inbox and one wake goes out (operator-page is not batched).
 */
export function pageMessageSender(options: { stateDir: string; ports?: LaneSendPorts }): NonNullable<CommandCenterDeps["sendMessage"]> {
	return async (to, text, id) => {
		if (to !== "henry") {
			await inboxSender({ stateDir: options.stateDir, agentId: PAGE_CALLER, recipientId: to })(text, undefined, id);
			return { messageId: id };
		}
		const deps = laneSendDeps(options.stateDir, PAGE_CALLER, options.ports);
		try {
			const outcome = await deliverLaneMessage({ laneId: GATEWAY_AGENT_ID, mode: "wake", text }, deps);
			if (outcome.transport !== "inbox") throw new Error(outcome.transport === "none" ? outcome.error : `Henry's message went by ${outcome.transport}, not his inbox`);
			return outcome.messageId !== undefined ? { messageId: outcome.messageId } : {};
		} finally {
			await deps.dispose?.();
		}
	};
}

/** The inbox each raising writer reads. A writer that is the operator himself (`operator-shell`, `operator-page`) needs no line. */
const RAISER_INBOX: Readonly<Record<string, string>> = { orchestrator: "orchestrator", architect: "architect", grokbot: "grokbot" };
const ANSWER_LINE_WORDS = 500;

/** The one line the raiser gets: which ask, the operator's words (capped), and where the full record is. A tap says "tapped" and names the option, never "answered ... words" (D15). */
function answerLine(ask: Ask, code: string, said: { words: string } | { option: string }): string {
	const cap = (text: string): string => (text.length > ANSWER_LINE_WORDS ? `${text.slice(0, ANSWER_LINE_WORDS)}...` : text);
	if ("option" in said) return `[command center] the operator tapped ${JSON.stringify(cap(said.option))} on ${code} (${ask.kind}) on the page -- full record: muster asks show ${ask.id}`;
	return `[command center] the operator answered ${code} (${ask.kind}) on the page: ${cap(said.words)} -- full record: muster asks show ${ask.id}`;
}

function briefTitleFrom(home: string, laneId: string): string | undefined {
	const briefs = readLaneBriefs(home, laneId);
	const newest = briefs[briefs.length - 1];
	if (newest === undefined) return undefined;
	const line = briefOutcome(newest)
		.split("\n")
		.map((text) => text.replace(/^Outcome:\s*/, "").trim())
		.find((text) => text !== "");
	return line === undefined ? undefined : line.length > 200 ? `${line.slice(0, 200)}...` : line;
}

async function readPanel<T>(now: () => Date, read: () => T | Promise<T>): Promise<PanelResult<T>> {
	try {
		const data = await read();
		return { readAt: now().toISOString(), error: null, data };
	} catch (error) {
		return { readAt: now().toISOString(), error: error instanceof Error && error.message !== "" ? error.message : "the owner could not be read", data: null };
	}
}

/** D28: the now line is the first line of the latest report, capped at 140 characters. */
export const NOW_LINE_CHARS = 140;
export function nowLine(summary: string): string | null {
	const first = summary
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line !== "");
	if (first === undefined) return null;
	return first.length > NOW_LINE_CHARS ? `${first.slice(0, NOW_LINE_CHARS)}…` : first;
}

/** Pi's registry is a small file that changes when the operator adds a provider; one read a minute is enough. */
const MODEL_NAMES_TTL_MS = 60_000;
const modelNamesCache = new Map<string, { at: number; names: Map<string, string> }>();

/** `models.json` read as `provider/id` to the model's display `name`. A missing or torn file is no names, never a guess. */
function registryNames(path: string): Map<string, string> {
	const nowMs = Date.now();
	const cached = modelNamesCache.get(path);
	if (cached !== undefined && nowMs - cached.at < MODEL_NAMES_TTL_MS) return cached.names;
	const names = new Map<string, string>();
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { providers?: Record<string, { models?: Array<{ id?: unknown; name?: unknown }> }> };
		for (const [provider, entry] of Object.entries(parsed.providers ?? {})) {
			for (const model of entry.models ?? []) {
				if (typeof model.id !== "string" || typeof model.name !== "string" || model.name.trim() === "") continue;
				names.set(`${provider}/${model.id}`, model.name.trim());
			}
		}
	} catch {
		// No registry, no names: the ref's own model part is the fallback below.
	}
	modelNamesCache.set(path, { at: nowMs, names });
	return names;
}

/**
 * D32: a model's display name, from Pi's own registry (`~/.pi/agent/models.json`), with a trailing provider
 * note in brackets dropped; the part of the ref after the slash when the registry does not know it.
 */
export function modelName(ref: string | null, modelsFile?: string): string | null {
	if (ref === null || ref.trim() === "") return null;
	const value = ref.trim();
	const named = registryNames(modelsFile ?? join(piAgentDir(), "models.json")).get(value);
	if (named !== undefined) {
		const withoutNote = named.replace(/\s*\([^()]*\)\s*$/, "").trim();
		return withoutNote !== "" ? withoutNote : named;
	}
	const slash = value.indexOf("/");
	return slash === -1 ? value : value.slice(slash + 1);
}

export function commandCenter(deps: CommandCenterDeps): {
	state: () => Promise<CommandCenterState>;
	/** D30: the one composer; `state()` is a compose of every panel through the same function. */
	composePanels: (names: ReadonlySet<PanelName>) => Promise<ComposedPanels>;
	/** D30: the one live hub of this gateway process, serving every connected page. */
	live: LiveHub;
	act: (body: unknown) => Promise<ActOutcome>;
	feed: FeedReader;
	report: ReportReader;
	messages: (() => MessageDraftView[]) | undefined;
	/** MG7: the panel's rows and the one open thread, for the two reads on the tailnet listener. */
	messagesPanel: (() => MessagesPanelView) | undefined;
	messagesThread: ((draftId: string) => MessageThreadView | undefined) | undefined;
} {
	const now = deps.now ?? (() => new Date());
	const startedAt = now().toISOString();
	const scopeUnits = deps.scopeUnits ?? readActiveScopeUnits;
	const seatContext = { stateDir: deps.stateDir };
	const seatHeld = (laneId: string): boolean => resolveSeatRole(laneId) !== undefined || seatHeldBy(laneId, seatContext) !== undefined;
	// Git, systemctl and the inbox are reused for 60 s (R5.3); a timer whose cached next run has passed is read again at once.
	const reuseHistory = reusing<LaneHistoryEntry[]>(REUSE_MS, now);
	const reuseTimers = reusing<TimerInfo[]>(REUSE_MS, now, (timers, nowMs) => timers.some((timer) => timer.nextMs !== null && timer.nextMs <= nowMs));
	const reuseHenry = reusing<InboxMessage[]>(REUSE_MS, now);

	const lanesPanel = (cards: LaneCard[]): LanesPanel => {
		const units = scopeUnits();
		const title = deps.briefTitle ?? ((laneId: string) => briefTitleFrom(deps.home, laneId));
		// C4: one record read per lane per compose feeds the start time, the stage, the title, the class,
		// the handoffs and the health.
		type ReadRecord = LaneRecord & { handoffs?: readonly LaneHandoff[] };
		const records = new Map<string, ReadRecord | undefined>();
		const recordOf = (laneId: string): ReadRecord | undefined => {
			if (!records.has(laneId)) {
				try {
					records.set(laneId, deps.laneRecord === undefined ? readLaneRecord(deps.stateDir, laneId) : deps.laneRecord(laneId));
				} catch {
					// One lane whose record cannot be read leaves that row's record facts out, not the panel.
					records.set(laneId, undefined);
				}
			}
			return records.get(laneId);
		};
		const rows: LaneRow[] = [];
		let hiddenGone = 0;
		for (const card of cards) {
			const leftover = card.phase === CLOSED_PHASE && laneScopeAlive(card.laneId, units);
			if (card.state === "gone" && !leftover) {
				hiddenGone += 1;
				continue;
			}
			const stalled = card.state === "stalled";
			const record = recordOf(card.laneId);
			const latestReport = newerLaneReport(card.lastReport, record?.lastReport);
			// D26: the tone and the words come from the health owner, never from a test of the card state here.
			const health = laneHealth({
				cardState: card.state,
				phase: record?.phase ?? card.phase,
				terminal: record?.terminal !== undefined,
				latestReport,
				handoffs: record?.handoffs,
				leftover,
			});
			const stage = laneStage({
				record: { phase: record?.phase ?? card.phase ?? "working", terminal: record?.terminal, launchedAt: record?.launchedAt ?? card.since ?? 0, handoffs: record?.handoffs },
				latestReport,
				lastTurnAt: card.lastTurnAt,
			});
			const handoffs = record?.handoffs === undefined ? [] : [...record.handoffs];
			const accepted = [...handoffs].reverse().find((handoff) => handoff.verdict === "accepted");
			const canStop = leftover && card.origin !== "operator" && !seatHeld(card.laneId);			rows.push({
				laneId: card.laneId,
				harness: card.harness,
				model: card.model,
				modelName: modelName(card.model, deps.modelsFile),
				title: record?.title ?? title(card.laneId) ?? card.laneId,
				stage: stage.stage,
				alreadyDone: stage.alreadyDone,
				health,
				now: latestReport === undefined ? null : nowLine(latestReport.summary),
				goal: null,
				station: null,
				rounds: roundsOf(record?.handoffs),
				waits: accepted?.waits ?? null,
				class: record?.class ?? null,
				taskKind: record?.taskKind ?? null,
				handoffs,
				state: card.state,
				phase: card.phase ?? null,
				origin: card.origin ?? null,
				alive: card.alive ?? null,
				since: card.since,
				branch: card.branch,
				brief: title(card.laneId) ?? null,
				stalled,
				startedAt: record?.launchedAt ?? null,
				report: card.lastReport === undefined ? null : { kind: card.lastReport.kind, summary: card.lastReport.summary, at: card.lastReport.at ?? null },
				leftover,
				canStop,
				// D7: every health value but `ok` is the attention tone, never red, and says its state in words.
				tone: health === "ok" ? null : "attention",
				reason: health === "ok" ? null : health === "blocked" && card.blockedReason ? `${LANE_HEALTH_LABELS[health]}: ${card.blockedReason}` : LANE_HEALTH_LABELS[health],
			});
		}
		return { rows, hiddenGone };
	};

	const machinePanel = async (): Promise<MachinePanel> => {
		const gate = await deps.gateStatus();
		// Blueprint §4: amber while heavy jobs are paused or the dev-server window is open, else red when the gate
		// would refuse a 0 MiB job. The gate's own reason is the text.
		const tone = gate.paused || gate.devServerWindow !== "" ? "amber" : !gate.wouldAdmit ? "red" : null;
		return { gate, tone, kills: deps.psiKills() };
	};

	/**
	 * The tickets in the queue's own order, plus the asks settled today so the change lines can say who answered (D31).
	 * The composer applies `waitingOnOperator` once (D32); only `settledToday` reads the whole queue.
	 */
	const decisionsPanel = async (): Promise<DecisionsPanel> => {
		const at = now().getTime();
		const asks = deps.asks();
		const open = waitingOnOperator({ asks } as AskQueue);
		const tickets = orderAsksForOperator(open).map((ask): DecisionTicket => {
			const raised = Date.parse(ask.raisedAt);
			const ageMs = Number.isFinite(raised) ? Math.max(0, at - raised) : null;
			return {
				id: ask.id,
				code: ask.code ?? null,
				kind: ask.kind,
				question: ask.question,
				owner: ask.owner ?? null,
				raisedBy: ask.raisedBy,
				raisedAt: ask.raisedAt,
				ageMs,
				stale: ageMs !== null && ageMs > STALE_ASK_MS,
				blocks: ask.blocks,
				options: ask.options,
				recommendation: ask.recommendation ?? null,
				status: ask.status,
				answerOnCard: ask.card !== undefined,
				sitting: SITTING_KINDS.includes(ask.kind),
				recommended: recommendedOption(ask) ?? null,
				version: askVersion(ask),
			};
		});
		const midnight = localMidnight(now()).getTime();
		const settledToday: SettledAsk[] = [];
		for (const ask of asks) {
			if (ask.status !== "decided" && ask.status !== "done") continue;
			const answeredAt = ask.answeredAt === undefined ? Number.NaN : Date.parse(ask.answeredAt);
			if (!Number.isFinite(answeredAt) || answeredAt < midnight) continue;
			settledToday.push({ id: ask.id, code: askCodeOf(ask), question: ask.question, by: ask.answeredBy ?? null, relay: ask.relay !== undefined, at: ask.answeredAt! });
		}
		return { tickets, settledToday };
	};

	const deliveryPanel = async (): Promise<unknown> => {
		if (deps.delivery === undefined) throw new Error("not wired yet (WP5)");
		return deps.delivery();
	};

	/** What one compose shares between panels: each source is read once, and a failure reaches every panel that needs it. */
	const once = <T>(read: () => T | Promise<T>): (() => Promise<T>) => {
		let pending: Promise<T> | undefined;
		return () => (pending ??= Promise.resolve().then(read));
	};

	/** The goal registry's goals, or none when the gateway is not given the registry. */
	const goalSource = (): GoalSource[] => deps.goals?.() ?? [];
	/** D32, Q4: the queue's own open set, applied once by the composer. */
	const openAsksOf = (asks: readonly Ask[]): Ask[] => waitingOnOperator({ asks } as AskQueue);
	const usageSnapshotReader = deps.usageSnapshot ?? (() => readUsageSnapshot(usageSnapshotPath()));
	/**
	 * OL6: the doctor's result file, read through the doctor's own path rule. A file that is missing or torn is
	 * no result, which the panel states as the doctor not having written one: never a second reading of liveness.
	 */
	const doctorResultReader =
		deps.doctorResult ??
		(async () => {
			try {
				return JSON.parse(readFileSync(await piPort("doctor").resultFile(), "utf8")) as unknown;
			} catch {
				return undefined;
			}
		});
	const plansReader = deps.plans ?? (() => loadSubscriptionPlans());
	const routingReader = deps.routing ?? (() => readRoutingSnapshot());
	/**
	 * D42: the one read this adds. The digest is written beside the snapshot, so its path follows the snapshot's
	 * own directory and its `PI_USAGE_SNAPSHOT_PATH` override. A missing, torn or unreadable file is null, which
	 * the page states as "Value against API prices not computed yet": never a guess and never a second store.
	 */
	const costDigestReader =
		deps.costDigest ??
		((): string | null => {
			try {
				const parsed = JSON.parse(readFileSync(join(dirname(usageSnapshotPath()), "cost-digest.json"), "utf8")) as { plans30d?: { line?: unknown } };
				const line = parsed?.plans30d?.line;
				return typeof line === "string" && line.trim() !== "" ? line : null;
			} catch {
				return null;
			}
		});

	const defaultClaudeMax = (): number | undefined => {
		try {
			const loaded = loadPoolConfig();
			return loaded.ok ? loaded.config.routing?.claudeMax : undefined;
		} catch {
			return undefined;
		}
	};

	/**
	 * The composer, one implementation (CRH 1): `state()` composes every panel through it, and the live hub
	 * composes only the panels a wake marked. A panel's inputs are computed inside the compose, so `next`
	 * reuses the goals view and `goals` reuses the lane rows.
	 */
	const composePanels = async (names: ReadonlySet<PanelName>): Promise<ComposedPanels> => {
		const cards = once(() => deps.lanes());
		const goals = once(() => goalSource());
		const queue = once(() => deps.asks());
		const openAsks = once(async () => openAsksOf(await queue()));
		const seatLanes = once(() => seatHolderLanes(seatContext));

		// D32: a lane's goal and station come from the registry's attachments, resolved through the seat
		// holder, exactly as `buildGoals` resolves them. A lane on no goal carries null.
		const lanes = once(async (): Promise<LanesPanel> => {
			const panel = lanesPanel(await cards());
			const attached = new Map<string, { goal: string; station: string }>();
			let attachedGoals: GoalSource[] = [];
			try {
				attachedGoals = await goals();
			} catch {
				// The board is the panel the operator reads: a goal store that cannot be read leaves the attachments
				// out and the goals panel carries the error, rather than blanking the lanes with it.
				attachedGoals = [];
			}
			if (attachedGoals.length > 0) {
				const holders = await seatLanes();
				for (const goal of attachedGoals) {
					if (goal.status !== "open") continue;
					for (const attachment of goal.lanes) {
						const role = resolveSeatRole(attachment.lane);
						const laneId = role === undefined ? attachment.lane : holders.find((entry) => entry.role === role)?.laneId;
						if (laneId !== undefined && !attached.has(laneId)) attached.set(laneId, { goal: goal.code, station: attachment.station });
					}
				}
			}
			return {
				...panel,
				rows: panel.rows.map((row) => ({ ...row, goal: attached.get(row.laneId)?.goal ?? null, station: attached.get(row.laneId)?.station ?? null })),
			};
		});
		const rows = async (): Promise<LaneRow[]> => (await lanes()).rows;
		const workers = async (): Promise<LaneRow[]> => workerRows(await rows(), seatHeld);

		// D30: the three volatile fields, one entry per lane the directory lists.
		const activity = once(async (): Promise<ActivityPanel> => {
			const panel: ActivityPanel = {};
			for (const card of await cards()) panel[card.laneId] = { lastMessage: card.lastMessage ?? null, lastActivityMs: card.lastActivityMs ?? null, contextPercent: card.contextPercent ?? null };
			return panel;
		});

		const goalsView = once(async (): Promise<GoalsPanel> => {
			const holders = await seatLanes();
			return buildGoals({
				goals: await goals(),
				rows: await rows(),
				workers: await workers(),
				asks: await openAsks(),
				register: deps.register?.(),
				seatLane: (role) => holders.find((entry) => entry.role === role)?.laneId,
			});
		});

		/** The lane history, reused for 60 s; a gateway without it shows what shipped as nothing rather than an error. */
		const historyEntries = once(async (): Promise<LaneHistoryEntry[]> => (deps.laneHistory === undefined ? [] : await reuseHistory("history", deps.laneHistory)));
		/** The summary's own read of it: "shipped today" is one number, so a git failure leaves it at zero and the shipped panel carries the error. */
		const summaryEntries = once(async (): Promise<LaneHistoryEntry[]> => {
			try {
				return await historyEntries();
			} catch {
				return [];
			}
		});

		const summaryPanel = once(async (): Promise<SummaryData> =>
			buildSummary({
				workers: await workers(),
				openGoals: (await goals()).filter((goal) => goal.status === "open").length,
				goals: await goals(),
				tasks: await queue(),
				openAsks: await openAsks(),
				draftsWaiting: deps.messages?.counts().draftsWaiting ?? 0,
				pendingPc: deps.pending === undefined ? 0 : deps.pending.list().length,
				entries: await summaryEntries(),
				now: now(),
			}),
		);

		const teamPanel = async (): Promise<TeamPanel> =>
			buildTeam({
				cards: await cards(),
				seatContext,
				henryMessages: await reuseHenry("henry", deps.henryMessages ?? (() => readHenryMessages(deps.stateDir))),
				auditLines: deps.auditLines?.(),
			});

		const shippedPanel = async (): Promise<ShippedPanel> => {
			if (deps.laneHistory === undefined) throw new Error("not wired yet (lane history)");
			return buildShipped({ entries: await historyEntries(), goals: await goals(), now: now() });
		};

		const nextPanel = async (): Promise<NextPanel> => {
			const view = await goalsView();
			const units = timerUnitsOf(view.groups);
			let timers: TimerInfo[] = [];
			if (units.length > 0) {
				if (deps.timers === undefined) throw new Error("not wired yet (timers)");
				timers = await reuseTimers(units.join(","), () => deps.timers!(units));
			}
			return buildNext({ groups: view.groups, workers: await workers(), timers, now: now() });
		};

		// D21: the desk's cards, through the one function Henry's `cards_read` also calls. Its own panel: a desk that cannot be read blanks nothing else.
		const ideasPanel = (): IdeasPanel => {
			if (deps.desk === undefined) throw new Error("not wired yet (research desk)");
			return cardsForPage(readDesk(deps.desk), now());
		};

		// D41: one row per snapshot row, keyed provider plus account, with the router's own facts and no threshold of its own.
		const usagePanel = once(async (): Promise<UsagePanel> => {
			const snapshot = await usageSnapshotReader();
			const routing = await routingReader();
			let claudeMax: number | undefined;
			try {
				claudeMax = deps.poolRouting === undefined ? defaultClaudeMax() : deps.poolRouting()?.claudeMax;
			} catch {
				claudeMax = undefined;
			}
			const counted = new Map<string, number>();
			if (deps.runningLanes === undefined) {
				for (const card of await cards()) if (card.model !== null) counted.set(providerOf(card.model), (counted.get(providerOf(card.model)) ?? 0) + 1);
			}
			return buildUsage({
				snapshot,
				plans: await plansReader(),
				routing: routing === undefined ? undefined : routing,
				claudeMax,
				runningLanes: deps.runningLanes ?? ((provider: string) => counted.get(provider) ?? 0),
				valueLine: costDigestReader(),
				now: now().getTime(),
			});
		});

		// OL0/OL6: the doctor's contract rows, for the Systems tab, read once per compose from the doctor's own result.
		const contractsPanel = once(async (): Promise<ContractsPanel> => buildContracts(await doctorResultReader()));

		// D33: the file read again at most once a minute; a row it cannot parse is counted and skipped.
		const historyPanel = once(async (): Promise<HistoryPanel> => {
			const read = deps.laneOutcomes === undefined ? readLaneOutcomes(laneOutcomesPath()) : deps.laneOutcomes();
			return buildHistoryPanel(read.rows, now(), read.skipped, (ref) => modelName(ref, deps.modelsFile) ?? "No model recorded");
		});

		const buildPanel = async (name: PanelName): Promise<PanelResult<unknown>> => {
			switch (name) {
				case "summary":
					return readPanel(now, summaryPanel);
				case "lanes":
					return readPanel(now, lanes);
				case "machine":
					return readPanel(now, machinePanel);
				case "decisions":
					return readPanel(now, decisionsPanel);
				case "delivery":
					return readPanel(now, deliveryPanel);
				case "goals":
					return readPanel(now, goalsView);
				case "team":
					return readPanel(now, teamPanel);
				case "shipped":
					return readPanel(now, shippedPanel);
				case "next":
					return readPanel(now, nextPanel);
				case "ideas":
					return readPanel(now, ideasPanel);
				case "pendingPc":
					return readPanel(now, () => deps.pending!.list());
				case "messages":
					return readPanel(now, () => ({ counts: deps.messages!.counts() }));
				case "activity":
					return readPanel(now, activity);
				case "usage":
					return readPanel(now, usagePanel);
				case "contracts":
					return readPanel(now, contractsPanel);
				case "history":
					return readPanel(now, historyPanel);
			}
		};

		const wanted = [...names].filter((name) => (name !== "pendingPc" || deps.pending !== undefined) && (name !== "messages" || deps.messages !== undefined));
		const built = await Promise.all(wanted.map(async (name) => [name, await buildPanel(name)] as const));
		const composed: ComposedPanels = { panels: {} };
		const panels: Record<string, PanelResult<unknown>> = {};
		for (const [name, panel] of built) {
			if (name === "summary") composed.summary = panel as PanelResult<SummaryData>;
			else panels[name] = panel;
		}
		composed.panels = panels as ComposedPanels["panels"];
		return composed;
	};

	/** The live hub: one per process, its ledger subscription only while a page is connected (D30). */
	const live = createLiveHub({
		state: () => state(),
		composePanels,
		now,
		...(deps.liveWakes !== undefined ? { subscribe: deps.liveWakes } : { subscribe: (onWake: (wake: LiveWake) => void) => ledgerWakeSource(deps.stateDir, onWake) }),
	});

	const state = async (): Promise<CommandCenterState> => {
		const composed = await composePanels(new Set<PanelName>(PANEL_NAMES));
		// CUTOVER: the Scrum views read the work-item records through the owner's own reader, once per state read. A
		// store that cannot be read is the panel's error, not the page's silence: the other panels still render.
		const scrumPanel = await readPanel(now, () => {
			const listing = deps.workItems === undefined ? listWorkItems(workItemStore(workItemsDir(deps.stateDir))) : deps.workItems();
			const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia", year: "numeric", month: "2-digit", day: "2-digit" }).format(now());
			return buildScrumPanel(listing.items, today, listing.skipped.length);
		});
		composed.panels = { ...composed.panels, scrum: scrumPanel };
		return {
			generatedAt: now().toISOString(),
			startedAt,
			stages: LANE_STAGES.map((key) => ({ key, label: LANE_STAGE_LABELS[key] })),
			recent: live.recentChanges(),
			// MG7: without the messages port there is no `/cc/api/messages` to read, so the view is counts only.
			countsOnly: deps.messages === undefined,
			summary: composed.summary ?? { readAt: now().toISOString(), error: null, data: null },
			panels: composed.panels as CommandCenterState["panels"],
		};
	};

	const stop = async (laneRaw: unknown): Promise<ActOutcome> => {
		if (typeof laneRaw !== "string" || laneRaw === "") return { status: 400, body: { error: "lane is required" } };
		const lane = laneRaw;
		// WP6: only a lane that is closed with its scope still alive. Never a working lane, a seat, or the operator's own session.
		if (lane.startsWith("operator:")) return { status: 409, body: { error: "the operator's own sessions are never stopped from the page" } };
		if (!LANE_ID.test(lane)) return { status: 400, body: { error: "lane is not a valid lane id" } };
		if (seatHeld(lane)) return { status: 409, body: { error: "the orchestrator and architect seats, and the sessions that hold them, are never stopped from the page" } };
		const row = deps.lanes().find((card) => card.laneId === lane);
		if (row === undefined) return { status: 404, body: { error: `no lane named ${lane}` } };
		if (operatorSessionRefusal(row.origin) !== undefined) return { status: 409, body: { error: "the operator's own sessions are never stopped from the page" } };
		if (row.phase !== CLOSED_PHASE) return { status: 409, body: { error: `${lane} is not closed; the page stops only a closed lane whose scope is still running` } };
		if (!laneScopeAlive(lane, scopeUnits())) return { status: 409, body: { error: `${lane} has no running scope left; nothing to stop` } };
		const outcome = await deps.closeLane(lane, PAGE_CALLER);
		return outcome.ok ? { status: 200, body: { ok: true, detail: outcome.detail } } : { status: 502, body: { error: `stop failed: ${outcome.detail}` } };
	};

	/**
	 * WP4 and D15: record the operator's answer on one ask as the writer `operator-page`, through `answerAsk` (the one
	 * place the relay rule lives), then tell the seat that raised it. The ask is read fresh from the store, so a
	 * ticket the page loaded earlier is compared with what is on file now. The answer is his typed `words` or one
	 * tapped `option` of a prepared ask: exactly one of the two. A tap records the option and no words; the store
	 * checks the option and the version itself, and a repeat of the recorded option answers `already`.
	 */
	const answer = async (idRaw: unknown, versionRaw: unknown, wordsRaw: unknown, optionRaw: unknown): Promise<ActOutcome> => {
		if (typeof idRaw !== "string" || idRaw.trim() === "") return { status: 400, body: { error: "id is required" } };
		if (typeof versionRaw !== "string" || versionRaw.trim() === "") return { status: 400, body: { error: "version is required: reload the page" } };
		const hasWords = wordsRaw !== undefined;
		const hasOption = optionRaw !== undefined;
		if (hasWords === hasOption) return { status: 400, body: { error: "send either words or an option, not both and not neither" } };
		if (hasWords && (typeof wordsRaw !== "string" || wordsRaw.trim() === "")) return { status: 400, body: { error: "words are required" } };
		if (hasOption && (typeof optionRaw !== "string" || optionRaw.trim() === "")) return { status: 400, body: { error: "option is required" } };
		const words = hasWords ? (wordsRaw as string).trim() : undefined;
		const option = hasOption ? (optionRaw as string) : undefined;
		const version = versionRaw.trim();
		const ask = readAsks(deps.stateDir).asks.find((candidate) => candidate.id === idRaw.trim());
		if (ask === undefined) return { status: 404, body: { error: `no ask ${idRaw.trim()}` } };
		// A card-linked ask is answered on its card (answerAsk refuses it too); say so before anything about versions.
		if (ask.card !== undefined) return { status: 409, body: { error: `ask ${ask.id} defers to card ${ask.card.decisionId}: answer it on its card` } };
		// MG6 (G9): the OK for a send is bound to the text the operator saw, so a draft's ask is answered in Messages and nowhere else.
		if (ask.raisedBy === "messaging" && ask.kind === "authorization") return { status: 409, body: { error: "a reply waiting for your OK is answered in Messages, where its text is shown" } };
		const at = now().toISOString();
		const relay = { via: "command-center" as const, ref: randomUUID(), at };
		let answered: Ask;
		try {
			if (option !== undefined) {
				// The store owns the tap's rules (option, version, status, repeat), so a caller that skips the page cannot skip them.
				const outcome = answerAskResult(deps.stateDir, { ref: ask.id, by: "operator-page", ruling: option, relay, tap: { option, version }, at });
				if (outcome.already) return { status: 200, body: { ok: true, id: outcome.ask.id, code: askCodeOf(outcome.ask), status: outcome.ask.status, already: true, notified: null } };
				answered = outcome.ask;
			} else {
				if (askVersion(ask) !== version) return { status: 409, body: { error: "this ask changed, reload" } };
				if (ask.status !== "open" && ask.status !== "awaiting-operator") return { status: 409, body: { error: `ask ${ask.id} is ${ask.status}; the page answers only an open or awaiting-operator ask` } };
				answered = answerAskResult(deps.stateDir, { ref: ask.id, by: "operator-page", ruling: words!, words: words!, relay, at }).ask;
			}
		} catch (error) {
			if (!(error instanceof AskStateError)) throw error;
			const status = error.code === "missing" ? 404 : error.code === "invalid" ? 400 : error.code === "io" ? 502 : 409;
			return { status, body: { error: error.message } };
		}
		// AK3: the list the operator reads regenerates on every event; a failed view write is reported, never raised.
		const listed = regenerateOperatorList(deps.stateDir);
		const code = askCodeOf(answered);
		const body: Record<string, unknown> = { ok: true, id: answered.id, code, status: answered.status, notified: null, ...("error" in listed ? { listWarning: listed.error } : {}) };
		const recipient = RAISER_INBOX[answered.raisedBy];
		if (recipient !== undefined && deps.notifyRaiser !== undefined) {
			try {
				await deps.notifyRaiser(recipient, answerLine(answered, code, option !== undefined ? { option } : { words: words! }));
				body["notified"] = recipient;
			} catch (error) {
				// The answer is on record; only the line failed.
				body["notifyError"] = error instanceof Error && error.message !== "" ? error.message : "the line was not delivered";
			}
		}
		return { status: 200, body };
	};

	/**
	 * D21: one tap on a research card, recorded through `tapCard` (the one place a tap is recorded) as a page tap.
	 * 400 for an unknown tap or a missing field, 404 for no such card, 409 for a card that changed since the page
	 * drew it, 502 when the tap is recorded and its message was not delivered (asking again delivers it).
	 */
	const card = async (idRaw: unknown, versionRaw: unknown, tapRaw: unknown): Promise<ActOutcome> => {
		if (typeof idRaw !== "string" || idRaw.trim() === "") return { status: 400, body: { error: "id is required" } };
		if (typeof versionRaw !== "string" || versionRaw.trim() === "") return { status: 400, body: { error: "version is required: reload the page" } };
		if (typeof tapRaw !== "string" || tapRaw.trim() === "") return { status: 400, body: { error: "tap is required" } };
		if (deps.desk === undefined || deps.deliverCard === undefined) return { status: 503, body: { error: "the research desk is not available" } };
		try {
			const result = await tapCard(deps.desk, { id: idRaw.trim(), version: versionRaw.trim(), tap: tapRaw.trim(), via: "page", deliver: deps.deliverCard, at: now().toISOString() });
			return { status: 200, body: { ok: true, id: result.card.id, tap: result.tap.tap, already: result.already, delivered: result.delivered } };
		} catch (error) {
			if (error instanceof DeskRefusal) {
				// The delivery's own reason may quote the card, so the reply names only what happened.
				return { status: error.status, body: { error: error.code === "undelivered" ? `the tap on ${idRaw.trim()} is saved and was not delivered yet` : error.message } };
			}
			if (error instanceof DeskStateError) return { status: error.code === "conflict" ? 409 : 502, body: { error: "the research desk could not be written" } };
			throw error;
		}
	};

	/** D21: the report attached to a card, read again through the `~/research/` check with links resolved. Undefined for anything else. */
	const report = (cardId: string): string | undefined => {
		if (deps.desk === undefined || !CARD_ID_PATTERN.test(cardId)) return undefined;
		const file = reportFileFor(readDesk(deps.desk), cardId, deps.researchRoot ?? researchRoot(deps.home));
		return file === undefined ? undefined : readFileSync(file, "utf8");
	};

	/** D4: the operator's typed words to the architect, the orchestrator or Henry, as `operator-page`. Nothing is written unless the whole request is valid. */
	const message = async (toRaw: unknown, textRaw: unknown): Promise<ActOutcome> => {
		if (!isMessageTarget(toRaw)) return { status: 400, body: { error: `to must be one of ${MESSAGE_TARGETS.join(", ")}` } };
		if (typeof textRaw !== "string" || textRaw.trim() === "") return { status: 400, body: { error: "text is required" } };
		const words = textRaw.trim();
		if (words.length > MAX_MESSAGE_CHARS) return { status: 400, body: { error: `text is longer than ${MAX_MESSAGE_CHARS} characters` } };
		if (deps.sendMessage === undefined) return { status: 503, body: { error: "the message box is not available" } };
		const id = randomUUID();
		try {
			const sent = await deps.sendMessage(toRaw, messageText(toRaw, id, words), id);
			return { status: 200, body: { ok: true, to: toRaw, ...(sent.messageId !== undefined ? { messageId: sent.messageId } : {}) } };
		} catch {
			// The reason may quote the message; the words stay out of the reply and the audit.
			return { status: 502, body: { error: `the message to ${toRaw} was not delivered` } };
		}
	};

	/**
	 * MG6: the operator's tap on one waiting draft, as `operator-page`. The request names the draft, the short hash of the text the page
	 * showed and the version of the ask; the messaging module refuses a tap whose text is not the stored draft's.
	 * The reply and the audit line hold the draft id and the thread fingerprint, never text or a chat id.
	 */
	/** The three fields a message action names back, or the refusal that stops it (MG6, MG7). */
	const messageFields = (request: Record<string, unknown>): { draftId: string; hash12: string; version: string } | { error: ActOutcome } => {
		const draftId = request["draftId"];
		const hash12 = request["hash12"];
		const version = request["version"];
		if (typeof draftId !== "string" || !/^[0-9a-f]{16}$/.test(draftId)) return { error: { status: 400, body: { error: "draftId is required" } } };
		if (typeof hash12 !== "string" || !/^[0-9a-f]{12}$/.test(hash12)) return { error: { status: 400, body: { error: "hash12 is required: reload the page" } } };
		if (typeof version !== "string" || version.trim() === "") return { error: { status: 400, body: { error: "version is required: reload the page" } } };
		return { draftId, hash12, version: version.trim() };
	};

	const messageTap = async (request: Record<string, unknown>, option: MessageTap["option"]): Promise<ActOutcome> => {
		const fields = messageFields(request);
		if ("error" in fields) return fields.error;
		if (deps.messages === undefined) return { status: 503, body: { error: "Messages is not available" } };
		const at = now().toISOString();
		const result = deps.messages.tap({ ...fields, option, relay: { via: "command-center", ref: randomUUID(), at }, at });
		if (!result.ok) return { status: result.status, body: { error: result.error } };
		return { status: 200, body: { ok: true, draft: fields.draftId, thread: result.thread, ...(result.code !== null ? { code: result.code } : {}), already: result.already } };
	};

	/**
	 * MG7: the operator's own text for a draft, through the same tap rule. The module builds the draft of his
	 * text, raises and prepares its ask and answers it as `operator-page`; the send gate sends it, and
	 * nothing here does. His words are read here and reach neither the audit line nor the reply.
	 */
	const messageEditSend = async (request: Record<string, unknown>): Promise<ActOutcome> => {
		const fields = messageFields(request);
		if ("error" in fields) return fields.error;
		const text = request["text"];
		if (typeof text !== "string" || text.trim() === "") return { status: 400, body: { error: "text is required: type the reply" } };
		if (deps.messages === undefined) return { status: 503, body: { error: "Messages is not available" } };
		const at = now().toISOString();
		const result = deps.messages.editSend({ ...fields, text, relay: { via: "command-center", ref: randomUUID(), at }, at });
		if (!result.ok) return { status: result.status, body: { error: result.error } };
		return { status: 200, body: { ok: true, draft: fields.draftId, draftId: result.draftId, thread: result.thread, ...(result.code !== null ? { code: result.code } : {}), already: result.already } };
	};

	/**
	 * MG7: the writer is asked for a new draft of that thread, with the operator's one-line instruction when
	 * he gave one. Nothing is sent; the action stands the old draft's ask down first, so one text waits.
	 */
	const messageRedraft = async (request: Record<string, unknown>): Promise<ActOutcome> => {
		const fields = messageFields(request);
		if ("error" in fields) return fields.error;
		const given = request["instruction"];
		if (given !== undefined && given !== null && (typeof given !== "string" || given.length > MAX_INSTRUCTION_CHARS)) {
			return { status: 400, body: { error: `the instruction must be one line of ${MAX_INSTRUCTION_CHARS} characters or fewer` } };
		}
		if (deps.messages === undefined) return { status: 503, body: { error: "Messages is not available" } };
		const at = now().toISOString();
		const instruction = typeof given === "string" && given.trim() !== "" ? given.trim() : null;
		const result = await deps.messages.redraft({ ...fields, instruction, relay: { via: "command-center", ref: randomUUID(), at }, at });
		if (!result.ok) return { status: result.status, body: { error: result.error } };
		return { status: 200, body: { ok: true, draft: fields.draftId, draftId: result.draftId, thread: result.thread, ...(result.code !== null ? { code: result.code } : {}), already: result.already } };
	};

	const act = async (body: unknown): Promise<ActOutcome> => {
		const request = (typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
		switch (request["action"]) {
			case "stop":
				return stop(request["lane"]);
			case "pause":
			case "resume": {
				const outcome = await deps.heavyJobs(request["action"]);
				return outcome.ok ? { status: 200, body: { ok: true, detail: outcome.detail } } : { status: 502, body: { error: `${request["action"]} failed: ${outcome.detail}` } };
			}
			case "answer":
				return answer(request["id"], request["version"], request["words"], request["option"]);
			case "card":
				return card(request["id"], request["version"], request["tap"]);
			case "message":
				return message(request["to"], request["text"]);
			case "msg-send":
				return messageTap(request, "send");
			case "msg-drop":
				return messageTap(request, "dont-send");
			case "msg-edit-send":
				return messageEditSend(request);
			case "msg-redraft":
				return messageRedraft(request);
			default:
				return { status: 400, body: { error: `action must be one of ${ACT_ACTIONS.join(", ")}` } };
		}
	};

	// The live session of one lane (WPF): the tail of its transcript through the oversight reader, never the whole file.
	const oversight: OversightToolDeps = { home: deps.home, stateDir: deps.stateDir, lanes: deps.lanes, now, ...deps.transcripts };
	const feed: FeedReader = (query) => laneTranscriptTail(oversight, query.lane, { limit: query.limit, ...(query.before !== undefined ? { before: query.before } : {}) });

	return {
		state,
		composePanels,
		live,
		act,
		feed,
		report,
		messages: deps.messages === undefined ? undefined : deps.messages.list,
		messagesPanel: deps.messages === undefined ? undefined : deps.messages.panel,
		messagesThread: deps.messages === undefined ? undefined : deps.messages.thread,
	};
}

export type ActOutcome = { status: number; body: Record<string, unknown> };

// ─── Real readers for the composer ─────────────────────────────────────────

function runFile(file: string, args: readonly string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; detail: string }> {
	return new Promise((resolveRun) => {
		execFile(file, [...args], { timeout: timeoutMs, encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
			resolveRun({ ok: error === null, stdout: stdout.trim(), detail: (error === null ? stdout : `${stderr}${stdout}`).trim().split("\n").slice(-1)[0] ?? "" });
		});
	});
}

/** `heavy-gate.sh --status`: one JSON line, always exit 0 (WP2). Anything else is an error for the machine panel. */
export function gateStatusReader(script: string): () => Promise<GateStatus> {
	return async () => {
		const run = await runFile("bash", [script, "--status"], GATE_TIMEOUT_MS);
		if (!run.ok) throw new Error(`heavy-gate --status failed: ${run.detail}`);
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(run.stdout.split("\n").slice(-1)[0] ?? "") as Record<string, unknown>;
		} catch {
			throw new Error("heavy-gate --status did not print JSON");
		}
		const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
		if (typeof parsed["wouldAdmit"] !== "boolean" || typeof parsed["paused"] !== "boolean") throw new Error("heavy-gate --status printed an unexpected shape");
		return {
			wouldAdmit: parsed["wouldAdmit"],
			reason: typeof parsed["reason"] === "string" ? parsed["reason"] : "",
			psi: num(parsed["psi"]),
			availableMb: num(parsed["availableMb"]),
			sliceUsedPct: num(parsed["sliceUsedPct"]),
			paused: parsed["paused"],
			devServerWindow: typeof parsed["devServerWindow"] === "string" ? parsed["devServerWindow"] : "",
		};
	};
}

/** `heavy-gate-pause.sh pause|resume` (WP3), the one writer of the pause flag. */
export function heavyJobsRunner(script: string): CommandCenterDeps["heavyJobs"] {
	return async (verb) => {
		const run = await runFile("bash", [script, verb], GATE_TIMEOUT_MS);
		return { ok: run.ok, detail: run.detail };
	};
}

const PSI_KILL_LINE = /^(\S+) PSI KILL: (.+)$/;
const EVENTS_TAIL_BYTES = 512 * 1024;

/** The psi guard's kill events, from the tail of the orchestrator events log (the guard's own output, `pi-psi-guard.py note_event`). */
export function psiKillReader(eventsLog: string, limit = 10): () => PsiKill[] {
	return () => {
		let fd: number;
		try {
			fd = openSync(eventsLog, "r");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		try {
			const size = fstatSync(fd).size;
			const start = Math.max(0, size - EVENTS_TAIL_BYTES);
			const buffer = Buffer.alloc(size - start);
			readSync(fd, buffer, 0, buffer.length, start);
			const kills: PsiKill[] = [];
			for (const line of buffer.toString("utf8").split("\n")) {
				const match = PSI_KILL_LINE.exec(line);
				if (match !== null) kills.push({ at: match[1]!, text: match[2]! });
			}
			return kills.slice(-limit);
		} finally {
			closeSync(fd);
		}
	};
}

// ─── The listener's request handler ────────────────────────────────────────

export type CommandCenterListener = {
	/** The address the listener binds: the PC's tailnet address, never a wildcard. */
	host: string;
	/** 0 picks a free port (tests). */
	port: number;
	/** The one tailnet login that may open the page (`CC_ALLOWED_LOGIN`). */
	allowedLogin: string;
	/** The stable node ids of the machines that may open it (`CC_ALLOWED_NODES`): the login alone admits every node under it. An empty list admits no one. */
	allowedNodes: string[];
	/** This gateway's own node (tailscaled's `Self`): refused whatever the list says, since every lane and process on the PC reaches the page from it. */
	selfNodeId: string;
	/** Extra Host names the page may be opened under, such as the machine's MagicDNS name. The bound address is always allowed. */
	allowedHosts?: string[];
	whois: Whois;
	/** WP1c: the actions the loopback listener filed. Present: this listener serves `confirm` and `reject`. */
	pending?: PendingStore;
	/** WP1c: the certificate and key (PEM files) this listener's server terminates TLS with. The Origin it expects is then https. */
	tls?: TlsFiles;
	state: () => Promise<CommandCenterState>;
	/** D30: the process's one live hub; every frame of the stream passes this listener's checks and redaction. */
	live?: LiveHub;
	act: (body: unknown) => Promise<ActOutcome>;
	/** The live session of one lane (WPF). Absent: the feed path answers 404. */
	feed?: FeedReader;
	/** The report of one card (D21). Absent: the report path answers 404. */
	report?: ReportReader;
	/** MG6: the waiting drafts for `GET /cc/api/messages`. Absent: that path answers 404. */
	messages?: () => MessageDraftView[];
	/** MG7: the panel for `GET /cc/api/messages`. Absent: the reply carries no `panel`. */
	messagesPanel?: () => MessagesPanelView;
	/** MG7: one thread for `GET /cc/api/messages?draft=<id>`. Absent: that query answers 404. */
	messagesThread?: (draftId: string) => MessageThreadView | undefined;
};

export type CommandCenterHandlerHooks = {
	isOff: () => boolean;
	/** Refusals before anything runs; the gateway's rate-limited HTTP refusal log. */
	refusal: (args: unknown, reason: string) => void;
	/** The gateway's audit line, as tool calls write it. Throws when the line cannot be written. */
	audit: (tool: string, args: unknown, resultBytes: number | null, refused: boolean, reason?: string, phase?: "intent" | "result") => void;
};

/** True for an address the listener may never be bound to. A tailnet address, or a loopback one in tests, is an IP literal. */
export function isWildcardOrUnnamed(host: string): boolean {
	return host.trim() === "" || host === "0.0.0.0" || host === "::" || host === "*" || host === "::0" || /^0+(\.0+){3}$/.test(host);
}

/** The audit fields of a card tap (D21): the card id and the tap, each only when it has the shape of one, so no free text reaches the line. */
function cardAudit(record: Record<string, unknown>): Record<string, string> {
	const id = record["id"];
	const tap = record["tap"];
	return {
		...(typeof id === "string" && CARD_ID_PATTERN.test(id) ? { card: id } : {}),
		...(typeof tap === "string" && (CARD_TAPS as readonly string[]).includes(tap) ? { tap } : {}),
	};
}

export function csrfToken(secret: Buffer, login: string): string {
	const nonce = randomBytes(16).toString("hex");
	return `${nonce}.${createHmac("sha256", secret).update(`${nonce}|${login}`).digest("hex")}`;
}

export function csrfValid(secret: Buffer, login: string, token: string | undefined): boolean {
	if (token === undefined) return false;
	const [nonce, signature, extra] = token.split(".");
	if (nonce === undefined || signature === undefined || extra !== undefined || !/^[0-9a-f]{32}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(signature)) return false;
	const expected = createHmac("sha256", secret).update(`${nonce}|${login}`).digest();
	return timingSafeEqual(Buffer.from(signature, "hex"), expected);
}

export function redactDeep(value: unknown): unknown {
	if (typeof value === "string") return redactSensitiveText(value, { preservePaths: true, strictAssignments: true });
	if (Array.isArray(value)) return value.map(redactDeep);
	if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactDeep(entry)]));
	return value;
}

export const BASE_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } as const;

export function json(res: ServerResponse, status: number, body: unknown): string {
	const text = JSON.stringify(body);
	res.writeHead(status, { ...BASE_HEADERS, "content-type": "application/json" });
	res.end(text);
	return text;
}

export async function readActBody(req: IncomingMessage): Promise<string | undefined> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_ACT_BODY_BYTES) return undefined;
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** The one page (blueprint D6): one HTML file with inline style and one inline script, read once when the handler is made. */
const PAGE_FILE = new URL("./command-center-page.html", import.meta.url);
/** The vendored design library and the README beside it (blueprint D35), served from beside this module. */
const ASSETS_DIR = new URL("./cc-assets/", import.meta.url);
/** The copy's own manifest, written by `scripts/vendor-graphite-ui.sh` and committed with the files it names. */
const UI_MANIFEST_FILE = new URL("./cc-assets/ui/manifest.json", import.meta.url);

type VendoredFile = { file: string; type: string };
/** A name the manifest may list: plain segments under `ui/`, so never a dot segment, an absolute path or an escape. */
const VENDORED_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

/**
 * The vendored copy's manifest, read once when this module loads. A copy that does not match its own manifest is a
 * build fault, so it stops the gateway here, by name, instead of serving a page whose parts half load.
 */
function readVendoredManifest(): VendoredFile[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(fileURLToPath(UI_MANIFEST_FILE), "utf8"));
	} catch (error) {
		throw new Error(`the vendored library's manifest could not be read: ${error instanceof Error ? error.message : String(error)}`);
	}
	const files = (parsed as { files?: unknown } | null)?.files;
	if (!Array.isArray(files)) throw new Error("the vendored library's manifest names no files; run scripts/vendor-graphite-ui.sh <tag>");
	return files.map((entry) => {
		const { file, type } = (entry ?? {}) as { file?: unknown; type?: unknown };
		if (typeof file !== "string" || typeof type !== "string" || !VENDORED_NAME.test(file)) {
			throw new Error(`the vendored library's manifest lists an unusable name: ${JSON.stringify(entry)}`);
		}
		return { file, type };
	});
}

/**
 * Every file `/cc/assets/` serves: the README and the vendored library's own manifest, with the type each one is
 * served as. Nothing is resolved from the request: a name that is not a key here is a 404, so `..`, an encoded slash
 * and any other name cannot leave this list.
 */
export const CC_ASSETS: ReadonlyMap<string, string> = new Map([
	["README.md", "text/plain; charset=utf-8"],
	...readVendoredManifest().map((entry) => [`ui/${entry.file}`, entry.type] as const)
]);

/**
 * The page's content security policy (blueprint D35): no origin outside this listener, one nonce'd script, the page's
 * own inline style and the vendored library's stylesheets from this listener, the system type, same-origin reads.
 */
export function commandCenterCsp(nonce: string): string {
	return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

/** The page with this load's CSRF token and script nonce filled in. */
export function commandCenterPageHtml(page: string, token: string, nonce: string): string {
	return page.replaceAll("__CC_CSRF__", token).replaceAll("__CC_NONCE__", nonce);
}

/** The page file on disk, so the fixture server and the QA run drive the same bytes the gateway serves. */
export function commandCenterPageFile(): string {
	return fileURLToPath(PAGE_FILE);
}

/** The directory the vendored library lives in. */
export function commandCenterAssetsDir(): string {
	return fileURLToPath(ASSETS_DIR);
}

const PENDING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * the operator's tap on a pending PC action (WP1c point 4), after the listener's whois, Origin and CSRF checks.
 * Confirm claims the action once (a replay is 410) and runs the payload through the same `act` a direct tap calls.
 * The audit lines name the kind, the source (`pc-confirmed`) and the pending id, never the payload and never an id the payload carries.
 */
async function settlePending(
	res: ServerResponse,
	pending: PendingStore,
	hooks: CommandCenterHandlerHooks,
	c: { id: string; confirm: boolean; body: unknown; login: string; node: string; act: (body: unknown) => Promise<ActOutcome>; refuse: (status: number, reason: string) => void },
): Promise<void> {
	const record = (typeof c.body === "object" && c.body !== null && !Array.isArray(c.body) ? c.body : {}) as Record<string, unknown>;
	if (!c.confirm) {
		const rejected = pending.reject(c.id);
		if (!rejected.ok) return c.refuse(rejected.status, rejected.error);
		try {
			hooks.audit("(cc:reject)", { action: rejected.kind, source: "pc-rejected", pending: c.id, login: c.login, node: c.node }, null, false);
		} catch {
			json(res, 500, { error: "gateway error" });
			return;
		}
		json(res, 200, { ok: true, id: c.id, rejected: true });
		return;
	}
	const claimed = pending.claim(c.id, typeof record["digest"] === "string" ? record["digest"] : "");
	if (!claimed.ok) return c.refuse(claimed.status, claimed.error);
	const audited = { action: claimed.kind, source: "pc-confirmed", pending: c.id, login: c.login, node: c.node };
	// Intent first: if the line cannot be written the action does not run (it is already spent, so the PC asks again).
	try {
		hooks.audit("(cc:confirm)", audited, null, false, undefined, "intent");
	} catch {
		json(res, 500, { error: "gateway error" });
		return;
	}
	let outcome: ActOutcome;
	try {
		outcome = await c.act(claimed.payload);
	} catch {
		outcome = { status: 500, body: { error: "the action failed" } };
	}
	const text = json(res, outcome.status, outcome.body);
	try {
		hooks.audit("(cc:confirm)", { ...audited, status: outcome.status }, Buffer.byteLength(text), outcome.status >= 400, outcome.status >= 400 ? String(outcome.body["error"] ?? "refused") : undefined, "result");
	} catch {
		// The intent line is on record.
	}
}

/** The page file read once, as D6 says: a file that changes on disk is picked up by a restart, never by a request. */
export type PageSource = { html: string | undefined; error: string | undefined };
export function loadPage(): PageSource {
	try {
		return { html: readFileSync(fileURLToPath(PAGE_FILE), "utf8"), error: undefined };
	} catch (error) {
		return { html: undefined, error: `the command center page could not be read: ${error instanceof Error ? error.message : String(error)}` };
	}
}

export type ReadRoute = "shell" | "asset" | "state" | "live" | "feed" | "report";
/** The routes both listeners serve from the same functions below; undefined for any other path. */
export function readRouteOf(pathname: string): ReadRoute | undefined {
	if (pathname === CC_PREFIX) return "shell";
	if (pathname === CC_STATE_PATH) return "state";
	if (pathname === CC_LIVE_PATH) return "live";
	if (pathname === CC_FEED_PATH) return "feed";
	if (pathname === CC_REPORT_PATH) return "report";
	if (pathname.startsWith(CC_ASSETS_PATH)) return "asset";
	return undefined;
}

export type ReadContext = {
	page: PageSource;
	/** This load's CSRF token, for the page. */
	csrf: string;
	state: () => Promise<CommandCenterState>;
	feed?: FeedReader | undefined;
	report?: ReportReader | undefined;
	/** D30: the process's one live hub. Absent only in a caller that has no stream (the fixture server's reads). */
	live?: LiveHub | undefined;
	/** A listener may reduce the state before it leaves (the loopback listener withholds message text). */
	shapeState?: (state: CommandCenterState) => CommandCenterState;
	refuse: (status: number, reason: string) => void;
};

/** The page, the assets, the state, the feed and the report: one implementation, called by the tailnet and the loopback listener. */
export async function serveRead(route: ReadRoute, req: IncomingMessage, res: ServerResponse, pathname: string, c: ReadContext): Promise<void> {
	if (route === "shell") {
		if (c.page.html === undefined) return c.refuse(500, c.page.error ?? "the command center page is missing");
		const nonce = randomBytes(16).toString("base64");
		res.writeHead(200, {
			...BASE_HEADERS,
			"content-type": "text/html; charset=utf-8",
			"content-security-policy": commandCenterCsp(nonce),
			"x-frame-options": "DENY",
		});
		res.end(commandCenterPageHtml(c.page.html, c.csrf, nonce));
		return;
	}
	if (route === "asset") {
		// The raw path segment, never decoded: only a listed name is ever touched.
		const name = pathname.slice(CC_ASSETS_PATH.length);
		const type = CC_ASSETS.get(name);
		if (type === undefined) return c.refuse(404, "not found");
		let body: Buffer;
		try {
			body = readFileSync(fileURLToPath(new URL(name, ASSETS_DIR)));
		} catch {
			return c.refuse(500, "the asset is missing from the gateway");
		}
		res.writeHead(200, { ...BASE_HEADERS, "cache-control": "public, max-age=86400", "content-type": type, "content-length": String(body.byteLength) });
		res.end(body);
		return;
	}
	if (route === "state") {
		const state = await c.state();
		json(res, 200, redactDeep(c.shapeState === undefined ? state : c.shapeState(state)));
		return;
	}
	if (route === "live") {
		if (c.live === undefined) return c.refuse(404, "not found");
		// D30: every frame passes this listener's `shapeState` and then `redactDeep`, exactly as the state route does.
		c.live.open(res, (value: unknown) => redactDeep(c.shapeState === undefined ? value : c.shapeState(value as CommandCenterState)));
		return;
	}
	if (route === "feed") {
		const query = new URL(req.url ?? "", "http://cc").searchParams;
		const lane = query.get("lane") ?? "";
		// A lane id (no colon, so never a `operator:*` session) or a seat role; the reader decides which of them it serves.
		if (!LANE_ID.test(lane) || c.feed === undefined) return c.refuse(404, "not found");
		const limitText = query.get("limit");
		const limit = limitText === null ? SESSION_MESSAGES_DEFAULT : /^\d{1,3}$/.test(limitText) ? Number(limitText) : 0;
		if (limit < 1 || limit > CC_FEED_LIMIT_MAX) return c.refuse(400, `limit must be a whole number from 1 to ${CC_FEED_LIMIT_MAX}`);
		const beforeText = query.get("before");
		const before = beforeText === null ? undefined : /^\d{1,15}$/.test(beforeText) ? Number(beforeText) : -1;
		if (before !== undefined && before < 0) return c.refuse(400, "before must be a message index from an earlier read");
		let tail: LaneTail | undefined;
		try {
			tail = await c.feed({ lane, limit, ...(before !== undefined ? { before } : {}) });
		} catch {
			json(res, 500, { error: "the live session could not be read" });
			return;
		}
		if (tail === undefined) return c.refuse(404, "not found");
		json(res, 200, redactDeep(tail));
		return;
	}
	// Only a report attached to this card, read again through the `~/research/` check; every other answer is the same 404.
	const cardId = new URL(req.url ?? "", "http://cc").searchParams.get("card") ?? "";
	let text: string | undefined;
	try {
		text = c.report?.(cardId);
	} catch {
		text = undefined;
	}
	if (text === undefined) return c.refuse(404, "not found");
	const masked = redactDeep(text) as string;
	res.writeHead(200, { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8", "content-security-policy": "default-src 'none'; sandbox" });
	res.end(masked);
}

/** The request handler for the second listener. `port` is the port the listener is actually bound to. */
export function createCommandCenterHandler(options: CommandCenterListener, hooks: CommandCenterHandlerHooks): (req: IncomingMessage, res: ServerResponse, port: number) => Promise<void> {
	const secret = randomBytes(32);
	const allowedLogin = options.allowedLogin.trim().toLowerCase();
	const selfNodeId = options.selfNodeId.trim();
	const allowedNodes = new Set(options.allowedNodes.map((id) => id.trim()).filter((id) => id !== ""));
	const extraHosts = (options.allowedHosts ?? []).map((host) => host.trim().toLowerCase()).filter((host) => host !== "");
	const pageSource = loadPage();

	return async (req, res, port) => {
		const pathname = req.url?.split("?")[0] ?? "";
		let login: string | undefined;
		let node: string | undefined;
		const refuse = (status: number, reason: string): void => {
			hooks.refusal({ method: req.method, path: pathname, listener: "cc", ...(login !== undefined ? { login } : {}), ...(node !== undefined ? { node } : {}) }, reason);
			json(res, status, { error: reason });
		};
		const host = req.headers.host?.toLowerCase();
		const allowedHosts = new Set([`${options.host.toLowerCase()}:${port}`, ...extraHosts.map((name) => `${name}:${port}`)]);
		if (host === undefined || !allowedHosts.has(host)) return refuse(403, "host not allowed");
		if (hooks.isOff()) return refuse(503, "gateway is off");

		// Who is asking: tailscaled's answer for the peer address, nothing the client sent.
		const peer = req.socket.remoteAddress?.replace(/^::ffff:/, "");
		const peerPort = req.socket.remotePort;
		const identity = peer === undefined || peerPort === undefined ? undefined : await options.whois(peer, peerPort).catch(() => undefined);
		if (identity === undefined) return refuse(403, "the peer is not identified");
		login = identity.login;
		if (login.trim().toLowerCase() !== allowedLogin) return refuse(403, "login not allowed");
		// The login covers every node under it (the PC, the VPS, the phone). The gateway's own node comes first, so
		// that a process on this machine never passes, then only the listed nodes.
		node = identity.nodeId;
		if (node === selfNodeId) return refuse(403, "the gateway's own node is never allowed");
		if (!allowedNodes.has(node)) return refuse(403, "node not allowed");

		const route = readRouteOf(pathname);
		const isAct = pathname === CC_ACT_PATH;
		// MG6: the Messages read exists on this listener only. It is not a read route, so the loopback listener never serves it.
		if (pathname === CC_MESSAGES_PATH) {
			if (options.messages === undefined) return refuse(404, "not found");
			if (req.method !== "GET") return refuse(405, "method not allowed");
			const asked = req.headers.origin;
			if (asked !== undefined && !(typeof asked === "string" && host !== undefined && asked.toLowerCase() === `${options.tls !== undefined ? "https" : "http"}://${host}`)) return refuse(403, "origin not allowed");
			// MG7: `?draft=<id>` is one thread with its last messages; the list is the panel. Both carry chat text, so both live here.
			const askedDraft = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("draft");
			if (askedDraft !== null) {
				if (!/^[0-9a-f]{16}$/.test(askedDraft)) return refuse(400, "draft must be a draft id");
				if (options.messagesThread === undefined) return refuse(404, "not found");
				let thread: MessageThreadView | undefined;
				try {
					thread = options.messagesThread(askedDraft);
				} catch {
					json(res, 500, { error: "Messages could not be read" });
					return;
				}
				if (thread === undefined) return refuse(404, "no thread for that draft");
				const text = json(res, 200, redactDeep({ readAt: new Date().toISOString(), thread }));
				try {
					// The line holds the draft and the thread fingerprint, never an id, a name or text.
					hooks.audit("(cc:messages)", { action: "thread", draft: askedDraft, thread: thread.thread, login, node }, Buffer.byteLength(text), false);
				} catch {
					// A read has nothing to undo; the refusal log still holds the route's other failures.
				}
				return;
			}
			let drafts: MessageDraftView[];
			let panel: MessagesPanelView | undefined;
			try {
				drafts = options.messages();
				panel = options.messagesPanel?.();
			} catch {
				json(res, 500, { error: "Messages could not be read" });
				return;
			}
			const text = json(res, 200, redactDeep({ readAt: new Date().toISOString(), drafts, ...(panel !== undefined ? { panel } : {}) }));
			try {
				// The line holds a count and the thread fingerprints, never an id, a name or text.
				hooks.audit("(cc:messages)", { action: "messages", count: drafts.length, threads: drafts.map((draft) => draft.thread), login, node }, Buffer.byteLength(text), false);
			} catch {
				// A read has nothing to undo; the refusal log still holds the route's other failures.
			}
			return;
		}
		// WP1c: confirm and reject exist only where actions are kept, and only here, never on the loopback listener.
		const confirmId = options.pending !== undefined && pathname.startsWith(CC_CONFIRM_PREFIX) ? pathname.slice(CC_CONFIRM_PREFIX.length) : undefined;
		const rejectId = options.pending !== undefined && pathname.startsWith(CC_REJECT_PREFIX) ? pathname.slice(CC_REJECT_PREFIX.length) : undefined;
		const pendingId = confirmId ?? rejectId;
		if (route === undefined && !isAct && !(pendingId !== undefined && PENDING_ID.test(pendingId))) return refuse(404, "not found");
		if (req.method !== (route === undefined ? "POST" : "GET")) return refuse(405, "method not allowed");
		// A page loaded from this listener sends its own origin; a foreign one is refused on a GET as well as a POST.
		const origin = req.headers.origin;
		if (origin !== undefined && !(typeof origin === "string" && host !== undefined && origin.toLowerCase() === `${options.tls !== undefined ? "https" : "http"}://${host}`)) return refuse(403, "origin not allowed");

		if (route !== undefined) return serveRead(route, req, res, pathname, { page: pageSource, csrf: csrfToken(secret, login), state: options.state, live: options.live, feed: options.feed, report: options.report, refuse });

		// POST /cc/api/act, /cc/api/confirm/<id>, /cc/api/reject/<id>
		if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) return refuse(403, "content type must be application/json");
		const sent = req.headers[CSRF_HEADER];
		if (!csrfValid(secret, login, typeof sent === "string" ? sent : undefined)) return refuse(403, "csrf token missing or invalid");
		const raw = await readActBody(req);
		if (raw === undefined) return refuse(413, "request too large");
		let body: unknown;
		try {
			body = JSON.parse(raw);
		} catch {
			return refuse(400, "request is not JSON");
		}
		if (pendingId !== undefined) return settlePending(res, options.pending!, hooks, { id: pendingId, confirm: confirmId !== undefined, body, login, node, act: options.act, refuse });
		const record = (typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
		const audited = { action: typeof record["action"] === "string" ? record["action"] : null, ...(typeof record["lane"] === "string" ? { lane: record["lane"] } : {}), ...(record["action"] === "answer" && typeof record["id"] === "string" ? { ask: record["id"], form: typeof record["option"] === "string" ? "tap" : "words" } : {}), ...(record["action"] === "card" ? cardAudit(record) : {}), ...(record["action"] === "message" && isMessageTarget(record["to"]) ? { to: record["to"] } : {}), ...(isMessageAction(record["action"]) && typeof record["draftId"] === "string" && /^[0-9a-f]{16}$/.test(record["draftId"]) ? { draft: record["draftId"] } : {}), login, node };
		// Intent first: if the line cannot be written, nothing runs.
		try {
			hooks.audit("(cc:act)", audited, null, false, undefined, "intent");
		} catch {
			json(res, 500, { error: "gateway error" });
			return;
		}
		let outcome: ActOutcome;
		try {
			outcome = await options.act(body);
		} catch {
			outcome = { status: 500, body: { error: "the action failed" } };
		}
		const text = json(res, outcome.status, outcome.body);
		const reason = outcome.status >= 400 ? String(outcome.body["error"] ?? "refused") : undefined;
		try {
			hooks.audit("(cc:act)", { ...audited, status: outcome.status, ...(typeof outcome.body["messageId"] === "string" ? { messageId: outcome.body["messageId"] } : {}), ...(isMessageAction(record["action"]) && typeof outcome.body["thread"] === "string" ? { thread: outcome.body["thread"] } : {}), ...(isMessageAction(record["action"]) && typeof outcome.body["draftId"] === "string" && /^[0-9a-f]{16}$/.test(outcome.body["draftId"]) ? { newDraft: outcome.body["draftId"] } : {}) }, Buffer.byteLength(text), outcome.status >= 400, reason, "result");
		} catch {
			// The intent line is on record.
		}
	};
}

/** Where the gateway's repository keeps the two scripts the page calls. */
export function commandCenterScripts(repoRoot: string): { gate: string; pause: string } {
	// The gate moved with muster (OL12-D8): it sits in this package's own
	// `scripts/` folder, found beside this file (S10's own-package rule). The
	// pause helper stays in Pi's profile, so it keeps the repository path.
	return { gate: join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "heavy-gate.sh"), pause: join(repoRoot, "scripts", "heavy-gate-pause.sh") };
}
