#!/usr/bin/env bash
# pi-lane-launch.sh — start (or respawn) one lane as an enrolled bus lane.
#
# One command per lane: a tmux window `<tmux-session>:<lane>` running the Pi
# build (`--harness pi`) or the OpenCode lane host (`--harness opencode`) with
# CONCORD_AGENT_ID=<lane> and CONCORD_REPO_ROOT=<repo root>, the model and the
# cwd in arg, resuming that lane's session. The same script is the moving tool
# for the lanes that already run: `--respawn` replaces the process in the
# existing window, and the resumed session keeps the conversation.
#
# It only creates or replaces a process it was asked to replace:
#   - no window        -> one is created
#   - window exists    -> refuse, unless --respawn names the intent
#   - --dry-run        -> print exactly what would run, touch nothing
#
# After launching it verifies what it can see: the pane's command line, the
# process environment, and the lane card (once the A2 extension is merged).
# It never kills anything else and never edits a card.
#
# A direct launch from an agent session needs the orchestrator seat: the script asks
# `muster launch-check` (seats blueprint, Privileges 3). A resume, --unregister and
# --dry-run skip the question.
#
# Harnesses (`--harness`):
#   pi        a Pi session window (default). The session id is a Pi uuid.
#   opencode  the OpenCode lane host (`harness/muster/opencode-host.mjs`),
#             which owns its `opencode serve` process, the card heartbeats, the
#             Concord watch and the delivery ledger. The session id is an
#             `ses_...` id: when the lane has none yet the host creates one and
#             this script registers it here for the next respawn.
#   claude    a Claude Code background session (`claude --bg --name <lane>`) in
#             the lane's cwd, started with the lane-worker trigger and the brief:
#             "/lane-worker Read <brief> and do it. Commit locally; do not push."
#             It is not a
#             tmux window and writes nothing to the lane store: it enrols on its
#             first `muster report`. Refused when a live `claude agents` row
#             already has that name. With no --model the lane's default comes from
#             `laneDefaults.claude` in provider-pool.json (resolve_lane_model below).
#
# A lane's Concord workspace is `--repo-root` (passed through as
# CONCORD_REPO_ROOT): point several lanes at one root to put them on one bus.
#
# --- usage ---
# Usage:
#   pi-lane-launch.sh --lane <lane> [--harness pi|opencode|claude] [--session <id>]
#                     [--cwd <dir>] [--repo-root <dir>] [--model <id>]
#                     (--model is optional: with none, the harness's own default is
#                     resolved and printed; an explicit --model is checked against the
#                     harness's own catalog first and refused when it is outside the pool)
#                     [--branch <name>] [--agent-dir <dir>] [--db <path>]
#                     [--task-kind <kind>] [--class <flash|H1..H5>]
#                     [--brief <file>] [--resume-brief] [--launched-by <who>] [--item <code>] [--chrome] [--conversation]
#                     [--respawn] [--no-attach] [--no-register]
#                     [--dry-run] [--verify-seconds N]
#       pi-lane-launch.sh --lane <lane> --unregister
#                     (remove the lane's row from the lane store; refused while the
#                     lane has a window)
#
# Defaults:
#   --harness     pi
#   --session     the lane store ~/.pi/agent/state/pi-lanes.json, else a fresh
#                 Pi uuid (OpenCode: no id in the store means the host creates
#                 one and the created id is registered here after launch;
#                 session ids are project-scoped, so resume happens in the
#                 lane's own cwd, which a respawn keeps automatically)
#   --model       optional for every harness (2026-10-09). With none, the model
#                 comes from the one owner of the per-harness defaults,
#                 provider-pool.json laneDefaults, read through
#                 extensions/lib/provider-pool.ts: pi is an ordered DeepSeek V4.1
#                 Flash list that falls through the pool's worker chain when every
#                 candidate is walled, opencode is the free-only shortlist, claude
#                 is the laneDefaults alias. A provider with a live wall is skipped
#                 and the choice and its reason are printed. An explicit --model is
#                 checked against the harness's own model catalog before the lane
#                 starts, and refused with the catalog's reason when it is a Pi model
#                 outside the pool (P5-D6, no override).
#                 For opencode this default is passed to the host, so it also
#                 replaces a model an adopted session was running: naming no model
#                 means the harness default (the operator's ruling, 2026-10-09).
#   --cwd         the current directory
#   --repo-root   the lane's Concord workspace. Defaults to $PI_LANES_REPO_ROOT,
#                 else ~/.pi/agent for every harness: one shared workspace is how the
#                 bus works, so a lane and the orchestrator see each other (2026-10-08;
#                 an OpenCode lane used its cwd until 2026-10-09)
#   --repo-root-own
#                 give the lane its own cwd as its workspace instead (the default
#                 before the shared root, kept for a lab or an isolated lane)
#   --branch      opencode only: the cwd's current git branch, for the card
#   --db          opencode only: the lane's own OpenCode database, absolute (or
#                 `:memory:`). Default `<OpenCode data dir>/lanes/<lane>.db`,
#                 derived from the lane name. One database per lane is what keeps
#                 the lanes off SQLite's single writer: with no --db they would
#                 all open the agent-wide `opencode.db` and stall on
#                 `database is locked`. A lane with a session in the agent-wide
#                 database has that session copied into the lane's own (read
#                 only, the original stays) and the copy is counted against the
#                 source before the window starts.
#   environment   PI_LANES_TMUX_SESSION (pi / oc), PI_BIN (pi),
#                 PI_LANES_JSON (~/.pi/agent/state/pi-lanes.json, one store for
#                 every lane the recipe starts; A6's Pi loop watches it),
#                 PI_MUSTER_STATE_DIR (~/.pi/agent/state/muster) for the card check,
#                 PI_LANES_ATTACH_WAIT_SECONDS (60) for the OpenCode TUI pane,
#                 OPENCODE_BIN (opencode),
#                 PI_BIN (~/projects/pi-mono/run-custom.sh, the `pi` alias: it
#                 carries the WSL rebuild stamp, the DNS workarounds and
#                 PI_NO_REBUILD, so a bare `pi` from PATH is not it)
#   --agent-dir   the installation whose provider-pool.json (quota shapes) the
#                 OpenCode host reads; default is this script's installation
#   --no-attach   opencode only: leave the window as the host alone, without
#                 the `opencode attach` TUI pane
#   --brief       the brief file the lane's first message names. Required for
#                 --harness claude; optional for pi and opencode, where no
#                 message is sent when it is absent. The first message always
#                 starts with the harness's lane-worker trigger (/lane-worker on
#                 Claude and OpenCode, /skill:lane-worker on Pi), an existing
#                 file, resolved to an absolute path. A brief under /tmp is
#                 refused: briefs live in handoffs/msgs (standing rule
#                 2026-10-11), never copied silently. A Pi lane that resumes a
#                 session is not briefed again (the launcher says so), unless
#                 --resume-brief is given.
#   --resume-brief
#                 send the --brief message into a lane that RESUMES a session. Without it
#                 only a new session is briefed (a respawn must not repeat the original
#                 brief). `muster send` to a parked lane uses it with a resume brief.
#   --item        the work item the lane serves (spec OL2): the dispatcher states it, so an item
#                 left launch-uncertain is resolved from the lane record instead of a relaunch
#   --launched-by who started the lane, for its lane record: orchestrator (default), dispatcher,
#                 grokbot or a lane id. After a successful launch the script writes the
#                 lane's record (`muster lane-record launch`, lane-lifecycle.ts); a parked
#                 lane launched again comes back to `working`.
#   --chrome      claude only: start the session with Claude in Chrome (`claude --chrome`). A Claude
#                 lane started with it, or whose brief names `claude-in-chrome`, is a browser QA lane:
#                 its lane record says `browser`, and its turn does not end while a tab it opened is
#                 open (LD11). Register dev servers and browsers it starts with `muster lane-pid add <pid>`.
#   --conversation
#                 a design or product session in talk with the operator (LD14). Its lane record says
#                 `kind: conversation`: the tick never parks or closes it and the Stop hook never
#                 asks it for a report. The orchestrator closes it when the operator ends the topic.
#                 The inbox waiter nudge still applies.
#   --title       what the lane delivers, in plain words for the operator (D27): one line, 3 to 80
#                 characters, no codes, paths or branch names. A NEW worker lane needs one on every
#                 harness, checked before anything starts; a relaunch or respawn of a lane that
#                 already has a record keeps its title, and a --conversation session needs none.
#   --goal        <CODE>[:<station>] the goal the lane works on (D28). The station defaults to the
#                 goal's current one; an unknown or closed goal, an unknown station, or a goal with
#                 every station finished is refused before anything starts. The lane is attached
#                 only when the goal does not hold it yet. Refused with --launched-by grokbot.
#   --no-goal     the orchestrator states that this lane works on no goal today, instead of leaving
#                 the question open: an orchestrator launch names exactly one of --goal or --no-goal.
#   --model       claude only: when --model is absent, the `laneDefaults.claude`
#                 alias from provider-pool.json (one subscription, no fallback chain)
#
# A lane name has one live holder (LD15), whatever the harness: the launch is refused (exit 3,
# nothing started) when `claude agents --json` lists a session with that name or the lane tmux
# sessions (`pi`, `oc`, or PI_LANES_TMUX_SESSION) hold a window with it. A Pi or OpenCode
# --respawn of its own window is the one allowed reuse.
#
# Exit 3 covers every refusal that starts nothing: the live name, a missing or malformed --title, an
# orchestrator launch with neither --goal nor --no-goal, and a goal or station that does not exist.
# Exit 4 means the lane runs and its goal link was not written: the script prints the
# `muster goals attach` command to run, so a lost link is never silent.
#
# The OpenCode window is the host plus a TUI: pane 0 runs the lane host (it owns
# `opencode serve`, the card, the delivery ledger and the Concord watch) and the
# second pane, created once the host has published its server record, attaches
# the terminal to the same server and session, so the lane looks like a normal
# OpenCode window and the bus drives the same conversation. The host needs about
# 25 seconds to be ready (server, session, Concord registration), so give an
# OpenCode lane --verify-seconds 30. A --respawn rebuilds that window (the lane's
# state lives in Concord, the card, the ledger and the server record, not in the
# pane), which is also how a TUI pane is replaced cleanly.
# --- end usage ---
set -euo pipefail

LANE=""
SESSION=""
CWD_DIR=""
REPO_ROOT=""
REPO_ROOT_OWN=0
MODEL=""
# The account the model runs on (CCACCT2): filled by resolve_lane_model from the model helper's answer and printed with
# the model. The key itself comes from the name `models.json` gives the provider, not from a rewrite here.
LANE_ACCOUNT=""
LAUNCH_WARNING=""
TASK_KIND=""
LANE_CLASS=""
BRANCH=""
HARNESS="pi"
AGENT_DIR_OVERRIDE=""
DB_OVERRIDE=""
BRIEF=""
RESUME_BRIEF=0
LAUNCHED_BY="orchestrator"
# The work item the lane serves, when the dispatcher starts it: the record keeps it, so a crash is
# resolved from the record instead of a relaunch (spec OL2).
ITEM=""
CHROME=0
CONVERSATION=0
LANE_DB=""
ATTACH=1
RESPAWN=0
UNREGISTER=0
REGISTER=1
DRY_RUN=0
VERIFY_SECONDS=5
# D27/D28: the title the lane delivers and the goal it works on. NEW_LANE is 1 when this launch
# starts a lane with no live record, which is when the two flags are needed.
TITLE=""
GOAL=""
NO_GOAL=0
NEW_LANE=1
GOAL_CODE=""
GOAL_STATION=""
GOAL_ATTACHED=0
# 4 when the lane ran and the goal link was not written (CRL 4).
ATTACH_STATUS=0

TMUX_SESSION_OVERRIDE="${PI_LANES_TMUX_SESSION:-}"
# The lane build is the `pi` alias: run-custom.sh holds the WSL rebuild stamp,
# the DNS workarounds and PI_NO_REBUILD, so a bare `pi` from PATH is not it.
PI_BIN="${PI_BIN:-$HOME/projects/pi-mono/run-custom.sh}"
LANES_JSON_OVERRIDE="${PI_LANES_JSON:-}"
# The card directory is the owner's: <musterStateDir>/lanes, where the muster
# state dir is PI_MUSTER_STATE_DIR else <agent dir>/state/muster (the same one
# `muster lanes` and night-watch read). The agent dir is the one the lane will
# run with (PI_CODING_AGENT_DIR when it is set), so a staging lane's card is
# checked in the staging tree, not in the live agent dir.
LANE_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
MUSTER_STATE="${PI_MUSTER_STATE_DIR:-$LANE_AGENT_DIR/state/muster}"
ATTACH_WAIT_SECONDS="${PI_LANES_ATTACH_WAIT_SECONDS:-60}"
# Half-live enrollment is refused: the installation a lane loads and the state
# dir its card lands in must both be live or both be a lab. A staging agent dir
# with the live state dir (or the live agent dir with a lab state dir) writes
# the card into a tree whose extensions the lane never loaded, and silently
# enrols it in front of a watcher that reads the other one (seen live on a
# respawn whose session override was missing, 2026-10-08).
LIVE_AGENT_DIR="$HOME/.pi/agent"
LIVE_STATE_DIR="$HOME/.pi/agent/state/muster"
if [ -n "${PI_MUSTER_STATE_DIR:-}" ]; then
    agent_is_live=1; [ "$LANE_AGENT_DIR" = "$LIVE_AGENT_DIR" ] || agent_is_live=0
    state_is_live=1; [ "$PI_MUSTER_STATE_DIR" = "$LIVE_STATE_DIR" ] || state_is_live=0
    if [ "$agent_is_live" != "$state_is_live" ]; then
        if [ "$state_is_live" = 1 ]; then
            echo "pi-lane-launch: refusal: the live state dir $LIVE_STATE_DIR with the lab agent dir $LANE_AGENT_DIR" >&2
        else
            echo "pi-lane-launch: refusal: the lab state dir $PI_MUSTER_STATE_DIR with the live agent dir $LANE_AGENT_DIR" >&2
        fi
        echo "pi-lane-launch: keep PI_CODING_AGENT_DIR and PI_MUSTER_STATE_DIR in the same installation (or set neither)" >&2
        exit 3
    fi
fi
# The Pi profile this launcher acts on. The script moved into the harness tree
# (packages/muster/scripts, OL12-D8), so the profile root is three levels up; a
# released harness tree carries no profile of its own and falls back to the live
# one. Everything below still reads the profile it read before the move.
DEFAULT_AGENT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
[ -d "$DEFAULT_AGENT_ROOT/extensions/muster/launchers" ] || DEFAULT_AGENT_ROOT="$HOME/.pi/agent"
# A lane's agent dir and Muster state dir travel with it when they are set: the
# tmux server, not this shell, owns the environment of a new window.
# A lane never holds a seat. The caller may be the orchestrator or the architect, whose shell carries the seat
# credential, and a Claude daemon started by this launch would hand it to every later session (seat1, 2026-10-23:
# every `claude bg-spare` held the orchestrator seat). The names are `SEAT_ENV_NAMES` in muster/lib/seat-env.ts;
# extensions/tests/pi-lane-launch-seat-env.test.ts holds the two lists equal.
SEAT_SCRUB=(env -u MUSTER_SEAT -u MUSTER_SEAT_TOKEN -u MUSTER_SEAT_EPOCH)
ENV_ARGS=()
[ -n "${PI_CODING_AGENT_DIR:-}" ] && ENV_ARGS+=(-e "PI_CODING_AGENT_DIR=$PI_CODING_AGENT_DIR")
[ -n "${PI_MUSTER_STATE_DIR:-}" ] && ENV_ARGS+=(-e "PI_MUSTER_STATE_DIR=$PI_MUSTER_STATE_DIR")

usage() {
    awk '/^# --- usage ---$/{f=1;next} /^# --- end usage ---$/{f=0} f' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
    echo "pi-lane-launch: $*" >&2
    exit "${2:-2}"
}

# VR21-42 S3: every lane starts with the tool shims first on its PATH, so no
# lane can run a raw compiler or test runner: tsc, tsgo, jest, vitest and next
# route to the project's guarded entry or refuse naming it. The routed entry
# runs with the shim directory stripped from PATH (scripts/lane-shims/
# guarded-route.sh), so the guarded entries still reach the real tools.
LANE_SHIM_DIR="$DEFAULT_AGENT_ROOT/scripts/lane-shims"
[ -d "$LANE_SHIM_DIR" ] || die "lane shims missing: $LANE_SHIM_DIR"
case ":$PATH:" in
    *":$LANE_SHIM_DIR:"*) : ;;
    *) PATH="$LANE_SHIM_DIR:$PATH" ;;
esac

# The lane's lifecycle record (harness/muster/lane-lifecycle.ts), written once the
# lane is up. A failure is reported and never fails the launch: the lane is running.
# A lane whose record already exists is the same lane coming back: the record write re-declares it. The one caller that
# must never do that is the dispatcher, and it refuses a lane id that already has a live record before it starts anything
# (dispatch.ts, `gated:live-record`), so it never replaces a running session's record.
write_lane_record() {
    local muster="$DEFAULT_AGENT_ROOT/extensions/muster/launchers/muster" branch
    if [ ! -x "$muster" ]; then
        echo "pi-lane-launch: no muster CLI at $muster; the lane record was not written" >&2
        return 0
    fi
    branch="${BRANCH:-$(git -C "$CWD_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)}"
    local browser=""
    if [ "$HARNESS" = "claude" ] && { [ "$CHROME" -eq 1 ] || { [ -n "$BRIEF" ] && [ -r "$BRIEF" ] && grep -Fq 'claude-in-chrome' "$BRIEF"; }; }; then
        browser=1
    fi
    local conversation=""
    [ "$CONVERSATION" -eq 0 ] || conversation=1
    PI_MUSTER_STATE_DIR="$MUSTER_STATE" "$muster" lane-record launch --lane "$LANE" --harness "$HARNESS" \
        --cwd "$CWD_DIR" --repo-root "$REPO_ROOT" --launched-by "$LAUNCHED_BY" \
        ${branch:+--branch "$branch"} ${SESSION:+--session "$SESSION"} ${browser:+--browser} ${conversation:+--conversation} \
        ${LAUNCH_WARNING:+--launch-warning "model $MODEL $LAUNCH_WARNING"} \
        ${MODEL:+--model "$MODEL"} ${LANE_CLASS:+--class "$LANE_CLASS"} ${TASK_KIND:+--task-kind "$TASK_KIND"} \
        ${TITLE:+--title "$TITLE"} ${ITEM:+--item "$ITEM"} \
        || echo "pi-lane-launch: the lane record for $LANE was not written" >&2
    attach_goal
    return 0
}

# D28/CRL 4: the goal link, as the last step of the record write, on every start path. The attach runs
# in THIS shell, under the caller's seat: the seat scrub applies to the lane's process, not to the
# launcher (a lane that held the seat could attach itself to anything). A conflict is retried once;
# a second failure leaves the lane running and reports exit 4 with the command to run.
attach_goal() {
    local muster="$DEFAULT_AGENT_ROOT/extensions/muster/launchers/muster" out=""
    [ -n "$GOAL_CODE" ] || return 0
    [ "$GOAL_ATTACHED" -eq 0 ] || return 0
    [ -x "$muster" ] || return 0
    if out="$(PI_MUSTER_STATE_DIR="$MUSTER_STATE" "$muster" goals attach "$GOAL_CODE" "$LANE" --station "$GOAL_STATION" 2>&1)"; then
        return 0
    fi
    sleep 1
    if out="$(PI_MUSTER_STATE_DIR="$MUSTER_STATE" "$muster" goals attach "$GOAL_CODE" "$LANE" --station "$GOAL_STATION" 2>&1)"; then
        return 0
    fi
    echo "pi-lane-launch: $LANE is running; its goal link to $GOAL_CODE was not written" >&2
    if [ -n "$out" ]; then echo "pi-lane-launch: $out" >&2; fi
    echo "pi-lane-launch: run: PI_MUSTER_STATE_DIR=$MUSTER_STATE $muster goals attach $GOAL_CODE $LANE --station $GOAL_STATION" >&2
    ATTACH_STATUS=4
    return 0
}

# The dry run prints the one call that writes the lane's record, with the facts the record will carry.
describe_lane_record() {
    local branch="${BRANCH:-}"
    printf 'would run: PI_MUSTER_STATE_DIR=%s %s lane-record launch --lane %s --harness %s --cwd %s --repo-root %s --launched-by %s' \
        "$MUSTER_STATE" "$MUSTER_CLI" "$LANE" "$HARNESS" "$CWD_DIR" "$REPO_ROOT" "$LAUNCHED_BY"
    if [ -n "$branch" ]; then printf ' --branch %s' "$branch"; fi
    if [ -n "$SESSION" ]; then printf ' --session %s' "$SESSION"; fi
    if [ -n "$MODEL" ]; then printf ' --model %s' "$MODEL"; fi
    if [ -n "$LANE_CLASS" ]; then printf ' --class %s' "$LANE_CLASS"; fi
    if [ -n "$TASK_KIND" ]; then printf ' --task-kind %s' "$TASK_KIND"; fi
    if [ -n "$TITLE" ]; then printf ' --title %s' "$TITLE"; fi
    printf '\n'
    if [ -n "$GOAL_CODE" ]; then
        if [ "$GOAL_ATTACHED" -eq 1 ]; then
            printf 'would attach nothing: goal %s already holds %s\n' "$GOAL_CODE" "$LANE"
        else
            printf 'would then attach: PI_MUSTER_STATE_DIR=%s %s goals attach %s %s --station %s\n' "$MUSTER_STATE" "$MUSTER_CLI" "$GOAL_CODE" "$LANE" "$GOAL_STATION"
        fi
    fi
}

while [ $# -gt 0 ]; do
    case "$1" in
        --lane) LANE="${2:-}"; shift 2 ;;
        --harness) HARNESS="${2:-}"; shift 2 ;;
        --agent-dir) AGENT_DIR_OVERRIDE="${2:-}"; shift 2 ;;
        --session) SESSION="${2:-}"; shift 2 ;;
        --cwd) CWD_DIR="${2:-}"; shift 2 ;;
        --repo-root) REPO_ROOT="${2:-}"; shift 2 ;;
        --repo-root-own) REPO_ROOT_OWN=1; shift ;;
        --model) MODEL="${2:-}"; shift 2 ;;
        --task-kind) TASK_KIND="${2:-}"; shift 2 ;;
        --class) LANE_CLASS="${2:-}"; shift 2 ;;
        --branch) BRANCH="${2:-}"; shift 2 ;;
        --db) DB_OVERRIDE="${2:-}"; shift 2 ;;
        --brief) BRIEF="${2:-}"; shift 2 ;;
        --resume-brief) RESUME_BRIEF=1; shift ;;
        --launched-by) LAUNCHED_BY="${2:-}"; shift 2 ;;
        --item) ITEM="${2:-}"; shift 2 ;;
        --chrome) CHROME=1; shift ;;
        --conversation) CONVERSATION=1; shift ;;
        --title) TITLE="${2:-}"; shift 2 ;;
        --goal) GOAL="${2:-}"; shift 2 ;;
        --no-goal) NO_GOAL=1; shift ;;
        --no-attach) ATTACH=0; shift ;;
        --respawn) RESPAWN=1; shift ;;
        --no-register) REGISTER=0; shift ;;
        --unregister) UNREGISTER=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        --verify-seconds) VERIFY_SECONDS="${2:-}"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) die "unknown argument: $1" ;;
    esac
done

[ -n "$LANE" ] || die "--lane <lane> is required"
case "$HARNESS" in
    pi|opencode|claude) ;;
    *) die "--harness must be pi, opencode or claude, got $HARNESS" ;;
esac

# ── D27/D28 (CRL): the title and the goal are stated before anything starts ─────────────────────
# The check sits after the seat check and before the heavy gate, so a seat refusal answers first and a
# refused launch spends no gate stamp; either way no process exists yet on any start path (blueprint Q1).
# A relaunch or respawn of a lane that already has a record needs neither flag, and a conversation lane
# needs neither: that is `recordLaunch`'s own rule.
record_phase() {
    local muster="$DEFAULT_AGENT_ROOT/extensions/muster/launchers/muster" record status=0
    [ -x "$muster" ] || { printf 'unknown'; return 0; }
    # The exit code is the owner's answer (VR24-178 R4): 0 carries the record, 3 says the lane has none, and
    # anything else (a ledger with no daemon, a broken backend) is UNKNOWN, never "new": reading a failure as
    # "no record" launched a lane as if it were new, and a broken install must not decide that.
    record="$(PI_MUSTER_STATE_DIR="$MUSTER_STATE" "$muster" lane-record show "$LANE" --json 2>/dev/null)" || status=$?
    case "$status" in
        0) ;;
        3) printf 'new'; return 0 ;;
        *) printf 'unknown'; return 0 ;;
    esac
    printf '%s' "$record" | python3 -c 'import json,sys
try: d = json.load(sys.stdin)
except Exception: d = None
print("unknown" if d is None else ("new" if d.get("terminal") is not None or d.get("phase") in ("merged","abandoned","closed") else "live"))' 2>/dev/null || printf 'unknown'
}

check_title_and_goal() {
    local muster="$DEFAULT_AGENT_ROOT/extensions/muster/launchers/muster" phase answer goals_json
    phase="$(record_phase)"
    if [ "$phase" = "live" ]; then NEW_LANE=0; fi
    # A store that cannot be read never refuses a launch: the record write reports it, and a missing
    # musterd or CLI must not stop every lane on the machine.
    if [ "$phase" = "unknown" ]; then NEW_LANE=0; fi
    # Nothing starts on these paths, so the two flags are not asked of them.
    if [ "$RESPAWN" -eq 1 ] || [ "$RESUME_BRIEF" -eq 1 ] || [ "$UNREGISTER" -eq 1 ] || [ "$DRY_RUN" -eq 1 ]; then
        NEW_LANE=0
    fi
    if [ "$NEW_LANE" -eq 1 ] && [ "$CONVERSATION" -eq 0 ] && [ -z "$TITLE" ]; then
        echo "pi-lane-launch: a new lane needs --title: what it delivers, in plain words" >&2
        exit 3
    fi
    if [ -n "$TITLE" ]; then
        # The rule has ONE owner, `validateLaneTitle`, and the launcher asks it through the CLI: Python counts
        # code points and JavaScript counts UTF-16 units, so a title at the length edge (an emoji) would pass a
        # shell-side count and then be refused by the record write after the lane had started (VR24-178 R3).
        # A CLI that is not there skips the check; a CLI that answers refuses with the owner's own words.
        if answer="$(PI_MUSTER_STATE_DIR="$MUSTER_STATE" "$muster" lane-record title-check --title "$TITLE" 2>&1)"; then
            TITLE="$answer"
        elif [ -x "$muster" ]; then
            printf '%s\n' "$answer" >&2
            exit 3
        fi
    fi
    if [ -n "$GOAL" ] && [ "$NO_GOAL" -eq 1 ]; then
        echo "pi-lane-launch: --goal and --no-goal name two different things; give one" >&2
        exit 3
    fi
    if [ -n "$GOAL" ] && [ "$LAUNCHED_BY" = "grokbot" ]; then
        echo "pi-lane-launch: --goal is refused with --launched-by grokbot; a Grokbot lane works on no goal" >&2
        exit 3
    fi
    if [ "$NEW_LANE" -eq 1 ] && [ "$CONVERSATION" -eq 0 ] && [ "$LAUNCHED_BY" = "orchestrator" ] && [ -z "$GOAL" ] && [ "$NO_GOAL" -eq 0 ]; then
        echo "pi-lane-launch: an orchestrator launch names the goal the lane works on: --goal <CODE>[:<station>] or --no-goal" >&2
        exit 3
    fi
    [ -n "$GOAL" ] || return 0
    GOAL_CODE="${GOAL%%:*}"
    case "$GOAL" in
        *:*) GOAL_STATION="${GOAL#*:}" ;;
    esac
    if [ -z "$GOAL_CODE" ]; then
        echo "pi-lane-launch: --goal needs a goal code" >&2
        exit 3
    fi
    goals_json="$(PI_MUSTER_STATE_DIR="$MUSTER_STATE" "$muster" goals show "$GOAL_CODE" --json 2>/dev/null || true)"
    if [ -z "$goals_json" ]; then
        echo "pi-lane-launch: no goal $GOAL_CODE in the goal registry; nothing was started" >&2
        exit 3
    fi
    answer="$(printf '%s' "$goals_json" | python3 -c 'import json,sys
want, lane = sys.argv[1], sys.argv[2]
d = json.load(sys.stdin)
if d.get("status") != "open":
    print("closed:" + str(d.get("status"))); raise SystemExit
stations = [s.get("id") for s in d.get("stations", [])]
if want and want not in stations:
    print("no-station:" + want); raise SystemExit
station = want or next((s.get("id") for s in d.get("stations", []) if s.get("finishedAt") is None), "")
if not station:
    print("no-current"); raise SystemExit
held = any(row.get("lane") == lane for row in d.get("lanes", []))
print("ok:" + station + (":held" if held else ""))' "$GOAL_STATION" "$LANE" 2>/dev/null || true)"
    case "$answer" in
        ok:*:held) GOAL_ATTACHED=1; GOAL_STATION="${answer#ok:}"; GOAL_STATION="${GOAL_STATION%:held}" ;;
        ok:*) GOAL_STATION="${answer#ok:}" ;;
        closed:*) echo "pi-lane-launch: goal $GOAL_CODE is ${answer#closed:}; a lane attaches to an open goal" >&2; exit 3 ;;
        no-station:*) echo "pi-lane-launch: goal $GOAL_CODE has no station ${answer#no-station:}" >&2; exit 3 ;;
        no-current) echo "pi-lane-launch: every station of goal $GOAL_CODE is finished; name one with --goal $GOAL_CODE:<station>" >&2; exit 3 ;;
        *) echo "pi-lane-launch: goal $GOAL_CODE could not be read; nothing was started" >&2; exit 3 ;;
    esac
}
# A direct launch from an agent session needs the orchestrator seat (seats blueprint, Privileges 3).
# `muster launch-check` owns the answer. A resume (`muster send` to a parked lane), --unregister and
# --dry-run change no lane and skip it.
if [ "$RESUME_BRIEF" -eq 0 ] && [ "$UNREGISTER" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
    launch_check_muster="$DEFAULT_AGENT_ROOT/extensions/muster/launchers/muster"
    if [ -x "$launch_check_muster" ]; then
        "$launch_check_muster" launch-check || exit $?
    else
        echo "pi-lane-launch: no muster CLI at $launch_check_muster; the launch seat check was skipped" >&2
    fi
fi
# D27/D28 (CRL): the title and the goal are checked after the seat check and before the heavy gate, so a
# refused launch spends no gate stamp, and before the live-name read, model resolution, the record write and
# every start call: a refusal never leaves a process running (blueprint Q1).
check_title_and_goal
# A new lane is a heavy start (agent, installs, tests): refused while a dev-server window is open or the
# machine is under memory pressure (heavy-gate.sh, Henry priority 1, 2026-10-19). A respawn, a resume and a
# dry run start no new lane and skip it.
if [ "$RESPAWN" -eq 0 ] && [ "$RESUME_BRIEF" -eq 0 ] && [ "$UNREGISTER" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
    "$(dirname "$(readlink -f "$0")")/heavy-gate.sh" lane-launch || exit $?
fi
[ "$CHROME" -eq 0 ] || [ "$HARNESS" = "claude" ] || die "--chrome is supported only with --harness claude"
if [ "$HARNESS" = "claude" ]; then
    # A Claude lane is a background session: no tmux window, no lane store row.
    [ "$RESPAWN" -eq 0 ] || die "--respawn is not supported with --harness claude"
    [ -z "$SESSION" ] || die "--session is not supported with --harness claude (a Claude session resumes with claude --resume)"
    [ -n "$BRIEF" ] || die "--brief <file> is required for --harness claude"
    command -v claude >/dev/null || die "claude is not on PATH"
else
    command -v tmux >/dev/null || die "tmux is not on PATH"
fi
# --brief is required for a Claude lane and optional for a Pi or OpenCode lane:
# with none those lanes start with no first message and the orchestrator sends
# its pointer later. With one, the first message carries the harness trigger.
if [ -n "$BRIEF" ]; then
    [ -f "$BRIEF" ] || die "brief not found: $BRIEF"
    BRIEF="$(cd "$(dirname "$BRIEF")" && pwd)/$(basename "$BRIEF")"
    case "$(readlink -f "$BRIEF")" in
        /tmp|/tmp/*) die "briefs live in handoffs/msgs (standing rule 2026-10-11); refused: $BRIEF" ;;
    esac
fi

# The lane's first message. Its first word is the harness's own trigger for the
# lane-worker skill (Claude and OpenCode: /lane-worker; Pi: /skill:lane-worker),
# so the lane takes the brief through its role procedure rather than from raw
# text. One body, one prefix per harness; an empty --brief sends no message.
LANE_FIRST_MESSAGE=""
if [ -n "$BRIEF" ]; then
    LANE_MESSAGE_BODY="Read $BRIEF and do it. Commit your work locally; do not push. When you finish, file your report with \`muster report review_ready --summary \"<one line>\" --branch <branch> --sha <sha>\`, or with \`muster report blocked \"<reason>\" --needs \"<what you need>\"\` if you cannot finish, then stop."
    case "$HARNESS" in
        pi) LANE_FIRST_MESSAGE="/skill:lane-worker $LANE_MESSAGE_BODY" ;;
        *) LANE_FIRST_MESSAGE="/lane-worker $LANE_MESSAGE_BODY" ;;
    esac
fi

# OpenCode lanes live in the `oc` tmux session, Pi lanes in `pi`; the
# environment variable wins over both. The host is the one in this script's own
# installation (recipe and host are one piece); --agent-dir only points at the
# provider pool the host reads for quota shapes.
AGENT_DIR="${AGENT_DIR_OVERRIDE:-$DEFAULT_AGENT_ROOT}"
[ -d "$AGENT_DIR" ] || die "--agent-dir does not exist: $AGENT_DIR"
TMUX_SESSION="${TMUX_SESSION_OVERRIDE:-$([ "$HARNESS" = "opencode" ] && echo oc || echo pi)}"
# One lane store, whoever launched the lane: the recipe resumes by lane id and
# A6's Pi loop reads this file (an OpenCode id in it is reported as a Pi lane
# without a window — see the lane report's finding).
LANES_JSON="${LANES_JSON_OVERRIDE:-$HOME/.pi/agent/state/pi-lanes.json}"
# The registry and the lane record are the owners' (LC5): every read and write of
# pi-lanes.json goes through this CLI, so the launcher never writes the store's
# file itself and the same calls work when the ledger is the store.
MUSTER_CLI="$DEFAULT_AGENT_ROOT/extensions/muster/launchers/muster"

# The same node resolution the muster launchers and the guarded test runner use:
# the installation's own node, then the live agent's, then whatever is on PATH.
resolve_node() {
    local candidate resolved
    for candidate in "$DEFAULT_AGENT_ROOT/bin/node" "$HOME/.pi/agent/bin/node"; do
        resolved="$(readlink -f "$candidate" 2>/dev/null || true)"
        if [ -n "$resolved" ] && [ -x "$resolved" ]; then printf '%s' "$resolved"; return 0; fi
    done
    command -v node 2>/dev/null || true
}

# The directories the lane's own executables live in. run-custom.sh ends in
# `exec node`, and the OpenCode host needs `opencode`; a service such as
# muster-gateway runs with PATH=~/.local/bin:/usr/local/bin:/usr/bin:/bin, which
# has neither, so the pane died with status 127 within a second (2026-10-10).
# The launcher puts them on its own PATH and hands that PATH to the lane's
# window: a tmux server that already exists would otherwise give the window its
# own, older environment.
ensure_toolchain_path() {
    local candidate dir
    local -a wanted=("$(resolve_node)")
    if [ "$HARNESS" = "opencode" ] && ! command -v "${OPENCODE_BIN:-opencode}" >/dev/null 2>&1; then
        wanted+=("$HOME/.opencode/bin/opencode")
    fi
    for candidate in "${wanted[@]}"; do
        [ -x "$candidate" ] || continue
        dir="$(dirname "$candidate")"
        case ":$PATH:" in *":$dir:"*) continue ;; esac
        PATH="$dir:$PATH"
    done
    # PATH always travels with the pane (VR21-42 S3): even when no toolchain
    # directory had to be added, an existing tmux server keeps its own older
    # environment, and the shims must be first on the pane's PATH.
    ENV_ARGS+=(-e "PATH=$PATH")
    return 0
}
if [ "$HARNESS" != "claude" ]; then ensure_toolchain_path; fi

# Agent keys: the file is the owner of a provider key's value, and the tmux server is not. A server holds the
# environment it was started with, so a key added to `~/.config/agent-keys.env` afterwards never reached a lane
# (2026-10-27: the S14 Go proof failed on "Failed to resolve API key"), and a copy kept with its shell quotes reached
# one as 53 characters against 51 and answered 401. The launcher therefore reads the file at every start, through the
# one parser (`harness/muster/lane-keys.mjs` over `harness/routing/provider-key.ts`), and gives the lane each name and
# value: `-e` overrides the server's copy for this window alone, and the same values are exported here so a background
# Claude lane inherits them. The helper says out loud, on stderr and by NAME and length only, about a value it cannot
# trust: one still quoted after parsing, or one whose length and sha256 are not the second copy's. A helper that cannot
# run leaves the launch exactly as it was; no value is ever printed, because the dry run and the log line print
# `describe()`'s argv, which holds no key, and the helper's own output on stderr carries none.
KEY_ENV_ARGS=()
inject_agent_keys() {
    local node_bin helper pair
    node_bin="$(resolve_node)"
    helper="$DEFAULT_AGENT_ROOT/harness/muster/lane-keys.mjs"
    if [ -z "$node_bin" ] || [ ! -f "$helper" ]; then
        echo "pi-lane-launch: no key helper ($helper); $LANE starts with the tmux server's environment" >&2
        return 0
    fi
    while IFS= read -r -d '' pair; do
        [ -n "$pair" ] || continue
        KEY_ENV_ARGS+=(-e "$pair")
        export "$pair"
    done < <("$node_bin" "$helper")
    return 0
}
inject_agent_keys

NEW_WINDOW_ID=""
NODE_BIN=""
PI_PATH=""
OPENCODE_HOST=""
OPENCODE_BIN_PATH=""
if [ "$HARNESS" = "opencode" ]; then
    NODE_BIN="$(resolve_node)"
    [ -n "$NODE_BIN" ] || die "no node executable found (the OpenCode host needs one)"
    OPENCODE_HOST="$DEFAULT_AGENT_ROOT/harness/muster/opencode-host.mjs"
    [ -f "$OPENCODE_HOST" ] || die "OpenCode lane host not found: $OPENCODE_HOST"
    # The TUI pane needs the opencode client; without it the lane still runs on
    # the bus headless, so this is a warning, not a failure.
    OPENCODE_BIN_PATH="$(command -v "${OPENCODE_BIN:-opencode}" 2>/dev/null || true)"
    # A lane's own database: the recipe sets it (or refuses) so no lane can fall
    # back to the agent-wide database. The path comes from the one owner of that
    # question, which asks OpenCode itself where its data lives.
    LANE_DB_HELPER="$DEFAULT_AGENT_ROOT/harness/muster/lane-database.mjs"
    [ -f "$LANE_DB_HELPER" ] || die "lane database helper not found: $LANE_DB_HELPER"
    [ -n "$OPENCODE_BIN_PATH" ] || die "opencode is not on PATH (OPENCODE_BIN=${OPENCODE_BIN:-opencode}); an OpenCode lane needs it to run and to report its data directory"
    DB_PATH_ARGS=(path --lane "$LANE" --opencode "$OPENCODE_BIN_PATH")
    [ -n "$DB_OVERRIDE" ] && DB_PATH_ARGS+=(--db "$DB_OVERRIDE")
    LANE_DB="$("$NODE_BIN" "$LANE_DB_HELPER" "${DB_PATH_ARGS[@]}")" || die "could not work out the lane database path (pass --db <absolute path>)"
    [ -n "$LANE_DB" ] || die "the lane database path came back empty"
    if [ "$LANE_DB" != ":memory:" ] && [ "$DRY_RUN" -eq 0 ]; then
        mkdir -p "$(dirname "$LANE_DB")" || die "cannot create the lane database directory: $(dirname "$LANE_DB")"
    fi
elif [ "$HARNESS" = "pi" ]; then
    PI_PATH="$(command -v "$PI_BIN" || true)"
    [ -n "$PI_PATH" ] || die "no pi executable found ($PI_BIN)"
fi

# The per-harness lane default model, and the P5-D6 check on an explicit one. One owner:
# provider-pool.json laneDefaults and its ranking rule, read through the pool library
# (extensions/lib/provider-pool.ts), and the harness catalog (harness/muster/lib/lane-control.ts)
# for the check, by this thin CLI. The launcher reads the answer and prints why; it adds no
# routing of its own.
LANE_MODEL_HELPER="$DEFAULT_AGENT_ROOT/harness/muster/lane-model.mjs"
resolve_lane_model() {
    local node_bin json explicit=0
    [ -n "$MODEL" ] && explicit=1
    node_bin="$(resolve_node)"
    [ -n "$node_bin" ] || die "no node executable found (the lane model is resolved with node); pass --model <model>"
    [ -f "$LANE_MODEL_HELPER" ] || die "lane model helper not found: $LANE_MODEL_HELPER"
    local helper_args=(--harness "$HARNESS" --agent-dir "$AGENT_DIR" --lane "$LANE" --json)
    [ -n "$MODEL" ] && helper_args+=(--explicit "$MODEL")
    # What the lane does and as which class: the helper writes them on the routing decision line.
    [ -n "$TASK_KIND" ] && helper_args+=(--task-kind "$TASK_KIND")
    [ -n "$LANE_CLASS" ] && helper_args+=(--class "$LANE_CLASS")
    if ! json="$("$node_bin" "$LANE_MODEL_HELPER" "${helper_args[@]}")"; then
        local reason
        reason="$(printf '%s' "$json" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("reason") or "no reason given")
except Exception: print("the lane model helper printed nothing readable")')"
        if [ "$explicit" -eq 1 ]; then die "model $MODEL is refused: $reason"; fi
        die "no default model for harness $HARNESS: $reason (pass --model <provider/model>)"
    fi
    if [ "$explicit" -eq 0 ]; then
        MODEL="$(printf '%s' "$json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("model") or "")')"
        [ -n "$MODEL" ] || die "no default model for harness $HARNESS; pass --model <provider/model>"
        read_lane_account "$json"
        echo "pi-lane-launch: model $MODEL ($(printf '%s' "$json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("note") or "no reason given")'))${LANE_ACCOUNT:+, account $LANE_ACCOUNT}"
    else
        # An explicit model on a walled provider still launches (P5-D6); the helper's warning is
        # printed here and copied to the lane record for the weekly digest.
        read_lane_account "$json"
        LAUNCH_WARNING="$(printf '%s' "$json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("warning") or "")')"
        if [ -n "$LAUNCH_WARNING" ]; then echo "pi-lane-launch: warning: model $MODEL $LAUNCH_WARNING" >&2; fi
    fi
}

# The account the helper named for this model (CCACCT2), when the plan holds more than one: printed with the model.
read_lane_account() {
    LANE_ACCOUNT="$(printf '%s' "$1" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("account") or "")')"
}

# A respawn must not move the lane: without --cwd it stays where the pane is.
# (The session id is project-scoped, so a different cwd would resume nothing.)
if [ -z "$CWD_DIR" ] && [ "$RESPAWN" -eq 1 ] && tmux list-windows -t "$TMUX_SESSION" -F '#{window_name}' 2>/dev/null | grep -Fxq "$LANE"; then
    CWD_DIR="$(tmux list-panes -t "$TMUX_SESSION:$LANE" -F '#{pane_current_path}' 2>/dev/null | head -1)"
    if [ -n "$CWD_DIR" ]; then echo "pi-lane-launch: respawn keeps the pane's cwd: $CWD_DIR"; fi
fi
CWD_DIR="${CWD_DIR:-$PWD}"
# The Concord workspace of a lane (any harness): the shared root unless the caller names one
# or asks for the lane's own cwd (`--repo-root-own`, the pre-2026-10-08 default).
if [ -z "$REPO_ROOT" ]; then
    if [ "$REPO_ROOT_OWN" -eq 1 ]; then
        REPO_ROOT="$CWD_DIR"
    else
        REPO_ROOT="${PI_LANES_REPO_ROOT:-$HOME/.pi/agent}"
    fi
fi
[ -d "$CWD_DIR" ] || die "cwd does not exist: $CWD_DIR"

# One live holder per lane name, whatever the harness (LD15): a second session under a lane's name
# splits its messages and its record. `claude agents --json` lists the Claude sessions by name; the
# lane tmux sessions list the Pi and OpenCode windows. A Pi or OpenCode lane's own window in its own
# session is left to the window check below (a --respawn replaces that process).
refuse_live_name() {
    local live session sessions
    if command -v claude >/dev/null; then
        if agents_json="$("${SEAT_SCRUB[@]}" claude agents --json 2>/dev/null)"; then
            live="$(printf '%s' "$agents_json" | python3 -c 'import json,sys
rows = json.load(sys.stdin)
print(sum(1 for r in rows if isinstance(r, dict) and str(r.get("name") or "").strip() == sys.argv[1]))' "$LANE")" || die "could not read claude agents --json"
            [ "$live" = "0" ] || die "a live Claude session is already named $LANE; nothing was started" 3
        elif [ "$HARNESS" = "claude" ]; then
            die "claude agents --json failed; cannot check whether a session named $LANE is live"
        else
            echo "pi-lane-launch: warning: claude agents --json failed; a Claude session named $LANE was not ruled out" >&2
        fi
    fi
    if command -v tmux >/dev/null; then
        sessions="${TMUX_SESSION_OVERRIDE:-pi oc}"
        for session in $sessions; do
            [ "$HARNESS" = "claude" ] || [ "$session" != "$TMUX_SESSION" ] || continue
            if tmux list-windows -t "=$session" -F '#{window_name}' 2>/dev/null | grep -Fxq "$LANE"; then
                die "window $session:$LANE already exists; a lane name has one live holder (LD15); nothing was started" 3
            fi
        done
    fi
}
if [ "$UNREGISTER" -eq 0 ]; then
    refuse_live_name
fi

if [ "$HARNESS" = "claude" ]; then
    resolve_lane_model
    CLAUDE_MODEL="$MODEL"
    CLAUDE_ARGS=(--bg --name "$LANE" --model "$CLAUDE_MODEL" --permission-mode bypassPermissions)
    if [ "$CHROME" -eq 1 ]; then
        CLAUDE_ARGS+=(--chrome)
    fi
    # The bus-agent plugin gives the lane the same mid-task inbox delivery and
    # heartbeat a Pi lane has (muster claude-hook). Loaded only for a bus lane:
    # an interactive session never sees it. PI_CLAUDE_BUS_PLUGIN_DIR names it; a
    # missing folder is not an error, the lane just runs without the plugin.
    CLAUDE_BUS_PLUGIN_DIR="${PI_CLAUDE_BUS_PLUGIN_DIR:-$HOME/.local/share/claude-mods-live/muster-bus}"
    if [ -d "$CLAUDE_BUS_PLUGIN_DIR" ]; then
        CLAUDE_ARGS+=(--plugin-dir "$CLAUDE_BUS_PLUGIN_DIR")
    fi
    # The lane files its own end-of-run report: a Claude session ends with no bus signal,
    # so without this line the orchestrator's inbox never hears that it finished. The
    # session names the lane (muster resolves it), so no --agent is needed. The message
    # starts with the lane-worker trigger so the lane takes the brief through its role skill.
    # A Claude lane is woken in place by its own background `muster wait --inbox` (LD10), so the
    # first message asks for it. The Stop hook asks again at each turn end while it is not running.
    CLAUDE_ARGS+=("$LANE_FIRST_MESSAGE Message wake-up: run \`muster wait --inbox $LANE --timeout 0\` with run_in_background true now, and again each time it returns, so messages can wake you.")
    if [ "$DRY_RUN" -eq 1 ]; then
        echo "would start Claude lane $LANE: cd $CWD_DIR && claude ${CLAUDE_ARGS[*]}   (CONCORD_REPO_ROOT=$REPO_ROOT; the job record names the lane)"
        exit 0
    fi
    # No CONCORD_AGENT_ID: `claude --bg` hands the job to the daemon, which spawns every session from its own environment, so the
    # variable reached only the lane that started the daemon and then named that lane in every later session (S6, 2026-10-23:
    # `pb3fix`). A Claude lane's identity is its job record (ownClaudeLane). The caller's own id is removed too, so it is not
    # baked into the daemon either.
    bg_id="$(cd "$CWD_DIR" && "${SEAT_SCRUB[@]}" -u CONCORD_AGENT_ID CONCORD_REPO_ROOT="$REPO_ROOT" claude "${CLAUDE_ARGS[@]}")" || die "claude --bg failed for $LANE"
    # `claude --bg` prints `backgrounded · <id> · <name>` and then a hint block, so the id is
    # the third word of that line, not the last line (Claude Code 2.1.295).
    bg_id="$(printf '%s\n' "$bg_id" | awk '/^backgrounded / { print $3; exit }')"
    [ -n "$bg_id" ] || die "claude --bg printed no session id for $LANE"
    echo "pi-lane-launch: started Claude lane $LANE (id $bg_id, model $CLAUDE_MODEL, cwd $CWD_DIR)"
    # The Claude daemon starts the lane, so it is moved into pi-lanes.slice after the fact (its tsc/jest children inherit the scope).
    adopted=0
    for _ in 1 2 3 4 5; do
        if "$DEFAULT_AGENT_ROOT/scripts/lane-adopt-cgroup.sh" "$LANE"; then adopted=1; break; fi
        sleep 2
    done
    [ "$adopted" -eq 1 ] || echo "pi-lane-launch: $LANE runs outside pi-lanes.slice (lane-adopt-cgroup.sh failed)" >&2
    write_lane_record
    exit "$ATTACH_STATUS"
fi

# --unregister: the one code path that removes a lane's row from the lane store.
# A launch that fails leaves no row (it is written after verify); this is for a
# row left by a lane that has since been stopped.
if [ "$UNREGISTER" -eq 1 ]; then
    if tmux list-windows -t "=$TMUX_SESSION" -F '#{window_name}' 2>/dev/null | grep -Fxq "$LANE"; then
        die "window $TMUX_SESSION:$LANE exists; stop the lane before removing its row" 3
    fi
    if [ ! -x "$MUSTER_CLI" ]; then
        echo "pi-lane-launch: no muster CLI at $MUSTER_CLI; the registry row was not removed" >&2
        exit 0
    fi
    PI_MUSTER_STATE_DIR="$MUSTER_STATE" PI_LANES_JSON="$LANES_JSON" "$MUSTER_CLI" lane-record unregister "$LANE" || die "could not remove $LANE from $LANES_JSON"
    exit 0
fi

# The session to resume: an explicit id, else the lane's own registry row. The
# owner decides which store that is (files or ledger) and answers empty when the
# lane has no row, exactly as the launcher's earlier reader did.
if [ -z "$SESSION" ] && [ -x "$MUSTER_CLI" ]; then
    SESSION="$(PI_MUSTER_STATE_DIR="$MUSTER_STATE" PI_LANES_JSON="$LANES_JSON" "$MUSTER_CLI" lane-record session "$LANE" 2>/dev/null || true)"
fi
FRESH_PI_SESSION=0
if [ -z "$SESSION" ]; then
    if [ "$HARNESS" = "opencode" ]; then
        echo "pi-lane-launch: no session for $LANE; the host creates one and this script registers it after launch"
    else
        SESSION="$(python3 -c 'import uuid; print(uuid.uuid4())')"
        FRESH_PI_SESSION=1
        echo "pi-lane-launch: no session for $LANE; starting a new one ($SESSION)"
    fi
fi

# The card's branch: explicit, else the cwd's branch (OpenCode host only; a Pi
# session derives its own).
if [ "$HARNESS" = "opencode" ] && [ -z "$BRANCH" ]; then
    BRANCH="$(git -C "$CWD_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
fi

# The model the lane starts on: an explicit --model, else the harness's default. The helper also names the account that
# model runs on (CCACCT2): Command Code's routed account is the second one, named by `models.json`'s `$ACCT2_` entry, so
# the launcher prints it and nothing else — the general key injection above already hands the lane that name's value.
resolve_lane_model "$HARNESS"

if [ "$HARNESS" = "opencode" ]; then
    CMD=("$NODE_BIN" "$OPENCODE_HOST" --lane "$LANE" --cwd "$CWD_DIR"
         --state-dir "$MUSTER_STATE" --agent-dir "$AGENT_DIR" --repo-root "$REPO_ROOT")
    [ -n "$MODEL" ] && CMD+=(--model "$MODEL")
    [ -n "$SESSION" ] && CMD+=(--session "$SESSION")
    [ -n "$BRANCH" ] && CMD+=(--branch "$BRANCH")
    [ -n "$LANE_FIRST_MESSAGE" ] && CMD+=(--first-message "$LANE_FIRST_MESSAGE")
    [ -n "$LANE_FIRST_MESSAGE" ] && [ "$RESUME_BRIEF" -eq 1 ] && CMD+=(--first-message-on-resume)
else
    CMD=("$PI_PATH" --session-id "$SESSION" --name "$LANE")
    [ -n "$MODEL" ] && CMD+=(--model "$MODEL")
    # Only a new session is briefed: a resumed one already holds its conversation (the
    # OpenCode host applies the same rule to an adopted session). --resume-brief is the
    # exception: a parked lane resumed with a message.
    [ -n "$LANE_FIRST_MESSAGE" ] && { [ "$FRESH_PI_SESSION" -eq 1 ] || [ "$RESUME_BRIEF" -eq 1 ]; } && CMD+=("$LANE_FIRST_MESSAGE")
    # The brief is dropped on a resumed session by design; say so, because the
    # launch output is the only place the caller can see it (2026-10-11: a respawn
    # with --brief started a lane that had no message to act on).
    if [ -n "$LANE_FIRST_MESSAGE" ] && [ "$FRESH_PI_SESSION" -eq 0 ] && [ "$RESUME_BRIEF" -eq 0 ]; then
        echo "pi-lane-launch: session $SESSION is resumed, so the brief is not sent; send it with muster send $LANE"
    fi
fi

# Stagger rule (2026-10-18, after the 18:28-18:55 stall): launch at most 2 lanes per 5 minutes. Five launches at once
# (installs, typechecks, dev servers) plus a leaking dev server exhausted memory and took the gateway down. The BE dev
# server runs only through scripts/lanes/dev-server.sh, capped at MemoryMax=5G with no swap, restarted per journey run.
# The pane's process runs in its own transient scope inside pi-lanes.slice, so
# the lanes are one cgroup group (systemd-oomd's target, LD6) and `systemctl
# --user status pi-lanes.slice` lists them. No memory properties: the slice only
# groups (LD8). Without a user manager (a bare container, a shell with no
# XDG_RUNTIME_DIR) the lane runs as before and the launcher says so.
LANE_SCOPE=()
LANE_SCOPE_UNIT=""
build_lane_scope() {
    LANE_SCOPE=()
    if ! command -v systemd-run >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1; then
        echo "pi-lane-launch: no user systemd manager; $LANE runs outside pi-lanes.slice" >&2
        return 0
    fi
    LANE_SCOPE_UNIT="lane-${LANE//[^A-Za-z0-9._-]/_}-$(date +%s)"
    LANE_SCOPE=(systemd-run --user --scope --quiet --slice=pi-lanes.slice "--unit=$LANE_SCOPE_UNIT" --)
}
describe_scope() {
    if [ "${#LANE_SCOPE[@]}" -gt 0 ]; then
        printf 'pane command runs in scope %s.scope, slice pi-lanes.slice\n' "$LANE_SCOPE_UNIT"
    fi
}

window_exists() {
    tmux list-windows -t "$TMUX_SESSION" -F '#{window_name}' 2>/dev/null | grep -Fxq "$LANE"
}

# Open the lane's window. When the tmux session does not exist (its last window
# was closed, which ends it) the lane's window becomes the first window of a new
# one. The `=` makes the session name exact: a bare name also matches a session
# that merely starts with it (2026-10-08).
start_window() {
    # -P prints the window id. remain-on-exit is set in the same tmux command
    # queue as the creation, so a pane that dies at startup (status 127 for a
    # missing binary) is still there for verify() to read; a separate set-option
    # call would lose that race.
    if tmux has-session -t "=$TMUX_SESSION" 2>/dev/null; then
        NEW_WINDOW_ID="$(tmux new-window -d -P -F '#{window_id}' -t "=$TMUX_SESSION:" -n "$LANE" -c "$CWD_DIR" "$@" \; set-option -w -t "=$TMUX_SESSION:=$LANE" remain-on-exit on)"
    else
        echo "pi-lane-launch: tmux session $TMUX_SESSION does not exist; creating it with this lane as its first window"
        NEW_WINDOW_ID="$(tmux new-session -d -P -F '#{window_id}' -s "$TMUX_SESSION" -n "$LANE" -c "$CWD_DIR" "$@" \; set-option -w -t "=$TMUX_SESSION:=$LANE" remain-on-exit on)"
    fi
}

# The lane's own environment: its bus identity, and for an OpenCode lane the
# database its server and its TUI pane both use. ENV_ARGS above stays what it is
# (the caller's forwarded overrides).
LANE_ENV_ARGS=(-e "CONCORD_AGENT_ID=$LANE" -e "CONCORD_REPO_ROOT=$REPO_ROOT")
[ "$HARNESS" = "opencode" ] && LANE_ENV_ARGS+=(-e "OPENCODE_DB=$LANE_DB")

# A lane that already has a session — a moved lane — gets it into the lane's own
# database first: an OpenCode process sees one database, so a session left in the
# agent-wide one would be adopted from there. The copy reads the shared database
# through OpenCode's own export and leaves the original in place; the owner
# checks the copy's message count against the source before this returns.
migrate_session() {
    [ "$HARNESS" = "opencode" ] || return 0
    [ -n "$SESSION" ] || return 0
    if [ "$LANE_DB" = ":memory:" ]; then
        die "--db :memory: cannot hold a session; a lane with an existing session needs a file database"
    fi
    local output
    output="$("$NODE_BIN" "$LANE_DB_HELPER" ensure --lane "$LANE" --db "$LANE_DB" --session "$SESSION" --opencode "$OPENCODE_BIN_PATH")" || die "could not put session $SESSION into $LANE_DB (nothing was started; the original session is untouched)"
    [ -n "$output" ] && echo "pi-lane-launch: $output"
    return 0
}

register_lane() {
    [ "$REGISTER" -eq 1 ] || return 0
    # An empty session is not a registration: the OpenCode host creates and
    # reports its own session id, which verify() then registers.
    [ -n "$SESSION" ] || return 0
    if [ ! -x "$MUSTER_CLI" ]; then
        echo "pi-lane-launch: no muster CLI at $MUSTER_CLI; the registry row was not written" >&2
        return 0
    fi
    mkdir -p "$(dirname "$LANES_JSON")"
    # One row shape, written by the owner: `{sessionId, harness, retired?}`. The
    # harness travels with the row because the registry is bus-wide and a reader
    # that has no card yet still has to know which session a lane's window lives in.
    # A row written before 2026-10-08 is a bare session id and reads as a Pi lane.
    PI_MUSTER_STATE_DIR="$MUSTER_STATE" PI_LANES_JSON="$LANES_JSON" "$MUSTER_CLI" lane-record register "$LANE" --session "$SESSION" --harness "$HARNESS" || {
        echo "pi-lane-launch: could not register $LANE in $LANES_JSON" >&2
        return 0
    }
    echo "pi-lane-launch: registered $LANE -> $SESSION ($HARNESS) in $LANES_JSON"
}

# The dry run prints the one call that writes the registry row (LC5).
describe_registry() {
    [ "$REGISTER" -eq 1 ] || return 0
    [ -n "$SESSION" ] || return 0
    printf 'would run: PI_MUSTER_STATE_DIR=%s PI_LANES_JSON=%s %s lane-record register %s --session %s --harness %s\n' \
        "$MUSTER_STATE" "$LANES_JSON" "$MUSTER_CLI" "$LANE" "$SESSION" "$HARNESS"
}

# The exact argv tmux runs, for the dry run and the log line.
describe() {
    local kind="$1"
    printf '%s' "$kind"
    printf ' %q' "${CMD[@]}"
    printf '   (cwd %s, CONCORD_AGENT_ID=%s, CONCORD_REPO_ROOT=%s)\n' "$CWD_DIR" "$LANE" "$REPO_ROOT"
}

# The card path this lane writes (the owner's path: <musterStateDir>/lanes).
lane_card() {
    echo "$MUSTER_STATE/lanes/$LANE.json"
}

verify() {
    [ "$VERIFY_SECONDS" -gt 0 ] || return 0
    sleep "$VERIFY_SECONDS"
    local pane
    # A window that is already gone makes list-panes fail; that must reach the
    # message below, not end the script through pipefail with no output.
    pane="$(tmux list-panes -t "$TMUX_SESSION:$LANE" -F '#{pane_dead} #{pane_pid} #{pane_current_command} #{pane_current_path}' 2>/dev/null | head -1 || true)"
    if [ -z "$pane" ]; then
        echo "pi-lane-launch: window $TMUX_SESSION:$LANE is gone after launch" >&2
        return 1
    fi
    local dead
    read -r dead pane <<<"$pane"
    if [ "$dead" = "1" ]; then
        echo "pi-lane-launch: the process in $TMUX_SESSION:$LANE exited within ${VERIFY_SECONDS}s; the pane's last 20 lines:" >&2
        tmux capture-pane -p -S - -t "$TMUX_SESSION:$LANE" 2>/dev/null | grep -v '^[[:space:]]*$' | tail -20 >&2 || true
        # The dead window was made by this launch; leaving it would make the next
        # attempt refuse as "already exists". A respawned lane's window stays.
        if [ "$RESPAWN" -eq 0 ] && [ -n "$NEW_WINDOW_ID" ]; then tmux kill-window -t "$NEW_WINDOW_ID" 2>/dev/null || true; fi
        return 1
    fi
    local pid command path
    read -r pid command path <<<"$pane"
    echo "pi-lane-launch: pane pid=$pid command=$command cwd=$path"
    if [ -r "/proc/$pid/environ" ]; then
        local agent repo
        agent="$(tr '\0' '\n' < "/proc/$pid/environ" | sed -n 's/^CONCORD_AGENT_ID=//p')"
        repo="$(tr '\0' '\n' < "/proc/$pid/environ" | sed -n 's/^CONCORD_REPO_ROOT=//p')"
        echo "pi-lane-launch: bus identity CONCORD_AGENT_ID=${agent:-<missing>} CONCORD_REPO_ROOT=${repo:-<missing>}"
        [ "$agent" = "$LANE" ] || { echo "pi-lane-launch: the process did not carry CONCORD_AGENT_ID=$LANE" >&2; return 1; }
        # The lane's database has to be the one this script chose: sharing the
        # agent-wide database is the stall that one database per lane removes.
        if [ "$HARNESS" = "opencode" ]; then
            local db
            db="$(tr '\0' '\n' < "/proc/$pid/environ" | sed -n 's/^OPENCODE_DB=//p')"
            [ "$db" = "$LANE_DB" ] || { echo "pi-lane-launch: the pane did not carry OPENCODE_DB=$LANE_DB (found ${db:-<missing>})" >&2; return 1; }
        fi
    fi
    # The card lives where the extension's musterStateDir() points; one owner
    # (`lane_card`) reads $MUSTER_STATE, which follows the lane's agent dir.
    local card
    card="$(lane_card)"
    if [ -f "$card" ]; then
        echo "pi-lane-launch: lane card $(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("state=%s model=%s updatedAt=%s" % (d.get("state"), d.get("model"), d.get("updatedAt")))' "$card" 2>/dev/null || echo present)"
    else
        echo "pi-lane-launch: no lane card yet at $card (the A2 extension writes it once merged and loaded)"
    fi
    # An OpenCode lane creates its own session when it has none; register the id
    # it wrote in the card so the next respawn resumes this conversation.
    if [ "$HARNESS" = "opencode" ]; then
        local created
        created="$(python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("sessionId") or "")
except Exception: print("")' "$card" 2>/dev/null || true)"
        if [ -n "$created" ] && [ "$created" != "$SESSION" ]; then
            if [ -z "$SESSION" ]; then
                echo "pi-lane-launch: the host created OpenCode session $created"
            else
                echo "pi-lane-launch: the host reports OpenCode session $created (was $SESSION)"
            fi
            SESSION="$created"
            register_lane
        fi
    fi
    return 0
}

# The TUI pane: the host owns the server, this attaches a normal terminal to the
# same server and session, so the window looks like any other OpenCode window.
# Endpoint, session and password are runtime values: the host publishes them in
# its server record, which is read here (never a copy of the state).
attach_pane() {
    [ "$HARNESS" = "opencode" ] || return 0
    [ "$ATTACH" -eq 1 ] || return 0
    local record="$MUSTER_STATE/opencode/$LANE.server.json" deadline
    deadline=$(( $(date +%s) + ATTACH_WAIT_SECONDS ))
    while [ ! -s "$record" ] && [ "$(date +%s)" -lt "$deadline" ]; do sleep 1; done
    if [ ! -s "$record" ]; then
        echo "pi-lane-launch: no server record at $record after ${ATTACH_WAIT_SECONDS}s; the window runs headless" >&2
        return 0
    fi
    if [ -z "$OPENCODE_BIN_PATH" ]; then
        echo "pi-lane-launch: opencode is not on PATH (OPENCODE_BIN=${OPENCODE_BIN:-opencode}); the window runs headless" >&2
        return 0
    fi
    local -a fields=()
    mapfile -t fields < <(python3 -c 'import json, sys
d = json.load(open(sys.argv[1]))
for key in ("endpoint", "sessionId", "password"):
    print(d.get(key) or "")' "$record")
    local endpoint="${fields[0]:-}" sid="${fields[1]:-}" pw="${fields[2]:-}"
    if [ -z "$endpoint" ] || [ -z "$sid" ]; then
        echo "pi-lane-launch: server record $record carries no endpoint/session; the window runs headless" >&2
        return 0
    fi
    local target="$TMUX_SESSION:$LANE"
    echo "pi-lane-launch: attaching the lane TUI: $OPENCODE_BIN_PATH attach $endpoint --dir $CWD_DIR -s $sid"
    # A window that already carries a TUI pane (a hand-split or an older
    # attach) gets a clean one, so the window never grows panes per respawn.
    local pane
    for pane in $(tmux list-panes -t "$target" -F '#{pane_index}' 2>/dev/null); do
        [ "$pane" = "0" ] && continue
        tmux kill-pane -t "$target.$pane" 2>/dev/null || true
    done
    # A host crash must stay readable instead of closing the window.
    tmux set-option -p -t "$target.0" remain-on-exit on 2>/dev/null || true
    tmux split-window -v -t "$target" -l 75% -c "$CWD_DIR" \
        -e "OPENCODE_SERVER_PASSWORD=$pw" -- \
        "$OPENCODE_BIN_PATH" attach "$endpoint" --dir "$CWD_DIR" -s "$sid"
    tmux select-pane -t "$target" 2>/dev/null || true
}

# The attach half of the dry run (its endpoint and session exist only at runtime).
describe_attach() {
    [ "$HARNESS" = "opencode" ] || return 0
    [ "$ATTACH" -eq 1 ] || return 0
    printf 'would then attach a TUI pane there: %s attach <endpoint> --dir %s -s <sessionId>' "${OPENCODE_BIN_PATH:-opencode}" "$CWD_DIR"
    printf '   (endpoint, sessionId and password are read from %s/opencode/%s.server.json once the host publishes it)\n' "$MUSTER_STATE" "$LANE"
}

# The lane's own database, for the dry run and the log.
describe_database() {
    [ "$HARNESS" = "opencode" ] || return 0
    printf 'lane database %s (OPENCODE_DB for both panes; the agent-wide database is not used)\n' "$LANE_DB"
}

build_lane_scope

if [ "$RESPAWN" -eq 1 ] && ! window_exists; then
    # Fail closed, never create: the window could not be found in the resolved
    # session, and the usual cause is that the caller's session override is
    # missing (`PI_LANES_TMUX_SESSION`), which would otherwise start a second
    # lane in a session the operator never named (2026-10-08).
    die "--respawn found no window $TMUX_SESSION:$LANE (nothing was created; is PI_LANES_TMUX_SESSION/--session the session the lane runs in?)" 3
fi

if window_exists; then
    if [ "$RESPAWN" -eq 0 ]; then
        die "window $TMUX_SESSION:$LANE already exists and --respawn was not given; nothing was changed (this may be a live lane)" 3
    fi
    if [ "$DRY_RUN" -eq 1 ]; then
        echo "would respawn in $TMUX_SESSION:$LANE: $(describe "$HARNESS")"
        describe_database
        describe_scope
        describe_attach
        describe_registry
        describe_lane_record
        exit 0
    fi
    echo "pi-lane-launch: respawning $TMUX_SESSION:$LANE (replacing the process in that window)"
    migrate_session
    if [ "$HARNESS" = "opencode" ]; then
        # The OpenCode window is host pane + TUI pane, so it is rebuilt rather
        # than respawned in place: the lane keeps its state in Concord, the card,
        # the ledger and the server record, and gains a single fresh pane 0.
        tmux kill-window -t "$TMUX_SESSION:$LANE" 2>/dev/null || true
        start_window "${LANE_ENV_ARGS[@]}" "${KEY_ENV_ARGS[@]}" "${ENV_ARGS[@]}" -- "${LANE_SCOPE[@]}" "${SEAT_SCRUB[@]}" "${CMD[@]}"
        if verify; then register_lane; write_lane_record; record_status=$ATTACH_STATUS; attach_pane; exit "$record_status"; fi
        exit 1
    fi
    tmux respawn-window -k -t "$TMUX_SESSION:$LANE" -c "$CWD_DIR" \
        "${LANE_ENV_ARGS[@]}" "${KEY_ENV_ARGS[@]}" "${ENV_ARGS[@]}" -- "${LANE_SCOPE[@]}" "${SEAT_SCRUB[@]}" "${CMD[@]}"
    verify || exit $?
    register_lane
    write_lane_record
    exit "$ATTACH_STATUS"
fi

if [ "$DRY_RUN" -eq 1 ]; then
    echo "would create $TMUX_SESSION:$LANE: $(describe "$HARNESS")"
    describe_database
    describe_scope
    describe_attach
    describe_registry
    describe_lane_record
    exit 0
fi
echo "pi-lane-launch: creating $TMUX_SESSION:$LANE in $CWD_DIR (harness $HARNESS, session ${SESSION:-<new>}${MODEL:+, model $MODEL})"
migrate_session
start_window "${LANE_ENV_ARGS[@]}" "${KEY_ENV_ARGS[@]}" "${ENV_ARGS[@]}" -- "${LANE_SCOPE[@]}" "${SEAT_SCRUB[@]}" "${CMD[@]}"
# The registry row is written only for a lane that is up: a launch that dies at
# startup leaves no row behind (the next attempt would resume a session that
# never ran, and a resumed session is not briefed).
if [ "$HARNESS" = "opencode" ]; then
    if verify; then register_lane; write_lane_record; record_status=$ATTACH_STATUS; attach_pane; exit "$record_status"; fi
    exit 1
fi
verify || exit $?
register_lane
write_lane_record
exit "$ATTACH_STATUS"
