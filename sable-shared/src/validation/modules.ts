// Module-code validation. Wraps `isModuleCode` from constants with a
// throwing assertion variant for use at trust boundaries.

import { isModuleCode, MODULE_CODES, type ModuleCode } from '../constants/modules.js';
import { AppError } from '../errors/AppError.js';

/** Type guard — re-exported alias of `isModuleCode` for naming consistency in validation. */
export function isValidModule(value: unknown): value is ModuleCode {
  return isModuleCode(value);
}

/**
 * Assertion that throws `AppError('INVALID_MODULE_CODE')` if the value is not
 * one of MODULE_CODES. After this call returns, TypeScript narrows the value
 * to `ModuleCode`. The `field` lands in `error.details.field`.
 */
export function assertValidModule(value: unknown, field = 'module'): asserts value is ModuleCode {
  if (!isValidModule(value)) {
    throw new AppError('INVALID_MODULE_CODE', {
      message: `${field} is not a valid module code (got ${JSON.stringify(value)}; expected one of ${MODULE_CODES.join(', ')})`,
      details: { field, expected: MODULE_CODES },
    });
  }
}
