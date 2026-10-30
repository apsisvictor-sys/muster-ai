# Runware standalone CLI staging

Safe standalone artifact for later Toolbelt wrapping. This directory intentionally does **not** modify shared Toolbelt provider/config/conformance files.

## Runtime and safety

- REST endpoint: `https://api.runware.ai/v1`
- WebSocket endpoint noted for future SDK/wrapper work: `wss://ws-api.runware.ai/v1`
- API key source: runtime env `RUNWARE_API_KEY` only
- The CLI never prints, stores, or accepts API keys/tokens/secrets as arguments.
- `--args` accepts only a non-secret JSON object for future schema metadata. Secret-shaped keys/values are rejected.
- Cost, generation, upload, and model-write commands are represented for coverage but do **not** execute API calls in this staging artifact.

## Executable/read-only commands

```bash
./runware status
./runware auth status
./runware coverage
./runware models search --query flux --limit 5
./runware task response <canonical-task-uuid> --number-results 1
./runware task details <canonical-task-uuid>
./runware task helpers
```

Read-only task types are hardcoded: `modelSearch`, `getResponse`, `getTaskDetails`. Task IDs are strictly validated as canonical UUIDs. Output is JSON and bounded/truncated.

## Full SDK taskType/capability coverage

| SDK taskType/capability | Command | Execution in standalone staging |
| --- | --- | --- |
| `authentication` | `status`, `auth status` | local status only |
| `modelSearch` | `models search` | read-only API enabled |
| `getResponse` | `task response` | read-only API enabled |
| `getTaskDetails` | `task details` | read-only API enabled |
| `imageInference` | `image generate` (`image inference`) | `approval_required` |
| `photoMaker` | `image photo-maker` (`photo-maker generate`) | `approval_required` |
| `imageUpload` | `image upload` | `approval_required` |
| `imageUpscale` | `image upscale` | `approval_required` |
| `imageBackgroundRemoval` | `image background-removal` (`image remove-background`) | `approval_required` |
| `imageCaption` | `image caption` | `approval_required` |
| `imageControlNetPreProcess` | `image controlnet-preprocess` (`image preprocess`) | `approval_required` |
| `vectorize` | `image vectorize` | `approval_required` |
| `promptEnhance` | `prompt enhance` | `approval_required` |
| `modelUpload` | `models upload` (`model upload`) | `blocked` |
| `videoInference` | `video generate` (`video inference`) | `approval_required` |
| `caption` / video caption | `video caption` (`video video-caption`) | `approval_required` |
| `removeBackground` / video background removal | `video background-removal` (`video remove-background`) | `approval_required` |
| `upscale` / video upscale | `video upscale` (`video video-upscale`) | `approval_required` |
| `3dInference` | `3d generate` (`3d inference`) | `approval_required` |
| `textInference` | `text generate` (`text inference`) | `approval_required` |
| `audioInference` | `audio generate` (`audio inference`) | `approval_required` |
| `mediaStorage` | `media storage` | `approval_required` |

`task helpers` documents SDK response helper shapes for `IAsyncTaskResponse`, `IGetResponseRequest`, and `IGetTaskDetailsRequest`.

## Smoke verification

```bash
tests/smoke.sh
```

The smoke test covers syntax, help/status, coverage classification, secret non-disclosure/rejection, UUID rejection, representative image/video/audio/3d/text approval gating, modelUpload blocking, `--args` JSON validation, task response helpers, and no-unknown classification for every covered task type. If `RUNWARE_API_KEY` is present in the environment, it also runs a live `models search --query flux --limit 1` call.

## Toolbelt integration notes

Later integration should wrap this CLI (or port its validation) behind Toolbelt approval gates:

1. Register a Runware provider/tool pointing to this artifact.
2. Keep `status`, `auth status`, `coverage`, `models search`, `task response`, `task details`, and `task helpers` as non-cost/read-only operations.
3. Gate all generation/caption/enhance/upscale/background-removal/preprocess/vectorize/upload/media-storage operations with explicit approval and cost disclosure.
4. Keep `modelUpload` blocked unless the operator explicitly enables model-write operations.
5. Preserve secret handling: `RUNWARE_API_KEY` from environment only; never provider args or logs.
6. Reuse UUID validation, bounded output behavior, and the coverage matrix in shared Toolbelt conformance/smoke tests.
