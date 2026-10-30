/**
 * `muster inbox list|read <agent>` — read an agent's inbox without waiting.
 *
 * `muster wait --inbox` moves a message into `read/` the moment it prints it, so a
 * reader that holds messages for a while (the one orchestrator waiter collects
 * for 20 minutes) cannot use it: a crash in between would lose them. This pair
 * splits the two steps. `list` only looks. `read` moves the named messages into
 * `read/` through the inbox owner (lib/agent-inbox.ts), after the caller printed them.
 */

import { inboxReadPath, listInboxMessages, markInboxMessageRead } from "../lib/agent-inbox.ts";
import { authorizeSeatInboxRead, SEAT_REFUSED_EXIT, seatContextFor } from "../seats.ts";
import { lanesStateDir } from "./lanes.ts";
import { parseFlags, type CliCommand } from "./types.ts";

/**
 * The whole text on one line, so a reader splitting on tabs and newlines keeps its rows
 * and columns and loses no byte: backslash, tab, carriage return and newline are written
 * as `\\`, `\t`, `\r` and `\n`. (`list` once kept only the first line, 300 characters at
 * most, and the orchestrator waiter printed that: a 1.5 KB relay arrived as its header.)
 */
function flatText(text: string): string {
	return text.trim().replace(/[\\\t\r\n]/g, (char) => (char === "\\" ? "\\\\" : char === "\t" ? "\\t" : char === "\r" ? "\\r" : "\\n"));
}

export const command: CliCommand = {
	name: "inbox",
	summary: "List an agent's pending inbox messages, or mark some read",
	usage: [
		"muster inbox list <agent> [--json]",
		"muster inbox read <agent> <message-id>...",
		"  list never moves a message. Without --json it prints one tab-separated line per message,",
		"  oldest first: id, sent time (ISO), from, source, path once read, the whole text on one line",
		"  (backslash, tab, CR and newline written as \\\\, \\t, \\r and \\n; an empty field is \"-\", so a reader",
		"  splitting on tabs keeps its columns). --json returns the text as it was sent.",
		"  read moves the named messages into read/ (nothing is deleted); a message already read is skipped.",
		"  muster wait --inbox <agent> is the blocking reader that marks as it prints.",
	].join("\n"),
	async run(ctx) {
		const parsed = parseFlags(ctx.argv, []);
		const [action, agent, ...ids] = parsed.positionals;
		if ((action !== "list" && action !== "read") || agent === undefined || agent.trim() === "") {
			ctx.io.err("muster inbox: an action (list or read) and an agent id are required\n" + command.usage);
			return 2;
		}
		// A seat inbox is read only by the holder (LD23); the operator's own shell is not asked.
		const seat = authorizeSeatInboxRead(agent, ctx.env, seatContextFor(ctx.env));
		if (!seat.allowed) {
			ctx.io.err(`muster inbox: ${seat.message}`);
			return SEAT_REFUSED_EXIT;
		}
		const stateDir = lanesStateDir(ctx.env);
		if (action === "list") {
			const messages = listInboxMessages(stateDir, agent);
			if (ctx.json) {
				ctx.io.out(JSON.stringify(messages.map((message) => ({ ...message, readPath: inboxReadPath(stateDir, agent, message.id) })), null, 2));
				return 0;
			}
			for (const message of messages) {
				ctx.io.out([message.id, message.at, message.from, message.source ?? "-", inboxReadPath(stateDir, agent, message.id) || "-", flatText(message.text) || "-"].join("\t"));
			}
			return 0;
		}
		if (ids.length === 0) {
			ctx.io.err("muster inbox read: at least one message id is required\n" + command.usage);
			return 2;
		}
		let failed = 0;
		for (const id of ids) {
			if (markInboxMessageRead(stateDir, agent, id)) ctx.io.out(`inbox: ${agent} message ${id} marked read`);
			else {
				failed += 1;
				ctx.io.err(`muster inbox: ${agent} has no pending message ${id}`);
			}
		}
		return failed === 0 ? 0 : 1;
	},
};
