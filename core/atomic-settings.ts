import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const LOCK_NAME = ".routing-delegate-settings.lock";
const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
const MALFORMED_READ_ATTEMPTS = 3;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
const warnedMalformedReadPaths = new Set<string>();

function sleepSync(ms: number): void {
	Atomics.wait(sleepBuffer, 0, 0, ms);
}

function lockOwnerIsDead(lockPath: string): boolean {
	try {
		const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as { pid?: unknown };
		if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
		try {
			process.kill(owner.pid, 0);
			return false;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ESRCH";
		}
	} catch {
		return false;
	}
}

function recoverStaleLock(lockPath: string): boolean {
	try {
		const ageMs = Date.now() - statSync(lockPath).mtimeMs;
		if (ageMs < STALE_LOCK_MS && !lockOwnerIsDead(lockPath)) return false;
		rmSync(lockPath, { recursive: true, force: true });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		return false;
	}
}

function withSettingsLock<T>(path: string, action: () => T): T {
	const lockPath = join(dirname(path), LOCK_NAME);
	const ownerToken = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	mkdirSync(dirname(path), { recursive: true });
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	while (true) {
		try {
			mkdirSync(lockPath, { mode: 0o700 });
			writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: ownerToken }), { mode: 0o600 });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (recoverStaleLock(lockPath)) continue;
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for settings lock ${lockPath}`);
			sleepSync(LOCK_WAIT_MS);
		}
	}
	try {
		return action();
	} finally {
		try {
			const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as { token?: unknown };
			if (owner.token === ownerToken) rmSync(lockPath, { recursive: true, force: true });
		} catch { /* lock was already recovered or replaced; never remove another owner's lock */ }
	}
}

function readJsonUnlocked<T extends object>(path: string, fallback: T): T {
	if (!existsSync(path)) return { ...fallback };
	let lastError: unknown;
	for (let attempt = 1; attempt <= MALFORMED_READ_ATTEMPTS; attempt += 1) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("top-level JSON value must be an object");
			return parsed as T;
		} catch (error) {
			lastError = error;
			if (attempt < MALFORMED_READ_ATTEMPTS) sleepSync(LOCK_WAIT_MS);
		}
	}
	const detail = lastError instanceof Error ? lastError.message : String(lastError);
	throw new Error(`Malformed settings file ${path} after ${MALFORMED_READ_ATTEMPTS} attempts: ${detail}`);
}

function atomicWriteJsonUnlocked(path: string, value: object): void {
	const tempPath = join(dirname(path), `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(tempPath, "wx", 0o600);
		writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(tempPath, path);
		const dirFd = openSync(dirname(path), "r");
		try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		try { rmSync(tempPath, { force: true }); } catch { /* preserve original error */ }
		throw error;
	}
}

/** Read without taking the writer lock; atomic renames keep snapshots complete and bounded retries expose persistent corruption. */
export function readJsonSettingsFile<T extends object>(path: string, fallback: T): T {
	return readJsonUnlocked(path, fallback);
}

/**
 * Read at a runtime boundary where a corrupt settings file must not disable the
 * feature. Persistent corruption is reported once per path and the caller's
 * defaults are returned. Writers intentionally do not use this path: updates
 * remain fail-closed so malformed files are never overwritten.
 */
export function readJsonSettingsFileWithFallback<T extends object>(
	path: string,
	fallback: T,
	onMalformed: (message: string, path: string) => void,
): T {
	try {
		return readJsonUnlocked(path, fallback);
	} catch (error) {
		if (!(error instanceof Error) || !error.message.startsWith(`Malformed settings file ${path} `)) throw error;
		if (!warnedMalformedReadPaths.has(path)) {
			warnedMalformedReadPaths.add(path);
			try { onMalformed(error.message, path); } catch { /* warning delivery must not disable fallback reads */ }
		}
		return { ...fallback };
	}
}

/** Start a new warning-deduplication boundary (normally one interactive session). */
export function resetMalformedSettingsWarningDedupe(): void {
	warnedMalformedReadPaths.clear();
}

/** Atomically read, update, fsync, and rename a settings object while holding the shared lock. */
export function updateJsonSettingsFile<T extends object>(path: string, fallback: T, update: (current: T) => T): T {
	return withSettingsLock(path, () => {
		const next = update(readJsonUnlocked(path, fallback));
		if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error(`Settings update for ${path} must return an object`);
		atomicWriteJsonUnlocked(path, next);
		return next;
	});
}

/**
 * Build a cutover candidate from JSON snapshots, adding only missing own keys.
 * Existing scalar/null/array values win; objects reconcile recursively. No route
 * defaults are computed here, and neither snapshot is mutated or aliased.
 */
export function reconcileMissingSettings(live: Record<string, any>, bridge: Record<string, any>): Record<string, any> {
	const isObject = (value: unknown): value is Record<string, any> =>
		value !== null && typeof value === "object" && !Array.isArray(value);
	if (!isObject(live) || !isObject(bridge)) throw new Error("Settings snapshots must be JSON objects");
	const clone = (value: any): any => {
		if (Array.isArray(value)) return value.map(clone);
		if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
		return value;
	};
	const merge = (current: Record<string, any>, additions: Record<string, any>): Record<string, any> => {
		const pairs = Object.entries(current).map(([key, value]) => [
			key,
			Object.hasOwn(additions, key) && isObject(value) && isObject(additions[key])
				? merge(value, additions[key]) : clone(value),
		]);
		for (const [key, value] of Object.entries(additions)) {
			if (!Object.hasOwn(current, key)) pairs.push([key, clone(value)]);
		}
		// fromEntries defines own data properties even for __proto__/constructor.
		return Object.fromEntries(pairs);
	};
	return merge(live, bridge);
}

export const SETTINGS_LOCK_NAME = LOCK_NAME;
