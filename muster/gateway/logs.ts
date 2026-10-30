/**
 * The last lines of a log, for `audit_read`, `send_log_read` and `logs_read`. Read-only.
 * The gateway's own logs are append-only JSON lines; the tail is cut from the end of the file
 * so a large log is never read whole.
 *
 * HO6 (`henry-observability-blueprint-2026-10-17.md`) adds the same tail view over a user unit's
 * journal through one fixed `journalctl` argv, over the gateway's own unit, and over a guarded
 * run's own `/tmp` log that the HO5 run ledger recorded. A lane supplies no path that is read:
 * a `test` name must be a ledger row's `log` AND one of the runners' own names, after realpath.
 */

import { execFile } from "node:child_process";
import { LabUnitRefusal, labUnitOperand } from "../../core/lab-units.ts";
import { closeSync, existsSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { redactSensitiveText } from "../../core/self-improving-redactor.ts";
import { backendState, readBackend } from "../ledger/backend.ts";
import { requestSync } from "../ledger/client-sync.ts";
import { ownerLedgerSocket } from "../ledger/stores.ts";
import { SEND_LOG_FILE } from "../send.ts";

export const LOG_TAIL_DEFAULT_LINES = 50;
export const LOG_TAIL_MAX_LINES = 200;
/** At most this much is read from the end of the file. */
const READ_BYTES = 256 * 1024;
/** At most this many characters are returned; the oldest lines go first. */
const RETURN_CHARS = 60_000;

/**
 * The tail of an already-read log text: at most `lines` complete non-blank lines, the oldest
 * dropped first when the whole answer would pass the character cap, then redacted. One owner for
 * both the file reader and the journal reader.
 */
function tailOfText(text: string, lines: number, emptyText: string): string {
	let tail = text.split("\n").filter((line) => line.trim() !== "").slice(-lines);
	let joined = tail.join("\n");
	while (joined.length > RETURN_CHARS && tail.length > 1) {
		tail = tail.slice(1);
		joined = tail.join("\n");
	}
	if (tail.length === 0) return emptyText;
	return redactSensitiveText(joined, { preservePaths: true, strictAssignments: true });
}

/**
 * The complete lines in the last 256 KiB of a log file, raw: nothing redacted, capped or filtered, the partial first line of a
 * cut read dropped. `readLogTail` redacts and caps them for the text answers; a caller that parses a line (the command center
 * reads Henry's audit lines) takes them here, because masked text is never parsed. An absent file has no lines.
 */
export function readLogTailLines(file: string): string[] {
	if (!existsSync(file)) return [];
	const fd = openSync(file, "r");
	let text: string;
	let truncated: boolean;
	try {
		const size = fstatSync(fd).size;
		const length = Math.min(size, READ_BYTES);
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, size - length);
		text = buffer.toString("utf8");
		truncated = size > length;
	} finally {
		closeSync(fd);
	}
	const all = text.split("\n");
	// The first line of a cut read may be partial.
	if (truncated) all.shift();
	// A file that ends in a newline leaves one empty piece after the last line; it is not a line.
	if (all.at(-1) === "") all.pop();
	return all;
}

/** The last `lines` complete lines of a log file, redacted, or a plain "no log" answer. */
export function readLogTail(file: string, lines: number, what: string): string {
	if (!existsSync(file)) return `no ${what} yet`;
	return tailOfText(readLogTailLines(file).join("\n"), lines, `${what} is empty`);
}

// ─── `send_log_read` ─────────────────────────────────────────────────────────

/** A ledger `SENT` entry as `musterd` serves it (`ledger/methods.ts:eventsSince`). */
type LedgerEvent = { id: number; type: string; lane?: string; text?: string; at: number };

/** The whole-store read budget the flip's export uses; the events after the flip cursor are far fewer. */
const SENT_READ_TIMEOUT_MS = 10_000;
const SENT_READ_MAX_LINE_BYTES = 64 * 1024 * 1024;

/**
 * The ledger's `SENT` entries as send-log lines. Since the flip, `appendSendLog` writes no file: the ledger's
 * `send` method appends a `SENT` entry instead (LC9), so the file stops at the flip. Only the lane, the time and
 * the size of the text are shown, never the message body.
 */
function ledgerSendLines(stateDir: string): string[] {
	if (readBackend(stateDir) !== "ledger") return [];
	const state = backendState(stateDir);
	const events = requestSync<LedgerEvent[]>(ownerLedgerSocket(stateDir), "events", state.backend === "ledger" ? { after: state.cursor } : {}, { timeoutMs: SENT_READ_TIMEOUT_MS, maxLineBytes: SENT_READ_MAX_LINE_BYTES });
	return events
		.filter((event) => event.type === "SENT")
		.map((event) => JSON.stringify({ at: new Date(event.at).toISOString(), laneId: event.lane ?? "", transport: "inbox", source: "ledger", eventId: event.id, bytes: Buffer.byteLength(event.text ?? "") }));
}

/**
 * The tail of the send log: the file's lines (everything before the ledger flip, and the files-mode install's
 * own), then the ledger's `SENT` entries after the flip. A ledger that cannot be reached still answers with the file.
 */
export function readSendLogTail(stateDir: string, lines: number): string {
	const file = readLogTail(join(stateDir, SEND_LOG_FILE), LOG_TAIL_MAX_LINES, "send log");
	const fileLines = file === "no send log yet" || file === "send log is empty" ? [] : file.split("\n");
	let ledgerLines: string[] = [];
	let note = "";
	try {
		ledgerLines = ledgerSendLines(stateDir);
	} catch (error) {
		note = `\nnote: the ledger's sends could not be read (${failureNote("", error instanceof Error ? error.message : String(error))})`;
	}
	const all = [...fileLines, ...ledgerLines].slice(-lines);
	if (all.length === 0) return note === "" ? "no send log yet" : `no send log yet${note}`;
	return `${redactSensitiveText(all.join("\n"), { preservePaths: true, strictAssignments: true })}${note}`;
}

// ─── HO6: `logs_read` ────────────────────────────────────────────────────────

/** One finished `systemctl`/`journalctl` run. A non-zero exit is a normal answer, not an error. */
export type LogCommandRun = { exitCode: number | null; stdout: string; stderr: string };

/** The one exec seam for `logs_read`: a fixed argv, no shell, a timeout and a bounded buffer. Tests stub it. */
export type RunLogCommand = (file: string, args: string[], timeoutMs: number) => Promise<LogCommandRun>;

export const LOG_COMMAND_TIMEOUT_MS = 10_000;
const LOG_COMMAND_MAX_BUFFER = 1024 * 1024;
/** A failure note carries the redacted first line only, so one bad binary cannot flood the answer. */
const NOTE_CHARS = 300;

export const execLogCommand: RunLogCommand = (file, args, timeoutMs) =>
	new Promise((resolveRun, rejectRun) => {
		execFile(file, args, { timeout: timeoutMs, maxBuffer: LOG_COMMAND_MAX_BUFFER, env: process.env }, (error, stdout, stderr) => {
			if (error === null) return resolveRun({ exitCode: 0, stdout, stderr });
			// A command's own non-zero exit is a normal answer; only a spawn or timeout failure rejects.
			if (typeof error.code === "number") return resolveRun({ exitCode: error.code, stdout, stderr });
			rejectRun(new Error(failureNote(stderr, error.message)));
		});
	});

/** What a failure says: the redacted first line of stderr or the error, nothing more. */
function failureNote(stderr: string, fallback: string): string {
	const said = redactSensitiveText((stderr || fallback).trim(), { preservePaths: true }).split("\n")[0] ?? "";
	return said.slice(0, NOTE_CHARS) || "the command failed";
}

/** The `logs_read` sources. */
export const LOGS_READ_SOURCES = ["unit", "test", "gateway"] as const;
export type LogsReadSource = (typeof LOGS_READ_SOURCES)[number];

/** HO6: the only user units whose journal `logs_read` will read. */
export const JOURNAL_UNIT_PREFIXES = ["muster", "pi-", "crm-app", "be-", "radar", "secrets-", "mcp-", "agent-", "night-watch", "windows-portwatch", "grokbot-tunnel", "grokbot-oom-protect"] as const;
/** The gateway's own user unit: its log is that unit's journal. */
export const GATEWAY_UNIT = "muster-gateway.service";
/** HO6: the guarded runners' own `/tmp` log names (`run-guarded.sh`, BE `scripts/lanes/test.sh`). */
export const TEST_LOG_PATTERNS = [/^\/tmp\/be-lane-[^/]+\.log$/, /^\/tmp\/pi-test-[^/]+\.log$/] as const;
/** `journalctl -u` expands patterns of its own, so a name that is not an exact unit name never reaches it. */
const UNIT_GLOB = /[*?[\]]/;

/** A `logs_read` refusal: the tool that asked turns it into its own refusal. */
export class LogsReadRefusal extends Error {}

/** At most `lines`, never fewer than one, never more than `LOG_TAIL_MAX_LINES` (a larger value clamps). */
export function clampLogLines(lines: number | undefined): number {
	return Math.min(Math.max(lines ?? LOG_TAIL_DEFAULT_LINES, 1), LOG_TAIL_MAX_LINES);
}

export type LogsReadDeps = {
	/** The systemctl/journalctl seam; production wires `execLogCommand`, tests stub it. */
	run: RunLogCommand;
	/** The log paths the HO5 run ledger recorded; a `test` source may read only one of them. */
	ledgerLogs: () => string[];
	/** Where the lab unit marker is read from; `process.env` when absent. */
	env?: NodeJS.ProcessEnv;
};

export type LogsReadInput = { source: string; name?: string; lines?: number };

/**
 * HO6 `logs_read`: the last lines of one user unit's journal (`unit`), of the gateway's own unit
 * (`gateway`), or of a guarded run's own `/tmp` log the run ledger recorded (`test`). Read-only.
 */
export async function logsRead(deps: LogsReadDeps, input: LogsReadInput): Promise<string> {
	const source = (input.source ?? "").trim();
	if (!(LOGS_READ_SOURCES as readonly string[]).includes(source)) {
		throw new LogsReadRefusal(`source must be one of ${LOGS_READ_SOURCES.join(", ")}`);
	}
	const lines = clampLogLines(input.lines);
	if (source === "gateway") return journalTail(deps.run, GATEWAY_UNIT, lines);
	const name = (input.name ?? "").trim();
	if (name === "") throw new LogsReadRefusal(`name is required for source ${source}`);
	if (source === "unit") return unitLog(deps.run, name, lines, deps.env);
	return testLog(deps, name, lines);
}

/**
 * One allowed unit: the exact installed name first, then the prefix, then the journal. The lab unit guard
 * (`lab-units.ts`) resolves the name before the listing spawns anything: in a marked lab a unit the lab did not
 * map is refused here, so a lab gateway never reads a live unit's journal by accident (R2).
 */
async function unitLog(run: RunLogCommand, name: string, lines: number, env: NodeJS.ProcessEnv = process.env): Promise<string> {
	if (UNIT_GLOB.test(name)) throw new LogsReadRefusal(`name must be an exact installed unit name, never a pattern: ${name}`);
	let unit: string;
	try {
		unit = labUnitOperand(name, env);
	} catch (error) {
		if (!(error instanceof LabUnitRefusal)) throw error;
		throw new LogsReadRefusal(error.message);
	}
	const installed = await installedUserUnits(run);
	if (!installed.has(name)) throw new LogsReadRefusal(`${name} is not an installed user unit`);
	if (!JOURNAL_UNIT_PREFIXES.some((prefix) => name.startsWith(prefix))) {
		throw new LogsReadRefusal(`${name} is outside the readable units (${JOURNAL_UNIT_PREFIXES.join(", ")})`);
	}
	return journalTail(run, unit, lines);
}

/** The installed user unit names, one per line of `systemctl --user list-unit-files --no-legend`. */
async function installedUserUnits(run: RunLogCommand): Promise<Set<string>> {
	const result = await run("systemctl", ["--user", "list-unit-files", "--no-legend", "--no-pager"], LOG_COMMAND_TIMEOUT_MS);
	if (result.exitCode !== 0) throw new LogsReadRefusal(`the installed user units could not be listed (${failureNote(result.stderr, "systemctl failed")})`);
	const names = new Set<string>();
	for (const line of result.stdout.split("\n")) {
		const name = line.trim().split(/\s+/)[0];
		if (name !== undefined && name !== "") names.add(name);
	}
	return names;
}

/** One unit's last journal lines, redacted, with the fixed argv the blueprint names. */
async function journalTail(run: RunLogCommand, unit: string, lines: number): Promise<string> {
	const result = await run("journalctl", ["--user", "-u", unit, "-n", String(lines), "--no-pager"], LOG_COMMAND_TIMEOUT_MS);
	const header = `${unit}: last ${lines} journal lines`;
	const empty = `${unit}: the journal has no lines`;
	const note = result.exitCode === 0 ? "" : `\nnote: journalctl exited ${result.exitCode}: ${failureNote(result.stderr, "no stderr")}`;
	if (result.stdout.trim() === "") return `${header}\n${empty}${note}`;
	return `${header}\n${tailOfText(result.stdout, lines, empty)}${note}`;
}

/** A `test` log must be a ledger row's `log` AND a runner's own name after realpath, or it is refused. */
function testLog(deps: LogsReadDeps, name: string, lines: number): string {
	if (!deps.ledgerLogs().includes(name)) throw new LogsReadRefusal(`${name} is not a log path the run ledger recorded`);
	const resolved = resolveTestLogPath(name);
	if (!resolved.ok) throw new LogsReadRefusal(resolved.reason);
	return readLogTail(resolved.path, lines, "test log");
}

/**
 * The path a `test` name resolves to, or why it is refused. The pattern is checked on the name and
 * again on its realpath, so a symlink inside `/tmp` that points elsewhere is refused. A path that no
 * longer exists still passes the pattern check and reads as a plain "no test log yet".
 */
export function resolveTestLogPath(name: string): { ok: true; path: string } | { ok: false; reason: string } {
	if (!TEST_LOG_PATTERNS.some((pattern) => pattern.test(name))) {
		return { ok: false, reason: `${name} is not one of the guarded runners' own logs (/tmp/be-lane-*.log, /tmp/pi-test-*.log)` };
	}
	if (!existsSync(name)) return { ok: true, path: name };
	let real: string;
	try {
		real = realpathSync(name);
	} catch (error) {
		return { ok: false, reason: `${name} could not be resolved (${error instanceof Error ? error.message : String(error)})` };
	}
	if (!TEST_LOG_PATTERNS.some((pattern) => pattern.test(real))) {
		return { ok: false, reason: `${name} resolves to ${real}, outside the guarded runners' own logs` };
	}
	return { ok: true, path: real };
}
