import "./muster-test-isolation.ts";
/**
 * OL8's second half (spec §7b: "Henry gets the ask verbs and work-item create"): the gateway's
 * `work_item_create` tool.
 *
 * 1. The tool is registered by `createGatewayTools`, is not chat-only, and its argument schema is the
 *    owner's §7a field table plus the required set a create must be told.
 * 2. A full payload creates one record, and the record reads back through the work-item owner with the
 *    defaults filled (harness `pi`, attempt 1, state `draft`) and one create event written by `grokbot`.
 * 3. A payload missing a §7a field is refused with the owner's own reason and nothing is stored.
 * 4. A value the owner refuses (an unknown class) reaches the caller as a refusal, and the store is
 *    still empty: the tool has no path to storage of its own.
 * 5. The create is create-only: the state a caller may name is the owner's pair (`ready` or `idea`),
 *    every other state is refused with a reason that names the pair, and with no state the owner's own
 *    default still stands. The pair is the owner's constant, not a list in this file.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createGatewayTools, ToolRefusal, type GatewayTool, type GatewayToolDeps } from "../gateway/tools.ts";
import { readWorkItem, workItemStore, WORK_ITEM_FIELDS } from "../work-items.ts";

type World = { root: string; muster: string; tools: GatewayTool[] };

function withWorld(run: (world: World) => Promise<void>): Promise<void> {
	return (async () => {
		const root = mkdtempSync(join(tmpdir(), "muster-work-item-tool-"));
		const muster = join(root, "muster");
		mkdirSync(muster, { recursive: true });
		const saved = process.env["PI_MUSTER_STATE_DIR"];
		process.env["PI_MUSTER_STATE_DIR"] = muster;
		const deps: GatewayToolDeps = {
			stateDir: muster,
			lanes: () => [],
			notesRoot: join(root, "notes"),
			agentId: "grokbot",
			sendToOrchestrator: async () => "ok",
		};
		try {
			await run({ root, muster, tools: createGatewayTools(deps) });
		} finally {
			if (saved === undefined) delete process.env["PI_MUSTER_STATE_DIR"];
			else process.env["PI_MUSTER_STATE_DIR"] = saved;
			rmSync(root, { recursive: true, force: true });
		}
	})();
}

const PAYLOAD: Record<string, unknown> = {
	code: "OL8-HENRY",
	heading: "Henry files a work item",
	summary: "a client asks for the register check on the dev branch",
	goal: "out-loop",
	project: "pi-agent",
	kind: "build",
	class: "H2",
	acceptance: "the item reads back with every §7a field filled in",
	source: "Henry, 2026-10-28",
};

function tool(world: World): GatewayTool {
	const found = world.tools.find((candidate) => candidate.name === "work_item_create");
	assert.ok(found !== undefined, "work_item_create is registered by createGatewayTools");
	return found;
}

test("the create tool is registered, is not chat-only, and its schema is the §7a field table", async () => {
	await withWorld(async (world) => {
		const create = tool(world);
		assert.notEqual(create.chatOnly, true, "Henry's chat bearer is the normal caller, and the monitor is read-only by rule, not by a missing tool");
		const properties = Object.keys(create.inputSchema.properties);
		assert.deepEqual(properties, WORK_ITEM_FIELDS.map((field) => field.name));
		assert.deepEqual(create.inputSchema.required, ["code", "heading", "summary", "goal", "project", "kind", "class", "acceptance", "source"]);
		assert.equal(create.inputSchema.additionalProperties, false);
	});
});

test("a full payload creates one record, and it reads back with the defaults filled", async () => {
	await withWorld(async (world) => {
		const answer = await tool(world).run(PAYLOAD);
		assert.match(answer, /created work item OL8-HENRY in state draft/);

		const stored = readWorkItem(workItemStore(), "OL8-HENRY");
		assert.ok(stored !== undefined, "the record is in the work-item store");
		assert.equal(stored.heading, "Henry files a work item");
		assert.equal(stored.harness, "pi");
		assert.equal(stored.attempt, 1);
		assert.equal(stored.state, "draft");
		assert.deepEqual(stored.ownedPaths, []);
		assert.deepEqual(stored.dependencies, []);
		assert.equal(stored.events[0]?.by, "grokbot");
		assert.equal(stored.events[0]?.verb, "create");
	});
});

test("a payload missing a §7a field is refused with the owner's reason and nothing is stored", async () => {
	await withWorld(async (world) => {
		const { acceptance: _dropped, ...withoutAcceptance } = PAYLOAD;
		await assert.rejects(() => tool(world).run(withoutAcceptance), (error: unknown) => error instanceof ToolRefusal && /acceptance is required/.test(error.message));
		assert.equal(readWorkItem(workItemStore(), "OL8-HENRY"), undefined);
	});
});

test("a value the owner refuses reaches the caller as a refusal, and the store stays empty", async () => {
	await withWorld(async (world) => {
		await assert.rejects(
			() => tool(world).run({ ...PAYLOAD, class: "H9" }),
			(error: unknown) => error instanceof ToolRefusal && /class must be one of H1, H2, H3, H4, H5/.test(error.message),
		);
		await assert.rejects(
			() => tool(world).run({ ...PAYLOAD, state: "waiting" }),
			(error: unknown) => error instanceof ToolRefusal && /state must be ready or idea/.test(error.message),
		);
		assert.equal(existsSync(join(world.muster, "work-items", "OL8-HENRY.json")), false);
	});
});

test("the states a create may name are the owner's pair, and the schema names the same pair", async () => {
	const owner = (await import("../work-items.ts")) as { WORK_ITEM_CREATE_STATES?: readonly string[] };
	assert.deepEqual(owner.WORK_ITEM_CREATE_STATES, ["ready", "idea"], "the pair is the work-item owner's constant, not a list in the tool file");
	await withWorld(async (world) => {
		const state = tool(world).inputSchema.properties["state"] as { enum?: string[]; description?: string };
		assert.deepEqual(state.enum, ["ready", "idea"], "the schema says the same pair the tool accepts");
		assert.match(state.description ?? "", /ready/);
		assert.match(state.description ?? "", /idea/);
	});
});

test("every state but the pair is refused, and a refused state stores nothing", async () => {
	await withWorld(async (world) => {
		for (const state of ["done", "launch-uncertain", "gated:dep:OL2", "launched:ol8a", "draft", "waiting"]) {
			await assert.rejects(
				() => tool(world).run({ ...PAYLOAD, state }),
				(error: unknown) => error instanceof ToolRefusal && /state must be ready or idea/.test(error.message),
				`state ${state} must be refused: a create files an item, it never files a record that is already under way`,
			);
		}
		assert.equal(readWorkItem(workItemStore(), "OL8-HENRY"), undefined, "a refused state stores nothing");
	});
});

test("ready and idea are accepted, and the record reads back in that state", async () => {
	await withWorld(async (world) => {
		const ready = await tool(world).run({ ...PAYLOAD, state: "ready" });
		assert.match(ready, /created work item OL8-HENRY in state ready/);
		assert.equal(readWorkItem(workItemStore(), "OL8-HENRY")?.state, "ready");
	});
	await withWorld(async (world) => {
		const idea = await tool(world).run({ ...PAYLOAD, state: "idea" });
		assert.match(idea, /created work item OL8-HENRY in state idea/);
		assert.equal(readWorkItem(workItemStore(), "OL8-HENRY")?.state, "idea");
	});
});
