// /billing/* controllers.
//
// Wired:
//   GET   /billing/subscriptions           → listSubscriptions
//   GET   /billing/invoices                → listInvoices
//   POST  /billing/subscriptions/cancel    → cancelSubscription
//   GET   /billing/modules                 → listAvailableModules
//
// Stubbed (need Stripe SDK in config/stripe.ts):
//   POST  /billing/checkout                → createCheckoutSession
//   POST  /billing/portal                  → createPortalSession

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError, MODULE_CODES, parse, success, type ModuleCode } from 'sable-shared';

import type { AppConfig } from '../app.js';
import { cancelSubscriptionSchema } from '../schemas/billing.js';
import * as billingSvc from '../services/billing.js';

const MODULE_LABELS: Record<ModuleCode, string> = {
  sc: 'Stocks & Commodities',
  re: 'Property',
  crypto: 'Crypto',
  alt: 'Alternatives',
  tax: 'Tax',
};

export function listSubscriptions(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!req.session) return next(new AppError('AUTH_FAILED'));
      const subs = await billingSvc.listSubscriptions(config.sql, req.session.userId);
      res.status(200).json(success(subs, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function listInvoices(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!req.session) return next(new AppError('AUTH_FAILED'));
      const invs = await billingSvc.listInvoices(config.sql, req.session.userId);
      res.status(200).json(success(invs, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function cancelSubscription(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!req.session) return next(new AppError('AUTH_FAILED'));
      const input = parse(cancelSubscriptionSchema, req.body);
      await billingSvc.cancelSubscription(config.sql, req.session.userId, input.subscriptionId);
      res.status(200).json(success(undefined, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function listAvailableModules(_config: AppConfig): RequestHandler {
  return (req, res) => {
    const monthly = billingSvc.pricePerSeatGbp('monthly');
    const annual = billingSvc.pricePerSeatGbp('annual');
    res.status(200).json(
      success(
        MODULE_CODES.map((code) => ({
          code,
          label: MODULE_LABELS[code],
          pricing: { monthlyGbp: monthly, annualGbp: annual },
        })),
        req.requestId,
      ),
    );
  };
}

// Stripe-touching — stubbed.
const todo = (_req: Request, _res: Response, next: NextFunction): void =>
  next(new AppError('INTERNAL_ERROR', { message: 'Stripe SDK not wired — see config/stripe.ts' }));
export const createCheckoutSession = todo;
export const createPortalSession = todo;
