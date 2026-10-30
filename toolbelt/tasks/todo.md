# Toolbelt v2 — capability index for Pi

Goal: when Pi needs an external provider action, it loads that provider's full
capability menu on demand (cheap, cached), issues one correct call, and gets
LLM-actionable status back. Full capability, no hand-written adapters.

## Measured baseline (2026-08-29)

- 27 providers, 229 safe ops, 330 mutating ops declared.
- 55/330 mutating ops (16.7%) can actually execute after valid approval.
- supabase: catalog covers 40 of 101 real CLI leaf commands.
- vercel: catalog covers 8 of ~45 command groups.
- Menu cost after global-flag hoisting: railway 308 tok, stripe 347,
  supabase 1190, gh 3349 (needs group drill-down).
- Call overhead: node 50ms, python PDEATHSIG wrapper 20ms.
  Provider CLIs dominate: supabase 640-1370ms, gh 80ms, railway 70ms.
- conformance suite RED (test/conformance.js:501, portal-cli removed from ~/projects).

## Phase 1 — capability index + passthrough  [value core, removes nothing]

1. lib/surface.js: walk a CLI's --help tree -> {cmd, flags, desc} leaves
   -> verify: `refresh-surface supabase` produces 101 leaves matching the
     python prototype
2. lib/surface.js: renderMenu with auto global-flag hoisting (>=70% of cmds)
   -> verify: supabase menu <= 1300 tokens, includes `db push --dry-run`
3. data/surface/<provider>.json cache, version-stamped to the CLI version
   -> verify: `menu supabase` reads cache only, no subprocess, <100ms
4. `providers` command: one line per provider, installed + accounts + cmd count
   -> verify: all 27 providers listed under 400 tokens
5. `menu <provider> [group]`: full menu under 1500 tok, else group index
   -> verify: `menu gh` returns group index; `menu gh pr` returns pr commands
6. `run <provider> -- <argv...>`: verbatim passthrough, account routing,
   gate, redact, ledger
   -> verify: `run supabase -- inspect db table-stats` works with zero
     per-command code

## Phase 2 — classification + gates

7. data/policy/<provider>.json: read/destructive/blocked/secretReturning
   patterns + native dryRun flag. Unmatched defaults to `mutate` (gated,
   EXECUTABLE) instead of refused.
   -> verify: catalog-check reports unclassified leaves as drift
8. Destructive second gate: --confirm-destructive + typed target echo
   -> verify: wrong target string refuses
9. Fix secret detector gap: dbPassword / pass / pwd currently pass through
   -> verify: test asserts no secret-shaped value reaches argv

## Phase 3 — routing correctness (F2/F3)

10. Verify identity BEFORE mutations (currently skipped for mutations)
11. Supabase identity probe via `orgs list`; expectedIdentity on every account
12. Project with no binding for a provider fails closed, not ambient auth
    -> verify: fake-CLI negative tests both directions

## Phase 4 — collapse + tests + docs

13. Route `call --operation` through the engine as aliases; delete adapters
    that add nothing beyond the passthrough
14. Fix red conformance suite; add menu/run/routing tests
15. Update SKILL.md, wiki pi-toolbelt.md, catalog notes

## Round 2 — router redesign 2026-08-29

the operator's correction: this is a router for an LLM, not a catalogue for a human.
Pi's system prompt has one line; from there Toolbelt must make external work
effortless. Audited against that and fixed:

- bare `pi-toolbelt` printed a stale help listing the old broken operations.
  It is the landing page for that one-liner. Rewritten as the protocol: 389 tok.
- discovery was provider-first. Pi has an intent, not a provider name. Added
  `find "<intent>"` — searches every surface, returns commands + flags + gate.
  ~150-250 tok, one call, no provider needed.
- menus now group by gate (read / mutate / destructive / blocked), so the model
  knows the approval cost before calling. +4% tokens, -1 round trip.
- failure hints now lead with the provider's own error plus the positional
  signature, and call out Toolbelt-vs-provider flag collisions. Verified a hint
  led straight to a working call.
- THE BLOCKER: the Pi extension had a hardcoded ACTIONS allowlist without
  find/menu/run/refresh_surface, so none of this was reachable from Pi at all.
  Added them, plus query/group/command/confirmDestructive params.
- extension promptGuidelines were ~1400 tok of per-provider prose. Replaced
  with the protocol: 582 tok.
- AGENTS.md told Pi to run `discover` first (5505 tok). Now points at `find`.
- parser bug: commander dialect (`list|ls [options]  desc`) was rejected, hiding
  91 commands on resend alone. Fixed: 1310 -> 1445 commands.
- classification bug: hyphenated names hid their verbs (`domains-list` was
  mutate). Fixed, plus catalog-derived surfaces now carry an authoritative
  class that strengthens but never weakens a destructive match.

Final: 1445 commands, 599 read / 638 mutate / 135 destructive / 73 blocked.
1372 (94.9%) executable with approval.

## Review — Phase 1-3 complete 2026-08-29

Done and verified:
1-6  capability index shipped: providers / menu / run / refresh-surface
7-9  classification policies for 8 CLIs; unmatched defaults to mutate
     (gated, executable); destructive second gate; secret detector fixed
10-12 identity verified before mutations; supabase org probe added;
     project-with-no-binding and single-account fail-closed

Result: 19 providers, 1310 commands reachable, 1254 (95.7%) executable
with approval. Was 55 of 330 declared mutations (16.7%).

  read (immediate)              408
  mutate (approval + reason)    750
  destructive (second gate)      96
  blocked (creds / live secrets) 56

Menu cost 54-3356 tokens, loaded on demand. SKILL.md 2655 -> 833 tokens.
menu latency 890ms -> 90ms (mtime stat replaced a --version subprocess).
status 150ms -> 120ms (ledger newline count; providers.json no longer
rewritten every invocation).

Tests: test/engine.js (new, fake-CLI proofs of every gate), conformance,
account-routing, smoke.

O1 — policy coverage expansion completed 2026-08-30:
- Added explicit policy entries for all 21 providers, covering the remaining
  245 leaves across railway, stripe, tailscale, sentry, audible, notebooklm,
  runware, stitch, infisical, claude-code, and antigravity.
- `catalog-check` now reports 1,740/1,740 leaves classified, zero partial
  providers, and zero unclassified defaults. Current classes: 767 read, 678
  mutate, 195 destructive, and 100 sensitive.
- Sensitive-returning commands have explicit secret-returning rules and safe
  output handling. SQL, credential, network, cleanup, and plugin operations
  were reviewed for conservative classification.

V2 conformance and operational finish completed 2026-08-30:
- Replaced stale approval/refusal assertions with a safe v2 contract suite.
  It verifies discovery, menus, coverage, policy metadata, run validation,
  legacy compatibility, secret rejection, and redacted ledger output without
  executing live mutations.
- `call --operation` remains a bounded compatibility alias layer for curated
  operations. `run` owns the complete provider surface. Removing the aliases
  is not required for operational completeness and would risk capability loss.
- Verification: `catalog-check`, `audit-secrets`, `test/conformance.js`,
  `test/engine.js`, `test/account-routing.js`, `test/studio.js`,
  `test/smoke.sh`, and `git diff --check` pass. No external provider mutation
  was performed.

Remaining work is optional hardening, not an operational blocker:
- Keep the compatibility aliases unless a separately scoped migration proves
  full argument, sanitization, routing, and output parity through `run`.
- Update stale historical counts in older review notes only when those notes
  are next revised.
