/**
 * `muster mailbox check-auth|check-unread` — Henry's mailbox health (VR24-12 C9, C10).
 *
 * The two checks live in `mailbox-health.ts`; this verb is the timer's entry. A failing check raises one event line
 * through the one event writer and exits 1, so the user unit shows as failed as well. Exit 0 means healthy, 2 a
 * wrong usage. The verb is auto-registered by the frame's directory scan.
 */

import { musterStateDir } from "../binding.ts";
import { checkMailboxAuth, checkUnreadForHenry } from "../mailbox-health.ts";
import { execCaptured } from "../send-deps.ts";
import { parseFlags, type CliCommand } from "./types.ts";

const USAGE = [
	"muster mailbox check-auth    the gh login that opens Henry's mailbox issues can read the mailbox repo",
	"muster mailbox check-unread  any message to Henry unread for more than 30 minutes",
	"  a failing check raises one event line (BLOCKED / STALLED: henry-mailbox | ...) and exits 1; healthy exits 0",
	"  GROKBOT_MAILBOX_REPO names another mailbox repo, as for `muster send`",
].join("\n");

export const command: CliCommand = {
	name: "mailbox",
	summary: "Check the Henry wake path: the GitHub login and unread messages",
	usage: USAGE,
	async run(ctx) {
		const [which, ...extra] = parseFlags(ctx.argv, []).positionals;
		if ((which !== "check-auth" && which !== "check-unread") || extra.length > 0) {
			ctx.io.err(`muster mailbox: check-auth or check-unread is required\n${USAGE}`);
			return 2;
		}
		const stateDir = musterStateDir();
		if (which === "check-auth") {
			const repo = ctx.env["GROKBOT_MAILBOX_REPO"]?.trim();
			const result = await checkMailboxAuth({ stateDir, exec: execCaptured, ...(repo !== undefined && repo !== "" ? { repo } : {}) });
			if (result.ok) {
				ctx.io.out("mailbox auth: ok");
				return 0;
			}
			ctx.io.err(`mailbox auth: failed (${result.detail}); ${result.raised ? "raised to the orchestrator" : "already raised"}`);
			return 1;
		}
		const result = checkUnreadForHenry({ stateDir });
		if (result.stale.length === 0) {
			ctx.io.out("mailbox unread: none older than 30 minutes");
			return 0;
		}
		ctx.io.err(`mailbox unread: ${result.stale.length} message(s) older than 30 minutes; ${result.raised ? "raised to the orchestrator" : "already raised"}`);
		return 1;
	},
};
