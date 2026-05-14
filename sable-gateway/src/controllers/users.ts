// /users/* controllers.

import type { RequestHandler } from 'express';
import { AppError, parse, success } from 'sable-shared';

import type { AppConfig } from '../app.js';
import { updateProfileSchema } from '../schemas/users.js';
import * as apiKeysSvc from '../services/apiKeys.js';
import * as usersSvc from '../services/users.js';

export function getMe(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!req.session) return next(new AppError('AUTH_FAILED'));
      const profile = await usersSvc.getProfile(config.sql, req.session.userId);
      res.status(200).json(success(profile, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function updateMe(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!req.session) return next(new AppError('AUTH_FAILED'));
      const input = parse(updateProfileSchema, req.body);
      const profile = await usersSvc.updateProfile(config.sql, req.session.userId, input);
      res.status(200).json(success(profile, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function deactivateMe(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!req.session) return next(new AppError('AUTH_FAILED'));
      await usersSvc.deactivate(config.sql, req.session.userId);
      res.clearCookie(config.sessionCookieName, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: req.protocol === 'https',
      });
      res.status(200).json(success(undefined, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

// ---------------------------------------------------------------------------
// API keys (per-user self-service)
// ---------------------------------------------------------------------------

export function listMyApiKeys(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!req.session) return next(new AppError('AUTH_FAILED'));
      const rows = await apiKeysSvc.listForOwner(config.sql, req.session.userId, req.session.orgId ?? null);
      res.status(200).json(
        success(
          rows.map((r) => ({
            id: r.id,
            name: r.name,
            prefix: r.prefix,
            scopes: r.scopes,
            lastUsedAt: r.last_used_at,
            expiresAt: r.expires_at,
            createdAt: r.created_at,
          })),
          req.requestId,
        ),
      );
    } catch (err) {
      next(err);
    }
  };
}

export function issueMyApiKey(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!req.session) return next(new AppError('AUTH_FAILED'));
      const name = typeof req.body?.name === 'string' ? req.body.name : '';
      const scopes = Array.isArray(req.body?.scopes) ? (req.body.scopes as string[]) : [];
      if (name.length === 0) return next(new AppError('VALIDATION_FAILED', { message: 'name required' }));
      const issued = await apiKeysSvc.issue(config.sql, {
        ownerUserId: req.session.userId,
        ownerOrgId: req.session.orgId ?? null,
        name,
        scopes,
        expiresAt: null,
      });
      res.status(201).json(
        success(
          { id: issued.id, key: issued.key, prefix: issued.prefix, createdAt: issued.createdAt },
          req.requestId,
        ),
      );
    } catch (err) {
      next(err);
    }
  };
}

export function revokeMyApiKey(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!req.session) return next(new AppError('AUTH_FAILED'));
      const id = req.params.id;
      if (!id) return next(new AppError('VALIDATION_FAILED', { message: 'missing id' }));
      await apiKeysSvc.revoke(config.sql, id, req.session.userId);
      res.status(200).json(success(undefined, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}
