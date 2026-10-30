/**
 * Moonshot's receipt (UB0 B-2): Kimi's own credits, which are bought once rather than paid for on a
 * rhythm, so a receipt that states no rhythm keeps "once".
 */

import { parseReceiptText } from "./common.ts";
import type { ReceiptParser } from "../types.ts";

export const moonshotParser: ReceiptParser = (message) =>
	parseReceiptText(`${message.subject}\n${message.body}`, {
		plans: [{ name: "kimi", also: ["Kimi", "Moonshot AI"] }],
		defaultPeriod: "once",
	});
