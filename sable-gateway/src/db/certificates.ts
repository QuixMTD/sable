// gateway.certificates — issued certifications. One row per pass.
// public_id is the URL-safe identifier shown on CVs. Verification
// queries by public_id and falls through to the ledger row for the
// cryptographic proof.

import { withRequestContext, type Sql, type TransactionSql } from 'sable-shared';

import type { LevelCode } from './examQuestions.js';

export interface CertificateRow {
  id: string;
  public_id: string;
  user_id: string;
  level: LevelCode;
  exam_attempt_id: string;
  score: number;
  hours_at_issue: number;
  ledger_entry_id: string;
  issued_at: Date;
}

/** Joined shape — for the public verification page. */
export interface CertificatePublicView {
  public_id: string;
  level: LevelCode;
  score: number;
  hours_at_issue: number;
  issued_at: Date;
  user_name: string;
  ledger_entry_id: string;
}

export interface IssueInput {
  publicId: string;
  userId: string;
  level: LevelCode;
  examAttemptId: string;
  score: number;
  hoursAtIssue: number;
  ledgerEntryId: string;
}

export async function issue(tx: TransactionSql, input: IssueInput): Promise<CertificateRow> {
  const rows = await tx<CertificateRow[]>`
    INSERT INTO gateway.certificates
      (public_id, user_id, level, exam_attempt_id, score, hours_at_issue, ledger_entry_id)
    VALUES
      (${input.publicId},
       ${input.userId},
       ${input.level},
       ${input.examAttemptId},
       ${input.score},
       ${input.hoursAtIssue},
       ${input.ledgerEntryId})
    RETURNING *
  `;
  return rows[0]!;
}

export async function listForUser(sql: Sql, userId: string): Promise<CertificateRow[]> {
  return withRequestContext(sql, { actor: 'user', userId }, async (tx) =>
    tx<CertificateRow[]>`
      SELECT * FROM gateway.certificates
      WHERE user_id = ${userId}
      ORDER BY issued_at DESC
    `,
  );
}

export async function findByPublicId(sql: Sql, publicId: string): Promise<CertificatePublicView | null> {
  const rows = await withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    tx<CertificatePublicView[]>`
      SELECT
        c.public_id, c.level, c.score, c.hours_at_issue, c.issued_at,
        u.name AS user_name, c.ledger_entry_id
      FROM gateway.certificates c
      JOIN gateway.users u ON u.id = c.user_id
      WHERE c.public_id = ${publicId}
      LIMIT 1
    `,
  );
  return rows[0] ?? null;
}
