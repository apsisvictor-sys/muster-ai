/**
 * `muster send <lane> [text]` — deliver one message to a lane.
 *
 * Concord first (the lane's inbox drains it and the card's endpoint stays
 * authoritative); when Concord cannot deliver, the lane's pane is prompted
 * and the fallback is printed and logged (design section 4.3, rollout step 1).
 */

import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { assertAttachmentSet, storeAttachment, type AttachmentRef } from "../lib/inbox-attachments.ts";
import { GATEWAY_AGENT_ID } from "../gateway/state.ts";
import { ConcordClient } from "../concord.ts";
import { musterStateDir, piAgentDir } from "../binding.ts";
import { laneSendDeps } from "../send-deps.ts";
import { deliverLaneMessage, formatSendOutcome, SEND_MODES, type SendMode, type SendRequest } from "../send.ts";
import { parseFlags, requireAgentId, type CliCommand } from "./types.ts";

export const command: CliCommand = {
	name: "send",
	summary: "Deliver a message to a lane (Concord first, pane fallback)",
	usage: [
		"muster send <lane> <text...> [--mode steer|followup|wake] [--attach <file> ...] [--task <id>] [--key <idempotency-key>] [--no-verify] [--json]",
		"  --attach stores each file first (at most 10 files, 50 MiB each, 200 MiB in all) and the message last. A lane reads a file from the path in the message. Every message to `grokbot` is a wake whatever --mode says: it also opens an assigned issue in the Henry mailbox repo so his routine can start. Messages from muster-tick and muster-janitor are batched to one issue per hour; the messages wait in his inbox.",
		"  after Concord accepts, waits for the lane to take the message (its card shows nothing held). A lane that is busy and holds it is reported as queued: Concord delivers it when the lane is free, and nothing is typed into its pane. The pane carries the message only when the lane has stopped writing its card. --no-verify returns at once.",
		"muster send <lane> --stdin [--mode ...] [--task <id>] [--json]      # text on stdin",
		"muster --agent <id> send <lane> ...                               # the agent identity is a global flag, before the subcommand",
	].join("\n"),
	async run(ctx) {
		const parsed = parseFlags(ctx.argv, ["mode", "task", "key", "attach"]);
		const laneId = parsed.positionals[0];
		if (laneId === undefined) {
			ctx.io.err("muster send: a lane id is required\n" + command.usage);
			return 2;
		}
		const attachPaths = (parsed.multi.get("attach") ?? []).map((path) => resolve(ctx.cwd, path));
		const modeWord = parsed.values.get("mode") ?? (laneId === GATEWAY_AGENT_ID ? "wake" : "followup");
		if (!(SEND_MODES as readonly string[]).includes(modeWord)) {
			ctx.io.err(`muster send: mode must be one of ${SEND_MODES.join(", ")}`);
			return 2;
		}
		const mode = modeWord as SendMode;
		let text = parsed.positionals.slice(1).join(" ");
		if (parsed.flags.has("stdin") || text === "-") {
			text = (await ctx.readStdin()).replace(/\n+$/, "");
		}
		if (text.trim() === "") {
			ctx.io.err("muster send: the message text is empty\n" + command.usage);
			return 2;
		}
		const identity = requireAgentId(ctx);
		if (typeof identity !== "string") {
			ctx.io.err(`muster send: ${identity.error}`);
			return 2;
		}

		const stateDir = musterStateDir();
		const attachments: AttachmentRef[] = [];
		if (attachPaths.length > 0) {
			// Files are stored first and the message last, so a reader never sees a message whose files are missing.
			try {
				const sizes = attachPaths.map((path) => {
					if (!statSync(path).isFile()) throw new Error(`${path} is not a regular file`);
					accessSync(path, fsConstants.R_OK);
					return statSync(path).size;
				});
				assertAttachmentSet(sizes);
				for (const path of attachPaths) attachments.push(await storeAttachment(stateDir, { sourcePath: path, name: basename(path), from: identity, to: laneId }));
			} catch (error) {
				ctx.io.err(`muster send: --attach failed (${error instanceof Error ? error.message : String(error)}); nothing was sent`);
				return 2;
			}
		}

		const request: SendRequest = {
			laneId,
			mode,
			text,
			...(attachments.length > 0 ? { attachments } : {}),
			...(parsed.values.get("task") !== undefined ? { taskId: parsed.values.get("task")! } : {}),
			...(parsed.values.get("key") !== undefined ? { idempotencyKey: parsed.values.get("key")! } : {}),
		};
		let concord: ConcordClient | undefined;
		try {
			concord = await ConcordClient.connect({
				launcherMcp: join(piAgentDir(), "extensions", "muster", "launchers", "concord-mcp"),
				repoRoot: ctx.repoRoot,
				agentId: identity,
				cwd: ctx.cwd,
			});
		} catch (error) {
			ctx.io.err(`muster send: Concord is not reachable (${error instanceof Error ? error.message : String(error)}); falling back to the lane's pane`);
		}
		let deps: ReturnType<typeof laneSendDeps> | undefined;
		try {
			deps = laneSendDeps(stateDir, identity, {
				concord: concord === undefined ? undefined : { callTool: (name, args, options) => concord!.callTool(name, args, options) },
				// A lane launched into another workspace publishes its endpoint there (its lifecycle record's repoRoot).
				senderRoot: ctx.repoRoot,
				concordAt: async (repoRoot) => {
					const client = await ConcordClient.connect({ launcherMcp: join(piAgentDir(), "extensions", "muster", "launchers", "concord-mcp"), repoRoot, agentId: identity, cwd: ctx.cwd });
					return { callTool: (name, args, options) => client.callTool(name, args, options), close: () => client.close() };
				},
				confirmArrival: !parsed.flags.has("no-verify"),
				// LD35: the identity above passed the seat guard, so the inbox entries this
				// relay path writes carry the mark that admits launcher authority.
				relayAdmitted: true,
				onLogError: (error) => { ctx.io.err(`muster send: the send log could not be written (${error instanceof Error ? error.message : String(error)})`); },
			});
			const outcome = await deliverLaneMessage(request, deps);
			const text = formatSendOutcome(outcome, request);
			if (ctx.json) ctx.io.out(JSON.stringify({ ...outcome, laneId, mode }, null, 2));
			else if (outcome.transport === "concord" || outcome.transport === "inbox" || outcome.transport === "resume") ctx.io.out(text);
			else ctx.io.err(text);
			if (outcome.transport === "concord") return 0;
			if (outcome.transport === "pane") return 0;
			if (outcome.transport === "inbox") return 0;
			if (outcome.transport === "resume") return 0;
			return 1;
		} finally {
			await deps?.dispose?.();
			await concord?.close().catch(() => undefined);
		}
	},
};
