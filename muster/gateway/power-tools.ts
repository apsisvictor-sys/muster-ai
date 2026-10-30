/**
 * Power tools for Henry (grokbot) — added 2026-10-22 on the operator's instruction.
 * Guardrails: kill-switch file (<stateDir>/power-off) disables every tool here; per-call timeout (max 300 s);
 * output cap 64 KiB; every call appended to <stateDir>/power-audit.jsonl (args, exit, bytes, duration);
 * a best-effort secrets-path denylist on commands and file paths; the seat phrase and `seat assign` are
 * refused so the human-typed seat proof stays human. The server's redactor still runs on every result.
 * Denylisting a shell is best effort, not a sandbox: the kill-switch and the audit log are the real controls.
 * The write roots and the secrets denylist are advisory while `wsl_exec` exists: a shell reaches any file the user can.
 * They still hold for file_read, file_write and the tmux and launch paths, which resolve symbolic links before checking (F1, F2).
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, constants, copyFileSync, existsSync, fchmodSync, mkdirSync, openSync, readFileSync, readSync, readlinkSync, realpathSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { redactSensitiveText } from "../../core/self-improving-redactor.ts";
import { auditArgs } from "./state.ts";
import { ToolRefusal, type GatewayTool, type ToolCaller } from "./tools.ts";

export const POWER_MAX_OUTPUT = 64 * 1024;
export const POWER_MAX_TIMEOUT_S = 300;
const DENY = [
	/auth\.json/i, /\/secrets?\//i, /\.ssh\b/i, /(^|[\/\s])\.env(\.|\b)/i, /infisical/i, /credentials?/i,
	/gateway[-_.]?token/i, /monitor[-_.]?token/i, /\.git-credentials/i, /id_(rsa|ed25519)/i, /print-api-key/i,
	/\bseat\s+(assign|claim|rebind)\b/i, /seat_assign/i,
];
const SEAT_PHRASE = /(\/seat\s+(orchestrator|architect|designer))|become the (orchestrator|architect|designer)/i;
const WRITE_ROOTS = (home: string) => [join(home, ".pi/agent"), join(home, "projects"), join(home, ".worktrees"), "/tmp"];
const UNITS = /^(muster-gateway|grokbot-tunnel|musterd|muster-gateway-watchdog|pi-media-mcp|pi-psi-guard|hermes-gateway|hermes-serve)\.service$|^[a-z0-9-]+\.timer$/;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;

/** The path with every symbolic link resolved, also through a missing tail or a dangling link, so a root check and the denylist see where a write or read would really land. */
function resolveReal(p: string, depth = 0): string {
	if (depth > 40) throw new ToolRefusal("too many symbolic links");
	const rest: string[] = [];
	let cur = p;
	for (;;) {
		try { return join(realpathSync(cur), ...rest); } catch { /* missing, or a dangling link */ }
		let link: string | undefined;
		try { link = readlinkSync(cur); } catch { /* not a link */ }
		if (link !== undefined) return resolveReal(join(resolve(dirname(cur), link), ...rest), depth + 1);
		const parent = dirname(cur);
		if (parent === cur) return join(cur, ...rest);
		rest.unshift(basename(cur));
		cur = parent;
	}
}

const q = (x: string) => `'${x.replace(/'/g, "'\\''")}'`;
const piBin = (home: string) => (existsSync(join(home, "bin/pi")) ? join(home, "bin/pi") : "pi");

/** What a call reports to its result line besides success: the exit status of the last process it ran. */
type CallMeta = { exit?: number | null; timedOut?: boolean };
export type PowerDeps = { stateDir: string; home: string; agentDir: string; now?: () => Date };

function str(args: Record<string, unknown>, key: string, required = false): string | undefined {
	const v = args[key];
	if (v === undefined || v === null) { if (required) throw new ToolRefusal(`${key} is required`); return undefined; }
	if (typeof v !== "string") throw new ToolRefusal(`${key} must be a string`);
	return v;
}
function num(args: Record<string, unknown>, key: string, def: number, max: number): number {
	const v = args[key];
	if (v === undefined) return def;
	if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new ToolRefusal(`${key} must be a positive number`);
	return Math.min(v, max);
}
function denied(text: string): void {
	for (const re of DENY) if (re.test(text)) throw new ToolRefusal(`refused by the power-tools denylist (${re.source})`);
}
/** The captured output, with the cut marked and the real size of what the process wrote (counted in bytes, not kept). */
function shown(r: { out: string; total: number }): string {
	return r.total > POWER_MAX_OUTPUT ? `${r.out}\n…[cut at ${POWER_MAX_OUTPUT} bytes of ${r.total}]` : r.out;
}

export function runCapped(cmd: string, argv: string[], opts: { cwd?: string; timeoutS: number; input?: string }): Promise<{ code: number | null; signal: string | null; out: string; total: number; ms: number; timedOut: boolean }> {
	return new Promise((done) => {
		const t0 = Date.now();
		const child = spawn(cmd, argv, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], detached: true });
		let timedOut = false;
		// Keep the first 64 KiB, count the rest: the pipes are still drained so the child never blocks on a full pipe.
		const chunks: Buffer[] = []; let kept = 0; let total = 0;
		const add = (b: Buffer) => { total += b.length; if (kept < POWER_MAX_OUTPUT) { const take = b.subarray(0, POWER_MAX_OUTPUT - kept); chunks.push(take); kept += take.length; } };
		child.stdout.on("data", add); child.stderr.on("data", add);
		const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, opts.timeoutS * 1000);
		child.on("error", (e) => add(Buffer.from(String(e))));
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			const text = Buffer.concat(chunks).toString("utf8");
			done({ code, signal, out: total > kept ? text.replace(/\uFFFD$/, "") : text, total, ms: Date.now() - t0, timedOut });
		});
		child.stdin.end(opts.input ?? "");
	});
}

export function createPowerTools(deps: PowerDeps): GatewayTool[] {
	const off = () => existsSync(join(deps.stateDir, "power-off"));
	const auditFile = join(deps.stateDir, "power-audit.jsonl");
	/** The server audit's scrubbing (secret-named keys, long strings cut) plus the shared redactor; a written file's text is a length and a hash only. */
	const argsText = (tool: string, args: Record<string, unknown>): string => {
		const content = args["content"];
		const shown = tool === "file_write" && typeof content === "string" ? { ...args, content: { bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") } } : args;
		return redactSensitiveText(auditArgs(shown), { preservePaths: true, strictAssignments: true });
	};
	const append = (record: Record<string, unknown>) => {
		const fd = openSync(auditFile, "a", 0o600);
		try { fchmodSync(fd, 0o600); writeSync(fd, `${JSON.stringify(record)}\n`); } finally { closeSync(fd); }
	};
	const stamp = (tool: string, caller: ToolCaller | undefined, phase: "intent" | "result") => ({ at: (deps.now?.() ?? new Date()).toISOString(), tool, role: caller?.role ?? "unknown", phase });
	/** The intent line comes first and a call whose intent cannot be written does not run. The result line is best effort. */
	const guard = <T extends Record<string, unknown>>(name: string, fn: (a: T, meta: CallMeta) => Promise<string>, opts: { whenOff?: true } = {}) => async (a: Record<string, unknown>, caller?: ToolCaller) => {
		try { append({ ...stamp(name, caller, "intent"), args: argsText(name, a) }); } catch { throw new ToolRefusal("the power audit log could not be written, so the call was not made"); }
		const t0 = Date.now();
		const meta: CallMeta = {};
		const result = (extra: Record<string, unknown>) => {
			const ran = { ms: Date.now() - t0, ...(meta.exit !== undefined ? { exit: meta.exit } : {}), ...(meta.timedOut === true ? { timedOut: true } : {}) };
			try { append({ ...stamp(name, caller, "result"), ...extra, ...ran }); } catch { /* the intent line is on record */ }
		};
		if (off() && opts.whenOff !== true) { result({ refused: "kill-switch" }); throw new ToolRefusal(`power tools are off (kill-switch ${join(deps.stateDir, "power-off")} exists)`); }
		try { const r = await fn(a as T, meta); result({ ok: true, bytes: Buffer.byteLength(r) }); return r; }
		catch (e) { result({ refused: e instanceof Error ? e.message : String(e) }); throw e; }
	};
	const shell = async (command: string, cwd: string | undefined, timeoutS: number, meta: CallMeta) => {
		const r = await runCapped("bash", ["-lc", command], { cwd: cwd ?? deps.home, timeoutS });
		meta.exit = r.code; meta.timedOut = r.timedOut;
		return `exit=${r.code}${r.signal ? ` signal=${r.signal}` : ""}${r.timedOut ? " TIMED-OUT" : ""} ms=${r.ms}\n${shown(r)}`;
	};
	/** The real location of a path: the denylist sees both the name given and where it leads, and callers use the real one. */
	const safePath = (p: string) => { const abs = resolve(deps.home, p.replace(/^~(?=\/|$)/, deps.home)); denied(abs); const real = resolveReal(abs); denied(real); return real; };

	const tools: GatewayTool[] = [
		{
			name: "wsl_exec",
			description: "Run one bash command (login shell) in WSL on the operator's PC as user operator. timeout_s default 60, max 300; output (stdout+stderr) capped at 64 KiB; the process group is killed on timeout. Every call is audited to power-audit.jsonl. Refused: secrets paths (auth.json, secrets/, .ssh, .env, tokens, credentials), `seat assign|claim|rebind`. Kill-switch: touch ~/.pi/state/grokbot-gateway/power-off.",
			inputSchema: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" }, timeout_s: { type: "number" } }, required: ["command"], additionalProperties: false },
			run: guard("wsl_exec", async (a, meta) => {
				const command = str(a, "command", true)!;
				if (command.length > 8000) throw new ToolRefusal("command is longer than 8000 characters");
				denied(command);
				if (SEAT_PHRASE.test(command)) throw new ToolRefusal("the seat phrase is the operator's to type");
				const cwd = str(a, "cwd"); return shell(command, cwd === undefined ? undefined : safePath(cwd), num(a, "timeout_s", 60, POWER_MAX_TIMEOUT_S), meta);
			}),
		},
		{
			name: "file_read",
			description: "Read a text file in WSL (absolute or ~/ path). offset (bytes, default 0) and max_bytes (default and max 64 KiB). Secrets paths are refused.",
			inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, max_bytes: { type: "number" } }, required: ["path"], additionalProperties: false },
			run: guard("file_read", async (a) => {
				const p = safePath(str(a, "path", true)!);
				if (!existsSync(p)) throw new ToolRefusal(`no such file: ${p}`);
				const st = statSync(p); if (!st.isFile()) throw new ToolRefusal(`${p} is not a regular file`);
				const off = typeof a["offset"] === "number" && Number.isFinite(a["offset"]) ? Math.max(0, Math.floor(a["offset"] as number)) : 0;
				const want = Math.max(0, Math.min(Math.floor(num(a, "max_bytes", POWER_MAX_OUTPUT, POWER_MAX_OUTPUT)), st.size - off));
				// Only the requested slice is read: a file of any size costs at most 64 KiB of memory.
				const buf = Buffer.alloc(want);
				const fd = openSync(p, "r");
				let got = 0;
				try { if (want > 0) got = readSync(fd, buf, 0, want, off); } finally { closeSync(fd); }
				return `${p} (${st.size} bytes; showing ${off}..${off + got})\n${buf.subarray(0, got).toString("utf8")}`;
			}),
		},
		{
			name: "file_write",
			description: "Write or append a text file under ~/.pi/agent, ~/projects, ~/.worktrees or /tmp (max 256 KiB). An existing file is first copied to <file>.bak-power-<timestamp>. Secrets paths are refused. Symbolic links are resolved before the check. Advisory while wsl_exec exists.",
			inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, mode: { type: "string", enum: ["overwrite", "append"] } }, required: ["path", "content"], additionalProperties: false },
			run: guard("file_write", async (a) => {
				const p = safePath(str(a, "path", true)!);
				if (!WRITE_ROOTS(deps.home).map((r) => resolveReal(r)).some((r) => p === r || p.startsWith(r + "/"))) throw new ToolRefusal(`writes are allowed only under ${WRITE_ROOTS(deps.home).join(", ")}`);
				const content = str(a, "content", true)!;
				if (Buffer.byteLength(content) > 256 * 1024) throw new ToolRefusal("content is larger than 256 KiB");
				let backup = "";
				if (existsSync(p)) {
					// Never replace an earlier backup: a second write in the same millisecond gets a -n suffix.
					const stem = `${p}.bak-power-${Date.now()}`;
					for (let n = 0; ; n++) {
						backup = n === 0 ? stem : `${stem}-${n}`;
						try { copyFileSync(p, backup, constants.COPYFILE_EXCL); break; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST" || n >= 1000) throw e; }
					}
				}
				mkdirSync(dirname(p), { recursive: true });
				if (a["mode"] === "append") appendFileSync(p, content); else writeFileSync(p, content);
				return `wrote ${Buffer.byteLength(content)} bytes to ${p}${backup ? `; previous copy at ${backup}` : ""}`;
			}),
		},
		{
			name: "tmux_control",
			description: "tmux in WSL. action list | capture (session, lines ≤ 500) | send_keys (session, text, enter default true) | new (session, command, cwd) | kill (session; refused for any session not created through this tool's `new` with a gw- prefix). send_keys refuses the seat phrase and secrets paths. Never use it on operator's own sessions.",
			inputSchema: { type: "object", properties: { action: { type: "string", enum: ["list", "capture", "send_keys", "new", "kill"] }, session: { type: "string" }, text: { type: "string" }, enter: { type: "boolean" }, command: { type: "string" }, cwd: { type: "string" }, lines: { type: "number" } }, required: ["action"], additionalProperties: false },
			run: guard("tmux_control", async (a, meta) => {
				const action = str(a, "action", true)!;
				const session = str(a, "session");
				if (action !== "list" && (session === undefined || !SESSION.test(session))) throw new ToolRefusal("session is required and must be a plain tmux session name");
				const run = async (argv: string[]) => { const r = await runCapped("tmux", argv, { timeoutS: 15 }); meta.exit = r.code; return `exit=${r.code}\n${shown(r)}`; };
				switch (action) {
					case "list": return run(["list-sessions"]);
					case "capture": return run(["capture-pane", "-p", "-t", session!, "-S", `-${num(a, "lines", 60, 500)}`]);
					case "send_keys": {
						const text = str(a, "text", true)!;
						if (SEAT_PHRASE.test(text)) throw new ToolRefusal("the seat phrase is the operator's to type; send_keys refuses it");
						denied(text);
						const out = await run(["send-keys", "-t", session!, "-l", text]);
						if (a["enter"] !== false) await run(["send-keys", "-t", session!, "Enter"]);
						return out;
					}
					case "new": {
						const command = str(a, "command", true)!; denied(command);
						const name = session!.startsWith("gw-") ? session! : `gw-${session}`;
						const cwd = safePath(str(a, "cwd") ?? deps.agentDir);
						return run(["new-session", "-d", "-s", name, "-c", cwd, `bash -lc ${q(`${join(deps.agentDir, "scripts/session-launch.sh")} bash -lc ${q(command)}`)}`]).then((r) => `session ${name}\n${r}`);
					}
					case "kill": if (!session!.startsWith("gw-")) throw new ToolRefusal("kill only works on gw- sessions this tool created"); return run(["kill-session", "-t", session!]);
					default: throw new ToolRefusal("unknown action");
				}
			}),
		},
		{
			name: "session_launch",
			description: "Launch a persistent interactive Pi session (any role, incl. orchestrator or architect) in a new tmux session gw-<name>, through scripts/session-launch.sh (sessions.slice). model is provider/id from `pi --list-models`; boot_file is a file whose text is the first prompt. Seats still move only when the operator types /seat <role> in that pane.",
			inputSchema: { type: "object", properties: { name: { type: "string" }, model: { type: "string" }, boot_file: { type: "string" }, cwd: { type: "string" } }, required: ["name", "model"], additionalProperties: false },
			run: guard("session_launch", async (a, meta) => {
				const name = str(a, "name", true)!; if (!SESSION.test(name)) throw new ToolRefusal("name must be a plain session name");
				const model = str(a, "model", true)!; if (!/^[A-Za-z0-9._\/:-]+$/.test(model)) throw new ToolRefusal("model is not a provider/id");
				const boot = str(a, "boot_file"); const bootPath = boot === undefined ? undefined : safePath(boot);
				const cwd = safePath(str(a, "cwd") ?? deps.agentDir);
				const sess = `gw-${name}`;
				const cmd = `${q(join(deps.agentDir, "scripts/session-launch.sh"))} ${q(piBin(deps.home))} --model ${model} --name ${name}${bootPath ? ` "$(cat ${q(bootPath)})"` : ""}`;
				const r = await runCapped("tmux", ["new-session", "-d", "-s", sess, "-c", cwd, `bash -lc ${q(cmd + "; echo session ended; exec bash")}`], { timeoutS: 15 });
				meta.exit = r.code;
				return `exit=${r.code} tmux session ${sess} model ${model}\n${shown(r)}`;
			}),
		},
		{
			name: "model_smoke",
			description: "One tiny non-interactive Pi call (`pi -p --no-session`) against a model to prove it answers. prompt max 500 chars, timeout_s default 90, max 180. Uses the model's existing subscription or key; keep it to one short prompt.",
			inputSchema: { type: "object", properties: { model: { type: "string" }, prompt: { type: "string" }, timeout_s: { type: "number" } }, required: ["model"], additionalProperties: false },
			run: guard("model_smoke", async (a, meta) => {
				const model = str(a, "model", true)!; if (!/^[A-Za-z0-9._\/:-]+$/.test(model)) throw new ToolRefusal("model is not a provider/id");
				const prompt = (str(a, "prompt") ?? "Reply with exactly: PONG").slice(0, 500);
				const r = await runCapped("bash", ["-lc", `pi -p --no-session --model ${q(model)} ${q(prompt)}`], { cwd: "/tmp", timeoutS: num(a, "timeout_s", 90, 180) });
				meta.exit = r.code; meta.timedOut = r.timedOut;
				return `exit=${r.code}${r.timedOut ? " TIMED-OUT" : ""} ms=${r.ms}\n${shown(r)}`;
			}),
		},
		{
			name: "service_control",
			description: "systemctl --user on an allowlisted unit (muster-gateway, grokbot-tunnel, musterd, muster-gateway-watchdog, pi-media-mcp, pi-psi-guard, hermes-gateway, hermes-serve, any .timer). action status | restart | start | stop. Restarting muster-gateway or grokbot-tunnel is deferred 2 s so the answer gets out first.",
			inputSchema: { type: "object", properties: { unit: { type: "string" }, action: { type: "string", enum: ["status", "restart", "start", "stop"] } }, required: ["unit", "action"], additionalProperties: false },
			run: guard("service_control", async (a, meta) => {
				const unit = str(a, "unit", true)!; if (!UNITS.test(unit)) throw new ToolRefusal(`${unit} is not on the allowlist`);
				const action = str(a, "action", true)!;
				if (action === "status") { const r = await runCapped("systemctl", ["--user", "status", "--no-pager", "-n", "20", unit], { timeoutS: 15 }); meta.exit = r.code; return shown(r); }
				if (/^(muster-gateway|grokbot-tunnel)\.service$/.test(unit)) {
					const c = spawn("bash", ["-c", `sleep 2; systemctl --user ${action} ${unit}`], { detached: true, stdio: "ignore" }); c.unref();
					return `${action} of ${unit} scheduled in 2 s`;
				}
				const r = await runCapped("systemctl", ["--user", action, unit], { timeoutS: 60 });
				meta.exit = r.code;
				return `exit=${r.code}\n${shown(r)}`;
			}),
		},
		{
			name: "power_status",
			description: "Whether the power tools are on, the kill-switch path, and the last 20 power-audit lines.",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
			// Answers while the kill switch is on (that is when it is needed) and is audited like every other call (F12).
			run: guard("power_status", async () => {
				const p = join(deps.stateDir, "power-audit.jsonl");
				const tail = existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").slice(-20).join("\n") : "(no audit yet)";
				return `power tools: ${off() ? "OFF" : "ON"}\nkill-switch: ${join(deps.stateDir, "power-off")}\naudit: ${p}\n${tail}`;
			}, { whenOff: true }),
		},
	];
	// The monitor bearer is a different bot with a different job: it never gets a shell (F15).
	return tools.map((tool) => ({ ...tool, chatOnly: true as const }));
}
