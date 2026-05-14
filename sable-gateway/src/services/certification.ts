// Sable Institute — eligibility, exam orchestration, certificate
// issuance. Hours come from gateway.certification_minutes (one row per
// active minute, published from each module). Exams are MCQ for
// Foundation today; Professional / Advanced practical formats live
// inside the terminal and only surface here as `pending_payment`
// placeholders until the runner is wired downstream.

import { randomBytes } from 'node:crypto';
import {
  AppError,
  getDek,
  withRequestContext,
  type Sql,
} from 'sable-shared';

import * as certsDb from '../db/certificates.js';
import * as ledgerDb from '../db/certificationLedger.js';
import * as minutesDb from '../db/certificationMinutes.js';
import * as attemptsDb from '../db/examAttempts.js';
import * as questionsDb from '../db/examQuestions.js';
import type { LevelCode } from '../db/examQuestions.js';
import * as ledger from './certificationLedger.js';

const ATTEMPT_TTL_MINUTES: Record<LevelCode, number> = {
  foundation: 90,
  professional: 180,
  advanced: 240,
};

const PUBLIC_ID_PREFIXES: Record<LevelCode, string> = {
  foundation: 'SABLE-FND',
  professional: 'SABLE-PRO',
  advanced: 'SABLE-ADV',
};

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export interface LevelConfig {
  code: LevelCode;
  display_name: string;
  min_hours: number;
  exam_fee_usd: number;
  format: 'mcq' | 'practical' | 'case_study';
  pass_threshold: number;
  question_count: number | null;
  duration_minutes: number;
}

async function loadLevels(sql: Sql): Promise<LevelConfig[]> {
  return withRequestContext(sql, { actor: 'gateway' }, async (tx) =>
    tx<LevelConfig[]>`
      SELECT code, display_name, min_hours, exam_fee_usd, format,
             pass_threshold, question_count, duration_minutes
      FROM gateway.certification_levels
      WHERE is_active = true
      ORDER BY min_hours
    `,
  );
}

export interface OverviewLevel extends LevelConfig {
  eligible: boolean;
  hours_short_of_eligibility: number;
  held: { public_id: string; issued_at: Date; score: number } | null;
}

export interface CertificationOverview {
  hours: minutesDb.HoursTotals;
  levels: OverviewLevel[];
}

export async function overview(sql: Sql, userId: string): Promise<CertificationOverview> {
  const [hours, levels, held] = await Promise.all([
    minutesDb.totalsForUser(sql, userId),
    loadLevels(sql),
    certsDb.listForUser(sql, userId),
  ]);
  const heldByLevel = new Map(held.map((h) => [h.level, h] as const));

  return {
    hours,
    levels: levels.map((l) => {
      const heldCert = heldByLevel.get(l.code);
      return {
        ...l,
        eligible: hours.total_hours >= l.min_hours,
        hours_short_of_eligibility: Math.max(0, l.min_hours - hours.total_hours),
        held: heldCert
          ? { public_id: heldCert.public_id, issued_at: heldCert.issued_at, score: heldCert.score }
          : null,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Start an attempt
// ---------------------------------------------------------------------------

export interface StartAttemptResult {
  attemptId: string;
  level: LevelCode;
  format: LevelConfig['format'];
  expiresAt: Date;
  hoursAtAttempt: number;
  /** Populated only for MCQ — Professional / Advanced runners live in the terminal. */
  questions?: questionsDb.QuestionForCandidate[];
  /** Reserved — Stripe payment intent client_secret. Null until billing lands. */
  paymentIntentClientSecret: string | null;
}

export async function startAttempt(sql: Sql, userId: string, level: LevelCode): Promise<StartAttemptResult> {
  const [levels, hours, held] = await Promise.all([
    loadLevels(sql),
    minutesDb.totalsForUser(sql, userId),
    certsDb.listForUser(sql, userId),
  ]);

  const config = levels.find((l) => l.code === level);
  if (config === undefined) throw new AppError('NOT_FOUND', { message: `Unknown level: ${level}` });

  if (hours.total_hours < config.min_hours) {
    throw new AppError('FORBIDDEN', {
      message: `Need ${config.min_hours} hours to attempt ${config.code}; you have ${hours.total_hours.toFixed(1)}`,
      details: { required: config.min_hours, current: hours.total_hours },
    });
  }
  if (held.some((h) => h.level === level)) {
    throw new AppError('ALREADY_EXISTS', { message: `Already certified at the ${level} level` });
  }

  const expiresAt = new Date(Date.now() + ATTEMPT_TTL_MINUTES[level] * 60 * 1000);

  // Non-MCQ levels: create a placeholder attempt but don't draw a
  // question set. The terminal runner picks the attempt up once the
  // candidate launches the practical scenario.
  if (config.format !== 'mcq' || config.question_count === null) {
    return withRequestContext(sql, { actor: 'gateway' }, async (tx) => {
      const row = await attemptsDb.create(tx, {
        userId,
        level,
        hoursAtAttempt: hours.total_hours,
        questionSet: [],
        expiresAt,
        status: 'pending_payment',
      });
      return {
        attemptId: row.id,
        level,
        format: config.format,
        expiresAt,
        hoursAtAttempt: hours.total_hours,
        paymentIntentClientSecret: null,
      };
    });
  }

  // MCQ — sample questions, hide the correct keys.
  const sampled = await questionsDb.sampleForLevel(sql, level, config.question_count);
  if (sampled.length < config.question_count) {
    throw new AppError('INTERNAL_ERROR', {
      message: `Question bank for ${level} has too few active questions (${sampled.length}/${config.question_count})`,
    });
  }

  return withRequestContext(sql, { actor: 'gateway' }, async (tx) => {
    const row = await attemptsDb.create(tx, {
      userId,
      level,
      hoursAtAttempt: hours.total_hours,
      questionSet: sampled.map((q) => q.id),
      expiresAt,
      status: 'in_progress',
    });
    return {
      attemptId: row.id,
      level,
      format: 'mcq' as const,
      expiresAt,
      hoursAtAttempt: hours.total_hours,
      questions: sampled.map((q) => ({
        id: q.id,
        prompt: q.prompt,
        options: q.options,
        category: q.category,
      })),
      paymentIntentClientSecret: null,
    };
  });
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

export interface SubmitAttemptInput {
  attemptId: string;
  userId: string;
  answers: Record<string, string>;
}

export interface SubmitAttemptResult {
  attemptId: string;
  score: number;
  passed: boolean;
  certificate: { publicId: string; ledgerEntryId: string } | null;
}

export async function submitAttempt(sql: Sql, input: SubmitAttemptInput): Promise<SubmitAttemptResult> {
  const attempt = await attemptsDb.findById(sql, input.attemptId, input.userId);
  if (attempt === null) throw new AppError('NOT_FOUND');
  if (attempt.user_id !== input.userId) throw new AppError('FORBIDDEN');
  if (attempt.status !== 'in_progress') {
    throw new AppError('CONFLICT', { message: `Attempt is in status ${attempt.status}, not in_progress` });
  }
  if (attempt.expires_at !== null && attempt.expires_at.getTime() < Date.now()) {
    throw new AppError('CONFLICT', { message: 'Attempt has expired' });
  }

  // Score
  const levels = await loadLevels(sql);
  const config = levels.find((l) => l.code === attempt.level);
  if (config === undefined) throw new AppError('INTERNAL_ERROR', { message: 'Missing level config' });
  if (config.format !== 'mcq') {
    throw new AppError('CONFLICT', { message: 'Use the terminal runner to submit practical / case-study attempts' });
  }

  const questions = await questionsDb.findManyByIds(sql, attempt.question_set);
  const byId = new Map(questions.map((q) => [q.id, q]));
  let correct = 0;
  for (const qid of attempt.question_set) {
    const q = byId.get(qid);
    if (q === undefined) continue;
    if (input.answers[qid] === q.correct_key) correct += 1;
  }
  const score = Math.round((correct / attempt.question_set.length) * 100);
  const passed = score >= config.pass_threshold;

  // Mark submitted. If passed, issue the certificate + ledger entry
  // atomically — both transactional so we never have a cert without a
  // ledger row (or vice versa).
  return withRequestContext(sql, { actor: 'gateway', dek: getDek() }, async (tx) => {
    await attemptsDb.submit(tx, {
      id: input.attemptId,
      answers: input.answers,
      score,
      status: passed ? 'passed' : 'failed',
    });

    if (!passed) {
      return { attemptId: input.attemptId, score, passed: false, certificate: null };
    }

    // Look up the user's name (needed in the canonical payload).
    const userRows = await tx<{ name: string }[]>`
      SELECT name FROM gateway.users WHERE id = ${input.userId} LIMIT 1
    `;
    const userName = userRows[0]?.name ?? 'Unknown';

    const publicId = generatePublicId(attempt.level);
    const issuedAt = new Date();

    const ledgerResult = await ledger.appendEntry(tx, {
      public_id: publicId,
      user_id: input.userId,
      user_name: userName,
      level: attempt.level,
      score,
      hours_at_issue: attempt.hours_at_attempt,
      exam_attempt_id: attempt.id,
      issued_at: issuedAt.toISOString(),
    });

    await certsDb.issue(tx, {
      publicId,
      userId: input.userId,
      level: attempt.level,
      examAttemptId: attempt.id,
      score,
      hoursAtIssue: attempt.hours_at_attempt,
      ledgerEntryId: ledgerResult.ledgerEntryId,
    });

    return {
      attemptId: input.attemptId,
      score,
      passed: true,
      certificate: { publicId, ledgerEntryId: ledgerResult.ledgerEntryId },
    };
  });
}

// ---------------------------------------------------------------------------
// Public verification view
// ---------------------------------------------------------------------------

export interface PublicVerification {
  valid: true;
  certificate: certsDb.CertificatePublicView;
  proof: NonNullable<Awaited<ReturnType<typeof ledger.buildVerificationProof>>>;
}

export interface InvalidVerification {
  valid: false;
  reason: string;
}

export async function verifyByPublicId(sql: Sql, publicId: string): Promise<PublicVerification | InvalidVerification> {
  const cert = await certsDb.findByPublicId(sql, publicId);
  if (cert === null) return { valid: false, reason: 'unknown_certificate' };
  const proof = await ledger.buildVerificationProof(sql, cert.ledger_entry_id);
  if (proof === null) return { valid: false, reason: 'missing_ledger_entry' };
  return { valid: true, certificate: cert, proof };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generatePublicId(level: LevelCode): string {
  // 6-character base32-style suffix (Crockford alphabet, no I/L/O/U to
  // avoid handwriting confusion).
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = randomBytes(6);
  let suffix = '';
  for (const b of bytes) suffix += alphabet[b % alphabet.length];
  return `${PUBLIC_ID_PREFIXES[level]}-${suffix}`;
}
