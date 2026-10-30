/**
 * Reads Codex subscription usage from ChatGPT's first-party WHAM endpoint,
 * with the Pi runtime cache and Codex CLI rollout files as local fallbacks.
 * Older Codex versions wrote `rate_limits` on every token_count event:
 *
 *   {"type":"event_msg","payload":{"type":"token_count","rate_limits":{
 *     "limit_id":"codex","plan_type":"plus",
 *     "primary":   {"used_percent": 3.0, "window_minutes":  300, "resets_at": 1777091496},
 *     "secondary": {"used_percent": 0.0, "window_minutes":10080, "resets_at": 1777678296}
 *   }}}
 *
 * The WHAM endpoint is polled every 5 minutes while a Codex model is active.
 * Local snapshots remain useful during transient endpoint/auth failures.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RateLimitWindow {
	usedPercent: number;
	windowMinutes: number;
	resetsAt: number; // epoch seconds
}

export interface CodexQuota {
	primary: RateLimitWindow | null;   // 5-hour block when exposed
	secondary: RateLimitWindow | null; // weekly block when exposed
	planType: string | null;
	capturedAt: number;         // epoch ms when this snapshot was written
	source: "codex-wham" | "pi-runtime" | "codex-rollout";
	ageMs: number;              // age of the snapshot as of read time
}

const CACHE_TTL_MS = 30_000;
const POLL_INTERVAL_MS = 5 * 60_000;
/**
 * Local snapshots bridge the gap between session start and the first WHAM
 * response. Past this age they are not evidence of anything — a status bar
 * that reports a month-old percentage is worse than one that reports nothing.
 */
const MAX_LOCAL_AGE_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;
const WHAM_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");
const PI_AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");
const PI_RUNTIME_FILE = join(homedir(), ".pi", "agent", "runtime", "codex-rate-limits.json");
const TAIL_BYTES = 64 * 1024; // last 64KB of the rollout file is plenty

let cached: { value: CodexQuota | null; at: number } = { value: null, at: 0 };
let polled: CodexQuota | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
const updateListeners = new Set<() => void>();

function newestRolloutFile(): string | null {
	if (!existsSync(CODEX_SESSIONS_DIR)) return null;

	// Walk YYYY/MM/DD — pick the lexicographically largest valid path.
	const pickLatest = (dir: string): string | null => {
		try {
			const entries = readdirSync(dir, { withFileTypes: true })
				.filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
				.sort((a, b) => b.name.localeCompare(a.name));
			return entries[0]?.name ?? null;
		} catch { return null; }
	};

	const year = pickLatest(CODEX_SESSIONS_DIR);
	if (!year) return null;
	const month = pickLatest(join(CODEX_SESSIONS_DIR, year));
	if (!month) return null;
	const day = pickLatest(join(CODEX_SESSIONS_DIR, year, month));
	if (!day) return null;

	const dayDir = join(CODEX_SESSIONS_DIR, year, month, day);
	let files: string[];
	try {
		files = readdirSync(dayDir).filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"));
	} catch { return null; }
	if (files.length === 0) return null;

	let latestPath: string | null = null;
	let latestMtime = 0;
	for (const f of files) {
		const p = join(dayDir, f);
		try {
			const m = statSync(p).mtimeMs;
			if (m > latestMtime) { latestMtime = m; latestPath = p; }
		} catch { /* ignore */ }
	}
	return latestPath;
}

function tailFile(path: string, maxBytes: number): string {
	const fd = require("node:fs").openSync(path, "r");
	try {
		const size = statSync(path).size;
		const start = Math.max(0, size - maxBytes);
		const len = size - start;
		const buf = Buffer.alloc(len);
		require("node:fs").readSync(fd, buf, 0, len, start);
		return buf.toString("utf8");
	} finally {
		require("node:fs").closeSync(fd);
	}
}

function finiteNumber(value: unknown): number | null {
	const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(number) ? number : null;
}

function epochSeconds(value: unknown): number | null {
	const number = finiteNumber(value);
	if (number != null) return number > 1_000_000_000_000 ? Math.floor(number / 1000) : Math.floor(number);
	if (typeof value !== "string") return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function toWindow(w: any, nowSeconds: number): RateLimitWindow | null {
	if (!w || typeof w !== "object") return null;
	const usedPercent = finiteNumber(w.used_percent ?? w.usedPercent);
	const windowMinutes = finiteNumber(w.window_minutes ?? w.windowMinutes)
		?? ((finiteNumber(w.limit_window_seconds) ?? 0) / 60);
	const resetsAt = epochSeconds(w.resets_at ?? w.resetsAt ?? w.reset_at ?? w.resetAt);
	if (usedPercent == null || !Number.isFinite(windowMinutes) || windowMinutes <= 0 || resetsAt == null) return null;
	// A window past its reset describes a period that has already ended. Its
	// percentage says nothing about the current one.
	if (resetsAt <= nowSeconds) return null;
	return { usedPercent: Math.max(0, Math.min(100, usedPercent)), windowMinutes, resetsAt };
}

function classifyWindows(...windows: Array<RateLimitWindow | null>): Pick<CodexQuota, "primary" | "secondary"> | null {
	const valid = windows.filter((window): window is RateLimitWindow => window != null);
	if (valid.length === 0) return null;
	const primary = valid.find((window) => window.windowMinutes <= 360) ?? null;
	const secondary = valid.find((window) => window.windowMinutes >= 5 * 24 * 60) ?? null;
	return { primary, secondary };
}

export function parseRateLimitsObject(
	rl: any,
	capturedAt: number,
	source: CodexQuota["source"],
	nowMs: number = Date.now(),
): CodexQuota | null {
	const nowSeconds = Math.floor(nowMs / 1000);
	const windows = classifyWindows(toWindow(rl?.primary, nowSeconds), toWindow(rl?.secondary, nowSeconds));
	if (!windows) return null;
	return {
		...windows,
		planType: rl.plan_type ?? null,
		capturedAt,
		source,
		ageMs: Math.max(0, Date.now() - capturedAt),
	};
}

function readPiRuntime(): CodexQuota | null {
	try {
		const raw = readFileSync(PI_RUNTIME_FILE, "utf8");
		const obj = JSON.parse(raw);
		const capturedAt = typeof obj?.capturedAt === "number" ? obj.capturedAt : Date.now();
		return parseRateLimitsObject(obj?.rate_limits, capturedAt, "pi-runtime");
	} catch { return null; }
}

function parseLatestRateLimitsFromRollout(text: string): CodexQuota | null {
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!;
		if (!line || line.length < 30) continue;
		if (!line.includes('"rate_limits"')) continue;
		let obj: any;
		try { obj = JSON.parse(line); } catch { continue; }
		const rl = obj?.payload?.rate_limits ?? obj?.rate_limits;
		const ts = obj?.timestamp ? Date.parse(obj.timestamp) : Date.now();
		const parsed = parseRateLimitsObject(rl, ts, "codex-rollout");
		if (parsed) return parsed;
	}
	return null;
}

function readRollout(): CodexQuota | null {
	try {
		const file = newestRolloutFile();
		if (!file) return null;
		const text = tailFile(file, TAIL_BYTES);
		return parseLatestRateLimitsFromRollout(text);
	} catch { return null; }
}

function resolvePiAuth(): { access: string; accountId: string | null } | null {
	try {
		const auth = JSON.parse(readFileSync(PI_AUTH_FILE, "utf8"));
		const entry = auth?.["openai-codex"];
		if (typeof entry?.access !== "string" || !entry.access.trim()) return null;
		return {
			access: entry.access.trim(),
			accountId: typeof entry.accountId === "string" && entry.accountId.trim() ? entry.accountId.trim() : null,
		};
	} catch { return null; }
}

export function parseWhamResponse(json: any, capturedAt: number, nowMs: number = Date.now()): CodexQuota | null {
	const nowSeconds = Math.floor(nowMs / 1000);
	const windows = classifyWindows(
		toWindow(json?.rate_limit?.primary_window, nowSeconds),
		toWindow(json?.rate_limit?.secondary_window, nowSeconds),
	);
	if (!windows) return null;
	return {
		...windows,
		planType: typeof json?.plan_type === "string" ? json.plan_type : null,
		capturedAt,
		source: "codex-wham",
		ageMs: 0,
	};
}

/**
 * One-shot WHAM fetch: used by the snapshot script and any caller that needs
 * a fresh reading without starting the background poller. Reads the credential
 * from `~/.pi/agent/auth.json`, never logs the key or the response body.
 * Returns null on missing auth, transport failure, non-2xx or unparsable body
 * — the snapshot records that null as an error per provider and continues.
 */
export async function fetchWhamQuota(): Promise<CodexQuota | null> {
	const auth = resolvePiAuth();
	if (!auth) return null;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${auth.access}`,
			Accept: "application/json",
			"User-Agent": "Pi-Status-Bar",
		};
		if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
		const response = await fetch(WHAM_ENDPOINT, { headers, signal: controller.signal });
		if (!response.ok) return null;
		return parseWhamResponse(await response.json(), Date.now());
	} catch { return null; }
	finally { clearTimeout(timer); }
}

async function refreshPolledQuota(): Promise<void> {
	const quota = await fetchWhamQuota();
	if (!quota) return;
	polled = quota;
	cached = { value: null, at: 0 };
	for (const listener of updateListeners) {
		try { listener(); } catch { /* a session may have shut down */ }
	}
}

/** Refresh immediately after a completed Codex response, not only on the timer. */
export function refreshCodexQuota(): void {
	void refreshPolledQuota();
}

export function startCodexPoller(onUpdate?: () => void): void {
	if (onUpdate) updateListeners.add(onUpdate);
	if (pollTimer) return;
	void refreshPolledQuota();
	pollTimer = setInterval(() => { void refreshPolledQuota(); }, POLL_INTERVAL_MS);
	pollTimer.unref?.();
}

export function stopCodexPoller(onUpdate?: () => void): void {
	if (onUpdate) updateListeners.delete(onUpdate);
	if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function newestQuota(...values: Array<CodexQuota | null>): CodexQuota | null {
	let newest: CodexQuota | null = null;
	for (const value of values) {
		if (value && (!newest || value.capturedAt > newest.capturedAt)) newest = value;
	}
	return newest ? { ...newest, ageMs: Math.max(0, Date.now() - newest.capturedAt) } : null;
}

/**
 * First-party data is authoritative whenever we have it. A local snapshot is
 * only a bridge until the poller answers, so it is trusted for MAX_LOCAL_AGE_MS
 * and then dropped rather than aged into a lie.
 */
export function selectQuota(
	polledValue: CodexQuota | null,
	localValue: CodexQuota | null,
	nowMs: number = Date.now(),
): CodexQuota | null {
	if (polledValue) return { ...polledValue, ageMs: Math.max(0, nowMs - polledValue.capturedAt) };
	if (!localValue || nowMs - localValue.capturedAt > MAX_LOCAL_AGE_MS) return null;
	return { ...localValue, ageMs: Math.max(0, nowMs - localValue.capturedAt) };
}

/** Returns the newest trustworthy Codex quota snapshot. Cached 30s. */
export function readCodexQuota(): CodexQuota | null {
	const now = Date.now();
	if (now - cached.at < CACHE_TTL_MS) {
		return cached.value ? { ...cached.value, ageMs: Math.max(0, now - cached.value.capturedAt) } : null;
	}

	const value = selectQuota(polled, newestQuota(readPiRuntime(), readRollout()), now);
	cached = { value, at: now };
	return value;
}

/**
 * True while a Codex model is active but no trustworthy snapshot exists yet —
 * the status bar renders a pending marker rather than omitting the field or
 * substituting stale local data.
 */
export function isCodexQuotaPending(): boolean {
	return pollTimer !== null && polled === null;
}
