#!/usr/bin/env python3
"""Safe standalone Runware CLI staging artifact.

This file intentionally has no Toolbelt integration. It uses RUNWARE_API_KEY from
runtime environment only and never accepts API keys as CLI arguments.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import uuid
from dataclasses import asdict, is_dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

REST_ENDPOINT = "https://api.runware.ai/v1"
WS_ENDPOINT = "wss://ws-api.runware.ai/v1"
ENV_KEY = "RUNWARE_API_KEY"
MAX_OUTPUT_BYTES = 24_000
DEFAULT_TIMEOUT_SECONDS = 45

READ_ONLY_TASK_TYPES = {
    "model_search": "modelSearch",
    "get_response": "getResponse",
    "get_task_details": "getTaskDetails",
}

# Full Runware SDK ETaskType surface from runware/types.py plus authentication/status.
TASK_TYPE_COVERAGE: dict[str, dict[str, Any]] = {
    "authentication": {"taskType": "authentication", "command": "auth status", "class": "status", "execution": "local_status"},
    "modelSearch": {"taskType": "modelSearch", "command": "models search", "class": "read_only", "execution": "api_enabled"},
    "getResponse": {"taskType": "getResponse", "command": "task response", "class": "read_only", "execution": "api_enabled"},
    "getTaskDetails": {"taskType": "getTaskDetails", "command": "task details", "class": "read_only", "execution": "api_enabled"},
    "imageInference": {"taskType": "imageInference", "command": "image generate", "aliases": ["image inference"], "class": "generation", "execution": "approval_required"},
    "photoMaker": {"taskType": "photoMaker", "command": "image photo-maker", "aliases": ["photo-maker generate"], "class": "generation", "execution": "approval_required"},
    "imageUpload": {"taskType": "imageUpload", "command": "image upload", "class": "upload", "execution": "approval_required"},
    "imageUpscale": {"taskType": "imageUpscale", "command": "image upscale", "class": "cost", "execution": "approval_required"},
    "imageBackgroundRemoval": {"taskType": "imageBackgroundRemoval", "command": "image background-removal", "aliases": ["image remove-background"], "class": "cost", "execution": "approval_required"},
    "imageCaption": {"taskType": "imageCaption", "command": "image caption", "class": "cost", "execution": "approval_required"},
    "imageControlNetPreProcess": {"taskType": "imageControlNetPreProcess", "command": "image controlnet-preprocess", "aliases": ["image preprocess"], "class": "cost", "execution": "approval_required"},
    "vectorize": {"taskType": "vectorize", "command": "image vectorize", "class": "cost", "execution": "approval_required"},
    "promptEnhance": {"taskType": "promptEnhance", "command": "prompt enhance", "class": "cost", "execution": "approval_required"},
    "modelUpload": {"taskType": "modelUpload", "command": "models upload", "aliases": ["model upload"], "class": "model_write", "execution": "blocked"},
    "videoInference": {"taskType": "videoInference", "command": "video generate", "aliases": ["video inference"], "class": "generation", "execution": "approval_required"},
    "caption": {"taskType": "caption", "command": "video caption", "aliases": ["video video-caption"], "class": "cost", "execution": "approval_required"},
    "removeBackground": {"taskType": "removeBackground", "command": "video background-removal", "aliases": ["video remove-background"], "class": "cost", "execution": "approval_required"},
    "upscale": {"taskType": "upscale", "command": "video upscale", "aliases": ["video video-upscale"], "class": "cost", "execution": "approval_required"},
    "3dInference": {"taskType": "3dInference", "command": "3d generate", "aliases": ["3d inference"], "class": "generation", "execution": "approval_required"},
    "textInference": {"taskType": "textInference", "command": "text generate", "aliases": ["text inference"], "class": "generation", "execution": "approval_required"},
    "audioInference": {"taskType": "audioInference", "command": "audio generate", "aliases": ["audio inference"], "class": "generation", "execution": "approval_required"},
    "mediaStorage": {"taskType": "mediaStorage", "command": "media storage", "class": "upload", "execution": "approval_required"},
}

STAGED_COMMANDS: dict[tuple[str, str], str] = {}
for task_type, meta in TASK_TYPE_COVERAGE.items():
    command = meta["command"].split()
    if len(command) == 2 and meta["execution"] in {"approval_required", "blocked"}:
        STAGED_COMMANDS[(command[0], command[1])] = task_type
    for alias in meta.get("aliases", []):
        alias_parts = alias.split()
        if len(alias_parts) == 2:
            STAGED_COMMANDS[(alias_parts[0], alias_parts[1])] = task_type

UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
)
SECRET_FLAG_RE = re.compile(r"(?:api[_-]?key|token|secret|authorization|bearer|password|credential)", re.I)
SECRET_VALUE_RE = re.compile(r"^(?:sk-|rw_|pk_|eyJ)[A-Za-z0-9_\-.]{12,}$")


def reject_secret_shaped_args(argv: list[str]) -> None:
    for arg in argv[1:]:
        if SECRET_FLAG_RE.search(arg):
            fail("secret-shaped argument rejected; provide RUNWARE_API_KEY via environment only", code=64)
        if SECRET_VALUE_RE.match(arg):
            fail("secret-shaped argument rejected; provide RUNWARE_API_KEY via environment only", code=64)


def fail(message: str, *, code: int = 1, detail: Any | None = None) -> None:
    payload: dict[str, Any] = {"ok": False, "error": message}
    if detail is not None:
        payload["detail"] = detail
    emit(payload)
    raise SystemExit(code)


def bounded(obj: Any) -> str:
    text = json.dumps(to_jsonable(obj), ensure_ascii=False, indent=2, sort_keys=True)
    encoded = text.encode("utf-8")
    if len(encoded) <= MAX_OUTPUT_BYTES:
        return text
    truncated = encoded[:MAX_OUTPUT_BYTES].decode("utf-8", errors="ignore")
    return truncated + "\n...<truncated>"


def emit(obj: Any) -> None:
    print(bounded(obj))


def to_jsonable(value: Any) -> Any:
    if is_dataclass(value):
        return to_jsonable(asdict(value))
    if isinstance(value, (list, tuple)):
        return [to_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {str(k): to_jsonable(v) for k, v in value.items()}
    if hasattr(value, "__dict__") and not isinstance(value, type):
        return to_jsonable(vars(value))
    return value


def api_key() -> str:
    key = os.environ.get(ENV_KEY, "")
    if not key:
        fail(f"{ENV_KEY} is not set", code=2)
    return key


def validate_uuid(value: str) -> str:
    if not UUID_RE.match(value):
        raise argparse.ArgumentTypeError("must be a canonical UUID")
    return str(uuid.UUID(value))


def bounded_int(name: str, value: int, low: int, high: int) -> int:
    if value < low or value > high:
        fail(f"{name} must be between {low} and {high}", code=64)
    return value


def validate_no_secrets(value: Any, path: str = "args") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            key_text = str(key)
            if SECRET_FLAG_RE.search(key_text):
                fail(f"secret-shaped --args key rejected at {path}.{key_text}", code=64)
            validate_no_secrets(child, f"{path}.{key_text}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            validate_no_secrets(child, f"{path}[{index}]")
    elif isinstance(value, str):
        if SECRET_FLAG_RE.search(value) or SECRET_VALUE_RE.match(value):
            fail(f"secret-shaped --args value rejected at {path}", code=64)


def parse_args_json(raw: str | None) -> dict[str, Any]:
    if raw is None:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        fail("--args must be valid JSON", code=64, detail={"message": exc.msg, "position": exc.pos})
    if not isinstance(parsed, dict):
        fail("--args must be a JSON object", code=64)
    validate_no_secrets(parsed)
    return parsed


def post_tasks(tasks: list[dict[str, Any]], timeout: int = DEFAULT_TIMEOUT_SECONDS) -> Any:
    body = json.dumps(tasks).encode("utf-8")
    req = Request(
        REST_ENDPOINT,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key()}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "pi-runware-standalone-cli/0.2",
        },
    )
    try:
        with urlopen(req, timeout=timeout) as response:
            raw = response.read(MAX_OUTPUT_BYTES + 1)
            status = response.status
    except HTTPError as exc:
        raw = exc.read(MAX_OUTPUT_BYTES + 1)
        try:
            parsed = json.loads(raw.decode("utf-8", errors="replace"))
        except json.JSONDecodeError:
            parsed = raw.decode("utf-8", errors="replace")[:2000]
        fail("Runware API HTTP error", code=1, detail={"status": exc.code, "body": parsed})
    except URLError as exc:
        fail("Runware API connection error", code=1, detail=str(exc.reason))

    try:
        parsed = json.loads(raw.decode("utf-8", errors="replace"))
    except json.JSONDecodeError:
        fail("Runware API returned non-JSON response", detail={"status": status})
    return parsed


def command_status(_: argparse.Namespace) -> None:
    emit(
        {
            "ok": True,
            "runware_api_key_present": bool(os.environ.get(ENV_KEY)),
            "key_source": ENV_KEY,
            "rest_endpoint": REST_ENDPOINT,
            "websocket_endpoint": WS_ENDPOINT,
            "enabled_operations": ["status", "auth status", "models search", "task response", "task details"],
            "staged_operations": sorted(meta["command"] for meta in TASK_TYPE_COVERAGE.values() if meta["execution"] == "approval_required"),
            "blocked_operations": sorted(meta["command"] for meta in TASK_TYPE_COVERAGE.values() if meta["execution"] == "blocked"),
            "covered_task_types": sorted(TASK_TYPE_COVERAGE),
            "coverage_count": len(TASK_TYPE_COVERAGE),
            "notes": "API key value is never printed or accepted as an argument. Cost/upload/model-write operations are represented but not executed.",
        }
    )


def command_auth_status(args: argparse.Namespace) -> None:
    command_status(args)


def command_coverage(_: argparse.Namespace) -> None:
    emit({"ok": True, "coverage": TASK_TYPE_COVERAGE})


def command_models_search(args: argparse.Namespace) -> None:
    limit = bounded_int("limit", args.limit, 1, 50)
    offset = bounded_int("offset", args.offset, 0, 10_000)
    extra = parse_args_json(args.args)
    task: dict[str, Any] = {
        "taskType": READ_ONLY_TASK_TYPES["model_search"],
        "taskUUID": str(uuid.uuid4()),
        "limit": limit,
        "offset": offset,
    }
    if args.query:
        task["search"] = args.query[:200]
    if args.tag:
        task["tags"] = [t[:80] for t in args.tag[:10]]
    for field in ("category", "type", "architecture", "conditioning", "visibility"):
        value = getattr(args, field)
        if value:
            task[field] = value
    task.update(extra)
    emit(post_tasks([task], timeout=args.timeout))


def command_task_response(args: argparse.Namespace) -> None:
    number_results = bounded_int("number-results", args.number_results, 1, 10)
    extra = parse_args_json(args.args)
    task = {"taskType": READ_ONLY_TASK_TYPES["get_response"], "taskUUID": args.task_uuid, "numberResults": number_results}
    task.update(extra)
    emit(post_tasks([task], timeout=args.timeout))


def command_task_details(args: argparse.Namespace) -> None:
    extra = parse_args_json(args.args)
    task = {"taskType": READ_ONLY_TASK_TYPES["get_task_details"], "taskUUID": args.task_uuid}
    task.update(extra)
    emit(post_tasks([task], timeout=args.timeout))


def command_task_helpers(_: argparse.Namespace) -> None:
    emit(
        {
            "ok": True,
            "helpers": {
                "async_response": {"response_type": "IAsyncTaskResponse", "fields": {"taskType": "<taskType>", "taskUUID": "<uuid>"}},
                "get_response_request": {"taskType": "getResponse", "fields": {"taskUUID": "<uuid>", "numberResults": 1}},
                "get_task_details_request": {"taskType": "getTaskDetails", "fields": {"taskUUID": "<uuid>"}},
            },
        }
    )


def command_staged(args: argparse.Namespace) -> None:
    op = f"{args.family} {args.operation}"
    task_type = STAGED_COMMANDS.get((args.family, args.operation), "unsupported")
    if task_type == "unsupported":
        fail("unsupported operation classification", code=64, detail={"operation": op})
    meta = TASK_TYPE_COVERAGE[task_type]
    extra = parse_args_json(args.args)
    detail = {"operation": op, "canonical_command": meta["command"], "taskType": task_type, "capability_class": meta["class"], "schema": staged_schema(task_type, extra)}
    if meta["execution"] == "blocked":
        fail("blocked: model-write operation is represented but disabled in standalone staging CLI", code=4, detail=detail)
    fail("approval_required: cost/generation/upload operation is represented but disabled in standalone staging CLI", code=3, detail=detail)


def staged_schema(task_type: str, extra: dict[str, Any]) -> dict[str, Any]:
    base: dict[str, Any] = {"taskType": task_type, "taskUUID": "<uuid>"}
    if task_type in {"imageInference", "videoInference", "audioInference", "textInference", "3dInference", "photoMaker"}:
        base.update({"model": "<model-id>", "positivePrompt": "<prompt>", "numberResults": 1, "deliveryMethod": "async", "includeCost": True})
    elif task_type in {"imageUpload"}:
        base.update({"file": "<local-path-or-url>"})
    elif task_type in {"mediaStorage"}:
        base.update({"media_url": "<url>"})
    elif task_type in {"imageUpscale", "imageBackgroundRemoval", "imageCaption", "imageControlNetPreProcess", "vectorize", "caption", "removeBackground", "upscale"}:
        base.update({"input": "<media-uuid-or-url>", "includeCost": True})
    elif task_type == "promptEnhance":
        base.update({"prompt": "<prompt>", "promptVersions": 1, "includeCost": True})
    elif task_type == "modelUpload":
        base.update({"modelName": "<name>", "modelFile": "<path-or-url>", "category": "<checkpoint|lora|controlnet>"})
    if extra:
        base["args_preview"] = extra
    return base


def add_args_option(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--args", default=None, help="Non-secret JSON object reserved for future schema metadata; not sent for staged operations")


def add_staged_parser(subparsers: argparse._SubParsersAction[argparse.ArgumentParser], family: str, operation: str, help_text: str) -> None:
    op_parser = subparsers.add_parser(operation, help=help_text)
    add_args_option(op_parser)
    op_parser.set_defaults(func=command_staged, family=family, operation=operation)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="runware", description="Safe standalone Runware CLI staging artifact with full SDK taskType coverage")
    parser.add_argument("--version", action="version", version="runware standalone staging 0.2")
    sub = parser.add_subparsers(dest="command", required=True)

    status = sub.add_parser("status", help="Report environment/key presence without printing values")
    status.set_defaults(func=command_status)

    auth = sub.add_parser("auth", aliases=["authentication"], help="Authentication/status operations")
    auth_sub = auth.add_subparsers(dest="auth_command", required=True)
    auth_status = auth_sub.add_parser("status", help="Alias for top-level status; represents taskType authentication")
    auth_status.set_defaults(func=command_auth_status)

    coverage = sub.add_parser("coverage", help="Print full taskType/capability coverage matrix")
    coverage.set_defaults(func=command_coverage)

    models = sub.add_parser("models", aliases=["model"], help="Model catalog and model-write operations")
    models_sub = models.add_subparsers(dest="models_command", required=True)
    search = models_sub.add_parser("search", help="Search Runware models with taskType modelSearch")
    search.add_argument("--query", default=None, help="Search text (bounded to 200 chars)")
    search.add_argument("--tag", action="append", help="Tag filter; repeat up to 10 times")
    search.add_argument("--category", choices=["checkpoint", "lora", "controlnet"])
    search.add_argument("--type")
    search.add_argument("--architecture")
    search.add_argument("--conditioning")
    search.add_argument("--visibility", choices=["public", "private", "all"])
    search.add_argument("--limit", type=int, default=10)
    search.add_argument("--offset", type=int, default=0)
    search.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    add_args_option(search)
    search.set_defaults(func=command_models_search)
    add_staged_parser(models_sub, "models", "upload", "blocked; represents modelUpload")

    task = sub.add_parser("task", help="Task lookup and response helper operations")
    task_sub = task.add_subparsers(dest="task_command", required=True)
    response = task_sub.add_parser("response", help="Fetch task response with taskType getResponse")
    response.add_argument("task_uuid", type=validate_uuid)
    response.add_argument("--number-results", type=int, default=1)
    response.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    add_args_option(response)
    response.set_defaults(func=command_task_response)
    details = task_sub.add_parser("details", aliases=["detail"], help="Fetch task details with taskType getTaskDetails")
    details.add_argument("task_uuid", type=validate_uuid)
    details.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    add_args_option(details)
    details.set_defaults(func=command_task_details)
    helpers = task_sub.add_parser("helpers", aliases=["response-helpers"], help="Print SDK task response helper schemas")
    helpers.set_defaults(func=command_task_helpers)

    image = sub.add_parser("image", help="Image operations: generation/upload/caption/upscale/background/controlnet/vectorize")
    image_sub = image.add_subparsers(dest="operation", required=True)
    for operation in ["generate", "inference", "photo-maker", "upload", "caption", "upscale", "background-removal", "remove-background", "controlnet-preprocess", "preprocess", "vectorize"]:
        add_staged_parser(image_sub, "image", operation, "staged; returns approval_required without API execution")

    photo = sub.add_parser("photo-maker", help="Alias family for photoMaker")
    photo_sub = photo.add_subparsers(dest="operation", required=True)
    add_staged_parser(photo_sub, "photo-maker", "generate", "staged; returns approval_required without API execution")

    video = sub.add_parser("video", help="Video operations: generation/caption/upscale/background removal")
    video_sub = video.add_subparsers(dest="operation", required=True)
    for operation in ["generate", "inference", "caption", "video-caption", "upscale", "video-upscale", "background-removal", "remove-background"]:
        add_staged_parser(video_sub, "video", operation, "staged; returns approval_required without API execution")

    prompt = sub.add_parser("prompt", help="Prompt operations")
    prompt_sub = prompt.add_subparsers(dest="operation", required=True)
    add_staged_parser(prompt_sub, "prompt", "enhance", "staged; returns approval_required without API execution")

    media = sub.add_parser("media", help="Media storage/upload helper operations")
    media_sub = media.add_subparsers(dest="operation", required=True)
    add_staged_parser(media_sub, "media", "storage", "staged; returns approval_required without API execution")

    for family in ["audio", "text", "3d"]:
        fam = sub.add_parser(family, help=f"{family} generation operations")
        fam_sub = fam.add_subparsers(dest="operation", required=True)
        for operation in ["generate", "inference"]:
            add_staged_parser(fam_sub, family, operation, "staged; returns approval_required without API execution")

    return parser


def main(argv: list[str] | None = None) -> int:
    actual_argv = sys.argv if argv is None else argv
    reject_secret_shaped_args(actual_argv)
    parser = build_parser()
    args = parser.parse_args(actual_argv[1:])
    if hasattr(args, "timeout"):
        args.timeout = bounded_int("timeout", args.timeout, 1, 120)
    args.func(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
