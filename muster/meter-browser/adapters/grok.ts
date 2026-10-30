/**
 * grok.com (SuperGrok, provider `xai`) — UB0 U-1, read only.
 *
 * The site's own usage page, read as words: a human check outranks every number, a used percentage
 * names its window, a page that only asks to sign in is a login wall, and a page this reader finds
 * nothing on is a page that changed.
 *
 * It opens `/usage` first and falls back to the app's root, both declared here, and touches nothing
 * else on the site. The fallback is not a guess about layout: the usage route renders nothing for a
 * session that is not logged in (measured 2026-10-26: `/usage` shows only its skip link, while `/`
 * shows "Sign in" and "Sign up"), so the root is where a logged-out session states its wall.
 */

import type { MeterFacade } from "../facade.ts";
import { looksLikeHumanCheck, looksLikeLoginWall, readLabelledWindows, readPageText } from "./page.ts";
import { UNREADABLE_HUMAN_CHECK, UNREADABLE_LOGIN, UNREADABLE_PAGE_CHANGED, type AdapterResult, type MeterSite } from "./types.ts";

/** The site as it reads in a reason line, and the id `--site` takes. */
export const GROK_SITE_ID = "grok.com";

/** The pages this adapter may open, in the order it tries them. */
const PATHS: readonly string[] = ["/usage", "/"];

export const grokSite: MeterSite = {
	site: GROK_SITE_ID,
	provider: "xai",
	origin: "https://grok.com",
	paths: PATHS,
	tabs: ["Usage"],
	async read(facade: MeterFacade): Promise<AdapterResult> {
		for (const path of PATHS) {
			await facade.goto(path);
			const page = await readPageText((selector) => facade.text(selector));
			// A human check first: a CAPTCHA page sometimes carries numbers, and none of them is a reading.
			if (looksLikeHumanCheck(page)) return { unreadable: UNREADABLE_HUMAN_CHECK };
			const windows = readLabelledWindows(page);
			if (windows.length > 0) return { windows };
			if (looksLikeLoginWall(page)) return { unreadable: UNREADABLE_LOGIN };
		}
		return { unreadable: UNREADABLE_PAGE_CHANGED };
	},
};
