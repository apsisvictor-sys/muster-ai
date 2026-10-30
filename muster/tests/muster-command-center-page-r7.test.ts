import "./muster-test-isolation.ts";
/**
 * The command center page on a fixture stream (CRW 3 to 7, Revision 7): a stage change moving its card and
 * nothing else, the change line in the island, a ping-only stream staying online, the phone and the board's own
 * scroll, the four routes and the back gesture, state text never read as markup, and the two kept action paths.
 *
 * It drives the real page file in headless Chrome over CDP against a fixture server it starts itself: no live
 * gateway, no live provider, synthetic names only. The fixture state is exported so the release check
 * (`reports/crw-release-check.md`) serves the very same bytes.
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
import { LANE_STAGES } from "../lane-stage.ts";

const FIXTURES_ONLY = process.env.CRW_FIXTURES_ONLY === "1";
const CHROME = process.env.CC_CHROME ?? "/usr/bin/google-chrome";
const NONCE = "crw-test-nonce";
const TOKEN = "crw-test-token";
const CHROME_PATH = `http://127.0.0.1:`;

// ── The fixture state: the CRH shape, synthetic people and lanes only ────────
const STAGE_LABELS: Record<string, string> = {
	assigning: "Assigning",
	working: "Working",
	verifying: "Verifying",
	"sent-back": "Sent back",
	"waiting-to-merge": "Waiting to merge",
	merged: "Merged"
};
const NOW = Date.parse("2026-10-26T20:00:00.000Z");
const at = (minutesAgo: number): number => NOW - minutesAgo * 60_000;

const laner = (over: Record<string, unknown>) => ({
	laneId: "lane-alpha",
	harness: "pi",
	model: "command-code/deepseek/deepseek-v4.1-flash",
	modelName: "DeepSeek V4.1 Flash",
	title: "Rewrite the intake brief",
	stage: "working",
	alreadyDone: false,
	health: "ok",
	now: "Reading the goal registry",
	goal: "EA",
	station: "build",
	rounds: 0,
	waits: null,
	class: "L",
	taskKind: "page",
	handoffs: [],
	state: "running",
	phase: "working",
	origin: "auto",
	alive: true,
	since: at(18),
	branch: "lane/ea-brief",
	brief: null,
	stalled: false,
	startedAt: at(18),
	report: null,
	leftover: false,
	canStop: false,
	tone: null,
	reason: null,
	...over
});

export const fixtureState = () => ({
	generatedAt: new Date(NOW).toISOString(),
	startedAt: "boot-crw-1",
	stages: LANE_STAGES.map((key) => ({ key, label: STAGE_LABELS[key] })),
	recent: ["EA-1 opened by the architect", "Alpha finished its first pass"],
	summary: {
		data: {
			running: 2,
		readyForReview: 1,
		goals: 1,
		stuck: 1,
			needsYou: { total: 3, decisions: 1, steps: 1, drafts: 1, pc: 0, holdGoals: ["EA"] },
			decidedToday: [{ code: "EA-0", question: "Should the brief lead with the outcome?" }],
			working: { count: 2, byModel: [{ name: "DeepSeek V4.1 Flash", count: 2 }] },
			review: { verifying: 1, waiting: 0, sentBack: 1 },
			shipped: { today: 4, thisHour: 1, perHour: Array.from({ length: 24 }, (_, hour) => (hour < 20 ? (hour % 5 === 0 ? 1 : 0) : 0)) }
		}
	},
	panels: {
		lanes: {
			data: {
				hiddenGone: 0,
				rows: [
					laner({}),
					laner({ laneId: "lane-beta", title: "Check the sums on the offer page", stage: "verifying", startedAt: at(40), since: at(6), now: "Comparing two reports", modelName: "Claude Opus", harness: "claude" }),
					laner({ laneId: "lane-gamma", title: "Wire the calendar to the deal", stage: "sent-back", rounds: 2, tone: "attention", reason: "Stalled for 24 minutes", startedAt: at(90), since: at(24) }),
					laner({ laneId: "lane-delta", title: "Ship the copy pass", stage: "merged", startedAt: at(200), since: at(120), origin: "auto" }),
					laner({ laneId: "lane-omega", title: "Look into the cache numbers", goal: null, station: null, stage: "assigning", startedAt: at(4), since: at(4) }),
					laner({ laneId: "lane-operator", title: "the operator's own session", origin: "operator", stage: "working" }),
					laner({ laneId: "lane-seat", title: "The architect's session", origin: "auto", stage: "working" })
				]
			}
		},
		machine: {
			data: {
				gate: { wouldAdmit: true, reason: "Room for a heavy job", psi: 0.1, availableMb: 9216, sliceUsedPct: 42, paused: false, devServerWindow: "" },
				tone: null,
				kills: []
			}
		},
		decisions: {
			data: {
				settledToday: [],
				tickets: [
					{
						id: "ask-0001",
						code: "EA-1",
						kind: "product-decision",
						question: "Should the intake brief lead with the outcome?",
						owner: "architect",
						raisedBy: "lane-alpha",
						raisedAt: new Date(at(30)).toISOString(),
						ageMs: 30 * 60_000,
						stale: false,
						blocks: ["EA"],
						options: ["Lead with the outcome", "Lead with the constraint"],
						recommendation: "Lead with the outcome",
						status: "open",
						answerOnCard: false,
						sitting: false,
						recommended: "Lead with the outcome",
						version: "v1"
					},
					{
						id: "ask-0002",
						code: "EA-2",
						kind: "human-login",
						question: "Confirm the bank feed on your phone",
						owner: "operator",
						raisedBy: "lane-beta",
						raisedAt: new Date(at(50)).toISOString(),
						ageMs: 50 * 60_000,
						stale: false,
						blocks: [],
						options: [],
						recommendation: null,
						status: "open",
						answerOnCard: false,
						sitting: true,
						recommended: null,
						version: "v1"
					}
				]
			}
		},
		goals: {
			data: {
				sideTrack: ["lane-omega"],
				groups: [
					{
						project: "web-app",
						title: "Webapp Center",
						goals: [
							{
								code: "EA",
								name: "One intake brief the client signs",
								sub: "The brief the architect sends is the one the client signs.",
								colour: "blue",
								project: "web-app",
								stations: [
									{ id: "brief", name: "Brief", done: true, now: false, owner: "architect", timer: null },
									{ id: "build", name: "Build", done: false, now: true, owner: "lane-alpha", timer: null },
									{ id: "sign", name: "Sign-off", done: false, now: false, owner: null, timer: null }
								],
								trains: [],
								lanes: ["lane-alpha", "lane-beta", "lane-gamma", "lane-delta"],
								waitsOn: ["ask-0001"]
							}
						]
					}
				]
			}
		},
		team: {
			data: {
				members: [
					{ role: "architect", held: true, lane: "lane-seat", harness: "claude", model: "Opus", state: "Thinking", line: "Reading the decision record", lineAt: NOW, lastActiveAt: NOW },
					{ role: "henry", held: true, lane: null, harness: null, model: null, state: "Waiting", line: null, lineAt: null, lastActiveAt: null }
				]
			}
		},
		shipped: {
			data: {
				items: [
					{ at: new Date(at(20)).toISOString(), kind: "merge", text: "Merged lane/ea-copy", sha: "abcdef1234567", goal: "EA", title: "Ship the copy pass" }
				]
			}
		},
		next: { data: { items: [{ when: "21:00", kind: "timer", text: "Nightly drift check", who: "systemd" }] } },
		ideas: {
			data: {
				late: false,
				cards: [
					{
						id: "idea-1",
						title: "Prompt caching across subagents",
						source: "x:someone",
						sourceName: "@someone on X",
						url: "https://example.test/post",
						verdict: "signal",
						sentences: "A shared prefix reads at a tenth of the price.",
						version: "7",
						taps: [],
						hasReport: false
					}
				]
			}
		},
		activity: { data: { "lane-alpha": { lastMessage: "reading the registry", lastActivityMs: NOW, contextPercent: 38 } } },
		usage: {
			data: {
				capturedAt: NOW - 4 * 60_000,
				rows: [
					{
						provider: "command-code",
						label: "DeepSeek",
						kind: "subscription",
						plan: { name: "Pro", monthlyUsd: 20 },
						quotaState: "ok",
						windows: [
							{ usedPercent: 42, windowMinutes: 300, resetsAt: NOW + 3600_000 },
							{ usedPercent: 61, windowMinutes: 10080, resetsAt: NOW + 86400_000 }
						],
						ageMs: 240_000,
						source: "monitor",
						walls: [],
						router: {}
					},
					{
						provider: "xai",
						label: "Grok",
						kind: "subscription",
						plan: { name: "Max", monthlyUsd: 30 },
						quotaState: "ok",
						windows: [{ usedPercent: 12, windowMinutes: 1440, resetsAt: NOW + 7200_000 }],
						ageMs: 240_000,
						source: "monitor",
						walls: [],
						router: {}
					}
				]
			}
		},
		history: {
			data: {
				skipped: 0,
				ranges: [
					{
						range: "today",
						// Nine merges across a working day, as the record's own hours would read: busy around midday, quiet at night.
						merges: Array.from({ length: 24 }, (_, hour) => ({ at: at(20 * 60 - hour * 60), count: [0, 0, 1, 0, 1, 2, 1, 1, 0, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0][hour] ?? 0 })),
						lanes: 9,
						byModel: [
							{ name: "DeepSeek V4.1 Flash", lanes: 6, rounds: 5, sentBack: 2 },
							{ name: "Claude Opus", lanes: 3, rounds: 1, sentBack: 0 }
						],
						byGoal: [{ code: "EA", lanes: 7 }, { code: null, lanes: 2 }],
						medianLaunchToMergeMs: 2.4 * 3600_000
					},
					{ range: "7d", merges: [], lanes: 0, byModel: [], byGoal: [], medianLaunchToMergeMs: null },
					{ range: "30d", merges: [], lanes: 0, byModel: [], byGoal: [], medianLaunchToMergeMs: null }
				]
			}
		},
		messages: { data: { counts: { draftsWaiting: 1, needYou: 1 } } }
	}
});

/** The panels frame the live hub sends when a lane changes stage: one row, one change line. */
export const fixtureStageFrame = () => ({
	generatedAt: new Date(NOW + 60_000).toISOString(),
	startedAt: "boot-crw-1",
	panels: {
		lanes: {
			data: {
				hiddenGone: 0,
				rows: [
					laner({ stage: "verifying", since: at(0), now: "Comparing the two briefs" }),
					laner({ laneId: "lane-beta", title: "Check the sums on the offer page", stage: "verifying", startedAt: at(40), since: at(6), now: "Comparing two reports", modelName: "Claude Opus", harness: "claude" }),
					laner({ laneId: "lane-gamma", title: "Wire the calendar to the deal", stage: "sent-back", rounds: 2, tone: "attention", reason: "Stalled for 24 minutes", startedAt: at(90), since: at(24) }),
					laner({ laneId: "lane-delta", title: "Ship the copy pass", stage: "merged", startedAt: at(200), since: at(120) }),
					laner({ laneId: "lane-omega", title: "Look into the cache numbers", goal: null, station: null, stage: "assigning", startedAt: at(4), since: at(4) }),
					laner({ laneId: "lane-operator", title: "the operator's own session", origin: "operator", stage: "working" }),
					laner({ laneId: "lane-seat", title: "The architect's session", origin: "auto", stage: "working" })
				]
			}
		}
	},
	changes: ["Alpha moved to Verifying"]
});

// ── The fixture server: the page, the vendored library, the state and the stream ──
type Fixture = {
	server: Server;
	port: number;
	base: string;
	frames: string[];
	send: (event: string, data: unknown) => void;
	acts: Array<Record<string, unknown>>;
	stateRequests: () => number;
	setState: (next: unknown) => void;
	close: () => Promise<void>;
};

async function startFixture(): Promise<Fixture> {
	const page = commandCenterPageHtml(readFileSync(commandCenterPageFile(), "utf8"), TOKEN, NONCE);
	const assets = commandCenterAssetsDir();
	const streams = new Set<ServerResponse>();
	const acts: Array<Record<string, unknown>> = [];
	const frames: string[] = [];
	let state: unknown = fixtureState();
	let stateRequests = 0;
	const send = (event: string, data: unknown): void => {
		frames.push(event);
		const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
		for (const stream of streams) stream.write(payload);
	};
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const path = url.pathname;
		if (path === "/" || path === "/cc/" || path === "/cc") {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": commandCenterCsp(NONCE), "cache-control": "no-store" });
			response.end(page);
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
			streams.add(response);
			request.on("close", () => { streams.delete(response); });
			return;
		}
		if (path === "/cc/api/state") {
			stateRequests += 1;
			response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
			response.end(JSON.stringify(state));
			return;
		}
		if (path === "/cc/api/messages") {
			// The tailnet listener's own answer (MG7). The PC listener answers 404 and the page then shows the counts
			// only, which is the same request the Revision 6 page made: kept as it was, and not this lane's to change.
			response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
			response.end(JSON.stringify({
				panel: {
					strip: { tone: "ok", text: "The phone link is up" },
					counts: { draftsWaiting: 1, needYou: 1 },
					history: true,
					empty: null,
					rows: [{ thread: "thread-1", name: "Ana Petrova", channel: "whatsapp", state: "draft", line: "Draft ready", preview: "Can we move it to Thursday?", waitingSince: new Date(at(9)).toISOString(), draftId: "draft-1" }]
				}
			}));
			return;
		}
		if (path === "/cc/api/feed") {
			response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
			response.end(JSON.stringify({ messages: [{ at: new Date(at(3)).toISOString(), text: "Opened the brief" }, { at: new Date(at(2)).toISOString(), text: "Reading the registry" }], more: false }));
			return;
		}
		if (path === "/cc/api/report") {
			response.writeHead(404);
			response.end("no");
			return;
		}
		if (path.startsWith("/cc/api/act") && request.method === "POST") {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				let body: Record<string, unknown> = {};
				try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; } catch { body = {}; }
				acts.push(body);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ ok: true }));
			});
			return;
		}
		response.writeHead(404, { "content-type": "text/plain" });
		response.end("no");
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const port = (server.address() as AddressInfo).port;
	return {
		server,
		port,
		base: `${CHROME_PATH}${port}/cc/`,
		frames,
		send,
		acts,
		stateRequests: () => stateRequests,
		setState: (next: unknown) => { state = next; },
		close: async () => {
			for (const stream of streams) stream.end();
			streams.clear();
			// A keep-alive socket would otherwise hold the event loop after the last test.
			server.closeAllConnections();
			await new Promise<void>((done) => server.close(() => done()));
		}
	};
}

// ── Headless Chrome over CDP, the same transport the QA runs use ─────────────
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
	const profile = mkdtempSync(join(tmpdir(), "crw-r7-profile-"));
	// Its own process group, so the teardown's one signal reaches the helpers Chrome starts as well: they
	// share `--user-data-dir`, and a writer that outlives the browser is what makes the removal race.
	const child = spawn(CHROME, [
		"--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
		"--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars",
		"--disable-extensions", "--disable-background-networking", "--force-device-scale-factor=1",
		"--no-sandbox", "about:blank"
	], { stdio: "ignore", detached: true });
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
				const listeners = new Map<string, Array<(params: any) => void>>();
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

/**
 * Stop the browser and remove its profile once nothing writes into it any more.
 *
 * Chrome keeps its profile open for as long as the process lives, and the helpers it starts (GPU, renderer,
 * network service) share `--user-data-dir`, so removing the tree straight after a signal to the browser alone
 * raced a live writer: `rmSync` walked a directory that was being refilled and failed with ENOTEMPTY, which is
 * how this file went red twice on CI. The browser leads its own process group, so one signal reaches every
 * writer; the removal then retries inside one bounded budget and still reports the error if the tree cannot go.
 */
async function stopChrome(chrome: { child: ChildProcess; profile: string }): Promise<void> {
	// A process killed by a signal keeps `exitCode === null`, so the exit is tracked by the event, not the code.
	const exited = chrome.child.exitCode !== null || chrome.child.signalCode !== null
		? Promise.resolve()
		: new Promise<void>((done) => chrome.child.once("exit", () => done()));
	try { process.kill(-chrome.child.pid!, "SIGKILL"); } catch { /* the group is already gone */ }
	await exited;
	const deadline = Date.now() + 10_000;
	for (;;) {
		try {
			rmSync(chrome.profile, { recursive: true, force: true });
			return;
		} catch (error) {
			if (Date.now() >= deadline) throw error;
			await sleep(100);
		}
	}
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
let navigations = 0;

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

async function openPage(cdp: Cdp, base: string, hash = ""): Promise<void> {
	// A fragment-only navigation would keep the old document (and its old fixture state), so it is a reload.
	// Always a fresh document, and always the hash this test asked for: a same-document jump would keep the
	// fixture state (and the route) the previous test left behind.
	navigations += 1;
	const navigated = await cdp.send("Page.navigate", { url: `${base}?r=${navigations}${hash}` });
	try {
		await waitFor(cdp, "document.readyState === 'complete' && document.querySelector('#view .view') !== null", "the first paint");
	} catch (error) {
		// A failed paint names what the browser actually has, so a refused load is not read as a slow one.
		const snapshot = await evaluate<string>(cdp, `JSON.stringify({ href: location.href, ready: document.readyState, view: Boolean(document.querySelector("#view .view")), body: document.body ? document.body.innerHTML.length : -1, errors: (window.__crwErrors || []).slice(-3) })`).catch(() => "unreadable");
		throw new Error(`${String(error)} while opening ${base + hash}: navigate=${JSON.stringify(navigated)} page=${snapshot}`);
	}
	await sleep(250);
}

if (!FIXTURES_ONLY) {
	let fixture: Fixture;
	let chrome: { child: ChildProcess; cdp: Cdp; profile: string };
	const consoleErrors: string[] = [];

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
		await chrome.cdp.send("Page.enable");
		await chrome.cdp.send("Runtime.enable");
		await chrome.cdp.send("Log.enable");
		await chrome.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
		// Keep the page's own errors, so a failure can name them instead of only timing out.
		await chrome.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__crwErrors = []; window.addEventListener('error', (event) => window.__crwErrors.push(String(event.message)));" });
		console.log(`[crw] fixture on ${fixture.base}`);
	});

	after(async () => {
		chrome?.cdp.close();
		if (chrome) await stopChrome(chrome);
		if (fixture) await fixture.close();
		assert.deepEqual(consoleErrors, [], "the page logged no error");
	});

	test("CRW 3: a stage change moves its card, tweens the counts and shows one change line", { timeout: 120000 }, async () => {
		fixture.setState(fixtureState());
		await openPage(chrome.cdp, fixture.base, "#pipeline");
		await waitFor(chrome.cdp, "document.querySelectorAll('#pipeline-board .g-card').length > 0", "the board's cards");
		const before = await evaluate<{ column: string | null; cards: number; big: string | null }>(chrome.cdp, `(() => {
			const card = document.querySelector('#pipeline-board .g-card[data-id="lane-alpha"]');
			const column = card ? card.closest('.g-col') : null;
			return {
				column: column ? column.getAttribute('data-key') : null,
				cards: document.querySelectorAll('#pipeline-board .g-card').length,
				big: document.querySelector('#kpi-needs .g-kpi-big')?.textContent ?? null
			};
		})()`);
		assert.ok(before.cards >= 4, `the board painted its lanes: ${before.cards}`);
		const startedColumn = before.column;

		// The sniffer records which elements animate while the frame lands, so "one animation" is measured, not assumed.
		await evaluate(chrome.cdp, `(() => {
			window.__crwAnimated = [];
			const seen = new Set();
			window.__crwSniff = setInterval(() => {
				for (const animation of document.getAnimations()) {
					const target = animation.effect && animation.effect.target;
					if (!target || !target.getAttribute) continue;
					const lane = target.getAttribute('data-id');
					const label = lane || target.className || target.tagName;
					const key = label + '|' + (animation.animationName || animation.transitionProperty || 'anim');
					if (seen.has(key)) continue;
					seen.add(key);
					window.__crwAnimated.push({ label, lane, cls: String(target.className || '') });
				}
			}, 30);
			return true;
		})()`);

		fixture.send("panels", fixtureStageFrame());
		await waitFor(chrome.cdp, "document.querySelector('#island .g-island-line') && document.querySelector('#island .g-island-line').textContent.includes('Alpha moved to Verifying')", "the island's change line");
		await sleep(1600);
		const after = await evaluate<{ column: string | null; animated: Array<{ label: string; lane: string | null; cls: string }> }>(chrome.cdp, `(() => {
			clearInterval(window.__crwSniff);
			const card = document.querySelector('#pipeline-board .g-card[data-id="lane-alpha"]');
			return {
				column: card && card.closest('.g-col') ? card.closest('.g-col').getAttribute('data-key') : null,
				animated: window.__crwAnimated
			};
		})()`);
		assert.notEqual(after.column, startedColumn, `the card left its column: ${startedColumn} -> ${after.column}`);
		assert.equal(after.column, LANE_STAGES[2], "the card sits in the column the frame named");
		const cards = after.animated.filter((entry) => entry.cls.includes("g-card"));
		assert.ok(cards.some((entry) => entry.lane === "lane-alpha"), `the moved card animated: ${JSON.stringify(after.animated)}`);
		// No idle churn: an animation may target a card of the board or the KPI numbers the frame changed, and nothing else.
		const stray = after.animated.filter((entry) => !/g-card|g-kpi-big|g-col-n|g-mix|g-hourbars|g-ring/.test(entry.cls));
		assert.deepEqual(stray, [], `nothing outside the board and the counts animated: ${JSON.stringify(stray)}`);
	});

	test("CRW 3: the change line clears itself, and a ping alone changes nothing", { timeout: 60000 }, async () => {
		await sleep(4200);
		const line = await evaluate<string>(chrome.cdp, "document.querySelector('#island .g-island-line')?.textContent ?? ''");
		assert.equal(line.includes("Alpha moved to Verifying"), false, "the change line cleared itself");
		assert.match(line, /working|Offline/, `the island went back to its own line: "${line}"`);
		const before = await evaluate<string>(chrome.cdp, "document.querySelector('#pipeline-board').innerHTML.length.toString()");
		fixture.send("ping", { at: new Date().toISOString() });
		await sleep(600);
		const after = await evaluate<string>(chrome.cdp, "document.querySelector('#pipeline-board').innerHTML.length.toString()");
		assert.equal(after, before, "a ping repainted nothing");
	});

	test("CRW 4: a ping keeps the stream online, and 60 s without a frame shows offline and starts the poll", { timeout: 220000 }, async () => {
		fixture.setState(fixtureState());
		await openPage(chrome.cdp, fixture.base, "#today");
		await waitFor(chrome.cdp, "document.querySelector('#island .g-island-line') !== null", "the island");
		// Q5: the offline timer counts every frame, a ping included. Only pings arrive for 65 s.
		const pings = setInterval(() => fixture.send("ping", { at: new Date().toISOString() }), 10000);
		let everOffline = false;
		const watch = setInterval(async () => {
			try {
				if (await evaluate<boolean>(chrome.cdp, "document.querySelector('#island').hasAttribute('offline')")) everOffline = true;
			} catch { /* the page is closing */ }
		}, 1000);
		await sleep(65000);
		clearInterval(pings);
		clearInterval(watch);
		assert.equal(everOffline, false, "a ping-only stream stays online past the 60 s mark");
		assert.equal(await evaluate<boolean>(chrome.cdp, "document.querySelector('#island').hasAttribute('offline')"), false, "online at 65 s");

		// Now nothing arrives at all: 60 s later the island says offline and the 10 s poll starts.
		const before = fixture.stateRequests();
		await sleep(62000);
		const offline = await evaluate<boolean>(chrome.cdp, "document.querySelector('#island').hasAttribute('offline')");
		assert.equal(offline, true, "the island shows offline after 60 s of silence");
		const banner = await evaluate<string>(chrome.cdp, "document.querySelector('#banner')?.hidden === false ? document.querySelector('#banner-text').textContent : ''");
		assert.match(banner, /Can't reach the gateway/, `the banner says so: "${banner}"`);
		await sleep(12000);
		assert.ok(fixture.stateRequests() > before, `the poll asked for the state again: ${before} -> ${fixture.stateRequests()}`);
	});

	test("CRW 5: the phone never scrolls sideways", { timeout: 60000 }, async () => {
		await chrome.cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
		await openPage(chrome.cdp, fixture.base, "#goal/EA");
		await waitFor(chrome.cdp, "document.querySelector('#goal-board .g-card') !== null", "the goal board");
		const phone = await evaluate<{ page: number; viewport: number; boardScrolls: boolean }>(chrome.cdp, `(() => {
			const board = document.querySelector('#goal-board .g-board');
			return {
				page: document.scrollingElement.scrollWidth,
				viewport: window.innerWidth,
				boardScrolls: board ? board.scrollWidth > board.clientWidth + 1 : false
			};
		})()`);
		assert.ok(phone.page <= phone.viewport + 1, `the page is not wider than the phone: ${phone.page} <= ${phone.viewport}`);
		assert.equal(phone.boardScrolls, true, "the board is the part that scrolls on a phone");
		// A 300-character lane title stays inside its card and never widens the page.
		const long = "A".repeat(120) + " " + "B".repeat(120) + " " + "C".repeat(60);
		fixture.setState({ ...fixtureState(), panels: { ...fixtureState().panels, lanes: { data: { hiddenGone: 0, rows: [laner({ title: long })] } } } });
		await openPage(chrome.cdp, fixture.base, "#goal/EA");
		await sleep(400);
		const wide = await evaluate<{ page: number; viewport: number; cardWidth: number; columnWidth: number }>(chrome.cdp, `(() => {
			const card = document.querySelector('#goal-board .g-card');
			const column = card ? card.closest('.g-col') : null;
			return {
				page: document.scrollingElement.scrollWidth,
				viewport: window.innerWidth,
				cardWidth: card ? Math.round(card.getBoundingClientRect().width) : 0,
				columnWidth: column ? Math.round(column.getBoundingClientRect().width) : 0
			};
		})()`);
		assert.ok(wide.page <= wide.viewport + 1, `a long title does not widen the page: ${wide.page} <= ${wide.viewport}`);
		assert.ok(wide.cardWidth <= wide.columnWidth + 1, `the card stays inside its column: ${wide.cardWidth} <= ${wide.columnWidth}`);
	});

	test("CRW 5: between 761 and 1218 px the board scrolls inside its own box and the page does not", { timeout: 60000 }, async () => {
		for (const width of [1024, 1200]) {
			await chrome.cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
			await openPage(chrome.cdp, fixture.base, "#pipeline");
			await waitFor(chrome.cdp, "document.querySelector('#pipeline-board .g-card') !== null", "the pipeline board");
			const box = await evaluate<{ page: number; viewport: number; board: number; client: number }>(chrome.cdp, `(() => {
				const board = document.querySelector('#pipeline-board .g-board');
				return { page: document.scrollingElement.scrollWidth, viewport: window.innerWidth, board: board.scrollWidth, client: board.clientWidth };
			})()`);
			assert.ok(box.page <= box.viewport + 1, `at ${width} the page does not scroll sideways: ${box.page} <= ${box.viewport}`);
			assert.ok(box.board > box.client, `at ${width} the board scrolls inside its own box: ${box.board} > ${box.client}`);
		}
		await chrome.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
	});

	test("CRW 7: every view opens from its hash, and the back gesture closes the sheet first", { timeout: 60000 }, async () => {
		fixture.setState(fixtureState());
		await openPage(chrome.cdp, fixture.base, "#history");
		await waitFor(chrome.cdp, "document.querySelector('#history-merges .g-chart-svg') !== null || document.querySelector('#history-merges svg') !== null", "the history chart");
		const history = await evaluate<{ title: string; nav: string | null }>(chrome.cdp, `(() => ({
			title: document.querySelector('.title span')?.textContent ?? '',
			nav: document.querySelector('#nav [aria-selected="true"]')?.textContent ?? null
		}))()`);
		assert.equal(history.title, "History");

		await openPage(chrome.cdp, fixture.base, "#goal/EA");
		await waitFor(chrome.cdp, "document.querySelector('#goal-hero h1') !== null", "the goal hero");
		const hero = await evaluate<string>(chrome.cdp, "document.querySelector('#goal-hero h1').textContent");
		assert.equal(hero, "One intake brief the client signs");

		// A load never opens a lane sheet (the operator, 2026-10-29), so the route is reached the way a person reaches it —
		// a tap on the lane. The back gesture below is what CRW 7 pins, and it is unchanged.
		await openPage(chrome.cdp, fixture.base, "#pipeline");
		await waitFor(chrome.cdp, "document.querySelector('g-board') !== null", "the pipeline board");
		await evaluate(chrome.cdp, `(() => {
			document.querySelector('g-board').dispatchEvent(new CustomEvent('g-select', { detail: { id: "lane-alpha" }, bubbles: true }));
			return true;
		})()`);
		await waitFor(chrome.cdp, "document.querySelector('#lane-sheet').hasAttribute('open')", "the lane sheet");
		const sheet = await evaluate<{ open: boolean; title: string; facts: number }>(chrome.cdp, `(() => ({
			open: document.querySelector('#lane-sheet').hasAttribute('open'),
			title: document.querySelector('#lane-sheet .g-sheet-title')?.textContent ?? '',
			facts: document.querySelectorAll('#lane-sheet .g-fact').length
		}))()`);
		assert.equal(sheet.open, true, "the lane sheet opened from its own hash");
		assert.equal(sheet.title, "Rewrite the intake brief");
		assert.ok(sheet.facts >= 4, `the sheet names the lane's facts: ${sheet.facts}`);

		// The back gesture closes the sheet and leaves the view beneath it alone.
		await evaluate(chrome.cdp, "history.back(); true");
		await sleep(500);
		const afterBack = await evaluate<{ open: boolean; hash: string; title: string }>(chrome.cdp, `(() => ({
			open: document.querySelector('#lane-sheet').hasAttribute('open'),
			hash: location.hash,
			title: document.querySelector('.title span')?.textContent ?? ''
		}))()`);
		assert.equal(afterBack.open, false, "the back gesture closed the sheet");
		assert.notEqual(afterBack.hash, "#lane/lane-alpha", "the route is no longer the sheet's");
	});

	test("CRW 2: state text is read as text, never as markup", { timeout: 60000 }, async () => {
		const injected = '<img src="x" onerror="window.__crwPwned=1"> and <b>bold</b>';
		const state = fixtureState();
		state.panels.decisions.data.tickets[0].question = injected;
		state.panels.goals.data.groups[0].goals[0].name = injected;
		state.panels.lanes.data.rows[0].title = injected;
		fixture.setState(state);
		await openPage(chrome.cdp, fixture.base, "#today");
		await waitFor(chrome.cdp, "document.querySelector('#tickets .tk-row .t') !== null", "the tickets");
		const read = await evaluate<{ images: number; fired: boolean; text: string }>(chrome.cdp, `(() => ({
			images: document.querySelectorAll('#view img').length,
			fired: window.__crwPwned === 1,
			text: document.querySelector('#tickets .tk-row .t').textContent
		}))()`);
		assert.equal(read.images, 0, "no image element was built from the state");
		assert.equal(read.fired, false, "the injected handler never ran");
		assert.equal(read.text.includes("<img"), true, "the question reads as literal text");
	});

	test("CRW 1: an answer is held six seconds with Undo, and Undo posts nothing", { timeout: 90000 }, async () => {
		fixture.setState(fixtureState());
		await openPage(chrome.cdp, fixture.base, "#today");
		await waitFor(chrome.cdp, "document.querySelector('#tickets .tk-row') !== null", "the first ticket");
		await evaluate(chrome.cdp, `(() => { document.querySelector('#tickets .tk-row').click(); return true; })()`);
		await waitFor(chrome.cdp, "document.querySelector('#tickets textarea') !== null", "the ticket's words box");
		await evaluate(chrome.cdp, `(() => {
			const box = document.querySelector('#tickets textarea');
			box.value = 'Lead with the outcome';
			box.dispatchEvent(new Event('input', { bubbles: true }));
			document.querySelector('[id^="send-"]').click();
			return true;
		})()`);
		await waitFor(chrome.cdp, "document.querySelector('#tickets .answered') !== null", "the hold");
		await evaluate(chrome.cdp, `(() => { document.querySelector('#tickets .answered button').click(); return true; })()`);
		await sleep(7000);
		assert.equal(fixture.acts.length, 0, "Undo posted nothing");
		const back = await evaluate<boolean>(chrome.cdp, "document.querySelector('#tickets textarea') !== null && document.querySelector('#tickets textarea').value === 'Lead with the outcome'");
		assert.equal(back, true, "the words are back in their box");

		// The same answer without Undo reaches the gateway once, with the ticket's own version.
		await evaluate(chrome.cdp, `(() => { document.querySelector('[id^="send-"]').click(); return true; })()`);
		await sleep(7000);
		assert.equal(fixture.acts.length, 1, `one POST after the hold: ${JSON.stringify(fixture.acts)}`);
		assert.equal(fixture.acts[0].action, "answer");
		assert.equal(fixture.acts[0].id, "ask-0001");
		assert.equal(fixture.acts[0].version, "v1");
		assert.equal(fixture.acts[0].words, "Lead with the outcome");
	});

	test("CRW 1: an answer still inside its hold when the page hides is sent, with keepalive", { timeout: 60000 }, async () => {
		fixture.setState(fixtureState());
		const before = fixture.acts.filter((act) => act.action === "answer").length;
		await openPage(chrome.cdp, fixture.base, "#today");
		await waitFor(chrome.cdp, "document.querySelector('#tickets .tk-row') !== null", "the first ticket");
		await evaluate(chrome.cdp, "(() => { document.querySelector('#tickets .tk-row').click(); return true; })()");
		await waitFor(chrome.cdp, "document.querySelector('#tickets textarea') !== null", "the ticket's words box");
		await evaluate(chrome.cdp, `(() => {
			const box = document.querySelector('#tickets textarea');
			box.value = 'Lead with the outcome';
			box.dispatchEvent(new Event('input', { bubbles: true }));
			document.querySelector('[id^="send-"]').click();
			return true;
		})()`);
		await waitFor(chrome.cdp, "document.querySelector('#tickets .answered') !== null", "the six-second hold");
		// Revision 6 flushed a tap held at pagehide with keepalive. The spy records the options the page used.
		await evaluate(chrome.cdp, `(() => {
			window.__crwPosts = [];
			const original = window.fetch;
			window.fetch = (url, options) => {
				if (String(url).includes('/cc/api/act')) window.__crwPosts.push({ keepalive: Boolean(options && options.keepalive), body: String((options && options.body) || '') });
				return original(url, options);
			};
			window.dispatchEvent(new Event('pagehide'));
			return true;
		})()`);
		await sleep(900);
		const posts = await evaluate<Array<{ keepalive: boolean; body: string }>>(chrome.cdp, "window.__crwPosts || []");
		assert.equal(posts.length, 1, `the held answer was flushed once: ${JSON.stringify(posts)}`);
		assert.equal(posts[0]!.keepalive, true, "the flush carries keepalive, so a hiding tab does not drop it");
		const body = JSON.parse(posts[0]!.body) as Record<string, unknown>;
		assert.equal(body.action, "answer");
		assert.equal(body.id, "ask-0001");
		assert.equal(body.version, "v1");
		assert.equal(body.words, "Lead with the outcome");
		await sleep(500);
		assert.equal(fixture.acts.filter((act) => act.action === "answer").length, before + 1, "it reached the gateway exactly once");
	});

	test("CRW 1: the message box posts the words to the target you picked", { timeout: 60000 }, async () => {
		await openPage(chrome.cdp, fixture.base, "#today");
		await waitFor(chrome.cdp, "document.querySelector('#open-msg') !== null", "the message button");
		await evaluate(chrome.cdp, "document.querySelector('#open-msg').click(); true");
		await waitFor(chrome.cdp, "document.querySelector('#cmp-msg') !== null", "the message box");
		await evaluate(chrome.cdp, `(() => {
			const box = document.querySelector('#cmp-msg');
			box.value = 'Try the shorter brief';
			box.dispatchEvent(new Event('input', { bubbles: true }));
			document.querySelector('#cmp-send').click();
			return true;
		})()`);
		await waitFor(chrome.cdp, "!document.querySelector('#dialog-wrap') || document.querySelector('#dialog-wrap').hidden", "the box closing");
		const sent = fixture.acts.filter((act) => act.action === "message");
		assert.equal(sent.length, 1, `one message POST: ${JSON.stringify(fixture.acts)}`);
		assert.equal(sent[0].text, "Try the shorter brief");
		assert.equal(sent[0].to, "architect");
	});
}

// Kept for the release check: the same fixtures, served by its own script.
export const CRW_FIXTURE_PORT_HELP = "run with CRW_FIXTURES_ONLY=1 to import the fixtures without running the browser tests";
