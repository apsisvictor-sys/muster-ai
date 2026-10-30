/**
 * Command Code's receipt (UB0 B-2): the plan Command Code's own orders use, and a monthly rhythm unless
 * the receipt states another.
 */

import { parseReceiptText } from "./common.ts";
import type { ReceiptParser } from "../types.ts";

export const commandCodeParser: ReceiptParser = (message) =>
	parseReceiptText(`${message.subject}\n${message.body}`, {
		plans: [{ name: "command-code", also: ["Command Code"] }],
		defaultPeriod: "month",
	});
