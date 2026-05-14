// User profile service — read / update the authenticated user's own
// record. Email changes go through a re-verification flow (handled in
// services/auth.ts), not directly here.

import { AppError, getDek, withRequestContext, type Sql } from 'sable-shared';

import * as usersDb from '../db/users.js';

export interface UpdateProfileInput {
  name?: string;
  phone?: string;
  dateOfBirth?: string;     // ISO-8601 yyyy-mm-dd
  settings?: Record<string, unknown>;
}

export async function getProfile(sql: Sql, userId: string): Promise<usersDb.UserProfileRow> {
  const row = await usersDb.readProfile(sql, userId, getDek());
  if (row === null) throw new AppError('NOT_FOUND');
  return row;
}

export async function updateProfile(sql: Sql, userId: string, input: UpdateProfileInput): Promise<usersDb.UserProfileRow> {
  // No-op writes are still a successful read.
  const hasAny = input.name !== undefined || input.phone !== undefined
    || input.dateOfBirth !== undefined || input.settings !== undefined;

  if (hasAny) {
    await withRequestContext(sql, { actor: 'user', userId, dek: getDek() }, async (tx) => {
      // postgres.js doesn't have a clean partial-update builder; emit
      // conditional UPDATEs. Encrypted columns (phone, date_of_birth)
      // go through enc() so they land as bytea with the DEK applied.
      if (input.name !== undefined) {
        await tx`UPDATE gateway.users SET name = ${input.name} WHERE id = ${userId}`;
      }
      if (input.phone !== undefined) {
        await tx`UPDATE gateway.users SET phone = enc(${input.phone}) WHERE id = ${userId}`;
      }
      if (input.dateOfBirth !== undefined) {
        await tx`UPDATE gateway.users SET date_of_birth = enc(${input.dateOfBirth}) WHERE id = ${userId}`;
      }
      if (input.settings !== undefined) {
        await tx`UPDATE gateway.users SET settings = ${JSON.stringify(input.settings)}::jsonb WHERE id = ${userId}`;
      }
    });
  }

  return getProfile(sql, userId);
}

export async function deactivate(sql: Sql, userId: string): Promise<void> {
  await withRequestContext(sql, { actor: 'user', userId }, async (tx) => {
    await tx`UPDATE gateway.users SET is_active = false WHERE id = ${userId}`;
    // Revoke every active session — the user is gone.
    await tx`
      UPDATE gateway.sessions
      SET revoked_at = now(), revoke_reason = 'user_deactivated'
      WHERE user_id = ${userId} AND revoked_at IS NULL
    `;
  });
}
