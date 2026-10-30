/**
 * xAI's receipt (UB0 B-2): the plan Grok's own orders use, and a monthly rhythm unless the receipt states
 * another.
 */

import { parseReceiptText } from "./common.ts";
import type { ReceiptParser } from "../types.ts";

export const xaiParser: ReceiptParser = (message) =>
	parseReceiptText(`${message.subject}\n${message.body}`, {
		plans: [{ name: "SuperGrok", also: ["Super Grok"] }],
		defaultPeriod: "month",
	});
