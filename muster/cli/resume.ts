/**
 * `muster resume <lane> [--message <text>]` — wake a Claude lane whose process is gone.
 *
 * The one deliberate restart (LD16). No send path, tool or MCP stops or resumes a Claude session to
 * deliver a message; the orchestrator or the operator runs this on purpose, for a worker lane the daemon
 * retired after an idle hour or one that was parked. It is never a gateway tool.
 *
 * It refuses a session `sessionUntouchable` names (LD17: orchestrator, the operator's own, interactive,
 * conversation) and a session whose process is alive, both with the way to reach it instead, and a
 * lane whose record is merged or closed (LD26: start a new lane). The wake
 * itself is `resumeClaudeLane` (lib/claude-lane-card.ts): `claude --bg --resume <full session id>` with
 * no flags, which keeps the short id, the session id and the Remote Control entry. A lane record that
 * is `parked` goes back to `working`; the woken session's own SessionStart heartbeat appends its id to
 * the record's chain.
 */

import { claudeRemoteControlLink, formatClaudeInboxDelivery, resumeClaudeLane, type ClaudeResumeResult } from "../lib/claude-lane-card.ts";
import { laneVerbCell } from "../lib/lane-control.ts";
import { readLaneCard, type LaneOrigin } from "../lib/lane-card.ts";
import { recordLaunch, readLaneRecord, sessionUntouchable, TERMINAL_PHASES } from "../lane-lifecycle.ts";
import { realCloseLanePorts } from "../lane-lifecycle-ports.ts";
import { lanesStateDir } from "./lanes.ts";
import { parseFlags, type CliCommand, type CliContext } from "./types.ts";

/** What a test replaces: the `claude` CLI, `claude agents --json`, the job records and the registry rows. Each defaults to the real one. */
export interface ResumeDeps {
	claude?: NonNullable<Parameters<typeof resumeClaudeLane>[3]>;
	sessionRows?: (laneId: string) => { registryRow?: { origin?: LaneOrigin }; agentsRow?: { kind?: string } };
}

export const command: CliCommand = {
	name: "resume",
	summary: "Wake a Claude worker lane whose process is gone (retired by the daemon, or parked); never a send path",
	usage: [
		"muster resume <lane> [--message <text>] [--from <agent>] [--json]",
		"  runs `claude --bg --resume <full session id>` with no flags: the same short id, session id and Remote Control entry.",
		"  Refuses an orchestrator, the operator-owned, interactive or conversation session, a merged or closed lane, a session whose process is alive,",
		"  and a lane another `muster resume` is waking. --message becomes the woken session's first prompt.",
	].join("\n"),
	run: (ctx) => resumeCommand(ctx),
};

export async function resumeCommand(ctx: CliContext, deps: ResumeDeps = {}): Promise<number> {
	const parsed = parseFlags(ctx.argv, ["message", "from"]);
	const laneId = parsed.positionals[0]?.trim();
	if (laneId === undefined || laneId === "") {
		ctx.io.err(`muster resume: a lane is required\n${command.usage}`);
		return 2;
	}
	const caller = parsed.values.get("from")?.trim() || ctx.agentId || "muster resume";
	const message = parsed.values.get("message")?.trim();
	const stateDir = lanesStateDir(ctx.env);
	const refuse = (reason: string): number => {
		if (ctx.json) ctx.io.out(JSON.stringify({ laneId, ok: false, reason }, null, 2));
		else ctx.io.err(`muster resume: ${laneId} was not resumed: ${reason}`);
		return 3;
	};

	const untouchable = sessionUntouchable({ stateDir, laneId, ...(deps.sessionRows ?? realCloseLanePorts(stateDir, ctx.env).sessionRows)?.(laneId) });
	if (untouchable !== undefined) {
		const short = readLaneCard(stateDir, laneId)?.sessionId?.slice(0, 8);
		return refuse(`${untouchable.detail}. the operator opens it in the Claude app or runs \`claude attach ${short ?? "<short id>"}\`; it keeps its id`);
	}
	const record = readLaneRecord(stateDir, laneId);
	// LD26: a merged or closed lane's work is on the base and its worktree may be gone. A follow-up is a new lane.
	if (record !== undefined && TERMINAL_PHASES.includes(record.phase)) return refuse(`${laneId} is merged (or closed); start a new lane`);
	const card = readLaneCard(stateDir, laneId);
	const harness = card?.harness ?? record?.harness;
	if (harness === "pi" || harness === "opencode") {
		const cell = laneVerbCell(harness, "resume");
		if (cell.support === "cannot") return refuse(`${cell.why}. Use ${cell.substitute}`);
	}

	const sessionId = card?.sessionId ?? record?.sessionId;
	const prompt = message === undefined || message === "" ? undefined : formatClaudeInboxDelivery({ from: caller, text: message }, laneId, "delivered on resume");
	const result: ClaudeResumeResult = resumeClaudeLane(stateDir, laneId, prompt, { ...deps.claude, ...(sessionId !== undefined ? { sessionId } : {}) });

	if (result.state === "live") return refuse(`its process is alive, so a resume would start a copy. The message is in its inbox${result.waiter ? " (its waiter is armed)" : " (read at its next tool boundary, or by its waiter once armed)"}`);
	if (result.state === "in-progress") return refuse(`resume in progress (pid ${result.by} holds the lease)`);
	if (result.state === "unresumable" || result.state === "failed") return refuse(result.reason);

	if (record?.phase === "parked") recordLaunch(stateDir, { laneId, harness: "claude", cwd: record.cwd, branch: record.branch, sessionId: result.sessionId });
	const link = result.bridgeSessionId !== undefined ? claudeRemoteControlLink(result.bridgeSessionId) : undefined;
	const newShort = result.handle ?? result.oldHandle;
	if (ctx.json) {
		ctx.io.out(JSON.stringify({ laneId, ok: result.keptId, oldShortId: result.oldHandle, newShortId: newShort, sessionId: result.sessionId, remoteControl: link ?? null, rowSeen: result.rowSeen, detail: result.detail }, null, 2));
		return result.keptId ? 0 : 3;
	}
	ctx.io.out(`muster resume: ${result.detail}`);
	ctx.io.out(`  short id: ${result.oldHandle} -> ${newShort}`);
	ctx.io.out(`  session id: ${result.sessionId}`);
	ctx.io.out(`  Remote Control: ${link ?? "none (the job record holds no bridgeSessionId)"}`);
	if (!result.rowSeen) ctx.io.out("  note: the new row did not show in `claude agents --json` within 30 s; check `muster lanes`");
	if (message === undefined || message === "") ctx.io.out("  note: no --message given, so the session is idle until it gets one or the operator opens it");
	if (!result.keptId) ctx.io.err(`muster resume: WARNING the CLI started a copy (${newShort}) and ${result.oldHandle} was not woken; stop the copy with \`claude stop ${newShort}\``);
	return result.keptId ? 0 : 3;
}
