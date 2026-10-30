/**
 * Lane reports — A3 of the harness bus design, section 4.4 (D2).
 *
 * One report vocabulary over Concord calls, so no second store: a lane
 * finishes work, records a finding, a blocker, a question or progress through
 * this module's mapping and the tool/CLI faces carry only transport.
 *
 * Validation is strict and happens before any Concord call: an unknown kind, a
 * missing field or a question outside the allowed kinds is refused here, not
 * written to the task record. `questions[]` carries only the five kinds a
 * worker may stop for (methodology.md), so a report cannot smuggle an ordinary
 * detail in as a decision request.
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeInboxMessage } from "./lib/agent-inbox.ts";
import { backendState } from "./ledger/backend.ts";
import { MusterdUnreachable } from "./ledger/client.ts";
import { requestSync } from "./ledger/client-sync.ts";
import { spoolWrite } from "./ledger/spool.ts";
import { ownerLedgerSocket } from "./ledger/stores.ts";

export const LANE_REPORT_KINDS = ["review_ready", "discovery_ready", "blocked", "question", "working", "already_done"] as const;
export type LaneReportKind = (typeof LANE_REPORT_KINDS)[number];

/**
 * The five kinds a worker may stop and ask about (methodology.md, "Workers own
 * their slice"). Anything else belongs in the report text, not in a question.
 */
export const QUESTION_KINDS = ["product-rule", "decision-conflict", "schema-change", "outward-facing", "data-deletion"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export type LaneQuestion = {
	/** One of QUESTION_KINDS. */
	kind: QuestionKind;
	text: string;
	options?: string[];
	recommendation?: string;
};

export type LaneReportOutcome = {
	source?: "agent" | "ci" | "review" | "human";
	acceptance?: "accepted" | "rejected";
	integration?: "passed" | "failed";
};

export type LaneReport =
	| {
			kind: "review_ready";
			summary: string;
			branch: string;
			sha: string;
			base?: string;
			logs?: string[];
			decidedMyself?: string[];
			questions?: LaneQuestion[];
			outcome?: LaneReportOutcome;
	  }
	| { kind: "discovery_ready"; doc: string; sha?: string; questions?: LaneQuestion[] }
	| { kind: "blocked"; reason: string; needs: string }
	| { kind: "question"; question: LaneQuestion }
	| { kind: "working"; summary: string }
	| { kind: "already_done"; where: string };

/** One Concord call: the tool name and its arguments. */
export type ConcordCall = { tool: "finish_work" | "update_work"; args: Record<string, unknown> };

export type LaneReportMapping =
	| { ok: true; call: ConcordCall; summary: string; level: "task" | "lane"; laneReport: LaneReportLine; line: LaneReportLine }
	| { ok: false; error: string };

/**
 * The form of a report the lane's own card carries.
 *
 * Every report kind renders one line and writes it to the lane's card (F7): a
 * lane holding a Concord task used to leave `lastReport` empty, because only a
 * lane-level report reached the card. A lane without a task is the same line
 * with `task_id` omitted (acceptance check 3), and the directory shows it.
 */
export interface LaneReportLine {
	kind: LaneReportKind;
	/** One line, already rendered for a table cell. */
	summary: string;
	/** The reported branch, commit and base (`review_ready`), or the commit (`discovery_ready`). */
	branch?: string;
	sha?: string;
	base?: string;
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

function optionalStringArray(value: unknown, field: string): { ok: true; value?: string[] } | { ok: false; error: string } {
	if (value === undefined || value === null) return { ok: true };
	if (!Array.isArray(value) || value.some((item) => !nonEmpty(item))) return { ok: false, error: `${field} must be an array of non-empty strings` };
	return { ok: true, value: value as string[] };
}

/** Validate one question, including its kind against the allowed five. */
export function validateQuestion(raw: unknown, field: string): { ok: true; question: LaneQuestion } | { ok: false; error: string } {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: `${field} must be an object` };
	const input = raw as Record<string, unknown>;
	for (const key of Object.keys(input)) {
		if (!["kind", "text", "options", "recommendation"].includes(key)) return { ok: false, error: `${field} has unknown field ${key}` };
	}
	if (!nonEmpty(input["kind"])) return { ok: false, error: `${field}.kind is required` };
	if (!(QUESTION_KINDS as readonly string[]).includes(input["kind"])) {
		return { ok: false, error: `${field}.kind must be one of ${QUESTION_KINDS.join(", ")} (an ordinary detail is not a question a worker stops for)` };
	}
	if (!nonEmpty(input["text"])) return { ok: false, error: `${field}.text is required` };
	const options = optionalStringArray(input["options"], `${field}.options`);
	if (!options.ok) return options;
	if (input["recommendation"] !== undefined && !nonEmpty(input["recommendation"])) return { ok: false, error: `${field}.recommendation must be a non-empty string` };
	return {
		ok: true,
		question: {
			kind: input["kind"] as QuestionKind,
			text: input["text"],
			...(options.value !== undefined ? { options: options.value } : {}),
			...(nonEmpty(input["recommendation"]) ? { recommendation: input["recommendation"] } : {}),
		},
	};
}

/** The question as the record text Concord keeps. */
export function formatQuestion(question: LaneQuestion): string {
	const parts = [`[${question.kind}] ${question.text}`];
	if (question.options !== undefined && question.options.length > 0) parts.push(`Options: ${question.options.join(" | ")}`);
	if (question.recommendation !== undefined) parts.push(`Recommendation: ${question.recommendation}`);
	return parts.join("\n");
}

/**
 * Validate one report object and map it to its Concord call.
 * `taskId` is the task the report is about (the lane's active task, or an
 * explicit override). Without one the report is lane-level: the same call shape
 * without `task_id`, plus the card line the directory shows (check 3).
 */
export function mapLaneReport(raw: unknown, taskId: string | undefined): LaneReportMapping {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "report must be an object" };
	const input = raw as Record<string, unknown>;
	const kind = input["kind"];
	if (!nonEmpty(kind) || !(LANE_REPORT_KINDS as readonly string[]).includes(kind)) {
		return { ok: false, error: `kind must be one of ${LANE_REPORT_KINDS.join(", ")}` };
	}
	const level: "task" | "lane" = nonEmpty(taskId) ? "task" : "lane";
	/** A task-bound call carries the task; a lane-level report omits it. */
	const call = (tool: ConcordCall["tool"], args: Record<string, unknown>): ConcordCall => ({
		tool,
		args: level === "task" ? { task_id: taskId as string, ...args } : args,
	});
	const where = level === "task" ? `for ${taskId}` : "at lane level";
	/** Render this report into the one card line every kind carries, task or not. */
	const withLine = (mapping: { ok: true; call: ConcordCall; summary: string }, line: string, refs: Pick<LaneReportLine, "branch" | "sha" | "base"> = {}): LaneReportMapping => {
		const reportLine: LaneReportLine = { kind: kind as LaneReportKind, summary: line, ...refs };
		return { ...mapping, level, laneReport: reportLine, line: reportLine };
	};

	const finish = (args: Record<string, unknown>): ConcordCall => call("finish_work", args);

	switch (kind as LaneReportKind) {
		case "review_ready": {
			if (!nonEmpty(input["summary"])) return { ok: false, error: "review_ready requires summary" };
			if (!nonEmpty(input["branch"])) return { ok: false, error: "review_ready requires branch" };
			if (!nonEmpty(input["sha"])) return { ok: false, error: "review_ready requires sha" };
			if (input["base"] !== undefined && !nonEmpty(input["base"])) return { ok: false, error: "review_ready.base must be a non-empty string" };
			const logs = optionalStringArray(input["logs"], "logs");
			if (!logs.ok) return logs;
			const decided = optionalStringArray(input["decidedMyself"], "decidedMyself");
			if (!decided.ok) return decided;
			const questions: LaneQuestion[] = [];
			if (input["questions"] !== undefined) {
				if (!Array.isArray(input["questions"])) return { ok: false, error: "questions must be an array" };
				for (let index = 0; index < input["questions"].length; index += 1) {
					const checked = validateQuestion(input["questions"][index], `questions[${index}]`);
					if (!checked.ok) return checked;
					questions.push(checked.question);
				}
			}
			const summaryLines = [input["summary"] as string, `branch ${input["branch"]} @ ${input["sha"]}${input["base"] === undefined ? "" : ` (base ${input["base"]})`}`];
			if (logs.value !== undefined && logs.value.length > 0) summaryLines.push(`Logs: ${logs.value.join(", ")}`);
			if (decided.value !== undefined && decided.value.length > 0) summaryLines.push(`Decided myself: ${decided.value.join("; ")}`);
			const args: Record<string, unknown> = {
				outcome: "review_ready",
				what_changed: summaryLines.join("\n"),
			};
			if (decided.value !== undefined && decided.value.length > 0) args["decisions"] = decided.value;
			if (logs.value !== undefined) args["tests_run"] = logs.value;
			if (questions.length > 0) args["open_questions"] = questions.map(formatQuestion);
			// reported_outcome is only sent when it carries a measured result; the
			// schema refuses an all-not_checked claim, and provenance names the source.
			if (input["outcome"] !== undefined) {
				if (input["outcome"] === null || typeof input["outcome"] !== "object" || Array.isArray(input["outcome"])) return { ok: false, error: "review_ready.outcome must be an object" };
				const outcome = input["outcome"] as Record<string, unknown>;
				for (const key of Object.keys(outcome)) {
					if (!["source", "acceptance", "integration"].includes(key)) return { ok: false, error: `review_ready.outcome has unknown field ${key}` };
				}
				const measured = outcome["acceptance"] !== undefined || outcome["integration"] !== undefined;
				if (!measured) return { ok: false, error: "review_ready.outcome needs a measured acceptance or integration value, not only a source" };
				args["reported_outcome"] = {
					source: nonEmpty(outcome["source"]) ? outcome["source"] : "agent",
					...(outcome["acceptance"] !== undefined ? { acceptance: outcome["acceptance"] } : {}),
					...(outcome["integration"] !== undefined ? { integration: outcome["integration"] } : {}),
				};
				args["provenance"] = [{ field: "reported_outcome", source: `lane_report review_ready ${input["sha"]}` }];
			}
			return withLine({ ok: true, call: finish(args), summary: `review_ready recorded ${where}: ${input["branch"]} @ ${input["sha"]}` }, `REVIEW READY: ${input["branch"]}@${input["sha"]}${input["base"] === undefined ? "" : ` (base ${input["base"]})`} — ${input["summary"]}`, {
				branch: input["branch"] as string,
				sha: input["sha"] as string,
				...(input["base"] !== undefined ? { base: input["base"] as string } : {}),
			});
		}
		case "discovery_ready": {
			if (!nonEmpty(input["doc"])) return { ok: false, error: "discovery_ready requires doc" };
			if (input["sha"] !== undefined && !nonEmpty(input["sha"])) return { ok: false, error: "discovery_ready.sha must be a non-empty string" };
			const questions: LaneQuestion[] = [];
			if (input["questions"] !== undefined) {
				if (!Array.isArray(input["questions"])) return { ok: false, error: "questions must be an array" };
				for (let index = 0; index < input["questions"].length; index += 1) {
					const checked = validateQuestion(input["questions"][index], `questions[${index}]`);
					if (!checked.ok) return checked;
					questions.push(checked.question);
				}
			}
			const content = [`Discovery doc: ${input["doc"]}${input["sha"] === undefined ? "" : ` @ ${input["sha"]}`}`, ...questions.map(formatQuestion)].join("\n");
			return withLine({
				ok: true,
				call: call("update_work", { operation: "record", kind: "finding", content }),
				summary: `discovery_ready recorded as a finding ${where}`,
			}, `DISCOVERY READY: ${input["doc"]}${input["sha"] === undefined ? "" : ` @ ${input["sha"]}`}`, input["sha"] !== undefined ? { sha: input["sha"] as string } : {});
		}
		case "blocked": {
			if (!nonEmpty(input["reason"])) return { ok: false, error: "blocked requires reason" };
			if (!nonEmpty(input["needs"])) return { ok: false, error: "blocked requires needs" };
			const content = `Blocked: ${input["reason"]}\nNeeds: ${input["needs"]}`;
			return withLine({
				ok: true,
				call: call("update_work", { operation: "record", kind: "blocker", content }),
				summary: `blocked recorded ${where}`,
			}, `BLOCKED: ${input["reason"]} (needs: ${input["needs"]})`);
		}
		case "question": {
			const checked = validateQuestion(input["question"], "question");
			if (!checked.ok) return checked;
			return withLine({
				ok: true,
				call: call("update_work", { operation: "record", kind: "question", content: formatQuestion(checked.question) }),
				summary: `question recorded ${where}`,
			}, `QUESTION: ${formatQuestion(checked.question)}`);
		}
		case "working": {
			if (!nonEmpty(input["summary"])) return { ok: false, error: "working requires summary" };
			return withLine({
				ok: true,
				call: call("update_work", { operation: "record", kind: "progress", content: input["summary"] }),
				summary: `progress recorded ${where}`,
			}, `progress: ${input["summary"]}`);
		}
		case "already_done": {
			if (!nonEmpty(input["where"])) return { ok: false, error: "already_done requires where (the commit or file that already holds the outcome)" };
			return withLine({
				ok: true,
				call: call("update_work", { operation: "record", kind: "finding", content: `Already done: ${input["where"]}` }),
				summary: `already_done recorded as a finding ${where}`,
			}, `ALREADY DONE: ${input["where"]}`);
		}
	}
}

/**
 * The orchestrator is an address, not a harness: lanes report to `orchestrator`,
 * and whoever holds the role (Claude Code, Pi) reads that inbox.
 */
export const ORCHESTRATOR_ADDRESS = "orchestrator";

/** The reports that wake the orchestrator. `working` is progress: the card carries it and nobody is woken. */
export const WAKING_REPORT_KINDS: readonly LaneReportKind[] = ["review_ready", "discovery_ready", "blocked", "question", "already_done"];

/**
 * Put a report that should wake the orchestrator into its inbox, so a lane's
 * `lane_report` reaches `muster wait --inbox orchestrator`. Returns whether a
 * notice was written. Never throws: the card and Concord keep the record, and a
 * failed notice must not turn a filed report into an error.
 */
export function notifyOrchestrator(musterStateDir: string, laneId: string, line: LaneReportLine, now: Date = new Date()): boolean {
	if (!WAKING_REPORT_KINDS.includes(line.kind) || laneId === ORCHESTRATOR_ADDRESS) return false;
	try {
		writeInboxMessage(musterStateDir, {
			agent: ORCHESTRATOR_ADDRESS,
			from: laneId,
			at: now.toISOString(),
			text: line.summary,
			idempotencyKey: `report:${laneId}:${now.getTime()}`,
			source: "report",
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Where every harness appends its event line (efficiency plan, section 1).
 *
 * The file sits beside the Muster state dir, never inside it: the card directory
 * enumerates `*.json` under the state dir, and the events file is plain text for
 * the one waiter (`orch-wait.sh`, WP2) whatever wrote it. Resolving it from the
 * Muster state dir keeps one answer when `PI_MUSTER_STATE_DIR` moves both.
 */
export function orchestratorEventsPath(musterStateDir: string): string {
	return join(dirname(musterStateDir), "orchestrator-events.log");
}

/** `date -Iseconds`: local ISO-8601 seconds with the offset, exactly what the contract shows. */
function isoSecondsLocal(now: Date): string {
	const pad = (value: number, width = 2): string => String(Math.abs(value)).padStart(width, "0");
	const offsetMinutes = -now.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
	return `${date}T${time}${sign}${pad(Math.trunc(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
}

/**
 * One committed ledger event as the line the events file carries (LC9), so the
 * same waiter output comes from either store.
 */
export function formatEventRecord(event: { type: string; lane?: string; text: string; at: number }): string {
	return `${isoSecondsLocal(new Date(event.at))} ${formatEventLine(event.type as EventKind, event.lane ?? "", event.text)}`;
}

/** The kinds of event line the orchestrator's waiter reads (efficiency blueprint, section 1). */
export const EVENT_KINDS = ["REVIEW READY", "BLOCKED", "QUESTION", "ALREADY DONE", "QUOTA WALL", "STALLED", "CRASHED", "ASLEEP"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/**
 * One event line without its date: `<KIND>: <lane> | <detail>`, except REVIEW READY,
 * whose detail is already `<branch>@<sha> | <one line>` and follows the lane after a space.
 *
 * The one place the line format is built. The report command, the Claude StopFailure
 * hook and muster-tick build their lines here, and `night-watch.py` writes the same
 * shape. A line break in the detail would split one event into two waiter lines, so
 * it collapses to a space.
 */
export function formatEventLine(kind: EventKind, lane: string, detail: string): string {
	const oneLine = detail.replace(/\s*[\r\n]+\s*/g, " ").trim();
	return kind === "REVIEW READY" ? `${kind}: ${lane} ${oneLine}` : `${kind}: ${lane} | ${oneLine}`;
}

/**
 * The inverse of `formatEventLine`, for the ledger's own record (LC9): the ledger
 * stores the kind, the lane and the detail as fields, and `formatEventRecord`
 * renders the line back. Both directions of the one format live here, so a caller
 * that only has the line (the hook, the tick, a lane's report) still writes one
 * record and the `lanes` filter has a lane to match.
 *
 * A line in neither shape answers with an empty kind: it is kept, and the waiter's
 * kind filter leaves it unprinted rather than inventing a kind for it.
 */
export function parseEventLine(line: string): { kind: string; lane: string; detail: string } {
	const colon = line.indexOf(": ");
	if (colon < 0) return { kind: "", lane: "", detail: line };
	const kind = line.slice(0, colon);
	const rest = line.slice(colon + 2);
	const separator = kind === "REVIEW READY" ? " " : " | ";
	const at = rest.indexOf(separator);
	if (at < 0) return { kind, lane: "", detail: rest };
	return { kind, lane: rest.slice(0, at), detail: rest.slice(at + separator.length) };
}

/**
 * The event line for one report, or undefined for a kind the waiter does not
 * wake on.
 *
 * The waking kinds are review_ready, blocked, question and already_done; a
 * discovery doc rides the report itself, and progress is the card's business.
 * The line names the lane, so the reader needs no second lookup.
 */
export function reportEventLine(laneId: string, raw: unknown): string | undefined {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const input = raw as Record<string, unknown>;
	switch (input["kind"]) {
		case "review_ready":
			return nonEmpty(input["summary"]) && nonEmpty(input["branch"]) && nonEmpty(input["sha"])
				? formatEventLine("REVIEW READY", laneId, `${input["branch"]}@${input["sha"]} | ${input["summary"]}`)
				: undefined;
		case "blocked":
			return nonEmpty(input["reason"]) && nonEmpty(input["needs"])
				? formatEventLine("BLOCKED", laneId, `${input["reason"]} (needs: ${input["needs"]})`)
				: undefined;
		case "question": {
			const checked = validateQuestion(input["question"], "question");
			return checked.ok ? formatEventLine("QUESTION", laneId, formatQuestion(checked.question)) : undefined;
		}
		case "already_done":
			return nonEmpty(input["where"]) ? formatEventLine("ALREADY DONE", laneId, input["where"]) : undefined;
		default:
			return undefined;
	}
}

/**
 * The request id of one event line: the same line at the same moment is one
 * event, so a spool replay writes once and two lines written in the same
 * millisecond stay two events.
 */
function eventRequestId(line: string, at: Date): string {
	return `event:${at.getTime()}:${createHash("sha1").update(line).digest("hex").slice(0, 16)}`;
}

/** One spool file per event line, in the shape `replaySpool` reads back through this owner (DL6, §3.2). */
function spoolOrchestratorEvent(musterStateDir: string, line: string, at: Date, requestId: string): "spooled" {
	spoolWrite(musterStateDir, { method: "appendEvent", params: { owner: "event", line, at: at.getTime(), requestId } });
	return "spooled";
}

/**
 * Append one event line through its one owner, answering where it went: `true`
 * when it is durably recorded, `"spooled"` when `musterd` is unreachable or the
 * switch is frozen and the line waits for the replay, `false` when nothing was
 * written. Never throws: the card and Concord hold the record, and a failed
 * append must not turn a filed report into an error.
 *
 * Files mode writes today's line byte for byte. Ledger mode appends one
 * `muster.event` entry through the synchronous bridge (LC9), with the kind, the
 * lane and the detail the waiter's filter and re-render read.
 */
export function recordOrchestratorEvent(musterStateDir: string, line: string, now: Date = new Date()): boolean | "spooled" {
	let state: ReturnType<typeof backendState>;
	try {
		state = backendState(musterStateDir);
	} catch {
		// A torn switch is the flip tool's to fix; an event that cannot be read
		// must not turn a filed report into an error.
		return false;
	}
	const requestId = eventRequestId(line, now);
	if (state.backend === "frozen") return spoolOrchestratorEvent(musterStateDir, line, now, requestId);
	if (state.backend === "ledger") {
		const parsed = parseEventLine(line);
		try {
			requestSync(ownerLedgerSocket(musterStateDir), "appendEvent", {
				type: parsed.kind,
				...(parsed.lane === "" ? {} : { lane: parsed.lane }),
				text: parsed.detail,
				requestId,
			});
			return true;
		} catch (error) {
			if (error instanceof MusterdUnreachable) return spoolOrchestratorEvent(musterStateDir, line, now, requestId);
			return false;
		}
	}
	try {
		const path = orchestratorEventsPath(musterStateDir);
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${isoSecondsLocal(now)} ${line}\n`);
		return true;
	} catch {
		return false;
	}
}

/**
 * Append one event line, prefixed with `date -Iseconds`, to the shared events
 * file (files mode) or the ledger (ledger mode). The boolean face the existing
 * callers keep: true only when the line is durably recorded, never when it is
 * only spooled, so `replaySpool` keeps a file whose write did not land.
 */
export function appendOrchestratorEvent(musterStateDir: string, line: string, now: Date = new Date()): boolean {
	return recordOrchestratorEvent(musterStateDir, line, now) === true;
}

/** Report kind from a bare CLI word (`muster report blocked ...`) or a report object. */
export function normalizeReportKind(word: string): LaneReportKind | undefined {
	const normalized = word.trim().toLowerCase().replace(/-/g, "_");
	return (LANE_REPORT_KINDS as readonly string[]).includes(normalized) ? (normalized as LaneReportKind) : undefined;
}

/**
 * The tool parameters (snake_case, the Concord convention) as one JSON schema.
 * `kind` is required; each kind reads only its own fields and validation names
 * the missing one.
 */
export const LANE_REPORT_PARAMETERS = {
	type: "object",
	properties: {
		kind: { type: "string", enum: [...LANE_REPORT_KINDS], description: "Which report this is" },
		task_id: { type: "string", description: "Task the report is about; defaults to this session's active task" },
		summary: { type: "string", description: "review_ready/working: what happened, in review terms" },
		branch: { type: "string", description: "review_ready: branch carrying the work" },
		sha: { type: "string", description: "review_ready/discovery_ready: commit the report names" },
		base: { type: "string", description: "review_ready: base commit the branch starts from" },
		logs: { type: "array", items: { type: "string" }, description: "review_ready: evidence and log paths" },
		decided_myself: { type: "array", items: { type: "string" }, description: "review_ready: decisions this lane made on its own" },
		questions: {
			type: "array",
			description: "review_ready/discovery_ready: open questions, each with an allowed kind",
			items: {
				type: "object",
				properties: {
					kind: { type: "string", enum: [...QUESTION_KINDS] },
					text: { type: "string" },
					options: { type: "array", items: { type: "string" } },
					recommendation: { type: "string" },
				},
				required: ["kind", "text"],
				additionalProperties: false,
			},
		},
		doc: { type: "string", description: "discovery_ready: the document that is ready" },
		where: { type: "string", description: "already_done: the commit or file that already holds the outcome" },
		reason: { type: "string", description: "blocked: what stopped the work" },
		needs: { type: "string", description: "blocked: what would unblock it, and from whom" },
		question: {
			type: "object",
			description: "question: one question with an allowed kind",
			properties: {
				kind: { type: "string", enum: [...QUESTION_KINDS] },
				text: { type: "string" },
				options: { type: "array", items: { type: "string" } },
				recommendation: { type: "string" },
			},
			required: ["kind", "text"],
			additionalProperties: false,
		},
	},
	required: ["kind"],
	additionalProperties: true,
} as const;

/** Tool parameters (snake_case) to the report object `mapLaneReport` validates. */
export function laneReportFromParams(params: Record<string, unknown>): unknown {
	const kind = params["kind"];
	switch (kind) {
		case "review_ready":
			return {
				kind,
				summary: params["summary"],
				branch: params["branch"],
				sha: params["sha"],
				...(params["base"] !== undefined ? { base: params["base"] } : {}),
				...(params["logs"] !== undefined ? { logs: params["logs"] } : {}),
				...(params["decided_myself"] !== undefined ? { decidedMyself: params["decided_myself"] } : {}),
				...(params["questions"] !== undefined ? { questions: params["questions"] } : {}),
				...(params["outcome"] !== undefined ? { outcome: params["outcome"] } : {}),
			};
		case "discovery_ready":
			return {
				kind,
				doc: params["doc"],
				...(params["sha"] !== undefined ? { sha: params["sha"] } : {}),
				...(params["questions"] !== undefined ? { questions: params["questions"] } : {}),
			};
		case "blocked":
			return { kind, reason: params["reason"], needs: params["needs"] };
		case "question":
			return { kind, question: params["question"] };
		case "working":
			return { kind, summary: params["summary"] };
		case "already_done":
			return { kind, where: params["where"] };
		default:
			return { kind };
	}
}
