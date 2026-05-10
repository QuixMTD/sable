// Paid modules a user / org can subscribe to. Source of truth: gateway DB doc
// — `subscriptions.module CHECK (... IN ('sc','re','crypto','alt','tax'))` and
// `users.active_modules` / `organisations.active_modules`.
//
// `MODULE_CODES` is `as const` so the array IS a tuple of literal strings; the
// derived type stays in lock-step with the runtime array — change one, both
// move together.

export const MODULE_CODES = ['sc', 're', 'crypto', 'alt', 'tax'] as const;
export type ModuleCode = (typeof MODULE_CODES)[number];

export function isModuleCode(value: unknown): value is ModuleCode {
  return typeof value === 'string' && (MODULE_CODES as readonly string[]).includes(value);
}

/**
 * Module → owning service. Used when the gateway routes a module-specific
 * request to the right downstream Cloud Run service.
 */
export const MODULE_SERVICES = {
  sc: 'sable-sc',
  re: 'sable-re',
  crypto: 'sable-crypto',
  alt: 'sable-alt',
  tax: 'sable-core',         // tax module is part of sable-core, not its own service
} as const satisfies Record<ModuleCode, string>;

export type ModuleService = (typeof MODULE_SERVICES)[ModuleCode];
