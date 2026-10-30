/**
 * Google's receipt (UB0 B-2): the metered AI credits, which are bought once rather than paid for on a
 * rhythm.
 */

import { parseReceiptText } from "./common.ts";
import type { ReceiptParser } from "../types.ts";

export const googleParser: ReceiptParser = (message) =>
	parseReceiptText(`${message.subject}\n${message.body}`, {
		plans: [{ name: "Google AI", also: ["Google AI Studio", "Google AI credits"] }],
		defaultPeriod: "once",
	});
