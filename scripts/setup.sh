#!/usr/bin/env bash
# A fresh clone's one install step (OL12-D6, RS3 step 3): the four lockfiles this
# tree declares its dependencies in. Nothing here fetches an unlisted package:
# every install is `npm ci` from the lockfile beside the manifest it belongs to.
#
#   scripts/setup.sh
#
# The root install provides tsx (the test runner), TypeScript (the type proof) and
# the two Pi packages the port seam's signatures come from. `muster` owns the
# MCP and Concord dependencies, `toolbelt/mcp` the SDK the stdio server loads,
# and `toolbelt/generated/stitch` the Stitch SDK — each into its own folder,
# never into a shared node_modules.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

for dir in . muster toolbelt/mcp toolbelt/generated/stitch; do
	echo "== npm ci in ${dir} =="
	(cd "$ROOT/$dir" && npm ci --no-audit --no-fund)
done
