import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REDACTED = "[REDACTED]";
const DEFAULT_DENYLISTED_KEYS = [
	"accountId", "account_id", "conversation", "cwd", "currentWorkingDirectory", "email",
	"filePath", "file_path", "homeDir", "home_dir", "initialPrompt", "initial_prompt",
	"messages", "prompt", "rawPrompt", "raw_prompt", "sessionId", "session_id", "systemPrompt",
	"system_prompt", "transcript", "userId", "user_id",
];
const IMPROVEMENTS_DIR = join(homedir(), ".pi", "agent", "improvements");
const MAX_JSONL_FILES = 100;
const MAX_JSONL_FILE_BYTES = 5_000_000;

export type RedactionCategory = "account-id" | "bearer" | "cloud-access-id" | "denylisted-key" | "email" | "filesystem-path" | "jwt-oauth" | "private-key" | "provider-token" | "secret-assignment" | "uri-userinfo";
export interface RedactionSummary { total: number; categories: Partial<Record<RedactionCategory, number>> }
export interface RedactionOptions {
	denylistedKeys?: string[];
	summary?: RedactionSummary;
	/**
	 * When true, the filesystem-path category is left intact. Credential
	 * assignments, URI userinfo, JWT/OAuth tokens and private keys stay
	 * redacted regardless — this only preserves benign local locators such as
	 * `/home/operator/projects/...` and `~/...` for memory evidence output.
	 * Defaults to false: existing callers keep today's behavior exactly.
	 */
	preservePaths?: boolean;
	/**
	 * When true, any `NAME=value` / `NAME: value` whose name contains secret,
	 * token, credential, password or key is redacted, not only the fixed names.
	 * For text leaving the machine (the Grokbot gateway). Defaults to false.
	 */
	strictAssignments?: boolean;
}

function note(options: RedactionOptions | undefined, category: RedactionCategory): void {
	if (!options?.summary) return;
	options.summary.total++;
	options.summary.categories[category] = (options.summary.categories[category] ?? 0) + 1;
}

function replaceAndCount(text: string, pattern: RegExp, replacement: string | ((...args: any[]) => string), category: RedactionCategory, options?: RedactionOptions): string {
	return text.replace(pattern, (...args: any[]) => {
		note(options, category);
		return typeof replacement === "function" ? replacement(...args) : replacement;
	});
}

/** Redact bounded, recognizable secrets and private identifiers before persistence or exposure. */
export function redactSensitiveText(text: string, options?: RedactionOptions): string {
	const assignment = options?.strictAssignments
		? "(?:[a-z0-9_-]*(?:secret|token|credential|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key)[a-z0-9_-]*|pwd|session[_-]?id)"
		: "(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|pwd|session[_-]?id)";
	let safe = text;
	safe = replaceAndCount(safe, /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, REDACTED, "private-key", options);
	safe = replaceAndCount(safe, /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[^\r\n]*/gi, REDACTED, "private-key", options);
	safe = replaceAndCount(safe, /-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, REDACTED, "private-key", options);
	safe = replaceAndCount(safe, /\b(Bearer)\s+(["'])(?:\\.|(?!\2)[^\r\n])*\2/gi, (match: string, prefix: string) => `${prefix} ${REDACTED}`, "bearer", options);
	safe = replaceAndCount(safe, /\b(Bearer)\s+[A-Za-z0-9._~+\/-]+=*/gi, (match: string, prefix: string) => `${prefix} ${REDACTED}`, "bearer", options);
	safe = replaceAndCount(safe, /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g, REDACTED, "provider-token", options);
	// No leading `\b`: a provider token embedded in a longer word run
	// (`AAAAsk-proj-…`) is still a credential. The read/search paths sanitize
	// the complete selected view before any slice, so the match must not depend
	// on what precedes the token. The trailing boundary still ends it.
	// The bare `sk-<20+ alphanumerics>` form must not start inside a word: `task-`, `risk-` and
	// `disk-` followed by a long id are names, not keys. The `ant-` and `proj-` forms are specific
	// enough to match anywhere.
	safe = replaceAndCount(safe, /sk-(?:ant-[A-Za-z0-9_-]{16,}|proj-[A-Za-z0-9_-]{16,})\b|(?<![A-Za-z0-9])sk-[A-Za-z0-9]{20,}\b/g, REDACTED, "provider-token", options);
	safe = replaceAndCount(safe, /\b(?:xox[baprs]-[A-Za-z0-9-]{20,}|ya29\.[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35})\b/g, REDACTED, "provider-token", options);
	safe = replaceAndCount(safe, /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED, "jwt-oauth", options);
	safe = replaceAndCount(safe, /\b(?:AKIA|ASIA|AIDA|AROA)[A-Z0-9]{16}\b/g, REDACTED, "cloud-access-id", options);
	safe = replaceAndCount(safe, /\b(account[_-]?id\s*[:=]\s*)(["'])(?:\\.|(?!\2)[^\r\n])*\2/gi, (match: string, prefix: string) => `${prefix}${REDACTED}`, "account-id", options);
	safe = replaceAndCount(safe, /\b(account[_-]?id\s*[:=]\s*)[^\s,;}'"]+/gi, (match: string, prefix: string) => `${prefix}${REDACTED}`, "account-id", options);
	safe = replaceAndCount(safe, new RegExp(`\\b(${assignment}\\s*[:=]\\s*)(["'])(?:\\\\.|(?!\\2)[^\\r\\n])*\\2`, "gi"), (match: string, prefix: string) => `${prefix}${REDACTED}`, "secret-assignment", options);
	safe = replaceAndCount(safe, new RegExp(`\\b(${assignment}\\s*[:=]\\s*)[^\\s,;}'"]+`, "gi"), (match: string, prefix: string) => `${prefix}${REDACTED}`, "secret-assignment", options);
	safe = replaceAndCount(safe, /\b([a-z][a-z0-9+.-]*:\/\/)[^\s\/@?#]+@/gi, (match: string, scheme: string) => `${scheme}${REDACTED}@`, "uri-userinfo", options);
	safe = replaceAndCount(safe, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/gi, REDACTED, "email", options);
	// Preserved only when the caller explicitly opts in (memory evidence keeps
	// safe handoff locators). Default behavior is unchanged.
	if (!options?.preservePaths) {
		safe = replaceAndCount(safe, /(?:^|(?<=\s))(?:~\/|\/home\/[^\s/]+\/|[A-Z]:\\Users\\[^\s\\]+\\)[^\s"'<>]*/g, REDACTED, "filesystem-path", options);
	}
	return safe;
}

function normalizeKey(key: string): string { return key.replace(/[^a-z0-9]/gi, "").toLowerCase(); }

/** Recursively redact strings and whole values under sensitive/configured JSON keys. */
export function redactSensitiveData<T>(value: T, options?: RedactionOptions): T {
	const denied = new Set([...DEFAULT_DENYLISTED_KEYS, ...(options?.denylistedKeys ?? [])].map(normalizeKey));
	const visit = (item: unknown): unknown => {
		if (typeof item === "string") return redactSensitiveText(item, options);
		if (Array.isArray(item)) return item.map(visit);
		if (item && typeof item === "object") {
			return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([key, child]) => {
				if (denied.has(normalizeKey(key))) {
					note(options, "denylisted-key");
					return [key, REDACTED];
				}
				return [key, visit(child)];
			}));
		}
		return item;
	};
	return visit(value) as T;
}

export interface ScrubCounts {
	filesScanned: number;
	filesChanged: number;
	recordsChanged: number;
	recordsMalformed: number;
	recordsSkipped: number;
}

function validUtf8SequenceLength(bytes: Buffer, offset: number): number {
	const first = bytes[offset]!;
	if (first <= 0x7f) return 1;
	const second = bytes[offset + 1];
	const third = bytes[offset + 2];
	const fourth = bytes[offset + 3];
	const continuation = (byte: number | undefined) => byte !== undefined && byte >= 0x80 && byte <= 0xbf;
	if (first >= 0xc2 && first <= 0xdf && continuation(second)) return 2;
	if (first === 0xe0 && second !== undefined && second >= 0xa0 && second <= 0xbf && continuation(third)) return 3;
	if (((first >= 0xe1 && first <= 0xec) || (first >= 0xee && first <= 0xef)) && continuation(second) && continuation(third)) return 3;
	if (first === 0xed && second !== undefined && second >= 0x80 && second <= 0x9f && continuation(third)) return 3;
	if (first === 0xf0 && second !== undefined && second >= 0x90 && second <= 0xbf && continuation(third) && continuation(fourth)) return 4;
	if (first >= 0xf1 && first <= 0xf3 && continuation(second) && continuation(third) && continuation(fourth)) return 4;
	if (first === 0xf4 && second !== undefined && second >= 0x80 && second <= 0x8f && continuation(third) && continuation(fourth)) return 4;
	return 0;
}

/** Redact recognizable text in malformed input while retaining invalid bytes outside redacted spans. */
function redactMalformedBytes(bytes: Buffer): Buffer {
	let markerPrefix = "ZPIINVALIDBYTE";
	while (bytes.includes(Buffer.from(markerPrefix, "ascii"))) markerPrefix += "Z";
	const invalidBytes: number[] = [];
	const decoded: string[] = [];
	let validStart = 0;
	let offset = 0;
	while (offset < bytes.length) {
		const length = validUtf8SequenceLength(bytes, offset);
		if (length > 0) {
			offset += length;
			continue;
		}
		if (validStart < offset) decoded.push(bytes.subarray(validStart, offset).toString("utf8"));
		const index = invalidBytes.push(bytes[offset]!) - 1;
		decoded.push(`${markerPrefix}${index.toString(36)}Z`);
		offset++;
		validStart = offset;
	}
	if (validStart < bytes.length) decoded.push(bytes.subarray(validStart).toString("utf8"));

	const safeText = redactSensitiveText(decoded.join(""));
	const marker = new RegExp(`${markerPrefix}([0-9a-z]+)Z`, "g");
	const parts: Buffer[] = [];
	let textOffset = 0;
	for (let match = marker.exec(safeText); match; match = marker.exec(safeText)) {
		parts.push(Buffer.from(safeText.slice(textOffset, match.index), "utf8"));
		parts.push(Buffer.from([invalidBytes[Number.parseInt(match[1]!, 36)]!]));
		textOffset = match.index + match[0].length;
	}
	parts.push(Buffer.from(safeText.slice(textOffset), "utf8"));
	return Buffer.concat(parts);
}

/** Atomically scrub a bounded set of JSONL files, returning counts only. */
export function scrubImprovementJsonlFiles(directory = IMPROVEMENTS_DIR): ScrubCounts {
	const counts: ScrubCounts = {
		filesScanned: 0,
		filesChanged: 0,
		recordsChanged: 0,
		recordsMalformed: 0,
		recordsSkipped: 0,
	};
	if (!existsSync(directory)) return counts;
	const names = readdirSync(directory)
		.filter((entry) => entry.endsWith(".jsonl"))
		.sort()
		.slice(0, MAX_JSONL_FILES);
	for (const name of names) {
		const path = join(directory, name);
		const metadata = statSync(path);
		if (!metadata.isFile() || metadata.size > MAX_JSONL_FILE_BYTES) continue;
		counts.filesScanned++;
		const original = readFileSync(path);
		const scrubbedParts: Buffer[] = [];
		let offset = 0;
		while (offset < original.length) {
			const newline = original.indexOf(0x0a, offset);
			const end = newline === -1 ? original.length : newline;
			const line = original.subarray(offset, end);
			let scrubbedLine: Buffer = Buffer.from(line);
			if (line.toString("utf8").trim().length === 0) {
				counts.recordsSkipped++;
			} else {
				try {
					const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
					const safe = Buffer.from(JSON.stringify(redactSensitiveData(JSON.parse(text))), "utf8");
					if (!safe.equals(line)) counts.recordsChanged++;
					scrubbedLine = safe;
				} catch {
					counts.recordsMalformed++;
					counts.recordsSkipped++;
					const safe = redactMalformedBytes(line);
					if (!safe.equals(line)) counts.recordsChanged++;
					scrubbedLine = safe;
				}
			}
			scrubbedParts.push(scrubbedLine);
			if (newline === -1) break;
			scrubbedParts.push(Buffer.from("\n"));
			offset = newline + 1;
		}
		const scrubbed = Buffer.concat(scrubbedParts);
		if (scrubbed.equals(original)) continue;
		const temporary = `${path}.redact-${process.pid}.tmp`;
		try {
			writeFileSync(temporary, scrubbed, { mode: metadata.mode });
			renameSync(temporary, path);
			counts.filesChanged++;
		} finally {
			if (existsSync(temporary)) unlinkSync(temporary);
		}
	}
	return counts;
}
