/**
 * `muster pool admit <ref> --ask <id>` — UM11, P5-D2 of
 * `plans/provider-accounts/usage-monitor-blueprint-2026-10-16.md`.
 *
 * A free model joins the pool only on the operator's own yes. The verb needs the
 * `authorization` ask the signal store raised for this ref (`signals.ts`
 * `maybeRaiseFreeLaunchAsk`, once the catalog shows the model and a probe
 * passed), answered yes in the operator's queue, and a `pass` probe signal from the
 * last 24 hours (`probe-verdict.ts` `probePassedFor`). With both it appends the
 * ref to `provider-pool.json`'s `freeRefs` and to the end of every chat chain —
 * the file's own free-ref rule — through the one settings writer
 * (`updateJsonSettingsFile`), and writes one line to the routing decisions log
 * naming the ask.
 *
 * `laneDefaults` is never touched: it is a lane's own start list (the operator's
 * order), not a routing chain. `models.json` is not touched either: a model the
 * provider's catalog carries is Pi's own catalog entry, and UM13's precedent
 * kept that a separate edit.
 *
 * A no admits nothing and is not repeated: the answer already left the operator's
 * queue (`answersAsk` folds it to `decided`), and only a new launch signal
 * raises a new ask. The verb writes no ask event itself.
 *
 * Exit codes: 0 admitted, 1 the gate refused, 2 the usage is wrong.
 */

import { updateJsonSettingsFile } from "../../core/atomic-settings.ts";
import {
	isPoolRef,
	parsePoolConfig,
	poolConfigPath,
	providerOf,
	routeDecisionLine,
	routingDecisionsPath,
	routingDecisionsTarget,
	withAdmittedFreeRef,
	type RouteDecision,
} from "../../routing/provider-pool.ts";
import { askCodeOf, readAsks, resolveAskRef, type Ask } from "../asks.ts";
import { musterStateDir } from "../binding.ts";
import { probePassedFor, PROBE_PASS_WINDOW_MS } from "../probe-verdict.ts";
import { appendFsyncedLine } from "../send.ts";
import { parseFlags, type CliCommand, type CliContext } from "./types.ts";

const USAGE = [
	"muster pool admit <ref> --ask <id> [--json]",
	"  admits one free model <provider/model> into provider-pool.json's freeRefs and the end of",
	"  every chat chain, only with the authorization ask for this ref answered yes and a pass",
	"  probe signal from the last 24 hours; laneDefaults is never touched",
	"  exit 0 admitted, 1 the gate refused, 2 the usage is wrong",
].join("\n");

/** A refusal from the admission itself, so the verb reports it and exits 1. */
class PoolAdmissionRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PoolAdmissionRefusal";
	}
}

/**
 * Whether an ask is the one the store raised for `ref`. The store writes the
 * provider and the model into the question; the id alone does not say which
 * model an ask is about, so the question has to name both.
 */
export function askNamesRef(ask: Ask, provider: string, modelId: string): boolean {
	const question = ask.question.toLowerCase();
	return question.includes(modelId.toLowerCase()) && question.includes(provider.toLowerCase());
}

/**
 * Whether the operator's ruling is a yes. His wording is free text (`answerAsk`), so
 * the first word decides: "yes", "yes, add it" and "Yes, up to the ceiling"
 * pass; a no, or any other first word, does not.
 */
export function rulingIsYes(ruling: string | undefined): boolean {
	const first = (ruling ?? "").trim().toLowerCase().replace(/^[^\p{L}\p{N}]+/u, "").split(/[^\p{L}\p{N}]+/u)[0] ?? "";
	return first === "yes" || first === "y";
}

export const command: CliCommand = {
	name: "pool",
	summary: "Admit one free model into the provider pool on the operator's answered yes",
	usage: USAGE,
	async run(ctx) {
		const parsed = parseFlags(ctx.argv, ["ask"]);
		const action = parsed.positionals[0]?.trim();
		if (action !== "admit") {
			ctx.io.err(`muster pool: ${action === undefined ? "an action is needed" : `unknown action ${JSON.stringify(action)}`}: use admit\n${USAGE}`);
			return 2;
		}
		const ref = parsed.positionals[1]?.trim();
		if (ref === undefined || ref === "" || parsed.positionals.length > 2) {
			ctx.io.err(`muster pool admit: one <provider/model> ref is required\n${USAGE}`);
			return 2;
		}
		if (!isPoolRef(ref)) {
			ctx.io.err(`muster pool admit: ${ref} is not a <provider/model> ref\n${USAGE}`);
			return 2;
		}
		const askRef = parsed.values.get("ask")?.trim();
		if (askRef === undefined || askRef === "") {
			ctx.io.err(`muster pool admit: --ask <id> is required: the authorization ask for this ref that the operator answered\n${USAGE}`);
			return 2;
		}
		return admit(ctx, ref, askRef);
	},
};

async function admit(ctx: CliContext, ref: string, askRef: string): Promise<number> {
	const stateDir = musterStateDir();
	const provider = providerOf(ref);
	const modelId = ref.slice(ref.indexOf("/") + 1).toLowerCase();

	// 1. The ask the store raised for this ref, answered yes.
	const resolution = resolveAskRef(readAsks(stateDir), askRef);
	if ("ambiguous" in resolution) {
		ctx.io.err(`muster pool admit: ${askRef} belongs to ${resolution.ambiguous.length} live asks (${resolution.ambiguous.map((ask) => ask.id).join(", ")}); use the id`);
		return 1;
	}
	if ("missing" in resolution) {
		ctx.io.err(`muster pool admit: no live ask matches ${askRef}: the store raises one for ${ref} once the catalog shows it and its probe passes`);
		return 1;
	}
	const ask = resolution.ask;
	if (ask.kind !== "authorization") {
		ctx.io.err(`muster pool admit: ${askCodeOf(ask)} is a ${ask.kind} ask; a free admission needs the authorization ask for this ref`);
		return 1;
	}
	if (!askNamesRef(ask, provider, modelId)) {
		ctx.io.err(`muster pool admit: ${askCodeOf(ask)} does not name ${ref}; the ask the store raised for it carries its provider and its model`);
		return 1;
	}
	if (ask.status !== "decided") {
		ctx.io.err(`muster pool admit: ${askCodeOf(ask)} is ${ask.status}; a free model joins only on the ask answered yes`);
		return 1;
	}
	if (!rulingIsYes(ask.ruling)) {
		ctx.io.err(`muster pool admit: ${askCodeOf(ask)} was not answered yes (${ask.ruling ?? "no ruling"}); the model stays out, and only a new launch signal raises a new ask`);
		return 1;
	}

	// 2. A pass probe signal from the last 24 hours.
	if (!probePassedFor(stateDir, provider, modelId)) {
		ctx.io.err(`muster pool admit: no pass probe signal for ${ref} in the last ${PROBE_PASS_WINDOW_MS / 3_600_000} hours; run muster probe ${ref}`);
		return 1;
	}

	// 3. The pool file, through its one owner and the loader's own validator.
	const path = poolConfigPath();
	let roles: string[] = [];
	try {
		updateJsonSettingsFile<Record<string, unknown>>(path, {}, (current) => {
			const admission = withAdmittedFreeRef(current, ref);
			if (!admission.ok) throw new PoolAdmissionRefusal(admission.reason);
			const parsed = parsePoolConfig(admission.file);
			if (!parsed.ok) throw new PoolAdmissionRefusal(`the pool file would not load: ${parsed.errors.join("; ")}`);
			roles = admission.roles;
			return admission.file;
		});
	} catch (error) {
		if (error instanceof PoolAdmissionRefusal) {
			ctx.io.err(`muster pool admit: ${error.message}`);
			return 1;
		}
		throw error;
	}

	// 4. The routing log line: what was admitted, by whom, on which ask.
	const decision: RouteDecision = {
		at: Date.now(),
		chosen: ref,
		by: "orchestrator",
		candidates: [{ ref, verdict: "free", reason: `admitted on the operator's yes (${ask.id})` }],
		reason: `admitted to freeRefs and the end of every chat chain on the operator's yes (ask ${ask.id}, probe pass within ${PROBE_PASS_WINDOW_MS / 3_600_000}h)`,
	};
	const target = routingDecisionsTarget(ctx.env);
	appendFsyncedLine(target.stateDir, target.fileName, routeDecisionLine(decision));

	const joined = roles.length === 0 ? "already in every chat chain" : `the end of ${roles.length} chat chain(s) (${roles.join(", ")})`;
	if (ctx.json) {
		ctx.io.out(JSON.stringify({ ref, askId: ask.id, askCode: askCodeOf(ask), provider, modelId, probe: "pass", chains: roles, path, log: routingDecisionsPath(ctx.env) }, null, 2));
		return 0;
	}
	ctx.io.out(`muster pool: admitted ${ref} to freeRefs and ${joined} on the operator's yes (${askCodeOf(ask)}); logged in ${routingDecisionsPath(ctx.env)}`);
	return 0;
}
