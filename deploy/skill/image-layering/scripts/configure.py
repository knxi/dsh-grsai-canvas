#!/usr/bin/env python3
"""Interactively configure APIMart and Recraft credentials for image-layering."""

from __future__ import annotations

import getpass
import json
import os
from pathlib import Path
from urllib.parse import urlparse


SKILL_DIR = Path(__file__).resolve().parents[1]
CONFIG_DIR = SKILL_DIR / "config"
APIMART_PATH = CONFIG_DIR / "apimart_config.json"
RECRAFT_PATH = CONFIG_DIR / "recraft_config.json"
DEFAULT_APIMART_URL = "https://api.apimart.ai"
DEFAULT_SUBMIT_ENDPOINT = "/v1/images/generations"
DEFAULT_STATUS_ENDPOINT = "/v1/tasks"
DEFAULT_RECRAFT_URL = "https://external.api.recraft.ai/v1/images/vectorize"


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def write_private_json(path: Path, value: dict) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(path, 0o600)


def ask_url(label: str, default: str) -> str:
    while True:
        value = input(f"{label}（直接回车使用 {default}）：").strip() or default
        parsed = urlparse(value)
        if parsed.scheme in {"http", "https"} and parsed.netloc:
            return value.rstrip("/")
        print("URL 必须以 http:// 或 https:// 开头，请重新输入。")


def ask_secret(label: str, existing: str) -> str:
    while True:
        value = getpass.getpass(f"{label}（输入不会显示，留空则保留已有值）：").strip()
        if value:
            return value
        if existing:
            return existing
        print("首次配置不能为空，请重新输入。")


def main() -> int:
    if not (os.isatty(0) and os.isatty(2)):
        raise SystemExit(
            "错误：此配置命令必须在你自己打开的真实终端中运行，不能从聊天后台或非交互命令启动。"
        )

    apimart = read_json(APIMART_PATH)
    recraft = read_json(RECRAFT_PATH)
    print("图片分层 Skill 本机配置（Key/Token 不会显示，也不会发送到聊天窗口）。")
    apimart["base_url"] = ask_url("APIMart API URL", str(apimart.get("base_url") or DEFAULT_APIMART_URL))
    apimart["api_key"] = ask_secret("APIMart API Key", str(apimart.get("api_key") or ""))
    print("端点路径(只有换平台才需要改;直接回车保持原样。地址尾部带 /v1 也不会被拼重)")
    entered_submit = input(
        f"提交端点(回车保持 {apimart.get('submit_endpoint') or DEFAULT_SUBMIT_ENDPOINT})："
    ).strip()
    if entered_submit:
        apimart["submit_endpoint"] = entered_submit
    entered_status = input(
        f"查询端点(回车保持 {apimart.get('task_status_endpoint') or DEFAULT_STATUS_ENDPOINT}；可用 {{id}} 代表任务号)："
    ).strip()
    if entered_status:
        apimart["task_status_endpoint"] = entered_status
    apimart.setdefault("submit_endpoint", DEFAULT_SUBMIT_ENDPOINT)
    apimart.setdefault("task_status_endpoint", DEFAULT_STATUS_ENDPOINT)
    recraft["vectorize_endpoint"] = ask_url(
        "Recraft API URL", str(recraft.get("vectorize_endpoint") or DEFAULT_RECRAFT_URL)
    )
    recraft["api_token"] = ask_secret("Recraft API Key / Token", str(recraft.get("api_token") or ""))
    write_private_json(APIMART_PATH, apimart)
    write_private_json(RECRAFT_PATH, recraft)
    print("配置完成：APIMart 与 Recraft 已分别保存到本机私有配置（权限 600）。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
