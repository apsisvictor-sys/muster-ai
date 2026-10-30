import "./muster-test-isolation.ts";
/**
 * CCP: the Systems tab and the Your plans card (blueprint
 * `command-center-blueprint-2026-10-22.md`, R7a.1 and the pack's acceptance row at line 1677).
 *
 * 1. The page's own words, evaluated as they stand: the fixture snapshot's eight rows yield exactly the eight
 *    strings the acceptance row lists, the split account yields two cards and the note, the unreadable row its
 *    reason, and a 40-minute-old snapshot the stale line.
 * 2. D46's table for 272, 300, 1440, 8519, 10 080 and 43 200 minutes, and the three shapes of a time.
 * 3. The fifth tab and the phone's More control: five items, and at 760 px and below only four controls show.
 *    The measurement basis is CRW's release check (`reports/crw-release-check.md`, "The phone's four tabs":
 *    four controls are fully readable at 390 px), so a fifth tab moves under More rather than widening the row.
 * 4. The panel's own fields the page reads: `stale` from `snapshotIsFresh`, `meter` from `METER_ROW_SOURCES`,
 *    and `valueLine` read once from `cost-digest.json` beside the snapshot.
 *
 * No browser is launched: the words are pure functions of the page, and the page's DOM builder only puts them
 * into `textContent`. Every path here is a fixture; no live state is read.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
	commandCenter,
	type CommandCenterDeps,
	type GateStatus,
	type PsiKill
} from "../gateway/command-center.ts";
import { buildUsage, type UsageInput, type UsageRow } from "../gateway/command-center-panels.ts";
import { SNAPSHOT_FRESH_MS } from "../../routing/provider-pool.ts";
import type { SnapshotProvider } from "../bin/usage-snapshot.mts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE_FILE = join(HERE, "..", "gateway", "command-center-page.html");
const PAGE = readFileSync(PAGE_FILE, "utf8");

/** A Tuesday in the operator's zone: 27 Oct 2026, 11:00 EET, the day after the clocks went back. */
const NOW = Date.parse("2026-10-27T09:00:00.000Z");
const TODAY_RESET = Date.parse("2026-10-27T19:30:00.000Z");
const FRIDAY_RESET = Date.parse("2026-10-30T05:00:00.000Z");
const LATER_RESET = Date.parse("2026-11-10T12:00:00.000Z");
const GATE_OK: GateStatus = { wouldAdmit: true, reason: "", psi: 0, availableMb: 9000, sliceUsedPct: 10, paused: false, devServerWindow: "" };

// ── The page's own words, as it stands ──────────────────────────────────────

const WORDS_START = "// ── Systems words region";
const WORDS_END = "// ── end of the Systems words";

/** The marked region of the page's script: the one place its plan-card words live. */
function wordsSource(): string {
	const from = PAGE.indexOf(WORDS_START);
	assert.ok(from >= 0, "the page keeps its Systems words in one marked region");
	const to = PAGE.indexOf(WORDS_END, from);
	assert.ok(to > from, "the region is closed");
	return PAGE.slice(from, to);
}

type Words = Record<string, (...args: any[]) => any>;

/**
 * The page's own functions, evaluated exactly as they are written there. Nothing in this file restates a word of
 * them, so a change to the page's copy is a change this test sees.
 */
const words = new Function(
	`${wordsSource()}
	return { windowWords, windowLabel, resetWords, planPriceWords, planCardWords, planCardOrder, balanceWords,
		freeRowWords, valueLineWords, staleWords, nearestResetWords, readWords, billingWords, routerWords, priceOf,
		ringOf };`
)() as Words;

// ── The fixture snapshot: eight rows, each the shape the panel emits (D41) ──

const window = (usedPercent: number, windowMinutes: number, resetsAt: number, name?: string) => ({ ...(name === undefined ? {} : { name }), usedPercent, windowMinutes, resetsAt });
const row = (over: Partial<UsageRow>): UsageRow => ({
	provider: "claude-code",
	label: "Claude",
	kind: "subscription",
	plan: { name: "Max 5x", monthlyUsd: 100 },
	quotaState: "read",
	windows: [],
	ageMs: 4 * 60_000,
	source: "claude-usage",
	meter: false,
	walls: [],
	router: { atHeadroom: false, runningLanes: 0 },
	...over
});

const FIXTURE: UsageRow[] = [
	// (1) walled
	row({ windows: [window(67, 300, TODAY_RESET), window(75, 10_080, FRIDAY_RESET, "weekly")], walls: [{ until: TODAY_RESET, source: "quota" }], router: { atHeadroom: false, runningLanes: 1, claudeMax: 2 } }),
	// (2) spent
	row({ provider: "minimax", label: "MiniMax", plan: { name: "MiniMax Pro", monthlyUsd: 20 }, windows: [window(40, 300, FRIDAY_RESET)], router: { spentUntil: FRIDAY_RESET, atHeadroom: false, runningLanes: 0 } }),
	// (3) over headroom
	row({ provider: "zai", label: "GLM", plan: { name: "GLM Coding", monthlyUsd: 6 }, windows: [window(97, 10_080, FRIDAY_RESET)], router: { atHeadroom: true, runningLanes: 2 } }),
	// (4) metered, below zero
	row({ provider: "kie", label: "Kie", kind: "metered", plan: null, windows: [], balance: { amount: -64.02, currency: "credits" }, ageMs: 52 * 60_000, source: "monitor bot", meter: true }),
	// (5) a plan with no price
	row({ provider: "opencode-go", label: "OpenCode", kind: "subscription", plan: { name: "OpenCode Go", monthlyUsd: 0 }, windows: [window(12, 300, TODAY_RESET)] }),
	// (6) and (8) an unpriced row whose reading the monitor could not take
	row({ provider: "xai", label: "Grok", plan: { name: "SuperGrok", monthlyUsd: null }, windows: [], unreadable: "the reader answered 401", ageMs: null }),
	// (7) a provider with two accounts: two rows, one router reading
	row({ provider: "command-code", label: "DeepSeek", account: "Personal account", plan: { name: "Pro", monthlyUsd: 20 }, windows: [window(42, 300, TODAY_RESET)] }),
	row({ provider: "command-code", label: "DeepSeek", account: "Acme Realty account", plan: { name: "Pro", monthlyUsd: 20 }, windows: [window(61, 10_080, FRIDAY_RESET)] })
];

const subscriptions = FIXTURE.filter((entry) => entry.kind === "subscription");
const cards = (): Array<ReturnType<Words["planCardWords"]>> =>
	subscriptions
		.slice()
		.sort((left, right) => words.planCardOrder(left, right))
		.map((entry) => words.planCardWords(entry, NOW, FIXTURE.filter((other) => other.provider === entry.provider).length > 1));
const cardOf = (label: string, account?: string): any => cards().find((card: any) => card.name === (account === undefined ? label : `${label} · ${account}`));
const linesOf = (card: any): string[] => card.lines.map((line: { text: string }) => line.text);

test("CCP 1: the walled row says when the wall lifts, and each window in D46's words", () => {
	const walled = cardOf("Claude");
	assert.equal(walled.name, "Claude");
	assert.equal(walled.price, "Max 5x · $100 a month");
	assert.deepEqual(walled.windows, [
		{ label: "5 hours", right: "67% · resets 21:30", used: 67 },
		{ label: "weekly", right: "75% · resets Fri 07:00", used: 75 }
	], "the outer and inner windows are labelled in words, and a named window keeps its name");
	assert.ok(linesOf(walled).includes("Walled until 21:30"), `the wall comes first: ${linesOf(walled).join(" | ")}`);
	assert.equal(linesOf(walled)[0], "Walled until 21:30", "the wall is the card's first line");
	assert.ok(linesOf(walled).includes("1 lane running now"), "the lane count is the router's");
	assert.ok(linesOf(walled).includes("Claude lanes: at most 2 at once"), "the Claude ceiling is the pool's own (`claudeMax`)");
	assert.ok(linesOf(walled).includes("Read 4 min ago · API"), "the reading's age and source");
	assert.equal(cards()[0].name, "Claude", "a walled plan is the first card");
});

test("CCP 2: the spent row says when it is open again", () => {
	assert.ok(linesOf(cardOf("MiniMax")).includes("Spent until Fri 07:00"), linesOf(cardOf("MiniMax")).join(" | "));
});

test("CCP 3: the row at or over the headroom threshold says what the router does with it", () => {
	const headroom = cardOf("GLM");
	assert.ok(linesOf(headroom).includes("At or over 95% of a window: used only when nothing else is open"), linesOf(headroom).join(" | "));
	assert.ok(linesOf(headroom).includes("2 lanes running now"));
	assert.equal(cards()[1].name, "GLM", "after the walled card, the highest window used comes next");
});

test("CCP 4: a metered account below zero reads as the row gives it, with a minus sign and no percentage", () => {
	const balance = words.balanceWords(FIXTURE[3]);
	assert.equal(balance.text, "Kie · \u221264.02 credits · below zero", "the acceptance string, exactly");
	assert.equal(balance.attn, true, "the attention tone, never red (D43)");
	assert.equal(words.balanceWords(row({ label: "DeepSeek", kind: "metered", balance: { amount: 1.54, currency: "USD" } })).text, "DeepSeek · 1.54 USD left");
	assert.equal(words.balanceWords(row({ label: "Kie", kind: "metered" })).text, "Kie · Balance not read yet");
	assert.doesNotMatch(balance.text, /%/, "a balance is never a percentage (UM5)");
	assert.equal(words.readWords(FIXTURE[3]), "Read 52 min ago · browser", "a meter reading came from a browser");
});

test("CCP 5 and 6: a plan with no price says so, and a null price is the only 'price not given'", () => {
	assert.equal(words.planPriceWords(FIXTURE[4]), "$0 a month (no paid plan)", "a zero price is a plan, and the card says which");
	assert.equal(words.planPriceWords(FIXTURE[5]), "price not given", "a null price is the only case that says it");
	assert.equal(words.planPriceWords({ label: "No plan", plan: null }), "price not given", "no plan at all has no price either");
});

test("CCP 7: a provider with two accounts gives two cards, and each says the router counts both as one", () => {
	const split = cards().filter((card: any) => card.name.indexOf("DeepSeek") === 0);
	assert.equal(split.length, 2, "two cards, one per account");
	assert.deepEqual(split.map((card: any) => card.name).sort(), ["DeepSeek · Personal account", "DeepSeek · Acme Realty account"].sort(), "one card per account");
	assert.deepEqual(split.map((card: any) => card.name), ["DeepSeek · Acme Realty account", "DeepSeek · Personal account"], "and in R7a.1's order: the highest window used first");
	for (const card of split) assert.equal(card.note, "The router counts both accounts as one provider", "the note is on each card");
	for (const card of cards().filter((candidate: any) => candidate.name.indexOf("DeepSeek") !== 0)) assert.equal(card.note, "", "and only on a split provider's card");
});

test("CCP 8: an unreadable row shows its own reason and claims no percentage", () => {
	const unreadable = cardOf("Grok");
	assert.equal(unreadable.windows.length, 0, "no bar is drawn for a row with no reading");
	assert.ok(linesOf(unreadable).includes("the reader answered 401"), `the monitor's reason is shown: ${linesOf(unreadable).join(" | ")}`);
	assert.equal(unreadable.price, "price not given");
});

test("CCP: the digest's sentence is rendered as written, and a gateway without one says so", () => {
	assert.equal(words.valueLineWords(null), "Value against API prices not computed yet");
	assert.equal(words.valueLineWords({}), "Value against API prices not computed yet");
	assert.equal(words.valueLineWords({ valueLine: "" }), "Value against API prices not computed yet");
	const line = "- fleet (30d): API-equivalent at least $412.10 against plans $130.20: saves at least $281.90, 3.2x";
	assert.equal(words.valueLineWords({ valueLine: line }), line.slice(2), "the digest's line, with only its markdown bullet taken off");
	assert.match(words.valueLineWords({ valueLine: line }), /at least/, "a lower bound keeps its 'at least' (D42)");
});

test("CCP: a snapshot 40 minutes old carries the stale line the router's own rule earns", () => {
	assert.equal(words.staleWords(NOW - 40 * 60_000, NOW), "Usage snapshot 40 min old: the router is not using it");
	assert.equal(words.staleWords(NOW, NOW), "Usage snapshot 0 min old: the router is not using it", "the line's shape, before the flag decides");
});

test("CCP: the Your plans ring says what its number is: the window it belongs to, and that it is used", () => {
	// The usage snapshot's own number (`usedPercent`, the percent of the window that is used) and nothing else.
	const claude = row({ windows: [window(1, 300, TODAY_RESET), window(99, 10_080, FRIDAY_RESET)] });
	const ring = words.ringOf(claude);
	assert.equal(ring.used, 1, "the number is the short window's used percent");
	assert.equal(ring.sub, "5 hours: 1% used · Week: 99% used", "the label says which window the number is, that it is used, and the week beside it");
	assert.equal(ring.inner, 0.99, "the inner arc is the longer window");
	assert.equal(ring.label, "Claude", "the ring names the plan");
	// One window: the same words, without a second window to name.
	const one = words.ringOf(row({ windows: [window(12, 300, TODAY_RESET)] }));
	assert.equal(one.sub, "5 hours: 12% used", "a plan with one window says so");
	// A walled plan keeps the wall and the number's own words.
	const walled = words.ringOf(row({ windows: [window(67, 300, TODAY_RESET)], walls: [{ until: TODAY_RESET, source: "quota" }] }));
	assert.equal(walled.sub, "5 hours: 67% used · walled, resets 21:30", "the wall comes after the number's own words");
});

test("CCP: D46's table, minute for minute", () => {
	for (const [minutes, expected] of [[272, "4.5 hours"], [300, "5 hours"], [1440, "Day"], [8519, "5.9 days"], [10080, "Week"], [43200, "Month"]] as const) {
		assert.equal(words.windowWords(minutes), expected, `${minutes} minutes reads "${expected}"`);
	}
	assert.equal(words.windowLabel({ name: "Sonnet week", windowMinutes: 10_080 }), "Sonnet week", "a named window keeps its name");
	assert.equal(words.windowLabel({ usedPercent: 1, windowMinutes: 10_080, resetsAt: 0 }), "Week", "an unnamed one reads its length");
	assert.equal(words.windowWords(null), "", "no length, no words");
});

test("CCP: D46's three shapes of a time, in the operator's zone", () => {
	assert.equal(words.resetWords(TODAY_RESET, NOW), "21:30", "today reads the clock");
	assert.equal(words.resetWords(FRIDAY_RESET, NOW), "Fri 07:00", "within six days reads the weekday and the clock");
	assert.equal(words.resetWords(LATER_RESET, NOW), "10 Nov", "later reads the date");
	assert.equal(words.resetWords(null, NOW), "", "no time, no words");
});

test("CCP: the Today card names the soonest reset", () => {
	assert.equal(words.nearestResetWords(subscriptions, NOW), "Claude resets 21:30", "the soonest reset among the subscription rows, named by its row");
	assert.equal(words.nearestResetWords([], NOW), "", "nothing to name");
});

// ── The fifth tab, and the phone's More control (D40) ───────────────────────

test("CCP: the nav's fifth tab is Systems, after History", () => {
	const block = /const NAV_ITEMS = \[([\s\S]*?)\];/.exec(PAGE)?.[1];
	assert.ok(block !== undefined, "the page declares its nav items");
	const ids = [...block!.matchAll(/id: "([a-z]+)"/g)].map((match) => match[1]!);
	assert.deepEqual(ids, ["today", "goals", "pipeline", "history", "systems"], "five views, Systems last");
	assert.match(PAGE, /label: "Systems"/, "and it is named");
});

test("CCP: at 390 px the row keeps the four controls CRW measured, and History and Systems sit under More", () => {
	// The phone block is the page's one `max-width: 760px` query; the rules below are read from it as text, so
	// this check needs no browser and no rendered geometry.
	const phone = /@media \(max-width: 760px\) \{([\s\S]*?)\n\}/.exec(PAGE)?.[1] ?? "";
	assert.notEqual(phone, "", "the phone block is in the page");
	assert.match(phone, /\.navrow \.g-nav-tab\[data-id="history"\], \.navrow \.g-nav-tab\[data-id="systems"\] \{ display: none; \}/, "the two tabs leave the phone's row");
	assert.match(phone, /\.navrow \.morebtn \{ display: inline-flex;/, "one More control takes their place");
	assert.match(PAGE, /^\.morebtn \{ display: none; \}$/m, "and it is hidden on a wide screen, where all five tabs show");
	const menu = /<div class="more-menu glass" id="more-menu"([\s\S]*?)<\/div>/.exec(PAGE)?.[1] ?? "";
	assert.match(menu, /data-more="history"/, "the menu holds History");
	assert.match(menu, /data-more="systems"/, "and Systems");
	// Scrum is a view with no tab of its own: it joins the menu, and the row still carries only the four
	// controls, with those same two tabs under More. The row's budget is what this test holds; the menu is
	// where a tabless view goes.
	assert.match(menu, /data-more="scrum"/, "and Scrum, which has no tab of its own");
	assert.equal([...menu.matchAll(/data-more="/g)].length, 3, "the two tabs the row cannot hold, plus the one view with no tab");
});

// ── The panel's own fields the page reads (D41, D42) ────────────────────────

const providerRow = (over: Partial<SnapshotProvider> = {}): SnapshotProvider =>
	({
		provider: "claude-code",
		quotaState: "read",
		plan: { name: "Max", monthlyUsd: 200, source: "catalogue", readOn: "2026-10-01" },
		quota: { source: "claude-usage", planType: "max", capturedAt: NOW, ageMs: 60_000, primary: { usedPercent: 40, windowMinutes: 300, resetsAt: Math.floor(TODAY_RESET / 1000) }, secondary: null },
		error: null,
		walls: [],
		reason: null,
		readerWired: true,
		...over
	}) as SnapshotProvider;

const usageInput = (over: Partial<UsageInput> = {}): UsageInput => ({
	snapshot: { capturedAt: NOW - 4 * 60_000, providers: [providerRow()] },
	plans: [],
	routing: undefined,
	claudeMax: undefined,
	runningLanes: () => 0,
	now: NOW,
	...over
});

test("CCP: the panel judges freshness with the router's own rule, not the page's arithmetic", () => {
	const fresh = buildUsage(usageInput());
	assert.equal(fresh.stale, false, "a four-minute-old snapshot is fresh");
	assert.equal(fresh.valueLine, null, "no digest line is no sentence");
	const old = buildUsage(usageInput({ snapshot: { capturedAt: NOW - 40 * 60_000, providers: [providerRow()] } }));
	assert.equal(old.stale, true, "past SNAPSHOT_FRESH_MS the router is not using it");
	const edge = buildUsage(usageInput({ snapshot: { capturedAt: NOW - SNAPSHOT_FRESH_MS, providers: [providerRow()] } }));
	assert.equal(edge.stale, false, "exactly the owner's threshold is still fresh, as `snapshotIsFresh` says");
});

test("CCP: a meter reading is marked from the owner's list, so the page never keeps a copy of it", () => {
	assert.equal(buildUsage(usageInput()).rows[0]!.meter, false, "a provider reading is not a meter row");
	const meter = buildUsage(usageInput({
		snapshot: { capturedAt: NOW, providers: [providerRow({ quota: { source: "monitor bot", planType: null, capturedAt: NOW, ageMs: 60_000, primary: null, secondary: null } })] }
	}));
	assert.equal(meter.rows[0]!.meter, true, "the monitor bot's reading is one");
	const browser = buildUsage(usageInput({
		snapshot: { capturedAt: NOW, providers: [providerRow({ quota: { source: "browser reader", planType: null, capturedAt: NOW, ageMs: 60_000, primary: null, secondary: null } })] }
	}));
	assert.equal(browser.rows[0]!.meter, true, "and so is this PC's browser reader");
});

test("CCP: the panel carries the digest's line when the composer passes it", () => {
	assert.equal(buildUsage(usageInput({ valueLine: "- fleet (30d): a sentence" })).valueLine, "- fleet (30d): a sentence");
});

// ── The composer's one extra read: cost-digest.json beside the snapshot (D42) ──

const deps = (over: Partial<CommandCenterDeps> = {}): CommandCenterDeps => ({
	stateDir: "/nonexistent-state",
	home: "/nonexistent-home",
	now: () => new Date(NOW),
	lanes: () => [],
	scopeUnits: () => [],
	briefTitle: () => undefined,
	gateStatus: async () => GATE_OK,
	psiKills: (): PsiKill[] => [],
	tasks: () => [],
	closeLane: async () => ({ ok: true, detail: "" }),
	heavyJobs: async () => ({ ok: true, detail: "" }),
	usageSnapshot: () => ({ version: 1 as const, capturedAt: NOW - 40 * 60_000, providers: [providerRow()] }),
	plans: () => [],
	routing: () => undefined,
	poolRouting: () => undefined,
	laneOutcomes: () => ({ rows: [], skipped: 0 }),
	...over
});

test("CCP: the digest is read beside the snapshot, and its absence is a sentence rather than a number", async () => {
	const root = mkdtempSync(join(tmpdir(), "ccp-digest-"));
	const saved = process.env.PI_USAGE_SNAPSHOT_PATH;
	process.env.PI_USAGE_SNAPSHOT_PATH = join(root, "snapshot.json");
	try {
		const missing = (await commandCenter(deps()).state()).panels.usage.data!;
		assert.equal(missing.valueLine, null, "no file, no sentence");
		assert.equal(missing.stale, true, "and the snapshot's own age still decides the line");

		const line = "- fleet (30d): API-equivalent at least $412.10 against plans $130.20: saves at least $281.90, 3.2x";
		writeFileSync(join(root, "cost-digest.json"), JSON.stringify({ version: 1, plans30d: { line, equivalentUsd: 412.1, unknownEquivalentTurns: 3 } }));
		const read = (await commandCenter(deps()).state()).panels.usage.data!;
		assert.equal(read.valueLine, line, "the digest's own line, unchanged");

		writeFileSync(join(root, "cost-digest.json"), JSON.stringify({ version: 1, plans30d: { line: 42 } }));
		assert.equal((await commandCenter(deps()).state()).panels.usage.data!.valueLine, null, "a shape the digest does not write is no sentence");
	} finally {
		if (saved === undefined) delete process.env.PI_USAGE_SNAPSHOT_PATH; else process.env.PI_USAGE_SNAPSHOT_PATH = saved;
		rmSync(root, { recursive: true, force: true });
	}
});

// ── The page's own contract: it renders the words above, and adds none ──────

test("CCP: the Systems view builds its cards from those words, and the page keeps no provider name", () => {
	assert.match(PAGE, /planCardNode\(planCardWords\(row, now, counted\[row\.provider\] > 1\)\)/, "one card per row, the words coming from the block");
	assert.match(PAGE, /usage\.stale === true \? staleWords\(usage\.capturedAt, now\)/, "the stale line comes from the panel's flag and the owner's age");
	assert.match(PAGE, /valueLineWords\(usage\)/, "the value line is the digest's sentence");
	assert.match(PAGE, /cta: \{ action: "systems", label: "All your plans" \}/, "the Today card opens Systems (R7a.1)");
	for (const name of ["Claude", "DeepSeek", "MiniMax", "Grok"]) assert.equal(PAGE.includes(name), false, `the page names no provider ("${name}")`);
});
