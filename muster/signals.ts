/**
 * The signal log (UM8 of
 * `plans/provider-accounts/usage-monitor-blueprint-2026-10-16.md`).
 *
 * One store for the usage, launch, price, terms, meter and probe signals the
 * monitor reads and writes: `signals_add` claims one through the gateway,
 * `scripts/usage-snapshot.ts` records its own state transitions, and
 * `muster signals` reads them back. The store owns the shape, the provider and
 * model normalization, the dedupe, the daily write cap and the alert rules, so
 * no caller re-implements them.
 *
 * Append is the same owner the send log and the ask queue use
 * (`appendFsyncedLine`, `send.ts`). There is no second store and no second send
 * path: an alert line reaches the orchestrator's inbox through the port the
 * caller supplies (the gateway's `sendToOrchestrator`, which is
 * `deliverLaneMessage` in followup mode), and the free-launch ask goes through
 * the port wired to `raiseAsk`.
 *
 * A signal is evidence, never an instruction. Nothing here acts on a signal's
 * content: the store checks a free launch against the caller's probe port and
 * raises one ask, and a meter reading only produces an alert line.
 */

import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizeProviderId } from "../routing/provider-policy.ts";
import type { Ask } from "./asks.ts";
import { appendFsyncedLine } from "./send.ts";

export const SIGNAL_EVENTS_FILE = "events.jsonl";
/** Writes one writer may append in one UTC day before the next is refused. */
export const SIGNAL_MAX_WRITES_PER_DAY = 200;
/** An equal dedupe key inside this window writes nothing. */
export const SIGNAL_DEDUPE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const SIGNAL_LIMITS_MAX_CHARS = 500;
export const SIGNAL_TEXT_MAX_CHARS = 1000;
export const SIGNAL_AUTHOR_MAX_CHARS = 100;
export const SIGNAL_WINDOWS_MAX = 4;
export const SIGNAL_RECEIPT_MIN_AMOUNT = 0;
export const SIGNAL_READ_LIMIT_DEFAULT = 50;
export const SIGNAL_READ_LIMIT_MAX = 500;

export const SIGNAL_KINDS = ["usage", "launch", "price", "terms", "meter", "probe", "idea"] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];
export const SIGNAL_SOURCES = ["x", "news", "provider-page", "provider-catalog", "local", "dashboard", "receipt"] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];
export const SIGNAL_WRITERS = ["grokbot", "usage-snapshot", "model-catalog", "model-probe", "meter-browser", "receipt-reader"] as const;
export type SignalWriter = (typeof SIGNAL_WRITERS)[number];
export const SIGNAL_CONFIDENCES = ["low", "medium", "high"] as const;
export type SignalConfidence = (typeof SIGNAL_CONFIDENCES)[number];
export const SIGNAL_ACCOUNTS = ["personal", "acme-realty", "studio"] as const;
export type SignalAccount = (typeof SIGNAL_ACCOUNTS)[number];

/**
 * The kinds the gateway may write. `usage` is this machine's own snapshot
 * transition and `probe` is UM9's local probe result, so neither is ever
 * accepted from the bot.
 */
export const GATEWAY_SIGNAL_KINDS: readonly SignalKind[] = ["launch", "price", "terms", "meter", "idea"];

export type SignalTerms = {
	training?: "yes" | "no" | "unknown";
	retention?: string;
	notes?: string;
};
export type SignalWindow = {
	name: string;
	usedPercent: number;
	resetsAt?: number;
	/**
	 * The model this window belongs to, when the page states one (UD4). A window with a model is a
	 * per-model reading: the snapshot keeps it out of `quota`, so routing never acts on it.
	 */
	model?: string;
};
export type SignalReceipt = {
	plan: string;
	amount: number;
	currency: string;
	period: "month" | "year" | "once";
	chargedOn: string;
};

/**
 * The rhythm a provider is paid on. The store owns the vocabulary, and `usage-snapshot.mts` aliases
 * its own `BillingCycle` to it, so a billing word is spelled in exactly one place.
 */
export const SIGNAL_BILLING_CYCLES = ["monthly", "annual", "prepaid", "metered"] as const;
export type SignalBillingCycle = (typeof SIGNAL_BILLING_CYCLES)[number];

/**
 * One reading's own billing dates (UD3): what the provider's page states about the plan, never a figure
 * this machine computed. Every field is optional, so a page that states only the next charge still lands.
 */
export type SignalBilling = {
	cycle?: SignalBillingCycle;
	amount?: number;
	currency?: string;
	/** The day the paid period began, YYYY-MM-DD. */
	lastChargedOn?: string;
	/** The day the next charge falls, YYYY-MM-DD. */
	nextChargeOn?: string;
};

/** A metered account's credit balance, read from its own page and never rendered as a percentage (UM5). */
export type SignalBalance = { amount: number; currency: string };

/**
 * Signal shape version 1, exactly as the blueprint spells it. `provider` is
 * required for every kind except `idea` (a link and an author, no provider).
 */
export type Signal = {
	id: string;
	at: string;
	by: SignalWriter;
	kind: SignalKind;
	source: SignalSource;
	provider?: string;
	modelId?: string;
	url?: string;
	/** An `idea` only: who wrote the post the link points at. */
	author?: string;
	free?: boolean;
	limits?: string;
	terms?: SignalTerms;
	windows?: SignalWindow[];
	receipt?: SignalReceipt;
	/** A reading's own billing dates (UD3), a `meter` field. */
	billing?: SignalBilling;
	/** A metered account's balance read from its page (UD3), a `meter` field. */
	balance?: SignalBalance;
	account?: SignalAccount;
	observedAt: string;
	confidence: SignalConfidence;
	text?: string;
	dedupeKey: string;
};

/** A signal as the gateway's `signals_read` returns it: Grokbot's text marked untrusted. */
export type UntrustedSignal = Signal & { untrusted?: true };

/** What a caller hands the store; `id`, `at`, `by` and `dedupeKey` are the store's. */
export type RaiseSignalInput = {
	kind: SignalKind;
	source: SignalSource;
	/** Required for every kind except `idea`. */
	provider?: string;
	modelId?: string;
	url?: string;
	author?: string;
	free?: boolean;
	limits?: string;
	terms?: SignalTerms;
	windows?: SignalWindow[];
	receipt?: SignalReceipt;
	billing?: SignalBilling;
	balance?: SignalBalance;
	account?: SignalAccount;
	observedAt: string;
	confidence: SignalConfidence;
	text?: string;
};

/** The store's own refusals; a gateway caller turns one into a `ToolRefusal`. */
export class SignalStateError extends Error {}

const INPUT_KEYS = new Set([
	"kind", "source", "provider", "modelId", "url", "author", "free", "limits", "terms",
	"windows", "receipt", "billing", "balance", "account", "observedAt", "confidence", "text",
]);
const TERMS_KEYS = new Set(["training", "retention", "notes"]);
const WINDOW_KEYS = new Set(["name", "usedPercent", "resetsAt", "model"]);
const RECEIPT_KEYS = new Set(["plan", "amount", "currency", "period", "chargedOn"]);
const BILLING_KEYS = new Set(["cycle", "amount", "currency", "lastChargedOn", "nextChargeOn"]);
const BALANCE_KEYS = new Set(["amount", "currency"]);
const URL_KINDS: readonly SignalKind[] = ["launch", "price", "terms", "idea"];

// ─── The store ───────────────────────────────────────────────────────────────

/** The signals directory under a Muster state dir: `<stateDir>/signals`. */
export function signalsDir(musterStateDir: string): string {
	return join(musterStateDir, "signals");
}

/** The one event file: `<stateDir>/signals/events.jsonl`. */
export function signalsEventsPath(musterStateDir: string): string {
	return join(signalsDir(musterStateDir), SIGNAL_EVENTS_FILE);
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

/** Does a non-empty file end without a newline (the torn tail of a crash)? */
function endsWithoutNewline(path: string): boolean {
	let size: number;
	try {
		size = statSync(path).size;
	} catch {
		return false;
	}
	if (size === 0) return false;
	const fd = openSync(path, "r");
	try {
		const byte = Buffer.alloc(1);
		const read = readSync(fd, byte, 0, 1, size - 1);
		return read === 1 && byte[0] !== 0x0a;
	} catch {
		return false;
	} finally {
		closeSync(fd);
	}
}

/**
 * Append one signal (file mode 0600, fsynced, directory 0700), through the one
 * append body the send log also uses. The append carries its own leading
 * newline when the file does not end on one, so a write torn by a crash stays
 * its own unreadable line instead of swallowing the next signal.
 */
export function appendSignal(musterStateDir: string, signal: Signal): void {
	const repair = endsWithoutNewline(signalsEventsPath(musterStateDir)) ? "\n" : "";
	appendFsyncedLine(signalsDir(musterStateDir), SIGNAL_EVENTS_FILE, `${repair}${JSON.stringify(signal)}\n`);
}

export type SignalLog = {
	signals: Signal[];
	path: string;
	/** The count of lines the store could not read (a torn tail counts once). */
	partialLastLine: number;
	unreadableLines: number;
};

function isSignal(value: unknown): value is Signal {
	if (value === null || typeof value !== "object") return false;
	const signal = value as Partial<Signal> & Record<string, unknown>;
	if (!(SIGNAL_KINDS as readonly string[]).includes(String(signal["kind"]))) return false;
	if (!(SIGNAL_WRITERS as readonly string[]).includes(String(signal["by"]))) return false;
	if (!(SIGNAL_SOURCES as readonly string[]).includes(String(signal["source"]))) return false;
	if (!(SIGNAL_CONFIDENCES as readonly string[]).includes(String(signal["confidence"]))) return false;
	// An idea is a link and an author: no provider, and every other kind needs one.
	// A stored row that still carries a provider on an idea is data the append-only
	// store keeps whole (sig_30885d40 and its siblings), so a reader tolerates it.
	const providerOk = signal["kind"] === "idea" ? signal["provider"] === undefined || nonEmpty(signal["provider"]) : nonEmpty(signal["provider"]);
	return nonEmpty(signal["id"]) && nonEmpty(signal["at"]) && providerOk && nonEmpty(signal["dedupeKey"]);
}

/** Read the event file in append order. It never throws on file content. */
export function readSignalLog(musterStateDir: string): SignalLog {
	const path = signalsEventsPath(musterStateDir);
	let raw = "";
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		raw = "";
	}
	const signals: Signal[] = [];
	let unreadableLines = 0;
	let partialLastLine = 0;

	const lines = raw.split("\n");
	// Content after the last newline: a torn write (unusable), or a complete
	// line whose newline was lost (usable, and counted: the next append repairs it).
	const trailing = lines.pop() ?? "";
	if (trailing.trim() !== "") {
		partialLastLine = 1;
		try {
			const parsed: unknown = JSON.parse(trailing);
			if (isSignal(parsed)) signals.push(parsed);
		} catch {
			// The torn write itself: counted by `partialLastLine`, not again below.
		}
	}
	for (const line of lines) {
		if (line.trim() === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			unreadableLines += 1;
			continue;
		}
		if (isSignal(parsed)) signals.push(parsed);
		else unreadableLines += 1;
	}
	return { signals, path, partialLastLine, unreadableLines };
}

export type SignalReadOptions = {
	/** ISO time; only signals at or after it are returned. */
	since?: string;
	kind?: SignalKind;
	provider?: string;
	limit?: number;
	/**
	 * When set, every signal written by `grokbot` comes back with
	 * `untrusted: true` and its text behind this prefix. The gateway passes
	 * `EXTERNAL_PREFIX`; the store never invents one.
	 */
	untrustedPrefix?: string;
};

export type SignalRead = {
	signals: UntrustedSignal[];
	path: string;
	partialLastLine: number;
	unreadableLines: number;
};

/** Read the log, newest last, filtered and (when asked) marked untrusted. */
export function readSignals(musterStateDir: string, options: SignalReadOptions = {}): SignalRead {
	const log = readSignalLog(musterStateDir);
	const kind = options.kind;
	const provider = options.provider === undefined ? undefined : normalizeProviderId(options.provider);
	let signals = log.signals.filter((signal) => {
		if (options.since !== undefined && signal.at < options.since) return false;
		if (kind !== undefined && signal.kind !== kind) return false;
		if (provider !== undefined && signal.provider !== provider) return false;
		return true;
	});
	const limit = clampLimit(options.limit);
	if (signals.length > limit) signals = signals.slice(signals.length - limit);
	return {
		signals: options.untrustedPrefix === undefined ? signals : signals.map((signal) => markUntrusted(signal, options.untrustedPrefix!)),
		path: log.path,
		partialLastLine: log.partialLastLine,
		unreadableLines: log.unreadableLines,
	};
}

/** Grokbot's own text is external input; it never reads back as a plain claim. */
export function markUntrusted(signal: Signal, prefix: string): UntrustedSignal {
	if (signal.by !== "grokbot") return signal;
	return {
		...signal,
		untrusted: true,
		...(signal.text !== undefined ? { text: `${prefix}${signal.text}` } : {}),
	};
}

function clampLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit) || limit < 1) return SIGNAL_READ_LIMIT_DEFAULT;
	return Math.min(Math.floor(limit), SIGNAL_READ_LIMIT_MAX);
}

// ─── Validation ──────────────────────────────────────────────────────────────

function refuse(reason: string): never {
	throw new SignalStateError(reason);
}

function assertKnownKeys(value: object, allowed: Set<string>, what: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) refuse(`${what} has an unknown field: ${key}`);
	}
}

function requireString(value: unknown, what: string): string {
	if (typeof value !== "string" || value.trim() === "") refuse(`${what} is required`);
	return value.trim();
}

function optionalString(value: unknown, what: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") refuse(`${what} must be a string`);
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

function isoTime(value: unknown, what: string): string {
	const text = requireString(value, what);
	const parsed = Date.parse(text);
	if (Number.isNaN(parsed)) refuse(`${what} is not an ISO time: ${text}`);
	return text;
}

function httpsUrl(value: string): string {
	let parsed: URL | undefined;
	try {
		parsed = new URL(value);
	} catch {
		refuse(`url is not a URL: ${value}`);
	}
	if (parsed === undefined || parsed.protocol !== "https:") refuse(`url must be https: ${value}`);
	return value;
}

function validateTerms(value: unknown): SignalTerms {
	if (value === null || typeof value !== "object") refuse("terms must be an object");
	const terms = value as Record<string, unknown>;
	assertKnownKeys(terms, TERMS_KEYS, "terms");
	const training = terms["training"];
	if (training !== undefined && training !== "yes" && training !== "no" && training !== "unknown") {
		refuse('terms.training must be "yes", "no" or "unknown"');
	}
	const out: SignalTerms = {};
	if (training !== undefined) out.training = training as SignalTerms["training"];
	const retention = optionalString(terms["retention"], "terms.retention");
	if (retention !== undefined) out.retention = retention;
	const notes = optionalString(terms["notes"], "terms.notes");
	if (notes !== undefined) out.notes = notes;
	return out;
}

function validateWindows(value: unknown): SignalWindow[] {
	if (!Array.isArray(value)) refuse("windows must be an array");
	if (value.length > SIGNAL_WINDOWS_MAX) refuse(`windows carries at most ${SIGNAL_WINDOWS_MAX} entries`);
	return value.map((entry, index) => {
		if (entry === null || typeof entry !== "object") refuse(`windows[${index}] must be an object`);
		const window = entry as Record<string, unknown>;
		assertKnownKeys(window, WINDOW_KEYS, `windows[${index}]`);
		const name = requireString(window["name"], `windows[${index}].name`);
		const used = window["usedPercent"];
		if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) {
			refuse(`windows[${index}].usedPercent must be a number between 0 and 100`);
		}
		const out: SignalWindow = { name, usedPercent: used };
		if (window["resetsAt"] !== undefined) out.resetsAt = Date.parse(isoTime(window["resetsAt"], `windows[${index}].resetsAt`));
		const model = optionalString(window["model"], `windows[${index}].model`);
		if (model !== undefined) out.model = model;
		return out;
	});
}

function validateReceipt(value: unknown): SignalReceipt {
	if (value === null || typeof value !== "object") refuse("receipt must be an object");
	const receipt = value as Record<string, unknown>;
	// A receipt never carries a mail address, a message id, a subject or a body.
	assertKnownKeys(receipt, RECEIPT_KEYS, "receipt");
	const plan = requireString(receipt["plan"], "receipt.plan");
	const amount = receipt["amount"];
	if (typeof amount !== "number" || !Number.isFinite(amount) || amount < SIGNAL_RECEIPT_MIN_AMOUNT) {
		refuse("receipt.amount must be a number of 0 or more");
	}
	const currency = requireString(receipt["currency"], "receipt.currency");
	const period = receipt["period"];
	if (period !== "month" && period !== "year" && period !== "once") refuse('receipt.period must be "month", "year" or "once"');
	const chargedOn = requireString(receipt["chargedOn"], "receipt.chargedOn");
	return { plan, amount, currency, period: period as SignalReceipt["period"], chargedOn };
}

/**
 * One reading's billing dates, validated like a receipt: an object of stated fields, no figure invented,
 * and no field a page could pad with an address or a body.
 */
function validateBilling(value: unknown): SignalBilling {
	if (value === null || typeof value !== "object" || Array.isArray(value)) refuse("billing must be an object");
	const billing = value as Record<string, unknown>;
	assertKnownKeys(billing, BILLING_KEYS, "billing");
	const out: SignalBilling = {};
	if (billing["cycle"] !== undefined) {
		if (!(SIGNAL_BILLING_CYCLES as readonly unknown[]).includes(billing["cycle"])) {
			refuse(`billing.cycle must be one of: ${SIGNAL_BILLING_CYCLES.join(", ")}`);
		}
		out.cycle = billing["cycle"] as SignalBillingCycle;
	}
	if (billing["amount"] !== undefined) {
		const amount = billing["amount"];
		if (typeof amount !== "number" || !Number.isFinite(amount) || amount < SIGNAL_RECEIPT_MIN_AMOUNT) {
			refuse("billing.amount must be a number of 0 or more");
		}
		out.amount = amount;
	}
	const currency = optionalString(billing["currency"], "billing.currency");
	if (currency !== undefined) out.currency = currency;
	const lastChargedOn = optionalString(billing["lastChargedOn"], "billing.lastChargedOn");
	if (lastChargedOn !== undefined) out.lastChargedOn = lastChargedOn;
	const nextChargeOn = optionalString(billing["nextChargeOn"], "billing.nextChargeOn");
	if (nextChargeOn !== undefined) out.nextChargeOn = nextChargeOn;
	return out;
}

/** A metered account's balance: an amount and the currency it is in, never a percentage (UM5). */
function validateBalance(value: unknown): SignalBalance {
	if (value === null || typeof value !== "object" || Array.isArray(value)) refuse("balance must be an object");
	const balance = value as Record<string, unknown>;
	assertKnownKeys(balance, BALANCE_KEYS, "balance");
	const amount = balance["amount"];
	if (typeof amount !== "number" || !Number.isFinite(amount)) refuse("balance.amount must be a number");
	return { amount, currency: requireString(balance["currency"], "balance.currency") };
}

/** Validate one caller's input and return it normalized. */
export function normalizeSignalInput(input: RaiseSignalInput): RaiseSignalInput {
	assertKnownKeys(input as unknown as object, INPUT_KEYS, "signal");
	const kind = input.kind;
	if (!(SIGNAL_KINDS as readonly string[]).includes(kind)) refuse(`kind must be one of: ${SIGNAL_KINDS.join(", ")}`);
	const source = input.source;
	if (!(SIGNAL_SOURCES as readonly string[]).includes(source)) refuse(`source must be one of: ${SIGNAL_SOURCES.join(", ")}`);
	if (!(SIGNAL_CONFIDENCES as readonly string[]).includes(input.confidence)) {
		refuse(`confidence must be one of: ${SIGNAL_CONFIDENCES.join(", ")}`);
	}
	const out: RaiseSignalInput = {
		kind,
		source,
		observedAt: isoTime(input.observedAt, "observedAt"),
		confidence: input.confidence,
	};
	if (kind === "idea") {
		// An idea is a link and an author: it carries no provider and no model id.
		if (input.provider !== undefined) refuse("an idea carries no provider: it is a link and an author");
		if (input.modelId !== undefined) refuse("modelId is not an idea field");
	} else {
		out.provider = normalizeProviderId(requireString(input.provider, "provider"));
	}

	if (input.modelId !== undefined) {
		const modelId = optionalString(input.modelId, "modelId");
		// Trimmed and lower-cased before anything else, so case variants neither
		// escape the dedupe nor take a real model's key.
		if (modelId !== undefined) out.modelId = modelId.toLowerCase();
	}
	if (input.url !== undefined) out.url = httpsUrl(requireString(input.url, "url"));
	if (input.author !== undefined) {
		if (kind !== "idea") refuse("author is an idea field");
		const author = optionalString(input.author, "author");
		if (author !== undefined) {
			if (author.length > SIGNAL_AUTHOR_MAX_CHARS) refuse(`author carries at most ${SIGNAL_AUTHOR_MAX_CHARS} characters`);
			out.author = author;
		}
	}
	if (input.free !== undefined) {
		if (typeof input.free !== "boolean") refuse("free must be true or false");
		out.free = input.free;
	}
	if (input.limits !== undefined) {
		const limits = requireString(input.limits, "limits");
		if (limits.length > SIGNAL_LIMITS_MAX_CHARS) refuse(`limits carries at most ${SIGNAL_LIMITS_MAX_CHARS} characters`);
		out.limits = limits;
	}
	if (input.text !== undefined) {
		const text = requireString(input.text, "text");
		if (text.length > SIGNAL_TEXT_MAX_CHARS) refuse(`text carries at most ${SIGNAL_TEXT_MAX_CHARS} characters`);
		out.text = text;
	}
	if (input.account !== undefined) {
		if (!(SIGNAL_ACCOUNTS as readonly string[]).includes(input.account)) {
			refuse(`account must be one of: ${SIGNAL_ACCOUNTS.join(", ")} (a label, never an address)`);
		}
		out.account = input.account;
	}
	if (input.terms !== undefined) out.terms = validateTerms(input.terms);
	if (input.windows !== undefined) {
		if (kind !== "meter") refuse("windows is a meter field");
		out.windows = validateWindows(input.windows);
	}
	if (input.receipt !== undefined) {
		if (kind !== "price") refuse("receipt is a price field");
		out.receipt = validateReceipt(input.receipt);
	}
	if (input.billing !== undefined) {
		if (kind !== "meter") refuse("billing is a meter field");
		out.billing = validateBilling(input.billing);
	}
	if (input.balance !== undefined) {
		if (kind !== "meter") refuse("balance is a meter field");
		out.balance = validateBalance(input.balance);
	}
	// A `price` signal that carries a receipt is a charge, not a link (UB0 UD1): the receipt's own plan and
	// day are its identity, so it needs no url. Every other price signal still needs one.
	if ((URL_KINDS as readonly string[]).includes(kind) && out.url === undefined && out.receipt === undefined) {
		refuse(`url is required for a ${kind} signal`);
	}
	return out;
}

// ─── The dedupe key ──────────────────────────────────────────────────────────

/** The URL without query and fragment, as the dedupe sees it. */
export function stripQueryFragment(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.search = "";
		parsed.hash = "";
		return parsed.toString();
	} catch {
		return url;
	}
}

/** `YYYY-MM-DDTHH` in UTC: a meter reading's hour bucket. */
function hourBucket(at: string): string {
	return at.slice(0, 13);
}

/** `YYYY-MM-DD` in UTC: a probe result's day bucket. */
function dayBucket(at: string): string {
	return at.slice(0, 10);
}

/**
 * The result a `probe` signal's text carries — `pass` or `fail`, the word
 * `scripts/model-probe.ts` writes first — or `-` when the text names neither: a
 * result nobody stated never collapses into one that was.
 */
function probeResult(text: string | undefined): string {
	return /^\s*(pass|fail)\b/.exec(text ?? "")?.[1] ?? "-";
}

/**
 * `kind|provider|modelId` (or the URL without query and fragment when there is
 * no model id). An `idea` is `idea||<URL without query and fragment>`, whatever the provider. A `meter` key adds `observedAt` rounded to the hour, so the
 * twice-daily readings never collapse into one.
 *
 * A `price` signal that carries a receipt keys on the receipt itself:
 * `price|<provider>|receipt|<account>|<plan>|<chargedOn>`, so two receipts in one week are two signals, and
 * the same receipt from grokbot and from the receipt reader is one.
 *
 * A `usage` signal is one state transition, not a claim that repeats: its key
 * carries the transition's own label, so a wall that starts and later lifts is
 * two signals while an identical duplicate reading inside the window is one.
 *
 * A `probe` signal is a measurement of a model that changes its answer: its key
 * carries the result and the UTC day, so a fail followed by a pass is two
 * signals, a repeat of the same result on the same day is one, and the same
 * result on the next day is measurable again (UM11 admits on a pass from the
 * last 24 hours, which a single 7-day key could never supply).
 */
export function dedupeKeyFor(
	input: Pick<RaiseSignalInput, "kind" | "provider" | "modelId" | "url" | "observedAt" | "text" | "receipt" | "account">,
): string {
	// An idea is the link: the same post under any provider (or none) is one idea.
	if (input.kind === "idea") return `idea||${input.url === undefined ? "" : stripQueryFragment(input.url)}`;
	// A receipt is the charge, not a link (UB0 UD1): the key carries the provider, the account, the plan and
	// the day, so two receipts in one week both land while the same receipt from two writers is one signal.
	if (input.kind === "price" && input.receipt !== undefined) {
		return `price|${input.provider ?? ""}|receipt|${input.account ?? ""}|${input.receipt.plan}|${input.receipt.chargedOn}`;
	}
	const subject =
		input.modelId !== undefined && input.modelId !== ""
			? input.modelId
			: input.url !== undefined
				? stripQueryFragment(input.url)
				: input.kind === "usage"
					? (input.text ?? "").trim().toLowerCase().replace(/\s+/g, " ")
					: "";
	const base = `${input.kind}|${input.provider ?? ""}|${subject}`;
	if (input.kind === "meter") return `${base}|${hourBucket(input.observedAt)}`;
	if (input.kind === "probe") return `${base}|${probeResult(input.text)}|${dayBucket(input.observedAt)}`;
	return base;
}

// ─── The write path ──────────────────────────────────────────────────────────

/** The ask the store raises into the operator's queue for a free launch that passed its probe. */
export type SignalAskInput = {
	kind: "authorization";
	question: string;
	code?: string;
	link?: string;
	blocks?: string[];
};

/**
 * The ask code the store raises for a free launch: `free-` plus the first 12 hex
 * of the sha1 of the ref. Deterministic and stable across runs, and short enough
 * for the queue's own code shape (`asks.ts` `CODE_PATTERN`, at most 24
 * characters). The spelling `free-<provider>-<modelId>` this replaced exceeded
 * that shape for every real model id, so the queue refused the raise and no ask
 * existed for the operator to answer (UM11 send-back, 2026-10-17).
 */
export function freeLaunchAskCode(provider: string, modelId: string): string {
	return `free-${createHash("sha1").update(`${provider}/${modelId}`).digest("hex").slice(0, 12)}`;
}

/** How long a settled free-launch ask keeps the next one from being raised (UM11, SL3 F3-1). */
export const FREE_LAUNCH_ASK_SETTLE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether the queue already holds the free-launch ask for this ref, or settled one
 * inside the window: the owner of "one ask per free find" (UM11, SL3 F3-1).
 *
 * The ask's code is `freeLaunchAskCode(provider, modelId)`, so the provider is part
 * of the identity and a model id two providers share cannot suppress the other's
 * ask. A live ask on the operator's queue always counts; a settled one — answered, done
 * or withdrawn — counts for the window, so his answer is not asked again the next
 * day, and a later launch may ask again once the window has passed.
 *
 * The queue's reader is the caller's (`asks.ts` `readAsks`): the store raises into
 * asks through its port and never reads the queue itself.
 */
export function hasFreeLaunchAsk(asks: readonly Ask[], provider: string, modelId: string, now: number = Date.now()): boolean {
	const code = freeLaunchAskCode(provider, modelId);
	return asks.some((ask) => {
		if (ask.code !== code) return false;
		if (ask.status === "open" || ask.status === "awaiting-operator") return true;
		const settledAt = Date.parse(ask.answeredAt ?? ask.closedAt ?? ask.raisedAt);
		return !Number.isNaN(settledAt) && now - settledAt <= FREE_LAUNCH_ASK_SETTLE_WINDOW_MS;
	});
}

/**
 * The ports the store calls for its alerts. Every one is injected: the store
 * decides what reaches whom, and its caller owns the transport. Absent ports
 * mean the alert is not delivered (a local reader, or a test).
 */
export type SignalAlertPorts = {
	/** One line to the orchestrator's Muster inbox (`deliverLaneMessage`, followup). */
	notifyOrchestrator?: (line: string) => unknown;
	/** Raise one ask into the operator's queue (`asks.ts` `raiseAsk`). */
	raiseAsk?: (input: SignalAskInput) => unknown;
	/** UM9's catalog-and-probe verdict for a free model. Absent means no ask yet. */
	probePassed?: (provider: string, modelId: string) => boolean | Promise<boolean>;
	/** The inventory's monthly USD figure for a provider and plan, when it has one. */
	inventoryAmount?: (provider: string, plan: string) => number | undefined;
	/**
	 * Is an ask already on the queue for this model? Guards "never a second ask".
	 * The argument is the model's full `<provider>/<model id>` ref, not the bare id:
	 * the ask's own question carries the ref, so a caller that matches on the
	 * question text cannot confuse two providers that ship the same model id
	 * (SL3 F3-1).
	 */
	hasAskForModel?: (ref: string) => boolean | Promise<boolean>;
	now?: () => Date;
};

/**
 * What `raiseSignal` reports: the id and whether an equal key already covered it,
 * plus the record itself — the signal just written, or the existing one the key
 * matched. A caller that acts on the record afterwards (UM9's catalog scan asks
 * for its own free finds, SL3 F3-2) holds it from this return rather than reading
 * the log back a second time.
 */
export type RaiseSignalResult = { id: string; duplicate: boolean; signal: Signal };

/**
 * Record one signal from one writer, or report that an equal key already exists
 * within the dedupe window. The writer is never a caller's field.
 */
export async function raiseSignal(
	musterStateDir: string,
	by: SignalWriter,
	input: RaiseSignalInput,
	ports: SignalAlertPorts = {},
): Promise<RaiseSignalResult> {
	if (!(SIGNAL_WRITERS as readonly string[]).includes(by)) refuse(`${by} is not a signal writer`);
	const draft = normalizeSignalInput(input);
	const log = readSignalLog(musterStateDir);
	const now = ports.now?.() ?? new Date();

	// An equal key inside the window is a duplicate at any count, so it is looked up before the cap.
	const dedupeKey = dedupeKeyFor(draft);
	const duplicate = log.signals.find(
		(signal) => signal.dedupeKey === dedupeKey && now.getTime() - Date.parse(signal.at) <= SIGNAL_DEDUPE_WINDOW_MS,
	);
	if (duplicate !== undefined) return { id: duplicate.id, duplicate: true, signal: duplicate };

	// The writer's daily cap: it is a per-writer budget, never per provider.
	const today = now.toISOString().slice(0, 10);
	const writtenToday = log.signals.filter((signal) => signal.by === by && signal.at.slice(0, 10) === today).length;
	if (writtenToday >= SIGNAL_MAX_WRITES_PER_DAY) {
		refuse(`${by} has written ${SIGNAL_MAX_WRITES_PER_DAY} signals today; the next write is refused until tomorrow (UTC)`);
	}

	const signal: Signal = {
		id: `sig_${randomUUID()}`,
		at: now.toISOString(),
		by,
		...draft,
		dedupeKey,
	};
	appendSignal(musterStateDir, signal);
	await deliverAlerts(signal, log.signals, ports);
	return { id: signal.id, duplicate: false, signal };
}

async function deliverAlerts(signal: Signal, prior: Signal[], ports: SignalAlertPorts): Promise<void> {
	const lines = alertLines(signal, prior, ports);
	if (ports.notifyOrchestrator !== undefined) {
		for (const line of lines) await ports.notifyOrchestrator(line);
	}
	await raiseFreeLaunchAskFor(signal, ports);
}

/** The orchestrator-inbox lines one signal produces. */
export function alertLines(signal: Signal, prior: Signal[], ports: SignalAlertPorts = {}): string[] {
	const lines: string[] = [];
	// Only an idea has no provider, and an idea raises no alert.
	const provider = signal.provider;
	if (provider === undefined) return lines;
	if (signal.kind === "meter" && signal.windows !== undefined) {
		for (const window of signal.windows) {
			const earlier = prior
				.filter((entry) => entry.kind === "meter" && entry.provider === provider && entry.windows !== undefined)
				.flatMap((entry) => (entry.windows ?? []).filter((candidate) => candidate.name === window.name).map((candidate) => candidate.usedPercent))
				.pop();
			if (earlier === undefined) continue;
			const crossedUp = earlier < 95 && window.usedPercent >= 95;
			const droppedDown = earlier >= 95 && window.usedPercent < 95;
			if (crossedUp || droppedDown) {
				lines.push(`signal ${signal.id}: meter ${provider} ${window.name} ${earlier}% -> ${window.usedPercent}%`);
			}
		}
	}
	if (signal.kind === "price" && signal.receipt !== undefined && ports.inventoryAmount !== undefined) {
		const known = ports.inventoryAmount(provider, signal.receipt.plan);
		if (known !== undefined && known !== signal.receipt.amount) {
			lines.push(`signal ${signal.id}: price ${provider} ${signal.receipt.plan} is ${signal.receipt.amount} ${signal.receipt.currency}, the inventory says ${known}`);
		}
	}
	if (signal.kind === "terms") {
		lines.push(`signal ${signal.id}: terms changed for ${provider}${signal.modelId === undefined ? "" : ` ${signal.modelId}`}`);
	}
	return lines;
}

/**
 * Raise the one ask for a free launch whose probe passed, or report that none is
 * due. Exported so a caller holding the record — UM9's catalog scan, whose free
 * find has no Grokbot announcement behind it — asks from the record it raised
 * instead of reading the log back (SL3 F3-2). Both triggers go through this body.
 *
 * Returns the ask's code when it raised one, so the caller can report which item
 * reached the operator, and `undefined` when the launch is not a free find, the probe
 * has not passed, or an ask for that ref is already on the queue.
 */
export async function raiseFreeLaunchAskFor(signal: Signal, ports: SignalAlertPorts): Promise<string | undefined> {
	if (signal.kind !== "launch" || signal.free !== true || signal.modelId === undefined || signal.provider === undefined) return undefined;
	if (ports.probePassed === undefined || ports.raiseAsk === undefined) return undefined;
	const modelId = signal.modelId;
	if (!(await ports.probePassed(signal.provider, modelId))) return undefined;
	// The ref carries the provider, so the guard and every ask-text reader see both
	// halves of the model's identity, not the id alone (SL3 F3-1).
	const ref = `${signal.provider}/${modelId}`;
	if (ports.hasAskForModel !== undefined && (await ports.hasAskForModel(ref))) return undefined;
	const terms = signal.terms;
	const code = freeLaunchAskCode(signal.provider, modelId);
	await ports.raiseAsk({
		kind: "authorization",
		code,
		...(signal.url !== undefined ? { link: signal.url } : {}),
		question: [
			`${ref} went free${signal.url === undefined ? "" : ` (${signal.url})`}.`,
			`Probe: passed.`,
			`Terms: training ${terms?.training ?? "unknown"}, retention ${terms?.retention ?? "unknown"}.`,
			`Add it to the pool's free models?`,
		].join(" "),
	});
	return code;
}
