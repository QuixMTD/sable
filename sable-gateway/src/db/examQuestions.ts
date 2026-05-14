// gateway.exam_questions — Foundation MCQ bank. RLS prevents users
// reading directly (would defeat the exam); the gateway service draws
// a fresh randomised sample for each attempt.

import { withRequestContext, type Sql, type TransactionSql } from 'sable-shared';

export type LevelCode = 'foundation' | 'professional' | 'advanced';

export interface ExamQuestionRow {
  id: string;
  level: LevelCode;
  prompt: string;
  options: { key: string; text: string }[];
  correct_key: string;
  weight: number;
  category: string | null;
  is_active: boolean;
  created_at: Date;
}

/** Returns a candidate-safe shape (no correct_key). */
export interface QuestionForCandidate {
  id: string;
  prompt: string;
  options: { key: string; text: string }[];
  category: string | null;
}

export async function sampleForLevel(sql: Sql, level: LevelCode, count: number): Promise<ExamQuestionRow[]> {
  return withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    tx<ExamQuestionRow[]>`
      SELECT * FROM gateway.exam_questions
      WHERE level = ${level} AND is_active = true
      ORDER BY random()
      LIMIT ${count}
    `,
  );
}

export async function findManyByIds(sql: Sql, ids: string[]): Promise<ExamQuestionRow[]> {
  if (ids.length === 0) return [];
  return withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    tx<ExamQuestionRow[]>`
      SELECT * FROM gateway.exam_questions WHERE id = ANY(${ids})
    `,
  );
}

export interface CreateQuestionInput {
  level: LevelCode;
  prompt: string;
  options: { key: string; text: string }[];
  correctKey: string;
  category?: string;
  weight?: number;
}

export async function create(tx: TransactionSql, input: CreateQuestionInput): Promise<{ id: string }> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO gateway.exam_questions (level, prompt, options, correct_key, category, weight)
    VALUES (
      ${input.level},
      ${input.prompt},
      ${JSON.stringify(input.options)}::jsonb,
      ${input.correctKey},
      ${input.category ?? null},
      ${input.weight ?? 1}
    )
    RETURNING id
  `;
  return rows[0]!;
}
