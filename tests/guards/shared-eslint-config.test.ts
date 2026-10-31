import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { createEslintConfig } from '../../packages/shared-config/eslint.base.mjs';

/**
 * Redesign Step 8, package 1 — the ESLint rule set lives in packages/shared-config. The rule that
 * forbids reading process.env outside src/env.ts is a security control (configuration is
 * validated in one place), so this pins that it is still applied through the package to every
 * source root, that src/env.ts alone is exempt, and that the package refuses to be configured so
 * that it lints less.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RULE_MESSAGE = 'Read configuration through src/env.ts';

async function messagesFor(filePath: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: ROOT });
  const [result] = await eslint.lintText('export const x = process.env.FOO;\n', {
    filePath: join(ROOT, filePath),
  });
  return (result?.messages ?? []).map((m) => m.message);
}

describe('shared ESLint config: the process.env rule', () => {
  it.each([
    'src/lib/crm/zz-fixture.ts',
    'apps/web/src/app/zz-fixture.tsx',
    'apps/worker/src/zz-fixture.ts',
  ])('is applied to %s', async (file) => {
    const messages = await messagesFor(file);
    expect(messages.some((m) => m.startsWith(RULE_MESSAGE))).toBe(true);
  });

  it('exempts src/env.ts and nothing else under src/', async () => {
    expect((await messagesFor('src/env.ts')).some((m) => m.startsWith(RULE_MESSAGE))).toBe(false);
    expect((await messagesFor('src/lib/env.ts')).some((m) => m.startsWith(RULE_MESSAGE))).toBe(
      true,
    );
  });

  it('refuses a configuration that would lint less', () => {
    const ok = {
      baseDirectory: ROOT,
      nextRootDir: 'apps/web',
      envRuleFiles: ['src/**/*.ts'],
      envRuleIgnores: ['src/env.ts'],
    };
    expect(() => createEslintConfig({ ...ok, envRuleFiles: [] })).toThrow(TypeError);
    expect(() => createEslintConfig({ ...ok, envRuleFiles: undefined as never })).toThrow(
      TypeError,
    );
    expect(() => createEslintConfig({ ...ok, envRuleIgnores: ['**'] })).toThrow(TypeError);
    expect(() => createEslintConfig({ ...ok, envRuleIgnores: [] })).toThrow(TypeError);
    expect(() => createEslintConfig(ok)).not.toThrow();
  });
});
