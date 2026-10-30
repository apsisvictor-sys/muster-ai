/**
 * A follow-up reaches a lane through the Concord workspace the lane lives in.
 *
 * A lane publishes its endpoint in the workspace it was launched into (`repoRoot` in its lifecycle
 * record). The shared bus root is the default, but a launch may name another (the BE repository),
 * and the sender used to ask only its own workspace: "Agent oc-maps is not registered in this
 * workspace (after 4 Concord attempts)", then the tmux pane (2026-10-18).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordLaunch } from "../lane-lifecycle.ts";
import { writeLaneCard } from "../lib/lane-card.ts";
import { laneSendDeps } from "../send-deps.ts";
import { deliverLaneMessage, type SendDeps, type SendLogRecord } from "../send.ts";

type Concord = NonNullable<SendDeps["concord"]>;

/** A Concord workspace that knows exactly the agents it was given. */
function workspace(name: string, agents: string[], calls: string[]): Concord & { close: () => Promise<void>; closed: () => number } {
	let closed = 0;
	return {
		callTool: async (_tool, args) => {
			calls.push(`${name}:${String(args["to_agent_id"])}`);
			if (!agents.includes(String(args["to_agent_id"]))) throw new Error(`Workspace: ws_${name}\nAgent ${String(args["to_agent_id"])} is not registered in this workspace.`);
			return { structuredContent: { message_id: `${name}-msg`, status: "pending" } };
		},
		close: async () => { closed += 1; },
		closed: () => closed,
	};
}

function world<T>(run: (stateDir: string) => Promise<T>): Promise<T> {
	const stateDir = mkdtempSync(join(tmpdir(), "muster-send-workspace-"));
	return run(stateDir).finally(() => { rmSync(stateDir, { recursive: true, force: true }); });
}

function enrol(stateDir: string, laneId: string, harness: "pi" | "opencode", repoRoot: string | undefined): void {
	recordLaunch(stateDir, { laneId, harness, cwd: "/work/lane", branch: null, title: "A lane the send fixture writes to", ...(repoRoot !== undefined ? { repoRoot } : {}) });
	writeLaneCard(stateDir, { laneId, harness, cwd: "/work/lane", branch: "lane/x", state: "idle", model: null, thinking: null, since: 1, updatedAt: 1, wall: null });
}

async function send(stateDir: string, laneId: string, bus: ReturnType<typeof workspace>, others: Record<string, ReturnType<typeof workspace>>, opened: string[]): Promise<{ deps: SendDeps; outcome: Awaited<ReturnType<typeof deliverLaneMessage>>; log: SendLogRecord[] }> {
	const log: SendLogRecord[] = [];
	const deps: SendDeps = {
		...laneSendDeps(stateDir, "orchestrator", {
			concord: bus,
			senderRoot: "/bus",
			concordAt: async (root) => { opened.push(root); return others[root]; },
			confirmArrival: false,
			pane: async () => ({ ok: true, command: "tmux send-keys" }),
		}),
		sleep: async () => undefined,
		log: (record) => { log.push(record); },
	};
	const outcome = await deliverLaneMessage({ laneId, mode: "followup", text: "go on" }, deps);
	return { deps, outcome, log };
}

test("a lane recorded in another workspace is asked there, not in the sender's", async () => {
	await world(async (stateDir) => {
		enrol(stateDir, "oc-maps", "opencode", "/be");
		const calls: string[] = [];
		const bus = workspace("bus", [], calls);
		const be = workspace("be", ["oc-maps"], calls);
		const opened: string[] = [];
		const { deps, outcome, log } = await send(stateDir, "oc-maps", bus, { "/be": be }, opened);
		assert.deepEqual(outcome, { transport: "concord", messageId: "be-msg", status: "pending" });
		assert.deepEqual(calls, ["be:oc-maps"], "the sender's workspace is not asked");
		assert.deepEqual(opened, ["/be"]);
		assert.equal(log.at(-1)?.transport, "concord");
		await deps.dispose?.();
		assert.equal(be.closed(), 1, "the client opened for the lane's workspace is closed");
	});
});

test("a lane recorded in the sender's workspace, or with no record of one, is asked in the sender's", async () => {
	await world(async (stateDir) => {
		enrol(stateDir, "pi-a", "pi", "/bus");
		enrol(stateDir, "pi-b", "pi", undefined);
		const calls: string[] = [];
		const bus = workspace("bus", ["pi-a", "pi-b"], calls);
		const opened: string[] = [];
		for (const lane of ["pi-a", "pi-b"]) {
			const { outcome } = await send(stateDir, lane, bus, {}, opened);
			assert.equal(outcome.transport, "concord");
		}
		assert.deepEqual(calls, ["bus:pi-a", "bus:pi-b"]);
		assert.deepEqual(opened, [], "no second client is opened");
	});
});

test("a workspace that cannot be opened leaves the sender's own, and the failure is the usual one", async () => {
	await world(async (stateDir) => {
		enrol(stateDir, "pi-c", "pi", "/gone");
		const calls: string[] = [];
		const bus = workspace("bus", [], calls);
		const { outcome } = await send(stateDir, "pi-c", bus, {}, []);
		assert.equal(outcome.transport, "pane", "the pane still carries it, as before");
		assert.ok(calls.every((call) => call === "bus:pi-c"));
	});
});

test("the client for a foreign workspace is opened once per wiring, however many sends use it", async () => {
	await world(async (stateDir) => {
		enrol(stateDir, "oc-a", "opencode", "/be");
		enrol(stateDir, "oc-b", "opencode", "/be");
		const calls: string[] = [];
		const be = workspace("be", ["oc-a", "oc-b"], calls);
		const opened: string[] = [];
		const deps = laneSendDeps(stateDir, "orchestrator", {
			concord: workspace("bus", [], calls),
			senderRoot: "/bus",
			concordAt: async (root) => { opened.push(root); return be; },
			confirmArrival: false,
		});
		await deliverLaneMessage({ laneId: "oc-a", mode: "followup", text: "one" }, deps);
		await deliverLaneMessage({ laneId: "oc-b", mode: "followup", text: "two" }, deps);
		assert.deepEqual(opened, ["/be"]);
		await deps.dispose?.();
		assert.equal(be.closed(), 1);
	});
});
