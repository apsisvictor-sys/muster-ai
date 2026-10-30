import "./muster-test-isolation.ts";
/**
 * The harness flip's preflight refuses one thing and reports the rest (RD10, VR24-229 item 7,
 * and Henry's ruling of 2026-10-29 as the acceptance).
 *
 * The defect: `scripts/muster-release.sh flip <sha>` refused every real switch, because
 * preflight 4 listed interactive Pi sessions and helper processes as processes the flip had
 * to wait for, and no orchestrator may kill a session. The five behaviours the fix states:
 *
 * 1. A live worker lane still refuses the flip, exactly as before: a lane is mid-task.
 * 2. An interactive session and a helper are restart-needed, listed by pid, start time and
 *    class, and they do not refuse the flip. A session picks the new code up on its own next
 *    start; a helper is restarted by the release script's own step.
 * 3. The classification is the preflight owner's: one function decides it, here.
 *
 * The process list is injected through the tool's own port, so nothing reads live /proc.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	harnessFlipChecks,
	restartClassOf,
	restartNeededCheck,
	type LedgerTool,
	type MusterProcessRow,
	type ProcRow,
} from "../cli/ledger.ts";

const LANDING = "1".repeat(40);
const LANDING_MS = 1_760_000_000_000;
const BEFORE = LANDING_MS - 60_000;
const AFTER = LANDING_MS + 60_000;

type Box = { root: string; stateDir: string; leasesDir: string; close: () => void };

function box(): Box {
	const root = mkdtempSync(join(tmpdir(), "muster-restart-needed-"));
	const stateDir = join(root, "state", "muster");
	const leasesDir = join(stateDir, "leases");
	for (const dir of [stateDir, leasesDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
	return { root, stateDir, leasesDir, close: () => rmSync(root, { recursive: true, force: true }) };
}

/** The preflight tool over a fixture: the process list, the lanes and the git answer are the test's. */
function toolFor(b: Box, rows: ProcRow[], overrides: Partial<LedgerTool> = {}): LedgerTool {
	const show = { status: 0, stdout: `${"1".repeat(40)}\t${LANDING_MS / 1000}\n` };
	return {
		stateDir: b.stateDir,
		ledgerDir: b.stateDir,
		socketPath: join(b.stateDir, "musterd.sock"),
		repoRoot: b.root,
		env: {},
		now: () => LANDING_MS + 1_000,
		out: () => {},
		err: () => {},
		git: () => show,
		gitInCode: () => show,
		systemctl: () => ({ status: 1, stdout: "" }),
		leaseHeld: () => false,
		leasesDir: b.leasesDir,
		processes: () => rows,
		processEnv: () => ({}),
		lanes: () => [],
		spoolCount: () => 0,
		...overrides,
	};
}

/** The Pi CLI as the launcher starts it: a binary named `pi`, no lease, no lane. */
function piCli(pid: number, startMs: number): ProcRow {
	return { pid, ppid: 1, comm: "pi", args: [`${"/home/operator/.local/bin"}/pi`], startMs };
}

/** A helper as the units start it: python and node start files under the profile. */
function helper(pid: number, startMs: number, script = "night-watch.py"): ProcRow {
	return { pid, ppid: 1, comm: "python3", args: ["/usr/bin/python3", `/home/operator/.pi/agent/scripts/${script}`], startMs };
}

function processesOf(checks: ReturnType<typeof harnessFlipChecks>): { ok: boolean; detail: string } {
	const found = checks.find((check) => check.check === "processes");
	assert.ok(found, "the harness preflight has a processes check");
	return found;
}

test("an interactive session and a helper are restart-needed, with pid, start time and class, and do not refuse", () => {
	const b = box();
	try {
		const rows = [piCli(4242, BEFORE), helper(102, BEFORE)];
		const check = restartNeededCheck(toolFor(b, rows, {}), LANDING_MS, { profileDir: "/home/operator/.pi/agent" });
		assert.equal(check.ok, true, check.detail);
		assert.match(check.detail, /2 of 2 Muster process\(es\) restart-needed, started before the landing commit/);
		assert.match(check.detail, new RegExp(`interactive-session pid 4242 since ${new Date(BEFORE).toISOString()} pi-cli pi`));
		assert.match(check.detail, new RegExp(`helper pid 102 since ${new Date(BEFORE).toISOString()}`));
		assert.match(check.detail, /night-watch\.py/);
	} finally {
		b.close();
	}
});

test("a process started after the landing commit is not restart-needed", () => {
	const b = box();
	try {
		const check = restartNeededCheck(toolFor(b, [piCli(4242, AFTER)], {}), LANDING_MS, { profileDir: "/home/operator/.pi/agent" });
		assert.equal(check.ok, true, check.detail);
		assert.equal(check.detail, "no process is restart-needed: 1 Muster process(es), all started after the landing commit");
	} finally {
		b.close();
	}
});

test("the class is the preflight's: a session is never restarted underneath itself, a helper is", () => {
	const row = (kind: MusterProcessRow["kind"], where: string): MusterProcessRow => ({ kind, pid: 1, startMs: BEFORE, where, operator: false });
	assert.equal(restartClassOf(row("pi-session", "rs-4211")), "interactive-session");
	assert.equal(restartClassOf(row("muster-wait", "--inbox")), "interactive-session");
	assert.equal(restartClassOf(row("opencode-host", "--lane")), "interactive-session");
	assert.equal(restartClassOf(row("harness", "pi-cli pi")), "interactive-session");
	assert.equal(restartClassOf(row("gateway", "muster-gateway.service")), "helper");
	assert.equal(restartClassOf(row("harness", "pi-profile node")), "helper");
	assert.equal(restartClassOf(row("harness", "pi-profile+harness-tree+toolbelt-mcp node")), "helper");
});

test("a live worker lane still refuses the flip while a session and a helper are only restart-needed", () => {
	const b = box();
	try {
		const lane = { laneId: "rs-4211", harness: "pi", origin: "auto", state: "working", updatedAt: new Date(LANDING_MS + 1_000).toISOString(), taskId: "t-1" };
		const checks = harnessFlipChecks(toolFor(b, [piCli(4242, BEFORE), helper(102, BEFORE)], { lanes: () => [lane as never] }), {
			landing: LANDING,
			roots: { profileDir: "/home/operator/.pi/agent" },
		});
		assert.deepEqual(checks.map((check) => check.check), ["lanes", "processes"]);
		const lanes = checks.find((check) => check.check === "lanes");
		assert.equal(lanes?.ok, false);
		assert.match(lanes?.detail ?? "", /1 live orchestrator worker lane\(s\): rs-4211/);
		const processes = processesOf(checks);
		assert.equal(processes.ok, true, processes.detail);
		assert.match(processes.detail, /interactive-session pid 4242/);
	} finally {
		b.close();
	}
});
