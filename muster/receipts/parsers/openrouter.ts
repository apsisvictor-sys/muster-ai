/**
 * OpenRouter's receipt (UB0 B-2): the metered credits, which are bought once rather than paid for on a
 * rhythm.
 */

import { parseReceiptText } from "./common.ts";
import type { ReceiptParser } from "../types.ts";

export const openrouterParser: ReceiptParser = (message) =>
	parseReceiptText(`${message.subject}\n${message.body}`, {
		plans: [{ name: "OpenRouter credits", also: ["OpenRouter Credits", "OpenRouter"] }],
		defaultPeriod: "once",
	});
