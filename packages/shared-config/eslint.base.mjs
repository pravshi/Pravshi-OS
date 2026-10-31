import { FlatCompat } from '@eslint/eslintrc';

/**
 * The workspace's ESLint rule set (redesign Step 8, package 1: shared-config).
 *
 * `createEslintConfig` returns the flat config array; the repository's eslint.config.mjs calls it
 * with the values that are specific to this repository (where the Next.js app is, which files the
 * process.env rule covers). The rules themselves are unchanged from before the extraction.
 *
 * `@eslint/eslintrc` (and, for the Vitest base, `@vitejs/plugin-react`) are resolved from the root
 * node_modules by walking up from this directory: the package declares no dependency of its own,
 * the tools stay declared in the root package.json.
 *
 * @param {object} options
 * @param {string} options.baseDirectory   directory the `next/*` and `prettier` configs resolve from
 *                                         (the repository root, where the tools are installed)
 * @param {string} options.nextRootDir     the Next.js app, for eslint-config-next's rules
 * @param {string[]} options.envRuleFiles  files that must read configuration through src/env.ts
 * @param {string[]} options.envRuleIgnores files exempt from that rule (src/env.ts itself)
 */
export function createEslintConfig({ baseDirectory, nextRootDir, envRuleFiles, envRuleIgnores }) {
  // The process.env rule is a security control (see below): refuse a caller that would silently
  // shrink or remove it, instead of producing a config that lints less.
  if (
    !Array.isArray(envRuleFiles) ||
    envRuleFiles.length === 0 ||
    !envRuleFiles.every((f) => typeof f === 'string' && f !== '')
  ) {
    throw new TypeError('createEslintConfig: envRuleFiles must be a non-empty array of globs');
  }
  if (!Array.isArray(envRuleIgnores) || envRuleIgnores.join('|') !== 'src/env.ts') {
    throw new TypeError('createEslintConfig: the only file exempt from the rule is src/env.ts');
  }
  const compat = new FlatCompat({ baseDirectory });
  return [
    ...compat.extends('next/core-web-vitals', 'next/typescript'),
    {
      // eslint-config-next's rules that look for the pages/app directory need to know where the
      // Next.js app is now that it lives in the workspace (redesign Step 7).
      settings: { next: { rootDir: nextRootDir } },
    },
    {
      ignores: ['node_modules/**', '**/.next/**', '**/out/**', '**/build/**', '**/next-env.d.ts'],
    },
    {
      // Configuration is read through src/env.ts, which validates it. Reading process.env
      // directly bypasses that validation and the credential-separation rules built on it.
      // src/env.ts is the one file that must read it, so it is exempt.
      //
      // The Sentry config files live in apps/web, outside its src/, so this rule
      // does not fight them — and instrumentation-client.ts documents why the browser DSN
      // must be read as a literal. The exception is now written in three places that have
      // to agree: that file, this message, and ENVIRONMENT.md.
      files: envRuleFiles,
      ignores: envRuleIgnores,
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            selector: "MemberExpression[object.name='process'][property.name='env']",
            message:
              'Read configuration through src/env.ts, not process.env. ' +
              'The only exception is instrumentation-client.ts — see ENVIRONMENT.md.',
          },
        ],
      },
    },
    ...compat.extends('prettier'),
  ];
}
