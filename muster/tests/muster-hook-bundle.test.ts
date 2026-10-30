/**
 * The prebuilt `muster claude-hook` bundle (`extensions/muster/claude-hook.bundle.mjs`).
 *
 * The launcher runs the bundle for `claude-hook` when every source hash in its header still matches and
 * falls back to tsx otherwise. These cases prove the three promises of that rule: the committed bundle is
 * fresh, the bundle answers exactly as the tsx path does, and a stale or missing bundle changes the speed
 * of the call, never its answer.
 */

import "./muster-test-isolation.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { enclosingProfile, harnessRoot, nodeBinary } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = harnessRoot(import.meta.url);
/**
 * The agent directory: the tree that holds `bin`, `node_modules` and `scripts`, and that every recorded
 * `harness/...` source is relative to. It is Pi's profile when this checkout sits inside one and the
 * repository root when it does not (`harness-paths.ts`); `harnessRoot` alone is only right in the second.
 */
const AGENT_ROOT = enclosingProfile(import.meta.url) ?? HARNESS_ROOT;
const PROFILE = enclosingProfile(import.meta.url) ?? piAgentDir();
const MUSTER_DIR = join(PROFILE, "extensions", "muster");
const LAUNCHER = join(MUSTER_DIR, "launchers", "muster");
const BUNDLE = join(MUSTER_DIR, "claude-hook.bundle.mjs");
const SESSION = "0a1b2c3d-1111-4222-8333-444455556666";

interface Install {
	state: string;
	env: NodeJS.ProcessEnv;
	cleanup: () => void;
}

/** A disposable muster state dir with a job record naming lane `cc-lane` and one pending message. */
function install(): Install {
	const root = mkdtempSync(join(tmpdir(), "muster-hook-bundle-"));
	const state = join(root, "muster");
	const claudeDir = join(root, "claude");
	mkdirSync(join(claudeDir, "jobs", SESSION.slice(0, 8)), { recursive: true });
	writeFileSync(join(claudeDir, "jobs", SESSION.slice(0, 8), "state.json"), JSON.stringify({ name: "cc-lane", sessionId: SESSION, template: "bg" }));
	const inbox = join(state, "inbox", "cc-lane");
	mkdirSync(inbox, { recursive: true });
	const at = "2026-10-09T10:00:00.000Z";
	writeFileSync(
		join(inbox, `${String(Date.parse(at)).padStart(13, "0")}-m1.json`),
		JSON.stringify({ id: "m1", from: "cc-orchestrator", text: "report the parity table", agent: "cc-lane", at, idempotencyKey: "key-m1", mode: "steer", source: "send" }),
	);
	return { state, env: { PI_MUSTER_STATE_DIR: state, HOME: join(root, "home"), CLAUDE_CONFIG_DIR: claudeDir }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function payload(event: string): string {
	return JSON.stringify({ hook_event_name: event, session_id: SESSION, cwd: "/w/cc-lane", model: "claude-haiku-4-5-20251001" });
}

function run(command: string, args: string[], input: string, env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(command, args, { encoding: "utf8", timeout: 60_000, input, cwd: HARNESS_ROOT, env: { ...process.env, ...env } });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The tsx path, exactly as the launcher falls back to it. `bin/node` is untracked live state and is missing in worktrees, so the repo's own node runs the loader there. */
function viaTsx(args: string[], input: string, env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
	const node = nodeBinary();
	return run(node, ["--import", `file://${join(AGENT_ROOT, "node_modules", "tsx", "dist", "loader.mjs")}`, join(AGENT_ROOT, "scripts", "muster.mts"), ...args], input, env);
}

test("the committed bundle is fresh against its sources", () => {
	const result = run(process.execPath, [join(MUSTER_DIR, "build-hook-bundle.mjs"), "--check"], "", {});
	assert.equal(result.status, 0, `rebuild with: node extensions/muster/build-hook-bundle.mjs\n${result.stderr}`);
});

test("a build in a worktree whose files are links into the main checkout writes the same bundles main does", () => {
	// A worktree links node_modules (and here every source) to the main checkout. The bundle must record each
	// source by its path in the repository, never by where the link leads, or main reads it as stale (2026-10-17).
	const root = mkdtempSync(join(tmpdir(), "muster-hook-bundle-worktree-"));
	try {
		for (const name of readdirSync(PROFILE)) {
			if (name !== "extensions" && name !== ".git") symlinkSync(join(PROFILE, name), join(root, name));
		}
		mkdirSync(join(root, "extensions", "muster"), { recursive: true });
		for (const name of readdirSync(join(PROFILE, "extensions"))) {
			if (name !== "muster") symlinkSync(join(PROFILE, "extensions", name), join(root, "extensions", name));
		}
		for (const name of readdirSync(MUSTER_DIR)) {
			if (name !== "build-hook-bundle.mjs" && !name.endsWith(".bundle.mjs")) symlinkSync(join(MUSTER_DIR, name), join(root, "extensions", "muster", name));
		}
		copyFileSync(join(MUSTER_DIR, "build-hook-bundle.mjs"), join(root, "extensions", "muster", "build-hook-bundle.mjs"));
		const built = spawnSync(process.execPath, [join(root, "extensions", "muster", "build-hook-bundle.mjs")], { encoding: "utf8", timeout: 120_000, cwd: root });
		assert.equal(built.status, 0, built.stderr);
		for (const verb of ["claude-hook", "seat"]) {
			const text = readFileSync(join(root, "extensions", "muster", `${verb}.bundle.mjs`), "utf8");
			assert.doesNotMatch(text, /^\/\/ src-sha256 [0-9a-f]{64} {2}\.\.\//m, `${verb}: a source recorded outside the repository`);
			assert.equal(text, readFileSync(join(MUSTER_DIR, `${verb}.bundle.mjs`), "utf8"), `${verb}: the worktree build differs from the committed bundle`);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the bundle and the tsx path answer identically: delivery, ledger, inert and unreadable payloads", () => {
	const cases: Array<{ name: string; args: string[]; input: string }> = [
		{ name: "delivery", args: ["claude-hook", "PostToolUse"], input: payload("PostToolUse") },
		{ name: "nothing left to deliver", args: ["claude-hook", "PostToolUse"], input: payload("PostToolUse") },
		{ name: "stop", args: ["claude-hook", "Stop"], input: payload("Stop") },
		{ name: "inbox dir", args: ["claude-hook", "--session", SESSION, "--inbox-dir"], input: "" },
		{ name: "unknown session is inert", args: ["claude-hook", "PostToolUse", "--session", "9f8e7d6c-1111-4222-8333-444455556666"], input: "{}" },
		{ name: "unreadable payload fails open", args: ["claude-hook", "PostToolUse"], input: "{not json" },
	];
	const bundled = install();
	const tsx = install();
	try {
		for (const { name, args, input } of cases) {
			const a = run(LAUNCHER, args, input, bundled.env);
			const b = viaTsx(args, input, tsx.env);
			// The state dir differs per install; the answers must not otherwise.
			const same = (text: string, state: string): string => text.split(state).join("<state>");
			assert.equal(a.status, b.status, `${name}: exit code`);
			assert.equal(same(a.stdout, bundled.state), same(b.stdout, tsx.state), `${name}: stdout`);
			assert.equal(a.stderr, b.stderr, `${name}: stderr`);
		}
		const card = (state: string): Record<string, unknown> => {
			const { lastActivityMs: _a, updatedAt: _b, ...rest } = JSON.parse(readFileSync(join(state, "lanes", "cc-lane.json"), "utf8")) as Record<string, unknown>;
			return rest;
		};
		const bundledCard = card(bundled.state);
		assert.equal(bundledCard["state"], "idle");
		assert.deepEqual(Object.keys(bundledCard).sort(), Object.keys(card(tsx.state)).sort(), "the same card fields");
		assert.equal(readdirSync(join(bundled.state, "inbox", "cc-lane", "read")).length, 1, "the ledger moved the message");
	} finally {
		bundled.cleanup();
		tsx.cleanup();
	}
});

/** An agent directory whose launcher and sources are the real ones, but whose `<verb>.bundle.mjs` this test chooses. */
function agentDirWithBundle(bundleText: string | undefined, verb = "claude-hook"): { launcher: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "muster-hook-bundle-agent-"));
	for (const name of ["bin", "node_modules", "scripts"]) symlinkSync(join(AGENT_ROOT, name), join(root, name));
	// The launcher verifies each recorded source from this directory, so the scratch agent folder resolves
	// `harness/...` the way a real profile does.
	symlinkSync(HARNESS_ROOT, join(root, "harness"));
	mkdirSync(join(root, "extensions", "muster", "launchers"), { recursive: true });
	for (const name of readdirSync(join(PROFILE, "extensions"))) {
		if (name !== "muster") symlinkSync(join(PROFILE, "extensions", name), join(root, "extensions", name));
	}
	for (const name of readdirSync(MUSTER_DIR)) {
		if (name !== "launchers" && name !== `${verb}.bundle.mjs`) symlinkSync(join(MUSTER_DIR, name), join(root, "extensions", "muster", name));
	}
	copyFileSync(LAUNCHER, join(root, "extensions", "muster", "launchers", "muster"));
	if (bundleText !== undefined) writeFileSync(join(root, "extensions", "muster", `${verb}.bundle.mjs`), bundleText);
	return { launcher: join(root, "extensions", "muster", "launchers", "muster"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const MARKER = "BUNDLE-RAN";
/** Makes a bundle announce itself on stderr, so a case can tell which path answered. */
function withMarker(text: string): string {
	const marked = text.replace("\n\n// harness/muster/cli-main.ts\n", `\nprocess.stderr.write("${MARKER}\\n");\n\n// harness/muster/cli-main.ts\n`);
	assert.notEqual(marked, text, "the marker must land in the bundle");
	return marked;
}

/**
 * The bundle records every source it was built from relative to the agent directory it was built in
 * (`build-hook-bundle.mjs`), and that set reaches outside the repository (Pi's ports pull memory's
 * readers and the harness packages). The synthetic agent directory below is somewhere else, so the
 * recorded paths are made absolute here: they resolve under the real install either way, and the
 * freshness check still tests every source it names.
 */
test("the launcher runs the bundle when it is fresh, and falls back to tsx when it is stale or missing", () => {
	const marked = withMarker(readFileSync(BUNDLE, "utf8"));
	const flipFirstHash = (text: string): string => text.replace(/^(\/\/ src-sha256 )([0-9a-f])/m, (_m, head: string, digit: string) => `${head}${digit === "0" ? "1" : "0"}`);
	const cases: Array<{ name: string; bundle: string | undefined; bundleRuns: boolean }> = [
		{ name: "fresh", bundle: marked, bundleRuns: true },
		{ name: "one source hash differs", bundle: flipFirstHash(marked), bundleRuns: false },
		{ name: "a named source is gone", bundle: marked.replace("harness/muster/lib/agent-inbox.ts", "extensions/lib/no-such-source.ts"), bundleRuns: false },
		{ name: "no bundle", bundle: undefined, bundleRuns: false },
	];
	for (const { name, bundle, bundleRuns } of cases) {
		const dir = agentDirWithBundle(bundle);
		const inst = install();
		try {
			const result = run(dir.launcher, ["claude-hook", "PostToolUse"], payload("PostToolUse"), inst.env);
			assert.equal(result.stderr.includes(MARKER), bundleRuns, `${name}: which path answered (stderr: ${result.stderr})`);
			assert.equal(result.status, 0, `${name}: exit code`);
			const delivered = JSON.parse(result.stdout.trim()) as { hookSpecificOutput?: { additionalContext?: string[] } };
			assert.match(delivered.hookSpecificOutput?.additionalContext?.[0] ?? "", /report the parity table/, `${name}: the message is still delivered`);
		} finally {
			dir.cleanup();
			inst.cleanup();
		}
	}
});

test("only claude-hook and seat use a bundle: other verbs stay on tsx", () => {
	for (const verb of ["claude-hook", "seat"]) {
		const dir = agentDirWithBundle(withMarker(readFileSync(join(MUSTER_DIR, `${verb}.bundle.mjs`), "utf8")), verb);
		const inst = install();
		try {
			const result = run(dir.launcher, ["lanes", "--json"], "", inst.env);
			// An empty directory is exit 3 ("no lane matches"); either way `lanes` answered, not a bundle.
			assert.ok(result.status === 0 || result.status === 3, result.stderr);
			assert.equal(result.stderr.includes(MARKER), false, `muster lanes must not run the ${verb} bundle`);
			assert.match(result.stderr + result.stdout, /lane/);
		} finally {
			dir.cleanup();
			inst.cleanup();
		}
	}
});

// ─── The seat bundle (2026-10-17) ────────────────────────────────────────────
// The Claude plugin claims and rebinds seats at session start with a 5 s budget. Through tsx one
// `muster seat` call took 3.6 s alone and over 5 s with four at once, so a resumed holder's rebind
// ran out of time; the bundle answers the same in a fraction of that.

test("the seat bundle and the tsx path answer identically: show, dossier and a refused rebind", () => {
	const cases: Array<{ name: string; args: string[] }> = [
		{ name: "show one seat", args: ["seat", "show", "architect"] },
		{ name: "dossier", args: ["seat", "dossier", "architect", "--json"] },
		{ name: "rebind without a ticket is refused", args: ["seat", "rebind", "architect", "--session", SESSION, "--harness", "claude", "--process-key", "claude-1-1", "--ticket", "no-such-ticket", "--json"] },
		{ name: "unknown role", args: ["seat", "show", "no-such-role"] },
	];
	const bundled = install();
	const tsx = install();
	try {
		for (const { name, args } of cases) {
			const a = run(LAUNCHER, args, "", bundled.env);
			const b = viaTsx(args, "", tsx.env);
			const same = (text: string, state: string): string => text.split(state).join("<state>");
			assert.equal(a.status, b.status, `${name}: exit code`);
			assert.equal(same(a.stdout, bundled.state), same(b.stdout, tsx.state), `${name}: stdout`);
			assert.equal(same(a.stderr, bundled.state), same(b.stderr, tsx.state), `${name}: stderr`);
		}
	} finally {
		bundled.cleanup();
		tsx.cleanup();
	}
});

test("the launcher runs the seat bundle when it is fresh, and falls back to tsx when it is stale or missing", () => {
	const marked = withMarker(readFileSync(join(MUSTER_DIR, "seat.bundle.mjs"), "utf8"));
	const flipFirstHash = (text: string): string => text.replace(/^(\/\/ src-sha256 )([0-9a-f])/m, (_m, head: string, digit: string) => `${head}${digit === "0" ? "1" : "0"}`);
	for (const { name, bundle, bundleRuns } of [
		{ name: "fresh", bundle: marked, bundleRuns: true },
		{ name: "one source hash differs", bundle: flipFirstHash(marked), bundleRuns: false },
		{ name: "no bundle", bundle: undefined, bundleRuns: false },
	]) {
		const dir = agentDirWithBundle(bundle, "seat");
		const inst = install();
		try {
			const result = run(dir.launcher, ["seat", "dossier", "architect", "--json"], "", inst.env);
			assert.equal(result.stderr.includes(MARKER), bundleRuns, `${name}: which path answered (stderr: ${result.stderr})`);
			assert.equal(result.status, 0, `${name}: exit code`);
			assert.ok(Array.isArray(JSON.parse(result.stdout)), `${name}: the dossier is still answered`);
		} finally {
			dir.cleanup();
			inst.cleanup();
		}
	}
});

test("four seat calls at once through the launcher each finish inside the plugin's 5 s budget", async () => {
	const inst = install();
	try {
		const { spawn } = await import("node:child_process");
		const one = (): Promise<number> =>
			new Promise((done) => {
				const started = Date.now();
				const child = spawn(LAUNCHER, ["seat", "dossier", "architect", "--json"], { cwd: HARNESS_ROOT, env: { ...process.env, ...inst.env }, stdio: "ignore" });
				child.on("close", () => done(Date.now() - started));
			});
		const times = await Promise.all([one(), one(), one(), one()]);
		for (const ms of times) assert.ok(ms < 5_000, `a seat call took ${ms} ms (all: ${times.join(", ")})`);
	} finally {
		inst.cleanup();
	}
});
