/**
 * The dispatcher's effects on the machine (out-loop spec Revision 3 §9 and §10 row OL2; VR24-220).
 *
 * `dispatch.ts` decides and is pure. This module is the other side of its port: every read and every write the
 * pass needs, each on the owner that already answers it, and each kept out of `runTick` so an in-process pass
 * under a test can neither consult this machine's gate nor start a lane.
 *
 * The owners, one each:
 *   - the queue: `work-items.ts` (`listWorkItems`, `setWorkItemState`), never a private table;
 *   - the switch: `state/routing/dispatch-mode`, in the routing state dir beside `jev-mode` (§9). A missing or
 *     unreadable file is `off`, which is the rollback;
 *   - admission: `scripts/heavy-gate.sh`, read through its non-recording `--status` view (VR24-210). The
 *     launcher's own `lane-launch` call stays the one admission that stamps the 60 s spacing;
 *   - the brief verdict: `scripts/brief-check.sh` (S6);
 *   - the slot count: `routing.slots` (VR24-208) minus the lanes the lane directory lists;
 *   - starting the lane: the worktree step at a verified base, then `scripts/pi-lane-launch.sh` — one launch
 *     effect (§11 rule 2). The model is not named here: the router picks;
 *   - liveness: the lane records (`lane-lifecycle.ts`), whose `item` field also resolves a crash.
 */

import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { piAgentDir } from "../core/pi-ports.ts";
import { loadPoolConfig, routingDecisionsTarget, type PoolConfig } from "../routing/provider-pool.ts";
import { SEAT_ROLES, readSeat } from "./seats.ts";
import { laneCardsDir } from "./lib/lane-card.ts";
import { enumerateLanes } from "./lib/lane-directory.ts";
import { lanesRegistryPath } from "./cli/lanes.ts";
import { TERMINAL_PHASES, listLaneRecords, validateLaneTitle, type LaneRecord } from "./lane-lifecycle.ts";
import { programmeKillFileActive } from "./control-bridge.ts";
import { appendOrchestratorEvent } from "./lane-report.ts";
import { raiseAsk } from "./asks.ts";
import { listWorkItems, setWorkItemState, workItemStore, workItemsDir, type WorkItemRecord } from "./work-items.ts";
import { runningWorkerLanes, type SeatHold } from "./tick.ts";
import type { DispatchItem, DispatchMode, DispatchPort, GateReading, LaunchOutcome, LaunchRequest, LiveLane } from "./dispatch.ts";

// ─── The switch (§9) ─────────────────────────────────────────────────────────

/** The file the mode is read from, in the routing state dir beside `jev-mode`. */
export const DISPATCH_MODE_FILE = "dispatch-mode";

/** The shadow log: what the pass would have launched, beside the orchestrator's own launches. */
export const DISPATCH_SHADOW_FILE = "dispatch-shadow.jsonl";

/** The routing state dir the switch sits in, for the installation this process serves. */
export function dispatchStateDir(env: NodeJS.ProcessEnv = process.env): string {
	return routingDecisionsTarget(env).stateDir;
}

/**
 * The mode in force. A file that is missing, unreadable or holds a word this pass does not know means `off`:
 * off is the rollback (§11 rule 1), and the switch only ever moves when the operator or the orchestrator moves it.
 */
export function readDispatchMode(stateDir: string): DispatchMode {
	try {
		const raw = readFileSync(join(stateDir, DISPATCH_MODE_FILE), "utf8").trim().toLowerCase();
		return raw === "on" || raw === "shadow" ? raw : "off";
	} catch {
		return "off";
	}
}

/** One shadow line, appended to the routing state dir's own log. A log that cannot be written never stops a pass. */
export function appendDispatchShadow(stateDir: string, line: Record<string, unknown>): void {
	try {
		mkdirSync(stateDir, { recursive: true });
		appendFileSync(join(stateDir, DISPATCH_SHADOW_FILE), `${JSON.stringify(line)}\n`);
	} catch {
		/* the shadow log is evidence, never a precondition */
	}
}

// ─── The owners' entry points, in this tree ──────────────────────────────────

/**
 * The scripts this pass calls, under the configured agent folder's `scripts/`, where `pi-lane-launch.sh`
 * already stands for the lane lifecycle (`lane-lifecycle-ports.ts`). They are Pi's own profile files, not the
 * checkout's: this repository ships no `brief-check.sh`, and its `heavy-gate.sh` is reached through the
 * profile's entry anyway, so the profile is the one owner of where they are.
 */
function scriptPath(name: string): string {
	return join(piAgentDir(), "scripts", name);
}

// ─── Admission: the gate's non-recording answer (VR24-210) ───────────────────

type GateStatus = { wouldAdmit: boolean; reason: string; availableMb?: number; devServerWindow?: string; paused: boolean };

function gateStatus(env: NodeJS.ProcessEnv): GateStatus {
	try {
		const said = execFileSync(scriptPath("heavy-gate.sh"), ["--status"], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"], env }).trim();
		const parsed = JSON.parse(said.split("\n").pop() ?? "{}") as { wouldAdmit?: unknown; reason?: unknown; availableMb?: unknown; devServerWindow?: unknown; paused?: unknown };
		return {
			wouldAdmit: parsed.wouldAdmit === true,
			reason: typeof parsed.reason === "string" ? parsed.reason : "",
			...(typeof parsed.availableMb === "number" ? { availableMb: parsed.availableMb } : {}),
			...(typeof parsed.devServerWindow === "string" && parsed.devServerWindow !== "" ? { devServerWindow: parsed.devServerWindow } : {}),
			paused: parsed.paused === true,
		};
	} catch {
		// A status view that cannot be read says nothing about admitting a lane; the launcher's own call decides.
		return { wouldAdmit: true, reason: "", paused: false };
	}
}

/** The job size the gate last recorded for a refused lane launch: its log line names it even when the reason does not. */
function lastGateRefusalSize(env: NodeJS.ProcessEnv): number | undefined {
	const log = env.HEAVY_GATE_LOG?.trim() || join(env.HOME?.trim() || homedir(), ".pi", "agent", "state", "heavy-gate.log");
	let text: string;
	try {
		text = readFileSync(log, "utf8");
	} catch {
		return undefined;
	}
	const lines = text.split("\n").filter((line) => line.includes("refused kind=lane-launch size="));
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const size = /refused kind=lane-launch size=(\d+)MiB/.exec(lines[index]!)?.[1];
		if (size !== undefined) return Number(size);
	}
	return undefined;
}

/**
 * What the gate says right now, with the gate's own words and the facts it read (§12 F2). It is the
 * non-recording `--status` read: `--status` answers the 0 MiB probe and writes no lane-launch stamp, so a look
 * never spends VR24-210's 60 s spacing and the launcher stays the one call that counts.
 */
export function heavyGateReading(env: NodeJS.ProcessEnv = process.env): GateReading {
	const status = gateStatus(env);
	if (status.wouldAdmit) return { admitted: true, reason: "" };
	const size = lastGateRefusalSize(env);
	const paused = status.paused || /^paused by /i.test(status.reason);
	return {
		admitted: false,
		reason: status.reason,
		...(size === undefined ? {} : { jobSizeMiB: size }),
		...(status.availableMb === undefined ? {} : { availableMiB: status.availableMb }),
		...(status.devServerWindow === undefined ? {} : { devServerWindow: status.devServerWindow }),
		...(paused && /^paused by /i.test(status.reason) ? { pausedBy: status.reason.replace(/ at .*$/, "") } : {}),
	};
}

// ─── The brief's verdict (S6) ────────────────────────────────────────────────

/** One brief, read once, with `scripts/brief-check.sh`'s verdict: a brief that fails its header is never launched. */
export function briefVerdict(path: string, env: NodeJS.ProcessEnv = process.env): { ok: boolean; reason?: string; text?: string } {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { ok: false, reason: `the brief ${path} does not exist` };
	}
	try {
		execFileSync(scriptPath("brief-check.sh"), [path], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"], env });
	} catch (error) {
		const said = (error as { stderr?: string }).stderr ?? "";
		const line = said.split("\n").map((part) => part.trim()).filter((part) => part !== "")[0] ?? (error as { stdout?: string }).stdout?.trim() ?? "brief-check refused it";
		return { ok: false, reason: `the brief fails check: ${line}` };
	}
	return { ok: true, text };
}

// ─── The worktree step, at a verified base (§10 OL2, §12 round 2 F5) ─────────

/** Run git and keep its exit state: the worktree step is the only caller, and it decides on each answer. */
function gitRun(args: string[], timeoutMs = 60_000): Promise<{ ok: boolean; stdout: string; detail: string }> {
	return new Promise((resolve) => {
		execFile("git", args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error !== null) resolve({ ok: false, stdout, detail: (stderr || error.message).trim().slice(-300) });
			else resolve({ ok: true, stdout, detail: "" });
		});
	});
}

/** A verified base: the full commit a brief's `Cut from:` token names in its repository, or the reason there is none. */
export async function resolveBaseCommit(repo: string, base: string): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
	if (!/^[0-9a-f]{7,64}$/i.test(base)) return { ok: false, error: `a verified 40-hex base SHA is required; shared-checkout execution is refused (the brief names "${base}")` };
	const resolved = await gitRun(["-C", repo, "rev-parse", "--verify", "--end-of-options", `${base}^{commit}`], 15_000);
	if (!resolved.ok) return { ok: false, error: `the base ${base} is not a commit in ${repo}; shared-checkout execution is refused` };
	const sha = resolved.stdout.trim();
	if (!/^[0-9a-f]{40,64}$/.test(sha)) return { ok: false, error: `the base ${base} did not resolve to a full commit; shared-checkout execution is refused` };
	// The checkout must name the same commit after the read: a base that moved is not a verified base.
	const again = await gitRun(["-C", repo, "rev-parse", "--verify", "--end-of-options", `${sha}^{commit}`], 15_000);
	if (!again.ok || again.stdout.trim() !== sha) return { ok: false, error: `the base ${base} moved while it was being verified; nothing was created` };
	return { ok: true, sha };
}

/**
 * The worktree step: a worktree at a verified base, then proven isolated, clean and on its own branch. It is
 * kept from the Herdr pane launch when only the pane start was replaced, because `scripts/pi-lane-launch.sh`
 * creates no worktree and a shared checkout is refused.
 */
export async function createLaneWorktree(input: { repo: string; base: string; laneRoot: string; branch: string }): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
	const base = await resolveBaseCommit(input.repo, input.base);
	if (!base.ok) return base;
	mkdirSync(dirname(input.laneRoot), { recursive: true });
	const git = (cwd: string, args: string[]) => gitRun(["-C", cwd, ...args]);
	// Whether this attempt made the checkout decides whether it may undo it: existing work is never touched.
	const created = !existsSync(input.laneRoot);
	if (created) {
		const added = await git(input.repo, ["worktree", "add", input.laneRoot, "-b", input.branch, base.sha]);
		if (!added.ok) return { ok: false, error: `git worktree add failed: ${added.detail}` };
	}
	// A pre-existing directory is not proof of an isolated writer checkout.
	const sourceCommon = await git(input.repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const laneCommon = await git(input.laneRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const laneGit = await git(input.laneRoot, ["rev-parse", "--absolute-git-dir"]);
	const head = await git(input.laneRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
	const branch = await git(input.laneRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	const clean = await git(input.laneRoot, ["status", "--porcelain", "--untracked-files=all"]);
	if (![sourceCommon, laneCommon, laneGit, head, branch, clean].every((result) => result.ok)
		|| sourceCommon.stdout.trim() !== laneCommon.stdout.trim() || laneGit.stdout.trim() === sourceCommon.stdout.trim()
		|| head.stdout.trim() !== base.sha || branch.stdout.trim() !== input.branch || clean.stdout !== "") {
		const why = `the lane checkout ${input.laneRoot} is not an isolated clean worktree at ${base.sha}`;
		if (!created) return { ok: false, error: `${why}; existing work was preserved` };
		// This attempt made the checkout and it failed its own check: undo it while it is still ours to undo (F3).
		const undone = await removeLaneWorktree({ repo: input.repo, laneRoot: input.laneRoot, branch: input.branch, base: base.sha });
		return { ok: false, error: `${why}; ${undone.reason}` };
	}
	return { ok: true, sha: base.sha };
}

/**
 * Undo a failed attempt's own worktree, and only while it holds no work: a checkout with a worker's change in
 * it is preserved and said so. The reservation is the lane root itself, so nothing else is touched. The lane's
 * branch goes with it, and only while it still points at the attempt's base: a retry of the same attempt needs
 * the name back, and a branch that carries a commit is somebody's work.
 */
export async function removeLaneWorktree(input: { repo: string; laneRoot: string; branch?: string; base?: string }): Promise<{ removed: boolean; reason: string }> {
	if (!existsSync(input.laneRoot)) return { removed: false, reason: "there was no worktree to remove" };
	const clean = await gitRun(["-C", input.laneRoot, "status", "--porcelain", "--untracked-files=all"], 15_000);
	if (!clean.ok) return { removed: false, reason: "the worktree could not be read, so it was kept" };
	if (clean.stdout !== "") return { removed: false, reason: "the attempt's worktree was kept (it holds work)" };
	const removed = await gitRun(["-C", input.repo, "worktree", "remove", input.laneRoot]);
	if (!removed.ok) return { removed: false, reason: `the attempt's worktree was kept (git worktree remove failed: ${removed.detail})` };
	const branch = input.branch;
	const base = input.base;
	const untrimmed = branch !== undefined && base !== undefined ? await branchAtBase(input.repo, branch, base) : false;
	if (branch !== undefined && base !== undefined && untrimmed) await gitRun(["-C", input.repo, "branch", "-D", branch], 15_000);
	return { removed: true, reason: `the attempt's clean worktree was removed${untrimmed ? ` and its branch ${branch} released` : ""}` };
}

/** True when the branch exists and still points at the commit the attempt started from: nothing landed on it. */
async function branchAtBase(repo: string, branch: string, base: string): Promise<boolean> {
	const pointed = await gitRun(["-C", repo, "rev-parse", "--verify", "--end-of-options", `${branch}^{commit}`], 15_000);
	if (!pointed.ok) return false;
	const at = await gitRun(["-C", repo, "rev-parse", "--verify", "--end-of-options", `${base}^{commit}`], 15_000);
	return at.ok && pointed.stdout.trim() === at.stdout.trim();
}

// ─── The one launch effect (§9, §11 rule 2) ─────────────────────────────────

/**
 * The launcher's argv, in one place so a test can assert it: one lane, its brief, its attempt's worktree, the
 * title the lane delivers, the goal it works on or an explicit `--no-goal`, the harness it runs on, and the
 * item it serves. No `--model`: the router picks. No `--attach`: nothing waits on a terminal that is not there.
 */
export function laneLauncherArgv(request: LaunchRequest): string[] {
	return [
		"--lane", request.lane,
		"--title", request.title,
		...(request.goal === undefined ? ["--no-goal"] : ["--goal", request.goal]),
		"--brief", request.briefPath,
		"--cwd", request.laneRoot,
		"--harness", request.harness,
		"--item", request.code,
		"--launched-by", "dispatcher",
		"--no-attach",
	];
}

/** The launcher call itself: one lane, one brief, one directory, no attach, and its exit code kept. */
function runLaneLauncher(request: LaunchRequest, env: NodeJS.ProcessEnv): Promise<LaunchOutcome> {
	return new Promise((resolve) => {
		execFile(scriptPath("pi-lane-launch.sh"), laneLauncherArgv(request), { timeout: 300_000, maxBuffer: 8 * 1024 * 1024, env }, (error, stdout, stderr) => {
			if (error === null) {
				resolve({ launched: true });
				return;
			}
			const line = `${stderr}\n${stdout}`.split("\n").map((part) => part.trim()).filter((part) => part !== "").pop();
			const code = typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : undefined;
			resolve({ launched: false, error: line ?? (error instanceof Error ? error.message : "the launcher failed"), ...(code === undefined ? {} : { exitCode: code }) });
		});
	});
}

/**
 * The worktree at a verified base, then `scripts/pi-lane-launch.sh`. A failed launch undoes its own clean
 * worktree and keeps one that holds work, so a retry after a refusal starts from a clean checkout. The
 * launcher runner is a parameter so a test can assert the argv without starting a process.
 */
export async function dispatchAssignedLane(
	request: LaunchRequest,
	env: NodeJS.ProcessEnv = process.env,
	run: (request: LaunchRequest, env: NodeJS.ProcessEnv) => Promise<LaunchOutcome> = runLaneLauncher,
): Promise<LaunchOutcome> {
	// The title rule has one owner, and a refused title starts nothing (§12 F1).
	const title = validateLaneTitle(request.title);
	if ("error" in title) return { launched: false, error: `the lane title is refused: ${title.error}` };
	const worktree = await createLaneWorktree({ repo: request.repo, base: request.base, laneRoot: request.laneRoot, branch: request.branch });
	if (!worktree.ok) return { launched: false, error: worktree.error };
	const launched = await run({ ...request, title: title.title }, env);
	if (launched.launched) return launched;
	const cleaned = await removeLaneWorktree({ repo: request.repo, laneRoot: request.laneRoot, branch: request.branch, base: request.base });
	return { launched: false, error: `${launched.error ?? "the launcher failed"}; ${cleaned.reason}`, ...(launched.exitCode === undefined ? {} : { exitCode: launched.exitCode }) };
}

// ─── Liveness and slots ─────────────────────────────────────────────────────

/** The lane records that are still live: a parked lane still holds its item, a merged one does not. */
export function liveLaneRecords(stateDir: string): LiveLane[] {
	try {
		return listLaneRecords(stateDir).flatMap((record: LaneRecord) =>
			TERMINAL_PHASES.includes(record.phase)
				? []
				: [{ lane: record.laneId, phase: record.phase, ...(record.item === undefined ? {} : { item: record.item }) }],
		);
	} catch {
		// An unreadable lane store says nothing about what is live; the pass still refuses to launch twice by item state.
		return [];
	}
}

/** Free worker slots: `routing.slots` (the pool's own cap, VR24-208) minus the lanes that hold one. */
export function freeWorkerSlots(stateDir: string, env: NodeJS.ProcessEnv = process.env, pool?: PoolConfig): number {
	const loaded = pool === undefined ? loadPoolConfig() : { ok: true as const, config: pool };
	if (!loaded.ok) return 0;
	const slots = loaded.config.routing?.slots ?? 0;
	if (slots <= 0) return 0;
	const seats: SeatHold[] = SEAT_ROLES.flatMap((role) => {
		const holder = readSeat(role, { stateDir }).holder;
		return holder === null ? [] : [{ role, ...(holder.laneId !== undefined ? { laneId: holder.laneId } : {}), sessionId: holder.sessionId }];
	});
	const rows = enumerateLanes({
		laneCardsDir: laneCardsDir(stateDir),
		laneRegistryPath: lanesRegistryPath({ ...env, PI_MUSTER_STATE_DIR: stateDir }),
		includeUnregisteredSessions: false,
	});
	return Math.max(0, slots - runningWorkerLanes(rows, seats).length);
}

// ─── The port ───────────────────────────────────────────────────────────────

/** The tick's own mark store (`tick-alerts.json`), supplied by the script that already owns that file. */
export type DispatchMarkStore = { get(key: string): string | undefined; set(key: string, value: string): void };

/**
 * The dispatcher's port, on this machine: the queue from the work-item store, the switch from the routing
 * state dir, the gate from its own script, the lane count from `routing.slots`, and the one launch effect.
 */
export function dispatchTickPorts(input: { stateDir: string; mark: DispatchMarkStore; env?: NodeJS.ProcessEnv }): DispatchPort {
	const env = input.env ?? process.env;
	const stateDir = input.stateDir;
	const store = () => workItemStore(workItemsDir(stateDir));
	return {
		now: () => Date.now(),
		stateDir: () => stateDir,
		// §9: the switch is a file in the routing state dir, so it moves without a restart and off is the rollback.
		mode: () => readDispatchMode(dispatchStateDir(env)),
		items: () => {
			const listing = listWorkItems(store());
			return { items: listing.items.map(asDispatchItem), skipped: listing.skipped };
		},
		liveLanes: () => liveLaneRecords(stateDir),
		freeSlots: () => freeWorkerSlots(stateDir, env),
		// §9: the programme kill file is the third stop lever, read through its own owner.
		killed: () => (programmeKillFileActive({}) ? "the programme kill file exists" : undefined),
		gate: async () => heavyGateReading(env),
		brief: (path) => briefVerdict(path, env),
		launch: (request) => dispatchAssignedLane(request, env),
		setState: (code, state) => {
			try {
				setWorkItemState(store(), code, state, { by: "tick" });
				return { ok: true };
			} catch (error) {
				return { ok: false, reason: error instanceof Error ? error.message : String(error) };
			}
		},
		mark: input.mark,
		shadow: (line) => appendDispatchShadow(dispatchStateDir(env), line),
		event: (line) => void appendOrchestratorEvent(stateDir, line),
		ask: ({ code, question }) => {
			try {
				// `asks.ts` is the one owner of a question for the operator. The tick is a system writer, which may raise
				// only contract asks, so the question goes in the orchestrator's name with the dispatcher as its
				// source — the same shape the contract asks use.
				const ask = raiseAsk(stateDir, { by: "orchestrator", kind: "product-decision", question, source: `muster-tick dispatch ${code}` });
				return { ok: true, reason: ask.id };
			} catch (error) {
				return { ok: false, reason: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}

/** The fields the dispatcher decides on, taken from the one record owner. */
function asDispatchItem(record: WorkItemRecord): DispatchItem {
	return {
		code: record.code,
		heading: record.heading,
		goal: record.goal,
		project: record.project,
		kind: record.kind,
		class: record.class,
		harness: record.harness,
		brief: record.brief,
		ownedPaths: [...record.ownedPaths],
		dependencies: [...record.dependencies],
		attempt: record.attempt,
		state: record.state,
	};
}
