// Role constants. Source of truth:
//   - users.role CHECK (... IN ('owner','admin','analyst','trader','viewer'))
//   - admin_accounts.admin_role CHECK (... IN ('super_admin','support','operations','sales'))
//
// User roles are firm-internal — assigned by org owners/admins to seats.
// Admin roles are Sable-internal — assigned by super_admins to staff accounts.

// ---------------------------------------------------------------------------
// User roles (org-internal)
// ---------------------------------------------------------------------------

export const USER_ROLES = ['owner', 'admin', 'analyst', 'trader', 'viewer'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

/**
 * Roles that can manage other users / billing within an org. Mirrors the
 * `app_is_owner_or_admin()` helper in gateway-schema.sql.
 */
export const OWNER_OR_ADMIN_ROLES = ['owner', 'admin'] as const satisfies readonly UserRole[];
export type OwnerOrAdminRole = (typeof OWNER_OR_ADMIN_ROLES)[number];

export function isOwnerOrAdmin(role: UserRole | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

// ---------------------------------------------------------------------------
// Admin roles (Sable-internal staff)
// ---------------------------------------------------------------------------

export const ADMIN_ROLES = ['super_admin', 'support', 'operations', 'sales'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && (ADMIN_ROLES as readonly string[]).includes(value);
}
