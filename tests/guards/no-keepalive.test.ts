import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Neon scale-to-zero is a locked decision. Nothing may keep compute awake.
 * This guard catches the two ways it gets defeated by accident.
 */

// Files whose only "heartbeat" matches are Phase 6 job-lease liveness
// timestamps (see the keep-alive test below for the rationale).
const JOB_HEARTBEAT_ALLOWLIST = new Set([
  'apps/web/src/app/(app)/jobs/[id]/page.tsx',
  'apps/web/src/app/(app)/jobs/_components/JobActions.tsx',
  'apps/web/src/app/(app)/jobs/_jobs.ts',
  'apps/web/src/app/api/jobs/store.ts',
  'src/lib/jobs/queue.ts',
  'src/lib/jobs/types.ts',
  'apps/worker/src/handlers.ts',
  'apps/worker/src/worker.ts',
]);

describe('nothing defeats Neon autosuspend', () => {
  it('declares no cron jobs in vercel.json', () => {
    const cfg = JSON.parse(readFileSync('apps/web/vercel.json', 'utf8')) as Record<string, unknown>;
    expect(
      cfg.crons,
      'Adding a cron requires a founder decision — see LOCKED DECISIONS',
    ).toBeUndefined();
  });

  it('has no keep-alive, heartbeat or warmup code', () => {
    const hits = execSync(
      `git grep -lEi "keep-?alive|heartbeat|warm-?up|prevent.*(idle|suspend)|setInterval.*(query|pool)" -- src apps/web/src apps/worker/src scripts || true`,
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean)
      // Phase 6 job-lease heartbeats (heartbeat_at on the jobs table) are
      // worker-plane liveness timestamps for crash recovery — a worker only
      // writes them while actively processing a claimed job. They cannot wake
      // an idle Neon compute on their own, so they are not keep-alive code.
      .filter((f) => !JOB_HEARTBEAT_ALLOWLIST.has(f))
      .join('\n');
    expect(hits, `Possible keep-alive found in:\n${hits}`).toBe('');
  });

  it('keeps /health free of database access', () => {
    const health = readFileSync('apps/web/src/app/health/route.ts', 'utf8');
    expect(health).not.toMatch(/lib\/db/);
    expect(existsSync('apps/web/src/app/health/db/route.ts')).toBe(true);
  });

  // REL-11: the worker's liveness watchdog runs on a timer for as long as the worker lives, and
  // GET /healthz is polled by uptime monitors. Neither may reach the database, or the watchdog
  // and every monitor poll would keep Neon compute awake. Each file's complete import list is
  // pinned below, so a new dependency — in any import form — fails here and must be reviewed.
  const LIVENESS_PATH_IMPORTS: Record<string, string[]> = {
    'apps/worker/src/liveness.ts': [],
    'apps/worker/src/wake-latch.ts': [],
    'apps/worker/src/wake-server.ts': [
      './liveness',
      './wake-latch',
      '@/lib/jobs/wake-token',
      'node:crypto',
      'node:http',
    ],
    // The wake-token constant is on that path too (imported by wake-server): no imports at all.
    'src/lib/jobs/wake-token.ts': [],
  };
  /** Every module specifier in `code`: static, side-effect, dynamic, re-export and require. */
  const specifiersOf = (code: string): string[] => {
    const forms = [
      /\bimport\s[^'"`;]*?\bfrom\s*(['"])([^'"]+)\1/g, // import x from 'y' (also `import type`)
      /\bimport\s*(['"])([^'"]+)\1/g, // import 'y'
      /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g, // import('y')
      /\bexport\s[^'"`;]*?\bfrom\s*(['"])([^'"]+)\1/g, // export … from 'y'
      /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g, // require('y')
    ];
    return [...new Set(forms.flatMap((re) => [...code.matchAll(re)].map((m) => m[2]!)))].sort();
  };

  it('finds every import form (the scanner itself is tested)', () => {
    const sample = [
      `import a from 'one';`,
      `import type { B } from "two";`,
      `import 'three';`,
      `const c = await import("four");`,
      `export { d } from 'five';`,
      `const e = require('six');`,
    ].join('\n');
    expect(specifiersOf(sample)).toEqual(['five', 'four', 'one', 'six', 'three', 'two']);
  });

  it('keeps the worker liveness watchdog and the worker /healthz free of database access', () => {
    for (const [file, allowed] of Object.entries(LIVENESS_PATH_IMPORTS)) {
      const source = readFileSync(file, 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      expect(
        specifiersOf(code),
        `${file}: the liveness path must not touch the database — review any new import`,
      ).toEqual(allowed);
      expect(code, `${file} must not call the database`).not.toMatch(
        /withWorkerDb|withAuthorizedDb|connectWithWake|connectWorkerWithWake|\bpool\.|drizzle/,
      );
    }
  });
});
