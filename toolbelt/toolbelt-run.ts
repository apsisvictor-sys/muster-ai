/**
 * The toolbelt run engine: one `pi-toolbelt` dispatch, its deadline and metadata handling, hints,
 * result rendering and payload preservation. It runs the CLI through an injected `exec`, so the Pi
 * wrapper (pi.exec) and the MCP server (child_process) share one implementation and one set of rules.
 * The CLI stays the only owner of providers, accounts, policy, redaction and the ledger.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
	allOperations,
	deadlineArgs,
	executionControlArgs,
	explainFailure,
	formatAccountResolutionHint,
	formatCatalog,
	formatProjectResolutionHint,
	isProjectResolutionStatus,
	normalizeExecutionControls,
	normalizeOperation,
	parseCatalog,
	planExecutionDeadline,
	surveyControlArgs,
	translateRunAlternative,
	translateToolbeltHint,
	unknownOperationMessage,
	WRAPPER_GRACE_MS,
	type ExecutionControls,
	type ExecutionDeadline,
	type ProjectAccountRegistry,
	type ProviderCatalog,
} from "./toolbelt-operations.js";
import type { ToolbeltAction, ToolbeltParams } from "./toolbelt-tool-spec.ts";

export type OperationMetadata = { adapterTimeoutMs: number; extensionTimeoutMs: number; deadlineVisible: true; abortPropagation: string };
export type ToolbeltRunResult = { ok: boolean; text: string; details: Record<string, unknown>; infrastructureFailure?: "aborted" | "timed_out" | "killed" | "nonzero_exit" | "metadata_unavailable" };

/** Session identity that scopes preserved full payloads. */
export type ToolbeltPayloadScope = { sessionDir: string; sessionId: string };
/** A preserved uncapped payload the model can re-read by path. */
export type ToolbeltPayloadReference = { id: string; path: string; chars: number };
/**
 * Outcome of trying to preserve an uncapped payload. "unavailable" is
 * reported to the model; it never changes the provider's success or exit
 * status, only the truthfulness of the recovery note.
 */
export type ToolbeltPayloadPreservation =
	| { status: "preserved"; reference: ToolbeltPayloadReference }
	| { status: "unavailable"; reason: string };


export const DEFAULT_EXTENSION_TIMEOUT_MS = 120_000;
export const MIN_EXTENSION_TIMEOUT_MS = 5_000;
export const MAX_EXTENSION_TIMEOUT_MS = 43_215_000;

/** How the engine runs the CLI. The Pi wrapper passes `pi.exec`; the MCP server passes a child_process runner. */
export type ToolbeltExec = (
	command: string,
	args: string[],
	options: { cwd: string; signal?: AbortSignal; timeout?: number },
) => Promise<{ stdout?: string; stderr?: string; code: number; killed?: boolean }>;

/** Per-call inputs: the caller's directory and the agent name the CLI writes to its ledger. */
export type ToolbeltCall = {
	cwd: string;
	signal?: AbortSignal | undefined;
	agent: string;
	onMetadata?: ((metadata: OperationMetadata) => void) | undefined;
	session?: ToolbeltPayloadScope | undefined;
};

export type ToolbeltRunnerOptions = { exec: ToolbeltExec; bin: string; textCap?: number };

export function createToolbeltRunner(options: ToolbeltRunnerOptions) {
	const { exec, bin } = options;
	const textCap = options.textCap ?? TOOLBELT_TEXT_CAP;
	/** Per-session provider catalogues, so `discover` is spawned at most once each. */
	const catalogCache = new Map<string, ProviderCatalog | null>();
	/** Providers whose operation list has already been shown to the model. */
	const disclosed = new Set<string>();
	/** Per-session non-secret project/account registry from `accounts --json`. */
	let accountsRegistry: ProjectAccountRegistry | undefined;
	let accountsRegistryLoaded = false;

	async function loadCatalog(
		provider: string,
		cwd: string,
		signal: AbortSignal | undefined,
	): Promise<ProviderCatalog | undefined> {
		const cached = catalogCache.get(provider);
		if (cached !== undefined) return cached ?? undefined;
		let catalog: ProviderCatalog | undefined;
		try {
			const result = await execToolbelt(["discover", "--json", "--provider", provider], { cwd, signal });
			// `details` IS the parsed discover envelope. Reading `details.stdout`
			// asked the envelope for a field only raw-stdout envelopes carry, so the
			// catalogue never loaded and every curated call fell back to guessing.
			catalog = parseCatalog(result.details, provider)
				?? parseCatalog(parseJsonObject(String(result.details.stdout ?? "")), provider);
		} catch {
			catalog = undefined;
		}
		catalogCache.set(provider, catalog ?? null);
		return catalog;
	}

	/**
	 * Load the non-secret `accounts --json` registry once per session. The
	 * `accounts.json` source is the canonical project/alias store; calling the
	 * official CLI bridge keeps the wrapper aligned with whatever the source of
	 * truth currently reads, including any drift tests want to surface.
	 */
	async function loadAccountRegistry(
		cwd: string,
		signal: AbortSignal | undefined,
	): Promise<ProjectAccountRegistry | undefined> {
		if (accountsRegistryLoaded) return accountsRegistry;
		accountsRegistryLoaded = true;
		try {
			const result = await execToolbelt(["accounts", "--json"], { cwd, signal });
			// Success shape: `details` is the parsed accounts envelope. Failure
			// shape (non-JSON stdout): `details` carries the raw stdout instead.
			const rawStdout = typeof result.details.stdout === "string" ? result.details.stdout : undefined;
			let parsed = rawStdout !== undefined ? parseJsonObject(rawStdout) : result.details;
			if (!parsed) {
				try {
					parsed = parseJsonObject(readFileSync(join(process.env.PI_TOOLBELT_HOME ?? join(homedir(), ".pi", "agent", "toolbelt"), "data", "accounts.json"), "utf8"));
				} catch {
					// The registry is optional; provider failure diagnostics must remain fail-open.
				}
			}
			if (parsed) {
				const accounts = Array.isArray(parsed.accounts)
					? parsed.accounts as Array<{ alias: string; provider?: string; enabled?: boolean }>
					: parsed.accounts && typeof parsed.accounts === "object"
						? Object.entries(parsed.accounts as Record<string, unknown>).flatMap(([alias, value]) => {
							if (!value || typeof value !== "object") return [];
							const entry = value as { provider?: unknown; enabled?: unknown };
							return [{ alias, provider: typeof entry.provider === "string" ? entry.provider : undefined, enabled: entry.enabled !== false }];
						})
						: [];
				const projects = parsed.projects && typeof parsed.projects === "object" && !Array.isArray(parsed.projects)
					? parsed.projects as Record<string, Record<string, string>>
					: {};
				accountsRegistry = { accounts, projects };
			}
		} catch {
			// Registry is optional — the post-flight hint will simply degrade.
		}
		return accountsRegistry;
	}

	async function runToolbelt(params: ToolbeltParams, call: ToolbeltCall): Promise<ToolbeltRunResult> {
		const { cwd, signal, agent, onMetadata, session } = call;
		const provider = params.provider ?? params.service;
		// Fail fast on unusable execution controls: a relative cwd or a zero
		// timeout would otherwise be resolved or defaulted silently by the CLI.
		const { controls, issues } = normalizeExecutionControls({
			cwd: params.cwd,
			timeoutMs: params.timeoutMs,
			stdinFile: params.stdinFile,
			allowUnlisted: params.allowUnlisted,
			fast: params.fast,
			all: params.all,
		});
		if (issues.length > 0) {
			return {
				ok: false,
				text: `fail ${provider ?? "toolbelt"} invalid_execution_controls | msg=${issues.join("; ")}`,
				details: { ok: false, status: "invalid_execution_controls", issues, valuesPrinted: false },
			};
		}
		const deadline = planExecutionDeadline(controls.timeoutMs, Date.now());
		let effective = params;
		let preamble = "";

		// Resolve the operation against the provider's real catalogue before
		// spending a subprocess on it. 24 of 66 observed failures were invented
		// operation names, and the shipped error returned five fuzzy matches
		// rather than the answer — so a miss now returns the whole catalogue.
		if (normalizeAction(params.action) === "call" && provider && params.operation) {
			const catalog = await loadCatalog(provider, cwd, signal);
			if (catalog) {
				const resolved = normalizeOperation(params.operation, catalog);
				if (!resolved) {
					disclosed.add(provider);
					return {
						ok: false,
						text: unknownOperationMessage(provider, params.operation, catalog),
						details: { provider, operation: params.operation, resolved: false, operations: allOperations(catalog) },
					};
				}
				if (resolved !== params.operation) effective = { ...params, operation: resolved };
				// Show the catalogue once per provider per session, so the second
				// call onwards is informed rather than corrected.
				if (!disclosed.has(provider)) {
					disclosed.add(provider);
					preamble = `${formatCatalog(provider, catalog)}\n`;
				}
			}
		}

		const result = await execToolbelt(paramsToCliArgs(effective, agent, controls, deadline), { cwd, signal, onMetadata, deadline, session });
		const renamed = effective.operation !== params.operation ? `resolved operation ${params.operation} → ${effective.operation}\n` : "";

		// Append a self-correcting hint when the bin returned a structured
		// resolver failure. We never rewrite the upstream error text — only add a
		// line the model can act on, and only when the registry has evidence to
		// share. Secret-shaped values are never read by the registry loader.
		if (!result.ok && result.details && isProjectResolutionStatus((result.details as Record<string, unknown>).status)) {
			const detail = result.details as Record<string, unknown>;
			const registry = await loadAccountRegistry(cwd, signal);
			const hint = detail.status === "unknown_project"
				? formatProjectResolutionHint(registry, params.project ?? String(detail.project ?? ""))
				: formatAccountResolutionHint(registry, detail, provider);
			if (hint) {
				return {
					...result,
					text: `${renamed}${preamble}${result.text}\n${hint}`,
					details: { ...result.details, projectResolutionHint: hint },
				};
			}
		}

		return preamble || renamed ? { ...result, text: `${renamed}${preamble}${result.text}` } : result;
	}


	/**
	 * One `pi-toolbelt` dispatch.
	 *
	 * `deadline` is the caller's planned budget. The wrapper waits
	 * `wrapperTimeoutMs` (budget + `WRAPPER_GRACE_MS`) so the CLI can emit its own
	 * structured timeout envelope before any SIGTERM lands; a flat wrapper timeout
	 * equal to the CLI's own provider timeout raced it and the diagnosis was lost.
	 */
	async function execToolbelt(
		args: string[],
		options: {
			cwd: string;
			signal?: AbortSignal;
			onMetadata?: (metadata: OperationMetadata) => void;
			deadline?: ExecutionDeadline;
			timeoutMs?: number;
			session?: ToolbeltPayloadScope;
		},
	): Promise<ToolbeltRunResult> {
		const startedAt = Date.now();
		const { cwd, signal, onMetadata, deadline, session } = options;
		const action = args[0];
		// `run` with no explicit budget must not impose a short cap of its own: the
		// CLI already enforces its per-command default, and a wrapper kill at the
		// same instant would replace the CLI's structured timeout with a SIGTERM.
		// The physical ceiling is the only remaining backstop.
		let timeout = options.timeoutMs ?? deadline?.wrapperTimeoutMs ?? (action === "run" ? MAX_EXTENSION_TIMEOUT_MS : DEFAULT_EXTENSION_TIMEOUT_MS);
		let metadata: OperationMetadata | null = null;
		if (action === "call") {
			metadata = await resolveOperationMetadata(args, cwd, signal);
			if (!metadata) {
				const details = { ok: false, status: "operation_metadata_unavailable", message: "Toolbelt refused dispatch because a bounded adapter deadline could not be established.", valuesPrinted: false };
				return { ok: false, text: "fail operation_metadata_unavailable", details, infrastructureFailure: "metadata_unavailable" };
			}
			onMetadata?.(metadata);
			// The adapter-declared bound is the contract for curated calls; a caller
			// budget may tighten it, never loosen it.
			timeout = boundedOperationTimeout(metadata.extensionTimeoutMs);
			if (deadline) timeout = Math.min(timeout, deadline.wrapperTimeoutMs);
			else args = [...args, ...deadlineArgs({ timeoutMs: timeout, deadlineAt: Date.now() + timeout, graceMs: WRAPPER_GRACE_MS, wrapperTimeoutMs: timeout })];
		}
		const result = await exec(bin, args, { cwd, signal, timeout });
		const stdout = result.stdout ?? "";
		const stderr = result.stderr ?? "";
		const parsed = parseJsonObject(stdout);
		const aborted = signal?.aborted === true;
		const killed = Boolean(result.killed);
		// With no parseable envelope, the raw streams ARE the payload — keep both the
		// structured copy and a truthful status instead of dumping the wrapper's own
		// diagnostics JSON at the model.
		const details: Record<string, unknown> = parsed ?? {
			ok: result.code === 0 && !killed && !aborted,
			status: aborted ? "aborted" : killed ? "killed" : result.code === 0 ? "no_json_output" : "nonzero_exit",
			message: aborted
				? "The tool call was cancelled before pi-toolbelt returned output."
				: killed
					? "pi-toolbelt was killed before it returned a JSON envelope (wrapper timeout or signal)."
					: result.code === 0
						? "pi-toolbelt returned no JSON envelope."
						: `pi-toolbelt exited ${result.code} without a JSON envelope; see stderr.`,
			stdout,
			stderr,
		};
		// Never clobber the envelope's own provider stderr with the outer CLI's.
		if (stderr.trim() && typeof details.stderr !== "string") details.stderr = stderr.trim();
		// Timeout is a lifecycle fact only when the envelope's own execution
		// metadata says so. Provider payloads legitimately carry `timedOut: true` of
		// their own — `vercel status` reports `data.whoami.timedOut` for one probe —
		// and the old recursive search classified that as a Toolbelt failure,
		// discarding a successful envelope.
		const timedOut = envelopeTimedOut(details);
		const ok = result.code === 0 && !killed && !aborted && details.ok !== false;
		const summary = summarizeToolbeltDetailed(parsed ?? details, ok, textCap);
		// A result the inline cap cut short keeps its uncapped rendering on disk,
		// session-scoped, and names that file in the text the model receives. The
		// payload is written from the source rendering, never from the truncated
		// copy the model already has. When preservation is impossible the text says
		// so explicitly: a truncated result must never read as recoverable.
		const preservation = summary.truncated ? preserveToolbeltPayload(session, summary.fullText) : undefined;
		const outputNote = providerOutputNote(details);
		// A parsed envelope's `exitCode` is the provider CLI's own and must survive:
		// the wrapper exits 0 whenever the CLI produced an envelope at all. The outer
		// status lives on `details.wrapper`. Only the raw (non-envelope) fallback,
		// which carries no provider status, reports the wrapper's code here.
		if (!parsed) details.exitCode = result.code;
		details.killed = killed;
		if (details.deadline === undefined) details.deadline = {
			timeoutMs: timeout,
			deadlineAt: deadline?.deadlineAt ?? null,
			graceMs: deadline?.graceMs ?? null,
			visible: true,
			// Honest cancellation state: an attached-but-unaborted signal cancelled
			// nothing, which the old `Boolean(signal)` field claimed it had.
			abortSignalAttached: signal !== undefined,
			aborted,
			metadata,
		};
		details.wrapper = {
			action,
			exitCode: result.code,
			killed,
			durationMs: Date.now() - startedAt,
			timeoutMs: timeout,
			deadlineAt: deadline?.deadlineAt ?? null,
			graceMs: deadline?.graceMs ?? null,
			abortSignalAttached: signal !== undefined,
			aborted,
			output: {
				stdoutPresent: stdout.trim() !== "",
				stderrPresent: stderr.trim() !== "",
				stdoutChars: stdout.length,
				stderrChars: stderr.length,
				stdinUsed: details.stdinFileUsed === true,
				suppressed: outputNote !== undefined,
				suppressionReason: outputNote ?? null,
			},
			summary: {
				cap: textCap,
				truncated: summary.truncated,
				sections: summary.sections,
				...(preservation?.status === "preserved"
					? { fullPayload: { id: preservation.reference.id, path: preservation.reference.path, chars: preservation.reference.chars } }
					: preservation?.status === "unavailable"
						? { fullPayloadUnavailable: { reason: preservation.reason } }
						: {}),
			},
			valuesPrinted: false,
		};
		const infrastructureFailure = aborted
			? "aborted"
			: timedOut
				? "timed_out"
				: killed
					? "killed"
					: result.code !== 0
						? "nonzero_exit"
						: undefined;
		if (infrastructureFailure) {
			details.lifecycle = { aborted, timedOut, killed, exitCode: result.code, classification: infrastructureFailure, abortSignalAttached: signal !== undefined };
		}
		const preservationNote = preservation
			? preservation.status === "preserved"
				? toolbeltPayloadReferenceLine(preservation.reference, textCap)
				: toolbeltPayloadUnavailableLine(preservation.reason, textCap)
			: undefined;
		return { ok, text: preservationNote ? `${summary.text}\n${preservationNote}` : summary.text, details, infrastructureFailure };
	}


	async function resolveOperationMetadata(
		args: string[],
		cwd: string,
		signal?: AbortSignal,
	): Promise<OperationMetadata | null> {
		const metaArgs = operationMetadataArgs(args);
		if (!metaArgs) return null;
		const result = await exec(bin, metaArgs, { cwd, signal, timeout: 10_000 });
		if (result.code !== 0) return null;
		const parsed = parseJsonObject(result.stdout ?? "");
		if (!parsed || parsed.ok !== true || parsed.deadlineVisible !== true) return null;
		const adapterTimeoutMs = boundedOperationTimeout(parsed.adapterTimeoutMs);
		const extensionTimeoutMs = boundedOperationTimeout(parsed.extensionTimeoutMs);
		if (extensionTimeoutMs < adapterTimeoutMs) return null;
		return {
			adapterTimeoutMs,
			extensionTimeoutMs,
			deadlineVisible: true,
			abortPropagation: typeof parsed.abortPropagation === "string" ? parsed.abortPropagation : "extension_signal_to_process",
		};
	}


	return {
		runToolbelt,
		/** One raw dispatch with the CLI's own argv; used by the Pi /toolbelt command. */
		execToolbelt: (args: string[], call: { cwd: string; signal?: AbortSignal | undefined; session?: ToolbeltPayloadScope | undefined }) => execToolbelt(args, call),
	};
}

/**
 * Timeout classification reads only the envelope's own execution metadata.
 * Provider payloads (`data`, `stdout`, ...) are the provider's business and
 * may contain a `timedOut` of their own; recursing into them made an ordinary
 * provider result look like a Toolbelt lifecycle failure.
 */
function envelopeTimedOut(details: Record<string, unknown>): boolean {
	if (details.timedOut === true) return true;
	if (details.status === "timeout") return true;
	const lifecycle = details.lifecycle;
	return Boolean(lifecycle && typeof lifecycle === "object" && (lifecycle as Record<string, unknown>).timedOut === true);
}

/**
 * Why the provider's raw output is absent. The core withholds `stdout` when a
 * sensitive-data sanitizer applies (the sanitized payload travels in `data`)
 * and reports `outputSuppressed` directly when nothing safe remains. Without a
 * note either case reads as a silently empty success.
 */
function providerOutputNote(details: Record<string, unknown>): string | undefined {
	if (details.outputSuppressed === true) {
		const reason = details.outputSuppressedReason;
		return typeof reason === "string" && reason.trim() !== ""
			? reason
			: "the provider's raw output was withheld by the sensitive-data policy";
	}
	if (typeof details.sanitized === "string" && details.stdout === undefined) {
		return `raw output withheld by the ${details.sanitized} sanitizer; the sanitized payload is above`;
	}
	return undefined;
}

export function boundedOperationTimeout(value: unknown): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return DEFAULT_EXTENSION_TIMEOUT_MS;
	return Math.max(MIN_EXTENSION_TIMEOUT_MS, Math.min(Math.trunc(parsed), MAX_EXTENSION_TIMEOUT_MS));
}

function flagValue(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index !== -1 && index + 1 < args.length) return args[index + 1];
	const inline = args.find((arg) => arg.startsWith(`${name}=`));
	return inline?.slice(name.length + 1);
}

export function operationMetadataArgs(args: string[]): string[] | null {
	if (args[0] !== "call") return null;
	const provider = flagValue(args, "--provider") ?? (args[1] && !args[1].startsWith("--") ? args[1] : undefined);
	const operation = flagValue(args, "--operation") ?? (args[2] && !args[2].startsWith("--") ? args[2] : "status");
	if (!provider) return null;
	const out = ["operation-meta", "--provider", provider, "--operation", operation, "--json", "--agent", "pi-extension-meta"];
	const operationArgs = flagValue(args, "--args");
	if (operationArgs) out.push("--args", operationArgs);
	return out;
}

/** Default cap on the readable body the model receives. The uncapped payload is preserved on disk and referenced inline. */
export const TOOLBELT_TEXT_CAP = 32_000;
/** Subdirectory of the session directory holding uncapped Toolbelt payloads. */
const TOOLBELT_PAYLOAD_DIR_NAME = "toolbelt-results";
/** Hints are bounded, but long enough to carry a provider error line verbatim. */
const TOOLBELT_HINT_CAP = 400;

type ToolbeltSection = { label: string; text: string };

function textSection(label: string, value: unknown): ToolbeltSection | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.replace(/\s+$/, "");
	return text.trim() === "" ? undefined : { label, text };
}

function payloadSection(label: string, value: unknown): ToolbeltSection | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") return textSection(label, value);
	// false and 0 are results, not absences — JSON.stringify keeps them.
	if (typeof value === "number" || typeof value === "boolean") return { label, text: JSON.stringify(value) };
	try {
		return { label, text: JSON.stringify(value, null, 1) };
	} catch {
		return undefined;
	}
}

/**
 * Everything the command actually produced, in priority order. `details` never
 * reaches the model, so each of these has to be rendered here or it is lost:
 * `run` puts plain provider output in `stdout`, and that was dropped entirely,
 * leaving "ok vercel run success" with no command output at all.
 */
function toolbeltSections(parsed: Record<string, unknown>): ToolbeltSection[] {
	const candidates = [
		textSection("text", parsed.text),
		textSection("stdout", parsed.stdout),
		textSection("stderr", parsed.stderr),
		payloadSection("data", parsed.data),
		payloadSection("cli", parsed.cli),
	];
	// `parseJsonObject` wraps a non-object JSON payload (false, 0, "x") as
	// {value} so a scalar result is not mistaken for an empty response.
	if (Object.keys(parsed).length === 1 && "value" in parsed) candidates.push(payloadSection("value", parsed.value));
	const seen = new Set<string>();
	const sections: ToolbeltSection[] = [];
	for (const candidate of candidates) {
		if (!candidate) continue;
		const key = candidate.text.trim();
		if (seen.has(key)) continue; // never repeat bytes the model already has
		seen.add(key);
		sections.push(candidate);
	}
	return sections;
}

function boundText(value: string, cap: number, note: string): { text: string; truncated: boolean } {
	if (value.length <= cap) return { text: value, truncated: false };
	return { text: `${value.slice(0, cap)}\n${note}`, truncated: true };
}

/**
 * Directory holding this session's preserved payloads. The name is scoped by
 * the session directory Pi assigned and the session id, so a session reads
 * its own payloads from its own directory. That is a naming convention, not
 * an access boundary: the read and bash tools can open any local file the
 * user can read, exactly as intended. An unusual session id is hashed rather
 * than trusted as a path segment, keeping the write inside the session
 * directory.
 */
function resolveToolbeltPayloadDir(scope: ToolbeltPayloadScope): string | undefined {
	const sessionDir = scope.sessionDir.trim();
	const sessionId = scope.sessionId.trim();
	if (!sessionDir || !sessionId) return undefined;
	const segment = /^[A-Za-z0-9._-]+$/.test(sessionId) && sessionId !== "." && sessionId !== ".."
		? sessionId
		: `session-${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}`;
	let root: string;
	try {
		root = realpathSync(resolve(sessionDir));
	} catch {
		return undefined;
	}
	const dir = resolve(root, TOOLBELT_PAYLOAD_DIR_NAME, segment);
	return dir.startsWith(`${root}${sep}`) ? dir : undefined;
}

/** Refuse pre-existing links before writing or changing artifact permissions. */
function ensurePrivatePayloadDirectory(path: string): void {
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	if (!lstatSync(path).isDirectory()) throw Object.assign(new Error("Unsafe payload directory"), { code: "ELOOP" });
	const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		fchmodSync(fd, 0o700);
	} finally {
		closeSync(fd);
	}
}

/**
 * Preserve the uncapped rendering of a truncated result as plain text. Plain
 * text, not JSON, because recovery is the read tool and local shell slicing:
 * the model re-reads or slices the tail the inline cap cut off, and the bytes
 * stay exactly the redacted provider payload's rendering rather than a second
 * copy of the truncated text.
 *
 * The artifact is created owner-only (directory 0700, file 0600). A failed
 * write never changes the provider's success or exit status, but it must not
 * silently read as recoverable either, so it returns "unavailable" together
 * with the reason the model-visible text will carry.
 */
function preserveToolbeltPayload(scope: ToolbeltPayloadScope | undefined, text: string): ToolbeltPayloadPreservation {
	if (!scope) return { status: "unavailable", reason: "no session identity was available to scope the payload" };
	if (text === "") return { status: "unavailable", reason: "the rendered payload was empty" };
	const dir = resolveToolbeltPayloadDir(scope);
	if (!dir) return { status: "unavailable", reason: "the session identity could not be mapped to a session directory" };
	const id = `toolbelt-result-${createHash("sha256").update(text).digest("hex").slice(0, 24)}`;
	// A fresh exclusive file never follows or truncates an existing artifact,
	// symlink or hard link, even for repeated identical provider responses.
	const path = join(dir, `${id}-${randomUUID()}.txt`);
	try {
		ensurePrivatePayloadDirectory(dirname(dir));
		ensurePrivatePayloadDirectory(dir);
		const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		try {
			fchmodSync(fd, 0o600);
			writeFileSync(fd, text, "utf8");
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		const code = (error as { code?: string } | null)?.code;
		return { status: "unavailable", reason: `the payload file could not be written${code ? ` (${code})` : ""}` };
	}
	return { status: "preserved", reference: { id, path, chars: text.length } };
}

/**
 * The model-visible pointer to a preserved payload. `content` is the only
 * channel that reaches the model — `details` does not — so the reference has
 * to travel in the text, and it has to name the recovery action, because a
 * bare path is not an instruction. The file can hold a single line longer
 * than read's 50KB output cap, and read cannot page inside a line, so the
 * pointer also names the local character slice that recovers the tail
 * without re-running the provider.
 */
function toolbeltPayloadReferenceLine(reference: ToolbeltPayloadReference, cap: number): string {
	return `full=${reference.path} (redacted, ${reference.chars} chars; read this file for everything past the first ${cap}. If a single line is longer than read's 50KB output cap, slice the tail locally, e.g. bash: tail -c 8000 '${reference.path}' — a byte slice on the text file, so increase the count for multibyte payloads)`;
}

/**
 * The model-visible warning when a truncated result could not be preserved.
 * The provider's own success and exit status are untouched by a local write
 * failure, but the text must never imply the missing payload is recoverable.
 */
function toolbeltPayloadUnavailableLine(reason: string, cap: number): string {
	return `full=unavailable (the result was truncated at ${cap} chars and the uncapped payload could not be preserved: ${reason}; it is not recoverable from this session without re-running the command)`;
}

/**
 * The summary plus the details the caller needs to describe what happened
 * (`truncated`, `sections`). `summarizeToolbelt` stays the string-only entry
 * point for display.
 */
export function summarizeToolbeltDetailed(
	parsed: Record<string, unknown>,
	ok: boolean,
	cap: number = TOOLBELT_TEXT_CAP,
): { text: string; truncated: boolean; sections: string[]; fullText: string } {
	const sections = toolbeltSections(parsed);
	const hint = translateToolbeltHint(parsed.hint);
	const errMsg = (parsed.error as { message?: string } | undefined)?.message || parsed.message;
	// Adapters that fail inside a sub-command carry no top-level message, which
	// produced the unactionable "fail vercel status error" — 39 of 66 observed
	// failures. Dig the real reason (timeout / exit code / stderr) out instead.
	const reason = typeof errMsg === "string" ? errMsg : !ok ? explainFailure(parsed) : undefined;
	// A `call` adapter can still refuse a curated operation. The executable
	// alternative is the CLI's own `run` line, rendered as a real tool call; the
	// legacy approval flag is named only as an adapter-specific option, never as
	// a second gate. An unlisted `run` command executes and carries a menu note,
	// so there is no compulsory allowUnlisted step.
	const runAlternative = typeof parsed.runAlternative === "string"
		? parsed.runAlternative
		: typeof parsed.runAlternativeHint === "string"
			? parsed.runAlternativeHint
			: undefined;
	const alternative = runAlternative
		? translateRunAlternative(runAlternative) ?? translateToolbeltHint(runAlternative)
		: undefined;
	const legacyApproval = parsed.status === "approval_required" && Array.isArray(parsed.required) && (parsed.required as unknown[]).includes("--confirm-mutating")
		? "legacy call adapter refused; the same command runs directly through action:'run' (no approval flag), or pass confirmMutating:true with a non-empty reason for this adapter only"
		: undefined;
	// Honest coverage: say when the command was outside the cached menu, and
	// when there was no menu to check it against at all.
	const menuNote = typeof parsed.menuNote === "string" && parsed.menuNote.trim() !== ""
		? parsed.menuNote
		: parsed.menuChecked === false && typeof parsed.command === "string"
			? "no cached menu for this provider, so the command was not checked against an index"
			: undefined;
	const flagCollision = typeof parsed.flagCollisionNote === "string" ? parsed.flagCollisionNote : undefined;
	const outputNote = providerOutputNote(parsed);
	const stdinNote = parsed.stdinFileUsed === true
		? "the provider CLI read its stdin from the stdinFile path (contents never printed)"
		: undefined;
	const tail = [
		reason ? `msg=${boundText(reason, 200, "…").text}` : "",
		hint ? `hint=${boundText(hint, TOOLBELT_HINT_CAP, "…").text}` : "",
		alternative ? `alt=${boundText(alternative, TOOLBELT_HINT_CAP, "…").text}` : "",
		legacyApproval ? `next=${legacyApproval}` : "",
		menuNote ? `menu=${boundText(menuNote, TOOLBELT_HINT_CAP, "…").text}` : "",
		flagCollision ? `flags=${boundText(flagCollision, TOOLBELT_HINT_CAP, "…").text}` : "",
		outputNote ? `suppressed=${boundText(outputNote, TOOLBELT_HINT_CAP, "…").text}` : "",
		stdinNote ? `stdin=${stdinNote}` : "",
	].filter(Boolean).join(" | ");

	// Commands whose whole purpose is to deliver text to the model (menu, find,
	// providers) put it in `text`. Summarising those produced "ok supabase" with
	// the entire 5,000-character menu discarded, which is why Toolbelt looked
	// like it could not expose provider commands at all.
	const passthrough = parsed.text;
	if (typeof passthrough === "string" && passthrough.trim() !== "") {
		const bounded = boundText(
			passthrough,
			cap,
			`… truncated at ${cap} chars; narrow the request (menu <provider> <group>, or find with --provider)`,
		);
		return {
			text: tail ? `${bounded.text}\n${tail}` : bounded.text,
			truncated: bounded.truncated,
			sections: sections.map((section) => section.label),
			// The source rendering before the cap: the uncapped passthrough plus
			// every other payload section the non-passthrough renderer would have
			// shown, so a preserved artifact cannot lose stdout/data that the
			// text-first inline rendering leaves out. The inline text keeps
			// preferring `text` and is unchanged for ordinary responses.
			fullText: [passthrough, ...sections.slice(1).map((section) => section.text), ...(tail ? [tail] : [])].join("\n"),
		};
	}

	const provider = parsed.provider as string | undefined;
	const operation = parsed.operation as string | undefined;
	const status = parsed.status as string | undefined;
	const head = [ok ? "ok" : "fail", provider, operation, status].filter(Boolean).join(" ") || (ok ? "ok" : "fail");
	const counts: string[] = [];
	for (const [k, v] of Object.entries(parsed)) {
		if (Array.isArray(v)) counts.push(`${k}=${v.length}`);
		else if (v && typeof v === "object" && Array.isArray((v as { items?: unknown[] }).items)) counts.push(`${k}.items=${(v as { items: unknown[] }).items.length}`);
	}
	const summaryLine = [head, counts.join(" "), tail].filter(Boolean).join(" | ");

	let budget = cap;
	const rendered: string[] = [];
	const included: string[] = [];
	let truncated = false;
	for (const section of sections) {
		if (budget <= 0) {
			truncated = true;
			break;
		}
		if (section.text.length <= budget) {
			rendered.push(section.text);
			included.push(section.label);
			budget -= section.text.length;
			continue;
		}
		// Truncate at the display boundary, never in the source: the untruncated
		// payload is already in `details`.
		rendered.push(`${section.text.slice(0, budget)}\n… truncated at ${cap} chars (${section.label}); narrow the request with a limit or a narrower command`);
		included.push(section.label);
		truncated = true;
		budget = 0;
	}
	return {
		text: rendered.length > 0 ? `${summaryLine}\n${rendered.join("\n")}` : summaryLine,
		truncated,
		sections: included,
		fullText: sections.length > 0 ? `${summaryLine}\n${sections.map((section) => section.text).join("\n")}` : summaryLine,
	};
}

export function summarizeToolbelt(parsed: Record<string, unknown>, ok: boolean): string {
	return summarizeToolbeltDetailed(parsed, ok).text;
}

export function paramsToCliArgs(
	params: ToolbeltParams,
	agent: string,
	controls: ExecutionControls = {},
	deadline?: ExecutionDeadline,
): string[] {
	const action = normalizeAction(params.action);
	const args = [action, "--json", "--agent", agent];
	const provider = params.provider ?? params.service;
	if (provider) args.push("--provider", provider);
	if (params.operation) args.push("--operation", params.operation);
	if (params.project) args.push("--project", params.project);
	if (params.account) args.push("--account", params.account);
	if (params.dryRun) args.push("--dry-run");
	// Legacy approval fields. Forwarded because the CLI still parses them and a
	// caller may still pass them; they are not gates, and the approval that
	// matters is the conversation in chat.
	if (params.confirmMutating) args.push("--confirm-mutating");
	if (params.reason) args.push("--reason", params.reason);
	if (params.name) args.push("--name", params.name);
	if (params.target) args.push("--target", params.target);
	if (params.kind) args.push("--kind", params.kind);
	if (params.limit !== undefined) args.push("--limit", String(params.limit));
	if (params.specPath) args.push("--spec", params.specPath);
	if (params.confirmDestructive) args.push("--confirm-destructive");
	if (params.query) args.push("--query", params.query);
	if (params.args && Object.keys(params.args).length > 0) args.push("--args", JSON.stringify(params.args));
	// Execution controls (--cwd/--timeout-ms/--stdin-file) and the overall
	// --deadline-ms are Toolbelt flags: they must precede the `--` separator,
	// because everything after it is the provider CLI's own argv. The survey
	// controls (--fast/--all) are Toolbelt flags too, and travel the same way.
	if (action === "run" || action === "call") {
		args.push(...executionControlArgs(controls));
		args.push(...deadlineArgs(deadline));
	} else {
		args.push(...surveyControlArgs(controls));
	}
	// menu takes its group positionally; run passes everything after `--` to the
	// provider CLI verbatim, so it must come last.
	if (action === "menu" && params.group) args.push("--group", params.group);
	if (action === "run" && Array.isArray(params.command) && params.command.length > 0) args.push("--", ...params.command.map(String));
	return args;
}

export function normalizeAction(action: ToolbeltAction): string {
	if (action === "audit_secrets") return "audit-secrets";
	if (action === "catalog_check") return "catalog-check";
	if (action === "generate_cli") return "generate";
	if (action === "refresh_surface") return "refresh-surface";
	return action;
}

export function parseJsonObject(stdout: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(stdout);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { value: parsed };
	} catch {
		return null;
	}
}

