import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { harnessRoot } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);

/**
 * The learning digest's send and delivery check (S6 of VR24-209, report O7).
 *
 * `learning-digest.service` failed every Sunday since 2026-10-25 20:00 with `muster send: no agent
 * identity`: a unit runs no agent session, and `--agent` is a global flag before the subcommand, so the
 * send could not name one. The digest file was written and the message never reached the architect.
 *
 * The first fix sent under the job's own identity and then read the message back from
 * `muster inbox list architect`. The live run on 2026-10-27 00:39 showed that read-back is wrong: the
 * ledger backend prints `{transport: "inbox", messageId, ledger: true}` with no `inboxPath`, and the
 * architect's `muster wait --inbox` marks a message read within seconds, while `inbox list` lists only
 * pending messages. A delivered message was therefore reported as missing.
 *
 * These tests drive the real script against a fixture tree and a fixture `muster` that refuses a send
 * with no identity exactly as the CLI does (packages/muster/cli/send.ts:69-73) and prints the outcome the
 * test chooses. Nothing here touches the real muster state, the real plans tree or the real inbox.
 */

const SCRIPTS = join(piAgentDir(), "scripts");

/** The outcome the live ledger-mode send printed (orchestrator's run, 2026-10-27 00:39). */
const LEDGER_OUTCOME = JSON.stringify({
	transport: "inbox",
	messageId: "1792726541863-8b6d6b4a-4c2e-4a12-9d47-6c1a2b0f5e31",
	fallbackReason: "architect has no prompt endpoint; it reads its inbox with `muster wait --inbox architect`",
	ledger: true,
	laneId: "architect",
	mode: "followup",
});

/** A fixture muster: the global `--agent` before the subcommand, as packages/muster/cli-main.ts reads it. */
const FAKE_MUSTER = `#!/usr/bin/env bash
set -u
state="\${FAKE_MUSTER_STATE:?}"
agent=""
if [ "\${1:-}" = "--agent" ]; then agent="\${2:-}"; shift 2; fi
cmd="\${1:-}"
shift || true
case "$cmd" in
  asks)
    printf '{"asks": []}\\n'
    exit 0 ;;
  send)
    if [ -z "$agent" ]; then
      echo "muster send: no agent identity: pass --agent <id>, or run from an enrolled session with CONCORD_AGENT_ID" >&2
      exit 2
    fi
    printf '%s %s\\n' "$agent" "$*" >> "$state/sends"
    if [ -n "\${FAKE_MUSTER_OUTCOME:-}" ]; then
      printf '%s\\n' "$FAKE_MUSTER_OUTCOME"
    else
      printf '{"transport":"inbox","messageId":"%s","inboxPath":"%s"}\\n' "\${FAKE_MUSTER_MSG_ID:-}" "\${FAKE_MUSTER_INBOX_PATH:-}"
    fi
    exit 0 ;;
  inbox)
    cat "$state/inbox.json"
    exit 0 ;;
  *)
    echo "fixture muster: unhandled command $cmd" >&2
    exit 3 ;;
esac
`;

type Fixture = { dir: string; repo: string; state: string; script: string };

function fixture(options: { inbox?: unknown[]; outcome?: string } = {}): Fixture {
	const dir = mkdtempSync(join(tmpdir(), "learning-digest-"));
	const repo = join(dir, "repo");
	const state = join(dir, "state");
	const bin = join(dir, "bin");
	for (const path of [join(repo, "scripts"), join(repo, "plans"), join(dir, "home"), state, bin]) mkdirSync(path, { recursive: true });
	const script = join(repo, "scripts", "learning-digest.py");
	copyFileSync(join(SCRIPTS, "learning-digest.py"), script);
	writeFileSync(join(bin, "muster"), FAKE_MUSTER, { mode: 0o755 });
	writeFileSync(join(state, "inbox.json"), JSON.stringify(options.inbox ?? []));
	const today = new Date().toISOString().slice(0, 10);
	writeFileSync(
		join(repo, "plans", "lane-outcomes.tsv"),
		"date\tlane\tproject\tclass\tmodel\trounds_sent_back\toutcome\tsend_back_causes\tlaunched_at\tclosed_at\n" +
			`${today}\ts6timers\tpi\tflash\tpool/session\t0\tmerged\tnone\t${today}T10:00:00+02:00\t${today}T12:00:00+02:00\n`,
	);
	writeFileSync(join(repo, "plans", "quality-escapes.md"), "| Date | Product | What slipped | Cause |\n|---|---|---|---|\n");
	mkdirSync(join(repo, "plans", `orchestration-${today.slice(0, 7)}`), { recursive: true });
	writeFileSync(join(repo, "plans", `orchestration-${today.slice(0, 7)}`, `operator-rulings-${today}.md`), "| VR24-209 | S6 | row |\n");
	void options.outcome;
	return { dir, repo, state, script };
}

function runDigest(f: Fixture, options: { msgId?: string; inboxPath?: string; outcome?: string } = {}) {
	const out = join(f.dir, "digest.md");
	const messageId = options.msgId ?? "";
	const inboxPath = options.inboxPath ?? join(f.dir, "inbox", "architect", `${messageId}.json`);
	const run = spawnSync("python3", ["-I", f.script, "--out", out, "--no-compaction"], {
		encoding: "utf8",
		env: {
			PATH: `${join(f.dir, "bin")}:${process.env.PATH ?? ""}`,
			HOME: join(f.dir, "home"),
			FAKE_MUSTER_STATE: f.state,
			FAKE_MUSTER_MSG_ID: messageId,
			FAKE_MUSTER_INBOX_PATH: inboxPath,
			FAKE_MUSTER_OUTCOME: options.outcome ?? "",
		},
	});
	return { ...run, out, inboxPath, sends: existsSync(join(f.state, "sends")) ? readFileSync(join(f.state, "sends"), "utf8") : "" };
}

test("the send names the job's own identity, which is the only one a unit can pass", () => {
	const f = fixture({ inbox: [{ id: "msg-1" }] });
	const result = runDigest(f, { msgId: "msg-1" });
	assert.equal(result.status, 0, result.stderr);
	assert.ok(existsSync(result.out), "the digest file is written before the send");
	assert.match(result.sends, /^learning-digest /, "the send carries --agent learning-digest, not a bare send");
	assert.match(result.sends, /architect LEARNING DIGEST /, "the architect is still the recipient");
});

// The live shape: ledger mode prints no inboxPath, and the architect had already read the message, so
// the pending list is empty. Absence from that list is not evidence of a lost message.
test("a ledger-mode send the architect already read is delivered, not missing", () => {
	const f = fixture({ inbox: [], outcome: LEDGER_OUTCOME });
	const result = runDigest(f, { outcome: LEDGER_OUTCOME });
	assert.equal(result.status, 0, `a delivered ledger-mode message must not fail the run: ${result.stderr}`);
	assert.equal(result.stderr, "");
});

test("a file-mode message the inbox moved into its read dir is delivered", () => {
	const f = fixture({ inbox: [] });
	const path = join(f.dir, "inbox", "architect", "read", "1792701820910-msg-3.json");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "{}\n");
	const result = runDigest(f, { msgId: "msg-3", inboxPath: join(f.dir, "inbox", "architect", "1792701820910-msg-3.json") });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
});

test("a file the send named is in neither the inbox dir nor its read dir", () => {
	const f = fixture({ inbox: [] });
	const result = runDigest(f, { msgId: "msg-2" });
	assert.equal(result.status, 1, "a send naming a file that is nowhere is a failed run");
	assert.equal(result.stderr.trimEnd().split("\n").length, 1, `one line, not a traceback: ${result.stderr}`);
	assert.match(result.stderr, /^delivery check failed: the architect inbox holds no file for message msg-2 sent by learning-digest/);
	assert.match(result.stderr, /checked .* and its read dir; 0 pending message\(s\)/, "the line says what was checked");
});

test("a send that prints no message id fails the run", () => {
	const f = fixture({ inbox: [] });
	const result = runDigest(f, { outcome: JSON.stringify({ transport: "inbox", laneId: "architect", mode: "followup" }) });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /^delivery check failed: muster send reported no message id or inbox path \(transport=inbox\)/);
});

test("the digest file still lands", () => {
	const f = fixture({ inbox: [{ id: "msg-4" }] });
	const result = runDigest(f, { msgId: "msg-4" });
	assert.equal(result.status, 0, result.stderr);
	assert.match(readFileSync(result.out, "utf8"), /^# /, "the digest starts with its own heading");
});
