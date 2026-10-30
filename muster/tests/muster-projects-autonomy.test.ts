import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * R1 / AM1.1–AM1.2: the project is the repository. The catalogue self-populates
 * on first orchestration, names the project after the repository folder, keeps
 * one stable parent mailbox per project and holds the per-project settings.
 * Every test uses a temp catalogue file; the live catalogue is never read.
 */

import * as projects from "../projects.ts";
import { validateAgentId } from "../binding.ts";

function tempCatalogue(): { dir: string; file: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "muster-projects-auto-"));
	return { dir, file: join(dir, "muster-projects.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const BE_KEY = "/home/operator/projects/crm-app/.git";

test("project name is the repository folder, for a normal repo and for a bare repo", () => {
	assert.equal(projects.projectNameForRepoKey(BE_KEY), "crm-app");
	assert.equal(projects.projectNameForRepoKey("/srv/git/Pixel-Estate.git"), "pixel-estate");
});

test("mailbox is pi-<slug>-parent and a valid agent id of at most 32 chars", () => {
	assert.equal(projects.mailboxForProject("sandbox"), "pi-sandbox-parent");
	const long = projects.mailboxForProject("a-very-long-repository-folder-name-indeed");
	assert.ok(long.length <= 32, long);
	assert.equal(validateAgentId(long), long);
	assert.match(long, /^pi-.+-parent$/);
	assert.notEqual(long, projects.mailboxForProject("a-very-long-repository-folder-name-other"));
});

test("internal programme id is deterministic per repository", () => {
	const a = projects.programmeIdForRepoKey(BE_KEY);
	assert.match(a, /^agp_[0-9a-f]{12}$/);
	assert.equal(a, projects.programmeIdForRepoKey(BE_KEY));
	assert.notEqual(a, projects.programmeIdForRepoKey("/x/other/.git"));
});

test("first orchestration registers the project; a second call is idempotent", () => {
	const t = tempCatalogue();
	try {
		const first = projects.ensureProjectForRepo({ repoKey: BE_KEY, checkoutRoot: "/home/operator/projects/crm-app" }, t.file);
		assert.equal(first.created, true);
		assert.equal(first.project.name, "crm-app");
		assert.equal(first.programme.parentAgentId, "pi-crm-app-parent");
		assert.equal(first.programme.repoKey, BE_KEY);
		const second = projects.ensureProjectForRepo({ repoKey: BE_KEY, checkoutRoot: "/home/operator/projects/be-viewings" }, t.file);
		assert.equal(second.created, false);
		assert.equal(second.programme.programmeId, first.programme.programmeId);
		const catalogue = projects.readProjectCatalogue(t.file);
		assert.equal(catalogue.projects.length, 1);
	} finally {
		t.cleanup();
	}
});

test("two repositories become two projects, and a folder-name clash gets a distinct name", () => {
	const t = tempCatalogue();
	try {
		const a = projects.ensureProjectForRepo({ repoKey: "/p/one/app/.git", checkoutRoot: "/p/one/app" }, t.file);
		const b = projects.ensureProjectForRepo({ repoKey: "/p/two/app/.git", checkoutRoot: "/p/two/app" }, t.file);
		assert.notEqual(a.project.projectId, b.project.projectId);
		assert.notEqual(a.project.name, b.project.name);
		assert.notEqual(a.programme.parentAgentId, b.programme.parentAgentId);
		assert.equal(projects.readProjectCatalogue(t.file).projects.length, 2);
	} finally {
		t.cleanup();
	}
});

test("an existing parent id with open handoffs is adopted as the mailbox only when it is the sole addressee", () => {
	const t = tempCatalogue();
	try {
		const adopted = projects.ensureProjectForRepo(
			{ repoKey: BE_KEY, checkoutRoot: "/x", existingParentIds: ["pi-be-master-plan-parent"] },
			t.file,
		);
		assert.equal(adopted.programme.parentAgentId, "pi-be-master-plan-parent");
		const ambiguous = projects.ensureProjectForRepo(
			{ repoKey: "/p/other/.git", checkoutRoot: "/x", existingParentIds: ["pi-a-parent", "pi-b-parent"] },
			t.file,
		);
		assert.equal(ambiguous.programme.parentAgentId, "pi-other-parent");
		assert.equal(ambiguous.mailboxAmbiguous, true);
	} finally {
		t.cleanup();
	}
});

test("settings and the Discord thread round-trip, and invalid settings are refused", () => {
	const t = tempCatalogue();
	try {
		const settings = {
			integration: { checkout: "/home/operator/projects/be-viewings", branch: "work/viewings" },
			ceiling: 5,
			workerModel: "openai-codex/gpt-6.1-sol",
			workerThinking: "high",
			verify: { test: "scripts/lanes/test.sh", typecheck: "scripts/lanes/typecheck.sh" },
			riskyGlobs: ["prisma/**", "lib/auth/**"],
			parentWritableGlobs: ["docs/**"],
		};
		const created = projects.ensureProjectForRepo({ repoKey: BE_KEY, checkoutRoot: "/x", settings }, t.file);
		projects.setProjectDiscordThread(t.file, created.project.projectId, { channelId: "1100000000000000001", threadId: "1100000000000000002" });
		const read = projects.readProjectCatalogue(t.file).projects[0]!;
		assert.deepEqual(read.settings, settings);
		assert.deepEqual(read.discord, { channelId: "1100000000000000001", threadId: "1100000000000000002" });
		assert.throws(
			() => projects.parseProjectCatalogue({ schemaVersion: 1, projects: [{ ...read, settings: { ceiling: 0 } }] }),
			/ceiling/,
		);
		assert.throws(
			() => projects.parseProjectCatalogue({ schemaVersion: 1, projects: [{ ...read, settings: { riskyGlobs: "prisma/**" } }] }),
			/riskyGlobs/,
		);
	} finally {
		t.cleanup();
	}
});

test("rotation settings round-trip, and a typo or an out-of-range value is refused rather than ignored (R1.5)", () => {
	const t = tempCatalogue();
	try {
		const rotation = {
			rotateAtTokens: 200_000,
			parentModel: "openai-codex/gpt-6.1-sol",
			parentThinking: "high",
			checkpoint: "docs/plans/master-plan.md section 4",
			resumeBrief: "Read the checkpoint, reconcile, continue.",
			cwd: "/home/operator",
		};
		projects.ensureProjectForRepo({ repoKey: BE_KEY, checkoutRoot: "/x", settings: { rotation } }, t.file);
		const read = projects.readProjectCatalogue(t.file).projects[0]!;
		assert.deepEqual(read.settings?.rotation, rotation);
		const parse = (value: unknown) => projects.parseProjectCatalogue({ schemaVersion: 1, projects: [{ ...read, settings: { rotation: value } }] });
		assert.throws(() => parse({ rotateAtTokens: 0 }), /rotateAtTokens/);
		assert.throws(() => parse({ rotateAtTokens: 1.5 }), /rotateAtTokens/);
		assert.throws(() => parse({ rotateAtTokens: 500 }), /rotateAtTokens/, "a threshold below a sane floor would rotate on every turn");
		assert.throws(() => parse({ rotateAtToken: 250_000 }), /unknown/);
		assert.throws(() => parse({ cwd: "relative/dir" }), /cwd/);
		assert.deepEqual(parse({}).projects[0]!.settings?.rotation, {}, "every field is optional");
	} finally {
		t.cleanup();
	}
});

test("a catalogue written by an older release (no settings, no discord) still parses", () => {
	const t = tempCatalogue();
	try {
		writeFileSync(
			t.file,
			JSON.stringify({
				schemaVersion: 1,
				projects: [
					{
						projectId: "alpha",
						name: "Alpha",
						aliases: [],
						programmes: [{ programmeId: "agp_0123456789ab", checkoutRoot: "/a", repoKey: "/a/.git", parentAgentId: "pi-alpha-parent" }],
					},
				],
			}),
		);
		const cat = projects.readProjectCatalogue(t.file);
		assert.equal(cat.projects[0]!.settings, undefined);
		assert.equal(readFileSync(t.file, "utf8").includes("settings"), false);
	} finally {
		t.cleanup();
	}
});

test("lookup by repository resolves every worktree of one repo to the same project", () => {
	const t = tempCatalogue();
	try {
		projects.ensureProjectForRepo({ repoKey: BE_KEY, checkoutRoot: "/home/operator/projects/crm-app" }, t.file);
		const cat = projects.readProjectCatalogue(t.file);
		const hit = projects.findProjectByRepoKey(cat, BE_KEY);
		assert.equal(hit?.project.name, "crm-app");
		assert.equal(projects.findProjectByRepoKey(cat, "/nope/.git"), undefined);
	} finally {
		t.cleanup();
	}
});
