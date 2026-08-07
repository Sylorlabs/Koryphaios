// ESLint config for Koryphaios.
//
// Enforces the engineering rules from AGENTS.md:
//   - No bare catch {} blocks (every catch must at least log the error).
//   - No `as any` type escapes (extend the type or use a typed narrowing).
//   - No @ts-ignore (use @ts-expect-error with a reason if truly needed).
//
// These rules prevent the regression patterns documented in the engineering
// audit: silent error swallowing and type safety theater. The rules are
// errors, not warnings, so CI fails if they're violated.

module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  rules: {
    // ─── No silent error swallowing ───────────────────────────────────
    // no-empty: flags `catch {}` with no body. We allow a comment as the
    // body (e.g. "// ignore, best-effort") so intentional empty catches
    // must be documented.
    'no-empty': ['error', { allowEmptyCatch: false }],

    // Flag `catch (e) { throw e }` patterns.
    'no-useless-catch': 'error',

    // ─── No type safety escapes ────────────────────────────────────────
    '@typescript-eslint/no-explicit-any': 'error',

    // @ts-ignore is forbidden; use @ts-expect-error with a comment
    // explaining why the type system can't express the constraint.
    '@typescript-eslint/ban-ts-comment': [
      'error',
      {
        'ts-ignore': true,
        'ts-expect-error': 'allow-with-description',
        'ts-nocheck': true,
        'ts-check': false,
        minimumDescriptionLength: 10,
      },
    ],
  },
  overrides: [
    {
      // Test files: relax no-explicit-any since test fixtures often use any.
      files: ['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**/*.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
  ],
  ignorePatterns: [
    'node_modules/**',
    '**/build/**',
    '**/dist/**',
    '**/.svelte-kit/**',
  ],
};
