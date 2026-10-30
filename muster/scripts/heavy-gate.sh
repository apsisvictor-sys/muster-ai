#!/usr/bin/env bash
# Heavy-launch gate (Henry priority 1, 2026-10-19, part c): refuse a heavy start while the machine has
# no room for it. The 2026-10-19 00:28 stall began when lanes, installs and a graph refresh started during
# the 7G dev-server window, so one owner answers "may a heavy job start now" for every caller.
#
#   heavy-gate.sh <kind> [size-mib]
#                             kind is a label for the log line (lane-launch, graph-refresh, ...);
#                             size-mib is the caller's declared job size in MiB, overriding the table;
#                             a test-run caller names its project in HEAVY_GATE_PROJECT (the ledger's
#                             project name: crm-app, agent, pi-media-platform) and gets that
#                             project's table size (VR24-44)
#   heavy-gate.sh --status
#                             the gate's own read-only view of this machine (command-center WP2):
#                             prints one JSON line {"wouldAdmit":...,"reason":...,"psi":...,
#                             "availableMb":...,"sliceUsedPct":...,"paused":...,"devServerWindow":...}
#                             — wouldAdmit says whether a new 0 MiB heavy job would pass right now,
#                             and reason carries the same words a real refusal of the same inputs
#                             prints, because both come from the one check functions below. psi is
#                             memory avg10 (null when unreadable), availableMb is MemAvailable
#                             (null when unreadable), sliceUsedPct is pi.slice's share of its
#                             MemoryHigh (null when unreadable or "max"), paused says whether the
#                             pause flag exists, devServerWindow holds the active be-dev-server
#                             scopes ("" when none). Always exits 0: it admits nothing and records
#                             nothing (no log line, no lane-launch slot, no refusal marker, no event).
#                             This is the color the command center reads; WP1 owns the page itself.
#
# Exit 42 on a refused test-run (its caller waits: the guarded runner burns down its lock-free poll),
# exit 75 on a refusal of any other kind (lane-launch and graph-refresh defer on 75, as since the
# first gate; graph-refresh maps the refusal to "still due" and the tick retries). The reason is on
# stderr either way. It refuses when
#   0. state/heavy-gate.paused exists (the pause flag, command-center WP3, written by the operator with
#      scripts/heavy-gate-pause.sh as "<who> <when>"): every new heavy job is refused through the
#      usual refuse path with the reason "paused by <who> at <when>"; running jobs are untouched.
#      The check is first on purpose: the pause precedes PI_HEAVY_GATE_OVERRIDE, so the operator's stop
#      is not bypassable by an override an earlier caller's environment already set.
#   1. a BE dev server scope (be-dev-server-*.scope) is active: that is the dev-server window,
#   2. system memory pressure (some avg10) is at or above HEAVY_GATE_PSI (default 15), or
#   3. pi.slice already holds 75% or more of its MemoryHigh,
#   4. MemAvailable is under MIN_AVAILABLE_MB (default 6144, the S2 session reserve) plus the
#      job's measured size from the table below (VR21-42 S1: MemAvailable minus the 6144 MiB
#      reserve must cover the declared size), or
#   5. (lane-launch only) another lane launch passed this gate less than HEAVY_GATE_SPACING seconds ago (default 60, VR24-210; 300 until 2026-10-26):
#      one heavy start at a time, so a start's own load shows in the pressure before the next is judged
#      (the operator 2026-10-21, O2: three lanes plus a dev server and a typecheck took memory pressure to 92%).
# PI_HEAVY_GATE_OVERRIDE=1 skips the gate and logs one line, for an explicit decision by the caller's owner.
# Test knobs: HEAVY_GATE_UNITS_CMD (prints active scope names), HEAVY_GATE_PSI_FILE, HEAVY_GATE_SLICE_DIR,
# HEAVY_GATE_MEMINFO_FILE, HEAVY_GATE_LAST, HEAVY_GATE_PAUSED_FILE.
#
# Job sizes (VR21-42 S1) live in this ONE table at the gate, in MiB, never guessed. A job's size is
# its caller's declared argument, else the table entry for its kind, else the largest measured peak
# of all kinds for an unmeasured kind. The table is filled from the guarded runner's "Memory peak"
# log lines of real runs on this machine (the state rehersal logs hold wrapper-size lines only; the
# 2026-10-06 orchestrator handoff explains that artifact):
#   test-run 4600  largest measured 4.6G in /tmp/be-lane-kaisdup-7053f1d5f-20261021-204455-1196611.log
#                  (2026-10-21; other runs logged 4.5G twice: evalleak and regpdf, same day)
# A test-run is sized by its project (VR24-44, 2026-10-25): crm-app 4600 (the figure above),
# agent 1150 (the one measured peak, 738 MiB in the wfix run, plus 50 percent rounded up to 50) and
# pi-media-platform 650 (433 MiB in the rm3 run, same rule). Every other project, and a run with no
# project named (HEAVY_GATE_PROJECT unset: the guarded runner leaves it unset for a tsc, tsgo or
# typecheck command), keeps 4600 until measured. The project names are the ledger's own
# (test-ledger-append.mjs projectName: the checkout's git root folder), so pi-media-platform is the
# folder of that name in ~/projects and a BE worktree still answers crm-app through the
# shared common dir.
# An entry is provisional until its project has 20 measured runs: agent's 1150 rests on one run
# (738 MiB, the wfix run) plus 50 percent rounded up to the next 50, so it is a thin figure rather
# than a measured range.
# Updating the table is a MANUAL step, the only way it changes: once a project has 20 measured runs in
# state/tests/runs.jsonl, its largest peakMiB replaces the entry, and whoever updates reads the ledger
# and edits the table below by hand. Nothing reads the ledger automatically, and this gate must not
# be changed to: a size that moves on its own would move the admission bar without a decision.
# A sustained refusal becomes a muster event (VR21-42 S5): once a kind has been refused for at least
# HEAVY_GATE_REFUSAL_EVENT_SECONDS (default 600), one event line (GATE REFUSAL: unit,size,psi,reason)
# is appended to orchestrator-events.log, once per 10-minute window of the episode, per kind.
set -u

# --status needs no kind and no command-line answer: run it before the kind is read, so the
# status view can never be mistaken for an admission request (WP2).
if [ "${1:-}" = "--status" ]; then
	mode="status"
	shift
else
	mode="gate"
fi
kind="${1:-heavy}"
declared="${2:-}"
PSI_LIMIT="${HEAVY_GATE_PSI:-15}"
PSI_FILE="${HEAVY_GATE_PSI_FILE:-/proc/pressure/memory}"
SLICE_DIR="${HEAVY_GATE_SLICE_DIR:-/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/pi.slice}"
LOG="${HEAVY_GATE_LOG:-$HOME/.pi/agent/state/heavy-gate.log}"
MEMINFO_FILE="${HEAVY_GATE_MEMINFO_FILE:-/proc/meminfo}"
MIN_AVAILABLE_MB="${HEAVY_GATE_MIN_AVAILABLE_MB:-6144}"
SPACING="${HEAVY_GATE_SPACING:-60}"
LAST="${HEAVY_GATE_LAST:-$HOME/.pi/agent/state/heavy-gate.last-lane-launch}"
EVENTS_LOG="${HEAVY_GATE_EVENTS_LOG:-$HOME/.pi/agent/state/orchestrator-events.log}"
REFUSED_STATE_DIR="${HEAVY_GATE_REFUSED_STATE_DIR:-$HOME/.pi/agent/state}"
REFUSAL_EVENT_SECONDS="${HEAVY_GATE_REFUSAL_EVENT_SECONDS:-600}"
PAUSED_FILE="${HEAVY_GATE_PAUSED_FILE:-$HOME/.pi/agent/state/heavy-gate.paused}"

# table_size — the one job-size table (VR21-42 S1), MiB, never guessed: filled from measured peaks on
# this machine (2026-10-21). test-run 4600 from the guarded runner's "Memory peak" lines: largest
# measured run 4.6G in /tmp/be-lane-kaisdup-7053f1d5f-20261021-204455-1196611.log, 4.5G twice the same
# day (evalleak, regpdf), 26 more /tmp/be-lane-*.log runs between 1.0G and 4.5G. lane-launch 1498 from
# the live lane unit scopes' memory.peak, largest lane-stagesel-1792613403.scope 1571434496 B read
# read-only (lane-adm2 1285586944 B, lane-adm1 1043652608 B; swap peaks 0). graph-refresh 510 from one
# real refresh of the live pi-agent checkout in a throwaway scope (lab-gr-adm1-2255d.scope
# memory.peak 535035904 B, peak read inside the scope before it ended). A kind without a table entry
# lands on the largest measured peak of all kinds.
# test_run_size — a test run's size by HEAVY_GATE_PROJECT (VR24-44); every entry here is provisional
# (one measured run, not a range) until the manual update the header describes.
test_run_size() {
	case "${HEAVY_GATE_PROJECT:-}" in
		agent) echo 1150 ;;           # provisional: one run, 738 MiB (wfix) plus 50 percent, rounded up to 50
		pi-media-platform) echo 650 ;; # provisional: one run, 433 MiB (rm3), the same rule
		*) echo 4600 ;;
	esac
}

table_size() {
	case "$kind" in
		test-run) test_run_size ;;
		lane-launch) echo 1498 ;;
		graph-refresh) echo 510 ;;
		*) echo 4600 ;;
	esac
}

# size_mb — the job size in MiB (VR21-42 S1), resolved before any refusal so the log and event carry
# it: a declared argument wins, then this table entry for the kind, then the largest measured peak
# (an unmeasured kind is admitted under the biggest measured job, not under a guess).
declared_bad=""
case "$declared" in
	"") size_mb="$(table_size)";;
	"0") declared_bad="$declared"; size_mb="$(table_size)";;
	*[!0-9]*) declared_bad="$declared"; size_mb="$(table_size)";;
	*) size_mb="$declared";;
esac

note() {
	mkdir -p "$(dirname "$LOG")" 2>/dev/null
	printf '%s %s\n' "$(date -Is)" "$1" >>"$LOG" 2>/dev/null
}

# ---- the one check functions (WP2): each echoes the refusal reason when its rule would refuse,
# "" otherwise. The gate path refuses on the first non-empty one in rule order; --status reports
# the first one verbatim, so a status reason and a refusal reason are the same words for the same
# inputs. None of them state, touch or record anything.

# pause_reason — rule 0 (WP3): the pause flag "<who> <when>"; its words decide the refusal reason.
pause_reason() {
	[ -f "$PAUSED_FILE" ] || return 0
	local who when
	read -r who when _ <"$PAUSED_FILE" 2>/dev/null
	printf 'paused by %s at %s' "${who:-the operator}" "${when:-an unknown time}"
}

# dev_servers — the active be-dev-server scopes, space-joined; "" when the window is closed.
dev_servers() {
	if [ -n "${HEAVY_GATE_UNITS_CMD:-}" ]; then
		sh -c "$HEAVY_GATE_UNITS_CMD" 2>/dev/null | head -3 | tr '\n' ' '
	else
		systemctl --user list-units 'be-dev-server-*.scope' --state=active --no-legend --plain 2>/dev/null | awk '{print $1}' | head -3 | tr '\n' ' '
	fi
}

# dev_window_reason — rule 1.
dev_window_reason() {
	local servers
	servers="$(dev_servers)"
	[ -z "${servers// /}" ] || printf 'dev-server window open (%s)' "${servers% }"
}

# psi_value — the machine's memory avg10, "" when unreadable.
psi_value() {
	awk '/^some/{split($2,a,"=");print a[2]}' "$PSI_FILE" 2>/dev/null
}

# psi_reason — rule 2.
psi_reason() {
	local psi
	psi="$(psi_value)"
	if [ -n "$psi" ] && awk -v p="$psi" -v l="$PSI_LIMIT" 'BEGIN{exit !(p+0 >= l+0)}'; then
		printf 'memory pressure avg10 %s at or above %s' "$psi" "$PSI_LIMIT"
	fi
}

# slice_used_pct — pi.slice's share of its MemoryHigh as a whole percent, "" when unreadable
# or the high mark is "max" (rule report for --status).
slice_used_pct() {
	[ -r "$SLICE_DIR/memory.current" ] && [ -r "$SLICE_DIR/memory.high" ] || return 0
	local current high
	current="$(cat "$SLICE_DIR/memory.current")"
	high="$(cat "$SLICE_DIR/memory.high")"
	[ "$high" != "max" ] || return 0
	printf '%d' $((current * 100 / high))
}

# slice_reason — rule 3.
slice_reason() {
	[ -r "$SLICE_DIR/memory.current" ] && [ -r "$SLICE_DIR/memory.high" ] || return 0
	local current high
	current="$(cat "$SLICE_DIR/memory.current")"
	high="$(cat "$SLICE_DIR/memory.high")"
	[ "$high" != "max" ] || return 0
	if [ "$((current * 100))" -ge "$((high * 75))" ]; then
		printf 'pi.slice holds %d MiB, 75%% of its %d MiB high mark or more' $((current / 1048576)) $((high / 1048576))
	fi
}

# mem_available_mb — MemAvailable in MiB, "" when unreadable.
mem_available_mb() {
	awk '/^MemAvailable:/{printf "%d", $2/1024}' "$MEMINFO_FILE" 2>/dev/null
}

# memory_reason — rule 4 with the caller's resolved size.
memory_reason() {
	local available
	available="$(mem_available_mb)"
	if [ -n "$available" ] && [ "$available" -lt "$((MIN_AVAILABLE_MB + $1))" ]; then
		printf 'only %d MiB of memory is available, under %d for the %d MiB job plus the %d MiB session reserve' \
			"$available" $((MIN_AVAILABLE_MB + $1)) "$1" "$MIN_AVAILABLE_MB"
	fi
}

# reserve_floor_reason — the override's own floor (the override path omits the job size).
reserve_floor_reason() {
	local available
	available="$(mem_available_mb)"
	if [ -n "$available" ] && [ "$available" -lt "$MIN_AVAILABLE_MB" ]; then
		printf 'only %d MiB of memory is available, under %d' "$available" "$MIN_AVAILABLE_MB"
	fi
}

# spacing_reason — rule 5 for lane-launch, read-only: it reads $LAST and never records,
# because --status reuses this view without admitting (no 5-minute slot is written here).
spacing_reason() {
	[ -f "$LAST" ] || return 0
	local age
	age="$(( $(date +%s) - $(stat -c %Y "$LAST" 2>/dev/null || echo 0) ))"
	[ "$age" -ge "$SPACING" ] || printf 'another lane launch passed the gate %ds ago (spacing %ds)' "$age" "$SPACING"
}

# record_lane_launch — rule 5's write side, the gate path only, after a clean read.
record_lane_launch() {
	mkdir -p "$(dirname "$LAST")" 2>/dev/null
	: >"$LAST" 2>/dev/null
}

# first_reason — the first non-empty reason of its checks, in rule order.
first_reason() {
	local r
	for r in "$@"; do
		[ -n "$r" ] && { printf '%s' "$r"; return 0; }
	done
}

# --status_line (WP2): one JSON line, exit 0, nothing recorded. The rules are the gate's own
# check functions; the pause is first there too, then the override's answer, then the normal
# rule order with a 0 MiB job.
status_line() {
	local reason="" paused=false servers psi pct
	servers="$(dev_servers)"
	psi="$(psi_value)"
	pct="$(slice_used_pct)"
	reason="$(pause_reason)"
	if [ -n "$reason" ]; then
		paused=true
	elif [ "${PI_HEAVY_GATE_OVERRIDE:-0}" = "1" ]; then
		reason="$(reserve_floor_reason)"
	else
		reason="$(first_reason "$(dev_window_reason)" "$(psi_reason)" "$(slice_reason)" "$(memory_reason 0)")"
	fi
	local jpsi="null" javail="null" jpct="null" avail
	[ -n "$psi" ] && jpsi="$psi"
	[ -n "$pct" ] && jpct="$pct"
	avail="$(mem_available_mb)"
	[ -n "$avail" ] && javail="$avail"
	printf '{"wouldAdmit":%s,"reason":%s,"psi":%s,"availableMb":%s,"sliceUsedPct":%s,"paused":%s,"devServerWindow":%s}\n' \
		"$([ -z "$reason" ] && echo true || echo false)" \
		"$(json_str "$reason")" \
		"$jpsi" "$javail" "$jpct" \
		"$paused" \
		"$(json_str "${servers% }")"
}

# json_str — a minimal JSON string: the refusal reasons carry no backslashes or quotes by
# construction, but the field is a public interface, so escape them anyway.
json_str() {
	printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
}

if [ "$mode" = "status" ]; then
	status_line
	exit 0
fi

# refuse_event <reason> — the muster event for a refusal episode older than REFUSAL_EVENT_SECONDS
# (VR21-42 S5), best effort: a failed append never decides admission. The marker file holds the
# episode's first refusal as an epoch; emitting and resetting lets one event per 10 minutes of a
# continuing refusal through, per kind.
refuse_event() {
	local reason="$1" marker first now age
	marker="$REFUSED_STATE_DIR/heavy-gate.refused.$kind"
	mkdir -p "$REFUSED_STATE_DIR" 2>/dev/null
	if [ -f "$marker" ]; then
		first="$(cat "$marker" 2>/dev/null)"
		now="$(date +%s)"
		age=$(( now - ${first:-$now} ))
		if [ "$age" -ge "$REFUSAL_EVENT_SECONDS" ]; then
			psi_now="$(awk '/^some/{split($2,a,"=");print a[2]}' "$PSI_FILE" 2>/dev/null)"
			{ printf '%s GATE REFUSAL: unit=%s size=%sMiB psi=%s reason="%s"\n' \
				"$(date -Iseconds)" "$kind" "$size_mb" "${psi_now:-none}" "$reason" >>"$EVENTS_LOG"; } 2>/dev/null || true
			printf '%s\n' "$now" >"$marker" 2>/dev/null
		fi
	else
		printf '%s\n' "$(date +%s)" >"$marker" 2>/dev/null
	fi
}

refuse() {
	note "refused kind=$kind size=${size_mb:-?}MiB: $1"
	refuse_event "$1"
	echo "heavy-gate: $kind refused: $1 (set PI_HEAVY_GATE_OVERRIDE=1 only on an explicit decision)" >&2
	# The wait-out exit follows the caller's contract: a guarded run waits with 42 (run-guarded's
	# own refusal code); lane-launch and graph-refresh defer on 75 as since the first gate, because
	# pi-lane-launch.sh propagates it and graph-refresh maps every refusal to "still due".
	if [ "$kind" = "test-run" ]; then
		exit 42
	fi
	exit 75
}

# ---- rules 0..5, in order. The pause check is first (WP3): the operator's stop is not bypassable,
# even by the override an earlier caller's environment already set. The declared-size header
# stays before it, as since the sizes lane.
if [ -n "$declared_bad" ]; then
	refuse "declared size $declared_bad is not a whole number of MiB (the job keeps its table size ${size_mb} MiB)"
fi

paused_reason="$(pause_reason)"
[ -z "$paused_reason" ] || refuse "$paused_reason"

if [ "${PI_HEAVY_GATE_OVERRIDE:-0}" = "1" ]; then
	note "override kind=$kind"
	overridden_reason="$(reserve_floor_reason)"
	[ -z "$overridden_reason" ] || refuse "$overridden_reason"
	if [ "$kind" = "lane-launch" ]; then
		spaced_reason="$(spacing_reason)"
		[ -z "$spaced_reason" ] || refuse "$spaced_reason"
		record_lane_launch
	fi
	exit 0
fi

reason="$(first_reason "$(dev_window_reason)" "$(psi_reason)" "$(slice_reason)" "$(memory_reason "$size_mb")")"
if [ "$kind" = "lane-launch" ] && [ -z "$reason" ]; then
	reason="$(spacing_reason)"
fi
if [ "$kind" = "lane-launch" ] && [ -z "$reason" ]; then
	record_lane_launch
fi
[ -z "$reason" ] || refuse "$reason"

available_mb="$(mem_available_mb)"
need_mb=$(( MIN_AVAILABLE_MB + size_mb ))
rm -f "$REFUSED_STATE_DIR/heavy-gate.refused.$kind" 2>/dev/null
note "admitted kind=$kind size=${size_mb}MiB available=${available_mb:-unknown}MiB need=${need_mb}MiB"
exit 0
