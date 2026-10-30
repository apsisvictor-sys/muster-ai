/**
 * The one wiring of `deliverLaneMessage` (`muster/send.ts`) for the two senders, `muster send`
 * (cli/send.ts) and the gateway's `lane_send` (cli/gateway.ts). It was built twice, so no test
 * exercised the gateway's own wiring (no-restart blueprint F8).
 *
 * Nothing wired here stops or resumes a Claude session (LD16). A message to a Claude session, live,
 * idle, retired by the daemon or parked, goes to its inbox. `claudeInboxState` only reads whether
 * its process is there, for the outcome text. Pi and OpenCode parked lanes are still relaunched
 * by `parkedLaneResume`.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { resolveAttachment } from "./lib/inbox-attachments.ts";
import { claudeInboxState, isClaudeLane, type ClaudeJob } from "./lib/claude-lane-card.ts";
import { writeInboxMessage } from "./lib/agent-inbox.ts";
import { readLaneCard, type LaneOrigin } from "./lib/lane-card.ts";
import { readClaudeAgentsJson, type ClaudeLaneRow } from "./lib/lane-directory.ts";
import { GATEWAY_AGENT_ID } from "./gateway/state.ts";
import { boundaryReason } from "./ledger/boundary.ts";
import { readBackend } from "./ledger/backend.ts";
import { raiseAsleepEvent } from "./asleep-event.ts";
import { DEFAULT_MAILBOX_ASSIGNEE, DEFAULT_MAILBOX_REPO, flushGrokbotWake, wakeGrokbotGated, type GatedWakeDeps } from "./grokbot-wake.ts";
import { parkedLaneResume, realCloseLanePorts } from "./lane-lifecycle-ports.ts";
import { readLaneRecord } from "./lane-lifecycle.ts";
import { seatHeldBy, seatOf } from "./seats.ts";
import { appendSendLog, awaitLaneArrival, deliverLaneMessage, herdrPaneDelivery, tmuxPaneDelivery, tmuxSessionForHarness, type PaneDelivery, type SendDeps, type SendOutcome, type SendRequest } from "./send.ts";

/** Everything the wiring touches outside the state dir. Each port defaults to the real one. */
export interface LaneSendPorts {
	/** A connected Concord client, or undefined when it could not be reached. */
	concord?: SendDeps["concord"];
	/** `claude agents --json`; default the real CLI. This is the only Claude CLI call a send makes. */
	readRows?: () => readonly ClaudeLaneRow[];
	readJob?: (sessionId: string) => ClaudeJob | undefined;
	pidAlive?: (pid: number) => boolean;
	waiterAlive?: (stateDir: string, laneId: string) => boolean;
	pane?: PaneDelivery;
	now?: () => Date;
	/** False for `--no-verify`: Concord's answer is not checked against the lane's card. */
	confirmArrival?: boolean;
	/** The send log is best-effort; a caller that wants to hear about a failure passes this. */
	onLogError?: (error: unknown) => void;
	/**
	 * Opens a Concord client in the named workspace. With `concord` it lets a send reach a lane that
	 * lives in another workspace than the sender's: the lane's lifecycle record names it
	 * (`repoRoot`), and `concordFor` connects there once and `dispose` closes it. Absent: every
	 * lane is asked in `concord`'s workspace.
	 */
	concordAt?: (repoRoot: string) => Promise<(NonNullable<SendDeps["concord"]> & { close: () => Promise<void> }) | undefined>;
	/** The workspace `concord` is connected to; a lane recorded there needs no second client. */
	senderRoot?: string;
	/** The parked Pi/OpenCode relaunch; default the real launcher. */
	parkedDeps?: Parameters<typeof parkedLaneResume>[2];
	/** The registry and `claude agents` rows `sessionUntouchable` reads for the ASLEEP event; default the real ones. */
	sessionRows?: (laneId: string) => { registryRow?: { origin?: LaneOrigin }; agentsRow?: { kind?: string } };
	/** Does this lane hold a seat (LD24)? Default `laneHoldsSeat`. */
	holdsSeat?: (laneId: string) => boolean;
	/** The Henry wake (`grokbot-wake.ts`); default `gh issue create` in the mailbox repo (`GROKBOT_MAILBOX_REPO`), assigned to `GROKBOT_MAILBOX_ASSIGNEE`. Tests inject a stub. */
	wakeGrokbot?: NonNullable<SendDeps["wakeGrokbot"]>;
	/**
	 * LD35: the muster CLI sets this after its seat admission (requireAgentId),
	 * so the inbox entries this wiring writes carry the relay mark. The
	 * gateway's own wiring (send-deps.ts for `lane_send`) leaves it unset: its
	 * entries carry no launcher authority.
	 */
	relayAdmitted?: true;
}

/** LD24: does the lane (by name or by its session) hold a seat? The answer is the seat owner's (`seatHeldBy`, `seatOf`), read from `<stateDir>/seats`. */
export function laneHoldsSeat(stateDir: string, laneId: string): boolean {
	try {
		const ctx = { stateDir };
		if (seatHeldBy(laneId, ctx) !== undefined) return true;
		const sessionId = readLaneCard(stateDir, laneId)?.sessionId ?? readLaneRecord(stateDir, laneId)?.sessionId;
		return sessionId !== undefined && seatOf(sessionId, ctx).length > 0;
	} catch {
		// An unreadable seat file cannot name a holder; the event only wakes the orchestrator.
		return false;
	}
}

/**
 * A command's captured answer, spawned without a shell. `env` is that child's environment only: it is
 * merged over the process's own for the one spawn and never written back (TICKGH).
 */
export function execCaptured(command: string, args: string[], timeoutMs: number, env?: Readonly<Record<string, string>>): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	return new Promise((resolvePromise) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...(env === undefined ? {} : { env: { ...process.env, ...env } }) });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
		child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolvePromise({ exitCode: null, stdout, stderr: `${stderr}\n(timed out after ${timeoutMs} ms)` });
		}, timeoutMs);
		child.on("error", (error) => {
			clearTimeout(timer);
			resolvePromise({ exitCode: null, stdout, stderr: String(error.message) });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolvePromise({ exitCode: code, stdout, stderr });
		});
	});
}

/** Herdr first (its lanes have a real agent to prompt), then the lane's own tmux window: an enrolled Pi lane lives in tmux and has no Herdr agent. */
function realPane(stateDir: string): PaneDelivery {
	return async (request) => {
		const herdr = await herdrPaneDelivery({ spawn: execCaptured })(request);
		if (herdr.ok) return herdr;
		const session = tmuxSessionForHarness(readLaneCard(stateDir, request.laneId)?.harness);
		const tmux = await tmuxPaneDelivery({ spawn: execCaptured, ...(session !== undefined ? { session } : {}) })(request);
		if (tmux.ok) return tmux;
		return { ok: false, command: `${herdr.command} | ${tmux.command}`, detail: `${herdr.detail ?? "herdr failed"} / ${tmux.detail ?? "tmux failed"}` };
	};
}

/** The Henry wake's live wiring: `gh` through the captured exec, the repo and assignee from the environment, the hourly batch state in `stateDir`. */
function liveWakeDeps(stateDir: string, now?: () => Date): GatedWakeDeps {
	return {
		exec: execCaptured,
		stateDir,
		now: () => (now?.() ?? new Date()).getTime(),
		repo: process.env["GROKBOT_MAILBOX_REPO"]?.trim() || DEFAULT_MAILBOX_REPO,
		assignee: process.env["GROKBOT_MAILBOX_ASSIGNEE"]?.trim() || DEFAULT_MAILBOX_ASSIGNEE,
	};
}

/** The tick calls this every run: messages queued for the hourly Henry wake get their issue once the hour is up. */
export function flushHenryWake(stateDir: string, now?: () => Date): Promise<boolean> {
	return flushGrokbotWake(liveWakeDeps(stateDir, now));
}

/** The `deliverLaneMessage` deps for a sender named `from` (an agent id or the gateway's). */
export function laneSendDeps(stateDir: string, from: string, ports: LaneSendPorts = {}): SendDeps {
	const readRows = ports.readRows ?? (() => readClaudeAgentsJson({}));
	// LC13: the switch decides whether Concord is asked at all. In ledger mode every message goes to
	// the inbox owner (`writeInboxMessage`, the ledger `send`) and the arrival proof decides about
	// the pane; the CLI's own store boundary (DL6) owns a `musterd` that is down.
	const ledgerMode = readBackend(stateDir) === "ledger";
	// One client per foreign workspace for the life of this wiring (a gateway send, a CLI call).
	const opened = new Map<string, Promise<Awaited<ReturnType<NonNullable<LaneSendPorts["concordAt"]>>>>>();
	const concordAt = ports.concordAt;
	const senderRoot = ports.senderRoot === undefined ? undefined : resolve(ports.senderRoot);
	return {
		concord: ports.concord,
		ledgerMode,
		...(concordAt === undefined ? {} : {
			concordFor: async (laneId: string) => {
				const recorded = readLaneRecord(stateDir, laneId)?.repoRoot;
				if (recorded === undefined || resolve(recorded) === senderRoot) return undefined;
				const key = resolve(recorded);
				let client = opened.get(key);
				if (client === undefined) {
					client = concordAt(key).catch((): undefined => undefined);
					opened.set(key, client);
				}
				return client;
			},
			dispose: async () => {
				const clients = [...opened.values()];
				opened.clear();
				for (const client of clients) await (await client)?.close().catch(() => undefined);
			},
		}),
		// An enrolled lane (a card exists) whose Concord endpoint is not published yet is the
		// enrolment race, not a dead lane: give Concord a few seconds before the pane carries the
		// message (2026-10-08).
		endpointless: (laneId) => (laneId === GATEWAY_AGENT_ID ? "the gateway tool outbox_read" : isClaudeLane(stateDir, laneId, readRows) ? `\`muster wait --inbox ${laneId}\`` : undefined),
		inboxState: claudeInboxState(stateDir, {
			readRows,
			...(ports.readJob !== undefined ? { readJob: ports.readJob } : {}),
			...(ports.pidAlive !== undefined ? { pidAlive: ports.pidAlive } : {}),
			...(ports.waiterAlive !== undefined ? { waiterAlive: ports.waiterAlive } : {}),
		}),
		resumeParked: parkedLaneResume(stateDir, from, ports.parkedDeps),
		// LD25: a message queued for an asleep worker lane wakes the orchestrator (at most once per lane per 30 min).
		onAsleep: ({ laneId, why }) => {
			let sessionRows: ReturnType<NonNullable<LaneSendPorts["sessionRows"]>> | undefined;
			try {
				sessionRows = (ports.sessionRows ?? realCloseLanePorts(stateDir, process.env).sessionRows)?.(laneId);
			} catch {
				// Rows that cannot be read leave the record's kind and the protected-lanes file to decide.
			}
			raiseAsleepEvent({ stateDir, laneId, from, why, now: ports.now?.() ?? new Date(), holdsSeat: ports.holdsSeat ?? ((lane) => laneHoldsSeat(stateDir, lane)), ...(sessionRows !== undefined ? { sessionRows } : {}) });
		},
		recipientEnrolled: (laneId) => readLaneCard(stateDir, laneId) !== undefined,
		attachmentPath: (attachmentId) => resolveAttachment(stateDir, attachmentId)?.path,
		wakeGrokbot: ports.wakeGrokbot ?? ((wake) => wakeGrokbotGated({ ...wake, from }, liveWakeDeps(stateDir, ports.now))),
		...(ports.confirmArrival === false
			? {}
			: { confirmArrival: ({ laneId, acceptedAt }: { laneId: string; acceptedAt: number }) => awaitLaneArrival({ laneId, acceptedAt, readCard: (id) => readLaneCard(stateDir, id) }) }),
		pane: ports.pane ?? realPane(stateDir),
		inbox: async (message) => {
			try {
				const messageId = randomUUID();
				const written = writeInboxMessage(stateDir, {
					id: messageId,
					agent: message.laneId,
					from,
					at: (ports.now?.() ?? new Date()).toISOString(),
					text: message.text,
					idempotencyKey: message.idempotencyKey,
					mode: message.mode,
					...(message.taskId !== undefined ? { taskId: message.taskId } : {}),
					source: "send" as const,
					// The relay mark rides only on an admission the CLI made (LD35).
					...(ports.relayAdmitted === true ? { relayAdmitted: true as const } : {}),
					...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
				});
				// Ledger mode (LC7) writes no file, so the owner answers with the id it stored — the
				// first id for a repeated request, this one's otherwise.
				if (ledgerMode) return { ok: true, messageId: written };
				return { ok: true, path: written, messageId };
			} catch (error) {
				// A store that is down belongs to the process boundary (DL6, LC13), not to this adapter:
				// `muster send` must exit 75 with the reason rather than fall back to the pane.
				if (boundaryReason(error) !== undefined) throw error;
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
		log: (record) => {
			try {
				appendSendLog(stateDir, record);
			} catch (error) {
				ports.onLogError?.(error);
			}
		},
		...(ports.now !== undefined ? { now: ports.now } : {}),
	};
}

/** One line for a `lane_send` result from the bus owner's outcome. */
export function sendDetail(outcome: SendOutcome): string {
	switch (outcome.transport) {
		case "concord": return `concord ${outcome.status}${outcome.arrival !== undefined ? ` (${outcome.arrival})` : ""}`;
		case "inbox":
			if (outcome.queued === "waiter") return `queued (inbox; the lane's waiter wakes it) ${outcome.inboxPath ?? outcome.messageId ?? ""}`;
			if (outcome.queued === "no-waiter") return `queued (inbox; no waiter is armed) ${outcome.inboxPath ?? outcome.messageId ?? ""}`;
			if (outcome.queued === "asleep") return `queued (inbox; asleep: ${outcome.asleepWhy ?? "its process is gone"}; read when the session is next opened) ${outcome.inboxPath ?? outcome.messageId ?? ""}`;
			return `inbox ${outcome.inboxPath ?? outcome.messageId ?? ""}`;
		case "resume": return `relaunched the parked lane: ${outcome.detail}`;
		case "pane": return `pane ${outcome.command}`;
		default: return `error: ${outcome.error}`;
	}
}

/**
 * The gateway's `lane_send` delivery: the same owner as `muster send`, sent as the gateway. The
 * Concord client is opened per send and closed again.
 */
export async function gatewayLaneSend(
	request: SendRequest,
	stateDir: string,
	connectConcord: (repoRoot?: string) => Promise<(NonNullable<SendDeps["concord"]> & { close: () => Promise<void> }) | undefined>,
	ports: Omit<LaneSendPorts, "concord"> = {},
): Promise<{ ok: boolean; detail: string }> {
	// Concord is optional: the pane and inbox fallbacks carry the message.
	const concord = await connectConcord().catch(() => undefined);
	try {
		const deps = laneSendDeps(stateDir, GATEWAY_AGENT_ID, { ...ports, concord, concordAt: (repoRoot) => connectConcord(repoRoot) });
		try {
			const outcome = await deliverLaneMessage(request, deps);
			return { ok: outcome.transport !== "none", detail: sendDetail(outcome) };
		} finally {
			await deps.dispose?.();
		}
	} finally {
		await concord?.close().catch(() => undefined);
	}
}
