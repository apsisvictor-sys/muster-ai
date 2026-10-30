# studio-gateway full tool test, 2026-10-10

Tester: Henry (Grok Bot), through the `user-studio-gateway` connector.
- Read tests: 20:08 to 20:30 Sofia.
- Write tests: 22:02 to 22:20 Sofia, approved by the operator (relayed by Bob and the parent assistant).

Scope rules followed:
- Only lanes named `grokbot-test-*` were touched. Real lanes were read, never messaged or controlled.
- No client data, no secrets, no pushes, no merges.
- `outbox_read` was only called with `peek:true`.

Source references below come from the `~/.worktrees/grokbot-scope` copy of pi-agent (branch `lane/grokbot-scope@0983323`, merged into main). Live main may differ slightly.

## 0. Headline

| Area | Result |
|------|--------|
| Read tools (20) | 11 PASS (4 with minor notes), 9 BUGGY, 0 down. `git_log knowledge` is the only call that never works. |
| brief_write | PASS. Overwrite, bad name and secret content are all refused correctly. |
| lane_launch claude | PASS. Lane started, read the brief, replied. |
| lane_launch pi | FAIL. `launch failed: exit 1` on 3 models from 3 providers. The cause is the launcher, not quota (W1). |
| lane_launch opencode | FAIL. Model list never supplied to the gateway, so every OpenCode launch is refused (W2). |
| lane_send (claude) | PASS. Resumed the idle lane, and its reply arrived in the grokbot outbox. |
| lane_control (claude) | PASS. set-model and abort refused with the parity substitutes, and stop worked. |
| lane_control / lane_send (pi, opencode) | UNTESTED. No Pi or OpenCode lane could be launched. |
| send_to_orchestrator | See section 3. |
| Cleanup | All `grokbot-test-*` lanes are stopped or never existed. `lanes` shows none (section 2.5). |

## 1. Read-tool results (from the 20:08 run)

| Tool | Result | Exact error / note |
|------|--------|--------------------|
| lanes | PASS | 76 to 77 lanes, JSON and table both work. |
| lane_card | BUGGY | `no card for orchestrator`. Live lanes with no sessionId (orchestrator, salon-*, operator-*) have no card. Card state differs from `lanes` (oc-int: card idle, lanes gone; sn-chrome: card running, lanes waiting). The same error is given for an unknown lane. |
| lane_report_read | PASS | `no report for <lane>`, the same for a live lane and an unknown one. |
| outbox_read | PASS | `peek:true` works. |
| state_note_read | PASS | Traversal gives `path is outside the folder`. |
| wiki_search | BUGGY | The stemmer reduces "muster" to "must" and "harness" to "har" (false hits). Cap: `limit must be an integer from 1 to 50`. Hints name `expectedRevision`, which is not in the schema. No 502 in 6 calls. |
| wiki_read | PASS (minor) | `expectedRevision` is accepted but not in the schema. findText plus limit is rejected with a clear message. |
| recall | BUGGY (minor) | `cursor conflicts with offset/limit`, although the hint says to repeat the same limit. |
| recall_expand | PASS | |
| plans_read | PASS | |
| git_log | BUGGY | `knowledge` always gives `git log failed` (the repo is most likely `~/knowledge/wiki`). A bad ref also gives the bare `git log failed`. |
| history_search | PASS | Cap 20. At 20:30 the index looked about 6.5 h stale. At 22:15 it had caught up (newest turn 17:59 UTC, 20:59 Sofia), so this is batch lag, not a fault. |
| history_read | BUGGY | Claude and Hermes turns give `fail history_read no_byte_range \| … (Claude/Hermes readers normalise the whole file)`, yet history_search prints history_read locators for them. Pi turns work. |
| project_list | PASS (minor) | The `projects` listing is cut at `[+15 more]` with no paging. The client-data folder is refused. |
| project_read | PASS | Secret-file denylist by name, traversal refused. |
| memory_read | BUGGY | The root list shows `claude-memory available`, but every call gives `.claude is never readable`. recall_expand returns claude-global memory bodies anyway. |
| reports_read | PASS (note) | Redaction does not mask IPs or local paths. |
| instructions_read | PASS | claude-md and agents-md are readable. |
| skills_list | BUGGY (minor) | The `claude` root is listed but refused. |
| skills_read | BUGGY (minor) | With no root it defaults to the refused claude root. |

## 2. Write and lane tests

### 2.1 brief_write: PASS
- New file `grokbot-test-henry-2026-10-10.md`: `wrote /home/operator/.pi/agent/plans/orchestration-2026-10-05/handoffs/msgs/grokbot-test-henry-2026-10-10.md`.
- Existing name `grokbot-lane-test-2026-10-10.md`: `would overwrite …/grokbot-lane-test-2026-10-10.md` (refused, correct).
- Name `../grokbot-test-traversal-probe.md`: `name must match /^[a-z0-9-]+\.md$/` (refused, correct).
- Fake Anthropic-key-shaped string: `content would be redacted: a secret-shaped value (token, key, password, …) is present; do not write secrets into a brief` (refused, correct).
- Minor: the refusal text "would overwrite <path>" reads like a dry run. "refused: <path> already exists" would be clearer.

### 2.2 lane_launch pi: FAIL (launcher bug, not quota)

Every attempt used lane `grokbot-test-pi`, cwd `/home/operator/.worktrees/grokbot-scope` and brief `grokbot-test-henry-2026-10-10.md`.

| Model | Result |
|-------|--------|
| `command-code/deepseek/deepseek-v4.1-flash` (first laneDefaults.pi candidate) | `launch failed: exit 1` |
| `opencode-go/deepseek-v4.1-flash` (second candidate) | `launch failed: exit 1` |
| `command-code/inclusionai/ling-3.1-flash:free` (free ref) | `launch failed: exit 1` |
| `""` (empty, hoping for the default) | `model  is not in the pi catalog` |
| `grokbot/not-a-model` | `model grokbot/not-a-model is not in the pi catalog` |
| Bob, earlier: `deepseek/deepseek-flash` | `launch failed: exit 1` |

Afterwards:
- `lane_card grokbot-test-pi` gives `no card for grokbot-test-pi`.
- `lane_send grokbot-test-pi` gives `… Agent grokbot-test-pi is not registered in this workspace … no tmux window pi:grokbot-test-pi`.

So the tmux window was created and gone within the 5-second verify window.

Diagnosis from the source:
- The gateway's `launchLane` (`extensions/muster/cli/gateway.ts`) returns the last stderr line, or `exit <code>` when stderr is empty. Stdout, which carries all the `pi-lane-launch:` progress lines, is thrown away.
- `scripts/pi-lane-launch.sh` runs with `set -euo pipefail`. In `verify()`:
  `pane="$(tmux list-panes -t "$TMUX_SESSION:$LANE" … 2>/dev/null | head -1)"`
  When the window is already gone, `tmux list-panes` fails. With pipefail that assignment returns 1, and `set -e` exits the script with code 1 and empty stderr. The intended message `window … is gone after launch` is never printed. That explains the bare `exit 1`.
- The real underlying fault is that the Pi process exits within 5 seconds of starting in a window created by the gateway service. The same result with three models on three providers, before any prompt is sent, means it is not a quota or provider wall. Pi makes no model call at startup without a prompt. Likely causes to check:
  - The `muster-gateway.service` environment: PATH, TERM, the agent-keys env file, or the `run-custom.sh` rebuild stamp.
  - A tmux server or socket mismatch under systemd.
  - Pi refusing `--session-id <new uuid>` together with `--name`.
- Separate bug: for `--harness pi` and `opencode`, the script accepts `--brief` but never uses it. Only the claude branch passes the brief. A Pi or OpenCode lane launched through the gateway would start with no task.
- Side effect: `register_lane` writes `grokbot-test-pi` into `~/.pi/agent/state/pi-lanes.json` before the window starts. A stale registry row probably remains. It does not show in `lanes`. Please remove it.

Pi quota: not measurable through the gateway, because no Pi lane started. Quota is not the cause of the launch failure.

### 2.3 lane_launch opencode: FAIL (wiring bug)
- `grokbot-test-oc` on `opencode/muse-spark-1.3-contributor-free` (first laneDefaults.opencode entry) gave:
  `cannot validate model for harness opencode: the OpenCode model list could not be read (\`opencode models\` gave no output); a model is never guessed`
- Cause: `ActionToolDeps.opencodeModelsOutput` (and `piSettingsModels`) are declared in `gateway/tools.ts` and read by `catalogDeps()`. The `serve` case in `cli/gateway.ts` never sets them in the `actions` object, so the OpenCode catalog is always empty. This has nothing to do with whether `opencode models` works on the machine.

### 2.4 lane_launch claude: PASS

| Step | Call | Result |
|------|------|--------|
| launch | `grokbot-test-claude`, model `sonnet` | `launched grokbot-test-claude: pi-lane-launch: started Claude lane grokbot-test-claude (id 568240b1, model sonnet, cwd /home/operator/.worktrees/grokbot-scope)` |
| card after 45 s | lane_card | state `idle`, model `claude-sonnet-5-5`, lastMessage `READY claude-sonnet-5-5`, lastReport `review_ready` "grokbot-test READY". The lane said Concord refused the lane-level record because `finish_work` lacked `task_id` and `expected_version`. Its report went to the orchestrator inbox. |
| report | lane_report_read | `review_ready` / `REVIEW READY: lane/grokbot-scope@0983323… — grokbot-test READY` |
| send | lane_send "reply READY…" | `delivered to grokbot-test-claude: resumed the idle lane: claude stop 568240b1, then claude --bg --resume (now a43ec666)` |
| reply | card after 45 s plus outbox_read peek | The lane ran `muster send grokbot` and the outbox held `{from: grokbot-test-claude, at: 2026-10-10T19:06:07Z (22:06 Sofia), text: "grokbot-test-claude READY claude-sonnet-5-5"}`. The round trip works. |
| set-model haiku | lane_control | Refused: `no verified remote model switch for a live Claude lane … Substitute: stop the lane and relaunch it on the new model: claude --bg --resume <sessionId> --model <id> --name <lane>` |
| abort | lane_control | Refused: `Claude Code exposes no remote interrupt for a running background session … Substitute: send the lane a message (muster send <lane> …)` |
| stop | lane_control | `claude stop dispatched for grokbot-test-claude: a43ec666` |

Observations:
- C1. After the resume, the card's `model` became `null` and `lastReport` was dropped, so `lane_report_read` then said `no report`. A resume should keep the model and the last report.
- C2. The brief said "send no report" and "run no commands". The lane still ran `muster report review_ready` at launch, because the Claude lane prompt requires it. That review_ready went to the orchestrator's inbox. Please ignore it (it is a test lane).
- C3. The lane's reply went to the grokbot inbox, which `outbox_read` returns. Lane replies and orchestrator messages share one outbox. That works, but nothing separates them except the `from` field.

### 2.5 Cleanup evidence
- `lane_card grokbot-test-claude` after the stop: `no card for grokbot-test-claude`.
- `lanes` JSON at about 22:15 Sofia: 77 rows and zero rows containing `grokbot-test`. Live rows are orchestrator, salon-ecommerce-store-setup, sn-chrome, sn-wp10, sn-wp9, sn-wp2, operator-bb, operator-bf, operator-0a, operator-21 and sn-s3, all the operator's or the orchestrator's.
- `grokbot-test-pi`: no tmux window and no card. A probable stale row in `pi-lanes.json`.
- `grokbot-test-oc`: refused before launch, so nothing was created.

### 2.6 Untested
- lane_control abort, stop and set-model on Pi and OpenCode lanes. lane_send to a live Pi or OpenCode lane. Pi and OpenCode quota behaviour. All blocked by W1 and W2.
- lane_control on a real lane. Not allowed by the test rules.

## 3. send_to_orchestrator and outbox_read
- outbox_read peek before the tests: `[]`.
- outbox_read peek mid-test: one message from `grokbot-test-claude` (above).
- I tried twice to save this full report to handoffs/msgs with brief_write, as `grokbot-gateway-test-report-2026-10-10.md`. Both attempts were refused with `content would be redacted: a secret-shaped value (token, key, password, …) is present`, even after removing key-like phrases. The report contains no secrets, and the refusal does not say which part matched. This is listed as fix P12.
- send_to_orchestrator: a concise version (3.4 KB, with fix list P1 to P12) was sent once at about 22:20 Sofia. Result: `delivered to orchestrator's inbox`.
- outbox_read peek after the send: still only the one test-lane message. No orchestrator reply yet.

## 4. Log, inbox and outbox review
- The audit log (`~/.pi/state/grokbot-gateway/audit.jsonl`), send log and muster inboxes are not exposed by any read tool. I could not confirm the intent and result audit lines for these calls. This is a gap for remote debugging.
- Lane state notes: still 12 notes, none for the test lanes (expected).
- history_search: the test lanes' turns are not indexed yet (index newest turn 20:59 Sofia).
- A 2026-10-09 orchestrator turn says the BE client hard-delete defect was already fixed on dev (lane sn-f2 added a test proving the row stays after a delete).

## 5. Prioritized fix list for Claude Code

P1. **OpenCode catalog never wired (W2).**
- File: `extensions/muster/cli/gateway.ts`, the `serve` case, the `actions: ActionToolDeps` object.
- Fix: run `opencode models` once at startup with `execCaptured(OPENCODE_BIN, ["models"], 20000)` (or lazily with a TTL cache) and set `opencodeModelsOutput`. Read Pi's enabled models from settings.json into `piSettingsModels`.
- Expected: `lane_launch harness=opencode model=opencode/muse-spark-1.3-contributor-free` passes validation.
- Verify: a unit test in the gateway tools tests with a stubbed `opencodeModelsOutput`, plus a live `lane_launch` of a `grokbot-test-oc` lane.

P2. **Pi launch from the gateway dies, and the error is swallowed (W1).**
- (a) In `scripts/pi-lane-launch.sh` `verify()`, guard the list-panes assignment, for example `pane="$(tmux list-panes … 2>/dev/null | head -1 || true)"`, so the "window gone" message prints. Set `remain-on-exit on` on the new window and, on failure, print the dead pane's last 20 lines (`tmux capture-pane -p -t …`) to stderr.
- (b) In `cli/gateway.ts` `launchLane`, return the last 5 to 10 lines of stdout and stderr, redacted, not only the last stderr line.
- (c) Then reproduce from the service's environment, for example `systemd-run --user --pty --property=EnvironmentFile=… scripts/pi-lane-launch.sh --lane grokbot-test-pi --harness pi --cwd ~/.worktrees/grokbot-scope --model command-code/deepseek/deepseek-v4.1-flash --brief <brief> --no-attach`, and fix the root cause (PATH, TERM, keys env, run-custom.sh rebuild, or tmux socket).
- (d) Run `register_lane` only after `verify` succeeds, or retire the row on failure.
- Verify: a gateway `lane_launch` of `grokbot-test-pi` returns `launched …`, the card shows up, and lane_send gets a reply.

P3. **The brief is ignored for Pi and OpenCode lanes.**
- In `pi-lane-launch.sh`, when `--brief` is given for pi or opencode, deliver "Read <brief> and do it…" as the first prompt: the Pi CLI's initial-message argument, or a `muster send` after the card appears.
- Verify: a Pi test lane's first turn quotes the brief.

P4. **lane_card and lanes disagree (read F1).**
- `lane_card` should fall back to the `enumerateLanes()` row when there is no card file, overlay the live state, and give distinct errors (`unknown lane` versus `live, not enrolled`). The same applies to `lane_report_read` and `lane_control` ("no card … not enrolled").

P5. **The Claude resume drops card fields (C1).**
- In the resume path in `send.ts` and `claude-lane-card.ts`, carry `model` and `lastReport` over to the new session's card.

P6. **git_log knowledge.**
- In `knowledge.ts` `defaultGitRepos`, map `knowledge` to `~/knowledge/wiki`, and return git's stderr, redacted.

P7. **history_read for Claude and Hermes turns.**
- Fall back to the indexed turn text, or stop printing locators for turns without byte ranges.

P8. **The .claude roots are advertised but refused.**
- Mark them refused in the root lists and default `skills_read` to `pi`, or allowlist read-only memory and skill markdown with redaction. Align with `recall_expand` and `claude-md`, which already serve .claude content.

P9. **Search and paging polish.**
- Use a Porter or Snowball stemmer, or a minimum stem length, in wiki_search.
- Add `expectedRevision` and the limit min/max to the schemas.
- Fix the recall cursor hint (cursor alone).
- Add paging to project_list.

P10. **Observability.**
- Add a read-only `audit_read` (last N gateway audit lines) and a `send_log_read`, so Grok Bot can confirm its own calls.

P12. **The brief_write redaction has false positives and gives no detail.**
- It refused a plain Markdown report twice. Return the rule id and a masked excerpt, and review the generic long-token rule against hyphenated file names and ids.

P11. **Concord lane-level report.**
- `finish_work` without `task_id` and `expected_version` is refused, so lane-level reports from Claude lanes reach the card and inbox but not Concord. This is the open acceptance item 3 in the harness-bus page.
