import type { ExtensionApiLike, ExtensionContextLike } from "./pi-ports.ts";

export interface EventWakeRequest {
 text: string;
 origin: string;
 mode: "followUp" | "steer";
 dedupeKey: string;
 customType?: string;
 details?: Record<string, unknown>;
 display?: boolean;
 /** Drop an obligation consumed before its retained event could be delivered. */
 isRelevant?: () => boolean;
 onDelivered?: () => void;
}

/**
 * Installed by the existing wake/admission owner, NOT by producers. It must
 * preserve WakePump's breaker, global pause, kill/env, prompt/editor and human
 * input holds, and continuation admission/claim accounting. Missing policy
 * retains events: the common transport cannot infer permission to wake.
 * Retry held events with flush() when that owner's state changes.
 */
export interface EventWakePolicy {
 admit(request: EventWakeRequest, ctx: ExtensionContextLike | undefined): boolean;
 sendFailed?(request: EventWakeRequest, error: unknown): void;
}

type Send = ExtensionApiLike["sendMessage"];

// The wake policy is a per-SESSION concept — one policy owns all holds — but
// the owner transport is per extension: pi 1.0.x hands every extension its own
// ExtensionAPI with its own `events` facade, so keying owners on `pi.events`
// (as this file once did) gave the policy-setting extension (Muster) a
// different owner instance than the producers (background-tasks), whose flush
// then silently retained every event forever. The policy is shared so a
// policy installed through one extension governs events queued by another,
// and it is cleared when an owner's session lifecycle closes. Pi also loads
// every extension with its own jiti and moduleCache: false (pi-mono
// loader.ts), so each extension evaluates its own copy of this file: the
// shared state sits on globalThis, as lib/theme-lifecycle.ts does.
// `owners` holds every live owner, so a hold change can flush producers'
// owners that the holder itself never sees (the policy is shared, the pending
// queues are not).
const SHARED_KEY = Symbol.for("pi.eventWake.session");
const sharedHost = globalThis as unknown as { [SHARED_KEY]?: { policy: EventWakePolicy | undefined; owners: Set<EventWakeOwner> } };
const shared = (sharedHost[SHARED_KEY] ??= { policy: undefined, owners: new Set() });

/** Session-local event transport; no parallel programme/loop-breaker predicate. */
export class EventWakeOwner {
 private readonly pending = new Map<string, EventWakeRequest>();
 private readonly delivered = new Set<string>();
 private timestamps: number[] = [];
 private timer: ReturnType<typeof setTimeout> | undefined;
 private flushing = false;
 private closed = false;
 private ctx: ExtensionContextLike | undefined;
 private cap: number;
 get maxWakesPerMinute(): number { return this.cap; }
 private readonly now: () => number;
 rateLimited = 0;

 constructor(private readonly send: Send, options: { now?: () => number; maxWakesPerMinute?: number } = {}) {
  const cap = options.maxWakesPerMinute ?? 10;
  if (!Number.isInteger(cap) || cap < 1) throw new Error("maxWakesPerMinute must be a positive integer");
  this.cap = cap;
  this.now = options.now ?? Date.now;
  shared.owners.add(this);
 }

 /** Configure the shared bound without changing live settings or hold policy. */
 setMaxWakesPerMinute(cap: number): void {
  if (!Number.isInteger(cap) || cap < 1) throw new Error("maxWakesPerMinute must be a positive integer");
  this.cap = cap;
  this.flush();
 }

 get hasPolicy(): boolean { return shared.policy !== undefined; }
 get isClosed(): boolean { return this.closed; }
 get pendingCount(): number { return this.pending.size; }
 updateContext(ctx: ExtensionContextLike): void { this.ctx = ctx; }

 setPolicy(policy: EventWakePolicy | EventWakePolicy["admit"]): void {
  shared.policy = typeof policy === "function" ? { admit: policy } : policy;
  this.flush();
 }

 request(request: EventWakeRequest): "queued" | "duplicate" | "closed" {
  if (this.closed) return "closed";
  if (!request.text.trim() || !request.origin.trim() || !request.dedupeKey.trim()) throw new Error("wake requires text, origin and dedupeKey");
  if (this.pending.has(request.dedupeKey) || this.delivered.has(request.dedupeKey)) return "duplicate";
  this.pending.set(request.dedupeKey, request);
  this.flush();
  return "queued";
 }

 cancel(dedupeKey: string): void { this.pending.delete(dedupeKey); }

 flush(): void {
  const policy = shared.policy;
  if (this.closed || this.flushing || !policy) return;
  this.flushing = true;
  try {
   for (const [key, request] of this.pending) {
    if (request.isRelevant?.() === false) { this.pending.delete(key); continue; }
    const now = this.now();
    this.timestamps = this.timestamps.filter(at => now - at < 60_000);
    if (this.timestamps.length >= this.maxWakesPerMinute) {
     this.rateLimited += 1;
     if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, Math.max(1, 60_000 - (now - this.timestamps[0])));
      this.timer.unref?.();
     }
     break;
    }
    try {
     if (!policy.admit(request, this.ctx)) continue;
     this.send({
      customType: request.customType ?? "event-wake",
      content: `Event from ${request.origin} (not operator input):\n${request.text}`,
      display: request.display ?? true,
      details: { ...request.details, origin: request.origin, dedupeKey: key, event: true },
     }, { triggerTurn: true, deliverAs: request.mode });
    } catch (error) {
     policy.sendFailed?.(request, error);
     continue;
    }
    this.pending.delete(key);
    this.delivered.add(key);
    this.timestamps.push(now);
    // Delivery is committed before observer callbacks: an observer failure
    // must never cause a second turn or a repeated completion payload.
    try { request.onDelivered?.(); } catch { /* producer still owns durable evidence */ }
   }
  } finally { this.flushing = false; }
 }

 close(): void {
  this.closed = true;
  if (this.timer) clearTimeout(this.timer);
  this.timer = undefined;
  this.pending.clear();
  this.delivered.clear();
  shared.owners.delete(this);
  // A closed owner means its session ended; the policy belonged to that
  // session, so the next one must re-install it (Muster does on session_start).
  if (shared.policy !== undefined) shared.policy = undefined;
 }
}

// ExtensionAPI instances are extension-specific; the runtime event bus is
// shared. Keep one dispatcher set per bus across session restarts, replacing
// only the closed session owner when the next session begins.
interface EventWakeRegistration {
 pi: ExtensionApiLike;
 owner: EventWakeOwner;
 options: { maxWakesPerMinute?: number } | undefined;
}
const owners = new WeakMap<object, EventWakeRegistration>();
function createEventWakeOwner(registration: EventWakeRegistration): EventWakeOwner {
 return new EventWakeOwner((message, delivery) => registration.pi.sendMessage(message, delivery), registration.options);
}

/** Flush every live owner once, e.g. after a hold release or a run settle. */
export function flushAllEventWakeOwners(): void {
 for (const owner of [...shared.owners]) {
  try { owner.flush(); } catch { /* one stuck owner must not strand the rest */ }
 }
}
export function getEventWakeOwner(pi: ExtensionApiLike, options?: { maxWakesPerMinute?: number }): EventWakeOwner {
 const key = pi.events ?? pi;
 const existing = owners.get(key);
 if (existing) {
  existing.pi = pi;
  if (existing.owner.isClosed) existing.owner = createEventWakeOwner(existing);
  return existing.owner;
 }
 const registration: EventWakeRegistration = { pi, owner: undefined as never, options };
 registration.owner = createEventWakeOwner(registration);
 owners.set(key, registration);
 // `input` is not a flush point. It fires inside prompt(), after the editor has
 // already been cleared and before the human text is committed, so a flush here
 // admits the wake (the draft hold sees an empty editor) and sendMessage starts
 // a turn with the hook text instead of the operator's prompt. The prompt is
 // then lost, and triggerTurn does not become a visible run, so the operator
 // has to press Enter again. Idle delivery belongs to agent_settled.
 for (const event of ["session_start", "agent_settled", "tool_result"] as const) {
  pi.on(event, (_event, ctx) => {
   if (event === "session_start" && registration.owner.isClosed) registration.owner = createEventWakeOwner(registration);
   if (registration.owner.isClosed) return;
   registration.owner.updateContext(ctx);
   registration.owner.flush();
  });
 }
 pi.on("session_shutdown", () => { registration.owner.close(); });
 return registration.owner;
}
