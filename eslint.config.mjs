import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    ignores: ['node_modules/**', '.next/**', 'out/**', 'build/**', 'next-env.d.ts'],
  },
  {
    // Configuration is read through src/env.ts, which validates it. Reading process.env
    // directly bypasses that validation and the credential-separation rules built on it.
    // src/env.ts is the one file that must read it, so it is exempt.
    //
    // The Sentry config files live at the repository root, outside src/, so this rule
    // does not fight them — and instrumentation-client.ts documents why the browser DSN
    // must be read as a literal. The exception is now written in three places that have
    // to agree: that file, this message, and ENVIRONMENT.md.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/env.ts'],
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

export default eslintConfig;
