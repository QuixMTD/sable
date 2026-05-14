// /verify/:publicId — public, unauthenticated. Resolves a certificate
// id to the full verification view: the candidate's name, level,
// score, hours, and the cryptographic proof (ledger entry hash,
// platform signature, public key). Future TSA-anchored entries also
// include the RFC 3161 timestamp evidence.
//
// Mounted outside the /auth subtree; rate-limited per IP at the
// app level. The DB read runs as actor='gateway' so RLS lets us see
// the certificate without a session.

import type { RequestHandler } from 'express';
import { failure, success } from 'sable-shared';

import type { AppConfig } from '../app.js';
import * as certificationSvc from '../services/certification.js';

export function verify(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      const publicId = (req.params.publicId ?? '').trim().toUpperCase();
      if (publicId.length === 0) {
        res.status(404).json(failure('NOT_FOUND', 'Certificate id required', undefined, req.requestId));
        return;
      }
      const result = await certificationSvc.verifyByPublicId(config.sql, publicId);
      if (!result.valid) {
        res.status(404).json(
          success(
            { valid: false, reason: result.reason, publicId },
            req.requestId,
          ),
        );
        return;
      }
      res.status(200).json(
        success(
          {
            valid: true,
            certificate: {
              public_id: result.certificate.public_id,
              level: result.certificate.level,
              score: result.certificate.score,
              hours_at_issue: result.certificate.hours_at_issue,
              issued_at: result.certificate.issued_at,
              user_name: result.certificate.user_name,
            },
            proof: result.proof,
          },
          req.requestId,
        ),
      );
    } catch (err) {
      next(err);
    }
  };
}

/** Exposes the platform's current signing public key so verifiers
 *  outside the gateway can independently check signatures. */
export function publicKey(_config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      const { publicKeyPem, activeKeyId } = await import('../services/certificationLedger.js');
      res.status(200).json(
        success(
          { key_id: activeKeyId(), algorithm: 'Ed25519', public_key_pem: publicKeyPem() },
          req.requestId,
        ),
      );
    } catch (err) {
      next(err);
    }
  };
}
