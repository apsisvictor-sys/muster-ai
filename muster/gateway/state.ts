/**
 * Grokbot gateway state: where it keeps its files, the bearer token, the
 * append-only audit log and the off switch.
 *
 * Everything lives outside the repo: `~/.pi/state/grokbot-gateway/` for the
 * audit log, the off flag and the pid file, and a token file under
 * `~/.config/grokbot-gateway/` that this module reads and never prints, logs
 * or returns to a caller.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { piAgentDir } from "../binding.ts";

export const AUDIT_FILE = "audit.jsonl";
export const OFF_FLAG_FILE = "disabled";
export const PID_FILE = "gateway.pid";
export const MIN_TOKEN_LENGTH = 32;
/** The bearer's environment name: the gateway's own env source (SK-D11, `operator-personal/services`). */
export const GATEWAY_TOKEN_ENV = "GROKBOT_GATEWAY_TOKEN";
/** The monitor bot's bearer (UM14, SK-D11): its own connection, the only one that lists `dashboard_login`. */
export const MONITOR_TOKEN_ENV = "GROKBOT_MONITOR_TOKEN";
/** The gateway's Concord-style agent id: the orchestrator's outbox for the operator is its inbox. */
export const GATEWAY_AGENT_ID = "grokbot";
/** The sender name on a command center action the operator made on the page (a stop, an answer, a typed message). */
export const PAGE_CALLER = "operator-page";
/** The sender name on the line an answered ask sends its raiser. */
export const CC_AGENT_ID = "command-center";
/** The names only the gateway process writes under. The CLI refuses all of them as an identity (blueprint r5 D4). */
export const RESERVED_SENDERS: readonly string[] = [PAGE_CALLER, CC_AGENT_ID, GATEWAY_AGENT_ID];

/** A refusal for an identity the CLI may not act as, or undefined when the name is free. */
export function reservedSenderRefusal(agentId: string): string | undefined {
	return RESERVED_SENDERS.includes(agentId.trim()) ? `${agentId.trim()} is a reserved sender: only the gateway process writes under that name` : undefined;
}

function home(env: NodeJS.ProcessEnv): string {
	return env["HOME"] ?? homedir();
}

export function gatewayStateDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env["GROKBOT_GATEWAY_STATE_DIR"]?.trim();
	return override ? resolve(override) : join(home(env), ".pi", "state", "grokbot-gateway");
}

export function gatewayTokenFile(env: NodeJS.ProcessEnv = process.env): string {
	const override = env["GROKBOT_GATEWAY_TOKEN_FILE"]?.trim();
	return override ? resolve(override) : join(home(env), ".config", "grokbot-gateway", "token");
}

function ensureDir(dir: string): void {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// ─── Token ───────────────────────────────────────────────────────────────────

function isInside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Read the bearer token: `GATEWAY_TOKEN_ENV` first (SK-D11, from
 * `operator-personal/services`), deleted from `env` as it is read so no lane the
 * gateway launches inherits it, then the token file as the fallback. Refuses a
 * file inside the repo, a file other users can read and a token too short to
 * resist guessing. Errors name the variable or the file, never the token.
 */
export function readGatewayToken(file: string, repoRoots: readonly string[] = [piAgentDir(), join(homedir(), ".pi", "agent")], env: NodeJS.ProcessEnv = process.env): string {
	// Deleted whether or not the value is usable: a misconfigured bearer must not
	// reach a launched lane either, and an empty one must not shadow the file.
	const fromEnv = env[GATEWAY_TOKEN_ENV];
	if (fromEnv !== undefined) delete env[GATEWAY_TOKEN_ENV];
	const envToken = fromEnv?.trim();
	if (envToken !== undefined && envToken !== "") {
		if (envToken.length < MIN_TOKEN_LENGTH) throw new Error(`${GATEWAY_TOKEN_ENV} is shorter than ${MIN_TOKEN_LENGTH} characters`);
		return envToken;
	}
	const path = resolve(file);
	for (const root of repoRoots) {
		if (isInside(resolve(root), path)) throw new Error(`the token file ${path} is inside the repo ${root}; keep it outside`);
	}
	if (!existsSync(path)) throw new Error(`no token file at ${path} (create one with: muster gateway init-token)`);
	if ((statSync(path).mode & 0o077) !== 0) throw new Error(`the token file ${path} is readable by other users; chmod 600 it`);
	const token = readFileSync(path, "utf8").trim();
	if (token.length < MIN_TOKEN_LENGTH) throw new Error(`the token in ${path} is shorter than ${MIN_TOKEN_LENGTH} characters`);
	return token;
}

/**
 * The monitor bot's bearer from `MONITOR_TOKEN_ENV`, deleted from `env` as it is read (as the chat token is),
 * or undefined when it is unset or empty. A value shorter than `MIN_TOKEN_LENGTH` is an error naming the variable.
 */
export function readMonitorToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const raw = env[MONITOR_TOKEN_ENV];
	if (raw !== undefined) delete env[MONITOR_TOKEN_ENV];
	const token = raw?.trim();
	if (token === undefined || token === "") return undefined;
	if (token.length < MIN_TOKEN_LENGTH) throw new Error(`${MONITOR_TOKEN_ENV} is shorter than ${MIN_TOKEN_LENGTH} characters`);
	return token;
}

/** Create a fresh token file (0600). Never overwrites, never returns the token. */
export function initGatewayToken(file: string): string {
	const path = resolve(file);
	ensureDir(dirname(path));
	writeFileSync(path, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
	chmodSync(path, 0o600);
	return path;
}

/** Does the Authorization header carry this token? Constant-time over fixed-size digests. */
export function bearerMatches(header: string | undefined, token: string): boolean {
	const presented = header !== undefined && /^Bearer /i.test(header) ? header.slice(7).trim() : "";
	const a = createHash("sha256").update(presented).digest();
	const b = createHash("sha256").update(token).digest();
	return timingSafeEqual(a, b) && presented !== "";
}

// ─── Audit ───────────────────────────────────────────────────────────────────

export type AuditRecord = {
	at: string;
	/** Tool name, or `(rpc:<method>)` / `(http)` / `(control)` for what is not a tool call. */
	tool: string;
	/** The arguments, scrubbed and cut (see `auditArgs`). */
	args: string;
	/** Bytes of the text the caller received; null when there is no result body. */
	resultBytes: number | null;
	refused: boolean;
	reason?: string;
	/** The bearer role of a tool call (never the token); absent on records that are not tool calls. */
	role?: "chat" | "monitor";
	/** A tool call writes `intent` before it runs and `result` after; other records have no phase. */
	phase?: "intent" | "result";
};

const SECRET_KEY = /token|authorization|password|secret|api[-_]?key/i;
const ARG_STRING_LIMIT = 300;
const ARGS_LIMIT = 2000;

/** The arguments as one audit string: secret-looking keys redacted, long strings cut. */
export function auditArgs(args: unknown): string {
	const text = JSON.stringify(args ?? {}, (key, value: unknown) => {
		if (key !== "" && SECRET_KEY.test(key)) return "[redacted]";
		if (typeof value === "string" && value.length > ARG_STRING_LIMIT) return `${value.slice(0, ARG_STRING_LIMIT)}...[${value.length} chars]`;
		return value;
	});
	return text.length > ARGS_LIMIT ? `${text.slice(0, ARGS_LIMIT)}...` : text;
}

/** Append one record. The file is only ever appended to. */
export function appendAudit(stateDir: string, record: AuditRecord): void {
	ensureDir(stateDir);
	appendFileSync(join(stateDir, AUDIT_FILE), `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "a" });
}

// ─── Off switch ──────────────────────────────────────────────────────────────

export function isGatewayOff(stateDir: string): boolean {
	return existsSync(join(stateDir, OFF_FLAG_FILE));
}

function gatewayPid(stateDir: string): number | undefined {
	try {
		const pid = Number(readFileSync(join(stateDir, PID_FILE), "utf8").trim());
		return Number.isInteger(pid) && pid > 1 ? pid : undefined;
	} catch {
		return undefined;
	}
}

/** Is this pid a running `muster ... gateway serve`? A reused pid must not be signalled. */
function isGatewayProcess(pid: number): boolean {
	try {
		const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
		return cmdline.includes("gateway") && cmdline.includes("serve");
	} catch {
		return false;
	}
}

export function writeGatewayPid(stateDir: string, pid: number): void {
	ensureDir(stateDir);
	writeFileSync(join(stateDir, PID_FILE), `${pid}\n`, { mode: 0o600 });
}

export function removeGatewayPid(stateDir: string): void {
	rmSync(join(stateDir, PID_FILE), { force: true });
}

/**
 * Turn the gateway off: write the flag first, so every request already refuses,
 * then stop the running server. `serve` will not start while the flag exists.
 */
export function turnGatewayOff(stateDir: string, now: () => Date = () => new Date()): { stoppedPid: number | undefined } {
	ensureDir(stateDir);
	writeFileSync(join(stateDir, OFF_FLAG_FILE), `${now().toISOString()}\n`, { mode: 0o600 });
	appendAudit(stateDir, { at: now().toISOString(), tool: "(control)", args: '{"command":"off"}', resultBytes: null, refused: false });
	const pid = gatewayPid(stateDir);
	if (pid !== undefined && isGatewayProcess(pid)) {
		process.kill(pid, "SIGTERM");
		return { stoppedPid: pid };
	}
	return { stoppedPid: undefined };
}

export function turnGatewayOn(stateDir: string, now: () => Date = () => new Date()): void {
	rmSync(join(stateDir, OFF_FLAG_FILE), { force: true });
	appendAudit(stateDir, { at: now().toISOString(), tool: "(control)", args: '{"command":"on"}', resultBytes: null, refused: false });
}

export function gatewayStatus(stateDir: string): { off: boolean; pid: number | undefined; running: boolean } {
	const pid = gatewayPid(stateDir);
	return { off: isGatewayOff(stateDir), pid, running: pid !== undefined && isGatewayProcess(pid) };
}
