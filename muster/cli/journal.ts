/**
 * `muster journal` — read Grokbot's journal (UB0 UD8, VR24-196 W1).
 *
 * Reads `<stateDir>/journal/events.jsonl`, the store `extensions/muster/journal.ts`
 * owns and the gateway's `journal_add` writes: each relay with the operator's exact words,
 * each task the bot started, dropped or scheduled, and its errors. One line per entry,
 * or the whole read as JSON for the command center (CCJ) and the architect.
 *
 * Every entry is Grokbot's, so every one prints with `untrusted` and both `text` and
 * `quote` behind the gateway's `EXTERNAL_PREFIX`, the same marking `journal_read`
 * applies. A relay also prints the check against the message it claims to have carried.
 * The store's own review notes report a torn or unreadable line.
 *
 * The verb is auto-registered: `scripts/muster.mts` discovers every module under
 * `extensions/muster/cli/` that exports `command`, so this file is the only change
 * that lands `muster journal`.
 */

import { EXTERNAL_PREFIX } from "../gateway/tools.ts";
import { musterStateDir } from "../binding.ts";
import { JOURNAL_KINDS, JOURNAL_READ_LIMIT_MAX, readJournal, type JournalKind, type UntrustedJournalEntry } from "../journal.ts";
import { parseFlags, type CliCommand } from "./types.ts";

const VALUE_FLAGS = ["since", "kind", "limit"];

const USAGE = [
	"muster journal [--since <ISO time>] [--kind <kind>] [--limit <n>] [--json]",
	`  reads <stateDir>/journal/events.jsonl; kinds: ${JOURNAL_KINDS.join(", ")}`,
	`  --limit is the newest N (default 50, at most ${JOURNAL_READ_LIMIT_MAX}); --json is the machine view`,
	"  every entry is Grokbot's: text and quote read untrusted, and a relay carries its check",
].join("\n");

export const command: CliCommand = {
	name: "journal",
	summary: "Read Grokbot's journal: the relays it carried, its tasks and its errors",
	usage: USAGE,
	async run(ctx) {
		const parsed = parseFlags(ctx.argv, VALUE_FLAGS);
		const kind = parsed.values.get("kind")?.trim();
		if (kind !== undefined && !(JOURNAL_KINDS as readonly string[]).includes(kind)) {
			ctx.io.err(`muster journal: kind must be one of: ${JOURNAL_KINDS.join(", ")}\n${USAGE}`);
			return 2;
		}
		const since = parsed.values.get("since")?.trim();
		const limitText = parsed.values.get("limit")?.trim();
		const limit = limitText === undefined || limitText === "" ? undefined : Number(limitText);
		if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
			ctx.io.err(`muster journal: --limit must be a positive integer\n${USAGE}`);
			return 2;
		}
		const read = readJournal(musterStateDir(), {
			...(since !== undefined && since !== "" ? { since } : {}),
			...(kind !== undefined ? { kind: kind as JournalKind } : {}),
			...(limit !== undefined ? { limit } : {}),
			untrustedPrefix: EXTERNAL_PREFIX,
		});
		if (ctx.json) {
			ctx.io.out(JSON.stringify(read, null, 2));
			return 0;
		}
		if (read.entries.length === 0) {
			ctx.io.out(`no journal entries in ${read.path}`);
			return 0;
		}
		ctx.io.out(`${read.entries.length} journal entr${read.entries.length === 1 ? "y" : "ies"} from ${read.path}`);
		for (const entry of read.entries) ctx.io.out(formatJournalLine(entry));
		if (read.partialLastLine > 0) ctx.io.out(`review — ${read.path} ends mid-write; the next append repairs it`);
		if (read.unreadableLines > 0) ctx.io.out(`review — ${read.unreadableLines} unreadable line(s) in ${read.path}`);
		return 0;
	},
};

/** One line: when, what kind, what became of it, where it went, and the bot's words. */
function formatJournalLine(entry: UntrustedJournalEntry): string {
	const untrusted = entry.untrusted === true ? " UNTRUSTED" : "";
	const state = entry.state === undefined ? "" : ` ${entry.state}`;
	const when = entry.when === undefined ? "" : ` at ${entry.when}`;
	const relay = entry.relay === undefined ? "" : `  relay: ${entry.relay}`;
	const where = entry.to === undefined ? "" : `  to=${entry.to}${entry.ref === undefined ? "" : ` #${entry.ref}`}`;
	const why = entry.why === undefined ? "" : `  why: ${entry.why}`;
	const quote = entry.quote === undefined ? "" : `\n    quote: ${entry.quote}`;
	return `  ${entry.at}  ${entry.kind.padEnd(5)}${state}${when}${untrusted}  ${entry.text}${relay}${where}${why}${quote}`;
}
