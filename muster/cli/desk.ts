/**
 * `muster desk` — the research desk, read and attached (command center blueprint r6, D13).
 *
 * `list` prints the cards, or with `--json` the whole record (the architect saves it before a revert of the
 * desk, R6.4). `show` prints one card with its taps and report. `attach` records the report a research lane
 * wrote; it is allowed for the writers the ask queue allows for the operator's shell, the architect and the
 * orchestrator, and a lane is refused. Every read and write goes through `research-desk.ts`.
 */

import { homedir } from "node:os";

import { notASeatRefusal, resolveAskWriter } from "../asks.ts";
import { musterStateDir } from "../binding.ts";
import { attachReport, cardVersion, cardsForPage, deskStore, readDesk, researchRoot, type DeskCard, type DeskRecord } from "../research-desk.ts";
import { parseFlags, type CliCommand } from "./types.ts";

const VALUE_FLAGS = ["report"];
const SUBCOMMANDS = ["list", "show", "attach"] as const;

export const command: CliCommand = {
	name: "desk",
	summary: "Read the research desk's cards and taps, or attach the report of a dig-deeper lane to its card",
	usage: [
		"muster desk list [--json]                    # the cards; --json prints the whole desk record",
		"muster desk show <card id> [--json]",
		"muster desk attach <card id> --report <path>  # the report must be a file of at most 256 KB under ~/research/",
		"  the writer of `attach` is the process: the operator's shell, the architect or the orchestrator (a lane is refused)",
	].join("\n"),
	async run(ctx) {
		const parsed = parseFlags(ctx.argv, VALUE_FLAGS);
		const subcommand = parsed.positionals[0];
		if (subcommand === undefined || !(SUBCOMMANDS as readonly string[]).includes(subcommand)) {
			ctx.io.err(`muster desk: ${subcommand === undefined ? "a subcommand is required" : `unknown subcommand ${subcommand}`}\n${command.usage}`);
			return 2;
		}
		const fail = (message: string): number => {
			ctx.io.err(`muster desk ${subcommand}: ${message}`);
			return 2;
		};
		try {
			const store = deskStore(musterStateDir());
			const record = readDesk(store);
			if (subcommand === "list") {
				if (ctx.json) ctx.io.out(JSON.stringify(record, null, 2));
				else ctx.io.out(listText(record, Date.now()));
				return 0;
			}
			const ref = parsed.positionals[1]?.trim() ?? "";
			if (ref === "") return fail("a card id is required");
			const card = findCard(record, ref);
			if (typeof card === "string") return fail(card);
			if (subcommand === "show") {
				ctx.io.out(ctx.json ? JSON.stringify(detail(record, card), null, 2) : detailText(record, card));
				return 0;
			}
			const writer = resolveAskWriter(ctx.env, ctx.agentId);
			if ("error" in writer) return fail(writer.error);
			// A chat session closes only the ask its own thread raised (VR24-230), and a desk card is not an
			// ask: attaching a report to one stays with a seat.
			if (writer.writer === "chat-session") return fail(notASeatRefusal((ctx.agentId ?? "").trim()));
			const report = parsed.values.get("report")?.trim() ?? "";
			if (report === "") return fail("--report <path> is required");
			const next = attachReport(store, { cardId: card.id, path: report, root: researchRoot(ctx.env["HOME"] ?? homedir()) });
			ctx.io.out(ctx.json ? JSON.stringify({ card: card.id, report: next.reports[card.id] }, null, 2) : `attached ${card.id}: ${next.reports[card.id]} (revision ${next.revision})`);
			return 0;
		} catch (error) {
			return fail(error instanceof Error ? error.message : String(error));
		}
	},
};

/** A card by its id, or by a prefix of it that names one card. A string result is the refusal. */
function findCard(record: DeskRecord, ref: string): DeskCard | string {
	const exact = record.cards.find((card) => card.id === ref);
	if (exact !== undefined) return exact;
	const matches = record.cards.filter((card) => card.id.startsWith(ref));
	if (matches.length === 1) return matches[0]!;
	return matches.length === 0 ? `no card ${ref}` : `${ref} matches ${matches.length} cards (${matches.map((card) => card.id).join(", ")}); use the full id`;
}

function detail(record: DeskRecord, card: DeskCard) {
	return {
		card,
		version: cardVersion(card, record),
		taps: record.taps.filter((row) => row.cardId === card.id),
		report: record.reports[card.id] ?? null,
		reportedAt: record.reportedAt[card.id] ?? null,
	};
}

function cardLine(record: DeskRecord, card: DeskCard, onPage: ReadonlySet<string>): string {
	const taps = record.taps.filter((row) => row.cardId === card.id).map((row) => `${row.tap}${row.delivered ? "" : " (not delivered)"}`);
	return `${card.id}  ${card.shownAt.slice(0, 10)}  ${card.verdict.padEnd(7)}  ${onPage.has(card.id) ? "shown " : "hidden"}  ${card.title}${taps.length > 0 ? `  [${taps.join(", ")}]` : ""}${record.reports[card.id] !== undefined ? "  [report]" : ""}`;
}

function listText(record: DeskRecord, nowMs: number): string {
	const onPage = new Set(cardsForPage(record, nowMs).cards.map((card) => card.id));
	const cards = [...record.cards].sort((left, right) => Date.parse(right.shownAt) - Date.parse(left.shownAt));
	return [
		...(cards.length === 0 ? ["no cards"] : cards.map((card) => cardLine(record, card, onPage))),
		`last run ${record.lastRunAt ?? "never"}; last publish ${record.lastPublishDate ?? "never"}; ${record.taps.length} taps; revision ${record.revision}`,
	].join("\n");
}

function detailText(record: DeskRecord, card: DeskCard): string {
	const taps = record.taps.filter((row) => row.cardId === card.id);
	return [
		cardLine(record, card, new Set(cardsForPage(record, Date.now()).cards.map((shown) => shown.id))),
		`  ${card.kind} from ${card.sourceName ?? card.source}, project ${card.project ?? "none"}, topic ${card.topic}`,
		`  ${card.url}`,
		`  ${card.sentences}`,
		`  scores: hype ${card.scores.hype}, fact ${card.scores.fact}, signal ${card.scores.signal}`,
		`  version: ${cardVersion(card, record)}`,
		...taps.map((row) => `  tap ${row.tap} at ${row.at} via ${row.via}${row.words !== undefined ? ` (the operator's words: ${row.words})` : ""}${row.delivered ? "" : " — not delivered"}`),
		`  report: ${record.reports[card.id] ?? "none"}`,
	].join("\n");
}
