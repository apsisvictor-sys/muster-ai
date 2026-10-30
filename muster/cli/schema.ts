/**
 * `muster schema` — one schema per kind in code, printed (spec §7b "Vocabulary", §10 row OL8).
 *
 * The vocabulary is the owner's own constant: `muster schema work-item` prints the §7a field table the
 * validator reads (`WORK_ITEM_FIELDS`), the states the validator accepts and the writers it allows, so
 * a surface, a brief or Henry gets the contract without reading the module. Nothing here restates a
 * rule: every line comes from the owner's constants.
 *
 * Goals (`goals.ts`) and questions (`asks.ts`) keep their own modules; their schemas move here one kind
 * at a time, so this verb never prints a second copy of a vocabulary another owner holds.
 */

import {
	WORK_ITEM_CLASSES,
	WORK_ITEM_CODE_PATTERN,
	WORK_ITEM_DEFAULT_HARNESS,
	WORK_ITEM_FIELDS,
	WORK_ITEM_HARNESSES,
	WORK_ITEM_INITIAL_STATE,
	WORK_ITEM_KINDS,
	WORK_ITEM_SCHEMA_VERSION,
	WORK_ITEM_STATES,
	WORK_ITEM_STATE_PREFIXES,
	WORK_ITEM_STATE_RULE,
	WORK_ITEM_WRITERS,
	listWorkItems,
	workItemStore,
} from "../work-items.ts";
import { backfillRecords, renderGeneratedBacklog } from "../work-items-backlog.ts";
import type { CliCommand, CliContext } from "./types.ts";

/** The kinds this verb prints, each with the owner module that holds its vocabulary. */
const KINDS = [
	{ kind: "work-item", owner: "work-items.ts", summary: "one validated record per item a lane can be launched from (spec §7a, OL8)" },
] as const;

type SchemaPayload = {
	kind: string;
	owner: string;
	schemaVersion: number;
	fields: { name: string; audience: string; type: string; rule: string }[];
	codePattern: string;
	kinds: readonly string[];
	classes: readonly string[];
	harnesses: readonly string[];
	defaultHarness: string;
	states: readonly string[];
	statePrefixes: readonly string[];
	stateRule: string;
	initialState: string;
	writers: readonly string[];
};

function workItemSchema(): SchemaPayload {
	return {
		kind: "work-item",
		owner: "work-items.ts",
		schemaVersion: WORK_ITEM_SCHEMA_VERSION,
		fields: WORK_ITEM_FIELDS.map((field) => ({ name: field.name, audience: field.audience, type: field.type, rule: field.rule })),
		codePattern: WORK_ITEM_CODE_PATTERN.source,
		kinds: WORK_ITEM_KINDS,
		classes: WORK_ITEM_CLASSES,
		harnesses: WORK_ITEM_HARNESSES,
		defaultHarness: WORK_ITEM_DEFAULT_HARNESS,
		states: WORK_ITEM_STATES,
		statePrefixes: WORK_ITEM_STATE_PREFIXES,
		stateRule: WORK_ITEM_STATE_RULE,
		initialState: WORK_ITEM_INITIAL_STATE,
		writers: WORK_ITEM_WRITERS,
	};
}

function printWorkItem(ctx: CliContext, schema: SchemaPayload): void {
	const width = Math.max(...schema.fields.map((field) => field.name.length));
	ctx.io.out(`work item — ${schema.owner}, schema version ${schema.schemaVersion}`);
	for (const audience of ["operator", "machine"] as const) {
		ctx.io.out("");
		ctx.io.out(audience === "operator" ? "for the operator:" : "for the machine:");
		for (const field of schema.fields.filter((candidate) => candidate.audience === audience)) {
			ctx.io.out(`  ${field.name.padEnd(width)}  ${field.type.padEnd(5)}  ${field.rule}`);
		}
	}
	ctx.io.out("");
	ctx.io.out(`states: ${schema.stateRule}; a record is created in ${schema.initialState}`);
	ctx.io.out(`kinds: ${schema.kinds.join(", ")}; classes: ${schema.classes.join(", ")}; harnesses: ${schema.harnesses.join(", ")} (default ${schema.defaultHarness})`);
	ctx.io.out(`writers: ${schema.writers.join(", ")}; a lane is refused`);
	ctx.io.out(`code: ${schema.codePattern}`);
}

export const command: CliCommand = {
	name: "schema",
	summary: "Print the record schema of one kind (the §7a work-item record), as its owner validates it",
	usage: [
		"muster schema                       # the kinds this verb prints",
		`muster schema ${KINDS.map((entry) => entry.kind).join("|")} [--json]`,
		"muster schema work-item --backlog [--backfill]   # the generated backlog, from the records or from the retired hand table's rows",
	].join("\n"),
	async run(ctx) {
		const kind = ctx.argv.find((arg) => !arg.startsWith("-"));
		if (ctx.argv.includes("--backlog")) {
			// The generated view: the store's records, or the retired hand table's rows through the cutover mapping.
			if (ctx.argv.includes("--backfill")) {
				ctx.io.out(renderGeneratedBacklog(backfillRecords()));
				return 0;
			}
			const listing = listWorkItems(workItemStore());
			for (const skipped of listing.skipped) ctx.io.err(`skipped ${skipped.id}: ${skipped.error}`);
			if (listing.items.length === 0) {
				ctx.io.err("muster schema --backlog: the work-item store holds no records yet; --backfill renders the hand-table backfill");
				return 1;
			}
			ctx.io.out(renderGeneratedBacklog(listing.items));
			return 0;
		}
		if (kind === undefined) {
			for (const entry of KINDS) ctx.io.out(`${entry.kind.padEnd(10)} ${entry.summary} (${entry.owner})`);
			ctx.io.out("");
			ctx.io.out("goals and questions keep their schemas in goals.ts and asks.ts; each moves here with its owner's work");
			return 0;
		}
		const known = KINDS.find((entry) => entry.kind === kind);
		if (known === undefined) {
			ctx.io.err(`muster schema: unknown kind ${JSON.stringify(kind)}: one of ${KINDS.map((entry) => entry.kind).join(", ")}`);
			return 2;
		}
		const schema = workItemSchema();
		if (ctx.json) ctx.io.out(JSON.stringify(schema, null, 2));
		else printWorkItem(ctx, schema);
		return 0;
	},
};
