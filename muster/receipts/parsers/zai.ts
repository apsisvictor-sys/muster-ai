/**
 * Z.ai's receipt (UB0 B-2): the plan Z.ai's own orders use, and a monthly rhythm unless the receipt
 * states another.
 */

import { parseReceiptText } from "./common.ts";
import type { ReceiptParser } from "../types.ts";

export const zaiParser: ReceiptParser = (message) =>
	parseReceiptText(`${message.subject}\n${message.body}`, {
		plans: [{ name: "z.ai", also: ["Z.ai", "Zhipu AI"] }],
		defaultPeriod: "month",
	});
