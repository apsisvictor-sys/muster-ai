/**
 * Read-only knowledge for the Grokbot gateway: which folders and repos may be
 * read, the path denylist that applies to every read, paged file reads, and a
 * fixed `git log`.
 *
 * Content search and the wiki are not here: `wiki_search` / `wiki_read` call
 * `executeContextLookup` and `recall` / `recall_expand` call the pi-memory
 * server, the existing owners. What this module owns is the gateway's own
 * boundary: a path is read only when it resolves, symlinks followed, inside a
 * named root and passes the denylist.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { piPort } from "../../core/pi-ports.ts";
import { redactSensitiveText } from "../../core/self-improving-redactor.ts";

export class KnowledgeRefusal extends Error {}

export type NamedDir = { name: string; dir: string };

/** Folders `plans_read` may read: the Pi plans and the plans folder of each named project. */
export function defaultPlanRoots(home: string = homedir()): NamedDir[] {
	const project = (name: string): NamedDir => ({ name, dir: join(home, "projects", name, "docs", "plans") });
	return [
		{ name: "pi-plans", dir: join(home, ".pi", "agent", "plans") },
		project("crm-app"),
		project("acme-realty-website"),
		project("studio-hub"),
		project("studio-marketing"),
		project("pi-media-platform"),
	];
}

/** Repos `git_log` may read. */
export function defaultGitRepos(home: string = homedir()): NamedDir[] {
	return [
		{ name: "pi-agent", dir: join(home, ".pi", "agent") },
		{ name: "claude-mods", dir: join(home, "projects", "claude-mods") },
		{ name: "knowledge", dir: join(home, "knowledge", "wiki") },
		{ name: "crm-app", dir: join(home, "projects", "crm-app") },
		{ name: "acme-realty-website", dir: join(home, "projects", "acme-realty-website") },
		{ name: "studio-hub", dir: join(home, "projects", "studio-hub") },
		{ name: "studio-marketing", dir: join(home, "projects", "studio-marketing") },
		{ name: "pi-media-platform", dir: join(home, "projects", "pi-media-platform") },
	];
}

/** Skill folders `skills_list` and `skills_read` may read. Read-only, never run. */
export function defaultSkillRoots(home: string = homedir()): NamedDir[] {
	return [
		{ name: "claude", dir: join(home, ".claude", "skills") },
		{ name: "pi", dir: join(home, ".pi", "agent", "skills") },
		{ name: "home", dir: join(home, "skills") },
		{ name: "agents", dir: join(home, ".agents", "skills") },
	];
}

/** Top-level project directories `project_list` and `project_read` may read, plus the one checkout
 *  root that is outside them. */
export function defaultProjectRoots(home: string = homedir()): NamedDir[] {
	return [
		{ name: "projects", dir: join(home, "projects") },
		{ name: "worktrees", dir: join(home, ".worktrees") },
		// HO9: the register's one checkout outside `~/projects` and `~/.worktrees`, read through the same
		// tool, the same denylist and the same root check.
		{ name: "pi-agent", dir: join(home, ".pi", "agent") },
	];
}

/** Subdirectory names `project_read` always refuses under a project, regardless of extension.
 *  BE client data lives here by convention; the operator has the list and decides what to allow. */
export const EXCLUDED_PROJECT_SUBDIRS: readonly string[] = ["uploads", "exports", "dumps", "data", ".data", "client-data", "secrets"];

/** Memory folders `memory_read` may read. */
export function defaultMemoryRoots(home: string = homedir()): NamedDir[] {
	return [
		{ name: "claude-memory", dir: join(home, ".claude", "projects", "-home-operator", "memory") },
		{ name: "pi-consolidated", dir: join(home, ".pi", "agent", "memory", "consolidated") },
	];
}

/** Reports folder `reports_read` may read. */
export function defaultReportsRoot(home: string = homedir()): NamedDir {
	return { name: "reports", dir: join(home, "reports") };
}

/**
 * Instruction sources `instructions_read` may read. `instructions` is the folder of
 * architecture.md, methodology.md, and any sibling .md/.txt/.json; `agents-md` is the
 * single file `~/.pi/agent/AGENTS.md` (the Pi parent profile); `claude-md` is the
 * single file `~/.claude/CLAUDE.md` (the operator's global instructions for Claude sessions).
 */
export function defaultInstructionsRoots(home: string = homedir()): NamedDir[] {
	return [
		{ name: "instructions", dir: join(home, ".pi", "agent", "instructions") },
		{ name: "agents-md", dir: join(home, ".pi", "agent", "AGENTS.md") },
		{ name: "claude-md", dir: join(home, ".claude", "CLAUDE.md") },
	];
}

/** A single .md / .txt / .json file is also a "root" for `instructions_read`; this is the extension set
 *  it accepts. The folder and the single file use the same allowlist. */
export const INSTRUCTION_EXTENSIONS = [".md", ".txt", ".json", ".markdown"];

// ─── The denylist: every read, whatever the root ─────────────────────────────

const DENIED_NAMES: readonly RegExp[] = [
	/^\.env/i,
	/^auth\.json$/i,
	/^credentials/i,
	/^agent-keys\.env$/i,
	/^\.npmrc$/i,
	/\.key$/i,
	/\.pem$/i,
	/^id_(rsa|dsa|ecdsa|ed25519)/i,
	// Any database file, its journals and its retired copies (`history-index.db.retired-…`).
	/\.(db|sqlite3?)(-wal|-shm|-journal)?(\.|$)/i,
	// A segment whose own word is "token" or "secret" (my-token.json, secret_key.txt, x.secret),
	// not any segment that merely contains the letters (tokenizer.py, tokens.md, secretary.md stay readable).
	/(^|[^a-z0-9])token([^a-z0-9]|$)/i,
	/(^|[^a-z0-9])secret([^a-z0-9]|$)/i,
];
const DENIED_SEGMENTS = new Set([".claude", ".config", ".ssh", ".cloudflared", ".gnupg", ".aws", ".git", "node_modules", "secrets"]);

/** Why this path may never be read, or undefined. Checks every segment, so a denied folder denies what is under it. */
export function deniedReason(path: string, home: string = homedir()): string | undefined {
	const normalized = resolve(path);
	for (const dir of [".claude", ".config", ".ssh", ".cloudflared"]) {
		const denied = join(home, dir);
		if (normalized === denied || normalized.startsWith(denied + sep)) return `${dir} is never readable`;
	}
	for (const segment of normalized.split(sep)) {
		if (segment === "") continue;
		if (DENIED_SEGMENTS.has(segment)) return `${segment} is never readable`;
		if (DENIED_NAMES.some((pattern) => pattern.test(segment))) return `${segment} matches the secret-file denylist`;
	}
	return undefined;
}

/** The subdirectory names `project_read` always refuses under a project, regardless of file extension.
 *  Equivalent to denylist segment check, scoped to a project's children, not the home denylist. */
export function isExcludedProjectSubdir(name: string): boolean {
	return EXCLUDED_PROJECT_SUBDIRS.includes(name);
}

/** Refuses a project path whose first segment (the project name) is in the BE client-data list. */
export function projectPathRefusal(projectRelative: string): string | undefined {
	const first = projectRelative.split(/[\\/]/).find((segment) => segment !== "" && segment !== ".");
	if (first !== undefined && EXCLUDED_PROJECT_SUBDIRS.includes(first)) return `${first} is a BE client-data folder and is not readable`;
	return undefined;
}

/**
 * A requested path inside a root, as a real path, or a refusal: no `..`, no
 * absolute path, symlinks resolved and still inside the root, the denylist on
 * both the requested and the resolved path, an allowed extension.
 */
export function resolveInsideRoot(root: string, requested: string, extensions: readonly string[], home: string = homedir()): string {
	if (requested.includes("\0") || requested.startsWith("/") || requested.split(/[\\/]/).includes("..")) throw new KnowledgeRefusal("path is outside the folder");
	if (!existsSync(root)) throw new KnowledgeRefusal("the folder does not exist");
	const rootReal = realpathSync(root);
	const candidate = resolve(rootReal, requested);
	const requestedDenied = deniedReason(candidate, home);
	if (requestedDenied !== undefined) throw new KnowledgeRefusal(requestedDenied);
	if (!existsSync(candidate)) throw new KnowledgeRefusal("no such file");
	const real = realpathSync(candidate);
	if (real !== rootReal && !real.startsWith(rootReal + sep)) throw new KnowledgeRefusal("path is outside the folder");
	const resolvedDenied = deniedReason(real, home);
	if (resolvedDenied !== undefined) throw new KnowledgeRefusal(resolvedDenied);
	if (statSync(real).isFile() && !extensions.some((ext) => real.endsWith(ext))) throw new KnowledgeRefusal(`only ${extensions.join(", ")} files can be read`);
	return real;
}

export const PAGE_CHARS = 60_000;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LIST_ENTRIES = 200;

/** One page of a text file starting at a character offset, with the offset of the next page. */
export function readPage(file: string, offset: number): string {
	if (statSync(file).size > MAX_FILE_BYTES) throw new KnowledgeRefusal(`the file is larger than ${MAX_FILE_BYTES} bytes`);
	const text = readFileSync(file, "utf8");
	if (offset > text.length) throw new KnowledgeRefusal(`offset is past the end (${text.length} characters)`);
	const end = Math.min(text.length, offset + PAGE_CHARS);
	const footer = end < text.length ? `\n[characters ${offset}-${end} of ${text.length}; next offset ${end}]` : "";
	return text.slice(offset, end) + footer;
}

/** One level of a folder: files with an allowed extension and subfolders, minus anything denied. */
export function listFolder(dir: string, extensions: readonly string[], home: string = homedir()): string {
	const entries = readdirSync(dir, { withFileTypes: true })
		.filter((entry) => deniedReason(join(dir, entry.name), home) === undefined)
		.filter((entry) => entry.isDirectory() || (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))))
		.sort((a, b) => a.name.localeCompare(b.name));
	const lines = entries.slice(0, MAX_LIST_ENTRIES).map((entry) => (entry.isDirectory() ? `${entry.name}/` : `${entry.name}\t${statSync(join(dir, entry.name)).size} bytes`));
	return lines.join("\n") + (entries.length > MAX_LIST_ENTRIES ? `\n[+${entries.length - MAX_LIST_ENTRIES} more]` : "");
}

/** One level of a project folder: same as `listFolder`, but also hides BE client-data subdirs and pages by entry `offset`. */
export function listProjectFolder(dir: string, extensions: readonly string[], home: string = homedir(), offset: number = 0): string {
	const entries = readdirSync(dir, { withFileTypes: true })
		.filter((entry) => deniedReason(join(dir, entry.name), home) === undefined)
		.filter((entry) => !entry.isDirectory() || !isExcludedProjectSubdir(entry.name))
		.filter((entry) => entry.isDirectory() || (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))))
		.sort((a, b) => a.name.localeCompare(b.name));
	if (offset > entries.length) throw new KnowledgeRefusal(`offset is past the end (${entries.length} entries)`);
	const end = Math.min(entries.length, offset + MAX_LIST_ENTRIES);
	const lines = entries.slice(offset, end).map((entry) => (entry.isDirectory() ? `${entry.name}/` : `${entry.name}\t${statSync(join(dir, entry.name)).size} bytes`));
	return lines.join("\n") + (end < entries.length ? `\n[entries ${offset}-${end} of ${entries.length}; next offset ${end}]` : "");
}

// ─── git log, one line per commit ────────────────────────────────────────────

export type GitExec = (args: string[], cwd: string) => Promise<string>;

/** What git said, redacted and bounded, so a bad ref reads as "unknown revision" and not a bare "git log failed". */
function gitFailureMessage(stderr: string, error: Error): string {
	const said = redactSensitiveText((stderr || error.message).trim(), { preservePaths: true }).split("\n").slice(0, 5).join("\n").slice(0, 500);
	return said === "" ? "git log failed" : `git log failed: ${said}`;
}

export const execGit: GitExec = (args, cwd) =>
	new Promise((resolveGit, rejectGit) => {
		execFile("git", args, { cwd, timeout: 10_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" } }, (error, stdout, stderr) => {
			if (error !== null) rejectGit(new KnowledgeRefusal(gitFailureMessage(stderr, error)));
			else resolveGit(stdout);
		});
	});

// ─── graphify, a fixed argument list against one catalogue repository's graph ───

export type GraphifyExec = (args: string[]) => Promise<string>;

/** `graphify` with an argument list and no shell. The caller fixes the subcommand and the graph path. */
export const execGraphify: GraphifyExec = (args) =>
	new Promise((resolveGraphify, rejectGraphify) => {
		execFile("graphify", args, { timeout: 30_000, maxBuffer: 1024 * 1024, env: process.env }, (error, stdout, stderr) => {
			if (error !== null) {
				const said = redactSensitiveText((stderr || error.message).trim(), { preservePaths: true }).split("\n").slice(0, 5).join("\n").slice(0, 500);
				rejectGraphify(new KnowledgeRefusal(said === "" ? "graphify failed" : `graphify failed: ${said}`));
			} else resolveGraphify(redactSensitiveText(stdout, { preservePaths: true }));
		});
	});

/** The `since` shapes the gateway accepts: a date, an ISO time (git reads it as well as `Date.parse`), or "N units ago". Shared with the oversight digest. */
export const SINCE = /^(\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})?)?|\d{1,3} (hour|day|week|month)s? ago)$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;
export const MAX_GIT_COMMITS = 100;

export async function gitLogOneLine(
	repo: NamedDir,
	options: { limit: number; since?: string; ref?: string; path?: string },
	exec: GitExec = execGit,
	home: string = homedir(),
): Promise<string> {
	if (!existsSync(repo.dir)) throw new KnowledgeRefusal("the repo does not exist");
	if (options.since !== undefined && !SINCE.test(options.since)) throw new KnowledgeRefusal("since must be YYYY-MM-DD or like '3 days ago'");
	if (options.ref !== undefined && (!REF.test(options.ref) || options.ref.includes(".."))) throw new KnowledgeRefusal("ref is not a branch or tag name");
	const args = ["--no-pager", "-c", "core.fsmonitor=false", "log", "--no-color", "--date=short", "--format=%h %ad %s", `--max-count=${Math.min(MAX_GIT_COMMITS, Math.max(1, options.limit))}`];
	if (options.since !== undefined) args.push(`--since=${options.since}`);
	if (options.ref !== undefined) args.push(options.ref);
	if (options.path !== undefined) {
		if (options.path.includes("\0") || options.path.startsWith("/") || options.path.startsWith("-") || options.path.split(/[\\/]/).includes("..")) throw new KnowledgeRefusal("path is outside the repo");
		const denied = deniedReason(join(repo.dir, options.path), home);
		if (denied !== undefined) throw new KnowledgeRefusal(denied);
		args.push("--", options.path);
	}
	return (await exec(args, repo.dir)).trim() || "no commits";
}

// ─── pi-memory, through its own server ───────────────────────────────────────

export type MemoryCall = (tool: "recall" | "recall_expand", args: Record<string, unknown>) => Promise<string>;

/**
 * `recall` and `recall_expand` through the pi-memory server's own factory
 * (loaded by the `memoryServer` port, S12), in this process over an in-memory
 * transport: the same tools, validation and sanitising the Claude sessions get,
 * no copy of them. `cwd` is the project the recall is asked from.
 */
export function memoryRecall(cwd: string): MemoryCall {
	let client: Promise<{ callTool: (request: { name: string; arguments: Record<string, unknown> }) => Promise<{ content?: unknown; isError?: boolean }> }> | undefined;
	const connect = async () => {
		const { createMemoryServer } = await piPort("memoryServer")();
		const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
		const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
		await createMemoryServer().connect(serverSide);
		const memoryClient = new Client({ name: "grokbot-gateway", version: "1.0.0" });
		await memoryClient.connect(clientSide);
		return memoryClient;
	};
	return async (tool, args) => {
		client ??= connect();
		const result = await (await client).callTool({ name: tool, arguments: { ...args, cwd } });
		const text = (Array.isArray(result.content) ? result.content : []).map((part: { text?: string }) => part.text ?? "").join("\n");
		if (result.isError === true) throw new KnowledgeRefusal(text || "recall failed");
		return text;
	};
}
