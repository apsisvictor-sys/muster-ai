/**
 * The goal registry (command center blueprint r5, D1): what the operator's team is working toward, as a
 * metro line of stations with the lanes that work on them.
 *
 * One record per goal, stored under its two-letter code. The ledger holds it while the ledger is
 * live (`GOAL_STORE`), the files store under `<muster state>/goals/` otherwise, switched the way
 * `programmeControlStore` switches (`control.ts`). The store, its record shape and its writers are
 * the recorded decision D1, so adding them is not an undecided data-shape change.
 *
 * Every write reads the goal, builds the next record, and hands it to the store's compare-and-set
 * `update` with the revision it read. It never uses `put`, which keeps the last writer and would
 * drop an event another writer appended. A write that lost the race is refused with the store's
 * conflict error and changes nothing, and the writer runs the verb again.
 *
 * The writer is the process (`resolveGoalWriter`, one rule with the ask queue): the operator's shell, the
 * architect or the orchestrator. A lane is refused. The gateway has no goal writer.
 *
 * The current station is the first one not finished. It is derived and never stored, because
 * stations finish in any order (a goal can have lanes on two stations side by side).
 */

import { musterStateDir, validateAgentId } from "./binding.ts";
import { readBackend } from "./ledger/backend.ts";
import { ledgerCasStore, type LedgerCasStore } from "./ledger/cas-store.ts";
import { GOAL_STORE, ownerLedgerSocket } from "./ledger/stores.ts";
import { fileCasStore, type CasStore } from "./owner-fence.ts";
import { readProjectCatalogue } from "./projects.ts";
import { resolveSeatWriter, type SeatContext, type SeatRole } from "./seats.ts";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export const GOAL_SCHEMA_VERSION = 1 as const;

/**
 * The line colours a goal may take: the mockup's eight plus `cyan` (R7 D29: nine goals open, nine
 * keys). Red is never one: red means "needs you" (D7). The page checks its colour map against this
 * constant (WP1b), and the library maps each key to a muted tint (D29).
 */
export const GOAL_COLOURS = ["blue", "green", "violet", "orange", "teal", "gold", "brown", "magenta", "cyan"] as const;
export type GoalColour = (typeof GOAL_COLOURS)[number];

export const GOAL_STATUSES = ["open", "done", "dropped"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
/** What `close` records: the two ways a goal ends. */
export const GOAL_OUTCOMES = ["done", "dropped"] as const satisfies readonly GoalStatus[];

/** Station owners that are not a lane id. */
export const STATION_OWNER_ROLES = ["architect", "orchestrator", "operator", "henry"] as const;

export const GOAL_VERBS = ["add", "station", "colour", "attach", "detach", "finish", "reopen", "wait", "unwait", "close"] as const;
export type GoalVerb = (typeof GOAL_VERBS)[number];

/** Who wrote an event: the operator's shell, or the seat whose credential the process holds. */
export type GoalWriter = "operator-shell" | SeatRole;
const GOAL_WRITERS: readonly string[] = ["operator-shell", "architect", "orchestrator"];

export const GOAL_CODE_PATTERN = /^[A-Z]{2}$/;
const STATION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** A systemd user timer unit name. */
const TIMER_PATTERN = /^[A-Za-z0-9:_.@-]+\.timer$/;
/** An ask id, as `raiseAsk` mints it (`ask_<uuid>`). */
const ASK_ID_PATTERN = /^ask_[0-9A-Za-z-]{4,64}$/;

export type GoalStation = {
	id: string;
	name: string;
	/** architect, orchestrator, operator, henry, or a lane id. */
	owner?: string;
	/** A systemd user timer unit that starts this station on its own (D3). */
	timer?: string;
	finishedAt?: string;
};

/** A lane id or a seat role (a seat role resolves to its holder at read time), and the station it works on. */
export type GoalLane = { lane: string; station: string };

export type GoalEvent = { at: string; by: GoalWriter; verb: GoalVerb; detail: string };

export type GoalRecord = {
	schemaVersion: typeof GOAL_SCHEMA_VERSION;
	revision: number;
	code: string;
	name: string;
	sub: string;
	/** A register `projectId`, checked at write time. */
	project: string;
	colour: GoalColour;
	stations: GoalStation[];
	lanes: GoalLane[];
	/** Ask ids: the one structured link from a goal to the operator's asks. */
	waitsOn: string[];
	status: GoalStatus;
	closedAt?: string;
	events: GoalEvent[];
};

export class GoalStateError extends Error {
	constructor(
		readonly code: "missing" | "malformed" | "conflict" | "io" | "invalid",
		message: string,
	) {
		super(message);
		this.name = "GoalStateError";
	}
}

// ─── Validation of a stored record ───────────────────────────────────────────

const RECORD_KEYS = new Set(["schemaVersion", "revision", "code", "name", "sub", "project", "colour", "stations", "lanes", "waitsOn", "status", "closedAt", "events"]);
const STATION_KEYS = new Set(["id", "name", "owner", "timer", "finishedAt"]);

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const oneLine = (value: string): boolean => !/[\u0000-\u001f\u007f\u2028\u2029]/.test(value);
const nonEmptyLine = (value: unknown): value is string => typeof value === "string" && value.trim() !== "" && oneLine(value);
const isTime = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const isStationOwner = (value: string): boolean => (STATION_OWNER_ROLES as readonly string[]).includes(value) || validateAgentId(value) === value;

/**
 * A stored record fails closed: an unknown field or any structural deviation is `malformed`, and the
 * store never resets it. Whether the project is in the register is a write-time check and not part of
 * the record, so a project removed later does not make a goal unreadable.
 */
export function validateGoalRecord(input: unknown): { ok: true; record: GoalRecord } | { ok: false; errors: string[] } {
	if (!isObject(input)) return { ok: false, errors: ["record must be an object"] };
	const errors: string[] = [];
	const extra = Object.keys(input).filter((key) => !RECORD_KEYS.has(key));
	if (extra.length > 0) errors.push(`record has unknown fields: ${extra.join(", ")}`);
	if (input["schemaVersion"] !== GOAL_SCHEMA_VERSION) errors.push("record.schemaVersion must be 1");
	if (!Number.isInteger(input["revision"]) || (input["revision"] as number) < 1) errors.push("record.revision must be a positive integer");
	if (typeof input["code"] !== "string" || !GOAL_CODE_PATTERN.test(input["code"])) errors.push("record.code must be two capital letters");
	if (!nonEmptyLine(input["name"])) errors.push("record.name must be one non-empty line");
	if (typeof input["sub"] !== "string" || !oneLine(input["sub"])) errors.push("record.sub must be one line");
	if (!nonEmptyLine(input["project"])) errors.push("record.project must be a project id");
	if (!(GOAL_COLOURS as readonly unknown[]).includes(input["colour"])) errors.push(`record.colour must be one of ${GOAL_COLOURS.join(", ")}`);
	if (!(GOAL_STATUSES as readonly unknown[]).includes(input["status"])) errors.push("record.status must be open, done or dropped");
	if (input["closedAt"] !== undefined && !isTime(input["closedAt"])) errors.push("record.closedAt must be a time");
	if ((input["status"] === "open") !== (input["closedAt"] === undefined)) errors.push("record.closedAt is set exactly when the goal is closed");

	const stationIds = new Set<string>();
	if (!Array.isArray(input["stations"]) || input["stations"].length === 0) errors.push("record.stations must hold at least one station");
	else {
		for (const station of input["stations"]) {
			if (!isObject(station) || Object.keys(station).some((key) => !STATION_KEYS.has(key))) {
				errors.push("record.stations holds an invalid station");
				continue;
			}
			if (typeof station["id"] !== "string" || !STATION_ID_PATTERN.test(station["id"])) errors.push("a station id must be lowercase letters, digits and dashes");
			else if (stationIds.has(station["id"])) errors.push(`duplicate station id ${station["id"]}`);
			else stationIds.add(station["id"]);
			if (!nonEmptyLine(station["name"])) errors.push("a station name must be one non-empty line");
			if (station["owner"] !== undefined && !(typeof station["owner"] === "string" && isStationOwner(station["owner"]))) errors.push("a station owner must be architect, orchestrator, operator, henry or a lane id");
			if (station["timer"] !== undefined && !(typeof station["timer"] === "string" && TIMER_PATTERN.test(station["timer"]))) errors.push("a station timer must be a systemd timer unit");
			if (station["finishedAt"] !== undefined && !isTime(station["finishedAt"])) errors.push("a station finishedAt must be a time");
		}
	}
	if (!Array.isArray(input["lanes"])) errors.push("record.lanes must be an array");
	else {
		const seen = new Set<string>();
		for (const row of input["lanes"]) {
			if (!isObject(row) || Object.keys(row).some((key) => key !== "lane" && key !== "station") || typeof row["lane"] !== "string" || validateAgentId(row["lane"]) !== row["lane"] || typeof row["station"] !== "string" || !stationIds.has(row["station"])) {
				errors.push("record.lanes holds an invalid lane");
				continue;
			}
			if (seen.has(row["lane"])) errors.push(`lane ${row["lane"]} is attached twice`);
			seen.add(row["lane"]);
		}
	}
	if (!Array.isArray(input["waitsOn"]) || input["waitsOn"].some((id) => typeof id !== "string" || !ASK_ID_PATTERN.test(id)) || new Set(input["waitsOn"]).size !== input["waitsOn"].length) {
		errors.push("record.waitsOn must be a list of distinct ask ids");
	}
	if (!Array.isArray(input["events"])) errors.push("record.events must be an array");
	else {
		for (const event of input["events"]) {
			if (!isObject(event) || Object.keys(event).some((key) => !["at", "by", "verb", "detail"].includes(key)) || !isTime(event["at"]) || !GOAL_WRITERS.includes(String(event["by"])) || !(GOAL_VERBS as readonly unknown[]).includes(event["verb"]) || typeof event["detail"] !== "string") {
				errors.push("record.events holds an invalid event");
				break;
			}
		}
	}
	return errors.length > 0 ? { ok: false, errors } : { ok: true, record: input as unknown as GoalRecord };
}

// ─── Store ───────────────────────────────────────────────────────────────────

export type GoalStore = CasStore<GoalRecord>;

/** Files-mode location: `<muster state>/goals/<CODE>.json`. */
export function goalsDir(stateDir: string = musterStateDir()): string {
	return join(stateDir, "goals");
}

const storeOptions = {
	idPattern: GOAL_CODE_PATTERN,
	idKind: "goal",
	noun: "goal",
	validate: validateGoalRecord,
	errorClass: GoalStateError,
	passThrough: (error: unknown): boolean => error instanceof GoalStateError && error.code === "invalid",
} as const;

export function fileGoalStore(dir: string = goalsDir()): GoalStore {
	return fileCasStore<GoalRecord>({ dir, ...storeOptions });
}

export function ledgerGoalStore(socketPath: string): LedgerCasStore<GoalRecord> {
	return ledgerCasStore<GoalRecord>(GOAL_STORE, socketPath, storeOptions);
}

/**
 * The goal store the switch names: the ledger's `goal` record while `backend.json` says ledger, the
 * files store otherwise. Only the store changes; every rule below is the same in both backends.
 */
export function goalStore(dir: string = goalsDir()): GoalStore {
	const stateDir = musterStateDir();
	return readBackend(stateDir) === "ledger" ? ledgerGoalStore(ownerLedgerSocket(stateDir)) : fileGoalStore(dir);
}

export type GoalListing = { goals: GoalRecord[]; skipped: { id: string; error: string }[] };

/**
 * Every goal, by code. A record that fails to read is listed as skipped, never reset, in both
 * stores: the files store reads one file at a time, the ledger store reads the rows it listed and
 * reports the ones it could not parse. One bad record never costs the whole list.
 */
export function listGoals(store: GoalStore, options: { all?: boolean } = {}): GoalListing {
	const skipped: GoalListing["skipped"] = [];
	const goals: GoalRecord[] = [];
	const ledgerStore = store as Partial<LedgerCasStore<GoalRecord>>;
	const tolerantLister = ledgerStore.listWithSkipped;
	const lister = ledgerStore.list;
	if (typeof tolerantLister === "function") {
		const outcome = tolerantLister.call(store);
		for (const row of outcome.rows) goals.push(row.record);
		for (const bad of outcome.skipped) skipped.push(bad);
	} else if (typeof lister === "function") {
		for (const row of lister.call(store)) goals.push(row.record);
	} else {
		let names: string[] = [];
		try {
			names = readdirSync(store.dir).filter((name) => /^[A-Z]{2}\.json$/.test(name));
		} catch {
			/* no goals yet */
		}
		for (const name of names) {
			const id = name.slice(0, -".json".length);
			try {
				const goal = store.read(id);
				if (goal !== undefined) goals.push(goal);
			} catch (error) {
				skipped.push({ id, error: error instanceof Error ? error.message : String(error) });
			}
		}
	}
	goals.sort((left, right) => left.code.localeCompare(right.code));
	return { goals: options.all === true ? goals : goals.filter((goal) => goal.status === "open"), skipped };
}

export function readGoal(store: GoalStore, code: string): GoalRecord | undefined {
	return GOAL_CODE_PATTERN.test(code) ? store.read(code) : undefined;
}

/** The first station not finished. Derived, never stored. */
export function currentStation(goal: GoalRecord): GoalStation | undefined {
	return goal.stations.find((station) => station.finishedAt === undefined);
}

// ─── Who writes ──────────────────────────────────────────────────────────────

export type GoalWriterResolution = { writer: GoalWriter } | { error: string };

/** The writer of a goal change, from the process it runs in. The rule is the ask queue's (`resolveSeatWriter`). */
export function resolveGoalWriter(env: NodeJS.ProcessEnv, agentId: string | undefined, context?: SeatContext): GoalWriterResolution {
	return resolveSeatWriter(env, agentId, context, (named) =>
		`${named === "" ? "this session" : named} is not a seat: goals are written by the operator's shell, the architect or the orchestrator, and a lane never writes one`,
	);
}

// ─── Writes ──────────────────────────────────────────────────────────────────

export type GoalContext = {
	by: GoalWriter;
	/** The event time; the clock when absent. */
	at?: string;
	/** Register project ids, when the caller already has them; else the register is read. */
	projectIds?: readonly string[];
};

const invalid = (message: string): GoalStateError => new GoalStateError("invalid", message);

function requireCode(code: string): void {
	if (!GOAL_CODE_PATTERN.test(code)) throw invalid(`goal code ${JSON.stringify(code)} must be two capital letters`);
}

function requireLine(value: unknown, what: string, options: { empty?: boolean } = {}): string {
	if (typeof value !== "string") throw invalid(`${what} is required`);
	if (!oneLine(value)) throw invalid(`${what} must be one line (no newline or control character)`);
	if (options.empty !== true && value.trim() === "") throw invalid(`${what} must not be empty`);
	return value.trim();
}

function requireStationId(id: string): void {
	if (!STATION_ID_PATTERN.test(id)) throw invalid(`station id ${JSON.stringify(id)} must be lowercase letters, digits and dashes`);
}

function requireOwner(owner: string): string {
	if (!isStationOwner(owner)) throw invalid(`owner ${JSON.stringify(owner)} must be architect, orchestrator, operator, henry or a lane id`);
	return owner;
}

function requireTimer(timer: string): string {
	if (!TIMER_PATTERN.test(timer)) throw invalid(`timer ${JSON.stringify(timer)} must be a systemd user timer unit (name.timer)`);
	return timer;
}

function requireLane(lane: string): string {
	if (validateAgentId(lane) !== lane) throw invalid(`${JSON.stringify(lane)} is not a lane id or a seat role`);
	return lane;
}

function requireStation(goal: GoalRecord, id: string): GoalStation {
	const station = goal.stations.find((candidate) => candidate.id === id);
	if (station === undefined) throw invalid(`goal ${goal.code} has no station ${JSON.stringify(id)} (stations: ${goal.stations.map((candidate) => candidate.id).join(", ")})`);
	return station;
}

function registeredProjectIds(context: GoalContext): readonly string[] {
	return context.projectIds ?? readProjectCatalogue().projects.map((project) => project.projectId);
}

const timeOf = (context: GoalContext): string => context.at ?? new Date().toISOString();

/**
 * The one write path of an existing goal: read it, let `change` edit a copy and say what happened, append
 * the event, and hand the store the revision that was read. `change` returns undefined when nothing
 * changed, and then nothing is written.
 */
function writeGoal(store: GoalStore, code: string, context: GoalContext, verb: GoalVerb, change: (goal: GoalRecord) => string | undefined): GoalRecord {
	requireCode(code);
	const current = store.read(code);
	if (current === undefined) throw new GoalStateError("missing", `no goal ${code}`);
	if (current.status !== "open") throw invalid(`goal ${code} is closed (${current.status})`);
	const next: GoalRecord = structuredClone(current);
	const detail = change(next);
	if (detail === undefined) return current;
	next.events.push({ at: timeOf(context), by: context.by, verb, detail });
	next.revision = current.revision + 1;
	return store.update(code, current.revision, () => next);
}

export type AddGoalInput = {
	code: string;
	name: string;
	sub: string;
	project: string;
	colour?: string;
	stations: { id: string; name: string; owner?: string; timer?: string }[];
};

/** Creates a goal. The store itself refuses a code already taken, because the create carries no revision. */
export function addGoal(store: GoalStore, input: AddGoalInput, context: GoalContext): GoalRecord {
	requireCode(input.code);
	const name = requireLine(input.name, "name");
	const sub = requireLine(input.sub, "sub");
	const project = requireLine(input.project, "project");
	const known = registeredProjectIds(context);
	if (!known.includes(project)) throw invalid(`unknown project ${JSON.stringify(project)}: it is not in the project register (${known.join(", ")})`);
	if (input.stations.length === 0) throw invalid("a goal needs at least one station (--station <id>=<name>)");
	const ids = new Set<string>();
	const stations = input.stations.map((station): GoalStation => {
		requireStationId(station.id);
		if (ids.has(station.id)) throw invalid(`duplicate station id ${station.id}`);
		ids.add(station.id);
		return {
			id: station.id,
			name: requireLine(station.name, `station ${station.id} name`),
			...(station.owner !== undefined && station.owner !== "" ? { owner: requireOwner(station.owner) } : {}),
			...(station.timer !== undefined && station.timer !== "" ? { timer: requireTimer(station.timer) } : {}),
		};
	});
	let colour: GoalColour;
	if (input.colour !== undefined) {
		if (!(GOAL_COLOURS as readonly string[]).includes(input.colour)) throw invalid(`unknown colour ${JSON.stringify(input.colour)}: one of ${GOAL_COLOURS.join(", ")}`);
		colour = input.colour as GoalColour;
	} else {
		const used = new Set(listGoals(store).goals.map((goal) => goal.colour));
		colour = GOAL_COLOURS.find((candidate) => !used.has(candidate)) ?? "blue";
	}
	const record: GoalRecord = {
		schemaVersion: GOAL_SCHEMA_VERSION,
		revision: 1,
		code: input.code,
		name,
		sub,
		project,
		colour,
		stations,
		lanes: [],
		waitsOn: [],
		status: "open",
		events: [{ at: timeOf(context), by: context.by, verb: "add", detail: `added with ${stations.length} station${stations.length === 1 ? "" : "s"}: ${stations.map((station) => station.id).join(", ")}` }],
	};
	return store.update(input.code, undefined, () => record);
}

export type StationInput = {
	id: string;
	name?: string;
	/** An empty string clears it. */
	owner?: string;
	/** An empty string clears it. */
	timer?: string;
	/** Puts the station ahead of this one. */
	before?: string;
};

/** Adds a station, or edits one: a field not named is left as it is. */
export function setStation(store: GoalStore, code: string, input: StationInput, context: GoalContext): GoalRecord {
	requireStationId(input.id);
	return writeGoal(store, code, context, "station", (goal) => {
		const existing = goal.stations.find((station) => station.id === input.id);
		const changes: string[] = [];
		let station: GoalStation;
		if (existing === undefined) {
			if (input.name === undefined) throw invalid(`a new station needs --name (goal ${code} has no station ${input.id})`);
			station = { id: input.id, name: requireLine(input.name, "station name") };
			goal.stations.push(station);
			changes.push("added");
		} else {
			station = existing;
			if (input.name !== undefined) {
				const name = requireLine(input.name, "station name");
				if (name !== station.name) {
					station.name = name;
					changes.push("renamed");
				}
			}
		}
		for (const [field, value, check] of [["owner", input.owner, requireOwner], ["timer", input.timer, requireTimer]] as const) {
			if (value === undefined) continue;
			if (value === "") {
				if (station[field] !== undefined) {
					delete station[field];
					changes.push(`${field} cleared`);
				}
			} else if (check(value) !== station[field]) {
				station[field] = value;
				changes.push(`${field} ${value}`);
			}
		}
		if (input.before !== undefined) {
			if (input.before === input.id) throw invalid(`station ${input.id} cannot go before itself`);
			requireStation(goal, input.before);
			const without = goal.stations.filter((candidate) => candidate.id !== input.id);
			without.splice(without.findIndex((candidate) => candidate.id === input.before), 0, station);
			if (without.some((candidate, index) => candidate.id !== goal.stations[index]!.id)) {
				goal.stations = without;
				changes.push(`before ${input.before}`);
			}
		}
		return changes.length === 0 ? undefined : `station ${input.id}: ${changes.join(", ")}`;
	});
}

/**
 * Attaches a lane to a station. A lane that sits on another open goal moves: the destination is written
 * first and the source second, each with its own event, so a crash between the two writes leaves the lane
 * on both goals and the same attach, run again, finishes it. A lane already at that station writes nothing.
 */
export function attachLane(store: GoalStore, code: string, lane: string, station: string, context: GoalContext): { goal: GoalRecord; movedFrom: string[] } {
	requireLane(lane);
	const sources = listGoals(store).goals.filter((goal) => goal.code !== code && goal.lanes.some((row) => row.lane === lane)).map((goal) => goal.code);
	const goal = writeGoal(store, code, context, "attach", (draft) => {
		requireStation(draft, station);
		const held = draft.lanes.find((row) => row.lane === lane);
		// Already there: nothing to write, which is also how a rerun after a crash between the two writes finds the destination.
		if (held?.station === station) return undefined;
		if (held === undefined) draft.lanes.push({ lane, station });
		else held.station = station;
		return `lane ${lane} at station ${station}${sources.length > 0 ? ` (moved from ${sources.join(", ")})` : ""}`;
	});
	for (const source of sources) {
		writeGoal(store, source, context, "detach", (draft) => {
			const before = draft.lanes.length;
			draft.lanes = draft.lanes.filter((row) => row.lane !== lane);
			return draft.lanes.length === before ? undefined : `lane ${lane} (moved to ${code})`;
		});
	}
	return { goal, movedFrom: sources };
}

export function detachLane(store: GoalStore, code: string, lane: string, context: GoalContext): GoalRecord {
	requireLane(lane);
	return writeGoal(store, code, context, "detach", (goal) => {
		if (!goal.lanes.some((row) => row.lane === lane)) throw invalid(`lane ${lane} is not attached to ${code}`);
		goal.lanes = goal.lanes.filter((row) => row.lane !== lane);
		return `lane ${lane}`;
	});
}

export function finishStation(store: GoalStore, code: string, station: string, context: GoalContext): GoalRecord {
	return writeGoal(store, code, context, "finish", (goal) => {
		const target = requireStation(goal, station);
		if (target.finishedAt !== undefined) throw invalid(`station ${station} of ${code} is already finished`);
		target.finishedAt = timeOf(context);
		return `station ${station} (${target.name})`;
	});
}

export function reopenStation(store: GoalStore, code: string, station: string, context: GoalContext): GoalRecord {
	return writeGoal(store, code, context, "reopen", (goal) => {
		const target = requireStation(goal, station);
		if (target.finishedAt === undefined) throw invalid(`station ${station} of ${code} is not finished`);
		delete target.finishedAt;
		return `station ${station} (${target.name})`;
	});
}

export function waitOn(store: GoalStore, code: string, askId: string, context: GoalContext): GoalRecord {
	if (!ASK_ID_PATTERN.test(askId)) throw invalid(`${JSON.stringify(askId)} is not an ask id`);
	return writeGoal(store, code, context, "wait", (goal) => {
		if (goal.waitsOn.includes(askId)) return undefined;
		goal.waitsOn.push(askId);
		return `ask ${askId}`;
	});
}

export function unwaitOn(store: GoalStore, code: string, askId: string, context: GoalContext): GoalRecord {
	return writeGoal(store, code, context, "unwait", (goal) => {
		if (!goal.waitsOn.includes(askId)) throw invalid(`${code} is not waiting on ${askId}`);
		goal.waitsOn = goal.waitsOn.filter((id) => id !== askId);
		return `ask ${askId}`;
	});
}

/** Sets a goal's colour. A key another open goal holds is refused: each open goal owns one tint (R7 D29). */
export function setGoalColour(store: GoalStore, code: string, colour: string, context: GoalContext): GoalRecord {
	if (!(GOAL_COLOURS as readonly string[]).includes(colour)) throw invalid(`unknown colour ${JSON.stringify(colour)}: one of ${GOAL_COLOURS.join(", ")}`);
	return writeGoal(store, code, context, "colour", (goal) => {
		if (goal.colour === colour) return undefined;
		const holder = listGoals(store).goals.find((other) => other.code !== goal.code && other.colour === colour);
		if (holder !== undefined) throw invalid(`colour ${JSON.stringify(colour)} is held by goal ${holder.code}; each open goal owns one tint`);
		const before = goal.colour;
		goal.colour = colour as GoalColour;
		return `colour ${before} to ${colour}`;
	});
}

export function closeGoal(store: GoalStore, code: string, outcome: string, context: GoalContext): GoalRecord {
	if (!(GOAL_OUTCOMES as readonly string[]).includes(outcome)) throw invalid(`close needs --outcome ${GOAL_OUTCOMES.join("|")}`);
	return writeGoal(store, code, context, "close", (goal) => {
		goal.status = outcome as GoalStatus;
		goal.closedAt = timeOf(context);
		return `outcome ${outcome}`;
	});
}
