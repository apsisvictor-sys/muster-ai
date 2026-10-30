/**
 * The workspace a `muster` command talks to when nobody names one.
 *
 * Lanes join the shared bus root (`~/.pi/agent`, decided 2026-10-08). A sender
 * that defaulted to its own cwd landed in another Concord workspace: the
 * 16:44 orchestrator send from the BE repo ("Agent pi-fixr6 is not registered
 * in this workspace") and the systemd heartbeat from $HOME (a stray ~/.concord
 * store) on 2026-10-11.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { cliRepoRoot, sharedBusRoot } from "../lib/bus-root.ts";
import { deliverLaneMessage, formatSendOutcome, readableConcordReason } from "../send.ts";

test("the shared bus root is PI_LANES_REPO_ROOT, else PI_CODING_AGENT_DIR, else ~/.pi/agent", () => {
	assert.equal(sharedBusRoot({ HOME: "/home/v" }), "/home/v/.pi/agent");
	assert.equal(sharedBusRoot({ HOME: "/home/v", PI_CODING_AGENT_DIR: "/srv/agent" }), "/srv/agent");
	assert.equal(sharedBusRoot({ HOME: "/home/v", PI_CODING_AGENT_DIR: "/srv/agent", PI_LANES_REPO_ROOT: " /tmp/lab " }), "/tmp/lab");
});

test("a command with no --repo and no CONCORD_REPO_ROOT uses the shared bus root, not its cwd", () => {
	const env = { HOME: "/home/v" };
	assert.equal(cliRepoRoot({ env }), "/home/v/.pi/agent");
});

test("--repo wins over CONCORD_REPO_ROOT, and CONCORD_REPO_ROOT wins over the shared root", () => {
	const env = { HOME: "/home/v", CONCORD_REPO_ROOT: "/work/lane-root" };
	assert.equal(cliRepoRoot({ flag: "/work/explicit", env }), resolve("/work/explicit"));
	assert.equal(cliRepoRoot({ env }), "/work/lane-root");
	assert.equal(cliRepoRoot({ env: { HOME: "/home/v", CONCORD_REPO_ROOT: "  " } }), "/home/v/.pi/agent");
});

test("the Concord workspace header is split from the reason it precedes", () => {
	const raw = "muster: update_work failed: Workspace: ws_L2hvbWUvdmljdG9y (/home/operator)\nAgent orchestrator has no prompt endpoint.";
	assert.equal(readableConcordReason(raw), "Agent orchestrator has no prompt endpoint. (Concord workspace /home/operator)");
	const retried = "muster: update_work failed: Workspace: ws_x (/p/be)\nAgent pi-fixr6 is not registered in this workspace. (after 4 Concord attempts: the lane is enrolled, so its endpoint was not published yet)";
	assert.match(readableConcordReason(retried), /^Agent pi-fixr6 is not registered in this workspace\. \(after 4 Concord attempts.*\) \(Concord workspace \/p\/be\)$/);
	assert.equal(readableConcordReason("muster: update_work failed: recipient has no live endpoint"), "muster: update_work failed: recipient has no live endpoint");
});

test("a message that reached the inbox is reported with the reason, not with the workspace header", async () => {
	const outcome = await deliverLaneMessage(
		{ laneId: "orchestrator", mode: "followup", text: "HEARTBEAT" },
		{
			concord: { callTool: async () => { throw new Error("muster: update_work failed: Workspace: ws_x (/home/operator)\nAgent orchestrator has no prompt endpoint."); } },
			inbox: async () => ({ ok: true, path: "/state/inbox/orchestrator/1.json" }),
			pane: async () => ({ ok: false, command: "none" }),
			log: () => undefined,
		},
	);
	const text = formatSendOutcome(outcome, { laneId: "orchestrator", mode: "followup", text: "x" });
	assert.equal(text, "muster send: delivered to orchestrator by inbox (/state/inbox/orchestrator/1.json); Concord cannot prompt it: Agent orchestrator has no prompt endpoint. (Concord workspace /home/operator)");
	assert.doesNotMatch(text, /Workspace: ws_/);
});
