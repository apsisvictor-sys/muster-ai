/**
 * `muster ask` — raise one ask in the operator's queue (AK1).
 *
 * The writer is the process, not a flag: the operator's own shell writes as
 * `operator-shell`, a session holding the architect or orchestrator seat writes as
 * that role, and anything else is refused (lanes ask the orchestrator). The ask
 * is durable from this moment, so the writer cites its id or code in whatever it
 * sends the operator.
 */

import { ASK_KINDS, ASK_RULES, raiseAsk, regenerateOperatorList, resolveAskWriter, type AskKind, type AskRule } from "../asks.ts";
import { musterStateDir } from "../binding.ts";
import { parseFlags, type CliCommand } from "./types.ts";

const VALUE_FLAGS = ["kind", "question", "code", "owner", "source", "link", "blocks", "rule"];

/** `--blocks a,b` and `--blocks a --blocks b` both name the same lanes and tasks. */
function blockList(parsed: { multi: Map<string, string[]> }): string[] {
	return (parsed.multi.get("blocks") ?? [])
		.flatMap((value) => value.split(","))
		.map((value) => value.trim())
		.filter((value) => value !== "");
}

export const command: CliCommand = {
	name: "ask",
	summary: "Raise an ask in the operator's queue (the operator's shell, the architect or the orchestrator)",
	usage: [
		"muster ask --kind <kind> --question \"<q>\" [--code VD7] [--owner <who>] [--source <where>] [--link <artifact>] [--blocks a,b] [--rule <rule>] [--json]",
		`  --kind is one of: ${ASK_KINDS.join(", ")}`,
		"  --link card:<programmeId>/<decisionId> links a programme decision card: the card keeps the one answer, and `muster asks answer` refuses the ask",
		"  --blocks names the lanes or tasks waiting on the answer: the more of them, the higher the operator's view puts the ask",
		`  --rule says what the ask is about, one of: ${ASK_RULES.join(", ")}`,
		"  a lane is refused: lanes ask the orchestrator",
	].join("\n"),
	async run(ctx) {
		const parsed = parseFlags(ctx.argv, VALUE_FLAGS);
		const kindWord = parsed.values.get("kind")?.trim();
		if (kindWord === undefined || !(ASK_KINDS as readonly string[]).includes(kindWord)) {
			ctx.io.err(`muster ask: --kind must be one of: ${ASK_KINDS.join(", ")}\n${command.usage}`);
			return 2;
		}
		const question = (parsed.values.get("question") ?? parsed.positionals.join(" ")).trim();
		if (question === "") {
			ctx.io.err(`muster ask: a question is required\n${command.usage}`);
			return 2;
		}
		const writer = resolveAskWriter(ctx.env, ctx.agentId);
		if ("error" in writer) {
			ctx.io.err(`muster ask: ${writer.error}`);
			return 2;
		}
		const ruleWord = parsed.values.get("rule")?.trim();
		if (ruleWord !== undefined && ruleWord !== "" && !(ASK_RULES as readonly string[]).includes(ruleWord)) {
			ctx.io.err(`muster ask: rule must be one of: ${ASK_RULES.join(", ")}\n${command.usage}`);
			return 2;
		}
		const value = (key: string): string | undefined => parsed.values.get(key)?.trim() || undefined;
		try {
			const ask = raiseAsk(musterStateDir(), {
				by: writer.writer,
				kind: kindWord as AskKind,
				question,
				blocks: blockList(parsed),
				...(value("code") !== undefined ? { code: value("code")! } : {}),
				...(value("owner") !== undefined ? { owner: value("owner")! } : {}),
				...(value("source") !== undefined ? { source: value("source")! } : {}),
				...(value("link") !== undefined ? { link: value("link")! } : {}),
				...(value("rule") !== undefined ? { rule: value("rule")! as AskRule } : {}),
			});
			if (ctx.json) ctx.io.out(JSON.stringify(ask, null, 2));
			else {
				ctx.io.out(`muster ask: ${ask.id}${ask.code !== undefined ? ` (${ask.code})` : ""} [${ask.kind}, ${ask.status}]`);
				ctx.io.out(`  cite it to the operator as ${ask.code ?? ask.id}; read the queue with \`muster asks\``);
			}
			const list = regenerateOperatorList(musterStateDir(), { env: ctx.env });
			if ("error" in list) ctx.io.err(`muster ask: the list the operator reads was not regenerated: ${list.error}`);
			return 0;
		} catch (error) {
			ctx.io.err(`muster ask: ${error instanceof Error ? error.message : String(error)}`);
			return 2;
		}
	},
};
