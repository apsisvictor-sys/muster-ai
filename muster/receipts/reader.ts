/**
 * The receipt reader (UB0 B-2, UD1, VR24-199).
 *
 * One run reads the billing receipts of the nine providers the allow-list names and writes each of them as
 * a `price` signal with a `receipt`: six fields and nothing else. No body, no subject and no address is
 * stored, printed or logged, and no model ever reads the mail — the parser is the only thing that looks at
 * the text, and it returns the six fields or nothing.
 *
 * The order of a run:
 *
 *  1. for each mailbox profile, for each sender in the allow-list: one Gmail query for that sender;
 *  2. every id the reader has not seen is fetched once (`format=full`) and read by that sender's parser;
 *  3. a parsed receipt is written through `raiseSignal` as a `price` signal with `source: "receipt"` and
 *     the writer `receipt-reader`; a message that is not a receipt writes nothing at all;
 *  4. the id is remembered in `<stateDir>/receipts/seen.json`, so the next run reads only what is new;
 *  5. a profile whose sign-in has lapsed gives the operator one `human-login` ask per Sofia day, and the other
 *     profiles carry on.
 *
 * Nothing here spends anything, writes to a mailbox or touches a provider: the reader only reads mail and
 * writes into the local store.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import { raiseAsk } from "../asks.ts";
import { musterStateDir } from "../binding.ts";
import { sofiaDay } from "../meter-browser/last-run.ts";
import { raiseSignal } from "../signals.ts";
import { messageFromGmail } from "./parsers/common.ts";
import { RECEIPT_SENDERS, type ReceiptSender } from "./senders.ts";
import {
	readReceiptLastRun,
	readReceiptSeen,
	rememberSeen,
	seenIds,
	writeReceiptLastRun,
	writeReceiptSeen,
	type ReceiptLastRun,
	type ReceiptSeen,
} from "./state.ts";
import type { ReceiptProfile } from "./types.ts";

/** The writer the store records a receipt under. */
export const RECEIPT_WRITER = "receipt-reader";

/** How many new messages one sender contributes to one run; the reader catches up over the next runs. */
export const RECEIPTS_PER_SENDER_MAX = 5;

/** How many messages one query asks for. */
export const GWS_LIST_MAX_RESULTS = 25;

/** How long one gws call may take before the reader gives up on it. */
export const GWS_TIMEOUT_MS = 30_000;

/** What one gws call answered. */
export interface GwsResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** The seam a test stands in for: the gws CLI itself, one call at a time. */
export type GwsRunner = (request: { argv: string[]; profile: ReceiptProfile }) => Promise<GwsResult>;

/**
 * The mailboxes the reader reads. The personal profile is the operator's own; the Acme Realty profile is the
 * business mailbox, whose gws sign-in lapsed on 2026-10-26 and which gives one sign-in ask a day until he
 * signs it back in. Pixel Automate joins the list when the operator names its mailbox.
 */
export function defaultReceiptProfiles(home: string = homedir()): ReceiptProfile[] {
	return [
		{ name: "personal", configDir: join(home, ".config", "gws") },
		{ name: "acme-realty", configDir: join(home, ".config", "gws-acme-realty") },
	];
}

/**
 * Anything that looks like an address in what a command printed is replaced before it is read. The reader
 * never writes an address anywhere (UD1), and a command's own error text is the one place one could leak.
 */
export function redactAddresses(text: string): string {
	return text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<address>");
}

/** The gws CLI, one call at a time, against one profile's own config directory. */
export function spawnGws(request: { argv: string[]; profile: ReceiptProfile }): Promise<GwsResult> {
	return new Promise((resolve) => {
		const child = spawn("gws", request.argv, {
			env: { ...process.env, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: request.profile.configDir },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), GWS_TIMEOUT_MS);
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", (error: Error) => {
			clearTimeout(timer);
			resolve({ code: 127, stdout, stderr: redactAddresses(`${stderr} ${error.message}`) });
		});
		child.on("close", (code: number | null) => {
			clearTimeout(timer);
			resolve({ code: code ?? 1, stdout, stderr: redactAddresses(stderr) });
		});
	});
}

/** The ids one sender's mailbox holds, newest first, or undefined when the profile did not answer. */
async function listMessageIds(
	runner: GwsRunner,
	profile: ReceiptProfile,
	sender: ReceiptSender,
): Promise<string[] | undefined> {
	const query = `from:(${sender.domains.join(" ")})`;
	const result = await runner({
		argv: [
			"gmail",
			"users",
			"messages",
			"list",
			"--params",
			JSON.stringify({ userId: "me", q: query, maxResults: GWS_LIST_MAX_RESULTS }),
		],
		profile,
	});
	if (result.code !== 0) return undefined;
	const parsed = parseJson(result.stdout);
	const messages = parsed === undefined ? undefined : parsed["messages"];
	if (!Array.isArray(messages)) return [];
	const ids: string[] = [];
	for (const message of messages) {
		const id = message !== null && typeof message === "object" ? (message as Record<string, unknown>)["id"] : undefined;
		if (typeof id === "string" && id !== "") ids.push(id);
	}
	return ids;
}

/** One message as Gmail holds it, or undefined when the profile did not answer. */
async function getMessage(runner: GwsRunner, profile: ReceiptProfile, id: string): Promise<unknown | undefined> {
	const result = await runner({
		argv: ["gmail", "users", "messages", "get", "--params", JSON.stringify({ userId: "me", id, format: "full" })],
		profile,
	});
	if (result.code !== 0) return undefined;
	return parseJson(result.stdout);
}

function parseJson(text: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(text) as unknown;
		return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** What one run did for one profile. */
export interface ReceiptProfileResult {
	profile: string;
	/** The messages the queries found. */
	listed: number;
	/** The messages the reader fetched. */
	fetched: number;
	/** The messages that were receipts. */
	read: number;
	/** The receipts the store took. */
	written: number;
	/** The receipts the store already had. */
	duplicates: number;
	/** The receipts the store refused. */
	refused: number;
	/** Whether the profile answered at all. */
	failed: boolean;
	/** Whether the operator was asked to sign the profile back in today. */
	asked: boolean;
}

/** What one run did. */
export interface ReceiptRunResult {
	at: string;
	profiles: ReceiptProfileResult[];
}

/** How a run is set up. */
export interface ReceiptRunOptions {
	/** Where the reader keeps its state and writes its signals; the Muster state dir by default. */
	stateDir?: string;
	/** The mailboxes to read; the personal and Acme Realty profiles by default. */
	profiles?: readonly ReceiptProfile[];
	/** The senders to ask for; the allow-list by default. */
	senders?: readonly ReceiptSender[];
	/** The clock. */
	now?: () => number;
	/** The gws seam; the real CLI by default, a fake one in a test. */
	runGws?: GwsRunner;
	/** What the run says; nothing by default. */
	log?: (line: string) => void;
}

/**
 * One run of the reader. A run never throws for one bad message or one silent mailbox: the message is
 * skipped, the mailbox gives its one ask, and the other mailboxes are still read.
 */
export async function runReceiptReader(options: ReceiptRunOptions = {}): Promise<ReceiptRunResult> {
	const stateDir = options.stateDir ?? musterStateDir();
	const now = options.now ?? Date.now;
	const atMs = now();
	const at = new Date(atMs).toISOString();
	const day = sofiaDay(atMs);
	const log = options.log ?? ((): void => {});
	const runner = options.runGws ?? spawnGws;
	const senders = options.senders ?? RECEIPT_SENDERS;
	const profiles = options.profiles ?? defaultReceiptProfiles();
	const seen = readReceiptSeen(stateDir);
	const lastRun = readReceiptLastRun(stateDir);
	const results: ReceiptProfileResult[] = [];

	for (const profile of profiles) {
		const result: ReceiptProfileResult = {
			profile: profile.name,
			listed: 0,
			fetched: 0,
			read: 0,
			written: 0,
			duplicates: 0,
			refused: 0,
			failed: false,
			asked: false,
		};
		const known = seenIds(seen, profile.name);
		for (const sender of senders) {
			const ids = await listMessageIds(runner, profile, sender);
			if (ids === undefined) {
				// The profile did not answer: its sign-in has lapsed or gws is not there. The ask is the
				// reader's only way to say so, and the other profiles are still read.
				result.failed = true;
				break;
			}
			result.listed += ids.length;
			for (const id of ids.filter((candidate) => !known.has(candidate)).slice(0, RECEIPTS_PER_SENDER_MAX)) {
				const raw = await getMessage(runner, profile, id);
				if (raw === undefined) continue;
				const message = messageFromGmail(raw);
				if (message === undefined) continue;
				result.fetched += 1;
				const receipt = sender.parser(message);
				rememberSeen(seen, profile.name, id);
				known.add(id);
				if (receipt === undefined) continue;
				result.read += 1;
				const write = await writeReceipt(stateDir, sender, receipt, at);
				if (write === "duplicate") result.duplicates += 1;
				else if (write === "refused") result.refused += 1;
				else result.written += 1;
				log(
					`receipt-reader: ${sender.label} receipt read (${receipt.currency} ${receipt.amount}, ${receipt.period}), charged on ${receipt.chargedOn}`,
				);
			}
		}
		if (result.failed) {
			result.asked = raiseLoginAsk(stateDir, profile, day, at, lastRun);
			log(
				`receipt-reader: the ${profile.name} mailbox did not answer; ${result.asked ? "the operator was asked once today" : "today's ask is already raised"}`,
			);
		} else {
			lastRun.profiles[profile.name] = { ...(lastRun.profiles[profile.name] ?? {}), at };
		}
		results.push(result);
	}

	seen.at = at;
	lastRun.at = at;
	writeReceiptSeen(stateDir, seen);
	writeReceiptLastRun(stateDir, lastRun);
	return { at, profiles: results };
}

/** One receipt into the store, as a `price` signal with a receipt and the reader's own writer. */
async function writeReceipt(
	stateDir: string,
	sender: ReceiptSender,
	receipt: { plan: string; amount: number; currency: string; period: "month" | "year" | "once"; chargedOn: string },
	at: string,
): Promise<"written" | "duplicate" | "refused"> {
	try {
		const write = await raiseSignal(stateDir, RECEIPT_WRITER, {
			kind: "price",
			source: "receipt",
			provider: sender.provider,
			receipt,
			observedAt: at,
			confidence: "high",
		});
		return write.duplicate ? "duplicate" : "written";
	} catch {
		// One receipt the store refuses must not stop the reader: the message is still seen, and the next run
		// reads the next one. The refusal is counted, never counted as a duplicate.
		return "refused";
	}
}

/**
 * One sign-in ask for a mailbox that did not answer, once per Sofia day. The day is kept in the reader's own
 * last-run file, so the queue never fills with the same request.
 */
function raiseLoginAsk(
	stateDir: string,
	profile: ReceiptProfile,
	day: string,
	at: string,
	lastRun: ReceiptLastRun,
): boolean {
	const previous = lastRun.profiles[profile.name];
	if (previous?.askDay === day) return false;
	raiseAsk(stateDir, {
		by: RECEIPT_WRITER,
		kind: "human-login",
		code: `receipts-${profile.name}`,
		question: `Sign the ${profile.name} mailbox back in for the receipt reader: gws auth login with GOOGLE_WORKSPACE_CLI_CONFIG_DIR=${profile.configDir}`,
		source: RECEIPT_WRITER,
	});
	lastRun.profiles[profile.name] = { ...(previous ?? { at }), at, askDay: day };
	return true;
}
