#!/usr/bin/env node
/**
 * Muster OpenCode lane host (harness bus A4) — one process per lane.
 *
 * Contract (design §4.1–4.3, decisions HB1–HB6):
 * - starts or adopts `opencode serve` on a free loopback port with a per-lane
 *   password (OPENCODE_SERVER_PASSWORD from the environment wins; otherwise a
 *   random one is generated), and records how to reach it in
 *   `<musterStateDir>/opencode/<laneId>.server.json` (0600) so `opencode attach`
 *   can be pointed at the same server;
 * - writes its lane card through the one owner, `lib/lane-card.ts`
 *   (`writeLaneCard`), at `<musterStateDir>/lanes/<laneId>.json` with the §4.2
 *   fields, every `HEARTBEAT_INTERVAL_MS`;
 *   the state comes from the Pi adapter's derivation
 *   (`muster/lane-card.ts` `computeLaneState`) over OpenCode observations,
 *   plus OpenCode's own `waiting` (an open permission/question request);
 * - subscribes GET /event (SSE) for state and liveness;
 * - files mode: runs `concord inbox watch --agent <laneId> --provider opencode`
 *   in the Concord workspace `--repo-root` (default: CONCORD_REPO_ROOT, else the
 *   lane's cwd) and delivers every message by POST /session/{id}/prompt_async,
 *   exactly once per Concord messageId (its own ledger file, mandatory for
 *   OpenCode);
 * - ledger mode (`<stateDir>/backend.json` names the ledger, LC11): no Concord
 *   child runs and no monitor line is parsed. The lane's mail comes from the
 *   inbox owner (`lib/agent-inbox.ts`), the wake is an in-process subscription
 *   to the ledger's `SENT` entries, and the message document is the delivered
 *   state, so `opencode/<laneId>.ledger.json` is neither read nor written;
 * - implements the four verbs deliver / state / setModel / abort; control
 *   messages use A2's shape, `{ operation: "setModel" | "abort", params }`;
 *   `muster control <lane> stop` is taken from the same control queue and is the
 *   host's own `shutdown()` (its card, server record and children go with it);
 * - registers the Concord MCP server through POST /mcp;
 * - lives only as long as its parent (liveness fd), and on exit clears its card
 *   through the owner (`removeLaneCard`), removes the server record, and tears
 *   both children down.
 *
 * The ledger and the server record live in `<musterStateDir>/opencode`, never in
 * the card directory: the lane directory enumerates every `*.json` there as a
 * card, so a sidecar in that directory would appear as a phantom lane.
 */

import { spawn } from "node:child_process";
import { existsSync, createReadStream, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

import { classifyQuota } from "../routing/quota-classifier.ts";
import { learnQuotaWall, loadPoolConfig } from "../routing/provider-pool.ts";
import { listInboxMessages, markInboxMessageRead } from "./lib/agent-inbox.ts";
import { isLaneControlOutcome, isLaneReportMark, laneCardsDir, readLaneCard, recordLaneControlOutcome, removeLaneCard, writeLaneCard } from "./lib/lane-card.ts";
import { takeLaneControl } from "./lib/lane-control.ts";
import { computeLaneState, loadQuotaShapes } from "./lane-card.ts";
import { atBoundary, atBoundaryAsync } from "./ledger/boundary.ts";
import { readBackend } from "./ledger/backend.ts";
import { createClient } from "./ledger/client.ts";
import { ownerLedgerSocket } from "./ledger/stores.ts";
import {
	EXIT_USAGE,
	MESSAGE_SCAN_QUERY,
	MESSAGE_TAIL_QUERY,
	assistantErrorFrom,
	basicAuthHeader,
	deliveryBody,
	deliveryMessageId,
	formatModelRef,
	interpretControlMessage,
	laneConfigContent,
	laneRuntimeDir,
	ledgerPathFor,
	parseHostArgs,
	parseMonitorLine,
	parseSseChunk,
	readLedger,
	resolveModelSwitch,
	serverRecordPathFor,
	shouldHold,
	withLedgerId,
} from "./opencode-host-lib.mjs";
import { EXIT_REFUSED, laneDatabasePath } from "./lane-database.mjs";

const SIGKILL_GRACE_MS = 2000;
const HEALTH_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 15_000;

const args = parseHostArgs(process.argv);
if (args.error !== undefined) {
	process.stderr.write(`opencode-host: ${args.error}\n`);
	process.exit(EXIT_USAGE);
}

const laneId = args.lane;
const password = process.env.OPENCODE_SERVER_PASSWORD && process.env.OPENCODE_SERVER_PASSWORD.length > 0 ? process.env.OPENCODE_SERVER_PASSWORD : randomBytes(24).toString("base64url");
const auth = basicAuthHeader(password);

let baseUrl = args.endpoint ?? "";
let sessionId = args.session ?? "";
let currentModel = args.modelRef;
let busy = false;
let permissionOpen = false;
let questionOpen = false;
let lastDeltaAt = Date.now();
let lastErrorText = undefined;
/** The ref the recorded wording belongs to; a wall is keyed by the full ref it came from. */
let lastErrorRef = undefined;
/** When the lane was last switched onto another model; wording recorded before it is not that model's. */
let switchedAt = 0;
/** When a turn last started, or 0 when none has started since the last switch. */
let turnStartedAt = 0;
let state = "idle";
let since = Date.now();
let shuttingDown = false;

let serverChild;
let watchChild;
let sseController;
let inboxClient;
let inboxUnsubscribe;
const delivered = new Map(); // messageId → { messageID, at, verified }
const inFlight = new Set(); // messageIds claimed but not yet recorded
const held = [];
const ledgerPath = ledgerPathFor(args.stateDir, laneId);
const serverRecordPath = serverRecordPathFor(args.stateDir, laneId);
/** True when `<stateDir>/backend.json` names the ledger (LC11); set in `main` before anything runs. */
let ledgerMode = false;
let ledgerIds = [];
// S10: the Concord launchers live under the agent folder the lane launcher passed
// (`--agent-dir`), never beside this file, which moves to the harness repo. Read
// when a child is spawned, not while this module loads.
const launcherPath = (name) => join(args.agentDir, "extensions", "muster", "launchers", name);

const say = (line) => process.stdout.write(`opencode-host[lane ${laneId}]: ${line}\n`);
const warn = (line) => process.stderr.write(`opencode-host[lane ${laneId}]: ${line}\n`);

/** The lane's model as a pool ref (`provider/model`). */
const currentRef = () => formatModelRef(currentModel);

/**
 * Record a provider wording together with the ref that produced it. The wall is keyed
 * by the full ref, so a wording read from a model the lane has left never walls the one
 * it was switched onto.
 */
function noteError(text) {
	lastErrorText = text;
	lastErrorRef = currentRef();
}

/** Back to a clean lane: the wording goes with the ref it belonged to. */
function clearError() {
	lastErrorText = undefined;
	lastErrorRef = undefined;
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

async function api(path, { method = "GET", body, timeoutMs = CALL_TIMEOUT_MS } = {}) {
	const res = await fetch(`${baseUrl}${path}`, {
		method,
		headers: body === undefined ? { Authorization: auth } : { Authorization: auth, "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
	});
	return res;
}

async function apiJson(path, options) {
	const res = await api(path, options);
	const text = await res.text();
	let parsed;
	try {
		parsed = text === "" ? undefined : JSON.parse(text);
	} catch {
		parsed = undefined;
	}
	return { status: res.status, ok: res.ok, body: parsed, text };
}

// ─── Server lifecycle ────────────────────────────────────────────────────────

async function pickFreePort() {
	return await new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			probe.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
		});
	});
}

async function healthy() {
	try {
		const res = await api("/global/health", { timeoutMs: 3000 });
		if (!res.ok) return false;
		const body = await res.json();
		return body?.healthy === true;
	} catch {
		return false;
	}
}

async function waitHealthy(deadlineMs) {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		if (await healthy()) return true;
		if (serverChild !== undefined && serverChild.exitCode !== null) return false;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return false;
}

async function startServer() {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const port = await pickFreePort();
		const child = spawn(args.opencode, ["serve", "--port", String(port), "--hostname", "127.0.0.1", "--pure"], {
			cwd: args.cwd,
			env: { ...process.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_CONFIG_CONTENT: laneConfigContent(process.env.OPENCODE_CONFIG_CONTENT) },
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		child.stdout?.on("data", (chunk) => process.stdout.write(`[opencode] ${chunk}`));
		child.stderr?.on("data", (chunk) => process.stderr.write(`[opencode] ${chunk}`));
		child.on("exit", (code, signal) => {
			if (shuttingDown) return;
			warn(`opencode serve exited code=${code} signal=${signal}`);
			shutdown("opencode serve exited");
		});
		baseUrl = `http://127.0.0.1:${port}`;
		serverChild = child;
		if (await waitHealthy(HEALTH_TIMEOUT_MS)) return;
		warn(`opencode serve on ${baseUrl} never became healthy; retrying`);
		killGroup(child);
		serverChild = undefined;
	}
	throw new Error("opencode serve did not become healthy");
}

function killGroup(child, signal) {
	if (child === undefined || child === null) return;
	const pid = child.pid;
	if (pid !== undefined && pid > 0) {
		try {
			process.kill(-pid, signal);
			return;
		} catch {
			/* fall through to the direct child */
		}
	}
	try {
		child.kill(signal);
	} catch {
		/* already gone */
	}
}

// ─── Session ─────────────────────────────────────────────────────────────────

async function ensureSession() {
	if (sessionId !== "") {
		const existing = await apiJson(`/session/${sessionId}`);
		if (existing.status !== 200) throw new Error(`--session ${sessionId} not found (${existing.status})`);
		const info = existing.body ?? {};
		// Adopting a lane keeps the conversation's model: the session owns it, and
		// an explicit --model still wins.
		if (currentModel === undefined && typeof info.model?.id === "string" && info.model.id !== "") {
			currentModel = { providerID: typeof info.model.providerID === "string" ? info.model.providerID : "opencode", modelID: info.model.id };
			say(`adopted session model ${formatModelRef(currentModel)}`);
		}
		// OpenCode scopes sessions by directory: a lane resumed somewhere else
		// would keep the session but lose its workspace.
		if (typeof info.directory === "string" && info.directory !== "" && resolve(info.directory) !== resolve(args.cwd)) {
			warn(`session directory ${info.directory} differs from --cwd ${args.cwd}`);
		}
		say(`adopted session ${sessionId}`);
		return false;
	}
	const created = await apiJson("/session", { method: "POST", body: currentModel === undefined ? {} : { model: { id: currentModel.modelID, providerID: currentModel.providerID } } });
	if (created.status !== 200 && created.status !== 201) throw new Error(`POST /session failed: ${created.status} ${created.text}`);
	sessionId = created.body?.id ?? "";
	if (sessionId === "") throw new Error("POST /session returned no id");
	say(`created session ${sessionId}`);
	return true;
}

/**
 * The lane's server record (0600): what `opencode attach` needs. The card is the
 * card owner's file and the ledger is the ledger's; this is the runtime secret
 * for the loopback server, so it lives in the harness runtime directory (never
 * in the card directory) and is removed on a clean exit.
 */
function writeServerRecord() {
	try {
		mkdirSync(laneRuntimeDir(args.stateDir), { recursive: true, mode: 0o700 });
		const tmp = `${serverRecordPath}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ laneId, endpoint: baseUrl, sessionId, password }, null, "\t")}\n`, { mode: 0o600 });
		renameSync(tmp, serverRecordPath);
	} catch (error) {
		warn(`server record write failed: ${String(error)}`);
	}
}

function removeServerRecord() {
	try {
		if (existsSync(serverRecordPath)) rmSync(serverRecordPath, { force: true });
	} catch {
		/* a stale secret file is not worth failing the shutdown for */
	}
}

// ─── Concord MCP ─────────────────────────────────────────────────────────────

async function registerMcp() {
	if (args.registerMcp !== true) return;
	const body = {
		name: "concord-mcp",
		config: {
			type: "local",
			command: [launcherPath("concord-mcp")],
			cwd: args.cwd,
			environment: {
				CONCORD_AGENT_ID: laneId,
				CONCORD_REPO_ROOT: args.repoRoot,
				CONCORD_TELEMETRY_DISABLED: "1",
				CONCORD_NO_UPDATE_CHECK: "1",
			},
			enabled: true,
		},
	};
	try {
		const res = await apiJson("/mcp", { method: "POST", body });
		say(res.ok ? "concord-mcp registered" : `concord-mcp registration failed: ${res.status}`);
	} catch (error) {
		warn(`concord-mcp registration error: ${String(error)}`);
	}
}

// ─── SSE ─────────────────────────────────────────────────────────────────────

function noteDelta() {
	lastDeltaAt = Date.now();
}

function handleEvent(event) {
	const properties = event?.properties ?? {};
	const eventSession = properties.sessionID;
	if (typeof eventSession === "string" && eventSession !== sessionId) return;
	switch (event?.type) {
		case "session.idle":
			busy = false;
			noteDelta();
			void refreshAssistantError().then(() => writeCard(Date.now()));
			void flushHeld("session.idle");
			break;
		case "session.status": {
			const type = properties.status?.type;
			busy = type === "busy" || type === "retry";
			// A busy turn is progress and starts clean; the error it ends on arrives as
			// session.error. A retry is the provider refusing, not progress: its message is
			// the wall text, and the activity clock must age, so a session that only ever
			// retries reaches the stall threshold instead of reading "running" for hours
			// (2026-10-18: an OpenCode lane on the free Zen ref read running from 20:30
			// with "Free usage exceeded, subscribe to Go" on every retry status, no wall
			// and no event to the orchestrator).
			if (type === "busy") {
				clearError();
				turnStartedAt = Date.now();
				noteDelta();
			}
			if (type === "retry" && typeof properties.status?.message === "string") noteError(properties.status.message);
			writeCard(Date.now());
			break;
		}
		case "session.error": {
			const error = properties.error ?? {};
			noteError(`${error.name ?? "Error"}: ${error.data?.message ?? ""}`);
			busy = false;
			writeCard(Date.now());
			break;
		}
		case "permission.asked":
			permissionOpen = true;
			writeCard(Date.now());
			break;
		case "permission.replied":
			permissionOpen = false;
			writeCard(Date.now());
			break;
		case "question.asked":
			questionOpen = true;
			writeCard(Date.now());
			break;
		case "question.replied":
		case "question.rejected":
			questionOpen = false;
			writeCard(Date.now());
			break;
		default:
			noteDelta();
			break;
	}
}

async function subscribeEvents() {
	while (!shuttingDown) {
		sseController = new AbortController();
		try {
			const res = await fetch(`${baseUrl}/event`, { headers: { Authorization: auth, Accept: "text/event-stream" }, signal: sseController.signal });
			if (!res.ok || res.body === null) throw new Error(`/event ${res.status}`);
			const decoder = new TextDecoder();
			let rest = "";
			for await (const chunk of res.body) {
				const parsed = parseSseChunk(rest, decoder.decode(chunk, { stream: true }));
				rest = parsed.rest;
				for (const event of parsed.events) handleEvent(event);
			}
		} catch (error) {
			if (shuttingDown) return;
			warn(`event stream ended: ${String(error)}`);
		}
		if (!shuttingDown) await new Promise((resolve) => setTimeout(resolve, 1000));
	}
}

// ─── Delivery ────────────────────────────────────────────────────────────────

/**
 * The host has taken one message off the bus. In files mode that is the host's own
 * ledger file, read at start so a restart does not deliver the same Concord
 * message twice; in ledger mode the message document is the delivered state
 * (LC11), so the file is none of this host's business and the move goes through
 * the inbox owner.
 */
function recordLedger(messageId) {
	ledgerIds = withLedgerId(ledgerIds, messageId);
	if (ledgerMode) {
		atBoundary("muster-opencode-host:mark-delivered", () => markInboxMessageRead(args.stateDir, laneId, messageId), false);
		return;
	}
	try {
		mkdirSync(laneRuntimeDir(args.stateDir), { recursive: true, mode: 0o700 });
		const tmp = `${ledgerPath}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ version: 1, ids: ledgerIds }, null, "\t")}\n`, { mode: 0o600 });
		renameSync(tmp, ledgerPath);
	} catch (error) {
		warn(`ledger write failed: ${String(error)}`);
	}
}

async function sendPrompt({ from, messageId, text }) {
	const messageID = deliveryMessageId(sessionId, messageId);
	const payload = {
		messageID,
		parts: [{ type: "text", text: deliveryBody(text, from, messageId, laneId) }],
		...(currentModel === undefined ? {} : { model: { providerID: currentModel.providerID, modelID: currentModel.modelID } }),
	};
	let res = await api(`/session/${sessionId}/prompt_async`, { method: "POST", body: payload });
	if (res.status === 400) {
		// The harness rejected our message id: deliver without it and prove by body text.
		delete payload.messageID;
		res = await api(`/session/${sessionId}/prompt_async`, { method: "POST", body: payload });
	}
	if (res.status !== 204) {
		const detail = await res.text().catch(() => "");
		warn(`prompt_async ${res.status} for ${messageId}: ${detail.slice(0, 200)}`);
		return false;
	}
	recordLedger(messageId);
	delivered.set(messageId, { messageID: payload.messageID, text: deliveryBody(text, from, messageId, laneId), at: Date.now(), verified: false });
	busy = true;
	noteDelta();
	say(`delivered ${messageId}${payload.messageID === undefined ? " (no message id)" : ""}`);
	return true;
}

/**
 * The lane's first message, sent raw (no delivery wrapper) once for a session this
 * host created, so the lane's first instruction starts with the launcher's
 * lane-worker trigger. An adopted session gets nothing: its conversation already
 * began.
 */
async function sendFirstMessage(text) {
	const trimmed = typeof text === "string" ? text.trim() : "";
	if (trimmed === "") return;
	const payload = {
		parts: [{ type: "text", text: trimmed }],
		...(currentModel === undefined ? {} : { model: { providerID: currentModel.providerID, modelID: currentModel.modelID } }),
	};
	const res = await api(`/session/${sessionId}/prompt_async`, { method: "POST", body: payload });
	if (res.status !== 204) {
		const detail = await res.text().catch(() => "");
		warn(`first message: prompt_async ${res.status}: ${detail.slice(0, 200)}`);
		return;
	}
	busy = true;
	noteDelta();
	say(`first message delivered (${trimmed.split(/\s+/)[0]})`);
}

async function flushHeld(reason) {
	if (held.length === 0) return;
	const batch = held.splice(0, held.length);
	for (const item of batch) {
		if (!claimDelivery(item.messageId)) continue;
		say(`flushing held ${item.messageId} (${reason})`);
		try {
			await sendPrompt(item);
		} finally {
			inFlight.delete(item.messageId);
		}
	}
}

/**
 * One delivery per messageId. A message that is already delivered, still being
 * sent, or waiting in `held` is refused. The claim is synchronous: the watch
 * child can print the same id twice, and a ledger wake can list a held message
 * again, before the first prompt_async returns.
 */
function claimDelivery(messageId) {
	if (ledgerIds.includes(messageId) || delivered.has(messageId) || inFlight.has(messageId)) return false;
	if (held.some((item) => item.messageId === messageId)) return false;
	inFlight.add(messageId);
	return true;
}

async function incoming({ from, messageId, text }) {
	if (!claimDelivery(messageId)) {
		say(`ignored ${messageId}: already handled`);
		return;
	}
	try {
		const control = interpretControlMessage(text);
		if (control !== undefined) {
			recordLedger(messageId);
			await applyControl(control, from);
			return;
		}
		if (shouldHold(args.defaultMode, busy)) {
			held.push({ from, messageId, text });
			say(`held ${messageId} (${args.defaultMode}, session busy)`);
			return;
		}
		await sendPrompt({ from, messageId, text });
	} finally {
		inFlight.delete(messageId);
	}
}

/** Apply one control verb. Resolves to `{ ok, reason? }` for the card's `lastControl`. */
async function applyControl(control, from) {
	if (control.error !== undefined) {
		warn(`control from ${from}: ${control.error}`);
		return { ok: false, reason: control.error };
	}
	if (control.operation === "abort") {
		const result = await abortSession();
		say(`control abort from ${from}: ${result}`);
		return /^(failed|error)/.test(result) ? { ok: false, reason: result } : { ok: true };
	}
	if (control.operation === "setModel") {
		const ref = resolveModelSwitch(control.modelId, currentModel);
		if (ref === undefined) {
			warn(`control setModel from ${from}: no current provider to resolve ${control.modelId}`);
			return { ok: false, reason: `no current provider to resolve ${control.modelId}` };
		}
		const applied = await setSessionModel(ref);
		say(`control setModel from ${from}: ${applied ? formatModelRef(ref) : "failed"}`);
		return applied ? { ok: true } : { ok: false, reason: "model switch failed" };
	}
	return { ok: false, reason: `unknown operation ${control.operation}` };
}

/**
 * The orchestrator's `muster control <lane> <verb>` leaves one request in
 * `<state dir>/control/<lane>.json` (lib/lane-control.ts, the same queue a Pi lane
 * drains). Take it, apply it through the same handler a Concord control message
 * uses, and write the outcome on the card, so the verb is never typed into the TUI.
 */
async function drainQueuedControl() {
	if (shuttingDown) return;
	// The whole turn is the host boundary (LC11, §3.3): with `musterd` down, taking
	// the request and writing the outcome both throw that one error, the turn logs
	// one line a minute and the host carries on.
	await atBoundaryAsync("host", "muster-opencode-host:control", async () => {
		const request = takeLaneControl(args.stateDir, laneId);
		if (request === undefined) return;
		const from = request.from ?? "muster control";
		// A stop is the host's own clean exit: shutdown() removes the card (F4) and the
		// server record, and stops the children it owns. Nothing is signalled from outside.
		if (request.operation === "stop") {
			say(`control stop from ${from}: shutting down`);
			shutdown(`control stop from ${from}`);
			return;
		}
		const modelId = typeof request.params?.modelId === "string" ? request.params.modelId : undefined;
		const control = request.operation === "setModel" && (modelId === undefined || modelId === "")
			? { operation: "setModel", error: "setModel: modelId required" }
			: { operation: request.operation, ...(modelId !== undefined ? { modelId } : {}) };
		const outcome = await applyControl(control, from);
		recordLaneControlOutcome(args.stateDir, laneId, { operation: request.operation, ok: outcome.ok, ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}), at: Date.now() });
	}, undefined);
}

// ─── The four verbs ──────────────────────────────────────────────────────────

async function setSessionModel(ref) {
	try {
		const res = await api(`/api/session/${sessionId}/model`, { method: "POST", body: { model: { id: ref.modelID, providerID: ref.providerID } } });
		if (res.status !== 204) {
			warn(`model switch failed: ${res.status}`);
			return false;
		}
		currentModel = ref;
		// A model switch starts the lane clean: the wording recorded on the ref it left goes
		// with that ref, and no turn has started on the new one yet.
		clearError();
		switchedAt = Date.now();
		turnStartedAt = 0;
		return true;
	} catch (error) {
		warn(`model switch error: ${String(error)}`);
		return false;
	}
}

async function abortSession() {
	try {
		const res = await api(`/session/${sessionId}/abort`, { method: "POST" });
		const text = await res.text().catch(() => "");
		return res.ok ? `${res.status} ${text.trim()}` : `failed ${res.status}`;
	} catch (error) {
		return `error ${String(error)}`;
	}
}

function pendingCount() {
	let pending = 0;
	for (const [, entry] of delivered) if (entry.verified !== true) pending += 1;
	return pending + held.length;
}

// ─── Card and state ──────────────────────────────────────────────────────────

async function refreshFromApi() {
	const wasBusy = busy;
	try {
		const statuses = await apiJson("/session/status");
		const mine = statuses.body?.[sessionId];
		busy = mine?.type === "busy" || mine?.type === "retry";
		if (mine?.type === "busy") turnStartedAt = Date.now();
		permissionOpen = await hasOpenRequest("/permission");
		questionOpen = await hasOpenRequest("/question");
	} catch (error) {
		warn(`state refresh failed: ${String(error)}`);
	}
	// The error is event-driven (session.error, retry status). A busy-to-idle edge
	// the stream missed is the only reason to read the session from here.
	if (wasBusy && !busy) await refreshAssistantError();
	await verifyDelivered();
}

async function hasOpenRequest(path) {
	try {
		const res = await apiJson(path);
		if (!Array.isArray(res.body)) return false;
		return res.body.some((entry) => entry?.sessionID === undefined || entry?.sessionID === sessionId);
	} catch {
		return false;
	}
}

/**
 * Read the newest message for the assistant error of the turn that just ended.
 * The full history is never fetched: it carries every step's patches (megabytes
 * per read, decoded by the server each time). One read runs at a time; a request
 * that arrives meanwhile is folded into one re-read after it.
 */
let errorRead; // the promise of the read in flight
let errorReadAgain = false;
async function refreshAssistantError() {
	if (errorRead !== undefined) {
		errorReadAgain = true;
		return errorRead;
	}
	errorRead = (async () => {
		do {
			errorReadAgain = false;
			try {
				const res = await apiJson(`/session/${sessionId}/message${MESSAGE_TAIL_QUERY}`);
				// Only an assistant message speaks for the turn: a tail that is still the
				// user's prompt leaves what session.error reported.
				//
				// The tail speaks for the turn that just ended, and after a model switch it
				// still carries the turn that ended on the model the lane left. So it replaces
				// the recorded wording only once a turn has started on the current model; until
				// then the lane stays clean, and the wording of a switch arrives on its own ref
				// through the retry status or session.error that recorded it (2026-10-18 22:01:
				// oc-maps kept "Free usage exceeded" through the switch to
				// zai-coding-plan/glm-5.3-flash and stayed quota-walled on the new ref).
				if (Array.isArray(res.body) && res.body.some((entry) => entry?.info?.role === "assistant") && switchedAt <= turnStartedAt) noteError(assistantErrorFrom(res.body));
			} catch {
				/* no history yet */
			}
		} while (errorReadAgain && !shuttingDown);
	})();
	try {
		await errorRead;
	} finally {
		errorRead = undefined;
	}
}

/**
 * Delivery proof (design §4.3 level 2): the delivered message id is readable
 * from the session. The exact-id route is the strong proof; a list scan covers
 * a delivery whose message id the server refused.
 */
async function verifyDelivered() {
	if (delivered.size === 0) return;
	try {
		for (const [, entry] of delivered) {
			if (entry.verified === true) continue;
			if (entry.messageID === undefined) continue;
			const one = await apiJson(`/session/${sessionId}/message/${entry.messageID}`);
			if (one.status === 200) entry.verified = true;
		}
		if (![...delivered.values()].some((entry) => entry.verified !== true && entry.messageID === undefined)) return;
		const listed = await apiJson(`/session/${sessionId}/message${MESSAGE_SCAN_QUERY}`);
		if (!Array.isArray(listed.body)) return;
		const texts = listed.body.map((message) => (Array.isArray(message?.parts) ? message.parts.map((part) => part?.text ?? "").join("\n") : ""));
		for (const [, entry] of delivered) {
			if (entry.verified === true) continue;
			const marker = entry.text.slice(0, 60);
			if (texts.some((text) => text.includes(marker))) entry.verified = true;
		}
	} catch {
		/* verification is best effort; the ledger already guarantees one send */
	}
}

/**
 * Learn a wall through the pool's one owner (D3), keyed by the full ref the wording came
 * from. A wall learning that fails is a bonus lost, never a card lost: the card is the record.
 */
function learnWall(ref, wall, now) {
	try {
		const pool = loadPoolConfig(join(args.agentDir, "provider-pool.json"));
		if (pool.ok) learnQuotaWall(pool.config, ref, wall, now);
	} catch {
		/* the card is the record */
	}
}

/**
 * One card write, through the owner. The state is the Pi adapter's derivation
 * over OpenCode's observations (idle/running from the session status, the last
 * SSE delta for stalled, the last assistant error for a wall), plus OpenCode's
 * own `waiting` when a permission or question request is open.
 */
function writeCard(now) {
	// A card write must never race the final removal on shutdown.
	if (shuttingDown) return;
	const quotaShapes = loadQuotaShapes(args.agentDir);
	const ref = currentRef();
	// The wall is keyed by the full ref: wording recorded on another model is not this one's.
	const errorText = lastErrorRef === ref ? lastErrorText : undefined;
	const derived = computeLaneState({
		isIdle: !busy,
		lastLifecycle: busy ? "agent_start" : "agent_end",
		lastEventAt: lastDeltaAt,
		lastAssistantText: errorText ?? "",
		quotaShapes,
		now,
	});
	const nextState = permissionOpen || questionOpen ? "waiting" : derived;
	let wall = null;
	if (nextState === "quota-walled" && errorText !== undefined) {
		const classification = classifyQuota({ stopReason: "error", errorMessage: errorText }, quotaShapes, now);
		if (classification.quota) {
			wall = {
				shapeId: classification.shapeId,
				...(classification.resetAt !== undefined ? { resetAt: classification.resetAt } : {}),
				...(classification.assumed === true ? { assumed: true } : {}),
			};
		}
	}
	if (nextState !== state) {
		say(`state ${state} → ${nextState}${wall === null ? "" : ` (wall ${wall.shapeId})`}`);
		state = nextState;
		since = now;
		// Learn the wall through the pool's one owner (D3), keyed by the full ref, so the tick
		// that walks laneDefaults.opencode skips a ref that is still walled instead of sending
		// the lane back onto it: the 2026-10-18 21:49-22:01 cycle switched the lane every two
		// minutes because nothing had recorded the wall the switch was moving it off.
		if (wall !== null && ref !== undefined) learnWall(ref, wall, now);
	}
	// The card is rebuilt from scratch at every beat, so what other writers put on it
	// (`muster report` records the lane's last report, a control outcome the verb's
	// result) has to be carried over or it is gone within one heartbeat. The owner's
	// unreachability belongs to the host boundary (LC11, §3.3): one line a minute and
	// this beat writes no card. Any other error keeps its own warning.
	try {
		atBoundary("muster-opencode-host:card", () => {
			const existing = readLaneCard(args.stateDir, laneId);
			const lastReport = isLaneReportMark(existing?.lastReport) ? existing.lastReport : undefined;
			const lastControl = isLaneControlOutcome(existing?.lastControl) ? existing.lastControl : undefined;
			// The tick marks the wall it acted on (`wall.handledAt`) and this beat rebuilds the card
			// from scratch, so the mark is carried over while it is the same wall on the same ref.
			// Same rule as the Pi lane's card tick (`lane-card-tick.ts`); without it the tick acts
			// on one wall at every beat.
			const handledAt =
				wall !== null && existing?.model === ref && existing?.wall?.shapeId === wall.shapeId && existing?.wall?.resetAt === wall.resetAt
					? existing.wall.handledAt
					: undefined;
			writeLaneCard(args.stateDir, {
				laneId,
				harness: "opencode",
				cwd: args.cwd,
				branch: args.branch ?? null,
				state,
				model: formatModelRef(currentModel) ?? null,
				thinking: args.thinking ?? null,
				since,
				updatedAt: now,
				wall: wall === null || handledAt === undefined ? wall : { ...wall, handledAt },
				endpoint: baseUrl,
				pendingIn: pendingCount(),
				sessionId,
				...(lastReport !== undefined ? { lastReport } : {}),
				...(lastControl !== undefined ? { lastControl } : {}),
			});
		}, undefined);
	} catch (error) {
		warn(`card write failed: ${String(error)}`);
	}
}

// A refresh that outlasts the interval (a slow or locked server) must not stack
// a second one behind it; the card is still written so the lane stays alive.
let refreshing = false;
async function heartbeat() {
	if (shuttingDown) return;
	const now = Date.now();
	if (!refreshing) {
		refreshing = true;
		try {
			await refreshFromApi();
		} catch (error) {
			warn(`heartbeat error: ${String(error)}`);
		} finally {
			refreshing = false;
		}
	}
	writeCard(now);
}

// ─── Ledger inbox (LC11) ─────────────────────────────────────────────────────

/**
 * The ledger's wake: `send` appends one `SENT` entry for the address it queued,
 * and the subscription turns that into a drain. The client reconnects on its own
 * and wakes its subscribers once (RECONNECT), so a `musterd` restart does not
 * lose a message that arrived during the outage. A `SENT` entry for another lane
 * is not this lane's mail and does not wake a read.
 */
function startInboxSubscription() {
	const client = createClient(ownerLedgerSocket(args.stateDir));
	inboxClient = client;
	inboxUnsubscribe = client.subscribe({ types: ["SENT"] }, (event) => {
		if (event?.type === "SENT" && typeof event.lane === "string" && event.lane !== laneId) return;
		void drainInbox(`ledger ${event?.type ?? "event"}`);
	});
	// The subscription starts here, so whatever is already waiting is taken now.
	void drainInbox("startup");
}

let draining = false;
let drainAgain = false;

/**
 * Take everything the inbox owner has waiting for this lane and hand it to the
 * same delivery path the Concord monitor fed (LC11). One drain runs at a time; a
 * wake that arrives during one sets a second pass, so a message committed while
 * the drain ran is not missed. The owner is the only reader and `claimDelivery`
 * refuses an id twice, so a repeat delivers nothing again. With `musterd` down
 * the owner throws: the host boundary logs one line a minute and carries on.
 */
async function drainInbox(reason) {
	if (draining) {
		drainAgain = true;
		return;
	}
	draining = true;
	try {
		do {
			drainAgain = false;
			const messages = await atBoundaryAsync("host", "muster-opencode-host:inbox", async () => listInboxMessages(args.stateDir, laneId), []);
			for (const message of messages) {
				try {
					await incoming({ from: message.from, messageId: message.id, text: message.text });
				} catch (error) {
					warn(`delivery error (${reason}): ${String(error)}`);
				}
			}
		} while (drainAgain && !shuttingDown);
	} finally {
		draining = false;
	}
}

// ─── Concord watch child ─────────────────────────────────────────────────────

function startWatch() {
	const command = args.watchCmd ?? [launcherPath("concord"), "inbox", "watch", "--agent", laneId, "--provider", "opencode", "--interval", String(args.interval), "--format", "monitor"];
	watchChild = spawn(command[0], command.slice(1), {
		cwd: args.cwd,
		env: { ...process.env, CONCORD_AGENT_ID: laneId, CONCORD_REPO_ROOT: args.repoRoot, CONCORD_TELEMETRY_DISABLED: "1", CONCORD_NO_UPDATE_CHECK: "1" },
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	let buffer = "";
	watchChild.stdout?.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			const message = parseMonitorLine(line);
			if (message !== undefined) void incoming(message).catch((error) => warn(`delivery error: ${String(error)}`));
			index = buffer.indexOf("\n");
		}
	});
	watchChild.stderr?.on("data", (chunk) => process.stderr.write(`[concord] ${chunk}`));
	watchChild.on("exit", (code, signal) => {
		if (shuttingDown) return;
		warn(`concord watch exited code=${code} signal=${signal}; restarting in 2 s`);
		setTimeout(() => {
			if (!shuttingDown) startWatch();
		}, 2000);
	});
}

// ─── Parent liveness and teardown ────────────────────────────────────────────

/**
 * Clean exit: the card is removed through its owner (a lane that stopped is
 * `gone` to readers by the staleness rule either way), the server record goes
 * with it, and both children are killed with a bounded grace.
 */
function shutdown(reason) {
	if (shuttingDown) return;
	shuttingDown = true;
	say(`shutting down (${reason})`);
	try {
		removeLaneCard(args.stateDir, laneId);
		removeServerRecord();
	} catch {
		/* best effort on the way out */
	}
	sseController?.abort();
	inboxUnsubscribe?.();
	inboxClient?.close();
	killGroup(watchChild, "SIGTERM");
	killGroup(serverChild, "SIGTERM");
	const deadline = Date.now() + SIGKILL_GRACE_MS;
	const tick = () => {
		const alive = [watchChild, serverChild].some((child) => child !== undefined && child.exitCode === null && child.signalCode === null);
		if (!alive || Date.now() >= deadline) {
			killGroup(watchChild, "SIGKILL");
			killGroup(serverChild, "SIGKILL");
			process.exit(0);
		}
		setTimeout(tick, 100);
	};
	setTimeout(tick, 100);
}

if (Number.isInteger(args.livenessFd) && args.livenessFd >= 3) {
	try {
		const liveness = createReadStream(null, { fd: args.livenessFd, autoClose: true });
		liveness.on("data", () => {});
		liveness.on("end", () => shutdown("parent pipe EOF"));
		liveness.on("error", () => shutdown("parent pipe error"));
	} catch (error) {
		warn(`liveness fd ${args.livenessFd} unavailable: ${String(error)}`);
	}
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGHUP", () => shutdown("SIGHUP"));
process.stdout.on("error", () => shutdown("stdout pipe closed"));

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
	// The one database per lane is the whole point of the recipe's --db: a lane
	// that does not name its own would open the agent-wide database and stall with
	// every other lane on SQLite's single writer, so this refuses before anything
	// is started, spawned or written rather than falling back silently.
	const laneDbOverride = (process.env.OPENCODE_DB ?? "").trim();
	if (laneDbOverride === "") {
		process.stderr.write("opencode-host: OPENCODE_DB is not set, so this lane would share the agent-wide database. Start it with scripts/pi-lane-launch.sh --db <absolute path>, which sets OPENCODE_DB=<data>/lanes/<lane>.db.\n");
		process.exit(EXIT_REFUSED);
	}
	const laneDatabase = laneDatabasePath({ lane: laneId, override: laneDbOverride });
	if (laneDatabase.error !== undefined) {
		process.stderr.write(`opencode-host: ${laneDatabase.error}\n`);
		process.exit(EXIT_REFUSED);
	}
	say(`lane database ${laneDatabase.path}`);
	// The switch every owner reads, and the mode this host runs in (LC11). A broken
	// switch file fails here, before anything is started or written, rather than
	// letting the host guess which store its lanes live in.
	ledgerMode = readBackend(args.stateDir) === "ledger";
	if (ledgerMode) say("ledger mode: the inbox owner carries this lane's messages");
	else ledgerIds = readLedger(ledgerPath, readFileSync);
	// The one stall threshold is the owner's; the flag drives its env override
	// rather than introducing a second constant here.
	if (Number.isFinite(args.stalledMinutes) && args.stalledMinutes > 0) process.env.PI_LANES_STALLED_MINUTES = String(args.stalledMinutes);
	if (baseUrl === "") {
		await startServer();
	} else if (!(await healthy())) {
		throw new Error(`--endpoint ${baseUrl} is not a healthy opencode server`);
	}
	say(`server ${baseUrl}`);
	const createdSession = await ensureSession();
	// An adopted session may already end on an error (a wall); read it once.
	await refreshAssistantError();
	writeServerRecord();
	await registerMcp();
	if (createdSession || args.firstMessageOnResume) await sendFirstMessage(args.firstMessage);
	if (ledgerMode) startInboxSubscription();
	else startWatch();
	void subscribeEvents();
	await heartbeat();
	say(`ready: lane=${laneId} session=${sessionId} endpoint=${baseUrl} model=${formatModelRef(currentModel) ?? "unset"} state=${state}`);
	setInterval(() => void heartbeat(), args.heartbeatMs);
	setInterval(() => void drainQueuedControl().catch((error) => warn(`control drain failed: ${String(error)}`)), 2_000);
}

main().catch((error) => {
	warn(`fatal: ${error instanceof Error ? error.message : String(error)}`);
	shutdown("fatal");
});
