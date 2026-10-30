/**
 * `muster usage` — print the UM1 usage snapshot, and run the meter browser (UB0 U-1).
 *
 * `muster usage` reads `<stateDir>/usage/snapshot.json` (the file `scripts/usage-snapshot.ts`
 * writes every 15 minutes via the `pi-usage-snapshot.timer` user unit) and renders it as a
 * one-line-per-provider table or as JSON.
 *
 * One row per provider, no accounts dimension (R1). A row whose provider is
 * opaque carries walls and resets only, never an invented percentage; a metered
 * row carries its credit `balance`, kept apart from a quota so it is never
 * rendered as a percentage (UM5). A row with no reading shows `unreadable:` and
 * the reason (H52); an older snapshot without that field shows the reader's
 * error, or why no reader ran.
 *
 * `--provider <name>` narrows to one provider. Without `--json` the verb
 * prints a small table the orchestrator can read at a glance; with `--json`
 * the same data is the machine view.
 *
 * Two subcommands run the meter browser itself (U-1):
 *
 *  - `refresh --browser [--site <id>]` reads the sites now instead of waiting for the hour. The
 *    router may call it before placing a hard lane when the row is older than 2 h (design record U3).
 *    It takes the same lock as the timer, so it can never open the profile beside a run, and it says
 *    "the meter browser is busy" when the hour is already running.
 *  - `login <site>` opens the same profile in a window on the desktop, on that site, and returns when
 *    the operator closes it. It logs nothing in itself: the login is his hands only (VR24-201), and no agent
 *    types a password, solves a CAPTCHA or cancels a plan. The window is a plain Chrome on that
 *    profile — no DevTools pipe, no automation switch — because a sign-in page refuses to offer
 *    "Continue with Google" to a browser that announces either (USELOGIN).
 *
 * Both subcommands run inside the lock by relaunching this same command under `flock`. The CLI frame
 * hands a verb its own arguments, so the relaunch has to restore the verb name — that is what
 * `usageSelfLaunch` exists for; without it the child is `muster refresh`, which the frame refuses.
 *
 * The verb is auto-registered: `scripts/muster.mts` discovers every module
 * under `extensions/muster/cli/` that exports `command`, so this file is the
 * only change that lands `muster usage`.
 */

import { existsSync } from "node:fs";
import { readUsageSnapshot, usageSnapshotPath, type UsageSnapshot, type SnapshotProvider } from "../bin/usage-snapshot.mts";
import { meterSiteFor } from "../meter-browser/adapters/index.ts";
import { meterSiteUrl, openMeterLoginWindow, type MeterLoginWindow } from "../meter-browser/facade.ts";
import { formatMeterRun, meterSelfLaunch, runMeterBrowser, withMeterLock, type MeterLockLaunch } from "../meter-browser/runner.ts";
import { musterStateDir } from "../binding.ts";
import { parseFlags, type CliCommand, type CliContext } from "./types.ts";

const VALUE_FLAGS = ["provider", "site"];

const USAGE = [
	"muster usage [--json] [--provider <name>]",
	"  reads <stateDir>/usage/snapshot.json (the file pi-usage-snapshot.timer writes)",
	"  --provider narrows to one provider's row; --json is the machine view",
	"muster usage refresh --browser [--site <id>]",
	"  reads the meter browser's sites now (the timer reads them hourly at :05)",
	"muster usage login <site>",
	"  opens the meter browser's profile on that site so you can log in, and returns when you close it",
].join("\n");

/**
 * What a subcommand calls, so a test drives the whole verb without a browser, a lock or a run. The
 * production values are the owners themselves: nothing here re-implements one.
 */
export type UsagePorts = {
	withMeterLock?: typeof withMeterLock;
	runMeterBrowser?: typeof runMeterBrowser;
	/** The login window the verb opens on the site; the production value is the facade's own. */
	openMeterLoginWindow?: typeof openMeterLoginWindow;
};

/**
 * This command, relaunched as `muster usage <argv>` under the lock.
 *
 * The frame gives a verb the arguments that follow its name (`cli-main.ts`), so a relaunch that
 * passed only those would run `muster refresh` and be refused as an unknown command. The verb name is
 * part of what this command *is*, so this file restores it and the runner stays ignorant of CLI verbs.
 */
export function usageSelfLaunch(argv: readonly string[]): MeterLockLaunch {
	return meterSelfLaunch(["usage", ...argv]);
}

export const command: CliCommand = {
	name: "usage",
	summary: "Print the usage snapshot (percentage for observable, walls for opaque/metered), or run the meter browser",
	usage: USAGE,
	async run(ctx) {
		return runUsageCommand(ctx);
	},
};

/** The verb, with its collaborators replaceable for a test. */
export async function runUsageCommand(ctx: CliContext, ports: UsagePorts = {}): Promise<number> {
	const parsed = parseFlags(ctx.argv, VALUE_FLAGS);
	const verb = parsed.positionals[0]?.trim();
	if (verb === "refresh") return refreshMeterBrowser(ctx, parsed, ports);
	if (verb === "login") return loginMeterBrowser(ctx, parsed, ports);
	return printSnapshot(ctx, parsed);
}

async function printSnapshot(ctx: CliContext, parsed: ReturnType<typeof parseFlags>): Promise<number> {
	const provider = parsed.values.get("provider")?.trim();
	const path = usageSnapshotPath(ctx.env);
	const snapshot = existsSync(path) ? readUsageSnapshot(path) : { version: 1 as const, capturedAt: 0, providers: [] };
	const filtered = provider
		? snapshot.providers.filter((row) => row.provider === provider)
		: snapshot.providers;
	if (provider !== undefined && filtered.length === 0) {
		ctx.io.err(`muster usage: no provider ${JSON.stringify(provider)} in the snapshot (the file lists ${snapshot.providers.length} provider${snapshot.providers.length === 1 ? "" : "s"})\n${USAGE}`);
		return 3;
	}
	if (ctx.json) {
		ctx.io.out(JSON.stringify(snapshot, null, 2));
		return 0;
	}
	ctx.io.out(formatUsageTable(filtered, snapshot.capturedAt, path));
	return 0;
}

/**
 * `refresh --browser [--site]`: one run, under the timer's own lock. A run that cannot take the lock
 * says so and exits 1, because an on-demand read that quietly did nothing would look like a read.
 */
async function refreshMeterBrowser(
	ctx: CliContext,
	parsed: ReturnType<typeof parseFlags>,
	ports: UsagePorts,
): Promise<number> {
	if (!parsed.flags.has("browser")) {
		ctx.io.err(`muster usage refresh: only --browser exists; nothing else in the snapshot is read on demand\n${USAGE}`);
		return 2;
	}
	const site = parsed.values.get("site")?.trim();
	if (site !== undefined && site !== "" && meterSiteFor(site) === undefined) {
		ctx.io.err(`muster usage refresh: no meter site is called ${JSON.stringify(site)}\n${USAGE}`);
		return 2;
	}
	const stateDir = musterStateDir();
	const lock = await (ports.withMeterLock ?? withMeterLock)({ stateDir, launch: usageSelfLaunch(ctx.argv), env: ctx.env });
	if (lock.kind === "busy") {
		ctx.io.err("muster usage refresh: the meter browser is busy");
		return 1;
	}
	if (lock.kind === "finished") return lock.code;
	const result = await (ports.runMeterBrowser ?? runMeterBrowser)({
		stateDir,
		...(site === undefined || site === "" ? {} : { site }),
	});
	ctx.io.out(formatMeterRun(result));
	for (const outcome of result.sites) {
		if (outcome.kind === "unreadable") ctx.io.out(`  ${outcome.site}: ${outcome.reason}`);
		// A fixed line: the raw message can carry a page's own text or the browser's last stderr line, and the
		// journal already has the redacted detail (VR24-207 F3).
		else if (outcome.kind === "error") ctx.io.out(`  ${outcome.site}: failed (the journal has the reason)`);
	}
	return 0;
}

/**
 * `login <site>`: the profile in a window, on that site, and the operator's hands. It needs a desktop on this
 * machine (WSLg sets `DISPLAY` or `WAYLAND_DISPLAY`), says so when there is none, and takes the same
 * lock so the window never shares a profile with a run.
 */
async function loginMeterBrowser(
	ctx: CliContext,
	parsed: ReturnType<typeof parseFlags>,
	ports: UsagePorts,
): Promise<number> {
	const wanted = parsed.positionals[1]?.trim() ?? "";
	const site = meterSiteFor(wanted);
	if (site === undefined) {
		ctx.io.err(`muster usage login: no meter site is called ${JSON.stringify(wanted)}\n${USAGE}`);
		return 2;
	}
	if ((ctx.env["DISPLAY"] ?? "") === "" && (ctx.env["WAYLAND_DISPLAY"] ?? "") === "") {
		ctx.io.err("muster usage login: the meter browser needs a desktop here, and neither DISPLAY nor WAYLAND_DISPLAY is set (WSLg provides one)");
		return 2;
	}
	const stateDir = musterStateDir();
	const lock = await (ports.withMeterLock ?? withMeterLock)({ stateDir, launch: usageSelfLaunch(ctx.argv), env: ctx.env });
	if (lock.kind === "busy") {
		ctx.io.err("muster usage login: the meter browser is busy");
		return 1;
	}
	if (lock.kind === "finished") return lock.code;
	// The window's address is the adapter table's own ("/" on the site's declared origin), never anything the
	// command line said: a blank window would ask the operator to log into nothing (VR24-207 F2).
	let window: MeterLoginWindow;
	try {
		window = await (ports.openMeterLoginWindow ?? openMeterLoginWindow)({ url: meterSiteUrl(site, "/") });
	} catch (error) {
		ctx.io.err(`muster usage login: the window could not open ${site.origin} (${error instanceof Error ? error.name : "error"})`);
		return 2;
	}
	ctx.io.out(`muster usage login: a window is open on ${site.origin}. Log in as yourself, then close the window to finish.`);
	await window.exited;
	await window.close();
	ctx.io.out("muster usage login: the window is closed; the profile keeps the login for the hourly run.");
	return 0;
}

function formatUsageTable(providers: SnapshotProvider[], capturedAt: number, path: string): string {
	const header = `usage snapshot captured ${new Date(capturedAt).toISOString()}${capturedAt === 0 ? " (no snapshot on disk yet)" : ""} from ${path}`;
	if (providers.length === 0) return `${header}\n(no providers)`;
	const lines: string[] = [header];
	for (const row of providers) {
		lines.push(formatRow(row));
	}
	return lines.join("\n");
}

function formatRow(row: SnapshotProvider): string {
	const state = row.quotaState.padEnd(10);
	const plan = row.plan ? `${row.plan.name} ($${row.plan.monthlyUsd ?? "?"}/mo)` : "no plan";
	// A row's own windows beyond the two slots: a monthly meter reads beside the 5-hour and weekly ones, named
	// by the reading (UD4), never folded into a slot it does not belong to.
	const beyond = (row.quota?.windows ?? []).slice(2).map((window) => ` / ${window.name} ${window.usedPercent.toFixed(1)}%`).join("");
	const quota = row.quota
		? `${row.quota.primary?.usedPercent.toFixed(1) ?? "?"}% 5h${row.quota.secondary ? ` / ${row.quota.secondary.usedPercent.toFixed(1)}% weekly` : ""}${beyond} (${row.quota.source}, ${row.quota.ageMs}ms ago, planType=${row.quota.planType ?? "?"})`
		: row.balance
			? `balance ${row.balance.amount} ${row.balance.currency}`
			: row.unreadable
				? `unreadable: ${row.unreadable}`
				: row.error
				? `error: ${row.error.message}`
				: row.walls.length > 0
					? `wall until ${new Date(row.walls[0]!.until).toISOString()} (${row.walls[0]!.source})`
					: row.reason ?? "no data";
	// A provider whose subscription Pi holds twice writes one row per account (UD11): the row names its account,
	// the next charge day belongs to it, and the account the pool does not route says so instead of looking routed.
	const account = row.account === undefined ? "" : `${row.account}, `;
	const renewal = row.billing?.nextChargeOn ? `, renews ${row.billing.nextChargeOn}` : "";
	const router = row.routed === false ? " [not used by Pi's router]" : "";
	return `  ${row.provider.padEnd(18)} ${state} ${account}${quota}${renewal}${router} plan=${plan}`;
}
