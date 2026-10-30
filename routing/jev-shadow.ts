/**
 * `jev-shadow.ts` — the doors' Jev step (AR15): one owner of "what Jev would pick for this placement", in shadow first.
 *
 * Two doors place a lane by rule: the Pi launcher's helper (`muster/lane-model.mjs`, plain node) and `muster route
 * pick` (`muster/cli/route.ts`, tsx). AR13 built the step itself — `jev-choice.ts` reads the methodology's prompt,
 * asks the classifier owner a closed question over the candidate refs code has already built, and falls back to the
 * deterministic top — and left the two doors to call it. This module is that call, in one place, so both doors behave
 * the same and neither keeps a second copy of the wiring.
 *
 * What it does:
 * - nothing when the mode is `off`, when the placement placed nothing (a wait is a rule, not a judgement), or when
 *   the pool carries no routing ceiling (VR24-204: without `ceilings.routing.usdPerMonth` no call is made);
 * - one call to `chooseWithJev` for a placement whose candidate set code has already built, so the choice is made
 *   inside that set and never outside it (VR24-203);
 * - the shadow line: the rule's placement with Jev's answer beside it (`shadowDecision`, the owner's own line shape),
 *   so a reader compares the two instead of assuming Jev's answer was applied.
 *
 * The mode is a file in the routing state dir, next to the decisions log: `jev-mode`, holding `shadow`, `on` or
 * `off`. `shadow` (the default) records Jev's answer and leaves the launch on the rule's pick; `on` places Jev's
 * answer; `off` makes no call at all. Henry flips that file on the day the architect reads the shadow lines.
 *
 * The launcher's helper runs under plain node, which cannot load this module's two TypeScript owners (`jev-choice.ts`
 * and the telemetry owner), so the helper runs the step in a child process (`node --import tsx` on this file) and
 * this module is that child's program as well as the route door's library. The child reads the placement and the pool
 * as JSON on stdin and answers with the line as JSON, so the helper writes the line through the one append body it
 * already uses and never keeps a second writer.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { piPort, type ClassifierBudgetPort, type ClassifierRegistry } from "../core/pi-ports.ts";
import type { JevChoice } from "./jev-choice.ts";
import type { LanePlacement, PoolConfig, RouteDecision } from "./provider-pool.ts";
import { routingDecisionsTarget } from "./provider-pool.ts";

/** What the Jev step does at the doors. */
export type JevMode = "off" | "shadow" | "on";

/** The three modes, in the order the file names them. */
export const JEV_MODES = ["off", "shadow", "on"] as const;

/** The file the mode is read from, in the routing state dir beside the decisions log. */
export const JEV_MODE_FILE = "jev-mode";

/** How long one Jev call may take before the step gives up and the rule's pick stands. */
export const JEV_TIMEOUT_MS = 30_000;

/**
 * The mode in force, read from the routing state dir. A file that is missing, unreadable or holds a word this step
 * does not know means `shadow`: the shadow phase is the default, and in it the launch stays on the rule's pick, so
 * the only thing a wrong word can change is that the shadow data keeps coming. `off` stops the calls, `on` places
 * Jev's answer. The architect starts the shadow phase with one line:
 * `echo shadow > ~/.pi/agent/state/routing/jev-mode`, and Henry flips it to `on` on the day the shadow lines are read.
 */
export function readJevMode(stateDir: string): JevMode {
	try {
		const raw = readFileSync(join(stateDir, JEV_MODE_FILE), "utf8").trim().toLowerCase();
		return (JEV_MODES as readonly string[]).includes(raw) ? (raw as JevMode) : "shadow";
	} catch {
		return "shadow";
	}
}

/** The routing state dir the mode file sits in, for the installation this process serves. */
export function jevModeDir(env: NodeJS.ProcessEnv = process.env): string {
	return routingDecisionsTarget(env).stateDir;
}

export interface JevStepRequest {
	/** The placement code has already made: the candidate set and the deterministic top are its own. */
	placement: LanePlacement;
	/** The pool, read through the one parser, for the classifier role and the routing ceiling. */
	pool: PoolConfig;
	/** Who asked, for the classifier owner's call log (`lane-model`, `route-pick`). */
	caller: string;
	/** The mode in force. */
	mode: JevMode;
	lane?: string;
	project?: string;
	/** A short summary of the lane's work, as data: the methodology forbids reading it as an instruction. */
	brief?: string;
	/** The registry to ask. Absent builds the production one (pi-ai's models with the OpenRouter provider). */
	registry?: ClassifierRegistry;
	/** The port that reads and records the router's month. Absent builds the production one (the telemetry owner). */
	budget?: ClassifierBudgetPort;
	now?: () => Date;
	signal?: AbortSignal;
	methodologyPath?: string;
}

export interface JevStepResult {
	mode: JevMode;
	/** Jev's answer, when a call was made. */
	jev?: JevChoice;
	/** The shadow line: the rule's placement with Jev's answer beside it. */
	line?: RouteDecision;
	/** Why no call was made, when none was. */
	skipped?: string;
	/** The step broke (a bug or a crash in an owner): the rule's pick stands and this is why. */
	failed?: string;
}

/**
 * The line a step that broke leaves: the rule's placement, marked as a shadow line, with the reason no Jev answer is
 * beside it. One owner for both doors, so a failed step is recorded the same way wherever it failed.
 */
export function jevFallbackLine(input: { placement: LanePlacement; reason: string; at?: number; lane?: string; project?: string }): RouteDecision {
	return {
		at: input.at ?? Date.now(),
		...(input.lane === undefined ? {} : { lane: input.lane }),
		...(input.project === undefined ? {} : { project: input.project }),
		chosen: input.placement.ref ?? "",
		by: "rule",
		shadow: true,
		candidates: input.placement.candidates,
		reason: input.reason,
	};
}

/**
 * One Jev step over a placement code has already made. It makes no call when code has decided the answer, and it
 * never changes the placement: in `shadow` the rule's pick stands and Jev's answer is recorded beside it.
 */
export async function jevStep(request: JevStepRequest): Promise<JevStepResult> {
	const { mode, placement, pool } = request;
	if (mode === "off") return { mode, skipped: "the Jev mode is off" };
	if (placement.status !== "placed") return { mode, skipped: placement.reason };
	// VR24-204: the router's month is its own bucket, and without a ceiling for it no call is made at all.
	if (pool.ceilings?.routing?.usdPerMonth === undefined) {
		return { mode, skipped: "the pool carries no routing ceiling, so no call is made (VR24-204)" };
	}
	const registry = request.registry ?? (await productionRegistry());
	const budget = request.budget ?? (await productionBudget());
	let jev: JevChoice;
	let line: RouteDecision | undefined;
	try {
		jev = await askJev(registry, budget, request);
		line = await shadowLine({
			placement,
			jev,
			at: request.now?.().getTime() ?? Date.now(),
			...(request.lane === undefined ? {} : { lane: request.lane }),
			...(request.project === undefined ? {} : { project: request.project }),
		});
	} catch (error) {
		// A step that breaks is a missing shadow answer, never a broken door: the rule's pick stands and the log says
		// why. The doors write the reason with `jevFallbackLine`.
		return { mode, failed: `the Jev step failed: ${error instanceof Error ? error.message : String(error)}` };
	}
	return { mode, jev, ...(line === undefined ? {} : { line }) };
}

/**
 * The call itself, in the owner's own words: the Jev step reads the methodology at call time, asks the classifier
 * owner the closed question over the candidate refs, and falls back to the deterministic top. This module adds no
 * rule of its own to that answer — it decides only whether to ask.
 */
async function askJev(registry: ClassifierRegistry, budget: ClassifierBudgetPort, request: JevStepRequest): Promise<JevChoice> {
	const { chooseWithJev: choose } = await import("./jev-choice.ts");
	return choose({
		placement: request.placement,
		registry,
		pool: { roles: request.pool.roles, ceilings: request.pool.ceilings ?? {} },
		caller: request.caller,
		budget,
		...(request.brief === undefined ? {} : { brief: request.brief }),
		...(request.now === undefined ? {} : { now: request.now }),
		...(request.methodologyPath === undefined ? {} : { methodologyPath: request.methodologyPath }),
		signal: request.signal ?? AbortSignal.timeout(JEV_TIMEOUT_MS),
	});
}

/** The shadow line, in the owner's own words (AR13): the rule's placement with Jev's answer beside it. */
async function shadowLine(input: { placement: LanePlacement; jev: JevChoice; at: number; lane?: string; project?: string }): Promise<RouteDecision | undefined> {
	const { shadowDecision: shadow } = await import("./jev-choice.ts");
	return shadow(input);
}

/**
 * The production registry: pi-ai's own models with the OpenRouter provider, which is where the pool's
 * `classifier` role points (Jev). The key is Pi's own business — the environment or the stored credential — so
 * nothing here reads or prints one.
 */
async function productionRegistry(): Promise<ClassifierRegistry> {
	const { createModels } = await import("@earendil-works/pi-ai/models");
	const { openrouterProvider } = await import("@earendil-works/pi-ai/providers/openrouter");
	const models = createModels();
	models.setProvider(openrouterProvider());
	return {
		getModelOfType: (type, provider, modelId) => models.getModelOfType(type, provider, modelId),
		classify: (model, context, options) => models.classify(model as never, context as never, options) as never,
	};
}

/**
 * The production budget port: the telemetry owner's own port, counting the router's bucket (the routing month's
 * routing calls, never the desk's). The database is the one the desk writes to, so the router's month is the same
 * month the desk's records live in. `PI_TELEMETRY_DB_PATH` points it elsewhere, which is how a test keeps its calls
 * out of the live database.
 */
function productionBudget(): Promise<ClassifierBudgetPort> {
	return piPort("routingBudget")();
}

// ─── the child process: the launcher's plain node calls this program ─────────────────────────────

/** What the child reads on stdin: the request, as data. */
export interface JevStepScriptRequest {
	placement: LanePlacement;
	pool: PoolConfig;
	caller: string;
	mode: JevMode;
	lane?: string;
	project?: string;
	brief?: string;
}

/**
 * This file as a path. The launcher's helper (`muster/lane-model.mjs`) runs it as a program in a child process;
 * the module owns its own location, so the caller derives no path into the tree for it. RS3FIXB: the tree
 * owner's two-level rule (`core/harness-paths.ts`) does not hold for a file that sits directly in a package
 * directory, and a derivation there pointed the child at `<root>/routing/jev-shadow.ts`.
 */
export function jevProgramPath(): string {
	return fileURLToPath(import.meta.url);
}

/**
 * Run this file as a program: read the request on stdin, run the step, answer with the result as one JSON line.
 * The launcher's helper does this in a child process, because plain node cannot load the owners this step calls.
 */
async function runAsProgram(): Promise<void> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JevStepScriptRequest;
	const result = await jevStep({ ...request });
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
	await runAsProgram();
}
