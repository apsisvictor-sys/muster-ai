/**
 * `muster lanes` — the CLI face of the A1 lane directory (design section 4.7).
 *
 * Reads the lane cards through their one owner (`lib/lane-directory.ts`, which
 * reads `lib/lane-card.ts`): the caller gets the same rows the Pi tool and the
 * `/muster lanes` command show, with no second store and no second vocabulary.
 * Writes nothing, touches no lane.
 *
 * `--json` prints the machine view: the cards exactly as the directory
 * resolved them (`formatLaneJson`). The table is the human view.
 *
 * The cards live under the muster state directory of the agent directory this
 * CLI runs from — the same `<stateDir>/lanes` the A2 writer uses
 * (`PI_MUSTER_STATE_DIR` overrides it), so a repo checkout and an installed
 * agent dir each read their own.
 */

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { musterStateDir } from "../binding.ts";
import { laneCardsDir as cardDirFor, type LaneCard } from "../lib/lane-card.ts";
import { enumerateLanes, formatLaneJson, formatLaneTable } from "../lib/lane-directory.ts";
import { countInboxMessages, listInboxAgents } from "../lib/agent-inbox.ts";
import { missionKey, missionOpenPlan } from "../mission.ts";
import { MISSION_REFRESH_MS, runMissionWatch } from "../mission-run.ts";
import { parseFlags, type CliCommand, type CliContext } from "./types.ts";

const VALUE_FLAGS = ["lane", "stalled-minutes", "gone-minutes", "session", "refresh-seconds"];

/**
 * The Muster state dir this CLI reads: `PI_MUSTER_STATE_DIR` when set, else the
 * agent dir's own — the same rule `musterStateDir()` applies to the extension,
 * so a repo checkout and an installed agent dir each read their own.
 */
export function lanesStateDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env["PI_MUSTER_STATE_DIR"]?.trim();
	return override !== undefined && override !== "" ? resolve(override) : musterStateDir();
}

/** The directory holding `*.json` lane cards for this installation. */
export function lanesCardsDir(env: NodeJS.ProcessEnv = process.env): string {
	return cardDirFor(lanesStateDir(env));
}

/**
 * The launcher's lane registry for this installation.
 *
 * The registry sits beside the muster state directory (`<stateDir>/muster` +
 * `<stateDir>/pi-lanes.json`), so the CLI derives it from the same override the
 * cards use and a repo checkout reads its own.
 */
export function lanesRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(dirname(lanesStateDir(env)), "pi-lanes.json");
}

/** One lane's row as `muster lanes` shows it (including the operator's own sessions), for a verb that must check the row's origin first. */
export function lanesDirectoryRow(env: NodeJS.ProcessEnv, laneId: string): LaneCard | undefined {
	return enumerateLanes({
		...(env["HOME"] !== undefined ? { home: env["HOME"] } : {}),
		laneCardsDir: lanesCardsDir(env),
		laneRegistryPath: lanesRegistryPath(env),
		includeUnregisteredSessions: true,
	}).find((card) => card.laneId === laneId);
}

export const command: CliCommand = {
	name: "lanes",
	summary: "Print the lane directory (cards, states, walls) as a table or JSON",
	usage: [
		"muster lanes [--json] [--lane <id>] [--stalled] [--gone] [--active] [--all]",
		"             [--stalled-minutes N] [--gone-minutes N]",
		"muster lanes --watch [--session <tmux session>] [--refresh-seconds N]",
		"muster lanes --inbox [--json]",
		"  --watch is the pi:mission table: live, read-only, Enter opens the lane",
		"  (a lane is a card, a registered lane session, or a Claude agent;",
		"   an unregistered old session is not a lane: use --all to see those too)",
		"  --inbox lists the agents with pending inbox messages (an agent whose harness has",
		"   no Concord prompt endpoint, e.g. orchestrator); the table view adds a summary line",
		"  --json is the machine view; `muster lanes --json` is what a watcher reads",
	].join("\n"),
	async run(ctx) {
		const parsed = parseFlags(ctx.argv, VALUE_FLAGS);
		const numberFlag = (key: string): number | undefined => {
			const raw = parsed.values.get(key);
			if (raw === undefined) return undefined;
			const value = Number(raw);
			return Number.isFinite(value) && value >= 0 ? value : Number.NaN;
		};
		const stalledMinutes = numberFlag("stalled-minutes");
		const goneMinutes = numberFlag("gone-minutes");
		for (const [key, value] of [["--stalled-minutes", stalledMinutes], ["--gone-minutes", goneMinutes]] as const) {
			if (value !== undefined && Number.isNaN(value)) {
				ctx.io.err(`muster lanes: ${key} must be a non-negative number\n${command.usage}`);
				return 2;
			}
		}
		if (parsed.flags.has("watch")) return runWatch(ctx, parsed);
		const unknown = [...parsed.values.keys(), ...parsed.flags].filter((key) => !VALUE_FLAGS.includes(key) && !["stalled", "gone", "active", "all", "watch", "inbox"].includes(key));
		if (unknown.length > 0) {
			ctx.io.err(`muster lanes: unknown option --${unknown[0]}\n${command.usage}`);
			return 2;
		}

		const pendingInbox = listInboxAgents(lanesStateDir(ctx.env)).map((agent) => ({ agent, pending: countInboxMessages(lanesStateDir(ctx.env), agent) }));
		if (parsed.flags.has("inbox")) {
			// A pending-inbox count for the agents that have one. Kept out of the lane
			// rows on purpose: the orchestrator is not a lane, and a lane's own work
			// lives on its card.
			ctx.io.out(ctx.json ? JSON.stringify(pendingInbox, null, 2) : (pendingInbox.length === 0 ? "inbox: no pending messages" : pendingInbox.map((row) => `inbox: ${row.agent} ${row.pending} pending`).join("\n")));
			return 0;
		}

		const cards = enumerateLanes({
			...(ctx.env["HOME"] !== undefined ? { home: ctx.env["HOME"] } : {}),
			laneCardsDir: lanesCardsDir(ctx.env),
			laneRegistryPath: lanesRegistryPath(ctx.env),
			// Check 1: sessions no lane claims are not lanes.
			includeUnregisteredSessions: parsed.flags.has("all"),
			...(stalledMinutes !== undefined ? { stalledMinutes } : {}),
			...(goneMinutes !== undefined ? { goneMinutes } : {}),
		});

		let rows = cards;
		const laneId = parsed.values.get("lane");
		if (laneId !== undefined) rows = rows.filter((card) => card.laneId === laneId);
		if (parsed.flags.has("active")) rows = rows.filter((card) => card.state !== "gone");
		if (parsed.flags.has("stalled")) rows = rows.filter((card) => card.state === "stalled");
		if (parsed.flags.has("gone")) rows = rows.filter((card) => card.state === "gone");

		if (rows.length === 0) {
			const want = laneId !== undefined ? `no lane ${laneId}` : "no lane matches that filter";
			if (ctx.json) ctx.io.out(formatLaneJson(rows));
			ctx.io.err(`muster lanes: ${want} (the directory sees ${cards.length} lane${cards.length === 1 ? "" : "s"})`);
			return 3;
		}
		ctx.io.out(ctx.json ? formatLaneJson(rows) : formatLaneTable(rows));
		if (!ctx.json && pendingInbox.length > 0) ctx.io.out(`inbox: ${pendingInbox.map((row) => `${row.agent} ${row.pending} pending`).join(", ")}`);
		return 0;
	},
};

/**
 * `muster lanes --watch` — the live table the `pi:mission` window runs.
 *
 * Read-only. The key handler owns no lane: Enter asks tmux to show the lane's
 * own window, or starts `claude attach` in a new `view-<lane>` window for a
 * Claude background session.
 */
async function runWatch(ctx: CliContext, parsed: ReturnType<typeof parseFlags>): Promise<number> {
	const session = parsed.values.get("session")?.trim() ?? ctx.env["PI_LANES_TMUX_SESSION"]?.trim() ?? "pi";
	const refreshSeconds = Number(parsed.values.get("refresh-seconds") ?? "2");
	const refreshMs = Number.isFinite(refreshSeconds) && refreshSeconds > 0 ? refreshSeconds * 1000 : MISSION_REFRESH_MS;
	const readCards = (): ReturnType<typeof enumerateLanes> => enumerateLanes({
		...(ctx.env["HOME"] !== undefined ? { home: ctx.env["HOME"] } : {}),
		laneCardsDir: lanesCardsDir(ctx.env),
		laneRegistryPath: lanesRegistryPath(ctx.env),
		includeUnregisteredSessions: false,
	});
	const keys = subscribeTerminalKeys();
	try {
		return await runMissionWatch(
			{
				readCards,
				write: (text) => ctx.io.out(text),
				size: () => ({ rows: process.stdout.rows ?? 40, columns: process.stdout.columns ?? 200 }),
				onKey: keys.onKey,
				clientSession: () => {
					const client = spawnSync("tmux", ["display-message", "-p", "#{client_session}"], { encoding: "utf8", timeout: 5000 });
					return client.status === 0 ? client.stdout.trim() || undefined : undefined;
				},
				open: (row) => openLane(row, session),
			},
			{ refreshMs },
		);
	} finally {
		keys.stop();
	}
}

/** tmux `-t` targets: `session:window`, and a fresh `view-<lane>` for Claude. */
function openLane(row: { laneId: string; harness: string }, session: string): { ok: boolean; detail: string } {
	const plan = missionOpenPlan({ laneId: row.laneId, harness: row.harness } as never, { session });
	if (plan.kind === "none") return { ok: false, detail: "nothing to open" };
	if (plan.kind === "claude") {
		const window = `view-${row.laneId.replace(/[^A-Za-z0-9_.-]/g, "-")}`;
		const created = spawnSync("tmux", ["new-window", "-d", "-t", `${session}:`, "-n", window, "--", "claude", ...plan.args], { encoding: "utf8", timeout: 10_000 });
		if (created.status !== 0) return { ok: false, detail: `tmux new-window failed: ${(created.stderr || created.stdout || "").trim().slice(-160)}` };
		const selected = spawnSync("tmux", ["select-window", "-t", `${session}:${window}`], { encoding: "utf8", timeout: 5_000 });
		if (selected.status !== 0) return { ok: false, detail: `tmux select-window failed: ${(selected.stderr || selected.stdout || "").trim().slice(-160)}` };
		return { ok: true, detail: `${session}:${window}` };
	}
	const result = spawnSync("tmux", plan.args, { encoding: "utf8", timeout: 5_000 });
	if (result.status === 0) return { ok: true, detail: plan.args.join(" ") };
	return { ok: false, detail: `tmux ${plan.args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim().slice(-160)}` };
}

/**
 * Raw-mode keypresses for the watch loop.
 *
 * Without a TTY (a pipe, a test) the subscription is a no-op, so the window
 * still renders instead of failing; `q`, arrows and Enter are the whole key
 * map (`missionKey`), and Ctrl-C quits like `q`.
 */
function subscribeTerminalKeys(): { onKey: (handler: (key: ReturnType<typeof missionKey>) => void) => () => void; stop: () => void } {
	const stdin = process.stdin;
	const handlers = new Set<(key: ReturnType<typeof missionKey>) => void>();
	let listening = false;
	const onData = (chunk: Buffer | string): void => {
		const key = missionKey(String(chunk));
		if (key === "none") return;
		for (const handler of handlers) handler(key);
	};
	const start = (): void => {
		if (listening || stdin.isTTY !== true) return;
		listening = true;
		stdin.setRawMode?.(true);
		stdin.resume();
		stdin.setEncoding("utf8");
		stdin.on("data", onData);
	};
	const stop = (): void => {
		if (!listening) return;
		listening = false;
		stdin.off("data", onData);
		stdin.setRawMode?.(false);
		stdin.pause();
	};
	return {
		onKey: (handler) => {
			handlers.add(handler);
			start();
			return () => { handlers.delete(handler); if (handlers.size === 0) stop(); };
		},
		stop,
	};
}
