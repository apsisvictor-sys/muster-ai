#!/usr/bin/env bash
# The repository's one test entry (OL12-D4, RD7).
#
#   ./test.sh [test file...]      # no arguments: every test file in the tree
#
# On this machine the tests run through Pi's one guarded entry point, so no run
# skips the memory, unit and concurrency guard. The guard preloads the *calling
# checkout's* Pi-profile setup (\`extensions/tests/harness-test-setup.ts\`) — the file
# that configures the \`agentDir\` port before any test file loads — and this
# repository has no Pi profile. The guard is therefore invoked from the Pi
# checkout it lives in, with this repository's files as absolute paths: the port
# is configured the way every other run on this machine sees it, and the code,
# the relative imports and the bare imports are this repository's.
#
# CI has no Pi profile and no guard, so the same files run with node's own
# runner and this tree's \`test-setup.ts\`, which points \`agentDir\` at a scratch
# folder: a run there reads nothing from a profile and writes nothing into one.
#
# \`scripts/ci-test-exclusions.txt\` lists the tests that cannot run without Pi's
# profile, one reason per test; its header says how the list is applied.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="${HARNESS_TEST_GUARD:-/home/operator/.pi/agent/extensions/tests/run-guarded.sh}"
PI_AGENT="${PI_AGENT_HOME:-/home/operator/.pi/agent}"

cd "$ROOT"
if [ "$#" -gt 0 ]; then
	FILES=("$@")
else
	FILES=()
	# node_modules is pruned: its packages ship their own test files, and they are not ours.
	while IFS= read -r file; do FILES+=("${file#"$ROOT"/}"); done < <(find core routing toolbelt muster -name node_modules -prune -o -type f \( -name '*.test.ts' -o -name '*.test.mts' \) -print | sort)
	if [ "${#FILES[@]}" -eq 0 ]; then
		echo "muster/test.sh: no test files" >&2
		exit 46
	fi
fi

# The tests that need Pi's profile, which this repository does not carry: one
# entry per test, keyed by path and test name, with the reason it cannot run here.
#
# A file whose import reads the profile throws before any test exists, so no test
# name can skip it: its entry names the file with `-` in place of the pattern, and
# the run leaves the file out. Nothing is hidden by that, because a file that does
# not load reports no result for any of its tests.
EXCLUSIONS="${TEST_EXCLUSIONS:-$ROOT/scripts/ci-test-exclusions.txt}"
SKIP=()
UNLOADABLE=()
EXCLUDED=0
UNLOADABLE_COUNT=0
if [ -f "$EXCLUSIONS" ]; then
	while IFS=$'\t' read -r path pattern reason || [ -n "$path" ]; do
		case "$path" in '' | '#'*) continue ;; esac
		[ -n "$pattern" ] || continue
		if [ "$pattern" = "-" ]; then
			UNLOADABLE+=("$path")
			UNLOADABLE_COUNT=$((UNLOADABLE_COUNT + 1))
			continue
		fi
		SKIP+=("--test-skip-pattern=$pattern")
		EXCLUDED=$((EXCLUDED + 1))
	done <"$EXCLUSIONS"
fi
if [ "$EXCLUDED" -gt 0 ] || [ "$UNLOADABLE_COUNT" -gt 0 ]; then
	echo "exclusions: $EXCLUDED test(s) and $UNLOADABLE_COUNT file(s) from ${EXCLUSIONS#"$ROOT"/} cannot run without Pi's profile"
fi

if [ -x "$GUARD" ] && [ -f "$PI_AGENT/extensions/tests/harness-test-setup.ts" ]; then
	# The guard takes files only and starts its unit with its own environment, so it
	# cannot skip a named test: this run executes the excluded ones and stays red on
	# them, which is the honest local picture. CI takes the branch below.
	if [ "$EXCLUDED" -gt 0 ] || [ "$UNLOADABLE_COUNT" -gt 0 ]; then
		echo "exclusions: not applied through the guard, which takes files only"
	fi
	# One log per repository: the guard names its log after the checkout it runs in.
	export PI_TEST_LOG="${PI_TEST_LOG:-/tmp/pi-test-muster.log}"
	ABSOLUTE=()
	for file in "${FILES[@]}"; do
		case "$file" in
			/*) ABSOLUTE+=("$file") ;;
			*) ABSOLUTE+=("$ROOT/$file") ;;
		esac
	done
	cd "$PI_AGENT"
	exec "$GUARD" "${ABSOLUTE[@]}"
fi

if [ -x "$GUARD" ]; then
	exec "$GUARD" "${FILES[@]}"
fi

# A run is bounded (RS3CI). One test that waits on something that never arrives used
# to hold the whole job: node runs the files concurrently and one family's 60 s waits
# added up past the job's own limit, so the run was killed before it reported anything.
# Two bounds, both below CI's step limit:
#
#   TEST_TIMEOUT_MS      node's own per-test limit; a test past it fails and the run
#                        continues, so the file's other tests still report.
#   TEST_WALL_TIMEOUT_S  the whole invocation, for a hang that is not inside a test
#                        (a fixture's top-level code, a child that never exits).
#
# `--test-force-exit` is the third bound and the one the first run needed: a test that
# leaves a spawned daemon behind keeps the file's own process alive after its last
# test, so the runner waits on it and no per-test limit ever fires. Measured here on
# muster/tests/ledger-lc9-events.test.ts, which leaves its ledger daemon running and
# never exits without it.
#
# Both limits are generous for the slowest legitimate family here: the waiter tests
# take a measured 61 s in the worst case, and one page fixture's file takes 229 s.
# The tests expect the offsets of the zone this code is written in (ASLEEP lines carry +03:00 on
# 2026-10-12); a runner without TZ is UTC, so the zone is pinned unless the caller sets one.
export TZ="${TZ:-Europe/Sofia}"

TEST_TIMEOUT_MS="${TEST_TIMEOUT_MS:-120000}"
TEST_WALL_TIMEOUT_S="${TEST_WALL_TIMEOUT_S:-1140}"

# The file entries leave the run here: a file that cannot load has no result to report,
# and node has no flag that skips a file.
if [ "$UNLOADABLE_COUNT" -gt 0 ]; then
	RUN=()
	for file in "${FILES[@]}"; do
		skip=0
		for gone in "${UNLOADABLE[@]}"; do
			[ "$file" = "$gone" ] && skip=1
		done
		[ "$skip" -eq 0 ] && RUN+=("$file")
	done
	FILES=("${RUN[@]}")
	if [ "${#FILES[@]}" -eq 0 ]; then
		echo "muster/test.sh: every test file is excluded here, so there is nothing to run" >&2
		exit 46
	fi
fi
echo "bounds: ${TEST_TIMEOUT_MS} ms per test, force exit, ${TEST_WALL_TIMEOUT_S} s for the run"

exec timeout --signal=KILL "${TEST_WALL_TIMEOUT_S}" \
	node --import tsx --import ./test-setup.ts --test --test-force-exit --test-timeout="${TEST_TIMEOUT_MS}" ${SKIP[@]+"${SKIP[@]}"} "${FILES[@]}"
