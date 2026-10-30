import "./muster-test-isolation.ts";
/**
 * The command center page's own width, and the local view's requests (cc1's D1 and D2).
 *
 * D1: the page ran off the right edge — the "Only you can do these" panel's `ul.steps` ended at 1626 px on a
 * 1440 px viewport, and on a 390 px phone a section ended at 712 px with the Message button clipped. The rule that
 * let it happen is that a grid track and a grid item may both be pushed wider than the viewport by a long word (a
 * path, a URL, an id): `1fr` is `minmax(auto, 1fr)`, so a track grows to its content's minimum, and a grid item's
 * automatic minimum size is its own minimum-content size. This file measures the same thing the defect was measured
 * with — the element's own right edge against the viewport's width — at 1440 and at 390, and fails with the name of
 * every element that runs past the edge.
 *
 * D2: the local (loopback) view asked `/cc/api/messages` for a route the loopback listener does not serve by design
 * (it is not a read route), so the page produced a failed request and a console error against a listener that was
 * never going to answer it. This file drives the page against the loopback listener's own state — the one
 * `loopbackState` builds — and fails if the page asks for that route or logs an error.
 *
 * The harness is the one the Revision 7 page test already uses: the real page file in headless Chrome over CDP,
 * against a fixture server this file starts itself. No live gateway, no live provider, synthetic names only.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import {
	CC_ASSETS,
	commandCenterAssetsDir,
	commandCenterCsp,
	commandCenterPageFile,
	commandCenterPageHtml
} from "../gateway/command-center.ts";
import { loopbackState } from "../gateway/command-center-local.ts";
import { buildScrumPanel } from "../gateway/command-center-scrum.ts";
import { buildWorkItemRecord, type CreateWorkItemInput } from "../work-items.ts";

// ── The fixture: a day of the command center, with the long words a real day carries ───

const NOW = Date.parse("2026-10-28T20:00:00.000Z");
const at = (minutesAgo: number): number => NOW - minutesAgo * 60_000;

/**
 * A file name of the kind a real decision quotes: one word, so the browser has no place to break it. This is the
 * shape that pushes a panel past the viewport — a track sized `1fr` grows to its content's minimum, and a grid
 * item's automatic minimum size is its own minimum-content size.
 */
const LONG_WORD = ["unbreakable", "filename", "for", "the", "layout", "fixture"].join("");
/** A URL of the kind a real change line carries. */
const LONG_URL = "https://muster.example.test/reports/commandcenterreleasecheck20261028";

const STAGES = [
	{ key: "assigning", label: "Assigning" },
	{ key: "working", label: "Working" },
	{ key: "verifying", label: "Verifying" },
	{ key: "sent-back", label: "Sent back" },
	{ key: "waiting-to-merge", label: "Waiting to merge" },
	{ key: "merged", label: "Merged" }
];

const panel = (data: unknown) => ({ readAt: new Date(NOW).toISOString(), error: null, data });

/** The state the tailnet listener serves: every panel, the messages one included. */

/** One work item the Scrum views read, built by the owner's builder: no fixture record the owner would refuse. */
function layoutStory(code: string, input: Partial<CreateWorkItemInput> & { points?: number }) {
	const base: CreateWorkItemInput = {
		code,
		heading: "Story " + code.toLowerCase(),
		summary: "What " + code + " delivers.",
		goal: input.goal ?? "SI",
		project: "muster",
		kind: "build",
		class: "H3",
		acceptance: "The story works.",
		source: "layout fixture",
		brief: "brief",
		ownedPaths: ["muster/gateway/command-center-page.html"],
		dependencies: [],
	};
	return buildWorkItemRecord({ ...base, ...input } as CreateWorkItemInput, { by: "tick", at: "2026-10-27T08:00:00.000Z" });
}

function tailnetState(): unknown {
	return {
		generatedAt: new Date(NOW).toISOString(),
		startedAt: new Date(NOW - 7_200_000).toISOString(),
		stages: STAGES,
		recent: ["Alpha moved to Verifying"],
		summary: panel({
			needsYou: { total: 3, decisions: 1, steps: 2, drafts: 1, pc: 1, holdGoals: [] },
			working: { count: 1, byModel: [{ name: "DeepSeek V4.1 Flash", count: 1 }] },
			review: { verifying: 1, waiting: 0, sentBack: 0 },
			shipped: { today: 4, thisHour: 1, perHour: [0, 1, 0, 2, 1] },
			decidedToday: [{ code: "VR24-222", question: "The card contract" }]
		}),
		panels: {

			// CUTOVER: the Scrum views' own facts, built by the owner's builder so the fixture cannot hold a shape it refuses.
			scrum: panel(
				buildScrumPanel(
					[
						layoutStory("CC-EST", { priority: "P0", points: 3, state: "ready", goal: "SI" }),
						layoutStory("CC-OPEN", { priority: "P1", points: 2, state: "launched:lane-alpha", sprint: "sprint-7", goal: "SI" }),
						layoutStory("CC-NOPOINTS", { priority: "P2", state: "gated:waiting on hardware", sprint: "sprint-7", goal: "S2" }),
						layoutStory("CC-DONE", { priority: "P3", points: 5, state: "done", sprint: "sprint-7", goal: "SI" }),
					],
					"2026-10-29",
					1,
				)
			),
			lanes: panel({
				rows: [
					{
						laneId: "lane-alpha",
						harness: "pi",
						model: "command-code/deepseek/deepseek-v4.1-flash",
						modelName: "DeepSeek V4.1 Flash",
						title: "Rewrite the intake brief for " + LONG_WORD,
						stage: "working",
						origin: "auto",
						goal: "EA",
						station: "build",
						rounds: 0,
						since: at(18),
						startedAt: at(24),
						// The record's own codes: what a person reads must be words, not these (the operator, 2026-10-29).
						class: "decision_conflict",
						taskKind: "product_rule",
						report: { at: at(20), kind: "review_ready", summary: "The page answers for its own width" },
						handoffs: [{ at: at(15), verdict: "sent_back", cause: "a missing pin" }]
					}
				]
			}),
			team: panel({ members: [] }),
			decisions: panel({
				tickets: [
					{
						id: "ticket-1",
						code: "VR24-222",
						question: "Should the page answer the plan ring from " + LONG_WORD + " and the release check say the same thing?",
						kind: "decision",
						status: "open",
						ageMs: at(40),
						stale: false,
						blocks: [],
						options: []
					},
					{
						id: "ticket-2",
						code: "VR24-223",
						question: "Records for state, Markdown for reasoning.",
						kind: "decision",
						status: "open",
						ageMs: at(10),
						stale: false,
						blocks: [],
						options: []
					}
				]
			}),
			goals: panel({
				groups: [{
					project: "muster",
					title: "Muster",
					goals: [{
						code: "EA",
						name: "The intake brief",
						title: "The intake brief",
						status: "open",
						colour: "cyan",
						// Six stations, three done: the plate and the circle both say 3 of 6 (the operator, 2026-10-29).
						stations: [
							{ name: "The questions", done: true, now: false },
							{ name: "The audit", done: true, now: false },
							{ name: "The offer", done: true, now: false },
							{ name: "The build", done: false, now: true },
							{ name: "The phone pass", done: false, now: false },
							{ name: "The review", done: false, now: false }
						]
					}]
				}]
			}),
			shipped: panel({ items: [{ title: "The release check " + LONG_WORD, at: at(30), lane: "lane-alpha" }] }),
			next: panel({ items: [{ when: "Friday 18:00", text: "The " + LONG_URL + " review" }] }),
			ideas: panel({
				cards: [
					{
						id: "card-1",
						title: "The plans ring of " + LONG_URL,
						url: LONG_URL,
						verdict: "signal",
						sentences: "A short card with a long link in its title.",
						source: "https://example.test/idea"
					}
				]
			}),
			usage: panel({
				capturedAt: NOW - 120_000,
				rows: [
					{
						provider: "claude-code",
						label: "Claude",
						kind: "subscription",
						plan: { name: "Max", monthlyUsd: 100 },
						quotaState: "ok",
						windows: [
							{ usedPercent: 1, windowMinutes: 300, resetsAt: Math.floor((NOW + 7_200_000) / 1000) },
							{ usedPercent: 99, windowMinutes: 10_080, resetsAt: Math.floor((NOW + 259_200_000) / 1000) }
						],
						ageMs: 120_000,
						source: "claude-oauth-usage",
						walls: [],
						router: { atHeadroom: false, runningLanes: 1 }
					},
					// A second plan, so the phone's card carries two rings and their columns can be told apart.
					{
						provider: "opencode-go",
						label: "OpenCode Go",
						kind: "subscription",
						plan: { name: "Go", monthlyUsd: 20 },
						quotaState: "ok",
						windows: [{ usedPercent: 37, windowMinutes: 10_080, resetsAt: Math.floor((NOW + 259_200_000) / 1000) }],
						ageMs: 300_000,
						source: "opencode-usage",
						walls: [],
						router: { atHeadroom: false, runningLanes: 2 }
					}
				]
			}),
			messages: panel({ counts: { draftsWaiting: 2, needYou: 1 } })
		}
	};
}

// ── The fixture server: the page, the vendored library, the state and the stream ──

type Fixture = {
	base: string;
	requests: string[];
	setState: (next: unknown) => void;
	/** The tailnet listener serves the messages route; the loopback listener does not, and answers 404. */
	setMessages: (served: boolean) => void;
	close: () => Promise<void>;
};

async function startFixture(): Promise<Fixture> {
	const page = commandCenterPageHtml(readFileSync(commandCenterPageFile(), "utf8"), "layout-test-token", "layout-test-nonce");
	const assets = commandCenterAssetsDir();
	const requests: string[] = [];
	let state: unknown = tailnetState();
	let messagesServed = true;
	const server = createServer((request, response) => {
		const path = (request.url ?? "/").split("?")[0];
		requests.push(path);
		if (path === "/" || path === "/cc/" || path === "/cc") {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": commandCenterCsp("layout-test-nonce"), "cache-control": "no-store" });
			response.end(page);
			return;
		}
		if (path === "/favicon.ico") {
			response.writeHead(204);
			response.end();
			return;
		}
		if (path.startsWith("/cc/assets/")) {
			const name = path.slice("/cc/assets/".length);
			const type = CC_ASSETS.get(name);
			if (type === undefined) {
				response.writeHead(404);
				response.end("no");
				return;
			}
			response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
			response.end(readFileSync(join(assets, name)));
			return;
		}
		if (path === "/cc/api/live") {
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
			response.write(": open\n\n");
			response.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
			// A change line of the kind a real lane writes: one long word in it.
			response.write(`event: panels\ndata: ${JSON.stringify({ generatedAt: new Date(NOW).toISOString(), changes: ["lane-alpha moved to Verifying after " + LONG_WORD] })}\n\n`);
			request.on("close", () => { /* the page closed its stream */ });
			return;
		}
		if (path === "/cc/api/state") {
			response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
			response.end(JSON.stringify(state));
			return;
		}
		if (path === "/cc/api/messages") {
			if (!messagesServed) {
				// The loopback listener's own answer: `/cc/api/messages` is not a read route, so it is 404 there.
				response.writeHead(404, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: "not found" }));
				return;
			}
			// The tailnet listener's own answer (MG7): the drafts with their text.
			response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
			response.end(JSON.stringify({
				panel: {
					strip: { tone: "ok", text: "The phone link is up" },
					counts: { draftsWaiting: 1, needYou: 1 },
					history: true,
					empty: null,
					rows: [{ thread: "thread-1", name: "Ana Petrova", channel: "whatsapp", state: "draft", line: "Draft ready", preview: "Can we move the release check " + LONG_WORD + " to Thursday?", waitingSince: new Date(at(9)).toISOString(), draftId: "draft-1" }]
				}
			}));
			return;
		}
		response.writeHead(404, { "content-type": "text/plain" });
		response.end("no");
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const port = (server.address() as AddressInfo).port;
	return {
		base: `http://127.0.0.1:${port}/cc/`,
		requests,
		setState: (next: unknown) => { state = next; },
		setMessages: (served: boolean) => { messagesServed = served; },
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((done) => server.close(() => done()));
		}
	};
}

// ── Headless Chrome over CDP, the same transport the Revision 7 page test uses ──

type Cdp = {
	send: (method: string, params?: Record<string, unknown>) => Promise<any>;
	on: (method: string, listener: (params: any) => void) => void;
	close: () => void;
};

async function targetUrl(debugPort: number): Promise<string> {
	for (let attempt = 0; attempt < 120; attempt += 1) {
		try {
			const list = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
			const page = list.find((entry) => entry.type === "page");
			if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
		} catch { /* not up yet */ }
		await new Promise((done) => setTimeout(done, 200));
	}
	throw new Error("headless Chrome did not open a page target");
}

async function startChrome(): Promise<{ child: ChildProcess; cdp: Cdp; profile: string }> {
	const profile = mkdtempSync(join(tmpdir(), "cc-layout-profile-"));
	const child = spawn(process.env.CC_CHROME ?? "/usr/bin/google-chrome", [
		"--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
		"--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars",
		"--disable-extensions", "--disable-background-networking", "--force-device-scale-factor=1",
		"--no-sandbox", "about:blank"
	], { stdio: "ignore" });
	const portFile = join(profile, "DevToolsActivePort");
	for (let attempt = 0; attempt < 150; attempt += 1) {
		if (existsSync(portFile)) {
			const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
			if (Number.isFinite(port) && port > 0) {
				const socket = new WebSocket(await targetUrl(port));
				await new Promise<void>((done, fail) => {
					socket.addEventListener("open", () => done());
					socket.addEventListener("error", () => fail(new Error("the CDP socket refused")));
				});
				let next = 1;
				const pending = new Map<number, { done: (value: any) => void; fail: (error: Error) => void }>();
				const listeners = new Map<string, Array<(params: any) => void>>();
				socket.addEventListener("message", (event) => {
					const message = JSON.parse(String((event as MessageEvent).data)) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string; code: number } };
					if (message.method) {
						for (const listener of listeners.get(message.method) ?? []) listener(message.params);
						return;
					}
					if (!message.id) return;
					const waiting = pending.get(message.id);
					if (!waiting) return;
					pending.delete(message.id);
					if (message.error) waiting.fail(new Error(`${message.error.message} (${message.error.code})`));
					else waiting.done(message.result);
				});
				const cdp: Cdp = {
					on: (method, listener) => {
						const list = listeners.get(method) ?? [];
						list.push(listener);
						listeners.set(method, list);
					},
					send: (method, params = {}) => {
						const id = next++;
						return new Promise((done, fail) => {
							pending.set(id, { done, fail });
							socket.send(JSON.stringify({ id, method, params }));
							setTimeout(() => {
								if (pending.has(id)) { pending.delete(id); fail(new Error(`${method} timed out`)); }
							}, 60000);
						});
					},
					close: () => { socket.close(); }
				};
				return { child, cdp, profile };
			}
		}
		await new Promise((done) => setTimeout(done, 200));
	}
	child.kill("SIGKILL");
	throw new Error("headless Chrome did not start");
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
	const result = (await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as { result?: { value?: T }; exceptionDetails?: { text: string } };
	if (result.exceptionDetails) throw new Error(`the page threw: ${result.exceptionDetails.text}`);
	return result.result?.value as T;
}

async function waitFor(cdp: Cdp, expression: string, what: string, timeoutMs = 20000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluate<boolean>(cdp, `(() => { try { return Boolean(${expression}); } catch (error) { return false; } })()`)) return;
		await sleep(100);
	}
	throw new Error(`waited ${timeoutMs} ms for ${what}`);
}

/** Every element that runs past the right edge of the viewport, with its own numbers. */
const OVERFLOW_PROBE = `(() => {
	const viewport = window.innerWidth;
	const bad = [];
	for (const element of document.querySelectorAll("body *")) {
		if (element.closest(".ground")) continue;
		const style = getComputedStyle(element);
		if (style.visibility === "hidden" || style.display === "none") continue;
		const rect = element.getBoundingClientRect();
		if (rect.width === 0 && rect.height === 0) continue;
		if (rect.right > viewport + 1) {
			bad.push({
				tag: element.tagName.toLowerCase(),
				id: element.id || "",
				class: String(element.className && element.className.baseVal !== undefined ? element.className.baseVal : element.className || "").slice(0, 60),
				right: Math.round(rect.right),
				width: Math.round(rect.width)
			});
		}
	}
	return { viewport, scrollWidth: document.scrollingElement.scrollWidth, bad: bad.slice(0, 20), total: bad.length };
})()`;

let fixture: Fixture;
let chrome: { child: ChildProcess; cdp: Cdp; profile: string };
let consoleErrors: string[] = [];
let navigations = 0;

async function openPage(): Promise<void> {
	navigations += 1;
	await chrome.cdp.send("Page.navigate", { url: `${fixture.base}?r=${navigations}` });
	await waitFor(chrome.cdp, "document.readyState === 'complete' && document.querySelector('#view .view') !== null", "the first paint");
	await sleep(400);
}

before(async () => {
	fixture = await startFixture();
	chrome = await startChrome();
	chrome.cdp.on("Runtime.consoleAPICalled", (params: { type?: string; args?: Array<{ value?: unknown; description?: string }> }) => {
		if (params.type !== "error") return;
		consoleErrors.push((params.args ?? []).map((arg) => String(arg.value ?? arg.description ?? "")).join(" "));
	});
	chrome.cdp.on("Runtime.exceptionThrown", (params: { exceptionDetails?: { text?: string } }) => {
		consoleErrors.push(params.exceptionDetails?.text ?? "an exception");
	});
	chrome.cdp.on("Log.entryAdded", (params: { entry?: { level?: string; text?: string; url?: string } }) => {
		const entry = params.entry;
		if (!entry || entry.level !== "error") return;
		// The page's own network error is the thing under test; a favicon is not the page's business.
		if (String(entry.url ?? "").includes("/favicon.ico")) return;
		consoleErrors.push(entry.text ?? "a network error");
	});
	await chrome.cdp.send("Page.enable");
	await chrome.cdp.send("Runtime.enable");
	await chrome.cdp.send("Log.enable");
});

after(async () => {
	await fixture?.close();
	chrome?.cdp.close();
	chrome?.child.kill("SIGKILL");
	if (chrome?.profile) rmSync(chrome.profile, { recursive: true, force: true });
});

test("nothing on the page runs past the right edge of a 1440 px viewport", async () => {
	fixture.setMessages(true);
	await chrome.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
	await openPage();
	const probe = await evaluate<{ viewport: number; scrollWidth: number; bad: unknown[]; total: number }>(chrome.cdp, OVERFLOW_PROBE);
	assert.equal(probe.total, 0, `elements past the right edge at 1440: ${JSON.stringify(probe.bad)}`);
	assert.ok(probe.scrollWidth <= probe.viewport, `the page scrolls sideways at 1440: ${probe.scrollWidth} > ${probe.viewport}`);
});

test("QW3: nothing on the page runs past the right edge at 360 or 768 either", async () => {
	fixture.setMessages(true);
	for (const width of [360, 768]) {
		await chrome.cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width <= 390 });
		await openPage();
		const probe = await evaluate<{ viewport: number; scrollWidth: number; bad: unknown[]; total: number }>(chrome.cdp, OVERFLOW_PROBE);
		assert.equal(probe.total, 0, `elements past the right edge at ${width}: ${JSON.stringify(probe.bad)}`);
		assert.ok(probe.scrollWidth <= probe.viewport, `the page scrolls sideways at ${width}: ${probe.scrollWidth} > ${probe.viewport}`);
	}
});

test("nothing on the page runs past the right edge of a 390 px phone, and the Message button stays inside", async () => {
	fixture.setMessages(true);
	await chrome.cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
	await openPage();
	const probe = await evaluate<{ viewport: number; scrollWidth: number; bad: unknown[]; total: number }>(chrome.cdp, OVERFLOW_PROBE);
	assert.equal(probe.total, 0, `elements past the right edge at 390: ${JSON.stringify(probe.bad)}`);
	assert.ok(probe.scrollWidth <= probe.viewport, `the page scrolls sideways at 390: ${probe.scrollWidth} > ${probe.viewport}`);
	const button = await evaluate<{ right: number; viewport: number }>(chrome.cdp, `(() => {
		const node = document.querySelector("#open-msg");
		if (!node) return { right: -1, viewport: window.innerWidth };
		return { right: Math.round(node.getBoundingClientRect().right), viewport: window.innerWidth };
	})()`);
	assert.ok(button.right > 0, "the Message button is on the page");
	assert.ok(button.right <= button.viewport, `the Message button runs past the phone's edge: ${button.right} > ${button.viewport}`);
});

test("the plans ring says what its number is: the window it belongs to, and that it is used", async () => {
	fixture.setMessages(true);
	await chrome.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
	await openPage();
	const ring = await evaluate<{ value: string; label: string; sub: string }>(chrome.cdp, `(() => {
		const item = document.querySelector("#kpi-plans g-ring");
		if (!item) return { value: "", label: "", sub: "" };
		const value = item.querySelector(".g-ring-val");
		const label = item.querySelector(".g-ring-label");
		const sub = item.querySelector(".g-ring-sub");
		return {
			value: value ? String(value.textContent || "") : "",
			label: label ? String(label.textContent || "") : "",
			sub: sub ? String(sub.textContent || "") : ""
		};
	})()`);
	assert.equal(ring.label, "Claude", "the ring is the Claude plan's");
	assert.equal(ring.value, "1%", "the number is the short window's used percent, the usage snapshot's own number");
	assert.equal(ring.sub, "5 hours: 1% used · Week: 99% used", "the label says which window the number is, that it is used, and the week beside it");
});

test("the loopback listener's own state says the view is counts only, and it keeps the counts it may show", () => {
	const state = loopbackState(tailnetState() as never);
	assert.equal(state.countsOnly, true, "the loopback's state says the message text is not there, so the page never asks for it");
	const panel = state.panels.messages as { data?: { openOnPhone?: boolean; counts?: { draftsWaiting?: number; needYou?: number } } };
	assert.equal(panel.data?.openOnPhone, true, "the messages panel is withheld: the page is sent to the phone");
	assert.equal(panel.data?.counts?.draftsWaiting, 2, "the counts the loopback may show are kept");
});

test("the local view asks for no route the loopback listener does not serve, and logs no error", async () => {
	fixture.setMessages(false);
	fixture.setState(loopbackState(tailnetState() as never));
	await chrome.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
	fixture.requests.length = 0;
	consoleErrors = [];
	await openPage();
	await sleep(600);
	assert.deepEqual(fixture.requests.filter((path) => path === "/cc/api/messages"), [], "the page asked for a route the loopback listener does not serve");
	assert.deepEqual(consoleErrors, [], "the page logged an error against the loopback listener");
});

test("the loopback view still shows what the loopback view may show: the message counts", async () => {
	const strip = await evaluate<string>(chrome.cdp, `(() => {
		const node = document.querySelector("#msg-strip");
		return node ? String(node.textContent || "") : "";
	})()`);
	assert.match(strip, /draft/i, `the loopback view's message strip says nothing about the drafts it counts: ${JSON.stringify(strip)}`);
});

// ── the operator's four from his phone (2026-10-29): the sheet, the rings, the words, the plate ──

test("a load never opens a lane sheet: a tap is the only way in, and the address it landed on is rewritten", async () => {
	fixture.setMessages(true);
	fixture.setState(tailnetState());
	await chrome.cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
	await chrome.cdp.send("Page.navigate", { url: `${fixture.base}#lane/lane-alpha` });
	await waitFor(chrome.cdp, "document.readyState === 'complete' && document.querySelector('#view .view') !== null", "the lane-route paint");
	await sleep(900);
	const after = await evaluate<{ open: boolean; hash: string; title: string }>(chrome.cdp, `(() => {
		const sheet = document.querySelector("g-sheet#lane-sheet");
		const title = sheet ? sheet.querySelector(".g-sheet-title") : null;
		return { open: Boolean(sheet && sheet.isOpen), hash: location.hash, title: title ? String(title.textContent || "") : "" };
	})()`);
	assert.equal(after.open, false, `a load opened a lane sheet by itself (${after.hash}): ${JSON.stringify(after.title)}`);
	assert.equal(after.hash, "#today", "the address a load lands on is the view it shows, so a refresh cannot resurrect the sheet");
});

test("the phone's top bar leaves the brand its own room, and the nav row nothing to scroll", async () => {
	fixture.setMessages(true);
	await chrome.cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
	await openPage();
	const bar = await evaluate<{ brandRight: number; modeLeft: number; scroll: number; client: number; firstLeft: number }>(chrome.cdp, `(() => {
		const box = (node) => node ? node.getBoundingClientRect() : null;
		const brand = box(document.querySelector(".brand"));
		const mode = box(document.querySelector("#mode"));
		const row = document.querySelector(".navrow");
		const tab = document.querySelector(".g-nav-tab");
		return {
			brandRight: brand ? Math.round(brand.right) : -1,
			modeLeft: mode ? Math.round(mode.left) : -1,
			scroll: row ? row.scrollWidth : 0,
			client: row ? row.clientWidth : 0,
			firstLeft: tab ? Math.round(box(tab).left) : -1
		};
	})()`);
	assert.ok(bar.brandRight <= bar.modeLeft, `the brand runs under the theme button: brand ends at ${bar.brandRight}, the button starts at ${bar.modeLeft}`);
	assert.ok(bar.scroll <= bar.client + 1, `the nav row has to scroll on the phone: ${bar.scroll} > ${bar.client}, which cuts the first tab at the left edge`);
	assert.ok(bar.firstLeft >= 0, `the first tab starts left of the viewport: ${bar.firstLeft}`);
});

test("the plans card's rings keep their own circles at 390: each number sits in its own ring", async () => {
	fixture.setMessages(true);
	await chrome.cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
	await openPage();
	const rings = await evaluate<Array<{ value: string; left: number; right: number; valueDx: number; valueDy: number; subLeft: number; subRight: number }>>(chrome.cdp, `(() => {
		const host = document.querySelector("#kpi-plans");
		if (!host) return [];
		return [...host.querySelectorAll(".g-ring")].map((ring) => {
			const wrap = ring.querySelector(".g-ring-wrap").getBoundingClientRect();
			const value = ring.querySelector(".g-ring-val").getBoundingClientRect();
			const sub = ring.querySelector(".g-ring-sub");
			const subBox = sub ? sub.getBoundingClientRect() : wrap;
			return {
				value: String(ring.querySelector(".g-ring-val").textContent || ""),
				left: Math.round(ring.getBoundingClientRect().left),
				right: Math.round(ring.getBoundingClientRect().right),
				valueDx: Math.round((value.left + value.width / 2) - (wrap.left + wrap.width / 2)),
				valueDy: Math.round((value.top + value.height / 2) - (wrap.top + wrap.height / 2)),
				subLeft: Math.round(subBox.left),
				subRight: Math.round(subBox.right)
			};
		});
	})()`);
	assert.ok(rings.length >= 2, `the plans card shows its rings: ${rings.length}`);
	for (let index = 0; index < rings.length; index += 1) {
		assert.ok(Math.abs(rings[index]!.valueDx) <= 2 && Math.abs(rings[index]!.valueDy) <= 2, `ring ${index}'s number is not in its own circle: dx=${rings[index]!.valueDx} dy=${rings[index]!.valueDy}`);
		if (index > 0) assert.ok(rings[index - 1]!.subRight <= rings[index]!.left + 1, `ring ${index - 1}'s words run into ring ${index}: ${rings[index - 1]!.subRight} > ${rings[index]!.left}`);
	}
});

test("a goal's plate is its own progress: one mark per station, filled for the ones that are done", async () => {
	fixture.setMessages(true);
	await chrome.cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
	await chrome.cdp.send("Page.navigate", { url: `${fixture.base}#goals` });
	await waitFor(chrome.cdp, "document.querySelector('g-goal-card') !== null", "the goal board");
	await sleep(900);
	const card = await evaluate<{ circle: string; marks: number; filled: number; labels: string[] }>(chrome.cdp, `(() => {
		const card = document.querySelector("g-goal-card");
		const strip = card ? card.querySelector(".g-strip") : null;
		const cells = strip ? [...strip.querySelectorAll("i")] : [];
		return {
			circle: card && card.querySelector(".g-mini-val") ? String(card.querySelector(".g-mini-val").textContent || "") : "",
			marks: cells.length,
			filled: cells.filter((cell) => /g-done/.test(String(cell.className))).length,
			labels: cells.map((cell) => cell.getAttribute("title") || "")
		};
	})()`);
	assert.equal(card.circle, "3/6", "the circle counts three of six stations done");
	assert.equal(card.marks, 6, `the plate has one mark per station: ${JSON.stringify(card.labels)}`);
	assert.equal(card.filled, 3, "half the plate is filled, matching the circle");
});

test("the page cannot be panned sideways on a phone: the document is no wider than the screen, and a scroll goes nowhere", async () => {
	fixture.setMessages(true);
	await chrome.cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
	await openPage();
	const width = await evaluate<{ doc: number; body: number; viewport: number; afterScroll: number }>(chrome.cdp, `(async () => {
		const before = { doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, viewport: window.innerWidth };
		window.scrollTo(600, 0);
		await new Promise((done) => setTimeout(done, 60));
		return { ...before, afterScroll: Math.round(window.scrollX) };
	})()`);
	assert.ok(width.doc <= width.viewport, `the document is wider than the phone: ${width.doc} > ${width.viewport}`);
	assert.ok(width.body <= width.viewport, `the body is wider than the phone: ${width.body} > ${width.viewport}`);
	assert.equal(width.afterScroll, 0, "the page can be scrolled sideways");
});

test("the lane sheet names the work and its state, and shows no id, no branch name and no raw code", async () => {
	fixture.setMessages(true);
	fixture.setState(tailnetState());
	await chrome.cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
	await chrome.cdp.send("Page.navigate", { url: `${fixture.base}#pipeline` });
	await waitFor(chrome.cdp, "document.querySelector('g-board') !== null", "the pipeline board");
	await sleep(600);
	await evaluate<boolean>(chrome.cdp, `(() => {
		document.querySelector("g-board").dispatchEvent(new CustomEvent("g-select", { detail: { id: "lane-alpha" }, bubbles: true }));
		return true;
	})()`);
	await waitFor(chrome.cdp, "document.querySelector('g-sheet#lane-sheet') && document.querySelector('g-sheet#lane-sheet').isOpen", "the tapped sheet");
	await sleep(300);
	const sheet = await evaluate<{ text: string; tags: string[] }>(chrome.cdp, `(() => {
		const node = document.querySelector("g-sheet#lane-sheet");
		const tags = [...node.querySelectorAll(".g-sheet-tags *")];
		return { text: String(node.textContent || ""), tags: tags.map((tag) => String(tag.textContent || "")) };
	})()`);
	assert.match(sheet.text, /Waiting on review/, `the sheet never says what state the lane is in: ${JSON.stringify(sheet.text.slice(0, 200))}`);
	assert.doesNotMatch(sheet.text, /lane-alpha/, "the sheet shows the lane's own id");
	assert.doesNotMatch(sheet.text, /\bBranch\b/, "the sheet shows the branch name");
	assert.doesNotMatch(sheet.text, /undefined/, "the sheet shows the word undefined");
});

test("the page shows words where a record keeps a code, and no ring jargon", async () => {
	fixture.setMessages(true);
	fixture.setState(tailnetState());
	await chrome.cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
	await openPage();
	const aside = await evaluate<string>(chrome.cdp, `(() => {
		const card = document.querySelector("#kpi-plans");
		return card ? String(card.getAttribute("aside") || (card.querySelector(".g-kpi-aside") ? card.querySelector(".g-kpi-aside").textContent : "") || card.textContent || "") : "";
	})()`);
	assert.doesNotMatch(aside, /outer shortest|inner longest/i, `the plans card still carries the ring's internal words: ${JSON.stringify(aside.slice(0, 120))}`);
	// The lane sheet's own timeline: the record's codes, written out. The sheet opens where a lane card is: the
	// pipeline board.
	await chrome.cdp.send("Page.navigate", { url: `${fixture.base}#pipeline` });
	await waitFor(chrome.cdp, "document.querySelector('g-board') !== null", "the pipeline board");
	await sleep(600);
	await evaluate<boolean>(chrome.cdp, `(() => {
		const board = document.querySelector("g-board");
		if (!board) throw new Error("no board");
		board.dispatchEvent(new CustomEvent("g-select", { detail: { id: "lane-alpha" }, bubbles: true }));
		return true;
	})()`);
	await waitFor(chrome.cdp, "document.querySelector('g-sheet#lane-sheet') && document.querySelector('g-sheet#lane-sheet').isOpen", "the tapped sheet");
	await sleep(300);
	const sheet = await evaluate<string>(chrome.cdp, `String(document.querySelector("g-sheet#lane-sheet").textContent || "")`);
	assert.match(sheet, /Review ready/, `the sheet names the report's kind in words: ${JSON.stringify(sheet.slice(0, 300))}`);
	assert.match(sheet, /Sent back/, "the sheet names a sent-back handoff in words");
	assert.doesNotMatch(sheet, /review_ready|sent_back|decision_conflict|product_rule/, `the sheet shows a record's own code: ${JSON.stringify(sheet.slice(0, 300))}`);
});

test("the Scrum view reads the work items: a ranked backlog, a board with points per column, a burndown and epics", async () => {
	fixture.setMessages(true);
	fixture.setState(tailnetState());
	await chrome.cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
	await chrome.cdp.send("Page.navigate", { url: `${fixture.base}#scrum` });
	await waitFor(chrome.cdp, "document.querySelector('#scrum-backlog') !== null", "the Scrum view");
	await sleep(600);
	const view = await evaluate<{ backlog: string[]; backlogText: string; columns: string[]; burn: { points: number[]; labels: string[] }; epics: string[]; width: number; viewport: number }>(chrome.cdp, `(() => {
		const text = (node) => String((node && node.textContent) || "").split("  ").join(" ").trim();
		const backlogRows = [...document.querySelectorAll("#scrum-backlog .tk-row")];
		const columns = [...document.querySelectorAll("#scrum-columns .scrum-col")].map((col) => text(col.querySelector("h3")));
		const chart = document.querySelector("#scrum-burn");
		const epics = [...document.querySelectorAll("#scrum-epics .g-hbar, #scrum-epics .g-hb, #scrum-epics [class*=hbar]")].map(text);
		return {
			backlog: backlogRows.map((row) => text(row.querySelector(".t span"))),
			backlogText: text(document.querySelector("#scrum-backlog-sub")),
			columns,
			burn: chart && chart.data ? { points: chart.data.points || [], labels: chart.data.labels || [] } : { points: [], labels: [] },
			epics: epics.length ? epics : [text(document.querySelector("#scrum-epics"))],
			width: document.documentElement.scrollWidth,
			viewport: window.innerWidth,
		};
	})()`);
	assert.equal(view.backlog.length, 1, `the backlog is what no sprint took, and a sprint's story is not in it: ${JSON.stringify(view.backlog)}`);
	assert.match(view.backlogText, /1 story · 3 points/, `the backlog carries its own total: ${view.backlogText}`);
	assert.equal(view.columns.length, 4, `the board shows every column, empty ones included: ${JSON.stringify(view.columns)}`);
	assert.ok(view.columns[0].startsWith("To do"), `the first column is the one to do: ${view.columns[0]}`);
	assert.match(view.columns[0], /0 stories · 0 points/, `an empty column says so rather than disappearing: ${view.columns[0]}`);
	assert.match(view.columns[1], /1 story · 0 points · 1 story has no estimate/, `a held, unestimated story is counted and named: ${view.columns[1]}`);
	assert.match(view.columns[2], /1 story · 2 points/, `the story under way carries its points: ${view.columns[2]}`);
	assert.match(view.columns[3], /1 story · 5 points/, `the done column carries the points that closed: ${view.columns[3]}`);
	assert.deepEqual(view.burn.points, [2, 2, 2], "the burndown counts the sprint's remaining points on each of its own days");
	assert.deepEqual(view.burn.labels, ["10-27", "10-28", "10-29"], "the days come from the records' own event times");
	assert.ok(view.epics.join(" ").includes("1/3 done"), `epics count stories done against promised: ${JSON.stringify(view.epics)}`);
	assert.ok(view.width <= view.viewport, `the Scrum view does not pan sideways: ${view.width} > ${view.viewport}`);
});

