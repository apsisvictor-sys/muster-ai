/**
 * The lane classifier (auto-routing blueprint 2026-10-25, section 4.3 and the AR4 row, VR24-100).
 *
 * A lane's kind decides the class it runs hard or flash on, so it has to be decided before the lane
 * launches. This module decides it from structured inputs only: the brief's owned paths, its project,
 * and the flags the orchestrator sets from what it knows when it writes the brief. It never reads
 * brief prose, because keyword guessing on prose is the flaky part.
 *
 * Rules, in the blueprint's order, first match wins:
 *
 * | Rule | Condition | Result |
 * |---|---|---|
 * | R1 | `retry` | `retry`, H1 |
 * | R2 | an owned path is a migration, an auth or permission owner, a data-write path, or a lock or concurrency owner | `security-data`, H4 |
 * | R3 | `causeUnknown` | `unknown-cause-bug`, H2 |
 * | R4 | an owned path is a shared owner | `shared-owner`, H3 |
 * | R5 | `perf` | `perf`, H5 |
 * | R6 | the owned paths are only tests, only docs, only config, only adapter files, or only copy or a screen | `test`, `docs`, `config`, `adapter`, `copy`, `ui` |
 * | R7 | `readsOnly` and no owned path | `research-read` |
 * | R8 | `review` or `productPass` | `review`, `product-pass` |
 * | none | no rule matched, or two rules of different class matched | `unclear` |
 *
 * Two rules that agree on the class are not a conflict: the earlier rule answers, so `review` and
 * `productPass` together answer `review`. Two rules of different class answer `unclear`, and
 * `unclear` is never turned into a default kind: the orchestrator classes the lane by hand, as
 * today, and the lane record says `rule: none`.
 *
 * The path patterns are data (`routing.kindRules` in `provider-pool.json`, per project), never code
 * and never a second list in this file. A project without patterns answers `unclear` for R2, R4 and
 * R6, which are the three rules that read the table, rather than guessing.
 *
 * Nothing calls this module yet: `routing.pick` ships `off` and AR6 is the caller that places a lane
 * by the answer.
 */

import { TASK_KIND_CLASS, type TaskKind, type TaskKindClass, type PoolRouting } from "./provider-pool.ts";

/** The rule that answered. `none` is the lane record's word for `unclear` (blueprint 4.3). */
export type LaneKindRule = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8" | "none";

/** The `routing.kindRules` table itself: project -> kind -> path patterns. The owner is `parseRouting`. */
export type LaneKindRules = PoolRouting["kindRules"];

/**
 * What the orchestrator knows when it briefs a lane. `paths` is the brief's owned paths and
 * `project` is the project whose `kindRules` entry classifies them. The flags are the six the
 * blueprint names; nothing else is read.
 */
export interface LaneKindInput {
	/** The brief's owned paths, as the brief writes them. */
	paths?: readonly string[];
	/** The project the lane works in, keyed into `kindRules`. */
	project?: string;
	/** An earlier attempt was sent back or failed Done. */
	retry?: boolean;
	/** The cause is not known yet. */
	causeUnknown?: boolean;
	/** The lane is about performance. */
	perf?: boolean;
	/** The lane reads and writes no file of any project. */
	readsOnly?: boolean;
	/** A Fix-gate independent review. */
	review?: boolean;
	/** The BE W9 pass on the product model. */
	productPass?: boolean;
}

/** A decided lane: the kind, its class, the rule that answered, and why. */
export interface LaneKindDecided {
	kind: TaskKind;
	class: TaskKindClass;
	rule: Exclude<LaneKindRule, "none">;
	reason: string;
}

/** No rule answered, or two rules of different class disagreed. The orchestrator classes it by hand. */
export interface LaneKindUnclear {
	kind: "unclear";
	class: null;
	rule: "none";
	reason: string;
}

export type LaneKindDecision = LaneKindDecided | LaneKindUnclear;

/** R6's kinds, in the order the blueprint lists them. All flash, so their order never decides a class. */
const R6_KINDS: readonly TaskKind[] = ["test", "docs", "config", "adapter", "copy", "ui"];

const compiled = new Map<string, RegExp>();

/**
 * One path, normalized for matching: no `./` prefix, no repeated or trailing separator. A path keeps
 * its own `~`, because a brief names a research directory that way and the pattern says the same.
 */
function normalizePath(value: string): string {
	let path = value.trim().replace(/\\/g, "/");
	if (path.startsWith("./")) path = path.slice(2);
	return path.replace(/\/{2,}/g, "/");
}

/**
 * A pattern is a path glob, anchored at both ends:
 * - `**` matches any run of characters including `/`, and `**​/` also matches nothing, so `a/**​/b`
 *   matches `a/b`;
 * - `*` matches any run inside one segment and never crosses `/`;
 * - `?` matches one character that is not `/`;
 * - a trailing `/` is shorthand for `/**`, so `docs/` matches every path under `docs`.
 *
 * A pattern without a wildcard matches that exact path only: `vercel.json` is the root file, and
 * `**​/vercel.json` is any of them.
 */
function patternToRegExp(pattern: string): RegExp {
	const cached = compiled.get(pattern);
	if (cached) return cached;
	let source = "";
	const path = normalizePath(pattern).replace(/\/$/, "/**");
	for (let index = 0; index < path.length; index += 1) {
		const char = path[index];
		if (char === "*") {
			if (path[index + 1] === "*") {
				index += 1;
				if (path[index + 1] === "/") {
					index += 1;
					source += "(?:.*/)?";
				} else {
					source += ".*";
				}
			} else {
				source += "[^/]*";
			}
			continue;
		}
		if (char === "?") {
			source += "[^/]";
			continue;
		}
		source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	const regex = new RegExp(`^${source}$`);
	compiled.set(pattern, regex);
	return regex;
}

/** Whether one owned path matches one pattern. */
export function matchesPattern(path: string, pattern: string): boolean {
	return patternToRegExp(pattern).test(normalizePath(path));
}

/** The first owned path that matches one of a kind's patterns, or `undefined`. */
function firstMatchingPath(paths: readonly string[], patterns: readonly string[] | undefined): string | undefined {
	if (!patterns || patterns.length === 0) return undefined;
	for (const path of paths) {
		for (const pattern of patterns) if (matchesPattern(path, pattern)) return path;
	}
	return undefined;
}

/** Whether every owned path matches one of a kind's patterns: R6's "only tests", "only docs". */
function pathsMatchOnly(paths: readonly string[], patterns: readonly string[] | undefined): boolean {
	if (paths.length === 0 || !patterns || patterns.length === 0) return false;
	return paths.every((path) => patterns.some((pattern) => matchesPattern(path, pattern)));
}

function quote(value: string): string {
	return `"${value}"`;
}

/**
 * Which rules matched, in blueprint order. Each candidate carries its own reason so the answer can
 * say what fired, and a conflict can name both sides.
 */
function candidates(input: LaneKindInput, kindRules: LaneKindRules): LaneKindDecided[] {
	const paths = (input.paths ?? []).map(normalizePath).filter((path) => path !== "");
	const project = input.project?.trim();
	const table = project ? kindRules[project] : undefined;
	const found: LaneKindDecided[] = [];
	const add = (kind: TaskKind, rule: LaneKindDecided["rule"], reason: string) =>
		found.push({ kind, class: TASK_KIND_CLASS[kind], rule, reason });

	if (input.retry) add("retry", "R1", "--retry: an earlier attempt was sent back or failed Done");

	const security = firstMatchingPath(paths, table?.["security-data"]);
	if (security !== undefined) {
		add("security-data", "R2", `owned path ${quote(security)} is a migration, auth or permission owner, data-write path, or lock or concurrency owner`);
	}

	if (input.causeUnknown) add("unknown-cause-bug", "R3", "--cause-unknown: the cause is not known yet");

	const shared = firstMatchingPath(paths, table?.["shared-owner"]);
	if (shared !== undefined) add("shared-owner", "R4", `owned path ${quote(shared)} is a shared owner`);

	if (input.perf) add("perf", "R5", "--perf: the lane is about performance");

	for (const kind of R6_KINDS) {
		if (pathsMatchOnly(paths, table?.[kind])) {
			add(kind, "R6", `every owned path is ${kind === "ui" ? "a screen" : kind === "copy" ? "copy" : kind} (${paths.join(", ")})`);
			break;
		}
	}

	if (input.readsOnly && paths.length === 0) add("research-read", "R7", "--reads-only with no owned path");

	if (input.review) add("review", "R8", "--review: a Fix-gate independent review");
	if (input.productPass) add("product-pass", "R8", "--product-pass: the BE W9 pass on the product model");

	return found;
}

/**
 * Classify a lane into a kind, or say `unclear`. Pure: the same inputs and the same `kindRules`
 * always answer the same way, and nothing here reads a file, a clock or a model.
 */
export function classifyLane(input: LaneKindInput, kindRules: LaneKindRules): LaneKindDecision {
	const found = candidates(input, kindRules);
	if (found.length === 0) {
		const project = input.project?.trim();
		const table = project ? kindRules[project] : undefined;
		const why = !project
			? "no project was named, so R2, R4 and R6 had no patterns"
			: !table || Object.keys(table).length === 0
				? `project ${quote(project)} has no kind patterns`
				: `project ${quote(project)} has no pattern for the owned paths`;
		return { kind: "unclear", class: null, rule: "none", reason: `no rule matched (${why})` };
	}
	const [first] = found;
	const classes = new Set(found.map((match) => match.class));
	if (classes.size > 1) {
		const named = found.map((match) => `${match.rule} (${match.class})`).join(" and ");
		return { kind: "unclear", class: null, rule: "none", reason: `${named} disagree on the class` };
	}
	return first;
}

/** Whether the answer is `unclear`, for a caller that wants the flag rather than the shape. */
export function isUnclear(decision: LaneKindDecision): decision is LaneKindUnclear {
	return decision.kind === "unclear";
}
