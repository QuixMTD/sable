// University programme service. Self-serve enrolment: at signup we
// look up the email domain against gateway.universities; if it matches
// (and the user marked themselves a student/staff), we set
// users.license_type + users.university_id and create a university
// license row. License grants free-tier access — billing logic reads
// `license_type` and skips the entitlement check for educational
// licenses.

import { AppError, withRequestContext, type Sql, type TransactionSql } from 'sable-shared';

import * as licensesDb from '../db/universityLicenses.js';
import type { UniversityRole } from '../db/universityLicenses.js';
import * as universitiesDb from '../db/universities.js';

const STUDENT_LICENCE_TTL_YEARS = 4;     // typical degree length

/** Extract the lowercase domain after the '@' in an email address. */
export function domainOf(email: string): string {
  const idx = email.lastIndexOf('@');
  return idx === -1 ? '' : email.slice(idx + 1).toLowerCase().trim();
}

/**
 * If `email` resolves to a partner-university domain, attach a free
 * student / staff license to the new user. Called inside the signup
 * transaction so the user-creation, university link, and licence row
 * commit together.
 */
export async function applyOnSignup(
  tx: TransactionSql,
  userId: string,
  email: string,
  preferredRole: UniversityRole = 'student',
): Promise<{ universityId: string; role: UniversityRole } | null> {
  const domain = domainOf(email);
  if (domain.length === 0) return null;

  const rows = await tx<universitiesDb.UniversityRow[]>`
    SELECT * FROM gateway.universities
    WHERE email_domain = ${domain} AND is_active = true
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const university = rows[0]!;

  await tx`
    UPDATE gateway.users
    SET license_type = ${preferredRole === 'university_admin' ? 'university_admin' : preferredRole},
        university_id = ${university.id}
    WHERE id = ${userId}
  `;
  await licensesDb.create(tx, {
    userId,
    universityId: university.id,
    role: preferredRole,
    verifiedAt: new Date(),
    expiresAt: new Date(Date.now() + STUDENT_LICENCE_TTL_YEARS * 365 * 24 * 60 * 60 * 1000),
  });

  return { universityId: university.id, role: preferredRole };
}

export async function listPublic(sql: Sql): Promise<Array<{ id: string; name: string; country: string }>> {
  const rows = await universitiesDb.listActive(sql);
  return rows.map((u) => ({ id: u.id, name: u.name, country: u.country }));
}

export interface AddUniversityInput {
  adminId: string;
  name: string;
  country: string;
  emailDomain: string;
}

export async function addUniversity(sql: Sql, input: AddUniversityInput): Promise<{ id: string }> {
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(input.emailDomain)) {
    throw new AppError('VALIDATION_FAILED', { message: 'Invalid email domain' });
  }
  return withRequestContext(sql, { actor: 'admin', userId: input.adminId, isAdmin: true }, async (tx) =>
    universitiesDb.create(tx, {
      name: input.name,
      country: input.country,
      emailDomain: input.emailDomain,
    }),
  );
}
