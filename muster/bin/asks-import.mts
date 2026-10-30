#!/usr/bin/env node
/**
 * AK6 of `plans/muster-autonomy/operator-queue-proposal-2026-10-16.md`: the import
 * of today's open items into the operator's ask queue, with a manifest.
 *
 * The sources are the six live lists the proposal names, read in order. Every
 * imported ask is raised through the queue's own owner (`extensions/muster/asks.ts`),
 * so this script is a reader of the lists and a writer of the one event file —
 * never a second store or a second event format. Each `raised` event carries its
 * `source` as `<file>:<line>`; a source line already present in the queue is
 * skipped, so a second `--apply` adds nothing. A struck row (markdown `~~…~~`)
 * imports as `done`, with the source row as its evidence.
 *
 * The dry run is the default and writes nothing: it prints the manifest. `--apply`
 * appends the events and writes `state/muster/asks/import-manifest-<date>.md`,
 * and only when it recorded something new — a second apply leaves both files as
 * the first one left them. The writer is the process, resolved by the queue's own
 * rule: the operator's shell writes as `operator-shell`, a session holding the architect
 * or orchestrator seat writes as that role, and a lane is refused because lanes
 * ask the orchestrator.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
	CLOSED_ASK_STATUSES,
	asksDir,
	finishAsk,
	noteAsk,
	raiseAsk,
	readAsks,
	resolveAskWriter,
	type Ask,
	type AskQueue,
	type AskWriter,
} from "../asks.ts";
import { musterStateDir } from "../binding.ts";
import {
	REPO_SOURCE_PATHS,
	clean,
	parseDesignSnapshot,
	parseOrchestratorSnapshot,
	textMatch,
	type ImportCandidate,
} from "../asks-import-lib.ts";

// ─── Sources ─────────────────────────────────────────────────────────────────

/** The BE decision record: the rulings; rows that say they wait on the operator are import candidates. */
export const DEFAULT_BE_DECISIONS = "~/projects/crm-app/docs/plans/decisions-2026-10-02.md";
/** Global memory's manual-action list. */
export const DEFAULT_PENDING_ACTIONS = "~/.claude/projects/-home-operator/memory/pending_actions.md";

export type ImportOptions = {
	root: string;
	beDecisions: string;
	pendingActions: string;
	stateDir: string;
	date: string;
	apply: boolean;
};

// ─── Text helpers ────────────────────────────────────────────────────────────

function splitCells(line: string): string[] {
	return line
		.split("|")
		.slice(1, -1)
		.map((cell) => cell.trim());
}

// ─── Parsers, one per source ─────────────────────────────────────────────────

/**
 * `operator-only-list.md`: the VH and VD tables. A struck row keeps its note (the
 * third column) and imports as `done`.
 */
export function parseOperatorList(file: string, text: string): ImportCandidate[] {
	const rows: ImportCandidate[] = [];
	text.split("\n").forEach((line, index) => {
		const trimmed = line.trim();
		if (!trimmed.startsWith("|")) return;
		const cells = splitCells(trimmed);
		if (cells.length < 3) return;
		const code = clean(cells[0]!);
		if (code === "" || /^-+$/.test(code) || code.toLowerCase() === "code") return;
		const struck = cells[0]!.includes("~~") || cells[1]!.includes("~~");
		const question = clean(cells[1]!);
		if (question === "") return;
		rows.push({
			token: `${file}:${index + 1}`,
			file,
			line: index + 1,
			code,
			question,
			kind: code.startsWith("VH") ? "operator-action" : "product-decision",
			struck,
			...(struck && clean(cells[2]!) !== "" ? { note: clean(cells[2]!) } : {}),
		});
	});
	return rows;
}

/** `design-inbox.md`: the DQ lines still marked `open`. */
export function parseDesignInbox(file: string, text: string): ImportCandidate[] {
	const rows: ImportCandidate[] = [];
	text.split("\n").forEach((line, index) => {
		const match = /^(DQ\d+)\s*\|\s*([^|]*)\|(.*)$/.exec(line.trim());
		if (match === null) return;
		const status = match[2]!.trim();
		if (!/^open\b/i.test(status)) return;
		const cells = line.trim().split("|").map((cell) => cell.trim());
		const question = clean(cells[2] ?? "");
		if (question === "") return;
		rows.push({
			token: `${file}:${index + 1}`,
			file,
			line: index + 1,
			code: match[1]!,
			question,
			kind: "product-decision",
			struck: false,
		});
	});
	return rows;
}

/**
 * The BE decision record: a row that says the item waits on the operator. The row is
 * matched as a whole (the operator and the wait word may sit in different sentences),
 * and the question is the sentence that carries the wait. A negated row
 * ("does not wait") is listed and skipped.
 */
export function parseBeDecisions(file: string, text: string): ImportCandidate[] {
	const rows: ImportCandidate[] = [];
	const waitWord = /\b(wait|waits|waiting|waited)\b|\bheld for\b|\bpending\b/i;
	const negation = /\b(does not|do not|no longer|never)\s+wait/i;
	text.split("\n").forEach((line, index) => {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("|")) return;
		if (!/\bOperator\b/.test(trimmed) || !waitWord.test(trimmed)) return;
		const sentence = trimmed.split(/(?<=[.;])\s+/).find((part) => waitWord.test(part)) ?? trimmed;
		const question = clean(sentence.replace(/^[-*\d.]+\s*/, ""));
		if (question === "") return;
		rows.push({
			token: `${file}:${index + 1}`,
			file,
			line: index + 1,
			question,
			kind: "product-decision",
			struck: false,
			...(negation.test(sentence) ? { skipReason: "the row says it does not wait on the operator" } : {}),
		});
	});
	return rows;
}

/** Global memory's `pending_actions.md` table: one manual action per row, struck rows done. */
export function parsePendingActions(file: string, text: string): ImportCandidate[] {
	const rows: ImportCandidate[] = [];
	text.split("\n").forEach((line, index) => {
		const trimmed = line.trim();
		if (!trimmed.startsWith("|")) return;
		const cells = splitCells(trimmed);
		if (cells.length < 2) return;
		const action = clean(cells[0]!);
		if (action === "" || /^-+$/.test(action) || /^action$/i.test(action)) return;
		const struck = cells[0]!.includes("~~");
		rows.push({
			token: `${file}:${index + 1}`,
			file,
			line: index + 1,
			question: action,
			kind: "operator-action",
			struck,
			...(clean(cells[1]!) !== "" ? { note: clean(cells[1]!) } : {}),
		});
	});
	return rows;
}

/** Read the six sources in the order the proposal names. A missing file is reported, never fatal. */
export function collectCandidates(options: ImportOptions): { candidates: ImportCandidate[]; missing: string[] } {
	const candidates: ImportCandidate[] = [];
	const missing: string[] = [];
	const read = (file: string, path: string, parse: (file: string, text: string) => ImportCandidate[]): void => {
		try {
			candidates.push(...parse(file, readFileSync(path, "utf8")));
		} catch {
			missing.push(file);
		}
	};
	read(REPO_SOURCE_PATHS.operatorList, join(options.root, REPO_SOURCE_PATHS.operatorList), parseOperatorList);
	read(REPO_SOURCE_PATHS.designInbox, join(options.root, REPO_SOURCE_PATHS.designInbox), parseDesignInbox);
	read(options.beDecisions, options.beDecisions, parseBeDecisions);
	read(REPO_SOURCE_PATHS.orchestratorSnapshot, join(options.root, REPO_SOURCE_PATHS.orchestratorSnapshot), parseOrchestratorSnapshot);
	read(REPO_SOURCE_PATHS.designSnapshot, join(options.root, REPO_SOURCE_PATHS.designSnapshot), parseDesignSnapshot);
	read(options.pendingActions, options.pendingActions, parsePendingActions);
	return { candidates, missing };
}

// ─── The plan ────────────────────────────────────────────────────────────────

export type ImportAction =
	| { type: "raise" }
	/** A struck row: raise, then `done` with the source row as evidence. */
	| { type: "done" }
	| { type: "skip"; reason: string }
	/** The item is already an ask: this source line is recorded on it. */
	| { type: "attach"; targetId?: string; targetToken?: string; targetCode?: string; exact: boolean };

export type ImportRow = ImportCandidate & { action: ImportAction };

/** Every source token an ask already records: its `source` and its `also at` notes. */
export function sourceTokensOf(ask: Ask): string[] {
	const tokens: string[] = [];
	for (const part of (ask.source ?? "").split(",")) {
		const token = part.trim();
		if (token !== "") tokens.push(token);
	}
	for (const note of ask.notes) {
		const match = /^also at (.+)$/.exec(note);
		if (match !== null) tokens.push(match[1]!.trim());
	}
	return tokens;
}

/** The code series the queue owns; a candidate with one of these matches by code, never by text. */
const AUTHORITATIVE_CODE = /^(VH|VD|DQ)\d/;

/**
 * Decide each candidate against the existing queue and the candidates before it:
 * an already-recorded source line is skipped, a code or a near-text match attaches
 * to that ask (recording the second source), everything else is raised.
 */
export function planImport(candidates: readonly ImportCandidate[], existing: AskQueue): ImportRow[] {
	const seen = new Set<string>();
	for (const ask of existing.asks) for (const token of sourceTokensOf(ask)) seen.add(token);

	const byCode = new Map<string, Ask>();
	for (const ask of existing.asks) {
		if (ask.code !== undefined && !CLOSED_ASK_STATUSES.includes(ask.status)) byCode.set(ask.code, ask);
	}
	const pool: Ask[] = [...existing.asks];
	const newByToken = new Map<string, Ask>();

	const rows: ImportRow[] = [];
	for (const candidate of candidates) {
		if (seen.has(candidate.token)) {
			const owner = [...existing.asks, ...newByToken.values()].find((ask) => sourceTokensOf(ask).includes(candidate.token));
			rows.push({
				...candidate,
				action: { type: "skip", reason: `already imported (${owner !== undefined ? labelOf(owner) : "in the store"})` },
			});
			continue;
		}
		seen.add(candidate.token);

		if (candidate.skipReason !== undefined) {
			rows.push({ ...candidate, action: { type: "skip", reason: candidate.skipReason } });
			continue;
		}

		if (candidate.code !== undefined) {
			const target = byCode.get(candidate.code);
			if (target !== undefined) {
				rows.push({ ...candidate, action: attachAction(target, candidate.code, true) });
				continue;
			}
			// A code the queue owns (VH, VD, DQ) is authoritative: text must never fold a
			// differently coded item onto a VH/VD row and lose that ask.
			if (AUTHORITATIVE_CODE.test(candidate.code)) {
				rows.push(...raiseRow(candidate));
				continue;
			}
		}

		// Text matching is a snapshot's own route back to a VH/VD row, and only a
		// code-bearing ask can be its target: an item never disappears into a prose ask.
		let best: { ask: Ask; exact: boolean; score: number } | undefined;
		for (const ask of pool) {
			if (ask.code === undefined) continue;
			const match = textMatch(candidate.question, ask.question);
			const threshold = match.shorterSize <= 1 ? 0.5 : 0.7;
			// A one-word item may be carried by a longer word (`vpn` in `nordvpn`); a longer
			// item must share a whole word, so a coincidental phrase never folds it away.
			if (match.score < threshold || (match.shorterSize > 1 && match.exactWords === 0)) continue;
			if (best === undefined || match.score > best.score) best = { ask, exact: match.exact, score: match.score };
		}
		if (best !== undefined) {
			rows.push({ ...candidate, action: attachAction(best.ask, best.ask.code, best.exact) });
			continue;
		}

		rows.push(...raiseRow(candidate));
	}
	return rows;

	/** Record the row, and register what it raised so a later source dedupes against it. */
	function raiseRow(candidate: ImportCandidate): ImportRow[] {
		const placeholder = {
			...emptyAsk(),
			id: `pending:${candidate.token}`,
			code: candidate.code,
			question: candidate.question,
			source: candidate.token,
		} as Ask;
		pool.push(placeholder);
		newByToken.set(candidate.token, placeholder);
		if (candidate.code !== undefined) byCode.set(candidate.code, placeholder);
		return [{ ...candidate, action: candidate.struck ? { type: "done" } : { type: "raise" } }];
	}
}

/** An ask the plan only knows as a placeholder keeps its token; a real one keeps its id. */
function attachAction(target: Ask, code: string | undefined, exact: boolean): ImportAction {
	return target.id.startsWith("pending:")
		? { type: "attach", targetToken: target.id.slice("pending:".length), targetCode: code, exact }
		: { type: "attach", targetId: target.id, targetCode: code, exact };
}

/** How a row names the ask it matched or already recorded: its code, or its real id. */
function labelOf(ask: Ask): string {
	if (ask.code !== undefined) return ask.id.startsWith("pending:") ? `${ask.code} (raised in this run)` : ask.code;
	return ask.id.startsWith("pending:") ? "raised in this run" : ask.id;
}

/** Shape only: the planning pool needs `id`, `code`, `question`, `source` and `notes`. */
function emptyAsk(): Ask {
	return {
		id: "",
		code: undefined,
		kind: "product-decision",
		question: "",
		owner: undefined,
		raisedBy: "",
		raisedAt: "",
		updatedAt: "",
		source: undefined,
		link: undefined,
		card: undefined,
		blocks: [],
		status: "open",
		options: [],
		recommendation: undefined,
		ruling: undefined,
		answeredBy: undefined,
		answeredAt: undefined,
		words: undefined,
		relay: undefined,
		row: undefined,
		answeredByCard: false,
		cardState: undefined,
		evidence: undefined,
		withdrawnReason: undefined,
		notes: [],
	};
}

// ─── Apply ───────────────────────────────────────────────────────────────────

/**
 * The writer, by the queue's own rule. A lane without a seat is refused here
 * exactly as `muster ask` refuses it, so the import can never be a second way in.
 */
export function resolveImportWriter(env: NodeJS.ProcessEnv): AskWriter {
	const resolution = resolveAskWriter(env, env["CONCORD_AGENT_ID"]);
	if ("error" in resolution) throw new Error(resolution.error);
	return resolution.writer;
}

/**
 * Append the plan's events. Returns the real id of every ask it raised; the plan's
 * own ids are placeholders, because an id is only real once the event is written.
 */
export function applyImport(stateDir: string, rows: readonly ImportRow[], env: NodeJS.ProcessEnv): Map<string, string> {
	const by = resolveImportWriter(env);
	const idByToken = new Map<string, string>();
	for (const row of rows) {
		if (row.action.type === "skip") continue;
		if (row.action.type === "attach") {
			const target = row.action.targetId ?? idByToken.get(row.action.targetToken ?? "");
			if (target === undefined) throw new Error(`no ask for ${row.token}: the row it attaches to was not imported`);
			noteAsk(stateDir, { ref: target, by, text: `also at ${row.token}` });
			continue;
		}
		const ask = raiseAsk(stateDir, {
			by,
			kind: row.kind,
			question: row.question,
			...(row.code !== undefined ? { code: row.code } : {}),
			source: row.token,
		});
		idByToken.set(row.token, ask.id);
		if (row.struck) {
			if (row.note !== undefined) noteAsk(stateDir, { ref: ask.id, by, text: row.note });
			finishAsk(stateDir, { ref: ask.id, by, evidence: { row: row.code ?? `row ${row.line}`, file: row.file, line: row.line } });
		}
	}
	return idByToken;
}

// ─── The manifest ────────────────────────────────────────────────────────────

function shortened(text: string, limit = 72): string {
	const one = clean(text);
	return one.length <= limit ? one : `${one.slice(0, limit - 1)}…`;
}

function resultOf(row: ImportRow, ids: ReadonlyMap<string, string>): string {
	switch (row.action.type) {
		case "skip":
			return `skipped, ${row.action.reason}`;
		case "attach": {
			const label = row.action.targetCode ?? "the ask";
			const id = row.action.targetId ?? "raised in this run";
			return row.action.exact
				? `skipped, same item as ${label} (${id}); source recorded`
				: `review: matched to ${label} by text (${id}), not exact; source recorded`;
		}
		case "raise":
		case "done": {
			const id = ids.get(row.token);
			const base = id !== undefined ? `new ask ${id}` : "new ask (dry run)";
			return row.action.type === "done"
				? `${base}, done (row:${row.code ?? `row ${row.line}`}@${row.file}:${row.line})`
				: base;
		}
	}
}

/** One markdown table with every source line and what happened to it. */
export function renderManifest(options: ImportOptions, rows: readonly ImportRow[], missing: readonly string[], ids: ReadonlyMap<string, string>): string {
	const counts = {
		rows: rows.length,
		raised: rows.filter((row) => row.action.type !== "skip" && row.action.type !== "attach").length,
		done: rows.filter((row) => row.action.type === "done").length,
		attached: rows.filter((row) => row.action.type === "attach").length,
		review: rows.filter((row) => row.action.type === "attach" && !row.action.exact).length,
		skipped: rows.filter((row) => row.action.type === "skip").length,
	};
	const lines = [
		`# Ask import manifest — ${options.date}`,
		"",
		`Mode: ${options.apply ? "apply" : "dry run (nothing written)"}. Root: ${options.root}. Store: ${join(asksDir(options.stateDir), "events.jsonl")}.`,
		"",
		`Counts: ${counts.rows} source rows, ${counts.raised} raised (${counts.done} as done), ${counts.attached} already an ask (${counts.review} for review), ${counts.skipped} skipped.`,
		...(missing.length > 0 ? ["", `Missing sources (skipped whole): ${missing.join(", ")}`] : []),
		"",
		"| Source | Line | Item | Result |",
		"|---|---|---|---|",
	];
	for (const row of rows) {
		const item = row.code ?? shortened(row.question);
		lines.push(`| ${row.file} | ${row.line} | ${item} | ${resultOf(row, ids)} |`);
	}
	lines.push("");
	return lines.join("\n");
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = [
	"asks-import — import today's open items into the operator's ask queue (AK6, dry run by default)",
	"",
	"usage: node --import tsx scripts/asks-import.mts [--apply] [--root <dir>] [--state-dir <dir>]",
	"         [--be-decisions <path>] [--pending-actions <path>] [--date <YYYY-MM-DD>]",
	"",
	"  --apply    append the events and write the manifest (default: print the manifest, write nothing)",
	`  --root     the agent checkout the four plan lists are read from (default: the current directory)`,
	`  --be-decisions    the BE decision record (default: ${DEFAULT_BE_DECISIONS})`,
	`  --pending-actions global memory's manual-action list (default: ${DEFAULT_PENDING_ACTIONS})`,
	"  --state-dir       the Muster state directory (default: musterStateDir())",
	"  --date            the manifest's date and the day the import is filed under (default: today, UTC)",
	"",
	"Every source line is reported in the manifest with its ask id or why it was skipped. A second",
	"apply adds nothing: a source already recorded in the queue is skipped.",
].join("\n");

function expandHome(path: string): string {
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function parseArguments(argv: readonly string[]): { options: ImportOptions } | { error: string } {
	const values = new Map<string, string>();
	const valueFlags = new Set(["root", "be-decisions", "pending-actions", "state-dir", "date"]);
	let apply = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]!;
		if (arg === "--help" || arg === "-h") return { error: USAGE };
		if (arg === "--apply") {
			apply = true;
			continue;
		}
		if (!arg.startsWith("--")) return { error: `unexpected argument ${JSON.stringify(arg)}\n\n${USAGE}` };
		const name = arg.slice(2);
		if (!valueFlags.has(name)) return { error: `unknown flag --${name}\n\n${USAGE}` };
		const value = argv[index + 1];
		if (value === undefined || value.startsWith("--")) return { error: `--${name} needs a value\n\n${USAGE}` };
		values.set(name, value);
		index += 1;
	}
	const root = resolve(expandHome(values.get("root") ?? process.cwd()));
	const beDecisions = resolve(expandHome(values.get("be-decisions") ?? DEFAULT_BE_DECISIONS));
	const pendingActions = resolve(expandHome(values.get("pending-actions") ?? DEFAULT_PENDING_ACTIONS));
	return {
		options: {
			root,
			beDecisions,
			pendingActions,
			stateDir: resolve(expandHome(values.get("state-dir") ?? musterStateDir())),
			date: values.get("date") ?? new Date().toISOString().slice(0, 10),
			apply,
		},
	};
}

/** The whole run: read, plan, optionally apply, print the manifest. Returns the exit code. */
export function runImport(
	options: ImportOptions,
	env: NodeJS.ProcessEnv = process.env,
	out: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): number {
	const { candidates, missing } = collectCandidates(options);
	const existing = readAsks(options.stateDir);
	const rows = planImport(candidates, existing);
	if (!options.apply) {
		out(renderManifest(options, rows, missing, new Map()));
		const raised = rows.filter((row) => row.action.type !== "skip" && row.action.type !== "attach").length;
		out(
			`asks-import: ${candidates.length} source rows, ${raised} to raise, ${rows.length - raised} skipped or already an ask; dry run, nothing written`,
		);
		return 0;
	}
	const ids = applyImport(options.stateDir, rows, env);
	const manifest = renderManifest(options, rows, missing, ids);
	const path = join(asksDir(options.stateDir), `import-manifest-${options.date}.md`);
	if (ids.size === 0) {
		out(`asks-import: nothing new to import; the store and ${path} are unchanged`);
		return 0;
	}
	mkdirSync(asksDir(options.stateDir), { recursive: true });
	writeFileSync(path, manifest, { mode: 0o600 });
	out(manifest);
	out(`asks-import: ${ids.size} new asks written to ${join(asksDir(options.stateDir), "events.jsonl")}; manifest ${path}`);
	return 0;
}

export async function main(): Promise<void> {
	const parsed = parseArguments(process.argv.slice(2));
	if ("error" in parsed) {
		process.stderr.write(`${parsed.error}\n`);
		process.exitCode = 2;
		return;
	}
	try {
		process.exitCode = runImport(parsed.options);
	} catch (error) {
		process.stderr.write(`asks-import: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 2;
	}
}

// Run only as the start file `scripts/asks-import.mts`. The name is checked because a bundle that includes this
// module has its own URL as `process.argv[1]`: `claude-hook.bundle.mjs` reads the ask queue through `asks.ts`
// (VR24-230 AC2), and an unprefixed guard ran the importer at every hook event.
const startFile = process.argv[1];
if (startFile?.endsWith("asks-import.mts") && import.meta.url === pathToFileURL(startFile).href) {
	await main();
}
