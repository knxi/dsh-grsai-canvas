#!/usr/bin/env python3
"""Split one image into layers with APIMart Seedream-5.0-Pro.

Provider credentials are configured on first use through hidden terminal input;
they are never bundled in this Skill or printed to the console.
"""

from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import json
import mimetypes
import os
import re
import shutil
import ssl
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from PIL import Image, ImageFilter
from psd_tools import PSDImage
import cv2
import numpy as np

def join_api_url(base: str, endpoint: str) -> str:
    """把 base 与端点路径拼成一个 URL,重复的 `/v1` 只留一段。

    为什么要有它:端点默认自带 `/v1`(`/v1/images/generations`、`/v1/tasks`),
    而很多人填地址时习惯连 `/v1` 一起填 —— 字符串硬加就变成 `.../v1/v1/...`,
    换平台时的表现是"地址没错却怎么都连不上"。端点若本身写成完整 URL
    (`http(s)://…`)则不再拼 base,这样"提交在 A 域名、查询在 B 域名"的中转也能用。
    """
    base = (base or "").strip().rstrip("/")
    endpoint = (endpoint or "").strip()
    if not endpoint:
        return base
    if re.match(r"^https?://", endpoint, re.I):
        return endpoint.rstrip("/")
    suffix = endpoint if endpoint.startswith("/") else f"/{endpoint}"
    match = re.search(r"/(v\d+)$", base, re.I)
    if match and re.match(rf"^/{re.escape(match.group(1))}(/|$)", suffix, re.I):
        return f"{base}{suffix[len(match.group(1)) + 1:]}"
    return f"{base}{suffix}"


def load_local_config() -> dict:
    config_path = Path(__file__).resolve().parents[1] / "config" / "apimart_config.json"
    if not config_path.exists():
        return {}
    try:
        return json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Could not read APIMart config: {config_path}: {exc}") from exc


_LOCAL_CONFIG = load_local_config()
_RECRAFT_CONFIG_PATH = Path(__file__).resolve().parents[1] / "config" / "recraft_config.json"
try:
    _RECRAFT_CONFIG = json.loads(_RECRAFT_CONFIG_PATH.read_text(encoding="utf-8")) if _RECRAFT_CONFIG_PATH.exists() else {}
except (OSError, json.JSONDecodeError) as exc:
    raise RuntimeError(f"Could not read Recraft config: {_RECRAFT_CONFIG_PATH}: {exc}") from exc
API_KEY = os.environ.get("APIMART_API_KEY", str(_LOCAL_CONFIG.get("api_key", "")))
BASE_URL = os.environ.get("APIMART_BASE_URL", str(_LOCAL_CONFIG.get("base_url", "https://api.apimart.ai"))).rstrip("/")
MODEL = str(_LOCAL_CONFIG.get("model", "seedream-5-0-pro"))
TASK_CREATE_URL = join_api_url(BASE_URL, str(_LOCAL_CONFIG.get("submit_endpoint", "/v1/images/generations")))
TASK_STATUS_URL = join_api_url(BASE_URL, str(_LOCAL_CONFIG.get("task_status_endpoint", "/v1/tasks")))
DEFAULT_SIZE = "1K"
DEFAULT_OUTPUT_FORMAT = "png"
DEFAULT_POLL_INTERVAL = 5
DEFAULT_TIMEOUT = 300
MAX_SIZE_TIER = "2K"
# APIMart exposes a tier name rather than a fixed width/height. For local PSD/AI
# assembly we use the tier's long-edge budget and preserve the source aspect ratio.
# This is especially important for small portrait/landscape inputs: keeping a
# 523x732 canvas would force all downloaded layers and vector placements back
# onto a low-resolution document.
SIZE_TIER_LONG_EDGE = {"1K": 1024, "1.5K": 1536, "2K": 2048}
MAX_API_INPUT_EDGE = 2048
RECRAFT_VECTORIZE_URL = os.environ.get(
    "RECRAFT_VECTORIZE_URL",
    str(_RECRAFT_CONFIG.get("vectorize_endpoint", "https://external.api.recraft.ai/v1/images/vectorize")),
).rstrip("/")
RECRAFT_API_TOKEN = os.environ.get("RECRAFT_API_TOKEN", str(_RECRAFT_CONFIG.get("api_token", ""))).strip()
RECRAFT_MAX_EDGE = min(2048, int(_RECRAFT_CONFIG.get("max_edge", 2048)))
RECRAFT_MAX_PIXELS = min(4_194_304, int(_RECRAFT_CONFIG.get("max_pixels", 4_194_304)))
RECRAFT_MAX_BYTES = int(_RECRAFT_CONFIG.get("max_bytes", 5 * 1024 * 1024))
RECRAFT_MIN_EDGE = int(_RECRAFT_CONFIG.get("min_edge", 256))
RECRAFT_MAX_RETRIES = int(_RECRAFT_CONFIG.get("max_retries", 3))
SUCCESS_STATUSES = {"success", "completed"}
FAILED_STATUSES = {"failed", "cancelled", "canceled", "error"}


def _write_private_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _require_interactive_terminal() -> None:
    """Prevent hidden-input prompts from being launched in a non-interactive shell."""
    if not (sys.stdin.isatty() and sys.stderr.isatty()):
        raise RuntimeError(
            "首次配置需要真实可交互的终端（TTY/PTY），当前执行环境无法接收隐藏输入。"
            "请让 Agent 打开可交互终端后重新运行，或由用户在本机终端启动此 Skill；"
            "不能通过后台或非交互命令配置 API Key/Token。"
        )


def ensure_runtime_config(*, need_recraft: bool) -> None:
    """Prompt once for missing provider credentials, then refresh globals."""
    global API_KEY, BASE_URL, MODEL, TASK_CREATE_URL, TASK_STATUS_URL
    global RECRAFT_API_TOKEN, RECRAFT_VECTORIZE_URL

    if not API_KEY.strip():
        _require_interactive_terminal()
        print("首次使用图片分层 Skill，需要配置 APIMart API。")
        try:
            entered_url = input("APIMart API URL（直接回车使用 https://api.apimart.ai）：").strip()
        except EOFError as exc:
            raise RuntimeError("APIMart 配置未启动交互式终端，无法接收输入；没有保存任何凭据。") from exc
        if not entered_url:
            entered_url = "https://api.apimart.ai"
        if not is_http_url(entered_url):
            raise ValueError("API URL 必须以 http:// 或 https:// 开头")
        try:
            entered_key = getpass.getpass("APIMart API Key（输入不会显示）：").strip()
        except EOFError as exc:
            raise RuntimeError("APIMart Key 输入被非交互环境中断，没有保存任何凭据。") from exc
        if not entered_key:
            raise ValueError("API Key 不能为空")
        _LOCAL_CONFIG["base_url"] = entered_url.rstrip("/")
        _LOCAL_CONFIG["api_key"] = entered_key
        _write_private_json(Path(__file__).resolve().parents[1] / "config" / "apimart_config.json", _LOCAL_CONFIG)
        API_KEY = entered_key
        BASE_URL = entered_url.rstrip("/")
        MODEL = str(_LOCAL_CONFIG.get("model", "seedream-5-0-pro"))
        TASK_CREATE_URL = join_api_url(BASE_URL, str(_LOCAL_CONFIG.get("submit_endpoint", "/v1/images/generations")))
        TASK_STATUS_URL = join_api_url(BASE_URL, str(_LOCAL_CONFIG.get("task_status_endpoint", "/v1/tasks")))
        print("APIMart 配置已保存到本机私有配置，继续执行。")

    if need_recraft and not RECRAFT_API_TOKEN:
        _require_interactive_terminal()
        print("AI 分层还需要配置 Recraft API。")
        default_recraft_url = (
            str(_RECRAFT_CONFIG.get("vectorize_endpoint", "")).strip()
            or "https://external.api.recraft.ai/v1/images/vectorize"
        )
        try:
            entered_recraft_url = input(
                f"Recraft API URL（直接回车使用 {default_recraft_url}）："
            ).strip()
        except EOFError as exc:
            raise RuntimeError("Recraft 配置未启动交互式终端，无法接收输入；没有保存任何凭据。") from exc
        if not entered_recraft_url:
            entered_recraft_url = default_recraft_url
        if not is_http_url(entered_recraft_url):
            raise ValueError("Recraft API URL 必须以 http:// 或 https:// 开头")
        try:
            entered_token = getpass.getpass("Recraft API Key / Token（输入不会显示）：").strip()
        except EOFError as exc:
            raise RuntimeError("Recraft Key/Token 输入被非交互环境中断，没有保存任何凭据。") from exc
        if not entered_token:
            raise ValueError("Recraft API Key / Token 不能为空")
        _RECRAFT_CONFIG["vectorize_endpoint"] = entered_recraft_url.rstrip("/")
        _RECRAFT_CONFIG["api_token"] = entered_token
        _write_private_json(_RECRAFT_CONFIG_PATH, _RECRAFT_CONFIG)
        RECRAFT_VECTORIZE_URL = entered_recraft_url.rstrip("/")
        RECRAFT_API_TOKEN = entered_token
        print("Recraft 配置已保存到本机私有配置，继续执行。")


def eprint(*args: object) -> None:
    print(*args, file=sys.stderr)


def infer_mime_type(path: Path) -> str:
    mime, _ = mimetypes.guess_type(str(path))
    if mime:
        return mime
    suffix = path.suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix == ".png":
        return "image/png"
    if suffix == ".webp":
        return "image/webp"
    raise ValueError(f"Unsupported image file type: {path.suffix or '(no extension)'}")


def to_data_uri(image_path: Path) -> str:
    mime_type = infer_mime_type(image_path)
    encoded = base64.b64encode(image_path.read_bytes()).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def is_http_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"}


def http_bytes(url: str, headers: dict[str, str] | None = None, timeout: int = 180) -> bytes:
    for attempt in range(RECRAFT_MAX_RETRIES + 1):
        request = Request(url, headers=headers or {}, method="GET")
        try:
            with urlopen(request, timeout=timeout) as response:
                return response.read()
        except HTTPError as exc:
            error_body = exc.read().decode("utf-8", errors="replace")
            if exc.code in {408, 425, 429, 500, 502, 503, 504} and attempt < RECRAFT_MAX_RETRIES:
                time.sleep(2 ** attempt)
                continue
            raise RuntimeError(f"HTTP {exc.code} {exc.reason} while downloading {url}:\n{error_body}") from exc
        except (URLError, ssl.SSLError, TimeoutError, ConnectionError) as exc:
            if attempt < RECRAFT_MAX_RETRIES:
                time.sleep(2 ** attempt)
                continue
            reason = getattr(exc, "reason", exc)
            raise RuntimeError(f"Network error while downloading {url}: {reason}") from exc
    raise RuntimeError(f"Could not download {url}")


def _multipart_body(field_name: str, filename: str, content: bytes, content_type: str, fields: dict[str, str] | None = None) -> tuple[bytes, str]:
    boundary = f"----CodexRecraft{int(time.time() * 1000)}"
    chunks: list[bytes] = []
    for key, value in (fields or {}).items():
        chunks.extend([
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode(),
            str(value).encode(),
            b"\r\n",
        ])
    chunks.extend([
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="{field_name}"; filename="{filename}"\r\n'.encode(),
        f"Content-Type: {content_type}\r\n\r\n".encode(),
        content,
        b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ])
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def _recraft_svg_from_response(response_bytes: bytes, source_path: Path) -> bytes:
    stripped = response_bytes.lstrip()
    if stripped.startswith(b"<svg") or stripped.startswith(b"<?xml"):
        return response_bytes
    try:
        payload = json.loads(response_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Recraft returned neither SVG nor JSON for {source_path}") from exc

    candidates: list[object] = []
    if isinstance(payload, dict):
        for key in ("url", "image_url", "svg_url", "b64_json", "base64", "svg"):
            if key in payload:
                candidates.append(payload[key])
        for container_key in ("image", "data", "result", "output"):
            container = payload.get(container_key)
            if isinstance(container, dict):
                for key in ("url", "image_url", "svg_url", "b64_json", "base64", "svg"):
                    if key in container:
                        candidates.append(container[key])
            elif isinstance(container, list):
                for item in container:
                    if isinstance(item, dict):
                        for key in ("url", "image_url", "svg_url", "b64_json", "base64", "svg"):
                            if key in item:
                                candidates.append(item[key])
    for candidate in candidates:
        if not isinstance(candidate, str) or not candidate:
            continue
        if candidate.lstrip().startswith("<svg") or candidate.lstrip().startswith("<?xml"):
            return candidate.encode("utf-8")
        if candidate.startswith("data:image/svg+xml;base64,"):
            return base64.b64decode(candidate.split(",", 1)[1])
        if candidate.startswith("http://") or candidate.startswith("https://"):
            downloaded = http_bytes(candidate)
            if b"<svg" in downloaded[:4096]:
                return downloaded
        # Recraft's b64_json response is a raw base64 string, not a data URI.
        try:
            decoded = base64.b64decode(candidate, validate=True)
        except (ValueError, base64.binascii.Error):
            decoded = b""
        if decoded.lstrip().startswith((b"<svg", b"<?xml")):
            return decoded
    raise RuntimeError(f"Could not find an SVG URL/body in Recraft response for {source_path}: {response_bytes[:2000]!r}")


def _recraft_upload_image(src_path: Path) -> tuple[Path, float, dict[str, object]]:
    with Image.open(src_path) as image:
        rgba = image.convert("RGBA")
    original_size = rgba.size
    max_scale = min(
        RECRAFT_MAX_EDGE / max(rgba.size),
        (RECRAFT_MAX_PIXELS / (rgba.width * rgba.height)) ** 0.5,
    )
    min_scale = RECRAFT_MIN_EDGE / float(min(rgba.size))
    if min_scale > max_scale + 1e-9:
        raise RuntimeError(
            f"Recraft input aspect/size cannot satisfy its {RECRAFT_MIN_EDGE}px minimum and "
            f"{RECRAFT_MAX_EDGE}px/{RECRAFT_MAX_PIXELS}px maximums: {rgba.width}x{rgba.height}: {src_path}"
        )
    # Downscale large layers to the hard 2K edge cap. Upscale only genuinely
    # tiny semantic layers to satisfy Recraft's minimum edge constraint. The
    # previous implementation treated every downscale as an impossible
    # min-edge violation, which is why large backgrounds could fall through to
    # the local backend.
    scale = max(min_scale, min(1.0, max_scale))
    if abs(scale - 1.0) > 1e-9:
        resized = (max(1, int(round(rgba.width * scale))), max(1, int(round(rgba.height * scale))))
        rgba = rgba.resize(resized, Image.Resampling.LANCZOS)
    upload_path = src_path.with_name(src_path.stem + "_recraft-input.png")
    rgba.save(upload_path, format="PNG", optimize=True)
    if upload_path.stat().st_size > RECRAFT_MAX_BYTES:
        # PNG can be larger than the documented limit for textured layers.
        # Keep alpha and downscale proportionally until the request is legal.
        while upload_path.stat().st_size > RECRAFT_MAX_BYTES and min(rgba.size) > 256:
            resized = (max(1, int(round(rgba.width * 0.85))), max(1, int(round(rgba.height * 0.85))))
            rgba = rgba.resize(resized, Image.Resampling.LANCZOS)
            rgba.save(upload_path, format="PNG", optimize=True)
    if upload_path.stat().st_size > RECRAFT_MAX_BYTES:
        raise RuntimeError(
            f"Recraft input remains larger than 5 MB after safe resizing: {upload_path.stat().st_size} bytes"
        )
    return upload_path, rgba.width / original_size[0], {
        "original_size": list(original_size),
        "upload_size": list(rgba.size),
        "scale": rgba.width / original_size[0],
        "bytes": upload_path.stat().st_size,
    }


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _recraft_cache_path(svg_path: Path) -> Path:
    return svg_path.with_name(svg_path.name + ".recraft.json")


def _read_recraft_cache(svg_path: Path, trace_input_png: Path) -> dict[str, object] | None:
    if not svg_path.exists() or not _recraft_cache_path(svg_path).exists():
        return None
    try:
        meta = json.loads(_recraft_cache_path(svg_path).read_text(encoding="utf-8"))
        if meta.get("backend") != "recraft" or meta.get("source_sha256") != _file_sha256(trace_input_png):
            return None
        validate_traced_svg(svg_path, trace_input_png, "detail")
        return meta
    except (OSError, ValueError, json.JSONDecodeError, RuntimeError):
        return None


def vectorize_png_to_recraft_svg(src_path: Path, svg_path: Path) -> tuple[Path, dict[str, object]]:
    if not RECRAFT_API_TOKEN:
        raise RuntimeError(
            "Recraft vectorization was requested but RECRAFT_API_TOKEN is not set. "
            "Create an API token in Recraft, then set it in PowerShell with "
            '$env:RECRAFT_API_TOKEN="..." before running the Skill.'
        )
    upload_path, scale, resize_info = _recraft_upload_image(src_path)
    body, content_type = _multipart_body(
        "file", upload_path.name, upload_path.read_bytes(), "image/png",
        {
            # Use base64 to avoid a second result-URL download. This is an
            # officially supported response format for the vectorize endpoint.
            "response_format": "b64_json",
        },
    )
    request = Request(
        RECRAFT_VECTORIZE_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {RECRAFT_API_TOKEN}",
            "Content-Type": content_type,
            "Accept": "application/json, image/svg+xml",
        },
        method="POST",
    )
    response_bytes = b""
    for attempt in range(RECRAFT_MAX_RETRIES + 1):
        try:
            with urlopen(request, timeout=180) as response:
                response_bytes = response.read()
            break
        except HTTPError as exc:
            error_body = exc.read().decode("utf-8", errors="replace")
            if exc.code in {408, 425, 429, 500, 502, 503, 504} and attempt < RECRAFT_MAX_RETRIES:
                time.sleep(2 ** attempt)
                continue
            raise RuntimeError(f"Recraft vectorization failed: HTTP {exc.code} {exc.reason}\n{error_body}") from exc
        except (URLError, ssl.SSLError, TimeoutError, ConnectionError) as exc:
            if attempt < RECRAFT_MAX_RETRIES:
                time.sleep(2 ** attempt)
                continue
            reason = getattr(exc, "reason", exc)
            raise RuntimeError(f"Recraft vectorization network error: {reason}") from exc
    if not response_bytes:
        raise RuntimeError("Recraft vectorization returned an empty response")
    svg_bytes = _recraft_svg_from_response(response_bytes, src_path)
    svg_path.write_bytes(svg_bytes)
    ET.parse(svg_path)
    info = {"backend": "recraft", "upload": resize_info, "scale": scale}
    _recraft_cache_path(svg_path).write_text(
        json.dumps({**info, "source_sha256": _file_sha256(src_path)}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return svg_path, info


def resolve_task_status_url(task_id: str) -> str:
    """按配置里的查询端点拼出"查这个任务"的 URL。

    兼容三种写法:不含占位符(自动补 `/{task_id}`,即 APIMart 的 `/v1/tasks/{id}`)、
    含 `{id}` 或 `{task_id}`(按模板替换,兼容别家把任务号放在路径中间或末尾带后缀的路径)。
    """
    template = str(TASK_STATUS_URL or "")
    if "{id}" in template:
        return template.replace("{id}", task_id)
    if "{task_id}" in template:
        return template.replace("{task_id}", task_id)
    return f"{template.rstrip('/')}/{task_id}"


def http_json(url: str, method: str = "GET", payload: dict | None = None) -> dict:
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    }
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(request, timeout=60) as response:
            body = response.read().decode("utf-8")
            return json.loads(body)
    except HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} {exc.reason}\n{error_body}") from exc
    except URLError as exc:
        raise RuntimeError(f"Network error: {exc.reason}") from exc


def unwrap_response(response: dict) -> dict | list:
    """APIMart commonly returns {'code': 200, 'data': ...}; unwrap it."""
    if isinstance(response, dict) and "code" in response and "data" in response:
        return response["data"]
    return response


def extract_task_id(response: dict) -> str:
    data = unwrap_response(response)
    if isinstance(data, list) and data:
        first = data[0]
        if isinstance(first, dict) and first.get("task_id"):
            return str(first["task_id"])
    if isinstance(data, dict) and data.get("task_id"):
        return str(data["task_id"])
    if response.get("task_id"):
        return str(response["task_id"])
    raise RuntimeError(f"Could not find task id in response: {json.dumps(response, ensure_ascii=False)[:2000]}")


def build_split_prompt(prompt: str | None, target_layers: int | None) -> str | None:
    background_rule = (
        "CRITICAL PSD REQUIREMENT: Layer 1 must be a clean isolated background/backdrop layer with foreground subjects, text, logo, IP character, decorations, and products removed. "
        "Preserve exact x/y placement, width/height, and z-order as much as possible. Do not recenter, normalize, or relayout layers unless the returned bbox requires it. "
        "Return background as a separate decomposed layer named Background. Every split must include this separate Background layer."
    )
    foreground_rule = (
        "Also separate the main subject/IP/foreground content into its own useful layer whenever present, and keep each layer as close as possible to the original canvas coordinates and scale."
    )
    if target_layers is None:
        if prompt and prompt.strip():
            return f"{background_rule} {foreground_rule} User requested elements: {prompt.strip()}"
        return f"{background_rule} {foreground_rule} Automatically choose the other meaningful foreground/text/logo layers."

    if target_layers <= 0:
        raise ValueError("target_layers must be a positive integer")

    effective_layers = max(target_layers, 2)
    count_guidance = (
        f"Target approximately {effective_layers} total decomposed layers EXCLUDING the base image. "
        f"One of these {effective_layers} layers must be the clean Background layer, so allocate the remaining {effective_layers - 1} layer(s) to the most important foreground, IP, text, logo, or decorative elements without sacrificing spatial accuracy."
    )
    if prompt and prompt.strip():
        return (
            f"{background_rule} {foreground_rule} {count_guidance} "
            f"User requested elements: {prompt.strip()}"
        )
    return (
        f"{background_rule} {foreground_rule} {count_guidance} "
        "Choose the most visually important remaining layers."
    )


def normalize_size(size: str) -> str:
    """Normalize every requested APIMart tier to a hard maximum of 2K."""
    raw = str(size).strip()
    normalized = raw.upper().replace(" ", "")
    aliases = {
        "1K": "1K",
        "1.5K": "1.5K",
        "1_5K": "1.5K",
        "2K": "2K",
        # AUTO is deliberately capped so a provider-side auto policy cannot
        # silently exceed the skill's 2K ceiling.
        "AUTO": MAX_SIZE_TIER,
        "3K": MAX_SIZE_TIER,
        "4K": MAX_SIZE_TIER,
        "2048": MAX_SIZE_TIER,
        "4096": MAX_SIZE_TIER,
    }
    if normalized in aliases:
        return aliases[normalized]
    match = re.fullmatch(r"(\d+(?:\.\d+)?)K", normalized)
    if match:
        requested = float(match.group(1))
        if requested <= 1:
            return "1K"
        if requested <= 1.5:
            return "1.5K"
        return MAX_SIZE_TIER
    raise ValueError(f"Unsupported size '{size}'. Use 1K, 1.5K, or 2K; values above 2K are capped at 2K.")


def compute_target_canvas_size(
    source_canvas_size: tuple[int, int] | None,
    size_tier: str,
) -> tuple[tuple[int, int] | None, dict[str, object] | None]:
    """Choose the PSD/AI assembly canvas without losing a small source to re-scaling.

    The provider tier controls processing quality, while the PSD document needs a
    concrete rectangular canvas. For a local source whose long edge is below the
    requested tier, enlarge it once to that tier's long edge and preserve the exact
    aspect ratio. For sources already at or above the tier, retain their original
    dimensions; this avoids an unnecessary downscale. All layer bboxes are mapped
    through the same target canvas, so PSD and AI stay spatially consistent.
    """
    if source_canvas_size is None:
        return None, None
    width, height = (int(source_canvas_size[0]), int(source_canvas_size[1]))
    if width <= 0 or height <= 0:
        raise ValueError(f"Invalid source canvas size: {source_canvas_size}")

    normalized_tier = normalize_size(size_tier)
    tier_edge = SIZE_TIER_LONG_EDGE[normalized_tier]
    source_edge = max(width, height)
    if source_edge >= tier_edge:
        return (width, height), {
            "policy": "preserve-source-canvas",
            "requested_tier": normalized_tier,
            "tier_long_edge": tier_edge,
            "source_size": {"width": width, "height": height},
            "target_size": {"width": width, "height": height},
            "scale": 1.0,
            "upscaled": False,
        }

    scale = tier_edge / float(source_edge)
    target_width = max(1, int(round(width * scale)))
    target_height = max(1, int(round(height * scale)))
    return (target_width, target_height), {
        "policy": "upscale-small-source-to-tier-long-edge",
        "requested_tier": normalized_tier,
        "tier_long_edge": tier_edge,
        "source_size": {"width": width, "height": height},
        "target_size": {"width": target_width, "height": target_height},
        "scale": scale,
        "upscaled": True,
        "aspect_ratio_preserved": True,
    }


def prepare_local_api_input(
    image_path: Path,
    size_tier: str = DEFAULT_SIZE,
) -> tuple[Path, dict[str, object] | None]:
    """Normalize a local input before APIMart while retaining source geometry.

    File size in KB is not a reliable quality signal: a highly compressed JPEG/PNG
    may be small on disk but still have enough pixels, while a visually simple
    image may be large on disk. The reliable gate is pixel dimensions. We therefore
    keep inputs within the requested tier's long-edge range: downscale anything
    above the hard 2K API ceiling, and upscale sub-tier inputs to the requested
    tier long edge. The resize is done once with Lanczos; PSD/AI assembly later
    uses the same aspect-ratio-preserving target canvas.
    """
    with Image.open(image_path) as source:
        image = source.convert("RGB")
    original = image.size
    longest = max(original)
    normalized_tier = normalize_size(size_tier)
    requested_edge = SIZE_TIER_LONG_EDGE[normalized_tier]

    if longest > MAX_API_INPUT_EDGE:
        direction = "downscale-to-api-ceiling"
        scale = MAX_API_INPUT_EDGE / float(longest)
    elif longest < requested_edge:
        direction = "upscale-small-input-to-requested-tier"
        scale = requested_edge / float(longest)
    else:
        return image_path, {
            "policy": "keep-input-within-tier-range",
            "original_size": {"width": original[0], "height": original[1]},
            "api_size": {"width": original[0], "height": original[1]},
            "requested_tier": normalized_tier,
            "requested_long_edge": requested_edge,
            "max_edge": MAX_API_INPUT_EDGE,
            "scale": 1.0,
            "direction": "unchanged",
            "temporary": False,
            "file_size_bytes": image_path.stat().st_size,
            "note": "Pixel dimensions, not compressed file size, determined the normalization decision.",
        }

    resized = (max(1, int(round(original[0] * scale))), max(1, int(round(original[1] * scale))))
    image = image.resize(resized, Image.Resampling.LANCZOS)
    handle, temp_name = tempfile.mkstemp(prefix="apimart-input-", suffix="-normalized.png")
    os.close(handle)
    temp_path = Path(temp_name)
    image.save(temp_path, format="PNG", optimize=True)
    return temp_path, {
        "policy": direction,
        "original_size": {"width": original[0], "height": original[1]},
        "api_size": {"width": resized[0], "height": resized[1]},
        "requested_tier": normalized_tier,
        "requested_long_edge": requested_edge,
        "max_edge": MAX_API_INPUT_EDGE,
        "scale": scale,
        "direction": direction,
        "temporary": True,
        "file_size_bytes": image_path.stat().st_size,
        "aspect_ratio_preserved": True,
    }


def submit_task(image_ref: str, prompt: str | None, target_layers: int | None, size: str, output_format: str) -> str:
    effective_prompt = build_split_prompt(prompt, target_layers)
    payload: dict[str, object] = {
        "model": MODEL,
        "image_urls": [image_ref],
        "layer_decomposition": True,
        "size": size,
        "output_format": output_format,
    }
    if effective_prompt:
        payload["prompt"] = effective_prompt
    response = http_json(TASK_CREATE_URL, method="POST", payload=payload)
    return extract_task_id(response)


def get_task(task_id: str) -> dict:
    response = http_json(resolve_task_status_url(task_id))
    data = unwrap_response(response)
    if not isinstance(data, dict):
        raise RuntimeError(f"Unexpected task response: {json.dumps(response, ensure_ascii=False)[:2000]}")
    return data


def poll_task(task_id: str, poll_interval: int, timeout_seconds: int) -> dict:
    deadline = time.time() + timeout_seconds
    while True:
        task = get_task(task_id)
        status = str(task.get("status", "")).lower()
        progress = task.get("progress", 0)
        print(f"Status: {status or 'unknown'}; progress: {progress}%")
        if status in SUCCESS_STATUSES:
            return task
        if status in FAILED_STATUSES:
            raise RuntimeError(f"Task {status}: {json.dumps(task, ensure_ascii=False, indent=2)}")
        if time.time() >= deadline:
            raise TimeoutError(f"Timed out after {timeout_seconds} seconds while waiting for task {task_id}")
        time.sleep(poll_interval)


def save_url(url: str, destination: Path) -> None:
    request = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(request, timeout=120) as response:
        destination.write_bytes(response.read())


def choose_extension(image_info: dict, index: int, url: str) -> str:
    formats = image_info.get("output_formats")
    if isinstance(formats, list) and index < len(formats):
        fmt = str(formats[index]).lower()
        if fmt == "jpeg":
            return ".jpg"
        if fmt in {"png", "webp", "gif", "bmp", "tiff"}:
            return f".{fmt}"
    suffix = Path(urlparse(url).path).suffix
    return suffix or ".bin"


def safe_slug(value: str, fallback: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9._-]+", "-", value.strip().lower()).strip("-._")
    return slug[:64] or fallback


BACKGROUND_NAME_KEYWORDS = {
    "background", "backdrop", "clean-background", "bg", "背景", "底图", "背景层"
}
BACKGROUND_DESCRIPTION_PATTERNS = (
    "clean background",
    "isolated background",
    "background area",
    "background/backdrop",
    "backdrop layer",
    "sky background",
    "纯背景",
    "干净背景",
    "背景区域",
)
NEGATIVE_BACKGROUND_PATTERNS = (
    "no background",
    "without background",
    "excluding background",
    "not background",
    "must not include background",
)


def is_background_layer_meta(layer: dict) -> bool:
    if not isinstance(layer, dict):
        return False
    name = str(layer.get("name", "")).lower()
    desc = str(layer.get("description", "")).lower()
    if any(pattern in name or pattern in desc for pattern in NEGATIVE_BACKGROUND_PATTERNS):
        return False
    if any(keyword.lower() in name for keyword in BACKGROUND_NAME_KEYWORDS):
        return True
    return any(pattern.lower() in desc for pattern in BACKGROUND_DESCRIPTION_PATTERNS)


def extract_canvas_size(task: dict, saved_files: list[str]) -> tuple[int, int]:
    image_info = task.get("result", {}).get("images", [{}])[0]
    layers = image_info.get("layers", [])
    if isinstance(layers, list) and layers:
        base_meta = layers[0]
        size_text = str(base_meta.get("size", "")) if isinstance(base_meta, dict) else ""
        if "x" in size_text:
            try:
                w, h = size_text.lower().split("x", 1)
                return int(w), int(h)
            except ValueError:
                pass
    with Image.open(Path(saved_files[0])) as base_img:
        return base_img.size


def bbox_dimensions(layer_meta: dict) -> tuple[int, int] | None:
    bbox = layer_meta.get("bounding_box") if isinstance(layer_meta, dict) else None
    if not isinstance(bbox, dict):
        return None
    absolute = bbox.get("absolute")
    if not isinstance(absolute, list) or len(absolute) < 4:
        return None
    try:
        x1, y1, x2, y2 = [int(v) for v in absolute[:4]]
    except (TypeError, ValueError):
        return None
    width = max(1, x2 - x1)
    height = max(1, y2 - y1)
    return width, height


def paste_alpha_on_canvas(canvas: np.ndarray, alpha: np.ndarray, left: int, top: int) -> None:
    """Paste an alpha mask into a full-size canvas with clipping.

    APIMart sometimes returns cropped layer PNGs. This helper keeps the mask
    aligned to the canvas and prevents oversized layer images from spilling
    across unrelated scenic background such as grass or distant playground props.
    """
    canvas_h, canvas_w = canvas.shape[:2]
    alpha_h, alpha_w = alpha.shape[:2]
    if alpha_w <= 0 or alpha_h <= 0:
        return

    dst_x1 = max(0, left)
    dst_y1 = max(0, top)
    dst_x2 = min(canvas_w, left + alpha_w)
    dst_y2 = min(canvas_h, top + alpha_h)
    if dst_x2 <= dst_x1 or dst_y2 <= dst_y1:
        return

    src_x1 = max(0, -left)
    src_y1 = max(0, -top)
    src_x2 = src_x1 + (dst_x2 - dst_x1)
    src_y2 = src_y1 + (dst_y2 - dst_y1)
    canvas[dst_y1:dst_y2, dst_x1:dst_x2] = np.maximum(
        canvas[dst_y1:dst_y2, dst_x1:dst_x2],
        alpha[src_y1:src_y2, src_x1:src_x2],
    )


def layer_alpha_on_canvas(layer_img: Image.Image, layer_meta: dict, canvas_size: tuple[int, int]) -> np.ndarray:
    canvas_w, canvas_h = canvas_size
    alpha_img = layer_img.convert("RGBA").getchannel("A")

    if layer_img.size == canvas_size:
        return np.array(alpha_img, dtype=np.uint8)

    # Prefer the API bbox for cropped layer outputs. Some returned layer PNGs are
    # generated at a different pixel size from the bbox, so resize the alpha mask
    # into the bbox before placement instead of blindly pasting the raw bitmap.
    dims = bbox_dimensions(layer_meta)
    left, top = layer_position(layer_meta, canvas_size)
    if dims is not None:
        alpha_img = alpha_img.resize(dims, Image.Resampling.LANCZOS)

    canvas = np.zeros((canvas_h, canvas_w), dtype=np.uint8)
    paste_alpha_on_canvas(canvas, np.array(alpha_img, dtype=np.uint8), left, top)
    return canvas


def force_opaque_full_canvas(image: Image.Image, canvas_size: tuple[int, int]) -> Image.Image:
    """Return a full-canvas opaque RGBA image.

    The PSD background layer must be an independently usable scenic backdrop. A
    transparent or cropped layer is the exact failure mode the user reported.
    """
    canvas_w, canvas_h = canvas_size
    rgba = image.convert("RGBA")
    if rgba.size != canvas_size:
        full = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
        full.alpha_composite(rgba, (0, 0))
        rgba = full
    arr = np.array(rgba)
    alpha = arr[:, :, 3]
    if int(alpha.min()) < 255:
        rgb = arr[:, :, :3].copy()
        empty = alpha < 255
        if np.any(empty):
            # For any transparent holes, keep RGB data where available and make
            # it opaque. In normal path inpainting already fills the holes.
            rgb[empty] = rgb[empty]
        arr = np.dstack([rgb, np.full_like(alpha, 255)])
        rgba = Image.fromarray(arr, "RGBA")
    return rgba


def build_background_from_foreground(
    task: dict,
    output_dir: Path,
    foreground_files: list[str],
    background_hint: tuple[str, dict] | None = None,
    model_canvas_size: tuple[int, int] | None = None,
    target_canvas_size: tuple[int, int] | None = None,
    source_image_path: Path | None = None,
    foreground_layers: list[dict] | None = None,
) -> Path:
    model_canvas_size = model_canvas_size or extract_canvas_size(task, foreground_files)
    if target_canvas_size is None:
        target_canvas_size = model_canvas_size
    canvas_w, canvas_h = target_canvas_size
    base_path = source_image_path or Path(foreground_files[0])
    with Image.open(base_path) as base_img:
        base_rgb = base_img.convert("RGB")
        if base_rgb.size != target_canvas_size:
            base_rgb = base_rgb.resize(target_canvas_size, Image.Resampling.LANCZOS)

    mask = np.zeros((canvas_h, canvas_w), dtype=np.uint8)
    image_info = task.get("result", {}).get("images", [{}])[0]
    layers = foreground_layers if foreground_layers is not None else image_info.get("layers", [])
    if not isinstance(layers, list):
        layers = []

    for index, file_path in enumerate(foreground_files[1:], start=1):
        layer_meta = layers[index] if index < len(layers) and isinstance(layers[index], dict) else {}
        if isinstance(layer_meta, dict) and is_background_layer_meta(layer_meta):
            continue
        prepared_img, left, top = prepare_layer_image_for_placement(
            Path(file_path),
            layer_meta,
            model_canvas_size,
            target_canvas_size,
        )
        alpha_canvas = np.array(prepared_img.getchannel("A"), dtype=np.uint8)
        if int(alpha_canvas.max()) == 0:
            continue
        paste_alpha_on_canvas(mask, alpha_canvas, left, top)

    bg_arr = np.array(base_rgb.convert("RGBA"), dtype=np.uint8)
    if int(mask.max()) > 0:
        kernel_size = max(9, min(31, int(round(min(canvas_w, canvas_h) * 0.011))))
        if kernel_size % 2 == 0:
            kernel_size += 1
        kernel = np.ones((kernel_size, kernel_size), dtype=np.uint8)
        grown_mask = cv2.dilate((mask > 12).astype(np.uint8) * 255, kernel, iterations=1)
        soft_alpha = cv2.GaussianBlur(grown_mask.astype(np.float32) / 255.0, (0, 0), sigmaX=max(6.0, min(canvas_w, canvas_h) * 0.012))
        soft_alpha = np.clip(soft_alpha, 0.0, 1.0)[:, :, None]
        blur_radius = max(18, int(round(min(canvas_w, canvas_h) * 0.03)))
        blurred = np.array(base_rgb.filter(ImageFilter.GaussianBlur(radius=blur_radius)).convert("RGBA"), dtype=np.uint8)
        bg_arr = (bg_arr.astype(np.float32) * (1.0 - soft_alpha) + blurred.astype(np.float32) * soft_alpha).astype(np.uint8)

    bg_img = Image.fromarray(bg_arr, "RGBA")

    if background_hint is not None:
        hint_path, hint_meta = background_hint
        try:
            prepared_hint, hint_left, hint_top = prepare_layer_image_for_placement(
                Path(hint_path),
                hint_meta,
                model_canvas_size,
                target_canvas_size,
                # The provider background hint is a full-scene image, even when
                # its metadata bbox is expressed in a different coordinate
                # system. Never apply a foreground bbox scale to it.
                preserve_background=True,
            )
            bg_img.alpha_composite(prepared_hint, (hint_left, hint_top))
        except Exception as exc:
            print(f"NOTE: Could not overlay APIMart background hint: {exc}")

    bg_img = force_opaque_full_canvas(bg_img, target_canvas_size)
    background_path = output_dir / "01_background-full-scene-local.png"
    bg_img.save(background_path)
    return background_path


def make_forced_background_layer_meta(canvas_w: int, canvas_h: int, local_fallback: bool) -> dict:
    return {
        "z_index": 1,
        "name": "Background",
        "description": (
            "Forced local full-scene background layer reconstructed from the base image and the remaining foreground masks."
            if local_fallback
            else "Forced local full-scene background layer reconstructed from the base image and the remaining foreground masks."
        ),
        "output_format": "png",
        "size": f"{canvas_w}x{canvas_h}",
        "bounding_box": {"absolute": [0, 0, canvas_w, canvas_h], "normalized": [0, 0, 1000, 1000]},
        "local_fallback": True,
    }


def ensure_background_layer(
    task: dict,
    output_dir: Path,
    saved_files: list[str],
    model_canvas_size: tuple[int, int] | None = None,
    target_canvas_size: tuple[int, int] | None = None,
    source_image_path: Path | None = None,
) -> list[str]:
    image_info = task.get("result", {}).get("images", [{}])[0]
    layers = image_info.get("layers", [])
    if not isinstance(layers, list):
        layers = []

    model_canvas_size = model_canvas_size or extract_canvas_size(task, saved_files)
    if target_canvas_size is None:
        target_canvas_size = model_canvas_size

    base_file = saved_files[0]
    filtered_files = [base_file]
    filtered_layers = [layers[0] if len(layers) > 0 and isinstance(layers[0], dict) else {"z_index": 0, "name": "base", "output_format": "png"}]
    removed_any = False
    background_hint: tuple[str, dict] | None = None

    for index, file_path in enumerate(saved_files[1:], start=1):
        layer_meta = layers[index] if index < len(layers) and isinstance(layers[index], dict) else {}
        if is_background_layer_meta(layer_meta):
            removed_any = True
            # A model-marked local fallback is already known to be incomplete or
            # synthetic. Do not composite it back over the source-derived full scene.
            if background_hint is None and not bool(layer_meta.get("local_fallback")):
                background_hint = (file_path, layer_meta)
            continue
        filtered_files.append(file_path)
        filtered_layers.append(layer_meta)

    background_path = build_background_from_foreground(
        task,
        output_dir,
        filtered_files,
        background_hint=background_hint,
        model_canvas_size=model_canvas_size,
        target_canvas_size=target_canvas_size,
        source_image_path=source_image_path,
        foreground_layers=filtered_layers,
    )
    background_meta = make_forced_background_layer_meta(target_canvas_size[0], target_canvas_size[1], local_fallback=True)

    final_files = [filtered_files[0], str(background_path), *filtered_files[1:]]
    final_layers = [filtered_layers[0], background_meta, *filtered_layers[1:]]
    image_info["layers"] = final_layers

    if removed_any:
        print("WARNING: APIMart returned an incomplete background layer or no usable background layer; rebuilt a full-scene background locally for the PSD.")
        print("NOTE: Built a local full-scene background layer for PSD export to ensure the backdrop is complete.")

    return final_files


def infer_target_canvas_size(
    task: dict,
    model_canvas_size: tuple[int, int],
) -> tuple[int, int]:
    """Infer the source canvas when the caller supplies only --task-id.

    APIMart can return a low-resolution base layer while its full-scene
    background metadata retains the original canvas dimensions. Without this
    fallback, a task-id-only invocation would silently assemble a small PSD/AI
    and make every object appear undersized relative to the original.
    """
    image_info = task.get("result", {}).get("images", [{}])[0]
    layers = image_info.get("layers", [])
    if not isinstance(layers, list):
        layers = []
    model_w, model_h = model_canvas_size
    for meta in layers[1:]:
        if not isinstance(meta, dict) or not is_background_layer_meta(meta):
            continue
        bbox = valid_layer_bbox(meta)
        if bbox is None or bbox[0] != 0 or bbox[1] != 0:
            continue
        candidate = (bbox[2], bbox[3])
        if candidate[0] >= model_w and candidate[1] >= model_h and candidate != (0, 0):
            return candidate
    return model_canvas_size


def cleanup_stale_downloaded_layer_outputs(output_dir: Path) -> list[str]:
    """Remove stale root-level layer images before downloading a fresh task result.

    Reprocessing an existing task directory used to leave old ``00_base`` and
    numbered layer PNGs beside the new manifest. Any downstream consumer that
    used a glob could then assemble a mixed-generation PSD/AI, which presents
    as missing elements or a tiny top-left composition. Only names produced by
    this skill are removed; PSDs, vector outputs, reports, and unrelated user
    files are never touched.
    """
    removed: list[str] = []
    image_extensions = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"}
    pattern = re.compile(r"^(?:00_base|\d{2}_[A-Za-z0-9._-]+)$")
    for candidate in output_dir.iterdir():
        if not candidate.is_file() or candidate.suffix.lower() not in image_extensions:
            continue
        if not pattern.fullmatch(candidate.stem):
            continue
        try:
            candidate.unlink()
            removed.append(str(candidate))
        except FileNotFoundError:
            continue
    if removed:
        print(f"Removed stale downloaded layer output(s): {', '.join(removed)}")
    return removed


def cleanup_obsolete_background_outputs(output_dir: Path, keep_path: Path) -> list[str]:
    """Remove stale provider-background duplicates from the canonical output root.

    A task may first download ``01_background.png`` and then replace it with the
    source-derived full-scene background. Leaving both files in the root makes
    glob-based consumers and users prone to selecting the wrong one. Keep the
    canonical full-scene file and remove only known generated duplicates.
    """
    removed: list[str] = []
    keep_resolved = keep_path.resolve()
    for candidate in output_dir.glob("01_*background*.png"):
        try:
            if candidate.resolve() == keep_resolved:
                continue
            candidate.unlink()
            removed.append(str(candidate))
        except FileNotFoundError:
            continue
    if removed:
        print(f"Removed obsolete provider background output(s): {', '.join(removed)}")
    return removed


def validate_saved_output_contract(
    task: dict,
    saved_files: list[str],
    model_canvas_size: tuple[int, int],
    target_canvas_size: tuple[int, int],
) -> dict:
    """Validate the exact file/metadata contract before PSD or vector assembly."""
    image_info = task.get("result", {}).get("images", [{}])[0]
    layers = image_info.get("layers", [])
    if not isinstance(layers, list):
        layers = []
    if not saved_files:
        raise RuntimeError("No layer files are available after download/background normalization")
    if len(saved_files) != len(layers):
        raise RuntimeError(
            "Layer file/metadata count mismatch: "
            f"files={len(saved_files)}, metadata={len(layers)}. "
            "Refusing to assemble PSD/AI from an ambiguous or stale file set."
        )
    resolved = [str(Path(p).resolve()) for p in saved_files]
    if len(set(resolved)) != len(resolved):
        raise RuntimeError("Duplicate layer file paths detected; refusing ambiguous PSD/AI assembly")
    missing = [p for p in saved_files if not Path(p).exists()]
    if missing:
        raise RuntimeError(f"Downloaded layer file(s) missing before assembly: {missing}")

    placements: list[dict[str, object]] = []
    for index, file_path in enumerate(saved_files[1:], start=1):
        meta = layers[index] if isinstance(layers[index], dict) else {}
        is_background = is_background_layer_meta(meta) or index == 1
        img, left, top = prepare_layer_image_for_placement(
            Path(file_path), meta, model_canvas_size, target_canvas_size, preserve_background=is_background
        )
        right, bottom = left + img.width, top + img.height
        if left < 0 or top < 0 or right > target_canvas_size[0] or bottom > target_canvas_size[1]:
            raise RuntimeError(
                f"Layer placement exceeds target canvas: index={index}, name={meta.get('name')}, "
                f"placement={(left, top, right, bottom)}, canvas={target_canvas_size}"
            )
        placements.append({
            "index": index,
            "name": str(meta.get("name") or Path(file_path).stem),
            "file": str(Path(file_path)),
            "is_background": is_background,
            "position": {"left": left, "top": top},
            "size": {"width": img.width, "height": img.height},
            "bbox": [left, top, right, bottom],
            "metadata_bbox": valid_layer_bbox(meta),
        })
    return {
        "model_canvas": {"width": model_canvas_size[0], "height": model_canvas_size[1]},
        "target_canvas": {"width": target_canvas_size[0], "height": target_canvas_size[1]},
        "file_count": len(saved_files),
        "placements": placements,
    }


def validate_psd_layout(
    psd_path: Path,
    task: dict,
    saved_files: list[str],
    model_canvas_size: tuple[int, int],
    target_canvas_size: tuple[int, int],
) -> dict:
    """Re-open the saved PSD and verify its actual layer geometry."""
    try:
        from psd_tools import PSDImage
        psd = PSDImage.open(psd_path)
    except Exception as exc:
        raise RuntimeError(f"Could not reopen generated PSD for validation: {psd_path}: {exc}") from exc
    expected = validate_saved_output_contract(task, saved_files, model_canvas_size, target_canvas_size)
    if tuple(psd.size) != tuple(target_canvas_size):
        raise RuntimeError(f"PSD canvas mismatch: actual={psd.size}, expected={target_canvas_size}")
    children = list(psd)
    expected_count = len(saved_files)
    if len(children) != expected_count:
        raise RuntimeError(f"PSD layer count mismatch: actual={len(children)}, expected={expected_count}")
    actual_layers: list[dict[str, object]] = []
    for index, (layer, placement) in enumerate(zip(children[1:], expected["placements"]), start=1):
        actual_bbox = tuple(int(v) for v in layer.bbox)
        expected_bbox = tuple(int(v) for v in placement["bbox"])
        if actual_bbox != expected_bbox:
            raise RuntimeError(
                f"PSD layer geometry mismatch at index {index}: actual={actual_bbox}, expected={expected_bbox}"
            )
        actual_layers.append({
            "index": index,
            "name": layer.name,
            "bbox": list(actual_bbox),
            "size": {"width": int(layer.size[0]), "height": int(layer.size[1])},
        })
    return {"canvas": {"width": psd.size[0], "height": psd.size[1]}, "layer_count": len(children), "layers": actual_layers}


def write_manifest(output_dir: Path, task: dict) -> Path:
    manifest_path = output_dir / "task-result.json"
    manifest_path.write_text(json.dumps(task, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest_path


def download_task_outputs(task: dict, output_dir: Path) -> list[str]:
    image_info = task.get("result", {}).get("images", [{}])[0]
    urls = image_info.get("url", []) or []
    if not isinstance(urls, list) or not urls:
        raise RuntimeError(f"No output URLs found in task result: {json.dumps(task, ensure_ascii=False, indent=2)}")

    layers = image_info.get("layers", [])
    if not isinstance(layers, list):
        layers = []

    saved_files: list[str] = []
    for index, url in enumerate(urls):
        ext = choose_extension(image_info, index, str(url))
        layer_meta = layers[index] if index < len(layers) and isinstance(layers[index], dict) else {}
        if index == 0:
            filename = f"00_base{ext}"
        else:
            label = safe_slug(str(layer_meta.get("name", "")), f"layer-{index:02d}")
            filename = f"{index:02d}_{label}{ext}"
        destination = output_dir / filename
        save_url(str(url), destination)
        saved_files.append(str(destination))
    return saved_files


def print_layer_summary(task: dict, saved_files: list[str]) -> None:
    image_info = task.get("result", {}).get("images", [{}])[0]
    layers = image_info.get("layers", []) if isinstance(image_info.get("layers", []), list) else []
    total_outputs = len(saved_files)
    layer_count = max(0, total_outputs - 1)
    print(f"Final outputs: {total_outputs} total; {layer_count} PSD layer file(s) plus base")
    if layers:
        print("Layer summary:")
        for index, layer in enumerate(layers):
            print(f"  {index}: z={layer.get('z_index')} name={layer.get('name', 'base')} size={layer.get('size')}")
    for file_path in saved_files:
        print(f"Saved: {file_path}")


def layer_position(layer_meta: dict, fallback_canvas_size: tuple[int, int]) -> tuple[int, int]:
    bbox = layer_meta.get("bounding_box") if isinstance(layer_meta, dict) else None
    if isinstance(bbox, dict):
        absolute = bbox.get("absolute")
        if isinstance(absolute, list) and len(absolute) >= 2:
            try:
                return max(0, int(absolute[0])), max(0, int(absolute[1]))
            except (TypeError, ValueError):
                pass
    return 0, 0


def valid_layer_bbox(layer_meta: dict) -> tuple[int, int, int, int] | None:
    bbox = layer_meta.get("bounding_box") if isinstance(layer_meta, dict) else None
    if not isinstance(bbox, dict):
        return None
    absolute = bbox.get("absolute")
    if not isinstance(absolute, list) or len(absolute) < 4:
        return None
    try:
        x1, y1, x2, y2 = [int(v) for v in absolute[:4]]
    except (TypeError, ValueError):
        return None
    if x2 <= x1 or y2 <= y1:
        return None
    return x1, y1, x2, y2


def alpha_content_bbox(image: Image.Image) -> tuple[int, int, int, int] | None:
    alpha = image.getchannel("A")
    bbox = alpha.getbbox()
    if bbox is None:
        return None
    if bbox == (0, 0, image.width, image.height):
        return None
    return bbox


def prepare_layer_image_for_placement(
    image_path: Path,
    layer_meta: dict,
    model_canvas_size: tuple[int, int],
    target_canvas_size: tuple[int, int] | None = None,
    preserve_background: bool = False,
) -> tuple[Image.Image, int, int]:
    """Normalize a returned layer into the metadata bounding box.

    APIMart may return a cropped PNG whose pixel dimensions are at the model
    output resolution rather than the logical canvas bounding-box dimensions.
    The bounding_box is the authoritative placement contract. Previously the
    code only applied that contract when model and target canvas sizes differed,
    which left objects such as a 223x149 paper plane in a 2042x1359 bitmap and
    made the composed SVG/PSD many times too large.
    """
    with Image.open(image_path) as src:
        rgba = src.convert("RGBA")

    target_canvas_size = target_canvas_size or model_canvas_size
    model_w, model_h = model_canvas_size
    target_w, target_h = target_canvas_size

    if preserve_background:
        if rgba.size != target_canvas_size:
            rgba = rgba.resize(target_canvas_size, Image.Resampling.LANCZOS)
        return rgba, 0, 0

    scale_x = target_w / model_w if model_w > 0 else 1.0
    scale_y = target_h / model_h if model_h > 0 else 1.0
    bbox = valid_layer_bbox(layer_meta)
    if bbox is not None:
        x1, y1, x2, y2 = bbox
        left = int(round(x1 * scale_x))
        top = int(round(y1 * scale_y))
        right = int(round(x2 * scale_x))
        bottom = int(round(y2 * scale_y))
        # Round the four absolute edges, not width/height independently.
        # Independent rounding can make (left + width) differ from the mapped
        # right edge by one pixel at non-integer canvas scale factors.
        desired_size = (
            max(1, right - left),
            max(1, bottom - top),
        )
        if rgba.size != desired_size:
            rgba = rgba.resize(desired_size, Image.Resampling.LANCZOS)
        return rgba, left, top

    # If metadata has no bbox, fall back to the returned alpha content bounds
    # and scale both position and dimensions with the canvas.
    left, top = layer_position(layer_meta, model_canvas_size)
    content_bbox = alpha_content_bbox(rgba)
    if content_bbox is not None:
        crop_left, crop_top, crop_right, crop_bottom = content_bbox
        rgba = rgba.crop((crop_left, crop_top, crop_right, crop_bottom))
        left += crop_left
        top += crop_top
    left = int(round(left * scale_x))
    top = int(round(top * scale_y))
    desired_size = (
        max(1, int(round(rgba.width * scale_x))),
        max(1, int(round(rgba.height * scale_y))),
    )
    if rgba.size != desired_size:
        rgba = rgba.resize(desired_size, Image.Resampling.LANCZOS)
    return rgba, left, top


def svg_placement_transform(left: int, top: int, placed_width: int, placed_height: int, svg_width: int, svg_height: int) -> tuple[str, float, float]:
    """Map an extracted SVG viewport into the exact prepared PNG rectangle.

    Do not infer this transform from the provider upload scale. Providers may
    return a vector viewport whose width/height differ from the uploaded PNG
    even when the artwork is otherwise correct. The only reliable placement
    contract is: returned SVG viewport -> prepared layer rectangle -> absolute
    canvas position.
    """
    source_width = float(svg_width or placed_width or 1)
    source_height = float(svg_height or placed_height or 1)
    scale_x = float(placed_width) / source_width
    scale_y = float(placed_height) / source_height
    transform = (
        f"translate({int(left)} {int(top)}) "
        f"scale({_fmt_svg_number(scale_x)} {_fmt_svg_number(scale_y)})"
    )
    return transform, scale_x, scale_y


def add_layer_to_psd(psd: PSDImage, image_path: Path, name: str, left: int, top: int) -> None:
    with Image.open(image_path) as src:
        image = src.convert("RGBA")
        psd.create_pixel_layer(image, name=name, left=left, top=top)


def slug_layer_name(layer_meta: dict, fallback: str) -> str:
    return safe_slug(str(layer_meta.get("name", "")) if isinstance(layer_meta, dict) else "", fallback)


def remove_uniform_matte_for_vector(src_path: Path, dest_path: Path, preserve_background: bool) -> None:
    """Prepare APIMart layer PNG for vector tracing.

    Some APIMart foreground PNGs contain a neutral gray matte around the object.
    That matte is useful for preview, but if traced it becomes a huge unwanted
    vector background. Detect a low-saturation border matte and make it
    transparent before sending the layer to Recraft. Background layers are never
    matte-cleaned.
    """
    with Image.open(src_path) as image:
        rgba = image.convert("RGBA")
    if preserve_background:
        rgba.save(dest_path)
        return

    arr = np.array(rgba)
    h, w = arr.shape[:2]
    if h < 8 or w < 8:
        rgba.save(dest_path)
        return

    border_px = max(2, min(24, int(round(min(w, h) * 0.025))))
    rgb = arr[:, :, :3].astype(np.int16)
    alpha = arr[:, :, 3]
    border = np.concatenate([
        rgb[:border_px, :, :].reshape(-1, 3),
        rgb[-border_px:, :, :].reshape(-1, 3),
        rgb[:, :border_px, :].reshape(-1, 3),
        rgb[:, -border_px:, :].reshape(-1, 3),
    ], axis=0)
    border_alpha = np.concatenate([
        alpha[:border_px, :].reshape(-1),
        alpha[-border_px:, :].reshape(-1),
        alpha[:, :border_px].reshape(-1),
        alpha[:, -border_px:].reshape(-1),
    ], axis=0)

    matte = np.median(border[border_alpha > 8] if np.any(border_alpha > 8) else border, axis=0)
    matte_spread = float(np.std(border, axis=0).mean())
    neutral = (float(np.max(matte) - np.min(matte)) <= 18) and (85 <= float(np.mean(matte)) <= 175)
    if not neutral:
        rgba.save(dest_path)
        return

    dist = np.sqrt(np.sum((rgb - matte.reshape(1, 1, 3)) ** 2, axis=2))
    saturation = np.max(rgb, axis=2) - np.min(rgb, axis=2)
    matte_mask = (dist < max(18.0, 3.5 * matte_spread)) & (saturation < 28)
    # Do not delete all low-saturation interior details; only delete matte areas
    # connected to the border.
    matte_u8 = matte_mask.astype(np.uint8) * 255
    flood = matte_u8.copy()
    ffmask = np.zeros((h + 2, w + 2), dtype=np.uint8)
    for seed in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1), (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2)]:
        if flood[seed[1], seed[0]]:
            cv2.floodFill(flood, ffmask, seed, 128)
    border_connected = flood == 128
    arr[border_connected, 3] = 0
    Image.fromarray(arr, "RGBA").save(dest_path)


def create_visual_perfect_svg(image_path: Path, svg_path: Path, name: str | None = None) -> Path:
    with Image.open(image_path) as image:
        w, h = image.size
        mime = infer_mime_type(image_path)
    encoded = base64.b64encode(image_path.read_bytes()).decode("ascii")
    title = name or image_path.stem
    svg = (
        f'<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="{w}" height="{h}" viewBox="0 0 {w} {h}">\n'
        f'  <title>{escape_xml(title)}</title>\n'
        f'  <image href="data:{mime};base64,{encoded}" x="0" y="0" width="{w}" height="{h}"/>\n'
        f'</svg>\n'
    )
    svg_path.write_text(svg, encoding="utf-8")
    return svg_path


def escape_xml(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def validate_traced_svg(svg_path: Path, trace_input_png: Path, preset: str) -> dict:
    """Validate that a vector export is path-based and not an accidental raster wrapper.

    The detail branch must contain real SVG paths and must not contain embedded images.
    This catches the exact failure mode where a visual-perfect or silhouette artifact
    is accidentally used as the AI source.
    """
    text = svg_path.read_text(encoding="utf-8", errors="replace")
    path_count = len(re.findall(r"<path\b", text, flags=re.I))
    image_count = len(re.findall(r"<image\b", text, flags=re.I))
    if path_count <= 0:
        raise RuntimeError(f"Vector trace contains no paths: {svg_path}")
    if preset in {"detail", "clean"} and image_count:
        raise RuntimeError(f"Raster image element found in path vector trace: {svg_path}")
    if not trace_input_png.exists():
        raise RuntimeError(f"Trace input was not preserved: {trace_input_png}")
    return {
        "path_count": path_count,
        "embedded_image_count": image_count,
        "is_path_only": image_count == 0 and path_count > 0,
    }


def _fmt_svg_number(value: float) -> str:
    return f"{value:.12f}".rstrip("0").rstrip(".") or "0"


def svg_inner_content(svg_path: Path) -> tuple[str, int, int, int]:
    """Extract SVG content while preserving its viewBox-to-viewport transform.

    Recraft commonly returns e.g. width=1605/height=1735 with a viewBox of
    1895x2048. Copying only the inner paths into a master SVG without applying
    this transform changes the layer geometry and is the main source of the
    previously observed size/position mismatch.
    """
    text = svg_path.read_text(encoding="utf-8")
    path_count = len(re.findall(r"<path\b", text))
    match = re.search(r"<svg\b([^>]*)>", text, flags=re.I | re.S)
    width = height = 0
    view_min_x = view_min_y = 0.0
    view_w = view_h = 0.0
    if match:
        attrs = match.group(1)
        wm = re.search(r'\bwidth="?([0-9.]+)', attrs)
        hm = re.search(r'\bheight="?([0-9.]+)', attrs)
        vm = re.search(r'\bviewBox="?([0-9eE+\-. ]+)', attrs)
        if wm:
            width = int(float(wm.group(1)))
        if hm:
            height = int(float(hm.group(1)))
        if vm:
            values = [float(v) for v in re.split(r"[ ,]+", vm.group(1).strip()) if v]
            if len(values) == 4:
                view_min_x, view_min_y, view_w, view_h = values
    if view_w <= 0 or view_h <= 0:
        view_w = float(width or 1)
        view_h = float(height or 1)
    if width <= 0:
        width = int(round(view_w))
    if height <= 0:
        height = int(round(view_h))
    start = text.find(">", match.start()) + 1 if match else 0
    end = text.rfind("</svg>")
    inner = text[start:end].strip() if end > start else text
    inner = re.sub(r"<\?xml[^>]*>\s*", "", inner, flags=re.I)
    inner = re.sub(r"<!--.*?-->\s*", "", inner, flags=re.S)

    sx = float(width) / view_w if view_w else 1.0
    sy = float(height) / view_h if view_h else 1.0
    tx = -view_min_x * sx
    ty = -view_min_y * sy
    if (abs(sx - 1.0) > 1e-9 or abs(sy - 1.0) > 1e-9 or
            abs(tx) > 1e-9 or abs(ty) > 1e-9):
        matrix = " ".join(_fmt_svg_number(v) for v in (sx, 0.0, 0.0, sy, tx, ty))
        inner = f'<g data-coordinate-normalization="viewBox-to-viewport" transform="matrix({matrix})">\n{inner}\n</g>'
    return inner, width, height, path_count


def validate_master_vector_svg(master_svg: Path) -> dict:
    """Guard the AI source against accidental raster or silhouette-only routing."""
    text = master_svg.read_text(encoding="utf-8", errors="replace")
    path_count = len(re.findall(r"<path\b", text, flags=re.I))
    image_count = len(re.findall(r"<image\b", text, flags=re.I))
    if path_count <= 0:
        raise RuntimeError(f"AI source master contains no vector paths: {master_svg}")
    if image_count:
        raise RuntimeError(f"AI source master contains embedded raster images: {master_svg}")
    return {"path_count": path_count, "embedded_image_count": image_count, "is_path_only": True}



def export_native_ai_with_illustrator(master_svg: Path, ai_path: Path) -> dict | None:
    """Create a native layered .ai through installed Illustrator when possible."""
    try:
        import win32com.client as win32
    except Exception:
        return None
    app = None
    doc = None
    initial_documents = 0
    temp_ai = ai_path.with_name(ai_path.name + ".native.tmp.ai")
    try:
        app = win32.Dispatch("Illustrator.Application")
        initial_documents = int(app.Documents.Count)
        doc = app.Open(str(master_svg))
        root_layer = doc.Layers.Item(1)
        top_groups = [
            root_layer.PageItems.Item(i)
            for i in range(1, root_layer.PageItems.Count + 1)
            if root_layer.PageItems.Item(i).Typename == "GroupItem"
        ]
        if not top_groups:
            raise RuntimeError("No top-level semantic groups found in master SVG")
        layer_names = []
        for group in reversed(top_groups):
            layer = doc.Layers.Add()
            raw_name = str(group.Name or "Vector Layer")
            name = re.sub(r"^layer\s+\d+[_ -]*", "", raw_name, flags=re.I).strip(" _-") or raw_name
            layer.Name = name[:255]
            group.Move(layer, 1)
            layer_names.append(layer.Name)
        try:
            root_layer.Delete()
        except Exception:
            try:
                root_layer.Name = "SVG Source (empty)"
            except Exception:
                pass
        ai_path.parent.mkdir(parents=True, exist_ok=True)
        doc.SaveAs(str(temp_ai))
        if not temp_ai.exists() or temp_ai.stat().st_size <= 0:
            raise RuntimeError("Illustrator returned an empty native AI file")
        data = temp_ai.read_bytes()
        if b"Adobe Illustrator" not in data[:200000] and not data.startswith(b"%!PS-Adobe"):
            raise RuntimeError("Native AI header validation failed")
        os.replace(temp_ai, ai_path)
        return {
            "container": "native-adobe-illustrator-ai",
            "exists": True,
            "size_bytes": ai_path.stat().st_size,
            "is_native_ai": True,
            "layer_count": len(layer_names),
            "layer_names": list(reversed(layer_names)),
        }
    except Exception:
        try:
            temp_ai.unlink()
        except FileNotFoundError:
            pass
        return None
    finally:
        if doc is not None:
            try:
                doc.Close(2)
            except Exception:
                pass
        if app is not None:
            try:
                if initial_documents == 0:
                    app.Quit()
            except Exception:
                pass

def validate_ai_artifact(ai_path: Path, master_svg: Path) -> dict:
    """Verify that the reported AI artifact was actually written and is usable."""
    if not ai_path.exists():
        raise RuntimeError(f"AI artifact was not created: {ai_path}")
    size = ai_path.stat().st_size
    if size <= 0:
        raise RuntimeError(f"AI artifact is empty: {ai_path}")

    data = ai_path.read_bytes()
    if b"Adobe Illustrator" in data[:200000] or data.startswith(b"%!PS-Adobe"):
        return {
            "exists": True,
            "size_bytes": size,
            "container": "native-adobe-illustrator-ai",
            "is_vector_compatible": True,
            "is_native_ai": True,
            "master_svg": str(master_svg),
        }
    if data.startswith(b"%PDF-"):
        # ReportLab output is a PDF-compatible Illustrator artifact. Check the
        # trailer marker as a cheap corruption guard without adding a hard
        # pypdf dependency to the skill runtime.
        if b"%%EOF" not in data[-4096:]:
            raise RuntimeError(f"AI PDF artifact has no EOF marker: {ai_path}")
        return {
            "exists": True,
            "size_bytes": size,
            "container": "pdf",
            "is_vector_compatible": True,
            "master_svg": str(master_svg),
        }

    # Fallback keeps the path-only SVG bytes under the .ai extension. It is
    # still Illustrator-openable in many environments, but must be reported
    # honestly as a fallback rather than a native AI file.
    text = data.decode("utf-8", errors="replace")
    path_count = len(re.findall(r"<path\b", text, flags=re.I))
    image_count = len(re.findall(r"<image\b", text, flags=re.I))
    if path_count <= 0 or image_count:
        raise RuntimeError(f"AI fallback artifact is not path-only: {ai_path}")
    return {
        "exists": True,
        "size_bytes": size,
        "container": "svg-bytes-fallback",
        "is_vector_compatible": True,
        "path_count": path_count,
        "embedded_image_count": image_count,
        "master_svg": str(master_svg),
    }


def convert_master_svg_to_ai_compatible(master_svg: Path, ai_path: Path) -> str:
    """Create native layered AI first, then use a validated compatibility fallback."""
    ai_path.parent.mkdir(parents=True, exist_ok=True)
    native = export_native_ai_with_illustrator(master_svg, ai_path)
    if native is not None:
        return "native-adobe-illustrator-ai"
    temp_pdf = ai_path.with_name(ai_path.name + ".tmp.pdf")
    temp_ai = ai_path.with_name(ai_path.name + ".tmp")
    final_pdf = ai_path.with_suffix(".pdf")
    try:
        from svglib.svglib import svg2rlg
        from reportlab.graphics import renderPDF
        from reportlab.pdfgen import canvas
        drawing = svg2rlg(str(master_svg))
        if drawing is None:
            raise RuntimeError("svglib returned no drawing")
        _, target_width, target_height, _ = svg_inner_content(master_svg)
        native_width = float(getattr(drawing, "width", 0) or 0)
        native_height = float(getattr(drawing, "height", 0) or 0)
        target_width = float(target_width or native_width)
        target_height = float(target_height or native_height)
        if target_width <= 0 or target_height <= 0 or native_width <= 0 or native_height <= 0:
            raise RuntimeError("Could not determine positive SVG canvas dimensions")
        pdf_canvas = canvas.Canvas(str(temp_pdf), pagesize=(target_width, target_height))
        pdf_canvas.saveState()
        pdf_canvas.scale(target_width / native_width, target_height / native_height)
        renderPDF.draw(drawing, pdf_canvas, 0, 0)
        pdf_canvas.restoreState()
        pdf_canvas.showPage()
        pdf_canvas.save()
        shutil.copyfile(temp_pdf, final_pdf)
        shutil.copyfile(temp_pdf, temp_ai)
        os.replace(temp_ai, ai_path)
        validate_ai_artifact(ai_path, master_svg)
        return "pdf-compatible-vector-ai"
    except Exception as exc:
        try:
            shutil.copyfile(master_svg, temp_ai)
            os.replace(temp_ai, ai_path)
            validate_ai_artifact(ai_path, master_svg)
            return f"svg-bytes-fallback-ai-extension: {exc}"
        except Exception as fallback_exc:
            raise RuntimeError(f"Could not create a usable AI artifact: {exc}; fallback failed: {fallback_exc}") from fallback_exc
    finally:
        for transient in (temp_pdf, temp_ai):
            try:
                transient.unlink()
            except FileNotFoundError:
                pass

def create_svg_and_ai_outputs(
    task: dict,
    output_dir: Path,
    saved_files: list[str],
    svg_preset: str = "detail",
    vector_backend: str = "recraft",
    ai: bool = True,
    model_canvas_size: tuple[int, int] | None = None,
    target_canvas_size: tuple[int, int] | None = None,
) -> dict:
    """Vectorize aligned PSD layers with Recraft only.

    There is intentionally no local vector fallback in this path. A missing or
    failed Recraft request must stop the AI branch instead of silently producing
    a lower-quality alternative.
    """
    if not saved_files:
        raise RuntimeError("No downloaded files are available for SVG/AI export")
    if vector_backend != "recraft":
        raise RuntimeError(
            "Local vectorization has been disabled. Use vector-backend=recraft; "
            "the AI branch will stop if Recraft is unavailable."
        )
    if not RECRAFT_API_TOKEN:
        raise RuntimeError("Recraft vectorization requires RECRAFT_API_TOKEN")
    if svg_preset != "detail":
        raise RuntimeError("Only the Recraft high-fidelity detail path is supported; local outline/clean tracing is disabled.")

    image_info = task.get("result", {}).get("images", [{}])[0]
    layers = image_info.get("layers", [])
    if not isinstance(layers, list):
        layers = []
    model_canvas_size = model_canvas_size or extract_canvas_size(task, saved_files)
    target_canvas_size = target_canvas_size or infer_target_canvas_size(task, model_canvas_size)
    validate_saved_output_contract(task, saved_files, model_canvas_size, target_canvas_size)

    vector_dir = output_dir / "vector"
    prepared_dir = vector_dir / "prepared_png"
    vector_dir.mkdir(parents=True, exist_ok=True)
    prepared_dir.mkdir(parents=True, exist_ok=True)
    canvas_w, canvas_h = target_canvas_size
    layer_records: list[dict[str, object]] = []
    master_groups: list[str] = []
    visual_master_groups: list[str] = []
    total_paths = 0
    nl = chr(10)

    for index, file_path in enumerate(saved_files[1:], start=1):
        src = Path(file_path)
        layer_meta = layers[index] if index < len(layers) and isinstance(layers[index], dict) else {}
        name = str(layer_meta.get("name") or src.stem)
        slug = slug_layer_name(layer_meta, f"layer-{index:02d}")
        is_bg = is_background_layer_meta(layer_meta) or index == 1
        prepared_png = prepared_dir / f"{index:02d}_{slug}_prepared.png"
        trace_input_png = prepared_dir / f"{index:02d}_{slug}_trace-input.png"
        prepared_img, left, top = prepare_layer_image_for_placement(
            src, layer_meta, model_canvas_size, target_canvas_size, preserve_background=is_bg
        )
        prepared_img.save(prepared_png)
        remove_uniform_matte_for_vector(prepared_png, trace_input_png, preserve_background=is_bg)
        svg_path = vector_dir / f"{index:02d}_{slug}.svg"
        visual_svg_path = vector_dir / f"{index:02d}_{slug}_visual-perfect.svg"
        cached = _read_recraft_cache(svg_path, trace_input_png)
        if cached is not None:
            backend_info = cached
            print(f"Reusing cached Recraft vector layer {index:02d}: {name}")
        else:
            print(f"Recraft vectorizing layer {index:02d}: {name}")
            _, backend_info = vectorize_png_to_recraft_svg(trace_input_png, svg_path)
        create_visual_perfect_svg(prepared_png, visual_svg_path, name=name)
        trace_validation = validate_traced_svg(svg_path, trace_input_png, "detail")
        inner, svg_w, svg_h, path_count = svg_inner_content(svg_path)
        visual_inner, visual_w, visual_h, visual_path_count = svg_inner_content(visual_svg_path)
        total_paths += path_count
        gid = f"layer_{index:02d}_{slug}"
        master_transform, master_scale_x, master_scale_y = svg_placement_transform(
            left, top, prepared_img.width, prepared_img.height, svg_w, svg_h
        )
        master_groups.append(
            f'  <g id="{escape_xml(gid)}" data-layer-name="{escape_xml(name)}" '
            f'inkscape:label="{escape_xml(name)}" inkscape:groupmode="layer" '
            f'transform="{master_transform}">' + nl + inner + nl + '  </g>'
        )
        visual_master_groups.append(
            f'  <g id="{escape_xml(gid)}_visual" data-layer-name="{escape_xml(name)}" '
            f'inkscape:label="{escape_xml(name)}" inkscape:groupmode="layer" '
            f'transform="translate({left} {top})">' + nl + visual_inner + nl + '  </g>'
        )
        layer_records.append({
            "index": index,
            "name": name,
            "source_png": str(src),
            "prepared_png": str(prepared_png),
            "trace_input_png": str(trace_input_png),
            "vector_svg": str(svg_path),
            "outline_svg": None,
            "visual_perfect_svg": str(visual_svg_path),
            "preset": "detail",
            "vector_mode": "recraft-vectorize",
            "path_count": path_count,
            "outline_path_count": 0,
            "trace_validation": trace_validation,
            "outline_validation": None,
            "visual_path_count": visual_path_count,
            "edge_smoothing": {"applied": False, "reason": "disabled for Recraft fidelity"},
            "vector_backend": "recraft",
            "backend_info": backend_info,
            "svg_coordinate_normalization": "viewBox-to-viewport, then explicit SVG-viewport-to-prepared-layer mapping",
            "position": {"left": left, "top": top},
            "placed_size": {"width": prepared_img.width, "height": prepared_img.height},
            "vector_svg_size": {"width": svg_w, "height": svg_h},
            "master_transform": master_transform,
            "master_scale": {"x": master_scale_x, "y": master_scale_y},
            "metadata_bbox": valid_layer_bbox(layer_meta),
            "is_background": is_bg,
        })

    master_svg = vector_dir / "layers_vector_master.svg"
    master_svg.write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" '
        f'version="1.1" width="{canvas_w}" height="{canvas_h}" viewBox="0 0 {canvas_w} {canvas_h}">\n'
        '  <title>Recraft layered vector export for Adobe Illustrator</title>\n'
        '  <desc>Path-only Recraft vectors grouped to the validated PSD canvas.</desc>\n'
        + "\n".join(master_groups) + "\n</svg>\n",
        encoding="utf-8",
    )
    ET.parse(master_svg)
    visual_master_svg = vector_dir / "layers_visual_master.svg"
    visual_master_svg.write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" '
        f'version="1.1" width="{canvas_w}" height="{canvas_h}" viewBox="0 0 {canvas_w} {canvas_h}">\n'
        '  <title>Raster reference export; not used for AI</title>\n'
        '  <desc>Visual reference only. The AI file is generated from layers_vector_master.svg.</desc>\n'
        + "\n".join(visual_master_groups) + "\n</svg>\n",
        encoding="utf-8",
    )
    ET.parse(visual_master_svg)
    master_validation = validate_master_vector_svg(master_svg)
    ai_path = vector_dir / "layers_vector_master.ai"
    ai_method = None
    ai_validation = None
    if ai:
        ai_method = convert_master_svg_to_ai_compatible(master_svg, ai_path)
        ai_validation = validate_ai_artifact(ai_path, master_svg)
    report = {
        "method": "Recraft image vectorization per aligned PSD/PNG layer; detailed Recraft master is the sole AI source",
        "source_task_id": task.get("taskId") or task.get("task_id") or task.get("id"),
        "canvas": {"width": canvas_w, "height": canvas_h},
        "master_svg": str(master_svg),
        "outline_master_svg": None,
        "visual_master_svg": str(visual_master_svg),
        "ai_source_svg": str(master_svg) if ai else None,
        "ai_source_layer_svgs": [rec["vector_svg"] for rec in layer_records] if ai else None,
        "ai_source_mode": "recraft-detailed-traced-vector-master-svg" if ai else None,
        "svg_preset": "detail",
        "vector_backend": "recraft",
        "vector_fallback_disabled": True,
        "recraft_max_input_edge": RECRAFT_MAX_EDGE,
        "ai_file": str(ai_path) if ai else None,
        "ai_method": ai_method,
        "ai_source_is_path_only": True if ai else None,
        "ai_validation": ai_validation,
        "coordinate_contract": "Each layer is mapped from APIMart metadata bbox to the target PSD canvas, then the Recraft SVG viewport is explicitly mapped into that prepared rectangle.",
        "master_validation": master_validation,
        "total_path_count": total_paths,
        "layers": layer_records,
        "reality_note": "Recraft is the only vector backend. If it fails, the AI branch fails rather than falling back to local tracing. Raster-to-vector output remains an approximation for arbitrary pixels.",
    }
    report_path = vector_dir / "vector-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Saved layered SVG: {master_svg}")
    print(f"Saved visual reference SVG: {visual_master_svg}")
    if ai:
        print(f"Saved Illustrator-compatible AI file: {ai_path} [{ai_method}] source=Recraft traced master SVG")
    print(f"Saved vector report: {report_path}")
    return report


def create_psd_from_outputs(

    task: dict,
    output_dir: Path,
    saved_files: list[str],
    psd_name: str = "layers.psd",
    model_canvas_size: tuple[int, int] | None = None,
    target_canvas_size: tuple[int, int] | None = None,
    source_image_path: Path | None = None,
) -> Path:
    if not saved_files:
        raise RuntimeError("No downloaded files are available for PSD assembly")

    image_info = task.get("result", {}).get("images", [{}])[0]
    layers = image_info.get("layers", [])
    if not isinstance(layers, list):
        layers = []

    model_canvas_size = model_canvas_size or extract_canvas_size(task, saved_files)
    if target_canvas_size is None:
        target_canvas_size = infer_target_canvas_size(task, model_canvas_size)
    validate_saved_output_contract(task, saved_files, model_canvas_size, target_canvas_size)

    base_path = source_image_path or Path(saved_files[0])
    with Image.open(base_path) as base_img:
        base_rgba = base_img.convert("RGBA")
        if base_rgba.size != target_canvas_size:
            base_rgba = base_rgba.resize(target_canvas_size, Image.Resampling.LANCZOS)
        psd = PSDImage.new("RGB", target_canvas_size, color=(255, 255, 255))

    psd.create_pixel_layer(base_rgba, name="00_base", left=0, top=0)

    for index, file_path in enumerate(saved_files[1:], start=1):
        layer_meta = layers[index] if index < len(layers) and isinstance(layers[index], dict) else {}
        name = str(layer_meta.get("name") or Path(file_path).stem)
        is_background = is_background_layer_meta(layer_meta) or index == 1
        layer_img, left, top = prepare_layer_image_for_placement(
            Path(file_path),
            layer_meta,
            model_canvas_size,
            target_canvas_size,
            preserve_background=is_background,
        )
        psd.create_pixel_layer(layer_img, name=f"{index:02d}_{name}", left=left, top=top)

    psd_path = output_dir / psd_name
    psd.save(psd_path)
    return psd_path


def write_psd_readme(output_dir: Path, psd_path: Path, task: dict) -> Path:
    image_info = task.get("result", {}).get("images", [{}])[0]
    layers = image_info.get("layers", []) if isinstance(image_info.get("layers", []), list) else []
    lines = [
        "# PSD Assembly Notes",
        "",
        f"PSD: {psd_path.name}",
        "",
        "Layer order follows APIMart z_index/order. The first layer is the base image.",
        "",
        "## Layers",
    ]
    for index, layer in enumerate(layers):
        name = layer.get("name", "base") if isinstance(layer, dict) else "unknown"
        desc = layer.get("description", "") if isinstance(layer, dict) else ""
        bbox = layer.get("bounding_box", {}) if isinstance(layer, dict) else {}
        lines.append(f"- {index}: {name}; size={layer.get('size') if isinstance(layer, dict) else ''}; bbox={bbox}; {desc}")
    readme = output_dir / "PSD_README.md"
    readme.write_text("\n".join(lines), encoding="utf-8")
    return readme


def build_hidden_payload(image_ref: str, prompt: str | None, target_layers: int | None, size: str, output_format: str) -> dict:
    effective_prompt = build_split_prompt(prompt, target_layers)
    payload: dict[str, object] = {
        "model": MODEL,
        "image_urls": ["<data-uri-hidden>" if image_ref.startswith("data:") else image_ref],
        "layer_decomposition": True,
        "size": size,
        "output_format": output_format,
    }
    if effective_prompt:
        payload["prompt"] = effective_prompt
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="图片分层：将单张图片拆成透明图层并输出 PSD、SVG 或 AI")
    parser.add_argument("image", nargs="?", help="Local image path or http(s) image URL. Omit when using --task-id.")
    parser.add_argument("--task-id", default=None, help="Existing APIMart task id to poll/download without submitting again")
    parser.add_argument("--prompt", default=None, help="Optional split guidance prompt for named elements or regions")
    parser.add_argument("--target-layers", type=int, default=None, help="Best-effort target layer count such as 2, 3, 4, or 5")
    parser.add_argument("--size", default=DEFAULT_SIZE, help="Layer split size tier: 1K, 1.5K, or 2K. Any value above 2K (including auto/3K/4K) is capped at 2K.")
    parser.add_argument("--output-format", default=DEFAULT_OUTPUT_FORMAT, choices=["jpeg", "png"], help="Base image output format")
    parser.add_argument("--output-dir", default="apimart-split-output", help="Directory for downloaded results")
    parser.add_argument("--no-psd", action="store_false", dest="psd", help="Skip PSD assembly and keep PNG outputs only")
    parser.add_argument("--psd-name", default="layers.psd", help="PSD filename to create inside the task output directory")
    parser.add_argument("--no-svg", action="store_false", dest="svg", help="Skip per-layer SVG and Illustrator-compatible AI export")
    parser.add_argument("--no-ai", action="store_false", dest="ai", help="Skip Illustrator-compatible .ai export while still creating SVG outputs")
    parser.add_argument("--svg-preset", default="detail", choices=["detail"], help="Recraft high-fidelity vectorization path. Local clean/outline tracing is disabled.")
    parser.add_argument("--vector-backend", default="recraft", choices=["recraft"], help="Required SVG backend after PSD assembly. Recraft is mandatory; there is no local fallback.")
    parser.add_argument("--psd-approved", action="store_true", help="Explicit human approval that the generated PSD passed visual QA. Required on the second run before any Recraft request; use with --task-id.")
    parser.set_defaults(psd=True, svg=True, ai=True)
    parser.add_argument("--poll-interval", type=int, default=DEFAULT_POLL_INTERVAL, help="Seconds between task polls")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="Total seconds to wait for completion")
    parser.add_argument("--dry-run", action="store_true", help="Print the request payload without submitting")
    args = parser.parse_args()

    if args.target_layers is not None and args.target_layers <= 0:
        raise ValueError("--target-layers must be a positive integer")
    if args.svg and not args.psd:
        raise ValueError("AI/SVG output requires the PSD branch; do not use --no-psd with vector output")
    if args.psd_approved and not args.task_id:
        raise ValueError("--psd-approved is a resume flag and requires --task-id after the PSD has been reviewed")
    args.size = normalize_size(args.size)
    if not args.dry_run:
        ensure_runtime_config(need_recraft=bool(args.svg))

    source_image_path: Path | None = None
    source_canvas_size: tuple[int, int] | None = None
    input_normalization: dict[str, object] | None = None
    if args.image and not is_http_url(args.image):
        source_image_path = Path(args.image).expanduser().resolve()
        if not source_image_path.exists():
            raise FileNotFoundError(f"Image not found: {source_image_path}")
        with Image.open(source_image_path) as source_img:
            source_canvas_size = source_img.size

    if args.task_id:
        task_id = args.task_id
        print(f"Using existing task: {task_id}")
        task = poll_task(task_id, poll_interval=args.poll_interval, timeout_seconds=args.timeout)
    else:
        if not args.image:
            raise ValueError("Provide an image path/URL or --task-id")
        if is_http_url(args.image):
            image_ref = args.image
            input_desc = args.image
            print(f"Using remote image URL; Recraft vector uploads remain capped at {RECRAFT_MAX_EDGE}px maximum edge.")
        else:
            api_input_path, input_normalization = prepare_local_api_input(source_image_path, args.size)
            image_ref = to_data_uri(api_input_path)
            input_desc = str(source_image_path)
            if input_normalization:
                if input_normalization.get("direction") == "upscale-small-input-to-requested-tier":
                    print(f"Small input enlarged before APIMart split: {input_normalization['original_size']} -> {input_normalization['api_size']} (tier {args.size}; aspect ratio preserved).")
                elif input_normalization.get("direction") == "downscale-to-api-ceiling":
                    print(f"Large input compressed for APIMart API: {input_normalization['original_size']} -> {input_normalization['api_size']} (max edge {MAX_API_INPUT_EDGE}px). Original canvas geometry will be retained for PSD placement.")
                if bool(input_normalization.get("temporary")):
                    try:
                        api_input_path.unlink()
                    except FileNotFoundError:
                        pass

        if args.dry_run:
            print(json.dumps(build_hidden_payload(image_ref, args.prompt, args.target_layers, args.size, args.output_format), ensure_ascii=False, indent=2))
            return 0

        mode_label = "auto split" if not args.prompt and args.target_layers is None else (f"target-layer split ({args.target_layers})" if args.target_layers is not None else "guided split")
        print(f"Submitting split task for: {input_desc} [{mode_label}]")
        task_id = submit_task(image_ref=image_ref, prompt=args.prompt, target_layers=args.target_layers, size=args.size, output_format=args.output_format)
        print(f"Task submitted: {task_id}")
        task = poll_task(task_id, poll_interval=args.poll_interval, timeout_seconds=args.timeout)

    output_dir = Path(args.output_dir).expanduser().resolve() / task_id
    output_dir.mkdir(parents=True, exist_ok=True)
    cleanup_stale_downloaded_layer_outputs(output_dir)
    saved_files = download_task_outputs(task, output_dir)
    model_canvas_size = extract_canvas_size(task, saved_files)
    if source_canvas_size is not None:
        target_canvas_size, canvas_normalization = compute_target_canvas_size(source_canvas_size, args.size)
    else:
        target_canvas_size = infer_target_canvas_size(task, model_canvas_size)
        canvas_normalization = {
            "policy": "task-metadata-or-model-canvas",
            "requested_tier": args.size,
            "source_size": None,
            "target_size": {"width": target_canvas_size[0], "height": target_canvas_size[1]},
            "scale": 1.0,
            "upscaled": False,
            "warning": "Original source dimensions were unavailable; pass the original image path when strict canvas geometry is required.",
        }
    if target_canvas_size is None:
        raise RuntimeError("Could not determine a target PSD/AI canvas size")
    saved_files = ensure_background_layer(
        task, output_dir, saved_files, model_canvas_size=model_canvas_size,
        target_canvas_size=target_canvas_size, source_image_path=source_image_path
    )
    cleanup_obsolete_background_outputs(output_dir, Path(saved_files[1]))
    if input_normalization:
        (output_dir / "input-normalization.json").write_text(json.dumps(input_normalization, ensure_ascii=False, indent=2), encoding="utf-8")
    if canvas_normalization:
        (output_dir / "canvas-normalization.json").write_text(json.dumps(canvas_normalization, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"PSD/AI target canvas: {canvas_normalization['source_size']} -> {canvas_normalization['target_size']} (tier {args.size}; aspect ratio preserved)")
    placement_report = validate_saved_output_contract(task, saved_files, model_canvas_size, target_canvas_size)
    (output_dir / "placement-report.json").write_text(json.dumps(placement_report, ensure_ascii=False, indent=2), encoding="utf-8")
    manifest = write_manifest(output_dir, task)
    print(f"Saved manifest: {manifest}")
    print_layer_summary(task, saved_files)
    psd_path: Path | None = None
    psd_validation: dict[str, object] | None = None
    if args.psd:
        psd_path = create_psd_from_outputs(
            task, output_dir, saved_files, psd_name=args.psd_name,
            model_canvas_size=model_canvas_size, target_canvas_size=target_canvas_size,
            source_image_path=source_image_path
        )
        psd_validation = validate_psd_layout(psd_path, task, saved_files, model_canvas_size, target_canvas_size)
        (output_dir / "psd-layout-report.json").write_text(json.dumps(psd_validation, ensure_ascii=False, indent=2), encoding="utf-8")
        readme_path = write_psd_readme(output_dir, psd_path, task)
        print(f"Saved PSD: {psd_path}")
        print(f"Saved PSD notes: {readme_path}")
    if args.svg:
        if psd_path is None or psd_validation is None:
            raise RuntimeError("PSD quality gate cannot run because PSD validation did not complete")
        review_path = output_dir / "psd-review.json"
        if not args.psd_approved:
            review = {
                "status": "awaiting_human_review",
                "task_id": task_id,
                "psd": str(psd_path),
                "psd_layout_report": str(output_dir / "psd-layout-report.json"),
                "canvas": psd_validation.get("canvas"),
                "layer_count": psd_validation.get("layer_count"),
                "instruction": "Open and visually inspect the PSD. Re-run with --task-id <task_id> --psd-approved only after confirming the PSD is acceptable. No Recraft request was sent in this run.",
            }
            review_path.write_text(json.dumps(review, ensure_ascii=False, indent=2), encoding="utf-8")
            print("PSD quality gate: WAITING FOR HUMAN REVIEW")
            print(f"Review PSD: {psd_path}")
            print(f"After approval, rerun with: --task-id {task_id} --psd-approved and the original image path if its source dimensions must be preserved.")
            return 0
        approved_review = {
            "status": "approved",
            "task_id": task_id,
            "approved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "psd": str(psd_path),
            "psd_layout_report": str(output_dir / "psd-layout-report.json"),
            "canvas": psd_validation.get("canvas"),
            "layer_count": psd_validation.get("layer_count"),
        }
        review_path.write_text(json.dumps(approved_review, ensure_ascii=False, indent=2), encoding="utf-8")
        print("PSD quality gate: HUMAN APPROVAL RECEIVED; starting Recraft vectorization.")
        create_svg_and_ai_outputs(
            task, output_dir, saved_files, svg_preset=args.svg_preset,
            vector_backend=args.vector_backend, ai=args.ai,
            model_canvas_size=model_canvas_size, target_canvas_size=target_canvas_size
        )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        eprint(f"Error: {exc}")
        raise SystemExit(1)
