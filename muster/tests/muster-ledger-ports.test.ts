/**
 * PB1: in-process task ports. A ledger opened with MUSTERD=1 refuses
 * requestSync, while the ports still read and write through methods.ts.
 * Tests use a temporary directory only — never ~/.pi/agent/state/muster.
 */

import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { LedgerError, requestSync } from "../ledger/client-sync.ts";
import { casUpdate } from "../ledger/methods.ts";
import { openLedger } from "../ledger/open.ts";
import { createTaskPorts } from "../ledger/task-ports.ts";
import { harnessRoot } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

const tempDir = () => mkdtempSync(join(tmpdir(), "ledger-ports-"));
const HARNESS_ROOT = harnessRoot(import.meta.url);

test("requestSync throws inside musterd while a port casRead still returns a fixture row", async () => {
	const dir = tempDir();
	const saved = process.env["MUSTERD"];
	process.env["MUSTERD"] = "1";
	const l = await openLedger(dir);
	try {
		await casUpdate(l, {
			store: "seat",
			id: "fixture",
			expectedRevision: undefined,
			record: { epoch: 1 },
		});
		assert.throws(
			() => requestSync(join(dir, "ledger.sock"), "casRead", { store: "seat", id: "fixture" }),
			(error: unknown) => error instanceof LedgerError && error.message === "requestSync inside musterd",
		);
		const ports = createTaskPorts(l);
		assert.deepEqual(await ports.reconcile.casRead({ store: "seat", id: "fixture" }), {
			record: { epoch: 1 },
			revision: 1,
		});
	} finally {
		await l.close();
		if (saved === undefined) delete process.env["MUSTERD"];
		else process.env["MUSTERD"] = saved;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("live musterd.service environment does not set MUSTER_LEDGER_TASKS", () => {
	const units = [
		join(piAgentDir(), "systemd", "musterd.service"),
		join(HARNESS_ROOT, "muster", "ledger", "musterd.service.template"),
		join(homedir(), ".config", "systemd", "user", "musterd.service"),
	];
	for (const path of units) {
		if (!existsSync(path)) continue;
		const text = readFileSync(path, "utf8");
		assert.equal(
			/MUSTER_LEDGER_TASKS/.test(text),
			false,
			`${path} must not set MUSTER_LEDGER_TASKS`,
		);
	}
});

test("open.ts still registers no task when MUSTER_LEDGER_TASKS is off", async () => {
	const dir = tempDir();
	const saved = process.env["MUSTER_LEDGER_TASKS"];
	delete process.env["MUSTER_LEDGER_TASKS"];
	const l = await openLedger(dir);
	try {
		const inspection = await l.harness.inspect(ctx);
		assert.equal(
			inspection.tasks.filter((task) => task.record.kind.startsWith("muster.")).length,
			0,
		);
	} finally {
		await l.close();
		if (saved === undefined) delete process.env["MUSTER_LEDGER_TASKS"];
		else process.env["MUSTER_LEDGER_TASKS"] = saved;
		rmSync(dir, { recursive: true, force: true });
	}
});
