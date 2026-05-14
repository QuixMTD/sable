// /admin/* controllers. Gated by `requireAdmin` in the router;
// super-admin-only routes layer a second guard.
//
// Wired:
//   POST   /admin/hmac-keys/rotate        → rotateHmacKey   (super_admin)
//   GET    /admin/sessions                → listActiveSessions
//   DELETE /admin/sessions/:id            → forceRevokeSession
//   POST   /admin/blocks                  → blockEntity
//   DELETE /admin/blocks/:id              → unblockEntity
//   GET    /admin/blocks                  → listBlocks
//   GET    /admin/security-events         → listSecurityEvents
//   PATCH  /admin/config                  → setConfig       (super_admin)
//
// Stubbed (need additional schema or features):
//   GET    /admin/hmac-keys               → listHmacKeys
//   GET    /admin/audit                   → listAuditLog
//   GET    /admin/health/services         → listServiceHealth
//   GET    /admin/config                  → getConfig
//   GET    /admin/enquiries               → listEnquiries
//   PATCH  /admin/enquiries/:id           → updateEnquiry

import type { Request, RequestHandler } from 'express';
import { AppError, parse, success } from 'sable-shared';

import type { AppConfig } from '../app.js';
import { blockEntitySchema, rotateHmacKeySchema, setConfigSchema, unblockEntitySchema } from '../schemas/admin.js';
import * as adminSvc from '../services/admin.js';
import * as security from '../services/security.js';

function ip(req: Request): string | null {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim()) || req.ip || null;
}

export function rotateHmacKey(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!req.session) return next(new AppError('AUTH_FAILED'));
      const input = parse(rotateHmacKeySchema, req.body);
      await adminSvc.rotateHmacKey(config.sql, config.redis, {
        adminId: req.session.userId,
        newVersion: input.newVersion,
        keyRef: input.keyRef,
        deprecatePrevious: input.deprecatePrevious,
        ipAddress: ip(req),
      });
      res.status(200).json(success(undefined, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function listActiveSessions(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
      const rows = await adminSvc.listActiveSessions(config.sql, userId);
      res.status(200).json(success(rows, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function forceRevokeSession(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!req.session) return next(new AppError('AUTH_FAILED'));
      const id = req.params.id ?? '';
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'admin_revoked';
      await adminSvc.forceRevokeSession(config.sql, config.redis, req.session.userId, id, reason, ip(req));
      res.status(200).json(success(undefined, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function blockEntity(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!req.session) return next(new AppError('AUTH_FAILED'));
      const input = parse(blockEntitySchema, req.body);
      await security.block(config.sql, config.redis, {
        entityType: input.entityType,
        entityValue: input.entityValue,
        reason: input.reason,
        blockedBy: req.session.userId,
        expiresAt: input.expiresAt !== undefined ? new Date(input.expiresAt) : undefined,
      });
      res.status(200).json(success(undefined, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function unblockEntity(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      const input = parse(unblockEntitySchema, req.body);
      await security.unblock(config.sql, config.redis, input.entityType, input.entityValue);
      res.status(200).json(success(undefined, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function listBlocks(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      const rows = await adminSvc.listBlocks(config.sql);
      res.status(200).json(success(rows, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function listSecurityEvents(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      const limit = Number.parseInt(typeof req.query.limit === 'string' ? req.query.limit : '200', 10);
      const rows = await adminSvc.listSecurityEvents(config.sql, Number.isFinite(limit) ? limit : 200);
      res.status(200).json(success(rows, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function setConfig(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!req.session) return next(new AppError('AUTH_FAILED'));
      const input = parse(setConfigSchema, req.body);
      // Schema lets `value` be unknown; coerce to string for storage.
      const value = typeof input.value === 'string' ? input.value : JSON.stringify(input.value);
      await adminSvc.setGatewayConfig(config.sql, config.redis, {
        adminId: req.session.userId,
        key: input.key,
        value,
        ipAddress: ip(req),
      });
      res.status(200).json(success(undefined, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function listHmacKeys(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      const rows = await adminSvc.listHmacKeys(config.sql);
      res.status(200).json(success(rows, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function listAuditLog(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      const limit = Number.parseInt(typeof req.query.limit === 'string' ? req.query.limit : '200', 10);
      const rows = await adminSvc.listAuditLog(config.sql, Number.isFinite(limit) ? limit : 200);
      res.status(200).json(success(rows, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function listServiceHealth(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      const rows = await adminSvc.listServiceHealth(config.sql);
      res.status(200).json(success(rows, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function getConfig(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      const rows = await adminSvc.listConfig(config.sql);
      res.status(200).json(success(rows, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function listEnquiries(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const rows = await adminSvc.listEnquiries(config.sql, status);
      res.status(200).json(success(rows, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function updateEnquiry(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!req.session) return next(new AppError('AUTH_FAILED'));
      const id = req.params.id ?? '';
      const body = (req.body ?? {}) as {
        status?: 'new' | 'contacted' | 'qualified' | 'demo_booked' | 'converted' | 'closed';
        assignedTo?: string | null;
        internalNotes?: string;
      };
      await adminSvc.updateEnquiry(config.sql, {
        adminId: req.session.userId,
        id,
        status: body.status,
        assignedTo: body.assignedTo,
        internalNotes: body.internalNotes,
        ipAddress: ip(req),
      });
      res.status(200).json(success(undefined, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

