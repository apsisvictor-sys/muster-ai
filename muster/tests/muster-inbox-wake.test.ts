/**
 * A Pi session that holds the orchestrator role is woken by its bus inbox.
 *
 * The transport is the real EventWakeOwner (lib/event-wake.ts) with a stand-in
 * for the session's sendMessage and an admit-everything policy: the Muster wake
 * policy has its own tests (muster-event-wake-policy.test.ts).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countInboxMessages, listInboxMessages, writeInboxMessage } from "../lib/agent-inbox.ts";
import { EventWakeOwner, type EventWakeRequest } from "../../core/event-wake.ts";
import { seatHeldBy } from "../seats.ts";
import { inboxWakeRequest, pollInboxWake, startInboxWake } from "../inbox-wake.ts";
import { mapLaneReport, notifyOrchestrator } from "../lane-report.ts";

function lab(run: (state: string) => void | Promise<void>): Promise<void> | void {
	const state = mkdtempSync(join(tmpdir(), "muster-inbox-wake-"));
	const done = (): void => rmSync(state, { recursive: true, force: true });
	try {
		const result = run(state);
		if (result instanceof Promise) return result.finally(done);
		done();
	} catch (error) {
		done();
		throw error;
	}
}

const note = (state: string, from: string, text: string, at = "2026-10-08T21:00:00.000Z"): string => {
	writeInboxMessage(state, { agent: "orchestrator", from, at, text, idempotencyKey: `${from}:${text}` });
	return listInboxMessages(state, "orchestrator").at(-1)!.id;
};

test("while the orchestrator seat was never claimed, only the session running as that address polls", () =>
	lab((state) => {
		const seats = { stateDir: state };
		assert.equal(seatHeldBy("orchestrator", seats), "orchestrator");
		assert.equal(seatHeldBy(" orchestrator ", seats), "orchestrator");
		assert.equal(seatHeldBy("pi-recall", seats), undefined);
		assert.equal(seatHeldBy(undefined, seats), undefined);
	}));

test("a lane's report starts a turn, and the message is read only once the transport delivered it", () =>
	lab((state) => {
		const sent: Array<{ content: string; deliverAs: string | undefined; triggerTurn: boolean | undefined }> = [];
		const owner = new EventWakeOwner((message, delivery) => { sent.push({ content: String(message.content), deliverAs: delivery?.deliverAs, triggerTurn: delivery?.triggerTurn }); });
		owner.setPolicy({ admit: () => false });
		const review = mapLaneReport({ kind: "review_ready", summary: "recall done", branch: "lane/x", sha: "abc1234" }, undefined);
		assert.ok(review.ok && review.line !== undefined && notifyOrchestrator(state, "pi-recall", review.line));
		assert.equal(pollInboxWake(state, "orchestrator", (wake) => owner.request(wake)), 1);
		assert.equal(sent.length, 0, "held by the policy, nothing sent");
		assert.equal(countInboxMessages(state, "orchestrator"), 1, "a held message stays unread");
		assert.equal(pollInboxWake(state, "orchestrator", (wake) => owner.request(wake)), 0, "the next poll does not queue it twice");

		owner.setPolicy({ admit: () => true });
		assert.equal(sent.length, 1);
		assert.equal(sent[0]!.triggerTurn, true);
		assert.equal(sent[0]!.deliverAs, "followUp");
		assert.match(sent[0]!.content, /pi-recall wrote to orchestrator's bus inbox:\nREVIEW READY: lane\/x@abc1234 — recall done/);
		assert.equal(countInboxMessages(state, "orchestrator"), 0, "delivered, so read");
		assert.equal(pollInboxWake(state, "orchestrator", (wake) => owner.request(wake)), 0);
		owner.close();
	}));

test("a message someone else already read is dropped instead of waking the session", () =>
	lab((state) => {
		const sent: string[] = [];
		const owner = new EventWakeOwner((message) => { sent.push(String(message.content)); });
		owner.setPolicy({ admit: () => false });
		const id = note(state, "oc-ctx", "BLOCKED: x");
		pollInboxWake(state, "orchestrator", (wake) => owner.request(wake));
		// A `muster wait --inbox orchestrator` on the same inbox takes it.
		const request: EventWakeRequest = inboxWakeRequest(state, "orchestrator", listInboxMessages(state, "orchestrator")[0]!);
		assert.equal(request.isRelevant?.(), true);
		rmSync(join(state, "inbox", "orchestrator"), { recursive: true, force: true });
		assert.equal(request.isRelevant?.(), false);
		owner.setPolicy({ admit: () => true });
		assert.deepEqual(sent, [], `message ${id} was read elsewhere`);
		owner.close();
	}));

test("the poll hands the message itself to the request, not only the wake it built", () =>
	lab((state) => {
		const id = note(state, "oc-ctx", "REVIEW READY: lane/x@abc1234 | wake delivery");
		const seen: Array<{ wake: string; id: string; agent: string }> = [];
		pollInboxWake(state, "orchestrator", (wake, message) => {
			seen.push({ wake: wake.dedupeKey, id: message.id, agent: message.agent });
			return "queued";
		});
		// WAKE-DELIVERY: the session's injection needs the delivery's identity and address, so the
		// request receives the inbox message the wake was built from.
		assert.deepEqual(seen, [{ wake: `inbox:orchestrator:${id}`, id, agent: "orchestrator" }]);
	}));

test("startInboxWake polls on a timer, picks up a message written later, and stops", async () => {
	await lab(async (state) => {
		const seen: string[] = [];
		const stop = startInboxWake({ stateDir: () => state, agent: "orchestrator", request: (wake) => { seen.push(wake.text); return "queued"; }, intervalMs: 20 });
		assert.deepEqual(seen, [], "an empty inbox wakes nothing");
		note(state, "oc-ctx", "DISCOVERY READY: plans/x.md");
		await new Promise((resolve) => setTimeout(resolve, 120));
		stop();
		const count = seen.length;
		assert.ok(count >= 1 && seen[0]!.includes("oc-ctx wrote to orchestrator's bus inbox:\nDISCOVERY READY: plans/x.md"));
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.equal(seen.length, count, "stopped");
	});
});
