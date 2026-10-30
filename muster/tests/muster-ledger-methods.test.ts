import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendEvent, casRead, casUpdate, commit, eventsSince } from "../ledger/methods.ts";
import { openLedger } from "../ledger/open.ts";

const tempDir = () => mkdtempSync(join(tmpdir(), "ledger-methods-"));

test("an event kept under a repeated request id is appended once and read back by cursor", async () => {
	const l = await openLedger(tempDir());
	await appendEvent(l, { type: "WORKING", lane: "lane-a", text: "first", requestId: "e1" });
	const events = await eventsSince(l);
	const first = events[0];
	assert.ok(first !== undefined);
	assert.equal(events.length, 1);
	assert.equal(first.type, "WORKING");
	assert.equal(first.lane, "lane-a");
	assert.equal(first.text, "first");
	assert.deepEqual(await appendEvent(l, { type: "WORKING", lane: "lane-a", text: "first", requestId: "e1" }), {
		duplicate: true,
	});
	assert.equal((await eventsSince(l)).length, 1);
	await appendEvent(l, { type: "BLOCKED", text: "second", requestId: "e2" });
	assert.deepEqual(
		(await eventsSince(l, first.id)).map((event) => event.type),
		["BLOCKED"],
	);
	await l.close();
});

test("casRead reads a record back after casUpdate wrote it", async () => {
	const l = await openLedger(tempDir());
	assert.equal(await casRead(l, { store: "seat", id: "orchestrator" }), undefined);
	await casUpdate(l, {
		store: "seat",
		id: "orchestrator",
		expectedRevision: undefined,
		record: { epoch: 1 },
	});
	assert.deepEqual(await casRead(l, { store: "seat", id: "orchestrator" }), {
		record: { epoch: 1 },
		revision: 1,
	});
	await l.close();
});

test("casUpdate refuses a stale revision and creates only once", async () => {
	const l = await openLedger(tempDir());
	const created = await casUpdate(l, {
		store: "seat",
		id: "orchestrator",
		expectedRevision: undefined,
		record: { epoch: 1 },
	});
	assert.deepEqual(created, { ok: true, revision: 1 });
	assert.deepEqual(
		await casUpdate(l, {
			store: "seat",
			id: "orchestrator",
			expectedRevision: undefined,
			record: { epoch: 9 },
		}),
		{ ok: false, code: "conflict" },
	);
	assert.deepEqual(
		await casUpdate(l, { store: "seat", id: "orchestrator", expectedRevision: 0, record: { epoch: 9 } }),
		{ ok: false, code: "conflict" },
	);
	assert.deepEqual(
		await casUpdate(l, { store: "seat", id: "orchestrator", expectedRevision: 1, record: { epoch: 2 } }),
		{ ok: true, revision: 2 },
	);
	assert.deepEqual(
		await casUpdate(l, { store: "seat", id: "nobody", expectedRevision: 1, record: { epoch: 2 } }),
		{ ok: false, code: "missing" },
	);
	await l.close();
});

/**
 * An emptied record is an absent record (LC18).
 *
 * `casRead`, `casList` and the store's own `read` already answer absent for a record
 * whose body was emptied — it is how `removeLaneCard` and `takeLaneControl` remove one,
 * because the ledger has no delete. `casUpdate` and `commit` looked at the revision alone,
 * so a caller that read "absent" (a heartbeat creating a card, a control request for a
 * lane whose last request was taken) was refused "already exists" forever, and the card
 * or the control queue for that lane could never be written again.
 */
test("an emptied record is an absent record: a create over it succeeds in both write paths", async () => {
	const l = await openLedger(tempDir());
	const store = { store: "lane-card", id: "lane-a" };
	const card = { laneId: "lane-a", state: "idle" };
	assert.deepEqual(await casUpdate(l, { ...store, expectedRevision: undefined, record: card }), { ok: true, revision: 1 });

	// The removal every owner performs: an expected-revision write of a null record.
	assert.deepEqual(
		await commit(l, { requestId: "remove:lane-card:lane-a:1", cas: [{ ...store, expectedRevision: 1, record: null }], events: [] }),
		{ ok: true, revisions: [2], eventIds: [] },
	);
	assert.deepEqual(await casRead(l, store), { record: null, revision: 2 }, "an emptied record carries no body, which the store answers as absent");

	// A caller holding the emptied record's revision writes nothing back: the record does not
	// exist, exactly as the files store answers once the file is unlinked.
	assert.deepEqual(await casUpdate(l, { ...store, expectedRevision: 2, record: card }), { ok: false, code: "missing" });

	// The create — what `writeLaneCard` and every heartbeat do — succeeds, and the revision
	// still rises, so a writer holding the emptied record's revision stays stale.
	assert.deepEqual(await casUpdate(l, { ...store, expectedRevision: undefined, record: { ...card, state: "running" } }), { ok: true, revision: 3 });
	assert.deepEqual(await casRead(l, store), { record: { ...card, state: "running" }, revision: 3 });

	// `commit`'s own create takes the same rule.
	assert.deepEqual(
		await commit(l, { requestId: "remove:lane-card:lane-a:3", cas: [{ ...store, expectedRevision: 3, record: null }], events: [] }),
		{ ok: true, revisions: [4], eventIds: [] },
	);
	assert.deepEqual(
		await commit(l, { requestId: "create:lane-card:lane-a", cas: [{ ...store, expectedRevision: undefined, record: card }], events: [] }),
		{ ok: true, revisions: [5], eventIds: [] },
	);
	assert.deepEqual(await casRead(l, store), { record: card, revision: 5 });
	await l.close();
});
