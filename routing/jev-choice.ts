import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { piAgentDir, piPort, type ClassifierBudgetPort, type ClassifierPool, type ClassifierRegistry, type JsonState } from "../core/pi-ports.ts";
import {
	type DecisionFacts,
	type DecisionFactsCandidate,
	type DecisionWindow,
	type LanePlacement,
	type RouteDecision,
	type RouteJev,
} from "./provider-pool.js";

/**
 * AR13 of the auto-routing blueprint (VR24-203, VR24-204): code decides what must be true and builds the
 * candidate set; Jev chooses inside it under the written methodology. This module is that one step — it reads
 * the methodology at call time and quotes its hash, asks the classifier owner's closed questions over the
 * candidate refs, discards an answer the set does not hold, falls back to the deterministic top, and assembles
 * the shadow decision line.
 *
 * What it never does: call a model when code has decided the answer. A wait (an empty set, or every candidate
 * over the line with a refill inside the horizon), a single remaining candidate, and a missing methodology all
 * answer without a call, because none of them is a judgement (VR24-204).
 *
 * The methodology file is the architect's (`plans/orchestration-2026-10-05/specs/routing-methodology.md`): the
 * prompt is the text between its two lines of equals signs, and everything else there is notes for people.
 */
/**
 * The question set this step asks. Versioned with its wording, as a file's set is: version 2 carries the
 * methodology's own answer fields (AR13B), so a row recorded under version 1 keeps the old question names.
 */
export const JEV_QUESTION_SET = { id: "lane-placement", version: 2 } as const;

/**
 * The two answers this step asks for, named exactly as the methodology's Answer format names them (AR13B). The
 * prompt asks for one JSON object with these fields, so the closed questions carry these names and a model that
 * obeys the prompt returns exactly the object the code reads.
 */
export const JEV_ANSWER = { choice: "choice", reason: "reason" } as const;

/**
 * The keys of the JSON object the methodology's `Answer format` section asks for, in the prompt's own order, read
 * from that file and never retyped here. A prompt with no such template, or one that is not a JSON object, is an
 * error: this step reads the answer its prompt asks for, so it has to know what that answer is shaped like.
 */
export function answerFormatKeys(text: string): string[] {
	const section = text.split(/^#+[ \t]*Answer format[ \t]*$/m)[1];
	const template = (section ?? "").match(/`(\{[^`]*\})`/)?.[1];
	if (template === undefined) throw new Error("the methodology's Answer format states no JSON object template");
	let parsed: unknown;
	try {
		parsed = JSON.parse(template);
	} catch {
		throw new Error(`the methodology's Answer format template is not JSON: ${template}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`the methodology's Answer format template is not a JSON object: ${template}`);
	const keys = Object.keys(parsed);
	if (keys.length === 0) throw new Error(`the methodology's Answer format template names no field: ${template}`);
	return keys;
}

/**
 * The closed list of deciding facts, in the methodology's own order of preference. Jev answers with one of
 * these codes, so the line names the fact that decided it instead of a free-text sentence the classifier owner
 * cannot return.
 */
export const JEV_BECAUSE = {
	"refill-window-open": "a plan whose only limit is its 5-hour window, and that window is open",
	"most-spare": "the most spare allowance: the least used window with the nearest reset",
	"behind-pace": "furthest behind its weekly pace",
	"fewer-running": "no candidate has fewer lanes running on it",
	"kind-order": "the kind's own preference order, when nothing else separates them",
	"unknown-meter": "an unreadable meter, better than a candidate over the line",
	"soonest-reset": "over the line, with the limiting window that resets soonest",
	"fit-hard-list": "a hard kind, which only the hard list serves",
	"fit-review": "a review, which needs an independent strong model",
	"fit-product-model": "a product pass, which needs the product model",
} as const;

export type JevBecause = keyof typeof JEV_BECAUSE;

/** Why the deterministic top stands instead of Jev's answer. */
export type JevFallback = "not-placed" | "single-candidate" | "no-methodology" | "answer-format" | "outside-set" | "ceiling" | "failed";

/** The methodology's prompt text and the sha256 every decision line quotes. */
export interface Methodology {
	text: string;
	hash: string;
}

/** Where the methodology file lives. `PI_ROUTING_METHODOLOGY_PATH` is the test's and a retro's way in. */
export function routingMethodologyPath(env: NodeJS.ProcessEnv = process.env): string {
	return env["PI_ROUTING_METHODOLOGY_PATH"] ?? join(piAgentDir(), "plans", "orchestration-2026-10-05", "specs", "routing-methodology.md");
}

/**
 * The prompt text and its hash, read on every call so a change to the file is a change to what the next line
 * quotes (VR24-203). A file with no prompt between the two lines of equals signs is an error, never an empty
 * system prompt.
 */
export function readMethodology(path: string = routingMethodologyPath()): Methodology {
	const raw = readFileSync(path, "utf8");
	const block = raw.match(/^={4,}[ \t]*\r?\n([\s\S]*?)^={4,}[ \t]*$/m);
	const text = (block?.[1] ?? "").trim();
	if (text === "") throw new Error(`${path} carries no prompt between its two lines of equals signs`);
	return { text, hash: createHash("sha256").update(text).digest("hex") };
}

export interface JevChoiceInput {
	/** The code's own answer: its candidate set, its facts, and the top a fallback uses. */
	placement: LanePlacement;
	registry: ClassifierRegistry;
	pool: ClassifierPool;
	/** Who asked, for the call log (for example `route-pick`). */
	caller: string;
	/** A short summary of the lane's work, as data: the methodology forbids reading it as an instruction. */
	brief?: string;
	/** The port that reads and records the router's own month. With the pool's ceiling and no port, no call is made. */
	budget?: ClassifierBudgetPort;
	methodologyPath?: string;
	/** A methodology read once by a caller that makes several decisions in a row. */
	methodology?: Methodology;
	now?: () => Date;
	signal?: AbortSignal;
}

/** Jev's answer, as the decision line and the shadow comparison read it. */
export interface JevChoice {
	/** True only for an answer that is one ref of the set: that answer is what the shadow line compares. */
	accepted: boolean;
	/** The ref Jev answered, exactly as it answered it, discarded answers included. */
	choice?: string;
	because?: JevBecause;
	/** One line, at most 200 characters, naming the fact and the chosen candidate's own numbers. */
	reason?: string;
	confidence?: number;
	methodologyHash: string;
	model?: string;
	costUsd?: number | null;
	fallback?: JevFallback;
	stopReason?: string;
	error?: string;
}

const MAX_REASON = 200;

/** A window's own name, as a person reads it in the question. */
function spanName(windowMinutes: number): string {
	if (windowMinutes === 300) return "5-hour";
	if (windowMinutes === 10_080) return "weekly";
	if (windowMinutes === 43_200) return "monthly";
	return `${Math.max(1, Math.round(windowMinutes / 60))}-hour`;
}

function windowLine(window: DecisionWindow): string {
	return `${spanName(window.windowMinutes)} window ${Math.round(window.usedPercent)}% used (${window.remaining}% left), resets ${new Date(window.resetsAt).toISOString()}`;
}

/** One candidate as the closed answer list describes it: the facts, in the vocabulary the methodology uses. */
function describeCandidate(candidate: DecisionFactsCandidate): string {
	const tier = candidate.tier === "open" ? "open and readable" : candidate.tier === "unknown-meter" ? "meter unreadable" : "over the line";
	const windows = candidate.windows.length === 0 ? "no window reading" : candidate.windows.map(windowLine).join("; ");
	const pace = candidate.pace === undefined ? "no weekly pace" : `${candidate.pace >= 0 ? "ahead of" : "behind"} pace by ${Math.abs(Math.round(candidate.pace * 10) / 10)}`;
	const refills = candidate.refills ? "; its only limit is its 5-hour window, so unused room is lost when it resets" : "";
	return `${tier}; ${windows}; ${pace}; ${candidate.running} running lane(s)${refills}${candidate.free ? "; free" : ""}`;
}

/** The one line the decision carries: the fact Jev named, and the chosen candidate's own numbers. */
function jevReason(candidate: DecisionFactsCandidate, because: JevBecause | undefined): string {
	const binding = [...candidate.windows].sort((left, right) => left.remaining - right.remaining)[0];
	const fact = binding === undefined ? "no window reading" : windowLine(binding);
	const why = because === undefined ? `the ${candidate.tier} tier` : JEV_BECAUSE[because];
	const line = `${candidate.ref}: ${why}; ${fact}; ${candidate.running} running lane(s)`;
	return line.length <= MAX_REASON ? line : `${line.slice(0, MAX_REASON - 1)}…`;
}

/** The state the call reads: the methodology, the task, and the facts. The answer list lives in the questions. */
function jevState(facts: DecisionFacts, methodology: string, brief: string | undefined): JsonState {
	return {
		methodology,
		task: { kind: facts.kind, class: facts.class, ...(brief === undefined || brief.trim() === "" ? {} : { brief: brief.trim() }) },
		now: facts.now,
		deterministic: facts.deterministic,
		candidates: facts.candidates,
	};
}

const CHOICE_INSTRUCTIONS =
	`The "${JEV_ANSWER.choice}" field of the one answer object the methodology asks for: which candidate should take ` +
	"this lane? Answer with exactly one of the refs in this question's criteria, following the methodology in the " +
	"state's methodology field and the facts in its candidates. Never answer with a ref that is not in the " +
	"criteria, and never with anything else.";

const REASON_INSTRUCTIONS =
	`The "${JEV_ANSWER.reason}" field of that same object: which single fact decided that choice? Answer with exactly ` +
	"one code from this question's criteria, in the order of preference the methodology states; code writes the " +
	"one sentence the methodology asks this field to carry.";

/**
 * One Jev decision over a placement code has already made. It makes no call when code has decided the answer:
 * nothing placed, a single candidate, or no methodology to read.
 */
export async function chooseWithJev(input: JevChoiceInput): Promise<JevChoice> {
	let methodology: Methodology;
	try {
		methodology = input.methodology ?? readMethodology(input.methodologyPath);
	} catch (error) {
		return { accepted: false, methodologyHash: "", fallback: "no-methodology", error: error instanceof Error ? error.message : String(error) };
	}
	const hash = methodology.hash;
	const facts = input.placement.status === "placed" ? input.placement.facts : undefined;
	// Waiting is a rule, not a judgement (VR24-204): code has decided, so there is nothing to ask.
	if (input.placement.status !== "placed" || facts === undefined || facts.candidates.length === 0) {
		return { accepted: false, methodologyHash: hash, fallback: "not-placed", reason: input.placement.reason };
	}
	// One candidate is a forced answer: a closed list of one is not a choice, and asking would buy nothing.
	if (facts.candidates.length === 1) {
		const only = facts.candidates[0] as DecisionFactsCandidate;
		return { accepted: false, methodologyHash: hash, fallback: "single-candidate", reason: `${only.ref} is the only candidate code leaves for ${facts.kind}` };
	}

	// The answer this step reads is the answer the prompt asks for (AR13B): the questions carry the prompt's own
	// field names, so a model that obeys the stated format is answered, not discarded as outside the set. A prompt
	// that asks for other fields is refused here, before any call, rather than asked and then ignored.
	let keys: string[];
	try {
		keys = answerFormatKeys(methodology.text);
	} catch (error) {
		const why = error instanceof Error ? error.message : String(error);
		return { accepted: false, methodologyHash: hash, fallback: "answer-format", reason: why.slice(0, MAX_REASON) };
	}
	const asked = [JEV_ANSWER.choice, JEV_ANSWER.reason];
	if (keys.length !== asked.length || !asked.every((key) => keys.includes(key))) {
		return {
			accepted: false,
			methodologyHash: hash,
			fallback: "answer-format",
			reason: `the methodology's Answer format asks for {${keys.join(", ")}} and this step answers {${asked.join(", ")}}: align jev-choice.ts or report the prompt change`.slice(0, MAX_REASON),
		};
	}

	const criteria: Record<string, string> = {};
	for (const candidate of facts.candidates) criteria[candidate.ref] = describeCandidate(candidate);
	const set = piPort("classifier").closedChoiceSet(JEV_QUESTION_SET.id, JEV_QUESTION_SET.version, {
		[JEV_ANSWER.choice]: { instructions: CHOICE_INSTRUCTIONS, criteria },
		[JEV_ANSWER.reason]: { instructions: REASON_INSTRUCTIONS, criteria: { ...JEV_BECAUSE } },
	});
	const outcome = await piPort("classifier").classifyQuestionSet(input.registry, input.pool, set, jevState(facts, methodology.text, input.brief), {
		caller: input.caller,
		bucket: "routing",
		...(input.budget === undefined ? {} : { budget: input.budget }),
		...(input.now === undefined ? {} : { now: input.now }),
		...(input.signal === undefined ? {} : { signal: input.signal }),
	});
	const record = outcome.record;
	const cost = {
		model: record.model,
		costUsd: record.costUsd,
		stopReason: record.stopReason,
	};
	if (!outcome.ok) {
		const stopped = record.stopReason === "ceiling" || record.stopReason === "budget-unreadable";
		const why = record.error ?? record.stopReason;
		return {
			accepted: false,
			methodologyHash: hash,
			fallback: stopped ? "ceiling" : "failed",
			reason: (stopped ? `jev ceiling: ${why}` : `jev failed: ${why}`).slice(0, MAX_REASON),
			...cost,
		};
	}

	const answer = outcome.answers[JEV_ANSWER.choice];
	const picked = answer?.type === "choice" ? answer.choice : "";
	const chosen = facts.candidates.find((candidate) => candidate.ref === picked);
	// A closed list is only closed if code enforces it: an answer the set does not hold is discarded, never
	// mapped onto the nearest ref (VR24-203 (2), acceptance (a)).
	if (chosen === undefined) {
		return {
			accepted: false,
			choice: picked,
			methodologyHash: hash,
			fallback: "outside-set",
			reason: `Jev answered "${picked}", which is not one of the ${facts.candidates.length} candidates, so ${facts.deterministic} stands`.slice(0, MAX_REASON),
			...cost,
		};
	}
	// The reason field carries a deciding-fact code; the prompt's one sentence is written from the facts below. A
	// prose value there is a model that ignored the code list, which is no reason to discard a choice inside the set.
	const why = outcome.answers[JEV_ANSWER.reason];
	const code = why?.type === "choice" && why.choice in JEV_BECAUSE ? (why.choice as JevBecause) : undefined;
	return {
		accepted: true,
		choice: chosen.ref,
		...(code === undefined ? {} : { because: code }),
		reason: jevReason(chosen, code),
		...(answer?.type === "choice" ? { confidence: answer.confidence } : {}),
		methodologyHash: hash,
		...cost,
	};
}

/** Jev's answer as the decision line carries it. */
export function routeJev(jev: JevChoice): RouteJev {
	return {
		choice: jev.choice ?? "",
		accepted: jev.accepted,
		methodologyHash: jev.methodologyHash,
		...(jev.reason === undefined ? {} : { reason: jev.reason }),
		...(jev.because === undefined ? {} : { because: jev.because }),
		...(jev.confidence === undefined ? {} : { confidence: jev.confidence }),
		...(jev.model === undefined ? {} : { model: jev.model }),
		...(jev.costUsd === undefined ? {} : { costUsd: jev.costUsd }),
		...(jev.fallback === undefined ? {} : { fallback: jev.fallback }),
	};
}

export interface ShadowDecisionInput {
	placement: LanePlacement;
	jev: JevChoice;
	at: number;
	lane?: string;
	project?: string;
}

/**
 * The shadow line: the deterministic placement code made, with Jev's answer beside it and `shadow: true`, so no
 * reader mistakes it for a placement (VR24-203 (3)). Nothing is returned when code placed nothing: a wait is the
 * door's own line, and a line with an empty `chosen` would read as a placement nobody made.
 */
export function shadowDecision(input: ShadowDecisionInput): RouteDecision | undefined {
	const { placement, jev } = input;
	if (placement.status !== "placed" || placement.ref === undefined) return undefined;
	return {
		at: input.at,
		...(input.lane === undefined ? {} : { lane: input.lane }),
		...(input.project === undefined ? {} : { project: input.project }),
		...(placement.facts === undefined ? {} : { taskKind: placement.facts.kind, class: placement.facts.class, facts: placement.facts }),
		chosen: placement.ref,
		by: "rule",
		shadow: true,
		candidates: placement.candidates,
		reason: placement.reason,
		jev: routeJev(jev),
	};
}
