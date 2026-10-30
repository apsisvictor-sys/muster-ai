/**
 * Anthropic's receipt (UB0 B-2): the plan Claude's own orders use, and a monthly rhythm unless the receipt
 * states another.
 */

import { parseReceiptText } from "./common.ts";
import type { ReceiptParser } from "../types.ts";

export const anthropicParser: ReceiptParser = (message) =>
	parseReceiptText(`${message.subject}\n${message.body}`, {
		plans: [{ name: "Claude Max 5x", also: ["Max 5x", "Claude Max"] }],
		defaultPeriod: "month",
	});
