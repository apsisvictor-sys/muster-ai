/**
 * Contract repairs and system asks (spec §4, OL3b): the one owner of what a red contract causes.
 *
 * The doctor owns liveness and publishes one row per contract into `health/doctor-result.json`
 * (`state`, `ok`, `reason`); `contracts.ts` owns each contract's declared answer to a red state
 * (`onRed`: one bounded command, an ask, or a panel line). This file owns the step between them, so
 * the tick and the doctor cannot answer the same red state in two different ways:
 *
 * - **Repair, once per contract per day.** The tick runs the declared command and records the attempt
 *   in `state/muster/repairs.json`, which replaces the janitor's `janitor-repairs.json` (spec §4 item 2).
 *   A unit a live lane record registers as a helper scope is never repaired: another lane's dev server
 *   is not this pass's to stop. Only `state === "red"` is repaired, never `pending`. A contract the table
 *   marks `autoRestart: false` is never repaired either: its red state is the alert alone - the unit, since
 *   when it has shown no proof, and the one command that restarts it (Henry relay 2026-10-28 21:12 (f)).
 * - **An ask 15 minutes after the repair, at once for a contract that asks, never for a panel contract.**
 *   The ask is fully prepared - one line for the operator, concrete options and a recommendation - and carries
 *   the contract's own `askCode`, which is how a second pass recognises its own open ask (spec §4 items 3
 *   and 4). The tick withdraws it when the contract is green again.
 * - **The doctor's two contracts.** The tick cannot report its own death, so the doctor raises and
 *   withdraws the asks for `muster tick` and `doctor-result`, its only write besides its result file
 *   (spec §4 item 5). Every other contract is the tick's.
 *
 * The command comes from the code table, never from a report: a row's `id` and `reason` are read, and
 * only a table entry's declared `command` can reach a process. A tick reading a result file older than
 * two doctor runs treats `doctor-result` as red, because two missed runs are not evidence of anything.
 *
 * Nothing here starts, stops or signals a service by pattern: one argv built from the table, run by the
 * caller's port, with the attempt recorded either way.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
	CONTRACT_TABLE,
	DERIVED_CONTRACTS,
	SERVICE_IDS,
	type ContractDeclaration,
	type ContractOnRed,
} from "./contracts.ts";
import type { AskKind } from "../asks.ts";

/** The attempt log the tick writes and reads (spec §4 item 2): contract id to the epoch ms it was tried. */
export const REPAIRS_FILE = "repairs.json";

/** The doctor's published rows, under the agent folder the doctor writes them into. */
export const DOCTOR_RESULT_FILE = "doctor-result.json";

/** The doctor's own cadence (`pi-doctor.timer`): every five minutes. */
export const DOCTOR_RUN_MS = 5 * 60_000;

/** A result two doctor runs old says nothing about now (spec §4 item 1). */
export const DOCTOR_RESULT_STALE_MS = 2 * DOCTOR_RUN_MS;

/** How long a repair gets before the tick stops waiting and asks (spec §4 item 3). */
export const REPAIR_ASK_DELAY_MS = 15 * 60_000;

/** One declared repair's budget: a restart that hangs is over, not a pass that never ends. */
export const REPAIR_TIMEOUT_MS = 30_000;

/**
 * The two contracts whose ask the doctor raises, because the tick cannot report its own death and a dead
 * doctor writes no result (spec §4 item 5). The tick still repairs them: repair is the tick's alone.
 */
export const DOCTOR_ASKED_CONTRACTS: ReadonlySet<string> = new Set([SERVICE_IDS.tick, DERIVED_CONTRACTS.doctorResult]);

/** The two writers of a contract ask (`asks.ts` `CONTRACT_ASK_WRITERS`), named as this pass needs them. */
export type ContractWriter = "tick" | "doctor";

/**
 * The three states the doctor publishes (spec §4). Restated here because muster's package may not import
 * Pi's profile, where the doctor declares them (`health/doctor.ts` `ContractState`); the doctor's own rows
 * are assignable to this union, so the two can never drift apart unnoticed by a fixture.
 */
export type ContractState = "green" | "red" | "pending";

/** One contract row as the doctor publishes it: the fields this step reads, and nothing else. */
export type ContractRow = {
	kind: string;
	id: string;
	state?: ContractState;
	ok: boolean;
	reason?: string;
	askCode?: string;
	onRed?: ContractOnRed;
	/**
	 * The doctor's own record of when this row last had a proof, and of when it was first seen without one. Both
	 * are its verdict's evidence, quoted as they stand: the alert says since when the unit has shown no proof.
	 */
	proofAt?: string | null;
	pendingSince?: string | null;
};

/** The doctor's result, as this step reads it: when it was written, its rows, and why it could not be read. */
export type DoctorResultRead = { atMs: number | null; rows: ContractRow[]; error?: string };

/** What one pass did, per contract. Only a change is reported, so a red contract does not print every pass. */
export type ContractOutcome = {
	contractId: string;
	code: string;
	action: "repaired" | "repair-failed" | "repair-skipped" | "ask-raised" | "ask-withdrawn" | "unreadable";
	detail: string;
};

export type ContractStepInput = {
	writer: ContractWriter;
	/** The muster state directory: the repairs log and the asks store. */
	stateDir: string;
	now: number;
	rows: readonly ContractRow[];
	/** Units a live lane record registers as a helper scope: never repaired (spec §4 item 2). */
	helperScopeUnits?: readonly string[];
	/** Run one declared repair. Absent means this pass runs nothing, so no attempt is recorded. */
	repair?(argv: readonly string[]): { ok: boolean; detail: string };
};

/** Local calendar date, `YYYY-MM-DD`: the day a once-a-day repair is measured in, the way the operator reads it. */
export function localDate(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** A time as the alert writes it: the local day and clock, `YYYY-MM-DD HH:MM`. */
export function localStamp(ms: number): string {
	const d = new Date(ms);
	return `${localDate(ms)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Where the attempt log lives in one muster state directory. */
export function repairsPath(stateDir: string): string {
	return join(stateDir, REPAIRS_FILE);
}

/** The attempt log: contract id to the epoch ms of its last attempt. A date string is read as that day's start. */
export function readRepairs(stateDir: string): Record<string, number> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(repairsPath(stateDir), "utf8"));
	} catch {
		return {};
	}
	if (typeof parsed !== "object" || parsed === null) return {};
	const log: Record<string, number> = {};
	for (const [contractId, value] of Object.entries(parsed as Record<string, unknown>)) {
		const at = typeof value === "number" ? value : typeof value === "string" ? Date.parse(`${value}T00:00:00`) : Number.NaN;
		if (Number.isFinite(at)) log[contractId] = at;
	}
	return log;
}

/** Write the attempt log atomically: a pass that dies mid-write leaves the previous log, not half of one. */
export function writeRepairs(stateDir: string, log: Readonly<Record<string, number>>): void {
	const file = repairsPath(stateDir);
	mkdirSync(dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(log, null, "\t")}\n`, { mode: 0o600 });
	renameSync(temp, file);
}

/**
 * One declared repair as an argv. The table writes commands the way a person would: words and a single
 * quoted unit name. Nothing else is allowed through - no pipe, no redirection, no substitution, no second
 * command - because a repair is one bounded command and the caller runs an argv, never a shell.
 */
export function repairArgv(command: string): { argv: string[] } | { refused: string } {
	const forbidden = /[;&|<>$`\\\n\r(){}*?[\]]/;
	if (forbidden.test(command)) return { refused: `the declared command carries a shell character, so it is not run as an argv: ${JSON.stringify(command)}` };
	const argv: string[] = [];
	let current = "";
	let quoted = false;
	let open = false;
	for (const character of command.trim()) {
		if (character === "'") {
			quoted = !quoted;
			open = true;
			continue;
		}
		if (!quoted && /\s/.test(character)) {
			if (open) argv.push(current);
			current = "";
			open = false;
			continue;
		}
		current += character;
		open = true;
	}
	if (quoted) return { refused: `the declared command has an unclosed quote: ${JSON.stringify(command)}` };
	if (open) argv.push(current);
	if (argv.length === 0) return { refused: "the declared command is empty" };
	return { argv };
}

function isContractRow(value: unknown): value is ContractRow {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return typeof row["id"] === "string" && typeof row["ok"] === "boolean";
}

/**
 * Read the doctor's published rows (spec §4). A file that cannot be read, carries no time, or is older
 * than two doctor runs counts as red for `doctor-result`: the tick cannot tell a healthy machine from a
 * doctor that stopped, and saying so is the difference between the two.
 */
export function readDoctorResult(file: string, now: number): DoctorResultRead {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { atMs: null, rows: [staleDoctorResult(reason)], error: `the doctor's result could not be read: ${reason}` };
	}
	const result = parsed as { ts?: unknown; checks?: { contracts?: { rows?: unknown } } };
	const raw = result.checks?.contracts?.rows;
	const rows: ContractRow[] = Array.isArray(raw) ? raw.filter(isContractRow) : [];
	const ts = typeof result.ts === "string" ? Date.parse(result.ts) : Number.NaN;
	const atMs = Number.isFinite(ts) ? ts : null;
	if (atMs === null) return { atMs, rows: withoutRow(rows, DERIVED_CONTRACTS.doctorResult).concat(staleDoctorResult("the result carries no readable time")), error: "the doctor's result carries no readable time" };
	if (now - atMs > DOCTOR_RESULT_STALE_MS) {
		const late = Math.round((now - atMs) / 60_000);
		return { atMs, rows: withoutRow(rows, DERIVED_CONTRACTS.doctorResult).concat(staleDoctorResult(`the doctor's result is ${late} minutes old, two runs behind`)) };
	}
	return { atMs, rows };
}

function withoutRow(rows: readonly ContractRow[], id: string): ContractRow[] {
	return rows.filter((row) => row.id !== id);
}

function staleDoctorResult(reason: string): ContractRow {
	return { kind: "derived", id: DERIVED_CONTRACTS.doctorResult, state: "red", ok: false, reason, askCode: CONTRACT_TABLE[DERIVED_CONTRACTS.doctorResult]?.askCode };
}

function declarationOf(contractId: string): ContractDeclaration | undefined {
	return CONTRACT_TABLE[contractId];
}

/** The writer that owns one contract's ask: the doctor's two, and the tick's everything else (spec §4 item 5). */
export function asksFor(writer: ContractWriter, contractId: string): boolean {
	return writer === "doctor" ? DOCTOR_ASKED_CONTRACTS.has(contractId) : !DOCTOR_ASKED_CONTRACTS.has(contractId);
}

function stateOf(row: ContractRow): ContractState {
	return row.state ?? (row.ok ? "green" : "red");
}

function ageLabel(ms: number): string {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

/**
 * The ask one red contract raises: one line for the operator, then options that each say what picking it does,
 * and a recommendation with its reason (spec §7a: a question reaches him only when fully prepared).
 *
 * A contract whose restart the table refuses the tick (`autoRestart: false`) gets the alert in its place: the
 * unit is red, since when it has shown no proof, and the one command that restarts it (Henry relay 21:12 (f)).
 */
export function contractAsk(
	contractId: string,
	row: ContractRow,
	context: { now: number; repairedAt?: number },
): { kind: AskKind; question: string; options: string[]; recommendation: string } {
	const declaration = declarationOf(contractId);
	const why = row.reason === undefined || row.reason.trim() === "" ? "its proof is not fresh" : row.reason.trim();
	const whyClause = why.endsWith(".") ? why : `${why}.`;
	const purpose = declaration === undefined ? "" : ` ${declaration.purpose}`;
	const repaired = context.repairedAt === undefined ? "" : ` One repair was tried ${ageLabel(context.now - context.repairedAt)} ago and the contract is still red.`;
	const declaredRepair = declaration === undefined || declaration.onRed.action !== "repair" ? undefined : declaration.onRed;
	// The tick's restart is refused in the table, so the alert carries what it may not do: since when, and the command.
	const mine = declaredRepair !== undefined && declaration?.autoRestart !== false;
	const options = [
		`I look at ${contractId} now and come back to you with what I found.`,
		...(declaredRepair === undefined ? [] : [mine ? "Try the declared repair again now." : `Restart it with ${declaredRepair.command} now.`]),
		"Leave it red for now: the panel keeps showing it.",
	];
	const recommendation = options[0]!;
	const since = sinceClause(row);
	const restart = declaredRepair !== undefined && !mine ? ` Nothing here restarts it: ${declaredRepair.command} is the one command that does.` : "";
	return {
		kind: "operator-action",
		question: `${contractId} is red: ${whyClause}${since}${purpose}${repaired}${restart}`,
		options,
		recommendation,
	};
}

/**
 * Since when the contract has shown no proof, in the doctor's own times: the last proof it had, or the moment it
 * was first seen without one. Absent when the row carries neither, because a guessed time is worse than none.
 */
function sinceClause(row: ContractRow): string {
	const since = row.pendingSince ?? row.proofAt;
	if (typeof since !== "string") return "";
	const ms = Date.parse(since);
	if (!Number.isFinite(ms)) return "";
	return ` It has shown no proof since ${localStamp(ms)}.`;
}

/**
 * The ask store, loaded when this pass needs it. `asks.ts` is a large module and one of its dependencies carries
 * top-level await, so Pi's doctor - which loads this file through a static import - must not pull it in at load
 * time; the tick, which reaches the same module directly today, pays nothing for this.
 */
type AskStore = typeof import("../asks.ts");
let askStore: AskStore | undefined;
async function askStoreOf(): Promise<AskStore> {
	if (askStore === undefined) askStore = await import("../asks.ts");
	return askStore;
}

/** The live ask carrying this code, if the queue holds one: the dedupe is `asks.ts`'s own rule, asked here. */
function openAskFor(store: AskStore, stateDir: string, code: string): { id: string } | undefined {
	const found = store.findOpenDuplicate(store.readAsks(stateDir), { code });
	return found === undefined ? undefined : { id: found.id };
}

function withdraw(store: AskStore, input: ContractStepInput, code: string, reason: string): string | undefined {
	const live = openAskFor(store, input.stateDir, code);
	if (live === undefined) return undefined;
	try {
		store.withdrawAsk(input.stateDir, { by: input.writer, ref: live.id, reason, at: new Date(input.now).toISOString() });
		return `${live.id} withdrawn: ${reason}`;
	} catch (error) {
		return `ask ${live.id} could not be withdrawn: ${error instanceof Error ? error.message : String(error)}`;
	}
}

function raise(store: AskStore, input: ContractStepInput, contractId: string, code: string, row: ContractRow, repairedAt: number | undefined): ContractOutcome {
	const content = contractAsk(contractId, row, { now: input.now, ...(repairedAt === undefined ? {} : { repairedAt }) });
	try {
		const at = new Date(input.now).toISOString();
		const ask = store.raiseAsk(input.stateDir, {
			by: input.writer,
			kind: content.kind,
			question: content.question,
			code,
			...(declarationOf(contractId)?.owner === undefined ? {} : { owner: declarationOf(contractId)!.owner }),
			source: `contract:${contractId}`,
			at,
		});
		store.prepareAsk(input.stateDir, { by: input.writer, ref: ask.id, options: content.options, recommendation: content.recommendation, at });
		return { contractId, code, action: "ask-raised", detail: `${ask.id} raised for ${contractId}: ${content.question}` };
	} catch (error) {
		return { contractId, code, action: "unreadable", detail: `the ask for ${contractId} could not be raised: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/**
 * One pass over the contract table: repair a red contract once a day (the tick's alone), then raise the
 * ask when the repair is 15 minutes old and the contract is still red, or at once for a contract that
 * asks, and withdraw it when the contract is green (spec §4 items 2-5).
 */
export async function contractStep(input: ContractStepInput): Promise<ContractOutcome[]> {
	const outcomes: ContractOutcome[] = [];
	const rows = new Map<string, ContractRow>();
	for (const row of input.rows) if (!rows.has(row.id)) rows.set(row.id, row);
	const helpers = new Set(input.helperScopeUnits ?? []);
	const log = readRepairs(input.stateDir);
	let logged = false;
	/** The ask side, decided while the repairs run and acted on after them. */
	const verdicts: Array<{ contractId: string; code: string; row: ContractRow; state: "green" | "red"; askAt: number; repairedAt?: number }> = [];
	/** The contracts this pass refused to restart, reported once, beside the alert it raises. */
	const refusedRestart = new Map<string, string>();

	for (const contractId of Object.keys(CONTRACT_TABLE)) {
		const row = rows.get(contractId);
		if (row === undefined) continue;
		const declaration = declarationOf(contractId);
		if (declaration === undefined) continue;
		const code = declaration.askCode;
		const state = stateOf(row);
		const askMine = asksFor(input.writer, contractId);

		if (state === "green") {
			if (!askMine) continue;
			verdicts.push({ contractId, code, row, state: "green", askAt: input.now });
			continue;
		}
		// `pending` is registered and waiting for its first proof: not broken, so neither repaired nor asked about.
		if (state !== "red") continue;
		// A panel contract shows on the Services panel and never becomes a question (spec §4 item 4).
		if (declaration.onRed.action === "panel") continue;

		// `askAt` is the one wait per contract: a repair buys 15 minutes before the ask (spec §4 item 3).
		let askAt = input.now;
		let repairedAt = log[contractId];
		const declaredRepair = declaration.onRed.action === "repair" ? declaration.onRed : undefined;
		// A restart the table refuses the tick is never run here: its red state is the alert alone (OL3b, Henry 21:12 (f)).
		const restartMine = declaration.autoRestart !== false;
		if (declaredRepair !== undefined && !restartMine) {
			// The wait is for the command, not for a repair that will never run: the ask goes out in this pass, and
			// it says what the pass did not do, so a red core unit leaves one line rather than one line every pass.
			repairedAt = undefined;
			refusedRestart.set(contractId, `${contractId} is red and was not restarted: ${declaredRepair.command} is the command that restarts it`);
		} else if (declaredRepair !== undefined && restartMine && input.writer === "tick" && input.repair !== undefined) {
			if (helpers.has(contractId)) {
				// Another lane runs this unit as its helper scope: nothing here may restart it (spec §4 item 2).
				outcomes.push({ contractId, code, action: "repair-skipped", detail: `${contractId} is a live lane's helper scope, so it was not repaired` });
			} else if (repairedAt !== undefined && localDate(repairedAt) === localDate(input.now)) {
				askAt = repairedAt + REPAIR_ASK_DELAY_MS;
			} else {
				const parsed = repairArgv(declaredRepair.command);
				if ("refused" in parsed) {
					outcomes.push({ contractId, code, action: "repair-skipped", detail: `${contractId} was not repaired: ${parsed.refused}` });
				} else {
					const result = input.repair(parsed.argv);
					repairedAt = input.now;
					log[contractId] = input.now;
					logged = true;
					askAt = input.now + REPAIR_ASK_DELAY_MS;
					outcomes.push({ contractId, code, action: result.ok ? "repaired" : "repair-failed", detail: `${contractId}: ${result.detail}` });
				}
			}
		} else if (declaredRepair !== undefined) {
			// A writer that repairs nothing - the doctor - still waits for the tick's own attempt, when there was one.
			askAt = repairedAt === undefined ? input.now : repairedAt + REPAIR_ASK_DELAY_MS;
		}

		if (!askMine || input.now < askAt) continue;
		verdicts.push({ contractId, code, row, state: "red", askAt, ...(repairedAt === undefined ? {} : { repairedAt }) });
	}

	if (logged) {
		try {
			writeRepairs(input.stateDir, log);
		} catch (error) {
			outcomes.push({ contractId: "-", code: "-", action: "unreadable", detail: `the repair log could not be written: ${error instanceof Error ? error.message : String(error)}` });
		}
	}

	// The asks come after every repair, so a store that cannot be read never stops a service being put right.
	if (verdicts.length === 0) return outcomes;
	const store = await askStoreOf();
	for (const verdict of verdicts) {
		try {
			if (verdict.state === "green") {
				const detail = withdraw(store, input, verdict.code, `${verdict.contractId} is green again`);
				if (detail !== undefined) outcomes.push({ contractId: verdict.contractId, code: verdict.code, action: "ask-withdrawn", detail });
				continue;
			}
			if (openAskFor(store, input.stateDir, verdict.code) !== undefined) continue;
			const skipped = refusedRestart.get(verdict.contractId);
			if (skipped !== undefined) outcomes.push({ contractId: verdict.contractId, code: verdict.code, action: "repair-skipped", detail: skipped });
			outcomes.push(raise(store, input, verdict.contractId, verdict.code, verdict.row, verdict.repairedAt));
		} catch (error) {
			// One line, not one per contract: an unreadable store is one fault, and the repairs have already run.
			outcomes.push({ contractId: verdict.contractId, code: verdict.code, action: "unreadable", detail: `the ask store could not be reached: ${error instanceof Error ? error.message : String(error)}` });
			break;
		}
	}
	return outcomes;
}
