import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { repoTopologyForCheckout } from "../binding.ts";
import { command as projectCommand } from "../cli/project.ts";
import type { CliContext } from "../cli/types.ts";
import { parseProjectCatalogue } from "../projects.ts";

/**
 * SK2 — the employer in the project register
 * (plans/secrets/key-management-blueprint-2026-10-16.md, section 12).
 *
 * Acceptance: a linked worktree of a registered project carries the project's
 * employer, a directory outside the register (and any non-Git directory such
 * as `~`) is `personal`, an unknown employer value fails the catalogue parse
 * naming the project id, and the CLI verb prints the bare resolver value.
 * Fixtures are temp Git repositories and temp catalogue files only; the live
 * register is never read or written here.
 */

import * as projectsModule from "../projects.ts";

type Workspace = { root: string; repo: string; worktree: string; repoKey: string; catalogue: string };

/** A registered temp repo with a linked worktree, and the catalogue claiming it as `alpha`. */
async function workspace(fixtureEmployer: "acme-realty" | undefined): Promise<Workspace> {
	const root = mkdtempSync(join(tmpdir(), "muster-projects-employer-"));
	let repo!: string, worktree!: string, repoKey!: string, catalogue!: string;
	try {
		repo = join(root, "register-repo");
		mkdirSync(repo);
		writeFileSync(join(repo, "README.md"), "employer fixture\n");
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
		execFileSync("git", ["-C", repo, "add", "."]);
		execFileSync("git", ["-C", repo, "-c", "user.email=operator@local", "-c", "user.name=operator", "commit", "-qm", "init"]);
		// The worktree lives beside the repo, like `~/projects/be-lane-*`:
		// resolution must go through the common dir, never the cwd itself.
		worktree = join(root, "be-lane-fixture");
		execFileSync("git", ["-C", repo, "worktree", "add", "-q", worktree, "-b", "employer-fixture"]);
		repoKey = (await repoTopologyForCheckout(repo)).repoKey;
		catalogue = join(root, "projects.json");
		writeFileSync(catalogue, JSON.stringify({
			schemaVersion: 1,
			projects: [
				{
					projectId: "alpha",
					name: "Alpha Register",
					aliases: [],
					...(fixtureEmployer !== undefined ? { employer: fixtureEmployer } : {}),
					programmes: [
						{
							programmeId: "pg-alpha",
							checkoutRoot: "/var/checkouts/alpha",
							repoKey,
							parentAgentId: "pi-alpha-parent-fixture",
						},
					],
				},
				{
					projectId: "beta",
					name: "Beta Register",
					aliases: [],
					programmes: [
						{
							programmeId: "pg-beta",
							checkoutRoot: "/var/checkouts/beta",
							repoKey: "/var/repos/beta-nope/.git",
							parentAgentId: "pi-beta-parent-fixture",
						},
					],
				},
			],
		}));
		return { root, repo, worktree, repoKey, catalogue };
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
}

function catalogueWithProject(employer: unknown, projectId: string): Record<string, unknown> {
	return {
		schemaVersion: 1,
		projects: [
			{
				projectId,
				name: "Alpha Register",
				aliases: [],
				...(employer === undefined ? {} : { employer }),
				programmes: [
					{ programmeId: "pg-alpha", checkoutRoot: "/var/checkouts/alpha", repoKey: "/var/repos/alpha/.git", parentAgentId: "pi-alpha-parent-fixture" },
				],
			},
		],
	};
}

// ─── Catalogue parse ─────────────────────────────────────────────────────────

test("SK2: employer parses verbatim, absence stores nothing", () => {
	const parsed = parseProjectCatalogue({
		schemaVersion: 1,
		projects: [
			{
				projectId: "alpha",
				name: "Alpha Register",
				aliases: [],
				employer: "acme-realty",
				programmes: [
					{ programmeId: "pg-alpha", checkoutRoot: "/var/checkouts/alpha", repoKey: "/var/repos/alpha/.git", parentAgentId: "pi-alpha-parent-fixture" },
				],
			},
			{
				projectId: "beta",
				name: "Beta Register",
				aliases: [],
				programmes: [
					{ programmeId: "pg-beta", checkoutRoot: "/var/checkouts/beta", repoKey: "/var/repos/beta-nope/.git", parentAgentId: "pi-beta-parent-fixture" },
				],
			},
		],
	});
	assert.equal(parsed.projects[0]!.employer, "acme-realty");
	assert.equal(parsed.projects[1]!.employer, undefined);
});

test("SK2: an unknown employer value fails the parse naming the project id", () => {
	assert.throws(
		() => parseProjectCatalogue(catalogueWithProject("enterprise", "alpha")),
		(error: unknown) =>
			error instanceof Error &&
			error.message.includes('on project "alpha"') &&
			error.message.includes('got "enterprise"'),
	);
	// Verbatim matching: casing and padding are not the register's values.
	assert.throws(
		() => parseProjectCatalogue(catalogueWithProject("Acme Realty", "alpha")),
		(error: unknown) => error instanceof Error && error.message.includes('on project "alpha"'),
	);
});

// ─── Employer resolution ─────────────────────────────────────────────────────

test("SK2: employerForProject defaults an absent field to personal", () => {
	const set = parseProjectCatalogue(catalogueWithProject("acme-realty", "alpha"));
	const absent = parseProjectCatalogue(catalogueWithProject(undefined, "alpha"));
	assert.equal(projectsModule.employerForProject(set.projects[0]!), "acme-realty");
	assert.equal(projectsModule.employerForProject(absent.projects[0]!), "personal");
});

test("SK2: a linked worktree and its primary checkout carry the project's employer", async () => {
	const ws = await workspace("acme-realty");
	try {
		assert.equal(await projectsModule.employerForCwd(ws.worktree, ws.catalogue), "acme-realty");
		assert.equal(await projectsModule.employerForCwd(ws.repo, ws.catalogue), "acme-realty");
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("SK2: a directory outside the register (and non-Git paths) are personal", async () => {
	const ws = await workspace("acme-realty");
	try {
		// A registered repo with no employer field is personal.
		mkdirSync(join(ws.root, "secondary-repo"));
		writeFileSync(join(ws.root, "secondary-repo", "keep"), "x\n");
		execFileSync("git", ["init", "-q"], { cwd: join(ws.root, "secondary-repo") });
		assert.equal(
			await projectsModule.employerForCwd(join(ws.root, "secondary-repo"), ws.catalogue),
			"personal",
			"a registered project without an employer field is personal",
		);
		// A Git repository the register does not know.
		mkdirSync(join(ws.root, "plain-dir"));
		writeFileSync(join(ws.root, "plain-dir", "keep"), "x\n");
		execFileSync("git", ["init", "-q"], { cwd: join(ws.root, "plain-dir") });
		assert.equal(
			await projectsModule.employerForCwd(join(ws.root, "plain-dir"), ws.catalogue),
			"personal",
			"a repo outside the register is personal",
		);
		// `~` and any non-Git directory: no repository, no project, personal.
		assert.equal(
			await projectsModule.employerForCwd(mkdtempSync(join(tmpdir(), "muster-projects-employer-nogit-")), ws.catalogue),
			"personal",
			"a non-Git directory (like ~) is personal",
		);
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("SK2: a catalogue failure propagates instead of silently downgrading to personal", async () => {
	const ws = await workspace("acme-realty");
	try {
		const missing = join(ws.root, "does-not-exist.json");
		await assert.rejects(
			projectsModule.employerForCwd(ws.worktree, missing),
			/catalogue file not found/,
		);
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

// ─── CLI verb ────────────────────────────────────────────────────────────────

async function withCatalogueEnv<T>(file: string, run: () => Promise<T>): Promise<T> {
	const saved = process.env.PI_MUSTER_PROJECTS_FILE;
	process.env.PI_MUSTER_PROJECTS_FILE = file;
	try {
		return await run();
	} finally {
		if (saved === undefined) delete process.env.PI_MUSTER_PROJECTS_FILE;
		else process.env.PI_MUSTER_PROJECTS_FILE = saved;
	}
}

function cliCtx(
	argv: string[],
	cwd: string,
	json: boolean,
): { ctx: CliContext; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	return {
		out,
		err,
		ctx: {
			argv,
			repoRoot: "/tmp/no-repo",
			agentId: undefined,
			json,
			cwd,
			env: { PI_MUSTER_PROJECTS_FILE: process.env.PI_MUSTER_PROJECTS_FILE },
			io: { out: (line) => out.push(line), err: (line) => err.push(line) },
			readStdin: async () => "",
		},
	};
}

test("SK2: muster project employer prints the bare employer for a registered worktree", async () => {
	const ws = await workspace("acme-realty");
	try {
		await withCatalogueEnv(ws.catalogue, async () => {
			const { ctx, out, err } = cliCtx(["employer", "--cwd", ws.worktree], "/tmp/no-repo", false);
			const code = await projectCommand.run(ctx);
			assert.equal(code, 0);
			assert.deepEqual(out, ["acme-realty"]);
			assert.deepEqual(err, []);
		});
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("SK2: muster project employer --json prints the employer object", async () => {
	const ws = await workspace("acme-realty");
	try {
		await withCatalogueEnv(ws.catalogue, async () => {
			const { ctx, out } = cliCtx(["employer", "--cwd", ws.repo], "/tmp/no-repo", true);
			const code = await projectCommand.run(ctx);
			assert.equal(code, 0);
			assert.deepEqual(out, [JSON.stringify({ employer: "acme-realty" })]);
		});
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("SK2: muster project employer defaults --cwd to the session directory", async () => {
	const ws = await workspace("acme-realty");
	try {
		await withCatalogueEnv(ws.catalogue, async () => {
			const { ctx, out } = cliCtx(["employer"], ws.worktree, false);
			const code = await projectCommand.run(ctx);
			assert.equal(code, 0);
			assert.deepEqual(out, ["acme-realty"]);
		});
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("SK2: muster project employer outside the register prints personal", async () => {
	const ws = await workspace(undefined);
	const plain = mkdtempSync(join(tmpdir(), "muster-projects-employer-nogit-"));
	try {
		await withCatalogueEnv(ws.catalogue, async () => {
			const { ctx, out, err } = cliCtx(["employer", "--cwd", plain], "/tmp/no-repo", false);
			const code = await projectCommand.run(ctx);
			assert.equal(code, 0);
			assert.deepEqual(out, ["personal"]);
			assert.deepEqual(err, []);
		});
	} finally {
		rmSync(plain, { recursive: true, force: true });
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("SK2: muster project refuses an unknown subcommand with usage", async () => {
	const ws = await workspace(undefined);
	try {
		await withCatalogueEnv(ws.catalogue, async () => {
			const { ctx, out, err } = cliCtx(["list"], "/tmp/no-repo", false);
			const code = await projectCommand.run(ctx);
			assert.equal(code, 2);
			assert.deepEqual(out, []);
			assert.match(err[0] ?? "", /muster project: usage: employer/);
		});
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("SK2: muster project employer reports a catalogue failure with exit 3", async () => {
	const ws = await workspace("acme-realty");
	try {
		await withCatalogueEnv(join(ws.root, "does-not-exist.json"), async () => {
			const { ctx, out, err } = cliCtx(["employer", "--cwd", ws.worktree], "/tmp/no-repo", false);
			const code = await projectCommand.run(ctx);
			assert.equal(code, 3);
			assert.deepEqual(out, []);
			assert.match(err[0] ?? "", /muster project: muster-projects: catalogue file not found/);
		});
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});
