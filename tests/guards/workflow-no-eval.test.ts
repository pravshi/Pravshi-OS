import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Phase 5 structural invariant (§19 / P2-9): no dynamic code execution in the
 * workflow surface. Conditions are structured JSON and templates are
 * string-path lookups only (audit D5) — eval / new Function must never
 * appear in src/lib/workflows, the workflow API routes, or the workflow
 * frontend.
 *
 * Uses an fs walk (not git grep) so it runs in any checkout.
 */

const ROOTS = [
  'src/lib/workflows',
  'src/app/api/workflows',
  'src/app/api/workflow-executions',
  'src/app/(app)/workflows',
];

// Matches real dynamic-code constructs, not comments that merely mention
// them: eval( / new Function( / Function( as a call. String.prototype
// .replace with a function arg, .map(fn), etc. are not matched.
const EVAL_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'eval(', re: /(^|[^\w$.])eval\s*\(/ },
  { name: 'new Function(', re: /\bnew\s+Function\s*\(/ },
  { name: 'Function(', re: /(^|[^\w$.])Function\s*\(/ },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

function stripComments(source: string): string {
  // Remove block comments, then line comments. String literals are left
  // intact — a DYNAMIC_CODE-shaped string literal would still be flagged,
  // which is the conservative direction for this guard.
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^\S"'])\/\/.*$/gm, '$1');
}

describe('workflow surface: no dynamic code execution (D5)', () => {
  for (const root of ROOTS) {
    it(`no eval/new Function in ${root}`, () => {
      const violations: string[] = [];
      for (const file of sourceFiles(root)) {
        const code = stripComments(readFileSync(file, 'utf8'));
        for (const { name, re } of EVAL_PATTERNS) {
          if (re.test(code)) violations.push(`${file}: ${name}`);
        }
      }
      expect(violations, 'Dynamic code execution breaks audit decision D5').toEqual([]);
    });
  }
});
