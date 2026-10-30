# Backlog — generated from the work-item records

Rendered by `muster schema work-item --backlog` from the work-item store, or by
`muster schema work-item --backlog --backfill` from the retired hand table's rows, which this mapping
carried over at the cutover of 2026-10-29.
40 records. The records are the truth; this file is never edited by hand (spec §7b).

| id | outcome | state | brief / source | deps | sprint goal |
| --- | --- | --- | --- | --- | --- |
| A1 | OpenAI 5 USD for voice tests (AIC6/AIC7) | gated:operator:Wed 28 Oct | VR24-217 | none | AI coverage |
| AI-LIVE | AI live pass re-run (Anthropic, 20 USD ceiling, VR24-5) then AIC8 report | gated:dep:quiet-machine | specs/be-ai-coverage-2026-10-26.md AIC8 | after GL2-FRESH | AI coverage |
| BAL | Balance DeepSeek lanes across the two Command Code accounts by remaining allowance, not only on limit (the operator via Henry 17:42) | gated:dep:usage-monitor data | provider-pool.json accountFailover, muster usage | first real account move | account use |
| BEDEPS | Repair crm-app deps in place (frozen lockfile, no symlinks into lane worktrees), confirm jest resolves; run after the J14 window ends (Henry 22:00) | gated:dep:J14 run | this chat | J14 | BE tests |
| CCACCT2 | Command Code pool switchover: balance DeepSeek lanes across both Command Code accounts with automatic switchover at a limit (Henry 04:17). 04:00 account-health shows BOTH command-code accounts failing insufficient-credits, so no allowance to switch to until credits are bought (the operator) | launched:ccacct2 | account-health 04:00 | none | routing |
| CR1 | Room crop question server side | done | specs/team-input-room-blueprint-2026-10-24.md | none | rooms stage 1 |
| CR2 | CropStep.tsx questionnaire UI | done | blueprint CR2 | none | rooms stage 1 |
| CRQ | Command center phone checks | gated:operator:phone | specs/cc-r7-build-plan-2026-10-26.md CRQ | none | command center |
| D11FIX | D11 driver changes | done | handoffs/msgs/lane-prompt-d11fix-* | none | J1b1 memory |
| EA-IMPORT | EA import step list to Henry, then run | gated:dep:fresh-T2 | VR24-216 | clean J01+J10 | EA |
| GHTOKEN | Move the working gh token out of the ~/.bashrc export into gh auth or Infisical (names only, no value printed) so hosts.yml is not stale; the wake code already reads env, gh auth token, then bashrc (Henry 01:52) | ready | tickgh review | tickgh | gh credential |
| GL2-ONLY | One gate-only GL2 run (J10,J2,J11,J3-J6,J8,J9,J13-J17; no J1b*) on 3ac035e82 when MemAvailable>=12288, PSI some avg10<10, non-lane sessions flat 10 min; deadline 21:30 else Wed after the 05:09 nightly (Henry 19:0x). Watcher: job tmp gl2-gated-start.py | launched:watcher | reports docs/qa/*run3* | none | BE dev push |
| GL2COOL | pressure-refused start waited out, retried once | done | - | none | BE dev push |
| GL2MEM | Cut GL2 per-spec memory (shared server, fewer workers); 7 specs peaked over 7680 MiB (Henry 20:56, not blocking) | gated:parked | run4 report ea65eae92 | none | GL2 memory |
| HELD | AR7-AR9, be62, portal-cli, BP1-BP10, D11 labels, rooms WP9 release R, website push, AIC6/AIC7, B-4, W9, production, EA capture (closed for good, VR24-152) | gated:held | switch-board / rulings | none | none |
| MSG | Messaging M2-M5 | gated:operator:at the PC | VR24-62/72 | none | messaging |
| OL0 | Contract checks in health/doctor.ts for the 36 timers, ledger, gateway, tick and desks; read-only, shown on the Systems tab (VR24-220, architect 2026-10-27) | done | specs/out-loop-durable-agents-2026-10-27.md §10 | none | out-loop |
| OL0B | Show the doctor contracts (42 rows, proof age, red/ok) on the command center Systems tab; the tab reads no doctor output today (OL0 lane question). Find the Systems tab owner first; ROUND 2: plus one code table in doctor.ts keyed by contract id (owner, purpose, onRed, kill); a contract with no entry is red | launched:oldoc | OL0 report, spec §10 OL0 | OL0 | out-loop |
| OL1 | Cleanup rules in muster-janitor (spec §6); fixture tests per rule first; the live destructive pass waits for Henry's word | done | specs/out-loop-durable-agents-2026-10-27.md §6, §10 | OL0 | out-loop |
| OL10 | Goal loop (VR24-221): acceptance, timeBoxHours and fix-round bounds on goals.ts, earned-autonomy count per product, auto-rollback proof; spec OL10 | gated:dep:OL8 | specs/out-loop-durable-agents-2026-10-27.md §8a, §10 | OL8 | out-loop |
| OL1B | Doctor contract for C: free space (structured read of /mnt/c, red under 50 GB, then one ask), moved out of the janitor (OL1 round 3) | launched:oldoc | OL1 report, spec §6, §12 | OL0 | out-loop |
| OL1R2 | Janitor Rev 2 (OL1 already merged 90a0da4f local): flock, manifest-before-removal, dry run first, no fstrim (system fstrim.timer), ignored files archived minus regenerable list and .env*, expiry needs merged ref AND no untracked/ignored payload, docker per-image rmi only for images with RepoDigests | gated:held | specs/out-loop-durable-agents-2026-10-27.md Rev 2 | OL1 | out-loop |
| OL2 | dispatch.ts on pi-lane-launch.sh and the real queue; a ready row launches within 2 min of a free slot, no session turn; Fix gate (shared owner) | gated:held | specs/out-loop-durable-agents-2026-10-27.md §10 | OL0 | out-loop |
| OL3 | "ready rows > 0 and no launch for 20 min" alert via tick-alerts.json, replaces orch-heartbeat.sh; Fix gate; CORRECTION (design 2026-10-28): orch-heartbeat.sh STAYS, do not remove it; ROUND 2: extend the existing empty-slot wake (UBEMPTY, tick.ts emptySlotWake) with the per-row gate reason as one ask, no second alert | gated:dep:OL2 | specs/out-loop-durable-agents-2026-10-27.md §10 | OL2 | out-loop |
| OL3B | Repairs move from the janitor to the tick (Rev 2) | gated:held | spec Rev 2 | OL0b | out-loop |
| OL4 | Ledger Phase B (PB6 then PB7); CORRECTION: PB7 must not disable muster-tick.timer until the durable pass calls runTick | gated:dep:OL2 | specs/out-loop-durable-agents-2026-10-27.md §10 | OL2 | out-loop |
| OL5 | Conductor on Pi durable, in shadow | gated:dep:OL4 | specs/out-loop-durable-agents-2026-10-27.md §10 | OL2, OL4 | out-loop |
| OL6 | Agents view in the command center | gated:dep:OL0 | specs/out-loop-durable-agents-2026-10-27.md §10 | CRW, OL0 | out-loop |
| OL7 | methodology.md update (spec sections 1 and 4) | done | specs/out-loop-durable-agents-2026-10-27.md §10 | D2 | out-loop |
| OL8 | Work items as validated ledger records beside goals.ts; backlog.md generated from them; an ask without heading, summary and per-option consequences never reaches the operator (VR24-222); Fix gate; CORRECTION: no new preparing status, unprepared asks stay open and are filtered out of waitingOnOperator and the push, system writers go in ASK_WRITERS | gated:dep:OL2 | specs/out-loop-durable-agents-2026-10-27.md §7a, §10 | OL2 | out-loop |
| OL9 | One card component on desktop, phone and TV with motion | gated:dep:OL8 | specs/out-loop-durable-agents-2026-10-27.md §7a, §10 | OL8, CRW | out-loop |
| PRUNE | Remove merged, clean worktrees of c1e5c09a without --force, re-checking each at removal; keep every branch and tag; then git worktree prune; report removed/skipped counts | gated:dep:GL2-FRESH | reports/worktree-prune-candidates-2026-10-27.md (Henry GO 17:44) | GL2-FRESH | housekeeping |
| PRUNE2 | Worktree prune must check for node_modules symlinks pointing into worktrees before removing them (crm-app jest link broke; Henry 22:00) | gated:held | worktree-prune-result-2026-10-27.md | none | harness hygiene |
| T2-BATCH | Fresh T2 on the BE batch tip before the push | gated:dep:GL2-FRESH | scripts/lanes/test.sh | none | BE dev push |
| UB-EMPTY | muster-tick empty-slot wake | launched:ubempty | handoffs/msgs/lane-prompt-ubempty-* | none | self-launching |
| WAITWIN | waiter 3 min for REVIEW READY/BLOCKED/QUESTION | done | - | none | self-launching |
| WAKEHEALTH | alert after 2 failed Henry wake flushes | done | - | none | self-launching |
| WGFIX2-WGGUARD | notice measures unarmed time; orch-wait refuses a second arm | launched:ubempty | Henry 17:44 | UB-EMPTY | self-launching |
| WP9 | Build the the operator test room spec with image_crop units (VR24-219 stage 1; local Postgres, next dev on his PC) | done | blueprint 10a | CR2 | rooms stage 1 |
| WT-INV | Read-only worktree inventory | done | reports/worktree-inventory-2026-10-27.md | none | housekeeping |
