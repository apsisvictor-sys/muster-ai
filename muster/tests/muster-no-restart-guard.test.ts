import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { harnessRoot } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);

/**
 * No harness, tool or MCP stops or restarts a Claude session to deliver a message (LD16).
 * The send paths may not reach the functions that stop or resume one, nor pass `--resume`
 * to the Claude CLI. `resumeClaudeLane` (packages/muster/lib/claude-lane-card.ts) is the one resume owner and the
 * deliberate restart (`muster resume`, WP-B): outside tests, `packages/muster/cli/resume.ts` is its only caller.
 */

const EXTENSIONS = join(piAgentDir(), "extensions");
const AGENT_DIR = join(EXTENSIONS, "..");
/** The Muster package (RS2c moved the senders, the gateway and `muster resume` out of extensions/muster). */
const MUSTER = join(AGENT_DIR, "packages", "muster");

function source(root: string, relative: string): string {
	return readFileSync(join(root, relative), "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "")
		.replace(/\s\/\/ .*$/gm, "");
}

const musterSource = (relative: string): string => source(MUSTER, relative);

/** The text of one top-level `export function <name>` up to its closing brace at column 0. */
function topLevelFunction(text: string, name: string): string {
	const start = text.indexOf(`export function ${name}`);
	assert.notEqual(start, -1, `${name} not found`);
	const end = text.indexOf("\n}\n", start);
	return text.slice(start, end === -1 ? undefined : end + 2);
}

const RESUMERS = ["resumeClaudeLane", "resumeParkedClaudeLane", "claudeIdleResume"];
const STOPPER = "stopClaudeLane";
const CLAUDE_FLAGS = [/["'`]--resume["'`]/, /["'`]--bg["'`]/];

function assertClean(label: string, text: string, forbidden: readonly string[]): void {
	for (const name of forbidden) assert.equal(new RegExp(`\\b${name}\\b`).test(text), false, `${label} reaches ${name}: a send must not stop or resume a Claude session`);
	for (const flag of CLAUDE_FLAGS) assert.equal(flag.test(text), false, `${label} passes ${flag} to the Claude CLI`);
}

test("the send paths reach no function that stops or resumes a Claude session, and pass no --resume to the CLI", () => {
	// Every stop goes through closeLane (WP-C), so neither gateway file may reach the Claude stop bridge either.
	for (const file of ["send.ts", "send-deps.ts", "cli/send.ts", "cli/gateway.ts", "gateway/tools.ts"]) assertClean(file, musterSource(file), [...RESUMERS, STOPPER]);
	assertClean("parkedLaneResume", topLevelFunction(musterSource("lane-lifecycle-ports.ts"), "parkedLaneResume"), [...RESUMERS, STOPPER]);
});

test("one wiring owner: both senders build their deliverLaneMessage deps through send-deps.ts, with no private copy", () => {
	const send = musterSource("cli/send.ts");
	const gateway = musterSource("cli/gateway.ts");
	assert.match(send, /laneSendDeps\(/);
	assert.match(gateway, /gatewayLaneSend\(/);
	for (const [label, text] of [["cli/send.ts", send], ["cli/gateway.ts", gateway]] as const) {
		for (const privateWiring of ["endpointless:", "resumeParked:", "inboxState:", "recipientEnrolled:", "writeInboxMessage"]) assert.equal(text.includes(privateWiring), false, `${label} wires ${privateWiring} itself instead of using send-deps.ts`);
	}
});

/** Every non-test source that could call the resume owner: extensions and packages (not tests, not node_modules) and scripts. */
function sourcesOutsideTests(): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === "node_modules" || entry.name === "tests" || entry.name.startsWith(".")) continue;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (/\.(ts|mts|mjs|sh)$/.test(entry.name) && !entry.name.endsWith(".bundle.mjs")) found.push(path);
		}
	};
	walk(EXTENSIONS);
	walk(join(AGENT_DIR, "packages"));
	walk(join(AGENT_DIR, "scripts"));
	return found;
}

test("`muster resume` is the one caller of resumeClaudeLane outside tests, and it is no gateway tool", () => {
	const callers = sourcesOutsideTests().filter((file) => /\bresumeClaudeLane\b/.test(readFileSync(file, "utf8")));
	assert.deepEqual(callers.map((file) => file.slice(AGENT_DIR.length + 1)).sort(), ["packages/muster/cli/resume.ts", "packages/muster/lib/claude-lane-card.ts"]);
	assert.equal(/\bresume\b/.test(musterSource("gateway/tools.ts")), false, "gateway/tools.ts names no resume verb");
});
