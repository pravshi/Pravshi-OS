import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Phase 12 Wave J (adversarial) — boundary leak guards.
 *
 * Wave C's frontend-resilience.test.ts pins the four contracted boundary
 * files by path. This guard generalises the two safety properties to the
 * WHOLE app tree, so a future nested segment cannot quietly reintroduce
 * the leak:
 *
 *  1. NO ERROR INTERNALS, ANYWHERE. Every error boundary in src/app —
 *     found by walking the tree for error.tsx / global-error.tsx, not by
 *     a hardcoded list — may read exactly ONE property of its error:
 *     `digest`, the opaque Next.js reference that is safe to show. Any
 *     other property access (error.message, error.stack, error.name,
 *     String(error), JSON.stringify(error), a bare {error} render…) fails
 *     here. An unhandled server error's message can carry a connection
 *     string, a role name or a stack; the boundary renders in the browser.
 *
 *  2. LAZY FALLBACKS NEVER FETCH. The F-12-09 code splits swap heavy
 *     editors for skeleton fallbacks at first paint. A fallback that
 *     fetched data would defeat the split and flash wrong content; the
 *     three *Lazy wrappers and the (app) loading boundary are asserted
 *     fetch-free, effect-free and free of service-layer imports. (The
 *     board's inline TaskFormSkeleton lives inside a component that
 *     legitimately fetches elsewhere, so only its own function body is
 *     asserted.)
 */

const read = (path: string) => readFileSync(path, 'utf8');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

const appFiles = walk('src/app');
const errorBoundaries = appFiles.filter(
  (p) => p.endsWith('/error.tsx') || p.endsWith('/global-error.tsx'),
);
const notFounds = appFiles.filter((p) => p.endsWith('/not-found.tsx'));

describe('error boundaries never render internals (Wave J)', () => {
  it('the walk finds the contracted boundaries (guard sanity)', () => {
    expect(errorBoundaries).toContain('src/app/global-error.tsx');
    expect(errorBoundaries).toContain('src/app/(app)/error.tsx');
    expect(notFounds).toContain('src/app/not-found.tsx');
    expect(notFounds).toContain('src/app/(app)/not-found.tsx');
  });

  it('every error boundary reads only error.digest from its error', () => {
    for (const path of errorBoundaries) {
      const src = read(path);
      // The lookbehind keeps filename mentions in comments ("global-
      // error.tsx") from matching as property accesses.
      const accessed = [...src.matchAll(/(?<![\w/-])error\.(\w+)/g)].map((m) => m[1]);
      expect(accessed.length, path).toBeGreaterThan(0); // digest is rendered
      for (const prop of accessed) expect(prop, `${path}: error.${prop}`).toBe('digest');
      // No indirect rendering of the error value either.
      expect(src, path).not.toMatch(/\{\s*error\s*\}/);
      expect(src, path).not.toContain('String(error)');
      expect(src, path).not.toContain('JSON.stringify(error)');
      expect(src, path).not.toMatch(/\.stack\b/);
      expect(src, path).not.toMatch(/\.message\b/);
    }
  });

  it('not-found boundaries render no error data and fetch nothing', () => {
    for (const path of notFounds) {
      const src = read(path);
      // Lookbehind: "global-error.tsx" in a comment is a filename, not
      // an access to error data.
      expect(src, path).not.toMatch(/(?<![\w/-])error\./);
      expect(src, path).not.toMatch(/\bfetch\s*\(/);
    }
  });
});

describe('lazy fallbacks never fetch (Wave J)', () => {
  const expectFetchFree = (src: string, label: string) => {
    expect(src, label).not.toMatch(/\bfetch\s*\(/);
    expect(src, label).not.toContain('useEffect');
    expect(src, label).not.toContain('useSWR');
    expect(src, label).not.toContain('axios');
    expect(src, label).not.toMatch(/from '@\/lib\//);
    expect(src, label).not.toMatch(/\bawait\b/);
  };

  it('the three *Lazy wrappers are pure skeleton shells', () => {
    for (const path of [
      'src/app/(app)/workflows/_components/WorkflowBuilderLazy.tsx',
      'src/app/(app)/workflows/_components/EditWorkflowClientLazy.tsx',
      'src/app/(app)/work/_components/EditTaskFormLazy.tsx',
    ]) {
      expectFetchFree(read(path), path);
    }
  });

  it("the board's inline TaskFormSkeleton body is fetch-free", () => {
    const src = read('src/app/(app)/work/_components/TaskBoard.tsx');
    const start = src.indexOf('function TaskFormSkeleton');
    expect(start).toBeGreaterThan(-1);
    // Brace-matched extraction of just the skeleton's own body — the
    // surrounding component legitimately fetches; the fallback must not.
    const open = src.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    expect(end).toBeGreaterThan(open);
    const body = src.slice(open, end + 1);
    expect(body).toContain('Skeleton');
    expect(body).not.toMatch(/\bfetch\s*\(/);
    expect(body).not.toContain('useEffect');
    expect(body).not.toMatch(/\bawait\b/);
  });

  it('the (app) loading boundary is a pure skeleton', () => {
    expectFetchFree(read('src/app/(app)/loading.tsx'), 'src/app/(app)/loading.tsx');
  });
});
