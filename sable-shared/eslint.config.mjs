// ESLint flat config. Run `npm run lint`.
//
// The marquee rule here is the template-literal-in-logger guard: any
// logger.{debug,info,warn,error,trace,fatal}() call whose first argument is
// a template literal with interpolation is rejected. The point is to force
// PII into the structured `meta` argument so safeLog can redact it; PII in
// the message string is invisible to the redactor and leaks straight to
// stdout.
//
//   logger.info('user logged in', { userId });   // ✅ id in meta
//   logger.info(`user ${user.email} logged in`); // ❌ email in message

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const LOGGER_METHODS_RE = '/^(debug|info|warn|error|trace|fatal)$/';

const restrictedSyntax = [
  {
    // Method-call form: logger.info(`...${x}...`)
    selector: `CallExpression[callee.type='MemberExpression'][callee.property.name=${LOGGER_METHODS_RE}][arguments.0.type='TemplateLiteral'][arguments.0.expressions.length>0]`,
    message:
      'Do not interpolate values into logger messages — pass them as a structured meta object so safeLog can redact PII. Example: log.info("user logged in", { userId: user.id }).',
  },
  {
    // String-concat form: logger.info('user ' + email + ' logged in')
    selector: `CallExpression[callee.type='MemberExpression'][callee.property.name=${LOGGER_METHODS_RE}][arguments.0.type='BinaryExpression'][arguments.0.operator='+']`,
    message:
      'Do not concatenate values into logger messages — pass them as a structured meta object so safeLog can redact PII.',
  },
];

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', '*.config.js', '*.config.mjs'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-restricted-syntax': ['error', ...restrictedSyntax],

      // We use `unknown` deliberately in places (RequestContext, error helpers).
      '@typescript-eslint/no-explicit-any': 'warn',

      // Empty interfaces are intentional in some places (SableRequest as an
      // augmentation seam).
      '@typescript-eslint/no-empty-object-type': 'off',

      // Allow leading-underscore unused params for Express-style signatures.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
