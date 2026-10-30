/**
 * `extensions/muster/asks-import-lib.ts` — the shared parsers and text rules of
 * the asks import (AK6 of `plans/muster-autonomy/operator-queue-proposal-2026-10-16.md`,
 * S11 of `plans/repo/modular-repo-blueprint-2026-10-17.md`).
 *
 * The import script (`scripts/asks-import.mts`) and the transcript scan
 * (`asks-scan.ts`) share these symbols; this file is their one owner. Nothing
 * here derives a path from this file's own location (S10): `REPO_SOURCE_PATHS`
 * stays relative, and every caller resolves it against its own root — the agent
 * folder in production.
 */

import type { AskKind } from "./asks.ts";

/** The four lists inside the agent checkout, relative to `--root`. */
export const REPO_SOURCE_PATHS = {
	operatorList: "plans/orchestration-2026-10-05/handoffs/operator-only-list.md",
	designInbox: "plans/orchestration-2026-10-05/design-inbox.md",
	orchestratorSnapshot: "plans/orchestration-2026-10-05/handoffs/orchestrator-snapshot.md",
	designSnapshot: "plans/orchestration-2026-10-05/handoffs/design-snapshot.md",
} as const;

/** One candidate row, exactly as it reads at its source line. */
export type ImportCandidate = {
	/** `file:line` as the ask's `source`, and the import's own skip key. */
	token: string;
	/** The file as cited: a path relative to the root, or an absolute path outside it. */
	file: string;
	line: number;
	code?: string;
	question: string;
	kind: AskKind;
	/** A struck row (markdown `~~…~~`): imported as `done`. */
	struck: boolean;
	/** The struck row's note, recorded before the `done`. */
	note?: string;
	/** Set by a parser for a row that is visible but not imported. */
	skipReason?: string;
};

// ─── Text helpers ────────────────────────────────────────────────────────────

/** Strip markdown emphasis, collapse whitespace: one line, as the operator reads it. */
export function clean(text: string): string {
	return text
		.replace(/~~/g, "")
		.replace(/\*\*/g, "")
		.replace(/`/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

const STOPWORDS = new Set([
	"the", "and", "for", "with", "from", "that", "this", "then", "than", "when", "what", "into", "once", "over",
	"only", "your", "you", "are", "not", "but", "him", "his", "its", "all", "any", "some", "has", "have", "was",
	"were", "will", "would", "can", "cannot", "out", "off", "one", "two", "must", "may", "new", "use", "used",
	"using", "get", "got", "who", "why", "how", "does", "did", "doing", "done", "add", "also", "more", "less",
	"now", "next", "last", "first", "second", "then", "per", "via", "not", "yet", "keep", "keeps", "each", "every",
]);

/** The words a text-match is decided on: lowercase alphanumeric runs of three or more, without stopwords. */
export function tokensOf(text: string): Set<string> {
	const words = clean(text).toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
	return new Set(words.filter((word) => !STOPWORDS.has(word)));
}

/**
 * How close two one-line items are. `exact` when one item's words are all in the
 * other's (the shorter has at least two), `score` the share of the shorter item's
 * words the other carries, counting a word that only appears inside a longer one
 * (`vpn` in `nordvpn`). `shorterSize` and `exactWords` let the caller pick a bar:
 * a one-word item is allowed a fuzzier one, a longer one is not.
 */
export function textMatch(left: string, right: string): { exact: boolean; score: number; shorterSize: number; exactWords: number } {
	const a = tokensOf(left);
	const b = tokensOf(right);
	if (a.size === 0 || b.size === 0) return { exact: false, score: 0, shorterSize: 0, exactWords: 0 };
	const shorter = a.size <= b.size ? a : b;
	const longer = a.size <= b.size ? b : a;
	let weight = 0;
	let exactWords = 0;
	for (const word of shorter) {
		if (longer.has(word)) {
			weight += 1;
			exactWords += 1;
			continue;
		}
		for (const other of longer) {
			if (other.length >= 4 && (other.includes(word) || word.includes(other))) {
				weight += 0.5;
				break;
			}
		}
	}
	const score = weight / shorter.size;
	const exact = clean(left).toLowerCase() === clean(right).toLowerCase() || (shorter.size >= 2 && exactWords === shorter.size);
	return { exact, score, shorterSize: shorter.size, exactWords };
}

// ─── Parsers, one per source ─────────────────────────────────────────────────

/** The orchestrator snapshot's `Waits on the operator:` line: `;`-separated `H1 …`, `D5 …`. */
export function parseOrchestratorSnapshot(file: string, text: string): ImportCandidate[] {
	const rows: ImportCandidate[] = [];
	text.split("\n").forEach((line, index) => {
		const match = /^Waits on the operator:(.*)$/.exec(line.trim());
		if (match === null) return;
		const items = match[1]!.split(";").map((item) => clean(item).replace(/\.$/, ""));
		items.forEach((item, at) => {
			if (item === "") return;
			const coded = /^([A-Za-z][A-Za-z0-9.]*\d+)\s+(.*)$/.exec(item);
			const code = coded?.[1];
			const question = clean(coded?.[2] ?? item);
			if (question === "") return;
			rows.push({
				token: itemToken(file, index + 1, at, items.length),
				file,
				line: index + 1,
				...(code !== undefined ? { code } : {}),
				question,
				kind: code?.startsWith("H") === true ? "operator-action" : "product-decision",
				struck: false,
			});
		});
	});
	return rows;
}

/**
 * One source line can hold several items; then each item's token names its place
 * on the line (`file:line#k`), because `file:line` alone would make the second
 * item look like a source the first one already imported.
 */
function itemToken(file: string, line: number, at: number, count: number): string {
	return count === 1 ? `${file}:${line}` : `${file}:${line}#${at + 1}`;
}

/** The design snapshot's `## the operator's list` section: `;`-separated items, no codes. */
export function parseDesignSnapshot(file: string, text: string): ImportCandidate[] {
	const rows: ImportCandidate[] = [];
	const lines = text.split("\n");
	let inSection = false;
	lines.forEach((line, index) => {
		const heading = /^##\s+(.*)$/.exec(line.trim());
		if (heading !== null) {
			inSection = clean(heading[1]!).toLowerCase() === "operator's list";
			return;
		}
		if (!inSection) return;
		const items = line.split(";");
		items.forEach((item, at) => {
			const question = clean(item.replace(/^V\d+\s+/, ""));
			if (question === "") return;
			rows.push({
				token: itemToken(file, index + 1, at, items.length),
				file,
				line: index + 1,
				question,
				kind: "product-decision",
				struck: false,
			});
		});
	});
	return rows;
}
