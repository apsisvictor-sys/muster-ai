#!/usr/bin/env bash
# `muster-orch-waker` launcher (WAKE1, Henry via the operator 2026-10-29 03:29).
#
# Resolves the harness tree this script sits in (a release, a worktree) and the Pi profile
# beside it, then runs the waker under node + tsx. The systemd user unit
# (`muster/systemd/muster-orch-waker.service`) is the only intended caller; a manual run is
# safe while the unit is stopped, because the waker takes its own lock (`orch-waker.pid`) and a
# second copy refuses to start with one named line and exit 75.
set -u

SELF="$(readlink -f "${BASH_SOURCE[0]}")"
HERE="$(dirname "$SELF")"
ROOT="$(cd "$HERE/../.." && pwd)"
AGENT_DIR="${PI_AGENT_HOME:-$HOME/.pi/agent}"

NODE_BIN="${PI_AGENT_NODE:-$AGENT_DIR/bin/node}"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
	echo "muster-orch-waker: no node found (looked at $AGENT_DIR/bin/node and PATH)" >&2
	exit 127
fi

# tsx ships with this repository; the profile's copy is the fallback for a release that has none.
for candidate in "$ROOT/node_modules/tsx/dist/loader.mjs" "$AGENT_DIR/node_modules/tsx/dist/loader.mjs"; do
	if [ -f "$candidate" ]; then
		TSX="$candidate"
		break
	fi
done
if [ -z "${TSX:-}" ]; then
	echo "muster-orch-waker: no tsx loader found (looked in $ROOT and $AGENT_DIR)" >&2
	exit 127
fi

export PI_AGENT_HOME="$AGENT_DIR"
exec "$NODE_BIN" --import "file://$TSX" "$ROOT/muster/bin/muster-orch-waker.mts" "$@"
