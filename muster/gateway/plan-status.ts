/**
 * `plan_status` (HO8 of `plans/muster-autonomy/henry-observability-blueprint-2026-10-17.md`).
 *
 * One data file holds one entry per plan item, the plans it covers and where it came from:
 * `~/.pi/agent/plans/status/plan-status.json`. The architect seeds it from the verified gap
 * audit (offload-0004); the orchestrator updates the entries a merge settles, in the same
 * commit as its snapshot replace. This module is the tool's only owner: it reads the file,
 * filters it by plan and state, and checks every SHA-shaped evidence entry against the
 * repositories the gateway already reads (`git_log`'s catalogue repositories).
 *
 * Read-only: it never writes the file, and it changes nothing it reads.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defaultGitRepos, execGit, type GitExec, type NamedDir } from "./knowledge.ts";

/** The states the seeded file uses. The tool filters by them and the schema offers them. */
export const PLAN_STATUS_STATES = ["done", "partly", "not-done", "dropped", "held"] as const;

export type PlanStatusState = (typeof PLAN_STATUS_STATES)[number];

/** One plan item, exactly as the seeded file holds it. */
export type PlanStatusItem = {
	/** The plan's id, one of the file's `plans`. */
	plan: string;
	/** The plan's own item code, such as `0.1`, `UM14` or `P6`. */
	code: string;
	title: string;
	state: PlanStatusState;
	/** Commits (short hex) and paths, as the gap audit cited them. */
	evidence: string[];
	/** The lanes that carry the item, if any. */
	lanes: string[];
	/** What the audit could not verify, `null` when nothing is missing. */
	missing: string | null;
	updatedAt: string;
};

/** The file: `plans` names the plans it covers, `items` carries one entry per plan item. */
export type PlanStatusFile = {
	version?: number;
	seededBy?: string;
	source?: string;
	seededAt?: string;
	plans: string[];
	items: PlanStatusItem[];
};

/** The tool's own refusals: an unreadable or malformed file, an unknown plan or state. */
export class PlanStatusRefusal extends Error {}

/** The seams the tool takes: the file, one git call, and the repositories evidence is looked for in. */
export type PlanStatusDeps = {
	/** The seeded file. Default `planStatusPath()` (`PI_PLAN_STATUS_PATH` overrides it). */
	path?: string;
	/** One git call with a fixed argv and no shell. Default `execGit`. */
	git?: GitExec;
	/** The repositories an evidence SHA may live in: the catalogue repositories `git_log` reads. Default `defaultGitRepos(home)`. */
	repositories?: NamedDir[];
	/** The home the default repositories resolve under. */
	home?: string;
};

export type PlanStatusQuery = {
	plan?: string;
	state?: string;
};

/** A commit-shaped evidence entry: the audit cites short commits as bare hex, 7 to 40 characters. */
const EVIDENCE_SHA = /^[0-9a-f]{7,40}$/;

/** Evidence a repository holds, one repository named; `missing` when no repository holds it. */
type EvidenceCheck = { repository: string; found: true } | { found: false; checked: boolean };

export function planStatusDefaultPath(): string {
	return join(homedir(), ".pi", "agent", "plans", "status", "plan-status.json");
}

/** The seeded file's path; `PI_PLAN_STATUS_PATH` overrides it, so a test never reads the live one. */
export function planStatusPath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env["PI_PLAN_STATUS_PATH"]?.trim();
	return override !== undefined && override !== "" ? resolve(override) : planStatusDefaultPath();
}

export function isPlanStatusState(value: string): value is PlanStatusState {
	return (PLAN_STATUS_STATES as readonly string[]).includes(value);
}

function stringArray(value: unknown, where: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new PlanStatusRefusal(`${where} must be an array of strings`);
	return value as string[];
}

/**
 * The seeded file as it stands. The shape is the architect's (the schema is seeded, not changed
 * here): a missing or malformed file is a refusal naming the path, never an empty register.
 */
export function readPlanStatus(path: string = planStatusPath()): PlanStatusFile {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw new PlanStatusRefusal(`the plan-status file could not be read at ${path}: ${(error as Error).message}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new PlanStatusRefusal(`the plan-status file at ${path} is not valid JSON: ${(error as Error).message}`);
	}
	if (typeof parsed !== "object" || parsed === null) throw new PlanStatusRefusal(`the plan-status file at ${path} is not an object`);
	const file = parsed as Partial<PlanStatusFile>;
	if (!Array.isArray((parsed as { items?: unknown }).items)) throw new PlanStatusRefusal(`the plan-status file at ${path} has no items array`);
	const items = ((parsed as { items: unknown[] }).items).map((entry, index): PlanStatusItem => {
		if (typeof entry !== "object" || entry === null) throw new PlanStatusRefusal(`item ${index} of ${path} is not an object`);
		const item = entry as Record<string, unknown>;
		for (const key of ["plan", "code", "title", "state"]) {
			if (typeof item[key] !== "string" || (item[key] as string).trim() === "") throw new PlanStatusRefusal(`item ${index} of ${path} has no ${key}`);
		}
		const missing = item["missing"];
		if (missing !== undefined && missing !== null && typeof missing !== "string") throw new PlanStatusRefusal(`item ${index} of ${path} has a missing that is neither text nor null`);
		return {
			plan: item["plan"] as string,
			code: item["code"] as string,
			title: item["title"] as string,
			state: item["state"] as PlanStatusState,
			evidence: stringArray(item["evidence"], `item ${index} of ${path}: evidence`),
			lanes: stringArray(item["lanes"], `item ${index} of ${path}: lanes`),
			missing: typeof missing === "string" ? missing : null,
			updatedAt: typeof item["updatedAt"] === "string" ? item["updatedAt"] : "",
		};
	});
	const plans = stringArray(file.plans, `the plans of ${path}`);
	return {
		...(typeof file.version === "number" ? { version: file.version } : {}),
		...(typeof file.seededBy === "string" ? { seededBy: file.seededBy } : {}),
		...(typeof file.source === "string" ? { source: file.source } : {}),
		...(typeof file.seededAt === "string" ? { seededAt: file.seededAt } : {}),
		plans: plans.length > 0 ? plans : [...new Set(items.map((item) => item.plan))],
		items,
	};
}

/** Where one evidence SHA lives: the first catalogue repository that holds it, else whether any was asked. */
async function checkEvidence(git: GitExec, sha: string, repositories: NamedDir[]): Promise<EvidenceCheck> {
	let asked = false;
	for (const repository of repositories) {
		if (!existsSync(repository.dir)) continue;
		asked = true;
		try {
			await git(["cat-file", "-e", `${sha}^{commit}`], repository.dir);
			return { found: true, repository: repository.name };
		} catch {
			// The next repository holds it, or none does.
		}
	}
	return { found: false, checked: asked };
}

function renderEvidence(entry: string, check: EvidenceCheck | undefined): string {
	if (check === undefined) return entry;
	if (check.found) return `${entry} (${check.repository})`;
	return check.checked ? `${entry} (evidence missing)` : `${entry} (evidence not checked)`;
}

/**
 * The plan register as text: the header, then one block per item — its code, state and title,
 * what is missing, the lanes that carry it, and its evidence with each checked commit named or
 * marked `evidence missing`.
 */
export async function planStatus(query: PlanStatusQuery = {}, deps: PlanStatusDeps = {}): Promise<string> {
	const path = deps.path ?? planStatusPath();
	const file = readPlanStatus(path);
	if (query.plan !== undefined && !file.plans.includes(query.plan)) throw new PlanStatusRefusal(`unknown plan ${query.plan}: the file covers ${file.plans.length > 0 ? file.plans.join(", ") : "no plan"}`);
	if (query.state !== undefined && !isPlanStatusState(query.state)) throw new PlanStatusRefusal(`state must be one of ${PLAN_STATUS_STATES.join(", ")}`);
	const items = file.items.filter((item) => (query.plan === undefined || item.plan === query.plan) && (query.state === undefined || item.state === query.state));

	const repositories = deps.repositories ?? defaultGitRepos(deps.home ?? homedir());
	const git = deps.git ?? execGit;
	const checks = new Map<string, EvidenceCheck>();
	for (const sha of [...new Set(items.flatMap((item) => item.evidence.filter((entry) => EVIDENCE_SHA.test(entry))))]) {
		checks.set(sha, await checkEvidence(git, sha, repositories));
	}

	const filter = [query.plan !== undefined ? `plan ${query.plan}` : undefined, query.state !== undefined ? `state ${query.state}` : undefined].filter((entry) => entry !== undefined).join(", ");
	const counts = PLAN_STATUS_STATES.map((state) => `${state} ${items.filter((item) => item.state === state).length}`).join(", ");
	const missing = [...checks.values()].filter((check) => !check.found && check.checked).length;
	const lines = [
		`plan_status: ${items.length} of ${file.items.length} items${filter === "" ? "" : ` (${filter})`} — ${counts}`,
		`  file: ${path}${file.seededBy !== undefined ? `, seeded by ${file.seededBy}${file.seededAt !== undefined ? ` at ${file.seededAt}` : ""}` : ""}`,
		`  evidence: ${checks.size} commit${checks.size === 1 ? "" : "s"} checked in ${repositories.length > 0 ? repositories.map((repository) => repository.name).join(", ") : "no repository of the catalogue"}${missing > 0 ? `, ${missing} evidence missing` : ""}`,
	];
	for (const plan of [...new Set(items.map((item) => item.plan))]) {
		lines.push("", plan);
		for (const item of items.filter((candidate) => candidate.plan === plan)) {
			const itemMissing = item.evidence.some((entry) => {
				const check = checks.get(entry);
				return check !== undefined && !check.found && check.checked;
			});
			lines.push(`  ${item.code} ${item.state}  ${item.title}${itemMissing ? " — evidence missing" : ""}`);
			if (item.missing !== null && item.missing !== "") lines.push(`      missing: ${item.missing}`);
			if (item.lanes.length > 0) lines.push(`      lanes: ${item.lanes.join(", ")}`);
			if (item.evidence.length > 0) lines.push(`      evidence: ${item.evidence.map((entry) => renderEvidence(entry, checks.get(entry))).join("; ")}`);
		}
	}
	return lines.join("\n");
}
