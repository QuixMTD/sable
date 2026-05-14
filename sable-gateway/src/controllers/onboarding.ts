// /public/* controllers. Unauthenticated; rate-limited aggressively by IP.

import type { RequestHandler } from 'express';
import { AppError, parse, success } from 'sable-shared';

import type { AppConfig } from '../app.js';
import { joinWaitlistSchema, redeemReferralSchema, submitEnquirySchema } from '../schemas/onboarding.js';
import * as onboardingSvc from '../services/onboarding.js';

export function joinWaitlist(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      const raw = parse(joinWaitlistSchema, req.body);
      // The public schema is conservative — name is required by the DB
      // row but optional in the public form; default it.
      const result = await onboardingSvc.joinWaitlist(config.sql, {
        name: typeof req.body?.name === 'string' && req.body.name.length > 0 ? req.body.name : '(anonymous)',
        email: raw.email,
        firmName: typeof req.body?.firmName === 'string' ? req.body.firmName : undefined,
        aumRange: typeof req.body?.aumRange === 'string' ? req.body.aumRange : undefined,
        primaryInterest: typeof req.body?.primaryInterest === 'string' ? req.body.primaryInterest : undefined,
        source: raw.referralSource,
      });
      res.status(result.alreadyJoined ? 200 : 201).json(success({ alreadyJoined: result.alreadyJoined }, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function submitEnquiry(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      const input = parse(submitEnquirySchema, req.body);
      const result = await onboardingSvc.submitEnquiry(config.sql, {
        name: input.name,
        email: input.email,
        enquiryType: 'general',
        message: input.message,
        source: typeof req.body?.source === 'string' ? req.body.source : undefined,
        firmName: typeof req.body?.firmName === 'string' ? req.body.firmName : undefined,
      });
      res.status(201).json(success(result, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function redeemReferral(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!req.session) return next(new AppError('AUTH_FAILED'));
      const input = parse(redeemReferralSchema, req.body);
      await onboardingSvc.redeemReferral(config.sql, input.code, req.session.userId);
      res.status(200).json(success(undefined, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}
