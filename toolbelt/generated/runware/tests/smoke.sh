#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -m py_compile runware_cli.py
./runware --help >/tmp/runware_help.txt
env -u RUNWARE_API_KEY ./runware status >/tmp/runware_status.txt
env -u RUNWARE_API_KEY ./runware auth status >/tmp/runware_auth_status.txt
./runware coverage >/tmp/runware_coverage.txt
./runware task helpers >/tmp/runware_helpers.txt
if grep -E 'sk-|rw_|RUNWARE_API_KEY=.*[A-Za-z0-9]' /tmp/runware_status.txt; then
  echo "status leaked secret-shaped data" >&2
  exit 1
fi
python3 - <<'PY'
import json
from pathlib import Path
coverage = json.loads(Path('/tmp/runware_coverage.txt').read_text())['coverage']
expected = {
    'authentication', 'modelSearch', 'getResponse', 'getTaskDetails', 'imageInference',
    'photoMaker', 'imageUpload', 'imageUpscale', 'imageBackgroundRemoval', 'imageCaption',
    'imageControlNetPreProcess', 'vectorize', 'promptEnhance', 'modelUpload',
    'videoInference', 'caption', 'removeBackground', 'upscale', '3dInference',
    'textInference', 'audioInference', 'mediaStorage'
}
missing = expected - set(coverage)
extra = set(coverage) - expected
if missing or extra:
    raise SystemExit(f'coverage mismatch missing={sorted(missing)} extra={sorted(extra)}')
for task_type, meta in coverage.items():
    if meta.get('execution') in {'approval_required', 'blocked'} and not meta.get('command'):
        raise SystemExit(f'missing command for {task_type}')
PY
approval_commands=(
  "image generate"
  "image photo-maker"
  "image upload"
  "image upscale"
  "image background-removal"
  "image caption"
  "image controlnet-preprocess"
  "image vectorize"
  "prompt enhance"
  "video generate"
  "video caption"
  "video background-removal"
  "video upscale"
  "3d generate"
  "text generate"
  "audio generate"
  "media storage"
)
for cmd in "${approval_commands[@]}"; do
  safe_name="${cmd// /_}"
  if ./runware $cmd --args '{"note":"schema only"}' >"/tmp/runware_${safe_name}.txt" 2>&1; then
    echo "$cmd unexpectedly succeeded" >&2
    exit 1
  fi
  grep -q 'approval_required' "/tmp/runware_${safe_name}.txt"
  grep -q 'taskType' "/tmp/runware_${safe_name}.txt"
  if grep -qi 'unknown' "/tmp/runware_${safe_name}.txt"; then
    echo "$cmd classified as unknown" >&2
    exit 1
  fi
done
if ./runware models upload >/tmp/runware_model_upload.txt 2>&1; then
  echo "model upload unexpectedly succeeded" >&2
  exit 1
fi
grep -q 'blocked' /tmp/runware_model_upload.txt
grep -q 'modelUpload' /tmp/runware_model_upload.txt
secret_args="$(printf '{"%s":"x"}' "apiKey")"
if ./runware image generate --args "$secret_args" >/tmp/runware_secret_args.txt 2>&1; then
  echo "secret-shaped --args unexpectedly accepted" >&2
  exit 1
fi
grep -q 'secret-shaped' /tmp/runware_secret_args.txt
if ./runware image generate --args '[]' >/tmp/runware_bad_args.txt 2>&1; then
  echo "non-object --args unexpectedly accepted" >&2
  exit 1
fi
grep -q 'JSON object' /tmp/runware_bad_args.txt
if ./runware task details not-a-uuid >/tmp/runware_uuid.txt 2>&1; then
  echo "invalid uuid unexpectedly accepted" >&2
  exit 1
fi
if [[ -n "${RUNWARE_API_KEY:-}" ]]; then
  ./runware models search --query flux --limit 1 >/tmp/runware_live_models.txt
else
  echo "RUNWARE_API_KEY not set; skipping live Runware API smoke" >&2
fi
