#!/usr/bin/env bash
# The one orchestrator waiter (efficiency plan WP2, section 1).
#
# It reads only the nine event kinds from the shared events file, from a saved
# offset so nothing is read twice, and the orchestrator's bus inbox (`muster send`
# and the gateway's send_to_orchestrator write there, and so does every lane
# report). After the first event it collects for
# COLLECT_WINDOW_S and then prints every event and exits; while the operator is
# chatting (a typed message in the orchestrator transcript within the last
# CHATTING_WINDOW_S) it prints and exits at once. An inbox message from a sender
# in PRIORITY_SENDERS (the operator, the Grok Bot gateway) also ends the wait at once,
# with every event already collected: someone is waiting for the answer. Lane
# events and lane reports keep batching in the window. With no event for
# NO_EVENT_TIMEOUT_S it prints the line `no events` and exits. It never polls a
# lane and never types anything.
#
# A lane handoff does not wait for the batch (WAITWIN, Henry 2026-10-27 18:52: a
# REVIEW READY at 18:26 woke the seat at 18:46). A REVIEW READY, BLOCKED or
# QUESTION line is the lane handing work back and waiting on the answer, so the
# window shortens to PRIORITY_COLLECT_WINDOW_S from the moment the waiter collects
# that line, whether it opened the window or arrived inside one. Every other
# kind keeps COLLECT_WINDOW_S, and the short window never extends the long one.
# The two windows are one deadline, not a second timer.
#
# Exact duplicate lines within one run are printed once (DS1: `muster report`
# is the one writer, this is the guard). The offset is written only at exit, so
# an interrupted run reads the same events again: delivery is at least once.
#
# Inbox messages are listed through `muster inbox list` and marked read through
# `muster inbox read` (the inbox owner, lib/agent-inbox.ts), only after they were
# printed, so a waiter that dies in the collect window leaves them pending. A
# lane report puts both an event line and an inbox notice; the notice is marked
# read without a second print when the store already holds the same lane, kind,
# branch@sha and a time within INBOX_DUP_WINDOW_S. A notice from a dropped lane
# is marked read unprinted, as its event line would be dropped.
#
# Which store the events come from is `$MUSTER_STATE_DIR/backend.json`, read again
# on every turn (LC9): `files` tails the events file from a byte offset, as before,
# and `ledger` blocks in `muster wait --events`, which prints the same lines and
# keeps its own cursor in CURSOR_FILE. A waiter started before a flip therefore
# follows it without a restart, and never keeps tailing the old store.
#
# "the operator is chatting" has two sources. Once the orchestrator seat is claimed
# (`muster seat show orchestrator --json` reports epoch 1 or more) the holder's
# `lastTypedAt` is the source, whichever harness holds the seat, and a typed
# message within CHATTING_WINDOW_S counts. While the seat was never claimed
# (epoch 0, or no seat verb) the waiter behaves as before the seats existed: it
# reads the orchestrator's own transcript (ORCH_TRANSCRIPT, DS8: the snapshot's
# wake line passes it, the default below is the fallback) through
# orch-last-typed.py. Both go with the cut-over (seats blueprint WP-S5).
#
# A waiter whose credential the bus refuses (`muster inbox list` exits 77: the
# seat moved to another session) prints `SEAT LOST <role> #N` and exits at once
# without reading the offset forward, so the new holder's waiter reads the same
# events. Any other failure of `inbox list` is skipped, as before.
#
# A handoff nobody answered is surfaced again rather than lost (OPENITEMS,
# the operator 2026-10-26): on every wake and before any no-events exit the waiter asks
# the lane directory for the lanes whose latest report is review_ready, blocked or
# question, drops the ones whose record holds an accept or a send-back at or after
# that report, and prints `STALE: <lane> <KIND> <age>` for each one older than
# STALE_AFTER_S. A STALE find ends the wait at once, like a priority sender: the
# item is already late. At most one line per lane per STALE_RATE_S, stamped in
# STALE_STATE_FILE beside the offset (never in the events file), so an unanswered
# item cannot wake the orchestrator every minute.
set -u
export LC_ALL=C   # so ${#chunk} counts bytes, matching the saved byte offset

STATE_DIR=${ORCH_STATE_DIR:-$HOME/.pi/agent/state}
EVENTS=${ORCH_EVENTS:-$STATE_DIR/orchestrator-events.log}
OFFSET_FILE=${ORCH_WAIT_OFFSET:-$STATE_DIR/orch-wait.offset}
MUSTER_STATE_DIR=${PI_MUSTER_STATE_DIR:-$STATE_DIR/muster}   # the switch and the ledger live here (the muster CLI's own default)
CURSOR_FILE=${ORCH_WAIT_CURSOR:-$STATE_DIR/orch-wait.cursor} # `muster wait --events`'s cursor, ledger mode only
# The Pi profile that owns the seat helper. The script moved into the harness
# tree (packages/muster/scripts, OL12-D8), so the profile root is three levels
# up; a released harness tree carries no profile of its own and uses the live
# one.
PROFILE_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
[ -f "$PROFILE_ROOT/scripts/orch-last-typed.py" ] || PROFILE_ROOT="$HOME/.pi/agent"
HELPER=$PROFILE_ROOT/scripts/orch-last-typed.py
TRANSCRIPT=${ORCH_TRANSCRIPT:-$HOME/.claude/projects/-home-operator/352cee8e-a1af-4056-9e39-cfc3aef16c83.jsonl}

POLL_S=${ORCH_POLL_S:-30}
EVENT_WAIT_S=${ORCH_EVENT_WAIT_S:-${ORCH_POLL_S:-30}}        # how long one `muster wait --events` blocks, ledger mode
MUSTER=${ORCH_MUSTER:-muster}
INBOX_AGENT=orchestrator
INBOX_DUP_WINDOW_S=120
COLLECT_WINDOW_S=${ORCH_COLLECT_WINDOW_S:-1200}   # 20 minutes after the first event (R5)
PRIORITY_COLLECT_WINDOW_S=${ORCH_PRIORITY_COLLECT_WINDOW_S:-180}   # 3 minutes from a lane handoff (WAITWIN)
CHATTING_WINDOW_S=${ORCH_CHATTING_WINDOW_S:-600}  # the operator typed within this window = wake at once
PRIORITY_SENDERS=${ORCH_PRIORITY_SENDERS:-operator,grokbot,operator:*}  # comma-separated globs: an inbox message from one wakes at once
NO_EVENT_TIMEOUT_S=${ORCH_NO_EVENT_S:-3300}       # 55 minutes with no event
KINDS='REVIEW READY:|BLOCKED:|QUESTION:|ALREADY DONE:|STALLED:|QUOTA WALL:|CRASHED:|ASLEEP:|STALE:'
PRIORITY_KINDS='REVIEW READY:|BLOCKED:|QUESTION:'   # the kinds that shorten the collect window (WAITWIN)
KINDS_BARE='REVIEW READY|BLOCKED|QUESTION|ALREADY DONE'   # the kinds a lane report writes to both stores
DROP_LANE='scratch|proof|^sn-verify-p$'
STALE_AFTER_S=${ORCH_STALE_AFTER_S:-1800}   # a handoff older than this is stale
STALE_RATE_S=${ORCH_STALE_RATE_S:-3600}     # at most one STALE wake per lane in this window
STALE_SCAN_S=${ORCH_STALE_SCAN_S:-300}      # how often the scan may run while the waiter holds
STALE_STATE_FILE=${ORCH_STALE_STATE:-${OFFSET_FILE%/*}/orch-wait-stale}   # beside the offset, never the events file

# The waiter's pid file (WAITER-GUARD, Henry 11:11): the Claude Stop hook and the muster-tick watchdog
# ask it whether a live waiter is armed before they report a missing one, by the exact pid and never
# `pgrep -f`. The path and the read are the inbox waiter's rule (`packages/muster/inbox-waiter.ts`:
# `<Muster state dir>/waiters/<id>.pid`, here `orchestrator` is the id); this script only writes its own
# pid and removes it on exit, and only while the file still names this process, so a waiter re-armed in
# the meantime keeps its own file.
#
# WGGUARD (VR24-215, Henry 17:44): one seat has one waiter. A second waiter reads the same events from
# the same saved offset and both race it, so a waiter whose pid is still alive refuses to start: it
# prints one line naming the pid and exits 75, and it does not touch the file. Liveness is the exact
# pid, never `pgrep -f`: `kill -0` says the process exists, and the process's own argv must then name
# this script, or the kernel has given the number to something else. A missing file, a dead pid, a
# garbage file and a pid another process now holds are all stale files: they are replaced, and the
# waiter arms normally.
WAITER_PID_FILE=$MUSTER_STATE_DIR/waiters/orchestrator.pid
refuse_live_waiter() {
  local pid cmd
  pid=$(cat "$WAITER_PID_FILE" 2>/dev/null) || return 0
  case $pid in '' | *[!0-9]*) return 0 ;; esac
  [ "$pid" = "$$" ] && return 0
  kill -0 "$pid" 2>/dev/null || return 0
  cmd=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null) || return 0
  [ "${cmd#*orch-wait.sh}" = "$cmd" ] && return 0
  printf 'orch-wait: refusing to arm, pid %s is already a live waiter (%s)\n' "$pid" "${cmd% }" >&2
  exit 75
}
#
# The waker's lock (WAKE1, rev4 finding F2): the waker owns `orch-waker.pid` in the same
# directory and never takes this waiter's slot. While that file names a live waker, a waiter
# would be a second reader of the same events and the same inbox, so the waiter refuses to
# arm: it prints one line naming the waker's pid and exits 75, and it does not touch the
# file. Liveness is the exact pid and the process's own argv, never `pgrep -f`.
WAKER_LOCK_FILE=$MUSTER_STATE_DIR/orch-waker.pid
refuse_live_waker() {
  local pid cmd
  pid=$(awk '{print $1}' "$WAKER_LOCK_FILE" 2>/dev/null) || return 0
  case $pid in '' | *[!0-9]*) return 0 ;; esac
  kill -0 "$pid" 2>/dev/null || return 0
  cmd=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null) || return 0
  case "$cmd" in *muster-orch-waker*) ;; *) return 0 ;; esac
  printf 'orch-wait: refusing to arm, pid %s is already a live waker (%s)\n' "$pid" "${cmd% }" >&2
  exit 75
}
refuse_live_waiter
refuse_live_waker
mkdir -p "${WAITER_PID_FILE%/*}" 2>/dev/null && printf '%s\n' "$$" >"$WAITER_PID_FILE" 2>/dev/null
remove_waiter_pid() {
  [ "$(cat "$WAITER_PID_FILE" 2>/dev/null)" = "$$" ] && rm -f "$WAITER_PID_FILE"
  return 0
}
NEW_EVENTS=$(mktemp)
LEDGER_OUT=$(mktemp)
declare -A SEEN=()
declare -A SEEN_MSG=()
declare -A STALE_MARK=()
TO_MARK=()
PRIORITY=""
PRIORITY_AT=""   # the epoch a priority lane event was collected, empty while none was
STALE_WAKE=""
STALE_SCANNED_AT=""
trap 'rm -f "$NEW_EVENTS" "$LEDGER_OUT"; remove_waiter_pid' EXIT

# The store the switch names: `files` (the events file) or `ledger` (`muster.event`
# entries), or while a flip is in progress the store it is coming from. An absent or
# unreadable switch reads as `files`, which is the switch owner's own default.
backend_mode() {
  local file=$MUSTER_STATE_DIR/backend.json mode from
  [ -f "$file" ] || { echo files; return 0; }
  mode=$(sed -n 's/.*"backend"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' "$file" | head -1)
  if [ "$mode" = frozen ]; then
    from=$(sed -n 's/.*"from"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' "$file" | head -1)
    [ -n "$from" ] && mode=$from
  fi
  case "$mode" in ledger) echo ledger ;; *) echo files ;; esac
}

# Append the lines of one reader to NEW_EVENTS, applying the kinds, the dropped lanes
# and the duplicate guard. Reads stdin, so the events file and `muster wait --events`
# share one filter and neither store can drift from the other's output.
filter_lines() {
  local line body lane
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    body=${line#* }                                  # drop the ISO prefix
    [[ "$body" =~ ^($KINDS) ]] || continue
    lane=${body#*: }; lane=${lane%%[ |]*}
    [[ "$lane" =~ $DROP_LANE ]] && continue
    [ -n "${SEEN[$line]:-}" ] && continue
    SEEN[$line]=1
    if [ -z "$PRIORITY_AT" ] && [[ "$body" =~ ^($PRIORITY_KINDS) ]]; then PRIORITY_AT=$(date +%s); fi
    printf '%s\n' "$line" >>"$NEW_EVENTS"
  done
}

# Read the bytes after READ_POS and append matching complete lines to NEW_EVENTS.
# READ_POS advances to the end of the last complete line, so a half-written line
# is read again on the next pass. (`; printf 'X'` keeps command substitution from
# stripping the trailing newline, which is how the offset is measured.)
read_new_events() {
  [ -f "$EVENTS" ] || return 0
  local size chunk complete
  size=$(wc -c <"$EVENTS")
  [ "$size" -lt "$READ_POS" ] && READ_POS=0   # the file was rotated or truncated
  [ "$size" -eq "$READ_POS" ] && return 0
  chunk=$(tail -c +$((READ_POS + 1)) "$EVENTS"; printf 'X')
  chunk=${chunk%X}
  if [[ "$chunk" == *$'\n' ]]; then
    complete=$chunk
  else
    complete=${chunk%$'\n'*}
    [ "$complete" = "$chunk" ] && complete=""   # a partial last line is not consumed
  fi
  READ_POS=$((READ_POS + ${#complete}))
  filter_lines <<<"$complete"
}

# In ledger mode `muster wait --events` is the reader (LC9): it blocks until an event
# lands, or EVENT_WAIT_S passes, prints the events-file line format and keeps its own
# cursor in CURSOR_FILE. The backend is read again on the next turn, so a flip is
# followed without a restart.
read_new_events_ledger() {
  : >"$LEDGER_OUT"
  timeout $((EVENT_WAIT_S + 30)) "$MUSTER" wait --events --cursor-file "$CURSOR_FILE" --timeout "$EVENT_WAIT_S" >"$LEDGER_OUT" 2>/dev/null || true
  filter_lines <"$LEDGER_OUT"
}

# True when one line is the event line a lane report's inbox notice stands for: the
# kind, the lane, the branch@sha token (REVIEW READY) and a time within
# INBOX_DUP_WINDOW_S of the notice. An `INBOX:` line is never an event line.
same_report_line() {
  local line=$1 kind=$2 from=$3 token=$4 at_s=$5 body stamp
  [ -n "$line" ] || return 1
  body=${line#* }
  [[ "$body" == "$kind: $from "* ]] || return 1
  [ -n "$token" ] && [[ "$line" != *"$token"* ]] && return 1
  stamp=$(date -d "${line%% *}" +%s 2>/dev/null) || return 1
  [ $(( stamp > at_s ? stamp - at_s : at_s - stamp )) -le "$INBOX_DUP_WINDOW_S" ]
}

# True when the store already holds the line a lane report's inbox notice stands for:
# the events file is the durable record in files mode, and in ledger mode the line was
# collected by this run's reader instead (the file holds nothing then).
report_in_events() {
  local text=$1 from=$2 at=$3 kind token line at_s
  kind=${text%%:*}
  [[ "$kind" =~ ^($KINDS_BARE)$ ]] || return 1
  token=""
  if [ "$kind" = "REVIEW READY" ]; then
    token=${text#*: }; token=${token%% *}
    [[ "$token" == *@* ]] || token=""
  fi
  at_s=$(date -d "$at" +%s 2>/dev/null) || return 1
  if [ -f "$EVENTS" ]; then
    while IFS= read -r line; do
      same_report_line "$line" "$kind" "$from" "$token" "$at_s" && return 0
    done < <(command grep -F -- "$kind: $from " "$EVENTS")
  fi
  while IFS= read -r line; do
    same_report_line "$line" "$kind" "$from" "$token" "$at_s" && return 0
  done <<<"${collected}$(cat "$NEW_EVENTS" 2>/dev/null)"
  return 1
}

# The clock the stale rules read. ORCH_STALE_NOW injects it (epoch seconds), so a
# test measures 31 minutes without waiting for one.
stale_now() {
  if [ -n "${ORCH_STALE_NOW:-}" ]; then printf '%s' "$ORCH_STALE_NOW"; else date +%s; fi
}

# How long a handoff has waited, as a person reads it: `31m`, `2h00m`.
stale_age() {
  local s=$1
  if [ "$s" -lt 3600 ]; then printf '%sm' $((s / 60)); else printf '%dh%02dm' $((s / 3600)) $(((s % 3600) / 60)); fi
}

# One line per lane whose latest report is a handoff: <lane>\t<KIND>\t<report epoch ms>\t<age s>.
# `muster lanes --json` is the directory's one read and merges the lane records, so a
# parked lane with no card is still seen; the record itself answers the accept question.
# A row the directory already reports as closed, merged or abandoned is dropped here,
# before any per-lane call: on 2026-10-26 the live directory held 137 such rows and one
# `lane-record show` costs about 1.2 s, so reading them would stall every scan for minutes.
stale_candidates() {
  timeout 30 "$MUSTER" lanes --json 2>/dev/null | python3 -c '
import json, sys
now = float(sys.argv[1])
kinds = {"review_ready": "REVIEW READY", "blocked": "BLOCKED", "question": "QUESTION"}
settled = ("merged", "abandoned", "closed")
try:
    rows = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
if not isinstance(rows, list):
    raise SystemExit(0)
for row in rows:
    if not isinstance(row, dict):
        continue
    report = row.get("lastReport")
    if not isinstance(report, dict):
        continue
    kind = kinds.get(report.get("kind"))
    at = report.get("at")
    lane = row.get("laneId")
    if kind is None or not isinstance(at, (int, float)) or not isinstance(lane, str) or lane == "":
        continue
    if row.get("phase") in settled or row.get("terminal"):
        continue
    print("%s\t%s\t%d\t%d" % (lane, kind, int(at), int(now - at / 1000.0)))
' "$1"
}

# True when the lane record on stdin still holds its last report unanswered: an accept
# or a send-back at or after it closes the item, and so does a terminal phase.
report_unanswered() {
  python3 -c '
import json, sys
at = float(sys.argv[1])
try:
    record = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
if not isinstance(record, dict):
    raise SystemExit(1)
if record.get("terminal") or record.get("phase") in ("merged", "abandoned", "closed"):
    raise SystemExit(1)
for handoff in record.get("handoffs") or []:
    if not isinstance(handoff, dict):
        continue
    if handoff.get("verdict") in ("accepted", "sent-back") and float(handoff.get("at") or 0) >= at:
        raise SystemExit(1)
raise SystemExit(0)
' "$1"
}

# The lanes surfaced in the last STALE_RATE_S, one `<lane>\t<epoch>` line each. It sits
# beside the offset and never in the events file: it is this waiter's own memory, not an event.
read_stale_marks() {
  [ -f "$STALE_STATE_FILE" ] || return 0
  local lane at
  while IFS=$'\t' read -r lane at; do
    [ -n "$lane" ] || continue
    [[ "$at" =~ ^[0-9]+$ ]] || continue
    STALE_MARK[$lane]=$at
  done <"$STALE_STATE_FILE"
  return 0
}

# Write the stamps at exit, beside the offset (at-least-once: a waiter killed before it
# printed leaves none), keeping only the lanes inside the rate-limit window.
write_stale_marks() {
  local now=$1 lane at
  [ -n "$STALE_WAKE" ] || return 0
  : >"$STALE_STATE_FILE.tmp"
  for lane in "${!STALE_MARK[@]}"; do
    at=${STALE_MARK[$lane]}
    [ $((now - at)) -lt "$STALE_RATE_S" ] && printf '%s\t%s\n' "$lane" "$at" >>"$STALE_STATE_FILE.tmp"
  done
  mv "$STALE_STATE_FILE.tmp" "$STALE_STATE_FILE"
}

# Append one `STALE:` line per unanswered handoff older than STALE_AFTER_S to NEW_EVENTS.
# Runs at most once per STALE_SCAN_S, and again before an exit when `force` is given.
read_stale_reviews() {
  local force=${1:-} now lane kind at age record
  now=$(stale_now)
  [ "$STALE_SCANNED_AT" = "$now" ] && return 0
  if [ -z "$force" ] && [ -n "$STALE_SCANNED_AT" ] && [ $((now - STALE_SCANNED_AT)) -lt "$STALE_SCAN_S" ]; then return 0; fi
  STALE_SCANNED_AT=$now
  while IFS=$'\t' read -r lane kind at age; do
    [ -n "$lane" ] || continue
    [[ "$lane" =~ $DROP_LANE ]] && continue
    [ "$age" -gt "$STALE_AFTER_S" ] || continue
    if [ -n "${STALE_MARK[$lane]:-}" ] && [ $((now - STALE_MARK[$lane])) -lt "$STALE_RATE_S" ]; then continue; fi
    record=$(timeout 30 "$MUSTER" lane-record show "$lane" --json 2>/dev/null) || continue
    printf '%s' "$record" | report_unanswered "$at" || continue
    STALE_MARK[$lane]=$now
    STALE_WAKE=1
    printf 'STALE: %s %s %s\n' "$lane" "$kind" "$(stale_age "$age")" >>"$NEW_EVENTS"
  done < <(stale_candidates "$now")
}

# True when the inbox sender matches one of the PRIORITY_SENDERS globs.
priority_sender() {
  local from=$1 pattern
  local -a patterns
  IFS=, read -ra patterns <<<"$PRIORITY_SENDERS"
  for pattern in "${patterns[@]}"; do
    [ -n "$pattern" ] && [[ "$from" == $pattern ]] && return 0
  done
  return 1
}

# List the pending orchestrator inbox messages and queue one line per new message
# in NEW_EVENTS. Listing never moves a message: ids are queued in TO_MARK and
# marked read by mark_read_messages once the lines were printed.
read_new_inbox() {
  local listing id at from source rpath text when
  local rc
  listing=$(timeout 60 "$MUSTER" inbox list "$INBOX_AGENT" 2>/dev/null); rc=$?
  [ "$rc" -eq 77 ] && seat_lost   # the bus refused the seat credential (SEAT_REFUSED_EXIT)
  [ "$rc" -eq 0 ] || return 0
  while IFS=$'\t' read -r id at from source rpath text; do
    [ -z "$id" ] && continue
    [ -n "${SEEN_MSG[$id]:-}" ] && continue
    SEEN_MSG[$id]=1
    if [[ "$from" =~ $DROP_LANE ]]; then TO_MARK+=("$id"); continue; fi
    if [ "$source" = report ] && report_in_events "$text" "$from" "$at"; then TO_MARK+=("$id"); continue; fi
    when=$(date -d "$at" -Iseconds 2>/dev/null || echo "$at")
    printf '%s INBOX: %s | %s | %s\n' "$when" "$from" "$text" "$rpath" >>"$NEW_EVENTS"
    priority_sender "$from" && PRIORITY=1
    TO_MARK+=("$id")
  done <<<"$listing"
}

# Move the messages whose lines were printed (and the silently dropped ones) into read/.
mark_read_messages() {
  [ "${#TO_MARK[@]}" -gt 0 ] || return 0
  timeout 60 "$MUSTER" inbox read "$INBOX_AGENT" "${TO_MARK[@]}" >/dev/null 2>&1 || true
}

# The seat's state as "<epoch> <lastTypedAt in epoch seconds, or ->". Fails when `muster seat` is unavailable.
seat_read() {
  local json
  json=$(timeout 60 "$MUSTER" seat show orchestrator --json 2>/dev/null) || return 1
  printf '%s' "$json" | python3 -c '
import json, sys
from datetime import datetime
d = json.load(sys.stdin)
typed = ((d.get("holder") or {}).get("lastTypedAt"))
stamp = "-"
if typed:
    stamp = str(int(datetime.fromisoformat(typed.replace("Z", "+00:00")).timestamp()))
print(d["epoch"], stamp)
' 2>/dev/null
}

# The credential was refused: this waiter belongs to a session that no longer holds the seat.
seat_lost() {
  local token=${MUSTER_SEAT_TOKEN:-} n seat epoch
  n=${token#s}; n=${n%%.*}
  if ! [[ "$n" =~ ^[0-9]+$ ]]; then
    n="?"
    if seat=$(seat_read); then read -r epoch _ <<<"$seat"; [[ "${epoch:-}" =~ ^[0-9]+$ ]] && n=$epoch; fi
  fi
  printf 'SEAT LOST orchestrator #%s\n' "$n"
  exit 0
}

# True while the operator typed into the orchestrator session within CHATTING_WINDOW_S.
chatting() {
  local last seat epoch typed
  if seat=$(seat_read); then
    read -r epoch typed <<<"$seat"
    if [[ "${epoch:-}" =~ ^[0-9]+$ ]] && [ "$epoch" -ge 1 ]; then
      [ "${typed:--}" != "-" ] || return 1
      [ $(($1 - typed)) -lt "$CHATTING_WINDOW_S" ]
      return
    fi
  fi
  last=$(python3 "$HELPER" "$TRANSCRIPT" 2>/dev/null) || return 1
  [ -n "$last" ] || return 1
  [ $(($1 - last)) -le "$CHATTING_WINDOW_S" ]
}

READ_POS=$(cat "$OFFSET_FILE" 2>/dev/null || echo 0)
[[ "$READ_POS" =~ ^[0-9]+$ ]] || READ_POS=0
read_stale_marks
# The epoch the collect window ends: COLLECT_WINDOW_S after the first event, pulled in
# to PRIORITY_COLLECT_WINDOW_S after the first priority lane event, whichever is sooner.
# A priority line that arrives late in an open long window shortens the wait; it never
# moves the deadline out.
collect_deadline() {
  local deadline=$((first + COLLECT_WINDOW_S)) priority_deadline
  if [ -n "$PRIORITY_AT" ]; then
    priority_deadline=$((PRIORITY_AT + PRIORITY_COLLECT_WINDOW_S))
    [ "$priority_deadline" -lt "$deadline" ] && deadline=$priority_deadline
  fi
  printf '%s' "$deadline"
}

start=$(date +%s)
first=""
collected=""

while :; do
  if [ "$(backend_mode)" = ledger ]; then
    read_new_events_ledger
  else
    read_new_events
  fi
  read_new_inbox
  read_stale_reviews
  if [ -s "$NEW_EVENTS" ]; then
    collected="${collected}$(cat "$NEW_EVENTS")"$'\n'
    : >"$NEW_EVENTS"
    [ -z "$first" ] && first=$(date +%s)
  fi
  now=$(date +%s)
  # Before a no-events exit, look for a stale handoff one last time: a report nobody
  # answered is a wake even when nothing new arrived.
  if [ -z "$first" ] && [ $((now - start)) -ge "$NO_EVENT_TIMEOUT_S" ]; then
    read_stale_reviews force
    if [ -s "$NEW_EVENTS" ]; then
      collected="${collected}$(cat "$NEW_EVENTS")"$'\n'
      : >"$NEW_EVENTS"
      first=$(date +%s)
      now=$first
    fi
  fi
  if [ -n "$first" ]; then
    if [ -n "$PRIORITY" ] || [ -n "$STALE_WAKE" ] || chatting "$now" || [ "$now" -ge "$(collect_deadline)" ]; then
      printf '%s' "$collected"
      mark_read_messages
      printf '%s' "$READ_POS" >"$OFFSET_FILE"
      write_stale_marks "$(stale_now)"
      exit 0
    fi
  elif [ $((now - start)) -ge "$NO_EVENT_TIMEOUT_S" ]; then
    printf 'no events\n'
    mark_read_messages
    printf '%s' "$READ_POS" >"$OFFSET_FILE"
    write_stale_marks "$(stale_now)"
    exit 0
  fi
  sleep "$POLL_S"
done
