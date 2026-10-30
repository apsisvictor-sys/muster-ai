/**
 * What one meter adapter answers (UB0 U-1): the windows it read, or the one reason it read nothing.
 *
 * The result is either a reading or a single unreadable reason — never both, never a percentage with
 * a reason beside it. That is the shape the store and the snapshot already understand: a `meter`
 * signal carries windows, and a failed read carries a reason line the row shows (UD2, UM7).
 */

import type { SignalBalance, SignalBilling } from "../../signals.ts";
import type { MeterFacade } from "../facade.ts";

/** One window a page stated: its name, the percentage it said was used, and its reset when it said one. */
export type MeterWindowReading = {
	/** The window's length as the adapter names it: "5h", "week", "month" (UD4). */
	name: string;
	/** What the page said was used, 0-100. */
	usedPercent: number;
	/** The reset the page stated as an ISO instant, when it stated one. */
	resetsAt?: string;
	/** The model a per-model window names; a provider-wide window omits it (UD4). */
	model?: string;
};

/** A reading: what the page showed. */
export type MeterReading = {
	windows: MeterWindowReading[];
	/** The billing dates the page stated, when it stated any (UD3). */
	billing?: SignalBilling;
	/** A metered account's balance, when the page stated one (UD3). */
	balance?: SignalBalance;
};

/** The one reason a site reads nothing. These three strings are the whole vocabulary (VR24-200). */
export const UNREADABLE_LOGIN = "needs your login";
export const UNREADABLE_HUMAN_CHECK = "the site asks for a human check";
export const UNREADABLE_PAGE_CHANGED = "the page changed";
export type MeterUnreadable = typeof UNREADABLE_LOGIN | typeof UNREADABLE_HUMAN_CHECK | typeof UNREADABLE_PAGE_CHANGED;

/** What one adapter answers. */
export type AdapterResult = MeterReading | { unreadable: MeterUnreadable };

/** Whether an answer is a reason rather than a reading. */
export function isUnreadable(result: AdapterResult): result is { unreadable: MeterUnreadable } {
	return "unreadable" in result;
}

/**
 * One site's adapter. It declares where the site lives, which paths and tabs it may open, and how it
 * reads — and it reads through the facade alone (UD6).
 */
export type MeterSite = {
	/** The site's name as it reads in a reason line: "grok.com". */
	site: string;
	/** The provider this reading belongs to in the signal store: `xai`, `openai`. */
	provider: string;
	/** The one origin the adapter may read. */
	origin: string;
	/** The paths on that origin it may open. */
	paths: readonly string[];
	/** The tabs it may open, by visible name. */
	tabs: readonly string[];
	/** Read the site: a reading, or the one reason it read nothing. */
	read(facade: MeterFacade): Promise<AdapterResult>;
};
