/**
 * Muster project catalogue and target resolution — disjoint P2 leaf.
 *
 * The catalogue is configuration references only (not a task database, not
 * an approval source, not a grant store). The parent owns every other seam
 * (wiring, concordance, binding, control, parent-mode, real catalogues,
 * grants, provider/model defaults). This leaf owns exactly:
 *   - schemaVersion-1 catalogue shape and validation,
 *   - reading the on-disk JSON,
 *   - pure resolution of a user request to a (project, programme) candidate,
 *     or a selector when one input is ambiguous, or a blocked reason when
 *     the request is unknown.
 *
 * Resolution performs no I/O, no grant checks, no ownership transfer, no
 * Concord call, no model call. The takeover sequence is the parent's job:
 * it consumes a ProjectResolution here and then runs its own preflight
 * against the existing approved records and canonical Git identity before
 * it can claim a takeover complete.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { updateJsonSettingsFile } from "../core/atomic-settings.ts";
import { normalizePrimaryRoot, piAgentDir, repoTopologyForCheckout, validateAgentId } from "./binding.ts";
import { MAX_WRITER_CEILING } from "./control.ts";

// ─── Types (frozen public contract) ──────────────────────────────────────────

export type ProgrammeRegistration = {
	programmeId: string;
	checkoutRoot: string;
	repoKey: string;
	/** The project's stable parent mailbox (AM1.2): workers and handoffs address this id. */
	parentAgentId: string;
};

/**
 * Per-project defaults (AM1.1). Every field is optional: an absent field means
 * "use the runtime default", never a value invented in reusable code.
 */
export type ProjectSettings = {
	integration?: { checkout: string; branch: string };
	ceiling?: number;
	workerModel?: string;
	workerThinking?: string;
	verify?: { test?: string; typecheck?: string };
	riskyGlobs?: string[];
	parentWritableGlobs?: string[];
	/** Changed lines the parent may write into one file on one task, outside its parent-writable globs (default 20). */
	parentMaxChangedLines?: number;
	rotation?: RotationSettings;
};

/**
 * Automatic rotation of the project's parent (R1.5, AM4). Every field is
 * optional: an absent one means the runtime default (250k tokens, the Pi
 * default model and thinking level, the project checkout as working directory).
 */
export type RotationSettings = {
	/** Context size at which the leader is replaced. */
	rotateAtTokens?: number;
	parentModel?: string;
	parentThinking?: string;
	/** Where the leader keeps the project's checkpoint, named in the wake and the resume brief. */
	checkpoint?: string;
	/** Replaces the default resume brief for the fresh parent. */
	resumeBrief?: string;
	/** Working directory of the fresh parent. */
	cwd?: string;
};

/** Below this a threshold would rotate the parent on nearly every turn. */
export const MIN_ROTATE_AT_TOKENS = 20_000;
export const DEFAULT_ROTATE_AT_TOKENS = 250_000;

/** Discord surface of the project (AM1.6); ids are opaque platform strings. */
export type ProjectDiscord = { channelId?: string; threadId?: string };

/**
 * Secrets-routing employer of a project (SK-D5): a project's workers take the
 * split providers' keys from the employer's vault. The register carries the
 * literal value; an absent field means `personal`, the operator's default for
 * everything the register does not name.
 */
export type Employer = "personal" | "acme-realty";

const EMPLOYER_VALUES: readonly Employer[] = ["personal", "acme-realty"];

export type ProjectRegistration = {
	projectId: string;
	/** Secrets-routing employer (SK-D5); absent means `personal`. */
	employer?: Employer;
	name: string;
	/** A one-line display title (D2): the command center shows it, else `name`. A label only: it is not a lookup key. */
	title?: string;
	aliases: string[];
	programmes: ProgrammeRegistration[];
	settings?: ProjectSettings;
	discord?: ProjectDiscord;
};

export type ProjectCatalogue = {
	schemaVersion: 1;
	projects: ProjectRegistration[];
};

export type ProjectCandidate = {
	project: ProjectRegistration;
	programme: ProgrammeRegistration;
};

export type ProjectResolution =
	| { kind: "resolved"; candidate: ProjectCandidate }
	| { kind: "select"; candidates: ProjectCandidate[] }
	| { kind: "blocked"; reason: string };

// ─── Path (no live I/O on import; tests pass an explicit filePath) ───────────

/**
 * Default location for the on-disk project catalogue.
 *
 * Reads only happen through {@link readProjectCatalogue}; tests must pass an
 * explicit filePath to keep this module from touching the live catalogue.
 */
export function projectCataloguePath(): string {
	const override = process.env.PI_MUSTER_PROJECTS_FILE?.trim();
	if (override) return path.resolve(override);
	return path.join(piAgentDir(), "muster-projects.json");
}

// ─── Validation ──────────────────────────────────────────────────────────────

const PROJECT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

const NONEMPTY_IDENTIFIER_PATTERN = /^\S+$/;

function asNonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`muster-projects: ${label} must be a non-empty string`);
	}
	return value;
}

function asHumanLookup(value: unknown, label: string): string {
	const text = asNonEmptyString(value, label);
	if (!text.trim() || text !== text.trim()) {
		throw new Error(
			`muster-projects: ${label} must not be blank or padded with whitespace`,
		);
	}
	return text;
}

function asOneLineTitle(value: unknown, label: string): string {
	const text = asNonEmptyString(value, label);
	if (!text.trim() || text !== text.trim() || /[\r\n]/.test(text)) {
		throw new Error(`muster-projects: ${label} must be one line, not blank or padded with whitespace`);
	}
	return text;
}

function asNonEmptyArray<T>(value: unknown, label: string): T[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`muster-projects: ${label} must be a non-empty array`);
	}
	return value as T[];
}

function asAbsolutePath(value: unknown, label: string): string {
	const s = asNonEmptyString(value, label);
	if (!path.isAbsolute(s)) {
		throw new Error(
			`muster-projects: ${label} must be an absolute path (got "${s}")`,
		);
	}
	return s;
}

function asProjectId(value: unknown): string {
	const s = asNonEmptyString(value, "projectId");
	if (!PROJECT_ID_PATTERN.test(s)) {
		throw new Error(
			`muster-projects: projectId "${s}" must match ^[a-z][a-z0-9_-]{0,63}$`,
		);
	}
	return s;
}

function asProgrammeId(value: unknown): string {
	const s = asNonEmptyString(value, "programmeId");
	if (!NONEMPTY_IDENTIFIER_PATTERN.test(s)) {
		throw new Error(
			`muster-projects: programmeId "${s}" must be a non-empty whitespace-free identifier`,
		);
	}
	return s;
}

function asParentAgentId(value: unknown): string {
	const s = asNonEmptyString(value, "parentAgentId");
	// validateAgentId trims; we want exact-match validation here so callers
	// can't smuggle whitespace through and have it normalized silently.
	if (s !== s.trim()) {
		throw new Error(
			`muster-projects: parentAgentId must not have surrounding whitespace`,
		);
	}
	const validated = validateAgentId(s);
	if (validated === undefined || validated !== s) {
		throw new Error(
			`muster-projects: parentAgentId "${s}" must match the existing validateAgentId pattern`,
		);
	}
	return s;
}

/**
 * The register carries the employer verbatim, so `Acme Realty` differs from
 * `acme-realty` and fails the parse instead of silently matching. Every
 * employer error names the owning project: the value is a property of the
 * project, and that is what the operator must go fix.
 */
function parseEmployer(value: unknown, label: string, projectId: string): Employer {
	const fail = (why: string): Error =>
		new Error(`muster-projects: ${label} on project "${projectId}" ${why}`);
	if (typeof value !== "string" || value.length === 0) {
		throw fail("must be a non-empty string");
	}
	if (!EMPLOYER_VALUES.includes(value as Employer)) {
		throw fail(
			`must be one of: ${EMPLOYER_VALUES.join(", ")} (got "${value}")`,
		);
	}
	return value as Employer;
}

function asOptionalNonEmptyStringArray(
	value: unknown,
	label: string,
): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new Error(`muster-projects: ${label} must be an array when present`);
	}
	const out: string[] = [];
	for (const [i, v] of value.entries()) {
		const s = asHumanLookup(v, `${label}[${i}]`);
		out.push(s);
	}
	return out;
}

// ─── parseProjectCatalogue ───────────────────────────────────────────────────

/**
 * Validate arbitrary JSON-decoded input as a ProjectCatalogue.
 *
 * Throws a descriptive Error on every shape that violates the contract:
 * wrong schemaVersion, empty projects/programmes arrays, malformed projectId,
 * format, malformed programmeId, whitespace or non-absolute paths, parent
 * agent ids that don't pass validateAgentId, duplicate projectId, duplicate
 * name, duplicate alias across projects, duplicate programmeId, or two
 * programmes that share a (repoKey, parentAgentId) mailbox in the same repo.
 *
 * Supplied strings are never reparsed/expanded/trimmed/canonicalized — the
 * stored values are kept verbatim so projection / error messages reflect
 * exactly what the operator wrote.
 */
/**
 * Match a repository-relative path against one catalogue glob. `**` crosses
 * directory separators, `*` and `?` do not; every other character is literal.
 * `**` also crosses zero directories: the pattern `lib/` + `**` + a slash +
 * `contract*.ts` matches `lib/contract.ts` as well as deeper paths, which is
 * what the operator's glob means. This is the only glob matcher the
 * catalogue's `riskyGlobs` and `parentWritableGlobs` go through, so both
 * owners agree on what a pattern means.
 */
export function pathMatchesGlob(path: string, glob: string): boolean {
	if (glob === "" || path === "") return false;
	// A doubled star followed by a slash may stand for nothing, and a trailing one
	// covers the folder's own files. The markers keep them readable while the
	// slash after a doubled star becomes optional.
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "\u0000")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]")
		.replace(/\u0000\//g, "(?:\u0001.*)?")
		.replace(/\u0000/g, ".*")
		.replace(/\u0001/g, "[^/]*");
	return new RegExp(`^${escaped}$`).test(path);
}

/** True when any of the catalogue's globs matches the path. */
export function pathMatchesAnyGlob(path: string, globs: readonly string[] | undefined): boolean {
	return (globs ?? []).some((glob) => pathMatchesGlob(path, glob));
}

export function parseProjectCatalogue(input: unknown): ProjectCatalogue {
	if (input === null || typeof input !== "object") {
		throw new Error("muster-projects: catalogue root must be an object");
	}
	const root = input as Record<string, unknown>;
	if (root.schemaVersion !== 1) {
		throw new Error(
			`muster-projects: schemaVersion must be exactly 1 (got ${JSON.stringify(root.schemaVersion)})`,
		);
	}
	const rawProjects = asNonEmptyArray<unknown>(root.projects, "projects");

	const projects: ProjectRegistration[] = [];
	const seenProjectIds = new Set<string>();
	const seenNames = new Set<string>();
	const seenAliases = new Set<string>();
	const seenProgrammeIds = new Set<string>();
	const lookupOwners = new Map<string, string>();
	const registerLookup = (text: string, projectId: string) => {
		const key = text.toLowerCase();
		const prior = lookupOwners.get(key);
		if (prior !== undefined && prior !== projectId) {
			throw new Error(
				`muster-projects: lookup collision "${text}" across projects "${prior}" and "${projectId}"`,
			);
		}
		lookupOwners.set(key, projectId);
	};
	// Distinct programmes can use the same (repoKey, parentAgentId) mailbox
	// across different repos, so we key the mailbox by (repoKey, parentAgentId).
	const seenMailboxes = new Map<string, string>(); // mailbox -> programmeId

	for (const [pi, rawProject] of rawProjects.entries()) {
		if (rawProject === null || typeof rawProject !== "object") {
			throw new Error(`muster-projects: projects[${pi}] must be an object`);
		}
		const p = rawProject as Record<string, unknown>;

		const projectId = asProjectId(p.projectId);
		if (seenProjectIds.has(projectId)) {
			throw new Error(`muster-projects: duplicate projectId "${projectId}"`);
		}
		seenProjectIds.add(projectId);
		registerLookup(projectId, projectId);

		const name = asHumanLookup(p.name, `projects[${pi}].name`);
		const nameKey = name.toLowerCase();
		if (seenNames.has(nameKey)) {
			throw new Error(
				`muster-projects: duplicate project name "${name}" — projects must resolve by human name without guessing`,
			);
		}
		seenNames.add(nameKey);
		registerLookup(name, projectId);

		const aliases = asOptionalNonEmptyStringArray(
			p.aliases,
			`projects[${pi}].aliases`,
		);
		for (const [ai, alias] of aliases.entries()) {
			const aliasKey = alias.toLowerCase();
			if (seenAliases.has(aliasKey)) {
				throw new Error(
					`muster-projects: duplicate alias "${alias}" across projects[${pi}].aliases[${ai}] — alias collisions must be reported, not silently picked`,
				);
			}
			seenAliases.add(aliasKey);
			registerLookup(alias, projectId);
		}

		const rawProgrammes = asNonEmptyArray<unknown>(
			p.programmes,
			`projects[${pi}].programmes`,
		);
		const programmes: ProgrammeRegistration[] = [];

		for (const [mi, rawProgramme] of rawProgrammes.entries()) {
			if (rawProgramme === null || typeof rawProgramme !== "object") {
				throw new Error(
					`muster-projects: projects[${pi}].programmes[${mi}] must be an object`,
				);
			}
			const pr = rawProgramme as Record<string, unknown>;

			const programmeId = asProgrammeId(pr.programmeId);
			if (seenProgrammeIds.has(programmeId)) {
				throw new Error(
					`muster-projects: duplicate programmeId "${programmeId}"`,
				);
			}
			seenProgrammeIds.add(programmeId);

			const checkoutRoot = asAbsolutePath(
				pr.checkoutRoot,
				`projects[${pi}].programmes[${mi}].checkoutRoot`,
			);
			const repoKey = asAbsolutePath(
				pr.repoKey,
				`projects[${pi}].programmes[${mi}].repoKey`,
			);
			const parentAgentId = asParentAgentId(pr.parentAgentId);

			// Distinct programmes must not reuse the same (repoKey, parentAgentId)
			// mailbox within one repo. Same agentId across different repos is fine.
			const mailbox = `${repoKey}\u0000${parentAgentId}`;
			const prior = seenMailboxes.get(mailbox);
			if (prior !== undefined) {
				throw new Error(
					`muster-projects: programmes "${prior}" and "${programmeId}" reuse the same (repoKey, parentAgentId) mailbox in "${repoKey}" — distinct programmes cannot share a mailbox in one repo`,
				);
			}
			seenMailboxes.set(mailbox, programmeId);

			programmes.push({ programmeId, checkoutRoot, repoKey, parentAgentId });
		}

		const registration: ProjectRegistration = { projectId, name, aliases, programmes };
		if (p.title !== undefined) registration.title = asOneLineTitle(p.title, `projects[${pi}].title`);
		if (p.employer !== undefined) {
			registration.employer = parseEmployer(p.employer, `projects[${pi}].employer`, projectId);
		}
		if (p.settings !== undefined) registration.settings = parseProjectSettings(p.settings, `projects[${pi}].settings`);
		if (p.discord !== undefined) registration.discord = parseProjectDiscord(p.discord, `projects[${pi}].discord`);
		projects.push(registration);
	}

	return { schemaVersion: 1, projects };
}

function parseStringList(value: unknown, label: string): string[] {
	if (!Array.isArray(value)) throw new Error(`muster-projects: ${label} must be an array of strings`);
	return value.map((entry, i) => asNonEmptyString(entry, `${label}[${i}]`));
}

function parseProjectSettings(value: unknown, label: string): ProjectSettings {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`muster-projects: ${label} must be an object`);
	}
	const s = value as Record<string, unknown>;
	const out: ProjectSettings = {};
	if (s.integration !== undefined) {
		const i = s.integration as Record<string, unknown> | null;
		if (i === null || typeof i !== "object") throw new Error(`muster-projects: ${label}.integration must be an object`);
		out.integration = {
			checkout: asAbsolutePath(i.checkout, `${label}.integration.checkout`),
			branch: asNonEmptyString(i.branch, `${label}.integration.branch`),
		};
	}
	if (s.ceiling !== undefined) {
		if (!Number.isInteger(s.ceiling) || (s.ceiling as number) < 1 || (s.ceiling as number) > MAX_WRITER_CEILING) {
			throw new Error(`muster-projects: ${label}.ceiling must be an integer between 1 and ${MAX_WRITER_CEILING}`);
		}
		out.ceiling = s.ceiling as number;
	}
	if (s.workerModel !== undefined) out.workerModel = asNonEmptyString(s.workerModel, `${label}.workerModel`);
	if (s.workerThinking !== undefined) out.workerThinking = asNonEmptyString(s.workerThinking, `${label}.workerThinking`);
	if (s.verify !== undefined) {
		const v = s.verify as Record<string, unknown> | null;
		if (v === null || typeof v !== "object") throw new Error(`muster-projects: ${label}.verify must be an object`);
		out.verify = {};
		if (v.test !== undefined) out.verify.test = asNonEmptyString(v.test, `${label}.verify.test`);
		if (v.typecheck !== undefined) out.verify.typecheck = asNonEmptyString(v.typecheck, `${label}.verify.typecheck`);
	}
	if (s.riskyGlobs !== undefined) out.riskyGlobs = parseStringList(s.riskyGlobs, `${label}.riskyGlobs`);
	if (s.parentWritableGlobs !== undefined) out.parentWritableGlobs = parseStringList(s.parentWritableGlobs, `${label}.parentWritableGlobs`);
	if (s.parentMaxChangedLines !== undefined) {
		if (!Number.isInteger(s.parentMaxChangedLines) || (s.parentMaxChangedLines as number) < 0) {
			throw new Error(`muster-projects: ${label}.parentMaxChangedLines must be a non-negative integer`);
		}
		out.parentMaxChangedLines = s.parentMaxChangedLines as number;
	}
	if (s.rotation !== undefined) out.rotation = parseRotationSettings(s.rotation, `${label}.rotation`);
	return out;
}

const ROTATION_SETTING_KEYS = new Set(["rotateAtTokens", "parentModel", "parentThinking", "checkpoint", "resumeBrief", "cwd"]);

function parseRotationSettings(value: unknown, label: string): RotationSettings {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`muster-projects: ${label} must be an object`);
	}
	const r = value as Record<string, unknown>;
	// A misspelled key would silently leave rotation at its default: refuse it.
	const unknown = Object.keys(r).filter((key) => !ROTATION_SETTING_KEYS.has(key));
	if (unknown.length > 0) throw new Error(`muster-projects: ${label} has unknown fields: ${unknown.join(", ")}`);
	const out: RotationSettings = {};
	if (r.rotateAtTokens !== undefined) {
		if (!Number.isInteger(r.rotateAtTokens) || (r.rotateAtTokens as number) < MIN_ROTATE_AT_TOKENS) {
			throw new Error(`muster-projects: ${label}.rotateAtTokens must be an integer of at least ${MIN_ROTATE_AT_TOKENS}`);
		}
		out.rotateAtTokens = r.rotateAtTokens as number;
	}
	for (const key of ["parentModel", "parentThinking", "checkpoint", "resumeBrief"] as const) {
		if (r[key] !== undefined) out[key] = asNonEmptyString(r[key], `${label}.${key}`);
	}
	if (r.cwd !== undefined) out.cwd = asAbsolutePath(r.cwd, `${label}.cwd`);
	return out;
}

const DISCORD_ID_PATTERN = /^\d{5,30}$/;

function parseProjectDiscord(value: unknown, label: string): ProjectDiscord {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`muster-projects: ${label} must be an object`);
	}
	const d = value as Record<string, unknown>;
	const out: ProjectDiscord = {};
	for (const key of ["channelId", "threadId"] as const) {
		if (d[key] === undefined) continue;
		const id = asNonEmptyString(d[key], `${label}.${key}`);
		if (!DISCORD_ID_PATTERN.test(id)) throw new Error(`muster-projects: ${label}.${key} must be a numeric platform id`);
		out[key] = id;
	}
	return out;
}

// ─── readProjectCatalogue ────────────────────────────────────────────────────

/**
 * Read and validate the catalogue from disk at the supplied path.
 *
 * Tests pass an explicit path pointing at a temporary fixture file. The
 * caller is responsible for never asking this module to read the live
 * catalogue while tests are running.
 */
export function readProjectCatalogue(
	filePath: string = projectCataloguePath(),
): ProjectCatalogue {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			throw new Error(
				`muster-projects: catalogue file not found at "${filePath}"`,
			);
		}
		throw new Error(
			`muster-projects: cannot read catalogue at "${filePath}": ${(err as Error).message}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(
			`muster-projects: malformed JSON in catalogue at "${filePath}": ${(err as Error).message}`,
		);
	}
	return parseProjectCatalogue(parsed);
}

// ─── resolveProjectTarget ────────────────────────────────────────────────────

function findProjectsByIdOrNameOrAlias(
	catalogue: ProjectCatalogue,
	requested: string,
): ProjectRegistration[] {
	const key = requested.toLowerCase();
	return catalogue.projects.filter(
		(project) =>
			project.projectId === requested ||
			project.name.toLowerCase() === key ||
			project.aliases.some((alias) => alias.toLowerCase() === key),
	);
}

function resolveWithinProject(
	project: ProjectRegistration,
	activeProgrammeIds: readonly string[],
	explicitProgrammeId?: string,
): ProjectResolution {
	if (explicitProgrammeId !== undefined) {
		const programme = project.programmes.find(
			(p) => p.programmeId === explicitProgrammeId,
		);
		if (!programme)
			return {
				kind: "blocked",
				reason: `Unknown programmeId "${explicitProgrammeId}" for project "${project.projectId}".`,
			};
		return { kind: "resolved", candidate: { project, programme } };
	}
	const eligible = project.programmes.filter((p) =>
		activeProgrammeIds.includes(p.programmeId),
	);
	const programmes = eligible.length ? eligible : project.programmes;
	if (programmes.length === 0)
		return {
			kind: "blocked",
			reason: `Project "${project.projectId}" has no programmes.`,
		};
	if (programmes.length === 1)
		return {
			kind: "resolved",
			candidate: { project, programme: programmes[0] },
		};
	return {
		kind: "select",
		candidates: programmes.map((programme) => ({ project, programme })),
	};
}

function findProgrammesByRepoKey(
	catalogue: ProjectCatalogue,
	repoKey: string,
): ProjectCandidate[] {
	const out: ProjectCandidate[] = [];
	for (const project of catalogue.projects) {
		for (const programme of project.programmes) {
			if (programme.repoKey === repoKey) {
				out.push({ project, programme });
			}
		}
	}
	return out;
}

function activeCandidates(
	catalogue: ProjectCatalogue,
	activeProgrammeIds: readonly string[],
): ProjectCandidate[] {
	const out: ProjectCandidate[] = [];
	for (const project of catalogue.projects) {
		for (const programme of project.programmes) {
			if (activeProgrammeIds.includes(programme.programmeId)) {
				out.push({ project, programme });
			}
		}
	}
	return out;
}

function registeredCandidates(catalogue: ProjectCatalogue): ProjectCandidate[] {
	const out: ProjectCandidate[] = [];
	for (const project of catalogue.projects) {
		for (const programme of project.programmes) {
			out.push({ project, programme });
		}
	}
	return out;
}

/**
 * Pure target resolution; configuration is never approval or ownership authority.
 * Explicit requests override advisory context, and unknown/ambiguous requests block.
 * For a bare command, reconcile selected context with canonical checkout matches;
 * disagreement or multiple matches requires selection, never array-order guessing.
 * An unregistered checkout is no target signal and falls through to eligible active
 * programmes. The caller supplies eligibility (including paused/waiting, excluding
 * finished/off). Without eligible targets, configured references require selection.
 * An explicit programme id is accepted only within a selected project or matching
 * checkout. The caller then revalidates grants/topology before transferring authority.
 */
export function resolveProjectTarget(input: {
	catalogue: ProjectCatalogue;
	requested?: string;
	selectedProjectId?: string;
	checkoutRepoKey?: string;
	activeProgrammeIds: readonly string[];
	explicitProgrammeId?: string;
}): ProjectResolution {
	const {
		catalogue,
		requested,
		selectedProjectId,
		checkoutRepoKey,
		activeProgrammeIds,
		explicitProgrammeId,
	} = input;

	// An explicit operator request takes precedence over advisory session/cwd context.
	if (requested !== undefined && requested !== "") {
		const projects = findProjectsByIdOrNameOrAlias(catalogue, requested);
		if (projects.length !== 1)
			return {
				kind: "blocked",
				reason: `Requested project "${requested}" is unknown or ambiguous in the catalogue.`,
			};
		return resolveWithinProject(
			projects[0],
			activeProgrammeIds,
			explicitProgrammeId,
		);
	}

	const checkoutMatches = checkoutRepoKey
		? findProgrammesByRepoKey(catalogue, checkoutRepoKey)
		: [];
	if (selectedProjectId !== undefined) {
		const project = catalogue.projects.find(
			(p) => p.projectId === selectedProjectId,
		);
		if (!project)
			return {
				kind: "blocked",
				reason: `Selected projectId "${selectedProjectId}" not found in catalogue.`,
			};
		const selected = resolveWithinProject(
			project,
			activeProgrammeIds,
			explicitProgrammeId,
		);
		if (selected.kind === "blocked") return selected;
		const selectedCandidates =
			selected.kind === "resolved" ? [selected.candidate] : selected.candidates;
		const conflictingProject = checkoutMatches.some(
			(c) => c.project.projectId !== project.projectId,
		);
		const conflictingProgramme =
			explicitProgrammeId !== undefined &&
			checkoutMatches.length > 0 &&
			!checkoutMatches.some(
				(c) => c.programme.programmeId === explicitProgrammeId,
			);
		if (conflictingProject || conflictingProgramme) {
			const candidates = [...selectedCandidates, ...checkoutMatches].filter(
				(candidate, index, all) =>
					all.findIndex(
						(c) => c.programme.programmeId === candidate.programme.programmeId,
					) === index,
			);
			return { kind: "select", candidates };
		}
		if (checkoutMatches.length > 0 && explicitProgrammeId === undefined) {
			return checkoutMatches.length === 1
				? { kind: "resolved", candidate: checkoutMatches[0] }
				: { kind: "select", candidates: checkoutMatches };
		}
		return selected;
	}

	if (checkoutMatches.length > 0) {
		if (explicitProgrammeId !== undefined) {
			const candidate = checkoutMatches.find(
				(c) => c.programme.programmeId === explicitProgrammeId,
			);
			if (!candidate)
				return {
					kind: "blocked",
					reason: `Unknown programmeId "${explicitProgrammeId}" for checkoutRepoKey "${checkoutRepoKey}".`,
				};
			return { kind: "resolved", candidate };
		}
		return checkoutMatches.length === 1
			? { kind: "resolved", candidate: checkoutMatches[0] }
			: { kind: "select", candidates: checkoutMatches };
	}
	if (explicitProgrammeId !== undefined)
		return {
			kind: "blocked",
			reason:
				"Explicit programmeId requires a selected project or matching checkout.",
		};

	// Unregistered cwd is not a conflicting target; continue to backend eligibility.
	const eligible = activeCandidates(catalogue, activeProgrammeIds);
	if (eligible.length === 1)
		return { kind: "resolved", candidate: eligible[0] };
	if (eligible.length > 1) return { kind: "select", candidates: eligible };
	const registered = registeredCandidates(catalogue);
	return registered.length
		? { kind: "select", candidates: registered }
		: {
				kind: "blocked",
				reason: "Catalogue contains no registered programmes.",
			};
}

// ─── Self-population (AM1.1 / AM1.2): the project is the repository ──────────

function slugOf(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function shortHash(text: string, length: number): string {
	return createHash("sha256").update(text).digest("hex").slice(0, length);
}

/**
 * The project name is the repository folder. `repoKey` is the canonical Git
 * common directory (`.../<name>/.git`, or a bare `.../<name>.git`), so every
 * worktree of one repository names the same project.
 */
export function projectNameForRepoKey(repoKey: string): string {
	const base = path.basename(repoKey) === ".git" ? path.basename(path.dirname(repoKey)) : path.basename(repoKey).replace(/\.git$/, "");
	const slug = slugOf(base) || "project";
	return /^[a-z]/.test(slug) ? slug.slice(0, 64) : `p-${slug}`.slice(0, 64);
}

/** The main checkout of every repository in the catalogue, once each, with the name of the project that owns it. */
export function catalogueRepos(catalogue: ProjectCatalogue): Array<{ name: string; dir: string }> {
	const seen = new Map<string, { name: string; dir: string }>();
	for (const project of catalogue.projects) {
		for (const programme of project.programmes) {
			const dir = normalizePrimaryRoot(programme.repoKey);
			if (!seen.has(dir)) seen.set(dir, { name: project.name, dir });
		}
	}
	return [...seen.values()];
}

/** The main checkout of every repository in the catalogue, once each. */
export function catalogueRepoRoots(catalogue: ProjectCatalogue): string[] {
	return catalogueRepos(catalogue).map((repo) => repo.dir);
}

/** Default stable parent mailbox: `pi-<slug>-parent`, at most 32 characters, hashed when the slug is long. */
export function mailboxForProject(name: string): string {
	const slug = slugOf(name) || "project";
	const plain = `pi-${slug}-parent`;
	if (plain.length <= 32) return plain;
	return `pi-${slug.slice(0, 15).replace(/-+$/, "")}-${shortHash(name, 6)}-parent`;
}

/** Internal programme id for a project: deterministic, so registration is idempotent and never user-visible. */
export function programmeIdForRepoKey(repoKey: string): string {
	return `agp_${shortHash(repoKey, 12)}`;
}

/**
 * `hermes send --to` target for a project's Discord thread. The thread id is
 * also the chat id, the shape the bound programme thread has always used, so
 * one function names the target for the alert, the digest and the takeover line.
 */
export function discordTargetFor(discord: ProjectDiscord | undefined): string | undefined {
	return discord?.threadId === undefined ? undefined : `discord:${discord.threadId}:${discord.threadId}`;
}

export function findProjectByRepoKey(catalogue: ProjectCatalogue, repoKey: string): ProjectCandidate | undefined {
	return findProgrammesByRepoKey(catalogue, repoKey)[0];
}

// ─── Employer (SK2) ─────────────────────────────────────────────────────────

/** The secrets-routing employer of a project (SK-D5); an absent field means `personal`. */
export function employerForProject(project: ProjectRegistration): Employer {
	return project.employer ?? "personal";
}

/**
 * The employer at a working directory: the register's project for the cwd's
 * repository decides, and every directory outside the register is `personal` —
 * `~`, a non-Git path, an unregistered checkout. Linked worktrees resolve
 * through the repository's common dir (`repoTopologyForCheckout`), so a
 * project's worktree carries the same employer as its primary checkout. The
 * catalogue is read on each call; a catalogue error propagates rather than
 * silently downgrading to `personal`.
 */
export async function employerForCwd(
	cwd: string,
	cataloguePath: string = projectCataloguePath(),
): Promise<Employer> {
	let repoKey: string;
	try {
		repoKey = (await repoTopologyForCheckout(cwd)).repoKey;
	} catch {
		return "personal";
	}
	const project = findProjectByRepoKey(
		readProjectCatalogue(cataloguePath),
		repoKey,
	)?.project;
	return project === undefined ? "personal" : employerForProject(project);
}

/** The accounts marker a session's status line shows (SK5, blueprint §5 step 7). */
export type EmployerAccountsMark = {
	/** `UE` — this session runs on the work accounts; `UE?` — its directory needs them. */
	mark: "UE" | "UE?";
	/** The one notice to show, for `UE?` only. */
	notice?: string;
};

/** The one notice for a session on the personal accounts in a work project (blueprint §5 step 7). */
export const EMPLOYER_ACCOUNTS_NOTICE =
	"This session runs on the personal accounts; start Pi in this repo for the work accounts.";

/**
 * The accounts marker for a session whose process employer is `sessionEmployer`
 * and whose working directory belongs to `cwdEmployer`. `UE` when the session
 * runs on the work accounts. `UE?`, with the one notice, when the directory
 * belongs to an acme-realty project while this process does not run on the
 * work accounts — its requests would leave on the personal keys. Otherwise
 * nothing: a personal directory needs no marker either way.
 */
export function employerAccountsMark(
	sessionEmployer: string | undefined,
	cwdEmployer: Employer,
): EmployerAccountsMark | null {
	if (sessionEmployer === "acme-realty") return { mark: "UE" };
	if (cwdEmployer === "acme-realty") return { mark: "UE?", notice: EMPLOYER_ACCOUNTS_NOTICE };
	return null;
}

export type EnsureProjectInput = {
	repoKey: string;
	checkoutRoot: string;
	/** Parent ids that already have open handoffs in this repository (from Concord). */
	existingParentIds?: readonly string[];
	settings?: ProjectSettings;
};

export type EnsureProjectResult = ProjectCandidate & {
	created: boolean;
	/** More than one existing parent id had open work, so none was adopted. */
	mailboxAmbiguous?: boolean;
};

const EMPTY_CATALOGUE = { schemaVersion: 1, projects: [] as unknown[] };

/**
 * Register the repository as a project on its first orchestration, or return
 * the existing registration. Written through the locked atomic helper so two
 * sessions registering at once never lose an entry. An existing parent id that
 * already has open handoffs is adopted as the mailbox only when it is the sole
 * candidate: with several, guessing could strand handoffs, so the default is
 * used and the ambiguity is reported.
 */
export function ensureProjectForRepo(
	input: EnsureProjectInput,
	filePath: string = projectCataloguePath(),
): EnsureProjectResult {
	let result: EnsureProjectResult | undefined;
	updateJsonSettingsFile<Record<string, unknown>>(filePath, EMPTY_CATALOGUE as Record<string, unknown>, (current) => {
		const projects = Array.isArray(current.projects) ? (current.projects as unknown[]) : [];
		const existing = projects.length > 0 ? findProjectByRepoKey(parseProjectCatalogue(current), input.repoKey) : undefined;
		if (existing !== undefined) {
			result = { ...existing, created: false };
			return current;
		}
		const taken = new Set(projects.map((p) => String((p as { name?: unknown }).name).toLowerCase()));
		const baseName = projectNameForRepoKey(input.repoKey);
		const name = taken.has(baseName) ? `${baseName}-${shortHash(input.repoKey, 4)}`.slice(0, 64) : baseName;
		const parentIds = [...new Set((input.existingParentIds ?? []).filter((id) => validateAgentId(id) === id))];
		const adopted = parentIds.length === 1 ? parentIds[0] : undefined;
		const registration: ProjectRegistration = {
			projectId: name,
			name,
			aliases: [],
			programmes: [
				{
					programmeId: programmeIdForRepoKey(input.repoKey),
					checkoutRoot: input.checkoutRoot,
					repoKey: input.repoKey,
					parentAgentId: adopted ?? mailboxForProject(name),
				},
			],
		};
		if (input.settings !== undefined) registration.settings = input.settings;
		const next = { schemaVersion: 1, projects: [...projects, registration] };
		// Validate the whole result so a bad registration never reaches disk.
		parseProjectCatalogue(next);
		result = {
			project: registration,
			programme: registration.programmes[0]!,
			created: true,
			...(parentIds.length > 1 ? { mailboxAmbiguous: true } : {}),
		};
		return next;
	});
	return result!;
}

/** Record the project's Discord thread (AM1.6), validated and written under the catalogue lock. */
export function setProjectDiscordThread(
	filePath: string,
	projectId: string,
	discord: ProjectDiscord,
): ProjectRegistration {
	let updated: ProjectRegistration | undefined;
	updateJsonSettingsFile<Record<string, unknown>>(filePath, EMPTY_CATALOGUE as Record<string, unknown>, (current) => {
		const catalogue = parseProjectCatalogue(current);
		const next = {
			...catalogue,
			projects: catalogue.projects.map((p) =>
				p.projectId === projectId ? { ...p, discord: parseProjectDiscord(discord, "discord") } : p,
			),
		};
		updated = next.projects.find((p) => p.projectId === projectId);
		if (updated === undefined) throw new Error(`muster-projects: unknown project "${projectId}"`);
		parseProjectCatalogue(next);
		return next;
	});
	return updated!;
}
