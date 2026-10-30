#!/usr/bin/env bash
# The G6 seam check (DL4: one seam for Durable Pi).
#
#   1. Durable Pi 1.0.3's SQLite storage conformance suite, through the guarded
#      runner, in the pinned checkout.
#   2. Every file that imports Durable Pi lives under `extensions/muster/ledger/`,
#      and nowhere else in `extensions/` or `scripts/`.
#
# Usage: seam-check.sh [log-path]
#   PI_DURABLE_DIR overrides the checkout (default ~/projects/pi-mono/packages/durable).
#   The log defaults outside the tree: this script runs from a checkout, so it
#   writes nothing into one.
#
# Exit 0 when the conformance suite exits 0 and no file outside the seam imports
# Durable Pi. Each result is one RESULT line in the log.

set -uo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
DURABLE="${PI_DURABLE_DIR:-$HOME/projects/pi-mono/packages/durable}"
LOG="${1:-${TMPDIR:-/tmp}/muster-ledger-seam-$(date +%F).log}"
mkdir -p "$(dirname "$LOG")"

VERSION="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$DURABLE/package.json" | head -1)"
{
	echo "== seam check $(date -Iseconds)"
	echo "repo: $REPO_ROOT"
	echo "durable: $DURABLE at $VERSION"

	echo "-- 1. sqlite conformance --"
	(cd "$DURABLE" && "$REPO_ROOT/extensions/tests/run-guarded.sh" --runner vitest test/sqlite-storage.test.ts)
	CONFORMANCE=$?
	echo "conformance exit=$CONFORMANCE"

	echo "-- 2. import seam --"
	# Built in two pieces so this script's own text is not a match for its pattern.
	PATTERN='@earendil-works/pi-''durable'
	IMPORTS="$(cd "$REPO_ROOT" && rg -l "$PATTERN" extensions scripts | sort)"
	echo "$IMPORTS"
	OUTSIDE="$(printf '%s\n' "$IMPORTS" | command grep -v '^extensions/muster/ledger/' || true)"
	if [ -n "$OUTSIDE" ]; then
		echo "files outside the seam:"
		echo "$OUTSIDE"
	fi

	if [ "$CONFORMANCE" -eq 0 ] && [ -z "$OUTSIDE" ]; then
		echo "G6 RESULT: PASS conformance exit=0, every Durable Pi import is under extensions/muster/ledger/"
	else
		echo "G6 RESULT: FAIL conformance exit=$CONFORMANCE, $(printf '%s' "$OUTSIDE" | command grep -c . ) file(s) outside the seam"
	fi
} 2>&1 | tee -a "$LOG"

# tee exits with the last command's status; re-read the verdict from the log.
command grep -q "^G6 RESULT: PASS" "$LOG" && exit 0
exit 1
