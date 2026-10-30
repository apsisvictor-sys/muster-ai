import test from "node:test";
import assert from "node:assert/strict";
import { EventWakeOwner, flushAllEventWakeOwners, getEventWakeOwner } from "../event-wake.ts";

const event = (key: string) => ({ text: `payload ${key}`, origin: "fixture", mode: "followUp" as const, dedupeKey: key });

test("extension-specific APIs with separate events facades get separate owners (F3)", () => {
 // Matches pi-mono's real shape: every extension gets its own `events` facade
 // object closing over the shared runtime bus. Owners are per facade; the
 // POLICY is what must be shared across them (next test).
 const first: any = { events: {}, on: () => {}, sendMessage: () => {} };
 const second: any = { events: {}, on: () => {}, sendMessage: () => {} };
 const owner = getEventWakeOwner(first);
 try {
  assert.notEqual(getEventWakeOwner(second), owner, "pi-mono gives each extension its own events facade");
  owner.setMaxWakesPerMinute(3);
  assert.equal(getEventWakeOwner(second).maxWakesPerMinute, 10, "bounds stay per owner");
 } finally { owner.close(); }
});

test("a policy set through one extension admits another extension's queued wake (F3)", () => {
 // Muster sets the policy; background-tasks queues a completion. In pi-mono the
 // two extensions carry different events facades, and the queued wake must be
 // flushed by the same owner the policy was set on.
 const sent: any[] = [];
 const muster: any = { events: {}, on: () => {}, sendMessage: (m: any, o: any) => sent.push({ message: m, options: o }) };
 const background: any = { events: {}, on: () => {}, sendMessage: (m: any, o: any) => sent.push({ message: m, options: o }) };
 const musterOwner = getEventWakeOwner(muster);
 musterOwner.setPolicy(() => true);
 const backgroundOwner = getEventWakeOwner(background);
 try {
  assert.notEqual(backgroundOwner, musterOwner, "owners stay per extension");
  backgroundOwner.request(event("bg-done"));
  assert.equal(sent.length, 1, "muster's policy admits the producer's queued wake");
  assert.match(sent[0].message.content, /Event from fixture/);
  assert.equal(sent[0].options.triggerTurn, true, "the wake must start a run");
 } finally { backgroundOwner.close(); }
});

test("extension-specific APIs with a shared events object share one owner and one bound", () => {
 const events = {};
 const first: any = { events, on: () => {}, sendMessage: () => {} };
 const second: any = { events, on: () => {}, sendMessage: () => {} };
 const owner = getEventWakeOwner(first);
 try {
  assert.equal(getEventWakeOwner(second), owner);
  owner.setMaxWakesPerMinute(3);
  assert.equal(getEventWakeOwner(second).maxWakesPerMinute, 3);
  assert.throws(() => owner.setMaxWakesPerMinute(0), /positive integer/);
 } finally { owner.close(); }
});

test("session shutdown and restart reuse one event subscription without reviving the old owner", () => {
 const listeners = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
 const sent: any[] = [];
 const pi: any = {
  events: {},
  on: (name: string, listener: (event: unknown, ctx: unknown) => void) => {
   const current = listeners.get(name) ?? [];
   current.push(listener);
   listeners.set(name, current);
  },
  sendMessage: (message: any, options: any) => sent.push({ message, options }),
 };
 const restartedContext = { session: "restarted" };
 const fire = (name: string) => {
  const context = name === "session_start" ? restartedContext : {};
  for (const listener of listeners.get(name) ?? []) listener({}, context);
 };
 const first = getEventWakeOwner(pi);
 first.setPolicy(() => true);
 first.request(event("before-shutdown"));
 assert.equal(sent.length, 1);
 const listenerCounts = [...listeners].map(([name, handlers]) => [name, handlers.length]);
 fire("session_shutdown");
 first.request(event("after-shutdown"));
 assert.equal(sent.length, 1, "closed owner cannot send after shutdown");
 fire("session_start");
 const second = getEventWakeOwner(pi);
 assert.notEqual(second, first);
 assert.equal(first.request(event("closed")), "closed");
 assert.deepEqual([...listeners].map(([name, handlers]) => [name, handlers.length]), listenerCounts);
 let admittedContext: unknown;
 second.setPolicy((_request, context) => { admittedContext = context; return true; });
 second.request(event("after-restart"));
 assert.equal(admittedContext, restartedContext, "new owner receives the restarted session context");
 assert.equal(sent.length, 2, "new session has one live owner");
 second.close();
});

test("wake retains payload without owner policy, then sends one event-labelled custom message", () => {
 const messages: any[] = [];
 const owner = new EventWakeOwner((message, options) => messages.push({ message, options }));
 owner.request(event("one"));
 owner.request(event("one"));
 assert.equal(messages.length, 0);
 owner.setPolicy(() => true);
 assert.equal(messages.length, 1);
 assert.match(messages[0].message.content, /Event from fixture/);
 assert.match(messages[0].message.content, /payload one/);
 assert.deepEqual(messages[0].options, { triggerTurn: true, deliverAs: "followUp" });
 owner.request(event("one"));
 assert.equal(messages.length, 1);
 owner.close();
});

test("pressing Enter is not a wake flush point", () => {
 const listeners = new Map<string, Array<() => void>>();
 const pi: any = {
  events: {},
  on: (name: string, listener: () => void) => {
   const current = listeners.get(name) ?? [];
   current.push(listener);
   listeners.set(name, current);
  },
  sendMessage: () => {},
 };
 const owner = getEventWakeOwner(pi);
 try {
  assert.equal(listeners.has("input"), false, "an operator submit must not flush a pending hook");
  assert.equal(listeners.has("agent_settled"), true, "an idle session still wakes when the run settles");
 } finally { owner.close(); }
});

test("a hold change re-flushes a wake retained in another extension's owner (F3)", () => {
 // Muster's hold denies the producer's wake; when the hold releases, muster
 // flushes ALL owners — a release must not strand a pending event in an owner
 // muster itself does not hold a reference to.
 const sent: any[] = [];
 const muster: any = { events: {}, on: () => {}, sendMessage: (m: any, o: any) => sent.push({ message: m, options: o }) };
 const background: any = { events: {}, on: () => {}, sendMessage: (m: any, o: any) => sent.push({ message: m, options: o }) };
 let admit = false;
 const musterOwner = getEventWakeOwner(muster);
 musterOwner.setPolicy(() => admit);
 const backgroundOwner = getEventWakeOwner(background);
 try {
  backgroundOwner.request(event("held-while-busy"));
  assert.equal(sent.length, 0, "hold retains the event");
  admit = true;
  flushAllEventWakeOwners();
  assert.equal(sent.length, 1, "the hold release reached the producer's owner");
 } finally { backgroundOwner.close(); }
});

test("one policy owns all holds; rate cap retains events and failed sends remain retryable", () => {
 let now = 0;
 let held = true;
 let fail = false;
 const messages: any[] = [];
 const owner = new EventWakeOwner((message, options) => {
  if (fail) throw new Error("fixture send failure");
  messages.push({ message, options });
 }, { now: () => now, maxWakesPerMinute: 1 });
 owner.setPolicy(() => !held);
 owner.request(event("one"));
 assert.equal(messages.length, 0);
 held = false;
 owner.flush();
 owner.request({ ...event("two"), mode: "steer" });
 assert.equal(messages.length, 1);
 now = 60_000;
 fail = true;
 owner.flush();
 assert.equal(messages.length, 1);
 fail = false;
 owner.flush();
 assert.equal(messages.length, 2);
 assert.equal(messages[1].options.deliverAs, "steer");
 owner.close();
});

test("each extension's own copy of this module shares the one policy, as Pi loads extensions (F3)", async () => {
 // Pi loads every extension with its own jiti and moduleCache: false (pi-mono
 // loader.ts), so Muster and background-tasks each evaluate their own copy of
 // event-wake.ts. A policy kept in module state reaches only Muster's copy.
 const { createJiti } = await import("jiti");
 const path = new URL("../event-wake.ts", import.meta.url).pathname;
 const load = async () => (await createJiti(import.meta.url, { moduleCache: false, fsCache: false }).import(path)) as typeof import("../event-wake.ts");
 const musterCopy = await load();
 const backgroundCopy = await load();
 assert.notEqual(musterCopy.EventWakeOwner, backgroundCopy.EventWakeOwner, "two module copies, as in Pi");
 const sent: any[] = [];
 const muster: any = { events: {}, on: () => {}, sendMessage: (m: any, o: any) => sent.push({ message: m, options: o }) };
 const background: any = { events: {}, on: () => {}, sendMessage: (m: any, o: any) => sent.push({ message: m, options: o }) };
 let admit = false;
 const musterOwner = musterCopy.getEventWakeOwner(muster);
 const backgroundOwner = backgroundCopy.getEventWakeOwner(background);
 try {
  musterOwner.setPolicy(() => admit);
  assert.equal(backgroundOwner.hasPolicy, true, "the producer's copy sees Muster's policy");
  backgroundOwner.request(event("bg-done-copy"));
  assert.equal(sent.length, 0, "the hold retains the event");
  admit = true;
  musterCopy.flushAllEventWakeOwners();
  assert.equal(sent.length, 1, "a hold release in Muster's copy reaches the producer's owner");
  assert.equal(sent[0].options.triggerTurn, true, "the wake must start a run");
 } finally { backgroundOwner.close(); musterOwner.close(); }
});
