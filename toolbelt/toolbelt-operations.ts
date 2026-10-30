/**
 * toolbelt-operations — stop the model guessing provider operation names.
 *
 * Measured over 2026-07-17..27, 24 of 66 pi_toolbelt failures were invented
 * operation names. For a single intent the model tried, in sequence:
 *
 *     list PRs  → pr, pr-list, search-prs, list_pull_requests, get_pull_request
 *     view repo → repo, repo_view, repo-view, repos, search-repos
 *
 * and twice called `help`, looking for a discovery affordance that is
 * actually named `discover`. The canonical names are `prs` and `repo`. Note
 * that most guesses are NOT mechanical variants of the right answer, so
 * normalisation alone cannot rescue them — the model has to be shown the
 * catalogue.
 *
 * Three layers, cheapest first:
 *   1. normalise mechanical variants (snake_case, list-X/X-list, plurals);
 *   2. validate against the provider's real catalogue before shelling out,
 *      and on a miss return the whole catalogue instead of a fuzzy guess;
 *   3. disclose the catalogue once per provider per session, so the second
 *      call onwards is informed rather than corrected.
 *
 * Pure functions over a catalogue object; no Pi or child_process imports.
 */

export type ProviderCatalog = {
	safe: string[];
	mutating: string[];
	blocked: string[];
};

/**
 * Shared execution-control contract with the core `pi-toolbelt` CLI.
 *
 * `run` forwards the provider CLI's own argv verbatim; these three controls
 * travel as Toolbelt flags BEFORE the `--` separator so they can never be
 * misread as provider arguments:
 *
 *     pi-toolbelt run --provider <p> --cwd <abs> --timeout-ms <ms> \
 *         --stdin-file <path> --deadline-ms <epoch-ms> -- <provider argv...>
 *
 * - `cwd`        absolute working directory for the provider CLI.
 * - `timeoutMs`  positive budget in ms; the wrapper adds `WRAPPER_GRACE_MS` so
 *                the CLI reports a structured timeout instead of being killed
 *                at the same instant its own provider timeout fires.
 * - `stdinFile`  local file path; the CLI feeds the contents to the provider
 *                CLI's stdin. The contents never enter arguments, output, or
 *                logs, which is why only the path is carried here.
 */
export const WRAPPER_GRACE_MS = 15_000;

/**
 * Physical platform bound for a wrapper-enforced timeout: the CLI's own
 * `MAX_OPERATION_TIMEOUT_MS` (43_200_000) plus the 15s grace it already adds
 * to extension timeouts. Nothing shorter is imposed by the wrapper.
 */
export const MAX_CONTROL_TIMEOUT_MS = 43_215_000;

export type ExecutionControls = {
	cwd?: string;
	timeoutMs?: number;
	stdinFile?: string;
	allowUnlisted?: boolean;
	/** `status`: read local/config state only and skip provider auth probes. */
	fast?: boolean;
	/** `providers`: include registered CLIs that are not installed. */
	all?: boolean;
};

export type ExecutionDeadline = {
	/** Caller-supplied budget in ms. */
	timeoutMs: number;
	/** Absolute epoch ms the provider CLI should stop by. */
	deadlineAt: number;
	/** Extra wrapper wall-clock room on top of `timeoutMs`. */
	graceMs: number;
	/** Timeout handed to the wrapper's own process spawn. */
	wrapperTimeoutMs: number;
};

/** Absolute posix or Windows path; the CLI resolves relative paths against its
 * own working directory, which is not necessarily the caller's intent. */
function isAbsolutePath(value: string): boolean {
	return /^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

/** Clamp to physical platform bounds only — never an arbitrary short cap. */
export function clampControlTimeoutMs(value: unknown): number | undefined {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
	return Math.max(1, Math.min(Math.trunc(parsed), MAX_CONTROL_TIMEOUT_MS));
}

/**
 * Validate and normalise caller-supplied execution controls. Returns the
 * usable values plus one message per rejected value, so the model is told what
 * to change instead of silently running in the wrong directory or with the
 * CLI's own default timeout.
 */
export function normalizeExecutionControls(raw: {
	cwd?: unknown;
	timeoutMs?: unknown;
	stdinFile?: unknown;
	allowUnlisted?: unknown;
	fast?: unknown;
	all?: unknown;
}): { controls: ExecutionControls; issues: string[] } {
	const issues: string[] = [];
	const controls: ExecutionControls = {};

	if (raw.cwd !== undefined && raw.cwd !== null && raw.cwd !== "") {
		const cwd = String(raw.cwd);
		if (isAbsolutePath(cwd)) controls.cwd = cwd;
		else issues.push(`cwd must be an absolute working directory, got "${cwd}"`);
	}

	if (raw.stdinFile !== undefined && raw.stdinFile !== null && raw.stdinFile !== "") {
		const stdinFile = String(raw.stdinFile);
		if (/[\0\r\n]/.test(stdinFile)) issues.push("stdinFile must be a single local file path");
		else if (!isAbsolutePath(stdinFile)) issues.push(`stdinFile must be an absolute local file path, got "${stdinFile}"`);
		else controls.stdinFile = stdinFile;
	}

	if (raw.timeoutMs !== undefined && raw.timeoutMs !== null) {
		const timeoutMs = clampControlTimeoutMs(raw.timeoutMs);
		if (timeoutMs === undefined) issues.push(`timeoutMs must be a positive number of milliseconds, got "${String(raw.timeoutMs)}"`);
		else controls.timeoutMs = timeoutMs;
	}

	if (raw.allowUnlisted === true) controls.allowUnlisted = true;
	if (raw.fast === true) controls.fast = true;
	if (raw.all === true) controls.all = true;
	return { controls, issues };
}

/** Toolbelt-side flags for one dispatch, in the order the CLI documents them. */
export function executionControlArgs(controls: ExecutionControls): string[] {
	const args: string[] = [];
	if (controls.cwd) args.push("--cwd", controls.cwd);
	if (controls.timeoutMs !== undefined) args.push("--timeout-ms", String(controls.timeoutMs));
	if (controls.stdinFile) args.push("--stdin-file", controls.stdinFile);
	if (controls.allowUnlisted) args.push("--allow-unlisted");
	return args;
}

/**
 * Survey controls select how much of the local surface the CLI reads rather
 * than how it dispatches a provider command: `--fast` keeps global `status` to
 * local/config state instead of probing provider auth, and `--all` makes
 * `providers` include registered CLIs that are not installed. They are Toolbelt
 * flags like the execution controls, so they must travel before any `--`
 * separator — a provider CLI may define the same flags and own everything
 * after it.
 */
export function surveyControlArgs(controls: ExecutionControls): string[] {
	const args: string[] = [];
	if (controls.fast) args.push("--fast");
	if (controls.all) args.push("--all");
	return args;
}

/**
 * Plan an overall deadline plus the wrapper's own grace. The wrapper must
 * outlive the deadline it imposes on the CLI, otherwise the SIGTERM races the
 * CLI's structured timeout envelope and the caller sees a kill instead of a
 * diagnosis.
 */
export function planExecutionDeadline(timeoutMs: number | undefined, now: number): ExecutionDeadline | undefined {
	if (timeoutMs === undefined) return undefined;
	return {
		timeoutMs,
		deadlineAt: now + timeoutMs,
		graceMs: WRAPPER_GRACE_MS,
		wrapperTimeoutMs: timeoutMs + WRAPPER_GRACE_MS,
	};
}

export function deadlineArgs(deadline: ExecutionDeadline | undefined): string[] {
	return deadline ? ["--deadline-ms", String(Math.trunc(deadline.deadlineAt))] : [];
}

export function allOperations(catalog: ProviderCatalog): string[] {
	return [...catalog.safe, ...catalog.mutating, ...catalog.blocked];
}

/** Parse a `pi-toolbelt discover` payload into a catalogue for one provider. */
export function parseCatalog(payload: unknown, providerId: string): ProviderCatalog | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const root = payload as Record<string, unknown>;
	const providers = Array.isArray(root.providers) ? (root.providers as Array<Record<string, unknown>>) : undefined;
	const entry = providers?.find((p) => p.id === providerId) ?? (root.id === providerId ? root : undefined);
	if (!entry) return undefined;
	const list = (key: string): string[] => (Array.isArray(entry[key]) ? (entry[key] as unknown[]).filter((v): v is string => typeof v === "string") : []);
	const catalog = { safe: list("safeOperations"), mutating: list("mutatingOperations"), blocked: list("blockedOperations") };
	return allOperations(catalog).length > 0 ? catalog : undefined;
}

/** Canonical comparison key: case-insensitive, separator-insensitive. */
function key(operation: string): string {
	return operation.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Resolve a caller-supplied operation to a real one when the difference is
 * purely mechanical. Returns undefined rather than guessing at meaning —
 * silently running the wrong operation against a live service is worse than
 * an error.
 */
export function normalizeOperation(operation: string, catalog: ProviderCatalog): string | undefined {
	const operations = allOperations(catalog);
	const exact = operations.find((candidate) => candidate === operation);
	if (exact) return exact;

	const wanted = key(operation);
	const byKey = operations.find((candidate) => key(candidate) === wanted);
	if (byKey) return byKey; // repo_view → repo-view, PR-Diff → pr-diff

	// Verb-noun reordering and filler verbs: list-deployments ↔ deployments-list,
	// get-repo → repo. Build the candidate set from the supplied name only.
	const parts = operation.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
	const fillers = new Set(["list", "get", "show", "view", "search", "describe", "fetch", "read"]);
	const nouns = parts.filter((part) => !fillers.has(part));
	// Order matters: a verb-carrying variant must beat the bare noun, or
	// `list-repo` resolves to `repo` when `repo-list` exists.
	const candidates = new Set<string>();
	if (parts.length > 1) {
		candidates.add(key([...parts].reverse().join("")));
		candidates.add(key(parts.join("")));
	}
	if (nouns.length > 0) {
		const noun = nouns.join("");
		for (const filler of parts.filter((part) => fillers.has(part))) {
			candidates.add(key(`${noun}-${filler}`));
			candidates.add(key(`${filler}-${noun}`));
		}
		candidates.add(key(noun));
		candidates.add(key(`${noun}s`)); // pull-request → prs-style plurals
		candidates.add(key(noun.replace(/s$/, "")));
	}
	// Walk candidates in priority order — not the catalogue — so the ranking
	// above decides the winner rather than the provider's declaration order.
	for (const candidate of candidates) {
		const match = operations.find((operation) => key(operation) === candidate);
		if (match) return match;
	}
	return undefined;
}

/** Character-bigram similarity; good enough to rank near-misses. */
function similarity(a: string, b: string): number {
	const grams = (value: string): Set<string> => {
		const out = new Set<string>();
		for (let i = 0; i < value.length - 1; i++) out.add(value.slice(i, i + 2));
		return out;
	};
	const left = grams(key(a));
	const right = grams(key(b));
	if (left.size === 0 || right.size === 0) return 0;
	let shared = 0;
	for (const gram of left) if (right.has(gram)) shared += 1;
	return (2 * shared) / (left.size + right.size);
}

export function suggestOperations(operation: string, catalog: ProviderCatalog, limit = 5): string[] {
	return allOperations(catalog)
		.map((candidate) => ({ candidate, score: similarity(operation, candidate) }))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((entry) => entry.candidate);
}

/**
 * Project/account resolution diagnostics — make unknown project/slug failures
 * self-correcting instead of leaving the model guessing.
 *
 * The pi-toolbelt envelope marks provider/project resolution failures with a
 * small `status` namespace. When the wrapper sees one, it should surface the
 * structured alternatives (configured projects, registered account aliases)
 * from the non-secret `~/.pi/agent/toolbelt/data/accounts.json` registry and
 * propose a `did you mean` only when the evidence supports it. If no list is
 * available, it must tell the model to call `discover`/`status` rather than
 * inventing names. Secret-shaped values are never read or returned.
 *
 * Pure functions over a registry object; no Pi or child_process imports.
 */

export type ProjectAccountRegistry = {
	accounts: Array<{ alias: string; provider?: string; enabled?: boolean }>;
	projects: Record<string, Record<string, string>>;
};

/** Status codes that mean a project or account selector failed to resolve. */
export const PROJECT_RESOLUTION_STATUS_CODES = new Set<string>([
	"account_not_found",
	"account_disabled",
	"account_provider_mismatch",
	"account_selection_required",
	"account_binding_mismatch",
	"unknown_project",
]);

export function isProjectResolutionStatus(status: unknown): boolean {
	return typeof status === "string" && PROJECT_RESOLUTION_STATUS_CODES.has(status);
}

/** Safely pull configured project slugs from a `accounts --json` payload. */
export function extractValidProjectSelectors(registry: unknown): string[] {
	if (!registry || typeof registry !== "object") return [];
	const projects = (registry as { projects?: unknown }).projects;
	if (!projects || typeof projects !== "object" || Array.isArray(projects)) return [];
	return Object.keys(projects as Record<string, unknown>)
		.filter((key): key is string => typeof key === "string" && key.length > 0)
		.sort();
}

/** Safely pull registered account aliases from a `accounts --json` payload. */
export function extractValidAccountAliases(registry: unknown, provider?: string): string[] {
	if (!registry || typeof registry !== "object") return [];
	const accounts = (registry as { accounts?: unknown }).accounts;
	if (!Array.isArray(accounts)) return [];
	const out: string[] = [];
	for (const entry of accounts) {
		if (!entry || typeof entry !== "object") continue;
		const alias = (entry as { alias?: unknown }).alias;
		if (typeof alias !== "string" || alias.length === 0) continue;
		if (provider) {
			const entryProvider = (entry as { provider?: unknown }).provider;
			if (typeof entryProvider === "string" && entryProvider !== provider) continue;
			if ((entry as { enabled?: unknown }).enabled === false) continue;
		}
		out.push(alias);
	}
	return out.sort();
}

/**
 * Conservative single-match suggestion. Returns the candidate only if it is
 * meaningfully closer than every other option and clears a minimum threshold.
 * Ties suppress the suggestion so the model doesn't confidently fire a wrong
 * name at a live service.
 */
export function didYouMeanClose(target: string, options: string[], threshold = 0.45): string | undefined {
	if (typeof target !== "string" || target.length === 0) return undefined;
	const ranked: Array<{ candidate: string; score: number }> = [];
	for (const candidate of options) {
		if (typeof candidate !== "string" || candidate.length === 0) continue;
		ranked.push({ candidate, score: similarity(target, candidate) });
	}
	if (ranked.length === 0) return undefined;
	ranked.sort((a, b) => b.score - a.score);
	const top = ranked[0];
	if (top.score < threshold) return undefined;
	if (ranked[1] && ranked[1].score === top.score) return undefined;
	return top.candidate;
}

/** Self-correcting hint for a project selector that did not resolve. */
export function formatProjectResolutionHint(registry: unknown, target: string): string {
	const valid = extractValidProjectSelectors(registry);
	if (valid.length === 0) {
		// Don't invent names. Tell the model to fetch the registry.
		return "no configured projects are visible; call pi_toolbelt with action:'discover' or action:'accounts' to list the registered project bindings";
	}
	const match = didYouMeanClose(target, valid);
	if (match) return `did you mean: project=${match} (configured project bindings: ${valid.join(", ")})`;
	return `configured project bindings: ${valid.join(", ")}`;
}

/** Self-correcting hint for a structured account-resolution failure payload. */
export function formatAccountResolutionHint(
	registry: unknown,
	payload: Record<string, unknown> | undefined,
	provider?: string,
): string | undefined {
	if (!payload || !isProjectResolutionStatus(payload.status)) return undefined;
	// If the payload already carries a self-describing list, do not duplicate it.
	const listed = Array.isArray(payload.accounts) ? payload.accounts.filter((v): v is string => typeof v === "string") : [];
	const valid = extractValidAccountAliases(registry, provider);
	const status = payload.status as string;
	if (status === "account_binding_mismatch" && typeof payload.boundAccount === "string") {
		return `project binding is fail-closed: provider ${provider ?? "?"} for this project must use account=${payload.boundAccount}, not account=${payload.requestedAccount ?? "?"}; registered aliases for ${provider ?? "provider"}: ${valid.join(", ") || "(none — fix the binding or omit --account)"}`;
	}
	if (status === "account_selection_required") {
		if (listed.length > 0) return undefined; // the payload already lists options.
		return `registered aliases for ${provider ?? "provider"}: ${valid.join(", ") || "(none configured)"}`;
	}
	if (valid.length === 0) return undefined; // nothing to add; the original error stands.
	return `registered aliases for ${provider ?? "provider"}: ${valid.join(", ")}`;
}

/**
 * The catalogue as the model should see it: every name, grouped by what
 * calling it will do. Compact enough to include in a tool result.
 */
export function formatCatalog(provider: string, catalog: ProviderCatalog): string {
	const lines = [`${provider} operations — use these names exactly:`];
	if (catalog.safe.length > 0) lines.push(`  read-only: ${catalog.safe.join(" ")}`);
	// The class is advisory. Approval happens in chat; there is no Toolbelt
	// flag that authorises a mutation, so the label must not imply one.
	if (catalog.mutating.length > 0) lines.push(`  mutating (ask before running): ${catalog.mutating.join(" ")}`);
	if (catalog.blocked.length > 0) lines.push(`  policy-classified (expect refusal/redaction): ${catalog.blocked.join(" ")}`);
	return lines.join("\n");
}

/**
 * Error text for a curated operation that does not exist. It carries the whole
 * catalogue so one round trip recovers, and it names the native path — the
 * catalogue covers curated aliases only, never the CLI's full command set.
 */
export function unknownOperationMessage(provider: string, operation: string, catalog: ProviderCatalog): string {
	const suggestions = suggestOperations(operation, catalog);
	const closest = suggestions.length > 0 ? `\nclosest: ${suggestions.join(" ")}` : "";
	const native = `\nthis catalogue lists curated operations only; if the CLI documents the command, run it directly with action:'run' and command:['<word>', ...]`;
	return `fail ${provider} ${operation} unknown_operation${closest}${native}\n${formatCatalog(provider, catalog)}`;
}

/** CLI sub-commands as the corresponding pi_toolbelt action. */
const HINT_ACTIONS: Record<string, string> = {
	menu: "menu",
	run: "run",
	providers: "providers",
	status: "status",
	find: "find",
	accounts: "accounts",
	discover: "discover",
	inventory: "inventory",
	links: "links",
	ledger: "ledger",
	"refresh-surface": "refresh_surface",
	"audit-secrets": "audit_secrets",
	"catalog-check": "catalog_check",
};

/**
 * Rewrite a shell hint (`run "pi-toolbelt menu supabase"`) into a tool call the
 * model can actually make. A hint that names a shell command it cannot run is
 * not actionable, so the wrapper translates rather than forwards it.
 */
export function translateToolbeltHint(hint: unknown): string | undefined {
	if (typeof hint !== "string" || hint.trim() === "") return undefined;
	return hint
		.replace(/\bpi-toolbelt\s+([a-z][a-z-]*)(?:\s+("[^"]*"|'[^']*'|[^\s,;)"']+))?/g, (match, sub: string, rawArg: string | undefined) => {
			const action = HINT_ACTIONS[sub];
			if (!action) return match;
			const arg = rawArg ? rawArg.replace(/^["']|["']$/g, "") : undefined;
			if (!arg || /^[<\[].*[>\]]$/.test(arg)) return `{action:'${action}'}`;
			return `{action:'${action}', ${sub === "find" ? "query" : "service"}:'${arg}'}`;
		})
		.trim();
}

/**
 * Translate the CLI's structured `run` refusal alternative
 * (`pi-toolbelt run <provider> -- <argv...>`) into the equivalent
 * `action:'run'` tool call. The argv after `--` is the provider CLI's own, so
 * it becomes `command` verbatim; anything else falls through to the generic
 * hint translation. Returns undefined when the line is not a run alternative.
 */
export function translateRunAlternative(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const match = /^pi-toolbelt\s+run\s+(\S+)\s+--\s+(.+)$/.exec(value.trim());
	if (!match) return undefined;
	return `{action:'run', service:'${match[1]}', command:${JSON.stringify(splitQuoted(match[2]))}}`;
}

/** Minimal shell-word splitter for the quoted argv `runAlternative` emits. */
function splitQuoted(input: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (quote) {
			if (ch === quote) {
				quote = undefined;
				continue;
			}
			// `'\''` is a single-quoted apostrophe: close, escape, reopen.
			if (quote === "'" && ch === "\\" && input[i + 1] === "'" && input[i + 2] === "'") {
				current += "'";
				i += 2;
				continue;
			}
			current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current) {
				out.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (current) out.push(current);
	return out;
}

/**
 * Recover a usable reason from a toolbelt failure payload.
 *
 * `summarizeToolbelt` only reads `error.message`/`message`, so an adapter
 * that fails inside a sub-command produced the bare, unactionable text
 * `fail vercel status error` — 39 of 66 observed failures. The detail is
 * present in the payload, one level down.
 */
export function explainFailure(payload: unknown): string | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const reasons: string[] = [];
	const visit = (value: unknown, depth: number, label?: string): void => {
		if (depth > 3 || !value || typeof value !== "object" || reasons.length >= 3) return;
		const node = value as Record<string, unknown>;
		// Prefer the step's key (whoami, version) over the shared binary name.
		const command = label ?? (typeof node.command === "string" ? node.command : undefined);
		if (node.timedOut === true) {
			reasons.push(`${command ?? "step"} timed out after ${typeof node.timeoutMs === "number" ? `${node.timeoutMs}ms` : "its limit"}`);
		} else if (typeof node.exitCode === "number" && node.exitCode !== 0) {
			const stderr = typeof node.stderr === "string" ? node.stderr.replace(/\s+/g, " ").trim().slice(0, 120) : "";
			reasons.push(`${command ?? "step"} exited ${node.exitCode}${stderr ? `: ${stderr}` : ""}`);
		}
		for (const [childKey, child] of Object.entries(node)) visit(child, depth + 1, childKey === "data" ? label : childKey);
	};
	visit(payload, 0);
	return reasons.length > 0 ? reasons.join("; ") : undefined;
}
