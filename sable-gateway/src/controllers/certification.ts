// /certification/* — authenticated candidate-facing endpoints.
//
//   GET    /certification/me                       overview of hours + eligibility + held certs
//   GET    /certification/me/certificates          list this user's certificates
//   POST   /certification/attempts                 start an exam attempt for a given level
//   POST   /certification/attempts/:id/submit      submit MCQ answers, get pass/fail + cert
//   GET    /certification/attempts                 list this user's attempts

import type { RequestHandler } from 'express';
import { AppError, parse, success } from 'sable-shared';

import type { AppConfig } from '../app.js';
import * as certsDb from '../db/certificates.js';
import * as attemptsDb from '../db/examAttempts.js';
import { startAttemptSchema, submitAttemptSchema } from '../schemas/certification.js';
import * as certificationSvc from '../services/certification.js';

export function me(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!req.session) return next(new AppError('AUTH_FAILED'));
      const view = await certificationSvc.overview(config.sql, req.session.userId);
      res.status(200).json(success(view, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function listMyCertificates(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!req.session) return next(new AppError('AUTH_FAILED'));
      const rows = await certsDb.listForUser(config.sql, req.session.userId);
      res.status(200).json(success(rows, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function startAttempt(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!req.session) return next(new AppError('AUTH_FAILED'));
      const input = parse(startAttemptSchema, req.body);
      const result = await certificationSvc.startAttempt(config.sql, req.session.userId, input.level);
      res.status(201).json(success(result, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function submitAttempt(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!req.session) return next(new AppError('AUTH_FAILED'));
      const input = parse(submitAttemptSchema, req.body);
      // Belt-and-braces: ignore the body's attemptId in favour of the path param
      // if both are present; route ensures :id is set.
      const attemptId = req.params.id ?? input.attemptId;
      const result = await certificationSvc.submitAttempt(config.sql, {
        attemptId,
        userId: req.session.userId,
        answers: input.answers,
      });
      res.status(200).json(success(result, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function listAttempts(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!req.session) return next(new AppError('AUTH_FAILED'));
      const rows = await attemptsDb.listForUser(config.sql, req.session.userId);
      res.status(200).json(success(rows, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}
