import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { createEslintConfig } from './packages/shared-config/eslint.base.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// The rule set lives in packages/shared-config (redesign Step 8); this file only says where this
// repository's Next.js app is and which files the process.env rule covers.
export default createEslintConfig({
  baseDirectory: __dirname,
  nextRootDir: 'apps/web',
  envRuleFiles: [
    'src/**/*.{ts,tsx}',
    'apps/web/src/**/*.{ts,tsx}',
    'apps/worker/src/**/*.{ts,tsx}',
  ],
  envRuleIgnores: ['src/env.ts'],
});
