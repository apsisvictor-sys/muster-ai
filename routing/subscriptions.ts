// Pi's port wiring stays with the Pi-profile start file that imports this module
// (RS1 §8, S13): a harness package never imports Pi's profile (RD1).
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { musterStateDir, piAgentDir } from "../core/pi-ports.ts";

/**
 * Subscription plans and the savings line. A plan belongs to a provider and its monthly price is configuration
 * (`subscriptions.json` under Pi's profile, with who gave the price and the day), so a plan change is a data edit. Pi and Hermes share
 * providers, so a plan is counted once, in the fleet total: every harness's API-equivalent value (from the harness report view, priced
 * by `lib/model-rates.ts`) against every known plan's cost for the same window. A plan with no known price is named as unknown and
 * never counted as zero, and a value nobody knows is never zero either.
 *
 * The same file is the monitor's inventory (UM4 of `plans/provider-accounts/usage-monitor-blueprint-2026-10-16.md`): every
 * subscription, metered account and free-model set, where its credential lives (names only, never a value) and how its usage is read.
 * `loadSubscriptionPlans` is the one loader for both, and `--check` compares the inventory with the evidence on disk. A price may also
 * arrive from a `price` signal's receipt (UM8). Two writers send one: the monitor bot's Gmail connector, and this PC's own receipt
 * reader (UB0 B-2, writer `receipt-reader`). No lane reads email (P5-V1), so the loader is the only consumer of a receipt and it reads
 * the signal log, never a mailbox.
 */
export interface SubscriptionPlan {
	provider: string;
	name: string;
	/** USD a month, or null when nobody has given the price. A plan the operator does not pay for is 0. */
	monthlyUsd: number | null;
	/** Where the price came from, or `receipt <date> via monitor bot` once a receipt has overridden it. */
	source: string;
	/** The day the price was read or given, as YYYY-MM-DD. */
	readOn: string;
	/** How the account is paid for. Absent on a plan written before the inventory (UM4). */
	kind?: PlanKind;
	credential?: PlanCredential;
	usage?: PlanUsage;
	terms?: PlanTerms;
	/**
	 * True for a plan whose only limit is a window that refills — MiniMax's 5-hour cap that opens again
	 * (VR24-202). This flag is the one owner of that fact: the routing placement uses such a provider
	 * while its window is open, ahead of a capped weekly or monthly allowance, and keeps no list of its
	 * own. Absent means the plan is not read as refilling.
	 */
	refills?: boolean;
	/** The accounts this plan is held under (UD11); absent for a plan with one account. */
	accounts?: PlanAccount[];
}

/**
 * One account of a provider whose subscription Pi holds more than once (UD11): the page shows each account as
 * its own row, and the router uses exactly one of them. The label is what the row, the history file and the page
 * call the account; the env prefix is the one `providerApiKey` reads that account's key through.
 */
export interface PlanAccount {
	/** What the row and the page call this account, unique within the plan. */
	label: string;
	/** Env-name prefix of this account's key copies, such as `ACCT2_`; absent for the account Pi's own order reads. */
	envPrefix?: string;
	/** True for the one account Pi's pool routes. Exactly one account of a plan is routed. */
	routed: boolean;
}

/** A subscription, a metered pay-as-you-go account, or free models. */
export type PlanKind = "subscription" | "metered" | "free";

/** Where a plan's credential lives. Names only: never a key, a token or a value. */
export interface PlanCredential {
	/** A provider id in `~/.pi/agent/auth.json`. */
	authJson?: string;
	/** A variable name in `~/.config/agent-keys.env`, which `--check` parses and never sources. */
	env?: string;
	/** A command on `PATH`, such as the Aliyun `bl` CLI. */
	cli?: string;
}

/**
 * How a plan's usage is read. `monitor-browser` is a reading the monitor bot's own browser takes (UM7);
 * `browser` is the same reading taken by the reader on this PC (VR24-201), whose writer is `meter-browser`;
 * `none` states the plan's usage is read nowhere here, so no wired reader runs for it.
 */
export type PlanUsageMethod = "api" | "cli" | "claude-mod" | "browser" | "monitor-browser" | "walls-only" | "none";

export interface PlanUsage {
	method: PlanUsageMethod;
	/** The reader as `<module>#<function>`, or the module that holds it. */
	reader?: string;
	cadence?: string;
	/** The provider's usage page, which a browser reading reads (`monitor-browser`, `browser`; UM14). An https URL. */
	url?: string;
	/** What needs the operator's hands, such as a login. */
	hands?: string;
}

export interface PlanTerms {
	multiAccount: "forbidden" | "by-project" | "unknown";
	/** The path or URL the terms were read from, or `not read`. */
	source: string;
}

/** The columns of `telemetry_harness_report_*` the savings line reads. */
export interface HarnessValueRow {
	harness: string;
	equivalent_value: number | null;
	unknown_equivalent_value_turns: number | null;
	turns: number | null;
}

export interface FleetSavings {
	/** API list-price value of every harness's usage in the window; null when nothing in it could be priced. */
	equivalentValue: number | null;
	/** Turns whose model has no rate, so `equivalentValue` is a lower bound when this is above zero. */
	unknownTurns: number;
	/** The window's cost of every plan with a known price, each once. */
	planCostUsd: number;
	/** Plans with no known price, which the cost leaves out. */
	unknownPlans: string[];
	hasPlans: boolean;
	savingsUsd: number | null;
	multiple: number | null;
}

/**
 * The inventory file's default location, under the agent folder the start file
 * configured (S10/S13): `<piAgentDir>/extensions/telemetry-stats/subscriptions.json`.
 * A function, not a constant, because nothing here may read a port while its
 * module loads. The data stays in Pi's profile (RD3).
 */
export function DEFAULT_SUBSCRIPTIONS_PATH(): string {
	return join(piAgentDir(), "extensions", "telemetry-stats", "subscriptions.json");
}
/**
 * The inventory path a reader outside Pi's profile uses: `PI_SUBSCRIPTIONS_PATH` when it is set, else the
 * shipped file under `~/.pi/agent`. `DEFAULT_SUBSCRIPTIONS_PATH` stays the Pi process's answer (S10); this
 * names the same file for a caller that loads under plain node, where the `agentDir` port does not exist —
 * the Pi launcher's helper, which must still read the plan that names a refilling window (AR12).
 */
export function routerSubscriptionsPath(): string {
	const override = process.env.PI_SUBSCRIPTIONS_PATH?.trim();
	if (override !== undefined && override !== "") return resolve(override);
	return join(homedir(), ".pi", "agent", "extensions", "telemetry-stats", "subscriptions.json");
}

const DAYS_PER_MONTH = 30;
const PLAN_KINDS: readonly PlanKind[] = ["subscription", "metered", "free"];
const USAGE_METHODS: readonly PlanUsageMethod[] = ["api", "cli", "claude-mod", "browser", "monitor-browser", "walls-only", "none"];
const MULTI_ACCOUNT: readonly PlanTerms["multiAccount"][] = ["forbidden", "by-project", "unknown"];
/** A receipt in anything but USD is not a USD figure, so it never overwrites one; no rate is applied here. */
const RECEIPT_CURRENCY = "usd";

function readCredential(at: string, raw: unknown): PlanCredential {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${at}.credential must be an object of names`);
	const out: PlanCredential = {};
	for (const key of ["authJson", "env", "cli"] as const) {
		const value = (raw as Record<string, unknown>)[key];
		if (value === undefined) continue;
		if (typeof value !== "string" || value.trim() === "") throw new Error(`${at}.credential.${key} must be a non-empty string (a name, never a value)`);
		out[key] = value;
	}
	return out;
}

function readUsage(at: string, raw: unknown): PlanUsage {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${at}.usage must be an object`);
	const usage = raw as Record<string, unknown>;
	if (!USAGE_METHODS.includes(usage["method"] as PlanUsageMethod)) throw new Error(`${at}.usage.method must be one of ${USAGE_METHODS.join(", ")}`);
	const out: PlanUsage = { method: usage["method"] as PlanUsageMethod };
	for (const key of ["reader", "cadence", "hands"] as const) {
		const value = usage[key];
		if (value === undefined) continue;
		if (typeof value !== "string" || value.trim() === "") throw new Error(`${at}.usage.${key} must be a non-empty string`);
		out[key] = value;
	}
	const url = usage["url"];
	if (url !== undefined) {
		if (typeof url !== "string" || !/^https:\/\/[^\s/]+(\/\S*)?$/.test(url)) throw new Error(`${at}.usage.url must be an https URL`);
		out.url = url;
	}
	return out;
}

/**
 * A plan's account list (UD11). One account is routed and no other, labels are unique, and a prefix is a name
 * prefix, never a key: the same rule `readCredential` keeps.
 */
function readAccounts(at: string, raw: unknown): PlanAccount[] {
	if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${at}.accounts must be a non-empty array`);
	const out: PlanAccount[] = [];
	for (const [index, entry] of raw.entries()) {
		const where = `${at}.accounts[${index}]`;
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`${where} must be an object`);
		const account = entry as Record<string, unknown>;
		if (typeof account["label"] !== "string" || account["label"].trim() === "") throw new Error(`${where}.label must be a non-empty string`);
		const label = account["label"].trim();
		if (out.some((other) => other.label === label)) throw new Error(`${where}.label repeats ${JSON.stringify(label)}`);
		if (typeof account["routed"] !== "boolean") throw new Error(`${where}.routed must be true or false`);
		const shaped: PlanAccount = { label, routed: account["routed"] };
		const prefix = account["envPrefix"];
		if (prefix !== undefined) {
			if (typeof prefix !== "string" || prefix.trim() === "") throw new Error(`${where}.envPrefix must be a non-empty string (a name prefix, never a value)`);
			shaped.envPrefix = prefix.trim();
		}
		out.push(shaped);
	}
	const routed = out.filter((account) => account.routed);
	if (routed.length !== 1) throw new Error(`${at}.accounts must mark exactly one account routed (found ${routed.length})`);
	return out;
}

function readTerms(at: string, raw: unknown): PlanTerms {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${at}.terms must be an object`);
	const terms = raw as Record<string, unknown>;
	if (!MULTI_ACCOUNT.includes(terms["multiAccount"] as PlanTerms["multiAccount"])) throw new Error(`${at}.terms.multiAccount must be one of ${MULTI_ACCOUNT.join(", ")}`);
	if (typeof terms["source"] !== "string" || terms["source"].trim() === "") throw new Error(`${at}.terms.source must be a non-empty string`);
	return { multiAccount: terms["multiAccount"] as PlanTerms["multiAccount"], source: terms["source"] };
}

/**
 * Read one entry. The four original fields are required, exactly as they were before the inventory; the inventory fields are optional,
 * so a file written before UM4 still loads, and each one is validated when it is there.
 */
function readPlan(path: string, index: number, raw: unknown): SubscriptionPlan {
	const at = `${path}: plans[${index}]`;
	const plan = raw as Partial<SubscriptionPlan>;
	for (const key of ["provider", "name", "source", "readOn"] as const) {
		if (typeof plan[key] !== "string" || !plan[key]) throw new Error(`${at}.${key} must be a non-empty string`);
	}
	if (plan.monthlyUsd !== null && (typeof plan.monthlyUsd !== "number" || !Number.isFinite(plan.monthlyUsd) || plan.monthlyUsd < 0)) throw new Error(`${at}.monthlyUsd must be a number of at least 0, or null when the price is unknown`);
	const out: SubscriptionPlan = { provider: plan.provider!, name: plan.name!, monthlyUsd: plan.monthlyUsd as number | null, source: plan.source!, readOn: plan.readOn! };
	if (plan.kind !== undefined) {
		if (!PLAN_KINDS.includes(plan.kind)) throw new Error(`${at}.kind must be one of ${PLAN_KINDS.join(", ")}`);
		out.kind = plan.kind;
	}
	if (plan.credential !== undefined) out.credential = readCredential(at, plan.credential);
	if (plan.usage !== undefined) out.usage = readUsage(at, plan.usage);
	if (plan.terms !== undefined) out.terms = readTerms(at, plan.terms);
	if (plan.accounts !== undefined) out.accounts = readAccounts(at, plan.accounts);
	if (plan.refills !== undefined) {
		if (typeof plan.refills !== "boolean") throw new Error(`${at}.refills must be true or false`);
		out.refills = plan.refills;
	}
	return out;
}

/** A receipt is the only path a price takes from a mailbox to this machine (P5-V1). It carries no address and no message body. */
export interface PlanReceipt {
	provider: string;
	amount: number;
	/** The currency the amount is in, as the receipt states it. Only a USD receipt sets a plan's price (UM8). */
	currency: string;
	/** The day the provider charged, as YYYY-MM-DD. */
	chargedOn: string;
	/** The plan the receipt names, when it names one. */
	plan?: string;
	/** The rhythm the charge pays for (UB0 B-2), when the receipt states one. */
	period?: "month" | "year" | "once";
	/** The writer that sent the receipt: `receipt-reader` on this PC, or `grokbot` from the monitor bot. */
	writer?: string;
	account?: string;
	at?: string;
	observedAt?: string;
}

export interface LoadSubscriptionOptions {
	/** The signal log to read receipts from; defaults to UM8's `<musterStateDir>/signals/events.jsonl`. */
	signalsPath?: string;
	/** Read the file's own figures only, ignoring any receipt (used by a caller that wants the file as written). */
	noReceipts?: boolean;
}

/** UM8's signal log: `<musterStateDir>/signals/events.jsonl`. */
export function receiptSignalsPath(stateDir: string = musterStateDir()): string {
	return join(stateDir, "signals", "events.jsonl");
}

export function loadSubscriptionPlans(path: string = DEFAULT_SUBSCRIPTIONS_PATH(), options: LoadSubscriptionOptions = {}): SubscriptionPlan[] {
	if (!existsSync(path)) return [];
	const parsed = JSON.parse(readFileSync(path, "utf8")) as { plans?: unknown };
	if (!Array.isArray(parsed.plans)) throw new Error(`${path}: "plans" must be an array`);
	const plans = parsed.plans.map((raw, index): SubscriptionPlan => readPlan(path, index, raw));
	if (options.noReceipts === true) return plans;
	const receipts = newestReceipts(options.signalsPath ?? receiptSignalsPath());
	return plans.map((plan) => applyReceipt(plan, receipts));
}

/**
 * A `price` signal's receipt, or undefined for any other line: another kind, a torn line, or a missing
 * field. A receipt in another currency is kept with its own currency and its period (UB0 B-2): the
 * snapshot's row states what was charged, and only a USD receipt sets a plan's price.
 */
function readReceiptSignal(signal: Record<string, unknown>): PlanReceipt | undefined {
	if (signal["kind"] !== "price") return undefined;
	const receipt = signal["receipt"];
	if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) return undefined;
	const fields = receipt as Record<string, unknown>;
	const provider = signal["provider"];
	const amount = fields["amount"];
	const currency = fields["currency"];
	const chargedOn = fields["chargedOn"];
	if (typeof provider !== "string" || provider.trim() === "") return undefined;
	if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return undefined;
	if (typeof currency !== "string" || currency.trim() === "") return undefined;
	if (typeof chargedOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(chargedOn)) return undefined;
	const out: PlanReceipt = { provider, amount, currency, chargedOn };
	const period = fields["period"];
	if (period === "month" || period === "year" || period === "once") out.period = period;
	if (typeof fields["plan"] === "string" && fields["plan"].trim() !== "") out.plan = fields["plan"];
	if (typeof signal["account"] === "string" && signal["account"].trim() !== "") out.account = signal["account"];
	if (typeof signal["at"] === "string") out.at = signal["at"];
	if (typeof signal["observedAt"] === "string") out.observedAt = signal["observedAt"];
	if (typeof signal["by"] === "string" && signal["by"].trim() !== "") out.writer = signal["by"];
	return out;
}

/**
 * The newest receipt per provider, keyed by the provider id. Two readers want the same map: this loader,
 * which sets a plan's price from a USD receipt, and the snapshot's billing fold (UB0 B-2), which reads a
 * row's dates from it. An unreadable or torn line is skipped and the next write lands on a new line (UM8).
 */
export function newestReceipts(path: string): Map<string, PlanReceipt> {
	const newest = new Map<string, PlanReceipt>();
	if (!existsSync(path)) return newest;
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return newest;
	}
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		let signal: Record<string, unknown>;
		try {
			signal = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		const receipt = readReceiptSignal(signal);
		if (receipt === undefined) continue;
		const key = receipt.provider.trim().toLowerCase();
		const previous = newest.get(key);
		if (previous === undefined || receiptTime(receipt) >= receiptTime(previous)) newest.set(key, receipt);
	}
	return newest;
}

function receiptTime(receipt: PlanReceipt): number {
	const parsed = Date.parse(receipt.observedAt ?? receipt.at ?? "");
	return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * A receipt for this provider (and the plan it names, when it names one) replaces the file's price. Without one the file's value stays,
 * so a plan whose provider sends no receipt keeps what was read on `readOn`.
 *
 * Only a USD receipt sets a price (UM8): a receipt in another currency states a charge, and its own amount and currency reach the
 * snapshot's row instead. A price a receipt set names the writer that sent it, so the line reads `via receipt reader` or
 * `via monitor bot`.
 */
function applyReceipt(plan: SubscriptionPlan, receipts: Map<string, PlanReceipt>): SubscriptionPlan {
	const receipt = receipts.get(plan.provider.trim().toLowerCase());
	if (receipt === undefined) return plan;
	if (receipt.plan !== undefined && receipt.plan.trim().toLowerCase() !== plan.name.trim().toLowerCase()) return plan;
	if (receipt.currency.trim().toLowerCase() !== RECEIPT_CURRENCY) return plan;
	return { ...plan, monthlyUsd: receipt.amount, source: `receipt ${receipt.chargedOn} via ${receiptWriterLabel(receipt)}`, readOn: receipt.chargedOn };
}

/** The writer of a receipt, in the words the price's `source` line uses: the reader on this PC, or the monitor bot. */
function receiptWriterLabel(receipt: PlanReceipt): string {
	if (receipt.writer === "receipt-reader") return "receipt reader";
	if (receipt.writer === undefined || receipt.writer === "grokbot") return "monitor bot";
	return receipt.writer;
}

// ─── Inventory check (UM4 `--check`) ────────────────────────────────────────

/** The evidence the check reads. Names and types only: a key, a token or a response value never enters this shape. */
export interface InventoryEvidence {
	authJson: Array<{ id: string; type: string | null }>;
	envNames: string[];
	/** Every provider id the machine's files name: auth.json, models.json and provider-pool.json. */
	diskProviders: string[];
	commandsOnPath: string[];
}

export interface InventoryCheckOptions {
	/** The home the evidence lives under; defaults to the running user's. `HOME` is what the check resolves. */
	env?: NodeJS.ProcessEnv;
	/** The inventory to check; defaults to the shipped file. */
	inventoryPath?: string;
	/** The signal log to apply receipts from; defaults to UM8's. */
	signalsPath?: string;
}

export interface InventoryCheck extends InventoryEvidence {
	inventoryPath: string;
	home: string;
	entries: number;
	byKind: Record<PlanKind, number>;
	/** Provider ids on disk that no entry names. */
	unlistedProviders: string[];
	/** Credential-shaped variable names in the key file that no entry names. */
	unlistedEnvNames: string[];
	/** One line per entry whose named credential is not where the entry says it is. */
	stale: string[];
	/** Commands an entry names that are not on `PATH`. */
	missingCommands: string[];
}

/** A variable name that can hold a credential. A `*_BASE_URL` and the like is a setting, not a credential. */
const CREDENTIAL_ENV_NAME = /_(KEY|TOKEN|SECRET|PASSWORD)$/;

function readJsonObject(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		return parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Provider ids and credential types in `auth.json`, never a value. */
function readAuthJson(path: string): Array<{ id: string; type: string | null }> {
	const parsed = readJsonObject(path);
	if (parsed === undefined) return [];
	return Object.entries(parsed).map(([id, value]) => {
		const type = asObject(value)?.["type"];
		return { id, type: typeof type === "string" ? type : null };
	});
}

/**
 * The variable names in a `.env`-shaped file. The line is split at its first `=` and the value side is dropped, so the file is parsed
 * and never sourced: no `$(...)` is run and no value leaves this function.
 */
function readEnvNames(path: string): string[] {
	if (!existsSync(path)) return [];
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const names: string[] = [];
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
		const assignment = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
		const equals = assignment.indexOf("=");
		if (equals <= 0) continue;
		const name = assignment.slice(0, equals).trim();
		if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.push(name);
	}
	return [...new Set(names)].sort();
}

function readModelsProviders(path: string): string[] {
	const providers = asObject(readJsonObject(path)?.["providers"]);
	return providers === undefined ? [] : Object.keys(providers);
}

/** The provider ids `provider-pool.json` routes to: role chains, free refs, walls and lane defaults. The virtual id is not a provider. */
function readPoolProviders(path: string): string[] {
	const parsed = readJsonObject(path);
	if (parsed === undefined) return [];
	const virtual = typeof parsed["virtualProvider"] === "string" ? parsed["virtualProvider"] : undefined;
	const found = new Set<string>();
	const addProvider = (value: unknown): void => {
		if (typeof value !== "string") return;
		const id = value.trim();
		if (id === "" || id === virtual) return;
		if (/^[a-z0-9][a-z0-9._-]*$/.test(id)) found.add(id);
	};
	const addRef = (ref: unknown): void => {
		if (typeof ref !== "string") return;
		const slash = ref.indexOf("/");
		if (slash > 0) addProvider(ref.slice(0, slash));
	};
	for (const role of Object.values(asObject(parsed["roles"]) ?? {})) if (Array.isArray(role)) for (const ref of role) addRef(ref);
	for (const ref of Array.isArray(parsed["freeRefs"]) ? parsed["freeRefs"] : []) addRef(ref);
	for (const key of Object.keys(asObject(parsed["providerWalls"]) ?? {})) addProvider(key);
	for (const entry of Object.values(asObject(parsed["laneDefaults"]) ?? {})) {
		const candidates = Array.isArray(entry) ? entry : Array.isArray(asObject(entry)?.["candidates"]) ? (asObject(entry)!["candidates"] as unknown[]) : [];
		for (const ref of candidates) addRef(ref);
	}
	return [...found].sort();
}

function onPath(command: string, env: NodeJS.ProcessEnv): boolean {
	for (const dir of (env["PATH"] ?? "").split(":")) {
		if (dir === "") continue;
		const candidate = join(dir, command);
		try {
			if (existsSync(candidate) && statSync(candidate).isFile()) {
				accessSync(candidate, constants.X_OK);
				return true;
			}
		} catch {
			// Not executable, or not reachable: keep looking down PATH.
		}
	}
	return false;
}

/**
 * Compare the inventory with the evidence on disk: provider ids in `auth.json`, `models.json` and `provider-pool.json`, variable names
 * in the key file, and whether an entry's command is on `PATH`. Nothing here reads a value.
 */
export function checkSubscriptionInventory(options: InventoryCheckOptions = {}): InventoryCheck {
	const env = options.env ?? process.env;
	const home = env["HOME"]?.trim() || homedir();
	const agentDir = join(home, ".pi", "agent");
	const inventoryPath = options.inventoryPath ?? DEFAULT_SUBSCRIPTIONS_PATH();
	const plans = loadSubscriptionPlans(inventoryPath, { signalsPath: options.signalsPath });
	const authJson = readAuthJson(join(agentDir, "auth.json"));
	const envNames = readEnvNames(join(home, ".config", "agent-keys.env"));
	const diskProviders = [...new Set([
		...authJson.map((entry) => entry.id),
		...readModelsProviders(join(agentDir, "models.json")),
		...readPoolProviders(join(agentDir, "provider-pool.json")),
	])].sort();
	const listed = new Set(plans.map((plan) => plan.provider.trim().toLowerCase()));
	const unlistedProviders = diskProviders.filter((id) => !listed.has(id.toLowerCase()));
	const namedEnv = new Set(plans.map((plan) => plan.credential?.env).filter((name): name is string => name !== undefined));
	const unlistedEnvNames = envNames.filter((name) => CREDENTIAL_ENV_NAME.test(name) && !namedEnv.has(name));
	const stale: string[] = [];
	const missingCommands: string[] = [];
	const commandsOnPath: string[] = [];
	for (const plan of plans) {
		const credential = plan.credential;
		if (credential === undefined) continue;
		if (credential.authJson !== undefined && !authJson.some((entry) => entry.id === credential.authJson)) stale.push(`${plan.provider} -> auth.json ${credential.authJson}`);
		if (credential.env !== undefined && !envNames.includes(credential.env)) stale.push(`${plan.provider} -> env ${credential.env}`);
		if (credential.cli !== undefined) {
			if (onPath(credential.cli, env)) {
				commandsOnPath.push(credential.cli);
			} else {
				missingCommands.push(credential.cli);
				stale.push(`${plan.provider} -> cli ${credential.cli}`);
			}
		}
	}
	const byKind: Record<PlanKind, number> = { subscription: 0, metered: 0, free: 0 };
	for (const plan of plans) if (plan.kind !== undefined) byKind[plan.kind] += 1;
	return {
		inventoryPath,
		home,
		entries: plans.length,
		byKind,
		authJson,
		envNames,
		diskProviders,
		commandsOnPath: [...new Set(commandsOnPath)].sort(),
		unlistedProviders,
		unlistedEnvNames,
		stale,
		missingCommands: [...new Set(missingCommands)].sort(),
	};
}

const price = (monthlyUsd: number | null): string => (monthlyUsd === null ? "price unknown" : `$${monthlyUsd}/mo`);

function credentialText(credential: PlanCredential | undefined): string {
	if (credential === undefined) return "no credential";
	const parts = [
		credential.authJson === undefined ? undefined : `auth.json:${credential.authJson}`,
		credential.env === undefined ? undefined : `env:${credential.env}`,
		credential.cli === undefined ? undefined : `cli:${credential.cli}`,
	].filter((part): part is string => part !== undefined);
	return parts.length === 0 ? "no credential" : parts.join(" ");
}

/** One line per entry: what it is, what it costs, where its credential lives and how its usage is read. */
export function formatInventory(plans: readonly SubscriptionPlan[]): string[] {
	if (plans.length === 0) return ["(no entries)"];
	const width = Math.max(...plans.map((plan) => plan.provider.length));
	return plans.map((plan) => {
		const usage = plan.usage === undefined
			? "usage: none listed"
			: `${plan.usage.method}${plan.usage.reader === undefined ? "" : ` ${plan.usage.reader}`}${plan.usage.cadence === undefined ? "" : ` (${plan.usage.cadence})`}`;
		return `${plan.provider.padEnd(width)}  ${(plan.kind ?? "kind unknown").padEnd(12)}  ${plan.name}  ${price(plan.monthlyUsd)}  ${credentialText(plan.credential)}  ${usage}`;
	});
}

const listed = (values: readonly string[]): string => (values.length === 0 ? "none" : values.join(", "));

/** The `--check` report: what is unlisted, what is stale, and the evidence each answer rests on. Names only. */
export function formatInventoryCheck(check: InventoryCheck): string[] {
	const lines = [
		`inventory: ${check.entries} entries (${check.byKind.subscription} subscription, ${check.byKind.metered} metered, ${check.byKind.free} free) from ${check.inventoryPath}`,
		`evidence: ${check.diskProviders.length} provider ids in auth.json, models.json or provider-pool.json; ${check.envNames.length} variable names in ${join(check.home, ".config", "agent-keys.env")} (parsed, never sourced)`,
		`unlisted providers (on disk, named by no entry): ${listed(check.unlistedProviders)}`,
		`unlisted environment names (credential-shaped, named by no entry): ${listed(check.unlistedEnvNames)}`,
		`missing commands: ${listed(check.missingCommands)}`,
	];
	if (check.stale.length === 0) return [...lines, "stale entries: none"];
	return [...lines, "stale entries (the credential the entry names is not where it says it is):", ...check.stale.map((line) => `  ${line}`)];
}

/** A window of `days` days costs that share of a 30-day month of each plan. */
export function fleetSavings(rows: readonly HarnessValueRow[], plans: readonly SubscriptionPlan[], days: number): FleetSavings {
	const priced = rows.filter((row) => row.equivalent_value !== null);
	const equivalentValue = priced.length === 0 ? null : priced.reduce((sum, row) => sum + Number(row.equivalent_value), 0);
	const planCostUsd = plans.reduce((sum, plan) => sum + (plan.monthlyUsd === null ? 0 : plan.monthlyUsd * days / DAYS_PER_MONTH), 0);
	const known = equivalentValue !== null && plans.length > 0;
	return {
		equivalentValue,
		unknownTurns: rows.reduce((sum, row) => sum + Number(row.unknown_equivalent_value_turns ?? 0), 0),
		planCostUsd,
		unknownPlans: plans.filter((plan) => plan.monthlyUsd === null).map((plan) => plan.name),
		hasPlans: plans.length > 0,
		savingsUsd: known ? equivalentValue - planCostUsd : null,
		multiple: known && planCostUsd > 0 ? equivalentValue / planCostUsd : null,
	};
}

const usd = (value: number): string => `$${value.toFixed(2)}`;

/** One line per harness (API value only), then one fleet line against every plan. A lower bound says "at least", an unknown says unknown. */
export function formatSavings(rows: readonly HarnessValueRow[], fleet: FleetSavings, period: string): string[] {
	const lines = rows.map((row) => {
		const unknownTurns = Number(row.unknown_equivalent_value_turns ?? 0);
		if (row.equivalent_value === null) return `- ${row.harness} (${period}): API-equivalent unknown${unknownTurns ? ` (${unknownTurns} turns have no rate)` : ""}`;
		return `- ${row.harness} (${period}): API-equivalent ${unknownTurns ? "at least " : ""}${usd(Number(row.equivalent_value))}`;
	});
	if (!fleet.hasPlans) return [...lines, `- fleet (${period}): no subscription plans configured, so no saving is stated`];
	const unknownPlans = fleet.unknownPlans.length ? ` (plans of unknown price: ${fleet.unknownPlans.join(", ")})` : "";
	if (fleet.equivalentValue === null || fleet.savingsUsd === null) return [...lines, `- fleet (${period}): API-equivalent unknown against plans ${usd(fleet.planCostUsd)}${unknownPlans}`];
	const value = `${fleet.unknownTurns ? "at least " : ""}${usd(fleet.equivalentValue)}`;
	// Unknown rates make the value a lower bound and unknown plans make the cost one, so each alone bounds the saving, and both together bound nothing.
	const bound = fleet.unknownTurns && fleet.unknownPlans.length ? "" : fleet.unknownTurns ? "at least " : fleet.unknownPlans.length ? "at most " : "";
	const saving = fleet.savingsUsd >= 0
		? `saves ${bound}${usd(fleet.savingsUsd)}${fleet.unknownTurns && fleet.unknownPlans.length ? " on the figures counted so far" : ""}`
		: `costs ${usd(-fleet.savingsUsd)} more than the API value counted so far`;
	const multiple = fleet.multiple === null ? "" : `, ${fleet.multiple.toFixed(1)}x`;
	return [...lines, `- fleet (${period}): API-equivalent ${value} against plans ${usd(fleet.planCostUsd)}${unknownPlans}: ${saving}${multiple}`];
}
