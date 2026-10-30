import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ledgerDir, openLedger } from "../ledger/open.ts";
import { eventsSince } from "../ledger/methods.ts";
import { musterStateDir } from "../binding.ts";
import { CasFamily, MusterEvent } from "../ledger/schema.ts";

test("a cas record and an event written in one commit survive close and reopen", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ledger-"));
	const first = await openLedger(dir);
	await first.root.commit(async (tx) => {
		const doc = await tx.doc(CasFamily, "seat:orchestrator", { store: "seat", id: "orchestrator" });
		doc.record = { epoch: 1 };
		doc.revision = 1;
		await tx.appendEntry(MusterEvent, first.root.id, { data: { type: "WORKING", text: "", at: 1 } });
	}, ctx);
	await first.close();
	const second = await openLedger(dir);
	const doc = await second.harness.snapshot(CasFamily, "seat:orchestrator", ctx);
	assert.deepEqual(doc, { record: { epoch: 1 }, revision: 1 });
	assert.deepEqual((await eventsSince(second)).map((event) => event.type), ["WORKING"]);
	await second.close();
});

test("the ledger directory is MUSTER_LEDGER_DIR, else the Muster state directory", () => {
	const saved = process.env.MUSTER_LEDGER_DIR;
	try {
		process.env.MUSTER_LEDGER_DIR = join(tmpdir(), "ledger-dir-override");
		assert.equal(ledgerDir(), join(tmpdir(), "ledger-dir-override"));
		delete process.env.MUSTER_LEDGER_DIR;
		assert.equal(ledgerDir(), musterStateDir());
	} finally {
		if (saved === undefined) delete process.env.MUSTER_LEDGER_DIR;
		else process.env.MUSTER_LEDGER_DIR = saved;
	}
});
