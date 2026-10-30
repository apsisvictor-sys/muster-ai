/**
 * `core/harness-paths.ts` — the one owner of where a harness file stands (RS3 F1).
 *
 * A harness file lives in one of two trees. Pi's profile keeps the packages at
 * `packages/<pkg>/...` under the agent folder; the muster repository keeps them at
 * `<pkg>/...` under its own root. A test sits two levels below the tree that holds
 * the packages in **both** layouts, so that depth is the harness root — which is
 * what `muster/tests/ledger-fixture.ts` already assumed. Three levels is right only
 * under `packages/`, which is why the moved tests failed from the repository.
 *
 * Pi's own profile is never derived here. It comes from the `agentDir` port (RD1,
 * S10), which a start file configures and which is a scratch folder in a run that
 * has no profile at all — the repository's CI. A helper that needs a file Pi ships
 * asks the port, so a run without a profile fails at the file it wanted, never at
 * the root it guessed.
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { piAgentDir } from "./pi-ports.ts";

/** The tree that holds the packages: `packages/` under Pi's profile, the repository root in the clone. */
export function harnessRoot(moduleUrl: string): string {
	return resolve(dirname(fileURLToPath(moduleUrl)), "..", "..");
}

/** A path inside the harness tree. */
export function harnessPath(moduleUrl: string, ...segments: string[]): string {
	return join(harnessRoot(moduleUrl), ...segments);
}

/**
 * The agent folder when a start file configured one, else `undefined`. A test helper
 * asks instead of throwing, because a run with no profile is a supported run.
 */
export function profileDir(): string | undefined {
	try {
		return piAgentDir();
	} catch {
		return undefined;
	}
}

/** A file Pi ships when the profile is present, else `undefined`. */
export function profileFile(...segments: string[]): string | undefined {
	const root = profileDir();
	if (root === undefined) return undefined;
	const path = join(root, ...segments);
	return existsSync(path) ? path : undefined;
}

/**
 * The `tsx` loader a child process loads: the profile's copy, else the harness's own
 * `node_modules` (the repository installs it for CI), else the copy this process runs.
 */
export function tsxLoaderPath(): string | undefined {
	const candidates = [profileDir() === undefined ? undefined : join(profileDir() as string, "node_modules", "tsx", "dist", "loader.mjs"), harnessPath(import.meta.url, "node_modules", "tsx", "dist", "loader.mjs")];
	for (const candidate of candidates) if (candidate !== undefined && existsSync(candidate)) return candidate;
	return undefined;
}

/** The `tsx` CLI a child process runs: the profile's copy, else the harness's own. */
export function tsxCliPath(): string | undefined {
	const candidates = [profileDir() === undefined ? undefined : join(profileDir() as string, "node_modules", "tsx", "dist", "cli.mjs"), harnessPath(import.meta.url, "node_modules", "tsx", "dist", "cli.mjs")];
	for (const candidate of candidates) if (candidate !== undefined && existsSync(candidate)) return candidate;
	return undefined;
}

/** Pi's own node when the profile ships one, else the node running this file. */
export function nodeBinary(): string {
	const shipped = profileFile("bin", "node");
	return shipped ?? process.execPath;
}

/**
 * The --import arguments a child process needs to run harness code with the ports wired:
 * the tsx loader, then Pi's own start file when this checkout stands inside a profile.
 * A checkout with no profile passes the loader only, and the child reports the port it
 * needed instead of loading Pi's profile from a guessed path.
 */
export function childImportArgs(): string[] {
	const loader = tsxLoaderPath();
	const args = loader === undefined ? [] : ["--import", pathToFileURL(loader).href];
	const ports = profileFile("extensions", "lib", "harness-ports.ts");
	if (ports !== undefined) args.push("--import", pathToFileURL(ports).href);
	return args;
}

/**
 * The Pi profile this checkout stands in, when the packages are that profile's own
 * `packages/` folder: the agent folder above it. A standalone checkout has none, and
 * a caller then falls back to the `agentDir` the run configured — a scratch folder in
 * the repository's CI, which is why a test that needs real profile files must skip
 * rather than read a guessed path.
 */
export function enclosingProfile(moduleUrl: string): string | undefined {
	const root = harnessRoot(moduleUrl);
	return existsSync(join(root, "..", "packages", "package.json")) ? resolve(root, "..") : undefined;
}
