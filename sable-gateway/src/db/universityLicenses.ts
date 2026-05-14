// gateway.university_licenses — per-user enrolment trail. Separate from
// users.university_id so the user can change institutions over their
// career while their cert history stays attached to them.

import { withRequestContext, type Sql, type TransactionSql } from 'sable-shared';

export type UniversityRole = 'student' | 'staff' | 'university_admin';

export interface UniversityLicenseRow {
  id: string;
  user_id: string;
  university_id: string;
  role: UniversityRole;
  verified_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

export interface CreateLicenseInput {
  userId: string;
  universityId: string;
  role: UniversityRole;
  expiresAt: Date | null;
  verifiedAt: Date | null;
}

export async function create(tx: TransactionSql, input: CreateLicenseInput): Promise<{ id: string }> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO gateway.university_licenses
      (user_id, university_id, role, verified_at, expires_at)
    VALUES
      (${input.userId}, ${input.universityId}, ${input.role}, ${input.verifiedAt}, ${input.expiresAt})
    ON CONFLICT (user_id, university_id, role) DO UPDATE
      SET verified_at = COALESCE(EXCLUDED.verified_at, university_licenses.verified_at),
          expires_at = EXCLUDED.expires_at,
          revoked_at = NULL
    RETURNING id
  `;
  return rows[0]!;
}

export async function listForUser(sql: Sql, userId: string): Promise<UniversityLicenseRow[]> {
  return withRequestContext(sql, { actor: 'user', userId }, async (tx) =>
    tx<UniversityLicenseRow[]>`
      SELECT * FROM gateway.university_licenses
      WHERE user_id = ${userId}
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY created_at DESC
    `,
  );
}
