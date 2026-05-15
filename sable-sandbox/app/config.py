"""Boot config. The sandbox is dependency-free by design: no DB, no
Redis, no outbound calls. The only thing it loads is the HMAC key set
used to verify inbound service-auth from sable-engine.

Keys come from env (Cloud Run injects them from Secret Manager) as
`HMAC_KEY_V<version>` = base64(key bytes), mirroring the gateway's
convention. There's no DB fallback — that's the whole point of a
zero-dependency jail.
"""

from __future__ import annotations

import base64
import os
import re

from sable_shared.config import env_flag

_KEY_RE = re.compile(r"^HMAC_KEY_V(\d+)$")


def load_hmac_keys() -> dict[int, bytes]:
    """Scan env for HMAC_KEY_V<n> and return {version: key bytes}."""
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
    """Local-dev escape hatch. NEVER set this in staging/prod — it drops
    the HMAC requirement entirely."""
    return env_flag("SANDBOX_DISABLE_SERVICE_AUTH", False)
