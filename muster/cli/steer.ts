/**
 * `muster steer` — the one door onto the steer journal (S-steer, blueprint
 * `~/research/router-steers-2026-10-29/architecture-v2.md` sections 3, 4 and 7).
 *
 *   muster steer add --action <exclude|demote|prefer> --reason "<why>" [--role <r>|--harness <h>]
 *                    [--ref <provider/model> | --provider <p>] [--account <a>] [--project <p>]
 *                    [--at <ISO> | --meter <provider/account> --fallback-at <ISO> | --review-at <ISO>]
 *                    [--chat "<the words>"] [--json]
 *   muster steer cap --field <claudeMax|hardMax|slots> --value <n> --until <ISO> --reason "<why>"
 *                    [--role <r>] [--harness <h>] [--project <p>] [--json]
 *   muster steer list [--live] [--json]
 *   muster steer explain [--role <r> | --harness <h>] [--project <p>] [--json]
 *   muster steer retire <id> [--json]
 *
 * The author is the identity the frame and the seat owner proved for this session (`requireAgentId`), and a
 * name on the command line never replaces it: a lane cannot write a steer as the operator, and a steer carries no
 * author field a caller can set (review finding 4). Every write holds the journal's lock; `list` and
 * `explain` only read.
 *
 * `list` prints the journal's own records, one line each, with the retirement a later line recorded — never
 * a re-derivation. `explain` prints the pool file as a placement would read it, the composed chain, and the
 * live steers that touched it, so a steer can be checked against the file it stands on.
 *
 * Exit codes: 0 done, 2 the invocation or the record is wrong, 3 the refusal (an author the channel did not
 * prove, an expiry further than seven days out, a steer that is not there, a journal write that failed).
 */

import { loadPoolConfig } from "../../routing/provider-pool.ts";
import {
	applySteers,
	isSteerAuthor,
	readSteerJournal,
	STEER_ACTIONS,
	STEER_AUTHORS,
	STEER_CAP_FIELDS,
	steerView,
	steersJournalPath,
	addCapOverride,
	addSteer,
	retireSteer,
	type SteerAction,
	type SteerCapField,
	type SteerExpiry,
	type SteerScope,
} from "../../routing/steers.ts";
import { requireAgentId, parseFlags, type CliCommand, type CliContext, type ParsedFlags } from "./types.ts";

const USAGE = [
	"muster steer add --action <exclude|demote|prefer> --reason \"<why>\"",
	"                 [--role <role>|--harness pi|opencode|claude] [--ref <provider/model>|--provider <p>]",
	"                 [--account <a>] [--project <p>] [--at <ISO>|--meter <p/account> --fallback-at <ISO>|--review-at <ISO>]",
	"                 [--chat \"<the words>\"] [--json]",
	"muster steer cap --field <claudeMax|hardMax|slots> --value <n> --until <ISO> --reason \"<why>\" [--role <r>] [--json]",
	"muster steer list [--live] [--json]",
	"muster steer explain [--role <role>|--harness <h>] [--project <p>] [--json]",
	"muster steer retire <id> [--json]",
	"  the journal is state/steers.jsonl, append-only, and it is the only record of a steer;",
	"  the pool file is the base and this verb never writes it",
	"  exit 0 done, 2 the invocation or the record is wrong, 3 the refusal",
].join("\n");

const VALUE_FLAGS = [
	"action",
	"reason",
	"role",
	"ref",
	"provider",
	"account",
	"harness",
	"project",
	"at",
	"meter",
	"fallback-at",
	"review-at",
	"chat",
	"field",
	"value",
	"until",
];
const ACTIONS = ["add", "cap", "list", "explain", "retire"] as const;
type Action = (typeof ACTIONS)[number];

function scopeOf(parsed: ParsedFlags): SteerScope {
	const scope: SteerScope = {};
	const role = parsed.values.get("role");
	const ref = parsed.values.get("ref");
	const provider = parsed.values.get("provider");
	const account = parsed.values.get("account");
	const harness = parsed.values.get("harness");
	const project = parsed.values.get("project");
	if (role !== undefined) scope.role = role;
	if (ref !== undefined) scope.ref = ref;
	if (provider !== undefined) scope.provider = provider;
	if (account !== undefined) scope.account = account;
	if (harness !== undefined) scope.harness = harness as SteerScope["harness"];
	if (project !== undefined) scope.project = project;
	return scope;
}

function expiryOf(parsed: ParsedFlags): SteerExpiry | { error: string } {
	const at = parsed.values.get("at");
	const reviewAt = parsed.values.get("review-at");
	const fallbackAt = parsed.values.get("fallback-at");
	const meter = parsed.values.get("meter");
	const named = [at === undefined ? undefined : "at", reviewAt === undefined ? undefined : "review-at", fallbackAt === undefined || meter === undefined ? undefined : "meter-reset"].filter((value): value is string => value !== undefined);
	if (named.length !== 1) return { error: "one expiry is needed: --at <ISO>, or --meter <provider/account> --fallback-at <ISO>, or --review-at <ISO>" };
	if (at !== undefined) return { type: "at", at };
	if (reviewAt !== undefined) return { type: "manual", reviewAt };
	return { type: "meter-reset", meter: meter as string, fallbackAt: fallbackAt as string };
}

function isoOrNull(value: string | undefined): number | undefined {
	return value === undefined ? undefined : Date.parse(value);
}

/** The author the channel proved, or the refusal that becomes exit 3. */
function authorOf(ctx: CliContext): string | { error: string } {
	const identity = requireAgentId(ctx);
	if (typeof identity !== "string") return identity;
	if (!isSteerAuthor(identity)) {
		return { error: `a steer is accepted from ${STEER_AUTHORS.join(", ")} only; this session is ${identity}` };
	}
	return identity;
}

async function add(ctx: CliContext, parsed: ParsedFlags): Promise<number> {
	const author = authorOf(ctx);
	if (typeof author !== "string") {
		ctx.io.err(`muster steer: ${author.error}`);
		return 3;
	}
	const action = parsed.values.get("action");
	const reason = parsed.values.get("reason");
	if (action === undefined || !(STEER_ACTIONS as readonly string[]).includes(action)) {
		ctx.io.err(`muster steer: action ${action === undefined ? "is needed" : JSON.stringify(action)}: use ${STEER_ACTIONS.join(", ")}`);
		return 2;
	}
	if (reason === undefined || reason.trim() === "") {
		ctx.io.err("muster steer: --reason is needed: a steer carries the reason it was given");
		return 2;
	}
	const expiry = expiryOf(parsed);
	if ("error" in expiry) {
		ctx.io.err(`muster steer: ${expiry.error}`);
		return 2;
	}
	const chat = parsed.values.get("chat");
	const written = addSteer({
		author,
		action: action as SteerAction,
		scope: scopeOf(parsed),
		reason,
		expiry,
		...(chat === undefined ? {} : { source: { chat } }),
	});
	if (!written.ok) {
		ctx.io.err(`muster steer: refused\n  ${written.errors.join("\n  ")}`);
		return 3;
	}
	if (ctx.json) {
		ctx.io.out(JSON.stringify(written.record));
		return 0;
	}
	const until = written.record.kind === "steer" && written.record.expiry.type === "manual" ? `review ${written.record.expiry.reviewAt}` : written.record.kind === "steer" && written.record.expiry.type === "meter-reset" ? `until the ${written.record.expiry.meter} meter resets, no later than ${written.record.expiry.fallbackAt}` : `until ${written.record.kind === "steer" ? written.record.expiry.at : written.record.capOverride.until}`;
	ctx.io.out(`${written.record.id} ${written.record.kind === "cap" ? `cap ${written.record.capOverride.field} ${written.record.capOverride.value}` : written.record.action} ${until}`);
	ctx.io.out(`  ${JSON.stringify(written.record.scope)} by ${written.record.author}: ${written.record.reason}`);
	ctx.io.out(`  ${steersJournalPath()}`);
	return 0;
}

function cap(ctx: CliContext, parsed: ParsedFlags): number {
	const author = authorOf(ctx);
	if (typeof author !== "string") {
		ctx.io.err(`muster steer: ${author.error}`);
		return 3;
	}
	const field = parsed.values.get("field");
	const value = parsed.values.get("value");
	const until = parsed.values.get("until");
	const reason = parsed.values.get("reason");
	if (field === undefined || !(STEER_CAP_FIELDS as readonly string[]).includes(field)) {
		ctx.io.err(`muster steer: field ${field === undefined ? "is needed" : JSON.stringify(field)}: use ${STEER_CAP_FIELDS.join(", ")}`);
		return 2;
	}
	if (value === undefined || !Number.isFinite(Number(value))) {
		ctx.io.err("muster steer: --value is needed: a whole number of zero or more");
		return 2;
	}
	if (until === undefined || isoOrNull(until) === undefined) {
		ctx.io.err("muster steer: --until is needed: a capacity override carries a clock");
		return 2;
	}
	if (reason === undefined || reason.trim() === "") {
		ctx.io.err("muster steer: --reason is needed: a steer carries the reason it was given");
		return 2;
	}
	const chat = parsed.values.get("chat");
	const written = addCapOverride({
		author,
		scope: scopeOf(parsed),
		field: field as SteerCapField,
		value: Number(value),
		until,
		reason,
		...(chat === undefined ? {} : { source: { chat } }),
	});
	if (!written.ok) {
		ctx.io.err(`muster steer: refused\n  ${written.errors.join("\n  ")}`);
		return 3;
	}
	if (ctx.json) {
		ctx.io.out(JSON.stringify(written.record));
		return 0;
	}
	ctx.io.out(`${written.record.id} cap ${written.record.capOverride.field} ${written.record.capOverride.value} until ${written.record.capOverride.until}`);
	ctx.io.out(`  ${JSON.stringify(written.record.scope)} by ${written.record.author}: ${written.record.reason}`);
	return 0;
}

function list(ctx: CliContext, parsed: ParsedFlags): number {
	const journalPath = steersJournalPath();
	const read = readSteerJournal(journalPath);
	for (const warning of read.warnings) ctx.io.err(`muster steer: ${warning}`);
	const onlyLive = parsed.flags.has("live");
	const view = steerView(read, Date.now()).filter((entry) => !onlyLive || entry.live);
	if (ctx.json) {
		ctx.io.out(JSON.stringify(view, null, 2));
		return 0;
	}
	for (const entry of view) {
		const record = entry.record;
		const what = record.kind === "cap" ? `cap ${record.capOverride.field} ${record.capOverride.value} until ${record.capOverride.until}` : `${record.action} ${record.expiry.type === "manual" ? `review ${record.expiry.reviewAt}` : record.expiry.type === "meter-reset" ? `meter ${record.expiry.meter} by ${record.expiry.fallbackAt}` : `until ${record.expiry.at}`}`;
		const state = entry.retiredAt !== undefined ? `retired ${entry.retiredAt}` : entry.live ? (entry.reviewDue ? "live, review due" : `live${entry.expiresAt === undefined ? "" : ` until ${entry.expiresAt}`}`) : `expired${entry.expiresAt === undefined ? "" : ` ${entry.expiresAt}`}`;
		ctx.io.out(`${record.id}  ${state}  ${what}  ${JSON.stringify(record.scope)}  by ${record.author}: ${record.reason}`);
	}
	if (view.length === 0) ctx.io.out("no steers");
	return 0;
}

function explain(ctx: CliContext, parsed: ParsedFlags): number {
	const scope = scopeOf(parsed);
	const now = Date.now();
	const loaded = loadPoolConfig();
	if (!loaded.ok) {
		ctx.io.err(`muster steer: ${loaded.errors.join("; ")}`);
		return 2;
	}
	const journal = readSteerJournal(steersJournalPath());
	const composed = applySteers(loaded.config, journal, { now, ...scope });
	const live = steerView(journal, now).filter((entry) => entry.live);
	const rules = loaded.config.routing;
	const chains: Array<{ name: string; before: readonly string[]; after: readonly string[] }> = [];
	const roles = scope.role === undefined ? Object.keys(loaded.config.roles).sort() : [scope.role];
	for (const role of roles) {
		const before = loaded.config.roles[role];
		const after = composed.roles[role];
		if (before !== undefined && after !== undefined) chains.push({ name: `role ${role}`, before, after });
	}
	{
		const defaults = loaded.config.laneDefaults;
		const composedDefaults = composed.laneDefaults;
		if (defaults !== undefined && composedDefaults !== undefined) {
			if (scope.harness === undefined || scope.harness === "pi") chains.push({ name: "laneDefaults.pi", before: defaults.pi.candidates, after: composedDefaults.pi.candidates });
			if (scope.harness === undefined || scope.harness === "opencode") chains.push({ name: "laneDefaults.opencode", before: defaults.opencode, after: composedDefaults.opencode });
		}
	}
	if (ctx.json) {
		ctx.io.out(JSON.stringify({ chains, capacity: rules === undefined ? undefined : { claudeMax: composed.routing?.claudeMax, hardMax: composed.routing?.hardMax, slots: composed.routing?.slots }, live: live.map((entry) => entry.record.id), warnings: [...(loaded.warnings ?? []), ...journal.warnings] }, null, 2));
		return 0;
	}
	for (const chain of chains) {
		const changed = chain.before.join(",") !== chain.after.join(",");
		ctx.io.out(`${chain.name}: ${chain.after.join(", ")}${changed ? `  (was ${chain.before.join(", ")})` : ""}`);
	}
	for (const warning of [...(loaded.warnings ?? []), ...journal.warnings]) ctx.io.err(`muster steer: ${warning}`);
	const base = loaded.config.routing;
	if (base !== undefined && composed.routing !== undefined) {
		ctx.io.out(`capacity: claudeMax ${composed.routing.claudeMax}, hardMax ${composed.routing.hardMax}, slots ${composed.routing.slots}`);
	}
	ctx.io.out(`live steers: ${live.length === 0 ? "none" : live.map((entry) => entry.record.id).join(", ")}`);
	return 0;
}

function retire(ctx: CliContext, parsed: ParsedFlags): number {
	const author = authorOf(ctx);
	if (typeof author !== "string") {
		ctx.io.err(`muster steer: ${author.error}`);
		return 3;
	}
	const id = parsed.positionals[1]?.trim();
	if (id === undefined || id === "") {
		ctx.io.err("muster steer: retire needs a steer id: muster steer list prints them");
		return 2;
	}
	const retired = retireSteer(id, author);
	if (!retired.ok) {
		ctx.io.err(`muster steer: ${retired.errors.join("; ")}`);
		return 3;
	}
	if (ctx.json) {
		ctx.io.out(JSON.stringify(retired.record));
		return 0;
	}
	ctx.io.out(`${retired.record.id} retired at ${retired.record.at} by ${retired.record.by}`);
	return 0;
}

export const command: CliCommand = {
	name: "steer",
	summary: "List, add and retire routing steers: temporary, scoped instructions applied over the pool file at read time",
	usage: USAGE,
	async run(ctx) {
		const parsed = parseFlags(ctx.argv, VALUE_FLAGS);
		const positional = parsed.positionals[0]?.trim();
		if (positional === undefined || !(ACTIONS as readonly string[]).includes(positional)) {
			ctx.io.err(`muster steer: ${positional === undefined ? "an action is needed" : `unknown action ${JSON.stringify(positional)}`}: use ${ACTIONS.join(", ")}\n${USAGE}`);
			return 2;
		}
		const action = positional as Action;
		if (action === "add") return add(ctx, parsed);
		if (action === "cap") return cap(ctx, parsed);
		if (action === "list") return list(ctx, parsed);
		if (action === "explain") return explain(ctx, parsed);
		return retire(ctx, parsed);
	},
};

