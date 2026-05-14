"""Role constants. Source of truth (mirrored from the gateway schema):

    users.role           CHECK (... IN ('owner','admin','analyst','trader','viewer'))
    admin_accounts.admin_role
                         CHECK (... IN ('super_admin','support','operations','sales'))

User roles are firm-internal — assigned by org owners/admins to seats.
Admin roles are Sable-internal — assigned by super_admins to staff
accounts.
"""

from __future__ import annotations

from typing import Final, Literal, TypeGuard

# ---------------------------------------------------------------------------
# User roles (org-internal)
# ---------------------------------------------------------------------------

UserRole = Literal["owner", "admin", "analyst", "trader", "viewer"]

USER_ROLES: Final[tuple[UserRole, ...]] = ("owner", "admin", "analyst", "trader", "viewer")


def is_user_role(value: object) -> TypeGuard[UserRole]:
    return isinstance(value, str) and value in USER_ROLES


OwnerOrAdminRole = Literal["owner", "admin"]

OWNER_OR_ADMIN_ROLES: Final[tuple[OwnerOrAdminRole, ...]] = ("owner", "admin")


def is_owner_or_admin(role: UserRole | None) -> bool:
    """Mirrors the ``app_is_owner_or_admin()`` helper in gateway-schema.sql."""
    return role in OWNER_OR_ADMIN_ROLES


# ---------------------------------------------------------------------------
# Admin roles (Sable-internal staff)
# ---------------------------------------------------------------------------

AdminRole = Literal["super_admin", "support", "operations", "sales"]

ADMIN_ROLES: Final[tuple[AdminRole, ...]] = ("super_admin", "support", "operations", "sales")


def is_admin_role(value: object) -> TypeGuard[AdminRole]:
    return isinstance(value, str) and value in ADMIN_ROLES
