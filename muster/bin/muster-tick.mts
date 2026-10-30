/**
 * Muster tick (R1 item 4): run by the `muster-tick.timer` systemd user unit.
 *
 * Thin by design. The decisions live in `extensions/muster/tick.ts`; this file
 * only supplies its ports: a read-only look at each project's Concord database,
 * a small alert-dedupe file, Henry's mailbox for every alert, and the Herdr
 * dispatch port for authorized worker lanes. Run directly it makes one pass and exits.
 *
 * It does not restart or signal existing processes, with one exception (lifecycle
 * blueprint LD1, decided 2026-10-11): with `--lifecycle` the tick also stops lanes
 * itself, through `closeLane` and never a raw kill. It stops a lane whose reported
 * commit is in origin/dev or origin/main, and one that handed off and has been idle
 * for 30 minutes with a clean worktree. `--dry-run` runs only that pass and prints
 * what it would do. The pass is off unless `--lifecycle` or `--dry-run` is given.
 */

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { concordDbPath, musterSessionsDir, musterStateDir, normalizePrimaryRoot, piAgentDir } from "../binding.ts";
import { backendState } from "../ledger/backend.ts";
import { boundaryReason, replaySpool } from "../ledger/boundary.ts";
import {
	autoAppliableDecisions,
	applyDecisionDefault,
	armDecisionWindow,
	decisionCardText,
	getDecision,
	listOpenDecisions,
} from "../decisions.ts";
import { computeMetrics, formatMetricsLine, readMetricEvents, readOwnershipEvents } from "../metrics.ts";
import { readProgrammeSnapshot, type ProgrammeControlContext } from "../control.ts";
import { inspectConcordCustody } from "../concord-custody.ts";
import { dispatchTickPorts } from "../dispatch-launch.ts";
import type { FrontierTask } from "../frontier.ts";
import { catalogueRepoRoots, projectCataloguePath, readProjectCatalogue } from "../projects.ts";
import type { RotationLaunchPlan } from "../rotation.ts";
import { applyQuotaFallback, henryWakeHealth, quotaFallback, runTick, runTickPass, type QuotaFallbackPorts, type TickPassPorts, type TickPorts } from "../tick.ts";
import { laneCardsDir, readLaneCard, writeLaneCard, type LaneCard } from "../lib/lane-card.ts";
import { enumerateLanes, laneSystemEvidence, readClaudeAgentsJson } from "../lib/lane-directory.ts";
import { askCodeOf, orderAsksForOperator, raiseStandingRuleDraft, readAsks, standingRuleDrafts, waitingOnOperator, OPERATOR_ONLY_KINDS, type Ask, type AskQueue, type StandingRuleDraft } from "../asks.ts";
import { tellGrokbot, tellOrchestrator } from "../grokbot-tell.ts";
// CUTOVER: the empty-slot wake reads the work-item records - the queue - instead of the retired hand table.
import { listWorkItems, workItemsDir, workItemStore, WORK_ITEM_READY_STATE } from "../work-items.ts";
import { flushHenryWake } from "../send-deps.ts";
import { laneHealth, laneStage } from "../lane-stage.ts";
import { WAKER_UNIT } from "../orch-waker.ts";
import { lanesRegistryPath } from "../cli/lanes.ts";
import { closeLaneLive } from "../lane-lifecycle-ports.ts";
import { liveGitFacts } from "../lib/git-facts.ts";
// The heartbeat file's name is shared with its one reader, the doctor (spec §4).
import { TICK_HEARTBEAT_FILE } from "../health/contracts.ts";
// OL3b: the contract repairs and system asks, and the doctor's published rows they read (spec §4).
import { DOCTOR_RESULT_FILE, readDoctorResult, REPAIR_TIMEOUT_MS } from "../health/contract-asks.ts";
// SL2: the usage snapshot through its one owner, beside the seat it is compared with.
import { readUsageSnapshot, usageSnapshotPath } from "./usage-snapshot.mts";
import {
	duplicateDetail,
	duplicateOperatorText,
	findDuplicateLanes,
	markDuplicateReported,
	readReportedDuplicates,
	type DuplicateSet,
} from "../lane-duplicates.ts";
import { laneKeyFindings, laneKeyPass, markLaneKeyReported, readReportedLaneKeys, type LaneKeyFinding } from "../lane-key-health.ts";
import { backlogPath } from "../backlog.ts";
import { describeSeat, markSeatOrphanNotified, observeSeatOrphans, readSeat, seatHolderLanes, SEAT_ROLES, type SeatOrphanNotice, type SeatRole } from "../seats.ts";
import {
	decideLifecycle,
	untouchableSession,
	LANE_NOT_RUNNING_PHASES,
	listLaneRecords,
	markReminded,
	readProtectedLanes,
	type GitFacts,
	type LaneRecord,
	type LaneReminder,
	type LifecycleAction,
} from "../lane-lifecycle.ts";
import { activeWalls, loadPoolConfig } from "../../routing/provider-pool.ts";
import { appendOrchestratorEvent, formatEventLine } from "../lane-report.ts";
import { checkoutHead, gatewayChangedFiles, gatewayFreshnessPass, type GatewayFreshnessPorts } from "../gateway-code.ts";
import { scheduleLaneResume } from "../resume-timer.ts";
import { musterLauncher } from "../../core/pi-ports.ts";
import { graphRefreshPass, graphStatus, startGraphRefresh, type GraphRefreshPorts } from "../../core/graph-refresh.ts";

/**
 * Tasks of one Concord database, plus the addressee of the latest unresolved
 * handoff for each task whose status is `handoff_offered`. The database is
 * opened read-only: the tick can observe Concord and cannot change it.
 */
export function readTasksFromConcordDb(file: string): FrontierTask[] {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		const rows = db
			.prepare("SELECT task_id, status, agent_id, assigned_agent_id, notes, risk_tags, expected_files FROM tasks ORDER BY task_id")
			.all() as Array<{ task_id: string; status: string; agent_id: string | null; assigned_agent_id: string | null; notes: string | null; risk_tags: string; expected_files: string }>;
		const addressee = db.prepare(
			"SELECT to_agent_id FROM handoffs WHERE task_id = ? AND resolved_at IS NULL AND to_agent_id IS NOT NULL ORDER BY id DESC LIMIT 1",
		);
		return rows.map((row) => {
			// Concord stores scopes and tags as JSON string arrays. Malformed input
			// must stop the read, not silently turn a declared scope into no scope.
			const strings = (value: string, field: string): string[] => {
				const parsed: unknown = JSON.parse(value);
				if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) throw new Error(`Invalid Concord ${field} for ${row.task_id}`);
				return parsed;
			};
			const task: FrontierTask = { taskId: row.task_id, status: row.status,
				expectedFiles: strings(row.expected_files, "expected_files"), riskTags: strings(row.risk_tags, "risk_tags"),
				...(row.notes !== null ? { notes: row.notes } : {}) };
			if (row.agent_id) task.ownerAgentId = row.agent_id;
			if (row.assigned_agent_id) task.assignedAgentId = row.assigned_agent_id;
			if (row.status === "handoff_offered") {
				const handoff = addressee.get(row.task_id) as { to_agent_id: string } | undefined;
				if (handoff?.to_agent_id) task.pendingHandoffTo = handoff.to_agent_id;
			}
			return task;
		});
	} finally {
		db.close();
	}
}

/**
 * The tick's heartbeat (spec §4): the file the doctor reads as the `muster tick` contract's proof, whose
 * name has one owner in `health/contracts.ts`. `tick-alerts.json` stays what it is — a rate-limit store —
 * and is no longer anyone's proof of life.
 */
function tickHeartbeatPath(stateDir: string = musterStateDir()): string {
	return join(stateDir, TICK_HEARTBEAT_FILE);
}

/**
 * Write this pass into the heartbeat file, one pass number further than the last. Best-effort by design: a
 * heartbeat that cannot be written is a line on stderr at most, never the end of a pass.
 */
export function writeTickHeartbeat(stateDir: string = musterStateDir(), now: Date = new Date()): void {
	const file = tickHeartbeatPath(stateDir);
	let pass = 1;
	try {
		const previous = JSON.parse(readFileSync(file, "utf8")) as { pass?: unknown };
		if (typeof previous.pass === "number" && Number.isFinite(previous.pass)) pass = previous.pass + 1;
	} catch { /* a missing or torn heartbeat starts the count again */ }
	try {
		mkdirSync(dirname(file), { recursive: true });
		const temp = `${file}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify({ at: now.toISOString(), pass })}\n`, { mode: 0o600 });
		renameSync(temp, file);
	} catch (error) {
		process.stderr.write(`muster-tick: heartbeat not written: ${error instanceof Error ? error.message : String(error)}\n`);
	}
}

function alertStatePath(stateDir: string = musterStateDir()): string {
	return join(stateDir, "tick-alerts.json");
}

function readAlertState(file: string): Record<string, string> {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
	} catch {
		return {};
	}
}

function writeAlertState(file: string, state: Record<string, string>): void {
	mkdirSync(dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(state, null, "\t")}\n`, { mode: 0o600 });
	renameSync(temp, file);
}

function runHerdr(bin: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; detail: string; interrupted: boolean }> {
	return new Promise((resolve) => {
		execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error !== null) {
				const runError = error as NodeJS.ErrnoException & { killed?: boolean };
				resolve({ ok: false, stdout, detail: (stderr || error.message).trim().slice(-300), interrupted: runError.killed === true || runError.signal != null });
			} else resolve({ ok: true, stdout, detail: "", interrupted: false });
		});
	});
}

/** Every pane id Herdr lists, or undefined when the list cannot be read. */
async function listPaneIds(bin: string): Promise<string[] | undefined> {
	const listed = await runHerdr(bin, ["pane", "list"], 10_000);
	if (!listed.ok) return undefined;
	try {
		const panes = (JSON.parse(listed.stdout) as { result?: { panes?: unknown } }).result?.panes;
		return Array.isArray(panes) ? panes.flatMap((pane) => (typeof (pane as { pane_id?: unknown })?.pane_id === "string" ? [(pane as { pane_id: string }).pane_id] : [])) : undefined;
	} catch {
		return undefined;
	}
}

/** Can Herdr be reached at all? Checked before a rotation asks the leader to stop. */
export async function launchReadyWithHerdr(): Promise<{ ready: boolean; reason?: string }> {
	const bin = process.env.HERDR_BIN_PATH?.trim() || "herdr";
	const listed = await runHerdr(bin, ["pane", "list"], 10_000);
	return listed.ok ? { ready: true } : { ready: false, reason: `herdr did not answer (${bin}): ${listed.detail}` };
}

/** Whether a valid agent-list answer shows the named worker or exact pane. */
function herdrAgentOwnsPane(stdout: string, agentName: string, paneId: string): boolean | undefined {
	try {
		const agents = (JSON.parse(stdout) as { result?: { agents?: unknown } }).result?.agents;
		if (!Array.isArray(agents)) return undefined;
		return agents.some((agent) => agent !== null && typeof agent === "object" &&
			((agent as { name?: unknown }).name === agentName || (agent as { pane_id?: unknown }).pane_id === paneId));
	} catch { return undefined; }
}

/** The first `pane_id` string anywhere in Herdr's JSON answer, or undefined. */
function paneIdIn(stdout: string): string | undefined {
	const find = (value: unknown): string | undefined => {
		if (value === null || typeof value !== "object") return undefined;
		const record = value as Record<string, unknown>;
		if (typeof record["pane_id"] === "string" && record["pane_id"] !== "") return record["pane_id"];
		for (const child of Object.values(record)) {
			const found = find(child);
			if (found !== undefined) return found;
		}
		return undefined;
	};
	try {
		return find(JSON.parse(stdout));
	} catch {
		return undefined;
	}
}

/**
 * Launch the fresh parent of a rotation through Herdr (R1.5, AM4): a pane next
 * to the leader's and a pi agent in it carrying the rotation ticket. The resume
 * brief is not typed: typed input is the operator's, so the session reads the
 * brief from the rotation record and submits it itself. It only creates. A failure leaves whatever was made
 * in place and names it, so the one thing this port never does is remove or stop
 * anything. The environment never carries CONCORD_AGENT_ID: the fresh parent
 * joins as itself and takes the mailbox through the ordinary handover.
 */
export async function launchRotationWithHerdr(plan: RotationLaunchPlan, options: { extensionPath?: string } = {}): Promise<{ launched: boolean; error?: string }> {
	const bin = process.env.HERDR_BIN_PATH?.trim() || "herdr";
	const extensionPath = options.extensionPath ?? join(piAgentDir(), "extensions", "muster");
	const envFlags = Object.entries(plan.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
	const before = await listPaneIds(bin);
	if (before === undefined) return { launched: false, error: "herdr pane list failed, so the new pane could not be told apart and nothing was created" };
	// Next to the leader's own pane when it has one; otherwise an isolated workspace of its own,
	// the pattern the Muster skill uses for a parent with no pane.
	const created = plan.paneId !== undefined
		? await runHerdr(bin, ["pane", "split", plan.paneId, "--direction", "right", "--cwd", plan.cwd, ...envFlags, "--no-focus"], 30_000)
		: await runHerdr(bin, ["workspace", "create", "--cwd", plan.cwd, "--label", plan.name, ...envFlags, "--no-focus"], 30_000);
	const step = plan.paneId !== undefined ? "pane split" : "workspace create";
	if (!created.ok) return { launched: false, error: `herdr ${step} failed: ${created.detail}` };
	// The new pane is the one that was not there before: the list's shape is known, the answer's is not.
	const after = await listPaneIds(bin);
	const fresh = (after ?? []).filter((id) => !before.includes(id));
	const answered = paneIdIn(created.stdout);
	const paneId = fresh.length === 1 ? fresh[0] : answered !== undefined && fresh.includes(answered) ? answered : undefined;
	if (paneId === undefined) return { launched: false, error: `herdr ${step} created no identifiable pane (${fresh.length} new), so no agent was started` };
	const start = await runHerdr(bin, [
		"agent", "start", plan.name, "--kind", "pi", "--pane", paneId, "--timeout", "60000", "--",
		"-e", extensionPath,
		...(plan.model !== undefined ? ["--model", plan.model] : []),
		...(plan.thinking !== undefined ? ["--thinking", plan.thinking] : []),
	], 90_000);
	if (!start.ok) return { launched: false, error: `herdr agent start failed in pane ${paneId} (the pane was left open): ${start.detail}` };
	// No prompt is typed: the fresh session submits its own brief from the rotation record.
	return { launched: true };
}

/**
 * Completions from Concord's own event log: how many distinct tasks finished,
 * and the id of the last completion event as a durable cursor. A roster that
 * merely shrinks is not a completion, so the digest's milestone follows the
 * event the lifecycle recorded, never a count that moved. Read-only.
 */
export function readCompletionsFromConcordDb(file: string): { done: number; cursor: number } {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		const row = db
			.prepare("SELECT COUNT(DISTINCT task_id) AS done, COALESCE(MAX(id), 0) AS cursor FROM events WHERE status IN ('complete','closed') AND task_id IS NOT NULL")
			.get() as { done: number; cursor: number } | undefined;
		return { done: Number(row?.done ?? 0), cursor: Number(row?.cursor ?? 0) };
	} finally {
		db.close();
	}
}

/** The catalogue project name for a programme, when one exists; used in card text. */
function projectNameFor(programmeId: string): string | undefined {
	try {
		return readProjectCatalogue().projects.find((project) => project.programmes.some((programme) => programme.programmeId === programmeId))?.name;
	} catch {
		return undefined;
	}
}

/** The metrics window the status line uses; the digest must not use another one. */
const METRICS_WINDOW_MS = 4 * 60 * 60_000;
const METRICS_LOOKBACK_MS = 48 * 60 * 60_000;

export function livePorts(stateDir: string = musterStateDir()): TickPorts {
	const stateFile = alertStatePath(stateDir);
	return {
		now: () => Date.now(),
		// No catalogue file yet means no project has been orchestrated: nothing to tick.
		// A file that exists and cannot be read throws, and the tick reports it.
		catalogue: () => (existsSync(projectCataloguePath()) ? readProjectCatalogue() : undefined),
		control: {},
		readTasks: (programme) => {
			const file = concordDbPath(normalizePrimaryRoot(programme.repoKey));
			if (!existsSync(file)) return undefined;
			try {
				return readTasksFromConcordDb(file);
			} catch {
				return undefined;
			}
		},
		completions: (programme) => {
			const file = concordDbPath(normalizePrimaryRoot(programme.repoKey));
			if (!existsSync(file)) return undefined;
			try {
				return readCompletionsFromConcordDb(file);
			} catch {
				return undefined;
			}
		},
		alerts: {
			get: (programmeId) => readAlertState(stateFile)[programmeId],
			set: (programmeId, heartbeatAt) => writeAlertState(stateFile, { ...readAlertState(stateFile), [programmeId]: heartbeatAt }),
		},
		// OL3's conductor wake reads the machine through this port: the lane rows, the seats and the send
		// path. The empty-slot wake that once used it is gone (WAKE1); the conductor is its reader now.
		emptySlot: {
			lanes: () =>
				enumerateLanes({
					laneCardsDir: laneCardsDir(stateDir),
					laneRegistryPath: lanesRegistryPath({ ...process.env, PI_MUSTER_STATE_DIR: stateDir }),
					includeUnregisteredSessions: false,
				}),
			// Both roles, because either holder's session is a seat rather than a slot. `readSeat` is the whole read.
			seats: () =>
				SEAT_ROLES.flatMap((role) => {
					const holder = readSeat(role, { stateDir }).holder;
					if (holder === null) return [];
					return [{ role, ...(holder.laneId !== undefined ? { laneId: holder.laneId } : {}), sessionId: holder.sessionId }];
				}),
			// CUTOVER (2026-10-29): the ready rows are the work-item records' now. The hand table is retired and no
			// script reads it; this asks the store the record owner owns, and a store that cannot be read is a reason
			// one log line rather than a crashed pass.
			readyItems: () => {
				try {
					const listing = listWorkItems(workItemStore(workItemsDir(stateDir)));
					return { ok: true, ready: listing.items.filter((item) => item.state === WORK_ITEM_READY_STATE).map((item) => item.code) };
				} catch (error) {
					return { ok: false, reason: `the work-item store could not be read (${error instanceof Error ? error.message : String(error)})` };
				}
			},
			wake: (text, key) => tellOrchestrator(stateDir, "muster-tick", text, key),
		},

		// WAKE1 (Henry via the operator 2026-10-29 03:29): the waker's unit, its restart, the seat's turn clock and
		// the waiting handoffs stay here rather than in `runTick`, so an in-process tick pass under a test can
		// neither ask systemd nor read the machine's lanes. The policy - both restart conditions, the hourly
		// throttle and the text - is the library's (`tick.ts`).
		wakerGuard: {
			// systemd is the one answer for a unit's state; `is-active` prints it and exits non-zero for the
			// states we act on, so the word on stdout is what is read, never the exit code.
			unit: () => {
				// `is-active` exits non-zero for the states this acts on, so the word on stdout is the answer.
				const result = spawnSync(process.env.PI_MUSTER_SYSTEMCTL?.trim() || "systemctl", ["--user", "is-active", WAKER_UNIT], { encoding: "utf8", timeout: SYSTEMCTL_TIMEOUT_MS, env: process.env });
				const state = (result.stdout ?? "").trim();
				return state === "active" || state === "inactive" || state === "failed" ? state : "unknown";
			},
			restart: () => {
				try {
					execFileSync(process.env.PI_MUSTER_SYSTEMCTL?.trim() || "systemctl", ["--user", "restart", WAKER_UNIT], { encoding: "utf8", timeout: SYSTEMCTL_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"], env: process.env });
					return { ok: true, detail: `systemctl --user restart ${WAKER_UNIT}` };
				} catch (error) {
					const detail = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "failed";
					return { ok: false, detail: `systemctl --user restart ${WAKER_UNIT}: ${detail}` };
				}
			},
			lastTurnAt: () => {
				const holder = readSeat("orchestrator", { stateDir }).holder;
				if (holder === null) return undefined;
				const row = machineRows(stateDir).find((entry) => entry.sessionId === holder.sessionId || entry.laneId === (holder.laneId ?? holder.sessionId));
				return row?.lastTurnAt ?? undefined;
			},
			waiting: () => {
				const rows = machineRows(stateDir);
				if (rows.length === 0) return [];
				const records = new Map(listLaneRecords(stateDir).map((record) => [record.laneId, record]));
				const waiting: Array<{ laneId: string; kind: string; at: number }> = [];
				for (const row of rows) {
					const report = row.lastReport;
					if (report === undefined || report.at === undefined) continue;
					const record = records.get(row.laneId);
					const stage = laneStage({
						record: { phase: record?.phase ?? "working", terminal: record?.terminal, launchedAt: record?.launchedAt ?? 0, handoffs: record?.handoffs },
						latestReport: report,
						lastTurnAt: row.lastTurnAt,
					});
					const health = laneHealth({
						cardState: row.state,
						phase: record?.phase,
						terminal: record?.terminal !== undefined,
						latestReport: report,
						handoffs: record?.handoffs,
						leftover: false,
					});
					// A review report newer than the latest handoff (`verifying`), or a blocked/question report
					// nobody answered: both are the seat's to absorb, and the two owners say so, not this file.
					if (stage.stage === "verifying" || health === "blocked" || health === "question") waiting.push({ laneId: row.laneId, kind: report.kind, at: report.at });
				}
				return waiting;
			},
		},
		// WAKEHEALTH: the wake owner's flush and the orchestrator's inbox, the owners the waker and the
		// contract asks also speak through. The count and the hour are the library's, in the same
		// `tick-alerts.json` the other marks live in.
		henryWake: {
			flush: () => flushHenryWake(stateDir),
			wake: (text, key) => tellOrchestrator(stateDir, "muster-tick", text, key),
		},
		// OL3b (spec §4): the contract repairs and system asks. The doctor's result file, the repair log's
		// directory, the live lanes' helper scopes and the one command a declared repair runs all stay here,
		// so an in-process tick pass under a test can neither restart a unit nor raise an ask for the operator. The
		// once-a-day rule, the 15-minute wait, the dedupe by code and the withdraw on green are the library's.
		contracts: {
			stateDir: () => stateDir,
			result: () => readDoctorResult(join(piAgentDir(), "health", DOCTOR_RESULT_FILE), Date.now()),
			// A unit a lane that has not finished holds as its helper scope is never restarted here: that lane's
			// dev server is not this pass's to stop (spec §4 item 2). A finished lane's scope stops nothing.
			helperScopeUnits: () =>
				listLaneRecords(stateDir)
					.filter((record) => !LANE_NOT_RUNNING_PHASES.includes(record.phase))
					.flatMap((record) => (record.helperScopes ?? []).map((scope) => scope.unit)),
			repair: (argv) => {
				const [program, ...args] = argv;
				if (program === undefined) return { ok: false, detail: "the declared repair has no command" };
				try {
					execFileSync(program, args, { encoding: "utf8", timeout: REPAIR_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
					return { ok: true, detail: `ran: ${argv.join(" ")}` };
				} catch (error) {
					return { ok: false, detail: `${argv.join(" ")}: ${(error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "failed"}` };
				}
			},
		},
		// SL2: Claude's window against a live Claude seat. The snapshot is read through its one owner, the seats
		// through the seat owner's own read, and the state directory is the one the asks store uses; the pass raises
		// one prepared item per seat and moves nothing (VR24-225).
		seatMove: {
			stateDir: () => stateDir,
			snapshot: () => readUsageSnapshot(usageSnapshotPath()),
			seats: () =>
				SEAT_ROLES.map((role) => {
					const holder = describeSeat(readSeat(role, { stateDir }), { stateDir }).holder;
					return { role, holder: holder === null ? null : { harness: holder.harness, processAlive: holder.processAlive } };
				}),
		},
		// Every person-facing alert from this pass reaches Henry's mailbox, in wake mode, through the one send path
		// (the operator, 2026-10-29 22:24). No thread, channel or webhook is reachable from the tick.
		alert: async (text, key) => {
			try {
				tellGrokbot(stateDir, "muster-tick", text, key);
				return { delivered: true };
			} catch (error) {
				return { delivered: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
		launch: (plan) => launchRotationWithHerdr(plan),
		launchReady: () => launchReadyWithHerdr(),
		dispatch: dispatchTickPorts({
			stateDir,
			mark: {
				get: (key) => readAlertState(stateFile)[key],
				set: (key, value) => writeAlertState(stateFile, { ...readAlertState(stateFile), [key]: value }),
			},
		}),
		// T5: read-only. Whether the database a live Concord MCP holds open is the
		// one at the project's path — the check that catches a silent split.
		custody: (programme) => {
			const custody = inspectConcordCustody({ dbPath: concordDbPath(normalizePrimaryRoot(programme.repoKey)) });
			return { verdict: custody.verdict, summary: custody.summary };
		},
		decisions: {
			// The decision store is its own owner: the card text, the deadline and
			// the auto-apply verdict all come from it, never from here.
			open: (programmeId) => {
				const open = listOpenDecisions(programmeId);
				const due = new Set(autoAppliableDecisions(programmeId, Date.now()).map((decision) => decision.decisionId));
				return open.map((decision) => ({
					decisionId: decision.decisionId,
					cardText: decisionCardText(decision, projectNameFor(programmeId)),
					recommendation: decision.recommendation,
					autoApplyAt: decision.autoApplyAt,
					autoAppliable: due.has(decision.decisionId),
				}));
			},
			armWindow: (programmeId, decisionId, deliveredAtIso) => {
				const decision = armDecisionWindow(programmeId, decisionId, deliveredAtIso);
				return {
					decisionId: decision.decisionId,
					cardText: decisionCardText(decision, projectNameFor(programmeId)),
					recommendation: decision.recommendation,
					autoApplyAt: decision.autoApplyAt,
					autoAppliable: false,
				};
			},
			applyDefault: (programmeId, decisionId, threadId) => {
				const outcome = applyDecisionDefault(programmeId, decisionId, threadId);
				const record = getDecision(programmeId, decisionId);
				return {
					applied: outcome.applied,
					duplicate: outcome.duplicate,
					optionId: outcome.optionId,
					actorId: outcome.answerRef.actorId,
					cardText: decisionCardText(record, projectNameFor(programmeId)),
				};
			},
		},
		// The digest prints the same metrics line the status line does, from the
		// same metrics owner, so the two can never disagree.
		metrics: async (programme) => {
			const record = readProgrammeSnapshot(programme.programmeId);
			const to = Date.now();
			const from = to - METRICS_WINDOW_MS;
			try {
				const metrics = computeMetrics({
					events: await readOwnershipEvents(concordDbPath(normalizePrimaryRoot(programme.repoKey)), from - METRICS_LOOKBACK_MS),
					metricEvents: readMetricEvents(musterSessionsDir(), from, { sessions: new Set(record.enrolledSessions), repoKey: programme.repoKey }),
					mailbox: programme.parentAgentId,
					ceiling: record.ceiling,
					from,
					to,
					retired: new Set(record.retiredAgents.map((row) => row.agentId)),
				});
				return `metrics (last ${METRICS_WINDOW_MS / 3_600_000} h): ${formatMetricsLine(metrics)}`;
			} catch {
				return undefined;
			}
		},
	};
}

/** Every lane card in the Muster state dir; a card that cannot be read is not a card. */
function readLaneCards(stateDir: string): LaneCard[] {
	let names: string[];
	try {
		names = readdirSync(laneCardsDir(stateDir));
	} catch {
		return [];
	}
	return names.flatMap((name) => (name.endsWith(".json") ? [readLaneCard(stateDir, name.slice(0, -".json".length))] : [])).filter((card): card is LaneCard => card !== undefined);
}

/** The effects of a quota fallback, each through the owner that already does it (DS3, DS4). */
export function quotaFallbackPorts(stateDir: string): QuotaFallbackPorts {
	return {
		setModel(lane, ref) {
			try {
				execFileSync(musterLauncher(), ["control", lane, "set-model", ref, "--from", "muster-tick"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
				return { ok: true };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message.split("\n")[0] : String(error) };
			}
		},
		scheduleResume: (lane, at, text) => scheduleLaneResume(lane, at, text),
		event: (line) => void appendOrchestratorEvent(stateDir, line),
		markHandled(lane, at) {
			const card = readLaneCard(stateDir, lane);
			if (card?.wall) writeLaneCard(stateDir, { ...card, wall: { ...card.wall, handledAt: at } });
		},
		now: () => Date.now(),
	};
}

/** One quota-fallback pass over every lane card. The pool file is read only when a lane is walled; an unreadable one is reported, never guessed around. */
export function runQuotaFallback(stateDir: string = musterStateDir(), ports: QuotaFallbackPorts = quotaFallbackPorts(stateDir)): Array<{ lane: string; action: string; detail: string }> {
	const cards = readLaneCards(stateDir);
	if (!cards.some((card) => card.state === "quota-walled")) return [];
	const pool = loadPoolConfig();
	// A broken pool file is this step's failure, reported by the pass that owns it (OL4): the step no longer
	// writes its own stderr line or sets the process exit code, because it now also runs inside `musterd`.
	if (!pool.ok) throw new Error(`provider-pool.json: ${pool.errors.join("; ")}`);
	const now = ports.now();
	return applyQuotaFallback(quotaFallback(cards, pool.config, activeWalls(pool.config, undefined, now), now), ports);
}

export { liveGitFacts } from "../lib/git-facts.ts";

/** What the lifecycle pass reads and does; the live ports are `lifecyclePorts`, tests pass fakes. */
export interface LifecyclePorts {
	now(): number;
	rows(): LaneCard[];
	records(): LaneRecord[];
	protectedLanes(): { lanes: string[]; error?: string };
	git: GitFacts;
	/** `closeLane` with `park: false`. */
	close(lane: string, outcome: "merged" | "abandoned", reason: string): Promise<{ ok: boolean; detail: string }>;
	/** `closeLane` with `park: true`. */
	park(lane: string, why: string): Promise<{ ok: boolean; detail: string }>;
	/** Appends the event line; false when it could not be written. */
	event(line: string): boolean;
	/** One line into Henry's outbox. */
	tellOperator(text: string, key: string): void;
	markReminded(lane: string, reminder: LaneReminder, at: number): void;
	/** LD15: lane names with more than one live session. Alert only: nothing in the pass ever stops one. Absent means no guard. */
	duplicates?(): DuplicateSet[];
	/** KEYINJ: live lanes whose model's provider key resolves empty. Alert only, and it names the key NAME, never a value. */
	keyFindings?(): LaneKeyFinding[] | undefined;
	/** Has this lane-key finding (lane and NAME) been reported already? */
	keyReported?(key: string): boolean;
	markKeyReported?(key: string, at: number): void;
	/** Has this duplicate set (by key) been reported already? */
	duplicateReported?(key: string): boolean;
	markDuplicateReported?(key: string, at: number): void;
	/** LD24: the lane id of every seat holder. A holder is never acted on, so it is untouchable whatever else is true. Absent means none. */
	seatLanes?(): Array<{ role: SeatRole; laneId: string }>;
	/** LD24: a seat without a live session for 15 minutes yields one notice for the operator. Absent means no watch. */
	seatOrphans?(options?: { dryRun?: boolean }): SeatOrphanNotice[];
	markSeatOrphanNotified?(role: SeatRole): void;
	/** Says why a lane got no action (dry run only). */
	trace?(lane: string, note: string): void;
}

export interface LifecycleResult {
	lane: string;
	action: string;
	detail: string;
}

/** How long one `systemctl --user` call may take before the watchdog treats the unit as unknown. */
const SYSTEMCTL_TIMEOUT_MS = 10_000;

/** The lane directory's rows once per watchdog read: the same listing the lifecycle pass uses. */
function machineRows(stateDir: string): LaneCard[] {
	return enumerateLanes({
		laneCardsDir: laneCardsDir(stateDir),
		laneRegistryPath: lanesRegistryPath({ ...process.env, PI_MUSTER_STATE_DIR: stateDir }),
		includeUnregisteredSessions: false,
	});
}

/** The effects of the lifecycle pass, each through its owner: `closeLane`, the event file, Henry's outbox. */
export function lifecyclePorts(stateDir: string = musterStateDir(), env: NodeJS.ProcessEnv = process.env): LifecyclePorts {
	const laneEnv = { ...env, PI_MUSTER_STATE_DIR: stateDir };
	const listRows = (): LaneCard[] => enumerateLanes({ laneCardsDir: laneCardsDir(stateDir), laneRegistryPath: lanesRegistryPath(laneEnv), includeUnregisteredSessions: false });
	return {
		now: () => Date.now(),
		rows: listRows,
		records: () => listLaneRecords(stateDir),
		protectedLanes: () => readProtectedLanes(stateDir),
		git: liveGitFacts,
		close: async (lane, outcome, reason) => {
			const closed = await closeLaneLive(stateDir, lane, { park: false, terminal: { outcome, reason }, caller: "muster-tick" }, laneEnv);
			return { ok: closed.ok, detail: closed.detail };
		},
		park: async (lane) => {
			const parked = await closeLaneLive(stateDir, lane, { park: true, caller: "muster-tick" }, laneEnv);
			return { ok: parked.ok, detail: parked.detail };
		},
		event: (line) => appendOrchestratorEvent(stateDir, line),
		tellOperator: (text, key) => {
			tellGrokbot(stateDir, "muster-tick", text, key);
		},
		markReminded: (lane, reminder, at) => markReminded(stateDir, lane, reminder, at),
		duplicates: () => {
			// The same machine readers as the directory, so an isolated install (PI_LANES_SYSTEM_EVIDENCE=off) sees no one.
			const evidence = laneSystemEvidence(env);
			const records = listLaneRecords(stateDir);
			const knownLanes = new Set([...records.map((record) => record.laneId), ...listRows().filter((row) => row.origin === "auto").map((row) => row.laneId)]);
			return findDuplicateLanes({ claudeRows: readClaudeAgentsJson({ home: env["HOME"] }), panes: evidence.tmuxPanes(), records, knownLanes, pidAlive: evidence.pidAlive });
		},
		duplicateReported: (key) => key in readReportedDuplicates(stateDir),
		markDuplicateReported: (key, at) => markDuplicateReported(stateDir, key, at),
		// The lane rows are the directory's own, so the key check reads the model each live lane actually runs.
		keyFindings: () => laneKeyFindings(listRows(), laneEnv),
		keyReported: (key) => key in readReportedLaneKeys(stateDir),
		markKeyReported: (key, at) => markLaneKeyReported(stateDir, key, at),
		seatLanes: () => seatHolderLanes({ stateDir }),
		seatOrphans: (options) => observeSeatOrphans({ stateDir }, options),
		markSeatOrphanNotified: (role) => markSeatOrphanNotified(role, { stateDir }),
	};
}

/**
 * LD24: tell the operator once, through Henry, about each seat that has had no live session for 15 minutes. It changes
 * nothing about the seat or its holder. The notice is marked sent only after it went out, so a failed send is tried again.
 */
export function seatOrphanPass(ports: LifecyclePorts, options: { dryRun?: boolean } = {}): LifecycleResult[] {
	const results: LifecycleResult[] = [];
	for (const notice of ports.seatOrphans?.(options) ?? []) {
		if (options.dryRun === true) {
			results.push({ lane: notice.role, action: "lifecycle-seat-orphan", detail: notice.text });
			continue;
		}
		try {
			ports.tellOperator(notice.text, notice.key);
			ports.markSeatOrphanNotified?.(notice.role);
			results.push({ lane: notice.role, action: "lifecycle-seat-orphan", detail: notice.text });
		} catch (error) {
			results.push({ lane: notice.role, action: "lifecycle-failed", detail: error instanceof Error ? error.message : String(error) });
		}
	}
	return results;
}

/**
 * LD15: tell the orchestrator and Henry once about each lane name held by more than one live session. It
 * changes nothing, so it makes no difference whose sessions they are (a conversation lane, the operator's own).
 * The line to Henry goes first and carries the set as its idempotency key, so a retry after a failed event
 * sends it once; the set is marked reported only when both went out.
 */
export function duplicatePass(ports: LifecyclePorts, options: { dryRun?: boolean } = {}): LifecycleResult[] {
	const results: LifecycleResult[] = [];
	for (const set of ports.duplicates?.() ?? []) {
		if (ports.duplicateReported?.(set.key) === true) continue;
		const detail = duplicateDetail(set);
		if (options.dryRun === true) {
			results.push({ lane: set.lane, action: "lifecycle-duplicate", detail });
			continue;
		}
		try {
			ports.tellOperator(duplicateOperatorText(set), `duplicate:${set.key}`);
			const sent = ports.event(formatEventLine("STALLED", set.lane, detail));
			if (sent) ports.markDuplicateReported?.(set.key, ports.now());
			results.push({ lane: set.lane, action: sent ? "lifecycle-duplicate" : "lifecycle-failed", detail });
		} catch (error) {
			results.push({ lane: set.lane, action: "lifecycle-failed", detail: error instanceof Error ? error.message : String(error) });
		}
	}
	return results;
}

function describeAction(action: LifecycleAction): { action: string; detail: string } {
	switch (action.kind) {
		case "park":
			return { action: "lifecycle-park", detail: action.why === "idle-cap" ? "more than 3 idle lanes: the oldest is parked" : "handed off and idle for 30 minutes: parked" };
		case "close":
			return { action: "lifecycle-close", detail: `${action.outcome}: ${action.reason}` };
		case "event":
			return { action: "lifecycle-event", detail: action.detail };
		case "tell-operator":
			return { action: "lifecycle-tell-operator", detail: action.text };
		case "flag-dirty":
			return { action: "lifecycle-flag-dirty", detail: "uncommitted changes in the worktree: not stopped" };
	}
}

/**
 * One lifecycle pass (blueprint WP3): the duplicate guard (WP12, LD15), the lane key check (KEYINJ) and the seat watch,
 * then read the directory rows and the lane records, decide, act.
 * `dryRun` decides and returns what it would do and takes no action (no stop, no event, no
 * message, no reminder stamp). A protected-lanes file that cannot be read stops the pass: the tick
 * does not guess who is protected. A failed action is reported and does not stop the others; a
 * reminder is stamped only once its message went out, so a failed send is tried again next tick.
 */
export async function lifecyclePass(ports: LifecyclePorts, options: { dryRun?: boolean } = {}): Promise<LifecycleResult[]> {
	// The duplicate guard first: it needs no protected-lanes list and must not be silenced by an unreadable one.
	const results: LifecycleResult[] = [...duplicatePass(ports, options), ...laneKeyPass(ports, options), ...seatOrphanPass(ports, options)];
	const protectedLanes = ports.protectedLanes();
	const seatLanes = ports.seatLanes?.() ?? [];
	if (protectedLanes.error !== undefined) throw new Error(`lifecycle pass skipped, protected lanes: ${protectedLanes.error}`);
	const now = ports.now();
	const records = new Map(ports.records().map((record) => [record.laneId, record]));
	const rows = ports.rows();
	for (const row of rows) {
		if (records.has(row.laneId) || ports.trace === undefined) continue;
		const heldSeat = seatLanes.find((entry) => entry.laneId === row.laneId)?.role;
		const never = untouchableSession({ laneId: row.laneId, protectedLanes: protectedLanes.lanes, ...(row.origin !== undefined ? { origin: row.origin } : {}), ...(heldSeat !== undefined ? { heldSeat } : {}) }) !== undefined;
		ports.trace(row.laneId, never ? "protected or the operator's own session: never touched" : "no lane record (launched before the lifecycle), so it is not managed");
	}
	const actions = decideLifecycle(rows, records, ports.git, now, { protectedLanes: protectedLanes.lanes, seatLanes, ...(ports.trace !== undefined ? { trace: ports.trace } : {}) });
	const failedClose = new Set<string>();
	for (const action of actions) {
		const described = describeAction(action);
		if (options.dryRun === true) {
			results.push({ lane: action.lane, ...described });
			continue;
		}
		try {
			let done = true;
			let detail = described.detail;
			switch (action.kind) {
				case "close": {
					const closed = await ports.close(action.lane, action.outcome, action.reason);
					done = closed.ok;
					detail = closed.detail;
					if (!done) failedClose.add(action.lane);
					break;
				}
				case "park": {
					const parked = await ports.park(action.lane, action.why);
					done = parked.ok;
					detail = parked.detail;
					break;
				}
				case "event":
					done = ports.event(formatEventLine("STALLED", action.lane, action.detail));
					break;
				case "flag-dirty":
					done = ports.event(formatEventLine("STALLED", action.lane, "uncommitted changes in the worktree; the tick never stops a dirty lane"));
					break;
				case "tell-operator":
					if (action.afterClose === true && failedClose.has(action.lane)) {
						results.push({ lane: action.lane, action: "lifecycle-skipped", detail: "its close failed, so the operator is not told yet" });
						continue;
					}
					ports.tellOperator(action.text, `lifecycle:${action.lane}:${action.reminder ?? "died"}:${records.get(action.lane)?.phaseSince ?? now}`);
					break;
			}
			if (done && "reminder" in action && action.reminder !== undefined) ports.markReminded(action.lane, action.reminder, now);
			results.push({ lane: action.lane, action: done ? described.action : "lifecycle-failed", detail });
		} catch (error) {
			results.push({ lane: action.lane, action: "lifecycle-failed", detail: error instanceof Error ? error.message : String(error) });
		}
	}
	return results;
}

function printLifecycle(results: LifecycleResult[], dryRun: boolean): void {
	for (const result of results) process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), programmeId: "-", project: "-", ...result, ...(dryRun ? { dryRun: true } : {}) })}\n`);
}

/** WP11 (LD12): the graph pass reads the catalogue's repositories and starts refreshes through the graph owner. */
export function liveGraphRefreshPorts(): GraphRefreshPorts {
	return { repos: () => (existsSync(projectCataloguePath()) ? catalogueRepoRoots(readProjectCatalogue()) : []), status: (repo) => graphStatus(repo), start: (repo) => startGraphRefresh(repo) };
}

/** WP-E (LD19): the checkout this tick runs from is the one whose HEAD the gateway's start commit is compared with. */
export function liveGatewayFreshnessPorts(stateDir: string = musterStateDir(), checkout: string = piAgentDir()): GatewayFreshnessPorts {
	return { stateDir, head: () => checkoutHead(checkout), changedFiles: (sha) => gatewayChangedFiles(checkout, sha), event: (line) => appendOrchestratorEvent(stateDir, line) };
}

/**
 * LC2 (§3.3): the one line a failed pass prints when the store is unavailable.
 * A boundary failure never prints a stack — the operator's action is to check
 * `musterd` or the flip, and the stack hides that — and every other error keeps
 * the tick's own handling, so files mode is unchanged.
 */
export function tickBoundaryLine(error: unknown): string | undefined {
	const reason = boundaryReason(error);
	return reason === undefined ? undefined : `muster-tick: ${reason}`;
}

// ─── D25: the ask push ───────────────────────────────────────────────────────

/**
 * The keys the ask push owns in `tick-alerts.json`. The file holds more than this
 * pass's keys — the programme heartbeats `runTick` stamps — and `writeAlertState`
 * replaces the whole file, so the pass never writes a fresh object.
 */
const ASK_PUSH_PREFIX = "ask:";
/** Written by the first pass, which only records what is already waiting: the backlog it starts with never wakes Henry. */
const ASK_PUSH_SEEDED = "asks:seeded";
/** The body is a wake line, so it lists a bounded set and then the count left over. */
const ASK_PUSH_BODY_LIMIT = 20;

export interface AskPushPorts {
	/** The queue owner (`asks.ts`): this pass never reads the event file itself. */
	queue: () => AskQueue;
	/** `tick-alerts.json` as it is right now. Read again after a send, because the write replaces the file. */
	state: () => Record<string, string>;
	write: (state: Record<string, string>) => void;
	/** Henry's one send path (`tellGrokbot`), batched to one issue an hour for the sender `muster-tick`. */
	tell: (text: string, key: string) => void;
	now?: () => Date;
}

export type AskPushResult = {
	/** The pass only recorded the asks that were already waiting. */
	seeded: boolean;
	sent: boolean;
	/** The message's first line, which the wake uses as its issue title. */
	line?: string;
	newIds: string[];
	/** Keys removed because their ask no longer waits on the operator. */
	dropped: string[];
};

/**
 * The asks D25 pushes: waiting on the operator, and either a kind only he may answer or
 * a lane waiting on the answer. The order is the queue's own, so the ask blocking
 * the most lanes comes first.
 */
export function asksToPush(queue: AskQueue): Ask[] {
	return orderAsksForOperator(waitingOnOperator(queue).filter((ask) => OPERATOR_ONLY_KINDS.includes(ask.kind) || ask.blocks.length > 0));
}

/**
 * D25's message: counts, codes or ids, kinds and blocked counts, and nothing else.
 * A question is never carried, because question text can quote chat. The first
 * line is the wake's issue title, which is cut at 80 characters (`grokbot-wake.ts`).
 */
export function askPushText(asks: Ask[]): string {
	const count = asks.length;
	const lines = [`${count} new ask${count === 1 ? "" : "s"} wait${count === 1 ? "s" : ""} on the operator`];
	for (const ask of asks.slice(0, ASK_PUSH_BODY_LIMIT)) lines.push(`- ${askCodeOf(ask)} | ${ask.kind} | blocks ${ask.blocks.length}`);
	if (count > ASK_PUSH_BODY_LIMIT) lines.push(`- and ${count - ASK_PUSH_BODY_LIMIT} more`);
	lines.push("", "Read them with asks_read.");
	return lines.join("\n");
}

/** The send's idempotency key: the set of new asks, so a retry of the same set is one message. */
function askPushKey(asks: Ask[]): string {
	return `asks-push:${createHash("sha256").update(asks.map((ask) => ask.id).sort().join(",")).digest("hex").slice(0, 16)}`;
}

function withoutKeys(state: Record<string, string>, keys: readonly string[]): Record<string, string> {
	const next = { ...state };
	for (const key of keys) delete next[key];
	return next;
}

/**
 * D25. One pass: the asks waiting on the operator that Henry has not been told about,
 * one line to him, then the keys marked. A failed send throws before anything is
 * written, so the next tick sends the same asks again. A key whose ask no longer
 * waits is removed by the next pass that writes.
 */
export function askPushPass(ports: AskPushPorts): AskPushResult {
	const at = (ports.now?.() ?? new Date()).toISOString();
	const waiting = asksToPush(ports.queue());
	const waitingIds = new Set(waiting.map((ask) => ask.id));
	const keyOf = (id: string): string => `${ASK_PUSH_PREFIX}${id}`;
	const before = ports.state();
	const dropped = Object.keys(before).filter((key) => key.startsWith(ASK_PUSH_PREFIX) && !waitingIds.has(key.slice(ASK_PUSH_PREFIX.length)));

	if (!(ASK_PUSH_SEEDED in before)) {
		const seeded = withoutKeys({ ...before, [ASK_PUSH_SEEDED]: at }, dropped);
		for (const ask of waiting) seeded[keyOf(ask.id)] = at;
		ports.write(seeded);
		return { seeded: true, sent: false, newIds: [], dropped };
	}
	const fresh = waiting.filter((ask) => !(keyOf(ask.id) in before));
	if (fresh.length === 0) {
		if (dropped.length > 0) ports.write(withoutKeys(ports.state(), dropped));
		return { seeded: false, sent: false, newIds: [], dropped };
	}
	const text = askPushText(fresh);
	ports.tell(text, askPushKey(fresh));
	const after = withoutKeys(ports.state(), dropped);
	for (const ask of fresh) after[keyOf(ask.id)] = at;
	ports.write(after);
	return { seeded: false, sent: true, line: text.split("\n")[0], newIds: fresh.map((ask) => ask.id), dropped };
}

/** D25's failure contained: a throw becomes the tick's stderr line, so the passes after it still run. */
export function askPushStage(ports: AskPushPorts): { action?: "asks-push" | "asks-push-seeded"; detail?: string; error?: string } {
	try {
		const result = askPushPass(ports);
		if (result.seeded) return { action: "asks-push-seeded", detail: "the asks already waiting are recorded; nothing is sent for them" };
		if (result.sent && result.line !== undefined) return { action: "asks-push", detail: result.line };
		return {};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** The ask push's effects, each through its owner: the queue, the alert file's read-merge-write, Henry's send path. */
export function liveAskPushPorts(stateDir: string = musterStateDir(), tell?: AskPushPorts["tell"]): AskPushPorts {
	const file = alertStatePath(stateDir);
	return {
		queue: () => readAsks(stateDir),
		state: () => readAlertState(file),
		write: (state) => writeAlertState(file, state),
		tell: tell ?? ((text: string, key: string) => tellGrokbot(stateDir, "muster-tick", text, key)),
	};
}

// ─── D23: standing-rule drafts ───────────────────────────────────────────────

export interface StandingRulePorts {
	/** The queue owner (`asks.ts`): this pass never reads the event file itself. */
	queue: () => AskQueue;
	/** Raises one draft through the ask store's owner, as the writer `desk`. */
	raise: (draft: StandingRuleDraft) => Ask;
}

export type StandingRuleResult = { raised: Array<{ id: string; code: string; source: string }> };

/**
 * D23. One pass: the drafts the queue calls for (`standingRuleDrafts`, which holds the trigger and
 * the text) raised as asks. The source of a draft names its third ask, so a second pass finds it
 * and raises nothing. No model is called and no rule is applied.
 */
export function standingRulePass(ports: StandingRulePorts): StandingRuleResult {
	const raised: StandingRuleResult["raised"] = [];
	for (const draft of standingRuleDrafts(ports.queue())) {
		const ask = ports.raise(draft);
		raised.push({ id: ask.id, code: draft.code, source: draft.source });
	}
	return { raised };
}

/** D23's failure contained: a throw becomes the tick's stderr line, so the passes after it still run. */
export function standingRuleStage(ports: StandingRulePorts): { action?: "standing-rule-draft"; detail?: string; error?: string } {
	try {
		const { raised } = standingRulePass(ports);
		if (raised.length === 0) return {};
		return { action: "standing-rule-draft", detail: raised.map((entry) => entry.code).join(", ") };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

export function liveStandingRulePorts(stateDir: string = musterStateDir()): StandingRulePorts {
	return { queue: () => readAsks(stateDir), raise: (draft) => raiseStandingRuleDraft(stateDir, draft) };
}

/**
 * OL4 (spec §10): the live bindings of `runTickPass`. This is the one place the pass's steps are bound to
 * the machine, and both owners use it — the timer's `main()` with the live state dir, the durable task
 * with the ledger's directory. Each step is the existing owner, unchanged in what it does; only where its
 * lines go has moved, from `main()`'s `process.stdout` to the pass's sinks, so the text is the same.
 */
export function liveTickPassPorts(stateDir: string = musterStateDir(), options: { replaySpool?: () => void; fail?: () => void } = {}): TickPassPorts {
	const at = (): string => new Date().toISOString();
	const line = (fields: Record<string, unknown>): string => JSON.stringify({ at: at(), programmeId: "-", project: "-", ...fields });
	return {
		stateDir: () => stateDir,
		// Spec §4: the tick's proof of life, written before the passes so a pass that dies still says it began.
		// The doctor reads this file as the `muster tick` contract; nothing else polls it.
		heartbeat: () => writeTickHeartbeat(stateDir),
		// DL6 (§3.2): a one-time signal that could not be written while `musterd` was down waits in the spool.
		// A ledger-mode pass replays it through the owners before its own work; the flip tool replays at the
		// end of flip, abort and rollback, which is what puts the spool back when the stores are frozen.
		replaySpool:
			options.replaySpool ??
			(() => {
				if (backendState(stateDir).backend === "ledger") replaySpool(stateDir);
			}),
		quota: () => ({
			out: runQuotaFallback(stateDir).map((done) => line({ action: `quota-${done.action}`, detail: done.detail, lane: done.lane })),
		}),
		// A base ref that moved since the last graph refresh starts one in the background, so a push refreshes within a tick.
		graphRefresh: () => ({
			out: graphRefreshPass(liveGraphRefreshPorts()).map((started) => line({ action: "graph-refresh", detail: `${started.repo}: ${started.reason}` })),
		}),
		// LD19: a gateway started from code older than main is reported once per HEAD. Nothing is restarted here.
		gatewayFreshness: () => {
			const stale = gatewayFreshnessPass(liveGatewayFreshnessPorts(stateDir));
			return stale === undefined ? {} : { out: [line({ action: stale.action, detail: stale.detail })] };
		},
		// D25: an ask that newly waits on the operator goes to Henry once. A dry run returned above, so it sends nothing.
		askPush: () => {
			const staged = askPushStage(liveAskPushPorts(stateDir));
			if (staged.error !== undefined) return { err: [`muster-tick: ask push failed: ${staged.error}`], failed: true };
			return staged.action === undefined ? {} : { out: [line({ action: staged.action, detail: staged.detail })] };
		},
		// D23: three alike answers on one kind and rule raise a standing-rule draft for the operator. A dry run returned above.
		standingRules: () => {
			const staged = standingRuleStage(liveStandingRulePorts(stateDir));
			if (staged.error !== undefined) return { err: [`muster-tick: standing-rule pass failed: ${staged.error}`], failed: true };
			return staged.action === undefined ? {} : { out: [line({ action: staged.action, detail: staged.detail })] };
		},
		// WAKEHEALTH (Henry 2026-10-27 18:56): a flush that fails twice in a row raises one alert an hour in the
		// orchestrator's inbox, because the stderr line below was the only sign a broken `gh` left. The flush
		// itself, and the queue it keeps, are the wake owner's; this pass counts what it says.
		wakeHealth: async () => {
			const wakeHealth = await henryWakeHealth(livePorts(stateDir));
			if (wakeHealth === undefined) return {};
			return { out: [JSON.stringify({ at: at(), ...wakeHealth })], err: [`muster-tick: ${wakeHealth.detail}`] };
		},
		tick: async () => {
			const actions = await runTick(livePorts(stateDir));
			const out: string[] = [];
			const err: string[] = [];
			let failed = false;
			for (const action of actions) {
				if (action.action === "none") continue;
				out.push(JSON.stringify({ at: at(), ...action }));
				if (action.action === "unreadable") {
					err.push(`muster-tick: ${action.project}: ${action.detail}`);
					failed = true;
				}
			}
			return { out, err, ...(failed ? { failed: true } : {}) };
		},
		// The lifecycle pass stops lanes (LD1). It prints its own human-readable lines; a ledger boundary
		// keeps its one-line form, and any other failure is the pass's to report.
		lifecycle: async () => {
			try {
				printLifecycle(await lifecyclePass(lifecyclePorts()), false);
			} catch (error) {
				const boundary = tickBoundaryLine(error);
				if (boundary === undefined) throw error;
				process.stderr.write(`${boundary}\n`);
				process.exitCode = 1;
			}
		},
		out: (text) => process.stdout.write(`${text}\n`),
		err: (text) => process.stderr.write(`${text}\n`),
		fail:
			options.fail ??
			(() => {
				process.exitCode = 1;
			}),
	};
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const dryRun = args.includes("--dry-run");
	if (dryRun) {
		// A dry run is the lifecycle pass alone and takes no action: no quota switch, no wake, no stop.
		const notes: string[] = [];
		const ports = { ...lifecyclePorts(), trace: (lane: string, note: string) => void notes.push(`${lane}: ${note}`) };
		printLifecycle(await lifecyclePass(ports, { dryRun: true }), true);
		const stale = gatewayFreshnessPass(liveGatewayFreshnessPorts(), { dryRun: true });
		if (stale !== undefined) process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), programmeId: "-", project: "-", action: stale.action, detail: stale.detail, dryRun: true })}\n`);
		for (const note of notes) process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), action: "lifecycle-skipped", dryRun: true, detail: note })}\n`);
		return;
	}
	// OL4 (spec §10): the whole pass is one owner, `runTickPass` in `../tick.ts`, and it takes
	// `state/muster/tick.lock` before any step. The live bindings below are the same steps `main()`
	// used to call one by one; the durable task binds the same pass to the ledger's directory.
	const ports = liveTickPassPorts(musterStateDir());
	// The lifecycle pass stops lanes (LD1), so it runs only when asked for. The durable task never asks.
	const pass = args.includes("--lifecycle") ? ports : { ...ports, lifecycle: undefined };
	// The expected loser of the lock (it logs `skipped: lock held`, runs nothing and exits 0 for systemd) is
	// the pass's own answer, so there is nothing left to do here either way.
	await runTickPass(pass);
}

/** The entry the start file runs (`scripts/muster-tick.mts`). */
export function run(): void {
	main().catch((error: unknown) => {
		process.stderr.write(`${tickBoundaryLine(error) ?? `muster-tick: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`}\n`);
		process.exitCode = 1;
	});
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	run();
}
