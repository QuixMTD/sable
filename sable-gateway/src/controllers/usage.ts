// /usage/* — internal, service-to-service. Module services post a
// single record or a batch of minute reports; the gateway writes them
// to gateway.certification_minutes (idempotent via UNIQUE constraint).
//
// Auth: serviceAuth middleware verifies the HMAC signature on the
// X-Service-* headers before this handler runs.

import type { RequestHandler } from 'express';
import { AppError, parse, success } from 'sable-shared';

import type { AppConfig } from '../app.js';
import { recordUsageBatchSchema, recordUsageSchema } from '../schemas/certification.js';
import * as usage from '../services/usage.js';

export function recordOne(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      const input = parse(recordUsageSchema, req.body);
      const sourceService = req.header('x-service-name') ?? 'unknown';
      const result = await usage.recordOne(config.sql, { ...input, sourceService });
      res.status(200).json(success(result, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}

export function recordBatch(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      const input = parse(recordUsageBatchSchema, req.body);
      const sourceService = req.header('x-service-name') ?? 'unknown';
      if (input.items.length === 0) {
        return next(new AppError('VALIDATION_FAILED', { message: 'items required' }));
      }
      const result = await usage.recordBatch(config.sql, sourceService, input.items);
      res.status(200).json(success(result, req.requestId));
    } catch (err) {
      next(err);
    }
  };
}
