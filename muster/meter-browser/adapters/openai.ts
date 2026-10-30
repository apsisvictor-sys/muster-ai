/**
 * platform.openai.com (provider `openai`) — UB0 U-1, read only.
 *
 * The platform's usage and billing pages, read exactly as grok.com's is: a human check outranks every
 * number, a used percentage names its window, a page that only asks to sign in is a login wall, and a
 * page this reader finds nothing on is a page that changed.
 *
 * It opens the page the inventory names first (UM14 owns where a provider's usage page is) and falls
 * back to `/usage`, both declared here. Billing dates are not read here: B-1 owns them from the API,
 * and this adapter states only what a page states.
 */

import type { MeterFacade } from "../facade.ts";
import { looksLikeHumanCheck, looksLikeLoginWall, readLabelledWindows, readPageText } from "./page.ts";
import { UNREADABLE_HUMAN_CHECK, UNREADABLE_LOGIN, UNREADABLE_PAGE_CHANGED, type AdapterResult, type MeterSite } from "./types.ts";

/** The site as it reads in a reason line, and the id `--site` takes. */
export const OPENAI_SITE_ID = "platform.openai.com";

/**
 * The pages this adapter may open: the inventory's page first, then `/usage`, and the root, which is where
 * `muster usage login` opens a window for the operator. All three are the platform's own, declared here.
 */
const PATHS: readonly string[] = ["/settings/organization/billing/overview", "/usage", "/"];

export const openaiSite: MeterSite = {
	site: OPENAI_SITE_ID,
	provider: "openai",
	origin: "https://platform.openai.com",
	paths: PATHS,
	tabs: ["Usage"],
	async read(facade: MeterFacade): Promise<AdapterResult> {
		for (const path of PATHS) {
			await facade.goto(path);
			const page = await readPageText((selector) => facade.text(selector));
			if (looksLikeHumanCheck(page)) return { unreadable: UNREADABLE_HUMAN_CHECK };
			const windows = readLabelledWindows(page);
			if (windows.length > 0) return { windows };
			if (looksLikeLoginWall(page)) return { unreadable: UNREADABLE_LOGIN };
		}
		return { unreadable: UNREADABLE_PAGE_CHANGED };
	},
};
