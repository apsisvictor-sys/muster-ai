/**
 * `muster seat assign|claim|rebind|release|show|dossier` — the seat owner's command line (LD20 to LD24).
 *
 * `claim` and `rebind` need proof the seat may move: a ticket the Claude adapter wrote after it saw
 * the operator's typed phrase, or — for `claim` only — the nonce of a pending assignment (LD36) written
 * through the owner's `assignSeat`. With none, a stale one or one for another session they refuse
 * and change nothing. There is no verb that writes a ticket. The credential comes back only with
 * `--json` (the adapter reads it from there) and is presented later through `MUSTER_SEAT_TOKEN`,
 * never on argv.
 *
 * `assign` (LD36) writes a pending assignment for a target session the lane directory resolves
 * (`resolveSeatTarget`), from the operator's shell only — it is refused inside an agent session. Every
 * move sends one line to Grokbot through the existing send path; a failed wake never undoes the
 * assignment.
 */

import { assignSeat, claimSeat, describeSeat, editSeatDossier, readSeat, rebindSeat, releaseSeat, resolveSeatRole, runsInAgentSession, SEAT_ENV_TOKEN, SEAT_ROLES, SeatStateError, type SeatHarness, type SeatHolderInput, type SeatProof } from "../seats.ts";
import { resolveSeatTarget } from "../lib/lane-directory.ts";
import { GATEWAY_AGENT_ID } from "../gateway/state.ts";
import { lanesRegistryPath, lanesStateDir } from "./lanes.ts";
import { command as sendCommand } from "./send.ts";
import { parseFlags, type CliCommand, type ParsedFlags } from "./types.ts";

const VALUE_FLAGS = ["session", "harness", "process-key", "lane", "transcript", "ticket", "assignment", "to"];
const USAGE = [
	"muster seat claim <role> --session <id> --harness claude|pi --process-key <key> --ticket <nonce>|--assignment <nonce> [--lane <lane>] [--transcript <path>] [--json]",
	"muster seat rebind <role> --session <id> --harness claude|pi --process-key <key> --ticket <nonce> [--lane <lane>] [--transcript <path>] [--json]",
	"muster seat assign <role> --to <session-id-or-prefix> [--harness claude|pi]   (the operator's shell; refused inside an agent session)",
	"muster seat release <role>             (the holder's MUSTER_SEAT_TOKEN)",
	"muster seat show [<role>] [--json]",
	"muster seat dossier <role> [add|remove <path>]   (add and remove need the holder's MUSTER_SEAT_TOKEN)",
	`roles: ${SEAT_ROLES.join(", ")} (designer is the architect)`,
].join("\n");

function holderInput(flags: ParsedFlags): SeatHolderInput | string {
	const harness = flags.values.get("harness")?.trim();
	if (harness !== "claude" && harness !== "pi") return "--harness must be claude or pi";
	const sessionId = flags.values.get("session")?.trim();
	if (sessionId === undefined || sessionId === "") return "--session is required";
	const processKey = flags.values.get("process-key")?.trim();
	if (processKey === undefined || processKey === "") return "--process-key is required";
	const laneId = flags.values.get("lane")?.trim();
	const transcript = flags.values.get("transcript")?.trim();
	return {
		harness: harness as SeatHarness,
		sessionId,
		processKey,
		...(laneId ? { laneId } : {}),
		...(transcript ? { transcript } : {}),
	};
}

export const command: CliCommand = {
	name: "seat",
	summary: "Seats: claim, rebind, release, show or edit the dossier of the orchestrator and architect seats",
	usage: USAGE,
	async run(ctx) {
		const flags = parseFlags(ctx.argv, VALUE_FLAGS);
		const [verb, roleName, ...rest] = flags.positionals;
		const seatCtx = { stateDir: lanesStateDir(ctx.env) };
		const usage = (message: string): number => {
			ctx.io.err(`muster seat: ${message}\n${USAGE}`);
			return 2;
		};
		const token = ctx.env[SEAT_ENV_TOKEN];
		try {
			if (verb === "show") {
				const one = roleName === undefined ? undefined : resolveSeatRole(roleName);
				if (roleName !== undefined && one === undefined) return usage(`${JSON.stringify(roleName)} is not a seat`);
				const described = (one === undefined ? [...SEAT_ROLES] : [one]).map((role) => describeSeat(readSeat(role, seatCtx), seatCtx));
				if (ctx.json) ctx.io.out(JSON.stringify(one === undefined ? described : described[0], null, 2));
				else {
					for (const seat of described) {
						const holder = seat.holder;
						ctx.io.out(holder === null
							? `${seat.role}\t#${seat.epoch}\t${seat.epoch === 0 ? "never claimed" : "empty"}`
							: [seat.role, `#${seat.epoch}`, holder.harness, holder.sessionId.slice(0, 8), holder.laneId ?? "-", `since ${holder.since}`, `typed ${holder.lastTypedAt ?? "-"}`, holder.processAlive ? "live" : "dead"].join("\t"));
					}
				}
				return 0;
			}
			if (roleName === undefined || resolveSeatRole(roleName) === undefined) {
				return usage(verb === undefined ? "a verb is required" : `${JSON.stringify(roleName)} is not a seat`);
			}
			if (verb === "assign") {
				if (runsInAgentSession(ctx.env)) {
					ctx.io.err("muster seat: assign is refused inside an agent session; the operator runs it from his shell (LD36)");
					return 3;
				}
				const to = flags.values.get("to")?.trim();
				if (to === undefined || to === "") return usage("--to <session-id-or-prefix> is required");
				const harness = flags.values.get("harness")?.trim();
				if (harness !== undefined && harness !== "claude" && harness !== "pi") return usage("--harness must be claude or pi");
				const resolved = resolveSeatTarget(to, {
					...(ctx.env["HOME"] !== undefined ? { home: ctx.env["HOME"] } : {}),
					laneRegistryPath: lanesRegistryPath(ctx.env),
					...(harness !== undefined ? { harness: harness as SeatHarness } : {}),
				});
				if (!resolved.ok) {
					ctx.io.err(`muster seat: ${resolved.reason}`);
					return 3;
				}
				const target = resolved.target;
				const result = assignSeat(roleName, { harness: target.harness, sessionId: target.sessionId, inbox: target.inbox }, "shell", seatCtx);
				const short = target.sessionId.slice(0, 8);
				ctx.io.out(`${result.role} seat assigned to ${target.harness} session ${short}; it takes it on its next turn or inbox wake (assignment valid 10 minutes)${target.alive === undefined ? "; its liveness is unknown, so the assignment may go unclaimed" : ""}`);
				// One line to Grokbot on every move (LD36/O1), through the existing send path. A failed
				// wake is logged and never undoes the assignment.
				try {
					const errs: string[] = [];
					const code = await sendCommand.run({
						...ctx,
						argv: [GATEWAY_AGENT_ID, "--mode", "wake", `${result.role} seat assigned to ${target.harness} ${short} from the operator's shell`],
						agentId: "muster-seats",
						json: false,
						io: { out: () => undefined, err: (message) => errs.push(message) },
					});
					if (code !== 0) ctx.io.err(`muster seat: the Grokbot notice could not be sent${errs.length > 0 ? `: ${errs[errs.length - 1]}` : ` (exit ${code})`}`);
				} catch (error) {
					ctx.io.err(`muster seat: the Grokbot notice could not be sent (${error instanceof Error ? error.message : String(error)})`);
				}
				return 0;
			}
			if (verb === "claim" || verb === "rebind") {
				const input = holderInput(flags);
				if (typeof input === "string") return usage(input);
				const nonce = flags.values.get("ticket")?.trim();
				const assignment = flags.values.get("assignment")?.trim();
				if (nonce !== undefined && assignment !== undefined) return usage("use --ticket or --assignment, not both");
				// With no proof value the proof is still the ticket kind: the owner refuses it. Only an in-process caller skips it.
				const proof: SeatProof = assignment === undefined ? { kind: "ticket", nonce: nonce ?? "" } : { kind: "assignment", nonce: assignment };
				if (verb === "claim") {
					const result = claimSeat(roleName, input, proof, seatCtx);
					const previous = result.previous === null ? null : { harness: result.previous.harness, sessionId: result.previous.sessionId, laneId: result.previous.laneId ?? null };
					ctx.io.out(ctx.json
						? JSON.stringify({ role: result.role, epoch: result.epoch, token: result.token, previous, assignedBy: result.assignedBy, ...(result.writtenAt === undefined ? {} : { writtenAt: result.writtenAt }) })
						: `muster seat: ${result.role} seat held by ${input.harness} session ${input.sessionId.slice(0, 8)} (#${result.epoch})`);
				} else {
					const result = rebindSeat(roleName, input, proof, seatCtx);
					ctx.io.out(ctx.json
						? JSON.stringify({ role: result.role, epoch: result.epoch, token: result.token })
						: `muster seat: ${result.role} seat rebound to ${input.harness} session ${input.sessionId.slice(0, 8)} (#${result.epoch})`);
				}
				return 0;
			}
			if (verb === "release") {
				const result = releaseSeat(roleName, token, seatCtx);
				ctx.io.out(ctx.json ? JSON.stringify(result) : `muster seat: ${result.role} seat released (#${result.epoch}); it stays empty until the operator claims it`);
				return 0;
			}
			if (verb === "dossier") {
				const [op, path] = rest;
				if (op === undefined) {
					const dossier = readSeat(roleName, seatCtx).dossier;
					ctx.io.out(ctx.json ? JSON.stringify(dossier) : dossier.join("\n"));
					return 0;
				}
				if ((op !== "add" && op !== "remove") || path === undefined) return usage("dossier takes add|remove <path>");
				const dossier = editSeatDossier(roleName, token, op, path, seatCtx);
				ctx.io.out(ctx.json ? JSON.stringify(dossier) : dossier.join("\n"));
				return 0;
			}
			return usage(`unknown verb ${JSON.stringify(verb)}`);
		} catch (error) {
			if (error instanceof SeatStateError) {
				ctx.io.err(`muster seat: ${error.message}`);
				return 3;
			}
			throw error;
		}
	},
};
