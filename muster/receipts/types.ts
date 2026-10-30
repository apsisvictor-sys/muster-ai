/**
 * The receipt reader's own shapes (UB0 B-2, UD1, VR24-199).
 *
 * A receipt is six fields and nothing else: the provider, the plan, the amount, the currency, the period and
 * the day the provider charged. No address, no subject, no body and no message id leaves this module: the
 * reader parses a message and keeps the six, so nothing about the operator's mail is stored, printed or logged.
 */

/** How long a provider is paid for. The store's own vocabulary for a receipt (`signals.ts` `SignalReceipt`). */
export type ReceiptPeriod = "month" | "year" | "once";

/** One receipt: the six fields, exactly as the store keeps them. */
export interface ParsedReceipt {
	/** The plan the receipt names, spelled the way the inventory spells it. */
	plan: string;
	/** The amount charged. */
	amount: number;
	/** The currency the amount is in, as the receipt states it (`USD`, `EUR`, ...). */
	currency: string;
	/** The rhythm the charge pays for. */
	period: ReceiptPeriod;
	/** The day the provider charged, YYYY-MM-DD, as the receipt states it. */
	chargedOn: string;
}

/**
 * One message as the reader needs it: the text to read, and nothing it keeps. The id says only that the
 * message was already handled, so it never reaches a log line.
 */
export interface ReceiptMessage {
	/** The Gmail message id. */
	id: string;
	/** The subject line. */
	subject: string;
	/** The plain-text body. */
	body: string;
}

/** One sender's parser: the message in, the six fields out, or nothing when the message is not a receipt. */
export type ReceiptParser = (message: ReceiptMessage) => ParsedReceipt | undefined;

/**
 * One mailbox the reader reads. The name is the profile's own label, never an address, and the config
 * directory is the one gws reads that profile's sign-in from.
 */
export interface ReceiptProfile {
	/** The profile's label: `personal`, `acme-realty`. */
	name: string;
	/** The gws config directory that holds this profile's sign-in. */
	configDir: string;
}
