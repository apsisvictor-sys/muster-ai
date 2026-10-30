/**
 * `muster route` — the routing decisions log (UM10, P5-D1 O1).
 *
 * Every lane start, delegate placement and mid-run failover is chosen by one rule
 * (`rankLaneRoutes`, extensions/lib/provider-pool.ts) and recorded in one file. This verb is
 * both ends of it:
 *
 *   muster route record           append one decision, read as JSON on stdin
 *   muster route log              the newest decisions, one line each, newest last
 *   muster route explain <lane>   one lane's own last decision, with the alternatives
 *   muster route pick --lane <l> --task-kind <k> [--class <c>] [--project <p>] [--harness <h>]
 *                    [--model <ref> --override "<reason>"] [--json]
 *                                 ask the table where one lane goes, and record the answer
 *
 * `pick` is the second door onto the one placement function (`placeLaneModel`,
 * `routing/provider-pool.ts`; the first is the Pi launcher's `lane-model.mjs`): the Claude harness and the
 * orchestrator read the answer here. It places by rule and records `by: "rule"`, or records a placement made
 * by hand with `--model` and `--override "<reason>"` as `by: "orchestrator"`, which the weekly report counts.
 * With `routing.pick: "off"` it answers with what the harness default already does and records nothing.
 *
 * `record` appends one decision through the one append body (`appendFsyncedLine`, since RS1 in
 * `extensions/lib/core/append-line.ts`) for a caller that holds a decision and not the log's
 * path. The launcher's helper (`extensions/muster/lane-model.mjs`) no longer needs it: that
 * helper runs under plain node and writes its line itself through the same append body, which
 * core made plain-node loadable; the pool library still owns the line's shape and path. Nothing
 * here decides anything: it shows what was decided and why.
 */

import { existsSync } from "node:fs";
// RS1 (S8): the credentials port has to be configured before `provider-key.ts` reads a provider's env names, which is
// VR24-213's presence test for a candidate. `muster route` is the only verb that reaches this file, so the adapters'
// cost is paid by that door alone; the waiter verbs never import it.
import "../../core/pi-ports-profile.ts";
import {
	freshRoutingSnapshot,
	isTaskKind,
	laneAccountFor,
	loadPoolConfig,
	placeLaneModel,
	providerOf,
	readRouteDecisions,
	routeDecisionLine,
	routingDecisionsPath,
	routingDecisionsTarget,
	TASK_KIND_CLASS,
	TASK_KINDS,
	type LaneHarness,
	type RouteDecision,
	type RunningLane,
	type TaskKindClass,
} from "../../routing/provider-pool.ts";
import { accountConfigured } from "../../routing/provider-key.ts";
import { jevFallbackLine, jevModeDir, jevStep, readJevMode } from "../../routing/jev-shadow.ts";
import { routeJev } from "../../routing/jev-choice.ts";
import type { ClassifierBudgetPort, ClassifierRegistry } from "../../core/pi-ports.ts";
import { enumerateLanes } from "../lib/lane-directory.ts";
import { appendFsyncedLine } from "../send.ts";
import { lanesCardsDir, lanesRegistryPath } from "./lanes.ts";
import { parseFlags, type CliCommand, type CliContext, type ParsedFlags } from "./types.ts";

const USAGE = [
	"muster route record          reads one decision as JSON on stdin and appends it",
	"muster route log [--limit N] [--json]",
	"muster route explain <lane> [--json]",
	"muster route pick --lane <lane> --task-kind <kind> [--class <flash|H1..H5|exception>]",
	"                  [--project <project>] [--harness pi|opencode|claude]",
	"                  [--model <ref> --override \"<reason>\"] [--json]",
	"  reads <pi-agent>/state/routing/decisions.jsonl, the record every lane start, delegate",
	"  placement and failover writes; --json is the machine view",
	"  pick asks the routing table where one lane goes and records the answer: by rule, or by",
	"  hand with --model and the reason in --override. --harness constrains the answer to one",
	"  harness; without it the answer may name either, and the JSON view says which. Its exit",
	"  code is 0 placed, 3 nothing may start (wait, with the earliest return), 2 a bad invocation",
].join("\n");

export const VALUE_FLAGS = ["limit", "lane", "task-kind", "class", "project", "harness", "model", "override"];
const DEFAULT_LIMIT = 20;
const ACTIONS = ["record", "log", "explain", "pick"];
const VERDICTS = ["chosen", "open", "over-threshold", "free", "walled", "unavailable", "excluded", "unknown-meter"];
const HARNESSES: readonly LaneHarness[] = ["pi", "opencode", "claude"];

export const command: CliCommand = {
	name: "route",
	summary: "Read and record routing decisions: how each lane, delegate and failover was placed, and why",
	usage: USAGE,
	async run(ctx) {
		const parsed = parseFlags(ctx.argv, VALUE_FLAGS);
		const action = parsed.positionals[0]?.trim();
		if (action === undefined || !ACTIONS.includes(action)) {
			ctx.io.err(`muster route: ${action === undefined ? "an action is needed" : `unknown action ${JSON.stringify(action)}`}: use record, log or explain\n${USAGE}`);
			return 2;
		}
		const path = routingDecisionsPath(ctx.env);

		if (action === "record") {
			const entry = parseDecision(await ctx.readStdin());
			if (entry === undefined) {
				ctx.io.err("muster route record: stdin must be one decision object with a numeric at, a chosen ref, a by of rule|orchestrator|failover and a candidates array");
				return 2;
			}
			const target = routingDecisionsTarget(ctx.env);
			appendFsyncedLine(target.stateDir, target.fileName, routeDecisionLine(entry));
			ctx.io.out(`muster route: recorded ${entry.chosen} (${entry.by}${entry.lane ? `, lane ${entry.lane}` : ""}) in ${path}`);
			return 0;
		}

		if (action === "pick") return pickLane(ctx, parsed);

		if (!existsSync(path)) {
			ctx.io.err(`muster route: no routing decisions yet (${path})`);
			return 3;
		}
		const entries = readRouteDecisions(path);

		if (action === "log") {
			const raw = parsed.values.get("limit");
			const limit = raw === undefined ? DEFAULT_LIMIT : Number(raw);
			if (!Number.isInteger(limit) || limit < 1) {
				ctx.io.err(`muster route: --limit needs a positive whole number\n${USAGE}`);
				return 2;
			}
			const shown = entries.slice(-limit);
			if (ctx.json) {
				ctx.io.out(JSON.stringify(shown, null, 2));
				return 0;
			}
			if (shown.length === 0) {
				ctx.io.out(`muster route: no routing decisions yet (${path})`);
				return 0;
			}
			for (const entry of shown) ctx.io.out(formatDecisionLine(entry));
			ctx.io.out(`muster route: ${shown.length} of ${entries.length} decision(s) from ${path}`);
			return 0;
		}

		const lane = parsed.positionals[1]?.trim();
		if (lane === undefined || lane === "") {
			ctx.io.err(`muster route explain: a lane is needed\n${USAGE}`);
			return 2;
		}
		const mine = entries.filter((entry) => entry.lane === lane);
		if (mine.length === 0) {
			ctx.io.err(`muster route explain: no decision for ${lane} in ${path}`);
			return 3;
		}
		const last = mine[mine.length - 1] as RouteDecision;
		if (ctx.json) {
			ctx.io.out(JSON.stringify(last, null, 2));
			return 0;
		}
		ctx.io.out(formatDecisionLine(last));
		ctx.io.out(`  reason: ${last.reason ?? "none given"}`);
		for (const candidate of last.candidates) ctx.io.out(`  ${candidate.ref}: ${candidate.verdict} (${candidate.reason})`);
		ctx.io.out(`  (${mine.length} decision(s) for ${lane} in ${path})`);
		return 0;
	},
};

/**
 * The lanes the directory says are up right now, as the placement's one running list: the spread step, the
 * Claude cap and the hard cap all read it. A directory that cannot be read is no running list, never fatal.
 */
function runningLanes(env: NodeJS.ProcessEnv): RunningLane[] {
	try {
		return enumerateLanes({
			...(env["HOME"] !== undefined ? { home: env["HOME"] } : {}),
			laneCardsDir: lanesCardsDir(env),
			laneRegistryPath: lanesRegistryPath(env),
		})
			.filter((card) => card.state !== "gone" && card.model !== null)
			.map((card) => ({ ref: card.model as string }));
	} catch {
		return [];
	}
}

/**
 * What a caller may hand the pick: the registry to ask and the port that reads the router's month. A test that
 * must not reach a provider passes its own; the doors build the production ones when these are absent.
 */
export interface PickLaneOptions {
	registry?: ClassifierRegistry;
	budget?: ClassifierBudgetPort;
}

/**
 * `muster route pick`: where one lane goes, by the table and the live facts, and the line that records it
 * (blueprint 4.5, AR6). A placement made by hand is `--model` with the reason in `--override`; it is recorded
 * as the orchestrator's and the weekly report counts it.
 */
export async function pickLane(ctx: CliContext, parsed: ParsedFlags, options: PickLaneOptions = {}): Promise<number> {
	const lane = parsed.values.get("lane")?.trim() ?? parsed.positionals[1]?.trim() ?? "";
	if (lane === "") {
		ctx.io.err(`muster route pick: --lane is needed\n${USAGE}`);
		return 2;
	}
	const kind = parsed.values.get("task-kind")?.trim() ?? "";
	if (!isTaskKind(kind)) {
		ctx.io.err(`muster route pick: --task-kind is needed and must be one of ${TASK_KINDS.join(", ")}\n${USAGE}`);
		return 2;
	}
	const klass = parsed.values.get("class")?.trim();
	if (klass !== undefined && !(klass === "flash" || klass === "exception" || /^H[1-5]$/.test(klass))) {
		ctx.io.err(`muster route pick: --class must be flash, H1 to H5 or exception\n${USAGE}`);
		return 2;
	}
	const requested = parsed.values.get("harness")?.trim();
	if (requested !== undefined && !(HARNESSES as readonly string[]).includes(requested)) {
		ctx.io.err(`muster route pick: --harness must be one of ${HARNESSES.join(", ")}\n${USAGE}`);
		return 2;
	}
	// A harness named on the command line constrains the answer; without one the table answers across both, and the
	// decision line's `claude` flag (in the JSON view) says which lane the ref needs.
	const harness = requested as LaneHarness | undefined;
	const handModel = parsed.values.get("model")?.trim() ?? "";
	const override = parsed.values.get("override")?.trim() ?? "";
	if (handModel !== "" && override === "") {
		ctx.io.err(`muster route pick: a placement by hand names its reason: --model <ref> --override "<reason>"\n${USAGE}`);
		return 2;
	}
	if (handModel === "" && override !== "") {
		ctx.io.err(`muster route pick: --override records a placement you made, so it needs --model <ref>\n${USAGE}`);
		return 2;
	}

	const loaded = loadPoolConfig();
	if (!loaded.ok) {
		ctx.io.err(`muster route pick: ${loaded.errors.join("; ")}`);
		return 2;
	}
	const now = Date.now();
	const placement = placeLaneModel(loaded.config, {
		now,
		kind,
		...(harness === undefined ? {} : { harness }),
		...(klass === undefined ? {} : { class: klass as TaskKindClass }),
		// VR24-213: a candidate whose key name is absent from this process's environment is never started.
		configured: (candidate, account) => accountConfigured(providerOf(candidate), account),
		running: runningLanes(ctx.env),
	});
	const status = handModel === "" ? placement.status : "placed";
	const project = parsed.values.get("project")?.trim();
	// AR15: the Jev step, for a lane that names no model. A hand placement names one, so the table's answer is not
	// asked about: the operator's choice stands. In `shadow` (the default) the rule's pick stands and Jev's answer
	// is recorded beside it; in `on` Jev's accepted answer is the placement.
	const jev = handModel === "" && placement.status === "placed"
		? await jevStep({
			placement,
			pool: loaded.config,
			caller: "route-pick",
			mode: readJevMode(jevModeDir(ctx.env)),
			lane,
			...(project === undefined || project === "" ? {} : { project }),
			...(options.registry === undefined ? {} : { registry: options.registry }),
			...(options.budget === undefined ? {} : { budget: options.budget }),
		})
		: undefined;
	const jevRef = jev?.mode === "on" && jev.jev?.accepted === true ? jev.jev.choice : undefined;
	const ref = handModel === "" ? (jevRef ?? placement.ref) : handModel;
	const snapshot = freshRoutingSnapshot(now);
	const entry: RouteDecision = {
		at: now,
		lane,
		...(project === undefined || project === "" ? {} : { project }),
		taskKind: kind,
		class: klass ?? TASK_KIND_CLASS[kind],
		chosen: ref ?? "",
		by: handModel === "" ? "rule" : "orchestrator",
		// AR14 design 5, shadow first: the account the rule would pick, and the account a lane on this ref uses.
		...(handModel === "" && placement.account !== undefined ? { account: placement.account } : {}),
		...(ref === undefined || ref === "" ? {} : { laneAccount: laneAccountFor(ref, ctx.env) }),
		...(handModel === "" ? {} : { override }),
		candidates: placement.candidates,
		reason: handModel === "" ? (jevRef === undefined ? placement.reason : `Jev chose ${jevRef}: ${jev?.jev?.reason ?? "the deciding fact"}`) : `placed by hand: ${override}`,
		// The Jev answer, when it is the placement (`on`): the line says who chose it. The `by` vocabulary has no
		// "jev" value yet (the pool owns it), so the line says `rule` and carries the answer in `jev`.
		...(jevRef !== undefined && jev?.jev !== undefined ? { jev: routeJev(jev.jev) } : {}),
		...(handModel !== "" || placement.until === undefined ? {} : { until: placement.until }),
		...(snapshot ? { snapshotAt: snapshot.capturedAt } : {}),
	};
	const path = routingDecisionsPath(ctx.env);
	// Nothing placed means nothing to record: a line with no ref would read as a placement somebody made.
	if (status !== "off") {
		const target = routingDecisionsTarget(ctx.env);
			try {
			appendFsyncedLine(target.stateDir, target.fileName, routeDecisionLine(entry));
			// AR15: the shadow line — the rule's placement with Jev's answer beside it, never a placement itself.
			if (jev?.line !== undefined) appendFsyncedLine(target.stateDir, target.fileName, routeDecisionLine(jev.line));
			// A step that broke is still a missing shadow answer: the line says why, and the placement stands.
			else if (jev?.failed !== undefined) {
				appendFsyncedLine(target.stateDir, target.fileName, routeDecisionLine(jevFallbackLine({ placement, reason: jev.failed, lane, ...(project === undefined || project === "" ? {} : { project }) })));
			}
		} catch (error) {
			ctx.io.err(`muster route pick: the decision was not recorded: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	if (ctx.json) {
		ctx.io.out(JSON.stringify({ status, ref: ref ?? null, until: status === "wait" ? (placement.until ?? null) : null, reason: entry.reason, candidates: placement.candidates, resolution: placement.resolution, entry, ...(jev?.jev === undefined ? {} : { jev: jev.jev }), path }, null, 2));
		return status === "wait" ? 3 : 0;
	}
	if (status === "placed") {
		ctx.io.out(`muster route: lane ${lane} -> ${ref} (${entry.by}, ${entry.taskKind}, ${TASK_KIND_CLASS[kind]})`);
		ctx.io.out(`  ${entry.reason}`);
		// What Jev would have picked, when it answered: the shadow comparison the architect reads.
		if (jev?.jev?.accepted === true) ctx.io.out(`  Jev would pick ${jev.jev.choice}: ${jev.jev.reason ?? "the deciding fact"}`);
		else if (jev?.jev !== undefined) ctx.io.out(`  Jev answered nothing usable (${jev.jev.fallback ?? "no reason given"}): ${jev.jev.reason ?? "the rule's pick stands"}`);
		else if (jev?.failed !== undefined) ctx.io.err(`muster route pick: ${jev.failed}`);
	} else if (status === "wait") {
		ctx.io.out(`muster route: lane ${lane} waits${placement.until === undefined ? ", and no candidate names a return time" : ` until ${new Date(placement.until).toISOString()}`}`);
		ctx.io.out(`  ${entry.reason}`);
		return 3;
	} else {
		ctx.io.out(`muster route: lane ${lane} is placed by the harness default (${placement.reason}): ${placement.resolution.model ?? "none"}`);
		return 0;
	}
	ctx.io.out(`  recorded in ${path}`);
	return 0;
}

/** Validate the minimum a logged decision must carry; anything else on stdin is refused, never guessed. */
function parseDecision(raw: string): RouteDecision | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== "object") return undefined;
	const entry = parsed as Partial<RouteDecision>;
	if (typeof entry.at !== "number" || !Number.isFinite(entry.at)) return undefined;
	if (typeof entry.chosen !== "string" || entry.chosen === "") return undefined;
	if (entry.by !== "rule" && entry.by !== "orchestrator" && entry.by !== "failover") return undefined;
	// The routing facts a placement may carry: a class, a kind, the rule that chose it, the reason a
	// hand placement differs from the rule, and whether the line is a shadow answer beside a placement.
	for (const key of ["class", "taskKind", "rule", "override"] as const) {
		if (entry[key] !== undefined && typeof entry[key] !== "string") return undefined;
	}
	if (entry.shadow !== undefined && typeof entry.shadow !== "boolean") return undefined;
	if (entry.until !== undefined && (typeof entry.until !== "number" || !Number.isFinite(entry.until))) return undefined;
	if (!Array.isArray(entry.candidates)) return undefined;
	for (const candidate of entry.candidates) {
		if (candidate === null || typeof candidate !== "object") return undefined;
		if (typeof candidate.ref !== "string" || !VERDICTS.includes(candidate.verdict)) return undefined;
	}
	return entry as RouteDecision;
}

/** One decision on one line: when, who, what, by which rule, and the snapshot it read. */
function formatDecisionLine(entry: RouteDecision): string {
	const who = entry.lane ? `lane ${entry.lane}` : entry.delegate ? `delegate ${entry.delegate}` : entry.role ? `role ${entry.role}` : "unattributed";
	const snapshot = entry.snapshotAt === undefined ? "no snapshot" : `snapshot ${new Date(entry.snapshotAt).toISOString()}`;
	// A wait placed nothing: the line says so instead of printing an empty ref.
	const what = entry.chosen === "" ? `wait until ${entry.until === undefined ? "no clock named" : new Date(entry.until).toISOString()}` : entry.chosen;
	return `${new Date(entry.at).toISOString()} ${who} -> ${what} (${entry.by}, ${snapshot})${entry.shadow ? " [shadow]" : ""}`;
}
