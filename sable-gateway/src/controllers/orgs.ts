// /orgs/* controllers.
//
// Wired:
//   POST   /orgs                              → createOrg
//   GET    /orgs/:id/members                  → listMembers
//   DELETE /orgs/:id/members/:userId          → removeMember
//   PATCH  /orgs/:id/members/:userId/role     → updateMemberRole
//
// Stubbed (need an org_invites schema table — see services/orgs.ts):
//   GET    /orgs/:id                          → getOrg
//   PATCH  /orgs/:id                          → updateOrg
//   POST   /orgs/:id/invites                  → inviteMember
//   GET    /orgs/:id/invites                  → listInvites
//   DELETE /orgs/:id/invites/:inviteId        → revokeInvite
//   POST   /orgs/invites/accept               → acceptInvite

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError, isOwnerOrAdmin, parse, success } from 'sable-shared';

import type { AppConfig } from '../app.js';
import { acceptInviteSchema, createOrgSchema, inviteMemberSchema } from '../schemas/orgs.js';
import * as orgsSvc from '../services/orgs.js';

function requireOwnerOrAdmin(req: Request): void {
  if (!req.session) throw new AppError('AUTH_FAILED');
  if (!isOwnerOrAdmin(req.session.role)) throw new AppError('INSUFFICIENT_ROLE');
}

export function createOrg(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!req.session) return next(new AppError('AUTH_FAILED'));
      const input = parse(createOrgSchema, req.body);
      const result = await orgsSvc.create(config.sql, { creatorUserId: req.session.userId, ...input });
      res.status(201).json(success(result, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function listMembers(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!req.session) return next(new AppError('AUTH_FAILED'));
      const orgId = req.params.id ?? '';
      if (req.session.orgId !== orgId) return next(new AppError('FORBIDDEN'));
      const members = await orgsSvc.listMembers(config.sql, orgId, req.session.userId);
      res.status(200).json(success(members, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function removeMember(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      requireOwnerOrAdmin(req);
      const orgId = req.params.id ?? '';
      const userId = req.params.userId ?? '';
      if (req.session!.orgId !== orgId) return next(new AppError('FORBIDDEN'));
      await orgsSvc.removeMember(config.sql, orgId, userId, req.session!.userId);
      res.status(200).json(success(undefined, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function updateMemberRole(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      requireOwnerOrAdmin(req);
      const orgId = req.params.id ?? '';
      const userId = req.params.userId ?? '';
      if (req.session!.orgId !== orgId) return next(new AppError('FORBIDDEN'));
      const newRole = typeof req.body?.role === 'string' ? req.body.role : '';
      if (!['admin', 'analyst', 'trader', 'viewer'].includes(newRole)) {
        return next(new AppError('VALIDATION_FAILED', { message: 'invalid role' }));
      }
      await orgsSvc.updateMemberRole(config.sql, orgId, userId, newRole as 'admin' | 'analyst' | 'trader' | 'viewer', req.session!.userId);
      res.status(200).json(success(undefined, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function inviteMember(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      requireOwnerOrAdmin(req);
      const orgId = req.params.id ?? '';
      if (req.session!.orgId !== orgId) return next(new AppError('FORBIDDEN'));
      const input = parse(inviteMemberSchema, req.body);
      const result = await orgsSvc.invite(config.sql, {
        orgId,
        inviterUserId: req.session!.userId,
        email: input.email,
        role: input.role,
      });
      res.status(201).json(success({ inviteId: result.inviteId }, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function listInvites(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!req.session) return next(new AppError('AUTH_FAILED'));
      const orgId = req.params.id ?? '';
      if (req.session.orgId !== orgId) return next(new AppError('FORBIDDEN'));
      const rows = await orgsSvc.listInvites(config.sql, orgId, req.session.userId);
      res.status(200).json(
        success(
          rows.map((r) => ({
            id: r.id,
            role: r.role,
            invitedByUserId: r.invited_by_user_id,
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

export function revokeInvite(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      requireOwnerOrAdmin(req);
      const orgId = req.params.id ?? '';
      const inviteId = req.params.inviteId ?? '';
      if (req.session!.orgId !== orgId) return next(new AppError('FORBIDDEN'));
      await orgsSvc.revokeInvite(config.sql, inviteId, req.session!.userId, orgId);
      res.status(200).json(success(undefined, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function acceptInvite(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!req.session) return next(new AppError('AUTH_FAILED'));
      const input = parse(acceptInviteSchema, req.body);
      const result = await orgsSvc.acceptInvite(config.sql, {
        rawToken: input.token,
        acceptingUserId: req.session.userId,
      });
      res.status(200).json(success(result, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

// Org self-read / update aren't strictly invite-related; keep them
// stubbed for now (small, mechanical additions when needed).
const todo = (_req: Request, _res: Response, next: NextFunction): void =>
  next(new AppError('INTERNAL_ERROR', { message: 'Not implemented' }));
export const getOrg = todo;
export const updateOrg = todo;
