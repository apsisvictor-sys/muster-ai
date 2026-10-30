#!/usr/bin/env node
/**
 * lane-model.mjs — the launcher's read of the per-harness lane model defaults.
 *
 * A thin CLI over extensions/lib/provider-pool.ts (`resolveLaneModel`, the one
 * owner of the pool, its wall logic and the P5-D1 O1 ranking rule) and over
 * `harnessModelRefusal` (lib/lane-control.ts, the one owner of what a harness
 * accepts). The launcher calls it for every lane start: with no `--model` the
 * harness default is resolved, and with `--model` the operator's choice is
 * checked against the harness's own catalog before the lane starts — a Pi model
 * outside the pool is refused, with no override (P5-D6).
 *
 *   node lane-model.mjs --harness pi|opencode|claude --agent-dir <dir> [--lane <id>] [--explicit <model>] [--task-kind <kind>] [--class <flash|H1..H5>] [--json]
 *
 * Prints one JSON object on stdout:
 *   { model, source, skipped: [{ ref, reason }], reason, note, warning? }
 * `note` is the one-line human explanation the launcher logs. `warning` is set only for an
 * explicit model whose provider has an active quota wall: "walled at launch, until <time>".
 * It never changes the exit code or the choice (P5-D6 keeps an explicit model the
 * orchestrator's); the launcher prints it and copies it to the lane record. Exit 0 when a
 * model is available, 1 when none is or an explicit one is refused, 2 on a bad
 * invocation or an unreadable pool. The pool, learned walls, the usage snapshot
 * and the routing decisions log are all read under `--agent-dir`, so a lane is
 * resolved against the installation it will run in. The choice is written to that
 * log by this helper itself, under plain node (see `logDecision`).
 */
// RS1 (S8): the credentials port must be configured before `provider-key.ts` reads a provider's env names, which is
// VR24-213's presence test for a candidate. This file still runs under plain node (no tsx): both modules load with
// Node's own type stripping, and the port's configuration is the only thing that waits.
import { defaultAgentDir } from "../core/pi-ports-profile.ts";
import { childImportArgs, tsxLoaderPath } from "../core/harness-paths.ts";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFsyncedLine } from "../core/append-line.ts";
import { harnessModelCatalog, harnessModelRefusal } from "./lib/lane-control.ts";
import { listLaneCards } from "./lib/lane-card.ts";
import { accountWallKey, activeWalls, freshRoutingSnapshot, isTaskKind, laneAccountFor, loadPoolConfig, placeLaneModel, providerOf, rankLaneRoutes, readRoutingSnapshot, recordSnapshotWalls, resolveLaneModel, routeDecisionLine, routingDecisionsTarget, TASK_KINDS } from "../routing/provider-pool.ts";
import { jevFallbackLine, jevModeDir, jevProgramPath, readJevMode } from "../routing/jev-shadow.ts";
import { chooseLaunchAccount, readFailingAccounts } from "../routing/launch-account.ts";
import { accountConfigured } from "../routing/provider-key.ts";
import { readPiSettingsModels } from "./gateway/catalog.ts";

const USAGE = `usage: lane-model.mjs --harness pi|opencode|claude [--agent-dir <dir>] [--lane <id>] [--explicit <model>] [--task-kind <kind>] [--class <flash|H1..H5>] [--json]`;

const HARNESSES = ["pi", "opencode", "claude"];

/**
 * The Jev step's own program, and the loader that runs it. Plain node cannot load the owners the step calls
 * (`jev-choice.ts` and the telemetry owner), so the launcher runs the step in a child process under tsx and reads
 * its answer as JSON. The program names its own path (`jevProgramPath()`), so no caller derives one for it.
 */
const JEV_MODULE = jevProgramPath();
const TSX_LOADER = tsxLoaderPath();

function fail(message, code) {
	process.stderr.write(`lane-model: ${message}\n`);
	process.exit(code);
}

const args = { harness: "", agentDir: "", explicit: "", lane: "", taskKind: "", class: "", json: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	const flag = argv[i];
	if (flag === "--harness") args.harness = argv[++i] ?? "";
	else if (flag === "--agent-dir") args.agentDir = argv[++i] ?? "";
	else if (flag === "--lane") args.lane = argv[++i] ?? "";
	else if (flag === "--task-kind") args.taskKind = argv[++i] ?? "";
	else if (flag === "--class") args.class = argv[++i] ?? "";
	else if (flag === "--explicit") args.explicit = argv[++i] ?? "";
	else if (flag === "--json") args.json = true;
	else if (flag === "-h" || flag === "--help") { process.stdout.write(`${USAGE}\n`); process.exit(0); }
	else fail(`unknown argument: ${flag}\n${USAGE}`, 2);
}
if (!HARNESSES.includes(args.harness)) fail(`--harness must be one of ${HARNESSES.join(", ")}\n${USAGE}`, 2);
// A kind or a class nobody put in the vocabulary is refused, never quietly ignored: a typo would otherwise be
// logged as a lane that has no kind, and the placement would read as if no kind had been given.
if (args.taskKind && !isTaskKind(args.taskKind)) fail(`--task-kind must be one of ${TASK_KINDS.join(", ")}\n${USAGE}`, 2);
if (args.class && !(args.class === "flash" || args.class === "exception" || /^H[1-5]$/.test(args.class))) fail(`--class must be flash, H1 to H5 or exception\n${USAGE}`, 2);

/** The installation this lane will run in: `--agent-dir` is authoritative when given. */
const agentDir = args.agentDir || defaultAgentDir();
/** The Muster state root this installation's lane cards sit under: `PI_MUSTER_STATE_DIR`, else its own state dir. */
const musterState = process.env.PI_MUSTER_STATE_DIR?.trim() || join(agentDir, "state", "muster");
if (args.agentDir) {
	process.env.PI_PROVIDER_WALLS_PATH = join(args.agentDir, "state", "provider-walls.json");
	if (!process.env.PI_USAGE_SNAPSHOT_PATH) process.env.PI_USAGE_SNAPSHOT_PATH = join(args.agentDir, "state", "usage", "snapshot.json");
	if (!process.env.PI_ROUTING_DECISIONS_PATH) process.env.PI_ROUTING_DECISIONS_PATH = join(args.agentDir, "state", "routing", "decisions.jsonl");
}
const poolPath = args.agentDir && !process.env.PI_PROVIDER_POOL_PATH ? join(args.agentDir, "provider-pool.json") : undefined;

/** The OpenCode host's own model list, read only for an explicit OpenCode model. A failed read is undefined, never a guess. */
function readOpencodeModels() {
	const bin = process.env.OPENCODE_BIN?.trim() || "opencode";
	const result = spawnSync(bin, ["models"], { encoding: "utf8", timeout: 20_000 });
	return result.status === 0 && (result.stdout ?? "").trim() !== "" ? result.stdout : undefined;
}

const loaded = loadPoolConfig(poolPath);
if (!loaded.ok) fail(loaded.errors.join("; "), 2);

// P5-D6: an explicit model is checked against the harness's own catalog, exactly as the
// gateway's lane_launch and set-model do. A refusal is the answer of this helper, so the
// launcher stops with the note instead of starting a lane on a model nobody put in the pool.
if (args.explicit) {
	const catalog = harnessModelCatalog(args.harness, {
		...(poolPath ? { poolPath } : {}),
		...(args.harness === "pi" ? { piSettingsModels: readPiSettingsModels(join(agentDir, "settings.json")) } : {}),
		...(args.harness === "opencode" ? { opencodeModelsOutput: readOpencodeModels() } : {}),
	});
	const refusal = harnessModelRefusal(catalog, args.explicit);
	if (refusal !== undefined) {
		const payload = { model: null, source: "explicit", skipped: [], reason: refusal, note: refusal };
		if (args.json) process.stdout.write(`${JSON.stringify(payload)}\n`);
		else process.stderr.write(`${refusal}\n`);
		process.exit(1);
	}
}

/**
 * A window of a day or more at 100 percent keeps its provider out until it resets (blueprint 4.2, AR2).
 * The snapshot is read for the walls at any age, because going stale never lifts a known exhaustion
 * (G3) while a later reading below 100 percent does, and the pool is re-read so this launch ranks
 * against the walls that now exist. A failed write is reported, never fatal: a lane that resolves
 * still starts.
 */
const observed = readRoutingSnapshot();
if (observed) {
	try {
		recordSnapshotWalls(observed, loaded.config, Date.now());
		const refreshed = loadPoolConfig(poolPath);
		if (refreshed.ok) loaded.config = refreshed.config;
	} catch (error) {
		process.stderr.write(`lane-model: the usage snapshot was not recorded: ${error instanceof Error ? error.message : String(error)}\n`);
	}
}

const resolution = resolveLaneModel(loaded.config, {
	harness: args.harness,
	now: Date.now(),
	explicit: args.explicit || undefined,
});

/** The one-line reason the launcher prints: which harness default ran and what it skipped. */
function noteFor(result) {
	if (!result.model) return `no ${args.harness} model available: ${result.reason}`;
	const skipped = result.skipped.map((skip) => `${skip.ref} (${skip.reason})`).join(", ");
	const source =
		result.source === "explicit" ? "named on the command line"
		: result.source === "fallback" ? `fallback through the pool's "${loaded.config.laneDefaults?.pi.fallbackRole ?? "?"}" role`
		: `${args.harness} default`;
	return skipped ? `${source}; skipped ${skipped}` : source;
}

/** `2026-10-25T05:03:35Z (07:03 EET)`: the wall's `until` in UTC with the Sofia reading (EET or EEST by the date). */
function untilText(until) {
	const utc = new Date(until).toISOString().replace(/\.\d+Z$/, "Z");
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Sofia", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
			.formatToParts(new Date(until)).map((part) => [part.type, part.value]),
	);
	const sofiaAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
	const offsetHours = Math.round((sofiaAsUtc - Math.floor(until / 60_000) * 60_000) / 3_600_000);
	return `${utc} (${parts.hour}:${parts.minute} ${offsetHours === 3 ? "EEST" : "EET"})`;
}

/**
 * The warning for an explicit model whose provider is walled right now, else undefined. It reads
 * the same walls `logDecision` ranks against (`activeWalls`, keyed through `accountWallKey`), so a
 * wall on another account's key does not warn. A free ref walls alone and a provider wall covers
 * every ref of the provider, the two keys `resolveLaneModel` honours for OpenCode.
 */
function wallWarningFor(model, now) {
	const walls = activeWalls(loaded.config, undefined, now);
	const wall = walls[accountWallKey(loaded.config, model)] ?? walls[accountWallKey(loaded.config, providerOf(model))];
	return wall ? `walled at launch, until ${untilText(wall.until)}` : undefined;
}

/**
 * The running list both doors hand the placement (N4 of the AR6 review): every lane card up right now that
 * names a model, read through the cards' own owner, which serves the file and the ledger backend alike.
 * `muster route pick` applies the same projection to the directory's rows, so the spread step and the two caps
 * read the same facts at either door. A store that cannot be read is no running list and never fatal: the launch
 * then reads the spread and the caps as unconstrained, exactly as it did before this call existed.
 */
function runningLanes() {
	try {
		return listLaneCards(musterState)
			.map((entry) => entry.card)
			.filter((card) => card.state !== "gone" && card.model !== null)
			.map((card) => ({ ref: card.model }));
	} catch {
		return [];
	}
}

/**
 * Append one decision line through the one append body, the same one the log's own writer uses. A failed record is
 * reported, never fatal: a lane that resolves still starts.
 */
function appendLine(entry) {
	const target = routingDecisionsTarget();
	try {
		appendFsyncedLine(target.stateDir, target.fileName, routeDecisionLine(entry));
	} catch (error) {
		process.stderr.write(`lane-model: the routing decision was not logged: ${error instanceof Error ? error.message : String(error)}\n`);
	}
}

/**
 * Record the choice in the routing decisions log, the one record `muster route` reads back.
 * The append goes through the one append body, `appendFsyncedLine`
 * (extensions/lib/core/append-line.ts), which loads under plain node: its import graph is
 * `node:fs` and `node:path` only, since the body moved out of `muster/send.ts`, whose own
 * graph is not plain-node loadable (`inbox-attachments.ts` uses a constructor parameter
 * property). So the helper writes the line itself, with no tsx subprocess to boot and no
 * second writer; the pool library owns the line's shape and its path. A failed record is
 * reported, never fatal: a lane that resolves still starts.
 */
function logDecision(result, extra = {}) {
	const now = Date.now();
	const snapshot = freshRoutingSnapshot(now);
	const defaults = loaded.config.laneDefaults;
	const refs = args.harness === "pi" ? defaults?.pi.candidates ?? [] : args.harness === "opencode" ? defaults?.opencode ?? [] : [result.model];
	const entry = {
		at: now,
		...(args.lane ? { lane: args.lane } : {}),
		...(args.harness === "pi" && defaults?.pi.fallbackRole ? { role: defaults.pi.fallbackRole } : {}),
		chosen: extra.chosen ?? result.model ?? "",
		by: extra.by ?? (result.source === "explicit" ? "orchestrator" : "rule"),
		// What the lane does and as which class, when the launcher knows it: the decision line
		// carries them, so a closed lane can say it without a second record.
		...(args.taskKind ? { taskKind: args.taskKind } : {}),
		...(args.class ? { class: args.class } : {}),
		candidates: extra.candidates ?? rankLaneRoutes({
			config: loaded.config,
			candidates: refs,
			walls: activeWalls(loaded.config, undefined, now),
			available: () => true,
			now,
			...(snapshot ? { snapshot } : {}),
			freeRefsLast: args.harness !== "pi",
		}),
		...(snapshot ? { snapshotAt: snapshot.capturedAt } : {}),
		...(extra.until === undefined ? {} : { until: extra.until }),
		...(extra.shadow ? { shadow: true } : {}),
		// AR14 design 5: the account the rule would pick, and the account this lane actually runs on. Shadow first, so
		// the two sit beside each other on the line and a reader compares them instead of assuming the pick applied.
		...(extra.account === undefined ? {} : { account: extra.account }),
		...(extra.laneAccount === undefined ? {} : { laneAccount: extra.laneAccount }),
		...(extra.reason ?? result.reason ? { reason: extra.reason ?? result.reason } : {}),
	};
	appendLine(entry);
}

/**
 * The Jev step's answer for this placement, or undefined when the mode is off. The step is a child process
 * (`packages/routing/jev-shadow.ts` under tsx): it reads the placement and the pool as JSON and answers with the
 * line to write and the ref Jev chose. A child that does not answer leaves the rule's pick standing, and its
 * reason on a line of its own.
 */
function jevAnswer(placement) {
	const mode = readJevMode(jevModeDir());
	if (mode === "off") return undefined;
	const request = { placement, pool: loaded.config, caller: "lane-model", mode, ...(args.lane ? { lane: args.lane } : {}) };
	const child = spawnSync(process.execPath, [...childImportArgs(), JEV_MODULE], {
		input: JSON.stringify(request),
		encoding: "utf8",
		timeout: 60_000,
		env: process.env,
	});
	let result;
	try {
		result = JSON.parse(child.stdout ?? "");
	} catch {
		result = undefined;
	}
	if (result === undefined) {
		const why = child.error !== undefined
			? child.error.message
			: child.signal
				? `the child was stopped by ${child.signal}`
				: child.status === null
					? "the child wrote nothing"
					: `the child exited with ${child.status}`;
		return { mode, failed: `the Jev step did not answer: ${why}` };
	}
	return result;
}

/**
 * What the table would do with this launch (blueprint 4.5, AR6). No kind, `pick: off` and an explicit model all
 * leave it `off`, and then this helper's answer is exactly what it was before AR6. The running list is read
 * beside it (`runningLanes`), so this door counts the same facts `muster route pick` counts: the spread step,
 * the Claude cap and the hard cap (N4 of the AR6 review).
 */
const placement = placeLaneModel(loaded.config, {
	harness: args.harness,
	now: Date.now(),
	...(args.explicit ? { explicit: args.explicit } : {}),
	...(args.taskKind ? { kind: args.taskKind } : {}),
	...(args.class ? { class: args.class } : {}),
	// VR24-213: a candidate whose key name is absent from this lane's would-be environment is never started.
	configured: (ref, account) => accountConfigured(providerOf(ref), account),
	running: runningLanes(),
});
const pickMode = loaded.config.routing?.pick ?? "off";
// `on`: the table's placement is the launch. `shadow`: the same answer is written beside the real placement and
// the launch is untouched (blueprint 4.7). `off`: nothing is written and nothing changes.
const placedByTable = pickMode === "on" && placement.status === "placed";
const waiting = pickMode === "on" && placement.status === "wait";
const shadowed = pickMode === "shadow" && placement.status !== "off";

// AR15: the Jev step, for a lane that names no model. Code has placed the lane and built the candidate set; Jev is
// asked inside that set, and in shadow its answer is recorded beside the rule's pick, which is what the launch uses.
// A lane that names a model is untouched: the operator's choice is the placement, so there is nothing to ask about.
const jev = args.explicit === "" && placement.status === "placed" ? jevAnswer(placement) : undefined;
const jevRef = jev?.mode === "on" && jev?.jev?.accepted === true ? jev.jev.choice : undefined;

const model = jevRef ?? (placedByTable ? placement.ref : resolution.model);
/**
 * CCACCT2 (the operator 2026-10-27, relayed by Henry 04:22 EET): the account the lane starts on. The launch used to land on
 * whichever account Pi's own key name belongs to — the first one — so a new lane stayed walled when that account had
 * no credits while the other was free (04:2x: a launch walled within 40 s on account 1 while account 2 answered).
 *
 * `chooseLaunchAccount` reads the inventory's accounts, the walls in force and account-health's current hour, and
 * answers with the account to start on, or with another ref when no account of the planned plan can take the lane.
 * The answer goes on the decision line below; the lane's key itself comes from `models.json`, whose routed name is that
 * account's own, so nothing here sets a variable.
 */
const choiceNow = Date.now();
const choiceSnapshot = freshRoutingSnapshot(choiceNow);
const accountChoice = args.harness === "pi" && model !== undefined
	? chooseLaunchAccount({
		config: loaded.config,
		ref: model,
		walls: activeWalls(loaded.config, undefined, choiceNow),
		now: choiceNow,
		...(choiceSnapshot ? { snapshot: choiceSnapshot } : {}),
		configured: (ref, account) => accountConfigured(providerOf(ref), account),
		failing: readFailingAccounts(musterState, choiceNow),
		// Another owner already ranked the plan's accounts (the placement's allowance rule, AR14): this module only says
		// whether that account can start, so the two doors never place different accounts for the same lane. The ref it
		// was answered for travels with it, so the module can refuse a label from another provider's plan.
		...(placement.status === "placed" && placement.account !== undefined
			? { preferred: placement.account, preferredRef: placement.ref }
			: {}),
	})
	: undefined;
/** The ref the launch uses: the choice's own when every account of the planned plan was out, else the planned one. */
const launchModel = accountChoice?.ref ?? model;
/** A plan held once needs no account line: the note stays exactly what it was before CCACCT2. */
const accountNote = accountChoice === undefined || (accountChoice.account === undefined && !accountChoice.fellBack) ? "" : `; ${accountChoice.reason}`;
const placedLine = {
	chosen: jevRef ?? placement.ref,
	by: "rule",
	candidates: placement.candidates,
	reason: jevRef === undefined ? placement.reason : `Jev chose ${jevRef}: ${jev?.jev?.reason ?? "the deciding fact"}`,
	...(placement.until === undefined ? {} : { until: placement.until }),
	...(placement.account === undefined ? {} : { account: placement.account }),
};
/** The account the launch applies: the choice's answer, else whatever this process was already placed on (AR14). */
const laneAccount = accountChoice?.account ?? laneAccountFor(launchModel ?? placement.ref ?? resolution.model ?? "");
/**
 * The choice's own reason, when it has one to give: an account it names, or a move it made. A plan held once is left
 * out, because its answer says nothing about why the stage chose this model.
 */
const laneAccountReason = accountChoice === undefined || (accountChoice.account === undefined && !accountChoice.fellBack) ? undefined : accountChoice.reason;
/**
 * The applied account on the line. A placed line keeps `account` as the rule's own answer, so a reader compares the two
 * (AR14), and adds `laneAccount`; a line the rule did not place has no rule answer, so there `account` is this one.
 */
const laneAccountLine = laneAccount === undefined ? {} : placedByTable ? { laneAccount } : { account: laneAccount, laneAccount };
/** A shadow line keeps the rule's own answer under `account`, so only the applied half travels on it. */
const shadowAccountLine = laneAccount === undefined ? {} : { laneAccount };

// One line for the real placement, and in shadow one more with `shadow: true` that is never counted as a
// placement (blueprint 4.6). A wait starts nothing, so it writes only its own line, with no ref and the
// earliest return in `until`.
if (launchModel && !waiting) {
	logDecision(
		resolution,
		placedByTable
			// The rule placed this lane, but the launch may have moved off its ref: the line names the ref the lane runs and
			// says why it moved, while `account` stays the rule's answer beside the applied `laneAccount`.
			? { ...placedLine, chosen: launchModel, ...(accountChoice?.fellBack === true && laneAccountReason !== undefined ? { reason: laneAccountReason } : {}), ...laneAccountLine }
			: { chosen: launchModel, ...(laneAccountReason === undefined ? {} : { reason: laneAccountReason }), ...laneAccountLine },
	);
}
if (shadowed) logDecision(resolution, { ...placedLine, chosen: placement.ref ?? "", shadow: true, ...shadowAccountLine });
if (waiting) logDecision(resolution, { ...placedLine, chosen: "", reason: placement.reason });
// AR15: the shadow line — the rule's placement with Jev's answer beside it, never a placement itself. A step that
// did not answer leaves its reason on a line of its own, so the log says why the shadow data is missing.
if (jev?.line !== undefined) appendLine(jev.line);
else if (jev?.failed !== undefined) appendLine(jevFallbackLine({ placement, reason: jev.failed, ...(args.lane ? { lane: args.lane } : {}) }));
if (jev?.failed !== undefined) process.stderr.write(`lane-model: ${jev.failed}\n`);
else if (jev?.jev !== undefined && jev.jev.accepted === false) {
	process.stderr.write(`lane-model: Jev's answer was not used: ${jev.jev.reason ?? jev.jev.fallback ?? "no reason given"}\n`);
}

const warning = launchModel && resolution.source === "explicit" ? wallWarningFor(launchModel, Date.now()) : undefined;

const payload = {
	model: launchModel ?? null,
	source: resolution.source,
	skipped: resolution.skipped,
	reason: (accountChoice?.fellBack === true ? accountChoice.reason : placedByTable ? placement.reason : resolution.reason) ?? null,
	note: (jevRef === undefined
		? (placedByTable ? `routing.policy.${args.taskKind}: ${placement.reason}` : noteFor(resolution))
		: `Jev chose ${jevRef}: ${jev?.jev?.reason ?? "the deciding fact"}`) + accountNote,
	...(placement.status === "placed" && placement.account !== undefined ? { account: placement.account } : {}),
	...laneAccountLine,
	...(jev?.jev === undefined ? {} : { jev: jev.jev }),
	...(warning ? { warning } : {}),
};

if (waiting) {
	process.stderr.write(`lane-model: nothing may start now: ${placement.reason}${
		placement.until === undefined ? ", and no candidate names a return time" : `; earliest return ${untilText(placement.until)}`
	}\n`);
	process.exit(1);
}

if (args.json) {
	process.stdout.write(`${JSON.stringify(payload)}\n`);
} else if (launchModel) {
	process.stdout.write(`${launchModel}\n${payload.note}\n`);
	if (warning) process.stderr.write(`lane-model: warning: ${launchModel} ${warning}\n`);
} else {
	process.stderr.write(`${payload.note}\n`);
}
process.exit(launchModel ? 0 : 1);
