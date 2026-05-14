// gateway.exam_attempts — one row per try at an exam. question_set is
// the deterministic list of question IDs, captured at start so the same
// attempt can be re-scored if a question is later disabled. answers is
// the candidate's submission keyed by question id.

import { withRequestContext, type Sql, type TransactionSql } from 'sable-shared';

import type { LevelCode } from './examQuestions.js';

export type AttemptStatus =
  | 'pending_payment'
  | 'in_progress'
  | 'submitted'
  | 'passed'
  | 'failed'
  | 'expired';

export interface ExamAttemptRow {
  id: string;
  user_id: string;
  level: LevelCode;
  status: AttemptStatus;
  question_set: string[];
  answers: Record<string, string>;
  score: number | null;
  hours_at_attempt: number;
  started_at: Date | null;
  submitted_at: Date | null;
  expires_at: Date | null;
  payment_intent_id: string | null;
  created_at: Date;
}

export interface CreateAttemptInput {
  userId: string;
  level: LevelCode;
  hoursAtAttempt: number;
  questionSet: string[];
  expiresAt: Date;
  status: AttemptStatus;
}

export async function create(tx: TransactionSql, input: CreateAttemptInput): Promise<ExamAttemptRow> {
  const rows = await tx<ExamAttemptRow[]>`
    INSERT INTO gateway.exam_attempts
      (user_id, level, status, question_set, hours_at_attempt, started_at, expires_at)
    VALUES
      (${input.userId},
       ${input.level},
       ${input.status},
       ${JSON.stringify(input.questionSet)}::jsonb,
       ${input.hoursAtAttempt},
       now(),
       ${input.expiresAt})
    RETURNING *
  `;
  return rows[0]!;
}

export async function findById(sql: Sql, id: string, callerUserId: string): Promise<ExamAttemptRow | null> {
  const rows = await withRequestContext(sql, { actor: 'user', userId: callerUserId }, async (tx) =>
    tx<ExamAttemptRow[]>`SELECT * FROM gateway.exam_attempts WHERE id = ${id} LIMIT 1`,
  );
  return rows[0] ?? null;
}

export async function listForUser(sql: Sql, userId: string): Promise<ExamAttemptRow[]> {
  return withRequestContext(sql, { actor: 'user', userId }, async (tx) =>
    tx<ExamAttemptRow[]>`
      SELECT * FROM gateway.exam_attempts
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `,
  );
}

export interface SubmitAttemptInput {
  id: string;
  answers: Record<string, string>;
  score: number;
  status: 'passed' | 'failed';
}

export async function submit(tx: TransactionSql, input: SubmitAttemptInput): Promise<void> {
  await tx`
    UPDATE gateway.exam_attempts
    SET answers = ${JSON.stringify(input.answers)}::jsonb,
        score = ${input.score},
        status = ${input.status},
        submitted_at = now()
    WHERE id = ${input.id} AND status = 'in_progress'
  `;
}
