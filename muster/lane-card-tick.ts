/**
 * Lane card heartbeat — A2 of the harness bus design.
 *
 * Tracks the live observations the extension sees (model, thinking, last
 * assistant text, lifecycle, event timestamp) and writes the lane card every
 * `HEARTBEAT_INTERVAL_MS` (15 s). The card is read by every other lane and by
 * the bus directory (A1, now pi-history's).
 *
 * Stops cleanly on session shutdown. The last write marks the card `gone` so a
 * reader can distinguish a stopped lane from one that simply hasn't published
 * yet.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildLaneCard } from "./lane-card.ts";
// The store's unreachability is a boundary, not a crash in a 15 s timer (LC10, §3.3).
import { atBoundary } from "./ledger/boundary.ts";
import { HEARTBEAT_INTERVAL_MS, isLaneControlOutcome, newerLaneReport, readLaneCard, removeLaneCard, writeLaneCard, type LaneCard, type LaneReportMark, type LaneState } from "./lib/lane-card.ts";
import { takeLaneControl, type LaneControlRequest } from "./lib/lane-control.ts";

const execFileP = promisify(execFile);

/** One observation snapshot the heartbeat uses. */
export interface LaneObservation {
  laneId: string;
  /** The Pi session UUID (F4): the directory keys session files by it. */
  sessionId?: string;
  cwd: string;
  isIdle: boolean | undefined;
  lastLifecycle: "agent_start" | "agent_end" | "none";
  lastEventAt: number | undefined;
  /**
   * The last progress of any kind: a streaming delta, a tool event, a lifecycle
   * edge. Distinct from `lastEventAt` because the stall clock measures silence
   * (2026-10-08: lanes mid-generation read as stalled on the event clock).
   */
  lastActivityAt?: number;
  /** A tool is executing right now. */
  toolInFlight?: boolean;
  /** Epoch ms when the executing tool started; carried to the card as `toolStartedAt`. */
  toolStartedAt?: number;
  lastAssistantText: string;
  /** The last assistant text that was not empty; `null` before the lane has said anything. The card's `lastMessage`. */
  lastMessage?: string | null;
  model: string;
  thinking: string;
  since: number;
  pendingIn: number;
  /** Context window used, 0-100 (the mission table's context column). */
  contextPercent?: number | null;
}

/** Heartbeat state. */
interface TickState {
  timer: ReturnType<typeof setInterval> | undefined;
  observation: LaneObservation;
  /**
   * Re-reads the live observation at each write. `isIdle` and the model change
   * between events, so a card built from the install-time snapshot would be
   * wrong forever — the first enrolled lane would report `idle` while it ran
   * (found on the pilot, 2026-10-08).
   */
  observe?: () => LaneObservation;
  branch: string;
  /** The Muster state dir: the card lives at <stateDir>/lanes. */
  stateDir: string;
  /** The Pi agent dir, where provider-pool.json carries the quota shapes. */
  agentDir: string;
  lastState: LaneState | undefined;
  lastWallText: string;
  /** The lane's last report line, kept across heartbeats. */
  lastReport: LaneReportMark | undefined;
  /** Applies a queued control request (the adapter supplies the real handler). */
  onControl: ((request: LaneControlRequest) => void | Promise<void>) | undefined;
  /** Polls the control queue between heartbeats: a 15 s abort is too slow. */
  controlTimer: ReturnType<typeof setInterval> | undefined;
}

/** How often a lane looks for a control request (check 5). */
export const CONTROL_POLL_MS = 2_000;

const tickStates = new WeakMap<object, TickState>();

/** Read the current branch from a cwd. Empty string on failure. */
export async function readBranch(cwd: string): Promise<string> {
  if (!cwd) return "";
  try {
    const { stdout } = await execFileP("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 3000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

/** Initialise the heartbeat for a session. */
export function startLaneCardHeartbeat(opts: {
  scope: object;
  stateDir: string;
  agentDir: string;
  initial: LaneObservation;
  /** Live re-read of the observation fields at each write. */
  observe?: () => LaneObservation;
  /** Handle a queued control request (`abort`, `stop`, `setModel`). */
  onControl?: (request: LaneControlRequest) => void | Promise<void>;
}): void {
  stopLaneCardHeartbeat(opts.scope);
  const state: TickState = {
    timer: undefined,
    observation: opts.initial,
    observe: opts.observe,
    branch: "",
    stateDir: opts.stateDir,
    agentDir: opts.agentDir,
    lastState: undefined,
    lastWallText: "",
    lastReport: undefined,
    onControl: opts.onControl,
    controlTimer: undefined,
  };
  tickStates.set(opts.scope, state);
  void refreshBranch(state);
  writeOnce(state);
  state.timer = setInterval(() => {
    writeOnce(state);
  }, HEARTBEAT_INTERVAL_MS);
  state.timer.unref?.();
  if (state.onControl !== undefined) {
    state.controlTimer = setInterval(() => {
      applyQueuedControl(state);
    }, CONTROL_POLL_MS);
    state.controlTimer.unref?.();
  }
}

/** Stop the heartbeat and remove the card (session ended cleanly). */
export function stopLaneCardHeartbeat(scope: object): void {
  const state = tickStates.get(scope);
  if (!state) return;
  if (state.timer) clearInterval(state.timer);
  if (state.controlTimer) clearInterval(state.controlTimer);
  tickStates.delete(scope);
  // Mark gone: a reader that checks updatedAt age will see it expired too.
  try {
    removeLaneCard(state.stateDir, state.observation.laneId);
  } catch {
    /* ignore */
  }
}

/** Apply any queued control request for this session now (tests, and a start). */
export function drainLaneControlNow(scope: object): void {
  const state = tickStates.get(scope);
  if (state === undefined) return;
  applyQueuedControl(state);
}

/** Update the live observation; the next heartbeat tick writes the card. */
export function recordLaneCardObservation(scope: object, partial: Partial<LaneObservation>): void {
  const state = tickStates.get(scope);
  if (!state) return;
  state.observation = { ...state.observation, ...partial };
}

/** Force an immediate card write (e.g. on state changes). */
export function flushLaneCardHeartbeat(scope: object): void {
  const state = tickStates.get(scope);
  if (!state) return;
  writeOnce(state);
}

/** Write the card now using the current observation. */
/**
 * Apply one queued control request, if the orchestrator left one.
 *
 * The request is taken (read + removed) before the handler runs, so a refused
 * verb is refused once rather than retried every two seconds. The handler owns
 * the peer boundary and the verb itself; this function only drains the queue.
 */
function applyQueuedControl(state: TickState): void {
  try {
    const request = takeLaneControl(state.stateDir, state.observation.laneId);
    if (request === undefined) return;
    void Promise.resolve(state.onControl?.(request)).catch(() => {
      /* the handler reports its own refusal; the request is already taken */
    });
  } catch {
    /* a control queue that cannot be read never stops the heartbeat */
  }
}

function writeOnce(state: TickState): void {
  const now = Date.now();
  const observation: LaneObservation = { ...state.observation, ...(state.observe?.() ?? {}) };
  // The save is rebuilt from the card that is there, so the read and the write share
  // one boundary: a store that cannot be reached costs this beat its card and one line
  // a minute, and never throws out of the heartbeat (§3.3, LC10).
  try {
    atBoundary("pi-lane-card-tick", () => {
      // A report filed between two heartbeats (by the lane's own tool, or by
      // `muster report` writing the card) is part of the card the heartbeat rebuilds.
      const existing = readLaneCard(state.stateDir, observation.laneId);
      const lastReport = newerLaneReport(state.lastReport, existing?.lastReport);
      // What the lane made of the last control request is written by the adapter,
      // not built here: the heartbeat rebuilds the card every tick, so it must carry
      // the outcome over or a refusal would vanish within 15 s (found live on the
      // first `muster control set-model`, 2026-10-08).
      const lastControl = isLaneControlOutcome(existing?.lastControl) ? existing?.lastControl : undefined;
      const card: LaneCard = buildLaneCard({
        laneId: observation.laneId,
        sessionId: observation.sessionId,
        cwd: observation.cwd,
        branch: state.branch,
        model: observation.model,
        thinking: observation.thinking,
        isIdle: observation.isIdle,
        lastLifecycle: observation.lastLifecycle,
        lastEventAt: observation.lastEventAt,
        ...(observation.lastActivityAt !== undefined ? { lastActivityAt: observation.lastActivityAt } : {}),
        ...(observation.toolInFlight !== undefined ? { toolInFlight: observation.toolInFlight } : {}),
        ...(observation.toolStartedAt !== undefined ? { toolStartedAt: observation.toolStartedAt } : {}),
        lastAssistantText: observation.lastAssistantText,
        ...(observation.lastMessage !== undefined ? { lastMessage: observation.lastMessage } : {}),
        since: observation.since,
        pendingIn: observation.pendingIn,
        agentDir: state.agentDir,
        now,
        ...(lastReport !== undefined ? { lastReport } : {}),
        ...(lastControl !== undefined ? { lastControl } : {}),
        ...(observation.contextPercent !== undefined ? { contextPercent: observation.contextPercent } : {}),
      });
      // muster-tick marks a wall it acted on; the heartbeat rebuilds the wall, so it
      // carries the mark over for the same wall on the same model (DS3).
      if (card.wall !== null && existing?.wall?.handledAt !== undefined && existing.model === card.model
        && existing.wall.shapeId === card.wall.shapeId && existing.wall.resetAt === card.wall.resetAt) {
        card.wall.handledAt = existing.wall.handledAt;
      }
      state.lastReport = lastReport;
      writeLaneCard(state.stateDir, card);
      state.lastState = card.state;
    }, undefined);
  } catch {
    /* a failed write is not fatal; the next tick will retry */
  }
}

async function refreshBranch(state: TickState): Promise<void> {
  if (!state.observation.cwd) return;
  state.branch = await readBranch(state.observation.cwd);
}
