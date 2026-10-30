# Toolbelt stability execution

As of: 2026-09-12 (verification complete; commits/pushes/activation pending)
Status: hermetic verification fully green (59/59, ten suites). Wiki updated. Next: logical commits, authorized pushes via Toolbelt git, activation with the operator.
Worktree: `/home/operator/.pi/agent`, branch `main`; programme changes uncommitted.

## Approved outcome and boundaries

the operator authorized evaluating and repairing Toolbelt across every registered service so it is a stable, easy programmatic interaction layer. Preserve the CLI-router architecture: official CLIs own credentials and service operations; Toolbelt owns routing, discovery, identity checks, redaction and execution evidence. No parallel API clients/credential stores. No arbitrary operation omissions or repeated permission loops. Discovery coverage is not runtime support or live authentication proof.

Outstanding explicit external authorization: push agent `main` to `origin`, and Pi custom `operator-custom` to `fork`. Neither push has been executed. No force pushes, provider-account changes, paid calls or deployment exercises are authorized by this repair programme. No new runtime activation performed.

## Demonstrated causes

- `cmdRun` blocked valid commands absent from stale indexes and rejected provider flags with names matching Toolbelt flags.
- Pi wrapper dropped stdout-only output, misread parsed catalogue envelopes, omitted cwd/stdin-file/timeout controls, and appended slash-command flags after the provider separator.
- Wrapper overwrote provider exitCode with outer process status; recursive timeout detection could misread provider data as lifecycle failure.
- Some help indexes fabricated recursive/positional command paths (stitch, vercel, wrangler); runware index used incorrect grammar.
- Legacy alias paths still carry contradictory approval/refusal behavior.
- Old smoke/conformance tests assumed permanent refusal and could touch live providers. They must be demonstrably fixture-isolated before broader execution.

Initial live listing had 26 visible providers; cached registry had 30 entries, 23 surfaces. These are different populations. Git transport was absent (GitHub adapter wraps gh). Git is now authored into the core registry; source/runtime verification pending.

## Settled delegate evidence

Every delegate below has settled and its original ID was joined. No delegate remains running and no replacement should be dispatched to recover old results.

Research:
- `d-mtycl08g-1`: core audit ended without usable final output; parent inspected core directly.
- `d-mtycl7pn-2`: discovery/policy findings consumed.
- `d-mtyclg4b-3`: wrapper findings consumed.

First implementation batch:
- `d-mtycscd3-4`: core passthrough, Git, controls, result metadata; new `toolbelt/test/stability-core.js`.
- `d-mtycsttn-5`: discovery/policy libs, corrected five surfaces/four policies, conformance and new discovery regressions.
- `d-mtyctcpo-6`: wrapper/helper/schema and three wrapper test files.
- `d-mtycujew-7`: smoke/engine/account/studio isolation; fixture CLI helper. Joined and compact result consumed; full output is available if needed.

Independent review `d-mtyd8hic-8`: needs-fixes. Found stdin echo leak, invented 16MiB stdin cap, contradictory 5s/120s timeout behavior, repeated-help completeness misstatement, live conformance calls, and remaining legacy alias refusal concerns. Full result consumed.

Correction batch (all joined; available full results consumed):
- `d-mtydd5rn-9`: core and stability-core tests. ENDED WITHOUT USABLE FINAL SUMMARY (`Upstream stream ended before terminal chunk`). Inspect current diff to determine which corrections actually landed. Assigned: file-backed stdin without invented size cap; suppress provider body when secret stdin used with explicit reason; consistent native deadlines; repair generated refresh grammar so runware/stitch/Git caches cannot regress; address legacy alias contradictions at existing mappings without fabricating commands.
- `d-mtyddi6z-a`: reports search `log`→`login` regression fixed at description scoring; repeated-parent help now incomplete; rendered unknown/partial/group coverage. Changed `surface.js` and `discovery-policy.js`. Did not change policy.js; claims existing declared mutation ranking covers positional `status`, with authored regressions. Not tested.
- `d-mtydds8c-b`: reports standalone conformance fixture isolation, no-fallthrough/audit assertions, and updated native passthrough expectations. Changed conformance.js and support/fake-provider-cli.js. HOME remains real intentionally for generated catalog paths; inspect isolation rather than treating that explanation as proof. Not tested.
- `d-mtydeggz-c`: wrapper corrections ENDED WITHOUT USABLE FINAL SUMMARY (`Upstream stream ended before terminal chunk`). Tool record lists edits to wrapper/helper and three tests, but completion is unproven. Assigned: preserve provider exit metadata; nonrecursive lifecycle classification; slash separator fix; output suppression/alternative/coverage hints; fast/all controls; no duplicate approval loop.

## Verification state (2026-09-12 resumed session)

- Focused batch (wrapper x3 + stability-core + discovery-policy): **55/55** after parent-dispatched corrections (d-mtydvi2i-d) landed the four core-bin fixes + refresh guard + blocked→sensitive mapping; parent added `timeoutMs` disclosure to the run envelope.
- Broadened batch (conformance, engine, account-routing, studio): initially 2 failures — `find "logs"` returned login (description-word leak; root-based decisiveness fixed by d-mtye2jg0-f) and `menu <unknown-slug>` returned surface_not_generated instead of unknown_provider (bin catalog check fixed) — then **59/59** across all nine suites in one guarded run. Zero descendant test processes.
- Surface regeneration complete: git 51 (new), portal-bg 8, pally 11, vercel 107, google-workspace 188, resend 126→119 (artifact filter), wrangler 288 (18 groups honestly incomplete, ~9 min walk), infisical 49, vps 52, claude-code 38; sentry honestly `cli_not_installed`; neon deferred (npx install risk) — not exercised.
- catalog-check: 1,624 leaves, 0 unclassified. Walker artifact filter drops exactly 7 resend help-dialect leaves with no collateral; 3 residual prose-fragment artifacts (`suppressions bounce|complaint|manual`) classified defensively; 5 earlier fragments eliminated by regeneration surfacing real parents (`broadcasts send`, `contacts update-topics`).
- Fix for the conformance secret-audit regression: a `_residual_artifacts` note key in resend policy broke `isPolicyShaped` (only POLICY_TOP_KEYS allowed) — note moved here instead: the 3 residual artifacts are documented in this file.
- M4 test-execution gate correctly refused `node --check` on test scripts; respected.
- Per-provider inventory (d-mtydvi2w-e): 31 registry entries incl. git; missing indexes never gate native run; all live auth uniformly unproven this audit.

## Outstanding after verification

- Logical commits (harness/toolbelt split per prior grouping), authorized pushes: agent `main`→origin, pi-mono `operator-custom`→fork — pushes must go THROUGH repaired Toolbelt (`run git --cwd … -- push`) as the demonstrating use case.
- Activation: extension schema/description changed — needs Pi restart (fresh restart preferred); arranged with the operator at the end.
- Wiki: rewrite pi-toolbelt.md with verified behavior + inventory; log.md pointer.
- Honest limitations: legacy call adapters keep adapter-contract behavior; 16 MiB stdin guard documented; identity cache is not live proof; gcloud deferred though binary exists (PATH); sentry-cli unresolvable by PATH name.
