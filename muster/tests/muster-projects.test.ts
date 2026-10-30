import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * P2 disjoint leaf — Muster project catalogue and target resolution.
 *
 * The catalogue is configuration references only (not a task database or
 * approval source). Resolution is pure and never reads/writes the live
 * catalogue, executes a grant transfer, or touches parent state.
 *
 * Two unrelated fixtures exercise the precedence rules:
 *  - project-alpha: two programmes in two repos (alpha-web, alpha-api),
 *    one of which is the active registered programme.
 *  - project-beta: a single programme in beta-stack.
 *
 * Alias collisions across projects and malformed literals are detected and
 * reported, never silently guessed.
 */

import * as projectsModule from "../projects.ts";
import { harnessRoot } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);

function fixtureDir(): string {
	return mkdtempSync(join(tmpdir(), "muster-projects-"));
}

function alphaProgramme(
	programmeId: string,
	repoKey: string,
	parentAgentId: string,
) {
	return {
		programmeId,
		checkoutRoot: `/var/checkouts/${programmeId}`,
		repoKey,
		parentAgentId,
	};
}

function buildAlphaCatalogue() {
	return {
		schemaVersion: 1 as const,
		projects: [
			{
				projectId: "alpha",
				name: "Alpha Adventure",
				aliases: ["alpha", "Alpha Adventure", "al"],
				programmes: [
					alphaProgramme(
						"alpha-web",
						"/var/repos/alpha-web.git",
						"pi-aaaaaaaaaaaaaaaaaaaa",
					),
					alphaProgramme(
						"alpha-api",
						"/var/repos/alpha-api.git",
						"pi-bbbbbbbbbbbbbbbbbbbb",
					),
				],
			},
			{
				projectId: "beta",
				name: "Beta Beacon",
				aliases: ["beta", "Beta Beacon"],
				programmes: [
					alphaProgramme(
						"beta-stack",
						"/var/repos/beta-stack.git",
						"pi-cccccccccccccccccccc",
					),
				],
			},
		],
	};
}

const ALPHA = buildAlphaCatalogue();
const ALPHA_KEY = "/var/repos/alpha-web.git";
const ALPHA_API_KEY = "/var/repos/alpha-api.git";
const BETA_KEY = "/var/repos/beta-stack.git";

const ACTIVE = ["alpha-web"];

// ─── Validation & parseProjectCatalogue ──────────────────────────────────────

test("P2: schemaVersion must be exactly 1", () => {
	assert.throws(
		() =>
			projectsModule.parseProjectCatalogue({ schemaVersion: 2, projects: [] }),
		/schemaVersion/,
	);
	assert.throws(
		() => projectsModule.parseProjectCatalogue({ projects: [] }),
		/schemaVersion/,
	);
});

test("P2: projectId must match ^[a-z][a-z0-9_-]{0,63}$ and is preserved verbatim", () => {
	assert.throws(
		() =>
			projectsModule.parseProjectCatalogue({
				schemaVersion: 1,
				projects: [
					{
						projectId: "1leading-digit",
						name: "x",
						aliases: [],
						programmes: [
							alphaProgramme("p1", "/r/r.git", "pi-aaaaaaaaaaaaaaaaaaaa"),
						],
					},
				],
			}),
		/projectId/,
	);
	assert.throws(
		() =>
			projectsModule.parseProjectCatalogue({
				schemaVersion: 1,
				projects: [
					{
						projectId: "Upper",
						name: "x",
						aliases: [],
						programmes: [
							alphaProgramme("p1", "/r/r.git", "pi-aaaaaaaaaaaaaaaaaaaa"),
						],
					},
				],
			}),
		/projectId/,
	);
	assert.throws(
		() =>
			projectsModule.parseProjectCatalogue({
				schemaVersion: 1,
				projects: [
					{
						projectId: "x".repeat(65),
						name: "x",
						aliases: [],
						programmes: [
							alphaProgramme("p1", "/r/r.git", "pi-aaaaaaaaaaaaaaaaaaaa"),
						],
					},
				],
			}),
		/projectId/,
	);
});

test("P2: programmeId must be a nonempty, whitespace-free literal", () => {
	assert.throws(
		() =>
			projectsModule.parseProjectCatalogue({
				schemaVersion: 1,
				projects: [
					{
						projectId: "alpha",
						name: "Alpha",
						aliases: [],
						programmes: [
							alphaProgramme("", "/r/r.git", "pi-aaaaaaaaaaaaaaaaaaaa"),
						],
					},
				],
			}),
		/programmeId/,
	);
	assert.throws(
		() =>
			projectsModule.parseProjectCatalogue({
				schemaVersion: 1,
				projects: [
					{
						projectId: "alpha",
						name: "Alpha",
						aliases: [],
						programmes: [
							alphaProgramme(
								"with space",
								"/r/r.git",
								"pi-aaaaaaaaaaaaaaaaaaaa",
							),
						],
					},
				],
			}),
		/programmeId/,
	);
});

test("P2: checkoutRoot and repoKey must be absolute and are preserved verbatim", () => {
	const cat = {
		schemaVersion: 1,
		projects: [
			{
				projectId: "alpha",
				name: "Alpha",
				aliases: [],
				programmes: [
					{
						programmeId: "alpha-web",
						checkoutRoot: "relative/path",
						repoKey: "/abs/repo.git",
						parentAgentId: "pi-aaaaaaaaaaaaaaaaaaaa",
					},
				],
			},
		],
	};
	assert.throws(
		() => projectsModule.parseProjectCatalogue(cat),
		/checkoutRoot/,
	);
	// supplied values must not be reparsed — trailing slash kept, distinct keys stay distinct
	const ok = {
		schemaVersion: 1,
		projects: [
			{
				projectId: "alpha",
				name: "Alpha",
				aliases: [],
				programmes: [
					{
						programmeId: "alpha-web",
						checkoutRoot: "/var/checkouts/alpha/",
						repoKey: "/var/repos/alpha-web.git",
						parentAgentId: "pi-aaaaaaaaaaaaaaaaaaaa",
					},
				],
			},
		],
	};
	const parsed = projectsModule.parseProjectCatalogue(ok);
	assert.equal(
		parsed.projects[0].programmes[0].checkoutRoot,
		"/var/checkouts/alpha/",
	);
	assert.equal(
		parsed.projects[0].programmes[0].repoKey,
		"/var/repos/alpha-web.git",
	);
});

test("P2: parentAgentId must pass validateAgentId (regex, no silent trim)", () => {
	// Too long
	assert.throws(
		() =>
			projectsModule.parseProjectCatalogue({
				schemaVersion: 1,
				projects: [
					{
						projectId: "alpha",
						name: "Alpha",
						aliases: [],
						programmes: [
							alphaProgramme("p1", "/r/r.git", `pi-${"a".repeat(40)}`),
						],
					},
				],
			}),
		/parentAgentId/,
	);
	// Bad pattern (uppercase)
	assert.throws(
		() =>
			projectsModule.parseProjectCatalogue({
				schemaVersion: 1,
				projects: [
					{
						projectId: "alpha",
						name: "Alpha",
						aliases: [],
						programmes: [
							alphaProgramme("p1", "/r/r.git", "Pi-aaaaaaaaaaaaaaaaaaaa"),
						],
					},
				],
			}),
		/parentAgentId/,
	);
});

test("P2: rejects empty projects array and requires at least one programme per project", () => {
	assert.throws(
		() =>
			projectsModule.parseProjectCatalogue({ schemaVersion: 1, projects: [] }),
		/non-empty array.*projects|projects must be a non-empty/i,
	);
	assert.throws(
		() =>
			projectsModule.parseProjectCatalogue({
				schemaVersion: 1,
				projects: [
					{
						projectId: "alpha",
						name: "Alpha",
						aliases: [],
						programmes: [],
					},
				],
			}),
		/non-empty array.*programmes|programmes must be a non-empty/i,
	);
});

test("P2: project ids, project names and aliases must be unique across the catalogue", () => {
	assert.throws(
		() =>
			projectsModule.parseProjectCatalogue({
				schemaVersion: 1,
				projects: [
					{
						projectId: "alpha",
						name: "Same Name",
						aliases: [],
						programmes: [
							alphaProgramme("a1", "/r/r.git", "pi-aaaaaaaaaaaaaaaaaaaa"),
						],
					},
					{
						projectId: "beta",
						name: "Same Name",
						aliases: [],
						programmes: [
							alphaProgramme("b1", "/s/s.git", "pi-bbbbbbbbbbbbbbbbbbbb"),
						],
					},
				],
			}),
		/name/i,
	);
	assert.throws(
		() =>
			projectsModule.parseProjectCatalogue({
				schemaVersion: 1,
				projects: [
					{
						projectId: "alpha",
						name: "Alpha",
						aliases: ["shared"],
						programmes: [
							alphaProgramme("a1", "/r/r.git", "pi-aaaaaaaaaaaaaaaaaaaa"),
						],
					},
					{
						projectId: "beta",
						name: "Beta",
						aliases: ["shared"],
						programmes: [
							alphaProgramme("b1", "/s/s.git", "pi-bbbbbbbbbbbbbbbbbbbb"),
						],
					},
				],
			}),
		/alias/i,
	);
});

test("P2: duplicate programmeId across the catalogue is rejected", () => {
	assert.throws(
		() =>
			projectsModule.parseProjectCatalogue({
				schemaVersion: 1,
				projects: [
					{
						projectId: "alpha",
						name: "Alpha",
						aliases: [],
						programmes: [
							alphaProgramme("dup", "/r/r.git", "pi-aaaaaaaaaaaaaaaaaaaa"),
							alphaProgramme("dup", "/s/s.git", "pi-bbbbbbbbbbbbbbbbbbbb"),
						],
					},
				],
			}),
		/programmeId/,
	);
});

test("P2: two distinct programmes may share a parentAgentId only across different repos (duplicate mailbox in same repo rejected)", () => {
	assert.throws(
		() =>
			projectsModule.parseProjectCatalogue({
				schemaVersion: 1,
				projects: [
					{
						projectId: "alpha",
						name: "Alpha",
						aliases: [],
						programmes: [
							{
								programmeId: "alpha-web",
								checkoutRoot: "/var/checkouts/alpha-web",
								repoKey: "/var/repos/alpha.git",
								parentAgentId: "pi-aaaaaaaaaaaaaaaaaaaa",
							},
							{
								programmeId: "alpha-api",
								checkoutRoot: "/var/checkouts/alpha-api",
								repoKey: "/var/repos/alpha.git", // same repo
								parentAgentId: "pi-aaaaaaaaaaaaaaaaaaaa", // same agent — collision
							},
						],
					},
				],
			}),
		/mailbox|repoKey.*parentAgentId|duplicate/i,
	);
});

test("P2: same agentId across different repos is allowed (model-free dual-repo operator)", () => {
	const cat = projectsModule.parseProjectCatalogue({
		schemaVersion: 1,
		projects: [
			{
				projectId: "alpha",
				name: "Alpha",
				aliases: [],
				programmes: [
					{
						programmeId: "alpha-web",
						checkoutRoot: "/var/checkouts/alpha-web",
						repoKey: "/var/repos/alpha-web.git",
						parentAgentId: "pi-sharedagentidxxxxxxx",
					},
					{
						programmeId: "alpha-api",
						checkoutRoot: "/var/checkouts/alpha-api",
						repoKey: "/var/repos/alpha-api.git",
						parentAgentId: "pi-sharedagentidxxxxxxx",
					},
				],
			},
		],
	});
	assert.equal(cat.projects[0].programmes.length, 2);
});

test("P2: parseProjectCatalogue preserves validated configuration references", () => {
	const cat = projectsModule.parseProjectCatalogue(ALPHA);
	assert.equal(cat.schemaVersion, 1);
	assert.equal(cat.projects.length, 2);
	assert.equal(cat.projects[0].projectId, "alpha");
	assert.equal(cat.projects[0].programmes[0].programmeId, "alpha-web");
});

// ─── readProjectCatalogue ────────────────────────────────────────────────────

test("P2: readProjectCatalogue throws a clear error when the file is absent", () => {
	const dir = fixtureDir();
	try {
		const absent = join(dir, "no-such.json");
		assert.throws(
			() => projectsModule.readProjectCatalogue(absent),
			/(not found|absent|ENOENT|cannot read)/i,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("P2: readProjectCatalogue throws a clear error on malformed JSON", () => {
	const dir = fixtureDir();
	try {
		const file = join(dir, "muster-projects.json");
		writeFileSync(file, "{not-json");
		assert.throws(
			() => projectsModule.readProjectCatalogue(file),
			/malformed|JSON|parse/i,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("P2: readProjectCatalogue throws on schema-invalid content", () => {
	const dir = fixtureDir();
	try {
		const file = join(dir, "muster-projects.json");
		writeFileSync(file, JSON.stringify({ schemaVersion: 99, projects: [] }));
		assert.throws(
			() => projectsModule.readProjectCatalogue(file),
			/schemaVersion/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("P2: readProjectCatalogue reads and validates a valid file from a temporary path", () => {
	const dir = fixtureDir();
	try {
		const file = join(dir, "muster-projects.json");
		writeFileSync(file, JSON.stringify(ALPHA));
		const cat = projectsModule.readProjectCatalogue(file);
		assert.equal(cat.projects.length, 2);
		assert.ok(existsSync(file), "fixture file is real on disk");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ─── resolveProjectTarget: explicit request ──────────────────────────────────

test("P2: explicit projectId resolves to the single matching project + active programme", () => {
	const r = projectsModule.resolveProjectTarget({
		catalogue: ALPHA,
		requested: "alpha",
		activeProgrammeIds: ACTIVE,
	});
	assert.equal(r.kind, "resolved");
	if (r.kind === "resolved") {
		assert.equal(r.candidate.project.projectId, "alpha");
		assert.equal(r.candidate.programme.programmeId, "alpha-web");
	}
});

test("P2: explicit request matches human name and alias case-insensitively without rewriting identifiers", () => {
	const r1 = projectsModule.resolveProjectTarget({
		catalogue: ALPHA,
		requested: "alpha adventure",
		activeProgrammeIds: ACTIVE,
	});
	assert.equal(r1.kind, "resolved");
	if (r1.kind === "resolved") {
		assert.equal(r1.candidate.project.projectId, "alpha");
	}

	const r2 = projectsModule.resolveProjectTarget({
		catalogue: ALPHA,
		requested: "AL",
		activeProgrammeIds: ACTIVE,
	});
	assert.equal(r2.kind, "resolved");
	if (r2.kind === "resolved") {
		assert.equal(r2.candidate.project.projectId, "alpha");
	}
});

test("P2: explicit unknown request blocks (no fallback)", () => {
	const r = projectsModule.resolveProjectTarget({
		catalogue: ALPHA,
		requested: "gamma",
		activeProgrammeIds: ACTIVE,
	});
	assert.equal(r.kind, "blocked");
	if (r.kind === "blocked") {
		assert.match(r.reason, /unknown|not.*found|requested/i);
	}
});

// ─── resolveProjectTarget: selectedProjectId ─────────────────────────────────

test("P2: selected project narrows before unrelated backend-active programmes", () => {
	const r = projectsModule.resolveProjectTarget({
		catalogue: ALPHA,
		selectedProjectId: "beta",
		activeProgrammeIds: ACTIVE,
	});
	assert.equal(r.kind, "resolved");
	if (r.kind === "resolved") {
		assert.equal(r.candidate.project.projectId, "beta");
		assert.equal(r.candidate.programme.programmeId, "beta-stack");
	}
});

// ─── resolveProjectTarget: checkoutRepoKey ───────────────────────────────────

test("P2: checkoutRepoKey disambiguates when no explicit request — single matching repo wins", () => {
	const r = projectsModule.resolveProjectTarget({
		catalogue: ALPHA,
		checkoutRepoKey: ALPHA_API_KEY,
		activeProgrammeIds: ACTIVE,
	});
	assert.equal(r.kind, "resolved");
	if (r.kind === "resolved") {
		assert.equal(r.candidate.project.projectId, "alpha");
		assert.equal(r.candidate.programme.programmeId, "alpha-api");
	}
});

test("P2: unregistered checkout with multiple eligible programmes returns a selector", () => {
	const r = projectsModule.resolveProjectTarget({
		catalogue: ALPHA,
		checkoutRepoKey: "/var/repos/no-such.git",
		activeProgrammeIds: ["alpha-web", "beta-stack"],
	});
	assert.equal(r.kind, "select");
});

// ─── resolveProjectTarget: single active registered programme ────────────────

test("P2: with multiple active registered programmes for one project, all candidates are returned as selector", () => {
	// Both alpha programmes are active registered; expected: selector listing both.
	const r = projectsModule.resolveProjectTarget({
		catalogue: ALPHA,
		activeProgrammeIds: ["alpha-web", "alpha-api"],
	});
	assert.equal(r.kind, "select");
	if (r.kind === "select") {
		assert.equal(r.candidates.length, 2);
		const ids = r.candidates.map((c) => c.programme.programmeId).sort();
		assert.deepEqual(ids, ["alpha-api", "alpha-web"]);
	}
});

test("P2: with no active registered programmes but a single project, that project returns its single programme", () => {
	const r = projectsModule.resolveProjectTarget({
		catalogue: ALPHA,
		selectedProjectId: "beta",
		activeProgrammeIds: [],
	});
	assert.equal(r.kind, "resolved");
	if (r.kind === "resolved") {
		assert.equal(r.candidate.project.projectId, "beta");
		assert.equal(r.candidate.programme.programmeId, "beta-stack");
	}
});

test("P2: with no active programmes anywhere, the selector contains every registered candidate", () => {
	const r = projectsModule.resolveProjectTarget({
		catalogue: ALPHA,
		activeProgrammeIds: [],
	});
	assert.equal(r.kind, "select");
	if (r.kind === "select") {
		// one candidate per programme across both projects
		assert.equal(r.candidates.length, 3);
	}
});

// ─── explicitProgrammeId ─────────────────────────────────────────────────────

test("P2: explicitProgrammeId filters within resolved project — unknown blocks", () => {
	const r = projectsModule.resolveProjectTarget({
		catalogue: ALPHA,
		requested: "alpha",
		activeProgrammeIds: ACTIVE,
		explicitProgrammeId: "alpha-typo",
	});
	assert.equal(r.kind, "blocked");
	if (r.kind === "blocked") {
		assert.match(r.reason, /programme/i);
	}
});

test("P2: explicitProgrammeId picks the named programme when more than one active candidate", () => {
	const r = projectsModule.resolveProjectTarget({
		catalogue: ALPHA,
		requested: "alpha",
		activeProgrammeIds: ["alpha-web", "alpha-api"],
		explicitProgrammeId: "alpha-api",
	});
	assert.equal(r.kind, "resolved");
	if (r.kind === "resolved") {
		assert.equal(r.candidate.programme.programmeId, "alpha-api");
	}
});

// ─── Ambiguity / first-array-entry rule ─────────────────────────────────────

test("P2: never selects first array entry when ambiguity exists — explicit request resolves alpha precisely", () => {
	// Two projects, neither explicitly requested. With checkoutRepoKey matching both repos we must
	// not pick the first entry. Here only one repo key is given so this is single-match; this
	// test guards against silent first-wins regressions by asserting the candidate is not the
	// first entry when the lookup yields a single distinct repo (alpha-api) inside alpha project.
	const r = projectsModule.resolveProjectTarget({
		catalogue: ALPHA,
		checkoutRepoKey: ALPHA_API_KEY,
		activeProgrammeIds: ["alpha-web", "alpha-api"],
	});
	assert.equal(r.kind, "resolved");
	if (r.kind === "resolved") {
		assert.notEqual(r.candidate.programme.programmeId, "alpha-web");
		assert.equal(r.candidate.programme.programmeId, "alpha-api");
	}
});

// ─── Empty catalogue ─────────────────────────────────────────────────────────

test("P2: inactive single registered candidate still requires explicit selection", () => {
	const empty = projectsModule.parseProjectCatalogue({
		schemaVersion: 1,
		projects: [
			{
				projectId: "lonely",
				name: "Lonely",
				aliases: [],
				programmes: [
					alphaProgramme("p1", "/r/r.git", "pi-aaaaaaaaaaaaaaaaaaaa"),
				],
			},
		],
	});
	const r = projectsModule.resolveProjectTarget({
		catalogue: empty,
		activeProgrammeIds: [],
	});
	assert.equal(r.kind, "select");
	if (r.kind === "select") {
		assert.equal(r.candidates.length, 1);
	}
});

test("P2: lookup names, aliases and ids cannot collide across projects", () => {
	for (const field of ["name", "aliases"] as const) {
		const cat = structuredClone(ALPHA);
		if (field === "name") cat.projects[1].name = "alpha";
		else cat.projects[1].aliases = ["ALPHA"];
		assert.throws(
			() => projectsModule.parseProjectCatalogue(cat),
			/collision|duplicate|ambiguous/i,
		);
	}
	const cat = structuredClone(ALPHA);
	cat.projects[1].aliases = [cat.projects[0].name];
	assert.throws(
		() => projectsModule.parseProjectCatalogue(cat),
		/collision|duplicate|ambiguous/i,
	);
});

test("P2: whitespace-only or padded project names and aliases are rejected without repair", () => {
	for (const text of ["   ", " Beta "]) {
		const cat = structuredClone(ALPHA);
		cat.projects[1].name = text;
		assert.throws(
			() => projectsModule.parseProjectCatalogue(cat),
			/name|whitespace/i,
		);
		cat.projects[1].name = "Beta Beacon";
		cat.projects[1].aliases = [text];
		assert.throws(
			() => projectsModule.parseProjectCatalogue(cat),
			/alias|whitespace/i,
		);
	}
});

test("P2: unregistered checkout is no target context and falls back to the single active programme", () => {
	const r = projectsModule.resolveProjectTarget({
		catalogue: ALPHA,
		checkoutRepoKey: "/unrelated/repo",
		activeProgrammeIds: ACTIVE,
	});
	assert.equal(r.kind, "resolved");
	if (r.kind === "resolved")
		assert.equal(r.candidate.programme.programmeId, "alpha-web");
});

test("P2: selected project and checkout disagreement requires explicit selection", () => {
	const r = projectsModule.resolveProjectTarget({
		catalogue: ALPHA,
		selectedProjectId: "beta",
		checkoutRepoKey: ALPHA_API_KEY,
		activeProgrammeIds: ACTIVE,
	});
	assert.equal(r.kind, "select");
	if (r.kind === "select")
		assert.deepEqual(r.candidates.map((c) => c.programme.programmeId).sort(), [
			"alpha-api",
			"beta-stack",
		]);
});

test("P2: project selection and explicit request use the same eligible-programme narrowing", () => {
	const r = projectsModule.resolveProjectTarget({
		catalogue: ALPHA,
		selectedProjectId: "alpha",
		activeProgrammeIds: ACTIVE,
	});
	assert.equal(r.kind, "resolved");
	if (r.kind === "resolved")
		assert.equal(r.candidate.programme.programmeId, "alpha-web");
});

test("P2: resolver never returns the first conflicting lookup from a mutated catalogue", () => {
	const cat = structuredClone(ALPHA);
	cat.projects[0].aliases = ["beta"];
	const r = projectsModule.resolveProjectTarget({
		catalogue: cat,
		requested: "beta",
		activeProgrammeIds: ACTIVE,
	});
	assert.equal(r.kind, "blocked");
});

test("P2: checkout shared by distinct registered projects requires a selector", () => {
	const cat = structuredClone(ALPHA);
	cat.projects[1].programmes[0].repoKey = ALPHA_KEY;
	const r = projectsModule.resolveProjectTarget({
		catalogue: cat,
		checkoutRepoKey: ALPHA_KEY,
		activeProgrammeIds: ACTIVE,
	});
	assert.equal(r.kind, "select");
	if (r.kind === "select")
		assert.deepEqual(r.candidates.map((c) => c.project.projectId).sort(), [
			"alpha",
			"beta",
		]);
});

test("P2: an explicit programme id without project or matching checkout cannot be silently ignored", () => {
	const r = projectsModule.resolveProjectTarget({
		catalogue: ALPHA,
		explicitProgrammeId: "typo",
		activeProgrammeIds: ACTIVE,
	});
	assert.equal(r.kind, "blocked");
});

test("P2: explicit requested project overrides advisory session and checkout context", () => {
	const r = projectsModule.resolveProjectTarget({
		catalogue: ALPHA,
		requested: "alpha",
		selectedProjectId: "beta",
		checkoutRepoKey: BETA_KEY,
		activeProgrammeIds: ACTIVE,
	});
	assert.equal(r.kind, "resolved");
	if (r.kind === "resolved")
		assert.equal(r.candidate.programme.programmeId, "alpha-web");
});

// ─── projectId pattern sanity (not the whole suite, just a kept shape) ──────

test("P2: production parser enforces projectId format and length boundaries", () => {
	for (const id of ["a", "a-b_c", "z9", "x".repeat(64)]) {
		const cat = structuredClone(ALPHA);
		cat.projects[0].projectId = id;
		assert.equal(
			projectsModule.parseProjectCatalogue(cat).projects[0].projectId,
			id,
		);
	}
	for (const id of ["1", "A", "x".repeat(65)]) {
		const cat = structuredClone(ALPHA);
		cat.projects[0].projectId = id;
		assert.throws(() => projectsModule.parseProjectCatalogue(cat), /projectId/);
	}
});

test("WPS D2: a register entry may carry a one-line display title; without one it still validates", () => {
	const project = (extra: Record<string, unknown>) => ({
		projectId: "alpha",
		name: "alpha",
		aliases: [],
		programmes: [alphaProgramme("agp_alpha000001", "/var/repos/alpha/.git", "pi-alpha-parent")],
		...extra,
	});
	const parsed = projectsModule.parseProjectCatalogue({ schemaVersion: 1, projects: [project({ title: "Alpha Product" })] });
	assert.equal(parsed.projects[0]!.title, "Alpha Product");
	const bare = projectsModule.parseProjectCatalogue({ schemaVersion: 1, projects: [project({})] });
	assert.equal(bare.projects[0]!.title, undefined);
	for (const bad of ["", "   ", "two\nlines", 7]) {
		assert.throws(() => projectsModule.parseProjectCatalogue({ schemaVersion: 1, projects: [project({ title: bad })] }), /title/, JSON.stringify(bad));
	}
	// The title is a label, not a lookup key: two projects may share one without a collision.
	const second = { ...project({ title: "Shared" }), projectId: "beta", name: "beta", programmes: [alphaProgramme("agp_beta0000001", "/var/repos/beta/.git", "pi-beta-parent")] };
	assert.doesNotThrow(() => projectsModule.parseProjectCatalogue({ schemaVersion: 1, projects: [project({ title: "Shared" }), second] }));
});

test("WPS D2: the real register parses and names the three display titles", () => {
	const real = JSON.parse(readFileSync(join(piAgentDir(), "muster-projects.json"), "utf8"));
	const catalogue = projectsModule.parseProjectCatalogue(real);
	const titles = Object.fromEntries(catalogue.projects.filter((p) => p.title !== undefined).map((p) => [p.projectId, p.title]));
	assert.deepEqual(titles, { "crm-app": "the CRM app", "acme-realty-website": "Acme Realty website", "pi-agent": "Your AI team" });
});
