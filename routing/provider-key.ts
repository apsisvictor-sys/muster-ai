/**
 * One owner for a provider's key (SK3 of `plans/secrets/key-management-blueprint-2026-10-16.md`).
 *
 * A provider's key has one env-name list and one resolution order, and every
 * reader asks here instead of rebuilding either:
 *
 *   - `providerEnvName(provider)` — the env names pi-ai's own table holds for
 *     the provider, else a `$NAME` `apiKey` in `models.json` (how
 *     `command-code` is named, since the table lacks it).
 *   - `providerApiKey(provider, options)` — the reader's own order: its env
 *     names in order, then the stored `auth.json` api_key entry.
 *   - `accountFor(provider)` — the account a split provider's work belongs to
 *     in this process (SK4's walls and cooldowns key on it).
 *
 * The name table is the fork's, never a local copy (SK0-R6, no fork change),
 * and the three Pi calls travel through the `credentials` port (S8), so this
 * module imports no Pi package at runtime: `findEnvKeys` with an env whose
 * every name reads as set returns the provider's full name list from
 * `getApiKeyEnvVars`, and the fork's `getProviderEnvValue` reads the value
 * (given env, then `process.env`, then its Bun sandbox fallback), so a reader
 * and the request path read the same environment and an empty environment
 * cannot change the name list. The `$NAME` `models.json` fallback is read
 * under `piAgentDir()` (S10), the agent folder the start file configured.
 *
 * No value is ever returned in an error, logged or put in a thrown message; a
 * missing or malformed file yields no key rather than a wrong one.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { piAgentDir, piPort } from "../core/pi-ports.ts";
import { loadPoolConfig, providerAccounts } from "./provider-pool.ts";

/**
 * The employer label of a split provider's second account (SK-D5). `run-as`
 * sets `PI_EMPLOYER` to it, SK4's walls and Muster cooldowns carry it as the
 * account, and the usage snapshot labels its row with it.
 */
export const WORK_ACCOUNT = "acme-realty";
/**
 * The env-name prefix `run-as` gives the work account's copies of a split
 * provider's names (`consumers.json` `usage-snapshot`, §4 rule 4), so one
 * process can read both accounts.
 */
export const WORK_ENV_PREFIX = "WORK_";

/** What a caller can say about the order: only the account, as a rule (§5 step 6). */
export interface ProviderKeyOptions {
	/** Env-name prefix: `WORK_` reads the work account's copy of a split provider's key. */
	prefix?: string;
	/** Extra env names this reader owns, tried in front of the provider's own names. */
	extraEnvNames?: readonly string[];
	/** A reader's own ordered env-name list, replacing the provider's table names. */
	envNames?: readonly string[];
	/** The stored `auth.json` entries to try, in order; defaults to `[provider]`. */
	storedProviders?: readonly string[];
}

/**
 * An env whose every name reads as set, so `findEnvKeys` returns the provider's
 * whole name list. `getProviderEnvValue` reads it before `process.env`, so the
 * real environment cannot change the result.
 */
const EVERY_NAME_SET: Record<string, string> = new Proxy({} as Record<string, string>, { get: () => "1" });

/**
 * The env names a provider's key can come from, in the order they are tried: a
 * ruling for the provider (below), else pi-ai's own table, else the `$NAME`
 * `models.json` gives it, else `undefined` — and the caller then falls back to the
 * stored credential, as every reader did before this owner existed.
 */
/**
 * The env names a provider's key is read through by a ruling, which leads the list Pi's own table and `models.json`
 * give (VR24-213): a ruling states the name that addresses the account, so it is tried before anything else. `UB0` is
 * the source of Command Code's pair, `COMMAND_CODE_API_KEY` and its `ACCT2_` copy, which is the name AR14's account
 * pick maps. A provider joins this table only by a ruling.
 */
const RULED_KEY_ENV_NAMES: Readonly<Record<string, readonly string[]>> = {
	// CCACCT2 (the operator 2026-10-27, relayed by Henry 04:22 EET: "hook them up properly so all pi lanes go through them"):
	// Command Code's routed account is the second one. Measured 2026-10-28: `COMMAND_CODE_API_KEY` answers 400
	// insufficient credits and `ACCT2_COMMAND_CODE_API_KEY` answers the same model, so the name the ruling leads with is
	// the account that can answer, exactly as OpenCode Go's already is.
	"command-code": ["ACCT2_COMMAND_CODE_API_KEY"],
	// OpenCode Go reads the account's own name. The legacy `OPENCODE_GO_API_KEY` has no Go subscription (403,
	// 2026-10-27), and Pi's table name for this provider (`OPENCODE_API_KEY`) is the free Zen tier's, so neither may
	// name a Go ref: a Go request that resolved through either one failed while a plan was in place (VR24-218: the
	// `ACCT2_` copy is the account's own and a prefixed read never falls back to the stored key).
	"opencode-go": ["ACCT2_OPENCODE_API_KEY"],
};

export function providerEnvName(provider: string): string[] | undefined {
	const fromTable = piPort("credentials").findEnvKeys(provider, EVERY_NAME_SET);
	const table = fromTable !== undefined && fromTable.length > 0 ? fromTable : undefined;
	const fromModels = table === undefined ? modelsEnvName(provider) : undefined;
	const base = table ?? (fromModels === undefined ? undefined : [fromModels]);
	const ruled = RULED_KEY_ENV_NAMES[provider];
	if (ruled === undefined) return base === undefined ? undefined : [...base];
	// The ruling leads, so the account's own name is tried before any name the table or `models.json` mentions; a name
	// both of them hold appears once.
	return [...new Set([...ruled, ...(base ?? [])])];
}

/** The env name a provider's `$NAME` `models.json` `apiKey` points at, if it has one. */
function modelsEnvName(provider: string): string | undefined {
	try {
		const path = join(piAgentDir(), "models.json");
		if (!existsSync(path)) return undefined;
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as { providers?: Record<string, { apiKey?: unknown }> };
		const apiKey = parsed?.providers?.[provider]?.apiKey;
		if (typeof apiKey !== "string" || !apiKey.startsWith("$")) return undefined;
		const name = apiKey.slice(1).trim();
		return name === "" ? undefined : name;
	} catch {
		return undefined;
	}
}

/**
 * A provider's key, in one reader's own order: the env names first (the
 * reader's extras in front of the provider's own names, or the reader's whole
 * list when it has one), then the stored `auth.json` api_key entry — under
 * `key`, or under `access`, which is where GLM and MiniMax keep it.
 *
 * A `prefix` reads another account's copy of the key. That account has no
 * stored entry here, and the stored credential belongs to this process's own
 * account, so a prefixed read never falls back to it: the work row of a split
 * provider can show "no key", never the personal account's key (§4 rule 3).
 */
export function providerApiKey(provider: string, options: ProviderKeyOptions = {}): string | null {
	const prefix = options.prefix ?? "";
	for (const name of [...(options.extraEnvNames ?? []), ...(options.envNames ?? providerEnvName(provider) ?? [])]) {
		// A prefixed read asks for another account's copy, and a name that already carries the prefix is that copy, not
		// something to prefix again: CCACCT2 (2026-10-28) made Command Code's routed name
		// `ACCT2_COMMAND_CODE_API_KEY`, the shape OpenCode Go has had since S14, and `ACCT2_ACCT2_…` names nothing.
		const value = piPort("credentials").getProviderEnvValue(name.startsWith(prefix) && prefix !== "" ? name : `${prefix}${name}`)?.trim();
		if (value) return value;
	}
	if (prefix !== "") return null;
	for (const stored of options.storedProviders ?? [provider]) {
		const value = storedApiKey(stored);
		if (value !== null) return value;
	}
	return null;
}

/**
 * Why `providerApiKey` found nothing, for a one-shot reader that throws its
 * cause: the env names it looked at (with the prefix) and whether the stored
 * entry was consulted. It names no value, so it is safe in a snapshot row.
 */
export function missingKeyReason(provider: string, options: ProviderKeyOptions = {}): string {
	const prefix = options.prefix ?? "";
	// The same rule as the read itself: a prefixed read never asks for a name that already carries the prefix, so the
	// message names one variable per account (CCACCT2).
	const names = [...new Set([...(options.extraEnvNames ?? []), ...(options.envNames ?? providerEnvName(provider) ?? [])].map(
		(name) => (prefix !== "" && name.startsWith(prefix) ? name : `${prefix}${name}`),
	))];
	const where = names.length > 0 ? `${names.join(" / ")} is not set in this process` : "no env name is known for the provider";
	return prefix !== ""
		? `no key: ${where} (the work account has no stored entry)`
		: `no key: ${where} and auth.json has no ${provider} api_key entry`;
}

/** The stored `api_key` value of one `auth.json` entry, or null when it has none. */
function storedApiKey(provider: string): string | null {
	const credential = piPort("credentials").readStoredCredential(provider) as
		| { type?: unknown; key?: unknown; access?: unknown }
		| undefined;
	if (credential === null || typeof credential !== "object" || credential.type !== "api_key") return null;
	for (const field of [credential.key, credential.access]) {
		if (typeof field === "string" && field.trim() !== "") return field.trim();
	}
	return null;
}

/**
 * The account this process reads a provider's key from: `PI_ACCOUNT` when the provider's plan holds that account
 * (AR14: `run-as` exports it, and it wins over the employer, design 3), else `acme-realty` for a split provider in
 * an Acme Realty process, else `undefined` (the process's own account). The owners are the inventory's account
 * labels, `provider-pool.json` `employerAccounts` and the two env names `run-as` sets; a pool file that cannot be
 * read yields `undefined`, so a broken file never moves work onto another account's key.
 */
export function accountFor(provider: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const placed = env.PI_ACCOUNT?.trim();
	if (placed !== undefined && placed !== "") return providerAccounts(provider).some((account) => account.label === placed) ? placed : undefined;
	if (env.PI_EMPLOYER !== WORK_ACCOUNT) return undefined;
	const loaded = loadPoolConfig();
	if (!loaded.ok) return undefined;
	return loaded.config.employerAccounts.includes(provider) ? WORK_ACCOUNT : undefined;
}

/**
 * The env names one account of a provider's plan is configured through (AR14, VR24-213): the provider's own names
 * with the account's prefix, and — for the account Pi's own entry reads — the provider's names as they are, because
 * an entry such as OpenCode Go's `models.json` `$ACCT2_OPENCODE_API_KEY` is already the routed account's name. An
 * account the plan does not list has no names: a placement never reads a key through a label nobody owns.
 */
export function accountKeyNames(provider: string, account: string | undefined): string[] {
	const names = providerEnvName(provider) ?? [];
	if (account === undefined) return names;
	const plan = providerAccounts(provider).find((entry) => entry.label === account);
	if (plan === undefined) return [];
	// A name that already carries the prefix (OpenCode Go's `models.json` entry is `$ACCT2_OPENCODE_API_KEY`) is not
	// prefixed twice.
	const prefixed = plan.envPrefix === undefined ? [] : names.map((name) => (name.startsWith(plan.envPrefix as string) ? name : `${plan.envPrefix}${name}`));
	return [...new Set(plan.routed ? [...names, ...prefixed] : prefixed)];
}

/**
 * Whether a provider's stored `auth.json` entry exists (VR24-213): its type and that a value is there, never the value
 * itself. `api_key` is a key Pi reads directly; `oauth` is a sign-in Pi already holds (xai, openai-codex). It answers
 * for the account Pi's own entry reads, which is why a prefixed account never reaches it.
 */
function storedCredentialPresent(provider: string): boolean {
	const credential = piPort("credentials").readStoredCredential(provider) as
		| { type?: unknown; key?: unknown; access?: unknown; refresh?: unknown }
		| undefined;
	if (credential === null || typeof credential !== "object") return false;
	if (credential.type === "oauth") return [credential.access, credential.refresh].some((field) => typeof field === "string" && field.trim() !== "");
	if (credential.type !== "api_key") return false;
	return [credential.key, credential.access].some((field) => typeof field === "string" && field.trim() !== "");
}

/** `~/.config/agent-keys.env`, unless a caller points the reader elsewhere (tests, a fixture). */
function agentKeysPath(): string {
	const override = process.env.PI_AGENT_KEYS_PATH?.trim();
	return override !== undefined && override !== "" ? override : join(homedir(), ".config", "agent-keys.env");
}

/**
 * `agent-keys.env` parsed as a shell reads a value: the name before the first `=`, and the value after it with its
 * surrounding single or double quotes removed and an optional `export ` prefix accepted (KEYINJ, 2026-10-27: a copy
 * kept with its quotes reached a lane as 53 characters against 51 and answered 401). A blank or `#` line is skipped,
 * a line with no `=` or an empty name is skipped, and a value keeps everything after the `=`; no `#` comment is
 * stripped from a value and no escape is interpreted, because a key is written by hand and holds neither.
 *
 * This is the one parser: the names `accountConfigured` tests and the values a launcher hands a lane both come from
 * here, so the two can never disagree about what the file says.
 */
export function parseAgentKeys(text: string): Map<string, string> {
	const entries = new Map<string, string>();
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
		const assignment = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
		const equals = assignment.indexOf("=");
		if (equals <= 0) continue;
		const name = assignment.slice(0, equals).trim();
		if (name === "") continue;
		entries.set(name, unquoteValue(assignment.slice(equals + 1).trim()));
	}
	return entries;
}

/** A value's surrounding quotes, removed when they are a matching pair; a lone quote is left alone, never guessed at. */
function unquoteValue(value: string): string {
	for (const quote of ['"', "'"]) {
		if (value.length >= 2 && value.startsWith(quote) && value.endsWith(quote)) return value.slice(1, -1);
	}
	return value;
}

/**
 * The key file as `PI_AGENT_KEYS_PATH` names it, else `~/.config/agent-keys.env`. An absent, unreadable or malformed
 * file is no key rather than a wrong one, and no value is logged or thrown.
 */
export function readAgentKeysFile(path: string = agentKeysPath()): Map<string, string> {
	if (!existsSync(path)) return new Map();
	try {
		return parseAgentKeys(readFileSync(path, "utf8"));
	} catch {
		return new Map();
	}
}

/**
 * The variable names `~/.config/agent-keys.env` holds, parsed and never sourced. This is where a key a lane would get
 * lives when the launcher's own process environment does not carry it (VR24-213: the lane's would-be environment).
 */
function agentKeysNames(): ReadonlySet<string> {
	return new Set(readAgentKeysFile().keys());
}

/** A key's identity without its value: what a launch compares, so a value is never needed to compare two copies. */
export interface KeyFingerprint {
	length: number;
	sha256: string;
}

/** The fingerprint of one key value. The two fields are all a reader may report about a value. */
export function keyFingerprint(value: string): KeyFingerprint {
	return { length: value.length, sha256: createHash("sha256").update(value).digest("hex") };
}

/** Why a value parsed out of the key file cannot be trusted, and what the comparison saw. Names and lengths only. */
export interface UntrustedKey {
	/** `still-quoted`: the file was written with a second layer of quotes, so the value carries one. `differs`: the value
	 * is not the copy a second source holds. */
	problem: "still-quoted" | "differs";
	/** The value's own length, which is what makes a quoted copy visible (53 against 51). */
	length: number;
	/** The second copy the comparison used, when there was one. */
	source?: string;
	/** That copy's length. */
	expectedLength?: number;
}

/**
 * The other copies of a key name the machine keeps, in the order a comparison uses them. `~/.hermes/.env` is the second
 * copy the secrets inventory names (`scripts/secrets/migrate.mts`); a lab points `PI_AGENT_KEYS_EXPECTED_PATH` at a
 * fixture instead. A copy that is absent or unreadable yields no entries, so the comparison simply has nothing to say.
 */
function expectedKeyCopies(): Array<{ source: string; entries: Map<string, string> }> {
	const override = process.env.PI_AGENT_KEYS_EXPECTED_PATH?.trim();
	const sources = override !== undefined && override !== "" ? [{ source: override, path: override }] : [{ source: "~/.hermes/.env", path: join(homedir(), ".hermes", ".env") }];
	const copies: Array<{ source: string; entries: Map<string, string> }> = [];
	for (const { source, path } of sources) {
		const entries = readAgentKeysFile(path);
		if (entries.size > 0) copies.push({ source, entries });
	}
	return copies;
}

/**
 * The key names in `agent-keys.env` whose value a lane must not be trusted with, by NAME only (KEYINJ: a copy kept with
 * its shell quotes reached a lane as 53 characters against 51 and answered 401). Two things make a value untrusted:
 *
 *   - `still-quoted`: a quote survives parsing, which means the file was written with a second layer of them;
 *   - `differs`: a second copy of the name exists and its fingerprint is not this value's.
 *
 * A name no second copy holds is never reported as `differs`: with nothing to compare against, absence of a difference
 * cannot be claimed and is not (VR24-213's rule, applied to a value instead of a name). Comparison is by length and
 * sha256, so no value is read out of this function and none can be printed by a caller.
 */
export function untrustedAgentKeys(path: string = agentKeysPath()): Map<string, UntrustedKey> {
	const entries = readAgentKeysFile(path);
	const copies = expectedKeyCopies();
	const untrusted = new Map<string, UntrustedKey>();
	for (const [name, value] of entries) {
		const quote = value[0];
		if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
			untrusted.set(name, { problem: "still-quoted", length: value.length });
			continue;
		}
		const own = keyFingerprint(value);
		for (const copy of copies) {
			const expected = copy.entries.get(name);
			if (expected === undefined) continue;
			const other = keyFingerprint(expected);
			if (other.sha256 === own.sha256 && other.length === own.length) break;
			untrusted.set(name, { problem: "differs", length: own.length, source: copy.source, expectedLength: other.length });
			break;
		}
	}
	return untrusted;
}

/** One plain sentence about an untrusted value: the NAME, the lengths and the source, never the value. */
export function untrustedKeyReason(name: string, untrusted: UntrustedKey): string {
	return untrusted.problem === "still-quoted"
		? `${name} is still quoted after parsing (${untrusted.length} characters), so the file carries a second layer of quotes`
		: `${name} differs from ${untrusted.source} (${untrusted.length} characters here, ${untrusted.expectedLength} there)`;
}

/**
 * Whether a candidate can start at all (VR24-213): one of its account's key names is present in `env` or in
 * `agent-keys.env`, tested by NAME only, or — for the account Pi's own entry reads — the stored `auth.json` entry
 * exists, which is where Command Code's key lives today. No value is copied out of this function; the answer is a
 * boolean. A candidate that fails is skipped as `unconfigured`, so a launch never starts a provider whose key it
 * cannot reach. A provider nobody names (no table entry, no `models.json` name, no ruling) is never refused by name:
 * with no name, absence cannot be established, and inventing one would be a second naming rule.
 */
export function accountConfigured(provider: string, account: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
	const base = providerEnvName(provider) ?? [];
	if (base.length === 0) return true;
	const names = accountKeyNames(provider, account);
	const agentKeys = agentKeysNames();
	if (names.some((name) => {
		const value = env[name];
		return (value !== undefined && value.trim() !== "") || agentKeys.has(name);
	})) return true;
	// Only the account Pi's own entry reads has the stored credential: a prefixed account's key lives in the vault under
	// its own name, and a prefixed read never falls back to the stored one (UB0).
	const plan = account === undefined ? undefined : providerAccounts(provider).find((entry) => entry.label === account);
	return (account === undefined || plan?.routed === true) && storedCredentialPresent(provider);
}
