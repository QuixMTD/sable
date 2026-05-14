// Sable middleware. Cross-cutting middleware lives here so every Node
// service composes the same set into its Express chain.
//
// The framework-agnostic ones (requestId, logger, errorHandler,
// setRlsContext, serviceAuth, moduleGuard) carry no Express coupling.
// The Express-bound ones (bodyParser, compression, cors, helmet,
// authenticate) wrap third-party packages declared as optional peer
// dependencies — services that compose them must install the underlying
// package themselves.

// Side-effect import: augments Express.Request with SableRequest fields.
import './expressAugment.js';

export * from './types.js';
export * from './requestId.js';
export * from './logger.js';
export * from './errorHandler.js';
export * from './setRlsContext.js';
export * from './serviceAuth.js';
export * from './moduleGuard.js';
export * from './bodyParser.js';
export * from './compression.js';
export * from './cors.js';
export * from './helmet.js';
export * from './authenticate.js';
export * from './authenticateApiKey.js';
export * from './requireAdmin.js';
export * from './blockGate.js';
export * from './rateLimit.js';
