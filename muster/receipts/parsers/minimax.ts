/**
 * MiniMax's receipt (UB0 B-2): the plan MiniMax's own orders use, and a monthly rhythm unless the receipt
 * states another.
 */

import { parseReceiptText } from "./common.ts";
import type { ReceiptParser } from "../types.ts";

export const minimaxParser: ReceiptParser = (message) =>
	parseReceiptText(`${message.subject}\n${message.body}`, {
		plans: [{ name: "MiniMax", also: ["MiniMax Token Plan"] }],
		defaultPeriod: "month",
	});
