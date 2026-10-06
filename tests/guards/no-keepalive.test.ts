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
  'src/app/(app)/jobs/[id]/page.tsx',
  'src/app/(app)/jobs/_components/JobActions.tsx',
  'src/app/(app)/jobs/_jobs.ts',
  'src/app/api/jobs/store.ts',
  'src/lib/jobs/handlers.ts',
  'src/lib/jobs/queue.ts',
  'src/lib/jobs/types.ts',
  'src/lib/jobs/worker.ts',
]);

describe('nothing defeats Neon autosuspend', () => {
  it('declares no cron jobs in vercel.json', () => {
    const cfg = JSON.parse(readFileSync('vercel.json', 'utf8')) as Record<string, unknown>;
    expect(
      cfg.crons,
      'Adding a cron requires a founder decision — see LOCKED DECISIONS',
    ).toBeUndefined();
  });

  it('has no keep-alive, heartbeat or warmup code', () => {
    const hits = execSync(
      `git grep -lEi "keep-?alive|heartbeat|warm-?up|prevent.*(idle|suspend)|setInterval.*(query|pool)" -- src scripts || true`,
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
    const health = readFileSync('src/app/health/route.ts', 'utf8');
    expect(health).not.toMatch(/lib\/db/);
    expect(existsSync('src/app/health/db/route.ts')).toBe(true);
  });
});
