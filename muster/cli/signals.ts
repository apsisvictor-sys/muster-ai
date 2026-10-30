/**
 * `muster signals` — read the UM8 signal log.
 *
 * Reads `<stateDir>/signals/events.jsonl` (the store `extensions/muster/signals.ts`
 * owns, written by the gateway's `signals_add` and by `scripts/usage-snapshot.ts`)
 * and prints one line per signal, or the whole read as JSON.
 *
 * A signal written by the gateway (`by: "grokbot"`) is external input: it prints
 * with `untrusted` and its text behind the gateway's `EXTERNAL_PREFIX`, the same
 * marking `signals_read` applies. The store's own review notes report a torn or
 * unreadable line.
 *
 * The verb is auto-registered: `scripts/muster.mts` discovers every module
 * under `extensions/muster/cli/` that exports `command`, so this file is the
 * only change that lands `muster signals`.
 */

import { EXTERNAL_PREFIX } from "../gateway/tools.ts";
import { musterStateDir } from "../binding.ts";
import { SIGNAL_KINDS, SIGNAL_READ_LIMIT_MAX, readSignals, type SignalKind, type UntrustedSignal } from "../signals.ts";
import { parseFlags, type CliCommand } from "./types.ts";

const VALUE_FLAGS = ["since", "kind", "provider", "limit"];

const USAGE = [
	"muster signals [--since <ISO time>] [--kind <kind>] [--provider <name>] [--limit <n>] [--json]",
	`  reads <stateDir>/signals/events.jsonl; kinds: ${SIGNAL_KINDS.join(", ")}`,
	`  --limit is the newest N (default 50, at most ${SIGNAL_READ_LIMIT_MAX}); --json is the machine view`,
	"  a signal written by the gateway is marked untrusted, its text behind the external-agent prefix",
].join("\n");

export const command: CliCommand = {
	name: "signals",
	summary: "Read the signal log: usage, launch, price, terms, meter, probe and idea signals",
	usage: USAGE,
	async run(ctx) {
		const parsed = parseFlags(ctx.argv, VALUE_FLAGS);
		const kind = parsed.values.get("kind")?.trim();
		if (kind !== undefined && !(SIGNAL_KINDS as readonly string[]).includes(kind)) {
			ctx.io.err(`muster signals: kind must be one of: ${SIGNAL_KINDS.join(", ")}\n${USAGE}`);
			return 2;
		}
		const since = parsed.values.get("since")?.trim();
		const provider = parsed.values.get("provider")?.trim();
		const limitText = parsed.values.get("limit")?.trim();
		const limit = limitText === undefined || limitText === "" ? undefined : Number(limitText);
		if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
			ctx.io.err(`muster signals: --limit must be a positive integer\n${USAGE}`);
			return 2;
		}
		const read = readSignals(musterStateDir(), {
			...(since !== undefined && since !== "" ? { since } : {}),
			...(kind !== undefined ? { kind: kind as SignalKind } : {}),
			...(provider !== undefined && provider !== "" ? { provider } : {}),
			...(limit !== undefined ? { limit } : {}),
			untrustedPrefix: EXTERNAL_PREFIX,
		});
		if (ctx.json) {
			ctx.io.out(JSON.stringify(read, null, 2));
			return 0;
		}
		if (read.signals.length === 0) {
			ctx.io.out(`no signals in ${read.path}`);
			return 0;
		}
		ctx.io.out(`${read.signals.length} signal${read.signals.length === 1 ? "" : "s"} from ${read.path}`);
		for (const signal of read.signals) ctx.io.out(formatSignalLine(signal));
		if (read.partialLastLine > 0) ctx.io.out(`review — ${read.path} ends mid-write; the next append repairs it`);
		if (read.unreadableLines > 0) ctx.io.out(`review — ${read.unreadableLines} unreadable line(s) in ${read.path}`);
		return 0;
	},
};

/** One line: when, what, where, who wrote it, how sure, and the text. An idea has an author and a link, not a provider. */
function formatSignalLine(signal: UntrustedSignal): string {
	const model = signal.modelId === undefined ? "" : ` ${signal.modelId}`;
	const untrusted = signal.untrusted === true ? " UNTRUSTED" : "";
	const text = signal.text === undefined ? "" : ` ${signal.text}`;
	const subject = signal.kind === "idea" ? `${signal.author === undefined ? "" : `${signal.author} `}${signal.url ?? ""}` : `${signal.provider ?? "-"}${model}`;
	return `  ${signal.at}  ${signal.kind.padEnd(6)} ${subject}  by=${signal.by} ${signal.confidence}${untrusted}${text}`;
}
