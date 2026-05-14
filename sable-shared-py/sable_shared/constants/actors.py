"""Actor types — mirrors the ``app.actor`` RLS session variable values.

The gateway sets ``app.actor`` per-request via ``SET LOCAL`` (see
``withRequestContext`` in TS sable-shared). RLS policies key off this var
to authorise inserts/updates that should only come from specific origins
(e.g. ``webhook`` for Stripe-driven subscription writes, ``system`` for
scheduled reconciliation, ``gateway`` for session writes).

Python services receive the actor on the forwarded ``X-Actor`` header
when relevant; otherwise they default to ``gateway`` because every
request they see has already passed gateway HMAC verification.
"""

from __future__ import annotations

from typing import Final, Literal, TypeGuard

ActorType = Literal["user", "gateway", "admin", "webhook", "system", "public"]

ACTOR_TYPES: Final[tuple[ActorType, ...]] = (
    "user",      # authenticated end-user request
    "gateway",   # gateway service-account writes (sessions, security_events, audit)
    "admin",     # admin console actions
    "webhook",   # Stripe / external webhook handlers
    "system",    # schedulers, cron jobs, background reconciliation
    "public",    # unauthenticated public endpoints (waitlist, enquiries)
)


def is_actor_type(value: object) -> TypeGuard[ActorType]:
    return isinstance(value, str) and value in ACTOR_TYPES
