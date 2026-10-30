/**
 * `muster report <kind>` — the CLI face of `lane_report` (design section 4.4).
 *
 * Same validation and same Concord mapping as the Pi tool: the report object
 * is built here, `mapLaneReport` refuses anything malformed, and the mapped
 * call runs against Concord. No second store, no second vocabulary.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConcordClient } from "../concord.ts";
import { recordLaneReport } from "../lib/lane-card.ts";
import { ensureClaudeLaneCard } from "../lib/claude-lane-card.ts";
import { backendState } from "../ledger/backend.ts";
import { musterStateDir, piAgentDir } from "../binding.ts";
import { mapLaneReport, normalizeReportKind, notifyOrchestrator, reportEventLine, appendOrchestratorEvent } from "../lane-report.ts";
import { parseFlags, requireAgentId, type CliCommand, type ParsedFlags } from "./types.ts";

const VALUE_FLAGS = ["task", "lane", "file", "summary", "branch", "sha", "base", "log", "decided", "doc", "reason", "needs", "question-kind", "text", "options", "recommendation", "where"];

/** The report object a command line expresses; `--file`/`--stdin` JSON wins. */
export function reportFromFlags(kind: string, parsed: ParsedFlags, positionalText: string): unknown {
	const summaryOrText = parsed.values.get("summary") ?? positionalText;
	const logs = parsed.multi.get("log");
	const decided = parsed.multi.get("decided");
	switch (kind) {
		case "review_ready":
			return {
				kind,
				summary: summaryOrText,
				branch: parsed.values.get("branch") ?? "",
				sha: parsed.values.get("sha") ?? "",
				...(parsed.values.get("base") !== undefined ? { base: parsed.values.get("base") } : {}),
				...(logs !== undefined ? { logs } : {}),
				...(decided !== undefined ? { decidedMyself: decided } : {}),
			};
		case "discovery_ready":
			return {
				kind,
				doc: parsed.values.get("doc") ?? summaryOrText,
				...(parsed.values.get("sha") !== undefined ? { sha: parsed.values.get("sha") } : {}),
			};
		case "blocked":
			return { kind, reason: parsed.values.get("reason") ?? summaryOrText, needs: parsed.values.get("needs") ?? "" };
		case "question":
			return {
				kind,
				question: {
					kind: parsed.values.get("question-kind") ?? parsed.values.get("kind") ?? "",
					text: parsed.values.get("text") ?? summaryOrText,
					...(parsed.values.get("options") !== undefined ? { options: parsed.values.get("options")!.split("|").map((part) => part.trim()).filter((part) => part !== "") } : {}),
					...(parsed.values.get("recommendation") !== undefined ? { recommendation: parsed.values.get("recommendation") } : {}),
				},
			};
		case "working":
			return { kind, summary: summaryOrText };
		case "already_done":
			return { kind, where: parsed.values.get("where") ?? summaryOrText };
		default:
			return { kind };
	}
}

export const command: CliCommand = {
	name: "report",
	summary: "File one lane report (review_ready, discovery_ready, blocked, question, working, already_done)",
	usage: [
		"muster report <kind> [--task <id>] [--lane <id>] [kind fields] [--json]",
		"  working:          <summary> | --summary <text>",
		"  blocked:          <reason> --needs <text>",
		"  question:         --question-kind <product-rule|decision-conflict|schema-change|outward-facing|data-deletion> --text <text> [--options a|b] [--recommendation <text>]",
		"  discovery_ready:  --doc <path> [--sha <sha>]",
		"  already_done:     --where <commit or file> | <where>",
		"  review_ready:     --summary <text> --branch <b> --sha <sha> [--base <sha>] [--log <path>]... [--decided <text>]...",
		"muster report --file <report.json>                       # a full report object",
		"muster report --stdin                                    # a full report object on stdin",
		"  with no --task the report is lane-level: recorded on the lane's card, and",
		"  sent to Concord without a task_id (check 3).",
	].join("\n"),
	async run(ctx) {
		const parsed = parseFlags(ctx.argv, VALUE_FLAGS);
		// The task is optional: without one this is a lane-level report (check 3).
		const taskId = parsed.values.get("task")?.trim();
		let raw: unknown;
		const file = parsed.values.get("file");
		if (file !== undefined) {
			try {
				raw = JSON.parse(readFileSync(file, "utf8"));
			} catch (error) {
				ctx.io.err(`muster report: ${file} could not be read as JSON (${error instanceof Error ? error.message : String(error)})`);
				return 2;
			}
		} else if (parsed.flags.has("stdin")) {
			try {
				raw = JSON.parse(await ctx.readStdin());
			} catch (error) {
				ctx.io.err(`muster report: stdin is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
				return 2;
			}
		} else {
			const kindWord = parsed.positionals[0];
			const kind = kindWord === undefined ? undefined : normalizeReportKind(kindWord);
			if (kind === undefined) {
				ctx.io.err("muster report: a kind is required\n" + command.usage);
				return 2;
			}
			raw = reportFromFlags(kind, parsed, parsed.positionals.slice(1).join(" ").trim());
		}

		const mapped = mapLaneReport(raw, taskId);
		if (!mapped.ok) {
			ctx.io.err(`muster report: ${mapped.error}`);
			return 2;
		}
		const identity = requireAgentId(ctx);
		if (typeof identity !== "string") {
			ctx.io.err(`muster report: ${identity.error}`);
			return 2;
		}
		const laneId = parsed.values.get("lane")?.trim() || identity;
		const laneLevel = mapped.level === "lane";
		// The ledger branch covers the frozen window too: a frozen switch writes files or
		// spools, and neither reaches Concord (LC-D2, §3.3).
		const ledgerMode = backendState(musterStateDir()).backend !== "files";
		// Every report files the line on the lane's own card (F7): a lane that held a
		// Concord task left `lastReport` empty, because only a lane-level report reached
		// the card. The card is the durable record whatever Concord answers.
		let cardRecorded: boolean | "spooled" = false;
		try {
			// A Claude Code lane has no heartbeat writer: its card is made here, on the
			// first report, from `claude agents`. A card that cannot be read or written
			// never stops the report: the owner below is what records it (DL6).
			ensureClaudeLaneCard(musterStateDir(), laneId);
		} catch {
			/* no card to make; the report still files through its owner */
		}
		try {
			cardRecorded = recordLaneReport(musterStateDir(), laneId, { ...mapped.line, at: Date.now() });
		} catch {
			cardRecorded = false;
		}
		// One store whatever the transport (efficiency plan section 1): the report
		// command appends its waking kinds to the shared events file, beside the
		// card, so a Claude lane's review reaches the file-based waiter too.
		const eventLine = reportEventLine(laneId, raw);
		if (eventLine !== undefined) appendOrchestratorEvent(musterStateDir(), eventLine);
		// The orchestrator is woken through its inbox whatever Concord answers: a REVIEW READY,
		// BLOCKED, question or discovery line lands in `muster wait --inbox orchestrator`.
		const notified = notifyOrchestrator(musterStateDir(), laneId, mapped.line);
		const noticeText = notified ? "; the orchestrator's inbox has it" : "";
		if (ledgerMode) {
			// Ledger mode connects no Concord client (LC-D8): the report's one store is
			// the ledger, and its owner spools the report when `musterd` is down (DL6),
			// so a spooled report counts as recorded and exits 0 with DL6's sentence.
			if (cardRecorded === "spooled") {
				ctx.io.out(`muster report: ${mapped.summary}; musterd is down; the report is kept and filed when it starts${noticeText}`);
				return 0;
			}
			if (cardRecorded === true) {
				ctx.io.out(`muster report: ${mapped.summary}; on the card as "${mapped.line.summary}"${noticeText}`);
				return 0;
			}
			ctx.io.err(`muster report: no ledger card for lane ${laneId}; nothing was recorded`);
			return 1;
		}
		const client = await ConcordClient.connect({
			launcherMcp: join(piAgentDir(), "extensions", "muster", "launchers", "concord-mcp"),
			repoRoot: ctx.repoRoot,
			agentId: identity,
			cwd: ctx.cwd,
		}).catch((error: unknown) => {
			ctx.io.err(`muster report: Concord is not reachable (${error instanceof Error ? error.message : String(error)})`);
			return undefined;
		});
		if (client === undefined) {
			if (laneLevel && cardRecorded) {
				ctx.io.err(`muster report: Concord is unreachable; the lane-level report is on the card as "${mapped.line.summary}"${noticeText}`);
				return 0;
			}
			return 1;
		}
		try {
			const result = await client.callTool(mapped.call.tool, mapped.call.args, { timeoutMs: 20_000 });
			if (ctx.json) ctx.io.out(JSON.stringify({ summary: mapped.summary, tool: mapped.call.tool, status: result.structuredContent?.["status"] ?? null, laneReport: mapped.line, cardRecorded, notified }, null, 2));
			else ctx.io.out(`muster report: ${mapped.summary}; on the card as "${mapped.line.summary}"${noticeText}`);
			return 0;
		} catch (error) {
			if (laneLevel && cardRecorded) {
				ctx.io.err(`muster report: Concord refused the lane-level record (${error instanceof Error ? error.message : String(error)}); the report is on the card as "${mapped.line.summary}"${noticeText}`);
				return 0;
			}
			ctx.io.err(`muster report: Concord refused the report (${error instanceof Error ? error.message : String(error)})`);
			return 1;
		} finally {
			await client.close().catch(() => undefined);
		}
	},
};
