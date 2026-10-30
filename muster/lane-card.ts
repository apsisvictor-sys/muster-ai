/**
 * Pi lane card — A2 of the harness bus design, the Pi adapter's half.
 *
 * The card contract (shape, state vocabulary, thresholds, file IO) lives in
 * `extensions/lib/lane-card.ts` — one owner for every harness. This module
 * only turns the observations a Pi session can make (ctx.isIdle(), lifecycle
 * events, the last assistant text, the model) into that contract, and reads
 * the quota shapes from provider-pool.json.
 *
 * State per §4.2, as Pi can observe it:
 *   running / idle — ctx.isIdle() with agent_start / agent_end
 *   stalled — a turn is in progress, no tool is executing, and no progress has
 *             been seen for stalledThresholdMs()
 *   quota-walled — the last assistant text matches a quotaShapes entry
 *   gone — never written: the reader concludes it from `updatedAt` (isCardGone)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyQuota, type QuotaShape } from "../routing/quota-classifier.ts";
import { loadPoolConfig } from "../routing/provider-pool.ts";
import { fileProgrammeControlStore, listProgrammeControlRecords, programmeControlStateDir } from "./control.ts";
import { cutLastMessage, stalledThresholdMs, type LaneCard, type LaneControlOutcome, type LaneReportMark, type LaneState } from "./lib/lane-card.ts";
import { reviewMarkForLane, type ReviewMark } from "./merge-queue.ts";

/** Load quotaShapes from provider-pool.json. */
export function loadQuotaShapes(agentDir: string): QuotaShape[] {
  const file = join(agentDir, "provider-pool.json");
  if (!existsSync(file)) return [];
  try {
    const raw = readFileSync(file, "utf8");
    // The owner's parser first: a fully valid pool carries the shapes.
    const result = loadPoolConfig(file);
    if (result.ok) return result.config.quotaShapes ?? [];
    // A reader only needs the shapes list; a pool that fails the stricter
    // whole-file validation still names what a wall looks like, so read them
    // directly rather than silently pretending there are no walls.
    const parsed = JSON.parse(raw) as { quotaShapes?: unknown };
    if (Array.isArray(parsed.quotaShapes)) {
      return parsed.quotaShapes.filter(
        (s): s is QuotaShape =>
          !!s && typeof s === "object" && typeof (s as QuotaShape).id === "string" && typeof (s as QuotaShape).match === "string",
      );
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * The card, with the merge queue's verdict on the lane's own offer (R2): the queue records the verdict, the card
 * reads it. A declared extension of `LaneCard`, so the card's one shape owner keeps that shape and the card file
 * carries the field the reader shows.
 */
export type LaneCardWithReview = LaneCard & { review?: ReviewMark };

/**
 * The newest merge-queue verdict for one lane, read from the queue's own records (R2, §9). A lane is joined to
 * the queue by the offer it made (`offeredBy` is the lane's own agent id); a missing or unreadable queue is no
 * mark, never an error, because a card is a heartbeat and a heartbeat that throws is a dead lane.
 */
export function reviewMarkForLaneCard(laneId: string, controlDir: string = programmeControlStateDir()): ReviewMark | undefined {
  try {
    const scan = listProgrammeControlRecords(fileProgrammeControlStore(controlDir));
    let newest: ReviewMark | undefined;
    for (const record of scan.records.values()) {
      const mark = reviewMarkForLane(record.mergeQueue, laneId);
      if (mark === undefined) continue;
      if (newest === undefined || Date.parse(mark.at) >= Date.parse(newest.at)) newest = mark;
    }
    return newest;
  } catch {
    return undefined;
  }
}

/**
 * Compute the lane state from the extension context, the last assistant text,
 * and the current time.
 *
 * - quota-walled: the last assistant text matches a quotaShapes entry.
 * - running: ctx.isIdle() is false and the last lifecycle was agent_start.
 * - stalled: running, no tool executing, and no progress for stalledThresholdMs().
 * - idle: ctx.isIdle() is true and the last lifecycle was agent_end.
 *
 * The stall clock measures silence, not duration. A turn is work: one
 * generation or one tool call can run past the threshold while the session is
 * plainly alive, and the old rule — the age of `lastEventAt`, which only the
 * lifecycle and message-end hooks refreshed — reported exactly those lanes as
 * stalled (`muster lanes` showed four lanes stalled while each was mid-turn
 * generating, 2026-10-08).
 *
 * Two kinds of silence are not the same. A streaming message that stops
 * emitting deltas is the failure `stalled` exists to catch, so a message is
 * judged by `lastActivityAt`, which every `message_update` refreshes. A tool
 * that is executing is work in its own right — a test run or a build writes
 * nothing for minutes at a time (measured: a 1988 s `bash` call, 2026-10-08) —
 * so an executing tool reads `running` and the card carries `toolStartedAt`, so
 * a watcher can judge the age itself rather than the state lying about it.
 */
export function computeLaneState(opts: {
  isIdle: boolean | undefined;
  lastLifecycle: "agent_start" | "agent_end" | "none";
  lastEventAt: number | undefined;
  /** The last progress of any kind (a stream delta, a tool event, a lifecycle edge). */
  lastActivityAt?: number;
  /** A tool is executing right now; see the note above. */
  toolInFlight?: boolean;
  lastAssistantText: string;
  quotaShapes: QuotaShape[];
  now: number;
}): LaneState {
  const { isIdle, lastLifecycle, lastEventAt, lastAssistantText, quotaShapes, now } = opts;
  const activityAt = opts.lastActivityAt ?? lastEventAt;

  // Quota wall check first — a stuck wall is the most important state.
  if (lastAssistantText) {
    const classification = classifyQuota({ stopReason: "error", errorMessage: lastAssistantText }, quotaShapes, now);
    if (classification.quota) return "quota-walled";
  }

  if (isIdle === true) return "idle";
  if (isIdle === false) {
    if (opts.toolInFlight === true) return "running";
    const wall = activityAt ? now - activityAt : 0;
    if (wall >= stalledThresholdMs()) return "stalled";
    return "running";
  }
  // isIdle unknown: fall back to recency.
  if (activityAt) {
    const wall = now - activityAt;
    if (wall >= stalledThresholdMs()) return "idle";
    return "running";
  }
  return "idle";
}

/**
 * Build a card for the current Pi session.
 * The caller supplies the live observation values from the extension context.
 */
export function buildLaneCard(opts: {
  laneId: string;
  /** The Pi session UUID, so the directory never lists this lane twice (F4). */
  sessionId?: string;
  cwd: string;
  branch: string;
  model: string;
  thinking: string;
  isIdle: boolean | undefined;
  lastLifecycle: "agent_start" | "agent_end" | "none";
  lastEventAt: number | undefined;
  /** The last progress of any kind; see `computeLaneState`. */
  lastActivityAt?: number;
  /** A tool is executing right now. */
  toolInFlight?: boolean;
  /** Epoch ms when the executing tool started; written to the card as `toolStartedAt`. */
  toolStartedAt?: number;
  lastAssistantText: string;
  /** The last assistant text that was not empty (D8); `null` is "nothing said yet". Not read for the state. */
  lastMessage?: string | null;
  since: number;
  pendingIn: number;
  agentDir: string;
  now: number;
  /** The lane's last report line, carried across heartbeats (check 3). */
  lastReport?: LaneReportMark;
  /** What the lane made of the last control request (check 5); written by the adapter. */
  lastControl?: LaneControlOutcome;
  /** Context window used, 0-100. */
  contextPercent?: number | null;
  /** Epoch ms when the tool now executing started (absent when none is). */
  toolStartedAt?: number;
  /** The programme control directory the review verdict is read from; the owner's own default when absent. */
  controlDir?: string;
}): LaneCardWithReview {
  const quotaShapes = loadQuotaShapes(opts.agentDir);
  const state = computeLaneState({
    isIdle: opts.isIdle,
    lastLifecycle: opts.lastLifecycle,
    lastEventAt: opts.lastEventAt,
    ...(opts.lastActivityAt !== undefined ? { lastActivityAt: opts.lastActivityAt } : {}),
    ...(opts.toolInFlight !== undefined ? { toolInFlight: opts.toolInFlight } : {}),
    lastAssistantText: opts.lastAssistantText,
    quotaShapes,
    now: opts.now,
  });
  const card: LaneCardWithReview = {
    laneId: opts.laneId,
    harness: "pi",
    cwd: opts.cwd,
    branch: opts.branch,
    state,
    model: opts.model,
    thinking: opts.thinking,
    since: opts.since,
    updatedAt: opts.now,
    wall: null,
    endpoint: "concord",
    pendingIn: opts.pendingIn,
    ...(opts.lastReport !== undefined ? { lastReport: opts.lastReport } : {}),
    ...(opts.lastControl !== undefined ? { lastControl: opts.lastControl } : {}),
    ...(opts.contextPercent !== undefined ? { contextPercent: opts.contextPercent } : {}),
    ...(opts.lastMessage !== undefined ? { lastMessage: opts.lastMessage === null ? null : cutLastMessage(opts.lastMessage) } : {}),
    ...(opts.toolStartedAt !== undefined ? { toolStartedAt: opts.toolStartedAt } : {}),
    ...(opts.sessionId !== undefined && opts.sessionId !== "" ? { sessionId: opts.sessionId } : {}),
  };
  if (state === "quota-walled" && opts.lastAssistantText) {
    const classification = classifyQuota({ stopReason: "error", errorMessage: opts.lastAssistantText }, quotaShapes, opts.now);
    if (classification.quota) {
      card.wall = {
        shapeId: classification.shapeId,
        ...(classification.resetAt !== undefined ? { resetAt: classification.resetAt } : {}),
        ...(classification.assumed === true ? { assumed: true } : {}),
      };
    }
  }
  // R2: the merge queue's verdict on this lane's offer, when it has one. Absent is "no verdict yet".
  const review = reviewMarkForLaneCard(opts.laneId, opts.controlDir ?? programmeControlStateDir());
  if (review !== undefined) card.review = review;
  return card;
}
