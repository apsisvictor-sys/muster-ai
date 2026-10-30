/**
 * Henry's work-item tool (§7b: "Henry gets the ask verbs and work-item create"; spec §10 row OL8).
 *
 * One tool, `work_item_create`. It writes through the work-item owner and nothing else: the same store
 * (`workItemStore()`), the same validator, the same writers (`work-items.ts`). No rule of its own, no
 * state of its own, and no path to storage that a screen or a verb does not also take.
 *
 * It is create-only: the state a caller may name is the owner's pair (`ready` or `idea`), and every
 * other state is refused with the owner's own names. With no state the owner's default still stands.
 *
 * The gateway restarts before Henry can see it: the running process lists the tools it built at
 * startup (impact map §5).
 */

import { createWorkItem, isWorkItemCreateState, workItemStore, WorkItemStateError, WORK_ITEM_CLASSES, WORK_ITEM_CREATE_STATES, WORK_ITEM_FIELDS, WORK_ITEM_HARNESSES, WORK_ITEM_KINDS, WORK_ITEM_STATE_RULE } from "../work-items.ts";
import { ToolRefusal, type GatewayTool } from "./tools.ts";

const FIELD_RULES = new Map(WORK_ITEM_FIELDS.map((field) => [field.name, field]));

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new ToolRefusal(`${key} must be a string`);
	return value;
}

function requiredArg(args: Record<string, unknown>, key: string): string {
	const value = stringArg(args, key);
	if (value === undefined || value.trim() === "") throw new ToolRefusal(`${key} is required: ${FIELD_RULES.get(key)?.rule ?? "see muster schema work-item"}`);
	return value;
}

function listArg(args: Record<string, unknown>, key: string): string[] | undefined {
	const value = args[key];
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new ToolRefusal(`${key} must be an array of strings`);
	return value as string[];
}

/** The schema of the tool's arguments, built from the owner's field table so no rule is restated here. */
function inputSchema(): GatewayTool["inputSchema"] {
	const properties: Record<string, unknown> = {};
	const required: string[] = [];
	for (const field of WORK_ITEM_FIELDS) {
		const type = field.type === "list" ? { type: "array", items: { type: "string" } } : field.type === "count" ? { type: "integer", minimum: 1 } : field.type === "number" ? { type: "integer", minimum: 0 } : { type: "string" };
		properties[field.name] = { ...type, description: field.rule };
		// The fields a create must be told; the rest the owner defaults or fills. CUTOVER's three are the owner's
		// defaults too: an item is created unranked, unestimated and in no sprint unless the caller says otherwise.
		if (!["priority", "points", "sprint", "harness", "brief", "ownedPaths", "dependencies", "attempt", "state"].includes(field.name)) required.push(field.name);
	}
	properties["kind"] = { type: "string", enum: [...WORK_ITEM_KINDS], description: FIELD_RULES.get("kind")!.rule };
	properties["class"] = { type: "string", enum: [...WORK_ITEM_CLASSES], description: FIELD_RULES.get("class")!.rule };
	properties["harness"] = { type: "string", enum: [...WORK_ITEM_HARNESSES], description: FIELD_RULES.get("harness")!.rule };
	properties["state"] = {
		type: "string",
		enum: [...WORK_ITEM_CREATE_STATES],
		description: `the state the item is created in, and only ${WORK_ITEM_CREATE_STATES.join(" or ")}: an item is filed ready to dispatch or captured as an idea. The owner's full state set is ${WORK_ITEM_STATE_RULE}.`,
	};
	return { type: "object", properties, required, additionalProperties: false };
}

/** The one tool: create an item with every §7a field filled in at creation. */
export function workItemTools(): GatewayTool[] {
	return [
		{
			name: "work_item_create",
			description:
				"Create one work item as a validated record, with every §7a field filled in now: code, heading (what the operator reads), summary, goal, project, kind, class, acceptance (what proves it done), source, and optionally priority, points, sprint, harness, brief, ownedPaths, dependencies, attempt and state. The work-item owner validates and stores it; a field that breaks the schema is refused with the owner's own reason. The state may only be ready or idea: a create files an item, it never files a record that is already under way. Read it back with `muster work-items show` once that verb exists, or through the ledger.",
			inputSchema: inputSchema(),
			run: async (args) => {
				const code = requiredArg(args, "code");
				const attempt = args["attempt"];
				if (attempt !== undefined && (typeof attempt !== "number" || !Number.isInteger(attempt))) throw new ToolRefusal("attempt must be an integer of 1 or more");
				const points = args["points"];
				if (points !== undefined && (typeof points !== "number" || !Number.isInteger(points) || points < 0)) throw new ToolRefusal("points must be a whole number of 0 or more");
				const state = stringArg(args, "state");
				if (state !== undefined && !isWorkItemCreateState(state)) {
					throw new ToolRefusal(`state must be ${WORK_ITEM_CREATE_STATES.join(" or ")}: a create files an item, it never files a record that is already under way`);
				}
				try {
					const record = createWorkItem(
						workItemStore(),
						{
							code,
							heading: requiredArg(args, "heading"),
							summary: requiredArg(args, "summary"),
							goal: requiredArg(args, "goal"),
							project: requiredArg(args, "project"),
							kind: requiredArg(args, "kind"),
							class: requiredArg(args, "class"),
							acceptance: requiredArg(args, "acceptance"),
							source: requiredArg(args, "source"),
							...(stringArg(args, "priority") !== undefined ? { priority: stringArg(args, "priority")! } : {}),
							...(typeof points === "number" ? { points } : {}),
							...(stringArg(args, "sprint") !== undefined ? { sprint: stringArg(args, "sprint")! } : {}),
							...(stringArg(args, "harness") !== undefined ? { harness: stringArg(args, "harness")! } : {}),
							...(stringArg(args, "brief") !== undefined ? { brief: stringArg(args, "brief")! } : {}),
							...(listArg(args, "ownedPaths") !== undefined ? { ownedPaths: listArg(args, "ownedPaths")! } : {}),
							...(listArg(args, "dependencies") !== undefined ? { dependencies: listArg(args, "dependencies")! } : {}),
							...(typeof attempt === "number" ? { attempt } : {}),
							...(state !== undefined ? { state } : {}),
						},
						{ by: "grokbot" },
					);
					return `created work item ${record.code} in state ${record.state}\n${record.heading}`;
				} catch (error) {
					if (error instanceof WorkItemStateError) throw new ToolRefusal(error.message);
					throw error;
				}
			},
		},
	];
}
