// /auth/* controllers.
//
// Wired endpoints (all rate-limited by IP at the router layer):
//   POST  /auth/signup                  → signup
//   POST  /auth/login                   → login
//   POST  /auth/logout                  → logout                (authed)
//   GET   /auth/me                      → me                    (authed)
//   GET   /auth/sessions                → listSessions          (authed)
//   DELETE /auth/sessions/:id           → revokeSession         (authed)
//   POST  /auth/password/change         → changePassword        (authed)
//   POST  /auth/password/reset/request  → requestPasswordReset
//   POST  /auth/password/reset/confirm  → confirmPasswordReset
//   POST  /auth/verify                  → verifyEmail
//
// MFA endpoints (enrollMfa, verifyMfa, disableMfa) remain stubbed until
// services/mfa lands.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError, parse, sha256, success } from 'sable-shared';

import type { AppConfig } from '../app.js';
import {
  changePasswordSchema,
  loginSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  signupSchema,
} from '../schemas/auth.js';
import * as authSvc from '../services/auth.js';
import * as sessions from '../services/sessions.js';

const COOKIE_BASE = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
};

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim()) || req.ip || '';
}

function setSessionCookie(res: Response, name: string, token: string, expiresAt: Date, secure: boolean): void {
  res.cookie(name, token, { ...COOKIE_BASE, secure, expires: expiresAt });
}

function clearSessionCookie(res: Response, name: string, secure: boolean): void {
  res.clearCookie(name, { ...COOKIE_BASE, secure });
}

// ---------------------------------------------------------------------------

export function signup(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      const input = parse(signupSchema, req.body);
      const result = await authSvc.signup(config.sql, config.redis, {
        email: input.email,
        password: input.password,
        name: input.name,
        orgName: input.orgName,
        ipAddress: clientIp(req),
        platform: 'web',
      });
      const secure = req.protocol === 'https';
      setSessionCookie(res, config.sessionCookieName, result.sessionToken, result.expiresAt, secure);

      // The email-delivery service is stubbed — surface the verification
      // token in the structured log so dev / staging can hit /auth/verify directly.
      config.log.info('verification token issued', {
        userId: result.userId,
        verifyToken: result.verificationToken,
      });
      res.status(201).json(success({ userId: result.userId, sessionId: result.sessionId }, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function login(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      const input = parse(loginSchema, req.body);
      const result = await authSvc.login(config.sql, config.redis, {
        email: input.email,
        password: input.password,
        platform: input.platform,
        deviceFingerprint: input.deviceFingerprint,
        ipAddress: clientIp(req),
      });
      const secure = req.protocol === 'https';
      setSessionCookie(res, config.sessionCookieName, result.sessionToken, result.expiresAt, secure);
      res.status(200).json(success({ userId: result.userId, sessionId: result.sessionId }, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function logout(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      const raw = req.cookies?.[config.sessionCookieName];
      const secure = req.protocol === 'https';
      if (!raw || !req.session) {
        clearSessionCookie(res, config.sessionCookieName, secure);
        res.status(200).json(success(undefined, req.requestId));
        return;
      }
      const tokenHashHex = sha256(raw).toString('hex');
      await authSvc.logout(config.sql, config.redis, req.session.sessionId, tokenHashHex);
      clearSessionCookie(res, config.sessionCookieName, secure);
      res.status(200).json(success(undefined, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function me(_config: AppConfig): RequestHandler {
  return (req, res, next) => {
    if (!req.session) {
      next(new AppError('AUTH_FAILED'));
      return;
    }
    res.status(200).json(
      success(
        {
          userId: req.session.userId,
          orgId: req.session.orgId ?? null,
          role: req.session.role,
          actor: req.session.actor,
          activeModules: req.session.activeModules,
        },
        req.requestId,
      ),
    );
  };
}

export function listSessions(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!req.session) return next(new AppError('AUTH_FAILED'));
      const rows = await sessions.listForUser(config.sql, req.session.userId);
      res.status(200).json(
        success(
          rows.map((s) => ({
            id: s.id,
            ipAddress: s.ip_address,
            platform: s.platform,
            createdAt: s.created_at,
            lastActiveAt: s.last_active_at,
            expiresAt: s.expires_at,
            isCurrent: s.id === req.session?.sessionId,
          })),
          req.requestId,
        ),
      );
    } catch (err) {
      next(err);
    }
  };
}

export function revokeSession(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!req.session) return next(new AppError('AUTH_FAILED'));
      const targetId = req.params.id;
      if (!targetId) return next(new AppError('VALIDATION_FAILED', { message: 'Missing session id' }));
      // Users may only revoke their own sessions.
      const rows = await sessions.listForUser(config.sql, req.session.userId);
      if (!rows.some((s) => s.id === targetId)) return next(new AppError('NOT_FOUND'));
      await sessions.revoke(config.sql, config.redis, targetId, null, 'user_revoked');
      res.status(200).json(success(undefined, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function changePassword(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!req.session) return next(new AppError('AUTH_FAILED'));
      const input = parse(changePasswordSchema, req.body);
      await authSvc.changePassword(config.sql, config.redis, {
        userId: req.session.userId,
        current: input.currentPassword,
        next: input.newPassword,
      });
      res.status(200).json(success(undefined, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function requestPasswordReset(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      const input = parse(passwordResetRequestSchema, req.body);
      const result = await authSvc.requestPasswordReset(config.sql, input.email, clientIp(req));
      if (result.token !== null) {
        config.log.info('password reset token issued', { resetToken: result.token });
      }
      res.status(200).json(success(undefined, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function confirmPasswordReset(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      const input = parse(passwordResetConfirmSchema, req.body);
      await authSvc.confirmPasswordReset(config.sql, input.token, input.newPassword);
      res.status(200).json(success(undefined, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function verifyEmail(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      const token = typeof req.body?.token === 'string' ? req.body.token : '';
      if (token.length === 0) return next(new AppError('VALIDATION_FAILED', { message: 'token required' }));
      await authSvc.verifyEmail(config.sql, token);
      res.status(200).json(success(undefined, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

// MFA stays todo() until services/mfa lands.
const todo = (_req: Request, _res: Response, next: NextFunction): void =>
  next(new AppError('INTERNAL_ERROR', { message: 'Not implemented' }));
export const enrollMfa = todo;
export const verifyMfa = todo;
export const disableMfa = todo;
