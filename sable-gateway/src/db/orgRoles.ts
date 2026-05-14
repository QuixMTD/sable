// gateway.org_roles — many-to-many mapping of users to org roles when a
// user belongs to (or has been invited to) more than one org.

import type { Sql, UserRole } from 'sable-shared';

export interface OrgRoleRow {
  id: string;
  user_id: string;
  org_id: string;
  role: UserRole;
  invited_by: string | null;
  accepted_at: Date | null;
  created_at: Date;
}

export async function listForUser(_sql: Sql, _userId: string): Promise<OrgRoleRow[]> {
  throw new Error('TODO: implement db/orgRoles.listForUser');
}

export async function listForOrg(_sql: Sql, _orgId: string): Promise<OrgRoleRow[]> {
  throw new Error('TODO: implement db/orgRoles.listForOrg');
}
