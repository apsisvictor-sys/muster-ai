#!/usr/bin/env bash
#
# Toolbelt smoke — fixture-isolated regression entrypoint.
#
# Safety contract:
#   * No call in this file may reach a real provider. Every provider CLI the
#     matrix can touch resolves to test/support/fake-provider-cli.js inside a
#     temp bin dir, Toolbelt runs with a temp PI_TOOLBELT_HOME seeded from the
#     checked-in surfaces/policies, and every provider credential variable is
#     unset before the first invocation. A fixture CLI that is missing is a
#     hard failure, never a fallback to the real binary.
#   * The sibling node regressions (conformance, engine, account-routing,
#     studio) are executed only when this script is already inside the
#     canonical guarded runner's cgroup. They therefore cannot become a way to
#     run a test suite unguarded.
#
# Verification claims belong to the canonical guarded runner:
#   extensions/tests/run-guarded.sh <wrapper test files>
#
# Everything after that runner is the fixture matrix; it never recommends a raw
# `node test/...` invocation.
set -euo pipefail

TOOLBELT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLBELT_BIN="${PI_TOOLBELT_BIN:-$TOOLBELT_ROOT/bin/pi-toolbelt}"
AGENT="${PI_TOOLBELT_AGENT:-smoke}"
FAKE_HELPER="$TOOLBELT_ROOT/test/support/fake-provider-cli.js"
GUARDED_RUNNER="$HOME/.pi/agent/extensions/tests/run-guarded.sh"
NODE_BIN="$(command -v node)"
PY_BIN="$(command -v python3)"

FIXTURE_DIR="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_DIR"' EXIT
FIXTURE_BIN="$FIXTURE_DIR/bin"
FIXTURE_HOME="$FIXTURE_DIR/toolbelt"
FIXTURE_OUT="$FIXTURE_DIR/out"
AUDIT="$FIXTURE_DIR/invocations.jsonl"
mkdir -p "$FIXTURE_BIN" "$FIXTURE_OUT" "$FIXTURE_HOME/data"

# --- data the matrix reads (never secrets, never live state) ---------------
cp -R "$TOOLBELT_ROOT/data/surface" "$FIXTURE_HOME/data/surface"
cp -R "$TOOLBELT_ROOT/data/policy" "$FIXTURE_HOME/data/policy"
if [ -f "$TOOLBELT_ROOT/data/providers.json" ]; then
  cp "$TOOLBELT_ROOT/data/providers.json" "$FIXTURE_HOME/data/providers.json"
fi
printf '{"version":1,"accounts":{},"projects":{}}\n' >"$FIXTURE_HOME/data/accounts.json"
: >"$AUDIT"

# --- fixture provider CLIs -------------------------------------------------
FIXTURE_CLIS="resend gh vercel stripe sentry-cli railway tailscale gws supabase wrangler portal pixellab runware studio stitch"
write_fake() {
  local name="$1"
  cat >"$FIXTURE_BIN/$name" <<EOF
#!/bin/sh
exec "$NODE_BIN" "$FAKE_HELPER" "$name" "\$@"
EOF
  chmod +x "$FIXTURE_BIN/$name"
}
for name in $FIXTURE_CLIS; do write_fake "$name"; done

# A missing or misordered fixture is a hard failure, not a live fallback.
for name in $FIXTURE_CLIS; do
  resolved="$(PATH="$FIXTURE_BIN:$PATH" command -v "$name" || true)"
  if [ "$resolved" != "$FIXTURE_BIN/$name" ]; then
    echo "fixture CLI $name did not resolve to $FIXTURE_BIN/$name (got: ${resolved:-none})" >&2
    exit 1
  fi
done

# Path excludes /usr/local/bin and ~/.local/bin, where the real provider CLIs
# live. Provider commands can therefore only come from the fixture bin.
export PATH="$FIXTURE_BIN:$(dirname "$NODE_BIN"):$(dirname "$PY_BIN"):/usr/bin:/bin"
export PI_TOOLBELT_HOME="$FIXTURE_HOME"
export PI_TOOLBELT_BIN="$TOOLBELT_BIN"
export PI_TOOLBELT_IDENTITY_TTL_MS=0
export PI_TOOLBELT_FIXTURE=1
export PI_TOOLBELT_FAKE_AUDIT="$AUDIT"
export PI_TOOLBELT_FAKE_CLIS="$FIXTURE_CLIS"
export PIXELLAB_CLI_PATH="$FIXTURE_BIN/pixellab"
export RUNWARE_CLI_PATH="$FIXTURE_BIN/runware"
export STUDIO_CLI_PATH="$FIXTURE_BIN/studio"
export STITCH_CLI_PATH="$FIXTURE_BIN/stitch"
export PORTAL_CLI_PATH="$FIXTURE_BIN/portal"
export PI_TOOLBELT_GWS_BIN="$FIXTURE_BIN/gws"

# Provider credentials are removed, not replaced: a present token can route an
# adapter onto its direct HTTP surface, which is the live path we must exclude.
for credential in VERCEL_TOKEN GITHUB_TOKEN GH_TOKEN RESEND_API_KEY \
  STRIPE_API_KEY STRIPE_SECRET_KEY SENTRY_AUTH_TOKEN RAILWAY_TOKEN RAILWAY_API_TOKEN \
  TAILSCALE_AUTHKEY RUNWARE_API_KEY PIXELLAB_API_KEY STUDIO_API_KEY \
  SUPABASE_ACCESS_TOKEN CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do
  unset "$credential" 2>/dev/null || true
done

# The real home must not move while this runs.
REAL_LEDGER="$HOME/.pi/agent/toolbelt/data/ledger.jsonl"
real_ledger_lines() {
  if [ -f "$REAL_LEDGER" ]; then wc -l <"$REAL_LEDGER"; else echo 0; fi
}
REAL_LEDGER_BEFORE="$(real_ledger_lines)"

run_json() {
  local name="$1"
  shift
  local out="$FIXTURE_OUT/$name.json"
  "$TOOLBELT_BIN" "$@" --json --agent "$AGENT" >"$out"
  "$NODE_BIN" -e 'const fs=require("fs"); const p=process.argv[1]; const v=JSON.parse(fs.readFileSync(p,"utf8")); if (!v || typeof v !== "object") process.exit(2);' "$out"
  printf 'ok %s\n' "$name"
}

expect_field() {
  local file="$1" field="$2" expected="$3"
  local actual
  actual="$("$NODE_BIN" -e 'const fs=require("fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const c=process.argv[2].split(".").reduce((a,k)=>a==null?a:a[k],v);process.stdout.write(c===undefined?"":String(c));' "$file" "$field")"
  if [ "$actual" != "$expected" ]; then
    echo "expected $field=$expected in $file, got ${actual:-<missing>}" >&2
    exit 1
  fi
}


# --- Toolbelt introspection (fixture home only) ----------------------------
run_json status status
run_json discover discover
run_json catalog catalog-check
run_json inventory inventory
run_json links links
run_json audit audit-secrets

# --- provider matrix -------------------------------------------------------
# Each provider call resolves to the fixture CLI above. A mutating or
# destructive operation still executes (classification is advisory) — against
# the fixture, which records the invocation instead of contacting the service.
run_json vercel_status call --provider vercel --operation status
run_json vercel_domains call --provider vercel --operation domains || true
run_json vercel_teams call --provider vercel --operation teams || true
run_json vercel_blob_del_fixture call --provider vercel --operation blob-del
run_json vercel_env_add_fixture call --provider vercel --operation env-add
run_json github_status call --provider github --operation status
run_json github_releases call --provider github --operation releases || true
run_json github_release_missing call --provider github --operation release
run_json github_workflows call --provider github --operation workflows || true
run_json github_repo_list call --provider github --operation repo-list || true
run_json github_search_repos call --provider github --operation search-repos --args '{"query":"cli","limit":1}' || true
run_json github_pr_create_fixture call --provider github --operation pr-create
run_json github_issue_close_fixture call --provider github --operation issue-close
run_json github_release_create_fixture call --provider github --operation release-create
run_json github_workflow_run_fixture call --provider github --operation workflow-run
run_json github_run_rerun_fixture call --provider github --operation run-rerun
run_json github_repo_delete_fixture call --provider github --operation repo-delete
run_json github_release_delete_fixture call --provider github --operation release-delete
run_json github_gist_delete_fixture call --provider github --operation gist-delete
run_json stripe_status call --provider stripe --operation status || true
run_json stripe_balance call --provider stripe --operation balance || true
run_json stripe_customers_list call --provider stripe --operation customers-list --args '{"limit":1}' || true
run_json stripe_charges_list call --provider stripe --operation charges-list --args '{"limit":1}' || true
run_json stripe_payment_intents_list call --provider stripe --operation payment-intents-list --args '{"limit":1}' || true
run_json stripe_customer_create_fixture call --provider stripe --operation customers-create
run_json stripe_refund_create_fixture call --provider stripe --operation refunds-create
run_json resend_status call --provider resend --operation status || true
run_json resend_profile_status call --provider resend --operation status --args '{"profile":"safe-profile_1.test"}' || true
run_json resend_domains_list call --provider resend --operation domains-list || true
run_json resend_emails_get_missing call --provider resend --operation emails-get
run_json resend_email_send_fixture call --provider resend --operation emails-send
run_json resend_template_delete_fixture call --provider resend --operation templates-delete
run_json pixellab_status call --provider pixellab --operation status || true
run_json pixellab_characters_list call --provider pixellab --operation characters-list || true
run_json pixellab_tilesets_list call --provider pixellab --operation tilesets-list || true
run_json pixellab_isometric_tiles_list call --provider pixellab --operation isometric-tiles-list || true
run_json pixellab_character_missing_arg call --provider pixellab --operation characters-get
run_json pixellab_generation_fixture call --provider pixellab --operation generate-image-v2
run_json pixellab_pixen_fixture call --provider pixellab --operation create-image-pixen --args '{"prompt":"test","options":{"seed":1}}'
run_json pixellab_pixen_raw_alias_fixture call --provider pixellab --operation post-create-image-pixen --args '{"prompt":"test","options":{"seed":1}}'
run_json pixellab_object_4_directions_fixture call --provider pixellab --operation create-object-with-4-directions --args '{"prompt":"test"}'
run_json pixellab_review_fixture call --provider pixellab --operation objects-select-frames --args '{"id":"asset_123","frame_ids":["frame_1"]}'
run_json pixellab_delete_fixture call --provider pixellab --operation characters-delete --args '{"id":"asset_123"}'
run_json pixellab_delete_raw_alias_fixture call --provider pixellab --operation delete-objects-object_id --args '{"id":"asset_123"}'
run_json runware_status call --provider runware --operation status
run_json runware_models_search call --provider runware --operation models-search --args '{"query":"flux","limit":1}' || true
run_json runware_generation_fixture call --provider runware --operation image-generate --args '{"prompt":"test"}'
run_json runware_upload_fixture call --provider runware --operation image-upload --args '{"file":"example.png"}'
run_json runware_audio_fixture call --provider runware --operation audio-inference --args '{"prompt":"test"}'
run_json runware_model_upload_fixture call --provider runware --operation models-upload
run_json gws_status call --provider google-workspace --operation status || true
run_json gws_drive_about call --provider google-workspace --operation drive-about || true
run_json gws_drive_list call --provider google-workspace --operation drive-list || true
run_json gws_drive_get_missing call --provider google-workspace --operation drive-get
run_json gws_gmail_profile call --provider google-workspace --operation gmail-profile || true
run_json gws_gmail_labels call --provider google-workspace --operation gmail-labels || true
run_json gws_gmail_messages call --provider google-workspace --operation gmail-messages || true
run_json gws_calendar_list call --provider google-workspace --operation calendar-list || true
run_json gws_drive_create_fixture call --provider google-workspace --operation drive-create
run_json gws_gmail_send_fixture call --provider google-workspace --operation gmail-send
run_json gws_cal_event_delete_fixture call --provider google-workspace --operation calendar-event-delete
run_json sentry_status call --provider sentry --operation status || true
run_json sentry_projects_list call --provider sentry --operation projects-list || true
run_json sentry_releases_list call --provider sentry --operation releases-list || true
run_json sentry_releases_get_missing call --provider sentry --operation releases-get
run_json sentry_releases_create_fixture call --provider sentry --operation releases-create
run_json railway_status call --provider railway --operation status || true
run_json railway_variables call --provider railway --operation variables || true
run_json railway_up_fixture call --provider railway --operation up
run_json railway_variable_set_fixture call --provider railway --operation variable-set
run_json tailscale_status call --provider tailscale --operation status || true
run_json tailscale_devices call --provider tailscale --operation devices || true
run_json ts_whois_missing call --provider tailscale --operation whois
run_json ts_ping_missing call --provider tailscale --operation ping
run_json ts_netcheck call --provider tailscale --operation netcheck || true
run_json ts_cert_missing call --provider tailscale --operation cert
run_json ts_up_fixture call --provider tailscale --operation up
run_json ts_down_fixture call --provider tailscale --operation down
run_json ts_funnel_fixture call --provider tailscale --operation funnel
run_json ts_serve_fixture call --provider tailscale --operation serve
run_json portal_status call --provider portal-bg --operation status
run_json portal_cities call --provider portal-bg --operation cities

# --- secret rejection (never reaches any CLI) ------------------------------
if "$TOOLBELT_BIN" call --provider github --operation repo --args '{"token":"ghp_aaaaaaaaaaaaaaaaaaaa"}' --json --agent "$AGENT" >"$FIXTURE_OUT/secret.json"; then
  echo "secret rejection failed" >&2
  exit 1
fi
expect_field "$FIXTURE_OUT/secret.json" "error" "secret_like_input_rejected"
expect_field "$FIXTURE_OUT/secret.json" "valuesPrinted" "false"
expect_field "$FIXTURE_OUT/secret.json" "valuesStored" "false"
printf 'ok secret_rejection\n'

run_json ledger ledger --limit 10

# --- isolation proof -------------------------------------------------------
# 1. Every provider process that ran was a fixture CLI. Non-fixture or zero
#    invocations fail this check.
"$NODE_BIN" "$FAKE_HELPER" --audit-check "$AUDIT" >/dev/null
# 2. The paid generation and deletion operations reached their fixtures.
"$NODE_BIN" "$FAKE_HELPER" --audit-has "$AUDIT" pixellab "" >/dev/null
"$NODE_BIN" "$FAKE_HELPER" --audit-has "$AUDIT" runware "" >/dev/null
# 3. Toolbelt's own state stayed in the fixture home.
if [ "$(real_ledger_lines)" != "$REAL_LEDGER_BEFORE" ]; then
  echo "real ledger changed during a fixture-isolated run" >&2
  exit 1
fi
printf 'ok fixture_isolation\n'

echo "toolbelt smoke ok"

# --- sibling node regressions ----------------------------------------------
# Only inside the canonical guarded runner's cgroup. Direct invocation runs the
# fixture matrix above and stops; it never starts a raw node test suite.
if grep -qs 'pi-test-suite-guarded' /proc/self/cgroup 2>/dev/null; then
  run_script() {
    local name="$1" script="$2"
    "$NODE_BIN" "$script"
    printf 'ok %s\n' "$name"
  }
  run_script conformance "$TOOLBELT_ROOT/test/conformance.js"
  run_script engine "$TOOLBELT_ROOT/test/engine.js"
  run_script account-routing "$TOOLBELT_ROOT/test/account-routing.js"
  # The studio regression drives its own loopback fixture through the
  # real generated CLI, so the smoke-level CLI override is removed for it.
  unset STUDIO_CLI_PATH
  run_script studio "$TOOLBELT_ROOT/test/studio.js"
else
  printf 'skipped sibling node regressions: not inside the guarded runner cgroup\n'
  printf 'run them through: %s (with this fixture environment)\n' "$GUARDED_RUNNER"
fi
