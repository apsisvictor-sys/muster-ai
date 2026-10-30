/**
 * The meter browser's one page surface (UB0 U-1, UD6) and the browser behind it.
 *
 * An adapter never gets a `Page`, a `Browser` or a driver handle. It gets four calls, and nothing
 * else exists to call:
 *
 *  - `goto(path)` walks to one path on the adapter's own origin, and only to a path the adapter
 *    declares in `paths`;
 *  - `text(selector)` and `texts(selector)` read what the page shows;
 *  - `clickTab(name)` opens one tab the adapter declares in `tabs`, and is the only click in the
 *    whole reader (VR24-201: read only, no clicks except tab links).
 *
 * There is deliberately no `fill`, `type`, `press`, `click(selector)` or `evaluate`, so an adapter
 * cannot type into a page, press a key, follow an arbitrary link or run its own script. The test
 * beside this file fails an adapter module that imports a browser driver at all, which is what makes
 * "read only by construction" a property of the build rather than a promise in a comment.
 *
 * The browser is Chrome over the DevTools pipe (`--remote-debugging-pipe`), not a driver library:
 * this repository has no browser dependency (checked: `playwright` resolves nowhere under the
 * profile's `node_modules`), and installing one into the shared profile directory is not a lane's
 * call. The pipe is the same transport a driver uses underneath; the facade is the whole of the API
 * the adapters see, so a later move to Playwright changes this file only.
 *
 * `muster usage login` is the one launch that is not that browser: a plain Chrome window on the same
 * profile, with no pipe and no automation switch, because a sign-in page refuses a browser that
 * announces either (USELOGIN). `openMeterLoginWindow` is that window, and it hands back a process,
 * never a page.
 *
 * The profile is `~/.local/share/pi-meter-browser/profile`, created 0700 and shared by the hourly
 * run, `muster usage refresh --browser` and `muster usage login`, so it holds the operator's logins for
 * the two sites. Nothing here writes, refreshes or prints a credential, and the directory is never
 * deleted: it is his to keep (VR24-201).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── The facade an adapter sees (UD6) ────────────────────────────────────────

/**
 * The whole browser surface an adapter gets. Four calls, no driver handle, no arbitrary selector
 * click and no script of its own (UD6).
 */
export type MeterFacade = {
	/** Walk to one path the site declares, on the site's own origin. */
	goto(path: string): Promise<void>;
	/** The text a selector shows, or null when the page has no such element. */
	text(selector: string): Promise<string | null>;
	/** The text of every element a selector matches, in page order. */
	texts(selector: string): Promise<string[]>;
	/** Open one tab the site declares, by its visible name. False when the page has no such tab. */
	clickTab(name: string): Promise<boolean>;
};

/** One site as an adapter declares it: where it lives, where it may be read, and its tabs. */
export type FacadeSite = {
	/** The site's own name, as it reads in a reason line ("grok.com"). */
	site: string;
	/** The one origin the adapter may read (`https://grok.com`). */
	origin: string;
	/** The paths on that origin the adapter may open. */
	paths: readonly string[];
	/** The tabs the adapter may open, by visible name. */
	tabs: readonly string[];
};

/** The page driver the facade sits on: whatever a browser session can do. */
export type FacadePage = {
	/** Navigate to an absolute URL and resolve when the page has loaded. */
	navigate(url: string): Promise<void>;
	/** Evaluate one expression in the page and return its value. */
	evaluate(expression: string): Promise<unknown>;
};

/** A path the adapter asked for that its own declaration does not allow. A bug, never a live case. */
export class FacadeRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FacadeRefusal";
	}
}

/**
 * The URL one adapter path names, or a refusal when the path is not the site's own.
 *
 * Exported because `muster usage login` opens its window on that URL: the login window's address is the
 * adapter table's too, never anything the command line said (VR24-207 F2).
 */
export function meterSiteUrl(site: FacadeSite, path: string): string {
	let url: URL;
	try {
		url = new URL(path, site.origin);
	} catch {
		throw new FacadeRefusal(`${site.site}: ${JSON.stringify(path)} is not a URL`);
	}
	if (url.origin !== new URL(site.origin).origin) {
		throw new FacadeRefusal(`${site.site}: ${url.href} is not on ${site.origin}`);
	}
	if (!site.paths.includes(url.pathname)) {
		throw new FacadeRefusal(`${site.site}: ${url.pathname} is not one of ${site.paths.join(", ")}`);
	}
	return url.href;
}

/** The expression that reads one selector's text, or null. `innerText` is what a reader sees. */
function textExpression(selector: string): string {
	return `(() => {
		const el = document.querySelector(${JSON.stringify(selector)});
		if (el === null) return null;
		const text = (el.innerText || el.textContent || "").trim();
		return text === "" ? null : text;
	})()`;
}

/** The expression that reads every match's text, in page order. */
function textsExpression(selector: string): string {
	return `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
		.map((el) => (el.innerText || el.textContent || "").trim())
		.filter((text) => text !== "")`;
}

/**
 * The expression that opens one named tab. The name is matched against a link's, button's or tab's
 * own visible text, case and spacing aside, and only when the adapter declared that name.
 */
function clickTabExpression(name: string): string {
	return `(() => {
		const wanted = ${JSON.stringify(name)}.trim().toLowerCase();
		const candidates = Array.from(document.querySelectorAll('a, button, [role="tab"]'));
		const hit = candidates.find((el) => (el.innerText || el.textContent || "").trim().toLowerCase() === wanted);
		if (hit === undefined) return false;
		hit.click();
		return true;
	})()`;
}

/** The facade over one page, for one site's declaration. */
export function createFacade(page: FacadePage, site: FacadeSite): MeterFacade {
	return {
		async goto(path) {
			await page.navigate(meterSiteUrl(site, path));
		},
		async text(selector) {
			const value = await page.evaluate(textExpression(selector));
			return typeof value === "string" ? value : null;
		},
		async texts(selector) {
			const value = await page.evaluate(textsExpression(selector));
			return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
		},
		async clickTab(name) {
			if (!site.tabs.includes(name)) {
				throw new FacadeRefusal(`${site.site}: ${JSON.stringify(name)} is not one of ${site.tabs.join(", ")}`);
			}
			return (await page.evaluate(clickTabExpression(name))) === true;
		},
	};
}

// ─── The browser behind the facade ───────────────────────────────────────────

/** Where the operator's logins live. One profile for the timer, `refresh` and `login` alike. */
export function meterBrowserProfileDir(env: NodeJS.ProcessEnv = process.env): string {
	const base = env["XDG_DATA_HOME"]?.trim() || join(homedir(), ".local", "share");
	return join(base, "pi-meter-browser", "profile");
}

/**
 * The browsers this machine can drive: Chrome when it is installed here, else the Chromium a
 * Playwright-era install left in `~/.cache/ms-playwright`. A machine with neither is a plain error,
 * not a silent skip, because a reader that is not running must say so.
 */
export function resolveChromeBinary(options: { chromePath?: string; cacheRoot?: string } = {}): string {
	const chrome = options.chromePath ?? "/usr/bin/google-chrome";
	if (existsSync(chrome)) return chrome;
	const cache = options.cacheRoot ?? join(homedir(), ".cache", "ms-playwright");
	const candidates = existsSync(cache)
		? readdirSync(cache)
				.filter((name) => name.startsWith("chromium"))
				.sort()
				.reverse()
		: [];
	for (const candidate of candidates) {
		for (const inner of ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-headless-shell-linux64/chrome-headless-shell"]) {
			const path = join(cache, candidate, inner);
			if (existsSync(path)) return path;
		}
	}
	throw new Error(`no Chrome to drive: ${chrome} is absent and ${cache} has no Chromium build`);
}

/** One DevTools-pipe browser: a page driver, its process, and a way to close both. */
export type MeterBrowser = FacadePage & {
	pid: number;
	/** Resolves when the browser process ends. */
	exited: Promise<void>;
	close(): Promise<void>;
};

/** A DevTools message, as the pipe carries it: a reply is matched to its request by `id`. */
type CdpMessage = { id?: number; method?: string; params?: unknown; result?: Record<string, unknown>; error?: { message?: string } };

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** How long one DevTools call may take before it is an error rather than a hang. */
const CDP_CALL_TIMEOUT_MS = 20_000;
/** How long Chrome is given to answer its first call, which includes creating the browser's profile. */
const STARTUP_TIMEOUT_MS = 30_000;
/** How long a page is given to raise its load event after `Page.navigate`. */
const NAVIGATE_TIMEOUT_MS = 30_000;
/** After the load event a page may still paint what it read; this is how long it is left alone. */
const SETTLE_MS = 750;
/**
 * How long a page is given to render content it fetches after the load event, and how little text counts
 * as "nothing rendered yet". Both sites are single-page apps: grok.com's body is one line of chrome
 * until its own script fills it, so a reader that reads at the load event reads an empty page and calls
 * a working site broken.
 */
const CONTENT_WAIT_MS = 10_000;
const CONTENT_MIN_CHARS = 40;

/**
 * The one place a meter Chrome command line is written (USELOGIN).
 *
 * Both modes share the profile and the switches that keep Chrome from asking about a fresh profile.
 * They differ in the two things that decide whether a sign-in page offers to continue with Google:
 *
 *  - `run` is the hourly read: headless, driven over the DevTools pipe the facade is built on;
 *  - `login` is the operator's own window: no `--remote-debugging-*`, no `--headless`, and nothing else that
 *    says "automation", because Chrome's own sign-in answers those switches with "this browser or app
 *    may not be secure" and refuses. The site is Chrome's own argument, so the window opens on the page
 *    without anything navigating it.
 */
export function meterBrowserArgv(launch: { mode: "run"; profileDir: string } | { mode: "login"; profileDir: string; url: string }): string[] {
	const profile = [
		`--user-data-dir=${launch.profileDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--window-size=1280,900",
	];
	if (launch.mode === "login") return [...profile, launch.url];
	return [
		"--headless=new",
		"--remote-debugging-pipe",
		...profile,
		"--disable-gpu",
		"--disable-background-networking",
		"about:blank",
	];
}

/** The spawn a launch uses. A test passes its own, so no Chrome starts (VR21-15). */
export type MeterBrowserSpawn = typeof spawn;

/** One launch's own options: where Chrome is, which profile, and who starts the process. */
type MeterChromeLaunch = { binary?: string; profileDir?: string; spawn?: MeterBrowserSpawn } & (
	| { mode: "run" }
	| { mode: "login"; url: string }
);

/**
 * Start Chrome once, for either mode: the profile is prepared here, and the command line is
 * `meterBrowserArgv`'s, so no second copy of the launch exists to drift from it.
 */
function launchMeterChrome(launch: MeterChromeLaunch): ChildProcess {
	const profileDir = launch.profileDir ?? meterBrowserProfileDir();
	mkdirSync(profileDir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(profileDir, 0o700);
	} catch {
		// A profile on a filesystem without modes is still the operator's login store; the launch continues.
	}
	const argv = launch.mode === "login"
		? meterBrowserArgv({ mode: "login", profileDir, url: launch.url })
		: meterBrowserArgv({ mode: "run", profileDir });
	// The run carries its DevTools messages on two extra pipes (fds 3 and 4); the login window is one plain
	// process whose only content is what Chrome says on stderr.
	const stdio: ("ignore" | "pipe")[] = launch.mode === "run"
		? ["ignore", "ignore", "pipe", "pipe", "pipe"]
		: ["ignore", "ignore", "pipe"];
	const spawner = launch.spawn ?? spawn;
	return spawner(launch.binary ?? resolveChromeBinary(), argv, {
		stdio,
		env: { ...process.env, DISPLAY: process.env["DISPLAY"] ?? "", WAYLAND_DISPLAY: process.env["WAYLAND_DISPLAY"] ?? "" },
	});
}

/**
 * Open Chrome on the DevTools pipe and return the page driver over its first tab.
 *
 * The pipe carries one JSON message per `\0`, so nothing listens on a port, no websocket is opened
 * and the profile is the only thing two runs could share — which the runner's `flock` prevents. This is
 * the read's browser only; the login window is `openMeterLoginWindow`.
 */
export async function openMeterBrowser(options: {
	binary?: string;
	profileDir?: string;
	startupTimeoutMs?: number;
} = {}): Promise<MeterBrowser> {
	const child = launchMeterChrome({
		mode: "run",
		...(options.binary === undefined ? {} : { binary: options.binary }),
		...(options.profileDir === undefined ? {} : { profileDir: options.profileDir }),
	});
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		// Chrome narrates its own startup on stderr; the last lines are what names a failure.
		stderr = `${stderr}${chunk.toString()}`.slice(-4_000);
	});

	const toBrowser = child.stdio[3] as unknown as NodeJS.WritableStream;
	const fromBrowser = child.stdio[4] as unknown as NodeJS.ReadableStream;
	const pending = new Map<number, Pending>();
	let nextId = 1;
	let buffer = "";
	let closed = false;
	let loadWaiter: (() => void) | undefined;

	fromBrowser.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		let at: number;
		while ((at = buffer.indexOf("\0")) !== -1) {
			const raw = buffer.slice(0, at);
			buffer = buffer.slice(at + 1);
			if (raw === "") continue;
			let message: CdpMessage;
			try {
				message = JSON.parse(raw) as CdpMessage;
			} catch {
				continue;
			}
			if (message.method === "Page.loadEventFired") {
				loadWaiter?.();
				continue;
			}
			if (message.id === undefined) continue;
			const waiting = pending.get(message.id);
			if (waiting === undefined) continue;
			pending.delete(message.id);
			clearTimeout(waiting.timer);
			if (message.error !== undefined) waiting.reject(new Error(`DevTools: ${message.error.message ?? "failed"}`));
			else waiting.resolve(message.result ?? {});
		}
	});

	const failAll = (error: Error): void => {
		for (const waiting of pending.values()) {
			clearTimeout(waiting.timer);
			waiting.reject(error);
		}
		pending.clear();
	};
	let markExited: () => void = () => {};
	const exited = new Promise<void>((resolve) => {
		markExited = resolve;
	});
	child.on("exit", (code) => {
		markExited();
		if (closed) return;
		failAll(new Error(`the meter browser exited before the answer (code ${code ?? "signal"})${stderr === "" ? "" : `: ${stderr.split("\n").filter((line) => line.trim() !== "").slice(-1)[0]}`}`));
	});

	const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> => {
		const id = nextId++;
		const message = { id, method, params, ...(sessionId === undefined ? {} : { sessionId }) };
		return new Promise<Record<string, unknown>>((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`DevTools call ${method} did not answer within ${CDP_CALL_TIMEOUT_MS} ms`));
			}, CDP_CALL_TIMEOUT_MS);
			pending.set(id, { resolve, reject, timer });
			try {
				toBrowser.write(`${JSON.stringify(message)}\0`);
			} catch (error) {
				clearTimeout(timer);
				pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	};

	const startupDeadline = Date.now() + (options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);
	const answer = async (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
		const budget = Math.max(1_000, startupDeadline - Date.now());
		let timer: NodeJS.Timeout | undefined;
		try {
			return await Promise.race([
				send(method, params),
				new Promise<Record<string, unknown>>((_, reject) => {
					timer = setTimeout(() => reject(new Error(`the meter browser did not answer ${method} within ${budget} ms${stderr === "" ? "" : `: ${stderr.split("\n").filter((line) => line.trim() !== "").slice(-1)[0]}`}`)), budget);
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	};

	let sessionId: string;
	try {
		await answer("Browser.getVersion");
		const target = await answer("Target.createTarget", { url: "about:blank" });
		const created = target["targetId"];
		if (typeof created !== "string") throw new Error("the meter browser created no tab");
		const attached = await answer("Target.attachToTarget", { targetId: created, flatten: true });
		const id = attached["sessionId"];
		if (typeof id !== "string") throw new Error("the meter browser attached no tab");
		sessionId = id;
		await send("Page.enable", {}, sessionId);
	} catch (error) {
		closed = true;
		child.kill("SIGKILL");
		throw error;
	}

	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		failAll(new Error("the meter browser was closed"));
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, 5_000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
			try {
				toBrowser.end();
			} catch {
				// The pipe is already gone; the wait below still ends the process.
			}
			child.kill("SIGTERM");
		});
	};

	const navigate = async (url: string): Promise<void> => {
		const loaded = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				loadWaiter = undefined;
				reject(new Error(`the page did not load within ${NAVIGATE_TIMEOUT_MS} ms: ${url}`));
			}, NAVIGATE_TIMEOUT_MS);
			loadWaiter = () => {
				clearTimeout(timer);
				loadWaiter = undefined;
				resolve();
			};
		});
		const navigation = await send("Page.navigate", { url }, sessionId);
		const problem = navigation["errorText"];
		if (typeof problem === "string" && problem !== "") {
			loadWaiter = undefined;
			throw new Error(`the page did not open: ${problem}`);
		}
		await loaded;
		// Wait for the page to say something, bounded: a page that stays empty is read as it is, and the adapter
		// says what it found rather than this layer waiting forever.
		const deadline = Date.now() + CONTENT_WAIT_MS;
		while (Date.now() < deadline) {
			const rendered = await send("Runtime.evaluate", { expression: "(document.body?.innerText ?? '').trim().length", returnByValue: true }, sessionId)
				.then((result) => Number((result["result"] as { value?: unknown } | undefined)?.value ?? 0))
				.catch(() => CONTENT_MIN_CHARS);
			if (rendered >= CONTENT_MIN_CHARS) break;
			await new Promise<void>((resolve) => setTimeout(resolve, 250));
		}
		await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS));
	};

	const evaluate = async (expression: string): Promise<unknown> => {
		const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
		const inner = result["result"];
		if (typeof inner !== "object" || inner === null) return undefined;
		const details = inner as { value?: unknown; description?: string };
		return details.value ?? details.description ?? undefined;
	};

	return {
		pid: child.pid ?? -1,
		exited,
		navigate,
		evaluate,
		close,
	};
}

// ─── The login window ────────────────────────────────────────────────────────

/** A login window: Chrome on the meter profile, a window on the desktop, and the operator's hands. */
export type MeterLoginWindow = {
	pid: number;
	/** Resolves when the window closes, which is the operator finishing the login. */
	exited: Promise<void>;
	/** End the window, for the error path: a window the operator already closed is gone and this is a no-op. */
	close(): Promise<void>;
};

/**
 * Open the meter profile in a Chrome window on one site, and hand back the process (USELOGIN).
 *
 * This is `muster usage login`, and it is deliberately not the DevTools browser: no pipe, no automation
 * switch, and the site as Chrome's own argument, so the page offers "Continue with Google" the way it
 * does in a browser the operator opened himself. Nothing here types, clicks, reads or screenshots the page —
 * the login is his hands only (VR24-201) — and the call resolves when he closes the window. The caller
 * holds the meter lock, so a run never shares this profile, and the profile is the same directory the
 * hourly read uses, which is how the login reaches the read at all.
 */
export async function openMeterLoginWindow(options: {
	url: string;
	binary?: string;
	profileDir?: string;
	spawn?: MeterBrowserSpawn;
}): Promise<MeterLoginWindow> {
	const child = launchMeterChrome({
		mode: "login",
		url: options.url,
		...(options.binary === undefined ? {} : { binary: options.binary }),
		...(options.profileDir === undefined ? {} : { profileDir: options.profileDir }),
		...(options.spawn === undefined ? {} : { spawn: options.spawn }),
	});
	// A binary that never started emits `error` and no `exit`, so the start itself is awaited: a window that is
	// not open must reach the caller as a failure, not as a window that closes immediately.
	await new Promise<void>((resolve, reject) => {
		child.once("spawn", () => resolve());
		child.once("error", (error: Error) => reject(error));
	});
	const exited = new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
		// An error after the start leaves no process to wait for; the window is over either way.
		child.once("error", () => resolve());
	});
	let closed = false;
	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		child.kill("SIGTERM");
		await exited;
	};
	return { pid: child.pid ?? -1, exited, close };
}
