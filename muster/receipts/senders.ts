/**
 * The allow-list (UB0 B-2): the senders the reader may read, one per provider.
 *
 * A receipt reaches this machine from exactly one place: the provider's own billing mail. The list below is
 * that set, and nothing else is ever read: the reader asks Gmail for one sender at a time and parses the
 * answer with that sender's own parser.
 *
 * The list names the provider's own sending domains rather than one mailbox. A provider changes the local
 * part of a billing address more often than it changes its domain, and a wrong local part would silently
 * find nothing; a domain that is too wide costs one parser call, because a message that states no plan,
 * no amount and no day reads as no receipt at all.
 *
 * No address appears here or in any fixture: the reader never reads, stores or logs an address (UD1).
 */

import { anthropicParser } from "./parsers/anthropic.ts";
import { commandCodeParser } from "./parsers/command-code.ts";
import { googleParser } from "./parsers/google.ts";
import { minimaxParser } from "./parsers/minimax.ts";
import { moonshotParser } from "./parsers/moonshot.ts";
import { openaiParser } from "./parsers/openai.ts";
import { openrouterParser } from "./parsers/openrouter.ts";
import { xaiParser } from "./parsers/xai.ts";
import { zaiParser } from "./parsers/zai.ts";
import type { ReceiptParser } from "./types.ts";

/** One sender the reader may read. */
export interface ReceiptSender {
	/** The provider id the pool and the inventory use, so the receipt lands on that row. */
	provider: string;
	/** The provider's name for people. */
	label: string;
	/** The sender domains the Gmail query matches. */
	domains: string[];
	/** The parser that reads this sender's receipt. */
	parser: ReceiptParser;
}

/**
 * The nine senders, in the order the reader asks for them. Each is confirmed by one synthetic fixture in
 * `extensions/tests/receipts-reader.test.ts`: a message shaped like that provider's receipt, carrying no
 * real address and no real receipt.
 */
export const RECEIPT_SENDERS: readonly ReceiptSender[] = [
	{ provider: "claude-code", label: "Anthropic", domains: ["anthropic.com"], parser: anthropicParser },
	{ provider: "xai", label: "xAI", domains: ["x.ai"], parser: xaiParser },
	{ provider: "kimi-coding", label: "Moonshot", domains: ["moonshot.ai", "moonshot.cn"], parser: moonshotParser },
	{ provider: "zai", label: "Z.ai", domains: ["z.ai"], parser: zaiParser },
	{ provider: "minimax", label: "MiniMax", domains: ["minimax.io", "minimax.chat"], parser: minimaxParser },
	{ provider: "command-code", label: "Command Code", domains: ["commandcode.ai"], parser: commandCodeParser },
	{ provider: "openai", label: "OpenAI", domains: ["openai.com"], parser: openaiParser },
	{ provider: "google", label: "Google", domains: ["google.com"], parser: googleParser },
	{ provider: "openrouter", label: "OpenRouter", domains: ["openrouter.ai"], parser: openrouterParser },
];

/** The sender of one provider, or undefined when the allow-list does not know it. */
export function receiptSenderFor(provider: string): ReceiptSender | undefined {
	const key = provider.trim().toLowerCase();
	return RECEIPT_SENDERS.find((sender) => sender.provider.toLowerCase() === key);
}
