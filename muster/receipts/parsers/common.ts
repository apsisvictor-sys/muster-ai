/**
 * The shared reading of a receipt mail (UB0 B-2).
 *
 * One place knows what a receipt says: a currency with an amount, a day, a period and a plan. Each
 * sender's parser gives this module its own plan names and its own default period, so the nine parsers
 * stay small and no two of them spell a receipt's words differently.
 *
 * Nothing here keeps a message: every helper reads the text and returns the six fields or nothing.
 */

import type { ParsedReceipt, ReceiptMessage, ReceiptPeriod } from "../types.ts";

/** The currency a receipt states as a symbol. */
const CURRENCY_BY_SYMBOL: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP", "¥": "CNY", "₹": "INR" };

/** The currency a receipt states as a word. */
const CURRENCY_WORDS = ["USD", "EUR", "GBP", "CNY", "RMB", "JPY", "INR", "HKD", "BRL"] as const;

/** The month a receipt may spell out or shorten: three letters, then whatever the issuer adds. */
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** One plan the inventory knows, with the other spellings a receipt may use for it. */
export interface ReceiptPlan {
	/** The plan name the inventory spells it with; this is what the receipt carries. */
	name: string;
	/** Other spellings of the same plan, as a receipt may write it. */
	also?: readonly string[];
}

/** The shape `gws gmail users messages get --params '{"format":"full"}'` returns. */
export interface GmailMessage {
	id?: string;
	payload?: GmailPayload;
}

export interface GmailPayload {
	headers?: Array<{ name?: string; value?: string }>;
	body?: { data?: string };
	parts?: GmailPart[];
}

export interface GmailPart {
	mimeType?: string;
	body?: { data?: string };
	parts?: GmailPart[];
}

/**
 * Decode one base64url body part. Gmail drops the padding and uses the URL alphabet, so the text is put
 * back into the standard alphabet before it is decoded; a part that does not decode is empty, never a throw.
 */
export function decodeBody(data: string): string {
	const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
	try {
		return Buffer.from(padded, "base64").toString("utf8");
	} catch {
		return "";
	}
}

/** The plain text of a message: its text parts, or its HTML parts with the markup taken off. */
function messageText(payload: GmailPayload | undefined): string {
	if (payload === undefined) return "";
	let text = "";
	let html = "";
	for (const part of payload.parts ?? []) {
		const data = part.body?.data;
		if (data === undefined) continue;
		const decoded = decodeBody(data);
		if (part.mimeType === "text/html") html += decoded;
		else text += decoded;
	}
	if (text.trim() !== "") return text;
	if (html.trim() !== "") return stripMarkup(html);
	const own = payload.body?.data;
	return own === undefined ? "" : decodeBody(own);
}

/** The HTML of a receipt, read as text: the tags go and the few entities a receipt uses are spelled out. */
function stripMarkup(html: string): string {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n");
}

/** The message as the reader needs it, or nothing when the response is not a message. */
export function messageFromGmail(raw: unknown): ReceiptMessage | undefined {
	if (raw === null || typeof raw !== "object") return undefined;
	const message = raw as GmailMessage;
	const id = typeof message.id === "string" ? message.id : undefined;
	if (id === undefined) return undefined;
	return { id, subject: headerValue(message.payload, "subject"), body: messageText(message.payload) };
}

/** The header value a receipt's subject came from, read from the message's own header list. */
function headerValue(payload: GmailPayload | undefined, name: string): string {
	for (const header of payload?.headers ?? []) {
		if (header.name?.toLowerCase() === name && typeof header.value === "string") return header.value;
	}
	return "";
}

/** One amount and the currency it is in. */
export interface ParsedAmount {
	amount: number;
	currency: string;
}

/**
 * The first amount the text states, with its currency. A symbol before the number, a currency word before
 * it and a currency word after it are all read, because a receipt states its figure in whichever of the
 * three its own issuer uses.
 */
export function parseAmount(text: string): ParsedAmount | undefined {
	const candidates: Array<{ at: number; amount: number; currency: string }> = [];
	// The number never spans whitespace: a figure and the day under it are two fields, and a separator made
	// of a space is rare enough that reading the integer alone is the safer half of the trade.
	const symbolBefore = /([$€£¥₹])\s*(\d[\d.,]*)/g;
	for (const match of text.matchAll(symbolBefore)) {
		const amount = parseDecimal(match[2] ?? "");
		if (amount !== undefined) candidates.push({ at: match.index, amount, currency: CURRENCY_BY_SYMBOL[match[1]!] ?? "USD" });
	}
	const wordBefore = new RegExp(`\\b(${CURRENCY_WORDS.join("|")})\\s*(\\d[\\d.,]*)`, "gi");
	for (const match of text.matchAll(wordBefore)) {
		const amount = parseDecimal(match[2] ?? "");
		if (amount !== undefined) candidates.push({ at: match.index, amount, currency: match[1]!.toUpperCase() });
	}
	const wordAfter = new RegExp(`(\\d[\\d.,]*)\\s*\\b(${CURRENCY_WORDS.join("|")})\\b`, "gi");
	for (const match of text.matchAll(wordAfter)) {
		const amount = parseDecimal(match[1] ?? "");
		if (amount !== undefined) candidates.push({ at: match.index, amount, currency: match[2]!.toUpperCase() });
	}
	const symbolAfter = /(\d[\d.,]*)\s*([$€£¥₹])/g;
	for (const match of text.matchAll(symbolAfter)) {
		const amount = parseDecimal(match[1] ?? "");
		if (amount !== undefined) candidates.push({ at: match.index, amount, currency: CURRENCY_BY_SYMBOL[match[2]!] ?? "USD" });
	}
	candidates.sort((left, right) => left.at - right.at);
	return candidates[0];
}

/**
 * The number a receipt writes. A group of three digits behind a separator is a thousands group, so
 * "1,234.56" is 1234.56 and "12,50" is 12.50; two separators make the last one the decimal point.
 */
export function parseDecimal(raw: string): number | undefined {
	const text = raw.replace(/[\s ]/g, "");
	if (text === "") return undefined;
	const lastComma = text.lastIndexOf(",");
	const lastDot = text.lastIndexOf(".");
	if (lastComma >= 0 && lastDot >= 0) {
		const decimalAt = Math.max(lastComma, lastDot);
		const integer = text.slice(0, decimalAt).replace(/[.,]/g, "");
		const fraction = text.slice(decimalAt + 1).replace(/[.,]/g, "");
		if (fraction === "") return undefined;
		return finite(Number(`${integer}.${fraction}`));
	}
	const separator = lastComma >= 0 ? "," : lastDot >= 0 ? "." : "";
	if (separator === "") return finite(Number(text));
	const groups = text.split(separator);
	const fraction = groups[groups.length - 1] ?? "";
	const thousands = groups.length > 2 || fraction.length === 3;
	if (thousands) return finite(Number(groups.join("")));
	const integer = groups.slice(0, -1).join("");
	return finite(Number(`${integer === "" ? "0" : integer}.${fraction}`));
}

function finite(value: number): number | undefined {
	return Number.isFinite(value) ? value : undefined;
}

/**
 * The day a receipt was charged, as YYYY-MM-DD. The forms a receipt writes are read in the order they are
 * least ambiguous in: the ISO day first, then the European day, then the month name.
 */
export function parseChargedOn(text: string): string | undefined {
	const iso = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(text);
	if (iso !== null) {
		const day = calendarDay(iso[1]!, iso[2]!, iso[3]!);
		if (day !== undefined) return day;
	}
	const european = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(text);
	if (european !== null) {
		const day = calendarDay(european[3]!, european[2]!, european[1]!);
		if (day !== undefined) return day;
	}
	const dayFirst = new RegExp(`(\\d{1,2})\\s+(${MONTHS.join("|")})[a-z]*\\.?,?\\s+(\\d{4})`, "i").exec(text);
	if (dayFirst !== null) {
		const month = MONTHS.indexOf(dayFirst[2]!.toLowerCase()) + 1;
		const day = calendarDay(dayFirst[3]!, String(month), dayFirst[1]!);
		if (day !== undefined) return day;
	}
	const monthFirst = new RegExp(`(${MONTHS.join("|")})[a-z]*\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})`, "i").exec(text);
	if (monthFirst !== null) {
		const month = MONTHS.indexOf(monthFirst[1]!.toLowerCase()) + 1;
		const day = calendarDay(monthFirst[3]!, String(month), monthFirst[2]!);
		if (day !== undefined) return day;
	}
	return undefined;
}

/** One day, checked against the calendar so "31 February" is no day at all. */
function calendarDay(year: string, month: string, day: string): string | undefined {
	const y = Number(year);
	const m = Number(month);
	const d = Number(day);
	if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return undefined;
	if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return undefined;
	const stamp = new Date(Date.UTC(y, m - 1, d));
	if (stamp.getUTCFullYear() !== y || stamp.getUTCMonth() !== m - 1 || stamp.getUTCDate() !== d) return undefined;
	return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * The rhythm a receipt pays for. The words a receipt uses are read; a receipt that states none keeps the
 * period its own parser knows, which is the rhythm that provider charges on.
 */
export function parsePeriod(text: string, fallback: ReceiptPeriod): ReceiptPeriod {
	if (/\b(annual|yearly|per\s+year|annual\s+plan|year\s+plan)\b/i.test(text)) return "year";
	if (/\b(monthly|per\s+month|monthly\s+plan|month\s+plan)\b/i.test(text)) return "month";
	if (/\b(one[-\s]?time|one[-\s]?off|single\s+payment)\b/i.test(text)) return "once";
	return fallback;
}

/**
 * The plan a receipt names, spelled the way the inventory spells it. The longest spelling wins, so a
 * receipt that says "Claude Max 5x" does not read as "Claude Max".
 */
export function matchPlan(text: string, plans: readonly ReceiptPlan[]): string | undefined {
	const haystack = text.toLowerCase();
	const candidates = plans.flatMap((plan) => [plan.name, ...(plan.also ?? [])].map((spelling) => ({ spelling, name: plan.name })));
	candidates.sort((left, right) => right.spelling.length - left.spelling.length);
	for (const candidate of candidates) {
		if (haystack.includes(candidate.spelling.toLowerCase())) return candidate.name;
	}
	return undefined;
}

/**
 * The six fields of one receipt, read from the text of a message. A message that states no plan, no
 * amount or no day is not a receipt and returns nothing: a receipt never gets a half-written figure.
 */
export function parseReceiptText(
	text: string,
	options: { plans: readonly ReceiptPlan[]; defaultPeriod: ReceiptPeriod },
): ParsedReceipt | undefined {
	const plan = matchPlan(text, options.plans);
	if (plan === undefined) return undefined;
	const amount = parseAmount(text);
	if (amount === undefined) return undefined;
	const chargedOn = parseChargedOn(text);
	if (chargedOn === undefined) return undefined;
	return { plan, amount: amount.amount, currency: amount.currency, period: parsePeriod(text, options.defaultPeriod), chargedOn };
}
