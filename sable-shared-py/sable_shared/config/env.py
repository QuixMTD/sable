"""Env-var loading. In production, Cloud Run injects values from Secret
Manager into `os.environ`, so the path through this module is identical
in dev and prod — we read from `os.environ`. The only dev convenience is
optional `.env` loading at startup if python-dotenv is installed (kept
as an optional dep so the module itself has no runtime dependency).

Fail fast at startup: every loader raises EnvError on missing or
malformed values. A misconfigured process should never reach 'serving'.
"""

from __future__ import annotations

import os
from pathlib import Path


class EnvError(Exception):
    """Raised at startup when a required env var is missing or malformed."""


def load_dotenv_if_present(dotenv_path: str | Path = ".env") -> None:
    """Best-effort load of a .env file for local development. Silently
    returns if python-dotenv isn't installed — production paths set env
    vars directly and don't need this.
    """
    try:
        from dotenv import load_dotenv  # type: ignore[import-untyped]
    except ImportError:
        return
    load_dotenv(dotenv_path, override=False)


# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if value is None or value == "":
        raise EnvError(f"Missing required env var: {name}")
    return value


def optional_env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    return value


def require_env_int(name: str) -> int:
    raw = require_env(name)
    try:
        return int(raw)
    except ValueError as e:
        raise EnvError(f"Env var {name} is not an integer: {raw!r}") from e


def optional_env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError as e:
        raise EnvError(f"Env var {name} is not an integer: {raw!r}") from e


def env_flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    if raw.lower() in {"true", "1", "yes", "on"}:
        return True
    if raw.lower() in {"false", "0", "no", "off"}:
        return False
    raise EnvError(f"Env var {name} is not a boolean: {raw!r}")
