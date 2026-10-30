import "./muster-test-isolation.ts";
/**
 * USELOGIN: the meter browser's login window is the operator's own Chrome, and the hourly read stays the pipe.
 *
 * The bug (design session report, 2026-10-28): `muster usage login` opened the profile with
 * `--remote-debugging-pipe`, and a sign-in page answers that with "Couldn't sign you in. This browser or
 * app may not be secure", so "Continue with Google" was never offered on grok.com or
 * platform.openai.com.
 *
 * What is proved here, with no browser at all (VR21-15: the spawner is injected and the command line is
 * read as data, so no Chrome starts and no login is attempted):
 *
 *  1. the login window's command line carries no `--remote-debugging-*`, no `--headless` and no other
 *     switch that announces automation, and carries the site as Chrome's own argument;
 *  2. the hourly run's command line still carries `--remote-debugging-pipe` and is headless, on the same
 *     profile;
 *  3. `openMeterLoginWindow` starts one plain process — three stdio channels, never the run's two extra
 *     pipe fds — and its `exited` ends when the process does;
 *  4. the meter lock answers "busy" while a run holds it, and the `login` verb refuses with that answer
 *     and opens no window: a login never runs beside a run;
 *  5. the `login` verb asks the facade for the site's own URL, so the window opens on the adapter's page.
 *
 * OS temp directories only: no browser, no network, no profile, no spawn of Chrome.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { meterSiteFor } from "../meter-browser/adapters/index.ts";
import { meterBrowserArgv, openMeterLoginWindow, type MeterBrowserSpawn } from "../meter-browser/facade.ts";
import { meterLockPath } from "../meter-browser/last-run.ts";
import { withMeterLock } from "../meter-browser/runner.ts";
import { runUsageCommand } from "../cli/usage.ts";
import type { CliContext } from "../cli/types.ts";

/** The switches that make a browser announce itself; a login window may carry none of them. */
const AUTOMATION_SWITCHES = ["--remote-debugging", "--headless", "--enable-automation", "--test-type", "--auto-open-devtools"];

/** Whether one command-line argument announces automation, in any of its spellings. */
function announcesAutomation(argument: string): boolean {
	return AUTOMATION_SWITCHES.some((prefix) => argument === prefix || argument.startsWith(`${prefix}-`) || argument.startsWith(`${prefix}=`));
}

/** One fake Chrome: a process that can be told it started, and then told it ended. */
function fakeChrome(pid = 4242): { child: ChildProcess; signals: string[]; emitExit: (code?: number) => void } {
	const emitter = new EventEmitter() as EventEmitter & { pid?: number; kill: (signal?: string) => boolean };
	emitter.pid = pid;
	const signals: string[] = [];
	emitter.kill = (signal?: string): boolean => {
		signals.push(signal ?? "");
		return true;
	};
	const child = emitter as unknown as ChildProcess;
	// Node emits `spawn` once Chrome is running; the fake says so on the next turn of the loop.
	setImmediate(() => child.emit("spawn"));
	return { child, signals, emitExit: (code = 0) => child.emit("exit", code, null) };
}

test("the login window's command line announces no automation and carries the site itself", () => {
	const profileDir = join(tmpdir(), "pi-meter-login-argv");
	const argv = meterBrowserArgv({ mode: "login", profileDir, url: "https://grok.com/" });

	assert.deepEqual(argv.filter(announcesAutomation), []);
	assert.equal(argv.at(-1), "https://grok.com/");
	assert.ok(argv.includes(`--user-data-dir=${profileDir}`), "the login window uses the meter profile, or the login reaches no run");
});

test("the hourly run keeps the DevTools pipe on the same profile", () => {
	const profileDir = join(tmpdir(), "pi-meter-login-argv");
	const argv = meterBrowserArgv({ mode: "run", profileDir });
	const login = meterBrowserArgv({ mode: "login", profileDir, url: "https://grok.com/" });

	assert.ok(argv.includes("--remote-debugging-pipe"), "the run is driven over the pipe; removing it would remove the reader");
	assert.ok(argv.includes("--headless=new"));
	assert.ok(login.includes(`--user-data-dir=${profileDir}`) && argv.includes(`--user-data-dir=${profileDir}`));
	assert.ok(!argv.includes("https://grok.com/"), "the run opens its own blank page, never a site it was not asked for");
});

test("the login window is one plain process: no pipe fds, and it ends when the process does", async () => {
	const profileDir = mkdtempSync(join(tmpdir(), "pi-meter-login-spawn-"));
	const fake = fakeChrome();
	const calls: { command: string; argv: string[]; stdio: unknown }[] = [];
	const spawner = ((command: string, argv: string[], options: { stdio: unknown }) => {
		calls.push({ command, argv, stdio: options.stdio });
		return fake.child;
	}) as unknown as MeterBrowserSpawn;
	try {
		const window = await openMeterLoginWindow({
			url: "https://platform.openai.com/",
			binary: "/usr/bin/google-chrome",
			profileDir,
			spawn: spawner,
		});

		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.command, "/usr/bin/google-chrome");
		assert.equal(calls[0]?.argv.at(-1), "https://platform.openai.com/");
		assert.deepEqual(calls[0]?.argv.filter(announcesAutomation), []);
		// Three channels: stdin, stdout and stderr. The run adds fds 3 and 4 for the DevTools pipe, and a login
		// window that carried them would be the browser this fix removes.
		assert.equal((calls[0]?.stdio as unknown[]).length, 3);
		assert.equal(window.pid, 4242);

		let ended = false;
		void window.exited.then(() => {
			ended = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(ended, false, "the window is open until Chrome exits");
		fake.emitExit(0);
		await window.exited;
		assert.equal(ended, true);
	} finally {
		rmSync(profileDir, { recursive: true, force: true });
	}
});

test("closing the login window ends its process", async () => {
	const profileDir = mkdtempSync(join(tmpdir(), "pi-meter-login-close-"));
	const fake = fakeChrome(5150);
	const spawner = (() => fake.child) as unknown as MeterBrowserSpawn;
	try {
		const window = await openMeterLoginWindow({ url: "https://grok.com/", binary: "/usr/bin/google-chrome", profileDir, spawn: spawner });
		const closing = window.close();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(fake.signals, ["SIGTERM"]);
		fake.emitExit(0);
		await closing;
	} finally {
		rmSync(profileDir, { recursive: true, force: true });
	}
});

test("the meter lock answers busy while a run holds it, and runs again once it does not", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "pi-meter-lock-"));
	// The holder is a run: `flock` on the meter's own lock file, kept for a few seconds. It is left to exit on its
	// own rather than killed, because `flock`'s child inherits the lock's file descriptor and a killed `flock`
	// would leave that child holding the lock as an orphan.
	const holder = spawn("flock", ["--nonblock", meterLockPath(stateDir), "bash", "-c", "echo ready; sleep 5"], {
		stdio: ["ignore", "pipe", "ignore"],
	});
	await new Promise<void>((resolve, reject) => {
		holder.stdout?.once("data", () => resolve());
		holder.once("error", reject);
	});
	const holderExit = new Promise<void>((resolve) => holder.once("exit", () => resolve()));
	assert.deepEqual(await withMeterLock({ stateDir, launch: { command: "/bin/true", args: [] } }), { kind: "busy" });
	await holderExit;
	// With the holder gone the same call takes the lock and runs its command, so the busy answer above was the
	// holder's and not a call that fails on its own.
	assert.deepEqual(await withMeterLock({ stateDir, launch: { command: "/bin/true", args: [] } }), { kind: "finished", code: 0 });
	rmSync(stateDir, { recursive: true, force: true });
});

/** The context a verb sees: arguments after its name, a desktop, and lines collected instead of printed. */
function loginContext(out: string[], err: string[]): CliContext {
	return {
		argv: ["login", "grok.com"],
		repoRoot: process.cwd(),
		agentId: undefined,
		json: false,
		cwd: process.cwd(),
		env: { ...process.env, DISPLAY: ":0" },
		io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
		readStdin: async () => "",
	};
}

test("the login verb refuses while a run holds the lock, and opens no window", async () => {
	const out: string[] = [];
	const err: string[] = [];
	let opened = 0;
	const code = await runUsageCommand(loginContext(out, err), {
		withMeterLock: async () => ({ kind: "busy" as const }),
		openMeterLoginWindow: async () => {
			opened += 1;
			throw new Error("the login window must not open while a run holds the lock");
		},
	});

	assert.equal(code, 1);
	assert.equal(opened, 0);
	assert.match(err.join("\n"), /the meter browser is busy/);
	assert.deepEqual(out, []);
});

test("the login verb opens the window on the site's own address and waits for it to close", async () => {
	const out: string[] = [];
	const err: string[] = [];
	const site = meterSiteFor("grok.com");
	assert.ok(site !== undefined);
	const seen: string[] = [];
	let closes = 0;
	const code = await runUsageCommand(loginContext(out, err), {
		withMeterLock: async () => ({ kind: "held" as const }),
		openMeterLoginWindow: async (options: { url: string }) => {
			seen.push(options.url);
			return { pid: 7, exited: Promise.resolve(), close: async () => {
				closes += 1;
			} };
		},
	});

	assert.equal(code, 0);
	assert.deepEqual(seen, ["https://grok.com/"]);
	assert.equal(closes, 1);
	assert.match(out.join("\n"), /a window is open on https:\/\/grok\.com/);
});
