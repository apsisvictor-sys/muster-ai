/**
 * The two sites the meter browser reads, in the order it reads them (UB0 U-1, UD2 amended): grok.com
 * (SuperGrok, `xai`) first, platform.openai.com (`openai`) second.
 *
 * Kimi, Google AI Studio and the claude.ai page are not here on purpose (VR24-201): those providers
 * are read over their own APIs, and a browser reader for them would be a second source of the same
 * number.
 */

import { grokSite } from "./grok.ts";
import { openaiSite } from "./openai.ts";
import type { MeterSite } from "./types.ts";

export const METER_SITES: readonly MeterSite[] = [grokSite, openaiSite];

/** The adapter one `--site` value names, or undefined when no site carries that id. */
export function meterSiteFor(id: string): MeterSite | undefined {
	const wanted = id.trim().toLowerCase();
	return METER_SITES.find((site) => site.site.toLowerCase() === wanted);
}

export { grokSite, openaiSite };
export type { AdapterResult, MeterReading, MeterSite, MeterUnreadable, MeterWindowReading } from "./types.ts";
