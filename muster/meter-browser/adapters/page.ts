/**
 * What a page's own words say (UB0 U-1): its used percentages, whether it wants a login, and whether
 * it is asking for a human check.
 *
 * Both adapters read pages whose layout nobody here can see until the operator logs the profile in, so the
 * reading is driven by the words a usage page states rather than by a layout. That also decides what
 * "read only" means in practice: a page either states a percentage it calls used, or the reader says
 * why it has none.
 *
 * Two rules are deliberate and both fail closed:
 *
 *  - a percentage counts only when the line says it is *used* (`used`, `usage`, `consumed`). A line
 *    that says *remaining* or *left* is not converted: a reader that inverts a page's arithmetic
 *    reports a plan at 66% used when it is at 34%, which is worse than reporting no reading at all.
 *    The window is skipped and the row keeps the reason, so the mistake is visible.
 *  - a page that shows no used percentage and no login or human check reads "the page changed",
 *    which reaches the orchestrator rather than the operator, because fixing an adapter is development
 *    (VR24-200).
 */

import type { MeterWindowReading } from "./types.ts";

/** One line's stated percentage: the first number followed by a percent sign. */
const PERCENT = /(\d{1,3}(?:\.\d+)?)\s*%/;

/** The words that make a percentage a used percentage, never a remaining one. */
const USED_WORD = /\b(used|usage|consumed)\b/i;

/** The words a usage page pairs a percentage with to name the window's length. */
const WINDOW_LABELS: ReadonlyArray<{ pattern: RegExp; name: string }> = [
	{ pattern: /\b5[- ]?(?:h|hour)s?\b|\bfive[- ]?hours?\b|\bhourly\b/i, name: "5h" },
	{ pattern: /\bweek(?:ly)?\b|\b7[- ]?days?\b|\bseven[- ]?days?\b/i, name: "week" },
	{ pattern: /\bmonth(?:ly)?\b|\b30[- ]?days?\b/i, name: "month" },
	{ pattern: /\b(?:24[- ]?h|daily|day)\b/i, name: "day" },
];

/** A reset the page states as a full ISO instant, which is the store's own window shape (UD3). */
const ISO_INSTANT = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\b/;

/** The markers a site shows when it wants a person to sign in before it shows anything else. */
const LOGIN_MARKERS: readonly RegExp[] = [
	/\bsign in\b/i,
	/\blog ?in\b/i,
	/\bcreate (?:an )?account\b/i,
	/\bcontinue with (?:google|apple|x|email)\b/i,
	/\bsign up\b/i,
];

/** The markers a site shows when it is asking for a human check rather than showing its numbers. */
const HUMAN_CHECK_MARKERS: readonly RegExp[] = [
	/\bverify (?:that )?you are (?:a )?human\b/i,
	/\bare you a robot\b/i,
	/\bchecking (?:if the site connection is secure|your browser)\b/i,
	/\bunusual traffic\b/i,
	/\bcaptcha\b/i,
	// A Cloudflare interstitial: "Just a moment...", "Enable JavaScript and cookies to continue", the
	// challenge platform's own script names, and a successful-verification page that still waits.
	/\bjust a moment\b/i,
	/\benable javascript and cookies to continue\b/i,
	/\bverification successful\b/i,
	/\bchallenge-platform\b/i,
	/\bcf[_-]chl/i,
];

/** Whether the page is asking for a human check. It outranks every number on the page (VR24-200). */
export function looksLikeHumanCheck(pageText: string): boolean {
	return HUMAN_CHECK_MARKERS.some((marker) => marker.test(pageText));
}

/** Whether the page is a login wall: it asks to sign in and says nothing else that reads as usage. */
export function looksLikeLoginWall(pageText: string): boolean {
	return LOGIN_MARKERS.some((marker) => marker.test(pageText));
}

/**
 * The windows one page's text states, in the order the page states them, one per window name. A line
 * that names a window and a used percentage is a window; a line that names a window and a remaining
 * percentage is not (see the file comment).
 */
export function readLabelledWindows(pageText: string): MeterWindowReading[] {
	const windows: MeterWindowReading[] = [];
	const seen = new Set<string>();
	for (const rawLine of pageText.split(/\n+/)) {
		const line = rawLine.replace(/\s+/g, " ").trim();
		if (line === "") continue;
		if (!USED_WORD.test(line)) continue;
		const percent = PERCENT.exec(line);
		if (percent === null) continue;
		const used = Number(percent[1]);
		if (!Number.isFinite(used) || used < 0 || used > 100) continue;
		const label = WINDOW_LABELS.find((candidate) => candidate.pattern.test(line));
		if (label === undefined) continue;
		if (seen.has(label.name)) continue;
		seen.add(label.name);
		const reset = ISO_INSTANT.exec(line);
		windows.push({
			name: label.name,
			usedPercent: used,
			...(reset === null ? {} : { resetsAt: reset[1]! }),
		});
	}
	return windows;
}

/**
 * The whole page as one string: the body, and the main region when it says something the body does not
 * already carry. Both are read because one site puts its numbers in `main` and its sign-in prompt outside
 * it, while the other renders everything into `body`. A marker is then never missed for being in the
 * wrong half of the page, and the number lines are still one per line.
 */
export async function readPageText(read: (selector: string) => Promise<string | null>): Promise<string> {
	const body = ((await read("body")) ?? "").trim();
	const main = ((await read("main")) ?? "").trim();
	if (main === "") return body;
	if (body === "") return main;
	return body.includes(main.slice(0, 80)) ? body : `${main}\n${body}`;
}
