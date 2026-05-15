"""Boot config. sable-quant is the *trusted* compute engine — it does
no auth of its own beyond verifying that the caller is a Sable service
(sable-engine / sable-gateway) over signed HMAC. Keys come from env
(`HMAC_KEY_V<n>` = base64), Cloud Run-injected from Secret Manager.
No DB, no Redis: pure compute.
"""

from __future__ import annotations

import base64
import os
import re

from sable_shared.config import env_flag

_KEY_RE = re.compile(r"^HMAC_KEY_V(\d+)$")


def load_hmac_keys() -> dict[int, bytes]:
    keys: dict[int, bytes] = {}
    for name, value in os.environ.items():
        m = _KEY_RE.match(name)
        if m is None:
            continue
        try:
            keys[int(m.group(1))] = base64.b64decode(value)
        except (ValueError, TypeError):
            continue
    return keys


def service_auth_disabled() -> bool:
    """Local-dev escape hatch. NEVER set in staging/prod."""
    return env_flag("QUANT_DISABLE_SERVICE_AUTH", False)
