/**
 * The model lists the gateway hands to `harnessModelCatalog` (extensions/lib/lane-control.ts,
 * the one owner of what a harness accepts). The gateway only reads the two inputs that live
 * on this machine: OpenCode's own `opencode models` and the models Pi's settings enable.
 */

import { readFileSync } from "node:fs";

export type CapturedRun = { exitCode: number | null; stdout: string; stderr: string };
export type RunCaptured = (command: string, args: string[], timeoutMs: number) => Promise<CapturedRun>;

/** A good `opencode models` answer is reused this long; the list changes when the operator adds a provider. */
export const OPENCODE_MODELS_TTL_MS = 5 * 60 * 1000;
/** A failed read is retried soon, so a missing binary or a slow start does not refuse launches for minutes. */
export const OPENCODE_MODELS_RETRY_MS = 15 * 1000;
const OPENCODE_MODELS_TIMEOUT_MS = 20_000;

/**
 * Reads `opencode models` lazily and caches it. Resolves to the raw output, or undefined when
 * the command failed or printed nothing (the catalog then refuses and never guesses a model).
 * Concurrent callers share one run.
 */
export function opencodeModelsReader(options: { run: RunCaptured; bin: string; now?: () => number }): () => Promise<string | undefined> {
	const now = options.now ?? Date.now;
	let cached: { value: string | undefined; until: number } | undefined;
	let inflight: Promise<string | undefined> | undefined;
	return async () => {
		if (cached !== undefined && now() < cached.until) return cached.value;
		inflight ??= (async () => {
			try {
				const result = await options.run(options.bin, ["models"], OPENCODE_MODELS_TIMEOUT_MS);
				const output = result.exitCode === 0 && result.stdout.trim() !== "" ? result.stdout : undefined;
				cached = { value: output, until: now() + (output === undefined ? OPENCODE_MODELS_RETRY_MS : OPENCODE_MODELS_TTL_MS) };
				return output;
			} finally {
				inflight = undefined;
			}
		})();
		return inflight;
	};
}

/**
 * Pi's enabled models from settings.json, read on every call (a small file) so a Ctrl+S save
 * in Pi shows up without a gateway restart. Glob patterns are not model ids and are skipped.
 */
export function readPiSettingsModels(settingsPath: string): string[] {
	try {
		const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as { enabledModels?: unknown };
		if (!Array.isArray(parsed.enabledModels)) return [];
		return parsed.enabledModels.filter((id): id is string => typeof id === "string" && id.trim() !== "" && !/[*?]/.test(id)).map((id) => id.trim());
	} catch {
		return [];
	}
}
