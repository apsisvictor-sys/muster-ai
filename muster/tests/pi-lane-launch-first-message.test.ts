/**
 * The launch recipe's first message (2026-10-09).
 *
 * A lane started with `--brief` is told to take it through the lane-worker skill,
 * so the first message's first word is the harness's own trigger: `/lane-worker`
 * on Claude and OpenCode, `/skill:lane-worker` on Pi. The dry run prints exactly
 * what would run, so these tests read the first message per harness and nothing
 * is created.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeBrief } from "./lane-brief-fixture.ts";
import { harnessRoot } from "../../core/harness-paths.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);
const RECIPE = join(HARNESS_ROOT, "muster", "scripts", "pi-lane-launch.sh");
const HOUR = 3_600_000;

const POOL = {
	version: 1,
	virtualProvider: "pool",
	cooldownMs: HOUR,
	resetHorizonMs: 24 * HOUR,
	roles: { worker: ["alpha/a"] },
	laneDefaults: { pi: { candidates: ["cc/ds-flash"], fallbackRole: "worker" }, opencode: ["opencode/one-free"], claude: "sonnet" },
	quotaShapes: [{ id: "wall", match: "QUOTA_WALL" }],
};

type Lab = { dir: string; env: NodeJS.ProcessEnv; agentDir: string; brief: string };

/** A private tmux server, a fixture agent dir and fake harness binaries. */
function withLab(run: (lab: Lab) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "lane-first-message-"));
	const agentDir = join(dir, "agent");
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "provider-pool.json"), `${JSON.stringify(POOL, null, "\t")}\n`);
	const fixture = makeBrief();
	const brief = fixture.path;
	const fakePi = join(dir, "fake-pi.sh");
	writeFileSync(fakePi, "#!/bin/sh\nexec sleep 30\n");
	chmodSync(fakePi, 0o755);
	const fakeClaude = join(dir, "claude");
	writeFileSync(fakeClaude, '#!/bin/sh\nif [ "$1" = "agents" ]; then echo "[]"; exit 0; fi\necho deadbeef\n');
	chmodSync(fakeClaude, 0o755);
	// The OpenCode recipe asks `opencode` for its data dir before it can name the
	// lane's database, so the fake answers `debug paths` and `db path`.
	const fakeOpencode = join(dir, "opencode");
	writeFileSync(
		fakeOpencode,
		["#!/bin/sh", `if [ "$1" = "debug" ] && [ "$2" = "paths" ]; then echo "data ${dir}/oc-data"; exit 0; fi`, `if [ "$1" = "db" ] && [ "$2" = "path" ]; then echo "${dir}/oc-data/opencode.db"; exit 0; fi`, "exec sleep 30", ""].join("\n"),
	);
	chmodSync(fakeOpencode, 0o755);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		TMUX_TMPDIR: dir,
		PI_BIN: fakePi,
		PI_LANES_TMUX_SESSION: "fm-test",
		PI_LANES_JSON: join(dir, "pi-lanes.json"),
		PATH: `${dir}:${process.env.PATH}`,
	};
	delete env["TMUX"];
	try {
		run({ dir, env, agentDir, brief });
	} finally {
		spawnSync("tmux", ["kill-server"], { env, stdio: "ignore" });
		fixture.remove();
		rmSync(dir, { recursive: true, force: true });
	}
}

function dry(lab: Lab, args: string[]): { status: number | null; output: string } {
	const result = spawnSync(RECIPE, ["--lane", "fm-lane", "--cwd", lab.dir, "--agent-dir", lab.agentDir, "--dry-run", ...args], { encoding: "utf8", timeout: 60_000, env: lab.env });
	return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** `describe` prints each argv through `printf %q`, so spaces arrive as `\ `. Flatten for assertions. */
function flat(output: string): string {
	return output.replaceAll("\\ ", " ").replaceAll("\\`", "`");
}

function briefPattern(brief: string): string {
	return brief.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("pi: the first message starts with /skill:lane-worker and points at the brief", () => {
	withLab((lab) => {
		const result = dry(lab, ["--harness", "pi", "--brief", lab.brief]);
		assert.equal(result.status, 0, result.output);
		const output = flat(result.output);
		assert.match(output, new RegExp(`/skill:lane-worker Read ${briefPattern(lab.brief)} and do it\\.`), result.output);
		// The rest of the text is unchanged: the same report instruction every lane gets.
		assert.match(output, /muster report review_ready --summary/);
		assert.match(output, /muster report blocked/);
	});
});

test("claude: the first message starts with /lane-worker and points at the brief", () => {
	withLab((lab) => {
		const result = dry(lab, ["--harness", "claude", "--brief", lab.brief]);
		assert.equal(result.status, 0, result.output);
		assert.match(result.output, new RegExp(`/lane-worker Read ${briefPattern(lab.brief)} and do it\\.`), result.output);
		assert.doesNotMatch(result.output, /skill:lane-worker/, "a Claude lane uses the Claude trigger");
	});
});

test("opencode: the first message starts with /lane-worker and is passed to the host", () => {
	withLab((lab) => {
		const result = dry(lab, ["--harness", "opencode", "--brief", lab.brief]);
		assert.equal(result.status, 0, result.output);
		const output = flat(result.output);
		const expected = new RegExp(`--first-message /lane-worker Read ${briefPattern(lab.brief)} and do it\\.`);
		assert.match(output, expected, result.output);
	});
});

test("without --brief no lane gets a first message, whatever the harness", () => {
	withLab((lab) => {
		const pi = dry(lab, ["--harness", "pi"]);
		assert.equal(pi.status, 0, pi.output);
		assert.doesNotMatch(flat(pi.output), /lane-worker/, pi.output);
		const claude = dry(lab, ["--harness", "claude"]);
		assert.equal(claude.status, 2, claude.output);
		assert.match(claude.output, /--brief <file> is required for --harness claude/);
	});
});

test("pi: a resumed session is not briefed again", () => {
	withLab((lab) => {
		const result = dry(lab, ["--harness", "pi", "--brief", lab.brief, "--session", "11111111-1111-4111-8111-111111111111"]);
		assert.equal(result.status, 0, result.output);
		assert.doesNotMatch(flat(result.output), /lane-worker/, result.output);
	});
});
