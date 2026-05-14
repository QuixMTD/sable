// Zod schema runner. Validates an input against a schema and throws an
// AppError('VALIDATION_FAILED') on mismatch — Zod's own `safeParse` is
// great for inline use but we want the same error shape everywhere.
//
// `zod` is an optional peer dep of sable-shared.

import { z, type ZodError, type ZodSchema, type ZodTypeDef } from 'zod';

import { AppError } from '../errors/AppError.js';

export function parse<TOutput, TDef extends ZodTypeDef, TInput>(
  schema: ZodSchema<TOutput, TDef, TInput>,
  data: unknown,
  field = 'body',
): TOutput {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AppError('VALIDATION_FAILED', {
      message: `${field} did not validate`,
      details: { field, issues: formatIssues(result.error) },
    });
  }
  return result.data;
}

/** Reduce Zod's nested error tree to a flat array suitable for the wire. */
function formatIssues(error: ZodError): { path: string; message: string; code: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

// Re-export `z` so handlers don't need to import zod separately when they
// already need this helper.
export { z };
