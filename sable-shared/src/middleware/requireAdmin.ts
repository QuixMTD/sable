// Admin guard. Runs AFTER `authenticate` so `req.session` is populated;
// rejects with FORBIDDEN if the caller isn't an admin.
//
// The schema currently stores admin staff as `gateway.users` rows with
// account_type='admin' (plus a mirror row in `gateway.admin_accounts`
// for role + TOTP secret). `authenticate` already sets actor='admin' for
// those rows, so the guard is a single boolean check.
//
// If a future schema change splits admin sessions into their own table,
// swap `authenticate` for an `authenticateAdmin` factory at the /admin
// router boundary — `requireAdmin` keeps the same shape.

import { AppError } from '../errors/AppError.js';
import type { HttpRequest, HttpResponse, NextFunction } from './types.js';

export interface RequireAdminOptions {
  /** If true, only super_admin is accepted; default false (any admin). */
  superAdminOnly?: boolean;
}

export function requireAdmin(options: RequireAdminOptions = {}) {
  return (req: HttpRequest, _res: HttpResponse, next: NextFunction): void => {
    if (!req.session) {
      next(new AppError('AUTH_FAILED'));
      return;
    }
    if (req.session.actor !== 'admin' || !req.session.isAdmin) {
      next(new AppError('ADMIN_ONLY'));
      return;
    }
    if (options.superAdminOnly && !req.session.isSuperAdmin) {
      next(new AppError('SUPER_ADMIN_ONLY'));
      return;
    }
    next();
  };
}
