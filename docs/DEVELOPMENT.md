# The muster repository

Muster is the cross-harness coordination system: lanes, tasks, claims, messages,
the gateway, the ledger and the asks, plus the `core`, `routing` and `toolbelt`
packages it is built on. It used to live inside Pi's profile at
`~/.pi/agent/packages` and reaches Pi from there through the one tracked link
`~/.pi/agent/harness` (OL12 D1, RD5).

- **History**: this repository is the split of `packages/` out of the
  `pi-agent` repository (`git subtree split --prefix=packages`, RD6, OL12 D2).
  Its commits start at RS2a, 2026-10-17, and every one is traceable. The older
  history, plans and personal data never travelled: the pi-agent tag
  **`muster-split-base`** names the commit this split was cut from
  (`3dc8e0b21db5`, 2026-10-28), and that repository holds everything before
  RS2a.
- **Layout**: `core` (settings lock, event wake, graph refresh, redactor, the
  import scan and the Pi port seam), `routing` (provider pool and policy,
  provider keys, the quota readers, the subscription inventory), `toolbelt`
  (the provider CLIs' single control surface) and `muster` (lanes, tasks,
  claims, the gateway, the ledger, the asks, the CLI). `docs/qa/` holds the
  verification records that belong to this repository.
- **Direction** (RD1/RD2): `core` imports nothing, `routing` imports `core`,
  `toolbelt` imports `core`, `muster` imports all three, and no package imports
  Pi's profile, `memory/` or a Pi package at runtime. `core/tests/harness-boundary.test.ts`
  enforces it. Inside the tree, packages import each other by relative path.
- **Tests**: `./test.sh [files...]`. On this machine it calls the one guarded
  entry point, `~/.pi/agent/extensions/tests/run-guarded.sh` (RD7, OL12 D4);
  `HARNESS_TEST_GUARD` overrides that path. Where no guard exists — CI, which
  has no Pi profile — the same files run with node's own runner and this tree's
  `test-setup.ts`, which points the `agentDir` port at a scratch folder.
  With no arguments it runs every test file in the tree.
- **Tests that need Pi's profile**: `scripts/ci-test-exclusions.txt` lists them, one
  test and one reason per line — they read Pi's agent folder, start its launcher or
  its CLI, or read profile data this repository does not carry. `./test.sh` hands
  each entry to node's runner as `--test-skip-pattern`, so CI runs without them.
  The guard this machine uses takes files only and starts its unit with its own
  environment, so a guarded local run still executes them and shows them red.
- **Setup**: `scripts/setup.sh` runs the four installs a fresh clone needs: the
  root, `muster`, `toolbelt/mcp` and `toolbelt/generated/stitch` (`npm ci`,
  each from its own lockfile). CI runs the same four.
- **Type proof**: `tsc --noEmit -p tsconfig.json` (TypeScript 7). CI runs it;
  it is the type proof this project has (VR24-211).
- **Secrets**: `scripts/harness-secret-scan.sh <rev-or-range> [--allow <file>]
  [--split-base <commit>]` scans every commit it is given for the key patterns
  and personal-data names, and prints the commit, the path and the pattern's name —
  never a value. Commits up to the split base keep the whole-tree scan the allow
  entries were reviewed against; every commit after it is scanned for the lines it
  adds only, so a reviewed fixture is not re-flagged on every push. The split base
  is `996266fc` (the tip of the history RS3 moved), which CI and
  `npm run secret-scan` pass.
  `scripts/harness-secret-scan-allow.txt` lists the hits RS3 reviewed: made-up
  test fixtures, constant names and a PEM header in a redaction test, keyed by
  commit and path up to the split base and by path, pattern and line hash after it.
  The classification is in `docs/qa/rs3-secret-scan-2026-10-28.md` of the pi-agent
  repository, where the scan was first run.
- **Graph**: `graphify-out/` is this repository's own code graph, refreshed by
  `~/.pi/agent/scripts/graph-refresh.sh` and read by absolute path.
