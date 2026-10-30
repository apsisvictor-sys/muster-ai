/** The live hub never buffers without bound for a page that stopped reading, and caps how many pages it holds. */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { createLiveHub, MAX_SUBSCRIBERS, MAX_UNREAD_BYTES, PING_MS } from "./command-center-live.ts";

function fakeRes(): ServerResponse & { written: number } {
	const res = new EventEmitter() as unknown as ServerResponse & { written: number; writableLength: number; destroyed: boolean; writableEnded: boolean };
	res.written = 0;
	res.writableLength = 0;
	res.destroyed = false;
	res.writableEnded = false;
	(res as any).writeHead = () => res;
	(res as any).write = (chunk: string) => { res.written += chunk.length; res.writableLength += chunk.length; return false; };
	(res as any).end = () => { res.writableEnded = true; };
	(res as any).destroy = () => { res.destroyed = true; res.emit("close"); };
	return res;
}

const hubAt = (clock: { t: number }) =>
	createLiveHub({
		state: async () => ({ generatedAt: "x", startedAt: "x", panels: {}, recent: [] }) as any,
		composePanels: async () => ({ panels: {} }) as any,
		now: () => new Date(clock.t),
	});

test("a page that never reads is dropped once its unread bytes pass the cap", async () => {
	const clock = { t: 0 };
	const hub = hubAt(clock);
	const res = fakeRes();
	hub.open(res, (v) => v);
	await new Promise((r) => setImmediate(r));
	(res as any).writableLength = MAX_UNREAD_BYTES + 1;
	clock.t += PING_MS;
	await hub.tick();
	assert.equal(res.destroyed, true);
	assert.equal(hub.subscriberCount(), 0);
	hub.close();
});

test("the hub holds at most MAX_SUBSCRIBERS pages, closing the oldest", async () => {
	const clock = { t: 0 };
	const hub = hubAt(clock);
	const all = Array.from({ length: MAX_SUBSCRIBERS + 3 }, () => fakeRes());
	for (const res of all) hub.open(res, (v) => v);
	assert.equal(hub.subscriberCount(), MAX_SUBSCRIBERS);
	assert.equal(all[0].destroyed, true);
	assert.equal(all[all.length - 1].destroyed, false);
	hub.close();
});
