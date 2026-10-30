/**
 * OpenAI's receipt (UB0 B-2): the metered API credits, which are bought once rather than paid for on a
 * rhythm. A ChatGPT or Codex receipt names no plan the inventory holds, so it reads as no receipt.
 */

import { parseReceiptText } from "./common.ts";
import type { ReceiptParser } from "../types.ts";

export const openaiParser: ReceiptParser = (message) =>
	parseReceiptText(`${message.subject}\n${message.body}`, {
		plans: [{ name: "OpenAI API", also: ["OpenAI API credits", "API credits"] }],
		defaultPeriod: "once",
	});
