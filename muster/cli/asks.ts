/**
 * `muster asks` — the operator's queue, read and answered (AK1).
 *
 * The read side prints what waits on him, in the design's order: an ask that
 * blocks a lane or task first, then the kinds only he may answer, then the rest
 * by age; `show` prints one ask whole, and `--json` prints the folded queue for
 * Bob, Henry and the register. A code that belongs to two live asks prints both
 * and acts on neither.
 *
 * The write side records a ruling (`answer`), the options and recommendation
 * (`prepare`), the artifact that carried the outcome (`done`), a withdrawal
 * (`withdraw`) and a pointer (`note`). Every one of them goes through the store
 * owner, and every one of them is refused unless this process may write the
 * queue: the operator's shell, the architect or the orchestrator.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	askCodeOf,
	askListSources,
	diffLists,
	formatAskDetail,
	formatAskLine,
	formatFileDiffAccounting,
	orderAsksForOperator,
	parseEvidence,
	programmeCardReader,
	readAsks,
	readReviewFindings,
	recordReviewFindings,
	regenerateOperatorList,
	resolveAskRef,
	resolveAskWriter,
	waitingOnOperator,
	answerAsk,
	finishAsk,
	noteAsk,
	prepareAsk,
	withdrawAsk,
	CLOSED_ASK_STATUSES,
	type Ask,
	type AskRelay,
	type AskWriter,
} from "../asks.ts";
import {
	offloadLabeller,
	parseHandAudits,
	renderComparisonReport,
	scanTranscripts,
	SCAN_WINDOWS,
	unreadableCause,
	unreadableRunIsOutage,
	type HandAuditItem,
	type ScanWindow,
} from "../asks-scan.ts";
import { musterStateDir } from "../binding.ts";
import { parseFlags, type CliCommand, type CliContext, type ParsedFlags } from "./types.ts";

const VALUE_FLAGS = ["ruling", "words", "relay", "row", "option", "recommend", "evidence", "reason", "text", "since", "report", "audits"];
const SUBCOMMANDS = ["show", "prepare", "answer", "done", "withdraw", "note", "sweep"] as const;
const RELAY_VIAS = ["architect-session", "grokbot-gateway"] as const;

export const command: CliCommand = {
	name: "asks",
	summary: "Read the operator's queue, or record an answer, a preparation, a finish, a withdrawal or a note",
	usage: [
		"muster asks [--all] [--json]                 # what waits on the operator, blockers first",
		"muster asks show <id|code>",
		"muster asks prepare <id|code> --option \"<o>\" [--option …] --recommend \"<o>\"",
		"muster asks answer <id|code> --ruling \"<text>\" [--words \"<w>\"] [--relay <ref>] [--row file:line]",
		"muster asks done <id|code> --evidence <kind>:<value>",
		"muster asks withdraw <id|code> --reason \"<r>\"",
		"muster asks note <id|code> \"<text>\"",
		"muster asks sweep --files                     # the file diff: what the queue is missing, and what may be done",
		"muster asks sweep --since <2h|4d|24h> [--dry-run]   # the transcript scan; --dry-run counts candidates and makes no model call",
		"muster asks sweep --report <path> [--audits <file>]  # the comparison report from the review list and the operator's hand audits",
		"  evidence: commit:<sha>@<repo> | row:<row>@<file>:<line> | log:<file>:<line>",
		"  a relay may name its carrier: --relay architect-session:<session id> | grokbot-gateway:<call>",
		"  a kind only the operator may approve recorded by anyone else needs his words and the relay that carried them",
		"  a card-linked ask is answered on its card, and a product question is answered by the operator or the architect: `answer` refuses both otherwise",
		"  the writer is the process: the operator's shell, the architect or the orchestrator (a lane is refused)",
	].join("\n"),
	async run(ctx) {
		const parsed = parseFlags(ctx.argv, VALUE_FLAGS);
		const stateDir = musterStateDir();
		const subcommand = parsed.positionals[0];
		if (subcommand === undefined) return listQueue(ctx, stateDir, parsed);
		if (!(SUBCOMMANDS as readonly string[]).includes(subcommand)) {
			ctx.io.err(`muster asks: unknown subcommand ${subcommand}\n${command.usage}`);
			return 2;
		}
		if (subcommand === "sweep") return await sweep(ctx, stateDir, parsed);
		const ref = parsed.positionals[1]?.trim();
		if (ref === undefined || ref === "") {
			ctx.io.err(`muster asks ${subcommand}: an ask id or code is required\n${command.usage}`);
			return 2;
		}
		const text = parsed.values.get("text") ?? parsed.positionals.slice(2).join(" ").trim();
		if (subcommand === "show") return showAsk(ctx, stateDir, ref);
		const writer = resolveAskWriter(ctx.env, ctx.agentId);
		if ("error" in writer) {
			ctx.io.err(`muster asks ${subcommand}: ${writer.error}`);
			return 2;
		}
		try {
			switch (subcommand) {
				case "prepare":
					return report(ctx, prepareAsk(stateDir, {
						ref,
						by: writer.writer,
						options: parsed.multi.get("option") ?? [],
						recommendation: parsed.values.get("recommend") ?? parsed.positionals.slice(2).join(" "),
					}), "prepared", stateDir);
				case "answer": {
					const relay = relayFrom(parsed, writer.writer);
					if (typeof relay === "string") {
						ctx.io.err(`muster asks answer: ${relay}`);
						return 2;
					}
					return report(ctx, answerAsk(stateDir, {
						ref,
						by: writer.writer,
						ruling: parsed.values.get("ruling") ?? text,
						...(parsed.values.get("words") !== undefined ? { words: parsed.values.get("words")! } : {}),
						...(parsed.values.get("row") !== undefined ? { row: parsed.values.get("row")! } : {}),
						...(relay !== undefined ? { relay } : {}),
					}), "answered", stateDir);
				}
				case "done": {
					const evidence = parseEvidence(parsed.values.get("evidence") ?? "");
					if (evidence === undefined) {
						ctx.io.err("muster asks done: --evidence must be commit:<sha>@<repo>, row:<row>@<file>:<line> or log:<file>:<line>");
						return 2;
					}
					return report(ctx, finishAsk(stateDir, { ref, by: writer.writer, evidence }), "finished", stateDir);
				}
				case "withdraw":
					return report(ctx, withdrawAsk(stateDir, { ref, by: writer.writer, reason: parsed.values.get("reason") ?? text }), "withdrawn", stateDir);
				default:
					return report(ctx, noteAsk(stateDir, { ref, by: writer.writer, text }), "noted", stateDir);
			}
		} catch (error) {
			ctx.io.err(`muster asks ${subcommand}: ${error instanceof Error ? error.message : String(error)}`);
			return 2;
		}
	},
};

/**
 * `muster asks sweep` (AK4 and AK5): the deterministic file diff over the lists a
 * person or an agent edits by hand, the transcript scan over a window, and the
 * comparison report that accepts both against the operator's hand audits. One check per
 * run. Every run records its findings on the review list and prints its accounting
 * line; none of them changes an ask's status, so a finding is a request for the
 * architect's queue event, never a status of its own.
 */
async function sweep(ctx: CliContext, stateDir: string, parsed: ParsedFlags): Promise<number> {
	const files = parsed.flags.has("files");
	const since = parsed.values.get("since");
	const report = parsed.values.get("report");
	const chosen = [files ? "--files" : undefined, since !== undefined ? "--since" : undefined, report !== undefined ? "--report" : undefined].filter(Boolean);
	if (chosen.length === 0) {
		ctx.io.err(`muster asks sweep: name one check — --files, --since <2h|4d|24h> or --report <path>\n${command.usage}`);
		return 2;
	}
	if (chosen.length > 1) {
		ctx.io.err(`muster asks sweep: one check per run, not ${chosen.join(" and ")}`);
		return 2;
	}
	if (files) return sweepFiles(ctx, stateDir, parsed);
	if (since !== undefined) return sweepSince(ctx, stateDir, since);
	return sweepReport(ctx, stateDir, report!, parsed);
}

/** `--files`: the file diff (AK4). */
function sweepFiles(ctx: CliContext, stateDir: string, parsed: ParsedFlags): number {
	const diff = diffLists(stateDir, { sources: askListSources(stateDir, { env: ctx.env }) });
	const recorded = recordReviewFindings(stateDir, diff.findings);
	for (const source of diff.sources) {
		if (source.missing) ctx.io.out(`  missing ${source.path}`);
	}
	for (const finding of diff.findings) {
		ctx.io.out(`  ${finding.finding} ${finding.source} ${finding.text}`);
	}
	ctx.io.out(formatFileDiffAccounting(diff, recorded));
	return 0;
}

/**
 * `--since <2h|4d|24h>`: the transcript scan (AK5). It labels its candidates with a
 * cheap pool model through one isolated headless Pi print-mode run per chunk
 * (no session, no extensions, its own model); `--dry-run` counts the candidates
 * the pre-filter finds and makes no model call and no write. A labelled run
 * whose every candidate stayed unreadable because the labeller could not label it
 * exits non-zero: a labelling substrate that cannot run must be loud, never an
 * accounting line. A run whose labels the scan itself refused keeps its warning
 * and its accounting and exits 0 (`unreadableRunIsOutage`, the one owner of the
 * difference, decided on the reason counts and never on the error text).
 */
async function sweepSince(ctx: CliContext, stateDir: string, since: string): Promise<number> {
	const window = since.trim();
	if (!(SCAN_WINDOWS as readonly string[]).includes(window)) {
		ctx.io.err(`muster asks sweep: --since is 2h, 4d or 24h, not ${JSON.stringify(window)}`);
		return 2;
	}
	let firstChunkError = "";
	const dryRun = ctx.argv.includes("--dry-run");
	try {
		const result = await scanTranscripts(stateDir, {
			window: window as ScanWindow,
			dryRun,
			env: ctx.env,
			...(dryRun ? {} : { labeller: offloadLabeller({ env: ctx.env, onError: (message) => { if (firstChunkError === "") firstChunkError = message; } }) }),
		});
		for (const finding of result.findings) ctx.io.out(`  ${finding.finding} ${finding.source} ${finding.text}`);
		if (!dryRun && result.candidates > 0 && result.buckets.unreadable === result.candidates) {
			const unscanned = result.unreadableReasons.unscanned;
			// A run whose candidates carry only refused labels is a content rejection: the warning stays, the
			// accounting stays, and the contract does not go red for a model's mistake.
			const outage = unreadableRunIsOutage(result);
			ctx.io.err(
				`muster asks sweep --since ${window}: every candidate (${result.candidates}) came back unreadable${unscanned > 0 ? ` (${unscanned} of them unscanned: no labelling attempt labelled them)` : ""}, so the run labelled nothing; the cause: ${unreadableCause(result, firstChunkError)}${outage ? "" : ". The labels were produced and the scan refused them, so this is a content rejection, not an outage"}`,
			);
			ctx.io.out(result.accounting);
			return outage ? 1 : 0;
		}
		ctx.io.out(result.accounting);
		return 0;
	} catch (error) {
		ctx.io.err(`muster asks sweep --since ${window}: ${error instanceof Error ? error.message : String(error)}`);
		return 2;
	}
}

/**
 * `--report <path>`: the comparison report (AK5, "The sweeper" step 3), from the
 * review list the two runs wrote and, when they have arrived, the operator's hand audits.
 * It runs no check and makes no model call.
 */
function sweepReport(ctx: CliContext, stateDir: string, reportPath: string, parsed: ParsedFlags): number {
	const auditsPath = parsed.values.get("audits");
	let audits: HandAuditItem[] = [];
	if (auditsPath !== undefined) {
		try {
			audits = parseHandAudits(readFileSync(auditsPath, "utf8"));
		} catch (error) {
			ctx.io.err(`muster asks sweep: cannot read --audits ${auditsPath}: ${error instanceof Error ? error.message : String(error)}`);
			return 2;
		}
	}
	const findings = readReviewFindings(stateDir).findings;
	const markdown = renderComparisonReport({ date: new Date().toISOString().slice(0, 10), findings, audits });
	try {
		mkdirSync(dirname(reportPath), { recursive: true });
		writeFileSync(reportPath, markdown, { mode: 0o644 });
	} catch (error) {
		ctx.io.err(`muster asks sweep: cannot write ${reportPath}: ${error instanceof Error ? error.message : String(error)}`);
		return 2;
	}
	ctx.io.out(`muster asks sweep: wrote ${reportPath} (${findings.length} findings, ${audits.length} audit items)`);
	return 0;
}

/** `--relay <ref>`; a `via:` prefix names the carrier, else the writer's own. */
function relayFrom(parsed: ParsedFlags, writer: AskWriter): AskRelay | undefined | string {
	const raw = parsed.values.get("relay")?.trim();
	if (raw === undefined || raw === "") return undefined;
	const via = RELAY_VIAS.find((candidate) => raw.startsWith(`${candidate}:`));
	const ref = via === undefined ? raw : raw.slice(via.length + 1).trim();
	if (ref === "") return "the relay needs the session id or gateway call that carried the operator's words";
	return {
		via: via ?? (writer === "grokbot" ? "grokbot-gateway" : "architect-session"),
		ref,
		at: new Date().toISOString(),
	};
}

/**
 * One written ask back to the caller, in text or as the folded ask. Every write
 * regenerates the list the operator reads first (AK3); a failed view write is reported
 * on stderr and never fails the event that was just appended.
 */
function report(ctx: CliContext, ask: Ask, verb: string, stateDir: string): number {
	const list = regenerateOperatorList(stateDir, { env: ctx.env });
	if ("error" in list) ctx.io.err(`muster asks: the list the operator reads was not regenerated: ${list.error}`);
	if (ctx.json) ctx.io.out(JSON.stringify(ask, null, 2));
	else ctx.io.out(`muster asks: ${askCodeOf(ask)} ${verb} — ${ask.status}${ask.recommendation !== undefined ? `, rec ${ask.recommendation}` : ""}`);
	return 0;
}

/** One ask whole; a code that belongs to two live asks prints both and acts on neither. */
function showAsk(ctx: CliContext, stateDir: string, ref: string): number {
	const queue = readAsks(stateDir, { cardState: programmeCardReader() });
	const resolution = resolveAskRef(queue, ref);
	if ("ambiguous" in resolution) {
		ctx.io.err(`muster asks show: ${ref} belongs to ${resolution.ambiguous.length} live asks; name one by id`);
		for (const ask of resolution.ambiguous) ctx.io.err(`  ${ask.id}  ${formatAskLine(ask, Date.now())}`);
		return 2;
	}
	if ("missing" in resolution) {
		ctx.io.err(`muster asks show: no live ask matches ${ref}`);
		return 2;
	}
	if (ctx.json) ctx.io.out(JSON.stringify(resolution.ask, null, 2));
	else for (const line of formatAskDetail(resolution.ask, Date.now())) ctx.io.out(line);
	return 0;
}

function listQueue(ctx: CliContext, stateDir: string, parsed: ParsedFlags): number {
	const queue = readAsks(stateDir, { cardState: programmeCardReader() });
	if (ctx.json) {
		ctx.io.out(JSON.stringify(queue, null, 2));
		return 0;
	}
	const waiting = orderAsksForOperator(waitingOnOperator(queue));
	const now = Date.now();
	if (waiting.length === 0) ctx.io.out("muster asks: nothing waits on the operator");
	else {
		ctx.io.out(`muster asks: ${waiting.length} waiting on the operator`);
		for (const ask of waiting) ctx.io.out(`  ${formatAskLine(ask, now)}`);
	}
	if (parsed.flags.has("all")) {
		const settled = queue.asks.filter((ask) => CLOSED_ASK_STATUSES.includes(ask.status) || ask.status === "decided");
		if (settled.length > 0) {
			ctx.io.out(`muster asks: ${settled.length} settled`);
			for (const ask of settled) ctx.io.out(`  ${formatAskLine(ask, now)}`);
		}
	}
	for (const code of queue.duplicateCodes) {
		const holders = queue.asks.filter((ask) => ask.code === code).map((ask) => ask.id);
		ctx.io.out(`muster asks: review — ${holders.length} live asks share code ${code} (${holders.join(", ")}); list both, act on neither`);
	}
	for (const ask of queue.asks) {
		if (ask.cardState === "unreadable") ctx.io.out(`muster asks: review — ${askCodeOf(ask)} links a card that cannot be read`);
	}
	if (queue.partialLastLine > 0) ctx.io.out(`muster asks: review — ${queue.path} ends mid-write; the next append repairs it`);
	if (queue.unreadableLines > 0) ctx.io.out(`muster asks: review — ${queue.unreadableLines} unreadable line(s) in ${queue.path}`);
	return 0;
}
