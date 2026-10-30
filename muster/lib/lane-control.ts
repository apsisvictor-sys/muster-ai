/**
 * Lane control requests — design §4.5, acceptance check 5.
 *
 * ONE owner of the control vocabulary and its queue on disk. The orchestrator's
 * CLI writes one request (`muster control <lane> abort|stop|set-model`); the lane's
 * own heartbeat takes it and applies it through the same handler the Concord
 * `details.control` envelope uses, so there is no second implementation of the
 * verb and no path that types into a TUI.
 *
 * Why a file and not only Concord: an enrolled Pi lane in a repository with no
 * Concord workspace cannot receive anything through Concord (the pilot measured
 * exactly that on pi-be-g3, 2026-10-08), and control is the one thing an
 * orchestrator must be able to do without a workspace. The file sits beside the
 * lane cards, is one-shot (taken = removed), and is never authority: the lane's
 * handler applies the same peer boundary as before.
 *
 * The parity table below says how each harness gets each verb: the lane's own
 * host or heartbeat drains the queue, or — for a Claude lane, where nothing on
 * the lane reads the queue — this CLI runs the harness's own command.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { LaneHarness, LaneOrigin } from "./lane-card.ts";
import { loadPoolConfig } from "../../routing/provider-pool.ts";
import { readBackend, writeBackend } from "../ledger/backend.ts";
import { ledgerCasStore, ledgerCommit, type LedgerCasStore } from "../ledger/cas-store.ts";
import { LANE_CONTROL_STORE, ownerLedgerSocket } from "../ledger/stores.ts";
import { CAS_ATTEMPTS } from "../owner-fence.ts";

/**
 * Every control verb works on every harness (2026-10-09). `stop` was
 * OpenCode-only until the parity table below existed; the table, not the verb
 * list, now says how each harness gets it.
 */
export const LANE_CONTROL_OPERATIONS = ["abort", "setModel", "stop"] as const;
export type LaneControlOperation = (typeof LANE_CONTROL_OPERATIONS)[number];

export interface LaneControlRequest {
	/** Unique per request; a lane takes each request once. */
	id: string;
	laneId: string;
	operation: LaneControlOperation;
	/** `setModel`: `{ modelId }`. `abort` and `stop`: nothing. */
	params?: Record<string, unknown>;
	/** Epoch ms the request was written. */
	at: number;
	/** Who asked (the orchestrator's agent id), for the lane's log line. */
	from?: string;
}

/** `<musterStateDir>/control` — beside `lanes/`, the same root and lifetime. */
export function laneControlDir(musterStateDir: string): string {
	return join(musterStateDir, "control");
}

export function laneControlFile(musterStateDir: string, laneId: string): string {
	// The lane id is a Concord agent id (namespaced, maybe with a colon): keep it
	// readable but never a path separator.
	return join(laneControlDir(musterStateDir), `${laneId.replace(/[\\/]/g, "_")}.json`);
}

/** Accept a control word from a command line. */
export function normalizeLaneControlOperation(word: string | undefined): LaneControlOperation | undefined {
	if (word === undefined) return undefined;
	const normalized = word.trim().toLowerCase().replace(/[-_]/g, "");
	if (normalized === "abort" || normalized === "cancel") return "abort";
	if (normalized === "stop") return "stop";
	if (normalized === "setmodel" || normalized === "model") return "setModel";
	return undefined;
}

/** Queue one request atomically. Returns the file path, or the ledger doc the request queued under. */
export function enqueueLaneControl(
	musterStateDir: string,
	request: Omit<LaneControlRequest, "id" | "at"> & { id?: string; at?: number },
): string {
	const full: LaneControlRequest = {
		...request,
		id: request.id ?? randomUUID(),
		at: request.at ?? Date.now(),
	};
	if (writeBackend(musterStateDir) === "ledger") {
		const store = ledgerControlStore(musterStateDir);
		for (let attempt = 0; ; attempt += 1) {
			const current = store.readWithRevision(request.laneId);
			try {
				store.update(request.laneId, current?.revision, () => ({ ...full, revision: current?.revision ?? 0 }));
				return `${LANE_CONTROL_STORE}:${request.laneId}`;
			} catch (error) {
				if (!(error instanceof LaneControlStateError) || error.code !== "conflict" || attempt >= CAS_ATTEMPTS - 1) throw error;
			}
		}
	}
	const dir = laneControlDir(musterStateDir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const target = laneControlFile(musterStateDir, request.laneId);
	const tmp = `${target}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(full, null, 2), { mode: 0o600 });
	renameSync(tmp, target);
	return target;
}

// ─── The ledger backend (LC5) ────────────────────────────────────────────────
//
// One owner, two stores (LC-D2): `control/<laneId>.json` (today's store,
// untouched) or the ledger's `lane-control` record, whose body is the same
// `LaneControlRequest`. Only the store branch changes.

/** The owner's `CasStoreError` code set. */
export class LaneControlStateError extends Error {
	readonly code: "missing" | "malformed" | "conflict" | "io";
	constructor(code: "missing" | "malformed" | "conflict" | "io", message: string) {
		super(message);
		this.code = code;
		this.name = "LaneControlStateError";
	}
}

/** The ledger keeps its revision beside the request, never inside it (LC-D3). */
type StoredLaneControl = LaneControlRequest & { revision: number };

function validateStoredControl(raw: unknown): { ok: true; record: StoredLaneControl } | { ok: false; errors: string[] } {
	const request = raw as (Partial<LaneControlRequest> & { revision?: unknown }) | null | undefined;
	if (request === null || request === undefined || typeof request !== "object") return { ok: false, errors: ["not a control request"] };
	if (typeof request.laneId !== "string" || request.laneId === "") return { ok: false, errors: ["laneId must be a lane id"] };
	if (!(LANE_CONTROL_OPERATIONS as readonly unknown[]).includes(request.operation)) return { ok: false, errors: ["operation must be a lane control operation"] };
	return { ok: true, record: { ...(request as LaneControlRequest), revision: typeof request.revision === "number" ? request.revision : 0 } };
}

function ledgerControlStore(musterStateDir: string): LedgerCasStore<StoredLaneControl> {
	return ledgerCasStore<StoredLaneControl>(LANE_CONTROL_STORE, ownerLedgerSocket(musterStateDir), {
		idPattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/,
		idKind: "lane",
		noun: "lane control",
		validate: validateStoredControl,
		errorClass: LaneControlStateError,
	});
}

// ─── The parity table ────────────────────────────────────────────────────────
//
// One owner of "which bus verb works on which harness" (2026-10-09). It is data
// the CLI reads, so a refusal is stated once and is never re-typed per harness.
//
//   works    the harness-neutral path serves the verb (the CLI, Concord, the
//            card and the directory); no per-harness code runs.
//   adapter  the verb needs the named harness adapter. `appliedBy` says who
//            runs it: "lane" (the lane's own host or heartbeat drains the
//            control queue) or "claude-cli" (this CLI runs the harness's own
//            command, because nothing on a Claude lane reads the queue).
//   cannot   the harness has no way to do it. `why` is the reason and
//            `substitute` is the stated path the caller uses instead — never a
//            silent no-op and never an ad-hoc refusal in the caller.

/**
 * The bus verb vocabulary. `close` is `stop`: one verb removes the card, so
 * there is no second name for the caller to drift onto.
 */
export const LANE_BUS_VERBS = ["send", "report", "wait", "lanes", "abort", "stop", "setModel", "launch", "close", "resume", "card", "report-nudge", "graph-nudge"] as const;
export type LaneBusVerb = (typeof LANE_BUS_VERBS)[number];

/** Who applies a control verb. */
export type LaneControlApplier = "lane" | "claude-cli";

export type LaneVerbCell =
	| { support: "works" }
	/** Absent `appliedBy` means the lane's own host or heartbeat applies it. */
	| { support: "adapter"; adapter: string; appliedBy?: LaneControlApplier }
	| { support: "cannot"; why: string; substitute: string };

const NO_HARNESS: LaneVerbCell = {
	support: "cannot",
	why: "the card does not name a harness, so the bus never guesses one",
	substitute: "re-launch the lane with `pi-lane-launch.sh --harness pi|opencode|claude` so its card names its harness",
};

/** Every bus verb against every harness. Read through `laneVerbCell`. */
export const LANE_VERB_PARITY: Record<LaneBusVerb, Record<LaneHarness, LaneVerbCell>> = {
	send: {
		pi: { support: "adapter", adapter: "the Pi extension's relay: a Concord delivery lands in the conversation as a `muster-relay` row" },
		opencode: { support: "adapter", adapter: "the OpenCode host: `concord inbox watch` → `prompt_async` (opencode-host.mjs)" },
		claude: { support: "adapter", adapter: "inbox only (LD16): the message is written to the session's agent inbox (lib/agent-inbox.ts) and nothing else, whatever the session's state. A running lane's `muster-bus` hook reads it at each tool boundary and injects it as `hookSpecificOutput.additionalContext` via `muster claude-hook`, and `muster wait --inbox <lane>` is the between-turns reader on the same once-only ledger (LD10; the waiter writes state/muster/waiters/<lane>.pid, and the Stop hook asks a lane to arm it). A session whose process is gone (retired by the daemon after an idle hour, or parked) is asleep: the message waits and is read when the session is next opened, and the send outcome says so. No send path stops or resumes a Claude session; a restart is a deliberate command, never part of delivery", appliedBy: "lane" },
		// F17, LC12: a Hermes lane reads its inbox through the CLI (`muster wait --inbox`),
		// so the harness-neutral send path serves it and no adapter runs.
		hermes: { support: "works" },
		unknown: NO_HARNESS,
	},
	report: {
		pi: { support: "works" },
		opencode: { support: "works" },
		claude: { support: "adapter", adapter: "the card is created at session start by the `muster-bus` heartbeat (lib/claude-lane-card.ts), so the report lands on it like any other; `muster report` creates it on first need when no hook has run yet" },
		hermes: { support: "works" },
		unknown: NO_HARNESS,
	},
	wait: {
		pi: { support: "works" },
		opencode: { support: "works" },
		claude: { support: "works" },
		hermes: { support: "works" },
		unknown: NO_HARNESS,
	},
	lanes: {
		pi: { support: "works" },
		opencode: { support: "works" },
		claude: { support: "adapter", adapter: "the `muster-bus` heartbeat writes activity and model on the card (lib/claude-lane-card.ts) and lib/lane-directory.ts overlays `claude agents --json` for liveness, so the row carries the lane's own last activity, not just the harness surface" },
		hermes: {
			support: "cannot",
			why: "the lane directory overlays each harness's own liveness surface (`claude agents --json`, the harness's tmux window) and a Hermes lane has none, so the bus cannot tell a running Hermes lane from a stopped one",
			substitute: "the lane's own service (`systemctl --user status <unit>`), and `muster report --lane <lane>` to keep its card current",
		},
		unknown: NO_HARNESS,
	},
	abort: {
		pi: { support: "adapter", adapter: "the lane-card adapter: `handleControlMessage` → `ctx.abort()` stops the current run", appliedBy: "lane" },
		opencode: { support: "adapter", adapter: "the OpenCode host: `abortSession()` on the lane's own server record", appliedBy: "lane" },
		claude: {
			support: "cannot",
			why: "Claude Code exposes no remote interrupt for a running background session: `claude attach` takes the terminal over and `claude stop` ends the session, and a hook fires only at a tool boundary, after the run it would interrupt",
			substitute: "send the lane a message (`muster send <lane> …`): the `muster-bus` hook injects it at the next tool boundary, and the lane itself decides to stop what it is doing",
		},
		hermes: {
			support: "cannot",
			why: "a Hermes lane runs no bus adapter and reads no control queue, so a queued abort would have no reader",
			substitute: "`muster send <lane> \"<text>\"`: the lane reads its inbox through the CLI and decides for itself",
		},
		unknown: NO_HARNESS,
	},
	stop: {
		pi: { support: "adapter", adapter: "`closeLane` (muster/lane-lifecycle.ts), the one stop owner: it queues `<state>/control/<lane>.json`, the lane's tick drains it and `ctx.shutdown()` ends the session cleanly (up to 60 s), then it kills the tmux window, removes the registry row and the Concord agent and closes the lane record. Nothing is signalled from outside unless the pane ignores its stop", appliedBy: "lane" },
		opencode: { support: "adapter", adapter: "`closeLane`: the same queue, the OpenCode host's own `shutdown()` stops its children, then the window, the registry row and the Concord agent are cleaned up", appliedBy: "lane" },
		claude: { support: "adapter", adapter: "`closeLane` runs `claude stop <short background id>` (resolved from `claude agents --json`, whatever the session's state) through `stopClaudeChecked` / `stopClaudeLane`, which removes the card only after the stop, then closes the lane record and the Concord agent. A registry it cannot read, or a stop the CLI refuses, changes nothing and keeps the card; only a registry that was read and does not list the lane lets the close remove the card without a stop (LC16 F10)", appliedBy: "claude-cli" },
		hermes: {
			support: "cannot",
			why: "nothing on a Hermes lane reads the control queue, and the bus never signals a lane it did not start",
			substitute: "stop the lane's own service (`systemctl --user stop <unit>`)",
		},
		unknown: NO_HARNESS,
	},
	setModel: {
		pi: { support: "adapter", adapter: "the lane-card adapter: `pi.setModel` then restore the thinking level", appliedBy: "lane" },
		opencode: { support: "adapter", adapter: "the OpenCode host: `POST /api/session/<id>/model`", appliedBy: "lane" },
		claude: {
			support: "cannot",
			why: "no verified remote model switch for a live Claude lane, and a `--resume` carrying flags starts a copy under a new id rather than switching the session (WP-B probe, 2026-10-12)",
			substitute: "a model change on a running Claude lane needs a new lane or the lane's own `/model`; to wake a stopped Claude lane use its one owner, `muster resume <lane>` (flagless, LD16), which keeps the session's saved model. A new lane's model id is in Claude's own catalog (`laneDefaults.claude` in provider-pool.json is the default), never a `provider/model` id",
		},
		hermes: {
			support: "cannot",
			why: "nothing on a Hermes lane applies a model switch, and the bus never writes one",
			substitute: "restart the lane's own service with the model you want",
		},
		unknown: NO_HARNESS,
	},
	launch: {
		pi: { support: "adapter", adapter: "`scripts/pi-lane-launch.sh --harness pi`: a tmux window resuming the lane's session" },
		opencode: { support: "adapter", adapter: "`scripts/pi-lane-launch.sh --harness opencode`: the lane host plus its attach pane" },
		claude: { support: "adapter", adapter: "`scripts/pi-lane-launch.sh --harness claude`: `claude --bg --name <lane> --model <id> --plugin-dir <muster-bus>`, which refuses a live name and loads the bus-agent hooks. With no `--model` the default is resolved from `laneDefaults.claude` in provider-pool.json; the id is in Claude's own catalog, not a `provider/model` id" },
		hermes: {
			support: "cannot",
			why: "`scripts/pi-lane-launch.sh` starts pi, opencode and claude lanes only; the bus does not start a Hermes lane (F17)",
			substitute: "start the Hermes lane's own service; `muster report --lane <lane>` then writes its card",
		},
		unknown: NO_HARNESS,
	},
	close: {
		pi: { support: "adapter", adapter: "`muster close <lane> --abandoned \"<reason>\" | --merged`: `closeLane` with a terminal outcome; `stop` is the same path closing as abandoned (`stopped by <caller>`)", appliedBy: "lane" },
		opencode: { support: "adapter", adapter: "`muster close`: `closeLane` with a terminal outcome, the same path as `stop`", appliedBy: "lane" },
		claude: { support: "adapter", adapter: "`muster close`: `closeLane` with a terminal outcome, the same path as `stop`", appliedBy: "claude-cli" },
		hermes: {
			support: "cannot",
			why: "`muster close` needs a lane the bus started, and nothing on a Hermes lane reads the control queue",
			substitute: "stop the lane's own service (`systemctl --user stop <unit>`)",
		},
		unknown: NO_HARNESS,
	},
	resume: {
		pi: {
			support: "cannot",
			why: "a parked Pi lane is relaunched by the launcher, which a message to it starts (`parkedLaneResume`), so `muster resume` has nothing to wake",
			substitute: "`muster send <lane> \"<text>\"` to a parked lane, or `scripts/pi-lane-launch.sh --lane <lane> --harness pi --resume-brief`",
		},
		opencode: {
			support: "cannot",
			why: "a parked OpenCode lane is relaunched by the launcher, which a message to it starts (`parkedLaneResume`), so `muster resume` has nothing to wake",
			substitute: "`muster send <lane> \"<text>\"` to a parked lane, or `scripts/pi-lane-launch.sh --lane <lane> --harness opencode --resume-brief`",
		},
		claude: { support: "adapter", adapter: "`muster resume <lane> [--message <text>]` (muster/cli/resume.ts, run by the orchestrator or the operator, never a gateway tool; LD16): `claude --bg --resume <full session id>` with no flags, which wakes the same job under the same ids (the one resume owner, in lib/claude-lane-card.ts). It refuses a session `sessionUntouchable` names (LD17: open it in the Claude app, or `claude attach <short id>`), refuses a session whose process is alive (the message is in its inbox), and holds a per-lane lease while it runs" },
		hermes: {
			support: "cannot",
			why: "a Hermes lane's session belongs to its own service: the bus has no resume command for it",
			substitute: "restart the Hermes service (`systemctl --user restart <unit>`), or wait for its next turn: `muster send <lane> \"<text>\"` leaves a message in its inbox",
		},
		unknown: NO_HARNESS,
	},
	"report-nudge": {
		pi: { support: "adapter", adapter: "the lane-card adapter's `agent_end` handler: a launched lane (CONCORD_AGENT_ID set, not the orchestrator) that ends a turn with no report since its session started gets the nudge once, as a follow-up user message, unless it is a `conversation` lane (LD14: a design or product session, `kind` on its lane record or the protected-lanes stop-gap) (muster/report-nudge.ts, lane-card-adapter.ts)" },
		opencode: {
			support: "cannot",
			why: "the OpenCode host sees `session.idle` (opencode-host.mjs) but files no report nudge there: LD7 builds the Pi and Claude turn-end hooks only",
			substitute: "muster-tick's 30-minute STALLED event for a lane that is alive, has no report and no turn",
		},
		claude: { support: "adapter", adapter: "the `Stop` branch of `muster claude-hook` (muster/cli/claude-hook.ts): a lane that ends a turn with no report since its last `SessionStart` (startup or resume) is blocked once with the nudge, in the same answer as any pending inbox message; `stop_hook_active` true never blocks, and a `conversation` lane (LD14) is never asked for a report. The same block asks an auto lane whose `muster wait --inbox` is not running to arm it (WP9)" },
		hermes: {
			support: "cannot",
			why: "no Hermes turn-end hook exists: LD7 builds the Pi and Claude hooks only",
			substitute: "muster-tick's 30-minute STALLED event for a lane that is alive, has no report and no turn",
		},
		unknown: NO_HARNESS,
	},
	"graph-nudge": {
		pi: { support: "adapter", adapter: "the `tool_call` hook in extensions/graphify-tools.ts: the first bash, grep or find call of a session that searches raw files runs `scripts/graph-nudge.sh --text` (lib/graph-refresh.ts `graphNudge`) and sends its text once as a steering message" },
		opencode: {
			support: "cannot",
			why: "the OpenCode host (opencode-host.mjs) has no tool-call interception, so nothing can run before a lane's first search",
			substitute: "the brief's `Graph:` line (plans/orchestration-2026-10-05/TEMPLATE.md) and the Codebase map paragraph in methodology.md",
		},
		claude: { support: "adapter", adapter: "the PreToolUse hook (matcher Bash) in the user's Claude Code settings runs `scripts/graph-nudge.sh` and prints its `hookSpecificOutput` once per session id; the script finds the main checkout's graph through `git rev-parse --git-common-dir`, so it works in every lane worktree" },
		hermes: {
			support: "cannot",
			why: "a Hermes lane runs no tool-call interception, so nothing can run before its first search",
			substitute: "the brief's `Graph:` line (plans/orchestration-2026-10-05/TEMPLATE.md) and the Codebase map paragraph in methodology.md",
		},
		unknown: NO_HARNESS,
	},
	card: {
		pi: { support: "adapter", adapter: "the heartbeat writes it every 15 s (lane-card-tick.ts)" },
		opencode: { support: "adapter", adapter: "the lane host writes it (opencode-host.mjs)" },
		claude: { support: "adapter", adapter: "the `muster-bus` heartbeat writes it at session start, each tool boundary and each stop (lib/claude-lane-card.ts → lane-card.ts); lib/lane-directory.ts overlays `claude agents --json` for liveness and lib/claude-lane-card.ts creates the file on first need" },
		hermes: {
			support: "cannot",
			why: "no heartbeat writes a Hermes card and the bus runs no Hermes lane lifecycle",
			substitute: "`muster report --lane <lane>` writes the card on its first use",
		},
		unknown: NO_HARNESS,
	},
};

/** One cell, with an unknown harness reading as the honest refusal. */
export function laneVerbCell(harness: LaneHarness, verb: LaneBusVerb): LaneVerbCell {
	return LANE_VERB_PARITY[verb][harness] ?? NO_HARNESS;
}

/**
 * What the CLI does with one control verb on one harness's card: queue it for
 * the lane's own host, run the harness's CLI itself, or refuse with the reason
 * and the stated substitute. This is the only place that decides, so no caller
 * keeps its own per-harness list.
 */
export type LaneControlDecision =
	| { allowed: true; applier: LaneControlApplier }
	| { allowed: false; reason: string; substitute: string };

/**
 * the operator's own sessions are read-only on the bus (LD2): every verb is refused for origin
 * `operator`, whatever the harness. The one wording, read by the CLI, the gateway's
 * `lane_control` and its `lane_send`.
 */
export function operatorSessionRefusal(origin: LaneOrigin | undefined): { allowed: false; reason: string; substitute: string } | undefined {
	if (origin !== "operator") return undefined;
	return {
		allowed: false,
		reason: "the operator's own session (LD2)",
		substitute: "none: a session the operator started is never stopped, messaged or controlled by the bus; ask the operator",
	};
}

export function laneControlDecision(harness: LaneHarness, operation: LaneControlOperation, origin?: LaneOrigin, untouchable?: string): LaneControlDecision {
	const refused = operatorSessionRefusal(origin);
	if (refused !== undefined) return refused;
	// LD17: a stop of an untouchable session (`sessionUntouchable`, passed by the caller as its detail) is refused here and again by `closeLane`.
	if (untouchable !== undefined && operation === "stop") {
		return { allowed: false, reason: untouchable, substitute: "none: the operator ends a conversation session, and the orchestrator then runs `muster close <lane> --end-conversation`" };
	}
	const cell = laneVerbCell(harness, operation);
	if (cell.support === "cannot") return { allowed: false, reason: cell.why, substitute: cell.substitute };
	return { allowed: true, applier: cell.support === "adapter" ? (cell.appliedBy ?? "lane") : "lane" };
}

/**
 * The model catalog of ONE harness (correction 5, 2026-10-09). The harnesses share no
 * routing table: `provider-pool.json` routes Pi sessions, delegates, memory and Muster
 * workers only, and the bus contract is only "the verb takes a model id valid for that
 * harness". So the validity check lives here, beside the parity table, and every caller
 * (the gateway, the CLI, `set-model`) reads it instead of keeping a model list of its own.
 *
 * An entry carries `paid`, so the recorded "no paid provider without the operator" rule stays a
 * policy check on the catalog entry rather than a second list of model names.
 */
export interface HarnessModelEntry {
	/** The model id or ref the harness accepts. */
	id: string;
	/** True when running it spends money; a free entry may be used by an automated lane. */
	paid: boolean;
	/**
	 * Pi only: whether the id is in the pool (a role chain, `freeRefs` or `laneDefaults`).
	 * Pi's own settings list models beside the pool, and the P5-D6 guard refuses an id
	 * only the settings name. Absent for the harnesses the pool does not route.
	 */
	fromPool?: boolean;
}

export type HarnessModelCatalog =
	| { ok: true; harness: "pi" | "opencode" | "claude"; models: HarnessModelEntry[] }
	| { ok: false; harness: LaneHarness; reason: string };

export interface HarnessCatalogDeps {
	/** Path to `provider-pool.json`; defaults to the standard location. */
	poolPath?: string;
	/** Pi: model ids enabled in Pi's own settings, merged with the pool refs. */
	piSettingsModels?: string[];
	/** OpenCode: the output of `opencode models` for the lane host, already read by the caller. */
	opencodeModelsOutput?: string;
}

/** A ref or id whose own name says it is free (the pool's free-ref convention, `-free` or `:free`). */
function looksFree(id: string): boolean {
	return /(^|[/:-])free(-|$)/i.test(id) || /:free$/i.test(id);
}

/**
 * Read one harness's catalog. Claude is not in the pool at all (its catalog is the CLI's own
 * aliases plus any full `claude-*` id). OpenCode comes from the lane host's own `opencode models`
 * output; when that cannot be read the catalog is a refusal naming why, never a guess. Pi comes
 * from every ref in every role chain, the lane defaults, and the models Pi's own settings enable.
 */
export function harnessModelCatalog(harness: LaneHarness, deps: HarnessCatalogDeps = {}): HarnessModelCatalog {
	if (harness === "claude") {
		return { ok: true, harness: "claude", models: ["haiku", "sonnet", "opus"].map((id) => ({ id, paid: true })) };
	}
	if (harness === "opencode") {
		if (deps.opencodeModelsOutput === undefined) {
			return { ok: false, harness, reason: "the OpenCode model list could not be read (`opencode models` gave no output); a model is never guessed" };
		}
		const models = deps.opencodeModelsOutput
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((id) => ({ id, paid: !looksFree(id) }));
		if (models.length === 0) return { ok: false, harness, reason: "`opencode models` listed no models for this host" };
		return { ok: true, harness, models };
	}
	if (harness === "hermes") return { ok: false, harness, reason: "the bus never launches or retunes a Hermes lane (F17), so no model catalog applies" };
	if (harness !== "pi") return { ok: false, harness, reason: "the card names no harness, so no catalog applies" };
	const loaded = loadPoolConfig(deps.poolPath);
	if (!loaded.ok) return { ok: false, harness, reason: `provider-pool.json could not be read: ${loaded.errors.join("; ")}` };
	const ids = new Set<string>();
	for (const chain of Object.values(loaded.config.roles)) for (const ref of chain) ids.add(ref);
	const defaults = loaded.config.laneDefaults;
	if (defaults) {
		for (const ref of defaults.pi.candidates) ids.add(ref);
		// The hard tier (VR19-51, H1-H5) is explicit-only: no default walks it, but a lane launched with --model on it is in the pool.
		for (const ref of defaults.pi.hard ?? []) ids.add(ref);
		for (const ref of defaults.opencode) ids.add(ref);
		if (defaults.claude) ids.add(defaults.claude);
	}
	// The pool is the only place work goes (P5-D6): a model Pi's own settings enable is listed
	// and refused unless a pool role, a freeRefs entry or a laneDefaults candidate also names it.
	const pool = new Set(ids);
	for (const id of deps.piSettingsModels ?? []) ids.add(id);
	const free = new Set(loaded.config.freeRefs);
	const models = [...ids].sort().map((id) => ({ id, paid: !free.has(id), fromPool: pool.has(id) }));
	return { ok: true, harness: "pi", models };
}

/** The one validity check callers use: is this model id valid for this harness's own catalog? */
export function harnessAcceptsModel(catalog: HarnessModelCatalog, id: string): boolean {
	if (!catalog.ok) return false;
	// Claude accepts the aliases in its catalog and any full claude-* id the CLI defines.
	if (catalog.harness === "claude" && /^claude-[a-z0-9.-]+$/i.test(id)) return true;
	const entry = catalog.models.find((candidate) => candidate.id === id);
	if (entry === undefined) return false;
	// P5-D6: a Pi model outside the pool is refused, full stop, with no override.
	if (catalog.harness === "pi") return entry.fromPool !== false;
	return true;
}

/**
 * P5-D6: the one guard on an explicit model, so a launch from the gateway, from the CLI
 * and from the shell refuses it the same way. Returns the refusal, or undefined when the
 * model is admitted. The Claude harness keeps its own alias catalog: an alias runs on the
 * Claude Max subscription and is never treated as the metered `anthropic` provider.
 */
export function harnessModelRefusal(catalog: HarnessModelCatalog, id: string): string | undefined {
	if (!catalog.ok) return catalog.reason;
	if (!harnessAcceptsModel(catalog, id)) {
		const entry = catalog.models.find((candidate) => candidate.id === id);
		if (catalog.harness === "pi" && entry !== undefined) {
			return `model ${id} is outside provider-pool.json (no role chain, freeRefs entry or laneDefaults candidate names it): the pool is the only place work goes (P5-D6)`;
		}
		return `model ${id} is not in the ${catalog.harness} catalog`;
	}
	if (catalog.harness === "opencode" && harnessModelPaid(catalog, id)) {
		return `model ${id} is paid and OpenCode lanes run free models only; no paid provider without the operator`;
	}
	return undefined;
}

/** Whether one accepted model id spends money; a full `claude-*` id is paid. */
export function harnessModelPaid(catalog: HarnessModelCatalog, id: string): boolean {
	if (!catalog.ok) return false;
	const entry = catalog.models.find((candidate) => candidate.id === id);
	if (entry) return entry.paid;
	return catalog.harness === "claude";
}

/**
 * Take the lane's pending request, if any: read it and remove it in the same
 * call, so a lane can never apply the same abort or model switch twice. A
 * malformed file is dropped rather than retried forever.
 */
export function takeLaneControl(musterStateDir: string, laneId: string): LaneControlRequest | undefined {
	if (readBackend(musterStateDir) === "ledger") {
		const store = ledgerControlStore(musterStateDir);
		const current = store.readWithRevision(laneId);
		if (current === undefined) return undefined;
		const { revision: _revision, ...request } = current.record;
		// Read and remove in one compare-and-set: a second reader that read the same
		// revision loses the commit and answers absent, exactly as the file's unlink race does.
		const result = ledgerCommit(ownerLedgerSocket(musterStateDir), {
			requestId: `take:${LANE_CONTROL_STORE}:${laneId}:${current.revision}`,
			cas: [{ store: LANE_CONTROL_STORE, id: laneId, expectedRevision: current.revision, record: null }],
		});
		return result.ok ? request : undefined;
	}
	const file = laneControlFile(musterStateDir, laneId);
	if (!existsSync(file)) return undefined;
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	try {
		unlinkSync(file);
	} catch {
		/* another reader took it first */
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as LaneControlRequest;
		if (typeof parsed?.laneId !== "string" || !(LANE_CONTROL_OPERATIONS as readonly string[]).includes(String(parsed?.operation))) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}
