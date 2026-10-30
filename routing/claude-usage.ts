/**
 * Claude's own usage read (UB0 A-1, VR24-201, spec
 * `plans/orchestration-2026-10-05/specs/ub0-meters-billing-journal-2026-10-26.md`, UD10 "A-1 Claude" and
 * its Custody paragraph).
 *
 * Claude Code's login already answers every meter the plan has:
 *   GET https://api.anthropic.com/api/oauth/usage
 *   Authorization: Bearer <the Claude Code login's access token>
 * (probed read-only 2026-10-26 by the architect and again by this lane, structure printed only; a missing
 * or wrong token answers HTTP 401 `{"type":"error","error":{"type":"authentication_error",...}}`):
 *
 *   { "five_hour":   { "utilization": 0..100, "resets_at": "ISO" },
 *     "seven_day":   { "utilization": 0..100, "resets_at": "ISO" },
 *     "seven_day_sonnet": null | { ... }, "seven_day_opus": null | { ... },
 *     "limits": [ { "kind": "session" | "weekly_all" | "weekly_scoped", "group": "session" | "weekly",
 *                   "percent": 0..100, "resets_at": "ISO",
 *                   "scope": null | { "model": { "id": null | string, "display_name": string } } } ],
 *     "extra_usage": { "monthly_limit": minor, "used_credits": minor, "currency": "EUR", ... },
 *     "iguana_necktie": { "utilization": 0..100, "resets_at": "ISO",
 *                         "limit_dollars": 250, "used_dollars": number, "remaining_dollars": number } }
 *
 * The status line Claude Code writes carries only the first two windows; this endpoint carries the
 * per-model weeks and the two money meters as well, so the snapshot's `claude-mod` row has a real reading
 * without a Claude session running.
 *
 * Mapping (UD10):
 *   - `five_hour` -> primary (300 minutes), `seven_day` -> secondary (10080); `utilization` is already
 *     0-100 and `resets_at` becomes epoch seconds;
 *   - `limits` never enters the provider-wide window list. An entry that names a model in its `scope`
 *     becomes a per-model window, as `seven_day_sonnet` and `seven_day_opus` do when they are not null;
 *   - `extra_usage` becomes the plan's extra-usage allowance in money (minor units with its currency);
 *   - the dollar meter under `CLOUD_ALLOWANCE_KEY` becomes the cloud-session allowance, the one the operator
 *     attributes to Claude cloud sessions (limit 250, resets 5 Nov on the day of the probe). A response
 *     without that key leaves the field out rather than guessing another meter's meaning.
 *
 * Custody (SK-D15): Claude Code owns and refreshes `~/.claude/.credentials.json`. This reader only reads
 * it, in-process, for `claudeAiOauth.accessToken`. It never writes the file and never refreshes the token
 * (a refresh would rotate Claude Code's own login), and the token never reaches a row, an error, a log or
 * a journal. A 401, or a token whose own `expiresAt` has already passed, reads `Claude login expired`
 * until the next Claude Code session refreshes it; the snapshot's status-line fallback still fills
 * whatever that file has.
 *
 * A changed response shape degrades to `unavailable` (the fallback stands), never to a wrong number, and
 * no body is ever logged. `fetchImpl` exists so the tests reach a fixture instead of the endpoint; the
 * timer's first live read is the first live read.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { RateLimitWindow } from "./codex-quota.ts";

/** The one line a dead Claude Code login reads, on the row and in the reader's error. */
export const CLAUDE_LOGIN_EXPIRED = "Claude login expired";

/** The endpoint Claude Code's own status line calls for the same numbers. */
export const CLAUDE_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";

/**
 * The response key carrying the cloud-session allowance: a dollar meter with `limit_dollars` 250 and its
 * own reset date, which the operator says is for Claude cloud sessions (UD10). The endpoint names its meters by
 * codeword, so the key is recorded here beside the mapping it belongs to.
 */
export const CLOUD_ALLOWANCE_KEY = "iguana_necktie";

/** A short deadline of its own: the snapshot's per-reader limit is 10 seconds (A-1, F1). */
export const CLAUDE_USAGE_DEADLINE_MS = 5_000;

const FIVE_HOUR_MINUTES = 300;
const WEEK_MINUTES = 10_080;

/** One per-model window: the weeks `seven_day_sonnet`, `seven_day_opus` and a scoped limit state. */
export interface ClaudeModelWindow extends RateLimitWindow {
	/** The model the window belongs to, as the endpoint names it ("Sonnet", or a scope's display name). */
	model: string;
	/** The window's own word ("week"), so the card can say "Sonnet week". */
	name: string;
}

/** The plan's extra-usage allowance, in minor units with the currency the endpoint states. */
export interface ClaudeExtraUsage {
	usedMinor: number;
	limitMinor: number;
	currency: string;
}

/** The cloud-session allowance in dollars, with the reset the endpoint states (epoch seconds). */
export interface ClaudeCloudAllowance {
	usedUsd: number;
	limitUsd: number;
	resetsAt: number;
}

/** One Claude usage reading: the two plan windows, the per-model weeks and the two money meters. */
export interface ClaudeUsage {
	primary: RateLimitWindow;
	secondary: RateLimitWindow | null;
	modelWindows: ClaudeModelWindow[];
	extraUsage: ClaudeExtraUsage | null;
	cloudAllowance: ClaudeCloudAllowance | null;
	source: "claude-oauth-usage";
	capturedAt: number;
	ageMs: number;
}

/**
 * What one read answered. `login-expired` is Claude Code's login being dead (401 or its own expiry), which
 * the row states as such; `unavailable` is every other reason there is no reading (no login file, non-2xx,
 * transport failure, a changed shape), where the status line's own reading stands.
 */
export type ClaudeUsageOutcome =
	| { kind: "usage"; usage: ClaudeUsage }
	| { kind: "login-expired" }
	| { kind: "unavailable" };

export interface ClaudeUsageOptions {
	/** Claude Code's login file; defaults to `~/.claude/.credentials.json`. */
	credentialsPath?: string;
	/** The clock the reading is stamped with, and the one the token's own expiry is compared to. */
	now?: number;
	/** The HTTP call; a test injects its own so no test reaches the endpoint. */
	fetchImpl?: typeof fetch;
	deadlineMs?: number;
}

/**
 * Where Claude Code keeps its login: `~/.claude/.credentials.json` (SK-D15). Read-only here; Claude Code
 * owns the file and refreshes it.
 */
export function claudeCredentialsPath(override?: string): string {
	const trimmed = override?.trim();
	return trimmed !== undefined && trimmed !== "" ? trimmed : join(homedir(), ".claude", ".credentials.json");
}

/** The ISO instant or epoch value an endpoint stated, in epoch seconds; 0 when it states none. */
function resetSeconds(value: unknown): number {
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
	}
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || numeric <= 0) return 0;
	return Math.floor(numeric > 1_000_000_000_000 ? numeric / 1000 : numeric);
}

/** One meter with `utilization` and `resets_at`, or null when it states no percentage. */
function meterWindow(raw: unknown, windowMinutes: number): RateLimitWindow | null {
	if (raw === null || typeof raw !== "object") return null;
	const meter = raw as { utilization?: unknown; resets_at?: unknown };
	const usedPercent = Number(meter.utilization);
	if (!Number.isFinite(usedPercent)) return null;
	return {
		usedPercent: Math.max(0, Math.min(100, usedPercent)),
		windowMinutes,
		resetsAt: resetSeconds(meter.resets_at),
	};
}

/** The window name a length reads, so a model window says "week" beside its model. */
function windowName(windowMinutes: number): string {
	if (windowMinutes === FIVE_HOUR_MINUTES) return "5h";
	if (windowMinutes === WEEK_MINUTES) return "week";
	return "";
}

/** The minutes a `limits` entry's own group or kind states; 0 when it states none. */
function limitMinutes(entry: { kind?: unknown; group?: unknown }): number {
	const words = [entry.group, entry.kind].filter((value): value is string => typeof value === "string").join(" ");
	if (/weekly|week/.test(words)) return WEEK_MINUTES;
	if (/session|5\s*h|hour/.test(words)) return FIVE_HOUR_MINUTES;
	return 0;
}

/** The model a `limits` entry's scope names, or null when it names none (UD10: only a named model). */
function scopedModel(scope: unknown): string | null {
	if (scope === null || typeof scope !== "object") return null;
	const model = (scope as { model?: unknown }).model;
	if (model === null || typeof model !== "object") return null;
	const named = model as { display_name?: unknown; id?: unknown };
	const displayName = typeof named.display_name === "string" ? named.display_name.trim() : "";
	if (displayName !== "") return displayName;
	const id = typeof named.id === "string" ? named.id.trim() : "";
	return id === "" ? null : id;
}

/**
 * Every per-model window the response states: the two plan-level model weeks and any `limits` entry whose
 * scope names a model. One entry per model and length, so a scoped limit that repeats a week adds nothing.
 */
function modelWindowsOf(json: Record<string, unknown>): ClaudeModelWindow[] {
	const windows: ClaudeModelWindow[] = [];
	const add = (window: ClaudeModelWindow | null): void => {
		if (window === null) return;
		if (windows.some((existing) => existing.model === window.model && existing.windowMinutes === window.windowMinutes)) return;
		windows.push(window);
	};
	const namedWeek = (raw: unknown, model: string): void => {
		const meter = meterWindow(raw, WEEK_MINUTES);
		add(meter === null ? null : { ...meter, model, name: windowName(meter.windowMinutes) });
	};
	namedWeek(json["seven_day_sonnet"], "Sonnet");
	namedWeek(json["seven_day_opus"], "Opus");
	const limits = Array.isArray(json["limits"]) ? json["limits"] : [];
	for (const raw of limits) {
		if (raw === null || typeof raw !== "object") continue;
		const entry = raw as { kind?: unknown; group?: unknown; scope?: unknown; percent?: unknown; resets_at?: unknown };
		const model = scopedModel(entry.scope);
		if (model === null) continue;
		// A scoped limit states its share as `percent`, not `utilization`; the two are the same 0-100 scale.
		const windowMinutes = limitMinutes(entry);
		const usedPercent = Number(entry.percent);
		if (!Number.isFinite(usedPercent)) continue;
		add({
			usedPercent: Math.max(0, Math.min(100, usedPercent)),
			windowMinutes,
			resetsAt: resetSeconds(entry.resets_at),
			model,
			name: windowName(windowMinutes),
		});
	}
	return windows;
}

/** `extra_usage` in money: the plan's own cap, in minor units with the currency it states. */
function extraUsageOf(raw: unknown): ClaudeExtraUsage | null {
	if (raw === null || typeof raw !== "object") return null;
	const allowance = raw as { monthly_limit?: unknown; used_credits?: unknown; currency?: unknown };
	const limitMinor = Number(allowance.monthly_limit);
	const usedMinor = Number(allowance.used_credits);
	if (!Number.isFinite(limitMinor) || !Number.isFinite(usedMinor)) return null;
	if (typeof allowance.currency !== "string" || allowance.currency.trim() === "") return null;
	return { usedMinor, limitMinor, currency: allowance.currency.trim() };
}

/** The cloud-session allowance under its recorded key; a response without it leaves the field out. */
function cloudAllowanceOf(json: Record<string, unknown>): ClaudeCloudAllowance | null {
	const raw = json[CLOUD_ALLOWANCE_KEY];
	if (raw === null || typeof raw !== "object") return null;
	const meter = raw as { limit_dollars?: unknown; used_dollars?: unknown; resets_at?: unknown };
	const limitUsd = Number(meter.limit_dollars);
	const usedUsd = Number(meter.used_dollars);
	if (!Number.isFinite(limitUsd) || !Number.isFinite(usedUsd)) return null;
	return { usedUsd, limitUsd, resetsAt: resetSeconds(meter.resets_at) };
}

/**
 * One `/api/oauth/usage` body as the row's reading, or null when the response does not carry the meter the
 * plan's 5-hour window is read from: a changed shape is never a number. Exported for the fixture test.
 */
export function parseClaudeUsage(json: unknown, now: number = Date.now()): ClaudeUsage | null {
	if (json === null || typeof json !== "object") return null;
	const body = json as Record<string, unknown>;
	// `five_hour` is the plan's own meter: without it the body is not this endpoint's answer. `secondary`
	// stays optional, exactly as the status line may carry one window.
	const primary = meterWindow(body["five_hour"], FIVE_HOUR_MINUTES);
	if (primary === null) return null;
	return {
		primary,
		secondary: meterWindow(body["seven_day"], WEEK_MINUTES),
		modelWindows: modelWindowsOf(body),
		extraUsage: extraUsageOf(body["extra_usage"]),
		cloudAllowance: cloudAllowanceOf(body),
		source: "claude-oauth-usage",
		capturedAt: now,
		ageMs: 0,
	};
}

/** Claude Code's login as this reader may use it: the token, and the expiry it states (epoch ms). */
interface ClaudeLogin {
	accessToken: string;
	expiresAt: number | null;
}

/**
 * The login Claude Code stored, read in-process and never written. A missing file, an unparsable one or a
 * file without a token all read as no login, which leaves the status line's reading in place.
 */
function readClaudeLogin(path: string): ClaudeLogin | null {
	let parsed: { claudeAiOauth?: unknown };
	try {
		parsed = JSON.parse(readFileSync(path, "utf8")) as { claudeAiOauth?: unknown };
	} catch {
		return null;
	}
	const oauth = parsed?.claudeAiOauth;
	if (oauth === null || typeof oauth !== "object") return null;
	const login = oauth as { accessToken?: unknown; expiresAt?: unknown };
	if (typeof login.accessToken !== "string" || login.accessToken.trim() === "") return null;
	const expiresAt = Number(login.expiresAt);
	return {
		accessToken: login.accessToken.trim(),
		expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : null,
	};
}

/**
 * One live read of Claude's usage endpoint through Claude Code's own login. The token is read and used
 * here and nowhere else; nothing is refreshed and nothing is written. A login whose stated expiry has
 * passed is reported as expired without spending a request, which is how a read after Claude Code has been
 * idle for a while answers.
 */
export async function fetchClaudeUsageOnce(options: ClaudeUsageOptions = {}): Promise<ClaudeUsageOutcome> {
	const now = options.now ?? Date.now();
	const login = readClaudeLogin(claudeCredentialsPath(options.credentialsPath));
	if (login === null) return { kind: "unavailable" };
	if (login.expiresAt !== null && login.expiresAt <= now) return { kind: "login-expired" };
	const deadlineMs = options.deadlineMs ?? CLAUDE_USAGE_DEADLINE_MS;
	const request = options.fetchImpl ?? fetch;
	try {
		const response = await request(CLAUDE_USAGE_ENDPOINT, {
			method: "GET",
			headers: { Authorization: `Bearer ${login.accessToken}`, Accept: "application/json" },
			signal: AbortSignal.timeout(deadlineMs),
		});
		// A refused token is the one failure with its own meaning on the row (UD10): Claude Code refreshes it
		// on its next session, and until then the row says so instead of guessing.
		if (response.status === 401) return { kind: "login-expired" };
		if (!response.ok) return { kind: "unavailable" };
		const usage = parseClaudeUsage(await response.json(), now);
		return usage === null ? { kind: "unavailable" } : { kind: "usage", usage };
	} catch {
		// A transport failure, a bad body or a request past its deadline: no reading, and the error text never
		// carries the token or the body.
		return { kind: "unavailable" };
	}
}
