"""Paid modules a user / org can subscribe to. Source of truth: gateway DB
— ``subscriptions.module CHECK (... IN ('sc','re','crypto','alt','tax'))``
and ``users.active_modules`` / ``organisations.active_modules``.
"""

from __future__ import annotations

from typing import Final, Literal, TypeGuard

ModuleCode = Literal["sc", "re", "crypto", "alt", "tax"]

MODULE_CODES: Final[tuple[ModuleCode, ...]] = ("sc", "re", "crypto", "alt", "tax")


def is_module_code(value: object) -> TypeGuard[ModuleCode]:
    return isinstance(value, str) and value in MODULE_CODES


# Module → owning service. Used when the gateway routes a module-specific
# request to the right downstream Cloud Run service.
MODULE_SERVICES: Final[dict[ModuleCode, str]] = {
    "sc": "sable-sc",
    "re": "sable-re",
    "crypto": "sable-crypto",
    "alt": "sable-alt",
    "tax": "sable-core",  # tax module is part of sable-core, not its own service
}
