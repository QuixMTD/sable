// Entitlement check — rejects requests for modules the user / org hasn't
// paid for. The list of active modules is denormalised onto the user row
// (and the org row), refreshed by Stripe webhooks via the
// enforce_active_modules_actor trigger so a malicious admin can't grant
// modules they haven't paid for.
//
// Module entitlement is a request-time concern only — the schema has no
// active_modules CHECK on holdings tables. The gateway is the single
// enforcement point.

import { AppError, isModuleCode, type ModuleCode } from 'sable-shared';
import type { NextFunction, Request, Response } from 'express';

export function moduleGuard(module: ModuleCode) {
  if (!isModuleCode(module)) {
    throw new Error(`moduleGuard called with invalid module code: ${module}`);
  }
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.session) {
      next(new AppError('AUTH_FAILED'));
      return;
    }

    if (!req.session.activeModules.includes(module)) {
      next(
        new AppError('MODULE_NOT_ACTIVE', {
          message: `Module '${module}' is not active for this user`,
          details: { module, activeModules: req.session.activeModules },
        }),
      );
      return;
    }

    next();
  };
}
